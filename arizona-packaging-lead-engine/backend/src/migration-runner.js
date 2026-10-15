'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_SCHEMA = 'lead_intel_migrations';
const LEDGER_TABLE = `${MIGRATION_SCHEMA}.schema_migrations`;
const MIGRATION_DIR = path.join(__dirname, '..', 'db', 'migrations');

function listMigrations(directory = MIGRATION_DIR) {
  const files = fs.readdirSync(directory)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.up\.sql$/.test(name))
    .sort();
  const migrations = files.map((name) => {
    const sql = fs.readFileSync(path.join(directory, name), 'utf8');
    if (!/^\s*BEGIN;[\s\S]*COMMIT;\s*$/i.test(sql)) {
      throw new Error(`Migration ${name} must contain one explicit BEGIN/COMMIT wrapper.`);
    }
    return {
      version: Number(name.slice(0, 3)),
      name,
      sql,
      body: sql.replace(/^\s*BEGIN;\s*/i, '').replace(/\s*COMMIT;\s*$/i, ''),
      checksum: crypto.createHash('sha256').update(sql).digest('hex')
    };
  });
  for (let index = 0; index < migrations.length; index += 1) {
    if (migrations[index].version !== index + 1) throw new Error('Migration versions must be contiguous starting at 001.');
  }
  return migrations;
}

function migrationBundleHash(migrations = listMigrations()) {
  const digest = crypto.createHash('sha256');
  for (const migration of migrations) digest.update(`${migration.name}\0${migration.checksum}\n`);
  return digest.digest('hex');
}

function assertMigrationAuthorization({ environment, projectRef, migrations, confirmation, disposableBundleValidated }) {
  const target = String(environment || '').toUpperCase();
  if (target === 'DISPOSABLE') {
    if (confirmation !== projectRef) throw new Error('Disposable migration requires typing its exact Supabase project ref.');
    return;
  }
  if (target !== 'PRODUCTION') throw new Error('Refusing schema changes: target must be explicitly DISPOSABLE or PRODUCTION.');
  const expectedBundle = migrationBundleHash(migrations);
  if (disposableBundleValidated !== expectedBundle) {
    throw new Error('Production migration blocked: first validate this exact migration bundle in a dedicated disposable Supabase project.');
  }
  if (confirmation !== projectRef) throw new Error('Production migration requires typing the exact project ref at the interactive prompt.');
}

async function query(client, text, values) {
  return client.query(text, values);
}

async function healthCheck(client, { projectRef, environment }) {
  const result = await query(client,
    'SELECT current_database() AS database, current_user AS database_user, current_setting($1) AS server_version',
    ['server_version']);
  const row = result.rows[0];
  return Object.freeze({
    ok: Boolean(row), projectRef, environment,
    database: row && row.database,
    databaseUser: row && row.database_user,
    serverVersion: row && row.server_version
  });
}

async function readMigrationStatus(client) {
  const exists = await query(client, "SELECT to_regclass($1) AS ledger", [LEDGER_TABLE]);
  if (!exists.rows[0].ledger) return [];
  const result = await query(client,
    `SELECT version, name, checksum, applied_at FROM ${LEDGER_TABLE} ORDER BY version`);
  return result.rows;
}

async function ensureLedger(client) {
  await query(client, `CREATE SCHEMA IF NOT EXISTS ${MIGRATION_SCHEMA}`);
  await query(client, `REVOKE ALL ON SCHEMA ${MIGRATION_SCHEMA} FROM PUBLIC`);
  await query(client, `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    version integer PRIMARY KEY CHECK (version > 0),
    name text NOT NULL UNIQUE,
    checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
  await query(client, `REVOKE ALL ON ALL TABLES IN SCHEMA ${MIGRATION_SCHEMA} FROM PUBLIC`);
}

async function assertNoUntrackedSchema(client, applied) {
  if (applied.length) return;
  const result = await query(client,
    "SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lead_intel'");
  if (result.rows[0].count > 0) {
    throw new Error('Untracked lead_intel objects exist. Refusing to adopt or alter them automatically.');
  }
}

async function applyMigrations({ client, migrations = listMigrations(), environment, projectRef,
  confirmation, disposableBundleValidated } = {}) {
  assertMigrationAuthorization({ environment, projectRef, migrations, confirmation, disposableBundleValidated });
  await client.connect();
  let lockHeld = false;
  try {
    await query(client, "SELECT pg_advisory_lock(hashtext('hof-pack'), hashtext('schema-migrations'))");
    lockHeld = true;
    const ledgerExists = await query(client, 'SELECT to_regclass($1) AS ledger', [LEDGER_TABLE]);
    if (!ledgerExists.rows[0].ledger) await assertNoUntrackedSchema(client, []);
    await ensureLedger(client);
    const applied = await readMigrationStatus(client);
    const appliedByVersion = new Map(applied.map((item) => [Number(item.version), item]));
    const pending = [];
    for (const migration of migrations) {
      const previous = appliedByVersion.get(migration.version);
      if (previous && (previous.name !== migration.name || previous.checksum.trim() !== migration.checksum)) {
        throw new Error(`Applied migration ${migration.version} has changed name/checksum; use a forward migration instead.`);
      }
      if (!previous) pending.push(migration);
    }
    const highest = Math.max(0, ...applied.map((item) => Number(item.version)));
    if (pending.some((item) => item.version < highest)) throw new Error('Out-of-order pending migration detected.');

    const appliedNow = [];
    for (const migration of pending) {
      await query(client, 'BEGIN');
      try {
        await query(client, migration.body);
        await query(client, `INSERT INTO ${LEDGER_TABLE}(version,name,checksum) VALUES($1,$2,$3)`,
          [migration.version, migration.name, migration.checksum]);
        await query(client, 'COMMIT');
        appliedNow.push({ version: migration.version, name: migration.name });
      } catch (error) {
        await query(client, 'ROLLBACK').catch(() => {});
        throw error;
      }
    }
    return { applied: appliedNow, alreadyApplied: migrations.length - pending.length };
  } finally {
    if (lockHeld) await query(client, "SELECT pg_advisory_unlock(hashtext('hof-pack'), hashtext('schema-migrations'))").catch(() => {});
    await client.end();
  }
}

module.exports = {
  MIGRATION_DIR, MIGRATION_SCHEMA, LEDGER_TABLE, listMigrations,
  migrationBundleHash, assertMigrationAuthorization, healthCheck,
  readMigrationStatus, applyMigrations
};
