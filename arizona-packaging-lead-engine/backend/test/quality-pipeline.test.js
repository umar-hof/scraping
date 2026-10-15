'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeName, normalizeDomain, normalizeUsPhone, inspectExistingProspect, fieldEvidencePlan, buildExistingRecordAudit } = require('../src/quality');
const { buildSdrBatches } = require('../src/sdr-batching');
const { buildSheetsSyncPreview, applyApprovedSheetsSync, checkpointAfter, retryWithBackoff } = require('../src/sheets-sync');
const { PROSPECTS_HEADERS } = require('../src/prospects-contract');
const { parseProspectsValues } = require('../src/sheets-import');
const { normalizeSuppressionSnapshot } = require('../src/normalization');

function qualifiedRecord(leadId, phone, extra = {}) {
  return { leadId, companyName: `Arizona Brand ${leadId}`, companyWebsite: 'https://brand.example/', companyDomain: 'brand.example',
    arizonaCity: 'Phoenix', arizonaAddress: 'Phoenix, AZ 85001', industry: 'Cosmetics & Skincare Brands', icpScore: 72,
    brandOwnershipEvidence: 'Official site sells skincare products', packagingOpportunity: 'Bottles and cartons',
    sourceUrl: 'https://brand.example/about', companyContactNumber: phone, companyPhoneSourceUrl: 'https://brand.example/contact',
    phoneActivityStatus: 'UNVERIFIED', phoneFormatStatus: 'VALID_FORMAT', ...extra };
}

test('normalization handles company identity, official website domains, and format-only phone validation', () => {
  assert.equal(normalizeName('Café & Co., LLC'), 'cafe and co llc');
  assert.equal(normalizeDomain('https://www.Brand.Example/path?q=1'), 'brand.example');
  assert.equal(normalizeDomain('javascript:alert(1)'), '');
  assert.deepEqual(normalizeUsPhone('(602) 555-0123'), { e164: '+16025550123', formatStatus: 'VALID_FORMAT' });
  assert.equal(normalizeUsPhone('555').formatStatus, 'INVALID_FORMAT');
});

test('existing-record qualification is source-backed, Arizona-specific, and never creates a new company', () => {
  const record = qualifiedRecord('existing-1', '(602) 555-0123');
  assert.equal(inspectExistingProspect(record).qualificationStatus, 'ELIGIBLE_EXISTING_ONLY');
  assert.equal(inspectExistingProspect({ ...record, arizonaAddress: 'Phoenix' }).qualificationStatus, 'EXCLUDED_PENDING_REVIEW');
  assert.equal(inspectExistingProspect({ ...record, sourceUrl: '' }).qualificationStatus, 'EXCLUDED_PENDING_REVIEW');
  assert.equal(buildExistingRecordAudit([record]).noCompaniesCreated, true);
});

test('field evidence retains field-level source and value hash without copying its value', () => {
  const fields = fieldEvidencePlan({ ...qualifiedRecord('existing-2', '6025550123'), companyEmail: 'hello@brand.example',
    companyEmailSourceUrl: 'https://brand.example/contact', pocEmailId: '', pocEmailSourceUrl: '' });
  const email = fields.find((item) => item.fieldKey === 'companyEmail');
  assert.equal(email.sourceUrl, 'https://brand.example/contact');
  assert.equal(email.status, 'SOURCE_LINKED');
  assert.equal(Object.hasOwn(email, 'value'), false);
  assert.equal(fields.some((item) => item.fieldKey === 'pocEmailId'), false);
});

test('three SDR batches deduplicate phone numbers, exclude suppressed/invalid/unqualified rows, and report shortages', () => {
  const records = [
    qualifiedRecord('lead-a', '602-555-0101', { phoneActivityStatus: 'ACTIVE', phoneActivityIndependentlyVerified: true, phoneVerifiedAt: '2026-10-15T00:00:00Z' }),
    qualifiedRecord('lead-b', '(602) 555-0101', { phoneActivityStatus: 'ACTIVE', phoneActivityIndependentlyVerified: true, phoneVerifiedAt: '2026-10-15T00:00:00Z' }),
    qualifiedRecord('lead-c', '480-555-0202', { phoneActivityStatus: 'ACTIVE', phoneActivityIndependentlyVerified: true, phoneVerifiedAt: '2026-10-15T00:00:00Z' }),
    qualifiedRecord('lead-d', 'bad phone', { phoneActivityStatus: 'ACTIVE', phoneActivityIndependentlyVerified: true, phoneVerifiedAt: '2026-10-15T00:00:00Z' }),
    qualifiedRecord('lead-e', '623-555-0303', { arizonaAddress: '', phoneActivityStatus: 'ACTIVE', phoneActivityIndependentlyVerified: true, phoneVerifiedAt: '2026-10-15T00:00:00Z' }),
    qualifiedRecord('lead-f', '520-555-0404', { phoneActivityStatus: 'ACTIVE', phoneActivityIndependentlyVerified: true, phoneVerifiedAt: '2026-10-15T00:00:00Z' })
  ];
  const completeSnapshot = normalizeSuppressionSnapshot({ sourceKey:'test-suppressions', sourceUrl:'https://example.test/suppression.csv',
    capturedAt:'2026-10-15T00:00:00Z', completenessStatus:'COMPLETE', entries:[{ phone:'520-555-0404', leadId:'lead-f' }] });
  const result = buildSdrBatches(records, { campaignId: 'campaign-1', perAgent: 1, suppressions: ['lead-f'], suppressionSnapshot:completeSnapshot,
    verificationPolicy: { requireIndependentActive: true, maxAgeDays: 30 }, now: new Date('2026-10-15T12:00:00Z') });
  assert.equal(Object.keys(result.batches).length, 3);
  assert.equal(result.eligibleUniquePhones, 2);
  assert.equal(result.assigned, 2);
  assert.equal(result.excluded.duplicatePhone, 1);
  assert.equal(result.excluded.invalidPhone, 1);
  assert.equal(result.excluded.unqualified, 1);
  assert.equal(result.excluded.suppressed, 1);
  const all = Object.values(result.batches).flat();
  assert.equal(new Set(all.map((item) => item.phoneE164)).size, all.length);
  assert.ok(all.every((item) => item.phoneActivityStatus === 'ACTIVE' && !item.requiresReview));
  assert.equal(result.totalShortage, 1);
  assert.throws(() => buildSdrBatches(records, { campaignId: 'bad', agents: ['only-one'] }), /exactly three/);
});

test('SDR batching refuses to assign records until a complete suppression snapshot is confirmed', () => {
  const result = buildSdrBatches([qualifiedRecord('lead-safe', '602-555-0111')], { campaignId: 'preview-only', perAgent: 1 });
  assert.equal(result.uniquePhoneCandidatesBeforeSuppressionReview, 1);
  assert.equal(result.eligibleUniquePhones, null);
  assert.equal(result.assigned, 0);
  assert.equal(result.suppressionStatus, 'BLOCKED_NEEDS_COMPLETE_SUPPRESSION_SNAPSHOT');
  assert.equal(result.verificationPolicyStatus, 'BLOCKED_NEEDS_VERIFICATION_POLICY');
  assert.equal(result.totalShortage, 3);
});

test('SDR batching excludes unverified phones even when the suppression snapshot is complete', () => {
  const completeSnapshot = normalizeSuppressionSnapshot({ sourceKey:'complete-test',sourceUrl:'https://example.test/supp.csv',
    capturedAt:'2026-10-15T00:00:00Z',completenessStatus:'COMPLETE',entries:[] });
  const result = buildSdrBatches([qualifiedRecord('unverified', '602-555-0112')], { campaignId: 'verification-required',
    suppressionSnapshot:completeSnapshot, verificationPolicy: { requireIndependentActive: true, maxAgeDays: 30 } });
  assert.equal(result.assigned, 0);
  assert.equal(result.excluded.insufficientVerification, 1);
  assert.equal(result.verificationPolicyStatus, 'CONFIGURED');
});

test('Sheets sync plan updates blanks only, preserves manual values, is idempotent, and checkpoints by Lead ID', () => {
  const row = Array(42).fill(''); row[0] = 'Existing Brand'; row[24] = 'sync-1'; row[26] = 'manual@brand.example';
  const snapshot = parseProspectsValues([PROSPECTS_HEADERS, row], { spreadsheetId: 'sheet-3' });
  const record = { companyName: 'Existing Brand', leadId: 'sync-1', companyEmail: 'automated@brand.example',
    contactCompletenessScore: 30, notes: 'database note' };
  const plan = buildSheetsSyncPreview({ spreadsheetId: 'sheet-3', existingSnapshot: snapshot, databaseRecords: [record],
    managedHeaders: ['Company Email', 'Contact Completeness Score', 'Notes'] });
  assert.equal(plan.counts.proposedCellUpdates, 2);
  const newRow = plan.changes[0];
  assert.deepEqual(newRow.cellChanges.map((item) => item.header), ['Contact Completeness Score', 'Notes']);
  assert.equal(newRow.cellChanges.some((item) => item.value === 'manual@brand.example'), false);
  assert.equal(plan.writePerformed, false);
  assert.equal(buildSheetsSyncPreview({ spreadsheetId: 'sheet-3', existingSnapshot: snapshot,
    databaseRecords: [record], managedHeaders: [] }).counts.proposedCellUpdates, 0);
  assert.equal(checkpointAfter(plan, 'sync-1').nextIndex, 1);
  assert.throws(() => buildSheetsSyncPreview({ spreadsheetId: 'sheet-3', existingSnapshot: snapshot,
    databaseRecords: [record], managedHeaders: ['Lead ID'] }), /Invalid managed header/);
});

test('Sheets sync writer is approval-gated, rechecks the live snapshot, and verifies the accepted write', async () => {
  const row = Array(42).fill(''); row[0] = 'Write Test Brand'; row[24] = 'write-test-1';
  let values = [PROSPECTS_HEADERS, row];
  const snapshot = parseProspectsValues(values, { spreadsheetId: 'sheet-write-identifier-123456' });
  const record = { companyName: 'Write Test Brand', leadId: 'write-test-1', contactCompletenessScore: 20 };
  const plan = buildSheetsSyncPreview({ spreadsheetId: 'sheet-write-identifier-123456', existingSnapshot: snapshot,
    databaseRecords: [record], managedHeaders: ['Contact Completeness Score'] });
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    if (options.method === 'POST') {
      const cellRequest = options.body && JSON.parse(options.body).requests[0];
      const { rowIndex, columnIndex } = cellRequest.updateCells.start;
      const cell = cellRequest.updateCells.rows[0].values[0].userEnteredValue;
      values[rowIndex][columnIndex] = cell.numberValue;
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes('fields=spreadsheetId')) return { ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 7, title: 'Prospects' } }] }) };
    return { ok: true, json: async () => ({ values }) };
  };
  await assert.rejects(() => applyApprovedSheetsSync({ plan, databaseRecords: [record], accessToken: 'token', fetchImpl }), /explicit approval/);
  assert.equal(calls, 0);
  const result = await applyApprovedSheetsSync({ plan, databaseRecords: [record], accessToken: 'token',
    approvedPlanSha256: plan.planSha256, confirmWrite: true, fetchImpl });
  assert.equal(result.writePerformed, true);
  assert.equal(result.verifiedAfterWrite, true);
  assert.equal(values[1][40], 20);
  assert.equal(calls, 5);
});

test('sync retry logs contain error codes and attempt counts but never exception messages', async () => {
  const logs = []; let calls = 0;
  const value = await retryWithBackoff(async () => { calls += 1; if (calls === 1) { const e = new Error('secret text'); e.code = 'TEMP'; throw e; } return 'ok'; },
  { attempts: 2, sleep: async () => {}, log: (event) => logs.push(event) });
  assert.equal(value, 'ok');
  assert.equal(logs[0].errorCode, 'TEMP');
  assert.equal(JSON.stringify(logs).includes('secret text'), false);
});
