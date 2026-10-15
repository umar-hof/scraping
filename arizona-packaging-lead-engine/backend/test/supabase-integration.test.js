'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readSupabaseConfig } = require('../src/supabase-config');
const { listMigrations, migrationBundleHash, assertMigrationAuthorization, healthCheck, applyMigrations } = require('../src/migration-runner');
const { safeMessage } = require('../scripts/supabase');

function env(overrides = {}) {
  return { SUPABASE_DB_HOST: 'db.abcdefghij1234567890.supabase.co', SUPABASE_DB_PORT: '5432',
    SUPABASE_DB_NAME: 'postgres', SUPABASE_DB_USER: 'postgres', SUPABASE_DB_PASSWORD: 'hidden',
    SUPABASE_PROJECT_REF: 'abcdefghij1234567890', SUPABASE_ENVIRONMENT: 'DISPOSABLE', ...overrides };
}

test('Supabase config requires a recognized project endpoint and TLS certificate validation', () => {
  const config = readSupabaseConfig(env());
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.projectRef, 'abcdefghij1234567890');
  assert.throws(() => readSupabaseConfig(env({ SUPABASE_DB_HOST: 'production.example.com' })), /Supabase database host/);
  assert.throws(() => readSupabaseConfig(env({ SUPABASE_PROJECT_REF: 'differentproject12345' })), /does not match/);
  assert.throws(() => readSupabaseConfig(env({ SUPABASE_ENVIRONMENT: 'UNKNOWN' })), /must be DISPOSABLE or PRODUCTION/);
});

test('migration bundle is ordered, checksummed, and includes additive sheet snapshot and field-evidence migration', () => {
  const migrations = listMigrations();
  assert.deepEqual(migrations.map((item) => item.version), [1, 2, 3]);
  assert.equal(migrationBundleHash(migrations).length, 64);
  assert.match(migrations[2].sql, /sheet_import_rows/);
  assert.match(migrations[2].sql, /field_evidence/);
  assert.match(migrations[2].sql, /jsonb_array_length\(row_payload\) = 42/);
});

test('migrations require exact disposable confirmation and block live without tested bundle plus exact confirmation', () => {
  const migrations = listMigrations();
  const bundle = migrationBundleHash(migrations);
  assert.throws(() => assertMigrationAuthorization({ environment: 'DISPOSABLE', projectRef: 'test-ref', migrations }), /typing its exact/);
  assert.doesNotThrow(() => assertMigrationAuthorization({ environment: 'DISPOSABLE', projectRef: 'test-ref', migrations, confirmation: 'test-ref' }));
  assert.throws(() => assertMigrationAuthorization({ environment: 'PRODUCTION', projectRef: 'live-ref', migrations,
    confirmation: 'live-ref', disposableBundleValidated: 'wrong-hash' }), /first validate/);
  assert.throws(() => assertMigrationAuthorization({ environment: 'PRODUCTION', projectRef: 'live-ref', migrations,
    confirmation: 'wrong-ref', disposableBundleValidated: bundle }), /exact project ref/);
  assert.doesNotThrow(() => assertMigrationAuthorization({ environment: 'PRODUCTION', projectRef: 'live-ref', migrations,
    confirmation: 'live-ref', disposableBundleValidated: bundle }));
});

test('health check query is read-only and safe logs redact database URLs and passwords', async () => {
  let queryText = '';
  const result = await healthCheck({ query: async (sql) => { queryText = sql; return { rows: [{ database: 'postgres', database_user: 'probe', server_version: 'PostgreSQL' }] }; } },
  { projectRef: 'ref', environment: 'DISPOSABLE' });
  assert.match(queryText, /^SELECT/);
  assert.equal(result.ok, true);
  assert.equal(safeMessage(new Error('bad postgres://user:pass@host/db hidden')), 'bad [database-url-redacted] hidden');
});

test('migration result counts report newly applied and already-applied versions accurately', async () => {
  const ledger = [];
  const client = {
    async connect() {},
    async end() {},
    async query(sql, params = []) {
      if (sql.includes('to_regclass')) return { rows: [{ ledger: 'lead_intel_migrations.schema_migrations' }] };
      if (sql.startsWith('SELECT version, name, checksum')) return { rows: ledger.slice() };
      if (sql.startsWith('INSERT INTO lead_intel_migrations.schema_migrations')) {
        ledger.push({ version: params[0], name: params[1], checksum: params[2] });
      }
      return { rows: [] };
    }
  };
  const migrations = [{ version: 1, name: '001_test.up.sql', checksum: 'a'.repeat(64), body: 'SELECT 1' }];
  const first = await applyMigrations({ client, migrations, environment: 'DISPOSABLE', projectRef: 'test-ref', confirmation: 'test-ref' });
  assert.deepEqual(first.applied, [{ version: 1, name: '001_test.up.sql' }]);
  assert.equal(first.alreadyApplied, 0);
  const second = await applyMigrations({ client, migrations, environment: 'DISPOSABLE', projectRef: 'test-ref', confirmation: 'test-ref' });
  assert.deepEqual(second.applied, []);
  assert.equal(second.alreadyApplied, 1);
});
