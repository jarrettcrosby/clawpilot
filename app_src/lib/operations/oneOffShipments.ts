import { createHash } from 'node:crypto'
import type { Address, Millimeters } from '@/lib/operations/types'

export type OneOffCarrierProvider = 'ups_rest' | 'fedex_rest'
export type OneOffRateEnvironment = 'sandbox' | 'production'
export type OneOffExecutionMode = 'test' | 'live'
export {
  ONE_OFF_LIVE_POSTAGE_CONFIRMATION,
  ONE_OFF_MAX_SYNCHRONOUS_PACKAGES,
} from '@/lib/operations/oneOffShipmentConstants'

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
  executionMode: OneOffExecutionMode
  customerGlobalId: string
  warehouseGlobalId: string
  inventoryPoolGlobalId: string
  receivingLocationGlobalId: string
  referenceNumber: string
  currency: string
  requestedDeliveryAt: string | null
  shipFromPhone: string
  shipToPhone: string
  shipToResidential: boolean
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
  integrationAccountGlobalId: string
  carrierAccountGlobalId: string
  credentialVersion: number
}

export type OneOffPackedRateRefresh = {
  orderGlobalId: string
  rowVersion: number
  planningQuoteGlobalId: string
  planningOfferGlobalId: string
  planningAmountMinor: number
  currency: string
  executionMode: OneOffExecutionMode
  packageCount: number
  quote: OneOffShipmentQuote
}

export type OneOffCarrierGroupCommandResult = {
  orderGlobalId: string
  orderStatus: 'packed'
  rowVersion: number
  groupAttemptGlobalId: string
  action: 'create' | 'void' | 'close_sample'
  state: 'succeeded'
  executionMode: OneOffExecutionMode
  environment: OneOffRateEnvironment
  provider: OneOffCarrierProvider
  serviceCode: string
  packageCount: number
  masterTrackingNumber: string
  providerShipmentId: string
  selectedAmountMinor: number
  currency: string
  providerChargeMinor: number | null
  providerChargeCurrency: string | null
  chargeVarianceMinor: number | null
  labels: Array<{
    packageGlobalId: string
    packageNumber: number
    labelGlobalId: string
    trackingNumber: string
    status: 'created' | 'voided'
    printJobGlobalId: string | null
    printWarning: string | null
  }>
  replayed: boolean
}

export type OneOffShipmentExecutionState = {
  orderGlobalId: string
  rowVersion: number
  executionMode: OneOffExecutionMode
  environment: OneOffRateEnvironment
  packageCount: number
  planning: {
    quoteGlobalId: string
    offerGlobalId: string
    provider: OneOffCarrierProvider
    serviceCode: string
    serviceName: string
    amountMinor: number
    currency: string
  }
  packedRate: null | {
    quoteGlobalId: string
    expiresAt: string
    status: 'succeeded' | 'partial' | 'failed'
    consumed: boolean
    offers: OneOffShipmentQuoteOffer[]
  }
  carrierGroup: null | {
    createAttemptGlobalId: string
    state: 'prepared' | 'succeeded' | 'failed' | 'unknown'
    provider: OneOffCarrierProvider
    serviceCode: string
    packageCount: number
    selectedAmountMinor: number
    currency: string
    providerChargeMinor: number | null
    providerChargeCurrency: string | null
    chargeVarianceMinor: number | null
    masterTrackingNumber: string | null
    providerShipmentId: string | null
    lifecycleMode: 'local_sample_close' | 'carrier_void' | null
    unresolved: boolean
    active: boolean
    voidAttemptGlobalId: string | null
    voidAction: 'void' | 'close_sample' | null
    voidState: 'prepared' | 'succeeded' | 'failed' | 'unknown' | null
    labels: Array<{
      packageGlobalId: string
      packageNumber: number
      labelGlobalId: string
      trackingNumber: string
      status: 'created' | 'voided'
      printJobGlobalId: string | null
      printStatus: 'queued' | 'printed' | 'failed' | 'rerouted' | null
      printWarning: string | null
    }>
  }
}

export type OneOffShipmentQuote = {
  globalId: string
  referenceNumber: string
  status: 'succeeded' | 'partial' | 'failed'
  environment: OneOffRateEnvironment
  executionMode: OneOffExecutionMode
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
  executionModes: Array<{
    mode: OneOffExecutionMode
    environment: OneOffRateEnvironment
    enabled: boolean
    blockers: string[]
  }>
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
