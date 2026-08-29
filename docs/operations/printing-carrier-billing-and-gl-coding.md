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

ClawPilot persists organization- and warehouse-scoped printer profiles, capability-aware defaults and fallbacks, enrolled local print agents, fenced claim and acknowledgement attempts, bounded retries and audited reprints, direct carrier CSV imports, carrier-account and billing evidence, selected-batch GL Coding runs, versioned shipper-routing rules, manual orphan assignments, immutable review evidence, billing-time MUD calculations, billed-actual settlement entries, and append-only settlement lifecycle events. Additive migrations `0146` and `0147` correct replay pricing vocabulary and add the billing-time MUD evidence boundary in development. Bounded UPS and FedEx sandbox label create/void is available only for the fixed synthetic shipment and automatically routes a committed label to one durable print job. Production label purchase, production void, pickup, tracking, production billing automation, accounting export, invoicing, and payment-provider adapters remain activation-gated. Browser printing is best effort and is not delivery evidence.

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
- A successful label commit precedes print routing. The order-bound flow may recover its same idempotent print job during command replay; the Settings diagnostic exposes a separate explicit print command. Both retry and controlled reprint reuse stored bytes without another carrier call.
- A void command resolves the exact persisted integration and carrier account from the label; an operator cannot substitute a different account.
- Carrier rating is earlier, separate quote evidence. It never supplies a printable label. The Settings diagnostic creates a label only after the operator chooses an evidenced service and confirms the separate sandbox Ship API command.
- Provider base64 is decoded before durable storage. ZPL must contain a valid command envelope and is delivered as UTF-8; PDF/PNG must pass binary signature validation and is base64 encoded only at a JSON delivery boundary. Artifact SHA-256 and byte length always cover the decoded bytes delivered to the printer.
- Unknown or stale prepared Settings diagnostic mutations are recovered through the organization-admin reconciliation control after external provider verification. The allowed result is action-specific, durable, idempotent, and clears the retry fence without invoking the carrier.

Packing slips and other operational documents will follow the same print route but do not share carrier-purchase state. Packing-slip generation is not yet active because ClawPilot still needs a logistics document renderer and durable binary-object adapter; the knowledge-document repository is not used as a substitute.

## Inspect A Print Job

Open **Operations > Printing > Jobs** and choose **Details** on a job. The operator record provides the information needed to investigate DOM/WMS document delivery without exposing credentials or the printable payload:

- document Global ID, type, format, medium, template version, original or reprint lineage, and current status;
- source order, shipment, carrier label, tracking number, carrier, service, and provider environment;
- ship-to name and locality plus the source package Global ID, package number, canonical dimensions, and weight;
- warehouse, station type, requested printer, selected printer, local print agent, fallback printer, and the human-readable routing reason;
- artifact checksum, byte length, creation actor, and creation time;
- created, available, leased, acknowledged, failed, cancelled, and reprinted lifecycle timestamps;
- retry counts, last safe error, reprint actor and reason, and every fenced agent/device delivery attempt.

**Agent heartbeat**, **last device delivery**, and **paper verified** are separate signals. The heartbeat proves the enrolled local agent has recently polled ClawPilot, including when no work was available. Last device delivery records the most recent acknowledged handoff to that printer. An acknowledged job proves only that the agent handed the document to the configured device. Paper verified is a separate append-only attestation made by an authorized operator who personally observed output; the print agent cannot assert it, and each reprint requires independent evidence.

Credentials, complete carrier-account numbers, artifact storage references, and raw label bytes remain outside the operator view. A retry or reprint always references the existing durable artifact and never purchases another carrier label.

## Import Carrier Billing Evidence

A carrier billing file may contain one or many carrier account numbers. Each imported source must retain provider, environment, checksum, filename, source-document reference, import actor, and row totals.

Import the source directly from **Operations > Carrier invoicing > Import carrier billing CSV**. ClawPilot accepts multipart CSV uploads, calculates the checksum server-side, rejects an idempotency-key replay with different bytes, and never persists the complete carrier account number. Provider-specific column aliases normalize into the common charge schema; unsupported or incomplete rows remain visible as rejected evidence instead of being silently discarded.

For each statement and charge:

1. Normalize the provider, tracking number, account identity, dates, currency, and monetary values.
2. Resolve the billed account to exactly one organization-authorized carrier account. Provider name alone is insufficient.
3. Match a shipment using retained provider, account, tracking, label, and quote evidence. A tracking number is evidence, not authority.
4. Keep ambiguous and unmatched charges in review. Do not invent a shipment to close a total.
5. Preserve the original charge. Corrections create superseding evidence rather than mutating the imported row.

The carrier account registered address determines sender, recipient, or third-party payer classification only after the account is authorized.

Uploading a CSV does not by itself establish carrier-billed actual cost. A
carrier-billed actual is available for pricing and settlement only when the
imported charges are retained exactly, the current shipment match is
unambiguous, the shipper assignment is exact, and the GL Coding review is
approved. Unmatched, ambiguous, superseded, or unapproved evidence remains in
review and cannot drive MUD.

## Run GL Coding

Open **Operations > Shipment pricing & GL** and explicitly select the carrier billing batches to process.

The immutable checkout shipping charge is the pro forma, customer-facing
amount recorded at checkout. The checkout carrier estimate and the pre-label
carrier rerate are separate estimate facts. Their signed differences are
estimated variances until a carrier invoice is imported, exactly matched, and
approved; none is MUD or carrier-billed actual.

A **Markup Directive (MUD)** in this workflow is an approved, effective-dated
`actual_cost` contract rule evaluated only against that approved
carrier-billed actual. It is not calculated during replay, checkout rating, or
the pre-label rerate. A calculated result retains immutable statement,
charge, shipment, quote, account, grant, contract, directive, calculation,
input-hash, and actor provenance. When no applicable directive is configured,
the result is explicitly `not_configured`; ClawPilot does not infer a markup or
coerce it to zero. Eligibility is evaluated at the shipment timestamp and
requires exactly one direct grant to the assigned shipper that actually has
one or more applicable actual-cost directives. Extra grants with no such
directive remain `not_configured`; competing eligible grants are `blocked`.
A future-effective superseding grant or directive does not erase the
historical version applicable at shipment time.

1. Select a versioned routing-rule set.
2. Run GL Coding against the selected immutable input snapshot.
3. Review automatic shipment-to-shipper assignments and their exact shipper-routing rule version.
4. Review orphans separately.
5. Manually assign an orphan only when the responsible Circle is known. Record a reason.
6. Leave unresolved evidence unresolved when neither a rule nor an operator can support an assignment.
7. Reprocess under a later rule version by creating superseding assignment evidence. Never rewrite the prior run.
8. Approve or reject a completed run as a separate financial-control action. Approval snapshots every selected charge, statement, account resolution, account authorization, carrier account, shipper assignment, currency, amount, and GL output.
9. For each exactly matched approved shipment, evaluate the effective approved
   `actual_cost` directive. Persist `calculated`, `not_configured`, or
   `blocked` evidence without changing checkout or quote history.

Shipment matching, shipper assignment, and MUD pricing are independent:

- A matched shipment may determine the Circle.
- An unmatched charge may still be assigned to a Circle by a versioned GL rule or a manual decision.
- Manual or rule assignment must not falsely change the shipment match to `matched`.
- A shipper-assignment rule identifies the responsible Circle and GL dimensions; it is not a MUD and cannot rewrite the customer-facing price.
- MUD requires an exact current shipment match; assigning an orphan to a Circle
  is insufficient.

## Triangle, Square, And Circle Billing

The economic path is:

`Triangle -> zero or more Squares -> Circle`

- **Triangle** is the platform operator and participates in every transaction. Its fee is explicit and may be zero.
- **Square** is an authorized reseller or 3PL. Each participating Square may have an explicit reseller fee.
- **Circle** is the downstream shipper and receives the customer-facing charge.

Carrier account ownership is separate. Triangle or an authorized Square may own the carrier account. Circle does not gain account ownership from delegated access.

The immutable checkout and quote evidence records the customer-facing shipping
charge separately from the selected checkout carrier estimate. A pre-label
rerate records another carrier estimate without rewriting either checkout
fact. Those comparisons remain estimated. The later exactly matched and
approved carrier bill records actual cost. Reconciliation compares the
customer checkout charge with carrier-billed actual without rewriting any
earlier fact; billing-time MUD is a new append-only calculation based on that
actual.

Settlement produces append-only entries for:

- carrier payable;
- carrier-account-owner reimbursement;
- Triangle platform fee, including an explicit zero;
- each Square reseller fee;
- immutable Circle checkout shipping-charge evidence and any separately
  approved contract-billed shipping entry;
- approved credits, rebills, disputes, reversals, and voids.

For a positive billed-actual carrier charge, approval accrues the carrier-account owner's carrier payable. When the Circle and carrier-account owner are different parties, it also accrues the Circle-to-owner reimbursement. A negative billed amount creates carrier credit evidence. A zero amount remains reviewed evidence and creates no fabricated money movement.

Any explicitly supported quote-time fees remain tied to their immutable quote
evidence. The current `actual_cost` MUD is instead evaluated once at approved
carrier billing and retains the exact effective directive provenance. The
settlement ledger therefore separates:

- customer-facing checkout shipping charge;
- checkout and pre-label carrier estimates plus their estimated variances;
- billed-actual carrier payable or carrier credit;
- billing-time MUD adjustment and contract-billed shipping amount, or explicit
  `not_configured`;
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

- apply and verify migrations `0089` through `0094`, `0097`, `0146`, and
  `0147`;
- confirm active-organization isolation and least-privilege capabilities;
- verify provider-specific CSV parsing with retained source metadata and duplicate checksums;
- reconcile account, tracking, label, quote, and shipment evidence;
- prove that manual and rule assignments cannot both be current;
- prove actual charges do not rewrite quoted charges;
- prove replay never persists a MUD result and retains checkout and pre-label
  carrier estimates separately;
- prove billing-time MUD requires exact current shipment matches plus an
  approved review and current effective `actual_cost` directive, and returns
  `not_configured` when no directive applies;
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
