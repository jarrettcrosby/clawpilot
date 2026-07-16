# Database

ClawPilot uses Railway Postgres for durable app-owned state. Google Sheets remains the operator-owned writable table for the pipeline workflow unless a later product decision changes that.

## Runtime Modes

Hosted development and production require Railway Postgres and fail closed rather than writing ephemeral container files:

```bash
CLAWPILOT_STORAGE=postgres
DATABASE_URL=postgresql://...
CLAWPILOT_DB_FALLBACK_TO_FILE=false
```

The canonical local `./scripts/dev-start.sh` path uses isolated file-backed compatibility state unless Postgres is explicitly configured:

```bash
CLAWPILOT_STORAGE=file
```

## Migrations

Migrations are append-only and run before the Railway application starts:

```bash
npm run db:migrate
```

Legacy import commands remain available for controlled one-time migrations:

```bash
npm run db:import:tasks
npm run db:import:threads
```

Postgres owns ClawPilot users and access, organizations, boards and tasks, CRM projections, short links, documents and releases, agent threads and execution evidence, pipeline definitions and projections, credentials metadata, outboxes, and audit events. Google Sheets remains the controlled writable Opportunities table, and SuiteCRM remains the native CRM projection.

Hosted ChatGPT credentials require a dedicated `AGENT_CREDENTIAL_ENCRYPTION_KEY` with at least 32 random characters. Tokens are encrypted before they are written to Postgres. Every invited ClawPilot user signs in with their own email and completes their own ChatGPT device authorization.

The Railway worker drains leased Google, CRM, agent, and document jobs with retries and dead-letter handling. Never edit a previously applied migration; add a new migration and validate development before production.

See [Railway Postgres backups](../docs/operations/railway-postgres-backups.md) for recovery policy and [Pipeline and synchronization](../docs/modules/pipeline-and-sync.md) for the Sheets/Postgres ownership boundary.
