---
id: cp-ops-printing-carrier-billing-gl-coding
title: Printing, Carrier Billing, And GL Coding
summary: Operator setup and evidence flow for printer routing, multi-account carrier bills, GL Coding, settlement, and rebilling.
status: draft
kind: operations-guide
area: distributed-operations
tags: [clawpilot, printing, carriers, billing, gl-coding, settlement]
app_visible: false
---

# Printing, Carrier Billing, And GL Coding

## Scope And Current Status

This guide covers three separate but connected controls:

1. **Printing** routes an existing durable document to an eligible printer. It never purchases a carrier label.
2. **Carrier billing** retains actual carrier charges and matches them to carrier accounts and shipments.
3. **GL Coding and settlement** assigns carrier charges to the responsible shipper and calculates the approved Triangle, Square, and Circle economics.

ClawPilot currently persists organization- and warehouse-scoped printer profiles, capability-aware defaults and fallbacks, carrier-account and billing evidence, selected-batch GL Coding runs, versioned shipper-routing rules, and manual orphan assignments. A reliable enrolled local print-agent transport, provider-specific carrier CSV upload/parser, settlement approval/export workflow, production label purchase, label void, pickup, and tracking adapters remain activation-gated work. Browser printing is best effort and is not proof of delivery to a printer.

## Configure A Printer

Open **Operations > Printing** in the active organization.

1. Select the warehouse and add a printer.
2. Set a stable code and display name.
3. Choose **Thermal label printer** or **Office document printer**.
4. Choose the intended connection:
   - **Local print agent** for reliable leased delivery and acknowledgement after an agent is enrolled.
   - **Browser** for operator-initiated best-effort printing.
   - **System print service** only after that service has an approved adapter.
5. Select every format the device accepts: ZPL, PDF, or PNG.
6. Select every supported medium: 4 x 6 label, 4 x 8 label, US Letter, or A4.
7. Select supported document types, including shipping labels, packing slips, pick tickets, carton or pallet labels, bills of lading, customs documents, return labels, and customer inserts.
8. Mark only the document types that should default to this printer.
9. Choose an approved fallback printer in the same organization and warehouse when one exists.
10. Keep the printer `offline` until its real connection is verified. A local print agent must report health and acknowledge a test job before the printer is considered reliable.

ClawPilot removes conflicting defaults from other printers in the warehouse when a new default is saved. A route selects the online compatible default first, then its compatible online fallback, then the highest-priority compatible online printer. Disabled and incompatible printers are never selected.

## Label Purchase And Print Delivery

Carrier label purchase and print delivery are intentionally separate idempotent commands:

- A label command purchases or retrieves one carrier label and retains the provider reference and document.
- A print command references that existing document and creates a durable print job.
- A print retry must not call the carrier or purchase another label.
- A reprint is a new audited print command with actor, permission, reason, and an explicit reprint marker.
- A carrier outcome that is unknown must be reconciled before label purchase is retried.

Packing slips and other operational documents follow the same print route but do not share carrier-purchase state.

## Import Carrier Billing Evidence

A carrier billing file may contain one or many carrier account numbers. Each imported source must retain provider, environment, checksum, filename, source-document reference, import actor, and row totals.

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

Accounting export consumes approved entries. It does not calculate rates, infer ownership, or silently approve a variance.

## Approval And Audit Rules

- Cost and margin visibility requires the corresponding organization permission.
- Rules, manual assignments, reconciliations, settlement changes, exports, printer changes, print attempts, retries, and reprints retain actor and audit evidence.
- Secrets, complete carrier account numbers, label payloads, and unrestricted addresses do not appear in activity logs.
- Impersonated actions retain both the effective user and the root administrator.
- No cross-organization rate grant, printer fallback, GL assignment, settlement, or export is inferred from CRM hierarchy alone.

## Activation Checklist

Before enabling real carrier billing, printing, or settlement:

- apply and verify migrations `0089` through `0092`;
- confirm active-organization isolation and least-privilege capabilities;
- verify provider-specific CSV parsing with retained source documents and duplicate checksums;
- reconcile account, tracking, label, quote, and shipment evidence;
- prove that manual and rule assignments cannot both be current;
- prove actual charges do not rewrite quoted charges;
- enroll and health-check the local print agent;
- prove print retries cannot repurchase labels;
- test fallback routing and explicit reprints;
- approve settlement and accounting export as separate commands;
- complete sandbox and failure-injection tests before any production side effect.

## Connected Notes

- [Carrier Rate Delegation And Billing](../architecture/carrier-rate-delegation-and-billing.md)
- [Small Parcel Carrier Adapters](../architecture/small-parcel-carrier-adapters.md)
- [Distributed Operations](../modules/distributed-operations.md)
- [Distributed Operations Delivery Plan](../architecture/distributed-operations-delivery-plan.md)
- [Distributed Operations Runbook](distributed-operations-runbook.md)
