#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(relativePath) {
  const absolutePath = resolve(root, relativePath)
  assert.ok(existsSync(absolutePath), `missing regression replay file: ${relativePath}`)
  return readFileSync(absolutePath, 'utf8')
}

function assertIncludes(source, needle, label) {
  assert.ok(source.includes(needle), `${label} missing ${needle}`)
}

function assertMatches(source, pattern, label) {
  assert.match(source, pattern, `${label} missing ${pattern}`)
}

function loadTypeScriptModule(relativePath, mocks = {}) {
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: relativePath,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    Buffer,
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
  vm.runInNewContext(output, sandbox, { filename: relativePath })
  return module.exports
}

const migration = read(
  'db/migrations/0145_operations_two_pass_pack_rate_runs.sql',
)
const pricingSemanticsMigration = read(
  'db/migrations/0146_operations_pack_rate_pricing_semantics.sql',
)
for (const table of [
  'operations_pack_rate_runs',
  'operations_pack_rate_run_lines',
  'operations_pack_rate_run_packages',
  'operations_pack_rate_run_allocations',
  'operations_pack_rate_run_rate_choices',
  'operations_pack_rate_run_package_finalizations',
  'operations_pack_rate_variances',
]) {
  assertMatches(
    migration,
    new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}`),
    'two-pass pack-rate migration',
  )
}
for (const invariant of [
  "'checkout_quote', 'fulfillment_execution'",
  'prior_checkout_run_id',
  'Checkout quote runs require an expiring, customer-neutral succeeded snapshot',
  'Fulfillment execution lineage must reference the exact checkout quote context',
  "rate.provider = 'ups_rest'",
  "rate.provider = 'fedex_rest'",
  'rate_rows <> NEW.rate_choice_count',
  'selected_rows <> 1',
  'provider_write_count = 0',
  'postage_purchase_count = 0',
  'label_write_count = 0',
  'BEFORE UPDATE OR DELETE ON operations_pack_rate_runs',
  'Recorded final packing slip must match its immutable package allocation and tracking evidence',
]) {
  assertIncludes(migration, invariant, 'two-pass pack-rate invariant')
}
for (const invariant of [
  'pricing_semantics_version',
  'Pack-and-rate replay cannot calculate MUD before carrier billing',
  'Fulfillment must preserve the recorded checkout shipping charge',
  'Version 2 records checkout charge and carrier-estimate variance only',
]) {
  assertIncludes(
    pricingSemanticsMigration,
    invariant,
    'pack-rate pricing semantics correction',
  )
}

const types = read('app_src/lib/operations/regressionReplay.ts')
for (const contract of [
  'operations-regression-replay-v2',
  "'live_callback_recorded'",
  "'faire_checkout_estimate_captured'",
  "'new'",
  "'reuse'",
  "'ambiguous'",
  "'checkout_quote'",
  "'fulfillment_execution'",
  "'expected_blocked'",
  "finalPackingSlipStatus: 'blocked_until_label' | 'ready'",
  'noProviderWrites: true',
  'noPostagePurchases: true',
]) {
  assertIncludes(types, contract, 'regression replay shared contract')
}

const artifacts = read(
  'app_src/lib/persistence/operationsRegressionArtifacts.ts',
)
for (const contract of [
  'persistOperationsRegressionPackingSlipArtifactWithClient',
  'recorded_fulfillment_replay',
  'providerWriteCount: 0',
  'postagePurchaseCount: 0',
  'operations_print_artifacts',
  'operations_print_artifact_payloads',
]) {
  assertIncludes(artifacts, contract, 'regression packing-slip artifact adapter')
}
assert.doesNotMatch(
  artifacts,
  /INSERT INTO operations_(?:labels|shipments|print_jobs)/,
  'regression artifact adapter must not create labels, shipments, or print jobs',
)

const persistence = read(
  'app_src/lib/persistence/operationsRegressionReplay.ts',
)
for (const contract of [
  'planHybridCartonization',
  'HYBRID_CARTONIZATION_POLICY_VERSION',
  'HYBRID_CARTONIZATION_ALGORITHM_VERSION',
  'verifyOperationsRegressionOptimizerFixtures',
  'withTransaction',
  'acquireTransactionAdvisoryLock',
  'persistOperationsRegressionPackingSlipArtifactWithClient',
  'operations_pack_rate_runs',
  'operations_pack_rate_run_lines',
  'operations_pack_rate_run_packages',
  'operations_pack_rate_run_allocations',
  'operations_pack_rate_run_rate_choices',
  'operations_pack_rate_variances',
  "'ups_rest'",
  "'fedex_rest'",
  "'faire_checkout_estimate_captured'",
  "'ambiguous'",
  'expectedBlocker',
  'crm_organizations',
]) {
  assertIncludes(persistence, contract, 'regression replay persistence')
}
assertMatches(
  persistence,
  /customerMode:\s*'reuse'/,
  'fixed CRM reuse scenario',
)
assertMatches(
  persistence,
  /customerMode:\s*'new'/,
  'fixed CRM create scenario',
)
assertMatches(
  persistence,
  /customerMode:\s*'ambiguous'/,
  'fixed CRM ambiguity scenario',
)
assertMatches(
  persistence,
  /expectedFulfillmentPackages:\s*[2-9]/,
  'fixed multi-package scenario',
)
assertMatches(
  persistence,
  /provider:\s*'faire'/,
  'fixed Faire captured-estimate scenario',
)
assertMatches(
  persistence,
  /if\s*\([^)]*(?:finaliz|label)/i,
  'packing-slip persistence finalization guard',
)
assert.doesNotMatch(
  persistence,
  /from ['"]@\/lib\/integrations\/(?:ups|fedex)|from ['"]@\/lib\/operations\/carrier/i,
  'regression replay persistence must not import live carrier clients',
)

let postgresEnabled = true
const hybridCartonizationModule = loadTypeScriptModule(
  'app_src/lib/operations/hybridCartonization.ts',
)
const persistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/operationsRegressionReplay.ts',
  {
    '@/lib/operations/regressionReplay': {
      OPERATIONS_REGRESSION_REPLAY_SCHEMA_VERSION:
        'operations-regression-replay-v2',
    },
    '@/lib/operations/hybridCartonization': hybridCartonizationModule,
    '@/lib/persistence/config': {
      isPostgresStorageEnabled: () => postgresEnabled,
    },
    '@/lib/persistence/postgres': {
      acquireTransactionAdvisoryLock: async () => undefined,
      getPostgresPool: () => {
        throw new Error('Postgres must not be opened by scenario/guard checks')
      },
      withTransaction: async () => {
        throw new Error('Transactions must not start during scenario/guard checks')
      },
    },
    '@/lib/persistence/operationsRegressionArtifacts': {
      persistOperationsRegressionPackingSlipArtifactWithClient: async () => {
        throw new Error('Artifacts must not persist during scenario/guard checks')
      },
    },
  },
)

const scenarios = persistenceModule.operationsRegressionScenarios()
assert.equal(scenarios.length, 4, 'the fixed replay catalog must be bounded')
assert.deepEqual(
  Array.from(scenarios, (scenario) => scenario.id),
  [
    'shopify-finalized-multi-package',
    'shopify-successful-pre-label',
    'faire-captured-estimate',
    'shopify-ambiguous-crm',
  ],
)
assert.ok(
  scenarios.some(
    (scenario) =>
      scenario.expectedFulfillmentPackages > 1
      && scenario.customerMode === 'reuse',
  ),
  'catalog must include a multi-package CRM-reuse replay',
)
assert.doesNotMatch(
  persistence,
  /mudMarkupMinor/,
  'version-2 replay must not accept or emit a fixture MUD',
)
assert.deepEqual(
  Array.from(
    persistenceModule.verifyOperationsRegressionOptimizerFixtures(),
    (fixture) => [
      fixture.scenarioId,
      fixture.purpose,
      fixture.packageCount,
    ],
  ),
  [
    ['shopify-finalized-multi-package', 'checkout_quote', 4],
    ['shopify-finalized-multi-package', 'fulfillment_execution', 4],
    ['shopify-successful-pre-label', 'checkout_quote', 2],
    ['shopify-successful-pre-label', 'fulfillment_execution', 2],
    ['faire-captured-estimate', 'fulfillment_execution', 1],
    ['shopify-ambiguous-crm', 'checkout_quote', 1],
  ],
  'fixed replay fixtures must execute the current cartonization optimizer',
)
assert.ok(
  scenarios.some(
    (scenario) =>
      scenario.provider === 'faire'
      && scenario.checkoutSource === 'faire_checkout_estimate_captured',
  ),
  'catalog must distinguish the Faire captured-estimate boundary',
)
assert.ok(
  scenarios.some(
    (scenario) =>
      scenario.customerMode === 'ambiguous'
      && scenario.expectedFulfillmentPackages === 0,
  ),
  'catalog must include an expected CRM ambiguity blocker',
)

assert.doesNotThrow(() =>
  persistenceModule.assertOperationsRegressionReplayRuntime({
    CLAWPILOT_ENV: 'local',
  }),
)
assert.throws(
  () =>
    persistenceModule.assertOperationsRegressionReplayRuntime({
      CLAWPILOT_ENV: 'production',
    }),
  /development or preview lane/,
)
assert.throws(
  () =>
    persistenceModule.assertOperationsRegressionReplayRuntime({
      CLAWPILOT_ENV: 'dev',
      VERCEL_ENV: 'production',
    }),
  /authoritative runtime marker identifies production/,
)
assert.throws(
  () =>
    persistenceModule.assertOperationsRegressionReplayRuntime({
      CLAWPILOT_ENV: 'dev',
      RAILWAY_PROJECT_ID: 'wrong-project',
      RAILWAY_ENVIRONMENT_ID: 'wrong-environment',
    }),
  /trusted ClawPilot Railway development environment/,
)
assert.doesNotThrow(() =>
  persistenceModule.assertOperationsRegressionReplayRuntime({
    CLAWPILOT_ENV: 'dev',
    RAILWAY_PROJECT_ID: 'b5169ebd-8166-4b96-9a81-7cc8adaa9270',
    RAILWAY_ENVIRONMENT_ID: 'e4abd95f-825c-4242-b37b-825a92597e98',
  }),
)
postgresEnabled = false
assert.throws(
  () =>
    persistenceModule.assertOperationsRegressionReplayRuntime({
      CLAWPILOT_ENV: 'local',
    }),
  /requires Postgres storage/,
)
postgresEnabled = true

const route = read(
  'app_src/app/api/operations/regression-replays/route.ts',
)
for (const contract of [
  "export const dynamic = 'force-dynamic'",
  "export const runtime = 'nodejs'",
  'requireRequestUser',
  'activeOperationsOrganizationId',
  'operationsCapabilities',
  '.canManage',
  'assertOperationsRegressionReplayRuntime',
  'readOperationsRegressionWalkthroughInPostgres',
  'runOperationsRegressionReplayInPostgres',
  'idempotency-key',
  "'run-replay'",
]) {
  assertIncludes(route, contract, 'regression replay route')
}

const healthRoute = read('app_src/app/api/health/route.ts')
assertIncludes(
  healthRoute,
  '0145_operations_two_pass_pack_rate_runs.sql',
  'hosted two-pass pack-rate migration health',
)
assertIncludes(
  healthRoute,
  'operations_two_pass_pack_rate_runs_applied',
  'hosted two-pass pack-rate migration health result',
)
assertIncludes(
  healthRoute,
  '0146_operations_pack_rate_pricing_semantics.sql',
  'hosted corrected pricing-semantics migration health',
)

const predeploy = read('scripts/verify-predeploy.mjs')
for (const requiredPath of [
  'db/migrations/0145_operations_two_pass_pack_rate_runs.sql',
  'db/migrations/0146_operations_pack_rate_pricing_semantics.sql',
  'app_src/lib/operations/regressionReplay.ts',
  'app_src/lib/persistence/operationsRegressionArtifacts.ts',
  'app_src/lib/persistence/operationsRegressionReplay.ts',
  'app_src/app/api/operations/regression-replays/route.ts',
  'scripts/test-operations-regression-replay.mjs',
]) {
  assertIncludes(predeploy, requiredPath, 'predeploy regression replay registration')
}

const packageJson = JSON.parse(read('package.json'))
assert.equal(
  packageJson.scripts['test:operations-regression-replay'],
  'node scripts/test-operations-regression-replay.mjs',
)
assert.equal(
  packageJson.scripts['test:operations-regression-postgres'],
  'node scripts/test-operations-regression-replay-postgres.mjs',
)
assertIncludes(
  packageJson.scripts['test:operations'],
  'npm run test:operations-regression-artifacts',
  'operations test artifact registration',
)
assertIncludes(
  packageJson.scripts['test:operations'],
  'npm run test:operations-regression-replay',
  'operations test replay registration',
)

console.log('Operations regression replay contract checks passed.')
