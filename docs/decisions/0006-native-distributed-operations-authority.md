---
id: cp-decision-0006
title: Native Distributed Operations Authority and Adapter Boundaries
summary: ClawPilot Postgres owns operational state while CRM, commerce, carrier, printing, optimization, and accounting systems connect through narrow adapters.
status: active
kind: decision-record
area: distributed-operations
date: 2026-07-22
decision_status: accepted
tags: [clawpilot, decision, dom, wms, 3pl, postgres, adapters]
app_visible: false
---

# 0006 - Native Distributed Operations Authority and Adapter Boundaries

## Context

ClawPilot is adding distributed order management, warehouse management, shipping, and 3PL billing. The target crosses current CRM, products, users, permissions, audit, tasks, documents, provider integrations, and accounting workflows. Without an explicit authority decision, each commerce platform, carrier, Sheet, optimizer, or future service could become a competing record of orders, inventory, plans, or charges.

ClawPilot already has two important authority decisions:

- [Decision 0001](0001-postgres-and-sheets-authority.md) makes Postgres authoritative for app-owned data while preserving one managed Google Sheet as the writable pipeline opportunity table.
- [Decision 0003](0003-crm-global-identity-and-sync.md) preserves SuiteCRM authority for CRM records and permanent Global IDs across projections.

Distributed operations needs a narrower decision for operational objects and external side effects. The requirements also assume several shared modules that do not currently exist as general services, including Contracts, Cases, logistics Documents, Notifications, and a generic rules engine. The module must not hide those gaps by building provider-specific parallel systems.

## Decision

Distributed operations is a native ClawPilot module. Railway Postgres is the authority for canonical operational state, immutable operational evidence, and outbound intent. The module lives in the existing Next.js application shell, session and workspace model, route-handler conventions, persistence layer, audit framework, and worker topology. It is not a separate application and does not use Google Sheets as an operations database.

The active `workspace_organization` owns every operations aggregate. An authorized pipeline may bind the first slice to current CRM organization/product projection rows, but pipeline and Sheet ownership do not determine operations authority. Permanent Global IDs remain the cross-module identity.

### Authority By Data Type

| Data | Authority | External/shared relationship |
| --- | --- | --- |
| Users, active workspace, roles, permissions, sessions | ClawPilot Postgres identity and membership model | Provider credentials never grant application access |
| Customer organizations, contacts, products, CRM history | SuiteCRM CRM authority with ClawPilot Postgres projection | Operations references existing `ga`, `gc`, and `gp` identities through a CRM adapter |
| Canonical imported orders and revisions | ClawPilot Postgres operations domain | Commerce provider remains source of its remote order/event; reconciliation translates changes into commands |
| Warehouses, locations, pools, eligibility, reservations, plans, waves, tasks, packages, shipments | ClawPilot Postgres operations domain | Physical/provider observations become validated commands and immutable facts |
| Inventory quantity and ownership | Immutable ClawPilot inventory ledger, with materialized position projections | Physical counts or provider inventory are reconciliation inputs, not direct balance overrides |
| Promise, carton, rate, optimizer, rule, and override decisions | Versioned ClawPilot input/result snapshots | Carrier and optimizer responses are evidence; application policy selects and validates |
| Labels, print jobs, tracking observations | ClawPilot transaction/intention evidence plus reconciled carrier result | Carrier owns its remote label/tracking record; print agent owns transport acknowledgement only |
| Contract versions, pricing directives, calculated billable facts | Native ClawPilot operations contract/billing domain | CRM identifies the customer; accounting adapter receives approved exports |
| Posted accounting transaction | Connected accounting system | ClawPilot retains approved export, provider reference, and reconciliation status |
| Pipeline opportunity rows | Existing managed Google Sheet exception from Decision 0001 | This exception does not extend to any operations data |

### Adapter Boundary

Every external or shared integration implements a narrow port owned by the operations application layer:

- **CRM/product adapter:** resolves authorized CRM projections and Global IDs; it does not create operations-owned customer/product masters.
- **Commerce adapter:** verifies webhooks, maps provider payloads to canonical commands, exposes capabilities/cursors, and sends fulfillment/tracking intents. It cannot reserve inventory or choose policy.
- **Carrier adapter:** rates package snapshots and executes idempotent label/void/tracking/manifest commands. It cannot choose a warehouse, alter a package, or confirm inventory.
- **Optimizer adapter:** receives one immutable bounded input snapshot and returns typed candidates/constraint evidence. It has no database, provider credential, or command authority.
- **Printer gateway:** claims a durable print job for an enrolled warehouse/printer and reports a fenced outcome. It cannot create or repurchase a label.
- **Task/case adapter:** creates or links authorized work from an operations exception. Projects is the current task target; a future Cases module remains a separate boundary.
- **Document adapter:** renders and stores logistics artifacts under a retention/access policy. Current knowledge documents are not silently repurposed as a label/BOL store.
- **Notification adapter:** accepts a typed, authorized alert intent with recipient policy and deduplication. POS-specific notification tables are not reused as a general service.
- **Accounting adapter:** exports approved immutable billable facts or adjustments. It cannot recalculate a contract or mutate operational history.

Adapters translate protocol and capability. They do not contain customer allocation rules, contract calculations, authorization, inventory mutation, state transition, or optimizer objective policy. Adapter code cannot write operations domain tables directly.

### Transaction And Delivery Boundary

A consequential command commits its aggregate mutation, immutable ledger/domain evidence, audit event, and required outbox intent in one Postgres transaction. Network calls occur after commit through leased, retryable workers. Provider completion uses the original idempotency key and a lease/fencing token.

`operations_domain_events` is the durable business-event journal. It is not by itself a delivery queue. External and asynchronous internal effects use the existing outbox pattern or a later operations-specific queue with equivalent leases, retries, dead letters, health, and replay controls.

Provider timeouts that may have completed remotely enter an unknown/reconciliation state. They do not become permission to repeat a label purchase, shipment confirmation, or accounting export under a new key.

### Identity And Security Boundary

- Every tenant-owned row carries `organization_id`; composite foreign keys and command authorization prevent cross-tenant relationships.
- Customer portal access adds CRM customer/subaccount scope and field policy. It is narrower than workspace membership.
- Global IDs are immutable business references; UUIDs remain internal relational keys; external IDs remain scoped aliases.
- Browser commands use the signed-in effective user and typed operations permissions. Workers, optimizer, commerce webhooks, and print agents use separate least-privilege identities.
- Credential references are opaque and server-resolved. Raw secrets, provider tokens, labels, and sensitive payloads are excluded from client responses, events, audit, and logs.
- AI may summarize or recommend but is never the authority for inventory, contract calculation, rating, label purchase, shipment confirmation, or an override.

### Missing Shared Capabilities

When ClawPilot lacks a reusable shared service, the first slice may add an explicit operations-owned bridge or domain service with a narrow interface. It may not claim a nonexistent general module or create an unbounded second platform service. A later shared-service extraction requires a separate decision when at least two real modules share the contract.

This applies to rule evaluation, cases, logistics documents, notifications, and contract/billing workflows. Tasks, audit, identity, CRM, products, outboxes, secrets, and accounting approval patterns are reused where they actually exist.

## Consequences

- Postgres backup, restore, migration checksums, ledger reconciliation, and outbox recovery become release-critical operations controls.
- Commerce platforms cannot directly allocate stock or define ClawPilot order state. Carrier results cannot directly confirm shipments. Solver results cannot relax hard constraints.
- A provider adapter can be replaced without changing canonical aggregates, Global IDs, state machines, or historical calculation evidence.
- Google Sheets remains useful for sales pipeline opportunities but cannot become an order, inventory, wave, shipment, or billing write surface.
- SuiteCRM remains the CRM authority, while operational contracts and billable facts are native because no current general Contracts/Billing module owns them.
- The initial schema must be corrected where it confuses immutable facts with mutable lifecycle, lacks typed permissions, or cannot preserve required snapshots and split plans.
- External reconciliation is mandatory because ClawPilot cannot atomically commit its Postgres transaction and a provider transaction.
- Local file-backed development cannot validate authoritative inventory or operations concurrency; focused acceptance requires Postgres.

## Rejected Alternatives

### Separate DOM/WMS Application

Rejected because it would duplicate identity, tenancy, CRM/product links, audit, tasks, UI, secrets, release controls, and reporting while introducing distributed consistency before the domain requires it.

### Commerce Platform As Canonical Order And Inventory Store

Rejected because multi-channel inventory ownership, shared pools, warehouse execution, contract pricing, and cross-provider reconciliation require one tenant-scoped operational authority.

### Google Sheets As Operations Authority

Rejected because atomic reservation, ledger integrity, idempotency, row-level security, label uniqueness, provider attempts, and append-only billing evidence are incompatible with a general editable table.

### Solver Or AI As Decision Authority

Rejected because hard constraints, replay, exact money, safety fallbacks, explanations, and authorized overrides must remain deterministic and auditable when a solver/model is unavailable or wrong.

### Provider SDK Calls Inside Domain Transactions

Rejected because network latency and ambiguous outcomes would hold locks, create partial commits, and make retries capable of duplicate financial or shipping effects.

### Immediate Generic Platform Abstractions

Rejected for missing capabilities such as rules, cases, notifications, and logistics documents. The first implementation uses explicit ports and extracts a shared service only from proven cross-module requirements.

## Implementation Conditions

This decision accepts the authority and boundary model, not the current completeness of migration `0081`. Runtime activation still requires the blockers, phase gates, and 25 scenarios in the connected discovery, architecture, delivery, and runbook documents.

## Connected Notes

- [Distributed Operations](../modules/distributed-operations.md)
- [Distributed Operations Integration and Gap Map](../maps/distributed-operations-integration-gap-map.md)
- [Distributed Operations Delivery, Migration, and Test Plan](../architecture/distributed-operations-delivery-plan.md)
- [Distributed Operations Runbook](../operations/distributed-operations-runbook.md)
- [Postgres and Sheets Authority](0001-postgres-and-sheets-authority.md)
- [CRM Global Identity and Synchronization](0003-crm-global-identity-and-sync.md)
- [Organization-Rooted Tenancy](0002-organization-rooted-tenancy.md)
- [Multi-Workspace User Membership](0005-multi-workspace-membership.md)
