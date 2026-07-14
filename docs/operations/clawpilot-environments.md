---
title: ClawPilot Environments and Deployment
status: active
kind: operations-contract
tags: [deployment, railway, vercel, github, environments]
app_visible: true
---

# ClawPilot Environments and Deployment

## Source and Promotion

- GitHub repository: `jarrettcrosby/clawpilot`
- Active development branch: `dev`
- Production branch: `main`
- Promotion uses a reviewed pull request from `dev` to `main`.

## Runtime Surfaces

- Development: `https://dev.aiapp.eigenracing.com`
- Production: `https://aiapp.eigenracing.com`
- Railway runs the application worker, environment-specific Postgres, private SuiteCRM service, and dedicated SuiteCRM MariaDB.
- Vercel provides protected Next.js previews and an independent deployment/build surface. It uses the matching Railway Postgres public proxy and does not replace the Railway background worker.

Development and production use separate Postgres and MariaDB databases, SuiteCRM volumes, user records, credentials, boards, pipelines, workbooks, documents, releases, and checkpoints. Code is promoted as the same reviewed commit; runtime data is not copied between environments.

## Release Contract

1. Build the application and validate the configured sender before changing the deployment.
2. Apply migrations before starting the Railway runtime.
3. Start the Next.js application and background outbox/agent worker.
4. Wait for the local `/api/health` contract to pass.
5. Record the release in Postgres only after that health check succeeds.
6. Verify the custom domain endpoints and protected Vercel deployment.

SuiteCRM is deployed from `services/suitecrm`, is reachable from ClawPilot over Railway's private network, and persists its application files on a separate volume. See the [SuiteCRM Railway runbook](suitecrm.md).

Vercel runs database gates only for `dev` and `main`. Other preview branches compile without mutating the shared development database.

The stable deployed checks are `/api/health`, `/api/persistence/status`, `/api/agents`, `/api/pipeline/sync-status`, and `/api/tasks`.
