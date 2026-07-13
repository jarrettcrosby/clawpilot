# Database

ClawPilot uses Railway Postgres for durable app-owned state. Google Sheets remains the operator-owned writable table for the pipeline workflow unless a later product decision changes that.

## Local Default

Local development continues to use the existing file-backed state unless explicitly configured:

```bash
CLAWPILOT_STORAGE=file
```

## Railway/Postgres Mode

Set:

```bash
DATABASE_URL=postgresql://...
CLAWPILOT_STORAGE=postgres
```

Then run migrations:

```bash
npm run db:migrate
```

Seed tasks from the current JSON lane:

```bash
npm run db:import:tasks
npm run db:import:threads
```

The first app areas moved are task persistence, agent thread persistence, execution run/result append logs, and the opportunity pipeline projection/outbox path. Migration `0002_pipeline_outbox_worker.sql` adds idempotency, worker leases, retry scheduling, and dead-letter support. Later migrations add multi-user access, encrypted per-user ChatGPT/Codex credentials, and user-scoped agent conversations. The migrations keep compatibility payloads in `jsonb` while adding extracted columns for durable querying.

Hosted ChatGPT credentials require a dedicated `AGENT_CREDENTIAL_ENCRYPTION_KEY` with at least 32 random characters. Tokens are encrypted before they are written to Postgres. Every invited ClawPilot user signs in with their own email and completes their own ChatGPT device authorization.

Pipeline ownership remains split: Google Sheets is still the writable operator table, while Postgres stores the app projection, dropdown cache, and sync outbox/audit rows. The Railway worker drains queued Sheet updates and retries failed operations.

See `docs/operations/railway-postgres-backups.md` for the backup and restore policy.
