---
id: cp-module-shipping
title: Shipping
summary: Standalone shipment creation, shipment records, and pickup readiness separated into Parcel and LTL workflows.
status: active
kind: module-contract
area: shipping
tags: [clawpilot, shipping, parcel, ltl, pickup, freight-class]
app_visible: true
---

# Shipping

## Purpose

Shipping is the operator-facing module for creating shipment plans, reviewing
shipment records, and scheduling pickups. Operations remains the durable order,
inventory, fulfillment, authorization, and audit authority.

The module deliberately keeps **Parcel** and **LTL** separate:

- Parcel uses loose boxes, envelopes, tubes, crates, or custom packages. The
  one-off flow rates the exact enabled accounts selected by the operator. UPS
  and FedEx offers can become a planned Operations order and later enter the
  audited whole-shipment purchase step. An activated Worldwide Express Small
  Parcel sandbox account can participate in comparison through read-only
  `shopFlow`, but its offers remain rate-only and cannot create or tender a
  shipment.
- LTL assumes cartons are palletized into outbound handling units. The current
  surface prepares advisory density-class evidence only. Worldwide Express and
  R+L rating, bill of lading/tender, and pickup orchestration are not connected
  to Create Shipment yet.

## Submodules

- **Create Shipment** presents separate Parcel and LTL buttons before shipment
  facts are entered.
- **Shipments** shows planned one-off records separately from carrier-confirmed
  Parcel shipments and successful LTL tender evidence.
- **Schedule Pickups** preserves separate Parcel and LTL readiness boundaries.
  It remains disabled until a pickup can be bound to the exact packed shipment,
  selected offer, pallet plan, credential revision, and carrier authority.

## Package and handling-unit catalog

`app_src/lib/operations/packageCatalog.ts` owns the versioned contract for
canonical pallets, cartons/boxes, envelopes, tubes, crates, custom packages,
and carrier packaging. Operator-facing labels are normalized ClawPilot names;
exact adapter package and handling-unit values remain internal.

The package menu is selection-aware:

- one selected carrier shows that carrier's name, then **Saved packaging** and
  **Custom packaging**, with each related package indented below its group;
- multiple selected carriers show the exact **Common packaging** intersection,
  plus compatible saved and custom packaging;
- changing selected accounts clears an incompatible package and invalidates
  prior rates rather than substituting another package type;
- FedEx requests fail before provider I/O when parcels would require mixed
  shipment-level packaging types;
- an unsupported provider, service, route, or package combination fails closed.

The Parcel dialog also reads the existing organization packaging-material
workspace. Active cartons map to canonical `box`; active poly and padded
mailers map to `envelope`. A material is selectable only when stock is marked
available at the selected warehouse. Rated exterior dimensions prefill the
form when present, but exterior dimensions and gross scale weight remain
editable operator facts. Material tare and maximum weight bounds are enforced.
When the same material is assigned to multiple parcels, available stock must
cover the aggregate number of selected parcels after other active plan claims.
Creating the reviewed one-off plan locks current warehouse stock, revalidates
that unclaimed balance, and creates one durable plan-scoped packaging claim per
material. The established shipment-confirmation lifecycle consumes that claim
and decrements physical packaging stock exactly once; failed transactions leave
neither the plan nor the claim behind.
The versioned catalog profile and optional material Global ID are sealed into
the one-off quote JSON.

Migration `0275_operations_one_off_carrier_selection.sql` seals the canonical
ordered selected-account set, credential versions, package-key-to-catalog
mapping, exact internal adapter package values, per-selection results, and
selection keys on retained rate evidence and offers. It retains provider- and
transport-level projections for existing downstream consumers. Packed rerating
reuses the original immutable selected-account set and never broadens it when a
new account becomes enabled later.

The LTL assessment replaces the free-text pallet key with normalized pallet
footprints. Standard footprints are only defaults: the operator still records
the greatest exterior dimensions and actual gross weight. Provider-specific
handling values remain inside the adapter and evidence; unsupported outer forms
remain unavailable until both the transport contract and adapter confirm them.

The pallet catalog choice is explicitly prefill-only in this assessment. Its
catalog entry ID and catalog version are not persisted or attested; saved
classification evidence instead seals the operator's final edited description,
dimensions, weight, classification reference, and attestation. A future rating
or tender lane must persist versioned package authority before treating a
catalog selection as execution evidence.

## Shipping integration capabilities

Settings separates shipping integrations by capability rather than by secret:

- **Small Parcel** presents direct UPS/FedEx administration and the Worldwide
  Express parcel connection. Existing USPS credential administration remains
  available, but USPS is not an executable Create Shipment rate source.
- **LTL** presents Worldwide Express LTL and R+L Carriers.

A Worldwide Express provider/environment account is stored once. Both views
read and update that same organization-scoped encrypted account, and activating
one rating mode preserves an already-active second mode. This avoids duplicate
credentials while keeping parcel and LTL readiness visible independently.

### Guarded production-label exercise

Direct UPS/FedEx one-off execution follows the selected connection environment:
a production connection uses the production rate and Ship endpoints, while a
sandbox connection remains on the provider sandbox. The live whole-shipment
path is available in the hosted production lane and in the exact trusted
ClawPilot Railway app service, project, and environment. Vercel deployments, browser
previews, generic development markers, and local runtimes cannot authorize or
select production postage.

Railway development eligibility is only a runtime boundary. It does not grant
carrier authority. Before any production provider call, the command still
requires all of the following current facts:

- Operations is Active and the actor can manage, execute, and activate
  Operations;
- the exact production UPS/FedEx connection is active, verified, and separately
  authorized for both `production_rate` and `production_label`;
- one active sender-billing account matches the sealed packed-rate evidence;
- every package is still packed, its immutable dimensions, weight, contents,
  and selected unexpired whole-shipment offer still match, and no competing
  active label or shipment exists;
- the operator supplies the explicit live-postage confirmation for the single
  idempotent purchase and the durable pre-call fence still passes.

A successful request creates real production postage and may incur charges.
The complete label group must be reviewed and then voided through ClawPilot for
an approved development exercise. Revoking `production_label` immediately
blocks new purchases but deliberately does not disable the exact-account void
path, so already purchased postage cannot be stranded. Provider acceptance is
not claimed by the runtime or unit tests; it requires a separately authorized
live exercise and recorded create/void evidence.

## Hermetic contract regression

`npm run test:shipping-package-catalog` runs both the catalog/UI contract and
`scripts/test-wwex-shipping-sandbox-regression.mjs`. The latter creates a frozen,
process-local AG Alchemy fixture using the known `AG-ALCHEMY-01` sandbox
warehouse identity, mock inventory, and separate Parcel/LTL mock orders. It
prepares and parses recorded Worldwide Express shop-rate fixtures for both
modes, proves deterministic request/result hashes, covers unsupported mappings
and provider failures, and asserts `prepare_only` with zero provider mutations.
This is a hermetic adapter regression, not a live provider sandbox test. It
never opens Postgres, loads credentials, calls a provider, tenders freight,
creates a label or pickup, or authorizes a charge. The script prints the exact
hash evidence and a cleanup record; process exit releases all fixture state, so
there are no durable fixture rows to remove.

The catalog test compares every exact catalog/provider mapping tuple against
readonly adapter definitions and migration 0275. Adding, removing, or swapping
an internal mapping without updating all three authorities fails the focused
gate. The one-off aggregate also verifies carrier-selection order independence,
duplicate/stale selection rejection, FedEx mixed-package rejection, packed
rerate selection preservation, rate-only no-write behavior, and the disposable
PostgreSQL seal.

## Guarded provider sandbox acceptance

`scripts/run-ag-alchemy-wwex-sandbox-acceptance.mjs` is a separate, opt-in
acceptance for actual Worldwide Express sandbox OAuth and read-only `shopFlow`
requests. Default and `--self-test` modes use no live database or provider.
Execution requires the exact confirmation printed by its default plan, the
trusted Railway development project/environment identity, the trusted database
fingerprint, a repeatable-read read-only transaction, the sole active AG
Alchemy warehouse, and an active verified WWEX sandbox rate capability. Its
network gate permits only the reviewed OAuth endpoint and `/svc/shopFlow`;
tender, integrated-order, pickup, label, BOL, and other provider mutation
routes are unavailable.

The 2026-08-12 guarded development run found no WWEX sandbox account or
credential for AG Alchemy, so both Parcel and LTL provider rate requests were
skipped with `wwex_sandbox_account_not_found`. No OAuth or provider shop call
was made. All eight inspected rate, pickup, tender, shipment, label, and print
table counts remained unchanged and no persistent fixture was created. The
hermetic regression therefore remains useful CI coverage, but it is not a
substitute for a successful provider sandbox rate after an AG Alchemy WWEX
credential is configured and verified.

The Shipping mode selector, first Parcel package selector, LTL handling-unit
selector, and Shipping integration capability tabs expose stable `data-testid`
selectors for centrally coordinated screenshots.

## Authorization

- Shipment records require Operations view access.
- Parcel planning and LTL classification evidence require Operations management
  plus warehouse execution access.
- LIVE carrier execution additionally requires Operations activation authority
  and the exact server-resolved provider capability.

Button state is never carrier authority. Every current and future mutation must
remain organization-fenced, idempotent, and durably prepared before provider I/O.
