import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const uiSource = await readFile(
  new URL(
    '../app_src/components/operations/OperationsSection.tsx',
    import.meta.url,
  ),
  'utf8',
)
const routeSource = await readFile(
  new URL('../app_src/app/api/operations/route.ts', import.meta.url),
  'utf8',
)

for (const fragment of [
  "'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'",
  'const COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT = 8',
  "input.state === 'failed'",
  'input.errorCode === COMMERCE_FULFILLMENT_RECONCILIATION_REQUIRED',
  'input.attempts < COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT',
  'input.recoveryRuntimeEnabled',
  "input.provider === 'shopify' || input.provider === 'faire'",
  'payload.runtime?.commerceFulfillmentRecoveryEnabled === true',
  'commerceFulfillmentRecoveryEnabled={commerceFulfillmentRecoveryEnabled}',
  'processing attempt',
  "? 'Reconciliation pending'",
  "color={reconciliationPending ? 'warning.main' : 'error.main'}",
  "{reconciliationPending ? 'Check now' : 'Retry / reconcile'}",
  "? 'Check commerce fulfillment reconciliation'",
  'Safe reconciliation is pending for export',
  "? 'Check now'",
  ": 'Retry / reconcile export'",
]) {
  assert.ok(
    uiSource.includes(fragment),
    `Commerce fulfillment reconciliation UI is missing ${fragment}`,
  )
}

assert.equal(
  uiSource.includes(
    'failed and requires review.',
  ),
  false,
  'Shipment confirmation must defer to the current export status instead of declaring every immediate failure an operator review item',
)

assert.match(
  uiSource,
  /color=\{reconciliationPending\s*\? 'warning'\s*: fulfillmentExport\.state === 'succeeded'/,
  'Eligible reconciliation must use warning presentation before normal state colors',
)
assert.match(
  uiSource,
  /fulfillmentExport\.state === 'failed'\s*\? 'error'/,
  'Non-eligible and exhausted failures must retain the genuine error presentation',
)
assert.match(
  uiSource,
  /reconciliationPending\s*\? 'Check the same immutable commerce fulfillment export while safe reconciliation is pending'\s*: 'Retry the same immutable commerce fulfillment export after operator review'/,
  'Only eligible reconciliation may replace the operator-review retry reason',
)
assert.ok(
  uiSource.includes(
    'Reconciliation remains pending for commerce fulfillment export',
  ),
  'An unresolved check must remain pending instead of being announced as a generic failure',
)
for (const fragment of [
  'CLAWPILOT_COMMERCE_FULFILLMENT_RECOVERY_ENABLED',
  'commerceFulfillmentRecoveryRuntimeAvailable()',
  'commerceFulfillmentRecoveryEnabled:',
]) {
  assert.ok(
    routeSource.includes(fragment),
    `Authenticated Operations runtime metadata is missing ${fragment}`,
  )
}

console.log('Commerce fulfillment reconciliation UI contract passed.')
