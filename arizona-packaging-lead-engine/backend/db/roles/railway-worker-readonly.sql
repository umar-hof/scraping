-- Environment-specific disposable Railway preview role. Does not change global grants or RLS settings.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hof_railway_worker') THEN
    EXECUTE 'CREATE ROLE hof_railway_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hof_railway_worker'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Existing hof_railway_worker role is not the expected restricted NOLOGIN role';
  END IF;
END $$;

GRANT USAGE ON SCHEMA lead_intel TO hof_railway_worker;
GRANT SELECT (id, job_type, status, priority, run_after, created_at, lease_expires_at)
  ON lead_intel.jobs TO hof_railway_worker;

-- Allows the disposable project owner to SET ROLE for permission tests; no inherited access is added.
DO $$
BEGIN
  EXECUTE format('GRANT hof_railway_worker TO %I WITH INHERIT FALSE, SET TRUE', current_user);
END $$;

DO $$
DECLARE p record;
BEGIN
  SELECT cmd, roles, qual INTO p FROM pg_policies
   WHERE schemaname = 'lead_intel' AND tablename = 'jobs' AND policyname = 'hof_railway_worker_preview';
  IF NOT FOUND THEN
    EXECUTE $policy$CREATE POLICY hof_railway_worker_preview ON lead_intel.jobs
      FOR SELECT TO hof_railway_worker
      USING (job_type IN ('RECONCILIATION','MANUAL_REVIEW'))$policy$;
  ELSIF p.cmd <> 'SELECT' OR NOT ('hof_railway_worker' = ANY(p.roles))
    OR p.qual NOT LIKE '%RECONCILIATION%' OR p.qual NOT LIKE '%MANUAL_REVIEW%' THEN
    RAISE EXCEPTION 'Existing worker preview policy differs from the expected narrow SELECT policy';
  END IF;
END $$;

COMMIT;
