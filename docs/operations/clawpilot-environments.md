---
id: cp-ops-environments
title: ClawPilot Environments and Deployment
summary: Canonical repository, branches, local startup, hosted topology, validation gates, promotion, verification, and rollback.
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

| Surface | Production | Development |
|---|---|---|
| Branch | `main` | `dev` |
| Railway environment | `production` | `development` |
| ClawPilot | `https://aiapp.eigenracing.com` | `https://dev.aiapp.eigenracing.com` |
| SuiteCRM | `https://crm.eigenracing.com` | `https://dev.crm.eigenracing.com` |

Railway runs the Next.js server, background outbox and agent workers, environment-specific Postgres, private SuiteCRM service, dedicated SuiteCRM MariaDB, and SuiteCRM volume. Vercel provides protected Next.js previews and an independent build/deployment check; it does not replace Railway workers or own durable writes.

The `eigenracing.com` DNS zone is managed through Squarespace. Each Railway custom domain uses the exact CNAME and verification TXT values Railway issues for that environment. Production standalone services use `<service>.eigenracing.com`; development uses `dev.<service>.eigenracing.com`. The shared domain is routing infrastructure only and does not import Eigen Racing product assumptions into ClawPilot.

## Environment Isolation

Development and production have separate Postgres and MariaDB databases, SuiteCRM volumes, users, sessions, platform credentials, boards, pipelines, Sheets, CRM projections, documents, releases, checkpoints, worker secrets, and short links. They may share only the restricted per-user ChatGPT credential store and its encryption key so one user authorization works in both lanes. Each environment database contains its own protected synthetic [demo account](public-demo-environment.md); it has no provider credential and does not copy data from another tenant or environment. No application data, database row, Sheet ID, or provider secret is copied between environments as part of promotion.

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

1. Validate the exact reviewed commit on `dev`, including affected routes and responsive UI when applicable.
2. Update the owning active contract and release copy without waiting for a separate documentation request.
3. Confirm the required Railway and provider backups before risky migrations or destructive work.
4. Promote through a reviewed `dev` to `main` pull request.
5. Railway applies append-only Postgres migrations before starting the application and workers.
6. Wait for `/api/health` and worker heartbeats before recording the deployment as successful.
7. Record one idempotent release entry in Postgres after health succeeds.
8. Verify custom domains and the protected Vercel deployment against the same candidate.

Vercel runs database gates only for `dev` and `main`; other previews compile without mutating the shared development database.

## Deployed Verification

Verify both development and production after release-facing changes:

- `/api/health`
- `/api/persistence/status`
- `/api/agents`
- `/api/pipeline/sync-status`
- `/api/tasks`

Also validate the affected authenticated browser workflow. A green build does not replace live board, agent-thread, CRM, Sheet, or mobile acceptance.

The `Deployed runtime monitor` GitHub workflow checks both custom domains every 30 minutes without application credentials. It verifies the login boundary, Postgres persistence, migrations, SuiteCRM, pipeline, agent, research, Toast, QuickBooks, AI Radar, and document-embedding worker health. A failed scheduled run is an operational alert and must not be dismissed as a deployment-only failure.

## Recovery And Rollback

Stop or freeze affected writes before restoring data. Roll code back to the previous reviewed commit when the defect is application-only. Restore Postgres, MariaDB, and SuiteCRM volume checkpoints as a coordinated recovery when data integrity is affected; preserve and later drain durable outbox work only after the restored projections are verified. Re-run migrations and deployed smoke checks before reopening writes.

Operator procedures:

- [Railway Postgres backups](railway-postgres-backups.md)
- [SuiteCRM Railway runbook](suitecrm.md)
- [Google Workspace integration](google-workspace-integration.md)
- [ChatGPT agent authorization](chatgpt-agent-auth.md)
