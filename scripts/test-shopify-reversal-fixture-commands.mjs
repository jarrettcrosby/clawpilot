#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const path = 'app_src/lib/operations/shopifyReversalFixtureCommands.ts'
const source = readFileSync(resolve(path), 'utf8')

const organizationId = '11111111-1111-4111-8111-111111111111'
const actorEmail = 'owner@example.test'
const authority = Object.freeze({
  organizationId,
  actorEmail,
  actorRole: 'owner',
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  accountGlobalId: 'giah34fedoa5b1o',
  externalAccountId: 'gid://shopify/Shop/123456789',
  shopDomain: 'fixed-development-store.myshopify.com',
  controlRowVersion: 7,
  credentialGeneration: 3,
  grantedScopeDigest: 'a'.repeat(64),
  grantedScopes: [
    'read_orders',
    'write_orders',
    'write_merchant_managed_fulfillment_orders',
  ],
  databaseIdentity: '750aa268-0e31-4065-a99c-4016e4d4fab1',
})
const target = Object.freeze({
  predecessorCommandId: '33333333-3333-4333-8333-333333333333',
  predecessorCommandGlobalId: 'gsfc1234567',
  orderId: '44444444-4444-4444-8444-444444444444',
  orderGlobalId: 'gor1234567',
  externalOrderId: 'gid://shopify/Order/123456789',
  orderName: '#1001',
  expectedOrderRowVersion: 8,
  releasedAt: '2026-08-25T12:00:00.000Z',
  providerLocationId: 'gid://shopify/Location/555',
  expectedLines: [{
    lineItemId: 'gid://shopify/LineItem/987654321',
    quantity: 1,
  }],
})
const signature = Object.freeze({
  version: 'shopify-fulfillment-attempt-v2',
  externalOrderId: target.externalOrderId,
  carrier: 'ClawPilot Fixture',
  trackingNumbers: ['CP-REV-GSFC7654321'],
  fulfillmentOrders: [{
    fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/100',
    locationId: target.providerLocationId,
  }],
  lineItems: [{
    lineItemId: target.expectedLines[0].lineItemId,
    quantity: 1,
  }],
})

const calls = {
  assertCurrent: 0,
  createOrder: 0,
  fulfillmentPrepare: 0,
  fulfillmentWrite: 0,
  fulfillmentRead: 0,
  inserts: [],
  outcomes: [],
  providerWrites: [],
}
let replay = null
let claimed = null
let unknown = null
let createOrderMode = 'success'
let fulfillmentMode = 'success'

class FixtureProviderError extends Error {
  constructor(code, outcomeUnknown = false) {
    super(code)
    this.code = code
    this.status = 502
    this.providerMutationAttempted = true
    this.outcomeUnknown = outcomeUnknown
  }
}
class FulfillmentError extends Error {
  constructor(code, outcomeUnknown = false) {
    super(code)
    this.code = code
    this.status = 502
    this.providerMutationAttempted = true
    this.outcomeUnknown = outcomeUnknown
  }
}

function commandFromInsert(input) {
  const phase = input.phase
  const fulfillment = input.fulfillmentTarget || null
  return Object.freeze({
    id: phase === 'create_order'
      ? '55555555-5555-4555-8555-555555555555'
      : '66666666-6666-4666-8666-666666666666',
    globalId: input.commandGlobalId,
    organizationId,
    phase,
    actorEmail,
    actorRole: 'owner',
    idempotencyKey: input.idempotencyKey,
    intentHash: input.intentHash,
    confirmationHash: input.confirmationHash,
    sourceIdentifier: input.sourceIdentifier || null,
    uniqueTag: input.uniqueTag || null,
    tagFingerprint: input.tagFingerprint || null,
    predecessorCommandId: fulfillment?.predecessorCommandId || null,
    orderId: fulfillment?.orderId || null,
    orderGlobalId: fulfillment?.orderGlobalId || null,
    externalOrderId: fulfillment?.externalOrderId || null,
    expectedOrderRowVersion: fulfillment?.expectedOrderRowVersion || null,
    releasedAt: fulfillment?.releasedAt || null,
    providerLocationId: fulfillment?.providerLocationId || null,
    expectedLines: fulfillment?.expectedLines || null,
    fulfillmentAttemptSignature: input.fulfillmentAttemptSignature || null,
    fulfillmentAttemptSignatureHash:
      input.fulfillmentAttemptSignatureHash || null,
    preparedAt: '2026-08-25T12:00:01.000Z',
    expiresAt: '2026-08-25T12:05:01.000Z',
    authority,
  })
}

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
  String,
  console,
  exports: module.exports,
  module,
  require(specifier) {
    if (specifier === 'node:crypto') {
      return { createHash, createHmac }
    }
    if (specifier === '@/lib/integrations/commerceCredentialCrypto') {
      return {
        decryptCommerceCredential: () => ({
          provider: 'shopify',
          clientId: 'redacted-client',
          clientSecret: 'redacted-secret',
        }),
      }
    }
    if (specifier === '@/lib/integrations/commerceCapabilities') {
      return { hasEffectiveShopifyScope: (scopes, scope) => (
        scopes.includes(scope)
      ) }
    }
    if (specifier === '@/lib/integrations/shopifyCommerceClient') {
      return {
        normalizeShopifyShopDomain: String,
        requestShopifyAccessToken: async () => ({
          accessToken: 'redacted-token',
          grantedScopes: [...authority.grantedScopes],
        }),
        probeShopifyConnection: async () => ({
          shopId: authority.externalAccountId,
          shopDomain: authority.shopDomain,
          grantedScopes: [...authority.grantedScopes],
        }),
      }
    }
    if (specifier === '@/lib/integrations/shopifyFulfillmentWriteback') {
      return {
        ShopifyFulfillmentWritebackError: FulfillmentError,
        shopifyFulfillmentAttemptSignatureHash: () => 'b'.repeat(64),
        prepareShopifyFulfillmentProviderAttempt: async (
          _credential,
          input,
        ) => {
          calls.fulfillmentPrepare += 1
          assert.equal(input.notifyCustomer, false)
          assert.deepEqual(input.expectedLineItems, target.expectedLines)
          return { signature, existing: null, providerInput: input }
        },
        writeShopifyFulfillment: async (
          _credential,
          input,
          suppliedSignature,
          beforeProviderMutation,
        ) => {
          calls.fulfillmentWrite += 1
          assert.equal(input.notifyCustomer, false)
          assert.equal(input.sandboxE2eAuthorityKind, null)
          assert.equal(suppliedSignature, signature)
          if (fulfillmentMode === 'replayed') {
            return {
              providerReference: 'gid://shopify/Fulfillment/999',
              trackingNumber: input.trackingNumbers[0],
              trackingNumbers: input.trackingNumbers,
              replayed: true,
            }
          }
          await beforeProviderMutation()
          if (fulfillmentMode === 'unknown') {
            throw new FulfillmentError(
              'SHOPIFY_FULFILLMENT_OUTCOME_UNKNOWN',
              true,
            )
          }
          if (fulfillmentMode === 'rejected') {
            throw new FulfillmentError(
              'SHOPIFY_FULFILLMENT_PROVIDER_REJECTED',
              false,
            )
          }
          return {
            providerReference: 'gid://shopify/Fulfillment/999',
            trackingNumber: input.trackingNumbers[0],
            trackingNumbers: input.trackingNumbers,
            replayed: false,
          }
        },
        readShopifyFulfillment: async () => {
          calls.fulfillmentRead += 1
          return null
        },
      }
    }
    if (specifier === '@/lib/integrations/shopifyLocationAdministration') {
      return {
        readShopifyLocationAdministrationShop: async () => ({
          id: authority.externalAccountId,
          domain: authority.shopDomain,
          name: 'Development store',
          partnerDevelopment: true,
          planName: 'Development',
        }),
      }
    }
    if (specifier === '@/lib/integrations/shopifyReversalFixtureProvider') {
      return {
        SHOPIFY_REVERSAL_FIXTURE_ORDER_PROFILE: {
          test: true,
          financialStatus: 'PENDING',
          buyerAcceptsMarketing: false,
          sendReceipt: false,
          sendFulfillmentReceipt: false,
          inventoryBehaviour: 'BYPASS',
          variantId: 'gid://shopify/ProductVariant/51028106379511',
          quantity: 1,
          requiresShipping: true,
        },
        SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION:
          'shopify-reversal-fixture-v1',
        shopifyReversalFixtureTagFingerprint: (tag) => (
          createHash('sha256').update(tag).digest('hex')
        ),
        ShopifyReversalFixtureProviderError: FixtureProviderError,
        createShopifyReversalFixtureOrder: async (
          _credential,
          input,
        ) => {
          calls.createOrder += 1
          await input.beforeProviderMutation()
          if (createOrderMode === 'unknown') {
            throw new FixtureProviderError(
              'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN',
              true,
            )
          }
          if (createOrderMode === 'rejected') {
            throw new FixtureProviderError(
              'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED',
              false,
            )
          }
          return {
            id: 'gid://shopify/Order/123456789',
            name: '#1001',
            updatedAt: '2026-08-25T12:00:02.000Z',
          }
        },
        reconcileShopifyReversalFixtureOrder: async () => ({
          resolution: 'applied',
          order: {
            id: 'gid://shopify/Order/123456789',
            name: '#1001',
            updatedAt: '2026-08-25T12:00:02.000Z',
          },
          evidenceHash: 'c'.repeat(64),
        }),
      }
    }
    if (specifier === '@/lib/integrations/shopifyReversalFixtureRuntime') {
      return {
        SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID: 'giah34fedoa5b1o',
        shopifyReversalFixtureRuntime: () => ({
          available: true,
          blockerCode: null,
        }),
      }
    }
    if (specifier === '@/lib/persistence/commerceIntegrations') {
      return {
        readCommerceRuntimeCredentialFromPostgres: async () => ({
          organizationId,
          integrationAccountId: authority.integrationAccountId,
          globalId: authority.accountGlobalId,
          provider: 'shopify',
          environment: 'sandbox',
          status: 'active',
          verificationStatus: 'verified',
          externalAccountId: authority.externalAccountId,
          credentialVersion: authority.credentialGeneration,
          configuration: { shopDomain: authority.shopDomain },
          encrypted: {},
        }),
      }
    }
    if (specifier === '@/lib/persistence/commerceProviderWrites') {
      return {
        requireCurrentCommerceProviderWritesInPostgres: async (input) => {
          calls.providerWrites.push(input)
          return {
            accountGlobalId: authority.accountGlobalId,
            provider: 'shopify',
            environment: 'sandbox',
            controlRowVersion: authority.controlRowVersion,
            credentialGeneration: authority.credentialGeneration,
            grantedScopes: [...authority.grantedScopes],
            grantedScopeDigest: authority.grantedScopeDigest,
          }
        },
      }
    }
    if (specifier === '@/lib/persistence/shopifyReversalFixture') {
      return {
        readShopifyReversalFixtureAuthorityInPostgres: async () => authority,
        readShopifyReversalFixtureCommandByIdempotencyInPostgres:
          async () => replay,
        allocateShopifyReversalFixtureCommandGlobalIdInPostgres:
          async () => claimed?.command.phase === 'create_fulfillment'
            ? 'gsfc7654321'
            : 'gsfc1234567',
        insertShopifyReversalFixtureCommandInPostgres: async (input) => {
          calls.inserts.push(input)
          return commandFromInsert(input)
        },
        readShopifyReversalFixtureFulfillmentTargetInPostgres:
          async () => target,
        claimShopifyReversalFixtureCommandInPostgres: async () => claimed,
        assertShopifyReversalFixtureClaimCurrentInPostgres: async () => {
          calls.assertCurrent += 1
        },
        recordShopifyReversalFixtureOutcomeInPostgres: async (input) => {
          calls.outcomes.push(input)
          return {
            outcomeGlobalId: 'gsfo1234567',
            state: input.outcomeState,
            recordedAt: '2026-08-25T12:00:03.000Z',
          }
        },
        readUnknownShopifyReversalFixtureCommandInPostgres:
          async () => unknown,
        readShopifyReversalFixtureCommandStateInPostgres: async () => ({
          state: 'prepared',
        }),
      }
    }
    return requireFromApp(specifier)
  },
}, { filename: path })

const commands = module.exports

const preparedOrder = await commands.prepareShopifyReversalFixtureOrder({
  organizationId,
  actorEmail,
  idempotencyKey: 'fixture-order-12345678',
})
assert.equal(preparedOrder.phase, 'create_order')
assert.match(preparedOrder.confirmationStatement, /^CREATE TEST ORDER [a-f0-9]{12}$/u)
assert.equal(calls.createOrder, 0, 'prepare must not create the provider order')
assert.equal(calls.fulfillmentPrepare, 0, 'phase 1 must not inspect fulfillment')
assert.equal(calls.inserts[0].sourceIdentifier, 'clawpilot-reversal-fixture:gsfc1234567')
assert.match(calls.inserts[0].uniqueTag, /^clawpilot-reversal-[a-f0-9]{24}$/u)

const orderCommand = commandFromInsert(calls.inserts[0])
claimed = {
  command: orderCommand,
  attemptId: '77777777-7777-4777-8777-777777777777',
  attemptGlobalId: 'gsft1234567',
}
const executedOrder = await commands.executeShopifyReversalFixtureCommand({
  organizationId,
  actorEmail,
  commandGlobalId: orderCommand.globalId,
  intentHash: orderCommand.intentHash,
  confirmationStatement: preparedOrder.confirmationStatement,
})
assert.equal(executedOrder.state, 'succeeded')
assert.equal(calls.createOrder, 1)
assert.equal(calls.assertCurrent, 1)
assert.equal(calls.fulfillmentWrite, 0, 'phase 1 must not auto-chain phase 2')
assert.equal(calls.outcomes.at(-1).providerMutationAttempted, true)

createOrderMode = 'unknown'
await commands.executeShopifyReversalFixtureCommand({
  organizationId,
  actorEmail,
  commandGlobalId: orderCommand.globalId,
  intentHash: orderCommand.intentHash,
  confirmationStatement: preparedOrder.confirmationStatement,
})
assert.equal(calls.outcomes.at(-1).outcomeState, 'unknown')
assert.equal(calls.outcomes.at(-1).providerWrites, null)
createOrderMode = 'rejected'
await commands.executeShopifyReversalFixtureCommand({
  organizationId,
  actorEmail,
  commandGlobalId: orderCommand.globalId,
  intentHash: orderCommand.intentHash,
  confirmationStatement: preparedOrder.confirmationStatement,
})
assert.equal(calls.outcomes.at(-1).outcomeState, 'rejected')
assert.equal(calls.outcomes.at(-1).providerMutationAttempted, true)
assert.equal(calls.outcomes.at(-1).providerWrites, 0)
createOrderMode = 'success'

claimed = { command: { phase: 'create_fulfillment' } }
const preparedFulfillment = await commands.prepareShopifyReversalFixtureFulfillment({
  organizationId,
  actorEmail,
  idempotencyKey: 'fixture-fulfillment-12345678',
  predecessorCommandGlobalId: target.predecessorCommandGlobalId,
  orderGlobalId: target.orderGlobalId,
})
assert.equal(preparedFulfillment.phase, 'create_fulfillment')
assert.match(
  preparedFulfillment.confirmationStatement,
  /^FULFILL TEST ORDER [a-f0-9]{12}$/u,
)
assert.equal(calls.fulfillmentPrepare, 1)
assert.equal(calls.fulfillmentWrite, 0, 'phase 2 prepare must not write')
assert.equal(calls.inserts.at(-1).fulfillmentTarget.releasedAt, target.releasedAt)
assert.equal(
  calls.inserts.at(-1).fulfillmentAttemptSignatureHash,
  'b'.repeat(64),
)

const fulfillmentCommand = commandFromInsert(calls.inserts.at(-1))
claimed = {
  command: fulfillmentCommand,
  attemptId: '88888888-8888-4888-8888-888888888888',
  attemptGlobalId: 'gsft7654321',
}
const orderCreateCallsBeforeFulfillment = calls.createOrder
const executedFulfillment = await commands.executeShopifyReversalFixtureCommand({
  organizationId,
  actorEmail,
  commandGlobalId: fulfillmentCommand.globalId,
  intentHash: fulfillmentCommand.intentHash,
  confirmationStatement: preparedFulfillment.confirmationStatement,
})
assert.equal(executedFulfillment.state, 'succeeded')
assert.equal(calls.fulfillmentWrite, 1)
assert.equal(
  calls.createOrder,
  orderCreateCallsBeforeFulfillment,
  'phase 2 must not auto-chain a new order',
)

fulfillmentMode = 'rejected'
await commands.executeShopifyReversalFixtureCommand({
  organizationId,
  actorEmail,
  commandGlobalId: fulfillmentCommand.globalId,
  intentHash: fulfillmentCommand.intentHash,
  confirmationStatement: preparedFulfillment.confirmationStatement,
})
assert.equal(calls.outcomes.at(-1).outcomeState, 'rejected')
assert.equal(calls.outcomes.at(-1).providerMutationAttempted, true)
assert.equal(calls.outcomes.at(-1).providerWrites, 0)

fulfillmentMode = 'unknown'
await commands.executeShopifyReversalFixtureCommand({
  organizationId,
  actorEmail,
  commandGlobalId: fulfillmentCommand.globalId,
  intentHash: fulfillmentCommand.intentHash,
  confirmationStatement: preparedFulfillment.confirmationStatement,
})
assert.equal(calls.outcomes.at(-1).outcomeState, 'unknown')
assert.equal(calls.outcomes.at(-1).providerMutationAttempted, true)
assert.equal(calls.outcomes.at(-1).providerWrites, null)
fulfillmentMode = 'success'

const assertCurrentBeforeReplay = calls.assertCurrent
fulfillmentMode = 'replayed'
const replayedFulfillment = await commands.executeShopifyReversalFixtureCommand({
  organizationId,
  actorEmail,
  commandGlobalId: fulfillmentCommand.globalId,
  intentHash: fulfillmentCommand.intentHash,
  confirmationStatement: preparedFulfillment.confirmationStatement,
})
assert.equal(replayedFulfillment.state, 'rejected')
assert.equal(calls.outcomes.at(-1).providerMutationAttempted, false)
assert.equal(calls.outcomes.at(-1).providerWrites, 0)
assert.equal(
  calls.outcomes.at(-1).errorCode,
  'SHOPIFY_REVERSAL_FIXTURE_FULFILLMENT_ALREADY_EXISTS',
)
assert.equal(calls.assertCurrent, assertCurrentBeforeReplay)
fulfillmentMode = 'success'

unknown = {
  command: orderCommand,
  attemptId: claimed.attemptId,
  attemptGlobalId: claimed.attemptGlobalId,
}
const reconciled = await commands.reconcileShopifyReversalFixtureCommand({
  organizationId,
  actorEmail,
  commandGlobalId: orderCommand.globalId,
})
assert.equal(reconciled.state, 'reconciled_applied')
assert.equal(reconciled.providerWrites, 0)

for (const check of calls.providerWrites) {
  assert.equal(check.accountGlobalId, 'giah34fedoa5b1o')
  assert.equal(check.provider, 'shopify')
  assert.equal(JSON.stringify(check.requiredScopes), JSON.stringify([
    'read_orders',
    'write_orders',
    'write_merchant_managed_fulfillment_orders',
  ]))
  assert.equal(check.expectedControlRowVersion, 7)
  assert.equal(check.expectedCredentialGeneration, 3)
  assert.equal(check.expectedGrantedScopeDigest, 'a'.repeat(64))
}

console.log('Shopify reversal fixture two-phase command boundaries passed.')
