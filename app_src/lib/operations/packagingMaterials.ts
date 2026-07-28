export const PACKAGING_MATERIAL_TYPES = [
  'carton',
  'poly_mailer',
  'padded_mailer',
] as const

export const PACKAGING_MATERIAL_STATUSES = ['draft', 'active'] as const

export type PackagingMaterialType = typeof PACKAGING_MATERIAL_TYPES[number]
export type PackagingMaterialStatus = typeof PACKAGING_MATERIAL_STATUSES[number]

export type PackagingMaterialStock = {
  id: string
  globalId: string
  warehouseId: string
  warehouseGlobalId: string
  warehouseName: string
  warehouseStatus: 'active' | 'inactive'
  isAvailable: boolean
  onHandQuantity: number | null
  reorderPointQuantity: number | null
  reorderToQuantity: number | null
  reorderRecommendedQuantity: number
  rowVersion: number
  updatedAt: string
}

export type PackagingMaterial = {
  id: string
  globalId: string
  code: string
  name: string
  materialType: PackagingMaterialType
  innerDimensionsMm: {
    length: number
    width: number
    height: number
  }
  tareWeightGrams: number
  maxWeightGrams: number
  unitCostMinor: number | null
  currency: string | null
  status: PackagingMaterialStatus
  source: 'manual' | 'starter_assortment'
  rowVersion: number
  updatedAt: string
  stock: PackagingMaterialStock[]
  readiness: {
    eligibleForCartonization: boolean
    missing: Array<'unit_cost' | 'warehouse_stock' | 'available_stock'>
  }
}

export type PackagingMaterialsWorkspace = {
  capabilities: {
    canView: boolean
    canManage: boolean
  }
  warehouses: Array<{
    id: string
    globalId: string
    name: string
    status: 'active' | 'inactive'
  }>
  materials: PackagingMaterial[]
  optimizerReadiness: {
    historyWindowDays: number
    shippedDemandSampleCount: number
    eligibleShippedDemandSampleCount: number
    missingProductDimensionCount: number
    missingMaterialCostCount: number
    missingWarehouseStockCount: number
    outOfStockAvailabilityCount: number
    eligibleMaterialCount: number
    reorderDueCount: number
  }
}

export type PackagingMaterialInput = {
  globalId?: string
  expectedRowVersion?: number
  code: string
  name: string
  materialType: PackagingMaterialType
  innerLengthMm: number
  innerWidthMm: number
  innerHeightMm: number
  tareWeightGrams: number
  maxWeightGrams: number
  unitCostMinor: number | null
  currency: string | null
  status: PackagingMaterialStatus
}

export type PackagingMaterialStockInput = {
  materialGlobalId: string
  warehouseId: string
  expectedRowVersion?: number
  isAvailable: boolean
  onHandQuantity: number | null
  reorderPointQuantity: number | null
  reorderToQuantity: number | null
}

export type StarterPackagingMaterial = Omit<
  PackagingMaterialInput,
  'globalId' | 'expectedRowVersion'
> & {
  source: 'starter_assortment'
}

// These are nominal, editable starting specifications rather than a claim
// about an organization's suppliers, historical demand, or carrier rates.
// The workflow stores them as drafts with no invented cost or stock.
export const STARTER_PACKAGING_MATERIALS: readonly StarterPackagingMaterial[] = [
  {
    code: 'STARTER-BOX-06X06X04',
    name: 'Compact starter carton',
    materialType: 'carton',
    innerLengthMm: 152,
    innerWidthMm: 152,
    innerHeightMm: 102,
    tareWeightGrams: 95,
    maxWeightGrams: 4536,
    unitCostMinor: null,
    currency: null,
    status: 'draft',
    source: 'starter_assortment',
  },
  {
    code: 'STARTER-BOX-08X06X04',
    name: 'Small starter carton',
    materialType: 'carton',
    innerLengthMm: 203,
    innerWidthMm: 152,
    innerHeightMm: 102,
    tareWeightGrams: 120,
    maxWeightGrams: 6804,
    unitCostMinor: null,
    currency: null,
    status: 'draft',
    source: 'starter_assortment',
  },
  {
    code: 'STARTER-BOX-10X08X06',
    name: 'Medium starter carton',
    materialType: 'carton',
    innerLengthMm: 254,
    innerWidthMm: 203,
    innerHeightMm: 152,
    tareWeightGrams: 190,
    maxWeightGrams: 11340,
    unitCostMinor: null,
    currency: null,
    status: 'draft',
    source: 'starter_assortment',
  },
  {
    code: 'STARTER-BOX-12X10X08',
    name: 'Large starter carton',
    materialType: 'carton',
    innerLengthMm: 305,
    innerWidthMm: 254,
    innerHeightMm: 203,
    tareWeightGrams: 285,
    maxWeightGrams: 15876,
    unitCostMinor: null,
    currency: null,
    status: 'draft',
    source: 'starter_assortment',
  },
  {
    code: 'STARTER-POLY-10X13',
    name: 'Starter poly mailer',
    materialType: 'poly_mailer',
    innerLengthMm: 330,
    innerWidthMm: 254,
    innerHeightMm: 51,
    tareWeightGrams: 18,
    maxWeightGrams: 2268,
    unitCostMinor: null,
    currency: null,
    status: 'draft',
    source: 'starter_assortment',
  },
  {
    code: 'STARTER-PADDED-08X12',
    name: 'Starter padded mailer',
    materialType: 'padded_mailer',
    innerLengthMm: 305,
    innerWidthMm: 216,
    innerHeightMm: 38,
    tareWeightGrams: 32,
    maxWeightGrams: 1814,
    unitCostMinor: null,
    currency: null,
    status: 'draft',
    source: 'starter_assortment',
  },
] as const

export function packagingMaterialReadiness(input: {
  status: PackagingMaterialStatus
  unitCostMinor: number | null
  stock: Array<{
    warehouseStatus: 'active' | 'inactive'
    isAvailable: boolean
    onHandQuantity: number | null
  }>
}): PackagingMaterial['readiness'] {
  const missing: PackagingMaterial['readiness']['missing'] = []
  if (input.unitCostMinor === null) missing.push('unit_cost')
  const configuredStock = input.stock.some(
    (item) => item.warehouseStatus === 'active' && item.onHandQuantity !== null,
  )
  if (!configuredStock) missing.push('warehouse_stock')
  const availableStock = input.stock.some(
    (item) => (
      item.warehouseStatus === 'active'
      && item.isAvailable
      && Number(item.onHandQuantity || 0) > 0
    ),
  )
  if (configuredStock && !availableStock) missing.push('available_stock')
  return {
    eligibleForCartonization: (
      input.status === 'active'
      && input.unitCostMinor !== null
      && availableStock
    ),
    missing,
  }
}
