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
  assert.equal(
    runtime.blockerCode,
    'SHOPIFY_ORDER_PRODUCTION_RAILWAY_IDENTITY_MISMATCH',
  )
}

const exactProduction = {
  CLAWPILOT_ENV: 'production',
  RAILWAY_ENVIRONMENT_NAME: 'production',
  RAILWAY_PROJECT_ID: 'b5169ebd-8166-4b96-9a81-7cc8adaa9270',
  RAILWAY_SERVICE_ID: 'f3fdf47c-6645-42ff-9a28-52843f8e4da2',
  RAILWAY_ENVIRONMENT_ID: '058ce52f-1d3b-44bb-afe2-0df2bf24efb9',
}

{
  const runtime = load(exactProduction).shopifyOrderManagementRuntime()
  assert.equal(runtime.available, false)
  assert.equal(runtime.blockerCode, 'SHOPIFY_ORDER_PRODUCTION_WRITES_DISABLED')
}

{
  const loaded = load({
    ...exactProduction,
    CLAWPILOT_SHOPIFY_ORDER_PRODUCTION_WRITES_ENABLED: '1',
    CLAWPILOT_SHOPIFY_ORDER_PRODUCTION_WRITE_ACCOUNT_IDS: 'gia9286799',
  })
  const runtime = loaded.shopifyOrderManagementRuntime()
  assert.equal(runtime.available, true)
  assert.equal(runtime.mode, 'production')
  assert.equal(runtime.productionAvailable, true)
  assert.equal(
    loaded.shopifyOrderManagementAccountAllowed(
      'gia9286799',
      'production',
    ),
    true,
  )
  assert.equal(
    loaded.shopifyOrderManagementAccountAllowed('gia9286799', 'sandbox'),
    false,
  )
}

{
  const runtime = load({
    ...exactProduction,
    VERCEL: '1',
    CLAWPILOT_SHOPIFY_ORDER_PRODUCTION_WRITES_ENABLED: '1',
    CLAWPILOT_SHOPIFY_ORDER_PRODUCTION_WRITE_ACCOUNT_IDS: 'gia9286799',
  }).shopifyOrderManagementRuntime()
  assert.equal(runtime.available, false)
  assert.equal(runtime.blockerCode, 'SHOPIFY_ORDER_TEST_WRITES_RAILWAY_OR_LOCAL_ONLY')
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
  assert.equal(
    valid.shopifyOrderManagementAccountAllowed('GIA9286799', 'production'),
    false,
  )
  assert.equal(valid.shopifyOrderManagementAccountAllowed('gia7654321'), false)
}

console.log('Shopify order-management runtime contracts passed')
