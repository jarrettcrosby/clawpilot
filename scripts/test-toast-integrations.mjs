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
  "GROUP BY CASE WHEN sync_kind = 'standard_order_updates' THEN 'standard_orders' ELSE sync_kind END",
  "syncKind: 'analytics_sales' | 'analytics_payouts' | 'standard_orders' | 'standard_order_updates'",
  "COALESCE(locked_at, updated_at) < now() - interval '15 minutes'",
  'AND lock_token = $4::uuid',
  'AND lock_token = $3::uuid',
  'rerun_requested_at',
  'make_interval(secs => $6::integer)',
  "CASE WHEN rerun_requested_at IS NULL THEN 'succeeded' ELSE 'pending' END",
  'canonicalReadinessVerified: false',
]) {
  assert.ok(persistence.includes(fragment), `Toast persistence contract missing ${fragment}`)
}
assert.ok(!persistence.includes('console.'), 'Toast persistence must not log credentials or payloads')
assert.ok(!persistence.includes("status = 'pending', attempt_count = 0"), 'automatic Toast sync must not resurrect terminal jobs')

const posMigration = read('db/migrations/0067_toast_pos_orders.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS toast_pos_orders',
]) {
  assert.ok(posMigration.includes(fragment), `Toast POS migration missing ${fragment}`)
}

const workerHardeningMigration = read('db/migrations/0073_toast_sync_worker_hardening.sql')
for (const fragment of [
  'ADD COLUMN IF NOT EXISTS lock_token uuid',
  "'standard_order_updates'",
  "'deployment.database.identity'",
]) {
  assert.ok(workerHardeningMigration.includes(fragment), `Toast worker hardening migration missing ${fragment}`)
}

const rerunMigration = read('db/migrations/0072_toast_sync_rerun_requests.sql')
assert.ok(
  rerunMigration.includes('ADD COLUMN IF NOT EXISTS rerun_requested_at timestamptz'),
  'Toast rerun migration must add the durable follow-up marker',
)

const notificationMigration = read('db/migrations/0074_pos_accounting_issue_notifications.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS pos_accounting_issue_states',
  'CREATE TABLE IF NOT EXISTS pos_accounting_notification_outbox',
  'issue_fingerprint text NOT NULL',
  'issues jsonb NOT NULL',
  'pos_accounting_notification_delivery_unique',
  "status IN ('pending', 'processing', 'failed', 'succeeded', 'dead', 'cancelled')",
]) {
  assert.ok(notificationMigration.includes(fragment), `POS accounting notification migration missing ${fragment}`)
}

const notificationConsentMigration = read('db/migrations/0076_pos_accounting_notification_consent.sql')
for (const fragment of [
  'email_notifications_enabled boolean NOT NULL DEFAULT false',
  'email_notifications_enabled_at timestamptz',
  'pos_accounting_notification_recipient_deliverable',
  "recipient_email = 'demo-system@clawpilot.example'",
]) {
  assert.ok(notificationConsentMigration.includes(fragment), `POS accounting notification consent migration missing ${fragment}`)
}

const zeroSalesDraftMigration = read('db/migrations/0077_zero_sales_accounting_draft_suppression.sql')
for (const fragment of [
  "draft.status NOT IN ('approved', 'posting', 'posted')",
  'sales.orders_count = 0',
  'sales.standard_orders_count = 0',
  'sales.refunds = 0',
  'sales.standard_refunds = 0',
  "SET status = 'resolved'",
  "SET status = 'cancelled'",
  'DELETE FROM toast_accounting_export_drafts draft',
]) {
  assert.ok(zeroSalesDraftMigration.includes(fragment), `Zero-sales draft migration missing ${fragment}`)
}

const toastWorker = read('app_src/lib/toastSyncWorker.ts')
for (const fragment of [
  'reconcilePosAccountingIssueForDateInPostgres',
  'processPosAccountingNotificationOutbox',
  'reconcileStaleOpenPosAccountingIssuesInPostgres',
  'refreshAccountingState',
]) {
  assert.ok(toastWorker.includes(fragment), `Toast worker notification integration missing ${fragment}`)
}

const tenantQueries = []
const toastOrderProjection = loadTypeScriptModule('app_src/lib/integrations/toastOrderProjection.ts')
const tenantPersistence = loadTypeScriptModule('app_src/lib/persistence/toastIntegrations.ts', {
  mocks: {
    '@/lib/integrations/toastOrderProjection': toastOrderProjection,
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
        if (String(sql).includes("GROUP BY CASE WHEN sync_kind = 'standard_order_updates'")) {
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

const queueQueries = []
const queuePersistence = loadTypeScriptModule('app_src/lib/persistence/toastIntegrations.ts', {
  mocks: {
    '@/lib/integrations/toastOrderProjection': toastOrderProjection,
    '@/lib/persistence/postgres': {
      query: async () => ({ rows: [], rowCount: 0 }),
      withTransaction: async (work) => work({
        query: async (sql, params = []) => {
          const source = String(sql)
          queueQueries.push({ source, params: [...params] })
          if (source.includes('SELECT access_type FROM organization_toast_credentials')) {
            return { rows: [{ access_type: 'analytics' }, { access_type: 'standard' }], rowCount: 2 }
          }
          if (source.includes('SELECT restaurant_guid::text, analytics_access, standard_access')) {
            return {
              rows: [{ restaurant_guid: restaurantGuid, analytics_access: true, standard_access: true }],
              rowCount: 1,
            }
          }
          return { rows: [], rowCount: 1 }
        },
      }),
    },
  },
})
await queuePersistence.queueToastSyncForDateInPostgres({
  organizationId,
  businessDate: '2026-07-18',
  actorEmail: 'manager@example.test',
})
const manualQueueCalls = queueQueries.filter((entry) => entry.source.includes('INSERT INTO toast_sync_outbox'))
assert.equal(manualQueueCalls.length, 3)
assert.ok(manualQueueCalls.every((entry) => entry.params[5] === 0), 'manual Toast sync must rerun completed jobs')
assert.ok(manualQueueCalls.every((entry) => entry.source.includes("status = 'processing' THEN now()")))

const zeroAccountingSales = {
  gross_sales: '0', net_sales: '0', discounts: '0', voids: '0', refunds: '0',
  orders_count: 0, standard_orders_count: 0,
  standard_gross_sales: '0', standard_net_sales: '0', standard_discounts: '0',
  standard_voids: '0', standard_refunds: '0', standard_tax: '0', standard_tips: '0',
  standard_service_charges: '0', standard_tendered: '0', standard_total: '0',
  standard_cash: '0', standard_card: '0', standard_other_tender: '0',
}
let accountingSales = zeroAccountingSales
const accountingDraftQueries = []
const accountingDraftPersistence = loadTypeScriptModule('app_src/lib/persistence/toastIntegrations.ts', {
  mocks: {
    '@/lib/integrations/toastOrderProjection': toastOrderProjection,
    '@/lib/persistence/postgres': {
      query: async (sql, params = []) => {
        const source = String(sql)
        accountingDraftQueries.push({ source, params: [...params] })
        if (source.includes('FROM toast_daily_sales')) return { rows: [accountingSales], rowCount: 1 }
        if (source.includes('FROM toast_sync_outbox')) {
          return { rows: [{ sync_kind: 'standard_orders', status: 'succeeded' }], rowCount: 1 }
        }
        if (source.includes('FROM toast_accounting_mappings')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      },
      withTransaction: async (work) => work({ query: async () => ({ rows: [], rowCount: 0 }) }),
    },
  },
})
async function accountingDraftRefreshQueries(sales, businessDate) {
  accountingSales = { ...zeroAccountingSales, ...sales }
  accountingDraftQueries.length = 0
  await accountingDraftPersistence.refreshToastAccountingDraftInPostgres({
    organizationId,
    restaurantGuid,
    businessDate,
    syncKind: 'standard_orders',
  })
  return [...accountingDraftQueries]
}

const zeroDraftQueries = await accountingDraftRefreshQueries({}, '2026-08-01')
assert.equal(zeroDraftQueries.filter((entry) => entry.source.includes('DELETE FROM toast_accounting_export_drafts')).length, 1)
assert.equal(zeroDraftQueries.filter((entry) => entry.source.includes('INSERT INTO toast_accounting_export_drafts')).length, 0)
assert.ok(zeroDraftQueries.some((entry) => entry.source.includes("status NOT IN ('approved', 'posting', 'posted')")))

for (const [label, businessDate, activity] of [
  ['standard refund', '2026-08-02', { standard_refunds: '12.34' }],
  ['Analytics refund', '2026-08-03', { refunds: '-9.87' }],
  ['nonzero accounting amount', '2026-08-04', { standard_tax: '0.01' }],
  ['zero-value order', '2026-08-05', { orders_count: 1 }],
]) {
  const queries = await accountingDraftRefreshQueries(activity, businessDate)
  assert.equal(queries.filter((entry) => entry.source.includes('DELETE FROM toast_accounting_export_drafts')).length, 0, `${label} must not delete a draft`)
  assert.equal(queries.filter((entry) => entry.source.includes('INSERT INTO toast_accounting_export_drafts')).length, 1, `${label} must retain a draft`)
}

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

const updatedOrders = await clientModule.getToastStandardOrderUpdates({
  credential: standardCredential,
  restaurantGuid,
  startDate: '2026-07-16T00:00:00.000Z',
  endDate: '2026-07-17T00:00:00.000Z',
})
assert.equal(updatedOrders.length, 0)
const updateRequest = requests.find((entry) => entry.url.includes('startDate=2026-07-16T00%3A00%3A00.000Z'))
assert.ok(updateRequest, 'Toast modified-order query must use an explicit modification window')
assert.ok(updateRequest.url.includes('endDate=2026-07-17T00%3A00%3A00.000Z'))

const worker = read('app_src/lib/toastSyncWorker.ts')
assert.ok(worker.includes('refreshToastAccountingDraftInPostgres'), 'Toast worker must produce reviewable accounting drafts')
assert.ok(worker.includes('deferToastSyncJobInPostgres'), 'Toast worker must support asynchronous Analytics reports')
assert.ok(worker.includes("job.syncKind === 'standard_order_updates'"), 'Toast worker must poll modified orders')
assert.ok(worker.includes('getToastStandardOrders({ credential, restaurantGuid: job.restaurantGuid, businessDate })'),
  'modified-order sync must refresh complete affected business days')
assert.ok(worker.includes('catchUpDates(target.latestStandardUpdateDate, businessDate)'),
  'Toast worker must catch up missed modified-order windows')
assert.ok(!worker.includes('quickbooks'), 'Toast ingestion worker must not post directly to QuickBooks')

const health = read('app_src/app/api/health/route.ts')
assert.ok(health.includes('Toast sync queue has terminal failed jobs.'))
assert.ok(health.includes('Toast sync queue has stale processing jobs.'))
assert.ok(health.includes('integrationQueues'))
assert.ok(health.includes("WHERE organization.is_demo = false"))

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${commandName} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return String(result.stdout || '').trim()
}

async function waitForPostgres(pool) {
  const deadline = Date.now() + 45_000
  let lastError
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (error) {
      lastError = error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
  }
  throw lastError || new Error('PostgreSQL did not become ready')
}

async function runToastOutboxPostgresAcceptance() {
  const dockerInfo = spawnSync('docker', ['info'], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  if (dockerInfo.status !== 0) {
    console.log('Toast outbox disposable PostgreSQL acceptance skipped: Docker is unavailable')
    return
  }
  const container = `clawpilot-toast-outbox-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  let pool
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_toast',
      '-e', 'POSTGRES_DB=clawpilot_toast',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const postgresPort = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(postgresPort > 0, `Unable to resolve disposable PostgreSQL port from ${portOutput}`)
    const databaseUrl = `postgresql://postgres:clawpilot_toast@127.0.0.1:${postgresPort}/clawpilot_toast`
    pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 })
    await waitForPostgres(pool)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    const actorEmail = 'toast-manager@example.test'
    await pool.query(
      `INSERT INTO app_users (email, role, status) VALUES ($1, 'owner', 'active')`,
      [actorEmail],
    )
    await pool.query(
      `INSERT INTO workspace_organizations (id, name, organization_type, created_by)
       VALUES ($1::uuid, 'Toast Queue Acceptance', 'root', $2)`,
      [organizationId, actorEmail],
    )
    await pool.query(
      `INSERT INTO organization_toast_credentials (
         organization_id, access_type, api_base_url, client_id,
         client_secret_ciphertext, client_secret_iv, client_secret_tag, client_secret_last_four,
         sync_enabled, verified_at, created_by, updated_by
       ) VALUES
         ($1::uuid, 'analytics', 'https://ws-api.toasttab.com', 'analytics-client', '\\x01', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), '0001', true, now(), $2, $2),
         ($1::uuid, 'standard', 'https://ws-api.toasttab.com', 'standard-client', '\\x02', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), '0002', true, now(), $2, $2)`,
      [organizationId, actorEmail],
    )
    await pool.query(
      `INSERT INTO toast_locations (
         organization_id, restaurant_guid, restaurant_name, active,
         analytics_access, standard_access, selected, last_verified_at
       ) VALUES ($1::uuid, $2::uuid, 'Toast Acceptance Restaurant', true, true, true, true, now())`,
      [organizationId, restaurantGuid],
    )

    const databasePersistence = loadTypeScriptModule('app_src/lib/persistence/toastIntegrations.ts', {
      mocks: {
        '@/lib/integrations/toastOrderProjection': toastOrderProjection,
        '@/lib/persistence/postgres': {
          query: (sql, params) => pool.query(sql, params),
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
        },
      },
    })

    const runtimeDraftDates = [
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]
    await pool.query(
      `INSERT INTO toast_daily_sales (organization_id, restaurant_guid, business_date)
       SELECT $1::uuid, $2::uuid, dates.business_date
       FROM unnest($3::date[]) AS dates(business_date)`,
      [organizationId, restaurantGuid, runtimeDraftDates],
    )
    await pool.query(
      `UPDATE toast_daily_sales SET standard_refunds = 5.25
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = '2026-08-03'::date`,
      [organizationId, restaurantGuid],
    )
    await pool.query(
      `UPDATE toast_daily_sales SET refunds = -4.75
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = '2026-08-04'::date`,
      [organizationId, restaurantGuid],
    )
    await pool.query(
      `UPDATE toast_daily_sales SET standard_tax = 0.01
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = '2026-08-05'::date`,
      [organizationId, restaurantGuid],
    )
    await pool.query(
      `UPDATE toast_daily_sales SET orders_count = 1
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = '2026-08-06'::date`,
      [organizationId, restaurantGuid],
    )
    await pool.query(
      `INSERT INTO toast_accounting_export_drafts (
         organization_id, restaurant_guid, business_date, idempotency_key, status, source_summary
       ) VALUES
         ($1::uuid, $2::uuid, '2026-08-01'::date, 'runtime-zero-existing', 'needs_mapping', '{"sentinel":"delete"}'::jsonb),
         ($1::uuid, $2::uuid, '2026-08-07'::date, 'runtime-zero-approved', 'approved', '{"sentinel":"approved"}'::jsonb),
         ($1::uuid, $2::uuid, '2026-08-08'::date, 'runtime-zero-posting', 'posting', '{"sentinel":"posting"}'::jsonb),
         ($1::uuid, $2::uuid, '2026-08-09'::date, 'runtime-zero-posted', 'posted', '{"sentinel":"posted"}'::jsonb)`,
      [organizationId, restaurantGuid],
    )

    for (const businessDate of runtimeDraftDates) {
      await databasePersistence.refreshToastAccountingDraftInPostgres({
        organizationId,
        restaurantGuid,
        businessDate,
        syncKind: 'standard_orders',
      })
    }
    const runtimeDrafts = await pool.query(
      `SELECT business_date::text, status, source_summary
       FROM toast_accounting_export_drafts
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = ANY($3::date[])
       ORDER BY business_date`,
      [organizationId, restaurantGuid, runtimeDraftDates],
    )
    const runtimeDraftByDate = new Map(runtimeDrafts.rows.map((row) => [row.business_date, row]))
    assert.equal(runtimeDraftByDate.has('2026-08-01'), false, 'an existing zero-activity draft must be deleted')
    assert.equal(runtimeDraftByDate.has('2026-08-02'), false, 'a zero-activity date must not create a draft')
    assert.equal(runtimeDraftByDate.get('2026-08-03')?.source_summary?.standard?.refunds, 5.25)
    assert.equal(runtimeDraftByDate.get('2026-08-04')?.source_summary?.refunds, -4.75)
    assert.equal(runtimeDraftByDate.get('2026-08-05')?.source_summary?.standard?.tax, 0.01)
    assert.equal(runtimeDraftByDate.has('2026-08-06'), true, 'an order with zero amounts must retain a draft')
    for (const [businessDate, status] of [
      ['2026-08-07', 'approved'],
      ['2026-08-08', 'posting'],
      ['2026-08-09', 'posted'],
    ]) {
      assert.equal(runtimeDraftByDate.get(businessDate)?.status, status, `${status} zero-activity evidence must remain`)
      assert.equal(runtimeDraftByDate.get(businessDate)?.source_summary?.sentinel, status)
    }

    const migrationDates = ['2026-09-01', '2026-09-02', '2026-09-03']
    await pool.query(
      `INSERT INTO toast_daily_sales (organization_id, restaurant_guid, business_date)
       SELECT $1::uuid, $2::uuid, dates.business_date
       FROM unnest($3::date[]) AS dates(business_date)`,
      [organizationId, restaurantGuid, migrationDates],
    )
    await pool.query(
      `UPDATE toast_daily_sales SET standard_refunds = 1.00
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = '2026-09-03'::date`,
      [organizationId, restaurantGuid],
    )
    await pool.query(
      `INSERT INTO toast_accounting_export_drafts (
         organization_id, restaurant_guid, business_date, idempotency_key, status, source_summary
       ) VALUES
         ($1::uuid, $2::uuid, '2026-09-01'::date, 'migration-zero-unprotected', 'needs_review', '{"sentinel":"delete"}'::jsonb),
         ($1::uuid, $2::uuid, '2026-09-02'::date, 'migration-zero-approved', 'approved', '{"sentinel":"approved"}'::jsonb),
         ($1::uuid, $2::uuid, '2026-09-03'::date, 'migration-refund-unprotected', 'failed', '{"sentinel":"refund"}'::jsonb)`,
      [organizationId, restaurantGuid],
    )
    const migrationIssues = await pool.query(
      `INSERT INTO pos_accounting_issue_states (
         organization_id, restaurant_guid, business_date, status, issue_fingerprint, issues
       ) VALUES
         ($1::uuid, $2::uuid, '2026-09-01'::date, 'open', $3, $4::jsonb),
         ($1::uuid, $2::uuid, '2026-09-02'::date, 'open', $3, $4::jsonb),
         ($1::uuid, $2::uuid, '2026-09-03'::date, 'open', $3, $4::jsonb)
       RETURNING id::text, business_date::text`,
      [
        organizationId,
        restaurantGuid,
        'a'.repeat(64),
        JSON.stringify([{ code: 'migration-test', title: 'Migration test', detail: 'Migration test issue' }]),
      ],
    )
    const migrationIssueByDate = new Map(migrationIssues.rows.map((row) => [row.business_date, row.id]))
    await pool.query(
      `INSERT INTO pos_accounting_notification_outbox (
         issue_state_id, occurrence, issue_fingerprint, issues, recipient_email,
         status, locked_at, locked_by, lock_token
       ) VALUES
         ($1::uuid, 1, $4, $5::jsonb, 'accounting-alerts@clawpilot.com', 'processing', now(), 'migration-test', gen_random_uuid()),
         ($2::uuid, 1, $4, $5::jsonb, 'accounting-alerts@clawpilot.com', 'pending', NULL, NULL, NULL),
         ($3::uuid, 1, $4, $5::jsonb, 'accounting-alerts@clawpilot.com', 'pending', NULL, NULL, NULL)`,
      [
        migrationIssueByDate.get('2026-09-01'),
        migrationIssueByDate.get('2026-09-02'),
        migrationIssueByDate.get('2026-09-03'),
        'a'.repeat(64),
        JSON.stringify([{ code: 'migration-test', title: 'Migration test', detail: 'Migration test issue' }]),
      ],
    )

    await pool.query(zeroSalesDraftMigration)
    const migrationDrafts = await pool.query(
      `SELECT business_date::text, status FROM toast_accounting_export_drafts
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = ANY($3::date[])
       ORDER BY business_date`,
      [organizationId, restaurantGuid, migrationDates],
    )
    assert.deepEqual(migrationDrafts.rows, [
      { business_date: '2026-09-02', status: 'approved' },
      { business_date: '2026-09-03', status: 'failed' },
    ])
    const migratedIssues = await pool.query(
      `SELECT business_date::text, status, resolved_at IS NOT NULL AS resolved
       FROM pos_accounting_issue_states
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = ANY($3::date[])
       ORDER BY business_date`,
      [organizationId, restaurantGuid, migrationDates],
    )
    assert.deepEqual(migratedIssues.rows, [
      { business_date: '2026-09-01', status: 'resolved', resolved: true },
      { business_date: '2026-09-02', status: 'open', resolved: false },
      { business_date: '2026-09-03', status: 'open', resolved: false },
    ])
    const migratedNotifications = await pool.query(
      `SELECT issue.business_date::text, notification.status,
         notification.locked_at, notification.locked_by, notification.lock_token
       FROM pos_accounting_notification_outbox notification
       JOIN pos_accounting_issue_states issue ON issue.id = notification.issue_state_id
       WHERE issue.organization_id = $1::uuid AND issue.restaurant_guid = $2::uuid
         AND issue.business_date = ANY($3::date[])
       ORDER BY issue.business_date`,
      [organizationId, restaurantGuid, migrationDates],
    )
    assert.equal(migratedNotifications.rows[0].business_date, '2026-09-01')
    assert.equal(migratedNotifications.rows[0].status, 'cancelled')
    assert.equal(migratedNotifications.rows[0].locked_at, null)
    assert.equal(migratedNotifications.rows[0].locked_by, null)
    assert.equal(migratedNotifications.rows[0].lock_token, null)
    assert.deepEqual(migratedNotifications.rows.slice(1).map((row) => [row.business_date, row.status]), [
      ['2026-09-02', 'pending'],
      ['2026-09-03', 'pending'],
    ])

    await databasePersistence.queueToastSyncForDateInPostgres({
      organizationId, businessDate: '2026-07-18', actorEmail,
    })
    const firstClaims = await databasePersistence.claimToastSyncJobsInPostgres({ limit: 3, workerId: 'acceptance-worker-1' })
    assert.equal(firstClaims.length, 3)
    const standardJob = firstClaims.find((job) => job.syncKind === 'standard_orders')
    assert.ok(standardJob)
    await databasePersistence.queueToastSyncForDateInPostgres({
      organizationId, businessDate: '2026-07-18', actorEmail,
    })
    const processingRefresh = await pool.query(
      `SELECT status, rerun_requested_at IS NOT NULL AS rerun_requested
       FROM toast_sync_outbox WHERE id = $1::uuid`,
      [standardJob.id],
    )
    assert.deepEqual(processingRefresh.rows[0], { status: 'processing', rerun_requested: true })
    assert.equal(await databasePersistence.completeToastSyncJobInPostgres({ job: standardJob, resultSummary: { records: 1 } }), true)
    const followUp = await pool.query(
      `SELECT status, attempt_count, rerun_requested_at
       FROM toast_sync_outbox WHERE id = $1::uuid`,
      [standardJob.id],
    )
    assert.equal(followUp.rows[0].status, 'pending')
    assert.equal(followUp.rows[0].attempt_count, 0)
    assert.equal(followUp.rows[0].rerun_requested_at, null)
    const followUpClaims = await databasePersistence.claimToastSyncJobsInPostgres({ limit: 1, workerId: 'acceptance-worker-2' })
    assert.equal(followUpClaims[0].id, standardJob.id)
    assert.equal(await databasePersistence.completeToastSyncJobInPostgres({ job: followUpClaims[0], resultSummary: { records: 2 } }), true)
    await databasePersistence.queueToastSyncForDateInPostgres({
      organizationId, businessDate: '2026-07-18', actorEmail,
    })
    assert.equal((await pool.query('SELECT status FROM toast_sync_outbox WHERE id = $1::uuid', [standardJob.id])).rows[0].status, 'pending')
    await pool.query("UPDATE toast_sync_outbox SET status = 'dead' WHERE id = $1::uuid", [standardJob.id])
    await databasePersistence.queueToastSyncForDateInPostgres({
      organizationId, businessDate: '2026-07-18', actorEmail,
    })
    assert.equal((await pool.query('SELECT status FROM toast_sync_outbox WHERE id = $1::uuid', [standardJob.id])).rows[0].status, 'dead')

    await databasePersistence.queueAutomaticToastOrderUpdateInPostgres({
      organizationId, restaurantGuid, businessDate: '2026-07-18',
    })
    const updateClaims = await databasePersistence.claimToastSyncJobsInPostgres({ limit: 10, workerId: 'acceptance-worker-3' })
    const updateJob = updateClaims.find((job) => job.syncKind === 'standard_order_updates')
    assert.ok(updateJob)
    await databasePersistence.queueAutomaticToastOrderUpdateInPostgres({
      organizationId, restaurantGuid, businessDate: '2026-07-18',
    })
    assert.equal(
      (await pool.query('SELECT rerun_requested_at FROM toast_sync_outbox WHERE id = $1::uuid', [updateJob.id])).rows[0].rerun_requested_at,
      null,
    )
    assert.equal(await databasePersistence.completeToastSyncJobInPostgres({ job: updateJob, resultSummary: { records: 0 } }), true)
    await databasePersistence.queueAutomaticToastOrderUpdateInPostgres({
      organizationId, restaurantGuid, businessDate: '2026-07-18',
    })
    assert.equal((await pool.query('SELECT status FROM toast_sync_outbox WHERE id = $1::uuid', [updateJob.id])).rows[0].status, 'succeeded')
    await pool.query("UPDATE toast_sync_outbox SET completed_at = now() - interval '20 minutes' WHERE id = $1::uuid", [updateJob.id])
    await databasePersistence.queueAutomaticToastOrderUpdateInPostgres({
      organizationId, restaurantGuid, businessDate: '2026-07-18',
    })
    assert.equal((await pool.query('SELECT status FROM toast_sync_outbox WHERE id = $1::uuid', [updateJob.id])).rows[0].status, 'pending')
    console.log('Toast outbox disposable PostgreSQL rerun acceptance passed')
  } finally {
    if (pool) await pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '-t', '1', container], { cwd: root, encoding: 'utf8', timeout: 20_000 })
  }
}

await runToastOutboxPostgresAcceptance()

console.log('Toast integration contracts passed')
