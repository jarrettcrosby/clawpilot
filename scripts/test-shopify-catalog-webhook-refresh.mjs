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

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
  }
}

function loadTypeScriptModule(path, { mocks = {} } = {}) {
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
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const migration = read(
  'db/migrations/0197_operations_shopify_catalog_webhook_refresh.sql',
)
includes(migration, [
  'operations_shopify_catalog_refresh_states',
  'dirty_version bigint NOT NULL DEFAULT 0',
  'reconciled_version bigint NOT NULL DEFAULT 0',
  'dirty_version > reconciled_version',
  'target_dirty_version bigint NOT NULL DEFAULT 0',
  'protect_operations_shopify_catalog_refresh_state',
  'refresh state versions are monotonic',
], 'Shopify catalog webhook refresh migration')

const capabilities = read(
  'app_src/lib/integrations/commerceCapabilities.ts',
)
includes(capabilities, [
  'SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS',
  "'products/create'",
  "'products/delete'",
  "'products/update'",
  "state: 'available'",
  'lossless monotonic watermark',
], 'Shopify product webhook capability')

const receiptPersistence = read(
  'app_src/lib/persistence/commerceIntegrations.ts',
)
assert.match(
  receiptPersistence,
  /if \(SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS\.some\([\s\S]+?signalShopifyCatalogRefreshWithClient/,
  'Product webhook topics must signal catalog reconciliation',
)
includes(receiptPersistence, [
  'commerce.catalog.refresh_signaled',
  'catalogRefreshSignaled: Boolean(catalogRefreshSignal)',
  'providerWrites: 0',
  'ordersTouched: 0',
  'inventoryTouched: 0',
], 'Shopify product webhook receipt boundary')

const catalogPersistence = read(
  'app_src/lib/persistence/commerceCatalogSync.ts',
)
includes(catalogPersistence, [
  'signalShopifyCatalogRefreshWithClient',
  'shopify-catalog-watermark:',
  'pendingRefreshSignals',
  "catalogRefresh?.provider === 'shopify'",
  "account.provider = 'shopify'",
  'refresh.credential_generation',
  '= account.commerce_credential_generation',
  'target_dirty_version',
  'COALESCE(refresh.dirty_version, 0)',
  'COALESCE(refresh.dirty_version, 0)',
  '> COALESCE(refresh.reconciled_version, 0)',
  'LEAST(dirty_version, $4::bigint)',
  'targetDirtyVersion: input.job.targetDirtyVersion',
], 'Lossless Shopify catalog reconciliation handoff')

const signalQueries = []
const persistence = loadTypeScriptModule(
  'app_src/lib/persistence/commerceCatalogSync.ts',
  {
    mocks: {
      '@/lib/auditWriter': { async recordAuditEvent() {} },
      '@/lib/persistence/postgres': {
        async acquireTransactionAdvisoryLock(client, key) {
          signalQueries.push({ kind: 'lock', key })
          await client.query('SELECT pg_advisory_xact_lock(1)')
        },
        async query() {
          return { rows: [] }
        },
        async withTransaction() {
          assert.fail('The receipt transaction must supply the client')
        },
      },
    },
  },
)
const signal = await persistence.signalShopifyCatalogRefreshWithClient(
  {
    async query(sql, values) {
      signalQueries.push({ kind: 'query', sql, values })
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
      return {
        rowCount: 1,
        rows: [{ dirty_version: '8', reconciled_version: '6' }],
      }
    },
  },
  {
    organizationId: '11111111-1111-4111-8111-111111111111',
    integrationAccountId: '22222222-2222-4222-8222-222222222222',
    credentialGeneration: 3,
    receiptGlobalId: 'gcw1234567',
    providerTriggeredAt: '2026-08-01T12:00:00.000Z',
  },
)
assert.deepEqual(JSON.parse(JSON.stringify(signal)), {
  dirtyVersion: 8,
  reconciledVersion: 6,
})
assert.equal(signalQueries[0].kind, 'lock')
const signalUpsert = signalQueries.find((entry) => (
  entry.kind === 'query'
  && entry.sql.includes('operations_shopify_catalog_refresh_states')
))
assert.ok(signalUpsert, 'Shopify catalog dirty signal was not issued')
includes(signalUpsert.sql, [
  'ON CONFLICT (organization_id, integration_account_id)',
  '.dirty_version + 1',
  'RETURNING dirty_version::text, reconciled_version::text',
], 'Shopify catalog dirty signal')

const latestCatalogJob = {
  status: 'succeeded',
  provider: 'shopify',
  credential_version: 1,
  policy_revision: 4,
  continuation_run_global_id: null,
  page_count: 5,
  provider_records_seen: '240',
  products_created: '0',
  products_mapped: '0',
  products_unchanged: '240',
  products_skipped: '0',
  products_failed: '0',
  attempt_count: 0,
  result_summary: {},
  max_attempts: 8,
  available_at: '2026-08-01T14:43:49.000Z',
  last_error_code: null,
  started_at: '2026-08-01T14:42:00.000Z',
  completed_at: '2026-08-01T14:43:49.000Z',
  updated_at: '2026-08-01T14:43:49.000Z',
  active_backlog: '0',
  unmatched_action: 'review',
  current_credential_version: 1,
  current_policy_revision: 4,
  current_policy_version: 'commerce-product-intake-policy-v1',
  current_provider: 'shopify',
  last_success_at: '2026-08-01T14:43:49.000Z',
}
async function catalogState(provider, dirtyVersion, reconciledVersion) {
  return persistence.readCommerceCatalogSyncStateWithClient(
    {
      async query(sql) {
        if (sql.includes(
          'LEFT JOIN operations_shopify_catalog_refresh_states refresh',
        )) {
          return {
            rows: [{
              provider,
              dirty_version: dirtyVersion,
              reconciled_version: reconciledVersion,
            }],
          }
        }
        if (sql.includes('FROM operations_commerce_catalog_sync_jobs job')) {
          return {
            rows: [{
              ...latestCatalogJob,
              provider,
              current_provider: provider,
            }],
          }
        }
        throw new Error(`Unexpected catalog-state query: ${sql}`)
      },
    },
    {
      organizationId: '11111111-1111-4111-8111-111111111111',
      integrationAccountId: '22222222-2222-4222-8222-222222222222',
    },
  )
}
const pausedShopifyState = await catalogState('shopify', '36', '0')
assert.equal(pausedShopifyState.status, 'paused')
assert.equal(pausedShopifyState.rawStatus, 'succeeded')
assert.equal(pausedShopifyState.dirtyVersion, 36)
assert.equal(pausedShopifyState.reconciledVersion, 0)
assert.equal(pausedShopifyState.pendingRefreshSignals, 36)

const pausedFaireState = await catalogState('faire', null, null)
assert.equal(pausedFaireState.status, 'paused')
assert.equal(pausedFaireState.dirtyVersion, null)
assert.equal(pausedFaireState.reconciledVersion, null)
assert.equal(pausedFaireState.pendingRefreshSignals, null)

const integrationService = read(
  'app_src/lib/integrations/commerceIntegrations.ts',
)
includes(integrationService, [
  'registerShopifyCatalogWebhookSubscriptions',
  "group: 'inventory' | 'catalog'",
  'SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS',
  'catalogWebhookSubscriptions',
  'providerWrites: 0',
], 'Shopify catalog webhook registration')

includes(
  read('app_src/app/api/integrations/commerce/route.ts'),
  [
    "action === 'register-shopify-catalog-webhooks'",
    'confirmProviderWrites !== true',
    'registerShopifyCatalogWebhookSubscriptions',
  ],
  'Shopify catalog webhook registration API',
)
includes(
  read('app_src/components/settings/CommerceIntegrationPanel.tsx'),
  [
    'registerCatalogWebhooks',
    'Register catalog webhooks',
    'read-only catalog reconciliation in Shadow',
  ],
  'Shopify catalog webhook registration UI',
)

includes(
  read('app_src/components/settings/CommerceIntakeWorkflow.tsx'),
  [
    'pendingRefreshSignals?: number | null',
    'pendingCatalogRefreshSignals',
    'catalog change notification${',
    'waiting while synchronization is paused',
    'Faire does not currently provide catalog webhooks',
  ],
  'Paused catalog refresh observability UI',
)
includes(
  read('app_src/lib/persistence/commerceIntake.ts'),
  [
    'const productCatalogSync = await readCommerceCatalogSyncStateWithClient(',
    'productCatalogSync,',
  ],
  'Commerce intake catalog-sync state projection',
)
includes(
  read('app_src/app/api/integrations/commerce/intake/route.ts'),
  [
    'const intake = await getCommerceIntake({',
    'return json({ ok: true, intake })',
  ],
  'Commerce intake API state response',
)

const worker = read('app_src/lib/commerceCatalogSyncWorker.ts')
includes(worker, [
  'const followUpQueued = await queueAutomaticCommerceCatalogSyncsInPostgres()',
  'autoQueued: autoQueued + followUpQueued',
], 'Shopify catalog follow-up scheduling')

includes(
  read('app_src/app/api/health/route.ts'),
  [
    'operations_shopify_catalog_webhook_refresh_applied',
    '0197_operations_shopify_catalog_webhook_refresh.sql',
  ],
  'Shopify catalog webhook migration health gate',
)

console.log(
  'Shopify catalog webhook refresh tests passed '
  + '(registration, signed receipt signal, monotonic watermark, follow-up '
  + 'scheduling, paused-state observability, Faire null semantics, read-only '
  + 'boundary, and zero provider writes).',
)
