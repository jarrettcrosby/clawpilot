#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

const organizationId = '11111111-1111-4111-8111-111111111111'
const foreignOrganizationId = '22222222-2222-4222-8222-222222222222'
const restaurantGuid = '33333333-3333-4333-8333-333333333333'
const foreignRestaurantGuid = '44444444-4444-4444-8444-444444444444'
const itemGuid = '55555555-5555-4555-8555-555555555555'
const noImageItemGuid = '66666666-6666-4666-8666-666666666666'
const privateImageItemGuid = '77777777-7777-4777-8777-777777777777'
const invalidImageItemGuid = '88888888-8888-4888-8888-888888888888'
const externalImageUrl = 'https://images.toast.example.test/menu/item.png?secret=do-not-leak'
const privateImageUrl = 'https://127.0.0.1/internal/admin.png?secret=private-do-not-leak'
const invalidImageUrl = 'http://images.toast.example.test/not-https.png?secret=invalid-do-not-leak'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const localRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
    try {
      return requireFromApp(specifier)
    } catch {
      return nodeRequire(specifier)
    }
  }
  vm.runInNewContext(output, {
    AbortController,
    AbortSignal,
    Buffer,
    console,
    Date,
    Error,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    clearTimeout,
    crypto: globalThis.crypto,
    exports: module.exports,
    fetch,
    module,
    process,
    require: localRequire,
    setTimeout,
    structuredClone,
  }, { filename: path })
  return module.exports
}

class TestNextResponse extends Response {
  static json(payload, init = {}) {
    const headers = new Headers(init.headers || {})
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    return new TestNextResponse(JSON.stringify(payload), { ...init, headers })
  }
}

async function responseJson(response) {
  return JSON.parse(await response.text())
}

function request() {
  return new Request('https://clawpilot.test/api/pos/catalog/media')
}

function context(selectedRestaurantGuid = restaurantGuid, selectedItemGuid = itemGuid) {
  return {
    params: Promise.resolve({
      restaurantGuid: selectedRestaurantGuid,
      itemGuid: selectedItemGuid,
    }),
  }
}

function itemDetail(overrides = {}) {
  return {
    restaurantGuid,
    itemGuid,
    name: 'Toast lunch special',
    sku: 'TOAST-LUNCH-1',
    description: 'Fresh description loaded only for the selected item.',
    hasImage: true,
    sourceImageUrl: externalImageUrl,
    sourceRevision: '2026-09-07T12:00:00.000Z',
    ...overrides,
  }
}

test('the large POS accounting source catalog exposes only media-presence flags', async () => {
  const projection = loadTypeScriptModule('app_src/lib/integrations/toastOrderProjection.ts')
  const menuQuerySources = []
  const leakedDescription = `full-description-must-not-leak-${'x'.repeat(3970)}`
  const menuRows = Array.from({ length: 5_000 }, (_, index) => {
    const id = String(index + 1).padStart(12, '0')
    return {
      item_guid: `00000000-0000-4000-8000-${id}`,
      provider_item_id: `00000000-0000-4000-8000-${id}`,
      name: `Menu item ${index + 1}`,
      plu: `PLU-${index + 1}`,
      sku: `SKU-${index + 1}`,
      has_description: true,
      has_image: true,
      description: leakedDescription,
      image_url: externalImageUrl,
      price: '12.50',
    }
  })
  const accounting = loadTypeScriptModule('app_src/lib/persistence/posAccounting.ts', {
    '@/lib/auditWriter': { recordAuditEvent: async () => {} },
    '@/lib/integrations/toastOrderProjection': projection,
    '@/lib/persistence/postgres': {
      acquireTransactionAdvisoryLock: async () => {},
      query: async (sql, params = []) => {
        const source = String(sql)
        if (source.includes('FROM toast_locations')) {
          return {
            rows: [{
              restaurant_guid: restaurantGuid,
              restaurant_name: 'Test Toast Restaurant',
              location_name: 'Test location',
              timezone: 'America/New_York',
              closeout_hour: 4,
              analytics_access: false,
              standard_access: true,
            }],
            rowCount: 1,
          }
        }
        if (source.includes('FROM toast_menu_catalog_items')) {
          menuQuerySources.push({ source, params: [...params] })
          return { rows: menuRows, rowCount: menuRows.length }
        }
        return { rows: [], rowCount: 0 }
      },
      withTransaction: async () => {
        throw new Error('transactions are not expected in the read-only workspace test')
      },
    },
  })

  const workspace = await accounting.readPosAccountingWorkspaceFromPostgres({
    organizationId,
    restaurantGuid,
    businessDate: '2026-09-07',
  })
  assert.equal(menuQuerySources.length, 1)
  assert.deepEqual(menuQuerySources[0].params, [organizationId, restaurantGuid])
  assert.match(menuQuerySources[0].source, /description IS NOT NULL AS has_description/)
  assert.match(menuQuerySources[0].source, /image_url IS NOT NULL AS has_image/)
  assert.doesNotMatch(menuQuerySources[0].source, /sku,\s*description,\s*image_url/)
  assert.equal(workspace.sourceCatalog.length, 5_000)
  assert.equal(workspace.sourceCatalog[0].hasDescription, true)
  assert.equal(workspace.sourceCatalog[0].hasImage, true)
  assert.equal(Object.hasOwn(workspace.sourceCatalog[0], 'description'), false)
  assert.equal(Object.hasOwn(workspace.sourceCatalog[0], 'imageUrl'), false)
  assert.equal(Object.hasOwn(workspace.sourceCatalog[0].productCreationSuggestion, 'description'), false)
  assert.equal(Object.hasOwn(workspace.sourceCatalog[0].productCreationSuggestion, 'imageUrl'), false)
  const serialized = JSON.stringify(workspace.sourceCatalog)
  assert.equal(serialized.includes(leakedDescription), false)
  assert.equal(serialized.includes(externalImageUrl), false)
  assert.ok(serialized.length < 5_000_000, 'presence-only catalog unexpectedly became a heavyweight media response')
})

test('the product-detail persistence read is fenced by organization, location, and item', async () => {
  const calls = []
  const catalog = loadTypeScriptModule('app_src/lib/persistence/posCatalog.ts', {
    '@/lib/persistence/postgres': {
      query: async (sql, params = []) => {
        calls.push({ source: String(sql), params: [...params] })
        if (
          params[0] === organizationId
          && params[1] === restaurantGuid
          && params[2] === itemGuid
        ) {
          return {
            rows: [{
              restaurant_guid: restaurantGuid,
              item_guid: itemGuid,
              name: 'Toast lunch special',
              sku: 'TOAST-LUNCH-1',
              description: 'Selected product detail',
              image_url: externalImageUrl,
              source_revision: '2026-09-07T12:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      },
      withTransaction: async () => {
        throw new Error('transactions are not expected in the detail read test')
      },
    },
  })

  const detail = await catalog.readToastMenuCatalogItemDetailFromPostgres({
    organizationId,
    restaurantGuid,
    itemGuid,
  })
  assert.equal(detail.description, 'Selected product detail')
  assert.equal(detail.sourceImageUrl, externalImageUrl)
  assert.equal(detail.hasImage, true)
  assert.deepEqual(calls[0].params, [organizationId, restaurantGuid, itemGuid])
  for (const fragment of [
    'item.organization_id = $1::uuid',
    'item.restaurant_guid = $2::uuid',
    'item.item_guid = $3::uuid',
    'item.active = true',
    'item.archived = false',
    'location.organization_id = item.organization_id',
    'location.restaurant_guid = item.restaurant_guid',
    'location.standard_access = true',
    'location.selected = true',
    'location.active = true',
    'location.archived = false',
  ]) assert.ok(calls[0].source.includes(fragment), `detail lookup missing scope: ${fragment}`)

  assert.equal(await catalog.readToastMenuCatalogItemDetailFromPostgres({
    organizationId: foreignOrganizationId,
    restaurantGuid,
    itemGuid,
  }), null)
  assert.equal(await catalog.readToastMenuCatalogItemDetailFromPostgres({
    organizationId,
    restaurantGuid: foreignRestaurantGuid,
    itemGuid,
  }), null)
  assert.equal(await catalog.readToastMenuCatalogItemDetailFromPostgres({
    organizationId,
    restaurantGuid,
    itemGuid: noImageItemGuid,
  }), null)
})

function routeHarness() {
  const state = {
    actor: { email: 'viewer@example.test', organizationId },
    authenticated: true,
    canView: true,
  }
  const detailCalls = []
  const details = new Map([
    [`${organizationId}:${restaurantGuid}:${itemGuid}`, itemDetail()],
    [`${organizationId}:${restaurantGuid}:${noImageItemGuid}`, itemDetail({
      itemGuid: noImageItemGuid,
      description: null,
      hasImage: false,
      sourceImageUrl: null,
    })],
    [`${organizationId}:${restaurantGuid}:${privateImageItemGuid}`, itemDetail({
      itemGuid: privateImageItemGuid,
      sourceImageUrl: privateImageUrl,
    })],
    [`${organizationId}:${restaurantGuid}:${invalidImageItemGuid}`, itemDetail({
      itemGuid: invalidImageItemGuid,
      sourceImageUrl: invalidImageUrl,
    })],
  ])
  const readDetail = async (input) => {
    detailCalls.push(input)
    return details.get(`${input.organizationId}:${input.restaurantGuid}:${input.itemGuid}`) || null
  }
  const sharedMocks = {
    'next/server': { NextResponse: TestNextResponse },
    '@/lib/accountingAuthorization': {
      accountingCapabilities: () => ({ canView: state.canView }),
      activeAccountingOrganizationId: (actor) => {
        if (!actor.organizationId) throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
        return actor.organizationId
      },
    },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
    '@/lib/persistence/posCatalog': {
      readToastMenuCatalogItemDetailFromPostgres: readDetail,
    },
    '@/lib/requestUser': {
      requireRequestUser: async () => {
        if (!state.authenticated) throw new Error('Unauthorized')
        return state.actor
      },
    },
  }
  return { state, details, detailCalls, sharedMocks }
}

test('product detail is authenticated and cannot cross tenant, location, or item scope', async () => {
  const harness = routeHarness()
  const detailRoute = loadTypeScriptModule(
    'app_src/app/api/pos/catalog/items/[restaurantGuid]/[itemGuid]/route.ts',
    harness.sharedMocks,
  )

  harness.state.authenticated = false
  let response = await detailRoute.GET(request(), context())
  assert.equal(response.status, 401)
  assert.equal((await responseJson(response)).code, 'UNAUTHORIZED')
  assert.equal(harness.detailCalls.length, 0)

  harness.state.authenticated = true
  harness.state.canView = false
  response = await detailRoute.GET(request(), context())
  assert.equal(response.status, 403)
  assert.equal((await responseJson(response)).code, 'POS_CATALOG_VIEW_REQUIRED')
  assert.equal(harness.detailCalls.length, 0)

  harness.state.canView = true
  response = await detailRoute.GET(request(), context('not-a-location', itemGuid))
  assert.equal(response.status, 404)
  assert.equal((await responseJson(response)).code, 'POS_CATALOG_ITEM_SELECTION_INVALID')
  assert.equal(harness.detailCalls.length, 0)

  response = await detailRoute.GET(request(), context())
  assert.equal(response.status, 200)
  const allowedBody = await responseJson(response)
  assert.equal(allowedBody.item.description, 'Fresh description loaded only for the selected item.')
  assert.equal(allowedBody.item.hasImage, true)
  assert.equal(
    allowedBody.item.imageUrl,
    `/api/pos/catalog/items/${restaurantGuid}/${itemGuid}/image`,
  )
  assert.equal(Object.hasOwn(allowedBody.item, 'sourceImageUrl'), false)
  assert.equal(JSON.stringify(allowedBody).includes(externalImageUrl), false)
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0')
  assert.equal(response.headers.get('vary'), 'Cookie')

  harness.state.actor = { ...harness.state.actor, organizationId: foreignOrganizationId }
  response = await detailRoute.GET(request(), context())
  assert.equal(response.status, 404)
  assert.equal((await responseJson(response)).code, 'POS_CATALOG_ITEM_NOT_FOUND')
  assert.equal(harness.detailCalls.at(-1).organizationId, foreignOrganizationId)

  harness.state.actor = { ...harness.state.actor, organizationId }
  response = await detailRoute.GET(request(), context(foreignRestaurantGuid, itemGuid))
  assert.equal(response.status, 404)
  assert.equal((await responseJson(response)).code, 'POS_CATALOG_ITEM_NOT_FOUND')
  assert.equal(harness.detailCalls.at(-1).restaurantGuid, foreignRestaurantGuid)

  response = await detailRoute.GET(request(), context(restaurantGuid, noImageItemGuid))
  assert.equal(response.status, 200)
  const noImageBody = await responseJson(response)
  assert.equal(noImageBody.item.description, null)
  assert.equal(noImageBody.item.hasImage, false)
  assert.equal(noImageBody.item.imageUrl, null)
})

test('product image reads use the vetted fetch path and fail closed for unsafe or missing media', async () => {
  class ProviderImageError extends Error {
    constructor(code, status = 400) {
      super('sanitized provider image failure')
      this.code = code
      this.status = status
    }
  }
  const harness = routeHarness()
  const fetchCalls = []
  const onePixelPng = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ))
  const imageRoute = loadTypeScriptModule(
    'app_src/app/api/pos/catalog/items/[restaurantGuid]/[itemGuid]/image/route.ts',
    {
      ...harness.sharedMocks,
      '@/lib/integrations/commerceProviderImageFetch': {
        CommerceProviderImageFetchError: ProviderImageError,
        fetchCommerceProviderImage: async (input) => {
          fetchCalls.push(input)
          if (input.url === privateImageUrl) {
            throw new ProviderImageError('COMMERCE_PROVIDER_IMAGE_HOST_FORBIDDEN', 400)
          }
          if (input.url === invalidImageUrl) {
            throw new ProviderImageError('COMMERCE_PROVIDER_IMAGE_HTTPS_REQUIRED', 400)
          }
          return {
            bytes: onePixelPng,
            byteLength: onePixelPng.byteLength,
            contentSha256: 'a'.repeat(64),
            mediaType: 'image/png',
          }
        },
      },
      '@/lib/integrations/integrationCredentialRuntimeHttp': {
        integrationCredentialRuntimeMaintenanceResponse: () => null,
      },
    },
  )

  harness.state.authenticated = false
  let response = await imageRoute.GET(request(), context())
  assert.equal(response.status, 401)
  assert.equal(fetchCalls.length, 0)

  harness.state.authenticated = true
  harness.state.actor = { ...harness.state.actor, organizationId: foreignOrganizationId }
  response = await imageRoute.GET(request(), context())
  assert.equal(response.status, 404)
  assert.equal((await responseJson(response)).code, 'POS_CATALOG_ITEM_NOT_FOUND')
  assert.equal(fetchCalls.length, 0)

  harness.state.actor = { ...harness.state.actor, organizationId }
  response = await imageRoute.GET(request(), context(restaurantGuid, noImageItemGuid))
  assert.equal(response.status, 404)
  assert.equal((await responseJson(response)).code, 'POS_CATALOG_ITEM_IMAGE_NOT_FOUND')
  assert.equal(fetchCalls.length, 0)

  response = await imageRoute.GET(request(), context(restaurantGuid, privateImageItemGuid))
  assert.equal(response.status, 400)
  let body = await responseJson(response)
  assert.equal(body.code, 'POS_CATALOG_ITEM_IMAGE_UNAVAILABLE')
  assert.equal(JSON.stringify(body).includes(privateImageUrl), false)
  assert.equal(fetchCalls.at(-1).url, privateImageUrl)

  response = await imageRoute.GET(request(), context(restaurantGuid, invalidImageItemGuid))
  assert.equal(response.status, 400)
  body = await responseJson(response)
  assert.equal(body.code, 'POS_CATALOG_ITEM_IMAGE_UNAVAILABLE')
  assert.equal(JSON.stringify(body).includes(invalidImageUrl), false)
  assert.equal(fetchCalls.at(-1).url, invalidImageUrl)

  response = await imageRoute.GET(request(), context())
  assert.equal(response.status, 200)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), onePixelPng)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox")
  assert.equal(fetchCalls.at(-1).url, externalImageUrl)

  const imageRouteSource = read(
    'app_src/app/api/pos/catalog/items/[restaurantGuid]/[itemGuid]/image/route.ts',
  )
  assert.ok(imageRouteSource.includes('fetchCommerceProviderImage({'))
  assert.doesNotMatch(imageRouteSource, /(^|[^A-Za-z])fetch\s*\(/m)
})

test('the POS UI uses same-origin lazy media and graceful no-image/error fallbacks', () => {
  const panel = read('app_src/components/pos/PosAccountingPanel.tsx')
  assert.ok(panel.includes('function toastProductDetailPath(restaurantGuid: string, itemGuid: string)'))
  assert.ok(panel.includes('function toastProductImagePath(restaurantGuid: string, itemGuid: string)'))
  assert.ok(panel.includes('source?.hasImage === true'))
  assert.ok(panel.includes("sourceImagePath: ''"))
  assert.ok(panel.includes('void loadToastProductDetail({'))
  assert.ok(panel.includes("cache: 'no-store'"))
  assert.ok(panel.includes('item.hasImage === true'))
  assert.ok(panel.includes('Loading the latest Toast product details...'))
  assert.ok(panel.includes('Toast image unavailable'))
  assert.ok(panel.includes('You can still prepare this draft with the current values.'))
  assert.equal(panel.includes('src={imageUrl}'), false)
})
