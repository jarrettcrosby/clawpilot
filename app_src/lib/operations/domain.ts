import type {
  Address,
  CarrierAccountTenderIdentity,
  CarrierBillingSelection,
  CarrierRateMarkupDirective,
  CarrierRateParty,
  CarrierRatePathGrant,
  CarrierRatePathPricing,
  CarrierBillingChargeLine,
  CarrierBillingReconciliation,
  CarrierBillingShipperAssignment,
  CarrierBillingStatementGroup,
  CarrierBillingStatementGroupInput,
  CarrierRate,
  ChargeBreakdown,
  CommerceOrderLineInput,
  EstimatedCharges,
  FulfillmentOptimizer,
  OperationsActivationState,
  OperationsOrderActionAvailability,
  OperationsOrderStatus,
  OptimizationRequest,
  OptimizationResult,
  PackagePlan,
  PricedCarrierRate,
  PricingDirective,
} from '@/lib/operations/types'

export function availableOperationsOrderActions(input: {
  status: OperationsOrderStatus
  sourceProvider?: string
  orderType?: string
  oneOffShippingMode?: 'test' | 'live' | null
  activationState: OperationsActivationState
  canExecute: boolean
  canManage?: boolean
  canPurchaseLivePostage?: boolean
  fulfillmentWritesEnabled?: boolean
  fulfillmentWritesBlockedReason?: string | null
  planStatus: string | null
  waveStatus: string | null
  lineCount: number
  fullyReservedLineCount: number
  allocatedLineCount: number
  pickTaskCount: number
  readyPickTaskCount: number
  pickedPickTaskCount: number
  packageCount: number
  plannedPackageCount: number
  packedPackageCount: number
  openExceptionCount?: number
  blockingExceptionCount: number
  shadowPreparationReady?: boolean
  shadowPreparationBlockedReason?: string | null
  activeLabelCount?: number
  shippableLabelCount?: number
  sandboxLabelCount?: number
  unresolvedLabelAttemptCount?: number
  existingShipmentCount?: number
  sandboxE2eAuthorized?: boolean
  sandboxE2eAuthorityKind?: 'legacy_packed' | 'shopify_test_store_canonical' | null
  sandboxE2eFulfillmentConfirmed?: boolean
  nativeOneOffGroupReady?: boolean
  nativeOneOffGroupBlockedReason?: string | null
  shopifyExternalFulfillmentReconciliationRequired?: boolean
  replanningCorrection?: OperationsOrderActionAvailability | null
}): OperationsOrderActionAvailability[] {
  const canonicalShopifyAuthorized =
    input.sandboxE2eAuthorityKind === 'shopify_test_store_canonical'
  let releaseBlockedReason: string | null = null
  if (!input.canExecute) {
    releaseBlockedReason = 'Operations execute permission is required.'
  } else if (input.status !== 'planned') {
    releaseBlockedReason = input.status === 'released' || input.status === 'picking'
      ? 'This order is already released to warehouse execution.'
      : 'The order must have a completed fulfillment plan before release.'
  } else if (input.planStatus !== 'planned') {
    releaseBlockedReason = 'The latest fulfillment plan is not ready for release.'
  } else if (input.lineCount < 1 || input.fullyReservedLineCount !== input.lineCount) {
    releaseBlockedReason = 'Every order line must have an active reservation before release.'
  } else if (input.allocatedLineCount !== input.lineCount) {
    releaseBlockedReason = 'Every order line must be allocated to the fulfillment plan before release.'
  } else if (input.blockingExceptionCount > 0) {
    releaseBlockedReason = 'Resolve high or critical order exceptions before release.'
  }

  let pickBlockedReason: string | null = null
  if (!input.canExecute) {
    pickBlockedReason = 'Operations execute permission is required.'
  } else if (input.status !== 'released') {
    pickBlockedReason = input.status === 'picking'
      ? 'Every pick on this wave is already confirmed.'
      : 'Release the order to warehouse execution before confirming picks.'
  } else if (input.planStatus !== 'released' || input.waveStatus !== 'released') {
    pickBlockedReason = 'The fulfillment plan and wave must both be released before picking.'
  } else if (input.shopifyExternalFulfillmentReconciliationRequired) {
    pickBlockedReason = 'Newer Shopify evidence no longer supports this provider commitment. Reconcile the external fulfillment before picking.'
  } else if (input.pickTaskCount < 1 || input.readyPickTaskCount !== input.pickTaskCount) {
    pickBlockedReason = 'Every pick task must be ready before confirming this wave.'
  } else if (input.blockingExceptionCount > 0) {
    pickBlockedReason = 'Resolve high or critical order exceptions before confirming picks.'
  }

  let externalFulfillmentBlockedReason: string | null = null
  if (input.canManage !== true) {
    externalFulfillmentBlockedReason = 'Operations manage permission is required.'
  } else if (!input.canExecute) {
    externalFulfillmentBlockedReason = 'Operations execute permission is required.'
  } else if (input.sourceProvider !== 'shopify') {
    externalFulfillmentBlockedReason = 'External fulfillment reconciliation requires a Shopify order.'
  } else if (!input.shopifyExternalFulfillmentReconciliationRequired) {
    externalFulfillmentBlockedReason = 'No newer Shopify evidence requires external fulfillment reconciliation.'
  } else if (input.status !== 'released') {
    externalFulfillmentBlockedReason = 'Only a released order can be reconciled as externally fulfilled.'
  } else if (input.planStatus !== 'released' || input.waveStatus !== 'released') {
    externalFulfillmentBlockedReason = 'The fulfillment plan and wave must both remain released.'
  } else if (
    input.pickTaskCount < 1
    || input.readyPickTaskCount !== input.pickTaskCount
    || input.pickedPickTaskCount !== 0
  ) {
    externalFulfillmentBlockedReason = 'Every warehouse pick must remain ready and wholly unpicked.'
  }

  let packBlockedReason: string | null = null
  if (!input.canExecute) {
    packBlockedReason = 'Operations execute permission is required.'
  } else if (input.status !== 'picking') {
    packBlockedReason = input.status === 'packed' || input.status === 'shipped'
      ? 'Package verification is already complete.'
      : 'Confirm every pick before verifying packages.'
  } else if (input.planStatus !== 'released' || input.waveStatus !== 'completed') {
    packBlockedReason = 'The fulfillment plan must be released and its wave completed before packing.'
  } else if (input.pickTaskCount < 1 || input.pickedPickTaskCount !== input.pickTaskCount) {
    packBlockedReason = 'Every pick task must be complete before verifying packages.'
  } else if (input.packageCount < 1 || input.plannedPackageCount !== input.packageCount) {
    packBlockedReason = input.packedPackageCount === input.packageCount
      ? 'Package verification is already complete.'
      : 'Every package must be in the planned state before verification.'
  } else if (input.blockingExceptionCount > 0) {
    packBlockedReason = 'Resolve high or critical order exceptions before verifying packages.'
  }

  const isNativeOneOff = input.sourceProvider === 'clawpilot_native'
    && input.orderType === 'one_off'
  let shipmentBlockedReason: string | null = null
  if (!input.canExecute) {
    shipmentBlockedReason = 'Operations execute permission is required.'
  } else if (
    ['shopify', 'faire'].includes(input.sourceProvider || '')
    && input.fulfillmentWritesEnabled !== true
  ) {
    shipmentBlockedReason = input.fulfillmentWritesBlockedReason
      || `Reconnect the ${input.sourceProvider === 'faire' ? 'Faire' : 'Shopify'} connection and verify its fulfillment-write scopes before confirming shipment.`
  } else if (
    isNativeOneOff
    && input.oneOffShippingMode === 'live'
    && input.canPurchaseLivePostage !== true
  ) {
    shipmentBlockedReason = 'Live-postage permission is required to confirm LIVE postage.'
  } else if (isNativeOneOff && !input.oneOffShippingMode) {
    shipmentBlockedReason = 'Select TEST or LIVE and create the exact one-off shipment group first.'
  } else if ((input.existingShipmentCount || 0) > 0 || input.status === 'shipped') {
    shipmentBlockedReason = 'This order already has a confirmed shipment.'
  } else if (input.status !== 'packed') {
    shipmentBlockedReason = 'Verify the package before confirming shipment.'
  } else if (input.planStatus !== 'released' || input.waveStatus !== 'completed') {
    shipmentBlockedReason = 'The fulfillment plan must be released and its wave completed before shipment.'
  } else if (
    input.sandboxE2eAuthorized || isNativeOneOff
      ? input.packageCount < 1 || input.packedPackageCount !== input.packageCount
      : input.packageCount !== 1 || input.packedPackageCount !== 1
  ) {
    shipmentBlockedReason = isNativeOneOff
      ? 'Every package in the one-off shipment must be verified before confirmation.'
      : input.sandboxE2eAuthorized
        ? 'Authorized sandbox E2E completion requires every package to be verified.'
        : 'This shipment-completion slice requires exactly one verified package.'
  } else if (isNativeOneOff && input.nativeOneOffGroupReady !== true) {
    shipmentBlockedReason = input.nativeOneOffGroupBlockedReason
      || 'Purchase one complete one-off carrier group before confirming shipment.'
  } else if ((input.unresolvedLabelAttemptCount || 0) > 0) {
    shipmentBlockedReason = 'Resolve the pending carrier label attempt before confirming shipment.'
  } else if (
    canonicalShopifyAuthorized
    && input.sandboxE2eFulfillmentConfirmed !== true
  ) {
    shipmentBlockedReason = 'Confirm this exact Shopify test fulfillment before creating fulfillmentCreate.'
  } else if (isNativeOneOff) {
    // Exact TEST/LIVE environment, selected-rate authority, group membership,
    // result, and active-label coverage are verified by the durable group read.
    shipmentBlockedReason = input.blockingExceptionCount > 0
      ? 'Resolve high or critical order exceptions before confirming shipment.'
      : null
  } else if (
    (input.activeLabelCount || 0)
      !== (input.sandboxE2eAuthorized ? input.packageCount : 1)
  ) {
    shipmentBlockedReason = input.sandboxE2eAuthorized
      ? 'Create exactly one active sandbox carrier label for every package before confirming shipment.'
      : 'Create exactly one active carrier label before confirming shipment.'
  } else if (
    input.sandboxE2eAuthorized
    && (input.sandboxLabelCount || 0) !== input.packageCount
  ) {
    shipmentBlockedReason = 'Authorized sandbox E2E completion requires sandbox labels for every package.'
  } else if (!input.sandboxE2eAuthorized && (input.sandboxLabelCount || 0) > 0) {
    shipmentBlockedReason = 'Sandbox labels are test evidence only. Void the label; they cannot confirm shipment.'
  } else if (!input.sandboxE2eAuthorized && (input.shippableLabelCount || 0) !== 1) {
    shipmentBlockedReason = 'A mock proof or production carrier label is required before shipment.'
  } else if (input.blockingExceptionCount > 0) {
    shipmentBlockedReason = 'Resolve high or critical order exceptions before confirming shipment.'
  }

  let preparationBlockedReason: string | null = null
  if (!input.canExecute) {
    preparationBlockedReason = 'Operations execute permission is required.'
  } else if (input.activationState !== 'shadow') {
    preparationBlockedReason = 'Shipment preparation is available only in Operations Shadow.'
  } else if (input.sourceProvider !== 'shopify') {
    preparationBlockedReason = 'Shadow shipment preparation currently requires a Shopify order.'
  } else if (input.status !== 'packed') {
    preparationBlockedReason = 'Verify every package before preparing shipment execution.'
  } else if (input.planStatus !== 'released') {
    preparationBlockedReason = 'The latest fulfillment plan must remain released.'
  } else if (
    input.packageCount < 1
    || input.packedPackageCount !== input.packageCount
  ) {
    preparationBlockedReason = 'Every physical package must be packed.'
  } else if ((input.openExceptionCount || 0) > 0) {
    preparationBlockedReason = 'Resolve all order exceptions before preparing shipment execution.'
  } else if (input.shadowPreparationReady !== true) {
    preparationBlockedReason = input.shadowPreparationBlockedReason
      || 'Exact checkout, carton, allocation, and UPS/FedEx sandbox evidence is required.'
  }

  const actions: OperationsOrderActionAvailability[] = [
    {
      action: 'release_to_warehouse',
      label: 'Release to warehouse',
      enabled: releaseBlockedReason === null,
      blockedReason: releaseBlockedReason,
    },
    {
      action: 'confirm_picks',
      label: 'Confirm all picks',
      enabled: pickBlockedReason === null,
      blockedReason: pickBlockedReason,
    },
    {
      action: 'reconcile_external_fulfillment',
      label: 'Reconcile Shopify fulfillment',
      enabled: externalFulfillmentBlockedReason === null,
      blockedReason: externalFulfillmentBlockedReason,
    },
    {
      action: 'verify_pack',
      label: 'Verify packages',
      enabled: packBlockedReason === null,
      blockedReason: packBlockedReason,
    },
    {
      action: 'prepare_fulfillment',
      label: 'Prepare shipment in Shadow',
      enabled: preparationBlockedReason === null,
      blockedReason: preparationBlockedReason,
    },
    {
      action: 'confirm_shipment',
      label: 'Confirm shipment',
      enabled: shipmentBlockedReason === null,
      blockedReason: shipmentBlockedReason,
    },
  ]
  if (input.replanningCorrection) actions.push(input.replanningCorrection)
  return actions
}

export function operationsOrderReplanningProfileAllowsCorrection() {
  return true
}

export function operationsOrderReplanningActionAvailability(input: {
  activationState: OperationsActivationState
  canManage: boolean
  canExecute: boolean
  sourceProvider: string
  orderType: string
  status: OperationsOrderStatus
  planStatus: string | null
  waveStatus: string | null
  exactStateReady: boolean
  exactStateBlockedCode?: string | null
  exactStateBlockedReason?: string | null
  expectedPlanGlobalId?: string | null
  expectedPlanVersion?: number | null
  expectedCorrectionFingerprint?: string | null
}): OperationsOrderActionAvailability {
  let blockedCode: string | null = null
  let blockedReason: string | null = null
  if (!input.canManage) {
    blockedCode = 'OPERATIONS_MANAGE_REQUIRED'
    blockedReason = 'Operations manage permission is required.'
  } else if (!input.canExecute) {
    blockedCode = 'OPERATIONS_EXECUTE_REQUIRED'
    blockedReason = 'Operations execute permission is required.'
  } else if (!['shopify', 'faire'].includes(input.sourceProvider)) {
    blockedCode = 'OPERATIONS_REPLANNING_PROVIDER_INVALID'
    blockedReason = 'Only a connected Shopify or Faire order can be reopened for replanning.'
  } else if (input.orderType === 'one_off' || input.sourceProvider === 'clawpilot_native') {
    blockedCode = 'OPERATIONS_REPLANNING_ORDER_TYPE_INVALID'
    blockedReason = 'Native one-off and mock orders use their own correction workflow.'
  } else if (input.status === 'released') {
    blockedCode = 'OPERATIONS_REPLANNING_RELEASED_RECALL_REQUIRED'
    blockedReason = 'Released work cannot be reopened until ClawPilot can recall and receive acknowledgement from every picker device holding this wave.'
  } else if (input.status !== 'planned') {
    blockedCode = 'OPERATIONS_REPLANNING_STATUS_INVALID'
    blockedReason = 'Only a planned order that has not been released to pickers can be reopened.'
  } else if (
    input.planStatus !== 'planned'
    || input.waveStatus !== null
  ) {
    blockedCode = 'OPERATIONS_REPLANNING_PLAN_STATE_INVALID'
    blockedReason = 'The current planned order has already entered warehouse release state.'
  } else if (!input.exactStateReady) {
    blockedCode = input.exactStateBlockedCode || 'OPERATIONS_REPLANNING_STATE_INVALID'
    blockedReason = input.exactStateBlockedReason
      || 'Warehouse or execution evidence prevents this order from being reopened safely.'
  } else if (
    !input.expectedPlanGlobalId
    || !Number.isSafeInteger(input.expectedPlanVersion)
    || Number(input.expectedPlanVersion) < 1
    || !/^[a-f0-9]{64}$/.test(input.expectedCorrectionFingerprint || '')
  ) {
    blockedCode = 'OPERATIONS_REPLANNING_FINGERPRINT_UNAVAILABLE'
    blockedReason = 'Refresh the order before reopening it for replanning.'
  }

  const enabled = blockedReason === null
  return {
    action: 'reopen_for_replanning',
    label: 'Reopen for replanning',
    enabled,
    blockedCode,
    blockedReason,
    consequenceSummary: enabled
      ? 'Cancels the unreleased local plan, releases active inventory and packaging claims, and returns the unchanged provider order to Imported. No carrier or storefront calls are made.'
      : null,
    expectedPlanGlobalId: input.expectedPlanGlobalId || null,
    expectedPlanVersion: input.expectedPlanVersion || null,
    expectedCorrectionFingerprint: enabled
      ? input.expectedCorrectionFingerprint || null
      : null,
  }
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

function decimal(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function assertCurrency(value: string): string {
  const currency = String(value || '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('OPERATIONS_CURRENCY_INVALID')
  return currency
}

export function assertPositiveQuantity(value: unknown): number {
  const quantity = decimal(value)
  if (!(quantity > 0) || Math.round(quantity * 1_000_000) !== quantity * 1_000_000) {
    throw new Error('OPERATIONS_QUANTITY_INVALID')
  }
  return quantity
}

export function cartonizeSinglePackage(lines: CommerceOrderLineInput[]): PackagePlan[] {
  if (!lines.length) throw new Error('OPERATIONS_ORDER_LINES_REQUIRED')
  const aggregate = lines.reduce((result, line) => {
    const quantity = assertPositiveQuantity(line.quantity)
    const unitsPerPackage = Math.max(1, integer(line.unitsPerPackage, 1))
    const packageQuantity = Math.ceil(quantity / unitsPerPackage)
    result.weight += Math.max(0, integer(line.weightGrams)) * packageQuantity
    result.length = Math.max(result.length, Math.max(1, integer(line.dimensionsMm.length, 100)))
    result.width = Math.max(result.width, Math.max(1, integer(line.dimensionsMm.width, 100)))
    result.height += Math.max(1, integer(line.dimensionsMm.height, 100)) * packageQuantity
    result.ids.push(line.externalLineId)
    result.contents.push({
      lineExternalId: line.externalLineId,
      quantity,
    })
    return result
  }, {
    weight: 0,
    length: 1,
    width: 1,
    height: 0,
    ids: [] as string[],
    contents: [] as PackagePlan['contents'],
  })

  return [{
    packageNumber: 1,
    dimensionsMm: {
      length: aggregate.length,
      width: aggregate.width,
      height: Math.max(1, Math.ceil(aggregate.height)),
    },
    weightGrams: Math.ceil(aggregate.weight),
    lineExternalIds: aggregate.ids,
    contents: aggregate.contents,
  }]
}

export function addCalendarDays(instant: string | Date, days: number): string {
  const date = instant instanceof Date ? new Date(instant) : new Date(instant)
  if (Number.isNaN(date.getTime())) throw new Error('OPERATIONS_DATE_INVALID')
  date.setUTCDate(date.getUTCDate() + Math.max(0, Math.floor(days)))
  return date.toISOString()
}

export function selectPromiseRate(rates: PricedCarrierRate[]): PricedCarrierRate {
  const eligible = rates
    .filter((rate) => rate.meetsPromise)
    .sort((left, right) => {
      if (left.internalCostMinor !== right.internalCostMinor) {
        return left.internalCostMinor < right.internalCostMinor ? -1 : 1
      }
      if (left.transitDays !== right.transitDays) return left.transitDays - right.transitDays
      return `${left.carrier}:${left.serviceCode}`.localeCompare(`${right.carrier}:${right.serviceCode}`)
    })
  if (!eligible[0]) throw new Error('OPERATIONS_PROMISE_UNAVAILABLE')
  return eligible[0]
}

function minor(value: unknown): bigint {
  const parsed = integer(value)
  if (parsed < 0) throw new Error('OPERATIONS_PRICE_INVALID')
  return BigInt(parsed)
}

function percentageAmount(baseMinor: bigint, basisPoints: number): bigint {
  if (basisPoints < 0) throw new Error('OPERATIONS_PRICE_INVALID')
  return (baseMinor * BigInt(basisPoints) + BigInt(5_000)) / BigInt(10_000)
}

function assertNonNegativeMinor(value: bigint): bigint {
  if (value < BigInt(0)) throw new Error('OPERATIONS_RATE_PATH_PRICE_INVALID')
  return value
}

function sortedRateMarkupDirectives(
  directives: CarrierRateMarkupDirective[],
): CarrierRateMarkupDirective[] {
  return [...directives].sort((left, right) => (
    left.priority - right.priority || left.globalId.localeCompare(right.globalId)
  ))
}

function priceRatePathHop(
  upstreamBuyMinor: bigint,
  directives: CarrierRateMarkupDirective[],
): {
  downstreamSellMinor: bigint
  directiveGlobalIds: string[]
} {
  assertNonNegativeMinor(upstreamBuyMinor)
  let additiveMinor = BigInt(0)
  let minimumMinor: bigint | null = null
  let maximumMinor: bigint | null = null
  const ordered = sortedRateMarkupDirectives(directives)

  for (const directive of ordered) {
    switch (directive.type) {
      case 'fixed_amount':
        additiveMinor += assertNonNegativeMinor(directive.amountMinor ?? BigInt(0))
        break
      case 'percent_markup':
      case 'cost_plus_percent':
        additiveMinor += percentageAmount(upstreamBuyMinor, integer(directive.basisPoints))
        break
      case 'minimum_charge':
        minimumMinor = assertNonNegativeMinor(directive.amountMinor ?? BigInt(0))
        break
      case 'maximum_charge':
        maximumMinor = assertNonNegativeMinor(directive.amountMinor ?? BigInt(0))
        break
    }
  }

  if (minimumMinor !== null && maximumMinor !== null && minimumMinor > maximumMinor) {
    throw new Error('OPERATIONS_RATE_PATH_BOUNDS_INVALID')
  }

  let downstreamSellMinor = upstreamBuyMinor + additiveMinor
  if (minimumMinor !== null && downstreamSellMinor < minimumMinor) {
    downstreamSellMinor = minimumMinor
  }
  if (maximumMinor !== null && downstreamSellMinor > maximumMinor) {
    downstreamSellMinor = maximumMinor
  }
  if (downstreamSellMinor < upstreamBuyMinor) {
    throw new Error('OPERATIONS_RATE_PATH_NEGATIVE_MARGIN')
  }

  return {
    downstreamSellMinor,
    directiveGlobalIds: ordered.map((directive) => directive.globalId),
  }
}

function assertRatePathPartySequence(parties: CarrierRateParty[]): void {
  if (parties.length < 2) throw new Error('OPERATIONS_RATE_PATH_PARTIES_REQUIRED')
  if (parties[0].role !== 'platform_operator') {
    throw new Error('OPERATIONS_RATE_PATH_PLATFORM_OPERATOR_REQUIRED')
  }
  if (parties.at(-1)?.role !== 'shipper') {
    throw new Error('OPERATIONS_RATE_PATH_SHIPPER_REQUIRED')
  }

  for (const [index, party] of parties.entries()) {
    if (index > 0 && index < parties.length - 1 && party.role !== 'reseller') {
      throw new Error('OPERATIONS_RATE_PATH_RESELLER_REQUIRED')
    }
    if (party.role !== 'shipper' && party.entityType !== 'workspace_organization') {
      throw new Error('OPERATIONS_RATE_PATH_ORGANIZATION_REQUIRED')
    }
  }

  const participantKeys = parties.map((party) => `${party.entityType}:${party.entityId}`)
  if (new Set(participantKeys).size !== participantKeys.length) {
    throw new Error('OPERATIONS_RATE_PATH_CYCLE')
  }
}

export function priceCarrierRatePath(input: {
  currency: string
  carrierAccountGlobalId: string
  carrierAccountOwnerGlobalId: string
  carrierPayeeReference: string
  carrierCostMinor: bigint
  parties: CarrierRateParty[]
  grants: CarrierRatePathGrant[]
}): CarrierRatePathPricing {
  const currency = assertCurrency(input.currency)
  const carrierCostMinor = assertNonNegativeMinor(input.carrierCostMinor)
  assertRatePathPartySequence(input.parties)
  if (input.grants.length !== input.parties.length - 1) {
    throw new Error('OPERATIONS_RATE_PATH_GRANTS_INVALID')
  }
  const carrierAccountOwner = input.parties.find(
    (party) => party.globalId === input.carrierAccountOwnerGlobalId,
  )
  if (!carrierAccountOwner || carrierAccountOwner.entityType !== 'workspace_organization') {
    throw new Error('OPERATIONS_RATE_PATH_CARRIER_ACCOUNT_OWNER_INVALID')
  }
  if (!input.grants[0]?.directives.length) {
    throw new Error('OPERATIONS_RATE_PATH_PLATFORM_FEE_DIRECTIVE_REQUIRED')
  }

  let upstreamBuyMinor = carrierCostMinor
  const hops = input.grants.map((grant, index) => {
    const grantor = input.parties[index]
    const grantee = input.parties[index + 1]
    if (
      grant.grantorGlobalId !== grantor.globalId
      || grant.granteeGlobalId !== grantee.globalId
    ) {
      throw new Error('OPERATIONS_RATE_PATH_GRANT_PARTIES_INVALID')
    }

    const priced = priceRatePathHop(upstreamBuyMinor, grant.directives)
    const hop = {
      grantGlobalId: grant.grantGlobalId,
      grantor,
      grantee,
      upstreamBuyMinor,
      markupMinor: priced.downstreamSellMinor - upstreamBuyMinor,
      downstreamSellMinor: priced.downstreamSellMinor,
      directiveGlobalIds: priced.directiveGlobalIds,
    }
    upstreamBuyMinor = priced.downstreamSellMinor
    return hop
  })

  const margins = hops.map((hop) => ({
    partyGlobalId: hop.grantor.globalId,
    role: hop.grantor.role as 'platform_operator' | 'reseller',
    buyMinor: hop.upstreamBuyMinor,
    sellMinor: hop.downstreamSellMinor,
    marginMinor: hop.downstreamSellMinor - hop.upstreamBuyMinor,
  }))

  return {
    currency,
    carrierAccountGlobalId: input.carrierAccountGlobalId,
    carrierAccountOwnerGlobalId: input.carrierAccountOwnerGlobalId,
    carrierPayeeReference: input.carrierPayeeReference,
    carrierCostMinor,
    customerChargeMinor: hops.at(-1)?.downstreamSellMinor ?? carrierCostMinor,
    hops,
    settlements: [
      {
        type: 'carrier_payable',
        payerGlobalId: input.carrierAccountOwnerGlobalId,
        payeeGlobalId: input.carrierPayeeReference,
        amountMinor: carrierCostMinor,
        currency,
        grantGlobalId: null,
      },
      {
        type: 'carrier_cost_reimbursement',
        payerGlobalId: input.parties.at(-1)!.globalId,
        payeeGlobalId: input.carrierAccountOwnerGlobalId,
        amountMinor: carrierCostMinor,
        currency,
        grantGlobalId: null,
      },
      ...hops.map((hop) => ({
        type: hop.grantor.role === 'platform_operator'
          ? 'platform_fee' as const
          : 'reseller_fee' as const,
        payerGlobalId: input.parties.at(-1)!.globalId,
        payeeGlobalId: hop.grantor.globalId,
        amountMinor: hop.markupMinor,
        currency,
        grantGlobalId: hop.grantGlobalId,
      })),
    ],
    margins,
  }
}

function canonicalAddressToken(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function canonicalPostalCode(value: string | null | undefined) {
  return canonicalAddressToken(value).replace(/\s+/g, '')
}

const US_REGION_CODES: Record<string, string> = {
  ALABAMA: 'AL',
  ALASKA: 'AK',
  ARIZONA: 'AZ',
  ARKANSAS: 'AR',
  CALIFORNIA: 'CA',
  COLORADO: 'CO',
  CONNECTICUT: 'CT',
  DELAWARE: 'DE',
  'DISTRICT OF COLUMBIA': 'DC',
  FLORIDA: 'FL',
  GEORGIA: 'GA',
  HAWAII: 'HI',
  IDAHO: 'ID',
  ILLINOIS: 'IL',
  INDIANA: 'IN',
  IOWA: 'IA',
  KANSAS: 'KS',
  KENTUCKY: 'KY',
  LOUISIANA: 'LA',
  MAINE: 'ME',
  MARYLAND: 'MD',
  MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI',
  MINNESOTA: 'MN',
  MISSISSIPPI: 'MS',
  MISSOURI: 'MO',
  MONTANA: 'MT',
  NEBRASKA: 'NE',
  NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM',
  'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND',
  OHIO: 'OH',
  OKLAHOMA: 'OK',
  OREGON: 'OR',
  PENNSYLVANIA: 'PA',
  'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN',
  TEXAS: 'TX',
  UTAH: 'UT',
  VERMONT: 'VT',
  VIRGINIA: 'VA',
  WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI',
  WYOMING: 'WY',
}

function canonicalRegion(value: string | null | undefined, country: string | null | undefined) {
  const region = canonicalAddressToken(value)
  if (canonicalAddressToken(country) === 'US') {
    return US_REGION_CODES[region] ?? region
  }
  return region
}

function postalAddressMatches(left: Address, right: Address) {
  const requiredMatches = (
    canonicalAddressToken(left.line1) === canonicalAddressToken(right.line1)
    && canonicalAddressToken(left.city) === canonicalAddressToken(right.city)
    && canonicalRegion(left.region, left.country) === canonicalRegion(right.region, right.country)
    && canonicalPostalCode(left.postalCode) === canonicalPostalCode(right.postalCode)
    && canonicalAddressToken(left.country) === canonicalAddressToken(right.country)
  )
  if (!requiredMatches) return false
  const expectedLine2 = canonicalAddressToken(right.line2)
  return !expectedLine2 || canonicalAddressToken(left.line2) === expectedLine2
}

export function selectCarrierBillingRelationship(input: {
  carrierAccount: CarrierAccountTenderIdentity
  sender: Address
  recipient: Address
}): CarrierBillingSelection {
  const senderMatched = postalAddressMatches(
    input.sender,
    input.carrierAccount.accountAddress,
  )
  const recipientMatched = postalAddressMatches(
    input.recipient,
    input.carrierAccount.accountAddress,
  )
  const relationship = senderMatched
    ? 'sender' as const
    : recipientMatched
      ? 'recipient' as const
      : 'third_party' as const

  return {
    relationship,
    carrierAccountGlobalId: input.carrierAccount.carrierAccountGlobalId,
    accountOwnerGlobalId: input.carrierAccount.accountOwnerGlobalId,
    matchedAddressSide: relationship === 'third_party' ? null : relationship,
    accountAddressVerification: input.carrierAccount.accountAddressVerification,
    evidence: {
      senderMatched,
      recipientMatched,
      normalizationVersion: 'postal-address-v1',
    },
  }
}

export function groupCarrierBillingStatements(
  rows: CarrierBillingStatementGroupInput[],
): CarrierBillingStatementGroup[] {
  const externalChargeIds = rows.map((row) => row.externalChargeId)
  if (new Set(externalChargeIds).size !== externalChargeIds.length) {
    throw new Error('OPERATIONS_CARRIER_CHARGE_DUPLICATE')
  }

  const groups = new Map<string, CarrierBillingStatementGroup>()
  for (const row of rows) {
    if (!/^[a-f0-9]{64}$/.test(row.billedAccountFingerprint)) {
      throw new Error('OPERATIONS_CARRIER_ACCOUNT_FINGERPRINT_INVALID')
    }
    const key = `${row.billedAccountFingerprint}:${row.externalStatementId}`
    const current = groups.get(key)
    if (current) {
      if (current.billedAccountMaskedReference !== row.billedAccountMaskedReference) {
        throw new Error('OPERATIONS_CARRIER_ACCOUNT_MASK_CONFLICT')
      }
      current.externalChargeIds.push(row.externalChargeId)
    } else {
      groups.set(key, {
        externalStatementId: row.externalStatementId,
        billedAccountMaskedReference: row.billedAccountMaskedReference,
        billedAccountFingerprint: row.billedAccountFingerprint,
        externalChargeIds: [row.externalChargeId],
      })
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      externalChargeIds: [...group.externalChargeIds].sort(),
    }))
    .sort((left, right) => (
      left.billedAccountFingerprint.localeCompare(right.billedAccountFingerprint)
      || left.externalStatementId.localeCompare(right.externalStatementId)
    ))
}

export function assignCarrierBillingShipper(input: {
  shipmentMatchStatus: CarrierBillingShipperAssignment['shipmentMatchStatus']
  shipmentGlobalId: string | null
  matchedShipmentShipperGlobalId?: string | null
  manualShipperGlobalId?: string | null
  routingRuleShipperGlobalId?: string | null
  routingRuleGlobalId?: string | null
  actorEmail?: string | null
  reason?: string | null
}): CarrierBillingShipperAssignment {
  if (
    input.shipmentMatchStatus === 'matched'
    && (!input.shipmentGlobalId || !input.matchedShipmentShipperGlobalId)
  ) {
    throw new Error('OPERATIONS_CARRIER_MATCHED_SHIPMENT_REQUIRED')
  }
  if (input.shipmentMatchStatus !== 'matched' && input.shipmentGlobalId) {
    throw new Error('OPERATIONS_CARRIER_UNMATCHED_SHIPMENT_FORBIDDEN')
  }

  const requestedAssignments = [
    input.matchedShipmentShipperGlobalId ? 'shipment_match' : null,
    input.manualShipperGlobalId ? 'manual' : null,
    input.routingRuleShipperGlobalId ? 'routing_rule' : null,
  ].filter(Boolean)
  if (requestedAssignments.length > 1) {
    throw new Error('OPERATIONS_CARRIER_ASSIGNMENT_SOURCE_AMBIGUOUS')
  }

  if (input.matchedShipmentShipperGlobalId) {
    if (input.shipmentMatchStatus !== 'matched') {
      throw new Error('OPERATIONS_CARRIER_ASSIGNMENT_MATCH_REQUIRED')
    }
    return {
      shipmentMatchStatus: input.shipmentMatchStatus,
      shipmentGlobalId: input.shipmentGlobalId,
      shipperAssignmentStatus: 'assigned',
      assignedShipperGlobalId: input.matchedShipmentShipperGlobalId,
      source: 'shipment_match',
      ruleGlobalId: null,
      actorEmail: null,
      reason: input.reason || null,
    }
  }
  if (input.manualShipperGlobalId) {
    if (!input.actorEmail || !input.reason?.trim()) {
      throw new Error('OPERATIONS_CARRIER_MANUAL_ASSIGNMENT_EVIDENCE_REQUIRED')
    }
    return {
      shipmentMatchStatus: input.shipmentMatchStatus,
      shipmentGlobalId: input.shipmentGlobalId,
      shipperAssignmentStatus: 'assigned',
      assignedShipperGlobalId: input.manualShipperGlobalId,
      source: 'manual',
      ruleGlobalId: null,
      actorEmail: input.actorEmail,
      reason: input.reason.trim(),
    }
  }
  if (input.routingRuleShipperGlobalId) {
    if (!input.routingRuleGlobalId) {
      throw new Error('OPERATIONS_CARRIER_ROUTING_RULE_REQUIRED')
    }
    return {
      shipmentMatchStatus: input.shipmentMatchStatus,
      shipmentGlobalId: input.shipmentGlobalId,
      shipperAssignmentStatus: 'assigned',
      assignedShipperGlobalId: input.routingRuleShipperGlobalId,
      source: 'routing_rule',
      ruleGlobalId: input.routingRuleGlobalId,
      actorEmail: null,
      reason: input.reason || null,
    }
  }

  return {
    shipmentMatchStatus: input.shipmentMatchStatus,
    shipmentGlobalId: input.shipmentGlobalId,
    shipperAssignmentStatus: input.shipmentMatchStatus === 'ambiguous'
      ? 'ambiguous'
      : input.shipmentMatchStatus === 'rejected'
        ? 'rejected'
        : 'unassigned',
    assignedShipperGlobalId: null,
    source: 'none',
    ruleGlobalId: null,
    actorEmail: null,
    reason: input.reason || null,
  }
}

export function reconcileCarrierBilling(input: {
  shipmentGlobalId: string
  currency: string
  quotedCarrierCostMinor: bigint
  statementFinalized: boolean
  chargeLines: CarrierBillingChargeLine[]
}): CarrierBillingReconciliation {
  const currency = assertCurrency(input.currency)
  assertNonNegativeMinor(input.quotedCarrierCostMinor)
  const externalChargeIds = input.chargeLines.map((line) => line.externalChargeId)
  if (new Set(externalChargeIds).size !== externalChargeIds.length) {
    throw new Error('OPERATIONS_CARRIER_CHARGE_DUPLICATE')
  }
  for (const line of input.chargeLines) {
    if (assertCurrency(line.currency) !== currency) {
      throw new Error('OPERATIONS_CARRIER_CHARGE_CURRENCY_MISMATCH')
    }
    if (
      line.shipmentMatchStatus === 'matched'
      && line.shipmentGlobalId !== input.shipmentGlobalId
    ) {
      throw new Error('OPERATIONS_CARRIER_CHARGE_SHIPMENT_MISMATCH')
    }
    if (
      line.shipmentMatchStatus !== 'matched'
      || line.shipmentGlobalId !== input.shipmentGlobalId
    ) {
      throw new Error('OPERATIONS_CARRIER_RECONCILIATION_SCOPE_INVALID')
    }
  }

  const matched = input.chargeLines
  const actualCarrierCostMinor = matched.reduce(
    (sum, line) => sum + line.amountMinor,
    BigInt(0),
  )
  if (actualCarrierCostMinor < BigInt(0)) {
    throw new Error('OPERATIONS_CARRIER_ACTUAL_COST_INVALID')
  }
  const unresolvedCandidateCount = 0
  const assignmentExceptionCount = input.chargeLines.filter(
    (line) => line.shipperAssignmentStatus !== 'assigned',
  ).length
  const chargeTotals = [...matched.reduce((totals, line) => {
    totals.set(line.category, (totals.get(line.category) ?? BigInt(0)) + line.amountMinor)
    return totals
  }, new Map<CarrierBillingChargeLine['category'], bigint>())]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, amountMinor]) => ({ category, amountMinor }))

  let status: CarrierBillingReconciliation['status'] = 'pending'
  if (assignmentExceptionCount > 0) {
    status = 'needs_review'
  } else if (matched.length > 0) {
    status = input.statementFinalized ? 'reconciled' : 'provisional'
  }

  return {
    shipmentGlobalId: input.shipmentGlobalId,
    currency,
    status,
    quotedCarrierCostMinor: input.quotedCarrierCostMinor,
    actualCarrierCostMinor,
    varianceMinor: actualCarrierCostMinor - input.quotedCarrierCostMinor,
    matchedChargeCount: matched.length,
    unresolvedCandidateCount,
    assignmentExceptionCount,
    chargeTotals,
    matchedExternalChargeIds: matched.map((line) => line.externalChargeId).sort(),
  }
}

export function priceContract(input: {
  directives: PricingDirective[]
  totalUnits: number
  freightCostMinor: bigint
  packageCount: number
}): EstimatedCharges {
  const charges: ChargeBreakdown[] = []
  const totalUnits = assertPositiveQuantity(input.totalUnits)
  for (const directive of [...input.directives].sort((a, b) => a.priority - b.priority || a.globalId.localeCompare(b.globalId))) {
    const config = directive.configuration
    let amountMinor = BigInt(0)
    let quantity = 1
    switch (directive.type) {
      case 'fixed_order_fee':
        amountMinor = minor(config.amountMinor)
        break
      case 'pick_fee':
        quantity = totalUnits
        amountMinor = minor(config.amountMinor) * BigInt(Math.ceil(totalUnits))
        break
      case 'tiered_pick_fee': {
        quantity = totalUnits
        const tiers = Array.isArray(config.tiers) ? config.tiers as Array<Record<string, unknown>> : []
        let remaining = Math.ceil(totalUnits)
        let previousThrough = 0
        for (const tier of tiers) {
          if (remaining <= 0) break
          const through = Math.max(previousThrough, integer(tier.throughUnits, Number.MAX_SAFE_INTEGER))
          const units = Math.min(remaining, through - previousThrough)
          amountMinor += BigInt(units) * minor(tier.amountMinor)
          remaining -= units
          previousThrough = through
        }
        if (remaining > 0) amountMinor += BigInt(remaining) * minor(config.overflowAmountMinor)
        break
      }
      case 'pack_fee':
        quantity = input.packageCount
        amountMinor = minor(config.amountMinor) * BigInt(input.packageCount)
        break
      case 'freight_markup_percent':
        amountMinor = percentageAmount(input.freightCostMinor, integer(config.basisPoints))
        break
      case 'storage_fee':
      case 'special_handling':
        amountMinor = minor(config.amountMinor)
        break
    }
    charges.push({
      directiveId: directive.id,
      directiveGlobalId: directive.globalId,
      type: directive.type,
      quantity,
      amountMinor,
    })
  }

  const freightMarkup = charges
    .filter((charge) => charge.type === 'freight_markup_percent')
    .reduce((sum, charge) => sum + charge.amountMinor, BigInt(0))
  const freightChargeMinor = input.freightCostMinor + freightMarkup
  const serviceRevenue = charges
    .filter((charge) => charge.type !== 'freight_markup_percent')
    .reduce((sum, charge) => sum + charge.amountMinor, BigInt(0))
  return {
    charges,
    freightChargeMinor,
    revenueMinor: serviceRevenue + freightChargeMinor,
  }
}

export function applyFreightPricing(rate: CarrierRate, directives: PricingDirective[]): PricedCarrierRate {
  const pricing = priceContract({
    directives: directives.filter((directive) => directive.type === 'freight_markup_percent'),
    totalUnits: 1,
    freightCostMinor: rate.internalCostMinor,
    packageCount: 1,
  })
  return { ...rate, customerChargeMinor: pricing.freightChargeMinor }
}

export class DeterministicFulfillmentOptimizer implements FulfillmentOptimizer {
  async plan(request: OptimizationRequest): Promise<OptimizationResult> {
    const complete = request.candidates
      .filter((candidate) => request.demand.every((demand) => (
        (candidate.availableByProductId.get(demand.productId) || 0) >= demand.quantity
      )))
      .sort((left, right) => {
        if (left.handlingCostMinor !== right.handlingCostMinor) {
          return left.handlingCostMinor < right.handlingCostMinor ? -1 : 1
        }
        return left.warehouseGlobalId.localeCompare(right.warehouseGlobalId)
      })

    if (complete[0]) {
      return {
        method: 'deterministic_fallback',
        solverStatus: 'fallback',
        warehouseIds: [complete[0].warehouseId],
        fallbackReason: 'OR-Tools is not enabled; selected the lowest-cost complete single-warehouse plan deterministically.',
        explanation: {
          completeCandidateCount: complete.length,
          selectedWarehouseGlobalId: complete[0].warehouseGlobalId,
          multiWarehouseConsidered: false,
        },
      }
    }

    return {
      method: 'deterministic_fallback',
      solverStatus: 'infeasible',
      warehouseIds: [],
      fallbackReason: request.allowMultiWarehouse
        ? 'No complete single-warehouse plan exists; multi-warehouse optimization is deferred to the OR-Tools phase.'
        : 'No complete single-warehouse plan exists and multi-warehouse fulfillment is not approved.',
      explanation: { completeCandidateCount: 0, multiWarehouseConsidered: request.allowMultiWarehouse },
    }
  }
}
