'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHealthServer } = require('../src/worker-health');

test('paused worker exposes HTTP health and metrics without starting DB or job execution', async () => {
  const metrics = { health: 'paused', startedAt: new Date(0).toISOString(), pollErrors: 0 };
  let workerCalls = 0;
  const server = createHealthServer({ metrics, getWorker: () => { workerCalls += 1; return null; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const healthResponse = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { status: 'paused', startedAt: metrics.startedAt, workerActive: false, activeJobs: 0 });
    const metricsResponse = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    assert.match(await metricsResponse.text(), /hof_worker_up 0/);
    assert.equal(workerCalls, 2);
    assert.equal(metrics.health, 'paused');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
