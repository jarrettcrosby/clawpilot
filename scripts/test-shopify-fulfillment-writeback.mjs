#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

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
assert.match(
  writebackSource,
  /from '@\/lib\/persistence\/commerceProviderWrites'/,
  'Shopify fulfillment writes must use the exact per-account Provider Writes authority',
)
assert.doesNotMatch(
  writebackSource,
  /commerceActiveTransitionAuthorization|requireCommerceActiveCapabilityClaimInPostgres/,
  'Shopify fulfillment writes must not depend on the legacy global Operations activation profile',
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
      if (specifier === '@/lib/persistence/shopifyReversalFixture') {
        return {
          assertShopifyReversalFixtureFulfillmentClaimCurrentInPostgres:
            async () => {},
        }
      }
      if (specifier === '@/lib/integrations/shopifyReversalFixtureRuntime') {
        return {
          SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN:
            'test-pro-bakery-bites.myshopify.com',
        }
      }
      if (specifier === '@/lib/integrations/integrationCredentialRuntimeGate.mjs') {
        return integrationCredentialRuntimeGate
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
const requiredScope = 'write_merchant_managed_fulfillment_orders'
const requiredScopes = ['read_orders', requiredScope]
const currentGrantedScopes = ['write_orders', requiredScope]
const hasEffectiveShopifyScope = (scopes, scope) => (
  scopes.includes(scope)
  || (
    scope.startsWith('read_')
    && scopes.includes(`write_${scope.slice('read_'.length)}`)
  )
)
const providerWriteScopeDigest = 'a'.repeat(64)
const providerAttemptGlobalId = 'gxa1234567'
const providerAttemptRequestHash = 'c'.repeat(64)
const providerAttemptLeaseToken = '33333333-3333-4333-8333-333333333333'
const providerCommerceExportGlobalId = 'gfe7654321'
const registeredProviderAttemptEvidence = {
  providerAttemptGlobalId,
  providerAttemptRequestHash,
  providerAttemptLeaseToken,
  commerceExportGlobalId: providerCommerceExportGlobalId,
  providerWriteAccountGlobalId: accountGlobalId,
  providerWriteProvider: 'shopify',
  providerWriteEnvironment: 'production',
  providerWriteControlRowVersion: 11,
  providerWriteCredentialGeneration: 7,
  providerWriteScopeDigest,
}
const exactProviderWriteAuthority = (environment = 'production') => ({
  accountGlobalId,
  provider: 'shopify',
  environment,
  controlRowVersion: 11,
  credentialGeneration: 7,
  grantedScopes: currentGrantedScopes,
  grantedScopeDigest: providerWriteScopeDigest,
})
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
let providerWritesOn = true
let providerWriteChecks = 0
let sealedProviderWriteChecks = 0
const module = load({
  '@/lib/integrations/commerceCredentialCrypto': {
    normalizeCommerceOrganizationId: String,
    normalizeCommerceAccountGlobalId: String,
    decryptCommerceCredential: () => ({ provider: 'shopify', clientId: 'id', clientSecret: 'secret' }),
  },
  '@/lib/integrations/commerceCapabilities': {
    hasEffectiveShopifyScope,
  },
  '@/lib/integrations/shopifyCommerceClient': {
    normalizeShopifyShopDomain: String,
    requestShopifyAccessToken: async () => ({
      accessToken: 'token', grantedScopes: currentGrantedScopes,
    }),
    probeShopifyConnection: async () => ({
      shopId: 'gid://shopify/Shop/123', grantedScopes: currentGrantedScopes,
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
  '@/lib/persistence/commerceProviderWrites': {
    requireCurrentCommerceProviderWritesInPostgres: async (request) => {
      providerWriteChecks += 1
      assert.equal(request.organizationId, organizationId)
      assert.equal(request.accountGlobalId, accountGlobalId)
      assert.equal(request.provider, 'shopify')
      assert.equal(JSON.stringify(request.requiredScopes), JSON.stringify(requiredScopes))
      if (!providerWritesOn) {
        throw Object.assign(new Error('Provider Writes is Off'), {
          code: 'COMMERCE_PROVIDER_WRITES_OFF',
          status: 403,
        })
      }
      return exactProviderWriteAuthority()
    },
    requireSealedCommerceProviderWritesInPostgres: async (request) => {
      sealedProviderWriteChecks += 1
      assert.equal(request.organizationId, organizationId)
      assert.equal(request.accountGlobalId, accountGlobalId)
      assert.equal(request.provider, 'shopify')
      assert.equal(request.environment, 'production')
      assert.equal(JSON.stringify(request.requiredScopes), JSON.stringify(requiredScopes))
      assert.equal(request.expectedControlRowVersion, 11)
      assert.equal(request.expectedCredentialGeneration, 7)
      assert.equal(request.expectedGrantedScopeDigest, providerWriteScopeDigest)
      assert.equal(request.providerAttemptGlobalId, providerAttemptGlobalId)
      assert.equal(
        request.providerAttemptRequestHash,
        providerAttemptRequestHash,
      )
      assert.equal(request.providerAttemptLeaseToken, providerAttemptLeaseToken)
      assert.equal(
        request.commerceExportGlobalId,
        providerCommerceExportGlobalId,
      )
      return exactProviderWriteAuthority()
    },
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
  ...registeredProviderAttemptEvidence,
}

// Provider Writes Off is the account-exact external-write boundary. It must
// reject both preparation and execution before runtime credentials are read or
// decrypted, and before token, probe, query, or mutation provider calls.
const offBoundaryCalls = {
  providerWrites: 0,
  runtimeCredentials: 0,
  decryptions: 0,
  accessTokens: 0,
  probes: 0,
  graphql: 0,
}
const offModule = load({
  '@/lib/integrations/commerceCredentialCrypto': {
    normalizeCommerceOrganizationId: String,
    normalizeCommerceAccountGlobalId: String,
    decryptCommerceCredential: () => {
      offBoundaryCalls.decryptions += 1
      return { provider: 'shopify', clientId: 'id', clientSecret: 'secret' }
    },
  },
  '@/lib/integrations/commerceCapabilities': {
    hasEffectiveShopifyScope,
  },
  '@/lib/integrations/shopifyCommerceClient': {
    normalizeShopifyShopDomain: String,
    requestShopifyAccessToken: async () => {
      offBoundaryCalls.accessTokens += 1
      return { accessToken: 'token', grantedScopes: currentGrantedScopes }
    },
    probeShopifyConnection: async () => {
      offBoundaryCalls.probes += 1
      return {
        shopId: 'gid://shopify/Shop/123',
        grantedScopes: currentGrantedScopes,
      }
    },
    shopifyAdminGraphql: async () => {
      offBoundaryCalls.graphql += 1
      return { order: structuredClone(providerOrder) }
    },
  },
  '@/lib/persistence/commerceIntegrations': {
    readCommerceRuntimeCredentialFromPostgres: async () => {
      offBoundaryCalls.runtimeCredentials += 1
      return {
        organizationId,
        globalId: accountGlobalId,
        provider: 'shopify',
        environment: 'production',
        externalAccountId: 'gid://shopify/Shop/123',
        status: 'active',
        verificationStatus: 'verified',
        credentialVersion: 7,
        configuration: { shopDomain: 'ag-alchemy.myshopify.com' },
        encrypted: {},
      }
    },
  },
  '@/lib/persistence/commerceProviderWrites': {
    requireCurrentCommerceProviderWritesInPostgres: async (request) => {
      offBoundaryCalls.providerWrites += 1
      assert.equal(request.organizationId, organizationId)
      assert.equal(request.accountGlobalId, accountGlobalId)
      assert.equal(request.provider, 'shopify')
      assert.equal(JSON.stringify(request.requiredScopes), JSON.stringify(requiredScopes))
      throw Object.assign(new Error('Provider Writes is Off'), {
        code: 'COMMERCE_PROVIDER_WRITES_OFF',
        status: 403,
      })
    },
    requireSealedCommerceProviderWritesInPostgres: async () => {
      throw new Error('Off-before-registration must not use sealed authority')
    },
  },
})
await assert.rejects(
  () => offModule.prepareShopifyFulfillmentWriteback(input),
  (error) => error?.code === 'COMMERCE_PROVIDER_WRITES_OFF',
)
await assert.rejects(
  () => offModule.executeShopifyFulfillmentWriteback({
    ...input,
    providerAttemptGlobalId: undefined,
  }),
  (error) => error?.code === 'SHOPIFY_FULFILLMENT_PROVIDER_ATTEMPT_INVALID',
)
assert.deepEqual(offBoundaryCalls, {
  providerWrites: 1,
  runtimeCredentials: 0,
  decryptions: 0,
  accessTokens: 0,
  probes: 0,
  graphql: 0,
})

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
assert.equal(
  providerWriteChecks,
  1,
  'Provider Writes On must allow preparation without any global activation-profile dependency',
)
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

// Off is the atomic cutoff for new durable provider-attempt registrations.
// Once the caller has durably registered an exact attempt while On, a later
// Off decision may not strand that immutable in-flight mutation. The sealed
// authority path still exact-checks account/provider/environment/credential.
providerWritesOn = false
providerOrder = openOrder()
calls.length = 0
const providerChecksBeforeRegisteredExecution = providerWriteChecks
const sealedChecksBeforeRegisteredExecution = sealedProviderWriteChecks
await assert.rejects(
  () => module.executeShopifyFulfillmentWriteback({
    ...input,
    attemptSignature: preparation.signature,
    providerWriteAccountGlobalId: 'gia7654321',
    providerWriteProvider: 'shopify',
    providerWriteEnvironment: 'production',
    providerWriteControlRowVersion: 11,
    providerWriteCredentialGeneration: 7,
    providerWriteScopeDigest,
  }),
  (error) => error?.code === 'SHOPIFY_FULFILLMENT_PROVIDER_AUTHORITY_MISMATCH',
)
assert.equal(sealedProviderWriteChecks, sealedChecksBeforeRegisteredExecution)
assert.equal(calls.length, 0, 'Mismatched sealed identity must make zero provider calls')
const registeredResult = await module.executeShopifyFulfillmentWriteback({
  ...input,
  attemptSignature: preparation.signature,
  providerWriteAccountGlobalId: accountGlobalId,
  providerWriteProvider: 'shopify',
  providerWriteEnvironment: 'production',
  providerWriteControlRowVersion: 11,
  providerWriteCredentialGeneration: 7,
  providerWriteScopeDigest,
})
assert.equal(registeredResult.replayed, false)
assert.equal(providerWriteChecks, providerChecksBeforeRegisteredExecution)
assert.equal(
  sealedProviderWriteChecks,
  sealedChecksBeforeRegisteredExecution + 3,
  'A sealed attempt must be checked before credential use and immediately before the mutation',
)
assert.equal(calls.length, 2)
providerWritesOn = true

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
  ...registeredProviderAttemptEvidence,
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
const providerWriteChecksBeforeReconciliation = providerWriteChecks
providerWritesOn = false
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
assert.equal(
  providerWriteChecks,
  providerWriteChecksBeforeReconciliation,
  'Read-only reconciliation must remain available while Provider Writes is Off',
)
providerWritesOn = true

function providerOnlyModule(orderFactory) {
  return load({
    '@/lib/integrations/commerceCredentialCrypto': {},
    '@/lib/integrations/commerceCapabilities': {},
    '@/lib/persistence/commerceIntegrations': {},
    '@/lib/persistence/commerceProviderWrites': {},
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
const fixturePreparation = await providerOnlyModule(() => openOrder())
  .prepareShopifyFulfillmentProviderAttempt(credential, providerInput)
assert.equal(fixturePreparation.existing, null)
assert.deepEqual(
  JSON.parse(JSON.stringify(fixturePreparation.providerInput)),
  {
    ...providerInput,
    sandboxE2eAuthorityKind: null,
    allowLegacySignatureWithoutAuthorityKind: false,
  },
)
assert.equal(
  fixturePreparation.signature.sandboxE2eAuthorityKind,
  null,
)
const replayModule = providerOnlyModule(() => closedOrderWith(exactObservedFulfillment()))

assert.equal(
  replayModule.writeShopifyFulfillment,
  undefined,
  'The low-level provider mutation primitive must remain private',
)

const fixtureCredential = {
  shopDomain: 'test-pro-bakery-bites.myshopify.com',
  accessToken: 'fixture-token',
}
const fixtureInput = {
  externalOrderId: orderGid,
  trackingNumbers: ['CP-REV-gsfc1234567'],
  carrier: 'ClawPilot Fixture',
  notifyCustomer: false,
  expectedLineItems: [{ lineItemId: lineItemGid, quantity: 1 }],
  sandboxE2eAuthorityKind: null,
  allowLegacySignatureWithoutAuthorityKind: false,
}
const fixtureOrder = () => ({
  id: orderGid,
  canNotifyCustomer: true,
  fulfillmentsCount: { count: 0 },
  fulfillments: [],
  fulfillmentOrders: page([{
    id: fulfillmentOrderGidA,
    status: 'OPEN',
    requestStatus: 'UNSUBMITTED',
    assignedLocation: { location: { id: locationGid } },
    lineItems: page([{
      id: fulfillmentOrderLineItemGidA,
      lineItem: { id: lineItemGid },
      remainingQuantity: 1,
    }]),
  }]),
})
const fixtureProviderCalls = []
let fixtureFenceError = null
let expectedFixturePayloadHash = null
const fixtureClaim = {
  organizationId: 'c6c8e6e7-fffa-4969-9526-e99da0ab2754',
  commandId: '44444444-4444-4444-8444-444444444444',
  attemptId: '55555555-5555-4555-8555-555555555555',
  actorEmail: 'owner@example.test',
}
const fixtureModule = load({
  '@/lib/integrations/commerceCredentialCrypto': {},
  '@/lib/integrations/commerceCapabilities': {},
  '@/lib/persistence/commerceIntegrations': {},
  '@/lib/persistence/commerceProviderWrites': {},
  '@/lib/integrations/shopifyCommerceClient': {
    shopifyAdminGraphql: async (_credential, request) => {
      fixtureProviderCalls.push(structuredClone(request))
      if (request.operationName === 'ClawPilotOrderFulfillment') {
        return {
          order: { ...fixtureOrder(), id: request.variables.id },
        }
      }
      return {
        fulfillmentCreate: {
          fulfillment: { id: fulfillmentGid, status: 'SUCCESS' },
          userErrors: [],
        },
      }
    },
  },
  '@/lib/persistence/shopifyReversalFixture': {
    assertShopifyReversalFixtureFulfillmentClaimCurrentInPostgres:
      async (claim) => {
        assert.deepEqual({
          organizationId: claim.organizationId,
          commandId: claim.commandId,
          attemptId: claim.attemptId,
          actorEmail: claim.actorEmail,
        }, fixtureClaim)
        assert.match(claim.providerPayloadHash, /^[a-f0-9]{64}$/u)
        if (fixtureFenceError) throw fixtureFenceError
        if (claim.providerPayloadHash !== expectedFixturePayloadHash) {
          throw Object.assign(new Error('stale provider payload'), {
            code: 'SHOPIFY_REVERSAL_FIXTURE_CLAIM_STALE',
          })
        }
      },
  },
})
const fixtureAttempt = await fixtureModule.prepareShopifyFulfillmentProviderAttempt(
  fixtureCredential,
  fixtureInput,
)
expectedFixturePayloadHash =
  fixtureModule.shopifyReversalFixtureFulfillmentProviderPayloadHash(
    fixtureCredential,
    fixtureInput,
    fixtureAttempt.signature,
  )
fixtureFenceError = Object.assign(new Error('stale fixture claim'), {
  code: 'SHOPIFY_REVERSAL_FIXTURE_CLAIM_STALE',
})
await assert.rejects(
  () => fixtureModule.executeShopifyReversalFixtureFulfillmentProviderAttempt(
    fixtureCredential,
    fixtureInput,
    fixtureAttempt.signature,
    fixtureClaim,
  ),
  (error) => error?.code === 'SHOPIFY_REVERSAL_FIXTURE_CLAIM_STALE',
)
fixtureFenceError = null
assert.equal(
  fixtureProviderCalls.filter((request) => (
    request.operationName === 'ClawPilotFulfillmentCreate'
  )).length,
  0,
  'a final fixture fence failure must issue zero fulfillment mutations',
)
const substitutedFixtureInput = {
  ...fixtureInput,
  externalOrderId: 'gid://shopify/Order/6899404406985',
}
const substitutedFixtureAttempt = {
  ...fixtureAttempt.signature,
  externalOrderId: substitutedFixtureInput.externalOrderId,
}
await assert.rejects(
  () => fixtureModule.executeShopifyReversalFixtureFulfillmentProviderAttempt(
    fixtureCredential,
    substitutedFixtureInput,
    substitutedFixtureAttempt,
    fixtureClaim,
  ),
  (error) => error?.code === 'SHOPIFY_REVERSAL_FIXTURE_CLAIM_STALE',
)
assert.equal(
  fixtureProviderCalls.filter((request) => (
    request.operationName === 'ClawPilotFulfillmentCreate'
  )).length,
  0,
  'a substituted fixture payload must fail before fulfillmentCreate',
)
await fixtureModule.executeShopifyReversalFixtureFulfillmentProviderAttempt(
  fixtureCredential,
  fixtureInput,
  fixtureAttempt.signature,
  fixtureClaim,
)
const emittedFixtureMutation = fixtureProviderCalls.findLast((request) => (
  request.operationName === 'ClawPilotFulfillmentCreate'
))
assert.ok(emittedFixtureMutation)
const exactEmittedFixtureHash = createHash('sha256').update(JSON.stringify({
  version: 'shopify-reversal-fixture-fulfillment-provider-payload-v1',
  shopDomain: fixtureCredential.shopDomain,
  externalOrderId: fixtureInput.externalOrderId,
  variables: emittedFixtureMutation.variables,
})).digest('hex')
assert.equal(
  exactEmittedFixtureHash,
  expectedFixturePayloadHash,
  'the final fulfillment fence must hash the exact emitted GraphQL variables',
)
const changedFixtureVariables = structuredClone(emittedFixtureMutation.variables)
changedFixtureVariables.fulfillment.trackingInfo.company = 'Changed carrier'
assert.notEqual(
  createHash('sha256').update(JSON.stringify({
    version: 'shopify-reversal-fixture-fulfillment-provider-payload-v1',
    shopDomain: fixtureCredential.shopDomain,
    externalOrderId: fixtureInput.externalOrderId,
    variables: changedFixtureVariables,
  })).digest('hex'),
  expectedFixturePayloadHash,
  'mutation-only fulfillment drift must change the final provider payload hash',
)
assert.deepEqual(JSON.parse(JSON.stringify(await replayModule.readShopifyFulfillment(
  credential,
  providerInput,
  preparation.signature,
))), {
  providerReference: fulfillmentGid, trackingNumber: '1ZTEST6567',
  trackingNumbers: ['1ZTEST6567'], replayed: true,
})
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
  '@/lib/persistence/commerceProviderWrites': {},
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
  providerWrites: [],
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
    hasEffectiveShopifyScope,
  },
  '@/lib/integrations/shopifyCommerceClient': {
    normalizeShopifyShopDomain: String,
    requestShopifyAccessToken: async () => {
      authorityCalls.provider += 1
      return {
        accessToken: 'token',
        grantedScopes: currentGrantedScopes,
      }
    },
    probeShopifyConnection: async () => {
      authorityCalls.provider += 1
      return {
        shopId: 'gid://shopify/Shop/123',
        grantedScopes: currentGrantedScopes,
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
  '@/lib/persistence/commerceProviderWrites': {
    requireCurrentCommerceProviderWritesInPostgres: async (request) => {
      authorityCalls.providerWrites.push(request)
      assert.equal(request.organizationId, organizationId)
      assert.equal(request.accountGlobalId, accountGlobalId)
      assert.equal(request.provider, 'shopify')
      assert.equal(JSON.stringify(request.requiredScopes), JSON.stringify(requiredScopes))
      return exactProviderWriteAuthority(authorityEnvironment)
    },
    requireSealedCommerceProviderWritesInPostgres: async (request) => {
      authorityCalls.providerWrites.push(request)
      assert.equal(request.organizationId, organizationId)
      assert.equal(request.accountGlobalId, accountGlobalId)
      assert.equal(request.provider, 'shopify')
      assert.equal(request.environment, authorityEnvironment)
      assert.equal(JSON.stringify(request.requiredScopes), JSON.stringify(requiredScopes))
      assert.equal(request.providerAttemptGlobalId, providerAttemptGlobalId)
      assert.equal(
        request.providerAttemptRequestHash,
        providerAttemptRequestHash,
      )
      assert.equal(request.providerAttemptLeaseToken, providerAttemptLeaseToken)
      assert.equal(request.commerceExportGlobalId, commerceExportGlobalId)
      return exactProviderWriteAuthority(authorityEnvironment)
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
assert.equal(authorityCalls.providerWrites.length, 1)
assert.equal(authorityCalls.providerWrites[0].accountGlobalId, accountGlobalId)
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
const providerWriteChecksBeforeCanonical = authorityCalls.providerWrites.length
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
  authorityCalls.providerWrites.length,
  providerWriteChecksBeforeCanonical + 1,
  'Canonical exact-order authority must remain layered on account-exact Provider Writes',
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
