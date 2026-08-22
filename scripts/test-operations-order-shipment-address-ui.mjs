#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [editor, operations] = await Promise.all([
  read('app_src/components/operations/OrderShipmentAddressEditor.tsx'),
  read('app_src/components/operations/OperationsSection.tsx'),
])

for (const fragment of [
  'canonical-order-shipment-address-editor',
  'Used for this ClawPilot shipment',
  'Ready for rates',
  'Ship-to needed for rates',
  'Store address',
  "fetch('/api/operations/shipment-address'",
  'expectedOrderRowVersion',
  'expectedAddressRowVersion',
  'Idempotency-Key',
  '>\n          Save\n        </Button>',
]) {
  assert.ok(editor.includes(fragment), `Shipment editor is missing ${fragment}`)
}
assert.equal(
  /name=["']reason["']|planningReason|confirmationStatement|canActivate|canExecute|typed confirmation/iu.test(editor),
  false,
  'The ordinary Ship-to editor must not expose activation or confirmation ceremony',
)
assert.ok(
  operations.includes('<DetailSection title="Shipment details">'),
  'Canonical order detail must include the shipment editor',
)
assert.ok(
  operations.includes("order?.shipmentShipTo.readiness !== 'carrier_ready'"),
  'The create-label affordance must surface address readiness at the action boundary',
)

console.log('Operations order shipment-address UI contract passed')
