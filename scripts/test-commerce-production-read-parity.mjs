#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadRuntime() {
  const path = 'app_src/lib/integrations/commerceReadRuntime.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const diagnostics = (output.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.equal(diagnostics.length, 0)
  const loaded = { exports: {} }
  vm.runInNewContext(output.outputText, {
    exports: loaded.exports,
    module: loaded,
    process,
    Error,
    Object,
    RegExp,
    Set,
    String,
  }, { filename: path })
  return loaded.exports
}

function withEnvironment(values, callback) {
  const keys = [
    'CLAWPILOT_COMMERCE_INTAKE_ENABLED',
    'CLAWPILOT_ENV',
    'RAILWAY_ENVIRONMENT_NAME',
    'VERCEL_ENV',
    'NODE_ENV',
  ]
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  Object.assign(process.env, values)
  try {
    return callback()
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
  }
}

const runtime = loadRuntime()

function productionReadSql(alias, capability = 'orders_history') {
  return `(${alias}.status = 'active' AND (`
    + `${alias}.environment = 'production' OR (`
    + `${alias}.provider = 'shopify' AND `
    + `${alias}.integration_type = 'commerce' AND `
    + `${alias}.environment = 'sandbox' AND `
    + 'operations_commerce_hosted_production_sandbox_read_is_current('
    + `${alias}.organization_id, ${alias}.id, '${capability}'`
    + '))))'
}

function assertBalancedSqlParentheses(sql) {
  let depth = 0
  for (const character of sql) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    assert.ok(depth >= 0, 'production read SQL closes an unopened parenthesis')
  }
  assert.equal(depth, 0, 'production read SQL has an unclosed parenthesis')
}

withEnvironment({ CLAWPILOT_ENV: 'production' }, () => {
  assert.equal(runtime.commerceReadRuntimeAvailable(), false)
  assert.equal(runtime.commerceReadRuntimeMode(), null)
  assert.equal(
    runtime.commerceReadAccountSql('account'),
    productionReadSql('account'),
  )
})

withEnvironment({
  CLAWPILOT_COMMERCE_INTAKE_ENABLED: '1',
  CLAWPILOT_ENV: 'development',
}, () => {
  assert.equal(runtime.commerceReadRuntimeMode(), 'development')
  assert.equal(runtime.commerceReadCredentialEligible({
    environment: 'sandbox',
    status: 'active',
    verificationStatus: 'verified',
  }), true)
  assert.equal(runtime.commerceReadCredentialEligible({
    environment: 'sandbox',
    status: 'disabled',
    verificationStatus: 'verified',
  }), true)
  assert.equal(runtime.commerceReadCredentialEligible({
    environment: 'sandbox',
    status: 'disabled',
    verificationStatus: 'verified',
  }, { developmentRequiresActive: true }), false)
})

withEnvironment({
  CLAWPILOT_COMMERCE_INTAKE_ENABLED: '1',
  RAILWAY_ENVIRONMENT_NAME: 'production',
  NODE_ENV: 'production',
}, () => {
  assert.equal(runtime.commerceReadRuntimeMode(), 'production')
  const eligible = {
    environment: 'production',
    status: 'active',
    verificationStatus: 'verified',
  }
  assert.equal(runtime.commerceReadCredentialEligible(eligible), true)
  assert.equal(runtime.commerceReadCredentialEligible({
    ...eligible,
    environment: 'sandbox',
    hostedProductionSandboxReadCapabilities: ['catalog'],
  }, { capability: 'catalog' }), true)
  assert.equal(runtime.commerceReadCredentialEligible({
    ...eligible,
    environment: 'sandbox',
    hostedProductionSandboxReadCapabilities: ['catalog'],
  }, { capability: 'orders_history' }), false)
  for (const ineligible of [
    { ...eligible, environment: 'sandbox' },
    { ...eligible, status: 'disabled' },
    { ...eligible, status: 'error' },
    { ...eligible, verificationStatus: 'unverified' },
    { ...eligible, verificationStatus: 'failed' },
  ]) {
    assert.equal(runtime.commerceReadCredentialEligible(ineligible), false)
  }
  assert.equal(
    runtime.commerceReadAccountSql('account', { capability: 'inventory' }),
    productionReadSql('account', 'inventory'),
  )
  assertBalancedSqlParentheses(
    runtime.commerceReadAccountSql('account', { capability: 'inventory' }),
  )
  assert.throws(
    () => runtime.commerceReadAccountSql('account', { capability: 'provider_write' }),
    /capability is invalid/u,
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.commerceReadRuntimeSummary())),
    {
      available: true,
      mode: 'production',
      providerWrites: 0,
      productionAccountPolicy:
        'active_verified_production_or_exact_expiring_shopify_sandbox_read_authority',
      productionTestOrdersAllowed: false,
      productionSandboxProviderWritesAllowed: false,
      automaticOrderPromotionAvailable: false,
    },
  )
})

withEnvironment({
  CLAWPILOT_COMMERCE_INTAKE_ENABLED: '1',
  CLAWPILOT_ENV: 'development',
  RAILWAY_ENVIRONMENT_NAME: 'production',
  NODE_ENV: 'production',
}, () => {
  assert.equal(
    runtime.commerceReadRuntimeMode(),
    'production',
    'A hosted production marker must fail closed over a conflicting dev marker',
  )
})

const intake = read('app_src/lib/integrations/commerceIntake.ts')
for (const expected of [
  "return commerceReadRuntimeMode() === 'development'",
  "if (commerceReadRuntimeMode() !== 'development')",
  "return includeTestOrders ? '' : 'test:false '",
  "runtimeAuthority: 'read_reconciliation'",
  "reconciliationRead\n        && commerceReadRuntimeMode() === 'production'",
]) assert.ok(intake.includes(expected), `Missing intake fence: ${expected}`)

const orderWorker = read('app_src/lib/commerceOrderReconciliationWorker.ts')
for (const expected of [
  'commerceReadRuntimeAvailable()',
  "const productionReadOnly = commerceReadRuntimeMode?.() === 'production'",
  '&& !productionReadOnly',
  'assertReconciliationFence(command, productionReadOnly)',
]) assert.ok(orderWorker.includes(expected), `Missing order fence: ${expected}`)

for (const path of [
  'app_src/lib/persistence/commerceCatalogSync.ts',
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  'app_src/lib/persistence/shopifyInventoryRefresh.ts',
  'app_src/lib/persistence/commerceInventory.ts',
  'app_src/lib/persistence/faireInventoryPolling.ts',
  'app_src/lib/persistence/commerceProductImageImports.ts',
  'app_src/lib/persistence/commerceIntegrations.ts',
]) {
  assert.ok(
    read(path).includes('commerceReadAccountSql'),
    `${path} does not apply the production account fence`,
  )
}

for (const path of [
  'app_src/app/api/integrations/commerce/intake/cartonization-preview/route.ts',
  'app_src/app/api/integrations/commerce/intake/cartonization-rate-evidence/route.ts',
  'app_src/app/api/integrations/commerce/intake/route.ts',
]) {
  assert.ok(
    read(path).includes('assertCommerceIntakeRuntime'),
    `${path} must remain behind the development-only interactive gate`,
  )
}

assert.ok(
  read('app_src/lib/integrations/commerceIntegrations.ts')
    .includes('assertShopifyOrderPreviewRuntime()'),
  'Shopify order preview must retain its independent development-only gate',
)
for (const path of [
  'app_src/lib/integrations/commerceShopifyAutomaticPromotion.ts',
  'app_src/lib/integrations/commerceFaireAutomaticPromotion.ts',
]) {
  assert.ok(
    read(path).includes('productionVeto'),
    `${path} must keep its hosted-production veto`,
  )
}

const health = read('app_src/app/api/health/route.ts')
assert.ok(health.includes('commerceReadReconciliation'))
assert.ok(health.includes('runtimeAuthority: commerceReadReconciliation'))
for (const expected of [
  '0358_operations_hosted_production_sandbox_read_authority.sql',
  '3e99c87a322816df28a76d0e00a2001d5301f978163679f950c1be856c1b5b79',
  'AS operations_hosted_production_sandbox_read_authority_applied',
  'operations_commerce_hosted_production_sandbox_read_is_current(',
  'hostedProductionSandboxReadAuthority',
  "'expiring-soon'",
  'warningWindowDays: 14',
  'Hosted-production Shopify sandbox read authority expires within 14 days',
]) {
  assert.ok(
    health.includes(expected),
    `Health must expose hosted-production sandbox read-authority state: ${expected}`,
  )
}
for (const capability of ['catalog']) {
  assert.ok(
    health.includes(`capability: '${capability}'`),
    `Health must use the exact ${capability} read capability`,
  )
}
assert.ok(health.includes("status = 'pending' AND authoritative"))
assert.ok(health.includes("status = 'failed' AND authoritative"))
assert.match(
  health,
  /status = 'processing'\s+AND authoritative\s+AND locked_at/,
)
assert.match(
  health,
  /status IN \('pending', 'failed'\)\s+AND authoritative\s+AND available_at/,
)

console.log('Commerce production read/reconciliation parity checks passed.')
