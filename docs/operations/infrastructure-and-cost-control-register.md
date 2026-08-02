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

## Platform Baseline

| Platform | Responsibility | Current boundary |
| --- | --- | --- |
| GitHub | Source and validation | `dev` is the development branch; promotion normally uses a pull request to `main`; Railway waits for successful GitHub Actions before deploying connected services. |
| Railway | Stateful and service runtime | ClawPilot, Postgres, SuiteCRM, MariaDB, and the development fulfillment optimizer. |
| Vercel | Protected web previews | Preview validation remains separate from Railway service and database health. |
| Google Sheets | Operator-owned pipeline tables | Remains writable for pipeline workflows. |
| Railway Postgres | Durable application-owned records | Requires `CLAWPILOT_STORAGE=postgres` and `DATABASE_URL`; production fallback must not silently mask database failure. |

## Railway Environments

### Development

| Service | Resource ceiling | Cost and connectivity policy |
| --- | --- | --- |
| ClawPilot | 2 vCPU / 2 GB | Uses private Railway connectivity for the fulfillment optimizer. |
| Postgres | 2 vCPU / 4 GB | Scheduled volume backups retained; PITR and external WAL archiving disabled while development contains no customer data. |
| SuiteCRM | 2 vCPU / 2 GB | Always-on until an approved suspension or serverless plan accounts for CRM workflows and volume behavior. |
| MariaDB | 1 vCPU / 1 GB | Supports SuiteCRM; do not suspend independently while SuiteCRM is active. |
| Fulfillment optimizer | 1 vCPU / 1 GB | Isolated service; ClawPilot calls `fulfillment-optimizer.railway.internal:8080`. Reassess concurrency and scaling from measured order volume before customer onboarding. |

### Production

| Service | Resource ceiling | Recovery policy |
| --- | --- | --- |
| ClawPilot | 2 vCPU / 2 GB | One replica; validate `/api/health` and `/api/persistence/status` after infrastructure changes. |
| Postgres | 2 vCPU / 4 GB | Keep PITR/WAL archiving and scheduled daily, weekly, and monthly volume backups. |
| SuiteCRM | 2 vCPU / 2 GB | Supported by the production MariaDB service and persistent volume. |
| MariaDB | 1 vCPU / 1 GB | Do not suspend independently while SuiteCRM is active. |

Resource ceilings contain abnormal growth; they do not reduce charges when actual utilization is already below the ceiling.

## Cost Controls

- Railway workspace soft alert: **$25**.
- Railway workspace hard limit: **$40**. Reaching it can stop workloads; treat the alert as an intervention threshold rather than a normal budget target.
- Wait for CI is enabled to avoid deploying commits before GitHub Actions completes successfully.
- Development service-to-service traffic should use Railway private networking whenever both services are in the project and environment.
- Do not infer monthly savings from a short metrics window. Compare current and previous billing-period line items and separate CPU, memory, egress, volume, and backup charges.
- Review deployment churn because repeated builds and replacements can create avoidable usage even when runtime utilization is low.

## Backup And Recovery Policy

- **Development:** daily, weekly, and monthly Railway volume snapshots remain the recovery control. PITR is intentionally disabled until customer data or recovery-point objectives justify its egress and storage cost.
- **Production:** retain both scheduled volume snapshots and PITR. Production uses a separate archive bucket and must not inherit development cleanup actions.
- Before destructive data work, verify a recent provider backup and follow [Railway Postgres Backups](railway-postgres-backups.md).
- Never treat an application checkpoint stored in Postgres as a replacement for provider-native recovery.

## Weekly Review

Run this review weekly and before onboarding a customer:

1. Record workspace current usage, monthly estimate, soft-limit state, and hard-limit state.
2. Break project cost down by service and by CPU, memory, egress, volume, and backup.
3. Confirm development and production service inventories, replica counts, deployment states, sleep/serverless settings, and resource ceilings.
4. Confirm Wait for CI remains enabled and development optimizer traffic still uses private networking.
5. Confirm development Postgres has no `WAL_ARCHIVE_*` variables or external PITR traffic.
6. Confirm production Postgres PITR remains enabled and scheduled provider backups are current.
7. Inspect deployment churn, failed/restarted deployments, database archive errors, and unexpected public egress.
8. Check development and production `/api/health` and `/api/persistence/status`, plus optimizer health when deployed.
9. Compare against the previous review and record material drift, cost changes, decisions, and follow-up owners.

Infrastructure changes require explicit approval. The weekly review reports recommendations and drift; it does not automatically mutate Railway.

## Change Log

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
