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
  "activationState !== 'active'",
  'Order label create and void actions require Operations Active mode.',
  'Shipping Settings → Sandbox / Developer',
  'data-testid="carrier-label-active-mode-required"',
  "!activeLabel && (",
  "!activeExecutionRequiredReason ? (",
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
  "description: 'Stops Operations; only health and migration checks remain.'",
  "description: 'Validates workflows and stores read evidence with no provider writes.'",
  "description: 'Allows viewing, health checks, reconciliation, and evidence export only.'",
  "description: 'Allows approved commands and provider actions. Select Shadow first.'",
  "description: 'Keeps evidence viewable while stopping new consequential work.'",
  "anchorOrigin: { vertical: 'bottom', horizontal: 'right' }",
  "transformOrigin: { vertical: 'top', horizontal: 'right' }",
  "variant: 'menu'",
  "maxHeight: 'min(360px, calc(100dvh - 24px))'",
  "overscrollBehavior: 'contain'",
  "'aria-label': 'Operations activation statuses'",
  'renderValue: (selected) => ACTIVATION_OPTIONS.find(',
]) {
  assert.ok(uiSource.includes(fragment), `Shadow evidence UI missing ${fragment}`)
}

assert.equal(
  uiSource.includes('Controls whether Operations is disabled, validating mock flows'),
  false,
  'the compact activation control must not repeat a universal tooltip explanation',
)

const activeModeReason = uiSource.indexOf(
  "const activeExecutionRequiredReason = activationState !== 'active'",
)
const createGate = uiSource.indexOf(
  'const createBlockedReason = activeExecutionRequiredReason',
  activeModeReason,
)
const voidGate = uiSource.indexOf(
  'const voidBlockedReason = activeExecutionRequiredReason',
  activeModeReason,
)
assert.ok(
  activeModeReason >= 0
    && createGate > activeModeReason
    && voidGate > createGate,
  'create and void label gates must both prioritize exact Active mode',
)

const shippingExecution = uiSource.indexOf(
  '<DetailSection title="Shipping execution">',
)
const activeModeAlert = uiSource.indexOf(
  'data-testid="carrier-label-active-mode-required"',
  shippingExecution,
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
    && activeModeAlert > shippingExecution
    && authorizedCreateButton > activeModeAlert
    && voidButton > authorizedCreateButton
    && createButton > voidButton,
  'the visible Active-mode explanation must precede authorized and legacy label actions',
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
