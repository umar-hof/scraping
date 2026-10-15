# Railway worker operations and activation checklist

## Current behavior

- `npm run worker` starts the health server. It remains paused unless `WORKER_START_ENABLED=true`.
- `WORKER_DRY_RUN` defaults true. In that mode the worker previews typed jobs using SELECT only: it does not lease, complete, or write any database rows.
- The disposable role setup creates `hof_railway_worker` as a NOLOGIN privilege role and adds one narrow SELECT policy for `RECONCILIATION`/`MANUAL_REVIEW` preview rows. It can read only selected queue metadata columns, not payloads; it has no DML or claim-function execution. The runtime LOGIN credential is intentionally not generated or exposed here.
- Discovery is not implemented and is excluded from the default job type list. A cleanup/enrichment worker can only claim its configured job types.
- Enrichment only processes evidence proposals for existing company IDs; no company creation and no direct business/contact field updates. Conflicts or weak sourcing route to manual review.
- Verification has no configured vendor adapter and defaults disabled. Provider results require independent verification to claim `DELIVERABLE`/`ACTIVE`; a USD cost cap is mandatory.
- Sheets outbox dry-run is SELECT-only. A write adapter is deliberately not included. Any future adapter must use the existing Lead ID reconciliation and blank-only approved writer, verify accepted writes by re-read, then acknowledge the outbox; uncertain outcomes must reconcile by Lead ID before retry.
- The existing suppression/verification checks in `src/sdr-batching.js` remain prerequisites; this worker has no call, email, SMS, or outreach code.

## Railway environment variable checklist

Store database/provider/Google credentials only in Railway's encrypted Variables. Never paste them into chat, commit them, or log them.

1. Runtime database: `SUPABASE_ENVIRONMENT`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_HOST`, `SUPABASE_DB_PORT`, `SUPABASE_DB_NAME`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD`, `SUPABASE_DB_SSL_CA_FILE`. Set the CA path to `/app/certs/supabase-ca.crt`; the certificate is packaged in the backend image (not a volume), validated at startup, and used with certificate/hostname validation. Use a dedicated least-privilege runtime login role (not the database owner or a service-role key).
2. Process: `PORT` (Railway supplies this), `WORKER_START_ENABLED`, `WORKER_ID`, `WORKER_JOB_TYPES`, `WORKER_CONCURRENCY`, `WORKER_LEASE_SECONDS`, `WORKER_POLL_MS`, `WORKER_DRY_RUN`, and `WORKER_RATE_<JOB_TYPE>_MS`.
3. Explicit gates: `DISCOVERY_ENABLED`, `ENRICHMENT_ENABLED`, `VERIFICATION_ENABLED`, `SHEETS_SYNC_ENABLED` (and the `WORKER_*_ENABLED` compatibility aliases), plus `SHEETS_WRITE_APPROVED`/`SHEETS_SYNC_WRITE_APPROVED` (both remain false until separate approval).
4. Verification only after vendor and policy approval: `VERIFICATION_PROVIDER_ENABLED`, `VERIFICATION_MAX_COST_USD`, `VERIFICATION_COST_PER_CHECK_USD`, plus provider-specific API credentials. Adapters are not yet implemented/configured. The implemented budget counter is per process; a shared hard cap across replicas must be added before scaling verification workers.
5. Google Sheets only after separately approved write testing: existing spreadsheet ID, narrowly scoped service-account/OAuth credentials, and `SHEETS_SYNC_WRITE_APPROVED`. The actual Google adapter is not yet implemented/configured.

## Safe deployment sequence (not yet performed)

1. Create/select an explicitly disposable Railway test service. Set service root directory `/backend` and config-as-code path `/backend/railway.json`; Railway docs specify the config-file path separately from the root directory. `railway.json` runs `npm ci` and `npm run worker`, binds injected `PORT` on `0.0.0.0`, health-checks `/healthz`, and has no cron schedule. Railway currently documents Config-as-Code as deprecated after 2026-12-01, so use equivalent service UI/IaC settings for longer-term deployment.
2. Begin with `WORKER_START_ENABLED=false`; confirm service health and that no DB connection or job mutation occurs.
3. Point only to the dedicated disposable Supabase project using the runtime role. Enable the worker with dry-run true and all job flags false; verify `/metrics`, safe logs, and database read-only behavior.
4. Implement and test the missing source, Google, and verification adapters against isolated test data. Validate outbox uncertainty recovery and user-owned field preservation before considering writes.
5. Request separate approval before enabling any write, discovery, paid verification, or production DB connection. Never combine these approvals implicitly.

## Current blockers

- No source registry/access-policy review or source adapters for automated enrichment/discovery.
- No real Google Sheets Railway authentication/write adapter; existing sync planner/writer is designed for explicit plan approval and short-lived authorization.
- No approved email/phone provider, credentials, cost policy, or integration tests.
- `hof_railway_worker` is a NOLOGIN privilege role validated through `SET ROLE`; no Railway LOGIN role/password exists yet. The project owner must provision the login role and save its password directly in Railway Variables. The group has only column-level SELECT on queue preview fields and an RLS policy limited to `RECONCILIATION`/`MANUAL_REVIEW`; no claim/write functions or payload access.
- No Railway service, environment, schedule, production approvals, or continuous job monitoring configured.
- The SDR planner remains blocked absent a complete authoritative suppression snapshot and independent verification policy.
