#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const migration = read('db/migrations/0108_operations_slotting_and_replenishment.sql')
const types = read('app_src/lib/operations/types.ts')
const persistence = read('app_src/lib/persistence/operations.ts')
const route = read('app_src/app/api/operations/route.ts')
const panel = read('app_src/components/operations/WarehouseSetupPanel.tsx')
const health = read('app_src/app/api/health/route.ts')
const predeploy = read('scripts/verify-predeploy.mjs')
const simulation = read('scripts/seed-wms-development-simulation.mjs')

for (const fragment of [
  'ADD COLUMN IF NOT EXISTS carrier_cutoffs jsonb',
  'ADD COLUMN IF NOT EXISTS storage_function text',
  "'work_area', 'reserve', 'bulk', 'forward_pick', 'mezzanine_pick'",
  'ADD COLUMN IF NOT EXISTS replenishment_mode text',
  'replenishment_source_location_id uuid',
  'operations_location_product_rules_replenishment_thresholds_valid',
  'operations_location_product_rules_replenishment_source_not_self',
]) {
  assert.ok(migration.includes(fragment), `Slotting migration missing ${fragment}`)
}

for (const fragment of [
  'carrierCutoffs: Record<string, string>',
  "storageFunction: 'work_area' | 'reserve' | 'bulk' | 'forward_pick'",
  "replenishmentMode: 'disabled' | 'min_max' | 'order_demand'",
  'replenishmentRecommendations: Array<{',
  'inventoryPoolGlobalId: string',
  'releasedDemand: number',
]) {
  assert.ok(types.includes(fragment), `Operations workspace types missing ${fragment}`)
}

for (const fragment of [
  'carrier_cutoffs',
  'storage_function',
  'replenishmentRecommendationResult',
  "rule.replenishment_mode IN ('min_max', 'order_demand')",
  'destination_position.pool_id = source_position.pool_id',
  "demand_order.status IN ('planned', 'released', 'picking')",
  'allocation_position.pool_id = source_position.pool_id',
  "['reserve', 'bulk'].includes(source.storage_function)",
  'OPERATIONS_LOCATION_REPLENISHMENT_INVALID',
  "{ code: 'RESERVE-01'",
  "{ code: 'PICKFACE-01'",
]) {
  assert.ok(persistence.includes(fragment), `Operations persistence missing ${fragment}`)
}

for (const fragment of [
  'carrierCutoffsValue',
  "'dailyOrderCapacity', 'carrierCutoffs', 'createStarterLocations'",
  "'maxWeightKg', 'allowMixedProducts', 'storageFunction', 'notes', 'productRules'",
  'replenishmentSourceLocationGlobalId',
  'targetQuantity',
]) {
  assert.ok(route.includes(fragment), `Operations API missing ${fragment}`)
}

for (const fragment of [
  'Forward pick face',
  'Mezzanine pick face',
  'Reserve storage',
  'Min / target',
  'Released order demand',
  'Reserve source',
  'Forward-pick shortages calculated within the same inventory owner and pool.',
  'UPS trailer cutoff',
  'FedEx trailer cutoff',
  'Pick route order controls task traversal inside released waves.',
]) {
  assert.ok(panel.includes(fragment), `Warehouse setup UI missing ${fragment}`)
}

for (const fileText of [health, predeploy]) {
  assert.ok(
    fileText.includes('0108_operations_slotting_and_replenishment.sql'),
    'Migration 0108 must be required by health and predeploy checks',
  )
}

for (const fragment of [
  "const ALLOWED_ENVIRONMENTS = new Set(['dev', 'development', 'local'])",
  'WMS_SIM_ORGANIZATION_ID must be an explicitly supplied UUID',
  'UPS',
  'FEDEX',
  '21:00',
  '[DEV WMS] Synthetic Fast Mover',
  "mode: 'min_max'",
  "mode: 'order_demand'",
  'storage_function',
  'carrier_cutoffs',
  '--cleanup',
]) {
  assert.ok(simulation.includes(fragment), `Development simulation missing ${fragment}`)
}

console.log('Operations slotting, replenishment, and development-simulation contracts passed.')
