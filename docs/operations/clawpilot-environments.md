---
id: cp-ops-environments
title: ClawPilot Environments and Deployment
summary: Canonical repository, isolated Railway development and production environments, local startup, validation, promotion, verification, and rollback.
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
- Feature work enters `dev` through a reviewed pull request. Production promotion then uses a reviewed pull request from `dev` to `main`.
- Railway `development` follows `dev`; Railway `production` follows `main`. Code is promoted, while runtime data, organizations, and credentials remain isolated and are never copied by branch promotion.

## Local Development

Start the isolated local runtime from the repository root:

```bash
./scripts/dev-start.sh
```

Use `http://localhost:4002`. The start script binds to `127.0.0.1` by default
and supplies isolated `data-dev` paths; normal validation must not use a plain
`npm run dev`. When `APP_AUTH_REQUIRED=0` on a non-hosted runtime, API requests
use a synthetic local operator so the isolated file-backed workspace remains
testable without weakening Railway or Vercel session enforcement. Keep a
tool-managed startup shell alive while browser testing so its child process is
not cleaned up.

A local runtime is optional test evidence only. It does not replace the hosted
Railway development environment, must not claim `dev.aiapp.eigenracing.com`,
and must not receive Railway data or provider credentials. The evaluated Mac
hostname override and public remote-local replacement were abandoned. If a
previous override or ingress is still present, keep it disabled and use the
public development hostname only for Railway:

```bash
./scripts/manage-local-development-domain.sh disable
./scripts/manage-remote-local-development.sh stop-ingress
./scripts/dev-stop.sh
```

### Retired Remote-Local Design

The following design is retained temporarily as implementation history while
its supporting code is removed separately. It is not an active deployment
option and none of its preparation, ingress, Funnel, or Vercel gateway commands
may be used to replace Railway development.

The evaluated design would have kept `dev.aiapp.eigenracing.com` as the
browser-visible origin while the app ran on this Mac. The ordinary
`scripts/dev-start.sh` process must never be exposed directly; it deliberately
uses an authentication-disabled file fixture and binds to loopback.

The retired remote-local topology used a dedicated Vercel gateway project
rooted at `infra/vercel-remote-local-gateway`, a stable Tailscale Funnel HTTPS
origin, and a second loopback-only Caddy listener on port 4102:

```text
browser -> dev.aiapp.eigenracing.com (Vercel TLS)
        -> stable *.ts.net Funnel origin (TLS)
        -> 127.0.0.1:4102 (Caddy)
        -> 127.0.0.1:4002 (authenticated ClawPilot runtime)
```

There are three independent checks before a browser reaches the application.
Vercel
overwrites `X-ClawPilot-Remote-Local-Ingress` with a secret held only in Vercel
and on the Mac; Caddy rejects requests without the exact value. Caddy then
requires an operator username and password using a one-way password hash.
Finally, ClawPilot itself must require its normal durable Postgres-backed user
session. A
request sent directly to the discoverable Funnel hostname therefore fails even
if it supplies a forged public host header. Caddy removes both the gateway
secret and Basic authorization header before forwarding to ClawPilot.

Generate the two local inputs without writing plaintext credentials to Git:

```bash
export CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
export CLAWPILOT_REMOTE_LOCAL_PASSWORD_HASH="$(caddy hash-password)"
./scripts/manage-remote-local-development.sh prepare
```

The password command prompts without echoing input and produces the required
bcrypt hash. Supply the same ingress
secret to the dedicated Vercel gateway as the encrypted
`CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET` environment variable. Set
`CLAWPILOT_REMOTE_LOCAL_ORIGIN` to the exact stable `https://*.ts.net` Funnel
origin with no trailing slash. Never use a `NEXT_PUBLIC_*` variable for either
value.

The ingress manager does not start ClawPilot. Before using it, separately start
a production-like local build on `127.0.0.1:4002` against a dedicated,
fully-migrated non-production Postgres database. It must use at least:

```text
APP_AUTH_REQUIRED=1
CLAWPILOT_STORAGE=postgres
CLAWPILOT_DB_FALLBACK_TO_FILE=false
DATABASE_URL=postgresql://non-production-runtime@isolated-host/clawpilot_dev
INTEGRATION_CREDENTIAL_ENCRYPTION_KEY=<dedicated-non-production-key>
INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID=<non-secret-non-production-key-id>
INTEGRATION_CREDENTIAL_ATTESTATION_MODE=strict
CLAWPILOT_PUBLIC_URL=https://dev.aiapp.eigenracing.com
CLAWPILOT_EXECUTION_ENABLED=0
CLAWPILOT_COMMERCE_INTAKE_ENABLED=0
CLAWPILOT_COMMERCE_ORDER_REVISION_APPLY_ENABLED=0
CLAWPILOT_SHOPIFY_ORDER_TEST_WRITES_ENABLED=0
CLAWPILOT_SHOPIFY_ORDER_PRODUCTION_WRITES_ENABLED=0
CLAWPILOT_SHOPIFY_REVERSAL_FIXTURE_ENABLED=0
QUICKBOOKS_WRITES_ENABLED=0
CAREER_SITE_SUBMISSIONS_ENABLED=0
CAREER_SITE_AGENTS_ENABLED=0
CAREER_SITE_LINKEDIN_ENABLED=0
CRM_ENABLED=0
CLAWPILOT_REPOSITORY_RUNNER_ENABLED=0
CLAWPILOT_PRINT_AGENT_RELEASE_ENABLED=0
AI_RADAR_ENABLED=false
```

Any runtime configured with `CLAWPILOT_STORAGE=postgres` and `DATABASE_URL`
must pass the integration-credential key-attestation gate, even when provider
execution is disabled. Apply all migrations, use a dedicated non-production
key and key ID, then bootstrap an empty database or complete reviewed legacy
adoption through the
[integration credential key-attestation runbook](integration-credential-key-attestation.md).
Verify the sentinel against the exact non-production database identity before
starting the application in `strict` mode. `adoption` is a bounded maintenance
state only and cannot be used for ordinary remote-local access.

With the complete remote-local profile above exported in one private shell,
use the same shell and exact database/key configuration for migration,
attestation, build, and startup:

```bash
npm run db:migrate
npm run integration-key:attest -- verify \
  --expected-database-identity <isolated-non-production-database-uuid>
npm run build
npm --prefix app_src run start -- \
  --hostname 127.0.0.1 --port 4002
```

For a new empty database, run the documented `bootstrap-empty` command before
`verify`; for a legacy non-empty database, complete the two-step reviewed
adoption before returning to `strict` and running `verify`. Never start the
remote-local app in `adoption` mode. Keep this application shell alive while
the ingress is in use, and confirm `http://127.0.0.1:4002/api/persistence/status`
reports the reviewed database fingerprint before `start-ingress`.

The database URL, application/session credentials, auth-mail or SSO identity,
and encryption keys remain server-only and are not stored in this repository.
Do not point this runtime at the production database or reuse production
provider credentials. The ordinary `scripts/dev-start.sh` fixture is not a
substitute: it hardcodes file storage and `APP_AUTH_REQUIRED=0`.
Set `CLAWPILOT_REMOTE_LOCAL_DATABASE_FINGERPRINT` for the ingress manager to
the exact `databaseFingerprint` returned by this isolated runtime's
`/api/persistence/status`. `start-ingress` and `status` fail closed when it is
missing, malformed, or different, preventing a healthy but incorrect database
from being exposed.
Disable the separate loopback hostname override before remote-local operation;
otherwise this Mac resolves the branded domain locally instead of through the
Vercel gateway. Never run the loopback-domain `enable` action while the public
remote-local ingress is active.

After separately validating a complete application login/session locally and
reviewing and approving the Vercel project/domain assignment and Funnel
enablement, start only the authenticated Mac-side ingress with:

```bash
./scripts/manage-remote-local-development.sh start-ingress
./scripts/manage-remote-local-development.sh funnel-command
```

The second command only prints the required Tailscale command; it does not run
it. `start-ingress` fails closed unless the upstream root redirects to the exact
HTTPS login origin, `/login` is available, an unauthenticated protected API
returns 401, and `/api/persistence/status` reports a healthy Postgres authority.
`status` repeats those checks and proves that the ingress is loopback-only, a
direct request receives 404, and a Vercel-secret-only request still receives
the Basic-auth 401. Stop the ingress with `stop-ingress`; manage the application
runtime separately. Disabling Funnel and changing the Vercel domain or
environment remain explicit infrastructure actions.

The Vercel gateway route matches only the exact branded host; Vercel project
aliases receive 404, and external-origin caching is disabled. Vercel external
routing retains the branded URL and proxies ordinary request
methods, bodies, cookies, and response headers for all matched paths, including
Next.js assets and APIs. It is not an offline replica: the Mac and Tailscale
must be online, Funnel has non-configurable bandwidth limits, and Vercel's
reserved `/.well-known` handling is not supplied by this catch-all gateway.
The retired design had no hosted Postgres, SuiteCRM, worker, provider, webhook,
or callback authority and cannot be cited as development evidence.

### Hosted Railway Development

Railway `development` remains the active non-production environment at
`https://dev.aiapp.eigenracing.com`. It owns an isolated Postgres database,
SuiteCRM stack, worker lane, provider configuration, sessions, and callbacks.
Use it for authenticated development acceptance after the exact `dev` commit
passes GitHub CI. It is not a migration source scheduled for retirement, and
no organization or integration transfer from development to production is part
of the active release plan.

Local fixtures and disposable Postgres tests remain useful implementation
evidence, but they do not replace hosted development health, persistence,
worker, provider, or authenticated UI checks.

## Required Hosted Topology

This table is the accepted target, not a claim that the retirement is already
complete. Retirement here refers only to the legacy application Vercel runtime,
not the retained Railway development environment. A read-only Vercel
configuration audit on `2026-09-05` found the
application project still carries production-scoped `DATABASE_URL`,
`AGENT_CREDENTIAL_DATABASE_URL`, `CLAWPILOT_AUTH_SELF_DELIVERY`,
`CLAWPILOT_AUTH_MAIL_ADDITIONAL_SENDERS`, `INTEGRATION_EVIDENCE_*`, and
`GOOGLE_SSO_SERVER_CLIENT_ID` assignments across legacy scopes.
No `INTEGRATION_CREDENTIAL_*` variable was present. Those facts leave the Vercel
project in a transitional, unaccepted state. The same audit found 24 READY
production deployments, and the public `clawpilot-nu.vercel.app` alias returned
`runtime=vercel`, `storage=postgres`, with both production database stores
reachable. Removing environment assignments is not retroactive: an older
deployment can retain the variables it received when built and can be promoted
or rolled back without exercising the new source build guard. Do not deploy
this project, call it preview-only, or use it as production/preview evidence
until the gated retirement steps below are complete. This inventory records
variable names only; values remain secret and must not enter Git or logs.

Railway development is retained as the permanent pre-production lane. The
selective workspace migration and production-consolidation plan is abandoned.

| Surface | Development | Production |
|---|---|---|
| Branch | `dev` | `main` |
| Railway environment | `development` | `production` |
| ClawPilot | `https://dev.aiapp.eigenracing.com` | `https://aiapp.eigenracing.com` |
| SuiteCRM | `https://dev.crm.eigenracing.com` | `https://crm.eigenracing.com` |
| Fulfillment optimizer | Isolated Railway service over `fulfillment-optimizer.railway.internal` | Isolated Railway service over `fulfillment-optimizer.railway.internal` |
| Vercel | No runtime or data authority | No runtime or data authority |

Railway is the execution and persistence runtime for both isolated environments.
Each environment runs its own Next.js application, background workers, Postgres,
SuiteCRM service, MariaDB, and volumes. The Railway deployment path, including
its predeploy gate and idempotent release-record check, is the sole authority
for append-only Postgres migrations. Vercel does not serve either application,
replace Railway workers, run migrations, call providers, or own durable writes.

The post-cutover contract prohibits every Vercel project or preview from receiving the production `DATABASE_URL`,
`INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`, production provider credentials,
production session secrets, or another secret that confers production data or
write authority. The audited legacy assignments above are cutover blockers, not
exceptions to that rule. The abandoned remote-local gateway is not part of the
hosted topology and must not receive production or development authority.

Both Railway environments retain their own backup and recovery controls. The
`dev` branch is the reviewed integration branch; only its committed code moves
to `main` after development acceptance.

The `eigenracing.com` DNS zone is managed through Squarespace. Each Railway
custom domain uses the exact CNAME and verification TXT values Railway issues
for its environment. The shared domain is routing infrastructure only and does
not import Eigen Racing product assumptions into ClawPilot.

## Environment Isolation

Development and production each own separate durable Postgres and MariaDB
databases, SuiteCRM volumes, users, sessions, provider credentials, boards,
pipelines, Sheets, CRM projections, documents, releases, checkpoints, worker
secrets, and short links. Local development uses isolated `data-dev` paths and
must not receive either hosted environment's data or secrets. Code promotion
never copies runtime data, organizations, or provider credentials. No
development-to-production data or integration migration is authorized by the
normal release sequence.

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

1. Validate the exact feature commit locally and in GitHub CI, including affected
   routes and responsive UI when applicable, then merge its reviewed pull request
   into `dev`.
2. Wait for the exact resulting `dev` commit to pass its push CI and deploy to the
   Railway `development` environment. The deployment path applies append-only
   Postgres migrations before starting the application and workers.
3. Verify the development commit through `/api/version`, `/api/runtime`,
   `/api/health`, `/api/persistence/status`, worker heartbeats, and the affected
   authenticated browser workflow.
4. Update the owning active contract and release copy, then promote through a
   reviewed `dev` to `main` pull request that cites the development evidence.
5. Wait for the exact resulting `main` commit to pass its push CI and deploy to
   Railway `production`. Verify the same runtime, persistence, worker, and
   authenticated UI boundaries against production.
6. In `strict` mode, `scripts/start-railway.sh` automatically runs the idempotent
   `release:record` command after health succeeds. Confirm that entry as
   deployment-and-health evidence for the production Railway start. Adoption
   maintenance deliberately suppresses this record.

Confirm the required environment and provider backups before risky migrations
or destructive work. Normal code promotion does not copy data, organizations,
or credentials between environments. The abandoned selective workspace
migration, Railway-development retirement, production consolidation, and
remote-local replacement are not release steps.

Repository configuration temporarily disables Vercel Git deployments for every
branch during the transition, and the Vercel build script rejects non-preview
hosted builds. That source contract does not prove the existing project
variables or deployments have been retired, so the application project's Git
integration must also remain disabled before this commit is pushed. After the
retirement audit passes, an independent preview may be created manually from an
exact commit. A later reviewed source change may re-enable automatic protected
feature-branch previews only after confirming those previews compile without
production database, agent-credential-database, integration-encryption,
provider, integration-evidence, authentication-mail, SSO, or session variables,
do not run managed environment gates, and cannot mutate production. A
migration-dependent preview is compile/UI evidence only until the Railway
migration is deployed. Vercel builds never run `db:migrate`, and a Vercel
deployment is never a production release or managed-mail verification surface.
Until this succeeds, the cutover remains incomplete and Vercel is not accepted as preview-only.

## Deployed Verification

Verify the Railway custom domains after release-facing changes, development
before production:

- `/api/version`
- `/api/runtime`
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

`/api/version` and `/api/runtime` must identify the exact expected branch and
commit. `/api/persistence/status` must return a non-empty
`databaseFingerprint` that matches the reviewed database identity for that
environment. A missing, mismatched, or cross-environment identity is a release
blocker. Do not configure or query a Vercel preview for either Railway
fingerprint: its lack of hosted database authority is intentional, and preview
output must not be cited as runtime, migration, worker, or persistence proof.

Also validate the affected authenticated browser workflow first in development
and then in production. A green build does not replace live board, agent-thread,
CRM, Sheet, POS, accounting, or mobile acceptance.

The `Deployed runtime monitor` GitHub workflow checks the production custom domain every 30 minutes without application credentials. It verifies the login boundary, Postgres persistence, migrations, SuiteCRM, pipeline, agent, research, Toast, QuickBooks, AI Radar, and document-embedding worker health. A failed scheduled run is an operational alert and must not be dismissed as a deployment-only failure.

## Recovery And Rollback

Stop or freeze affected writes before restoring data. Roll code back to the previous reviewed commit when the defect is application-only. Restore Postgres, MariaDB, and SuiteCRM volume checkpoints as a coordinated recovery when data integrity is affected; preserve and later drain durable outbox work only after the restored projections are verified. Re-run migrations and deployed smoke checks before reopening writes.

Operator procedures:

- [Railway Postgres backups](railway-postgres-backups.md)
- [SuiteCRM Railway runbook](suitecrm.md)
- [Google Workspace integration](google-workspace-integration.md)
- [ChatGPT agent authorization](chatgpt-agent-auth.md)
