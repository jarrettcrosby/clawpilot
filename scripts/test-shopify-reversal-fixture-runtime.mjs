#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const path = 'app_src/lib/integrations/shopifyReversalFixtureRuntime.ts'
const source = readFileSync(resolve(path), 'utf8')

function load(env, orderRuntime = { available: true }, accountAllowed = true) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Object,
    process: { env },
    exports: module.exports,
    module,
    require(specifier) {
      assert.equal(
        specifier,
        '@/lib/integrations/shopifyOrderManagementRuntime',
      )
      return {
        shopifyOrderManagementRuntime: () => orderRuntime,
        shopifyOrderManagementAccountAllowed: (accountGlobalId) => {
          assert.equal(accountGlobalId, 'giah34fedoa5b1o')
          return accountAllowed
        },
      }
    },
  }, { filename: path })
  return module.exports
}

const exactEnv = {
  CLAWPILOT_SHOPIFY_REVERSAL_FIXTURE_ENABLED: '1',
  RAILWAY_PROJECT_ID: 'b5169ebd-8166-4b96-9a81-7cc8adaa9270',
  RAILWAY_ENVIRONMENT_ID: 'e4abd95f-825c-4242-b37b-825a92597e98',
  RAILWAY_ENVIRONMENT_NAME: 'development',
}

{
  const runtime = load(exactEnv).shopifyReversalFixtureRuntime()
  assert.equal(runtime.available, true)
  assert.equal(runtime.accountGlobalId, 'giah34fedoa5b1o')
  assert.equal(runtime.routeOnly, true)
  assert.equal(runtime.normalUiAvailable, false)
  assert.equal(runtime.productionAvailable, false)
}

for (const [name, env, blocker] of [
  [
    'flag off',
    { ...exactEnv, CLAWPILOT_SHOPIFY_REVERSAL_FIXTURE_ENABLED: '0' },
    'SHOPIFY_REVERSAL_FIXTURE_DISABLED',
  ],
  [
    'wrong project',
    { ...exactEnv, RAILWAY_PROJECT_ID: 'wrong' },
    'SHOPIFY_REVERSAL_FIXTURE_RAILWAY_DEVELOPMENT_REQUIRED',
  ],
  [
    'wrong environment',
    { ...exactEnv, RAILWAY_ENVIRONMENT_ID: 'wrong' },
    'SHOPIFY_REVERSAL_FIXTURE_RAILWAY_DEVELOPMENT_REQUIRED',
  ],
  [
    'production marker',
    { ...exactEnv, RAILWAY_ENVIRONMENT_NAME: 'production' },
    'SHOPIFY_REVERSAL_FIXTURE_RAILWAY_DEVELOPMENT_REQUIRED',
  ],
  [
    'Vercel',
    { ...exactEnv, VERCEL: '1' },
    'SHOPIFY_REVERSAL_FIXTURE_RAILWAY_DEVELOPMENT_REQUIRED',
  ],
]) {
  const runtime = load(env).shopifyReversalFixtureRuntime()
  assert.equal(runtime.available, false, name)
  assert.equal(runtime.blockerCode, blocker, name)
}

assert.equal(
  load(exactEnv, { available: false }).shopifyReversalFixtureRuntime()
    .blockerCode,
  'SHOPIFY_REVERSAL_FIXTURE_ORDER_MANAGEMENT_RUNTIME_REQUIRED',
)
assert.equal(
  load(exactEnv, { available: true }, false).shopifyReversalFixtureRuntime()
    .blockerCode,
  'SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_NOT_ALLOWED',
)

console.log('Shopify reversal fixture runtime gates passed.')
