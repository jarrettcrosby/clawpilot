# Deployment

## Current Posture

ClawPilot now has a GitHub -> Vercel/Railway project workflow with Railway running the serverful app and Postgres-backed app state.

Current known platform notes:

- GitHub branch protection on the private repo requires GitHub Pro or a public repo, but it is not required while this remains a private single-operator repository.
- Vercel deployment protection returns `401` for unauthenticated direct preview curls, which is acceptable for private previews. Use authenticated `vercel curl` for checks.
- Runtime data remains present in legacy local git history, but the GitHub repo was created from a clean import.
- Execution runs/results, pipeline projections, dropdown cache, and the Sheet sync outbox have Postgres repository adapters behind `CLAWPILOT_STORAGE=postgres`.

## GitHub Setup

Recommended first remote:

- Private repository.
- Default branch: `main`.
- Development branch: `dev`.
- Protected `main` with required CI.
- Pull requests from `dev` or feature branches.

Local baseline refs created:

- `dev` at the current `4002` baseline.
- `stable/4001` at the current `4001` baseline.
- `dev-4002-baseline-2026-05-29`.
- `prod-4001-baseline-2026-05-29`.

## CI

GitHub Actions workflow:

- `.github/workflows/ci.yml`

Checks:

- install dependencies from `app_src/package-lock.json`
- lint
- build
- thread-store test
- predeploy verification

The full runtime regression gate remains local for now because it requires the local `4002` runtime and local data paths.

## Vercel

Vercel is connected to GitHub with project Root Directory set to `app_src`.
Root `vercel.json` documents the build behavior relative to that Vercel root:
`npm ci`, `npm run build`, and output directory `.next`.

Use Vercel for:

- web preview checks
- production web build once data writes are externalized or constrained

Do not rely on Vercel for durable file-backed writes.

## Railway

Root `railway.json` provides a service definition for a long-running Node runtime.

Use Railway for:

- serverful app runtime experiments
- healthchecked preview service
- durable app-owned state through Railway Postgres

Current Railway production setup:

- project: `clawpilot`
- app service: `clawpilot`
- database service: `Postgres`
- app URL: `https://clawpilot-production-52a1.up.railway.app`
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `PGSSLMODE=require`
- `CLAWPILOT_STORAGE=postgres`
- `CLAWPILOT_DB_FALLBACK_TO_FILE=false`
- `APP_AUTH_REQUIRED=1`
- `APP_LOGIN_EMAIL=<approved operator email>`
- `APP_LOGIN_PASSWORD=<secret>`
- `APP_SESSION_SECRET=<secret>`
- `MATON_API_KEY=<secret>`
- `MATON_GMAIL_CONNECTION_ID=<active Google Mail connection id>`
- `PIPELINE_SHEET_ID=<environment-specific Sheet id>`
- `PIPELINE_OUTBOX_WORKER_SECRET=<secret>`
- `CLAWPILOT_EXECUTION_ENABLED=0`
- `CLAWPILOT_AGENT_PROVIDER=openai` when hosted agent execution is enabled
- `OPENAI_API_KEY=<server API key>` when hosted agent execution is enabled
- `OPENAI_AGENT_MODEL=gpt-5-mini` (or another approved Responses API model)

Railway applies pending SQL migrations as a pre-deploy command, then starts the Next.js app and the pipeline outbox poller together. The worker uses leased `sync_outbox` rows with retries and dead-letter handling.
- initial 4002 dev-lane import: 43 tasks, 2 assignments, 13 threads, 26 messages

The primary hosted sign-in sends a six-digit, 15-minute code to `APP_LOGIN_EMAIL` through the configured Maton Google Mail connection. Challenges are HMAC-protected, attempt-limited, single-use Postgres records. `APP_LOGIN_PASSWORD` remains an emergency operator fallback and should stay synchronized with the local Keychain entry.

Hosted OpenClaw CLI execution remains disabled with `CLAWPILOT_EXECUTION_ENABLED=0`; Railway containers do not carry the operator's local OpenClaw installation. Agent threads use the OpenAI Responses API only when `CLAWPILOT_AGENT_PROVIDER=openai` and a valid server-side `OPENAI_API_KEY` are configured. Without a provider, the Agents screen reports `not connected` and does not create synthetic replies.

Operational requirements:

- enable Railway Postgres daily/weekly backup schedules described in `docs/operations/railway-postgres-backups.md`
- run the authenticated deployed smoke gate after every deployment

Google Sheets remains the operator-owned writable table for pipeline data. Postgres stores app-owned objects, sync bookkeeping, and pipeline projections. See `docs/architecture/data-ownership-and-postgres-plan.md`.

Use the read-only deployed smoke gate after each deployment:

```bash
CLAWPILOT_BASE_URL=https://clawpilot-production-52a1.up.railway.app \
CLAWPILOT_EXPECT_STORAGE=postgres \
CLAWPILOT_EXPECT_PIPELINE=1 \
CLAWPILOT_EXPECT_BRANCH=main \
CLAWPILOT_EXPECT_ENVIRONMENT=production \
npm run verify:deployed
```

## Release Gate

Before promoting any candidate:

```bash
npm run lint
npm run build
npm run test
npm run verify:dev
npm run verify:regression
npm run verify:predeploy
```

For stable/prod rollout, continue to follow:

- `docs/operations/promotion.md`
- `docs/operations/FINAL_PRODUCTION_GATE.md`
- `docs/operations/PRODUCTION_ROLLOUT_FIRST24H.md`
