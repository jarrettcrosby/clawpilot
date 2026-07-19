#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')
const contractsOnly = process.argv.includes('--contracts-only')

const organizationId = '11111111-1111-4111-8111-111111111111'
const otherOrganizationId = '22222222-2222-4222-8222-222222222222'
const restaurantGuid = '33333333-3333-4333-8333-333333333333'
const menuGuid = '44444444-4444-4444-8444-444444444444'
const otherMenuGuid = '55555555-5555-4555-8555-555555555555'
const groupGuid = '66666666-6666-4666-8666-666666666666'
const otherGroupGuid = '77777777-7777-4777-8777-777777777777'
const itemGuid = '88888888-8888-4888-8888-888888888888'
const salesCategoryGuid = '99999999-9999-4999-8999-999999999999'
const sourceRevision = '2026-07-19T15:00:00.000Z'
const secretSentinel = 'toast-secret-must-never-leak-ABCD'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, { mocks = {}, globals = {} } = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    Buffer,
    Date,
    Error,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    setTimeout,
    structuredClone,
    ...globals,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

function verifySourceContracts() {
  const migration = read('db/migrations/0070_toast_menu_catalog.sql')
  for (const fragment of [
    'CREATE TABLE IF NOT EXISTS toast_menu_catalog_sync_status',
    'CREATE TABLE IF NOT EXISTS toast_menu_catalog_restaurants',
    'CREATE TABLE IF NOT EXISTS toast_menu_catalog_menus',
    'CREATE TABLE IF NOT EXISTS toast_menu_catalog_groups',
    'CREATE TABLE IF NOT EXISTS toast_menu_catalog_items',
    'CREATE TABLE IF NOT EXISTS toast_menu_catalog_sales_categories',
    'source_provider text NOT NULL',
    'provider_item_id text NOT NULL',
    'provider_sales_category_id text',
    'source_revision timestamptz',
    'observed_source_revision timestamptz',
    'PRIMARY KEY (organization_id, restaurant_guid, menu_guid, group_guid, item_guid)',
  ]) assert.ok(migration.includes(fragment), `POS catalog migration missing ${fragment}`)
  assert.ok(!/customer|guest|order_guid|email|phone/i.test(migration), 'POS catalog migration must not add customer or order PII')

  const client = read('app_src/lib/integrations/toastClient.ts')
  for (const fragment of [
    "'/menus/v2/metadata'",
    "'/menus/v2/menus'",
    'getToastMenuCatalogV2',
    'Date.parse(metadata.sourceRevision) <= currentRevision',
    "reason: 'menus_scope_required'",
    "reason: 'menu_not_published'",
    'providerItemId',
    'providerSalesCategoryId',
  ]) assert.ok(client.includes(fragment), `Toast client missing ${fragment}`)
  assert.ok(client.indexOf("'/menus/v2/metadata'") < client.indexOf("'/menus/v2/menus'"), 'metadata must precede menus')

  const integration = read('app_src/lib/integrations/toastIntegrations.ts')
  for (const fragment of [
    "runtimeCredential(organizationId, 'standard')",
    'getToastMenuCatalogV2',
    'recordToastMenuCatalogUnavailableInPostgres',
    'recordToastMenuCatalogErrorInPostgres',
    'replaceToastMenuCatalogInPostgres',
  ]) assert.ok(integration.includes(fragment), `Toast catalog integration missing ${fragment}`)

  const persistence = read('app_src/lib/persistence/posCatalog.ts')
  for (const fragment of [
    'readPosCatalogFromPostgres',
    'readToastCatalogRefreshTargetsInPostgres',
    'replaceToastMenuCatalogInPostgres',
    'pg_advisory_xact_lock',
    'WHERE organization_id = $1::uuid',
    'location.organization_id = $1::uuid',
    'source_revision = $3::timestamptz',
  ]) assert.ok(persistence.includes(fragment), `POS catalog persistence missing ${fragment}`)
  assert.ok(!persistence.includes('organization_toast_credentials'), 'Catalog read model must not query credentials')
  assert.ok(!persistence.includes('console.'), 'Catalog persistence must not log data or secrets')

  const route = read('app_src/app/api/pos/catalog/route.ts')
  for (const fragment of [
    'requireRequestUser',
    'accountingCapabilities(actor)',
    'capabilities.canView',
    'capabilities.canManage',
    'activeAccountingOrganizationId(actor)',
    'refreshToastMenuCatalog',
    "'Cache-Control': 'private, no-store'",
  ]) assert.ok(route.includes(fragment), `POS catalog route missing ${fragment}`)
  assert.ok(
    !/clientSecret|accessToken|headers\.set\(['"]Authorization/i.test(route),
    'POS catalog route must not handle or expose secrets',
  )
}

function toastCredential() {
  return {
    accessType: 'standard',
    apiBaseUrl: 'https://ws-api.toasttab.com',
    clientId: 'standard-client-id',
    clientSecret: secretSentinel,
  }
}

function menuPayload(lastUpdated = sourceRevision) {
  const item = {
    name: 'Lunch special',
    guid: itemGuid,
    plu: 'PLU-42',
    price: 12.5,
    visibility: ['POS', 'KIOSK'],
    salesCategory: { guid: salesCategoryGuid, name: 'Food', plu: 'FOOD' },
  }
  return {
    restaurantGuid,
    lastUpdated,
    restaurantTimeZone: 'America/New_York',
    menus: [
      {
        guid: menuGuid,
        name: 'Lunch',
        visibility: ['POS'],
        menuGroups: [{
          guid: groupGuid,
          name: 'Entrees',
          visibility: ['POS'],
          menuItems: [item],
          menuGroups: [],
        }],
      },
      {
        guid: otherMenuGuid,
        name: 'Dinner',
        visibility: ['POS'],
        menuGroups: [{
          guid: otherGroupGuid,
          name: 'Specials',
          visibility: ['POS'],
          menuItems: [{ ...item, price: 15 }],
          menuGroups: [],
        }],
      },
    ],
  }
}

function toastFetchScenario({ metadataStatus = 200, menuStatus = 200, revision = sourceRevision } = {}) {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    requests.push({ target, init })
    if (target.endsWith('/authentication/v1/authentication/login')) {
      return new Response(JSON.stringify({ token: { accessToken: 'toast-access-token' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (target.endsWith('/menus/v2/metadata')) {
      const body = metadataStatus === 200
        ? { restaurantGuid, lastUpdated: revision }
        : { message: `remote response ${secretSentinel}` }
      return new Response(JSON.stringify(body), {
        status: metadataStatus,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (target.endsWith('/menus/v2/menus')) {
      const body = menuStatus === 200 ? menuPayload(revision) : { message: `remote response ${secretSentinel}` }
      return new Response(JSON.stringify(body), {
        status: menuStatus,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Unexpected Toast request ${target}`)
  }
  return { fetchImpl, requests }
}

async function verifyToastClient() {
  const updatedScenario = toastFetchScenario()
  const client = loadTypeScriptModule('app_src/lib/integrations/toastClient.ts', {
    globals: { fetch: updatedScenario.fetchImpl },
  })
  const updated = await client.getToastMenuCatalogV2({
    credential: toastCredential(),
    restaurantGuid,
    currentSourceRevision: '2026-07-18T15:00:00.000Z',
  })
  assert.equal(updated.status, 'updated')
  assert.deepEqual(updatedScenario.requests.map((entry) => new URL(entry.target).pathname), [
    '/authentication/v1/authentication/login',
    '/menus/v2/metadata',
    '/menus/v2/menus',
  ])
  assert.equal(updated.catalog.restaurantGuid, restaurantGuid)
  assert.equal(updated.catalog.providerRestaurantId, restaurantGuid)
  assert.equal(updated.catalog.menus.length, 2)
  assert.equal(updated.catalog.groups.length, 2)
  assert.equal(updated.catalog.items.length, 2)
  assert.deepEqual([...updated.catalog.items.map((item) => item.price)].sort((a, b) => a - b), [12.5, 15])
  assert.equal(updated.catalog.items[0].providerItemId, itemGuid)
  assert.equal(updated.catalog.items[0].plu, 'PLU-42')
  assert.equal(updated.catalog.salesCategories[0].providerSalesCategoryId, salesCategoryGuid)
  assert.ok(!JSON.stringify(updated).includes(secretSentinel), 'normalized menu output leaked the Toast secret')
  for (const request of updatedScenario.requests.slice(1)) {
    assert.equal(new Headers(request.init.headers).get('authorization'), 'Bearer toast-access-token')
    assert.equal(new Headers(request.init.headers).get('toast-restaurant-external-id'), restaurantGuid)
  }

  const unchangedScenario = toastFetchScenario()
  const unchangedClient = loadTypeScriptModule('app_src/lib/integrations/toastClient.ts', {
    globals: { fetch: unchangedScenario.fetchImpl },
  })
  const unchanged = await unchangedClient.getToastMenuCatalogV2({
    credential: toastCredential(), restaurantGuid, currentSourceRevision: sourceRevision,
  })
  assert.equal(unchanged.status, 'unchanged')
  assert.equal(unchangedScenario.requests.length, 2, 'unchanged metadata must not fetch /menus')

  const forcedScenario = toastFetchScenario()
  const forcedClient = loadTypeScriptModule('app_src/lib/integrations/toastClient.ts', {
    globals: { fetch: forcedScenario.fetchImpl },
  })
  const forced = await forcedClient.getToastMenuCatalogV2({
    credential: toastCredential(), restaurantGuid, currentSourceRevision: sourceRevision, force: true,
  })
  assert.equal(forced.status, 'updated')
  assert.equal(forcedScenario.requests.length, 3, 'force refresh must fetch /menus')

  for (const scenarioCase of [
    { metadataStatus: 403, menuStatus: 200, expectedReason: 'menus_scope_required', requestCount: 2 },
    { metadataStatus: 200, menuStatus: 404, expectedReason: 'menu_not_published', requestCount: 3 },
  ]) {
    const scenario = toastFetchScenario({
      metadataStatus: scenarioCase.metadataStatus,
      menuStatus: scenarioCase.menuStatus,
    })
    const unavailableClient = loadTypeScriptModule('app_src/lib/integrations/toastClient.ts', {
      globals: { fetch: scenario.fetchImpl },
    })
    const unavailable = await unavailableClient.getToastMenuCatalogV2({
      credential: toastCredential(), restaurantGuid, currentSourceRevision: null,
    })
    assert.equal(unavailable.status, 'unavailable')
    assert.equal(unavailable.reason, scenarioCase.expectedReason)
    assert.equal(scenario.requests.length, scenarioCase.requestCount)
    assert.ok(
      !JSON.stringify(unavailable).includes(secretSentinel),
      `${scenarioCase.menuStatus} unavailable result leaked a secret`,
    )
  }
}

async function verifySecureIntegrationReuse() {
  let credentialAccessType = null
  let clientInput = null
  const clientError = class ToastClientError extends Error {}
  const integration = loadTypeScriptModule('app_src/lib/integrations/toastIntegrations.ts', {
    mocks: {
      '@/lib/integrations/toastClient': {
        authenticateToast: async () => 'token',
        getToastMenuCatalogV2: async (input) => {
          clientInput = input
          return {
            status: 'unchanged',
            metadata: { restaurantGuid, sourceRevision },
            catalog: null,
          }
        },
        getToastStandardRestaurant: async () => ({}),
        listToastAnalyticsRestaurants: async () => [],
        normalizeToastApiBaseUrl: (value) => value,
        normalizeToastClientId: (value) => value,
        normalizeToastRestaurantGuid: (value) => value,
        ToastClientError: clientError,
      },
      '@/lib/integrations/toastCredentialCrypto': {
        decryptToastClientSecret: () => secretSentinel,
        encryptToastClientSecret: () => ({}),
        normalizeToastAccessType: (value) => {
          credentialAccessType = value
          return value
        },
        normalizeToastClientSecret: (value) => value,
        normalizeToastOrganizationId: (value) => value,
      },
      '@/lib/persistence/toastIntegrations': {
        readToastRuntimeCredentialFromPostgres: async () => ({
          apiBaseUrl: 'https://ws-api.toasttab.com',
          clientId: 'standard-client-id',
          secret: { ciphertext: Buffer.from('cipher'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) },
        }),
      },
      '@/lib/persistence/posCatalog': {
        readToastCatalogRefreshTargetsInPostgres: async () => [{
          restaurantGuid, restaurantName: 'Org A Restaurant', timezone: 'America/New_York', sourceRevision,
        }],
        recordToastMenuCatalogCheckInPostgres: async () => ({ status: 'unchanged', sourceRevision }),
        recordToastMenuCatalogErrorInPostgres: async () => ({ status: 'error' }),
        recordToastMenuCatalogUnavailableInPostgres: async () => ({ status: 'unavailable' }),
        replaceToastMenuCatalogInPostgres: async () => ({ status: 'ready' }),
        readPosCatalogFromPostgres: async (scopedOrganizationId) => ({
          organizationId: scopedOrganizationId, sourceProvider: 'toast', restaurants: [], menus: [], groups: [], items: [],
        }),
      },
    },
  })
  const result = await integration.refreshToastMenuCatalog({
    organizationId,
    actorEmail: 'owner@example.com',
    force: false,
  })
  assert.equal(credentialAccessType, 'standard')
  assert.equal(clientInput.credential.accessType, 'standard')
  assert.equal(clientInput.credential.clientSecret, secretSentinel)
  assert.equal(result.catalog.organizationId, organizationId)
  assert.ok(!JSON.stringify(result).includes(secretSentinel), 'integration response leaked the decrypted Toast secret')
}

async function verifyRouteAuthorization() {
  class RequestError extends Error {
    constructor(message, status = 400, code = 'REQUEST_INVALID') {
      super(message)
      this.status = status
      this.code = code
    }
  }
  let actor = { email: 'viewer@example.com', organizationId }
  let unauthorized = false
  let postgresEnabled = true
  let capabilities = { canView: true, canManage: false, canPrepare: false, canApprove: false }
  const reads = []
  const refreshes = []
  const route = loadTypeScriptModule('app_src/app/api/pos/catalog/route.ts', {
    mocks: {
      'next/server': {
        NextResponse: {
          json: (body, init = {}) => ({ body, status: init.status || 200, headers: init.headers || {} }),
        },
      },
      '@/lib/accountingAuthorization': {
        accountingCapabilities: () => capabilities,
        activeAccountingOrganizationId: (value) => {
          if (!value.organizationId) throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
          return value.organizationId
        },
      },
      '@/lib/integrations/toastIntegrations': {
        refreshToastMenuCatalog: async (input) => {
          refreshes.push(input)
          return { refresh: { force: input.force, locations: [] }, catalog: { organizationId: input.organizationId } }
        },
        sanitizedToastIntegrationError: (error) => error instanceof RequestError
          ? error
          : new RequestError('POS catalog is temporarily unavailable', 500, 'POS_CATALOG_INTERNAL_ERROR'),
        ToastIntegrationRequestError: RequestError,
      },
      '@/lib/persistence/config': { isPostgresStorageEnabled: () => postgresEnabled },
      '@/lib/persistence/posCatalog': {
        readPosCatalogFromPostgres: async (scopedOrganizationId) => {
          reads.push(scopedOrganizationId)
          return { organizationId: scopedOrganizationId, sourceProvider: 'toast', items: [] }
        },
      },
      '@/lib/requestUser': {
        requireRequestUser: async () => {
          if (unauthorized) throw new Error('Unauthorized')
          return actor
        },
      },
    },
  })
  const getRequest = { headers: new Headers(), nextUrl: new URL('https://clawpilot.test/api/pos/catalog') }
  const postRequest = (body, contentType = 'application/json') => ({
    headers: new Headers({ 'content-type': contentType }),
    text: async () => JSON.stringify(body),
    nextUrl: new URL('https://clawpilot.test/api/pos/catalog'),
  })

  unauthorized = true
  assert.equal((await route.GET(getRequest)).status, 401)
  unauthorized = false

  capabilities = { ...capabilities, canView: false }
  assert.equal((await route.GET(getRequest)).body.code, 'POS_CATALOG_VIEW_REQUIRED')
  assert.equal(reads.length, 0)

  capabilities = { ...capabilities, canView: true }
  actor = { ...actor, organizationId: null }
  assert.equal((await route.GET(getRequest)).body.code, 'ACTIVE_ORGANIZATION_REQUIRED')
  actor = { ...actor, organizationId }
  const firstTenant = await route.GET(getRequest)
  assert.equal(firstTenant.status, 200)
  assert.equal(firstTenant.body.catalog.organizationId, organizationId)

  actor = { ...actor, organizationId: otherOrganizationId }
  const secondTenant = await route.GET(getRequest)
  assert.equal(secondTenant.body.catalog.organizationId, otherOrganizationId)
  assert.deepEqual(reads, [organizationId, otherOrganizationId])

  capabilities = { ...capabilities, canManage: false }
  assert.equal((await route.POST(postRequest({ force: true }))).body.code, 'POS_CATALOG_MANAGE_REQUIRED')
  assert.equal(refreshes.length, 0)

  capabilities = { ...capabilities, canManage: true }
  actor = { ...actor, organizationId: null }
  assert.equal((await route.POST(postRequest({ force: true }))).body.code, 'ACTIVE_ORGANIZATION_REQUIRED')
  actor = { ...actor, organizationId }
  assert.equal((await route.POST(postRequest({ force: 'yes' }))).body.code, 'POS_CATALOG_REQUEST_INVALID')
  assert.equal((await route.POST(postRequest({}, 'text/plain'))).body.code, 'POS_CATALOG_CONTENT_TYPE_INVALID')
  const refreshed = await route.POST(postRequest({ force: true }))
  assert.equal(refreshed.status, 200)
  assert.equal(refreshes.length, 1)
  assert.equal(refreshes[0].organizationId, organizationId)
  assert.equal(refreshes[0].force, true)
  assert.equal(refreshes[0].actorEmail, actor.email)
  assert.ok(!JSON.stringify(refreshed).includes(secretSentinel), 'route response leaked a secret')

  postgresEnabled = false
  assert.equal((await route.GET(getRequest)).body.code, 'POS_CATALOG_POSTGRES_REQUIRED')
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    env: { ...process.env, ...options.env },
  })
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`${commandName} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return String(result.stdout || '').trim()
}

async function waitForPostgres(pool) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1')
      return
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

function persistenceCatalog(revision = sourceRevision) {
  return {
    restaurantGuid,
    sourceProvider: 'toast',
    providerRestaurantId: restaurantGuid,
    sourceRevision: revision,
    restaurantTimeZone: 'America/New_York',
    menus: [{
      menuGuid, sourceProvider: 'toast', providerMenuId: menuGuid, name: 'Lunch',
      visibility: ['POS'], active: true, archived: false, position: 0,
    }],
    groups: [{
      menuGuid, groupGuid, parentGroupGuid: null, sourceProvider: 'toast', providerGroupId: groupGuid,
      name: 'Entrees', visibility: ['POS'], active: true, archived: false, position: 0,
    }],
    items: [{
      menuGuid, groupGuid, itemGuid, sourceProvider: 'toast', providerItemId: itemGuid,
      name: 'Lunch special', plu: 'PLU-42', price: 12.5, visibility: ['POS'],
      salesCategoryGuid, providerSalesCategoryId: salesCategoryGuid,
      active: true, archived: false, position: 0,
    }],
    salesCategories: [{
      salesCategoryGuid, sourceProvider: 'toast', providerSalesCategoryId: salesCategoryGuid,
      name: 'Food', plu: 'FOOD', active: true, archived: false,
    }],
  }
}

async function verifyDisposablePostgres() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-pos-catalog-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  let pool
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_catalog',
      '-e', 'POSTGRES_DB=clawpilot_catalog',
      '-p', '127.0.0.1::5432',
      'postgres:16-alpine',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(port > 0, `Unable to resolve disposable PostgreSQL port from ${portOutput}`)
    pool = new Pool({
      connectionString: `postgresql://postgres:clawpilot_catalog@127.0.0.1:${port}/clawpilot_catalog`,
      connectionTimeoutMillis: 2000,
    })
    await waitForPostgres(pool)
    await pool.query(`
      CREATE TABLE workspace_organizations (id uuid PRIMARY KEY);
      CREATE TABLE toast_locations (
        organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
        restaurant_guid uuid NOT NULL,
        restaurant_name text NOT NULL,
        timezone text,
        active boolean NOT NULL DEFAULT true,
        archived boolean NOT NULL DEFAULT false,
        standard_access boolean NOT NULL DEFAULT false,
        selected boolean NOT NULL DEFAULT false,
        PRIMARY KEY (organization_id, restaurant_guid)
      );
    `)
    await pool.query(read('db/migrations/0070_toast_menu_catalog.sql'))
    await pool.query(
      `INSERT INTO workspace_organizations (id) VALUES ($1::uuid), ($2::uuid)`,
      [organizationId, otherOrganizationId],
    )
    await pool.query(
      `INSERT INTO toast_locations (
         organization_id, restaurant_guid, restaurant_name, timezone,
         active, archived, standard_access, selected
       ) VALUES
         ($1::uuid, $3::uuid, 'Org A Restaurant', 'America/New_York', true, false, true, true),
         ($2::uuid, $3::uuid, 'Org B Restaurant', 'America/Chicago', true, false, true, true)`,
      [organizationId, otherOrganizationId, restaurantGuid],
    )

    const postgresMock = {
      query: (sql, params = []) => pool.query(sql, params),
      withTransaction: async (work) => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await work(client)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      },
    }
    const persistence = loadTypeScriptModule('app_src/lib/persistence/posCatalog.ts', {
      mocks: { '@/lib/persistence/postgres': postgresMock },
    })
    const snapshot = persistenceCatalog()
    const first = await persistence.replaceToastMenuCatalogInPostgres({
      organizationId, restaurantName: 'Org A Restaurant', catalog: snapshot,
    })
    const second = await persistence.replaceToastMenuCatalogInPostgres({
      organizationId, restaurantName: 'Org A Restaurant', catalog: snapshot,
    })
    assert.equal(first.applied, true)
    assert.equal(second.applied, true)
    const counts = await pool.query(`
      SELECT
        (SELECT count(*) FROM toast_menu_catalog_restaurants WHERE organization_id = $1::uuid)::int AS restaurants,
        (SELECT count(*) FROM toast_menu_catalog_menus WHERE organization_id = $1::uuid)::int AS menus,
        (SELECT count(*) FROM toast_menu_catalog_groups WHERE organization_id = $1::uuid)::int AS groups,
        (SELECT count(*) FROM toast_menu_catalog_items WHERE organization_id = $1::uuid)::int AS items,
        (SELECT count(*) FROM toast_menu_catalog_sales_categories WHERE organization_id = $1::uuid)::int AS categories
    `, [organizationId])
    assert.deepEqual(counts.rows[0], { restaurants: 1, menus: 1, groups: 1, items: 1, categories: 1 })

    const orgA = await persistence.readPosCatalogFromPostgres(organizationId)
    const orgBBefore = await persistence.readPosCatalogFromPostgres(otherOrganizationId)
    assert.equal(orgA.items.length, 1)
    assert.equal(orgA.items[0].providerItemId, itemGuid)
    assert.equal(orgBBefore.items.length, 0)
    assert.ok(!JSON.stringify(orgA).includes(secretSentinel), 'Postgres catalog read leaked a secret')

    await persistence.replaceToastMenuCatalogInPostgres({
      organizationId: otherOrganizationId,
      restaurantName: 'Org B Restaurant',
      catalog: { ...snapshot, restaurantTimeZone: 'America/Chicago' },
    })
    const orgBAfter = await persistence.readPosCatalogFromPostgres(otherOrganizationId)
    assert.equal(orgBAfter.items.length, 1)
    assert.equal(orgBAfter.restaurants[0].name, 'Org B Restaurant')
    assert.equal((await persistence.readPosCatalogFromPostgres(organizationId)).restaurants[0].name, 'Org A Restaurant')

    await persistence.recordToastMenuCatalogUnavailableInPostgres({
      organizationId,
      restaurantGuid,
      sourceRevision: '2026-07-19T16:00:00.000Z',
      reason: 'menus_scope_required',
      errorCode: 'TOAST_MENUS_SCOPE_REQUIRED',
    })
    const unavailable = await persistence.readPosCatalogFromPostgres(organizationId)
    assert.equal(unavailable.sync.locations[0].status, 'unavailable')
    assert.equal(unavailable.sync.locations[0].unavailableReason, 'menus_scope_required')
    assert.equal(unavailable.sync.locations[0].sourceRevision, sourceRevision)
    assert.equal(unavailable.sync.locations[0].observedSourceRevision, '2026-07-19T16:00:00.000Z')
    assert.equal(unavailable.items.length, 1, 'unavailable refresh damaged the prior catalog')
    assert.equal(unavailable.items[0].active, true)
    assert.equal(
      (await persistence.readToastCatalogRefreshTargetsInPostgres(organizationId))[0].sourceRevision,
      sourceRevision,
      'an unavailable metadata revision must remain retryable',
    )

    const newerRevision = '2026-07-20T15:00:00.000Z'
    await persistence.replaceToastMenuCatalogInPostgres({
      organizationId,
      restaurantName: 'Org A Restaurant',
      catalog: { ...snapshot, sourceRevision: newerRevision, items: [] },
    })
    const archived = await persistence.readPosCatalogFromPostgres(organizationId)
    assert.equal(archived.items.length, 1)
    assert.equal(archived.items[0].active, false)
    assert.equal(archived.items[0].archived, true)

    const stale = await persistence.replaceToastMenuCatalogInPostgres({
      organizationId,
      restaurantName: 'Org A Restaurant',
      catalog: snapshot,
    })
    assert.equal(stale.applied, false)
    assert.equal((await persistence.readPosCatalogFromPostgres(organizationId)).items[0].active, false)
  } finally {
    if (pool) await pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '-t', '1', container], { cwd: root, encoding: 'utf8', timeout: 20_000 })
  }
}

async function main() {
  verifySourceContracts()
  await verifyToastClient()
  await verifySecureIntegrationReuse()
  await verifyRouteAuthorization()
  if (!contractsOnly) await verifyDisposablePostgres()
  console.log(`POS catalog contracts passed${contractsOnly ? '' : ' with disposable PostgreSQL'}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
