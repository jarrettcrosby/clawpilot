# Deployment

## Current Posture

ClawPilot now has a GitHub -> Vercel/Railway project workflow with Railway running the serverful app and Postgres-backed app state.

Current known platform gaps:

- GitHub branch protection on the private repo requires GitHub Pro or a public repo.
- Vercel deployment protection returns `401` for unauthenticated direct preview curls.
- Runtime data remains present in legacy local git history, but the GitHub repo was created from a clean import.
- Execution JSONL routes and pipeline projection/outbox writes still need Postgres repository adapters.

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
- initial 4002 dev-lane import: 43 tasks, 2 assignments, 13 threads, 26 messages

Before broader production use:

- configure auth/secrets management
- configure Railway Postgres backup/export policy
- add deployed-runtime smoke checks for Postgres-backed reads/writes

Google Sheets remains the operator-owned writable table for pipeline data. Postgres stores app-owned objects, sync bookkeeping, and pipeline projections. See `docs/architecture/data-ownership-and-postgres-plan.md`.

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
