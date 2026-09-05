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

## Purpose

This is the durable operating record for ClawPilot infrastructure, cost controls, and approved configuration changes. Read it before changing Railway topology, service limits, networking, deployment triggers, backups, or spending controls. Verify every time-sensitive value against Railway before acting; this document records the intended baseline, not a substitute for live evidence.

## Accepted Target And Current Cutover Drift

The table is the required post-cutover baseline. It is not yet a verified live
inventory. A read-only Vercel audit on `2026-09-05` found legacy
production-scoped `DATABASE_URL`, `AGENT_CREDENTIAL_DATABASE_URL`,
authentication-mail, integration-evidence, and Google SSO assignments still on
the application project, with no `INTEGRATION_CREDENTIAL_*` variable. Vercel is
therefore still transitional and must not be called preview-only. Its public
alias reached production Postgres and 24 READY Production artifacts retained
their build-time environment, so variable deletion alone is not a retirement.
After Railway passes exact-commit health, persistence, worker, and authenticated
UI acceptance, remove the alias and every legacy Vercel assignment, disable or
delete historical production artifacts, then revoke or rotate the database,
session, worker, Maton, provider, and webhook authority they held. Encryption
and evidence keys require a separately reviewed data migration rather than
blind rotation. Re-audit without printing values. The detailed order and stop
conditions live in
[ClawPilot Environments and Deployment](clawpilot-environments.md).

| Platform | Responsibility | Intended boundary |
| --- | --- | --- |
| GitHub | Source and validation | `dev` is the development branch; promotion normally uses a pull request to `main`; Railway waits for successful GitHub Actions before deploying connected services. |
| Railway | Sole hosted production runtime after acceptance | Production ClawPilot, Postgres, SuiteCRM, MariaDB, and an isolated fulfillment optimizer. No always-on Railway development stack remains. |
| Vercel | Protected compile/UI previews after retirement | The application project must have no production database, provider, session-secret, worker, or write authority after the gated cleanup. The separately scoped remote-local gateway only proxies to the authenticated Mac runtime. |
| Google Sheets | Operator-owned pipeline tables | Remains writable for pipeline workflows. |
| Railway Postgres | Durable application-owned records | Requires `CLAWPILOT_STORAGE=postgres` and `DATABASE_URL`; production fallback must not silently mask database failure. |

## Railway Production Environment

| Service | Resource ceiling | Recovery policy |
| --- | --- | --- |
| ClawPilot | 2 vCPU / 2 GB | One replica; validate `/api/health` and `/api/persistence/status` after infrastructure changes. |
| Postgres | 2 vCPU / 4 GB | Keep PITR/WAL archiving and scheduled daily, weekly, and monthly volume backups. |
| SuiteCRM | 2 vCPU / 2 GB | Supported by the production MariaDB service and persistent volume. |
| MariaDB | 1 vCPU / 1 GB | Do not suspend independently while SuiteCRM is active. |
| Fulfillment optimizer | Production ceiling set from measured load | Isolated production service; ClawPilot uses the exact private endpoint `http://fulfillment-optimizer.railway.internal:8080`. Missing service or invalid application configuration is capability drift and blocks parity sign-off. |

Resource ceilings contain abnormal growth; they do not reduce charges when actual utilization is already below the ceiling.

The target Railway topology hosts production only. Local development and, after
credential retirement, protected Vercel previews
provide pre-production code and UI evidence without duplicating the Railway
service topology. They are not provider, worker, callback, persistence, or
production-parity evidence. A future hosted development restoration requires a
separately approved, fully isolated stack and acceptance; retained branch,
script, or migration support does not make that stack active.

During the current transition, the frozen Railway `development` environment is
still retained as the selective-migration source. It remains a backup target and
billable resource until migration postflight, archive verification, and its
distinct retirement acceptance receipt succeed.

## Cost Controls

- Railway workspace soft alert: **$25**.
- Railway workspace hard limit: **$40**. Reaching it can stop workloads; treat the alert as an intervention threshold rather than a normal budget target.
- Wait for CI is enabled to avoid deploying commits before GitHub Actions completes successfully.
- Until DEV retirement is accepted, keep its application workers stopped,
  permit only bounded migration-source access, audit both development and
  production backups, and track its remaining compute, volume, backup, and
  egress charges. After acceptance, confirm the Railway development services
  and volumes are absent and no longer accruing charges.
- Do not infer monthly savings from a short metrics window. Compare current and previous billing-period line items and separate CPU, memory, egress, volume, and backup charges.
- Review deployment churn because repeated builds and replacements can create avoidable usage even when runtime utilization is low.

## Backup And Recovery Policy

- **Development during cutover:** retain the frozen Railway source and its
  scheduled recovery controls until migration postflight, archive verification,
  and the DEV-retirement receipt are accepted. After retirement, retain only
  the separately reviewed migration archive required by the cutover contract.
- **Production:** retain both scheduled volume snapshots and PITR. Production
  recovery data must not be removed by development-retirement cleanup.
- Before destructive data work, verify a recent provider backup and follow [Railway Postgres Backups](railway-postgres-backups.md).
- Never treat an application checkpoint stored in Postgres as a replacement for provider-native recovery.

## Weekly Review

Run this review weekly and before onboarding a customer:

1. Record workspace current usage, monthly estimate, soft-limit state, and hard-limit state.
2. Break project cost down by service and by CPU, memory, egress, volume, and backup.
3. Confirm the production service inventory, replica counts, deployment state,
   resource ceilings, and private optimizer endpoint.
4. Confirm Wait for CI remains enabled for production and no retired Railway
   development service, database, volume, backup schedule, or public domain is
   accruing cost.
5. Confirm production Postgres PITR remains enabled and scheduled provider
   backups are current.
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

Entries below are historical observations and approved actions. They do not
recreate or authorize a current Railway development environment.

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
