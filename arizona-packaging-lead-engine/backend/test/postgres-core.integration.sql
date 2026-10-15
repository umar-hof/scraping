\set ON_ERROR_STOP on

DO $$
DECLARE
  company_a uuid;
  company_b uuid;
  source_id uuid;
  evidence_id uuid;
  contact_id uuid;
  company_email_id uuid;
  person_email_id uuid;
  caught boolean := false;
BEGIN
  SELECT id INTO source_id FROM lead_intel.sources
   WHERE source_key = 'integration-manual-source';
  IF source_id IS NULL THEN RAISE EXCEPTION 'fixture source missing'; END IF;

  INSERT INTO lead_intel.companies (canonical_name, website_url, primary_domain, headquarters_state_code)
  VALUES ('Integration Brand A', 'https://shared.example/', 'shared.example', 'AZ') RETURNING id INTO company_a;
  INSERT INTO lead_intel.companies (canonical_name, website_url, primary_domain, headquarters_state_code)
  VALUES ('Integration Brand B', 'https://shared.example/brand-b', 'shared.example', 'AZ') RETURNING id INTO company_b;

  INSERT INTO lead_intel.company_identifiers
    (company_id, identifier_type, identifier_namespace, raw_value, normalized_value)
  VALUES (company_a, 'APPS_SCRIPT_LEAD_ID', 'apps-script', 'LEAD-IT-001', 'LEAD-IT-001');
  BEGIN
    INSERT INTO lead_intel.company_identifiers
      (company_id, identifier_type, identifier_namespace, raw_value, normalized_value)
    VALUES (company_b, 'APPS_SCRIPT_LEAD_ID', 'apps-script', 'LEAD-IT-001', 'LEAD-IT-001');
  EXCEPTION WHEN unique_violation THEN caught := true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'duplicate external Lead ID was accepted'; END IF;

  INSERT INTO lead_intel.company_locations (company_id, location_type, city, state_code, postal_code, is_primary)
  VALUES (company_a, 'HEADQUARTERS', 'Phoenix', 'AZ', '85001', true);
  INSERT INTO lead_intel.company_locations (company_id, location_type, city, state_code, postal_code)
  VALUES (company_a, 'FACILITY', 'Tempe', 'AZ', '85281');
  IF (SELECT count(*) FROM lead_intel.company_locations WHERE company_id = company_a) <> 2 THEN
    RAISE EXCEPTION 'multiple company locations were not retained';
  END IF;

  INSERT INTO lead_intel.source_evidence
    (company_id, source_id, evidence_type, source_url, access_policy_snapshot, confidence)
  VALUES (company_a, source_id, 'CONTACT_POINT', 'https://shared.example/contact', 'PUBLIC_OFFICIAL_PAGE', 0.9)
  RETURNING id INTO evidence_id;
  INSERT INTO lead_intel.contacts (company_id, full_name, job_title)
  VALUES (company_a, 'Sample Decision Maker', 'Operations Manager') RETURNING id INTO contact_id;
  INSERT INTO lead_intel.contact_points
    (company_id, scope_kind, channel, raw_value, normalized_value, source_evidence_id,
     is_publicly_listed, email_syntax_status, email_mx_status, email_deliverability_status)
  VALUES (company_a, 'COMPANY', 'EMAIL', 'hello@shared.example', 'hello@shared.example', evidence_id,
          true, 'UNVERIFIED', 'NOT_CHECKED', 'UNVERIFIED') RETURNING id INTO company_email_id;
  INSERT INTO lead_intel.contact_points
    (company_id, scope_kind, contact_id, channel, raw_value, normalized_value, source_evidence_id,
     is_publicly_listed, email_syntax_status, email_mx_status, email_deliverability_status)
  VALUES (company_a, 'PERSON', contact_id, 'EMAIL', 'person@shared.example', 'person@shared.example', evidence_id,
          true, 'VALID_FORMAT', 'MX_PRESENT', 'UNVERIFIED') RETURNING id INTO person_email_id;

  INSERT INTO lead_intel.verification_events
    (contact_point_id, channel, check_type, verification_state, normalized_result, provider)
  VALUES (person_email_id, 'EMAIL', 'EMAIL_MX', 'VERIFIED', 'MX_PRESENT', 'integration-test');
  IF (SELECT email_deliverability_status FROM lead_intel.contact_points WHERE id = person_email_id) <> 'UNVERIFIED' THEN
    RAISE EXCEPTION 'MX result incorrectly changed deliverability';
  END IF;
  caught := false;
  BEGIN
    INSERT INTO lead_intel.verification_events
      (contact_point_id, channel, check_type, verification_state, normalized_result, provider, independent_verifier)
    VALUES (person_email_id, 'EMAIL', 'EMAIL_DELIVERABILITY', 'VERIFIED', 'DELIVERABLE', 'integration-test', false);
  EXCEPTION WHEN check_violation THEN caught := true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'deliverability without independent verifier was accepted'; END IF;

  IF (SELECT scope_kind FROM lead_intel.contact_points WHERE id = company_email_id) <> 'COMPANY'
     OR (SELECT scope_kind FROM lead_intel.contact_points WHERE id = person_email_id) <> 'PERSON' THEN
    RAISE EXCEPTION 'company and person contact points are not separated';
  END IF;

  caught := false;
  BEGIN
    INSERT INTO lead_intel.source_evidence
      (company_id, contact_id, source_id, evidence_type, source_url, access_policy_snapshot)
    VALUES (company_b, contact_id, source_id, 'CONTACT_IDENTITY', 'https://shared.example/team', 'TEST');
  EXCEPTION WHEN foreign_key_violation THEN caught := true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'cross-company evidence/contact relationship was accepted'; END IF;
END $$;

SELECT 'core integration assertions passed' AS result;
