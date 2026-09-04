---
id: cp-ops-environments
title: ClawPilot Environments and Deployment
summary: Canonical repository, branches, local startup, production-only hosted topology, validation gates, promotion, verification, and rollback.
status: active
kind: operations-contract
area: operations
tags: [deployment, railway, vercel, github, environments]
app_visible: true
---

# ClawPilot Environments and Deployment

## Source And Promotion

- Canonical repository: `jarrettcrosby/clawpilot`
- Active development branch: `dev`
- Production branch: `main`
- Historical local reference: `stable/4001`; it is not the hosted promotion target.
- Promotion uses a reviewed pull request from `dev` to `main`. Code is promoted; runtime data is never copied from development into production.

## Local Development

Start the isolated local runtime from the repository root:

```bash
./scripts/dev-start.sh
```

Use `http://localhost:4002`. The start script supplies isolated `data-dev` paths; normal validation must not use a plain `npm run dev`. When `APP_AUTH_REQUIRED=0` on a non-hosted runtime, API requests use a synthetic local operator so the isolated file-backed workspace remains testable without weakening Railway or Vercel session enforcement. Keep a tool-managed startup shell alive while browser testing so its child process is not cleaned up.

## Hosted Topology

| Surface | Production |
|---|---|
| Branch | `main` |
| Railway environment | `production` |
| ClawPilot | `https://aiapp.eigenracing.com` |
| SuiteCRM | `https://crm.eigenracing.com` |
| Fulfillment optimizer | Isolated Railway service over `fulfillment-optimizer.railway.internal` |

Railway runs the Next.js server, background outbox and agent workers, production Postgres, private SuiteCRM service, dedicated SuiteCRM MariaDB, and SuiteCRM volume. The Railway deployment path, including its predeploy gate and idempotent release-record check, is the sole authority for append-only Postgres migrations. Vercel provides protected Next.js previews and an independent build/deployment check; it does not replace Railway workers, run migrations, or own durable writes.

Railway hosts only the production environment. The `dev` source branch remains
the reviewed integration branch, while local isolated development and protected
Vercel previews provide pre-production build and UI evidence without a second
always-on Railway database or service stack. Production retains PITR and
scheduled backups.

The `eigenracing.com` DNS zone is managed through Squarespace. Each Railway custom domain uses the exact CNAME and verification TXT values Railway issues for production. The shared domain is routing infrastructure only and does not import Eigen Racing product assumptions into ClawPilot.

## Environment Isolation

Production owns the durable Postgres and MariaDB databases, SuiteCRM volumes,
users, sessions, platform credentials, boards, pipelines, Sheets, CRM
projections, documents, releases, checkpoints, worker secrets, and short links.
Local development uses isolated `data-dev` paths and protected Vercel previews
must not mutate production. Code promotion never copies runtime data or provider
secrets. Any one-time legacy-development data transfer requires its own reviewed,
selective manifest, excludes credentials and bulky polling evidence, and is
verified before the retired environment is deleted.

## Implementation Gate

Use the smallest relevant checks while implementing:

```bash
npm run lint
npm run build
npm run test
npm run verify:docs
```

Before a deployment candidate, run:

```bash
npm run verify:regression
npm run verify:predeploy
```

The owning active contract must be current before promotion. A clean committed-files-only build is mandatory; local untracked modules do not count as deployable source. The [2026-03-20 build-integrity incident](../incidents/2026-03-20-stable-build-integrity-outage.md) records why this remains a hard rule.

## Release Sequence

1. Validate the exact reviewed commit from `dev` locally and in protected preview, including affected routes and responsive UI when applicable.
2. Update the owning active contract and release copy without waiting for a separate documentation request.
3. Confirm the required Railway and provider backups before risky migrations or destructive work.
4. Promote through a reviewed `dev` to `main` pull request.
5. The Railway deployment path applies append-only Postgres migrations before starting the application and workers.
6. Verify that Railway is running the exact reviewed commit, then wait for `/api/health`, `/api/persistence/status`, and worker heartbeats before recording the deployment as successful.
7. Record one idempotent Railway release entry in Postgres after Railway health succeeds. This entry is Railway runtime evidence; it does not by itself prove that Vercel is synchronized.
8. Create the protected Vercel deployment explicitly from the same Git commit SHA, then verify its runtime identity, health, and database fingerprint before considering the production surfaces synchronized.

Automatic Vercel deployments are disabled for `dev` and `main` so a new web runtime cannot reach production before Railway has applied its migrations and passed health. Feature branches remain eligible for automatic protected previews; those previews compile without running managed environment gates or mutating production. A migration-dependent feature preview is compile/UI evidence only until the Railway migration is deployed. After Railway succeeds, use Vercel's **Create Deployment** flow with the exact commit SHA rather than the moving branch name. The resulting `main` deployment also verifies the managed mail configuration. Vercel builds never run `db:migrate`.

## Deployed Verification

Verify production after release-facing changes:

- `/api/health`
- `/api/persistence/status`
- `/api/agents`
- `/api/pipeline/sync-status`
- `/api/tasks`

For the fulfillment optimizer, `/api/health` reports configuration readiness
without a network probe. When enabled, `configurationStatus` must be `ready`,
the endpoint hostname must be `fulfillment-optimizer.railway.internal`, and
`connectivity` remains `not-probed`. A disabled or invalid optimizer
configuration makes Railway application health fail. Verify the optimizer
service's own health endpoint separately.

`/api/persistence/status` must return a non-empty `databaseFingerprint`. Railway and Vercel production must report the same fingerprint. A missing or mismatched identity is a release blocker.

Also validate the affected authenticated browser workflow. A green build does not replace live board, agent-thread, CRM, Sheet, POS, accounting, or mobile acceptance.

The `Deployed runtime monitor` GitHub workflow checks the production custom domain every 30 minutes without application credentials. It verifies the login boundary, Postgres persistence, migrations, SuiteCRM, pipeline, agent, research, Toast, QuickBooks, AI Radar, and document-embedding worker health. A failed scheduled run is an operational alert and must not be dismissed as a deployment-only failure.

## Recovery And Rollback

Stop or freeze affected writes before restoring data. Roll code back to the previous reviewed commit when the defect is application-only. Restore Postgres, MariaDB, and SuiteCRM volume checkpoints as a coordinated recovery when data integrity is affected; preserve and later drain durable outbox work only after the restored projections are verified. Re-run migrations and deployed smoke checks before reopening writes.

Operator procedures:

- [Railway Postgres backups](railway-postgres-backups.md)
- [SuiteCRM Railway runbook](suitecrm.md)
- [Google Workspace integration](google-workspace-integration.md)
- [ChatGPT agent authorization](chatgpt-agent-auth.md)
