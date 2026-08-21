#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    AbortController,
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
    Headers,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Request,
    Response,
    Set,
    String,
    TextDecoder,
    TextEncoder,
    URL,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    structuredClone,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const constants = loadTypeScriptModule(
  'app_src/lib/operations/shopifyTestStoreCanonicalE2e.ts',
)
class ShopifyCommerceClientError extends Error {
  constructor(message, status = 502, retryable = true) {
    super(message)
    this.status = status
    this.retryable = retryable
  }
}
const integration = loadTypeScriptModule(
  'app_src/lib/integrations/shopifyTestStoreCanonicalE2e.ts',
  {
    '@/lib/integrations/commerceCredentialCrypto': {
      decryptCommerceCredential() {
        throw new Error('default decrypt must be injected')
      },
    },
    '@/lib/integrations/commerceCapabilities': {
      hasEffectiveShopifyScope: (scopes, required) => scopes.includes(required),
    },
    '@/lib/integrations/shopifyCommerceClient': {
      normalizeShopifyShopDomain(value) {
        const normalized = String(value || '').trim().toLowerCase()
        if (!/^[a-z0-9-]+\.myshopify\.com$/.test(normalized)) {
          throw new Error('Invalid shop domain')
        }
        return normalized
      },
      probeShopifyConnection() {
        throw new Error('default probe must be injected')
      },
      requestShopifyAccessToken() {
        throw new Error('default token request must be injected')
      },
      shopifyAdminGraphql() {
        throw new Error('default GraphQL call must be injected')
      },
      ShopifyCommerceClientError,
    },
    '@/lib/integrations/shopifyOrderManagementRuntime': {
      shopifyOrderManagementRuntime: () => ({
        available: true,
        allowedAccountGlobalIds: ['gia1234567'],
      }),
    },
    '@/lib/persistence/shopifyTestStoreCanonicalE2e': {
      persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres() {
        throw new Error('default persistence must be injected')
      },
      readShopifyTestStoreCanonicalE2eTargetFromPostgres() {
        throw new Error('default target read must be injected')
      },
    },
    '@/lib/persistence/commerceIntegrations': {
      readCommerceRuntimeCredentialFromPostgres() {
        throw new Error('default credential read must be injected')
      },
    },
    '@/lib/operations/shopifyTestStoreCanonicalE2e': constants,
  },
)

const verifiedAt = '2026-08-20T16:00:00.000Z'
const target = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  activationRevision: 7,
  order: {
    id: '22222222-2222-4222-8222-222222222222',
    globalId: 'gor1234567',
    rowVersion: 9,
    externalOrderId: 'gid://shopify/Order/6600000000',
    status: 'packed',
  },
  account: {
    id: '33333333-3333-4333-8333-333333333333',
    globalId: 'gia1234567',
    externalAccountId: 'gid://shopify/Shop/987654321',
    credentialGeneration: 4,
  },
  candidate: {
    id: '44444444-4444-4444-8444-444444444444',
    globalId: 'gcoc1234567',
    rowVersion: 3,
    sourceRevision: 'shopify-updated-at:2026-08-20T15:58:00Z',
    sourceHash: 'a'.repeat(64),
  },
}

const proof = integration.normalizeShopifyTestOrderProofResponse({
  order: {
    id: target.order.externalOrderId,
    test: true,
    updatedAt: '2026-08-20T15:59:00.000Z',
  },
}, target, verifiedAt)
assert.equal(proof.test, true)
assert.equal(proof.accountGlobalId, target.account.globalId)
assert.equal(proof.credentialGeneration, 4)
assert.equal(proof.orderRowVersion, 9)
assert.equal(proof.candidateRowVersion, 3)
assert.equal(proof.candidateSourceHash, 'a'.repeat(64))

for (const [response, expectedCode] of [
  [{ order: { id: target.order.externalOrderId, test: false,
    updatedAt: '2026-08-20T15:59:00.000Z' } },
  'SHOPIFY_TEST_E2E_PROVIDER_TEST_REQUIRED'],
  [{ order: { id: target.order.externalOrderId, test: 'true',
    updatedAt: '2026-08-20T15:59:00.000Z' } },
  'SHOPIFY_TEST_E2E_PROVIDER_TEST_UNPROVEN'],
  [{ order: { id: 'gid://shopify/Order/6600000001', test: true,
    updatedAt: '2026-08-20T15:59:00.000Z' } },
  'SHOPIFY_TEST_E2E_PROVIDER_ORDER_CHANGED'],
  [{ order: { id: target.order.externalOrderId, test: true,
    updatedAt: '2026-08-20T16:01:00.000Z' } },
  'SHOPIFY_TEST_E2E_PROVIDER_TIME_INVALID'],
]) {
  assert.throws(
    () => integration.normalizeShopifyTestOrderProofResponse(
      response,
      target,
      verifiedAt,
    ),
    (error) => error?.code === expectedCode,
  )
}

const calls = []
const runtimeCredential = {
  organizationId: target.organizationId,
  integrationAccountId: target.account.id,
  provider: 'shopify',
  environment: 'sandbox',
  status: 'active',
  verificationStatus: 'verified',
  externalAccountId: target.account.externalAccountId,
  credentialVersion: 4,
  configuration: { shopDomain: 'test-pro-bakery.myshopify.com' },
  encrypted: { ciphertext: 'ciphertext' },
}
const authorized = await integration.authorizeShopifyTestStoreCanonicalE2e({
  organizationId: target.organizationId,
  actorEmail: 'owner@example.com',
  idempotencyKey: 'shopify-test-store-authorize:focused-contract',
  orderGlobalId: target.order.globalId,
  expectedOrderRowVersion: 9,
  confirmationStatement: constants.SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION,
  reason: 'Exact focused canonical Shopify test order',
}, {
  async readTarget(input) {
    calls.push(['target', input])
    return target
  },
  async readRuntimeCredential(input) {
    calls.push(['credential', input])
    return runtimeCredential
  },
  decryptCredential() {
    calls.push(['decrypt'])
    return {
      provider: 'shopify',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }
  },
  async requestAccessToken(input) {
    calls.push(['token', input.shopDomain])
    return {
      accessToken: 'access-token',
      grantedScopes: [
        'read_orders',
        'write_merchant_managed_fulfillment_orders',
      ],
    }
  },
  async probeConnection() {
    calls.push(['probe'])
    return {
      shopId: target.account.externalAccountId,
      grantedScopes: [
        'read_orders',
        'write_merchant_managed_fulfillment_orders',
      ],
    }
  },
  async readProof(credential, exactTarget, exactVerifiedAt) {
    calls.push(['proof', credential.shopDomain])
    assert.equal(exactTarget, target)
    assert.equal(exactVerifiedAt, verifiedAt)
    return proof
  },
  async persistAuthorization(input) {
    calls.push(['persist', input.proof.test])
    assert.equal(input.proof, proof)
    assert.equal(
      input.idempotencyKey,
      'shopify-test-store-authorize:focused-contract',
    )
    return { authorizationGlobalId: 'gsea1234567' }
  },
  now: () => verifiedAt,
})
assert.equal(authorized.authorizationGlobalId, 'gsea1234567')
assert.deepEqual(
  calls.map((entry) => entry[0]),
  ['target', 'credential', 'decrypt', 'token', 'probe', 'proof', 'persist'],
  'Authorization must verify exact local state, sandbox credential, store, scopes, and fresh Shopify test=true before persistence',
)

const domain = loadTypeScriptModule('app_src/lib/operations/domain.ts')
function actionInput(overrides = {}) {
  return {
    status: 'packed',
    sourceProvider: 'shopify',
    activationState: 'read_only',
    canExecute: true,
    canManage: true,
    canActivate: true,
    planStatus: 'released',
    waveStatus: 'completed',
    lineCount: 1,
    fullyReservedLineCount: 1,
    allocatedLineCount: 1,
    pickTaskCount: 1,
    readyPickTaskCount: 0,
    pickedPickTaskCount: 1,
    packageCount: 1,
    plannedPackageCount: 0,
    packedPackageCount: 1,
    blockingExceptionCount: 0,
    activeLabelCount: 1,
    shippableLabelCount: 0,
    sandboxLabelCount: 1,
    unresolvedLabelAttemptCount: 0,
    existingShipmentCount: 0,
    sandboxE2eAuthorized: true,
    sandboxE2eFulfillmentConfirmed: false,
    ...overrides,
  }
}
function action(input, name) {
  return domain.availableOperationsOrderActions(input)
    .find((candidate) => candidate.action === name)
}
assert.equal(
  action(actionInput(), 'confirm_shipment').enabled,
  false,
  'Read-only canonical shipment must require the second confirmation',
)
assert.equal(
  action(actionInput({ sandboxE2eFulfillmentConfirmed: true }),
    'confirm_shipment').enabled,
  true,
)
assert.equal(
  action(actionInput({
    status: 'picking',
    waveStatus: 'completed',
    packageCount: 1,
    plannedPackageCount: 1,
    packedPackageCount: 0,
  }), 'verify_pack').enabled,
  true,
  'The exact authorized Read-only lane must be able to verify packing',
)
assert.equal(
  action(actionInput({
    status: 'picking',
    waveStatus: 'completed',
    packageCount: 1,
    plannedPackageCount: 1,
    packedPackageCount: 0,
    sandboxE2eAuthorized: false,
  }), 'verify_pack').enabled,
  false,
  'An unrelated Read-only order must remain blocked',
)
assert.equal(
  action(actionInput({
    activationState: 'active',
    sandboxE2eAuthorized: false,
    sandboxE2eFulfillmentConfirmed: false,
    activeLabelCount: 1,
    shippableLabelCount: 1,
    sandboxLabelCount: 0,
  }), 'confirm_shipment').enabled,
  true,
  'The ordinary Active production pathway must remain unchanged',
)

const sources = {
  persistence: read('app_src/lib/persistence/shopifyTestStoreCanonicalE2e.ts'),
  operations: read('app_src/lib/persistence/operations.ts'),
  shipping: read('app_src/lib/persistence/operationShipping.ts'),
  writeback: read('app_src/lib/integrations/shopifyFulfillmentWriteback.ts'),
  route: read('app_src/app/api/operations/route.ts'),
  ratingRoute: read(
    'app_src/app/api/integrations/commerce/intake/cartonization-rate-evidence/route.ts',
  ),
  ui: read('app_src/components/operations/OperationsSection.tsx'),
  health: read('app_src/app/api/health/route.ts'),
  package: read('package.json'),
  predeploy: read('scripts/verify-predeploy.mjs'),
  ci: read('.github/workflows/ci.yml'),
  migration: read(
    'db/migrations/0302_operations_shopify_test_store_canonical_e2e.sql',
  ),
}

for (const fragment of [
  'verifiedAt < proofClaimedAt - 5 * 60_000',
  'target.account.credentialGeneration !== proof.credentialGeneration',
  'target.candidate.sourceHash !== proof.candidateSourceHash',
  'operations_shopify_test_store_e2e_active_org_unique',
  'authorization_idempotency_key',
  'authorization_request_hash',
  'SHOPIFY_TEST_E2E_IDEMPOTENCY_CONFLICT',
  'SHOPIFY_TEST_E2E_FULFILLMENT_IDEMPOTENCY_CONFLICT',
  'requireExactShopifyTestStoreConfirmedLabelSnapshot',
  'confirmation.label_evidence_hash = encode(',
  "exact_label.environment = 'sandbox'",
  "export.payload_snapshot->'customerNotification'->>'notifyCustomer'",
]) {
  assert.ok(
    sources.persistence.includes(fragment)
      || sources.migration.includes(fragment),
    `Exact persistence contract missing ${fragment}`,
  )
}

for (const fragment of [
  "provider_verified_at >= created_at - interval '5 minutes'",
  "activation.state = 'read_only'",
  'activation.revision = evidence.activation_revision',
  'account.commerce_credential_generation =',
  'candidate.row_version = evidence.order_candidate_row_version',
  'candidate.source_hash = evidence.order_candidate_source_hash',
  'provider_test = true',
  'Shopify test-store E2E evidence is immutable',
  'Shopify test-store fulfillment confirmation is immutable',
  'operations_shopify_test_store_e2e_authorization_key_unique',
  'operations_shopify_test_store_e2e_confirmation_key_unique',
]) {
  assert.ok(sources.migration.includes(fragment), `Migration missing ${fragment}`)
}

for (const fragment of [
  "'0302_operations_shopify_test_store_canonical_e2e.sql'",
  "'2e4a2d7b74322bcc4b2a8f5565c9e14da0c2d41961e25bbfd56edfd8c8e2d6cb'",
  'operations_shopify_test_store_e2e_is_current(uuid,uuid,uuid)',
  'operations_shopify_test_store_e2e_active_org_unique',
  'operations_shopify_test_store_canonical_e2e_applied',
  'shopifyTestStoreCanonicalE2e',
  'af98d5867718c9891b17d168f37b6358e7f1fbddd72fc5c8f378673c4497f830',
  'f27b77a5a6f350dec333adb8ac04d5aafcf0bf1e8cb99f891ea4f56e581b62e0',
  '59d38d75ae50f7f0de62639c1e82f8e04429e48ca72e3a6253297821f0c4c638',
  'e46f58b04972cbcaf0741c2a62b3ac1fc5d248f087eda1b85dce621b5a70c66d',
  '7916b6b3bea6c7ded0f480fa653f7b21b2ae31f3e217f4520dc1493483bc429a',
  'fb376ea9ea5eedac159dc234b5f399e9b95d3e5e605b70491e4643d930afcf9d',
  'operations_sandbox_e2e_confirm_version_check',
  "'public.' || required.signature",
]) {
  assert.ok(sources.health.includes(fragment), `Health attestation missing ${fragment}`)
}
assert.ok(
  sources.package.includes('"test:shopify-test-store-canonical-e2e"'),
  'Focused canonical E2E package script is missing',
)
assert.ok(
  sources.predeploy.includes("'db/migrations/0302_operations_shopify_test_store_canonical_e2e.sql'"),
  'Predeploy required-path attestation is missing migration 0302',
)
assert.ok(
  sources.predeploy.includes("['scripts/test-shopify-test-store-canonical-e2e.mjs']"),
  'Predeploy must execute the focused canonical E2E contract',
)
assert.ok(
  sources.predeploy.includes("'scripts/test-shopify-test-store-canonical-e2e-health.mjs'"),
  'Predeploy must require and execute the exact 0302 health tamper test',
)
assert.ok(
  sources.ci.includes('run: npm run test:shopify-test-store-canonical-e2e'),
  'CI must execute the focused canonical E2E contract explicitly',
)

const snapshotGuard = sources.operations.indexOf(
  'requireExactShopifyTestStoreConfirmedLabelSnapshot(client',
)
const firstLocalShipmentWrite = sources.operations.indexOf(
  'INSERT INTO operations_shipments',
  snapshotGuard,
)
assert.ok(
  snapshotGuard >= 0 && firstLocalShipmentWrite > snapshotGuard,
  'The immutable label snapshot must be revalidated before local shipment effects',
)

for (const fragment of [
  "action === 'authorize-shopify-test-store-canonical-e2e'",
  "action === 'confirm-shopify-test-store-e2e-fulfillment'",
  '!capabilities.canActivate || !capabilities.canManage || !capabilities.canExecute',
  'Only an organization owner or administrator may authorize',
  'Only an organization owner or administrator may confirm',
  'idempotencyKey: idempotencyKeyValue(req)',
]) {
  assert.ok(sources.route.includes(fragment), `Owner/admin route missing ${fragment}`)
}

for (const fragment of [
  'Authorize verified test order',
  'Renew or resume verified test order',
  'Type the exact authorization statement',
  'Type the exact fulfillment statement',
  'shopify-test-store-fulfillment-confirmed',
  'Shopify customer notification is locked off',
  'fullScreen={mobile}',
  'Current order state was refreshed. Review it before authorizing again.',
  'the exact authorization command is retained for retry.',
  'the exact fulfillment-confirmation command is retained for retry.',
  "'Idempotency-Key': canonicalCommand.idempotencyKey",
  "'Idempotency-Key': command.idempotencyKey",
]) {
  assert.ok(sources.ui.includes(fragment), `Operator UI missing ${fragment}`)
}

for (const fragment of [
  'assertShopifyTestStoreCanonicalPlanningEvidenceAccessInPostgres',
  "evidenceMode !== 'operational'",
  'sandboxE2eAuthorizationGlobalId',
]) {
  assert.ok(sources.ratingRoute.includes(fragment), `Rating lane missing ${fragment}`)
}

for (const fragment of [
  "context.order.activation_state === 'read_only'",
  "=== 'shopify-test-store-canonical-e2e-v1'",
  "environment !== 'sandbox'",
]) {
  assert.ok(sources.shipping.includes(fragment), `Sandbox-label gate missing ${fragment}`)
}

const providerClaim = sources.writeback.indexOf(
  'requireShopifyTestStoreFulfillmentWriteClaimInPostgres',
)
const providerMutation = sources.writeback.indexOf(
  "operationName: 'ClawPilotFulfillmentCreate'",
)
assert.ok(providerClaim >= 0, 'Pre-provider exact fulfillment claim is missing')
assert.ok(providerMutation >= 0, 'Shopify fulfillmentCreate mutation is missing')
assert.ok(
  sources.writeback.includes('notifyCustomer !== false'),
  'Canonical provider writeback must force notifyCustomer=false',
)

console.log('Shopify test-store canonical E2E provider/domain/UI contracts passed')
