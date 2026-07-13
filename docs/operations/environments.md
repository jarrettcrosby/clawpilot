# Environments

## Local Dev

- Branch: `dev`
- Worktree: `/Users/agentsuburbiasandwich/Desktop/clawpilot`
- Port: `4002`
- Data root: `data-dev/`
- Start: `bash scripts/dev-start.sh`
- Status: `bash scripts/dev-status.sh`

Use this lane for all normal Codex and developer work.

`scripts/dev-start.sh` now runs directly from the canonical ClawPilot repository and seeds ignored `data-dev/` state once from the historical OpenClaw lanes when needed. The old `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev` checkout remains a read-only import source, not the active runtime.

## Local Stable / Prod

- Branch: `stable/4001`
- Worktree: `/Users/agentsuburbiasandwich/Desktop/clawd-app`
- Port: `4001`
- Data root: `data/`

This lane is protected. Do not mutate it without explicit operator approval.

## GitHub

Recommended setup:

- Repository visibility: private.
- Default branch after initial setup: `main`.
- Active development branch: `dev`.
- Protected branch: optional while the repository remains private and single-operator.
- Required checks: GitHub Actions `CI`.

Important: the legacy local git history contains tracked runtime data. Do not push this repository as-is to a shared remote unless the repository is private and the data exposure has been accepted. Best practice is a clean import containing source, docs, scripts, config, and safe fixtures only.

## Vercel

Vercel is connected to GitHub with project Root Directory set to `app_src`.
The root `vercel.json` intentionally uses commands relative to that Vercel root.

- Root directory: `app_src`
- Framework preset: Next.js
- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: `.next`

Vercel is suitable for web preview/build validation. Because the current app writes local files, production Vercel use should wait until durable state is moved out of the local filesystem or write paths are limited to read-only/demo behavior.

## Railway

Railway is configured from repository root via `railway.json`.

- Build command: `npm --prefix app_src install && npm run build`
- Start command: `npm run start:railway`
- Healthcheck: `/api/health`

Railway is the long-running serverful runtime. Railway Postgres is active for app-owned tasks, assignments, agent threads, execution logs, pipeline projections, dropdown cache, and the Google Sheets sync outbox. The Railway start command runs the app and an outbox poller in the same service.

Production and development use separate Railway environments, Postgres services/volumes, Google Sheets, auth secrets, and agent-provider secrets. Both set `CLAWPILOT_DB_FALLBACK_TO_FILE=false`; a database failure must be visible instead of creating ephemeral container state. Hosted OpenClaw CLI execution remains disabled with `CLAWPILOT_EXECUTION_ENABLED=0`. Hosted agent execution uses the OpenAI Responses API only when each environment has its own valid `OPENAI_API_KEY`; otherwise the UI reports that execution is not connected.

| Lane | Branch | Railway environment | Pipeline Sheet |
|---|---|---|---|
| Production | `main` | `production` | Existing operator production workbook |
| Development | `dev` | `development` | `ClawPilot Development Pipeline - Isolated` (`1VBF61ZtkgvKUp2-iIFUYeInrXqtXXx35Vc45tpuMG-E`) |

## Required Local Env

Use `.env.example` as the starting point. The important dev-lane variables are:

- `PORT=4002`
- `RUNTIME_LANE=dev`
- `RUNTIME_PORT=4002`
- `TASKS_PATH`
- `PIPELINE_NORMALIZED_PATH`
- `PIPELINE_LOG_PATH`
- `PIPELINE_DROPDOWN_CACHE_PATH`
- `AGENT_THREADS_PATH`
- `AGENT_ASSIGNMENTS_PATH`

The `scripts/dev-start.sh` path remains the canonical local dev startup because it sets lane-specific runtime isolation.

Railway Postgres mode also requires `PIPELINE_OUTBOX_WORKER_SECRET`. Pipeline Sheet pull/write operations require `MATON_API_KEY`.
