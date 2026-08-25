#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
let claimChecks = 0
let expectedProviderPayloadHash = null
let claimError = null
let lastProviderPayloadHash = null

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
        SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN:
          'test-pro-bakery-bites.myshopify.com',
        SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID:
          'gid://shopify/ProductVariant/51028106379511',
      }
    }
    if (specifier === '@/lib/persistence/shopifyReversalFixture') {
      return {
        assertShopifyReversalFixtureOrderClaimCurrentInPostgres:
          async (claim) => {
          assert.deepEqual({
            organizationId: claim.organizationId,
            commandId: claim.commandId,
            attemptId: claim.attemptId,
            actorEmail: claim.actorEmail,
          }, exactClaim)
          assert.match(claim.providerPayloadHash, /^[a-f0-9]{64}$/u)
          lastProviderPayloadHash = claim.providerPayloadHash
          claimChecks += 1
          if (claimError) throw claimError
          if (
            expectedProviderPayloadHash
            && claim.providerPayloadHash !== expectedProviderPayloadHash
          ) {
            throw Object.assign(new Error('stale provider payload'), {
              code: 'SHOPIFY_REVERSAL_FIXTURE_CLAIM_STALE',
            })
          }
        },
      }
    }
    return requireFromApp(specifier)
  },
}, { filename: path })

const adapter = module.exports
const credential = {
  shopDomain: 'test-pro-bakery-bites.myshopify.com',
  accessToken: 'redacted-test-token',
}
const exactClaim = {
  organizationId: 'c6c8e6e7-fffa-4969-9526-e99da0ab2754',
  commandId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  actorEmail: 'owner@example.test',
}
const sourceIdentifier = 'clawpilot-reversal-fixture:gsfc1234567'
const uniqueTag = 'clawpilot-reversal-0123456789abcdef01234567'
expectedProviderPayloadHash =
  adapter.shopifyReversalFixtureOrderProviderPayloadHash({
    shopDomain: credential.shopDomain,
    sourceIdentifier,
    uniqueTag,
  })
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
    version: 'shopify-reversal-fixture-v2',
    test: true,
    financialStatus: 'PENDING',
    marketingConsent: 'UNSET',
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
const created = await adapter.createShopifyReversalFixtureOrder(
  credential,
  {
    sourceIdentifier,
    uniqueTag,
    claim: exactClaim,
  },
)
assert.equal(claimChecks, 1)
assert.equal(created.id, exactOrder.id)
assert.equal(calls.length, 1)
assert.equal(calls[0].operationName, 'ClawPilotReversalFixtureOrderCreate')
assert.deepEqual(calls[0].variables, {
  order: {
    test: true,
    financialStatus: 'PENDING',
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
const exactEmittedPayloadHash = createHash('sha256').update(JSON.stringify({
  version: 'shopify-reversal-fixture-order-provider-payload-v2',
  shopDomain: credential.shopDomain,
  variables: calls[0].variables,
})).digest('hex')
assert.equal(
  lastProviderPayloadHash,
  exactEmittedPayloadHash,
  'the final fence hash must cover the exact emitted GraphQL variables',
)
const changedBaseTagVariables = structuredClone(calls[0].variables)
changedBaseTagVariables.order.tags[0] = 'changed-fixture-base-tag'
assert.notEqual(
  createHash('sha256').update(JSON.stringify({
    version: 'shopify-reversal-fixture-order-provider-payload-v2',
    shopDomain: credential.shopDomain,
    variables: changedBaseTagVariables,
  })).digest('hex'),
  lastProviderPayloadHash,
  'changing the fixed base tag must change the fenced provider payload',
)
const serializedWrite = JSON.stringify(calls[0].variables)
for (const forbidden of [
  'email', 'phone', 'customer', 'buyerAcceptsMarketing', 'billingAddress', 'transactions',
  'discount', 'tax', 'shippingLine', 'payment', 'notifyCustomer',
]) {
  assert.equal(
    serializedWrite.includes(`\"${forbidden}\"`),
    false,
    `orderCreate must omit ${forbidden}`,
  )
}

providerResponse = {
  orderCreate: {
    order: null,
    userErrors: [{
      code: 'INVALID',
      field: ['order', 'lineItems', '0', 'variantId'],
      message: 'Rejected exactly and must never be retained',
    }],
  },
}
await assert.rejects(
  () => adapter.createShopifyReversalFixtureOrder(credential, {
    sourceIdentifier,
    uniqueTag,
    claim: exactClaim,
  }),
  (error) => error.code === 'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED'
    && error.message
      === 'Shopify rejected order creation (INVALID at order.lineItems.0.variantId)'
    && error.providerErrorSummary === error.message
    && !error.message.includes('must never be retained')
    && error.providerMutationAttempted === true
    && error.outcomeUnknown === false,
)

for (const invalidProviderError of [
  {
    code: 'UNRECOGNIZED_PROVIDER_CODE',
    field: ['order'],
    message: 'Unknown provider code',
  },
  {
    code: 'INVALID',
    field: ['order', 'lineItems', 'invalid.field'],
    message: 'Malformed field path',
  },
]) {
  providerResponse = {
    orderCreate: { order: null, userErrors: [invalidProviderError] },
  }
  await assert.rejects(
    () => adapter.createShopifyReversalFixtureOrder(credential, {
      sourceIdentifier,
      uniqueTag,
      claim: exactClaim,
    }),
    (error) => (
      error.code === 'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN'
      && error.providerMutationAttempted === true
      && error.outcomeUnknown === true
      && error.providerErrorSummary === null
    ),
    'unrecognized provider error evidence must fail closed without retention',
  )
}

providerError = new Error('network timeout')
await assert.rejects(
  () => adapter.createShopifyReversalFixtureOrder(credential, {
    sourceIdentifier,
    uniqueTag,
    claim: exactClaim,
  }),
  (error) => error.code === 'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN'
    && error.providerMutationAttempted === true
    && error.outcomeUnknown === true,
)
providerError = null

for (const malformedUserErrors of [undefined, null, { message: 'invalid' }]) {
  providerResponse = {
    orderCreate: {
      order: exactOrder,
      ...(malformedUserErrors === undefined
        ? {}
        : { userErrors: malformedUserErrors }),
    },
  }
  await assert.rejects(
    () => adapter.createShopifyReversalFixtureOrder(credential, {
      sourceIdentifier,
      uniqueTag,
      claim: exactClaim,
    }),
    (error) => (
      error.code === 'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN'
      && error.providerMutationAttempted === true
      && error.outcomeUnknown === true
    ),
    'malformed post-dispatch userErrors must remain unknown',
  )
}

const claimChecksBeforeWrongStore = claimChecks
const providerCallsBeforeWrongStore = calls.length
await assert.rejects(
  () => adapter.createShopifyReversalFixtureOrder({
    ...credential,
    shopDomain: 'other-store.myshopify.com',
  }, {
    sourceIdentifier,
    uniqueTag,
    claim: exactClaim,
  }),
  (error) => error.code === 'SHOPIFY_REVERSAL_FIXTURE_STORE_CHANGED'
    && error.providerMutationAttempted === false,
)
assert.equal(claimChecks, claimChecksBeforeWrongStore)
assert.equal(calls.length, providerCallsBeforeWrongStore)

const providerCallsBeforeStaleClaim = calls.length
claimError = Object.assign(new Error('final claim fence rejected'), {
  code: 'SHOPIFY_REVERSAL_FIXTURE_CLAIM_STALE',
})
await assert.rejects(
  () => adapter.createShopifyReversalFixtureOrder(credential, {
    sourceIdentifier,
    uniqueTag,
    claim: exactClaim,
  }),
  (error) => error.code === 'SHOPIFY_REVERSAL_FIXTURE_CLAIM_STALE',
)
claimError = null
assert.equal(
  calls.length,
  providerCallsBeforeStaleClaim,
  'a final claim fence failure must issue zero provider mutations',
)

const substitutedTag = 'clawpilot-reversal-aaaaaaaaaaaaaaaaaaaaaaaa'
await assert.rejects(
  () => adapter.createShopifyReversalFixtureOrder(credential, {
    sourceIdentifier,
    uniqueTag: substitutedTag,
    claim: exactClaim,
  }),
  (error) => error.code === 'SHOPIFY_REVERSAL_FIXTURE_CLAIM_STALE',
)
assert.equal(
  calls.length,
  providerCallsBeforeStaleClaim,
  'a substituted provider payload must fail before the GraphQL mutation',
)

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
