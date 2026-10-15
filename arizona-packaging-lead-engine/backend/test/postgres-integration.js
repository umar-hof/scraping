'use strict';

// This harness is intentionally limited to loopback PostgreSQL and a random,
// harness-generated database. It never accepts a database name or URL from the caller.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const migrations = path.join(__dirname, '..', 'db', 'migrations');
const psql = process.env.PGTEST_PSQL || 'psql';
const dbName = `hof_leadintel_it_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
const roleName = `hof_leadintel_probe_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

function fail(message) {
  throw new Error(message);
}

function redact(text) {
  return String(text || '').replaceAll(process.env.PGPASSWORD || '\u0000', '[redacted]');
}

function validateLocalSettings() {
  const host = (process.env.PGHOST || 'localhost').toLowerCase();
  if (!loopbackHosts.has(host)) fail('Refusing to run: PGHOST must be localhost or a loopback IP address.');
  if (process.env.PGHOSTADDR && !loopbackHosts.has(process.env.PGHOSTADDR.toLowerCase())) {
    fail('Refusing to run: PGHOSTADDR must be a loopback IP address.');
  }
  if (process.env.PGSERVICE || process.env.PGSERVICEFILE || process.env.DATABASE_URL) {
    fail('Refusing to run with PGSERVICE, PGSERVICEFILE, or DATABASE_URL configured.');
  }
  const port = process.env.PGPORT;
  if (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    fail('PGPORT must be a valid TCP port.');
  }
}

function invoke(args, { allowFailure = false } = {}) {
  const result = spawnSync(psql, ['-X', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PGSSLMODE: 'disable' },
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) {
    if (['ENOENT', 'EPERM'].includes(result.error.code)) {
      fail('psql was not found. Install PostgreSQL locally, add its bin folder to PATH, then rerun the integration command.');
    }
    fail(`Could not start psql (${result.error.code || 'unknown error'}).`);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = redact(result.stderr).trim();
    fail(`psql operation failed (exit ${result.status}): ${detail.slice(-1200) || 'no diagnostic output'}`);
  }
  return { ...result, output: (result.stdout || '').trim() };
}

function adminArgs(sql) {
  return ['-d', process.env.PGTEST_ADMIN_DB || 'postgres', '-c', sql];
}

function runFile(file) {
  if (!fs.existsSync(file)) fail(`Missing SQL test file: ${path.basename(file)}`);
  invoke(['-d', dbName, '-f', file]);
}

function runDatabaseQuery(sql, extraArgs = []) {
  return invoke(['-d', dbName, '-At', '-F', '|', ...extraArgs, '-c', sql]).output;
}

function verifySchemaCatalogs() {
  const requiredTables = [
    'companies','company_locations','company_identifiers','sources','contacts','source_evidence',
    'contact_points','verification_events','discovery_coverage','jobs','job_runs',
    'sheet_sync_state','sheet_sync_row_state','sheet_sync_outbox','suppression',
    'sheet_import_batches','sheet_import_rows','field_evidence'
  ];
  const tableCount = runDatabaseQuery(
    `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace ` +
    `WHERE n.nspname='lead_intel' AND c.relkind='r' AND c.relname = ANY(ARRAY[${requiredTables.map((n) => `'${n}'`).join(',')}])`
  );
  if (tableCount !== String(requiredTables.length)) fail(`Expected ${requiredTables.length} tables; found ${tableCount}.`);

  const unprotected = runDatabaseQuery(
    `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace ` +
    `WHERE n.nspname='lead_intel' AND c.relkind='r' AND NOT c.relrowsecurity`
  );
  if (unprotected !== '0') fail(`${unprotected} lead_intel tables do not have RLS enabled.`);
  const policyCount = runDatabaseQuery("SELECT count(*) FROM pg_policies WHERE schemaname='lead_intel'");
  if (policyCount !== '0') fail(`Expected no permissive/default policies; found ${policyCount}.`);

  const indexes = runDatabaseQuery(
    "SELECT count(*) FROM pg_indexes WHERE schemaname='lead_intel' AND indexname = ANY(ARRAY[" +
    "'companies_domain_idx','company_identifiers_external_id_unique_idx','company_locations_one_primary_idx'," +
    "'jobs_claim_idx','jobs_expired_lease_idx','sheet_sync_outbox_claim_idx'])"
  );
  if (indexes !== '6') fail(`Expected critical dedupe/location/queue/outbox indexes; found ${indexes}.`);
  const fkCount = runDatabaseQuery(
    "SELECT count(*) FROM pg_constraint con JOIN pg_namespace n ON n.oid=con.connamespace " +
    "WHERE n.nspname='lead_intel' AND con.contype='f'"
  );
  if (Number(fkCount) < 10) fail(`Expected foreign keys across normalized entities; found ${fkCount}.`);

  invoke(['-d', dbName, '-c', `GRANT USAGE ON SCHEMA lead_intel TO ${roleName}; GRANT SELECT ON lead_intel.companies TO ${roleName};`]);
  const deniedRows = runDatabaseQuery(
    'SET ROLE ' + roleName + '; SELECT count(*) FROM lead_intel.companies; RESET ROLE;'
  );
  if (deniedRows !== '0') fail('RLS test role could read rows without an explicit policy.');
  console.log('PostgreSQL catalog assertions passed (tables, indexes, foreign keys, RLS and policy isolation).');
}

async function verifyConcurrentClaiming() {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  invoke(['-d', dbName, '-c',
    `INSERT INTO lead_intel.jobs(id,job_type,idempotency_key,priority) VALUES ` +
    `('${first}','RESEARCH','integration-concurrent-high',100),` +
    `('${second}','RESEARCH','integration-concurrent-low',50)`
  ]);

  const blocker = spawn(psql, ['-X', '-v', 'ON_ERROR_STOP=1', '-d', dbName, '-c',
    `BEGIN; SELECT id FROM lead_intel.jobs WHERE id='${first}' FOR UPDATE; ` +
    `SELECT 'LOCK_HELD'; SELECT pg_sleep(3); COMMIT;`
  ], { env: { ...process.env, PGSSLMODE: 'disable' }, windowsHide: true });
  let output = '';
  let errors = '';
  blocker.stdout.setEncoding('utf8');
  blocker.stderr.setEncoding('utf8');
  blocker.stdout.on('data', (chunk) => { output += chunk; });
  blocker.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for PostgreSQL row lock fixture.')), 10000);
      blocker.stdout.on('data', (chunk) => {
        if ((output + chunk).includes('LOCK_HELD')) { clearTimeout(timer); resolve(); }
      });
      blocker.once('error', (error) => { clearTimeout(timer); reject(error); });
      blocker.once('exit', (code) => {
        if (code !== 0) { clearTimeout(timer); reject(new Error(`Lock-holder psql exited ${code}: ${redact(errors).slice(-800)}`)); }
      });
    });
  } catch (error) {
    blocker.kill();
    if (blocker.exitCode === null) await new Promise((resolve) => blocker.once('exit', resolve));
    throw error;
  }

  try {
    const claimed = runDatabaseQuery("SELECT id FROM lead_intel.claim_jobs('concurrent-worker', 1, 30)");
    if (!claimed.startsWith(second)) fail(`Concurrent claimant should skip locked high-priority job and claim ${second}; got ${claimed.slice(0, 80)}.`);
  } finally {
    if (blocker.exitCode === null) await new Promise((resolve) => blocker.once('exit', resolve));
  }
  const afterUnlock = runDatabaseQuery("SELECT id FROM lead_intel.claim_jobs('after-unlock-worker', 1, 30)");
  if (!afterUnlock.startsWith(first)) fail(`Locked job was not claimable after its lock was released: ${afterUnlock.slice(0, 80)}.`);
  console.log('Concurrent job claiming and row-lock lease behavior passed using separate psql sessions.');
}

async function main() {
  validateLocalSettings();
  const version = spawnSync(psql, ['--version'], { encoding: 'utf8', env: process.env, windowsHide: true });
  if (version.error || version.status !== 0) {
    fail(version.error && ['ENOENT', 'EPERM'].includes(version.error.code)
      ? 'psql is unavailable or blocked in this environment. PostgreSQL integration tests were not run.'
      : 'Could not verify psql availability; PostgreSQL integration tests were not run.');
  }
  console.log(`Using ${version.stdout.trim()}; disposable database name: ${dbName}`);

  let databaseCreated = false;
  let roleCreated = false;
  try {
    invoke(adminArgs(`CREATE DATABASE ${dbName} TEMPLATE template0`));
    databaseCreated = true;
    invoke(['-d', dbName, '-f', path.join(migrations, '001_core.up.sql')]);
    invoke(['-d', dbName, '-c',
      "INSERT INTO lead_intel.sources(source_key,display_name,source_type,permission_status,enabled) " +
      "VALUES ('integration-manual-source','Integration fixture source','MANUAL_REVIEW','MANUAL_ONLY',true)"
    ]);
    runFile(path.join(__dirname, 'postgres-core.integration.sql'));
    invoke(['-d', dbName, '-f', path.join(migrations, '002_operations.up.sql')]);
    invoke(['-d', dbName, '-f', path.join(migrations, '003_sheet_import_and_field_evidence.up.sql')]);
    invoke(adminArgs(`CREATE ROLE ${roleName} NOLOGIN`));
    roleCreated = true;
    verifySchemaCatalogs();
    runFile(path.join(__dirname, 'postgres-operations.integration.sql'));
    await verifyConcurrentClaiming();

    invoke(['-d', dbName, '-f', path.join(migrations, '003_sheet_import_and_field_evidence.down.sql')]);
    invoke(['-d', dbName, '-f', path.join(migrations, '002_operations.down.sql')]);
    invoke(['-d', dbName, '-f', path.join(migrations, '001_core.down.sql')]);
    const remainingSchema = runDatabaseQuery("SELECT count(*) FROM pg_namespace WHERE nspname='lead_intel'");
    if (remainingSchema !== '0') fail('Disposable rollback left the lead_intel schema behind.');
    console.log('Disposable rollback assertions passed.');
  } finally {
    try {
      if (databaseCreated) {
        invoke(adminArgs(`DROP DATABASE ${dbName} WITH (FORCE)`));
        console.log('Removed the harness-created disposable database.');
      }
    } finally {
      if (roleCreated) {
        invoke(adminArgs(`DROP ROLE ${roleName}`));
        console.log('Removed the temporary RLS probe role.');
      }
    }
  }
}

main().catch((error) => {
  console.error(`PostgreSQL integration tests NOT PASSED: ${error.message}`);
  process.exitCode = 1;
});
