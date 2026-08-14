#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}) {
  const result = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const diagnostics = (result.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.equal(diagnostics.length, 0, `${path} must transpile without errors`)
  const loaded = { exports: {} }
  vm.runInNewContext(result.outputText, {
    AbortController,
    Array,
    BigInt,
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
    exports: loaded.exports,
    module: loaded,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
    setTimeout,
    structuredClone,
  }, { filename: path })
  return loaded.exports
}

const tests = []
function test(name, callback) {
  tests.push({ name, callback })
}

const organizationId = '11111111-1111-4111-8111-111111111111'
const integrationAccountId = '22222222-2222-4222-8222-222222222222'
const accountGlobalId = 'gia1234567'
const externalAccountId = 'gid://shopify/Shop/987654321'
const externalOrderId = 'gid://shopify/Order/123456789'
const sourceHashA = 'a'.repeat(64)
const sourceHashB = 'b'.repeat(64)

const priorEncryptionKey = process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY =
  'order-revision-integrity-test-key-with-at-least-32-bytes'

const evidence = loadTypeScriptModule(
  'app_src/lib/integrations/commerceOrderRevisionEvidence.ts',
)
const credentialCrypto = loadTypeScriptModule(
  'app_src/lib/integrations/commerceCredentialCrypto.ts',
  {
    '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs': await import(
      '../app_src/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'
    ),
    '@/lib/globalIds.mjs': {
      normalizeGlobalId(value, prefix) {
        const normalized = String(value || '').trim().toLowerCase()
        return normalized.startsWith(prefix) ? normalized : null
      },
    },
    '@/lib/persistence/config': {
      isHostedRuntime: () => false,
    },
  },
)

const available = (value) => ({ state: 'available', value })
const partyField = available({
  role: 'customer',
  partyType: 'person',
  externalIdentity: available('customer-123'),
  organizationName: available('AG Alchemy'),
  contactName: available('Private Customer'),
  email: available('private@example.com'),
  phone: available('+1 555 0100'),
})
const shipToField = (line1) => available({
  name: available('Private Customer'),
  organizationName: available('AG Alchemy'),
  line1: available(line1),
  line2: { state: 'unavailable', value: null },
  city: available('Asheville'),
  region: available('North Carolina'),
  regionCode: available('NC'),
  postalCode: available('28801'),
  country: available('United States'),
  countryCode: available('US'),
  phone: available('+1 555 0100'),
})

function protectedPlaintext(field, kind) {
  const value = evidence.commerceOrderRevisionProtectedPlaintext(field, kind)
  assert.ok(value, `${kind} protected plaintext must be available`)
  return value
}

function contentFingerprint(value, kind) {
  return credentialCrypto.commerceCandidateSnapshotContentFingerprint(
    value,
    organizationId,
    accountGlobalId,
    externalOrderId,
    kind,
  )
}

function encryptedSnapshot(value, sourceHash, kind) {
  return credentialCrypto.encryptCommerceCandidateSnapshot(
    value,
    organizationId,
    accountGlobalId,
    externalOrderId,
    sourceHash,
    kind,
  )
}

function decryptSnapshot(fields, sourceHash, kind) {
  return credentialCrypto.decryptCommerceCandidateSnapshot(
    fields,
    organizationId,
    accountGlobalId,
    externalOrderId,
    sourceHash,
    kind,
  )
}

test('protected PII content HMAC is stable across unrelated order revisions', () => {
  const party = protectedPlaintext(partyField, 'party')
  const fingerprint = contentFingerprint(party, 'party')
  const encryptedA = encryptedSnapshot(party, sourceHashA, 'party')
  const encryptedB = encryptedSnapshot(party, sourceHashB, 'party')

  assert.equal(contentFingerprint(party, 'party'), fingerprint)
  assert.notEqual(
    encryptedA.hash,
    encryptedB.hash,
    'Ciphertext evidence remains bound to the whole-order source hash',
  )
  assert.equal(
    contentFingerprint(decryptSnapshot(encryptedA, sourceHashA, 'party'), 'party'),
    fingerprint,
  )
  assert.equal(
    contentFingerprint(decryptSnapshot(encryptedB, sourceHashB, 'party'), 'party'),
    fingerprint,
  )
})

test('address-only revision changes only the ship-to content HMAC', () => {
  const party = protectedPlaintext(partyField, 'party')
  const originalShipTo = protectedPlaintext(shipToField('100 First Street'), 'ship_to')
  const revisedShipTo = protectedPlaintext(shipToField('200 Second Street'), 'ship_to')

  const partyBefore = contentFingerprint(party, 'party')
  const partyAfter = contentFingerprint(party, 'party')
  assert.equal(partyAfter, partyBefore)
  assert.notEqual(
    contentFingerprint(revisedShipTo, 'ship_to'),
    contentFingerprint(originalShipTo, 'ship_to'),
  )
})

test('protected PII decrypt-and-rehash detects ciphertext, tag, and AAD tampering', () => {
  const party = protectedPlaintext(partyField, 'party')
  const encrypted = encryptedSnapshot(party, sourceHashA, 'party')
  const expectedFingerprint = contentFingerprint(party, 'party')
  const decrypted = decryptSnapshot(encrypted, sourceHashA, 'party')
  assert.equal(contentFingerprint(decrypted, 'party'), expectedFingerprint)

  const tamperedCiphertext = Buffer.from(encrypted.ciphertext)
  tamperedCiphertext[0] ^= 0x01
  assert.throws(
    () => decryptSnapshot({ ...encrypted, ciphertext: tamperedCiphertext }, sourceHashA, 'party'),
    /could not be decrypted/u,
  )

  const tamperedTag = Buffer.from(encrypted.tag)
  tamperedTag[0] ^= 0x01
  assert.throws(
    () => decryptSnapshot({ ...encrypted, tag: tamperedTag }, sourceHashA, 'party'),
    /could not be decrypted/u,
  )
  assert.throws(
    () => decryptSnapshot(encrypted, sourceHashB, 'party'),
    /could not be decrypted/u,
  )
  assert.throws(
    () => decryptSnapshot(encrypted, sourceHashA, 'ship_to'),
    /could not be decrypted/u,
  )
})

class CommerceIntegrationRequestError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'CommerceIntegrationRequestError'
    this.status = status
    this.code = code
  }
}

function connection(nodes, hasNextPage = false, endCursor = null) {
  return {
    nodes,
    pageInfo: { hasNextPage, endCursor },
  }
}

function lines(prefix, count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `gid://shopify/LineItem/${prefix}-${index + offset}`,
  }))
}

function exactOrder(lineItems, updatedAt = '2026-08-12T16:00:00.000Z') {
  return {
    id: externalOrderId,
    updatedAt,
    test: false,
    lineItems,
  }
}

function createShopifyExactReadHarness(responses) {
  const graphqlResponses = [...responses]
  const graphqlCalls = []
  let probeCalls = 0
  const runtime = {
    organizationId,
    integrationAccountId,
    globalId: accountGlobalId,
    provider: 'shopify',
    environment: 'sandbox',
    externalAccountId,
    status: 'active',
    verificationStatus: 'verified',
    credentialVersion: 7,
    authMode: 'shopify_client_credentials',
    configuration: { shopDomain: 'ag-alchemy.myshopify.com' },
    encrypted: {},
  }
  const module = loadTypeScriptModule(
    'app_src/lib/integrations/commerceIntake.ts',
    {
      '@/lib/integrations/commerceCredentialCrypto': {
        decryptCommerceCredential: () => ({
          provider: 'shopify',
          authMode: 'shopify_client_credentials',
          clientId: 'client-id',
          clientSecret: 'client-secret-value',
        }),
        normalizeCommerceAccountGlobalId: (value) => String(value),
        normalizeCommerceOrganizationId: (value) => String(value),
      },
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError,
        sanitizedCommerceIntegrationError: () => ({
          code: 'SANITIZED',
          message: 'sanitized',
        }),
      },
      '@/lib/integrations/commerceCapabilities': {
        hasEffectiveShopifyScope: (scopes, scope) => scopes.includes(scope),
      },
      '@/lib/integrations/commerceReadRuntime': {
        commerceReadCredentialEligible: () => true,
        commerceReadRuntimeAvailable: () => true,
        commerceReadRuntimeMode: () => 'development',
      },
      '@/lib/integrations/faireCommerceClient': {},
      '@/lib/integrations/faireCommerceNormalizer': {
        FAIRE_COMMERCE_NORMALIZER_VERSION: 'test-faire-normalizer',
      },
      '@/lib/integrations/shopifyCommerceNormalizer': {
        SHOPIFY_COMMERCE_NORMALIZER_VERSION: 'test-shopify-normalizer',
        normalizeShopifyCommerce: ({ data }) => ({
          products: [],
          orders: data.orders.nodes.map((order) => ({
            identity: {
              provider: 'shopify',
              resourceType: 'order',
              value: order.id,
            },
            canonicalStates: {
              lifecycle: 'open',
              fulfillment: 'unfulfilled',
            },
            lines: order.lineItems.nodes.map((line) => ({ id: line.id })),
          })),
          rejections: [],
        }),
      },
      '@/lib/integrations/commerceFaireAutomaticPromotion': {
        AUTOMATIC_FAIRE_ORDER_PROMOTION_POLICY_VERSION: 'test-faire-policy',
      },
      '@/lib/integrations/commerceShopifyAutomaticPromotion': {
        SHOPIFY_AUTOMATIC_ORDER_PROMOTION_POLICY_VERSION: 'test-shopify-policy',
      },
      '@/lib/integrations/shopifyCommerceClient': {
        normalizeShopifyShopDomain: (value) => value,
        requestShopifyAccessToken: async () => ({
          accessToken: 'access-token',
          grantedScopes: ['read_orders'],
        }),
        probeShopifyConnection: async () => {
          probeCalls += 1
          return {
            shopId: externalAccountId,
            grantedScopes: ['read_orders'],
          }
        },
        shopifyAdminGraphql: async (_credential, request) => {
          graphqlCalls.push(request)
          assert.ok(graphqlResponses.length > 0, 'Unexpected Shopify provider read')
          return graphqlResponses.shift()
        },
      },
      '@/lib/operations/commerceNormalization': {
        createCommerceNormalizationRejection: (value) => ({ ...value }),
      },
      '@/lib/persistence/commerceIntegrations': {
        readCommerceRuntimeCredentialFromPostgres: async () => runtime,
      },
      '@/lib/persistence/commerceOrderReconciliation': {},
      '@/lib/persistence/commerceIntake': {},
      '@/lib/persistence/operations': {},
    },
  )

  return {
    async read() {
      return module.readCommerceShopifyOrderRevisionEnvelope({
        organizationId,
        accountGlobalId,
        integrationAccountId,
        externalAccountId,
        externalOrderId,
        expectedCredentialVersion: 7,
      })
    },
    graphqlCalls,
    providerReadCount: () => probeCalls + graphqlCalls.length,
  }
}

async function assertNormalizationRejected(harness) {
  await assert.rejects(
    () => harness.read(),
    (error) => {
      assert.equal(error.code, 'SHOPIFY_ORDER_REVISION_NORMALIZATION_REJECTED')
      assert.equal(error.status, 409)
      return true
    },
  )
}

test('Shopify exact read reports two provider reads for one complete line page', async () => {
  const harness = createShopifyExactReadHarness([
    { order: exactOrder(connection(lines('single', 250))) },
  ])
  const result = await harness.read()
  assert.equal(result.providerReads, 2)
  assert.equal(result.providerWrites, 0)
  assert.equal(harness.providerReadCount(), 2)
})

test('Shopify exact read reports the actual nested read for 251 and 500 lines', async () => {
  for (const secondPageCount of [1, 250]) {
    const harness = createShopifyExactReadHarness([
      { order: exactOrder(connection(lines('first', 250), true, 'cursor-1')) },
      {
        order: exactOrder(connection(
          lines('second', secondPageCount),
          false,
          null,
        )),
      },
    ])
    const result = await harness.read()
    assert.equal(result.providerReads, 3)
    assert.equal(result.providerWrites, 0)
    assert.equal(harness.providerReadCount(), 3)
    assert.match(harness.graphqlCalls[1].query, /\bupdatedAt\b/u)
  }
})

test('Shopify exact read rejects updatedAt drift across line pages', async () => {
  const harness = createShopifyExactReadHarness([
    { order: exactOrder(connection(lines('first', 250), true, 'cursor-1')) },
    {
      order: exactOrder(
        connection(lines('second', 1)),
        '2026-08-12T16:00:01.000Z',
      ),
    },
  ])
  await assertNormalizationRejected(harness)
  assert.equal(harness.providerReadCount(), 3)
})

test('Shopify exact read rejects duplicate line IDs across pages', async () => {
  const firstPage = lines('first', 250)
  const harness = createShopifyExactReadHarness([
    { order: exactOrder(connection(firstPage, true, 'cursor-1')) },
    { order: exactOrder(connection([{ id: firstPage[0].id }])) },
  ])
  await assertNormalizationRejected(harness)
  assert.equal(harness.providerReadCount(), 3)
})

test('Shopify exact read rejects a repeated provider cursor without a third read', async () => {
  const harness = createShopifyExactReadHarness([
    { order: exactOrder(connection(lines('first', 250), true, 'cursor-1')) },
    {
      order: exactOrder(connection(
        lines('second', 1),
        true,
        'cursor-1',
      )),
    },
  ])
  await assertNormalizationRejected(harness)
  assert.equal(harness.providerReadCount(), 3)
  assert.equal(harness.graphqlCalls.length, 2)
})

test('Shopify exact read fails closed above 500 lines without a third GraphQL page', async () => {
  const harness = createShopifyExactReadHarness([
    { order: exactOrder(connection(lines('first', 250), true, 'cursor-1')) },
    {
      order: exactOrder(connection(
        lines('second', 250),
        true,
        'cursor-2',
      )),
    },
  ])
  await assertNormalizationRejected(harness)
  assert.equal(harness.providerReadCount(), 3)
  assert.equal(harness.graphqlCalls.length, 2)
})

test('Shopify exact read counts a nested request even when total lines remain 250', async () => {
  const harness = createShopifyExactReadHarness([
    { order: exactOrder(connection(lines('first', 249), true, 'cursor-1')) },
    { order: exactOrder(connection(lines('second', 1))) },
  ])
  const result = await harness.read()
  assert.equal(harness.providerReadCount(), 3)
  assert.equal(
    result.providerReads,
    3,
    'Provider-read evidence must count the nested request, not infer it from final line count',
  )
})

const failures = []
for (const { name, callback } of tests) {
  try {
    await callback()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

if (priorEncryptionKey === undefined) {
  delete process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
} else {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = priorEncryptionKey
}

assert.equal(
  failures.length,
  0,
  `${failures.length} commerce order revision integrity test(s) failed`,
)
console.log('Commerce order revision integrity checks passed')
