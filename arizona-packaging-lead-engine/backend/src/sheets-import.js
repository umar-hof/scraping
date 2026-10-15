'use strict';

const crypto = require('node:crypto');
const { FIELD_TO_HEADER, PROSPECTS_HEADERS } = require('./prospects-contract');

const HEADER_TO_FIELD = Object.freeze(Object.fromEntries(
  Object.entries(FIELD_TO_HEADER).map(([field, header]) => [header, field])
));
const READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseProspectsValues(values, { spreadsheetId, readAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(values) || !values.length) throw new Error('Prospects tab has no header row.');
  const [headers, ...inputRows] = values;
  if (JSON.stringify(headers) !== JSON.stringify(PROSPECTS_HEADERS)) {
    throw new Error('Prospects header does not exactly match the frozen 42-column contract.');
  }

  const candidates = [];
  const rejected = [];
  for (let index = 0; index < inputRows.length; index += 1) {
    const input = inputRows[index];
    if (!Array.isArray(input) || input.length > 42) {
      rejected.push({ rowNumber: index + 2, reason: 'ROW_WIDTH_INVALID' });
      continue;
    }
    const cells = Array.from({ length: 42 }, (_, col) => input[col] === null || input[col] === undefined ? '' : input[col]);
    if (cells.every((cell) => cell === '')) continue;
    const leadId = String(cells[24] || '').trim();
    if (!leadId) {
      rejected.push({ rowNumber: index + 2, reason: 'LEAD_ID_MISSING' });
      continue;
    }
    const record = {};
    for (const [header, field] of Object.entries(HEADER_TO_FIELD)) record[field] = cells[PROSPECTS_HEADERS.indexOf(header)];
    candidates.push({ leadId, rowNumber: index + 2, cells, record, payloadSha256: sha256(JSON.stringify(cells)) });
  }
  const ids = new Map();
  for (const candidate of candidates) ids.set(candidate.leadId, (ids.get(candidate.leadId) || 0) + 1);
  const duplicateIds = new Set([...ids].filter(([, count]) => count > 1).map(([id]) => id));
  for (const candidate of candidates) {
    if (duplicateIds.has(candidate.leadId)) rejected.push({ rowNumber: candidate.rowNumber, leadId: candidate.leadId, reason: 'DUPLICATE_LEAD_ID' });
  }
  const records = candidates.filter((candidate) => !duplicateIds.has(candidate.leadId));
  return Object.freeze({
    spreadsheetId: String(spreadsheetId || ''), tabName: 'Prospects',
    readAt, headers: [...headers], headerSha256: sha256(JSON.stringify(headers)),
    records, rejected, inputRowCount: inputRows.length
  });
}

async function readProspectsTab({ spreadsheetId, accessToken, fetchImpl = globalThis.fetch } = {}) {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(String(spreadsheetId || ''))) throw new Error('A valid existing spreadsheet ID is required.');
  if (!String(accessToken || '').trim()) throw new Error('A short-lived Google Sheets read token is required.');
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is unavailable.');
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  const metadataResponse = await fetchImpl(`${baseUrl}?fields=spreadsheetId,sheets(properties(sheetId,title,gridProperties))`, {
    method: 'GET', headers
  });
  if (!metadataResponse.ok) throw new Error(`Google Sheets metadata read failed with HTTP ${metadataResponse.status}.`);
  const metadata = await metadataResponse.json();
  const prospectsTab = (metadata.sheets || []).find((sheet) => sheet.properties && sheet.properties.title === 'Prospects');
  if (!prospectsTab) throw new Error('The existing spreadsheet has no visible Prospects tab.');
  const range = encodeURIComponent('Prospects!A1:AP');
  const url = `${baseUrl}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMULA`;
  const response = await fetchImpl(url, {
    method: 'GET', headers
  });
  if (!response.ok) throw new Error(`Google Sheets read failed with HTTP ${response.status}.`);
  const payload = await response.json();
  return Object.freeze({ ...parseProspectsValues(payload.values || [], { spreadsheetId, readAt: new Date().toISOString() }),
    sheetId: prospectsTab.properties.sheetId, gridProperties: prospectsTab.properties.gridProperties || {} });
}

function buildImportPreview(snapshot, storedRows = []) {
  const existing = new Map();
  for (const row of storedRows) {
    const entries = existing.get(row.leadId) || [];
    entries.push(row.payloadSha256 || sha256(JSON.stringify(row.cells)));
    existing.set(row.leadId, entries);
  }
  const decisions = snapshot.records.map((record) => {
    const known = existing.get(record.leadId) || [];
    const action = !known.length ? 'INSERT_SNAPSHOT' : known.includes(record.payloadSha256) ? 'UNCHANGED' : 'CONFLICT_REVIEW';
    return { leadId: record.leadId, sourceRowNumber: record.rowNumber, payloadSha256: record.payloadSha256, action };
  });
  const planShape = {
    spreadsheetId: snapshot.spreadsheetId, tabName: snapshot.tabName,
    headerSha256: snapshot.headerSha256,
    decisions: decisions.map(({ leadId, payloadSha256, action }) => ({ leadId, payloadSha256, action })),
    rejected: snapshot.rejected
  };
  return Object.freeze({
    snapshot, decisions, rejected: snapshot.rejected,
    counts: Object.freeze({ input: snapshot.inputRowCount, eligible: snapshot.records.length,
      insert: decisions.filter((item) => item.action === 'INSERT_SNAPSHOT').length,
      unchanged: decisions.filter((item) => item.action === 'UNCHANGED').length,
      conflicts: decisions.filter((item) => item.action === 'CONFLICT_REVIEW').length,
      rejected: snapshot.rejected.length }),
    planSha256: sha256(JSON.stringify(planShape))
  });
}

async function persistApprovedSnapshotImport(client, preview, { approvedPlanSha256, confirmImport = false } = {}) {
  if (confirmImport !== true || approvedPlanSha256 !== preview.planSha256) {
    throw new Error('Snapshot import requires explicit approval of this exact preview hash.');
  }
  if (preview.counts.conflicts || preview.counts.rejected) {
    throw new Error('Resolve all conflicts and rejected rows before snapshot import.');
  }
  const rows = new Map(preview.snapshot.records.map((row) => [row.leadId, row]));
  const selected = preview.decisions.filter((decision) => decision.action === 'INSERT_SNAPSHOT');
  if (!selected.length) return { batchId: null, inserted: 0, unchanged: 0, importKey: null };
  const batchDigest = sha256(`${preview.snapshot.spreadsheetId}\0${preview.snapshot.headerSha256}\0${selected.map((x) => `${x.leadId}:${x.payloadSha256}`).join('\n')}`);
  await client.query('BEGIN');
  try {
    const batch = await client.query(
      `INSERT INTO lead_intel.sheet_import_batches(source_spreadsheet_id,source_tab_name,import_key,header_sha256,source_row_count,read_at)
       VALUES($1,'Prospects',$2,$3,$4,$5) ON CONFLICT(import_key) DO NOTHING RETURNING id`,
      [preview.snapshot.spreadsheetId, batchDigest, preview.snapshot.headerSha256, selected.length, preview.snapshot.readAt]
    );
    let batchId = batch.rows[0] && batch.rows[0].id;
    if (!batchId) {
      const existingBatch = await client.query('SELECT id FROM lead_intel.sheet_import_batches WHERE import_key=$1', [batchDigest]);
      batchId = existingBatch.rows[0].id;
    }
    let inserted = 0;
    for (const decision of selected) {
      const row = rows.get(decision.leadId);
      const result = await client.query(
        `INSERT INTO lead_intel.sheet_import_rows(batch_id,source_spreadsheet_id,source_row_number,lead_id,row_payload,payload_sha256)
         VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING`,
        [batchId, preview.snapshot.spreadsheetId, row.rowNumber, row.leadId, JSON.stringify(row.cells), row.payloadSha256]
      );
      inserted += result.rowCount || 0;
    }
    await client.query('COMMIT');
    return { batchId, inserted, unchanged: selected.length - inserted, importKey: batchDigest };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = { READONLY_SCOPE, sha256, parseProspectsValues, readProspectsTab, buildImportPreview, persistApprovedSnapshotImport };
