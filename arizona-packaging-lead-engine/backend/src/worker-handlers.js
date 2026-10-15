'use strict';

const { buildEnrichmentReview, persistEnrichmentEvidence } = require('./enrichment-pipeline');
const { createVerificationService } = require('./verification-providers');
const { previewOutbox, processOutboxBatch } = require('./sheets-outbox-worker');
const { booleanFlag } = require('./worker-runtime');

function createWorkerHandlers({ env = process.env, providers = {}, sheetsAdapter = null, logger = () => {} } = {}) {
  if (env.WORKER_VERIFICATION_ENABLED === 'true' &&
      (env.VERIFICATION_PROVIDER_ENABLED !== 'true' || (!providers.EMAIL && !providers.PHONE))) {
    throw new Error('VERIFICATION_ADAPTER_NOT_CONFIGURED');
  }
  const verification = createVerificationService({ providers, env });
  return {
    DISCOVERY: async () => { throw Object.assign(new Error('DISCOVERY_ADAPTER_NOT_IMPLEMENTED'), { code: 'DISCOVERY_ADAPTER_NOT_IMPLEMENTED', permanent: true }); },
    RESEARCH: async ({ job }) => ({ checkpoint: { mode: 'NO_AUTOMATIC_RESEARCH', reviewRequired: true, jobId: job.id } }),
    ENRICHMENT: async ({ job, client, dryRun }) => {
      const rows = await client.query('SELECT id FROM lead_intel.companies WHERE id=ANY($1::uuid[])', [job.payload.companyIds || []]);
      const source = job.payload.sourceId ? await client.query(`SELECT id,base_url FROM lead_intel.sources
        WHERE id=$1 AND enabled=true AND permission_status IN ('APPROVED','MANUAL_ONLY')`, [job.payload.sourceId]) : { rows: [] };
      const approvedSourceBaseUrl = source.rows[0]?.base_url || '';
      const plan = buildEnrichmentReview({ existingCompanies: rows.rows, proposedEvidence: job.payload.proposals || [], approvedSourceBaseUrl });
      if (dryRun) return { checkpoint: { previewCounts: plan.counts, existingOnly: true } };
      if (!job.payload.sourceId && plan.accepted.length) throw Object.assign(new Error('REGISTERED_SOURCE_REQUIRED'), { permanent: true });
      if (job.payload.sourceId) {
        if (plan.accepted.length && !source.rowCount) throw Object.assign(new Error('SOURCE_NOT_APPROVED'), { permanent: true });
      }
      const persisted = await persistEnrichmentEvidence(client, plan, { sourceId: job.payload.sourceId, dryRun: false });
      return { checkpoint: { ...plan.counts, evidenceInserted: persisted.evidenceInserted, existingOnly: true } };
    },
    VERIFICATION: async ({ job, client, dryRun }) => {
      if (dryRun) return { checkpoint: { verification: 'PREVIEW_ONLY', providerCalls: 0 } };
      const point = (await client.query('SELECT * FROM lead_intel.contact_points WHERE id=$1', [job.payload.contactPointId])).rows[0];
      if (!point || !['EMAIL', 'PHONE'].includes(point.channel)) throw Object.assign(new Error('CONTACT_POINT_NOT_FOUND'), { permanent: true });
      const result = await verification.verify({ channel: point.channel, contactPoint: point, costUsd: Number(env.VERIFICATION_COST_PER_CHECK_USD || 0) });
      if (result.provider === 'DISABLED' || result.provider === 'COST_CAP_BLOCKED' || result.provider === 'NO_APPROVED_ADAPTER') {
        return { checkpoint: { verification: 'UNVERIFIED', reason: result.provider, providerCalls: 0 } };
      }
      const checkType = point.channel === 'EMAIL' ? 'EMAIL_DELIVERABILITY' : 'PHONE_ACTIVITY';
      const state = result.status === 'INVALID' ? 'INVALID'
        : result.status === 'UNKNOWN' ? 'UNKNOWN' : result.independentlyVerified ? 'VERIFIED' : 'UNKNOWN';
      const providerCode = result.status;
      const idempotencyKey = `worker-verify:${point.id}:${checkType}:${result.checkedAt}`;
      await client.query(`INSERT INTO lead_intel.verification_events
        (contact_point_id,channel,check_type,verification_state,normalized_result,provider,provider_result_code,independent_verifier,checked_at,fresh_until,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(provider,idempotency_key) DO NOTHING`,
      [point.id, point.channel, checkType, state, result.status, result.provider, providerCode, result.independentlyVerified,
        result.checkedAt, result.freshUntil, idempotencyKey]);
      if (result.independentlyVerified) {
        if (point.channel === 'EMAIL') await client.query('UPDATE lead_intel.contact_points SET email_deliverability_status=$2,updated_at=clock_timestamp() WHERE id=$1', [point.id, result.status]);
        else await client.query('UPDATE lead_intel.contact_points SET phone_activity_status=$2,updated_at=clock_timestamp() WHERE id=$1', [point.id, result.status]);
      }
      return { checkpoint: { verification: result.status, independent: result.independentlyVerified, freshUntil: result.freshUntil } };
    },
    SHEET_SYNC: async ({ job, client, dryRun, workerId }) => {
      // Default remains read-only. Approved adapter must re-read by Lead ID and preserve all nonblank/manual cells.
      const output = sheetsAdapter
        ? await processOutboxBatch(client, { workerId, adapter: sheetsAdapter, dryRun,
          writeApproved: booleanFlag(env, 'SHEETS_WRITE_APPROVED', 'SHEETS_SYNC_WRITE_APPROVED'), limit: Number(job.payload.limit || 100) })
        : { preview: await previewOutbox(client, { limit: Number(job.payload.limit || 100) }), synced: 0, writePerformed: false };
      logger({ event: 'sheets_outbox_processed', claimed: output.claimed || 0, synced: output.synced || 0,
        previewCount: output.preview?.length || 0, writePerformed: output.writePerformed === true });
      return { checkpoint: { outboxPreviewCount: output.preview?.length || 0, synced: output.synced || 0, writePerformed: output.writePerformed === true } };
    },
    RECONCILIATION: async ({ job }) => ({ checkpoint: { reconciled: false, reviewRequired: true, jobId: job.id } }),
    MANUAL_REVIEW: async ({ job }) => ({ checkpoint: { reviewAvailable: true, jobId: job.id } })
  };
}

module.exports = { createWorkerHandlers };
