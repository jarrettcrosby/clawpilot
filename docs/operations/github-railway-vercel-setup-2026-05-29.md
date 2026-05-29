# GitHub, Railway, and Vercel Setup - 2026-05-29

## Current State

- GitHub repository: `https://github.com/jarrettcrosby/clawpilot`
- Visibility: private
- Default branch: `main`
- Development branch: `dev`
- Local stable branch: `stable/4001`
- Clean local working copy: `/Users/agentsuburbiasandwich/Desktop/clawpilot-clean-github`
- Original local dev lane remains at `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev`
- Original local prod lane remains at `/Users/agentsuburbiasandwich/Desktop/clawd-app`

The GitHub repository was created from a clean import so legacy tracked runtime data was not pushed. Only `data/README.md` and `data-dev/README.md` are included from runtime data directories.

## Completed

- Created a private GitHub repository.
- Pushed `main` from the clean 4002/dev code line.
- Pushed `dev` from the same clean 4002/dev code line.
- Pushed `stable/4001` from a sanitized 4001/prod source copy.
- Verified GitHub Actions CI passed on `main` and `dev`.
- Verified local clean import with `npm run check`.

## Blocked

- GitHub branch protection on a private repository returned:
  - `Upgrade to GitHub Pro or make this repository public to enable this feature.`
- Railway CLI is installed but the local token is expired:
  - run `railway login`
- Vercel CLI is not installed and no `VERCEL_TOKEN` is available.

## Recommended Setup Order

1. Keep the GitHub repository private.
2. Treat `dev` as the active development branch.
3. Treat `stable/4001` as the sanitized local-prod reference branch.
4. Use pull requests into `main` for promotion once branch protection is available.
5. Provision Railway Postgres before enabling `CLAWPILOT_STORAGE=postgres`.
6. Connect Vercel after GitHub is stable and the environment variables are ready.

## Railway Steps

Run these from the clean working copy:

```bash
cd /Users/agentsuburbiasandwich/Desktop/clawpilot-clean-github
railway login
railway init
railway add --database postgres
railway variable set CLAWPILOT_STORAGE=postgres
railway variable set APP_AUTH_REQUIRED=1
railway up
```

After Railway provides `DATABASE_URL`, run:

```bash
railway run npm run db:migrate
railway run npm run db:import:tasks
railway run npm run db:import:threads
railway run npm run verify:predeploy
```

Then check:

```bash
railway domain
railway logs
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
- Framework preset: Next.js
- Install command: `npm --prefix app_src install`
- Build command: `npm run build`
- Output directory: `app_src/.next`

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

After Railway Postgres is live:

1. Run migrations and imports.
2. Validate Postgres mode with `CLAWPILOT_STORAGE=postgres`.
3. Add repository adapters for execution runs/results.
4. Add pipeline sync outbox and projection workers.

