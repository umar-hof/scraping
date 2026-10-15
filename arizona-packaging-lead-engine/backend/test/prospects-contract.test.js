'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { FIELD_TO_HEADER, PROSPECTS_HEADERS, toProspectsRow } = require('../src/prospects-contract');

const configPath = path.join(__dirname, '..', '..', 'apps-script', 'Config.gs');

function appsScriptProspectsHeaders() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(configPath, 'utf8'), context, { filename: 'Config.gs' });
  return Array.from(context.PE.PROSPECTS_FULL_HEADERS);
}

test('backend schema exactly matches Config.gs: legacy 26 plus verification 16', () => {
  const configured = appsScriptProspectsHeaders();
  assert.equal(configured.length, 42);
  assert.equal(PROSPECTS_HEADERS.length, 42);
  assert.deepEqual(PROSPECTS_HEADERS.slice(0, 26), configured.slice(0, 26));
  assert.deepEqual(PROSPECTS_HEADERS.slice(26), configured.slice(26));
  assert.deepEqual(PROSPECTS_HEADERS, configured);
  assert.equal(Object.keys(FIELD_TO_HEADER).length, 42);
  assert.equal(new Set(Object.values(FIELD_TO_HEADER)).size, 42);
  assert.deepEqual(new Set(Object.values(FIELD_TO_HEADER)), new Set(configured));
});

test('blank optional fields stay blank and required identity is preserved', () => {
  const row = toProspectsRow({ companyName: 'Example Brand', leadId: 'lead-123' });
  assert.equal(row.length, 42);
  assert.equal(row[0], 'Example Brand');
  assert.equal(row[24], 'lead-123');
  assert.ok(row.slice(1, 24).every((value) => value === ''));
  assert.ok(row.slice(25).every((value) => value === ''));
});

test('company and direct POC email/phone fields never cross-map', () => {
  const row = toProspectsRow({
    companyName: 'Example Brand', leadId: 'lead-456',
    companyEmail: 'sales@example.com', pocEmailId: 'jane@example.com',
    companyContactNumber: '+16025550100', pocContactNumber: '+14805550101'
  });
  assert.equal(row[3], '+16025550100');
  assert.equal(row[2], '+14805550101');
  assert.equal(row[4], 'jane@example.com');
  assert.equal(row[26], 'sales@example.com');
  assert.equal(row[3] === row[2], false);
  assert.equal(row[4] === row[26], false);
});

test('all mapped timestamps, sources, statuses, and Lead ID retain their cells', () => {
  const checked = new Date('2026-10-15T08:00:00.000Z');
  const lead = {
    companyName: 'Example Brand', leadId: 'stable-lead',
    sourceUrl: 'https://source.example/listing',
    companyEmailSourceUrl: 'https://example.com/contact',
    pocEmailSourceUrl: 'https://example.com/team',
    emailDeliverabilityStatus: 'UNVERIFIED',
    phoneActivityStatus: 'UNVERIFIED', lastChecked: checked,
    dateAdded: checked, emailLastVerified: null
  };
  const row = toProspectsRow(lead);
  assert.equal(row[17], lead.sourceUrl);
  assert.equal(row[27], lead.companyEmailSourceUrl);
  assert.equal(row[28], lead.pocEmailSourceUrl);
  assert.equal(row[31], 'UNVERIFIED');
  assert.equal(row[36], 'UNVERIFIED');
  assert.deepEqual(row[22], checked);
  assert.deepEqual(row[23], checked);
  assert.equal(row[32], '');
  assert.equal(row[24], 'stable-lead');
});

test('rejects missing identity, non-record inputs, invalid cell values, and unknown fields', () => {
  assert.throws(() => toProspectsRow(null), /plain object/);
  assert.throws(() => toProspectsRow([]), /plain object/);
  assert.throws(() => toProspectsRow({ leadId: 'x' }), /companyName is required/);
  assert.throws(() => toProspectsRow({ companyName: 'X', leadId: ' ' }), /leadId is required/);
  assert.throws(() => toProspectsRow({ companyName: 'X', leadId: 'x', email: 'a@b.com' }), /Unknown lead field/);
  assert.throws(() => toProspectsRow({ companyName: 'X', leadId: 'x', sourceUrl: {} }), /must be a string/);
  assert.throws(() => toProspectsRow({ companyName: 'X', leadId: 'x', icpScore: Infinity }), /finite number/);
  assert.throws(() => toProspectsRow({ companyName: 'X', leadId: 'x', notes: new Date('invalid') }), /valid Date/);
});

test('mapping is deterministic, does not mutate input, and uses known fields only', () => {
  const input = Object.freeze({ companyName: 'Stable Co', leadId: 'stable-id', companyEmail: 'info@stable.example' });
  const first = toProspectsRow(input);
  const second = toProspectsRow(input);
  assert.deepEqual(first, second);
  assert.equal(input.companyEmail, 'info@stable.example');
  assert.equal(Object.keys(FIELD_TO_HEADER).length, 42);
});
