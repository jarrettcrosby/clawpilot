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

The former Railway hosted-development invocation is retained below only as
legacy evidence. That environment is retired; do not run this command unless a
separate, isolated hosted-development service and database have been restored
and accepted:

```bash
WMS_SIM_ENV=dev \
WMS_SIM_ORGANIZATION_ID=<workspace-organization-uuid> \
node scripts/seed-wms-development-simulation.mjs
```

Local or disposable PostgreSQL is the only supported active simulation lane.
Never point the simulator at the Railway production database.

The default pipeline is selected first. Set `WMS_SIM_PIPELINE_ID` to choose a
specific pipeline belonging to the supplied organization.

Generation is idempotent only before retirement. Before cleanup, re-running the
command refreshes the same tagged scenario without overwriting inventory
balances that operators changed while testing. After cleanup succeeds, the
organization-scoped simulator singleton and its order lineage are permanently
retired; generation is blocked for every scenario version.

CRM hierarchy staging can normalize the synthetic customer's original simulator
identity to ClawPilot's canonical `customer:name:<normalized name>` identity.
Generation recognizes only the exact original identity pair or that exact
canonical pair and updates the same marked customer. Multiple marked customers,
mixed identity pairs, or a repurposed identity abort generation.

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

Customer verification is linkage-first: all 21 exact orders must reference one
marked synthetic customer, and the simulator pool must have exactly one
eligibility link to that same customer. The customer must retain the exact
fixture metadata and either the original simulator identity pair or the exact
canonical CRM name identity pair. Any duplicate, foreign linkage, mixed pair, or
third identity form aborts the transaction before retirement.

The synthetic customer and products are marked archived and retired in the
local CRM read model, and their ClawPilot CRM short links are disabled. Cleanup
refuses to race a processing SuiteCRM projection and terminally neutralizes only
the exact synthetic customer's or products' queued/failed SuiteCRM upserts while
preserving outbox evidence. It does not hard-delete local tombstones or delete a
historical SuiteCRM projection that was already delivered; that external
evidence requires a separately authorized SuiteCRM cleanup.

Cleanup is one-way and terminal for this organization's WMS simulator lineage.
Rerunning cleanup is idempotent, but generation remains blocked afterward.
Global IDs, archived orders, inventory positions, immutable inventory ledger
history, and other evidence tombstones are intentionally preserved to maintain
ClawPilot's audit and no-ID-reuse invariants.

### Preserve-printing retirement

`--cleanup-preserve-warehouse` is a narrow development recovery mode for a
simulator warehouse that became the owner of a real local-agent printer
binding. It is not a general cleanup shortcut. In addition to the normal
development guards, it requires an exact confirmation string and the Global IDs
of one warehouse, one printer, one print agent, and one already-retired foreign
proof location/pool/position.

The command applies the same exact 21-order verification and compensating
reservation releases as normal cleanup. It leaves the named warehouse active,
marks its simulator lineage retired, and preserves only the exact active
printer-to-agent binding. Any second active printer or agent, any additional
foreign position, or a foreign proof position that remains active, reserved, or
allocated aborts the transaction.

The approved one-time Express Parcel workflow, including its prepare and
finalize phases, is documented in
`docs/operations/express-parcel-development-warehouse-normalization.md`.
