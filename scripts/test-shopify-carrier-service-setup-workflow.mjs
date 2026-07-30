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
  ['save-config', 'simulate-registration'],
  ['simulate-registration', 'register'],
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
  'simulate-registration',
  'recover-mutation',
]) {
  assert.ok(
    setupPanel.includes(`'${action}'`),
    `setup panel is not wired to the ${action} action`,
  )
}

const saveConfig = actionBranch('save-config', 'simulate-registration')
requireAll(saveConfig, [
  'requireActivator(context.capabilities.canActivate)',
  'upsertShopifyCarrierServiceConfigInPostgres({',
  'callbackTokenHash: tokenHash(token)',
  'actorEmail: context.actor.email',
], 'save-config action')

const simulation = actionBranch('simulate-registration', 'register')
requireAll(simulation, [
  "current.reference.activation.state !== 'shadow'",
  'current.reference.activation.revision === null',
  "current.config.registrationState === 'registered'",
  "? 'delete'",
  ": 'create'",
  "operation === 'create'",
  "current.account.environment !== 'sandbox'",
  "'SHOPIFY_CARRIER_SERVICE_PRODUCTION_CREATE_BLOCKED'",
  "mode: 'shadow'",
  'executeShopifyCarrierServiceRegistration({',
  'activationRevision: current.reference.activation.revision',
  'idempotencyKey: shadowSimulationIdempotencyKey({',
  'finalizeShopifyCarrierServiceRegistrationInPostgres({',
  "registrationState: 'shadow_simulated'",
  'const exactConfig = publicCarrierServiceConfig(finalized)',
], 'simulate-registration action')
assert.ok(
  (
    simulation.match(
      /await executeShopifyCarrierServiceRegistration\(\{/g,
    ) || []
  ).length >= 2,
  'create simulation must retain exact zero-write evidence for the final configuration row',
)

requireAll(providerMutation, [
  "action === 'register' || action === 'unregister'",
  'body.confirmProviderWrite !== true',
  "'SHOPIFY_CARRIER_SERVICE_PROVIDER_WRITE_CONFIRMATION_REQUIRED'",
  "action === 'register' ? 'create' : 'delete'",
  "current.reference.activation.state !== 'shadow'",
  'current.reference.activation.revision === null',
  "'SHOPIFY_CARRIER_SERVICE_RESOURCE_AUTHORIZATION_REQUIRES_SHADOW'",
  '!current.shadowSimulation',
  'current.shadowSimulation.configRowVersion',
  "'SHOPIFY_CARRIER_SERVICE_SHADOW_EVIDENCE_REQUIRED'",
  'body.confirmProductionProviderWrite !== true',
  'executeResourceScopedCarrierServiceMutation({',
  'confirmationRequestId(',
], 'revision-fenced register and unregister actions')

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
  "input.operation === 'create'",
  "input.accountEnvironment !== 'sandbox'",
  "'SHOPIFY_CARRIER_SERVICE_PRODUCTION_CREATE_BLOCKED'",
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
  'finalizeShopifyCarrierServiceConfigMutationInPostgres({',
], 'exact resource-scoped mutation executor')
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
    'finalizeShopifyCarrierServiceConfigMutationInPostgres({',
  ],
]) {
  assert.ok(
    activeExecutor.indexOf(before) < activeExecutor.indexOf(after),
    `${before} must precede ${after}`,
  )
}
requireAll(setupPanel, [
  'Simulate registration in Shadow',
  'Simulate exact removal in Shadow',
  'zero credential decryption, zero Shopify network calls, and zero provider writes',
  'Authorize exact resource registration',
  'Authorize exact resource removal',
  'single-use Shopify provider mutation',
  'confirmWrite',
  'confirmRemove',
  "run(\n                  'register'",
  "run(\n                  'unregister'",
  'confirmProviderWrite: true',
  'confirmProductionProviderWrite:',
  'globalThis.crypto.randomUUID()',
], 'Shadow plus resource-scoped provider mutation workflow')
requireAll(setupPanel, [
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
  'Shadow records immutable terminal evidence',
  'zero Shopify network calls',
  'Do not retry.',
  'Open Packaging Materials',
  'Create a cart for Jarrett+warehouse@episcs.com.',
], 'customer-facing setup panel')
assert.equal(
  setupPanel.includes('Jarrett+warehouse@gmail.com'),
  false,
  'obsolete Gmail test identity must not appear in the setup panel',
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
  'facts: setup?.callbackUrl ? [{',
  "label: 'Callback URL'",
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
