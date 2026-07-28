#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadDomain() {
  const path = 'app_src/lib/operations/packagingMaterials.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Error,
    Map,
    Math,
    Number,
    Object,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    require: requireFromApp,
  }, { filename: path })
  return module.exports
}

const {
  PACKAGING_MATERIAL_TYPES,
  STARTER_PACKAGING_MATERIALS,
  packagingMaterialReadiness,
} = loadDomain()

assert.deepEqual(
  Array.from(PACKAGING_MATERIAL_TYPES),
  ['carton', 'poly_mailer', 'padded_mailer'],
)
assert.equal(STARTER_PACKAGING_MATERIALS.length, 6)
assert.equal(
  new Set(STARTER_PACKAGING_MATERIALS.map((material) => material.code)).size,
  STARTER_PACKAGING_MATERIALS.length,
)
for (const starter of STARTER_PACKAGING_MATERIALS) {
  assert.equal(starter.status, 'draft')
  assert.equal(starter.source, 'starter_assortment')
  assert.equal(starter.unitCostMinor, null)
  assert.equal(starter.currency, null)
  assert.ok(starter.innerLengthMm > 0)
  assert.ok(starter.innerWidthMm > 0)
  assert.ok(starter.innerHeightMm > 0)
  assert.ok(starter.tareWeightGrams > 0)
  assert.ok(starter.maxWeightGrams > starter.tareWeightGrams)
}

assert.deepEqual(
  Array.from(packagingMaterialReadiness({
    status: 'draft',
    unitCostMinor: null,
    stock: [],
  }).missing),
  ['unit_cost', 'warehouse_stock'],
)
assert.equal(packagingMaterialReadiness({
  status: 'active',
  unitCostMinor: 35,
  stock: [{
    warehouseStatus: 'active',
    isAvailable: true,
    onHandQuantity: 20,
  }],
}).eligibleForCartonization, true)
assert.deepEqual(
  Array.from(packagingMaterialReadiness({
    status: 'active',
    unitCostMinor: 35,
    stock: [{
      warehouseStatus: 'active',
      isAvailable: true,
      onHandQuantity: 0,
    }],
  }).missing),
  ['available_stock'],
)

const migration = read('db/migrations/0123_operations_packaging_materials.sql')
for (const fragment of [
  "('gmat', 'operations.packaging_material'",
  "('gmas', 'operations.packaging_material_stock'",
  'operations_packaging_materials',
  'operations_packaging_material_stock',
  "material_type IN ('carton', 'poly_mailer', 'padded_mailer')",
  'inner_length_mm integer NOT NULL',
  'tare_weight_grams integer NOT NULL',
  'unit_cost_minor bigint',
  "status IN ('draft', 'active')",
  'is_available boolean NOT NULL DEFAULT false',
  'on_hand_quantity integer',
  'reorder_point_quantity integer',
  'reorder_to_quantity integer',
  'row_version bigint NOT NULL DEFAULT 0',
]) {
  assert.ok(migration.includes(fragment), `Migration missing ${fragment}`)
}

const persistence = read('app_src/lib/persistence/packagingMaterials.ts')
for (const fragment of [
  'readPackagingMaterialsWorkspaceFromPostgres',
  'savePackagingMaterialInPostgres',
  'savePackagingMaterialStockInPostgres',
  'createStarterPackagingAssortmentInPostgres',
  'operations_command_receipts',
  'PACKAGING_MATERIAL_STARTER_CODE_CONFLICT',
  "starterRow.source !== 'starter_assortment'",
  'PACKAGING_MATERIAL_VERSION_CONFLICT',
  'PACKAGING_MATERIAL_STOCK_VERSION_CONFLICT',
  'eligible_shipped_demand_sample_count',
  'missing_product_dimension_count',
  'missing_material_cost_count',
  'missing_warehouse_stock_count',
  'reorder_due_count',
  'CROSS JOIN operations_warehouses warehouse',
  "warehouse.status = 'active'",
]) {
  assert.ok(persistence.includes(fragment), `Persistence missing ${fragment}`)
}
assert.equal(
  persistence.includes('INSERT INTO operations_warehouses'),
  false,
  'Packaging material setup must never synthesize a warehouse',
)

const route = read('app_src/app/api/operations/packaging-materials/route.ts')
for (const fragment of [
  'requireRequestUser(req)',
  'activeOperationsOrganizationId(actor)',
  'operationsCapabilities(actor)',
  "action === 'save-material'",
  "action === 'save-stock'",
  "action === 'create-starter-assortment'",
  'PACKAGING_MATERIAL_MANAGE_REQUIRED',
  'Idempotency-Key header is required',
]) {
  assert.ok(route.includes(fragment), `API route missing ${fragment}`)
}

const panel = read('app_src/components/operations/PackagingMaterialsPanel.tsx')
for (const fragment of [
  'Optimizer readiness',
  'Create starter assortment',
  'Add material',
  'Activate material',
  'Edit stock',
  'Products missing dimensions',
  'Warehouse stock gaps',
  'verify against the selected supplier',
]) {
  assert.ok(panel.includes(fragment), `Packaging materials panel missing ${fragment}`)
}

const operationsSection = read('app_src/components/operations/OperationsSection.tsx')
const navigation = read('app_src/components/Navigation.tsx')
const home = read('app_src/app/HomeClient.tsx')
for (const source of [operationsSection, navigation, home]) {
  assert.ok(source.includes('packaging-materials'))
}

const health = read('app_src/app/api/health/route.ts')
for (const fragment of [
  "WHERE filename = '0123_operations_packaging_materials.sql'",
  'row?.operations_packaging_materials_migration_applied',
]) {
  assert.ok(health.includes(fragment), `Health migration gate missing ${fragment}`)
}
const predeploy = read('scripts/verify-predeploy.mjs')
for (const fragment of [
  "'db/migrations/0123_operations_packaging_materials.sql'",
  "'scripts/test-operations-packaging-materials.mjs'",
]) {
  assert.ok(predeploy.includes(fragment), `Predeploy gate missing ${fragment}`)
}

console.log('Operations packaging materials contracts passed')
