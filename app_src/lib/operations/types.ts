export type OperationsProvider = 'shopify' | 'bigcommerce' | 'etsy' | 'mock-commerce'

export type OperationsOrderStatus =
  | 'imported'
  | 'validated'
  | 'held'
  | 'promised'
  | 'reserved'
  | 'planned'
  | 'released'
  | 'picking'
  | 'packed'
  | 'shipped'
  | 'cancelled'
  | 'exception'

export type OperationsExceptionSeverity = 'low' | 'medium' | 'high' | 'critical'

export type OperationsExceptionStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed'

export type OperationsActivationState = 'disabled' | 'shadow' | 'read_only' | 'active' | 'frozen'

export type OperationsOrderAction = 'release_to_warehouse' | 'confirm_picks'

export type OperationsOrderActionAvailability = {
  action: OperationsOrderAction
  label: string
  enabled: boolean
  blockedReason: string | null
}

export type CommerceCustomerMatchMethod =
  | 'external_id'
  | 'email'
  | 'contact_email'
  | 'website_domain'
  | 'name_phone'
  | 'exact_name'
  | 'created'

export type CommerceCustomerIdentity = {
  provider: string
  externalCustomerId: string
  companyName: string
  email?: string | null
  phone?: string | null
  website?: string | null
  address?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
}

export type CommerceCustomerResolution = {
  status: 'matched' | 'created' | 'ambiguous'
  method: CommerceCustomerMatchMethod | 'ambiguous'
  customer: { id: string; globalId: string; name: string } | null
  candidateGlobalIds: string[]
}

export type Millimeters = {
  length: number
  width: number
  height: number
}

export type Address = {
  name: string
  line1: string
  line2?: string
  city: string
  region: string
  postalCode: string
  country: string
}

export type CommerceOrderLineInput = {
  externalLineId: string
  channelSku: string
  description: string
  quantity: number
  unitPriceMinor: number
  weightGrams: number
  dimensionsMm: Millimeters
}

export type CommerceOrderInput = {
  provider: OperationsProvider
  externalOrderId: string
  orderNumber: string
  customerGlobalId: string
  currency: string
  requestedDeliveryAt: string
  shipTo: Address
  lines: CommerceOrderLineInput[]
  sourcePayload?: Record<string, unknown>
}

export type PackagePlan = {
  packageNumber: number
  dimensionsMm: Millimeters
  weightGrams: number
  lineExternalIds: string[]
}

export type CarrierRate = {
  carrier: 'UPS' | 'FedEx' | 'USPS' | 'MockCarrier'
  serviceCode: string
  serviceName: string
  internalCostMinor: bigint
  transitDays: number
  estimatedDeliveryAt: string
  meetsPromise: boolean
  providerPayload: Record<string, unknown>
}

export type PricedCarrierRate = CarrierRate & {
  customerChargeMinor: bigint
}

export type PricingDirective = {
  id: string
  globalId: string
  type:
    | 'fixed_order_fee'
    | 'pick_fee'
    | 'tiered_pick_fee'
    | 'pack_fee'
    | 'freight_markup_percent'
    | 'storage_fee'
    | 'special_handling'
  priority: number
  configuration: Record<string, unknown>
}

export type ChargeBreakdown = {
  directiveId: string | null
  directiveGlobalId: string | null
  type: string
  quantity: number
  amountMinor: bigint
}

export type EstimatedCharges = {
  charges: ChargeBreakdown[]
  revenueMinor: bigint
  freightChargeMinor: bigint
}

export type WarehouseCandidate = {
  warehouseId: string
  warehouseGlobalId: string
  warehouseName: string
  availableByProductId: Map<string, number>
  handlingCostMinor: bigint
}

export type OrderDemand = {
  productId: string
  quantity: number
}

export type OptimizationRequest = {
  orderGlobalId: string
  demand: OrderDemand[]
  candidates: WarehouseCandidate[]
  allowMultiWarehouse: boolean
}

export type OptimizationResult = {
  method: 'optimizer' | 'deterministic_fallback'
  solverStatus: 'optimal' | 'fallback' | 'infeasible'
  warehouseIds: string[]
  fallbackReason: string | null
  explanation: Record<string, unknown>
}

export interface FulfillmentOptimizer {
  plan(request: OptimizationRequest): Promise<OptimizationResult>
}

export type LabelResult = {
  providerLabelId: string
  trackingNumber: string
  format: 'ZPL' | 'PDF' | 'PNG'
  payload: string
}

export type PrintResult = {
  accepted: boolean
  providerJobId: string
  printedAt: string | null
  error: string | null
}

export type OperationsSummary = {
  openOrders: number
  exceptions: number
  dueSoon: number
  shippedToday: number
  reservedUnits: number
  availableUnits: number
  unbilledMinor: string
}

export type OperationsOrderListItem = {
  id: string
  globalId: string
  orderNumber: string
  customerName: string
  customerGlobalId: string
  sourceProvider: string
  status: OperationsOrderStatus
  warehouseName: string | null
  promisedDeliveryAt: string | null
  lineCount: number
  exceptionCount: number
  expectedCostMinor: string | null
  expectedRevenueMinor: string | null
  expectedMarginMinor: string | null
  trackingNumber: string | null
  updatedAt: string
}

export type OperationsExceptionListItem = {
  id: string
  globalId: string
  exceptionType: string
  severity: OperationsExceptionSeverity
  status: OperationsExceptionStatus
  title: string
  details: Record<string, unknown>
  assignedTo: string | null
  orderGlobalId: string | null
  orderNumber: string | null
  customerName: string | null
  customerGlobalId: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export type OperationsOrderDetail = OperationsOrderListItem & {
  externalOrderId: string
  currency: string
  rowVersion: number
  planStatus: string | null
  waveStatus: string | null
  pickTaskCount: number
  readyPickTaskCount: number
  availableActions: OperationsOrderActionAvailability[]
  shipTo: Address
  lines: Array<{
    globalId: string
    productGlobalId: string
    productName: string
    channelSku: string
    quantity: number
    reservedQuantity: number
    pickStatus: string | null
  }>
  packages: Array<{
    globalId: string
    packageNumber: number
    weightGrams: number
    dimensionsMm: Millimeters
    status: string
  }>
  rates: Array<{
    globalId: string
    carrier: string
    serviceName: string
    internalCostMinor: string
    customerChargeMinor: string
    estimatedDeliveryAt: string
    meetsPromise: boolean
    selected: boolean
  }>
  billableEvents: Array<{
    globalId: string
    type: string
    amountMinor: string
    status: string
  }>
  events: Array<{
    globalId: string
    type: string
    occurredAt: string
    payload: Record<string, unknown>
  }>
}

export type OperationsWorkspace = {
  organizationId: string
  configured: boolean
  capabilities: {
    canView: boolean
    canManage: boolean
    canExecute: boolean
    canActivate: boolean
  }
  dataPipeline: { id: string; name: string }
  activation: {
    state: OperationsActivationState
    revision: number
    reason: string | null
    updatedAt: string
  }
  summary: OperationsSummary
  orders: OperationsOrderListItem[]
  exceptions: OperationsExceptionListItem[]
  selectedOrder: OperationsOrderDetail | null
  warehouses: Array<{ id: string; globalId: string; name: string }>
  catalog: {
    customers: Array<{ id: string; globalId: string; name: string }>
    products: Array<{ id: string; globalId: string; name: string; sku: string | null }>
  }
  generatedAt: string
}

export type MockOperationsProofLineInput = {
  productGlobalId: string
  quantity: number
  openingQuantity: number
}

export type MockOperationsProofInput = {
  customerGlobalId: string
  externalOrderId: string
  orderNumber: string
  lines?: MockOperationsProofLineInput[]
  // Temporary compatibility fields for callers deployed before multi-line orders.
  productGlobalId?: string
  quantity?: number
  openingQuantity?: number
  requestedDeliveryAt: string
  shipTo: Address
  executionMode?: 'planned' | 'shipped'
}

export type MockOperationsProofResult = {
  orderGlobalId: string
  orderStatus: OperationsOrderStatus
  duplicate: boolean
  trackingNumber: string | null
  steps: string[]
}

export type OperationsOrderCommandResult = {
  orderGlobalId: string
  orderStatus: OperationsOrderStatus
  rowVersion: number
  replayed: boolean
}

export type OperationsExceptionUpdateResult = {
  exception: OperationsExceptionListItem
  changed: boolean
}

export type OperationsActivationUpdateResult = OperationsWorkspace['activation'] & {
  dataPipeline: OperationsWorkspace['dataPipeline']
}
