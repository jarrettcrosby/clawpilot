#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const persistence = readFileSync(
  resolve(root, 'app_src/lib/persistence/operations.ts'),
  'utf8',
)
const route = readFileSync(
  resolve(root, 'app_src/app/api/operations/route.ts'),
  'utf8',
)
const types = readFileSync(
  resolve(root, 'app_src/lib/operations/types.ts'),
  'utf8',
)

const commandStart = persistence.indexOf(
  'export async function prepareOperationsShipmentExecutionFromPostgres',
)
const commandEnd = persistence.indexOf(
  'type PutawayPendingUsage',
  commandStart,
)
assert.notEqual(commandStart, -1, 'Shadow execution command is missing')
assert.notEqual(commandEnd, -1, 'Shadow execution command boundary is missing')
const command = persistence.slice(commandStart, commandEnd)

for (const fragment of [
  'providerVariantId: line.provider_variant_id',
  'operations_commerce_order_candidates candidate',
  'operations_commerce_order_candidate_lines candidate_line',
  "candidate.workflow_state = 'promoted'",
  "candidate_line.workflow_state = 'promoted'",
]) {
  assert.ok(
    persistence.includes(fragment),
    `Canonical provider-variant resolution is missing ${fragment}`,
  )
}

const preflight = command.indexOf(
  'const preflight = await withTransaction',
)
const carrierRead = command.indexOf(
  'const rated = await rateCheckoutShipment',
)
const commit = command.indexOf(
  'return await withTransaction',
  carrierRead,
)
assert.ok(
  preflight >= 0 && carrierRead > preflight && commit > carrierRead,
  'Carrier reads must occur after preflight and outside the atomic commit transaction',
)

for (const fragment of [
  "activation.state !== 'shadow'",
  "order.status !== 'packed'",
  "order.source_provider !== 'shopify'",
  "plan.status !== 'released'",
  "reconciliation.outcome !== 'matched'",
  'AND config.id = $4::uuid',
  'selectCanonicalFulfillmentRate',
  'completedShadowFulfillmentExecutionResult',
  'OPERATIONS_FULFILLMENT_EXECUTION_ALREADY_PREPARED',
  'FROM operations_fulfillment_executions execution',
]) {
  assert.ok(
    persistence.includes(fragment),
    `Preflight is missing ${fragment}`,
  )
}

for (const fragment of [
  "commandType: 'prepare_operations_shipment_execution'",
  'requireFailureEvidence: true',
  'current.driftHash !== preflight.driftHash',
  'operations_pack_rate_runs',
  'operations_pack_rate_variances',
  'comparison_product_key',
  'providerVariantId: allocation.providerVariantId',
  'GROUP BY package_key, comparison_product_key',
  'OPERATIONS_FULFILLMENT_COMPARISON_IDENTITY_REQUIRED',
  "'allocation_changed'",
  "'material_changed'",
  "'service_changed'",
  "'recorded_rate_changed'",
  'operations_fulfillment_executions',
  'operations_shipment_groups',
  'operations_fulfillment_execution_lines',
  'operations_fulfillment_execution_packages',
  'operations_fulfillment_execution_rate_attempts',
  'responseRates.length !== 1',
  'JSON.stringify(responseRates[0])',
  "'cartonization_shipment_rate'",
  "'sandbox'",
  "authority_mode, state",
  "'shadow', 'shadow_prepared'",
  'providerWriteCount: 0',
  'postagePurchaseCount: 0',
  'labelWriteCount: 0',
  'commerceWriteCount: 0',
  'completeCommandReceipt',
]) {
  assert.ok(command.includes(fragment), `Command is missing ${fragment}`)
}

const comparisonStart = command.indexOf(
  'const changeResult = await client.query<',
)
const comparisonEnd = command.indexOf(
  ') AS allocation_changed,',
  comparisonStart,
)
assert.ok(
  comparisonStart >= 0 && comparisonEnd > comparisonStart,
  'Canonical allocation-variance query is missing',
)
const allocationComparison = command.slice(comparisonStart, comparisonEnd)
for (const stageNativeKey of ['line_key', 'product_key']) {
  assert.equal(
    new RegExp(`\\b${stageNativeKey}\\b`).test(allocationComparison),
    false,
    `Allocation variance must not compare stage-native ${stageNativeKey}`,
  )
}
assert.ok(
  (allocationComparison.match(
    /GROUP BY package_key, comparison_product_key/g,
  ) || []).length === 4,
  'Allocation variance must compare both grouped canonical identity sets',
)

for (const forbidden of [
  'createOperationsSandboxLabelInPostgres(',
  'confirmOperationsOrderShipmentFromPostgres(',
  '.createLabel(',
  '.voidLabel(',
  'MockCommerceAdapter(',
  "'package_count_changed'",
  "'package_allocation_changed'",
  "'package_material_or_measurement_changed'",
  "'whole_shipment_service_changed'",
  "'carrier_estimate_changed'",
]) {
  assert.ok(
    !command.includes(forbidden),
    `Shadow preparation must not invoke ${forbidden}`,
  )
}

const actionStart = route.indexOf(
  "if (action === 'prepare-shipment-execution')",
)
const actionEnd = route.indexOf(
  "if (action === 'generate-packing-slip')",
  actionStart,
)
assert.notEqual(actionStart, -1, 'Shadow execution API action is missing')
assert.notEqual(actionEnd, -1, 'Shadow execution API boundary is missing')
const action = route.slice(actionStart, actionEnd)
for (const fragment of [
  'prepareOperationsShipmentExecutionFromPostgres',
  "'orderGlobalId'",
  "'expectedRowVersion'",
  "'reason'",
  'idempotencyKeyValue(req)',
  'result.replayed ? 200 : 201',
]) {
  assert.ok(action.includes(fragment), `API action is missing ${fragment}`)
}

const resultTypeStart = types.indexOf(
  'export type OperationsShadowFulfillmentExecutionResult',
)
const resultTypeEnd = types.indexOf(
  'export type OperationsExceptionUpdateResult',
  resultTypeStart,
)
assert.notEqual(resultTypeStart, -1, 'Shadow execution result type is missing')
const resultType = types.slice(resultTypeStart, resultTypeEnd)
for (const fragment of [
  "orderStatus: 'packed'",
  "status: 'succeeded' | 'degraded'",
  'providerWriteCount: 0',
  'postagePurchaseCount: 0',
  'labelWriteCount: 0',
  'commerceWriteCount: 0',
]) {
  assert.ok(resultType.includes(fragment), `Result type is missing ${fragment}`)
}

console.log('Shadow fulfillment-preparation command contract passed.')
