import { createHash } from 'node:crypto'
import { carrierProductionLabelAuthorizationAllowed } from '@/lib/integrations/carrierProductionLabelRuntime'
import type { Address, Millimeters } from '@/lib/operations/types'
import type { CanonicalPackageProfile } from '@/lib/operations/packageCatalog'

export type OneOffCarrierProvider = 'ups_rest' | 'fedex_rest' | 'wwex_speedship'
export type OneOffRateEnvironment = 'sandbox' | 'production'
export type OneOffExecutionMode = 'test' | 'live'
export {
  ONE_OFF_LIVE_POSTAGE_CONFIRMATION,
  ONE_OFF_MAX_SYNCHRONOUS_PACKAGES,
} from '@/lib/operations/oneOffShipmentConstants'

export type OneOffCarrierSelectionInput = {
  provider: OneOffCarrierProvider
  integrationAccountGlobalId: string
  carrierAccountGlobalId: string | null
}

export type OneOffCarrierPackageCode = {
  packageKey: string
  catalogEntryId: CanonicalPackageProfile['catalogEntryId']
  catalogVersion: CanonicalPackageProfile['contractVersion']
  providerPackageCode: string
}

export type OneOffResolvedCarrierSelection = OneOffCarrierSelectionInput & {
  selectionKey: string
  credentialVersion: number
  packageCodes: OneOffCarrierPackageCode[]
}

export type OneOffCarrierSelectionResult = {
  status: 'succeeded' | 'failed'
  eligibleOfferCount: number
  errorCode: string | null
}

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
  packageProfile: CanonicalPackageProfile
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
  selectedCarriers: OneOffCarrierSelectionInput[]
  shipTo: Address
  lines: OneOffShipmentLineInput[]
  packages: OneOffShipmentPackageInput[]
}

export type OneOffShipmentQuoteOffer = {
  globalId: string
  provider: OneOffCarrierProvider
  providerLabel: 'UPS' | 'FedEx' | 'Worldwide Express'
  executionCapability: 'direct_purchase_later' | 'rate_only'
  environment: OneOffRateEnvironment
  serviceCode: string
  serviceName: string
  amountMinor: number
  currency: string
  transitDays: number | null
  estimatedDeliveryAt: string | null
  rateEvidenceGlobalId: string
  integrationAccountGlobalId: string
  carrierAccountGlobalId: string | null
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
  requiredCarrierSelections: OneOffResolvedCarrierSelection[]
  carrierSelectionResults: Record<string, OneOffCarrierSelectionResult>
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
    providerLabel: 'UPS' | 'FedEx' | 'Worldwide Express'
    environment: OneOffRateEnvironment
    integrationAccountGlobalId: string
    carrierAccountGlobalId: string | null
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
  return provider === 'ups_rest'
    ? 'UPS' as const
    : provider === 'fedex_rest'
      ? 'FedEx' as const
      : 'Worldwide Express' as const
}

export function oneOffCarrierSelectionKey(input: {
  provider: OneOffCarrierProvider
  integrationAccountGlobalId: string
  carrierAccountGlobalId: string | null
  credentialVersion: number
}) {
  return `${input.provider}:${input.integrationAccountGlobalId}:${input.carrierAccountGlobalId || 'none'}:v${input.credentialVersion}`
}

export function canonicalOneOffCarrierSelections<
  T extends OneOffCarrierSelectionInput,
>(selections: readonly T[]): T[] {
  return [...selections].sort((left, right) => {
    const providerRank = (provider: OneOffCarrierProvider) => (
      provider === 'ups_rest' ? 0 : provider === 'fedex_rest' ? 1 : 2
    )
    const providerOrder = providerRank(left.provider) - providerRank(right.provider)
    if (providerOrder) return providerOrder
    const accountOrder = left.integrationAccountGlobalId.localeCompare(
      right.integrationAccountGlobalId,
    )
    return accountOrder || (left.carrierAccountGlobalId || '').localeCompare(
      right.carrierAccountGlobalId || '',
    )
  })
}

export function oneOffRateEnvironment(
  environment: Record<string, string | undefined> = process.env,
): OneOffRateEnvironment {
  return carrierProductionLabelAuthorizationAllowed(environment)
    ? 'production'
    : 'sandbox'
}
