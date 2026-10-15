'use strict';

const { Pool } = require('pg');
const { loadLocalEnv } = require('./src/local-env');
const { parseWorkerConfig, createWorker, safeLog, safeErrorCode } = require('./src/worker-runtime');
const { createWorkerHandlers } = require('./src/worker-handlers');
const { validateStartup, createGracefulShutdown } = require('./src/worker-bootstrap');
const { createHealthServer } = require('./src/worker-health');

loadLocalEnv();
const config = parseWorkerConfig();
const metrics = { startedAt: new Date().toISOString(), pollErrors: 0, health: 'paused' };
const logger = event => {
  if (event.event === 'worker_poll_failed') metrics.pollErrors += 1;
  process.stdout.write(`${JSON.stringify(event)}\n`);
};
let worker;
let pool;
const server = createHealthServer({ metrics, getWorker: () => worker });

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => safeLog(logger, 'health_server_listening', { port }));

const shutdown = createGracefulShutdown({ getWorker: () => worker, getPool: () => pool, server,
  exit: (code, signal) => { safeLog(logger, 'shutdown_finished', { code, signal }); process.exit(code); } });
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

async function start() {
  const startup = validateStartup(process.env);
  if (startup.paused) {
    safeLog(logger, 'worker_paused', { reason: 'WORKER_START_ENABLED_NOT_TRUE', dryRun: config.dryRun });
    return;
  }
  pool = new Pool(startup.database);
  await pool.query('SELECT 1');
  metrics.health = 'healthy';
  worker = createWorker({ pool, config, logger, handlers: createWorkerHandlers({ env: process.env, logger }) });
  worker.runPromise = worker.run();
}

start().catch(error => {
  metrics.health = 'error';
  safeLog(logger, 'worker_start_failed', { errorCode: safeErrorCode(error) });
  if (pool) pool.end().catch(() => {});
  process.exitCode = 1;
});
