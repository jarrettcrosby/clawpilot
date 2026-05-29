# Deployment

## Current Posture

ClawPilot is now shaped for a GitHub -> Vercel/Railway project workflow, but publishing is intentionally not complete in this pass.

Current blockers before first remote push/deploy:

- GitHub CLI token on this Mac is invalid and needs `gh auth login`.
- Railway CLI token is invalid and needs `railway login`.
- Vercel CLI is not installed, although GitHub-connected Vercel can still be configured from the Vercel dashboard.
- Runtime data is still present in legacy local git history.
- Railway Postgres is selected as the durable cloud target, but only the first migration/refactor slice is in place.

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

Before production Railway use:

- provision a Postgres service
- set `DATABASE_URL`
- set `CLAWPILOT_STORAGE=postgres` only after migrations pass
- run `npm run db:migrate`
- run `npm run db:import:tasks` and `npm run db:import:threads` for the initial app-state seed
- configure auth/secrets management
- configure backup policy

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
