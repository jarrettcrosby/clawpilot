---
id: cp-module-wearable-picking
title: Wearable Picking Phase 1
summary: Meta and iPhone barcode capture with iPhone orchestration, Watch display, and audited ClawPilot pick confirmation.
status: draft
kind: module-contract
area: distributed-operations
tags: [clawpilot, operations, warehouse, ios, watchos, meta, barcode]
app_visible: false
---

# Wearable Picking Phase 1

Phase 1 is deliberately limited to released outbound picks already assigned by
ClawPilot to the signed-in operator. It does not create or assign work, mutate
shipment/commerce state, print labels, move inventory between locations, or
complete receiving.

`GET /api/operations/picks` returns at most 200 ready tasks whose
`assigned_to` matches the signed worker. The projection requires Operations
view and warehouse execution capabilities and is fenced by the released
order, plan, wave, active warehouse, and active location states.

The iPhone caches the queue, matches each observed barcode in task sequence,
speaks the current instruction, and sends a barcode-free current/next
projection to Watch. Apple Vision's narrow UPC-A-as-leading-zero-EAN-13 form is
the only non-exact barcode equivalence. Raw images, audio, and transcripts are
not persisted or sent to ClawPilot.

After every task in one order matches, the iPhone persists the existing
`confirm-picks` body and idempotency key before sending it to
`POST /api/operations`. ClawPilot remains authoritative: it revalidates the
order row version, released plan/wave, ready tasks, reservations, exceptions,
and inventory positions, then records its existing domain, audit, command
receipt, and ledger evidence. Ambiguous results block new work and replay only
the original command/key.

## Audited picker handoff

A picker who cannot safely finish wholly unpicked work may send
`request-pick-handoff` to `POST /api/operations` with the order global ID,
current `expectedRowVersion`, a human reason, and a stable `Idempotency-Key`.
It also supplies the exact assigned task count from the durable queue; a
truncated or changed assignment fails before any task is unassigned.
The signed actor needs Operations view and warehouse execution capabilities.
The optional `blockedConfirmationIdempotencyKey` binds the request to an exact
failed `confirm_operations_order_picks` receipt for the same organization,
actor, and order whose error is
`OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED`. Omitting it
is the deliberate pre-confirmation abandon path.

ClawPilot locks the order, latest plan, wave, tasks, packages, labels, and label
attempts before accepting the request. The order, plan, and single wave must
all still be released. Every task must be ready, wholly unpicked, and assigned
to the requesting actor. Any mixed assignment, non-ready task, picked quantity,
pick timestamp, started pack, label, or label attempt fails closed. A generic
handoff also fails after wearable scan evidence is acknowledged. The exact
blocked-confirmation path is the narrow exception: it requires succeeded scan
evidence for that organization, order version, and picker because it deliberately
retains the terminal scan-backed command for manager reconciliation.

Success is deliberately narrow and local:

- every task remains `ready`, but `assigned_to` and `assigned_at` are cleared;
- the released order row version increments exactly once;
- one open, high-severity `picker_handoff_requested` exception is created;
- a terminal blocked-confirmation handoff records the exact scan-evidence and
  evidence-receipt linkage on the exception;
- the command receipt result records the exception, old/new row versions, task
  count, optional blocked confirmation key, and `providerWrites: 0`;
- domain and audit events retain the actor, reason, receipt, plan, wave, and
  exact failure code when a blocked confirmation supplied one; and
- `recommendedAction` tells the manager to review the reason and provider
  state, then either reassign ready tasks before resolving the exception or use
  the separate external-fulfillment reconciliation/cancel path when supported.

The command does not call Shopify, Faire, or a carrier. It does not cancel the
order, plan, wave, tasks, reservations, or packages; change inventory; buy or
void postage; or notify a customer. Because the tasks are now unassigned, the
normal signed-worker queue no longer returns the order. The high exception
keeps pick confirmation manager-blocked until a manager deliberately resolves
or dismisses it after choosing the proper disposition. Standalone
`assign-picks` is not composed into the request and must not be treated as
handoff approval. Resolving the exception alone does not reassign the work.

Clients must persist a handoff command and stable key before sending it. An
offline request remains queued with the current pick protected; the client
must not advance or erase scan/count state merely because a refreshed queue
omits the order. It may retire that local state only from the exact successful
handoff receipt (including matching blocked confirmation key when present),
then load the replacement queue. Organization switching must retain the
outbox and allow recovery only in the organization that owns it.

Shopify state changes follow a separate authority path. The desired policy is
for pre-release update ingestion to reproject and replan an order once an
explicit revision-sync path exists; the current generic handoff neither
performs nor proves that sync. After release, wholly unpicked work becomes a
manager-visible exception or audited handoff; generic handoff never claims
Shopify changed and never auto-cancels the order.
`OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED` continues to
use the existing manager reconciliation and its read-only native recheck. Any
recorded physical pick, pack, or label evidence fails closed for generic
handoff and requires manager review.

## Manager picking control

The Operations `Picking` view is a manager-only projection of current released
pick assignments and bounded completed-pick history. Current cards show the
exact order row version and assignment fingerprint, picker or mixed assignment,
ready/picked tasks, required/picked units, current-version scan and count
evidence, and any open picker-handoff or manager-intervention exception. The
picker selector contains only active organization members who may both view
Operations and execute warehouse work (plus organization owners).

`manage-pick-assignment` is the explicit assign, reassign, or unassign command.
It requires Operations manage and warehouse execute capabilities, a stable
`Idempotency-Key`, `expectedRowVersion`, `expectedTaskCount`, the exact SHA-256
`expectedAssignmentFingerprint`, and a retained manager reason. ClawPilot takes
the order advisory lock and row locks the latest plan, single wave, and full
task set. The order, plan, and wave must remain released; every task must remain
ready with zero picked quantity and no pick timestamp. Any current-version scan
or count evidence, started package, label, label attempt, or shipment fails
closed. A target picker is revalidated against current organization membership
and permissions inside the command.

Success changes only `assigned_to`, `assigned_at`, task update timestamps, and
the order row version. It never clears wearable evidence, picked state, physical
work, provider state, or reservations. Unassigning also creates an open,
high-severity `manager_pick_intervention` exception so work cannot disappear
from manager attention. The domain event, audit event, and command receipt
retain the prior/new assignment, exact task IDs, plan and wave, old/new row
versions, reason, related handoff/intervention exceptions, and
`providerWrites: 0`.

Reassigning after a picker handoff deliberately leaves the handoff exception
and old-version scan evidence intact. Likewise, assigning work after a manager
unassign leaves the manager-intervention exception open. A manager must review
and resolve those exceptions separately before confirmation; assignment is not
treated as silent approval of prior physical work or provider state.

The native iPhone Manager surface consumes this same read/command contract. It
shows current assignment, task/unit/scan/count progress, related open
exceptions, and completed history from only the authoritative latest plan and
its exact wave. Its in-context sheet requires a manager reason and supplies the
same exact row-version, task-count, assignment-fingerprint, and stable-key
fences used by the web view. Explicit “Unassign and flag” remains available;
it cannot be confused with closing the sheet or leaving the order detail. A
failure of the pick-management projection is reported as partial manager data
and does not hide otherwise available legacy order planning/release controls.

Development simulator walkthroughs are local fixtures only. Debug builds accept
`--walkthrough=pick-management` for the assigned/unassigned/history screen and
`--walkthrough=pick-intervention` for the popup. The fixture is compiled behind
`#if DEBUG`, includes no backend credentials, and never sends a manager command.

For a multi-unit task, the iPhone/Watch workflow presents a focused count
prompt after the product scan. The confirm command supplies paired
`countEvidenceIdempotencyKey` and `countEvidence` fields. Each immutable entry
identifies the task, repeats the locked required quantity, records the entered
quantity, references the exact product observation, and records whether the
count was entered on iPhone or Watch. ClawPilot accepts only positive whole
units with `enteredQuantity === requiredQuantity`, checks the signed picker and
current order/task context, requires the count after the product scan, and
commits the evidence in the same transaction as the confirm command receipt.
Short and excess counts fail closed and never change allocation, reservation,
or inventory semantics.

This enforcement is deliberately scoped to iPhone/Watch confirmations that
supply both count fields. Omitting both fields preserves the existing web and
legacy confirmation contract, and unit-one tasks do not create count evidence.
When location-first policy also applies, the count must reference the same
immutable product observation that ClawPilot already acknowledged with the
location/product scan evidence.

Passing source, Swift, Meta fixture, iPhone simulator, and Watch simulator gates
is development proof only. A signed device pilot remains mandatory.
