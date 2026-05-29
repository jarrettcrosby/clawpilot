# ClawPilot

ClawPilot is Jarrett's local command center for coordinating tasks, agent work, pipeline activity, docs, and operating reviews.

The web application lives in `app_src/` and is built with Next.js, React, TypeScript, and MUI. The surrounding repository contains runtime scripts, promotion gates, operations docs, and local file-backed data paths.

## Current Environment Model

| Purpose | Branch | Worktree | Port | Notes |
|---|---|---|---|---|
| Active ClawPilot project | `dev` | `/Users/agentsuburbiasandwich/Desktop/clawpilot` | `4002` | Default folder for Codex and developer work |
| Legacy dev source reference | local only | `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev` | `4002` | Historical OpenClaw lane. Read-only unless explicitly needed |
| Legacy stable/prod source reference | `stable/4001` | `/Users/agentsuburbiasandwich/Desktop/clawd-app` | `4001` | Protected. Do not mutate without explicit approval |

Baseline tags:

- `dev-4002-baseline-2026-05-29`
- `prod-4001-baseline-2026-05-29`

## Quick Start

Install dependencies:

```bash
npm --prefix app_src install
```

Start the isolated dev runtime:

```bash
bash scripts/dev-start.sh
```

Check dev runtime status:

```bash
bash scripts/dev-status.sh
```

Open:

```text
http://127.0.0.1:4002
```

## Validation

Use these checks before reporting a slice complete:

```bash
npm run lint
npm run build
npm run test
npm run verify:dev
```

Use the full local gate before promotion or any GitHub push candidate:

```bash
npm run verify:regression
```

CI-safe predeploy verification:

```bash
npm run verify:predeploy
```

Run Railway Postgres migrations after `DATABASE_URL` is configured:

```bash
npm run db:migrate
npm run db:import:tasks
npm run db:import:threads
```

## Repository Map

- `app_src/` - Next.js application, API routes, components, and shared libraries.
- `scripts/` - runtime, verification, promotion, watchdog, and backup scripts.
- `docs/architecture/` - system and code architecture notes.
- `docs/operations/` - environment, deployment, promotion, and baseline notes.
- `db/` - Railway Postgres migrations and database notes.
- `deployment/` - reusable OpenClaw deployment template.
- `data/` and `data-dev/` - local runtime data. Treat as sensitive runtime state, not portable source code.

## Data Safety

Do not push live data, backups, logs, customer/pipeline exports, or generated agent state to GitHub.

The current local history contains legacy tracked data. Before publishing to GitHub, use a private repository and either sanitize history or create a clean import that includes code, docs, scripts, config, and safe fixtures only.

## Related Docs

- [Contributing](CONTRIBUTING.md)
- [System overview](docs/architecture/system-overview.md)
- [Data ownership and Postgres plan](docs/architecture/data-ownership-and-postgres-plan.md)
- [Environments](docs/operations/environments.md)
- [Deployment](docs/operations/deployment.md)
- [Codex baseline](docs/operations/codex-baseline-2026-05-28.md)
