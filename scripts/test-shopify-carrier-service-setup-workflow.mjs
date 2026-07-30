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
  ['register', 'recover-mutation'],
  ['unregister', null],
  ['recover-mutation', null],
]
for (const [action, nextAction] of actions) {
  assert.ok(
    setupPanel.includes(`'${action}'`),
    `setup panel is not wired to the ${action} action`,
  )
  actionBranch(action, nextAction)
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
  "current.account.environment !== 'sandbox'",
  "'SHOPIFY_CARRIER_SERVICE_PRODUCTION_CREATE_BLOCKED'",
  "current.config.registrationState === 'registered'",
  'current.config.serviceGid !== null',
  "'SHOPIFY_CARRIER_SERVICE_EXACT_DELETE_REQUIRED'",
  "mode: 'shadow'",
  'executeShopifyCarrierServiceRegistration({',
  'finalizeShopifyCarrierServiceRegistrationInPostgres({',
  "registrationState: 'shadow_simulated'",
], 'simulate-registration action')

const register = actionBranch('register', null)
requireAll(register, [
  "action === 'register' || action === 'unregister'",
  'body.confirmProviderWrite !== true',
  "'SHOPIFY_CARRIER_SERVICE_PROVIDER_WRITE_CONFIRMATION_REQUIRED'",
  'body.confirmProductionProviderWrite !== true',
  "'SHOPIFY_CARRIER_SERVICE_PRODUCTION_CONFIRMATION_REQUIRED'",
  'executeOneTimeCarrierServiceMutation({',
  "operation: action === 'register' ? 'create' : 'delete'",
  'confirmationRequestId(',
  'mutationActorRole(',
], 'register action')
requireAll(setupPanel, [
  'I authorize exactly one sandbox Shopify CarrierService registration',
  "'register'",
  'confirmProviderWrite: true',
  'confirmationRequestId:',
  'globalThis.crypto.randomUUID()',
  'confirmProductionProviderWrite:',
  "'unregister'",
], 'register panel control')
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
  "input.operation === 'create'",
  "input.accountEnvironment !== 'sandbox'",
  "'SHOPIFY_CARRIER_SERVICE_PRODUCTION_CREATE_BLOCKED'",
  "mode: 'shadow'",
  'authorizeShopifyCarrierServiceMutationInPostgres({',
  'claimShopifyCarrierServiceMutationInPostgres({',
  'executeAuthorizedShopifyCarrierServiceMutation({',
  'finalizeShopifyCarrierServiceConfigMutationInPostgres({',
  'readShopifyCarrierServiceMutationAuthorizationsFromPostgres({',
  'oneTimeProviderMutationConfirmationRequired: true',
  'globalOperationsModeChangedForRegistration: false',
], 'one-time Shadow provider mutation route')
assert.ok(
  setupRoute.indexOf(
    'authorizeShopifyCarrierServiceMutationInPostgres({',
  ) < setupRoute.indexOf(
    'claimShopifyCarrierServiceMutationInPostgres({',
  )
  && setupRoute.indexOf(
    'claimShopifyCarrierServiceMutationInPostgres({',
  ) < setupRoute.indexOf(
    'executeAuthorizedShopifyCarrierServiceMutation({',
  )
  && setupRoute.indexOf(
    'executeAuthorizedShopifyCarrierServiceMutation({',
  ) < setupRoute.indexOf(
    'finalizeShopifyCarrierServiceConfigMutationInPostgres({',
  ),
  'route must authorize, consume, execute once, then link config evidence',
)
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
], 'database-enforced sandbox create and one-time consumption')

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
  'Operations remains',
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
