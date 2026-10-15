'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROSPECTS_HEADERS } = require('../src/prospects-contract');
const { buildNormalizationPreview, normalizeSuppressionSnapshot, assertSuppressionImportable, matchSuppressionSnapshot, parseSnapshotRow } = require('../src/normalization');

const SHEET_ID = 'test-spreadsheet-id-1234567890';
function snapshot({ leadId = 'L-1', company = 'Example AZ Brand', overrides = {} } = {}) {
  const cells = Array(42).fill('');
  const values = {
    'Company Name': company, 'Company Website': 'https://example.test', 'Company Domain': 'example.test',
    'Arizona City': 'Phoenix', 'Arizona Address': 'Phoenix, AZ 85001', Industry: 'Cosmetics & skincare brands',
    'ICP Score': '92', 'Brand Ownership Evidence': 'Product brand', 'Packaging Opportunity': 'Boxes',
    'Source URL': 'https://example.test/about', 'Lead ID': leadId, 'Company Contact Number': '(602) 555-0123',
    'Company Phone Source URL': 'https://example.test/contact', 'Phone Activity Status': 'ACTIVE',
    'Email Deliverability Status': 'DELIVERABLE', ...overrides
  };
  for (const [header, value] of Object.entries(values)) cells[PROSPECTS_HEADERS.indexOf(header)] = value;
  return { id: `snapshot-${leadId}`, source_row_number: 2, lead_id: leadId, row_payload: cells, payload_sha256: 'a'.repeat(64) };
}
function twenty(first = snapshot()) { return [first, ...Array.from({ length: 19 }, (_, i) => snapshot({ leadId: `L-${i + 2}`, company: `Example Brand ${i + 2}` }))]; }

test('normalization preview preserves exact snapshot cells and plans only existing identities', () => {
  const data = twenty();
  const before = JSON.stringify(data[0].row_payload);
  const preview = buildNormalizationPreview(data, { spreadsheetId: SHEET_ID });
  assert.equal(preview.counts.snapshots, 20);
  assert.equal(preview.counts.companiesToCreate, 20);
  assert.equal(preview.counts.qualificationExceptions, 0);
  assert.equal(preview.noNewCompanies, true);
  assert.equal(JSON.stringify(data[0].row_payload), before);
  assert.equal(preview.rows[0].cells.length, 42);
  assert.equal(preview.rows[0].record.emailDeliverabilityStatus, 'DELIVERABLE');
});

test('normalization plan is deterministic/idempotent and links by Lead ID', () => {
  const data = twenty();
  const a = buildNormalizationPreview(data, { spreadsheetId: SHEET_ID });
  const b = buildNormalizationPreview(data, { spreadsheetId: SHEET_ID });
  assert.equal(a.planSha256, b.planSha256);
  assert.equal(a.rows[0].leadId, 'L-1');
  const reused = buildNormalizationPreview(data, { spreadsheetId: SHEET_ID,
    existingIdentifiers: [{ identifier_type: 'APPS_SCRIPT_LEAD_ID', normalized_value: 'L-1' }] });
  assert.equal(reused.rows[0].identityAction, 'REUSE_BY_LEAD_ID');
});

test('normalization does not invent a named POC and surfaces unlinked POC details', () => {
  const rows = twenty(snapshot({ overrides: { 'POC Email ID': 'person@example.test', 'POC Email Source URL': 'https://example.test/contact' } }));
  const preview = buildNormalizationPreview(rows, { spreadsheetId: SHEET_ID });
  assert.equal(preview.rows[0].contactPlan, 'NO_NAMED_CONTACT');
  assert.equal(preview.rows[0].personPointCount, 0);
  assert.ok(preview.rows[0].issues.includes('POC_DETAILS_UNLINKED_NO_NAMED_CONTACT'));
});

test('ambiguous existing company identity is flagged and duplicate Lead IDs are rejected', () => {
  const collision = buildNormalizationPreview(twenty(), { spreadsheetId: SHEET_ID,
    existingCompanies: [{ id: 'company-1', normalized_name: 'example az brand' }] });
  assert.equal(collision.counts.identityConflicts, 1);
  assert.equal(collision.rows[0].identityAction, 'CONFLICT_REVIEW');
  const dupes = twenty(); dupes[1].lead_id = 'L-1'; dupes[1].row_payload[24] = 'L-1';
  assert.throws(() => buildNormalizationPreview(dupes, { spreadsheetId: SHEET_ID }), /Duplicate Lead ID/);
});

test('all normalized contact activity/deliverability is guarded as unverified', () => {
  const preview = buildNormalizationPreview(twenty(), { spreadsheetId: SHEET_ID });
  assert.equal(preview.deliverabilityForcedUnverified, true);
  assert.equal(preview.phoneActivityForcedUnverified, true);
  const parsed = parseSnapshotRow(snapshot({ overrides: { 'POC Name': 'Alex Example', Designation: 'Owner', 'Contact Source URL': 'https://example.test/team' } }));
  assert.equal(parsed.record.pocName, 'Alex Example');
});

test('suppression snapshot normalizes and deduplicates numbers, and refuses incomplete import', () => {
  const complete = normalizeSuppressionSnapshot({ sourceKey: 'suppression-2026-10', sourceUrl: 'https://example.test/suppression.csv',
    capturedAt: '2026-10-15T10:00:00Z', completenessStatus: 'COMPLETE', entries: [{ phone: '(602) 555-0123' }, { phone: '+1 602 555 0123' }] });
  assert.equal(complete.completenessStatus, 'COMPLETE');
  assert.equal(complete.duplicateCount, 1);
  assert.equal(complete.entries.length, 1);
  assert.equal(assertSuppressionImportable(complete), true);
  const matched = matchSuppressionSnapshot(complete, [
    { id:'poc-point', channel:'PHONE', scope_kind:'PERSON', normalized_value:'+16025550123' },
    { id:'company-point', channel:'PHONE', scope_kind:'COMPANY', normalized_value:'+16025550123' }
  ]);
  assert.equal(matched.matches.length, 2);
  assert.equal(matched.unmatched.length, 0);
  const incomplete = normalizeSuppressionSnapshot({ sourceKey: 'partial', sourceUrl: 'https://example.test/partial.csv',
    capturedAt: '2026-10-15T10:00:00Z', completenessStatus: 'INCOMPLETE', entries: [] });
  assert.throws(() => assertSuppressionImportable(incomplete), /complete authoritative/);
  assert.throws(() => normalizeSuppressionSnapshot({ sourceKey: 'x', sourceUrl: 'https://example.test/x', capturedAt: '2026-10-15',
    completenessStatus: 'COMPLETE', entries: [{ phone: '555' }] }), /invalid phone/);
});
