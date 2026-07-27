#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const migration = read('db/migrations/0101_operations_receiving_and_topology.sql')
const types = read('app_src/lib/operations/types.ts')
const persistence = read('app_src/lib/persistence/operations.ts')
const route = read('app_src/app/api/operations/route.ts')
const panel = read('app_src/components/operations/ReceivingPanel.tsx')
const section = read('app_src/components/operations/OperationsSection.tsx')

for (const fragment of [
  "('grc', 'operations.receipt'",
  "('grcl', 'operations.receipt_line'",
  'CREATE TABLE IF NOT EXISTS operations_receipts',
  'CREATE TABLE IF NOT EXISTS operations_receipt_lines',
  'CREATE TABLE IF NOT EXISTS operations_location_product_rules',
  'ADD COLUMN IF NOT EXISTS damaged_delta numeric',
]) {
  assert.ok(migration.includes(fragment), `Receiving migration missing ${fragment}`)
}

for (const fragment of [
  'OperationsPutawayPlacement',
  "'manual' | 'preferred_rule' | 'same_product' | 'route_order'",
  'OperationsInboundReceiptCreationResult',
  'OperationsInboundReceiptCompletionInput',
]) {
  assert.ok(types.includes(fragment), `Receiving types missing ${fragment}`)
}

for (const fragment of [
  'createOperationsInboundReceiptInPostgres',
  'completeOperationsInboundReceiptInPostgres',
  'operations:receipt-reference:',
  'OPERATIONS_PUTAWAY_UNAVAILABLE',
  'OPERATIONS_PUTAWAY_LOCATION_INVALID',
  'OPERATIONS_RECEIPT_QUANTITY_INCOMPLETE',
  'candidate.allow_mixed_products',
  "candidate.rule_type === 'restricted'",
  'candidate.max_volume_cubic_meters',
  'candidate.max_weight_kg',
  '/ NULLIF(profile.units_per_package, 0)',
  "eventType: 'operations.receipt.created'",
  "eventType: 'operations.receipt.completed'",
]) {
  assert.ok(persistence.includes(fragment), `Receiving persistence missing ${fragment}`)
}

for (const fragment of [
  "action === 'create-inbound-receipt'",
  "action === 'complete-inbound-receipt'",
  'inboundReceiptLinesValue',
  'inboundReceiptCompletionLinesValue',
  'idempotencyKey: idempotencyKeyValue(req)',
]) {
  assert.ok(route.includes(fragment), `Receiving API missing ${fragment}`)
}

for (const fragment of [
  'New receipt',
  'Automatic putaway',
  'Canonical units; case and pallet conversion require a versioned UOM profile.',
  "action: 'create-inbound-receipt'",
  "action: 'complete-inbound-receipt'",
  'label="Accepted"',
  'label="Damaged"',
  'as the final tie-breaker among eligible locations',
]) {
  assert.ok(panel.includes(fragment), `Receiving workspace missing ${fragment}`)
}

assert.ok(section.includes("value=\"receiving\""), 'Operations navigation must expose Receiving')
assert.ok(section.includes('<ReceivingPanel'), 'Operations must render the Receiving workspace')

console.log('Operations receiving and directed-putaway contracts passed.')
