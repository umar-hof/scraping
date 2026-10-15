'use strict';

function parsePayload(row) {
  const payload = typeof row.row_payload === 'string' ? JSON.parse(row.row_payload) : row.row_payload;
  if (!Array.isArray(payload) || payload.length !== 42 || String(payload[24]) !== String(row.lead_id)) throw new Error('OUTBOX_PAYLOAD_CONTRACT_INVALID');
  return payload;
}

async function previewOutbox(client, { limit = 100 } = {}) {
  const result = await client.query(`SELECT o.id,o.lead_id,o.payload_sha256,o.row_payload,o.status,o.attempt_count
    FROM lead_intel.sheet_sync_outbox o JOIN lead_intel.sheet_sync_state s ON s.id=o.destination_id
    WHERE o.status IN ('PENDING','RETRY_WAIT') AND o.next_attempt_at<=clock_timestamp() AND s.status IN ('READY','SYNCING')
    ORDER BY o.next_attempt_at,o.created_at LIMIT $1`, [Math.max(1, Math.min(500, Number(limit) || 100))]);
  return result.rows.map(row => ({ id: row.id, leadId: row.lead_id, payloadSha256: row.payload_sha256,
    status: row.status, attemptCount: row.attempt_count, cellCount: parsePayload(row).length, writePerformed: false }));
}

// Adapter must perform a fresh read/plan, and only the existing blank-only approved writer may write.
async function processOutboxBatch(client, { workerId, adapter, dryRun = true, writeApproved = false, limit = 10, leaseSeconds = 300 } = {}) {
  if (dryRun) return { preview: await previewOutbox(client, { limit }), claimed: 0, synced: 0, writePerformed: false };
  if (!writeApproved || typeof adapter !== 'function') throw new Error('Sheets outbox writes require an explicitly approved adapter.');
  const claim = await client.query('SELECT * FROM lead_intel.claim_sheet_sync_outbox($1,$2,$3)', [workerId, Math.max(1, Math.min(50, limit)), leaseSeconds]);
  let synced = 0;
  const failures = [];
  for (const row of claim.rows) {
    try {
      const outcome = await adapter({ leadId: row.lead_id, row: parsePayload(row), payloadSha256: row.payload_sha256,
        idempotencyKey: row.idempotency_key, destinationId: row.destination_id });
      if (!outcome || outcome.verifiedAfterWrite !== true || !Number.isInteger(outcome.remoteRowNumber)) throw new Error('SHEETS_WRITE_NOT_RECONCILED');
      await client.query('SELECT lead_intel.ack_sheet_sync_outbox($1,$2,$3,$4)', [row.id, workerId, outcome.remoteRowNumber, row.payload_sha256]);
      synced += 1;
    } catch (error) {
      // Uncertain outcomes retry only after adapter has done Lead-ID reconciliation on its next call.
      const rawCode = String(error.code || 'SHEETS_SYNC_ERROR');
      const code = /^[A-Za-z0-9_.-]{1,80}$/.test(rawCode) ? rawCode : 'SHEETS_SYNC_ERROR';
      await client.query('SELECT lead_intel.fail_sheet_sync_outbox($1,$2,$3,false,NULL)', [row.id, workerId, code]);
      failures.push({ leadId: row.lead_id, errorCode: code });
    }
  }
  return { claimed: claim.rowCount, synced, failures, writePerformed: synced > 0 };
}

module.exports = { parsePayload, previewOutbox, processOutboxBatch };
