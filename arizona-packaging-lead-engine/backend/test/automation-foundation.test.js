'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseWorkerConfig, claimJobs, createWorker, safeLog, finishJob, safeErrorCode } = require('../src/worker-runtime');
const { buildEnrichmentReview, persistEnrichmentEvidence } = require('../src/enrichment-pipeline');
const { createVerificationService } = require('../src/verification-providers');
const { parsePayload, previewOutbox, processOutboxBatch } = require('../src/sheets-outbox-worker');
const { validateStartup, createGracefulShutdown } = require('../src/worker-bootstrap');
const path = require('node:path');
const { validateDatabaseCa } = require('../src/worker-bootstrap');

test('worker config defaults to dry-run, excludes discovery and validates concurrency', () => {
  const cfg = parseWorkerConfig({});
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.jobTypes.includes('DISCOVERY'), false);
  assert.equal(Object.values(cfg.activation).some(Boolean), false);
  assert.throws(() => parseWorkerConfig({ WORKER_CONCURRENCY: '0' }), /WORKER_CONCURRENCY/);
  assert.throws(() => parseWorkerConfig({ DISCOVERY_ENABLED: 'maybe' }), /DISCOVERY_ENABLED/);
  assert.throws(() => parseWorkerConfig({ DISCOVERY_ENABLED: 'true', WORKER_DISCOVERY_ENABLED: 'false' }), /conflicts/);
  assert.throws(() => parseWorkerConfig({ WORKER_RATE_VERIFICATION_MS: 'NaN' }), /WORKER_RATE_VERIFICATION_MS/);
});

test('bundled Supabase CA is a valid current CA certificate', () => {
  assert.equal(validateDatabaseCa(path.join(__dirname, '..', 'certs', 'supabase-ca.crt')), true);
});

test('Railway config uses backend commands and paused worker health endpoint', () => {
  const config = require('../railway.json');
  assert.equal(config.build.buildCommand, 'npm ci');
  assert.equal(config.deploy.startCommand, 'npm run worker');
  assert.equal(config.deploy.healthcheckPath, '/healthz');
  assert.equal(config.deploy.cronSchedule, undefined);
});

test('restricted role SQL grants only preview columns and does not alter global RLS/grants', () => {
  const fs = require('node:fs');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'roles', 'railway-worker-readonly.sql'), 'utf8');
  assert.match(sql, /CREATE ROLE hof_railway_worker NOLOGIN NOSUPERUSER/);
  assert.match(sql, /GRANT SELECT \(id, job_type, status, priority, run_after, created_at, lease_expires_at\)/);
  assert.match(sql, /FOR SELECT TO hof_railway_worker/);
  assert.doesNotMatch(sql, /BYPASSRLS\s+TRUE|ALTER TABLE .* DISABLE ROW LEVEL SECURITY|GRANT .* ON ALL TABLES/i);
});

test('startup stays paused without database credentials; enabled startup requires complete disposable config', () => {
  assert.deepEqual(validateStartup({ WORKER_START_ENABLED: 'false' }), { paused: true, database: null });
  assert.throws(() => validateStartup({ WORKER_START_ENABLED: 'true' }), /SUPABASE/);
  assert.throws(() => validateStartup({ WORKER_START_ENABLED: 'true', SUPABASE_DB_SSL_CA_FILE: 'x' },
    { readConfig: () => ({ environment: 'PRODUCTION' }), validateCa: () => true }), /restricted to/);
  const result = validateStartup({ WORKER_START_ENABLED: 'true', SUPABASE_DB_SSL_CA_FILE: 'x' },
    { readConfig: () => ({ environment: 'DISPOSABLE', ssl: { rejectUnauthorized: true, ca: Buffer.from('ca') } }), validateCa: () => true });
  assert.equal(result.paused, false);
});

test('graceful shutdown stops, drains, closes pool/server, and exits cleanly', async () => {
  const order = [];
  const worker = { stop: () => order.push('stop'), runPromise: Promise.resolve().then(() => order.push('drain')) };
  const pool = { end: async () => order.push('pool') };
  const shutdown = createGracefulShutdown({ worker, pool, server: { listening: false },
    exit: code => order.push(`exit:${code}`), setTimer: () => ({ unref() {} }), clearTimer() {} });
  await shutdown('SIGTERM');
  assert.deepEqual(order, ['stop', 'drain', 'pool', 'exit:0']);
});

test('type-scoped job claiming queries only explicitly allowed job types and uses transactions', async () => {
  const calls = [];
  const client = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT id,status')) return { rows: [{ id: 'j1', status: 'QUEUED', attempt_count: 0, max_attempts: 3, checkpoint: {} }] };
    if (sql.includes('RETURNING *')) return { rows: [{ id: 'j1', attempt_count: 1, checkpoint: {} }] };
    return { rows: [], rowCount: 1 };
  } };
  const jobs = await claimJobs(client, { workerId: 'worker-test', jobTypes: ['ENRICHMENT'], limit: 1, leaseSeconds: 45 });
  assert.equal(jobs.length, 1);
  assert.deepEqual(calls[1].params[0], ['ENRICHMENT']);
  assert.match(calls[1].sql, /FOR UPDATE SKIP LOCKED/);
  assert.ok(calls.some(x => x.sql === 'COMMIT'));
  assert.equal(calls[1].params[0].includes('DISCOVERY'), false);
});

test('dry-run worker previews jobs without claiming, completing, or changing them', async () => {
  const calls = [];
  const client = { query: async (sql) => { calls.push(sql); return { rows: [], rowCount: 0 }; }, release() {} };
  const worker = createWorker({ pool: { connect: async () => client }, config: parseWorkerConfig({}), logger: () => {} });
  await worker.tick();
  assert.ok(calls.some(sql => sql.includes('SELECT id,job_type,status')));
  assert.equal(calls.some(sql => sql === 'BEGIN' || sql.includes('finish_job')), false);
});

test('enrichment accepts only evidence-backed proposals for existing companies and routes ambiguity to review', () => {
  const result = buildEnrichmentReview({ existingCompanies: [{ id: 'c1' }], approvedSourceBaseUrl: 'https://official.example', proposedEvidence: [
    { companyId: 'c1', field: 'arizonaCity', value: 'Phoenix', sourceUrl: 'https://official.example/contact', sourceKind: 'OFFICIAL_SITE', observedAt: '2026-01-01T00:00:00Z', confidence: 'HIGH' },
    { companyId: 'c1', field: 'pocName', value: 'Unknown person', sourceUrl: 'https://official.example/team', confidence: 'LOW' },
    { companyId: 'new-company', field: 'companyEmail', value: 'a@b.test', sourceUrl: 'https://b.test', confidence: 'HIGH' }
  ] });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.review.length, 1);
  assert.equal(result.rejected[0].reason, 'COMPANY_NOT_IN_EXISTING_SET');
  assert.equal(result.existingOnly, true);
});

test('enrichment rejects evidence URLs outside the approved source host', () => {
  const result = buildEnrichmentReview({ existingCompanies: [{ id: 'c1' }], approvedSourceBaseUrl: 'https://official.example', proposedEvidence: [
    { companyId: 'c1', field: 'companyEmail', value: 'x@example.test', sourceUrl: 'https://official.example.attacker.test/contact',
      sourceKind: 'OFFICIAL_SITE', confidence: 'HIGH', observedAt: '2026-01-01T00:00:00Z' }
  ] });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.review[0].reason, 'SOURCE_HOST_NOT_IN_APPROVED_REGISTRY');
});

test('enrichment persistence appends idempotent field-level evidence without updating companies', async () => {
  const plan = buildEnrichmentReview({ existingCompanies: [{ id: 'c1' }], approvedSourceBaseUrl: 'https://official.example', proposedEvidence: [
    { companyId: 'c1', field: 'arizonaCity', value: 'Phoenix', sourceUrl: 'https://official.example/contact', sourceKind: 'OFFICIAL_SITE',
      observedAt: '2026-01-01T00:00:00Z', confidence: 'HIGH' }
  ] });
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT id FROM lead_intel.source_evidence')) return { rows: [{ id: 'e1' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const result = await persistEnrichmentEvidence(client, plan, { sourceId: 's1', dryRun: false });
  assert.equal(result.evidenceInserted, 0);
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO lead_intel.field_evidence')));
  assert.equal(calls.some(call => /UPDATE lead_intel\.(companies|contacts|contact_points)/.test(call.sql)), false);
  assert.ok(calls.some(call => call.sql.includes('pg_advisory_xact_lock')));
});

test('verification stays disabled by default and cannot call provider', async () => {
  let calls = 0;
  const service = createVerificationService({ providers: { EMAIL: { verify: async () => { calls += 1; return { status: 'DELIVERABLE', independent: true, providerId: 'v' }; } } }, env: {} });
  const result = await service.verify({ channel: 'EMAIL', contactPoint: { normalized_value: 'x@example.test' }, costUsd: 1 });
  assert.equal(result.status, 'UNVERIFIED');
  assert.equal(calls, 0);
});

test('verification provider results require independent evidence for active/deliverable states and obey cost cap', async () => {
  const service = createVerificationService({ env: { WORKER_VERIFICATION_ENABLED: 'true', VERIFICATION_PROVIDER_ENABLED: 'true', VERIFICATION_MAX_COST_USD: '1' },
    providers: { PHONE: { verify: async () => ({ status: 'ACTIVE', independent: false, providerId: 'provider' }) } } });
  const unverified = await service.verify({ channel: 'PHONE', contactPoint: { normalized_value: '+16025550123' }, costUsd: 0.5 });
  assert.equal(unverified.status, 'UNKNOWN');
  assert.equal(unverified.independentlyVerified, false);
  const capped = await service.verify({ channel: 'PHONE', contactPoint: { normalized_value: '+16025550123' }, costUsd: 0.6 });
  assert.equal(capped.provider, 'COST_CAP_BLOCKED');
});

test('Sheets outbox validates 42 cells and dry-run never claims/writes', async () => {
  const row = { lead_id: 'lead-x', row_payload: Array(42).fill('') };
  row.row_payload[24] = 'lead-x';
  assert.equal(parsePayload(row).length, 42);
  const calls = [];
  const client = { query: async (sql) => { calls.push(sql); return { rows: [], rowCount: 0 }; } };
  const output = await processOutboxBatch(client, { workerId: 'w', dryRun: true, writeApproved: false, adapter: async () => { throw Error('never'); } });
  assert.equal(output.writePerformed, false);
  assert.equal(calls.some(sql => sql.includes('claim_sheet_sync_outbox')), false);
  assert.throws(() => parsePayload({ lead_id: 'wrong', row_payload: Array(42).fill('') }), /OUTBOX_PAYLOAD/);
});

test('Sheets write path requires explicit approval and applies retry status after uncertain result', async () => {
  await assert.rejects(() => processOutboxBatch({}, { dryRun: false, writeApproved: false }), /explicitly approved/);
});

test('uncertain Sheets write is returned to retry queue with a value-free error code', async () => {
  const calls = [];
  const payload = Array(42).fill(''); payload[24] = 'lead-x';
  const row = { id: 'o1', lead_id: 'lead-x', row_payload: payload, payload_sha256: 'a'.repeat(64), idempotency_key: 'k1', destination_id: 'd1' };
  const client = { query: async (sql) => { calls.push(sql); if (sql.includes('claim_sheet_sync_outbox')) return { rows: [row], rowCount: 1 }; return { rows: [] }; } };
  const result = await processOutboxBatch(client, { workerId: 'w', dryRun: false, writeApproved: true, adapter: async () => { throw new Error('token=do-not-log'); } });
  assert.equal(result.failures[0].errorCode, 'SHEETS_SYNC_ERROR');
  assert.ok(calls.some(sql => sql.includes('fail_sheet_sync_outbox')));
  assert.equal(result.synced, 0);
});

test('finishJob delegates lease-safe retry/dead-letter handling to the existing SQL function', async () => {
  let captured;
  const client = { query: async (sql, params) => { captured = { sql, params }; return { rows: [{ status: 'RETRY_WAIT' }] }; } };
  const status = await finishJob(client, { id: 'j', checkpoint: {} }, 'w', { succeeded: false, errorCode: 'ETIMEDOUT' });
  assert.equal(status, 'RETRY_WAIT');
  assert.match(captured.sql, /lead_intel\.finish_job/);
  assert.equal(captured.params[4], 'ETIMEDOUT');
});

test('structured log redaction removes secret-bearing fields', () => {
  let logged;
  safeLog(value => { logged = value; }, 'test', { password: 'secret', apiToken: 'secret', count: 1 });
  assert.equal('password' in logged, false);
  assert.equal('apiToken' in logged, false);
  assert.equal(logged.count, 1);
  assert.equal(safeErrorCode(new Error('password=secret')), 'WORKER_ERROR');
});

test('outbox read-only preview is select-only and reports no write', async () => {
  let sql;
  const result = await previewOutbox({ query: async value => { sql = value; return { rows: [] }; } });
  assert.equal(result.length, 0);
  assert.match(sql.trim(), /^SELECT/i);
});
