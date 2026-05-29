# Environments

## Local Dev

- Branch: `dev`
- Worktree: `/Users/agentsuburbiasandwich/Desktop/clawpilot`
- Port: `4002`
- Data root: `data-dev/`
- Start: `bash scripts/dev-start.sh`
- Status: `bash scripts/dev-status.sh`

Use this lane for all normal Codex and developer work.

The original OpenClaw dev lane remains at `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev` as a historical reference and data import source. Do not use it as the default Codex working folder.

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

Railway is the long-running serverful runtime. Railway Postgres is active for app-owned tasks, assignments, and agent threads.

## Required Local Env

Use `.env.example` as the starting point. The important dev-lane variables are:

- `PORT=4002`
- `RUNTIME_LANE=dev`
- `RUNTIME_PORT=4002`
- `TASKS_PATH`
- `PIPELINE_NORMALIZED_PATH`
- `PIPELINE_LOG_PATH`
- `AGENT_THREADS_PATH`
- `AGENT_ASSIGNMENTS_PATH`

The `scripts/dev-start.sh` path remains the canonical local dev startup because it sets lane-specific runtime isolation.
