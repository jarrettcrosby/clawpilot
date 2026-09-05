import { NextRequest, NextResponse } from 'next/server'
import {
  integrationCredentialRuntimeMaintenanceResponse,
} from '@/lib/integrations/integrationCredentialRuntimeHttp'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
  shippingCapabilities,
} from '@/lib/operations/authorization'
import {
  canUsePhysicalOutputAttestationBrowserSession,
} from '@/lib/operations/physicalOutputAttestationAuthorization'
import {
  isOperationsOrderProviderFilter,
  isOperationsOrderSort,
  isOperationsOrderSortDirection,
  isOperationsOrderTrackingFilter,
  isOperationsOrderUpdatedAfter,
} from '@/lib/operations/orderListQuery'
import type {
  Address,
  MockOperationsProofInput,
  MockOperationsProofLineInput,
  OperationsActivationState,
  OperationsExceptionStatus,
  OperationsInboundReceiptCompletionInput,
  OperationsInboundReceiptInput,
  OperationsOrderStatus,
  OperationsWorkspace,
} from '@/lib/operations/types'
import { OperationsShadowTrainingError } from '@/lib/operations/shadowTraining'
import { canRequestOperationsPickHandoff } from '@/lib/operations/types'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  CommerceStoreSyncPersistenceError,
  updateCommerceStoreSyncControlInPostgres,
} from '@/lib/persistence/commerceStoreSync'
import {
  CommerceOrderWorkbenchError,
} from '@/lib/persistence/commerceOrderWorkbench'
import {
  OperationsOrderShipmentAddressError,
} from '@/lib/persistence/operationsOrderShipmentAddress'
import {
  OperationsOrderUnitWeightError,
} from '@/lib/persistence/orderUnitWeightEvidence'
import {
  authorizeCommerceActiveTransitionInPostgres,
  CommerceActiveTransitionPersistenceError,
  consumeCommerceActiveTransitionAuthorizationInPostgres,
  prepareCommerceActiveTransitionInPostgres,
} from '@/lib/persistence/commerceActiveTransitionAuthorization'
import {
  authorizeSandboxCommerceE2eInPostgres,
  SandboxCommerceE2eAuthorizationError,
} from '@/lib/persistence/sandboxCommerceE2eAuthorization'
import {
  authorizeShopifyTestStoreCanonicalE2e,
  ShopifyTestStoreCanonicalE2eError,
} from '@/lib/integrations/shopifyTestStoreCanonicalE2e'
import {
  confirmShopifyTestStoreCanonicalE2eFulfillmentInPostgres,
  ShopifyTestStoreCanonicalE2ePersistenceError,
} from '@/lib/persistence/shopifyTestStoreCanonicalE2e'
import {
  cancelUnstartedCommerceOrderFromProviderRevisionInPostgres,
  CommerceOrderRevisionDispositionError,
} from '@/lib/persistence/commerceOrderRevisions'
import {
  assignOperationsOrderPicksFromPostgres,
  confirmOperationsOrderShipmentFromPostgres,
  confirmOperationsOrderPicksFromPostgres,
  completeOperationsInboundReceiptInPostgres,
  createOperationsInboundReceiptInPostgres,
  createOperationsLocationInPostgres,
  createOperationsWarehouseInPostgres,
  deleteOperationsLocationInPostgres,
  executeOperationsReplenishmentInPostgres,
  generateOperationsPackagePackingSlipInPostgres,
  manageOperationsOrderPickAssignmentFromPostgres,
  OperationsRequestError,
  planOperationsOrderFromPostgres,
  prepareOperationsShipmentExecutionFromPostgres,
  readOperationsWorkspaceFromPostgres,
  recordWearablePickScanEvidenceFromPostgres,
  reconcileShopifyExternalFulfillmentFromPostgres,
  releaseOperationsOrderFromPostgres,
  reopenOperationsOrderForReplanningInPostgres,
  requestOperationsPickHandoffFromPostgres,
  retryOperationsCommerceFulfillmentExportFromPostgres,
  runMockOperationsProofFromPostgres,
  updateOperationsActivationInPostgres,
  updateOperationsExceptionInPostgres,
  updateOperationsLocationInPostgres,
  updateOperationsWarehouseInPostgres,
  verifyOperationsOrderPackFromPostgres,
} from '@/lib/persistence/operations'
import { assertCanonicalShadowCommerceOrderIsMirrorOnlyInPostgres } from '@/lib/persistence/operationShadowTraining'
import {
  createOperationsSandboxLabelInPostgres,
  voidOperationsSandboxLabelInPostgres,
} from '@/lib/persistence/operationShipping'
import { CarrierIntegrationRequestError } from '@/lib/integrations/carrierIntegrations'
import {
  executeProductionFulfillmentRerate,
  ProductionFulfillmentRerateExecutionError,
} from '@/lib/operations/productionFulfillmentRerateExecution'
import {
  ProductionFulfillmentReratePersistenceError,
  selectProductionFulfillmentRerateOfferInPostgres,
} from '@/lib/operations/productionFulfillmentRerates'
import {
  ActiveFulfillmentExecutionPreparationError,
  prepareActiveFulfillmentExecutionFromShadowInPostgres,
} from '@/lib/operations/activeFulfillmentExecutionPreparation'
import type { ActiveCarrierDispatchAddressSnapshot } from '@/lib/operations/activeCarrierDispatchSnapshot'
import type {
  WearablePickTaskCountEvidenceInput,
  WearablePickTaskScanEvidenceInput,
} from '@/lib/operations/wearablePicking'
import { requestSession, requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_STANDARD_REQUEST_BYTES = 64 * 1024
const MAX_REQUEST_BYTES = 384 * 1024
const CUSTOMER_GLOBAL_ID = /^ga(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCT_GLOBAL_ID = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const PICK_TASK_GLOBAL_ID = /^gpk(?:[0-9]{7}|[0-9a-v]{12})$/
const CARTONIZATION_EVIDENCE_GLOBAL_ID = /^gcte(?:[0-9]{7}|[0-9a-v]{12})$/
const PACKAGE_GLOBAL_ID = /^gpa(?:[0-9]{7}|[0-9a-v]{12})$/
const EXCEPTION_GLOBAL_ID = /^gex(?:[0-9]{7}|[0-9a-v]{12})$/
const COMMERCE_ORDER_REVISION_OBSERVATION_GLOBAL_ID = /^gcor(?:[0-9]{7}|[0-9a-v]{12})$/
const COMMERCE_ORDER_REVISION_READ_GLOBAL_ID = /^gcrr(?:[0-9]{7}|[0-9a-v]{12})$/
const RATE_GLOBAL_ID = /^grt(?:[0-9]{7}|[0-9a-v]{12})$/
const CARRIER_ACCOUNT_GLOBAL_ID = /^gac(?:[0-9]{7}|[0-9a-v]{12})$/
const PRINTER_GLOBAL_ID = /^gpr(?:[0-9]{7}|[0-9a-v]{12})$/
const WAREHOUSE_GLOBAL_ID = /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/
const LOCATION_GLOBAL_ID = /^gwl(?:[0-9]{7}|[0-9a-v]{12})$/
const INVENTORY_POOL_GLOBAL_ID = /^gip(?:[0-9]{7}|[0-9a-v]{12})$/
const RECEIPT_GLOBAL_ID = /^grc(?:[0-9]{7}|[0-9a-v]{12})$/
const RECEIPT_LINE_GLOBAL_ID = /^grcl(?:[0-9]{7}|[0-9a-v]{12})$/
const INTEGRATION_ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const COMMERCE_ACTIVE_PREPARATION_GLOBAL_ID = /^gcap(?:[0-9]{7}|[0-9a-v]{12})$/
const SHADOW_EXECUTION_GLOBAL_ID = /^gofe(?:[0-9]{7}|[0-9a-v]{12})$/
const ACTIVE_EXECUTION_GLOBAL_ID = /^gaex(?:[0-9]{7}|[0-9a-v]{12})$/
const ACTIVE_SHIPMENT_GROUP_GLOBAL_ID = /^gash(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCTION_RERATE_RUN_GLOBAL_ID = /^gafr(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCTION_RERATE_OFFER_GLOBAL_ID = /^garo(?:[0-9]{7}|[0-9a-v]{12})$/
const SHA256 = /^[a-f0-9]{64}$/
const EXTERNAL_FULFILLMENT_STATUS = 'fulfilled_externally' as const
type OperationsOrderFilter = OperationsOrderStatus | typeof EXTERNAL_FULFILLMENT_STATUS
const ORDER_STATUSES = new Set<OperationsOrderFilter>([
  EXTERNAL_FULFILLMENT_STATUS,
  'imported', 'validated', 'held', 'promised', 'reserved', 'planned',
  'released', 'picking', 'packed', 'shipped', 'cancelled', 'exception',
])
const EXCEPTION_STATUSES = new Set<OperationsExceptionStatus>([
  'open', 'acknowledged', 'resolved', 'dismissed',
])
// Canonical commands remain isolated only from an exact open training overlay.
// The legacy workspace activation profile is not local-work authority.
const SHADOW_COMMERCE_CANONICAL_ORDER_ACTIONS = new Set([
  'plan-order',
  'release-order',
  'assign-picks',
  'manage-pick-assignment',
  'request-pick-handoff',
  'record-pick-scan-evidence',
  'confirm-picks',
  'verify-pack',
  'authorize-sandbox-commerce-e2e',
  'prepare-shipment-execution',
  'generate-packing-slip',
  'confirm-shipment',
  'create-sandbox-label',
  'void-sandbox-label',
])
const ACTIVATION_STATES = new Set<OperationsActivationState>([
  'disabled', 'shadow', 'read_only', 'active', 'frozen',
])
const PROOF_FIELDS = new Set([
  'customerGlobalId', 'lines', 'productGlobalId', 'externalOrderId', 'orderNumber',
  'quantity', 'openingQuantity', 'requestedDeliveryAt', 'shipTo', 'executionMode',
])
const PROOF_LINE_FIELDS = new Set(['productGlobalId', 'quantity', 'openingQuantity'])
const ADDRESS_FIELDS = new Set(['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'])
const CARRIER_DISPATCH_ADDRESS_FIELDS = new Set([
  'contactName', 'companyName', 'phone', 'email', 'line1', 'line2', 'line3',
  'city', 'region', 'postalCode', 'countryCode', 'residential',
])

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new OperationsRequestError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    requestError('OPERATIONS_POSTGRES_REQUIRED', 'Operations requires Postgres storage', 503)
  }
}

function commerceFulfillmentRecoveryRuntimeAvailable() {
  return String(
    process.env.CLAWPILOT_COMMERCE_FULFILLMENT_RECOVERY_ENABLED || '0',
  ) === '1'
}

function requireOperationsProofFixture() {
  if (process.env.CLAWPILOT_OPERATIONS_PROOF_ENABLED !== 'true') {
    requestError(
      'OPERATIONS_PROOF_DISABLED',
      'The hosted proof-order fixture is disabled',
      404,
    )
  }
}

function record(value: unknown, code: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) requestError(code, `${label} is invalid`)
  return value as Record<string, unknown>
}

function assertFields(value: Record<string, unknown>, allowed: Set<string>, code: string, label: string) {
  const unsupported = Object.keys(value).find((field) => !allowed.has(field))
  if (unsupported) requestError(code, `${label} includes an unsupported field`)
}

function textValue(value: unknown, label: string, max: number, required = true): string {
  const text = String(value ?? '').trim()
  if ((!text && required) || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  }
  return text
}

function integerValue(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

function wearableScanBarcodeValue(value: unknown, label: string) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 512
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    requestError('OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID', `${label} is invalid`)
  }
  return value
}

function wearableScanCapturedAtValue(value: unknown, label: string) {
  if (
    typeof value !== 'string'
    || value.length < 20
    || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  ) {
    requestError('OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID', `${label} is invalid`)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    requestError('OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID', `${label} is invalid`)
  }
  return parsed.toISOString()
}

function wearableScanObservationValue(
  value: unknown,
  label: string,
): WearablePickTaskScanEvidenceInput['location'] {
  const observation = record(
    value,
    'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID',
    label,
  )
  assertFields(
    observation,
    new Set(['barcode', 'capturedAt', 'source']),
    'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID',
    label,
  )
  const source = String(observation.source || '')
  if (source !== 'iphone_camera' && source !== 'meta') {
    requestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID',
      `${label} source is invalid`,
    )
  }
  return {
    barcode: wearableScanBarcodeValue(observation.barcode, `${label} barcode`),
    capturedAt: wearableScanCapturedAtValue(
      observation.capturedAt,
      `${label} capture time`,
    ),
    source,
  }
}

function wearablePickScanEvidenceValue(
  value: unknown,
): WearablePickTaskScanEvidenceInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    requestError(
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID',
      'Scan evidence must contain between one and 200 pick tasks',
    )
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const evidence = record(
      entry,
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID',
      `Scan evidence ${index + 1}`,
    )
    assertFields(
      evidence,
      new Set(['pickTaskGlobalId', 'policyRowVersion', 'location', 'product']),
      'OPERATIONS_WEARABLE_SCAN_EVIDENCE_INVALID',
      `Scan evidence ${index + 1}`,
    )
    const pickTaskGlobalId = globalIdValue(
      evidence.pickTaskGlobalId,
      `Scan evidence ${index + 1} pick task`,
      PICK_TASK_GLOBAL_ID,
    )
    if (seen.has(pickTaskGlobalId)) {
      requestError(
        'OPERATIONS_WEARABLE_SCAN_EVIDENCE_DUPLICATE',
        'Scan evidence contains the same pick task more than once',
        409,
      )
    }
    seen.add(pickTaskGlobalId)
    return {
      pickTaskGlobalId,
      policyRowVersion: integerValue(
        evidence.policyRowVersion,
        `Scan evidence ${index + 1} policy version`,
        1,
        2_147_483_647,
      ),
      location: wearableScanObservationValue(
        evidence.location,
        `Scan evidence ${index + 1} location observation`,
      ),
      product: wearableScanObservationValue(
        evidence.product,
        `Scan evidence ${index + 1} product observation`,
      ),
    }
  })
}

function wearableCountCapturedAtValue(value: unknown, label: string) {
  if (
    typeof value !== 'string'
    || value.length < 20
    || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  ) {
    requestError('OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID', `${label} is invalid`)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    requestError('OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID', `${label} is invalid`)
  }
  return parsed.toISOString()
}

function wearableCountProductObservationValue(
  value: unknown,
  label: string,
): WearablePickTaskCountEvidenceInput['product'] {
  const observation = record(
    value,
    'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
    label,
  )
  assertFields(
    observation,
    new Set(['barcode', 'capturedAt', 'source']),
    'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
    label,
  )
  const barcode = observation.barcode
  if (
    typeof barcode !== 'string'
    || barcode.length < 1
    || barcode.length > 512
    || barcode !== barcode.trim()
    || /[\u0000-\u001f\u007f]/.test(barcode)
  ) {
    requestError(
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
      `${label} barcode is invalid`,
    )
  }
  const source = String(observation.source || '')
  if (source !== 'iphone_camera' && source !== 'meta') {
    requestError(
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
      `${label} source is invalid`,
    )
  }
  return {
    barcode,
    capturedAt: wearableCountCapturedAtValue(
      observation.capturedAt,
      `${label} capture time`,
    ),
    source,
  }
}

function wearablePickCountEvidenceValue(
  value: unknown,
): WearablePickTaskCountEvidenceInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    requestError(
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
      'Count evidence must contain between one and 200 multi-unit pick tasks',
    )
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const label = `Count evidence ${index + 1}`
    const evidence = record(
      entry,
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
      label,
    )
    assertFields(
      evidence,
      new Set([
        'pickTaskGlobalId',
        'requiredQuantity',
        'enteredQuantity',
        'product',
        'countedAt',
        'countSource',
      ]),
      'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
      label,
    )
    const pickTaskGlobalId = globalIdValue(
      evidence.pickTaskGlobalId,
      `${label} pick task`,
      PICK_TASK_GLOBAL_ID,
    )
    if (seen.has(pickTaskGlobalId)) {
      requestError(
        'OPERATIONS_WEARABLE_COUNT_EVIDENCE_DUPLICATE',
        'Count evidence contains the same pick task more than once',
        409,
      )
    }
    seen.add(pickTaskGlobalId)
    const product = wearableCountProductObservationValue(
      evidence.product,
      `${label} product observation`,
    )
    const countSource = String(evidence.countSource || '')
    if (countSource !== 'iphone' && countSource !== 'watch') {
      requestError(
        'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
        `${label} count source is invalid`,
      )
    }
    return {
      pickTaskGlobalId,
      requiredQuantity: integerValue(
        evidence.requiredQuantity,
        `${label} required quantity`,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      enteredQuantity: integerValue(
        evidence.enteredQuantity,
        `${label} entered quantity`,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      product,
      countedAt: wearableCountCapturedAtValue(
        evidence.countedAt,
        `${label} count time`,
      ),
      countSource,
    }
  })
}

function optionalNumberValue(value: unknown, label: string, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} must be from ${minimum} to ${maximum}`)
  }
  return parsed
}

function positiveNumberValue(value: unknown, label: string, maximum = 1_000_000_000): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} must be greater than zero`)
  }
  return parsed
}

function nonNegativeNumberValue(value: unknown, label: string, maximum = 1_000_000_000): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} must be zero or greater`)
  }
  return parsed
}

function optionalDateTimeValue(value: unknown, label: string): string | null {
  const raw = textValue(value, label, 50, false)
  if (!raw) return null
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  }
  return parsed.toISOString()
}

function inboundReceiptLinesValue(value: unknown): OperationsInboundReceiptInput['lines'] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Receipt must include from 1 to 100 lines')
  }
  return value.map((entry, index) => {
    const line = record(entry, 'OPERATIONS_REQUEST_INVALID', `Receipt line ${index + 1}`)
    assertFields(
      line,
      new Set([
        'productGlobalId',
        'targetLocationGlobalId',
        'expectedQuantity',
        'lotCode',
        'unitOfMeasure',
      ]),
      'OPERATIONS_REQUEST_INVALID',
      `Receipt line ${index + 1}`,
    )
    return {
      productGlobalId: globalIdValue(
        line.productGlobalId,
        `Product on line ${index + 1}`,
        PRODUCT_GLOBAL_ID,
      ),
      targetLocationGlobalId: optionalGlobalIdValue(
        line.targetLocationGlobalId,
        `Putaway location on line ${index + 1}`,
        LOCATION_GLOBAL_ID,
      ),
      expectedQuantity: positiveNumberValue(
        line.expectedQuantity,
        `Expected quantity on line ${index + 1}`,
      ),
      lotCode: textValue(line.lotCode, `Lot on line ${index + 1}`, 120, false),
      unitOfMeasure: textValue(
        line.unitOfMeasure || 'each',
        `Unit of measure on line ${index + 1}`,
        50,
      ),
    }
  })
}

function inboundReceiptCompletionLinesValue(
  value: unknown,
): OperationsInboundReceiptCompletionInput['lines'] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    requestError(
      'OPERATIONS_REQUEST_INVALID',
      'Receiving confirmation must include every receipt line',
    )
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const line = record(entry, 'OPERATIONS_REQUEST_INVALID', `Receiving line ${index + 1}`)
    assertFields(
      line,
      new Set(['lineGlobalId', 'acceptedQuantity', 'damagedQuantity']),
      'OPERATIONS_REQUEST_INVALID',
      `Receiving line ${index + 1}`,
    )
    const lineGlobalId = globalIdValue(
      line.lineGlobalId,
      `Receipt line ${index + 1}`,
      RECEIPT_LINE_GLOBAL_ID,
    )
    if (seen.has(lineGlobalId)) {
      requestError('OPERATIONS_REQUEST_INVALID', 'Receipt line confirmations must be unique')
    }
    seen.add(lineGlobalId)
    return {
      lineGlobalId,
      acceptedQuantity: nonNegativeNumberValue(
        line.acceptedQuantity,
        `Accepted quantity on line ${index + 1}`,
      ),
      damagedQuantity: nonNegativeNumberValue(
        line.damagedQuantity,
        `Damaged quantity on line ${index + 1}`,
      ),
    }
  })
}

function operatingDaysValue(value: unknown): number[] {
  if (value === undefined) return [1, 2, 3, 4, 5]
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Select at least one operating day')
  }
  const days = value.map((day) => integerValue(day, 'Operating day', 0, 6))
  if (new Set(days).size !== days.length) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Operating days must be unique')
  }
  return [...days].sort((a, b) => a - b)
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function optionalBooleanValue(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} must be true or false`)
  }
  return value
}

function carrierCutoffsValue(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  const input = record(value, 'OPERATIONS_REQUEST_INVALID', 'Carrier cutoffs')
  if (Object.keys(input).length > 25) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Carrier cutoffs are invalid')
  }
  const result: Record<string, string> = {}
  for (const [providerValue, cutoffValue] of Object.entries(input)) {
    const provider = textValue(providerValue, 'Carrier code', 40).toUpperCase()
    const cutoff = textValue(cutoffValue, `${provider} cutoff`, 8)
    if (!/^[A-Z0-9_-]+$/.test(provider) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) {
      requestError(
        'OPERATIONS_REQUEST_INVALID',
        'Carrier cutoffs require a carrier code and local 24-hour HH:MM time',
      )
    }
    result[provider] = cutoff
  }
  return result
}

function commerceActiveSelectedAccountsValue(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    requestError(
      'COMMERCE_ACTIVE_COHORT_INVALID',
      'Select between one and eight commerce accounts',
    )
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const selected = record(
      entry,
      'COMMERCE_ACTIVE_COHORT_INVALID',
      `Commerce account ${index + 1}`,
    )
    assertFields(
      selected,
      new Set(['accountGlobalId', 'capabilities']),
      'COMMERCE_ACTIVE_COHORT_INVALID',
      `Commerce account ${index + 1}`,
    )
    const accountGlobalId = globalIdValue(
      selected.accountGlobalId,
      `Commerce account ${index + 1}`,
      INTEGRATION_ACCOUNT_GLOBAL_ID,
    )
    if (seen.has(accountGlobalId)) {
      requestError(
        'COMMERCE_ACTIVE_ACCOUNT_DUPLICATE',
        'A commerce account can appear only once in an Active cohort',
      )
    }
    seen.add(accountGlobalId)
    if (
      !Array.isArray(selected.capabilities)
      || selected.capabilities.length < 1
      || selected.capabilities.length > 32
    ) {
      requestError(
        'COMMERCE_ACTIVE_CAPABILITIES_INVALID',
        `Select at least one write capability for ${accountGlobalId}`,
      )
    }
    const capabilities = selected.capabilities.map((capability) => {
      const normalized = String(capability || '').trim()
      if (!/^[a-z][a-z0-9_]{0,127}$/.test(normalized)) {
        requestError(
          'COMMERCE_ACTIVE_CAPABILITIES_INVALID',
          `Selected write capabilities for ${accountGlobalId} are invalid`,
        )
      }
      return normalized
    })
    return {
      accountGlobalId,
      capabilities: [...new Set(capabilities)].sort(),
    }
  })
}

function sha256Value(value: unknown, label: string) {
  const normalized = String(value || '').trim()
  if (!SHA256.test(normalized)) {
    requestError('COMMERCE_ACTIVE_COHORT_INVALID', `${label} is invalid`)
  }
  return normalized
}

function locationStorageFunctionValue(
  value: unknown,
  locationType: OperationsWorkspace['warehouses'][number]['locations'][number]['locationType'],
): OperationsWorkspace['warehouses'][number]['locations'][number]['storageFunction'] {
  if (value === null || value === undefined || value === '') {
    if (locationType === 'pick') return 'forward_pick'
    if (locationType === 'storage') return 'reserve'
    if (locationType === 'staging') return 'staging'
    return 'work_area'
  }
  return textValue(value, 'Storage function', 30) as OperationsWorkspace['warehouses'][number]['locations'][number]['storageFunction']
}

function locationProductRulesValue(value: unknown): Array<{
  productGlobalId: string
  ruleType: 'allowed' | 'preferred' | 'restricted'
  maxQuantity: number | null
  replenishmentMode: 'disabled' | 'min_max' | 'order_demand'
  replenishmentSourceLocationGlobalId: string | null
  minQuantity: number | null
  targetQuantity: number | null
}> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 250) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Location product rules are invalid')
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const rule = record(entry, 'OPERATIONS_REQUEST_INVALID', `Location product rule ${index + 1}`)
    assertFields(
      rule,
      new Set([
        'productGlobalId',
        'ruleType',
        'maxQuantity',
        'replenishmentMode',
        'replenishmentSourceLocationGlobalId',
        'minQuantity',
        'targetQuantity',
      ]),
      'OPERATIONS_REQUEST_INVALID',
      `Location product rule ${index + 1}`,
    )
    const productGlobalId = globalIdValue(rule.productGlobalId, 'Location product', PRODUCT_GLOBAL_ID)
    if (seen.has(productGlobalId)) {
      requestError('OPERATIONS_REQUEST_INVALID', 'A product may only have one rule per location')
    }
    seen.add(productGlobalId)
    const ruleType = textValue(rule.ruleType, 'Product rule type', 20)
    if (!['allowed', 'preferred', 'restricted'].includes(ruleType)) {
      requestError('OPERATIONS_REQUEST_INVALID', 'Product rule type is invalid')
    }
    const replenishmentMode = textValue(
      rule.replenishmentMode,
      'Replenishment mode',
      20,
      false,
    ) || 'disabled'
    if (!['disabled', 'min_max', 'order_demand'].includes(replenishmentMode)) {
      requestError('OPERATIONS_REQUEST_INVALID', 'Replenishment mode is invalid')
    }
    return {
      productGlobalId,
      ruleType: ruleType as 'allowed' | 'preferred' | 'restricted',
      maxQuantity: optionalNumberValue(rule.maxQuantity, 'Product quantity limit', 0.000001, 1_000_000_000),
      replenishmentMode: replenishmentMode as 'disabled' | 'min_max' | 'order_demand',
      replenishmentSourceLocationGlobalId: optionalGlobalIdValue(
        rule.replenishmentSourceLocationGlobalId,
        'Replenishment source',
        LOCATION_GLOBAL_ID,
      ),
      minQuantity: optionalNumberValue(rule.minQuantity, 'Replenishment minimum', 0, 1_000_000_000),
      targetQuantity: optionalNumberValue(rule.targetQuantity, 'Replenishment target', 0.000001, 1_000_000_000),
    }
  })
}

function globalIdValue(value: unknown, label: string, pattern: RegExp): string {
  const globalId = textValue(value, label, 16)
  if (!pattern.test(globalId)) requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  return globalId
}

function optionalGlobalIdValue(value: unknown, label: string, pattern: RegExp): string | null {
  const globalId = textValue(value, label, 16, false)
  if (!globalId) return null
  if (!pattern.test(globalId)) requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  return globalId
}

function requestedDeliveryValue(value: unknown): string {
  const raw = textValue(value, 'Requested delivery date', 50)
  const date = new Date(raw)
  const now = Date.now()
  if (Number.isNaN(date.getTime()) || date.getTime() < now - 60_000 || date.getTime() > now + 366 * 24 * 60 * 60 * 1000) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Requested delivery date must be within the next year')
  }
  return date.toISOString()
}

function addressValue(value: unknown): Address {
  const input = record(value, 'OPERATIONS_REQUEST_INVALID', 'Ship-to address')
  assertFields(input, ADDRESS_FIELDS, 'OPERATIONS_REQUEST_INVALID', 'Ship-to address')
  const country = textValue(input.country, 'Ship-to country', 2).toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) requestError('OPERATIONS_REQUEST_INVALID', 'Ship-to country is invalid')
  return {
    name: textValue(input.name, 'Ship-to name', 120),
    line1: textValue(input.line1, 'Ship-to address', 160),
    line2: textValue(input.line2, 'Ship-to address line 2', 160, false) || undefined,
    city: textValue(input.city, 'Ship-to city', 100),
    region: textValue(input.region, 'Ship-to region', 100),
    postalCode: textValue(input.postalCode, 'Ship-to postal code', 30),
    country,
  }
}

function carrierDispatchAddressValue(
  value: unknown,
  label: string,
): ActiveCarrierDispatchAddressSnapshot {
  const input = record(value, 'OPERATIONS_REQUEST_INVALID', label)
  assertFields(
    input,
    CARRIER_DISPATCH_ADDRESS_FIELDS,
    'OPERATIONS_REQUEST_INVALID',
    label,
  )
  const countryCode = textValue(
    input.countryCode,
    `${label} country`,
    2,
  ).toUpperCase()
  if (countryCode !== 'US') {
    requestError(
      'OPERATIONS_REQUEST_INVALID',
      `${label} must use the currently supported US production carrier lane`,
    )
  }
  const region = textValue(input.region, `${label} region`, 2).toUpperCase()
  if (!/^[A-Z]{2}$/.test(region)) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} region is invalid`)
  }
  if (typeof input.residential !== 'boolean') {
    requestError(
      'OPERATIONS_REQUEST_INVALID',
      `${label} residential classification is required`,
    )
  }
  return {
    contactName: textValue(input.contactName, `${label} contact name`, 100),
    companyName: textValue(
      input.companyName,
      `${label} company name`,
      120,
      false,
    ) || null,
    phone: textValue(input.phone, `${label} phone`, 40, false) || null,
    email: textValue(input.email, `${label} email`, 254, false) || null,
    line1: textValue(input.line1, `${label} line 1`, 160),
    line2: textValue(input.line2, `${label} line 2`, 120, false) || null,
    line3: textValue(input.line3, `${label} line 3`, 120, false) || null,
    city: textValue(input.city, `${label} city`, 100),
    region,
    postalCode: textValue(input.postalCode, `${label} postal code`, 32),
    countryCode: 'US',
    residential: input.residential,
  }
}

function proofLinesValue(input: Record<string, unknown>): MockOperationsProofLineInput[] {
  const hasLines = input.lines !== undefined
  const hasLegacyLine = input.productGlobalId !== undefined
    || input.quantity !== undefined
    || input.openingQuantity !== undefined
  if (hasLines && hasLegacyLine) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Use either proof order lines or the legacy single product fields')
  }

  const rawLines = hasLines
    ? input.lines
    : [{
        productGlobalId: input.productGlobalId,
        quantity: input.quantity,
        openingQuantity: input.openingQuantity,
      }]
  if (!Array.isArray(rawLines) || rawLines.length < 1 || rawLines.length > 25) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Proof order must include from 1 to 25 product lines')
  }

  const seen = new Set<string>()
  return rawLines.map((value, index) => {
    const line = record(value, 'OPERATIONS_REQUEST_INVALID', `Proof order line ${index + 1}`)
    assertFields(line, PROOF_LINE_FIELDS, 'OPERATIONS_REQUEST_INVALID', `Proof order line ${index + 1}`)
    const productGlobalId = globalIdValue(line.productGlobalId, `Product on line ${index + 1}`, PRODUCT_GLOBAL_ID)
    if (seen.has(productGlobalId)) {
      requestError('OPERATIONS_REQUEST_INVALID', 'Each product may appear only once on a proof order')
    }
    seen.add(productGlobalId)
    return {
      productGlobalId,
      quantity: integerValue(line.quantity, `Quantity on line ${index + 1}`, 1, 1_000),
      openingQuantity: integerValue(line.openingQuantity, `Opening inventory on line ${index + 1}`, 1, 100_000),
    }
  })
}

function proofValue(value: unknown): MockOperationsProofInput {
  const input = record(value, 'OPERATIONS_REQUEST_INVALID', 'Proof order')
  assertFields(input, PROOF_FIELDS, 'OPERATIONS_REQUEST_INVALID', 'Proof order')
  const executionMode = textValue(input.executionMode, 'Proof execution mode', 20, false) || 'planned'
  if (!['planned', 'shipped'].includes(executionMode)) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Proof execution mode is invalid')
  }
  return {
    customerGlobalId: globalIdValue(input.customerGlobalId, 'CRM customer', CUSTOMER_GLOBAL_ID),
    lines: proofLinesValue(input),
    externalOrderId: textValue(input.externalOrderId, 'External order ID', 120),
    orderNumber: textValue(input.orderNumber, 'Order number', 100),
    requestedDeliveryAt: requestedDeliveryValue(input.requestedDeliveryAt),
    shipTo: addressValue(input.shipTo),
    executionMode: executionMode as MockOperationsProofInput['executionMode'],
  }
}

function idempotencyKeyValue(req: NextRequest): string {
  const key = String(req.headers.get('idempotency-key') || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    requestError('OPERATIONS_IDEMPOTENCY_KEY_INVALID', 'A valid Idempotency-Key header is required')
  }
  return key
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    requestError('OPERATIONS_CONTENT_TYPE_INVALID', 'Operations commands require JSON', 415)
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    requestError('OPERATIONS_REQUEST_TOO_LARGE', 'Operations command exceeded the supported size', 413)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    requestError('OPERATIONS_REQUEST_TOO_LARGE', 'Operations command exceeded the supported size', 413)
  }
  try {
    const parsed = record(
      JSON.parse(raw) as unknown,
      'OPERATIONS_REQUEST_INVALID',
      'Operations command',
    )
    if (
      Buffer.byteLength(raw, 'utf8') > MAX_STANDARD_REQUEST_BYTES
      && parsed.action !== 'record-pick-scan-evidence'
    ) {
      requestError(
        'OPERATIONS_REQUEST_TOO_LARGE',
        'Operations command exceeded the supported size',
        413,
      )
    }
    return parsed
  } catch (error) {
    if (error instanceof OperationsRequestError) throw error
    requestError('OPERATIONS_REQUEST_INVALID', 'A valid operations command is required')
  }
}

function errorResponse(error: unknown) {
  const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
  if (maintenance) return maintenance
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
  }
  if (error instanceof OperationsRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof OperationsOrderUnitWeightError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && 'status' in error
    && error.code === 'OPERATIONS_SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY'
    && error.status === 409
  ) {
    return json({
      ok: false,
      error: 'Pack confirmation is using this exact evidence; retry after refreshing status',
      code: error.code,
    }, error.status)
  }
  if (error instanceof CommerceStoreSyncPersistenceError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CommerceOrderWorkbenchError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof OperationsOrderShipmentAddressError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof OperationsShadowTrainingError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CommerceActiveTransitionPersistenceError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof SandboxCommerceE2eAuthorizationError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (
    error instanceof ShopifyTestStoreCanonicalE2eError
    || error instanceof ShopifyTestStoreCanonicalE2ePersistenceError
  ) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CommerceOrderRevisionDispositionError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (
    error instanceof CarrierIntegrationRequestError
    || error instanceof ActiveFulfillmentExecutionPreparationError
    || error instanceof ProductionFulfillmentReratePersistenceError
    || error instanceof ProductionFulfillmentRerateExecutionError
  ) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
      ...(
        error instanceof ProductionFulfillmentRerateExecutionError
        && error.attemptGlobalId
          ? { attemptGlobalId: error.attemptGlobalId }
          : {}
      ),
    }, error.status)
  }
  const code = error instanceof Error && /^OPERATIONS_[A-Z_]+$/.test(error.message)
    ? error.message
    : 'OPERATIONS_REQUEST_FAILED'
  const status = code === 'OPERATIONS_REQUEST_FAILED' ? 500 : 400
  if (status === 500) {
    console.error('[operations] unhandled request failure', {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    })
  }
  return json({ ok: false, error: status === 500 ? 'Operations request failed' : code, code }, status)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    const organizationId = activeOperationsOrganizationId(actor)
    if (!capabilities.canView) {
      return json({
        ok: false,
        error: 'Your organization administrator has not granted access to operations data',
        code: 'OPERATIONS_VIEW_REQUIRED',
      }, 403)
    }
    const statusValue = String(req.nextUrl.searchParams.get('status') || '').trim()
    if (statusValue && !ORDER_STATUSES.has(statusValue as OperationsOrderFilter)) {
      requestError('OPERATIONS_STATUS_INVALID', 'Order status is invalid')
    }
    const exceptionStatusValue = String(req.nextUrl.searchParams.get('exceptionStatus') || '').trim()
    if (exceptionStatusValue && !EXCEPTION_STATUSES.has(exceptionStatusValue as OperationsExceptionStatus)) {
      requestError('OPERATIONS_EXCEPTION_STATUS_INVALID', 'Exception status is invalid')
    }
    const selectedValue = String(req.nextUrl.searchParams.get('order') || '').trim()
    if (selectedValue && !ORDER_GLOBAL_ID.test(selectedValue)) {
      requestError('OPERATIONS_ORDER_INVALID', 'Order is invalid')
    }
    const search = String(req.nextUrl.searchParams.get('search') || '').trim()
    if (search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)) {
      requestError('OPERATIONS_SEARCH_INVALID', 'Order search is invalid')
    }
    const sortValue = String(
      req.nextUrl.searchParams.get('sort') || 'updated',
    ).trim()
    if (!isOperationsOrderSort(sortValue)) {
      requestError('OPERATIONS_ORDER_SORT_INVALID', 'Order sort is invalid')
    }
    const directionValue = String(
      req.nextUrl.searchParams.get('direction') || 'desc',
    ).trim()
    if (!isOperationsOrderSortDirection(directionValue)) {
      requestError(
        'OPERATIONS_ORDER_SORT_DIRECTION_INVALID',
        'Order sort direction is invalid',
      )
    }
    const providerValue = String(
      req.nextUrl.searchParams.get('provider') || '',
    ).trim()
    if (providerValue && !isOperationsOrderProviderFilter(providerValue)) {
      requestError(
        'OPERATIONS_ORDER_PROVIDER_INVALID',
        'Order provider is invalid',
      )
    }
    const trackingValue = String(
      req.nextUrl.searchParams.get('tracking') || '',
    ).trim()
    if (
      trackingValue
      && !isOperationsOrderTrackingFilter(trackingValue)
    ) {
      requestError(
        'OPERATIONS_ORDER_TRACKING_FILTER_INVALID',
        'Order tracking filter is invalid',
      )
    }
    const tracking = isOperationsOrderTrackingFilter(trackingValue)
      ? trackingValue
      : null
    const updatedAfterValue = String(
      req.nextUrl.searchParams.get('updatedAfter') || '',
    ).trim()
    if (
      updatedAfterValue
      && !isOperationsOrderUpdatedAfter(updatedAfterValue)
    ) {
      requestError(
        'OPERATIONS_ORDER_UPDATED_AFTER_INVALID',
        'Order updated-after value is invalid',
      )
    }
    const includeOrderSummariesValue = String(
      req.nextUrl.searchParams.get('includeOrderSummaries') || '',
    ).trim()
    if (
      includeOrderSummariesValue
      && !['true', 'false'].includes(includeOrderSummariesValue)
    ) {
      requestError(
        'OPERATIONS_ORDER_SUMMARY_MODE_INVALID',
        'Order summary mode is invalid',
      )
    }
    const operations = await readOperationsWorkspaceFromPostgres({
      organizationId,
      actorEmail: actor.email,
      capabilities,
      canVerifyPhysicalOutput: capabilities.canExecute
        && canUsePhysicalOutputAttestationBrowserSession({
          session: await requestSession(req),
          actor,
          organizationId,
        }),
      canPurchaseLivePostage:
        shippingCapabilities(actor).canPurchaseLivePostage,
      search,
      status: (statusValue as OperationsOrderFilter) || null,
      sort: sortValue,
      direction: directionValue,
      provider: providerValue || null,
      tracking,
      updatedAfter: updatedAfterValue || null,
      includeOrderSummaries: includeOrderSummariesValue !== 'false',
      exceptionStatus: (exceptionStatusValue as OperationsExceptionStatus) || null,
      selectedOrderGlobalId: selectedValue || null,
    })
    return json({
      ok: true,
      operations,
      runtime: {
        commerceFulfillmentRecoveryEnabled:
          commerceFulfillmentRecoveryRuntimeAvailable(),
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    const body = await requestBody(req)
    const action = textValue(body.action, 'Operations action', 50)
    if (SHADOW_COMMERCE_CANONICAL_ORDER_ACTIONS.has(action)) {
      await assertCanonicalShadowCommerceOrderIsMirrorOnlyInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        orderGlobalId: globalIdValue(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
      })
    }
    if (action === 'create-warehouse') {
      if (!capabilities.canManage) {
        return json({ ok: false, error: 'You do not have permission to configure warehouses', code: 'OPERATIONS_MANAGE_REQUIRED' }, 403)
      }
      assertFields(body, new Set([
        'action', 'code', 'name', 'facilityType', 'timezone', 'address', 'cutoffTime',
        'operatingDays', 'opensAt', 'closesAt', 'standardProcessingMinutes',
        'dailyOrderCapacity', 'carrierCutoffs', 'createStarterLocations',
      ]), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const result = await createOperationsWarehouseInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        code: textValue(body.code, 'Warehouse code', 32),
        name: textValue(body.name, 'Warehouse name', 160),
        facilityType: (textValue(body.facilityType, 'Facility type', 40, false) || 'distribution_center') as OperationsWorkspace['warehouses'][number]['facilityType'],
        timezone: textValue(body.timezone, 'Warehouse timezone', 80),
        address: addressValue(body.address),
        cutoffTime: textValue(body.cutoffTime, 'Warehouse cutoff', 8, false) || null,
        operatingDays: operatingDaysValue(body.operatingDays),
        opensAt: textValue(body.opensAt ?? '08:00', 'Warehouse opening time', 8),
        closesAt: textValue(body.closesAt ?? '17:00', 'Warehouse closing time', 8),
        standardProcessingMinutes: integerValue(
          body.standardProcessingMinutes ?? 120,
          'Standard processing time',
          0,
          10_080,
        ),
        dailyOrderCapacity: body.dailyOrderCapacity === null
          || body.dailyOrderCapacity === undefined
          || body.dailyOrderCapacity === ''
          ? null
          : integerValue(body.dailyOrderCapacity, 'Daily order capacity', 1, 1_000_000_000),
        carrierCutoffs: carrierCutoffsValue(body.carrierCutoffs),
        createStarterLocations: body.createStarterLocations !== false,
      })
      return json({ ok: true, capabilities, result }, 201)
    }
    if (action === 'update-warehouse') {
      if (!capabilities.canManage) {
        return json({ ok: false, error: 'You do not have permission to configure warehouses', code: 'OPERATIONS_MANAGE_REQUIRED' }, 403)
      }
      assertFields(body, new Set([
        'action', 'warehouseGlobalId', 'expectedRowVersion', 'name', 'facilityType',
        'timezone', 'address', 'cutoffTime', 'operatingDays', 'opensAt', 'closesAt',
        'standardProcessingMinutes', 'dailyOrderCapacity', 'carrierCutoffs', 'status',
      ]), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const result = await updateOperationsWarehouseInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        warehouseGlobalId: globalIdValue(body.warehouseGlobalId, 'Warehouse', WAREHOUSE_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Warehouse version', 0, 2_147_483_647),
        name: textValue(body.name, 'Warehouse name', 160),
        facilityType: textValue(body.facilityType, 'Facility type', 40) as OperationsWorkspace['warehouses'][number]['facilityType'],
        timezone: textValue(body.timezone, 'Warehouse timezone', 80),
        address: addressValue(body.address),
        cutoffTime: textValue(body.cutoffTime, 'Warehouse cutoff', 8, false) || null,
        operatingDays: operatingDaysValue(body.operatingDays),
        opensAt: textValue(body.opensAt ?? '08:00', 'Warehouse opening time', 8),
        closesAt: textValue(body.closesAt ?? '17:00', 'Warehouse closing time', 8),
        standardProcessingMinutes: integerValue(
          body.standardProcessingMinutes ?? 120,
          'Standard processing time',
          0,
          10_080,
        ),
        dailyOrderCapacity: body.dailyOrderCapacity === null
          || body.dailyOrderCapacity === undefined
          || body.dailyOrderCapacity === ''
          ? null
          : integerValue(body.dailyOrderCapacity, 'Daily order capacity', 1, 1_000_000_000),
        carrierCutoffs: carrierCutoffsValue(body.carrierCutoffs),
        status: textValue(body.status, 'Warehouse status', 20) as 'active' | 'inactive',
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'create-location') {
      if (!capabilities.canManage) {
        return json({ ok: false, error: 'You do not have permission to configure warehouse locations', code: 'OPERATIONS_MANAGE_REQUIRED' }, 403)
      }
      assertFields(body, new Set([
        'action', 'warehouseGlobalId', 'code', 'zone', 'locationType', 'topologyLevel',
        'parentLocationGlobalId', 'pickSequence', 'active', 'maxVolumeCubicMeters',
        'maxWeightKg', 'allowMixedProducts', 'storageFunction', 'notes', 'productRules',
      ]), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const locationType = textValue(body.locationType, 'Location type', 20) as OperationsWorkspace['warehouses'][number]['locations'][number]['locationType']
      const result = await createOperationsLocationInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        warehouseGlobalId: globalIdValue(body.warehouseGlobalId, 'Warehouse', WAREHOUSE_GLOBAL_ID),
        code: textValue(body.code, 'Location code', 40),
        zone: textValue(body.zone, 'Location zone', 80),
        locationType,
        topologyLevel: textValue(body.topologyLevel, 'Topology level', 20) as OperationsWorkspace['warehouses'][number]['locations'][number]['topologyLevel'],
        parentLocationGlobalId: optionalGlobalIdValue(body.parentLocationGlobalId, 'Parent location', LOCATION_GLOBAL_ID),
        pickSequence: integerValue(body.pickSequence, 'Pick sequence', 0, 1_000_000),
        active: booleanValue(body.active, true),
        storageFunction: locationStorageFunctionValue(body.storageFunction, locationType),
        maxVolumeCubicMeters: optionalNumberValue(body.maxVolumeCubicMeters, 'Maximum cubic storage', 0.000001, 1_000_000_000),
        maxWeightKg: optionalNumberValue(body.maxWeightKg, 'Maximum weight', 0.000001, 1_000_000_000),
        allowMixedProducts: booleanValue(body.allowMixedProducts, true),
        notes: textValue(body.notes, 'Location notes', 2_000, false) || null,
        productRules: locationProductRulesValue(body.productRules),
      })
      return json({ ok: true, capabilities, result }, 201)
    }
    if (action === 'update-location') {
      if (!capabilities.canManage) {
        return json({ ok: false, error: 'You do not have permission to configure warehouse locations', code: 'OPERATIONS_MANAGE_REQUIRED' }, 403)
      }
      assertFields(body, new Set([
        'action', 'warehouseGlobalId', 'locationGlobalId', 'expectedRowVersion',
        'code', 'zone', 'locationType', 'topologyLevel', 'parentLocationGlobalId',
        'pickSequence', 'active', 'maxVolumeCubicMeters', 'maxWeightKg',
        'allowMixedProducts', 'storageFunction', 'notes', 'productRules',
      ]), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const locationType = textValue(body.locationType, 'Location type', 20) as OperationsWorkspace['warehouses'][number]['locations'][number]['locationType']
      const result = await updateOperationsLocationInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        warehouseGlobalId: globalIdValue(body.warehouseGlobalId, 'Warehouse', WAREHOUSE_GLOBAL_ID),
        locationGlobalId: globalIdValue(body.locationGlobalId, 'Location', LOCATION_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Location version', 0, 2_147_483_647),
        code: textValue(body.code, 'Location code', 40),
        zone: textValue(body.zone, 'Location zone', 80),
        locationType,
        topologyLevel: textValue(body.topologyLevel, 'Topology level', 20) as OperationsWorkspace['warehouses'][number]['locations'][number]['topologyLevel'],
        parentLocationGlobalId: optionalGlobalIdValue(body.parentLocationGlobalId, 'Parent location', LOCATION_GLOBAL_ID),
        pickSequence: integerValue(body.pickSequence, 'Pick sequence', 0, 1_000_000),
        active: booleanValue(body.active, true),
        storageFunction: locationStorageFunctionValue(body.storageFunction, locationType),
        maxVolumeCubicMeters: optionalNumberValue(body.maxVolumeCubicMeters, 'Maximum cubic storage', 0.000001, 1_000_000_000),
        maxWeightKg: optionalNumberValue(body.maxWeightKg, 'Maximum weight', 0.000001, 1_000_000_000),
        allowMixedProducts: booleanValue(body.allowMixedProducts, true),
        notes: textValue(body.notes, 'Location notes', 2_000, false) || null,
        productRules: locationProductRulesValue(body.productRules),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'delete-location') {
      if (!capabilities.canManage) {
        return json({ ok: false, error: 'You do not have permission to remove warehouse locations', code: 'OPERATIONS_MANAGE_REQUIRED' }, 403)
      }
      assertFields(
        body,
        new Set(['action', 'locationGlobalId', 'expectedRowVersion']),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await deleteOperationsLocationInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        locationGlobalId: globalIdValue(body.locationGlobalId, 'Location', LOCATION_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Location version', 0, 2_147_483_647),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'create-inbound-receipt') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to create inbound receipts',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'warehouseGlobalId',
          'inventoryPoolGlobalId',
          'referenceNumber',
          'expectedAt',
          'lines',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await createOperationsInboundReceiptInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        receipt: {
          warehouseGlobalId: globalIdValue(
            body.warehouseGlobalId,
            'Warehouse',
            WAREHOUSE_GLOBAL_ID,
          ),
          inventoryPoolGlobalId: globalIdValue(
            body.inventoryPoolGlobalId,
            'Inventory pool',
            INVENTORY_POOL_GLOBAL_ID,
          ),
          referenceNumber: textValue(body.referenceNumber, 'Receipt reference', 120),
          expectedAt: optionalDateTimeValue(body.expectedAt, 'Expected date'),
          lines: inboundReceiptLinesValue(body.lines),
        },
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result }, result.replayed ? 200 : 201)
    }
    if (action === 'complete-inbound-receipt') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to complete inbound receipts',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'receiptGlobalId',
          'expectedRowVersion',
          'reason',
          'lines',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await completeOperationsInboundReceiptInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        completion: {
          receiptGlobalId: globalIdValue(
            body.receiptGlobalId,
            'Inbound receipt',
            RECEIPT_GLOBAL_ID,
          ),
          expectedRowVersion: integerValue(
            body.expectedRowVersion,
            'Receipt version',
            0,
            2_147_483_647,
          ),
          reason: textValue(body.reason, 'Receiving reason', 500),
          lines: inboundReceiptCompletionLinesValue(body.lines),
        },
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'execute-replenishment') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to execute warehouse replenishment',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'sourceLocationGlobalId',
          'destinationLocationGlobalId',
          'inventoryPoolGlobalId',
          'productGlobalId',
          'quantity',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await executeOperationsReplenishmentInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        replenishment: {
          sourceLocationGlobalId: globalIdValue(
            body.sourceLocationGlobalId,
            'Source location',
            LOCATION_GLOBAL_ID,
          ),
          destinationLocationGlobalId: globalIdValue(
            body.destinationLocationGlobalId,
            'Destination location',
            LOCATION_GLOBAL_ID,
          ),
          inventoryPoolGlobalId: globalIdValue(
            body.inventoryPoolGlobalId,
            'Inventory pool',
            INVENTORY_POOL_GLOBAL_ID,
          ),
          productGlobalId: globalIdValue(
            body.productGlobalId,
            'Product',
            PRODUCT_GLOBAL_ID,
          ),
          quantity: positiveNumberValue(body.quantity, 'Replenishment quantity'),
        },
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result }, result.replayed ? 200 : 201)
    }
    if (action === 'run-proof-order') {
      requireOperationsProofFixture()
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to prepare warehouse operations',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(body, new Set(['action', 'proof']), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const result = await runMockOperationsProofFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        proof: proofValue(body.proof),
      })
      return json({ ok: true, capabilities, result }, result.duplicate ? 200 : 201)
    }
    if (action === 'plan-order') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to plan warehouse work',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'cartonizationEvidenceGlobalId',
          'expectedRowVersion',
          'reason',
          'sandboxE2eAuthorizationGlobalId',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const organizationId = activeOperationsOrganizationId(actor)
      const orderGlobalId = globalIdValue(
        body.orderGlobalId,
        'Operations order',
        ORDER_GLOBAL_ID,
      )
      const result = await planOperationsOrderFromPostgres({
        organizationId,
        actorEmail: actor.email,
        orderGlobalId,
        cartonizationEvidenceGlobalId: globalIdValue(
          body.cartonizationEvidenceGlobalId,
          'Cartonization evidence',
          CARTONIZATION_EVIDENCE_GLOBAL_ID,
        ),
        expectedRowVersion: integerValue(
          body.expectedRowVersion,
          'Order version',
          0,
          2_147_483_647,
        ),
        reason: textValue(body.reason, 'Planning reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
        sandboxE2eAuthorizationGlobalId: optionalGlobalIdValue(
          body.sandboxE2eAuthorizationGlobalId,
          'Test fulfillment authorization',
          /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/,
        ),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'release-order') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to release warehouse work',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action', 'orderGlobalId', 'expectedRowVersion', 'reason',
          'assignedTo', 'sandboxE2eAuthorizationGlobalId',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await releaseOperationsOrderFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Release reason', 500),
        assignedTo: textValue(body.assignedTo, 'Assigned picker', 254, false) || undefined,
        idempotencyKey: idempotencyKeyValue(req),
        sandboxE2eAuthorizationGlobalId: optionalGlobalIdValue(
          body.sandboxE2eAuthorizationGlobalId,
          'Shopify test-store authorization',
          /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/,
        ),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'reopen-order-for-replanning') {
      if (!capabilities.canManage) {
        return json({
          ok: false,
          error: 'You do not have permission to correct warehouse work',
          code: 'OPERATIONS_MANAGE_REQUIRED',
        }, 403)
      }
      if (!capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to execute warehouse work corrections',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'expectedRowVersion',
          'expectedPlanGlobalId',
          'expectedPlanVersion',
          'expectedCorrectionFingerprint',
          'reason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const expectedCorrectionFingerprint = textValue(
        body.expectedCorrectionFingerprint,
        'Correction fingerprint',
        64,
      ).toLowerCase()
      if (!SHA256.test(expectedCorrectionFingerprint)) {
        requestError(
          'OPERATIONS_REPLANNING_FINGERPRINT_INVALID',
          'Correction fingerprint is invalid',
        )
      }
      const result = await reopenOperationsOrderForReplanningInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        expectedRowVersion: integerValue(
          body.expectedRowVersion,
          'Order version',
          0,
          2_147_483_647,
        ),
        expectedPlanGlobalId: globalIdValue(
          body.expectedPlanGlobalId,
          'Fulfillment plan',
          /^gfp(?:[0-9]{7}|[0-9a-v]{12})$/,
        ),
        expectedPlanVersion: integerValue(
          body.expectedPlanVersion,
          'Fulfillment plan version',
          1,
          2_147_483_647,
        ),
        expectedCorrectionFingerprint,
        reason: textValue(body.reason, 'Correction reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result }, result.replayed ? 200 : 201)
    }
    if (action === 'assign-picks') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to assign warehouse picks',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'expectedRowVersion',
          'assignedTo',
          'reason',
          'sandboxE2eAuthorizationGlobalId',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await assignOperationsOrderPicksFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        assignedTo: textValue(body.assignedTo, 'Assigned picker', 254),
        reason: textValue(body.reason, 'Assignment reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
        sandboxE2eAuthorizationGlobalId: optionalGlobalIdValue(
          body.sandboxE2eAuthorizationGlobalId,
          'Shopify test-store authorization',
          /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/,
        ),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'manage-pick-assignment') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to manage warehouse pick assignments',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'expectedRowVersion',
          'expectedTaskCount',
          'expectedAssignmentFingerprint',
          'assignedTo',
          'reason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await manageOperationsOrderPickAssignmentFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        expectedRowVersion: integerValue(
          body.expectedRowVersion,
          'Order version',
          0,
          2_147_483_647,
        ),
        expectedTaskCount: integerValue(
          body.expectedTaskCount,
          'Expected pick task count',
          1,
          200,
        ),
        expectedAssignmentFingerprint: textValue(
          body.expectedAssignmentFingerprint,
          'Expected picker-assignment fingerprint',
          64,
        ).toLowerCase(),
        assignedTo: textValue(
          body.assignedTo,
          'Assigned picker',
          254,
          false,
        ).toLowerCase() || null,
        reason: textValue(body.reason, 'Manager intervention reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'request-pick-handoff') {
      if (!canRequestOperationsPickHandoff(capabilities)) {
        return json({
          ok: false,
          error: 'You do not have permission to request a picker handoff',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'expectedRowVersion',
          'expectedAssignedTaskCount',
          'reason',
          'blockedConfirmationIdempotencyKey',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await requestOperationsPickHandoffFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        expectedRowVersion: integerValue(
          body.expectedRowVersion,
          'Order version',
          0,
          2_147_483_647,
        ),
        expectedAssignedTaskCount: integerValue(
          body.expectedAssignedTaskCount,
          'Assigned task count',
          1,
          200,
        ),
        reason: textValue(body.reason, 'Picker handoff reason', 500),
        blockedConfirmationIdempotencyKey: textValue(
          body.blockedConfirmationIdempotencyKey,
          'Blocked confirmation idempotency key',
          200,
          false,
        ) || undefined,
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'record-pick-scan-evidence') {
      if (!capabilities.canView || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to record warehouse scan evidence',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'expectedRowVersion',
          'scanEvidence',
          'sandboxE2eAuthorizationGlobalId',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await recordWearablePickScanEvidenceFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        scanEvidence: wearablePickScanEvidenceValue(body.scanEvidence),
        idempotencyKey: idempotencyKeyValue(req),
        sandboxE2eAuthorizationGlobalId: optionalGlobalIdValue(
          body.sandboxE2eAuthorizationGlobalId,
          'Shopify test-store authorization',
          /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/,
        ),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'confirm-picks') {
      if (!capabilities.canView || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to confirm warehouse picks',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'expectedRowVersion',
          'reason',
          'scanEvidenceIdempotencyKey',
          'countEvidenceIdempotencyKey',
          'countEvidence',
          'sandboxE2eAuthorizationGlobalId',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const countEvidenceIdempotencyKey = textValue(
        body.countEvidenceIdempotencyKey,
        'Count evidence idempotency key',
        200,
        false,
      ) || undefined
      const countEvidence = body.countEvidence === undefined
        ? undefined
        : wearablePickCountEvidenceValue(body.countEvidence)
      if ((countEvidenceIdempotencyKey === undefined) !== (countEvidence === undefined)) {
        requestError(
          'OPERATIONS_WEARABLE_COUNT_EVIDENCE_INVALID',
          'Count evidence and its idempotency key must be supplied together',
        )
      }
      const result = await confirmOperationsOrderPicksFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Pick confirmation reason', 500),
        scanEvidenceIdempotencyKey: textValue(
          body.scanEvidenceIdempotencyKey,
          'Scan evidence idempotency key',
          200,
          false,
        ) || undefined,
        countEvidenceIdempotencyKey,
        countEvidence,
        idempotencyKey: idempotencyKeyValue(req),
        sandboxE2eAuthorizationGlobalId: optionalGlobalIdValue(
          body.sandboxE2eAuthorizationGlobalId,
          'Shopify test-store authorization',
          /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/,
        ),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'reconcile-external-fulfillment') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to reconcile external fulfillment',
          code: 'OPERATIONS_MANAGE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action', 'orderGlobalId', 'expectedRowVersion', 'reason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await reconcileShopifyExternalFulfillmentFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        expectedRowVersion: integerValue(
          body.expectedRowVersion,
          'Order version',
          0,
          2_147_483_647,
        ),
        reason: textValue(body.reason, 'Reconciliation reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'verify-pack') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to verify warehouse packages',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action', 'orderGlobalId', 'expectedRowVersion', 'reason',
          'sandboxE2eAuthorizationGlobalId',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await verifyOperationsOrderPackFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Package verification reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
        sandboxE2eAuthorizationGlobalId: optionalGlobalIdValue(
          body.sandboxE2eAuthorizationGlobalId,
          'Shopify test-store authorization',
          /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/,
        ),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'authorize-shopify-test-store-canonical-e2e') {
      if (!capabilities.canActivate || !capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'Only an organization owner or administrator may enable test fulfillment',
          code: 'OPERATIONS_ACTIVATION_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action', 'orderGlobalId', 'expectedRowVersion',
          'confirmationStatement', 'reason', 'lifetimeMinutes',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await authorizeShopifyTestStoreCanonicalE2e({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        idempotencyKey: idempotencyKeyValue(req),
        orderGlobalId: globalIdValue(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        expectedOrderRowVersion: integerValue(
          body.expectedRowVersion,
          'Order version',
          0,
          2_147_483_647,
        ),
        confirmationStatement: body.confirmationStatement,
        reason: textValue(body.reason, 'Test fulfillment reason', 500),
        lifetimeMinutes: body.lifetimeMinutes === undefined
          ? undefined
          : integerValue(body.lifetimeMinutes, 'Authorization lifetime', 5, 240),
      })
      return json({ ok: true, capabilities, result }, result.replayed ? 200 : 201)
    }
    if (action === 'confirm-shopify-test-store-e2e-fulfillment') {
      if (!capabilities.canActivate || !capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'Only an organization owner or administrator may confirm test fulfillment',
          code: 'OPERATIONS_ACTIVATION_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action', 'authorizationGlobalId', 'orderGlobalId',
          'expectedRowVersion', 'confirmationStatement', 'reason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result =
        await confirmShopifyTestStoreCanonicalE2eFulfillmentInPostgres({
          organizationId: activeOperationsOrganizationId(actor),
          actorEmail: actor.email,
          idempotencyKey: idempotencyKeyValue(req),
          authorizationGlobalId: globalIdValue(
            body.authorizationGlobalId,
            'Test fulfillment authorization',
            /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/,
          ),
          orderGlobalId: globalIdValue(
            body.orderGlobalId,
            'Operations order',
            ORDER_GLOBAL_ID,
          ),
          expectedOrderRowVersion: integerValue(
            body.expectedRowVersion,
            'Order version',
            0,
            2_147_483_647,
          ),
          confirmationStatement: body.confirmationStatement,
          reason: textValue(body.reason, 'Fulfillment confirmation reason', 500),
        })
      return json({ ok: true, capabilities, result }, result.replayed ? 200 : 201)
    }
    if (action === 'authorize-sandbox-commerce-e2e') {
      if (!capabilities.canActivate || !capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'Only an organization owner or administrator may enable test fulfillment',
          code: 'OPERATIONS_ACTIVATION_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action', 'orderGlobalId', 'confirmationStatement', 'reason',
          'lifetimeMinutes',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await authorizeSandboxCommerceE2eInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        confirmationStatement: body.confirmationStatement,
        reason: textValue(body.reason, 'Test fulfillment reason', 500),
        lifetimeMinutes: body.lifetimeMinutes === undefined
          ? undefined
          : integerValue(body.lifetimeMinutes, 'Authorization lifetime', 5, 1_440),
      })
      return json({ ok: true, capabilities, result }, 201)
    }
    if (action === 'prepare-shipment-execution') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to prepare Shadow shipment execution',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set(['action', 'orderGlobalId', 'expectedRowVersion', 'reason']),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await prepareOperationsShipmentExecutionFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        expectedRowVersion: integerValue(
          body.expectedRowVersion,
          'Order version',
          0,
          2_147_483_647,
        ),
        reason: textValue(
          body.reason,
          'Shadow shipment-preparation reason',
          500,
        ),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json(
        { ok: true, capabilities, result },
        result.replayed ? 200 : 201,
      )
    }
    if (action === 'prepare-active-fulfillment-execution') {
      if (
        !capabilities.canManage
        || !shippingCapabilities(actor).canPurchaseLivePostage
      ) {
        return json({
          ok: false,
          error: 'You do not have permission to prepare production carrier execution',
          code: 'OPERATIONS_LIVE_POSTAGE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'shadowExecutionGlobalId',
          'expectedActivationRevision',
          'expectedOrderRowVersion',
          'reason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result =
        await prepareActiveFulfillmentExecutionFromShadowInPostgres({
          organizationId: activeOperationsOrganizationId(actor),
          shadowExecutionGlobalId: globalIdValue(
            body.shadowExecutionGlobalId,
            'Shadow fulfillment execution',
            SHADOW_EXECUTION_GLOBAL_ID,
          ),
          expectedActivationRevision: integerValue(
            body.expectedActivationRevision,
            'Expected activation revision',
            1,
            2_147_483_647,
          ),
          expectedOrderRowVersion: integerValue(
            body.expectedOrderRowVersion,
            'Expected order row version',
            0,
            2_147_483_647,
          ),
          reason: textValue(
            body.reason,
            'Active fulfillment-preparation reason',
            500,
          ),
          idempotencyKey: idempotencyKeyValue(req),
          actorEmail: actor.email,
        })
      return json(
        { ok: true, capabilities, result },
        result.replayed ? 200 : 201,
      )
    }
    if (action === 'execute-production-rerate') {
      if (
        !capabilities.canManage
        || !shippingCapabilities(actor).canPurchaseLivePostage
      ) {
        return json({
          ok: false,
          error: 'You do not have permission to execute production carrier rating',
          code: 'OPERATIONS_LIVE_POSTAGE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'activeExecutionGlobalId',
          'activeShipmentGroupGlobalId',
          'expectedActivationRevision',
          'destination',
          'currency',
          'provider',
          'integrationAccountGlobalId',
          'carrierAccountGlobalId',
          'origin',
          'fedexPickupType',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const provider = textValue(body.provider, 'Carrier provider', 20)
      if (provider !== 'ups_rest' && provider !== 'fedex_rest') {
        requestError(
          'OPERATIONS_REQUEST_INVALID',
          'Carrier provider must be UPS REST or FedEx REST',
        )
      }
      const currency = textValue(body.currency, 'Currency', 3).toUpperCase()
      if (currency !== 'USD') {
        requestError(
          'OPERATIONS_REQUEST_INVALID',
          'Production carrier rerating currently requires USD',
        )
      }
      const fedexPickupType = textValue(
        body.fedexPickupType,
        'FedEx pickup type',
        40,
        false,
      )
      if (
        fedexPickupType
        && ![
          'DROPOFF_AT_FEDEX_LOCATION',
          'CONTACT_FEDEX_TO_SCHEDULE',
          'USE_SCHEDULED_PICKUP',
        ].includes(fedexPickupType)
      ) {
        requestError('OPERATIONS_REQUEST_INVALID', 'FedEx pickup type is invalid')
      }
      const result = await executeProductionFulfillmentRerate({
        organizationId: activeOperationsOrganizationId(actor),
        activeExecutionGlobalId: globalIdValue(
          body.activeExecutionGlobalId,
          'Active fulfillment execution',
          ACTIVE_EXECUTION_GLOBAL_ID,
        ),
        activeShipmentGroupGlobalId: globalIdValue(
          body.activeShipmentGroupGlobalId,
          'Active shipment group',
          ACTIVE_SHIPMENT_GROUP_GLOBAL_ID,
        ),
        expectedActivationRevision: integerValue(
          body.expectedActivationRevision,
          'Expected activation revision',
          1,
          2_147_483_647,
        ),
        destination: carrierDispatchAddressValue(body.destination, 'Destination'),
        currency,
        provider,
        integrationAccountGlobalId: globalIdValue(
          body.integrationAccountGlobalId,
          'Carrier integration account',
          INTEGRATION_ACCOUNT_GLOBAL_ID,
        ),
        carrierAccountGlobalId: globalIdValue(
          body.carrierAccountGlobalId,
          'Carrier account',
          CARRIER_ACCOUNT_GLOBAL_ID,
        ),
        origin: carrierDispatchAddressValue(body.origin, 'Origin'),
        fedexPickupType: fedexPickupType
          ? fedexPickupType as
            | 'DROPOFF_AT_FEDEX_LOCATION'
            | 'CONTACT_FEDEX_TO_SCHEDULE'
            | 'USE_SCHEDULED_PICKUP'
          : null,
        idempotencyKey: idempotencyKeyValue(req),
        actorEmail: actor.email,
      })
      return json({ ok: true, capabilities, result }, 201)
    }
    if (action === 'select-production-rerate-offer') {
      if (
        !capabilities.canManage
        || !shippingCapabilities(actor).canPurchaseLivePostage
      ) {
        return json({
          ok: false,
          error: 'You do not have permission to select a production carrier service',
          code: 'OPERATIONS_LIVE_POSTAGE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'rerateRunGlobalId',
          'offerGlobalId',
          'selectionReason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await selectProductionFulfillmentRerateOfferInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        rerateRunGlobalId: globalIdValue(
          body.rerateRunGlobalId,
          'Production rerate run',
          PRODUCTION_RERATE_RUN_GLOBAL_ID,
        ),
        offerGlobalId: globalIdValue(
          body.offerGlobalId,
          'Production rerate offer',
          PRODUCTION_RERATE_OFFER_GLOBAL_ID,
        ),
        selectionReason: textValue(
          body.selectionReason,
          'Production carrier service selection reason',
          500,
        ),
        idempotencyKey: idempotencyKeyValue(req),
        selectedBy: actor.email,
      })
      return json(
        { ok: true, capabilities, result },
        result.replayed ? 200 : 201,
      )
    }
    if (action === 'generate-packing-slip') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to generate Pack Work Instructions',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'packageGlobalId',
          'expectedRowVersion',
          'sandboxE2eAuthorizationGlobalId',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await generateOperationsPackagePackingSlipInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(
          body.orderGlobalId,
          'Operations order',
          ORDER_GLOBAL_ID,
        ),
        packageGlobalId: globalIdValue(
          body.packageGlobalId,
          'Operations package',
          PACKAGE_GLOBAL_ID,
        ),
        expectedRowVersion: integerValue(
          body.expectedRowVersion,
          'Order version',
          0,
          2_147_483_647,
        ),
        sandboxE2eAuthorizationGlobalId: optionalGlobalIdValue(
          body.sandboxE2eAuthorizationGlobalId,
          'Shopify test-store authorization',
          /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/,
        ),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'confirm-shipment') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to confirm warehouse shipments',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'expectedRowVersion',
          'reason',
          'preferredPrinterGlobalId',
          'sandboxE2eAuthorizationGlobalId',
          'expectedNotificationPolicyRevision',
          'customerNotificationOverride',
          'customerNotificationOverrideReason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await confirmOperationsOrderShipmentFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Shipment confirmation reason', 500),
        preferredPrinterGlobalId: optionalGlobalIdValue(
          body.preferredPrinterGlobalId,
          'Preferred printer',
          PRINTER_GLOBAL_ID,
        ),
        sandboxE2eAuthorizationGlobalId: optionalGlobalIdValue(
          body.sandboxE2eAuthorizationGlobalId,
          'Test fulfillment authorization',
          /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/,
        ),
        expectedNotificationPolicyRevision:
          body.expectedNotificationPolicyRevision === undefined
            || body.expectedNotificationPolicyRevision === null
            ? null
            : integerValue(
                body.expectedNotificationPolicyRevision,
                'Fulfillment notification policy revision',
                0,
                2_147_483_647,
              ),
        customerNotificationOverride: optionalBooleanValue(
          body.customerNotificationOverride,
          'Customer notification override',
        ),
        customerNotificationOverrideReason: body.customerNotificationOverrideReason
          === undefined || body.customerNotificationOverrideReason === null
          ? null
          : textValue(
              body.customerNotificationOverrideReason,
              'Customer notification exception reason',
              500,
            ),
        canPurchaseLivePostage:
          shippingCapabilities(actor).canPurchaseLivePostage,
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'retry-commerce-fulfillment-export') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to retry commerce fulfillment exports',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set(['action', 'commerceExportGlobalId', 'reason']),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await retryOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        commerceExportGlobalId: globalIdValue(
          body.commerceExportGlobalId,
          'Commerce fulfillment export',
          /^gfe(?:[0-9]{7}|[0-9a-v]{12})$/,
        ),
        reason: textValue(body.reason, 'Commerce fulfillment retry reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'create-sandbox-label') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to purchase carrier labels',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'expectedRowVersion',
          'reason',
          'carrierRateGlobalId',
          'carrierAccountGlobalId',
          'preferredPrinterGlobalId',
          'packageGlobalId',
          'sandboxE2eAuthorizationGlobalId',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await createOperationsSandboxLabelInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Label creation reason', 500),
        carrierRateGlobalId: optionalGlobalIdValue(body.carrierRateGlobalId, 'Carrier rate', RATE_GLOBAL_ID),
        carrierAccountGlobalId: optionalGlobalIdValue(
          body.carrierAccountGlobalId,
          'Carrier account',
          CARRIER_ACCOUNT_GLOBAL_ID,
        ),
        preferredPrinterGlobalId: optionalGlobalIdValue(
          body.preferredPrinterGlobalId,
          'Preferred printer',
          PRINTER_GLOBAL_ID,
        ),
        packageGlobalId: optionalGlobalIdValue(
          body.packageGlobalId,
          'Package',
          PACKAGE_GLOBAL_ID,
        ),
        sandboxE2eAuthorizationGlobalId: optionalGlobalIdValue(
          body.sandboxE2eAuthorizationGlobalId,
          'Test fulfillment authorization',
          /^gsea(?:[0-9]{7}|[0-9a-v]{12})$/,
        ),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'void-sandbox-label') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to void carrier labels',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set(['action', 'orderGlobalId', 'expectedRowVersion', 'reason']),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const result = await voidOperationsSandboxLabelInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Label void reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'accept-provider-order-cancellation') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to accept provider order cancellations',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'orderGlobalId',
          'observationGlobalId',
          'readGlobalId',
          'expectedSourceHash',
          'expectedRevisionHash',
          'expectedRowVersion',
          'reason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const expectedSourceHash = textValue(body.expectedSourceHash, 'Provider source hash', 64)
      const expectedRevisionHash = textValue(body.expectedRevisionHash, 'Provider revision hash', 64)
      if (!SHA256.test(expectedSourceHash) || !SHA256.test(expectedRevisionHash)) {
        requestError('OPERATIONS_REQUEST_INVALID', 'Provider revision evidence is invalid')
      }
      const result = await cancelUnstartedCommerceOrderFromProviderRevisionInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        observationGlobalId: globalIdValue(
          body.observationGlobalId,
          'Provider order revision observation',
          COMMERCE_ORDER_REVISION_OBSERVATION_GLOBAL_ID,
        ),
        readGlobalId: globalIdValue(
          body.readGlobalId,
          'Provider order revision exact read',
          COMMERCE_ORDER_REVISION_READ_GLOBAL_ID,
        ),
        expectedSourceHash,
        expectedRevisionHash,
        expectedRowVersion: integerValue(body.expectedRowVersion, 'Order version', 0, 2_147_483_647),
        reason: textValue(body.reason, 'Provider cancellation reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'update-exception') {
      if (!capabilities.canManage) {
        return json({
          ok: false,
          error: 'You do not have permission to manage operations exceptions',
          code: 'OPERATIONS_MANAGE_REQUIRED',
        }, 403)
      }
      assertFields(body, new Set(['action', 'exceptionGlobalId', 'status']), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const status = textValue(body.status, 'Exception status', 20) as OperationsExceptionStatus
      if (!EXCEPTION_STATUSES.has(status)) {
        requestError('OPERATIONS_EXCEPTION_STATUS_INVALID', 'Exception status is invalid')
      }
      const result = await updateOperationsExceptionInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        exceptionGlobalId: globalIdValue(body.exceptionGlobalId, 'Operations exception', EXCEPTION_GLOBAL_ID),
        status,
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'prepare-commerce-active-authorization') {
      if (!capabilities.canActivate) {
        return json({
          ok: false,
          error: 'Only an organization owner or authorized administrator may prepare Operations Active mode',
          code: 'OPERATIONS_ACTIVATION_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'expectedActivationState',
          'expectedActivationRevision',
          'selectedAccounts',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      if (textValue(body.expectedActivationState, 'Expected activation state', 20) !== 'shadow') {
        requestError(
          'COMMERCE_ACTIVE_SHADOW_REQUIRED',
          'Return Operations to Shadow before preparing Active provider writes',
          409,
        )
      }
      const prepared = await prepareCommerceActiveTransitionInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        expectedActivationState: 'shadow',
        expectedActivationRevision: integerValue(
          body.expectedActivationRevision,
          'Expected activation revision',
          1,
          2_147_483_647,
        ),
        selectedAccounts: commerceActiveSelectedAccountsValue(
          body.selectedAccounts,
        ),
        idempotencyKey: idempotencyKeyValue(req),
      })
      const result = {
        ...prepared,
        accounts: prepared.accounts.map((account) => ({
          accountGlobalId: account.accountGlobalId,
          provider: account.provider,
          environment: account.environment,
          externalAccountId: account.externalAccountId,
          credentialGeneration: account.credentialGeneration,
          authMode: account.authMode,
          priorAccountStatus: account.priorAccountStatus,
          targetAccountStatus: account.targetAccountStatus,
          grantedScopes: account.grantedScopes,
          grantedScopeDigest: account.grantedScopeDigest,
          writeCapabilities: account.writeCapabilities,
          capabilityDigest: account.capabilityDigest,
        })),
      }
      return json(
        { ok: true, capabilities, result },
        prepared.replayed ? 200 : 201,
      )
    }
    if (action === 'activate-commerce-with-authorization') {
      if (!capabilities.canActivate) {
        return json({
          ok: false,
          error: 'Only an organization owner or authorized administrator may activate Operations provider writes',
          code: 'OPERATIONS_ACTIVATION_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'preparationGlobalId',
          'expectedCohortHash',
          'confirmActiveProviderWrites',
          'reason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      if (body.confirmActiveProviderWrites !== true) {
        requestError(
          'COMMERCE_ACTIVE_CONFIRMATION_REQUIRED',
          'Confirm the exact reviewed commerce accounts and provider-write capabilities before activating',
        )
      }
      const preparationGlobalId = globalIdValue(
        body.preparationGlobalId,
        'Commerce Active preparation',
        COMMERCE_ACTIVE_PREPARATION_GLOBAL_ID,
      )
      const expectedCohortHash = sha256Value(
        body.expectedCohortHash,
        'Expected commerce cohort hash',
      )
      const idempotencyKey = idempotencyKeyValue(req)
      const authorization =
        await authorizeCommerceActiveTransitionInPostgres({
          organizationId: activeOperationsOrganizationId(actor),
          actorEmail: actor.email,
          preparationGlobalId,
          expectedCohortHash,
          idempotencyKey,
        })
      const transition =
        await consumeCommerceActiveTransitionAuthorizationInPostgres({
          organizationId: activeOperationsOrganizationId(actor),
          actorEmail: actor.email,
          authorizationGlobalId: authorization.authorizationGlobalId,
          expectedCohortHash,
          idempotencyKey,
          reason: textValue(
            body.reason,
            'Activation reason',
            500,
            false,
          ) || null,
        })
      return json({
        ok: true,
        capabilities,
        result: { authorization, transition },
      })
    }
    if (action === 'update-activation') {
      if (!capabilities.canActivate) {
        return json({
          ok: false,
          error: 'Only an organization owner or authorized administrator may change Operations activation',
          code: 'OPERATIONS_ACTIVATION_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'state',
          'reason',
          'expectedCurrentState',
          'expectedCurrentRevision',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Operations command',
      )
      const state = textValue(body.state, 'Activation state', 20) as OperationsActivationState
      if (!ACTIVATION_STATES.has(state)) {
        requestError('OPERATIONS_ACTIVATION_STATE_INVALID', 'Operations activation state is invalid')
      }
      if (state === 'active') {
        requestError(
          'COMMERCE_ACTIVE_AUTHORIZATION_REQUIRED',
          'Prepare and explicitly authorize the exact commerce provider-write cohort before activating Operations',
          409,
        )
      }
      const expectedCurrentState = textValue(
        body.expectedCurrentState,
        'Expected current activation state',
        20,
      ) as OperationsActivationState
      if (!ACTIVATION_STATES.has(expectedCurrentState)) {
        requestError(
          'OPERATIONS_ACTIVATION_STATE_INVALID',
          'Expected current activation state is invalid',
        )
      }
      const result = await updateOperationsActivationInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        state,
        reason: textValue(body.reason, 'Activation reason', 500, false) || null,
        expectedCurrentState,
        expectedCurrentRevision: integerValue(
          body.expectedCurrentRevision,
          'Expected current activation revision',
          1,
          2_147_483_647,
        ),
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'update-commerce-store-sync') {
      if (!capabilities.canActivate) {
        return json({
          ok: false,
          error: 'Only an organization owner or authorized administrator may change Store sync',
          code: 'COMMERCE_STORE_SYNC_MANAGE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'accountGlobalId',
          'desiredState',
          'expectedDesiredState',
          'expectedRevision',
          'reason',
        ]),
        'OPERATIONS_REQUEST_INVALID',
        'Store sync command',
      )
      const desiredState = textValue(
        body.desiredState,
        'Store sync state',
        20,
      )
      const expectedDesiredState = textValue(
        body.expectedDesiredState,
        'Expected Store sync state',
        20,
      )
      if (!['running', 'paused'].includes(desiredState)
          || !['running', 'paused'].includes(expectedDesiredState)) {
        requestError(
          'COMMERCE_STORE_SYNC_STATE_INVALID',
          'Store sync state is invalid',
        )
      }
      const result = await updateCommerceStoreSyncControlInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        accountGlobalId: globalIdValue(
          body.accountGlobalId,
          'Commerce connection',
          INTEGRATION_ACCOUNT_GLOBAL_ID,
        ),
        desiredState: desiredState as 'running' | 'paused',
        expectedDesiredState: expectedDesiredState as 'running' | 'paused',
        expectedRevision: integerValue(
          body.expectedRevision,
          'Expected Store sync revision',
          1,
          2_147_483_647,
        ),
        reason: textValue(body.reason, 'Store sync reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result })
    }
    requestError('OPERATIONS_ACTION_INVALID', 'Operations action is invalid')
  } catch (error) {
    return errorResponse(error)
  }
}
