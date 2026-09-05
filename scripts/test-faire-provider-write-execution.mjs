#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function loadExecutionModule() {
  const path =
    'app_src/lib/integrations/faireProviderWriteExecution.ts'
  const source = readFileSync(resolve(root, path), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const loadedModule = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Boolean,
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
    exports: loadedModule.exports,
    module: loadedModule,
    process,
    require(specifier) {
      if (specifier === '@/lib/integrations/integrationCredentialRuntimeGate.mjs') {
        return integrationCredentialRuntimeGate
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return loadedModule.exports
}

const execution = loadExecutionModule()
const {
  FAIRE_PROVIDER_WRITE_ACTION,
  FAIRE_PROVIDER_WRITE_ADAPTER_VERSION,
  FAIRE_PROVIDER_WRITE_LEASE_SECONDS,
  executeFaireProviderWrite,
  hashFaireProviderWriteEvidence,
} = execution

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

assert.equal(
  FAIRE_PROVIDER_WRITE_ACTION,
  'faire.product.draft.create',
)
assert.equal(
  FAIRE_PROVIDER_WRITE_ADAPTER_VERSION,
  'faire-v2-product-draft-create-v1',
)
assert.equal(FAIRE_PROVIDER_WRITE_LEASE_SECONDS, 120)

const organizationId = '11111111-1111-4111-8111-111111111111'
const authorizationGlobalId = 'gfwa0123456789ab'
const authorizationFenceHash = 'a'.repeat(64)
const now = new Date('2026-08-01T22:00:00.000Z')
const draft = {
  idempotenceToken: 'cp-test-product-0001',
  name: 'ClawPilot Faire E2E Test Product',
  description: 'Non-saleable draft product for controlled integration testing.',
  shortDescription: 'Controlled integration test draft.',
  variants: [
    {
      idempotenceToken: 'cp-test-variant-0001',
      name: 'Test Case',
      sku: 'CLAWPILOT-FAIRE-E2E-001',
      prices: [
        {
          wholesalePrice: { amountMinor: 100, currency: 'USD' },
          retailPrice: { amountMinor: 200, currency: 'USD' },
          geoConstraint: { country: 'US' },
        },
      ],
      options: [{ name: 'Size', value: 'Test Case' }],
      tariffCode: 'TEST0001',
      orderabilityType: 'IMMEDIATE',
    },
  ],
  unitMultiplier: 1,
  minimumOrderQuantity: 1,
  allowSalesWhenOutOfStock: false,
  variantOptionSets: [{ name: 'Size', values: ['Test Case'] }],
  madeInCountry: 'US',
}
const redactedRequest = {
  operation: 'productDraftCreate',
  draft,
}

function baseClaim(overrides = {}) {
  return {
    organizationId,
    authorizationId: '22222222-2222-4222-8222-222222222222',
    authorizationGlobalId,
    authorizationRevision: 1,
    authorizationFenceHash,
    scopeEvidenceGlobalId: 'gfse0123456789ab',
    scopeEvidenceHash: 'd'.repeat(64),
    scopeVerificationSource: 'oauth_grant',
    verifiedWriteScopes: ['WRITE_PRODUCTS'],
    capabilities: ['product_draft_create'],
    authorizedBy: 'operator@example.com',
    authorizedRole: 'admin',
    authorizedAt: '2026-08-01T21:55:00.000Z',
    expiresAt: '2026-08-01T22:05:00.000Z',
    consumedAt: '2026-08-01T21:59:59.900Z',
    consumedBy: 'operator@example.com',
    effectId: '33333333-3333-4333-8333-333333333333',
    effectGlobalId: 'gcef0123456789ab',
    integrationAccountId: '44444444-4444-4444-8444-444444444444',
    accountGlobalId: 'gia0123456789ab',
    externalAccountId: 'b_test_brand',
    credentialGeneration: 7,
    activationRevision: 3,
    action: FAIRE_PROVIDER_WRITE_ACTION,
    aggregateType: 'faire_product_draft',
    aggregateId: 'gp0123456789ab',
    aggregateRevision: 1,
    aggregateHash: 'b'.repeat(64),
    idempotencyKey: 'faire-product-draft-gp0123456789ab-r1',
    requestHash: hashFaireProviderWriteEvidence(redactedRequest),
    redactedRequest,
    state: 'consumed',
    effectState: 'claimed',
    providerAttemptId: '55555555-5555-4555-8555-555555555555',
    providerAttemptGlobalId: 'gxa0123456789ab',
    attemptNumber: 1,
    leaseToken: '66666666-6666-4666-8666-666666666666',
    leaseExpiresAt: '2026-08-01T22:02:00.000Z',
    claimedBy: 'faire-provider-write-test',
    claimedAt: '2026-08-01T22:00:00.000Z',
    ...overrides,
  }
}

function executionInput(overrides = {}) {
  return {
    organizationId,
    authorizationGlobalId,
    expectedAuthorizationFenceHash: authorizationFenceHash,
    workerId: 'faire-provider-write-test',
    ...overrides,
  }
}

function runtime(overrides = {}) {
  return {
    organizationId,
    integrationAccountId: '44444444-4444-4444-8444-444444444444',
    globalId: 'gia0123456789ab',
    provider: 'faire',
    environment: 'production',
    externalAccountId: 'b_test_brand',
    status: 'active',
    verificationStatus: 'verified',
    credentialVersion: 7,
    authMode: 'faire_brand_token',
    configuration: {},
    encrypted: {
      ciphertext: Buffer.from('encrypted'),
      iv: Buffer.alloc(12),
      tag: Buffer.alloc(16),
    },
    ...overrides,
  }
}

function providerProduct(overrides = {}) {
  return {
    id: 'p_clawpilot_test_001',
    lifecycle_state: 'DRAFT',
    name: draft.name,
    variants: [{ id: 'pv_test_001', sku: draft.variants[0].sku }],
    ...overrides,
  }
}

function harness(options = {}) {
  const calls = {
    events: [],
    claim: [],
    resolveCredential: [],
    createClient: [],
    dispatch: [],
    finalize: [],
  }
  let claimable = options.claimable !== false
  const currentClaim = options.claim || baseClaim()
  const dependencies = {
    now: () => now,
    async claimProviderWrite(input) {
      calls.events.push('claim')
      calls.claim.push(input)
      if (!claimable) return null
      claimable = false
      if (options.claimError) throw options.claimError
      return currentClaim
    },
    async resolveCredential(claim) {
      calls.events.push('credential')
      calls.resolveCredential.push(claim)
      if (options.credentialError) throw options.credentialError
      return options.resolvedCredential || {
        runtime: runtime(),
        credential: {
          provider: 'faire',
          authMode: 'faire_brand_token',
          accessToken: 'private-faire-access-token',
        },
      }
    },
    createClient(clientOptions) {
      calls.events.push('client')
      calls.createClient.push(clientOptions)
      if (options.clientError) throw options.clientError
      return {
        async createDraftProduct(input) {
          calls.events.push('dispatch')
          calls.dispatch.push(input)
          if (options.dispatchError) throw options.dispatchError
          return options.providerResult || providerProduct()
        },
      }
    },
    async finalizeExternalEffect(input) {
      calls.events.push('finalize')
      calls.finalize.push(input)
      if (options.finalizeError) throw options.finalizeError
      return { state: input.outcome }
    },
  }
  return { calls, dependencies }
}

// Happy path: the durable claim is first, credentials are second, and the
// client receives only authority derived from that claim.
{
  const test = harness()
  const result = await executeFaireProviderWrite(
    executionInput(),
    test.dependencies,
  )
  assert.deepEqual(test.calls.events, [
    'claim',
    'credential',
    'client',
    'dispatch',
    'finalize',
  ])
  assert.deepEqual(plain(test.calls.claim[0]), {
    ...executionInput(),
    adapterVersion: FAIRE_PROVIDER_WRITE_ADAPTER_VERSION,
    leaseSeconds: FAIRE_PROVIDER_WRITE_LEASE_SECONDS,
  })
  assert.equal(test.calls.resolveCredential[0].effectGlobalId, 'gcef0123456789ab')
  assert.deepEqual(plain(test.calls.dispatch[0]), draft)
  assert.deepEqual(plain(test.calls.createClient[0].credentialBinding), {
    provider: 'faire',
    environment: 'production',
    accountGlobalId: 'gia0123456789ab',
    externalAccountId: 'b_test_brand',
    credentialVersion: 7,
    connectionStatus: 'active',
    verificationStatus: 'verified',
  })
  assert.deepEqual(plain(test.calls.createClient[0].writeAuthorization), {
    provider: 'faire',
    environment: 'production',
    accountGlobalId: 'gia0123456789ab',
    externalAccountId: 'b_test_brand',
    credentialVersion: 7,
    authorizationRevision: 1,
    capabilities: ['product_draft_create'],
    verifiedWriteScopes: ['WRITE_PRODUCTS'],
    scopeVerificationSource: 'oauth_grant',
  })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.providerReference, 'p_clawpilot_test_001')
  assert.equal(result.providerWriteCount, 1)
  assert.equal(test.calls.finalize[0].outcome, 'succeeded')
  assert.equal(test.calls.finalize[0].providerWriteCount, 1)
  assert.equal(
    JSON.stringify(test.calls.finalize[0]).includes(
      'private-faire-access-token',
    ),
    false,
  )
}

// Inline authorization, product content, or credential material is rejected
// before even asking persistence for a claim.
for (const forbidden of [
  { authorization: { verifiedWriteScopes: ['WRITE_PRODUCTS'] } },
  { draft },
  { accessToken: 'forged-access-token' },
]) {
  const test = harness()
  await assert.rejects(
    executeFaireProviderWrite(
      { ...executionInput(), ...forbidden },
      test.dependencies,
    ),
    (error) => error.code === 'FAIRE_PROVIDER_WRITE_INPUT_INVALID',
  )
  assert.equal(test.calls.claim.length, 0)
  assert.equal(test.calls.resolveCredential.length, 0)
  assert.equal(test.calls.dispatch.length, 0)
  assert.equal(test.calls.finalize.length, 0)
}

// A missing/consumed claim never touches credentials or the provider.
{
  const test = harness({ claimable: false })
  await assert.rejects(
    executeFaireProviderWrite(executionInput(), test.dependencies),
    (error) => error.code === 'FAIRE_PROVIDER_WRITE_NOT_CLAIMABLE'
      && error.retryable === false,
  )
  assert.deepEqual(test.calls.events, ['claim'])
}

// Every failure after a valid durable claim but before dispatch is finalized
// as known zero-write evidence.
const unauthorizedImageRequest = {
  ...redactedRequest,
  draft: { ...draft, images: [{ url: 'https://example.com/test.png' }] },
}
const forbiddenDurableSecret = 'durable-secret-must-never-leak'
const forbiddenSecretRequests = [
  { clientSecret: forbiddenDurableSecret },
  { applicationSecret: forbiddenDurableSecret },
  { 'x-faire-access-token': forbiddenDurableSecret },
  { 'x-faire-oauth-access-token': forbiddenDurableSecret },
  { 'x-faire-app-credentials': forbiddenDurableSecret },
].map((secret) => ({
  ...redactedRequest,
  draft: { ...draft, ...secret },
}))
for (const scenario of [
  {
    claim: baseClaim({ action: 'faire.inventory.update' }),
    expectedCode: 'FAIRE_PROVIDER_WRITE_CLAIM_MISMATCH',
  },
  {
    claim: baseClaim({ capabilities: [] }),
    expectedCode: 'FAIRE_PROVIDER_WRITE_AUTHORITY_MISMATCH',
  },
  {
    claim: baseClaim({
      verifiedWriteScopes: ['WRITE_PRODUCTS', 'WRITE_INVENTORIES'],
    }),
    expectedCode: 'FAIRE_PROVIDER_WRITE_AUTHORITY_MISMATCH',
  },
  {
    claim: baseClaim({ scopeVerificationSource: 'provider_confirmation' }),
    expectedCode: 'FAIRE_PROVIDER_WRITE_AUTHORITY_MISMATCH',
  },
  {
    claim: baseClaim({ requestHash: 'c'.repeat(64) }),
    expectedCode: 'FAIRE_PROVIDER_WRITE_REQUEST_HASH_MISMATCH',
  },
  ...forbiddenSecretRequests.map((forbiddenSecretRequest) => ({
    claim: baseClaim({
      redactedRequest: forbiddenSecretRequest,
      requestHash: hashFaireProviderWriteEvidence(forbiddenSecretRequest),
    }),
    expectedCode: 'FAIRE_PROVIDER_WRITE_CLAIM_NOT_REDACTED',
    forbiddenTerminalValue: forbiddenDurableSecret,
  })),
  {
    claim: baseClaim({
      redactedRequest: unauthorizedImageRequest,
      requestHash: hashFaireProviderWriteEvidence(unauthorizedImageRequest),
    }),
    expectedCode: 'FAIRE_PROVIDER_WRITE_INPUT_INVALID',
  },
]) {
  const test = harness({ claim: scenario.claim })
  const result = await executeFaireProviderWrite(
    executionInput(),
    test.dependencies,
  )
  assert.equal(result.outcome, 'failed')
  assert.equal(result.providerWriteCount, 0)
  assert.equal(result.errorCode, scenario.expectedCode)
  assert.equal(test.calls.resolveCredential.length, 0)
  assert.equal(test.calls.createClient.length, 0)
  assert.equal(test.calls.dispatch.length, 0)
  assert.equal(test.calls.finalize.length, 1)
  assert.equal(test.calls.finalize[0].outcome, 'failed')
  assert.equal(test.calls.finalize[0].providerWriteCount, 0)
  assert.equal(
    test.calls.finalize[0].redactedResult.providerWritesKnown,
    true,
  )
  assert.equal(
    test.calls.finalize[0].redactedResult.providerDispatchAttempted,
    false,
  )
  if (scenario.forbiddenTerminalValue) {
    assert.equal(
      JSON.stringify(test.calls.finalize[0]).includes(
        scenario.forbiddenTerminalValue,
      ),
      false,
    )
  }
}

{
  const credentialError = Object.assign(
    new Error('credential unavailable'),
    { code: 'FAIRE_CREDENTIAL_DECRYPT_FAILED' },
  )
  const test = harness({ credentialError })
  const result = await executeFaireProviderWrite(
    executionInput(),
    test.dependencies,
  )
  assert.equal(result.outcome, 'failed')
  assert.equal(result.providerWriteCount, 0)
  assert.deepEqual(test.calls.events, ['claim', 'credential', 'finalize'])
  assert.equal(test.calls.finalize[0].redactedResult.providerWritesKnown, true)
}

// A credential resolved after the claim still cannot cross the durable account
// or credential-generation fence. Both cases terminate as known zero-write.
for (const runtimeOverride of [
  { globalId: 'gia0123456789ac' },
  { credentialVersion: 8 },
]) {
  const test = harness({
    resolvedCredential: {
      runtime: runtime(runtimeOverride),
      credential: {
        provider: 'faire',
        authMode: 'faire_brand_token',
        accessToken: 'private-faire-access-token',
      },
    },
  })
  const result = await executeFaireProviderWrite(
    executionInput(),
    test.dependencies,
  )
  assert.equal(result.outcome, 'failed')
  assert.equal(result.errorCode, 'FAIRE_PROVIDER_WRITE_CREDENTIAL_STALE')
  assert.equal(result.providerWriteCount, 0)
  assert.deepEqual(test.calls.events, ['claim', 'credential', 'finalize'])
  assert.equal(test.calls.createClient.length, 0)
  assert.equal(test.calls.dispatch.length, 0)
  assert.equal(test.calls.finalize.length, 1)
  assert.equal(test.calls.finalize[0].outcome, 'failed')
  assert.equal(test.calls.finalize[0].providerWriteCount, 0)
  assert.equal(
    test.calls.finalize[0].redactedResult.providerWritesKnown,
    true,
  )
  assert.equal(
    test.calls.finalize[0].redactedResult.providerDispatchAttempted,
    false,
  )
}

// An explicit provider rejection is a terminal known zero-write result.
{
  const dispatchError = {
    code: 'FAIRE_REQUEST_REJECTED',
    providerWriteAccepted: false,
    retryable: false,
  }
  const test = harness({ dispatchError })
  const result = await executeFaireProviderWrite(
    executionInput(),
    test.dependencies,
  )
  assert.equal(result.outcome, 'failed')
  assert.equal(result.providerWriteCount, 0)
  assert.equal(test.calls.finalize[0].outcome, 'failed')
  assert.equal(test.calls.finalize[0].redactedResult.providerWritesKnown, true)
  assert.equal(
    test.calls.finalize[0].redactedResult.providerDispatchAttempted,
    true,
  )
}

// A provider status code without a stage-aware zero-write signal remains
// unknown: the production client also performs readback after the product
// POST, so the same access/rejection code can arrive after a successful write.
{
  const dispatchError = {
    code: 'FAIRE_ACCESS_DENIED',
    retryable: false,
  }
  const test = harness({ dispatchError })
  const result = await executeFaireProviderWrite(
    executionInput(),
    test.dependencies,
  )
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.providerWriteCount, 0)
  assert.equal(test.calls.finalize[0].outcome, 'unknown')
  assert.equal(test.calls.finalize[0].redactedResult.providerWritesKnown, false)
  assert.equal(
    test.calls.finalize[0].redactedResult.providerDispatchAttempted,
    true,
  )
}

// A timeout after the dispatch boundary is terminal unknown. The consumed
// one-shot claim makes a second invocation unable to dispatch again.
{
  const dispatchError = Object.assign(new Error('timeout'), {
    code: 'FAIRE_REQUEST_TIMEOUT',
    retryable: true,
  })
  const test = harness({ dispatchError })
  const first = await executeFaireProviderWrite(
    executionInput(),
    test.dependencies,
  )
  assert.equal(first.outcome, 'unknown')
  assert.equal(first.providerWriteCount, 0)
  assert.equal(test.calls.finalize[0].outcome, 'unknown')
  assert.equal(test.calls.finalize[0].providerWriteCount, 0)
  assert.equal(test.calls.finalize[0].redactedResult.providerWritesKnown, false)
  assert.equal(test.calls.dispatch.length, 1)
  await assert.rejects(
    executeFaireProviderWrite(executionInput(), test.dependencies),
    (error) => error.code === 'FAIRE_PROVIDER_WRITE_NOT_CLAIMABLE',
  )
  assert.equal(test.calls.dispatch.length, 1)
}

// A post-dispatch readback mismatch is also unknown: the product may already
// exist even though the response cannot prove its exact identity.
{
  const test = harness({
    providerResult: providerProduct({ lifecycle_state: 'ACTIVE' }),
  })
  const result = await executeFaireProviderWrite(
    executionInput(),
    test.dependencies,
  )
  assert.equal(result.outcome, 'unknown')
  assert.equal(
    result.errorCode,
    'FAIRE_PROVIDER_WRITE_READBACK_MISMATCH',
  )
  assert.equal(test.calls.finalize[0].outcome, 'unknown')
}

// Even if terminal persistence fails after dispatch, the authorization was
// already consumed. The surfaced error is non-retryable and a second call does
// not write again.
{
  const test = harness({ finalizeError: new Error('database unavailable') })
  await assert.rejects(
    executeFaireProviderWrite(executionInput(), test.dependencies),
    (error) => error.code === 'FAIRE_PROVIDER_WRITE_FINALIZE_FAILED'
      && error.retryable === false,
  )
  assert.equal(test.calls.dispatch.length, 1)
  await assert.rejects(
    executeFaireProviderWrite(executionInput(), test.dependencies),
    (error) => error.code === 'FAIRE_PROVIDER_WRITE_NOT_CLAIMABLE',
  )
  assert.equal(test.calls.dispatch.length, 1)
}

console.log(
  'Faire provider-write execution contract passed '
  + '(durable one-shot claim, no request-body authority, credential-after-claim, '
  + 'zero-write pre-dispatch failures, terminal unknown ambiguity, and no replay).',
)
