BEGIN;

-- Immutable source snapshot: keeps the exact existing 42-cell row and all
-- source/evidence strings without prematurely flattening contact ownership.
CREATE TABLE lead_intel.sheet_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_spreadsheet_id text NOT NULL CHECK (btrim(source_spreadsheet_id) <> ''),
  source_tab_name text NOT NULL DEFAULT 'Prospects' CHECK (source_tab_name = 'Prospects'),
  import_key char(64) NOT NULL UNIQUE CHECK (import_key ~ '^[0-9a-f]{64}$'),
  header_sha256 char(64) NOT NULL CHECK (header_sha256 ~ '^[0-9a-f]{64}$'),
  source_row_count integer NOT NULL CHECK (source_row_count >= 0),
  read_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, source_spreadsheet_id)
);

CREATE TABLE lead_intel.sheet_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES lead_intel.sheet_import_batches(id) ON DELETE RESTRICT,
  source_spreadsheet_id text NOT NULL,
  source_row_number integer NOT NULL CHECK (source_row_number >= 2),
  lead_id text NOT NULL CHECK (btrim(lead_id) <> ''),
  schema_version integer NOT NULL DEFAULT 42 CHECK (schema_version = 42),
  row_payload jsonb NOT NULL CHECK (jsonb_typeof(row_payload) = 'array' AND jsonb_array_length(row_payload) = 42),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  review_status text NOT NULL DEFAULT 'IMPORTED_SNAPSHOT'
    CHECK (review_status IN ('IMPORTED_SNAPSHOT','NEEDS_REVIEW','PROMOTED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (batch_id, lead_id),
  FOREIGN KEY (batch_id, source_spreadsheet_id)
    REFERENCES lead_intel.sheet_import_batches(id, source_spreadsheet_id) ON DELETE RESTRICT,
  UNIQUE (source_spreadsheet_id, lead_id, payload_sha256),
  UNIQUE (batch_id, source_row_number)
);
CREATE INDEX sheet_import_rows_lead_idx ON lead_intel.sheet_import_rows (lead_id, created_at DESC);
CREATE INDEX sheet_import_rows_review_idx ON lead_intel.sheet_import_rows (review_status, created_at);
CREATE INDEX sheet_import_rows_batch_idx ON lead_intel.sheet_import_rows (batch_id, source_row_number);

-- Field-level provenance points to an append-only source_evidence record.
-- Values themselves are not copied here: only a hash and field identifier.
CREATE TABLE lead_intel.field_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES lead_intel.companies(id) ON DELETE RESTRICT,
  contact_id uuid,
  contact_point_id uuid,
  field_key text NOT NULL CHECK (btrim(field_key) <> ''),
  source_evidence_id uuid NOT NULL,
  observed_value_sha256 char(64) NOT NULL CHECK (observed_value_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  observed_at timestamptz NOT NULL,
  confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (source_evidence_id, company_id)
    REFERENCES lead_intel.source_evidence(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (contact_id, company_id)
    REFERENCES lead_intel.contacts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (contact_point_id, company_id)
    REFERENCES lead_intel.contact_points(id, company_id) ON DELETE RESTRICT,
  CHECK (contact_id IS NULL OR contact_point_id IS NULL)
);
CREATE INDEX field_evidence_company_field_idx ON lead_intel.field_evidence (company_id, field_key, observed_at DESC);
CREATE INDEX field_evidence_source_idx ON lead_intel.field_evidence (source_evidence_id, observed_at DESC);
CREATE INDEX field_evidence_contact_idx ON lead_intel.field_evidence (contact_id, field_key, observed_at DESC)
  WHERE contact_id IS NOT NULL;
CREATE INDEX field_evidence_point_idx ON lead_intel.field_evidence (contact_point_id, field_key, observed_at DESC)
  WHERE contact_point_id IS NOT NULL;

CREATE TRIGGER field_evidence_append_only BEFORE UPDATE OR DELETE ON lead_intel.field_evidence
  FOR EACH ROW EXECUTE FUNCTION lead_intel.reject_audit_mutation();

ALTER TABLE lead_intel.sheet_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.sheet_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intel.field_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA lead_intel FROM PUBLIC;

COMMIT;
