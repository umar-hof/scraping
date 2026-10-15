'use strict';

const { readSupabaseConfig } = require('../src/supabase-config');
const { loadLocalEnv } = require('../src/local-env');
const {
  applyMigrations, healthCheck, listMigrations,
  migrationBundleHash, readMigrationStatus
} = require('../src/migration-runner');

function safeMessage(error) {
  return String(error && error.message || 'Operation failed')
    .replaceAll(process.env.SUPABASE_DB_PASSWORD || '\u0000', '[redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url-redacted]');
}

function askConfirmation(projectRef) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('Schema migration requires an interactive terminal confirmation.'));
    process.stdout.write(`Type the exact Supabase project ref (${projectRef}) to authorize schema migration: `);
    let answer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => {
      answer = chunk.trim();
      resolve(answer);
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  loadLocalEnv();
  const command = argv[0];
  const migrations = listMigrations();
  if (command === 'bundle-hash') {
    process.stdout.write(`${migrationBundleHash(migrations)}\n`);
    return;
  }
  if (!['health', 'status', 'migrate'].includes(command)) {
    throw new Error('Usage: node scripts/supabase.js <health|status|bundle-hash|migrate --confirm-disposable|migrate --confirm-production>');
  }

  const config = readSupabaseConfig(process.env);
  // pg is loaded only for cloud commands; offline tests and previews need no driver.
  let Client;
  try { ({ Client } = require('pg')); }
  catch (_) { throw new Error('PostgreSQL driver is missing; run npm install from backend/ before connecting.'); }
  const client = new Client(config);

  if (command === 'health') {
    try {
      await client.connect();
      const result = await healthCheck(client, config);
      process.stdout.write(`SUPABASE_HEALTH ${JSON.stringify(result)}\n`);
    } finally { await client.end().catch(() => {}); }
    return;
  }
  if (command === 'status') {
    try {
      await client.connect();
      const status = await readMigrationStatus(client);
      process.stdout.write(`MIGRATION_STATUS ${JSON.stringify({
        projectRef: config.projectRef, environment: config.environment,
        ledgerPresent: status.length > 0, applied: status.map(({ version, name, checksum, applied_at }) => ({ version, name, checksum, applied_at }))
      })}\n`);
    } finally { await client.end().catch(() => {}); }
    return;
  }

  const disposable = config.environment === 'DISPOSABLE';
  if (disposable && !argv.includes('--confirm-disposable')) {
    throw new Error('Refusing DDL: pass --confirm-disposable and type the disposable project ref.');
  }
  if (!disposable && !argv.includes('--confirm-production')) {
    throw new Error('Refusing production DDL: pass --confirm-production only after disposable validation.');
  }
  const confirmation = await askConfirmation(config.projectRef);
  const result = await applyMigrations({
    client, migrations, environment: config.environment, projectRef: config.projectRef,
    confirmation,
    disposableBundleValidated: process.env.SUPABASE_DISPOSABLE_VALIDATED_SHA256
  });
  process.stdout.write(`MIGRATION_RESULT ${JSON.stringify({
    projectRef: config.projectRef, environment: config.environment,
    migrationBundleSha256: migrationBundleHash(migrations), ...result
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`SUPABASE_COMMAND_FAILED ${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, safeMessage };
