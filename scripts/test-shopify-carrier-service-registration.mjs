#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

import {
  IntegrationCredentialRuntimeGateError,
  isIntegrationCredentialRuntimeGateError,
} from './lib/integration-credential-runtime-test-double.mjs'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(',')}}`
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function assertRedacted(value) {
  const serialized = JSON.stringify(value)
  for (const secret of [
    'client-secret-value',
    'short-lived-access-token',
    'opaque-callback-token-value',
  ]) {
    assert.equal(
      serialized.includes(secret),
      false,
      `redacted evidence exposed ${secret}`,
    )
  }
}

class MockShopifyCommerceClientError extends Error {
  constructor(
    message,
    status = 502,
    code = 'SHOPIFY_UPSTREAM_FAILED',
    retryable = false,
  ) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

class MockShopifyCarrierServiceClientError
  extends MockShopifyCommerceClientError {
  constructor(
    message,
    status,
    code,
    userErrors = [],
  ) {
    super(message, status, code, false)
    this.userErrors = userErrors
  }
}

function unavailable() {
  throw new Error('default dependency should be overridden by the test')
}

let runtimeGateCheckCount = 0
let runtimeGateFailureAt = null
let runtimeGateFailure = null

function assertRuntimeGate() {
  runtimeGateCheckCount += 1
  if (runtimeGateCheckCount === runtimeGateFailureAt) {
    throw runtimeGateFailure
  }
  return { mode: 'test', status: 'verified', providerIoReady: true }
}

function resetRuntimeGate() {
  runtimeGateCheckCount = 0
  runtimeGateFailureAt = null
  runtimeGateFailure = null
}

function loadRegistrationModule() {
  const path =
    'app_src/lib/integrations/shopifyCarrierServiceRegistration.ts'
  const source = readFileSync(resolve(root, path), 'utf8')
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
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
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
      if (
        specifier ===
        '@/lib/integrations/commerceCredentialCrypto'
      ) {
        return {
          decryptCommerceCredential: unavailable,
          normalizeCommerceAccountGlobalId(value) {
            const normalized = String(value || '').trim().toLowerCase()
            if (!/^gia(?:[0-9]{7}|[0-9a-v]{12})$/.test(normalized)) {
              throw new Error('invalid account')
            }
            return normalized
          },
          normalizeCommerceOrganizationId(value) {
            const normalized = String(value || '').trim().toLowerCase()
            if (
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                normalized,
              )
            ) {
              throw new Error('invalid organization')
            }
            return normalized
          },
        }
      }
      if (
        specifier ===
        '@/lib/integrations/shopifyCarrierServiceClient'
      ) {
        return {
          createShopifyCarrierService: unavailable,
          deleteShopifyCarrierService: unavailable,
          listShopifyCarrierServices: unavailable,
          queryShopifyCarrierService: unavailable,
          SHOPIFY_CARRIER_SERVICE_API_VERSION: '2026-07',
          ShopifyCarrierServiceClientError:
            MockShopifyCarrierServiceClientError,
          updateShopifyCarrierService: unavailable,
        }
      }
      if (
        specifier === '@/lib/integrations/shopifyCommerceClient'
      ) {
        return {
          normalizeShopifyShopDomain(value) {
            const normalized = String(value || '').trim().toLowerCase()
            if (!/^[a-z0-9-]+\.myshopify\.com$/.test(normalized)) {
              throw new MockShopifyCommerceClientError(
                'invalid domain',
                400,
                'SHOPIFY_DOMAIN_INVALID',
              )
            }
            return normalized
          },
          requestShopifyAccessToken: unavailable,
          ShopifyCommerceClientError:
            MockShopifyCommerceClientError,
        }
      }
      if (
        specifier ===
        '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
      ) {
        return {
          assertIntegrationCredentialProviderIoReady: assertRuntimeGate,
          isIntegrationCredentialRuntimeGateError,
        }
      }
      if (
        specifier === '@/lib/persistence/commerceExternalEffects'
      ) {
        return {
          assertRedactedCommerceExternalEffectEvidence: assertRedacted,
          claimCommerceExternalEffectsInPostgres: unavailable,
          commerceExternalEffectHash: hash,
          finalizeCommerceExternalEffectInPostgres: unavailable,
          prepareCommerceExternalEffectInPostgres: unavailable,
        }
      }
      if (
        specifier === '@/lib/persistence/commerceIntegrations'
      ) {
        return {
          readCommerceRuntimeCredentialFromPostgres: unavailable,
        }
      }
      if (
        specifier ===
        '@/lib/persistence/shopifyCarrierServiceMutationAuthorization'
      ) {
        return {
          finalizeShopifyCarrierServiceMutationInPostgres: unavailable,
        }
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const registration = loadRegistrationModule()

{
  const routeSource = readFileSync(
    resolve(
      root,
      'app_src/app/api/integrations/commerce/shopify/carrier-service/route.ts',
    ),
    'utf8',
  )
  assert.match(
    routeSource,
    /if \(isIntegrationCredentialRuntimeGateError\(error\)\) \{[\s\S]*?status: 503,[\s\S]*?'Retry-After': '60'/,
    'runtime proof loss must surface as retryable maintenance',
  )
  const mutationStart = routeSource.indexOf(
    'async function executeResourceScopedCarrierServiceMutation',
  )
  const mutationEnd = routeSource.indexOf('\nexport async function', mutationStart)
  assert.ok(mutationStart >= 0 && mutationEnd > mutationStart)
  const mutationSource = routeSource.slice(mutationStart, mutationEnd)
  const authorizeIndex = mutationSource.indexOf(
    'await authorizeShopifyCarrierServiceMutationInPostgres',
  )
  const claimIndex = mutationSource.indexOf(
    'await claimShopifyCarrierServiceMutationInPostgres',
  )
  assert.ok(authorizeIndex > 0 && claimIndex > authorizeIndex)
  assert.ok(
    mutationSource.lastIndexOf(
      'assertIntegrationCredentialProviderIoReady()',
      authorizeIndex,
    ) > 0,
    'the route must prove readiness before creating a one-time authorization',
  )
  assert.ok(
    mutationSource.lastIndexOf(
      'assertIntegrationCredentialProviderIoReady()',
      claimIndex,
    ) > authorizeIndex,
    'the route must re-prove readiness before claiming the authorization',
  )
}
const organizationId = '11111111-1111-4111-8111-111111111111'
const accountGlobalId = 'gia0000001'
const integrationAccountId =
  '22222222-2222-4222-8222-222222222222'
const aggregateHash = 'a'.repeat(64)
const callback =
  'https://dev.example.com/api/integrations/commerce/shopify/carrier-service/gia0000001/opaque-callback-token-value'
const serviceId =
  'gid://shopify/DeliveryCarrierService/123456789'

function command(overrides = {}) {
  return {
    organizationId,
    accountGlobalId,
    mode: 'active',
    credentialGeneration: 7,
    activationRevision: 9,
    aggregateId: 'shopify-checkout-rating',
    aggregateRevision: 12,
    aggregateHash,
    idempotencyKey: 'carrier-service-create-revision-12',
    mutation: {
      operation: 'create',
      name: 'ClawPilot checkout rates',
      callbackUrl: callback,
      active: true,
      supportsServiceDiscovery: false,
    },
    actorEmail: 'Jarrett+warehouse@episcs.com',
    ...overrides,
  }
}

function effectFromPrepare(input, state) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    globalId: 'gcef0000001',
    organizationId: input.organizationId,
    integrationAccountId,
    integrationAccountGlobalId: input.accountGlobalId,
    provider: input.provider,
    action: input.action,
    desiredMode: input.desiredMode,
    credentialGeneration: input.credentialGeneration,
    activationRevision: input.activationRevision,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateRevision: input.aggregateRevision,
    aggregateHash: input.aggregateHash,
    idempotencyKey: input.idempotencyKey,
    requestHash: hash(input.redactedRequest),
    redactedRequest: input.redactedRequest,
    state,
    providerAttemptId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    claimedBy: null,
    claimedAt: null,
    redactedResult: input.simulationEvidence || null,
    terminalEvidenceHash: input.simulationEvidence
      ? hash(input.simulationEvidence)
      : null,
    providerReference: null,
    errorCode: null,
    providerWriteCount: 0,
    completedAt: state === 'simulated'
      ? '2026-07-29T12:00:00.000Z'
      : null,
    createdBy: input.actorEmail,
    createdAt: '2026-07-29T12:00:00.000Z',
    updatedAt: '2026-07-29T12:00:00.000Z',
    claimable: state === 'pending',
    staleReason: null,
  }
}

function claimedEffect(prepared) {
  return {
    ...prepared,
    state: 'claimed',
    providerAttemptId:
      '44444444-4444-4444-8444-444444444444',
    leaseToken: '55555555-5555-4555-8555-555555555555',
    leaseExpiresAt: '2026-07-29T12:01:00.000Z',
    claimedBy: 'registration-test',
    claimedAt: '2026-07-29T12:00:00.000Z',
    claimable: false,
  }
}

function runtime(overrides = {}) {
  return {
    organizationId,
    integrationAccountId,
    globalId: accountGlobalId,
    provider: 'shopify',
    environment: 'sandbox',
    externalAccountId: 'gid://shopify/Shop/987654321',
    status: 'active',
    verificationStatus: 'verified',
    credentialVersion: 7,
    authMode: 'shopify_client_credentials',
    configuration: {
      shopDomain: 'ag-alchemy.myshopify.com',
    },
    encrypted: {
      ciphertext: Buffer.from('ciphertext'),
      iv: Buffer.alloc(12),
      tag: Buffer.alloc(16),
    },
    ...overrides,
  }
}

function authorizedRequestHash(mutation) {
  const redactedMutation = mutation.operation === 'delete'
    ? {
        operation: 'delete',
        carrierServiceId: mutation.id,
      }
    : mutation.operation === 'update'
      ? {
          operation: 'update',
          carrierServiceId: mutation.id,
          serviceName: mutation.name,
        }
      : {
        operation: 'create',
        serviceName: mutation.name,
        callback: {
          scheme: 'https',
          opaqueUrlSha256: createHash('sha256')
            .update(mutation.callbackUrl)
            .digest('hex'),
        },
        active: mutation.active,
        supportsServiceDiscovery: mutation.supportsServiceDiscovery,
      }
  return hash({
    provider: 'shopify',
    apiVersion: '2026-07',
    requiredScope: 'write_shipping',
    mutation: redactedMutation,
  })
}

function claimedAuthorization(mutation, overrides = {}) {
  const environment = overrides.accountEnvironment || 'sandbox'
  return {
    id: '66666666-6666-4666-8666-666666666666',
    globalId: 'gsca0000001',
    organizationId,
    integrationAccountId,
    accountGlobalId,
    operation: mutation.operation,
    accountEnvironment: environment,
    credentialGeneration: 7,
    activationState: 'shadow',
    activationRevision: 9,
    simulationActivationRevision: 9,
    providerWriteActivationRevision: 9,
    requestHash: authorizedRequestHash(mutation),
    expectedServiceGid:
      mutation.operation === 'create' ? null : mutation.id,
    status: 'claimed',
    attempt: {
      globalId: 'gscm0000001',
      leaseToken: '77777777-7777-4777-8777-777777777777',
    },
    ...overrides,
  }
}

function dependencies(options = {}) {
  const calls = []
  let prepared
  const deps = {
    async prepareExternalEffect(input) {
      calls.push(['prepare', input])
      prepared = effectFromPrepare(
        input,
        input.desiredMode === 'shadow' ? 'simulated' : 'pending',
      )
      return prepared
    },
    async claimExternalEffects(input) {
      calls.push(['claim', input])
      return [claimedEffect(prepared)]
    },
    async finalizeExternalEffect(input) {
      calls.push(['finalize', input])
      assertRedacted(input.redactedResult)
      return {
        ...claimedEffect(prepared),
        state: input.outcome,
        leaseToken: null,
        leaseExpiresAt: null,
        redactedResult: input.redactedResult,
        terminalEvidenceHash: hash(input.redactedResult),
        providerReference: input.providerReference,
        errorCode: input.errorCode,
        providerWriteCount: input.providerWriteCount,
        completedAt: '2026-07-29T12:00:01.000Z',
      }
    },
    async readRuntimeCredential(input) {
      calls.push(['runtime', input])
      return options.runtime || runtime()
    },
    decryptCredential(...args) {
      calls.push(['decrypt', args])
      return {
        provider: 'shopify',
        authMode: 'shopify_client_credentials',
        clientId: 'shopify-client-id',
        clientSecret: 'client-secret-value',
      }
    },
    async requestAccessToken(input, requestOptions) {
      calls.push(['token', input, requestOptions])
      return {
        accessToken: 'short-lived-access-token',
        grantedScopes: options.scopes || [
          'read_orders',
          'read_shipping',
          'write_shipping',
        ],
        expiresIn: 300,
        expiresAt: '2026-07-29T12:05:00.000Z',
      }
    },
    async createCarrierService(credential, input, requestOptions) {
      calls.push(['create', credential, input, requestOptions])
      if (options.providerError) throw options.providerError
      return {
        id: serviceId,
        name: input.name,
        callbackUrl: input.callbackUrl,
        active: input.active,
        supportsServiceDiscovery: input.supportsServiceDiscovery,
      }
    },
    async updateCarrierService(credential, input, requestOptions) {
      calls.push(['update', credential, input, requestOptions])
      if (options.providerError) throw options.providerError
      return {
        id: input.id,
        name: input.name || 'ClawPilot checkout rates',
        callbackUrl: input.callbackUrl || callback,
        active: input.active ?? true,
        supportsServiceDiscovery:
          input.supportsServiceDiscovery ?? false,
      }
    },
    async deleteCarrierService(credential, id, requestOptions) {
      calls.push(['delete', credential, id, requestOptions])
      if (options.providerError) throw options.providerError
      return id
    },
  }
  return { calls, deps }
}

function authorizedDependencies(authorization, options = {}) {
  const { calls, deps } = dependencies(options)
  return {
    calls,
    deps: {
      readRuntimeCredential: deps.readRuntimeCredential,
      decryptCredential: deps.decryptCredential,
      requestAccessToken: deps.requestAccessToken,
      createCarrierService: deps.createCarrierService,
      updateCarrierService: deps.updateCarrierService,
      deleteCarrierService: deps.deleteCarrierService,
      async listCarrierServices(credential, requestOptions) {
        calls.push(['list', credential, requestOptions])
        if (options.listError) throw options.listError
        if (Object.hasOwn(options, 'listResult')) {
          return options.listResult
        }
        return [{
          id: serviceId,
          name: command().mutation.name,
          callbackUrl: command().mutation.callbackUrl,
          active: command().mutation.active,
          supportsServiceDiscovery:
            command().mutation.supportsServiceDiscovery,
        }]
      },
      async queryCarrierService(credential, id, requestOptions) {
        calls.push(['query', credential, id, requestOptions])
        if (options.queryError) throw options.queryError
        if (Object.hasOwn(options, 'queryResult')) {
          return options.queryResult
        }
        return {
          id,
          name: command().mutation.name,
          callbackUrl: command().mutation.callbackUrl,
          active: command().mutation.active,
          supportsServiceDiscovery:
            command().mutation.supportsServiceDiscovery,
        }
      },
      async finalizeAuthorizedMutation(input) {
        calls.push(['authorized-finalize', input])
        assertRedacted(input.redactedResult)
        return {
          ...authorization,
          status: input.outcome,
          outcome: {
            globalId: 'gsco0000001',
            state: input.outcome,
            providerReference: input.providerReference,
            providerWriteCount: input.providerWriteCount,
          },
        }
      },
    },
  }
}

{
  const { calls, deps } = dependencies()
  const outage = new IntegrationCredentialRuntimeGateError(
    'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
  )
  runtimeGateFailure = outage
  runtimeGateFailureAt = 1
  await assert.rejects(
    () => registration.executeShopifyCarrierServiceRegistration(
      command(),
      deps,
    ),
    (error) => error === outage,
  )
  assert.deepEqual(calls.map(([name]) => name), ['prepare'])
  resetRuntimeGate()
}

{
  const { calls, deps } = dependencies()
  const outage = new IntegrationCredentialRuntimeGateError(
    'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
  )
  runtimeGateFailure = outage
  runtimeGateFailureAt = 2
  await assert.rejects(
    () => registration.executeShopifyCarrierServiceRegistration(
      command(),
      deps,
    ),
    (error) => error === outage,
  )
  assert.deepEqual(
    calls.map(([name]) => name),
    ['prepare', 'claim'],
    'post-claim maintenance must not synthesize terminal provider evidence',
  )
  resetRuntimeGate()
}

{
  const outage = new IntegrationCredentialRuntimeGateError(
    'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
  )
  const { calls, deps } = dependencies()
  deps.decryptCredential = (...args) => {
    calls.push(['decrypt', args])
    throw outage
  }
  await assert.rejects(
    () => registration.executeShopifyCarrierServiceRegistration(
      command(),
      deps,
    ),
    (error) => error === outage,
  )
  assert.deepEqual(
    calls.map(([name]) => name),
    ['prepare', 'claim', 'runtime', 'decrypt'],
  )
}

{
  const mutation = command().mutation
  const authorization = claimedAuthorization(mutation)
  const outage = new IntegrationCredentialRuntimeGateError(
    'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
  )
  const { calls, deps } = authorizedDependencies(authorization)
  deps.decryptCredential = (...args) => {
    calls.push(['decrypt', args])
    throw outage
  }
  await assert.rejects(
    () => registration.executeAuthorizedShopifyCarrierServiceMutation(
      { authorization, mutation },
      deps,
    ),
    (error) => error === outage,
  )
  assert.deepEqual(
    calls.map(([name]) => name),
    ['runtime', 'decrypt'],
    'a claimed authorization must remain unresolved during key maintenance',
  )
}

{
  const { calls, deps } = dependencies()
  const result =
    await registration.executeShopifyCarrierServiceRegistration(
      command({
        mode: 'shadow',
        idempotencyKey: 'carrier-service-shadow-revision-12',
      }),
      deps,
    )
  assert.equal(result.effect.state, 'simulated')
  assert.equal(result.effect.providerWriteCount, 0)
  assert.deepEqual(calls.map(([name]) => name), ['prepare'])
  const prepare = calls[0][1]
  assert.equal(prepare.desiredMode, 'shadow')
  assert.equal(prepare.simulationEvidence.providerWrites, 0)
  assert.equal(
    prepare.simulationEvidence.providerCredentialDecrypted,
    false,
  )
  assert.equal(prepare.simulationEvidence.providerNetworkCalls, 0)
  assertRedacted(prepare.redactedRequest)
  assert.equal(
    JSON.stringify(prepare.redactedRequest).includes(callback),
    false,
  )
}

{
  const mutation = {
    operation: 'update',
    id: serviceId,
    name: 'Pro Bakery Bites',
  }
  const { calls, deps } = dependencies()
  const result =
    await registration.executeShopifyCarrierServiceRegistration(
      command({
        mode: 'shadow',
        idempotencyKey: 'carrier-service-shadow-name-update-revision-12',
        mutation,
      }),
      deps,
    )
  assert.equal(result.effect.state, 'simulated')
  assert.equal(result.effect.providerWriteCount, 0)
  assert.deepEqual(calls.map(([name]) => name), ['prepare'])
  const redactedMutation = calls[0][1].redactedRequest.mutation
  assert.equal(
    JSON.stringify(redactedMutation),
    JSON.stringify({
      operation: 'update',
      carrierServiceId: serviceId,
      serviceName: 'Pro Bakery Bites',
    }),
    'Shadow name alignment must retain exact existing-GID/name-only evidence',
  )
}

for (const mutation of [
  {
    operation: 'create',
    name: 'ClawPilot checkout rates',
    callbackUrl: callback,
    active: true,
    supportsServiceDiscovery: false,
  },
  {
    operation: 'update',
    id: serviceId,
    callbackUrl: callback,
    active: true,
  },
  {
    operation: 'delete',
    id: serviceId,
  },
]) {
  const { calls, deps } = dependencies()
  const result =
    await registration.executeShopifyCarrierServiceRegistration(
      command({
        idempotencyKey: `carrier-service-${mutation.operation}-revision-12`,
        mutation,
      }),
      deps,
    )
  assert.equal(result.effect.state, 'succeeded')
  assert.equal(result.effect.providerWriteCount, 1)
  assert.equal(result.effect.providerReference, serviceId)
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      'prepare',
      'claim',
      'runtime',
      'decrypt',
      'token',
      mutation.operation,
      'finalize',
    ],
  )
  const claim = calls.find(([name]) => name === 'claim')[1]
  assert.equal(claim.globalId, 'gcef0000001')
  assert.equal(claim.limit, 1)
  const decrypt = calls.find(([name]) => name === 'decrypt')
  assert.equal(
    decrypt[1][4],
    'gid://shopify/Shop/987654321',
    'credential AAD must retain the immutable Shopify Shop GID',
  )
  const token = calls.find(([name]) => name === 'token')
  assert.equal(
    token[1].shopDomain,
    'ag-alchemy.myshopify.com',
    'token acquisition must use the configured canonical shop domain',
  )
  const finalize = calls.find(([name]) => name === 'finalize')[1]
  assert.equal(finalize.outcome, 'succeeded')
  assert.equal(finalize.providerWriteCount, 1)
  const serializedEvidence = JSON.stringify({
    request: calls[0][1].redactedRequest,
    result: finalize.redactedResult,
  })
  assert.equal(serializedEvidence.includes(callback), false)
  assertRedacted(JSON.parse(serializedEvidence))
}

{
  const { calls, deps } = dependencies({
    scopes: ['read_orders'],
  })
  await assert.rejects(
    () => registration.executeShopifyCarrierServiceRegistration(
      command({
        idempotencyKey: 'carrier-service-missing-scope',
      }),
      deps,
    ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code ===
        'SHOPIFY_CARRIER_SERVICE_WRITE_SHIPPING_SCOPE_REQUIRED'
      && error.effectGlobalId === 'gcef0000001',
  )
  assert.equal(
    calls.some(([name]) => name === 'create'),
    false,
  )
  const finalize = calls.find(([name]) => name === 'finalize')[1]
  assert.equal(finalize.outcome, 'failed')
  assert.equal(finalize.providerWriteCount, 0)
  assert.equal(
    finalize.redactedResult.providerMutationAttempted,
    false,
  )
}

{
  const { calls, deps } = dependencies({
    runtime: runtime({ credentialVersion: 8 }),
  })
  await assert.rejects(
    () => registration.executeShopifyCarrierServiceRegistration(
      command({
        idempotencyKey: 'carrier-service-stale-runtime',
      }),
      deps,
    ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code ===
        'SHOPIFY_CARRIER_SERVICE_REGISTRATION_RUNTIME_STALE',
  )
  assert.deepEqual(
    calls.map(([name]) => name),
    ['prepare', 'claim', 'runtime', 'finalize'],
  )
  const finalize = calls.at(-1)[1]
  assert.equal(finalize.outcome, 'failed')
  assert.equal(finalize.providerWriteCount, 0)
}

{
  const { calls, deps } = dependencies({
    runtime: runtime({ configuration: {} }),
  })
  await assert.rejects(
    () => registration.executeShopifyCarrierServiceRegistration(
      command({
        idempotencyKey: 'carrier-service-shop-domain-missing',
      }),
      deps,
    ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code === 'SHOPIFY_DOMAIN_INVALID',
  )
  assert.deepEqual(
    calls.map(([name]) => name),
    ['prepare', 'claim', 'runtime', 'decrypt', 'finalize'],
  )
  const finalize = calls.at(-1)[1]
  assert.equal(finalize.outcome, 'failed')
  assert.equal(finalize.providerWriteCount, 0)
  assertRedacted(finalize.redactedResult)
}

{
  const { calls, deps } = dependencies({
    providerError: new MockShopifyCommerceClientError(
      'provider response is intentionally not retained',
      503,
      'SHOPIFY_UNAVAILABLE',
      true,
    ),
  })
  await assert.rejects(
    () => registration.executeShopifyCarrierServiceRegistration(
      command({
        idempotencyKey: 'carrier-service-unknown-provider-outcome',
      }),
      deps,
    ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code === 'SHOPIFY_UNAVAILABLE'
      && error.retryable === true,
  )
  const finalize = calls.find(([name]) => name === 'finalize')[1]
  assert.equal(finalize.outcome, 'unknown')
  assert.equal(finalize.providerWriteCount, 0)
  assert.equal(
    finalize.redactedResult.providerMutationAttempted,
    true,
  )
  assert.equal(
    finalize.redactedResult.confirmedProviderWrites,
    0,
  )
}

{
  const { calls, deps } = dependencies({
    providerError: new MockShopifyCommerceClientError(
      'provider response is intentionally not retained',
      422,
      'SHOPIFY_CARRIER_SERVICE_CREATE_REJECTED',
      false,
    ),
  })
  await assert.rejects(
    () => registration.executeShopifyCarrierServiceRegistration(
      command({
        idempotencyKey: 'carrier-service-definitive-rejection',
      }),
      deps,
    ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code ===
        'SHOPIFY_CARRIER_SERVICE_CREATE_REJECTED'
      && error.retryable === false,
  )
  const finalize = calls.find(([name]) => name === 'finalize')[1]
  assert.equal(finalize.outcome, 'failed')
  assert.equal(finalize.providerWriteCount, 0)
  assert.equal(
    finalize.redactedResult.providerMutationAttempted,
    true,
  )
}

{
  const { calls, deps } = dependencies()
  const originalPrepare = deps.prepareExternalEffect
  deps.prepareExternalEffect = async (input) => ({
    ...(await originalPrepare(input)),
    state: 'succeeded',
    providerWriteCount: 1,
    providerReference: serviceId,
    completedAt: '2026-07-29T12:00:00.000Z',
  })
  const result =
    await registration.executeShopifyCarrierServiceRegistration(
      command({
        idempotencyKey: 'carrier-service-terminal-replay',
      }),
      deps,
    )
  assert.equal(result.replayed, true)
  assert.equal(result.effect.state, 'succeeded')
  assert.deepEqual(calls.map(([name]) => name), ['prepare'])
}

{
  const mutation = command().mutation
  const authorization = claimedAuthorization(mutation)
  const { calls, deps } = authorizedDependencies(authorization, {
    runtime: runtime({ status: 'disabled' }),
  })
  const result =
    await registration.executeAuthorizedShopifyCarrierServiceMutation(
      { authorization, mutation },
      deps,
    )
  assert.equal(result.operation, 'create')
  assert.equal(result.providerReference, serviceId)
  assert.equal(result.authorization.status, 'succeeded')
  assert.deepEqual(
    calls.map(([name]) => name),
    ['runtime', 'decrypt', 'token', 'create', 'authorized-finalize'],
    'the resource-scoped claim must permit a verified receipt-held connection before any credential or provider work',
  )
  const finalized = calls.at(-1)[1]
  assert.equal(finalized.outcome, 'succeeded')
  assert.equal(finalized.providerWriteCount, 1)
  assert.equal(finalized.attemptGlobalId, 'gscm0000001')
  assert.equal(
    finalized.leaseToken,
    '77777777-7777-4777-8777-777777777777',
  )
}

{
  const mutation = command().mutation
  const authorization = claimedAuthorization(mutation)
  const { calls, deps } = authorizedDependencies(authorization, {
    runtime: runtime({ status: 'error' }),
  })
  await assert.rejects(
    () =>
      registration.executeAuthorizedShopifyCarrierServiceMutation(
        { authorization, mutation },
        deps,
      ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code ===
        'SHOPIFY_CARRIER_SERVICE_AUTHORIZED_RUNTIME_STALE',
  )
  assert.deepEqual(
    calls.map(([name]) => name),
    ['runtime', 'authorized-finalize'],
    'an errored connection must fail before credential decryption or provider I/O',
  )
  assert.equal(calls.at(-1)[1].providerWriteCount, 0)
}

{
  const mutation = command().mutation
  const authorization = claimedAuthorization(mutation, {
    accountEnvironment: 'production',
  })
  const { calls, deps } = authorizedDependencies(authorization, {
    runtime: runtime({ environment: 'production' }),
  })
  const result =
    await registration.executeAuthorizedShopifyCarrierServiceMutation(
      { authorization, mutation },
      deps,
    )
  assert.equal(result.operation, 'create')
  assert.equal(result.providerReference, serviceId)
  assert.equal(result.authorization.status, 'succeeded')
  assert.deepEqual(
    calls.map(([name]) => name),
    ['runtime', 'decrypt', 'token', 'create', 'authorized-finalize'],
    'an exact resource-scoped production authorization may dispatch one confirmed CarrierService create',
  )
  assert.equal(calls.at(-1)[1].outcome, 'succeeded')
  assert.equal(calls.at(-1)[1].providerWriteCount, 1)
}

{
  const mutation = {
    operation: 'delete',
    id: serviceId,
  }
  const authorization = claimedAuthorization(mutation, {
    accountEnvironment: 'production',
  })
  const { calls, deps } = authorizedDependencies(authorization, {
    runtime: runtime({ environment: 'production' }),
  })
  const result =
    await registration.executeAuthorizedShopifyCarrierServiceMutation(
      { authorization, mutation },
      deps,
    )
  assert.equal(result.operation, 'delete')
  assert.equal(result.providerReference, serviceId)
  assert.deepEqual(
    calls.map(([name]) => name),
    ['runtime', 'decrypt', 'token', 'delete', 'authorized-finalize'],
    'exact production delete remains available for cleanup',
  )
}

{
  const mutation = {
    operation: 'update',
    id: serviceId,
    name: 'Pro Bakery Bites',
  }
  const authorization = claimedAuthorization(mutation, {
    accountEnvironment: 'production',
  })
  const priorService = {
    id: serviceId,
    name: 'Legacy checkout name',
    callbackUrl: 'https://dev.example.com/exact-existing-callback',
    active: false,
    supportsServiceDiscovery: true,
  }
  const { calls, deps } = authorizedDependencies(authorization, {
    runtime: runtime({ environment: 'production' }),
    queryResult: priorService,
  })
  let observedProviderResult = null
  deps.updateCarrierService = async (
    credential,
    providerInput,
    requestOptions,
  ) => {
    calls.push(['update', credential, providerInput, requestOptions])
    observedProviderResult = {
      ...priorService,
      name: providerInput.name,
    }
    return observedProviderResult
  }
  const result =
    await registration.executeAuthorizedShopifyCarrierServiceMutation(
      { authorization, mutation },
      deps,
    )
  assert.equal(result.operation, 'update')
  assert.equal(result.providerReference, serviceId)
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      'runtime',
      'decrypt',
      'token',
      'query',
      'update',
      'authorized-finalize',
    ],
    'the exact existing CarrierService must be queried and renamed in place',
  )
  const providerRead = calls.find(([name]) => name === 'query')
  assert.equal(providerRead[2], serviceId)
  const providerInput = calls.find(([name]) => name === 'update')[2]
  assert.equal(providerInput.id, serviceId)
  assert.equal(providerInput.name, 'Pro Bakery Bites')
  assert.equal(
    JSON.stringify(Object.keys(providerInput).sort()),
    JSON.stringify(['id', 'name']),
    'the provider update must contain only the exact existing GID and desired name',
  )
  assert.equal(
    observedProviderResult.callbackUrl,
    priorService.callbackUrl,
  )
  assert.equal(observedProviderResult.active, priorService.active)
  assert.equal(
    observedProviderResult.supportsServiceDiscovery,
    priorService.supportsServiceDiscovery,
  )
  const finalized = calls.at(-1)[1]
  assert.equal(finalized.outcome, 'succeeded')
  assert.equal(finalized.providerReference, serviceId)
  assert.equal(finalized.providerWriteCount, 1)
}

for (const mutation of [
  {
    operation: 'update',
    id: serviceId,
    callbackUrl: callback,
  },
  {
    operation: 'update',
    id: serviceId,
    active: false,
  },
  {
    operation: 'update',
    id: serviceId,
    supportsServiceDiscovery: true,
  },
  {
    operation: 'update',
    id: serviceId,
    name: 'Pro Bakery Bites',
    callbackUrl: callback,
  },
]) {
  const authorization = claimedAuthorization({
    operation: 'update',
    id: serviceId,
    name: 'Pro Bakery Bites',
  })
  const { calls, deps } = authorizedDependencies(authorization)
  await assert.rejects(
    () =>
      registration.executeAuthorizedShopifyCarrierServiceMutation(
        { authorization, mutation },
        deps,
      ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code ===
        'SHOPIFY_CARRIER_SERVICE_AUTHORIZATION_OPERATION_INVALID',
  )
  assert.deepEqual(
    calls,
    [],
    'callback, active, and discovery fields must be rejected before credential or provider work',
  )
}

{
  const mutation = command().mutation
  const authorization = claimedAuthorization(mutation)
  const { calls, deps } = authorizedDependencies(authorization, {
    runtime: runtime({ environment: 'production' }),
  })
  await assert.rejects(
    () =>
      registration.executeAuthorizedShopifyCarrierServiceMutation(
        { authorization, mutation },
        deps,
      ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code ===
        'SHOPIFY_CARRIER_SERVICE_AUTHORIZED_RUNTIME_STALE',
  )
  assert.deepEqual(
    calls.map(([name]) => name),
    ['runtime', 'authorized-finalize'],
    'authorization/runtime environment mismatch must fail before decrypt',
  )
  assert.equal(calls.at(-1)[1].providerWriteCount, 0)
}

{
  const mutation = {
    operation: 'update',
    id: serviceId,
    name: 'Pro Bakery Bites',
  }
  const authorization = claimedAuthorization(mutation)
  const { calls, deps } = authorizedDependencies(authorization)
  deps.updateCarrierService = async (
    credential,
    providerInput,
    requestOptions,
  ) => {
    calls.push(['update', credential, providerInput, requestOptions])
    return {
      id: serviceId,
      name: 'Different merchant name',
      callbackUrl: callback,
      active: true,
      supportsServiceDiscovery: false,
    }
  }
  await assert.rejects(
    () =>
      registration.executeAuthorizedShopifyCarrierServiceMutation(
        { authorization, mutation },
        deps,
      ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code ===
        'SHOPIFY_CARRIER_SERVICE_PROVIDER_RESPONSE_MISMATCH',
  )
  const finalized = calls.at(-1)[1]
  assert.equal(finalized.outcome, 'unknown')
  assert.equal(finalized.providerWriteCount, null)
  assert.equal(
    finalized.redactedResult.stage,
    'provider_response_verification',
  )
}

{
  const mutation = command().mutation
  const authorization = claimedAuthorization(mutation)
  const { calls, deps } = authorizedDependencies(authorization, {
    providerError: new MockShopifyCommerceClientError(
      'provider response is intentionally not retained',
      503,
      'SHOPIFY_UNAVAILABLE',
      true,
    ),
  })
  await assert.rejects(
    () =>
      registration.executeAuthorizedShopifyCarrierServiceMutation(
        { authorization, mutation },
        deps,
      ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code === 'SHOPIFY_UNAVAILABLE'
      && error.retryable === false,
  )
  assert.deepEqual(
    calls.map(([name]) => name),
    ['runtime', 'decrypt', 'token', 'create', 'authorized-finalize'],
  )
  const finalized = calls.at(-1)[1]
  assert.equal(finalized.outcome, 'unknown')
  assert.equal(finalized.providerWriteCount, null)
  assert.equal(
    finalized.redactedResult.confirmedProviderWrites,
    null,
    'unknown provider outcome must never claim zero writes',
  )
}

{
  const mutation = command().mutation
  const authorization = claimedAuthorization(mutation)
  const { calls, deps } = authorizedDependencies(authorization)
  deps.createCarrierService = async (
    credential,
    providerInput,
    requestOptions,
  ) => {
    calls.push(['create', credential, providerInput, requestOptions])
    return {
      id: serviceId,
      name: providerInput.name,
      callbackUrl: 'https://different.example.com/rates',
      active: providerInput.active,
      supportsServiceDiscovery:
        providerInput.supportsServiceDiscovery,
    }
  }
  await assert.rejects(
    () =>
      registration.executeAuthorizedShopifyCarrierServiceMutation(
        { authorization, mutation },
        deps,
      ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code ===
        'SHOPIFY_CARRIER_SERVICE_PROVIDER_RESPONSE_MISMATCH',
  )
  const finalized = calls.at(-1)[1]
  assert.equal(finalized.outcome, 'unknown')
  assert.equal(finalized.providerWriteCount, null)
  assert.equal(
    finalized.redactedResult.stage,
    'provider_response_verification',
  )
}

{
  const mutation = command().mutation
  const authorization = claimedAuthorization(mutation)
  const { calls, deps } = authorizedDependencies(authorization, {
    providerError: new MockShopifyCarrierServiceClientError(
      'Shopify returned malformed response evidence',
      502,
      'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
      [],
    ),
  })
  await assert.rejects(
    () =>
      registration.executeAuthorizedShopifyCarrierServiceMutation(
        { authorization, mutation },
        deps,
      ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code === 'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
  )
  const finalized = calls.at(-1)[1]
  assert.equal(finalized.outcome, 'unknown')
  assert.equal(finalized.providerWriteCount, null)
}

{
  const mutation = command().mutation
  const authorization = claimedAuthorization(mutation)
  const { calls, deps } = authorizedDependencies(authorization, {
    providerError: new MockShopifyCarrierServiceClientError(
      'Shopify rejected the exact create',
      422,
      'SHOPIFY_CARRIER_SERVICE_CREATE_REJECTED',
      [{ field: ['input', 'name'], message: 'Name is in use' }],
    ),
  })
  await assert.rejects(
    () =>
      registration.executeAuthorizedShopifyCarrierServiceMutation(
        { authorization, mutation },
        deps,
      ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code === 'SHOPIFY_CARRIER_SERVICE_CREATE_REJECTED',
  )
  const finalized = calls.at(-1)[1]
  assert.equal(finalized.outcome, 'failed')
  assert.equal(finalized.providerWriteCount, 0)
}

{
  const mutation = command().mutation
  const authorization = claimedAuthorization(mutation, {
    status: 'unknown',
    reconciliationRequired: true,
    outcome: {
      globalId: 'gsco0000001',
      state: 'unknown',
      providerReference: null,
      providerWriteCount: null,
    },
  })
  const { calls, deps } = authorizedDependencies(authorization)
  const verified =
    await registration
      .verifyShopifyCarrierServiceMutationForReconciliation(
        {
          authorization,
          mutation,
        },
        deps,
      )
  assert.equal(verified.disposition, 'confirmed_applied')
  assert.equal(verified.providerReference, serviceId)
  assert.equal(
    JSON.stringify(verified.resolutionEvidence).includes(callback),
    false,
  )
  assert.deepEqual(
    calls.map(([name]) => name),
    ['runtime', 'decrypt', 'token', 'list'],
  )
}

{
  const mutation = command().mutation
  const authorization = claimedAuthorization(mutation, {
    status: 'unknown',
    reconciliationRequired: true,
    outcome: {
      globalId: 'gsco0000001',
      state: 'unknown',
      providerReference: null,
      providerWriteCount: null,
    },
  })
  const absent = authorizedDependencies(authorization, {
    listResult: [],
  })
  const notApplied =
    await registration
      .verifyShopifyCarrierServiceMutationForReconciliation(
        { authorization, mutation },
        absent.deps,
      )
  assert.equal(notApplied.disposition, 'confirmed_not_applied')
  assert.equal(notApplied.providerReference, null)
  assert.equal(
    notApplied.resolutionEvidence.completeEnumeration,
    true,
  )
  assert.equal(notApplied.resolutionEvidence.exactMatchCount, 0)

  const duplicate = authorizedDependencies(authorization, {
    listResult: [
      {
        id: serviceId,
        name: mutation.name,
        callbackUrl: mutation.callbackUrl,
        active: mutation.active,
        supportsServiceDiscovery: mutation.supportsServiceDiscovery,
      },
      {
        id: 'gid://shopify/DeliveryCarrierService/987654321',
        name: mutation.name,
        callbackUrl: mutation.callbackUrl,
        active: mutation.active,
        supportsServiceDiscovery: mutation.supportsServiceDiscovery,
      },
    ],
  })
  await assert.rejects(
    () =>
      registration
        .verifyShopifyCarrierServiceMutationForReconciliation(
          { authorization, mutation },
          duplicate.deps,
        ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code
        === 'SHOPIFY_CARRIER_SERVICE_RECONCILIATION_AMBIGUOUS',
  )
}

{
  const mutation = {
    operation: 'update',
    id: serviceId,
    name: 'Pro Bakery Bites',
  }
  const authorization = claimedAuthorization(mutation, {
    status: 'unknown',
    reconciliationRequired: true,
    outcome: {
      globalId: 'gsco0000001',
      state: 'unknown',
      providerReference: null,
      providerWriteCount: null,
    },
  })
  const exact = authorizedDependencies(authorization, {
    queryResult: {
      id: serviceId,
      name: mutation.name,
      callbackUrl: callback,
      active: true,
      supportsServiceDiscovery: false,
    },
  })
  const applied =
    await registration
      .verifyShopifyCarrierServiceMutationForReconciliation(
        { authorization, mutation },
        exact.deps,
      )
  assert.equal(applied.disposition, 'confirmed_applied')
  assert.equal(applied.providerReference, serviceId)
  assert.deepEqual(
    exact.calls.map(([name]) => name),
    ['runtime', 'decrypt', 'token', 'query'],
  )

  const mismatch = authorizedDependencies(authorization, {
    queryResult: {
      id: serviceId,
      name: 'Different merchant name',
      callbackUrl: callback,
      active: true,
      supportsServiceDiscovery: false,
    },
  })
  await assert.rejects(
    () =>
      registration
        .verifyShopifyCarrierServiceMutationForReconciliation(
          { authorization, mutation },
          mismatch.deps,
        ),
    (error) =>
      error
        instanceof registration.ShopifyCarrierServiceRegistrationError
      && error.code ===
        'SHOPIFY_CARRIER_SERVICE_RECONCILIATION_INCONCLUSIVE'
      && error.retryable === false,
  )
}

{
  const mutation = { operation: 'delete', id: serviceId }
  const authorization = claimedAuthorization(mutation, {
    status: 'unknown',
    reconciliationRequired: true,
    outcome: {
      globalId: 'gsco0000001',
      state: 'unknown',
      providerReference: null,
      providerWriteCount: null,
    },
  })
  const absent = authorizedDependencies(authorization, {
    queryResult: null,
  })
  const applied =
    await registration
      .verifyShopifyCarrierServiceMutationForReconciliation(
        { authorization, mutation },
        absent.deps,
      )
  assert.equal(applied.disposition, 'confirmed_applied')
  assert.equal(applied.providerReference, serviceId)

  const present = authorizedDependencies(authorization, {
    queryResult: {
      id: serviceId,
      name: 'Existing service',
      callbackUrl: callback,
      active: true,
      supportsServiceDiscovery: false,
    },
  })
  const notApplied =
    await registration
      .verifyShopifyCarrierServiceMutationForReconciliation(
        { authorization, mutation },
        present.deps,
      )
  assert.equal(notApplied.disposition, 'confirmed_not_applied')
  assert.equal(notApplied.providerReference, null)
}

console.log('Shopify CarrierService registration executor tests passed')
