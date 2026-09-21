---
id: cp-ops-development-on-demand
title: ClawPilot Development On Demand
summary: Approved development suspension, retained data and configuration, and the restart procedure for hosted acceptance.
status: active
kind: operations-runbook
area: operations
tags: [railway, development, costs, recovery]
app_visible: false
---

# Development on demand

On September 21, 2026, the operator approved keeping Railway development as an
on-demand environment after validating the accounting release. This supersedes
the September 14 requirement to keep development continuously running. It does
not authorize deleting the environment, services, organizations, variables,
volumes, or backups, or migrating development records into production.

## Scope and preservation

- Project: `clawpilot` (`b5169ebd-8166-4b96-9a81-7cc8adaa9270`).
- Development: `e4abd95f-825c-4242-b37b-825a92597e98`.
- Production: `058ce52f-1d3b-44bb-afe2-0df2bf24efb9`; remains running.
- Stop development deployments for ClawPilot, SuiteCRM, fulfillment optimizer,
  MariaDB, and Postgres. Retain their service definitions, source connections,
  variables, domains, and attached volumes.
- Disable development GitHub autodeploy for ClawPilot, SuiteCRM, and the
  fulfillment optimizer. Keep production deployment triggers unchanged.
- Keep development credentials in their existing Railway/database stores. Do
  not export credential values into Git or evidence files.

While suspended, `dev.aiapp.eigenracing.com` and `dev.crm.eigenracing.com` are
unavailable. Development background jobs, incoming webhooks, and integrations
do not run. Providers may expire authorizations or remove repeatedly failing
webhooks; verify these when resuming, then use normal reconciliation to catch
up. Suspension does not itself revoke or rotate stored credentials.

## Restart for a test session

1. Verify the selected environment is **development**, the same three volumes
   remain attached, and the intended source commit has passed CI. Read the
   latest suspension evidence before deploying.
2. Use Railway **Deploy** on the retained Postgres and MariaDB services with
   their existing image sources. Wait for database readiness.
3. Deploy SuiteCRM and the fulfillment optimizer from their retained source
   configuration. Check their health before the application.
4. Manually deploy the intended reviewed `dev` commit to ClawPilot. Automatic
   deployment remains disabled; use Deploy Latest Commit only after checking
   the latest commit's CI result.
5. Verify `/api/version` matches the intended commit; `/api/health` and
   `/api/persistence/status` must be healthy with current migrations. Verify a
   normal signed-in session and the providers relevant to the test. Check
   webhook registrations and queued/background work after the offline period.
6. Perform hosted acceptance. Local compile and mock tests do not establish
   live provider behavior. Promote source through the normal `dev` to `main`
   PR; do not copy development data or credentials to production.
7. When testing is complete, check recent backups, stop ClawPilot and SuiteCRM
   first, stop the optimizer, then stop MariaDB and Postgres deployments. Use
   **Remove deployment**, not Delete service or Delete environment. Verify no
   development deployment remains active and production is healthy.

All stopped services can be deployed again from their retained configuration.
Re-enable autodeploy only if the operator intentionally returns to always-on
development; a normal source push must not wake suspended development.

## Cost and database review — September 21

The September 14–21 window contained 169 hourly samples per service. At the
published rates of $10/GB-month RAM and $20/vCPU-month, the five development
services averaged 2.242 GB RAM and 0.297 vCPU: about **$28.37/month compute**.
Their three volumes contained 9.789 GB: about **$1.47/month retained storage**,
plus incremental backups. These are measured run-rate estimates, not invoice
amounts or guaranteed savings for the partly elapsed billing cycle.

The six production services averaged about **$19.40/month compute**, with
**$0.56/month volume storage**, excluding backups, other projects, and taxes.
The Pro plan minimum and included usage credit still apply.

Both application database URLs use Railway private networking. Neither
Postgres instance has `WAL_ARCHIVE_*` variables. Public Postgres egress over the
last seven days was approximately 0.00305 GB combined (about $0.00015). The
$4.19 accrued network charge is historical and must not be extrapolated as the
current rate.

Production Postgres averaged about 0.33 GB RAM and 0.058 vCPU. No production
database tuning or resource-limit change is justified by these observations.
Railway bills actual use; lowering an unused ceiling does not reduce cost.

The workspace's existing soft alert is $25 and hard limit is $100. The hard
limit is workspace-wide and can take production offline; do not lower it as a
routine cost-saving measure. At review the forecast was $61.75 and accrued
usage was $43.40 for September 1–October 1.

## Recovery checks

Before suspension, all six retained dev/prod volume instances were `READY` and
had provider backup records less than 30 hours old. Development Postgres had
daily and weekly schedules; its previously documented monthly-schedule gap
remains. The other five volumes had daily, weekly, and monthly schedules.
Suspension does not remove these schedules. Confirm future backup behavior
from live Railway records instead of assuming offline backups ran.

Configuration fingerprints, service/source IDs, domain bindings, volume IDs,
and backup records were captured without credential values. Compare these
before and after suspension. Keep recovery evidence outside Git.

## Suspension result — September 21, 2026

All five development services have zero active deployments. GitHub autodeploy
is disabled for all three repository-backed development services. All six
production deployments remain successful with their original deployment IDs.
Production `/api/health` returned HTTP 200, `status=ok`, zero errors and zero
warnings; `/api/persistence/status` returned HTTP 200, `ok=true`, using Postgres.
The development application URL now returns Railway's HTTP 404 because no
application deployment is running; this is intentional.

Before suspension, accounting release
`38ba5b82e8d40ea990a5e948e8ce225cf8e44663` passed GitHub CI run `35652067689`,
Railway development deployment `a9899b2b-2107-4fc7-b000-806639dea580`, version,
health, and persistence checks. It was not promoted to production in this
infrastructure change. The live production read-only QuickBooks taxonomy
probe returned 31 root categories and 2,106 children under one root; this
identified a validation-performance follow-up before product-edit release
acceptance. Development's stored QuickBooks binding did not match its current
credential/connection owner, so live dev provider acceptance remains pending.

An additional manual development Postgres backup was requested but Railway
rejected it because the volume already had the plan maximum of ten backups.
No backup was deleted. The latest existing daily backup was September 21 at
02:45 UTC, within the 30-hour gate, and the database volume remains attached.

Redacted before/after evidence is retained locally under
`/Users/agentsuburbiasandwich/Documents/ClawPilot-Recovery/2026-09-21/dev-on-demand/`.
The weekly infrastructure review now treats suspended development as expected,
checks for unexpected restarts, and measures savings without waking services.

## References

- [Railway autodeploy controls](https://docs.railway.com/deployments/github-autodeploys)
- [Railway deployment removal](https://docs.railway.com/cli/down)
- [Railway pricing](https://docs.railway.com/pricing/plans)
- [Railway cost controls](https://docs.railway.com/pricing/cost-control)
- [Infrastructure register](infrastructure-and-cost-control-register.md)
- [Backup policy](railway-postgres-backups.md)
