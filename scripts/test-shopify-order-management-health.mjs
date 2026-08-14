#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const routePath = 'app_src/app/api/health/route.ts'
const routeSource = readFileSync(resolve(root, routePath), 'utf8')
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

const managementTables = [
  'operations_shopify_order_management_authorizations',
  'operations_shopify_order_management_attempts',
  'operations_shopify_order_management_outcomes',
]
const managementFunctions = [
  'operations_shopify_order_management_snapshot_updated_at(jsonb)',
  'operations_shopify_order_management_is_current(uuid,uuid,boolean)',
  'protect_shopify_order_management_authorization()',
  'protect_shopify_order_management_attempt()',
  'protect_shopify_order_management_outcome()',
  'protect_shopify_order_management_downstream_race()',
]
const managementTriggers = [
  [
    'operations_shopify_order_management_authorizations',
    'protect_shopify_order_management_authorization_write',
    'protect_shopify_order_management_authorization()',
  ],
  [
    'operations_shopify_order_management_attempts',
    'protect_shopify_order_management_attempt_write',
    'protect_shopify_order_management_attempt()',
  ],
  [
    'operations_shopify_order_management_outcomes',
    'protect_shopify_order_management_outcome_write',
    'protect_shopify_order_management_outcome()',
  ],
  [
    'operations_orders',
    'protect_shopify_order_management_order_status_race',
    'protect_shopify_order_management_downstream_race()',
  ],
  [
    'operations_fulfillment_plans',
    'protect_shopify_order_management_plan_race',
    'protect_shopify_order_management_downstream_race()',
  ],
  [
    'operations_reservations',
    'protect_shopify_order_management_reservation_race',
    'protect_shopify_order_management_downstream_race()',
  ],
  [
    'operations_billable_events',
    'protect_shopify_order_management_billable_event_race',
    'protect_shopify_order_management_downstream_race()',
  ],
  [
    'operations_sandbox_commerce_e2e_authorizations',
    'block_shopify_order_management_sandbox_e2e_authorization_race',
    'protect_shopify_order_management_downstream_race()',
  ],
]

for (const fragment of [
  "from '@/lib/persistence/shopifyOrderManagement'",
  'readShopifyOrderManagementHealthFromPostgres',
  "from '@/lib/integrations/shopifyOrderManagementRuntime'",
  'shopifyOrderManagementRuntime',
  "'0283_operations_shopify_order_management.sql'",
  'operations_shopify_order_management_applied',
  'shopifyOrderManagement,',
  'allowlistedAccountCount',
  'durable.processing > 0',
  'durable.staleProcessing > 0',
  'durable.unknown > 0',
  'Shopify order management has stale provider-write attempts requiring reconciliation.',
  'Shopify order management has unknown provider-write outcomes requiring reconciliation.',
]) {
  assert.ok(routeSource.includes(fragment), `Health route missing ${fragment}`)
}
for (const table of managementTables) {
  assert.ok(
    routeSource.includes(`'${table}'`),
    `Health structural query missing table ${table}`,
  )
}
for (const signature of managementFunctions) {
  assert.ok(
    routeSource.includes(`'${signature}'`),
    `Health structural query missing function ${signature}`,
  )
}
for (const [table, trigger, signature] of managementTriggers) {
  const mapping = new RegExp(
    `['"]${table}['"][\\s\\S]{0,180}`
      + `['"]${trigger}['"][\\s\\S]{0,180}`
      + `['"]${signature.replace(/[()]/gu, '\\$&')}['"]`,
    'u',
  )
  assert.match(
    routeSource,
    mapping,
    `Health structural query missing exact trigger mapping ${trigger}`,
  )
}
assert.match(
  routeSource,
  /installed_shopify_order_management_trigger\.tgfoid\s*=\s*[\s\S]{0,120}to_regprocedure/u,
  'Health structural query must compare exact trigger function OIDs',
)
assert.match(
  routeSource,
  /installed_shopify_order_management_trigger\.tgenabled\s*=\s*'O'/u,
  'Health structural query must require normally enabled triggers',
)
assert.match(
  routeSource,
  /!row\?\.operations_shopify_order_management_applied[\s\S]{0,180}errors\.push\('Required database migrations are not applied\.'\)/u,
  'Missing order-management structure must enter the global migration error',
)

function loadRoute({ durable, structureApplied }) {
  let healthReads = 0
  let mainQuery = null
  const runtime = Object.freeze({
    available: false,
    mode: null,
    blockerCode: 'SHOPIFY_ORDER_TEST_WRITES_RAILWAY_OR_LOCAL_ONLY',
    allowedAccountGlobalIds: Object.freeze([
      'gia9286799',
      'gia7654321',
    ]),
    providerWritesEnabled: false,
    productionAvailable: false,
  })
  const now = new Date().toISOString()
  const mainRow = new Proxy({ now }, {
    get(target, property) {
      if (property in target) return target[property]
      if (property === 'operations_shopify_order_management_applied') {
        return structureApplied
      }
      if (
        typeof property === 'string'
        && (property.endsWith('_applied') || property.endsWith('_present'))
      ) return true
      return undefined
    },
  })
  const query = async (sql) => {
    const statement = String(sql)
    if (statement.includes('AS operations_shopify_order_management_applied')) {
      mainQuery = statement
      return { rows: [mainRow] }
    }
    return { rows: [{}] }
  }
  const canonicalHealth = {
    status: 'ready',
    expiredProtectedReadBacklog: 0,
    protectedEvidenceKeys: { ready: true },
    summary: {},
  }
  const orderHistory = {
    transport: 'polling',
    continuousTransportCounts: {},
    pollingCadenceMinutes: 5,
    staleProcessing: 0,
    failed: 0,
    blocked: 0,
    dead: 0,
    overduePolls: 0,
    expiredSensitiveEvidence: 0,
  }
  const moduleMocks = {
    'next/server': {
      NextResponse: {
        json(body, init = {}) {
          return {
            body,
            status: init.status || 200,
            async json() {
              return body
            },
          }
        },
      },
    },
    '@/lib/agents/provider': {
      getAgentRuntime: () => ({ provider: 'test' }),
    },
    '@/lib/agents/repositoryRunnerConfig': {
      getRepositoryRunnerConfiguration: () => ({
        enabled: false,
        ready: true,
        reason: null,
        repositoryFullName: null,
        baseBranch: null,
      }),
    },
    '@/lib/persistence/config': {
      getStorageDriver: () => 'postgres',
      isHostedRuntime: () => true,
    },
    '@/lib/persistence/agentCredentials': {
      query: async () => ({ rows: [{ operator_id: 'operator' }] }),
    },
    '@/lib/persistence/postgres': { query },
    '@/lib/persistence/operationsCommandReceiptHealth': {
      OPERATIONS_COMMAND_RECEIPT_HEALTH_QUERY: 'command receipt health',
    },
    '@/lib/persistence/commerceOrderRevisions': {
      readCommerceOrderRevisionHealthFromPostgres: async () =>
        canonicalHealth,
    },
    '@/lib/persistence/commerceOrderSync': {
      readCommerceOrderSyncHealthFromPostgres: async () => orderHistory,
      readCommerceOrderSyncCursorKeyReadinessFromPostgres: async () => ({
        ready: true,
      }),
    },
    '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs': {
      CommerceOrderRevisionEvidenceKeyConfigError: class extends Error {},
      resolveCommerceOrderRevisionEvidenceKeyConfig: () => ({}),
      summarizeCommerceOrderRevisionEvidenceKeyReadiness: () => ({
        ready: true,
        activeKeyId: null,
        configuredKeyIds: [],
      }),
    },
    '@/lib/persistence/shopifyWebhookReceiptHealth': {
      readShopifyWebhookReceiptHealthFromPostgres: async () => ({
        status: 'ready',
        actionable: 0,
      }),
    },
    '@/lib/persistence/shopifyOrderWebhookSignals': {
      readShopifyOrderWebhookSignalHealthFromPostgres: async () => ({
        staleProcessing: 0,
        failed: 0,
        dead: 0,
        overdueDirty: 0,
      }),
    },
    '@/lib/persistence/shopifyOrderManagement': {
      async readShopifyOrderManagementHealthFromPostgres() {
        healthReads += 1
        return durable
      },
    },
    '@/lib/integrations/shopifyOrderManagementRuntime': {
      shopifyOrderManagementRuntime: () => runtime,
    },
    '@/lib/integrations/commerceIntake': {
      commerceReadRuntimeAvailable: () => false,
    },
    '@/lib/integrations/commerceReadRuntime': {
      commerceReadAccountSql: () => 'true',
      commerceReadRuntimeSummary: () => ({ status: 'disabled' }),
    },
    '@/lib/integrations/commerceOrderHistoryHealth': {
      commerceOrderHistoryDurableDegraded: () => false,
      commerceOrderHistoryOperationalHealth: () => ({
        status: 'disabled',
        runtimeAvailable: false,
        worker: { status: 'disabled' },
      }),
    },
    '@/lib/integrations/commerceFaireAutomaticPromotion': {
      faireAutomaticExactRefreshHealthSnapshot: () => ({ status: 'disabled' }),
      faireAutomaticOrderPromotionHealthSnapshot: () => ({ status: 'disabled' }),
      faireUnattributedAttentionHealthSnapshot: () => ({ status: 'disabled' }),
    },
    '@/lib/integrations/commerceShopifyAutomaticPromotion': {
      shopifyAutomaticOrderPromotionHealthSnapshot: () => ({
        status: 'disabled',
      }),
    },
    '@/lib/documentEmbeddings': {
      effectiveDocumentEmbeddingConfiguration: async () => ({
        provider: 'local',
      }),
    },
    '@/lib/shortlinks': {
      validateShortLinkConfiguration: () => {},
    },
    '@/lib/crm/suiteCrmClient': {
      suiteCrmBaseUrl: () => 'https://crm.invalid',
    },
    '@/lib/crm/suiteCrmProductImageReadClient': {
      suiteCrmProductImageReadConfiguration: () => ({
        enabled: false,
        ready: false,
        missing: [],
        invalid: [],
        credentialConflicts: [],
        aclAttestation: null,
        acl: [],
      }),
    },
    '@/lib/crm/suiteCrmNativeProductImageClient': {
      suiteCrmNativeProductImageProjectionConfiguration: () => ({
        enabled: false,
        ready: false,
        missing: [],
        invalid: [],
      }),
    },
    '@/lib/operations/fulfillmentOptimizerRuntimeConfig': {
      fulfillmentOptimizerRuntimeHealth: () => ({
        configurationStatus: 'ready',
        reason: null,
      }),
    },
  }
  const inertModule = new Proxy({}, {
    get() {
      return async () => null
    },
  })
  const output = ts.transpileModule(routeSource, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: routePath,
  }).outputText
  const loaded = { exports: {} }
  const secret = 'secret-health-sentinel-1234567890-abcdefghijk'
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    String,
    URL,
    console: { error() {} },
    exports: loaded.exports,
    module: loaded,
    process: {
      env: {
        VERCEL: '1',
        VERCEL_ENV: 'preview',
        APP_AUTH_REQUIRED: '1',
        APP_LOGIN_PASSWORD: 'password-long-enough-for-health',
        APP_LOGIN_EMAIL: 'operator@example.com',
        APP_SESSION_SECRET: secret,
        AGENT_CREDENTIAL_ENCRYPTION_KEY: secret,
        AGENT_CREDENTIAL_DATABASE_URL:
          'postgresql://health:health@database.invalid/health',
        MATON_API_KEY: 'maton-health-key-long-enough',
        MATON_GMAIL_CONNECTION_ID: 'gmail-health',
        CLAWPILOT_MAIL_FROM: 'clawpilot@example.com',
        CLAWPILOT_PUBLIC_URL: 'https://clawpilot.example.com',
        PIPELINE_SHEET_ID: 'pipeline-sheet-health-1234567890',
        CRM_ENABLED: '0',
      },
    },
    require(specifier) {
      if (specifier === 'fs') return requireFromApp('fs')
      return moduleMocks[specifier] || inertModule
    },
  }, { filename: routePath })
  return {
    GET: loaded.exports.GET,
    getHealthReads: () => healthReads,
    getMainQuery: () => mainQuery,
    secret,
  }
}

async function executeScenario(options) {
  const loaded = loadRoute(options)
  const response = await loaded.GET()
  return {
    body: JSON.parse(JSON.stringify(await response.json())),
    responseStatus: response.status,
    healthReads: loaded.getHealthReads(),
    mainQuery: loaded.getMainQuery(),
    secret: loaded.secret,
  }
}

const baseDurable = {
  prepared: 4,
  processing: 2,
  staleProcessing: 0,
  unknown: 0,
  latestUnknownAt: null,
  lastCompletedAt: '2026-08-13T12:00:00.000Z',
  knownProviderWriteOutcomeCount: 7,
  knownProviderWriteSum: 7,
}
const processing = await executeScenario({
  durable: baseDurable,
  structureApplied: true,
})
assert.equal(processing.responseStatus, 200)
assert.equal(processing.body.status, 'ok')
assert.equal(processing.body.shopifyOrderManagement.status, 'processing')
assert.deepEqual(processing.body.shopifyOrderManagement.runtime, {
  available: false,
  mode: null,
  blocker: 'SHOPIFY_ORDER_TEST_WRITES_RAILWAY_OR_LOCAL_ONLY',
  providerWritesEnabled: false,
  productionAvailable: false,
  allowlistedAccountCount: 2,
})
assert.deepEqual(processing.body.shopifyOrderManagement.durable, baseDurable)
assert.equal(processing.healthReads, 1)
assert.match(
  processing.mainQuery,
  /0283_operations_shopify_order_management\.sql/u,
)
const processingJson = JSON.stringify(processing.body)
assert.doesNotMatch(processingJson, /gia9286799|gia7654321/u)
assert.ok(!processingJson.includes(processing.secret))
assert.ok(
  !processing.body.warnings.some((warning) =>
    warning.includes('Shopify order management has stale')
    || warning.includes('Shopify order management has unknown')),
  'Active processing with a current lease must remain informational',
)

const disabled = await executeScenario({
  durable: { ...baseDurable, processing: 0 },
  structureApplied: true,
})
assert.equal(disabled.responseStatus, 200)
assert.equal(disabled.body.shopifyOrderManagement.status, 'disabled')
assert.equal(disabled.body.shopifyOrderManagement.runtime.available, false)
assert.equal(
  disabled.body.shopifyOrderManagement.runtime.providerWritesEnabled,
  false,
)
assert.equal(
  disabled.body.shopifyOrderManagement.runtime.productionAvailable,
  false,
)

const degraded = await executeScenario({
  durable: {
    ...baseDurable,
    processing: 3,
    staleProcessing: 1,
    unknown: 2,
    latestUnknownAt: '2026-08-13T12:05:00.000Z',
  },
  structureApplied: true,
})
assert.equal(degraded.responseStatus, 200)
assert.equal(degraded.body.status, 'ok')
assert.equal(degraded.body.shopifyOrderManagement.status, 'degraded')
assert.ok(degraded.body.warnings.includes(
  'Shopify order management has stale provider-write attempts requiring reconciliation.',
))
assert.ok(degraded.body.warnings.includes(
  'Shopify order management has unknown provider-write outcomes requiring reconciliation.',
))
assert.ok(
  !degraded.body.errors.some((error) =>
    error.includes('Shopify order management')),
  'Durable lane degradation must warn without making global health unavailable',
)

const missing = await executeScenario({
  durable: baseDurable,
  structureApplied: false,
})
assert.equal(missing.responseStatus, 503)
assert.equal(missing.body.status, 'error')
assert.ok(missing.body.errors.includes(
  'Required database migrations are not applied.',
))
assert.equal(missing.body.shopifyOrderManagement.status, 'migration-pending')
assert.equal(missing.body.shopifyOrderManagement.durable, null)
assert.equal(missing.healthReads, 0)

console.log('Shopify order management health acceptance passed')
