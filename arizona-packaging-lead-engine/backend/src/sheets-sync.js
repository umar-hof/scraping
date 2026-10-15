'use strict';

const crypto = require('node:crypto');
const { PROSPECTS_HEADERS, toProspectsRow } = require('./prospects-contract');
const { readProspectsTab } = require('./sheets-import');

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function buildSheetsSyncPreview({ spreadsheetId, existingSnapshot, databaseRecords, managedHeaders }) {
  if (!spreadsheetId) throw new Error('Existing spreadsheet ID is required.');
  if (!existingSnapshot || JSON.stringify(existingSnapshot.headers) !== JSON.stringify(PROSPECTS_HEADERS)) {
    throw new Error('Live Prospects snapshot must match the exact 42-column contract.');
  }
  if (existingSnapshot.rejected && existingSnapshot.rejected.length) throw new Error('Live Prospects contains malformed or duplicate Lead ID rows; sync is blocked for review.');
  if (!Array.isArray(managedHeaders)) throw new Error('An explicit managedHeaders allowlist is required.');
  const managed = new Set(managedHeaders);
  for (const header of managed) if (!PROSPECTS_HEADERS.includes(header) || header === 'Lead ID') throw new Error(`Invalid managed header: ${header}`);
  const byLeadId = new Map();
  const duplicateLiveIds = new Set();
  for (const row of existingSnapshot.records) {
    if (byLeadId.has(row.leadId)) duplicateLiveIds.add(row.leadId);
    else byLeadId.set(row.leadId, row);
  }
  const changes = [];
  const conflicts = [];
  const databaseLeadIds = new Set();
  for (const record of databaseRecords) {
    const proposed = toProspectsRow(record);
    const leadId = String(record.leadId);
    if (databaseLeadIds.has(leadId)) { conflicts.push({ leadId, reason: 'DUPLICATE_DATABASE_LEAD_ID' }); continue; }
    databaseLeadIds.add(leadId);
    if (duplicateLiveIds.has(leadId)) { conflicts.push({ leadId, reason: 'DUPLICATE_LIVE_LEAD_ID' }); continue; }
    const existing = byLeadId.get(leadId);
    if (!existing) {
      changes.push({ leadId, action: 'APPEND_NEW_ROW', row: proposed,
        idempotencyKey: hash(`${spreadsheetId}\0${leadId}\0${hash(JSON.stringify(proposed))}`) });
      continue;
    }
    const cells = existing.cells.slice();
    const cellChanges = [];
    for (const header of managed) {
      const index = PROSPECTS_HEADERS.indexOf(header);
      const current = existing.cells[index] ?? '';
      const next = proposed[index] ?? '';
      if ((current === '' || current === null) && next !== '' && next !== null) {
        cells[index] = next;
        cellChanges.push({ header, columnIndex: index, value: next });
      }
    }
    if (cellChanges.length) {
      changes.push({ leadId, action: 'FILL_BLANK_CELLS_ONLY', cellChanges,
        rowPayloadSha256: hash(JSON.stringify(cells)), idempotencyKey: hash(`${spreadsheetId}\0${leadId}\0${hash(JSON.stringify(cells))}`) });
    }
  }
  const nextRowNumber = Math.max(1, ...existingSnapshot.records.map((row) => row.rowNumber || 1)) + 1;
  const plan = { spreadsheetId, tabName: 'Prospects', managedHeaders: [...managed], nextRowNumber, changes, conflicts,
    counts: { existing: existingSnapshot.records.length,
      proposedRows: changes.filter((item) => item.action === 'APPEND_NEW_ROW').length,
      proposedCellUpdates: changes.reduce((sum, item) => sum + (item.cellChanges || []).length, 0),
      unchanged: databaseRecords.length - changes.length - conflicts.length, conflicts: conflicts.length },
    writePerformed: false };
  plan.planSha256 = hash(JSON.stringify(plan));
  return Object.freeze(plan);
}

function cellData(value) {
  if (value === null || value === undefined || value === '') return { userEnteredValue: { stringValue: '' } };
  if (value instanceof Date) return { userEnteredValue: { stringValue: value.toISOString() } };
  if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
  if (typeof value === 'number' && Number.isFinite(value)) return { userEnteredValue: { numberValue: value } };
  return { userEnteredValue: { stringValue: String(value) } };
}

async function applyApprovedSheetsSync({ plan, databaseRecords, accessToken, approvedPlanSha256,
  confirmWrite = false, fetchImpl = globalThis.fetch } = {}) {
  if (confirmWrite !== true || !plan || approvedPlanSha256 !== plan.planSha256) {
    throw new Error('Sheets sync requires explicit approval of the exact plan hash.');
  }
  if (!accessToken || typeof fetchImpl !== 'function') throw new Error('A short-lived Sheets write token and fetch implementation are required.');
  if (plan.conflicts.length) throw new Error('Resolve all Lead ID conflicts before Sheets sync.');
  const fresh = await readProspectsTab({ spreadsheetId: plan.spreadsheetId, accessToken, fetchImpl });
  const freshPlan = buildSheetsSyncPreview({ spreadsheetId: plan.spreadsheetId,
    existingSnapshot: fresh, databaseRecords, managedHeaders: plan.managedHeaders });
  if (freshPlan.planSha256 !== plan.planSha256) throw new Error('Live Sheet changed since preview; rebuild and re-approve the sync plan.');
  if (!fresh.sheetId) throw new Error('Google did not return the Prospects sheetId; sync aborted.');
  if (!plan.changes.length) return { updatedRows: 0, appendedRows: 0, changedCells: 0, writePerformed: false };

  let appendRow = plan.nextRowNumber;
  const requests = [];
  let appendedRows = 0;
  let changedCells = 0;
  for (const change of plan.changes) {
    if (change.action === 'APPEND_NEW_ROW') {
      requests.push({ updateCells: { start: { sheetId: fresh.sheetId, rowIndex: appendRow - 1, columnIndex: 0 },
        rows: [{ values: change.row.map(cellData) }], fields: 'userEnteredValue' } });
      appendRow += 1;
      appendedRows += 1;
      changedCells += change.row.filter((value) => value !== '' && value !== null && value !== undefined).length;
      continue;
    }
    const liveRow = fresh.records.find((row) => row.leadId === change.leadId);
    if (!liveRow) throw new Error('Lead ID disappeared during sync recheck; rebuild the preview.');
    for (const cell of change.cellChanges) {
      requests.push({ updateCells: { start: { sheetId: fresh.sheetId, rowIndex: liveRow.rowNumber - 1, columnIndex: cell.columnIndex },
        rows: [{ values: [cellData(cell.value)] }], fields: 'userEnteredValue' } });
      changedCells += 1;
    }
  }
  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(plan.spreadsheetId)}:batchUpdate`;
  const response = await fetchImpl(writeUrl, { method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }) });
  if (!response.ok) throw new Error(`Google Sheets sync failed with HTTP ${response.status}; retry only after a fresh Lead ID preview.`);
  await response.json().catch(() => ({}));
  const verifiedSnapshot = await readProspectsTab({ spreadsheetId: plan.spreadsheetId, accessToken, fetchImpl });
  const verifiedByLeadId = new Map(verifiedSnapshot.records.map((item) => [item.leadId, item]));
  for (const change of plan.changes) {
    const actual = verifiedByLeadId.get(change.leadId);
    if (!actual) throw new Error('Sync response was accepted but the Lead ID is not visible on re-read; reconcile before retrying.');
    if (change.action === 'FILL_BLANK_CELLS_ONLY' && change.cellChanges.some((cell) => actual.cells[cell.columnIndex] !== cell.value)) {
      throw new Error('Sync response was accepted but a target cell differs on re-read; reconcile before retrying.');
    }
    if (change.action === 'APPEND_NEW_ROW' && JSON.stringify(actual.cells) !== JSON.stringify(change.row)) {
      throw new Error('Sync response was accepted but appended values differ on re-read; reconcile before retrying.');
    }
  }
  return { updatedRows: plan.changes.filter((item) => item.action === 'FILL_BLANK_CELLS_ONLY').length,
    appendedRows, changedCells, writePerformed: true, verifiedAfterWrite: true, planSha256: plan.planSha256 };
}

function checkpointAfter(plan, completedLeadId = '') {
  const position = plan.changes.findIndex((item) => item.leadId === completedLeadId);
  return Object.freeze({ planSha256: plan.planSha256, completedLeadId, completedIndex: position,
    nextIndex: Math.max(0, position + 1), changeCount: plan.changes.length });
}

async function retryWithBackoff(operation, { attempts = 3, baseDelayMs = 100, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random, log = () => {} } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('attempts must be a positive integer.');
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      lastError = error;
      log({ event: 'sync_attempt_failed', attempt, retrying: attempt < attempts,
        errorCode: String(error.code || 'UNKNOWN').slice(0, 80) });
      if (attempt < attempts) await sleep(Math.min(30000, baseDelayMs * (2 ** (attempt - 1)) + Math.floor(random() * baseDelayMs)));
    }
  }
  throw lastError;
}

module.exports = { buildSheetsSyncPreview, applyApprovedSheetsSync, checkpointAfter, retryWithBackoff };
