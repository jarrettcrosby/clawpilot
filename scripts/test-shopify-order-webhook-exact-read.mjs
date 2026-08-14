#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(readFileSync(resolve(path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const loaded = { exports: {} }
  vm.runInNewContext(output, {
    BigInt,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    Set,
    String,
    console,
    exports: loaded.exports,
    module: loaded,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return loaded.exports
}

const detail = {
  id: 'gid://shopify/Order/9301',
  name: '#9301',
  createdAt: '2026-08-13T16:00:00.000Z',
  processedAt: '2026-08-13T16:00:01.000Z',
  updatedAt: '2026-08-13T17:00:00.000Z',
  cancelledAt: null,
  closedAt: null,
  confirmed: true,
  currencyCode: 'USD',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  returnStatus: 'NO_RETURN',
  currentSubtotalPriceSet: {
    shopMoney: { amount: '10.00', currencyCode: 'USD' },
  },
  currentShippingPriceSet: {
    shopMoney: { amount: '0.00', currencyCode: 'USD' },
  },
  currentTotalTaxSet: {
    shopMoney: { amount: '0.00', currencyCode: 'USD' },
  },
  currentTotalDiscountsSet: {
    shopMoney: { amount: '0.00', currencyCode: 'USD' },
  },
  currentTotalPriceSet: {
    shopMoney: { amount: '10.00', currencyCode: 'USD' },
  },
  lineItems: {
    nodes: [{
      id: 'gid://shopify/LineItem/9301',
      title: 'Test product',
      variantTitle: null,
      sku: 'TEST-9301',
      vendor: 'ClawPilot',
      quantity: 1,
      currentQuantity: 1,
      unfulfilledQuantity: 1,
      requiresShipping: true,
      originalUnitPriceSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
      originalTotalSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
      discountedTotalSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
      totalDiscountSet: {
        shopMoney: { amount: '0.00', currencyCode: 'USD' },
      },
      unfulfilledOriginalTotalSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
      unfulfilledDiscountedTotalSet: {
        shopMoney: { amount: '10.00', currencyCode: 'USD' },
      },
      product: { id: 'gid://shopify/Product/9301' },
      variant: { id: 'gid://shopify/ProductVariant/9301' },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  fulfillments: [],
  refunds: [],
  returns: {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
}

let returnedOrder = detail
const providerOperations = []
class CommerceOrderSyncError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}
const history = loadTypeScriptModule(
  'app_src/lib/integrations/commerceOrderHistory.ts',
  {
    '@/lib/integrations/commerceCapabilities': {
      hasEffectiveShopifyScope: (scopes, expected) => scopes.includes(expected),
    },
    '@/lib/integrations/commerceCredentialCrypto': {
      commerceProviderStaffEvidenceFingerprint: () => null,
      decryptCommerceCredential: () => ({
        provider: 'shopify',
        authMode: 'shopify_client_credentials',
        clientId: 'client-9301',
        clientSecret: 'secret-9301',
      }),
    },
    '@/lib/integrations/faireCommerceClient': {},
    '@/lib/integrations/faireCommerceNormalizer': {},
    '@/lib/integrations/shopifyCommerceClient': {
      normalizeShopifyShopDomain: (value) => value,
      async requestShopifyAccessToken() {
        providerOperations.push('token')
        return {
          accessToken: 'token-9301',
          grantedScopes: ['read_orders', 'read_all_orders', 'read_returns'],
        }
      },
      async probeShopifyConnection() {
        providerOperations.push('probe')
        return {
          shopId: 'gid://shopify/Shop/9301',
          grantedScopes: ['read_orders', 'read_all_orders', 'read_returns'],
        }
      },
      async shopifyAdminGraphql(_credential, request) {
        providerOperations.push(request.operationName)
        assert.equal(
          request.operationName,
          'ClawPilotCommerceOrderHistoryDetail',
        )
        assert.equal(request.variables.id, 'gid://shopify/Order/9301')
        assert.match(request.query, /returns\(first:/u)
        assert.doesNotMatch(request.query, /mutation/u)
        return { order: returnedOrder }
      },
    },
    '@/lib/integrations/shopifyCommerceNormalizer': {
      normalizeShopifyCommerce: (value) => ({
        orders: value.data.orders.nodes.map((source) => ({
          identity: { value: source.id },
          orderNumber: source.name,
          providerCreatedAt: source.createdAt,
          providerProcessedAt: source.processedAt,
          providerUpdatedAt: source.updatedAt,
          providerCancelledAt: source.cancelledAt,
          providerClosedAt: source.closedAt,
          rawStates: {
            lifecycle: 'OPEN',
            payment: source.displayFinancialStatus,
            fulfillment: source.displayFulfillmentStatus,
            returns: source.returnStatus,
          },
          canonicalStates: {
            lifecycle: 'open',
            payment: 'paid',
            fulfillment: 'unfulfilled',
            returns: 'none',
          },
          total: {
            state: 'available',
            value: { primary: { amountMinor: 1000n, currency: 'USD' } },
          },
          lines: [{
            identity: { value: source.lineItems.nodes[0].id },
            productIdentity: {
              state: 'available',
              value: { value: source.lineItems.nodes[0].product.id },
            },
            variantIdentity: {
              state: 'available',
              value: { value: source.lineItems.nodes[0].variant.id },
            },
            sku: source.lineItems.nodes[0].sku,
            orderedQuantity: 1,
            currentQuantity: 1,
            unfulfilledQuantity: 1,
            fulfilledQuantity: 0,
            requiresShipping: true,
          }],
          lineItemsTruncated: false,
        })),
        rejections: [],
      }),
    },
    '@/lib/operations/commerceNormalization': {
      commerceMoneyFromDecimal: () => ({ amountMinor: 0n, currency: 'USD' }),
      integerCommerceMinorUnits: () => ({ amountMinor: 0n, currency: 'USD' }),
    },
    '@/lib/persistence/commerceOrderSync': { CommerceOrderSyncError },
    '@/lib/persistence/commerceIntegrations': {
      readCommerceRuntimeCredentialFromPostgres: async () => ({
        organizationId: '00000000-0000-4000-8000-000000000001',
        integrationAccountId: '00000000-0000-4000-8000-000000000002',
        globalId: 'gia0009301',
        provider: 'shopify',
        environment: 'production',
        externalAccountId: 'gid://shopify/Shop/9301',
        status: 'active',
        verificationStatus: 'verified',
        credentialVersion: 1,
        authMode: 'shopify_client_credentials',
        configuration: { shopDomain: 'test-9301.myshopify.com' },
        encrypted: {},
      }),
    },
  },
)

const read = await history.readExactShopifyOrderHistoryObservation({
  organizationId: '00000000-0000-4000-8000-000000000001',
  accountGlobalId: 'gia0009301',
  expectedCredentialGeneration: 1,
  externalOrderId: 'gid://shopify/Order/9301',
  observedAt: '2026-08-13T17:01:00.000Z',
})
assert.deepEqual(providerOperations, [
  'token',
  'probe',
  'ClawPilotCommerceOrderHistoryDetail',
])
assert.equal(read.provider, 'shopify')
assert.equal(read.providerReads, 3)
assert.equal(read.providerWrites, 0)
assert.equal(read.readAllOrdersScopeObserved, true)
assert.equal(read.returnHistoryScopeObserved, true)
assert.equal(read.observation.observationKind, 'webhook_exact_read')
assert.equal(read.observation.externalOrderId, 'gid://shopify/Order/9301')
assert.equal(read.observation.providerReadCount, 3)

returnedOrder = { ...detail, id: 'gid://shopify/Order/9999' }
await assert.rejects(
  history.readExactShopifyOrderHistoryObservation({
    organizationId: '00000000-0000-4000-8000-000000000001',
    accountGlobalId: 'gia0009301',
    expectedCredentialGeneration: 1,
    externalOrderId: 'gid://shopify/Order/9301',
    observedAt: '2026-08-13T17:01:00.000Z',
  }),
  (error) => error.code === 'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
)
await assert.rejects(
  history.readExactShopifyOrderHistoryObservation({
    organizationId: '00000000-0000-4000-8000-000000000001',
    accountGlobalId: 'gia0009301',
    expectedCredentialGeneration: 1,
    externalOrderId: '9301',
  }),
  (error) => error.code === 'SHOPIFY_ORDER_HISTORY_EXACT_ID_INVALID',
)

console.log('Shopify exact-order webhook adapter contract checks passed')
