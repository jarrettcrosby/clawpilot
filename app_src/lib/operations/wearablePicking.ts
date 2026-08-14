export const WEARABLE_PICK_QUEUE_SCHEMA_VERSION = 1 as const

export type WearablePickTask = {
  pickTaskGlobalId: string
  sequence: number
  productGlobalId: string
  productName: string
  channelSku: string
  productImageURL: string | null
  barcode: string | null
  locationCode: string
  warehouseCode?: string
  warehouseGlobalId?: string
  locationGlobalId?: string
  locationBarcode?: string
  locationScanRequired?: true
  locationScanPolicyRowVersion?: number
  quantity: number
}

export type WearableScanSource = 'iphone_camera' | 'meta'

export type WearableScanObservationInput = {
  barcode: string
  capturedAt: string
  source: WearableScanSource
}

export type WearablePickTaskScanEvidenceInput = {
  pickTaskGlobalId: string
  policyRowVersion: number
  location: WearableScanObservationInput
  product: WearableScanObservationInput
}

export type WearableCountSource = 'iphone' | 'watch'

export type WearablePickTaskCountEvidenceInput = {
  pickTaskGlobalId: string
  requiredQuantity: number
  enteredQuantity: number
  product: WearableScanObservationInput
  countedAt: string
  countSource: WearableCountSource
}

export type WearablePickOrder = {
  orderGlobalId: string
  orderNumber: string
  rowVersion: number
  tasks: WearablePickTask[]
}

export type WearablePickQueue = {
  schemaVersion: typeof WEARABLE_PICK_QUEUE_SCHEMA_VERSION
  organizationId: string
  workerEmail: string
  generatedAt: string
  orders: WearablePickOrder[]
}

export type WearablePendingConfirmationState = {
  orderGlobalId: string
  expectedRowVersion: number
  state:
    | 'manager_action_required'
    | 'reconciled_external_fulfillment'
    | 'unresolved'
  code: string
  message: string
  reconciliationGlobalId: string | null
  providerWrites: 0 | null
}

export type WearablePendingConfirmationCandidate = {
  orderStatus: string
  orderRowVersion: number
  planStatus: string | null
  reconciliationRequired: boolean
  reconciliationGlobalId: string | null
  providerWriteCount: number | null
  reconciliationIsAuthoritative: boolean
}

export function resolveWearablePendingConfirmationState(input: {
  orderGlobalId: string
  expectedRowVersion: number
  candidates: WearablePendingConfirmationCandidate[]
}): WearablePendingConfirmationState {
  const unresolved = (message: string): WearablePendingConfirmationState => ({
    orderGlobalId: input.orderGlobalId,
    expectedRowVersion: input.expectedRowVersion,
    state: 'unresolved',
    code: 'OPERATIONS_PENDING_CONFIRMATION_UNRESOLVED',
    message,
    reconciliationGlobalId: null,
    providerWrites: null,
  })
  if (input.candidates.length === 0) {
    return unresolved('The original order is unavailable. A manager must review it before local picking evidence can be retired.')
  }
  if (input.candidates.length !== 1) {
    return unresolved('ClawPilot found conflicting reconciliation evidence. A manager must review the order before local picking evidence can be retired.')
  }

  const candidate = input.candidates[0]
  if (
    candidate.orderStatus === 'cancelled'
    && candidate.orderRowVersion === input.expectedRowVersion + 1
    && candidate.reconciliationIsAuthoritative === true
    && candidate.providerWriteCount === 0
    && candidate.reconciliationGlobalId !== null
  ) {
    return {
      orderGlobalId: input.orderGlobalId,
      expectedRowVersion: input.expectedRowVersion,
      state: 'reconciled_external_fulfillment',
      code: 'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILED',
      message: 'A manager reconciled the Shopify external fulfillment. The original warehouse pick is no longer active.',
      reconciliationGlobalId: candidate.reconciliationGlobalId,
      providerWrites: 0,
    }
  }

  if (
    candidate.orderStatus === 'released'
    && candidate.orderRowVersion === input.expectedRowVersion
    && candidate.planStatus === 'released'
    && candidate.reconciliationRequired === true
  ) {
    return {
      orderGlobalId: input.orderGlobalId,
      expectedRowVersion: input.expectedRowVersion,
      state: 'manager_action_required',
      code: 'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED',
      message: 'A manager must reconcile this order’s external Shopify fulfillment in Operations before picking can continue.',
      reconciliationGlobalId: null,
      providerWrites: null,
    }
  }

  return unresolved('The original confirmation is still unresolved. Ask a manager to review the order, then refresh this status.')
}
