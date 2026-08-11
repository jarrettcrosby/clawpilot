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

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const diagnostics = (output.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(diagnostics, [])
  const loaded = { exports: {} }
  vm.runInNewContext(output.outputText, {
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
    exports: loaded.exports,
    module: loaded,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return loaded.exports
}

const refreshTypes = loadTypeScriptModule(
  'app_src/lib/integrations/faireProductImageRefreshTypes.ts',
)

class CommerceProviderImageSourceError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'CommerceProviderImageSourceError'
    this.code = code
    this.status = status
  }
}

class CommerceProductImageImportError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'CommerceProductImageImportError'
    this.code = code
    this.status = status
  }
}

const service = loadTypeScriptModule(
  'app_src/lib/integrations/faireProductImageRefresh.ts',
  {
    '@/lib/integrations/commerceProviderImageSource': {
      CommerceProviderImageSourceError,
      async readCurrentCommerceProviderImageSources() {
        throw new Error('default source reader must be injected')
      },
    },
    '@/lib/integrations/faireProductImageRefreshTypes': refreshTypes,
    '@/lib/persistence/commerceProductImageImports': {
      CommerceProductImageImportError,
    },
    '@/lib/persistence/faireProductImageRefresh': {
      async readFaireProductImageRefreshTargetInPostgres() {
        throw new Error('default target reader must be injected')
      },
      async reconcileExactFaireProductImageRefreshInPostgres() {
        throw new Error('default reconciliation must be injected')
      },
    },
  },
)

const target = Object.freeze({
  organizationId: '00000000-0000-4000-8000-000000000001',
  productId: '00000000-0000-4000-8000-000000000002',
  productReferenceCode: 'gp2314728',
  productName: 'Chicken & Apple 10lb',
  integrationAccountId: '00000000-0000-4000-8000-000000000003',
  integrationAccountGlobalId: 'gia5156705',
  credentialGeneration: 4,
  channelStateGlobalId: 'gpcs1234567',
  channelStateRowVersion: 9,
  channelSourceRevision: 'faire-catalog-revision-9',
  externalProductId: 'p_26rmrj53zw',
  externalVariantId: 'po_7yd59nrwqg',
  providerSku: 'AG-CHEWY-CA-BK',
})

function command(overrides = {}) {
  return {
    organizationId: target.organizationId,
    productId: target.productId,
    channelStateGlobalId: target.channelStateGlobalId,
    expectedProductReferenceCode: target.productReferenceCode,
    expectedIntegrationAccountGlobalId:
      target.integrationAccountGlobalId,
    expectedChannelStateRowVersion: target.channelStateRowVersion,
    expectedChannelSourceRevision: target.channelSourceRevision,
    expectedExternalProductId: target.externalProductId,
    expectedExternalVariantId: target.externalVariantId,
    expectedProviderSku: target.providerSku,
    confirmReadOnlyProviderRequest: true,
    actorEmail: 'faire-image-operator@episcs.com',
    ...overrides,
  }
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.name, 'FaireProductImageRefreshError')
    assert.equal(error?.code, code)
    return true
  })
}

test('queues only the exact reviewed Faire Product images with zero provider writes', async () => {
  let targetReads = 0
  let sourceReadOperations = 0
  let reconciliationInput = null
  const result = await service.refreshExactFaireProductImages(command(), {
    async readTarget() {
      targetReads += 1
      return target
    },
    async readSources(input) {
      sourceReadOperations += 1
      assert.equal(input.provider, 'faire')
      assert.equal(input.accountGlobalId, 'gia5156705')
      assert.equal(input.externalProductId, 'p_26rmrj53zw')
      return Object.freeze([{
        providerImageId: 'i_6xtuafkgqp',
        locatorSha256: sha('faire-chicken-apple-front'),
        sequence: 0,
        url: 'https://cdn.faire.com/front.webp?token=secret-front',
      }, {
        providerImageId: 'i_w2a6xa5ysh',
        locatorSha256: sha('faire-chicken-apple-back'),
        sequence: 1,
        url: 'https://cdn.faire.com/back.webp?token=secret-back',
      }])
    },
    async reconcile(input) {
      reconciliationInput = input
      return {
        productSourceHash: input.productSourceHash,
        productLifecycle: 'active',
        imageSetComplete: false,
        staleSnapshotIgnored: false,
        active: [{ jobState: 'queued' }, { jobState: 'succeeded' }],
        removed: [],
      }
    },
    now: () => new Date('2026-08-02T15:00:00.000Z'),
  })
  assert.equal(targetReads, 1)
  assert.equal(sourceReadOperations, 1)
  assert.equal(reconciliationInput.target, target)
  assert.equal(reconciliationInput.images.length, 2)
  assert.deepEqual(
    JSON.parse(JSON.stringify(reconciliationInput.images)).map((image) => ({
      providerImageId: image.providerImageId,
      sequence: image.sequence,
      altText: image.altText,
    })),
    [{
      providerImageId: 'i_6xtuafkgqp',
      sequence: 0,
      altText: 'Chicken & Apple 10lb',
    }, {
      providerImageId: 'i_w2a6xa5ysh',
      sequence: 1,
      altText: 'Chicken & Apple 10lb',
    }],
  )
  assert.equal(
    JSON.stringify(reconciliationInput).includes('secret-front'),
    false,
  )
  assert.equal(JSON.stringify(reconciliationInput).includes('cdn.faire.com'), false)
  assert.equal(JSON.stringify(result).includes('secret-back'), false)
  assert.equal(result.logicalReadOperations, 1)
  assert.equal(result.providerRequests, 2)
  assert.equal(result.providerWrites, 0)
  assert.equal(result.imageSetComplete, false)
  assert.equal(result.removalsInferred, false)
  assert.equal(result.observedImages, 2)
  assert.equal(result.jobs.queued, 1)
  assert.equal(result.jobs.succeeded, 1)
})

test('requires explicit confirmation before any database or provider read', async () => {
  let calls = 0
  await expectCode(
    service.refreshExactFaireProductImages(command({
      confirmReadOnlyProviderRequest: false,
    }), {
      async readTarget() {
        calls += 1
        return target
      },
    }),
    'FAIRE_PRODUCT_IMAGE_REFRESH_CONFIRMATION_REQUIRED',
  )
  assert.equal(calls, 0)
})

test('rejects stale variant or SKU evidence before Faire I/O', async () => {
  let sourceReadOperations = 0
  await expectCode(
    service.refreshExactFaireProductImages(command({
      expectedProviderSku: 'WRONG-SKU',
    }), {
      async readTarget() {
        return target
      },
      async readSources() {
        sourceReadOperations += 1
        return []
      },
    }),
    'FAIRE_PRODUCT_IMAGE_REFRESH_SELECTION_STALE',
  )
  assert.equal(sourceReadOperations, 0)
})

test('preserves sanitized provider errors without exposing raw locators', async () => {
  await assert.rejects(
    service.refreshExactFaireProductImages(command(), {
      async readTarget() {
        return target
      },
      async readSources() {
        throw new CommerceProviderImageSourceError(
          'COMMERCE_PROVIDER_IMAGE_SOURCE_STALE',
          'Provider image source changed',
          409,
        )
      },
    }),
    (error) => {
      assert.equal(error?.code, 'COMMERCE_PROVIDER_IMAGE_SOURCE_STALE')
      assert.equal(error?.status, 409)
      assert.equal(String(error?.message).includes('http'), false)
      return true
    },
  )
})

test('route and UI pin authenticated same-origin exact-target zero-write behavior', () => {
  const route = read(
    'app_src/app/api/crm/products/[productId]/faire-product-images/route.ts',
  )
  assert.match(route, /assertSameOrigin\(req\)/u)
  assert.match(route, /requestSession\(req\)/u)
  assert.match(route, /session\?\.impersonating/u)
  assert.match(route, /requireRequestUser\(req\)/u)
  assert.match(route, /actor\.permissions\.manageOperations !== true/u)
  assert.match(route, /body\.action !== 'refresh-faire-product-images'/u)
  assert.match(route, /confirmReadOnlyProviderRequest/u)
  assert.match(route, /expectedExternalProductId/u)
  assert.match(route, /expectedExternalVariantId/u)
  assert.match(route, /expectedProviderSku/u)
  assert.match(route, /commerceReadRuntimeAvailable\(\)/u)
  assert.match(route, /FAIRE_PRODUCT_IMAGE_REFRESH_DISABLED/u)
  assert.ok(
    route.indexOf('if (!commerceReadRuntimeAvailable())')
      < route.indexOf('const body = await boundedJson(req)'),
    'runtime gate must reject before command parsing and provider refresh',
  )
  assert.ok(
    route.indexOf('if (!commerceReadRuntimeAvailable())')
      < route.indexOf('await refreshExactFaireProductImages({'),
    'runtime gate must reject before provider reads or queue writes',
  )

  const panel = read('app_src/components/crm/ProductImagePanel.tsx')
  assert.match(panel, /data-testid="crm-faire-image-import"/u)
  assert.match(panel, /Refresh and import from Faire/u)
  assert.match(panel, /Faire image import/u)
  assert.match(panel, /verified production connection/u)
  assert.match(panel, /state\?\.imageImportAvailable !== true/u)
  assert.match(
    panel,
    /No Faire read or image job will be attempted/u,
  )
  assert.match(panel, /confirmReadOnlyProviderRequest: true/u)
  assert.match(panel, /cannot write to Faire/u)
  assert.match(panel, /makes two[\s\S]*read-only Faire requests/u)
  assert.match(panel, /expectedChannelStateRowVersion: channel\.rowVersion/u)
  assert.match(panel, /expectedChannelSourceRevision: channel\.sourceRevision/u)

  const persistence = read(
    'app_src/lib/persistence/faireProductImageRefresh.ts',
  )
  assert.match(persistence, /channel_state\.provider = 'faire'/u)
  assert.match(persistence, /credential\.verification_status = 'verified'/u)
  assert.match(persistence, /product_mapping\.active = true/u)
  assert.match(persistence, /imageSetComplete: false/u)
  assert.doesNotMatch(persistence, /fetch\s*\(/u)
})
