'use strict';

const fs = require('node:fs');
const { X509Certificate } = require('node:crypto');
const { readSupabaseConfig } = require('./supabase-config');

function validateDatabaseCa(filePath) {
  if (!filePath) throw new Error('SUPABASE_DB_SSL_CA_FILE is required for the Railway worker.');
  const cert = new X509Certificate(fs.readFileSync(filePath));
  if (!cert.ca || Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) {
    throw new Error('Configured Supabase CA is not a currently valid CA certificate.');
  }
  return true;
}

function validateStartup(env = process.env, options = {}) {
  if (env.WORKER_START_ENABLED !== 'true') return Object.freeze({ paused: true, database: null });
  const database = (options.readConfig || readSupabaseConfig)(env);
  if (database.environment !== 'DISPOSABLE') throw new Error('Worker deployment is restricted to SUPABASE_ENVIRONMENT=DISPOSABLE.');
  (options.validateCa || validateDatabaseCa)(env.SUPABASE_DB_SSL_CA_FILE);
  if (database.ssl?.rejectUnauthorized !== true || !database.ssl.ca) throw new Error('Worker database TLS must verify certificates and use the configured CA.');
  return Object.freeze({ paused: false, database });
}

function createGracefulShutdown({ worker, pool, getWorker, getPool, server, exit = () => {}, timeoutMs = 10000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let closing = false;
  return async function shutdown(signal) {
    if (closing) return;
    closing = true;
    const activeWorker = getWorker ? getWorker() : worker;
    const activePool = getPool ? getPool() : pool;
    activeWorker?.stop();
    let timer;
    const drained = (async () => {
      if (activeWorker?.runPromise) await activeWorker.runPromise;
      if (activePool) await activePool.end();
      await new Promise(resolve => {
        if (!server || !server.listening) return resolve();
        server.close(resolve);
      });
    })();
    const timedOut = new Promise(resolve => { timer = setTimer(() => resolve(false), timeoutMs); timer.unref?.(); });
    const complete = await Promise.race([drained.then(() => true), timedOut]);
    clearTimer(timer);
    exit(complete ? 0 : 1, complete ? signal : 'shutdown-timeout');
  };
}

module.exports = { validateStartup, validateDatabaseCa, createGracefulShutdown };
