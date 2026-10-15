'use strict';

const http = require('node:http');

function createHealthServer({ metrics, getWorker = () => null } = {}) {
  return http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      const worker = getWorker();
      const body = { status: metrics.health, startedAt: metrics.startedAt, workerActive: Boolean(worker), activeJobs: worker?.activeCount || 0 };
      res.writeHead(metrics.health === 'error' ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    if (req.url === '/metrics') {
      const worker = getWorker();
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(`hof_worker_up ${metrics.health === 'healthy' ? 1 : 0}\nhof_worker_active_jobs ${worker?.activeCount || 0}\nhof_worker_poll_errors_total ${metrics.pollErrors}\n`);
      return;
    }
    res.writeHead(404); res.end();
  });
}

module.exports = { createHealthServer };
