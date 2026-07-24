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
class PosAccountingRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}
const toastPersistenceMocks = {
  '@/lib/auditWriter': { recordAuditEvent: async () => {} },
  '@/lib/persistence/posAccounting': { PosAccountingRequestError },
}

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
  'queuePosAccountingSalesReloadInPostgres',
  'pos_accounting_commands',
  'reporting: ToastReportingState',
  "result_summary ->> 'records'",
  "GROUP BY CASE WHEN sync_kind = 'standard_order_updates' THEN 'standard_orders' ELSE sync_kind END",
  "syncKind: 'analytics_sales' | 'analytics_payouts' | 'standard_orders' | 'standard_order_updates'",
  "COALESCE(locked_at, updated_at) < now() - interval '15 minutes'",
  'postprocess_token IS NULL',
  'postprocess_token = $4::uuid',
  'postprocess_token = $3::uuid',
  'postprocess_token = $2::uuid',
  'finishToastSyncPostProcessingInPostgres',
  'AND lock_token = $4::uuid',
  'AND lock_token = $3::uuid',
  'rerun_requested_at',
  'make_interval(secs => $6::integer)',
  "CASE WHEN rerun_requested_at IS NULL THEN 'succeeded' ELSE 'pending' END",
  "syncKind: 'analytics_sales'",
  "syncKind: 'standard_orders'",
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

const paymentExceptionMigration = read('db/migrations/0102_pos_payment_exceptions.sql')
for (const fragment of [
  'created_at_source timestamptz',
  'modified_at_source timestamptz',
  'promised_at timestamptz',
  'estimated_fulfillment_at timestamptz',
  "payment_business_dates date[] NOT NULL DEFAULT '{}'::date[]",
  'fulfillment_business_date date',
  'postprocess_token uuid',
  'postprocess_started_at timestamptz',
  "'infinity'::timestamptz",
  `'{"backfill":"pos_payment_exceptions_v1","staged":true}'::jsonb`,
  "CROSS JOIN generate_series(0, 30) AS recent(day_offset)",
  "'standard_order_updates'",
  'LEFT JOIN pg_timezone_names zone',
  "AT TIME ZONE COALESCE(zone.name, 'UTC')",
  "credential.access_type = 'standard'",
  "WHEN job.status = 'processing' THEN now()",
  "ELSE 'pending'",
]) {
  assert.ok(paymentExceptionMigration.includes(fragment), `Payment exception migration missing ${fragment}`)
}
assert.ok(
  !paymentExceptionMigration.includes('ALTER COLUMN fulfillment_business_date SET NOT NULL'),
  'Payment exception migration must remain compatible with the previously deployed Toast worker',
)
assert.ok(
  !paymentExceptionMigration.includes('USING gin (payment_business_dates)'),
  'Payment date indexing must wait for a predicate that can use the GIN index',
)

const paymentDateBackfillActivation = read('scripts/activate-toast-payment-date-backfill.mjs')
for (const fragment of [
  "pg_advisory_xact_lock(hashtext('clawpilot-toast-payment-date-backfill-v1'))",
  `'{"backfill":"pos_payment_exceptions_v1","staged":true}'::jsonb`,
  "job.request_state, '{}'::jsonb) - 'staged'",
  'staged.position / 4',
  "make_interval(secs => ((staged.position / 4)::integer * 60))",
]) {
  assert.ok(
    paymentDateBackfillActivation.includes(fragment),
    `Toast payment-date backfill activation missing ${fragment}`,
  )
}

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
    ...toastPersistenceMocks,
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
    ...toastPersistenceMocks,
    '@/lib/integrations/toastOrderProjection': toastOrderProjection,
    '@/lib/persistence/postgres': {
      query: async () => ({ rows: [], rowCount: 0 }),
      withTransaction: async (work) => work({
        query: async (sql, params = []) => {
          const source = String(sql)
          queueQueries.push({ source, params: [...params] })
          if (source.includes('SELECT access_type') && source.includes('FROM organization_toast_credentials')) {
            return { rows: [{ access_type: 'analytics' }, { access_type: 'standard' }], rowCount: 2 }
          }
          if (source.includes('SELECT restaurant_guid::text, analytics_access, standard_access')) {
            return {
              rows: [{ restaurant_guid: restaurantGuid, analytics_access: true, standard_access: true }],
              rowCount: 1,
            }
          }
          if (source.includes('SELECT restaurant_guid::text, restaurant_name, location_name')) {
            return {
              rows: [{
                restaurant_guid: restaurantGuid,
                restaurant_name: 'Test Restaurant',
                location_name: 'Downtown',
                analytics_access: true,
                standard_access: true,
              }],
              rowCount: 1,
            }
          }
          if (source.includes('INSERT INTO pos_accounting_commands')) {
            return {
              rows: [{
                id: '44444444-4444-4444-8444-444444444444',
                status: 'queued',
                created_at: '2026-07-18T12:00:00.000Z',
                updated_at: '2026-07-18T12:00:00.000Z',
              }],
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
const accountingReloadQueryStart = queueQueries.length
const accountingReload = await queuePersistence.queuePosAccountingSalesReloadInPostgres({
  organizationId,
  restaurantGuid,
  businessDate: '2026-07-19',
  actorEmail: 'preparer@example.test',
})
assert.equal(accountingReload.commandType, 'reload_sales')
assert.deepEqual([...accountingReload.expectedSyncKinds], ['analytics_sales', 'standard_orders'])
const accountingReloadQueries = queueQueries.slice(accountingReloadQueryStart)
const accountingReloadJobs = accountingReloadQueries.filter((entry) => entry.source.includes('INSERT INTO toast_sync_outbox'))
assert.equal(accountingReloadJobs.length, 2, 'accounting reload must queue sales sources only')
assert.deepEqual(accountingReloadJobs.map((entry) => entry.params[2]), ['analytics_sales', 'standard_orders'])
assert.ok(accountingReloadJobs.every((entry) => entry.params[0] === organizationId))
assert.ok(accountingReloadJobs.every((entry) => entry.params[1] === restaurantGuid))
assert.ok(accountingReloadJobs.every((entry) => entry.params[3] === '2026-07-19'))
assert.ok(accountingReloadJobs.every((entry) => entry.params[5] === 0))

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
assert.ok(worker.includes('regeneratePosAccountingDraftInPostgres'), 'Toast worker must regenerate canonical accounting drafts')
assert.ok(worker.includes('finalizePosAccountingReloadForDateInPostgres'), 'Toast worker must finalize date-scoped accounting reloads')
const completeJobBody = worker.slice(
  worker.indexOf('async function completeJob'),
  worker.indexOf('async function processJob'),
)
assert.ok(
  completeJobBody.indexOf('completeToastSyncJobInPostgres')
    < completeJobBody.indexOf('await refreshAccountingState(job, accountingBusinessDates)'),
  'Toast jobs must complete before accounting evaluates multi-source reload readiness',
)
assert.ok(
  completeJobBody.indexOf('await refreshAccountingState(job, accountingBusinessDates)')
    < completeJobBody.indexOf('await finishToastSyncPostProcessingInPostgres({ job })'),
  'Toast jobs must retain their durable completion lease until accounting refresh succeeds',
)
assert.ok(worker.includes('deferToastSyncJobInPostgres'), 'Toast worker must support asynchronous Analytics reports')
assert.ok(worker.includes("job.syncKind === 'standard_order_updates'"), 'Toast worker must poll modified orders')
assert.ok(worker.includes('getToastStandardOrders({ credential, restaurantGuid: job.restaurantGuid, businessDate })'),
  'modified-order sync must refresh complete affected business days')
assert.ok(worker.includes('catchUpDates(target.latestStandardUpdateDate, businessDate)'),
  'Toast worker must catch up missed modified-order windows')
assert.ok(worker.includes('queueAutomaticToastOrderUpdateInPostgres({ ...target, businessDate: currentDate })'),
  'Toast worker must poll current local-day order modifications')
assert.ok(!worker.includes('quickbooks'), 'Toast ingestion worker must not post directly to QuickBooks')

const automaticUpdateDates = []
const workerModule = loadTypeScriptModule('app_src/lib/toastSyncWorker.ts', {
  mocks: {
    '@/lib/integrations/toastClient': {},
    '@/lib/integrations/toastCredentialCrypto': { decryptToastClientSecret: () => 'secret' },
    '@/lib/persistence/posAccountingNotifications': {
      processPosAccountingNotificationOutbox: async () => ({ claimed: 0, succeeded: 0, failed: 0, dead: 0 }),
      reconcilePosAccountingIssueForDateInPostgres: async () => {},
      reconcileStaleOpenPosAccountingIssuesInPostgres: async () => ({ checked: 0, reconciled: 0, failed: 0 }),
    },
    '@/lib/persistence/posAccounting': {
      finalizePosAccountingReloadForDateInPostgres: async () => ({ pending: false, finalized: false, failed: false }),
      regeneratePosAccountingDraftInPostgres: async () => {},
    },
    '@/lib/persistence/toastIntegrations': {
      claimToastSyncJobsInPostgres: async () => [],
      listToastAutomaticSyncTargetsInPostgres: async () => [{
        organizationId,
        restaurantGuid,
        timezone: 'America/New_York',
        analyticsEnabled: false,
        standardEnabled: true,
        latestStandardUpdateDate: null,
      }],
      queueAutomaticToastSyncInPostgres: async () => {},
      queueAutomaticToastOrderUpdateInPostgres: async (input) => automaticUpdateDates.push(input.businessDate),
    },
  },
})
assert.equal(
  workerModule.currentBusinessDate('America/New_York', new Date('2026-07-24T02:00:00.000Z')),
  '2026-07-23',
  'Toast worker must derive the current business date in the restaurant timezone',
)
const historicalWindow = workerModule.modifiedWindow(
  '2026-07-23',
  'America/New_York',
  new Date('2026-07-25T12:00:00.000Z'),
)
assert.equal(historicalWindow.startDate, '2026-07-23T04:00:00.000Z')
assert.equal(historicalWindow.endDate, '2026-07-24T04:00:00.000Z',
  'Toast modification polling must use local-day UTC boundaries')
const currentWindow = workerModule.modifiedWindow(
  '2026-07-23',
  'America/New_York',
  new Date('2026-07-24T02:00:00.000Z'),
)
assert.equal(currentWindow.startDate, '2026-07-23T04:00:00.000Z')
assert.equal(currentWindow.endDate, '2026-07-24T02:00:00.000Z',
  'Toast current-day polling must not send a future endDate')
const daylightSavingWindow = workerModule.modifiedWindow(
  '2026-11-01',
  'America/New_York',
  new Date('2026-11-03T12:00:00.000Z'),
)
assert.equal(daylightSavingWindow.startDate, '2026-11-01T04:00:00.000Z')
assert.equal(daylightSavingWindow.endDate, '2026-11-02T05:00:00.000Z',
  'Toast modification polling must preserve the full local day across DST')
await workerModule.processToastSyncOutbox({ workerId: 'scheduler-contract' })
assert.ok(
  automaticUpdateDates.includes(workerModule.currentBusinessDate('America/New_York')),
  'automatic polling must queue the live local business date',
)

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
         organization_id, restaurant_guid, restaurant_name, timezone, active,
         analytics_access, standard_access, selected, last_verified_at
       ) VALUES (
         $1::uuid, $2::uuid, 'Toast Acceptance Restaurant', 'America/New_York',
         true, true, true, true, now()
       )`,
      [organizationId, restaurantGuid],
    )

    await pool.query(
      `INSERT INTO toast_sync_outbox (
         organization_id, restaurant_guid, sync_kind, business_date,
         status, available_at, request_state
       ) VALUES
         ($1::uuid, $2::uuid, 'standard_order_updates', '2026-06-01'::date,
          'pending', 'infinity'::timestamptz,
          '{"backfill":"pos_payment_exceptions_v1","staged":true}'::jsonb),
         ($1::uuid, $2::uuid, 'standard_order_updates', '2026-06-02'::date,
          'pending', 'infinity'::timestamptz,
          '{"backfill":"pos_payment_exceptions_v1","staged":true}'::jsonb)`,
      [organizationId, restaurantGuid],
    )
    const activationResult = JSON.parse(command(
      'node',
      ['scripts/activate-toast-payment-date-backfill.mjs'],
      { env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' } },
    ))
    assert.equal(activationResult.activated, 2)
    const activatedBackfill = await pool.query(
      `SELECT business_date::text, available_at < 'infinity'::timestamptz AS available,
         request_state ? 'staged' AS staged,
         request_state ? 'activatedAt' AS activated
       FROM toast_sync_outbox
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = ANY(ARRAY['2026-06-01', '2026-06-02']::date[])
       ORDER BY business_date`,
      [organizationId, restaurantGuid],
    )
    assert.deepEqual(activatedBackfill.rows, [
      { business_date: '2026-06-01', available: true, staged: false, activated: true },
      { business_date: '2026-06-02', available: true, staged: false, activated: true },
    ])
    const repeatedActivation = JSON.parse(command(
      'node',
      ['scripts/activate-toast-payment-date-backfill.mjs'],
      { env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' } },
    ))
    assert.equal(repeatedActivation.activated, 0, 'backfill activation must be idempotent')
    await pool.query(
      `DELETE FROM toast_sync_outbox
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = ANY(ARRAY['2026-06-01', '2026-06-02']::date[])`,
      [organizationId, restaurantGuid],
    )

    const databasePersistence = loadTypeScriptModule('app_src/lib/persistence/toastIntegrations.ts', {
      mocks: {
        ...toastPersistenceMocks,
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

    const legacyDraftUniqueness = await pool.query(
      `SELECT constraint_row.conname
       FROM pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'toast_accounting_export_drafts'::regclass
         AND constraint_row.contype = 'u'
         AND (
           SELECT array_agg(attribute_row.attname::text ORDER BY key_column.ordinality)
           FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
           JOIN pg_attribute attribute_row
             ON attribute_row.attrelid = constraint_row.conrelid
            AND attribute_row.attnum = key_column.attnum
         ) = ARRAY['organization_id', 'restaurant_guid', 'business_date']::text[]`,
    )
    assert.equal(legacyDraftUniqueness.rowCount, 0, 'date scope must allow immutable draft revision history')
    await pool.query(
      `INSERT INTO toast_accounting_export_drafts (
         organization_id, restaurant_guid, business_date, idempotency_key, status,
         source_summary, draft_revision, is_current, superseded_at
       ) VALUES
         ($1::uuid, $2::uuid, '2026-10-01'::date, 'protected-revision-1', 'approved',
          '{"sentinel":"protected"}'::jsonb, 1, false, now()),
         ($1::uuid, $2::uuid, '2026-10-01'::date, 'correction-revision-2', 'needs_review',
          '{"sentinel":"correction"}'::jsonb, 2, true, NULL)`,
      [organizationId, restaurantGuid],
    )
    await pool.query(
      `UPDATE toast_accounting_export_drafts
       SET source_summary = '{"sentinel":"changed"}'::jsonb
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = '2026-10-01'::date AND draft_revision = 1`,
      [organizationId, restaurantGuid],
    )
    const revisionEvidence = await pool.query(
      `SELECT draft_revision, status, source_summary, is_current
       FROM toast_accounting_export_drafts
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = '2026-10-01'::date
       ORDER BY draft_revision`,
      [organizationId, restaurantGuid],
    )
    assert.deepEqual(revisionEvidence.rows, [{
      draft_revision: 1,
      status: 'approved',
      source_summary: { sentinel: 'protected' },
      is_current: false,
    }, {
      draft_revision: 2,
      status: 'needs_review',
      source_summary: { sentinel: 'correction' },
      is_current: true,
    }])

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
    assert.equal(standardJob.timezone, 'America/New_York')
    const timingProjection = await databasePersistence.projectToastStandardOrdersInPostgres({
      job: standardJob,
      orders: [{
        guid: '55555555-5555-4555-8555-555555555555',
        createdDate: '2026-07-18T01:30:00.000Z',
        modifiedDate: '2026-07-18T05:15:00.000Z',
        promisedDate: '2026-07-20T15:00:00.000Z',
        checks: [{
          paymentStatus: 'PAID',
          amount: 44.54,
          totalAmount: 44.54,
          selections: [{ displayName: 'Weekend preorder', quantity: 1, price: 44.54 }],
          payments: [
            {
              type: 'CREDIT',
              amount: 20,
              paidDate: '2026-07-18T05:00:00.000Z',
              paidBusinessDate: 20260717,
            },
            {
              type: 'CREDIT',
              amount: 24.54,
              paidDate: '2026-07-18T06:00:00.000Z',
              paidBusinessDate: '20260717',
            },
          ],
        }],
      }],
    })
    assert.deepEqual(
      [...timingProjection.accountingBusinessDates],
      ['2026-07-17', '2026-07-18', '2026-07-20'],
    )
    const timingRow = await pool.query(
      `SELECT created_at_source::text, modified_at_source::text, promised_at::text,
         payment_business_dates::text, fulfillment_business_date::text, details
       FROM toast_pos_orders
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND order_guid = '55555555-5555-4555-8555-555555555555'`,
      [organizationId, restaurantGuid],
    )
    assert.equal(timingRow.rows[0].payment_business_dates, '{2026-07-17}')
    assert.equal(timingRow.rows[0].fulfillment_business_date, '2026-07-20')
    assert.deepEqual(
      timingRow.rows[0].details.checks[0].payments.map((payment) => payment.paidBusinessDate),
      ['2026-07-17', '2026-07-17'],
      'Toast paidBusinessDate must survive the sanitized projection and override local-calendar inference',
    )
    assert.match(timingRow.rows[0].created_at_source, /^2026-07-18 01:30:00/)
    assert.match(timingRow.rows[0].modified_at_source, /^2026-07-18 05:15:00/)
    assert.match(timingRow.rows[0].promised_at, /^2026-07-20 15:00:00/)
    const removedTimingProjection = await databasePersistence.projectToastStandardOrdersInPostgres({
      job: standardJob,
      orders: [],
    })
    assert.deepEqual(
      [...removedTimingProjection.accountingBusinessDates],
      ['2026-07-17', '2026-07-18', '2026-07-20'],
      'removing or moving an order must refresh its prior payment and fulfillment dates',
    )
    assert.equal(
      Number((await pool.query(
        `SELECT count(*) FROM toast_pos_orders
         WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
           AND order_guid = '55555555-5555-4555-8555-555555555555'`,
        [organizationId, restaurantGuid],
      )).rows[0].count),
      0,
      'full-date replacement must remove an order no longer returned by Toast',
    )
    assert.equal(
      Number((await pool.query(
        `SELECT standard_orders_count FROM toast_daily_sales
         WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
           AND business_date = '2026-07-18'`,
        [organizationId, restaurantGuid],
      )).rows[0].standard_orders_count),
      0,
      'removing the last order must clear its stored Standard daily total',
    )
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
    assert.equal(
      (await pool.query(
        'SELECT postprocess_token::text FROM toast_sync_outbox WHERE id = $1::uuid',
        [standardJob.id],
      )).rows[0].postprocess_token,
      standardJob.lockToken,
      'completion must retain the finishing worker token across accounting post-processing',
    )
    assert.equal(
      await databasePersistence.finishToastSyncPostProcessingInPostgres({ job: standardJob }),
      true,
    )
    const followUpClaims = await databasePersistence.claimToastSyncJobsInPostgres({ limit: 1, workerId: 'acceptance-worker-2' })
    assert.equal(followUpClaims[0].id, standardJob.id)
    assert.equal(await databasePersistence.completeToastSyncJobInPostgres({ job: followUpClaims[0], resultSummary: { records: 2 } }), true)
    const staleFailure = await databasePersistence.failToastSyncJobInPostgres({
      job: standardJob,
      error: 'stale worker failure',
    })
    assert.equal(staleFailure.accepted, false, 'an older lease must not overwrite a newer completed lease')
    assert.equal(staleFailure.dead, false)
    const accountingRefreshFailure = await databasePersistence.failToastSyncJobInPostgres({
      job: followUpClaims[0],
      error: 'accounting refresh failed',
    })
    assert.equal(
      accountingRefreshFailure.accepted,
      true,
      'the completing lease must be able to make a post-processing failure retryable',
    )
    assert.equal(accountingRefreshFailure.dead, false)
    const postprocessFailure = await pool.query(
      `SELECT status, last_error, postprocess_token
       FROM toast_sync_outbox WHERE id = $1::uuid`,
      [standardJob.id],
    )
    assert.equal(postprocessFailure.rows[0].status, 'failed')
    assert.equal(postprocessFailure.rows[0].last_error, 'accounting refresh failed')
    assert.equal(postprocessFailure.rows[0].postprocess_token, null)
    await databasePersistence.queueToastSyncForDateInPostgres({
      organizationId, businessDate: '2026-07-18', actorEmail,
    })
    assert.equal((await pool.query('SELECT status FROM toast_sync_outbox WHERE id = $1::uuid', [standardJob.id])).rows[0].status, 'pending')
    await pool.query("UPDATE toast_sync_outbox SET status = 'dead' WHERE id = $1::uuid", [standardJob.id])
    await databasePersistence.queueToastSyncForDateInPostgres({
      organizationId, businessDate: '2026-07-18', actorEmail,
    })
    assert.equal((await pool.query('SELECT status FROM toast_sync_outbox WHERE id = $1::uuid', [standardJob.id])).rows[0].status, 'pending')

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
    assert.equal(await databasePersistence.finishToastSyncPostProcessingInPostgres({ job: updateJob }), true)
    await databasePersistence.queueAutomaticToastOrderUpdateInPostgres({
      organizationId, restaurantGuid, businessDate: '2026-07-18',
    })
    assert.equal((await pool.query('SELECT status FROM toast_sync_outbox WHERE id = $1::uuid', [updateJob.id])).rows[0].status, 'succeeded')
    await pool.query("UPDATE toast_sync_outbox SET completed_at = now() - interval '20 minutes' WHERE id = $1::uuid", [updateJob.id])
    await databasePersistence.queueAutomaticToastOrderUpdateInPostgres({
      organizationId, restaurantGuid, businessDate: '2026-07-18',
    })
    assert.equal((await pool.query('SELECT status FROM toast_sync_outbox WHERE id = $1::uuid', [updateJob.id])).rows[0].status, 'pending')
    const orphanSourceClaims = await databasePersistence.claimToastSyncJobsInPostgres({
      limit: 20,
      workerId: 'acceptance-worker-orphan-source',
    })
    const orphanSourceJob = orphanSourceClaims.find((job) => job.id === updateJob.id)
    assert.ok(orphanSourceJob)
    assert.equal(await databasePersistence.completeToastSyncJobInPostgres({
      job: orphanSourceJob,
      resultSummary: { records: 0 },
    }), true)
    await pool.query(
      `UPDATE toast_sync_outbox
       SET postprocess_started_at = now() - interval '20 minutes'
       WHERE id = $1::uuid`,
      [updateJob.id],
    )
    const recoveredClaims = await databasePersistence.claimToastSyncJobsInPostgres({
      limit: 20,
      workerId: 'acceptance-worker-orphan-recovery',
    })
    const recoveredJob = recoveredClaims.find((job) => job.id === updateJob.id)
    assert.ok(recoveredJob, 'an orphaned post-processing lease must return to the retry queue')
    assert.notEqual(recoveredJob.lockToken, orphanSourceJob.lockToken)
    const lateStaleFailure = await databasePersistence.failToastSyncJobInPostgres({
      job: orphanSourceJob,
      error: 'late stale failure',
    })
    assert.equal(
      lateStaleFailure.accepted,
      false,
      'the recovered lease must reject a late failure from the orphaned lease',
    )
    assert.equal(lateStaleFailure.dead, false)
    const cleanupFailure = await databasePersistence.failToastSyncJobInPostgres({
      job: recoveredJob,
      error: 'acceptance cleanup',
    })
    assert.equal(cleanupFailure.accepted, true)
    assert.equal(cleanupFailure.dead, false)
    console.log('Toast outbox disposable PostgreSQL rerun acceptance passed')
  } finally {
    if (pool) await pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '-t', '1', container], { cwd: root, encoding: 'utf8', timeout: 20_000 })
  }
}

await runToastOutboxPostgresAcceptance()

console.log('Toast integration contracts passed')
