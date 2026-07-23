---
id: cp-ops-distributed-operations
title: Distributed Operations Runbook
summary: Pre-activation deployment, monitoring, reconciliation, incident response, recovery, and rollback procedures for DOM, WMS, shipping, and 3PL billing.
status: draft
kind: operations-runbook
area: distributed-operations
tags: [clawpilot, dom, wms, 3pl, runbook, incidents, reconciliation]
app_visible: false
---

# Distributed Operations Runbook

## Status And Scope

This runbook governs the target distributed order, inventory, warehouse, carrier, printing, shipment, and 3PL billing module. The development environment has a Postgres-backed planned-proof workbench, explicit warehouse-release, bulk all-ready pick-confirmation, and pack-verification commands, a shared product/default-package import workflow, an audited exception queue, organization-scoped activation, direct carrier credential administration, command-receipt health, and disposable PostgreSQL acceptance. The separate shipped mock proof is automated test evidence and is not the operator execution workflow. This runbook remains `draft` until the module has complete reconciliation and adapter health, tested production adapters, integration/warehouse activation subscopes, and on-call ownership. Current general environment, backup, promotion, and restore procedures remain authoritative:

- [ClawPilot Environments and Deployment](clawpilot-environments.md)
- [Railway Postgres Backups](railway-postgres-backups.md)
- [Agent Security and Integration Isolation](agent-security-and-isolation.md)

Migrations `0081`, `0082`, `0084`, `0085`, `0086`, and `0087` and the mock workbench are development evidence only. Do not use this document as evidence that an operations worker, production provider integration, checkout callback, enrolled print agent, or live warehouse workflow is deployed.

## Direct Carrier Credential Procedure

1. Confirm the active workspace before opening **Settings > Integrations > Shipping**. Carrier accounts belong to that organization only. The organization owner or a user with explicit **Manage operations** permission may manage them; that permission does not expose unrelated integrations.
2. Select UPS, FedEx, or USPS and select **Sandbox / developer** or **Production**. The developer selection uses UPS CIE, FedEx Sandbox, or USPS TEM. ClawPilot fixes those hosts server-side; do not enter a provider host or reuse production credentials. Configure and prove the developer workflow before production whenever the provider offers it.
3. Enter the provider client ID and client secret. Enter the billing account number for UPS or FedEx; it is optional for USPS. Do not paste credentials into tickets, chat, logs, documents, or source files.
4. Use **Save and verify**. ClawPilot calls only the provider's allowlisted OAuth endpoint before atomically storing encrypted credential material. A rejection leaves the previous stored credential unchanged.
5. Confirm the permanent `gia` integration identity, masked suffixes, incremented credential version, `Verified` state, and `Disabled` state for a first-time connection. The browser never receives the stored credential or short-lived access token.
6. Use **Test connection** after any provider-side permission, account, or secret change. Do not enable a failed or unverified account.
7. Enable the account only after verification and only in the intended environment. Enabling re-runs verification. Developer and production credentials are stored, versioned, verified, and enabled independently; a developer record cannot satisfy a production adapter.
8. Rotate by entering the full replacement credential and selecting **Save and verify**. The previous ciphertext is replaced only after the candidate verifies, and the audit log records rotation metadata without a secret.
9. Use **Disconnect** only after confirming the organization, provider, and environment. Disconnect deletes encrypted credential material and disables the integration metadata; it does not delete immutable historical shipment evidence.

Credential verification is not shipping certification. Do not activate rating, label purchase, void, manifest, pickup, or tracking until the corresponding adapter, provider attempts, unknown-outcome reconciliation, and authorized live smoke test pass the release gate in the [small parcel architecture](../architecture/small-parcel-carrier-adapters.md).

## Product And Package Catalog

1. Open **Pipeline**, select the intended pipeline, and open **Configure > Products**. Confirm the active workspace first; product and package records are organization scoped.
2. Add one product manually or download the Products CSV template. Imports accept at most 500 data rows and 1 MB per file.
3. For package-aware fulfillment, provide package name, type, unit of measure, units per package, length, width, height, and weight. Select **Metric** for centimeters and kilograms or **Imperial** for inches and pounds. Supply all four measurement fields together or leave all four empty. ClawPilot stores canonical millimeters and grams for deterministic cartonization and carrier requests while retaining the selected entry system.
4. Import the CSV once and review the result. Valid rows are retained when other rows fail, and each failed row reports its source row number and reason.
5. Confirm an existing product was updated rather than duplicated. Matching uses SKU first when present and then case-insensitive product name. A conflicting name/SKU pair is rejected for review.
6. Open the product again and verify the permanent `gp` product identity and default `gpp` package profile. A later team edit must retain both identities and increment package evidence rather than create a second default profile.
7. Disable the package profile when its measurements must not drive fulfillment. The product may remain active for sales while fulfillment uses the clearly identified fallback until corrected package data is approved.

Only authorized pipeline editors can import or change the catalog. Viewers can inspect it but cannot mutate it. The current slice supports one default package profile per product; do not model alternate cartons, facility packs, or supplier-specific packs as duplicate products.

## Planned Order, Warehouse Release, Pick Confirmation, And Pack Verification

1. Open **Operations**, select **Orders**, and prepare a proof order. The default proof stops at `planned`; it does not pick, pack, buy a label, print, or ship.
2. Open the planned order and verify the customer, lines, warehouse plan, reservation and allocation quantities, package and selected-rate evidence, promise, and estimated cost/revenue/margin.
3. Resolve every open high or critical exception before release. Do not bypass an incomplete reservation or allocation with direct SQL.
4. Use **Release to warehouse**, record a specific operational reason, and submit once. The client keeps one idempotency key for safe retries of that release attempt.
5. On success, confirm the order and selected plan are `released`, exactly one released wave exists, and the expected pick tasks are `ready`.
6. Verify that every expected task is ready and that the displayed pick count matches the order lines. **Confirm all picks** is intentionally unavailable for partial, short, blocked, or already confirmed work.
7. Use **Confirm all picks**, record a specific operational reason, and submit once. The client keeps one idempotency key for safe retries. The command rechecks the exact order version, released plan and wave, all ready picks, active organization, inventory positions, and blocking exceptions before changing state.
8. On success, confirm the order is `picking`, the wave is `completed`, every pick task is `picked`, and the active reservation remains intact for the later pack/ship consumption command.
9. Verify the package details and use **Verify pack** only after every required pick is complete. Record a specific operational reason and submit once. The command rechecks the exact order version, selected plan, wave, picks, package state, active organization, blocking exceptions, and command receipt before changing state.
10. On success, confirm the order and package are `packed`, one pack-fee billable event exists for each applicable directive, the active reservation remains retained for shipment consumption, and no shipment, label, or print job was created.
11. If the screen reports a stale version, reload and re-review the current evidence before issuing a new command. Never change the idempotency key merely to bypass an uncertain result.
12. Current operator capability stops after deterministic pack verification. Scanner claims, per-task scans, short-pick handling, label purchase, printing, and shipment confirmation remain unavailable until their explicit commands and reconciliation controls pass Phase 4 acceptance.

## Exception Queue Procedure

1. Open **Operations**, then select **Exceptions**.
2. Filter by status or search by exception Global ID, order number, title, or customer.
3. Open the exception and review its linked order, recommendation, and evidence before changing status.
4. Use **Acknowledge** when an operator has accepted ownership but work remains. Use **Resolve** only after the underlying operational state is verified. Use **Dismiss** only when the signal is invalid or non-actionable, and record supporting evidence at the source.
5. Reopen a resolved or dismissed exception when new evidence changes the disposition. ClawPilot retains the prior transitions in operations domain events and the global audit log.

Exception updates require operations-management permission. They never alter immutable inventory ledger, shipment, or billing evidence, and they do not silently create Projects tasks.

## Non-Negotiable Controls

1. Railway Postgres is the operational authority. File storage and Google Sheets never accept operations writes.
2. Freeze the smallest affected organization, integration account, warehouse, or command type before repairing uncertain state.
3. Never delete or update inventory ledger entries, domain events, published pricing facts, or billable facts. Correct them with approved compensating commands.
4. Never repeat a label purchase, shipment confirmation, inventory mutation, or accounting export with a new idempotency key merely because a response timed out.
5. Never hold a database transaction open while calling a provider, optimizer, or print agent.
6. Preserve Global IDs, correlation ID, idempotency key, adapter version, provider reference, timestamps, and safe error code during diagnosis.
7. Keep credentials, full addresses, customs data, raw labels, and unrestricted provider payloads out of tickets, chat, logs, audit payloads, and this repository.
8. Database restore is a last-resort coordinated recovery. Application defects use feature containment and code rollback; isolated data defects use compensating commands or later migrations.
9. Require each customer organization to configure and verify separate credentials for every enabled carrier and sandbox or production environment. Never substitute another organization's or a platform-wide account when credentials are absent, disabled, unverified, or environment-mismatched.

## Required Operating Roles

| Role | Responsibility | Required access |
| --- | --- | --- |
| Incident lead | Declares severity, contains scope, coordinates providers/customer communication, owns timeline | Operations health and audit, no routine database write needed |
| Application operator | Activation control, queues, workers, adapter health, code rollback | Operations administration and Railway app access |
| Database operator | Backups, migration verification, read-only diagnostics, approved recovery | Railway Postgres and backup permissions |
| Warehouse lead | Stops/restarts physical work, validates picks/packages/prints/shipments | Facility-scoped warehouse execution |
| Integration owner | Verifies provider account, webhook, rate/label/tracking state, cursor, and reconciliation | Named provider account only |
| Billing owner | Validates contract version, billable facts, credits/rebills, and export | Contract/billing access; margin/cost only when granted |
| Security lead | Handles cross-tenant, credential, portal, or unauthorized-action incidents | System audit, session/credential revocation |

One person may hold several roles for a small deployment, but the same person must not both create and independently approve a sensitive billing adjustment or cross-owner inventory override.

## Activation States

Runtime delivery provides durable audited organization activation. Production delivery must extend it to integration and warehouse subscopes:

| State | Allowed behavior |
| --- | --- |
| `disabled` | No operations routes, webhooks, workers, or UI commands; health and migration diagnostics only |
| `shadow` | Verify/store bounded provider receipts and compute comparisons; no reservations, labels, provider acknowledgements, or exports |
| `read_only` | Authorized queries, health, reconciliation, and evidence export; no domain commands |
| `active` | Approved command and adapter capabilities for the named cohort |
| `frozen` | Existing evidence remains queryable; new consequential commands and provider claims stop; approved reconciliation/void work is explicit |

Absence or invalid configuration means `disabled`. A global environment switch cannot expand a tenant that is not independently active.

## Health Contract

The existing endpoints remain required:

- `/api/persistence/status`: Postgres driver, reachability, and non-empty environment database fingerprint.
- `/api/health`: migration, worker, provider, queue, and dependency health.

Current `/api/health` reports the `0081`/`0082`/`0084`/`0085`/`0086` migration state, command failures, stale processing, and active/shadow organization counts. Before production activation it must additionally report:

- foundation and corrective migration applied/checksum state;
- activation state by cohort without exposing credentials;
- inventory reconciliation time, checked positions, drift count, and frozen scope count;
- command/outbox pending, failed, dead, stale, overdue, oldest due age, and last success;
- commerce/carrier/print/accounting adapter capability version, environment, circuit state, and last reconciliation;
- optimizer version, fallback rate, timeout/error count, and last successful health probe;
- label unknown-outcome count, print failure count, open critical exceptions, and oldest unbilled fact;
- worker heartbeat, claim lease age, and code version.

Health reports safe codes and counts, not source payloads, addresses, labels, tokens, or connection IDs.

## Routine Checks

### Start Of Operating Day

1. Confirm `/api/persistence/status` is Postgres, reachable, and points to the expected environment fingerprint.
2. Confirm `/api/health` is healthy and the expected operations cohort is `active`.
3. Confirm no inventory drift, dead jobs, stale leases, ambiguous labels, expired reservations, or critical exceptions.
4. Confirm each active commerce/carrier account is verified for the correct environment and reconciliation cursor is current.
5. Confirm facility calendar, cutoff, capacity, stations, printers, fallback routes, and carrier pickups for the day.
6. Confirm contract versions and required pricing directives are published for active customers.
7. Review orders on hold, promise risk, short picks, shipment exceptions, and prior-day unbilled activity.

### During Operations

- Watch import lag, unmatched products/customers, reservation failures, optimizer fallback, split plans, missed cutoffs, carrier circuits, label unknown outcomes, printer reroutes, short picks, shipment exceptions, and unbilled age.
- Treat a nonzero ledger drift, cross-customer allocation attempt, duplicate active label, or unauthorized data result as critical even if aggregate health remains green.
- Do not dismiss sustained fallback as harmless. A fallback can be safe while still signaling an optimizer or data-quality outage.

### End Of Operating Day

1. Reconcile imported/provider order counts and terminal/cancelled orders.
2. Reconcile inventory ledger to materialized balances and investigate every nonzero difference.
3. Reconcile label purchases/voids, manifests, shipments, tracking, and commerce fulfillment exports.
4. Reconcile estimated/accrued/final billable facts, credits, exports, and unbilled exceptions.
5. Review manual overrides, ownership borrowing, inventory adjustments, reprints, service changes, and margin erosion.
6. Confirm queues are draining and provider cursors have advanced.
7. Record unresolved exceptions with owner, next action, and due time.

## Deployment And Migration Procedure

### Before Development Application

1. Confirm whether `0081_distributed_operations_foundation.sql` and `0082_operations_activation_and_command_safety.sql` exist in `schema_migrations` as described in the [delivery plan](../architecture/distributed-operations-delivery-plan.md).
2. If it has applied anywhere, do not edit it. Require a later corrective migration.
3. Run schema tests against an empty database and a restored current snapshot.
4. Resolve every blocker in the [integration and gap map](../maps/distributed-operations-integration-gap-map.md) required for the enabled slice.
5. Capture a provider backup and validated logical dump.
6. Confirm operations activation defaults to `disabled` and no worker target can claim operations rows.

### Additive Schema Deployment

1. Apply through `npm run db:migrate` in development.
2. Confirm the migration filename and checksum:

```sql
SELECT filename, checksum, applied_at
FROM schema_migrations
WHERE filename LIKE '%distributed_operations%'
ORDER BY filename;
```

3. Confirm expected constraints/triggers/indexes through schema contract tests, not by row existence alone.
4. Compare existing application counts and `/api/health` before and after migration.
5. Deploy code with operations disabled, then verify lint, build, focused tests, full tests, docs, and predeploy checks.
6. Verify authenticated development queries and negative authorization before enabling a cohort.

### Cohort Activation

1. Name one organization, integration account, warehouse, provider environment, and capability set.
2. Complete configuration and opening-balance reconciliation from the delivery plan.
3. Use `shadow`, then `read_only`, before `active`.
4. Record provider cursor/cutoff, activation actor/time, application commit, migration checksums, adapter versions, contract versions, inventory totals, and rollback point.
5. Start with bounded orders that can be manually verified before warehouse release.
6. Expand only after one complete import-to-export cycle, required scenario pass, and zero unexplained reconciliation drift.

### Production Promotion

Use a reviewed `dev` to `main` pull request. Repeat backups, migration checks, hosted health, protected Vercel build status, one authenticated workflow, and cohort reconciliation. Do not copy development operational data or credentials into production.

## Read-Only Diagnostic Queries

Run queries through an approved read-only session when possible. Replace placeholders with internal UUIDs obtained from an authorized screen; do not paste results containing customer data into shared channels.

### Migration State

```sql
SELECT filename, checksum, applied_at
FROM schema_migrations
WHERE filename >= '0081'
ORDER BY filename;
```

### Queue State

```sql
SELECT target_system, status, count(*) AS jobs,
       min(available_at) AS oldest_available,
       max(updated_at) AS last_updated
FROM sync_outbox
WHERE aggregate_type LIKE 'operations.%'
GROUP BY target_system, status
ORDER BY target_system, status;
```

Inspect one job only by its authorized aggregate/correlation identifiers. Do not dump all payloads.

### Order Deduplication

```sql
SELECT organization_id, integration_account_id, external_order_id, count(*)
FROM operations_orders
GROUP BY organization_id, integration_account_id, external_order_id
HAVING count(*) > 1;
```

The expected result is zero rows. Duplicate webhook receipts require their own receipt-table diagnostic once implemented.

### Inventory Ledger Reconciliation

The `0081` draft can reconcile only on-hand and reserved deltas. Full activation requires ledger deltas for every projected bucket, including damaged/quarantine/allocated/picked/in-transit.

```sql
WITH ledger AS (
  SELECT organization_id, position_id,
         sum(on_hand_delta) AS ledger_on_hand,
         sum(reserved_delta) AS ledger_reserved
  FROM operations_inventory_ledger
  GROUP BY organization_id, position_id
)
SELECT position.global_id, position.on_hand_quantity,
       coalesce(ledger.ledger_on_hand, 0) AS ledger_on_hand,
       position.reserved_quantity,
       coalesce(ledger.ledger_reserved, 0) AS ledger_reserved
FROM operations_inventory_positions position
LEFT JOIN ledger
  ON ledger.organization_id = position.organization_id
 AND ledger.position_id = position.id
WHERE position.organization_id = :organization_id
  AND (
    position.on_hand_quantity <> coalesce(ledger.ledger_on_hand, 0)
    OR position.reserved_quantity <> coalesce(ledger.ledger_reserved, 0)
  )
ORDER BY position.global_id;
```

The expected result is zero rows. Any row triggers inventory containment.

### Active Reservations

```sql
SELECT reservation.global_id, reservation.status, reservation.quantity,
       reservation.expires_at, position.global_id AS position_global_id,
       order_row.global_id AS order_global_id
FROM operations_reservations reservation
JOIN operations_inventory_positions position
  ON position.organization_id = reservation.organization_id
 AND position.id = reservation.position_id
JOIN operations_orders order_row
  ON order_row.organization_id = reservation.organization_id
 AND order_row.id = reservation.order_id
WHERE reservation.organization_id = :organization_id
  AND reservation.status = 'active'
ORDER BY reservation.expires_at NULLS LAST, reservation.created_at;
```

### Label And Shipment Ambiguity

```sql
SELECT label.global_id AS label_global_id, label.carrier, label.service_code,
       label.status AS label_status, package.global_id AS package_global_id,
       shipment.global_id AS shipment_global_id, shipment.status AS shipment_status
FROM operations_labels label
JOIN operations_packages package
  ON package.organization_id = label.organization_id
 AND package.id = label.package_id
LEFT JOIN operations_shipments shipment
  ON shipment.organization_id = package.organization_id
 AND shipment.package_id = package.id
WHERE label.organization_id = :organization_id
  AND (label.status <> 'voided' OR shipment.id IS NOT NULL)
ORDER BY label.created_at DESC;
```

Use provider-attempt and reconciliation tables, once implemented, to identify `unknown` purchases. Label rows alone cannot prove that a timed-out provider request did not succeed remotely.

### Unbilled Activity

```sql
SELECT customer_id, currency, status, count(*) AS facts,
       sum(amount_minor) AS amount_minor,
       min(occurred_at) AS oldest_fact
FROM operations_billable_events
WHERE organization_id = :organization_id
  AND status IN ('estimated', 'unbilled')
GROUP BY customer_id, currency, status
ORDER BY oldest_fact;
```

This query reflects the `0081` draft. The final model must separate immutable charge facts from mutable invoice/export lifecycle.

## Incident Severity

| Severity | Examples | Initial action |
| --- | --- | --- |
| SEV-1 | Cross-tenant/customer disclosure, oversell or unexplained inventory drift with active work, duplicate live label/ship confirmation, unauthorized provider/accounting action, broad data corruption | Freeze affected and potentially related scopes immediately; page security/database/provider owners; preserve evidence |
| SEV-2 | Import or warehouse work blocked, carrier/print outage without safe fallback, accumulating critical exceptions, optimizer outage causing material backlog, billing export blocked near deadline | Freeze risky command only, activate approved fallback, assign incident lead, communicate operating impact |
| SEV-3 | Isolated order/print/rate/reconciliation failure with safe manual path, noncritical report delay, single mapping issue | Create owned exception/task, contain one object, resolve within operating SLA |

## Standard Incident Flow

1. **Detect and scope:** environment, organization, customer, integration account, warehouse, order/package/shipment Global IDs, first/last observed time, correlation ID, and safe error code.
2. **Contain:** move the narrowest activation scope to `frozen`; stop physical work when digital state may be wrong.
3. **Preserve:** capture health counts, migration/application/adapter versions, audit/event IDs, queue IDs, provider references, and a backup when data repair may follow.
4. **Classify authority:** determine whether ClawPilot, provider, physical stock, or accounting destination has the trusted fact for this incident.
5. **Reconcile:** use read-only comparisons and provider lookup before retrying or compensating.
6. **Recover:** use the authorized domain command, same idempotency key, provider void/reconciliation, compensating ledger/charge fact, code rollback, or later migration.
7. **Verify:** rerun the relevant S-ID scenario, health, reconciliation, and one real workflow before unfreezing.
8. **Close:** record root cause, customer/financial effect, exact repairs, prevention, owners, and release evidence without sensitive payloads.

## Incident Playbooks

### Migration Or Startup Failure

**Contain**

- Keep operations disabled. If migration is inside a transaction, allow `db:migrate` to roll it back; do not manually mark it applied.
- Do not edit an applied migration to make a retry pass.

**Diagnose**

- Inspect the migration filename/checksum row, safe database error, existing constraint/table shape, and deployment commit.
- Determine whether failure is additive schema, data precondition, lock timeout, or checksum mismatch.

**Recover**

- Fix an unapplied migration only if it has never applied in any shared environment. Otherwise add a corrective migration.
- Redeploy with operations disabled and repeat schema/health checks. Restore only if a failed operation escaped its transaction and broad integrity is affected.

### Duplicate, Missing, Or Stuck Order Import

**Contain**

- Freeze import for the affected integration account, not unrelated warehouses.
- Continue read-only provider reconciliation; do not delete one of two apparent orders.

**Diagnose**

- Compare provider event ID, external order ID, receipt status, payload hash, canonical order, external identifier, import event, and outbox state.
- Verify signature, cursor, and adapter version. Determine whether this is redelivery, provider correction, missed webhook, or mapping failure.

**Recover**

- Replay the stored receipt with its original idempotency key after fixing mapping/code.
- Use reconciliation to import a missed provider order. Provider corrections become versioned order commands, not replacement rows.
- If duplicate side effects exist, stop and reconcile reservations, labels, shipments, and exports before merging any work through an approved repair.

### Inventory Drift Or Oversell Risk

**Contain**

- SEV-1. Freeze reservation, allocation, pick, adjustment, and shipment confirmation for every affected pool/position. Stop physical picking when system quantity cannot be trusted.
- Do not release reservations or edit positions with SQL.

**Diagnose**

- Run ledger reconciliation and compare physical count, open reservations, allocations, picks, shipments, returns, adjustments, pool ownership, lot/serial, and UOM conversion.
- Identify the first divergent ledger/event/correlation record and whether a transaction, offline replay, import, or manual process bypassed the command path.

**Recover**

- Fix code or configuration first. Record an approved physical count or compensating inventory command with reason, actor, source evidence, and new reconciliation.
- Replan affected orders and quantify customer/margin effect. Unfreeze only after zero drift and S07-S09 plus S23 pass for the affected pattern.

### Optimizer, Promise, Or Quote Failure

**Contain**

- Disable public checkout quotes if a response can violate a promise, leak cost, or select ineligible inventory.
- Permit deterministic fallback only when input completeness and fallback health are good.

**Diagnose**

- Compare input hash, algorithm/version, deadline, hard constraints, candidate/rejection evidence, carrier rate age, facility calendar/cutoff, and fallback reason.
- Distinguish solver outage from missing dimensions, inventory drift, carrier outage, or policy conflict.

**Recover**

- Restore the optimizer or correct versioned data. Replay the exact stored input to prove deterministic result.
- Never manually relax a promise or ownership constraint. An override creates a new plan version and exception with financial effect.

### Carrier Timeout Or Unknown Label Outcome

Provider behavior, capability, credential, timeout, response, and certification boundaries are defined in the [small parcel carrier adapter architecture](../architecture/small-parcel-carrier-adapters.md). RocketShipIt is an optional provider transport; it does not change the durable command and reconciliation requirements below.

**Contain**

- Freeze label purchase for the affected carrier account/service if reconciliation cannot determine outcomes.
- Keep package and order in exception; do not create a new purchase key.

**Diagnose**

- Locate the durable purchase intent, package version, provider key/reference, request hash, timeout, adapter/circuit state, and any carrier-side shipment/label.

**Recover**

- Query/reconcile by the original provider key or approved reference. If the label exists, persist that result idempotently. If the provider proves no purchase, retry with the same key.
- Void unwanted confirmed duplicates at the provider, retain both facts, prevent dispatch, and quantify cost. Never delete label evidence.

### Printer Failure Or Missing Physical Output

**Contain**

- Stop packing from assuming a queued job printed. Keep package shipment confirmation blocked if the process requires a physical label.

**Diagnose**

- Inspect job lease token, agent heartbeat, printer status/capability, route/rule version, attempts, fallback approval, and acknowledgement.

**Recover**

- Retry the same print job or create an auditable reprint command; route only to an approved compatible fallback. A print action never purchases another label.
- Mark every reprint and capture actor/reason. Confirm barcode readability before resuming.

### Short Pick

**Contain**

- Confirm the physical short and stop that task from completing as fully picked.

**Diagnose**

- Compare expected position, scans, lot/serial/UOM, physical count, reservation/allocation, replenishment, and other eligible positions/warehouses.

**Recover**

- Use the short-pick command. Allow deterministic reallocation only when ownership, pool, promise, cutoff, handling, and contract constraints still pass.
- Otherwise create one owned exception/task, update promise/customer communication through approved workflow, and reconcile the source position.

### Shipment Or Tracking Mismatch

**Contain**

- Stop duplicate confirmation/export. Do not set shipped/delivered based only on a stale browser response.

**Diagnose**

- Compare shipment, package, active label, manifest/pickup, carrier tracking observations, commerce fulfillment ID, and outbox acknowledgements.

**Recover**

- Reconcile carrier and commerce state using original references. Append tracking observations and replay idempotent exports.
- If physical dispatch occurred without digital confirmation, use an approved recovery command that consumes inventory and creates missing immutable facts once.

### Contract Or Billing Discrepancy

**Contain**

- Stop the affected customer's invoice/export cohort; do not rewrite facts or publish a new contract version retroactively.

**Diagnose**

- Compare operational source, occurred time, contract/version/directive, precedence, base cost, quantity/UOM, rounding, estimate/accrual/final facts, credits, and provider cost.

**Recover**

- Correct future rules through a new effective version. Correct historical financial effect with approved credit/rebill facts linked to the original.
- Rebuild projections from facts and export only after totals reconcile by customer, currency, and accounting destination.

### Cross-Tenant, Portal, Or Credential Incident

**Contain**

- SEV-1. Disable affected routes/cohort, revoke sessions/service identity, and rotate provider credentials when exposure is possible.
- Preserve security audit and access logs; do not copy sensitive returned data into the incident record.

**Diagnose**

- Identify authenticated/effective identity, active workspace, membership, customer scope, permission, resource Global ID, worker claim, and adapter credential reference.

**Recover**

- Fix server-side scope enforcement; invalidate caches/sessions; verify direct-object-reference negative tests across list/detail/search/export.
- Determine disclosure/action scope with security and legal owners before reactivation. Rerun S07, S22, and all affected permission tests.

## Queue Recovery

- First freeze creation of new affected jobs when a target is failing materially.
- Distinguish pending, retryable failed, stale processing, dead, and succeeded. A high pending count can be load; a dead or stale job is an integrity concern.
- Recover stale leases only through the worker's lease-expiry path. Do not clear lock columns manually during normal operations.
- Replay by original outbox row/idempotency key after correcting the cause. Never clone the payload to force another attempt.
- For consequential provider outcomes, reconcile remote state before retry.
- A dead-letter replay records actor, reason, previous attempts/error code, next attempt, and resulting provider reference.

## Backup, Restore, And Disaster Recovery

Before risky migration, bulk inventory import, tenant cutover, or broad repair, verify Railway daily/weekly/monthly backup policy and take a validated logical export according to the backup runbook.

An operations restore additionally requires:

1. Freeze provider webhooks/claims or route them to durable quarantine so events are not lost.
2. Record provider cursors, label/shipment/accounting references, physical warehouse cutoff, and last trusted event time.
3. Restore to an isolated database first and run migrations plus operations reconciliation.
4. Compare orders, inventory ledger/positions, reservations, plans, labels, shipments, billable facts, domain events, outbox jobs, and external identifiers.
5. Plan provider replay/reconciliation from the restored cutoff. Do not blindly resend all outbox rows.
6. Rebind the application deliberately, verify environment fingerprint and credentials, then activate one cohort at a time.

The owner must define operations-specific RPO/RTO and each provider's webhook/replay retention before production activation.

## Credential And Adapter Rotation

1. Create and validate the candidate credential against the exact provider environment and account without exposing it.
2. Compare declared capabilities and account ownership to the active integration account.
3. Atomically switch the opaque credential reference and increment credential/configuration version.
4. Keep old credential only for a bounded rollback window in the secret store, never in Postgres configuration JSON.
5. Verify webhook signatures, rate/label/tracking or commerce reconciliation, then revoke the old credential.
6. Record safe audit metadata: actor, account Global ID, provider, environment, old/new version, verification result, and time.

Changing provider account identity is not a key rotation. It requires explicit re-binding, external-ID and shipment reconciliation, and usually a new integration account.

## Append-Only Repair Policy

| Incorrect fact | Allowed correction |
| --- | --- |
| Inventory quantity/status/ownership | Approved adjustment, transfer, release, damage, return, or ownership-borrow compensation ledger event |
| Reservation/allocation | Release/consume/reallocation command and new plan version |
| Promise/plan | New calculation/input snapshot and plan version; old selection remains evidence |
| Package/rate/label | New package version, re-rate, provider reconciliation, void, or marked reprint |
| Shipment/tracking | Recovery confirmation or new tracking observation; never overwrite provider history |
| Contract/pricing | New effective contract version/directive; no retroactive mutation |
| Charge | Credit/rebill/adjustment fact with approval and original reference |
| Domain event | Corrective event with causation link; no deletion or payload rewrite |

Direct SQL data changes require a reviewed, idempotent repair script or migration, a backup, dry run, row-count guard, explicit organization scope, audit evidence, reconciliation, and rollback/compensation plan. Ad hoc SQL updates are not an operating workflow.

## Reactivation Checklist

- Root cause is fixed or a bounded safe fallback is approved.
- No migration checksum mismatch or unexpected schema state exists.
- Inventory and provider reconciliation is exact for affected scope.
- No unknown label outcome, duplicate active shipment, stale lease, or dead consequential job remains.
- Contract and billing totals reconcile when financially affected.
- Relevant S-ID tests, focused regression, health, and one real development workflow pass.
- Warehouse and integration owners agree on physical/provider state and cutoff.
- Activation resumes from `read_only` or `shadow` before `active` when state changed materially.
- Incident record names impact, repair, evidence, remaining risk, and follow-up owner.

## Connected Notes

- [Distributed Operations](../modules/distributed-operations.md)
- [Distributed Operations Integration and Gap Map](../maps/distributed-operations-integration-gap-map.md)
- [Distributed Operations Delivery, Migration, and Test Plan](../architecture/distributed-operations-delivery-plan.md)
- [Native Distributed Operations Authority and Adapter Boundaries](../decisions/0006-native-distributed-operations-authority.md)
- [Application Shell and Access](../modules/application-shell-and-access.md)
- [User Integrations and Credentials](../modules/user-integrations.md)
