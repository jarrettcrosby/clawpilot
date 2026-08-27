#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { extname, resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const migrationPath =
  'db/migrations/0326_operations_shopify_reversal_test_fixture.sql'
const providerErrorMigrationPath =
  'db/migrations/0328_operations_shopify_reversal_fixture_provider_errors.sql'
const profileV3MigrationPath =
  'db/migrations/0330_operations_shopify_reversal_fixture_profile_v3.sql'
const profileV4MigrationPath =
  'db/migrations/0332_operations_shopify_reversal_fixture_profile_v4.sql'
const healthPath =
  'app_src/lib/persistence/shopifyReversalFixtureHealth.ts'
const healthRoutePath = 'app_src/app/api/health/route.ts'
const persistencePath = 'app_src/lib/persistence/shopifyReversalFixture.ts'
const commandsPath =
  'app_src/lib/operations/shopifyReversalFixtureCommands.ts'
const fulfillmentProviderPath =
  'app_src/lib/integrations/shopifyFulfillmentWriteback.ts'
const orderProviderPath =
  'app_src/lib/integrations/shopifyReversalFixtureProvider.ts'
const approvalRoutePath =
  'app_src/app/api/dev/shopify-test-fixtures/approve/route.ts'
const migration = readFileSync(resolve(root, migrationPath), 'utf8')
const providerErrorMigration = readFileSync(
  resolve(root, providerErrorMigrationPath),
  'utf8',
)
const profileV3Migration = readFileSync(
  resolve(root, profileV3MigrationPath),
  'utf8',
)
const profileV4Migration = readFileSync(
  resolve(root, profileV4MigrationPath),
  'utf8',
)
const checksum = createHash('sha256').update(migration).digest('hex')
const healthSource = readFileSync(resolve(root, healthPath), 'utf8')
const healthRoute = readFileSync(resolve(root, healthRoutePath), 'utf8')
const persistenceSource = readFileSync(resolve(root, persistencePath), 'utf8')
const commandsSource = readFileSync(resolve(root, commandsPath), 'utf8')
const fulfillmentProviderSource = readFileSync(
  resolve(root, fulfillmentProviderPath),
  'utf8',
)
const orderProviderSource = readFileSync(resolve(root, orderProviderPath), 'utf8')
const approvalRouteSource = readFileSync(resolve(root, approvalRoutePath), 'utf8')

assert.match(healthSource, new RegExp(checksum, 'u'))
assert.match(healthRoute, /readShopifyReversalFixtureHealthInPostgres/u)
assert.match(healthRoute, /SHOPIFY_REVERSAL_FIXTURE_DATABASE_IDENTITY/u)
assert.match(healthRoute, /shopifyReversalFixtureRuntimeState\.available/u)
assert.match(healthRoute, /reversalFixtureReady/u)
assert.match(
  persistenceSource,
  /\^\(\?:CREATE\|FULFILL\) TEST ORDER \[a-f0-9\]\{12\}\$/u,
  'claim confirmation must be a fixed short intent-hash-bound statement',
)

for (const fragment of [
  "phase IN ('create_order', 'create_fulfillment')",
  "fixture_profile_version = 'shopify-reversal-fixture-v1'",
  "account.global_id = 'giah34fedoa5b1o'",
  "'c6c8e6e7-fffa-4969-9526-e99da0ab2754'::uuid",
  "'gid://shopify/Shop/95083757815'",
  "'test-pro-bakery-bites.myshopify.com'",
  "'750aa268-0e31-4065-a99c-4016e4d4fab1'",
  "candidate.test_order = true",
  "candidate.normalized_payment_status = 'pending'",
  "candidate.normalized_fulfillment_status = 'unfulfilled'",
  "wave.released_at = p_released_at",
  'p_released_at <= pg_catalog.clock_timestamp()',
  "pick.status = 'ready'",
  "COALESCE(pick.picked_quantity, 0) = 0",
  'operations_shopify_external_fulfillment_reconciliations',
  'operations_label_attempts',
  'operations_labels',
  'operations_print_artifacts',
  'operations_packages',
  'operations_shipments',
  'operations_commerce_fulfillment_exports',
  'operations_billable_events',
  'operations_fulfillment_executions',
  'operations_active_fulfillment_executions',
  'pg_advisory_xact_lock',
  'operations_shopify_reversal_fixture_approvals',
  'operations_shopify_reversal_fixture_approval_session_is_current',
  'operations_shopify_reversal_fixture_provider_claim_is_current',
  'provider_payload_hash',
  "command.expires_at + interval '30 seconds'",
  "'shopify-reversal-fixture-outcome:'",
  "worker_principal = 'pipeline_outbox_worker'",
  "session.auth_method IN (",
  "user_account.status = 'active'",
  'Shopify reversal fixture ledgers are append-only',
]) {
  assert.ok(migration.includes(fragment), `0326 must include ${fragment}`)
}
for (const fragment of [
  'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_ERRORS_MIGRATION',
  providerErrorMigrationPath.split('/').at(-1),
  createHash('sha256').update(providerErrorMigration).digest('hex'),
  'provider_error_migration_current',
  'SHOPIFY_REVERSAL_FIXTURE_PROFILE_V3_MIGRATION',
  profileV3MigrationPath.split('/').at(-1),
  createHash('sha256').update(profileV3Migration).digest('hex'),
  'profile_v3_migration_current',
  'SHOPIFY_REVERSAL_FIXTURE_PROFILE_V4_MIGRATION',
  profileV4MigrationPath.split('/').at(-1),
  createHash('sha256').update(profileV4Migration).digest('hex'),
  'profile_v4_migration_current',
  'provider_error_column',
  'provider_error_constraint',
  'profile_version_constraint',
  'provider_error_view_columns',
]) {
  assert.ok(
    healthSource.includes(fragment),
    `fixture health must gate provider-error evidence with ${fragment}`,
  )
}

for (const fragment of [
  'shopify_reversal_fixture_commands_profile_version_valid',
  "'shopify-reversal-fixture-v1'",
  "'shopify-reversal-fixture-v2'",
  'ADD COLUMN provider_error_summary text',
  "outcome_state IN ('rejected', 'unknown')",
  'provider_mutation_attempted = true',
  'pg_catalog.char_length(provider_error_summary) BETWEEN 1 AND 500',
  "provider_error_summary !~ '[[:cntrl:]]'",
  "'^Shopify rejected order creation \\('",
  'FULFILLMENT_SERVICE_INVALID|INVALID|INVENTORY_CLAIM_FAILED',
  'TAX_LINE_RATE_MISSING|UNSPECIFIED',
  'initial_outcome.error_code AS provider_error_code',
  'initial_outcome.provider_error_summary',
]) {
  assert.ok(
    providerErrorMigration.includes(fragment),
    `0328 must include ${fragment}`,
  )
}
assert.doesNotMatch(
  providerErrorMigration,
  /^\s*(?:BEGIN|COMMIT);\s*$/imu,
  '0328 must use the migrator transaction',
)
for (const fragment of [
  'shopify_reversal_fixture_commands_profile_version_valid',
  "'shopify-reversal-fixture-v1'",
  "'shopify-reversal-fixture-v2'",
  "'shopify-reversal-fixture-v3'",
]) {
  assert.ok(
    profileV3Migration.includes(fragment),
    `0330 must include ${fragment}`,
  )
}
assert.doesNotMatch(
  profileV3Migration,
  /^\s*(?:BEGIN|COMMIT);\s*$/imu,
  '0330 must use the migrator transaction',
)
for (const fragment of [
  'shopify_reversal_fixture_commands_profile_version_valid',
  "'shopify-reversal-fixture-v1'",
  "'shopify-reversal-fixture-v2'",
  "'shopify-reversal-fixture-v3'",
  "'shopify-reversal-fixture-v4'",
]) {
  assert.ok(
    profileV4Migration.includes(fragment),
    `0332 must include ${fragment}`,
  )
}
assert.doesNotMatch(
  profileV4Migration,
  /^\s*(?:BEGIN|COMMIT);\s*$/imu,
  '0332 must use the migrator transaction',
)
for (const fragment of [
  'providerErrorSummary?: string | null',
  'provider_order_updated_at, error_code, provider_error_summary',
  'provider_error_code: string | null',
  'provider_error_summary: string | null',
  'providerErrorCode: row.provider_error_code',
  'providerErrorSummary: row.provider_error_summary',
]) {
  assert.ok(
    persistenceSource.includes(fragment),
    `provider-error persistence must include ${fragment}`,
  )
}
const safeSummaryStart = commandsSource.indexOf(
  'function safeProviderErrorSummary(',
)
const safeSummaryEnd = commandsSource.indexOf(
  '\nasync function recordOutcomeConservatively',
  safeSummaryStart,
)
assert.ok(safeSummaryStart >= 0 && safeSummaryEnd > safeSummaryStart)
const safeSummarySource = commandsSource.slice(safeSummaryStart, safeSummaryEnd)
assert.match(
  safeSummarySource,
  /error instanceof ShopifyReversalFixtureProviderError/u,
)
assert.match(safeSummarySource, /error\.providerErrorSummary/u)
assert.match(safeSummarySource, /summary\.length > 500/u)
assert.match(
  safeSummarySource,
  /\^Shopify rejected order creation \\\(/u,
)
assert.match(safeSummarySource, /SAFE_ORDER_CREATE_PROVIDER_ERROR_FACT/u)
assert.match(safeSummarySource, /SAFE_ORDER_CREATE_PROVIDER_ERROR_CODES/u)
assert.doesNotMatch(
  safeSummarySource,
  /error\.message/u,
  'durable provider evidence must never derive from the raw provider message',
)

const output = ts.transpileModule(healthSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: healthPath,
}).outputText
let queries = 0
let structureCurrent = true
const module = { exports: {} }
vm.runInNewContext(output, {
  Boolean,
  Number,
  Object,
  exports: module.exports,
  module,
  require(specifier) {
    assert.equal(specifier, '@/lib/persistence/postgres')
    return {
      query: async (_sql, values) => {
        queries += 1
        if (queries % 2 === 1) {
          assert.equal(values[0], migrationPath.split('/').at(-1))
          assert.equal(values[1], checksum)
          assert.equal(values[2], providerErrorMigrationPath.split('/').at(-1))
          assert.equal(
            values[3],
            createHash('sha256').update(providerErrorMigration).digest('hex'),
          )
          assert.equal(values[4], profileV3MigrationPath.split('/').at(-1))
          assert.equal(
            values[5],
            createHash('sha256').update(profileV3Migration).digest('hex'),
          )
          return { rows: [{
            migration_current: structureCurrent,
            provider_error_migration_current: structureCurrent,
            profile_v3_migration_current: structureCurrent,
            profile_v4_migration_current: structureCurrent,
            command_table: structureCurrent,
            approval_table: structureCurrent,
            attempt_table: structureCurrent,
            outcome_table: structureCurrent,
            provider_error_column: structureCurrent,
            provider_error_constraint: structureCurrent,
            profile_version_constraint: structureCurrent,
            provider_error_view_columns: structureCurrent,
            state_view: structureCurrent,
            actor_function: structureCurrent,
            account_function: structureCurrent,
            database_function: structureCurrent,
            approval_session_function: structureCurrent,
            approval_function: structureCurrent,
            fulfillment_function: structureCurrent,
            provider_claim_function: structureCurrent,
            immutable_trigger_count: structureCurrent ? '8' : '0',
            database_identity:
              '750aa268-0e31-4065-a99c-4016e4d4fab1',
          }] }
        }
        return { rows: [{
          awaiting_approval: '5', prepared: '1', processing: '2',
          unknown: '3', terminal: '4',
        }] }
      },
    }
  },
}, { filename: healthPath })

const healthy = await module.exports.readShopifyReversalFixtureHealthInPostgres()
assert.equal(healthy.migrationCurrent, true)
assert.equal(healthy.structureCurrent, true)
assert.equal(healthy.awaitingApproval, 5)
assert.equal(healthy.unknown, 3)
structureCurrent = false
const unhealthy = await module.exports.readShopifyReversalFixtureHealthInPostgres()
assert.equal(unhealthy.migrationCurrent, false)
assert.equal(unhealthy.structureCurrent, false)

function filesBelow(directory) {
  const result = []
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name)
    const stat = statSync(path)
    if (stat.isDirectory()) result.push(...filesBelow(path))
    else result.push(path)
  }
  return result
}

const uiRoots = [
  resolve(root, 'app_src/app'),
  resolve(root, 'app_src/components'),
]
const fixtureIdentifier = /shopify-test-fixtures|shopifyReversalFixture|SHOPIFY_REVERSAL_FIXTURE/iu
for (const path of uiRoots.flatMap(filesBelow)) {
  if (!['.ts', '.tsx', '.js', '.jsx'].includes(extname(path))) continue
  if (path.includes('/app/api/')) continue
  assert.doesNotMatch(
    readFileSync(path, 'utf8'),
    fixtureIdentifier,
    `fixture lane must not appear in normal UI: ${path}`,
  )
}

const proxy = readFileSync(resolve(root, 'app_src/proxy.ts'), 'utf8')
assert.match(proxy, /pathname === '\/api\/dev\/shopify-test-fixtures'/u)
assert.doesNotMatch(
  proxy,
  /normalizedPath === '\/api\/dev\/shopify-test-fixtures'/u,
  'the public proxy exception must be exact, not a trailing-slash alias',
)
assert.doesNotMatch(
  proxy,
  /pathname === '\/api\/dev\/shopify-test-fixtures\/approve'/u,
  'the authenticated approval subroute must not be public',
)
assert.doesNotMatch(
  proxy,
  /pathname\.startsWith\('\/api\/dev\/shopify-test-fixtures/u,
  'the worker-secret exception must not cover nested routes',
)
assert.match(healthRoute, /reversalFixtureDurable\.awaitingApproval/u)
assert.match(healthRoute, /'awaiting-approval'/u)

assert.doesNotMatch(
  fulfillmentProviderSource,
  /export async function writeShopifyFulfillment/u,
  'the generic low-level fulfillment mutation primitive must remain private',
)
assert.match(
  fulfillmentProviderSource,
  /executeShopifyReversalFixtureFulfillmentProviderAttempt[\s\S]*shopifyReversalFixtureFulfillmentProviderPayloadHash[\s\S]*assertShopifyReversalFixtureFulfillmentClaimCurrentInPostgres\([\s\S]*providerPayloadHash/u,
)
assert.match(
  orderProviderSource,
  /const providerPayload = exactOrderProviderPayload\([\s\S]*assertShopifyReversalFixtureOrderClaimCurrentInPostgres\([\s\S]*providerPayloadHash[\s\S]*shopifyAdminGraphql\([\s\S]*variables/u,
)
assert.match(orderProviderSource, /userErrors \{ code field message \}/u)
assert.match(
  orderProviderSource,
  /const errorSummary = providerRejectionSummary\(errors\)[\s\S]*true,[\s\S]*false,[\s\S]*errorSummary,/u,
)
assert.match(
  orderProviderSource,
  /tags: Object\.freeze\(\[SHOPIFY_REVERSAL_FIXTURE_BASE_TAG, uniqueTag\]\)[\s\S]*version: 'shopify-reversal-fixture-order-provider-payload-v3'[\s\S]*variables/u,
)
assert.match(
  persistenceSource,
  /operations_shopify_reversal_fixture_provider_claim_is_current\([\s\S]*expectedPhase[\s\S]*payloadHash/u,
)
assert.match(
  persistenceSource,
  /initial\.outcome_state = 'unknown'[\s\S]*durable_command\.expires_at \+ interval '30 seconds'/u,
)
for (const fragment of [
  'requireRequestSession(req)',
  'requireRequestUserForWorkspace(',
  'session.authenticatedUser !== session.effectiveUser',
  'session.activeWorkspaceOrganizationId',
  "role !== 'owner' && role !== 'admin'",
  'assertSameOrigin(req)',
  'browserSessionId: session.id',
  'isPostgresStorageEnabled()',
]) {
  assert.ok(
    approvalRouteSource.includes(fragment),
    `approval route must include ${fragment}`,
  )
}

console.log('Shopify reversal fixture health and hidden-surface boundary passed.')
