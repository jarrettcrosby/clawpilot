---
id: cp-ops-infrastructure-cost-register
title: ClawPilot Infrastructure and Cost Control Register
summary: Current Railway topology, cost controls, recovery policy, operating thresholds, review cadence, and infrastructure change history.
status: active
kind: operations-register
area: operations
tags: [railway, infrastructure, costs, backups, pitr, deployment]
app_visible: true
---

# ClawPilot Infrastructure and Cost Control Register

> Current development runtime policy, approved September 21, 2026:
> [Development on demand](development-on-demand.md). Development services,
> configuration, volumes, and backups are retained, but deployments are stopped
> and development autodeploy is disabled between test sessions. This supersedes
> the continuously running development assumptions in the earlier entries below.

## Purpose

This is the durable operating record for ClawPilot infrastructure, cost controls, and approved configuration changes. Read it before changing Railway topology, service limits, networking, deployment triggers, backups, or spending controls. Verify every time-sensitive value against Railway before acting; this document records the intended baseline, not a substitute for live evidence.

## Retained Hosted Environments

The selective organization migration and Mac-hosted replacement were abandoned.
Railway development and production are retained, isolated environments; promote
code from `dev` to `main`, never copy organizations, data, or credentials as part
of release parity. On 2026-09-14 both application deployments were successful,
their Git trees matched, and health and persistence checks returned HTTP 200.
Reassessing development cost is not approval to retire its services or data.

A read-only Vercel audit on `2026-09-05` found legacy
production-scoped `DATABASE_URL`, `AGENT_CREDENTIAL_DATABASE_URL`,
authentication-mail, integration-evidence, and Google SSO assignments still on
the application project, with no `INTEGRATION_CREDENTIAL_*` variable. Vercel is
therefore still transitional and must not be called preview-only. Its public
alias reached production Postgres and 24 READY Production artifacts retained
their build-time environment, so variable deletion alone is not a retirement.
Any Vercel credential retirement requires a separate current inventory and
approved change. The previously proposed sequence was to remove the alias and
every legacy Vercel assignment, disable or
delete historical production artifacts, then revoke or rotate the database,
session, worker, Maton, provider, and webhook authority they held. Encryption
and evidence keys require a separately reviewed data migration rather than
blind rotation. Re-audit without printing values. The detailed order and stop
conditions live in
[ClawPilot Environments and Deployment](clawpilot-environments.md).

| Platform | Responsibility | Intended boundary |
| --- | --- | --- |
| GitHub | Source and validation | `dev` is the development branch; promotion normally uses a pull request to `main`; Railway waits for successful GitHub Actions before deploying connected services. |
| Railway | Isolated hosted development and production | Each environment retains ClawPilot, Postgres, SuiteCRM, MariaDB, and its fulfillment optimizer. Development is not a frozen migration source. |
| Vercel | Preview and legacy-hosting audit scope | Do not assume preview-only isolation without checking credentials and reachable artifacts. The abandoned remote-local gateway must not replace Railway development. |
| Google Sheets | Operator-owned pipeline tables | Remains writable for pipeline workflows. |
| Railway Postgres | Durable application-owned records | Requires `CLAWPILOT_STORAGE=postgres` and `DATABASE_URL`; production fallback must not silently mask database failure. |

## Railway Production Environment

| Service | Resource ceiling | Recovery policy |
| --- | --- | --- |
| ClawPilot | 2 vCPU / 2 GB | One replica; validate `/api/health` and `/api/persistence/status` after infrastructure changes. |
| Postgres | 2 vCPU / 4 GB | PITR/external WAL archiving disabled under the 2026-09-07 cost-control decision; retain scheduled daily, weekly, and monthly volume backups. |
| SuiteCRM | 2 vCPU / 2 GB | Supported by the production MariaDB service and persistent volume. |
| MariaDB | 1 vCPU / 1 GB | Do not suspend independently while SuiteCRM is active. |
| Fulfillment optimizer | Production ceiling set from measured load | Isolated production service; ClawPilot uses the exact private endpoint `http://fulfillment-optimizer.railway.internal:8080`. Missing service or invalid application configuration is capability drift and blocks parity sign-off. |

Resource ceilings contain abnormal growth; they do not reduce charges when actual utilization is already below the ceiling.

Local development and protected previews can provide compile/UI evidence but
do not replace hosted provider, worker, callback, and persistence tests.
Development remains a backup target and billable resource. A future proposal
to suspend or remove it must inventory unique data, test stores, credentials,
webhooks, and recovery needs, quantify savings, and obtain operator approval.

## Cost Controls

- Railway workspace soft alert: **$25**.
- Railway workspace intended hard limit: **$40**. The live 2026-09-07 review
  observed **$100** instead; this is configuration drift, not an approved
  restoration or change made by this PITR task. Reaching the live limit can stop
  workloads; treat the alert as an intervention threshold rather than a normal
  budget target.
- Wait for CI is enabled to avoid deploying commits before GitHub Actions completes successfully.
- Audit both development and production backups and costs. Do not stop
  development workers or store sync because of the abandoned migration.
  Preserve each environment's reviewed integration permissions.
- Do not infer monthly savings from a short metrics window. Compare current and previous billing-period line items and separate CPU, memory, egress, volume, and backup charges.
- Review deployment churn because repeated builds and replacements can create avoidable usage even when runtime utilization is low.

## Backup And Recovery Policy

- **Development:** retain its data and daily, weekly, and monthly volume
  snapshots. PITR and external WAL archiving remain disabled. No development
  retirement or data migration is authorized by this register.
- **Production:** PITR and external WAL archiving are disabled under the
  operator-approved 2026-09-07 cost-control decision. Retain daily, weekly,
  and monthly volume snapshots. Production snapshots must not be removed by
  development-retirement cleanup.
- **Recovery tradeoff:** recovery is limited to completed snapshots or validated
  logical exports, not an arbitrary time between them. Writes since the latest
  usable snapshot may be lost. A daily schedule does not guarantee an exact
  24-hour recovery point if a backup is delayed or fails; keep the existing
  completed-backup age gate of 30 hours.
- Revisit production PITR and explicit recovery-point/recovery-time objectives
  before new customer onboarding or when recovery requirements change.
- Before destructive data work, verify a recent provider backup and follow [Railway Postgres Backups](railway-postgres-backups.md).
- Never treat an application checkpoint stored in Postgres as a replacement for provider-native recovery.

## Weekly Review

Run this review weekly and before onboarding a customer:

1. Record workspace current usage, monthly estimate, soft-limit state, and hard-limit state.
2. Break project cost down by service and by CPU, memory, egress, volume, and backup.
3. Confirm the production service inventory, replica counts, deployment state,
   resource ceilings, and private optimizer endpoint.
4. Confirm Wait for CI remains enabled for both release branches. Account for
   the retained development stack separately from production; investigate
   unused services and storage without deleting unidentified data.
5. Confirm production Postgres and any retained development Postgres have no
   `WAL_ARCHIVE_*` configuration, external WAL uploads, or remaining PITR bucket
   charges. Confirm daily, weekly, and monthly provider snapshots remain enabled
   and a completed backup is no more than 30 hours old for each retained volume.
6. Inspect deployment churn, failed/restarted deployments, database archive
   errors, and unexpected public egress.
7. Check Railway production `/api/health` and `/api/persistence/status`; require
   optimizer configuration readiness in the application response and separately
   check the production optimizer service health endpoint.
8. Confirm the application Vercel project contains no production database,
   agent-credential-database, provider, integration-key, integration-evidence,
   authentication-mail, SSO, worker, or session variable; has no production
   alias, reachable historical Production deployment, or automation bypass;
   and cannot reach production data or providers. Until this audit passes after
   Railway acceptance and credential revocation, record the platform as
   transitional rather than preview-only.
9. Compare against the previous review and record material drift, cost changes,
   decisions, and follow-up owners.

Infrastructure changes require explicit approval. The weekly review reports recommendations and drift; it does not automatically mutate Railway.

## Change Log

Entries below are historical observations and approved actions. Current
environment policy is defined above, not by superseded migration plans.

### 2026-09-14 — Release parity, retained development, and measured cost

#### Later daily-backup repair

After the operator approved the reliability pass, development's `DAILY`
six-day schedule was restored alongside its existing `WEEKLY` 27-day schedule.
No monthly schedule, PITR, production backup policy, resource limit, billing
limit, or environment topology was changed. The current $25 spending email
alert was independently confirmed; the $100 hard limit was left unchanged.
A new pre-change snapshot completed at `2026-09-15T00:32:02.501Z`; the scoped
daily/weekly freshness check passed. Development monthly coverage remains an
explicit retention-policy gap, not a passing result for the stricter default
backup audit. See [backup repair evidence](railway-postgres-backups.md#daily-coverage-repair--2026-09-14-edt).

#### Initial release and cost audit

- The operator requested completion of open development work, release parity,
  worktree cleanup, and a fresh cost assessment. This did not authorize another
  organization migration, hosted-development deletion, or public Mac hosting.
- Before this documentation consolidation, development ran `f8c0ef45` in
  successful deployment `c4004f50-b365-44e2-8289-6f54e230e4d6`; production ran
  `973c2aa3` in successful deployment `19d98a0e-dd64-490c-8c80-2eb13229f794`.
  The two commits had identical Git trees. Both health endpoints returned
  `status=ok`, no errors, and current database migrations; both persistence
  endpoints returned HTTP 200 with reachable Postgres.
- Railway's current September 1–October 1 workspace period showed **$30.24
  accrued usage**, **$52.08 projected usage**, and **$28.95 accrued for
  ClawPilot**. These are usage figures, not a settled invoice after credits or
  taxes. The observed hard spending limit was **$100**; no limit was changed.
- Postgres across the two environments accounted for **$16.25 accrued**:
  memory $8.79, egress $4.19, CPU $1.94, backup $0.80, and volume $0.53.
  Memory, not the configured volume ceiling, was the largest component.
  Both application database URLs used private networking. Both databases had
  `archive_mode=off`, and no PITR buckets remained. Accrued egress must not be
  treated as the ongoing post-PITR traffic rate. During the measured September
  7–14 week, Postgres public egress totaled about **0.0419 GB in production**
  and less than **0.000001 GB in development** (about $0.002 combined), versus
  $4.19 already accrued earlier in the billing period. This weekly window
  includes approximately three hours before the production PITR removal.
- Seven-day hourly metrics (169 samples, September 7–14) estimated development
  compute at **$26.44/month**, volume at **$1.43/month**, and egress at
  **$0.08/month**, excluding snapshots. Production's six services were about
  **$19.87/month** including compute, volume, and egress, excluding snapshots
  and other projects. All observed services were in US East. These estimates
  extrapolate measured load and can change with workload.
- If later approved, suspending development compute while retaining its
  volumes and backups could save roughly **$26/month**. Deleting the retained
  volumes would save only about another **$1.43/month plus backup charges**
  while introducing data-loss/recovery risk. A production-only workspace at
  the measured workload is estimated around **$23–27/month**, not guaranteed;
  retained development storage, other projects, credits, and taxes affect the
  final bill. The Pro plan's minimum remains $20/month, including $20 usage.
- Development is not an expendable copy of production: the read-only audit
  found **9 development organizations and 11,331 provider order candidates**,
  versus **8 production organizations and no provider order candidates**.
  Development retained active, credential-configured AG Alchemy Faire,
  Shopify, FedEx, and UPS integrations; French Florist Shopify; and Test Pro
  Bakery Bites Shopify and UPS. Those integrations were absent from
  production. Deleting development now would remove these working stores and
  history unless a separately approved preservation or migration plan were
  completed. Pausing compute would also interrupt their sync and webhooks.
- The read-only provider-backup audit at **2026-09-14 22:16 UTC** found
  production Daily, Weekly, and Monthly schedules, with the latest backup
  from 20:03 UTC that day (2.2 hours old). Development had only Weekly
  scheduled backups; its latest was September 12 at 07:34 UTC (62.7 hours
  old). Development therefore did not meet the documented 30-hour recovery
  gate. No backup schedule was changed by this audit; a fresh completed
  backup is required before any destructive development cleanup.
- SQL reported development database size **5,334 MiB (about 5.2 GiB)**, versus
  **221 MiB** in production; Railway volume usage was larger because it also
  includes database files outside the logical database. Development's legacy
  `operations_commerce_inventory_levels` and
  `operations_commerce_inventory_captures` occupied roughly 2,126 MiB and
  930 MiB. The levels table contained 31,398 rows with approximately 110 MiB
  of logical row data. Inventory capture payloads were already
  deduplicated: all 2,017 inspected capture rows referenced snapshot content
  and had null inline snapshots. Reusable allocated heap/index/TOAST space is
  not evidence of new duplicate inventory. Reclaiming 3 GB would save only
  about **$0.45/month in volume charges**; RAM/CPU savings are unmeasured.
- Do not run `VACUUM FULL`, drop tables, lower live memory ceilings, or remove
  development as automatic cost cleanup. A compaction needs a verified recent
  backup, temporary free space, and a maintenance window because it locks and
  rewrites the table. First prioritize measured compute, unnecessary polling,
  and the need for an always-on development stack.

Pricing checked against [Railway plans](https://docs.railway.com/pricing/plans)
and [cost control](https://docs.railway.com/pricing/cost-control): RAM
$10/GB-month, CPU $20/vCPU-month, egress $0.05/GB, and volume $0.15/GB-month.
The production estimate includes all six service runtimes, including the
career browser. Simply enabling
[Serverless](https://docs.railway.com/deployments/serverless) is not a reliable
saving for the current polling workers and persistent database connections;
private traffic also prevents sleep, and cold starts can delay callbacks.
Repeat the usage
and metrics audit before adopting a cost change; do not reduce a resource
ceiling and claim savings without measuring actual utilization.

### 2026-09-07 — Production PITR removed for cost control

- The operator approved removing production PITR to reduce Railway usage.
  This supersedes the earlier decision to retain production PITR; development
  PITR remains disabled.
- Before removal, Railway reported workspace usage of **$17.92** and a monthly
  estimate of **$41.38**. The dedicated production `Postgres-PITR` bucket held
  11,506,638,498 bytes across 70,490 objects. These are a point-in-time baseline,
  not a measurement of expected savings; incurred charges are not reversed by
  removing PITR.
- The authenticated Railway dashboard showed Daily, Weekly, and Monthly
  production snapshot schedules enabled, with a completed Daily snapshot five
  hours old and a reported size of 1,001 MB before the change.
- Removed all six production `WAL_ARCHIVE_*` variables and redeployed Postgres
  once. Deployment `11102868-ce2b-4438-a00f-fd53e1d7ee97` reached `SUCCESS`.
  Direct production SQL verification returned `archive_mode = off`,
  `archive_command = (disabled)`, `archive_timeout = 0`, and
  `pg_is_in_recovery() = false`.
- Deleted the dedicated production `Postgres-PITR` bucket
  (`9fd602c2-3bd2-4ea6-870b-0a1e189ccfd6`); the deletion was committed and the
  production bucket inventory was empty afterward. Its archived recovery
  history was removed and cannot be used for a future PITR restore. The
  database volume and scheduled snapshots were retained.
- Post-change verification on 2026-09-07 EDT (2026-09-08 UTC) confirmed both
  environments' `/api/health` and `/api/persistence/status` returned HTTP 200.
  A new-deployment query for `archive-push`/`pgbackrest` logs since
  `2026-09-08T01:17:30Z`, with a 5,000-row limit, returned zero entries. This
  bounded post-restart check does not establish a full-day traffic rate.
- Retain daily, weekly, and monthly provider snapshots and the requirement for
  a completed backup no more than 30 hours old. Recovering from a snapshot may
  lose writes made after that snapshot; arbitrary-time recovery is unavailable.
- Reassess production PITR at customer onboarding. This decision does not
  authorize service suspension, DEV retirement, a spending-limit change, or
  unrelated resource-ceiling changes.

### 2026-08-02 — Development PITR disabled

- Railway projected approximately **$130.23** for the month after only **$5.67** had accrued early in the billing period.
- Postgres accounted for approximately **$4.83**, including **$3.78** of external egress.
- Development Postgres was observed sending roughly 505 MB to external object storage in about six minutes while pgBackRest repeatedly started backup work and logged repository timeouts.
- Removed all development `WAL_ARCHIVE_*` variables, deleted the dedicated development PITR bucket, and redeployed development Postgres.
- Confirmed the new Postgres deployment reached `SUCCESS`, WAL archive events stopped after restart, and ClawPilot health and persistence endpoints returned HTTP 200.
- Production PITR was deliberately retained because its archive traffic was normal and its recovery value outweighed the small observed cost.

### 2026-08-01 — Initial cost controls

- Enabled Wait for CI across development and production.
- Added Railway workspace spending controls: $25 soft alert and $40 hard limit.
- Routed development fulfillment-optimizer calls over Railway private networking.
- Applied the current CPU and memory ceilings listed in this register.
- Verified relevant Railway deployments and ClawPilot health/persistence endpoints after rollout.

## Decision Triggers

Revisit this baseline when any of the following occurs:

- the first customer is scheduled for onboarding;
- monthly usage approaches the $25 alert;
- fulfillment optimization concurrency or order volume materially increases;
- any service repeatedly exceeds 70% memory or CPU utilization;
- recovery-point or recovery-time objectives change;
- a service becomes safe to suspend, sleep, or move to an event-driven boundary;
- public egress, deployment churn, or backup cost materially increases week over week.

Related operating contracts: [ClawPilot Environments and Deployment](clawpilot-environments.md), [Railway Postgres Backups](railway-postgres-backups.md), and [Knowledge Vault Organization](knowledge-vault-organization.md).
