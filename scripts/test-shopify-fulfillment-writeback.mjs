#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const writebackSource = readFileSync(
  resolve('app_src/lib/integrations/shopifyFulfillmentWriteback.ts'),
  'utf8',
)
assert.match(
  writebackSource,
  /from '@\/lib\/persistence\/sandboxCommerceE2eAuthorization'/,
  'The legacy authority import must preserve Linux-sensitive filename casing',
)
assert.equal(
  existsSync(resolve(
    'app_src/lib/persistence/sandboxCommerceE2eAuthorization.ts',
  )),
  true,
)
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
      if (specifier === '@/lib/persistence/shopifyTestStoreCanonicalE2e') {
        return {
          requireShopifyTestStoreFulfillmentWriteClaimInPostgres: async () => {
            throw new Error('Unexpected Shopify test-store fulfillment claim')
          },
        }
      }
      if (specifier === '@/lib/persistence/sandboxCommerceE2eAuthorization') {
        return {
          requireLegacySandboxCommerceE2eFulfillmentWriteClaimInPostgres:
            async () => {
              throw new Error('Unexpected legacy sandbox fulfillment claim')
            },
        }
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const organizationId = '11111111-1111-4111-8111-111111111111'
const accountGlobalId = 'gia1234567'
const orderGid = 'gid://shopify/Order/6899404406984'
const fulfillmentGid = 'gid://shopify/Fulfillment/999'
const fulfillmentOrderGidA = 'gid://shopify/FulfillmentOrder/456'
const fulfillmentOrderGidB = 'gid://shopify/FulfillmentOrder/457'
const fulfillmentOrderLineItemGidA = 'gid://shopify/FulfillmentOrderLineItem/788'
const fulfillmentOrderLineItemGidB = 'gid://shopify/FulfillmentOrderLineItem/789'
const lineItemGid = 'gid://shopify/LineItem/789'
const locationGid = 'gid://shopify/Location/321'
const calls = []

const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } })
const openFulfillmentOrder = (id, fulfillmentOrderLineItemId, remainingQuantity) => ({
  id,
  status: 'OPEN',
  requestStatus: 'UNSUBMITTED',
  assignedLocation: { location: { id: locationGid } },
  lineItems: page([{
    id: fulfillmentOrderLineItemId,
    lineItem: { id: lineItemGid },
    remainingQuantity,
  }]),
})
const openOrder = (fulfillments = []) => ({
  id: orderGid,
  canNotifyCustomer: true,
  fulfillmentsCount: { count: fulfillments.length },
  fulfillments,
  fulfillmentOrders: page([
    openFulfillmentOrder(fulfillmentOrderGidA, fulfillmentOrderLineItemGidA, 30),
    openFulfillmentOrder(fulfillmentOrderGidB, fulfillmentOrderLineItemGidB, 20),
  ]),
})
const exactObservedFulfillment = () => ({
  id: fulfillmentGid,
  status: 'SUCCESS',
  fulfillmentOrders: page([
    { id: fulfillmentOrderGidA, assignedLocation: { location: { id: locationGid } } },
    { id: fulfillmentOrderGidB, assignedLocation: { location: { id: locationGid } } },
  ]),
  fulfillmentLineItems: page([{
    lineItem: { id: lineItemGid },
    quantity: 50,
  }]),
  trackingInfo: [{ company: 'UPS', number: '1ZTEST6567' }],
})

let providerOrder = openOrder()
let mutationResponse = {
  fulfillmentCreate: {
    fulfillment: { id: fulfillmentGid, status: 'SUCCESS' },
    userErrors: [],
  },
}
let mutationError = null
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
      if (request.operationName === 'ClawPilotOrderFulfillment') {
        return { order: structuredClone(providerOrder) }
      }
      if (mutationError) throw mutationError
      return structuredClone(mutationResponse)
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

await assert.rejects(
  () => module.executeShopifyFulfillmentWriteback({
    organizationId, accountGlobalId, externalOrderId: orderGid,
    trackingNumber: '1ZMISSINGDECISION', carrier: 'UPS',
  }),
  (error) => error?.code === 'SHOPIFY_FULFILLMENT_NOTIFICATION_DECISION_REQUIRED',
)
assert.equal(calls.length, 0)

const input = {
  organizationId, accountGlobalId, externalOrderId: orderGid,
  trackingNumber: '1ZTEST6567', carrier: 'UPS', notifyCustomer: false,
  expectedLineItems: [{ externalLineId: lineItemGid, quantity: 50 }],
}
const preparation = await module.prepareShopifyFulfillmentWriteback(input)
assert.deepEqual(JSON.parse(JSON.stringify(preparation)), {
  signature: {
    version: 1,
    externalOrderId: orderGid,
    fulfillmentOrders: [
      {
        fulfillmentOrderId: fulfillmentOrderGidA,
        locationId: locationGid,
        lineItems: [{
          fulfillmentOrderLineItemId: fulfillmentOrderLineItemGidA,
          lineItemId: lineItemGid,
          quantity: 30,
        }],
      },
      {
        fulfillmentOrderId: fulfillmentOrderGidB,
        locationId: locationGid,
        lineItems: [{
          fulfillmentOrderLineItemId: fulfillmentOrderLineItemGidB,
          lineItemId: lineItemGid,
          quantity: 20,
        }],
      },
    ],
    lineItems: [{ lineItemId: lineItemGid, quantity: 50 }],
    carrier: 'UPS',
    trackingNumbers: ['1ZTEST6567'],
    notifyCustomer: false,
    sandboxE2eAuthorityKind: null,
  },
  existing: null,
})
assert.equal(calls.length, 1)
assert.match(calls[0].query, /fulfillmentOrders\(first: 100\)/)
assert.match(calls[0].query, /fulfillmentLineItems\(first: 250\)/)
assert.match(calls[0].query, /lineItem \{ id \} quantity/)
assert.match(calls[0].query, /lineItem \{ id \} remainingQuantity/)
assert.match(calls[0].query, /trackingInfo\(first: 11\) \{ company number \}/)

providerOrder = openOrder()
providerOrder.canNotifyCustomer = false
calls.length = 0
await assert.rejects(
  () => module.prepareShopifyFulfillmentWriteback({
    ...input,
    notifyCustomer: true,
  }),
  (error) => error?.code === 'SHOPIFY_FULFILLMENT_CUSTOMER_NOTIFICATION_UNAVAILABLE',
)
assert.equal(calls.length, 1, 'Notification eligibility must fail during read-only preparation')

providerOrder = openOrder()
calls.length = 0
await assert.rejects(
  () => module.prepareShopifyFulfillmentWriteback({
    ...input,
    expectedLineItems: [{ externalLineId: lineItemGid, quantity: 49 }],
  }),
  (error) => error?.code === 'SHOPIFY_FULFILLMENT_EXPECTED_LINES_MISMATCH',
)
assert.equal(calls.length, 1, 'Package-line mismatch must fail during read-only preparation')

calls.length = 0
const result = await module.executeShopifyFulfillmentWriteback({
  ...input,
  attemptSignature: preparation.signature,
})
assert.deepEqual(JSON.parse(JSON.stringify(result)), {
  providerReference: fulfillmentGid, trackingNumber: '1ZTEST6567',
  trackingNumbers: ['1ZTEST6567'], replayed: false,
})
assert.equal(calls.length, 2)
assert.deepEqual(JSON.parse(JSON.stringify(calls[1].variables.fulfillment)), {
  lineItemsByFulfillmentOrder: [
    {
      fulfillmentOrderId: fulfillmentOrderGidA,
      fulfillmentOrderLineItems: [{ id: fulfillmentOrderLineItemGidA, quantity: 30 }],
    },
    {
      fulfillmentOrderId: fulfillmentOrderGidB,
      fulfillmentOrderLineItems: [{ id: fulfillmentOrderLineItemGidB, quantity: 20 }],
    },
  ],
  notifyCustomer: false,
  trackingInfo: { number: '1ZTEST6567', company: 'UPS' },
})

providerOrder = openOrder()
providerOrder.fulfillmentOrders.nodes[1].lineItems.nodes[0].remainingQuantity = 19
calls.length = 0
await assert.rejects(
  () => module.executeShopifyFulfillmentWriteback({
    ...input,
    attemptSignature: preparation.signature,
  }),
  (error) => error?.code === 'SHOPIFY_FULFILLMENT_PLAN_CHANGED',
)
assert.equal(calls.length, 1, 'A changed open plan must not dispatch fulfillmentCreate')

providerOrder = openOrder()
calls.length = 0
const multiResult = await module.executeShopifyFulfillmentWriteback({
  organizationId, accountGlobalId, externalOrderId: orderGid,
  trackingNumbers: ['1ZTEST6567A', '1ZTEST6567B', '1ZTEST6567C'],
  carrier: 'UPS', notifyCustomer: true,
  expectedLineItems: [{ externalLineId: lineItemGid, quantity: 50 }],
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
assert.equal(calls[1].variables.fulfillment.notifyCustomer, true)

calls.length = 0
await assert.rejects(
  () => module.reconcileShopifyFulfillmentWriteback(input),
  (error) => error?.code === 'SHOPIFY_FULFILLMENT_SIGNATURE_REQUIRED',
)
assert.equal(calls.length, 0, 'Missing signatures must fail before provider authorization')

const absentReconciliation = await module.reconcileShopifyFulfillmentWriteback({
  ...input,
  attemptSignature: preparation.signature,
})
assert.equal(absentReconciliation, null)
assert.equal(calls.length, 1, 'Unknown-outcome reconciliation must remain read-only')
assert.equal(calls[0].operationName, 'ClawPilotOrderFulfillment')

function providerOnlyModule(orderFactory) {
  return load({
    '@/lib/integrations/commerceCredentialCrypto': {},
    '@/lib/integrations/commerceCapabilities': {},
    '@/lib/persistence/commerceIntegrations': {},
    '@/lib/persistence/commerceActiveTransitionAuthorization': {},
    '@/lib/integrations/shopifyCommerceClient': {
      shopifyAdminGraphql: async () => ({ order: structuredClone(orderFactory()) }),
    },
  })
}

const closedOrderWith = (fulfillment) => ({
  id: orderGid,
  canNotifyCustomer: true,
  fulfillmentsCount: { count: 1 },
  fulfillments: [fulfillment],
  fulfillmentOrders: page([]),
})
const providerInput = {
  externalOrderId: orderGid,
  trackingNumbers: ['1ZTEST6567'],
  carrier: 'UPS',
  notifyCustomer: false,
  expectedLineItems: [{ lineItemId: lineItemGid, quantity: 50 }],
}
const credential = {
  shopDomain: 'ag-alchemy.myshopify.com',
  accessToken: 'token',
}
const replayModule = providerOnlyModule(() => closedOrderWith(exactObservedFulfillment()))

assert.deepEqual(JSON.parse(JSON.stringify(await replayModule.writeShopifyFulfillment(
  credential,
  providerInput,
  preparation.signature,
))), {
  providerReference: fulfillmentGid, trackingNumber: '1ZTEST6567',
  trackingNumbers: ['1ZTEST6567'], replayed: true,
})
assert.deepEqual(JSON.parse(JSON.stringify(await replayModule.readShopifyFulfillment(
  credential,
  providerInput,
  preparation.signature,
))), {
  providerReference: fulfillmentGid, trackingNumber: '1ZTEST6567',
  trackingNumbers: ['1ZTEST6567'], replayed: true,
})
await assert.rejects(
  () => replayModule.writeShopifyFulfillment(credential, providerInput),
  (error) => error?.code === 'SHOPIFY_FULFILLMENT_NOT_OPEN',
  'A direct call must not replay based on tracking alone',
)

providerOrder = openOrder([exactObservedFulfillment()])
calls.length = 0
const replayPreparation = await module.prepareShopifyFulfillmentWriteback(input)
assert.equal(replayPreparation.existing?.providerReference, fulfillmentGid)
assert.equal(replayPreparation.existing?.replayed, true)
assert.equal(calls.length, 1)

async function assertNearMatchRejected(mutator, label) {
  const observed = exactObservedFulfillment()
  mutator(observed)
  const nearMatchModule = providerOnlyModule(() => closedOrderWith(observed))
  assert.equal(
    await nearMatchModule.readShopifyFulfillment(
      credential,
      providerInput,
      preparation.signature,
    ),
    null,
    label,
  )
}

await assertNearMatchRejected(
  (fulfillment) => { fulfillment.trackingInfo[0].company = 'FedEx' },
  'Same tracking number with the wrong carrier must not reconcile',
)
await assertNearMatchRejected(
  (fulfillment) => { fulfillment.fulfillmentOrders.nodes.pop() },
  'Same tracking number with different fulfillment-order coverage must not reconcile',
)
await assertNearMatchRejected(
  (fulfillment) => { fulfillment.fulfillmentLineItems.nodes[0].quantity = 49 },
  'Same tracking number with a different line quantity must not reconcile',
)
await assertNearMatchRejected(
  (fulfillment) => {
    fulfillment.fulfillmentOrders.nodes[0].assignedLocation.location.id =
      'gid://shopify/Location/322'
  },
  'Same tracking and coverage from a different location must not reconcile',
)
await assertNearMatchRejected(
  (fulfillment) => { fulfillment.status = 'PENDING' },
  'Only successful fulfillments may reconcile',
)

await assert.rejects(
  () => replayModule.readShopifyFulfillment(
    credential,
    providerInput,
    { ...preparation.signature, notifyCustomer: true },
  ),
  (error) => error?.code === 'SHOPIFY_FULFILLMENT_SIGNATURE_INPUT_MISMATCH',
  'The immutable notification decision must remain bound to the attempt input',
)
await assertNearMatchRejected(
  (fulfillment) => {
    fulfillment.trackingInfo.push({ company: 'UPS', number: '1ZEXTRA' })
  },
  'The observed tracking set must be exact',
)

const paginated = exactObservedFulfillment()
paginated.fulfillmentLineItems.pageInfo.hasNextPage = true
const paginationModule = providerOnlyModule(() => closedOrderWith(paginated))
await assert.rejects(
  () => paginationModule.readShopifyFulfillment(
    credential,
    providerInput,
    preparation.signature,
  ),
  (error) => error?.code === 'SHOPIFY_FULFILLMENT_RECONCILIATION_PAGINATION_REQUIRED',
)

providerOrder = openOrder()
calls.length = 0
mutationError = new Error('connection reset after request dispatch')
await assert.rejects(
  () => module.executeShopifyFulfillmentWriteback({
    ...input,
    attemptSignature: preparation.signature,
  }),
  (error) => (
    error?.code === 'SHOPIFY_FULFILLMENT_OUTCOME_UNKNOWN'
    && error?.retryable === true
    && error?.outcomeUnknown === true
  ),
)
assert.equal(calls.length, 2)

mutationError = null
mutationResponse = { fulfillmentCreate: { fulfillment: null, userErrors: [] } }
calls.length = 0
await assert.rejects(
  () => module.executeShopifyFulfillmentWriteback({
    ...input,
    attemptSignature: preparation.signature,
  }),
  (error) => (
    error?.code === 'SHOPIFY_FULFILLMENT_OUTCOME_UNKNOWN'
    && error?.retryable === true
    && error?.outcomeUnknown === true
  ),
)
assert.equal(calls.length, 2)

mutationResponse = {
  fulfillmentCreate: {
    fulfillment: null,
    userErrors: [{ field: ['fulfillment'], message: 'Fulfillment is invalid' }],
  },
}
calls.length = 0
await assert.rejects(
  () => module.executeShopifyFulfillmentWriteback({
    ...input,
    attemptSignature: preparation.signature,
  }),
  (error) => (
    error?.code === 'SHOPIFY_FULFILLMENT_REJECTED'
    && error?.outcomeUnknown === false
  ),
)
assert.equal(calls.length, 2)

const mismatchedOrderModule = load({
  '@/lib/integrations/commerceCredentialCrypto': {},
  '@/lib/integrations/commerceCapabilities': {},
  '@/lib/persistence/commerceIntegrations': {},
  '@/lib/persistence/commerceActiveTransitionAuthorization': {},
  '@/lib/integrations/shopifyCommerceClient': {
    shopifyAdminGraphql: async () => ({ order: {
      ...closedOrderWith(exactObservedFulfillment()),
      id: 'gid://shopify/Order/6899404406985',
    } }),
  },
})
await assert.rejects(
  () => mismatchedOrderModule.readShopifyFulfillment(
    credential,
    providerInput,
    preparation.signature,
  ),
  (error) => error?.code === 'SHOPIFY_FULFILLMENT_ORDER_MISMATCH',
)

// Exact authority-kind dispatch is executable through the real authorization,
// preparation, signature, replay, and mutation logic. Only the final Shopify
// transport boundary and durable claim readers are substituted here.
const legacyAuthorizationGlobalId = 'gsea1234567'
const canonicalAuthorizationGlobalId = 'gsea7654321'
const retainedLegacyAuthorizationGlobalId = 'gsea2222222'
const commerceExportGlobalId = 'gfe1234567'
let authorityEnvironment = 'production'
let authorityProviderOrder = openOrder()
const authorityCalls = {
  capabilities: [],
  canonicalClaims: 0,
  legacyClaims: 0,
  provider: 0,
  mutations: 0,
}
const claimError = (code) => Object.assign(new Error(code), { code })
const authorityModule = load({
  '@/lib/integrations/commerceCredentialCrypto': {
    normalizeCommerceOrganizationId: String,
    normalizeCommerceAccountGlobalId: String,
    decryptCommerceCredential: () => ({
      provider: 'shopify', clientId: 'id', clientSecret: 'secret',
    }),
  },
  '@/lib/integrations/commerceCapabilities': {
    hasEffectiveShopifyScope: (scopes, scope) => scopes.includes(scope),
  },
  '@/lib/integrations/shopifyCommerceClient': {
    normalizeShopifyShopDomain: String,
    requestShopifyAccessToken: async () => {
      authorityCalls.provider += 1
      return {
        accessToken: 'token',
        grantedScopes: ['write_merchant_managed_fulfillment_orders'],
      }
    },
    probeShopifyConnection: async () => {
      authorityCalls.provider += 1
      return {
        shopId: 'gid://shopify/Shop/123',
        grantedScopes: ['write_merchant_managed_fulfillment_orders'],
      }
    },
    shopifyAdminGraphql: async (_credential, request) => {
      authorityCalls.provider += 1
      if (request.operationName === 'ClawPilotOrderFulfillment') {
        return { order: structuredClone(authorityProviderOrder) }
      }
      authorityCalls.mutations += 1
      authorityProviderOrder = closedOrderWith(exactObservedFulfillment())
      return {
        fulfillmentCreate: {
          fulfillment: { id: fulfillmentGid, status: 'SUCCESS' },
          userErrors: [],
        },
      }
    },
  },
  '@/lib/persistence/commerceIntegrations': {
    readCommerceRuntimeCredentialFromPostgres: async () => ({
      organizationId,
      globalId: accountGlobalId,
      provider: 'shopify',
      environment: authorityEnvironment,
      externalAccountId: 'gid://shopify/Shop/123',
      status: 'active',
      verificationStatus: 'verified',
      credentialVersion: 7,
      configuration: { shopDomain: 'ag-alchemy.myshopify.com' },
      encrypted: {},
    }),
  },
  '@/lib/persistence/commerceActiveTransitionAuthorization': {
    requireCommerceActiveCapabilityClaimInPostgres: async ({ capability }) => {
      authorityCalls.capabilities.push(capability)
      return { activationRevision: 4, credentialGeneration: 7, capability }
    },
  },
  '@/lib/persistence/shopifyTestStoreCanonicalE2e': {
    requireShopifyTestStoreFulfillmentWriteClaimInPostgres: async (claim) => {
      authorityCalls.canonicalClaims += 1
      if (claim.authorizationGlobalId !== canonicalAuthorizationGlobalId) {
        throw claimError('SHOPIFY_TEST_E2E_FULFILLMENT_CLAIM_INVALID')
      }
      return {
        authorityKind: 'shopify_test_store_canonical',
        credentialGeneration: 7,
        externalAccountId: 'gid://shopify/Shop/123',
        notifyCustomer: false,
      }
    },
  },
  '@/lib/persistence/sandboxCommerceE2eAuthorization': {
    requireLegacySandboxCommerceE2eFulfillmentWriteClaimInPostgres:
      async (claim) => {
        authorityCalls.legacyClaims += 1
        if (![
          legacyAuthorizationGlobalId,
          retainedLegacyAuthorizationGlobalId,
        ].includes(claim.authorizationGlobalId)) {
          throw claimError('SANDBOX_E2E_FULFILLMENT_CLAIM_INVALID')
        }
        return {
          authorityKind: 'legacy_packed',
          notifyCustomer: false,
          authorityKindPersisted:
            claim.authorizationGlobalId !== retainedLegacyAuthorizationGlobalId,
        }
      },
  },
})
const authorityInput = {
  ...input,
  sandboxE2eAuthorizationGlobalId: legacyAuthorizationGlobalId,
  sandboxE2eAuthorityKind: 'legacy_packed',
  commerceExportGlobalId,
}

authorityProviderOrder = openOrder()
const legacyPreparation = await authorityModule.prepareShopifyFulfillmentWriteback(
  authorityInput,
)
assert.equal(
  legacyPreparation.signature.sandboxE2eAuthorityKind,
  'legacy_packed',
  'A new legacy attempt must durably bind its exact authority kind',
)
assert.deepEqual(authorityCalls.capabilities, [
  'fulfillment_export', 'tracking_export',
])
assert.equal(authorityCalls.legacyClaims, 1)
assert.equal(authorityCalls.canonicalClaims, 0)
const firstLegacyResult = await authorityModule.executeShopifyFulfillmentWriteback({
  ...authorityInput,
  attemptSignature: legacyPreparation.signature,
})
assert.equal(firstLegacyResult.replayed, false)
assert.equal(authorityCalls.mutations, 1)
const replayedLegacyResult = await authorityModule.executeShopifyFulfillmentWriteback({
  ...authorityInput,
  attemptSignature: legacyPreparation.signature,
})
assert.equal(replayedLegacyResult.replayed, true)
assert.equal(authorityCalls.mutations, 1, 'Exact retry must not duplicate fulfillment')

authorityEnvironment = 'sandbox'
authorityProviderOrder = openOrder()
authorityCalls.capabilities.length = 0
const canonicalPreparation =
  await authorityModule.prepareShopifyFulfillmentWriteback({
    ...input,
    sandboxE2eAuthorizationGlobalId: canonicalAuthorizationGlobalId,
    sandboxE2eAuthorityKind: 'shopify_test_store_canonical',
    commerceExportGlobalId,
  })
assert.equal(
  canonicalPreparation.signature.sandboxE2eAuthorityKind,
  'shopify_test_store_canonical',
)
assert.deepEqual(
  authorityCalls.capabilities,
  [],
  'Canonical Read only authority must not be replaced by Active capabilities',
)
let providerCallsBeforeRejection = authorityCalls.provider
await assert.rejects(
  () => authorityModule.prepareShopifyFulfillmentWriteback({
    ...input,
    notifyCustomer: true,
    sandboxE2eAuthorizationGlobalId: canonicalAuthorizationGlobalId,
    sandboxE2eAuthorityKind: 'shopify_test_store_canonical',
    commerceExportGlobalId,
  }),
  (error) => error?.code === 'SHOPIFY_TEST_E2E_FULFILLMENT_AUTHORIZATION_STALE',
)
assert.equal(
  authorityCalls.provider,
  providerCallsBeforeRejection,
  'Canonical notification mismatch must make zero provider calls',
)

for (const rejected of [
  {
    ...authorityInput,
    sandboxE2eAuthorityKind: 'shopify_test_store_canonical',
  },
  {
    ...authorityInput,
    sandboxE2eAuthorizationGlobalId: canonicalAuthorizationGlobalId,
  },
  {
    ...authorityInput,
    sandboxE2eAuthorityKind: undefined,
  },
  {
    ...authorityInput,
    commerceExportGlobalId: undefined,
  },
  {
    ...authorityInput,
    sandboxE2eAuthorityKind: 'unknown_authority',
  },
]) {
  providerCallsBeforeRejection = authorityCalls.provider
  await assert.rejects(
    () => authorityModule.prepareShopifyFulfillmentWriteback(rejected),
  )
  assert.equal(
    authorityCalls.provider,
    providerCallsBeforeRejection,
    'Cross-kind, missing, or malformed evidence must make zero provider calls',
  )
}

// A pre-field legacy attempt remains usable only through the exact legacy DB
// compatibility claim. The in-memory upgrade is not available to canonical or
// newly kind-bound snapshots, and all new preparations persist the kind.
authorityEnvironment = 'production'
authorityProviderOrder = openOrder()
const retainedLegacyInput = {
  ...input,
  sandboxE2eAuthorizationGlobalId: retainedLegacyAuthorizationGlobalId,
  commerceExportGlobalId,
}
const retainedPreparation =
  await authorityModule.prepareShopifyFulfillmentWriteback(retainedLegacyInput)
assert.equal(
  retainedPreparation.signature.sandboxE2eAuthorityKind,
  'legacy_packed',
)
const retainedAttempt = JSON.parse(JSON.stringify(retainedPreparation.signature))
delete retainedAttempt.sandboxE2eAuthorityKind
authorityProviderOrder = openOrder()
const retainedResult = await authorityModule.executeShopifyFulfillmentWriteback({
  ...retainedLegacyInput,
  attemptSignature: retainedAttempt,
})
assert.equal(retainedResult.replayed, false)
const retainedMutationCount = authorityCalls.mutations
const retainedReplay = await authorityModule.executeShopifyFulfillmentWriteback({
  ...retainedLegacyInput,
  attemptSignature: retainedAttempt,
})
assert.equal(retainedReplay.replayed, true)
assert.equal(
  authorityCalls.mutations,
  retainedMutationCount,
  'A retained legacy attempt must reconcile without a duplicate mutation',
)

console.log('Shopify fulfillment writeback tests passed')
