# HOF Pack backend foundation (Steps 26–27)

This directory contains backend adapters and Supabase migration tooling. No Supabase connection, Google Sheets write, Railway deployment, automated discovery, external verification, or outreach was performed in this task.

## Structure

- `src/prospects-contract.js` contains the backend's frozen 42-column header snapshot and the pure normalized-record-to-row mapper.
- `db/migrations/` contains versioned transactional SQL up/down migrations; see `db/README.md` for schema, security and rollback notes.
- `test/prospects-contract.test.js` compares that snapshot to `apps-script/Config.gs` and tests mapping behavior.
- `test/database-schema.test.js` performs offline structural checks on the schema and queue/outbox contracts; these are not PostgreSQL parser or server integration tests.
- `test/postgres-integration.js` plus `postgres-*.integration.sql` provide an optional local-only integration harness. It uses a random disposable database, refuses non-loopback configuration, checks migrations/constraints/locking/RLS/outbox/rollback, and removes its database and temporary role.
- `package.json` provides offline and optional PostgreSQL test commands plus the `pg` driver used only by explicitly invoked cloud commands. The driver is loaded lazily, so offline tests do not require a database connection.

`apps-script/Config.gs` remains the schema source of truth. The backend copy is intentionally checked against it by test so schema drift is caught before integration. The first 26 headers stay in their existing positions; the 16 verification headers follow them exactly.

## Contract

Call `toProspectsRow(record)` with a plain object using the camelCase fields in `FIELD_TO_HEADER`. `companyName` and `leadId` are required. Omitted, `null`, and `undefined` optional fields map to blank cells. Strings, finite numbers, booleans, valid `Date` instances, and blank values are accepted. Unknown fields and objects/arrays as cell values throw errors instead of being silently dropped.

Company channels (`companyEmail`, `companyContactNumber`) and direct-person channels (`pocEmailId`, `pocContactNumber`) have distinct explicit mappings. This mapper performs no research, normalization, verification, defaulting, deduplication, or inference; it preserves supplied values and does not invent missing information.

## Test

From this directory, run:

```text
npm test
```

From the project root, run the existing suite with `npm test`, then the backend contract/schema suite with `npm --prefix backend test`.

Real PostgreSQL tests require an already-installed local PostgreSQL server, `psql`, and a local role allowed to create databases and temporary roles. Configure `PGHOST=localhost`, `PGUSER`, and optionally `PGPORT`/`PGPASSWORD` or a protected local `pgpass.conf`, then run `npm run test:postgres` from this directory. Full safety details and the unavailability limitation are in `db/README.md`. No live/cloud database is accepted.

## Future integration boundary

Later, a Supabase repository can persist normalized companies, contacts, evidence, verification events and jobs using the migrations under `db/migrations/`. A separate Google Sheets adapter can use this contract to build the existing Prospects projection and sync by the namespaced external Lead ID. That adapter should use the database outbox and explicit column-ownership rules. No database, credentials, cloud service, schedule, seed import, or live-sheet write is configured in this step.

## Step 29 implementation

- `src/supabase-config.js` validates Supabase endpoint/project configuration and enforces TLS certificate validation.
- `src/migration-runner.js` provides a read-only health/status path and checksum-ledger migration runner, guarded by advisory locking and project confirmation. It has no down-migration command.
- `src/sheets-import.js` reads only the existing Prospects tab through the Google Sheets read-only API, validates the exact 42-header contract, and builds an idempotent reconciliation preview. Snapshot persistence requires approval of the exact plan hash.
- `src/quality.js` normalizes names/domains and phone format, conservatively checks Arizona/product/ICP evidence, flags conflicting/unverified fields and creates field-level provenance hashes.
- `src/sdr-batching.js` builds three offline preview batches from existing rows, deduplicates formatted numbers, honors suppression inputs, excludes invalid/unqualified rows and reports shortages. It never sends outreach.
- `src/sheets-sync.js` creates a dry-run Lead ID sync plan, requires an explicit managed-column allowlist, fills blank cells only, preserves nonblank cells and includes stable idempotency hashes, checkpoints and retry logging. The optional writer requires an explicit plan hash and confirmation, re-reads the live sheet before writing, and verifies the result; it was not called.
- `scripts/supabase.js` provides `health`, `status`, `bundle-hash` and explicitly confirmed `migrate` commands.
- `scripts/preview-sheets.js` emits aggregate-only read results and optionally compares against existing snapshot rows using SELECT only.

See `db/README.md` for disposable-first Supabase setup, OAuth read-only access, schema security, migration protections and unresolved integration validation. `npm run preview:sheets` requires `GOOGLE_SPREADSHEET_ID` plus a short-lived token authorized only for `https://www.googleapis.com/auth/spreadsheets.readonly`; no token is logged. `npm run test:postgres` remains optional and was not run. No company records have been imported into Supabase, no live Sheet cells changed, and no Railway worker was deployed. The CLI loads a local `.env` when present; existing process environment variables take precedence.

## Railway automation foundation (implementation only)

`worker.js` adds a Railway-compatible Node process with `/healthz` and Prometheus-compatible `/metrics`. It stays paused unless `WORKER_START_ENABLED=true`; dry-run defaults true. Dry-run only SELECTs eligible jobs and never leases, completes, or mutates them. Non-dry-run claiming uses a job-type allowlist with PostgreSQL `FOR UPDATE SKIP LOCKED`, lease expiry, attempt history, checkpoints, retry/dead-letter handling through `finish_job()`, bounded concurrency, per-type pacing and graceful SIGTERM/SIGINT draining.

Existing-record enrichment accepts source-evidence proposals only for company UUIDs already in the database. It never inserts companies or directly changes company/contact values; high-confidence supported evidence is append-only, and ambiguous/missing evidence becomes a deduplicated manual-review job. This is a pipeline interface, not an active web researcher: no source crawling or requests are implemented. Discovery has no handler and is excluded by default. Verification adapters are disabled by default and require both worker and provider flags plus a positive cost cap; only independent provider outcomes may become ACTIVE/DELIVERABLE. The Sheets helper validates the 42-cell row and Lead ID, provides a select-only preview, and can use the existing outbox claim/ack/retry functions only through an explicitly injected approved adapter. No writer adapter is configured.

See [`docs/worker-operations.md`](docs/worker-operations.md) for Railway variables, test-first activation order and current blockers. The Railway service was not deployed. A scoped read-only worker-role policy was installed and smoke-tested in the disposable Supabase project only; no data rows were written, and no Sheet write, discovery, or paid verification was performed.
