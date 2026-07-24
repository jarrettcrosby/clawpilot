---
id: cp-ops-printing-carrier-billing-gl-coding
title: Printing, Carrier Billing, And GL Coding
summary: Operator setup and evidence flow for printer routing, multi-account carrier bills, GL Coding, settlement, and rebilling.
status: active
kind: operations-guide
area: distributed-operations
tags: [clawpilot, printing, carriers, billing, gl-coding, settlement]
app_visible: true
---

# Printing, Carrier Billing, And GL Coding

## Scope And Current Status

This guide covers three separate but connected controls:

1. **Printing** routes an existing durable document to an eligible printer. It never purchases a carrier label.
2. **Carrier billing** retains actual carrier charges and matches them to carrier accounts and shipments.
3. **GL Coding and settlement** assigns carrier charges to the responsible shipper and calculates the approved Triangle, Square, and Circle economics.

ClawPilot persists organization- and warehouse-scoped printer profiles, capability-aware defaults and fallbacks, enrolled local print agents, fenced claim and acknowledgement attempts, bounded retries and audited reprints, direct carrier CSV imports, carrier-account and billing evidence, selected-batch GL Coding runs, versioned shipper-routing rules, manual orphan assignments, immutable review evidence, billed-actual settlement entries, and append-only settlement lifecycle events. Bounded UPS and FedEx sandbox label create/void is available only for the fixed synthetic shipment and automatically routes a committed label to one durable print job. Production label purchase, production void, pickup, tracking, accounting export, invoicing, and payment-provider adapters remain activation-gated. Browser printing is best effort and is not delivery evidence.

## Configure A Printer

Open **Operations > Printing** in the active organization.

1. Select the warehouse and add a printer.
2. Set a stable code and display name.
3. Choose **Thermal** or **Nonthermal**.
4. Choose the intended connection:
   - **Local print agent** for leased delivery and acknowledgement after an agent is enrolled and assigned.
   - **Browser** for operator-initiated best-effort printing.
   - **System print service** only after that service has an approved adapter.
5. Select every format the device accepts: ZPL, PDF, or PNG.
6. Select every supported medium: 4 x 6 label, 4 x 8 label, US Letter, or A4.
7. Select supported document types, including shipping labels, packing slips, pick tickets, carton or pallet labels, bills of lading, customs documents, return labels, and customer inserts.
8. Mark only the document types that should default to this printer.
9. Choose an approved same-warehouse fallback only when it supports every configured document, format, and medium on the primary.
10. Keep the printer `offline` until its real connection is verified. An online local-agent printer must be bound to an active agent.

ClawPilot removes conflicting defaults from other printers in the warehouse when a new default is saved. A route selects the online compatible default first, then its compatible online fallback, then the highest-priority compatible online printer. Disabled and incompatible printers are never selected.

See [Local Print Agent](local-print-agent.md) for credential lifecycle, claim, acknowledgement, failure, retry, fallback, and reprint contracts.

## Label Purchase And Print Delivery

Carrier label purchase and print delivery are intentionally separate idempotent commands:

- A sandbox label command prepares immutable provider-attempt evidence, purchases or retrieves one carrier label, and retains the provider reference, redacted evidence, exact carrier account, and label payload.
- A print command references that existing document and creates a durable print job.
- A print retry must not call the carrier or purchase another label.
- A reprint is a new audited print command with actor, permission, reason, and an explicit reprint marker.
- A carrier outcome that is unknown must be reconciled before label purchase is retried.
- A successful label commit precedes print routing. Replaying the original label command can recover the same idempotent print job without another carrier call.
- A void command resolves the exact persisted integration and carrier account from the label; an operator cannot substitute a different account.

Packing slips and other operational documents will follow the same print route but do not share carrier-purchase state. Packing-slip generation is not yet active because ClawPilot still needs a logistics document renderer and durable binary-object adapter; the knowledge-document repository is not used as a substitute.

## Import Carrier Billing Evidence

A carrier billing file may contain one or many carrier account numbers. Each imported source must retain provider, environment, checksum, filename, source-document reference, import actor, and row totals.

Import the source directly from **Operations > Billing & GL > Import carrier billing CSV**. ClawPilot accepts multipart CSV uploads, calculates the checksum server-side, rejects an idempotency-key replay with different bytes, and never persists the complete carrier account number. Provider-specific column aliases normalize into the common charge schema; unsupported or incomplete rows remain visible as rejected evidence instead of being silently discarded.

For each statement and charge:

1. Normalize the provider, tracking number, account identity, dates, currency, and monetary values.
2. Resolve the billed account to exactly one organization-authorized carrier account. Provider name alone is insufficient.
3. Match a shipment using retained provider, account, tracking, label, and quote evidence. A tracking number is evidence, not authority.
4. Keep ambiguous and unmatched charges in review. Do not invent a shipment to close a total.
5. Preserve the original charge. Corrections create superseding evidence rather than mutating the imported row.

The carrier account registered address determines sender, recipient, or third-party payer classification only after the account is authorized.

## Run GL Coding

Open **Operations > Billing & GL** and explicitly select the carrier billing batches to process.

1. Select a versioned routing-rule set.
2. Run GL Coding against the selected immutable input snapshot.
3. Review automatic shipper assignments and their exact rule version.
4. Review orphans separately.
5. Manually assign an orphan only when the responsible Circle is known. Record a reason.
6. Leave unresolved evidence unresolved when neither a rule nor an operator can support an assignment.
7. Reprocess under a later rule version by creating superseding assignment evidence. Never rewrite the prior run.
8. Approve or reject a completed run as a separate financial-control action. Approval snapshots every selected charge, statement, account resolution, account authorization, carrier account, shipper assignment, currency, amount, and GL output.

Shipment matching and shipper assignment are independent:

- A matched shipment may determine the Circle.
- An unmatched charge may still be assigned to a Circle by a versioned GL rule or a manual decision.
- Manual or rule assignment must not falsely change the shipment match to `matched`.

## Triangle, Square, And Circle Billing

The economic path is:

`Triangle -> zero or more Squares -> Circle`

- **Triangle** is the platform operator and participates in every transaction. Its fee is explicit and may be zero.
- **Square** is an authorized reseller or 3PL. Each participating Square may have an explicit reseller fee.
- **Circle** is the downstream shipper and receives the customer-facing charge.

Carrier account ownership is separate. Triangle or an authorized Square may own the carrier account. Circle does not gain account ownership from delegated access.

The immutable quote snapshot records expected carrier cost, account owner, path, directive versions, platform fee, reseller fees, and customer charge. The later carrier bill records actual cost. Reconciliation calculates quoted-to-actual variance without rewriting the quote.

Settlement produces append-only entries for:

- carrier payable;
- carrier-account-owner reimbursement;
- Triangle platform fee, including an explicit zero;
- each Square reseller fee;
- Circle customer charge;
- approved credits, rebills, disputes, reversals, and voids.

For a positive billed-actual carrier charge, approval accrues the carrier-account owner's carrier payable. When the Circle and carrier-account owner are different parties, it also accrues the Circle-to-owner reimbursement. A negative billed amount creates carrier credit evidence. A zero amount remains reviewed evidence and creates no fabricated money movement.

Quoted Triangle and Square fees remain tied to the immutable quote and MUD snapshots. Approving a carrier bill does not generate those quote fees again. The settlement ledger therefore separates:

- pro forma carrier cost and quoted contract fees;
- billed-actual carrier payable or carrier credit;
- Circle reimbursement to the account owner;
- Triangle platform fee, including an explicit zero;
- each Square reseller fee;
- payout and payment evidence.

Every settlement starts as `accrued`. Authorized users may record `approved`, `billed`, `paid`, `disputed`, `resolved`, `reversed`, or `voided` events only through permitted transitions. Every event requires an operator reason; billed and paid events also require an external invoice, statement, remittance, or payment reference. Paid history cannot be rewritten or reversed in place. Corrections require a new compensating settlement entry.

The settlement ledger displays the retained GL dimensions produced by the approved rule or manual assignment, including account, class, department, project, cost center, or future configured dimensions. Accounting export consumes approved entries. It does not calculate rates, infer ownership, or silently approve a variance.

## Approval And Audit Rules

- Cost and margin visibility requires the corresponding organization permission.
- Rules, manual assignments, reconciliations, run reviews, settlement changes, exports, printer changes, print attempts, retries, and reprints retain actor and audit evidence.
- Secrets, complete carrier account numbers, label payloads, and unrestricted addresses do not appear in activity logs.
- Impersonated actions retain both the effective user and the root administrator.
- No cross-organization rate grant, printer fallback, GL assignment, settlement, or export is inferred from CRM hierarchy alone.

## Activation Checklist

Before enabling real carrier billing, printing, or settlement:

- apply and verify migrations `0089` through `0094` and `0097`;
- confirm active-organization isolation and least-privilege capabilities;
- verify provider-specific CSV parsing with retained source metadata and duplicate checksums;
- reconcile account, tracking, label, quote, and shipment evidence;
- prove that manual and rule assignments cannot both be current;
- prove actual charges do not rewrite quoted charges;
- enroll and health-check the local print agent;
- prove print retries cannot repurchase labels;
- test fallback routing and explicit reprints;
- approve a completed GL run, settlement lifecycle event, and accounting export as separate commands;
- complete sandbox and failure-injection tests before any production side effect.

## Connected Notes

- [Carrier Rate Delegation And Billing](../architecture/carrier-rate-delegation-and-billing.md)
- [Small Parcel Carrier Adapters](../architecture/small-parcel-carrier-adapters.md)
- [Distributed Operations](../modules/distributed-operations.md)
- [Distributed Operations Delivery Plan](../architecture/distributed-operations-delivery-plan.md)
- [Distributed Operations Runbook](distributed-operations-runbook.md)
- [Local Print Agent](local-print-agent.md)
