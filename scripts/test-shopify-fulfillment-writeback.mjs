#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
function load(mocks) {
  const path = 'app_src/lib/integrations/shopifyFulfillmentWriteback.ts'
  const output = ts.transpileModule(readFileSync(resolve(path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    AbortController, Buffer, Date, Error, Object, Promise, console,
    exports: module.exports, module, process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const organizationId = '11111111-1111-4111-8111-111111111111'
const accountGlobalId = 'gia1234567'
const orderGid = 'gid://shopify/Order/6899404406984'
const fulfillmentGid = 'gid://shopify/Fulfillment/999'
const calls = []
const module = load({
  '@/lib/integrations/commerceCredentialCrypto': {
    normalizeCommerceOrganizationId: String,
    normalizeCommerceAccountGlobalId: String,
    decryptCommerceCredential: () => ({ provider: 'shopify', clientId: 'id', clientSecret: 'secret' }),
  },
  '@/lib/integrations/commerceCapabilities': {
    hasEffectiveShopifyScope: (scopes, scope) => scopes.includes(scope),
  },
  '@/lib/integrations/shopifyCommerceClient': {
    normalizeShopifyShopDomain: String,
    requestShopifyAccessToken: async () => ({
      accessToken: 'token', grantedScopes: ['write_merchant_managed_fulfillment_orders'],
    }),
    probeShopifyConnection: async () => ({
      shopId: 'gid://shopify/Shop/123', grantedScopes: ['write_merchant_managed_fulfillment_orders'],
    }),
    shopifyAdminGraphql: async (_credential, request) => {
      calls.push(request)
      if (request.operationName === 'ClawPilotOrderFulfillment') return {
        order: {
          fulfillments: [],
          fulfillmentOrders: {
            nodes: [{
              id: 'gid://shopify/FulfillmentOrder/456', status: 'OPEN',
              assignedLocation: { location: { id: 'gid://shopify/Location/321' } },
              lineItems: {
                nodes: [{ id: 'gid://shopify/FulfillmentOrderLineItem/789', remainingQuantity: 50 }],
                pageInfo: { hasNextPage: false },
              },
            }],
            pageInfo: { hasNextPage: false },
          },
        },
      }
      return { fulfillmentCreate: { fulfillment: { id: fulfillmentGid }, userErrors: [] } }
    },
  },
  '@/lib/persistence/commerceIntegrations': {
    readCommerceRuntimeCredentialFromPostgres: async () => ({
      organizationId, globalId: accountGlobalId, provider: 'shopify', environment: 'production',
      externalAccountId: 'gid://shopify/Shop/123', status: 'active', verificationStatus: 'verified',
      credentialVersion: 7, configuration: { shopDomain: 'ag-alchemy.myshopify.com' }, encrypted: {},
    }),
  },
  '@/lib/persistence/commerceActiveTransitionAuthorization': {
    requireCommerceActiveCapabilityClaimInPostgres: async ({ capability }) => ({
      activationRevision: 4, credentialGeneration: 7, capability,
    }),
  },
})

const result = await module.executeShopifyFulfillmentWriteback({
  organizationId, accountGlobalId, externalOrderId: orderGid,
  trackingNumber: '1ZTEST6567', carrier: 'UPS',
})
assert.deepEqual(JSON.parse(JSON.stringify(result)), {
  providerReference: fulfillmentGid, trackingNumber: '1ZTEST6567',
  trackingNumbers: ['1ZTEST6567'], replayed: false,
})
assert.equal(calls.length, 2)
assert.deepEqual(JSON.parse(JSON.stringify(calls[1].variables.fulfillment)), {
  lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/456' }],
  notifyCustomer: false,
  trackingInfo: { number: '1ZTEST6567', company: 'UPS' },
})

calls.length = 0
const multiResult = await module.executeShopifyFulfillmentWriteback({
  organizationId, accountGlobalId, externalOrderId: orderGid,
  trackingNumbers: ['1ZTEST6567A', '1ZTEST6567B', '1ZTEST6567C'],
  carrier: 'UPS',
})
assert.deepEqual(JSON.parse(JSON.stringify(multiResult.trackingNumbers)), [
  '1ZTEST6567A', '1ZTEST6567B', '1ZTEST6567C',
])
assert.deepEqual(
  JSON.parse(JSON.stringify(calls[1].variables.fulfillment.trackingInfo)),
  {
    numbers: ['1ZTEST6567A', '1ZTEST6567B', '1ZTEST6567C'],
    company: 'UPS',
  },
)

const replayModule = load({
  '@/lib/integrations/commerceCredentialCrypto': {},
  '@/lib/integrations/commerceCapabilities': {},
  '@/lib/persistence/commerceIntegrations': {},
  '@/lib/persistence/commerceActiveTransitionAuthorization': {},
  '@/lib/integrations/shopifyCommerceClient': {
    shopifyAdminGraphql: async () => ({ order: {
      fulfillments: [{ id: fulfillmentGid, trackingInfo: [{ number: '1ZTEST6567' }] }],
      fulfillmentOrders: { nodes: [], pageInfo: { hasNextPage: false } },
    } }),
  },
})
assert.deepEqual(JSON.parse(JSON.stringify(await replayModule.writeShopifyFulfillment(
  { shopDomain: 'ag-alchemy.myshopify.com', accessToken: 'token' },
  { externalOrderId: orderGid, trackingNumbers: ['1ZTEST6567'], carrier: 'UPS', notifyCustomer: false },
))), {
  providerReference: fulfillmentGid, trackingNumber: '1ZTEST6567',
  trackingNumbers: ['1ZTEST6567'], replayed: true,
})

console.log('Shopify fulfillment writeback tests passed')
