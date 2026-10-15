'use strict';

const { readProspectsTab } = require('../src/sheets-import');
const { buildImportPreview } = require('../src/sheets-import');
const { buildExistingRecordAudit } = require('../src/quality');
const { buildSdrBatches } = require('../src/sdr-batching');
const { loadLocalEnv } = require('../src/local-env');

async function main(env = process.env) {
  loadLocalEnv(env);
  const snapshot = await readProspectsTab({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    accessToken: env.GOOGLE_SHEETS_ACCESS_TOKEN
  });
  const records = snapshot.records.map((item) => item.record);
  const audit = buildExistingRecordAudit(records);
  const suppressions = String(env.SDR_SUPPRESSIONS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const fields = ['pocName','companyEmail','pocEmailId','companyContactNumber','pocContactNumber','liPocProfile','employeeSize','arizonaCity'];
  const missing = Object.fromEntries(fields.map((field) => [field,
    records.filter((record) => /^(?:|UNKNOWN|MISSING|N\/A)$/i.test(String(record[field] || '').trim())).length]));
  let databaseReconciliation = { status: 'NOT_RUN_NO_SUPABASE_CONNECTION' };
  if (env.SUPABASE_DB_HOST) {
    let client;
    try {
      const { readSupabaseConfig } = require('../src/supabase-config');
      const { Client } = require('pg');
      client = new Client(readSupabaseConfig(env));
      await client.connect();
      const stored = await client.query(
        'SELECT lead_id AS "leadId", payload_sha256 AS "payloadSha256" FROM lead_intel.sheet_import_rows WHERE source_spreadsheet_id=$1',
        [snapshot.spreadsheetId]
      );
      const importPreview = buildImportPreview(snapshot, stored.rows);
      databaseReconciliation = { status: 'READ_ONLY_PREVIEW', ...importPreview.counts, planSha256: importPreview.planSha256 };
      const suppressionRows = await client.query(
        `SELECT DISTINCT ci.normalized_value AS lead_id, cp.normalized_value AS phone
           FROM lead_intel.suppression s
           JOIN lead_intel.company_identifiers ci ON ci.company_id=s.company_id AND ci.identifier_type='APPS_SCRIPT_LEAD_ID'
           LEFT JOIN lead_intel.contact_points cp ON cp.company_id=s.company_id AND cp.channel='PHONE'
             AND (s.contact_point_id IS NULL OR cp.id=s.contact_point_id)
             AND (s.contact_id IS NULL OR cp.contact_id=s.contact_id)
          WHERE s.rescinded_at IS NULL AND s.effective_at <= clock_timestamp()
            AND (s.expires_at IS NULL OR s.expires_at > clock_timestamp())
            AND (s.channel IS NULL OR s.channel IN ('PHONE','ALL'))`);
      suppressions.push(...suppressionRows.rows.flatMap((row) => [row.lead_id, row.phone].filter(Boolean)));
    } catch (_) {
      databaseReconciliation = { status: 'UNAVAILABLE_OR_SCHEMA_NOT_READY' };
    } finally { if (client) await client.end().catch(() => {}); }
  }
  const sdr = buildSdrBatches(records, { campaignId: 'PREVIEW_ONLY', suppressions, verificationPolicy:null });
  process.stdout.write(`SHEETS_READ_PREVIEW ${JSON.stringify({
    spreadsheetId: snapshot.spreadsheetId,
    tabName: snapshot.tabName,
    records: snapshot.records.length,
    rejectedRows: snapshot.rejected.length,
    missing,
    qualification: {
      eligibleExisting: audit.audited.filter((row) => row.qualificationStatus === 'ELIGIBLE_EXISTING_ONLY').length,
      needsReview: audit.audited.filter((row) => row.qualificationStatus !== 'ELIGIBLE_EXISTING_ONLY').length,
      duplicateLeadRows: audit.audited.filter((row) => row.issues.includes('DUPLICATE_LEAD_ID')).length,
      sharedWebsiteDomains: audit.sharedDomains.length
    },
    sdrPreview: { suppressionStatus: sdr.suppressionStatus,
      uniquePhoneCandidatesBeforeSuppressionReview: sdr.uniquePhoneCandidatesBeforeSuppressionReview,
      uniqueEligibleNumbers: sdr.eligibleUniquePhones, assigned: sdr.assigned,
      totalShortage: sdr.totalShortage, shortage: sdr.shortage, excluded: sdr.excluded },
    sourceEvidenceMissingFields: audit.audited.reduce((sum, row) => sum + row.fieldEvidence.filter((field) => field.status === 'NEEDS_SOURCE').length, 0),
    databaseReconciliation,
    writePerformed: false,
    outreachSent: false
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`SHEETS_PREVIEW_FAILED ${String(error.message || 'Read failed').replace(/Bearer\s+\S+/gi, '[token-redacted]')}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
