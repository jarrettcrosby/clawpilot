#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const path = 'app_src/lib/integrations/shopifyReversalFixtureProvider.ts'
const source = readFileSync(resolve(path), 'utf8')
const calls = []
let providerResponse = null
let providerError = null

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
  Date,
  Error,
  JSON,
  Object,
  RegExp,
  Set,
  String,
  console,
  exports: module.exports,
  module,
  require(specifier) {
    if (specifier === 'node:crypto') return requireFromApp(specifier)
    if (specifier === '@/lib/integrations/shopifyCommerceClient') {
      return {
        shopifyAdminGraphql: async (_credential, request) => {
          calls.push(structuredClone(request))
          if (providerError) throw providerError
          return structuredClone(providerResponse)
        },
      }
    }
    if (specifier === '@/lib/integrations/shopifyReversalFixtureRuntime') {
      return {
        SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID:
          'gid://shopify/ProductVariant/51028106379511',
      }
    }
    return requireFromApp(specifier)
  },
}, { filename: path })

const adapter = module.exports
const credential = {
  shopDomain: 'fixed-development-store.myshopify.com',
  accessToken: 'redacted-test-token',
}
const sourceIdentifier = 'clawpilot-reversal-fixture:gsfc1234567'
const uniqueTag = 'clawpilot-reversal-0123456789abcdef01234567'
const exactOrder = {
  id: 'gid://shopify/Order/123456789',
  name: '#1001',
  test: true,
  sourceIdentifier,
  createdAt: '2026-08-25T12:00:00.000Z',
  updatedAt: '2026-08-25T12:00:01.000Z',
  displayFinancialStatus: 'PENDING',
  displayFulfillmentStatus: 'UNFULFILLED',
  tags: ['clawpilot-reversal-fixture', uniqueTag],
  lineItems: {
    nodes: [{
      id: 'gid://shopify/LineItem/987654321',
      currentQuantity: 1,
      unfulfilledQuantity: 1,
      requiresShipping: true,
      variant: {
        id: 'gid://shopify/ProductVariant/51028106379511',
      },
    }],
    pageInfo: { hasNextPage: false },
  },
}

assert.deepEqual(
  JSON.parse(JSON.stringify(adapter.SHOPIFY_REVERSAL_FIXTURE_ORDER_PROFILE)),
  {
    version: 'shopify-reversal-fixture-v1',
    test: true,
    financialStatus: 'PENDING',
    buyerAcceptsMarketing: false,
    sendReceipt: false,
    sendFulfillmentReceipt: false,
    inventoryBehaviour: 'BYPASS',
    variantId: 'gid://shopify/ProductVariant/51028106379511',
    quantity: 1,
    requiresShipping: true,
    shippingAddress: {
      firstName: 'John',
      lastName: 'Doe',
      address1: '101 Academy Drive',
      city: 'Buzzards Bay',
      provinceCode: 'MA',
      countryCode: 'US',
      zip: '02532',
    },
  },
)

providerResponse = {
  orderCreate: { order: exactOrder, userErrors: [] },
}
let beforeMutationCalls = 0
const created = await adapter.createShopifyReversalFixtureOrder(
  credential,
  {
    sourceIdentifier,
    uniqueTag,
    beforeProviderMutation: async () => { beforeMutationCalls += 1 },
  },
)
assert.equal(beforeMutationCalls, 1)
assert.equal(created.id, exactOrder.id)
assert.equal(calls.length, 1)
assert.equal(calls[0].operationName, 'ClawPilotReversalFixtureOrderCreate')
assert.deepEqual(calls[0].variables, {
  order: {
    test: true,
    financialStatus: 'PENDING',
    buyerAcceptsMarketing: false,
    sourceIdentifier,
    tags: ['clawpilot-reversal-fixture', uniqueTag],
    lineItems: [{
      variantId: 'gid://shopify/ProductVariant/51028106379511',
      quantity: 1,
      requiresShipping: true,
    }],
    shippingAddress: {
      firstName: 'John',
      lastName: 'Doe',
      address1: '101 Academy Drive',
      city: 'Buzzards Bay',
      provinceCode: 'MA',
      countryCode: 'US',
      zip: '02532',
    },
  },
  options: {
    inventoryBehaviour: 'BYPASS',
    sendReceipt: false,
    sendFulfillmentReceipt: false,
  },
})
const serializedWrite = JSON.stringify(calls[0].variables)
for (const forbidden of [
  'email', 'phone', 'customer', 'billingAddress', 'transactions',
  'discount', 'tax', 'shippingLine', 'payment', 'notifyCustomer',
]) {
  assert.equal(
    serializedWrite.includes(`\"${forbidden}\"`),
    false,
    `orderCreate must omit ${forbidden}`,
  )
}

providerResponse = {
  orderCreate: { order: null, userErrors: [{ message: 'Rejected exactly' }] },
}
await assert.rejects(
  () => adapter.createShopifyReversalFixtureOrder(credential, {
    sourceIdentifier,
    uniqueTag,
  }),
  (error) => error.code === 'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED'
    && error.providerMutationAttempted === true
    && error.outcomeUnknown === false,
)

providerError = new Error('network timeout')
await assert.rejects(
  () => adapter.createShopifyReversalFixtureOrder(credential, {
    sourceIdentifier,
    uniqueTag,
  }),
  (error) => error.code === 'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN'
    && error.providerMutationAttempted === true
    && error.outcomeUnknown === true,
)
providerError = null

providerResponse = {
  orders: { nodes: [exactOrder], pageInfo: { hasNextPage: false } },
}
const reconciled = await adapter.reconcileShopifyReversalFixtureOrder(
  credential,
  { sourceIdentifier, uniqueTag },
)
assert.equal(reconciled.resolution, 'applied')
assert.equal(reconciled.order.id, exactOrder.id)
assert.match(reconciled.evidenceHash, /^[a-f0-9]{64}$/u)
assert.deepEqual(calls.at(-1).variables, { query: `tag:${uniqueTag}` })

providerResponse = {
  orders: { nodes: [], pageInfo: { hasNextPage: false } },
}
assert.equal(
  (await adapter.reconcileShopifyReversalFixtureOrder(
    credential,
    { sourceIdentifier, uniqueTag },
  )).resolution,
  'absent',
)

providerResponse = {
  orders: {
    nodes: [exactOrder, { ...exactOrder, id: 'gid://shopify/Order/123456790' }],
    pageInfo: { hasNextPage: false },
  },
}
assert.equal(
  (await adapter.reconcileShopifyReversalFixtureOrder(
    credential,
    { sourceIdentifier, uniqueTag },
  )).resolution,
  'ambiguous',
)

console.log('Shopify reversal fixture fixed provider adapter passed.')
