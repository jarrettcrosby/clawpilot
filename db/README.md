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

The first app areas to move are task persistence and agent thread persistence. The migration keeps compatibility payloads in `jsonb` while adding extracted columns for durable querying.
