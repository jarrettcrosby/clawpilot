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

function loadShopifyPackagingImport() {
  const path = 'app_src/lib/operations/shopifyPackagingImport.ts'
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
    Buffer,
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
  PACKAGING_DIMENSION_BASES,
  PACKAGING_DIMENSION_EVIDENCE_TYPES,
  PACKAGING_MATERIAL_SOURCES,
  PACKAGING_MATERIAL_TYPES,
  STARTER_PACKAGING_MATERIALS,
  packagingDimensionEvidenceReady,
  packagingDimensionEvidenceReferenceRequired,
  packagingMaterialReadiness,
} = loadDomain()
const {
  SHOPIFY_PACKAGING_IMPORT_HEADERS,
  SHOPIFY_PACKAGING_IMPORT_TEMPLATE,
  parseShopifyPackagingImportCsv,
} = loadShopifyPackagingImport()

function expectImportError(csv, code) {
  assert.throws(
    () => parseShopifyPackagingImportCsv(csv),
    (error) => error?.code === code,
  )
}

assert.deepEqual(
  Array.from(PACKAGING_MATERIAL_TYPES),
  ['carton', 'poly_mailer', 'padded_mailer'],
)
assert.deepEqual(
  Array.from(PACKAGING_DIMENSION_BASES),
  ['inner', 'outer', 'unspecified'],
)
assert.ok(PACKAGING_DIMENSION_EVIDENCE_TYPES.includes('customer_confirmed'))
assert.equal(packagingDimensionEvidenceReferenceRequired('measured'), false)
assert.equal(packagingDimensionEvidenceReferenceRequired('provider'), true)
assert.equal(
  packagingDimensionEvidenceReferenceRequired('customer_confirmed'),
  true,
)
assert.ok(PACKAGING_MATERIAL_SOURCES.includes('customer_supplied'))
assert.ok(PACKAGING_MATERIAL_SOURCES.includes('shopify_import'))
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
  assert.equal(starter.dimensionBasis, 'inner')
  assert.equal(starter.dimensionEvidenceType, 'legacy')
  assert.ok(starter.innerLengthMm > 0)
  assert.ok(starter.innerWidthMm > 0)
  assert.ok(starter.innerHeightMm > 0)
  assert.ok(starter.tareWeightGrams > 0)
  assert.ok(starter.maxWeightGrams > starter.tareWeightGrams)
  assert.equal(
    /\b(?:in|inch|inches|mm|cm)\b/i.test(starter.name),
    false,
    'Starter names must remain measurement-system neutral',
  )
}

assert.deepEqual(
  Array.from(packagingMaterialReadiness({
    status: 'draft',
    unitCostMinor: null,
    stock: [],
  }).missing),
  ['unit_cost', 'warehouse_stock'],
)

assert.equal(SHOPIFY_PACKAGING_IMPORT_HEADERS.join(','), [
  'shopify_package_id',
  'code',
  'name',
  'type',
  'length',
  'width',
  'height',
  'length_unit',
  'empty_weight',
  'weight_unit',
  'is_default',
].join(','))
const shopifyPreview = parseShopifyPackagingImportCsv(
  SHOPIFY_PACKAGING_IMPORT_TEMPLATE,
)
assert.equal(shopifyPreview.totalCount, 1)
assert.equal(shopifyPreview.defaultCount, 1)
assert.equal(shopifyPreview.providerListApiAvailable, false)
assert.equal(shopifyPreview.createsDraftsOnly, true)
assert.equal(shopifyPreview.providerWrites, 0)
assert.equal(shopifyPreview.rows[0].code, 'CYL5505BK')
assert.equal(shopifyPreview.rows[0].materialType, 'carton')
assert.equal(shopifyPreview.rows[0].ratedOuterLengthMm, 483)
assert.equal(shopifyPreview.rows[0].ratedOuterWidthMm, 305)
assert.equal(shopifyPreview.rows[0].ratedOuterHeightMm, 305)
assert.equal(shopifyPreview.rows[0].tareWeightGrams, 454)
assert.match(shopifyPreview.fileSha256, /^[0-9a-f]{64}$/)
const importHeader = `${SHOPIFY_PACKAGING_IMPORT_HEADERS.join(',')}\n`
expectImportError(
  `name,code\nPackage,PKG\n`,
  'SHOPIFY_PACKAGING_IMPORT_HEADERS_INVALID',
)
expectImportError(
  `${importHeader},DUP,First,BOX,1,1,1,INCHES,1,POUNDS,true\n,DUP,Second,BOX,1,1,1,INCHES,1,POUNDS,false\n`,
  'SHOPIFY_PACKAGING_IMPORT_CODE_CONFLICT',
)
expectImportError(
  `${importHeader},ONE,First,BOX,1,1,1,INCHES,1,POUNDS,true\n,TWO,Second,BOX,1,1,1,INCHES,1,POUNDS,true\n`,
  'SHOPIFY_PACKAGING_IMPORT_DEFAULT_CONFLICT',
)
expectImportError(
  `${importHeader}gid://shopify/ShippingPackage/nope,ONE,First,BOX,1,1,1,INCHES,1,POUNDS,false\n`,
  'SHOPIFY_PACKAGING_IMPORT_PACKAGE_ID_INVALID',
)
expectImportError(
  `${importHeader},ONE,First,TUBE,1,1,1,INCHES,1,POUNDS,false\n`,
  'SHOPIFY_PACKAGING_IMPORT_TYPE_INVALID',
)
expectImportError(
  `${importHeader},ONE,First,BOX,1,1,1,FEET,1,POUNDS,false\n`,
  'SHOPIFY_PACKAGING_IMPORT_LENGTH_UNIT_INVALID',
)
assert.deepEqual(
  Array.from(packagingMaterialReadiness({
    status: 'draft',
    innerDimensionsMm: {
      length: 305,
      width: 229,
      height: null,
    },
    dimensionBasis: 'unspecified',
    dimensionEvidenceType: 'customer_confirmed',
    dimensionEvidenceReference: 'Customer supplied partial dimensions',
    dimensionConfirmedAt: '2026-08-21T12:00:00.000Z',
    tareWeightGrams: null,
    maxWeightGrams: null,
    unitCostMinor: null,
    stock: [],
  }).missing),
  [
    'dimensions',
    'dimension_basis',
    'tare_weight',
    'max_weight',
    'unit_cost',
    'warehouse_stock',
  ],
)
const providerEvidenceReadiness = {
  status: 'active',
  innerDimensionsMm: {
    length: 1727,
    width: 356,
    height: 102,
  },
  dimensionBasis: 'inner',
  dimensionEvidenceType: 'provider',
  dimensionEvidenceReference: 'https://supplier.example.test/snowboard-carton',
  dimensionConfirmedAt: '2026-08-21T12:00:00.000Z',
  tareWeightGrams: 1606,
  maxWeightGrams: 13608,
  unitCostMinor: 1131,
  stock: [{
    warehouseStatus: 'active',
    isAvailable: true,
    onHandQuantity: 100,
  }],
}
const measuredEvidenceReadiness = {
  ...providerEvidenceReadiness,
  dimensionEvidenceType: 'measured',
  dimensionEvidenceReference: null,
}
assert.equal(
  packagingDimensionEvidenceReady({
    evidenceType: measuredEvidenceReadiness.dimensionEvidenceType,
    evidenceReference: measuredEvidenceReadiness.dimensionEvidenceReference,
    confirmedAt: measuredEvidenceReadiness.dimensionConfirmedAt,
  }),
  true,
  'Exact measured evidence is retained by its dimensions, actor, and timestamp without a redundant note',
)
assert.equal(
  packagingMaterialReadiness(measuredEvidenceReadiness)
    .eligibleForCartonization,
  true,
  'Timestamped measured evidence must not require a free-form reference',
)
assert.equal(
  packagingMaterialReadiness({
    ...measuredEvidenceReadiness,
    dimensionConfirmedAt: null,
  }).eligibleForCartonization,
  false,
  'Measured evidence still requires its retained confirmation timestamp',
)
assert.equal(
  packagingMaterialReadiness({
    ...measuredEvidenceReadiness,
    innerDimensionsMm: {
      ...measuredEvidenceReadiness.innerDimensionsMm,
      height: 0,
    },
  }).eligibleForCartonization,
  false,
  'Measured readiness still requires exact positive dimensions',
)
assert.equal(
  packagingMaterialReadiness(providerEvidenceReadiness)
    .eligibleForCartonization,
  true,
  'Timestamped provider evidence must be eligible for cartonization',
)
for (const incompleteProviderEvidence of [
  {
    ...providerEvidenceReadiness,
    dimensionEvidenceReference: null,
  },
  {
    ...providerEvidenceReadiness,
    dimensionConfirmedAt: null,
  },
  {
    ...providerEvidenceReadiness,
    dimensionConfirmedAt: 'not-a-timestamp',
  },
]) {
  const readiness = packagingMaterialReadiness(incompleteProviderEvidence)
  assert.equal(readiness.eligibleForCartonization, false)
  assert.deepEqual(
    Array.from(readiness.missing),
    ['dimension_evidence'],
    'Provider evidence without a retained reference and valid timestamp must fail closed',
  )
}
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

const unitNeutralMigration = read(
  'db/migrations/0126_packaging_material_unit_neutral_names.sql',
)

const packHierarchyMigration = read(
  'db/migrations/0128_operations_pack_hierarchy.sql',
)
const packRuntimeAssociationMigration = read(
  'db/migrations/0133_operations_pack_runtime_association.sql',
)
const measuredEvidenceMigration = read(
  'db/migrations/0309_operations_measured_packaging_evidence.sql',
)
for (const fragment of [
  'ALTER COLUMN inner_length_mm DROP NOT NULL',
  "dimension_basis IN ('inner', 'outer', 'unspecified')",
  "'customer_supplied', 'csv_import'",
  'Drafts may retain incomplete customer facts',
  'operations_product_pack_profiles',
  'operations_product_pack_relationships',
  'operations_approved_pack_recipes',
]) {
  assert.ok(
    packHierarchyMigration.includes(fragment),
    `Pack hierarchy migration missing ${fragment}`,
  )
}
for (const fragment of [
  'operations_packaging_materials_dimension_evidence_valid',
  "dimension_evidence_type <> 'measured'",
  "dimension_evidence_type NOT IN ('customer_confirmed', 'provider')",
  "material.dimension_evidence_type = 'measured'",
  'inner_length_mm > 0',
  'dimension_confirmed_at IS NOT NULL',
  'NOT VALID',
  'CREATE OR REPLACE FUNCTION public.validate_operations_approved_pack_recipe()',
  'SET search_path = pg_catalog, public, pg_temp',
  'FROM public.operations_packaging_materials AS material',
]) {
  assert.ok(
    measuredEvidenceMigration.includes(fragment),
    `Measured evidence migration missing ${fragment}`,
  )
}
for (const fragment of [
  'operations_packaging_materials_dimension_evidence_valid',
  "dimension_evidence_type NOT IN ('customer_confirmed', 'measured')",
  'dimension_evidence_reference IS NOT NULL',
]) {
  assert.ok(
    packRuntimeAssociationMigration.includes(fragment),
    `Pack runtime association migration missing ${fragment}`,
  )
}
for (const fragment of [
  "material.source = 'starter_assortment'",
  'material.code = correction.code',
  'material.name = correction.previous_name',
  'row_version = material.row_version + 1',
  "'Compact starter carton'",
  "'Starter padded mailer'",
]) {
  assert.ok(
    unitNeutralMigration.includes(fragment),
    `Unit-neutral starter migration missing ${fragment}`,
  )
}

const persistence = read('app_src/lib/persistence/packagingMaterials.ts')
for (const fragment of [
  'readPackagingMaterialsWorkspaceFromPostgres',
  'savePackagingMaterialInPostgres',
  'savePackagingMaterialStockInPostgres',
  'createStarterPackagingAssortmentInPostgres',
  'operations_command_receipts',
  'PACKAGING_MATERIAL_STARTER_CODE_CONFLICT',
  'PACKAGING_MATERIAL_STARTER_REPLAY_STALE',
  '${createdReceipt.rows[0].id}',
  "starterRow.source !== 'starter_assortment'",
  'PACKAGING_MATERIAL_VERSION_CONFLICT',
  'PACKAGING_MATERIAL_STOCK_VERSION_CONFLICT',
  'PACKAGING_MATERIAL_STOCK_ACTIVE_CLAIMS_CONFLICT',
  'eligible_shipped_demand_sample_count',
  'missing_product_dimension_count',
  'missing_material_cost_count',
  'missing_warehouse_stock_count',
  'reorder_due_count',
  'CROSS JOIN operations_warehouses warehouse',
  "warehouse.status = 'active'",
  'dimension_evidence_reference',
  'dimension_confirmed_at',
  "WHEN $15 <> 'unknown'",
  'dimension_evidence_reference IS DISTINCT FROM $16',
  'evidence_ready',
  'THEN $22',
  'input.material.dimensionBasis',
  'input.material.source',
  'removePackagingMaterialInPostgres',
  'importShopifyPackagingMaterialsInPostgres',
  'PACKAGING_MATERIAL_ACTIVE_CLAIMS_CONFLICT',
  "outcome: 'deleted' | 'retired'",
  "status = 'retired'",
  "'shopify_import', $11::uuid",
  'providerListApiAvailable: false',
  'providerReads: 0',
  'providerWrites: 0',
  'PACKAGING_MATERIAL_SOURCE_IMMUTABLE',
  'PACKAGING_MATERIAL_SHOPIFY_CODE_IMMUTABLE',
  'SHOPIFY_PACKAGING_IMPORT_SOURCE_CONFLICT',
  "row.source === 'shopify_import'",
]) {
  assert.ok(persistence.includes(fragment), `Persistence missing ${fragment}`)
}
const canonicalPlanningMigration = read(
  'db/migrations/0176_operations_canonical_fulfillment_planning.sql',
)
for (const fragment of [
  'validate_ops_packaging_material_claim',
  'validate_ops_packaging_stock_active_claims',
  'Packaging material stock cannot fall below active plan claims',
  'successful shipment confirmation atomically consumes each claim',
]) {
  assert.ok(
    canonicalPlanningMigration.includes(fragment),
    `Canonical packaging-claim migration missing ${fragment}`,
  )
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
  'PACKAGING_MATERIAL_PHYSICAL_FACTS_REQUIRED',
  'PACKAGING_MATERIAL_EVIDENCE_REQUIRED',
  'dimensionEvidenceReference',
  "['customer_confirmed', 'provider'].includes(dimensionEvidenceType)",
  "dimensionEvidenceType === 'measured'",
  'Measured evidence requires exact positive length, width, and height',
  "action === 'remove-material'",
  'idempotencyKey: idempotencyKey(req)',
  'Use Remove material to retire a packaging material safely',
  'Create Shopify package materials through the verified import workflow',
]) {
  assert.ok(route.includes(fragment), `API route missing ${fragment}`)
}

const panel = read('app_src/components/operations/PackagingMaterialsPanel.tsx')
for (const fragment of [
  'Optimizer readiness',
  'Create starter assortment',
  'Add material',
  'Activate material',
  'Finish setup',
  'Needed before activation:',
  'openActivationSetup',
  'Edit stock',
  'Products missing dimensions',
  'Warehouse stock gaps',
  'verify against the selected supplier',
  'Record only the measurements the customer or supplier actually supplied',
  'You may save an incomplete draft',
  'Customer-supplied draft',
  'Import Shopify packages',
  'Import Shopify saved packages',
  'Download CSV template',
  'Remove material',
  'Idempotency-Key',
  'Shopify default',
  'globalThis.crypto.randomUUID()',
  "materialDraft.dimensionEvidenceType === 'measured'",
  'exact measurements retain the confirming actor and time automatically',
  'const starterCommandKey = useRef<string | null>(null)',
  'if (terminalResponse) starterCommandKey.current = null',
  'if (terminalResponse) importCommandKey.current = null',
]) {
  assert.ok(panel.includes(fragment), `Packaging materials panel missing ${fragment}`)
}
assert.equal(
  panel.includes("'packaging-materials:starter-assortment:v1'"),
  false,
  'An intentional starter creation must not remain pinned to the first receipt',
)
assert.equal(
  panel.includes('shopify-packages:${importAccountGlobalId}:${importPreview.fileSha256}'),
  false,
  'A file hash cannot permanently pin intentional reapply commands to the first receipt',
)

const lifecycleMigration = read(
  'db/migrations/0279_operations_packaging_material_lifecycle.sql',
)
for (const fragment of [
  "status IN ('draft', 'active', 'retired')",
  "'shopify_import'",
  'operations_packaging_materials_shopify_source_valid',
  'operations_packaging_materials_shopify_source_unique',
  'operations_packaging_materials_shopify_default_unique',
  'packaging_material_source_lineage_guard',
  'packaging_material_retirement_guard',
  'retired_packaging_material_stock_guard',
  'Retired packaging materials cannot be restored by a generic update',
  'Shopify packaging import source account lineage is invalid',
  'source_file_sha256',
]) {
  assert.ok(
    lifecycleMigration.includes(fragment),
    `Packaging lifecycle migration missing ${fragment}`,
  )
}
const measuredEvidenceConsumers = [
  [
    'app_src/lib/operations/hybridCartonization.ts',
    [
      "material.dimensionEvidenceType !== 'measured'",
      'dimensionEvidenceReference: string | null',
      'option.material.dimensionEvidenceReference,',
    ],
  ],
  [
    'app_src/lib/operations/sandboxCartonizationRatePlan.ts',
    [
      "material.dimensionEvidenceType !== 'measured'",
      'materialDimensionEvidenceReference: string | null',
      'selected.material.dimensionEvidenceReference,',
    ],
  ],
  [
    'app_src/lib/persistence/hybridCartonization.ts',
    ["row.dimension_evidence_type !== 'measured'"],
  ],
  [
    'app_src/lib/persistence/shopifyCheckoutContext.ts',
    ["row.dimension_evidence_type !== 'measured'"],
  ],
  [
    'app_src/lib/persistence/productPackManagement.ts',
    ["material.dimension_evidence_type !== 'measured'"],
  ],
]
for (const [path, fragments] of measuredEvidenceConsumers) {
  const consumer = read(path)
  for (const fragment of fragments) {
    assert.ok(
      consumer.includes(fragment),
      `${path} is missing measured-evidence contract ${fragment}`,
    )
  }
}
const importRoute = read(
  'app_src/app/api/operations/packaging-materials/import/route.ts',
)
for (const fragment of [
  'SHOPIFY_PACKAGING_IMPORT_TEMPLATE',
  "['preview', 'apply']",
  'PACKAGING_MATERIAL_MANAGE_REQUIRED',
  'Idempotency-Key',
  'parseShopifyPackagingImportCsv',
  'importShopifyPackagingMaterialsInPostgres',
]) {
  assert.ok(importRoute.includes(fragment), `Shopify package import route missing ${fragment}`)
}

const operationsSection = read('app_src/components/operations/OperationsSection.tsx')
const operationalMaterialBlocker = operationsSection.slice(
  operationsSection.indexOf('function operationalPlanningMaterialBlockers('),
  operationsSection.indexOf('\nfunction metric(', operationsSection.indexOf(
    'function operationalPlanningMaterialBlockers(',
  )),
)
for (const fragment of [
  'material.innerDimensionsMm',
  "material.dimensionBasis !== 'inner'",
  'packagingDimensionEvidenceReady({',
  'evidenceType: material.dimensionEvidenceType',
  'evidenceReference: material.dimensionEvidenceReference',
  'confirmedAt: material.dimensionConfirmedAt',
  "blockers.push('factual inner evidence missing')",
]) {
  assert.ok(
    operationalMaterialBlocker.includes(fragment),
    `Order planning material selection must fail closed on ${fragment}`,
  )
}
const navigation = read('app_src/components/Navigation.tsx')
const home = read('app_src/app/HomeClient.tsx')
for (const source of [operationsSection, navigation, home]) {
  assert.ok(source.includes('packaging-materials'))
}

const health = read('app_src/app/api/health/route.ts')
for (const fragment of [
  "WHERE filename = '0123_operations_packaging_materials.sql'",
  'row?.operations_packaging_materials_migration_applied',
  "'0279_operations_packaging_material_lifecycle.sql'",
  'row?.operations_packaging_material_lifecycle_migration_applied',
]) {
  assert.ok(health.includes(fragment), `Health migration gate missing ${fragment}`)
}
const predeploy = read('scripts/verify-predeploy.mjs')
for (const fragment of [
  "'db/migrations/0123_operations_packaging_materials.sql'",
  "'db/migrations/0279_operations_packaging_material_lifecycle.sql'",
  "'db/migrations/0126_packaging_material_unit_neutral_names.sql'",
  "'db/migrations/0133_operations_pack_runtime_association.sql'",
  "'scripts/test-operations-packaging-materials.mjs'",
  "'scripts/stage-ag-alchemy-pack-hierarchy.mjs'",
]) {
  assert.ok(predeploy.includes(fragment), `Predeploy gate missing ${fragment}`)
}

const agHierarchy = read('scripts/stage-ag-alchemy-pack-hierarchy.mjs')
for (const fragment of [
  "code: 'AG12V2'",
  "code: 'AG-20LB-BOX'",
  "code: 'AG-2OZ-CARTON-BOX'",
  "code: 'AG-ENVELOPE-09X12'",
  'heightMm, null',
  "six_ounce_bag",
  "six_ounce_case_12",
  "two_ounce_bag",
  "two_ounce_display_carton",
  "relationship('customer-loose-carton-18', 'customer-each', 18)",
  "relationship('customer-loose-carton-30', 'customer-each', 30)",
  "relationship('customer-case-12', 'customer-bag-each', 12)",
  "relationship('customer-case-36', 'customer-each', 36)",
  'Exact Product Global ID assignments are required',
  'title and SKU suggestions are never applied automatically',
  'operations_commerce_variant_pack_mappings',
  'operations_product_channel_states',
  'source_revision',
  'source_hash',
  'AG_SYNTHETIC_STARTER_MATERIALS',
  'Synthetic starter material stock contains operator-maintained facts',
  'AG Alchemy packaging plan would exceed the eight-material limit',
  'Apply requires the exact current plan fingerprint from a fresh plan',
  'The explicit AG pack actor must be an active AG Alchemy owner or administrator',
  'legacyRecipeOnlyProfileUpgradeAllowed',
  "lifecycle_state = 'superseded'",
  "lifecycle_state = 'retired'",
  'legacyProfileVersionsSuperseded',
  'legacyRecipeOnlyRepairIsVersioned: true',
  'materialsRemainDraft: true',
  'inventoryNotInferred: true',
  'missingFactsNotInvented: true',
  'providerWrites: 0',
  'inventoryWrites: 0',
  'shipmentWrites: 0',
]) {
  assert.ok(agHierarchy.includes(fragment), `AG hierarchy command missing ${fragment}`)
}

console.log('Operations packaging materials contracts passed')
