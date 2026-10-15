'use strict';

const { Client } = require('pg');
const { PROSPECTS_HEADERS } = require('../src/prospects-contract');
const { loadLocalEnv } = require('../src/local-env');
const { readSupabaseConfig } = require('../src/supabase-config');
const { sha256 } = require('../src/sheets-import');
const { buildNormalizationPreview, persistNormalization } = require('../src/normalization');
const { buildSdrBatches } = require('../src/sdr-batching');

const EXPECTED_SPREADSHEET_ID = String(process.env.EXPECTED_SPREADSHEET_ID || '').trim();
const APPLY_FLAG = '--confirm-clean-disposable-normalization';

function safeError(error) {
  return String(error && error.message || 'normalization failed')
    .replaceAll(process.env.SUPABASE_DB_PASSWORD || '\u0000', '[redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url-redacted]');
}

async function loadPlan(client) {
  const batchResult = await client.query(
    `SELECT id,source_spreadsheet_id,source_tab_name,header_sha256,read_at FROM lead_intel.sheet_import_batches
     WHERE source_spreadsheet_id=$1 AND source_tab_name='Prospects' ORDER BY created_at DESC`, [EXPECTED_SPREADSHEET_ID]);
  if (batchResult.rowCount !== 1) throw new Error('Expected exactly one immutable Prospects snapshot batch for the existing spreadsheet.');
  const batch = batchResult.rows[0];
  const expectedHeaderHash = sha256(JSON.stringify(PROSPECTS_HEADERS));
  if (batch.header_sha256.trim() !== expectedHeaderHash) throw new Error('Snapshot header hash does not match the frozen 42-column contract.');
  const sourceRows = await client.query(
    `SELECT id,source_row_number,lead_id,row_payload,payload_sha256 FROM lead_intel.sheet_import_rows
     WHERE batch_id=$1 ORDER BY source_row_number`, [batch.id]);
  if (sourceRows.rowCount !== 20) throw new Error('Expected 20 immutable snapshots; refusing partial normalization.');
  for (const row of sourceRows.rows) {
    if (sha256(JSON.stringify(row.row_payload)) !== row.payload_sha256) throw new Error('Snapshot payload hash mismatch; refusing normalization.');
  }
  const sourceKey = `google-sheets-snapshot:${EXPECTED_SPREADSHEET_ID}`;
  const [identifiers, companies] = await Promise.all([
    client.query(`SELECT company_id,identifier_type,normalized_value FROM lead_intel.company_identifiers WHERE identifier_namespace=$1 AND identifier_type='APPS_SCRIPT_LEAD_ID'`, [sourceKey]),
    client.query(`SELECT id,lower(canonical_name) AS normalized_name FROM lead_intel.companies`)
  ]);
  const preview = buildNormalizationPreview(sourceRows.rows, { spreadsheetId: EXPECTED_SPREADSHEET_ID,
    existingIdentifiers: identifiers.rows, existingCompanies: companies.rows });
  return { batch, sourceRows:sourceRows.rows, preview, sourceKey };
}

async function main() {
  if (!process.argv.includes(APPLY_FLAG)) throw new Error(`Refusing writes. Rerun with ${APPLY_FLAG} only for the disposable project.`);
  loadLocalEnv();
  const config = readSupabaseConfig();
  if (config.environment !== 'DISPOSABLE' || !config.host.endsWith('.pooler.supabase.com') || config.port !== 5432 || !config.user.endsWith(`.${config.projectRef}`)) {
    throw new Error('Database target did not pass the disposable Supabase identity check.');
  }
  const client = new Client(config);
  try {
    await client.connect();
    const identity = await client.query('SELECT current_database() AS db');
    if (identity.rows[0].db !== 'postgres') throw new Error('Connected database name did not match the expected Supabase database.');
    const { preview, sourceRows } = await loadPlan(client);
    const plan = preview;
    const clean = plan.counts.snapshots === 20 && plan.counts.identityConflicts === 0 &&
      plan.rows.every(r => r.cells.length === 42 && r.payloadSha256 === sourceRows.find(s => s.id === r.snapshotId).payload_sha256);
    const issueCounts = {};
    for (const item of plan.reviewItems) for (const issue of item.issues) issueCounts[issue] = (issueCounts[issue] || 0) + 1;
    const preflight = { target:'DISPOSABLE_CONFIRMED', snapshotRows:plan.counts.snapshots, mappedColumns:42,
      companiesPlanned:plan.counts.companiesToCreate, companiesReused:plan.counts.companiesToReuse,
      identityConflicts:plan.counts.identityConflicts, locationsSupported:plan.counts.locationsSupported,
      namedContacts:plan.counts.namedContactsToCreateOrReuse, companyContactPoints:plan.counts.companyContactPoints,
      personContactPoints:plan.counts.personContactPoints, fieldEvidenceLinks:plan.rows.reduce((n,r)=>n+r.fieldEvidenceCount,0),
      sourceEvidenceGaps:plan.counts.sourceEvidenceGaps, qualificationExceptions:plan.counts.qualificationExceptions,
      issueCounts, planSha256:plan.planSha256, cleanForImport:clean };
    console.log(`NORMALIZATION_DRY_RUN ${JSON.stringify(preflight)}`);
    if (!clean) throw new Error('Dry-run reconciliation was not clean; no normalized records were written.');
    const applied = await persistNormalization(client, plan, { approvedPlanSha256:plan.planSha256,
      confirmImport:true, environment:config.environment });
    const firstCheck = await loadPlan(client);
    if (firstCheck.preview.counts.companiesToCreate !== 0 || firstCheck.preview.counts.identityConflicts !== 0) {
      throw new Error('Post-normalization Lead ID linkage check failed.');
    }
    const secondRun = await persistNormalization(client, firstCheck.preview, { approvedPlanSha256:firstCheck.preview.planSha256,
      confirmImport:true, environment:config.environment });
    const totals = await client.query(`SELECT count(*)::int AS companies FROM lead_intel.company_identifiers WHERE identifier_namespace=$1 AND identifier_type='APPS_SCRIPT_LEAD_ID'`, [firstCheck.sourceKey]);
    const statuses = await client.query(`SELECT count(*)::int AS total,
        count(*) FILTER(WHERE channel='EMAIL' AND email_deliverability_status<>'UNVERIFIED')::int AS non_unverified_emails,
        count(*) FILTER(WHERE channel='PHONE' AND phone_activity_status<>'UNVERIFIED')::int AS non_unverified_phones
        FROM lead_intel.contact_points cp JOIN lead_intel.companies c ON c.id=cp.company_id
        JOIN lead_intel.company_identifiers i ON i.company_id=c.id WHERE i.identifier_namespace=$1 AND i.identifier_type='APPS_SCRIPT_LEAD_ID'`, [firstCheck.sourceKey]);
    const queue = await client.query(`SELECT count(*)::int AS count FROM lead_intel.jobs WHERE job_type='MANUAL_REVIEW' AND payload->>'kind'='EXISTING_PROSPECT_QUALITY_REVIEW'`);
    const suppressionRows = await client.query(`SELECT count(*)::int AS count FROM lead_intel.suppression`);
    if (Number(totals.rows[0].companies) !== 20 || Number(statuses.rows[0].non_unverified_emails) !== 0 || Number(statuses.rows[0].non_unverified_phones) !== 0) {
      throw new Error('Post-write count/status invariant failed.');
    }
    const batchPreview = buildSdrBatches(firstCheck.preview.rows.map(r => r.record), { campaignId:'arizona-existing-prospects-preview',
      perAgent:150, verificationPolicy:null });
    console.log(`NORMALIZATION_RESULT ${JSON.stringify({companiesNormalized:Number(totals.rows[0].companies),
      firstPass:applied, idempotencyRerun:secondRun, reviewJobs:Number(queue.rows[0].count),
      contactPoints:Number(statuses.rows[0].total), emailOrPhoneActivityNotUnverified:Number(statuses.rows[0].non_unverified_emails)+Number(statuses.rows[0].non_unverified_phones),
      suppressionRows:Number(suppressionRows.rows[0].count), sdr:{uniquePhoneCandidates:batchPreview.uniquePhoneCandidatesBeforeSuppressionReview,
        eligible:batchPreview.verificationCandidates, assigned:batchPreview.assigned, shortage:batchPreview.shortage,
        totalShortage:batchPreview.totalShortage, exclusions:batchPreview.excluded,
        suppressionStatus:batchPreview.suppressionStatus, verificationPolicyStatus:batchPreview.verificationPolicyStatus}})}`);
  } finally { await client.end().catch(() => {}); }
}

main().catch(error => { console.error(`NORMALIZATION_FAILED ${safeError(error)}`); process.exitCode=1; });
