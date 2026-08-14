#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const source = readFileSync(
  'app_src/lib/integrations/shopifyOrderManagementRuntime.ts',
  'utf8',
)
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText

function load(environment) {
  const module = { exports: {} }
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
    Object,
    RegExp,
    String,
    process: { env: { ...environment } },
  }, { filename: 'shopifyOrderManagementRuntime.ts' })
  return module.exports
}

{
  const runtime = load({
    CLAWPILOT_ENV: 'production',
    CLAWPILOT_SHOPIFY_ORDER_TEST_WRITES_ENABLED: '1',
    CLAWPILOT_SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_IDS: 'gia9286799',
  }).shopifyOrderManagementRuntime()
  assert.equal(runtime.available, false)
  assert.equal(runtime.productionAvailable, false)
  assert.equal(runtime.blockerCode, 'SHOPIFY_ORDER_TEST_WRITES_DEVELOPMENT_ONLY')
}

{
  const runtime = load({
    CLAWPILOT_ENV: 'development',
    VERCEL: '1',
    CLAWPILOT_SHOPIFY_ORDER_TEST_WRITES_ENABLED: '1',
    CLAWPILOT_SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_IDS: 'gia9286799',
  }).shopifyOrderManagementRuntime()
  assert.equal(runtime.available, false)
  assert.equal(runtime.blockerCode, 'SHOPIFY_ORDER_TEST_WRITES_RAILWAY_OR_LOCAL_ONLY')
}

{
  const runtime = load({
    CLAWPILOT_ENV: 'development',
    CLAWPILOT_SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_IDS: 'gia9286799',
  }).shopifyOrderManagementRuntime()
  assert.equal(runtime.available, false)
  assert.equal(runtime.blockerCode, 'SHOPIFY_ORDER_TEST_WRITES_DISABLED')
}

{
  const runtime = load({
    CLAWPILOT_ENV: 'development',
    CLAWPILOT_SHOPIFY_ORDER_TEST_WRITES_ENABLED: '1',
    CLAWPILOT_SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_IDS: 'bad,gIA9286799',
  }).shopifyOrderManagementRuntime()
  assert.equal(runtime.available, false)
  assert.equal(runtime.blockerCode, 'SHOPIFY_ORDER_TEST_WRITE_ALLOWLIST_REQUIRED')
}

{
  const loaded = load({
    RAILWAY_ENVIRONMENT_NAME: 'development',
    CLAWPILOT_SHOPIFY_ORDER_TEST_WRITES_ENABLED: '1',
    CLAWPILOT_SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_IDS:
      'gia9286799,gIA9286799,g ia1234567',
  })
  assert.equal(loaded.shopifyOrderManagementRuntime().available, false)

  const valid = load({
    RAILWAY_ENVIRONMENT_NAME: 'development',
    CLAWPILOT_SHOPIFY_ORDER_TEST_WRITES_ENABLED: '1',
    CLAWPILOT_SHOPIFY_ORDER_TEST_WRITE_ACCOUNT_IDS:
      'gia9286799,gIA1234567,gIA9286799',
  })
  const runtime = valid.shopifyOrderManagementRuntime()
  assert.equal(runtime.available, true)
  assert.equal(runtime.mode, 'development')
  assert.deepEqual(
    [...runtime.allowedAccountGlobalIds],
    ['gia1234567', 'gia9286799'],
  )
  assert.equal(valid.shopifyOrderManagementAccountAllowed('GIA9286799'), true)
  assert.equal(valid.shopifyOrderManagementAccountAllowed('gia7654321'), false)
}

console.log('Shopify order-management runtime contracts passed')
