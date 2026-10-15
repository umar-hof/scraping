BEGIN;

CREATE TABLE lead_intel.discovery_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES lead_intel.sources(id) ON DELETE RESTRICT,
  state_code char(2) NOT NULL DEFAULT 'AZ' CHECK (state_code = 'AZ'),
  geography_type text NOT NULL CHECK (geography_type IN ('STATE','COUNTY','CITY','ZIP')),
  geography_key text NOT NULL CHECK (btrim(geography_key) <> ''),
  city text,
  zip_code varchar(5),
  industry_key text NOT NULL DEFAULT '*' CHECK (btrim(industry_key) <> ''),
  status text NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (status IN ('NOT_STARTED','QUEUED','ATTEMPTED','COMPLETED_WITH_RESULTS','COMPLETED_NO_RESULTS','BLOCKED','ERROR')),
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cursor) = 'object'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  qualified_found bigint NOT NULL DEFAULT 0 CHECK (qualified_found >= 0),
  raw_found bigint NOT NULL DEFAULT 0 CHECK (raw_found >= 0),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  next_run_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_id, state_code, geography_type, geography_key, industry_key),
  CHECK ((geography_type = 'CITY' AND city IS NOT NULL AND zip_code IS NULL) OR
         (geography_type = 'ZIP' AND zip_code ~ '^[0-9]{5}$' AND city IS NULL) OR
         (geography_type IN ('STATE','COUNTY') AND city IS NULL AND zip_code IS NULL)),
  CHECK (geography_type <> 'STATE' OR geography_key = state_code),
  CHECK (geography_type <> 'CITY' OR lower(geography_key) = lower(city)),
  CHECK (geography_type <> 'ZIP' OR geography_key = zip_code),
  CHECK (last_completed_at IS NULL OR last_started_at IS NULL OR last_completed_at >= last_started_at)
);
CREATE INDEX discovery_coverage_due_idx ON lead_intel.discovery_coverage (status, next_run_at, source_id)
  WHERE status IN ('NOT_STARTED','QUEUED','ATTEMPTED','ERROR');
CREATE INDEX discovery_coverage_geo_idx ON lead_intel.discovery_coverage (state_code, geography_type, geography_key, industry_key);
CREATE INDEX discovery_coverage_last_run_idx ON lead_intel.discovery_coverage (last_completed_at DESC NULLS FIRST, source_id);

CREATE TABLE lead_intel.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL CHECK (job_type IN ('DISCOVERY','RESEARCH','ENRICHMENT','VERIFICATION','SHEET_SYNC','RECONCILIATION','MANUAL_REVIEW')),
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','LEASED','RETRY_WAIT','SUCCEEDED','FAILED','CANCELLED','DEAD_LETTER')),
  priority smallint NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (attempt_count <= max_attempts),
  CHECK ((status = 'LEASED' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
         (status <> 'LEASED' AND lease_owner IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX jobs_claim_idx ON lead_intel.jobs (priority DESC, run_after, created_at)
  WHERE status IN ('QUEUED','RETRY_WAIT');
CREATE INDEX jobs_expired_lease_idx ON lead_intel.jobs (lease_expires_at, priority DESC)
  WHERE status = 'LEASED';
CREATE INDEX jobs_type_status_idx ON lead_intel.jobs (job_type, status, created_at DESC);

CREATE TABLE lead_intel.job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES lead_intel.jobs(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','RETRY_WAIT','FAILED','DEAD_LETTER','LEASE_EXPIRED','CANCELLED')),
  worker_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  checkpoint_start jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint_start) = 'object'),
  checkpoint_end jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint_end) = 'object'),
  error_code text,
  safe_error_message text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, attempt_number),
  CHECK ((status = 'RUNNING' AND finished_at IS NULL) OR (status <> 'RUNNING' AND finished_at IS NOT NULL)),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX job_runs_job_time_idx ON lead_intel.job_runs (job_id, attempt_number DESC);
CREATE INDEX job_runs_failures_idx ON lead_intel.job_runs (status, finished_at DESC)
  WHERE status IN ('FAILED','DEAD_LETTER','LEASE_EXPIRED');

CREATE FUNCTION lead_intel.claim_jobs(p_worker_id text, p_batch_size integer DEFAULT 1, p_lease_seconds integer DEFAULT 300)
RETURNS SETOF lead_intel.jobs
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, lead_intel AS $$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 1000 OR p_lease_seconds IS NULL OR p_lease_seconds < 1 THEN
    RAISE EXCEPTION 'Invalid worker or lease parameters';
  END IF;
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT j.id, j.status
    FROM lead_intel.jobs AS j
    WHERE (j.status IN ('QUEUED','RETRY_WAIT') AND j.run_after <= clock_timestamp())
       OR (j.status = 'LEASED' AND j.lease_expires_at <= clock_timestamp())
    ORDER BY j.priority DESC, j.run_after, j.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  ), expired_runs AS (
    UPDATE lead_intel.job_runs AS r
       SET status = 'LEASE_EXPIRED', finished_at = clock_timestamp()
      FROM candidates AS c
     WHERE c.id = r.job_id AND c.status = 'LEASED' AND r.status = 'RUNNING'
    RETURNING r.job_id
  ), leased AS (
    UPDATE lead_intel.jobs AS j
       SET status = 'LEASED',
           attempt_count = j.attempt_count + 1,
           lease_owner = p_worker_id,
           lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
           updated_at = clock_timestamp()
      FROM candidates AS c CROSS JOIN (SELECT count(*) FROM expired_runs) AS dependency
     WHERE j.id = c.id AND j.attempt_count < j.max_attempts
    RETURNING j.*
  ), run_audit AS (
    INSERT INTO lead_intel.job_runs (job_id, attempt_number, status, worker_id, checkpoint_start)
    SELECT l.id, l.attempt_count, 'RUNNING', p_worker_id, l.checkpoint
      FROM leased AS l
    RETURNING job_id
  )
  SELECT l.* FROM leased AS l JOIN run_audit AS a ON a.job_id = l.id;

  -- Expired jobs at their attempt cap cannot be claimed again.
  UPDATE lead_intel.jobs AS j
     SET status = 'DEAD_LETTER', lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp(),
         last_error_code = COALESCE(j.last_error_code, 'ATTEMPTS_EXHAUSTED')
   WHERE j.status = 'LEASED' AND j.lease_expires_at <= clock_timestamp() AND j.attempt_count >= j.max_attempts;
END;
$$;

CREATE FUNCTION lead_intel.finish_job(
  p_job_id uuid, p_worker_id text, p_succeeded boolean,
  p_checkpoint jsonb DEFAULT NULL, p_error_code text DEFAULT NULL,
  p_safe_error_message text DEFAULT NULL, p_permanent_failure boolean DEFAULT false,
  p_retry_after timestamptz DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, lead_intel AS $$
DECLARE
  current_job lead_intel.jobs%ROWTYPE;
  final_status text;
  retry_at timestamptz;
BEGIN
  IF p_worker_id IS NULL OR p_succeeded IS NULL THEN
    RAISE EXCEPTION 'Worker ID and completion status are required';
  END IF;
  SELECT * INTO current_job FROM lead_intel.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR current_job.status <> 'LEASED' OR current_job.lease_owner <> p_worker_id OR current_job.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Job lease is missing, expired, or owned by another worker';
  END IF;

  IF p_succeeded THEN
    final_status := 'SUCCEEDED';
  ELSIF p_permanent_failure OR current_job.attempt_count >= current_job.max_attempts THEN
    final_status := 'DEAD_LETTER';
  ELSE
    final_status := 'RETRY_WAIT';
    retry_at := COALESCE(p_retry_after, clock_timestamp() + make_interval(
      secs => LEAST(3600, (power(2, LEAST(current_job.attempt_count, 10))::integer + floor(random() * 6)::integer))
    ));
  END IF;

  UPDATE lead_intel.jobs
     SET status = final_status,
         checkpoint = COALESCE(p_checkpoint, checkpoint),
         run_after = CASE WHEN final_status = 'RETRY_WAIT' THEN retry_at ELSE run_after END,
         lease_owner = NULL, lease_expires_at = NULL,
         last_error_code = CASE WHEN p_succeeded THEN NULL ELSE p_error_code END,
         last_error_message = CASE WHEN p_succeeded THEN NULL ELSE left(p_safe_error_message, 1000) END,
         updated_at = clock_timestamp()
   WHERE id = p_job_id;

  UPDATE lead_intel.job_runs
     SET status = final_status,
         finished_at = clock_timestamp(),
         checkpoint_end = COALESCE(p_checkpoint, checkpoint_start),
         error_code = CASE WHEN p_succeeded THEN NULL ELSE p_error_code END,
         safe_error_message = CASE WHEN p_succeeded THEN NULL ELSE left(p_safe_error_message, 1000) END
   WHERE job_id = p_job_id AND attempt_number = current_job.attempt_count AND status = 'RUNNING';

  RETURN final_status;
END;
$$;

CREATE TABLE lead_intel.sheet_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spreadsheet_id text NOT NULL CHECK (btrim(spreadsheet_id) <> ''),
  tab_name text NOT NULL DEFAULT 'Prospects' CHECK (tab_name = 'Prospects'),
  projection_version integer NOT NULL DEFAULT 1 CHECK (projection_version > 0),
  expected_column_count integer NOT NULL DEFAULT 42 CHECK (expected_column_count = 42),
  header_sha256 char(64) NOT NULL CHECK (header_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'PAUSED' CHECK (status IN ('PAUSED','READY','SYNCING','ERROR')),
  last_successful_sync_at timestamptz,
  last_cursor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(last_cursor) = 'object'),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (spreadsheet_id, tab_name, projection_version)
);
CREATE INDEX sheet_sync_state_status_idx ON lead_intel.sheet_sync_state (status, updated_at DESC);

CREATE TABLE lead_intel.sheet_sync_row_state (
  destination_id uuid NOT NULL REFERENCES lead_intel.sheet_sync_state(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES lead_intel.companies(id) ON DELETE RESTRICT,
  lead_id text NOT NULL CHECK (btrim(lead_id) <> ''),
  remote_row_number integer CHECK (remote_row_number IS NULL OR remote_row_number >= 2),
  row_version bigint NOT NULL CHECK (row_version > 0),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  last_synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (destination_id, lead_id),
  UNIQUE (destination_id, company_id)
);
CREATE INDEX sheet_sync_row_company_idx ON lead_intel.sheet_sync_row_state (company_id, last_synced_at DESC);

CREATE TABLE lead_intel.sheet_sync_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id uuid NOT NULL REFERENCES lead_intel.sheet_sync_state(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES lead_intel.companies(id) ON DELETE RESTRICT,
  lead_id text NOT NULL CHECK (btrim(lead_id) <> ''),
  row_version bigint NOT NULL CHECK (row_version > 0),
  projection_version integer NOT NULL CHECK (projection_version > 0),
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  row_payload jsonb NOT NULL CHECK (jsonb_typeof(row_payload) = 'array' AND jsonb_array_length(row_payload) = 42),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','LEASED','RETRY_WAIT','SYNCED','DEAD_LETTER','CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz,
  remote_row_number integer CHECK (remote_row_number IS NULL OR remote_row_number >= 2),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (destination_id, lead_id, projection_version, row_version),
  CHECK (attempt_count <= max_attempts),
  CHECK ((status = 'LEASED' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
         (status <> 'LEASED' AND lease_owner IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX sheet_sync_outbox_claim_idx ON lead_intel.sheet_sync_outbox (next_attempt_at, created_at)
  WHERE status IN ('PENDING','RETRY_WAIT');
CREATE INDEX sheet_sync_outbox_expired_lease_idx ON lead_intel.sheet_sync_outbox (lease_expires_at)
  WHERE status = 'LEASED';
CREATE INDEX sheet_sync_outbox_company_idx ON lead_intel.sheet_sync_outbox (company_id, row_version DESC);

CREATE FUNCTION lead_intel.claim_sheet_sync_outbox(p_worker_id text, p_batch_size integer DEFAULT 100, p_lease_seconds integer DEFAULT 300)
RETURNS SETOF lead_intel.sheet_sync_outbox
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, lead_intel AS $$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 1000 OR p_lease_seconds IS NULL OR p_lease_seconds < 1 THEN
    RAISE EXCEPTION 'Invalid worker or lease parameters';
  END IF;
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT o.id FROM lead_intel.sheet_sync_outbox AS o
    JOIN lead_intel.sheet_sync_state AS s ON s.id = o.destination_id AND s.status IN ('READY','SYNCING')
    WHERE (o.status IN ('PENDING','RETRY_WAIT') AND o.next_attempt_at <= clock_timestamp())
       OR (o.status = 'LEASED' AND o.lease_expires_at <= clock_timestamp())
    ORDER BY o.next_attempt_at, o.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE lead_intel.sheet_sync_outbox AS o
     SET status = CASE WHEN o.attempt_count >= o.max_attempts THEN 'DEAD_LETTER' ELSE 'LEASED' END,
         attempt_count = CASE WHEN o.attempt_count >= o.max_attempts THEN o.attempt_count ELSE o.attempt_count + 1 END,
         lease_owner = CASE WHEN o.attempt_count >= o.max_attempts THEN NULL ELSE p_worker_id END,
         lease_expires_at = CASE WHEN o.attempt_count >= o.max_attempts THEN NULL ELSE clock_timestamp() + make_interval(secs => p_lease_seconds) END,
         updated_at = clock_timestamp()
    FROM candidates AS c
   WHERE o.id = c.id
  RETURNING o.*;
END;
$$;

CREATE FUNCTION lead_intel.fail_sheet_sync_outbox(
  p_outbox_id uuid, p_worker_id text, p_error_code text,
  p_permanent_failure boolean DEFAULT false, p_retry_after timestamptz DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, lead_intel AS $$
DECLARE
  item lead_intel.sheet_sync_outbox%ROWTYPE;
  final_status text;
  retry_at timestamptz;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'Worker ID is required';
  END IF;
  SELECT * INTO item FROM lead_intel.sheet_sync_outbox WHERE id = p_outbox_id FOR UPDATE;
  IF NOT FOUND OR item.status <> 'LEASED' OR item.lease_owner <> p_worker_id OR item.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Outbox lease is missing, expired, or owned by another worker';
  END IF;
  IF p_permanent_failure OR item.attempt_count >= item.max_attempts THEN
    final_status := 'DEAD_LETTER';
  ELSE
    final_status := 'RETRY_WAIT';
    retry_at := COALESCE(p_retry_after, clock_timestamp() + make_interval(
      secs => LEAST(3600, (power(2, LEAST(item.attempt_count, 10))::integer + floor(random() * 6)::integer))
    ));
  END IF;
  UPDATE lead_intel.sheet_sync_outbox
     SET status = final_status,
         next_attempt_at = CASE WHEN final_status = 'RETRY_WAIT' THEN retry_at ELSE next_attempt_at END,
         lease_owner = NULL, lease_expires_at = NULL,
         last_error_code = p_error_code,
         updated_at = clock_timestamp()
   WHERE id = p_outbox_id;
  RETURN final_status;
END;
$$;

CREATE FUNCTION lead_intel.ack_sheet_sync_outbox(
  p_outbox_id uuid, p_worker_id text, p_remote_row_number integer, p_payload_sha256 char(64)
) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, lead_intel AS $$
DECLARE
  item lead_intel.sheet_sync_outbox%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'Worker ID is required';
  END IF;
  SELECT * INTO item FROM lead_intel.sheet_sync_outbox WHERE id = p_outbox_id FOR UPDATE;
  IF NOT FOUND OR item.status <> 'LEASED' OR item.lease_owner <> p_worker_id OR item.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Outbox lease is missing, expired, or owned by another worker';
  END IF;
  IF p_payload_sha256 IS NULL OR item.payload_sha256 <> p_payload_sha256 OR p_remote_row_number IS NULL OR p_remote_row_number < 2 THEN
    RAISE EXCEPTION 'Outbox acknowledgement does not match the leased payload';
  END IF;

  UPDATE lead_intel.sheet_sync_outbox
     SET status = 'SYNCED', remote_row_number = p_remote_row_number,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
   WHERE id = p_outbox_id;

  INSERT INTO lead_intel.sheet_sync_row_state
    (destination_id, company_id, lead_id, remote_row_number, row_version, payload_sha256)
  VALUES
    (item.destination_id, item.company_id, item.lead_id, p_remote_row_number, item.row_version, item.payload_sha256)
  ON CONFLICT (destination_id, lead_id) DO UPDATE
    SET company_id = EXCLUDED.company_id,
        remote_row_number = EXCLUDED.remote_row_number,
        row_version = EXCLUDED.row_version,
        payload_sha256 = EXCLUDED.payload_sha256,
        last_synced_at = clock_timestamp(),
        updated_at = clock_timestamp();

  UPDATE lead_intel.sheet_sync_state
     SET last_successful_sync_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE id = item.destination_id;
END;
$$;

CREATE TABLE lead_intel.suppression (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES lead_intel.companies(id) ON DELETE RESTRICT,
  contact_id uuid,
  contact_point_id uuid,
  channel text CHECK (channel IS NULL OR channel IN ('EMAIL','PHONE','ALL')),
  suppression_type text NOT NULL
    CHECK (suppression_type IN ('OPT_OUT','DO_NOT_CONTACT','LEGAL_HOLD','BOUNCE','INVALID_CONTACT','MANUAL_EXCLUSION')),
  reason text,
  source_evidence_id uuid,
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  rescinded_at timestamptz,
  recorded_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (contact_id, company_id) REFERENCES lead_intel.contacts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (contact_point_id, company_id) REFERENCES lead_intel.contact_points(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_evidence_id, company_id) REFERENCES lead_intel.source_evidence(id, company_id) ON DELETE RESTRICT,
  CHECK ((contact_id IS NULL OR contact_point_id IS NULL)),
  CHECK (expires_at IS NULL OR expires_at >= effective_at),
  CHECK (rescinded_at IS NULL OR rescinded_at >= effective_at)
);
CREATE INDEX suppression_active_company_idx ON lead_intel.suppression (company_id, channel, effective_at DESC)
  WHERE rescinded_at IS NULL;
CREATE INDEX suppression_active_contact_idx ON lead_intel.suppression (contact_id, channel, effective_at DESC)
  WHERE contact_id IS NOT NULL AND rescinded_at IS NULL;
CREATE INDEX suppression_active_point_idx ON lead_intel.suppression (contact_point_id, channel, effective_at DESC)
  WHERE contact_point_id IS NOT NULL AND rescinded_at IS NULL;

CREATE TRIGGER discovery_coverage_touch_updated_at BEFORE UPDATE ON lead_intel.discovery_coverage
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER jobs_touch_updated_at BEFORE UPDATE ON lead_intel.jobs
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER sheet_sync_state_touch_updated_at BEFORE UPDATE ON lead_intel.sheet_sync_state
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER sheet_sync_row_state_touch_updated_at BEFORE UPDATE ON lead_intel.sheet_sync_row_state
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER sheet_sync_outbox_touch_updated_at BEFORE UPDATE ON lead_intel.sheet_sync_outbox
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER suppression_touch_updated_at BEFORE UPDATE ON lead_intel.suppression
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER suppression_no_hard_delete BEFORE DELETE ON lead_intel.suppression
  FOR EACH ROW EXECUTE FUNCTION lead_intel.reject_audit_mutation();

ALTER TABLE lead_intel.discovery_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.sheet_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.sheet_sync_row_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.sheet_sync_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.suppression ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA lead_intel FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lead_intel FROM PUBLIC;

COMMIT;
