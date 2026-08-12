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

export type CommerceActiveWriteCapability =
  | 'catalog_publishing'
  | 'inventory_export'
  | 'inventory_transfer_synchronization'
  | 'inventory_shipment_synchronization'
  | 'location_administration'
  | 'customer_export'
  | 'order_creation'
  | 'order_update'
  | 'order_edit'
  | 'draft_order_synchronization'
  | 'refund_export'
  | 'fulfillment_export'
  | 'third_party_fulfillment_orchestration'
  | 'fulfillment_service'
  | 'tracking_export'
  | 'shipping_rate_callbacks'
  | 'return_export'

export type OperationsOrderAction =
  | 'release_to_warehouse'
  | 'confirm_picks'
  | 'reconcile_external_fulfillment'
  | 'verify_pack'
  | 'prepare_fulfillment'
  | 'confirm_shipment'

export type OperationsOrderActionAvailability = {
  action: OperationsOrderAction
  label: string
  enabled: boolean
  blockedReason: string | null
}

export type OperationsExternalFulfillmentReconciliationResult = {
  orderGlobalId: string
  orderStatus: 'cancelled'
  rowVersion: number
  reconciliationGlobalId: string
  providerFulfillmentId: string
  providerFulfillmentName: string
  providerReads: 2
  providerWrites: 0
  replayed: boolean
}

export type OperationsLabelAttemptState = 'prepared' | 'succeeded' | 'failed' | 'unknown'

export type OperationsSandboxLabelCommandResult = {
  orderGlobalId: string
  orderStatus: 'packed'
  rowVersion: number
  packageGlobalId: string
  labelGlobalId: string
  attemptGlobalId: string
  trackingNumber: string
  labelStatus: 'created' | 'voided'
  replayed: boolean
  printJobGlobalId: string | null
  printWarning: string | null
}

export type OperationsShipmentCommandResult = {
  orderGlobalId: string
  orderStatus: 'shipped'
  rowVersion: number
  shipmentGlobalId: string
  trackingNumber: string
  packingSlipArtifactGlobalId: string
  commerceExportGlobalId: string
  commerceExportState:
    | 'succeeded'
    | 'unsupported'
    | 'failed'
  customerNotification: OperationsCustomerNotificationDecision
  replayed: boolean
  printJobGlobalId: string | null
  printWarning: string | null
}

export type OperationsCustomerNotificationDecision = {
  mode: 'clawpilot_explicit' | 'provider_managed'
  notifyCustomer: boolean | null
  source:
    | 'account_default'
    | 'order_override'
    | 'sandbox_e2e_suppression'
    | 'legacy_safe_default'
    | 'provider_managed'
  accountPolicyRevision: number | null
  overrideReason: string | null
  decidedBy: string | null
}

export type OperationsCommerceFulfillmentRetryResult = {
  commerceExportGlobalId: string
  state: 'succeeded' | 'unsupported' | 'failed'
  providerReference: string | null
  errorCode: string | null
  errorMessage: string | null
  customerNotification: OperationsCustomerNotificationDecision
  replayed: boolean
}

export type OperationsPackingSlipCommandResult = {
  orderGlobalId: string
  orderStatus: 'packed'
  rowVersion: number
  packageGlobalId: string
  packageNumber: number
  documentKind: 'pack_work_instruction' | 'legacy_prelabel_packing_list'
  documentStage:
    | 'pre_label_pack_work_instruction'
    | 'legacy_prelabel_packing_list'
  finalPackingSlip: false
  packingSlipArtifactGlobalId: string
  contentUrl: string
  replayed: boolean
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
  contents: Array<{
    lineExternalId: string
    quantity: number
  }>
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

export type OperationsShadowFulfillmentPreparationPackage = {
  packageKey: string
  sequence: number
  materialCode: string
  materialName: string
  dimensionsMm: Millimeters
  contentWeightGrams: number
  tareWeightGrams: number
  grossWeightGrams: number
  allocations: Array<{
    lineKey: string
    productGlobalId: string
    providerVariantId: string
    title: string
    quantity: number
  }>
}

export type OperationsShadowFulfillmentPreparationStage = {
  runGlobalId: string
  packageCount: number
  packages: OperationsShadowFulfillmentPreparationPackage[]
  selectedRate: {
    provider: 'ups_rest' | 'fedex_rest'
    serviceCode: string
    serviceName: string
    carrierCostMinor: string
    customerChargeMinor: string
    currency: string
  }
}

export type OperationsShadowFulfillmentPreparation = {
  executionGlobalId: string
  shipmentGroupGlobalId: string
  reconciliationGlobalId: string | null
  checkoutRateReceiptGlobalId: string
  preparedAt: string
  checkout: OperationsShadowFulfillmentPreparationStage
  fulfillment: OperationsShadowFulfillmentPreparationStage
  variance: {
    globalId: string
    packageCountDelta: number
    carrierCostVarianceMinor: string
    estimatedCheckoutVarianceMinor: string
    allocationChanged: boolean
    materialChanged: boolean
    serviceChanged: boolean
    causes: string[]
  }
  providerAttempts: Array<{
    provider: 'ups_rest' | 'fedex_rest'
    carrierAccountGlobalId: string
    carrierAccountName: string
    rateEvidenceGlobalId: string
    environment: 'sandbox'
    status: 'succeeded' | 'degraded'
    failureCode: string | null
    selected: boolean
  }>
  effects: {
    providerWriteCount: 0
    postagePurchaseCount: 0
    labelWriteCount: 0
    commerceWriteCount: 0
  }
}

export type OperationsOrderDetail = OperationsOrderListItem & {
  oneOffShippingMode: 'test' | 'live' | null
  externalOrderId: string
  currency: string
  rowVersion: number
  warehouseId: string | null
  planStatus: string | null
  waveStatus: string | null
  pickTaskCount: number
  readyPickTaskCount: number
  pickedPickTaskCount: number
  packageCount: number
  plannedPackageCount: number
  packedPackageCount: number
  shopifyExternalFulfillmentReconciliationRequired: boolean
  availableActions: OperationsOrderActionAvailability[]
  sandboxCommerceE2eAuthorization: {
    authorizationGlobalId: string
    authorizedAt: string
    expiresAt: string
  } | null
  fulfillmentPreparation: OperationsShadowFulfillmentPreparation | null
  planningPreparation: {
    accountGlobalId: string
    candidateGlobalId: string
    candidateRowVersion: number
  } | null
  fulfillmentNotificationPolicy:
    | {
      mode: 'clawpilot_explicit'
      notifyCustomerDefault: boolean
      revision: number
    }
    | {
      mode: 'provider_managed'
      notifyCustomerDefault: null
      revision: 0
    }
    | {
      mode: 'unavailable'
      notifyCustomerDefault: null
      revision: 0
    }
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
    contents: Array<{
      globalId: string
      orderLineGlobalId: string
      productGlobalId: string
      productName: string
      channelSku: string
      quantity: number
    }>
    latestLabel: {
      globalId: string
      status: 'created' | 'voided' | 'failed'
      carrier: string
      serviceCode: string
      trackingNumber: string
      environment: 'mock' | 'sandbox' | 'production'
      createAttemptGlobalId: string | null
      voidAttemptGlobalId: string | null
      createdAt: string
      voidedAt: string | null
    } | null
  }>
  rates: Array<{
    globalId: string
    carrier: string
    serviceCode: string
    serviceName: string
    internalCostMinor: string
    customerChargeMinor: string | null
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
  labelAttempts: Array<{
    globalId: string
    action: 'create' | 'void' | 'reconcile'
    state: OperationsLabelAttemptState
    provider: 'ups_rest' | 'fedex_rest'
    environment: 'sandbox' | 'production'
    errorCode: string | null
    labelGlobalId: string | null
    requestedAt: string
    completedAt: string | null
  }>
  shipments: Array<{
    globalId: string
    status: 'confirmed' | 'in_transit' | 'delivered' | 'exception' | 'voided'
    carrier: string
    serviceCode: string
    trackingNumber: string
    quotedCarrierCostMinor: string
    oneOffCarrierGroupGlobalId: string | null
    shippedAt: string
  }>
  trackingObservations: Array<{
    globalId: string
    shipmentGlobalId: string
    status: 'confirmed' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception' | 'voided'
    provider: string
    source: 'shipment_confirmation' | 'carrier_webhook' | 'carrier_poll' | 'manual'
    location: string | null
    observedAt: string
  }>
  printArtifacts: Array<{
    globalId: string
    packageGlobalId: string | null
    shipmentGlobalId: string | null
    documentType: 'shipping_label' | 'packing_slip'
    documentKind:
      | 'shipping_label'
      | 'final_packing_slip'
      | 'pack_work_instruction'
      | 'legacy_prelabel_packing_list'
    format: 'ZPL' | 'PDF' | 'PNG'
    media: 'label_4x6' | 'label_4x8' | 'letter' | 'a4'
    filename: string | null
    contentUrl: string | null
    createdAt: string
  }>
  commerceExports: Array<{
    globalId: string
    shipmentGlobalId: string
    provider: string
    state:
      | 'queued'
      | 'processing'
      | 'succeeded'
      | 'failed'
      | 'unsupported'
    attempts: number
    providerReference: string | null
    errorCode: string | null
    errorMessage: string | null
    requestedAt: string
    completedAt: string | null
    customerNotification: OperationsCustomerNotificationDecision
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
  warehouses: Array<{
    id: string
    globalId: string
    code: string
    name: string
    facilityType: 'distribution_center' | 'store' | 'dark_store' | 'micro_fulfillment' | 'cross_dock' | 'supplier' | 'drop_ship' | 'third_party'
    timezone: string
    address: Address
    status: 'active' | 'inactive'
    cutoffTime: string | null
    carrierCutoffs: Record<string, string>
    operatingDays: number[]
    opensAt: string
    closesAt: string
    standardProcessingMinutes: number
    dailyOrderCapacity: number | null
    rowVersion: number
    locations: Array<{
      id: string
      globalId: string
      code: string
      zone: string
      locationType: 'receiving' | 'storage' | 'pick' | 'pack' | 'staging' | 'shipping' | 'returns'
      topologyLevel: 'building' | 'zone' | 'aisle' | 'row' | 'bay' | 'level' | 'shelf' | 'bin' | 'staging' | 'dock' | 'station'
      parentLocationGlobalId: string | null
      pickSequence: number
      active: boolean
      storageFunction: 'work_area' | 'reserve' | 'bulk' | 'forward_pick' | 'mezzanine_pick' | 'flow_rack' | 'staging'
      maxVolumeCubicMeters: number | null
      maxWeightKg: number | null
      usedVolumeCubicMeters: number
      usedWeightKg: number
      allowMixedProducts: boolean
      notes: string | null
      rowVersion: number
      productRules: Array<{
        globalId: string
        productGlobalId: string
        productName: string
        ruleType: 'allowed' | 'preferred' | 'restricted'
        maxQuantity: number | null
        replenishmentMode: 'disabled' | 'min_max' | 'order_demand'
        replenishmentSourceLocationGlobalId: string | null
        replenishmentSourceLocationCode: string | null
        minQuantity: number | null
        targetQuantity: number | null
        active: boolean
      }>
    }>
  }>
  replenishmentRecommendations: Array<{
    warehouseGlobalId: string
    warehouseName: string
    productGlobalId: string
    productName: string
    productSku: string | null
    inventoryPoolGlobalId: string
    inventoryPoolName: string
    sourceLocationGlobalId: string
    sourceLocationCode: string
    destinationLocationGlobalId: string
    destinationLocationCode: string
    replenishmentMode: 'min_max' | 'order_demand'
    availableAtSource: number
    availableAtDestination: number
    releasedDemand: number
    minQuantity: number | null
    targetQuantity: number
    recommendedQuantity: number
    explanation: string
  }>
  inventoryPools: Array<{
    id: string
    globalId: string
    name: string
    poolType: 'customer_dedicated' | 'shared'
    allocationPolicy: 'fifo' | 'fefo' | 'priority'
    ownerCustomerGlobalId: string | null
    ownerCustomerName: string | null
    eligibleCustomers: Array<{ globalId: string; name: string; priority: number }>
    active: boolean
  }>
  inboundReceipts: Array<{
    id: string
    globalId: string
    referenceNumber: string
    status: 'expected' | 'receiving' | 'completed' | 'cancelled'
    warehouseGlobalId: string
    warehouseName: string
    inventoryPoolGlobalId: string
    inventoryPoolName: string
    expectedAt: string | null
    completedAt: string | null
    rowVersion: number
    expectedQuantity: number
    receivedQuantity: number
    damagedQuantity: number
    lines: Array<{
      id: string
      globalId: string
      lineNumber: number
      productGlobalId: string
      productName: string
      productSku: string | null
      targetLocationGlobalId: string
      targetLocationCode: string
      expectedQuantity: number
      acceptedQuantity: number
      damagedQuantity: number
      lotCode: string
      unitOfMeasure: string
    }>
  }>
  catalog: {
    customers: Array<{ id: string; globalId: string; name: string }>
    products: Array<{ id: string; globalId: string; name: string; sku: string | null }>
  }
  shipping: {
    sandboxCarrierAccounts: Array<{
      globalId: string
      provider: 'ups_rest' | 'fedex_rest'
      displayName: string
      accountNumberLastFour: string
      billingRelationships: CarrierBillingRelationship[]
    }>
  }
  generatedAt: string
}

export type OperationsInventoryPoolInput = {
  name: string
  poolType: 'customer_dedicated' | 'shared'
  allocationPolicy: 'fifo' | 'fefo' | 'priority'
  ownerCustomerGlobalId: string | null
  eligibleCustomerGlobalIds: string[]
}

export type OperationsInboundReceiptInput = {
  warehouseGlobalId: string
  inventoryPoolGlobalId: string
  referenceNumber: string
  expectedAt: string | null
  lines: Array<{
    productGlobalId: string
    targetLocationGlobalId?: string | null
    expectedQuantity: number
    lotCode: string
    unitOfMeasure: string
  }>
}

export type OperationsPutawayPlacement = {
  lineGlobalId: string
  productGlobalId: string
  targetLocationGlobalId: string
  targetLocationCode: string
  strategy: 'manual' | 'preferred_rule' | 'same_product' | 'route_order'
  explanation: string
  projectedVolumeCubicMeters: number | null
  projectedWeightKg: number | null
}

export type OperationsInboundReceiptCreationResult = {
  receiptGlobalId: string
  status: 'expected'
  rowVersion: number
  expectedQuantity: number
  placements: OperationsPutawayPlacement[]
  replayed: boolean
}

export type OperationsInboundReceiptCompletionInput = {
  receiptGlobalId: string
  expectedRowVersion: number
  reason: string
  lines: Array<{
    lineGlobalId: string
    acceptedQuantity: number
    damagedQuantity: number
  }>
}

export type OperationsInboundReceiptCommandResult = {
  receiptGlobalId: string
  status: 'completed'
  rowVersion: number
  receivedQuantity: number
  damagedQuantity: number
  positionGlobalIds: string[]
  replayed: boolean
}

export type OperationsReplenishmentExecutionInput = {
  sourceLocationGlobalId: string
  destinationLocationGlobalId: string
  inventoryPoolGlobalId: string
  productGlobalId: string
  quantity: number
}

export type OperationsReplenishmentExecutionResult = {
  replenishmentTaskGlobalId: string
  status: 'completed'
  warehouseGlobalId: string
  productGlobalId: string
  inventoryPoolGlobalId: string
  sourceLocationGlobalId: string
  sourceLocationCode: string
  destinationLocationGlobalId: string
  destinationLocationCode: string
  movedQuantity: number
  sourceAvailableAfter: number
  destinationAvailableAfter: number
  replayed: boolean
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

export type OperationsPlanCommandResult = OperationsOrderCommandResult & {
  orderStatus: 'planned'
  fulfillmentPlanGlobalId: string
  cartonizationEvidenceGlobalId: string
  packageCount: number
  carrier: string
  serviceCode: string
  serviceName: string
  carrierCostMinor: number
  currency: string
  checkoutShippingChargeMinor: number | null
  checkoutVarianceMinor: number | null
}

export type OperationsShadowFulfillmentExecutionResult = {
  orderGlobalId: string
  orderStatus: 'packed'
  rowVersion: number
  fulfillmentExecutionGlobalId: string
  shipmentGroupGlobalId: string
  checkoutRateReceiptGlobalId: string
  checkoutPackRateRunGlobalId: string
  fulfillmentPackRateRunGlobalId: string
  varianceGlobalId: string
  packageCount: number
  carrier: 'UPS' | 'FedEx'
  provider: 'ups_rest' | 'fedex_rest'
  serviceCode: string
  serviceName: string
  carrierCostMinor: number
  checkoutShippingChargeMinor: number
  carrierCostVarianceMinor: number
  estimatedCheckoutVarianceMinor: number
  currency: string
  providerAttempts: Array<{
    provider: 'ups_rest' | 'fedex_rest'
    carrierAccountGlobalId: string
    status: 'succeeded' | 'degraded'
    failureCode: string | null
    rateEvidenceGlobalId: string
  }>
  providerWriteCount: 0
  postagePurchaseCount: 0
  labelWriteCount: 0
  commerceWriteCount: 0
  replayed: boolean
}

export type OperationsExceptionUpdateResult = {
  exception: OperationsExceptionListItem
  changed: boolean
}

export type OperationsActivationUpdateResult = OperationsWorkspace['activation'] & {
  dataPipeline: OperationsWorkspace['dataPipeline']
}

export type OperationsCommerceActivePreparationResult = {
  preparationGlobalId: string
  cohortHash: string
  expectedActivationState: 'shadow'
  expectedActivationRevision: number
  targetActivationState: 'active'
  targetActivationRevision: number
  accounts: Array<{
    accountGlobalId: string
    provider: 'shopify' | 'faire'
    environment: 'sandbox' | 'production'
    externalAccountId: string
    credentialGeneration: number
    authMode: string
    priorAccountStatus: 'active' | 'disabled'
    targetAccountStatus: 'active'
    grantedScopes: string[]
    grantedScopeDigest: string
    writeCapabilities: CommerceActiveWriteCapability[]
    capabilityDigest: string
  }>
  preparedBy: string
  preparedRole: 'owner' | 'admin'
  preparedAt: string
  replayed: boolean
}

export type OperationsCommerceActiveTransitionResult = {
  authorization: {
    authorizationGlobalId: string
    preparationGlobalId: string
    cohortHash: string
    confirmationStatementVersion: 'commerce-active-transition-v1'
    authorizedBy: string
    authorizedRole: 'owner' | 'admin'
    authorizedAt: string
    expiresAt: string
    replayed: boolean
  }
  transition: {
    transitionGlobalId: string
    preparationGlobalId: string
    authorizationGlobalId: string
    cohortHash: string
    fromActivationState: 'shadow'
    fromActivationRevision: number
    state: 'active'
    revision: number
    accountCount: number
    capabilityCount: number
    reason: string | null
    activatedBy: string
    activatedRole: 'owner' | 'admin'
    activatedAt: string
    replayed: boolean
  }
}
