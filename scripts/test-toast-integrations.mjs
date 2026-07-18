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
]) {
  assert.ok(persistence.includes(fragment), `Toast persistence contract missing ${fragment}`)
}
assert.ok(!persistence.includes('console.'), 'Toast persistence must not log credentials or payloads')

const route = read('app_src/app/api/integrations/toast/route.ts')
for (const fragment of [
  'requireRequestUser',
  'actor.role !== \'owner\'',
  'permissions.manageUserAccess',
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
const organizationId = '11111111-1111-4111-8111-111111111111'
const otherOrganizationId = '22222222-2222-4222-8222-222222222222'
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
const restaurantGuid = '33333333-3333-4333-8333-333333333333'
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
