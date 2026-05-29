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
- Wired the first app-owned repository boundary into:
  - `app_src/app/api/tasks/route.ts`
  - `app_src/app/api/agents/assignments/route.ts`
  - `app_src/app/api/agents/threads/route.ts`
- Added persistence health endpoint:
  - `GET /api/persistence/status`

## Architecture Position

Google Sheets remains the writable operator table for pipeline rows, interactions, and dropdowns. Railway Postgres owns app-native state such as tasks, assignments, threads, execution logs, audit events, sync jobs, and pipeline projections.

The first runtime slice is intentionally conservative: file mode still behaves as before, and Postgres mode is opt-in through environment variables.

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
  - `schema_migrations`: 1
  - `tasks`: 43
  - `agent_assignments`: 2
  - `agent_threads`: 13
  - `agent_thread_messages`: 26
- Live Railway app validation:
  - `/api/persistence/status`: `driver: postgres`, `database: reachable`
  - `/api/tasks`: returned 11 visible active tasks from the imported task set
  - `/api/agents/threads`: returned 13 threads

## Not Done

- Execution JSONL routes still need repository adapters.
- Pipeline remains file-cache plus Maton/Sheets writeback; the Postgres projection/outbox worker is planned but not implemented yet.
- Railway Postgres backup/export policy still needs to be documented.
- Vercel deployment protection still blocks unauthenticated public curl checks.

## Next Slice

1. Add repository adapters for execution runs/results.
2. Add sync outbox tables to the pipeline writeback path.
3. Add Railway Postgres backup/export runbook.
4. Add a focused deployed-runtime smoke check for Postgres-backed task and thread reads.
