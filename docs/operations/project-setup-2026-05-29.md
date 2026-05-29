# Project Setup - 2026-05-29

## Objective

Make ClawPilot understandable as a developer project before continuing refactor work.

## Changes

- Renamed active local branch from `dev/worktree` to `dev`.
- Created local protected baseline branch `stable/4001` at commit `5970420`.
- Created baseline tags:
  - `prod-4001-baseline-2026-05-29`
  - `dev-4002-baseline-2026-05-29`
- Added root project metadata and scripts in `package.json`.
- Added root onboarding docs:
  - `README.md`
  - `CONTRIBUTING.md`
  - `.env.example`
- Added GitHub Actions CI:
  - `.github/workflows/ci.yml`
- Added deployment config:
  - `vercel.json`
  - `railway.json`
- Added architecture and operations docs:
  - `docs/architecture/system-overview.md`
  - `docs/operations/environments.md`
  - `docs/operations/deployment.md`
- Added CI-safe predeploy verification:
  - `scripts/verify-predeploy.mjs`
- Expanded `.gitignore` to keep future runtime data, logs, backups, env files, and platform metadata out of source control.

## Not Done

- No GitHub remote was created or pushed.
- No Vercel project was linked or deployed.
- No Railway project was linked or deployed.
- No legacy tracked data was removed from git history.
- No stable/prod `4001` runtime mutation was performed.

## Validation

- `npm run check`: passed.
  - Runs lint, build, thread-store test, and predeploy verification.
  - Lint still has 13 existing warnings and 0 errors.
  - Build still reports the existing Next.js `middleware` to `proxy` deprecation warning.
- `npm run verify:dev`: passed with `VERIFY_OK` against a temporary foreground `4002` runtime.
- `npm run verify:regression`: passed with `REGRESSION_ALL_OK` against a temporary foreground `4002` runtime.
- Detached `scripts/dev-start.sh` still starts and verifies briefly, but the process exits after the script returns in this Codex execution environment. For verification here, a temporary foreground `next start` process was used and stopped afterward.

## Follow-Up Before First Push

1. Decide whether to create a clean private GitHub import instead of pushing legacy history.
2. Authenticate GitHub CLI or use GitHub web/app flow.
3. Authenticate Railway CLI if Railway deployment is needed.
4. Add or connect Vercel project.
5. Provision Railway Postgres, run `npm run db:migrate`, then seed tasks with `npm run db:import:tasks`.
6. Run the full validation gate again.
