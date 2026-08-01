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

await client.updateInventory({
  by: 'skus',
  inventories: [{
    sku: 'TEST-SKU-1',
    productVariantId: 'po_variant123',
    onHandQuantity: -3,
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
  }],
})
assert.equal(
  requests[requests.indexOf(skuInventoryPatch) + 1].url,
  'https://www.faire.com/external-api/v2/product-inventory/by-skus?skus=TEST-SKU-1',
  'inventory must be read back by the exact requested SKU',
)

await client.updateInventory({
  by: 'product_variant_ids',
  inventories: [{
    productVariantId: 'po_variant123',
    sku: 'TEST-SKU-1',
    onHandQuantity: 0,
  }],
})
const variantInventoryPatch = requests.find((request) => (
  request.method === 'PATCH'
  && request.url.endsWith('/product-inventory/by-product-variant-ids')
))
assert.ok(variantInventoryPatch)
assert.equal(
  requests[requests.indexOf(variantInventoryPatch) + 1].url,
  'https://www.faire.com/external-api/v2/product-inventory/by-product-variant-ids?ids=po_variant123',
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
const normalResult = await writeback.executeFaireFulfillmentWriteback(
  writebackInput,
  { createClient: () => normal.client },
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
assert.equal(normal.calls.shipments.length, 2)
assert.ok(normal.calls.shipments.every(
  (shipment) => shipment.shippingType === 'SHIP_ON_YOUR_OWN',
))

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

console.log('Faire provider-write foundation tests passed')
