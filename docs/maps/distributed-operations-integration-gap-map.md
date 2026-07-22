---
id: cp-map-distributed-operations-integration-gaps
title: Distributed Operations Integration and Gap Map
summary: Discovery record for the ClawPilot services reused by distributed order, warehouse, and 3PL operations and the gaps still requiring delivery.
status: active
kind: architecture-map
area: distributed-operations
tags: [clawpilot, dom, wms, 3pl, discovery, integrations, gaps]
app_visible: false
---

# Distributed Operations Integration and Gap Map

## Purpose And Truth Labels

This is the discovery baseline for a native ClawPilot distributed order management (DOM), warehouse management (WMS), and 3PL operations module. It records repository state inspected on 2026-07-22 and separates four kinds of truth:

- **Existing** means the capability is present in current ClawPilot code or an accepted active contract.
- **Development foundation** means migration `db/migrations/0081_distributed_operations_foundation.sql` and its bounded application services are committed on `dev`, tested, and applied in development. It is not proof of production activation.
- **Implemented development slice** means a committed, tested runtime contract exists behind mock adapters or an internal boundary. It does not imply a certified provider integration.
- **Gap** means a service, contract, data model, worker, API, UI, test, or operating control still has to be designed or implemented.

The target behavior lives in [Distributed Operations](../modules/distributed-operations.md). Delivery order and acceptance evidence live in the [delivery plan](../architecture/distributed-operations-delivery-plan.md). No document in this set claims that a commerce, carrier, optimizer, printer, billing, or warehouse workflow is currently live.

## Existing Platform Discovery

| Concern | Existing ClawPilot contract or implementation | Reuse rule | Status and gap |
| --- | --- | --- | --- |
| Application architecture | Next.js App Router and React live under `app_src`; route handlers are under `app_src/app/api`; domain and persistence code is under `app_src/lib`; MUI is the component system. Operations uses those same native boundaries. | Keep operations as a native section, route family, domain service, and persistence adapter. | **Implemented development slice.** There is no plugin runtime or independent operations application boundary. |
| Module registration | `app_src/components/Navigation.tsx` owns a static `NAV_ITEMS` list and `app_src/app/HomeClient.tsx` owns static section imports and rendering. | Follow the existing static section pattern for the first slice. Introduce a registry only as a separate platform decision. | **Existing but manual.** There is no current module-registration service to reuse. |
| Global IDs | Permanent CRM Global IDs are allocated through `crm_reference_registry`, `crm_reference_number_registry`, and `allocate_crm_reference`; numeric suffixes are globally exclusive and never reused. | Extend the registry and allocator; continue using UUID primary keys internally and Global IDs for business references, events, URLs, and cross-module links. | **Existing and extended by foundation draft.** `0081` proposes typed prefixes and `allocate_global_reference`. Missing target prefixes include quote, return, inventory unit/LPN, lot, serial, and any separate fulfillment-order aggregate. |
| Workspace tenancy | Each browser session selects one active `workspace_organization`; `requireRequestUser` resolves an active membership; organization hierarchy and resource membership narrow access. | Every operations command starts from the active workspace and includes `organization_id`; caller-supplied organization IDs are never trusted. | **Existing.** Customer-portal scoping within a tenant is a gap. |
| Pipeline and CRM scope | A pipeline belongs to a workspace. CRM organizations and products are pipeline-scoped projections with permanent `ga` and `gp` identities. | Resolve customers and products through an authorized operations pipeline; do not create parallel DOM customer or product masters. | **Existing.** The product model lacks logistics attributes such as UOM hierarchy, dimensions provenance, hazmat, lot, serial, and temperature handling. |
| CRM authority | SuiteCRM owns CRM records and history; ClawPilot Postgres holds the tenant-scoped projection and action/outbox state. | Operational records reference CRM customer/contact/product identities through a CRM adapter. Operations never write provider tables directly. | **Existing.** Order-party roles beyond one customer reference need a target model. |
| Postgres transactions | `query`, `withTransaction`, advisory locks, foreign keys, check constraints, and unique keys already exist. Hosted operations fail closed without Postgres. The mock vertical slice atomically writes order, reservation, ledger, events, audit, billable facts, and outbox intent. | Put each aggregate mutation, ledger evidence, domain event, audit event, and outbound intent in one transaction. | **Implemented development slice.** General command receipts, provider-attempt boundaries, and production mutation services remain gaps. |
| Local storage | The supported local launcher uses isolated file-backed compatibility state unless Postgres is deliberately configured. | Distributed operations are Postgres-only; file storage must return a clear unavailable response and cannot simulate authoritative inventory. | **Existing compatibility path; operations gap.** A Postgres-backed local test fixture is required. |
| API conventions | `/api/operations` authenticates with `requireRequestUser`, validates bounded JSON, returns structured error codes, uses `Cache-Control: no-store`, and enforces action-specific capabilities. | Version provider/public contracts before external activation and keep provider payloads behind adapter schemas. | **Implemented internal route.** Public checkout, webhook, and versioned provider contracts remain gaps. |
| Outboxes and workers | `sync_outbox` and domain-specific leased queues support idempotency, retries, backoff, dead letters, heartbeats, and `FOR UPDATE SKIP LOCKED` claims. | Use an operations-specific dispatcher over the existing queue contract, with target-specific adapters and lease fencing. | **Existing patterns, not a generic event bus.** `operations_domain_events` is a journal; an outbox is still required for delivery. |
| Workflow and rules | Projects supports task lifecycle and agent workflows. Domain-specific policy code exists for CRM, POS, and accounting. | Reuse Tasks for assigned exception work and use a typed operations policy evaluator for deterministic rules. | **Gap.** There is no reusable generic rules engine, rule version store, simulation framework, or Cases/Support module to call today. |
| Authentication | Opaque Postgres browser sessions, active memberships, worker bearer secrets, support-mode attribution, and session revocation are implemented. | Browser commands use the effective signed-in user; workers use scoped service credentials and never create browser sessions. | **Existing.** Scanner, portal, optimizer, and local print-agent identities need dedicated service boundaries. |
| Authorization | Global role, organization membership role, explicit permission JSON, hierarchy, and resource sharing are separate controls. Typed `viewOperations`, `manageOperations`, and `executeWarehouse` flags are enforced by the operations route. | Continue narrowing sensitive commands with facility, contract, billing, cost, carrier, and override capabilities. | **Implemented coarse development boundary.** The fine-grained target matrix remains a gap. |
| Audit | `recordAuditEvent` preserves authenticated/effective actor, active workspace, subject, aggregate, payload, and idempotent event key. | Use the signed-in actor or scoped worker identity; keep sensitive provider payloads and label contents out of audit JSON. | **Existing.** Operations event schemas and retention/redaction rules remain to be added. |
| Documents | `app_documents` supports repository and user-authored knowledge documents. | Use a future document adapter for packing slips, labels, BOLs, customs files, and return documents. | **Gap.** The current Docs module is not a binary logistics-document repository or template/rendering service. |
| Notifications | POS accounting has a specialized email notification outbox and health checks. The header has presentation affordances. | Reuse queue/recipient/consent patterns, not the POS-specific tables. | **Gap.** There is no general Notification or Messaging module for operations alerts. |
| Contracts and pricing | QuickBooks and POS contain versioned accounting policy, immutable previews, approval controls, minor-unit money, and provider write gates. | Reuse financial arithmetic, approval, and outbound accounting patterns. Keep operational pricing in versioned native records. | **Gap.** There is no existing general Contracts/MUD module. `0081` proposes operations-native contracts, versions, and directives. |
| Billing and accounting | QuickBooks is organization-bound and provider writes use explicit approval and durable requests. | Generate immutable operations billable events first; export approved summaries through an accounting adapter. | **Partial.** No invoice, AR, dispute, credit/rebill, or generic billing service consumes operations charges yet. |
| Tasks and exceptions | Projects has tenant-scoped tasks, comments, assignment, activity, and agent thread context. | An exception may create or link a task only through the Projects service with explicit board ownership and idempotency. | **Partial.** `operations_exceptions` has no task/case link, due date, customer, warehouse, or recommended-action fields. |
| Reporting | Pipeline, CRM, POS, Accounting, Dashboard, and Versions each implement purpose-built Postgres projections and responsive UI. Operations queries summary, order, package, rate, event, billable, and exception views directly from native records. | Build later aggregate read models from native events and snapshots; do not use Sheets as an operations reporting source. | **Implemented first read model.** KPI definitions, durable projection jobs, retention/aggregation, and operations health metrics remain gaps. |
| UI system | MUI, authenticated hash-based sections, desktop/mobile navigation, responsive work surfaces, and shared timezone formatting are established. | Reuse shell, typography, icons, tables, drawers, dialogs, accessibility, and workspace switching. | **Existing.** Scanner/offline workflows, pack station, wave planner, order workbench, portal, and exception queue are gaps. |
| Integrations and secrets | Organization-scoped Toast credentials use AES-GCM; per-user Maton and QuickBooks bindings are validated; settings and workers avoid returning secrets. Working-tree commerce, carrier, and print interfaces have deterministic mock implementations. | Store only a validated credential reference on an operations integration account; adapters resolve the secret server-side. | **Existing patterns plus mock adapter draft.** No production adapter, secret-store binding, capability declaration, account ownership model, webhook verification, rotation, or reconciliation exists. |
| Observability and recovery | `/api/health`, `/api/persistence/status`, worker queue health, structured audit events, Railway backups, logical exports, and release gates exist. | Add operations migration, queue, adapter, ledger reconciliation, optimizer, print, and shipment checks to those surfaces. | **Existing platform controls.** Operations-specific metrics, traces, alerts, dashboards, and drills are gaps. |
| Optimization | A working-tree `FulfillmentOptimizer` interface and `DeterministicFulfillmentOptimizer` choose the lowest-handling-cost complete single warehouse with a stable Global ID tie break. No OR-Tools package, service, or worker exists. | Evolve the draft interface to the immutable snapshot/result contract and keep OR-Tools behind it. | **Working-tree fallback draft.** It does not yet rank promise/rate/package economics, persist input/candidates, support approved splits, validate result hashes, or implement timeout budgets. |

## Concurrent Working-Tree Foundation

Committed development implementation now includes:

- `app_src/lib/operations/types.ts`: first-slice order, package, carrier, pricing, optimizer, workspace, and proof DTOs;
- `app_src/lib/operations/domain.ts`: simple single-package cartonization, promise-safe rate selection, initial MUD calculations, and a deterministic complete-single-warehouse fallback;
- `app_src/lib/operations/adapters.ts`: commerce, carrier, and print ports with deterministic mocks only;
- `app_src/lib/operations/authorization.ts` plus user/access edits: three coarse operations capabilities;
- `app_src/lib/persistence/operations.ts`: tenant-scoped reads, a complete mocked proof transaction, and audited exception dispositions;
- `app_src/app/api/operations/route.ts` and `app_src/components/operations/OperationsSection.tsx`: authenticated API and responsive Orders/Exceptions workbench;
- `scripts/test-distributed-operations.mjs`: route contracts plus optional PostgreSQL acceptance coverage.

The native shell registration, migration health gate, internal route, UI, and committed test suite exist on `dev`. There is still no operations worker target, detailed operations health section, OR-Tools implementation, public checkout contract, or production provider verification. The module remains pre-activation outside the bounded development proof.

## Foundation Migration Coverage

The development foundation is additive and organization-scoped. Its composite foreign keys bind operations rows to the active workspace, pipeline, warehouse, location, customer, and product. The following table records both the useful foundation and the follow-on work still required before production activation.

| Area | Proposed structures | Useful foundation | Required follow-on |
| --- | --- | --- | --- |
| Global identity | `global_reference_entity_types`, extended `crm_reference_registry`, `allocate_global_reference` | Extends the permanent registry without replacing old CRM IDs. | Add every required aggregate prefix and contract tests for collision, immutability, archival, and concurrent allocation. |
| Integration accounts | `operations_integration_accounts`, `operations_external_identifiers` | Separates provider/environment and external identifiers from Global IDs. | Add capability/version declarations, verified webhook endpoints, secret-reference integrity, provider account ownership, health, cursor, and reconciliation state. |
| Facilities | `operations_warehouses`, `operations_locations`, `operations_printers` | Provides tenant-scoped warehouse, minimal location, and printer records. | Add calendars, capacity, full location hierarchy/restrictions, stations, docks, equipment, printer capabilities, and enrolled print agents. |
| Inventory | `operations_inventory_pools`, pool customers, positions, immutable ledger | Supports dedicated/shared pools, priority, lots as text, balances, and append-only deltas. | Add owner/consumer roles, operator/consigned/virtual/borrowing policy, statuses, UOM, allocated/picked/in-transit/quarantine buckets, expiry, lot/serial/LPN entities, receipts, and atomic reservation functions. |
| Contracts | `operations_contracts`, immutable versions, immutable pricing directives | Provides a native version anchor and a small directive vocabulary. | Resolve lifecycle immutability, effective-date overlap, approval, precedence, calculation provenance, minimums/caps/tiers, adjustments, and invoice export. |
| Orders and products | `operations_orders`, lines, product mappings | Deduplicates imported orders per integration and maps channel SKUs to CRM products. | Add webhook receipt/source snapshot, all party roles, address validation, broader order types/policies, line states, edits/cancellations, quote linkage, and reconciliation state. |
| Reservation and planning | `operations_reservations`, fulfillment plans and allocations | Adds idempotency keys, plan versions, method/fallback fields, cost/revenue/margin, and allocation links. | Add one atomic reserve/release/consume command, candidate/input snapshots, hard-constraint evidence, multi-warehouse representation, override provenance, and expiration worker. |
| Carton and rate | carton plans and carrier rates | Stores a package-plan JSON snapshot and exact selected-rate snapshot per plan. | Add immutable checkout quote aggregate, expiration, item-to-carton assignments, carton catalog/version, account used, request/response hashes, timeout outcomes, and re-rate history. |
| Warehouse execution | waves, pick tasks, packages | Establishes a basic outbound path and pick sequence. | Add wave membership, release validation, task leasing/scanning, short-pick resolution, pack verification, replenishment, inbound, returns, offline replay, and advanced WMS models. |
| Labels, print, shipments | labels, print jobs, shipments | Adds label and print idempotency plus shipment references and actual carrier cost. | Add purchase attempt ledger, void/reprint provenance, sensitive payload storage/retention, station/routes/fallbacks, manifests, tracking observations, multi-package shipment model, and provider reconciliation. |
| Billing, exceptions, events | billable events, exceptions, domain events | Introduces native immutable evidence, event versions, correlation, actor, and idempotency. | Separate append-only charge facts from mutable billing lifecycle; link exception work; add event tenant Global ID/causation contract; define projections, delivery outbox rows, retention, and replay. |
| Permissions and outbox | permission JSON updates and operations uniqueness on `sync_outbox` | Defaults existing non-owners to no operations access and preserves an outbound delivery boundary. | Complete and test the drafted coarse typed permissions, then add least-privilege command roles, portal scope, service identities, worker target handling, queue health, payload validation, and dead-letter controls. |

## Required Adapter Boundaries

| Boundary | ClawPilot side | External or shared side | Forbidden coupling |
| --- | --- | --- | --- |
| CRM and product catalog | Customer/product resolution by authorized pipeline plus `ga`, `gc`, and `gp` | SuiteCRM-backed CRM projection | Copying customer or product masters into provider-specific operations tables. |
| Commerce | Canonical command and event contracts, raw receipt evidence, external-ID mapping | Shopify, BigCommerce, Etsy, later provider adapters | Provider payloads writing domain tables or provider IDs becoming primary identifiers. |
| Carrier | Package and shipment request snapshots, account policy, idempotent label command | USPS, UPS, FedEx, later carrier adapters | Adapter-selected warehouses, direct inventory mutation, or duplicate label purchase on retry. |
| Optimizer | Immutable optimization input and candidate/selection result | OR-Tools service and deterministic fallback | Solver database access, credentials, or authority to relax hard constraints. |
| Printing | Durable print job, routing decision, document reference | Enrolled local print agent and printer transport | Browser best-effort printing as confirmation or a print retry repurchasing a label. |
| Tasks and future cases | Exception-to-work command with tenant, actor, owner, and idempotency | Projects today; future Cases/Support adapter | Direct writes to task tables or assuming a Cases module exists. |
| Documents | Document metadata, source object, version, retention class | Future logistics renderer/blob store | Storing large label/BOL payloads in audit events or treating knowledge documents as shipping artifacts. |
| Notifications | Typed alert intent, recipient policy, consent, dedupe key | Future shared notification service | Reusing POS-specific notification tables or letting an adapter choose unauthorized recipients. |
| Accounting | Immutable billable-event export and approved adjustment | QuickBooks or another billing/accounting adapter | QuickBooks defining the contract calculation or mutating historical billable facts. |

## Blocking Gaps Before Runtime Activation

1. Complete route-level enforcement and tests for the drafted coarse typed operations permissions, then add the fine-grained sensitive-command matrix.
2. Define command handlers that atomically mutate aggregate state, inventory positions, ledger rows, domain events, audit events, and outbox intents.
3. Resolve the append-only billing lifecycle: `operations_billable_events.status` cannot change while the proposed trigger rejects every update.
4. Resolve contract-version lifecycle: draft/published/retired state cannot transition while contract versions and directives reject every update.
5. Add webhook receipt, provider attempt, reconciliation cursor, and dead-letter evidence; order uniqueness alone is insufficient for secure replay.
6. Add inventory owner/status/UOM/lot/serial/expiry dimensions and a database-enforced reservation operation before accepting real stock.
7. Add immutable quote, optimizer input, candidate plan, override, and re-rate history rather than relying only on mutable JSON explanations.
8. Define multi-warehouse plan representation. A single `warehouse_id` on each fulfillment plan cannot explain an approved split plan cleanly.
9. Add general or explicit bridge services for exceptions/tasks, logistics documents, alerts, and accounting export instead of assuming missing shared modules.
10. Add operations routes, workers, health checks, metrics, focused tests, and a tenant-scoped feature activation control.

## Open Product And Operating Decisions

These decisions are deliberately not hidden in schema defaults:

- Initial tenant, warehouses, channels, daily order volume, SKU count, inventory-position count, and peak concurrency used for capacity tests.
- Operations CRM-catalog binding when a workspace has multiple pipelines, including how one canonical `ga` or `gp` remains stable when projected in more than one pipeline.
- Exact customer-portal identity model, subaccount hierarchy, and fields customers may see, especially costs and margin.
- Provider credential ownership and precedence when both a customer and the operator have carrier accounts.
- Quote and provider-payload retention, redaction, encryption, and deletion requirements for addresses, labels, and customs data.
- OR-Tools deployment topology, timeout budget, capacity isolation, and whether optimization runs synchronously for checkout or only for order planning.
- Inventory valuation method and financial ownership rules for operator-owned, consigned, shared, and borrowed inventory.
- Append-only lifecycle representation for draft/published/retired contract versions and estimated/unbilled/billed/credited charge facts.
- Invoice/AR authority, export cadence, dispute workflow, and accounting destination for billable events.
- Local print-agent enrollment, certificate rotation, offline queue limits, and proof that a physical print completed.
- Returns, inbound receiving, kitting, LTL/international, hazmat, and regulated inventory scope for the first production customer.
- Recovery point objective, recovery time objective, and provider replay windows specific to operations data.

## Connected Notes

- [Distributed Operations](../modules/distributed-operations.md)
- [Distributed Operations Delivery, Migration, and Test Plan](../architecture/distributed-operations-delivery-plan.md)
- [Distributed Operations Runbook](../operations/distributed-operations-runbook.md)
- [Native Distributed Operations Authority and Adapter Boundaries](../decisions/0006-native-distributed-operations-authority.md)
- [Platform and Data Map](platform-data-map.md)
- [Application Shell and Access](../modules/application-shell-and-access.md)
- [CRM and Workbook Reporting](../modules/crm-and-reporting.md)
- [Pipeline and Synchronization](../modules/pipeline-and-sync.md)
