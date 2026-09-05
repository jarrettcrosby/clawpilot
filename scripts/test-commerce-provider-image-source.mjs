#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = '1'
process.env.CLAWPILOT_ENV = 'production'

function loadTypeScriptModule(path, { mocks = {} } = {}) {
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: path,
      reportDiagnostics: true,
    },
  )
  const diagnostics = (output.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(diagnostics, [])
  const loaded = { exports: {} }
  const sandbox = {
    Array,
    Boolean,
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
  }
  vm.runInNewContext(output.outputText, sandbox, { filename: path })
  return loaded.exports
}

function locatorFingerprint(value) {
  if (typeof value !== 'string') return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  url.search = ''
  url.hash = ''
  return createHash('sha256').update(url.toString()).digest('hex')
}

class StoreSyncFenceError extends Error {
  constructor() {
    super('Store sync is Paused for this commerce connection')
    this.code = 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
  }
}

function shopifyRuntime(overrides = {}) {
  return {
    configuration: { shopDomain: 'example.myshopify.com' },
    credentialVersion: 3,
    encrypted: { ciphertext: 'not-used-in-test' },
    environment: 'production',
    externalAccountId: 'gid://shopify/Shop/100',
    globalId: 'gcia0000001',
    integrationAccountId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    provider: 'shopify',
    status: 'active',
    verificationStatus: 'verified',
    ...overrides,
  }
}

function fixture(overrides = {}) {
  const state = {
    graphqlCalls: 0,
    faireCalls: 0,
    faireProfileCalls: 0,
    runtimeReads: 0,
    storeSyncFenceCalls: 0,
    storeSyncIntentKeys: [],
  }
  const values = {
    runtime: shopifyRuntime(),
    shopifyData: {
      product: {
        id: 'gid://shopify/Product/200',
        media: {
          nodes: [{
            id: 'gid://shopify/MediaImage/300',
            image: {
              url: 'https://cdn.shopify.com/image.png?token=shopify-secret',
            },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
    faireProduct: {
      id: 'p_200',
      brand_id: 'b_100',
      images: [
        'https://cdn.faire.com/image-a.png?token=faire-secret',
        {
          id: 'img_2',
          image_url: 'https://cdn.faire.com/image-b.png',
        },
      ],
    },
    faireProfile: null,
    ...overrides,
  }
  const module = loadTypeScriptModule(
    'app_src/lib/integrations/commerceProviderImageSource.ts',
    {
      mocks: {
        '@/lib/integrations/commerceReadRuntime': loadTypeScriptModule(
          'app_src/lib/integrations/commerceReadRuntime.ts',
        ),
        '@/lib/integrations/commerceCredentialCrypto': {
          decryptCommerceCredential() {
            return values.runtime.provider === 'shopify'
              ? {
                  provider: 'shopify',
                  clientId: 'client-id',
                  clientSecret: 'client-secret',
                }
              : {
                  provider: 'faire',
                  authMode: 'faire_brand_token',
                  accessToken: 'brand-token',
                }
          },
          normalizeCommerceAccountGlobalId(value) {
            return String(value)
          },
          normalizeCommerceOrganizationId(value) {
            return String(value)
          },
        },
        '@/lib/integrations/integrationCredentialRuntimeGate.mjs': {
          isIntegrationCredentialRuntimeGateError: () => false,
        },
        '@/lib/integrations/commerceCapabilities': {
          hasEffectiveShopifyScope(scopes, scope) {
            return scopes.includes(scope)
          },
        },
        '@/lib/integrations/faireCommerceClient': {
          async probeFaireBrandProfile() {
            state.faireProfileCalls += 1
            return values.faireProfile || {
              id: values.runtime.externalAccountId,
            }
          },
          async getFaireProduct() {
            state.faireCalls += 1
            return values.faireProduct
          },
        },
        '@/lib/integrations/shopifyCommerceClient': {
          normalizeShopifyShopDomain(value) {
            return String(value)
          },
          async probeShopifyConnection() {
            return {
              shopId: values.runtime.externalAccountId,
              grantedScopes: ['read_products'],
            }
          },
          async requestShopifyAccessToken() {
            return {
              accessToken: 'access-token',
              grantedScopes: ['read_products'],
            }
          },
          async shopifyAdminGraphql() {
            state.graphqlCalls += 1
            return values.shopifyData
          },
        },
        '@/lib/operations/commerceNormalization': {
          commerceProductImageLocatorFingerprint: locatorFingerprint,
        },
        '@/lib/persistence/commerceIntegrations': {
          async readCommerceRuntimeCredentialFromPostgres() {
            state.runtimeReads += 1
            return values.runtime
          },
        },
        '@/lib/persistence/commerceStoreSync': {
          CommerceStoreSyncProviderReadFenceError: StoreSyncFenceError,
          async withCommerceStoreSyncProviderReadFenceInPostgres(input) {
            state.storeSyncFenceCalls += 1
            state.storeSyncIntentKeys.push(input.intentKey)
            if (values.storeSyncPaused) {
              throw new StoreSyncFenceError()
            }
            return input.read({
              id: '00000000-0000-4000-8000-000000000298',
              authorityKind: input.authorityKind,
              readKind: input.readKind,
            })
          },
        },
      },
    },
  )
  return { module, state, values }
}

function sourceInput(overrides = {}) {
  return {
    accountGlobalId: 'gcia0000001',
    credentialGeneration: 3,
    externalProductId: 'gid://shopify/Product/200',
    organizationId: '00000000-0000-4000-8000-000000000002',
    provider: 'shopify',
    intentKey: 'manual-image-review-command-0001',
    acquiredBy: 'image-reviewer@example.com',
    ...overrides,
  }
}

async function expectCode(promise, code, forbidden = []) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, 'CommerceProviderImageSourceError')
    assert.equal(error?.code, code)
    for (const value of forbidden) {
      assert.equal(String(error?.message || '').includes(value), false)
    }
    return true
  })
}

test('re-reads one current Shopify product and returns query-free matching evidence', async () => {
  const { module, state } = fixture()
  const sources = await module.readCurrentCommerceProviderImageSources(
    sourceInput(),
  )
  assert.equal(state.runtimeReads, 1)
  assert.equal(state.graphqlCalls, 1)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].providerImageId, 'gid://shopify/MediaImage/300')
  assert.equal(sources[0].locatorSha256, locatorFingerprint(
    'https://cdn.shopify.com/image.png',
  ))
  assert.equal(sources[0].sequence, 0)
  assert.equal(
    sources[0].url,
    'https://cdn.shopify.com/image.png?token=shopify-secret',
  )
  assert.equal(
    module.selectCommerceProviderImageSource({
      sources,
      providerImageId: sources[0].providerImageId,
      locatorSha256: sources[0].locatorSha256,
    }),
    sources[0],
  )
})

test('sequential manual reviews use distinct durable command identities', async () => {
  const { module, state } = fixture()
  await module.readCurrentCommerceProviderImageSources(sourceInput({
    intentKey: 'manual-image-review-command-0001',
  }))
  await module.readCurrentCommerceProviderImageSources(sourceInput({
    intentKey: 'manual-image-review-command-0002',
  }))
  assert.equal(state.graphqlCalls, 2)
  assert.deepEqual(state.storeSyncIntentKeys, [
    'manual-image-review-command-0001',
    'manual-image-review-command-0002',
  ])
})

test('rejects a Shopify image set larger than the durable bounded set', async () => {
  const { module } = fixture({
    shopifyData: {
      product: {
        id: 'gid://shopify/Product/200',
        media: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: 'secret-cursor' },
        },
      },
    },
  })
  await expectCode(
    module.readCurrentCommerceProviderImageSources(sourceInput()),
    'COMMERCE_PROVIDER_IMAGE_SOURCE_SET_TOO_LARGE',
    ['secret-cursor'],
  )
})

test('fails closed on malformed Shopify media pagination evidence', async () => {
  for (const media of [{ nodes: [] }, {
    nodes: Array.from({ length: 51 }, (_value, index) => ({
      id: `gid://shopify/MediaImage/${index + 1}`,
      image: { url: `https://cdn.shopify.com/image-${index}.png` },
    })),
    pageInfo: { hasNextPage: false },
  }]) {
    const { module } = fixture({
      shopifyData: {
        product: {
          id: 'gid://shopify/Product/200',
          media,
        },
      },
    })
    await expectCode(
      module.readCurrentCommerceProviderImageSources(sourceInput()),
      Array.isArray(media.nodes) && media.nodes.length > 50
        ? 'COMMERCE_PROVIDER_IMAGE_SOURCE_SET_TOO_LARGE'
        : 'COMMERCE_PROVIDER_IMAGE_SOURCE_READ_FAILED',
    )
  }
})

test('rejects one provider image ID bound to conflicting current locators', async () => {
  const { module } = fixture({
    shopifyData: {
      product: {
        id: 'gid://shopify/Product/200',
        media: {
          nodes: [{
            id: 'gid://shopify/MediaImage/300',
            image: { url: 'https://cdn.shopify.com/image-a.png' },
          }, {
            id: 'gid://shopify/MediaImage/300',
            image: { url: 'https://cdn.shopify.com/image-b.png' },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  })
  await expectCode(
    module.readCurrentCommerceProviderImageSources(sourceInput()),
    'COMMERCE_PROVIDER_IMAGE_SOURCE_AMBIGUOUS',
    ['image-a.png', 'image-b.png', 'cdn.shopify.com'],
  )
})

test('fails before provider I/O when the credential fence changed', async () => {
  const { module, state } = fixture()
  await expectCode(
    module.readCurrentCommerceProviderImageSources(sourceInput({
      credentialGeneration: 4,
    })),
    'COMMERCE_PROVIDER_IMAGE_SOURCE_FENCE_CHANGED',
  )
  assert.equal(state.graphqlCalls, 0)
  assert.equal(state.faireCalls, 0)
})

test('fails before provider I/O when the connection is disabled', async () => {
  const { module, state } = fixture({
    runtime: shopifyRuntime({ status: 'disabled' }),
  })
  await expectCode(
    module.readCurrentCommerceProviderImageSources(sourceInput()),
    'COMMERCE_PROVIDER_IMAGE_SOURCE_CONNECTION_REQUIRED',
  )
  assert.equal(state.graphqlCalls, 0)
  assert.equal(state.faireCalls, 0)
})

test('committed Store sync Pause invokes no provider image-source call', async () => {
  const { module, state } = fixture({ storeSyncPaused: true })
  await expectCode(
    module.readCurrentCommerceProviderImageSources(sourceInput()),
    'COMMERCE_PROVIDER_IMAGE_SOURCE_STORE_SYNC_PAUSED',
  )
  assert.equal(state.storeSyncFenceCalls, 1)
  assert.equal(state.graphqlCalls, 0)
  assert.equal(state.faireProfileCalls, 0)
  assert.equal(state.faireCalls, 0)
})

test('rejects decorated or nonnumeric Shopify product identities', async () => {
  for (const externalProductId of [
    'gid://shopify/Product/200?token=secret',
    'gid://shopify/Product/not-numeric',
  ]) {
    const { module, state } = fixture()
    await expectCode(
      module.readCurrentCommerceProviderImageSources(sourceInput({
        externalProductId,
      })),
      'COMMERCE_PROVIDER_IMAGE_SOURCE_INPUT_INVALID',
      ['secret'],
    )
    assert.equal(state.graphqlCalls, 0)
  }
})

test('reads Faire string and object image shapes without returning secrets in errors', async () => {
  const runtime = shopifyRuntime({
    configuration: {},
    externalAccountId: 'b_100',
    provider: 'faire',
  })
  const { module, state } = fixture({ runtime })
  const sources = await module.readCurrentCommerceProviderImageSources(
    sourceInput({
      externalProductId: 'p_200',
      provider: 'faire',
    }),
  )
  assert.equal(state.faireCalls, 1)
  assert.equal(state.faireProfileCalls, 1)
  assert.equal(sources.length, 2)
  assert.equal(sources[0].providerImageId, null)
  assert.equal(sources[1].providerImageId, 'img_2')
  await expectCode(
    Promise.resolve().then(() => module.selectCommerceProviderImageSource({
      sources,
      providerImageId: null,
      locatorSha256: '0'.repeat(64),
    })),
    'COMMERCE_PROVIDER_IMAGE_SOURCE_STALE',
    ['faire-secret', 'cdn.faire.com'],
  )
})

test('authoritative Faire image reads preserve every ordered entry without dedupe', async () => {
  const duplicateUrl = 'https://cdn.faire.com/duplicate.png'
  const runtime = shopifyRuntime({
    configuration: {},
    externalAccountId: 'b_100',
    provider: 'faire',
  })
  const { module } = fixture({
    runtime,
    faireProduct: {
      id: 'p_200',
      brand_id: 'b_100',
      images: [duplicateUrl, duplicateUrl],
    },
  })
  const sources = await module.readCurrentCommerceProviderImageSources(
    sourceInput({
      externalProductId: 'p_200',
      provider: 'faire',
      requireExactOrderedSet: true,
    }),
  )
  assert.equal(sources.length, 2)
  assert.deepEqual(Array.from(sources, (source) => source.sequence), [0, 1])
  assert.deepEqual(Array.from(sources, (source) => source.url), [
    duplicateUrl,
    duplicateUrl,
  ])
})

test('authoritative Faire image reads fail closed on any undecodable entry', async () => {
  const runtime = shopifyRuntime({
    configuration: {},
    externalAccountId: 'b_100',
    provider: 'faire',
  })
  for (const invalidImage of [null, {}, 'http://cdn.faire.com/not-https.png']) {
    const { module } = fixture({
      runtime,
      faireProduct: {
        id: 'p_200',
        brand_id: 'b_100',
        images: [
          'https://cdn.faire.com/valid.png',
          invalidImage,
        ],
      },
    })
    await expectCode(
      module.readCurrentCommerceProviderImageSources(sourceInput({
        externalProductId: 'p_200',
        provider: 'faire',
        requireExactOrderedSet: true,
      })),
      'COMMERCE_PROVIDER_IMAGE_SOURCE_EXACT_SET_INVALID',
      ['not-https.png', 'cdn.faire.com'],
    )
  }
})

test('retries a malformed Faire product image shape instead of treating it as absence', async () => {
  const runtime = shopifyRuntime({
    configuration: {},
    externalAccountId: 'b_100',
    provider: 'faire',
  })
  const { module, state } = fixture({
    runtime,
    faireProduct: { id: 'p_200', brand_id: 'b_100' },
  })
  await expectCode(
    module.readCurrentCommerceProviderImageSources(sourceInput({
      externalProductId: 'p_200',
      provider: 'faire',
    })),
    'COMMERCE_PROVIDER_IMAGE_SOURCE_READ_FAILED',
  )
  assert.equal(state.faireCalls, 1)
})

test('fails closed when the live Faire brand or product brand changed', async () => {
  for (const overrides of [{
    faireProfile: { id: 'different-brand' },
  }, {
    faireProduct: {
      id: 'p_200',
      brand_id: 'different-brand',
      images: [],
    },
  }]) {
    const runtime = shopifyRuntime({
      configuration: {},
      externalAccountId: 'b_100',
      provider: 'faire',
    })
    const { module } = fixture({ runtime, ...overrides })
    await expectCode(
      module.readCurrentCommerceProviderImageSources(sourceInput({
        externalProductId: 'p_200',
        provider: 'faire',
      })),
      'COMMERCE_PROVIDER_IMAGE_SOURCE_ACCOUNT_CHANGED',
    )
  }
})

test('rejects identity changes and does not echo raw provider locators', async () => {
  const secretUrl = 'https://cdn.shopify.com/image.png?token=do-not-echo'
  const { module } = fixture({
    shopifyData: {
      product: {
        id: 'gid://shopify/Product/other',
        media: {
          nodes: [{
            id: 'gid://shopify/MediaImage/300',
            image: { url: secretUrl },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  })
  await expectCode(
    module.readCurrentCommerceProviderImageSources(sourceInput()),
    'COMMERCE_PROVIDER_IMAGE_SOURCE_IDENTITY_CHANGED',
    [secretUrl, 'do-not-echo', 'cdn.shopify.com'],
  )
})

const sourceText = readFileSync(
  resolve(root, 'app_src/lib/integrations/commerceProviderImageSource.ts'),
  'utf8',
)
assert.doesNotMatch(sourceText, /console\.(?:log|error|warn)/)
assert.doesNotMatch(sourceText, /recordAuditEvent|JSON\.stringify\([^)]*url/i)
