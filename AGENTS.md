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
