---
id: cp-architecture-brokered-parcel-and-ltl-carrier-adapters
title: Brokered Parcel And LTL Carrier Adapters
summary: ClawPilot contract for Worldwide Express parcel and brokered LTL, direct R+L freight, pallet handling units, tender safety, and parcel-versus-LTL comparison.
status: draft
kind: architecture
area: distributed-operations
tags: [clawpilot, shipping, worldwide-express, unishippers, ups, ltl, freight, rl-carriers, palletization]
app_visible: false
---

# Brokered Parcel And LTL Carrier Adapters

## Decision

ClawPilot models the API provider, transport mode, executing carrier, provider
account, and physical handling-unit plan independently.

| Requested lane | Provider | Transport mode | Executing carrier |
| --- | --- | --- | --- |
| Worldwide Express Small Parcel | `wwex_speedship` | `small_parcel` | UPS |
| Worldwide Express LTL | `wwex_speedship` | `ltl` | The carrier and SCAC returned on the selected WWEX offer |
| R+L LTL | `rl_carriers` | `ltl` | R+L Carriers |

Worldwide Express is a broker/provider. Its identity must not replace the
carrier that physically executes a shipment. A WWEX LTL quote can contain
several offers whose service labels overlap, so an offer identity includes the
provider, executing-carrier vendor ID, SCAC, provider service code, offer ID,
and exact handling-unit-plan hash. A WWEX Small Parcel offer is normalized as
UPS execution even though authorization, rating, tender, and billing flow
through WWEX.

## Current Scope And Activation Status

The working-tree implementation is an additive rate-activation and
tender-safety foundation:

- pure request preparation and response normalization for WWEX Small Parcel
  and LTL and current R+L LTL contracts;
- versioned loose-package and palletized-handling-unit plans;
- queryable provider, mode, and executing-carrier identity on immutable offers;
- a freight-specific durable tender/document boundary that does not fabricate
  parcel labels;
- organization- and environment-bound encrypted credential shapes for WWEX
  OAuth client credentials and the R+L API key;
- bounded fixed-endpoint clients for the reviewed WWEX sandbox and public R+L
  production contracts, with no automatic mutation retries;
- explicit, permission-gated read-only credential verification: WWEX sandbox
  OAuth token acquisition and R+L production `GET /ServicePoint`;
- independent rate-only activation that grants only the selected
  `small_parcel_rate` and/or `ltl_rate` capability and leaves every pickup,
  BOL, label, and tender flag disabled;
- no automatic credential import from the supplied Postman, environment, or
  Word exports and no carrier call during migration or automated tests.

This slice does not claim a certified production connection. WWEX production
hosts and audience must come from the provider after its platform review. R+L
has not supplied a sandbox base URL. Credential lifecycle and replacement
remain operator decisions; ClawPilot stores the selected values encrypted and
never returns them through the integration API. Credential storage uses a
server-keyed request hash and a durable Operations command receipt, so an exact
retry cannot increment the credential revision or deactivate an already active
rate connection a second time. Tender activation remains disabled until the
provider-specific gates below pass.

The production app and database must first be released through migrations
`0270` and `0271` before a connection can be persisted or activated there.
Successful direct connectivity checks outside that released state do not
constitute a deployed ClawPilot activation.

The current one-off route and execution panel still call only the direct
UPS/FedEx parcel services. They do not yet call these WWEX/R+L clients, persist
the new handling plans, or expose freight tender state. Consequently none of
the three new lanes is an operator-executable shipment path in this slice.

For brokered transport, the integration account is the provider-account
identity. It is not forced into the legacy direct-carrier billing-account row,
which requires a separately encrypted account number and registered address.
The WWEX bill-to account used at tender remains a separate activation input and
is retained only through a server-keyed, organization/environment-bound HMAC;
the raw account exists only in the ephemeral provider request.

## Physical Planning Contract

Cartonization produces physical cartons and poly bags before transport mode is
selected. The same order-line quantity may then be evaluated through two
different immutable alternatives:

```text
order lines
  -> cartons and poly bags
     -> parcel: loose packages tendered individually through WWEX/UPS
     -> LTL: cartons assigned to versioned outbound pallets
```

An LTL pallet plan records:

- pallet/load-unit key and packaging type;
- outer length, width, and height;
- tare weight and gross weight, including the pallet, with gross weight equal
  to pallet tare plus the member package gross weights;
- ordered carton membership and quantity conservation; poly bags remain
  eligible only for the loose Small Parcel alternative;
- stackability and mixed-commodity state;
- per-commodity freight class and its source, optional NMFC item/subitem, and
  description.

The immutable carrier-rate request, rather than the physical pallet plan,
separately binds origin/destination, pickup window, accessorials, payer facts,
hazardous-material declaration, and declared value. The first activation must
remain domestic USD and non-hazardous, with no declared-value service, until
those operator inputs and provider-specific evidence are wired into the
one-off UI and persistence service.

Product pack profiles whose package level is `pallet` describe product or
inventory identity; they are not outbound palletization evidence. Outbound
load units are separately versioned shipment facts. Parcel offers bind the
loose-package-plan hash. LTL offers bind both the carton plan and pallet plan
hash. A rate cannot be reused after any bound dimensions, membership, weight,
freight class, accessorial, address, or pickup-window fact changes.

Automated palletization may be added after the manual/versioned contract is
proven. It must account for pallet tare, maximum height/weight, support and
overhang, stackability, crush/rotation rules, mixed commodities, hazmat
segregation, and operator-approved freight class. The carrier APIs do not
replace that optimization.

## Freight Classification

Freight classification policy belongs to the exact LTL provider account; a
connection must not impose one static freight class on every shipment. An
account may authorize the full density scale, require an independently
verified NMFC item/subitem, or require operator review for commodities that do
not qualify for density classification. The selected policy and its revision
are immutable inputs to the rate request.

For an account that authorizes density classification, ClawPilot derives the
candidate class only after cartonization and palletization are complete. The
calculation uses the exact as-rated pallet's outside dimensions and gross
weight, including pallet tare and every assigned carton. Changing the pallet
configuration, contents, dimensions, weight, account, or account policy
invalidates the classification and the quote. Mixed-commodity or otherwise
ineligible pallets remain blocked from the density path instead of inheriting
an account default.

ClawPilot includes a dependency-free density assessment at
`app_src/lib/operations/freightClassification.ts`. It implements the public
NMFTA 13-subprovision full-density scale against an exact as-tendered pallet's
greatest outside dimensions and gross weight, including pallet tare. Band
selection uses full-precision density; rounded volume and pounds per cubic foot
are evidence display values.

The result is deliberately a candidate, not a general NMFC classification or
commodity lookup. It cannot authorize an LTL rate unless an operator confirms
all of the following:

- the commodity is governed by the full density scale;
- the pallet contains one commodity classification;
- no unusual handling, stowability, or liability characteristic applies;
- the classification source or rule is recorded; and
- any NMFC item/subitem entered was independently verified.

Migration `0271` stores that confirmation as immutable `gfca` evidence under a
stable idempotency key. A `density_calculation` commodity can reference it only
when organization, pallet dimensions, gross weight, class, NMFC value, and the
entire evidence object match. Mixed-commodity pallets and unresolved handling,
stowability, or liability characteristics remain advisory and cannot become
tender evidence through this path.

The one-off shipment dialog exposes the assessment now so operators can prove
the evidence contract. It does not yet build the pallet or include an LTL offer
in the parcel quote. The next application slice must bind the saved assessment
to a versioned outbound pallet, then fan that exact plan out to WWEX LTL and
R+L while retaining the same cartons as loose Small Parcel packages.

FreightClassPro was reviewed as a reference implementation, not imported as a
runtime dependency. It is a browser calculator with no carrier/NMFC API and no
authoritative item/subitem data. ClawPilot therefore does not copy its commodity
list, pallet optimizer, UI, assets, or dependency graph. A future ClassIT+ API
adapter requires an NMFTA license that expressly permits ClawPilot's customer
and SaaS use before any licensed data is cached, displayed, or redistributed.

## Canonical Offer

Every retained offer contains at least:

```text
provider
provider account and credential revision
transport mode
executing carrier vendor code and name; SCAC when the provider returns one
provider service code and service name
provider quote/offer/product-transaction references
amount, currency, accessorial breakdown, and billed-rate kind
transit estimate and provider expiration when the provider supplies them
loose-package or pallet-plan hash
sanitized request/response hashes and adapter version
```

The original quote, tender-authorized amount, provider-returned tender charge,
and later carrier invoice actual remain separate amounts. Selection does not
rewrite an offer, and a later invoice difference does not rewrite the quote.

## Worldwide Express Flow

### Authentication and hosts

The supplied v1.9b sandbox collection uses OAuth client credentials at the
fixed WWEX staging authorization host and calls SpeedShip staging flows with a
bearer token. The collection and guide disagree on token-body encoding; the
collection's form-encoded request is the sandbox test target. Production hosts
and audience are not inferred from staging; production execution remains
disabled until the provider-issued values pass platform review and are installed.

### Small Parcel

1. Optionally validate addresses.
2. Call `shopFlow` with `productType=SMALLPACK` and the exact loose packages.
3. Retain the selected `offerId`, `productTransactionId`, UPS execution
   identity, rate, transit, expiration, and package-plan hash.
4. For international shipments, complete the required forms flow before
   tender; the initial ClawPilot slice remains domestic U.S./USD.
5. Call `schedulePickupFlow` with the exact shipment product-transaction IDs,
   retain the selected pickup offer/product identities, and keep its charge
   separate from the shipment rate.
6. Tender through `integratedOrderFlow` using the exact selected shipment and
   pickup transaction identities. Both offers must still be unexpired.
7. The activation implementation must store UPS tracking and WWEX
   order/transaction identifiers independently and materialize WWEX documents
   without logging their bytes. That persistence/retrieval path is not wired in
   this slice.

Loose customer-owned cartons and poly bags use the reviewed custom-package
mapping. UPS-supplied packaging codes are never inferred from a ClawPilot poly
bag. The provider must confirm the final package-code mapping during sandbox
certification.

### LTL

1. Call `shopFlow` with `productType=LTL` and the exact pallet handling units,
   commodity facts, accessorials, addresses, and pickup window.
2. Normalize each offer with its `primaryVendor.vendorId`, carrier name, SCAC,
   `offerId`, product/transaction IDs, rate, transit, and expiration.
3. Tender the selected immutable offer through `quoteOrderFlow`; this is a
   provider mutation even though its name includes “quote.”
4. Retain WWEX order/transaction identity, carrier quote number, BOL,
   executing carrier/SCAC, PRO when available, and pickup transaction.
5. Store BOL, quote, packing-list, and pallet-label documents as sensitive
   immutable artifacts. Track by the provider-supported BOL, PRO, or tracking
   identity plus SCAC.

The supplied integrated-cancel example contains conflicting fields. WWEX LTL
or Small Parcel cancellation stays unsupported until WWEX supplies a corrected
request and the sandbox proves its reconciliation semantics.

## R+L Flow

The R+L adapter follows the current public Swagger and API updates where the
supplied Postman examples are older.

1. `POST /RateQuote` with origin, destination, class-rated items or eligible
   pallet-rate data, current accessorial names, and pickup date.
2. Normalize each service's `NetCharge` as its total net amount and retain its
   quote number, service code/name, service days, direct-service indicator, and
   charge breakdown.
3. Treat a special R+L pallet tariff as proven only when the response contains
   a charge whose type is `PALLET`. R+L may silently fall back to an ordinary
   class rate when pallet input is invalid or ineligible; that result remains
   a normal class-rated LTL offer.
4. `POST /BillOfLading` with `HandlingUnits`, never both `HandlingUnits` and
   top-level `Items`. Bind `ReferenceNumbers.RateQuoteNumber` to the selected
   quote and optionally include the pickup request in the same command.
5. Retain the returned PRO and pickup ID. A nominal HTTP success without valid
   business identifiers is not success.
6. A later document adapter may download bounded sensitive base64 artifacts
   and track by PRO, BOL, or pickup identity as supported. Those public R+L
   endpoints are not advertised as executable in this slice.

Only pickup cancellation is documented. ClawPilot does not advertise an R+L
BOL/shipment void. A tendered freight shipment therefore needs an explicit
operator recovery/escalation path rather than a fabricated void operation.
R+L COD fields are omitted because the carrier discontinued that API behavior.

## Side-Effect Safety

Neither supplied API publishes a general shipment idempotency guarantee. Before
activation, the one-off orchestration must use ClawPilot's durable
prepare/call/finalize pattern. Migration `0270` provides the freight-attempt
storage boundary, but the current one-off API does not yet execute this sequence:

1. Commit one immutable tender attempt with the exact organization, provider
   account, offer, plan, request hash, and stable ClawPilot idempotency key.
2. Perform one bounded provider call without holding a database transaction.
3. Finalize as `succeeded`, `failed`, or `unknown` with sanitized evidence.
4. Never blindly retry a timeout or ambiguous response. Reconcile using the
   original WWEX order/transaction/quote identity or R+L quote/BOL/PRO/pickup
   identity first.

WWEX correlation IDs and R+L quote/reference fields are support and
reconciliation identities, not assumed exactly-once controls. Freight tender
success is a shipment/BOL/PRO/pickup outcome, not one carrier label and tracking
number per package. Parcel execution continues to require its exact package
label set.

## Capability And Certification Gates

The canonical capability vocabulary is independently activated:

- `small_parcel_rate`, `small_parcel_tender`, `small_parcel_documents`,
  `small_parcel_pickup`, `small_parcel_tracking`, and `small_parcel_void`;
- `ltl_rate`, `ltl_tender`, `ltl_bol`, `ltl_documents`, `ltl_pickup`,
  `ltl_pickup_cancel`, `ltl_tracking`, and `ltl_cancel`.

Rate authority never implies tender authority. A provider connection requires
operator-selected credentials, fixed reviewed endpoints, organization/account and
ship-from binding, verified payer terms, sandbox fixtures where a sandbox
exists, an authorized live smoke test, document/print verification,
reconciliation procedures, and on-call ownership. Missing provider support is
shown as unavailable rather than inferred from a similar endpoint.

The current WWEX contract leaves `small_parcel_void`, `ltl_cancel`, and pickup
cancellation unavailable because its supplied cancel example is ambiguous.
R+L exposes pickup cancellation but not a shipment/BOL cancel, so it may expose
`ltl_pickup_cancel` only; `ltl_cancel` remains unavailable.

Executable client capabilities in this slice are deliberately narrower:

- WWEX: `small_parcel_rate`, `small_parcel_pickup`,
  `small_parcel_tender`, `ltl_rate`, and `ltl_tender`;
- R+L: `ltl_rate`, `ltl_tender`, `ltl_bol`, and `ltl_pickup`.

Document retrieval, tracking, pickup cancellation, and shipment cancellation
remain unavailable until their client, persistence, reconciliation, and
certification paths exist, even when a public provider page lists the feature.

For WWEX production approval, the operator must also complete the provider's
platform review and verify its required BOL/AWB billing presentation. For R+L,
the initial live proof must use a harmless rate read before any tender and must
verify freight class, accessorial, quote-link, BOL, PRO, document, and pickup
behavior against the customer's account/tariff.

## Source Documentation Reviewed

Private source material reviewed locally, without committing its credentials:

- `SpeedShip_myUnishippers_WebService_Guide_v1.9b.pdf`
- `API_Speedship_myUni_sandbox v1.9b.postman_collection.json`
- `R_L_Carriers_API_Method_Sheet.docx`
- the supplied R+L Postman collection and development/production environments

Current public material:

- [Unishippers API integrations](https://www.unishippers.com/shipping-technology/api-integrations)
- [Worldwide Express SpeedShip introduction](https://wwex.com/wp-content/uploads/sites/3/2023/04/SpeedShip-Intro-Guide.pdf)
- [R+L API tools and Swagger](https://www.rlcarriers.com/freight/shipping-software/api)
- [R+L rate quote](https://technology.rlcarriers.com/api-documentation/rate-quote/)
- [R+L pallet rates](https://technology.rlcarriers.com/api-documentation/pallet-rates/)
- [R+L accessorials](https://technology.rlcarriers.com/api-documentation/accessorial-documentation/)
- [R+L bill of lading](https://technology.rlcarriers.com/api-documentation/bill-of-lading/)
- [R+L handling-unit update](https://technology.rlcarriers.com/api-update-new-bol-handling-units-array-support/)
- [R+L pickup request](https://technology.rlcarriers.com/api-documentation/pickup-request/)
- [R+L pickup dimensions and quote-number update](https://technology.rlcarriers.com/api-update-pickup-request-dimensions-and-quote-number/)
- [R+L shipment tracking](https://technology.rlcarriers.com/api-documentation/shipment-tracking/)
- [R+L API release notes](https://technology.rlcarriers.com/news/)
- [NMFTA freight classification](https://nmfta.org/standards/classification/nmfc/)
- [NMFTA 13-subprovision density scale](https://nmfta.org/news/decoding-density-the-freight-factor-you-cant-afford-to-overlook/)
- [NMFTA ClassIT+ API](https://classitplus.nmfta.org/products/api)
- [FreightClassPro source reviewed as a non-runtime reference](https://github.com/elliepetalmedia/freight-class-pro)
