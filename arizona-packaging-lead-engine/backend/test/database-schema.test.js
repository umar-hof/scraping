'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PROSPECTS_HEADERS } = require('../src/prospects-contract');

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
const core = fs.readFileSync(path.join(migrationsDir, '001_core.up.sql'), 'utf8');
const operations = fs.readFileSync(path.join(migrationsDir, '002_operations.up.sql'), 'utf8');
const coreDown = fs.readFileSync(path.join(migrationsDir, '001_core.down.sql'), 'utf8');
const operationsDown = fs.readFileSync(path.join(migrationsDir, '002_operations.down.sql'), 'utf8');
const importEvidence = fs.readFileSync(path.join(migrationsDir, '003_sheet_import_and_field_evidence.up.sql'), 'utf8');
const importEvidenceDown = fs.readFileSync(path.join(migrationsDir, '003_sheet_import_and_field_evidence.down.sql'), 'utf8');
const allUp = `${core}\n${operations}\n${importEvidence}`;

test('versioned migrations have ordered up/down pairs and explicit transactions', () => {
  const files = fs.readdirSync(migrationsDir).sort();
  assert.deepEqual(files, [
    '001_core.down.sql', '001_core.up.sql',
    '002_operations.down.sql', '002_operations.up.sql',
    '003_sheet_import_and_field_evidence.down.sql', '003_sheet_import_and_field_evidence.up.sql'
  ]);
  for (const sql of [core, operations, importEvidence, coreDown, operationsDown, importEvidenceDown]) {
    assert.match(sql.trimStart(), /^BEGIN;/i);
    assert.match(sql.trimEnd(), /COMMIT;$/i);
    assert.equal((sql.match(/\$\$/g) || []).length % 2, 0, 'dollar-quoted function blocks are balanced');
  }
});

test('migration establishes all requested tables in a non-public schema', () => {
  const required = [
    'companies', 'company_identifiers', 'company_locations', 'contacts', 'contact_points',
    'sources', 'source_evidence', 'verification_events', 'discovery_coverage', 'jobs',
    'job_runs', 'sheet_sync_outbox', 'sheet_sync_state', 'sheet_sync_row_state', 'suppression'
  ];
  for (const table of required) assert.match(allUp, new RegExp(`CREATE TABLE lead_intel\\.${table}\\s*\\(`, 'i'));
  assert.match(core, /CREATE SCHEMA lead_intel;/i);
  assert.doesNotMatch(allUp, /CREATE\s+TABLE\s+public\./i);
  assert.match(allUp, /REVOKE ALL ON ALL TABLES IN SCHEMA lead_intel FROM PUBLIC;/i);
});

test('42-column Prospects schema contract remains unchanged', () => {
  assert.equal(PROSPECTS_HEADERS.length, 42);
  assert.match(operations, /expected_column_count integer NOT NULL DEFAULT 42 CHECK \(expected_column_count = 42\)/i);
  assert.match(operations, /jsonb_array_length\(row_payload\) = 42/i);
});

test('company domains are searchable but not assumed globally unique; locations are one-to-many', () => {
  assert.match(core, /primary_domain text/i);
  assert.match(core, /companies_domain_idx ON lead_intel\.companies \(lower\(primary_domain\)\)/i);
  assert.doesNotMatch(core, /UNIQUE\s*\([^)]*primary_domain/i);
  assert.match(core, /company_id uuid NOT NULL REFERENCES lead_intel\.companies\(id\)/i);
  assert.match(core, /company_identifiers_external_id_unique_idx[\s\S]*?identifier_type IN \('APPS_SCRIPT_LEAD_ID','SOURCE_RECORD_ID','STATE_ENTITY_ID'\)/i);
  assert.doesNotMatch(core, /company_identifiers_external_id_unique_idx[\s\S]*?WEBSITE_DOMAIN/i);
  assert.match(core, /UNIQUE INDEX company_locations_one_primary_idx/i);
});

test('company and person contact points have separate scope and channel-specific statuses', () => {
  assert.match(core, /scope_kind text NOT NULL CHECK \(scope_kind IN \('COMPANY','PERSON'\)\)/i);
  assert.match(core, /CHECK \(\(scope_kind = 'COMPANY' AND contact_id IS NULL\) OR \(scope_kind = 'PERSON' AND contact_id IS NOT NULL\)\)/i);
  assert.match(core, /email_deliverability_status[\s\S]*?CATCH_ALL[\s\S]*?UNVERIFIED/i);
  assert.match(core, /phone_activity_status[\s\S]*?ACTIVE[\s\S]*?INACTIVE[\s\S]*?UNVERIFIED/i);
  assert.match(core, /is_publicly_listed OR source_evidence_id IS NOT NULL/i);
});

test('verification history distinguishes statuses, raw provider codes, timestamps, and independent results', () => {
  assert.match(core, /CREATE TABLE lead_intel\.verification_events/i);
  assert.match(core, /provider_result_code text/i);
  assert.match(core, /checked_at timestamptz/i);
  assert.match(core, /fresh_until timestamptz/i);
  assert.match(core, /verification_state text NOT NULL CHECK \(verification_state IN \('UNVERIFIED','VERIFIED','INVALID','UNKNOWN'\)\)/i);
  assert.match(core, /independent_verifier boolean/i);
  assert.match(core, /check_type <> 'EMAIL_DELIVERABILITY'[\s\S]*?independent_verifier/i);
  assert.match(core, /check_type <> 'PHONE_ACTIVITY'[\s\S]*?independent_verifier/i);
  assert.match(core, /CREATE TRIGGER verification_events_append_only BEFORE UPDATE OR DELETE/i);
});

test('discovery coverage is keyed by Arizona geography, source, and industry without a completeness claim', () => {
  assert.match(operations, /state_code char\(2\) NOT NULL DEFAULT 'AZ' CHECK \(state_code = 'AZ'\)/i);
  assert.match(operations, /geography_type IN \('STATE','COUNTY','CITY','ZIP'\)/i);
  assert.match(operations, /zip_code varchar\(5\)/i);
  assert.match(operations, /industry_key text NOT NULL/i);
  assert.match(operations, /UNIQUE \(source_id, state_code, geography_type, geography_key, industry_key\)/i);
  const docs = fs.readFileSync(path.join(__dirname, '..', 'db', 'README.md'), 'utf8');
  assert.match(docs, /not a claim of market completeness/i);
});

test('job queue uses row locking, leases, attempt limits, checkpoints, and retry history', () => {
  assert.match(operations, /CREATE FUNCTION lead_intel\.claim_jobs/i);
  assert.match(operations, /FOR UPDATE SKIP LOCKED/i);
  assert.match(operations, /lease_expires_at = clock_timestamp\(\) \+ make_interval/i);
  assert.match(operations, /attempt_count = j\.attempt_count \+ 1/i);
  assert.match(operations, /CREATE FUNCTION lead_intel\.finish_job/i);
  assert.match(operations, /checkpoint = COALESCE\(p_checkpoint, checkpoint\)/i);
  assert.match(operations, /final_status := 'RETRY_WAIT'/i);
  assert.match(operations, /final_status := 'DEAD_LETTER'/i);
  assert.match(operations, /CREATE TABLE lead_intel\.job_runs/i);
});

test('Sheets outbox is versioned, unique, leased, retryable, and acknowledges by payload hash', () => {
  assert.match(operations, /UNIQUE \(destination_id, lead_id, projection_version, row_version\)/i);
  assert.match(operations, /idempotency_key text NOT NULL UNIQUE/i);
  assert.match(operations, /CREATE FUNCTION lead_intel\.claim_sheet_sync_outbox/i);
  assert.match(operations, /s\.status IN \('READY','SYNCING'\)/i);
  assert.match(operations, /CREATE FUNCTION lead_intel\.fail_sheet_sync_outbox/i);
  assert.match(operations, /CREATE FUNCTION lead_intel\.ack_sheet_sync_outbox/i);
  assert.match(operations, /item\.payload_sha256 <> p_payload_sha256/i);
  assert.match(operations, /p_worker_id IS NULL OR btrim\(p_worker_id\) = ''/i);
  assert.match(operations, /CREATE TRIGGER suppression_no_hard_delete BEFORE DELETE/i);
  assert.match(operations, /ON CONFLICT \(destination_id, lead_id\) DO UPDATE/i);
});

test('suppression supports company, person, and point-scoped opt-outs and do-not-contact', () => {
  assert.match(operations, /CREATE TABLE lead_intel\.suppression/i);
  assert.match(operations, /OPT_OUT','DO_NOT_CONTACT/i);
  assert.match(operations, /contact_point_id uuid/i);
  assert.match(operations, /rescinded_at timestamptz/i);
  assert.match(operations, /suppression_active_point_idx/i);
});

test('RLS is enabled and no public grants or exposed-schema setup are present', () => {
  const tableNames = [...allUp.matchAll(/CREATE TABLE lead_intel\.([a-z_]+)/gi)].map((m) => m[1]);
  for (const table of tableNames) assert.match(allUp, new RegExp(`ALTER TABLE lead_intel\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'));
  assert.doesNotMatch(allUp, /GRANT\s+[^;]*\bTO\s+PUBLIC/i);
  assert.match(allUp, /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lead_intel FROM PUBLIC/i);
});

test('rollback scripts drop operational objects first and warn that rollback is destructive', () => {
  const dropOrder = [
    'DROP TABLE lead_intel.suppression', 'DROP TABLE lead_intel.sheet_sync_outbox',
    'DROP TABLE lead_intel.sheet_sync_row_state', 'DROP TABLE lead_intel.sheet_sync_state',
    'DROP TABLE lead_intel.job_runs', 'DROP TABLE lead_intel.jobs', 'DROP TABLE lead_intel.discovery_coverage'
  ];
  let cursor = -1;
  for (const token of dropOrder) {
    const next = operationsDown.indexOf(token);
    assert.ok(next > cursor, `${token} must be dropped after dependent tables`);
    cursor = next;
  }
  assert.match(coreDown, /DROP SCHEMA lead_intel;/i);
  assert.doesNotMatch(coreDown, /CASCADE/i);
  const docs = fs.readFileSync(path.join(__dirname, '..', 'db', 'README.md'), 'utf8');
  assert.match(docs, /permanently destroy data/i);
});
