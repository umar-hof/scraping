'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PROSPECTS_HEADERS } = require('../src/prospects-contract');
const { parseProspectsValues, readProspectsTab, buildImportPreview, persistApprovedSnapshotImport, READONLY_SCOPE } = require('../src/sheets-import');

function sheetMatrix(rows = []) { return [PROSPECTS_HEADERS, ...rows]; }
function blankRow(leadId, name = 'Sample Brand') {
  const row = Array(42).fill(''); row[0] = name; row[24] = leadId; return row;
}

test('read-only Sheets import enforces exact 42-column headers and preserves all cells', () => {
  const row = blankRow('lead-1'); row[17] = 'https://official.example/source'; row[31] = 'UNVERIFIED';
  const snapshot = parseProspectsValues(sheetMatrix([row]), { spreadsheetId: 'sheet-id' });
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].cells.length, 42);
  assert.equal(snapshot.records[0].record.sourceUrl, 'https://official.example/source');
  assert.equal(snapshot.records[0].record.emailDeliverabilityStatus, 'UNVERIFIED');
  assert.equal(snapshot.records[0].record.companyName, 'Sample Brand');
  assert.throws(() => parseProspectsValues([['Company Name', 'Lead ID']]), /exactly match/);
});

test('Sheets parser pads omitted trailing blank cells and rejects blank or duplicate Lead IDs', () => {
  const short = blankRow('lead-2').slice(0, 25);
  const duplicateA = blankRow('duplicate');
  const duplicateB = blankRow('duplicate', 'Other Brand');
  const noId = blankRow('');
  const snapshot = parseProspectsValues(sheetMatrix([short, duplicateA, duplicateB, noId]));
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].cells.length, 42);
  assert.equal(snapshot.records[0].cells[41], '');
  assert.equal(snapshot.rejected.filter((row) => row.reason === 'DUPLICATE_LEAD_ID').length, 2);
  assert.equal(snapshot.rejected.filter((row) => row.reason === 'LEAD_ID_MISSING').length, 1);
});

test('Sheets API connector makes GET only and never includes the access token in diagnostics', async () => {
  const requests = [];
  const snapshot = await readProspectsTab({
    spreadsheetId: 'abcdefghijklmnopqrstuvwxyz123456', accessToken: 'opaque-secret-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('fields=spreadsheetId')) return { ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 12, title: 'Prospects' } }] }) };
      return { ok: true, json: async () => ({ values: sheetMatrix([blankRow('lead-3')]) }) };
    }
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.options.method === 'GET'));
  assert.ok(requests.every((request) => request.options.headers.Authorization === 'Bearer opaque-secret-token'));
  assert.match(requests[1].url, /Prospects/);
  assert.equal(READONLY_SCOPE, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.sheetId, 12);
  await assert.rejects(() => readProspectsTab({ spreadsheetId: 'abcdefghijklmnopqrstuvwxyz123456', accessToken: '', fetchImpl: async () => null }), /short-lived/);
  await assert.rejects(() => readProspectsTab({ spreadsheetId: 'abcdefghijklmnopqrstuvwxyz123456', accessToken: 'token',
    fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
});

test('database snapshot preview is idempotent and flags changed rows instead of overwriting', () => {
  const row = blankRow('lead-4');
  const snapshot = parseProspectsValues(sheetMatrix([row]), { spreadsheetId: 'sheet-1' });
  const first = buildImportPreview(snapshot, []);
  assert.deepEqual(first.counts, { input: 1, eligible: 1, insert: 1, unchanged: 0, conflicts: 0, rejected: 0 });
  assert.equal(buildImportPreview(snapshot, [{ leadId: 'lead-4', payloadSha256: snapshot.records[0].payloadSha256 }]).counts.unchanged, 1);
  const changed = blankRow('lead-4', 'Edited name');
  const changedSnapshot = parseProspectsValues(sheetMatrix([changed]), { spreadsheetId: 'sheet-1' });
  assert.equal(buildImportPreview(changedSnapshot, [{ leadId: 'lead-4', payloadSha256: snapshot.records[0].payloadSha256 }]).counts.conflicts, 1);
  assert.equal(first.snapshot.records[0].cells.length, 42);
});

test('database snapshot write requires approval of exact preview and skips unchanged rows', async () => {
  const snapshot = parseProspectsValues(sheetMatrix([blankRow('lead-5')]), { spreadsheetId: 'sheet-2' });
  const preview = buildImportPreview(snapshot, []);
  const queries = [];
  const client = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (/RETURNING id/.test(sql)) return { rows: [{ id: 'batch-uuid' }], rowCount: 1 };
    if (/INSERT INTO lead_intel\.sheet_import_rows/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  await assert.rejects(() => persistApprovedSnapshotImport(client, preview), /explicit approval/);
  assert.equal(queries.length, 0);
  const result = await persistApprovedSnapshotImport(client, preview, { confirmImport: true, approvedPlanSha256: preview.planSha256 });
  assert.equal(result.inserted, 1);
  assert.match(queries[0].sql, /BEGIN/);
  assert.match(queries.at(-1).sql, /COMMIT/);
  const unchangedPreview = buildImportPreview(snapshot, [{ leadId: 'lead-5', payloadSha256: snapshot.records[0].payloadSha256 }]);
  const before = queries.length;
  assert.equal((await persistApprovedSnapshotImport(client, unchangedPreview, { confirmImport: true, approvedPlanSha256: unchangedPreview.planSha256 })).inserted, 0);
  assert.equal(queries.length, before);
});
