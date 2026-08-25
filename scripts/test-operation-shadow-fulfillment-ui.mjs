import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [
  typesSource,
  domainSource,
  persistenceSource,
  preparationReadSource,
  uiSource,
] = await Promise.all([
  readFile(new URL('../app_src/lib/operations/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../app_src/lib/operations/domain.ts', import.meta.url), 'utf8'),
  readFile(new URL('../app_src/lib/persistence/operations.ts', import.meta.url), 'utf8'),
  readFile(
    new URL(
      '../app_src/lib/persistence/operationShadowFulfillmentPreparation.ts',
      import.meta.url,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      '../app_src/components/operations/OperationsSection.tsx',
      import.meta.url,
    ),
    'utf8',
  ),
])

for (const fragment of [
  "'prepare_fulfillment'",
  'fulfillmentPreparation: OperationsShadowFulfillmentPreparation | null',
  'providerWriteCount: 0',
  'postagePurchaseCount: 0',
  'labelWriteCount: 0',
  'commerceWriteCount: 0',
]) {
  assert.ok(typesSource.includes(fragment), `types missing ${fragment}`)
}

for (const fragment of [
  "input.activationState !== 'shadow'",
  "input.sourceProvider !== 'shopify'",
  'input.shadowPreparationReady !== true',
  "action: 'prepare_fulfillment'",
  "label: 'Prepare shipment in Shadow'",
]) {
  assert.ok(domainSource.includes(fragment), `domain missing ${fragment}`)
}

for (const fragment of [
  'readShadowFulfillmentPreparation(organizationId, row.id)',
  'readShadowExecutionContext(client',
  'sourceProvider: row.source_provider',
  'openExceptionCount: Number(row.exception_count)',
  'shadowPreparationReady',
  'shadowPreparationBlockedReason',
  'fulfillmentPreparation,',
]) {
  assert.ok(persistenceSource.includes(fragment), `workspace mapper missing ${fragment}`)
}

for (const fragment of [
  'FROM operations_fulfillment_executions execution',
  'JOIN operations_shipment_groups shipment_group',
  'JOIN operations_pack_rate_variances variance',
  'AS estimated_checkout_variance_minor',
  'FROM operations_fulfillment_execution_rate_attempts attempt',
  "attempt_status: 'succeeded' | 'degraded'",
  'OPERATIONS_SHADOW_PREPARATION_EFFECTS_INVALID',
  'allocation.comparison_product_key',
  'providerVariantId: allocation.comparison_product_key',
  'OPERATIONS_SHADOW_PREPARATION_COMPARISON_IDENTITY_INVALID',
]) {
  assert.ok(
    preparationReadSource.includes(fragment),
    `durable preparation read missing ${fragment}`,
  )
}

for (const fragment of [
  'Prepare shipment in Shadow',
  "action: 'prepare-shipment-execution'",
  "'Idempotency-Key': prepareFulfillmentIdempotencyKey",
  'expectedRowVersion: detail.rowVersion',
  'Shadow shipment preparation',
  'Checkout evidence',
  'Pre-label fulfillment evidence',
  'Estimated variance',
  'Estimated carrier-cost change',
  'Estimated checkout-charge variance',
  'Sandbox carrier attempts',
  'Provider writes',
  'Postage purchases',
  'Label writes',
  'Commerce writes',
  'Provider variant {allocation.providerVariantId}',
  'Stage product {allocation.productGlobalId}',
  'No shipment, tracking number, carrier',
  'label, postage purchase, commerce write, or final packing slip exists.',
  "activationState === 'shadow' || order.fulfillmentPreparation",
  'Connect and verify a TEST ${selectedRate.carrier} account first.',
  "!activeLabel && (",
  'const createBlockedReason = !canExecute',
  'const authorizedPackageCreateBlockedReason = !canExecute',
  'const voidBlockedReason = !canExecute',
  'You do not have permission to purchase carrier labels.',
  'You do not have permission to void carrier labels.',
  'sandboxCommerceE2eAuthorization',
  "action: 'authorize-sandbox-commerce-e2e'",
  'confirmationStatement: SANDBOX_COMMERCE_E2E_CONFIRMATION',
  'packageGlobalId: createLabelPackageGlobalId || undefined',
  'sandboxE2eAuthorizationGlobalId: createLabelPackageGlobalId',
  'detail.sandboxCommerceE2eAuthorization?.authorizationGlobalId',
  'onClick={() => onCreateSandboxLabel(item.globalId)}',
  'onClick={() => onCreateSandboxLabel()}',
  'disabled={busy || Boolean(voidBlockedReason)}',
  "gridTemplateColumns: { xs: 'minmax(0, 1fr)'",
  "overflowWrap: 'anywhere'",
  "overflowX: 'hidden'",
  "description: 'Emergency override for automatic commerce mirroring and activation-gated connected-order execution. Existing evidence remains viewable.'",
  "description: 'Legacy execution-safety profile. Explicit Store sync choices remain independent.'",
  "description: 'Allows viewing, health checks, reconciliation, evidence export, and explicitly confirmed zero-provider-write corrections; Store sync remains independently controlled.'",
  "description: 'Allows approved legacy execution commands. Store sync is controlled separately after an explicit choice.'",
  "anchorOrigin: { vertical: 'bottom', horizontal: 'right' }",
  "transformOrigin: { vertical: 'top', horizontal: 'right' }",
  "variant: 'menu'",
  "maxHeight: 'min(360px, calc(100dvh - 24px))'",
  "overscrollBehavior: 'contain'",
  "'aria-label': 'Advanced Operations safety statuses'",
  'renderValue: (selected) => ACTIVATION_OPTIONS.find(',
]) {
  assert.ok(uiSource.includes(fragment), `Shadow evidence UI missing ${fragment}`)
}

for (const fragment of [
  '<DetailSection title="Test fulfillment">',
  'Uses connected TEST carrier accounts. No live postage will be purchased.',
  'Create one test label per package.',
  'Fulfillment review saved. Shopify customer notification remains off.',
]) {
  assert.ok(uiSource.includes(fragment), `operator fulfillment copy missing ${fragment}`)
}

for (const fragment of [
  '<DetailSection title="Sandbox fulfillment">',
  'Create one sandbox label for each exact package.',
  'under authorization',
  'pack-to-ship validation',
]) {
  assert.equal(
    uiSource.includes(fragment),
    false,
    `normal operator UI must not expose internal test copy: ${fragment}`,
  )
}

assert.equal(
  uiSource.includes('Controls whether Operations is disabled, validating mock flows'),
  false,
  'the compact activation control must not repeat a universal tooltip explanation',
)

assert.equal(
  uiSource.includes('activeExecutionRequiredReason'),
  false,
  'sandbox label actions must not depend on hidden global activation state',
)
assert.equal(
  uiSource.includes('carrier-label-active-mode-required'),
  false,
  'the UI must not present global Active mode as a sandbox label prerequisite',
)
const createGate = uiSource.indexOf(
  'const createBlockedReason = !canExecute',
)
const authorizedCreateGate = uiSource.indexOf(
  'const authorizedPackageCreateBlockedReason = !canExecute',
  createGate,
)
const voidGate = uiSource.indexOf(
  'const voidBlockedReason = !canExecute',
  authorizedCreateGate,
)
assert.ok(
  createGate >= 0
    && authorizedCreateGate > createGate
    && voidGate > authorizedCreateGate,
  'create and void label gates must prioritize exact execution permission and evidence',
)

const shippingExecution = uiSource.indexOf(
  '<DetailSection title="Shipping execution">',
)
const voidButton = uiSource.indexOf('onClick={onVoidSandboxLabel}', shippingExecution)
const authorizedCreateButton = uiSource.indexOf(
  'onClick={() => onCreateSandboxLabel(item.globalId)}',
  shippingExecution,
)
const createButton = uiSource.indexOf(
  'onClick={() => onCreateSandboxLabel()}',
  shippingExecution,
)
assert.ok(
  shippingExecution >= 0
    && authorizedCreateButton > shippingExecution
    && voidButton > authorizedCreateButton
    && createButton > voidButton,
  'authorized and legacy sandbox label actions must remain in Shipping execution',
)

const shadowEvidenceCondition =
  "(activationState === 'shadow' || order.fulfillmentPreparation)"
const shadowEvidence = uiSource.indexOf(shadowEvidenceCondition)
const shadowEvidenceSection = uiSource.indexOf(
  '<DetailSection title="Shadow shipment preparation">',
  shadowEvidence,
)
assert.ok(
  shadowEvidence >= 0 && shadowEvidenceSection > shadowEvidence,
  'durable Shadow preparation must remain visible after activation changes',
)

const panelStart = uiSource.indexOf('function ShadowFulfillmentPreparationPanel')
const panelEnd = uiSource.indexOf('function OrderDetailDrawer', panelStart)
assert.ok(panelStart >= 0 && panelEnd > panelStart, 'Shadow panel boundary missing')
const panelSource = uiSource.slice(panelStart, panelEnd)
for (const forbidden of ['Realized', 'realized margin', 'MUD', 'billed variance']) {
  assert.equal(
    panelSource.includes(forbidden),
    false,
    `Shadow panel must not present ${forbidden} as a final fact`,
  )
}

console.log('Shadow fulfillment-preparation evidence UI contract passed.')
