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

withEnvironment({ CLAWPILOT_ENV: 'production' }, () => {
  assert.equal(runtime.commerceReadRuntimeAvailable(), false)
  assert.equal(runtime.commerceReadRuntimeMode(), null)
  assert.equal(
    runtime.commerceReadAccountSql('account'),
    "(account.status = 'active' AND account.environment = 'production')",
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
    runtime.commerceReadAccountSql('account'),
    "(account.status = 'active' AND account.environment = 'production')",
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.commerceReadRuntimeSummary())),
    {
      available: true,
      mode: 'production',
      providerWrites: 0,
      productionAccountPolicy: 'active_verified_production_only',
      productionTestOrdersAllowed: false,
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
assert.ok(health.includes("commerceReadAccountSql('account')"))
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
