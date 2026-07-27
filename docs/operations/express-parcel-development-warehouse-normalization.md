---
id: cp-operations-express-parcel-development-warehouse-normalization
title: Express Parcel development warehouse normalization
summary: One-time, fail-closed retirement of synthetic WMS and mock-proof data while retaining the live Zebra and carrier integrations.
status: active
kind: operations-runbook
area: operations
tags: [operations, development, warehouse, printing, cleanup]
app_visible: false
---

# Express Parcel development warehouse normalization

This runbook applies only to the Railway **development** database and the
Express Parcel workspace `ga8142977`. It retires the bounded 21-order WMS
simulator and eight mock-commerce proof orders, then makes the warehouse that
owns the working Zebra binding the real Delaware warehouse.

The process intentionally does not copy production into development. Suburbia
and Express Parcel remain real tenant fixtures in development, while synthetic
warehouse test lineages are retired with their audit evidence intact.

## Required retained identities

The normalization tool refuses to run unless all of these identities and their
relationships still match the approved development snapshot:

- operational warehouse `gwh7494117`;
- Zebra printer `gpr5630232` bound through local agent `gpt7418225`;
- delivered print job `gpj7874315`, artifact `gpf7529214`, label
  `glb5783781`, and proof order `gor3040630`;
- FedEx integration `gia8954146` and carrier account `gac9324986`;
- UPS integration `gia5798111` and carrier account `gac9831000`.

Inventory ledger entries, domain events, durable print jobs, delivery attempts,
rendered print artifacts, labels, and carrier credential/account identities are
never deleted. The old print-agent identity `gpt5737324` also cannot be deleted
or moved; finalization revokes it and retains its enrollment evidence.

## Before starting

1. Confirm a current Railway development PostgreSQL backup or point-in-time
   recovery boundary.
2. Confirm the local Zebra agent is running. Finalization requires its last
   heartbeat to be no more than 15 minutes old.
3. Run from the repository revision that contains both normalization scripts.
4. Export Railway development variables without printing secret values.
5. Set the actor to an active Express Parcel owner or admin.

There is no production override. The script requires
`CLAWPILOT_STORAGE=postgres`,
`RAILWAY_ENVIRONMENT_NAME=development`, a development `DATABASE_URL`, an exact
database identity, and an immediately prior plan digest for every write phase.
Live plan and write modes also require Railway project
`b5169ebd-8166-4b96-9a81-7cc8adaa9270` and development environment
`e4abd95f-825c-4242-b37b-825a92597e98`; those identities are compiled into the
one-time tool. Offline disposable rehearsal is a separate lane: it requires a
local PostgreSQL URL, no populated `RAILWAY_*` marker, and the exact
`EXPRESS_PARCEL_DEV_DISPOSABLE_REHEARSAL_CONFIRM=normalize-express-parcel-disposable-rehearsal-v1`
confirmation.

## Phase 1: plan and prepare

The default mode is read-only:

```bash
CLAWPILOT_STORAGE=postgres \
RAILWAY_ENVIRONMENT_NAME=development \
DATABASE_URL="$DATABASE_PUBLIC_URL" \
EXPRESS_PARCEL_DEV_ACTOR_EMAIL=<active-owner-or-admin> \
node scripts/normalize-express-parcel-development-warehouse.mjs --plan
```

Proceed only when `phase` is `prepare`. Record the database fingerprint and
plan digest, then run:

```bash
CLAWPILOT_STORAGE=postgres \
RAILWAY_ENVIRONMENT_NAME=development \
DATABASE_URL="$DATABASE_PUBLIC_URL" \
EXPRESS_PARCEL_DEV_ACTOR_EMAIL=<active-owner-or-admin> \
EXPRESS_PARCEL_DEV_DATABASE_FINGERPRINT=<fingerprint-from-plan> \
EXPRESS_PARCEL_DEV_PLAN_DIGEST=<digest-from-plan> \
EXPRESS_PARCEL_DEV_CONFIRM=prepare-express-parcel-dev-warehouse-v1 \
node scripts/normalize-express-parcel-development-warehouse.mjs --prepare
```

Prepare freezes Operations writes, verifies all eight mock orders carry the
nested proof marker, releases the seven active mock reservations through seven
compensating inventory-ledger entries, cancels mock tasks/plans/waves, archives
the mock orders, retires mock pools and routes, terminates only the mutable mock
contract projection, and removes only the two explicitly named unreferenced
mock printer profiles. Existing `operations_contract_versions` rows remain
immutable with their original status, dates, terms, and references. It leaves
the workspace frozen for the WMS phase.

Do not continue unless prepare reports `after.phase` as `wms_cleanup`.

## Phase 2: retire the WMS simulator

Use the exact environment block emitted by prepare:

```bash
WMS_SIM_ENV=development \
WMS_SIM_ORGANIZATION_ID=364b95d1-af2c-494d-8891-78c5d5abb7ac \
WMS_SIM_PRESERVE_CONFIRM=retire-wms-simulation-preserve-printing-v1 \
WMS_SIM_EXPECTED_DATABASE_FINGERPRINT=<fingerprint-emitted-by-prepare> \
WMS_SIM_PRESERVE_WAREHOUSE_GLOBAL_ID=gwh7494117 \
WMS_SIM_PRESERVE_PRINTER_GLOBAL_ID=gpr5630232 \
WMS_SIM_PRESERVE_PRINT_AGENT_GLOBAL_ID=gpt7418225 \
WMS_SIM_PRESERVE_FOREIGN_LOCATION_GLOBAL_ID=gwl1050773 \
WMS_SIM_PRESERVE_FOREIGN_POOL_GLOBAL_ID=gip7957421 \
WMS_SIM_PRESERVE_FOREIGN_POSITION_GLOBAL_ID=giv9161814 \
node scripts/seed-wms-development-simulation.mjs \
  --cleanup-preserve-warehouse
```

Do not edit or substitute the emitted fingerprint. Before opening the cleanup
transaction, the WMS tool reads `deployment.database.identity` from the
connected database and refuses a missing, malformed, or different identity.
`DATABASE_URL` remains required but is deliberately excluded from emitted
output because it is secret-bearing. Live preserve cleanup requires the same
compiled Railway project and development-environment identities. Its offline
disposable rehearsal lane requires a local PostgreSQL URL, no populated
`RAILWAY_*` marker, and
`WMS_SIM_DISPOSABLE_REHEARSAL_CONFIRM=retire-wms-simulation-disposable-rehearsal-v1`.

This mode retains only the exact warehouse/printer/agent binding named above.
The proof pool, location, and position must already be inactive, unreserved,
and free of active allocations. The normal simulator retirement still releases
the seven WMS reservations totaling 44 units through compensating ledger
entries, cancels and archives all 21 orders, and retires all marked simulator
objects.

Run a new read-only normalization plan. Proceed only when `phase` is
`finalize`.

## Phase 3: finalize

Use the new plan digest:

```bash
CLAWPILOT_STORAGE=postgres \
RAILWAY_ENVIRONMENT_NAME=development \
DATABASE_URL="$DATABASE_PUBLIC_URL" \
EXPRESS_PARCEL_DEV_ACTOR_EMAIL=<active-owner-or-admin> \
EXPRESS_PARCEL_DEV_DATABASE_FINGERPRINT=<same-development-fingerprint> \
EXPRESS_PARCEL_DEV_PLAN_DIGEST=<new-digest-from-plan> \
EXPRESS_PARCEL_DEV_CONFIRM=finalize-express-parcel-dev-warehouse-v1 \
node scripts/normalize-express-parcel-development-warehouse.mjs --finalize
```

Finalization:

- verifies the WMS and mock lineages are fully retired;
- verifies a fresh heartbeat and the exact immutable Zebra proof lineage;
- revokes the unused enrollment-only print agent;
- keeps retired simulator locations as inactive tombstones under unique codes;
- moves the exact nine dependency-free real locations from the enrollment shell
  into `gwh7494117`;
- copies the real Delaware facility and operating profile onto `gwh7494117`;
- assigns `DEL-OH-01` and `Jeg's Ecommerce Warehouse` to `gwh7494117`;
- leaves `gwh5361546` as an inactive technical tombstone because its immutable
  print-agent enrollment prevents deletion;
- restores Operations to `read_only`.

The completed plan must report `phase: complete`, one active real warehouse
under `gwh7494117`, nine active real locations there, no active reservations,
the exact Zebra binding, and unchanged FedEx/UPS identities.

## Recovery and evidence

Each phase is one PostgreSQL transaction and rolls back on any failed assertion.
The workspace deliberately remains `frozen` between prepare and finalization.
If the WMS phase or finalization fails, do not manually edit around the guard:
run the read-only plan, retain its output, inspect the reported drift, and
resume only after the contract or data discrepancy is understood.

Run the pure guards without a database:

```bash
node scripts/normalize-express-parcel-development-warehouse.mjs --self-test
node scripts/seed-wms-development-simulation.mjs --self-test
```
