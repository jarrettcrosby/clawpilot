export const PACKAGE_CATALOG_CONTRACT_VERSION = 'operations.package_catalog.v1' as const

export const CANONICAL_PACKAGE_KINDS = [
  'pallet',
  'box',
  'envelope',
  'tube',
  'crate',
  'custom',
] as const

export type CanonicalPackageKind = typeof CANONICAL_PACKAGE_KINDS[number]
export type PackageCatalogUsage =
  | 'small_parcel_package'
  | 'ltl_handling_unit'
  | 'ltl_commodity'
export type PackageCatalogProvider =
  | 'ups_rest'
  | 'fedex_rest'
  | 'wwex_speedship'
  | 'rl_carriers'
export type PackageCatalogProviderScope = 'canonical' | PackageCatalogProvider

export const PACKAGE_CATALOG_ENTRY_IDS = [
  'box',
  'envelope',
  'tube',
  'crate',
  'custom',
  'pallet_48x40',
  'pallet_48x48',
  'pallet_euro',
  'pallet_custom',
  'ups_letter_01',
  'ups_customer_supplied_02',
  'ups_tube_03',
  'ups_pak_04',
  'ups_express_box_21',
  'ups_25kg_box_24',
  'ups_10kg_box_25',
  'ups_express_box_small_2a',
  'ups_express_box_medium_2b',
  'ups_express_box_large_2c',
  'fedex_your_packaging',
  'fedex_envelope',
  'fedex_box',
  'fedex_extra_small_box',
  'fedex_small_box',
  'fedex_medium_box',
  'fedex_large_box',
  'fedex_extra_large_box',
  'fedex_10kg_box',
  'fedex_25kg_box',
  'fedex_pak',
  'fedex_tube',
  'wwex_ups_express_envelope_01',
  'wwex_custom_02',
  'wwex_ups_express_tube_03',
  'wwex_ups_express_pak_04',
  'wwex_ups_express_box_21',
  'wwex_ups_25kg_box_24',
  'wwex_ups_10kg_box_25',
  'wwex_ups_express_box_small_2a',
  'wwex_ups_express_box_medium_2b',
  'wwex_ups_express_box_large_2c',
  'wwex_ltl_bag',
  'wwex_ltl_bale',
  'wwex_ltl_box',
  'wwex_ltl_bundle',
  'wwex_ltl_carton',
  'wwex_ltl_case',
  'wwex_ltl_crate',
  'wwex_ltl_drum',
  'wwex_ltl_pail',
  'wwex_ltl_pallet',
  'wwex_ltl_pieces',
  'wwex_ltl_reel',
  'wwex_ltl_roll',
  'wwex_ltl_skid',
  'wwex_ltl_tank',
  'wwex_ltl_trailer',
  'rl_ltl_pallet_plt',
  'rl_ltl_carton_ctn',
] as const

export type PackageCatalogEntryId = typeof PACKAGE_CATALOG_ENTRY_IDS[number]

type NullableDimensionsMm = Readonly<{
  length: number | null
  width: number | null
  height: number | null
}>

export type PackageProviderMapping = Readonly<{
  smallParcelPackageCode: string | null
  ltlHandlingUnitCode: string | null
  ltlCommodityCode: string | null
}>

export type PackageCatalogEntry = Readonly<{
  id: PackageCatalogEntryId
  kind: CanonicalPackageKind
  providerScope: PackageCatalogProviderScope
  label: string
  description: string
  usages: readonly PackageCatalogUsage[]
  defaultDimensionsMm: NullableDimensionsMm
  providerMappings: Readonly<Record<PackageCatalogProvider, PackageProviderMapping>>
}>

function entry(
  value: Omit<PackageCatalogEntry, 'providerScope'>
    & { providerScope?: PackageCatalogProviderScope },
): PackageCatalogEntry {
  return Object.freeze({
    ...value,
    providerScope: value.providerScope || 'canonical',
  })
}

const UNSUPPORTED_MAPPING: PackageProviderMapping = Object.freeze({
  smallParcelPackageCode: null,
  ltlHandlingUnitCode: null,
  ltlCommodityCode: null,
})

const UPS_CUSTOM_PACKAGE: PackageProviderMapping = Object.freeze({
  smallParcelPackageCode: '02',
  ltlHandlingUnitCode: null,
  ltlCommodityCode: null,
})

const FEDEX_CUSTOM_PACKAGE: PackageProviderMapping = Object.freeze({
  smallParcelPackageCode: 'YOUR_PACKAGING',
  ltlHandlingUnitCode: null,
  ltlCommodityCode: null,
})

const WWEX_CUSTOM_PACKAGE: PackageProviderMapping = Object.freeze({
  // SpeedShip v1.9b code 02 means customer-supplied/custom packaging.
  smallParcelPackageCode: '02',
  ltlHandlingUnitCode: null,
  ltlCommodityCode: null,
})

function parcelMappings(input: {
  wwexLtlCommodityCode?: string
  rlLtlCommodityCode?: string
} = {}): Readonly<Record<PackageCatalogProvider, PackageProviderMapping>> {
  return Object.freeze({
    ups_rest: UPS_CUSTOM_PACKAGE,
    fedex_rest: FEDEX_CUSTOM_PACKAGE,
    wwex_speedship: Object.freeze({
      ...WWEX_CUSTOM_PACKAGE,
      ltlCommodityCode: input.wwexLtlCommodityCode || null,
    }),
    rl_carriers: input.rlLtlCommodityCode
      ? Object.freeze({
          smallParcelPackageCode: null,
          ltlHandlingUnitCode: null,
          ltlCommodityCode: input.rlLtlCommodityCode,
        })
      : UNSUPPORTED_MAPPING,
  })
}

const PALLET_MAPPINGS: Readonly<Record<PackageCatalogProvider, PackageProviderMapping>> =
  Object.freeze({
    ups_rest: UNSUPPORTED_MAPPING,
    fedex_rest: UNSUPPORTED_MAPPING,
    wwex_speedship: Object.freeze({
      smallParcelPackageCode: null,
      ltlHandlingUnitCode: 'PLT',
      ltlCommodityCode: 'PLT',
    }),
    rl_carriers: Object.freeze({
      smallParcelPackageCode: null,
      ltlHandlingUnitCode: 'PLT',
      ltlCommodityCode: null,
    }),
  })

const NO_DIMENSIONS: NullableDimensionsMm = Object.freeze({
  length: null,
  width: null,
  height: null,
})

function providerOnlyMappings(input: {
  provider: PackageCatalogProvider
  smallParcelPackageCode?: string
  ltlHandlingUnitCode?: string
  ltlCommodityCode?: string
}): Readonly<Record<PackageCatalogProvider, PackageProviderMapping>> {
  const mapping = Object.freeze({
    smallParcelPackageCode: input.smallParcelPackageCode || null,
    ltlHandlingUnitCode: input.ltlHandlingUnitCode || null,
    ltlCommodityCode: input.ltlCommodityCode || null,
  })
  return Object.freeze({
    ups_rest: input.provider === 'ups_rest'
      ? mapping
      : UNSUPPORTED_MAPPING,
    fedex_rest: input.provider === 'fedex_rest'
      ? mapping
      : UNSUPPORTED_MAPPING,
    wwex_speedship: input.provider === 'wwex_speedship'
      ? mapping
      : UNSUPPORTED_MAPPING,
    rl_carriers: input.provider === 'rl_carriers'
      ? mapping
      : UNSUPPORTED_MAPPING,
  })
}

function providerCatalogEntry(input: {
  id: PackageCatalogEntryId
  provider: PackageCatalogProvider
  kind: CanonicalPackageKind
  label: string
  description: string
  usages: readonly PackageCatalogUsage[]
  smallParcelPackageCode?: string
  ltlHandlingUnitCode?: string
  ltlCommodityCode?: string
}): PackageCatalogEntry {
  return entry({
    id: input.id,
    kind: input.kind,
    providerScope: input.provider,
    label: input.label,
    description: input.description,
    usages: input.usages,
    defaultDimensionsMm: NO_DIMENSIONS,
    providerMappings: providerOnlyMappings(input),
  })
}

export const CANONICAL_PACKAGE_CATALOG: readonly PackageCatalogEntry[] = Object.freeze([
  entry({
    id: 'box',
    kind: 'box',
    label: 'Carton / box',
    description: 'Customer-supplied corrugated carton or rigid parcel box',
    usages: Object.freeze(['small_parcel_package', 'ltl_commodity'] as const),
    defaultDimensionsMm: NO_DIMENSIONS,
    providerMappings: parcelMappings({
      wwexLtlCommodityCode: 'CARTON',
      rlLtlCommodityCode: 'CTN',
    }),
  }),
  entry({
    id: 'envelope',
    kind: 'envelope',
    label: 'Envelope / mailer',
    description: 'Customer-supplied poly, padded, or rigid envelope',
    usages: Object.freeze(['small_parcel_package', 'ltl_commodity'] as const),
    defaultDimensionsMm: NO_DIMENSIONS,
    providerMappings: parcelMappings({ wwexLtlCommodityCode: 'BAG' }),
  }),
  entry({
    id: 'tube',
    kind: 'tube',
    label: 'Tube',
    description: 'Customer-supplied mailing or shipping tube',
    usages: Object.freeze(['small_parcel_package'] as const),
    defaultDimensionsMm: NO_DIMENSIONS,
    providerMappings: parcelMappings(),
  }),
  entry({
    id: 'crate',
    kind: 'crate',
    label: 'Crate',
    description: 'Customer-supplied rigid crate shipped as one parcel',
    usages: Object.freeze(['small_parcel_package', 'ltl_commodity'] as const),
    defaultDimensionsMm: NO_DIMENSIONS,
    providerMappings: parcelMappings({ wwexLtlCommodityCode: 'CRATE' }),
  }),
  entry({
    id: 'custom',
    kind: 'custom',
    label: 'Custom package',
    description: 'Another customer-supplied parcel form using exact measured facts',
    usages: Object.freeze(['small_parcel_package'] as const),
    defaultDimensionsMm: NO_DIMENSIONS,
    providerMappings: parcelMappings(),
  }),
  entry({
    id: 'pallet_48x40',
    kind: 'pallet',
    label: '48 × 40 in pallet',
    description: 'Standard North American pallet footprint; height remains measured freight height',
    usages: Object.freeze(['ltl_handling_unit'] as const),
    defaultDimensionsMm: Object.freeze({ length: 1219, width: 1016, height: null }),
    providerMappings: PALLET_MAPPINGS,
  }),
  entry({
    id: 'pallet_48x48',
    kind: 'pallet',
    label: '48 × 48 in pallet',
    description: 'Square pallet footprint; height remains measured freight height',
    usages: Object.freeze(['ltl_handling_unit'] as const),
    defaultDimensionsMm: Object.freeze({ length: 1219, width: 1219, height: null }),
    providerMappings: PALLET_MAPPINGS,
  }),
  entry({
    id: 'pallet_euro',
    kind: 'pallet',
    label: 'EUR / EPAL pallet',
    description: '1200 × 800 mm pallet footprint; height remains measured freight height',
    usages: Object.freeze(['ltl_handling_unit'] as const),
    defaultDimensionsMm: Object.freeze({ length: 1200, width: 800, height: null }),
    providerMappings: PALLET_MAPPINGS,
  }),
  entry({
    id: 'pallet_custom',
    kind: 'pallet',
    label: 'Custom pallet footprint',
    description: 'Palletized handling unit using operator-measured exterior dimensions',
    usages: Object.freeze(['ltl_handling_unit'] as const),
    defaultDimensionsMm: NO_DIMENSIONS,
    providerMappings: PALLET_MAPPINGS,
  }),
  ...([
    ['ups_letter_01', '01', 'Envelope', 'envelope'],
    ['ups_customer_supplied_02', '02', 'Custom package', 'custom'],
    ['ups_tube_03', '03', 'Tube', 'tube'],
    ['ups_pak_04', '04', 'PAK', 'envelope'],
    ['ups_express_box_21', '21', 'Express box', 'box'],
    ['ups_25kg_box_24', '24', '25 kg box', 'box'],
    ['ups_10kg_box_25', '25', '10 kg box', 'box'],
    ['ups_express_box_small_2a', '2a', 'Small box', 'box'],
    ['ups_express_box_medium_2b', '2b', 'Medium box', 'box'],
    ['ups_express_box_large_2c', '2c', 'Large box', 'box'],
  ] as const).map(([id, code, label, kind]) => providerCatalogEntry({
    id,
    provider: 'ups_rest',
    kind,
    label,
    description: label,
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: code,
  })),
  ...([
    ['fedex_your_packaging', 'YOUR_PACKAGING', 'Custom package', 'custom'],
    ['fedex_envelope', 'FEDEX_ENVELOPE', 'Envelope', 'envelope'],
    ['fedex_box', 'FEDEX_BOX', 'Box', 'box'],
    ['fedex_extra_small_box', 'FEDEX_EXTRA_SMALL_BOX', 'Extra small box', 'box'],
    ['fedex_small_box', 'FEDEX_SMALL_BOX', 'Small box', 'box'],
    ['fedex_medium_box', 'FEDEX_MEDIUM_BOX', 'Medium box', 'box'],
    ['fedex_large_box', 'FEDEX_LARGE_BOX', 'Large box', 'box'],
    ['fedex_extra_large_box', 'FEDEX_EXTRA_LARGE_BOX', 'Extra large box', 'box'],
    ['fedex_10kg_box', 'FEDEX_10KG_BOX', '10 kg box', 'box'],
    ['fedex_25kg_box', 'FEDEX_25KG_BOX', '25 kg box', 'box'],
    ['fedex_pak', 'FEDEX_PAK', 'PAK', 'envelope'],
    ['fedex_tube', 'FEDEX_TUBE', 'Tube', 'tube'],
  ] as const).map(([id, code, label, kind]) => providerCatalogEntry({
    id,
    provider: 'fedex_rest',
    kind,
    label,
    description: label,
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: code,
  })),
  providerCatalogEntry({
    id: 'wwex_ups_express_envelope_01',
    provider: 'wwex_speedship',
    kind: 'envelope',
    label: 'Envelope',
    description: 'Envelope',
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: '01',
  }),
  providerCatalogEntry({
    id: 'wwex_custom_02',
    provider: 'wwex_speedship',
    kind: 'custom',
    label: 'Custom package',
    description: 'Custom package',
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: '02',
  }),
  providerCatalogEntry({
    id: 'wwex_ups_express_tube_03',
    provider: 'wwex_speedship',
    kind: 'tube',
    label: 'Tube',
    description: 'Tube',
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: '03',
  }),
  providerCatalogEntry({
    id: 'wwex_ups_express_pak_04',
    provider: 'wwex_speedship',
    kind: 'envelope',
    label: 'PAK',
    description: 'PAK',
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: '04',
  }),
  providerCatalogEntry({
    id: 'wwex_ups_express_box_21',
    provider: 'wwex_speedship',
    kind: 'box',
    label: 'Express box',
    description: 'Express box',
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: '21',
  }),
  providerCatalogEntry({
    id: 'wwex_ups_25kg_box_24',
    provider: 'wwex_speedship',
    kind: 'box',
    label: '25 kg box',
    description: '25 kg box',
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: '24',
  }),
  providerCatalogEntry({
    id: 'wwex_ups_10kg_box_25',
    provider: 'wwex_speedship',
    kind: 'box',
    label: '10 kg box',
    description: '10 kg box',
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: '25',
  }),
  providerCatalogEntry({
    id: 'wwex_ups_express_box_small_2a',
    provider: 'wwex_speedship',
    kind: 'box',
    label: 'Small box',
    description: 'Small box',
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: '2a',
  }),
  providerCatalogEntry({
    id: 'wwex_ups_express_box_medium_2b',
    provider: 'wwex_speedship',
    kind: 'box',
    label: 'Medium box',
    description: 'Medium box',
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: '2b',
  }),
  providerCatalogEntry({
    id: 'wwex_ups_express_box_large_2c',
    provider: 'wwex_speedship',
    kind: 'box',
    label: 'Large box',
    description: 'Large box',
    usages: Object.freeze(['small_parcel_package'] as const),
    smallParcelPackageCode: '2c',
  }),
  ...([
    ['wwex_ltl_bag', 'BAG', 'Bag', 'envelope'],
    ['wwex_ltl_bale', 'BALE', 'Bale', 'custom'],
    ['wwex_ltl_box', 'BOX', 'Box', 'box'],
    ['wwex_ltl_bundle', 'BUNDLE', 'Bundle', 'custom'],
    ['wwex_ltl_carton', 'CARTON', 'Carton', 'box'],
    ['wwex_ltl_case', 'CASE', 'Case', 'box'],
    ['wwex_ltl_crate', 'CRATE', 'Crate', 'crate'],
    ['wwex_ltl_drum', 'DRUM', 'Drum', 'custom'],
    ['wwex_ltl_pail', 'PAIL', 'Pail', 'custom'],
    ['wwex_ltl_pallet', 'PLT', 'Pallet', 'pallet'],
    ['wwex_ltl_pieces', 'PIECES', 'Pieces', 'custom'],
    ['wwex_ltl_reel', 'REEL', 'Reel', 'custom'],
    ['wwex_ltl_roll', 'ROLL', 'Roll', 'tube'],
    ['wwex_ltl_skid', 'SKID', 'Skid', 'pallet'],
    ['wwex_ltl_tank', 'TANK', 'Tank', 'custom'],
    ['wwex_ltl_trailer', 'TRAILER', 'Trailer', 'custom'],
  ] as const).map(([id, code, label, kind]) => providerCatalogEntry({
    id,
    provider: 'wwex_speedship',
    kind,
    label,
    description: label,
    // SpeedShip's current LTL shop adapter fixes the outer handling unit to
    // PLT. SKID is confirmed only as a shipped-item packaging code, so do not
    // invent an outer-handling mapping for it.
    usages: code === 'PLT'
      ? Object.freeze(['ltl_handling_unit', 'ltl_commodity'] as const)
      : Object.freeze(['ltl_commodity'] as const),
    ...(code === 'PLT'
      ? { ltlHandlingUnitCode: code }
      : {}),
    ltlCommodityCode: code,
  })),
  providerCatalogEntry({
    id: 'rl_ltl_pallet_plt',
    provider: 'rl_carriers',
    kind: 'pallet',
    label: 'Pallet',
    description: 'Pallet',
    usages: Object.freeze(['ltl_handling_unit'] as const),
    ltlHandlingUnitCode: 'PLT',
  }),
  providerCatalogEntry({
    id: 'rl_ltl_carton_ctn',
    provider: 'rl_carriers',
    kind: 'box',
    label: 'Carton',
    description: 'Carton',
    usages: Object.freeze(['ltl_commodity'] as const),
    ltlCommodityCode: 'CTN',
  }),
])

const CATALOG_BY_ID = new Map(
  CANONICAL_PACKAGE_CATALOG.map((entry) => [entry.id, entry]),
)

export type CanonicalPackageProfile = Readonly<{
  contractVersion: typeof PACKAGE_CATALOG_CONTRACT_VERSION
  catalogEntryId: PackageCatalogEntryId
  packageKind: CanonicalPackageKind
  packagingMaterialGlobalId: string | null
}>

const MATERIAL_GLOBAL_ID = /^gmat(?:[0-9]{7}|[0-9a-v]{12})$/

export function packageCatalogEntriesForUsage(usage: PackageCatalogUsage) {
  return packageCatalogEntries({ usage, includeCanonical: true })
}

export function packageCatalogEntries(input: {
  usage: PackageCatalogUsage
  provider?: PackageCatalogProvider | null
  includeCanonical?: boolean
}) {
  const includeCanonical = input.includeCanonical !== false
  return CANONICAL_PACKAGE_CATALOG.filter((entry) => (
    entry.usages.includes(input.usage)
    && (
      (includeCanonical && entry.providerScope === 'canonical')
      || entry.providerScope === input.provider
    )
  ))
}

export function packageCatalogProviderCodes(input: {
  provider: PackageCatalogProvider
  usage: PackageCatalogUsage
  providerScopedOnly?: boolean
}) {
  return CANONICAL_PACKAGE_CATALOG.flatMap((entry) => {
    if (
      !entry.usages.includes(input.usage)
      || (
        input.providerScopedOnly
        && entry.providerScope !== input.provider
      )
    ) return []
    const mapping = entry.providerMappings[input.provider]
    const code = input.usage === 'small_parcel_package'
      ? mapping.smallParcelPackageCode
      : input.usage === 'ltl_handling_unit'
        ? mapping.ltlHandlingUnitCode
        : mapping.ltlCommodityCode
    return code ? [code] : []
  }).filter((code, index, all) => all.indexOf(code) === index)
}

export function packageCatalogEntry(id: string): PackageCatalogEntry | null {
  return CATALOG_BY_ID.get(id as PackageCatalogEntryId) || null
}

export function packageProviderCode(input: {
  catalogEntryId: PackageCatalogEntryId
  provider: PackageCatalogProvider
  usage: PackageCatalogUsage
}) {
  const entry = packageCatalogEntry(input.catalogEntryId)
  if (!entry || !entry.usages.includes(input.usage)) {
    throw new Error('PACKAGE_CATALOG_USAGE_UNSUPPORTED')
  }
  const mapping = entry.providerMappings[input.provider]
  const code = input.usage === 'small_parcel_package'
    ? mapping.smallParcelPackageCode
    : input.usage === 'ltl_handling_unit'
      ? mapping.ltlHandlingUnitCode
      : mapping.ltlCommodityCode
  if (!code) throw new Error('PACKAGE_CATALOG_PROVIDER_MAPPING_UNSUPPORTED')
  return code
}

export function packageCatalogEntriesCompatibleWithProviders(input: {
  providers: readonly PackageCatalogProvider[]
  usage: PackageCatalogUsage
  includeCanonical?: boolean
}) {
  const providers = [...new Set(input.providers)]
  if (!providers.length) return []
  return packageCatalogEntries({
    usage: input.usage,
    includeCanonical: input.includeCanonical !== false,
    provider: providers.length === 1 ? providers[0] : null,
  }).filter((catalogEntry) => providers.every((provider) => {
    try {
      packageProviderCode({
        catalogEntryId: catalogEntry.id,
        provider,
        usage: input.usage,
      })
      return true
    } catch {
      return false
    }
  }))
}

export function packageKindForMaterialType(
  materialType: 'carton' | 'poly_mailer' | 'padded_mailer',
): Extract<CanonicalPackageKind, 'box' | 'envelope'> {
  return materialType === 'carton' ? 'box' : 'envelope'
}

export function packagingMaterialUnitCounts(
  packages: readonly Readonly<{ packagingMaterialGlobalId: string | null }>[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const shipmentPackage of packages) {
    const materialGlobalId = shipmentPackage.packagingMaterialGlobalId
    if (!materialGlobalId) continue
    counts.set(materialGlobalId, (counts.get(materialGlobalId) || 0) + 1)
  }
  return counts
}

export function defaultCanonicalPackageProfile(): CanonicalPackageProfile {
  return Object.freeze({
    contractVersion: PACKAGE_CATALOG_CONTRACT_VERSION,
    catalogEntryId: 'custom',
    packageKind: 'custom',
    packagingMaterialGlobalId: null,
  })
}

export function normalizeCanonicalPackageProfile(
  value: unknown,
  usage: PackageCatalogUsage,
): CanonicalPackageProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PACKAGE_CATALOG_PROFILE_INVALID')
  }
  const source = value as Record<string, unknown>
  const keys = [
    'contractVersion',
    'catalogEntryId',
    'packageKind',
    'packagingMaterialGlobalId',
  ]
  if (
    Object.keys(source).length !== keys.length
    || keys.some((key) => !Object.hasOwn(source, key))
  ) {
    throw new Error('PACKAGE_CATALOG_PROFILE_INVALID')
  }
  if (source.contractVersion !== PACKAGE_CATALOG_CONTRACT_VERSION) {
    throw new Error('PACKAGE_CATALOG_VERSION_UNSUPPORTED')
  }
  const entry = packageCatalogEntry(String(source.catalogEntryId || ''))
  if (!entry || !entry.usages.includes(usage)) {
    throw new Error('PACKAGE_CATALOG_USAGE_UNSUPPORTED')
  }
  if (source.packageKind !== entry.kind) {
    throw new Error('PACKAGE_CATALOG_KIND_MISMATCH')
  }
  const materialGlobalId = source.packagingMaterialGlobalId
  if (
    materialGlobalId !== null
    && (
      typeof materialGlobalId !== 'string'
      || !MATERIAL_GLOBAL_ID.test(materialGlobalId)
      || entry.providerScope !== 'canonical'
      || !['box', 'envelope'].includes(entry.kind)
    )
  ) {
    throw new Error('PACKAGE_CATALOG_MATERIAL_INVALID')
  }
  return Object.freeze({
    contractVersion: PACKAGE_CATALOG_CONTRACT_VERSION,
    catalogEntryId: entry.id,
    packageKind: entry.kind,
    packagingMaterialGlobalId: materialGlobalId as string | null,
  })
}
