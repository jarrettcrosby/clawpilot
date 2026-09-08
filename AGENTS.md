# ClawPilot Agent Guide

## Scope

Use `/Users/agentsuburbiasandwich/Desktop/clawpilot` as the canonical ClawPilot project folder.

Do not use Eigen Racing project assumptions, docs, ports, validation gates, or deployment settings for this repository. The old OpenClaw paths remain only as historical references and import sources:

- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev`
- `/Users/agentsuburbiasandwich/Desktop/clawd-app`

## Current Platform

- GitHub: `https://github.com/jarrettcrosby/clawpilot`
- Active branch: `dev`
- Main branch: `main`
- Stable reference branch: `stable/4001`
- Railway project: `clawpilot`
- Railway app service: `clawpilot`
- Railway database service: `Postgres`
- Vercel project: `clawpilot`

## Working Rules

- Keep runtime data, backups, logs, env files, and platform-local config out of Git.
- Treat Google Sheets as the writable operator table for pipeline data.
- Treat Railway Postgres as the durable store for app-owned objects.
- Use pull requests from `dev` to `main` for promotion.
- For private-project validation, GitHub CI plus Vercel protected previews are sufficient guardrails unless the operator asks for stricter branch protection.

## Local Development

- Start the local app from the repository root with `./scripts/dev-start.sh`.
- Do not use `npm run dev` for normal local validation. It omits the isolated data environment variables required by the dev runtime.
- The supported local URL is `http://localhost:4002`.
- For browser testing launched from a tool-managed shell, keep the startup shell alive for the duration of the test so the background app process is not cleaned up when the shell exits.
- `./scripts/dev-start.sh` and the root `build`/`test` lifecycles run a local disk preflight before expensive or mutating work. It fails below 15 GiB free and warns below 25 GiB; use `CLAWPILOT_MIN_FREE_GIB` and `CLAWPILOT_WARN_FREE_GIB` only for reviewed local overrides.
- Use `npm run storage:audit` for a read-only inventory. Its worktree, generated-artifact, npm-cache, and Docker allocation findings do not authorize deletion; never run broad prune or cache-cleaning commands automatically.
- Disposable PostgreSQL acceptance containers must pass both launch and forced-cleanup Docker arguments through `scripts/lib/disposable-postgres-docker.mjs`. The guard uses version-aware tmpfs storage, `--rm`, and volume-aware forced removal so image-declared anonymous volumes cannot accumulate; change `CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE` only for a reviewed test requirement.

## Validation

Before completing code changes, run the smallest relevant gate and record the result:

- `npm run lint`
- `npm run build`
- `npm run test`
- `npm run verify:predeploy`

For deployment-sensitive changes, also verify:

- Railway `/api/persistence/status`
- Railway `/api/health`
- Vercel preview status or authenticated `vercel curl`
