#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const path = 'app_src/lib/integrations/shopifyLocationAdministrationRuntime.ts'
const output = ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: path,
}).outputText

function load(env) {
  const module = { exports: {} }
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
    Object,
    RegExp,
    Set,
    String,
    process: { env: { ...env } },
  }, { filename: path })
  return module.exports
}

const base = {
  CLAWPILOT_ENV: 'development',
  RAILWAY_ENVIRONMENT_NAME: 'development',
  RAILWAY_PROJECT_ID: 'b5169ebd-8166-4b96-9a81-7cc8adaa9270',
  RAILWAY_SERVICE_ID: 'f3fdf47c-6645-42ff-9a28-52843f8e4da2',
  RAILWAY_ENVIRONMENT_ID: 'e4abd95f-825c-4242-b37b-825a92597e98',
  CLAWPILOT_SHOPIFY_LOCATION_ADMINISTRATION_ENABLED: '1',
  CLAWPILOT_SHOPIFY_LOCATION_ADMINISTRATION_ACCOUNT_IDS: 'gia2890001',
}

{
  const runtime = load({ ...base, CLAWPILOT_ENV: 'production' })
    .shopifyLocationAdministrationRuntime()
  assert.equal(runtime.available, false)
  assert.equal(
    runtime.blockerCode,
    'SHOPIFY_LOCATION_ADMINISTRATION_DEVELOPMENT_ONLY',
  )
}

{
  const runtime = load({ ...base, NODE_ENV: 'production' })
    .shopifyLocationAdministrationRuntime()
  assert.equal(
    runtime.available,
    true,
    'Railway development uses a production-optimized Next.js runtime',
  )
}

{
  const runtime = load({ ...base, VERCEL: '1' })
    .shopifyLocationAdministrationRuntime()
  assert.equal(runtime.available, false)
  assert.equal(
    runtime.blockerCode,
    'SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_ONLY',
  )
}

{
  const runtime = load({
    CLAWPILOT_ENV: 'development',
    CLAWPILOT_SHOPIFY_LOCATION_ADMINISTRATION_ENABLED: '1',
    CLAWPILOT_SHOPIFY_LOCATION_ADMINISTRATION_ACCOUNT_IDS: 'gia2890001',
  }).shopifyLocationAdministrationRuntime()
  assert.equal(runtime.available, false)
  assert.equal(
    runtime.blockerCode,
    'SHOPIFY_LOCATION_ADMINISTRATION_DEVELOPMENT_ONLY',
    'a local shell cannot opt itself into the hosted provider-write lane',
  )
}

{
  const runtime = load({
    ...base,
    RAILWAY_ENVIRONMENT_ID: '058ce52f-1d3b-44bb-afe2-0df2bf24efb9',
  }).shopifyLocationAdministrationRuntime()
  assert.equal(runtime.available, false)
  assert.equal(
    runtime.blockerCode,
    'SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_IDENTITY_MISMATCH',
  )
}

{
  const runtime = load({
    ...base,
    RAILWAY_SERVICE_ID: '00000000-0000-4000-8000-000000000000',
  }).shopifyLocationAdministrationRuntime()
  assert.equal(runtime.available, false)
  assert.equal(
    runtime.blockerCode,
    'SHOPIFY_LOCATION_ADMINISTRATION_RAILWAY_IDENTITY_MISMATCH',
  )
}

{
  const runtime = load({
    ...base,
    CLAWPILOT_SHOPIFY_LOCATION_ADMINISTRATION_ENABLED: '0',
  }).shopifyLocationAdministrationRuntime()
  assert.equal(runtime.available, false)
  assert.equal(
    runtime.blockerCode,
    'SHOPIFY_LOCATION_ADMINISTRATION_DISABLED',
  )
}

{
  const loaded = load({
    ...base,
    CLAWPILOT_SHOPIFY_LOCATION_ADMINISTRATION_ACCOUNT_IDS:
      'gia2890001,GIA2890002,gia2890001',
  })
  const runtime = loaded.shopifyLocationAdministrationRuntime()
  assert.equal(runtime.available, true)
  assert.equal(runtime.mode, 'development')
  assert.equal(runtime.providerWritesEnabled, true)
  assert.equal(runtime.productionAvailable, false)
  assert.equal(runtime.railwayIdentityMatched, true)
  assert.deepEqual(
    [...runtime.allowedAccountGlobalIds],
    ['gia2890001', 'gia2890002'],
  )
  assert.equal(
    loaded.shopifyLocationAdministrationAccountAllowed('GIA2890002'),
    true,
  )
  assert.equal(
    loaded.shopifyLocationAdministrationAccountAllowed('gia2899999'),
    false,
  )
}

console.log('Shopify location-administration runtime fences passed')
