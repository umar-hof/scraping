'use strict';

const fs = require('node:fs');

const DIRECT_HOST = /^db\.([a-z0-9-]+)\.supabase\.co$/;
const POOLER_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;
const PROJECT_REF = /^[a-z0-9]{10,32}$/;

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function readSupabaseConfig(env = process.env, { caReader = fs.readFileSync } = {}) {
  const host = required(env, 'SUPABASE_DB_HOST').toLowerCase();
  const projectRef = required(env, 'SUPABASE_PROJECT_REF').toLowerCase();
  const environment = required(env, 'SUPABASE_ENVIRONMENT').toUpperCase();
  const port = Number(required(env, 'SUPABASE_DB_PORT'));
  const user = required(env, 'SUPABASE_DB_USER');
  const database = required(env, 'SUPABASE_DB_NAME');
  const password = required(env, 'SUPABASE_DB_PASSWORD');

  if (!PROJECT_REF.test(projectRef)) throw new Error('SUPABASE_PROJECT_REF has an invalid format.');
  if (!['DISPOSABLE', 'PRODUCTION'].includes(environment)) {
    throw new Error('SUPABASE_ENVIRONMENT must be DISPOSABLE or PRODUCTION.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SUPABASE_DB_PORT is invalid.');
  const directMatch = host.match(DIRECT_HOST);
  const poolerMatch = host.match(POOLER_HOST);
  if (!directMatch && !poolerMatch) {
    throw new Error('Supabase database host must be a db.<project-ref>.supabase.co or *.pooler.supabase.com endpoint.');
  }
  if (directMatch && directMatch[1] !== projectRef) {
    throw new Error('SUPABASE_PROJECT_REF does not match the direct database hostname.');
  }
  if (poolerMatch && !user.endsWith(`.${projectRef}`)) {
    throw new Error('Pooler username must include the configured Supabase project reference.');
  }
  if (poolerMatch && port !== 5432) {
    throw new Error('Migration connections use direct PostgreSQL or Supavisor session mode on port 5432; transaction-mode poolers are not supported.');
  }

  const ssl = { rejectUnauthorized: true };
  if (env.SUPABASE_DB_SSL_CA_FILE) ssl.ca = caReader(env.SUPABASE_DB_SSL_CA_FILE);
  return Object.freeze({
    host, port, user, database, password, projectRef, environment,
    ssl, connectionTimeoutMillis: 8000, statement_timeout: 30000,
    application_name: 'hof-pack-lead-intelligence'
  });
}

module.exports = { readSupabaseConfig };
