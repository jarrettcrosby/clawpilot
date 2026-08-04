---
id: cp-module-distributed-operations
title: Distributed Operations
summary: Target domain and architecture contract for native order management, commerce sales channels, inventory, fulfillment, warehouse execution, shipping, and 3PL billing.
status: draft
kind: module-contract
area: distributed-operations
tags: [clawpilot, dom, wms, 3pl, commerce, shopify, faire, inventory, fulfillment, shipping]
app_visible: false
---

# Distributed Operations

## Purpose And Activation Status

Provide native distributed order management, warehouse execution, carrier shipping, and 3PL billing inside ClawPilot. The module serves 3PL operators, retailers, distributors, manufacturers, and fulfillment operators without creating a second application or duplicating CRM, product, identity, audit, task, document, notification, or accounting masters.

This document remains the **target contract** for the full module. The current development slice includes operations migrations `0081` through `0094`, `0097` through `0101`, and `0107` through `0195`; a tenant-scoped order workbench; explicit idempotent single-warehouse fulfillment-plan acceptance, warehouse-release, bulk all-ready pick-confirmation, pack-verification, sandbox-label-create, and sandbox-label-void commands for eligible non-archived orders; a durable exception queue; scoped activation controls; canonical CRM catalog projection; provider-customer resolution; team-managed product/package imports; warehouse-scoped Packaging Materials management; versioned Product each/case profiles and separately evidenced exact-case and loose-each recipes; retained Shopify/Faire channel taxonomy; immutable CRM Product image assets; an exact resource-scoped Shadow Shopify image-publish command; organization-scoped direct carrier credential administration; UPS and FedEx sandbox rating with an account-derived origin and editable test destination; a separate rate-selected diagnostic label-create with customer-selected provider-native output, stored-label download/print, and void workflow; immutable provider-source bytes plus an explicit derivative-artifact provenance boundary; append-only redacted provider evidence; carrier-rate delegation; direct multi-account carrier CSV import; selected-batch GL Coding; separate financial review; billed-actual Triangle/Square/Circle settlement evidence; append-only settlement status transitions; capability-aware printer configuration; enrolled local print-agent delivery with controlled reprints, same-warehouse fallback, and agent-declared format/media/document capabilities; final shipment packing-slip and provisional exact-package Pack Work Instruction PDF renderers, immutable artifact-payload store, authenticated artifact stream, tracking-observation schema, and commerce-fulfillment export state model; a Shopify/Faire sales-channel control plane; a bounded development-only Shopify held-order preview; leased development-only full-product-catalog reconciliation and current-order intake workers; guarded development-only product-catalog mapping and operational-order workflows with durable pre-call read intents, resource-scoped encrypted continuations, first-class rejection dispositions, and canonical promotion; a bounded development-only, leased, automatically scheduled, read-only Shopify inventory reconciliation for one eligible account/location/warehouse with the manager command retained as manual recovery; a strict development-only Shopify cartonization preview; a recipe-first, assumption-watermarked sandbox package-and-rate evidence workflow; an executable development-only two-pass pack-and-rate replay workbench; an authenticated idempotent command that derives one immutable Active execution, shipment group, and ordered package set from exact zero-write Shadow evidence; append-only production fulfillment-rerate runs, exact package snapshots, prepared provider attempts, terminal results, normalized offers, one immutable selection, and authoritative Active dispatch linkage; an authenticated Operations command backed by a read-only production UPS/FedEx whole-shipment HTTP rerate executor that commits the exact prepared attempt before token/rate I/O and persists terminal response evidence; a separate authenticated manual command that selects one unexpired offer as the single service for that whole package set without provider I/O; a persistence-only Active dispatch-attempt boundary with one durable owner, exact replay, strictly proven retryable nonshipment retry, unknown-outcome blocking, and safe failed/unknown finalization; and active-workspace measurement-presentation and product-currency defaults. The deterministic mock flow remains an internal automated-test harness only. Hosted mock generation is disabled and historical mock artifacts are archived. These features prove PostgreSQL authority and application boundaries; they do not establish historical closed-order commerce import, production or bidirectional provider inventory synchronization, production commerce workers, production carrier mutation, service auto-selection, production label or tracking creation, tracking ingestion, commerce-export dispatch, pickup scheduling, accounting export, invoice/AR workflow, payment adapters, or production fulfillment-optimizer activation.

Migration `0178` has a focused, disposable PostgreSQL acceptance at
`scripts/test-shopify-customer-rate-policies-postgres.mjs`. It applies the full
migration chain in an isolated container and proves migration presence,
tenant/account fencing, exact Customer GID uniqueness, bounded and fail-closed
Shadow expiry, optimistic row-version conflicts, durable removal tombstones,
and the database-level Shadow zero-provider-write trigger. Migration `0188`
extends that acceptance with the normal-charge default, exact visible-service
and reason constraints, semantic-hash resealing, Shadow-only subsidy writes,
Active rejection, and subsidy clearing on removal.

Migration `0180` adds the separate append-only production fulfillment-rerate
ledger without rewriting migration `0177` Shadow history. One run is bound to
one exact current Active execution, shipment group, order, plan, warehouse,
destination, activation revision, and ordered package set. Provider requests
are durable `prepared` attempts before network I/O; succeeded, failed, or
unknown terminal results are appended separately, succeeded results own
immutable normalized whole-shipment offers, and one unexpired immutable
selection is authoritative for a later Active carrier dispatch attempt. Carrier
account configuration revisions and encrypted-credential fingerprints are
database-managed evidence in that binding.

The authenticated Operations `prepare-active-fulfillment-execution` command
is the only application boundary in this slice that derives those `0179`
Active rows from retained Shadow evidence. It requires manage-plus-execute
access, the current exact Active activation revision, one packed Shopify order,
its exact expected row version, a specific operator reason, no open high or
critical exception, one released single-warehouse plan, one active warehouse,
one Shadow execution and shipment group with all four provider-write counters
at zero, no linked label attempt, label, or shipment, and the exact contiguous
1-through-50 packed package set from the Shadow rate run. Every current physical
package must retain the source Shadow package sequence, dimensions, and gross
weight exactly. Migration `0182` persists the expected order row version and
operator reason on the immutable Active execution and constrains the reason to
1-through-500 trimmed, control-free characters. One idempotency-key receipt and
canonical request hash commit with the Active execution, shipment group, and
package edges in a single transaction. Exact replay returns that immutable
result; changed evidence under the same key, a stale activation or order
version, an open blocking exception, a second key for an already-bound Shadow
execution, a tenant mismatch, or altered package sequence, dimensions, or
weight fails closed. Preparation performs no carrier or commerce network call and
creates no carrier attempt, label, tracking fact, shipment, packing slip, print
job, inventory mutation, fulfillment export, or provider write. Its inherited
service and amount remain a planning estimate until the separate production
rerate and offer-selection commands establish execution-time authority.

Migrations `0183` through `0187` and `activeCarrierDispatchPersistence.ts` add only the next
durable Active carrier-dispatch persistence boundary. Preparation revalidates
one exact current production-rerate selection under tenant-scoped row and
transaction advisory locks, writes the immutable redacted request snapshot,
commits that prepare transaction, and only then returns dispatch ownership to
exactly one caller. Exact replays return the same attempt without ownership.
Only a terminal failed attempt with `retryable: true`,
`shipmentOutcome: 'not_created'`, and either proof that the request did not
reach the provider or a received `provider_rejected` response may create the next consecutive
attempt with a fresh provider idempotency identity while retaining the exact
provider, service, and package group. A prepared,
succeeded, or unknown attempt blocks another owner; an unknown result remains
reconciliation-only. The current finalizer records only failed or unknown
terminal evidence. Terminal diagnostics use a strict application-generated
allowlist; unsafe or arbitrary provider evidence is discarded and terminalized
as unknown so reconciliation is required rather than retry. The immutable
request, group response, Active-linked label evidence, and package-result
evidence all pass the production carrier-evidence redaction gate. Migration
`0183` installs the four constraints as `NOT VALID`; migrations `0184` through
`0187` validate the group-attempt, package-result, Active-linked label-attempt,
and Active-linked label tables separately so each populated-table scan owns its own validation
transaction. Dispatch cannot precede durable preparation, completion cannot
precede dispatch, terminal timestamps may be at most five seconds ahead of the
database clock, and a retry prepare cannot predate the preceding terminal
completion. This persistence slice
has no public route, worker, token exchange, or carrier adapter call. Successful
finalization is intentionally rejected until every package label, shipment,
tracking fact, inventory effect, and downstream completion artifact can be
materialized atomically.

The current application exposes that read-only boundary through the
authenticated Operations `execute-production-rerate` command. It requires the
current Operations Active activation revision and binds the exact integration
account, carrier account, credential generation and fingerprint, ordered
package set, origin, destination, and billing relationship. The executor
commits the prepared provider attempt before acquiring a token or opening the
UPS/FedEx rate connection, never makes a second provider call when that
prepared attempt is replayed, and persists the terminal response evidence.
It neither selects a service automatically nor creates a shipment, label,
tracking fact, provider mutation, or commerce write.

The separate authenticated Operations `select-production-rerate-offer`
command is a manual, ClawPilot-local authority decision. An Operations manager
with execution access supplies one exact rerate-run Global ID, one offer Global
ID, a specific reason, and an idempotency key. The command accepts only an
unexpired successful offer from the same tenant, run, exact ordered package
set, current order destination and currency, current production carrier
integration/account/credential binding, and current Active revision when the
first selection is created. The idempotency key and canonical command hash
commit in the same transaction as the immutable result receipt: the same key
and exact normalized command return
that selection, while changed command data under the same key conflicts. The
first selection covers the entire package set with one provider service. A new
key for that same run and offer returns the existing immutable selection as
historical evidence even if its offer has since expired or current order,
activation, integration, account, or credential authority has drifted; this
replay is not fresh dispatch authority. A different later offer conflicts.
Any later dispatch must independently revalidate the selection's expiration
and every current authority fence before a provider write. Selection does not
call UPS or FedEx, create or void a label, obtain tracking, confirm a shipment,
consume inventory, render a final packing
slip, or write Shopify or Faire. It only supplies the exact local authority
that a later, separately guarded Active dispatch must consume.

Migrations `0128` through `0145` extend this slice with the pack hierarchy,
CRM CSV transfer evidence, durable sales-channel lifecycle and offer
projection, guarded canonical Product identity reconciliation, and
database-enforced packaging-dimension evidence described below.
Additive migrations `0146` and `0147` correct the development pricing
vocabulary and add append-only billing-time MUD evidence. They preserve legacy
replay rows, require new replay rows to keep MUD empty, and allow a MUD result
only after imported carrier-billing evidence has an approved exact shipment
match and an applicable approved `actual_cost` directive. These migrations are
development evidence, not production billing activation.

Migrations `0148` through `0150` add the provider-effect fence,
customer-neutral Shopify checkout-rate configuration and evidence,
deterministic quote-to-order reconciliation, and the historical
CarrierService authorization schema. Operations `shadow` remains
provider-write-ineligible without exception: simulation cannot create or
consume a provider-write authorization, decrypt the Shopify credential for
that mutation, or call Shopify.

Migration `0156` introduced the single-consumption CarrierService mutation
attempt, exact provider evidence, and local-only finalization contract.
Pre-`0156` Shadow authorization rows remain immutable audit evidence and cannot
be claimed.

Migration `0159` removes the false dependency between signed Shopify webhook
receipt intake and checkout-rate activation. The verified API connection,
signed-receipt queue/hold policy, CarrierService registration, callback
readiness, and global Operations mode are independent facts. After an exact
zero-write Shadow simulation, an owner or authorized administrator may confirm
one short-lived, resource-scoped grant for one exact CarrierService operation
while global Operations remains `shadow`. The resource-scoped Shadow revision
is a pre-call write fence, not a post-call local-finalization dependency. The
grant is bound to the current verified credential generation. The attempt is
claimed before credential decryption or network I/O, cannot be reused, and
permits only sandbox create or exact sandbox/production delete.
Unknown provider outcomes become reconciliation-only and are never retried
blindly. A verified Shopify connection remains generic-status `active` while
signed receipts may remain held; `error` still fails closed. The grant does not
authorize product, inventory, order, fulfillment, label, tracking, webhook
subscription, or any other provider mutation. Once an immutable succeeded
outcome or confirmed-applied resolution exists, an unchanged CarrierService
configuration can link that exact evidence even if later activation or
credential state drifts. That local-only link cannot authorize another
provider call or retry. Inserting the single-consumption attempt is the
provider-authority cutoff. Callback readiness remains a separate live
predicate recalculated from the current verified credential generation,
configuration revision, Shadow activation revision, warehouse, packaging
stock, and carrier facts; it never depends on the signed-receipt queue/hold
switch.

Migration `0167` adds the explicit provider-neutral Operations
Shadow-to-Active authority boundary. An owner or authorized administrator first
prepares metadata-only evidence for the exact verified Shopify/Faire accounts,
provider identities, credential generations, granted scopes, and selected
write capabilities at one Shadow revision. Preparation decrypts no credential
and makes no provider request. A separate five-minute authorization binds the
fixed confirmation statement and exact cohort hash; consumption, account-status
alignment, and the Shadow-to-Active revision change occur atomically. Tenant,
actor-role, account, credential, identity, scope, capability, or activation
drift fails closed. The immutable transition is only a capability-claim root:
each provider effect still requires implemented capability support plus its own
exact claim/effect fence, and this migration itself invokes no provider client
or worker. Active preparation, authorization, consumption, and claim lookup
all consult the same ClawPilot implementation registry: a provider-supported
capability marked `not_implemented` remains visible but disabled in the
operator review and cannot be selected, authorized, consumed, or returned as a
current capability claim.

Migration `0168` makes generic commerce-account status describe eligibility
for verified provider reads and registered callback computation. A successful
Shopify or Faire connect, credential rotation, or current-generation
verification sets the account `active`; an authoritative verification failure
sets it to `error`, and disconnect deletes the credential and sets it
`disabled`. The migration backfills only `disabled` commerce accounts whose
current credential generation is still `verified` and leaves `error` accounts
unchanged. `receipt_intake_enabled` remains independent and is not enabled by
connect, rotation, verification, or the backfill. Generic `active` status does
not authorize any provider mutation: Operations activation, capability
support, an exact resource-scoped authorization, and the existing claim fence
remain mandatory.

Migration `0166` extends that same single-consumption authority to the
customer-facing CarrierService name. Before a name preference is saved, a
create or update is simulated, or its exact provider mutation is authorized,
ClawPilot performs a read-only Shopify identity refresh. The server-derived
desired name defaults to the normalized `shop.name` returned by that refresh.
After checkout-rating configuration exists, an owner or authorized
administrator may save a separately audited optional override before the
initial registration or later alignment. The override is not
provider-verified identity; clearing it restores the refreshed provider
default, and changing it advances the configuration revision.

The desired name and provider-confirmed applied name are separate facts. Every
create and name-update Shadow simulation is bound to the exact mutation
request hash, configuration row, activation revision, and credential
generation. Initial registration creates the CarrierService with the exact
desired name and stores Shopify's confirmed result as
`registered_service_name`. A later alignment may update only the `name` of the
exact existing CarrierService GID in place. The callback URL, active state,
service-discovery state, CarrierService identity, and Shopify
shipping-profile assignments remain unchanged. A successful update requires
Shopify to return the same GID and exact desired name before
`registered_service_name` advances. An uncertain update is reconciled by
reading that exact GID; only an exact name match confirms application, while
any mismatch remains inconclusive and is never blindly retried.

A registered CarrierService is callback-ready only when its
provider-confirmed `registered_service_name` exactly matches the currently
derived desired name. Changing or clearing an override, or refreshing a
changed Shopify `shop.name`, therefore fails closed until the exact in-place
alignment succeeds or is confirmed applied. Checkout never advertises a
desired name that Shopify has not confirmed on the registered resource.

The setup projection evaluates mutation recovery only against the current
CarrierService configuration row version. A succeeded or confirmed-applied
authorization can require local-only recovery only while its recorded
configuration row version still equals the current row version and the
expected registered or disabled transition is absent. Once that transition
advances the configuration row, the immutable historical authorization remains
visible as audit evidence but cannot block simulation or authorization of a
later exact operation. This revision fence prevents a completed delete from
being misclassified as an uncommitted recovery after a newer create simulation.

Migration `0160` applies the same resource-scoped Shadow authority pattern to
Shopify Product image publishing. The operator must first run an exact
zero-write Shadow simulation, then an owner or administrator may issue one
short-lived authorization for that same ClawPilot Product, Shopify parent
Product GID and variant listing, active channel-state revision, primary image
asset revision, credential generation, and global Shadow revision. The
five-minute authorization and its provider effect are single-use and cannot be
replayed for another Product, listing, image revision, channel state, or
provider effect. The immutable delivery grant and signed URL remain usable only
to serve the same verified image bytes during Shopify's bounded 15-minute
asynchronous fetch window; a hash-only source binding ties that exact URL to
the authorization, grant, Product, and image revision before effect
preparation.
Shopify ProductVariant GIDs are the sellable-item boundary, so sibling
variants beneath one Shopify parent Product may map to separate ClawPilot
Products for catalog, inventory, order, and pack workflows. Product-image
publication is a narrower parent-level projection. If that parent Product GID
maps to more than one ClawPilot Product, its grant preparation, authorization,
and effect claim all fail closed before a provider call while catalog
observation remains available. Global Operations remains `shadow`; there is
no generic Active Product-image path.
Authenticated image upload and publication commands also recognize the
configured ClawPilot HTTPS public origin and an unambiguous proxy-routed
origin when a hosted platform terminates TLS ahead of the application.
Missing origins, unrelated origins, ambiguous forwarding headers, and browser
requests marked `cross-site` still fail closed.
The same configured public origin is used for the exact signed Shopify media
delivery URL; an internal bind address is never projected to Shopify.

Migration `0157` treats a Shopify CarrierService receipt as reusable immutable
rate evidence because Shopify may cache one exact callback response across
multiple identical checkout requests. Each order still must match exactly one
receipt by account, time window, shippable quantities, destination, currency,
selected stable service code, and customer charge. Multiple matching receipts
remain ambiguous and fail closed; the first imported order no longer consumes
the receipt and arbitrarily blocks a later identical order. A pre-`0157`
rejected or expired decision remains immutable; the migration appends a
separate matched supersession only when the database recomputes exactly one
current receipt offer, and the current-decision projection then exposes that
successor to intake and warehouse release. Zero or multiple matches create no
successor. Migration `0158` adds the account/resource/provider-identity index
used by the current-issue projection while preserving append-only rejection
history.

Migration `0126` is the bounded, owner-safe data correction that renames only
the exact original imperial-named `starter_assortment` records to unit-neutral
labels. It preserves material codes, canonical dimensions and weights, cost,
stock, status, and every operator-edited name.

## Current Development Slice

The implemented slice provides:

- Postgres-only operations access scoped to the active workspace and explicit `viewOperations`, `manageOperations`, and execution permissions;
- CRM organization and `gp` product resolution without cloning customer or catalog masters;
- one explicit CRM data pipeline per workspace, deduplicated customer and product catalogs by permanent Global ID, and deterministic provider-customer matching with review-required staging for ambiguous or unmatched identities;
- an internal test-only deterministic order, reservation, planning, cartonization, carrier, and print harness that cannot create hosted workspace records without an explicit automated-test feature flag;
- operator-controlled warehouse release with exact-version concurrency, readiness and exception checks, transactionally serialized revalidation of every active Shopify provider commitment against the newest sufficient successful inventory projection while preserving its original acceptance evidence, one released wave, ready pick tasks, domain event, audit evidence, and replay-safe command receipts;
- operator-controlled bulk pick confirmation with exact-version concurrency, affected-position locks, all-ready validation, one completed wave, picked tasks, retained reservations, immutable local-authority pick-ledger evidence, no second local ledger movement for Shopify-authoritative picks, domain event, audit evidence, and replay-safe exact result payloads;
- operator-controlled pack verification with exact-version concurrency, released-plan and completed-pick validation, one packed package, retained reservations for shipment consumption, immutable pack-fee evidence, domain event, audit evidence, and replay-safe exact result payloads;
- a shared CRM product catalog that authorized pipeline editors can maintain individually or import from CSV, with a permanent `gp` product identity, duplicate prevention by SKU or case-insensitive name, per-row validation, and bounded partial-import results;
- one organization-scoped default package profile per product in this slice, with permanent `gpp` identity, package type, unit of measure, units per package, preferred metric or imperial entry system, dimensions, weight, active state, source, optimistic row version, and audit history; fulfillment planning consumes canonical millimeters and grams from the active profile and records its provenance, while products without a profile retain the explicit conservative fallback;
- an active-session-scoped measurement presentation preference with an organization default and nullable per-user-per-workspace override; any active member may update only their own override, only an effective owner or administrator may update the organization default, organization writes require an exact optimistic revision, and the response identifies whether the effective system came from the user, organization, or compatibility fallback; a runtime with no active organization uses the compatibility fallback without a persistence request or save attempt;
- an organization ISO 4217 currency default, initially USD, used only when a new ClawPilot Product or product CSV row has no record currency; existing CRM products and Shopify, Faire, carrier, order, and imported money retain their own currencies, and no preference change converts an amount or relabels a source fact;
- archived legacy hosted mock proof records with reservations released and immutable ledger, domain-event, audit, billable, and Global ID evidence retained;
- an exact-scenario development WMS simulator retirement command that releases active reservations with compensating ledger entries, cancels linked execution, dismisses linked open exceptions, archives the 21 synthetic orders, deactivates scenario fixtures, preserves evidence tombstones, and removes retired scenario orders, facilities, pools, products, and customer fixtures from the default Operations workspace; retirement is terminal for the organization-scoped simulator singleton and its order lineage, so no later scenario version can reseed it;
- a guarded development-only establishment command that retains the existing Suburbia Sandwich Co and Express Parcel International DBA EPISCS workspaces, creates AG Alchemy, LLC as a separate switchable nondefault test workspace, re-establishes the AG Alchemy Shopify credential under that workspace without moving Express evidence, preserves the Express UPS, FedEx, physical Zebra, print-agent, and bound warehouse identities, and retires only the exact synthetic warehouse/mock operating state through compensating facts and tombstones; plus a separate plan-first command that projects exactly one AG warehouse from its sole active Shopify fulfillment/shipping location and refuses zero, multiple, or mismatched origins;
- a separate guarded Railway-development delegation that leaves EPISCS as the unchanged UPS/FedEx credential owner, creates fresh AG-scoped encrypted sandbox identities, projects AG warehouse `gwh5366613` as sender origin, and defaults AG to the `sandbox_rate` capability while credential reveal, carrier-account mutation, production execution, pickup, manifest, shipment, and unrelated provider-write paths remain blocked. A separately confirmed diagnostic profile may add only `sandbox_label` so an administrator can execute the real sandbox sequence of rate, exact-service label creation, immutable file download, compatible one-copy test print, and void or UPS CIE local sample close; returning to the default profile immediately revokes every stored-label action;
- organization-scoped `disabled`, `shadow`, `read_only`, `active`, and `frozen` activation state with revision, reason, actor, and audit history;
- organization-, provider-, and environment-scoped UPS REST, FedEx REST, and USPS REST credential administration with candidate OAuth verification, AES-256-GCM persistence, masked metadata, rotation versions, audited activation and disconnect, and no cross-tenant or production/sandbox fallback;
- manager-triggered UPS CIE and FedEx Sandbox rating that uses the selected active billing account's sender identity and registered address as the read-only origin, an operator-editable validated U.S. destination, and one fixed `Test Product` parcel, with normalized quote-only results and append-only PII-redacted `grq` evidence; production rating remains disabled;
- a separate execution-authorized Settings diagnostic that selects one exact evidenced rate, durably prepares and finalizes the carrier sandbox Ship API call, validates and stores decoded provider label bytes under permanent test-label and attempt identities, routes those stored bytes to a compatible printer without another carrier call, and voids through the exact persisted account; rating itself never returns label media or tracking. When this label workflow is authorized, its Step 3 print-readiness panel remains visible before a stored label is selected and reports one blocking prerequisite in deterministic order: create or select a stored label, obtain warehouse-execution permission, reject a voided label, then evaluate the organization's browser-safe printer profiles in active warehouses. Printer readiness distinguishes no available profile, exact shipping-label format/media/document capability mismatch, an exact-compatible printer that is offline or disabled, and an online exact-compatible printer that is not bound to an active enrolled local agent. The test-print action remains disabled until every prerequisite and an exact eligible printer selection are present;
- manager-triggered UPS CIE and FedEx Sandbox order-bound label creation and immediate void for the fixed synthetic packed-order shipment, with immutable `gla` prepare/call/finalize attempts, one active label per package, exact carrier-account reuse on void, redacted provider evidence, domain and audit events, and retry blocking whenever the provider result is unknown. These order-bound carrier mutations require Operations activation state `active`; `shadow` rejects create and void with `409 OPERATIONS_LABEL_ACTIVE_MODE_REQUIRED` before provider I/O, so Shadow may retain bounded carrier reads and local comparison evidence but never calls carrier label or void APIs;
- post-commit routing of a successfully persisted sandbox shipping label into one idempotent durable print job; replay of the original label command can recover a missing print job without calling the carrier again, while print retry and reprint remain separate from label purchase;
- a strict sandbox boundary: Settings diagnostics and order-bound label create/void can never create an `operations_shipments` row, mark an order shipped, consume or release inventory, append a tracking observation, create a commerce-fulfillment export, or render a packing slip; the Settings diagnostic additionally creates no order, package, or fulfillment-plan record;
- working-tree shipment-completion evidence contracts in `0099`: immutable packing-slip payloads, append-only `gto` tracking observations, and durable `gfe` commerce-fulfillment export intents with explicit `queued`, `processing`, `succeeded`, `failed`, and `unsupported` states;
- deterministic PDF document renderers with content hash, byte length, safe filename, template version, and immutable render snapshot; an exact-package **Pack Work Instruction** renderer whose durable package-content rows allocate every order-line quantity to one physical package, paginate without line truncation, and support package-specific generate, download, and print without a carrier call; a separate final packing-slip renderer bound to shipment and tracking evidence; organization-scoped authenticated exact-byte ZPL/PDF/PNG artifact download with safe MIME/extension, SHA-256 validation, and ETag; and local print-agent claims that preserve label text as `utf8` while encoding binary artifacts as `base64`. The existing database and local print-agent compatibility identifier remains `packing_slip`; a current pre-label artifact requires `source_shipment_id IS NULL`, template `pack-work-instruction-package-letter-v1`, and immutable render metadata `documentKind = pack_work_instruction`, `documentStage = pre_label_pack_work_instruction`, and `finalPackingSlip = false`. A package-scoped historical artifact without that template remains a **legacy pre-label packing list** for audit, is never relabeled as a Pack Work Instruction, and may coexist with one newly rendered warned Work Instruction without rewriting either artifact;
- explicit Triangle, optional Square, and Circle rate-path evidence; address-bound multi-account carrier identities; immutable customer-facing checkout shipping-charge evidence kept separate from checkout and pre-label carrier estimates; direct checksum-bound carrier CSV import; selected-batch shipment GL Coding; versioned shipper-assignment rules; independent shipment matches and shipper assignments; manual orphan assignment; separate run approval; exact matched carrier-billed actuals; billing-time MUD evaluation only for an effective approved `actual_cost` directive with immutable provenance, with explicit `not_configured` evidence otherwise; billed-actual reimbursement and payable entries; disputes; references; and append-only settlement transitions;
- organization- and warehouse-scoped thermal and nonthermal printer profiles with connection mode, supported formats, supported media, supported document types, document defaults, priority, status, same-warehouse fallback selection, enrolled local print agents, fenced claims, bounded retries, and reasoned reprints; a printer bound to an agent must be a subset of that agent's explicit capabilities, and each claim repeats the runtime capabilities so a mismatched worker fails before receiving bytes; browser delivery remains best effort;
- the Printing workbench's primary agent count represents active, job-eligible agents only. Revoked enrollments remain visible as explicitly labeled audit history and never inflate the usable-agent count or claim print jobs;
- a print-job operator drill-down with source order, shipment, carrier label, tracking, destination, package measurements, warehouse/station/printer routing, artifact integrity, authenticated exact-artifact download, retry and reprint lineage, safe failure evidence, and every agent/device delivery attempt; live agent heartbeat is reported separately from the printer's last acknowledged document handoff;
- durable command receipts that bind idempotency key, request hash, actor, correlation, status, exact result payload, attempts, and safe failure evidence;
- a **Settings > Integrations > Sales channels** control plane for one Shopify store and one Faire brand per organization/environment, with live identity verification before AES-256-GCM persistence, masked-by-default credential identifiers, an audited 30-second reveal of the current application credential for an authorized owner or administrator, explicit disabled-by-default state, immutable provider identity, monotonic credential generations, adapter/API version, scope and capability evidence, and audit history;
- a Shopify Dev Dashboard client-credentials exchange for an installed same-organization store, with 24-hour access tokens acquired only when needed and never persisted; an Admin GraphQL client pinned to `2026-07`; strict canonical `*.myshopify.com` endpoints; bounded requests/responses; reported-scope inspection; raw-body HMAC verification; a narrowly public account-specific receipt URL; event-ID deduplication; encrypted webhook bodies; durable cursor/retry/dead-letter structures; and an explicit receipt-intake-only activation label;
- a feature-gated, manager-triggered Shopify held-order preview for a configured and verified `sandbox` store: it reads at most the newest 25 non-test orders, retains only minimized diagnostic fields for no more than 24 hours, compares line SKUs with existing local product mappings and package-profile readiness, and records explicit zero canonical-order, zero Shopify-write, and no-cursor-advance evidence;
- separate feature-gated Shopify/Faire catalog and operational-order workflows for configured and verified accounts: each provider read first persists a fixed idempotent intent, bounded product pages stage map/create/exclude candidates, bounded nonterminal order pages stage resolve/validate/promote candidates, continuations are encrypted and resource scoped, Shopify pages are time-fenced, Faire order candidates require exact refresh, and every rejection exposes exact order retry or audited exclusion; a leased development-only order worker automatically stages current order pages under the same read/capture/normalize path without canonical promotion, inventory mutation, shipment creation, cursor advance, or provider write;
- order promotion preserves exact provider order-time money, including a zero-priced sell unit, and accepts PostgreSQL scale-formatted quantities such as `50.000000` only when their fractional component is exactly zero; genuinely fractional, negative, malformed, currency-mismatched, or unresolved remaining demand still fails closed before a canonical order is created;
- a feature-gated Shopify inventory reconciliation for a configured and verified account with `read_inventory`, `read_locations`, and `read_products`: a leased development worker automatically refreshes one eligible account/location/warehouse before checkout evidence reaches half its configured maximum age, while the manager command remains a recovery control. Both paths durably prepare the provider read, capture the bounded complete response before applying it, map one eligible Shopify location to the workspace's one active warehouse and selected reserve/storage location, retain all eight requested Shopify quantity states and operational product facts, project only exact product mappings into Shopify-authoritative Operations balances, and perform no provider write, order mutation, shipment creation, or fulfillment export;
- a manager-triggered, development-only Shopify cartonization preview that requires the exact current order-candidate revision, one active warehouse, account-bound inventory evidence captured from Shopify within 24 hours, exact product mappings and package measurements, explicit per-line committed-quantity assumptions, and one to eight active, priced, positively stocked packaging materials; inventory-run completion remains separate evidence and cannot make a replayed stale provider capture fresh; it calls only the authenticated OR-Tools service, uses fixed-axis conservative fit, excludes transport and handling costs, and returns a point-in-time in-memory fit/material recommendation with explicit zero database, provider, rate, label, and shipment writes; product-level committed attribution is displayed once and remains ineligible while more than one current inventory position exists; each optimizer package is surfaced as one planned shipment, but the preview cannot accept or persist that split, allocate durable package contents, or generate the future shipment-partitioned packing documents; Faire remains blocked until account-bound inventory reconciliation exists;
- a canonical **Operations > Commerce imports** submodule at `#operations/imports`, also available from the collapsed-navigation flyout, that selects a configured and verified active-workspace Shopify/Faire account and opens the same Overview/Products/Orders/Issues workbench as the compact Settings launcher; product decision CSV is account/candidate/row-version fenced, while order and issue exports are sanitized and no CSV order import or provider-write path exists;
- an idempotent **Plan order** command for one promoted `imported` commerce order and one sealed `operational` cartonization/rate evidence aggregate. It rechecks the exact order revision, promoted candidate/source hash, active warehouse, current packaging-material/recipe/profile revisions, complete line-to-package quantity conservation, and eligible inventory authority before creating one `planned` fulfillment plan, its allocations, exact physical packages and package contents, and all evidenced carrier offers. Shadow may accept explicitly identified sandbox carrier-read estimates for development evidence; Active fails closed unless the sealed aggregate identifies production carrier reads. One selected UPS or FedEx service must cover the complete ordered package array in the order currency; package-level service splitting is prohibited. When a requested-delivery timestamp exists, only promise-feasible offers compete, then lowest carrier cost, fewest transit days, and stable provider/service identifiers decide. Shopify-authoritative positions remain bound to one exact latest-sync inventory level and produce one `provider_commitment` claim bounded by the projected provider-committed quantity without a second balance or ledger delta. ClawPilot-authoritative inventory may satisfy one line from multiple eligible positions: planning locks candidates in location pick-sequence and permanent-position-Global-ID order, takes only the remaining whole-unit quantity from each, and creates one local reservation, ledger delta, and fulfillment allocation per selected position whose quantities sum exactly to the line. Planning also locks warehouse packaging stock, subtracts existing active claims, and writes one durable active plan/material claim for the exact carton or mailer count without decrementing physical on-hand; later execution must consume or release that terminal lifecycle exactly once. The immutable checkout shipping charge and its signed variance from the selected carrier estimate remain separate; neither is carrier-billed actual or MUD. Planning creates no label, postage purchase, shipment, packing slip, tracking fact, commerce fulfillment export, inventory-provider write, or other provider effect;
- a separate migration `0179` Active multi-package execution foundation derived from one exact immutable `0177` Shadow preparation. Preparing it requires the current organization-scoped Operations `active` revision and retains one single-warehouse shipment group, the exact Shadow package set, and one inherited Shadow planning estimate across every package. A whole-shipment carrier attempt is persisted before dispatch; under the current `0183` through `0187` safety layer, only a failed attempt carrying retryable persisted diagnostic proof of noncreation may create a new consecutive attempt with a new idempotency identity, while prepared, succeeded, or unknown outcomes block another dispatch and an unknown outcome requires reconciliation. Success requires exactly one production label and shipment lineage for every prepared package. Database triggers reject production labels or shipments outside Operations Active and reject lineage that does not match the durable group attempt. This foundation adds no command route, worker, provider adapter call, automatic activation, packing-slip generation, inventory consumption, commerce fulfillment export, or channel write-back; those remain later executable slices and cannot be inferred from migration acceptance alone;
- migration `0180` preserves that Shadow planning estimate as immutable comparison evidence and adds a distinct production execution-time rerate aggregate. Its append-only run and ordered package rows bind the exact Active execution/package set; every provider request is a separately immutable `prepared` production attempt, every succeeded, failed, or unknown outcome is a terminal result row, succeeded results own immutable normalized whole-shipment service offers, and exactly one unexpired offer selection may authorize dispatch. `operations_active_carrier_group_attempts.production_rerate_selection_id` is mandatory and database triggers require its provider, service, activation revision, and package set to match the authoritative selection. A production selection may differ in service and amount from the retained Shadow estimate without rewriting that estimate. The migration remains an evidence and authority boundary only: no HTTP or token client, network worker, shipment-label dispatch/finalization, package tracking, packing-slip generation, inventory consumption, commerce fulfillment, or Shopify/Faire writeback is implemented by it;
- migrations `0183` through `0187` and the Active dispatch persistence service add a redaction-gated durable prepare/replay boundary plus safe failed and unknown finalization. Shipment-group locking gives one caller dispatch ownership; exact replay returns the same attempt without ownership. Retry requires a failed terminal diagnostic that explicitly proves `retryable: true`, `shipmentOutcome: 'not_created'`, and either no provider reach or a received provider-rejected response; ambiguous or unsafe evidence becomes constant-safe unknown and remains reconciliation-only. Dispatch/completion and retry chronology are database-clock bounded, including a maximum five-second terminal skew. Migration `0183` installs four new-write constraints without scanning populated tables, and migrations `0184` through `0187` validate the group-attempt, package-result, label-attempt, and label tables independently. There is no command/public route or provider call in this slice, and succeeded finalization remains deliberately unavailable until package-level labels, shipments, tracking, inventory, packing artifacts, and commerce-export intent can commit as one complete result;
- production execution-evidence prerequisites, the narrow read-only rerate command, and manual local service selection: `carrierWholeShipmentRateFoundation.ts` deterministically prepares bounded UPS/FedEx whole-shipment rate requests for explicitly selected sandbox or production endpoints and parses recorded responses without network I/O, while `activeCarrierDispatchSnapshot.ts` validates and deep-freezes one production dispatch snapshot binding the exact organization, order, plan, warehouse, Active carrier attempt, integration/carrier account, credential revision and fingerprints, billing relationship, origin, destination, successful production fulfillment-rerate selection, single service, and ordered package set, and derives its provider idempotency identity. Recorded fixtures and contract tests prove those pure request/response and snapshot invariants only. Separately, `carrierWholeShipmentRateClient.ts` performs one bounded, read-only production UPS/FedEx token exchange and whole-shipment rate request; `productionFulfillmentRerateExecution.ts` and the authenticated Operations `execute-production-rerate` command require Operations Active at the current activation revision, resolve the exact active integration/carrier account and verified credential generation/fingerprint, bind the ordered package set plus origin, destination, and billing relationship, and commit the immutable prepared attempt before token/rate I/O. Replaying that prepared attempt is reconciliation-required and never repeats the provider call; each synchronous executor outcome is persisted separately as succeeded or failed evidence. The authenticated `select-production-rerate-offer` command then lets an authorized manager select one exact unexpired succeeded offer with a reason. That immutable local selection is one service for the complete ordered package set and is the only dispatch authority; it performs no network request or provider mutation. This executable slice does not auto-select a service or perform a carrier shipment/label/void call, finalization, tracking ingestion, packing-slip generation, inventory consumption, commerce-fulfillment export, channel write-back, or any provider write. Migration `0179` therefore remains non-executable as a carrier-create/label-dispatch path despite the read-only rerate and local selection commands;
- a canonical **Operations > Pack & rate replay** submodule at `#operations/replays` that lets a manager execute and reload sanitized historical scenarios across checkout quote, post-intake CRM resolution, fulfillment rerun, checkout-to-pre-label estimated variance, recorded label finalization, and tracking-gated package documents. It retains immutable checkout and fulfillment runs, exact line-to-package quantity conservation, all bounded recorded UPS/FedEx whole-shipment choices, one selected service for the complete package set, the unchanged checkout shipping charge, the separate checkout and pre-label carrier estimates, their signed estimated variances, and zero provider, postage, label, inventory, order, or commerce writes. It never calls an estimated replay delta a MUD and cannot establish carrier-billed actual cost. A successful fulfillment run may remain pre-label; finalized replay packages use recorded tracking facts and create one real immutable, downloadable PDF packing-slip artifact whose bytes and render snapshot are database-bound to that package's exact allocation. Shopify scenarios replay a recorded callback fixture without making a live callback, while Faire scenarios begin from a captured marketplace checkout shipping estimate and never claim that Faire called ClawPilot;
- a reusable progressive-disclosure setup journey across Commerce, carrier, Google Workspace, QuickBooks, Toast, and Maton Settings panels, with provider-specific ordered steps and copyable nonsecret operational facts derived only from each panel's existing organization-scoped state;
- a Faire External API v2 brand client for the fixed production origin, brand/product/order and selector-based inventory reads plus documented processing/cancellation/availability/shipment request translations; Faire is explicitly recorded as production-only and polling-only, with no public webhook, sandbox, retailer custom API, or return-write claim;
- responsive Orders and Exceptions views with permanent `gor` and `gex` identities, plus stable hash-addressed, horizontally scrollable Orders, Exceptions, Commerce imports, Receiving, Warehouses, Packaging materials, Carrier invoicing, Shipment pricing & GL, and Printing subpanel navigation with touch panning and accessible edge scroll controls on narrow screens; the expanded left-navigation Operations submenu and collapsed flyout expose that same complete submodule set without changing existing permission boundaries. Packaging materials owns organization-scoped cartons, poly mailers, padded mailers, dimensions, tare and maximum weights, unit cost, draft/active state, and per-existing-warehouse availability/on-hand/reorder facts. Its six-item starter assortment is draft-only and cannot become optimizer-eligible until real costs and positive available stock are recorded. Carrier invoicing owns immutable source-file evidence; carrier-billed actual exists only after its charges are exactly matched and the GL review is approved. Shipment pricing & GL owns shipment-to-shipper assignment, the separate checkout-charge and carrier-estimate comparisons, approved billing-time MUD calculations, variance and settlement review, and GL outputs; shipper-assignment rules do not replace or mutate an independently versioned MUD directive;
- incomplete customer-supplied packaging-material drafts that retain only the supplied dimensions, explicit inner/outer/unconfirmed basis, evidence type/reference, and source while leaving unknown depth, tare, maximum weight, cost, currency, and stock null; activation fails closed until verified usable inner dimensions and every operating fact are present. A separate trusted-development, plan-first AG Alchemy command stages the four customer-supplied material drafts and six explicit provider sell-unit pack classes only after an administrator supplies exact `gp` Product Global IDs and an explicit active owner/admin actor. It verifies the Railway environment name and database identity, binds apply to the exact fresh plan fingerprint, and projects every assigned Product's current exact channel state to the class's default pack version. Migration `0191` binds each current mapping to a database-derived physical pack fingerprint over the exact account/provider/product/variant/inventory-item identities, normalized lifecycle, provider-active state, requires-shipping state, and weight. Quantity, provider timestamps, media, merchandising copy, price, taxonomy, SKU, and barcode remain full catalog audit evidence but do not invalidate unchanged pack readiness. Any included physical fact change fails closed and requires a retired mapping plus an administrator-saved replacement; legacy mappings whose retained full evidence did not exactly match at migration time are staled rather than silently certified. `npm run test:product-pack-management` is the deterministic migration and runtime contract gate for this fingerprint boundary; it does not claim a live-Postgres migration smoke. Its title/SKU suggestions are discovery aids only. Guarded apply may replace the six exact untouched or legacy-equivalent synthetic starter drafts and their empty stock placeholders, but fails on partial, active, edited, referenced, or otherwise conflicting starter state. It never activates a material, profile, relationship, or recipe or infers intact-case inventory;
- audited exception transitions for acknowledge, resolve, dismiss, and reopen, with tenant isolation and retained resolution history;
- an in-module guide that directs carrier sandbox testing to **Settings > Integrations > Shipping** and identifies deterministic mocks as automated-test-only;
- disposable PostgreSQL acceptance coverage that applies the full migration chain and validates atomic writes, replay, rollback, append-only evidence, money totals, and cross-workspace isolation.

Production domain activation remains out of scope until later delivery gates verify provider credentials, processed webhook and polling imports, canonical mappings, provider attempts, reconciliation/replay, complete operational health, recovery commands, and an explicitly approved integration and warehouse cohort. Enabling Shopify signed receipt intake still accepts only its enumerated receipt topics; order and customer webhook topics remain rejected until their retention/privacy lifecycle and canonical processor exist. The separately gated held-order preview can inspect minimized recent order facts while the `sandbox` account remains receipt-disabled, but it does not import an order, create or change a customer, product, or mapping, reserve or export inventory, export a fulfillment, register webhooks, advance a cursor, or authorize any provider write. A verified product-readable Shopify or Faire connection authorizes the distinct development-only catalog worker without a second user approval and initializes its policy as resumed in an eligible runtime. A verified order-readable connection separately authorizes the development-only current-order intake worker when Operations is `shadow` or `active`; that worker follows bounded encrypted pages and creates held candidates or rejections. Catalog policy initialization does not prove queueing, and neither worker is production enabled. The catalog worker may create ClawPilot product masters and exact mappings but never reads or changes orders or inventory and never writes to the provider. The order worker may match or create an exact CRM customer through the guarded automatic-resolution boundary. It may also promote one newly observed, fresh Faire candidate into a local canonical order only after exact product/SKU and pack mapping, whole quantity, customer, address, delivery, and open/unfulfilled state checks pass. Existing candidates and every ambiguous or failed record remain held; the worker never creates products, reservations, packages, shipments, inventory changes, fulfillment work, or provider writes. Its completion response and immutable system audit evidence count customer matches and creations plus Faire promotions, holds, failures, stable failure categories, and the total requiring administrator review without storing protected party data in those counters. Interactive commerce intake may separately promote a manager-reviewed ready order; promotion itself does not alter provider inventory or deduct order demand from a separately reconciled Shopify-authoritative balance. An authorized operator may then accept separately sealed operational evidence into the one-warehouse `planned` state under migration `0176`; that local command remains provider-write-free and does not prove downstream release, picking, rerating, labeling, shipment, packing-slip, tracking, or fulfillment-export execution for the provider-backed plan. The automatic Shopify inventory worker and manager recovery command share the same read-only development reconciliation boundary; neither is production inventory synchronization. Sandbox rating and label evidence do not authorize production rating, label creation, pickup scheduling, shipment confirmation, or inventory consumption. `app_documents` is not used as a substitute for logistics artifacts.

### Product And Package Catalog Workflow

The shared catalog is managed from **Pipeline > Configure > Products** because CRM products remain the product authority for both sales and operations. An authorized editor may add or update one product at a time or import a CSV containing at most 500 rows and 1 MB. The product template includes name, SKU, type, category, status, price, cost, currency, URL, description, active state, package name, package type, unit of measure, units per package, measurement system, length, width, height, weight, and package active state. A new blank Product or truly currency-less CSV row receives the active organization's currency default. When SKU or name matches an existing Product, its record currency wins over that default; an explicit row currency is the only way to change it. Metric entry uses centimeters and kilograms; imperial entry uses inches and pounds. The service converts both to canonical millimeters and grams for cartonization and carrier adapters while retaining the team's preferred entry system.

An import updates an existing product when its SKU matches case-insensitively or, when no SKU resolves it, its name matches case-insensitively. A product name and SKU cannot identify different existing records. Every invalid row is reported without discarding valid rows, and spreadsheet-formula-prefixed text is rejected. Package length, width, height, and weight must be supplied together. Team edits reuse the same product and default package Global IDs, increment the package row version, and append audit evidence instead of creating duplicate catalog records.

The current vertical slice intentionally maintains one editable default package profile per product. The schema leaves room for multiple named profiles and facility-specific packaging in a later cartonization slice, but the application must not imply that those choices are available yet.

Migration `0128` and `scripts/stage-ag-alchemy-pack-hierarchy.mjs` add a
separate evidence-staging boundary behind that existing product editor. The AG
command can stage customer-confirmed `each`, `inner_pack`, and `case` versions,
their exact contains relationships, and approved-but-nonactive recipes for
loose carton packing:

- loose 6 oz bag listings as recipe-only eaches, with an `AG12V2`
  customer-confirmed range of 12 through 18 and a customer-named 20 lb box
  maximum of 30 whose minimum remains unknown and therefore unusable until
  confirmed;
- explicit prepackaged 6 oz case-of-12 listings as a separate default sell
  unit in `AG12V2`, represented by its contains relationship and never by an
  assembly recipe;
- loose 2 oz bag listings as eaches with a prepackaged case-of-36 relationship
  in `AG12V2`, without an assembly recipe;
- explicit prepackaged 2 oz display-carton listings as a separate default sell
  unit containing 6 bags, plus an assembly-allowed outer shipping box holding
  up to 6 complete display cartons;
- one 10 lb bulk unit in `AG12V2`; and
- one 20 lb bulk unit in the customer-named 20 lb box.

The command does not apply a classification from title or SKU. It prioritizes
explicit `2 oz Carton` and `6 oz 12pk` discovery suggestions so those listings
cannot inherit loose-bag dimensions, but apply still requires an explicit,
nonduplicated `gp` assignment. The assignment is not accepted as evidence by
itself: each current Shopify/Faire variant must be mapped to the class's
explicit default sell-unit profile using its durable source revision/hash.
Net-content names such as `10 lb` and `20 lb` are not treated as gross shipping
weights.

Migration `0134` connects an exact current Shopify or Faire variant-pack
mapping to new order candidates without activating the staged Product profile
or any incomplete packaging material. Automatic resolution accepts only a
current `customer_confirmed` or `active` pack version with complete **outer**
dimensions and measured, customer-confirmed, or provider evidence. The mapping
and current channel-state source revision and hash must still match, and a
provider-supplied pack multiplier must equal the mapped base-each quantity.
Candidate lines retain mapping/profile-version Global IDs, row-version fences,
package level, base-each quantity, and the explicit weight source.

Gross shipping weight is never inferred from Product names or nominal content.
Resolution uses an explicit pack-version gross weight first, an exact
provider-order package weight second, or the matching current provider-catalog
weight third. If weight is absent, pack quantities conflict, or provider
dimensions conflict with the customer-confirmed pack, the otherwise eligible
association remains review evidence but the line stays blocked for package
resolution. Changed or ineligible source evidence is not associated.
An active pack profile may also retain a `derived` gross weight when the
operator cites every evidenced component weight, the exact quantity, and the
auditable calculation. The management surface stores that basis as
`derived`/`manual`; it does not relabel the result as measured,
customer-confirmed, or provider-supplied. For example, an exact development
pack of thirty variants whose retained provider weight is 170 g may record
`30 × 170 g = 5,100 g` as the content gross weight while the selected shipping
material retains its own separate tare. A nominal `6 oz` Product title alone
can never support that calculation.
One narrow recipe-first exception prevents false product measurements: a
current customer-confirmed provider sell-unit profile marked
`approved_recipe_only` may intentionally omit item dimensions while retaining
its exact variant-pack association and current provider-catalog weight. The
candidate remains unresolved for ordinary package promotion and geometric
preview. The hybrid planner may consume that association only when a current
customer-confirmed recipe for the exact captured input-profile revision
supplies the outbound material and package geometry. This is the supported
model for 10 lb and 20 lb bulk sell units; ClawPilot does not copy the
shipping-carton dimensions onto the unmeasured inner product.
Promotion revalidates every mapping, version, source, dimension,
weight, and active Product mapping under row locks; a stale fact requires a
fresh order intake. Manual or compatibility-profile resolution clears mapped
pack provenance. The optimizer input schema remains unchanged: cartonization
consumes the ordinary resolved candidate-line dimension and weight snapshot.
For an association-only recipe input, the same repeatable read instead retains
the exact mapping/profile revisions and matching channel source revision/hash,
uses that source-bound catalog weight, and obtains outbound geometry only from
the current recipe and selected material. Draft materials still fail closed
until verified inner dimensions, tare, capacity, cost/currency, and positive
warehouse stock make them active outside the explicit sandbox evidence path.

Migration `0135` makes recipe-driven cartonization explicit. A max-capacity
recipe records a nullable customer-approved minimum, a normalized content
compatibility key, and whether fit evidence permits compatible Products to
share one outbound material. Mixed pooling requires a max-capacity recipe,
nonexclusive contents, the exact same compatibility key, and timestamped
customer-confirmed or measured fit evidence. An active max-capacity recipe
cannot retain an unknown minimum. A profile marked `approved_recipe_only`
requires timestamped referenced evidence and can never silently fall back to
geometric fitting.

The pure hybrid planner runs the approved-recipe phase before exposing
remaining `rigid_3d` or `compressible` lines to the geometric optimizer. Every
Product in a mixed pool must expose the same material, capacity, applied
minimum, compatibility key, and current row-version evidence. Stale profiles,
recipes, or materials block; missing recipe evidence blocks recipe-only
flexible items. The AG loose 6 oz recipes share
`ag-alchemy.loose-six-ounce-bags.v1` and may pool flavors, but `AG12V2` retains
the customer-confirmed 12-unit minimum. A smaller order such as six bags is
only an assumption-backed **read-only sandbox** option when the caller supplies
an explicit minimum override with a reason and evidence reference. Production
planning rejects all such overrides, and the 20 lb box remains blocked until
its currently unknown minimum is confirmed.
That unknown loose-pick minimum does not authorize a one-through-thirty
capacity rule. A bounded Shadow checkout demonstration may instead use an
exact thirty-unit pack rule because the customer explicitly confirmed that
thirty 6 oz bags fit the named 17 × 11 × 7 carton. Quantities other than that
exact pack remain blocked until the customer confirms the loose-pick minimum.
Any development material used for that proof must remain separately named and
must identify assumed tare, cost, stock, and nominal inner/outer reuse rather
than altering the customer draft.

Hybrid output includes policy and algorithm versions, canonical input/result
hashes, stable package keys and sequence, exact material/profile/recipe row
versions, customer material dimensions and evidence, recipe minimum/maximum,
line/Product/title/quantity allocations, and content weight. Rating readiness
is separate: missing rated outer dimensions or tare weight is returned as a
package-level blocker rather than invented from inner dimensions. This pure
planner performs no database, provider, inventory, shipment, rate, label, or
packing-list write.

Migration `0151` adds a product-level management surface for versioned each
and case profiles, exact provider-variant mapping purposes, and active
approved recipes. Checkout context resolves only a current mapping whose
purpose is explicitly `shopify_checkout`; a separate current `catalog`
mapping for the same variant cannot satisfy or duplicate the checkout join.
That checkout mapping follows the same registered-ready CarrierService
predicate as the public callback: a verified Shopify account is generic-status
`active` while its independent signed-receipt policy may remain held, and an
`error` account remains ineligible. Channel lifecycle, exact source revision/hash,
pack-version weight, recipe or self-package, configuration, warehouse,
material stock, carrier, credential-generation, and Shadow-revision fences
remain mandatory.
Migration `0162` corrects the original `0151` trigger and command fence to
enforce that same `active`-or-`disabled` account rule. It changes no signed
receipt setting and grants no provider write; verified credentials and every
other exact checkout predicate still fail closed.
Migration `0163` removes the broad Shopify parent-Product mapping trigger that
incorrectly rejected a catalog refresh when sibling ProductVariants mapped to
different sellable ClawPilot Products. Purpose-specific Product-image prepare,
grant, claim, and effect guards retain the parent-level ambiguity fence. The
migration narrowly requeues recent dead Shopify catalog jobs that carry the
retired trigger's `P0001` result and exhibit that exact sibling-variant
condition, while retaining the prior terminal error in the job summary.
Migration `0164` corrects checkout-offer finalization by comparing receipt
packages to the exact sanitized parcel shape retained by the carrier request:
description, flattened exterior inches, gross pounds, and explicit units.
Internal package keys remain typed receipt evidence and are never sent to UPS
or FedEx. Approved-recipe cartons and self-packaged cases retain their
distinct descriptions. Every other offer predicate remains exact: configured
carrier and account, successful request identity and hash, current credential,
destination, package count and ordered parcel array, service code and name,
amount, currency, response-rate hash, and stable Shopify service code. The
repair does not trust diagnostic result JSON, loosen quote-to-order
reconciliation, broaden the Shadow customer/Product gate, or activate a
production checkout path.
Migration `0165` makes the provider-verified Shopify store entity name the
default identity input to the same canonical CarrierService readiness
predicate used by setup, registration, checkout mapping, and the public
callback. A missing, blank, oversized, or control-character entity fails
closed. Neither the Shopify platform label, editable connection label, nor
external identifier can substitute for Shopify's read-only `shop.name`
result. The provider probe applies the same NFKC and whitespace normalization
before persistence and the 255-code-unit bound that callback branding applies
before responding. Migration `0166` then requires a registered configuration
to retain provider-confirmed `registered_service_name` evidence equal to the
current desired name, whether that desired name comes from refreshed
`shop.name` or an audited owner/administrator override.
An exact-case recipe and a loose-each max-capacity recipe are independent
evidence. For the 6 oz test path, an operator may retain exact 12 as the case
path and separately activate a customer-confirmed 1-through-12 loose-pick
range. The planner deterministically uses exact case for a complete 12, uses
the loose-each rule for 1, and splits 13 into exact 12 plus loose 1, without
geometric fallback. The UI never derives that lower minimum from case-only
evidence: production eligibility requires a separate evidence reference
confirming the complete loose-each range. Existing AG recipes whose confirmed
minimum is 12 remain unchanged until that explicit evidence is supplied.

An active case profile with `baseEachQuantity > 1` and
`shipsAsOwnPackage = true` is already a sealed carrier parcel and therefore
does not require or synthesize an assembly recipe. Its exact current profile
revision supplies the rated outer dimensions and gross weight. Checkout
quantity 1 creates one parcel; quantity 2 creates two parcels, each allocated
to exactly one provider sell unit. Receipt persistence keeps this
`self_package` evidence separate from `approved_recipe` cartons, while loose
eaches continue to require an approved recipe and selected material stock.

Migration `0136` adds a distinct `cartonization_package_rate` purpose to the
existing UPS and FedEx sandbox adapters. The caller supplies the exact planned
parcel exterior and gross weight; omitting that parcel preserves the separate
fixed diagnostic rate test. A cartonization quote cannot enter the diagnostic
label-create workflow.

Migration `0137` seals a reloadable `gcte` evidence aggregate after every
planned package has exactly one immutable UPS and one immutable FedEx `grq`
edge. One repeatable-read transaction binds the exact organization, commerce
account and candidate revision, active warehouse, latest successful
account-plus-warehouse inventory run, current variant mapping and pack-profile
row, selected material row, and every matching current recipe. Each shipping
line retains an explicit committed-inventory quantity, including zero; the
assumed total may not exceed provider-committed evidence, and demand may not
exceed operational availability plus that retained attribution.

The development sandbox proof may use current customer-confirmed profiles and
recipes plus a draft customer-supplied material. Rated exterior dimensions,
tare, and any below-minimum recipe quantity require an explicit operator
acknowledgement and are stored only in the evidence aggregate. The UI
watermarks that aggregate as **assumption-backed sandbox evidence, not
executable or actual billed cost** and exposes a direct reload link under
**Operations > Commerce imports**. It never activates or mutates Product,
material, recipe, inventory, order, shipment, label, print, or provider
records; only append-only ClawPilot evidence and carrier-rate request rows are
written.

For `sandbox_demo` only, mapped `negative_available` inventory evidence may
retain its exact provider-committed quantity while operational ATP remains
zero. The operator must still attribute that committed quantity explicitly per
line, and the assumption cannot exceed provider evidence. Production remains
fail closed to `projected` inventory evidence only. This exception never turns
negative availability into ATP and performs no inventory or provider write.

Migration `0138` closes three evidence-integrity gaps. Every planned package
now retains immutable child rows for all contributing approved recipes,
Products, and input-profile revisions, including mixed-product cartons. The
header stores the confirmed destination fingerprint, each package stores the
exact normalized carrier parcel, and each quote stores the linked carrier
request hash plus a package-rate-context hash. A deferred database check
requires the linked `grq` destination and parcel to match that saved package
proof exactly. A durable semantic command reservation is claimed before either
carrier read: a completed retry reloads the sealed `gcte`, a concurrent retry
remains pending, and neither path creates additional carrier request rows.

Migration `0139` keeps fully fulfilled provider lines as source evidence
without falsely requiring an operator-selected order-time price. The database
continues to require `line_price_required` whenever an unresolved-price line
has positive unfulfilled demand; zero-remaining lines remain excluded from
operational readiness and canonical fulfillment work.

Migration `0140` removes PostgreSQL's truncated legacy four-value
`packaging_source` check left behind by migration `0134`, then re-establishes
the named five-value constraint that admits exact `variant_pack_mapping`
evidence. Hosted migration health now requires both this repair and the
fulfilled-line price-state repair before reporting current schema.

Migration `0141` makes the recipe-only association state
database-authoritative. Exact `variant_pack_mapping` evidence may remain
`unresolved` only with the complete mapping/profile association, null item
dimensions and weight, and the ordinary `packaging_required` blocker still
present. Resolved mapped packages continue to require an explicit weight
source. The runtime admits the unresolved form only for a current
source-bound `approved_recipe_only` profile whose dimensions are all absent;
the sandbox hybrid reader retains its mapping/profile row versions and channel
source revision/hash, derives unit weight only from that positive current
catalog observation, and still requires the saved recipe/material proof before
it can rate a parcel.

The AG staging command has one guarded compatibility repair for bulk profiles
created before the recipe-only rule was introduced. A fresh plan may supersede
only an untouched version-1, row-version-0, customer-confirmed
`rigid_3d` profile whose dimensions and weights are all absent and whose other
facts exactly match the customer-supplied bulk manifest. Apply creates a
version-2 `approved_recipe_only` profile, retires and recreates the affected
relationship and recipe against that version, and versions the exact provider
variant mapping while retaining the current channel source revision and hash.
The old rows remain as history. Any extra version, changed fact, stale channel
evidence, or concurrent row-version change blocks the repair. The command
remains restricted to the trusted development database, exact Product Global
ID assignment, active AG administrator, and fresh plan fingerprint; it performs
zero provider, inventory, order, package, shipment, or carrier writes.

Confirmed US ship-to snapshots may retain a provider-native state or territory
name for audit display. The carrier sandbox boundary converts recognized names
such as `Wisconsin` to the canonical postal code (`WI`) before fingerprinting
and rating. An unknown subdivision now fails with
`CARTONIZATION_RATE_DESTINATION_INVALID` instead of being reported as a
generic evidence outage.

Operators may select at most eight packaging material types for one
cartonization run, while one saved read-only carrier comparison may retain up
to 50 resulting physical packages. This distinction lets a high-unit order
reuse a small controlled material catalog without truncating its actual carton
plan while remaining inside the UPS `Shop` one-request package limit shared by
the UPS/FedEx comparison boundary.

Every selected material in that comparison carries its own explicitly
acknowledged rated exterior dimensions and sandbox-only tare. Those assumptions
are normalized, bound to the exact material Global ID and row version, retained
in the semantic request hash, and rechecked against every resulting package
before evidence can seal. Cartonization completes first. ClawPilot then sends
the complete ordered physical-package list in exactly one UPS multi-package
shipment-rate request and one FedEx multi-piece shipment-rate request. A
shipment-level option is eligible only when that carrier returned the service
for the entire package list; one carrier service applies to every package in
the shipment and package-by-package service splitting is not allowed. The
optimizer counts one shipment per selected ship-from warehouse, while
`cartonCount` remains the number of physical packages; AG Alchemy's one
warehouse therefore produces one potentially multi-package shipment. A future
multi-warehouse plan must partition packages by ship-from warehouse before
rating, because each warehouse has a different sender address; ClawPilot then
sends one shipment-level request per warehouse group to each carrier and never
combines origins in one request. Each
physical package retains its own allocation, recipe, normalized parcel, and
edge to the shared immutable provider request so an administrator can audit the
two carrier reads without mistaking package evidence for separate rate choices.
The workflow is read-only at both providers and performs no shipment, label,
postage, inventory, or sales-channel write.
Migration `0144` removes the legacy inline single-package quote-purpose check
left by migration `0137`; the purpose-aware shipment/package constraint from
`0143` remains authoritative, so whole-shipment quote edges can seal without
weakening legacy evidence validation.

Migration `0145` adds the append-only development replay boundary rather than
activating a live checkout or fulfillment path. Checkout quotes remain
customer-neutral and expiring. A Shopify replay executes the current
`planHybridCartonization` policy at checkout and again at fulfillment; the
two executions are independent immutable runs and are not required to produce
the same package count, materials, or line allocation. Checkout rates the
cart's current physical plan; fulfillment re-cartonizes the then-current
warehouse facts and records every package, allocation, carrier-cost, and
service variance from the checkout predecessor without rewriting it. The
bounded approved-recipe fixtures fail closed if the current optimizer no
longer produces their run-specific exact package oracle. Faire has no ClawPilot
checkout callback: its first stage retains only the captured marketplace
customer estimate, with zero ClawPilot packages or UPS/FedEx choices, and the
first ClawPilot cartonization and carrier comparison occurs after order intake. CRM
resolution occurs only after that customer-neutral intake boundary; one
created or reused CRM organization is required before a successful fulfillment
rerun, while an ambiguous match persists as an expected blocker with no
invented downstream package, rate, label, or document facts. Each successful
pack-and-rate run binds the optimizer policy, algorithm, input/result hashes,
exact package-plan hash, exact bounded rate-choice count, UPS and FedEx
recorded responses, and exactly one selected whole-shipment service.
Fulfillment references its exact checkout predecessor and records
database-derived allocation, material, service, and carrier-cost variance
causes without overwriting the quote. Recorded label finalization is a later,
optional stage; a final packing slip cannot exist until that exact package has
unique tracking, the selected carrier/service, a unique recorded label
reference, and a content-addressed PDF payload. This replay does not establish
Shopify quote-to-canonical-order reconciliation, a production checkout
callback, live carrier pricing, label purchase, or a Faire checkout callback.
Those remain separate activation gates.

Migration `0146` is an additive correction to that development replay
boundary. Existing version-1 rows remain immutable legacy fixture evidence.
New version-2 rows preserve the checkout shipping charge through fulfillment,
record the checkout carrier estimate and pre-label carrier estimate as
different facts, and store their signed differences only as **estimated
variance**. Version-2 replay rows require `mud_markup_minor` to remain null:
neither estimate is a carrier invoice, realized margin, or a MUD calculation.

Migration `0147` adds the separate append-only carrier-billing MUD boundary.
Carrier-billed actual exists only after an imported CSV statement and all
included charges are retained, exactly and currently matched to one shipment,
assigned to the exact shipper, and included in an approved GL Coding review.
Only then may ClawPilot calculate MUD from an approved, effective,
currency-matched, current directive whose calculation basis is `actual_cost`.
For this slice, current means the terminal applicable version as of the
shipment timestamp, not the newest version created later. Exactly one direct
grant to the assigned shipper may contribute applicable actual-cost
directives; grants without such a directive do not create ambiguity, while
multiple eligible direct grants fail closed as `blocked`.
The calculation retains the statement lineage, exact charge set, quote,
account authorization, grant, contract and directive versions, calculation
snapshot, input hash, and actor. When no such directive applies, the durable
result is `not_configured`, not zero and not an inferred replay markup.
Ambiguous or invalid evidence remains `blocked`. A checkout shipping charge is
classified as customer-paid only when complete paid canonical commerce
evidence can allocate it to exactly one nonvoid shipment; otherwise its
unavailable, not-captured, or multi-shipment state remains explicit.

Migration `0149` adds the customer-neutral Shopify CarrierService callback
evidence and an exact quote-to-order reconciliation boundary. Each successful
receipt snapshots its account, configuration and activation revisions,
destination HMAC, aggregated provider-variant quantity fingerprint, currency,
inventory evidence, package plan, reconciliation window and immutable
deadline. Each returned Shopify service is tied by typed foreign keys to the
configured carrier account and the successful whole-shipment rate request.
When the source selected a ClawPilot CarrierService code, Shopify promotion
invokes reconciliation inside the same PostgreSQL transaction that creates
the canonical order. It compares only immutable typed facts: the same commerce
account, provider order creation time inside the stored receipt window, exact
shippable variant quantities, destination fingerprint, currency,
provider-selected Shopify service code and customer-paid shipping charge.
Exactly one match links the canonical order to the receipt and selected offer.
Zero matches persist a rejected or expired decision; multiple matches persist
an ambiguous decision; none fabricates a receipt link. That order cannot be
released to warehouse work unless the decision is `matched`. Another Shopify
shipping method is explicitly `not_applicable` and is not subject to this
ClawPilot quote-lineage release guard. Shopify may reuse one cached
CarrierService response for more than one checkout with the same typed request
facts, so one immutable receipt may support multiple orders; it is not
consumed by the first promotion. Each order must still have exactly one
matching receipt, and multiple receipts for that order remain ambiguous.
PostgreSQL recomputes the candidate count and candidate-set hash, so
application JSON or a caller-supplied count cannot forge a match. Merchandise
unit price and subtotal are intentionally absent from this matcher: a
zero-priced shippable product still receives the carrier shipping quote
derived from its physical fulfillment facts. A previously promoted Shopify
order with missing ClawPilot lineage exposes the request-hash-aware,
command-receipted **Match checkout quote** action. A pre-`0157` rejected or
expired decision may gain one database-verified append-only matched successor
under the cached-receipt rule; its original evidence remains unchanged.
Otherwise an existing non-matched immutable decision remains
warehouse-ineligible.

The development callback has a sandbox-only checkout execution boundary:
the Shopify account and the exact configured UPS and FedEx carrier accounts
must all be sandbox identities before setup can become ready, registration can
be finalized, or a callback can rate. Production registration and checkout
rating remain unsupported; an exact production CarrierService delete remains
available only for removal and reconciliation. Receipt reuse is fenced by the
current packaging-material and packaging-stock revisions and quantities plus
the current carrier-credential generations, in addition to configuration,
activation, policy, request, and inventory evidence. A cached Shopify response
is rebuilt one-to-one from immutable typed package and offer rows after those
facts are revalidated. The rebuild must exactly match the receipt's
hash-bound customer-neutral response before those stored response facts can be
replayed;
unverified or arbitrary result JSON is never response authority.
The checkout orchestrator retains each internal package key for allocation and
receipt lineage, but strips that ClawPilot-only identifier before invoking the
strict UPS and FedEx shipment-rate adapters. Both carriers receive the same
ordered array containing only description, exterior dimensions, and gross
weight; an internal planning field must never cause an otherwise ready quote
to fail provider validation.
FedEx may return more than one commitment row for the same service code. When
those duplicates use the same currency, the sandbox adapter deterministically
retains the lowest exact account charge, then delivery date, transit time,
service name, and rate type as tie breakers so Shopify receives one stable
service code. A same-service cross-currency conflict is not coerced and still
fails closed at the checkout response boundary.
Carrier rate evidence keeps its optional `actor_email` foreign key only when
the actor resolves to a real ClawPilot user. Automated Shopify callbacks retain
`actor_email = NULL` while the audit event records the explicit
`system:shopify-carrier-service` actor. A system callback must not lose an
otherwise valid UPS or FedEx result merely because it has no app-user row.
The callback cuts all configured carrier network work off at 6.5 seconds,
then permits at most 750 milliseconds for any aborted provider to persist its
sanitized failure evidence. Successful receipt persistence must begin before 8.25
seconds, and the callback returns or fails closed by 9.25 seconds. These
explicit evidence, persistence, and cancellation buffers remain inside
Shopify's 10-second low-volume CarrierService ceiling. Shopify's
documented 5- and 3-second high-volume ceilings remain a separate performance
gate; this sandbox proof does not claim readiness at those request rates.
The latency-sensitive new-claim and expired-lease reclaim paths return only the
durable receipt Global ID plus the exact lease token needed by the callback;
they do not hydrate terminal package, allocation, or offer evidence that cannot
exist yet. The claim reads only the scalar CarrierService configuration fence
required to establish authority. Cached, terminal-replay, and in-progress
follower paths still hydrate the complete typed receipt. Child hydration may
run in parallel through independent pool connections, but reads on one
transaction client are serialized; concurrent `PoolClient.query()` calls are
not a supported performance mechanism. These query-shape rules preserve the
absolute 6.5-second carrier and 9.25-second response deadlines rather
than extending Shopify's callback budget.
Shopify may submit the same normalized checkout request more than once while
the first callback is still processing. Exactly matching duplicates coalesce
only on the full execution fence: organization, commerce account, request
fingerprint, inventory snapshot hash, configuration and activation revision,
the complete normalized cartonization input, packaging and stock revisions,
carrier credential generations, and stable cache key. A separate 30-second
attempt-bucket suffix preserves duplicate coalescence during Shopify's
failed-response cache window. Once that failed receipt expires, the same
stable execution fence receives a fresh attempt key instead of replaying a
terminal failure forever; a successful receipt remains cacheable across later
attempt buckets. The receipt lease owner alone cartonizes, calls UPS and FedEx,
and completes or fails the receipt. A follower waits within the same bounded
callback deadline for that exact durable receipt to become terminal and then
replays its typed package and offer evidence; it must not run a second
cartonization, invoke either carrier, reclaim or fail the owner's lease, or
create another receipt/package/offer lineage. A changed customer, product,
quantity, destination, inventory, configuration, activation, package fact, or
credential generation cannot join that in-flight result. Deadline or request
abort remains fail-closed and never changes the owner receipt.

Proactive checkout warming is a separate, tenant-configurable workflow rather
than a relaxation of the callback fence. When an authenticated storefront
supplies the exact current cart plus the customer's saved delivery addresses,
ClawPilot may request bounded work for every distinct complete supported
destination represented by those addresses. Destination identity includes
Shopify's stored `address1`, `address2`, `city`, `province`, `country`, and
`zip`; canonicalization is used only to collapse an exact duplicate. Two
different streets in the same postal code remain separate warm requests, and
the stored field values are preserved when the browser invokes Shopify Ajax.
Each destination flows through Shopify's authoritative CarrierService callback
and therefore runs the same carton-plan and whole-shipment carrier selection
used by checkout; v1 does not claim a destination-neutral carton plan that is
computed once and reused across addresses. Every warmed result is keyed by the
complete cart, destination, inventory, warehouse, policy, carton plan, carrier
credentials, and callback configuration. A change to any of those facts
invalidates the affected result. Checkout may reuse only an unexpired result
for the selected exact destination and must otherwise execute the
authoritative live callback. Work runs with bounded concurrency and emits
count-only aggregate coverage and per-destination outcome totals; one
destination's failure does not discard successful destinations and no address
or rate fact enters that browser status event. All pages are read through a
fixed 250-address safety bound; exceeding the bound fails the read rather than
silently warming a partial list. Guest checkout has no saved-address cache to
prepare. The CarrierService callback alone does not constitute an early
storefront cart signal; hosted-store proactive warming therefore requires an
explicit storefront cart integration before this workflow can be activated.

The operator-facing name for this workflow is **Saved-address rate cache
preparation**. Every distinct eligible complete saved destination is processed
in the background, while the UI exposes aggregate counts only. A warmed
destination is cache preparation, not an order quote, and it does not select a
shipment service. The live CarrierService request for the address selected at
checkout remains the authoritative checkout-rate event.

For Shopify's hosted Online Store, the storefront browser owns the cart
session and therefore owns the warm-up calls. A theme app embed observes the
standard Shopify cart-line update event, reads the locale-aware Ajax cart,
obtains only the signed-in customer's HMAC-authenticated carrier-relevant saved
destination fields through an app proxy, and invokes Shopify's locale-aware
`cart/prepare_shipping_rates.json` plus
`cart/async_shipping_rates.json` endpoints for every returned destination. This
preserves the normal Shopify CarrierService callback, cartonization, provider
evidence, and receipt lineage. The app proxy must validate its signature,
timestamp, shop, and logged-in numeric customer identity. Its Admin API read
may return only `address1`, `address2`, `city`, `province`, `country`, and `zip`
for that customer; names, email, phone, address IDs, Admin tokens, and unrelated
customer facts are neither returned nor stored. The storefront emits aggregate
counts only. App-proxy requests do not carry the storefront cart cookie to
ClawPilot, so the server must never fabricate a CarrierService receipt or
perform a substitute session-cart calculation. Warm-up is best-effort browser
work while that storefront page remains open; navigation or process
termination does not create a durable browser-work continuation. The
selected-address checkout callback remains authoritative.

Warming is disabled by default and belongs to the organization, Shopify
integration account, and CarrierService warehouse configuration. Its policy
v1 fixes the storefront mode to Shopify hosted Ajax, fixes support to United
States destinations, and owns all-saved-address behavior, bounded concurrency,
debounce/minimum interval, and required stale-cart abort. The persisted
compatibility enum remains `all_saved_rate_zones`, but its implemented v1
semantics are all distinct complete saved destinations. Policy changes advance
an optimistic revision and invalidate prior warmed authority. The browser must
stop queued work when the cart fingerprint changes, process each remaining
destination through Shopify, and treat the live selected-destination checkout
callback as authoritative. Migration `0175` backfills this strict policy in the
disabled state and enforces its versioned shape. The extension, app-proxy
mapping, tenant policy, and customer-isolation readiness are separate activation
gates; a deployed application route alone does not activate warming. In the
current bounded test path, enabling additionally requires Operations Shadow, a
verified sandbox Shopify account, a valid nonempty
Shopify customer policy selected in the connection's **Checkout audience**
panel, and an exact signed customer-ID match before credential or Admin API
access. The remaining server-only variant allowlist confines Shadow traffic to
explicit test merchandise. Headless-store warming is a future contract that
must use Storefront Cart buyer identity, delivery-address mutations, and
delivery groups rather than this v1 hosted Ajax/app-proxy path.

Migration `0170` makes the checkout carton-plan/rate objective an explicit
tenant-owned fact inside the existing organization/account configuration,
which is already bound to one warehouse. Existing configurations are
backfilled with the versioned default, including an explicit ISO-4217 handling
currency taken from that tenant's workspace preference. If a legacy
configuration has no preference row, migration `0170` first creates the
application's existing imperial/USD workspace default for that organization;
it never overwrites an existing tenant currency. Their policy hash and
revision are refreshed, and future callbacks
fail closed when the persisted policy is missing or malformed; a process-local
fallback is not configuration authority. The setup API returns the exact
resolved policy and accepts owner/admin changes to its bounded candidate count,
objective priority, per-package handling cost, and handling currency. In
Operations Shadow, a dedicated optimistic policy-only command remains usable
after CarrierService registration: it increments only the policy and row
revisions and cannot change the provider registration, service GID, callback
token, warehouse, material bindings, or carrier bindings. Explicit JSON null
is invalid and never resets an existing policy. For the current AG/default
policy, hard fit, stock, weight, and currency feasibility apply first. The
handling currency must match the cart currency, and materials plus recipes in
another currency are removed before the bounded candidate frontier is built,
so they cannot consume its candidate budget. ClawPilot then ranks the bounded,
deterministically generated feasible complete-shipment candidates by lowest
whole-shipment landed cost
(carrier charge plus configured material and handling cost), fewer packages,
least unused cube (highest utilization), and stable candidate/carrier/service
identifiers. The deterministic best-first frontier considers each independent
compatibility pool's first alternative before compounded substitutions, using
the tenant objective's material ordering as its proxy; a pool earlier in stable
sort order cannot consume the frontier by itself. This is the best
whole-shipment price among the bounded generated feasible candidates, not a
claim of mathematical global optimality. Material
gross-weight and available-stock fences participate in plan construction, and
the bounded search can select different materials for independent
compatibility pools. Each candidate is sent to each configured carrier once as
its full ordered package array; one returned service covers every package and
per-package service stitching is forbidden. One provider timeout or sanitized
failure cannot erase another provider's usable whole-shipment offers. A
partially successful baseline remains selection-eligible only when the failed
provider's exact durable rate-request evidence and stable failure code were
persisted; no-provider success or missing failure evidence still fails the
quote closed. Later candidates are best-effort under a separate bounded
deadline; a failed optional candidate is retained as degraded evidence and
cannot invalidate a usable baseline.
Receipt response protocol `v3` retains exactly one typed provider-attempt row
for every configured carrier. Each successful attempt owns at least one offer;
each degraded attempt owns no offer and references exact failed carrier
evidence with the same stable failure code. Legacy `v2` receipts remain
replayable only through their pre-existing immutable package and offer
evidence. The receipt retains each candidate input/result hash, algorithm and
policy version, material and stock revisions, costs/currency, recipe/profile
revisions, tare/content/rated weights, allocations, package facts, all
successful offers and carrier evidence, or the explicit degraded code. A
provider-successful alternative whose local objective evaluation fails is
retained as degraded evidence and cannot invalidate the usable baseline.
Material and handling costs select the carton plan but do not silently
increase the carrier amount returned to Shopify. No checkout delivery-SLA rule
is claimed until a versioned tenant promise is durably configured. This
checkout deadline policy is distinct from the broader fulfillment-optimizer
objective contract below, which may consider warehouse splits and other
fulfillment costs after order intake.

`npm run test:shopify-carrier-service-postgres` is the rollback-only database
acceptance for migrations `0164`, `0165`, `0170`, and `0174` before permanent
development application. The `0164` acceptance
requires the explicitly trusted Railway development database fingerprint,
applies the parcel-evidence correction inside one transaction, projects both
an approved-recipe carton and a self-packaged case into the exact provider
request shape, proves that an ordered two-package checkout plan is compared as
one dynamic carrier parcel array, and inserts exact UPS and FedEx offers
against retained successful rate evidence. Package drift and a mismatched
carrier amount must still fail closed.
The transaction then rolls back, and a second connection must prove that no
schema, migration-history, receipt, package, allocation, or offer residue was
retained.
The `0165` acceptance applies the shared readiness replacement in a separate
rollback-only transaction. It proves the current verified store entity retains
readiness, missing, oversized, and control-character identities fail closed,
and restoring the provider value restores readiness. A second connection must
prove the original function and integration configuration were fully restored.
The authenticated setup read must also succeed when an account has no
CarrierService mutation history. Its persistence queries use the
PostgreSQL-safe `authorized_mutation` alias; setup-load failure is reported as
an error and must never be rendered as a false owner/administrator-permission
denial.
The `0170` acceptance backfills every current tenant CarrierService
configuration inside one transaction, proves each stored policy matches its
canonical policy hash, rejects a missing policy at the table boundary, proves
organization-scoped mutation cannot cross the tenant fence, persists a
different accepted priority without code changes, and rolls the entire
exercise back.
The `0174` acceptance applies typed per-carrier checkout attempts and its
schema-history row inside one transaction. It proves a receipt may finish with
exact UPS success plus exact FedEx degradation, while a missing attempt,
mismatched failure evidence, or an offer linked to a degraded attempt fails
closed. The transaction rolls back, and a second connection proves no `0174`
schema object, migration-history row, receipt, carrier evidence, or test data
remains.

The active commerce-fulfillment continuation uses one operator-selected
Shopify Customer resource as its sole Shadow test intent. The previously
supplied Gmail alias is superseded and must not appear in fixtures, provider
reconciliation, CRM evidence, screenshots, logs, or acceptance records. An
administrator selects that customer in **Integrations > Shopify checkout
rating > Checkout audience** by searching provider-visible name or email, but
ClawPilot persists and authorizes only the exact immutable
`gid://shopify/Customer/<decimal>` identity. A customer policy is one
organization- and integration-account-scoped row, so there is no central
cohort array or application-level customer-count cap. Shopify's documented
CarrierService callback does not guarantee a Customer GID. The local rule can
therefore authorize a request only when Shopify supplies the exact immutable
identity; it cannot promise the same customer-specific result across browsers,
devices, guest sessions, or concurrent checkouts when that fact is absent.
Runtime authorization never trusts callback contact text: names, email
addresses, phone numbers, fax numbers, and company names remain discarded
before normalized request, fingerprint, receipt, or carrier evidence
construction. The callback requires an exact, eligible simulated Shadow policy
for the Shopify customer GID and requires every shippable line to use an
explicitly configured Test Product variant. The operator configures either a
timed Shadow proof window from 15 through 240 minutes, with a 60-minute
default, or explicit **Until turned off** lifetime. Saving or renewing a timed
policy starts a new bounded window; an until-turned-off policy remains eligible
until an administrator edits or removes it, and a null expiry without that
explicit lifetime mode does not qualify. New Shadow policies retain the
documented 60-minute default when no lifetime is supplied, but every update to
an existing Shadow policy must supply an explicit lifetime mode. An omitted
lifetime fails closed instead of silently resetting or renewing the policy as a
new 60-minute window. Missing configuration, an expired or
removed policy, a missing or different customer ID, or any other shippable
variant returns authenticated HTTP 200 with no rates before request
fingerprinting, context reads, receipt persistence, cartonization, or carrier
calls. Display name and masked email
are selection aids only; neither is runtime authority or part of carrier-rate
evidence. Every callback response uses
`<store entity> · <carrier> · <service>` from the provider-confirmed
`registered_service_name` and normalized carrier response rather than the
ClawPilot or Shopify platform name, a customer alias, or an editable
connection label. A registered callback is not rate-ready when that applied
name is missing or differs from the current desired name derived from
refreshed Shopify `shop.name` or the audited override. The applied entity name
and exact customer-neutral branded response are immutable receipt evidence,
and cached duplicates replay that evidence rather than rebuilding a name from
current connection data. Component-aware truncation must retain a nonempty
entity, explicit carrier name, and service name. Carrier-prefix normalization
prevents values such as `UPS · UPS Ground`; the canonical form is
`Pro Bakery Bites · UPS · Ground` (and equivalently for FedEx). The stable
`service_code` and durable response remain customer-neutral. Failures before
receipt claim emit only a structured stage, the last static no-data execution
checkpoint, and a safe reason code with the account Global ID. The checkpoint
identifies only a code-owned boundary such as request parsing, line validation,
context loading, or receipt claim; it never includes payload values. Callback
tokens, request bodies, addresses, and customer facts are never logged.
The receipt claim transaction gives each PostgreSQL statement at most 750ms;
completion and failure retention keep their separate 500ms bound. Pool
acquisition is raced against the callback cancellation signal and absolute
deadline, and a late connection is released without starting a transaction.
Transaction start and every subsequent query are cooperatively checked before
and after execution, while the server-side statement timeout bounds database
work. Commit receives a freshly reduced server-side timeout with a final safety
buffer; once commit resolves, its durable result is returned rather than
reclassified as a late failure. A transaction that cannot reach commit inside
the fence rolls back. The claim may replay the entire idempotent transaction
once only for serialization failure, deadlock, lock timeout, or an exact locally
generated PostgreSQL statement-timeout cancellation. External or
request-driven query cancellation is classified but never retried. Each replay
reacquires the transaction advisory lock and revalidates configuration,
activation, inventory, policy, and idempotency fences; it does not bypass Shadow
authorization or repeat a carrier request. An exhausted retry maps the SQLSTATE
to a fixed ClawPilot reason code and never logs the database message, query text,
request values, or customer facts. The deadline remains authoritative and
produces the existing deadline-exceeded failure instead of extending Shopify's
response budget.
Shopify decimal identifiers and exact
`gid://shopify/Customer/<decimal>`, `gid://shopify/Product/<decimal>`, and
`gid://shopify/ProductVariant/<decimal>` resource GIDs normalize to the same
bounded decimal evidence. A wrong-resource GID, malformed value, or
leading-zero identifier fails closed. Missing-customer discovery callbacks
remain authenticated HTTP 200 with no rates. Protocol failures may log only a
schema-owned path; arbitrary property keys collapse to the known properties
root, and no provider message, payload value, or raw body enters the log.
Shopify can invoke an authenticated CarrierService while checkout has supplied
only a rate-grade US destination. The callback therefore requires country and
a valid postal code, but it does not require or fabricate a state/province,
street, recipient name, or city. Checkout rating deliberately reduces both
ZIP-only and subsequently enriched Shopify callbacks to the same country and
postal-code rate zone. Its versioned request fingerprint and the quote-only
UPS and FedEx destination therefore omit all optional recipient-address fields,
which makes progressive callbacks reuse one immutable receipt rather than
creating ambiguous evidence. The complete registered warehouse origin,
product lines, customer gate, currency, locale, and order totals remain in the
request fence. Label creation, fulfillment, and address validation retain
their full-address contracts and rerate with the execution address. Checkout
and later order intake share a customer-neutral
`shopify-rate-zone-fingerprint-v2` over country and postal code, so a partial
checkout callback can reconcile to the later complete order without retaining
plaintext destination data.
Street, city, or recipient changes inside the same rate zone do not make that
hash authoritative by themselves: exact line quantities, time window,
currency, selected stable service code, and customer-paid amount remain
mandatory match predicates, and zero or multiple candidates still fail
closed. Pre-v2 development receipts are not coerced into a v2 match.
Shopify's successful CarrierService cache does not include customer identity.
Production CarrierService pricing and service availability therefore remain
customer-neutral; a customer policy must not ordinarily change callback
prices or offers. Migration `0188` permits one narrow Shadow acceptance
exception for the operator-requested no-charge order: exact Customer GID,
dedicated Test Product variants, one exact stable service code, and an
explicit subsidy reason. That exception is not strict provider-side audience
isolation because Shopify may reuse its successful response. It must remain a
short-lived test, use the dedicated test-only shipping surface, and be turned
off immediately after the order is submitted. A Shopify Delivery
Customization must hide or filter ClawPilot options by authenticated Customer
GID before any customer-specific policy can remain enabled for an extended
period. The staged Function identifies
ClawPilot offers by stable `clawpilot:<carrier>:<service>` code, never by an
administrator-editable title. Its global `hide_all` default is the Shadow
policy and its global `show_all` default is the Active policy. Per-customer
policies may `show_all`, `hide_all`, `include_only`, or `exclude` an exact set
of stable service codes. An anonymous checkout has no durable Customer GID and
therefore always receives the global default. Until the provider-side guard is
accepted and reverified, a saved customer policy is local simulated or blocked
intent rather than live Shopify enforcement. The current Shadow callback can
test only binary allow or hide: an eligible non-`hide_all` policy admits the
complete customer-neutral ClawPilot service set, while `hide_all` denies it.
Eligibility is explicit: the policy is either inside its configured
15-through-240-minute window or uses **Until turned off**. A null expiry is
never interpreted as indefinite unless that lifetime mode is stored
explicitly. An administrator must edit or remove an until-turned-off policy to
stop it.
`include_only` and `exclude` remain saved future intent and do not filter the
live Shadow response. The setup journey must project those facts from the
tenant/account customer-policy summary, place **Checkout audience** before
saved-address cache preparation and live-cart proof, and never embed a tenant
customer email or other customer PII in generic instructions. Saved-address
cache preparation may run only while an exact selected allow policy remains
eligible under its timed or explicit until-turned-off lifetime and the Test
Product gate is present.
Warming cannot prove or provide deterministic customer enforcement because
Shopify may omit customer identity from the later callback and may reuse a
successful customer-neutral response. The live proof remains an
operator-controlled Shadow test rather than a generally enabled
production-store rate. Choosing an indefinite local policy does not make
Shopify include Customer GID, partition its successful-rate cache by customer,
or provide provider-side audience enforcement. Shopify may reuse a successful
CarrierService response for 15 minutes after an administrator edits or removes
an indefinite policy, so turn-off is an authorization change rather than an
immediate provider-cache purge.
The current Pro Bakery Bites store is verified as Shopify Advanced. Shopify
permits a custom app containing a Function only on Shopify Plus, so the
custom-distributed EPISHIP app cannot activate that Delivery Customization on
the current plan. The repository retains a staged Function package and
provider-verification contract for a future Shopify Plus custom app or eligible
limited-visibility public App Store distribution, but variant-only callback
fallback remains disabled. The current
Advanced-plan proof therefore continues to require the exact test customer and
exact Test Product variant at the callback, automatic fresh inventory, and an
explicit operator-managed policy lifetime; it does not claim general
customer-isolated production activation.
Migration `0181` adds that explicit lifetime discriminator without changing
the exact Customer GID, test-variant, activation, account, inventory, or
zero-provider-write gates. Existing bounded policies remain timed. Indefinite
eligibility exists only when `until_turned_off` is stored deliberately;
missing duration and expiry fields never silently grant it.
That selected-customer and variant gate belongs only to the resource-scoped
`shadow` proof. Shadow customer-policy saves perform zero Shopify writes and
remain visibly marked `not_written`; Active policy changes remain blocked
until the exact Delivery Customization and customer metafield writes are
eligible, applied, and provider-verified. After an explicitly authorized
promotion to `active`, the
CarrierService callback must evaluate every eligible shippable cart for the
store, including authenticated repeat customers, first-time customers, and
guest checkouts. Checkout rating must not depend on a pre-existing CRM customer
record: the callback uses the cart lines, destination rate zone, tenant
inventory, package policy, warehouse origin, and carrier configuration, while
later order intake performs customer identity resolution and CRM projection.
An `active` connection therefore removes the Shadow callback gate rather than
expanding it one buyer at a time. Optional provider-enforced customer policies
may narrow or hide the visible service set for a recognized authenticated
customer, but the Active global default still serves every eligible guest and
customer. There is no provider-safe way to personalize an anonymous checkout
before Shopify establishes a durable customer identity.
The operator-triggered Shopify checkout acceptance uses one deliberately
zero-priced but shippable test product. A zero merchandise subtotal is valid
and does not itself suppress, zero, or otherwise change ClawPilot shipping-rate
eligibility: the carrier estimate is derived from the exact shippable quantity,
current inventory evidence, product and package measurements, warehouse
origin, checkout destination, cartonization result, and one whole-shipment
carrier service. Product price and cart subtotal remain reconciliation
evidence only. The operator creates and advances the cart; ClawPilot retains
the inbound callback, package plan, bounded carrier responses, returned
Shopify rate, expiry, and later unambiguous quote-to-order lineage.
Migration `0188` adds a separate tenant-owned Shadow test subsidy. Normal
carrier charging remains the default. An administrator may instead select
`zero_single_service` for one exact stable Shopify service code that is visible
under the exact customer policy and must record a trimmed, control-free
3-through-160-character reason compatible with durable receipt evidence. The
persisted carrier estimate remains
distinct from the zero checkout charge. The exception is valid only on a
`simulated` / `not_written` Shadow policy; Active saves reject it, and policy
removal clears it. The configuration and its reason are included in the
semantic policy hash and optimistic row version. This creates no Shopify or
carrier write and authorizes ClawPilot to zero no different service, customer,
or tenant. Because Shopify's successful-rate cache is customer-neutral, an
identical Test Product cart and destination may still observe the cached
response until provider expiry; the subsidy is not a strict audience boundary.
At callback completion, the selected offer retains the carrier-derived amount
as `carrier_cost_minor`, records zero as `customer_charge_minor`, and records
the equal negative difference as a `subsidy` checkout adjustment with the
operator reason; it is neither MUD nor carrier-billed actual. Other eligible
offers retain their carrier-derived charge. The customer-policy hash and row
version are part of execution-fence v4, so enabling, changing, or disabling the
subsidy cannot reuse an older paid receipt under the new fence. A completed
typed receipt remains immutable replay authority. If the configured exact
service is not uniquely present in the current whole-shipment result, the
callback fails closed with no ClawPilot rates instead of substituting another
free service. Active and normal-charge paths remain unchanged.
The continuation is not complete until one AG Alchemy development journey
proves: an inbound Shopify cart-rate request; inventory-aware cartonization and
one whole-shipment service choice across all packages; unambiguous
cart-to-order reconciliation; customer/CRM resolution; a fulfillment-time
cartonization and rate rerun; separate checkout charge, checkout carrier
estimate, pre-label carrier estimate, and variance facts; one label, tracking
number, and final tracking-bound packing slip per package; local
print/download artifacts; and provider synchronization at the capability
boundary each provider actually documents. Operations `shadow` may perform
real provider reads, local planning and rating, persistence, variance
analysis, print preparation, and immutable outbound-intent simulation, but it
remains ineligible for provider mutation without a narrowly reviewed,
single-use resource grant. CarrierService create, name-only update, or exact
delete is executable only after the reviewed Shadow simulation is bound to the current
revision-fenced Shadow state and a short-lived exact-operation grant is
consumed. Global Operations remains `shadow`; broad provider scopes alone
never make a write executable.
Faire remains polling/marketplace-estimate based unless Faire documents a
live checkout callback; Shopify callback behavior must not be projected onto
Faire.

`npm run test:operations-regression-postgres` is the rollback-only database
acceptance for this boundary. Against an explicitly supplied development
Postgres URL, it applies `0145` and additive correction `0146`
transactionally, proves valid two-pass,
multi-package, one-service, variance, and tracked-document evidence, asserts
the lineage, quantity, append-only, and document mismatch rejections, then
rolls back and confirms from a second connection that no replay, CRM fixture,
artifact, or schema residue remains.

### Packaging Materials Workflow

**Operations > Packaging materials** manages the consumable outbound container catalog separately from product package profiles. Materials are organization-scoped cartons, poly mailers, or padded mailers with canonical millimeter dimensions, explicit dimension basis and evidence, nullable draft tare and maximum weight, nullable draft unit cost/currency, draft/active status, source, and optimistic row version. A draft may retain a partial customer measurement such as a 9 by 12 envelope with unknown depth; the API and UI preserve that missing value as null and display the activation gaps rather than coercing it to zero. Warehouse stock rows can reference only an existing active warehouse and record availability, on-hand quantity, reorder point, and reorder quantity. Activating a material requires verified usable inner dimensions, nonunknown evidence, complete tare/capacity and cost facts; an optimizer candidate additionally requires an available warehouse row with positive on-hand stock.

Migration `0133` makes the application evidence rule database-authoritative:
`customer_confirmed` and `measured` dimensions require both their confirmation
timestamp and a nonblank evidence reference. When any dimension, basis,
evidence type, or evidence reference changes, the persistence command refreshes
the confirming actor and timestamp instead of retaining stale provenance.

The starter command is idempotent and creates only six manageable draft candidates. It never invents landed cost, historical suitability, or stock and therefore cannot make those drafts eligible for cartonization. The readiness summary uses the last 365 days of shipped facts to report sample count, product-dimension gaps, cost gaps, stock gaps, eligible materials, and reorder needs. It is evidence for operator maintenance, not a claim that the assortment is already optimal.

### Sales-Channel Fit And Current Boundary

Shopify stores and Faire brands are **commerce sales channels** owned by Integration control and Order intake. They are not restaurant POS accounts. Shopify POS may later appear as an order source attribute on a Shopify-origin order, but its presence does not move Shopify credentials, order import, or fulfillment export into the Toast POS/accounting module. A cart is a provider-side pre-order session or quote object, not an owning ClawPilot module.

The `0111` through `0115` control plane, Faire OAuth staging, Shopify diagnostic preview, and operator-controlled normalized intake cover the provider surfaces without flattening their differences:

| Concern | Shopify | Faire | Current ClawPilot behavior |
| --- | --- | --- | --- |
| Account path | Dev Dashboard client ID and secret for one installed same-organization shop; ClawPilot exchanges them for a 24-hour token when needed; multi-merchant OAuth is planned | Organization-supplied Custom App credentials with an OAuth authorization-code flow for one verified brand; a shared multi-brand installation is planned | Candidate identity is verified before encrypted persistence; short-lived Shopify tokens are not persisted; the integration Global ID is permanently bound to that shop/brand in this slice |
| Environment | Development/test store may be classified as `sandbox`; production store is separate | Production only; no public sandbox | No arbitrary provider host can be supplied |
| Change intake | Signed webhooks plus scheduled reconciliation are provider-available | Cursor/high-water polling; no public webhooks | Shopify accepts only enumerated non-customer control-plane webhook evidence. Development-gated catalog and current-order workers run from verified read scopes without another authorization when Operations is eligible. Shopify current-order staging stays inside one 60-day time-fenced session; Faire follows a bounded encrypted live cursor and still requires exact-record refresh plus **Check for newer orders** before validation. Production workers remain inactive |
| Catalog/inventory/orders | GraphQL capabilities are scope-dependent, including protected/restricted scopes | Public brand scopes cover product, inventory, order, shipment, retailer, and review reads/writes as documented | Separate bounded catalog reads stage provider product/variant mapping candidates; separate bounded order reads stage nonterminal orders. A distinct development-only leased worker and its manager recovery command read and reconcile one complete eligible Shopify location into exact mapped-product balances. The CRM catalog remains authoritative, Faire inventory is not synchronized, closed history is not imported, and the refresh path performs no provider write |
| Returns/refunds | Shopify Return objects require their own read scope; order access alone is insufficient | Order item states may expose return outcomes, but no public return/RMA/refund write contract is claimed | The preview does not request Return objects; no canonical returns or refund worker is implemented |
| Fulfillment/tracking | Fulfillment Orders and related scopes are resource-assignment-specific | Documented order shipment writes are available | Merchant-managed fulfillment-order access alone does not cover assigned or third-party fulfillment orders; no authorized fulfillment-export dispatcher invokes provider clients |

`operations_commerce_credentials` stores only authenticated ciphertext and safe masked metadata. The nonsecret immutable provider account ID remains on the integration-account tombstone after disconnect so old receipts, attempts, and cursors can never be rebound to a different store or brand. Credential generations increase on every connect or rotation even after disconnect, and every receipt stores the exact generation whose secret authenticated it. Receipt insertion locks and rechecks the current account, credential generation, verification state, and connection status, so a stale in-flight request cannot cross a rotation, verification failure, or disconnect boundary. A valid delivery received while `receipt_intake_enabled` is false is encrypted and retained in `held`; it proves the webhook secret without entering the processing queue or changing the generic verified-connection status. `operations_commerce_sync_cursors`, immutable `operations_commerce_webhook_receipts`, and finalize-once `operations_commerce_provider_attempts` establish durable cursor, encrypted receipt, retry, unknown-outcome, and dead-letter evidence. The current route accepts only `app/scopes_update`, product, and inventory evidence topics; it rejects order/customer payloads because a bounded retention, erasure, and privacy-response lifecycle is not yet implemented. These tables do not themselves implement claim services, canonical translation, external-ID mapping, replay commands, or provider writes. Those remain the next Phase 6 boundary.

Commerce application credentials are masked by default. An effective owner or administrator of the owning organization may explicitly reveal only the current Shopify client ID/secret or Faire OAuth Application ID/Secret ID. The server rechecks organization scope and current credential generation, records the reveal in organization audit history before returning plaintext, and responds with `Cache-Control: no-store` plus a server-defined 30-second expiry. The browser clears the values at expiry or when the operator hides, rotates, disconnects, or changes context. Old generations, cross-organization credentials, legacy Faire brand tokens, and provider access or refresh tokens are never revealable. A reveal is credential administration, not provider authorization or activation.

The shared Settings setup journey is a presentation contract, not a second integration state machine. Each panel maps its existing verified/configured/active, provider identity, masked credential version, cursor or queue, selected resource, and latest-evidence fields into ordered `complete`, `next`, `needs attention`, or `pending` steps. Nonsecret facts such as Global IDs, provider account IDs, canonical callback URLs, environment, API version, masked credential suffix, scope counts, selected locations, and queue status may be copied. Submitted secrets, decrypted credentials, provider tokens, raw provider payloads, and facts from another organization must never enter the journey. Provider forms and command handlers remain the authority; the journey only makes their order and blockers legible.

Migration `0113` adds a separate ephemeral diagnostic boundary in `operations_commerce_order_preview_runs` and `operations_commerce_order_previews`. It is fail-closed unless `CLAWPILOT_SHOPIFY_ORDER_PREVIEW_ENABLED=1`, the runtime lane is development, local, or preview, and the account is a configured, verified `sandbox` Shopify connection whose token and provider probe both grant `read_orders`. Each run fixes a window, reads at most the newest 25 non-test orders and the first 20 lines per order, marks additional lines as a visible gap, and stores only bounded order identifiers, timestamps, statuses, money totals, line identifiers, SKUs, quantities, mapping/package readiness, hashes, and gap codes. It does not request or retain raw provider payloads, customer identity, names, contact data, addresses, notes, tags, or customized line text.

Preview runs and rows cannot be updated and expire no later than 24 hours. One held run may exist per Shopify account, and a successful replacement deletes the earlier run atomically. Expired rows are purged opportunistically when preview or Sales Channels activity occurs; a manager can clear them earlier, and disconnect clears all held runs for that Shopify account. Every preview run is constrained to zero canonical orders and Shopify writes with no sync-cursor advancement. `read_all_orders` only extends Shopify's eligible history beyond the default 60-day order window; it does not expand the newest-25 preview or turn the separate operational workflow into historical import. Missing `read_returns`, `read_assigned_fulfillment_orders`, or `read_third_party_fulfillment_orders` remains visible as return and fulfillment-coverage gaps even when `read_merchant_managed_fulfillment_orders` is granted. The capability catalog reports operator-controlled `order_import` separately and keeps `historical_order_import` not implemented.

### Shopify Inventory Reconciliation

Migration `0124` adds a separate development-only Shopify inventory boundary. It requires Postgres, the commerce-intake feature gate, a configured and verified Shopify account, the effective `read_inventory`, `read_locations`, and `read_products` grant, one active ClawPilot warehouse, and one uniquely eligible active physical Shopify location. An existing location mapping must still resolve to that same eligible provider location. The manager command and the automatic worker share this exact reconciliation boundary; neither can create a warehouse, select an arbitrary provider host, register a webhook, advance an order cursor, or make a Shopify mutation.
The inventory command uses the shared Shopify effective-scope projection:
provider-reported `write_inventory` and `write_products` satisfy their paired
read requirements, while `read_locations` remains independently required.
Both the token grant and live installation probe must still satisfy that
effective set before any inventory evidence is captured.

The adapter reads every bounded page for the selected location and requests `available`, `incoming`, `committed`, `damaged`, `on_hand`, `quality_control`, `reserved`, and `safety_stock`. Each retained level includes the provider inventory-item identity, SKU, tracking policy, per-state quantity evidence, variant/product identity, barcode, title, vendor, product type and status, inventory policy, customs facts, native weight, and other bounded operational product evidence Shopify supplies. Exact length, width, and height are retained only when a merchant metafield definition unambiguously identifies one axis and uses Shopify's single-value `dimension` type. `list.dimension` definitions are retained as ambiguous evidence but are not selected as a physical axis. Missing or ambiguous dimensions stay visible as gaps; ClawPilot does not infer package dimensions from title, image, weight, or unrelated metafields. Provider product evidence does not replace the editable ClawPilot package profile required for cartonization.

The provider response is durably captured before projection, and a successful run retains its request and snapshot hashes, account and credential generation, selected provider and ClawPilot locations, mapping result, quantities, product evidence, projection disposition, and immutable run identity. Unmapped items, untracked items, negative available-to-promise, protected-state anomalies, and quantity-equation mismatches remain held evidence and do not create a favorable balance. Only an exact account-scoped product mapping can project a position.

Shopify is the source authority for projected positions in this slice. For a consistent level, ClawPilot projects `on hand = available + committed`, `reserved = committed`, and `available = Shopify available`. Imported or staged order demand is not subtracted again because Shopify's committed state already represents allocated demand. Shopify-authoritative positions and ledger rows are fenced from ordinary ClawPilot reservation and adjustment paths; only the reconciliation transaction may replace their balances. Each worker execution is one point-in-time read and reconciliation; automatic scheduling does not make this multi-location allocation, an inventory adjustment/export path, a Faire inventory import, bidirectional synchronization, or production activation.

The public Shopify checkout callback never fetches inventory from Shopify. It
uses only the latest completed account-bound reconciliation and fails closed
when that evidence is older than the CarrierService configuration's maximum
inventory age. Migration `0169` adds a tenant/account-scoped leased refresh
queue to the existing Railway poller. An exact ready configuration becomes due
at half its maximum inventory age, and claim/completion recheck the current
account, credential generation, activation revision, configuration row,
policy, warehouse, scopes, and readiness predicate. A partial unique provider
attempt index plus an account advisory lock prevent the manager and worker from
reading the same Shopify account concurrently under different idempotency keys.
The worker claims one job at a time, renews both the job and provider-read
leases at bounded provider phases and every inventory page, and passes the
claimed configuration fence into the same transaction that mutates the local
projection. A captured provider response whose projection lease expires
reacquires a new fenced lease on that same immutable capture; it does not call
Shopify again or become permanently unrecoverable. Captured manager/worker
overlap completes against the effective
provider attempt's exact idempotency key and run Global ID rather than the
caller's proposed key. It uses a nullable system actor, captures provider
evidence before projection, retries bounded transient failures, dead-letters
terminal failures, and reports worker-loop liveness separately from
stale-account, retry, lease, overdue, and dead-job operational degradation.
Job completion requires the exact succeeded inventory-run evidence and builds
its zero-effect result summary from explicitly typed durable fields. A
completed provider read and projection therefore cannot be left retrying
because PostgreSQL cannot infer a polymorphic JSON parameter type.
The completion fence compares the provider attempt's durable `requested_at`
timestamp with the refresh job's claim timestamp; the provider-attempt table
does not expose a generic `created_at` column. This distinction is operationally
significant: a successful Shopify read may already have projected a current
inventory run even when a malformed completion query leaves the scheduler job
retrying. Bounded retries still fail closed, a terminal dead job prevents the
periodic scheduler from silently churning, and checkout stops returning rates
once the last projected inventory run exceeds its configured maximum age. The
worker contract must therefore assert the exact `requested_at` column so a
five-unit cart cannot become intermittently unrated merely because the
completion bookkeeping failed after Shopify returned five available units.
Only a missing or stale loop heartbeat makes the global health endpoint
unavailable; tenant/account queue failures remain visible warnings. Every result asserts `providerWrites = 0` and
`orderQuantityAdjustment = 0`; the manager-triggered **Sync inventory** command
remains the explicit recovery path. This is development-only automatic
freshness maintenance, not production or bidirectional inventory sync.
The authenticated inventory state also projects the latest job on the exact
current account/configuration fence. A current unrecovered dead job is rendered
as an account-scoped recovery requirement with only its safe error code and
bounded attempt count; the action becomes **Retry inventory sync**. Pending,
processing, and retrying jobs disable the manual action so an operator does not
start a competing read. A later fresh successful manager read clears the
scheduler's operational dead fence without editing or deleting the terminal
job, and the panel records that automatic scheduling is eligible again. This
projection exposes no provider payload, internal database identifier, or
credential and does not weaken the manager permission, account single-flight,
stable-idempotency, zero-provider-write, or zero-order-adjustment boundaries.
Migration `0172` replaces the original provider-attempt protection function
without replacing its trigger. A prepared `inventory.levels.read` attempt may
extend only a still-live lease with the same token. It may rotate an expired
token only when an immutable capture for the same organization, account,
attempt, and request hash exists. Every non-lease column is compared
fail-closed, lease decisions use wall-clock database time, terminal attempts
remain immutable, and a terminal transition still clears the lease and
finalizes exactly once. This recovery path cannot mutate captured evidence,
perform another provider read, write Shopify inventory, or adjust an order.
Migration `0190` makes accepted Shopify `inventory_items/update` and
`inventory_levels/update` receipts an immediate refresh signal without
trusting or projecting the webhook quantity. Signature verification and
receipt deduplication happen first; the verified processor increments a
durable account-scoped dirty version and coalesces a read-only authoritative
refresh job. Completion acknowledges only the dirty version captured by that
job and only when the provider read began after its claim. A newer signal is a
lost-wakeup-safe follow-up, and the periodic half-age poll remains a backstop.
Checkout claim, cache reuse, and terminal receipt finalization bind to the same
clean reconciled version and fail closed while dirty, so an older stock
snapshot cannot be served after Shopify reports a change. Webhook quantities
never become inventory authority and this slice still performs zero Shopify
writes and zero order-quantity adjustments.
`npm run test:shopify-inventory-refresh` is the deterministic contract gate for
the `0190` webhook-watermark, scheduling, lost-wakeup, checkout-fence, and
zero-write behavior. `npm run test:shopify-inventory-refresh-postgres` remains
the explicit trusted-development acceptance for the underlying leased refresh
worker boundary. It requires migrations `0169` and `0171`, then applies only
migration `0172` inside one transaction; it does not claim live-Postgres
acceptance for `0190`.
Migration `0171` replaces the already-applied
readiness function so only an exactly `active` commerce account is eligible.
The acceptance proves disabled-account exclusion, account-level queue and
provider-read single-flight, live renewal, expired captured-token rotation,
immutable attempt/capture evidence, exact-once terminalization, unexpired
completion/failure leases,
mid-flight fence cancellation, bounded retry/dead-letter, and zero-write result
semantics, rolls back, then uses a second connection to verify that no schema,
function definition, account state, or provider-attempt change remains. It is
intentionally not part of the default commerce suite.

### Commerce Normalization, Resolution, And Promotion

Migration `0114` replaces the diagnostic-only stopping point with provider-neutral product and order candidates for Shopify and Faire while preserving the existing CRM product and customer masters and the `gor`/`gol` order aggregate. Migration `0115` adds durable provider-read intents prepared before network I/O, resource-scoped immutable-lineage continuations whose cursors are AES-GCM encrypted at rest, and first-class record rejections with explicit dispositions. Provider reads normalize into bounded intake candidates; candidates are not a second product or order master. The real operator workflows are:

Migration `0173` corrects the Shopify order-intake boundary for
`ShippingLine.code`. Shopify defines this field as an opaque shipping-method
reference and does not impose ClawPilot's former three-character minimum;
carrier-native values such as UPS `03` are valid. The candidate now retains any
non-empty, control-free code up to the normalizer's 255-character bound. Exact
checkout-to-order reconciliation still compares the retained value without
rewriting it. Order-reconciliation SQLSTATE failures are reduced to stable,
operator-safe categories; the known checkout-service constraint has its own
allowlisted code, while unknown constraints remain generic. This keeps a cursor
and worker response diagnosable without persisting raw constraint names,
provider values, or customer data.

The automatic Shopify inventory projection distinguishes reservation
authority and serializes each affected position with the same advisory lock as
fulfillment planning. An active `local_balance` reservation blocks
reconciliation because applying a provider snapshot over a ClawPilot-owned
reservation would overwrite local balance authority. A
`provider_commitment` claim is already represented in Shopify's committed
quantity, so it creates no second balance or ledger delta and does not by
itself block a fresher read-only projection. The complete projection must still
cover the sum of every active provider commitment on the position. Missing,
unmapped, inconsistent, or undercommitted current evidence supplies zero
support and aborts the whole projection with
`SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT`; it never silently releases a
claim or partially advances inventory. Released and consumed claims are
terminal and no longer count against current committed support.

Each provider commitment retains the exact successful sync run and level that
authorized its creation. A newer sufficient Shopify snapshot does not rewrite
that historical evidence. Instead, warehouse release and shipment confirmation
both resolve the newest successful mapped, tracked, equation-valid snapshot,
revalidate the active claim total against its committed quantity, and persist
the current inventory-sync Global IDs in domain and audit evidence. Either
transition fails closed with `OPERATIONS_PROVIDER_COMMITMENT_CHANGED` when the
current snapshot no longer supports the plan.

Migration `0176` closes the next local boundary after canonical promotion
without expanding provider authority. A manager supplies one imported order's
exact row version, one sealed `operational` cartonization/rate evidence Global
ID, a planning reason, and a stable idempotency key. The command accepts only
evidence for the same promoted candidate source hash and one active warehouse;
it fails closed on assumption-backed evidence, incomplete package allocation,
stale material/recipe/profile inputs, ambiguous or insufficient inventory, a
stale Shopify inventory run, a currency/package mismatch, or carrier offers
that do not cover the complete ordered package array.

Operational cartonization/rate evidence may be sealed either before promotion
or from the exact promoted candidate after canonical import. The latter uses
the promoted candidate's current row version and immutable source hash plus
current provider inventory, packaging-material, recipe, and product-pack
facts. Promotion makes that candidate durable canonical-order lineage, so its
former intake review-window expiry does not prevent later warehouse planning.
This exception is operational-only: a promoted candidate cannot re-enter the
assumption-backed sandbox comparison or the zero-write cartonization preview,
and neither path can be used to manufacture executable evidence after
promotion.

The accepted plan owns an immutable link to that evidence and every physical
package owns its exact evidence package key, dimensions, weight, sequence, and
line quantities. Rate selection is whole-shipment only: one UPS or FedEx
service covers every package, and no package may choose a different service.
When an order has a requested-delivery timestamp, infeasible services are
rejected before lowest carrier cost, transit time, and stable identity
tie-breaks are considered.

Reservation authority remains explicit. A ClawPilot-authoritative inventory
position receives a `local_balance` reservation plus the corresponding local
reserved-balance and ledger delta. A Shopify-authoritative position already
contains provider committed quantity in its reconciled reserved projection, so
it receives a `provider_commitment` claim tied to the exact latest successful
Shopify sync run and projected inventory level. Active claims cannot exceed
that evidenced committed quantity, and they create no second balance or ledger
delta. Faire list/catalog availability does not become inventory authority; a
Faire order can use this boundary only when the accepted operational evidence
resolves to eligible ClawPilot-authoritative inventory.

Warehouse release acquires the same account-scoped transaction advisory lock
as Shopify inventory application and deliberately re-runs the reservation
authority trigger for every active provider claim before it creates a wave.
The claim's original sync-run and level references remain immutable acceptance
evidence, while the release event records the newest current supporting
sync-run Global IDs. Missing or invalid current product evidence, a projected
position mismatch, or aggregate active claims above current committed quantity
fails closed and requires inventory reconciliation plus replanning. Pick
confirmation records the pick task and domain/audit evidence but never appends
a local inventory-ledger movement for Shopify authority. Shipment confirmation
serializes with inventory refresh and repeats the same current-support check
immediately before any packaging, shipment, or inventory mutation; only then
does it change the provider claim from `active` to `consumed` without changing
the projected position. The existing queued Shopify fulfillment export remains
the sole provider-write path. Consumed or released provider commitments are
terminal and cannot become active again. Active mode also rejects any planned
or released order whose sealed production cartonization/rate evidence link is
missing. The current slice does not expose the guarded plan-cancellation
command needed to release abandoned inventory and packaging claims, so
accepted real plans must not be cancelled through direct SQL.

The selected carrier estimate, the immutable amount actually charged at
checkout when available, and their signed variance remain separate facts.
Planning applies no MUD. MUD remains legal only after a carrier-billing CSV
produces an approved exact shipment match and an applicable approved
`actual_cost` directive. Migration `0176` creates no label, postage purchase,
shipment, packing slip, tracking observation, fulfillment export, provider
inventory change, or commerce write.

Migration `0177` adds the next deliberately zero-write execution boundary for
an eligible packed Shopify order while Operations remains in Shadow. **Prepare
shipment in Shadow** revalidates the exact current Shopify reconciliation
receipt, canonical lines, accepted fulfillment plan, complete package
allocations, checkout pack/rate evidence, current warehouse and credential
bindings, and configured UPS and FedEx sandbox accounts. Carrier reads occur
outside the database transaction; every configured eligible sandbox carrier is
attempted once with the same complete package array. Finalization then rechecks
drift, selects one successful carrier/service for the entire shipment, records
the fulfillment-time rerate, and persists the mandatory estimated
checkout-to-fulfillment variance plus immutable attempt and package lineage.
Every retained fulfillment rate choice repeats the exact package-plan hash and
package count alongside one exact retained provider rate inside its normalized
response. The database rejects a carrier choice whose provider fact differs,
whose package identity is absent, or whose package identity differs from the
sealed plan.
The reconstructed checkout rate choices obey the same package-identity rule:
their immutable receipt offer snapshot is augmented from the receipt row's
authoritative package-plan hash and package count, with those canonical columns
overriding any absent or conflicting snapshot keys. Reconstruction never
rewrites or backfills the completed checkout receipt.
Shopify's checkout callback can supply only the destination country and postal
code, so its keyed carrier destination fingerprint remains checkout-zone
reconciliation evidence. The later fulfillment rerate independently derives a
complete carrier destination fingerprint from the canonical order ship-to and
requires every UPS/FedEx attempt to match that full address. These fingerprints
are retained as separate facts; a sparse checkout fingerprint is never treated
as the full fulfillment address, and the full address check is never dropped to
make checkout lineage pass.
The canonical order can own only one durable Shadow fulfillment preparation;
changing the client idempotency key cannot create a competing execution after
the first preparation commits, and concurrent attempts serialize on the order
before either can finalize.

Migrations `0192` through `0195` are a forward-only repair chain for that
deferred Shadow execution validator. Migration `0192` preserves the sparse
checkout destination fingerprint separately from the full fulfillment-address
fingerprint, while `0193` requires every retained provider choice to repeat the
sealed package-plan hash and package count. Migration `0194` repairs the
executable validator function without editing the already-applied `0177`
migration or its checksum. Canonical/run line comparisons use their exact
three-column shape and execution-edge line comparisons use their exact
four-column shape; canonical/run package comparisons use their exact
ten-column shape and execution-edge package comparisons use their exact
two-column shape. Each compatible family remains a bidirectional `EXCEPT`, and
their one-column mismatch sentinels are combined only after the independent
comparisons. This retains exact mismatch counts and the existing fail-closed
zero-versus-nonzero invariant. Migration `0195` then makes fulfillment carrier
evidence use the exact provider request parcel shape: ordered description,
integer-inch dimensions, decimal-pound weight, and unit fields. Internal
package keys and nested ClawPilot dimension/weight fields remain in canonical
run evidence and are intentionally excluded from the UPS/FedEx request JSON;
the independent package and allocation comparisons continue to prove their
identity. It does not change data, provider authority, or write behavior. The
repair chain is required because PostgreSQL otherwise rejects an
otherwise-valid execution at deferred-constraint time with SQLSTATE `42601`
before the domain invariant can be evaluated, or rejects exact retained carrier
evidence because its provider-native parcel shape differs from the internal
ClawPilot package snapshot.

Variance is derived from the immutable checkout and fulfillment package,
allocation, selected-service, and selected-rate rows rather than trusting
browser-supplied hashes or summary JSON. Its canonical cause set is
`allocation_changed`, `material_changed`, `service_changed`, and
`recorded_rate_changed`; package-count delta remains a separately stored signed
fact. A supplied cause set or delta that disagrees with those child rows fails
closed at the deferred database constraint.

Checkout line keys and canonical fulfillment line/product Global IDs are
different namespaces and must never be compared as though they were the same
identity. For Shopify, each allocation therefore retains the exact
ProductVariant GID from the promoted commerce candidate as its comparison
identity while preserving its stage-native line and product keys. Canonical
allocation variance groups by physical `package_key` plus that provider variant
identity and compares the summed quantity in both directions. A missing
comparison identity, an unpromoted candidate line, or a candidate identity that
does not exactly match the fulfillment allocation fails closed. Reloaded
Shadow evidence shows both the provider variant and the stage-native
line/product identity so an operator can audit the comparison without
conflating them.

That execution evidence records four separate zero counters for provider,
postage, label, and commerce writes. It creates no shipment, tracking number,
label, postage purchase, final packing slip, inventory-provider mutation, or
commerce fulfillment. A reload must show the exact checkout packages/rate,
fulfillment packages/rate, provider attempts, estimated variance, and all four
zeros from PostgreSQL rather than browser-only state. Existing Shadow
preparation evidence remains visible after a later activation-state change so
the audit trail cannot disappear merely because the organization moves to
Active, read-only, frozen, or disabled. Carrier-label create and void commands
remain unavailable unless Operations is currently Active; durable Shadow
evidence is not label-execution authority. Faire has no documented
live checkout callback lineage equivalent to Shopify CarrierService, so a
Faire order cannot enter this boundary by inference and must fail closed until
an exact provider-specific reconciliation contract exists.

The production-execution boundary now has two pure contracts, the append-only
migration `0180` persistence authority, and one narrow authenticated read-only
production rerate command.
`carrierWholeShipmentRateFoundation.ts` prepares one complete, ordered
1-50-package UPS or FedEx production-rate request and parses a recorded
whole-shipment response into redacted, hash-bound evidence. It binds the exact
organization, integration account, carrier account, credential revision,
account fingerprint, payer relationship, origin, destination, pickup policy,
currency, and package array. `activeCarrierDispatchSnapshot.ts` then seals one
unexpired successful production rerate selection, its exact
carrier/account/credential lineage, billing relationship, registered origin,
ordered package set, selected service, and server-derived retry identity into
an immutable dispatch snapshot.

Migration `0180` preserves migration `0177` as sandbox Shadow history and adds
a separate production fulfillment-rerate ledger. One immutable run and its
ordered package snapshots bind the exact current Active execution. Each
provider call must first own a durable `prepared` attempt with the exact
account configuration revision, credential revision and fingerprint,
registered origin, destination, payer relationship, request hash, and package
run. The network outcome is never written back onto that attempt: a separate
append-only result records succeeded, failed, or unknown, a succeeded result
owns its immutable normalized offers, and one unexpired immutable selection is
authoritative for a later Active dispatch attempt. Only a terminal known
failure permits a consecutive rerate retry; prepared, succeeded, and unknown
outcomes block retry, and unknown remains reconciliation-only.

The Active shipment-group provider, service, and amount inherited from Shadow
remain an immutable planning estimate rather than production execution
authority. The selected production service or amount may differ, while the
exact package set, activation revision, current account/credential authority,
one carrier service for the complete shipment, and server-derived provider
idempotency identity remain mandatory. Every Active carrier-create attempt must
reference the exact production rerate selection and match its provider,
service, activation revision, and package count.

Neither pure contract obtains a token or opens an HTTP connection, and migration
`0180` itself invokes no carrier. `carrierWholeShipmentRateClient.ts`, called by
`productionFulfillmentRerateExecution.ts` through the authenticated Operations
`execute-production-rerate` command, is the only current network producer for
this boundary. It requires Operations Active at the current activation
revision, resolves and binds the exact integration account, carrier account,
verified credential generation and fingerprint, ordered package set, origin,
destination, and billing relationship, and commits the immutable prepared
attempt before token/rate I/O. A replayed prepared attempt is
reconciliation-required and never repeats the provider call; each synchronous
executor outcome is persisted separately as succeeded or failed evidence, with
its terminal time and successful-offer lifetime derived from the PostgreSQL
transaction clock rather than the application or carrier-adapter clock.
Adapter request/completion times are sequence-validated transient telemetry,
not result identity. An exact terminal-evidence replay remains readable after
the offer lifetime expires; only a later service selection requires a current
unexpired offer.
The command is read-only: it does not auto-select a service or perform carrier
shipment/label/void, package-level tracking, final packing slips, inventory
consumption, commerce fulfillment, Shopify/Faire writeback, or any provider
write. Those downstream executable slices remain unimplemented.

`Fetch product catalog -> Fetch next product batch or Check for product changes -> Map existing, Create and map, or Exclude`

`Fetch operational orders -> Fetch next order batch or Check for newer orders -> Resolve -> Validate -> Promote`

The product lane reads bounded Shopify variant pages or Faire product pages into held mapping candidates. Each candidate preserves supported provider product/variant/inventory-item identities, SKU/barcode, title/vendor/type, selected options, current and compare-at price, taxability and shipping requirement when supplied, available-quantity evidence, and weight. Faire uses V2 `prices`, `options`, and item/case measurements; every catalog page requests deleted listings, while an OAuth connection with `READ_INVENTORIES` hydrates availability in at most 50 variant IDs per request and 20 requests per bounded batch. Negative Faire availability remains signed provider evidence and `UNTRACKED` remains unknown; neither updates the WMS inventory ledger. A verified connection authorizes the automatic catalog worker. The worker first reuses the exact account/variant mapping, then its provider-qualified source identity, then one non-archived CRM Product only when an exact stable SKU or GTIN/barcode resolves uniquely without conflicting evidence. Otherwise it creates a provider-scoped Product or leaves the candidate in review. An inactive, archived, draft, unpublished, or sales-paused provider listing may create an **Inactive** Product so the listing is represented without becoming globally saleable; the exact channel lifecycle remains independently inactive. An unchanged unresolved candidate is restaged into the current run so later `auto_create` reconciliation retries it instead of permanently preserving an unresolved historical row. Review offers executable **Map existing**, **Create and map**, and audited **Exclude** actions. The lane does not synchronize inventory, replace the CRM catalog, or write to either provider.

Commerce-created CRM names show the provider product title once and append only meaningful variant option values. A selected option is not appended when that complete phrase is already present in the product title at Unicode alphanumeric boundaries; an option found only inside a larger word remains meaningful, and any other color or size options retain provider order. Shopify `Default Title`, Faire `default`, and a Shopify `displayName` that repeats the full product title are not master-product name content. A `Shopify` or `Faire` suffix is a temporary collision state, not the intended product model. One sellable inventory-and-pack identity owns one canonical `gp` Product whose read-only `salesChannels` field contains its exact provider listings. Each, inner-pack, case, and pallet identities remain separate Products; when their marketing title is otherwise identical, the canonical product name carries a meaningful pack qualifier such as `6 oz each` or `case of 12`, never a provider qualifier.

Migration `0132` keeps each exact sales-channel listing as offer data on that canonical Product instead of flattening provider facts into the CRM master. The durable channel state retains provider product titles, full 512-character variant titles, SKU/barcode, exact wholesale, retail/current, and compare-at minor-unit money with each source currency, taxability, shipping requirement, and provider weight when supplied. The CRM editor presents Shopify selling price as **Current** and its distinct compare-at price as **Compare at**, while Faire retains separate **Wholesale** and **Retail** values and no invented compare-at value. Historical product-candidate money is deliberately not backfilled because those columns have provider-dependent semantics; money remains null until the next verified catalog observation. Reconciliation therefore may choose one canonical identity without relabeling Shopify current price as wholesale, changing either provider currency, or overwriting the editable ClawPilot product price.

Migration `0131` supplies the guarded **Resolve duplicate sales-channel product identities** workflow for records created under the earlier provider-isolation rule. A one-to-one exact stable SKU or GTIN/barcode match is exposed even when Shopify and Faire use different display names and can be reconciled only through the reviewed command. An identifier owned by multiple Products, conflicting current barcodes, or same-provider overlap fails closed; the application never silently merges those records. A name match alone never runs automatically and requires an administrator to confirm that the two rows represent the same sellable product and the same pack level. The canonical row is the record already carrying inventory, order, packaging, or CRM relationships; a duplicate that owns any such operational relationship fails closed. Reconciliation moves only the active provider-variant mapping and channel-state projection to the canonical Product, retains the old `gp` Global ID as a permanent alias, archives the duplicate projection, queues the corresponding SuiteCRM projection changes, and records an audit event. Product-list search by that retired Global ID returns the canonical Product, and an authorized deep link resolves the same alias. Reconciliation deletes no Product, rewrites no historical candidate, order, inventory, packaging, or CRM relationship, and sends zero provider writes.

`scripts/reconcile-ag-alchemy-commerce-product-names.mjs` remains the separate bounded development-only repair for display names created under the earlier convention. It is plan-first, checks the compiled Railway project/environment and development database fingerprint, reads the exact creation candidate named in each product source payload, independently locks and fingerprints every active mapping for each target product, and blocks any product that no longer has exactly its one original creation mapping. It also fences the product hash/time and candidate revision, preserves manually changed names, and enforces both the exact execution confirmation and fresh plan fingerprint at the mutation boundary. Apply changes no product, mapping, candidate, inventory, order, package, or provider identity; it queues the renamed product for normal SuiteCRM synchronization, refreshes the pipeline product dropdown, and appends product-level and summary audit evidence as the `system` actor with `is_system = true` and zero provider writes.

**Fetch operational orders** starts a new read-only order session and records its start cutoff as `windowEnd`. Shopify requests non-test `status:open` orders updated inside the current 60-day operational window and at or before that cutoff, then excludes cancelled, closed, and fulfilled records after normalization. Faire's documented list client in this slice supplies a live cursor rather than a request-time cutoff, so each Faire list candidate carries `source_stale` and cannot validate until the operator selects **Refresh** for an exact `/orders/{id}` read. This is day-to-day open-order intake. It does not backfill closed history or import every historical order. Shopify requires only `read_orders` for this current workflow; `read_all_orders` is reserved for a separately approved historical-import workflow and is not consumed here.

The Shopify read requests the order email, phone, ship-to address, current money sets, return status, shipping-service facts, and exact ordered, current, fulfilled, and unfulfilled line quantities. When the installed grant also contains `read_customers`, it requests the stable customer or purchasing-company identity needed for repeatable CRM matching; without that optional grant, the workflow remains executable through its existing-customer selector or explicit customer creation from the order snapshot. It never guesses a customer identity from a name or email.

Before any initial, continuation, exact-retry, or exact-refresh provider call, the server commits a durable read intent that fixes the organization, account, credential generation, resource, action, idempotency key, query/window, and optional target identity. It then reserves the provider attempt and expiring lease before network I/O. After a successful read, the bounded normalized response is encrypted and captured transactionally with the succeeded attempt before staging begins. If staging fails, retrying the same key decrypts and stages that exact captured response without another provider call; the intake run, candidates/rejections, continuation, command receipt, and intent transition to `staged` still commit together. The scheduled order-reconciliation claim adopts an active continuation read intent's original key, and new continuation reads derive a continuation-stable key, so a captured page is replayed rather than permanently rejected as a competing read after the worker lease changes. A captured or already-reserved continuation may survive a read-policy-version deployment; in that case the historical request hash remains authoritative for its provider attempt and is recoverable only when the provider, resource, credential generation, target/run/continuation identity, cursor hash and row version, session, batch, window, and query hash all still match exactly. A merely prepared historical intent is not eligible for that compatibility path. This recovery is safe for either a worker- or manager-prepared read because the continuation belongs to a worker-created, tenant-scoped, read-only run; provider mutation and canonical-write fences remain unchanged. A lease or intent that expires without a captured response becomes uncertain or expired, invalidates its continuation, and returns a restart-required code; the UI reloads the state and exposes **Restart session**, which begins a new bounded read with a new key. This closes the provider-response crash gap, the advisory-only recovery gap, and deployment-time request-hash drift without weakening idempotency target identity.

When a page has more provider records, **Fetch next order batch** uses `fetch-next` and **Fetch next product batch** uses `fetch-next-products`; each sends the matching previous run Global ID. The server resolves that opaque handle to one encrypted cursor, fixed resource and query hash, credential generation, account, session, and batch number. Product and order continuation handles cannot be interchanged. A successful continuation consumes the prior cursor once and creates the next batch; exhausted, consumed, invalid, expired, rotated-credential, or mismatched state never falls back to a client cursor. Shopify's query remains time-fenced across those pages. Faire's order cursor is live: finish it promptly, exact-refresh each order candidate before validation, then use **Check for newer orders** to reconcile records that changed while paging. Intake continuation state is not `operations_commerce_sync_cursors` and never advances durable synchronization.

The unattended Faire worker uses the same live-cursor constraint. Every fresh
poll starts a full current-order scan with no `updated_at_min` high-watermark;
only an encrypted continuation inside that one scan may resume. Faire exposes
no upper-bound time fence, so a lower-bound incremental checkpoint could skip
a record that moves behind the live cursor during paging. The worker therefore
chooses repeatable completeness over an unsafe incremental optimization.

Normalization may reject one malformed or over-limit provider record without discarding valid candidates in the same batch. A rejection is a row-versioned object with its own Global ID, source hash, safe code/message, and `open`, `retried`, `excluded`, or `superseded` disposition. **Retry exact order** re-reads an order rejection's exact provider identity under its own durable intent. **Exclude** accepts the current row version plus a safe operator reason and records the receipt and audit event. Product rejections cannot use exact retry because the current adapters expose no safe exact-variant read; the UI requires exclusion, provider correction, and a new bounded catalog fetch. Rejection messages therefore always lead to an executable ClawPilot disposition instead of stopping at advice.

The Issues section projects only the latest retained rejection for each
account, resource type, and external provider identity, then filters to current
open unexpired issues. It reports the uncapped current total separately from
the at-most-500 loaded rows, labels search/actions/CSV as loaded-subset
operations when truncated, and keeps historical rejection rows append-only.

Root order pagination is not represented as a `source_truncated` candidate blocker: an available root continuation produces **Fetch next order batch**. A truncation blocker is reserved for one provider record whose nested or per-order facts still could not be completed within the safe adapter contract. The operator may **Refresh** that exact record after provider correction or adapter recovery, then **Mark unsupported** if the current revision remains permanently incomplete.

An intake run and every candidate carry the organization, integration account, provider and API version, resource, external identity, provider timestamps and raw status, observation time, source hash, normalizer version, credential generation, and retention boundary. Money is stored as integer minor units plus ISO 4217 currency. For a line with positive remaining fulfillment demand, an exact nonnegative provider unit price in the order currency is accepted automatically as immutable `provider` price resolution and copied into the resolved money fields; this includes a zero-dollar test item. Missing, negative, or cross-currency line money remains blocked for explicit operator resolution, and ClawPilot never substitutes the mutable CRM Product price. Fresh order-candidate header blockers are derived again after the exact current product mappings, package facts, and line-price resolutions are applied, so a resolved line cannot leave a stale `product_mapping_required`, `packaging_required`, or `line_price_required` header warning. Previously retained candidate revisions remain historical evidence and require an exact **Refresh** to receive the corrected staging policy. Order-time names, SKUs, prices, parties, and addresses remain snapshots and never overwrite a current CRM or product master. Shopify Global IDs and Faire resource IDs are immutable provider aliases; SKU, barcode, title, email, and order number are matching evidence only.

Candidate workflow state is one of `held`, `resolving`, `ready`, `promoted`, `failed`, or `expired`. A candidate is `ready` only when all required resolution records are complete and a deterministic validation pass records no blocking issue. Each blocker exposed in the UI must have one of these outcomes:

| Blocker | Executable operator action | Completion evidence |
| --- | --- | --- |
| Provider catalog variant needs a product disposition | Select an active `gp` product, explicitly create an account-scoped CRM product and mapping, or exclude the catalog candidate with a safe reason. | Row-versioned decision, exact account/provider/variant mapping or terminal audited exclusion, and command receipt |
| Product or variant is unresolved | Select an existing `gp` product, or explicitly create a new CRM product, then bind the exact account-scoped provider variant identity. SKU-only matches are suggestions and require confirmation. | Active exact-variant mapping plus the selected product Global ID |
| Customer is unresolved or ambiguous | The unattended order-intake sweep first reuses the exact account-scoped provider identity, then applies deterministic CRM matching, and creates a new CRM customer when no match exists. Only ambiguous matches or provider records without a stable customer identity remain for integration-administrator review; warehouse execution does not own this decision. | Provider identity mapped to one `ga` identity and recorded match/create method, or an explicit ambiguity exception |
| Ship-to is missing or redacted | Confirm the provider address snapshot or enter the complete ship-to address manually. | Validated candidate address snapshot |
| Requested delivery handling is missing | Choose a provider date when present, enter a requested-delivery time, or explicitly choose the versioned default SLA policy. | UTC requested-delivery value and decision provenance |
| Product packaging is incomplete | Select an active package profile or enter a candidate-specific weight and dimensions for the order line. | Positive canonical grams and millimeters with source provenance |
| Provider record is stale or has a repairable per-order truncation | Select **Refresh** to read that exact provider order again, then resolve and validate its new candidate revision. | Later source revision and new validation |
| Provider record is cancelled, already fulfilled, permanently truncated, or unsupported | Select **Mark unsupported** with a safe provider reason. A failed/unsupported candidate is terminal; select **Check for newer orders** after correcting the provider if another attempt is required. An exactly quantified partially fulfilled Shopify record instead proceeds with only its remaining unfulfilled line work. | Terminal unsupported reason, a distinct later candidate from a new fetch, or exact remaining-work quantity evidence |
| A continuation is consumed, invalid, expired, resource-mismatched, or tied to an old credential generation | Reload when another operator already fetched the next batch; otherwise restart the matching order or product read from its visible workflow card. | Current resource-scoped batch lineage or a new session/run Global ID |
| An order record was rejected before staging | Select **Retry exact order** after correcting the provider, or enter a reason and select **Exclude**. | A staged candidate, current replacement rejection, or audited excluded disposition |
| A product record was rejected before staging | Enter a reason and select **Exclude**, correct the provider record, then run **Fetch product catalog** or **Check for product changes**. | Audited excluded disposition plus a later catalog candidate or rejection |

The resolution API is command-oriented. It exposes separate idempotent commands for order and catalog fetch/continuation, catalog product resolution, exact order-rejection retry, audited rejection exclusion, order-line product binding or explicit product creation, customer binding or explicit customer creation, address confirmation, delivery-policy selection, package resolution, exact-candidate refresh, validation, unsupported acknowledgement, and promotion. Every row-backed decision supplies the current Global ID and row version; every command supplies a stable idempotency key and receives an exact-result receipt. After each staged order page, an unattended customer sweep uses the same durable resolution boundary: exact provider identity first, then unique email, contact email, website domain, name-plus-phone, or exact-name evidence, then create-only CRM creation. An ambiguous tier fails closed for administrator review rather than guessing. The sweep binds the resulting `ga` identity to the order candidate with a deterministic command receipt and records zero provider writes. Explicit or automatic commerce customer creation uses an opaque organization-, integration-account-, provider-, and external-customer-scoped CRM identity (or a candidate-scoped identity when the provider supplies no customer ID) and create-only persistence. It can reuse only a previously created record carrying the same commerce scope evidence; it never name-upserts or changes an unrelated same-name CRM master.

Promotion is a single organization-scoped PostgreSQL transaction. It locks the candidate, revalidates the credential generation, source revision, mappings, customer, package facts, address, delivery decision, and canonical uniqueness, then creates or replays one `operations_orders` row, its `operations_order_lines`, exact external identifiers, product mappings created by the workflow, first `order.imported` domain event, audit event, and command receipt. Shopify promotion also persists the exact checkout-rate reconciliation in that transaction and returns its Global ID, receipt link, outcome, and fulfillment-eligibility fact; a ClawPilot CarrierService order with ambiguous, expired, rejected, or missing lineage cannot be released to warehouse work. A Shopify order using another shipping method is explicitly not applicable to that guard. The promoted order starts `imported` or `held`; promotion does not reserve inventory, select a facility, plan fulfillment, buy a label, create a shipment, advance a provider cursor, or export a fulfillment. Repeating the same command returns the original result. A newer provider revision after resolution returns a stale-candidate conflict and requires refresh and revalidation.

For a promoted Shopify order with a `matched` checkout-rate reconciliation,
operational cartonization uses two distinct authorities. The matched receipt is
the immutable **checkout baseline**: it proves the exact service reconciliation,
provider Product and Variant identities, canonical Product, aggregate ordered
quantity, quoted unit weight, and the pack mapping/profile identifiers and
versions captured while the cart was rated. It is never joined back to mutable
mapping or profile rows and never becomes today's fulfillment configuration.
A later catalog refresh may legitimately retire checkout mapping A; ClawPilot
retains A as historical evidence and never reactivates or rewrites it.

The second cartonization pass independently resolves the exact-current
**fulfillment authority** for the same organization, commerce account,
pipeline, canonical Product, provider Product, and provider Variant. That row
must have purpose `shopify_checkout`, be the current projection, match the
current channel-state pack fingerprint, directly prove that the current
channel row is active, provider-active, and requires shipping, and point to an
eligible current pack profile. The planner uses this replacement
mapping/profile B for present-day
cartonization and rerating. A generic `catalog` mapping, candidate-captured
mapping, SKU, barcode, or title can never substitute for B. Missing B returns
`HYBRID_CARTONIZATION_FULFILLMENT_PACK_MAPPING_REQUIRED`; an incomplete or
stale B returns `HYBRID_CARTONIZATION_FULFILLMENT_PACK_EVIDENCE_INVALID`; and
conflicting current B rows fail closed. Durable rate evidence retains the
matched receipt Global ID, immutable checkout baseline A, and the independently
resolved current fulfillment mapping/profile B so later quote-to-fulfillment
package and price variance can be explained without mutating either record.

New checkout receipt lines use the explicit
`shopify-checkout-line-pack-evidence-v1` snapshot version. The callback obtains
the mapping/channel-state `packEvidenceHash` only after proving the two current
fingerprints match, includes all physical pack identities and facts in the
execution fence, and persists their complete normalized snapshot. The claim
boundary rejects a missing, malformed, or unknown v1 field. Hydration and the
operational cartonization reader recompute the immutable line hash before
exposing or trusting the snapshot. Historical immutable rows
are not backfilled: a missing or unknown snapshot version, mapping row version,
or hash remains `null` and is never inferred from today's provider state. This
additive receipt format does not weaken quote-time current mapping, profile,
weight, inventory, or pack-evidence validation, and neither pass grants a
provider write in Shadow.
Receipt quantity reconciliation covers every requires-shipping source line and
its original ordered quantity, including lines later fulfilled, cancelled, or
refunded; cartonization demand is then limited to positive current unfulfilled
quantity. A promoted order whose Shopify shipping code begins `clawpilot:` must
have exactly one current `matched` reconciliation backed by a succeeded
receipt. Missing, rejected, ambiguous, expired, failed, or service-code-drifted
lineage blocks operational evidence. Generic candidate-captured pack facts are
available only to genuinely non-ClawPilot Shopify shipping methods.

For a partially fulfilled Shopify order, promotion creates canonical lines only for positive `unfulfilledQuantity` and makes that remaining quantity the canonical work quantity, so ClawPilot cannot fulfill units Shopify already fulfilled. Completed or removed/refunded source lines are excluded from canonical work while every source line's ordered, current, fulfilled, unfulfilled, removed-or-refunded, and returned-quantity availability is retained in the canonical order source payload with the source revision and hash. Shopify's `quantity - currentQuantity` delta is deliberately recorded as removed-or-refunded evidence rather than asserted to be a pure cancellation. Exact per-line returned quantity remains unavailable in this read path and is retained as unknown; adding it requires an authorized Return-data workflow rather than inference from order status.

The canonical order's merchandise total is derived from each positive remaining quantity multiplied by its resolved order-time unit price in the candidate currency: the exact immutable provider copy when available, otherwise an operator-confirmed manual resolution. Promotion retains a versioned monetary-reconciliation object containing that basis, the provider subtotal, the canonical merchandise total, and their signed variance. The provider header subtotal therefore remains source evidence and cannot incorrectly redefine remaining ClawPilot fulfillment demand.

Provider write-back is structurally disabled for this workflow. Its provider port contains read methods only; Shopify mutations, Faire write methods, fulfillment export, inventory export, webhook registration, and cursor advancement are absent. A database safety test compares provider attempts, sync cursors, inventory ledger, reservations, fulfillment, shipments, and export tables before and after intake and promotion. Permitted local changes are bounded intake evidence and receipts; explicitly selected catalog mappings or account-scoped CRM creations; explicitly promoted order-line product/customer records and mappings; and the canonical order/lines, external identifiers, domain event, and audit evidence. No provider-side state changes.

That intake/promotion boundary is intentionally separate from the explicit
Product-manager image command added by migrations `0153` through `0155` and
hardened by migration `0160`.
ClawPilot stores validated PNG, JPEG, or WebP originals as immutable,
tenant-scoped revisions and selects one local primary revision without
overwriting bytes. An authenticated organization-manager preview streams only
the exact tenant-, Product-, and asset-fenced revision with no-store,
same-origin response controls; the Product editor therefore shows the stored
image instead of metadata alone. **Simulate in Shadow** resolves the exact
Product, mapped active Shopify listing and variant, primary image revision,
credential generation, scope grant, and global Shadow revision, persists
replay-stable evidence, and guarantees zero provider writes. **Publish this
exact image once** is available only after that exact simulation and explicit
owner or administrator confirmation. It issues at most one idempotent
`productUpdate(..., media:)` call under the current verified credential and
`write_products` grant while global Operations remains `shadow`. The server,
not the browser, derives the idempotency identity from the integration
account, server-resolved parent Shopify Product GID and variant, immutable
image asset revision, channel-state revision, prior simulation, and internal
provider-effect mode. Changing the Product, listing, channel revision, or
image revision clears the UI confirmation and invalidates the durable grant.
The Shopify product-update adapter is versioned into that server-derived
identity. Adapter v2 selects the newest returned media node with Shopify's
forward-pagination-compatible
`media(first: 1, reverse: true, sortKey: POSITION)` connection arguments.
Adapter v3 also follows Shopify's 2026-07 `ProductUpdatePayload` contract:
generic `UserError` exposes `field` and `message`, not a `code` field. The
invalid `userErrors.code` selection made the complete mutation fail GraphQL
validation before Shopify could execute the write. Terminal unknown effects
from older adapter contracts remain immutable evidence. A newer adapter
therefore derives a fresh Shadow identity, but a fresh Active grant remains
blocked while any earlier effect is unresolved; changing the adapter version
never bypasses the unknown-provider-outcome fence.
An owner/admin can reconcile that exact unknown outcome only through the
read-only `reconcile-unknown-product-image` command. The server waits until five
minutes after both the provider attempt and signed-source expiry, then reads the
server-resolved parent Product with
`mediaCount` plus
`media(first: 1, reverse: true, sortKey: POSITION)`. Two append-only
zero-media observations at least one minute apart are required, and the newest
observation must still be less than five minutes old when Active authority is
issued. The observations bind the old effect, active grant, authorization,
Product, Product image asset/hash, signed-source hashes, credential generation,
query contract, and administrator. Any observed media keeps automatic recovery
closed. The old `unknown` effect is never changed or deleted; only after this
negative evidence may an exact fresh current-adapter Shadow simulation
authorize one new Active attempt. This automated absence proof is deliberately
available only
when the Product's total media baseline is zero; a Product with any pre-existing
image, video, or model remains closed for administrator investigation until a
future baseline-aware recovery contract can distinguish the attempted append
from unrelated media. Positive observations retain the newest media identity,
content type, and status for that investigation.
The Product-image parent lock and its purpose-specific grant, authorization,
and effect constraints reject ambiguous parent-level image authority without
forbidding legitimate variant-level Product mappings. Optional signed-receipt
queue status is not product-write authority.

Shopify media creation is asynchronous. A successful mutation means Shopify
accepted the media request; it does not mean the image is ready or featured.
The exact confirmation creates one immutable, short-lived authorization for
one delivery grant, one prior zero-write simulation, and one matching external
effect. It cannot be reused for another asset, Product, channel state, variant
listing, parent Product GID, or effect. The narrow authorization permits only
the selected image append while the credential remains verified, both live
scope probes grant `write_products`, and the global Operations revision
remains Shadow. It does not enable the generic integration account,
signed-receipt processing, or any other Shopify mutation.

The authorization expires within five minutes and must remain current through
effect insertion and claim. The exact active delivery grant and signed media
token have a separate maximum 15-minute lifetime so Shopify can fetch the same
bytes asynchronously after a claim. The signed token is reverified
server-side, then its exact URL SHA-256 and host are immutably bound to the
authorization and grant before external-effect preparation. Effect insertion,
claim, and later byte delivery require those values to match exactly. The
delivery grant is not reusable mutation authority and cannot serve a different
Product or image.

ClawPilot retains the returned MediaImage ID and bounded media errors. The
operator can refresh `UPLOADED` or `PROCESSING` evidence through an exact,
read-only MediaImage lookup; each observation is append-only, and `READY` or
`FAILED` is terminal for that publication. Refresh and terminal replay issue
zero Shopify writes. An expired claimed effect with an unknown provider
outcome is moved to terminal investigation without retrying the mutation, so
operator recovery cannot duplicate an unconfirmed image append. This workflow
does not call `productReorderMedia`, never claims position zero, and never
labels the newly added image as Shopify's primary or featured image.

Candidate party and address fields are tenant-scoped protected operational data. Routes require the active organization plus Operations-management permission, responses use `no-store`, audit payloads exclude the protected values, and candidates, read intents, rejections, and continuations become unavailable after the contracted retention interval. Migration `0115` clears encrypted cursor material when an available continuation is consumed, invalidated, or expired, but this slice does not claim a physical purge worker for intake rows. Promotion retains only the order-time snapshot already required by the canonical order. Provider raw bodies are not stored in the candidate tables.

Shopify and Faire normalizers implement the same versioned envelope and semantic fields without erasing provider differences. Shopify keeps separate order, financial, fulfillment, and return states, shop and presentment money, order-time line snapshots, full provider Global IDs, and field-level unavailable/redacted evidence. Faire keeps its brand/retailer distinction, case-sensitive SKU, physical quantity separately from `unit_multiplier`, brand discounts separately from line discounts, payout facts separately from customer payment state, and an absent inventory quantity separately from zero. A provider-specific field that has no safe canonical meaning remains in typed provider evidence or becomes an explicit unsupported condition; it is never guessed.

Migration `0130` makes one CRM/WMS product the canonical product master while projecting its exact provider variants through a read-only `salesChannels` field. A variant may reuse an existing product only when an exact stable SKU or GTIN/barcode resolves to one non-archived product. Multiple matches and same-SKU records with conflicting known barcodes fail closed; names and inferred pack levels never establish identity, so genuinely different each, inner-pack, and case products remain distinct. The durable channel projection retains raw lifecycle, normalized `active`, `draft`, `archived`, `unlisted`, `unavailable`, or `unknown` state, connection status, environment, external identity, and observation time after intake candidates expire and when an account is disabled or in error. Updating that projection never changes `crm_products.active`; only first-time Product creation derives its initial Active/Inactive master lifecycle from the observed provider status. Shopify explicitly requests `ACTIVE`, `ARCHIVED`, `DRAFT`, and `UNLISTED`, and the UI labels `active` only as **Source active**, not published. Faire requests `include_deleted=true`, retains `lifecycle_state` separately from `sale_state`, and preserves every lifecycle the brand API returns. A record missing from one provider response is not inferred to be archived.

Migration `0152` extends that retained channel projection with versioned
provider taxonomy rather than copying provider categories into the editable
ClawPilot Product category. Shopify retains its Standard Product Taxonomy
category GID, name, full name, and hierarchy path when the provider supplies
them; Faire retains its provider product type. A new local Product may use the
first exact observed category as initial editable context, but later catalog
reads never silently overwrite an operator-managed ClawPilot category.
Creating or updating provider categories remains a separately authorized
write workflow.

Migration `0131` preserves the same canonical model while reconciling historical provider-isolated Products. The UI exposes the workflow only to authorized product editors with Operations-management authority. Every command carries both Products' source hashes and update timestamps, locks both rows and their active mappings, rechecks operational-reference blockers, and records the old Global ID as an alias before changing the projection. Unique cross-provider exact identifier matches are discoverable independently of display name; ambiguous identifier ownership is not actionable. Exact identifier matches and administrator-confirmed same-name/same-pack matches use the same server-owned transaction; neither path treats title as durable identity or merges without an explicit command.

This is a development-only implementation behind `CLAWPILOT_COMMERCE_INTAKE_ENABLED=1`; the runtime refuses production. A product-readable verified connection authorizes catalog sync without a second approval and initializes a missing policy as resumed in the eligible runtime. That initialization is distinct from worker queueing: the leased job queues and executes only after the current product-read scope, credential generation, policy revision, and configured `shadow` or `active` Operations product target are eligible. Interactive reads and decisions remain gated by manager authority and `shadow` or `active` organization activation. A verified connection whose organization is missing activation, `disabled`, or `read_only` exposes an authorized **Enable Shadow** command in the intake workflow. That command configures the reviewed Operations target and requires explicit confirmation, organization activation authority, a current verified account, and an exact expected state-and-revision fence (or an exact missing-state sentinel) under the activation lock; it is not a second provider or catalog authorization and cannot override `frozen`, `active`, or a concurrent activation change. These contracts do not claim a successful hosted Shopify or Faire read, catalog mapping, rejection recovery, or order promotion until separate development deployment and browser acceptance evidence is recorded.

### Native Development Tenancy And Operations Establishment

The one-time native-development establishment is a bounded repair of the existing development database, not an environment-mirroring mechanism and not a production migration. It must refuse production, must not restore or copy a production database into development, and must not copy development records or credentials into production. Suburbia Sandwich Co and Express Parcel International DBA EPISCS remain independent root workspaces with their existing data and memberships. AG Alchemy, LLC is created as a third independent root workspace with an owner membership for the designated operator, marked nondefault so the operator can switch to it without changing the existing Suburbia default. The initial tenancy establishment gives AG no cloned pipeline, CRM, warehouse, order, integration, or other tenant-owned records. The later carrier-rating delegation described below is the sole bounded exception and creates new AG-scoped projections rather than reparenting EPISCS records.

The installed `ag-alchemy.myshopify.com` development store belongs to AG Alchemy, LLC after establishment. The existing Express Shopify integration account is not reparented: it becomes a disabled, credential-free nonsecret tombstone, and its immutable provider attempts remain in Express under their original integration-account and organization identities. A new AG integration account receives a new ClawPilot Global ID and the same verified provider shop identity. The application credential is decrypted only inside the guarded process, re-encrypted with AG-specific authenticated context, verified by a fresh Shopify client-credentials exchange and read-only identity/scope probe, and never logged or returned by the establishment command. The new account remains `sandbox` and generic-status `active` for verified reads and registered callback computation; signed receipt intake remains false and provider writes remain unauthorized. Its product-readable connection authorizes automatic catalog sync, and its order-readable connection authorizes automatic current-order staging, only in the eligible development runtime. Each worker still requires its independent scope, credential, and Operations-target fences. Short-lived Shopify access tokens are not persisted.

This transfer does not move old provider attempts, cursors, webhook receipts, or held previews across organizations. Any later AG held-order preview is a fresh bounded read under the new AG account. Establishment must not register a webhook, advance a sync cursor, create a canonical order, create or update a customer, product, inventory record, or mapping, export a fulfillment, or call any other Shopify mutation or provider write.

Express retains its established UPS and FedEx account identities and encrypted credentials without rotation or reassignment. It also retains the exact physical Zebra printer, enrolled local print agent, and warehouse identity to which those append-only print and delivery records are bound. The bound warehouse is normalized in place from simulator metadata into the active Express operational facility; the printer and agent are not re-created, re-enrolled, or moved between organizations or warehouses. Unused enrollment shells and mock printers may be disabled or retired only after dependency checks prove that doing so cannot strand the physical printer, active agent, immutable print jobs, artifact payloads, or delivery attempts.

`scripts/establish-ag-alchemy-carrier-sandbox.mjs` is a separate development-only, plan-first delegation command. It requires the exact compiled Railway development project, environment ID and name, the compiled development database fingerprint, exactly one active, verified EPISCS UPS sandbox account, one active, verified EPISCS FedEx sandbox account, exactly one active AG warehouse with code `AG-ALCHEMY-01` and Global ID `gwh5366613`, and one active AG owner or administrator. It decrypts and freshly verifies each source credential outside the write transaction, then rechecks a source-state digest before and after the transaction so the EPISCS integration, account, credential and account ciphertext/IV/tag, billing identity and payer flags, address and stored fingerprint, configuration, verification and error state, masked metadata, ownership metadata, timestamps, version, and status remain unchanged. Apply uses a serializable transaction and advisory lock to create or update fresh AG integration/account Global IDs and AG-authenticated ciphertext, with idempotent create, update, or no-op dispositions. Every ordinary target-side persistence mutation also locks the integration account with `FOR UPDATE` and reasserts the managed policy inside its transaction. Provisioning takes matching target credential advisory locks, reloads and locks the exact warehouse inside that transaction, and aborts if its reviewed snapshot changed. The AG account is `operator_owned`, auditably references EPISCS as its source, and uses the AG warehouse sender identity and address. Its default exact profile declares `authorizationScope: 'sandbox_rating_only'` with `allowedCapabilities: ['sandbox_rate']`; runtime capability and source-management guards then deny credential reveal, credential/account changes, disconnect, generic connection verification, labels, voids, pickups, manifests, shipments, and every other carrier mutation. The separate literal `--enable-sandbox-fulfillment` confirmation installs exactly `authorizationScope: 'sandbox_fulfillment_diagnostic'` with ordered capabilities `['sandbox_rate', 'sandbox_label']`. That narrower profile permits the Settings workflow to rate, create one exact-service provider sandbox label, download the immutable returned PDF/PNG/ZPL bytes, route one compatible test print, and void or close the sample. It never grants production rate or label execution, shipment, pickup, manifest, tracking, commerce write, or credential reveal. Missing, extra, or reordered managed configuration fails closed, and rerunning the guarded command without the fulfillment flag restores rating-only behavior and blocks queued, replayed, retried, reprinted, downloaded, voided, or closed test-label artifacts before bytes or provider calls are released. The generic **Test connection** command always fails before provider I/O and cannot change verification state. `scripts/prove-ag-alchemy-carrier-sandbox-rating.mjs` independently rechecks the trusted database, current AG warehouse sender identity/address, either exact delegated profile, and one active sender-billed account per provider before requesting one UPS and one FedEx quote. It requires an explicit execution confirmation and proves the two append-only rate/audit records while asserting no label attempt, label, shipment, or print side effect. This projection is not a production delegated-carrier contract; production requires a first-class delegated authority, billing, and ship-from model plus separate release evidence.

Zebra media calibration is a separate, guarded device-maintenance action. Read-only inspection is the default. Standard auto calibration requires explicit confirmation that the exact local agent is paused and 4 x 6 gap stock is loaded; it sends only Zebra `~JC`, never a carrier label or ClawPilot artifact. The expected one-to-four blank calibration feeds cannot be recorded as print-job delivery. A single physical Feed press after calibration must advance exactly one label and stop at the tear position before the local agent is resumed. Calibration does not convert stock dimensions, rasterize a document, adjust carrier barcodes, or repair a media-size mismatch.

Exact-artifact download requires no workstation installation. Silent cloud-to-local delivery requires an enrolled local agent or an approved managed printing bridge on a computer or print server that can reach the device. The bundled agent sends provider-native ZPL directly to a compatible network Zebra without an operating-system driver and advertises only ZPL, 4 x 6, shipping-label capability. PDF/PNG and USB/operating-system queues require a separately implemented backend with truthful capabilities. ClawPilot does not import arbitrary GitHub printer-driver collections; every backend must be version-pinned, licensed, security-reviewed, and certified for its declared format, DPI, media, copy count, and device class.

Synthetic warehouse and mock operating state is retired by domain-safe terminal transitions, not by truncating shared tables or bypassing append-only guards. Active synthetic reservations are released through balanced compensating ledger entries; linked plans, tasks, waves, orders, and open exceptions enter their legal terminal states; scenario-only mappings, positions, locations, pools, products, customers, integrations, and devices are deactivated, archived, or tombstoned according to their dependency contract. A mock `operations_contracts` projection may be terminated, but its `operations_contract_versions` rows and pricing directives remain immutable and are never updated or deleted. Permanent Global IDs, inventory ledger entries, domain events, audit events, provider and label attempts, print history, artifacts, and other immutable/finalize-once evidence remain attached to their original organization and aggregate identities. Retired scenario lineage cannot be reseeded.

The establishment command must be plan-first and fail closed. Execution requires the development runtime name, the expected development database fingerprint, an exact operator confirmation, an advisory lock, and exact preflight matches for the named workspaces, Shopify account/shop, carrier accounts, warehouse, printer, print agent, and synthetic-record counts. The one-time AG establishment and Express normalization tools require the exact trusted ClawPilot Railway project and development-environment IDs compiled into them. Their explicitly confirmed disposable-rehearsal lanes require a local PostgreSQL URL and refuse every populated `RAILWAY_*` marker. The intermediate preserve-printing WMS cleanup receives the database fingerprint from the normalization plan, requires the same trusted Railway identities in live use, and verifies the connected database identity before opening its transaction. Provider verification occurs outside the database transaction and is read-only; database changes commit atomically. Any identity, count, dependency, scope, environment, or postflight mismatch aborts without a partial tenancy transfer. A successful postflight proves:

1. Suburbia remains the designated operator's default workspace, Express remains independently switchable, and AG is independently switchable and nondefault.
2. AG owns one verified, generic-status `active` Shopify sandbox account for `ag-alchemy.myshopify.com`; signed receipt intake and provider writes remain disabled while verified product/order read scopes and the registered callback authorize development-gated catalog synchronization, current-order staging, and checkout computation. Actual queue and worker state reflect the independent runtime, scope, credential, policy where applicable, and Operations-target eligibility checks. Express retains only the credential-free Shopify tombstone and its original provider-attempt evidence.
3. Express still owns the same UPS account, FedEx account, physical Zebra printer, enrolled print agent, and bound warehouse identities.
4. AG owns fresh, active, verified UPS and FedEx sandbox projection identities whose origin is warehouse `gwh5366613`; the default exact profile permits only `sandbox_rate`, while the separately confirmed diagnostic profile permits only `sandbox_rate` and `sandbox_label`. In both profiles EPISCS source identities, ciphertext, billing metadata, and verification state remain unchanged, credential reveal and production execution remain blocked, and revoking the diagnostic profile immediately blocks all stored test-label actions.
5. Synthetic WMS/mock records no longer appear as live operating work, all released inventory reconciles to compensating ledger evidence, and immutable history remains queryable.
6. No canonical Shopify order, cursor advancement, Shopify mutation, cross-organization evidence move, environment data copy, or production change occurred.

Normative terms in this document use **must** for an invariant, **should** for the default, and **may** for an allowed option.

## Architectural Principles

1. ClawPilot and Railway Postgres own operational state and evidence. Google Sheets has no write authority for orders, inventory, fulfillment, shipments, or charges.
2. The active workspace organization is the tenant boundary. An authorized pipeline binds the first slice to current CRM customer and product projections, but it does not own operations data.
3. CRM organizations, contacts, and products retain their existing `ga`, `gc`, and `gp` identities and SuiteCRM authority. Operations reference them; operations do not clone them.
4. UUIDs are internal relational keys. Permanent Global IDs are the public and cross-module business identities. Provider IDs, SKUs, order numbers, tracking numbers, emails, and warehouse codes are aliases only.
5. Inventory ledger entries, domain events, billable facts, pricing snapshots, provider responses used for decisions, and audit records are immutable. Corrections use compensating records.
6. Consequential commands are authenticated, tenant-scoped, authorized, idempotent, concurrency-safe, audited, and observable.
7. Provider calls occur behind adapters. A provider adapter cannot select policy, mutate domain tables, or authorize itself.
8. Optimization is advisory computation behind a replaceable interface. Hard constraints, state transitions, permissions, and financial calculations remain deterministic application responsibilities.
9. An AI feature may explain or recommend. It cannot own inventory, calculate authoritative charges, buy labels, confirm shipments, or execute an override.
10. The first production slice is outbound parcel fulfillment. Advanced inbound, returns, lot/serial control, kitting, freight, and labor planning activate only after their own data and operating gates pass.

## System Context

```mermaid
flowchart LR
  User["Authenticated ClawPilot user"] --> UI["Native operations workspace"]
  Portal["Customer portal identity"] --> PortalAPI["Customer-scoped query API"]
  UI --> API["Operations route handlers"]
  PortalAPI --> App["Operations application services"]
  API --> App
  Worker["Scoped operations worker"] --> App
  App --> PG[("Railway Postgres")]
  App --> CRM["CRM and product adapter"]
  App --> Optimizer["Optimizer port"]
  App --> Outbox[("Durable outbox")]
  Outbox --> Commerce["Commerce adapters"]
  Outbox --> Carrier["Carrier adapters"]
  Outbox --> Print["Enrolled print agent"]
  Outbox --> Accounting["Accounting adapter"]
  PG --> ReadModels["Operations read models and metrics"]
  Optimizer --> ORTools["OR-Tools implementation"]
```

The route handler authenticates and validates transport. The application service owns policy, transactions, state transitions, and idempotency. Persistence adapters own SQL. External adapters own protocol translation only.

## Bounded Contexts And Authority

| Context | Owns | References or publishes | Does not own |
| --- | --- | --- | --- |
| Order intake | Canonical order snapshot, source identifiers, validation, holds, edits, cancellations | CRM customer/product IDs, contract version, `order.*` events | CRM customer master, provider order record |
| Inventory | Pools, eligibility, physical positions, reservations, immutable ledger, reconciled balances | CRM product and inventory-owner IDs, `inventory.*` events | Product master, provider inventory counter |
| Promise and fulfillment | Promise explanation, candidate plans, selected plan, allocations, overrides, estimated variance | Inventory, facilities, package/rate snapshots, contract policies | Inventory ledger, carrier transaction, or carrier-billed actual |
| Warehouse execution | Waves, pick tasks, scans, short-pick decisions, packs, station work | Plans, locations, Tasks for exception work | Generic project/task lifecycle |
| Shipping | Carrier rates, package facts, label attempts, labels, print jobs, shipments, tracking observations | Carrier account, documents, `shipment.*` events | Carrier account master or printer transport |
| Contracts and 3PL billing | Native contract versions, pricing directives, estimated/accrued/final billable facts, credits | CRM customer, operational source, accounting export | CRM customer master, accounting ledger, invoice provider |
| Exceptions | Operations exception status, severity, source, recommendation, resolution evidence | Projects task link and future Case link | Project task or CRM Case data |
| Integration control | Operations account metadata, capability/version, external IDs, cursors, receipts, attempts, health | Secret reference and adapter outbox | Plaintext credentials |
| Reporting | Tenant-scoped order, inventory, service, estimated and realized cost/margin, and exception projections | Immutable estimate and approved billing facts plus versioned snapshots | Source-of-truth mutations |

## Identity, Units, And Time

- Every aggregate and externally referenced child receives one immutable Global ID from the shared registry. `0081` proposes `gor`, `gol`, `gwh`, `gwl`, `gip`, `giv`, `gld`, `grs`, `gct`, `gcv`, `gpd`, `gfp`, `gfa`, `gcp`, `grt`, `gwv`, `gpk`, `gpa`, `glb`, `gsh`, `gpr`, `gpj`, `gbe`, `gia`, `gpm`, `gex`, `gev`, and `grl`.
- Later print and shipment-completion migrations add permanent identities for print agents/artifacts and `gto` tracking observations plus `gfe` commerce-fulfillment exports. A tracking number or provider fulfillment ID remains an alias, never the aggregate identity.
- Quote, return, inventory unit/LPN, lot, serial, receipt, manifest, and any separate fulfillment-order identities must be allocated before those aggregates ship.
- Cross-module payloads carry Global IDs. Database relationships also carry tenant-scoped UUID foreign keys for integrity.
- Money uses integer minor units plus ISO 4217 currency. Percentage and quantity calculations use PostgreSQL `numeric`; binary floating point is forbidden for authoritative results.
- An organization currency preference is a default for new ClawPilot-entered Product money, not an exchange-rate engine. Source and record currency always win; the application never converts, relabels, or aggregates mixed currencies under the preference.
- Weight, dimensions, volume, quantity, and UOM are explicit. Product, package, and shipment dimensions remain canonical integer millimeters and their weights remain canonical integer grams; existing warehouse-capacity volume and weight remain cubic meters and kilograms. Metric or imperial preference changes presentation and entry conversion only and never rewrites canonical facts. User-editable fields and corrective copy must use the effective preference or unit-neutral wording. Canonical optimizer facts and provider/printer source evidence may retain their native units only when clearly labeled as evidence; provider/source unit and conversion provenance remain independent evidence and do not choose a viewer's display system.
- Canonical timestamps are UTC. Warehouse calendars, cutoffs, and display calculations name an IANA facility timezone.
- Address, product, contract, inventory, carton, rate, and rule inputs used for a promise or charge are versioned snapshots; later master-data edits do not rewrite history.

## Logical Entity Relationship Model

This diagram shows the foundation relationship model. The [gap map](../maps/distributed-operations-integration-gap-map.md) names target entities that are not present in `0081`.

```mermaid
erDiagram
  WORKSPACE_ORGANIZATION ||--o{ PIPELINE_SPACE : owns
  PIPELINE_SPACE ||--o{ CRM_CUSTOMER : projects
  PIPELINE_SPACE ||--o{ CRM_PRODUCT : catalogs
  WORKSPACE_ORGANIZATION ||--o{ INTEGRATION_ACCOUNT : configures
  WORKSPACE_ORGANIZATION ||--o{ WAREHOUSE : operates
  WAREHOUSE ||--o{ LOCATION : contains
  WAREHOUSE ||--o{ PRINTER : contains

  WORKSPACE_ORGANIZATION ||--o{ INVENTORY_POOL : owns
  INVENTORY_POOL ||--o{ POOL_CUSTOMER : authorizes
  CRM_CUSTOMER ||--o{ POOL_CUSTOMER : consumes
  INVENTORY_POOL ||--o{ INVENTORY_POSITION : groups
  WAREHOUSE ||--o{ INVENTORY_POSITION : holds
  LOCATION ||--o{ INVENTORY_POSITION : locates
  CRM_PRODUCT ||--o{ INVENTORY_POSITION : identifies
  INVENTORY_POSITION ||--o{ INVENTORY_LEDGER : explains

  CRM_CUSTOMER ||--o{ CONTRACT : signs
  CONTRACT ||--|{ CONTRACT_VERSION : versions
  CONTRACT_VERSION ||--o{ PRICING_DIRECTIVE : prices

  INTEGRATION_ACCOUNT ||--o{ PRODUCT_MAPPING : maps
  CRM_PRODUCT ||--o{ PRODUCT_MAPPING : resolves
  INTEGRATION_ACCOUNT ||--o{ ORDER : imports
  CRM_CUSTOMER ||--o{ ORDER : places
  CONTRACT_VERSION ||--o{ ORDER : governs
  ORDER ||--|{ ORDER_LINE : contains
  CRM_PRODUCT ||--o{ ORDER_LINE : identifies
  ORDER_LINE ||--o{ RESERVATION : reserves
  INVENTORY_POSITION ||--o{ RESERVATION : supplies

  ORDER ||--o{ FULFILLMENT_PLAN : plans
  WAREHOUSE ||--o{ FULFILLMENT_PLAN : anchors
  FULFILLMENT_PLAN ||--o{ FULFILLMENT_ALLOCATION : allocates
  RESERVATION ||--o{ FULFILLMENT_ALLOCATION : backs
  FULFILLMENT_PLAN ||--|| CARTON_PLAN : cartonizes
  FULFILLMENT_PLAN ||--o{ CARRIER_RATE : rates
  FULFILLMENT_PLAN ||--o{ PICK_TASK : executes
  WAVE ||--o{ PICK_TASK : groups
  FULFILLMENT_PLAN ||--o{ PACKAGE : packs
  PACKAGE ||--o{ LABEL : labels
  CARRIER_RATE ||--o{ LABEL : purchases
  LABEL ||--o{ PRINT_JOB : prints
  PRINTER ||--o{ PRINT_JOB : receives
  PACKAGE ||--o| SHIPMENT : ships
  ORDER ||--o{ SHIPMENT : fulfills

  ORDER ||--o{ BILLABLE_EVENT : charges
  CONTRACT_VERSION ||--o{ BILLABLE_EVENT : calculates
  PRICING_DIRECTIVE ||--o{ BILLABLE_EVENT : explains
  ORDER ||--o{ OPERATIONS_EXCEPTION : raises
  WORKSPACE_ORGANIZATION ||--o{ DOMAIN_EVENT : records
  INTEGRATION_ACCOUNT ||--o{ EXTERNAL_IDENTIFIER : resolves
```

Every entity with a Global ID also references the shared Global ID registry. `organization_id` is required on every tenant-owned table even when another relationship implies it. Composite foreign keys prevent a child row from crossing organizations.

## Aggregate Invariants

| Aggregate | Transaction boundary | Required invariant |
| --- | --- | --- |
| Order | Order, lines, source receipt, external IDs, first event | One canonical order per organization, integration account, and provider order ID. Lines resolve to authorized CRM products before reservation. |
| Inventory position | Position, reservation, ledger row, event | `available = on_hand - reserved - damaged - quarantine - other unavailable`; no committed mutation may make any protected bucket negative. |
| Contract version | Version, directives, approval evidence | Published terms are immutable, effective ranges do not overlap for the same scope/precedence, and historical facts retain the exact version. |
| Fulfillment plan | Input snapshot, candidates, selected plan, allocations, promise, explanation | Every allocation is backed by an active reservation; selected plans satisfy hard constraints unless an explicit authorized exception records the violation. |
| Package and label | Package version, rate snapshot, provider attempt, label | One idempotent purchase result per package version and carrier account. A package change invalidates the selected rate and unshipped label. |
| Shipment | Shipment, package/label links, inventory consume/ship ledger, event, outbox | Confirmation happens once, only for packed/labeled packages, and atomically consumes the reserved inventory represented by the plan. |
| Billable fact | Operational source, contract version, directive, calculation snapshot | The same source/directive/charge kind emits at most one fact. Correction uses credit/rebill facts, never mutation. |

## Order State Machine

The foundation order statuses are the first-slice vocabulary. Holds and exceptions are explicit states with reason and prior-state evidence. A transition command must validate the current `row_version`, actor permission, required children, and idempotency receipt.

```mermaid
stateDiagram-v2
  [*] --> imported
  imported --> validated: validate
  imported --> held: validation or policy hold
  validated --> promised: calculate promise
  validated --> held: apply hold
  promised --> reserved: reserve inventory
  promised --> held: apply hold
  reserved --> planned: select fulfillment plan
  reserved --> held: apply hold and release if policy requires
  planned --> released: release to warehouse
  planned --> held: apply hold
  released --> picking: start first pick
  picking --> packed: all required packages verified
  packed --> shipped: confirm all required shipments
  held --> validated: release before promise
  held --> promised: release after promise
  held --> reserved: release with valid reservation
  held --> planned: release with valid plan
  imported --> cancelled: cancel
  validated --> cancelled: cancel
  promised --> cancelled: cancel
  reserved --> cancelled: release reservation and cancel
  planned --> cancelled: cancel plan and reservation
  released --> exception: warehouse cancellation required
  picking --> exception: short pick or invalid execution
  packed --> exception: package or label failure
  exception --> held: contain and review
  exception --> planned: authorized replan
  exception --> picking: authorized warehouse recovery
  shipped --> [*]
  cancelled --> [*]
```

Order edits before release create a new order revision, invalidate affected promises/plans, and adjust reservations in one command. Edits after release require a warehouse exception workflow. Shipped quantity is never reversed by changing order status; returns use a separate aggregate.

## Inventory State Machine

Inventory is event-sourced by quantity segment, not by mutating a single unit status. The ledger is authoritative and positions are materialized balances. The full target vocabulary below exceeds `0081`, which currently projects only on-hand, reserved, and damaged quantities.

```mermaid
stateDiagram-v2
  [*] --> expected: purchase order or ASN
  expected --> receiving: physical receipt starts
  receiving --> quarantine: inspection required
  receiving --> available: accepted receipt
  quarantine --> available: approved release
  quarantine --> damaged: rejected or damaged
  available --> reserved: atomic reservation
  reserved --> available: release or expiry
  reserved --> allocated: plan selected
  allocated --> reserved: reallocation
  allocated --> picked: confirmed pick
  picked --> allocated: authorized unpick
  picked --> shipped: shipment confirmed
  available --> damaged: damage event
  reserved --> damaged: damage and shortage resolution
  damaged --> available: approved recovery
  shipped --> returned: return received
  returned --> quarantine: inspect return
  returned --> available: direct restock policy
  damaged --> [*]: approved disposal
```

Every transition writes balanced quantity deltas with before/after values, source Global ID, actor, reason, and idempotency key. Ownership, pool eligibility, lot/serial, expiration, UOM, facility, and location remain attached throughout movement. Borrowing or cross-allocation is a separate authorized ledger event with source owner, consumer, contract rule, approval, and charge.

## Fulfillment State Machine

A fulfillment plan is immutable by version after release. Re-optimization or manual override creates a later version with a link to the prior plan and a quantified financial effect.

```mermaid
stateDiagram-v2
  [*] --> planned: create candidate and select
  planned --> planned: replace with later plan version
  planned --> released: validate and release
  planned --> cancelled: cancel or supersede
  released --> fulfilled: all required shipments confirmed
  released --> cancelled: authorized pre-pick cancellation
  released --> planned: exception creates later plan version
  fulfilled --> [*]
  cancelled --> [*]
```

Wave state is `planned -> released -> in_progress -> completed`, with `cancelled` allowed before completion. Pick-task state is `ready -> in_progress -> picked`, with `short` and `cancelled` as explicit outcomes. A short pick never silently decrements the requested quantity; it triggers deterministic reallocation or an exception.

## Shipment State Machine

Package, label, print, and shipment states remain distinct. A print confirms document delivery to an enrolled agent; it does not confirm the parcel shipped.

The current sandbox label commands stop at label and print evidence. A sandbox `label.created` result is never a dock-handoff fact and cannot call shipment confirmation or inventory consumption. The automated deterministic mock proof retains its older test-only behavior: inside its isolated mock transaction it creates a mock shipment, consumes its mock reservation, and records a mock commerce result. That path is unavailable from the hosted workbench and is not production acceptance.

Migration `0099` defines the durable evidence bundle used by the local shipment-confirmation command. Its transaction creates shipment and inventory-consumption facts together with immutable packing-slip metadata and bytes, the first append-only `confirmed` tracking observation, and a `queued` commerce-fulfillment export intent. Carrier or commerce network I/O occurs only after commit. The ordinary command remains bounded to exactly one packed package with a non-sandbox label. Migration `0198` adds a separate exact, expiring, actor- and order-bound sandbox-commerce authorization. That authorization permits package-specific carrier sandbox labels and an atomic multi-package test completion that creates one shipment, tracking observation, and final packing slip per package while consuming inventory once; replay cannot consume the authorization twice. Its Shopify dispatcher requires separate current Active claims for `fulfillment_export` and `tracking_export`, a matching verified credential generation and store identity, and the merchant-managed fulfillment scope. It reconciles an existing matching tracking set before mutation, fails closed on pagination or multiple Shopify locations, and uses `fulfillmentCreate` only after shipment commit. Faire fulfillment is supported for verified production OAuth accounts: the dispatcher requires separate current Active `order_update`, `fulfillment_export`, and `tracking_export` claims plus exact package tracking and maker-cost evidence, moves a writable order to `PROCESSING`, adds its shipments, and reconciles provider readback, including read-only recovery from an unknown write outcome. These implementation contracts do not by themselves prove deployed execution for order `#6567`.

Migration `0121` makes physical package contents exact rather than implied. Every package allocation references one canonical order line with a positive quantity, the sum across the plan must equal that line's fulfillment quantity, and a package plan cannot silently omit or duplicate a unit. Before carrier label creation and tracking, an authorized operator can generate, download, or print an immutable package-specific **Pack Work Instruction** from those allocations. It is visibly provisional, uses template `pack-work-instruction-package-letter-v1`, and is not a final packing slip. Generation reuses matching content-addressed evidence, paginates all lines, and performs no carrier call or postage purchase. The legacy `packing_slip` artifact and print-agent identifier remains only as a compatibility transport value; no-shipment linkage plus the exact Work Instruction template and immutable render metadata define the current pre-label kind. Historical package-scoped artifacts without that template retain their original bytes and titles, are presented only as legacy pre-label packing lists, and can coexist with the warned Work Instruction. A final packing slip remains a separate tracking-bound document produced only from shipment evidence. The current general shipment confirmation path still supports only its explicitly verified single-package execution contract; exact multi-package allocation and work instructions do not by themselves activate multi-package carrier purchase or dispatch.

```mermaid
stateDiagram-v2
  [*] --> package_planned
  package_planned --> package_packed: verify contents, weight, dimensions
  package_packed --> package_planned: change package and re-rate
  package_packed --> label_created: idempotent label purchase
  label_created --> print_queued: apply printer route
  print_queued --> print_completed: agent acknowledgement
  print_queued --> print_failed: timeout or printer failure
  print_failed --> print_queued: approved retry or fallback route
  label_created --> label_voided: void before dispatch
  print_completed --> shipment_confirmed: dock handoff confirmation
  label_created --> shipment_confirmed: paperless approved flow
  shipment_confirmed --> in_transit: carrier acceptance or tracking
  shipment_confirmed --> shipment_exception: pickup or manifest failure
  in_transit --> delivered: carrier delivery event
  in_transit --> shipment_exception: carrier exception
  shipment_exception --> in_transit: carrier recovery
  label_voided --> [*]
  delivered --> [*]
```

A package edit before confirmation creates a new package version, voids or
supersedes any unshipped label through an idempotent carrier command,
re-cartonizes as needed, and records a new pre-label carrier estimate plus
signed estimated variance without changing the checkout shipping charge. It
does not create carrier-billed actual or MUD. A provider timeout produces an
unknown outcome until reconciliation proves whether a label exists; retrying
with the same provider idempotency key cannot purchase a second label.

## Event Contract

Domain events record business facts. Audit events record who invoked or observed a consequential action. Outbox rows deliver side effects. These are related but not interchangeable.

```json
{
  "eventGlobalId": "gev1234567",
  "eventType": "inventory.reserved",
  "eventVersion": 1,
  "organizationId": "internal-organization-uuid",
  "organizationGlobalId": "ga1234567",
  "aggregateType": "operations.reservation",
  "aggregateGlobalId": "grs1234567",
  "correlationId": "request-or-workflow-uuid",
  "causationEventGlobalId": "gev7654321",
  "occurredAt": "2026-07-22T12:00:00.000Z",
  "actor": { "type": "user", "globalId": "gu1234567" },
  "idempotencyKey": "reserve:gor1234567:revision-3",
  "payload": { "schema": "operations.inventory.reserved.v1" }
}
```

Event payloads use allowlisted, versioned schemas and Global IDs. They exclude credentials, full addresses, raw labels, unrestricted provider payloads, and unnecessary personal data. A consumer must reject an unsupported major version and deduplicate on event Global ID or the consumer-specific idempotency key.

| Event family | Required events | Primary consumers |
| --- | --- | --- |
| Order | `order.imported`, `order.validated`, `order.held`, `order.released`, `order.cancelled` | Workbench projection, exception policy, commerce export |
| Promise and inventory | `promise.calculated`, `inventory.reserved`, `inventory.reservation_failed`, `inventory.released`, `inventory.reconciled` | Availability projection, plan service, alerts |
| Allocation and plan | `allocation.completed`, `allocation.failed`, `fulfillment.plan_selected`, `fulfillment.plan_overridden` | Warehouse release, estimated cost variance, audit |
| Warehouse | `wave.created`, `wave.released`, `pick.started`, `pick.completed`, `pick.short` | Work queues, billable facts, exceptions |
| Package and shipping | `package.cartonized`, `package.repacked`, `shipment.rated`, `label.created`, `label.voided`, `shipment.dispatched`, `tracking.updated` | Print, carrier reconciliation, commerce export, customer view |
| Billing and exception | `billable_event.created`, `charge.calculated`, `invoice.ready`, `exception.created`, `exception.resolved`, `print_job.failed` | Billing projection, Tasks bridge, notifications, operations health |
| Returns, later phase | `return.authorized`, `return.received`, `return.inspected`, `return.disposed` | Inventory, billing, customer service |

Aggregate mutation, domain-event insert, audit insert, and required outbox insert must commit together. Publishing reads only committed rows. Event replay rebuilds read models but never repeats external actions without the target consumer's idempotency boundary.

## Security Boundaries

```mermaid
flowchart TD
  Browser["Browser session"] --> Session["Authenticated and effective user"]
  Session --> Membership["Active workspace membership"]
  Membership --> Permission["Operations permission"]
  Permission --> Resource["Customer, warehouse, order, or task scope"]
  Resource --> Command["Authorized command handler"]
  WorkerSecret["Scoped worker secret"] --> WorkerClaim["Tenant and job claim"]
  WorkerClaim --> Command
  Command --> Domain[("Tenant-scoped domain transaction")]
  Domain --> SecretRef["Credential reference"]
  SecretRef --> Adapter["Least-privilege adapter"]
  Optimizer["Optimizer service"] --> Result["Untrusted typed result"]
  Result --> Command
  PrintAgent["Enrolled local print agent"] --> PrintAck["Fenced job acknowledgement"]
  PrintAck --> Command
```

### Authorization Contract

The working-tree `viewOperations`, `manageOperations`, and `executeWarehouse` flags are bootstrap categories, not the final authorization contract. They still require route-level enforcement and tests. Server types and route guards must expose explicit capabilities for:

- viewing orders, inventory, costs, margin, contracts, charges, integrations, and audit;
- editing orders, applying/releasing holds, reserving/allocating inventory, and overriding ownership;
- releasing waves, confirming picks/packs/shipments, and making inventory adjustments;
- changing packages or services, voiding/reprinting labels, and managing printers;
- editing contracts/directives, approving billing adjustments, and exporting charges;
- managing provider accounts, webhook configuration, reconciliation, and replay.

An owner receives the full organization capability set. Administrators receive only explicitly delegated capabilities. Warehouse roles receive facility-scoped execution without contract, margin, credential, or tenant-administration access. Customer portal identities receive read access only to approved fields for their CRM customer and allowed subaccounts; tenant membership alone is insufficient.

### Service Boundaries

- Commerce webhooks authenticate by verified provider signature, resolve one integration account and organization, store a bounded receipt, and enqueue a command. A webhook never carries a ClawPilot user permission.
- Workers authenticate with a dedicated operations secret or service identity, claim only tenant-bound jobs, and use lease tokens for every completion update.
- The optimizer receives no database URL, provider credential, user session, or unrestricted address. Its output is validated like any external response.
- The local print agent uses enrollment and rotating credentials, can claim only approved printers/documents for its warehouse, and cannot buy or void labels.
- Secret stores retain ciphertext or provider connection IDs. `credential_reference` is opaque to clients and never appears in API, event, audit, or log payloads.

## Idempotency And Concurrency

Every consequential command accepts a caller-stable `Idempotency-Key`. The application derives a scoped key from organization, command type, aggregate Global ID, and client key. A command receipt stores request hash, actor, first response, status, and timestamps. Reusing a key with the same request returns the first result; reusing it with different input returns `409 IDEMPOTENCY_KEY_REUSED`.

| Operation | Primary deduplication boundary | Concurrency control |
| --- | --- | --- |
| Commerce webhook | integration account + provider event ID; fallback payload hash only when provider lacks an event ID | Unique receipt insert, then leased processing |
| Canonical order import | organization + integration account + external order ID | Unique order key and source-revision check |
| Order edit/transition | organization + command key | `row_version` compare-and-swap |
| Reservation | organization + order-line intent key | Position rows locked in stable Global ID order; conditional quantity update; one transaction with ledger and event |
| Reservation release/consume | reservation Global ID + command kind | Reservation row lock and legal-state transition |
| Plan selection/override | order Global ID + order revision + optimizer input hash | Order lock plus monotonic plan version |
| Label purchase | organization + package version + carrier account + purchase intent | Durable provider attempt and stable provider key; unknown outcomes reconcile before retry |
| Print job | organization + label/document version + route version | Leased claim with lock token; retry never creates a label |
| Shipment confirmation | package Global ID + package version | Shipment/package lock; unique package shipment; inventory consume in same transaction |
| Billable fact | source Global ID + contract version + directive + charge kind | Unique fact key; corrections are new credit/rebill facts |
| Outbox delivery | target system + target operation key | `FOR UPDATE SKIP LOCKED`, lease token, bounded retries, dead letter |

### Atomic Reservation Algorithm

1. Validate organization, customer, product, pool membership, ownership, status, lot/serial, expiry, contract, and channel eligibility outside no transaction assumptions; repeat mutable checks inside the transaction.
2. Insert or load the command receipt.
3. Lock candidate positions in ascending position Global ID order to avoid deadlocks.
4. Recompute available quantity from the locked rows. Never trust a pre-query availability number.
5. Conditionally increment reserved quantity and position version only when every resulting balance remains valid.
6. Insert reservation rows and matching append-only ledger entries with before/after balances.
7. Insert the domain event, audit event, and any required outbox intent.
8. Commit, then return the stored command result. On insufficient stock, commit a deduplicated failure fact or exception without changing inventory.

The operation must be tested with two independent database connections racing for the final unit. Exactly one may succeed and the ledger must reconcile to the materialized position afterward.

### Optimistic And Pessimistic Use

- Use optimistic `row_version` checks for human edits, order transitions, package revisions, and rule/contract drafts.
- Use row locks or one conditional SQL update for scarce inventory, one-time shipment confirmation, provider-attempt ownership, and work-queue claims.
- Acquire multiple locks in stable Global ID order. Keep provider/network calls outside database transactions.
- Persist a provider intent before the call and finalize it with the same lease token after the call. An ambiguous timeout enters `unknown`, not `failed`, until reconciliation.

## Optimizer Interface

The application depends on a transport-neutral port. OR-Tools is one implementation and a deterministic heuristic is another. Both receive the same immutable, versioned input and return the same result schema.

```ts
type OptimizationStatus = 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error'

interface FulfillmentOptimizer {
  optimize(
    input: FulfillmentOptimizationInput,
    options: { deadlineMs: number; maxCandidates: number },
  ): Promise<FulfillmentOptimizationResult>
}

interface FulfillmentOptimizationInput {
  schemaVersion: 1
  inputSnapshotGlobalId: string
  organizationGlobalId: string
  orderGlobalId: string
  orderRevision: number
  evaluatedAtUtc: string
  lines: ReadonlyArray<OrderLineRequirement>
  eligiblePositions: ReadonlyArray<InventoryCandidate>
  warehouses: ReadonlyArray<WarehouseCandidate>
  packageAndRateOptions: ReadonlyArray<RatedPackagePlan>
  hardConstraints: ReadonlyArray<VersionedConstraint>
  objectivePolicy: VersionedObjectivePolicy
  contractPolicy: VersionedContractPolicy
  splitPolicy: { allowed: boolean; maxWarehouses: number }
}

interface FulfillmentOptimizationResult {
  schemaVersion: 1
  status: OptimizationStatus
  method: 'or_tools' | 'deterministic_fallback'
  algorithmVersion: string
  inputHash: string
  durationMs: number
  selectedPlan: CandidatePlan | null
  candidates: ReadonlyArray<CandidatePlan>
  rejectedAlternatives: ReadonlyArray<RejectedPlan>
  fallbackReason: string | null
  explanation: ReadonlyArray<DecisionFact>
}
```

The input uses integer minor-unit costs, normalized integer measurements, stable Global IDs, explicit calendars/cutoffs, and versioned policy references. It is canonically serialized and hashed before invocation. The result must echo the hash. The application rejects unknown references, negative values, missing allocations, quantity imbalance, promise violations, and any constraint result inconsistent with the input.

The current repository includes a disabled-by-default Python 3.13 / Google OR-Tools `9.15.6755` CP-SAT service under `services/fulfillment-optimizer` plus a TypeScript adapter under the same transport-neutral boundary. The service has no database, provider credential, browser session, or domain-write authority. Its authenticated bounded v1 endpoint expands integer line quantities into exact units, constrains those units to eligible inventory positions, approved warehouses, and available carton slots, and proves three-dimensional non-overlap using allowed item rotations. It minimizes warehouse count, shipment/carton count, supplied estimated cost, unused volume, and then stable identifiers as separate lexicographic solves under one deadline. The adapter requires an explicit enable flag, HTTPS URL, bearer secret, and timeout; validates the canonical input-hash echo, every returned reference, position balance, line quantity, weight, volume, rotation, 3D placement, carton availability, split limit, cost, and stable plan totals; and invokes the existing deterministic single-warehouse fallback on service unavailability, timeout, or invalid output.

The input carries an explicit allowed-warehouse set. An organization snapshot containing one allowed warehouse can never produce a second facility or split plan. Generic multi-warehouse planning remains available only when the immutable snapshot names multiple eligible facilities and its split policy explicitly permits them. The strict development preview projects carton candidates only from active packaging materials joined to the selected active warehouse's available, positive on-hand packaging stock; drafts, unavailable stock, and zero-stock rows are ineligible. A future hosted planner must retain that rule. Cartons, inventory, historical demand, and carrier-derived costs must be supplied as versioned facts; neither implementation invents them.

Packaging-material assortment selection is a separate authenticated v1 operation. It accepts only operator-supplied candidate boxes/poly mailers, versioned historical demand frequency, and precomputed feasible landed-cost/waste edges. Hard coverage is the default, while any lower coverage threshold and maximum material-SKU count must be explicit. It lexicographically minimizes frequency-weighted landed cost, active material count, weighted waste, and stable identifiers. This operation is a design aid for maintaining a manageable warehouse material catalog; it does not cartonize an order, call a carrier, activate a material, or write a catalog.

The OR-Tools service itself has a Railway development deployment and health evidence. The separately gated Shopify cartonization preview still requires OR-Tools and remains an in-memory, zero-write diagnostic. Migration `0176` adds a different boundary: it does not invoke the optimizer, but can accept one previously sealed `operational` cartonization/rate evidence aggregate for a promoted order and persist its exact single-warehouse plan, package allocations, package contents, and whole-shipment carrier-rate choice. That operator acceptance is not production optimizer activation, multi-warehouse planning, packing-list execution, transport purchase, or shipment confirmation. Migration `0180` supplies append-only production execution-time rerate and selection authority for an exact Active package set. The authenticated Operations `execute-production-rerate` command creates the read-only carrier network evidence through one bounded UPS/FedEx whole-shipment request after the prepared attempt is committed; `select-production-rerate-offer` then records one manual, immutable, unexpired local selection for the complete package set without another network call. Hosted activation still requires durable optimizer invocation/recovery observability and the downstream provider-authoritative release and picking, rerate recovery/reconciliation, operator selection UI or policy-based auto-selection, label and shipment dispatch/finalization, package documents, tracking, inventory consumption, and fulfillment-export gates.

The development/shadow evidence workflow now exposes two distinct actions. The
preferred operational-facts action accepts no operator parcel, inventory, or
minimum assumptions: every selected material must be active, positively
stocked at the selected active warehouse, and carry current
customer-confirmed, measured, or provider-rated exterior dimensions plus tare.
For a Shopify order, the read-only preflight uses the latest provider committed
quantity without attributing it to the order; the later transactional Plan
command remains the authority that locks an exact provider commitment and
prevents double claims. Other supported provider reads use projected
operational availability. This action still calls only sandbox carrier
accounts, records
`planSnapshot.carrierReadEnvironment = "sandbox"`, and is therefore acceptable
only as development/shadow evidence. Active acceptance must fail closed on that
marker. The separate assumption-backed sandbox action remains visibly
watermarked and cannot satisfy operational Plan acceptance.

### Objective Contract

Hard constraints are filters, not weighted preferences. Feasible plans are ranked lexicographically in this order unless a versioned policy explicitly changes a lower-priority item:

1. Meets the customer delivery promise.
2. Violates no inventory, ownership, contract, carrier, warehouse, handling, or regulatory hard constraint.
3. Minimizes warehouse count, preferring one warehouse whenever feasible.
4. Minimizes shipment and carton count.
5. Minimizes total fulfillment cost in minor units.
6. Maximizes projected contribution margin in minor units using only the
   immutable checkout charge and supplied carrier-cost estimate.
7. Balances versioned capacity utilization.
8. Applies inventory aging and customer preferences.
9. Breaks any remaining tie by warehouse Global ID, carrier/service code, position Global ID, and package-plan Global ID.

Projected margin can never compensate for a missed promise or hard-constraint
violation, and it is not carrier-billed actual or MUD. An authorized manual
exception creates a new plan version with actor, reason, previous and new
plans, violated constraint, estimated financial effect, and audit/event
evidence.

## Deterministic Fallback

The fallback is a pure, versioned function. The same canonical input and fallback version must produce the same output on every replay.

1. Reject positions, warehouses, package plans, and services that violate any hard constraint.
2. Build complete single-warehouse candidates that cover every line from eligible reserved/available inventory.
3. For each candidate, use the lowest-cost package and carrier service that meets the promise. Rank candidates by the objective tuple above and select the first.
4. If no single warehouse is feasible and split fulfillment is forbidden, return `infeasible` with explicit rejected constraints and create the configured exception.
5. If split fulfillment is explicitly allowed, sort order lines by fewest eligible warehouses, then product Global ID and line Global ID. Assign each line to the feasible warehouse that adds the least promise-safe cost, preferring a warehouse already used; break ties by warehouse Global ID. Stop if the plan exceeds `maxWarehouses`.
6. Re-cartonize and re-rate the complete proposed split. Reject it if any shipment misses the promise or violates a hard constraint.
7. Return `feasible` with `method=deterministic_fallback`, algorithm version,
   solver timeout/error reason, input hash, selected plan, estimated costs,
   checkout revenue, projected margin, constraint evidence, and rejected
   alternatives.

Fallback must not use current time, random values, unordered map iteration, provider calls, or database reads that are absent from the input snapshot. Missing required dimensions follows a versioned conservative package profile or returns manual review; it never silently invents a favorable estimate.

## External Adapter Contracts

Carrier billing accounts are organization-scoped operational identities. Each active account stores a required sender name with its registered address and supported payer roles. Rating and label adapters must obtain the shipper name and origin address from the selected account snapshot; they must not infer sender identity from a credential display name, account number, signed-in user, warehouse label, or hard-coded fixture. The immutable provider-attempt evidence records the selected account identity and safe sender metadata without exposing credential material. For the bounded AG Railway-development delegation, the guarded establishment command materializes the AG warehouse `gwh5366613` sender identity and address into the fresh AG account snapshot before runtime; the rate and optional sandbox-label diagnostic adapters still read only that target snapshot and never fall back to EPISCS or accept a browser origin override. The default profile cannot authorize labels, and the separately confirmed diagnostic profile can authorize only provider-sandbox test labels plus their exact stored download/print/void or local-sample-close lifecycle. Neither profile authorizes production execution; both must be replaced by an explicit delegated-authority, payer, and ship-from model before production.

### Commerce Provider

Each adapter declares versioned provider availability separately from ClawPilot implementation and activation state: authentication, webhook verification/registration, product and inventory sync, order/cancellation/refund import, checkout rates, fulfillment/tracking export, returns, cursors, and reconciliation. Scope metadata must distinguish requested, granted, missing, restricted, and provider-unverifiable access. A provider-supported capability is never evidence that its ClawPilot command or worker exists.

The adapter translates a verified provider message into a canonical command and translates an authorized outbox intent into a provider request. A shipment commit creates an immutable export identity and payload in `queued`; a worker may advance it through `processing` to `succeeded`, `failed`, or `unsupported` without rewriting its shipment, provider, external order, payload, idempotency key, or request time. `failed` may return to the retry lifecycle through an approved command, while `succeeded` and `unsupported` are immutable terminal outcomes.

Shopify and Faire are the first named control-plane targets. BigCommerce and Etsy remain planned adapter targets, not implemented connections. Shopify uses versioned Admin GraphQL and Fulfillment Orders; Faire is a B2B wholesale marketplace with production polling and a narrower public brand API. Mocks, local fixtures, a Shopify development store, or a successful Faire profile probe do not count as production domain verification.

### Carrier Provider

Each adapter declares accounts, services, negotiated/published rates, transit estimates, address validation, labels, voids, tracking, manifests, pickups, customs, proof of delivery, idempotency, and reconciliation capabilities. USPS, UPS, and FedEx are initial direct targets. RocketShipIt is an optional aggregator behind the same canonical boundary, not a replacement shipment master. Calls use controlled parallelism, per-provider timeout and circuit-breaker policy, bounded response storage, exact account/service snapshots, canonical millimeters/grams, and exact money conversion. The [small parcel carrier adapter architecture](../architecture/small-parcel-carrier-adapters.md) defines provider boundaries, side-effect safety, secret handling, and certification gates.

### Printer Gateway

The gateway accepts a durable document reference and route, not a carrier purchase request. It exposes printer capability/health, leased job claim, print acknowledgement, bounded retry, and approved fallback. Shipping-label claims retain their original UTF-8 payload and declare `encoding=utf8`; immutable binary packing-slip payloads are base64 encoded and declare `encoding=base64`. Reprints are separate auditable commands with permission and reason.

### Accounting Export

The adapter reads approved immutable billable facts and credits, produces a versioned export, and stores the provider reference. It does not recalculate the contract, merge tenants, infer customers, or make an unapproved external write.

## API And Command Boundary

- Browser and partner APIs are versioned under `/api/operations/v1` and use Global IDs in resource paths and payloads.
- Commands require `Idempotency-Key`, reject unsupported fields, cap request size, return stable machine error codes, and use `Cache-Control: no-store`.
- Queries return only the active workspace and authorized customer/facility scope. Cost and margin fields require separate permissions.
- The current internal `GET /api/operations/artifacts/{gpf}` route requires an authenticated user with Operations view access, resolves only the active organization, verifies PDF length and SHA-256, and returns immutable raw PDF bytes with a safe attachment filename. It does not expose a cross-tenant object-store URL.
- Public commerce webhooks use provider-specific signature authentication and never share browser-session routes.
- Checkout quote requests use a separate bounded contract with expiration, caller identity, rate limits, and an immutable quote snapshot.
- Bulk exports are asynchronous jobs; they do not hold request transactions open.
- Scanner commands support client operation IDs and ordered offline replay. Server state and permission are revalidated on reconnect.

## Required Observability And Reconciliation

- Migration and operations feature activation state appear in `/api/health`.
- Queue health exposes pending, failed, dead, stale-processing, oldest due age, throughput, and last success by target.
- Adapter health exposes verified account, environment, capability version, webhook/reconciliation cursor, last success, safe error code, and circuit state.
- Metrics cover import latency/deduplication, reservation conflicts, ledger
  drift, promise attainment, optimizer duration/fallback, split rate, pick/pack
  performance, carrier/label outcomes, printer failures, shipment exceptions,
  unbilled facts, checkout-to-estimate variance, and, only after exact approved
  carrier billing, checkout-to-carrier-actual and
  checkout-to-contract-bill variance.
- A scheduled ledger reconciliation compares every materialized bucket to immutable ledger deltas. Any nonzero drift is critical, freezes affected inventory commands, and follows the [runbook](../operations/distributed-operations-runbook.md).
- Commerce, carrier, tracking, print, and accounting reconciliation detect missed or ambiguous external outcomes without blindly repeating side effects.
- Shipment-completion reconciliation compares each confirmed shipment with its inventory-consumption evidence, packing-slip artifact and payload, first `confirmed` tracking observation, and commerce export state. Missing `0099` evidence is expected for the legacy mock path and for sandbox labels because neither uses the production completion bundle.
- Logs use correlation IDs, Global IDs, safe error codes, adapter version, and duration. They exclude credentials, label payloads, full addresses, and unrestricted provider bodies.

## Foundation Limitations

Before this contract can become active, implementation must close the blockers in the [integration and gap map](../maps/distributed-operations-integration-gap-map.md), especially fine-grained permissions, canonical commerce receipt/poll processing, leased reconciliation and replay commands, tracking ingestion, commerce-export dispatch, queue/throughput health, quote and optimizer snapshots, multi-warehouse split-plan representation, advanced inventory dimensions, billable lifecycle separation, and shared-service adapters. `0111` and `0112` close bounded credential, OAuth-staging, signed-receipt, cursor, and evidence-schema portions. `0113` adds only a disposable Shopify diagnostic preview. `0114` and `0115` close the bounded manager-driven catalog-mapping and operational-order workflow through durable pre-call read intent, resource-scoped pagination, row-versioned rejection disposition, explicit resolution, exact Faire order refresh, canonical-money reconciliation, and promotion. `0124` adds the bounded development Shopify location mapping, provider capture, all-state inventory evidence, and source-authority projection described above; `0169`, `0171`, and `0172` add only its single-account, single-location, read-only automatic freshness worker and recovery/health fences. `0176` accepts one exact promoted order into a single-warehouse `planned` state and preserves the bounded Shadow-local provider-commitment lifecycle through release, pick, and consumption. Migrations `0177`, `0179`, and `0180` then preserve the Shadow execution estimate, derive the exact Active package set, and add append-only production rerate attempts, terminal outcomes, offers, selection, and dispatch authority without rewriting that estimate. The authenticated Operations commands now close the narrow read-only UPS/FedEx token/network rerate producer and manual local one-service whole-shipment selection for one exact Active package set, but they do not production-activate the lifecycle: rerate recovery/reconciliation, operator selection UI or policy-based auto-selection, shipment-label dispatch/finalization, package tracking, final packing slips, inventory consumption, commerce fulfillment, and Shopify/Faire writeback remain later. `0125` adds only the tenant-safe organization/user preference store, optimistic organization-default command, pure conversion/formatting boundary, and application provider; it does not convert stored domain facts or claim every Operations surface has completed its display migration. `0127` adds the organization ISO 4217 default, guarded update and SuiteCRM Product currency projection; it does not invent exchange rates, convert existing amounts, assign currency to currency-less historical records, or change provider-owned money. These migrations do not close historical import, continuous multi-location or production provider inventory synchronization, unattended receipt/poll processing beyond the explicitly named development catalog, order-staging, and inventory workers, Faire inventory reconciliation, provider inventory writes, returns or full fulfillment-order coverage, general recurring reconciliation and recovery operations, or production activation.

Migration `0126` changes no measurement fact and does not activate any starter
material; it only removes an imperial-only label from untouched starter rows.

## Connected Notes

- [Distributed Operations Integration and Gap Map](../maps/distributed-operations-integration-gap-map.md)
- [Distributed Operations Delivery, Migration, and Test Plan](../architecture/distributed-operations-delivery-plan.md)
- [Distributed Operations Runbook](../operations/distributed-operations-runbook.md)
- [Printing, Carrier Billing, And GL Coding](../operations/printing-carrier-billing-and-gl-coding.md)
- [Native Distributed Operations Authority and Adapter Boundaries](../decisions/0006-native-distributed-operations-authority.md)
- [CRM and Workbook Reporting](crm-and-reporting.md)
- [Projects and Tenancy](projects-and-tenancy.md)
- [Application Shell and Access](application-shell-and-access.md)
- [User Integrations and Credentials](user-integrations.md)
