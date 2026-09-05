#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

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
          'gid://shopify/ProductVariant/51028106608887',
      }
    }
    if (specifier === '@/lib/integrations/integrationCredentialRuntimeGate.mjs') {
      return integrationCredentialRuntimeGate
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
const providerTag = 'clawpilot-rv-0123456789abcdef01234567'
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
  currencyCode: 'USD',
  presentmentCurrencyCode: 'USD',
  totalPriceSet: {
    shopMoney: { amount: '10.0', currencyCode: 'USD' },
    presentmentMoney: { amount: '10.00', currencyCode: 'USD' },
  },
  capturable: true,
  totalCapturableSet: {
    shopMoney: { amount: '10.00', currencyCode: 'USD' },
    presentmentMoney: { amount: '10', currencyCode: 'USD' },
  },
  displayFinancialStatus: 'PENDING',
  displayFulfillmentStatus: 'UNFULFILLED',
  tags: ['clawpilot-reversal-fixture', providerTag],
  lineItems: {
    nodes: [{
      id: 'gid://shopify/LineItem/987654321',
      quantity: 1,
      currentQuantity: 1,
      unfulfilledQuantity: 1,
      taxable: false,
      requiresShipping: true,
      variant: {
        id: 'gid://shopify/ProductVariant/51028106608887',
      },
      originalUnitPriceSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
        presentmentMoney: { amount: '10.0', currencyCode: 'USD' },
      },
    }],
    pageInfo: { hasNextPage: false },
  },
  transactions: [{
    id: 'gid://shopify/OrderTransaction/246813579',
    kind: 'AUTHORIZATION',
    status: 'SUCCESS',
    test: true,
    amountSet: {
      shopMoney: { amount: '10.00', currencyCode: 'USD' },
      presentmentMoney: { amount: '10', currencyCode: 'USD' },
    },
  }],
}

assert.deepEqual(
  JSON.parse(JSON.stringify(adapter.SHOPIFY_REVERSAL_FIXTURE_ORDER_PROFILE)),
  {
    version: 'shopify-reversal-fixture-v5',
    test: true,
    expectedFinancialStatus: 'PENDING',
    currencyCode: 'USD',
    unitPrice: '10.00',
    taxable: false,
    transaction: {
      kind: 'AUTHORIZATION',
      status: 'SUCCESS',
      test: true,
      amount: '10.00',
      currencyCode: 'USD',
    },
    marketingConsent: 'UNSET',
    sendReceipt: false,
    sendFulfillmentReceipt: false,
    inventoryBehaviour: 'BYPASS',
    variantId: 'gid://shopify/ProductVariant/51028106608887',
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

assert.equal(
  adapter.sanitizeShopifyReversalFixtureProviderErrorMessage(
    `Ｆａｉｌ\n${'A'.repeat(32)} customer@example.test `
      + 'gid://shopify/ProductVariant/51028106608887',
  ),
  'Fail [redacted-token] [redacted-email] [redacted-gid]',
)
const boundedProviderMessage =
  adapter.sanitizeShopifyReversalFixtureProviderErrorMessage(
    'safe provider detail '.repeat(40),
  )
assert.equal(boundedProviderMessage.length, 240)
assert.equal(boundedProviderMessage, boundedProviderMessage.trim())
assert.match(boundedProviderMessage, /^[ -~]+$/u)
const sensitiveNumberMessage =
  adapter.sanitizeShopifyReversalFixtureProviderErrorMessage(
    'Call +1 (555) 123-4567 card 4111 1111 1111 1111 '
      + 'account ID 1234-5678-9012 reference 123456789012 line 0',
  )
assert.equal(
  sensitiveNumberMessage,
  'Call [redacted-phone] [redacted-account] [redacted-account] '
    + 'reference [redacted-number] line 0',
)
for (const sensitiveDigits of [
  '555', '4567', '4111', '1234', '9012', '123456789012',
]) {
  assert.equal(sensitiveNumberMessage.includes(sensitiveDigits), false)
}

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
    currency: 'USD',
    sourceIdentifier,
    tags: ['clawpilot-reversal-fixture', providerTag],
    lineItems: [{
      variantId: 'gid://shopify/ProductVariant/51028106608887',
      quantity: 1,
      requiresShipping: true,
      taxable: false,
      priceSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
    }],
    transactions: [{
      kind: 'AUTHORIZATION',
      status: 'SUCCESS',
      test: true,
      amountSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
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
assert.equal(providerTag.length <= 40, true)
assert.deepEqual(
  calls[0].variables.order.tags,
  ['clawpilot-reversal-fixture', providerTag],
  'orderCreate must retain both fixed fingerprints as valid Shopify tags',
)
assert.equal(
  calls[0].variables.order.tags.every((tag) => tag.length <= 40),
  true,
  'Shopify order tags must not exceed the provider 40-character limit',
)
const exactEmittedPayloadHash = createHash('sha256').update(JSON.stringify({
  version: 'shopify-reversal-fixture-order-provider-payload-v5',
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
    version: 'shopify-reversal-fixture-order-provider-payload-v5',
    shopDomain: credential.shopDomain,
    variables: changedBaseTagVariables,
  })).digest('hex'),
  lastProviderPayloadHash,
  'changing the fixed base tag must change the fenced provider payload',
)
const serializedWrite = JSON.stringify(calls[0].variables)
for (const forbidden of [
  'email', 'phone', 'customer', 'buyerAcceptsMarketing', 'billingAddress',
  'presentmentCurrency', 'presentmentMoney',
  'discount', 'taxLines', 'shippingLine', 'payment', 'notifyCustomer',
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
      message: 'Rejected owner@example.test at https://shopify.test/fail '
        + 'gid://shopify/Order/123456789 '
        + '11111111-1111-4111-8111-111111111111 '
        + 'token_A1B2C3D4E5F6G7H8 123456789',
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
    && error.providerErrorMessage
      === 'Rejected [redacted-email] at [redacted-url] [redacted-gid] '
        + '[redacted-uuid] [redacted-token] [redacted-number]'
    && !error.providerErrorMessage.includes('owner@example.test')
    && error.providerMutationAttempted === true
    && error.outcomeUnknown === false,
)

providerResponse = {
  orderCreate: {
    order: null,
    userErrors: [{
      code: 'INVALID',
      field: ['order'],
      message: 'Order Order tags is invalid',
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
    && error.providerErrorSummary
      === 'Shopify rejected order creation (INVALID at order)'
    && error.providerErrorMessage === 'Order Order tags is invalid',
  'the exact provider tag rejection must remain sanitized terminal evidence',
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
      && error.providerErrorMessage === null
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

providerResponse = {
  orderCreate: {
    order: null,
    userErrors: [{
      code: 'INVALID',
      field: ['order'],
      message: 'First duplicate',
    }, {
      code: 'INVALID',
      field: ['order'],
      message: 'First duplicate',
    }, {
      code: 'INVALID',
      field: ['order', 'transactions'],
      message: 'Second detail',
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
    && error.providerErrorMessage === 'First duplicate; Second detail',
  'provider error message evidence must be de-duplicated deterministically',
)

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

providerResponse = {
  orderCreate: {
    order: { ...exactOrder, transactions: [] },
    userErrors: [],
  },
}
await assert.rejects(
  () => adapter.createShopifyReversalFixtureOrder(credential, {
    sourceIdentifier,
    uniqueTag,
    claim: exactClaim,
  }),
  (error) => error.code === 'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN'
    && error.providerMutationAttempted === true
    && error.outcomeUnknown === true,
  'a returned order without the exact authorization must remain unknown',
)

const lifecycleAdvancedOrder = {
  ...exactOrder,
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  capturable: false,
  tags: [...exactOrder.tags, 'operator-added-tag'],
  totalCapturableSet: {
    shopMoney: { amount: '0.00', currencyCode: 'USD' },
    presentmentMoney: { amount: '0', currencyCode: 'USD' },
  },
  lineItems: {
    nodes: [{
      ...exactOrder.lineItems.nodes[0],
      currentQuantity: 0,
      unfulfilledQuantity: 0,
    }, {
      id: 'gid://shopify/LineItem/987654322',
      quantity: 2,
      currentQuantity: 2,
      unfulfilledQuantity: 0,
      taxable: true,
      requiresShipping: false,
      variant: null,
      originalUnitPriceSet: {
        shopMoney: { amount: '2.00', currencyCode: 'USD' },
        presentmentMoney: { amount: '2.00', currencyCode: 'USD' },
      },
    }],
    pageInfo: { hasNextPage: false },
  },
  transactions: [...exactOrder.transactions, {
    id: 'gid://shopify/OrderTransaction/246813580',
    kind: 'CAPTURE',
    status: 'SUCCESS',
    test: true,
    amountSet: {
      shopMoney: { amount: '10.00', currencyCode: 'USD' },
      presentmentMoney: { amount: '10.00', currencyCode: 'USD' },
    },
  }],
}
providerResponse = {
  orderCreate: { order: lifecycleAdvancedOrder, userErrors: [] },
}
await assert.rejects(
  () => adapter.createShopifyReversalFixtureOrder(credential, {
    sourceIdentifier,
    uniqueTag,
    claim: exactClaim,
  }),
  (error) => error.code === 'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN',
  'the immediate mutation response must still prove PENDING and capturable',
)

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
const exactReconciliationSearch =
  `source_identifier:${JSON.stringify(sourceIdentifier)} `
  + `AND tag:${providerTag} AND test:true`
assert.deepEqual(calls.at(-1).variables, {
  query: exactReconciliationSearch,
})

providerResponse = {
  orders: {
    nodes: [lifecycleAdvancedOrder],
    pageInfo: { hasNextPage: false },
  },
}
const lifecycleReconciliation =
  await adapter.reconcileShopifyReversalFixtureOrder(
    credential,
    { sourceIdentifier, uniqueTag },
  )
assert.equal(lifecycleReconciliation.resolution, 'applied')
assert.equal(lifecycleReconciliation.order.id, exactOrder.id)

providerResponse = {
  orders: {
    nodes: [{
      ...lifecycleAdvancedOrder,
      transactions: [{
        ...lifecycleAdvancedOrder.transactions[0],
        amountSet: {
          shopMoney: { amount: '9.00', currencyCode: 'USD' },
          presentmentMoney: { amount: '9.00', currencyCode: 'USD' },
        },
      }],
    }],
    pageInfo: { hasNextPage: false },
  },
}
assert.equal(
  (await adapter.reconcileShopifyReversalFixtureOrder(
    credential,
    { sourceIdentifier, uniqueTag },
  )).resolution,
  'ambiguous',
  'transaction drift cannot be accepted as the exact applied fixture',
)

providerResponse = {
  orders: {
    nodes: [{
      ...lifecycleAdvancedOrder,
      sourceIdentifier: 'clawpilot-reversal-fixture:gsfc7654321',
    }],
    pageInfo: { hasNextPage: false },
  },
}
assert.equal(
  (await adapter.reconcileShopifyReversalFixtureOrder(
    credential,
    { sourceIdentifier, uniqueTag },
  )).resolution,
  'ambiguous',
  'command-specific source identity drift cannot be accepted',
)

providerResponse = {
  orders: {
    nodes: [{
      ...lifecycleAdvancedOrder,
      transactions: Array.from({ length: 10 }, (_, index) => ({
        id: `gid://shopify/OrderTransaction/${246813600 + index}`,
        kind: index === 0 ? 'AUTHORIZATION' : 'CAPTURE',
        status: 'SUCCESS',
        test: true,
        amountSet: {
          shopMoney: { amount: '10.00', currencyCode: 'USD' },
          presentmentMoney: { amount: '10.00', currencyCode: 'USD' },
        },
      })),
    }],
    pageInfo: { hasNextPage: false },
  },
}
assert.equal(
  (await adapter.reconcileShopifyReversalFixtureOrder(
    credential,
    { sourceIdentifier, uniqueTag },
  )).resolution,
  'ambiguous',
  'a full bounded transaction window cannot prove exhaustive identity',
)

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
