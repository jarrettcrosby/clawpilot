#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const [
  migration,
  persistence,
  route,
  operations,
  shipping,
  rateEvidence,
  productionRerates,
  types,
] = await Promise.all([
  read('db/migrations/0310_operations_order_shipment_address_working_copy.sql'),
  read('app_src/lib/persistence/operationsOrderShipmentAddress.ts'),
  read('app_src/app/api/operations/shipment-address/route.ts'),
  read('app_src/lib/persistence/operations.ts'),
  read('app_src/lib/persistence/operationShipping.ts'),
  read('app_src/lib/persistence/cartonizationRateEvidence.ts'),
  read('app_src/lib/operations/productionFulfillmentRerates.ts'),
  read('app_src/lib/operations/types.ts'),
])

for (const fragment of [
  'CREATE TABLE public.operations_order_shipment_address_working_copies',
  'source_order_row_version',
  'source_order_hash',
  'ship_to_ciphertext bytea NOT NULL',
  'ship_to_encryption_version',
  'dispatch_core_fingerprint',
  'last_command_receipt_id',
  'operations_order_ship_address_order_fkey',
  'operations_order_ship_address_receipt_fkey',
  'order binding is immutable',
  'SET search_path = pg_catalog, public, pg_temp',
  'FOR UPDATE OF source_order',
  'provider writes remain zero',
  'operations_order_dispatch_destination_matches',
]) {
  assert.ok(migration.includes(fragment), `0310 is missing ${fragment}`)
}
assert.equal(
  migration.includes('ALTER TABLE operations_orders'),
  false,
  'The source order table must remain unchanged',
)

for (const fragment of [
  'readOperationsOrderShipmentAddressInPostgres',
  'updateOperationsOrderShipmentAddressInPostgres',
  'shipmentAddressRequiresRerate',
  'plan_destination_fingerprints',
  'active_plan_count',
  'expectedOrderRowVersion',
  'expectedAddressRowVersion',
  'operations_order_shipment_address_working_copies',
  'operations_command_receipts',
  'recordAuditEvent',
  'OPERATIONS_SHIPMENT_ADDRESS_PROTECTED_DATA_UNREADABLE',
  'OPERATIONS_SHIPMENT_ADDRESS_DOWNSTREAM_EVIDENCE_EXISTS',
  'SELECT public.operations_dispatch_address_core_fingerprint(',
  'providerWrites: 0',
  'providerWriteIntentCreated: false',
  'LEFT JOIN operations_integration_accounts source_account',
  "attempt.environment = 'production'",
]) {
  assert.ok(persistence.includes(fragment), `Persistence is missing ${fragment}`)
}
assert.equal(
  persistence.includes('UPDATE operations_orders'),
  false,
  'A local shipment-address save must not change the canonical order rowVersion',
)
assert.equal(
  persistence.includes('INSERT INTO operations_commerce_external_effect_intents'),
  false,
  'A local shipment-address save must create zero provider-write intents',
)
assert.equal(
  persistence.includes('function normalizedDispatchCoreText'),
  false,
  'PostgreSQL, not a duplicated JavaScript normalizer, must own dispatch fingerprints',
)

for (const fragment of [
  'export async function GET',
  'export async function PATCH',
  'capabilities.canManage',
  'expectedOrderRowVersion',
  'expectedAddressRowVersion',
  'idempotencyKeyValue(req)',
]) {
  assert.ok(route.includes(fragment), `Route is missing ${fragment}`)
}
assert.equal(
  /reason|confirmationStatement|canActivate|canExecute/u.test(route),
  false,
  'An ordinary shipment edit must not require execution or activation ceremony',
)

assert.ok(
  operations.includes('shipTo: address(orderShipToStorageValue(shipmentShipTo.value))'),
  'Order detail must project the effective operational Ship-to',
)
assert.ok(
  operations.includes('shipmentShipTo,'),
  'Order detail must expose source and effective shipment-address state',
)
for (const fragment of [
  'order.ship_to = orderShipToStorageValue(operationalShipTo.value)',
  'source.ship_to = orderShipToStorageValue(operationalShipTo.value)',
]) {
  assert.ok(
    operations.includes(fragment),
    `Shadow execution, pack documents, and shipment confirmation are missing ${fragment}`,
  )
}
assert.ok(
  operations.match(/readOperationsOrderShipmentAddressInPostgres/g)?.length >= 4,
  'Order detail, shadow execution, pack documents, and shipment confirmation must resolve the effective address',
)
assert.ok(
  rateEvidence.includes('readOperationsOrderShipmentAddressInPostgres'),
  'Cartonization and rates must read the effective canonical Ship-to override',
)
assert.ok(
  rateEvidence.includes('destinationFingerprint'),
  'Rate evidence must retain the effective destination fingerprint',
)
assert.ok(
  shipping.includes('order.ship_to = orderShipToStorageValue(shipmentShipTo.value)'),
  'Label requests must use the effective operational Ship-to',
)
assert.ok(
  shipping.includes('OPERATIONS_LABEL_SHIP_TO_INCOMPLETE'),
  'Label creation must reject an incomplete address at the label boundary',
)
assert.ok(
  shipping.includes('OPERATIONS_LABEL_RERATE_REQUIRED'),
  'Label creation must reject stale destination-rate evidence',
)
assert.ok(
  migration.match(/operations_order_dispatch_destination_matches\(/gu)?.length
    >= 5,
  '0310 must bind the helper plus all four Active rerate/dispatch validators',
)
assert.ok(
  productionRerates
    .match(/readOperationsOrderShipmentAddressInPostgres\(/gu)?.length >= 3,
  'Production rerate preparation, selection, and dispatch must read the effective address',
)
assert.equal(
  /orders\.ship_to|current_order_ship_to|context\.ship_to/u.test(
    productionRerates,
  ),
  false,
  'Production rerates must not fall back to the provider/source order address',
)
assert.ok(
  types.includes('shipmentShipTo: OperationsOrderShipmentAddress'),
  'The order-detail contract must expose effective and source Ship-to state',
)

console.log('Operations order shipment-address contract passed')
