#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const path = 'app_src/components/operations/ShopifyInventoryPanel.tsx'
const source = readFileSync(resolve(root, path), 'utf8')
const commerceSettings = readFileSync(
  resolve(root, 'app_src/components/settings/CommerceIntegrationPanel.tsx'),
  'utf8',
)
const settingsShell = readFileSync(
  resolve(root, 'app_src/components/settings/UserAccessDialog.tsx'),
  'utf8',
)
const warehouseSetup = readFileSync(
  resolve(root, 'app_src/components/operations/WarehouseSetupPanel.tsx'),
  'utf8',
)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

const output = ts.transpileModule(source, {
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

for (const contract of [
  'aria-label="Shopify location routing"',
  'Shopify location',
  'ClawPilot route',
  'Merchant managed',
  'Provider / app managed',
  'Map existing',
  'Change route',
  'Create ClawPilot warehouse',
  'Create warehouse and route',
  'Warehouse timezone',
  'RESERVE-01',
  'Refresh this',
  'View import',
  'Create warehouse',
  "window.location.hash = '#operations/warehouses'",
  'Inventory import is Shopify → ClawPilot and makes zero Shopify',
  'Provider / app-managed fulfillment-service locations remain',
]) {
  assert.ok(source.includes(contract), `Missing location-routing UI contract: ${contract}`)
}

assert.match(
  source,
  /if \(mappingGlobalId\) params\.set\('mappingGlobalId', mappingGlobalId\)/,
  'Selected import details must load the exact location mapping',
)
assert.match(
  source,
  /location\.mappingEligible === true && !fulfillmentService/,
  'Only eligible merchant-managed locations may expose mapping controls',
)
assert.match(
  source,
  /mappingEligible \? \([\s\S]{0,500}'Map existing'/,
  'Map-existing must remain behind the server-projected eligibility gate',
)

for (const mapField of [
  "action: 'map-location'",
  'accountGlobalId,',
  'externalLocationId: mappingLocation.id',
  'warehouseGlobalId: mappingWarehouseGlobalId',
  'locationGlobalId: mappingInternalLocationGlobalId',
  'mappingGlobalId: current?.globalId || null',
  'expectedRowVersion: current?.rowVersion ?? null',
  'idempotencyKey: requestIdempotencyKey',
]) {
  assert.ok(source.includes(mapField), `Map-location payload is missing ${mapField}`)
}
assert.match(
  source,
  /payload\.providerWrites !== 0/,
  'Mapping must fail closed unless the server confirms zero Shopify writes',
)

for (const syncField of [
  "action: 'sync'",
  'mappingGlobalId: mapping.globalId',
  'expectedMappingRowVersion: mapping.rowVersion',
  'idempotencyKey: requestIdempotencyKey',
]) {
  assert.ok(source.includes(syncField), `Exact-location refresh is missing ${syncField}`)
}
assert.match(source, /syncIdempotencyKeys\.current\.get\(mapping\.globalId\)/)
assert.match(source, /mappingIdempotencyKeys\.current\.get\(`map:\$\{mappingLocation\.id\}`\)/)

for (const createField of [
  "action: 'create-warehouse-and-map'",
  'externalLocationId: mappingLocation.id',
  'code: warehouseImport.code.trim()',
  'name: warehouseImport.name.trim()',
  'facilityType: warehouseImport.facilityType',
  'timezone: warehouseImport.timezone',
  'idempotencyKey: requestIdempotencyKey',
]) {
  assert.ok(
    source.includes(createField),
    `Create-warehouse payload is missing ${createField}`,
  )
}
assert.match(source, /mappingIdempotencyKeys\.current\.get\(key\)/)

for (const forbiddenProviderWriteControl of [
  'inventorySetQuantities',
  'inventoryAdjustQuantities',
  "action: 'locationAdd'",
  "action: 'locationEdit'",
  'Write inventory to Shopify',
]) {
  assert.ok(
    !source.includes(forbiddenProviderWriteControl),
    `Phase A UI must not expose provider write control: ${forbiddenProviderWriteControl}`,
  )
}

for (const setupContract of [
  'Fulfillment locations &amp; warehouses',
  'Configure locations',
  "'#operations/imports'",
]) {
  assert.ok(
    commerceSettings.includes(setupContract),
    `Shopify setup is missing location-routing entry point: ${setupContract}`,
  )
}
assert.match(commerceSettings, /onNavigate\('#operations\/imports'\)/)
assert.match(
  settingsShell,
  /onNavigate=\{\(hash\) => \{[\s\S]{0,120}onClose\(\)[\s\S]{0,120}window\.location\.hash = hash/,
  'The Settings entry point must close before navigating to location setup',
)

for (const warehouseEntryContract of [
  'Create warehouse',
  'From a connected sales channel',
  'Enter warehouse manually',
  "onNavigate('imports')",
  'create the standard ClawPilot warehouse topology from it',
]) {
  assert.ok(
    warehouseSetup.includes(warehouseEntryContract),
    `Warehouse setup is missing sales-channel entry contract: ${warehouseEntryContract}`,
  )
}

console.log('Shopify inventory location-routing UI checks passed.')
