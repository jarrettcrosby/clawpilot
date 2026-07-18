---
id: cp-ops-sales-pipeline-episcs-migration
title: Sales Pipeline EPISCS Migration
summary: Operator runbook for moving the established sales CRM workspace from Suburbia Sandwich Co to EPISCS without crossing tenant boundaries.
status: active
kind: operator-runbook
area: operations
tags: [clawpilot, crm, pipeline, episcs, migration, tenancy]
app_visible: false
---

# Sales Pipeline EPISCS Migration

## Purpose

The established **Sales pipeline** and its customer CRM graph belong to **Express Parcel International DBA EPISCS**. Earlier builds provisioned that graph under **Suburbia Sandwich Co**. `scripts/migrate-sales-pipeline-to-episcs.mjs` performs the one-time ownership correction without copying records or granting EPISCS access to Suburbia users.

## Boundary

The migration moves the Sales pipeline, its workbook, CRM organizations, contacts, opportunities, interactions, meetings, leads, campaigns, products, the operator's matching CRM Board, related documents, record short links, and attributable audit history into the EPISCS workspace.

Suburbia user memberships remain Suburbia memberships. CRM organization projections whose relationship is `workspace_member` remain with Suburbia and are attached to its placeholder pipeline. CRM boards and generated documents owned by users without active EPISCS membership are rebound to those users' own Suburbia pipelines. The command refuses to continue if one of those excluded records has dependent CRM data or a non-owner board has comments.

The Sales root CRM row receives the existing EPISCS Account identity. The placeholder root receives the existing Suburbia Account identity. Global IDs and SuiteCRM IDs are exchanged with their business identities rather than reallocated. Customer parent relationships, root contacts, root interactions, and root meetings are restaged through the SuiteCRM outbox. The Google workbook is queued for EPISCS branding after commit.

## Safety Contract

- The command is a dry run unless `--apply` is supplied.
- Every run uses a serializable transaction and a transaction-scoped advisory lock.
- A dry run executes all updates and validations, then rolls back.
- Apply mode requires the exact confirmation value `MOVE_SALES_PIPELINE_TO_EPISCS`.
- The operator must be an active EPISCS owner or admin.
- Workspace, pipeline, root CRM, board, record-count, relationship, document, projection, and access assertions must all pass before commit.
- A completed migration is idempotent and reports `already-complete`.

## Run

Resolve `DATABASE_URL` from the Railway Postgres service for the intended environment. Do not store the URL in a file or shell history.

```bash
CLAWPILOT_MIGRATION_ACTOR='operator@example.com' \
CLAWPILOT_MIGRATION_ENVIRONMENT='development' \
DATABASE_URL='resolved Railway Postgres URL' \
npm run crm:migrate-sales-to-episcs -- --json
```

Review the complete dry-run summary. Apply only after the reported source, target, pipeline, excluded member organizations, non-owner board bindings, moved documents, links, CRM counts, and SuiteCRM restage counts match the live inventory.

```bash
CLAWPILOT_MIGRATION_ACTOR='operator@example.com' \
CLAWPILOT_MIGRATION_ENVIRONMENT='development' \
CLAWPILOT_EPISCS_MIGRATION_CONFIRM='MOVE_SALES_PIPELINE_TO_EPISCS' \
DATABASE_URL='resolved Railway Postgres URL' \
npm run crm:migrate-sales-to-episcs -- --apply --json
```

Run development first. Promote the tested command through the normal `dev` to `main` pull request before production execution.

## Verify

1. Rerun the command without `--apply`; it must report `already-complete`.
2. Confirm the Sales pipeline, workbook link, CRM Board, documents, and record links appear only in EPISCS.
3. Confirm Suburbia members cannot access the EPISCS pipeline and retain their Suburbia boards and pipelines.
4. Confirm CRM counts match the apply summary and every contact, opportunity, interaction, and meeting resolves to an organization in the same pipeline.
5. Wait for the SuiteCRM and Google Sheets outbox work to settle; investigate any failed item before promotion.
6. Verify SuiteCRM parent Accounts, root Contacts, interaction/meeting subpanels, Global IDs, and workbook branding.
7. Verify `/api/health`, `/api/persistence/status`, `/api/agents`, `/api/pipeline/sync-status`, and `/api/tasks` in the affected environment.
8. Verify the `crm.pipeline_workspace.migrated_in` and `crm.pipeline_workspace.migrated_out` audit entries.

## Recovery

There is no automatic reverse command. A failed run rolls back before commit. After a committed run, use the Railway Postgres backup and restore procedure in [Railway Postgres Backups](railway-postgres-backups.md), then reconcile SuiteCRM and Google outbox side effects before reopening the application.
