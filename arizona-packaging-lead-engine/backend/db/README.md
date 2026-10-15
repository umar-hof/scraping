# Offline PostgreSQL schema foundation

This schema and runner are local code artifacts only. They have **not** been applied to Supabase or any production database. No seed rows or credentials are included. The application schema is `lead_intel`, not `public`; keep it out of PostgREST's exposed-schema list.

## Versioned migrations

Apply migrations in ascending order, each `.up.sql` in its own transaction:

1. `migrations/001_core.up.sql` — companies, locations, company identifiers, sources, contacts, source evidence, contact points, verification events, audit triggers and initial RLS boundaries.
2. `migrations/002_operations.up.sql` — discovery coverage, jobs/run history, Sheets synchronization state/outbox, suppression and database queue/outbox lease functions.

Each migration contains `BEGIN`/`COMMIT`. `backend/src/migration-runner.js` maintains a checksum ledger in the private `lead_intel_migrations` schema, serializes application with a PostgreSQL advisory lock, rejects checksum drift and out-of-order migrations, and refuses untracked pre-existing `lead_intel` objects. It has no rollback command; recover from changes with forward migrations. No migration has been executed against PostgreSQL or Supabase.

Migration 003 is additive and creates the immutable import-snapshot and field-provenance tables described below. The new runner applies migrations 001 through 003 in order; existing Apps Script tables and the Google Sheet are not modified by these SQL migrations.

## Entity and identity model

- `companies` is the business identity; `company_locations` is one-to-many to represent headquarters, facilities, retail and mailing locations.
- `primary_domain` and `WEBSITE_DOMAIN` identifiers are indexed but intentionally **not globally unique**. The same domain may belong to more than one company.
- `company_identifiers` holds alternate names/domains, source IDs, state entity IDs and the existing Apps Script Lead ID. `APPS_SCRIPT_LEAD_ID` is unique within its namespace, but not treated as the internal company primary key.
- `contacts` represent people attached to a company. `contact_points.scope_kind` strictly separates `COMPANY` channels from `PERSON` channels. Company mailboxes/numbers do not become POC details by implication.
- `source_evidence` stores the source URL, source policy snapshot, evidence type, confidence and capture/review timestamps. It and `verification_events` are append-only through normal SQL operations; corrections should be new rows.

## Verification semantics

Contact point columns contain a current normalized state; `verification_events` is the append-only history with provider, provider result code, normalized result, checked time, freshness deadline, confidence and sanitized detail. Event-level `verification_state` distinguishes `UNVERIFIED`, `VERIFIED`, `INVALID`, and `UNKNOWN`; `VERIFIED` applies only to the specific `check_type` on that event, not to the entire contact. The channel-specific normalized result remains authoritative for what was actually checked. Status vocabularies deliberately separate:

- Email syntax: `UNVERIFIED`, `VALID_FORMAT`, `INVALID`, `UNKNOWN`.
- Email MX: `UNVERIFIED`, `NOT_CHECKED`, `MX_PRESENT`, `NO_MX`, `UNKNOWN`.
- Email deliverability: `UNVERIFIED`, `DELIVERABLE`, `UNDELIVERABLE`, `CATCH_ALL`, `INVALID`, `UNKNOWN` (history also permits `RISKY`).
- Phone format: `UNVERIFIED`, `NOT_CHECKED`, `VALID_FORMAT`, `INVALID`, `UNKNOWN`.
- Phone activity: `UNVERIFIED`, `ACTIVE`, `INACTIVE`, `INVALID`, `UNKNOWN` (history also permits `RISKY`).

Database checks prohibit setting deliverability or phone activity to affirmative provider results unless `independent_verifier` is true. Provider-native output remains separate in `provider_result_code`; do not collapse unfamiliar provider results into a positive normalized status. MX never implies deliverability. A listed phone never implies active status or person ownership.

## Coverage model

`discovery_coverage` tracks one `(source, Arizona geography, industry)` cell, cursor, attempt/progress counters, status, and next/last run timestamps. Geography types include state, county, city and ZIP. `COMPLETED_NO_RESULTS` means only that a particular permitted source/query returned no results at that time; it is not a claim of market completeness. Do not report 100% Arizona coverage based solely on attempted cells.

## Job queue and recovery

`jobs` is the durable queue; `job_runs` is one row per attempt. `claim_jobs()` claims eligible jobs in a transaction using `FOR UPDATE SKIP LOCKED`, assigns an expiring lease, increments attempts, and records a run. Expired leases can be reclaimed; exhausted work is dead-lettered. A worker must call `finish_job()` with its worker ID before lease expiry. Completion stores checkpoints; recoverable failures get exponential backoff with jitter (capped at one hour), and permanent/exhausted failures go to `DEAD_LETTER`.

Workers must be idempotent by `idempotency_key`. Checkpoint payloads should contain cursors/record IDs only, not credentials or unnecessary contact data. Error messages are expected to be sanitized before `finish_job()`.

## Google Sheets outbox

`sheet_sync_state` describes the existing destination and requires 42 columns. Its default is `PAUSED`; `claim_sheet_sync_outbox()` only returns work when the destination is explicitly `READY` or `SYNCING`. `sheet_sync_outbox` has a unique destination/Lead ID/projection version/row version key plus a 42-cell JSON array and payload hash. Enqueue an outbox item in the same database transaction as the projected data change. After a Sheets write, call `ack_sheet_sync_outbox()` to record the Lead ID, row number, version and hash. Failed items use `fail_sheet_sync_outbox()` for retry/dead-letter handling.

If a worker crashes after Google accepted a write but before acknowledgment, the same payload may be sent again. The future Sheets adapter must upsert/reconcile by the stable external Lead ID and hash, not blindly append; it must validate header order and preserve user-owned fields. Never assume a remembered row number remains stable after manual sorting. The database outbox makes delivery retryable; Google Sheets operations still require idempotent adapter logic.

## Access, RLS and exposure

All tables have RLS enabled and no policies or grants to `PUBLIC` are created. The tables live outside Supabase's default exposed `public` schema. Keep the schema out of the Supabase Data API exposed-schema list. A future runtime needs a dedicated non-owner role with only required schema/table/function privileges and explicit RLS policies; do not use a database owner or broad service-role credential as the application connection. Create/provision roles through the target environment's approved process, not in this portable schema migration.

Before any user-facing/API access, define tenancy/ownership columns and policies; these tables are currently single-workspace and have no `tenant_id`. RLS is not a substitute for least-privilege SQL grants. Test access as the actual runtime role, not as the migration owner (owners can bypass ordinary RLS unless forced).

## Index rationale and scale

Indexes support normalized domain/name lookup, external ID dedupe, company-to-contact/evidence joins, source/time evidence review, verification freshness queues, due discovery cells, queue claims/expired leases, run failure audit, and pending Sheets sync. There is no unique domain index and no globally unique email/phone index because shared domains and contacts are possible. Partial unique indexes prevent duplicate external IDs in their own namespace and duplicate same-scope contact points without merging across companies. Revisit indexes against production query plans as data grows; avoid indexes on high-churn columns without measurement.

## Rollback and data safety

Rollback in reverse order: run `002_operations.down.sql`, then `001_core.down.sql`, only against a disposable database or after an approved backup/restore plan. These down migrations drop tables/functions/schema and permanently destroy data in `lead_intel`; they are not safe production undo scripts. Prefer forward corrective migrations for production. A future runner must refuse to roll back if later versions remain applied and must record the rollback in its migration ledger.

The current migrations create no rows, import no Arizona seed companies, and do not alter Apps Script or Google Sheets.

## Disposable PostgreSQL integration tests

Offline schema tests inspect migration structure but do not parse or execute PostgreSQL. The optional `npm run test:postgres` command in `backend/` applies both up migrations, exercises constraints and queue/outbox behavior, performs a rollback, and drops its fixture database. It tests RLS using a temporary `NOLOGIN` role, then removes that role. Job concurrency is tested using two independent `psql` sessions and row-lock contention.

The harness accepts only `PGHOST=localhost`, `127.0.0.1`, or `::1` (and similarly restricted `PGHOSTADDR`). It refuses `DATABASE_URL`, `PGSERVICE`, and `PGSERVICEFILE`, never accepts a database name, creates a random `hof_leadintel_it_*` database using `template0`, and drops only that generated database in a `finally` cleanup. It disables SSL for that loopback session. A local PostgreSQL role with database-creation and role-creation privileges is required; its password may be supplied through `PGPASSWORD` but is never printed. Do not point this command at cloud or production infrastructure. The harness does not import project leads or contact any external services.

PowerShell setup after PostgreSQL is installed and its local service is running:

```powershell
$env:PGHOST = 'localhost'
$env:PGPORT = '5432'
$env:PGUSER = 'postgres'
```

If local password authentication is required, prefer a local `%APPDATA%\postgresql\pgpass.conf` entry and protect that file with user-only ACLs; alternatively set `PGPASSWORD` only in the current shell from a secure local secret source, never paste it into a command or commit it. Then run `npm run test:postgres` from `backend/`. A safe default is local `PGUSER=postgres`; the disposable database and temporary role are removed by the harness. If `psql` is not on `PATH`, set `PGTEST_PSQL` to the full path of the installed `psql.exe`.

The integration command was not run when no local PostgreSQL server/client was available. Creating/upgrading the schema on any persistent database is outside this test harness and requires a separate review.

## Supabase integration safety

Migration 003 adds `sheet_import_batches` and `sheet_import_rows` for immutable snapshots. Every imported row stores the exact 42-cell JSON array, original Lead ID, source row number, source spreadsheet ID and payload hash, preserving URLs and verification statuses without flattening or inventing data. Changed content for a known Lead ID is a review conflict, not an overwrite. `field_evidence` records the field key, company/person/contact-point relationship, source-evidence reference, timestamp and hash of the observed value; it does not duplicate contact values.

The migrations use standard PostgreSQL features available in Supabase Postgres (UUID/JSONB/timestamptz, UUID generation, partial indexes, triggers, RLS, PL/pgSQL and transactional DDL). This is a compatibility review only: no PostgreSQL parser/server or Supabase run has validated them. All application tables are in a non-public schema, with RLS enabled, no `PUBLIC` grants and no policies. Keep `lead_intel` and `lead_intel_migrations` out of the Supabase Data API exposed schemas; a future least-privilege runtime role and explicit access policies still need design and testing.

The Supabase driver configuration requires `SUPABASE_DB_HOST`, `SUPABASE_DB_PORT`, `SUPABASE_DB_NAME`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`, and `SUPABASE_ENVIRONMENT`. It accepts only a project-matched `db.<project-ref>.supabase.co` host or a `*.pooler.supabase.com` host and enforces TLS certificate validation. Use a direct connection where available, or Supavisor session mode on port 5432; transaction pooler mode is rejected because the migrator uses a session advisory lock. Supabase documents direct connections for migrations and session pooler as the IPv4 alternative. [Connection-mode guidance](https://supabase.com/docs/guides/database/connecting-to-postgres).

`node scripts/supabase.js health` issues a read-only query. `status` is read-only, and `bundle-hash` is offline. `migrate` has no rollback command. It requires an interactive exact project-ref confirmation even for a disposable target. Production also requires `--confirm-production` and `SUPABASE_DISPOSABLE_VALIDATED_SHA256` to match the exact current bundle, plus typing the exact target project ref. Set that validation hash only after the same bundle has run successfully in a dedicated disposable Supabase project. No database connection was attempted in this task because no Supabase credentials were provided.

Install the declared PostgreSQL driver from `backend/` with `npm install`. Keep `.env` out of version control and provide passwords via a secret manager. Never put Supabase passwords, service-role keys, Google access tokens or OAuth client secrets in source or logs.

For the read-only Sheets adapter, set `GOOGLE_SPREADSHEET_ID` to the existing spreadsheet ID and `GOOGLE_SHEETS_ACCESS_TOKEN` to a short-lived bearer token authorized with only `https://www.googleapis.com/auth/spreadsheets.readonly`. Use OAuth access already approved for the user or a dedicated OAuth client; do not broaden to write scopes for preview. `npm run preview:sheets` reads tab metadata first and then only the bounded Prospects value range. The optional writer requires an independently issued write-capable token, a fresh unchanged preview, `confirmWrite: true`, and the exact plan hash; it was not executed. Google Sheets does not enforce unique Lead IDs across concurrent writers, so a future worker must serialize sync per spreadsheet/Lead ID using a single queue claim path and re-read before retrying ambiguous append failures.
