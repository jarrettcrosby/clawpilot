#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

class ProjectionError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function loadProjectionModule() {
  const path =
    'app_src/lib/integrations/shopifyProductMediaProjection.ts'
  const source = readFileSync(resolve(root, path), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === 'node:net') return nodeRequire(specifier)
      if (
        specifier ===
        '@/lib/integrations/shopifyProductWriteback'
      ) {
        return { executeShopifyProductWriteback() {
          throw new Error('default writeback must be overridden')
        } }
      }
      if (
        specifier ===
        '@/lib/integrations/shopifyProductMediaProjectionTypes'
      ) {
        return { ShopifyProductMediaProjectionError: ProjectionError }
      }
      if (
        specifier ===
        '@/lib/integrations/shopifyProductMediaTokens'
      ) {
        return {
          resolveShopifyProductMediaSigningSecret() {
            throw new Error('default secret must be overridden')
          },
          signShopifyProductMediaToken(payload) {
            return Buffer.from(JSON.stringify(payload)).toString('base64url')
              + '.test-signature'
          },
        }
      }
      if (
        specifier ===
        '@/lib/persistence/shopifyProductMediaProjection'
      ) {
        return { prepareShopifyProductMediaProjectionInPostgres() {
          throw new Error('default persistence must be overridden')
        } }
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const projection = loadProjectionModule()
const organizationId = '11111111-1111-4111-8111-111111111111'
const productId = '22222222-2222-4222-8222-222222222222'
const imageAssetId = '33333333-3333-4333-8333-333333333333'
const channelStateGlobalId = 'gpcs0000001'
const nowEpoch = 1_785_400_000

function grant(mode = 'active', overrides = {}) {
  const productGid =
    overrides.productGid || 'gid://shopify/Product/123456789'
  const selectedImageAssetId =
    overrides.imageAssetId || imageAssetId
  const idempotencyKey = `shopify-product-image:${
    createHash('sha256').update(JSON.stringify({
      account: 'gia0000001',
      product: productGid,
      asset: selectedImageAssetId,
      mode,
    }), 'utf8').digest('hex')
  }`
  return {
    id: '44444444-4444-4444-8444-444444444444',
    organizationId,
    integrationAccountId:
      '55555555-5555-4555-8555-555555555555',
    integrationAccountGlobalId: 'gia0000001',
    pipelineId: '66666666-6666-4666-8666-666666666666',
    productId,
    channelStateId: '77777777-7777-4777-8777-777777777777',
    imageAssetId,
    idempotencyKey,
    productWriteAuthorizationId: mode === 'active'
      ? '99999999-9999-4999-8999-999999999999'
      : null,
    mode,
    publicOrigin: 'https://clawpilot.example.com',
    productReferenceCode: 'gp0000001',
    productSourceHash: 'a'.repeat(64),
    productGid,
    channelStateGlobalId,
    channelStateRowVersion: 8,
    channelSourceRevision: '2026-07-30T00:00:00.000Z',
    channelSourceHash: 'b'.repeat(64),
    assetRevision: 2,
    assetRowVersion: 3,
    assetContentSha256: 'c'.repeat(64),
    assetMimeType: 'image/png',
    assetByteLength: 1_024,
    assetPixelWidth: 1_200,
    assetPixelHeight: 1_200,
    assetAltText: 'EPISCS test dog treat bag',
    credentialGeneration: 7,
    activationRevision: 4,
    aggregateRevision: 2,
    aggregateHash: 'd'.repeat(64),
    issuedAtEpoch: nowEpoch,
    expiresAtEpoch: nowEpoch + (mode === 'active' ? 900 : 60),
    createdBy: 'admin@example.com',
    ...overrides,
  }
}

function effectFor(input, mode = 'active') {
  return {
    id: '88888888-8888-4888-8888-888888888888',
    globalId: 'gcef0000001',
    organizationId: input.organizationId,
    integrationAccountId:
      '55555555-5555-4555-8555-555555555555',
    integrationAccountGlobalId: input.accountGlobalId,
    provider: 'shopify',
    action: 'shopify.product.update',
    desiredMode: mode,
    credentialGeneration: input.credentialGeneration,
    activationRevision: input.activationRevision,
    aggregateType: 'shopify_product_projection',
    aggregateId: input.aggregateId,
    aggregateRevision: input.aggregateRevision,
    aggregateHash: input.aggregateHash,
    idempotencyKey: input.idempotencyKey,
    requestHash: 'e'.repeat(64),
    redactedRequest: {},
    state: mode === 'shadow' ? 'simulated' : 'succeeded',
    providerAttemptId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    claimedBy: null,
    claimedAt: null,
    redactedResult: {},
    terminalEvidenceHash: 'f'.repeat(64),
    providerReference: mode === 'active'
      ? 'gid://shopify/Product/123456789'
      : null,
    errorCode: null,
    providerWriteCount: mode === 'active' ? 1 : 0,
    completedAt: '2026-07-30T00:00:01.000Z',
    createdBy: 'admin@example.com',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:01.000Z',
  }
}

function command(overrides = {}) {
  return {
    organizationId,
    productId,
    channelStateGlobalId,
    imageAssetId,
    executeProviderWrite: true,
    publicOrigin: 'https://clawpilot.example.com',
    actorEmail: 'admin@example.com',
    // These adversarial browser values must be ignored because they are not
    // part of the server manager input contract.
    accountGlobalId: 'gia9999999',
    productGid: 'gid://shopify/Product/999',
    credentialGeneration: 999,
    activationRevision: 999,
    aggregateHash: '9'.repeat(64),
    idempotencyKey: 'browser-supplied-key-must-be-ignored',
    ...overrides,
  }
}

let prepared = 0
let writes = []
let preparedInputs = []

function dependencies(selectedGrant) {
  return {
    signingSecret: () => Buffer.from('x'.repeat(32)),
    nowEpoch: () => nowEpoch,
    async resolveProviderIdentity() {
      return {
        integrationAccountGlobalId:
          selectedGrant.integrationAccountGlobalId,
        productGid: selectedGrant.productGid,
      }
    },
    async prepareProjection(input) {
      prepared += 1
      preparedInputs.push(input)
      assert.deepEqual(
        Object.keys(input).sort(),
        [
          'actorEmail',
          'channelStateGlobalId',
          'expectedIntegrationAccountGlobalId',
          'expectedMode',
          'expectedProductGid',
          'idempotencyKey',
          'imageAssetId',
          'organizationId',
          'productId',
          'publicOrigin',
        ],
      )
      if (input.expectedMode !== selectedGrant.mode) {
        throw new ProjectionError(
          'SHOPIFY_PRODUCT_MEDIA_MODE_CONFIRMATION_MISMATCH',
          'mode mismatch',
          409,
        )
      }
      return selectedGrant
    },
    async executeWriteback(input) {
      writes.push(input)
      return {
        effect: effectFor(input, selectedGrant.mode),
        productGid: input.productGid,
        replayed: false,
        providerMutationAccepted: selectedGrant.mode === 'active',
        media: selectedGrant.mode === 'active'
          ? {
              mediaImageGid:
                'gid://shopify/MediaImage/987654321',
              status: 'PROCESSING',
              errors: [],
              ready: false,
            }
          : null,
      }
    },
  }
}

prepared = 0
writes = []
preparedInputs = []
const active = grant()
const activeResult = await projection.executeShopifyProductImagePublish(
  command(),
  dependencies(active),
)
assert.equal(prepared, 1)
assert.equal(writes.length, 1)
assert.equal(writes[0].accountGlobalId, active.integrationAccountGlobalId)
assert.equal(writes[0].productGid, active.productGid)
assert.equal(writes[0].credentialGeneration, active.credentialGeneration)
assert.equal(writes[0].activationRevision, active.activationRevision)
assert.equal(writes[0].aggregateHash, active.aggregateHash)
assert.equal(writes[0].mode, 'active')
assert.equal(writes[0].idempotencyKey, active.idempotencyKey)
assert.equal(
  writes[0].productMediaAuthorizationId,
  active.productWriteAuthorizationId,
)
assert.notEqual(
  writes[0].idempotencyKey,
  command().idempotencyKey,
)
assert.equal(
  writes[0].patch.image.alt,
  active.assetAltText,
)
assert.match(
  writes[0].patch.image.originalSource,
  /^https:\/\/clawpilot\.example\.com\/api\/integrations\/commerce\/shopify\/product-media\//,
)
assert.equal(activeResult.externalEffect.providerWriteCount, 1)
assert.equal(activeResult.providerMutation.accepted, true)
assert.equal(
  activeResult.mediaPublication.mediaImageGid,
  'gid://shopify/MediaImage/987654321',
)
assert.equal(activeResult.mediaPublication.status, 'PROCESSING')
assert.equal(activeResult.mediaPublication.ready, false)
assert.equal(
  activeResult.mediaPublication.primaryPositionConfirmed,
  false,
)
assert.equal(
  activeResult.mediaPublication.nextAction,
  'await_media_ready',
)

const reconciliationContext = {
  deliveryGrantId: active.id,
  externalEffectId: '88888888-8888-4888-8888-888888888888',
  externalEffectGlobalId: 'gcef0000001',
  effectState: 'succeeded',
  leaseExpired: false,
  integrationAccountGlobalId: active.integrationAccountGlobalId,
  credentialGeneration: active.credentialGeneration,
  productGid: active.productGid,
  mediaImageGid: 'gid://shopify/MediaImage/987654321',
  mediaStatus: 'PROCESSING',
  mediaErrors: [],
  observedAt: null,
}
let statusReads = 0
let observations = 0
const readyReconciliation =
  await projection.reconcileShopifyProductImagePublish({
    organizationId,
    productId,
    externalEffectGlobalId: 'gcef0000001',
    actorEmail: 'admin@example.com',
  }, {
    async readContext() {
      return reconciliationContext
    },
    async recoverExpiredClaim() {
      throw new Error('successful effect must not be recovered')
    },
    async readProviderStatus() {
      statusReads += 1
      return {
        mediaImageGid: reconciliationContext.mediaImageGid,
        status: 'READY',
        errors: [],
        ready: true,
      }
    },
    async recordObservation(input) {
      observations += 1
      assert.equal(input.status, 'READY')
      return {
        status: 'READY',
        errors: [],
        observedAt: '2026-07-30T00:05:00.000Z',
        replayed: false,
      }
    },
  })
assert.equal(readyReconciliation.status, 'READY')
assert.equal(readyReconciliation.terminal, true)
assert.equal(readyReconciliation.providerWriteCount, 0)
assert.equal(statusReads, 1)
assert.equal(observations, 1)

statusReads = 0
const replayedTerminal =
  await projection.reconcileShopifyProductImagePublish({
    organizationId,
    productId,
    externalEffectGlobalId: 'gcef0000001',
    actorEmail: 'admin@example.com',
  }, {
    async readContext() {
      return {
        ...reconciliationContext,
        mediaStatus: 'READY',
        observedAt: '2026-07-30T00:05:00.000Z',
      }
    },
    async recoverExpiredClaim() {
      throw new Error('terminal effect must not be recovered')
    },
    async readProviderStatus() {
      statusReads += 1
      throw new Error('terminal media must not call Shopify')
    },
    async recordObservation() {
      throw new Error('terminal media must not append another observation')
    },
  })
assert.equal(replayedTerminal.status, 'READY')
assert.equal(replayedTerminal.providerNetworkCalls, 0)
assert.equal(statusReads, 0)

let recoveredClaims = 0
const unknownRecovery =
  await projection.reconcileShopifyProductImagePublish({
    organizationId,
    productId,
    externalEffectGlobalId: 'gcef0000001',
    actorEmail: 'admin@example.com',
  }, {
    async readContext() {
      return {
        ...reconciliationContext,
        effectState: 'claimed',
        leaseExpired: true,
        mediaImageGid: null,
        mediaStatus: null,
      }
    },
    async recoverExpiredClaim() {
      recoveredClaims += 1
      return {
        ...reconciliationContext,
        effectState: 'unknown',
        leaseExpired: false,
        mediaImageGid: null,
        mediaStatus: null,
      }
    },
    async readProviderStatus() {
      throw new Error('unknown expired claim must not call Shopify')
    },
    async recordObservation() {
      throw new Error('unknown expired claim cannot record media status')
    },
  })
assert.equal(recoveredClaims, 1)
assert.equal(unknownRecovery.effectState, 'unknown')
assert.equal(unknownRecovery.providerNetworkCalls, 0)
assert.equal(
  unknownRecovery.nextAction,
  'investigate_unknown_provider_outcome',
)

prepared = 0
writes = []
await assert.rejects(
  projection.executeShopifyProductImagePublish(
    command({ executeProviderWrite: false }),
    dependencies(active),
  ),
  (error) =>
    error instanceof ProjectionError
    && error.code ===
      'SHOPIFY_PRODUCT_MEDIA_MODE_CONFIRMATION_MISMATCH',
)
assert.equal(prepared, 1)
assert.equal(writes.length, 0)

prepared = 0
writes = []
preparedInputs = []
const shadow = grant('shadow')
const shadowResult = await projection.executeShopifyProductImagePublish(
  command({ executeProviderWrite: false }),
  dependencies(shadow),
)
assert.equal(writes.length, 1)
assert.equal(writes[0].mode, 'shadow')
assert.equal(shadowResult.externalEffect.state, 'simulated')
assert.equal(shadowResult.externalEffect.providerWriteCount, 0)
assert.equal(shadowResult.providerMutation.accepted, false)
assert.equal(shadowResult.mediaPublication.mediaImageGid, null)
assert.equal(
  shadowResult.mediaPublication.nextAction,
  'shadow_simulation',
)

// Shopify mutates media at the parent Product level. Two local variant
// Products mapped to the same Shopify Product must therefore enter persistence
// with the same provider Product GID even though their local selections and
// asset-scoped command identities differ. The persistence source assertion
// below proves that this provider identity, not the local Product UUID, is the
// advisory-lock and unresolved-effect scope.
prepared = 0
writes = []
preparedInputs = []
const siblingProductId =
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const siblingImageAssetId =
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const siblingChannelStateGlobalId = 'gpcs0000002'
const parentProductGid = 'gid://shopify/Product/123456789'
const firstVariant = grant('shadow', { productGid: parentProductGid })
const siblingVariant = grant('shadow', {
  productId: siblingProductId,
  imageAssetId: siblingImageAssetId,
  channelStateGlobalId: siblingChannelStateGlobalId,
  productGid: parentProductGid,
})
await projection.executeShopifyProductImagePublish(
  command({ executeProviderWrite: false }),
  dependencies(firstVariant),
)
await projection.executeShopifyProductImagePublish(
  command({
    productId: siblingProductId,
    imageAssetId: siblingImageAssetId,
    channelStateGlobalId: siblingChannelStateGlobalId,
    executeProviderWrite: false,
  }),
  dependencies(siblingVariant),
)
assert.equal(preparedInputs.length, 2)
assert.notEqual(
  preparedInputs[0].productId,
  preparedInputs[1].productId,
)
assert.equal(
  preparedInputs[0].expectedProductGid,
  preparedInputs[1].expectedProductGid,
)
assert.equal(
  preparedInputs[0].expectedProductGid,
  parentProductGid,
)
assert.notEqual(
  preparedInputs[0].idempotencyKey,
  preparedInputs[1].idempotencyKey,
)
assert.equal(
  writes.every((input) => input.mode === 'shadow'),
  true,
)

prepared = 0
writes = []
preparedInputs = []
await assert.rejects(
  projection.executeShopifyProductImagePublish(
    command(),
    dependencies(shadow),
  ),
  (error) =>
    error instanceof ProjectionError
    && error.code ===
      'SHOPIFY_PRODUCT_MEDIA_MODE_CONFIRMATION_MISMATCH',
)
assert.equal(writes.length, 0)

prepared = 0
writes = []
await assert.rejects(
  projection.executeShopifyProductImagePublish(
    command(),
    dependencies(grant('active', {
      expiresAtEpoch: nowEpoch + 119,
    })),
  ),
  (error) =>
    error instanceof ProjectionError
    && error.code === 'SHOPIFY_PRODUCT_MEDIA_GRANT_EXPIRED',
)
assert.equal(
  writes.length,
  0,
  'near-expiry authority must make zero provider calls',
)

prepared = 0
writes = []
await assert.rejects(
  projection.executeShopifyProductImagePublish(
    command(),
    {
      ...dependencies(grant('active', {
        expiresAtEpoch: nowEpoch,
      })),
    },
  ),
  (error) =>
    error instanceof ProjectionError
    && error.code === 'SHOPIFY_PRODUCT_MEDIA_GRANT_EXPIRED',
)
assert.equal(writes.length, 0)

prepared = 0
writes = []
await assert.rejects(
  projection.executeShopifyProductImagePublish(
    command(),
    dependencies(grant('active', {
      publicOrigin: 'https://localhost',
    })),
  ),
  (error) =>
    error instanceof ProjectionError
    && error.code ===
      'SHOPIFY_PRODUCT_MEDIA_PUBLIC_ORIGIN_REQUIRED',
)
assert.equal(writes.length, 0)

const managerRoute = readFileSync(resolve(
  root,
  'app_src/app/api/crm/products/[productId]/shopify-product-image/route.ts',
), 'utf8')
assert.match(managerRoute, /assertSameOrigin\(req\)/)
assert.match(managerRoute, /effectiveAuthorizationRole/)
assert.match(managerRoute, /manageOperations/)
assert.match(managerRoute, /executeProviderWrite/)
assert.match(managerRoute, /publish-product-image/)
assert.match(managerRoute, /publication: result/)
assert.match(managerRoute, /session\?\.impersonating/)
assert.match(managerRoute, /refresh-product-image-status/)
assert.doesNotMatch(managerRoute, /project-primary-image/)
for (const forbidden of [
  "'accountGlobalId'",
  "'productGid'",
  "'credentialGeneration'",
  "'activationRevision'",
  "'aggregateRevision'",
  "'aggregateHash'",
  "'idempotencyKey'",
  "'scope'",
  "'url'",
]) {
  assert.equal(
    managerRoute.includes(forbidden),
    false,
    `manager route accepted forbidden client field ${forbidden}`,
  )
}

const publicRoute = readFileSync(resolve(
  root,
  'app_src/app/api/integrations/commerce/shopify/product-media/[token]/route.ts',
), 'utf8')
assert.match(publicRoute, /assertShopifyProductMediaTokenIsDeliverable/)
assert.match(publicRoute, /'Cache-Control': 'private, no-store/)
assert.match(publicRoute, /Do not log signed URLs/)
assert.doesNotMatch(publicRoute, /console\./)

const proxy = readFileSync(resolve(root, 'app_src/proxy.ts'), 'utf8')
assert.match(
  proxy,
  /startsWith\('\/api\/integrations\/commerce\/shopify\/product-media\/'\)/,
)

const persistence = readFileSync(resolve(
  root,
  'app_src/lib/persistence/shopifyProductMediaProjection.ts',
), 'utf8')
for (const fence of [
  'shopify-product-media:${input.organizationId}:${input.expectedIntegrationAccountGlobalId}:${input.expectedProductGid}',
  "account.organization_id = $1::uuid",
  "channel_state.provider = 'shopify'",
  'product_mapping.active = true',
  'image_asset.is_primary = true',
  "media_grant.desired_mode = 'active'",
  'media_grant.product_gid = $3',
  'media_grant.expires_at > to_timestamp($8)',
  'image_asset.content_sha256',
]) {
  assert.equal(
    persistence.includes(fence),
    true,
    `missing persistence fence ${fence}`,
  )
}
assert.doesNotMatch(
  persistence,
  /shopify-product-media:\$\{input\.organizationId\}:\$\{input\.productId\}/,
)
assert.match(
  persistence,
  /assertNoUnresolvedActiveImagePublish[\s\S]*productGid:[\s\S]*media_grant\.product_gid = \$3/,
)

const migration = readFileSync(resolve(
  root,
  'db/migrations/0154_shopify_product_media_delivery_grants.sql',
), 'utf8')
assert.match(
  migration,
  /UNIQUE \(organization_id, idempotency_key\)/,
)
assert.match(
  migration,
  /desired_mode = 'shadow'[\s\S]*interval '1 minute'/,
)
assert.match(
  migration,
  /BEFORE UPDATE OR DELETE/,
)

const authorityMigration = readFileSync(resolve(
  root,
  'db/migrations/0155_shopify_product_media_authority_and_reconciliation.sql',
), 'utf8')
assert.match(
  authorityMigration,
  /operations_shopify_product_media_write_authorizations/,
)
assert.match(
  authorityMigration,
  /operations_shopify_product_media_status_observations/,
)
assert.match(
  authorityMigration,
  /AND NOT exact_product_media_authority/,
)

console.log('shopify product media projection tests passed')
