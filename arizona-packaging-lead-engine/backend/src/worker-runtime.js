'use strict';

const crypto = require('node:crypto');

const JOB_TYPES = Object.freeze(['DISCOVERY', 'RESEARCH', 'ENRICHMENT', 'VERIFICATION', 'SHEET_SYNC', 'RECONCILIATION', 'MANUAL_REVIEW']);
const ACTIVATION_KEYS = Object.freeze({
  DISCOVERY: 'WORKER_DISCOVERY_ENABLED', ENRICHMENT: 'WORKER_ENRICHMENT_ENABLED',
  VERIFICATION: 'WORKER_VERIFICATION_ENABLED', SHEET_SYNC: 'WORKER_SHEETS_SYNC_ENABLED'
});
const CANONICAL_FLAGS = Object.freeze({
  WORKER_DISCOVERY_ENABLED: 'DISCOVERY_ENABLED', WORKER_ENRICHMENT_ENABLED: 'ENRICHMENT_ENABLED',
  WORKER_VERIFICATION_ENABLED: 'VERIFICATION_ENABLED', WORKER_SHEETS_SYNC_ENABLED: 'SHEETS_SYNC_ENABLED'
});

function booleanFlag(env, canonical, legacy, fallback = false) {
  const a = env[canonical], b = env[legacy];
  if (a !== undefined && b !== undefined && (a === 'true') !== (b === 'true')) throw new Error(`${canonical} conflicts with ${legacy}.`);
  const value = a !== undefined ? a : b;
  if (value === undefined) return fallback;
  if (!['true', 'false'].includes(String(value).toLowerCase())) throw new Error(`${canonical} must be true or false.`);
  return String(value).toLowerCase() === 'true';
}

function safeLog(logger, event, data = {}) {
  const safe = { ...data };
  for (const key of Object.keys(safe)) if (/token|password|secret|credential|authorization|email|phone|url/i.test(key)) delete safe[key];
  logger({ timestamp: new Date().toISOString(), event, ...safe });
}

function safeErrorCode(error) {
  const code = String(error?.code || 'WORKER_ERROR');
  return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : 'WORKER_ERROR';
}

function parseWorkerConfig(env = process.env) {
  const int = (key, fallback, min, max) => {
    const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
    return value;
  };
  const jobTypes = String(env.WORKER_JOB_TYPES || 'ENRICHMENT,VERIFICATION,SHEET_SYNC,RECONCILIATION,MANUAL_REVIEW')
    .split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  if (!jobTypes.length || jobTypes.some(x => !JOB_TYPES.includes(x)) || new Set(jobTypes).size !== jobTypes.length) throw new Error('WORKER_JOB_TYPES contains an unsupported or duplicate job type.');
  const rateLimits = Object.freeze(Object.fromEntries(['DISCOVERY','ENRICHMENT','VERIFICATION','SHEET_SYNC'].map(type =>
    [type, int(`WORKER_RATE_${type}_MS`, 1000, 0, 600000)])));
  return Object.freeze({ workerId: String(env.WORKER_ID || `worker-${crypto.randomUUID()}`).slice(0, 120), jobTypes,
    concurrency: int('WORKER_CONCURRENCY', 2, 1, 32), leaseSeconds: int('WORKER_LEASE_SECONDS', 300, 30, 3600),
    pollMs: int('WORKER_POLL_MS', 5000, 250, 300000), dryRun: String(env.WORKER_DRY_RUN || 'true').toLowerCase() !== 'false',
    activation: Object.freeze(Object.fromEntries(Object.values(ACTIVATION_KEYS).map(key => [key, booleanFlag(env, CANONICAL_FLAGS[key], key)]))),
    rateLimits });
}

// Type-scoped SKIP LOCKED claim; cleanup/enrichment workers can never claim DISCOVERY jobs.
async function claimJobs(client, { workerId, jobTypes, limit = 1, leaseSeconds = 300 }) {
  if (!Array.isArray(jobTypes) || !jobTypes.length) throw new Error('At least one allowed job type is required.');
  const types = [...new Set(jobTypes)];
  if (types.some(type => !JOB_TYPES.includes(type))) throw new Error('Unsupported job type in claim list.');
  const batch = Math.max(1, Math.min(32, Number(limit) || 1));
  await client.query('BEGIN');
  try {
    const selected = await client.query(
      `SELECT id,status,attempt_count,max_attempts,checkpoint FROM lead_intel.jobs
        WHERE job_type = ANY($1::text[]) AND ((status IN ('QUEUED','RETRY_WAIT') AND run_after <= clock_timestamp())
          OR (status='LEASED' AND lease_expires_at <= clock_timestamp()))
        ORDER BY priority DESC,run_after,created_at FOR UPDATE SKIP LOCKED LIMIT $2`, [types, batch]);
    const claimed = [];
    for (const job of selected.rows) {
      if (job.status === 'LEASED') await client.query(`UPDATE lead_intel.job_runs SET status='LEASE_EXPIRED',finished_at=clock_timestamp()
        WHERE job_id=$1 AND status='RUNNING'`, [job.id]);
      if (job.attempt_count >= job.max_attempts) {
        await client.query(`UPDATE lead_intel.jobs SET status='DEAD_LETTER',lease_owner=NULL,lease_expires_at=NULL,
          last_error_code='ATTEMPTS_EXHAUSTED',updated_at=clock_timestamp() WHERE id=$1`, [job.id]);
        continue;
      }
      const updated = await client.query(`UPDATE lead_intel.jobs SET status='LEASED',attempt_count=attempt_count+1,
        lease_owner=$2,lease_expires_at=clock_timestamp()+make_interval(secs=>$3),updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [job.id, workerId, leaseSeconds]);
      const current = updated.rows[0];
      await client.query(`INSERT INTO lead_intel.job_runs(job_id,attempt_number,status,worker_id,checkpoint_start)
        VALUES($1,$2,'RUNNING',$3,$4::jsonb)`, [current.id, current.attempt_count, workerId, JSON.stringify(current.checkpoint || {})]);
      claimed.push(current);
    }
    await client.query('COMMIT');
    return claimed;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

async function saveCheckpoint(client, job, workerId, checkpoint) {
  const result = await client.query(`UPDATE lead_intel.jobs SET checkpoint=$3::jsonb,updated_at=clock_timestamp()
    WHERE id=$1 AND status='LEASED' AND lease_owner=$2 AND lease_expires_at>clock_timestamp()`, [job.id, workerId, JSON.stringify(checkpoint || {})]);
  if (!result.rowCount) throw new Error('JOB_LEASE_LOST');
}

async function finishJob(client, job, workerId, { succeeded, checkpoint, errorCode, permanent = false } = {}) {
  const result = await client.query(`SELECT lead_intel.finish_job($1,$2,$3,$4::jsonb,$5,$6,$7) AS status`,
    [job.id, workerId, succeeded === true, checkpoint ? JSON.stringify(checkpoint) : null,
      errorCode || null, errorCode ? 'Worker handler failed; inspect structured logs.' : null, permanent]);
  return result.rows[0].status;
}

function createWorker({ pool, config, handlers = {}, logger = () => {}, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (!pool || !config) throw new Error('Worker requires a PostgreSQL pool and validated configuration.');
  let stopping = false;
  const active = new Set();
  const nextAllowedByType = new Map();
  const handlerFor = job => handlers[job.job_type];
  async function processJob(job) {
    const client = await pool.connect();
    try {
      const activationKey = ACTIVATION_KEYS[job.job_type];
      if (activationKey && !config.activation[activationKey]) throw Object.assign(new Error('JOB_TYPE_DISABLED'), { permanent: true, code: 'JOB_TYPE_DISABLED' });
      const handler = handlerFor(job);
      if (typeof handler !== 'function') throw Object.assign(new Error('NO_HANDLER_CONFIGURED'), { permanent: true, code: 'NO_HANDLER_CONFIGURED' });
      const minInterval = config.rateLimits?.[job.job_type] || 0;
      const scheduledAt = Math.max(now(), nextAllowedByType.get(job.job_type) || 0);
      nextAllowedByType.set(job.job_type, scheduledAt + minInterval);
      const delay = scheduledAt - now();
      if (delay > 0) await sleep(delay);
      const result = await handler({ job, client, dryRun: config.dryRun, workerId: config.workerId,
        checkpoint: async value => saveCheckpoint(client, job, config.workerId, value) });
      await finishJob(client, job, config.workerId, { succeeded: true, checkpoint: result?.checkpoint });
      safeLog(logger, 'job_succeeded', { jobType: job.job_type, jobId: job.id, dryRun: config.dryRun });
    } catch (error) {
      const code = safeErrorCode(error);
      try { const status = await finishJob(client, job, config.workerId, { succeeded: false, checkpoint: job.checkpoint, errorCode: code, permanent: error.permanent === true });
        safeLog(logger, 'job_failed', { jobType: job.job_type, jobId: job.id, errorCode: code, finalStatus: status }); }
      catch (leaseError) { safeLog(logger, 'job_finalize_failed', { jobId: job.id, errorCode: String(leaseError.code || 'FINALIZE_FAILED') }); }
    } finally { client.release(); }
  }
  async function tick() {
    const free = config.concurrency - active.size;
    if (stopping || free <= 0) return 0;
    const claimableTypes = config.jobTypes.filter(type => !ACTIVATION_KEYS[type] || config.activation[ACTIVATION_KEYS[type]]);
    if (!claimableTypes.length) return 0;
    const client = await pool.connect();
    let jobs;
    try {
      if (config.dryRun) {
        const preview = await client.query(`SELECT id,job_type,status FROM lead_intel.jobs
          WHERE job_type=ANY($1::text[]) AND ((status IN ('QUEUED','RETRY_WAIT') AND run_after<=clock_timestamp())
            OR (status='LEASED' AND lease_expires_at<=clock_timestamp())) ORDER BY priority DESC,run_after,created_at LIMIT $2`, [claimableTypes, free]);
        safeLog(logger, 'job_claim_preview', { count: preview.rowCount, jobTypes: claimableTypes.join(','), writePerformed: false });
        return preview.rowCount;
      }
      jobs = await claimJobs(client, { workerId: config.workerId, jobTypes: claimableTypes, limit: free, leaseSeconds: config.leaseSeconds });
    }
    finally { client.release(); }
    for (const job of jobs) {
      const task = processJob(job).catch(() => {}).finally(() => active.delete(task));
      active.add(task);
    }
    return jobs.length;
  }
  async function run() {
    safeLog(logger, 'worker_started', { workerId: config.workerId, jobTypes: config.jobTypes.join(','), dryRun: config.dryRun });
    while (!stopping) {
      try { const count = await tick(); if (!count) await sleep(config.pollMs); }
      catch (error) { safeLog(logger, 'worker_poll_failed', { errorCode: safeErrorCode(error) }); await sleep(config.pollMs); }
    }
    await Promise.allSettled([...active]);
  }
  return { run, tick, stop: () => { stopping = true; }, get activeCount() { return active.size; } };
}

module.exports = { JOB_TYPES, ACTIVATION_KEYS, CANONICAL_FLAGS, booleanFlag, parseWorkerConfig, claimJobs, saveCheckpoint, finishJob, createWorker, safeLog, safeErrorCode };
