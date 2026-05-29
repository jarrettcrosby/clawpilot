# GitHub, Railway, and Vercel Setup - 2026-05-29

## Current State

- GitHub repository: `https://github.com/jarrettcrosby/clawpilot`
- Visibility: private
- Default branch: `main`
- Development branch: `dev`
- Local stable branch: `stable/4001`
- Canonical local working copy: `/Users/agentsuburbiasandwich/Desktop/clawpilot`
- Compatibility symlink: `/Users/agentsuburbiasandwich/Desktop/clawpilot-clean-github` -> `/Users/agentsuburbiasandwich/Desktop/clawpilot`
- Original local dev lane remains at `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev`
- Original local prod lane remains at `/Users/agentsuburbiasandwich/Desktop/clawd-app`
- Railway project: `clawpilot`
- Railway app service: `clawpilot`
- Railway Postgres service: `Postgres`
- Railway app URL: `https://clawpilot-production-52a1.up.railway.app`
- Vercel project: `clawpilot`

The GitHub repository was created from a clean import so legacy tracked runtime data was not pushed. Only `data/README.md` and `data-dev/README.md` are included from runtime data directories.

## Completed

- Created a private GitHub repository.
- Pushed `main` from the clean 4002/dev code line.
- Pushed `dev` from the same clean 4002/dev code line.
- Pushed `stable/4001` from a sanitized 4001/prod source copy.
- Verified GitHub Actions CI passed on `main` and `dev`.
- Verified local clean import with `npm run check`.
- Linked Railway project and deployed the `clawpilot` service.
- Provisioned Railway Postgres with a ready `postgres-volume`.
- Applied `db/migrations/0001_initial_railway_postgres.sql`.
- Imported 4002 dev-lane app state:
  - 43 tasks
  - 2 projected assignments
  - 13 agent threads
  - 26 thread messages
- Set Railway app storage to `CLAWPILOT_STORAGE=postgres`.
- Verified live Railway `/api/persistence/status` returns `driver: postgres` and `database: reachable`.
- Connected Vercel to GitHub with Root Directory `app_src`; Vercel preview checks pass.

## Non-Blocking Private-Project Notes

- GitHub branch protection on this private repository returned:
  - `Upgrade to GitHub Pro or make this repository public to enable this feature.`
- This is not a blocker while the repository is private and single-operator. Keep PR discipline and green CI as the practical guardrail.
- Vercel direct public preview requests return `401` while deployment protection is enabled.
- This is not a blocker for private previews. Authenticated `vercel curl` works for validation.
- Railway database service is still named `Postgres`. That is functional. Rename to `clawpilot-postgres` only if the dashboard flow is available, then update `DATABASE_URL` from `${{Postgres.DATABASE_URL}}` to the new service reference.

## Recommended Setup Order

1. Keep the GitHub repository private.
2. Treat `dev` as the active development branch.
3. Treat `stable/4001` as the sanitized local-prod reference branch.
4. Use pull requests into `main` for promotion once branch protection is available.
5. Keep Railway as the writable serverful runtime while Postgres-backed state is expanded.
6. Keep Vercel for preview/build confidence until all durable writes are outside the Vercel filesystem.

## Railway Steps

Current Railway status can be checked from the clean working copy:

```bash
cd /Users/agentsuburbiasandwich/Desktop/clawpilot
railway status
railway service list
```

The app service should have these variables:

```text
CLAWPILOT_STORAGE=postgres
DATABASE_URL=${{Postgres.DATABASE_URL}}
PGSSLMODE=require
```

For one-time local migrations/imports against Railway Postgres, use the Postgres service public URL variable without printing it:

```bash
railway run --service Postgres --environment production -- sh -lc 'DATABASE_URL="$DATABASE_PUBLIC_URL" PGSSLMODE=require npm run db:migrate'
```

Expected smoke routes:

- `/api/health`
- `/api/persistence/status`
- `/api/tasks`
- `/api/agents/threads`

## Vercel Steps

Use the Vercel dashboard or install the CLI:

```bash
npm install -g vercel
vercel login
vercel link
```

Use GitHub import for:

- Repository: `jarrettcrosby/clawpilot`
- Production branch: `main`
- Root directory: `app_src`
- Framework preset: Next.js
- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: `.next`

Required environment variables should match Railway where applicable:

```text
CLAWPILOT_STORAGE=postgres
DATABASE_URL=<Railway Postgres DATABASE_URL>
APP_AUTH_REQUIRED=1
MATON_API_KEY=<configured secret if Sheets sync is enabled>
```

Do not use Vercel filesystem writes as durable storage.

## Post-Setup Validation

After Railway and Vercel are linked:

```bash
gh run list --repo jarrettcrosby/clawpilot --limit 10
npm run check
```

Validate deployed URLs:

- Railway `/api/health`
- Railway `/api/persistence/status`
- Vercel preview home route
- Vercel preview `/api/health`

## Next Implementation Slice

1. Add repository adapters for execution runs/results.
2. Add pipeline sync outbox and projection workers.
3. Add backup/export runbook for Railway Postgres.
4. Decide whether to rename the Railway database service from `Postgres` to `clawpilot-postgres` in the dashboard, then update the `DATABASE_URL` service reference if renamed.
