#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const organizationId = '11111111-1111-4111-8111-111111111111'
const otherOrganizationId = '22222222-2222-4222-8222-222222222222'
const restaurantGuid = '33333333-3333-4333-8333-333333333333'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, { mocks = {}, fetchImpl = fetch } = {}) {
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
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    fetch: fetchImpl,
    module,
    process,
    setTimeout,
    structuredClone,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const migration = read('db/migrations/0059_toast_restaurant_integrations.sql')
for (const fragment of [
  "access_type IN ('analytics', 'standard')",
  'client_secret_ciphertext bytea NOT NULL',
  'PRIMARY KEY (organization_id, access_type)',
  'CREATE TABLE IF NOT EXISTS toast_locations',
  'CREATE TABLE IF NOT EXISTS toast_sync_outbox',
  'UNIQUE (organization_id, restaurant_guid, sync_kind, business_date)',
  'CREATE TABLE IF NOT EXISTS toast_source_snapshots',
  'payload_hash text NOT NULL',
  'CREATE TABLE IF NOT EXISTS toast_daily_sales',
  'CREATE TABLE IF NOT EXISTS toast_accounting_mappings',
  'CREATE TABLE IF NOT EXISTS toast_accounting_export_drafts',
  "status IN ('needs_mapping', 'needs_review', 'approved', 'posting', 'posted', 'failed', 'voided')",
]) {
  assert.ok(migration.includes(fragment), `Toast migration missing ${fragment}`)
}
assert.ok(!migration.includes('client_secret text'), 'Toast migration must not store a plaintext client secret')

const persistence = read('app_src/lib/persistence/toastIntegrations.ts')
for (const fragment of [
  'WHERE organization_id = $1',
  'FOR UPDATE SKIP LOCKED',
  "'toast.credential.updated'",
  "'toast.sync.queued'",
  'refreshToastAccountingDraftInPostgres',
  'idempotency_key',
  'reporting: ToastReportingState',
  "result_summary ->> 'records'",
  'WHERE organization_id = $1::uuid\n       GROUP BY sync_kind',
]) {
  assert.ok(persistence.includes(fragment), `Toast persistence contract missing ${fragment}`)
}
assert.ok(!persistence.includes('console.'), 'Toast persistence must not log credentials or payloads')

const tenantQueries = []
const tenantPersistence = loadTypeScriptModule('app_src/lib/persistence/toastIntegrations.ts', {
  mocks: {
    '@/lib/persistence/postgres': {
      query: async (sql, params = []) => {
        tenantQueries.push({ sql: String(sql), params: [...params] })
        const organization = String(params[0] || '')
        if (organization !== organizationId) return { rows: [], rowCount: 0 }
        if (String(sql).includes('FROM organization_toast_credentials')) {
          return {
            rows: [{
              organization_id: organizationId,
              access_type: 'standard',
              api_base_url: 'https://ws-api.toasttab.com',
              client_id: 'standard-client-id',
              client_secret_ciphertext: Buffer.from('ciphertext'),
              client_secret_iv: Buffer.alloc(12),
              client_secret_tag: Buffer.alloc(16),
              client_secret_last_four: 'ABCD',
              credential_version: 1,
              sync_enabled: true,
              verified_at: '2026-07-17T12:00:00.000Z',
              last_error_code: null,
              updated_at: '2026-07-17T12:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        if (String(sql).includes('FROM toast_locations')) {
          return {
            rows: [{
              organization_id: organizationId,
              restaurant_guid: restaurantGuid,
              restaurant_name: 'Test Restaurant',
              location_name: null,
              location_code: null,
              timezone: 'America/New_York',
              active: true,
              test_mode: false,
              archived: false,
              analytics_access: false,
              standard_access: true,
              selected: true,
              last_verified_at: '2026-07-17T12:00:00.000Z',
              updated_at: '2026-07-17T12:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        if (String(sql).includes('GROUP BY sync_kind')) {
          return {
            rows: [{
              sync_kind: 'standard_orders',
              successful_jobs: '2',
              failed_jobs: '0',
              business_dates: '2',
              records: '0',
              latest_business_date: '2026-07-17',
            }],
            rowCount: 1,
          }
        }
        if (String(sql).includes('FROM toast_daily_sales')) {
          return {
            rows: [{
              business_days: '2',
              first_business_date: '2026-07-16',
              latest_business_date: '2026-07-17',
              locations_with_data: '1',
              gross_sales: '0',
              net_sales: '0',
              discounts: '0',
              voids: '0',
              refunds: '0',
              orders_count: '0',
              guest_count: '0',
              standard_orders_count: '0',
              analytics_rows: '0',
            }],
            rowCount: 1,
          }
        }
        if (String(sql).includes('max(completed_at)')) {
          return { rows: [{ latest: '2026-07-17T12:00:00.000Z' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
      withTransaction: async (work) => work({ query: async () => ({ rows: [], rowCount: 0 }) }),
    },
  },
})
const tenantState = await tenantPersistence.readToastIntegrationStateFromPostgres(organizationId)
assert.equal(tenantState.reporting.noDataReason, 'no_records')
assert.equal(tenantState.reporting.datasets.standardOrders.businessDates, 2)
assert.equal(tenantState.reporting.datasets.standardOrders.records, 0)
const firstTenantQueryCount = tenantQueries.length
await tenantPersistence.readToastIntegrationStateFromPostgres(otherOrganizationId)
assert.ok(tenantQueries.slice(0, firstTenantQueryCount).every((entry) => entry.params[0] === organizationId))
assert.ok(tenantQueries.slice(firstTenantQueryCount).every((entry) => entry.params[0] === otherOrganizationId))
assert.equal(tenantState.organizationId, organizationId)

const panel = read('app_src/components/settings/ToastIntegrationPanel.tsx')
for (const fragment of [
  'Data available',
  'Guests',
  'Restaurant profiles',
  'Standard orders',
  'Analytics sales',
  'Analytics payouts',
  'Coverage ${integration.reporting.firstBusinessDate} through ${integration.reporting.latestBusinessDate}',
  'No completed Toast records were returned for the synced business dates.',
]) {
  assert.ok(panel.includes(fragment), `Toast reporting panel missing ${fragment}`)
}

const route = read('app_src/app/api/integrations/toast/route.ts')
for (const fragment of [
  'requireRequestUser',
  'effectiveAuthorizationRole(actor)',
  "role !== 'owner'",
  'permissions.manageUserAccess',
  'requireManager(actor)',
  "action === 'update-credential'",
  "action === 'queue-sync'",
  "action === 'disconnect'",
  "'Cache-Control': 'no-store'",
]) {
  assert.ok(route.includes(fragment), `Toast route contract missing ${fragment}`)
}
assert.ok(!route.includes('clientSecretLastFour: body.clientSecret'), 'Toast API must not echo the submitted secret')

const settings = read('app_src/components/settings/IntegrationSettingsPanel.tsx')
assert.ok(settings.includes('const integrations = isOwner'), 'integration navigation must distinguish owner-only controls')
assert.ok(settings.includes("{ key: 'toast' as const"), 'organization managers must receive the Toast tab')
assert.ok(settings.includes("activeIntegration === 'google' && isOwner"), 'Google Workspace must remain owner-only')
assert.ok(settings.includes("activeIntegration === 'knowledge' && isOwner"), 'knowledge settings must remain owner-only')

process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY = 'toast-test-encryption-key-0123456789abcdef'
const cryptoModule = loadTypeScriptModule('app_src/lib/integrations/toastCredentialCrypto.ts', {
  mocks: {
    crypto,
    '@/lib/persistence/config': { isHostedRuntime: () => false },
  },
})
const secret = 'toast-client-secret-00000000-ABCD'
const encrypted = cryptoModule.encryptToastClientSecret(secret, organizationId, 'analytics')
assert.equal(encrypted.iv.length, 12)
assert.equal(encrypted.tag.length, 16)
assert.ok(!encrypted.ciphertext.includes(Buffer.from(secret)))
assert.equal(cryptoModule.decryptToastClientSecret(encrypted, organizationId, 'analytics'), secret)
assert.throws(
  () => cryptoModule.decryptToastClientSecret(encrypted, organizationId, 'standard'),
  /could not be decrypted/,
  'access-type AAD must isolate the two Toast credentials',
)
assert.throws(
  () => cryptoModule.decryptToastClientSecret(encrypted, otherOrganizationId, 'analytics'),
  /could not be decrypted/,
  'organization AAD must reject cross-tenant decryption',
)

const requests = []
const reportGuid = '44444444-4444-4444-8444-444444444444'
const toastFetch = async (url, init = {}) => {
  requests.push({ url: String(url), init })
  if (String(url).endsWith('/authentication/v1/authentication/login')) {
    return new Response(JSON.stringify({ token: { accessToken: 'access-token' } }), { status: 200 })
  }
  if (String(url).endsWith('/era/v1/restaurants-information')) {
    return new Response(JSON.stringify([{ restaurantGuid, restaurantName: 'Test Restaurant', active: true }]), { status: 200 })
  }
  if (String(url).includes(`/restaurants/v1/restaurants/${restaurantGuid}`)) {
    return new Response(JSON.stringify({ general: { name: 'Test Restaurant', timeZone: 'America/New_York' } }), { status: 200 })
  }
  if (String(url).endsWith('/era/v1/metrics') && init.method === 'POST') {
    return new Response(JSON.stringify(reportGuid), { status: 200 })
  }
  if (String(url).endsWith(`/era/v1/metrics/${reportGuid}`)) {
    return new Response('', { status: 202 })
  }
  if (String(url).includes('/orders/v2/ordersBulk')) {
    return new Response(JSON.stringify([]), { status: 200 })
  }
  throw new Error(`Unexpected Toast request ${url}`)
}

const clientModule = loadTypeScriptModule('app_src/lib/integrations/toastClient.ts', { fetchImpl: toastFetch })
const analyticsCredential = {
  accessType: 'analytics',
  apiBaseUrl: 'https://ws-api.toasttab.com',
  clientId: 'analytics-client-id',
  clientSecret: secret,
}
const standardCredential = { ...analyticsCredential, accessType: 'standard', clientId: 'standard-client-id' }

assert.equal(clientModule.normalizeToastApiBaseUrl('https://ws-api.toasttab.com/'), 'https://ws-api.toasttab.com')
for (const unsafeUrl of [
  'http://ws-api.toasttab.com',
  'https://ws-api.toasttab.com.evil.example',
  'https://user@ws-api.toasttab.com',
  'https://ws-api.toasttab.com:444',
  'https://ws-api.toasttab.com/orders',
]) {
  assert.throws(() => clientModule.normalizeToastApiBaseUrl(unsafeUrl), /Toast API access URL/)
}
assert.equal(clientModule.formatToastBusinessDate('2026-07-16'), '20260716')
assert.throws(() => clientModule.formatToastBusinessDate('2026-02-30'), /invalid/)

const restaurants = await clientModule.listToastAnalyticsRestaurants(analyticsCredential)
assert.equal(restaurants.length, 1)
assert.equal(restaurants[0].restaurantGuid, restaurantGuid)
assert.equal(requests[0].init.method, 'POST')
assert.deepEqual(JSON.parse(requests[0].init.body), {
  clientId: 'analytics-client-id',
  clientSecret: secret,
  userAccessType: 'TOAST_MACHINE_CLIENT',
})
assert.equal(requests[1].init.headers.get('Authorization'), 'Bearer access-token')

const standardRestaurant = await clientModule.getToastStandardRestaurant(standardCredential, restaurantGuid)
assert.equal(standardRestaurant.timezone, 'America/New_York')
const standardRequest = requests.find((entry) => entry.url.includes('/restaurants/v1/restaurants/'))
assert.equal(standardRequest.init.headers.get('Toast-Restaurant-External-ID'), restaurantGuid)

const sales = await clientModule.getToastAnalyticsSales({
  credential: analyticsCredential,
  restaurantGuid,
  businessDate: '2026-07-16',
})
assert.equal(sales.ready, false)
assert.equal(sales.requestGuid, reportGuid)
const metricsRequest = requests.find((entry) => entry.url.endsWith('/era/v1/metrics') && entry.init.method === 'POST')
assert.deepEqual(JSON.parse(metricsRequest.init.body).groupBy, ['REVENUE_CENTER'])

const orders = await clientModule.getToastStandardOrders({
  credential: standardCredential,
  restaurantGuid,
  businessDate: '2026-07-16',
})
assert.equal(orders.length, 0)
const ordersRequest = requests.find((entry) => entry.url.includes('/orders/v2/ordersBulk'))
assert.equal(ordersRequest.init.headers.get('Toast-Restaurant-External-ID'), restaurantGuid)

const worker = read('app_src/lib/toastSyncWorker.ts')
assert.ok(worker.includes('refreshToastAccountingDraftInPostgres'), 'Toast worker must produce reviewable accounting drafts')
assert.ok(worker.includes('deferToastSyncJobInPostgres'), 'Toast worker must support asynchronous Analytics reports')
assert.ok(!worker.includes('quickbooks'), 'Toast ingestion worker must not post directly to QuickBooks')

console.log('Toast integration contracts passed')
