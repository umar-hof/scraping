'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { loadLocalEnv } = require('../src/local-env');
const { readSupabaseConfig } = require('../src/supabase-config');

function safeErrorCode(error) {
  const code = String(error?.code || 'WORKER_ROLE_SETUP_FAILED');
  return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : 'WORKER_ROLE_SETUP_FAILED';
}

async function smokeTest(client) {
  const before = await client.query('SELECT count(*)::int AS count FROM lead_intel.jobs');
  let stage = 'begin';
  await client.query('BEGIN');
  try {
    stage = 'assume_restricted_role';
    await client.query('SET LOCAL ROLE hof_railway_worker');
    stage = 'read_allowed_preview_columns';
    const visible = await client.query(`SELECT id,job_type,status,priority,run_after,created_at,lease_expires_at
      FROM lead_intel.jobs ORDER BY priority DESC,run_after,created_at LIMIT 5`);
    stage = 'inspect_effective_privileges';
    const checks = await client.query(`SELECT current_user AS role,
      has_column_privilege(current_user,'lead_intel.jobs','id','SELECT') AS can_read_job_ids,
      has_column_privilege(current_user,'lead_intel.jobs','payload','SELECT') AS can_read_payload,
      has_column_privilege(current_user,'lead_intel.jobs','id','UPDATE') AS can_update,
      has_function_privilege(current_user,'lead_intel.claim_jobs(text,integer,integer)','EXECUTE') AS can_claim,
      (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='lead_intel' AND c.relname='jobs') AS rls_enabled`);
    const result = checks.rows[0];
    if (result.role !== 'hof_railway_worker' || !result.can_read_job_ids || result.can_read_payload || result.can_update || result.can_claim || !result.rls_enabled) {
      throw Object.assign(new Error('Restricted role permission assertions failed.'), { code: 'ROLE_PERMISSION_ASSERTION_FAILED' });
    }
    let deniedDml = false;
    stage = 'verify_dml_denied';
    await client.query('SAVEPOINT privilege_probe');
    try { await client.query("UPDATE lead_intel.jobs SET status='CANCELLED' WHERE false"); }
    catch (error) { deniedDml = error.code === '42501'; }
    await client.query('ROLLBACK TO SAVEPOINT privilege_probe');
    await client.query('RELEASE SAVEPOINT privilege_probe');
    if (!deniedDml) throw Object.assign(new Error('Restricted role unexpectedly has UPDATE permission.'), { code: 'ROLE_DML_NOT_DENIED' });
    await client.query('ROLLBACK');
    stage = 'verify_no_database_change';
    const after = await client.query('SELECT count(*)::int AS count FROM lead_intel.jobs');
    if (Number(before.rows[0].count) !== Number(after.rows[0].count)) throw Object.assign(new Error('Queue count changed during permission smoke test.'), { code: 'QUEUE_CHANGED' });
    return { rlsEnabled: true, canReadPreviewColumns: true, canReadPayload: false, canUpdate: false,
      canExecuteClaimFunction: false, dmlDenied: true, visibleRows: visible.rowCount, queueUnchanged: true };
  } catch (error) {
    error.smokeStage = stage;
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function inspectRoleSetup(client) {
  const result = await client.query(`SELECT r.rolcreaterole,r.rolsuper,
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hof_railway_worker') AS worker_role_exists,
    (SELECT rolcanlogin FROM pg_roles WHERE rolname='hof_railway_worker') AS worker_role_can_login,
    (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname='hof_railway_worker') AS worker_role_has_elevated_flags,
    (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname='hof_railway_worker') AS worker_role_member_count,
    pg_has_role(current_user,'hof_railway_worker','MEMBER') AS current_user_can_assume_worker_role,
    (SELECT m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
      WHERE r.rolname='hof_railway_worker' AND m.member=(SELECT oid FROM pg_roles WHERE rolname=current_user) LIMIT 1) AS current_membership_set_option,
    (SELECT cmd FROM pg_policies WHERE schemaname='lead_intel' AND tablename='jobs' AND policyname='hof_railway_worker_preview') AS preview_policy_command,
    (SELECT qual FROM pg_policies WHERE schemaname='lead_intel' AND tablename='jobs' AND policyname='hof_railway_worker_preview') AS preview_policy_qual,
    has_column_privilege('hof_railway_worker','lead_intel.jobs','id','SELECT') AS worker_can_read_ids,
    has_column_privilege('hof_railway_worker','lead_intel.jobs','payload','SELECT') AS worker_can_read_payload,
    has_column_privilege('hof_railway_worker','lead_intel.jobs','id','UPDATE') AS worker_can_update,
    pg_get_userbyid(c.relowner) AS jobs_owner,has_table_privilege(current_user,c.oid,'SELECT') AS admin_can_read
    FROM pg_roles r JOIN pg_class c ON c.relname='jobs' JOIN pg_namespace n ON n.oid=c.relnamespace
      AND n.nspname='lead_intel' WHERE r.rolname=current_user`);
  return result.rows[0];
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let stage = 'configuration';
  loadLocalEnv(env);
  if (argv.length !== 2 || !['--confirm-disposable','--inspect-disposable','--smoke-disposable'].includes(argv[0])) throw new Error('Usage: npm run worker:role-smoke -- (--confirm-disposable|--inspect-disposable|--smoke-disposable) <exact-disposable-project-ref>');
  const config = readSupabaseConfig(env);
  if (config.environment !== 'DISPOSABLE' || argv[1] !== config.projectRef) throw new Error('Disposable project confirmation did not match configured target. No database operation performed.');
  const caFile = env.SUPABASE_DB_SSL_CA_FILE;
  if (!caFile || !fs.existsSync(caFile)) throw new Error('Configured database CA file is missing. No database operation performed.');
  const client = new Client(config);
  try {
    stage = 'connect';
    await client.connect();
    stage = 'target_identity';
    const identity = await client.query('SELECT current_database() AS db, current_user AS role, current_setting(\'row_security\') AS row_security');
    if (identity.rows[0].db !== 'postgres' || identity.rows[0].row_security !== 'on') throw new Error('Connected database identity/settings did not match the disposable smoke-test expectation.');
    if (argv[0] === '--inspect-disposable') {
      process.stdout.write(`${JSON.stringify({ event: 'disposable_worker_role_inspection', environment: 'DISPOSABLE', ...await inspectRoleSetup(client) })}\n`);
      return;
    }
    if (argv[0] === '--confirm-disposable') {
      stage = 'apply_scoped_role_grants';
      const roleSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'roles', 'railway-worker-readonly.sql'), 'utf8');
      await client.query(roleSql);
    }
    stage = 'restricted_role_smoke';
    const result = await smokeTest(client);
    process.stdout.write(`${JSON.stringify({ event: 'disposable_worker_role_smoke', environment: 'DISPOSABLE', role: 'hof_railway_worker', ...result })}\n`);
  } catch (error) { error.stage = error.smokeStage || stage; throw error; }
  finally { await client.end(); }
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ event: 'disposable_worker_role_smoke_failed', stage: error.stage || 'preflight', errorCode: safeErrorCode(error), databaseOperationStarted: error.stage !== 'configuration' })}\n`);
  process.exitCode = 1;
});

module.exports = { main, smokeTest, inspectRoleSetup };
