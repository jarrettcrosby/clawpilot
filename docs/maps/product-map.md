---
id: cp-map-product
title: Product Map
summary: User-facing workflows and the module contracts that define the ClawPilot product.
status: active
kind: map-of-content
area: product
tags: [clawpilot, moc, product, workflows, modules]
app_visible: true
---

# Product Map

ClawPilot is a private operating workspace that connects work boards, pipeline data, CRM relationships, documents, and authenticated AI execution without collapsing user or organization boundaries.

## User Journey

1. [Application Shell and Access](../modules/application-shell-and-access.md) authenticates the user and applies role and permission boundaries.
2. [Projects and Tenancy](../modules/projects-and-tenancy.md) provides personal and shared boards, including account-scoped CRM boards.
3. [Pipeline and Synchronization](../modules/pipeline-and-sync.md) provides the sales operating view and its managed Google Sheet.
4. [CRM and Workbook Reporting](../modules/crm-and-reporting.md) connects organizations, contacts, opportunities, meetings, interactions, campaigns, SuiteCRM, and reporting.
5. [Agents and Execution](../modules/agents-and-execution.md) routes task-linked conversations to authenticated user agents and preserves results.
6. [Knowledge, Releases, and Checkpoints](../modules/knowledge-releases-and-checkpoints.md) provides private briefs, hybrid search, releases, and recovery checkpoints.
7. [Shared Short Links](../modules/short-links.md) exposes controlled organization-scoped links to records and managed resources.
8. [User Integrations and Credentials](../modules/user-integrations.md) lets each user connect the external services used by those workflows.
9. [Toast POS and Accounting](../modules/toast-and-accounting.md) provides restaurant sales, order/check detail, and controlled accounting drafts.
10. [QuickBooks Accounting Connector](../modules/quickbooks-accounting.md) binds each active business to its own accounting catalog and controls customer/product CRM reconciliation, accounting writes, and Toast mappings.

The [ClawPilot Identity](../brand/clawpilot-identity.md) contract keeps those surfaces visually and verbally consistent.

## Planned Distributed Operations

[Distributed Operations](../modules/distributed-operations.md) defines the draft native order, inventory, fulfillment, warehouse, shipping, and 3PL billing contract. Its [integration and gap map](distributed-operations-integration-gap-map.md) records which current ClawPilot services can be reused and which capabilities remain unimplemented. This design is not part of the current user journey until its phased gates pass.

## Cross-Module Paths

- CRM organization, contact, or product -> Global ID -> short link -> ClawPilot editor -> SuiteCRM projection.
- Pipeline opportunity -> Postgres projection -> Google Sheet operator row -> CRM opportunity and reporting.
- Project card -> assigned app agent -> user ChatGPT authorization -> execution log and result -> task thread.
- User profile -> organization membership -> CRM account/contact -> Drive folder and pipeline resource scope.
- Release -> Versions entry -> Build Brief -> searchable knowledge catalog.
- Toast restaurant -> immutable source snapshot -> sanitized POS order/check projection -> daily sales -> reviewable accounting draft.
- User QuickBooks authorization -> active organization binding -> read-only catalog -> configurable CRM customer/product reconciliation and Toast account mappings.
- Commerce order -> canonical operations order -> eligible inventory reservation -> fulfillment/package/rate plan -> warehouse execution -> shipment and billable facts (planned).

## Product Authority

The module contracts above define current behavior. Proposed ideas belong on a project board until accepted; they do not become product truth merely because they appear in a conversation or old note.
