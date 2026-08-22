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

function load(path) {
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
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    require: requireFromApp,
  }, { filename: path })
  return module.exports
}

const catalog = load('app_src/lib/operations/packageCatalog.ts')
const direct = load(
  'app_src/lib/integrations/carrierWholeShipmentRateFoundation.ts',
)
const wwex = load('app_src/lib/integrations/wwexSpeedshipFoundation.ts')
const rl = load('app_src/lib/integrations/rlCarriersFreightFoundation.ts')

assert.deepEqual(
  [...catalog.CANONICAL_PACKAGE_KINDS],
  ['pallet', 'box', 'envelope', 'tube', 'crate', 'custom'],
)
assert.deepEqual(
  Array.from(
    catalog.packageCatalogEntries({
      usage: 'small_parcel_package',
      includeCanonical: true,
    }),
    (entry) => entry.id,
  ),
  ['box', 'envelope', 'tube', 'crate', 'custom'],
)
assert.deepEqual(
  Array.from(
    catalog.packageCatalogEntriesForUsage('small_parcel_package'),
    (entry) => entry.id,
  ),
  ['box', 'envelope', 'tube', 'crate', 'custom'],
  'The compatibility usage helper must remain canonical-only',
)
assert.deepEqual(
  Array.from(
    catalog.packageCatalogEntries({
      usage: 'ltl_handling_unit',
      includeCanonical: true,
    }),
    (entry) => entry.id,
  ),
  ['pallet_48x40', 'pallet_48x48', 'pallet_euro', 'pallet_custom'],
)

const sorted = (values) => [...values].sort((left, right) => (
  String(left).localeCompare(String(right))
))

// Provider-scoped entries are exhaustive mirrors of adapter authority. They
// stay separate from canonical executable selectors so a newly added carrier
// package cannot silently become selectable in an unsupported workflow.
assert.deepEqual(
  sorted(catalog.packageCatalogProviderCodes({
    provider: 'ups_rest',
    usage: 'small_parcel_package',
    providerScopedOnly: true,
  })),
  sorted(Object.keys(direct.UPS_WHOLE_SHIPMENT_PACKAGING_TYPES)),
)
assert.deepEqual(
  sorted(catalog.packageCatalogProviderCodes({
    provider: 'fedex_rest',
    usage: 'small_parcel_package',
    providerScopedOnly: true,
  })),
  sorted(Object.keys(direct.FEDEX_WHOLE_SHIPMENT_PACKAGING_TYPES)),
)
assert.deepEqual(
  sorted(catalog.packageCatalogProviderCodes({
    provider: 'wwex_speedship',
    usage: 'small_parcel_package',
    providerScopedOnly: true,
  })),
  sorted(Object.keys(wwex.WWEX_SMALLPACK_PACKAGING_TYPES)),
)
assert.deepEqual(
  sorted(catalog.packageCatalogProviderCodes({
    provider: 'wwex_speedship',
    usage: 'ltl_commodity',
    providerScopedOnly: true,
  })),
  sorted(wwex.WWEX_LTL_PACKAGING_TYPES),
)
assert.deepEqual(
  Array.from(catalog.packageCatalogProviderCodes({
    provider: 'wwex_speedship',
    usage: 'ltl_handling_unit',
    providerScopedOnly: true,
  })),
  ['PLT'],
  'SpeedShip fixes the outer LTL handling unit to PLT; SKID is commodity-only',
)
assert.deepEqual(
  Array.from(catalog.packageCatalogProviderCodes({
    provider: 'rl_carriers',
    usage: 'ltl_handling_unit',
    providerScopedOnly: true,
  })),
  Array.from(rl.RL_CARRIERS_CONFIRMED_HANDLING_UNIT_TYPES),
)
assert.deepEqual(
  Array.from(catalog.packageCatalogProviderCodes({
    provider: 'rl_carriers',
    usage: 'ltl_commodity',
    providerScopedOnly: true,
  })),
  Array.from(rl.RL_CARRIERS_CONFIRMED_ITEM_PACKAGE_TYPES),
)

const directSmallParcelAdapterCodes = {
  ups_rest: new Set(Object.keys(direct.UPS_WHOLE_SHIPMENT_PACKAGING_TYPES)),
  fedex_rest: new Set(Object.keys(direct.FEDEX_WHOLE_SHIPMENT_PACKAGING_TYPES)),
  wwex_speedship: new Set(Object.keys(wwex.WWEX_SMALLPACK_PACKAGING_TYPES)),
}
const catalogAdapterTuples = []
for (const entry of catalog.CANONICAL_PACKAGE_CATALOG) {
  if (!entry.usages.includes('small_parcel_package')) continue
  for (const provider of ['ups_rest', 'fedex_rest', 'wwex_speedship']) {
    const providerPackageCode = entry.providerMappings[provider].smallParcelPackageCode
    if (!providerPackageCode) continue
    assert.ok(
      directSmallParcelAdapterCodes[provider].has(providerPackageCode),
      `${entry.id} maps ${provider} to an unsupported adapter package code`,
    )
    catalogAdapterTuples.push([
      catalog.PACKAGE_CATALOG_CONTRACT_VERSION,
      entry.id,
      provider,
      providerPackageCode,
    ].join('|'))
  }
}

const carrierSelectionMigration = read(
  'db/migrations/0275_operations_one_off_carrier_selection.sql',
)
const packageAllowlistStart = carrierSelectionMigration.indexOf(
  'CREATE OR REPLACE FUNCTION operations_one_off_package_code_matches_catalog(',
)
const packageValuesStart = carrierSelectionMigration.indexOf(
  'FROM (VALUES',
  packageAllowlistStart,
)
const packageValuesEnd = carrierSelectionMigration.indexOf(
  ') mapping(',
  packageValuesStart,
)
assert.ok(
  packageAllowlistStart >= 0
    && packageValuesStart > packageAllowlistStart
    && packageValuesEnd > packageValuesStart,
  'Migration 0275 must expose the exact package catalog allowlist',
)
const migrationPackageTuples = Array.from(
  carrierSelectionMigration
    .slice(packageValuesStart, packageValuesEnd)
    .matchAll(/\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g),
  (match) => match.slice(1).join('|'),
)
assert.equal(catalogAdapterTuples.length, 47)
assert.equal(migrationPackageTuples.length, 47)
assert.deepEqual(
  sorted(migrationPackageTuples),
  sorted(catalogAdapterTuples),
  'Migration 0275 package tuples must exactly equal catalog entries backed by adapter constants',
)

const providerScopedCatalogEntries = catalog.CANONICAL_PACKAGE_CATALOG.filter(
  (entry) => entry.providerScope !== 'canonical',
)
assert.ok(providerScopedCatalogEntries.length > 0)
for (const entry of providerScopedCatalogEntries) {
  assert.equal(
    entry.description,
    entry.label,
    `${entry.id} must expose one concise common package name`,
  )
  assert.doesNotMatch(
    `${entry.label} ${entry.description}`,
    /(?:\bUPS\b|\bFedEx\b|Worldwide Express|WWEX|R\+L|provider|catalog|\bcode\b)/i,
    `${entry.id} must keep provider attribution and raw codes internal`,
  )
}

const selectableDirectParcelEntries = catalog.packageCatalogEntries({
  usage: 'small_parcel_package',
  includeCanonical: true,
})
assert.ok(selectableDirectParcelEntries.length > 0)
for (const entry of selectableDirectParcelEntries) {
  assert.equal(entry.providerScope, 'canonical')
  assert.ok(entry.providerMappings.ups_rest.smallParcelPackageCode)
  assert.ok(entry.providerMappings.fedex_rest.smallParcelPackageCode)
}

assert.equal(catalog.packageProviderCode({
  catalogEntryId: 'box',
  provider: 'ups_rest',
  usage: 'small_parcel_package',
}), '02')
assert.equal(catalog.packageProviderCode({
  catalogEntryId: 'ups_customer_supplied_02',
  provider: 'ups_rest',
  usage: 'small_parcel_package',
}), '02')
assert.equal(catalog.packageProviderCode({
  catalogEntryId: 'fedex_your_packaging',
  provider: 'fedex_rest',
  usage: 'small_parcel_package',
}), 'YOUR_PACKAGING')
assert.equal(catalog.packageProviderCode({
  catalogEntryId: 'box',
  provider: 'fedex_rest',
  usage: 'small_parcel_package',
}), 'YOUR_PACKAGING')
assert.equal(catalog.packageProviderCode({
  catalogEntryId: 'box',
  provider: 'wwex_speedship',
  usage: 'small_parcel_package',
}), '02')
assert.equal(catalog.packageProviderCode({
  catalogEntryId: 'box',
  provider: 'wwex_speedship',
  usage: 'ltl_commodity',
}), 'CARTON')
assert.equal(catalog.packageProviderCode({
  catalogEntryId: 'box',
  provider: 'rl_carriers',
  usage: 'ltl_commodity',
}), 'CTN')
assert.equal(catalog.packageProviderCode({
  catalogEntryId: 'crate',
  provider: 'wwex_speedship',
  usage: 'ltl_commodity',
}), 'CRATE')
assert.equal(catalog.packageProviderCode({
  catalogEntryId: 'pallet_48x40',
  provider: 'wwex_speedship',
  usage: 'ltl_handling_unit',
}), 'PLT')

assert.deepEqual(
  Array.from(catalog.packageCatalogEntriesCompatibleWithProviders({
    providers: ['ups_rest', 'fedex_rest'],
    usage: 'small_parcel_package',
  }), (entry) => entry.id),
  ['box', 'envelope', 'tube', 'crate', 'custom'],
  'Multi-carrier package choices must be the exact provider intersection',
)
assert.deepEqual(
  Array.from(catalog.packageCatalogEntriesCompatibleWithProviders({
    providers: ['fedex_rest'],
    usage: 'small_parcel_package',
  }), (entry) => entry.id),
  [
    'box', 'envelope', 'tube', 'crate', 'custom',
    'fedex_your_packaging', 'fedex_envelope', 'fedex_box',
    'fedex_extra_small_box', 'fedex_small_box', 'fedex_medium_box',
    'fedex_large_box', 'fedex_extra_large_box', 'fedex_10kg_box',
    'fedex_25kg_box', 'fedex_pak', 'fedex_tube',
  ],
  'Single-carrier package choices may include that carrier scoped entries',
)

assert.deepEqual(
  Array.from(catalog.packagingMaterialUnitCounts([
    { packagingMaterialGlobalId: 'gmat0000001' },
    { packagingMaterialGlobalId: null },
    { packagingMaterialGlobalId: 'gmat0000001' },
    { packagingMaterialGlobalId: 'gmat0000002' },
  ]).entries()),
  [['gmat0000001', 2], ['gmat0000002', 1]],
  'Packaging-material availability must cover aggregate parcel use',
)
assert.equal(catalog.packageProviderCode({
  catalogEntryId: 'pallet_48x40',
  provider: 'rl_carriers',
  usage: 'ltl_handling_unit',
}), 'PLT')

for (const unsupported of [
  {
    catalogEntryId: 'pallet_48x40',
    provider: 'ups_rest',
    usage: 'small_parcel_package',
  },
  {
    catalogEntryId: 'crate',
    provider: 'rl_carriers',
    usage: 'ltl_commodity',
  },
  {
    catalogEntryId: 'box',
    provider: 'wwex_speedship',
    usage: 'ltl_handling_unit',
  },
]) {
  assert.throws(
    () => catalog.packageProviderCode(unsupported),
    /PACKAGE_CATALOG_(?:USAGE|PROVIDER_MAPPING)_UNSUPPORTED/,
  )
}

const materialProfile = catalog.normalizeCanonicalPackageProfile({
  contractVersion: catalog.PACKAGE_CATALOG_CONTRACT_VERSION,
  catalogEntryId: 'box',
  packageKind: 'box',
  packagingMaterialGlobalId: 'gmat0000001',
}, 'small_parcel_package')
assert.equal(materialProfile.packagingMaterialGlobalId, 'gmat0000001')

assert.throws(() => catalog.normalizeCanonicalPackageProfile({
  contractVersion: catalog.PACKAGE_CATALOG_CONTRACT_VERSION,
  catalogEntryId: 'pallet_48x40',
  packageKind: 'pallet',
  packagingMaterialGlobalId: 'gmat0000001',
}, 'ltl_handling_unit'), /PACKAGE_CATALOG_MATERIAL_INVALID/)
assert.throws(() => catalog.normalizeCanonicalPackageProfile({
  contractVersion: catalog.PACKAGE_CATALOG_CONTRACT_VERSION,
  catalogEntryId: 'wwex_ups_express_box_21',
  packageKind: 'box',
  packagingMaterialGlobalId: 'gmat0000001',
}, 'small_parcel_package'), /PACKAGE_CATALOG_MATERIAL_INVALID/)
assert.throws(() => catalog.normalizeCanonicalPackageProfile({
  contractVersion: catalog.PACKAGE_CATALOG_CONTRACT_VERSION,
  catalogEntryId: 'pallet_48x40',
  packageKind: 'pallet',
  packagingMaterialGlobalId: null,
}, 'small_parcel_package'), /PACKAGE_CATALOG_USAGE_UNSUPPORTED/)

const parcelDialog = read('app_src/components/operations/OneOffShipmentDialog.tsx')
const ltlPanel = read('app_src/components/operations/LtlFreightClassAssessmentPanel.tsx')
const shippingSection = read('app_src/components/shipping/ShippingSection.tsx')
const integrationSettings = read('app_src/components/settings/IntegrationSettingsPanel.tsx')
const carrierConnections = read('app_src/components/settings/CarrierConnectionsPanel.tsx')
const brokeredPanel = read('app_src/components/settings/BrokeredTransportIntegrationPanel.tsx')
const directCarrierPanel = read('app_src/components/settings/CarrierIntegrationPanel.tsx')
const persistence = read('app_src/lib/persistence/oneOffShipments.ts')

for (const fragment of [
  "fetch('/api/operations/packaging-materials'",
  'Package type / material',
  'packageCatalogEntriesCompatibleWithProviders',
  'data-testid="one-off-carrier-selection"',
  'All enabled',
  'selectedCarriers:',
  'packagingMaterialGlobalId',
  'ratedOuterDimensionsMm',
  'material.maxWeightGrams',
  'selectedMaterialUnits',
  'PACKAGE_CATALOG_CONTRACT_VERSION',
  'data-testid="one-off-shipment-actions"',
  'data-testid="one-off-shipment-mobile-secondary-actions"',
  'disableSpacing',
  "flexDirection: { xs: 'column', sm: 'row' }",
  'const primaryStepAction = step === 0',
  'const goBack = () =>',
  "minHeight: 44",
  'That product already exists. Choose it under Existing product and try again.',
  'needs package setup before shipping.',
  'setQuoteIdempotencyKey(nextQuoteIdempotencyKey())',
  'const [createAttempt, setCreateAttempt] = useState<OneOffShipmentCreateAttempt | null>(null)',
  'resolveOneOffShipmentCreateAttempt({',
  "'Idempotency-Key': attempt.idempotencyKey",
  "payload.code === 'OPERATIONS_IDEMPOTENCY_CONFLICT'",
  "const fedExPackageCodes = packages.map",
  'new Set(fedExPackageCodes).size > 1',
  'FedEx requires one package type across every parcel in this shipment.',
  "offer.executionCapability === 'direct_purchase_later'",
  'disabled={rateOnly}',
  'Rate only',
  'quote.carrierSelectionResults[selection.selectionKey]',
  'No selected carrier returned a rate that can create a shipment plan.',
  "'Common packaging'",
  "'Saved packaging'",
  "'Custom packaging'",
  'const carrierPackagingGroup = singleCarrier',
  '? carrierProviderLabel(providers[0])',
  '<ListSubheader key={`group:${group}`} disableSticky>',
  'sx={{ pl: 4 }}',
  "entry.providerScope !== 'canonical'\n        && entry.kind === 'custom'",
]) {
  assert.ok(parcelDialog.includes(fragment), `Parcel package catalog UI is missing ${fragment}`)
}
assert.ok(
  !parcelDialog.includes('if (!response.ok && payload.code) setCreateAttempt(null)'),
  'Create retries must retain the same body-bound key for in-progress or ambiguous outcomes',
)
assert.ok(
  parcelDialog.includes("entry.providerScope !== 'canonical'\n        && entry.kind === 'custom'"),
  'Single-carrier menus must not duplicate a provider customer-supplied code beside the common Custom package choice',
)
assert.doesNotMatch(
  parcelDialog,
  /payload\.code \? ` \[\$\{payload\.code\}\]`/,
  'Customer-facing one-off shipment errors must not expose internal error codes',
)
assert.doesNotMatch(
  persistence,
  /submit a new idempotency key/i,
  'Failed quote replay copy must explain the corrective action without idempotency jargon',
)
assert.match(
  parcelDialog,
  /payload\.error && !\/idempotency\/i\.test\(payload\.error\)/,
  'Unknown quote failures must not leak idempotency vocabulary',
)
assert.match(
  parcelDialog,
  /payload\.error && \/idempotency\/i\.test\(payload\.error\)/,
  'Create failures must replace idempotency vocabulary with customer-facing recovery copy',
)
assert.ok(
  !/(?:WWEX reference|provider packaging|Worldwide Express .*code)/.test(parcelDialog),
  'Package selectors must keep raw provider codes and catalog attribution internal',
)
for (const fragment of [
  'Pallet footprint preset (prefill only)',
  "packageCatalogEntries({\n  usage: 'ltl_handling_unit'",
  'Advisory until attested',
  'catalogEntryId is intentionally a UI prefill choice, not attested',
]) {
  assert.ok(ltlPanel.includes(fragment), `LTL handling-unit UI is missing ${fragment}`)
}
assert.ok(
  !ltlPanel.includes('`proposed-${catalogEntryId'),
  'A prefill-only catalog choice must not leak into persisted handling-unit evidence',
)
for (const fragment of [
  'aria-label="Shipment type"',
  '<ToggleButton data-testid="shipping-mode-parcel" value="parcel">',
  '<ToggleButton data-testid="shipping-mode-ltl" value="ltl">',
  'minHeight: 44',
  'minHeight: { xs: 44, sm: 40 }',
  'Rating, tender, and pickup are not connected yet.',
  'Pickup scheduling is not yet available',
]) {
  assert.ok(
    shippingSection.includes(fragment),
    `Shipping task UI is missing ${fragment}`,
  )
}
assert.ok(
  !shippingSection.includes('minHeight: { xs: 60, sm: 68 }'),
  'Shipment type choices must be compact segmented controls, not oversized cards',
)
for (const [source, label] of [
  [shippingSection, 'Shipping task UI'],
  [ltlPanel, 'LTL preparation UI'],
]) {
  assert.doesNotMatch(
    source,
    /(?:WWEX|Worldwide Express|R\+L|UPS\/FedEx|Provider package catalog|catalog reference|provider-specific codes|confirmed \$\{mode)/,
    `${label} must not expose reference catalogs, raw package codes, or provider attribution`,
  )
}
assert.ok(
  integrationSettings.includes('<CarrierConnectionsPanel onNavigate={onNavigate} />'),
  'Shipping settings must open the persistent carrier-connections workspace',
)
for (const fragment of [
  "Array<'small_parcel' | 'ltl'>",
  "['Carrier', 'Connection', 'Services', 'Done']",
  'Parcel rates',
  'LTL rates',
  'brokeredFocus="all"',
  'Troubleshoot',
]) {
  assert.ok(
    carrierConnections.includes(fragment),
    `Carrier connections are missing ${fragment}`,
  )
}
assert.ok(
  brokeredPanel.includes('any previously active mode was preserved'),
  'Shared Worldwide Express credential activation must preserve the other active mode',
)
assert.ok(
  brokeredPanel.includes("focus === 'small_parcel'\n          ? ['small_parcel']")
    && brokeredPanel.includes("focus === 'ltl'\n            ? ['ltl']"),
  'Capability tabs must request only their target mode and leave preservation to the locked server row',
)
assert.ok(
  (brokeredPanel.match(/minHeight: 44/g) || []).length >= 4,
  'Shipping integration actions must retain 44px touch targets',
)
for (const [source, label] of [
  [parcelDialog, 'One-off shipment'],
  [shippingSection, 'Shipping workspace'],
  [directCarrierPanel, 'Direct carrier credential'],
]) {
  assert.ok(
    source.includes('const iconActionSx = { minWidth: 44, minHeight: 44 }'),
    `${label} icon actions must define a 44px hit area`,
  )
  const iconActions = source.match(/<IconButton\b[\s\S]*?<\/IconButton>/g) || []
  assert.ok(iconActions.length > 0, `${label} must render at least one icon action`)
  assert.ok(
    iconActions.every((iconAction) => iconAction.includes('sx={iconActionSx}')),
    `${label} must apply the shared 44px hit area to every icon action`,
  )
}
for (const fragment of [
  'const buttonSx = {\n  minHeight: 44',
  "minHeight: 44, '& .MuiTab-root': { minHeight: 44 }",
  "'& .MuiToggleButton-root': { borderRadius: '8px', minHeight: 44 }",
  'sx={{ minHeight: 44, minWidth: 44 }}',
]) {
  assert.ok(
    directCarrierPanel.includes(fragment),
    `Direct carrier integration touch targets are missing ${fragment}`,
  )
}
assert.ok(
  persistence.includes("normalizeCanonicalPackageProfile(\n          source.packageProfile,\n          'small_parcel_package'"),
  'One-off quote validation must fail closed through the canonical profile',
)
assert.ok(
  persistence.includes('defaultCanonicalPackageProfile()'),
  'Legacy one-off quote callers must normalize to the versioned custom profile',
)
for (const fragment of [
  'operations_packaging_material_stock',
  'operations_packaging_material_claims',
  'activeClaimedByMaterialId',
  'AND ($4::uuid IS NULL OR plan_id <> $4::uuid)',
  'packedRerate.rows[0]?.plan_id || null',
  'OPERATIONS_ONE_OFF_PACKAGING_MATERIAL_UNAVAILABLE',
  'OPERATIONS_ONE_OFF_PACKAGING_MATERIAL_WEIGHT_INVALID',
  'packageKindForMaterialType(material.material_type)',
  'FOR SHARE OF material, stock',
  'materialUseCounts',
]) {
  assert.ok(
    persistence.includes(fragment),
    `Server-side packaging-material revalidation is missing ${fragment}`,
  )
}

console.log('Shipping package catalog and capability UI checks passed.')
