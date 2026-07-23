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

export type OperationsOrderAction = 'release_to_warehouse' | 'confirm_picks' | 'verify_pack'

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
  line2?: string | null
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
  unitsPerPackage?: number
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

export type SmallParcelCarrier = 'UPS' | 'FedEx' | 'USPS' | 'MockCarrier'

export type CarrierProvider = 'ups_rest' | 'fedex_rest' | 'usps_rest' | 'rocketshipit' | 'mock'

export type CarrierCapability =
  | 'address_validation'
  | 'rating'
  | 'transit'
  | 'label'
  | 'void'
  | 'tracking'
  | 'manifest'
  | 'pickup'
  | 'customs_documents'
  | 'proof_of_delivery'
  | 'reconciliation'

export type CarrierAdapterDescriptor = {
  provider: CarrierProvider
  adapterVersion: string
  environment: 'mock' | 'sandbox' | 'production'
  carriers: readonly SmallParcelCarrier[]
  capabilities: readonly CarrierCapability[]
}

export type CarrierRate = {
  carrier: SmallParcelCarrier
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

export type CarrierRatePartyRole = 'platform_operator' | 'reseller' | 'shipper'

export type CarrierRateParty = {
  entityType: 'workspace_organization' | 'crm_customer'
  entityId: string
  globalId: string
  displayName: string
  role: CarrierRatePartyRole
}

export type CarrierRateMarkupDirective = {
  globalId: string
  priority: number
  type:
    | 'fixed_amount'
    | 'percent_markup'
    | 'cost_plus_percent'
    | 'minimum_charge'
    | 'maximum_charge'
  amountMinor?: bigint
  basisPoints?: number
}

export type CarrierRatePathGrant = {
  grantGlobalId: string
  grantorGlobalId: string
  granteeGlobalId: string
  directives: CarrierRateMarkupDirective[]
}

export type CarrierRatePathHop = {
  grantGlobalId: string
  grantor: CarrierRateParty
  grantee: CarrierRateParty
  upstreamBuyMinor: bigint
  markupMinor: bigint
  downstreamSellMinor: bigint
  directiveGlobalIds: string[]
}

export type CarrierRateSettlement = {
  type:
    | 'carrier_payable'
    | 'carrier_cost_reimbursement'
    | 'platform_fee'
    | 'reseller_fee'
  payerGlobalId: string
  payeeGlobalId: string
  amountMinor: bigint
  currency: string
  grantGlobalId: string | null
}

export type CarrierRatePartyMargin = {
  partyGlobalId: string
  role: 'platform_operator' | 'reseller'
  buyMinor: bigint
  sellMinor: bigint
  marginMinor: bigint
}

export type CarrierRatePathPricing = {
  currency: string
  carrierAccountGlobalId: string
  carrierAccountOwnerGlobalId: string
  carrierPayeeReference: string
  carrierCostMinor: bigint
  customerChargeMinor: bigint
  hops: CarrierRatePathHop[]
  settlements: CarrierRateSettlement[]
  margins: CarrierRatePartyMargin[]
}

export type CarrierAccountAddressVerification =
  | 'operator_attested'
  | 'provider_verified'

export type CarrierBillingRelationship =
  | 'sender'
  | 'recipient'
  | 'third_party'

export type CarrierAccountTenderIdentity = {
  carrierAccountGlobalId: string
  accountOwnerGlobalId: string
  accountAddress: Address
  accountAddressVerification: CarrierAccountAddressVerification
}

export type CarrierBillingSelection = {
  relationship: CarrierBillingRelationship
  carrierAccountGlobalId: string
  accountOwnerGlobalId: string
  matchedAddressSide: 'sender' | 'recipient' | null
  accountAddressVerification: CarrierAccountAddressVerification
  evidence: {
    senderMatched: boolean
    recipientMatched: boolean
    normalizationVersion: 'postal-address-v1'
  }
}

export type CarrierBillingChargeCategory =
  | 'transportation'
  | 'fuel_surcharge'
  | 'residential_surcharge'
  | 'delivery_area_surcharge'
  | 'address_correction'
  | 'dimensional_adjustment'
  | 'weight_adjustment'
  | 'signature'
  | 'saturday'
  | 'declared_value'
  | 'tax'
  | 'duty'
  | 'late_fee'
  | 'refund'
  | 'credit'
  | 'other'

export type CarrierBillingShipmentMatchStatus =
  | 'matched'
  | 'unmatched'
  | 'ambiguous'
  | 'rejected'

export type CarrierBillingShipperAssignmentStatus =
  | 'assigned'
  | 'unassigned'
  | 'ambiguous'
  | 'rejected'

export type CarrierBillingChargeLine = {
  externalChargeId: string
  statementGlobalId: string
  billedAccountFingerprint: string
  trackingNumber: string | null
  shipmentGlobalId: string | null
  shipmentMatchStatus: CarrierBillingShipmentMatchStatus
  assignedShipperGlobalId: string | null
  shipperAssignmentStatus: CarrierBillingShipperAssignmentStatus
  shipperAssignmentSource:
    | 'shipment_match'
    | 'manual'
    | 'routing_rule'
    | 'none'
  category: CarrierBillingChargeCategory
  amountMinor: bigint
  currency: string
}

export type CarrierBillingStatementGroupInput = {
  externalChargeId: string
  externalStatementId: string
  billedAccountMaskedReference: string
  billedAccountFingerprint: string
}

export type CarrierBillingStatementGroup = {
  externalStatementId: string
  billedAccountMaskedReference: string
  billedAccountFingerprint: string
  externalChargeIds: string[]
}

export type CarrierBillingShipperAssignment = {
  shipmentMatchStatus: CarrierBillingShipmentMatchStatus
  shipmentGlobalId: string | null
  shipperAssignmentStatus: CarrierBillingShipperAssignmentStatus
  assignedShipperGlobalId: string | null
  source: 'shipment_match' | 'manual' | 'routing_rule' | 'none'
  ruleGlobalId: string | null
  actorEmail: string | null
  reason: string | null
}

export type CarrierBillingReconciliation = {
  shipmentGlobalId: string
  currency: string
  status: 'pending' | 'provisional' | 'needs_review' | 'reconciled'
  quotedCarrierCostMinor: bigint
  actualCarrierCostMinor: bigint
  varianceMinor: bigint
  matchedChargeCount: number
  unresolvedCandidateCount: number
  assignmentExceptionCount: number
  chargeTotals: Array<{
    category: CarrierBillingChargeCategory
    amountMinor: bigint
  }>
  matchedExternalChargeIds: string[]
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

export type CarrierAddressValidationResult = {
  valid: boolean
  residential: boolean | null
  normalizedAddress: Address | null
  suggestions: Address[]
  providerPayload: Record<string, unknown>
}

export type CarrierTransitEstimate = {
  carrier: SmallParcelCarrier
  serviceCode: string
  serviceName: string
  transitDays: number
  estimatedDeliveryAt: string
  guaranteed: boolean | null
  providerPayload: Record<string, unknown>
}

export type CarrierVoidResult = {
  voided: boolean
  providerReference: string
  providerPayload: Record<string, unknown>
}

export type CarrierTrackingActivity = {
  status: string
  occurredAt: string
  location: string | null
  description: string
}

export type CarrierTrackingResult = {
  trackingNumber: string
  status: string
  estimatedDeliveryAt: string | null
  deliveredAt: string | null
  activities: CarrierTrackingActivity[]
  providerPayload: Record<string, unknown>
}

export type CarrierManifestResult = {
  providerManifestId: string
  format: 'PDF' | 'PNG'
  payload: string
  providerPayload: Record<string, unknown>
}

export type CarrierPickupResult = {
  providerPickupId: string
  status: string
  providerPayload: Record<string, unknown>
}

export type CarrierLabelReconciliationResult = {
  outcome: 'found' | 'not_found' | 'unknown'
  label: LabelResult | null
  providerPayload: Record<string, unknown>
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
  pickedPickTaskCount: number
  packageCount: number
  plannedPackageCount: number
  packedPackageCount: number
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
