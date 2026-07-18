---
id: cp-map-platform-data
title: Platform and Data Map
summary: Systems of record, identity boundaries, synchronization flows, and external service projections.
status: active
kind: map-of-content
area: architecture
tags: [clawpilot, moc, architecture, data, integrations, synchronization]
app_visible: true
---

# Platform and Data Map

## Authority By Data Type

| Concern | Authority | Projection or operator surface |
| --- | --- | --- |
| Users, organizations, boards, tasks, docs, short links, audit, execution | Railway Postgres | ClawPilot UI |
| Pipeline operator rows | Managed Google Sheet | Postgres pipeline projection and CRM |
| CRM application modules and subpanels | ClawPilot Postgres model | SuiteCRM |
| Calendar and email provider state | Connected user account | ClawPilot CRM interactions and meetings |
| Deployment history | Postgres release entries | Versions and Build Brief |
| Repository knowledge | Git-tracked Markdown | Owner Docs catalog and vectors |
| Toast restaurant sales and orders | Toast read-only APIs | Immutable snapshots, daily projections, and accounting drafts in Postgres |
| Posted accounting transactions | Connected QuickBooks company | Approved accounting outbox and provider transaction reference |

## Identity Graph

- Workspace organizations and app users have permanent random Global IDs.
- CRM accounts, contacts, products, leads, opportunities, meetings, interactions, and campaigns use module-specific Global IDs.
- Global IDs are never reused after archive or deletion.
- Organization membership defines data scope; global application permissions are a separate control.
- See [Organization-Rooted Tenancy](../decisions/0002-organization-rooted-tenancy.md) and [CRM Global Identity and Synchronization](../decisions/0003-crm-global-identity-and-sync.md).

## Synchronization Graph

```mermaid
flowchart LR
  UI[ClawPilot UI] --> PG[Railway Postgres]
  Sheet[Google Sheet] <--> Outbox[Pipeline Sync Outbox]
  Outbox <--> PG
  PG --> CRMOutbox[SuiteCRM Outbox]
  CRMOutbox --> SuiteCRM[SuiteCRM]
  SuiteCRM --> Inbound[Inbound Reconciliation]
  Inbound --> PG
  Providers[Mail and Calendar] <--> Actions[Integration Actions]
  Actions <--> PG
  Toast[Toast APIs] --> ToastWorker[Toast Ingestion Worker]
  ToastWorker --> PG
  PG --> AccountingDraft[Accounting Draft Review]
  AccountingDraft --> QuickBooks[Authorized QuickBooks Connector]
```

## Connected Contracts

- [Pipeline and Synchronization](../modules/pipeline-and-sync.md)
- [CRM and Workbook Reporting](../modules/crm-and-reporting.md)
- [User Integrations and Credentials](../modules/user-integrations.md)
- [Toast Sales and Accounting](../modules/toast-and-accounting.md)
- [Shared Short Links](../modules/short-links.md)
- [Postgres and Sheets Authority](../decisions/0001-postgres-and-sheets-authority.md)
- [Google Workspace Integration](../operations/google-workspace-integration.md)
- [SuiteCRM Railway Runbook](../operations/suitecrm.md)
