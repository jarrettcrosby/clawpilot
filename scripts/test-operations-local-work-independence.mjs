#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const operations = read('app_src/lib/persistence/operations.ts')
const shipping = read('app_src/lib/persistence/operationShipping.ts')
const intake = read('app_src/lib/persistence/commerceIntake.ts')
const inventory = read('app_src/lib/persistence/commerceInventory.ts')
const providerWrites = read('app_src/lib/persistence/commerceProviderWrites.ts')
const migration = read(
  'db/migrations/0314_operations_local_work_independent_activation.sql',
)

assert.equal(
  createHash('sha256').update(migration).digest('hex'),
  '36e2daed265db2727edc14ebd84e557532cfd8bb7990d8da505f132025a85ee1',
  '0314 local-work authority bytes must remain exact',
)

function region(source, start, end = '\nexport async function') {
  const startIndex = source.indexOf(start)
  assert.ok(startIndex >= 0, `Missing source region ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  return source.slice(startIndex, endIndex < 0 ? undefined : endIndex)
}

for (const name of [
  'planOperationsOrderFromPostgres',
  'releaseOperationsOrderFromPostgres',
  'assignOperationsOrderPicksFromPostgres',
  'recordWearablePickScanEvidenceFromPostgres',
  'reconcileShopifyExternalFulfillmentFromPostgres',
  'reopenOperationsOrderForReplanningInPostgres',
  'confirmOperationsOrderPicksFromPostgres',
  'verifyOperationsOrderPackFromPostgres',
  'generateOperationsPackagePackingSlipInPostgres',
]) {
  const implementation = region(operations, `export async function ${name}`)
  assert.doesNotMatch(
    implementation,
    /resolveActivation|OPERATIONS_ACTIVE_RATE_EVIDENCE_REQUIRES_PRODUCTION/u,
    `${name} must use order/evidence authority instead of global activation`,
  )
}

assert.doesNotMatch(
  shipping,
  /operations_activation_scopes|activation_state/u,
  'Sandbox label create/void must not depend on global activation',
)
for (const fragment of [
  'resolveCarrierSandboxShippingRuntime',
  'carrierRateGlobalId',
  'carrierAccountGlobalId',
  "shipmentShipTo.readiness === 'carrier_ready'",
]) {
  assert.ok(shipping.includes(fragment), `Sandbox label authority missing ${fragment}`)
}

for (const implementation of [
  region(intake, 'async function lockCommerceStoreSyncState', '\nfunction requireCommerceStoreSyncRunning'),
  region(inventory, 'async function lockShopifyInventoryProviderReadAuthority', '\ntype TargetRow'),
  region(inventory, 'export async function renewShopifyInventoryReadLeaseInPostgres', '\nfunction safeSum'),
]) {
  assert.doesNotMatch(
    implementation,
    /operations_activation_scopes|activation\.state/u,
    'Provider-read authority must be account-scoped',
  )
}
assert.match(
  region(intake, 'async function commandStart', '\nasync function assertCurrentAutomaticProductCredentialFence'),
  /if \(automaticMirror && !lockedStoreSync\?\.running\)/u,
  'Automatic mirroring must retain the per-account Store Sync switch',
)

for (const fragment of [
  'operations_commerce_provider_write_control_current',
  "row.requested_mode === 'on'",
  'bound_granted_scopes',
  'providerWritesEffective',
]) {
  assert.ok(
    providerWrites.includes(fragment),
    `Per-account Provider Writes authority missing ${fragment}`,
  )
}

const guard = region(
  migration,
  'CREATE OR REPLACE FUNCTION guard_shadow_commerce_canonical_write()',
  '\nALTER FUNCTION operations_commerce_store_sync_effective_reason',
)
assert.doesNotMatch(guard, /operations_activation_scopes|activation\.state/u)
assert.match(guard, /operations_shadow_training_runs/u)
assert.match(guard, /shadowTraining/u)

console.log('Operations local-work activation source boundaries passed.')
