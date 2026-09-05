#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const path = 'app_src/lib/integrations/shopifyLocationAdministration.ts'
const source = readFileSync(path, 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: path,
}).outputText

class ShopifyCommerceClientError extends Error {
  constructor(code, status = 502) {
    super(code)
    this.code = code
    this.status = status
  }
}

const persistenceError = class extends Error {}
const persistence = {
  claimShopifyLocationAdministrationInPostgres() {},
  prepareShopifyLocationAdministrationInPostgres() {},
  readPendingShopifyLocationAdministrationsInPostgres() { return [] },
  readShopifyLocationAdministrationAuthorizationInPostgres() {},
  readShopifyLocationAdministrationConfigurationInPostgres() {},
  recordShopifyLocationAdministrationOutcomeInPostgres() {},
  recoverStaleShopifyLocationAdministrationInPostgres() {},
  reconcileShopifyLocationAdministrationAppliedInPostgres() {},
  ShopifyLocationAdministrationPersistenceError: persistenceError,
}
const module = { exports: {} }
vm.runInNewContext(output, {
  AbortController,
  Buffer,
  Date,
  Error,
  JSON,
  Map,
  Math,
  Number,
  Object,
  Promise,
  RegExp,
  Set,
  String,
  URL,
  console,
  exports: module.exports,
  module,
  process,
  require(specifier) {
    if (specifier === 'node:crypto') return requireFromApp(specifier)
    if (specifier === '@/lib/integrations/commerceCredentialCrypto') {
      return {
        decryptCommerceCredential() {},
        normalizeCommerceAccountGlobalId: String,
        normalizeCommerceOrganizationId: String,
      }
    }
    if (specifier === '@/lib/integrations/commerceCapabilities') {
      return {
        hasEffectiveShopifyScope() { return true },
        SHOPIFY_ADMIN_API_VERSION: '2026-07',
      }
    }
    if (specifier === '@/lib/integrations/shopifyCommerceClient') {
      return {
        normalizeShopifyShopDomain: String,
        probeShopifyConnection() {},
        requestShopifyAccessToken() {},
        ShopifyCommerceClientError,
        shopifyAdminGraphql() {},
      }
    }
    if (
      specifier
      === '@/lib/integrations/shopifyLocationAdministrationRuntime'
    ) {
      return {
        shopifyLocationAdministrationAccountAllowed() { return true },
        shopifyLocationAdministrationRuntime() {
          return { available: true }
        },
      }
    }
    if (specifier === '@/lib/persistence/shopifyLocationAdministration') {
      return persistence
    }
    if (specifier === '@/lib/persistence/commerceIntegrations') {
      return { readCommerceRuntimeCredentialFromPostgres() {} }
    }
    if (specifier === '@/lib/integrations/integrationCredentialRuntimeGate.mjs') {
      return integrationCredentialRuntimeGate
    }
    return requireFromApp(specifier)
  },
}, { filename: path })

const api = module.exports
const credential = Object.freeze({
  shopDomain: 'test-pro-bakery-bites.myshopify.com',
  accessToken: 'redacted-test-token',
})
const desired = Object.freeze({
  name: 'Test Pro Bakery Bites Warehouse',
  address: Object.freeze({
    address1: '100 Bakery Way',
    address2: '',
    city: 'Fairfield',
    provinceCode: 'CT',
    countryCode: 'US',
    zip: '06824',
  }),
  fulfillsOnlineOrders: true,
})

function location(overrides = {}) {
  return {
    id: 'gid://shopify/Location/2890001',
    name: desired.name,
    isActive: true,
    activatable: true,
    shipsInventory: true,
    fulfillsOnlineOrders: true,
    isFulfillmentService: false,
    fulfillmentService: null,
    address: { ...desired.address },
    ...overrides,
  }
}

{
  const flaggedLegacyService =
    api.normalizeShopifyLocationAdministrationLocation(location({
      isFulfillmentService: true,
      fulfillmentService: null,
    }))
  assert.equal(flaggedLegacyService.isFulfillmentService, true)
  const serviceObjectWins =
    api.normalizeShopifyLocationAdministrationLocation(location({
      isFulfillmentService: false,
      fulfillmentService: {
        id: 'gid://shopify/FulfillmentService/9',
        handle: 'legacy-service',
        serviceName: 'Legacy Service',
      },
    }))
  assert.equal(serviceObjectWins.isFulfillmentService, true)
}

{
  const calls = []
  const result = await api.executeShopifyLocationAdministrationProviderMutation({
    credential,
    action: 'locationAdd',
    desired,
    providerLocationId: null,
    providerIdempotencyKey: '28900000-0000-4000-8000-000000000001',
  }, {
    async graphql(_credential, request) {
      calls.push(request)
      if (request.operationName === 'ClawPilotLocationAdd') {
        return { locationAdd: { location: location(), userErrors: [] } }
      }
      return { node: location() }
    },
  })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.providerWrites, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].operationName, 'ClawPilotLocationAdd')
  assert.equal(calls[1].operationName, 'ClawPilotLocationAdministrationLocation')
}

{
  let calls = 0
  const result = await api.executeShopifyLocationAdministrationProviderMutation({
    credential,
    action: 'locationEdit',
    desired,
    providerLocationId: 'gid://shopify/Location/2890001',
    providerIdempotencyKey: '28900000-0000-4000-8000-000000000002',
  }, {
    async graphql() {
      calls += 1
      return {
        locationEdit: {
          location: null,
          userErrors: [{
            field: ['input', 'name'],
            message: 'Location name is unavailable',
            code: 'TAKEN',
          }],
        },
      }
    },
  })
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.providerWritesKnown, true)
  assert.equal(result.providerWrites, 0)
  assert.equal(result.errorCode, 'SHOPIFY_LOCATION_ADMINISTRATION_USER_ERROR')
  assert.equal(result.userErrors.length, 1)
  assert.equal(Object.hasOwn(result.userErrors[0], 'message'), false)
  assert.equal(calls, 1, 'definitive userErrors must not trigger readback')
}

{
  let calls = 0
  const result = await api.executeShopifyLocationAdministrationProviderMutation({
    credential,
    action: 'locationAdd',
    desired,
    providerLocationId: null,
    providerIdempotencyKey: '28900000-0000-4000-8000-000000000003',
  }, {
    async graphql() {
      calls += 1
      throw new ShopifyCommerceClientError('SHOPIFY_TIMEOUT')
    },
  })
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.providerWrites, null)
  assert.equal(calls, 1, 'ambiguous mutation must never be blindly retried')
}

{
  const stableKey = '28900000-0000-4000-8000-000000000004'
  const calls = []
  const result = await api.executeShopifyLocationAdministrationProviderMutation({
    credential,
    action: 'locationActivate',
    desired,
    providerLocationId: 'gid://shopify/Location/2890001',
    providerIdempotencyKey: stableKey,
  }, {
    async graphql(_credential, request) {
      calls.push(request)
      if (request.operationName === 'ClawPilotLocationActivate') {
        return {
          locationActivate: {
            location: location(),
            locationActivateUserErrors: [],
          },
        }
      }
      return { node: location() }
    },
  })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(calls[0].variables.idempotencyKey, stableKey)
  assert.match(calls[0].query, /@idempotent\(key: \$idempotencyKey\)/u)
  assert.equal(calls.length, 2)
}

{
  let calls = 0
  const result = await api.executeShopifyLocationAdministrationProviderMutation({
    credential,
    action: 'locationEdit',
    desired,
    providerLocationId: 'gid://shopify/Location/2890001',
    providerIdempotencyKey: '28900000-0000-4000-8000-000000000005',
  }, {
    async graphql() {
      calls += 1
      return {
        locationEdit: {
          location: location({
            isFulfillmentService: true,
            fulfillmentService: {
              id: 'gid://shopify/FulfillmentService/10',
              handle: 'third-party',
              serviceName: 'Third Party',
            },
          }),
          userErrors: [],
        },
      }
    },
  })
  assert.equal(result.outcome, 'unknown')
  assert.equal(
    result.errorCode,
    'SHOPIFY_LOCATION_ADMINISTRATION_OWNERSHIP_UNCERTAIN',
  )
  assert.equal(calls, 1, 'fulfillment-service response must not be accepted')
}

{
  let claimCalls = 0
  persistence.claimShopifyLocationAdministrationInPostgres = () => {
    claimCalls += 1
    throw new Error('terminal replay must not claim')
  }
  persistence.readShopifyLocationAdministrationAuthorizationInPostgres =
    async () => ({
      authorizedBy: 'owner@example.test',
      idempotencyKey: 'terminal-replay-2890001',
      status: 'unknown',
      action: 'locationAdd',
      outcomeProviderLocationId: 'gid://shopify/Location/2890099',
    })
  const replay = await api.executeShopifyLocationAdministration({
    organizationId: '11111111-1111-4111-8111-111111111111',
    actorEmail: 'owner@example.test',
    authorizationGlobalId: 'gsla2890001',
    idempotencyKey: 'terminal-replay-2890001',
  })
  assert.equal(replay.replayed, true)
  assert.equal(replay.outcomeUncertain, true)
  assert.equal(replay.reconcileRequired, true)
  assert.equal(replay.providerWrites, null)
  assert.equal(replay.mappingRequired, false)
  assert.equal(claimCalls, 0, 'unknown outcome replay must not dispatch')
}

assert.doesNotMatch(source, /mutation\s+ClawPilotLocation(?:Delete|Deactivate)/u)
assert.match(source, /locationActivateUserErrors\s*\{/u)
assert.match(source, /providerMutationsDuringReconciliation:\s*0/u)

console.log('Shopify location-administration provider/readback tests passed')
