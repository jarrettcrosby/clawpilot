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

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(',')}}`
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function assertRedacted(value) {
  const serialized = JSON.stringify(value)
  for (const secret of [
    'client-secret-value',
    'short-lived-access-token',
    'private-image-token',
  ]) {
    assert.equal(
      serialized.includes(secret),
      false,
      `redacted evidence exposed ${secret}`,
    )
  }
}

class MockShopifyCommerceClientError extends Error {
  constructor(
    message,
    status = 502,
    code = 'SHOPIFY_UPSTREAM_FAILED',
    retryable = false,
  ) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

function unavailable() {
  throw new Error('default dependency should be overridden by the test')
}

let graphqlImpl = unavailable

function loadWritebackModule() {
  const path =
    'app_src/lib/integrations/shopifyProductWriteback.ts'
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
      if (
        specifier ===
        '@/lib/integrations/commerceCredentialCrypto'
      ) {
        return {
          decryptCommerceCredential: unavailable,
          normalizeCommerceAccountGlobalId(value) {
            const normalized = String(value || '').trim().toLowerCase()
            if (!/^gia[0-9]{7}$/.test(normalized)) {
              throw new Error('invalid account')
            }
            return normalized
          },
          normalizeCommerceOrganizationId(value) {
            const normalized = String(value || '').trim().toLowerCase()
            if (
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                normalized,
              )
            ) {
              throw new Error('invalid organization')
            }
            return normalized
          },
        }
      }
      if (
        specifier === '@/lib/integrations/shopifyCommerceClient'
      ) {
        return {
          normalizeShopifyShopDomain(value) {
            const normalized = String(value || '').trim().toLowerCase()
            if (!/^[a-z0-9-]+\.myshopify\.com$/.test(normalized)) {
              throw new MockShopifyCommerceClientError(
                'invalid domain',
                400,
                'SHOPIFY_DOMAIN_INVALID',
              )
            }
            return normalized
          },
          probeShopifyConnection: unavailable,
          requestShopifyAccessToken: unavailable,
          shopifyAdminGraphql(...args) {
            return graphqlImpl(...args)
          },
          ShopifyCommerceClientError:
            MockShopifyCommerceClientError,
        }
      }
      if (
        specifier ===
        '@/lib/persistence/commerceExternalEffects'
      ) {
        return {
          assertRedactedCommerceExternalEffectEvidence: assertRedacted,
          claimCommerceExternalEffectsInPostgres: unavailable,
          commerceExternalEffectHash: hash,
          finalizeCommerceExternalEffectInPostgres: unavailable,
          prepareCommerceExternalEffectInPostgres: unavailable,
        }
      }
      if (
        specifier === '@/lib/persistence/commerceIntegrations'
      ) {
        return {
          readCommerceRuntimeCredentialFromPostgres: unavailable,
        }
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const writeback = loadWritebackModule()
const organizationId = '11111111-1111-4111-8111-111111111111'
const accountGlobalId = 'gia0000001'
const integrationAccountId =
  '22222222-2222-4222-8222-222222222222'
const productGid = 'gid://shopify/Product/123456789'
const shopGid = 'gid://shopify/Shop/987654321'
const categoryGid =
  'gid://shopify/TaxonomyCategory/aa-1-10'
const imageUrl =
  'https://assets.example.com/products/test-treat.png?signature=private-image-token'

function command(overrides = {}) {
  return {
    organizationId,
    accountGlobalId,
    mode: 'active',
    credentialGeneration: 7,
    activationRevision: 3,
    aggregateId: 'gp0000001',
    aggregateRevision: 11,
    aggregateHash: 'a'.repeat(64),
    idempotencyKey: 'shopify-product-gp0000001-r11',
    productGid,
    patch: {
      title: 'EPISCS Test Dog Treats',
      categoryGid,
      image: {
        originalSource: imageUrl,
        alt: 'EPISCS test dog treat bag',
      },
    },
    actorEmail: 'admin@example.com',
    workerId: 'focused-product-writeback-test',
    ...overrides,
  }
}

function effectFromPrepare(input, state = 'pending', overrides = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    globalId: 'gcef0000001',
    organizationId: input.organizationId,
    integrationAccountId,
    integrationAccountGlobalId: input.accountGlobalId,
    provider: input.provider,
    action: input.action,
    desiredMode: input.desiredMode,
    credentialGeneration: input.credentialGeneration,
    activationRevision: input.activationRevision,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateRevision: input.aggregateRevision,
    aggregateHash: input.aggregateHash,
    idempotencyKey: input.idempotencyKey,
    requestHash: hash(input.redactedRequest),
    redactedRequest: input.redactedRequest,
    state,
    providerAttemptId: state === 'claimed'
      ? '44444444-4444-4444-8444-444444444444'
      : null,
    leaseToken: state === 'claimed'
      ? '55555555-5555-4555-8555-555555555555'
      : null,
    leaseExpiresAt: state === 'claimed'
      ? '2026-07-30T03:00:00.000Z'
      : null,
    claimedBy: state === 'claimed'
      ? 'focused-product-writeback-test'
      : null,
    claimedAt: state === 'claimed'
      ? '2026-07-30T02:59:00.000Z'
      : null,
    redactedResult: input.simulationEvidence || null,
    terminalEvidenceHash: input.simulationEvidence
      ? hash(input.simulationEvidence)
      : null,
    providerReference: null,
    errorCode: null,
    providerWriteCount: 0,
    completedAt: state === 'simulated'
      ? '2026-07-30T02:59:00.000Z'
      : null,
    createdBy: input.actorEmail || null,
    createdAt: '2026-07-30T02:58:00.000Z',
    updatedAt: '2026-07-30T02:58:00.000Z',
    claimable: state === 'pending',
    staleReason: null,
    ...overrides,
  }
}

function runtime(overrides = {}) {
  return {
    organizationId,
    integrationAccountId,
    globalId: accountGlobalId,
    provider: 'shopify',
    environment: 'sandbox',
    externalAccountId: shopGid,
    status: 'active',
    verificationStatus: 'verified',
    credentialVersion: 7,
    authMode: 'shopify_client_credentials',
    configuration: {
      shopDomain: 'ag-alchemy.myshopify.com',
    },
    encrypted: {
      ciphertext: Buffer.from('encrypted'),
      iv: Buffer.alloc(12),
      tag: Buffer.alloc(16),
    },
    ...overrides,
  }
}

function providerResult(overrides = {}) {
  return {
    productGid,
    title: 'EPISCS Test Dog Treats',
    categoryGid,
    mediaRequested: true,
    media: {
      mediaImageGid:
        'gid://shopify/MediaImage/987654321',
      status: 'PROCESSING',
      errors: [],
      ready: false,
    },
    ...overrides,
  }
}

function dependencies(overrides = {}) {
  let prepared
  const calls = {
    prepare: 0,
    claim: 0,
    runtime: 0,
    decrypt: 0,
    token: 0,
    probe: 0,
    mutate: 0,
    finalize: [],
  }
  const deps = {
    async prepareExternalEffect(input) {
      calls.prepare += 1
      assertRedacted(input.redactedRequest)
      prepared = effectFromPrepare(
        input,
        input.desiredMode === 'shadow' ? 'simulated' : 'pending',
      )
      return prepared
    },
    async claimExternalEffects(input) {
      calls.claim += 1
      assert.equal(input.globalId, prepared.globalId)
      return [effectFromPrepare({
        ...prepared,
        accountGlobalId: prepared.integrationAccountGlobalId,
        desiredMode: prepared.desiredMode,
        simulationEvidence: null,
      }, 'claimed')]
    },
    async readRuntimeCredential() {
      calls.runtime += 1
      return runtime()
    },
    decryptCredential() {
      calls.decrypt += 1
      return {
        provider: 'shopify',
        authMode: 'shopify_client_credentials',
        clientId: 'shopify-client-id',
        clientSecret: 'client-secret-value',
      }
    },
    async requestAccessToken() {
      calls.token += 1
      return {
        accessToken: 'short-lived-access-token',
        grantedScopes: ['write_products'],
        expiresIn: 86_400,
        expiresAt: '2026-07-31T00:00:00.000Z',
      }
    },
    async probeConnection() {
      calls.probe += 1
      return {
        provider: 'shopify',
        apiVersion: '2026-07',
        shopId: shopGid,
        shopDomain: 'ag-alchemy.myshopify.com',
        shopName: 'AG Alchemy',
        grantedScopes: ['write_products'],
      }
    },
    async mutateProduct() {
      calls.mutate += 1
      return providerResult()
    },
    async finalizeExternalEffect(input) {
      calls.finalize.push(input)
      assertRedacted(input.redactedResult)
      return {
        ...prepared,
        state: input.outcome,
        redactedResult: input.redactedResult,
        providerReference: input.providerReference || null,
        errorCode: input.errorCode || null,
        providerWriteCount: input.providerWriteCount,
      }
    },
    ...overrides,
  }
  return { deps, calls, getPrepared: () => prepared }
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code)
    return true
  })
}

{
  const { deps, calls } = dependencies()
  await expectCode(
    () => writeback.executeShopifyProductWriteback(
      command({ productGid: '123456789' }),
      deps,
    ),
    'SHOPIFY_PRODUCT_GID_REQUIRED',
  )
  assert.equal(calls.prepare, 0)
}

{
  const { deps, calls, getPrepared } = dependencies()
  const result = await writeback.executeShopifyProductWriteback(
    command({ mode: 'shadow' }),
    deps,
  )
  assert.equal(result.effect.state, 'simulated')
  assert.equal(result.effect.providerWriteCount, 0)
  assert.equal(result.providerMutationAccepted, false)
  assert.equal(result.media, null)
  assert.equal(calls.prepare, 1)
  assert.equal(calls.claim, 0)
  assert.equal(calls.runtime, 0)
  assert.equal(calls.decrypt, 0)
  assert.equal(calls.token, 0)
  assert.equal(calls.probe, 0)
  assert.equal(calls.mutate, 0)
  assert.deepEqual(
    getPrepared().redactedResult.providerWrites,
    0,
  )
}

{
  const { deps, calls } = dependencies({
    async requestAccessToken() {
      calls.token += 1
      return {
        accessToken: 'short-lived-access-token',
        grantedScopes: ['read_products'],
        expiresIn: 86_400,
        expiresAt: '2026-07-31T00:00:00.000Z',
      }
    },
  })
  await expectCode(
    () => writeback.executeShopifyProductWriteback(command(), deps),
    'SHOPIFY_PRODUCT_WRITEBACK_SCOPE_REQUIRED',
  )
  assert.equal(calls.probe, 1)
  assert.equal(calls.mutate, 0)
  assert.equal(calls.finalize[0].outcome, 'failed')
  assert.equal(calls.finalize[0].providerWriteCount, 0)
}

{
  const { deps, calls } = dependencies({
    async probeConnection() {
      calls.probe += 1
      return {
        provider: 'shopify',
        apiVersion: '2026-07',
        shopId: shopGid,
        shopDomain: 'ag-alchemy.myshopify.com',
        shopName: 'AG Alchemy',
        grantedScopes: ['read_products'],
      }
    },
  })
  await expectCode(
    () => writeback.executeShopifyProductWriteback(command(), deps),
    'SHOPIFY_PRODUCT_WRITEBACK_SCOPE_REQUIRED',
  )
  assert.equal(calls.mutate, 0)
  assert.equal(calls.finalize[0].outcome, 'failed')
}

{
  const { deps, calls } = dependencies({
    async probeConnection() {
      calls.probe += 1
      return {
        provider: 'shopify',
        apiVersion: '2026-07',
        shopId: 'gid://shopify/Shop/111111111',
        shopDomain: 'ag-alchemy.myshopify.com',
        shopName: 'Wrong store',
        grantedScopes: ['write_products'],
      }
    },
  })
  await expectCode(
    () => writeback.executeShopifyProductWriteback(command(), deps),
    'SHOPIFY_PRODUCT_WRITEBACK_STORE_IDENTITY_MISMATCH',
  )
  assert.equal(calls.mutate, 0)
  assert.equal(calls.finalize[0].outcome, 'failed')
}

{
  let observedMutation
  const { deps, calls } = dependencies({
    async mutateProduct(credential, input, options) {
      calls.mutate += 1
      observedMutation = { credential, input, options }
      return providerResult()
    },
  })
  const result = await writeback.executeShopifyProductWriteback(
    command(),
    deps,
  )
  assert.equal(result.effect.state, 'succeeded')
  assert.equal(result.effect.providerReference, productGid)
  assert.equal(result.effect.providerWriteCount, 1)
  assert.equal(result.providerMutationAccepted, true)
  assert.equal(
    result.media.mediaImageGid,
    'gid://shopify/MediaImage/987654321',
  )
  assert.equal(result.media.status, 'PROCESSING')
  assert.equal(result.media.ready, false)
  assert.equal(observedMutation.input.productGid, productGid)
  assert.equal(observedMutation.input.patch.categoryGid, categoryGid)
  assert.equal(observedMutation.input.patch.image.originalSource, imageUrl)
  assert.equal(calls.finalize[0].redactedResult.providerWrites, 1)
  assert.equal(
    calls.finalize[0].redactedResult.media.id,
    'gid://shopify/MediaImage/987654321',
  )
  assert.equal(
    calls.finalize[0].redactedResult.media.status,
    'PROCESSING',
  )
  assert.equal(
    calls.finalize[0].redactedResult.providerMutationAccepted,
    true,
  )
  assertRedacted(calls.finalize[0].redactedResult)
}

{
  const { deps, calls } = dependencies({
    async mutateProduct() {
      calls.mutate += 1
      throw new writeback.ShopifyProductWritebackError({
        code: 'SHOPIFY_PRODUCT_UPDATE_REJECTED',
        message: 'rejected',
        status: 409,
        providerRejected: true,
      })
    },
  })
  await expectCode(
    () => writeback.executeShopifyProductWriteback(command(), deps),
    'SHOPIFY_PRODUCT_UPDATE_REJECTED',
  )
  assert.equal(calls.finalize[0].outcome, 'failed')
  assert.equal(calls.finalize[0].providerWriteCount, 0)
  assert.equal(
    calls.finalize[0].redactedResult.providerWritesKnown,
    true,
  )
}

{
  let durable
  const { deps, calls } = dependencies({
    async prepareExternalEffect(input) {
      calls.prepare += 1
      if (durable) return durable
      durable = effectFromPrepare(input, 'pending')
      return durable
    },
    async claimExternalEffects() {
      calls.claim += 1
      return [effectFromPrepare({
        ...durable,
        accountGlobalId: durable.integrationAccountGlobalId,
        desiredMode: durable.desiredMode,
        simulationEvidence: null,
      }, 'claimed')]
    },
    async mutateProduct() {
      calls.mutate += 1
      throw new MockShopifyCommerceClientError(
        'timed out after dispatch',
        504,
        'SHOPIFY_TIMEOUT',
        true,
      )
    },
    async finalizeExternalEffect(input) {
      calls.finalize.push(input)
      durable = {
        ...durable,
        state: input.outcome,
        redactedResult: input.redactedResult,
        providerReference: null,
        errorCode: input.errorCode,
        providerWriteCount: input.providerWriteCount,
      }
      return durable
    },
  })
  await expectCode(
    () => writeback.executeShopifyProductWriteback(command(), deps),
    'SHOPIFY_TIMEOUT',
  )
  assert.equal(durable.state, 'unknown')
  assert.equal(
    durable.redactedResult.providerWritesKnown,
    false,
  )
  assert.equal(calls.mutate, 1)
  await expectCode(
    () => writeback.executeShopifyProductWriteback(command(), deps),
    'SHOPIFY_PRODUCT_WRITEBACK_OUTCOME_UNKNOWN',
  )
  assert.equal(calls.mutate, 1)
  assert.equal(calls.claim, 1)
}

{
  const { deps, calls } = dependencies({
    async claimExternalEffects(input) {
      calls.claim += 1
      return [{
        ...effectFromPrepare({
          organizationId,
          accountGlobalId,
          provider: 'shopify',
          action: 'shopify.product.update',
          desiredMode: 'active',
          credentialGeneration: 7,
          activationRevision: 3,
          aggregateType:
            writeback.SHOPIFY_PRODUCT_WRITEBACK_AGGREGATE_TYPE,
          aggregateId: 'gp0000001',
          aggregateRevision: 11,
          aggregateHash: 'a'.repeat(64),
          idempotencyKey: 'shopify-product-gp0000001-r11',
          redactedRequest: {},
        }, 'claimed'),
        globalId: 'gcef9999999',
      }]
    },
  })
  await expectCode(
    () => writeback.executeShopifyProductWriteback(command(), deps),
    'SHOPIFY_PRODUCT_WRITEBACK_EFFECT_MISMATCH',
  )
  assert.equal(calls.runtime, 0)
  assert.equal(calls.mutate, 0)
}

{
  let observed
  graphqlImpl = async (credential, input, options) => {
    observed = { credential, input, options }
    return {
      productUpdate: {
        product: {
          id: productGid,
          title: 'EPISCS Test Dog Treats',
          category: { id: categoryGid },
          media: {
            nodes: [{
              id: 'gid://shopify/MediaImage/987654321',
              mediaContentType: 'IMAGE',
              status: 'UPLOADED',
              mediaErrors: [],
            }],
          },
        },
        userErrors: [],
      },
    }
  }
  const result = await writeback.updateShopifyProduct(
    {
      shopDomain: 'ag-alchemy.myshopify.com',
      accessToken: 'short-lived-access-token',
    },
    {
      productGid,
      patch: command().patch,
    },
    { timeoutMs: 10_000 },
  )
  assert.equal(result.productGid, productGid)
  assert.equal(
    result.media.mediaImageGid,
    'gid://shopify/MediaImage/987654321',
  )
  assert.equal(result.media.status, 'UPLOADED')
  assert.equal(result.media.ready, false)
  assert.equal(
    observed.input.operationName,
    'ClawPilotShopifyProductUpdate',
  )
  assert.equal(observed.input.variables.product.id, productGid)
  assert.equal(
    observed.input.variables.product.category,
    categoryGid,
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(observed.input.variables.media)),
    [{
      mediaContentType: 'IMAGE',
      originalSource: imageUrl,
      alt: 'EPISCS test dog treat bag',
    }],
  )
  assert.match(
    observed.input.query,
    /media\(last: 1\)/,
  )
  assert.match(
    observed.input.query,
    /mediaErrors \{/,
  )
}

{
  graphqlImpl = async () => ({
    productUpdate: {
      product: {
        id: productGid,
        title: 'EPISCS Test Dog Treats',
        category: { id: categoryGid },
        media: {
          nodes: [{
            id: 'gid://shopify/MediaImage/987654322',
            mediaContentType: 'IMAGE',
            status: 'FAILED',
            mediaErrors: [{
              code: 'INVALID_IMAGE_FILE',
              message: 'The image could not be processed.',
              details: 'Unsupported image bytes.',
            }],
          }],
        },
      },
      userErrors: [],
    },
  })
  const result = await writeback.updateShopifyProduct(
    {
      shopDomain: 'ag-alchemy.myshopify.com',
      accessToken: 'short-lived-access-token',
    },
    {
      productGid,
      patch: command().patch,
    },
  )
  assert.equal(result.media.status, 'FAILED')
  assert.equal(result.media.ready, false)
  assert.equal(result.media.errors[0].code, 'INVALID_IMAGE_FILE')
  assert.equal(
    result.media.errors[0].message,
    'The image could not be processed.',
  )
}

{
  graphqlImpl = async () => ({
    productUpdate: {
      product: null,
      userErrors: [{
        field: ['product', 'title'],
        message: 'Title is invalid',
        code: 'INVALID',
      }],
    },
  })
  await expectCode(
    () => writeback.updateShopifyProduct(
      {
        shopDomain: 'ag-alchemy.myshopify.com',
        accessToken: 'short-lived-access-token',
      },
      {
        productGid,
        patch: { title: 'EPISCS Test Dog Treats' },
      },
    ),
    'SHOPIFY_PRODUCT_UPDATE_REJECTED',
  )
}

{
  const exactAuthorizationId =
    '99999999-9999-4999-8999-999999999999'
  const { deps, calls } = dependencies()
  let preparedInput
  const defaultPrepare = deps.prepareExternalEffect
  deps.prepareExternalEffect = async (input) => {
    preparedInput = input
    return defaultPrepare(input)
  }
  deps.readRuntimeCredential = async () => {
    calls.runtime += 1
    return runtime({ status: 'disabled' })
  }
  const result = await writeback.executeShopifyProductWriteback(
    command({
      patch: {
        image: {
          originalSource: imageUrl,
          alt: 'EPISCS test dog treat bag',
        },
      },
      productMediaAuthorizationId: exactAuthorizationId,
    }),
    deps,
  )
  assert.equal(result.providerMutationAccepted, true)
  assert.equal(
    preparedInput.shopifyProductMediaAuthorizationId,
    exactAuthorizationId,
  )
  assert.equal(
    preparedInput.redactedRequest.productMediaAuthorizationId,
    exactAuthorizationId,
  )
  assert.equal(calls.mutate, 1)
}

{
  const { deps, calls } = dependencies()
  deps.readRuntimeCredential = async () => {
    calls.runtime += 1
    return runtime({ status: 'disabled' })
  }
  await expectCode(
    () => writeback.executeShopifyProductWriteback(command(), deps),
    'SHOPIFY_PRODUCT_WRITEBACK_RUNTIME_STALE',
  )
  assert.equal(calls.mutate, 0)
}

console.log('shopify product writeback checks passed')
