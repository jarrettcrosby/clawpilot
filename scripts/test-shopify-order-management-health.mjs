#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const routePath = 'app_src/app/api/health/route.ts'
const routeSource = readFileSync(resolve(root, routePath), 'utf8')
const singleSaveMigrationPath =
  'db/migrations/0312_operations_shopify_order_single_save.sql'
const singleSaveMigration = readFileSync(
  resolve(root, singleSaveMigrationPath),
  'utf8',
)
const singleSaveMigrationChecksum = createHash('sha256')
  .update(singleSaveMigration)
  .digest('hex')
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
const futureColumns = [
  'fulfillment_gid',
  'expected_fulfillment_updated_at',
  'predecessor_authorization_id',
]
const futureConstraints = [
  'operations_shopify_order_management_authorizations_action_check',
  'ops_shopify_order_mgmt_auth_action_valid',
  'operations_shopify_order_management_attempts_action_check',
  'ops_shopify_order_mgmt_attempt_identity_valid',
  'ops_shopify_order_mgmt_auth_predecessor_fkey',
  'ops_shopify_order_mgmt_attempt_predecessor_fkey',
]
const futureFunctions = [
  'operations_shopify_fulfillment_reversal_is_safe(uuid,uuid,text,timestamp with time zone)',
  'operations_shopify_post_reversal_order_cancellation_is_safe(uuid,uuid,uuid)',
  'operations_shopify_order_management_is_current(uuid,uuid,boolean)',
  'protect_shopify_fulfillment_reversal_authorization_insert()',
  'protect_shopify_fulfillment_reversal_attempt_insert()',
  'protect_shopify_post_reversal_order_cancel_authorization_insert()',
  'protect_shopify_post_reversal_order_cancel_attempt_insert()',
  'enforce_shopify_order_management_downstream_race(uuid,uuid)',
  'protect_shopify_order_management_downstream_race()',
  'protect_shopify_order_management_indirect_downstream_race()',
]
const futureSplitTriggers = [
  [
    'operations_shopify_order_management_authorizations',
    'protect_shopify_order_management_authorization_insert',
  ],
  [
    'operations_shopify_order_management_authorizations',
    'protect_shopify_fulfillment_reversal_authorization_insert',
  ],
  [
    'operations_shopify_order_management_authorizations',
    'protect_shopify_post_reversal_order_cancel_authorization_insert',
  ],
  [
    'operations_shopify_order_management_attempts',
    'protect_shopify_order_management_attempt_insert',
  ],
  [
    'operations_shopify_order_management_attempts',
    'protect_shopify_fulfillment_reversal_attempt_insert',
  ],
  [
    'operations_shopify_order_management_attempts',
    'protect_shopify_post_reversal_order_cancel_attempt_insert',
  ],
  [
    'operations_shopify_order_management_authorizations',
    'protect_shopify_order_management_authorization_write',
  ],
  [
    'operations_shopify_order_management_attempts',
    'protect_shopify_order_management_attempt_write',
  ],
]
const futureRaceTriggers = [
  ['operations_fulfillment_plans', 'protect_shopify_order_management_plan_race'],
  ['operations_reservations', 'protect_shopify_order_management_reservation_race'],
  ['operations_waves', 'protect_shopify_order_management_wave_race'],
  ['operations_pick_tasks', 'protect_shopify_order_management_pick_race'],
  [
    'operations_packaging_material_claims',
    'protect_shopify_order_management_packaging_claim_race',
  ],
  ['operations_packages', 'protect_shopify_order_management_package_race'],
  ['operations_labels', 'protect_shopify_order_management_label_race'],
  ['operations_shipments', 'protect_shopify_order_management_shipment_race'],
  [
    'operations_commerce_fulfillment_exports',
    'protect_shopify_order_management_export_race',
  ],
  [
    'operations_fulfillment_executions',
    'protect_shopify_order_management_execution_race',
  ],
  [
    'operations_active_fulfillment_executions',
    'protect_shopify_order_management_active_execution_race',
  ],
  [
    'operations_label_attempts',
    'protect_shopify_order_management_label_attempt_race',
  ],
  [
    'operations_shipment_groups',
    'protect_shopify_order_management_shipment_group_race',
  ],
  [
    'operations_production_fulfillment_rerate_runs',
    'protect_shopify_order_management_rerate_race',
  ],
]

function balancedSqlExpression(source, openingParenthesisIndex) {
  let depth = 0
  let quoted = false
  for (
    let index = openingParenthesisIndex;
    index < source.length;
    index += 1
  ) {
    const character = source[index]
    if (character === "'") {
      if (quoted && source[index + 1] === "'") {
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (!quoted && character === '(') {
      depth += 1
    } else if (!quoted && character === ')') {
      depth -= 1
      if (depth === 0) return source.slice(openingParenthesisIndex, index + 1)
    }
  }
  throw new Error('Unbalanced SQL health expression')
}

const firstFutureColumnIndex = routeSource.indexOf("'fulfillment_gid'")
assert.ok(firstFutureColumnIndex > 0, 'Future 0325 columns must be attested')
const futureGateNotExistsIndex = routeSource.lastIndexOf(
  'NOT EXISTS (',
  firstFutureColumnIndex,
)
const futureGateStart = routeSource.lastIndexOf(
  'AND (',
  futureGateNotExistsIndex,
)
assert.ok(
  futureGateNotExistsIndex > 0 && futureGateStart > 0,
  'Future 0325 attestation must have an explicit absence gate',
)
const futureGate = balancedSqlExpression(
  routeSource,
  routeSource.indexOf('(', futureGateStart),
)

assert.equal(
  singleSaveMigrationChecksum,
  'b0f591edc2dd10c6f9a8e88ef3291b9b8b1bd056fcafa159c2686d00cde44dcb',
  'health attestation must pin the exact address-aware 0312 migration',
)
assert.match(singleSaveMigration, /including the Shopify source[\s\S]{0,40}shipping address/u)
assert.match(
  singleSaveMigration,
  /No plaintext order field or address is retained\./u,
)
assert.doesNotMatch(
  singleSaveMigration,
  /ADD COLUMN (?:shipping_address|address1|address2|city|zip|postal_code)/u,
  'address PII must remain represented only by the requested projection hash',
)
for (const fragment of [
  "from '@/lib/persistence/shopifyOrderManagement'",
  'readShopifyOrderManagementHealthFromPostgres',
  "from '@/lib/integrations/shopifyOrderManagementRuntime'",
  'shopifyOrderManagementRuntime',
  "'0283_operations_shopify_order_management.sql'",
  'operations_shopify_order_management_applied',
  'operations_commerce_provider_write_controls_applied',
  'shopifyOrderManagement,',
  'allowlistedAccountCount',
  'durable.processing > 0',
  'durable.staleProcessing > 0',
  'durable.unknown > 0',
  'Shopify order management has stale provider-write attempts requiring reconciliation.',
  'Shopify order management has unknown provider-write outcomes requiring reconciliation.',
  "'0308_operations_commerce_provider_write_controls.sql'",
  "'public.operations_commerce_provider_write_controls'",
  "'public.operations_commerce_provider_write_control_current'",
  '86e39d6e19962894b94466a6fad367682093dc6271e0df92c9cade112ad075b6',
  '98cde97780ca536d8538b7814c5499ceee3fe47ff19ef406ad35a45b11610f6b',
  '9d0946bfb810bd7be8b859e8643b1fa51a946dd98c32b5e781b573c163cdbaf5',
  '442a1b8a8cac37652c6f193d5ab07ae3325891dcfa98f80593603e8166ac97d6',
  "'0312_operations_shopify_order_single_save.sql'",
  'b0f591edc2dd10c6f9a8e88ef3291b9b8b1bd056fcafa159c2686d00cde44dcb',
  'c00a5184de727bc7a795fc0447086f0feb3cdc2e1b3aea90927900ed16bf61c7',
  '656bf1da59cb5f5f282fd1f37173df02cf79a77bdcfa7449032970cb283241e7',
  'acf4d37a8b2d32bbd2b5731994bccf86f1b5549ce69fe9e4060d24e79c28c650',
  "'requested_projection_hash'",
  "'requires_order_edits'",
  "'ops_shopify_order_mgmt_auth_projection_hash_valid'",
  "'ops_shopify_order_mgmt_attempt_projection_hash_valid'",
  "'ops_shopify_order_mgmt_outcome_write_count_valid'",
  "'0325_operations_shopify_fulfillment_reversal.sql'",
  'f17aa20305e3190c6d26950aceb9c788e3b9b1ecc1cba3515e1d0d64aace50ab',
  '0a036803128e3152d7d200262e7980e913cc0197c852686c139918b81990b3b3',
  'fb97f262f1104adf5f090289158a2c6c911988f2193bed5f1b490a31afb38c25',
  '53032e88095ed3ce3159044c748684fed9500935b96c06d66af60f151116b052',
  '702f0b87268a63bc78762516719f410bcaed03318e1f041c3d3c4afa210eb59d',
  'e2b3e102a168eca0294656e883c74bfd2ebdac1740bfe13a14c36c282c79af99',
  'fc9b1d5fef57ae7a7f305713e7944713fd41026c00534c8d1216b983f5f05d2c',
  '2ef565c5cd6a53ff7a0bdf2532f33247fcdb89326adce0aa00883581170cfddc',
  '0ff13ea37552b62b039a3d6dfa7eeeb66db49fc21e7a7e266d2738912b4af101',
  "'fulfillment_gid'",
  "'expected_fulfillment_updated_at'",
  "'predecessor_authorization_id'",
  "'operations_shopify_fulfillment_reversal_is_safe(uuid,uuid,text,timestamp with time zone)'",
  "'operations_shopify_post_reversal_order_cancellation_is_safe(uuid,uuid,uuid)'",
  "'protect_shopify_fulfillment_reversal_authorization_insert()'",
  "'protect_shopify_fulfillment_reversal_attempt_insert()'",
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
  futureGate,
  /NOT EXISTS \([\s\S]{0,180}0325_operations_shopify_fulfillment_reversal\.sql[\s\S]{0,180}OR \(/u,
  'Future schema checks must be skipped as one unit while 0325 is absent',
)
for (const fragment of [
  'f17aa20305e3190c6d26950aceb9c788e3b9b1ecc1cba3515e1d0d64aace50ab',
  '0a036803128e3152d7d200262e7980e913cc0197c852686c139918b81990b3b3',
  'fb97f262f1104adf5f090289158a2c6c911988f2193bed5f1b490a31afb38c25',
  '53032e88095ed3ce3159044c748684fed9500935b96c06d66af60f151116b052',
  '702f0b87268a63bc78762516719f410bcaed03318e1f041c3d3c4afa210eb59d',
  'e2b3e102a168eca0294656e883c74bfd2ebdac1740bfe13a14c36c282c79af99',
]) {
  assert.ok(
    futureGate.includes(fragment),
    `Future-only health attestation escaped the 0325 absence gate: ${fragment}`,
  )
}
for (const fragment of [
  ...futureColumns,
  ...futureConstraints,
  ...futureFunctions,
]) {
  assert.ok(
    futureGate.includes(`'${fragment}'`),
    `Future-only contract escaped the 0325 absence gate: ${fragment}`,
  )
}
for (const [table, trigger] of [
  ...futureSplitTriggers,
  ...futureRaceTriggers,
]) {
  const mapping = new RegExp(
    `['"]${table}['"][\\s\\S]{0,240}['"]${trigger}['"]`,
    'u',
  )
  assert.match(
    futureGate,
    mapping,
    `Future trigger escaped the 0325 absence gate: ${trigger}`,
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
  /NOT EXISTS \([\s\S]{0,180}public\.schema_migrations[\s\S]{0,220}0308_operations_commerce_provider_write_controls\.sql[\s\S]{0,180}OR \(/u,
  'Health readiness must accept the old phase only while 0308 is absent',
)
assert.match(
  routeSource,
  /NOT EXISTS \([\s\S]{0,180}public\.schema_migrations[\s\S]{0,220}0312_operations_shopify_order_single_save\.sql[\s\S]{0,220}AND NOT EXISTS \([\s\S]{0,180}0325_operations_shopify_fulfillment_reversal\.sql[\s\S]{0,180}OR \(/u,
  'Health readiness may accept the 0308 function bodies only before both 0312 and 0325',
)
assert.match(
  routeSource,
  /CASE[\s\S]{0,300}0325_operations_shopify_fulfillment_reversal\.sql[\s\S]{0,300}2ef565c5cd6a53ff7a0bdf2532f33247fcdb89326adce0aa00883581170cfddc[\s\S]{0,300}0312_operations_shopify_order_single_save\.sql[\s\S]{0,300}c00a5184de727bc7a795fc0447086f0feb3cdc2e1b3aea90927900ed16bf61c7[\s\S]{0,180}ELSE[\s\S]{0,180}98cde97780ca536d8538b7814c5499ceee3fe47ff19ef406ad35a45b11610f6b/u,
  'Function attestation must select the exact 0325, 0312, or frozen 0308 aggregate',
)
assert.match(
  routeSource,
  /CASE[\s\S]{0,300}0325_operations_shopify_fulfillment_reversal\.sql[\s\S]{0,300}fc9b1d5fef57ae7a7f305713e7944713fd41026c00534c8d1216b983f5f05d2c[\s\S]{0,180}ELSE[\s\S]{0,180}acf4d37a8b2d32bbd2b5731994bccf86f1b5549ce69fe9e4060d24e79c28c650/u,
  'Constraint attestation must keep the exact 0312 aggregate until 0325 exists',
)
assert.match(
  routeSource,
  /CASE[\s\S]{0,300}0325_operations_shopify_fulfillment_reversal\.sql[\s\S]{0,300}0ff13ea37552b62b039a3d6dfa7eeeb66db49fc21e7a7e266d2738912b4af101[\s\S]{0,180}ELSE[\s\S]{0,180}9d0946bfb810bd7be8b859e8643b1fa51a946dd98c32b5e781b573c163cdbaf5/u,
  'Trigger attestation must keep the exact 0312 aggregate until 0325 exists',
)
assert.match(
  routeSource,
  /pg_catalog\.to_regprocedure\(\s*'public\.' \|\| required\.signature/u,
  'Post-0308 function resolvers must be schema-qualified',
)
assert.match(
  routeSource,
  /pg_catalog\.pg_get_triggerdef\(installed\.oid\)/u,
  'Post-0308 readiness must hash exact trigger definitions',
)
assert.match(
  routeSource,
  /installed\.conrelid\s*=\s*pg_catalog\.to_regclass\([\s\S]{0,140}operations_commerce_provider_write_controls[\s\S]{0,140}installed\.contype\s*<>\s*'n'/u,
  'Provider-write constraint health must ignore PostgreSQL 18 NOT NULL catalog rows',
)
assert.match(
  routeSource,
  /row\.operations_commerce_provider_write_controls_applied[\s\S]{0,100}\? 'ready'/u,
  'Post-0308 health status must use per-account Provider writes authority',
)
assert.doesNotMatch(
  routeSource,
  /'provider_write_control_row_version'\s+IN pg_get_functiondef/u,
  'Token-presence checks are not exact function-body attestation',
)
const migrationError = "errors.push('Required database migrations are not applied.')"
const migrationErrorIndex = routeSource.indexOf(migrationError)
const migrationConditionStart = routeSource.lastIndexOf('if (', migrationErrorIndex)
assert.ok(
  migrationErrorIndex >= 0
    && migrationConditionStart >= 0
    && routeSource
      .slice(migrationConditionStart, migrationErrorIndex + migrationError.length)
      .includes('!row?.operations_shopify_order_management_applied'),
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
assert.equal(disabled.body.shopifyOrderManagement.status, 'ready')
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

const liveDatabaseUrl = process.env.SHOPIFY_ORDER_MANAGEMENT_HEALTH_DATABASE_URL
if (liveDatabaseUrl) {
  const { Pool } = requireFromApp('pg')
  const pool = new Pool({ connectionString: liveDatabaseUrl, max: 1 })
  const client = await pool.connect()
  const phaseMarker = processing.mainQuery.indexOf(
    "'0308_operations_commerce_provider_write_controls.sql'",
  )
  const phaseStart = processing.mainQuery.lastIndexOf('AND (', phaseMarker) + 4
  assert.ok(phaseMarker > 0 && phaseStart > 3)
  let phaseEnd = -1
  let depth = 0
  let quoted = false
  for (let index = phaseStart; index < processing.mainQuery.length; index += 1) {
    const character = processing.mainQuery[index]
    if (character === "'") {
      if (quoted && processing.mainQuery[index + 1] === "'") {
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (!quoted && character === '(') {
      depth += 1
    } else if (!quoted && character === ')') {
      depth -= 1
      if (depth === 0) {
        phaseEnd = index + 1
        break
      }
    }
  }
  assert.ok(phaseEnd > phaseStart)
  const providerWriteHealthExpression = processing.mainQuery.slice(
    phaseStart,
    phaseEnd,
  )
  const structuralReady = async () => {
    const result = await client.query(
      `SELECT ${providerWriteHealthExpression} AS ready`,
    )
    return result.rows[0]?.ready === true
  }
  try {
    assert.equal(await structuralReady(), true)

    await client.query('BEGIN')
    await client.query(
      `DELETE FROM public.schema_migrations
       WHERE filename =
         '0312_operations_shopify_order_single_save.sql'`,
    )
    assert.equal(await structuralReady(), false)
    await client.query('ROLLBACK')

    await client.query('BEGIN')
    await client.query(
      `UPDATE public.schema_migrations
       SET checksum = repeat('0', 64)
       WHERE filename =
         '0312_operations_shopify_order_single_save.sql'`,
    )
    assert.equal(await structuralReady(), false)
    await client.query('ROLLBACK')

    await client.query('BEGIN')
    await client.query(
      `ALTER TABLE
         public.operations_shopify_order_management_attempts
       ALTER COLUMN requires_order_edits SET DEFAULT true`,
    )
    assert.equal(await structuralReady(), false)
    await client.query('ROLLBACK')

    await client.query('BEGIN')
    await client.query(
      `ALTER TABLE
         public.operations_shopify_order_management_outcomes
       DROP CONSTRAINT ops_shopify_order_mgmt_outcome_write_count_valid`,
    )
    assert.equal(await structuralReady(), false)
    await client.query('ROLLBACK')

    await client.query('BEGIN')
    await client.query(
      `UPDATE public.schema_migrations
       SET checksum = repeat('0', 64)
       WHERE filename =
         '0308_operations_commerce_provider_write_controls.sql'`,
    )
    assert.equal(await structuralReady(), false)
    await client.query('ROLLBACK')

    await client.query('BEGIN')
    await client.query(
      `CREATE OR REPLACE FUNCTION
         public.operations_shopify_order_management_is_current(
           p_organization_id uuid,
           p_authorization_id uuid,
           p_require_claim_fence boolean DEFAULT true
         )
       RETURNS boolean
       LANGUAGE sql
       STABLE
       SET search_path = pg_catalog, public, pg_temp
       AS 'SELECT true'`,
    )
    assert.equal(await structuralReady(), false)
    await client.query('ROLLBACK')

    await client.query('BEGIN')
    await client.query(
      `ALTER TABLE
         public.operations_shopify_order_management_authorizations
       DISABLE TRIGGER
         protect_shopify_order_management_authorization_write`,
    )
    assert.equal(await structuralReady(), false)
    await client.query('ROLLBACK')

    assert.equal(await structuralReady(), true)
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
    await pool.end()
  }
}

console.log('Shopify order management health acceptance passed')
