'use strict';

// Non-destructive integration checks for an already-migrated disposable Supabase project.
// Schema is never dropped. Transactional fixtures are rolled back; the two committed
// concurrency jobs use an unpredictable run key and are deleted in finally.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { loadLocalEnv } = require('../src/local-env');
const { readSupabaseConfig } = require('../src/supabase-config');
const { listMigrations, readMigrationStatus } = require('../src/migration-runner');
const { PROSPECTS_HEADERS } = require('../src/prospects-contract');
const { sha256 } = require('../src/sheets-import');
const { buildNormalizationPreview, persistNormalization } = require('../src/normalization');
const { buildSdrBatches } = require('../src/sdr-batching');

loadLocalEnv();
const config = readSupabaseConfig();
assert.equal(config.environment, 'DISPOSABLE', 'Cloud integration tests require SUPABASE_ENVIRONMENT=DISPOSABLE.');
assert.equal(config.ssl.rejectUnauthorized, true, 'TLS certificate and hostname verification must remain enabled.');
assert(config.ssl.ca, 'The trusted Supabase CA certificate must be configured.');
assert.equal(config.database, 'postgres');
assert(config.host.endsWith('.pooler.supabase.com') || config.host === `db.${config.projectRef}.supabase.co`,
  'Unexpected Supabase endpoint; use the confirmed disposable project direct/session endpoint.');
if (config.host.endsWith('.pooler.supabase.com')) {
  assert.equal(config.port, 5432, 'Only the session pooler is supported for these tests.');
  assert(config.user.endsWith(`.${config.projectRef}`), 'Pooler username must match the configured project ref.');
} else {
  assert.equal(config.port, 5432, 'Direct PostgreSQL must use port 5432.');
}

const expectedTables = [
  'companies','company_locations','company_identifiers','sources','contacts','source_evidence',
  'contact_points','verification_events','discovery_coverage','jobs','job_runs',
  'sheet_sync_state','sheet_sync_row_state','sheet_sync_outbox','suppression',
  'sheet_import_batches','sheet_import_rows','field_evidence'
];
const sqlFile = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8')
  .replace(/^\s*\\set[^\r\n]*(?:\r?\n|$)/gm, '');

async function checkSchema(client) {
  const tables = await client.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='lead_intel' AND c.relkind='r' ORDER BY c.relname`);
  assert.deepEqual(tables.rows.map((r) => r.relname).sort(), expectedTables.slice().sort(), 'Unexpected application table set.');
  const rls = await client.query(
    "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lead_intel' AND c.relkind='r' AND c.relrowsecurity");
  assert.equal(rls.rows[0].n, expectedTables.length, 'Every application table must have RLS enabled.');
  const policies = await client.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='lead_intel'");
  assert.equal(policies.rows[0].n, 0, 'Unexpected RLS policies found; review before application access.');
  const publicGrants = await client.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r',c.relowner))) a
     WHERE n.nspname='lead_intel' AND c.relkind='r' AND a.grantee=0`);
  assert.equal(publicGrants.rows[0].n, 0, 'PUBLIC has table privileges in lead_intel.');
  const indexes = await client.query(
    `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='lead_intel' AND indexname = ANY($1::text[])`,
    [['companies_domain_idx','company_identifiers_external_id_unique_idx','company_locations_one_primary_idx',
      'jobs_claim_idx','jobs_expired_lease_idx','sheet_sync_outbox_claim_idx']]);
  assert.equal(indexes.rows[0].n, 6, 'One or more required indexes are absent.');
  const fks = await client.query(
    `SELECT count(*)::int AS n FROM pg_constraint con JOIN pg_namespace n ON n.oid=con.connamespace
     WHERE n.nspname='lead_intel' AND con.contype='f'`);
  assert(fks.rows[0].n >= 10, 'Expected foreign keys across normalized entities.');
  console.log('PASS schema catalogs: 18 tables, required indexes/FKs, RLS enabled, no policies or PUBLIC table grants');
}

async function checkRlsBehavior(client, runId) {
  const roles = await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') ORDER BY CASE rolname WHEN 'anon' THEN 0 ELSE 1 END LIMIT 1");
  assert(roles.rows.length, 'No standard low-privilege Supabase role available for the RLS behavior test.');
  const role = roles.rows[0].rolname;
  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO lead_intel.companies(canonical_name) VALUES ($1)', [`Cloud RLS fixture ${runId}`]);
    await client.query(`GRANT USAGE ON SCHEMA lead_intel TO ${role}`);
    await client.query(`GRANT SELECT ON lead_intel.companies TO ${role}`);
    await client.query(`SET LOCAL ROLE ${role}`);
    const visible = await client.query('SELECT count(*)::int AS n FROM lead_intel.companies WHERE canonical_name=$1', [`Cloud RLS fixture ${runId}`]);
    assert.equal(visible.rows[0].n, 0, `${role} could read a fixture row despite enabled RLS and no policy.`);
    console.log(`PASS RLS behavior: ${role} cannot read a row without a policy`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

async function checkTransactionalFixtures(client) {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO lead_intel.sources(source_key,display_name,source_type,permission_status,enabled)
       VALUES ('integration-manual-source','Integration fixture source','MANUAL_REVIEW','MANUAL_ONLY',true)`);
    await client.query(sqlFile('postgres-core.integration.sql'));
    await client.query(sqlFile('postgres-operations.integration.sql'));
    const fieldTest = await client.query(`
      DO $$ DECLARE c uuid; e uuid; caught boolean:=false; BEGIN
        SELECT id INTO c FROM lead_intel.companies WHERE canonical_name='Integration Brand A';
        SELECT id INTO e FROM lead_intel.source_evidence WHERE company_id=c AND source_url='https://shared.example/contact';
        INSERT INTO lead_intel.field_evidence(company_id,source_evidence_id,field_key,observed_value_sha256,idempotency_key,observed_at,confidence)
          VALUES(c,e,'company_domain',repeat('d',64),'integration-field-evidence-v1',clock_timestamp(),0.9);
        BEGIN
          INSERT INTO lead_intel.field_evidence(company_id,source_evidence_id,field_key,observed_value_sha256,idempotency_key,observed_at)
            VALUES(c,e,'company_domain',repeat('d',64),'integration-field-evidence-v1',clock_timestamp());
        EXCEPTION WHEN unique_violation THEN caught:=true; END;
        IF NOT caught THEN RAISE EXCEPTION 'field evidence idempotency was not enforced'; END IF;
        caught:=false;
        BEGIN UPDATE lead_intel.field_evidence SET field_key='changed' WHERE idempotency_key='integration-field-evidence-v1';
        EXCEPTION WHEN raise_exception THEN caught:=true; END;
        IF NOT caught THEN RAISE EXCEPTION 'field evidence update was accepted'; END IF;
      END $$`);
    void fieldTest;
    console.log('PASS transactional fixtures: identity/dedupe, shared domain, locations, contact scope, verification, retries/dead-letter, outbox and field evidence');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

async function checkConcurrentClaims(client, runId) {
  const prefix = `cloud-it-${runId}`;
  const keys = [`${prefix}-high`, `${prefix}-low`];
  let blocker;
  let claimant;
  try {
    await client.query(
      `INSERT INTO lead_intel.jobs(job_type,idempotency_key,priority,max_attempts)
       VALUES ('RESEARCH',$1,100,3),('RESEARCH',$2,3,3)`, keys);
    blocker = new Client(config);
    claimant = new Client(config);
    await blocker.connect();
    await claimant.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM lead_intel.jobs WHERE idempotency_key=$1 FOR UPDATE', [keys[0]]);
    const whileLocked = await claimant.query('SELECT idempotency_key FROM lead_intel.claim_jobs($1,1,30)', [`${prefix}-worker-a`]);
    assert.equal(whileLocked.rows[0] && whileLocked.rows[0].idempotency_key, keys[1], 'Claim did not skip the locked high-priority job.');
    await blocker.query('COMMIT');
    const afterUnlock = await claimant.query('SELECT idempotency_key FROM lead_intel.claim_jobs($1,1,30)', [`${prefix}-worker-b`]);
    assert.equal(afterUnlock.rows[0] && afterUnlock.rows[0].idempotency_key, keys[0], 'Locked job was not claimable after release.');
    const lease = await claimant.query('SELECT status,lease_owner,lease_expires_at>clock_timestamp() AS live FROM lead_intel.jobs WHERE idempotency_key=$1', [keys[0]]);
    assert.equal(lease.rows[0].status, 'LEASED');
    assert.equal(lease.rows[0].live, true);
    console.log('PASS concurrent job claims: separate sessions skip locked row, lease, and reclaim after unlock');
  } finally {
    if (blocker) {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end().catch(() => {});
    }
    if (claimant) await claimant.end().catch(() => {});
    const found = await client.query('SELECT id FROM lead_intel.jobs WHERE idempotency_key=ANY($1::text[])', [keys]);
    if (found.rows.length) {
      const ids = found.rows.map((r) => r.id);
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM lead_intel.job_runs WHERE job_id=ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM lead_intel.jobs WHERE id=ANY($1::uuid[])', [ids]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
  }
}

async function checkSnapshotNormalization(client) {
  const spreadsheetId = process.env.EXPECTED_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('EXPECTED_SPREADSHEET_ID is required for this disposable integration test.');
  const batch = await client.query(`SELECT id,header_sha256 FROM lead_intel.sheet_import_batches WHERE source_spreadsheet_id=$1 AND source_tab_name='Prospects'`, [spreadsheetId]);
  assert.equal(batch.rowCount, 1, 'Expected the already-approved single source snapshot batch.');
  assert.equal(batch.rows[0].header_sha256.trim(), sha256(JSON.stringify(PROSPECTS_HEADERS)));
  const sourceRows = await client.query(`SELECT id,source_row_number,lead_id,row_payload,payload_sha256 FROM lead_intel.sheet_import_rows WHERE batch_id=$1 ORDER BY source_row_number`, [batch.rows[0].id]);
  assert.equal(sourceRows.rowCount, 20);
  for (const row of sourceRows.rows) assert.equal(sha256(JSON.stringify(row.row_payload)), row.payload_sha256);
  const sourceKey = `google-sheets-snapshot:${spreadsheetId}`;
  const identifiers = await client.query(`SELECT company_id,identifier_type,normalized_value FROM lead_intel.company_identifiers WHERE identifier_namespace=$1 AND identifier_type='APPS_SCRIPT_LEAD_ID'`, [sourceKey]);
  const companies = await client.query('SELECT id,lower(canonical_name) AS normalized_name FROM lead_intel.companies');
  const preview = buildNormalizationPreview(sourceRows.rows, { spreadsheetId, existingIdentifiers:identifiers.rows, existingCompanies:companies.rows });
  assert.equal(preview.counts.identityConflicts, 0);
  assert.equal(preview.counts.companiesToCreate, 0, 'Normalization was not persisted for all 20 source Lead IDs.');
  assert.equal(preview.counts.companiesToReuse, 20);
  const rerun = await persistNormalization(client, preview, { approvedPlanSha256:preview.planSha256, confirmImport:true, environment:'DISPOSABLE' });
  assert.equal(rerun.companiesCreated, 0);
  assert.equal(rerun.locationsCreated, 0);
  assert.equal(rerun.contactsCreated, 0);
  assert.equal(rerun.companyContactPointsCreated, 0);
  assert.equal(rerun.personContactPointsCreated, 0);
  assert.equal(rerun.fieldEvidenceCreated, 0);
  const verified = await client.query(`SELECT count(*)::int AS total,
    count(*) FILTER(WHERE channel='EMAIL' AND email_deliverability_status<>'UNVERIFIED')::int AS email_promoted,
    count(*) FILTER(WHERE channel='PHONE' AND phone_activity_status<>'UNVERIFIED')::int AS phone_promoted
    FROM lead_intel.contact_points cp JOIN lead_intel.company_identifiers ci ON ci.company_id=cp.company_id
    WHERE ci.identifier_namespace=$1 AND ci.identifier_type='APPS_SCRIPT_LEAD_ID'`, [sourceKey]);
  assert.equal(verified.rows[0].total, 25);
  assert.equal(verified.rows[0].email_promoted, 0);
  assert.equal(verified.rows[0].phone_promoted, 0);
  const normalized = await client.query(`SELECT
    (SELECT count(*)::int FROM lead_intel.company_locations l JOIN lead_intel.company_identifiers i ON i.company_id=l.company_id WHERE i.identifier_namespace=$1 AND i.identifier_type='APPS_SCRIPT_LEAD_ID') AS locations,
    (SELECT count(*)::int FROM lead_intel.contacts c JOIN lead_intel.company_identifiers i ON i.company_id=c.company_id WHERE i.identifier_namespace=$1 AND i.identifier_type='APPS_SCRIPT_LEAD_ID') AS contacts,
    (SELECT count(*)::int FROM lead_intel.field_evidence f JOIN lead_intel.company_identifiers i ON i.company_id=f.company_id WHERE i.identifier_namespace=$1 AND i.identifier_type='APPS_SCRIPT_LEAD_ID') AS field_evidence,
    (SELECT count(*)::int FROM lead_intel.jobs j WHERE j.job_type='MANUAL_REVIEW' AND j.payload->>'kind'='EXISTING_PROSPECT_QUALITY_REVIEW') AS review_jobs`, [sourceKey]);
  assert.equal(normalized.rows[0].locations, 20);
  assert.equal(normalized.rows[0].contacts, 5);
  assert.equal(normalized.rows[0].field_evidence, 216);
  assert.equal(normalized.rows[0].review_jobs, 157);
  const plan = buildSdrBatches(preview.rows.map(r=>r.record), { campaignId:'cloud-readiness-check', verificationPolicy:null });
  assert.equal(plan.uniquePhoneCandidatesBeforeSuppressionReview, 11);
  assert.equal(plan.assigned, 0);
  assert.equal(plan.totalShortage, 450);
  console.log('PASS snapshot normalization: 20 Lead IDs linked, 20 locations, 5 named contacts, 25 scoped contact points, 216 field evidence links, 157 review jobs, activity/deliverability unverified, idempotent rerun; SDR assignment blocked');
}

async function main() {
  const runId = crypto.randomUUID();
  const client = new Client(config);
  try {
    await client.connect();
    const status = await readMigrationStatus(client);
    const expected = listMigrations();
    assert.equal(status.length, expected.length, 'All three migrations must be applied before integration tests.');
    for (let i=0;i<expected.length;i+=1) {
      assert.equal(Number(status[i].version), expected[i].version);
      assert.equal(status[i].name, expected[i].name);
      assert.equal(status[i].checksum.trim(), expected[i].checksum);
    }
    console.log('PASS migration ledger: versions 001–003 and checksums match local bundle');
    await checkSchema(client);
    await checkRlsBehavior(client, runId);
    await checkTransactionalFixtures(client);
    await checkConcurrentClaims(client, runId);
    await checkSnapshotNormalization(client);
    console.log('SUPABASE_CLOUD_INTEGRATION PASSED; schema retained; test fixtures rolled back or safely idempotent; unique concurrency fixtures cleaned');
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  const message = String(error && error.message || 'integration test failed')
    .replaceAll(process.env.SUPABASE_DB_PASSWORD || '\u0000', '[redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url-redacted]');
  console.error(`SUPABASE_CLOUD_INTEGRATION FAILED: ${message}`);
  process.exitCode = 1;
});
