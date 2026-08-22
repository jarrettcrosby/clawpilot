#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function load(path, mocks = {}) {
  const output = ts.transpileModule(readFileSync(resolve(path), 'utf8'), {
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
    Buffer,
    Date,
    Error,
    Headers,
    Object,
    Promise,
    Response,
    Set,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    Uint8Array,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    setTimeout,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const faire = load('app_src/lib/integrations/faireCommerceClient.ts')
const binding = {
  provider: 'faire',
  environment: 'production',
  accountGlobalId: 'giaFaireWrites1',
  externalAccountId: 'b_brand123',
  credentialVersion: 7,
  connectionStatus: 'active',
  verificationStatus: 'verified',
}
const authorization = {
  provider: 'faire',
  environment: 'production',
  accountGlobalId: binding.accountGlobalId,
  externalAccountId: binding.externalAccountId,
  credentialVersion: binding.credentialVersion,
  authorizationRevision: 4,
  capabilities: [
    'product_draft_create',
    'product_draft_update',
    'product_image_upload',
    'inventory_update',
    'order_processing',
    'fulfillment_export',
    'tracking_export',
  ],
  verifiedWriteScopes: [
    'WRITE_PRODUCTS',
    'WRITE_INVENTORIES',
    'WRITE_ORDERS',
  ],
  scopeVerificationSource: 'oauth_grant',
}

let unauthorizedFetches = 0
const unauthorized = faire.createFaireCommerceClient({
  accessToken: 'faire-test-token-unauthorized',
  fetchImpl: async () => {
    unauthorizedFetches += 1
    return new Response('{}')
  },
})
await assert.rejects(
  () => unauthorized.createDraftProduct({}),
  (error) => error?.code === 'FAIRE_WRITE_AUTHORIZATION_REQUIRED',
)
assert.equal(unauthorizedFetches, 0)

assert.throws(
  () => faire.createFaireCommerceClient({
    accessToken: 'faire-test-token-advertised-only',
    credentialBinding: binding,
    writeAuthorization: {
      ...authorization,
      scopeVerificationSource: 'advertised_scope',
    },
  }),
  (error) => error?.code === 'FAIRE_WRITE_AUTHORIZATION_INVALID',
  'advertised provider scope vocabulary must never authorize a write',
)
for (const scopeVerificationSource of [
  'provider_confirmation',
  'successful_provider_effect',
]) {
  assert.throws(
    () => faire.createFaireCommerceClient({
      accessToken: `faire-test-token-${scopeVerificationSource}`,
      credentialBinding: binding,
      writeAuthorization: {
        ...authorization,
        scopeVerificationSource,
      },
    }),
    (error) => error?.code === 'FAIRE_WRITE_AUTHORIZATION_INVALID',
    `${scopeVerificationSource} must never authorize a provider write`,
  )
}

let wrongBrandMutations = 0
const wrongBrandClient = faire.createFaireCommerceClient({
  accessToken: 'faire-test-token-wrong-brand',
  credentialBinding: binding,
  writeAuthorization: authorization,
  fetchImpl: async (url) => {
    if (String(url).endsWith('/brands/profile')) {
      return new Response(JSON.stringify({ brand_id: 'b_otherbrand' }))
    }
    wrongBrandMutations += 1
    return new Response('{}')
  },
})
await assert.rejects(
  () => wrongBrandClient.uploadProductImage({
    attachmentBase64: Buffer.from('wrong brand fixture').toString('base64'),
  }),
  (error) => error?.code === 'FAIRE_WRITE_BRAND_MISMATCH',
  'the live token brand must be proved immediately before an image write',
)
assert.equal(wrongBrandMutations, 0)

const requests = []
let productReadback = null
const inventoryReadbacks = new Map()
const client = faire.createFaireCommerceClient({
  accessToken: 'faire-test-token-authorized',
  credentialBinding: binding,
  writeAuthorization: authorization,
  fetchImpl: async (url, init) => {
    const request = {
      url: String(url),
      method: init.method,
      body: init.body ? JSON.parse(init.body) : null,
    }
    requests.push(request)
    if (request.url.endsWith('/brands/profile')) {
      return new Response(JSON.stringify({
        brand_id: binding.externalAccountId,
      }))
    }
    if (request.url.endsWith('/products/upload-image')) {
      return new Response(JSON.stringify({
        url: 'https://cdn.faire.com/test-image.png',
      }))
    }
    if (request.url.includes('/product-inventory/')) {
      const path = request.url.split('?')[0]
      if (request.method === 'PATCH') {
        const bySku = path.endsWith('/by-skus')
        const levels = Object.fromEntries(request.body.inventories.map(
          (inventory) => [
            bySku ? inventory.sku : inventory.product_variant_id,
            {
              on_hand_quantity: {
                type: 'QUANTITY',
                quantity: inventory.on_hand_quantity,
              },
              committed_quantity: { type: 'QUANTITY', quantity: 0 },
              available_quantity: {
                type: 'QUANTITY',
                quantity: inventory.on_hand_quantity,
              },
            },
          ],
        ))
        inventoryReadbacks.set(path, levels)
      }
      return new Response(JSON.stringify({
        inventories: inventoryReadbacks.get(path),
      }))
    }
    if (request.url.endsWith('/orders/bo_order123/shipments')) {
      return new Response(JSON.stringify({
        id: 'bo_order123',
        state: 'PRE_TRANSIT',
        shipments: [],
      }))
    }
    if (request.url.endsWith('/products/p_product123')) {
      if (request.method === 'PATCH') {
        productReadback = { ...productReadback, ...request.body }
      }
      return new Response(JSON.stringify(productReadback))
    }
    if (request.url.endsWith('/products')) {
      productReadback = {
        id: 'p_product123',
        brand_id: binding.externalAccountId,
        ...request.body,
      }
      return new Response(JSON.stringify({
        id: 'p_product123',
        lifecycle_state: 'DRAFT',
      }))
    }
    if (request.url.endsWith('/orders/bo_order123/processing')) {
      return new Response(JSON.stringify({
        id: 'bo_order123',
        state: 'PROCESSING',
      }))
    }
    throw new Error(`Unexpected fixture request ${request.method} ${request.url}`)
  },
})

const created = await client.createDraftProduct({
  idempotenceToken: 'product-token-123',
  name: 'ClawPilot Faire draft test product',
  shortDescription: 'Unpublished integration test product',
  variants: [{
    idempotenceToken: 'variant-token-123',
    name: 'Test variant',
    sku: 'TEST-SKU-1',
    prices: [{
      geoConstraint: { country: 'USA' },
      wholesalePrice: { amountMinor: 0, currency: 'usd' },
      retailPrice: { amountMinor: 0, currency: 'usd' },
    }],
  }],
  unitMultiplier: 1,
  minimumOrderQuantity: 1,
})
assert.equal(created.id, 'p_product123')
const createRequest = requests.find((request) => (
  request.method === 'POST' && request.url.endsWith('/products')
))
assert.ok(createRequest)
assert.equal(createRequest.body.lifecycle_state, 'DRAFT')
assert.equal(createRequest.body.sale_state, undefined)
assert.equal(createRequest.body.variants[0].idempotence_token, 'variant-token-123')
assert.equal(createRequest.body.variants[0].prices[0].wholesale_price.amount_minor, 0)
assert.equal(createRequest.body.variants[0].prices[0].geo_constraint.country, 'USA')
assert.equal(requests[0].url.endsWith('/brands/profile'), true)
assert.equal(requests[1], createRequest)
assert.equal(requests[2].method, 'GET', 'created product must be read back')

await client.updateDraftProduct('p_product123', { name: 'Updated draft' })
const updateProbeIndex = requests.findIndex((request, index) => (
  index > 2 && request.url.endsWith('/brands/profile')
))
assert.ok(updateProbeIndex > 2)
assert.equal(requests[updateProbeIndex + 1].method, 'GET')
assert.equal(
  requests[updateProbeIndex + 1].url.endsWith('/products/p_product123'),
  true,
  'draft state must be read after the brand probe and before PATCH',
)
assert.equal(requests[updateProbeIndex + 2].method, 'PATCH')
assert.deepEqual(
  JSON.parse(JSON.stringify(requests[updateProbeIndex + 2].body)),
  { name: 'Updated draft' },
)
assert.equal(
  requests[updateProbeIndex + 3].method,
  'GET',
  'updated product must be read back after PATCH',
)

await client.uploadProductImage({
  attachmentBase64: Buffer.from('bounded image fixture').toString('base64'),
})
const imageRequestIndex = requests.findIndex((request) => (
  request.url.endsWith('/products/upload-image')
))
assert.ok(imageRequestIndex > 0)
assert.equal(requests[imageRequestIndex - 1].url.endsWith('/brands/profile'), true)
assert.equal(requests[imageRequestIndex].method, 'POST')
assert.equal(
  requests[imageRequestIndex].body.attachment,
  Buffer.from('bounded image fixture').toString('base64'),
)

productReadback = {
  ...productReadback,
  lifecycle_state: 'PUBLISHED',
  images: [{
    url: 'https://cdn.faire.com/existing-image.png',
    sequence: 0,
  }],
}
await client.updateProductImages('p_product123', {
  expectedCurrentImages: [{
    url: 'https://cdn.faire.com/existing-image.png',
    sequence: 0,
  }],
  images: [{
    url: 'https://cdn.faire.com/existing-image.png',
    sequence: 0,
  }, {
    url: 'https://cdn.faire.com/test-image.png',
    sequence: 1,
  }],
})
const publishedImagePatch = requests.findLast((request) => (
  request.method === 'PATCH'
  && request.url.endsWith('/products/p_product123')
))
assert.deepEqual(JSON.parse(JSON.stringify(publishedImagePatch.body)), {
  images: [{
    url: 'https://cdn.faire.com/existing-image.png',
    sequence: 0,
  }, {
    url: 'https://cdn.faire.com/test-image.png',
    sequence: 1,
  }],
})
assert.equal(
  requests[requests.indexOf(publishedImagePatch) - 1].method,
  'GET',
  'published lifecycle must be read before the image-only PATCH',
)
assert.equal(
  requests[requests.indexOf(publishedImagePatch) + 1].method,
  'GET',
  'published Product images must be read back exactly after PATCH',
)

productReadback = {
  ...productReadback,
  images: [...productReadback.images, {
    url: 'https://cdn.faire.com/concurrent-image.png',
    sequence: 2,
  }],
}
const patchCountBeforeConcurrencyCheck = requests.filter((request) => (
  request.method === 'PATCH'
  && request.url.endsWith('/products/p_product123')
)).length
await assert.rejects(
  client.updateProductImages('p_product123', {
    expectedCurrentImages: [{
      url: 'https://cdn.faire.com/existing-image.png',
      sequence: 0,
    }, {
      url: 'https://cdn.faire.com/test-image.png',
      sequence: 1,
    }],
    images: [{
      url: 'https://cdn.faire.com/existing-image.png',
      sequence: 0,
    }, {
      url: 'https://cdn.faire.com/test-image.png',
      sequence: 1,
    }, {
      url: 'https://cdn.faire.com/new-image.png',
      sequence: 2,
    }],
  }),
  (error) => error?.code === 'FAIRE_PRODUCT_IMAGE_BASE_SET_CHANGED',
  'a concurrent Faire image edit must fail before the replacement PATCH',
)
assert.equal(
  requests.filter((request) => (
    request.method === 'PATCH'
    && request.url.endsWith('/products/p_product123')
  )).length,
  patchCountBeforeConcurrencyCheck,
)

await client.updateInventory({
  by: 'skus',
  inventories: [{
    sku: 'TEST-SKU-1',
    productVariantId: 'po_variant123',
    onHandQuantity: -3,
  }, {
    sku: 'TEST-SKU-2',
    productVariantId: 'po_variant456',
    onHandQuantity: 7,
  }],
})
const skuInventoryPatch = requests.find((request) => (
  request.method === 'PATCH'
  && request.url.endsWith('/product-inventory/by-skus')
))
assert.ok(skuInventoryPatch)
assert.equal(
  requests[requests.indexOf(skuInventoryPatch) - 1].url.endsWith('/brands/profile'),
  true,
)
assert.deepEqual(JSON.parse(JSON.stringify(skuInventoryPatch.body)), {
  inventories: [{
    sku: 'TEST-SKU-1',
    product_variant_id: 'po_variant123',
    on_hand_quantity: -3,
  }, {
    sku: 'TEST-SKU-2',
    product_variant_id: 'po_variant456',
    on_hand_quantity: 7,
  }],
})
assert.equal(
  requests[requests.indexOf(skuInventoryPatch) + 1].url,
  'https://www.faire.com/external-api/v2/product-inventory/by-skus?skus=TEST-SKU-1&skus=TEST-SKU-2',
  'inventory must be read back by the exact requested SKU',
)

await client.updateInventory({
  by: 'product_variant_ids',
  inventories: [{
    productVariantId: 'po_variant123',
    sku: 'TEST-SKU-1',
    onHandQuantity: 0,
  }, {
    productVariantId: 'po_variant456',
    sku: 'TEST-SKU-2',
    onHandQuantity: 11,
  }],
})
const variantInventoryPatch = requests.find((request) => (
  request.method === 'PATCH'
  && request.url.endsWith('/product-inventory/by-product-variant-ids')
))
assert.ok(variantInventoryPatch)
assert.equal(
  requests[requests.indexOf(variantInventoryPatch) + 1].url,
  'https://www.faire.com/external-api/v2/product-inventory/by-product-variant-ids?ids=po_variant123&ids=po_variant456',
)

await client.moveOrderToProcessing('bo_order123')
await client.moveOrderToProcessing('bo_order123', { expectedShipDate: null })
const processingRequests = requests.filter((request) => (
  request.url.endsWith('/orders/bo_order123/processing')
))
assert.deepEqual(processingRequests.map((request) => request.body), [
  {},
  {},
])

await client.addOrderShipments('bo_order123', [{
  carrier: 'UPS',
  trackingCode: '1ZFAIRETEST',
  shippingType: 'SHIP_ON_YOUR_OWN',
}])
const shipmentRequest = requests.find((request) => (
  request.url.endsWith('/orders/bo_order123/shipments')
))
assert.ok(shipmentRequest)
assert.equal(shipmentRequest.method, 'POST')
assert.deepEqual(JSON.parse(JSON.stringify(shipmentRequest.body)), {
  shipments: [{
    order_id: 'bo_order123',
    carrier: 'UPS',
    tracking_code: '1ZFAIRETEST',
    shipping_type: 'SHIP_ON_YOUR_OWN',
  }],
})

const productMismatchClient = faire.createFaireCommerceClient({
  accessToken: 'faire-product-mismatch-token',
  credentialBinding: binding,
  writeAuthorization: authorization,
  fetchImpl: async (url, init) => {
    if (String(url).endsWith('/brands/profile')) {
      return new Response(JSON.stringify({ brand_id: binding.externalAccountId }))
    }
    if (init.method === 'POST') {
      return new Response(JSON.stringify({
        id: 'p_mismatch',
        lifecycle_state: 'DRAFT',
      }))
    }
    return new Response(JSON.stringify({
      id: 'p_mismatch',
      brand_id: binding.externalAccountId,
      lifecycle_state: 'DRAFT',
      name: 'ClawPilot Faire draft test product',
      variants: [{ name: 'Test variant', sku: 'WRONG-SKU' }],
    }))
  },
})
await assert.rejects(
  () => productMismatchClient.createDraftProduct({
    idempotenceToken: 'product-token-456',
    name: 'ClawPilot Faire draft test product',
    variants: [{
      idempotenceToken: 'variant-token-456',
      name: 'Test variant',
      sku: 'EXPECTED-SKU',
      prices: [{
        wholesalePrice: { amountMinor: 100, currency: 'USD' },
        retailPrice: { amountMinor: 200, currency: 'USD' },
      }],
    }],
    unitMultiplier: 1,
    minimumOrderQuantity: 1,
  }),
  (error) => error?.code === 'FAIRE_PRODUCT_READBACK_MISMATCH',
)

let mismatchedProductPatches = 0
const productBrandMismatchClient = faire.createFaireCommerceClient({
  accessToken: 'faire-product-brand-mismatch-token',
  credentialBinding: binding,
  writeAuthorization: authorization,
  fetchImpl: async (url, init) => {
    if (String(url).endsWith('/brands/profile')) {
      return new Response(JSON.stringify({ brand_id: binding.externalAccountId }))
    }
    if (init.method === 'PATCH') mismatchedProductPatches += 1
    return new Response(JSON.stringify({
      id: 'p_product123',
      brand_id: 'b_otherbrand',
      lifecycle_state: 'DRAFT',
      name: 'Draft',
      variants: [],
    }))
  },
})
await assert.rejects(
  () => productBrandMismatchClient.updateDraftProduct(
    'p_product123',
    { name: 'Must not write across brands' },
  ),
  (error) => error?.code === 'FAIRE_PRODUCT_BRAND_READBACK_MISMATCH',
)
assert.equal(mismatchedProductPatches, 0)

const inventoryMismatchClient = faire.createFaireCommerceClient({
  accessToken: 'faire-inventory-mismatch-token',
  credentialBinding: binding,
  writeAuthorization: authorization,
  fetchImpl: async (url) => String(url).endsWith('/brands/profile')
    ? new Response(JSON.stringify({ brand_id: binding.externalAccountId }))
    : new Response(JSON.stringify({
      inventories: {
        'OTHER-SKU': {
          on_hand_quantity: { type: 'QUANTITY', quantity: 99 },
        },
      },
    })),
})
await assert.rejects(
  () => inventoryMismatchClient.updateInventory({
    by: 'skus',
    inventories: [{ sku: 'EXPECTED-SKU', onHandQuantity: -2 }],
  }),
  (error) => error?.code === 'FAIRE_INVENTORY_READBACK_MISMATCH',
)

const readiness = load(
  'app_src/lib/integrations/faireFulfillmentReadiness.ts',
)
const readinessInput = {
  authMode: 'faire_oauth',
  environment: 'production',
  status: 'active',
  configured: true,
  verificationStatus: 'verified',
  externalIdentityMatches: true,
  credentialGenerationMatches: true,
  scopeEvidenceRecorded: false,
  scopeEvidenceCurrent: false,
  scopeVerificationSource: 'not_exposed_by_provider',
  currentCapabilities: [],
}
const brandTokenReadiness = readiness.faireFulfillmentWriteReadiness({
  ...readinessInput,
  authMode: 'faire_brand_token',
})
assert.equal(brandTokenReadiness.ready, false)
assert.equal(
  brandTokenReadiness.blockedBy.code,
  'FAIRE_FULFILLMENT_OAUTH_REQUIRED',
)
assert.equal(brandTokenReadiness.providerWrites, 0)

const missingEvidenceReadiness = readiness
  .faireFulfillmentWriteReadiness(readinessInput)
assert.equal(missingEvidenceReadiness.ready, false)
assert.equal(
  missingEvidenceReadiness.blockedBy.code,
  'FAIRE_FULFILLMENT_SCOPE_EVIDENCE_UNAVAILABLE',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(missingEvidenceReadiness.requiredScopes)),
  ['READ_BRAND', 'READ_ORDERS', 'READ_SHIPMENTS', 'WRITE_ORDERS'],
)

const staleEvidenceReadiness = readiness.faireFulfillmentWriteReadiness({
  ...readinessInput,
  scopeEvidenceRecorded: true,
})
assert.equal(
  staleEvidenceReadiness.blockedBy.code,
  'FAIRE_FULFILLMENT_SCOPE_EVIDENCE_STALE',
)

const staleBindingReadiness = readiness.faireFulfillmentWriteReadiness({
  ...readinessInput,
  externalIdentityMatches: false,
})
assert.equal(
  staleBindingReadiness.blockedBy.code,
  'FAIRE_FULFILLMENT_CREDENTIAL_BINDING_MISMATCH',
)
assert.equal(staleBindingReadiness.credentialBinding.current, false)

const missingClaimsReadiness = readiness.faireFulfillmentWriteReadiness({
  ...readinessInput,
  scopeEvidenceRecorded: true,
  scopeEvidenceCurrent: true,
  scopeVerificationSource: 'oauth_grant',
  currentCapabilities: ['fulfillment_export'],
})
assert.equal(
  missingClaimsReadiness.blockedBy.code,
  'FAIRE_FULFILLMENT_ACTIVE_CAPABILITIES_REQUIRED',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(missingClaimsReadiness.activeCapabilities.missing)),
  ['order_update', 'tracking_export'],
)

const readyFulfillment = readiness.faireFulfillmentWriteReadiness({
  ...readinessInput,
  scopeEvidenceRecorded: true,
  scopeEvidenceCurrent: true,
  scopeVerificationSource: 'oauth_grant',
  currentCapabilities: [
    'tracking_export',
    'order_update',
    'fulfillment_export',
  ],
})
assert.equal(readyFulfillment.ready, true)
assert.equal(readyFulfillment.blockedBy, null)
assert.equal(readyFulfillment.credentialBinding.current, true)
assert.equal(readyFulfillment.providerWrites, 0)

const writeback = load(
  'app_src/lib/integrations/faireFulfillmentWriteback.ts',
  { '@/lib/integrations/faireCommerceClient': faire },
)
const writebackInput = {
  mode: 'execute',
  writeAttempt: {
    attemptId: 'faire-attempt:order123:001',
    authorizationRevision: authorization.authorizationRevision,
    state: 'authorized',
  },
  credential: {
    accessToken: 'faire-test-token-authorized',
    binding,
  },
  authorization: {
    ...authorization,
    capabilities: ['order_processing', 'fulfillment_export', 'tracking_export'],
    verifiedWriteScopes: ['WRITE_ORDERS'],
  },
  externalOrderId: 'bo_order123',
  packages: [
    { packageReference: 'pkg-1', carrier: 'UPS', trackingCode: '1ZPKG1' },
    { packageReference: 'pkg-2', carrier: 'FEDEX', trackingCode: 'PKG2' },
  ],
}
const shipmentReadback = {
  id: 'bo_order123',
  state: 'PRE_TRANSIT',
  shipments: [
    { id: 's_shipment1', carrier: 'UPS', tracking_code: '1ZPKG1' },
    { id: 's_shipment2', carrier: 'FEDEX', tracking_code: 'PKG2' },
  ],
}

function fixtureClient({ orders, addError = null }) {
  const calls = {
    probe: 0,
    reads: 0,
    processing: 0,
    processingInput: 'not-called',
    adds: 0,
    shipments: null,
  }
  return {
    calls,
    client: {
      probeBrandProfile: async () => {
        calls.probe += 1
        return { brand_id: binding.externalAccountId }
      },
      getOrder: async () => {
        const value = orders[Math.min(calls.reads, orders.length - 1)]
        calls.reads += 1
        if (value instanceof Error) throw value
        return value
      },
      moveOrderToProcessing: async (_orderId, input) => {
        calls.processing += 1
        calls.processingInput = input
        return { id: 'bo_order123', state: 'PROCESSING' }
      },
      addOrderShipments: async (_orderId, shipments) => {
        calls.adds += 1
        calls.shipments = shipments
        if (addError) throw addError
        return shipmentReadback
      },
    },
  }
}

const normal = fixtureClient({
  orders: [
    { id: 'bo_order123', state: 'NEW', shipments: [] },
    { id: 'bo_order123', state: 'PROCESSING', shipments: [] },
    shipmentReadback,
  ],
})
let normalMutationLeaseChecks = 0
const normalResult = await writeback.executeFaireFulfillmentWriteback(
  writebackInput,
  { createClient: () => normal.client },
  async () => {
    normalMutationLeaseChecks += 1
  },
)
assert.equal(normalResult.outcome, 'succeeded')
assert.equal(normalResult.writeAttempt.state, 'succeeded')
assert.equal(normalResult.replayed, false)
assert.equal(normal.calls.processing, 1)
assert.equal(
  normal.calls.processingInput,
  undefined,
  'omitted expectedShipDate must remain omitted',
)
assert.equal(normal.calls.adds, 1)
assert.equal(
  normalMutationLeaseChecks,
  2,
  'Faire must recheck the sealed lease immediately before both mutations',
)
assert.equal(normal.calls.shipments.length, 2)
assert.ok(normal.calls.shipments.every(
  (shipment) => shipment.shippingType === 'SHIP_ON_YOUR_OWN',
))

const blockedProcessing = fixtureClient({
  orders: [{ id: 'bo_order123', state: 'NEW', shipments: [] }],
})
await assert.rejects(
  () => writeback.executeFaireFulfillmentWriteback(
    writebackInput,
    { createClient: () => blockedProcessing.client },
    async () => {
      throw new Error('sealed lease expired before processing mutation')
    },
  ),
  /sealed lease expired/u,
)
assert.equal(blockedProcessing.calls.processing, 0)
assert.equal(blockedProcessing.calls.adds, 0)

const blockedShipment = fixtureClient({
  orders: [{ id: 'bo_order123', state: 'PROCESSING', shipments: [] }],
})
await assert.rejects(
  () => writeback.executeFaireFulfillmentWriteback(
    writebackInput,
    { createClient: () => blockedShipment.client },
    async () => {
      throw new Error('sealed lease expired before shipment mutation')
    },
  ),
  /sealed lease expired/u,
)
assert.equal(blockedShipment.calls.adds, 0)

const explicitNullDate = fixtureClient({
  orders: [
    { id: 'bo_order123', state: 'NEW', shipments: [] },
    { id: 'bo_order123', state: 'PROCESSING', shipments: [] },
    shipmentReadback,
  ],
})
await writeback.executeFaireFulfillmentWriteback({
  ...writebackInput,
  expectedShipDate: null,
  writeAttempt: {
    ...writebackInput.writeAttempt,
    attemptId: 'faire-attempt:order123:002',
  },
}, { createClient: () => explicitNullDate.client })
assert.deepEqual(
  JSON.parse(JSON.stringify(explicitNullDate.calls.processingInput)),
  { expectedShipDate: null },
  'explicit null expectedShipDate must not be stringified',
)

const replay = fixtureClient({ orders: [shipmentReadback] })
const replayResult = await writeback.executeFaireFulfillmentWriteback(
  writebackInput,
  { createClient: () => replay.client },
)
assert.equal(replayResult.outcome, 'succeeded')
assert.equal(replayResult.replayed, true)
assert.equal(replay.calls.adds, 0, 'replay must not submit another shipment')

const partial = fixtureClient({
  orders: [{
    id: 'bo_order123',
    state: 'PROCESSING',
    shipments: [shipmentReadback.shipments[0]],
  }],
})
await assert.rejects(
  () => writeback.executeFaireFulfillmentWriteback(
    writebackInput,
    { createClient: () => partial.client },
  ),
  (error) => error?.code === 'FAIRE_FULFILLMENT_PARTIAL_MATCH',
  'partial multi-package provider state must fail closed',
)
assert.equal(
  partial.calls.adds,
  0,
  'partial multi-package provider state must never repeat any shipment',
)

const conflictingShipmentCases = [
  {
    label: 'unrelated provider shipment',
    shipments: [{
      id: 's_unrelated',
      carrier: 'UPS',
      tracking_code: '1ZUNRELATED',
    }],
  },
  {
    label: 'provider shipment without tracking',
    shipments: [{ id: 's_missingtracking', carrier: 'UPS' }],
  },
  {
    label: 'provider shipment without carrier',
    shipments: [{ id: 's_missingcarrier', tracking_code: '1ZMISSINGCARRIER' }],
  },
  {
    label: 'duplicate provider shipment identity',
    shipments: [
      shipmentReadback.shipments[0],
      { ...shipmentReadback.shipments[0] },
    ],
  },
]
for (const conflict of conflictingShipmentCases) {
  const fixture = fixtureClient({
    orders: [{
      id: 'bo_order123',
      state: 'PROCESSING',
      shipments: conflict.shipments,
    }],
  })
  await assert.rejects(
    () => writeback.executeFaireFulfillmentWriteback(
      writebackInput,
      { createClient: () => fixture.client },
    ),
    (error) => error?.code === 'FAIRE_FULFILLMENT_PARTIAL_MATCH',
    `${conflict.label} must fail closed`,
  )
  assert.equal(
    fixture.calls.adds,
    0,
    `${conflict.label} must never submit a shipment batch`,
  )
}

const timeoutError = new faire.FaireCommerceClientError(
  'timeout',
  504,
  'FAIRE_REQUEST_TIMEOUT',
  true,
)
const timeoutReconciled = fixtureClient({
  orders: [
    { id: 'bo_order123', state: 'PROCESSING', shipments: [] },
    shipmentReadback,
  ],
  addError: timeoutError,
})
const timeoutResult = await writeback.executeFaireFulfillmentWriteback(
  writebackInput,
  { createClient: () => timeoutReconciled.client },
)
assert.equal(timeoutResult.outcome, 'succeeded')
assert.equal(timeoutResult.reconciledUnknownOutcome, true)
assert.equal(timeoutReconciled.calls.adds, 1)

let providerNowShowsShipment = false
let unknownAdds = 0
const unknownClient = {
  probeBrandProfile: async () => ({ brand_id: binding.externalAccountId }),
  getOrder: async () => providerNowShowsShipment
    ? shipmentReadback
    : { id: 'bo_order123', state: 'PROCESSING', shipments: [] },
  moveOrderToProcessing: async () => ({}),
  addOrderShipments: async () => {
    unknownAdds += 1
    throw timeoutError
  },
}
const unknownResult = await writeback.executeFaireFulfillmentWriteback(
  writebackInput,
  { createClient: () => unknownClient },
)
assert.equal(unknownResult.outcome, 'unknown')
assert.equal(unknownResult.writeAttempt.state, 'outcome_unknown')
assert.equal(unknownAdds, 1)

let rejectedReexecutionClientCreations = 0
await assert.rejects(
  () => writeback.executeFaireFulfillmentWriteback({
    ...writebackInput,
    writeAttempt: unknownResult.writeAttempt,
  }, {
    createClient: () => {
      rejectedReexecutionClientCreations += 1
      return unknownClient
    },
  }),
  (error) => error?.code === 'FAIRE_FULFILLMENT_REEXECUTE_FORBIDDEN',
  'persisted unknown state must reject another execute call before provider IO',
)
assert.equal(rejectedReexecutionClientCreations, 0)

providerNowShowsShipment = true
const reconciledReplay = await writeback.executeFaireFulfillmentWriteback(
  {
    ...writebackInput,
    mode: 'reconcile_unknown',
    writeAttempt: unknownResult.writeAttempt,
  },
  { createClient: () => unknownClient },
)
assert.equal(reconciledReplay.outcome, 'succeeded')
assert.equal(reconciledReplay.replayed, true)
assert.equal(unknownAdds, 1, 'unknown reconciliation must never repeat POST')

providerNowShowsShipment = false
const stillUnknown = await writeback.executeFaireFulfillmentWriteback(
  {
    ...writebackInput,
    mode: 'reconcile_unknown',
    writeAttempt: unknownResult.writeAttempt,
  },
  { createClient: () => unknownClient },
)
assert.equal(stillUnknown.outcome, 'unknown')
assert.equal(unknownAdds, 1, 'unresolved reconciliation must remain read-only')

let invalidReconciliationClientCreations = 0
await assert.rejects(
  () => writeback.executeFaireFulfillmentWriteback({
    ...writebackInput,
    mode: 'reconcile_unknown',
  }, {
    createClient: () => {
      invalidReconciliationClientCreations += 1
      return unknownClient
    },
  }),
  (error) => (
    error?.code === 'FAIRE_FULFILLMENT_RECONCILIATION_STATE_REQUIRED'
  ),
)
assert.equal(invalidReconciliationClientCreations, 0)

let unauthorizedClientCreations = 0
await assert.rejects(
  () => writeback.executeFaireFulfillmentWriteback({
    ...writebackInput,
    authorization: {
      ...writebackInput.authorization,
      verifiedWriteScopes: [],
    },
  }, {
    createClient: () => {
      unauthorizedClientCreations += 1
      return unknownClient
    },
  }),
  (error) => error?.code === 'FAIRE_FULFILLMENT_AUTHORIZATION_STALE',
)
assert.equal(unauthorizedClientCreations, 0)

for (const scopeVerificationSource of [
  'provider_confirmation',
  'successful_provider_effect',
]) {
  let selfAssertedClientCreations = 0
  await assert.rejects(
    () => writeback.executeFaireFulfillmentWriteback({
      ...writebackInput,
      authorization: {
        ...writebackInput.authorization,
        scopeVerificationSource,
      },
    }, {
      createClient: () => {
        selfAssertedClientCreations += 1
        return unknownClient
      },
    }),
    (error) => error?.code === 'FAIRE_FULFILLMENT_AUTHORIZATION_INVALID',
    `${scopeVerificationSource} must fail before Faire client creation`,
  )
  assert.equal(selfAssertedClientCreations, 0)
}

const runtime = load(
  'app_src/lib/integrations/faireFulfillmentRuntime.ts',
  {
    '@/lib/integrations/commerceCredentialCrypto': {
      decryptCommerceCredential: () => {
        throw new Error('default decryptor must be replaced in this test')
      },
      normalizeCommerceAccountGlobalId: (value) => String(value).trim(),
      normalizeCommerceOrganizationId: (value) => String(value).trim(),
    },
    '@/lib/integrations/faireFulfillmentWriteback': {
      executeFaireFulfillmentWriteback: async () => {
        throw new Error('default executor must be replaced in this test')
      },
      reconcileFaireFulfillmentWritebackReadOnly: async () => {
        throw new Error('default reconciler must be replaced in this test')
      },
    },
    '@/lib/persistence/commerceIntegrations': {
      readCommerceRuntimeCredentialFromPostgres: async () => null,
    },
    '@/lib/persistence/commerceProviderWrites': {
      requireCurrentCommerceProviderWritesInPostgres: async () => {
        throw new Error('default Provider writes reader must be replaced in this test')
      },
      requireSealedCommerceProviderWritesInPostgres: async () => {
        throw new Error('default sealed Provider writes reader must be replaced in this test')
      },
    },
    '@/lib/persistence/commerceActiveTransitionAuthorization': {
      requireCurrentFaireFulfillmentScopeEvidenceInPostgres: async () => {
        throw new Error('default scope-evidence reader must be replaced in this test')
      },
    },
  },
)
const runtimeAccountGlobalId = 'gia1234567'
const runtimeOrganizationId = '11111111-1111-4111-8111-111111111111'
const runtimeExternalAccountId = 'b_brand123'
const runtimeCredential = {
  organizationId: runtimeOrganizationId,
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  globalId: runtimeAccountGlobalId,
  provider: 'faire',
  environment: 'production',
  externalAccountId: runtimeExternalAccountId,
  status: 'active',
  verificationStatus: 'verified',
  credentialVersion: 9,
  authMode: 'faire_oauth',
  configuration: {},
  encrypted: {},
}
const runtimeProviderWriteAuthority = {
  accountGlobalId: runtimeAccountGlobalId,
  provider: 'faire',
  environment: 'production',
  credentialGeneration: 9,
  controlRowVersion: 6,
  grantedScopes: ['READ_BRAND', 'READ_ORDERS', 'READ_SHIPMENTS', 'WRITE_ORDERS'],
  grantedScopeDigest: 'b'.repeat(64),
}
const runtimeProviderAttemptRequestHash = 'c'.repeat(64)
const runtimeProviderAttemptLeaseToken =
  '44444444-4444-4444-8444-444444444444'
const runtimeCommerceExportGlobalId = 'gfe1234567'
function runtimeProviderAttemptEvidence(providerAttemptGlobalId) {
  return {
    providerAttemptGlobalId,
    providerAttemptRequestHash: runtimeProviderAttemptRequestHash,
    providerAttemptLeaseToken: runtimeProviderAttemptLeaseToken,
    commerceExportGlobalId: runtimeCommerceExportGlobalId,
    providerWriteAccountGlobalId: runtimeAccountGlobalId,
    providerWriteProvider: 'faire',
    providerWriteEnvironment: 'production',
    providerWriteControlRowVersion: 6,
    providerWriteCredentialGeneration: 9,
    providerWriteScopeDigest: 'b'.repeat(64),
  }
}
let runtimeExecutions = 0
let runtimeExecutionInput = null
let runtimeTrustedEvidenceChecks = 0
let runtimeProviderWriteChecks = 0
let runtimeSealedProviderWriteChecks = 0
let runtimeCredentialReads = 0
let runtimeDecryptions = 0
let runtimeReadClientOptions = null
let runtimeReadMutations = 0
const runtimeDependencies = {
  readRuntimeCredential: async () => {
    runtimeCredentialReads += 1
    return runtimeCredential
  },
  requireProviderWrites: async (input) => {
    runtimeProviderWriteChecks += 1
    assert.equal(input.accountGlobalId, runtimeAccountGlobalId)
    assert.equal(input.provider, 'faire')
    assert.deepEqual(Array.from(input.requiredScopes), [
      'READ_BRAND',
      'READ_ORDERS',
      'READ_SHIPMENTS',
      'WRITE_ORDERS',
    ])
    return runtimeProviderWriteAuthority
  },
  requireSealedProviderWrites: async (input) => {
    runtimeSealedProviderWriteChecks += 1
    assert.equal(input.accountGlobalId, runtimeAccountGlobalId)
    assert.equal(input.provider, 'faire')
    assert.equal(input.environment, 'production')
    assert.match(input.providerAttemptGlobalId, /^gxa[0-9a-z]{7}$/u)
    assert.equal(
      input.providerAttemptRequestHash,
      runtimeProviderAttemptRequestHash,
    )
    assert.equal(
      input.providerAttemptLeaseToken,
      runtimeProviderAttemptLeaseToken,
    )
    assert.equal(input.commerceExportGlobalId, runtimeCommerceExportGlobalId)
    assert.equal(input.expectedControlRowVersion, 6)
    assert.equal(input.expectedCredentialGeneration, 9)
    assert.equal(input.expectedGrantedScopeDigest, 'b'.repeat(64))
    assert.deepEqual(Array.from(input.requiredScopes), [
      'READ_BRAND',
      'READ_ORDERS',
      'READ_SHIPMENTS',
      'WRITE_ORDERS',
    ])
    return runtimeProviderWriteAuthority
  },
  requireTrustedScopeEvidence: async () => {
    runtimeTrustedEvidenceChecks += 1
  },
  decryptCredential: () => {
    runtimeDecryptions += 1
    return {
      provider: 'faire',
      authMode: 'faire_oauth',
      applicationId: 'app-id-for-runtime-acceptance',
      applicationSecret: 'application-secret-for-runtime-acceptance',
      accessToken: 'oauth-access-token-for-runtime-acceptance',
      scopes: ['READ_BRAND', 'READ_ORDERS', 'READ_SHIPMENTS', 'WRITE_ORDERS'],
    }
  },
  executeWriteback: async (input, _dependencies, beforeProviderMutation) => {
    await beforeProviderMutation?.()
    runtimeExecutions += 1
    runtimeExecutionInput = input
    return {
      outcome: 'succeeded',
      writeAttempt: { ...input.writeAttempt, state: 'succeeded' },
      providerOrderId: input.externalOrderId,
      providerState: 'PRE_TRANSIT',
      providerShipmentReferences: ['s_runtime1'],
      trackingCodes: input.packages.map((item) => item.trackingCode),
      replayed: false,
      reconciledUnknownOutcome: false,
    }
  },
  reconcileReadOnly: (input) => (
    writeback.reconcileFaireFulfillmentWritebackReadOnly(input, {
      createClient: (options) => {
        runtimeReadClientOptions = options
        return {
          probeBrandProfile: async () => ({
            brand_id: runtimeExternalAccountId,
          }),
          getOrder: async () => ({
            id: input.externalOrderId,
            state: 'PRE_TRANSIT',
            shipments: [{
              id: 's_runtime_rotated1',
              carrier: input.packages[0].carrier,
              tracking_code: input.packages[0].trackingCode,
            }],
          }),
          moveOrderToProcessing: async () => {
            runtimeReadMutations += 1
          },
          addOrderShipments: async () => {
            runtimeReadMutations += 1
          },
        }
      },
    })
  ),
}
assert.deepEqual(
  JSON.parse(JSON.stringify(
    await runtime.prepareCurrentFaireFulfillmentAuthority({
      organizationId: runtimeOrganizationId,
      accountGlobalId: runtimeAccountGlobalId,
    }, runtimeDependencies),
  )),
  {
    authorizationRevision: 6,
    credentialGeneration: 9,
    externalAccountId: runtimeExternalAccountId,
  },
)
assert.equal(runtimeTrustedEvidenceChecks, 1)
assert.equal(runtimeProviderWriteChecks, 1)
await runtime.executeCurrentFaireFulfillmentWriteback({
  organizationId: runtimeOrganizationId,
  accountGlobalId: runtimeAccountGlobalId,
  ...runtimeProviderAttemptEvidence('gxa1234567'),
  mode: 'execute',
  writeAttempt: {
    attemptId: 'gxa1234567',
    authorizationRevision: 6,
    state: 'authorized',
  },
  externalOrderId: 'bo_runtime123',
  expectedShipDate: '2026-08-02T12:00:00.000Z',
  packages: [{
    packageReference: 'gpa1234567',
    carrier: 'UPS',
    trackingCode: '1ZRUNTIME',
  }],
}, runtimeDependencies)
assert.equal(runtimeExecutions, 1)
assert.equal(runtimeTrustedEvidenceChecks, 2)
assert.equal(runtimeProviderWriteChecks, 1)
assert.equal(runtimeSealedProviderWriteChecks, 2)
assert.deepEqual(
  JSON.parse(JSON.stringify(runtimeExecutionInput.authorization)),
  {
    provider: 'faire',
    environment: 'production',
    accountGlobalId: runtimeAccountGlobalId,
    externalAccountId: runtimeExternalAccountId,
    credentialVersion: 9,
    authorizationRevision: 6,
    capabilities: [
      'order_processing',
      'fulfillment_export',
      'tracking_export',
    ],
    verifiedWriteScopes: ['WRITE_ORDERS'],
    scopeVerificationSource: 'oauth_grant',
  },
)
assert.equal(runtimeExecutionInput.credential.binding.verificationStatus, 'verified')

const rotatedReconciliation = await runtime
  .executeCurrentFaireFulfillmentWriteback({
    organizationId: runtimeOrganizationId,
    accountGlobalId: runtimeAccountGlobalId,
    mode: 'reconcile_unknown',
    writeAttempt: {
      attemptId: 'gxa1234569',
      authorizationRevision: 6,
      state: 'outcome_unknown',
    },
    externalOrderId: 'bo_runtime_rotated',
    packages: [{
      packageReference: 'gpa1234569',
      carrier: 'UPS',
      trackingCode: '1ZROTATED',
    }],
  }, {
    ...runtimeDependencies,
    readRuntimeCredential: async () => ({
      ...runtimeCredential,
      credentialVersion: 10,
    }),
    decryptCredential: () => ({
      provider: 'faire',
      authMode: 'faire_oauth',
      applicationId: 'rotated-app-id',
      applicationSecret: 'rotated-application-secret',
      accessToken: 'rotated-oauth-access-token',
      scopes: ['READ_BRAND', 'READ_ORDERS', 'READ_SHIPMENTS'],
    }),
    requireProviderWrites: async () => {
      throw new Error('read-only recovery must not require Provider writes')
    },
    requireTrustedScopeEvidence: async () => {
      throw new Error('read-only recovery must not require write-scope evidence')
    },
  })
assert.equal(rotatedReconciliation.outcome, 'succeeded')
assert.equal(rotatedReconciliation.reconciledUnknownOutcome, true)
assert.equal(runtimeReadClientOptions.credentialBinding.credentialVersion, 10)
assert.equal(
  Object.prototype.hasOwnProperty.call(
    runtimeReadClientOptions,
    'writeAuthorization',
  ),
  false,
  'rotated recovery must construct a client with no POST authority',
)
assert.equal(runtimeReadMutations, 0, 'rotated recovery must issue GETs only')
assert.equal(runtimeExecutions, 1)
assert.equal(runtimeTrustedEvidenceChecks, 2)
assert.equal(runtimeProviderWriteChecks, 1)

let offRuntimeCredentialReads = 0
let offRuntimeDecryptions = 0
let offRuntimeExecutions = 0
await assert.rejects(
  () => runtime.prepareCurrentFaireFulfillmentAuthority({
    organizationId: runtimeOrganizationId,
    accountGlobalId: runtimeAccountGlobalId,
  }, {
    ...runtimeDependencies,
    requireProviderWrites: async () => {
      const error = new Error('Provider writes is Off')
      error.code = 'COMMERCE_PROVIDER_WRITES_OFF'
      throw error
    },
    readRuntimeCredential: async () => {
      offRuntimeCredentialReads += 1
      return runtimeCredential
    },
    decryptCredential: () => {
      offRuntimeDecryptions += 1
      throw new Error('Off must reject before credential decryption')
    },
    executeWriteback: async () => {
      offRuntimeExecutions += 1
      throw new Error('Off must reject before the provider executor')
    },
  }),
  (error) => error?.code === 'COMMERCE_PROVIDER_WRITES_OFF',
  'Provider writes Off must reject before credential access or provider intent',
)
assert.equal(offRuntimeCredentialReads, 0)
assert.equal(offRuntimeDecryptions, 0)
assert.equal(offRuntimeExecutions, 0)

await assert.rejects(
  () => runtime.prepareCurrentFaireFulfillmentAuthority({
    organizationId: runtimeOrganizationId,
    accountGlobalId: runtimeAccountGlobalId,
  }, {
    ...runtimeDependencies,
    requireTrustedScopeEvidence: async () => {
      const error = new Error('provider-verifiable evidence is unavailable')
      error.code = 'COMMERCE_ACTIVE_FAIRE_SCOPE_EVIDENCE_REQUIRED'
      throw error
    },
  }),
  (error) => (
    error?.code === 'COMMERCE_ACTIVE_FAIRE_SCOPE_EVIDENCE_REQUIRED'
  ),
  'requested OAuth scopes must not substitute for trusted grant evidence',
)
assert.equal(runtimeExecutions, 1)

await assert.rejects(
  () => runtime.executeCurrentFaireFulfillmentWriteback({
    organizationId: runtimeOrganizationId,
    accountGlobalId: runtimeAccountGlobalId,
    ...runtimeProviderAttemptEvidence('gxa1234568'),
    mode: 'execute',
    writeAttempt: {
      attemptId: 'gxa1234568',
      authorizationRevision: 6,
      state: 'authorized',
    },
    externalOrderId: 'bo_runtime124',
    packages: [{
      packageReference: 'gpa1234568',
      carrier: 'FEDEX',
      trackingCode: 'RUNTIME2',
    }],
  }, {
    ...runtimeDependencies,
    readRuntimeCredential: async () => ({
      ...runtimeCredential,
      authMode: 'faire_brand_token',
    }),
  }),
  (error) => error?.code === 'FAIRE_FULFILLMENT_CONNECTION_INVALID',
  'Direct Faire brand tokens must not authorize fulfillment writes',
)
assert.equal(runtimeExecutions, 1)

await assert.rejects(
  () => runtime.prepareCurrentFaireFulfillmentAuthority({
    organizationId: runtimeOrganizationId,
    accountGlobalId: runtimeAccountGlobalId,
  }, {
    ...runtimeDependencies,
    decryptCredential: () => ({
      provider: 'faire',
      authMode: 'faire_oauth',
      applicationId: 'app-id-for-runtime-acceptance',
      applicationSecret: 'application-secret-for-runtime-acceptance',
      accessToken: 'oauth-access-token-for-runtime-acceptance',
      scopes: ['READ_BRAND', 'READ_ORDERS', 'WRITE_ORDERS'],
    }),
  }),
  (error) => error?.code === 'FAIRE_FULFILLMENT_OAUTH_SCOPE_REQUIRED',
)
assert.equal(runtimeExecutions, 1)

const readsBeforeRegisteredFaire = runtimeCredentialReads
const decryptionsBeforeRegisteredFaire = runtimeDecryptions
await assert.rejects(
  () => runtime.executeCurrentFaireFulfillmentWriteback({
    organizationId: runtimeOrganizationId,
    accountGlobalId: runtimeAccountGlobalId,
    ...runtimeProviderAttemptEvidence('gxa1234571'),
    providerWriteAccountGlobalId: 'gia7654321',
    mode: 'execute',
    writeAttempt: {
      attemptId: 'gxa1234571',
      authorizationRevision: 6,
      state: 'authorized',
    },
    externalOrderId: 'bo_runtime_registered_mismatch',
    packages: [{
      packageReference: 'gpa1234571',
      carrier: 'UPS',
      trackingCode: '1ZMISMATCH',
    }],
  }, runtimeDependencies),
  (error) => error?.code === 'FAIRE_FULFILLMENT_PROVIDER_AUTHORITY_MISMATCH',
)
assert.equal(runtimeSealedProviderWriteChecks, 3)
assert.equal(runtimeCredentialReads, readsBeforeRegisteredFaire)
assert.equal(runtimeDecryptions, decryptionsBeforeRegisteredFaire)

// A later Off blocks new attempt registration, but an exact attempt already
// registered while On may finish through its immutable sealed authority.
await runtime.executeCurrentFaireFulfillmentWriteback({
  organizationId: runtimeOrganizationId,
  accountGlobalId: runtimeAccountGlobalId,
  ...runtimeProviderAttemptEvidence('gxa1234572'),
  mode: 'execute',
  writeAttempt: {
    attemptId: 'gxa1234572',
    authorizationRevision: 6,
    state: 'authorized',
  },
  externalOrderId: 'bo_runtime_registered',
  packages: [{
    packageReference: 'gpa1234572',
    carrier: 'UPS',
    trackingCode: '1ZREGISTERED',
  }],
}, {
  ...runtimeDependencies,
  requireProviderWrites: async () => {
    throw new Error('Registered execution must not re-require current On')
  },
})
assert.equal(runtimeSealedProviderWriteChecks, 5)
assert.equal(runtimeExecutions, 2)

console.log('Faire provider-write foundation tests passed')
