#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

function loadTypeScriptModule(path, { mocks = {}, globals = {} } = {}) {
  const result = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.equal(
    errors.length,
    0,
    errors.map((diagnostic) => (
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    )).join('\n'),
  )

  const loadedModule = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    BigInt,
    Buffer,
    Date,
    Error,
    Headers,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RangeError,
    RegExp,
    Request,
    Response,
    Set,
    String,
    TextDecoder,
    TextEncoder,
    TypeError,
    URL,
    URLSearchParams,
    Uint8Array,
    clearTimeout,
    console,
    crypto,
    exports: loadedModule.exports,
    fetch,
    module: loadedModule,
    process,
    setTimeout,
    ...globals,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      if (
        specifier
        === '@/lib/integrations/commerceFaireAutomaticPromotion'
      ) {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceFaireAutomaticPromotion.ts',
        )
      }
      if (
        specifier
        === '@/lib/integrations/commerceShopifyAutomaticPromotion'
      ) {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceShopifyAutomaticPromotion.ts',
        )
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(result.outputText, sandbox, { filename: path })
  return loadedModule.exports
}

const migration = read('db/migrations/0114_operations_commerce_normalization.sql')
includes(migration, [
  "CHECK (provider IN ('shopify', 'faire'))",
  "CHECK (provider_access_mode = 'read_only')",
  'provider_write_count integer NOT NULL DEFAULT 0',
  'CHECK (provider_write_count = 0)',
  'sync_cursor_advanced boolean NOT NULL DEFAULT false',
  'CHECK (sync_cursor_advanced = false)',
  'inventory_write_count integer NOT NULL DEFAULT 0',
  'reservation_write_count integer NOT NULL DEFAULT 0',
  'fulfillment_write_count integer NOT NULL DEFAULT 0',
  'shipment_write_count integer NOT NULL DEFAULT 0',
  'commerce_export_write_count integer NOT NULL DEFAULT 0',
], 'Commerce intake migration')
const continuationMigration = read(
  'db/migrations/0115_operations_commerce_intake_continuations.sql',
)
const currentIssueIndexMigration = read(
  'db/migrations/0158_operations_commerce_current_issue_index.sql',
)
includes(continuationMigration, [
  'CREATE TABLE IF NOT EXISTS operations_commerce_intake_continuations',
  "cursor_state IN (\n      'available', 'consumed', 'exhausted'",
  'cursor_ciphertext bytea',
  'cursor_iv bytea',
  'cursor_tag bytea',
  'consumed_by_run_id uuid',
  'Commerce intake continuation batch lineage is invalid',
  'never a durable provider sync cursor',
], 'Commerce intake continuation migration')
const productPolicyMigration = read(
  'db/migrations/0119_operations_commerce_product_intake_policy.sql',
)
includes(productPolicyMigration, [
  'CREATE TABLE IF NOT EXISTS operations_commerce_product_intake_policies',
  "'commerce-product-intake-policy-v1'",
  "CHECK (unmatched_action IN ('review', 'auto_create'))",
  'revision integer NOT NULL CHECK (revision > 0)',
  'PRIMARY KEY (organization_id, integration_account_id)',
  'operations_commerce_product_intake_policy_account_fkey',
  'DROP INDEX IF EXISTS idx_operations_product_mappings_exact_variant',
  'AND active = true',
], 'Commerce product-intake policy migration')
const catalogSyncMigration = read(
  'db/migrations/0120_operations_commerce_catalog_sync.sql',
)
includes(catalogSyncMigration, [
  'CREATE TABLE IF NOT EXISTS operations_commerce_catalog_sync_jobs',
  "status IN (\n      'pending', 'processing', 'failed',",
  'credential_version integer NOT NULL',
  'policy_revision integer NOT NULL',
  'continuation_run_global_id',
  'read_generation integer NOT NULL DEFAULT 0',
  'products_unchanged bigint NOT NULL DEFAULT 0',
  'attempt_count integer NOT NULL DEFAULT 0',
  'max_attempts integer NOT NULL DEFAULT 8',
  'idx_operations_commerce_catalog_sync_active_account',
  "WHERE status IN ('pending', 'processing', 'failed')",
  'operations_commerce_catalog_sync_lease_valid',
  'operations_commerce_catalog_sync_completion_valid',
  "'Product-only Shopify/Faire catalog backfill",
], 'Commerce catalog-sync migration')
const fulfilledLinePriceMigration = read(
  'db/migrations/0139_operations_fulfilled_line_price_state.sql',
)
includes(fulfilledLinePriceMigration, [
  'DROP CONSTRAINT IF EXISTS commerce_order_lines_price_block_valid',
  'unfulfilled_quantity = 0',
  "price_resolution_state <> 'unresolved'",
  "'line_price_required' = ANY(blocking_codes)",
], 'Fulfilled commerce-line price-state migration')
const catalogSyncPersistenceSource = read(
  'app_src/lib/persistence/commerceCatalogSync.ts',
)
includes(catalogSyncPersistenceSource, [
  'applyCommerceCatalogSyncPolicyWithClient',
  'ensureAutomaticCommerceCatalogIntakeWithClient',
  'automaticCommerceCatalogRuntimeAvailable',
  'queueAutomaticCommerceCatalogSyncsInPostgres',
  'claimCommerceCatalogSyncJobsInPostgres',
  'completeCommerceCatalogSyncPageInPostgres',
  'failCommerceCatalogSyncJobInPostgres',
  'readCommerceCatalogSyncStateWithClient',
  'account.commerce_credential_generation',
  "credential.verification_status = 'verified'",
  'commerceCatalogCredentialSupportsProducts',
  'PRODUCT_READABLE_CONNECTION_SQL',
  "account.configuration->'grantedScopes'",
  "account.configuration->'requestedScopes'",
  "credential.auth_mode = 'faire_brand_token'",
  "has('read_products')",
  "has('write_products')",
  "has('READ_PRODUCTS')",
  'commerce.intake.product_policy.connected_default',
  'connectionIsAuthorization: true',
  'productTargetReady: account.product_target_ready',
  'waitingForProductTarget',
  "existing?.unmatched_action || 'auto_create'",
  'review policy only controls unmatched-product creation',
  'COMMERCE_CATALOG_SYNC_FENCE_CHANGED',
  "activation.state IN ('shadow', 'active')",
  'FOR UPDATE OF job SKIP LOCKED',
  "const CATALOG_SYNC_LEASE = '10 minutes'",
  'attempt_count = 0',
  'sweepFailureCount',
  'commerceCatalogSweepFailureState',
  'COMMERCE_CATALOG_SYNC_PAGE_LIMIT_EXCEEDED',
  'COMMERCE_CATALOG_SYNC_RECORD_LIMIT_EXCEEDED',
  'COMMERCE_CATALOG_SYNC_DURATION_LIMIT_EXCEEDED',
  'COMMERCE_CATALOG_SYNC_CONTINUATION_REPEATED',
  "terminal.status = 'dead'",
  "recent.status = 'succeeded'",
  'read_generation = read_generation',
  'products_unchanged = products_unchanged',
  'power(2, LEAST(attempt_count, 8))',
  'queued',
  'running',
  'retrying',
  'completed',
  'paused',
  'dead',
  'lastSuccessAt',
  'nextRunAt',
  'terminalRecoveryRequired',
  "recoveryMode: status === 'dead'",
  "'operator_policy_revision'",
  'deadEvidencePreserved',
  'historicalTerminalEvidence',
  'authoritativeFence',
  'providerWrites: 0',
  'ordersTouched: 0',
  'inventoryTouched: 0',
], 'Commerce catalog-sync persistence')
assert.equal(
  (
    catalogSyncPersistenceSource.match(/terminal\.status = 'dead'/g)
    || []
  ).length,
  2,
  'Policy application and recurring queueing must not resurrect a dead sweep '
    + 'under the same credential and policy fence',
)
assert.equal(
  (
    catalogSyncPersistenceSource.match(
      /AND \$\{PRODUCT_READABLE_CONNECTION_SQL\}/g,
    ) || []
  ).length,
  6,
  'Product-read eligibility must gate policy application, stale-job fencing, '
    + 'recurring queueing, claiming, and the completion fence',
)
const catalogPolicyApplicationSource = catalogSyncPersistenceSource.slice(
  catalogSyncPersistenceSource.indexOf(
    'export async function applyCommerceCatalogSyncPolicyWithClient',
  ),
  catalogSyncPersistenceSource.indexOf(
    'export function automaticCommerceCatalogRuntimeAvailable',
  ),
)
includes(catalogPolicyApplicationSource, [
  'INSERT INTO operations_commerce_catalog_sync_jobs (',
  'credential_version, policy_revision, requested_by,',
  'target_dirty_version',
], 'Fresh catalog-sync policy queue')
assert.doesNotMatch(
  catalogPolicyApplicationSource,
  /INSERT INTO operations_commerce_catalog_sync_jobs \([\s\S]{0,300}continuation_run_global_id/,
  'A policy supersession must queue a new root sweep without copying the dead continuation',
)
const catalogCredentialPolicyModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceCatalogSync.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async acquireTransactionAdvisoryLock() {},
        async query() {
          throw new Error('Unexpected database query')
        },
        async withTransaction() {
          throw new Error('Unexpected transaction')
        },
      },
    },
  },
)
assert.equal(
  catalogCredentialPolicyModule.commerceCatalogCredentialSupportsProducts({
    provider: 'shopify',
    authMode: 'shopify_client_credentials',
    configuration: { grantedScopes: ['read_products', 'read_orders'] },
  }),
  true,
)
assert.equal(
  catalogCredentialPolicyModule.commerceCatalogCredentialSupportsProducts({
    provider: 'shopify',
    authMode: 'shopify_client_credentials',
    configuration: { grantedScopes: ['write_products', 'read_orders'] },
  }),
  true,
  'Shopify write_products also grants the product reads required by catalog sync',
)
assert.equal(
  catalogCredentialPolicyModule.commerceCatalogCredentialSupportsProducts({
    provider: 'shopify',
    authMode: 'shopify_client_credentials',
    configuration: { grantedScopes: ['read_orders'] },
  }),
  false,
)
assert.equal(
  catalogCredentialPolicyModule.commerceCatalogCredentialSupportsProducts({
    provider: 'faire',
    authMode: 'faire_brand_token',
    configuration: {},
  }),
  true,
)
assert.equal(
  catalogCredentialPolicyModule.commerceCatalogCredentialSupportsProducts({
    provider: 'faire',
    authMode: 'faire_oauth',
    configuration: { requestedScopes: ['READ_BRAND', 'READ_PRODUCTS'] },
  }),
  true,
)
assert.equal(
  catalogCredentialPolicyModule.commerceCatalogCredentialSupportsProducts({
    provider: 'faire',
    authMode: 'faire_oauth',
    configuration: { requestedScopes: ['READ_BRAND'] },
  }),
  false,
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    catalogCredentialPolicyModule.commerceCatalogSweepFailureState({
      code: 'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
      attemptCount: 1,
      sweepFailureCount: 0,
      maxAttempts: 8,
    }),
  )),
  {
    sweepFailureCount: 1,
    permanent: false,
    dead: false,
  },
  'A restart failure must consume one sweep-level failure attempt',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    catalogCredentialPolicyModule.commerceCatalogSweepFailureState({
      code: 'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
      attemptCount: 1,
      sweepFailureCount: 7,
      maxAttempts: 8,
    }),
  )),
  {
    sweepFailureCount: 8,
    permanent: false,
    dead: true,
  },
  'Successful prefix pages must not reset the sweep failure budget',
)
assert.equal(
  catalogCredentialPolicyModule.commerceCatalogSweepFailureState({
    code: 'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
    attemptCount: 8,
    sweepFailureCount: 0,
    maxAttempts: 8,
  }).dead,
  true,
  'A legacy in-flight retry must retain its consecutive failure budget',
)
assert.equal(
  catalogCredentialPolicyModule.commerceCatalogSweepFailureState({
    code: 'COMMERCE_CATALOG_SYNC_PAGE_LIMIT_EXCEEDED',
    attemptCount: 1,
    sweepFailureCount: 0,
    maxAttempts: 8,
  }).dead,
  true,
  'A sweep limit failure must dead-letter immediately',
)
const automaticIntakeAudit = []
function automaticIntakeClient({
  account,
  policy = null,
  queued = 1,
  cancelled = 0,
}) {
  const queries = []
  return {
    queries,
    async query(sql) {
      queries.push(sql)
      if (sql.includes('AS product_target_ready')) {
        return { rows: account ? [account] : [], rowCount: account ? 1 : 0 }
      }
      if (sql.includes('SELECT unmatched_action, revision')) {
        return { rows: policy ? [policy] : [], rowCount: policy ? 1 : 0 }
      }
      if (sql.includes(
        'INSERT INTO operations_commerce_product_intake_policies',
      )) {
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE operations_commerce_catalog_sync_jobs')) {
        return { rows: [], rowCount: cancelled }
      }
      if (sql.includes('INSERT INTO operations_commerce_catalog_sync_jobs')) {
        return { rows: [], rowCount: queued }
      }
      if (sql.includes('UPDATE operations_commerce_sync_cursors cursor')) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`Unexpected automatic-intake query: ${sql}`)
    },
  }
}
const automaticIntakeModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceCatalogSync.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent(event) {
          automaticIntakeAudit.push(event)
        },
      },
      '@/lib/persistence/postgres': {
        async acquireTransactionAdvisoryLock() {},
        async query() {
          throw new Error('Unexpected database query')
        },
        async withTransaction() {
          throw new Error('Unexpected transaction')
        },
      },
    },
  },
)
const automaticIntakeAccount = {
  global_id: 'gcia0000001',
  provider: 'shopify',
  status: 'disabled',
  configuration: { grantedScopes: ['read_products'] },
  commerce_credential_generation: 3,
  credential_version: 3,
  verification_status: 'verified',
  auth_mode: 'shopify_client_credentials',
  product_target_ready: true,
}
const automaticIntakeReadyClient = automaticIntakeClient({
  account: automaticIntakeAccount,
})
const savedBehaviorRuntime = {
  enabled: process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED,
  lane: process.env.CLAWPILOT_ENV,
}
process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = '1'
process.env.CLAWPILOT_ENV = 'development'
const automaticIntakeReady =
  await automaticIntakeModule.ensureAutomaticCommerceCatalogIntakeWithClient(
    automaticIntakeReadyClient,
    {
      organizationId: '11111111-1111-4111-8111-111111111111',
      integrationAccountId: '22222222-2222-4222-8222-222222222222',
      actorEmail: 'operator@example.com',
    },
  )
assert.deepEqual(
  JSON.parse(JSON.stringify(automaticIntakeReady)),
  {
    eligible: true,
    initialized: true,
    paused: false,
    waitingForProductTarget: false,
    policyRevision: 1,
    queued: 1,
    cancelled: 0,
  },
  'A verified product-readable connection must initialize and queue automatically',
)
assert.equal(automaticIntakeAudit.length, 1)
const automaticIntakeWaitingClient = automaticIntakeClient({
  account: {
    ...automaticIntakeAccount,
    product_target_ready: false,
  },
})
const automaticIntakeWaiting =
  await automaticIntakeModule.ensureAutomaticCommerceCatalogIntakeWithClient(
    automaticIntakeWaitingClient,
    {
      organizationId: '11111111-1111-4111-8111-111111111111',
      integrationAccountId: '22222222-2222-4222-8222-222222222222',
      actorEmail: 'operator@example.com',
    },
  )
assert.equal(automaticIntakeWaiting.initialized, true)
assert.equal(automaticIntakeWaiting.waitingForProductTarget, true)
assert.equal(automaticIntakeWaiting.queued, 0)
assert.equal(
  automaticIntakeWaitingClient.queries.some(
    (sql) => sql.includes(
      'INSERT INTO operations_commerce_catalog_sync_jobs',
    ),
  ),
  false,
  'Workspace target readiness must not become another user approval',
)
const automaticIntakePausedClient = automaticIntakeClient({
  account: automaticIntakeAccount,
  policy: { unmatched_action: 'review', revision: 4 },
})
const automaticIntakePaused =
  await automaticIntakeModule.ensureAutomaticCommerceCatalogIntakeWithClient(
    automaticIntakePausedClient,
    {
      organizationId: '11111111-1111-4111-8111-111111111111',
      integrationAccountId: '22222222-2222-4222-8222-222222222222',
      actorEmail: 'operator@example.com',
    },
  )
assert.equal(automaticIntakePaused.paused, false)
assert.equal(automaticIntakePaused.queued, 1)
assert.equal(automaticIntakePaused.policyRevision, 4)
const automaticIntakeScopeLossClient = automaticIntakeClient({
  account: {
    ...automaticIntakeAccount,
    configuration: { grantedScopes: ['read_orders'] },
  },
  cancelled: 1,
})
const automaticIntakeScopeLoss =
  await automaticIntakeModule.ensureAutomaticCommerceCatalogIntakeWithClient(
    automaticIntakeScopeLossClient,
    {
      organizationId: '11111111-1111-4111-8111-111111111111',
      integrationAccountId: '22222222-2222-4222-8222-222222222222',
      actorEmail: 'operator@example.com',
    },
  )
assert.equal(automaticIntakeScopeLoss.eligible, false)
assert.equal(automaticIntakeScopeLoss.cancelled, 1)
assert.equal(
  automaticIntakeScopeLossClient.queries.some(
    (sql) => sql.includes('SELECT unmatched_action, revision'),
  ),
  false,
  'Product-scope loss must fence active work before consulting auto policy',
)
if (savedBehaviorRuntime.enabled === undefined) {
  delete process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED
} else {
  process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED =
    savedBehaviorRuntime.enabled
}
if (savedBehaviorRuntime.lane === undefined) {
  delete process.env.CLAWPILOT_ENV
} else {
  process.env.CLAWPILOT_ENV = savedBehaviorRuntime.lane
}
const savedAutomaticCatalogRuntime = {
  enabled: process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED,
  lane: process.env.CLAWPILOT_ENV,
}
process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = '1'
process.env.CLAWPILOT_ENV = 'development'
assert.equal(
  catalogCredentialPolicyModule.automaticCommerceCatalogRuntimeAvailable(),
  true,
)
process.env.CLAWPILOT_ENV = 'production'
assert.equal(
  catalogCredentialPolicyModule.automaticCommerceCatalogRuntimeAvailable(),
  false,
  'Connecting in production must not create a dormant development catalog job',
)
if (savedAutomaticCatalogRuntime.enabled === undefined) {
  delete process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED
} else {
  process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED =
    savedAutomaticCatalogRuntime.enabled
}
if (savedAutomaticCatalogRuntime.lane === undefined) {
  delete process.env.CLAWPILOT_ENV
} else {
  process.env.CLAWPILOT_ENV = savedAutomaticCatalogRuntime.lane
}
const catalogSyncWorkerSource = read(
  'app_src/lib/commerceCatalogSyncWorker.ts',
)
includes(catalogSyncWorkerSource, [
  'executeCommerceCatalogProductPage',
  'replayHeldShopifyProductDeletionsInPostgres',
  'heldProductDeletionsReconciled',
  'queueAutomaticCommerceCatalogSyncsInPostgres',
  'claimCommerceCatalogSyncJobsInPostgres',
  'completeCommerceCatalogSyncPageInPostgres',
  'failCommerceCatalogSyncJobInPostgres',
  'if (automatic.failed === true)',
  'COMMERCE_PRODUCT_AUTO_CREATE_SWEEP_FAILED',
  'MAX_CATALOG_SWEEP_PAGES = 1_000',
  'MAX_CATALOG_SWEEP_PROVIDER_RECORDS = 50_000',
  'MAX_CATALOG_SWEEP_DURATION_MS = 2 * 60 * 60 * 1_000',
  'assertCommerceCatalogSweepCanRead(job)',
  'assertCommerceCatalogSweepPageWithinLimits',
  'COMMERCE_CATALOG_SYNC_CONTINUATION_REPEATED',
  'pageCount: job.pageCount',
  'readGeneration: job.readGeneration',
  "resource: 'products'",
  'providerWrites: 0',
  'ordersTouched: 0',
  'inventoryTouched: 0',
], 'Commerce catalog-sync worker')
const catalogSyncRouteSource = read(
  'app_src/app/api/integrations/commerce/catalog/process/route.ts',
)
includes(catalogSyncRouteSource, [
  'PIPELINE_OUTBOX_WORKER_SECRET',
  'timingSafeEqual',
  'commerceIntakeRuntimeAvailable()',
  'processCommerceCatalogSyncOutbox',
  'recordCommerceCatalogWorkerHeartbeatInPostgres',
], 'Commerce catalog-sync worker route')
includes(read('app_src/app/api/health/route.ts'), [
  'FROM operations_commerce_catalog_sync_jobs',
  "WHERE status = 'dead' AND authoritative",
  ')::integer AS historical_dead',
  'historicalDead: Number(commerceQueue?.historical_dead || 0)',
  'account.commerce_credential_generation',
  '= job.credential_version',
  "policy.policy_version\n                                = 'commerce-product-intake-policy-v1'",
  'policy.revision = job.policy_revision',
  "activation.state IN ('shadow', 'active')",
  'unreconciled_shopify_signals',
  'overdue_shopify_refreshes_without_active_job',
  'Commerce catalog queue has terminal failed jobs.',
], 'Authoritative commerce catalog terminal-failure health projection')
const runtimePollerSource = read('scripts/pipeline-outbox-poller.mjs')
includes(runtimePollerSource, [
  'CLAWPILOT_COMMERCE_INTAKE_ENABLED',
  'commerceCatalogEnabled',
  "runLoop('commerce-catalog'",
  '/api/integrations/commerce/catalog/process',
], 'Conditional commerce catalog poller')
const proxySource = read('app_src/proxy.ts')
includes(proxySource, [
  '/api/integrations/commerce/catalog/process',
], 'Commerce catalog worker proxy allowlist')
const catalogWorkerTrace = {
  pages: [],
  completions: [],
  failures: [],
}
const catalogWorkerModule = loadTypeScriptModule(
  'app_src/lib/commerceCatalogSyncWorker.ts',
  {
    mocks: {
      '@/lib/persistence/commerceIntegrations': {
        async replayHeldShopifyProductDeletionsInPostgres() {
          return {
            selected: 1,
            reconciled: 1,
            held: 0,
            failed: 0,
            deadLettered: 0,
            providerWrites: 0,
          }
        },
      },
      '@/lib/integrations/commerceIntake': {
        async executeCommerceCatalogProductPage(input) {
          catalogWorkerTrace.pages.push(input)
          return {
            command: {
              pagination: {
                providerRowsSeen: 50,
                hasNextBatch: false,
                continuationRunGlobalId: null,
              },
              automaticProductCreation: {
                created: 48,
                mappedExisting: 0,
                skipped: 2,
                failed: 0,
              },
            },
            intake: null,
          }
        },
      },
      '@/lib/persistence/commerceCatalogSync': {
        async queueAutomaticCommerceCatalogSyncsInPostgres() {
          return 0
        },
        async claimCommerceCatalogSyncJobsInPostgres() {
          return [{
            id: '11111111-1111-4111-8111-111111111111',
            organizationId: '22222222-2222-4222-8222-222222222222',
            integrationAccountId:
              '33333333-3333-4333-8333-333333333333',
            accountGlobalId: 'gcia0000001',
            provider: 'shopify',
            credentialVersion: 4,
            policyRevision: 2,
            requestedBy: 'operator@example.com',
            continuationRunGlobalId: null,
            readGeneration: 0,
            pageCount: 125,
            providerRecordsSeen: 6_250,
            attemptCount: 1,
            sweepFailureCount: 2,
            maxAttempts: 8,
            startedAt: new Date(Date.now() - 1_000).toISOString(),
            lockToken: '44444444-4444-4444-8444-444444444444',
          }]
        },
        async completeCommerceCatalogSyncPageInPostgres(input) {
          catalogWorkerTrace.completions.push(input)
          return {
            status: 'succeeded',
            pageCount: input.job.pageCount + 1,
            hasNextBatch: false,
          }
        },
        async failCommerceCatalogSyncJobInPostgres(input) {
          catalogWorkerTrace.failures.push(input)
          return { dead: false, leaseLost: false }
        },
      },
    },
  },
)
const catalogWorkerResult =
  await catalogWorkerModule.processCommerceCatalogSyncOutbox({
    limit: 2,
    workerId: 'test-worker',
  })
assert.equal(catalogWorkerResult.pagesCompleted, 1)
assert.equal(catalogWorkerResult.jobsCompleted, 1)
assert.equal(catalogWorkerResult.heldProductDeletionsReconciled, 1)
assert.equal(catalogWorkerTrace.failures.length, 0)
assert.equal(catalogWorkerTrace.pages[0].continuationRunGlobalId, null)
assert.equal(catalogWorkerTrace.completions[0].totals.providerRecordsSeen, 50)
assert.equal(catalogWorkerTrace.completions[0].totals.productsCreated, 48)
assert.equal(catalogWorkerTrace.completions[0].totals.productsSkipped, 2)
assert.equal(catalogWorkerTrace.completions[0].totals.productsUnchanged, 0)
assert.equal(
  catalogWorkerTrace.completions[0].job.pageCount,
  125,
  'Successful page count must be independent from retry attempts',
)
const guardedCatalogJob = {
  ...catalogWorkerTrace.completions[0].job,
  continuationRunGlobalId: 'gcir0000001',
  startedAt: '2026-08-01T12:00:00.000Z',
}
assert.throws(
  () => catalogWorkerModule.assertCommerceCatalogSweepCanRead({
    ...guardedCatalogJob,
    pageCount: 1_000,
  }, Date.parse('2026-08-01T12:01:00.000Z')),
  (error) => error.code === 'COMMERCE_CATALOG_SYNC_PAGE_LIMIT_EXCEEDED',
  'A catalog sweep at its page limit must not make another provider request',
)
assert.throws(
  () => catalogWorkerModule.assertCommerceCatalogSweepCanRead({
    ...guardedCatalogJob,
    providerRecordsSeen: 50_000,
  }, Date.parse('2026-08-01T12:01:00.000Z')),
  (error) => error.code === 'COMMERCE_CATALOG_SYNC_RECORD_LIMIT_EXCEEDED',
  'A catalog sweep at its record limit must not make another provider request',
)
assert.throws(
  () => catalogWorkerModule.assertCommerceCatalogSweepCanRead(
    guardedCatalogJob,
    Date.parse('2026-08-01T14:00:00.000Z'),
  ),
  (error) => error.code === 'COMMERCE_CATALOG_SYNC_DURATION_LIMIT_EXCEEDED',
  'A two-hour catalog sweep must not make another provider request',
)
assert.throws(
  () => catalogWorkerModule.assertCommerceCatalogSweepPageWithinLimits({
    job: guardedCatalogJob,
    continuationRunGlobalId: 'gcir0000001',
    hasNextBatch: true,
    providerRecordsSeen: 50,
    nowMs: Date.parse('2026-08-01T12:01:00.000Z'),
  }),
  (error) => error.code === 'COMMERCE_CATALOG_SYNC_CONTINUATION_REPEATED',
  'A provider page must not reuse the current continuation handle',
)
const limitedCatalogTrace = {
  providerCalls: 0,
  failures: [],
}
const limitedCatalogWorkerModule = loadTypeScriptModule(
  'app_src/lib/commerceCatalogSyncWorker.ts',
  {
    mocks: {
      '@/lib/persistence/commerceIntegrations': {
        async replayHeldShopifyProductDeletionsInPostgres() {
          return {
            selected: 0,
            reconciled: 0,
            held: 0,
            failed: 0,
            deadLettered: 0,
            providerWrites: 0,
          }
        },
      },
      '@/lib/integrations/commerceIntake': {
        async executeCommerceCatalogProductPage() {
          limitedCatalogTrace.providerCalls += 1
          throw new Error('Provider read must not run for an over-limit sweep')
        },
      },
      '@/lib/persistence/commerceCatalogSync': {
        async queueAutomaticCommerceCatalogSyncsInPostgres() {
          return 0
        },
        async claimCommerceCatalogSyncJobsInPostgres() {
          return [{
            ...guardedCatalogJob,
            pageCount: 1_000,
            startedAt: new Date(Date.now() - 1_000).toISOString(),
          }]
        },
        async completeCommerceCatalogSyncPageInPostgres() {
          assert.fail('An over-limit sweep must not complete another page')
        },
        async failCommerceCatalogSyncJobInPostgres(input) {
          limitedCatalogTrace.failures.push(input)
          return { dead: true, leaseLost: false }
        },
      },
    },
  },
)
const limitedCatalogResult =
  await limitedCatalogWorkerModule.processCommerceCatalogSyncOutbox({
    limit: 1,
    workerId: 'limit-test-worker',
  })
assert.equal(limitedCatalogTrace.providerCalls, 0)
assert.equal(limitedCatalogTrace.failures.length, 1)
assert.equal(
  limitedCatalogTrace.failures[0].error.code,
  'COMMERCE_CATALOG_SYNC_PAGE_LIMIT_EXCEEDED',
)
assert.equal(limitedCatalogResult.jobsDead, 1)
const mappingPolicy = loadTypeScriptModule(
  'app_src/lib/integrations/commerceProductMappingPolicy.ts',
)
assert.equal(
  mappingPolicy.exactProductMappingMutation({
    activeProductId: 'product-a',
    requestedProductId: 'product-b',
    allowReplacement: false,
  }),
  'preserve',
  'Automatic catalog intake must preserve an existing operator mapping',
)
assert.equal(
  mappingPolicy.exactProductMappingMutation({
    activeProductId: 'product-a',
    requestedProductId: 'product-b',
    allowReplacement: true,
  }),
  'replace',
  'An explicit operator mapping may rotate the active future binding',
)
assert.equal(
  mappingPolicy.exactProductMappingMutation({
    activeProductId: 'product-a',
    requestedProductId: 'product-a',
    allowReplacement: false,
  }),
  'reuse',
  'Automatic catalog intake may reuse the same active product mapping',
)
assert.equal(
  mappingPolicy.exactProductMappingMutation({
    activeProductId: null,
    requestedProductId: 'product-a',
    allowReplacement: false,
  }),
  'create',
  'Automatic catalog intake may create a mapping only when none exists',
)

const serviceSource = read('app_src/lib/integrations/commerceIntake.ts')
includes(serviceSource, [
  "resolution.identityConflictPolicy === 'provider_qualified'",
  "identityConflictPolicy:",
], 'Collision-safe explicit product command parsing')
const backgroundCatalogPageSource = serviceSource.slice(
  serviceSource.indexOf(
    'export async function executeCommerceCatalogProductPage',
  ),
)
includes(backgroundCatalogPageSource, [
  'executeCommerceIntakeCommandInternal',
  "includeIntakeState: false",
  "hydrateProductInventory: false",
  "'fetch-next-products'",
  "'fetch-products'",
], 'O(page) background commerce catalog execution')
assert.ok(
  !backgroundCatalogPageSource.includes(
    'readCommerceIntakeStateFromPostgres({',
  ),
  'The background page wrapper must not materialize retained intake state',
)
const shopifyQuerySource = serviceSource.slice(
  serviceSource.indexOf('const SHOPIFY_LINE_ITEM_FIELDS'),
  serviceSource.indexOf('type IntakeCommandAction'),
)
includes(shopifyQuerySource, [
  'query ClawPilotCommerceOrders',
  'query ClawPilotCommerceOrder($id: ID!)',
  'query ClawPilotCommerceOrderLines',
  'query ClawPilotCommerceProductVariants',
  'orders(',
  'first: ${SHOPIFY_ORDER_PAGE_SIZE}',
  'after: $after',
  'sortKey: ID',
  'endCursor',
  'currentQuantity',
  'unfulfilledQuantity',
  'unfulfilledOriginalTotalSet',
  'unfulfilledDiscountedTotalSet',
  'totalDiscountSet',
  'taxLines(first: 50)',
  'returnStatus',
  'email',
  'phone',
  'shippingAddress',
  'shippingLine',
  'customer {',
  'purchasingEntity {',
  'taxable',
  'selectedOptions {',
  'inventoryItem {',
  'requiresShipping',
  'measurement {',
  'weight {',
  'media(first: ${SHOPIFY_PRODUCT_IMAGE_PAGE_SIZE})',
  'mediaContentType',
  '... on MediaImage',
  'alt',
  'image {',
  'url',
  'width',
  'height',
  'pageInfo {',
  'hasNextPage',
], 'Shopify intake query')
includes(serviceSource, [
  'SHOPIFY_PRODUCT_IMAGE_PAGE_SIZE = 50',
], 'Bounded Shopify product-image intake')
const shopifyProductQuerySource = serviceSource.slice(
  serviceSource.indexOf('function shopifyProductVariantsQuery'),
  serviceSource.indexOf('type IntakeCommandAction'),
)
assert.doesNotMatch(
  shopifyProductQuerySource,
  /\b(?:originalSource|preview|mimeType|fileErrors|mediaErrors)\b/,
  'Shopify product-image intake must request only transient locator metadata',
)
includes(serviceSource, [
  "hasEffectiveShopifyScope(\n    grant.grantedScopes,\n    'read_customers'",
  "hasEffectiveShopifyScope(\n    probe.grantedScopes,\n    'read_customers'",
  'shopifyOrderQuery(includeCustomerIdentity)',
  'shopifyOrdersQuery(includeCustomerIdentity)',
], 'Shopify protected customer-data query gating')
includes(serviceSource, [
  "hasEffectiveShopifyScope(grant.grantedScopes, 'read_products')",
  "hasEffectiveShopifyScope(probe.grantedScopes, 'read_products')",
  "hasEffectiveShopifyScope(grant.grantedScopes, 'read_inventory')",
  "hasEffectiveShopifyScope(probe.grantedScopes, 'read_inventory')",
], 'Shopify token and installed-app scope intersection')
assert.doesNotMatch(
  shopifyQuerySource,
  /\bmutation\b/i,
  'Shopify intake GraphQL must remain read-only',
)
assert.doesNotMatch(
  shopifyQuerySource,
  /productVariants\([\s\S]*?sortKey:\s*UPDATED_AT/,
  'Shopify product-variant intake must use a supported 2026-07 sort key',
)

includes(serviceSource, [
  'getFaireOrder',
  'COMMERCE_INTAKE_EXACT_ORDER_ID_INVALID',
  'COMMERCE_INTAKE_EXACT_ORDER_ACTION_INVALID',
  'exactExternalOrderIdHash',
  'listFaireOrders',
  'listFaireProducts',
  'listFaireInventory',
  'probeFaireBrandProfile',
  'product_status:active,archived,draft,unlisted',
  "Shopify's search values are case-sensitive lowercase",
  'SHOPIFY_ORDER_PAGE_SIZE = 25',
  'FAIRE_ORDER_PAGE_SIZE = 50',
  'FAIRE_INVENTORY_SELECTOR_LIMIT = 50',
  'FAIRE_MAX_INVENTORY_REQUESTS = 20',
  'SHOPIFY_MAX_NESTED_LINE_REQUESTS',
  'COMMERCE_ORDER_LINE_PAGINATION_LIMIT',
  "targetExternalOrderId ? 'current' : 'stale'",
  'readCommerceIntakeRefreshTargetFromPostgres',
  'readCommerceIntakeStageReplayFromPostgres',
  'prepareCommerceIntakeReadIntentInPostgres',
  'reserveCommerceIntakeProviderReadInPostgres',
  'captureCommerceIntakeProviderReadInPostgres',
  'markCommerceIntakeProviderReadUncertainInPostgres',
  'readCommerceIntakeRejectionTargetFromPostgres',
  'excludeCommerceIntakeRejectionInPostgres',
  'providerAttemptActorEmail',
  'options.providerAttemptActorEmail === undefined',
  'providerAttemptActorEmail: null',
  'readOnly: true',
  'providerWrites: 0',
  'syncCursorAdvanced: false',
  "commandAction === 'fetch'",
  "commandAction === 'fetch-next'",
  "commandAction === 'fetch-products'",
  "commandAction === 'fetch-next-products'",
  "commandAction === 'retry-rejection'",
  "commandAction === 'exclude-rejection'",
  "commandAction === 'resolve-catalog-product'",
  "commandAction === 'resolve-product'",
  "commandAction === 'resolve-customer'",
  "commandAction === 'resolve-delivery'",
  "commandAction === 'resolve-package'",
  "commandAction === 'set-product-intake-policy'",
  "commandAction === 'validate'",
  "commandAction === 'promote'",
  "commandAction === 'reconcile-checkout-rate'",
  'confirmProviderWriteOff',
  'withAutomaticProductCreation',
  'autoCreateCommerceProductsForRunInPostgres',
  'updateCommerceProductIntakePolicyInPostgres',
  'SHOPIFY_COMMERCE_NORMALIZER_VERSION',
  'FAIRE_COMMERCE_NORMALIZER_VERSION',
  'confirmAutoCreateProducts',
  'confirmCatalogSyncReset',
  'catalogSyncResetReason',
  'COMMERCE_CATALOG_SYNC_RESET_CONFIRMATION_REQUIRED',
  'COMMERCE_CATALOG_SYNC_RESET_REASON_REQUIRED',
  'expectedPolicyRevision',
  'const organizationId = normalizeCommerceOrganizationId(input.organizationId)',
  'const accountGlobalId = normalizeCommerceAccountGlobalId(',
], 'Commerce intake service')
includes(serviceSource, [
  'getFaireProduct',
  'targetExternalProductId',
  "targetExternalProductId ? 'current' : 'stale'",
  'exactExternalProductIdHash',
  'COMMERCE_INTAKE_EXACT_PRODUCT_ACTION_INVALID',
  'COMMERCE_INTAKE_EXACT_PRODUCT_ID_INVALID',
  "'commerce-intake-exact-product-pack-v1'",
  'confirmExactProductRead',
  "mode !== 'variant_mapping'",
  'providerWrites: 0',
  'syncCursorAdvanced: false',
], 'Exact read-only Faire product intake and one-time pack binding')
for (const providerWrite of [
  'moveFaireOrderToProcessing',
  'cancelFaireOrder',
  'addFaireOrderShipment',
  'addFaireOrderShipments',
  'advanceCommerceSyncCursor',
  'updateCommerceSyncCursor',
  'writeCommerceSyncCursor',
]) {
  assert.ok(
    !serviceSource.includes(providerWrite),
    `Commerce intake service must not call ${providerWrite}`,
  )
}

const persistenceSource = read('app_src/lib/persistence/commerceIntake.ts')
const productChannelStateSource = read(
  'app_src/lib/persistence/productChannelStates.ts',
)
includes(productChannelStateSource, [
  'ON CONFLICT (',
  'organization_id, integration_account_id, external_variant_id',
  'normalized_status = EXCLUDED.normalized_status',
  'provider_active = EXCLUDED.provider_active',
  'product_id = COALESCE(',
  'product_mapping_id = COALESCE(',
], 'Provider listing lifecycle reconciliation preserves exact product identity')
includes(persistenceSource, [
  'providerAttemptActorEmail: string | null',
  'input.providerAttemptActorEmail',
  "attempt.redacted_request->>'targetHash'",
  'exactExternalOrderIdHash',
  'exactOrderTargetHash',
  'envelopeMatchesExactOrderTarget',
  'returnedOrderIdentities.length === 1',
  'COMMERCE_INTAKE_EXACT_ORDER_TARGET_MISMATCH',
  "SET disposition = 'retried'",
  'retry_run_id = $2::uuid',
], 'Successful exact-order retry closes the matching legacy rejection')
includes(persistenceSource, [
  'envelopeMatchesExactProductTarget',
  'envelope.products.length === 1',
  'productRejections.length === 0',
  'COMMERCE_INTAKE_EXACT_PRODUCT_TARGET_MISMATCH',
  'exactProductTargetHash',
  'exactProductAuditEvidenceMatches',
  'exactProductReadEvidence',
  'FOR UPDATE OF run, intent, attempt',
  "intent.intake_action = 'fetch-products'",
  "attempt.redacted_request->>'targetHash' = $6",
  'state.global_id = $4',
  'state.row_version = $9::bigint',
  'operations_product_pack_profile_versions version',
  'expectedPackProfileVersionRowVersion',
  'COMMERCE_INTAKE_PACK_UNIT_MULTIPLIER_CONFLICT',
  'operations_product_channel_states state',
  "mapping.mapping_purpose = 'catalog'",
  "mapping.provider = 'faire'",
  "packaging_source = 'variant_pack_mapping'",
  "packaging_weight_source = 'profile_version'",
  'variant_pack_mapping_created_from_exact_product',
  'orderSourceRevision: line.source_revision',
  'orderSourceHash: line.source_hash',
  'channelSourceRevision: channelState.source_revision',
  'channelSourceHash: channelState.source_hash',
  "eventType: 'commerce.intake.variant_pack_mapping_bound'",
], 'Exact Faire variant pack binding preserves source, identity, and version fences')
const variantPackResolutionSource = persistenceSource.slice(
  persistenceSource.indexOf("input.package.mode === 'variant_mapping'"),
  persistenceSource.indexOf('let packageProfileId: string | null'),
)
assert.doesNotMatch(
  variantPackResolutionSource,
  /INSERT INTO operations_product_package_profiles/,
  'Versioned Faire pack binding must not create a legacy package profile',
)
includes(persistenceSource, [
  'reconcileStagedCommerceProductImages',
  "input.account.provider === 'faire'",
  "product.lifecycleState?.toUpperCase() === 'DELETED'",
  "? 'deleted' as const",
  'productLifecycle,',
  'reconcileCommerceProductImageSetWithClient({',
], 'Faire authoritative deletion reaches fenced complete-empty image reconciliation')
includes(persistenceSource, [
  'resolveCommerceRuntimePack',
  'operations_commerce_variant_pack_mappings pack_mapping',
  'operations_product_pack_profile_versions profile_version',
  'profile_version.fit_model',
  'operations_product_channel_states channel_state',
  'pack_mapping.pack_evidence_hash,',
  'channel_state.pack_evidence_hash AS channel_pack_evidence_hash',
  'const channelStateEvidence =',
  'runtimePackMapping.channelPackEvidenceHash =',
  'channelStateEvidence.packEvidenceHash',
  'runtimePackMapping.channelWeightGrams =',
  'channelStateEvidence.weightGrams',
  'pack_mapping.pack_evidence_hash =',
  'channel_state.pack_evidence_hash',
  'commerce_variant_pack_mapping_id',
  'commerce_variant_pack_mapping_row_version',
  'pack_profile_version_id',
  'pack_profile_version_row_version',
  'pack_profile_package_level',
  'pack_profile_base_each_quantity',
  'packaging_weight_source',
  'fitModel: row.fit_model',
  'runtimePack.association',
  "runtimePack.reason === 'recipe_required'",
  "packagingState === 'unresolved'",
  "codes.push('packaging_required')",
  "'variant_pack_mapping'",
  'COMMERCE_INTAKE_PACK_MAPPING_STALE',
], 'Exact physical-pack provider resolution and promotion fencing')

const retainedPackEvidenceHash = 'b'.repeat(64)
const retainedPackWeightGrams = 172
const productChannelStatePersistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/productChannelStates.ts',
  {
    mocks: {
      '@/lib/operations/commercePackEvidence': {
        commercePackEvidenceHash() {
          return 'a'.repeat(64)
        },
      },
      '@/lib/persistence/postgres': { query() {} },
    },
  },
)
const retainedPackQueries = []
const retainedPackEvidence = await productChannelStatePersistenceModule
  .upsertProductChannelStateWithClient(
    {
      async query(sql, parameters) {
        retainedPackQueries.push({ sql, parameters })
        if (sql.includes('INSERT INTO operations_product_channel_states')) {
          return { rows: [] }
        }
        if (sql.includes('SELECT pack_evidence_hash, weight_grams')) {
          return {
            rows: [{
              pack_evidence_hash: retainedPackEvidenceHash,
              weight_grams: retainedPackWeightGrams,
            }],
          }
        }
        throw new Error(`Unexpected product-channel-state query: ${sql}`)
      },
    },
    {
      organizationId: '11111111-1111-4111-8111-111111111111',
      integrationAccountId: '22222222-2222-4222-8222-222222222222',
      pipelineId: '33333333-3333-4333-8333-333333333333',
      provider: 'shopify',
      externalProductId: 'gid://shopify/Product/1',
      externalVariantId: 'gid://shopify/ProductVariant/1',
      externalInventoryItemId: 'gid://shopify/InventoryItem/1',
      providerProductTitle: 'Stale product observation',
      providerVariantTitle: 'Default Title',
      providerSku: 'STALE-1',
      providerBarcode: null,
      providerTaxonomyScheme: null,
      providerCategoryId: null,
      providerCategoryName: null,
      providerCategoryFullName: null,
      providerCategoryPaths: [],
      wholesaleCurrencyCode: null,
      wholesalePriceMinor: null,
      retailCurrencyCode: 'USD',
      retailPriceMinor: '0',
      compareAtCurrencyCode: null,
      compareAtPriceMinor: null,
      taxable: false,
      requiresShipping: true,
      weightGrams: 999,
      productId: null,
      productMappingId: null,
      providerStatusRaw: 'active',
      normalizedStatus: 'active',
      providerActive: true,
      providerUpdatedAt: '2026-07-29T00:00:00.000Z',
      observedAt: '2026-07-29T00:00:01.000Z',
      sourceRevision: 'stale-source-revision',
      sourceHash: 'stale-source-hash',
      actorEmail: 'test@example.com',
    },
  )
assert.equal(retainedPackQueries.length, 2)
assert.equal(retainedPackEvidence.packEvidenceHash, retainedPackEvidenceHash)
assert.equal(retainedPackEvidence.weightGrams, retainedPackWeightGrams)

const manualPackageResolutionSource = persistenceSource.slice(
  persistenceSource.indexOf(
    'export async function resolveCommerceCandidatePackageInPostgres',
  ),
  persistenceSource.indexOf(
    'export async function validateCommerceCandidateInPostgres',
  ),
)
for (const fragment of [
  'commerce_variant_pack_mapping_id = NULL',
  'commerce_variant_pack_mapping_row_version = NULL',
  'pack_profile_version_id = NULL',
  'pack_profile_version_row_version = NULL',
  'pack_profile_package_level = NULL',
  'pack_profile_base_each_quantity = NULL',
  'packaging_weight_source = NULL',
]) {
  assert.ok(
    manualPackageResolutionSource.includes(fragment),
    `Manual package resolution must clear mapped provenance: ${fragment}`,
  )
}
includes(continuationMigration, [
  'candidate.external_order_id = NEW.external_id',
  'Commerce intake retry run must contain exact target evidence',
], 'Exact-order rejection closure requires exact retry-run evidence')
includes(persistenceSource, [
  'latestProductEvidenceByVariant',
  'candidate.provider = $3',
  'candidate.external_variant_id = ANY($4::text[])',
  'run.credential_version = $5::integer',
  'preserveCommerceProductCandidateEvidence({',
  'priorSourceRevision: prior.source_revision',
  'incomingSourceRevision',
  'priorSourceHash: prior.source_hash',
  'incomingSourceHash: variant.sourceHash',
  'priorMappingState: prior.mapping_state',
  'retryUnresolved: true',
  'prior.id,',
  'productVariantsPreserved += 1',
  'const recordsStaged = productVariantsStaged + ordersStaged',
  'external_variant_id = ANY($3::text[])',
  'COMMERCE_INTAKE_PRODUCT_CANDIDATE_RESPONSE_LIMIT = 500',
  'LIMIT ${COMMERCE_INTAKE_PRODUCT_CANDIDATE_RESPONSE_LIMIT}',
  'productCandidateSummary: {',
  "scope: 'latest_unexpired_per_account_provider_variant'",
  'unresolvedReturned: returnedUnresolvedProductCandidates',
  'truncated:',
  'unresolvedTruncated:',
], 'Unchanged product evidence deduplication and page-bounded mappings')
const productCandidateReadSource = persistenceSource.slice(
  persistenceSource.indexOf(
    'export async function readCommerceIntakeStateFromPostgres',
  ),
  persistenceSource.indexOf(
    'export async function resolveCommerceProductCandidateInPostgres',
  ),
)
includes(productCandidateReadSource, [
  "candidate.mapping_state <> 'resolved'",
  "IN ('held', 'resolving', 'ready')",
  "WHERE latest.mapping_state <> 'resolved'\n               AND latest.workflow_state IN ('held', 'resolving')",
  "WHERE latest.mapping_state <> 'resolved'\n               AND latest.workflow_state = 'ready'",
  "WHERE latest.mapping_state <> 'resolved'\n               AND latest.workflow_state = 'failed'",
  'LIMIT ${COMMERCE_INTAKE_PRODUCT_CANDIDATE_RESPONSE_LIMIT}',
  'unresolved: Number(productCandidateSummary.unresolved)',
  'Number(productCandidateSummary.unresolved)',
  '> returnedUnresolvedProductCandidates',
], 'Unresolved-first bounded product candidate response')
includes(productCandidateReadSource, [
  'WITH latest_rejections AS',
  'SELECT DISTINCT ON (resource_type, external_id)',
  "WHERE disposition = 'open'",
  'count(*) OVER()::text AS total_count',
  'rejectionSummary: {',
  "scope: 'latest_open_per_account_resource_external_identity'",
  'Number(openRejections.rows[0]?.total_count || 0)',
], 'Current provider-identity rejection projection and uncapped count')
includes(currentIssueIndexMigration, [
  'commerce_intake_rejections_current_identity_idx',
  'organization_id',
  'integration_account_id',
  'resource_type',
  'external_id',
  'created_at DESC',
  'id DESC',
], 'Current provider-identity rejection index')
assert.doesNotMatch(
  currentIssueIndexMigration,
  /\bINCLUDE\s*\(/i,
  'Current provider-identity rejection index must not retain wide payloads',
)
for (const exportName of [
  'captureCommerceIntakeProviderReadInPostgres',
  'confirmCommerceCandidateAddressInPostgres',
  'markCommerceCandidateUnsupportedInPostgres',
  'promoteCommerceCandidateInPostgres',
  'reconcilePromotedCommerceCandidateCheckoutRateInPostgres',
  'readCommerceIntakeStateFromPostgres',
  'readCommerceIntakeContinuationFromPostgres',
  'readCommerceIntakeRefreshTargetFromPostgres',
  'readCommerceIntakeStageReplayFromPostgres',
  'prepareCommerceIntakeReadIntentInPostgres',
  'reserveCommerceIntakeProviderReadInPostgres',
  'markCommerceIntakeProviderReadUncertainInPostgres',
  'resolveCommerceProductCandidateInPostgres',
  'updateCommerceProductIntakePolicyInPostgres',
  'autoCreateCommerceProductsForRunInPostgres',
  'resolveCommerceCandidateCustomerInPostgres',
  'resolveCommerceCandidateDeliveryInPostgres',
  'resolveCommerceCandidatePackageInPostgres',
  'resolveCommerceCandidateProductInPostgres',
  'stageCommerceNormalizationEnvelopeInPostgres',
  'validateCommerceCandidateInPostgres',
]) {
  assert.ok(
    new RegExp(
      `export\\s+(?:async\\s+function|const)\\s+${exportName}\\b`,
    ).test(persistenceSource),
    `Commerce intake persistence must export ${exportName}`,
  )
}
includes(persistenceSource, [
  'catalogSyncResetRequested',
  'COMMERCE_PRODUCT_INTAKE_POLICY_UNCHANGED',
  'COMMERCE_CATALOG_SYNC_RESET_NOT_REQUIRED',
  "job.status = 'dead'",
  "active.status IN ('pending', 'processing', 'failed')",
  'FOR UPDATE OF job',
  'COMMERCE_CATALOG_SYNC_RESET_QUEUE_FAILED',
  'catalogSync.queued !== 1',
  "eventType: 'commerce.catalog.sync.reset'",
  'terminalJobId: terminalCatalogSync.id',
  'reason: catalogSyncResetReason',
  'deadEvidencePreserved: true',
  'previousContinuationPreserved',
  'freshRootSession: true',
], 'Explicit terminal catalog-sync operator recovery')
const productPolicyUpdateSource = persistenceSource.slice(
  persistenceSource.indexOf(
    'export async function updateCommerceProductIntakePolicyInPostgres',
  ),
  persistenceSource.indexOf(
    'export async function readCommerceIntakeStateFromPostgres',
  ),
)
includes(productPolicyUpdateSource, [
  'if (!sameAction)',
  'A terminal catalog sync reset must preserve the current unmatched-product policy',
], 'Terminal catalog recovery preserves review or auto-create policy authority')
assert.doesNotMatch(
  productPolicyUpdateSource,
  /currentPolicy\?\.unmatched_action !== 'auto_create'/u,
  'Review-mode terminal catalog recovery must not require auto-create authority',
)
const checkoutReconciliationCommandSource = persistenceSource.slice(
  persistenceSource.indexOf(
    'reconcilePromotedCommerceCandidateCheckoutRateInPostgres',
  ),
)
includes(checkoutReconciliationCommandSource, [
  "'commerce.intake.reconcile_checkout_rate'",
  'candidateRowVersion: input.candidateRowVersion',
  'if (started.replayed) return replayPayload(started.receipt)',
  'await completeReceipt(',
  'reconciliation.globalId',
], 'Checkout-rate recovery command receipt and replay contract')
const commandResultSource = persistenceSource.slice(
  persistenceSource.indexOf('function commandResult'),
)
includes(persistenceSource, [
  'CASE WHEN $29::text IS NULL THEN NULL ELSE 0 END',
], 'Nullable presentment-currency staging parameter typing')
const readIntentPreparationSource = persistenceSource.slice(
  persistenceSource.indexOf(
    'export async function prepareCommerceIntakeReadIntentInPostgres',
  ),
  persistenceSource.indexOf('type CommerceReadIntentPersistenceRow'),
)
includes(readIntentPreparationSource, [
  "now() + interval '30 days'",
], 'Database-clock commerce read-intent retention')
includes(persistenceSource, [
  'windowEnd: input.page.windowEnd',
], 'Truthful intake pagination window projection')
assert.doesNotMatch(
  readIntentPreparationSource,
  /now\.getTime\(\)\s*\+\s*30\s*\*\s*24\s*\*\s*60\s*\*\s*60/,
  'Commerce read-intent retention must not mix the app clock with the database created_at clock',
)
includes(commandResultSource, [
  'providerWrites: 0',
  'syncCursorAdvanced: false',
], 'Commerce intake command result')
includes(persistenceSource, [
  'JOIN operations_commerce_intake_read_intents intent',
  'intent.staged_run_id = run.id',
  "intent.intent_state = 'staged'",
  'intent.target_kind',
  'intent.target_global_id',
  'row.target_kind !== input.target.kind',
  'row.target_global_id !== input.target.globalId',
  'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
], 'Target-bound staged read replay')
assert.doesNotMatch(
  persistenceSource,
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+operations_commerce_sync_cursors\b/i,
  'Commerce intake persistence must not advance commerce provider cursors',
)
includes(persistenceSource, [
  'activation.state AS activation_state',
  'FOR UPDATE OF account, activation',
  "'COMMERCE_INTAKE_ACTIVATION_REQUIRED'",
  "['shadow', 'active'].includes(account.activation_state)",
  'canonicalExternalOrderIds',
  'latestCandidateByExternalOrder',
  '&& !input.refreshCandidateGlobalId',
  "candidate.workflow_state = 'promoted'",
  "['held', 'resolving', 'ready'].includes(",
  'ordersSkippedCanonical',
  'ordersPreserved',
  'SELECT DISTINCT ON (candidate.external_order_id)',
  'line.order_candidate_id = ANY($3::uuid[])',
  "'COMMERCE_INTAKE_REFRESH_TARGET_MISSING'",
  'INSERT INTO operations_commerce_intake_continuations',
  "cursor_state = 'consumed'",
  "cursor_state = 'superseded'",
  'encryptCommerceIntakeContinuation',
  'continuationRunGlobalId',
  'action: input.stageAction',
  "stage.payload->>'recordsRejected'",
  'clawpilot:commerce:crm-customer-identity:v1',
  'candidate.organization_id',
  'candidate.integration_account_id',
  'identityKeyOverride: customerIdentityKey',
  'createOnly: true',
  "'provider_account_customer_identity_reused'",
  'line.current_quantity::text',
  'line.cancelled_quantity::text',
  'line.fulfilled_quantity::text',
  'line.unfulfilled_quantity::text',
  'shopifyPartialFulfillmentIsExact(order)',
  'shopifyCandidateQuantitiesAreExact(lines)',
  'current + cancelled === ordered',
  'canonicalMerchandiseTotalMinor',
  'lineQuantityEvidence',
  'removedOrRefundedQuantity',
  "candidate.provider === 'shopify'\n            ? null",
  "'promoted_remaining_quantity'",
  "'excluded_no_unfulfilled_quantity'",
  'line.unfulfilled_quantity,',
  "'no_unfulfilled_quantity'",
  'resolveCommerceOrderLineProviderPrice({',
  'storableCommerceOrderLineProviderMoney({',
  'providerPriceResolution.requiresOperatorResolution',
  'providerPriceResolution.resolvedCurrencyCode',
  'providerPriceResolution.resolvedUnitPriceMinor',
  'reconcileFreshCandidateBlockers(',
  'PRODUCT_CANDIDATE_SELECT',
  'SELECT DISTINCT ON (selected.external_variant_id)',
  'latest_unexpired_per_account_provider_variant',
  'productCandidates: mappedProductCandidates',
  'candidate.vendor_snapshot',
  'candidate.product_type_snapshot',
  'candidate.normalized_options',
  'compare_at_price_minor',
  'variant.inventoryItemIdentity',
  'variant.selectedOptions',
  'variant.taxable',
  'variant.requiresShipping',
  'variant.weightGrams',
  "'commerce.intake.resolve_product_candidate'",
  "'commerce-catalog'",
  "'COMMERCE_INTAKE_PRODUCT_SOURCE_CONFLICT'",
  'productWasCreated',
  'candidate.external_variant_id',
  "targetType: 'product_candidate'",
  "'commerce.intake.product_candidate.resolved'",
  "'commerce.intake.product_candidate.excluded'",
  'canonical_products_created',
  'commerce.intake.update_product_policy',
  'COMMERCE_PRODUCT_INTAKE_POLICY_REVISION_CONFLICT',
  'COMMERCE_PRODUCT_AUTO_CREATE_CONFIRMATION_REQUIRED',
  'COMMERCE_PRODUCT_AUTO_CREATE_CONNECTION_REQUIRED',
  'COMMERCE_PRODUCT_AUTO_CREATE_DISABLED',
  'candidate.mapping_state = \'unresolved\'',
  'run.global_id = $3',
  'deterministicCommandUuid',
  'commerce_catalog_automatic_creation',
  'replacedMappingGlobalId',
  'SET active = false',
  'preservedAutomaticMapping',
  'FOR UPDATE OF mapping, product',
  'allowReplacement: !input.automatic',
  'COMMERCE_PRODUCT_AUTO_CREATE_MAPPING_CONFLICT',
  'catalog_product_existing_mapping_preserved',
  'recordAutomaticProductFailureInPostgres',
  'commerce.intake.product_candidate.automatic_failed',
  'next_catalog_reconciliation_or_manual_resolution',
  'candidate.last_error_code',
  'lastErrorCode: candidate.last_error_code',
  'failedByCode',
  'header_money_state',
  'header_money_gaps',
  'order.headerMoney.fulfillmentDemandEligible',
  "expectedHeaderMoneyState === 'complete'",
  'commerceCustomerChargeEligible(',
  "provider === 'shopify' && headerMoneyState === 'complete'",
  'latestCandidate.normalizerVersion',
  '=== input.envelope.normalizerVersion',
  'shipping === null ? null : bigintString(shipping)',
  'otherAdjustment === null ? null : bigintString(otherAdjustment)',
  "fulfillmentDemandUse: 'exact_lines_only'",
  "accountingUse: candidate.header_money_state === 'complete'",
  'customerChargeUse: commerceCustomerChargeEligible(',
], 'Commerce intake continuity')
const productCandidateResolverSource = persistenceSource.slice(
  persistenceSource.indexOf(
    'export async function resolveCommerceProductCandidateInPostgres',
  ),
  persistenceSource.indexOf('function automaticProductResolution'),
)
const automaticCredentialFenceSource = persistenceSource.slice(
  persistenceSource.indexOf(
    'async function assertCurrentAutomaticProductCredentialFence',
  ),
  persistenceSource.indexOf('const CANDIDATE_SELECT'),
)
includes(automaticCredentialFenceSource, [
  'JOIN operations_commerce_credentials credential',
  'account.organization_id = $1::uuid',
  'account.id = $2::uuid',
  'account.provider = $3',
  'FOR UPDATE OF credential',
  "current.status === 'error'",
  "current.verification_status !== 'verified'",
  'current.commerce_credential_generation',
  '!== input.runtime.credentialVersion',
  'current.credential_version !== input.runtime.credentialVersion',
  'commerceCatalogCredentialSupportsProducts',
  "'COMMERCE_PRODUCT_AUTO_CREATE_DISABLED'",
], 'Per-candidate automatic product credential and scope fence')
assert.ok(
  productCandidateResolverSource.indexOf(
    'await assertCurrentAutomaticProductCredentialFence(client',
  ) < productCandidateResolverSource.indexOf(
    'stageCrmRecordWithClient(client',
  ),
  'Automatic product creation must recheck the current credential generation, verification, and product scope inside the product mutation transaction',
)
assert.ok(
  productCandidateResolverSource.indexOf(
    'FOR UPDATE OF mapping, product',
  ) < productCandidateResolverSource.indexOf(
    'stageCrmRecordWithClient(client',
  ),
  'Automatic product resolution must lock and preserve an active exact mapping before any CRM product can be created',
)
includes(productCandidateResolverSource, [
  'id: preservedAutomaticMapping.product_id',
  'globalId: preservedAutomaticMapping.product_global_id',
  'id: preservedAutomaticMapping.id',
  'global_id: preservedAutomaticMapping.global_id',
  'allowReplacement: !input.automatic',
  "input.resolution.identityConflictPolicy === 'provider_qualified'",
  'if (collisionSafeIdentity && localProductSku)',
  'collisionSafeLocalProductDisplayName(client',
  'commerce-catalog-local-name:',
  'namingPolicyVersion: \'commerce-product-display-name-v2\'',
  'identityConflictPolicy: collisionSafeIdentity',
  'resolvedName: localProductName',
  'commerce-catalog-local-sku:',
  'lower(btrim(sku)) = lower(btrim($2))',
  'automaticLocalProductSku({',
  'providerSnapshot: {',
  'productTitle: candidate.product_title_snapshot',
  'variantTitle: candidate.variant_title_snapshot',
  'sku: candidate.sku_snapshot',
  'localCatalog: {',
  'providerSkuOmittedBecauseDuplicate:',
  'channelSku: candidate.sku_snapshot || product.sku',
  'automaticLocalSkuOmitted',
  'await findStableCanonicalProductWithClient(client, {',
  'commerceMasterLifecycleForProviderStatus(',
  'status: masterLifecycle.status',
  'active: masterLifecycle.active',
], 'Automatic exact-mapping preservation')
assert.ok(
  persistenceSource.indexOf(
    'await findStableCanonicalProductWithClient(client, {',
  ) < persistenceSource.indexOf(
    'const staged = await stageCrmRecordWithClient(client, {',
  ),
  'Unique stable provider identity must be reused before creating a Product master',
)
const commerceProductNamingModule = loadTypeScriptModule(
  'app_src/lib/integrations/commerceProductNaming.ts',
)
const commerceProductLifecycleModule = loadTypeScriptModule(
  'app_src/lib/integrations/commerceProductLifecycle.ts',
)
const commerceCanonicalProductIdentityModule = loadTypeScriptModule(
  'app_src/lib/integrations/commerceCanonicalProductIdentity.ts',
)
const commerceProductChannelOffersModule = loadTypeScriptModule(
  'app_src/lib/integrations/commerceProductChannelOffers.ts',
)
const commercePackRuntimeModule = loadTypeScriptModule(
  'app_src/lib/integrations/commercePackRuntime.ts',
)
const commerceOrderStagingModule = loadTypeScriptModule(
  'app_src/lib/integrations/commerceOrderStaging.ts',
)
const productIdentityLocks = []
const automaticProductResolutionModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceIntake.ts',
  {
    mocks: {
      '@/lib/auditWriter': {},
      '@/lib/integrations/commerceCredentialCrypto': {},
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError: class extends Error {},
      },
      '@/lib/integrations/commerceProductMappingPolicy': {},
      '@/lib/integrations/commerceProductNaming':
        commerceProductNamingModule,
      '@/lib/integrations/commerceProductLifecycle':
        commerceProductLifecycleModule,
      '@/lib/integrations/commerceCanonicalProductIdentity':
        commerceCanonicalProductIdentityModule,
      '@/lib/integrations/commerceProductChannelOffers':
        commerceProductChannelOffersModule,
      '@/lib/integrations/commercePackRuntime':
        commercePackRuntimeModule,
      '@/lib/integrations/commerceOrderStaging':
        commerceOrderStagingModule,
      '@/lib/operations/commerceNormalization': {
        commerceCurrencyMinorUnit: () => 2,
      },
      '@/lib/persistence/crm': {},
      '@/lib/persistence/postgres': {
        async acquireTransactionAdvisoryLock(_client, key) {
          productIdentityLocks.push(key)
        },
      },
      '@/lib/persistence/commerceCatalogSync': {},
      '@/lib/persistence/productChannelStates': {
        async linkProductChannelStateWithClient() {},
        async upsertProductChannelStateWithClient() {},
      },
      '@/lib/persistence/commerceProductImageImports': {
        async reconcileCommerceProductImageSetWithClient() {},
      },
      '@/lib/persistence/shopifyCheckoutRating': {
        async reconcileShopifyCheckoutRateForOrderCandidateWithClient() {},
        shopifyCheckoutRateLineageIsRequired() { return false },
        shopifyCheckoutRateOutcomeAllowsFulfillment() { return true },
      },
    },
  },
)
const longAutomaticProduct = {
  product_title_snapshot: 'A'.repeat(300),
  variant_title_snapshot: null,
  sku_snapshot: 'SKU-THAT-IS-LONGER-THAN-TWENTY-FIVE',
  currency_code: 'usd',
  price_minor: '1250',
  normalized_status: 'active',
}
const boundedAutomaticResolution =
  automaticProductResolutionModule.automaticProductResolution(
    longAutomaticProduct,
  )
const unchangedProductEvidence = {
  priorCredentialVersion: 3,
  currentCredentialVersion: 3,
  priorSourceRevision: 'source-revision',
  incomingSourceRevision: 'source-revision',
  priorSourceHash: 'source-hash',
  incomingSourceHash: 'source-hash',
}
assert.equal(
  automaticProductResolutionModule.preserveCommerceProductCandidateEvidence({
    ...unchangedProductEvidence,
    priorMappingState: 'resolved',
    retryUnresolved: true,
  }),
  true,
  'An unchanged resolved provider variant may reuse its prior candidate evidence',
)
assert.equal(
  automaticProductResolutionModule.preserveCommerceProductCandidateEvidence({
    ...unchangedProductEvidence,
    priorMappingState: 'unsupported',
    retryUnresolved: true,
  }),
  true,
  'An unchanged explicitly excluded provider variant must stay excluded',
)
assert.equal(
  automaticProductResolutionModule.preserveCommerceProductCandidateEvidence({
    ...unchangedProductEvidence,
    priorMappingState: 'unresolved',
    retryUnresolved: true,
  }),
  false,
  'An unchanged unresolved provider variant must be re-staged for automatic retry',
)
assert.equal(
  automaticProductResolutionModule.automaticLocalProductSku({
    providerSku: ' DUPLICATE-SKU ',
    localSkuOccupied: true,
  }),
  null,
  'An occupied local SKU must be omitted from a new automatic product',
)
assert.equal(
  automaticProductResolutionModule.automaticLocalProductSku({
    providerSku: ' PROVIDER-SKU ',
    localSkuOccupied: false,
  }),
  'PROVIDER-SKU',
  'An available provider SKU must remain on the automatic local product',
)
const collisionNames =
  automaticProductResolutionModule.automaticProductDisplayNameCandidates({
    requestedName: 'Apple Crisp 10lb',
    provider: 'faire',
    externalVariantId: 'faire-variant-1',
  })
assert.equal(collisionNames[0], 'Apple Crisp 10lb')
assert.equal(collisionNames[1], 'Apple Crisp 10lb · Faire')
assert.match(
  collisionNames[2],
  /^Apple Crisp 10lb · Faire · [a-f0-9]{12}$/,
)
assert.equal(new Set(collisionNames).size, 3)
function collisionNameClient(occupiedNames) {
  return {
    async query(sql, parameters) {
      assert.match(sql, /FROM crm_products/)
      assert.match(sql, /lower\(name\) = ANY\(\$2::text\[\]\)/)
      assert.equal(parameters[0], 'pipeline-test-id')
      assert.deepEqual(
        JSON.parse(JSON.stringify(parameters[1])),
        JSON.parse(JSON.stringify(
          collisionNames.map((name) => name.toLocaleLowerCase('en-US')),
        )),
      )
      return {
        rows: occupiedNames.map((name) => ({ name })),
      }
    },
  }
}
assert.equal(
  await automaticProductResolutionModule.collisionSafeLocalProductDisplayName(
    collisionNameClient([]),
    {
      pipelineId: 'pipeline-test-id',
      requestedName: 'Apple Crisp 10lb',
      provider: 'faire',
      externalVariantId: 'faire-variant-1',
    },
  ),
  collisionNames[0],
  'An available canonical name must remain unchanged',
)
assert.equal(
  await automaticProductResolutionModule.collisionSafeLocalProductDisplayName(
    collisionNameClient([collisionNames[0]]),
    {
      pipelineId: 'pipeline-test-id',
      requestedName: 'Apple Crisp 10lb',
      provider: 'faire',
      externalVariantId: 'faire-variant-1',
    },
  ),
  collisionNames[1],
  'A duplicate canonical name must use the deterministic provider-qualified name',
)
assert.equal(
  await automaticProductResolutionModule.collisionSafeLocalProductDisplayName(
    collisionNameClient(collisionNames.slice(0, 2)),
    {
      pipelineId: 'pipeline-test-id',
      requestedName: 'Apple Crisp 10lb',
      provider: 'faire',
      externalVariantId: 'faire-variant-1',
    },
  ),
  collisionNames[2],
  'Repeated provider collisions must use the deterministic variant hash',
)
assert.deepEqual(
  productIdentityLocks,
  Array(3).fill(
    'commerce-catalog-local-name:pipeline-test-id:apple crisp 10lb',
  ),
  'Manual and automatic collision-safe creates must serialize on the same database identity lock',
)
const crmProductIdentityMigration = read(
  'db/migrations/0045_pipeline_people_products_and_dropdown_catalogs.sql',
)
includes(crmProductIdentityMigration, [
  'idx_crm_products_pipeline_name_unique',
  'ON crm_products (pipeline_id, lower(name))',
], 'CRM product-name uniqueness')
assert.equal(
  automaticProductResolutionModule.automaticProductFailureCode({
    code: '23505',
  }),
  'COMMERCE_PRODUCT_AUTO_CREATE_IDENTITY_CONFLICT',
  'A database uniqueness conflict must become a safe automatic product code',
)
assert.equal(
  automaticProductResolutionModule.automaticProductFailureCode({
    code: 'COMMERCE_PRODUCT_AUTO_CREATE_MAPPING_CONFLICT',
  }),
  'COMMERCE_PRODUCT_AUTO_CREATE_MAPPING_CONFLICT',
  'An existing safe commerce code must survive automatic failure classification',
)
assert.equal(
  automaticProductResolutionModule.automaticProductFailureCode(
    new Error('raw database failure must not reach the browser'),
  ),
  'COMMERCE_PRODUCT_AUTO_CREATE_FAILED',
  'An unknown automatic failure must collapse to a safe generic code',
)
assert.ok(
  boundedAutomaticResolution.resolution,
  'Long provider title and SKU must not block an otherwise exact automatic product',
)
assert.equal(boundedAutomaticResolution.resolution.name.length, 255)
assert.match(
  boundedAutomaticResolution.resolution.name,
  / · [a-f0-9]{12}$/,
)
assert.equal(
  boundedAutomaticResolution.resolution.sku,
  null,
  'An overlong provider SKU must be omitted from the bounded CRM SKU field',
)
assert.equal(boundedAutomaticResolution.resolution.unitPriceMinor, 1250)
assert.equal(boundedAutomaticResolution.resolution.currency, 'USD')
assert.equal(
  automaticProductResolutionModule.automaticProductResolution(
    longAutomaticProduct,
  ).resolution.name,
  boundedAutomaticResolution.resolution.name,
  'The bounded display name must be deterministic',
)
assert.equal(
  automaticProductResolutionModule.automaticProductResolution({
    ...longAutomaticProduct,
    price_minor: null,
  }).reason,
  'product_price_invalid',
  'Automatic creation must still fail closed when exact price is absent',
)
const inactiveAutomaticResolution =
  automaticProductResolutionModule.automaticProductResolution({
    ...longAutomaticProduct,
    normalized_status: 'unavailable',
  })
assert.ok(
  inactiveAutomaticResolution.resolution,
  'An inactive provider listing must remain eligible for a local Product identity',
)
assert.equal(inactiveAutomaticResolution.reason, null)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    automaticProductResolutionModule
      .commerceMasterLifecycleForProviderStatus('unavailable'),
  )),
  { status: 'Inactive', active: false },
  'An inactive provider listing must create an inactive Product master',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    automaticProductResolutionModule
      .commerceMasterLifecycleForProviderStatus('active'),
  )),
  { status: 'Active', active: true },
  'An active provider listing may create an active Product master',
)
const crmPersistenceSource = read('app_src/lib/persistence/crm.ts')
includes(crmPersistenceSource, [
  'identityKeyOverride?: string',
  'createOnly?: boolean',
  "input.createOnly\n    ? 'DO NOTHING'",
  'A custom CRM organization identity requires create-only persistence',
  'CRM organization identity already exists; select the existing organization',
], 'Commerce customer create-only CRM persistence')
assert.ok(
  persistenceSource.indexOf('identityKeyOverride: customerIdentityKey')
    < persistenceSource.indexOf('customerResolutionMethod = \'created\''),
  'Commerce customer creation must bind its scoped identity before reporting creation',
)
includes(serviceSource, [
  'withAutomaticCustomerResolution',
  'readAutomaticCommerceCustomerTargetsForRunInPostgres',
  'resolveCommerceCustomerInPostgres',
  "resolution.status === 'ambiguous'",
  "mode: 'existing'",
  'automaticCustomerResolution',
  'providerWrites: 0',
], 'Automatic commerce customer resolution')
includes(serviceSource, [
  'withAutomaticFaireOrderPromotion',
  'readAutomaticFaireOrderPromotionTargetsForRunInPostgres',
  "input.runtime.provider !== 'faire'",
  'confirmCommerceCandidateAddressInPostgres',
  'resolveCommerceCandidateDeliveryInPostgres',
  'validateCommerceCandidateInPostgres',
  'promoteCommerceCandidateInPostgres',
  'automaticFaireOrderPromotion',
  'automaticFairePromotionHoldRequiresAttention',
  'markAutomaticFaireOrderPromotionAttentionInPostgres',
  'automaticFairePromotionCanonicalRace',
  'COMMERCE_INTAKE_CANONICAL_ORDER_EXISTS',
  'COMMERCE_INTAKE_ALREADY_PROMOTED',
  'operatorReviewRequired,',
  'canonicalOrderWrites: promoted',
  'automaticFairePromotion:',
], 'Conservative automatic Faire order promotion orchestration')
includes(serviceSource, [
  'export async function executeCommerceFaireOrderExactRefresh',
  "action: 'refresh'",
  'providerAttemptActorEmail: null',
  'refreshTargetExpectation',
  'candidateRowVersion: input.candidateRowVersion',
  'sourceHash: input.sourceHash',
  'expectedCredentialVersion: input.expectedCredentialVersion',
  'COMMERCE_FAIRE_EXACT_REFRESH_CREDENTIAL_STALE',
], 'Worker-only revision-fenced Faire exact refresh wrapper')
includes(serviceSource, [
  "'plan-customer-binding'",
  "'confirm-customer-binding'",
  'planCommerceCustomerPrefetchBindingInPostgres',
  'confirmCommerceCustomerPrefetchBindingInPostgres',
  'confirmCustomerBinding',
], 'Plan-first Faire retailer pre-fetch binding commands')
includes(persistenceSource, [
  'commerce-customer-prefetch-binding-v1',
  'commerceCustomerEvidenceFingerprint',
  'deterministicCustomerPrefetchBindingUuid',
  "'COMMERCE_CUSTOMER_PREFETCH_PLAN_STALE'",
  "'COMMERCE_CUSTOMER_PREFETCH_IDENTITY_CONFLICT'",
  "bindingOutcome = plan.existingBindingStatus === 'active'",
  'confirmedBeforeProviderRead: true',
  'providerReads: 0',
  'providerWrites: 0',
], 'Audited deterministic Faire retailer pre-fetch binding persistence')
const candidateCustomerResolutionSource = persistenceSource.slice(
  persistenceSource.indexOf(
    'export async function resolveCommerceCandidateCustomerInPostgres',
  ),
  persistenceSource.indexOf(
    'export async function confirmCommerceCandidateAddressInPostgres',
  ),
)
includes(candidateCustomerResolutionSource, [
  "operations_external_identifiers.status = 'active'",
  "operations_external_identifiers.match_method = 'email'",
  'operations_external_identifiers.match_evidence\n                  @> $7::jsonb',
  'THEN operations_external_identifiers.match_evidence',
  'THEN operations_external_identifiers.last_verified_at',
  'WHERE operations_external_identifiers.entity_global_id\n               = EXCLUDED.entity_global_id',
  "evidenceType: 'operator_confirmed_email'",
  'confirmedBeforeProviderRead: true',
], 'Operator-confirmed Faire retailer evidence preservation')
assert.ok(
  !candidateCustomerResolutionSource.includes(
    'entity_global_id = EXCLUDED.entity_global_id',
  ),
  'Automatic customer resolution must never replace a bound CRM entity',
)
includes(persistenceSource, [
  'WITH anchor_run AS',
  "run.resource = 'products_and_orders'",
  "candidate.customer_resolution_state = 'unresolved'",
  "candidate.workflow_state IN ('held', 'resolving')",
  'CASE WHEN run.global_id = $3 THEN 0 ELSE 1 END',
  'LIMIT 100',
  "encryptedSnapshot(candidate, input.runtime.globalId, 'party')",
  'party?.organizationName\n        || address?.organizationName\n        || party?.contactName',
], 'Automatic customer targets include a bounded account backlog behind a validated run anchor')
includes(persistenceSource, [
  'readAutomaticFaireExactRefreshTargetsInPostgres',
  'WITH anchor AS',
  "run.created_by = 'system:commerce-order-reconciliation'",
  "'source_stale' = ANY(candidate.blocking_codes)",
  '(run.global_id = $3) DESC',
  'excludedCandidateGlobalIds?: readonly string[]',
  'NOT candidate.global_id = ANY($6::text[])',
  'retry_intent.target_global_id = candidate.global_id',
  'retry_intent.target_source_hash = candidate.source_hash',
  'history.external_order_id = candidate.external_order_id',
  "history.created_by\n                   <> 'system:commerce-order-reconciliation'",
  'operations_commerce_resolution_decisions decision',
], 'Durable preferred-run Faire exact-refresh backlog selection')
includes(persistenceSource, [
  'readAutomaticFaireOrderPromotionTargetsForRunInPostgres',
  "run.global_id = $3",
  "run.provider = 'faire'",
  "candidate.provider = 'faire'",
  "candidate.workflow_state IN ('held', 'resolving', 'ready')",
  'prior.run_id <> $5::uuid',
  'prior_candidate_requires_review',
  'unsafe_candidate_history',
  'exact_refresh_lineage',
  "exact_intent.intake_action = 'refresh'",
  'exact_intent.target_global_id',
  'exact_intent.target_source_hash',
  'exact_refresh_required',
  'order_terminal_no_demand',
  'source_age_requires_review',
  "candidate.normalized_order_status !== 'open'",
  "candidate.normalized_fulfillment_status !== 'unfulfilled'",
  'line_quantity_requires_review',
  'mapping.external_variant_id !== line.external_variant_id',
  "(mapping.channel_sku?.trim() || '') !== sku",
  'product_sku_or_pack_mapping_requires_review',
  'ship_to_requires_review',
  'delivery_date_requires_review',
  'operator_owned_history',
], 'Fresh-run Faire promotion eligibility and retained-order hold fences')
includes(persistenceSource, [
  'markAutomaticFaireOrderPromotionAttentionInPostgres',
  'commerce.intake.mark_faire_auto_promotion_attention',
  'commerce.intake.faire_auto_promotion.attention_marked',
  'AUTOMATIC_FAIRE_ORDER_PROMOTION_ATTENTION_MARKER',
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_AUTHORITY_STALE',
  'unsafe_candidate_history',
  'exact_refresh_lineage',
], 'Durable Faire attention provenance and final promotion authority fence')
includes(persistenceSource, [
  'async function lockCommerceOrderIdentity',
  "'commerce-intake-order-identity-v1'",
  'for (const externalOrderId of [...externalOrderIds].sort())',
  'await lockCommerceOrderIdentity(client, {',
  'newer.observed_at = current.observed_at',
  'newer.created_at > current.created_at',
  'newer.id > current.id',
], 'Shared staging and promotion order-identity concurrency fence')
assert.equal(
  persistenceSource.match(/await lockCommerceOrderIdentity\(client, \{/gu)
    ?.length,
  3,
  'Staging, attention marking, and promotion must share the same order identity lock',
)
includes(persistenceSource, [
  "rejection.resourceType === 'order'",
  'rejection.externalId === refreshTarget.rows[0].external_order_id',
  'readIntent.target_external_id_hash',
  'envelopeMatchesExactOrderTarget(',
  'COMMERCE_INTAKE_EXACT_ORDER_TARGET_MISMATCH',
  'COMMERCE_INTAKE_REFRESH_TARGET_MISSING',
], 'Exact Faire refresh stages a matching normalized rejection and fails closed on identity mismatch')
assert.ok(
  !persistenceSource.includes('records_failed AS records_rejected'),
  'Normalization rejection counts must come from stage audit evidence',
)
const credentialCryptoSource = read(
  'app_src/lib/integrations/commerceCredentialCrypto.ts',
)
const candidateSnapshotCryptoSource = credentialCryptoSource.slice(
  credentialCryptoSource.indexOf(
    'export function encryptCommerceCandidateSnapshot',
  ),
  credentialCryptoSource.indexOf(
    'export function decryptCommerceCandidateSnapshot',
  ),
)
includes(candidateSnapshotCryptoSource, [
  "crypto.createHmac('sha256', key)",
  'clawpilot:commerce:candidate-snapshot-digest:v1',
  '.update(authenticatedData)',
  '.update(payload)',
], 'Protected commerce snapshot digest')
assert.ok(
  !candidateSnapshotCryptoSource.includes(
    "hash: crypto.createHash('sha256').update(payload).digest('hex')",
  ),
  'Protected party and address snapshots must not expose an unkeyed plaintext digest',
)
includes(credentialCryptoSource, [
  'encryptCommerceIntakeReadResult',
  'decryptCommerceIntakeReadResult',
  'clawpilot:commerce:intake-read-result-digest:v1',
  "crypto.createHmac('sha256', key)",
  "typeof item === 'bigint'",
  '8_388_608',
], 'Encrypted commerce read replay evidence')
includes(credentialCryptoSource, [
  'commerceCustomerEvidenceFingerprint',
  ".createHmac('sha256', encryptionKey())",
  'clawpilot:commerce:customer-evidence:v1',
], 'Keyed commerce customer evidence fingerprints')
const workflowSource = read(
  'app_src/components/settings/CommerceIntakeWorkflow.tsx',
)
includes(workflowSource, [
  'operatorCommandsAllowed',
  'provider_cursor_live',
  'initializeShadowActivation',
  "'initialize-shadow'",
  'confirmShadowActivation: true',
  'Enable Shadow',
  'Review Operations',
  'Every staged',
  'href="#operations"',
], 'Commerce intake activation recovery')
includes(workflowSource, [
  'const totalRejectionCount = rejectionSummary?.total ?? rejections.length',
  'Export loaded issues CSV',
  'current provider rejections',
  'CSV export apply to the loaded subset',
], 'Truthful truncated provider-issue presentation')
includes(workflowSource, [
  'packProfileVersions',
  'matchingPackProfileVersions',
  'bindFaireVariantPack',
  "mode: 'variant_mapping'",
  'externalVariantId: line.externalVariantId',
  'confirmExactProductRead: true',
  'Read exact product & bind',
  'It does not write to Faire or create a legacy package profile.',
], 'Fail-closed exact Faire variant Product pack action')
const intakeRouteSource = read(
  'app_src/app/api/integrations/commerce/intake/route.ts',
)
includes(intakeRouteSource, [
  "body.action === 'initialize-shadow'",
  'assertCommerceIntakeRuntime()',
  'requireActivator(user)',
  'confirmShadowActivation',
  "state: 'shadow'",
  'expectedActivationState',
  'expectedActivationRevision',
  'expectedCurrentState',
  'expectedCurrentRevision',
  'getCommerceIntake',
], 'Authenticated in-place Shadow activation recovery')
includes(persistenceSource, [
  "'COMMERCE_INTAKE_ACTIVATION_REQUIRED'",
  'Initialize Operations in Shadow mode',
], 'Missing activation recovery')
const operationsPersistenceSource = read(
  'app_src/lib/persistence/operations.ts',
)
includes(operationsPersistenceSource, [
  'input.expectedCurrentState',
  "input.expectedCurrentState === 'missing'",
  'row.revision === input.expectedCurrentRevision',
  "'OPERATIONS_ACTIVATION_STATE_CONFLICT'",
], 'Activation recovery state fencing')
includes(operationsPersistenceSource, [
  'operations:commerce-customer:',
  'DO UPDATE SET status = \'active\'',
  'RETURNING entity_global_id',
  "'OPERATIONS_CUSTOMER_IDENTITY_CONFLICT'",
  'trimmed(input.identity.externalCustomerId, 512)',
], 'Conflict-preserving commerce customer identity binding')
assert.ok(
  !operationsPersistenceSource.includes(
    'DO UPDATE SET entity_global_id = EXCLUDED.entity_global_id',
  ),
  'Automatic customer resolution must never rebind an existing provider identity',
)
includes(workflowSource, [
  "'fetch-products'",
  "'fetch-next-products'",
  "'retry-rejection'",
  "'exclude-rejection'",
  "'resolve-catalog-product'",
  'Retry exact order',
  'Exclusion audit reason',
  'Match existing product',
  'Create and match product',
  'Reason for skipping',
  'Create all new products',
  'Create ready products',
  'const isPartialCreate = bulkInvalidProductCount > 0',
  'ready ClawPilot',
  'left for review',
  'in review without changing them',
  'bulkCreatableProductCandidates.length === 0',
  "'bulk-create-products'",
  "'bulk-create-product'",
  "identityConflictPolicy: 'provider_qualified'",
  'Retry all exact orders',
  "'bulk-retry-order-money'",
  "'bulk-retry-rejection'",
  'Find one exact Faire order',
  'Bind a Faire retailer before the first order read',
  "'plan-customer-binding'",
  "'confirm-customer-binding'",
  'confirmCustomerBinding: true',
  'Faire provider order ID',
  'externalOrderId: normalizedExactFaireOrderId',
  'creates no provider, inventory, or',
  'Download review CSV',
  'Import decisions',
  'parseCommerceProductReviewCsv',
  'confirmProviderWriteOff: true',
  "'reconcile-checkout-rate'",
  'Match checkout quote',
], 'Commerce intake executable recovery and catalog workflow')
includes(workflowSource, [
  'Automatically create unmatched provider products',
  'This verified connection authorizes automatic read-only catalog sync.',
  'automatic read-only product synchronization with no second approval.',
  "'set-product-intake-policy'",
  'expectedPolicyRevision: productIntakePolicyRevision',
  "unmatchedAction: enabled ? 'auto_create' : 'review'",
  'confirmAutoCreateProducts: enabled',
  'Revision ${productIntakePolicyRevision}',
  'Updated ${formatDate(',
  'exact provider-variant',
  'candidate.lastErrorCode',
  'ClawPilot will retry this',
  'Choose product decision',
  'automatic identity across Shopify and Faire',
  'automation never guesses that two source records are',
  'Catalog reads continue in',
  'retain unmatched products',
  "'COMMERCE_PRODUCT_INTAKE_POLICY_REVISION_CONFLICT'",
  'payload.command?.productIntake',
  'productIntake: committedPolicy',
  '!connectionReady',
  'Reconnect and verify ${providerLabel(provider)}',
  'Start fresh reconciliation',
  'resetTerminalProductCatalogSync',
  'window.prompt(',
  'Enter the audit reason for superseding this terminal catalog sweep.',
  'unmatchedAction: resetUnmatchedAction',
  "confirmAutoCreateProducts: resetUnmatchedAction === 'auto_create'",
  'confirmCatalogSyncReset: true',
  'catalogSyncResetReason: resetReason',
  'Repairing the connection does not itself restart this terminal sweep.',
  'The terminal job and its error evidence remain preserved.',
], 'Durable future-product policy controls')
assert.ok(
  !workflowSource.includes('Turn on automatic product sync for ${displayName}?'),
  'A verified connection must not lead to a second catalog authorization modal',
)
const commerceIntegrationPanelSource = read(
  'app_src/components/settings/CommerceIntegrationPanel.tsx',
)
includes(commerceIntegrationPanelSource, [
  'connectionReady={',
  "account.verificationStatus === 'verified'",
], 'Credential-independent product policy access')
includes(workflowSource, [
  'automaticProductCreationNotice',
  'payload.command?.automaticProductCreation',
  '${created} created',
  '${skipped} skipped by automation',
  '${failed} failed',
  '${remaining} remaining in review',
  'Products not created remain in review.',
], 'Automatic product creation execution summary')
includes(workflowSource, [
  'ExternalOrderV2 money fields',
  'Paid-shipping records can stage',
  'Missing shipping and total remain unavailable',
  'Header total unavailable',
  'Brand-side amount',
  'retailer-funded credits or tender charges',
  'labeled as what the retailer paid',
  'blocked from',
  'accounting and customer-charge use',
], 'Current Faire money retry guidance')
includes(workflowSource, [
  "requestError.code === 'COMMERCE_INTAKE_READ_RESTART_REQUIRED'",
  "'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED'",
  'retryKeys.current.delete(retryKey)',
  'await loadIntake().catch(() => undefined)',
  'workflow.pagination?.restartRequired',
], 'Commerce intake executable read restart')
includes(workflowSource, [
  'candidate.externalInventoryItemId',
  'candidate.selectedOptions',
  'candidate.vendor',
  'candidate.productType',
  'candidate.providerTaxonomy',
  'candidate.compareAtPriceMinor',
  'candidate.taxable',
  'candidate.requiresShipping',
  'candidate.inventoryQuantity',
  'candidate.weightGrams',
], 'Commerce product candidate fidelity evidence')
assert.ok(
  !workflowSource.includes('providerAccessToken'),
  'Commerce intake workflow must not expose provider access tokens',
)

const providerAttemptSource = read(
  'app_src/lib/persistence/commerceIntegrations.ts',
)
includes(providerAttemptSource, [
  "'commerce-provider-attempt'",
  'ORDER BY attempt_number DESC',
  "if (latest?.state === 'succeeded') return latest.global_id",
  '(latest?.attempt_number || 0) + 1',
], 'Commerce provider retry attempts')

const routeSource = read(
  'app_src/app/api/integrations/commerce/intake/route.ts',
)
includes(routeSource, [
  "export const dynamic = 'force-dynamic'",
  "export const runtime = 'nodejs'",
  'requireRequestUser(req)',
  'isPostgresStorageEnabled()',
  'operationsCapabilities(actor).canManage',
  'export async function GET',
  'export async function POST',
  'const user = await actor(req)',
  "'COMMERCE_POSTGRES_REQUIRED'",
  "'COMMERCE_MANAGER_REQUIRED'",
], 'Commerce intake route')
const actorSource = routeSource.slice(
  routeSource.indexOf('async function actor'),
  routeSource.indexOf('export async function GET'),
)
assert.ok(
  actorSource.indexOf('requireRequestUser(req)')
    < actorSource.indexOf('requirePostgres()'),
  'Commerce intake must authenticate before checking storage',
)
assert.ok(
  actorSource.indexOf('requirePostgres()')
    < actorSource.indexOf('requireManager(value)'),
  'Commerce intake must fail closed on Postgres before manager authorization',
)

class MockCommerceIntegrationRequestError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'CommerceIntegrationRequestError'
    this.status = status
    this.code = code
  }
}

class MockOperationsRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'OperationsRequestError'
    this.status = status
    this.code = code
  }
}

function sanitizeCommerceError(error) {
  if (error instanceof MockCommerceIntegrationRequestError) return error
  return new MockCommerceIntegrationRequestError(
    'Commerce provider request failed',
    502,
    'COMMERCE_UPSTREAM_FAILED',
  )
}

const customerIdentityPersistence = loadTypeScriptModule(
  'app_src/lib/persistence/commerceIntake.ts',
  {
    mocks: {
      '@/lib/auditWriter': { recordAuditEvent() {} },
      '@/lib/integrations/commerceCredentialCrypto': {
        decryptCommerceCandidateSnapshot() {},
        decryptCommerceIntakeContinuation() {},
        encryptCommerceCandidateSnapshot() {},
        encryptCommerceIntakeContinuation() {},
      },
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError: MockCommerceIntegrationRequestError,
      },
      '@/lib/integrations/commerceProductMappingPolicy': {
        exactProductMappingMutation:
          mappingPolicy.exactProductMappingMutation,
      },
      '@/lib/integrations/commerceProductNaming':
        commerceProductNamingModule,
      '@/lib/integrations/commerceProductLifecycle':
        commerceProductLifecycleModule,
      '@/lib/integrations/commerceCanonicalProductIdentity':
        commerceCanonicalProductIdentityModule,
      '@/lib/integrations/commerceProductChannelOffers':
        commerceProductChannelOffersModule,
      '@/lib/integrations/commercePackRuntime':
        commercePackRuntimeModule,
      '@/lib/integrations/commerceOrderStaging':
        commerceOrderStagingModule,
      '@/lib/operations/commerceNormalization': {
        commerceCurrencyMinorUnit() { return 2 },
      },
      '@/lib/persistence/crm': { stageCrmRecordWithClient() {} },
      '@/lib/persistence/commerceCatalogSync': {
        applyCommerceCatalogSyncPolicyWithClient() {},
        readCommerceCatalogSyncStateWithClient() {},
      },
      '@/lib/persistence/productChannelStates': {
        async linkProductChannelStateWithClient() {},
        async upsertProductChannelStateWithClient() {},
      },
      '@/lib/persistence/commerceProductImageImports': {
        async reconcileCommerceProductImageSetWithClient() {},
      },
      '@/lib/persistence/shopifyCheckoutRating': {
        async reconcileShopifyCheckoutRateForOrderCandidateWithClient() {},
        shopifyCheckoutRateLineageIsRequired() { return false },
        shopifyCheckoutRateOutcomeAllowsFulfillment() { return true },
      },
      '@/lib/persistence/postgres': {
        acquireTransactionAdvisoryLock() {},
        withTransaction() {},
      },
    },
  },
)
const customerIdentityInput = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  provider: 'shopify',
  candidateGlobalId: 'gcoc0000001',
  externalCustomerId: 'gid://shopify/Customer/123',
}
const customerIdentity = customerIdentityPersistence
  .commerceCustomerIdentityKey(customerIdentityInput)
assert.match(customerIdentity, /^commerce:customer:v1:[a-f0-9]{64}$/)
assert.equal(
  customerIdentityPersistence.commerceCustomerIdentityKey(
    customerIdentityInput,
  ),
  customerIdentity,
  'The same provider-account identity must be deterministic',
)
assert.notEqual(
  customerIdentityPersistence.commerceCustomerIdentityKey({
    ...customerIdentityInput,
    integrationAccountId: '33333333-3333-4333-8333-333333333333',
  }),
  customerIdentity,
  'Two same-provider accounts must not share a CRM customer identity',
)
assert.notEqual(
  customerIdentityPersistence.commerceCustomerIdentityKey({
    ...customerIdentityInput,
    provider: 'faire',
  }),
  customerIdentity,
  'Provider identities must remain distinct',
)
assert.notEqual(
  customerIdentityPersistence.commerceCustomerIdentityKey({
    ...customerIdentityInput,
    externalCustomerId: null,
  }),
  customerIdentity,
  'A candidate-scoped fallback must not collide with a provider customer ID',
)

const organizationId = '11111111-1111-4111-8111-111111111111'
const actorEmail = 'manager@example.test'
const shopifyRuntime = {
  organizationId,
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  globalId: 'gcia0000001',
  provider: 'shopify',
  environment: 'sandbox',
  externalAccountId: 'gid://shopify/Shop/123',
  status: 'active',
  verificationStatus: 'verified',
  credentialVersion: 3,
  configuration: { shopDomain: 'example.myshopify.com' },
  encrypted: {},
}
const faireRuntime = {
  ...shopifyRuntime,
  integrationAccountId: '33333333-3333-4333-8333-333333333333',
  globalId: 'gia0000002',
  provider: 'faire',
  externalAccountId: 'brand-123',
  configuration: {},
}
const shopifyAutoRuntime = {
  ...shopifyRuntime,
  integrationAccountId: '44444444-4444-4444-8444-444444444444',
  globalId: 'gia0009201',
}
let faireProfileId = faireRuntime.externalAccountId
let faireReturnedBrandId = faireRuntime.externalAccountId
const runtimes = new Map([
  [shopifyRuntime.globalId, shopifyRuntime],
  [shopifyAutoRuntime.globalId, shopifyAutoRuntime],
  [faireRuntime.globalId, faireRuntime],
])
const providerReads = {
  shopifyToken: 0,
  shopifyProbe: 0,
  shopifyGraphql: 0,
  faireProducts: 0,
  faireInventory: 0,
  faireOrders: 0,
  faireOrder: 0,
  faireProfile: 0,
}
let exactFaireProductReads = 0
const faireProductListOptions = []
const providerAttempts = []
const providerReservations = []
const capturedReads = new Map()
const uncertainReads = []
const persistenceCommands = []
const stateReads = []
const stageReplays = new Map()
const continuations = new Map()
const readIntents = new Map()
const readIntentPreparations = []
const invalidContinuations = []
const refreshTargetReads = []
const stageAttempts = []
const automaticProductSweeps = []
let automaticCustomerTargets = []
const automaticCustomerResolverCalls = []
let automaticFairePromotionTargets = []
let automaticShopifyPromotionTargets = []
let automaticFairePromotionFailureCode = null
const productPolicyUpdates = []
const customerBindingPlanCalls = []
const customerBindingConfirmCalls = []
let failStageOnceForKey = null
let failReadIntentPreparationForKey = null
let rejectedExactFaireProductId = null
const refreshTargets = new Map([
  ['gcoc0000001', {
    provider: 'shopify',
    external_order_id: 'gid://shopify/Order/999',
    source_hash: 'f'.repeat(64),
    row_version: '0',
  }],
  ['gcoc0000020', {
    provider: 'faire',
    external_order_id: 'faire-order-exact-worker-1',
    source_hash: '9'.repeat(64),
    row_version: '7',
  }],
])
let runSequence = 0
const normalizedSources = {
  shopify: null,
  faire: null,
}
const hydratedFaireProductSources = []

function envelope(provider, orderIds) {
  return {
    provider,
    normalizerVersion: `commerce-normalization-${provider}-v1`,
    observedAt: '2026-07-26T12:00:00.000Z',
    products: [],
    orders: orderIds.map((identity) => ({
      identity: { value: identity },
      canonicalStates: {
        lifecycle: 'open',
        fulfillment: 'unfulfilled',
      },
    })),
    rejections: [],
  }
}

function persistenceCommand(name) {
  return async (input) => {
    persistenceCommands.push({ name, input })
    if (
      name === 'promote'
      && input.candidateGlobalId === 'gcoc0000023'
    ) {
      throw new MockCommerceIntegrationRequestError(
        'Exact Shopify checkout-rate lineage changed before commit',
        409,
        'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_MATCH_REQUIRED',
      )
    }
    if (
      name === 'mark-shopify-auto-attention'
      && input.candidateGlobalId === 'gcoc0000026'
    ) {
      return {
        action: name,
        replayed: false,
        rowVersion: input.candidateRowVersion,
        marked: false,
        reasonCode: 'canonical_order_exists',
      }
    }
    if (name === 'promote' && automaticFairePromotionFailureCode) {
      const code = automaticFairePromotionFailureCode
      automaticFairePromotionFailureCode = null
      throw new MockCommerceIntegrationRequestError(
        'Simulated concurrent canonical promotion',
        409,
        code,
      )
    }
    return {
      action: name,
      replayed: false,
      rowVersion: Number(input.candidateRowVersion || 0) + 1,
      ...(name === 'validate'
        ? {
            ready: input.candidateGlobalId !== 'gcoc0000024',
          }
        : {}),
      ...(name === 'promote'
        ? {
            canonicalOrderGlobalId: 'go0000001',
            checkoutRateReconciliation:
              input.automaticShopifyPromotion
                ? { outcome: 'matched' }
                : undefined,
          }
        : {}),
    }
  }
}

const service = loadTypeScriptModule(
  'app_src/lib/integrations/commerceIntake.ts',
  {
    mocks: {
      '@/lib/integrations/commerceCredentialCrypto': {
        decryptCommerceCredential(_encrypted, _organizationId, provider) {
          if (provider === 'shopify') {
            return {
              provider,
              authMode: 'shopify_client_credentials',
              clientId: 'client-id',
              clientSecret: 'client-secret',
            }
          }
          return {
            provider,
            authMode: 'faire_oauth',
            accessToken: 'faire-access-token',
            applicationId: 'faire-application-id',
            applicationSecret: 'faire-application-secret',
            scopes: ['READ_ORDERS', 'READ_PRODUCTS', 'READ_INVENTORIES'],
          }
        },
        normalizeCommerceAccountGlobalId: (value) => String(value),
        normalizeCommerceOrganizationId: (value) => String(value),
      },
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError: MockCommerceIntegrationRequestError,
        sanitizedCommerceIntegrationError: sanitizeCommerceError,
      },
      '@/lib/integrations/commerceCapabilities': {
        hasEffectiveShopifyScope(scopes, scope) {
          if (scopes.includes(scope)) return true
          if (!scope.startsWith('read_')) return false
          return scopes.includes(`write_${scope.slice('read_'.length)}`)
        },
      },
      '@/lib/integrations/faireCommerceClient': {
        async probeFaireBrandProfile() {
          providerReads.faireProfile += 1
          return { id: faireProfileId }
        },
        async listFaireProducts(_options, listOptions) {
          providerReads.faireProducts += 1
          faireProductListOptions.push({
            cursor: listOptions.cursor ?? null,
            limit: listOptions.limit,
            includeDeleted: listOptions.includeDeleted,
          })
          return {
            products: [{
              id: listOptions.cursor
                ? 'faire-product-2'
                : 'faire-product-1',
              brand_id: faireReturnedBrandId,
              images: listOptions.cursor
                ? [{
                  id: 'faire-image-2',
                  url: 'https://cdn.faire.com/products/image-2.png?token=FAIRE-INTAKE-TOKEN-SENTINEL',
                  sequence: 0,
                }]
                : [],
              variants: listOptions.cursor
                ? [{ id: 'faire-variant-2' }]
                : Array.from({ length: 51 }, (_value, index) => ({
                    id: index === 0
                      ? 'faire-variant-1'
                      : `faire-variant-1-${index}`,
                  })),
            }],
            ...(!listOptions.cursor
              ? {
                page: 1,
                limit: 50,
                cursor: 'faire-products-page-2',
              }
              : {}),
          }
        },
        async getFaireProduct(_options, productId) {
          exactFaireProductReads += 1
          return {
            id: productId,
            brand_id: faireReturnedBrandId,
            images: [{
              id: 'faire-exact-image-1',
              url: 'https://cdn.faire.com/products/exact.png?token=FAIRE-EXACT-TOKEN-SENTINEL',
              sequence: 0,
            }],
            variants: [{ id: 'po_exact_variant_1' }],
          }
        },
        async listFaireInventory(_options, query) {
          providerReads.faireInventory += 1
          assert.ok(query.productVariantIds.length <= 50)
          return {
            inventories: Object.fromEntries(
              query.productVariantIds.map((variantId) => [variantId, {
                available_quantity: {
                  type: 'QUANTITY',
                  quantity: variantId === 'faire-variant-2' ? -2 : 4,
                },
              }]),
            ),
          }
        },
        async listFaireOrders(_options, listOptions) {
          providerReads.faireOrders += 1
          assert.equal(listOptions.limit, 50)
          if (!listOptions.cursor) {
            return {
              orders: [{
                id: 'faire-order-1',
                brand_id: faireRuntime.externalAccountId,
              }],
              next_cursor: 'faire-orders-page-2',
            }
          }
          assert.equal(listOptions.cursor, 'faire-orders-page-2')
          return { orders: [{
            id: 'faire-order-2',
            brand_id: faireRuntime.externalAccountId,
          }] }
        },
        async getFaireOrder(_options, orderId) {
          providerReads.faireOrder += 1
          return { id: orderId, brand_id: faireRuntime.externalAccountId }
        },
      },
      '@/lib/integrations/faireCommerceNormalizer': {
        FAIRE_COMMERCE_NORMALIZER_VERSION:
          'faire-commerce-normalizer-v7',
        normalizeFaireCommerce(source) {
          normalizedSources.faire = source
          if (source.inventories) {
            hydratedFaireProductSources.push(source)
          }
          const result = envelope(
            'faire',
            source.orders.orders.map((order) => order.id),
          )
          const rejectedProducts = source.products.products.filter(
            (product) => product.id === rejectedExactFaireProductId,
          )
          result.products = source.products.products
            .filter((product) => product.id !== rejectedExactFaireProductId)
            .map((product) => ({
            identity: { value: product.id },
            sourceHash: product.id === 'faire-product-1'
              ? '1'.repeat(64)
              : '2'.repeat(64),
            providerUpdatedAt: '2026-07-26T00:00:00.000Z',
            imageSetComplete: true,
            images: (product.images || []).map((image, sequence) => ({
              providerImageId: image.id || null,
              locatorFingerprint: 'f'.repeat(64),
              sequence,
              altText: null,
              widthPixels: null,
              heightPixels: null,
            })),
            variants: product.variants.map((variant) => ({
              identity: { value: variant.id },
              sourceHash: '9'.repeat(64),
              providerUpdatedAt: '2026-07-26T00:00:00.000Z',
            })),
          }))
          result.rejections = rejectedProducts.map((product) => ({
            resourceType: 'product',
            externalId: product.id,
            sourceHash: '7'.repeat(64),
            errorCode: 'COMMERCE_NORMALIZATION_PRODUCT_INVALID',
            safeMessage: 'Provider product was rejected.',
          }))
          return result
        },
      },
      '@/lib/integrations/shopifyCommerceNormalizer': {
        SHOPIFY_COMMERCE_NORMALIZER_VERSION:
          'shopify-commerce-normalizer-v4',
        normalizeShopifyCommerce(source) {
          normalizedSources.shopify = source
          const result = envelope(
            'shopify',
            source.data.orders.nodes.map((order) => order.id),
          )
          result.products = source.data.products.nodes.map((product) => ({
            identity: { value: product.id },
            sourceHash: product.id.endsWith('/1')
              ? '3'.repeat(64)
              : '4'.repeat(64),
            providerUpdatedAt: product.updatedAt,
            imageSetComplete:
              product.media?.pageInfo?.hasNextPage === false,
            images: (product.media?.nodes || []).map((media, sequence) => ({
              providerImageId: media.id || null,
              locatorFingerprint: 'e'.repeat(64),
              sequence,
              altText: media.alt || null,
              widthPixels: media.image?.width || null,
              heightPixels: media.image?.height || null,
            })),
            variants: product.variants.nodes.map((variant) => ({
              identity: { value: variant.id },
            })),
          }))
          return result
        },
      },
      '@/lib/operations/commerceNormalization': {
        createCommerceNormalizationRejection(input) {
          return {
            resourceType: input.resourceType,
            externalId: input.externalId || 'unknown',
            sourceHash: 'a'.repeat(64),
            errorCode: input.errorCode,
            safeMessage: 'Provider record was rejected.',
          }
        },
      },
      '@/lib/integrations/shopifyCommerceClient': {
        normalizeShopifyShopDomain: (value) => String(value),
        async requestShopifyAccessToken() {
          providerReads.shopifyToken += 1
          return {
            accessToken: 'shopify-access-token',
            grantedScopes: [
              'read_all_orders',
              'read_orders',
              'read_products',
            ],
          }
        },
        async probeShopifyConnection() {
          providerReads.shopifyProbe += 1
          return {
            shopId: shopifyRuntime.externalAccountId,
            grantedScopes: [
              'read_all_orders',
              'read_orders',
              'read_products',
            ],
          }
        },
        async shopifyAdminGraphql(_credential, request) {
          providerReads.shopifyGraphql += 1
          assert.doesNotMatch(request.query, /\bmutation\b/i)
          if (request.operationName === 'ClawPilotCommerceOrders') {
            assert.match(request.variables.query, /test:false status:open/)
            if (!request.variables.after) {
              return {
                orders: {
                  nodes: [{
                    id: 'gid://shopify/Order/1',
                    lineItems: {
                      nodes: [{ id: 'gid://shopify/LineItem/1' }],
                      pageInfo: {
                        hasNextPage: true,
                        endCursor: 'lines-page-2',
                      },
                    },
                  }],
                  pageInfo: {
                    hasNextPage: true,
                    endCursor: 'orders-page-2',
                  },
                },
              }
            }
            assert.equal(request.variables.after, 'orders-page-2')
            return {
              orders: {
                nodes: [{
                  id: 'gid://shopify/Order/2',
                  lineItems: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            }
          }
          if (request.operationName === 'ClawPilotCommerceOrder') {
            return {
              order: {
                id: request.variables.id,
                lineItems: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }
          }
          if (request.operationName === 'ClawPilotCommerceOrderLines') {
            assert.equal(request.variables.id, 'gid://shopify/Order/1')
            assert.equal(request.variables.after, 'lines-page-2')
            return {
              order: {
                id: request.variables.id,
                lineItems: {
                  nodes: [{ id: 'gid://shopify/LineItem/2' }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }
          }
          if (
            request.operationName === 'ClawPilotCommerceProductVariants'
          ) {
            assert.match(
              request.query,
              /productVariants\([\s\S]*?sortKey:\s*ID/,
            )
            assert.doesNotMatch(
              request.query,
              /productVariants\([\s\S]*?sortKey:\s*UPDATED_AT/,
            )
            assert.match(
              request.variables.query,
              /^updated_at:<='[^']+' AND product_status:active,archived,draft,unlisted$/,
            )
            const secondPage = Boolean(request.variables.after)
            if (secondPage) {
              assert.equal(
                request.variables.after,
                'shopify-products-page-2',
              )
            }
            return {
              shop: { currencyCode: 'USD' },
              productVariants: {
                nodes: [{
                  id: secondPage
                    ? 'gid://shopify/ProductVariant/2'
                    : 'gid://shopify/ProductVariant/1',
                  title: 'Default',
                  displayName: 'Example - Default',
                  sku: 'EXAMPLE-1',
                  price: '12.00',
                  updatedAt: '2026-07-26T00:00:00.000Z',
                  product: {
                    id: secondPage
                      ? 'gid://shopify/Product/2'
                      : 'gid://shopify/Product/1',
                    title: 'Example',
                    status: 'ACTIVE',
                    updatedAt: '2026-07-26T00:00:00.000Z',
                    media: {
                      nodes: [{
                        id: secondPage
                          ? 'gid://shopify/MediaImage/2'
                          : 'gid://shopify/MediaImage/1',
                        mediaContentType: 'IMAGE',
                        alt: 'Example image',
                        image: {
                          url: 'https://cdn.shopify.com/s/files/example.png?token=SHOPIFY-INTAKE-TOKEN-SENTINEL',
                          width: 640,
                          height: 480,
                        },
                      }],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                }],
                pageInfo: secondPage
                  ? { hasNextPage: false, endCursor: null }
                  : {
                      hasNextPage: true,
                      endCursor: 'shopify-products-page-2',
                    },
              },
            }
          }
          assert.fail(`Unexpected Shopify operation ${request.operationName}`)
        },
      },
      '@/lib/persistence/commerceIntegrations': {
        async readCommerceRuntimeCredentialFromPostgres(input) {
          return runtimes.get(input.accountGlobalId) || null
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async readCommerceOrderReconciliationStateInPostgres() {
          return {
            status: 'idle',
            recordsSeen: 0,
            recordsHeld: 0,
            consecutiveFailures: 0,
            lastErrorCode: null,
            lastStartedAt: null,
            lastCompletedAt: null,
            resumable: false,
            providerWrites: 0,
            canonicalOrderWrites: 0,
            inventoryWrites: 0,
          }
        },
      },
      '@/lib/persistence/commerceIntake': {
        async planCommerceCustomerPrefetchBindingInPostgres(input) {
          customerBindingPlanCalls.push(input)
          if (input.runtime.provider !== 'faire') {
            throw new MockCommerceIntegrationRequestError(
              'Pre-fetch retailer binding is available only for Faire',
              409,
              'COMMERCE_CUSTOMER_PREFETCH_FAIRE_REQUIRED',
            )
          }
          return {
            action: 'plan-customer-binding',
            policyVersion: 'commerce-customer-prefetch-binding-v1',
            accountGlobalId: input.runtime.globalId,
            provider: 'faire',
            customerGlobalId: input.customerGlobalId,
            customerName: 'Warehouse Warehouse',
            externalCustomerIdHash: 'a'.repeat(64),
            evidenceEmailHash: 'b'.repeat(64),
            matchMethod: 'email',
            planHash: 'c'.repeat(64),
            confirmationIdempotencyKey:
              '99999999-9999-5999-8999-999999999999',
            alreadyBound: false,
            existingBindingStatus: null,
            requiresConfirmation: true,
            providerReads: 0,
            providerWrites: 0,
            databaseWrites: 0,
            syncCursorAdvanced: false,
          }
        },
        async confirmCommerceCustomerPrefetchBindingInPostgres(input) {
          customerBindingConfirmCalls.push(input)
          if (!input.confirmed) {
            throw new MockCommerceIntegrationRequestError(
              'Confirm the reviewed binding',
              400,
              'COMMERCE_CUSTOMER_PREFETCH_CONFIRMATION_REQUIRED',
            )
          }
          return {
            action: 'confirm-customer-binding',
            customerGlobalId: input.customerGlobalId,
            bindingOutcome: 'created',
            providerReads: 0,
            providerWrites: 0,
            databaseWrites: 4,
            replayed: false,
          }
        },
        async readAutomaticFaireOrderPromotionTargetsForRunInPostgres() {
          const targets = automaticFairePromotionTargets
          automaticFairePromotionTargets = []
          return targets
        },
        async readAutomaticShopifyOrderPromotionTargetsForRunInPostgres(
          input,
        ) {
          assert.equal(input.runtime.globalId, shopifyAutoRuntime.globalId)
          assert.match(input.expectedCohortHash, /^[a-f0-9]{64}$/u)
          const targets = automaticShopifyPromotionTargets
          automaticShopifyPromotionTargets = []
          return targets
        },
        async readAutomaticCommerceCustomerTargetsForRunInPostgres() {
          const targets = automaticCustomerTargets
          automaticCustomerTargets = []
          return targets
        },
        async autoCreateCommerceProductsForRunInPostgres(input) {
          automaticProductSweeps.push(input)
          return {
            enabled: true,
            runGlobalId: input.runGlobalId,
            attempted: 1,
            created: 1,
            failed: 0,
            remainingUnresolved: 0,
            providerWrites: 0,
            syncCursorAdvanced: false,
          }
        },
        confirmCommerceCandidateAddressInPostgres:
          persistenceCommand('confirm-address'),
        markAutomaticFaireOrderPromotionAttentionInPostgres:
          persistenceCommand('mark-faire-auto-attention'),
        markAutomaticShopifyOrderPromotionAttentionInPostgres:
          persistenceCommand('mark-shopify-auto-attention'),
        markCommerceCandidateUnsupportedInPostgres:
          persistenceCommand('mark-unsupported'),
        excludeCommerceIntakeRejectionInPostgres:
          persistenceCommand('exclude-rejection'),
        promoteCommerceCandidateInPostgres: persistenceCommand('promote'),
        reconcilePromotedCommerceCandidateCheckoutRateInPostgres:
          persistenceCommand('reconcile-checkout-rate'),
        async readCommerceIntakeStateFromPostgres(input) {
          stateReads.push(input)
          return { accountGlobalId: input.accountGlobalId, candidates: [] }
        },
        async readCommerceIntakeStageReplayFromPostgres(input) {
          const replay = stageReplays.get(
            `${input.accountGlobalId}:${input.action}:${input.idempotencyKey}`,
          ) || null
          if (
            replay
            && (
              replay.target.kind !== input.target.kind
              || replay.target.globalId !== input.target.globalId
              || (
                input.exactExternalOrderIdHash !== undefined
                && replay.exactExternalOrderIdHash
                  !== input.exactExternalOrderIdHash
              )
              || (
                input.exactExternalProductIdHash !== undefined
                && replay.exactExternalProductIdHash
                  !== input.exactExternalProductIdHash
              )
            )
          ) {
            const error = new Error(
              'This idempotency key already completed a different intake action or target',
            )
            error.code = 'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT'
            throw error
          }
          return replay?.result || null
        },
        async prepareCommerceIntakeReadIntentInPostgres(input) {
          readIntentPreparations.push(input)
          if (
            input.idempotencyKey === failReadIntentPreparationForKey
          ) {
            throw new Error('simulated initial read-intent preparation failure')
          }
          const existing = readIntents.get(input.idempotencyKey)
          if (existing) return existing
          let continuedPage = null
          if (input.continuationRunGlobalId) {
            if (input.continuationRunGlobalId === 'gcir9999999') {
              throw new Error('simulated encrypted continuation corruption')
            }
            continuedPage = continuations.get(input.continuationRunGlobalId)
            assert.ok(
              continuedPage,
              'Continuation handle must resolve while preparing its read intent',
            )
          }
          const prepared = {
            id: `44444444-4444-4444-8444-${String(
              readIntents.size + 1,
            ).padStart(12, '0')}`,
            ...(continuedPage || {
              mode: 'operational',
              resource: input.resource,
              sessionId: `55555555-5555-4555-8555-${String(
                readIntents.size + 1,
              ).padStart(12, '0')}`,
              batchNumber: 1,
              previousRunGlobalId: null,
              windowStart: null,
              windowEnd: '2026-07-26T12:00:00.000Z',
              queryHash: 'c'.repeat(64),
              orderCursor: null,
              cursorHash: null,
            }),
          }
          readIntents.set(input.idempotencyKey, prepared)
          return prepared
        },
        async reserveCommerceIntakeProviderReadInPostgres(input) {
          providerReservations.push(input)
          const prepared = readIntents.get(input.idempotencyKey)
          assert.equal(prepared.id, input.readIntentId)
          const captured = capturedReads.get(input.readIntentId)
          if (captured) {
            return {
              kind: 'captured',
              readIntentId: input.readIntentId,
              providerAttemptId: captured.providerAttemptId,
              responseHash: captured.responseHash,
              result: captured.result,
            }
          }
          const ordinal = providerAttempts.length + 1
          const attempt = {
            action: 'commerce.intake.read',
            ...input,
            providerAttemptId:
              `66666666-6666-4666-8666-${String(ordinal).padStart(12, '0')}`,
            leaseToken:
              `77777777-7777-4777-8777-${String(ordinal).padStart(12, '0')}`,
            requestHash: 'd'.repeat(64),
            redactedResponse: null,
          }
          providerAttempts.push(attempt)
          return {
            kind: 'lease',
            readIntentId: input.readIntentId,
            providerAttemptId: attempt.providerAttemptId,
            leaseToken: attempt.leaseToken,
            requestHash: attempt.requestHash,
          }
        },
        async captureCommerceIntakeProviderReadInPostgres(input) {
          const attempt = providerAttempts.find(
            (candidate) => (
              candidate.providerAttemptId === input.providerAttemptId
            ),
          )
          assert.ok(attempt, 'Captured response must use its reserved attempt')
          attempt.redactedResponse = input.redactedResponse
          const captured = {
            result: input.result,
            responseHash: 'e'.repeat(64),
            providerAttemptId: input.providerAttemptId,
          }
          capturedReads.set(input.readIntentId, captured)
          return captured
        },
        async markCommerceIntakeProviderReadUncertainInPostgres(input) {
          uncertainReads.push(input)
        },
        async readCommerceIntakeRejectionTargetFromPostgres(input) {
          const provider = runtimes.get(input.accountGlobalId)?.provider
            || 'shopify'
          return {
            provider,
            resource_type: 'order',
            external_id: provider === 'faire'
              ? 'faire-order-rejected-1'
              : 'gid://shopify/Order/999',
            source_hash: 'e'.repeat(64),
            row_version: 0,
          }
        },
        async readCommerceIntakeRefreshTargetFromPostgres(input) {
          refreshTargetReads.push(input)
          const target = refreshTargets.get(input.candidateGlobalId)
          if (
            target
            && (
              (
                input.expectedSourceHash !== undefined
                && input.expectedSourceHash !== target.source_hash
              )
              || (
                input.expectedRowVersion !== undefined
                && input.expectedRowVersion !== Number(target.row_version)
              )
            )
          ) {
            throw new MockCommerceIntegrationRequestError(
              'The held order changed before its exact provider read could begin',
              409,
              'COMMERCE_INTAKE_REFRESH_TARGET_CHANGED',
            )
          }
          return target
        },
        async markCommerceIntakeContinuationInvalidInPostgres(input) {
          invalidContinuations.push(input)
        },
        resolveCommerceCandidateCustomerInPostgres:
          persistenceCommand('resolve-customer'),
        resolveCommerceCandidateDeliveryInPostgres:
          persistenceCommand('resolve-delivery'),
        resolveCommerceCandidatePackageInPostgres:
          persistenceCommand('resolve-package'),
        resolveCommerceCandidateProductInPostgres:
          persistenceCommand('resolve-product'),
        resolveCommerceProductCandidateInPostgres:
          persistenceCommand('resolve-catalog-product'),
        async stageCommerceNormalizationEnvelopeInPostgres(input) {
          stageAttempts.push(input)
          if (failStageOnceForKey === input.idempotencyKey) {
            failStageOnceForKey = null
            throw new Error('simulated crash after durable provider capture')
          }
          if (input.exactExternalProductIdHash) {
            const productRejections = input.envelope.rejections.filter(
              (rejection) => rejection.resourceType === 'product',
            )
            const exactProduct = input.envelope.products.length === 1
              ? input.envelope.products[0]
              : null
            const returnedTargetHash = exactProduct
              ? createHash('sha256')
                  .update(JSON.stringify(exactProduct.identity.value))
                  .digest('hex')
              : null
            if (
              !exactProduct
              || productRejections.length > 0
              || returnedTargetHash !== input.exactExternalProductIdHash
            ) {
              const error = new Error(
                'The exact provider read returned a different or ambiguous product identity. No provider data was staged.',
              )
              error.code = 'COMMERCE_INTAKE_EXACT_PRODUCT_TARGET_MISMATCH'
              throw error
            }
          }
          persistenceCommands.push({ name: 'stage-envelope', input })
          const action = input.stageAction
          const runGlobalId =
            `gcir${String(runSequence += 1).padStart(7, '0')}`
          const result = {
            action,
            replayed: false,
            runGlobalId,
            productImageImports: {
              productsObserved: input.envelope.products.length,
              activeImagesObserved: input.envelope.products.reduce(
                (count, product) => count + (product.images || []).length,
                0,
              ),
              removedImagesObserved: 0,
              staleSnapshotsIgnored: 0,
              jobsByState: {},
              providerWrites: 0,
              syncCursorAdvanced: false,
            },
            providerWrites: 0,
            syncCursorAdvanced: false,
            ...(input.exactExternalProductIdHash
              ? {
                  exactProductEvidence: {
                    externalProductId:
                      input.envelope.products[0].identity.value,
                    productSourceHash: input.envelope.products[0].sourceHash,
                    variants: input.envelope.products[0].variants.map(
                      (variant) => ({
                        externalVariantId: variant.identity.value,
                        variantSourceRevision: variant.providerUpdatedAt,
                        variantSourceHash: variant.sourceHash,
                        channelStateGlobalId:
                          `gpcs${String(runSequence).padStart(7, '0')}`,
                        channelStateRowVersion: 3,
                        channelSourceRevision: variant.providerUpdatedAt,
                        channelSourceHash: variant.sourceHash,
                        channelPackEvidenceHash: '8'.repeat(64),
                      }),
                    ),
                  },
                }
              : {}),
          }
          if (input.page?.nextOrderCursor) {
            continuations.set(runGlobalId, {
              mode: input.page.mode,
              resource: input.page.resource,
              sessionId: input.page.sessionId,
              batchNumber: input.page.batchNumber + 1,
              previousRunGlobalId: runGlobalId,
              windowStart: input.page.windowStart,
              windowEnd: input.page.windowEnd,
              queryHash: input.page.queryHash,
              orderCursor: input.page.nextOrderCursor,
              cursorHash: 'b'.repeat(64),
            })
          }
          stageReplays.set(
            `${input.runtime.globalId}:${action}:${input.idempotencyKey}`,
            {
              target: action === 'refresh'
                ? {
                    kind: 'candidate',
                    globalId: input.refreshCandidateGlobalId,
                  }
                : action === 'retry-rejection'
                  ? {
                      kind: 'rejection',
                      globalId: input.retryRejectionGlobalId,
                    }
                  : (
                    action === 'fetch-next'
                    || action === 'fetch-next-products'
                  )
                    ? {
                        kind: 'continuation',
                        globalId: input.page?.previousRunGlobalId || null,
                      }
                    : { kind: 'none', globalId: null },
              result: { ...result, replayed: true },
              exactExternalOrderIdHash:
                input.exactExternalOrderIdHash ?? null,
              exactExternalProductIdHash:
                input.exactExternalProductIdHash ?? null,
            },
          )
          return result
        },
        async updateCommerceProductIntakePolicyInPostgres(input) {
          productPolicyUpdates.push(input)
          return {
            action: 'set-product-intake-policy',
            accountGlobalId: input.accountGlobalId,
            productIntake: {
              version: 'commerce-product-intake-policy-v1',
              unmatchedAction: input.unmatchedAction,
              autoCreateNewProducts:
                input.unmatchedAction === 'auto_create',
              revision: input.expectedPolicyRevision + 1,
            },
            providerWrites: 0,
            syncCursorAdvanced: false,
            replayed: false,
          }
        },
        validateCommerceCandidateInPostgres: persistenceCommand('validate'),
      },
      '@/lib/persistence/operations': {
        async resolveCommerceCustomerInPostgres(input) {
          automaticCustomerResolverCalls.push(input)
          const externalCustomerId = input.identity.externalCustomerId
          if (externalCustomerId === 'customer-existing') {
            return {
              status: 'matched',
              method: 'email',
              customer: { globalId: 'ga0000001' },
            }
          }
          if (externalCustomerId === 'customer-new') {
            return {
              status: 'created',
              method: 'created',
              customer: { globalId: 'ga0000002' },
            }
          }
          if (externalCustomerId === 'customer-ambiguous') {
            return {
              status: 'ambiguous',
              method: 'ambiguous',
              customer: null,
            }
          }
          throw new MockCommerceIntegrationRequestError(
            'Simulated customer resolver failure',
            422,
            'COMMERCE_CUSTOMER_IDENTITY_INVALID',
          )
        },
      },
    },
  },
)

const savedEnvironment = {
  enabled: process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED,
  lane: process.env.CLAWPILOT_ENV,
  shopifyAutoCohort:
    process.env.CLAWPILOT_SHOPIFY_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS,
  faireAutoCohort:
    process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS,
  faireAutoNotBefore:
    process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_NOT_BEFORE,
}
process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = '1'
process.env.CLAWPILOT_ENV = 'development'
process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS =
  faireRuntime.globalId
process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_NOT_BEFORE =
  '2000-01-01T00:00:00.000Z'
const automaticFaireNotBefore =
  process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_NOT_BEFORE
const automaticFaireCohortHash = createHash('sha256')
  .update('commerce-faire-order-auto-promotion-v1')
  .update('\0')
  .update(faireRuntime.globalId)
  .update('\0')
  .update(automaticFaireNotBefore)
  .digest('hex')

assert.equal(
  service.nextFaireCursor(
    { page: 1, limit: 50, cursor: 'faire-products-page-2' },
    'Faire products',
  ),
  'faire-products-page-2',
  'Faire External API v2 top-level cursor must drive the next page',
)
assert.equal(
  service.nextFaireCursor(
    { limit: 50, products: [] },
    'Faire products',
  ),
  null,
  'A final Faire page without a cursor must exhaust the batch chain',
)
assert.throws(
  () => service.nextFaireCursor(
    { cursor: 'faire-products-page-2' },
    'Faire products',
    'faire-products-page-2',
  ),
  (error) => error.code === 'COMMERCE_INTAKE_PAGINATION_INVALID',
  'Faire pagination must fail closed when the provider repeats the current cursor',
)
assert.throws(
  () => service.nextFaireCursor(
    { cursor: 'x'.repeat(4_097) },
    'Faire products',
  ),
  (error) => error.code === 'COMMERCE_INTAKE_PAGINATION_INVALID',
  'Faire pagination must reject an oversized provider cursor',
)

let keySequence = 0
function nextKey() {
  keySequence += 1
  return `00000000-0000-4000-8000-${String(keySequence).padStart(12, '0')}`
}

function commandBody(action, extra = {}) {
  return {
    action,
    accountGlobalId: shopifyRuntime.globalId,
    candidateGlobalId: 'gcoc0000001',
    idempotencyKey: nextKey(),
    rowVersion: 0,
    ...extra,
  }
}

try {
  const disconnectedPolicyState = await service.getCommerceIntake({
    organizationId,
    accountGlobalId: 'gcia0000999',
  })
  assert.equal(
    disconnectedPolicyState.accountGlobalId,
    'gcia0000999',
    'Policy state must remain readable without a runtime credential so an administrator can disable automation',
  )
  assert.equal(
    providerReads.shopifyToken,
    0,
    'Reading credential-independent policy state must not call the provider',
  )
  const readPreparationFailureKey = nextKey()
  failReadIntentPreparationForKey = readPreparationFailureKey
  const readsBeforePreparationFailure = { ...providerReads }
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch-products',
        accountGlobalId: shopifyRuntime.globalId,
        confirmReadOnly: true,
        idempotencyKey: readPreparationFailureKey,
      },
    }),
    (error) => (
      error.code === 'COMMERCE_INTAKE_READ_PREPARATION_FAILED'
      && error.status === 500
      && /no provider request was sent/i.test(error.message)
    ),
  )
  assert.deepEqual(
    providerReads,
    readsBeforePreparationFailure,
    'Initial read-intent preparation failure must happen before provider I/O',
  )
  assert.equal(
    invalidContinuations.length,
    0,
    'Initial read-intent preparation failure must not invalidate a continuation',
  )

  const shopifyFetchKey = nextKey()
  failStageOnceForKey = shopifyFetchKey
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch',
        accountGlobalId: shopifyRuntime.globalId,
        confirmReadOnly: true,
        idempotencyKey: shopifyFetchKey,
      },
    }),
    /simulated crash after durable provider capture/,
  )
  const readsAfterDurableCapture = { ...providerReads }
  const firstShopify = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch',
      accountGlobalId: shopifyRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: shopifyFetchKey,
    },
  })
  assert.deepEqual(
    providerReads,
    readsAfterDurableCapture,
    'Retry after durable capture must stage the identical response without another provider read',
  )
  const shopifyContinuationKey = nextKey()
  failStageOnceForKey = shopifyContinuationKey
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch-next',
        accountGlobalId: shopifyRuntime.globalId,
        continuationRunGlobalId: firstShopify.command.runGlobalId,
        confirmReadOnly: true,
        idempotencyKey: shopifyContinuationKey,
      },
    }),
    /simulated crash after durable provider capture/,
  )
  const readsAfterContinuationCapture = { ...providerReads }
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-next',
      accountGlobalId: shopifyRuntime.globalId,
      continuationRunGlobalId: firstShopify.command.runGlobalId,
      confirmReadOnly: true,
      idempotencyKey: shopifyContinuationKey,
    },
  })
  assert.deepEqual(
    providerReads,
    readsAfterContinuationCapture,
    'Continuation retry after durable capture must stage the identical page without another provider read',
  )
  const shopifyProductsKey = nextKey()
  failStageOnceForKey = shopifyProductsKey
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch-products',
        accountGlobalId: shopifyRuntime.globalId,
        confirmReadOnly: true,
        idempotencyKey: shopifyProductsKey,
      },
    }),
    /simulated crash after durable provider capture/,
  )
  const readsAfterProductCapture = { ...providerReads }
  const firstShopifyProducts = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-products',
      accountGlobalId: shopifyRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: shopifyProductsKey,
    },
  })
  assert.deepEqual(
    providerReads,
    readsAfterProductCapture,
    'Product-stage retry must replay the captured catalog envelope without another provider read',
  )
  assert.equal(firstShopifyProducts.command.productImageImports.productsObserved, 1)
  assert.equal(firstShopifyProducts.command.productImageImports.activeImagesObserved, 1)
  assert.equal(firstShopifyProducts.command.productImageImports.providerWrites, 0)
  const replayedShopifyProducts =
    await service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch-products',
        accountGlobalId: shopifyRuntime.globalId,
        confirmReadOnly: true,
        idempotencyKey: shopifyProductsKey,
      },
    })
  assert.equal(replayedShopifyProducts.command.replayed, true)
  assert.equal(
    replayedShopifyProducts.command.automaticProductCreation.created,
    1,
    'A staged product replay must resume the deterministic automatic sweep',
  )
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-next-products',
      accountGlobalId: shopifyRuntime.globalId,
      continuationRunGlobalId: firstShopifyProducts.command.runGlobalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  const firstFaireProducts = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-products',
      accountGlobalId: faireRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-next-products',
      accountGlobalId: faireRuntime.globalId,
      continuationRunGlobalId: firstFaireProducts.command.runGlobalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  assert.deepEqual(
    faireProductListOptions,
    [
      { cursor: null, limit: 50, includeDeleted: true },
      {
        cursor: 'faire-products-page-2',
        limit: 50,
        includeDeleted: undefined,
      },
    ],
    'Faire catalog roots must request deleted lifecycle evidence while cursor continuations omit the rejected include-deleted filter',
  )
  const firstFaire = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch',
      accountGlobalId: faireRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-next',
      accountGlobalId: faireRuntime.globalId,
      continuationRunGlobalId: firstFaire.command.runGlobalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  const readsBeforeCustomerBinding = { ...providerReads }
  const customerBindingPlan = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'plan-customer-binding',
      accountGlobalId: faireRuntime.globalId,
      externalCustomerId: 'retailer-300',
      customerGlobalId: 'ga5649471',
      evidenceEmail: 'JARRETT+WAREHOUSE@EPISCS.COM',
      idempotencyKey: nextKey(),
    },
  })
  assert.equal(customerBindingPlan.command.action, 'plan-customer-binding')
  assert.equal(customerBindingPlan.command.providerReads, 0)
  assert.equal(customerBindingPlan.command.providerWrites, 0)
  assert.equal(customerBindingPlan.command.databaseWrites, 0)
  assert.equal(
    customerBindingPlanCalls.at(-1).evidenceEmail,
    'jarrett+warehouse@episcs.com',
  )
  assert.deepEqual(
    providerReads,
    readsBeforeCustomerBinding,
    'Customer binding review must not call either provider',
  )
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'confirm-customer-binding',
        accountGlobalId: faireRuntime.globalId,
        externalCustomerId: 'retailer-300',
        customerGlobalId: 'ga5649471',
        evidenceEmail: 'jarrett+warehouse@episcs.com',
        bindingPlanHash: customerBindingPlan.command.planHash,
        idempotencyKey:
          customerBindingPlan.command.confirmationIdempotencyKey,
      },
    }),
    (error) => (
      error.code === 'COMMERCE_CUSTOMER_PREFETCH_CONFIRMATION_REQUIRED'
    ),
  )
  const confirmedCustomerBinding =
    await service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'confirm-customer-binding',
        accountGlobalId: faireRuntime.globalId,
        externalCustomerId: 'retailer-300',
        customerGlobalId: 'ga5649471',
        evidenceEmail: 'jarrett+warehouse@episcs.com',
        bindingPlanHash: customerBindingPlan.command.planHash,
        confirmCustomerBinding: true,
        idempotencyKey:
          customerBindingPlan.command.confirmationIdempotencyKey,
      },
    })
  assert.equal(confirmedCustomerBinding.command.bindingOutcome, 'created')
  assert.equal(confirmedCustomerBinding.command.providerReads, 0)
  assert.equal(confirmedCustomerBinding.command.providerWrites, 0)
  assert.equal(customerBindingConfirmCalls.at(-1).confirmed, true)
  assert.deepEqual(
    providerReads,
    readsBeforeCustomerBinding,
    'Customer binding confirmation must not call either provider',
  )
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'plan-customer-binding',
        accountGlobalId: shopifyRuntime.globalId,
        externalCustomerId: 'retailer-300',
        customerGlobalId: 'ga5649471',
        evidenceEmail: 'jarrett+warehouse@episcs.com',
        idempotencyKey: nextKey(),
      },
    }),
    (error) => error.code === 'COMMERCE_CUSTOMER_PREFETCH_FAIRE_REQUIRED',
  )
  const exactFaireOrderId = 'bo_b78sny28px'
  const exactFaireKey = nextKey()
  const exactFaireRead = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch',
      accountGlobalId: faireRuntime.globalId,
      externalOrderId: exactFaireOrderId,
      confirmReadOnly: true,
      idempotencyKey: exactFaireKey,
    },
  })
  assert.equal(exactFaireRead.command.providerWrites, 0)
  assert.equal(exactFaireRead.command.syncCursorAdvanced, false)
  const exactPreparation = readIntentPreparations.find(
    (input) => input.idempotencyKey === exactFaireKey,
  )
  assert.ok(exactPreparation)
  assert.equal(exactPreparation.action, 'fetch')
  assert.equal(exactPreparation.resource, 'orders')
  assert.equal(exactPreparation.target.kind, 'none')
  assert.equal(exactPreparation.pageSize, 1)
  assert.match(exactPreparation.exactExternalOrderIdHash, /^[a-f0-9]{64}$/)
  const exactReservation = providerReservations.find(
    (input) => input.idempotencyKey === exactFaireKey,
  )
  assert.ok(exactReservation)
  assert.equal(exactReservation.redactedRequest.targetedRead, true)
  assert.equal(exactReservation.redactedRequest.pageSize, 1)
  assert.equal(exactReservation.redactedRequest.oneRootPage, false)
  assert.equal(
    exactReservation.redactedRequest.targetHash,
    exactPreparation.exactExternalOrderIdHash,
  )
  assert.doesNotMatch(
    JSON.stringify(exactReservation.redactedRequest),
    new RegExp(exactFaireOrderId, 'i'),
    'Exact provider-read evidence must retain only the order-ID hash',
  )
  const exactStage = stageAttempts.find(
    (input) => input.idempotencyKey === exactFaireKey,
  )
  assert.ok(exactStage)
  assert.equal(exactStage.stageAction, 'fetch')
  assert.equal(exactStage.page.resource, 'orders')
  assert.equal(exactStage.page.nextOrderCursor, null)
  assert.equal(
    exactStage.envelope.orders[0].identity.value,
    exactFaireOrderId,
  )
  assert.equal(
    exactStage.exactExternalOrderIdHash,
    exactPreparation.exactExternalOrderIdHash,
  )
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch',
        accountGlobalId: faireRuntime.globalId,
        externalOrderId: 'bo_different_order',
        confirmReadOnly: true,
        idempotencyKey: exactFaireKey,
      },
    }),
    (error) => error.code === 'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
    'An exact-order retry key must remain bound to the original hashed provider ID',
  )
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch',
        accountGlobalId: faireRuntime.globalId,
        confirmReadOnly: true,
        idempotencyKey: exactFaireKey,
      },
    }),
    (error) => error.code === 'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
    'Removing the exact-order target must not turn the same retry key into a root fetch',
  )
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch',
        accountGlobalId: shopifyRuntime.globalId,
        externalOrderId: exactFaireOrderId,
        confirmReadOnly: true,
        idempotencyKey: nextKey(),
      },
    }),
    (error) => error.code === 'COMMERCE_INTAKE_EXACT_ORDER_ACTION_INVALID',
  )
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch',
        accountGlobalId: faireRuntime.globalId,
        externalOrderId: '../orders/other',
        confirmReadOnly: true,
        idempotencyKey: nextKey(),
      },
    }),
    (error) => error.code === 'COMMERCE_INTAKE_EXACT_ORDER_ID_INVALID',
  )
  const refreshKey = nextKey()
  automaticCustomerTargets = [
    {
      candidateGlobalId: 'gcoc0000001',
      candidateRowVersion: 1,
      provider: 'shopify',
      externalCustomerId: 'customer-existing',
      companyName: 'Existing Customer',
    },
    {
      candidateGlobalId: 'gcoc0000002',
      candidateRowVersion: 2,
      provider: 'shopify',
      externalCustomerId: 'customer-new',
      companyName: 'New Customer',
    },
    {
      candidateGlobalId: 'gcoc0000003',
      candidateRowVersion: 3,
      provider: 'shopify',
      externalCustomerId: 'customer-ambiguous',
      companyName: 'Ambiguous Customer',
    },
    {
      candidateGlobalId: 'gcoc0000004',
      candidateRowVersion: 4,
      provider: 'shopify',
      externalCustomerId: null,
      companyName: 'Missing Provider Identity',
    },
    {
      candidateGlobalId: 'gcoc0000005',
      candidateRowVersion: 5,
      provider: 'shopify',
      externalCustomerId: 'customer-error',
      companyName: 'Invalid Customer',
    },
  ]
  const automaticCustomerRefresh = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'refresh',
      accountGlobalId: shopifyRuntime.globalId,
      candidateGlobalId: 'gcoc0000001',
      confirmReadOnly: true,
      idempotencyKey: refreshKey,
    },
  })
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      automaticCustomerRefresh.command.automaticCustomerResolution,
    )),
    {
      runGlobalId: automaticCustomerRefresh.command.runGlobalId,
      candidatesFound: 5,
      matched: 1,
      created: 1,
      ambiguous: 1,
      skipped: 1,
      failed: 1,
      failedByCode: { COMMERCE_CUSTOMER_IDENTITY_INVALID: 1 },
      providerWrites: 0,
      syncCursorAdvanced: false,
    },
  )
  assert.deepEqual(
    automaticCustomerResolverCalls.map(
      (call) => call.identity.externalCustomerId,
    ),
    [
      'customer-existing',
      'customer-new',
      'customer-ambiguous',
      'customer-error',
    ],
  )
  const automaticBindings = persistenceCommands.filter(
    (entry) => entry.name === 'resolve-customer'
      && ['gcoc0000001', 'gcoc0000002'].includes(
        entry.input.candidateGlobalId,
      ),
  )
  assert.deepEqual(
    automaticBindings.map((entry) => ({
      candidateGlobalId: entry.input.candidateGlobalId,
      mode: entry.input.customer.mode,
      customerGlobalId: entry.input.customer.customerGlobalId,
      resolutionMethod: entry.input.customer.resolutionMethod,
    })),
    [
      {
        candidateGlobalId: 'gcoc0000001',
        mode: 'existing',
        customerGlobalId: 'ga0000001',
        resolutionMethod: 'email',
      },
      {
        candidateGlobalId: 'gcoc0000002',
        mode: 'existing',
        customerGlobalId: 'ga0000002',
        resolutionMethod: 'created',
      },
    ],
  )
  const automaticShopifyCommandStart = persistenceCommands.length
  process.env.CLAWPILOT_SHOPIFY_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS =
    shopifyAutoRuntime.globalId
  automaticShopifyPromotionTargets = [
    {
      eligible: true,
      reason: null,
      candidateGlobalId: 'gcoc0000020',
      candidateRowVersion: 20,
      providerAddress: {
        name: 'Exact Shopify Customer',
        line1: '200 Checkout Way',
        line2: null,
        city: 'Huntington Beach',
        region: 'CA',
        postalCode: '92647',
        country: 'US',
      },
      deliveryMode: 'default_sla',
    },
    {
      eligible: false,
      reason: 'checkout_rate_lineage_missing',
      candidateGlobalId: 'gcoc0000021',
      candidateRowVersion: 21,
      providerAddress: null,
      deliveryMode: null,
    },
    {
      eligible: false,
      reason: 'physical_shipping_required',
      candidateGlobalId: 'gcoc0000022',
      candidateRowVersion: 22,
      providerAddress: null,
      deliveryMode: null,
    },
    {
      eligible: true,
      reason: null,
      candidateGlobalId: 'gcoc0000023',
      candidateRowVersion: 23,
      providerAddress: null,
      deliveryMode: null,
    },
    {
      eligible: true,
      reason: null,
      candidateGlobalId: 'gcoc0000024',
      candidateRowVersion: 24,
      providerAddress: null,
      deliveryMode: null,
    },
    {
      eligible: false,
      reason: 'canonical_order_exists',
      candidateGlobalId: 'gcoc0000025',
      candidateRowVersion: 25,
      providerAddress: null,
      deliveryMode: null,
    },
    {
      eligible: false,
      reason: 'checkout_rate_lineage_missing',
      candidateGlobalId: 'gcoc0000026',
      candidateRowVersion: 26,
      providerAddress: null,
      deliveryMode: null,
    },
  ]
  const automaticShopifyFetch = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail: 'system:commerce-order-reconciliation',
    body: {
      action: 'fetch',
      accountGlobalId: shopifyAutoRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  const automaticShopifySummary = JSON.parse(JSON.stringify(
    automaticShopifyFetch.command.automaticShopifyOrderPromotion,
  ))
  assert.equal(automaticShopifySummary.enabled, true)
  assert.equal(automaticShopifySummary.cohortConfigured, true)
  assert.equal(automaticShopifySummary.cohortValid, true)
  assert.equal(automaticShopifySummary.cohortSize, 1)
  assert.equal(automaticShopifySummary.accountInCohort, true)
  assert.match(automaticShopifySummary.cohortHash, /^[a-f0-9]{64}$/u)
  assert.equal(automaticShopifySummary.candidatesFound, 7)
  assert.equal(automaticShopifySummary.eligible, 3)
  assert.equal(automaticShopifySummary.promoted, 1)
  assert.equal(automaticShopifySummary.held, 5)
  assert.equal(automaticShopifySummary.actionableHeld, 3)
  assert.deepEqual(automaticShopifySummary.heldByReason, {
    checkout_rate_lineage_missing: 1,
    physical_shipping_required: 1,
    validation_blocked: 1,
    canonical_order_exists: 2,
  })
  assert.equal(automaticShopifySummary.failed, 1)
  assert.deepEqual(automaticShopifySummary.failedByCode, {
    COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_MATCH_REQUIRED: 1,
  })
  assert.equal(automaticShopifySummary.rollbackFenced, 1)
  assert.equal(automaticShopifySummary.operatorReviewRequired, 4)
  assert.equal(automaticShopifySummary.canonicalOrderWrites, 1)
  assert.equal(automaticShopifySummary.providerWrites, 0)
  assert.equal(automaticShopifySummary.inventoryWrites, 0)
  const automaticShopifyAttentionCommands = persistenceCommands
    .slice(automaticShopifyCommandStart)
    .filter((entry) => entry.name === 'mark-shopify-auto-attention')
  assert.deepEqual(
    automaticShopifyAttentionCommands.map((entry) => ({
      candidateGlobalId: entry.input.candidateGlobalId,
      rowVersion: entry.input.candidateRowVersion,
      reasonCode: entry.input.reasonCode,
      runGlobalId: entry.input.runGlobalId,
      actorEmail: entry.input.actorEmail,
      cohortHash: entry.input.expectedCohortHash,
    })),
    [
      {
        candidateGlobalId: 'gcoc0000021',
        rowVersion: 21,
        reasonCode: 'checkout_rate_lineage_missing',
        runGlobalId: automaticShopifyFetch.command.runGlobalId,
        actorEmail: 'system:commerce-order-reconciliation',
        cohortHash: automaticShopifySummary.cohortHash,
      },
      {
        candidateGlobalId: 'gcoc0000022',
        rowVersion: 22,
        reasonCode: 'physical_shipping_required',
        runGlobalId: automaticShopifyFetch.command.runGlobalId,
        actorEmail: 'system:commerce-order-reconciliation',
        cohortHash: automaticShopifySummary.cohortHash,
      },
      {
        candidateGlobalId: 'gcoc0000023',
        rowVersion: 24,
        reasonCode:
          'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_MATCH_REQUIRED',
        runGlobalId: automaticShopifyFetch.command.runGlobalId,
        actorEmail: 'system:commerce-order-reconciliation',
        cohortHash: automaticShopifySummary.cohortHash,
      },
      {
        candidateGlobalId: 'gcoc0000024',
        rowVersion: 25,
        reasonCode: 'validation_blocked',
        runGlobalId: automaticShopifyFetch.command.runGlobalId,
        actorEmail: 'system:commerce-order-reconciliation',
        cohortHash: automaticShopifySummary.cohortHash,
      },
      {
        candidateGlobalId: 'gcoc0000026',
        rowVersion: 26,
        reasonCode: 'checkout_rate_lineage_missing',
        runGlobalId: automaticShopifyFetch.command.runGlobalId,
        actorEmail: 'system:commerce-order-reconciliation',
        cohortHash: automaticShopifySummary.cohortHash,
      },
    ],
    'Only candidates encountered as actionable by the enabled Shopify path reach the durable provenance boundary',
  )
  assert.ok(
    !automaticShopifyAttentionCommands.some((entry) => (
      entry.input.candidateGlobalId === 'gcoc0000020'
      || entry.input.candidateGlobalId === 'gcoc0000025'
    )),
    'Successful promotion and an already-known canonical dedupe must never reach the marker command',
  )
  const automaticShopifyCommands = persistenceCommands
    .slice(automaticShopifyCommandStart)
    .filter((entry) => entry.input.candidateGlobalId === 'gcoc0000020')
  assert.deepEqual(
    automaticShopifyCommands.map((entry) => ({
      action: entry.name,
      rowVersion: entry.input.candidateRowVersion,
    })),
    [
      { action: 'confirm-address', rowVersion: 20 },
      { action: 'resolve-delivery', rowVersion: 21 },
      { action: 'validate', rowVersion: 22 },
      { action: 'promote', rowVersion: 23 },
    ],
    'Shopify clean path must advance exact row versions before one strict atomic promotion',
  )
  const strictShopifyPromotion = automaticShopifyCommands.at(-1).input
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      strictShopifyPromotion.automaticShopifyPromotion,
    )),
    {
      policyVersion: 'commerce-shopify-order-auto-promotion-v1',
      cohortHash: automaticShopifySummary.cohortHash,
    },
  )
  assert.equal(strictShopifyPromotion.runtime.environment, 'sandbox')
  delete process.env
    .CLAWPILOT_SHOPIFY_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS

  const automaticFaireCommandStart = persistenceCommands.length
  automaticFairePromotionTargets = [
    {
      eligible: true,
      reason: null,
      candidateGlobalId: 'gcoc0000010',
      candidateRowVersion: 10,
      sourceHash: 'a'.repeat(64),
      providerAddress: {
        name: 'Controlled Faire Retailer',
        line1: '100 Test Way',
        line2: null,
        city: 'Huntington Beach',
        region: 'CA',
        postalCode: '92647',
        country: 'US',
      },
      deliveryMode: 'provider',
    },
    {
      eligible: false,
      reason: 'customer_resolution_required',
      candidateGlobalId: 'gcoc0000011',
      candidateRowVersion: 11,
      sourceHash: 'b'.repeat(64),
      providerAddress: null,
      deliveryMode: null,
    },
    {
      eligible: false,
      reason: 'product_sku_or_pack_mapping_requires_review',
      candidateGlobalId: 'gcoc0000012',
      candidateRowVersion: 12,
      sourceHash: 'c'.repeat(64),
      providerAddress: null,
      deliveryMode: null,
    },
  ]
  const automaticFaireFetch = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail: 'system:commerce-order-reconciliation',
    body: {
      action: 'fetch',
      accountGlobalId: faireRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      automaticFaireFetch.command.automaticFaireOrderPromotion,
    )),
    {
      policyVersion: 'commerce-faire-order-auto-promotion-v1',
      cohortHash: automaticFaireCohortHash,
      notBefore: automaticFaireNotBefore,
      runGlobalId: automaticFaireFetch.command.runGlobalId,
      candidatesFound: 3,
      eligible: 1,
      promoted: 1,
      held: 2,
      heldByReason: {
        customer_resolution_required: 1,
        product_sku_or_pack_mapping_requires_review: 1,
      },
      failed: 0,
      failedByCode: {},
      operatorReviewRequired: 2,
      providerWrites: 0,
      canonicalOrderWrites: 1,
      inventoryWrites: 0,
      syncCursorAdvanced: false,
    },
    'One exact Faire order must promote without routine confirmation while ambiguous/error candidates remain held',
  )
  const automaticFaireCommands = persistenceCommands
    .slice(automaticFaireCommandStart)
    .filter((entry) => entry.input.candidateGlobalId === 'gcoc0000010')
  assert.deepEqual(
    automaticFaireCommands.map((entry) => ({
      action: entry.name,
      rowVersion: entry.input.candidateRowVersion,
    })),
    [
      { action: 'confirm-address', rowVersion: 10 },
      { action: 'resolve-delivery', rowVersion: 11 },
      { action: 'validate', rowVersion: 12 },
      { action: 'promote', rowVersion: 13 },
    ],
    'Faire happy-path promotion must advance exact row versions through provider address, delivery, validation, and local promotion',
  )
  assert.equal(
    new Set(automaticFaireCommands.map(
      (entry) => entry.input.idempotencyKey,
    )).size,
    4,
    'Each automatic Faire command must have a distinct deterministic receipt key',
  )
  const automaticFaireAttentionCommands = persistenceCommands
    .slice(automaticFaireCommandStart)
    .filter((entry) => entry.name === 'mark-faire-auto-attention')
  assert.deepEqual(
    automaticFaireAttentionCommands.map((entry) => ({
      candidateGlobalId: entry.input.candidateGlobalId,
      candidateRowVersion: entry.input.candidateRowVersion,
      sourceHash: entry.input.sourceHash,
      reasonCode: entry.input.reasonCode,
      runGlobalId: entry.input.runGlobalId,
      actorEmail: entry.input.actorEmail,
    })),
    [
      {
        candidateGlobalId: 'gcoc0000011',
        candidateRowVersion: 11,
        sourceHash: 'b'.repeat(64),
        reasonCode: 'customer_resolution_required',
        runGlobalId: automaticFaireFetch.command.runGlobalId,
        actorEmail: 'system:commerce-order-reconciliation',
      },
      {
        candidateGlobalId: 'gcoc0000012',
        candidateRowVersion: 12,
        sourceHash: 'c'.repeat(64),
        reasonCode: 'product_sku_or_pack_mapping_requires_review',
        runGlobalId: automaticFaireFetch.command.runGlobalId,
        actorEmail: 'system:commerce-order-reconciliation',
      },
    ],
    'Only actionable Faire holds cross the durable candidate-provenance boundary',
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      automaticFaireCommands.at(-1).input.automaticFairePromotion,
    )),
    {
      policyVersion: 'commerce-faire-order-auto-promotion-v1',
      cohortHash: automaticFaireCohortHash,
      notBefore: automaticFaireNotBefore,
      runGlobalId: automaticFaireFetch.command.runGlobalId,
      sourceHash: 'a'.repeat(64),
    },
    'The final Faire promotion transaction receives exact policy, run, and source authority',
  )
  automaticFairePromotionTargets = [{
    eligible: true,
    reason: null,
    candidateGlobalId: 'gcoc0000013',
    candidateRowVersion: 13,
    sourceHash: 'd'.repeat(64),
    providerAddress: null,
    deliveryMode: null,
  }]
  automaticFairePromotionFailureCode =
    'COMMERCE_INTAKE_CANONICAL_ORDER_EXISTS'
  const concurrentCanonicalFetch = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail: 'system:commerce-order-reconciliation',
    body: {
      action: 'fetch',
      accountGlobalId: faireRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      concurrentCanonicalFetch.command.automaticFaireOrderPromotion,
    )),
    {
      policyVersion: 'commerce-faire-order-auto-promotion-v1',
      cohortHash: automaticFaireCohortHash,
      notBefore: automaticFaireNotBefore,
      runGlobalId: concurrentCanonicalFetch.command.runGlobalId,
      candidatesFound: 1,
      eligible: 1,
      promoted: 0,
      held: 1,
      heldByReason: { canonical_order_exists: 1 },
      failed: 0,
      failedByCode: {},
      operatorReviewRequired: 0,
      providerWrites: 0,
      canonicalOrderWrites: 0,
      inventoryWrites: 0,
      syncCursorAdvanced: false,
    },
    'A concurrent canonical promotion must settle as a benign hold without operator attention',
  )
  const workerExactRefreshKey = nextKey()
  const faireExactReadsBeforeWorkerRefresh = providerReads.faireOrder
  const stateReadsBeforeWorkerRefresh = stateReads.length
  const workerExactRefreshInput = {
    organizationId,
    accountGlobalId: faireRuntime.globalId,
    actorEmail: 'system:commerce-order-reconciliation',
    idempotencyKey: workerExactRefreshKey,
    candidateGlobalId: 'gcoc0000020',
    candidateRowVersion: 7,
    sourceHash: '9'.repeat(64),
    expectedCredentialVersion: faireRuntime.credentialVersion,
    cohortHash: automaticFaireCohortHash,
    notBefore: automaticFaireNotBefore,
  }
  const workerExactRefresh =
    await service.executeCommerceFaireOrderExactRefresh(
      workerExactRefreshInput,
    )
  assert.equal(workerExactRefresh.command.action, 'refresh')
  assert.equal(workerExactRefresh.intake, null)
  assert.equal(
    providerReads.faireOrder,
    faireExactReadsBeforeWorkerRefresh + 1,
    'The worker wrapper performs exactly one targeted Faire GET',
  )
  assert.equal(
    stateReads.length,
    stateReadsBeforeWorkerRefresh,
    'The worker wrapper must not hydrate retained browser intake state',
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(refreshTargetReads.at(-1))),
    {
      organizationId,
      accountGlobalId: faireRuntime.globalId,
      candidateGlobalId: 'gcoc0000020',
      expectedSourceHash: '9'.repeat(64),
      expectedRowVersion: 7,
    },
    'The selected row version and source hash fence the provider read',
  )
  assert.equal(
    providerReservations.find(
      (reservation) => reservation.idempotencyKey === workerExactRefreshKey,
    )?.providerAttemptActorEmail,
    null,
    'An unattended exact read never borrows a human provider-attempt actor',
  )
  const replayedWorkerExactRefresh =
    await service.executeCommerceFaireOrderExactRefresh(
      workerExactRefreshInput,
    )
  assert.equal(replayedWorkerExactRefresh.command.replayed, true)
  assert.equal(
    providerReads.faireOrder,
    faireExactReadsBeforeWorkerRefresh + 1,
    'A deterministic exact-refresh replay must not issue a second provider GET',
  )
  await assert.rejects(
    service.executeCommerceFaireOrderExactRefresh({
      ...workerExactRefreshInput,
      idempotencyKey: nextKey(),
      candidateRowVersion: 8,
    }),
    (error) => error.code === 'COMMERCE_INTAKE_REFRESH_TARGET_CHANGED',
  )
  assert.equal(
    providerReads.faireOrder,
    faireExactReadsBeforeWorkerRefresh + 1,
    'Source concurrency drift must fail before provider I/O',
  )
  const credentialFencePreparations = readIntentPreparations.length
  const credentialFenceReservations = providerReservations.length
  const credentialFenceAttempts = providerAttempts.length
  runtimes.set(faireRuntime.globalId, {
    ...faireRuntime,
    credentialVersion: faireRuntime.credentialVersion + 1,
  })
  try {
    await assert.rejects(
      service.executeCommerceFaireOrderExactRefresh({
        ...workerExactRefreshInput,
        idempotencyKey: nextKey(),
      }),
      (error) => error.code
        === 'COMMERCE_FAIRE_EXACT_REFRESH_CREDENTIAL_STALE',
    )
  } finally {
    runtimes.set(faireRuntime.globalId, faireRuntime)
  }
  assert.equal(
    readIntentPreparations.length,
    credentialFencePreparations,
    'Credential drift must fail before creating a read intent',
  )
  assert.equal(
    providerReservations.length,
    credentialFenceReservations,
    'Credential drift must fail before reserving a provider attempt',
  )
  assert.equal(
    providerAttempts.length,
    credentialFenceAttempts,
    'Credential drift must fail before provider I/O',
  )
  const postStageCrashKey = nextKey()
  const postStageCrashReads = providerReads.faireOrder
  const postStageCrashAttentionStart = persistenceCommands.length
  automaticFairePromotionTargets = [{
    eligible: false,
    reason: 'customer_resolution_required',
    candidateGlobalId: 'gcoc0000021',
    candidateRowVersion: 3,
    sourceHash: '8'.repeat(64),
    providerAddress: null,
    deliveryMode: null,
  }]
  await assert.rejects(
    service.executeCommerceFaireOrderExactRefresh({
      ...workerExactRefreshInput,
      idempotencyKey: postStageCrashKey,
      afterStageBeforeAutomaticHooks() {
        throw new Error('simulated crash after exact stage before hooks')
      },
    }),
    /simulated crash after exact stage before hooks/u,
  )
  assert.equal(
    providerReads.faireOrder,
    postStageCrashReads + 1,
    'The injected failure occurs only after the exact provider result is durably staged',
  )
  const recoveredPostStageCrash =
    await service.executeCommerceFaireOrderExactRefresh({
      ...workerExactRefreshInput,
      idempotencyKey: postStageCrashKey,
    })
  assert.equal(recoveredPostStageCrash.command.replayed, true)
  assert.equal(
    providerReads.faireOrder,
    postStageCrashReads + 1,
    'Post-stage recovery must replay durable evidence without another Faire GET',
  )
  assert.equal(
    persistenceCommands
      .slice(postStageCrashAttentionStart)
      .filter((entry) => entry.name === 'mark-faire-auto-attention')
      .length,
    1,
    'A deterministic stage replay must resume the skipped automatic hook',
  )
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'refresh',
        accountGlobalId: shopifyRuntime.globalId,
        candidateGlobalId: 'gcoc0000002',
        confirmReadOnly: true,
        idempotencyKey: refreshKey,
      },
    }),
    (error) => error.code === 'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
  )
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'retry-rejection',
      accountGlobalId: shopifyRuntime.globalId,
      rejectionGlobalId: 'gcrj0000001',
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'retry-rejection',
      accountGlobalId: faireRuntime.globalId,
      rejectionGlobalId: 'gcrj0000002',
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  const replayedFetch = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch',
      accountGlobalId: shopifyRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: shopifyFetchKey,
    },
  })
  assert.equal(replayedFetch.command.replayed, true)
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch-next',
        accountGlobalId: shopifyRuntime.globalId,
        continuationRunGlobalId: 'gcir9999999',
        confirmReadOnly: true,
        idempotencyKey: nextKey(),
      },
    }),
    (error) => (
      error.code === 'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED'
    ),
  )
  assert.equal(invalidContinuations.length, 1)
  assert.equal(
    invalidContinuations[0].continuationRunGlobalId,
    'gcir9999999',
  )

  assert.deepEqual(providerReads, {
    shopifyToken: 7,
    shopifyProbe: 7,
    shopifyGraphql: 9,
    faireProducts: 2,
    faireInventory: 3,
    faireOrders: 4,
    faireOrder: 4,
    faireProfile: 10,
  })
  assert.equal(normalizedSources.shopify.data.products.nodes.length, 0)
  assert.equal(normalizedSources.shopify.data.orders.nodes.length, 1)
  assert.equal(
    normalizedSources.shopify.data.orders.nodes[0].id,
    'gid://shopify/Order/999',
  )
  assert.equal(
    normalizedSources.shopify.data.orders.pageInfo.hasNextPage,
    false,
  )
  assert.equal(normalizedSources.faire.products.products.length, 0)
  assert.equal(normalizedSources.faire.orders.orders.length, 1)
  assert.equal(normalizedSources.faire.products.cursor, null)
  assert.equal(normalizedSources.faire.products.next_cursor, null)
  assert.equal(normalizedSources.faire.orders.next_cursor, null)
  assert.equal(hydratedFaireProductSources.length, 2)
  assert.equal(
    hydratedFaireProductSources[0].inventories['faire-variant-1']
      .available_quantity.quantity,
    4,
  )
  assert.equal(
    hydratedFaireProductSources[1].inventories['faire-variant-2']
      .available_quantity.quantity,
    -2,
  )
  assert.equal(providerAttempts.length, 17)
  assert.equal(providerReservations.length, 20)
  assert.ok(
    providerReservations.some((reservation) => (
      reservation.runtime.provider === 'faire'
      && reservation.adapterVersion === 'faire-commerce-normalizer-v7'
    )),
    'Faire provider-attempt evidence must record the current normalizer',
  )
  assert.ok(
    providerReservations.some((reservation) => (
      reservation.runtime.provider === 'shopify'
      && reservation.adapterVersion === 'shopify-commerce-normalizer-v4'
    )),
    'Shopify provider-attempt evidence must record its current normalizer',
  )
  assert.equal(capturedReads.size, 17)
  assert.equal(uncertainReads.length, 0)
  assert.equal(stageAttempts.length, 20)
  for (const attempt of providerAttempts) {
    assert.equal(attempt.action, 'commerce.intake.read')
    assert.equal(attempt.redactedRequest.readOnly, true)
    assert.equal(attempt.redactedResponse.providerWrites, 0)
    assert.equal(attempt.redactedResponse.syncCursorAdvanced, false)
  }
  assert.equal(
    persistenceCommands.filter(({ name }) => name === 'stage-envelope').length,
    17,
  )
  const staged = persistenceCommands.filter(
    ({ name }) => name === 'stage-envelope',
  )
  const stagedProductReads = staged.filter(
    ({ input }) => input.page?.resource === 'products',
  )
  assert.ok(
    stagedProductReads.some(({ input }) => (
      input.envelope.products.some((product) => product.images?.length > 0)
    )),
    'Product intake must carry safe normalized image references to staging',
  )
  for (const { input } of stagedProductReads) {
    const durableProductEnvelope = JSON.stringify(input.envelope)
    assert.doesNotMatch(durableProductEnvelope, /https:\/\//)
    assert.doesNotMatch(durableProductEnvelope, /INTAKE-TOKEN-SENTINEL/)
    for (const product of input.envelope.products) {
      for (const image of product.images || []) {
        assert.ok(!Object.hasOwn(image, 'url'))
        assert.ok(!Object.hasOwn(image, 'bytes'))
      }
    }
  }
  for (const { input } of staged) {
    assert.match(input.readIntentId, /^[a-f0-9-]{36}$/)
    assert.match(input.capturedResponseHash, /^[a-f0-9]{64}$/)
  }
  assert.deepEqual(
    staged.map(({ input }) => input.stageAction),
    [
      'fetch',
      'fetch-next',
      'fetch-products',
      'fetch-next-products',
      'fetch-products',
      'fetch-next-products',
      'fetch',
      'fetch-next',
      'fetch',
      'refresh',
      'fetch',
      'fetch',
      'fetch',
      'refresh',
      'refresh',
      'retry-rejection',
      'retry-rejection',
    ],
  )
  assert.equal(staged[0].input.page.batchNumber, 1)
  assert.equal(staged[0].input.page.providerRowsSeen, 1)
  assert.equal(staged[1].input.page.batchNumber, 2)
  assert.equal(staged[1].input.page.nextOrderCursor, null)
  assert.equal(staged[2].input.page.resource, 'products')
  assert.equal(staged[3].input.page.resource, 'products')
  assert.equal(staged[9].input.page, null)
  assert.equal(staged[13].input.page, null)
  assert.equal(staged[14].input.page, null)
  assert.equal(staged[15].input.page, null)
  assert.equal(staged[16].input.page, null)
  assert.equal(
    staged[16].input.envelope.orders[0].identity.value,
    'faire-order-rejected-1',
    'Faire exact-order retry must stage the identity read by getFaireOrder',
  )
  assert.equal(
    automaticProductSweeps.length,
    5,
    'Every product stage and product-stage replay must run the automatic policy sweep',
  )
  for (const sweep of automaticProductSweeps) {
    assert.match(sweep.runGlobalId, /^gcir[0-9]{7}$/)
  }
  const reviewPolicy = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'set-product-intake-policy',
      accountGlobalId: 'gcia0000999',
      unmatchedAction: 'review',
      expectedPolicyRevision: 0,
      idempotencyKey: nextKey(),
    },
  })
  assert.equal(
    reviewPolicy.command.productIntake.unmatchedAction,
    'review',
    'Turning automatic creation off must not require a runtime credential',
  )
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'set-product-intake-policy',
        accountGlobalId: 'gcia0000999',
        unmatchedAction: 'review',
        expectedPolicyRevision: 1,
        catalogSyncResetReason:
          'Operator reviewed the review-mode terminal catalog failure.',
        idempotencyKey: nextKey(),
      },
    }),
    (error) => (
      error.code === 'COMMERCE_CATALOG_SYNC_RESET_CONFIRMATION_REQUIRED'
    ),
  )
  const reviewResetReason =
    'Operator reviewed terminal catalog evidence and preserved review-only product authority.'
  const reviewResetPolicy = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'set-product-intake-policy',
      accountGlobalId: 'gcia0000999',
      unmatchedAction: 'review',
      expectedPolicyRevision: 1,
      confirmCatalogSyncReset: true,
      catalogSyncResetReason: reviewResetReason,
      idempotencyKey: nextKey(),
    },
  })
  assert.equal(reviewResetPolicy.command.productIntake.revision, 2)
  assert.equal(productPolicyUpdates.at(-1).unmatchedAction, 'review')
  assert.equal(productPolicyUpdates.at(-1).confirmAutoCreateProducts, false)
  assert.equal(productPolicyUpdates.at(-1).confirmCatalogSyncReset, true)
  assert.equal(
    productPolicyUpdates.at(-1).catalogSyncResetReason,
    reviewResetReason,
  )
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'set-product-intake-policy',
        accountGlobalId: shopifyRuntime.globalId,
        unmatchedAction: 'auto_create',
        expectedPolicyRevision: 0,
        idempotencyKey: nextKey(),
      },
    }),
    (error) => (
      error.code === 'COMMERCE_PRODUCT_AUTO_CREATE_CONFIRMATION_REQUIRED'
    ),
  )
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'set-product-intake-policy',
      accountGlobalId: shopifyRuntime.globalId,
      unmatchedAction: 'auto_create',
      expectedPolicyRevision: 0,
      confirmAutoCreateProducts: true,
      idempotencyKey: nextKey(),
    },
  })
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'set-product-intake-policy',
        accountGlobalId: shopifyRuntime.globalId,
        unmatchedAction: 'auto_create',
        expectedPolicyRevision: 1,
        confirmAutoCreateProducts: true,
        catalogSyncResetReason:
          'Operator reviewed the terminal catalog failure.',
        idempotencyKey: nextKey(),
      },
    }),
    (error) => (
      error.code === 'COMMERCE_CATALOG_SYNC_RESET_CONFIRMATION_REQUIRED'
    ),
  )
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'set-product-intake-policy',
        accountGlobalId: shopifyRuntime.globalId,
        unmatchedAction: 'auto_create',
        expectedPolicyRevision: 1,
        confirmAutoCreateProducts: true,
        confirmCatalogSyncReset: true,
        idempotencyKey: nextKey(),
      },
    }),
    (error) => (
      error.code === 'COMMERCE_CATALOG_SYNC_RESET_REASON_REQUIRED'
    ),
  )
  const resetReason =
    'Operator reviewed terminal catalog evidence and authorized a fresh root reconciliation.'
  const resetPolicy = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'set-product-intake-policy',
      accountGlobalId: shopifyRuntime.globalId,
      unmatchedAction: 'auto_create',
      expectedPolicyRevision: 1,
      confirmAutoCreateProducts: true,
      confirmCatalogSyncReset: true,
      catalogSyncResetReason: resetReason,
      idempotencyKey: nextKey(),
    },
  })
  assert.equal(resetPolicy.command.productIntake.revision, 2)
  assert.deepEqual(
    productPolicyUpdates.map((update) => update.unmatchedAction),
    ['review', 'review', 'auto_create', 'auto_create'],
  )
  assert.equal(
    productPolicyUpdates.at(-1).confirmCatalogSyncReset,
    true,
  )
  assert.equal(
    productPolicyUpdates.at(-1).catalogSyncResetReason,
    resetReason,
  )

  const localCommands = [
    commandBody('exclude-rejection', {
      rejectionGlobalId: 'gcrj0000002',
      reason: 'Provider revision is not usable for this catalog.',
    }),
    commandBody('resolve-catalog-product', {
      candidateGlobalId: 'gcpc0000001',
      resolution: {
        mode: 'existing',
        productGlobalId: 'gp0000001',
      },
    }),
    commandBody('resolve-catalog-product', {
      candidateGlobalId: 'gcpc0000001',
      resolution: {
        mode: 'create',
        name: 'Provider catalog product',
        sku: 'CATALOG-1',
        unitPriceMinor: 497,
        currency: 'USD',
      },
    }),
    commandBody('resolve-catalog-product', {
      candidateGlobalId: 'gcpc0000001',
      resolution: {
        mode: 'exclude',
        reasonCode: 'provider_catalog_unsupported',
        reason: 'This catalog revision is not operationally supported.',
      },
    }),
    commandBody('resolve-product', {
      lineGlobalId: 'gcol0000001',
      product: {
        mode: 'existing',
        productGlobalId: 'gp0000001',
        unitPriceMinor: 497,
        currency: 'USD',
      },
    }),
    commandBody('resolve-customer', {
      customer: {
        mode: 'existing',
        customerGlobalId: 'ga0000001',
      },
    }),
    commandBody('confirm-address', {
      address: {
        name: 'Example Buyer',
        line1: '10 Market Street',
        city: 'Brooklyn',
        region: 'NY',
        postalCode: '11201',
        country: 'US',
      },
    }),
    commandBody('resolve-delivery', {
      decision: {
        mode: 'manual',
        requestedDeliveryAt: '2026-08-01T15:00:00.000Z',
      },
    }),
    commandBody('resolve-package', {
      lineGlobalId: 'gcol0000001',
      package: {
        mode: 'manual',
        weightGrams: 125,
        dimensionsMm: { length: 200, width: 100, height: 50 },
      },
    }),
    commandBody('validate'),
    commandBody('mark-unsupported', {
      reasonCode: 'provider_state_unsupported',
      reason: 'The source state cannot be promoted safely',
    }),
    commandBody('promote', { confirmProviderWriteOff: true }),
    commandBody('reconcile-checkout-rate'),
  ]
  for (const body of localCommands) {
    await service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body,
    })
  }

  const calledNames = persistenceCommands.map(({ name }) => name)
  for (const expected of [
    'exclude-rejection',
    'resolve-catalog-product',
    'resolve-product',
    'resolve-customer',
    'confirm-address',
    'resolve-delivery',
    'resolve-package',
    'validate',
    'mark-unsupported',
    'promote',
    'reconcile-checkout-rate',
  ]) {
    assert.ok(calledNames.includes(expected), `Command path missing ${expected}`)
  }
  assert.deepEqual(providerReads, {
    shopifyToken: 7,
    shopifyProbe: 7,
    shopifyGraphql: 9,
    faireProducts: 2,
    faireInventory: 3,
    faireOrders: 4,
    faireOrder: 4,
    faireProfile: 10,
  }, 'Resolution, validation, and promotion must not call providers')
  const readsBeforeExactPackBinding = { ...providerReads }
  const stagesBeforeExactPackBinding = stageAttempts.length
  const exactPackBindingKey = nextKey()
  const exactPackBinding = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'resolve-package',
      accountGlobalId: faireRuntime.globalId,
      candidateGlobalId: 'gcoc0000001',
      lineGlobalId: 'gcol0000001',
      rowVersion: 0,
      idempotencyKey: exactPackBindingKey,
      package: {
        mode: 'variant_mapping',
        externalProductId: 'p_exact_product_1',
        externalVariantId: 'po_exact_variant_1',
        packProfileVersionGlobalId: 'gppv0000001',
        expectedPackProfileVersionRowVersion: 0,
        confirmExactProductRead: true,
      },
    },
  })
  assert.equal(exactFaireProductReads, 1)
  assert.equal(
    providerReads.faireProducts,
    readsBeforeExactPackBinding.faireProducts,
    'Exact Faire Product pack binding must use GET /products/:id, not the paginated catalog',
  )
  assert.equal(
    providerReads.faireProfile,
    readsBeforeExactPackBinding.faireProfile + 1,
  )
  assert.equal(
    stageAttempts.length,
    stagesBeforeExactPackBinding + 1,
  )
  const exactProductStage = stageAttempts.at(-1)
  assert.equal(exactProductStage.stageAction, 'fetch-products')
  assert.match(
    exactProductStage.exactExternalProductIdHash,
    /^[a-f0-9]{64}$/,
  )
  assert.equal(
    exactProductStage.envelope.products[0].identity.value,
    'p_exact_product_1',
  )
  const exactProductReservation = providerReservations.at(-1)
  assert.equal(exactProductReservation.redactedRequest.targetedRead, true)
  assert.equal(exactProductReservation.redactedRequest.productsFetched, true)
  assert.equal(exactProductReservation.redactedRequest.providerWrites, 0)
  assert.equal(exactProductReservation.redactedRequest.syncCursorAdvanced, false)
  assert.doesNotMatch(
    JSON.stringify(exactProductReservation.redactedRequest),
    /p_exact_product_1/,
    'Durable exact-product request evidence must retain only the provider-ID hash',
  )
  assert.equal(exactPackBinding.command.action, 'resolve-package')
  const exactPackResolution = persistenceCommands
    .filter(({ name }) => name === 'resolve-package')
    .at(-1)
  assert.equal(exactPackResolution.input.runtime.provider, 'faire')
  assert.deepEqual(
    JSON.parse(JSON.stringify(exactPackResolution.input.package)),
    {
      mode: 'variant_mapping',
      externalProductId: 'p_exact_product_1',
      externalVariantId: 'po_exact_variant_1',
      packProfileVersionGlobalId: 'gppv0000001',
      expectedPackProfileVersionRowVersion: 0,
      exactProductReadEvidence: {
        runGlobalId:
          exactPackResolution.input.package.exactProductReadEvidence.runGlobalId,
        externalProductId: 'p_exact_product_1',
        productSourceHash: '2'.repeat(64),
        externalVariantId: 'po_exact_variant_1',
        variantSourceRevision: '2026-07-26T00:00:00.000Z',
        variantSourceHash: '9'.repeat(64),
        channelStateGlobalId:
          exactPackResolution.input.package.exactProductReadEvidence
            .channelStateGlobalId,
        channelStateRowVersion: 3,
        channelSourceRevision: '2026-07-26T00:00:00.000Z',
        channelSourceHash: '9'.repeat(64),
        channelPackEvidenceHash: '8'.repeat(64),
      },
    },
  )
  assert.match(
    exactPackResolution.input.package.exactProductReadEvidence.runGlobalId,
    /^gcir(?:[0-9]{7}|[0-9a-v]{12})$/,
  )
  assert.match(
    exactPackResolution.input.package.exactProductReadEvidence
      .channelStateGlobalId,
    /^gpcs(?:[0-9]{7}|[0-9a-v]{12})$/,
  )
  const exactReadsBeforeChangedTargetRetry = exactFaireProductReads
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'resolve-package',
        accountGlobalId: faireRuntime.globalId,
        candidateGlobalId: 'gcoc0000001',
        lineGlobalId: 'gcol0000001',
        rowVersion: 0,
        idempotencyKey: exactPackBindingKey,
        package: {
          mode: 'variant_mapping',
          externalProductId: 'p_different_product_1',
          externalVariantId: 'po_exact_variant_1',
          packProfileVersionGlobalId: 'gppv0000001',
          expectedPackProfileVersionRowVersion: 0,
          confirmExactProductRead: true,
        },
      },
    }),
    (error) => error.code === 'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
  )
  assert.equal(
    exactFaireProductReads,
    exactReadsBeforeChangedTargetRetry,
    'A changed target under the same pack-binding key must fail before another provider read',
  )
  const resolvesBeforeRejectedExactProduct = persistenceCommands.filter(
    ({ name }) => name === 'resolve-package',
  ).length
  const stagesBeforeRejectedExactProduct = stageAttempts.length
  const readsBeforeRejectedExactProduct = exactFaireProductReads
  rejectedExactFaireProductId = 'p_rejected_product_1'
  try {
    await assert.rejects(
      service.executeCommerceIntakeCommand({
        organizationId,
        actorEmail,
        body: {
          action: 'resolve-package',
          accountGlobalId: faireRuntime.globalId,
          candidateGlobalId: 'gcoc0000001',
          lineGlobalId: 'gcol0000001',
          rowVersion: 0,
          idempotencyKey: nextKey(),
          package: {
            mode: 'variant_mapping',
            externalProductId: rejectedExactFaireProductId,
            externalVariantId: 'po_rejected_variant_1',
            packProfileVersionGlobalId: 'gppv0000001',
            expectedPackProfileVersionRowVersion: 0,
            confirmExactProductRead: true,
          },
        },
      }),
      (error) => (
        error.code === 'COMMERCE_INTAKE_EXACT_PRODUCT_TARGET_MISMATCH'
      ),
    )
  } finally {
    rejectedExactFaireProductId = null
  }
  assert.equal(exactFaireProductReads, readsBeforeRejectedExactProduct + 1)
  assert.equal(stageAttempts.length, stagesBeforeRejectedExactProduct + 1)
  assert.equal(stageAttempts.at(-1).envelope.products.length, 0)
  assert.equal(stageAttempts.at(-1).envelope.rejections.length, 1)
  assert.equal(
    persistenceCommands.filter(({ name }) => name === 'resolve-package').length,
    resolvesBeforeRejectedExactProduct,
    'A rejected exact product must never reach pack mapping create or reuse',
  )
  const promotion = persistenceCommands.find(({ name }) => name === 'promote')
  assert.match(promotion.input.requestHash, /^[a-f0-9]{64}$/)
  assert.ok(stateReads.length >= localCommands.length + 2)

  const readsBeforeWrongProfile = { ...providerReads }
  faireProfileId = 'different-faire-brand'
  try {
    await assert.rejects(
      service.executeCommerceIntakeCommand({
        organizationId,
        actorEmail,
        body: {
          action: 'fetch-products',
          accountGlobalId: faireRuntime.globalId,
          confirmReadOnly: true,
          idempotencyKey: nextKey(),
        },
      }),
      (error) => error.code === 'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
    )
  } finally {
    faireProfileId = faireRuntime.externalAccountId
  }
  assert.equal(
    providerReads.faireProfile,
    readsBeforeWrongProfile.faireProfile + 1,
  )
  assert.equal(
    providerReads.faireProducts,
    readsBeforeWrongProfile.faireProducts,
    'A wrong live Faire brand must fail before catalog data is read',
  )
  assert.equal(
    uncertainReads.at(-1)?.errorCode,
    'COMMERCE_INTAKE_ACCOUNT_CHANGED',
  )

  const readsBeforeWrongProductBrand = { ...providerReads }
  faireReturnedBrandId = 'different-faire-brand'
  try {
    await assert.rejects(
      service.executeCommerceIntakeCommand({
        organizationId,
        actorEmail,
        body: {
          action: 'fetch-products',
          accountGlobalId: faireRuntime.globalId,
          confirmReadOnly: true,
          idempotencyKey: nextKey(),
        },
      }),
      (error) => error.code === 'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
    )
  } finally {
    faireReturnedBrandId = faireRuntime.externalAccountId
  }
  assert.equal(
    providerReads.faireProfile,
    readsBeforeWrongProductBrand.faireProfile + 1,
  )
  assert.equal(
    providerReads.faireProducts,
    readsBeforeWrongProductBrand.faireProducts + 1,
  )
  assert.equal(
    uncertainReads.at(-1)?.errorCode,
    'COMMERCE_INTAKE_ACCOUNT_CHANGED',
  )
} finally {
  if (savedEnvironment.enabled === undefined) {
    delete process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED
  } else {
    process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = savedEnvironment.enabled
  }
  if (savedEnvironment.lane === undefined) {
    delete process.env.CLAWPILOT_ENV
  } else {
    process.env.CLAWPILOT_ENV = savedEnvironment.lane
  }
  if (savedEnvironment.shopifyAutoCohort === undefined) {
    delete process.env
      .CLAWPILOT_SHOPIFY_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS
  } else {
    process.env.CLAWPILOT_SHOPIFY_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS =
      savedEnvironment.shopifyAutoCohort
  }
  if (savedEnvironment.faireAutoCohort === undefined) {
    delete process.env
      .CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS
  } else {
    process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS =
      savedEnvironment.faireAutoCohort
  }
  if (savedEnvironment.faireAutoNotBefore === undefined) {
    delete process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_NOT_BEFORE
  } else {
    process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_NOT_BEFORE =
      savedEnvironment.faireAutoNotBefore
  }
}

let authenticated = true
let postgresEnabled = true
let managerEnabled = true
let activatorEnabled = true
let intakeRuntimeEnabled = true
const routeTrace = []
const routeServiceCalls = []
const routeActor = {
  email: actorEmail,
  organizationId,
}
const route = loadTypeScriptModule(
  'app_src/app/api/integrations/commerce/intake/route.ts',
  {
    mocks: {
      'next/server': {
        NextResponse: {
          json(payload, init = {}) {
            return {
              payload,
              status: init.status || 200,
              headers: init.headers || {},
            }
          },
        },
      },
      '@/lib/integrations/commerceIntake': {
        assertCommerceIntakeRuntime() {
          routeTrace.push('runtime')
          if (!intakeRuntimeEnabled) {
            throw new MockCommerceIntegrationRequestError(
              'Commerce intake is not enabled in this environment',
              404,
              'COMMERCE_INTAKE_DISABLED',
            )
          }
        },
        async executeCommerceIntakeCommand(input) {
          routeTrace.push('service-post')
          routeServiceCalls.push({ method: 'POST', input })
          return { command: { action: input.body.action }, intake: {} }
        },
        async getCommerceIntake(input) {
          routeTrace.push('service-get')
          routeServiceCalls.push({ method: 'GET', input })
          return { accountGlobalId: input.accountGlobalId }
        },
      },
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError: MockCommerceIntegrationRequestError,
        async getCommerceIntegrationsState() {
          routeTrace.push('integration-state')
          return {
            accounts: [{
              globalId: shopifyRuntime.globalId,
              configured: true,
              verificationStatus: 'verified',
            }],
          }
        },
        sanitizedCommerceIntegrationError: sanitizeCommerceError,
      },
      '@/lib/operations/authorization': {
        operationsCapabilities() {
          routeTrace.push('manager')
          return {
            canManage: managerEnabled,
            canActivate: activatorEnabled,
          }
        },
      },
      '@/lib/persistence/config': {
        isPostgresStorageEnabled() {
          routeTrace.push('postgres')
          return postgresEnabled
        },
      },
      '@/lib/persistence/operations': {
        OperationsRequestError: MockOperationsRequestError,
        async updateOperationsActivationInPostgres(input) {
          routeTrace.push('activation-update')
          return {
            state: input.state,
            revision: 1,
          }
        },
      },
      '@/lib/requestUser': {
        async requireRequestUser() {
          routeTrace.push('auth')
          if (!authenticated) throw new Error('Unauthorized')
          return routeActor
        },
      },
    },
  },
)

function mockRequest(method, body) {
  const bytes = body === undefined
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(body))
  return {
    method,
    headers: new Headers(
      body === undefined ? {} : { 'content-length': String(bytes.byteLength) },
    ),
    nextUrl: new URL(
      `https://clawpilot.example/api/integrations/commerce/intake`
      + `?accountGlobalId=${shopifyRuntime.globalId}`,
    ),
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      )
    },
  }
}

authenticated = false
routeTrace.length = 0
let response = await route.GET(mockRequest('GET'))
assert.equal(response.status, 401)
assert.deepEqual(routeTrace, ['auth'])
assert.equal(routeServiceCalls.length, 0)

authenticated = true
postgresEnabled = false
routeTrace.length = 0
response = await route.GET(mockRequest('GET'))
assert.equal(response.status, 503)
assert.deepEqual(routeTrace, ['auth', 'postgres'])
assert.equal(routeServiceCalls.length, 0)

postgresEnabled = true
managerEnabled = false
routeTrace.length = 0
response = await route.GET(mockRequest('GET'))
assert.equal(response.status, 403)
assert.deepEqual(routeTrace, ['auth', 'postgres', 'manager'])
assert.equal(routeServiceCalls.length, 0)

managerEnabled = true
routeTrace.length = 0
response = await route.GET(mockRequest('GET'))
assert.equal(response.status, 200)
assert.deepEqual(routeTrace, ['auth', 'postgres', 'manager', 'service-get'])
assert.equal(routeServiceCalls.at(-1).input.organizationId, organizationId)

routeTrace.length = 0
response = await route.POST(mockRequest('POST', {
  action: 'validate',
  accountGlobalId: shopifyRuntime.globalId,
}))
assert.equal(response.status, 200)
assert.deepEqual(routeTrace, ['auth', 'postgres', 'manager', 'service-post'])
assert.equal(routeServiceCalls.at(-1).input.actorEmail, actorEmail)

intakeRuntimeEnabled = false
routeTrace.length = 0
response = await route.POST(mockRequest('POST', {
  action: 'initialize-shadow',
  accountGlobalId: shopifyRuntime.globalId,
  confirmShadowActivation: true,
  expectedActivationState: 'missing',
  expectedActivationRevision: null,
}))
assert.equal(response.status, 404)
assert.deepEqual(routeTrace, ['auth', 'postgres', 'manager', 'runtime'])
assert.ok(!routeTrace.includes('activation-update'))

intakeRuntimeEnabled = true
activatorEnabled = false
routeTrace.length = 0
response = await route.POST(mockRequest('POST', {
  action: 'initialize-shadow',
  accountGlobalId: shopifyRuntime.globalId,
  confirmShadowActivation: true,
  expectedActivationState: 'missing',
  expectedActivationRevision: null,
}))
assert.equal(response.status, 403)
assert.deepEqual(routeTrace, [
  'auth',
  'postgres',
  'manager',
  'runtime',
  'manager',
])

activatorEnabled = true
routeTrace.length = 0
response = await route.POST(mockRequest('POST', {
  action: 'initialize-shadow',
  accountGlobalId: shopifyRuntime.globalId,
  confirmShadowActivation: true,
  expectedActivationState: 'missing',
  expectedActivationRevision: null,
}))
assert.equal(response.status, 200)
assert.deepEqual(routeTrace, [
  'auth',
  'postgres',
  'manager',
  'runtime',
  'manager',
  'integration-state',
  'activation-update',
  'service-get',
])
assert.equal(response.payload.intake.accountGlobalId, shopifyRuntime.globalId)

console.log('PASS test-commerce-intake')
