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

This is the contract for the current development slice. Migrations `0089_operations_rate_delegation_and_carrier_settlement.sql` and `0090_operations_carrier_accounts_and_gl_coding.sql` provide the rate-network and operator-workbench foundation. Migration `0092_operations_carrier_billing_integrity.sql` binds each billing statement and charge to exact provider, environment, account, tracking, assignment, GL-run, reconciliation, and settlement evidence while preserving legacy rows for explicit backfill. The Operations workbench exposes the selected-batch GL Coding runner, pinned routing-rule versions, and manual orphan assignment. This is not evidence of a provider-specific live carrier-bill importer, final settlement approval, payout, or accounting export. Provider mechanics remain behind the [small parcel carrier adapter boundary](small-parcel-carrier-adapters.md), and the operator workflow is documented in [Printing, Carrier Billing, And GL Coding](../operations/printing-carrier-billing-and-gl-coding.md).

## Rate Network

The economic path uses these stable role names:

| Symbol | ClawPilot role | Invariant |
| --- | --- | --- |
| Triangle | Platform operator | Always starts and participates in every rate path. Its fee directive is explicit and may calculate to zero. |
| Square | Reseller or 3PL | May receive and regrant authorized rate access within the same versioned path. |
| Circle | Downstream shipper | Ends the path and receives the customer-facing charge. It cannot grant itself access. |

A path is `Triangle -> zero or more Squares -> Circle`. Every hop has an active, versioned grant and its own ordered pricing directives. The root grant always begins at Triangle, descendant grants must continue the same carrier-account authorization, and cycles are rejected.

Triangle's platform fee is never implicit. The quote must retain a platform-fee directive and calculated value even when that value is `0`. Square fees are also explicit when a Square participates.

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

Carrier API quotes are pro forma. An immutable quote snapshot records the account and owner, Triangle/Square/Circle path, grant and directive versions, carrier and service, quoted carrier cost, explicit platform and reseller fees, customer charge, request hash, provider reference, expiration, and redacted evidence.

The quote establishes the expected economics:

- the carrier-account owner owes the carrier;
- Circle reimburses the account owner for carrier cost;
- Circle owes Triangle the explicit platform fee;
- Circle owes each participating Square its explicit reseller fee.

A zero platform fee remains visible in the quote and calculation provenance. Actual carrier cost comes only from carrier billing evidence and reconciliation; a later bill never rewrites the quote.

## Carrier CSV And GL Coding

A carrier billing CSV is retained as an immutable source snapshot; its import batch is deduplicated by provider, environment, and checksum. One batch may contain statements and charges for many account numbers. Rows are grouped by external statement identity and billed-account fingerprint, then each statement resolves independently to an authorized carrier account.

Shipment matching and shipper assignment are different decisions:

- **Shipment match** answers which canonical ClawPilot shipment, if any, the charge supports. Tracking number is evidence for this decision, not proof by itself.
- **Shipper assignment** answers which Circle owns the charge for billing and reporting. Its source is a shipment match, a versioned GL Coding rule, or a manual decision.

Only operator-selected CSV batches run through GL Coding. GL Coding is the operator-facing contract backed by versioned carrier-billing routing rules. A run pins the exact rule version and input snapshot. Rules may assign a Circle now and may add versioned GL dimensions later without changing the raw charge or inventing a shipment relationship. Reprocessing under a later rule version creates superseding assignment evidence.

An unmatched charge remains an orphan with no shipment ID. A GL Coding rule or an authorized operator may assign that orphan to a Circle for billing, but the shipment match remains `unmatched`. Manual assignment requires an actor and reason. ClawPilot never creates a synthetic shipment match to make reconciliation totals close.

## Reconciliation, Settlement, And Rebill

The financial flow is:

1. Import and deduplicate the selected carrier CSV batch.
2. Resolve every statement to its billed carrier account.
3. Record charge lines, shipment-match decisions, and independent shipper assignments.
4. Run the selected version of GL Coding and retain unresolved charges as orphans.
5. Aggregate matched charge categories into actual carrier cost and compare it with the pro forma quote.
6. Hold ambiguous matches, unresolved account ownership, assignment exceptions, or incomplete statements in `needs_review`.
7. Finalize a versioned reconciliation snapshot only from retained evidence.
8. Approve settlement changes and downstream billing/export separately.

Nonzero carrier payable, account-owner reimbursement, platform fee, and reseller fee entries remain append-only. A zero platform fee remains explicit in quote and calculation evidence rather than disappearing from the rate path. A reconciled variance produces linked credit or rebill entries after approval. Settlement events record approval, billing, payment, dispute, resolution, reversal, or void without editing prior entries. Accounting export consumes approved entries; it does not define carrier cost or rate-path economics.

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

The working-tree foundation defines schema, append-only evidence, pure rate-path pricing, payer classification, statement grouping, selected-batch GL Coding, independent shipper assignment, manual orphan resolution, reconciliation calculations, multiple address-bound carrier-account administration, exact actual-cost provenance, and least-privilege capability enforcement. New integrity constraints are initially `NOT VALID` where historical rows require an explicit evidence backfill; new writes are still checked. It does not yet provide the production services that:

- parse and import provider-specific carrier CSV formats into immutable billing batches;
- add rule simulation, accounting-catalog bindings, and GL dimensions beyond shipper assignment;
- connect final reconciliation to approved settlement, rebill, and accounting export;
- execute production rating, labels, voids, pickups, tracking, or other carrier side effects.

Those services require tenant-isolation, idempotency, concurrency, audit, health, recovery, and provider-sandbox acceptance before activation.
