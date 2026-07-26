---
id: cp-module-wms-development-simulation
title: WMS Development Simulation
summary: Safe generation and cleanup of the deterministic development-only warehouse operations scenario.
status: active
kind: module-runbook
area: operations
tags: [operations, wms, simulation, development, warehouse, inventory]
app_visible: false
---

# WMS development simulation

`scripts/seed-wms-development-simulation.mjs` creates one bounded,
development-only warehouse scenario for Operations and WMS testing. It writes
directly to the existing PostgreSQL domain tables and does not call commerce,
CRM, carrier, printer, email, label, or pickup services.

## Safety boundaries

- `WMS_SIM_ENV` must explicitly be `dev`, `development`, or `local`.
- `WMS_SIM_ORGANIZATION_ID` must explicitly identify the target workspace.
- A non-local database URL also requires a recognized provider environment
  variable, such as Railway's `RAILWAY_ENVIRONMENT_NAME`, set to a development
  value.
- There is no production override.
- The operator identity is disabled and uses an organization-scoped
  `wms-simulator+<organization-key>@clawpilot.invalid` address.
- Customer, product, order, receiver, and inventory records are synthetic and
  tagged with `clawpilot-wms-development-v1`.
- The scenario never stores credentials or creates rates, labels, shipments,
  pickups, print jobs, or email delivery.

## What it creates

- A disabled synthetic operator identity and disabled organization membership.
- A mock commerce integration with no credential reference.
- A synthetic CRM customer and four synthetic products.
- A distribution center at 101 Jegs Place, Delaware, Ohio 43015.
- UPS and FedEx outbound docks with 21:00 local cutoffs.
- Receiving, inbound staging, reserve, forward-pick, mezzanine,
  replenishment-staging, packing, shipping, and returns locations.
- Metric capacity limits and product-placement rules on storage and pick
  locations.
- A shared synthetic inventory pool, inventory positions, and immutable opening
  ledger entries.
- Twenty-one deterministic multi-line orders over seven days.
- Four released orders with reservations, allocations, pick tasks, carton
  plans, and planned packages. Their reservations leave the forward-pick and
  mezzanine faces below their documented minimums to exercise replenishment
  workflows.

The fixed default anchor date is `2026-07-25`. Override it only when a test
requires a different deterministic date.

## Generate

Use a local database:

```bash
WMS_SIM_ENV=local \
WMS_SIM_ORGANIZATION_ID=<workspace-organization-uuid> \
DATABASE_URL=postgresql://localhost/clawpilot_dev \
node scripts/seed-wms-development-simulation.mjs
```

Use a Railway development environment through its injected variables:

```bash
WMS_SIM_ENV=dev \
WMS_SIM_ORGANIZATION_ID=<workspace-organization-uuid> \
node scripts/seed-wms-development-simulation.mjs
```

The default pipeline is selected first. Set `WMS_SIM_PIPELINE_ID` to choose a
specific pipeline belonging to the supplied organization.

Generation is idempotent only before retirement. Before cleanup, re-running the
command refreshes the same tagged scenario without overwriting inventory
balances that operators changed while testing. After cleanup succeeds, the
organization-scoped simulator singleton and its order lineage are permanently
retired; generation is blocked for every scenario version.

## Inspect

Open Operations and select the supplied organization. The seeded warehouse is
named **Jegs Place Development Simulation** and has code `DEV-WMS-SIM-01`.
Search orders for `WMS-SIM-` or products for `[DEV WMS]`.

Run the pure fixture and guard checks without a database:

```bash
node scripts/seed-wms-development-simulation.mjs --self-test
```

## Cleanup

```bash
WMS_SIM_ENV=local \
WMS_SIM_ORGANIZATION_ID=<workspace-organization-uuid> \
DATABASE_URL=postgresql://localhost/clawpilot_dev \
node scripts/seed-wms-development-simulation.mjs --cleanup
```

Cleanup first locks and verifies the exact integration, warehouse, inventory
pool, customer, pipeline, and 21-order fixture. It refuses a pool or wave that
also contains unrelated operational records. It also refuses unrelated active
reservations, allocations, plans, receipts, replenishment tasks, inventory
positions, location rules, waves, printers, or print agents that would be
stranded by deactivating the simulator warehouse or pool. It never mutates those
unrelated records. After that fail-closed preflight, it releases active synthetic
reservations through compensating inventory ledger entries, cancels synthetic
orders, plans, waves, and pick tasks, dismisses linked open exceptions, archives
the orders, and deactivates the synthetic warehouse, locations, pool, mappings,
products, integration, actor, and membership.

Cleanup is one-way and terminal for this organization's WMS simulator lineage.
Rerunning cleanup is idempotent, but generation remains blocked afterward.
Global IDs, archived orders, inventory positions, immutable inventory ledger
history, and other evidence tombstones are intentionally preserved to maintain
ClawPilot's audit and no-ID-reuse invariants.
