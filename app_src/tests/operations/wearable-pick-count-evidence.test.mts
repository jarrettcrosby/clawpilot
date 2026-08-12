import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

test('multi-unit count evidence is command-scoped, exact, and immutable', () => {
  const migration = read(
    '../db/migrations/0272_operations_wearable_pick_count_evidence.sql',
  )
  const route = read('app/api/operations/route.ts')
  const persistence = read('lib/persistence/operations.ts')
  const contract = read('lib/operations/wearablePicking.ts')

  assert.match(migration, /operations_wearable_pick_count_evidence/)
  assert.match(migration, /required_quantity BETWEEN 2 AND 9007199254740991/)
  assert.match(migration, /entered_quantity = required_quantity/)
  assert.match(migration, /product_source IN \('iphone_camera', 'meta'\)/)
  assert.match(migration, /count_source IN \('iphone', 'watch'\)/)
  assert.match(migration, /product_captured_at < counted_at/)
  assert.match(migration, /operations_wearable_pick_count_evidence rows are immutable/)
  assert.match(migration, /receipt\.command_type = 'confirm_operations_order_picks'/)
  assert.match(migration, /receipt\.status = 'processing'/)
  assert.match(migration, /lower\(receipt\.actor_email\) = lower\(NEW\.recorded_by\)/)
  assert.match(migration, /orders\.id = NEW\.order_id/)
  assert.match(migration, /orders\.row_version = NEW\.order_row_version/)
  assert.match(migration, /pick\.id = NEW\.pick_task_id/)
  assert.match(migration, /pick\.status = 'ready'/)
  assert.match(migration, /lower\(pick\.assigned_to\) = lower\(NEW\.recorded_by\)/)
  assert.match(migration, /pick\.quantity = trunc\(pick\.quantity\)/)
  assert.match(migration, /pick\.quantity = NEW\.required_quantity/)
  assert.match(migration, /existing\.command_receipt_id <> NEW\.command_receipt_id/)

  assert.match(contract, /WearablePickTaskCountEvidenceInput/)
  assert.match(contract, /requiredQuantity: number/)
  assert.match(contract, /enteredQuantity: number/)
  assert.match(contract, /countSource: WearableCountSource/)
  assert.match(route, /wearablePickCountEvidenceValue\(body\.countEvidence\)/)
  assert.match(route, /countEvidenceIdempotencyKey/)
  assert.match(route, /Count evidence and its idempotency key must be supplied together/)
  assert.match(persistence, /countEvidence: countEvidence \|\| null/)
  assert.match(persistence, /operations:wearable-count-evidence:/)
  assert.match(persistence, /Number\.isSafeInteger\(item\.enteredQuantity\)/)
  assert.match(persistence, /item\.enteredQuantity !== requiredQuantity/)
  assert.match(persistence, /input\.contexts\.filter\(\(context\) => Number\(context\.quantity\) > 1\)/)
  assert.match(persistence, /context\.assigned_to !== input\.actorEmail/)
  assert.match(persistence, /countedAt\.getTime\(\) <= productCapturedAt\.getTime\(\)/)
  assert.match(persistence, /OPERATIONS_WEARABLE_COUNT_SCAN_EVIDENCE_MISMATCH/)
  assert.match(persistence, /INSERT INTO operations_wearable_pick_count_evidence/)
  assert.match(persistence, /countEvidenceEnforced: countEvidenceAcknowledgement\.enforced/)
})

test('omitting both count fields preserves the legacy and unit-one confirmation path', () => {
  const persistence = read('lib/persistence/operations.ts')
  assert.match(
    persistence,
    /if \(idempotencyKey === undefined && evidence === undefined\) \{[\s\S]*?enforced: false as const/,
  )
  assert.doesNotMatch(
    persistence,
    /const required = input\.contexts\.filter[\s\S]*?if \(idempotencyKey === undefined && evidence === undefined\)/,
  )
})
