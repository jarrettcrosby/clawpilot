#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const componentPath =
  'app_src/components/operations/ShopifyLocationAdministrationPanel.tsx'
const parentPath = 'app_src/components/operations/ShopifyInventoryPanel.tsx'
const source = readFileSync(resolve(root, componentPath), 'utf8')
const parent = readFileSync(resolve(root, parentPath), 'utf8')
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

for (const [path, input] of [
  [componentPath, source],
  [parentPath, parent],
]) {
  const output = ts.transpileModule(input, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], `${path} must transpile without syntax errors`)
}

for (const contract of [
  '/api/integrations/commerce/shopify/location-administration',
  "body.state.runtime.available !== true",
  "body.state.runtime.providerWritesEnabled !== true",
  'if (loading || !available || !state) return null',
  'warehouse.canAddToShopify === true',
  "location.allowedActions.includes('locationEdit')",
  "location.allowedActions.includes('locationActivate')",
  '|| location.isFulfillmentService',
  'Fulfillment service · read only',
  "action: 'prepare'",
  'expectedWarehouseRowVersion: intent.warehouse.rowVersion',
  'prepareBody.mappingGlobalId = intent.mapping.globalId',
  'prepareBody.expectedMappingRowVersion = intent.mapping.rowVersion',
  'reason: intent.reason.trim()',
  'confirmationStatement: intent.confirmationStatement',
  'typedConfirmation !== intent.confirmationStatement',
  "action: 'execute'",
  'idempotencyKey: intent.idempotencyKey',
  "pending.status !== 'unknown'",
  "action: 'reconcile'",
  'attemptGlobalId: pending.attemptGlobalId',
  'Do not retry this change',
  'result?.providerLocationId || null',
  'no mapping was created automatically',
  'choose Map existing',
]) {
  assert.ok(
    source.includes(contract),
    `Missing Shopify location-administration UI contract: ${contract}`,
  )
}

assert.match(
  source,
  /const prepared = await post\(prepareBody, intent\.idempotencyKey\)[\s\S]{0,700}idempotencyKey: intent\.idempotencyKey/,
  'Prepare and execute must retain the exact same per-intent idempotency key',
)
assert.match(
  source,
  /const locationReadOnly = location\.readOnly[\s\S]{0,1500}Fulfillment service · read only/,
  'Fulfillment-service ownership must project to an explicit read-only row',
)
assert.match(
  source,
  /pending\.status === 'prepared'[\s\S]{0,800}pending\.status === 'unknown'/,
  'Prepared execution and unknown reconciliation must be separate explicit actions',
)
assert.ok(
  !source.includes('setTimeout(') && !source.includes('setInterval('),
  'Unknown or processing attempts must never be automatically retried or reconciled',
)
assert.ok(
  !source.includes('locationDeactivate')
    && !source.includes('locationDelete')
    && !source.includes('inventorySetQuantities'),
  'The UI must not expose unsupported Shopify mutations',
)

for (const integrationContract of [
  "import ShopifyLocationAdministrationPanel from '@/components/operations/ShopifyLocationAdministrationPanel'",
  '<ShopifyLocationAdministrationPanel',
  'accountGlobalId={accountGlobalId}',
  'onProviderLocationsChanged={async () => {',
  'await load()',
]) {
  assert.ok(
    parent.includes(integrationContract),
    `Shopify inventory is missing administration integration: ${integrationContract}`,
  )
}

console.log('Shopify location-administration UI checks passed.')
