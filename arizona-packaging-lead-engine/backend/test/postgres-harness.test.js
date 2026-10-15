'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const harness = fs.readFileSync(path.join(__dirname, 'postgres-integration.js'), 'utf8');
const coreSql = fs.readFileSync(path.join(__dirname, 'postgres-core.integration.sql'), 'utf8');
const operationsSql = fs.readFileSync(path.join(__dirname, 'postgres-operations.integration.sql'), 'utf8');
const operationsMigration = fs.readFileSync(path.join(root, 'db', 'migrations', '002_operations.up.sql'), 'utf8');
const docs = fs.readFileSync(path.join(root, 'db', 'README.md'), 'utf8');

test('PostgreSQL harness is loopback-only and refuses service or URL connection indirection', () => {
  assert.match(harness, /loopbackHosts = new Set/);
  assert.match(harness, /PGHOST must be localhost or a loopback IP address/);
  assert.match(harness, /PGHOSTADDR must be a loopback IP address/);
  assert.match(harness, /PGSERVICEFILE.*DATABASE_URL/);
  assert.match(harness, /PGSSLMODE: 'disable'/);
});

test('PostgreSQL harness creates only a generated database and cleans it in finally', () => {
  assert.match(harness, /const dbName = `hof_leadintel_it_/);
  assert.doesNotMatch(harness, /process\.env\.PGDATABASE/);
  assert.match(harness, /CREATE DATABASE \$\{dbName\} TEMPLATE template0/);
  assert.match(harness, /DROP DATABASE \$\{dbName\} WITH \(FORCE\)/);
  assert.match(harness, /finally\s*\{/);
  assert.match(harness, /CREATE ROLE \$\{roleName\} NOLOGIN/);
  assert.match(harness, /DROP ROLE \$\{roleName\}/);
});

test('PostgreSQL integration SQL covers core identity, locations, contact, evidence, and verification constraints', () => {
  assert.match(coreSql, /shared\.example/);
  assert.match(coreSql, /duplicate external Lead ID was accepted/);
  assert.match(coreSql, /multiple company locations were not retained/);
  assert.match(coreSql, /COMPANY/);
  assert.match(coreSql, /PERSON/);
  assert.match(coreSql, /MX result incorrectly changed deliverability/);
  assert.match(coreSql, /deliverability without independent verifier was accepted/);
  assert.match(coreSql, /cross-company evidence\/contact relationship was accepted/);
});

test('PostgreSQL integration SQL covers retries, dead-lettering, and Sheets outbox idempotency', () => {
  assert.match(operationsSql, /RETRY_WAIT/);
  assert.match(operationsSql, /DEAD_LETTER/);
  assert.match(operationsSql, /checkpoint was not persisted/);
  assert.match(operationsSql, /duplicate Sheets row version was accepted/);
  assert.match(operationsSql, /non-42-cell Sheets payload was accepted/);
  assert.match(harness, /verifyConcurrentClaiming/);
  assert.match(harness, /FOR UPDATE/);
  assert.match(operationsMigration, /FOR UPDATE SKIP LOCKED/);
  assert.match(harness, /Disposable rollback assertions passed/);
});

test('database docs describe exact local integration-test prerequisites and safety boundary', () => {
  assert.match(docs, /test:postgres/);
  assert.match(docs, /loopback/);
  assert.match(docs, /disposable database/);
  assert.match(docs, /not run/i);
});
