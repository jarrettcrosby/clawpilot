#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks) {
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
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    String,
    console,
    exports: module.exports,
    module,
    process,
    structuredClone,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      if (
        specifier
        === '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
      ) {
        return integrationCredentialRuntimeGate
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const organizationId = '11111111-1111-4111-8111-111111111111'
const integrationAccountId = '22222222-2222-4222-8222-222222222222'
const accountGlobalId = 'gia1234567'
const externalAccountId = 'brand_ag_alchemy'
const externalOrderId = 'bo_order_revision_123'

const module = loadTypeScriptModule(
  'app_src/lib/integrations/faireOrderRevision.ts',
  {
    '@/lib/integrations/commerceCredentialCrypto': {
      decryptCommerceCredential: () => ({
        provider: 'faire',
        authMode: 'faire_oauth',
        accessToken: 'secret-token',
        applicationId: 'application-id',
        applicationSecret: 'application-secret-value',
        scopes: ['READ_BRAND', 'READ_ORDERS'],
      }),
      commerceOrderRevisionProtectedContentFingerprint: (
        _value,
        _organizationId,
        _accountGlobalId,
        _externalOrderId,
        kind,
      ) => (kind === 'party' ? 'd' : 'e').repeat(64),
      encryptCommerceOrderRevisionProtectedSnapshot: (
        _value,
        _organizationId,
        _accountGlobalId,
        _externalOrderId,
        _sourceHash,
        kind,
      ) => ({
        ciphertext: Buffer.from('revision-test'),
        iv: Buffer.alloc(12),
        tag: Buffer.alloc(16),
        keyId: 'revision-test-k1',
        hash: (kind === 'party' ? 'd' : 'e').repeat(64),
        encryptionVersion: 1,
      }),
      normalizeCommerceAccountGlobalId(value) {
        if (!/^gia(?:[0-9]{7}|[0-9a-v]{12})$/u.test(value)) {
          throw new Error('invalid account')
        }
        return value
      },
      normalizeCommerceOrganizationId(value) {
        if (!/^[0-9a-f-]{36}$/u.test(value)) {
          throw new Error('invalid organization')
        }
        return value
      },
    },
    '@/lib/integrations/faireCommerceClient': {
      getFaireOrder: async () => null,
      probeFaireBrandProfile: async () => null,
    },
    '@/lib/integrations/faireCommerceNormalizer': {
      normalizeFaireCommerce: () => null,
    },
    '@/lib/integrations/commerceReadRuntime': {
      commerceReadCredentialEligible: () => true,
    },
    '@/lib/operations/commerceNormalization': {
      commerceSourceHash: () => 'f'.repeat(64),
    },
    '@/lib/persistence/commerceIntegrations': {
      readCommerceRuntimeCredentialFromPostgres: async () => null,
    },
    '@/lib/integrations/commerceOrderRevisionEvidence': {
      commerceOrderRevisionProtectedPlaintext(field) {
        return field?.state === 'available' ? field.value : null
      },
      commerceOrderRevisionHash(value) {
        return createHash('sha256').update(JSON.stringify({
          version: value.version,
          provider: value.provider,
          externalAccountId: value.externalAccountId,
          order: value.order,
        })).digest('hex')
      },
    },
  },
)

const target = {
  organizationId,
  accountGlobalId,
  integrationAccountId,
  externalAccountId,
  credentialVersion: 4,
  canonicalOrderGlobalId: 'gor1234567',
  canonicalOrderRowVersion: 0,
  externalOrderId,
}

const runtime = {
  organizationId,
  integrationAccountId,
  globalId: accountGlobalId,
  provider: 'faire',
  environment: 'production',
  externalAccountId,
  status: 'active',
  verificationStatus: 'verified',
  credentialVersion: 4,
  authMode: 'faire_oauth',
  configuration: {},
  encrypted: {},
}

const available = (value) => ({ state: 'available', value })
const unavailable = () => ({
  state: 'unavailable',
  value: null,
  reason: 'not_provided',
})
const money = (amountMinor) => available({
  primary: { amountMinor: BigInt(amountMinor), currency: 'USD' },
  shop: unavailable(),
  presentment: unavailable(),
})
const line = (id, quantity, hashCharacter) => ({
  identity: { provider: 'faire', resourceType: 'order_line', value: id },
  productIdentity: available({
    provider: 'faire',
    resourceType: 'product',
    value: `product_${id}`,
  }),
  variantIdentity: available({
    provider: 'faire',
    resourceType: 'variant',
    value: `variant_${id}`,
  }),
  sku: `SKU-${id}`,
  orderedQuantity: quantity,
  currentQuantity: null,
  cancelledQuantity: null,
  fulfilledQuantity: null,
  unfulfilledQuantity: null,
  returnedQuantity: null,
  removedOrRefundedQuantity: null,
  unitMultiplier: 1,
  physicalUnitQuantity: quantity,
  requiresShipping: true,
  unitPrice: money(1200),
  lineSubtotal: money(1200 * quantity),
  sourceHash: hashCharacter.repeat(64),
})

const normalizedOrder = (overrides = {}) => ({
  identity: {
    provider: 'faire',
    resourceType: 'order',
    value: externalOrderId,
  },
  orderNumber: 'FAIRE-123',
  providerCreatedAt: '2026-08-01T12:00:00.000Z',
  providerProcessedAt: null,
  providerUpdatedAt: '2026-08-12T15:00:00.000Z',
  providerCancelledAt: null,
  providerClosedAt: null,
  rawStates: {
    lifecycle: 'NEW',
    payment: null,
    fulfillment: 'UNFULFILLED',
    returns: null,
  },
  canonicalStates: {
    lifecycle: 'open',
    payment: 'unknown',
    fulfillment: 'unfulfilled',
    returns: 'unknown',
  },
  currency: 'USD',
  subtotal: money(3600),
  shipping: money(0),
  tax: money(0),
  discount: money(0),
  total: money(3600),
  headerMoney: { state: 'complete' },
  party: available({
    role: 'retailer',
    contactName: available('Private Customer'),
    email: available('private@example.com'),
  }),
  shipTo: available({
    line1: available('100 Private Street'),
    city: available('Private City'),
  }),
  requestedDeliveryAt: available('2026-08-20T00:00:00.000Z'),
  lines: [line('oi_2', 2, 'b'), line('oi_1', 1, 'c')],
  lineItemsTruncated: false,
  sourceStale: false,
  sourceHash: 'a'.repeat(64),
  ...overrides,
})

const providerOrder = (overrides = {}) => ({
  id: externalOrderId,
  brand_id: externalAccountId,
  state: 'NEW',
  shipments: [],
  items: [
    {
      id: 'oi_1', product_id: 'product_oi_1', variant_id: 'variant_oi_1',
      sku: 'SKU-oi_1', quantity: 1, state: 'PROCESSING',
    },
    {
      id: 'oi_2', product_id: 'product_oi_2', variant_id: 'variant_oi_2',
      sku: 'SKU-oi_2', quantity: 2, state: 'PROCESSING',
    },
  ],
  ...overrides,
})

function dependencies(overrides = {}) {
  const calls = []
  const deps = {
    readRuntimeCredential: async () => structuredClone(runtime),
    decryptCredential: () => ({
      provider: 'faire',
      authMode: 'faire_oauth',
      accessToken: 'secret-token',
      applicationId: 'application-id',
      applicationSecret: 'application-secret-value',
      scopes: ['READ_BRAND', 'READ_ORDERS'],
    }),
    credentialEligible: () => true,
    probeBrandProfile: async (options) => {
      calls.push({ operation: 'probeBrandProfile', options })
      return { id: externalAccountId }
    },
    getOrder: async (options, orderId) => {
      calls.push({ operation: 'getOrder', options, orderId })
      return providerOrder()
    },
    normalize: (source, context) => {
      calls.push({ operation: 'normalize', source, context })
      return {
        provider: 'faire',
        orders: [normalizedOrder()],
        rejections: [],
      }
    },
    ...overrides,
  }
  return { deps, calls }
}

{
  const { deps, calls } = dependencies()
  const evidence = await module.inspectFaireCanonicalOrderRevision(
    target,
    deps,
  )
  assert.equal(evidence.providerReads, 2)
  assert.equal(evidence.providerWrites, 0)
  assert.equal(evidence.sourceHash, 'a'.repeat(64))
  assert.equal(evidence.sourceRevision, '2026-08-12T15:00:00.000Z')
  assert.match(evidence.revisionHash, /^[a-f0-9]{64}$/u)
  assert.equal(evidence.snapshot.canonicalOrderRowVersion, 0)
  assert.equal(evidence.snapshot.order.externalOrderId, externalOrderId)
  assert.equal(
    evidence.snapshot.order.sourceRevision,
    '2026-08-12T15:00:00.000Z',
  )
  assert.deepEqual(
    evidence.snapshot.order.lines.map((item) => item.externalLineId),
    ['oi_1', 'oi_2'],
  )
  assert.equal(evidence.snapshot.version, 'faire-canonical-order-revision-v2')
  assert.deepEqual(JSON.parse(JSON.stringify(
    evidence.snapshot.order.providerRevisionState,
  )), {
    orderState: 'NEW',
    shipmentCount: 0,
    lineStateBasis: 'all_processing',
    quantityBasis: 'exact_order_item_quantity',
  })
  assert.deepEqual(
    JSON.parse(JSON.stringify(evidence.snapshot.order.lines.map((item) => ({
      id: item.externalLineId,
      current: item.currentQuantity,
      cancelled: item.cancelledQuantity,
      fulfilled: item.fulfilledQuantity,
      unfulfilled: item.unfulfilledQuantity,
      returned: item.returnedQuantity,
      removed: item.removedOrRefundedQuantity,
    })))),
    [
      { id: 'oi_1', current: 1, cancelled: 0, fulfilled: 0,
        unfulfilled: 1, returned: 0, removed: 0 },
      { id: 'oi_2', current: 2, cancelled: 0, fulfilled: 0,
        unfulfilled: 2, returned: 0, removed: 0 },
    ],
  )
  assert.match(evidence.snapshot.order.partyFingerprint, /^[a-f0-9]{64}$/u)
  assert.match(evidence.snapshot.order.shipToFingerprint, /^[a-f0-9]{64}$/u)
  assert.notEqual(
    evidence.snapshot.order.partyFingerprint,
    evidence.snapshot.order.shipToFingerprint,
  )
  assert.doesNotMatch(JSON.stringify(evidence.snapshot), /Private/u)
  assert.deepEqual(
    calls.map((call) => call.operation),
    ['probeBrandProfile', 'getOrder', 'normalize'],
  )
  assert.equal(calls[1].orderId, externalOrderId)
  assert.equal(
    JSON.stringify(calls[2].source.orders.orders),
    JSON.stringify([providerOrder()]),
  )
  assert.equal(calls[2].context.sourceState, 'current')
}

{
  const observedAt = '2026-08-12T16:00:00.000Z'
  const one = module.faireCanonicalOrderRevisionSnapshot({
    target,
    order: normalizedOrder(),
    providerOrder: providerOrder(),
    observedAt,
  })
  const two = module.faireCanonicalOrderRevisionSnapshot({
    target,
    order: normalizedOrder({
      lines: [...normalizedOrder().lines].reverse(),
    }),
    providerOrder: providerOrder(),
    observedAt,
  })
  assert.equal(
    module.faireCanonicalOrderRevisionHash(one),
    module.faireCanonicalOrderRevisionHash(two),
    'provider line ordering must not create a new revision',
  )
  assert.equal(
    module.faireCanonicalOrderRevisionHash(one),
    module.faireCanonicalOrderRevisionHash({
      ...two,
      credentialVersion: 99,
      canonicalOrderRowVersion: 12,
      observedAt: '2026-08-13T16:00:00.000Z',
    }),
    'poll time and local authority changes must not create a provider revision',
  )
  assert.notEqual(
    module.faireCanonicalOrderRevisionHash(one),
    module.faireCanonicalOrderRevisionHash({
      ...two,
      order: {
        ...two.order,
        sourceHash: '9'.repeat(64),
      },
    }),
    'changed provider content must create a new revision hash',
  )
}

{
  const processing = module.faireCanonicalOrderRevisionSnapshot({
    target,
    order: normalizedOrder({
      rawStates: {
        lifecycle: 'PROCESSING',
        payment: null,
        fulfillment: 'UNFULFILLED',
        returns: null,
      },
    }),
    providerOrder: providerOrder({ state: 'PROCESSING' }),
    observedAt: '2026-08-12T16:05:00.000Z',
  })
  assert.equal(
    processing.order.providerRevisionState.quantityBasis,
    'unavailable',
    'PROCESSING must remain fail-closed for wholly-unstarted structural Apply',
  )
  assert.ok(processing.order.lines.every((item) => (
    item.currentQuantity === null && item.unfulfilledQuantity === null
  )))
}

{
  const cancelled = normalizedOrder({
    providerCancelledAt: '2026-08-12T15:05:00.000Z',
    rawStates: {
      lifecycle: 'CANCELED',
      payment: null,
      fulfillment: 'UNFULFILLED',
      returns: null,
    },
    canonicalStates: {
      lifecycle: 'cancelled',
      payment: 'unknown',
      fulfillment: 'unfulfilled',
      returns: 'unknown',
    },
  })
  const { deps } = dependencies({
    getOrder: async () => providerOrder({
      state: 'CANCELED',
      items: providerOrder().items.map((item) => ({
        ...item,
        state: 'CANCELED',
      })),
    }),
    normalize: () => ({
      provider: 'faire',
      orders: [cancelled],
      rejections: [],
    }),
  })
  const evidence = await module.inspectFaireCanonicalOrderRevision(
    target,
    deps,
  )
  assert.equal(evidence.snapshot.order.canonicalStates.lifecycle, 'cancelled')
  assert.equal(
    evidence.snapshot.order.providerCancelledAt,
    '2026-08-12T15:05:00.000Z',
  )
}

{
  const { deps, calls } = dependencies({
    readRuntimeCredential: async () => ({
      ...runtime,
      credentialVersion: 5,
    }),
  })
  await assert.rejects(
    module.inspectFaireCanonicalOrderRevision(target, deps),
    (error) => error.code === 'FAIRE_ORDER_REVISION_AUTHORITY_STALE',
  )
  assert.equal(calls.length, 0)
}

{
  const { deps, calls } = dependencies({
    decryptCredential: () => ({
      provider: 'faire',
      authMode: 'faire_oauth',
      accessToken: 'secret-token',
      applicationId: 'application-id',
      applicationSecret: 'application-secret-value',
      scopes: ['READ_ORDERS'],
    }),
  })
  await assert.rejects(
    module.inspectFaireCanonicalOrderRevision(target, deps),
    (error) => error.code === 'FAIRE_ORDER_REVISION_SCOPE_REQUIRED',
  )
  assert.equal(calls.length, 0)
}

{
  const { deps } = dependencies({
    probeBrandProfile: async () => ({ id: 'different_brand' }),
  })
  await assert.rejects(
    module.inspectFaireCanonicalOrderRevision(target, deps),
    (error) => error.code === 'FAIRE_ORDER_REVISION_ACCOUNT_CHANGED',
  )
}

{
  const { deps } = dependencies({
    getOrder: async () => providerOrder({ id: 'bo_other_order' }),
  })
  await assert.rejects(
    module.inspectFaireCanonicalOrderRevision(target, deps),
    (error) => error.code === 'FAIRE_ORDER_REVISION_ORDER_CHANGED',
  )
}

{
  const { deps } = dependencies({
    getOrder: async () => providerOrder({
      items: { nodes: [{ id: 'oi_1' }], hasNextPage: true },
    }),
  })
  await assert.rejects(
    module.inspectFaireCanonicalOrderRevision(target, deps),
    (error) => error.code === 'FAIRE_ORDER_REVISION_LINES_TRUNCATED',
  )
}

{
  const { deps } = dependencies({
    getOrder: async () => providerOrder({ items: null }),
  })
  await assert.rejects(
    module.inspectFaireCanonicalOrderRevision(target, deps),
    (error) => error.code === 'FAIRE_ORDER_REVISION_LINES_INVALID',
  )
}

const source = read('app_src/lib/integrations/faireOrderRevision.ts')
assert.match(source, /getFaireOrder/u)
assert.match(source, /probeFaireBrandProfile/u)
assert.doesNotMatch(source, /listFaireOrders/u)
assert.match(source, /providerWrites: 0/u)

const revisionClaim = {
  ...target,
  targetId: '33333333-3333-4333-8333-333333333333',
  workerId: 'faire-revision-test-worker',
  canonicalOrderId: '44444444-4444-4444-8444-444444444444',
  provider: 'faire',
  acceptedSourceHash: '0'.repeat(64),
}
const workerClaims = [
  revisionClaim,
  {
    ...revisionClaim,
    targetId: '55555555-5555-4555-8555-555555555555',
    canonicalOrderId: '66666666-6666-4666-8666-666666666666',
    canonicalOrderGlobalId: 'gor7654321',
    externalOrderId: 'bo_order_revision_failed',
  },
  {
    ...revisionClaim,
    targetId: '77777777-7777-4777-8777-777777777777',
    canonicalOrderId: '88888888-8888-4888-8888-888888888888',
    canonicalOrderGlobalId: 'gor7654322',
    externalOrderId: 'bo_order_revision_store_sync_paused',
  },
]
const captureCalls = []
const failCalls = []
const parkCalls = []
const providerReadClaims = []
const storeSyncAssertions = []
let claimedInput = null
class CommerceOrderRevisionStoreSyncPausedError extends Error {
  constructor() {
    super('Store sync paused before Faire revision provider read')
    this.name = 'CommerceOrderRevisionStoreSyncPausedError'
    this.code = 'COMMERCE_ORDER_REVISION_STORE_SYNC_PAUSED'
  }
}
const workerModule = loadTypeScriptModule(
  'app_src/lib/commerceFaireOrderRevisionWorker.ts',
  {
    '@/lib/integrations/faireOrderRevision': {
      FaireOrderRevisionError: module.FaireOrderRevisionError,
      async inspectFaireCanonicalOrderRevision(claim) {
        providerReadClaims.push(claim.externalOrderId)
        assert.notEqual(
          claim,
          workerClaims[2],
          'A Paused account must send zero Faire revision provider reads',
        )
        if (claim === workerClaims[1]) {
          throw new module.FaireOrderRevisionError(
            'FAIRE_ORDER_REVISION_PROVIDER_READ_FAILED',
            'provider read failed',
            true,
          )
        }
        const snapshot = module.faireCanonicalOrderRevisionSnapshot({
          target: claim,
          order: normalizedOrder(),
          providerOrder: providerOrder(),
          observedAt: '2026-08-12T16:30:00.000Z',
        })
        return {
          sourceRevision: snapshot.order.sourceRevision,
          sourceHash: snapshot.order.sourceHash,
          revisionHash: module.faireCanonicalOrderRevisionHash(snapshot),
          snapshot,
          providerReads: 2,
          providerWrites: 0,
        }
      },
    },
    '@/lib/persistence/commerceOrderRevisions': {
      CommerceOrderRevisionStoreSyncPausedError,
      async claimCommerceOrderRevisionTargetsInPostgres(input) {
        claimedInput = input
        return workerClaims
      },
      async assertCommerceOrderRevisionStoreSyncRunningInPostgres(claim) {
        storeSyncAssertions.push(claim.externalOrderId)
        if (claim === workerClaims[2]) {
          throw new CommerceOrderRevisionStoreSyncPausedError()
        }
      },
      async captureCommerceOrderRevisionObservationInPostgres(input) {
        captureCalls.push(input)
        return { changed: true }
      },
      async failCommerceOrderRevisionTargetInPostgres(input) {
        failCalls.push(input)
        return 'failed'
      },
      async parkCommerceOrderRevisionTargetForStoreSyncPauseInPostgres(input) {
        parkCalls.push(input)
        return true
      },
    },
    '@/lib/persistence/commerceStoreSync': {
      CommerceStoreSyncProviderReadFenceError: class extends Error {},
      async withCommerceStoreSyncProviderReadFenceInPostgres(input) {
        return input.read({
          id: '00000000-0000-4000-8000-000000000298',
          organizationId: input.organizationId,
          integrationAccountId: input.integrationAccountId,
          authorityKind: input.authorityKind,
          readKind: input.readKind,
          controlRevision: 1,
          activationRevision: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      },
    },
  },
)
const workerResult = await workerModule.processFaireOrderRevisions({
  workerId: revisionClaim.workerId,
  limit: 3,
})
assert.equal(claimedInput.provider, 'faire')
assert.equal(claimedInput.workerId, revisionClaim.workerId)
assert.equal(claimedInput.limit, 3)
assert.equal(workerResult.claimed, 3)
assert.equal(workerResult.captured, 1)
assert.equal(workerResult.changed, 1)
assert.equal(workerResult.failed, 1)
assert.equal(workerResult.parked, 1)
assert.equal(workerResult.providerReadsPerCapture, 2)
assert.equal(workerResult.providerWrites, 0)
assert.equal(workerResult.canonicalOrderWrites, 0)
assert.equal(workerResult.managerDispositionRequired, 1)
assert.deepEqual(
  { ...workerResult.failureCodes },
  {
    FAIRE_ORDER_REVISION_PROVIDER_READ_FAILED: 1,
  },
)
assert.deepEqual(storeSyncAssertions, workerClaims.map(
  (claim) => claim.externalOrderId,
))
assert.deepEqual(providerReadClaims, workerClaims.slice(0, 2).map(
  (claim) => claim.externalOrderId,
))
assert.equal(captureCalls.length, 1)
assert.equal(captureCalls[0].sourceHash, 'a'.repeat(64))
assert.equal(captureCalls[0].providerReads, 2)
assert.equal(captureCalls[0].providerWrites, 0)
assert.equal(failCalls.length, 1)
assert.equal(
  failCalls[0].errorCode,
  'FAIRE_ORDER_REVISION_PROVIDER_READ_FAILED',
)
assert.equal(parkCalls.length, 1)
assert.equal(parkCalls[0].claim, workerClaims[2])

const workerSource = read('app_src/lib/commerceFaireOrderRevisionWorker.ts')
assert.match(workerSource, /claimCommerceOrderRevisionTargetsInPostgres/u)
assert.match(workerSource, /assertCommerceOrderRevisionStoreSyncRunningInPostgres/u)
assert.match(workerSource, /CommerceOrderRevisionStoreSyncPausedError/u)
assert.match(workerSource, /captureCommerceOrderRevisionObservationInPostgres/u)
assert.match(workerSource, /failCommerceOrderRevisionTargetInPostgres/u)
assert.match(workerSource, /parkCommerceOrderRevisionTargetForStoreSyncPauseInPostgres/u)
assert.match(workerSource, /canonicalOrderWrites: 0 as const/u)
assert.doesNotMatch(workerSource, /cancelFaireOrder|moveOrderToProcessing/u)

console.log('Faire canonical-order revision contract tests passed')
