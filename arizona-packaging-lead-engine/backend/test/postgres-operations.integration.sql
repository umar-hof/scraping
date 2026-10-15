\set ON_ERROR_STOP on

DO $$
DECLARE
  company_id uuid;
  source_id uuid;
  v_job_id uuid;
  destination_id uuid;
  outbox_id uuid;
  caught boolean := false;
BEGIN
  SELECT id INTO company_id FROM lead_intel.companies WHERE canonical_name = 'Integration Brand A';
  SELECT id INTO source_id FROM lead_intel.sources WHERE source_key = 'integration-manual-source';

  INSERT INTO lead_intel.discovery_coverage
    (source_id, geography_type, geography_key, city, industry_key)
  VALUES (source_id, 'CITY', 'Phoenix', 'Phoenix', 'PACKAGED_FOOD');
  INSERT INTO lead_intel.jobs (job_type, idempotency_key, max_attempts, payload, priority)
  VALUES ('RESEARCH', 'integration-retry-job', 2, '{"fixture":true}', 1000) RETURNING id INTO v_job_id;

  IF (SELECT count(*) FROM lead_intel.claim_jobs('worker-attempt-1', 1, 30) WHERE id = v_job_id) <> 1 THEN
    RAISE EXCEPTION 'initial job claim failed';
  END IF;
  IF lead_intel.finish_job(v_job_id, 'worker-attempt-1', false, '{"cursor":"checkpoint-1"}',
                           'TEMPORARY', 'sanitized test failure', false, clock_timestamp()) <> 'RETRY_WAIT' THEN
    RAISE EXCEPTION 'recoverable failure did not enter retry wait';
  END IF;
  IF (SELECT checkpoint->>'cursor' FROM lead_intel.jobs WHERE id = v_job_id) <> 'checkpoint-1' THEN
    RAISE EXCEPTION 'job checkpoint was not persisted';
  END IF;
  IF (SELECT count(*) FROM lead_intel.claim_jobs('worker-attempt-2', 1, 30) WHERE id = v_job_id) <> 1 THEN
    RAISE EXCEPTION 'retry claim failed';
  END IF;
  IF lead_intel.finish_job(v_job_id, 'worker-attempt-2', false, NULL,
                           'REPEATED', 'sanitized terminal test failure', false, NULL) <> 'DEAD_LETTER' THEN
    RAISE EXCEPTION 'exhausted job did not enter dead letter';
  END IF;
  IF (SELECT count(*) FROM lead_intel.job_runs AS jr WHERE jr.job_id = v_job_id AND jr.status = 'DEAD_LETTER') <> 1 THEN
    RAISE EXCEPTION 'dead-letter attempt was not audited';
  END IF;

  INSERT INTO lead_intel.sheet_sync_state
    (spreadsheet_id, header_sha256, status)
  VALUES ('DISPOSABLE-IT-ONLY', repeat('a', 64), 'READY') RETURNING id INTO destination_id;
  INSERT INTO lead_intel.sheet_sync_outbox
    (destination_id, company_id, lead_id, row_version, projection_version, idempotency_key,
     row_payload, payload_sha256)
  VALUES (destination_id, company_id, 'LEAD-IT-001', 1, 1, 'integration-outbox-v1',
          (SELECT jsonb_agg(''::text ORDER BY n) FROM generate_series(1,42) AS gs(n)), repeat('b',64))
  RETURNING id INTO outbox_id;
  BEGIN
    INSERT INTO lead_intel.sheet_sync_outbox
      (destination_id, company_id, lead_id, row_version, projection_version, idempotency_key,
       row_payload, payload_sha256)
    VALUES (destination_id, company_id, 'LEAD-IT-001', 1, 1, 'integration-outbox-v1-duplicate',
            (SELECT jsonb_agg(''::text ORDER BY n) FROM generate_series(1,42) AS gs(n)), repeat('b',64));
  EXCEPTION WHEN unique_violation THEN caught := true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'duplicate Sheets row version was accepted'; END IF;
  caught := false;
  BEGIN
    INSERT INTO lead_intel.sheet_sync_outbox
      (destination_id, company_id, lead_id, row_version, projection_version, idempotency_key,
       row_payload, payload_sha256)
    VALUES (destination_id, company_id, 'LEAD-IT-002', 1, 1, 'integration-outbox-v2',
            (SELECT jsonb_agg(''::text ORDER BY n) FROM generate_series(1,41) AS gs(n)), repeat('c',64));
  EXCEPTION WHEN check_violation THEN caught := true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'non-42-cell Sheets payload was accepted'; END IF;
  IF (SELECT count(*) FROM lead_intel.sheet_sync_outbox WHERE idempotency_key = 'integration-outbox-v1') <> 1 THEN
    RAISE EXCEPTION 'outbox idempotency fixture missing';
  END IF;
  SELECT o.id INTO outbox_id FROM lead_intel.claim_sheet_sync_outbox('sheet-worker', 1, 30) AS o WHERE o.id = outbox_id;
  IF outbox_id IS NULL THEN RAISE EXCEPTION 'outbox claim/lease failed'; END IF;
  IF lead_intel.fail_sheet_sync_outbox(outbox_id, 'sheet-worker', 'TEMPORARY', false, clock_timestamp()) <> 'RETRY_WAIT' THEN
    RAISE EXCEPTION 'recoverable outbox failure did not enter retry wait';
  END IF;
END $$;

SELECT 'operations integration assertions passed' AS result;
