import { createHash } from 'node:crypto'
import type { Address, Millimeters } from '@/lib/operations/types'

export type OneOffCarrierProvider = 'ups_rest' | 'fedex_rest'
export type OneOffRateEnvironment = 'sandbox' | 'production'

export type OneOffExistingProductLine = {
  kind: 'existing'
  lineKey: string
  productGlobalId: string
  quantity: number
}

export type OneOffNewProductLine = {
  kind: 'new'
  lineKey: string
  name: string
  sku: string
  quantity: number
  unitPriceMinor: number
  unitWeightGrams: number
  unitDimensionsMm: Millimeters
  physicalUnitsOnHandConfirmed: true
}

export type OneOffShipmentLineInput =
  | OneOffExistingProductLine
  | OneOffNewProductLine

export type OneOffShipmentPackageInput = {
  packageKey: string
  description: string
  dimensionsMm: Millimeters
  grossWeightGrams: number
  allocations: Array<{
    lineKey: string
    quantity: number
  }>
}

export type OneOffShipmentQuoteInput = {
  customerGlobalId: string
  warehouseGlobalId: string
  inventoryPoolGlobalId: string
  receivingLocationGlobalId: string
  referenceNumber: string
  currency: string
  requestedDeliveryAt: string | null
  shipTo: Address
  lines: OneOffShipmentLineInput[]
  packages: OneOffShipmentPackageInput[]
}

export type OneOffShipmentQuoteOffer = {
  globalId: string
  provider: OneOffCarrierProvider
  providerLabel: 'UPS' | 'FedEx'
  environment: OneOffRateEnvironment
  serviceCode: string
  serviceName: string
  amountMinor: number
  currency: string
  transitDays: number | null
  estimatedDeliveryAt: string | null
  rateEvidenceGlobalId: string
}

export type OneOffShipmentQuote = {
  globalId: string
  referenceNumber: string
  status: 'succeeded' | 'partial' | 'failed'
  environment: OneOffRateEnvironment
  requiredCarrierProviders: OneOffCarrierProvider[]
  expiresAt: string
  offers: OneOffShipmentQuoteOffer[]
  effects: {
    carrierRateReads: number
    inventoryWrites: 0
    shipmentWrites: 0
    labelCalls: 0
    postagePurchases: 0
  }
}

export type OneOffShipmentCreateResult = {
  orderGlobalId: string
  orderStatus: 'planned'
  rowVersion: number
  fulfillmentPlanGlobalId: string
  quoteGlobalId: string
  selectedOfferGlobalId: string
  createdProductGlobalIds: string[]
  receiptGlobalId: string | null
  packageCount: number
  replayed: boolean
}

export type OneOffShipmentWorkspace = {
  environment: OneOffRateEnvironment
  customers: Array<{ globalId: string; name: string }>
  warehouses: Array<{
    globalId: string
    name: string
    address: Address
    inventoryPools: Array<{ globalId: string; name: string }>
    receivingLocations: Array<{ globalId: string; code: string }>
  }>
  products: Array<{
    globalId: string
    name: string
    sku: string | null
    unitPriceMinor: number
    defaultPackage: {
      rowVersion: number
      unitsPerPackage: number
      dimensionsMm: Millimeters
      weightGrams: number
    } | null
    availability: Array<{
      warehouseGlobalId: string
      inventoryPoolGlobalId: string
      availableQuantity: number
    }>
  }>
  carriers: Array<{
    provider: OneOffCarrierProvider
    providerLabel: 'UPS' | 'FedEx'
    environment: OneOffRateEnvironment
    integrationAccountGlobalId: string
    carrierAccountGlobalId: string
    displayName: string
    senderOriginWarehouseGlobalId: string | null
  }>
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function oneOffShipmentHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function oneOffProviderLabel(provider: OneOffCarrierProvider) {
  return provider === 'ups_rest' ? 'UPS' as const : 'FedEx' as const
}

export function oneOffRateEnvironment(
  environment: Record<string, string | undefined> = process.env,
): OneOffRateEnvironment {
  const value = String(
    environment.CLAWPILOT_ENV
    || environment.RAILWAY_ENVIRONMENT_NAME
    || environment.VERCEL_ENV
    || '',
  ).trim().toLowerCase()
  return value === 'production' ? 'production' : 'sandbox'
}
