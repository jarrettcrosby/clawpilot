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
view, management, and warehouse execution capabilities and is fenced by the
released order, plan, wave, active warehouse, and active location states.

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

Passing source, Swift, Meta fixture, iPhone simulator, and Watch simulator gates
is development proof only. A signed device pilot remains mandatory.

