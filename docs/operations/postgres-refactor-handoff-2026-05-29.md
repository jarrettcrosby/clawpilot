# Postgres Refactor Handoff - 2026-05-29

## Objective

Move ClawPilot toward a best-in-class GitHub/Vercel/Railway project setup while preserving the existing Google Sheets pipeline workflow.

## Completed

- Documented the data ownership decision in `docs/architecture/data-ownership-and-postgres-plan.md`.
- Added Railway Postgres schema foundation in `db/migrations/0001_initial_railway_postgres.sql`.
- Added database docs in `db/README.md`.
- Added migration runner:
  - `npm run db:migrate`
  - `scripts/db-migrate.mjs`
- Added JSON task import runner:
  - `npm run db:import:tasks`
  - `scripts/db-import-tasks.mjs`
- Added JSON thread import runner:
  - `npm run db:import:threads`
  - `scripts/db-import-threads.mjs`
- Added optional runtime persistence config:
  - `CLAWPILOT_STORAGE=file` remains default.
  - `CLAWPILOT_STORAGE=postgres` activates only when `DATABASE_URL` is set.
- Added Postgres task persistence adapter:
  - `app_src/lib/persistence/config.ts`
  - `app_src/lib/persistence/postgres.ts`
  - `app_src/lib/persistence/tasks.ts`
- Added Postgres agent thread persistence adapter:
  - `app_src/lib/persistence/agentThreads.ts`
- Added Postgres execution run/result persistence adapter:
  - `app_src/lib/persistence/execution.ts`
- Added Postgres pipeline projection and sync outbox adapter:
  - `app_src/lib/persistence/pipeline.ts`
- Added a leased pipeline outbox worker with idempotency, retry backoff, stale-lease recovery, and dead-letter handling:
  - `app_src/lib/pipelineOutboxWorker.ts`
  - `app_src/app/api/pipeline/sync/outbox/process/route.ts`
  - `scripts/pipeline-outbox-poller.mjs`
  - `db/migrations/0002_pipeline_outbox_worker.sql`
- Replaced the request-path Python pipeline pull with a Railway-compatible TypeScript pull and durable Postgres projection:
  - `app_src/lib/pipelineSync.ts`
- Added Postgres dropdown catalog persistence and queued dropdown Sheet writes.
- Added a canonical ClawPilot dev launcher that runs from `/Users/agentsuburbiasandwich/Desktop/clawpilot` and only uses historical OpenClaw paths as one-time import sources.
- Added cloud-aware health, verified-session authentication, and a usable login page.
- Added read-only deployed smoke and database inspection commands:
  - `npm run verify:deployed`
  - `npm run db:inspect`
- Added Railway Postgres backup/export policy in `docs/operations/railway-postgres-backups.md`.
- Wired the first app-owned repository boundary into:
  - `app_src/app/api/tasks/route.ts`
  - `app_src/app/api/agents/assignments/route.ts`
  - `app_src/app/api/agents/threads/route.ts`
- Wired execution and pipeline repository boundaries into:
  - `app_src/lib/dispatchBridge.ts`
  - `app_src/app/api/auto-pickup/execute-once/route.ts`
  - `app_src/app/api/execution-runs/route.ts`
  - `app_src/app/api/execution-results/route.ts`
  - `app_src/app/api/execution-log-integrity/route.ts`
  - `app_src/app/api/pipeline/route.ts`
  - `app_src/app/api/pipeline/sync/pull/route.ts`
  - `app_src/app/api/pipeline/sync-status/route.ts`
  - `app_src/app/api/pipeline/opportunity/[id]/route.ts`
- Added adapter contract test:
  - `npm run test:persistence-contracts`
  - `scripts/test-postgres-adapter-contracts.mjs`
- Added persistence health endpoint:
  - `GET /api/persistence/status`

## Architecture Position

Google Sheets remains the writable operator table for pipeline rows, interactions, and dropdowns. Railway Postgres owns app-native state such as tasks, assignments, threads, execution logs, audit events, sync jobs, and pipeline projections.

The runtime slices remain conservative: file mode still behaves as before, and Postgres mode is opt-in through environment variables.

## Validation

- `npm run lint`: passed with 13 existing warnings and 0 errors.
- `npm run build`: passed.
- `npm run test`: passed.
- `node --check scripts/db-migrate.mjs`: passed.
- `node --check scripts/db-import-tasks.mjs`: passed.
- `node --check scripts/db-import-threads.mjs`: passed.
- `npm run verify:predeploy`: passed.
- Runtime API checks on temporary `4002` dev server:
  - `/api/persistence/status`: returned file-backed status.
  - `/api/tasks?includeArchived=true`: returned task array.
  - `/api/agents/assignments`: returned assignment projection.
  - `/api/agents/threads`: returned thread store.
- `npm run verify:dev`: passed with `VERIFY_OK`.
- `npm run verify:regression`: passed with `REGRESSION_ALL_OK`.
- `npm run check`: passed after the docs and scripts were added.
- Railway Postgres was provisioned after GitHub/Railway/Vercel setup:
  - project: `clawpilot`
  - app service: `clawpilot`
  - database service: `Postgres`
  - volume: `postgres-volume`, state `READY`
- Live Railway Postgres migration/import validation:
  - `schema_migrations`: 2
  - `tasks`: 43
  - `agent_assignments`: 2
  - `agent_threads`: 13
  - `agent_thread_messages`: 26
- Live Railway app validation:
  - `/api/persistence/status`: `driver: postgres`, `database: reachable`
  - `/api/tasks`: returned 11 visible active tasks from the imported task set
  - `/api/agents/threads`: returned 13 threads
- Execution/pipeline adapter slice validation:
  - `npm run lint`: passed with 12 existing warnings and 0 errors.
  - `npm run build`: passed.
  - `npm run test`: passed, including `PASS test-postgres-adapter-contracts`.
  - `npm run verify:predeploy`: passed.
- Outbox worker and projection validation on Railway Postgres:
  - `0002_pipeline_outbox_worker.sql` applied successfully.
  - 42 opportunities and 10 dropdown catalogs with 617 options persisted from Google Sheets.
  - A no-op opportunity update queued, was claimed by the worker, reached Google Sheets, and completed as `succeeded` with no pending row.
  - Postgres-mode deployed smoke passed for tasks, threads, execution summaries, pipeline projection, and sync diagnostics.
- Auth validation:
  - unauthenticated page requests redirect to `/login`.
  - protected APIs reject missing and invalid sessions with `401`.
  - authenticated file-mode smoke passed with the operator password.
  - desktop and mobile login layouts were visually checked.

## Current Rollout Work

1. Push the completed slice to `dev` and require green GitHub CI/Vercel preview checks.
2. Create an isolated Railway `development` environment and Postgres volume from the `dev` branch.
3. Promote `dev` to `main` and verify Railway production.
4. Attach `dev.aiapp.eigenracing.com` to development and `aiapp.eigenracing.com` to production.
5. Enable native Railway daily/weekly Postgres backup schedules in the dashboard.
