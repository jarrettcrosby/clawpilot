---
id: cp-architecture-carrier-rate-delegation-and-billing
title: Carrier Rate Delegation And Billing
summary: Rate-network authority, address-bound carrier account selection, carrier-bill GL Coding, reconciliation, settlement, and rebill contract.
status: draft
kind: architecture
area: distributed-operations
tags: [clawpilot, carriers, rate-delegation, 3pl, billing, reconciliation, gl-coding]
app_visible: false
---

# Carrier Rate Delegation And Billing

## Decision And Status

ClawPilot separates carrier-rate authority, carrier-account ownership, shipment matching, shipper assignment, and financial settlement. None can be inferred from CRM hierarchy or from another step succeeding.

This is the contract for the current development slice. Migrations `0089_operations_rate_delegation_and_carrier_settlement.sql` and `0090_operations_carrier_accounts_and_gl_coding.sql` provide the rate-network and operator-workbench foundation. Migration `0092_operations_carrier_billing_integrity.sql` binds each billing statement and charge to exact provider, environment, account, tracking, assignment, GL-run, reconciliation, and settlement evidence while preserving legacy rows for explicit backfill. Additive migration `0146_operations_pack_rate_pricing_semantics.sql` separates replay checkout and pre-label estimates from MUD, and `0147_operations_carrier_billing_mud.sql` adds append-only billing-time MUD evidence. The Operations workbench exposes the selected-batch GL Coding runner, pinned routing-rule versions, and manual orphan assignment. This is development-only evidence, not proof of a provider-specific live carrier-bill importer, final production settlement approval, payout, or accounting export. Provider mechanics remain behind the [small parcel carrier adapter boundary](small-parcel-carrier-adapters.md), and the operator workflow is documented in [Printing, Carrier Billing, And GL Coding](../operations/printing-carrier-billing-and-gl-coding.md).

## Rate Network

The economic path uses these stable role names:

| Symbol | ClawPilot role | Invariant |
| --- | --- | --- |
| Triangle | Platform operator | Always starts and participates in every rate path. Its fee directive is explicit and may calculate to zero. |
| Square | Reseller or 3PL | May receive and regrant authorized rate access within the same versioned path. |
| Circle | Downstream shipper | Ends the path and receives the customer-facing charge. It cannot grant itself access. |

A path is `Triangle -> zero or more Squares -> Circle`. Every hop has an
active, versioned grant and its own ordered pricing directives. The root grant
always begins at Triangle, descendant grants must continue the same
carrier-account authorization, and cycles are rejected. Storing a directive on
that path does not authorize quote-time MUD: an `actual_cost` MUD is selected
and evaluated only after exact approved carrier billing. The current
billing-time slice intentionally requires exactly one direct grant to the
assigned Circle with one or more applicable `actual_cost` directives. Grants
that have no applicable actual-cost directive do not create ambiguity; more
than one eligible direct grant is blocked instead of selecting a price path
implicitly.

Triangle's platform fee is never implicit. Any fee presented at quote time
must retain its own explicit quote-time basis and value, including `0`, and
must not be labeled as billing-time MUD. Square fees are also explicit when a
Square participates.

Carrier-account ownership is separate from the economic role path:

- Triangle may own the selected carrier account.
- An authorized Square on the path may own it.
- Circle does not become an account owner merely by receiving a delegated rate.
- CRM parent/child relationships, workspace hierarchy, and ordinary CRM access grant no carrier-rate access.
- Access requires an active carrier-account authorization, an unbroken active grant path, and the required user capability or explicit grant.

## Carrier Accounts And Payer Relationship

One provider and environment may have multiple carrier account numbers. Each account identity is independent and retains its owner, encrypted account number, non-secret fingerprint and masked reference, registered billing address, verification basis, status, and effective authorization. Provider name alone is never enough to select an account.

After an authorized account is selected, ClawPilot classifies its payer relationship against normalized shipment addresses in this exact order:

1. **Sender** when the registered account address matches the sender address.
2. **Recipient** when sender did not match and the registered account address matches the recipient address.
3. **Third party** when neither address matches.

Sender has precedence when the registered address matches both sender and recipient. Third-party classification does not bypass account authorization. Ambiguous account eligibility fails for review instead of falling back to another organization's credentials.

## Quotes And Economic Entries

Carrier API quotes are pro forma estimates. The immutable checkout snapshot
records the customer-facing shipping charge separately from the selected
checkout carrier estimate. A later pre-label rerate records a second estimate
without replacing either checkout fact. Their signed comparisons are
**estimated variances**, not realized margin, carrier-billed actual, or MUD.

The quote establishes expected operational economics only. It does not prove
what the carrier billed or create a final carrier payable. Any explicit
quote-time platform or reseller fee remains visible with its own provenance,
including a zero fee, but an `actual_cost` MUD is not evaluated at quote time.
The immutable checkout shipping charge remains unchanged through fulfillment.

Carrier-billed actual comes only from imported billing evidence whose charges
have an exact current shipment match and approved GL Coding review. A later
bill and any billing-time MUD calculation create new append-only facts; neither
rewrites the checkout charge, checkout estimate, or pre-label estimate.

## Carrier CSV And GL Coding

A carrier billing CSV is retained as an immutable source snapshot; its import batch is deduplicated by provider, environment, and checksum. One batch may contain statements and charges for many account numbers. Rows are grouped by external statement identity and billed-account fingerprint, then each statement resolves independently to an authorized carrier account.

Shipment matching and shipper assignment are different decisions:

- **Shipment match** answers which canonical ClawPilot shipment, if any, the charge supports. Tracking number is evidence for this decision, not proof by itself.
- **Shipper assignment** answers which Circle owns the charge for billing and reporting. Its source is a shipment match, a versioned GL Coding rule, or a manual decision.

Only operator-selected CSV batches run through GL Coding. GL Coding is the operator-facing contract backed by versioned carrier-billing routing rules. A run pins the exact rule version and input snapshot. Rules may assign a Circle now and may add versioned GL dimensions later without changing the raw charge or inventing a shipment relationship. Reprocessing under a later rule version creates superseding assignment evidence.

An unmatched charge remains an orphan with no shipment ID. A GL Coding rule or an authorized operator may assign that orphan to a Circle for billing, but the shipment match remains `unmatched`. Manual assignment requires an actor and reason. ClawPilot never creates a synthetic shipment match to make reconciliation totals close.

CSV import alone does not establish carrier-billed actual for a shipment.
Carrier-billed actual becomes eligible for MUD only when every included charge
is retained exactly, the current shipment match is unambiguous, the exact
shipper assignment is present, and the GL Coding review is approved. Assigning
an unmatched orphan to a Circle does not satisfy the shipment-match
requirement.

## Reconciliation, Settlement, And Rebill

The financial flow is:

1. Import and deduplicate the selected carrier CSV batch.
2. Resolve every statement to its billed carrier account.
3. Record charge lines, shipment-match decisions, and independent shipper assignments.
4. Run the selected version of GL Coding and retain unresolved charges as orphans.
5. After approval, aggregate the exactly matched retained charges into
   carrier-billed actual and compare it with the immutable checkout shipping
   charge; keep the checkout and pre-label estimate comparisons separate.
6. Hold ambiguous matches, unresolved account ownership, assignment exceptions, or incomplete statements in `needs_review`.
7. Evaluate MUD only when an approved, effective-as-of-shipment,
   currency-matched
   directive with `calculation_basis=actual_cost` applies to the exact
   shipment and the single eligible direct shipper grant. A later version
   whose effective window starts after `shipped_at` does not invalidate the
   historical version that applied to that shipment. Retain the grant,
   contract, directive version,
   statement lineage, charge set, calculation snapshot, input hash, and actor.
   Persist `not_configured` when no applicable directive exists and `blocked`
   for invalid or ambiguous evidence.
8. Finalize a versioned reconciliation snapshot only from retained evidence.
9. Approve settlement changes and downstream billing/export separately.

Nonzero carrier payable, account-owner reimbursement, platform fee, and
reseller fee entries remain append-only. A zero platform fee remains explicit
in its applicable evidence rather than disappearing from the rate path.
Checkout-to-carrier-actual and checkout-to-contract-bill variances are
different facts; before approved carrier billing, only estimated variance
exists. A reconciled variance produces linked credit or rebill entries after
approval. Settlement events record approval, billing, payment, dispute,
resolution, reversal, or void without editing prior entries. Accounting export
consumes approved entries; it does not define carrier cost, manufacture MUD, or
rewrite rate-path economics.

## Carrier Test Policy

All carrier tests in this slice are sandbox-only. The currently exposed provider action remains the fixed UPS CIE or FedEx Sandbox rate test; it creates no label, shipment, pickup, manifest, tracking record, or carrier charge.

Any later label or pickup test must:

- use only the provider's sandbox or test environment and synthetic data;
- persist a durable, idempotent intent before the provider call;
- automatically void each test label and cancel each test pickup;
- reconcile unknown outcomes before retrying;
- retain operator-visible evidence that cleanup succeeded.

A failed void or cancellation freezes further tests for that account until reconciliation completes. No production credential or live carrier side effect is used as a routine test.

## Remaining Delivery

The working-tree foundation defines schema, append-only evidence, separate
checkout and pre-label estimate semantics, payer classification, statement
grouping, selected-batch GL Coding, independent shipper assignment, manual
orphan resolution, approved exact carrier-billed actuals, billing-time
`actual_cost` MUD calculation or explicit `not_configured` evidence, multiple
address-bound carrier-account administration, immutable calculation
provenance, and least-privilege capability enforcement. New integrity
constraints are initially `NOT VALID` where historical rows require an
explicit evidence backfill; new writes are still checked. It does not yet
provide the production services that:

- parse and import provider-specific carrier CSV formats into immutable billing batches;
- add rule simulation, accounting-catalog bindings, and GL dimensions beyond shipper assignment;
- connect final reconciliation to approved settlement, rebill, and accounting export;
- execute production rating, labels, voids, pickups, tracking, or other carrier side effects.

Those services require tenant-isolation, idempotency, concurrency, audit, health, recovery, and provider-sandbox acceptance before activation.
