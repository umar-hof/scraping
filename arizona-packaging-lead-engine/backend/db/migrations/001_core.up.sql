BEGIN;

-- Private application schema; no Supabase Data API exposure is configured here.
CREATE SCHEMA lead_intel;
REVOKE ALL ON SCHEMA lead_intel FROM PUBLIC;

CREATE TABLE lead_intel.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL CHECK (btrim(canonical_name) <> ''),
  website_url text,
  primary_domain text,
  industry text,
  industry_code text,
  headquarters_city text,
  headquarters_state_code char(2),
  headquarters_postal_code varchar(10),
  icp_score numeric(5,2) CHECK (icp_score IS NULL OR icp_score BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'DISCOVERED'
    CHECK (status IN ('DISCOVERED','NEEDS_REVIEW','QUALIFIED','REJECTED','ACTIVE','INACTIVE','MERGED')),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CHECK (headquarters_state_code IS NULL OR headquarters_state_code ~ '^[A-Z]{2}$'),
  CHECK (headquarters_postal_code IS NULL OR headquarters_postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  CHECK (last_seen_at >= first_seen_at)
);

-- Website domains are deliberately non-unique: brands may share a domain,
-- and one company may operate at multiple locations.
CREATE INDEX companies_domain_idx ON lead_intel.companies (lower(primary_domain)) WHERE primary_domain IS NOT NULL;
CREATE INDEX companies_name_idx ON lead_intel.companies (lower(canonical_name));
CREATE INDEX companies_status_industry_idx ON lead_intel.companies (status, industry_code, updated_at DESC);
CREATE INDEX companies_arizona_city_idx ON lead_intel.companies (lower(headquarters_city))
  WHERE headquarters_state_code = 'AZ' AND headquarters_city IS NOT NULL;

CREATE TABLE lead_intel.company_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES lead_intel.companies(id) ON DELETE RESTRICT,
  location_type text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (location_type IN ('HEADQUARTERS','FACILITY','RETAIL','MAILING','UNKNOWN')),
  address_line_1 text,
  address_line_2 text,
  city text,
  region text,
  state_code char(2),
  postal_code varchar(10),
  country_code char(2) NOT NULL DEFAULT 'US',
  is_primary boolean NOT NULL DEFAULT false,
  source_evidence_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (state_code IS NULL OR state_code ~ '^[A-Z]{2}$'),
  CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{5}(-[0-9]{4})?$')
);
CREATE UNIQUE INDEX company_locations_one_primary_idx ON lead_intel.company_locations (company_id) WHERE is_primary;
CREATE INDEX company_locations_city_idx ON lead_intel.company_locations (state_code, lower(city), postal_code);
CREATE INDEX company_locations_postal_idx ON lead_intel.company_locations (postal_code) WHERE postal_code IS NOT NULL;

CREATE TABLE lead_intel.sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE CHECK (btrim(source_key) <> ''),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  source_type text NOT NULL
    CHECK (source_type IN ('OFFICIAL_REGISTRY','PUBLIC_DIRECTORY','PUBLIC_API','USER_PROVIDED','MANUAL_REVIEW','VERIFICATION_PROVIDER','OTHER')),
  base_url text,
  terms_url text,
  permission_status text NOT NULL DEFAULT 'PENDING'
    CHECK (permission_status IN ('PENDING','APPROVED','MANUAL_ONLY','RESTRICTED','REVOKED')),
  permission_notes text,
  rate_limit_per_second numeric(8,3) CHECK (rate_limit_per_second IS NULL OR rate_limit_per_second > 0),
  daily_request_limit integer CHECK (daily_request_limit IS NULL OR daily_request_limit > 0),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT enabled OR permission_status IN ('APPROVED','MANUAL_ONLY'))
);
CREATE INDEX sources_permission_enabled_idx ON lead_intel.sources (permission_status, enabled, source_type);

CREATE TABLE lead_intel.company_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES lead_intel.companies(id) ON DELETE RESTRICT,
  identifier_type text NOT NULL
    CHECK (identifier_type IN ('APPS_SCRIPT_LEAD_ID','SOURCE_RECORD_ID','STATE_ENTITY_ID','WEBSITE_DOMAIN','WEBSITE_URL','ALTERNATE_NAME','OTHER')),
  identifier_namespace text NOT NULL CHECK (btrim(identifier_namespace) <> ''),
  raw_value text NOT NULL CHECK (btrim(raw_value) <> ''),
  normalized_value text NOT NULL CHECK (btrim(normalized_value) <> ''),
  source_id uuid REFERENCES lead_intel.sources(id) ON DELETE RESTRICT,
  source_url text,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, identifier_type, identifier_namespace, normalized_value),
  CHECK (last_seen_at >= first_seen_at)
);
-- External IDs are unique in their own namespace; domains and names are not globally unique.
CREATE UNIQUE INDEX company_identifiers_external_id_unique_idx
  ON lead_intel.company_identifiers (identifier_namespace, identifier_type, normalized_value)
  WHERE identifier_type IN ('APPS_SCRIPT_LEAD_ID','SOURCE_RECORD_ID','STATE_ENTITY_ID');
CREATE INDEX company_identifiers_lookup_idx
  ON lead_intel.company_identifiers (identifier_type, normalized_value);
CREATE INDEX company_identifiers_company_idx ON lead_intel.company_identifiers (company_id, identifier_type);

CREATE TABLE lead_intel.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES lead_intel.companies(id) ON DELETE RESTRICT,
  full_name text NOT NULL CHECK (btrim(full_name) <> ''),
  normalized_name text,
  job_title text,
  department text,
  is_current boolean NOT NULL DEFAULT true,
  source_evidence_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, company_id),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX contacts_company_current_idx ON lead_intel.contacts (company_id, is_current, lower(full_name));
CREATE INDEX contacts_name_search_idx ON lead_intel.contacts (lower(normalized_name)) WHERE normalized_name IS NOT NULL;

CREATE TABLE lead_intel.source_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES lead_intel.companies(id) ON DELETE RESTRICT,
  contact_id uuid,
  source_id uuid NOT NULL REFERENCES lead_intel.sources(id) ON DELETE RESTRICT,
  evidence_type text NOT NULL
    CHECK (evidence_type IN ('DISCOVERY','COMPANY_IDENTITY','LOCATION','PRODUCT','INDUSTRY','CONTACT_IDENTITY','CONTACT_POINT','EMPLOYEE_SIZE','OTHER')),
  source_url text NOT NULL CHECK (source_url ~ '^https?://'),
  evidence_text text,
  access_policy_snapshot text NOT NULL DEFAULT 'UNRECORDED',
  confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  source_published_at timestamptz,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz,
  content_sha256 char(64) CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, company_id),
  FOREIGN KEY (contact_id, company_id) REFERENCES lead_intel.contacts(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX source_evidence_company_time_idx ON lead_intel.source_evidence (company_id, captured_at DESC);
CREATE INDEX source_evidence_source_time_idx ON lead_intel.source_evidence (source_id, captured_at DESC);
CREATE INDEX source_evidence_contact_idx ON lead_intel.source_evidence (contact_id, captured_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX source_evidence_type_confidence_idx ON lead_intel.source_evidence (evidence_type, confidence DESC, captured_at DESC);

ALTER TABLE lead_intel.company_locations
  ADD CONSTRAINT company_locations_evidence_company_fk
  FOREIGN KEY (source_evidence_id, company_id)
  REFERENCES lead_intel.source_evidence(id, company_id) ON DELETE RESTRICT;
ALTER TABLE lead_intel.contacts
  ADD CONSTRAINT contacts_evidence_company_fk
  FOREIGN KEY (source_evidence_id, company_id)
  REFERENCES lead_intel.source_evidence(id, company_id) ON DELETE RESTRICT;

CREATE TABLE lead_intel.contact_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES lead_intel.companies(id) ON DELETE RESTRICT,
  scope_kind text NOT NULL CHECK (scope_kind IN ('COMPANY','PERSON')),
  contact_id uuid,
  channel text NOT NULL CHECK (channel IN ('EMAIL','PHONE','LINKEDIN')),
  raw_value text NOT NULL CHECK (btrim(raw_value) <> ''),
  normalized_value text NOT NULL CHECK (btrim(normalized_value) <> ''),
  source_evidence_id uuid,
  is_publicly_listed boolean NOT NULL DEFAULT false,
  email_syntax_status text,
  email_mx_status text,
  email_deliverability_status text,
  phone_format_status text,
  phone_activity_status text,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, company_id),
  FOREIGN KEY (contact_id, company_id) REFERENCES lead_intel.contacts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_evidence_id, company_id) REFERENCES lead_intel.source_evidence(id, company_id) ON DELETE RESTRICT,
  CHECK ((scope_kind = 'COMPANY' AND contact_id IS NULL) OR (scope_kind = 'PERSON' AND contact_id IS NOT NULL)),
  CHECK (NOT is_publicly_listed OR source_evidence_id IS NOT NULL),
  CHECK (last_seen_at >= first_seen_at),
  CHECK (email_syntax_status IS NULL OR email_syntax_status IN ('UNVERIFIED','VALID_FORMAT','INVALID','UNKNOWN')),
  CHECK (email_mx_status IS NULL OR email_mx_status IN ('UNVERIFIED','NOT_CHECKED','MX_PRESENT','NO_MX','UNKNOWN')),
  CHECK (email_deliverability_status IS NULL OR email_deliverability_status IN ('UNVERIFIED','DELIVERABLE','UNDELIVERABLE','CATCH_ALL','INVALID','UNKNOWN')),
  CHECK (phone_format_status IS NULL OR phone_format_status IN ('UNVERIFIED','NOT_CHECKED','VALID_FORMAT','INVALID','UNKNOWN')),
  CHECK (phone_activity_status IS NULL OR phone_activity_status IN ('UNVERIFIED','ACTIVE','INACTIVE','INVALID','UNKNOWN')),
  CHECK ((channel = 'EMAIL' AND phone_format_status IS NULL AND phone_activity_status IS NULL AND email_syntax_status IS NOT NULL AND email_mx_status IS NOT NULL AND email_deliverability_status IS NOT NULL)
      OR (channel = 'PHONE' AND email_syntax_status IS NULL AND email_mx_status IS NULL AND email_deliverability_status IS NULL AND phone_format_status IS NOT NULL AND phone_activity_status IS NOT NULL)
      OR (channel = 'LINKEDIN' AND email_syntax_status IS NULL AND email_mx_status IS NULL AND email_deliverability_status IS NULL AND phone_format_status IS NULL AND phone_activity_status IS NULL))
);
CREATE INDEX contact_points_company_channel_idx ON lead_intel.contact_points (company_id, channel, scope_kind);
CREATE INDEX contact_points_normalized_lookup_idx ON lead_intel.contact_points (channel, normalized_value);
CREATE INDEX contact_points_person_idx ON lead_intel.contact_points (contact_id, channel) WHERE contact_id IS NOT NULL;
CREATE UNIQUE INDEX contact_points_company_dedupe_idx
  ON lead_intel.contact_points (company_id, channel, normalized_value) WHERE scope_kind = 'COMPANY';
CREATE UNIQUE INDEX contact_points_person_dedupe_idx
  ON lead_intel.contact_points (contact_id, channel, normalized_value) WHERE scope_kind = 'PERSON';
CREATE INDEX contact_points_due_email_verification_idx
  ON lead_intel.contact_points (last_seen_at, id)
  WHERE channel = 'EMAIL' AND email_deliverability_status IN ('UNVERIFIED','UNKNOWN');
CREATE INDEX contact_points_due_phone_verification_idx
  ON lead_intel.contact_points (last_seen_at, id)
  WHERE channel = 'PHONE' AND phone_activity_status IN ('UNVERIFIED','UNKNOWN');

CREATE TABLE lead_intel.verification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_point_id uuid NOT NULL REFERENCES lead_intel.contact_points(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('EMAIL','PHONE')),
  check_type text NOT NULL CHECK (check_type IN ('EMAIL_SYNTAX','EMAIL_MX','EMAIL_DELIVERABILITY','PHONE_FORMAT','PHONE_ACTIVITY')),
  verification_state text NOT NULL CHECK (verification_state IN ('UNVERIFIED','VERIFIED','INVALID','UNKNOWN')),
  normalized_result text NOT NULL,
  provider text NOT NULL CHECK (btrim(provider) <> ''),
  provider_result_code text,
  independent_verifier boolean NOT NULL DEFAULT false,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fresh_until timestamptz,
  confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  idempotency_key text,
  safe_details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (fresh_until IS NULL OR fresh_until >= checked_at),
  CHECK ((verification_state = 'UNVERIFIED' AND normalized_result = 'UNVERIFIED') OR
         (verification_state = 'UNKNOWN' AND normalized_result = 'UNKNOWN') OR
         (verification_state = 'INVALID' AND normalized_result = 'INVALID') OR
         (verification_state = 'VERIFIED' AND normalized_result NOT IN ('UNVERIFIED','UNKNOWN','INVALID'))),
  CHECK (
    (channel = 'EMAIL' AND check_type = 'EMAIL_SYNTAX' AND normalized_result IN ('VALID_FORMAT','INVALID','UNVERIFIED','UNKNOWN')) OR
    (channel = 'EMAIL' AND check_type = 'EMAIL_MX' AND normalized_result IN ('MX_PRESENT','NO_MX','UNVERIFIED','UNKNOWN')) OR
    (channel = 'EMAIL' AND check_type = 'EMAIL_DELIVERABILITY' AND normalized_result IN ('DELIVERABLE','UNDELIVERABLE','CATCH_ALL','INVALID','UNVERIFIED','UNKNOWN','RISKY')) OR
    (channel = 'PHONE' AND check_type = 'PHONE_FORMAT' AND normalized_result IN ('VALID_FORMAT','INVALID','UNVERIFIED','UNKNOWN')) OR
    (channel = 'PHONE' AND check_type = 'PHONE_ACTIVITY' AND normalized_result IN ('ACTIVE','INACTIVE','INVALID','UNVERIFIED','UNKNOWN','RISKY'))
  ),
  CHECK (check_type <> 'EMAIL_DELIVERABILITY' OR normalized_result NOT IN ('DELIVERABLE','UNDELIVERABLE','CATCH_ALL','RISKY') OR independent_verifier),
  CHECK (check_type <> 'PHONE_ACTIVITY' OR normalized_result NOT IN ('ACTIVE','INACTIVE','RISKY') OR independent_verifier),
  UNIQUE (provider, idempotency_key)
);
CREATE INDEX verification_events_point_latest_idx ON lead_intel.verification_events (contact_point_id, check_type, checked_at DESC);
CREATE INDEX verification_events_freshness_idx ON lead_intel.verification_events (check_type, fresh_until) WHERE fresh_until IS NOT NULL;
CREATE INDEX verification_events_provider_idx ON lead_intel.verification_events (provider, checked_at DESC);

CREATE FUNCTION lead_intel.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, lead_intel AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION lead_intel.reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, lead_intel AS $$
BEGIN
  RAISE EXCEPTION 'Rows in %.% are append-only; insert a corrective event instead', TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER companies_touch_updated_at BEFORE UPDATE ON lead_intel.companies
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER company_locations_touch_updated_at BEFORE UPDATE ON lead_intel.company_locations
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER sources_touch_updated_at BEFORE UPDATE ON lead_intel.sources
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER company_identifiers_touch_updated_at BEFORE UPDATE ON lead_intel.company_identifiers
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER contacts_touch_updated_at BEFORE UPDATE ON lead_intel.contacts
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER contact_points_touch_updated_at BEFORE UPDATE ON lead_intel.contact_points
  FOR EACH ROW EXECUTE FUNCTION lead_intel.touch_updated_at();
CREATE TRIGGER source_evidence_append_only BEFORE UPDATE OR DELETE ON lead_intel.source_evidence
  FOR EACH ROW EXECUTE FUNCTION lead_intel.reject_audit_mutation();
CREATE TRIGGER verification_events_append_only BEFORE UPDATE OR DELETE ON lead_intel.verification_events
  FOR EACH ROW EXECUTE FUNCTION lead_intel.reject_audit_mutation();

ALTER TABLE lead_intel.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.company_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.company_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.source_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.contact_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.verification_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA lead_intel FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lead_intel FROM PUBLIC;

COMMIT;
