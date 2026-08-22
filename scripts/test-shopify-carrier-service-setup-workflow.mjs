#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const setupRoute = read(
  'app_src/app/api/integrations/commerce/shopify/carrier-service/route.ts',
)
const publicCallbackRoute = read(
  'app_src/app/api/integrations/commerce/shopify/carrier-service/'
  + '[accountGlobalId]/[token]/route.ts',
)
const setupPanel = read(
  'app_src/components/settings/ShopifyCarrierServiceSetupPanel.tsx',
)
const commercePanel = read(
  'app_src/components/settings/CommerceIntegrationPanel.tsx',
)
const setupPersistence = read(
  'app_src/lib/persistence/shopifyCarrierServiceSetup.ts',
)
const checkoutRatingPersistence = read(
  'app_src/lib/persistence/shopifyCheckoutRating.ts',
)
const callbackExecution = read(
  'app_src/lib/integrations/shopifyCarrierServiceCallback.ts',
)
const operationsPersistence = read(
  'app_src/lib/persistence/operations.ts',
)
const commerceIntegrations = read(
  'app_src/lib/integrations/commerceIntegrations.ts',
)
const shopifyCommerceClient = read(
  'app_src/lib/integrations/shopifyCommerceClient.ts',
)
const checkoutMigration = read(
  'db/migrations/0149_operations_shopify_checkout_rating.sql',
)
const mutationMigration = read(
  'db/migrations/0150_operations_shopify_carrier_service_mutation_authorization.sql',
)
const activeMutationMigration = read(
  'db/migrations/0156_operations_shopify_carrier_service_active_authorization.sql',
)
const receiptAuthorityMigration = read(
  'db/migrations/0159_operations_shopify_receipt_and_carrier_authority.sql',
)
const nameAlignmentMigration = read(
  'db/migrations/0166_shopify_carrier_service_name_alignment.sql',
)
const configuredCarriersMigration = read(
  'db/migrations/0285_shopify_carrier_service_configured_carriers.sql',
)
const checkoutRateControlMigration = read(
  'db/migrations/0299_operations_shopify_checkout_rate_control.sql',
)
const simulationRuntimeReadinessMigration = read(
  'db/migrations/0317_operations_shopify_carrier_service_simulation_runtime_readiness.sql',
)
const checkoutRateControlDomain = read(
  'app_src/lib/operations/shopifyCheckoutRateControl.ts',
)
const mutationAuthorizationPersistence = read(
  'app_src/lib/persistence/shopifyCarrierServiceMutationAuthorization.ts',
)
const healthRoute = read('app_src/app/api/health/route.ts')
const predeployVerification = read('scripts/verify-predeploy.mjs')
const externalEffectsPersistence = read(
  'app_src/lib/persistence/commerceExternalEffects.ts',
)
const distributedOperationsContract = read(
  'docs/modules/distributed-operations.md',
)
const userIntegrationsContract = read(
  'docs/modules/user-integrations.md',
)
const proxy = read('app_src/proxy.ts')

requireAll(setupPersistence, [
  'carrier.allow_sender_billing',
  'carrier.registered_address_fingerprint',
  'integration.configuration',
  'matchingWarehouseGlobalIds',
  'readinessIssues: carrierReadinessIssues(row)',
  "'sender_billing_not_allowed'",
  "'production_rate_not_authorized'",
], 'checkout account readiness projection')
requireAll(setupPanel, [
  'const directRateCarriers = useMemo(',
  'const carrierIssues = (',
  "'origin_does_not_match_warehouse'",
  '(!checked && (atLimit || issues.length > 0))',
  'selectedRuntimeBindings.every((binding) => (',
], 'checkout account selection truth')

function requireAll(source, contracts, surface) {
  for (const contract of contracts) {
    assert.ok(
      source.includes(contract),
      `${surface} is missing required contract: ${contract}`,
    )
  }
}

function actionBranch(action, nextAction) {
  const start = setupRoute.indexOf(`action === '${action}'`)
  assert.notEqual(start, -1, `setup API is missing the ${action} action`)
  const end = nextAction
    ? setupRoute.indexOf(`action === '${nextAction}'`, start + 1)
    : setupRoute.indexOf('} else {', start + 1)
  assert.ok(end > start, `setup API ${action} action boundary is invalid`)
  return setupRoute.slice(start, end)
}

function requireOrder(source, before, after, surface) {
  const beforeIndex = source.indexOf(before)
  const afterIndex = source.indexOf(after)
  assert.ok(
    beforeIndex >= 0 && afterIndex > beforeIndex,
    `${surface} must place ${before} before ${after}`,
  )
}

requireAll(setupRoute, [
  'const MAX_REQUEST_BYTES = 32 * 1024',
  'const actor = await requireRequestUser(req)',
  'const capabilities = operationsCapabilities(actor)',
  'if (!capabilities.canManage)',
  'organizationId: activeOperationsOrganizationId(actor)',
  'const context = await actorContext(req)',
  "'Cache-Control': 'private, no-store'",
  "Vary: 'Cookie'",
], 'authenticated setup API')
assert.equal(
  (setupRoute.match(/const context = await actorContext\(req\)/g) || []).length,
  2,
  'both setup GET and POST must resolve the authenticated actor context',
)

const actions = [
  ['save-config', 'save-checkout-rate-control'],
  ['save-checkout-rate-control', 'save-plan-rate-policy'],
  ['save-plan-rate-policy', 'save-checkout-audience'],
  ['save-checkout-audience', 'save-rate-warm-policy'],
  ['save-rate-warm-policy', 'save-name-preference'],
  ['save-name-preference', 'simulate-registration'],
  ['simulate-registration', 'simulate-name-alignment'],
  ['simulate-name-alignment', 'align-registration-name'],
  ['align-registration-name', 'register'],
  ['recover-mutation', null],
]
for (const [action, nextAction] of actions) {
  actionBranch(action, nextAction)
}
const providerMutationStart = setupRoute.indexOf(
  "action === 'register' || action === 'unregister'",
)
const providerMutationEnd = setupRoute.indexOf(
  "} else if (action === 'recover-mutation')",
  providerMutationStart,
)
assert.ok(
  providerMutationStart >= 0 && providerMutationEnd > providerMutationStart,
  'setup API is missing the combined register/unregister action boundary',
)
const providerMutation = setupRoute.slice(
  providerMutationStart,
  providerMutationEnd,
)
for (const action of [
  'save-config',
  'save-checkout-rate-control',
  'save-plan-rate-policy',
  'save-rate-warm-policy',
  'save-name-preference',
  'simulate-registration',
  'simulate-name-alignment',
  'align-registration-name',
  'recover-mutation',
]) {
  assert.ok(
    setupPanel.includes(`'${action}'`),
    `setup panel is not wired to the ${action} action`,
  )
}

requireAll(setupPanel, [
  'ShopifyCheckoutRateControlHttpError',
  'shopifyCheckoutRateControlPendingResolution',
  "resolution === 'applied'",
  "resolution === 'definitive_rejection'",
  'clearPendingRateControlCommand()',
  'The exact command remains saved for retry.',
], 'checkout-rate control lost-response recovery')

for (const obsoleteActivationLatch of [
  'repair-activation-revision-binding',
  'activeRevisionBindingRequired',
  'repairShopifyCarrierServiceActiveRevisionBindingInPostgres({',
]) {
  assert.equal(
    setupRoute.includes(obsoleteActivationLatch)
      || setupPanel.includes(obsoleteActivationLatch),
    false,
    `checkout setup must not expose the obsolete global activation latch ${obsoleteActivationLatch}`,
  )
}
for (const obsoleteShadowTransitionMutation of [
  'lockShopifyCarrierServiceConfigWritersForActivationWithClient(',
  'rebindRegisteredShopifyCarrierServicesForShadowActivationWithClient(',
  'carrierServiceRebindings: shadowCarrierServiceRebindings.map(',
]) {
  assert.equal(
    operationsPersistence.includes(obsoleteShadowTransitionMutation),
    false,
    `Operations mode changes must not mutate checkout configuration via ${obsoleteShadowTransitionMutation}`,
  )
}
requireAll(operationsPersistence, [
  "if (input.state === 'shadow')",
  '`commerce-active-transition:${organizationId}`',
], 'global transition serialization without checkout config mutation')
const shadowActivationStart = operationsPersistence.indexOf(
  'export async function updateOperationsActivationInPostgres(',
)
const shadowActivationEnd = operationsPersistence.indexOf(
  'async function readException(',
  shadowActivationStart,
)
const shadowActivation = operationsPersistence.slice(
  shadowActivationStart,
  shadowActivationEnd,
)
assert.ok(
  shadowActivation.indexOf('commerce-active-transition:')
    < shadowActivation.indexOf('FOR UPDATE'),
  'Shadow activation must acquire commerce/config serialization before locking activation',
)

const saveConfig = actionBranch('save-config', 'save-checkout-rate-control')
requireAll(saveConfig, [
  'requireActivator(context.capabilities.canActivate)',
  'updateRegisteredShopifyCarrierServiceRateSourcesInPostgres({',
  "current.config?.registrationState === 'registered'",
  'expectedRowVersion: current.config.rowVersion',
  "warehouseGlobalId: String(body.warehouseGlobalId || ''),",
  'materials,',
  'normalizeShopifyCheckoutPlanRatePolicy(',
  'body.planRateOptimization',
  "Object.prototype.hasOwnProperty.call(\n        body,\n        'planRateOptimization',",
  'current.config.planRateOptimization',
  'const planRateOptimization',
  'upsertShopifyCarrierServiceConfigInPostgres({',
  'callbackTokenHash: tokenHash(token)',
  'actorEmail: context.actor.email',
], 'save-config action')
assert.doesNotMatch(
  saveConfig,
  /body\.checkoutRateControl/u,
  'save-config must not bypass the dedicated receipt-backed rate-control command',
)

const saveCheckoutRateControl = actionBranch(
  'save-checkout-rate-control',
  'save-plan-rate-policy',
)
requireAll(saveCheckoutRateControl, [
  'requireActivator(context.capabilities.canActivate)',
  'requireExactBodyFields(body, [',
  "'expectedConfigGlobalId'",
  "'expectedRowVersion'",
  "'expectedPolicyRevision'",
  "'checkoutRateControl'",
  "'reason'",
  'updateShopifyCarrierServiceRateControlInPostgres({',
  'expectedConfigGlobalId: configGlobalId(',
  'expectedPolicyRevision: integer(',
  'normalizeShopifyCheckoutRateControl(',
  'rateControlIdempotencyKey(req)',
  'return json({ ok: true, result })',
], 'idempotent desired checkout-rate control action')

const savePlanRatePolicy = actionBranch(
  'save-plan-rate-policy',
  'save-rate-warm-policy',
)
requireAll(savePlanRatePolicy, [
  'requireActivator(context.capabilities.canActivate)',
  "Object.prototype.hasOwnProperty.call(\n          body,\n          'planRateOptimization',",
  'normalizeShopifyCheckoutPlanRatePolicy(',
  'updateShopifyCarrierServicePlanRatePolicyInPostgres({',
  'expectedRowVersion: current.config.rowVersion',
  'actorEmail: context.actor.email',
], 'registered-safe plan-rate policy action')
assert.doesNotMatch(
  savePlanRatePolicy,
  /reference\.activation\.state\s*!==\s*'shadow'/u,
  'local plan-rate configuration must not require Shadow',
)

const saveRateWarmPolicy = actionBranch(
  'save-rate-warm-policy',
  'save-name-preference',
)
requireAll(saveRateWarmPolicy, [
  'requireActivator(context.capabilities.canActivate)',
  "Object.prototype.hasOwnProperty.call(\n          body,\n          'checkoutRateWarm',",
  'normalizeShopifyCheckoutRateWarmPolicy(',
  'updateShopifyCarrierServiceRateWarmPolicyInPostgres({',
  'expectedRowVersion: current.config.rowVersion',
  'actorEmail: context.actor.email',
], 'registered-safe rate-warm policy action')
assert.doesNotMatch(
  saveRateWarmPolicy,
  /reference\.activation\.state\s*!==\s*'shadow'/u,
  'desired cache-preparation configuration must not require Shadow',
)

requireAll(checkoutRatingPersistence, [
  'updateShopifyCarrierServicePlanRatePolicyInPostgres(',
  'policy_revision = policy_revision + 1',
  'policy_hash = $3',
  'policy_snapshot = $4::jsonb',
  'row_version = row_version + 1',
  'providerRegistrationRetained: true',
  'callbackTokenVersionRetained:',
], 'policy-only optimistic persistence')
const policyOnlyPersistenceStart = checkoutRatingPersistence.indexOf(
  'export async function updateShopifyCarrierServicePlanRatePolicyInPostgres(',
)
const policyOnlyPersistenceEnd = checkoutRatingPersistence.indexOf(
  'export async function updateShopifyCarrierServiceRateWarmPolicyInPostgres(',
  policyOnlyPersistenceStart,
)
assert.ok(
  policyOnlyPersistenceStart >= 0
    && policyOnlyPersistenceEnd > policyOnlyPersistenceStart,
  'policy-only persistence function boundary is invalid',
)
const policyOnlyPersistence = checkoutRatingPersistence.slice(
  policyOnlyPersistenceStart,
  policyOnlyPersistenceEnd,
)
for (const forbiddenMutation of [
  'service_gid =',
  'registration_state =',
  'callback_token_version =',
  'callback_token_hash =',
  'warehouse_id =',
]) {
  assert.equal(
    policyOnlyPersistence.includes(forbiddenMutation),
    false,
    `policy-only persistence must not mutate ${forbiddenMutation}`,
  )
}

requireAll(checkoutRatingPersistence, [
  'updateShopifyCarrierServiceRateWarmPolicyInPostgres(',
  "current.account_status !== 'active'",
  "current.verification_status !== 'verified'",
  'readShopifyCheckoutRateControl(current.policy_snapshot, {',
  'checkoutRateWarm: input.checkoutRateWarm',
  'policy_revision = policy_revision + 1',
  'policy_hash = $3',
  'row_version = row_version + 1',
  'providerRegistrationRetained: true',
], 'profile-independent desired rate-warm policy persistence')

requireAll(setupPanel, [
  'planRateOptimization: PlanRateOptimization',
  'setPlanRateOptimization({',
  'next.config?.planRateOptimization',
  'planRateOptimization,',
  'Whole-shipment carton and rate objective',
  'Optimization priority',
  'Candidate plan limit',
  'Handling cost per package (minor units)',
  'Handling cost currency (ISO 4217)',
  "'save-plan-rate-policy'",
  'Save rate objective only',
], 'checkout plan-rate policy UI round trip')

requireAll(setupRoute, [
  'checkoutRateWarm: readShopifyCheckoutRateWarmPolicy(',
  'rateWarmReadiness: {',
  'deliveryCustomizationDurable: false',
  'activationAllowed: checkoutRateWarmEffective',
  'readShopifyCustomerRatePolicySummaryFromPostgres({',
  'customerPolicySummary.checkoutEligibleCount < 1',
  'at least one eligible local customer policy in Checkout audience',
  'customerPolicySummary.earliestShadowExpiresAt',
  'Bounded saved-address cache preparation is available without a customer allow policy.',
  'Bounded cache preparation is available only for an allowed customer',
  'Shopify does not guarantee Customer GID in CarrierService callbacks',
  'successful-rate cache is customer-neutral',
  'not deterministic customer enforcement',
  "shadowCheckoutAudienceMode === 'restricted_customers'",
  'checkoutRateWarmBlockers.join',
], 'public rate-warm policy and truthful readiness')
assert.equal(
  setupRoute.includes('hasValidShopifyShadowVariantAllowlist()'),
  false,
  'checkout setup must not claim an unimplemented variant allowlist',
)

requireAll(setupRoute, [
  'checkoutAudience: {',
  "'shadow_off'",
  "'shadow_all_eligible_ready'",
  "'shadow_restricted_ready'",
  "'shadow_customer_required'",
  'mode: shadowCheckoutAudienceMode',
  'shadowAllowedCustomerCount: customerPolicySummary.shadowAllowedCount',
  'eligibleCustomerCount: customerPolicySummary.checkoutEligibleCount',
  'shadowBinaryTestReady: checkoutAccountReady',
  'providerEnforcementAvailable:',
  'limited-visibility public app or a custom app on Shopify Plus',
], 'checkout-audience readiness projection')

requireAll(setupPanel, [
  'checkoutRateWarm: CheckoutRateWarmPolicy',
  'next.config?.checkoutRateWarm',
  'Saved-address rate cache preparation',
  'Processes every distinct complete U.S. saved destination in the',
  'background to prime Shopify&apos;s checkout-rate cache.',
  'browser emits aggregate counts only.',
  'All-eligible cache preparation skips the customer allow-policy lookup.',
  'Checkout rates are Off. Cache preparation is disabled and does not request a Shopify Admin token',
  'Restricted cache preparation requires a signed-in customer with an unexpired allow policy',
  'Enable saved-address rate cache preparation',
  'Storefront mode (v1)',
  'Shopify hosted AJAX',
  'Version 1 warms rates through Shopify hosted Online Store AJAX endpoints.',
  'all_saved_rate_zones',
  'Version 1 processes every distinct complete U.S. saved destination in the background; addresses are never silently truncated.',
  'Supported country (v1)',
  'United States (US)',
  'Version 1 supports United States destinations only.',
  'Abort queued work when the cart changes (required)',
  "'save-rate-warm-policy'",
  'Save cache-preparation policy only',
], 'checkout rate-warm policy UI round trip')
requireAll(setupPanel, [
  "key: 'audience'",
  'Choose checkout audience and rate source',
  'Set the account-level desired audience and explicit TEST or LIVE carrier lane.',
  'Desired audience',
  'Desired source',
  'Off — return no ClawPilot rates',
  'Restricted customers — require an exact local policy',
  'All eligible checkouts',
  'Save desired checkout controls',
  'Eligible restricted customers',
  'Reason for this change',
  'Required and retained with the immutable control revision.',
  'SHOPIFY_CHECKOUT_RESTRICTED_LIVE_ENFORCEMENT_REQUIRED',
  'limited-visibility public app or a custom app on Shopify Plus',
  'Refresh checkout-audience status',
  "key: 'rate-warm'",
  "key: 'evidence'",
  'Use a signed-in Shopify customer covered by an unexpired Checkout audience allow policy',
], 'ordered checkout-audience prerequisite')
requireAll(setupPanel, [
  'Current operating profile',
  'const callbackServingReady = Boolean(',
  'Off · authenticated empty-rate response',
  'Store sync is independently controlled here. Pausing stops',
  'new provider catalog, order,',
  'existing mirrored data',
  'Desired Restricted · LIVE blocked pending verified provider enforcement',
  'Desired TEST source · production store effective empty',
  'Disabled or Frozen makes new authenticated callbacks empty',
  'response for up to 15 minutes',
  'Advanced safety · ${operatingActivation}',
  'Store sync',
  'Checkout rates',
  'Order execution',
  'sandbox store',
  'production store',
  'Rating only; checkout rating never buys postage or creates a',
  'Training and live store writeback are separate order paths.',
], 'derived operating-profile summary')
requireOrder(
  setupPanel,
  "key: 'audience'",
  "key: 'rate-warm'",
  'checkout setup journey',
)
requireOrder(
  setupPanel,
  "key: 'rate-warm'",
  "key: 'evidence'",
  'checkout setup journey',
)
assert.equal(
  /[A-Z0-9._%+-]+@episcs\.com/iu.test(setupPanel),
  false,
  'generic Shopify setup copy must not contain tenant customer email addresses',
)
assert.equal(
  setupPanel.includes('Headless Storefront API'),
  false,
  'checkout rate-warm v1 UI must not advertise unimplemented headless warming',
)
assert.equal(
  setupPanel.includes('label="Supported countries"'),
  false,
  'checkout rate-warm v1 UI must not expose unsupported country editing',
)

const saveNamePreference = actionBranch(
  'save-name-preference',
  'simulate-registration',
)
requireAll(saveNamePreference, [
  'requireActivator(context.capabilities.canActivate)',
  'await refreshShopifyIdentity()',
  "'SHOPIFY_CARRIER_SERVICE_CONFIG_REQUIRED'",
  'authorization.reconciliationRequired',
  'authorization.outcome?.state === \'unknown\'',
  "'SHOPIFY_CARRIER_SERVICE_NAME_CHANGE_BLOCKED'",
  'updateShopifyCarrierServiceBrandNameOverrideInPostgres({',
  'expectedRowVersion: current.config.rowVersion',
  'checkoutBrandNameOverride:',
  'checkoutBrandNameOverride(',
  'body.checkoutBrandNameOverride',
  'actorEmail: context.actor.email',
], 'audited checkout-name preference action')
requireOrder(
  saveNamePreference,
  'await refreshShopifyIdentity()',
  'updateShopifyCarrierServiceBrandNameOverrideInPostgres({',
  'save-name-preference identity refresh',
)

const simulation = actionBranch(
  'simulate-registration',
  'simulate-name-alignment',
)
requireAll(simulation, [
  'await refreshShopifyIdentity()',
  "current.reference.activation.state === 'missing'",
  'current.reference.activation.revision === null',
  "current.config.registrationState === 'registered'",
  "? 'delete'",
  ": 'create'",
  "operation === 'create'",
  "mode: 'shadow'",
  'executeShopifyCarrierServiceRegistration({',
  'activationRevision: current.reference.activation.revision',
  'idempotencyKey: shadowSimulationIdempotencyKey({',
  'finalizeShopifyCarrierServiceRegistrationInPostgres({',
  "registrationState: 'shadow_simulated'",
  'const exactConfig = publicCarrierServiceConfig(',
  'finalized,',
  'current.reference.activation.state,',
], 'simulate-registration action')
assert.doesNotMatch(
  simulation,
  /SHOPIFY_CARRIER_SERVICE_PRODUCTION_CREATE_BLOCKED/u,
  'zero-write production registration simulation must remain available',
)
requireOrder(
  simulation,
  'await refreshShopifyIdentity()',
  'carrierServiceMutation({',
  'simulate-registration identity refresh',
)
requireAll(simulation, [
  'shopifyCarrierServiceRegistrationRequestHash(mutation)',
  'requestHash,',
], 'request-hash-fenced create/delete Shadow simulation')
assert.ok(
  (simulation.match(/requestHash,/g) || []).length >= 2,
  'both initial and post-finalization registration simulations must carry the exact request hash',
)
assert.ok(
  (
    simulation.match(
      /await executeShopifyCarrierServiceRegistration\(\{/g,
    ) || []
  ).length >= 2,
  'create simulation must retain exact zero-write evidence for the final configuration row',
)

const nameSimulation = actionBranch(
  'simulate-name-alignment',
  'align-registration-name',
)
requireAll(nameSimulation, [
  'requireActivator(context.capabilities.canActivate)',
  'await refreshShopifyIdentity()',
  '!current.nameAlignment',
  "current.config.registrationState !== 'registered'",
  'current.reference.activation.revision === null',
  "'SHOPIFY_CARRIER_SERVICE_NAME_SIMULATION_STALE'",
  "operation: 'update'",
  'storeEntityName: current.namePreference.effectiveName',
  'shopifyCarrierServiceRegistrationRequestHash(mutation)',
  "mode: 'shadow'",
  "operation: 'update'",
  'requestHash,',
], 'exact zero-write name-alignment simulation')
requireOrder(
  nameSimulation,
  'await refreshShopifyIdentity()',
  'carrierServiceMutation({',
  'simulate-name-alignment identity refresh',
)
assert.ok(
  nameSimulation.indexOf(
    'shopifyCarrierServiceRegistrationRequestHash(mutation)',
  ) < nameSimulation.indexOf(
    'executeShopifyCarrierServiceRegistration({',
  ),
  'the name-alignment request hash must be fixed before Shadow evidence is recorded',
)

const alignName = actionBranch(
  'align-registration-name',
  'register',
)
requireAll(alignName, [
  'requireActivator(context.capabilities.canActivate)',
  'await refreshShopifyIdentity()',
  'body.confirmProviderWrite !== true',
  "'SHOPIFY_CARRIER_SERVICE_PROVIDER_WRITE_CONFIRMATION_REQUIRED'",
  '!current.nameAlignment?.simulation',
  "current.config.registrationState !== 'registered'",
  'checkoutCarrierServiceProviderWriteAuthority(',
  "'SHOPIFY_CARRIER_SERVICE_NAME_SIMULATION_EVIDENCE_REQUIRED'",
  'body.confirmProductionProviderWrite !== true',
  "'SHOPIFY_CARRIER_SERVICE_PRODUCTION_CONFIRMATION_REQUIRED'",
  'executeResourceScopedCarrierServiceMutation({',
  'storeEntityName: current.namePreference.effectiveName',
  "operation: 'update'",
  'simulation: current.nameAlignment.simulation',
  'confirmationRequestId(',
], 'confirmed in-place name-only update action')
requireOrder(
  alignName,
  'await refreshShopifyIdentity()',
  'executeResourceScopedCarrierServiceMutation({',
  'align-registration-name identity refresh',
)

requireAll(providerMutation, [
  "action === 'register' || action === 'unregister'",
  'await refreshShopifyIdentity()',
  'body.confirmProviderWrite !== true',
  "'SHOPIFY_CARRIER_SERVICE_PROVIDER_WRITE_CONFIRMATION_REQUIRED'",
  "action === 'register' ? 'create' : 'delete'",
  'checkoutCarrierServiceProviderWriteAuthority(',
  '!current.shadowSimulation',
  'current.shadowSimulation.configRowVersion',
  "'SHOPIFY_CARRIER_SERVICE_SIMULATION_EVIDENCE_REQUIRED'",
  'body.confirmProductionProviderWrite !== true',
  'executeResourceScopedCarrierServiceMutation({',
  'confirmationRequestId(',
], 'revision-fenced register and unregister actions')
requireAll(setupRoute, [
  "!['shadow', 'read_only', 'active'].includes(input.state)",
  "'SHOPIFY_CARRIER_SERVICE_PROVIDER_WRITE_SAFETY_BLOCKED'",
  'CarrierService provider changes are blocked while Operations is Disabled or Frozen',
], 'resource-scoped provider-write safety helper')
requireOrder(
  providerMutation,
  'await refreshShopifyIdentity()',
  'executeResourceScopedCarrierServiceMutation({',
  'register/unregister identity refresh',
)

const refreshIdentityStart = setupRoute.indexOf(
  'const refreshShopifyIdentity = async () => {',
)
const refreshIdentityEnd = setupRoute.indexOf(
  '\n    }\n\n    if (action ===',
  refreshIdentityStart,
)
assert.ok(
  refreshIdentityStart >= 0 && refreshIdentityEnd > refreshIdentityStart,
  'setup API is missing the fresh Shopify identity helper',
)
const refreshIdentity = setupRoute.slice(
  refreshIdentityStart,
  refreshIdentityEnd,
)
requireAll(refreshIdentity, [
  'testCommerceConnection({',
  'organizationId: context.organizationId',
  'accountGlobalId: accountId',
  'actorEmail: context.actor.email',
  'current = await setupState({',
], 'read-only Shopify identity refresh')
requireOrder(
  refreshIdentity,
  'testCommerceConnection({',
  'current = await setupState({',
  'identity refresh then state reload',
)
requireAll(commerceIntegrations, [
  'const probe = await probeShopifyConnection({',
  'accountName: probe.shopName',
  'lastVerifiedAt: new Date().toISOString()',
  'if (probe.shopId !== runtime.externalAccountId)',
], 'verified Shopify identity refresh implementation')
const connectionProbeQuery = shopifyCommerceClient.slice(
  shopifyCommerceClient.indexOf(
    'const SHOPIFY_CONNECTION_PROBE_QUERY =',
  ),
  shopifyCommerceClient.indexOf(
    'function probeShopName(',
  ),
)
requireAll(connectionProbeQuery, [
  'query ClawPilotShopifyConnectionProbe',
  'shop {',
  'id',
  'myshopifyDomain',
  'name',
  'currentAppInstallation',
], 'read-only Shopify connection probe')
assert.doesNotMatch(
  connectionProbeQuery,
  /\bmutation\b/,
  'identity refresh must not perform a Shopify provider mutation',
)

const shadowKeyStart = setupRoute.indexOf(
  'function shadowSimulationIdempotencyKey(',
)
const shadowKeyEnd = setupRoute.indexOf(
  'async function exactShadowSimulation(',
  shadowKeyStart,
)
const shadowKey = setupRoute.slice(shadowKeyStart, shadowKeyEnd)
requireAll(shadowKey, [
  'requestHash: string',
  ':${input.config.rowVersion}:${input.requestHash}',
], 'request-hash-fenced Shadow idempotency key')
assert.doesNotMatch(
  shadowKey,
  /requestHash\?:/,
  'all create/update/delete Shadow idempotency keys require a request hash',
)
const exactShadowStart = shadowKeyEnd
const exactShadowEnd = setupRoute.indexOf(
  'function mutationActorRole(',
  exactShadowStart,
)
const exactShadow = setupRoute.slice(exactShadowStart, exactShadowEnd)
requireAll(exactShadow, [
  'requestHash: string',
  'requestHash: input.requestHash',
  'effect.requestHash === input.requestHash',
], 'request-hash-fenced exact Shadow lookup')
assert.doesNotMatch(
  exactShadow,
  /input\.requestHash === undefined/,
  'exact Shadow lookup must never accept an unfenced legacy simulation',
)
requireAll(setupRoute, [
  'const operationRequestHash = publicConfig && operation',
  'shopifyCarrierServiceRegistrationRequestHash(',
  'requestHash: operationRequestHash',
], 'request-hash-fenced create/delete setup-state lookup')

const activeExecutorStart = setupRoute.indexOf(
  'async function executeResourceScopedCarrierServiceMutation(',
)
const activeExecutorEnd = setupRoute.indexOf(
  'async function recoverOneTimeCarrierServiceMutation(',
  activeExecutorStart,
)
assert.ok(
  activeExecutorStart >= 0 && activeExecutorEnd > activeExecutorStart,
  'setup API is missing the exact resource-scoped mutation executor',
)
const activeExecutor = setupRoute.slice(
  activeExecutorStart,
  activeExecutorEnd,
)
requireAll(activeExecutor, [
  'shopifyCarrierServiceRegistrationRequestHash(mutation)',
  'currentRequestHash !== input.simulation.requestHash',
  "'SHOPIFY_CARRIER_SERVICE_ACTIVE_REQUEST_STALE'",
  'shopifyCarrierServiceMutationConfirmationHash({',
  'authorizeShopifyCarrierServiceMutationInPostgres({',
  'simulationActivationRevision:',
  'providerWriteActivationRevision:',
  'expiresInSeconds: 120',
  'claimShopifyCarrierServiceMutationInPostgres({',
  'executeAuthorizedShopifyCarrierServiceMutation({',
  "if (input.operation === 'update')",
  'finalizeShopifyCarrierServiceNameAlignmentInPostgres({',
  'evidenceGlobalId: outcomeGlobalId',
  'finalizeShopifyCarrierServiceConfigMutationInPostgres({',
], 'exact resource-scoped mutation executor')
assert.doesNotMatch(
  activeExecutor,
  /SHOPIFY_CARRIER_SERVICE_PRODUCTION_CREATE_BLOCKED/u,
  'confirmed production CarrierService creation must not retain the old hard block',
)
const updateFinalization = activeExecutor.slice(
  activeExecutor.indexOf("if (input.operation === 'update')"),
  activeExecutor.indexOf(
    'return finalizeShopifyCarrierServiceConfigMutationInPostgres({',
  ),
)
requireAll(updateFinalization, [
  'return finalizeShopifyCarrierServiceNameAlignmentInPostgres({',
  'expectedConfigRowVersion: input.config.rowVersion',
  'attemptGlobalId: claimed.attempt.globalId',
  'evidenceGlobalId: outcomeGlobalId',
], 'dedicated applied-name finalization')
assert.doesNotMatch(
  updateFinalization,
  /finalizeShopifyCarrierServiceConfigMutationInPostgres/,
  'name-only update evidence must use the applied-name finalizer without changing create/delete configuration identity',
)
requireAll(setupPanel, [
  'state: stepState(',
  'false,',
  'Boolean(simulated)',
], 'operation-specific provider mutation step state')
for (const [before, after] of [
  [
    'authorizeShopifyCarrierServiceMutationInPostgres({',
    'claimShopifyCarrierServiceMutationInPostgres({',
  ],
  [
    'claimShopifyCarrierServiceMutationInPostgres({',
    'executeAuthorizedShopifyCarrierServiceMutation({',
  ],
  [
    'executeAuthorizedShopifyCarrierServiceMutation({',
    'finalizeShopifyCarrierServiceNameAlignmentInPostgres({',
  ],
  [
    'executeAuthorizedShopifyCarrierServiceMutation({',
    'finalizeShopifyCarrierServiceConfigMutationInPostgres({',
  ],
]) {
  assert.ok(
    activeExecutor.indexOf(before) < activeExecutor.indexOf(after),
    `${before} must precede ${after}`,
  )
}
requireAll(setupPanel, [
  'Simulate registration',
  'Simulate exact removal',
  'read-only provider check',
  'may decrypt the saved Shopify credential and make a Shopify read request',
  'zero Shopify mutations and zero provider writes',
  'available in every Advanced safety mode',
  'Authorize exact resource registration',
  'Authorize exact resource removal',
  'one short-lived, single-use Shopify mutation',
  'Read only, Shadow, and Active may apply it; Disabled and Frozen block the provider write.',
  'confirmWrite',
  'confirmRemove',
  "run(\n                  'register'",
  "run(\n                  'unregister'",
  'confirmProviderWrite: true',
  'confirmProductionProviderWrite:',
  'globalThis.crypto.randomUUID()',
], 'all-mode simulation plus resource-scoped provider mutation workflow')
requireAll(setupPanel, [
  'registeredServiceName: string | null',
  'appliedName: string | null',
  'aligned: boolean',
  'Optional administrator checkout name',
  'Leave blank to use the verified Shopify store name',
  'Clearing a saved override restores that default.',
  "'save-name-preference'",
  'checkoutBrandNameOverride:',
  'Restore verified Shopify name',
  'Saving invalidates any prior exact simulation.',
  'Source · administrator override',
  'Source · verified Shopify store',
  "'simulate-name-alignment'",
  "'align-registration-name'",
  'confirmationRequestId:',
  'globalThis.crypto.randomUUID()',
  'CarrierService ID, callback URL, active state, and Shopify',
  'shipping-profile assignments remain unchanged.',
  '...(setup?.config ? [{',
  "key: 'carrier-service-name'",
  'inputProps={{ maxLength: 120 }}',
  'Provider-confirmed applied name',
  "value: nameAlignment?.appliedName || 'Not yet confirmed'",
], 'verified-store default and administrator override workflow')
requireOrder(
  setupPanel,
  "key: 'bindings'",
  "key: 'carrier-service-name'",
  'pre-registration naming preference step',
)
requireOrder(
  setupPanel,
  "key: 'carrier-service-name'",
  "key: 'simulation'",
  'naming preference before provider simulation',
)
const nameAlignmentCompletionStart = setupPanel.indexOf(
  'const nameAlignmentComplete = Boolean(',
)
const nameAlignmentCompletionEnd = setupPanel.indexOf(
  'const expectedSimulationOperation',
  nameAlignmentCompletionStart,
)
assert.ok(
  nameAlignmentCompletionStart >= 0
    && nameAlignmentCompletionEnd > nameAlignmentCompletionStart,
  'setup panel is missing the provider-applied name completion predicate',
)
const nameAlignmentCompletion = setupPanel.slice(
  nameAlignmentCompletionStart,
  nameAlignmentCompletionEnd,
)
requireAll(nameAlignmentCompletion, [
  'nameAlignment?.aligned && !namePreferenceChanged',
], 'provider-applied name completion predicate')
assert.doesNotMatch(
  nameAlignmentCompletion,
  /nameAlignmentAuthorization/,
  'authorization evidence alone must not mark name alignment complete',
)
requireAll(setupRoute, [
  'checkoutBrandNameOverride: config.checkoutBrandNameOverride',
  'registeredServiceName: config.registeredServiceName',
  'function storeEntityNamePreference(',
  'providerStoreEntityName: account.configuration.accountName',
  'overrideName || providerStoreEntityName',
  "'administrator_override' as const",
  "'provider_verified_shop_name' as const",
  'const desiredName = namePreference.effectiveName',
  'appliedName: publicConfig.registeredServiceName',
  'aligned: publicConfig.registeredServiceName === desiredName',
  'shopifyCarrierServiceRegistrationRequestHash(nameMutation)',
  "operation: 'update'",
  'requestHash: alignmentSimulation.requestHash',
  'finalizeShopifyCarrierServiceNameAlignmentInPostgres({',
], 'effective checkout-name preference and request-hash fence')
assert.ok(
  (
    setupRoute.match(
      /finalizeShopifyCarrierServiceNameAlignmentInPostgres\(\{/g,
    ) || []
  ).length >= 3,
  'active execution, recovery, and reconciliation must all use the applied-name finalizer',
)
const overrideNormalizer = setupRoute.slice(
  setupRoute.indexOf('function checkoutBrandNameOverride('),
  setupRoute.indexOf('function shadowSimulationIdempotencyKey('),
)
requireAll(overrideNormalizer, [
  'if (value === null) return null',
  "typeof value !== 'string'",
  "'SHOPIFY_CARRIER_SERVICE_NAME_OVERRIDE_INVALID'",
  'The optional checkout name must be text or null',
  'if (!trimmed) return null',
  'if (normalized.length > 120)',
], 'strict checkout-name override parser')
assert.doesNotMatch(
  overrideNormalizer,
  /\bString\s*\(\s*value\s*\)/,
  'non-string non-null override input must be rejected instead of coerced',
)
const updateMutation = setupRoute.slice(
  setupRoute.indexOf("if (input.operation === 'update')", setupRoute.indexOf(
    'function carrierServiceMutation(',
  )),
  setupRoute.indexOf("return {\n      operation: 'delete'", setupRoute.indexOf(
    'function carrierServiceMutation(',
  )),
)
requireAll(updateMutation, [
  "operation: 'update'",
  'id: input.config.serviceGid',
  'name: shopifyStoreEntityCarrierServiceName(',
], 'exact existing-GID name-only mutation')
assert.doesNotMatch(
  updateMutation,
  /\b(?:callbackUrl|active|supportsServiceDiscovery)\s*:/,
  'name alignment must not mutate callback, active state, or discovery state',
)
requireAll(setupPanel, [
  'configRowVersion: number',
  'authorization.configRowVersion === setup?.config?.rowVersion',
  "authorization.status === 'claimed'",
  "authorization.status === 'unknown'",
  'authorization.attempt?.leaseExpiresAt',
  'Date.now()',
  'Boolean(reconciliationRequired)',
  'Verify Shopify and reconcile',
], 'lease-aware mutation recovery controls')
for (const forbidden of [
  'providerServiceGid',
  'recoveryServiceGid',
  'Shopify CarrierService GID',
]) {
  assert.equal(
    setupRoute.includes(forbidden),
    false,
    `recovery route must not require operator provider identity: ${forbidden}`,
  )
  assert.equal(
    setupPanel.includes(forbidden),
    false,
    `recovery UI must not require operator provider identity: ${forbidden}`,
  )
}

requireAll(setupRoute, [
  "mode: 'shadow'",
  'finalizeShopifyCarrierServiceConfigMutationInPostgres({',
  'readShopifyCarrierServiceMutationAuthorizationsFromPostgres({',
  'readCommerceExternalEffectByIdempotencyFromPostgres({',
  'oneTimeProviderMutationConfirmationRequired: true',
  'globalOperationsModeChangedForRegistration: false',
], 'zero-write Shadow evidence and exact resource-scoped provider route')
requireAll(externalEffectsPersistence, [
  'readCommerceExternalEffectByIdempotencyFromPostgres',
  'intent.organization_id = $1::uuid',
  'account.global_id = $2',
  'intent.action = $3',
  'intent.idempotency_key = $4',
], 'exact Shadow simulation evidence read')
for (const forbidden of [
  'updateOperationsActivationInPostgres',
  "'enter-active'",
  "'return-to-shadow'",
  "mode: 'active'",
]) {
  assert.equal(
    setupRoute.includes(forbidden),
    false,
    `one-time route must not use the removed global Active flow: ${forbidden}`,
  )
  assert.equal(
    setupPanel.includes(forbidden),
    false,
    `setup UI must not expose the removed global Active flow: ${forbidden}`,
  )
}
requireAll(mutationMigration, [
  "activation_state = 'shadow'",
  "NEW.operation = 'create'",
  "NEW.account_environment IS DISTINCT FROM 'sandbox'",
  'production is limited to exact delete reconciliation',
  'UNIQUE (authorization_id)',
], 'legacy Shadow authorization schema')
requireAll(activeMutationMigration, [
  'simulation_activation_revision integer',
  'provider_write_activation_revision integer',
  'NEW.provider_write_activation_revision',
  "effect_mode IS DISTINCT FROM 'shadow'",
  "effect_state IS DISTINCT FROM 'simulated'",
  'effect_provider_write_count IS DISTINCT FROM 0',
  "NEW.operation = 'create'",
  "NEW.account_environment IS DISTINCT FROM 'sandbox'",
  'authorization_provider_write_activation_revision IS NULL',
  'auth_provider_write_activation_revision IS NULL',
  'Legacy Shadow grants remain audit-only and unclaimable',
], 'legacy database-enforced Shadow simulation and one-time write schema')
requireAll(receiptAuthorityMigration, [
  'receipt_intake_enabled boolean NOT NULL DEFAULT false',
  "current_activation_state IS DISTINCT FROM 'shadow'",
  "account_status IS DISTINCT FROM 'active'",
  "account_status IS DISTINCT FROM 'disabled'",
  'NEW.provider_write_activation_revision',
  'operations_shopify_carrier_service_config_is_ready(',
], 'receipt-independent resource-scoped CarrierService authority')
requireAll(nameAlignmentMigration, [
  'checkout_brand_name_override text',
  'operations_shopify_carrier_service_configs_brand_name_valid',
  "operation IN ('create', 'update', 'delete')",
  "operation IN ('update', 'delete')",
  'protect_ops_shopify_cs_name_update_authorization()',
  "config_state IS DISTINCT FROM 'registered'",
  'config_service_gid IS DISTINCT FROM NEW.expected_service_gid',
  "simulated_mutation->>'operation' IS DISTINCT FROM 'update'",
  "simulated_mutation->>'carrierServiceId' IS DISTINCT FROM",
  "simulated_mutation->>'serviceName' IS DISTINCT FROM",
  'WHEN (NEW.operation = \'update\')',
], 'name-only CarrierService update schema')
const configMutationLinkTrigger = activeMutationMigration.slice(
  activeMutationMigration.indexOf(
    'CREATE OR REPLACE FUNCTION\n  protect_ops_shopify_cs_config_mut_link()',
  ),
  activeMutationMigration.indexOf(
    'CREATE OR REPLACE FUNCTION\n  operations_shopify_cs_config_has_exact_finalization_link',
  ),
)
assert.doesNotMatch(
  configMutationLinkTrigger,
  /current_activation_(?:state|revision)|activation\.state|activation\.revision|account_generation|credential_status|operations_commerce_credentials/,
  'local provider-evidence finalization must survive post-call activation and credential drift',
)
requireAll(activeMutationMigration, [
  'operations_shopify_cs_config_has_exact_finalization_link(',
  'authorized_mutation.provider_write_activation_revision =',
  'requested_to_activation_revision',
  'IF NOT exact_finalization_link_exists',
  'operations_shopify_carrier_service_config_is_ready(',
  'AND NOT exact_finalization_link_exists',
], 'exact local-finalization validator and callback-readiness exemption')
requireAll(distributedOperationsContract, [
  'is a pre-call write fence',
  'post-call local-finalization dependency',
  'grant is bound to the current verified credential generation',
  'credential state drifts',
  'cannot authorize another',
  'single-consumption attempt is the',
  'Callback readiness remains a separate live',
], 'Distributed Operations activation-drift contract')
requireAll(userIntegrationsContract, [
  'resource-scoped Shadow revision and verified credential generation are rechecked before the provider call',
  'single-consumption attempt is the provider-authority cutoff',
  'cannot cancel the consumed attempt or permit another provider call',
  'Callback readiness remains a separate live predicate',
], 'User Integrations activation and credential drift contract')

requireAll(setupPanel, [
  '/api/integrations/commerce/shopify/carrier-service',
  "method: 'POST'",
  'body: JSON.stringify({',
  'action,',
  'accountGlobalId,',
  'applySetup(payload.setup)',
  'Save exact callback setup',
  'Run zero-write simulation',
  'Authorize and register once',
  'Authorize and remove once',
  'read-only provider check',
  'zero Shopify mutations and zero provider writes',
  'available in every Advanced safety mode',
  'Read only, Shadow, and Active may apply it; Disabled and Frozen block the provider write.',
  'Do not retry.',
  'Open Packaging Materials',
  'Use a signed-in Shopify customer covered by an unexpired Checkout audience allow policy',
], 'customer-facing setup panel')
requireAll(setupPanel, [
  "key: 'cart-rate-callback'",
  "label: 'Shopify cart-rate callback'",
  "label: 'Exact POST callback URL'",
  'copyable: true',
  "label: 'Shopify registration'",
  "value: 'write_shipping'",
  'This is not an event webhook',
  'no manual webhook topic subscriptions belong on this URL',
  'Do not add it as an orders, products, inventory, or app event webhook.',
  'Checkout rate sources',
  "(['sandbox', 'production'] as const).map((environment) => {",
  'TEST accounts',
  'LIVE accounts',
  'Save checkout rate sources',
  'carriers: selectedCarrierBindings',
], 'paired TEST and LIVE multi-account callback setup UI')
requireAll(commercePanel, [
  'Shopify event webhook setup',
  'It is separate from the',
  'CarrierService POST callback used for live cart and',
  'Signed Shopify event webhook URL',
  'Do not use this URL for Shopify CarrierService cart rates.',
], 'event webhook and cart-rate callback distinction')

requireAll(checkoutRatingPersistence, [
  'MAX_SHOPIFY_CHECKOUT_CONFIGURED_CARRIER_ACCOUNTS',
  'carrierEnvironmentCounts.sandbox',
  'carrierEnvironmentCounts.production',
  'Checkout carrier accounts must be unique',
  'current.carriers.length < 1',
  '> MAX_SHOPIFY_CHECKOUT_CONFIGURED_CARRIER_ACCOUNTS',
  ').size !== current.carriers.length',
], 'paired TEST and LIVE multi-account application persistence fence')
requireAll(callbackExecution, [
  'account.carriers.length < 1',
  'MAX_CONFIGURED_CHECKOUT_CARRIER_ACCOUNTS',
  'checkoutRuntimeCarrierBindings(account)',
  'carrierAccountGlobalIds.size === account.carriers.length',
  'runtimeCarrierCount <= CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS',
  'Checkout carrier configuration is not rate-ready',
], 'paired TEST and LIVE multi-account callback execution fence')
requireAll(operationsPersistence, [
  'carrierRows.rows.length < 1',
  'carrierRows.rows.length > CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS',
  "row.carrier_provider !== 'ups_rest'",
  "row.carrier_provider !== 'fedex_rest'",
  ').size !== carrierRows.rows.length',
  'unique configured UPS or FedEx sandbox accounts',
], 'bounded multi-account downstream Shadow execution fence')
requireAll(configuredCarriersMigration, [
  'CREATE OR REPLACE FUNCTION',
  'operations_shopify_carrier_service_config_environment_is_ready(',
  'operations_shopify_carrier_service_config_is_ready(',
  "carrier_integration.provider IN ('ups_rest', 'fedex_rest')",
  ') BETWEEN 1 AND 8',
  'one through eight selected unique verified direct UPS/FedEx accounts',
], 'paired TEST and LIVE multi-account canonical database readiness')
requireAll(simulationRuntimeReadinessMigration, [
  'public.validate_operations_shopify_carrier_service_config_ready()',
  "NEW.registration_state = 'shadow_simulated'",
  'public.operations_shopify_carrier_service_rating_environment_is_ready(',
  "NEW.policy_snapshot #>> '{checkoutRateControl,rateSource}'",
  "NEW.registration_state = 'registered'",
  'public.operations_shopify_carrier_service_config_is_ready(',
  'AND NOT exact_finalization_link_exists',
  'AND NOT exact_name_finalization_exists',
], 'simulation-specific saved rating environment readiness')
const simulationReadinessStart = simulationRuntimeReadinessMigration.indexOf(
  "NEW.registration_state = 'shadow_simulated'",
)
const registeredReadinessStart = simulationRuntimeReadinessMigration.indexOf(
  "NEW.registration_state = 'registered'",
  simulationReadinessStart + 1,
)
assert.ok(
  simulationReadinessStart >= 0
    && registeredReadinessStart > simulationReadinessStart,
  'simulation readiness must remain separate from registered provider readiness',
)
assert.doesNotMatch(
  simulationRuntimeReadinessMigration,
  /NEW\.registration_state IN \('shadow_simulated', 'registered'\)/u,
  'simulation and registered state must not share the legacy activation-coupled predicate',
)
assert.doesNotMatch(
  configuredCarriersMigration,
  /selected\.carrier_provider = '(?:ups_rest|fedex_rest)'/u,
  'canonical readiness must not require both provider names',
)
requireAll(healthRoute, [
  'shopify_carrier_configured_carriers_applied',
  '0285_shopify_carrier_service_configured_carriers.sql',
  "'operations_shopify_carrier_service_config_is_ready(uuid,uuid)'",
  '0317_operations_shopify_carrier_service_simulation_runtime_readiness.sql',
  '8b6de19ad2fa428edd087100e1cb73c851ba59a7fdff248ce71eedd9d3b3e3bb',
], 'configured-carrier migration health gate')
requireAll(predeployVerification, [
  'db/migrations/0285_shopify_carrier_service_configured_carriers.sql',
  'db/migrations/0317_operations_shopify_carrier_service_simulation_runtime_readiness.sql',
], 'configured-carrier predeploy path gate')
assert.equal(
  /[A-Z0-9._%+-]+@(?:episcs\.com|gmail\.com)/iu.test(setupPanel),
  false,
  'tenant test identities must not appear in the generic setup panel',
)
assert.equal(
  /\b(?:window|globalThis)\.(?:alert|confirm|prompt)\s*\(/.test(setupPanel),
  false,
  'setup actions must not be replaced by global advisory dialogs',
)
requireAll(commercePanel, [
  "account.provider === 'shopify'",
  '<ShopifyCarrierServiceSetupPanel',
  'accountGlobalId={account.globalId}',
  'displayName={account.displayName}',
], 'commerce integration host panel')

requireAll(setupRoute, [
  'let publicCallbackUrl: string | null = null',
  'if (config && input.canActivate)',
  'publicCallbackUrl = callbackUrl(input.accountGlobalId, token)',
  'callbackUrl: publicCallbackUrl',
  'canActivate: input.canActivate',
], 'callback URL authorization boundary')
assert.equal(
  /callbackToken\s*:/.test(setupRoute),
  false,
  'authenticated setup responses must not expose a standalone callback token',
)
assert.ok(
  setupRoute.indexOf('if (config && input.canActivate)')
    < setupRoute.indexOf('callbackUrl: publicCallbackUrl'),
  'callback URL must be authorization-gated before it enters setup state',
)
requireAll(setupPanel, [
  "key: 'cart-rate-callback'",
  "label: 'Exact POST callback URL'",
  'value: setup.callbackUrl',
  'setup && !setup.canActivate',
  'Owner or authorized administrator permission is required to view the',
  'callback URL or change registration state.',
], 'callback URL panel boundary')

requireAll(publicCallbackRoute, [
  'function genericNotFound()',
  "{ ok: false, error: 'Carrier service callback was not found' }",
  'if (!result.authenticated) return genericNotFound()',
  'return NextResponse.json(result.response, {',
  "'Cache-Control': 'no-store, max-age=0'",
  "'X-Robots-Tag': 'noindex, nofollow'",
], 'public callback response boundary')
assert.equal(
  /NextResponse\.json\(\s*\{[^}]*\b(?:token|callbackUrl)\b/s.test(
    publicCallbackRoute,
  ),
  false,
  'public callback responses must not echo the callback URL or token',
)
assert.ok(
  proxy.includes(
    "normalizedPath.startsWith('/api/integrations/commerce/shopify/carrier-service/')",
  ),
  'only the tokenized callback path must bypass browser authentication',
)
assert.equal(
  proxy.includes(
    "normalizedPath === '/api/integrations/commerce/shopify/carrier-service'",
  ),
  false,
  'authenticated setup API must not be included in the public API allowlist',
)

const receiptTableStart = checkoutMigration.indexOf(
  'CREATE TABLE IF NOT EXISTS operations_shopify_checkout_rate_receipts (',
)
const receiptTableEnd = checkoutMigration.indexOf(
  '\n);',
  receiptTableStart,
)
assert.ok(
  receiptTableStart >= 0 && receiptTableEnd > receiptTableStart,
  'checkout receipt schema must be present in migration 0149',
)
const receiptTable = checkoutMigration.slice(
  receiptTableStart,
  receiptTableEnd,
)
requireAll(receiptTable, [
  'completed_at timestamptz',
  'created_at timestamptz NOT NULL DEFAULT now()',
  'updated_at timestamptz NOT NULL DEFAULT now()',
], 'checkout receipt timestamp schema')
assert.equal(
  /\breceived_at\b/.test(receiptTable),
  false,
  'checkout receipt schema does not define a received_at column',
)
requireAll(setupPersistence, [
  'max(receipt.created_at) AS last_received_at',
  'max(receipt.completed_at)',
  'receipt.created_at AS received_at',
  'receipt.completed_at',
  'ORDER BY receipt.created_at DESC, receipt.id DESC',
], 'setup evidence timestamp projection')
assert.equal(
  /\breceipt\.received_at\b/.test(setupPersistence),
  false,
  'setup evidence queries must not reference a nonexistent received_at column',
)

console.log(
  'Shopify CarrierService authenticated setup workflow contracts passed.',
)
