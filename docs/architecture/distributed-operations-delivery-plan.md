---
id: cp-plan-distributed-operations-delivery
title: Distributed Operations Delivery, Migration, and Test Plan
summary: Phased implementation, data migration, rollout, and automated acceptance plan for the native DOM, WMS, shipping, and 3PL billing module.
status: draft
kind: delivery-plan
area: distributed-operations
tags: [clawpilot, dom, wms, 3pl, delivery, migration, testing]
app_visible: false
---

# Distributed Operations Delivery, Migration, and Test Plan

## Planning Contract

This plan converts the distributed operations target into independently reviewable slices. Each phase must leave the database consistent, the module disabled or usable for its approved scope, and the next phase optional. No phase may claim a production provider based only on a mock, fixture, sandbox, compiled adapter, or unverified credential.

The [Distributed Operations](../modules/distributed-operations.md) contract defines target behavior. The [integration and gap map](../maps/distributed-operations-integration-gap-map.md) distinguishes existing ClawPilot services, the implemented `0081`/`0082` foundation plus `0084` command-result hardening, and the remaining provider and operating gaps.

## Cross-Phase Gates

Every phase supplies:

- additive migrations with checksum-safe forward behavior;
- domain types, service interfaces, and API/event schema versions;
- tenant, authorization, idempotency, concurrency, and audit tests for its writes;
- deterministic seed fixtures with Global IDs, customers, products, contracts, facilities, pools, and provider accounts;
- safe logs, metrics, health checks, queue controls, deployment steps, and rollback/containment steps;
- current module, decision, runbook, and release documentation;
- proof from the smallest focused tests plus lint, build, test, and predeploy gates before promotion.

Operations stays fail-closed on file storage. Hosted activation requires Postgres, migration health, typed permissions, an explicit tenant/channel/warehouse enablement, and no critical reconciliation drift.

## Current Delivery State

As of 2026-07-23, the development environment has completed the bounded Phase 2 shipped mock proof plus an operator-reviewed planned-order path and three explicit warehouse commands. Warehouse release uses an advisory lock, exact row-version check, request-hashed command receipt, complete reservation/allocation validation, blocking-exception validation, and one transaction to release the plan, create the wave and pick tasks, advance the order, and write event/audit evidence. Bulk all-ready pick confirmation locks every affected inventory position, revalidates the released plan, wave, picks, activation, row version, and blocking exceptions, then marks every ready pick `picked`, completes the wave, advances the order to `picking`, and records immutable ledger, event, audit, and exact replay-result evidence in one transaction. Pack verification is a separate replay-safe command that verifies package facts and creates immutable pack-fee evidence without consuming reservations. Durable exception dispositions, one canonical CRM projection per workspace, deterministic provider-customer resolution, team-managed metric/imperial product-package profiles, organization activation state, a provider-neutral small-parcel capability contract, organization-scoped encrypted UPS/FedEx/USPS credential management, carrier-rate delegation and GL Coding foundations, and capability-aware printer configuration also exist. The full migration chain and transaction behavior run against disposable PostgreSQL in the standard Operations test. Credential verification, printer profiles, and billing schema do not advance production-provider certification or mark Phase 4 or Phase 5 complete; scanner claims, short-pick recovery, production label/void/pickup/tracking, provider-specific carrier-bill ingestion, print-agent enrollment and job acknowledgement, settlement approval/export, complete reconciliation health, and live adapters remain open.

The exception queue deliberately stays separate from Projects tasks. An exception owns operational status and evidence. A later adapter may create or link a Projects task for collaborative work without transferring exception authority to the task module.

### Implemented inbound receiving checkpoint

The first advanced-WMS execution slice now supports expected inbound receipts with multiple product and lot lines, an active warehouse and inventory-ownership pool, optional manual destinations, and automatic capacity-aware putaway. Automatic placement considers only active leaf storage or pick locations. It rejects restricted products, disallowed mixed-product storage, product quantity limits, maximum cubic volume, and maximum weight. It prefers an explicit product-location rule, then an existing location for the same product, then storage over pick locations. **Pick route order is only the final tie-breaker**; it is not customer, order, allocation, or replenishment priority.

Receipt creation and completion are separate idempotent Postgres commands. Completion locks and version-checks the receipt, revalidates the planned location instead of silently rerouting inventory, updates the materialized position, and writes accepted and damaged quantities to the immutable inventory ledger with event and audit evidence. Capacity calculations use product package dimensions and weight normalized by `units_per_package`; a configured capacity fails closed when the package profile is missing or existing contents cannot be measured.

This checkpoint posts canonical inventory units only. Case and pallet conversion remains disabled until a versioned UOM conversion profile exists. Provider ASN import, receiving appointments, partial/short-receipt exception handling, quarantine workflows, lot expiration, serial capture, LPNs, replenishment, and directed picking remain Phase 7 work. Product placement rules are enforced for this receipt-putaway path; they do not yet claim directed replenishment or picking.

## Delivery Phases

### Phase 0 - Discovery And Architecture

**Scope**

- Approve the integration/gap map, authority ADR, domain contract, ER model, state machines, event envelope, optimizer port, deterministic fallback, security boundary, runbook, and this plan.
- Record open scale, portal, credentials, retention, print, billing, and regulated-inventory decisions with named owners.
- Decide whether `0081` remains one migration or is replaced, before application, by smaller foundation migrations.

**Exit**

- Docs verification passes.
- Reviewers agree which `0081` structures are first-slice commitments and which are placeholders.
- No document describes a proposed table or adapter as deployed behavior.

### Phase 1 - Shared Foundation And Migration Hardening

**Scope**

- Finalize typed Global ID entity registration and contract tests.
- Correct foundation lifecycle contradictions, including immutable contract versions/directives and mutable billing status.
- Extend implemented command receipts with webhook receipts, provider attempts, adapter capability/health state, optimizer input/candidate snapshots, and required quote identity.
- Add typed server permissions and least-privilege presets; keep existing non-owners denied.
- Extend the implemented operations persistence, domain transition, event, outbox, and organization activation boundaries to every production command and integration/warehouse subscope.
- Add explicit tenant constraints and indexes for every new relationship; verify pipeline binding only resolves CRM projections and does not become operations authority.

**Exit**

- Migration applies to an empty database and a current development snapshot, and a second run skips it without checksum drift.
- Schema contract tests prove Global ID uniqueness/immutability, cross-tenant foreign-key rejection, append-only evidence, permission defaults, and lifecycle constraints.
- Feature activation remains off and no provider worker claims operations rows.

### Phase 2 - Mocked Outbound Vertical Slice

**Scope**

- Import one canonical order through a commerce port and resolve CRM customer plus `gp` products.
- Configure one customer-dedicated pool and one shared pool with opening ledger balances.
- Atomically reserve inventory, select one feasible warehouse through deterministic fallback, cartonize, use mock carrier rates, calculate a minimal versioned estimated charge, and create a fulfillment plan.
- Release a wave, create pick tasks, pick, pack, create an idempotent mock label, route a print job, confirm shipment, create final billable facts, and enqueue fulfillment/tracking export.
- Expose a minimal order workbench and warehouse execution path in the native shell.

**Exit**

- The 20-step first vertical slice completes in Postgres without direct table repair.
- Replaying every command and worker job produces no duplicate order, reservation, ledger fact, label, shipment, billable fact, or provider export.
- S01-S03 and S07-S09 pass with provider fixtures; these are not yet production Shopify claims.

**Implemented operator checkpoint**

- The default proof prepares a planned order and stops before warehouse execution.
- The workbench exposes reservations, allocations, package/rate evidence, estimated financials, blocking exceptions, and the current row version before release.
- An authorized operator supplies a reason and stable idempotency key to release an eligible current version. An exact retry replays its completed receipt without a duplicate wave or pick task.
- After release, an authorized operator can confirm all ready picks for the exact current version. The command is replay-safe, fails closed on partial or blocked work, retains the active reservation for later consumption, and returns the original receipt result even after later commands advance the order.
- Scanner claims, per-task scans, short picks, package revisions, label, print, and shipment transitions remain explicit Phase 4 work; the 20-step shipped proof is not their operator interface.

### Phase 3 - Promise, Quote, Cartonization, Rating, And Optimization

**Scope**

- Add immutable checkout quote requests/snapshots, single-warehouse eligibility, expiration, promise explanations, package assignments, and cost/revenue/margin.
- Implement carrier capability discovery, controlled parallel rating, timeout/circuit policy, exact response snapshots, and conservative missing-dimension profiles.
- Keep direct UPS, FedEx, and USPS adapters plus optional RocketShipIt behind the [provider-neutral small parcel boundary](small-parcel-carrier-adapters.md).
- Deploy OR-Tools behind the optimizer port; validate result hashes and constraints; retain deterministic fallback and candidate/rejection evidence.
- Add approved split planning, promise-safe multi-warehouse representation, manual override versioning, and margin-erosion attribution.

**Exit**

- S04-S06, S14-S16, S21, and S24 pass against deterministic fixtures and Postgres.
- Solver unavailable/timeout tests produce the exact same fallback result across repeated runs.
- A quote never presents a single-location charge while selecting a hidden split plan.

### Phase 4 - Warehouse Execution, Shipping, And Printing

**Scope**

- Add wave composition/release validation, pick task claims, scanner-safe command IDs, short-pick resolution, pack verification, package revisions, and ship confirmation.
- Add label purchase/unknown-outcome reconciliation, void/reprint controls, printer rules, enrolled local print-agent leases, approved fallback routes, manifests, and tracking observations.
- Add facility calendars, cutoffs, capacity, stations, printer capabilities, and operational exception/task bridge.

**Exit**

- S17-S20 and S25 pass, including carrier/print failure injection.
- A retry cannot buy a duplicate label, and a print retry cannot invoke a carrier purchase.
- Package changes invalidate stale rates and recalculate margin before shipment.

**Implemented foundation**

- Warehouse-scoped thermal and office printer profiles record connection mode, ZPL/PDF/PNG capability, 4 x 6 and 4 x 8 label plus Letter/A4 media, supported documents, defaults, priority, status, and compatible fallback.
- Route selection fails closed when no compatible online printer exists.
- Durable local-agent enrollment, leases, acknowledgements, retry evidence, document rendering, and carrier-label purchase remain open.

### Phase 5 - Contracts, 3PL Billing, And Profitability

**Scope**

- Implement effective-dated contract versions, approved MUD/pricing directives, precedence, calculation explanations, minimums/caps/tiers, estimate/accrual/final facts, credits, rebills, and disputes.
- Add order/package/shipment/customer/contract/warehouse margin projections and quoted-to-actual variance.
- Add approved accounting export without transferring calculation authority to QuickBooks.

**Exit**

- S10-S13 pass with exact minor-unit arithmetic and historical version retention.
- S16 and S25 rerun with final billing and margin projections.
- Re-export and replay are idempotent; corrections are compensating facts.

**Implemented foundation**

- Triangle, Square, and Circle paths retain explicit directive versions and fees, including a zero Triangle fee.
- Carrier account identities, multi-account billing statements, shipment-match evidence, independent shipper assignments, selected-batch GL Coding runs, versioned routing rules, manual orphan resolution, reconciliation snapshots, and append-only settlement structures exist.
- Provider-specific CSV ingestion, GL dimension bindings, settlement approval/rebill commands, payouts, and accounting export remain open.

### Phase 6 - Production Commerce And Carrier Adapters

**Scope**

- Certify Shopify, BigCommerce, and Etsy adapter capability contracts for their actual supported features.
- Certify USPS, UPS, and FedEx account, rate, label, void, tracking, and reconciliation capabilities used by the release.
- Add webhook registration/signature verification, cursor sync, scheduled reconciliation, dead-letter replay, inventory export, fulfillment export, and integration-health UI.

**Exit**

- Provider sandboxes pass contract and fault-injection suites.
- Each production adapter receives a separately recorded credential/account verification and one authorized live smoke test that creates no customer-impacting shipment unless explicitly approved.
- S01-S06 and S19 rerun through the real adapter boundary; unsupported capabilities remain visibly disabled.

### Phase 7 - Advanced WMS And Reverse Logistics

**Scope**

- Add purchase orders/ASNs, appointments, receiving, inspection, quarantine, directed putaway, replenishment, transfers, cycle counts, UOM conversion, lot/serial/expiry, LPNs, kitting, cross-dock, returns, disposition, and capacity planning.
- Extend cartonization, warehouse map, batching, pick-path, zone, equipment, and labor optimization only where validated facility data exists.

**Exit**

- Every added inventory state has balanced ledger and projection tests.
- Receipt-to-available, available-to-shipped, and return-to-disposition reconciliation pass by owner, pool, product, warehouse, location, lot/serial, status, and UOM.
- Advanced workflows remain disabled for facilities lacking required configuration.

### Phase 8 - Portal, Reporting, Simulation, And Tuning

**Scope**

- Add customer-portal identities and customer/subaccount field policy.
- Add operational, service, inventory, carrier, profitability, margin-erosion, unbilled, return, and exception projections.
- Add rule/optimizer simulation, baseline comparison, tuning controls, and read-only AI explanations/recommendations.

**Exit**

- S22 passes with independent portal sessions and direct-object-reference attacks.
- S23 reruns as a scheduled production-like reconciliation with alerting.
- Reports reconcile to source facts, and simulations cannot mutate live state.

## First Vertical Slice Sequence

The Phase 2 slice proves the entire authority and adapter chain with mocks before production integrations expand the blast radius:

1. Receive a signed canonical fixture through the commerce adapter interface.
2. Deduplicate the provider event and external order ID.
3. Resolve the contracted CRM customer and channel SKUs to `gp` products.
4. Select only customer-dedicated or approved shared inventory.
5. Reserve all lines atomically and write ledger/events/audit in the same transaction.
6. Build one complete-warehouse candidate.
7. Cartonize from versioned product and carton facts.
8. Rate eligible mock carrier services.
9. Select a service that meets the promise.
10. Calculate versioned estimated contract charges.
11. Persist cost, revenue, margin, package, rate, promise, and decision evidence.
12. Select the fulfillment plan.
13. Release a wave after revalidating holds, reservations, cutoff, capacity, and printer route.
14. Create ordered pick tasks.
15. Confirm picks and pack the verified package.
16. Create one idempotent label.
17. Route one durable print job through a versioned rule.
18. Confirm shipment and consume reserved inventory.
19. Create immutable final billable facts.
20. Enqueue and acknowledge one idempotent commerce fulfillment/tracking export.

## Migration Strategy

### 1. Determine Whether `0081` Has Ever Applied

Before editing or replacing the migration, query each relevant database:

```sql
SELECT filename, checksum, applied_at
FROM schema_migrations
WHERE filename = '0081_distributed_operations_foundation.sql';
```

- If no row exists anywhere, the migration owner may revise or split the untracked file before first application.
- If a row exists in any shared environment, never edit that file. Add a later corrective migration and preserve its checksum.
- The documentation owner does not stage, edit, or apply `db/migrations/0081_distributed_operations_foundation.sql`.

### 2. Preflight The Foundation

- Validate every proposed Global ID prefix against the permanent registry and existing numeric suffixes.
- Verify all referenced pipeline, CRM, user, workspace, outbox, and audit columns exist in both development and production lineage.
- Resolve append-only/lifecycle conflicts and add missing organization-scoped uniqueness before application.
- Test on a clean database and a restored development snapshot with production-like row counts.
- Capture a current Railway provider backup and validated logical dump before development and production application.

### 3. Deploy Additive Schema With Activation Off

- Apply migrations through `npm run db:migrate`; never run copied statements manually against a hosted database.
- Confirm `schema_migrations` checksum, expected tables/indexes/constraints/triggers, permissions defaults, and unchanged existing module counts.
- Keep imports, reservations, provider calls, and UI entry points disabled.
- Deploy read-only schema health and diagnostics first.

### 4. Seed Tenant Configuration

Configuration is imported in dependency order and each row records source, actor, timestamp, and deterministic idempotency key:

1. Operations-enabled organization and authorized CRM pipeline binding.
2. Integration account metadata and secret references.
3. Warehouses, calendars, locations, stations, printers, cartons, and carrier service mappings.
4. CRM customers/products and verified external product mappings.
5. Contracts, published versions, directives, and approval evidence.
6. Inventory pools and authorized customers.
7. Opening inventory ledger entries and derived positions.

Opening inventory must never be inserted only into materialized positions. Import one immutable `opening_balance` ledger event per source balance and derive or atomically verify the position. The source extract, hash, owner, pool, UOM, lot/serial, cutoff time, accepted/rejected rows, and reconciliation totals remain durable outside Git.

### 5. Reconcile Before Writes

- Reconcile product mappings and reject ambiguous/missing SKUs.
- Compare source inventory totals to ledger and materialized positions by owner, pool, product, warehouse, location, status, lot/serial, and UOM.
- Shadow-import provider orders into receipt/canonical validation without reserving, exporting, or acknowledging fulfillment.
- Compare order counts, lines, quantities, customer links, and hold reasons to the provider.
- Block cutover on any unexplained inventory, identity, contract, or order mismatch.

### 6. Tenant-Scoped Cutover

Enable one organization, one commerce account, and one warehouse at a time:

1. Freeze or define the legacy order-ingestion cutoff.
2. Record the provider cursor and last accepted external event.
3. Enable import and validation only; inspect duplicate and unmatched rates.
4. Enable reservation/planning for a bounded order cohort.
5. Enable warehouse execution and label purchase for an approved service/account.
6. Enable fulfillment/tracking export and billing accrual after reconciliation.
7. Expand only after one full operating cycle and scenario acceptance.

### 7. Rollback And Forward Recovery

- Disable the affected tenant/channel/warehouse commands and public checkout callback.
- Stop new provider claims; allow only explicitly approved reconciliation/void work.
- Preserve schema and evidence. Do not down-migrate or delete imported orders, ledger entries, domain events, labels, or billable facts.
- Roll application code back when the defect is code-only.
- Correct data with versioned commands, ledger compensations, label voids, charge credits/rebills, or later migrations.
- Restore the database only for broad corruption after writes are frozen and coordinated Postgres/provider reconciliation is planned.

## Test Architecture

| Layer | Purpose | Required properties |
| --- | --- | --- |
| Schema contract | Constraints, triggers, indexes, migration behavior | Empty/current snapshot application, checksum, cross-tenant rejection, append-only protection |
| Domain unit | State transitions, calculations, policies, fallback | Pure deterministic fixtures, exact minor units, canonical sorting, no network |
| Postgres integration | Transactions, locks, command receipts, ledger, events, outbox | Real Postgres and independent connections; rollback proves no partial evidence |
| Adapter contract | Canonical-provider mapping and capabilities | Recorded fixtures, signature tests, pagination/cursor, timeout, retry, unknown outcome, redaction |
| End-to-end | Operator and portal workflows | Authenticated native UI/API, active workspace switching, server permissions, visible explanations |
| Security | Tenant/customer isolation, secrets, object references | Negative tests for every Global ID route and worker claim; logs/events contain no secret |
| Reconciliation | Ledger, provider, label, tracking, billing consistency | Replay-safe compare and repair path; zero unexplained drift |
| Performance and resilience | Peak import/reservation/quote/wave load and failures | Named data volumes, latency/error budget, provider circuit tests, queue recovery, no oversell |

## Required Scenario Matrix

The scenario ID is stable and must appear in the eventual test name, CI output, and phase evidence.

| ID | Required scenario | Earliest owning phase | Automated level and decisive assertion |
| --- | --- | --- | --- |
| S01 | Duplicate Shopify webhook imports one order. | 2 fixture; 6 provider | Adapter + Postgres concurrency: one receipt, one canonical order, one import event, replay returns the first result. |
| S02 | Imported order links to the correct CRM customer through Global ID. | 2 | Integration: order references the authorized pipeline customer UUID and expected permanent `ga`; another tenant's `ga` is rejected. |
| S03 | Channel SKUs map to correct global products. | 2 | Adapter contract: each line resolves the expected `gp`; missing/ambiguous mapping holds the order and creates no reservation. |
| S04 | Checkout quote uses a warehouse that can fulfill the complete order. | 3 | Domain + Postgres: selected warehouse covers every line from eligible inventory; partial warehouses are recorded as rejected. |
| S05 | Quote cartonizes, rates eligible services, and returns only promise-safe services. | 3 | Service integration: package assignments balance quantities; every returned rate is eligible and meets the stored promise. |
| S06 | Quote stores internal cost, customer charge, margin, warehouse, package plan, and promise. | 3 | Persistence contract: immutable snapshot contains exact minor-unit arithmetic, versions, input hash, and expiration. |
| S07 | Dedicated inventory cannot fulfill another customer's order. | 2 | Security/domain negative: reservation fails before quantity mutation; ledger and position remain unchanged; denial is audited safely. |
| S08 | Approved shared pool follows configured customer priorities. | 2 | Domain + Postgres: effective membership/priority determines allocation; deterministic tie break uses Global IDs. |
| S09 | Simultaneous orders cannot reserve the same final unit. | 2 | Multi-connection race: exactly one success, one insufficient-inventory result, reserved total equals one, ledger reconciles. |
| S10 | Fixed per-order MUD calculates correctly. | 5 | Unit + integration: one fact in exact minor units with contract/directive version and explanation. |
| S11 | Percentage freight-markup MUD calculates correctly. | 5 | Unit property tests: decimal basis, rounding, min/max, currency, and exact snapshot are correct. |
| S12 | Tiered pick fee calculates correctly. | 5 | Boundary tests at every tier: quantity split, precedence, and total are exact and replay-safe. |
| S13 | Historical charge retains the contract version active at transaction time. | 5 | Postgres integration: publishing a later version does not alter prior fact, amount, directive, or explanation. |
| S14 | Optimizer selects one warehouse when it meets the promise. | 3 | Optimizer contract: selected candidate is complete/promise-safe; split candidate ranks lower regardless of margin. |
| S15 | Multi-warehouse plan appears only when one location is infeasible or an approved rule allows it. | 3 | Property + integration: split is absent when a complete candidate exists unless versioned policy explicitly permits it. |
| S16 | Later operational split records incremental cost as margin erosion. | 3 estimate; 5 final | Plan/billing integration: prior quote and plan remain immutable; variance identifies cause, actor/policy, cost, and margin delta. |
| S17 | Overnight label routes to Pack Station 1. | 4 | Rule + print integration: matching versioned rule creates one job for the expected printer with explanation. |
| S18 | Failed printer routes to approved fallback. | 4 | Worker fault injection: fenced failure creates no duplicate job/label; approved fallback receives the rerouted job and reason. |
| S19 | Carrier timeout uses fallback without duplicate labels. | 4 fixture; 6 provider | Adapter chaos: ambiguous purchase reconciles first; stable provider key yields at most one active label and records fallback/circuit reason. |
| S20 | Short pick triggers reallocation or an exception. | 4 | Warehouse integration: short quantity is explicit; deterministic eligible reallocation occurs or one owned exception/task is created. |
| S21 | Manual warehouse override records actor, reason, old/new plans, and financial effect. | 3 | Authorization + persistence: permitted actor creates a new plan version, immutable comparison, margin delta, audit, and event. |
| S22 | Portal user cannot see another customer's orders, inventory, contracts, or charges. | 8 | Independent-session security suite: list, search, detail, export, and guessed Global ID requests return no cross-customer data. |
| S23 | Ledger reconciliation equals the materialized inventory view. | 2 | Reconciliation/property test: randomized event sequences and production-like fixture aggregate to exact position buckets; drift alerts/freeze. |
| S24 | Solver timeout uses deterministic fallback and records reason. | 3 | Optimizer chaos: repeated identical inputs yield identical plan/hash/version and explicit timeout reason with no promise violation. |
| S25 | Pack-station package change re-rates and recalculates margin. | 4 estimate; 5 final | End-to-end: new package version invalidates stale rate/label, stores new rate and exact margin variance, and preserves history. |

## Test Data And Isolation

- Use synthetic CRM organizations, contacts, products, addresses, warehouses, rates, and credentials. Never commit provider secrets, production labels, customer addresses, or inventory exports.
- Every fixture names organization, pipeline, customer, owner, pool, warehouse, location, product, lot/status/UOM, contract version, integration account, and Global IDs.
- Provide at least two independent root workspaces, two customers in one workspace, dedicated and shared pools, two warehouses, conflicting SKU aliases, two contract versions, and one failing carrier/printer.
- Time-dependent tests use an injected UTC clock and explicit facility timezone/calendars. Optimizer tests never read wall clock.
- Provider fixtures preserve sanitized request/response shape and capability version. A fixture hash change requires review.
- Concurrency tests use separate Postgres sessions; a Promise-based in-process test without independent connections is insufficient for S09.

## Nonfunctional Acceptance

Exact production latency and throughput budgets remain blocked on the volume decisions in the gap map. Before Phase 3 exits, the owner must record test volumes and budgets for webhook acknowledgement, order import, reservation, checkout quote, solver, wave release, label purchase, and worker recovery. Regardless of those numbers:

- oversell, cross-tenant/customer disclosure, duplicate active label, unbalanced ledger, silent promise violation, or mutable historical charge has a zero-error budget;
- provider timeouts never hold a database transaction open;
- queues recover stale leases and expose terminal dead letters;
- optimizer and rule output is deterministic for the same versioned input;
- a worker restart can replay committed work without repeating external effects;
- hosted development and production use separate databases, credentials, provider environments, webhook endpoints, and print-agent enrollment.

## Promotion Evidence

For each phase, record:

- migration filenames/checksums and preflight/backup evidence;
- focused test command and S-ID results;
- lint, build, test, docs, and predeploy results;
- development `/api/health` and `/api/persistence/status` results plus operations health once implemented;
- adapter account/environment/capability versions without secrets;
- one authenticated development browser workflow for the changed operator or portal path;
- rollout cohort, activation time, reconciliation totals, observed queue/adapter/solver health, and rollback point;
- known limitations and the exact next phase boundary.

Production promotion continues through a reviewed `dev` to `main` pull request and repeats hosted health plus the critical workflow before release completion.

## Connected Notes

- [Distributed Operations](../modules/distributed-operations.md)
- [Distributed Operations Integration and Gap Map](../maps/distributed-operations-integration-gap-map.md)
- [Distributed Operations Runbook](../operations/distributed-operations-runbook.md)
- [Native Distributed Operations Authority and Adapter Boundaries](../decisions/0006-native-distributed-operations-authority.md)
- [ClawPilot Environments and Deployment](../operations/clawpilot-environments.md)
- [Railway Postgres Backups](../operations/railway-postgres-backups.md)
