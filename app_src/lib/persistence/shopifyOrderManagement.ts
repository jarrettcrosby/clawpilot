import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

export const SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_TTL_SECONDS = 300 as const
export const SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_SECONDS = 300 as const
export const SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED_CODE =
  'SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED' as const

export type ShopifyOrderManagementShippingAddress = {
  firstName: string | null
  lastName: string | null
  company: string | null
  address1: string | null
  address2: string | null
  city: string | null
  provinceCode: string | null
  countryCode: string | null
  zip: string | null
  phone: string | null
}

export type ShopifyOrderManagementAction =
  | { type: 'add_tag'; tag: string }
  | {
      type: 'cancel_fulfillment'
      fulfillmentGid: string
      expectedFulfillmentUpdatedAt: string
    }
  | {
      type: 'cancel'
      reason?: ShopifyOrderCancellationReason
      staffNote?: string
      refundMethod?: ShopifyOrderCancellationRefundMethod
      restock?: boolean
      notifyCustomer?: boolean
    }
  | {
      type: 'cancel_order_after_fulfillment_reversal'
      predecessorAuthorizationGlobalId: string
      reason?: ShopifyOrderCancellationReason
      staffNote?: string
      refundMethod?: ShopifyOrderCancellationRefundMethod
      restock?: boolean
      notifyCustomer?: boolean
    }
  | {
      type: 'set_line_quantity'
      lineItemGid: string
      quantity: number
      staffNote?: string
    }
  | {
      type: 'save_order'
      email: string | null
      phone: string | null
      poNumber: string | null
      note: string | null
      shippingAddress: ShopifyOrderManagementShippingAddress | null
      tagAdds: string[]
      tagRemoves: string[]
      lineQuantities: Array<{
        lineItemGid: string
        quantity: number
      }>
    }

export type ShopifyOrderManagementStatus =
  | 'prepared'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'reconciled'
  | 'expired'

export type ShopifyOrderCancellationReason =
  | 'CUSTOMER'
  | 'DECLINED'
  | 'FRAUD'
  | 'INVENTORY'
  | 'OTHER'
  | 'STAFF'

export type ShopifyOrderCancellationRefundMethod =
  | 'none'
  | 'original_payment_methods'

export type ShopifyOrderCancellationPaymentEvidenceBindingV1 = Readonly<{
  schema: 'shopify-order-cancel-payment-evidence-v1'
  transactionsCount: number
  authorizationTransactionId: string | null
  authorizationAmount: Readonly<{
    amount: string
    currencyCode: string
  }> | null
}>

export type ShopifyOrderCancellationPaymentEvidenceBindingV2 = Readonly<{
  schema: 'shopify-order-cancel-payment-evidence-v2'
  transactionsCount: number
  transactionsHash: string
  totalReceived: Readonly<{ amount: string; currencyCode: string }>
  totalRefunded: Readonly<{ amount: string; currencyCode: string }>
  totalCapturable: Readonly<{ amount: string; currencyCode: string }>
  refundMethod: ShopifyOrderCancellationRefundMethod
}>

export type ShopifyOrderCancellationPaymentEvidenceBinding =
  | ShopifyOrderCancellationPaymentEvidenceBindingV1
  | ShopifyOrderCancellationPaymentEvidenceBindingV2

export type ShopifyOrderManagementAuthorization = {
  authorizationGlobalId: string
  organizationId: string
  accountGlobalId: string
  provider: 'shopify'
  accountEnvironment: 'sandbox' | 'production'
  externalAccountId: string
  shopDomain: string
  credentialGeneration: number
  legacyActivationState: 'shadow' | 'active' | null
  legacyActivationRevision: number | null
  providerWriteControlRowVersion: number | null
  providerWriteScopeDigest: string | null
  orderGlobalId: string
  externalOrderId: string
  orderNumber: string
  expectedOrderRowVersion: number
  expectedSourceHash: string
  acceptedObservationId: string | null
  acceptedProviderOrderUpdatedAt: string | null
  providerOrderUpdatedAt: string
  providerOrderObservedAt: string
  providerOrderTest: boolean
  providerSnapshotHash: string
  action: ShopifyOrderManagementAction['type']
  fulfillmentGid: string | null
  expectedFulfillmentUpdatedAt: string | null
  predecessorAuthorizationGlobalId: string | null
  predecessorFulfillmentGid: string | null
  lineItemGid: string | null
  expectedLineQuantity: number | null
  requestedQuantity: number | null
  tagHash: string | null
  cancelReason: ShopifyOrderCancellationReason | null
  cancelRefundMethod: ShopifyOrderCancellationRefundMethod | null
  cancelRestock: boolean | null
  cancelNotifyCustomer: boolean | null
  cancellationPaymentEvidence:
    ShopifyOrderCancellationPaymentEvidenceBinding | null
  staffNoteHash: string | null
  requestedProjectionHash: string | null
  requiresOrderEdits: boolean
  authorizationReason: string
  intentHash: string
  idempotencyKey: string
  requestHash: string
  status: ShopifyOrderManagementStatus
  storedStatus: ShopifyOrderManagementStatus
  authorizedBy: string
  authorizedRole: 'owner' | 'admin' | 'member'
  providerAttemptGlobalId: string | null
  processingLeaseExpiresAt: string | null
  latestOutcomeGlobalId: string | null
  latestOutcomeState:
    | 'succeeded'
    | 'failed'
    | 'unknown'
    | 'reconciled'
    | null
  reconciliationResolution: 'applied' | 'not_applied' | null
  providerWriteCount: number | null
  providerReference: string | null
  errorCode: string | null
  preparedAt: string
  expiresAt: string
  processingAt: string | null
  completedAt: string | null
  replayed: boolean
}

export type ClaimedShopifyOrderManagementAction =
  ShopifyOrderManagementAuthorization & {
    status: 'processing'
    storedStatus: 'processing'
    providerAttemptGlobalId: string
    processingLeaseExpiresAt: string
    attemptHash: string
    claimedAt: string
    actionInput: ShopifyOrderManagementAction
  }

export type ShopifyOrderManagementTarget = {
  organizationId: string
  accountGlobalId: string
  accountDisplayName: string
  accountEnvironment: string
  externalAccountId: string | null
  shopDomain: string | null
  credentialGeneration: number
  credentialCurrent: boolean
  providerWriteControlRowVersion: number
  providerWriteRequestedMode: 'off' | 'on'
  providerWriteBindingCurrent: boolean
  providerWriteScopeDigest: string | null
  orderGlobalId: string
  externalOrderId: string
  orderNumber: string
  orderRowVersion: number
  orderStatus: string
  sourceHash: string | null
  acceptedSourceHash: string
  acceptedProviderUpdatedAt: string | null
  latestSourceHash: string | null
  materialState: string
  latestObservedAt: string | null
  latestProviderUpdatedAt: string | null
  latestProviderOrderTest: boolean | null
  zeroDownstream: boolean
  reversibleExternalFulfillmentGid: string | null
  reversibleExternalFulfillmentUpdatedAt: string | null
  fulfillmentReversalSafe: boolean
  postReversalOrderCancellationSafe: boolean
  postReversalOrderCancellationPredecessorGlobalId: string | null
  latestOpenAuthorization: ShopifyOrderManagementAuthorization | null
}

export type PrepareShopifyOrderManagementInput = {
  organizationId: unknown
  actorEmail: unknown
  accountGlobalId: unknown
  orderGlobalId: unknown
  expectedOrderRowVersion: unknown
  expectedSourceHash: unknown
  providerOrderUpdatedAt: unknown
  providerOrderObservedAt: unknown
  providerOrderTest: unknown
  action: unknown
  cancellationPaymentEvidence?: unknown
  expectedLineQuantity?: unknown
  requestedProjectionHash?: unknown
  reason: unknown
  idempotencyKey: unknown
}

export type ClaimShopifyOrderManagementInput = {
  organizationId: unknown
  actorEmail: unknown
  authorizationGlobalId: unknown
  action: unknown
  expectedLineQuantity?: unknown
  reason: unknown
}

export type RecordShopifyOrderManagementOutcomeInput = {
  organizationId: unknown
  actorEmail: unknown
  authorizationGlobalId: unknown
  providerAttemptGlobalId: unknown
  outcome: 'succeeded' | 'failed' | 'unknown'
  evidence: unknown
  providerReference?: unknown
  errorCode?: unknown
  providerWriteCount: unknown
}

export type ReconcileShopifyOrderManagementOutcomeInput = {
  organizationId: unknown
  actorEmail: unknown
  authorizationGlobalId: unknown
  providerAttemptGlobalId: unknown
  resolution: 'applied' | 'not_applied'
  evidence: unknown
  providerReference?: unknown
  providerWriteCount: unknown
}

export type RecoverStaleShopifyOrderManagementAttemptInput = {
  organizationId: unknown
  actorEmail: unknown
  authorizationGlobalId: unknown
  providerAttemptGlobalId: unknown
}

export type RecoverStaleShopifyOrderManagementAttemptResult = Readonly<{
  authorization: ShopifyOrderManagementAuthorization
  recovered: boolean
}>

export type ShopifyOrderManagementHealth = Readonly<{
  prepared: number
  processing: number
  staleProcessing: number
  unknown: number
  latestUnknownAt: string | null
  lastCompletedAt: string | null
  knownProviderWriteOutcomeCount: number
  knownProviderWriteSum: number
}>

type TimestampValue = string | Date

type AuthorizationRow = {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  integration_account_global_id: string
  provider: 'shopify'
  account_environment: 'sandbox' | 'production'
  external_account_id: string
  shop_domain: string
  credential_generation: number
  activation_state: 'shadow' | 'active' | null
  activation_revision: number | null
  provider_write_control_row_version: number | string | null
  provider_write_scope_digest: string | null
  order_id: string
  order_global_id: string
  external_order_id: string
  order_number: string
  expected_order_row_version: string | number
  expected_source_hash: string
  accepted_observation_id: string | null
  accepted_provider_order_updated_at: TimestampValue | null
  provider_order_updated_at: TimestampValue
  provider_order_observed_at: TimestampValue
  provider_order_test: boolean
  provider_snapshot_hash: string
  action: ShopifyOrderManagementAction['type']
  fulfillment_gid: string | null
  expected_fulfillment_updated_at: TimestampValue | null
  predecessor_authorization_id: string | null
  predecessor_authorization_global_id?: string | null
  predecessor_fulfillment_gid?: string | null
  line_item_id: string | null
  expected_line_quantity: number | null
  requested_quantity: number | null
  tag_hash: string | null
  cancel_reason: ShopifyOrderCancellationReason | null
  cancel_refund_method: ShopifyOrderCancellationRefundMethod | null
  cancel_restock: boolean | null
  cancel_notify_customer: boolean | null
  cancellation_payment_evidence: unknown | null
  staff_note_hash: string | null
  requested_projection_hash: string | null
  requires_order_edits: boolean
  authorization_reason: string
  intent_hash: string
  idempotency_key: string
  request_hash: string
  status: ShopifyOrderManagementStatus
  effective_status?: ShopifyOrderManagementStatus
  authorized_by: string
  authorized_role: 'owner' | 'admin' | 'member'
  provider_attempt_id: string | null
  provider_attempt_global_id?: string | null
  provider_attempt_hash?: string | null
  processing_lease_expires_at?: TimestampValue | null
  processing_lease_expired?: boolean | null
  latest_outcome_id: string | null
  latest_outcome_global_id?: string | null
  latest_outcome_state?:
    | 'succeeded'
    | 'failed'
    | 'unknown'
    | 'reconciled'
    | null
  reconciliation_resolution?: 'applied' | 'not_applied' | null
  provider_write_count?: number | null
  provider_reference?: string | null
  error_code?: string | null
  prepared_at: TimestampValue
  expires_at: TimestampValue
  processing_at: TimestampValue | null
  completed_at: TimestampValue | null
}

type BindingRow = {
  integration_account_id: string
  integration_account_global_id: string
  account_environment: 'sandbox' | 'production'
  external_account_id: string
  shop_domain: string
  credential_generation: number
  credential_external_account_id: string
  credential_version: number
  auth_mode: string
  verification_status: string
  credential_last_error_code: string | null
  provider_write_control_row_version: number | string
  provider_write_requested_mode: 'off' | 'on'
  provider_write_binding_current: boolean
  provider_write_scope_digest: string | null
  provider_write_bound_scopes: string[] | null
  order_id: string
  order_global_id: string
  external_order_id: string
  order_number: string
  order_row_version: string | number
  order_status: string
  archived_at: TimestampValue | null
  source_hash: string | null
  accepted_source_hash: string
  accepted_observation_id: string | null
  accepted_provider_order_updated_at: TimestampValue | null
  latest_source_hash: string | null
  material_state: string
  zero_downstream: boolean
  fulfillment_reversal_safe: boolean
  post_reversal_order_cancellation_safe: boolean
  predecessor_authorization_id: string | null
  predecessor_authorization_global_id: string | null
  predecessor_fulfillment_gid: string | null
}

export class ShopifyOrderManagementPersistenceError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'ShopifyOrderManagementPersistenceError'
    this.code = code
    this.status = status
  }
}

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const AUTHORIZATION_GLOBAL_ID = /^gsom(?:[0-9]{7}|[0-9a-v]{12})$/
const ATTEMPT_GLOBAL_ID = /^gsoa(?:[0-9]{7}|[0-9a-v]{12})$/
const SHOPIFY_LINE_ITEM_GID = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]{0,20}$/
const SHOPIFY_FULFILLMENT_GID =
  /^gid:\/\/shopify\/Fulfillment\/[1-9][0-9]{0,20}$/
const SHOPIFY_ORDER_TRANSACTION_GID =
  /^gid:\/\/shopify\/OrderTransaction\/[A-Za-z0-9][A-Za-z0-9-]*$/
const SHA256 = /^[a-f0-9]{64}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,127}$/
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/
const COUNTRY_CODE = /^[A-Z]{2}$/
const CURRENCY_CODE = /^(?:[A-Z]{3}|USDC)$/
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
const SHIPPING_ADDRESS_FIELDS = [
  'firstName',
  'lastName',
  'company',
  'address1',
  'address2',
  'city',
  'provinceCode',
  'countryCode',
  'zip',
  'phone',
] as const

function fail(code: string, message: string, status = 409): never {
  throw new ShopifyOrderManagementPersistenceError(code, message, status)
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_EVIDENCE_INVALID',
        'Shopify order management evidence contains a non-finite number',
        400,
      )
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== 'object' || value === undefined) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_EVIDENCE_INVALID',
      'Shopify order management evidence must be valid JSON',
      400,
    )
  }
  if (ancestors.has(value)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_EVIDENCE_INVALID',
      'Shopify order management evidence cannot be recursive',
      400,
    )
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (
      prototype !== Object.prototype
      && prototype !== null
      && Object.prototype.toString.call(value) !== '[object Object]'
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_EVIDENCE_INVALID',
        'Shopify order management evidence must contain plain JSON objects',
        400,
      )
    }
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key], ancestors)}`
    )).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function shopifyOrderManagementEvidenceHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function organizationId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID.test(normalized)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ORGANIZATION_REQUIRED',
      'A valid workspace organization is required',
      400,
    )
  }
  return normalized
}

function globalId(
  value: unknown,
  pattern: RegExp,
  code: string,
  message: string,
) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!pattern.test(normalized)) fail(code, message, 400)
  return normalized
}

function actorEmail(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (
    normalized.length < 3
    || normalized.length > 320
    || !SAFE_TEXT.test(normalized)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTOR_REQUIRED',
      'A signed-in owner or operations administrator is required',
      401,
    )
  }
  return normalized
}

function integer(value: unknown, label: string, minimum = 0) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function canonicalPositiveDecimal(value: unknown): string | null {
  if (typeof value !== 'string' || !NONNEGATIVE_DECIMAL.test(value)) {
    return null
  }
  const [whole, fraction = ''] = value.split('.')
  const normalizedFraction = fraction.replace(/0+$/u, '')
  const normalized = normalizedFraction
    ? `${whole}.${normalizedFraction}`
    : whole
  return normalized === '0' ? null : normalized
}

function canonicalNonnegativeDecimal(value: unknown): string | null {
  if (typeof value !== 'string' || !NONNEGATIVE_DECIMAL.test(value)) {
    return null
  }
  const [whole, fraction = ''] = value.split('.')
  const normalizedFraction = fraction.replace(/0+$/u, '')
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole
}

function cancellationMoneyEvidence(
  value: unknown,
): Readonly<{ amount: string; currencyCode: string }> | null {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return null
  const source = value as Record<string, unknown>
  if (Object.keys(source).sort().join(',') !== 'amount,currencyCode') return null
  const amount = canonicalNonnegativeDecimal(source.amount)
  if (
    amount === null
    || typeof source.currencyCode !== 'string'
    || !CURRENCY_CODE.test(source.currencyCode)
  ) return null
  return Object.freeze({ amount, currencyCode: source.currencyCode })
}

function normalizeCancellationPaymentEvidence(
  value: unknown,
  required: boolean,
): ShopifyOrderCancellationPaymentEvidenceBinding | null {
  if (!required) {
    if (value === undefined || value === null) return null
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_SNAPSHOT_INVALID',
      'Cancellation payment evidence applies only to cancellation actions',
      400,
    )
  }
  if (value === undefined || value === null) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_SNAPSHOT_INVALID',
      'Exact cancellation payment evidence is required',
      400,
    )
  }
  if (
    typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_SNAPSHOT_INVALID',
      'Cancellation payment evidence is invalid',
      400,
    )
  }
  const source = value as Record<string, unknown>
  if (source.schema === 'shopify-order-cancel-payment-evidence-v2') {
    const expectedKeys = [
      'refundMethod',
      'schema',
      'totalCapturable',
      'totalReceived',
      'totalRefunded',
      'transactionsCount',
      'transactionsHash',
    ]
    const totalReceived = cancellationMoneyEvidence(source.totalReceived)
    const totalRefunded = cancellationMoneyEvidence(source.totalRefunded)
    const totalCapturable = cancellationMoneyEvidence(source.totalCapturable)
    if (
      Object.keys(source).sort().join(',') !== expectedKeys.join(',')
      || !Number.isSafeInteger(source.transactionsCount)
      || Number(source.transactionsCount) < 0
      || Number(source.transactionsCount) > 25
      || typeof source.transactionsHash !== 'string'
      || !SHA256.test(source.transactionsHash)
      || (source.refundMethod !== 'none'
        && source.refundMethod !== 'original_payment_methods')
      || !totalReceived
      || !totalRefunded
      || !totalCapturable
      || totalRefunded.currencyCode !== totalReceived.currencyCode
      || totalCapturable.currencyCode !== totalReceived.currencyCode
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_SNAPSHOT_INVALID',
        'Cancellation payment evidence is invalid',
        400,
      )
    }
    return Object.freeze({
      schema: 'shopify-order-cancel-payment-evidence-v2' as const,
      transactionsCount: Number(source.transactionsCount),
      transactionsHash: source.transactionsHash,
      totalReceived,
      totalRefunded,
      totalCapturable,
      refundMethod: source.refundMethod,
    })
  }
  const expectedKeys = [
    'authorizationAmount',
    'authorizationTransactionId',
    'schema',
    'transactionsCount',
  ]
  if (
    Object.keys(source).sort().join(',') !== expectedKeys.join(',')
    || source.schema !== 'shopify-order-cancel-payment-evidence-v1'
    || !Number.isSafeInteger(source.transactionsCount)
    || Number(source.transactionsCount) < 0
    || Number(source.transactionsCount) > 25
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_SNAPSHOT_INVALID',
      'Cancellation payment evidence is invalid',
      400,
    )
  }
  const transactionsCount = Number(source.transactionsCount)
  const authorizationTransactionId = source.authorizationTransactionId
  const amountSource = source.authorizationAmount
  if (authorizationTransactionId === null && amountSource === null) {
    return Object.freeze({
      schema: 'shopify-order-cancel-payment-evidence-v1' as const,
      transactionsCount,
      authorizationTransactionId: null,
      authorizationAmount: null,
    })
  }
  if (
    typeof authorizationTransactionId !== 'string'
    || !SHOPIFY_ORDER_TRANSACTION_GID.test(authorizationTransactionId)
    || typeof amountSource !== 'object'
    || amountSource === null
    || Array.isArray(amountSource)
    || Object.getPrototypeOf(amountSource) !== Object.prototype
    || Object.keys(amountSource).sort().join(',') !== 'amount,currencyCode'
    || transactionsCount < 1
    || transactionsCount >= 25
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_SNAPSHOT_INVALID',
      'Cancellation authorization evidence is invalid',
      400,
    )
  }
  const rawAmount = amountSource as Record<string, unknown>
  const amount = canonicalPositiveDecimal(rawAmount.amount)
  if (
    !amount
    || typeof rawAmount.currencyCode !== 'string'
    || !CURRENCY_CODE.test(rawAmount.currencyCode)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_SNAPSHOT_INVALID',
      'Cancellation authorization amount evidence is invalid',
      400,
    )
  }
  return Object.freeze({
    schema: 'shopify-order-cancel-payment-evidence-v1' as const,
    transactionsCount,
    authorizationTransactionId,
    authorizationAmount: Object.freeze({
      amount,
      currencyCode: rawAmount.currencyCode,
    }),
  })
}

function sourceHash(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!SHA256.test(normalized)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_SOURCE_HASH_REQUIRED',
      'A valid current order source hash is required',
      400,
    )
  }
  return normalized
}

function idempotencyKey(value: unknown) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < 8
    || normalized.length > 200
    || !SAFE_TEXT.test(normalized)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_IDEMPOTENCY_REQUIRED',
      'A stable idempotency key of 8-200 characters is required',
      400,
    )
  }
  return normalized
}

function authorizationReason(value: unknown) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < 10
    || normalized.length > 500
    || !SAFE_TEXT.test(normalized)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_REASON_REQUIRED',
      'An operator reason of 10-500 characters is required',
      400,
    )
  }
  return normalized
}

function timestamp(value: unknown, label: string) {
  const normalized = new Date(String(value || ''))
  if (!Number.isFinite(normalized.getTime())) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_SNAPSHOT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized.toISOString()
}

function optionalText(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const normalized = String(value).trim()
  if (
    normalized.length < 1
    || normalized.length > maximum
    || !SAFE_TEXT.test(normalized)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function nullableActionText(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  const normalized = value.trim()
  if (
    normalized !== value
    || normalized.length > maximum
    || (!allowEmpty && normalized.length < 1)
    || (normalized.length > 0 && !SAFE_TEXT.test(normalized))
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function normalizedTags(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 250) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      `${label} are invalid`,
      400,
    )
  }
  const tags = value.map((entry) => {
    const tag = nullableActionText(entry, label, 255)
    if (!tag || tag.includes(',')) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        `${label} are invalid`,
        400,
      )
    }
    return tag
  }).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (new Set(tags).size !== tags.length) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      `${label} contain duplicates`,
      400,
    )
  }
  return tags
}

function normalizedShippingAddress(
  value: unknown,
): ShopifyOrderManagementShippingAddress | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      'Shopify shipping address is invalid',
      400,
    )
  }
  const address = value as Record<string, unknown>
  if (Object.keys(address).some((key) => (
    !(SHIPPING_ADDRESS_FIELDS as readonly string[]).includes(key)
  ))) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      'Shopify shipping address is invalid',
      400,
    )
  }
  const countryCode = nullableActionText(
    address.countryCode,
    'Shopify shipping-address country code',
    2,
  )
  if (countryCode !== null && !COUNTRY_CODE.test(countryCode)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      'Shopify shipping-address country code is invalid',
      400,
    )
  }
  return {
    firstName: nullableActionText(
      address.firstName,
      'Shopify shipping-address first name',
      255,
    ),
    lastName: nullableActionText(
      address.lastName,
      'Shopify shipping-address last name',
      255,
    ),
    company: nullableActionText(
      address.company,
      'Shopify shipping-address company',
      255,
    ),
    address1: nullableActionText(
      address.address1,
      'Shopify shipping-address line 1',
      255,
    ),
    address2: nullableActionText(
      address.address2,
      'Shopify shipping-address line 2',
      255,
    ),
    city: nullableActionText(
      address.city,
      'Shopify shipping-address city',
      255,
    ),
    provinceCode: nullableActionText(
      address.provinceCode,
      'Shopify shipping-address province or state code',
      64,
    ),
    countryCode,
    zip: nullableActionText(
      address.zip,
      'Shopify shipping-address postal code',
      64,
    ),
    phone: nullableActionText(
      address.phone,
      'Shopify shipping-address phone',
      64,
    ),
  }
}

export function normalizeShopifyOrderManagementAction(
  value: unknown,
): ShopifyOrderManagementAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      'A supported Shopify order action is required',
      400,
    )
  }
  const input = value as Record<string, unknown>
  if (input.type === 'add_tag') {
    const tag = optionalText(input.tag, 'Shopify order tag', 255)
    if (!tag) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        'A non-empty Shopify order tag is required',
        400,
      )
    }
    return { type: 'add_tag', tag }
  }
  if (input.type === 'cancel_fulfillment') {
    const fulfillmentGid = String(input.fulfillmentGid || '').trim()
    if (!SHOPIFY_FULFILLMENT_GID.test(fulfillmentGid)) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        'A valid Shopify Fulfillment GID is required',
        400,
      )
    }
    return {
      type: 'cancel_fulfillment',
      fulfillmentGid,
      expectedFulfillmentUpdatedAt: timestamp(
        input.expectedFulfillmentUpdatedAt,
        'Expected Shopify fulfillment updated time',
      ),
    }
  }
  if (input.type === 'cancel') {
    const reason = input.reason === undefined ? 'STAFF' : input.reason
    if (![
      'CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF',
    ].includes(String(reason))) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        'Cancellation reason is invalid',
        400,
      )
    }
    const staffNote = optionalText(
      input.staffNote,
      'Cancellation staff note',
      255,
    )
    const refundMethod = input.refundMethod === undefined
      ? 'none' : input.refundMethod
    if (refundMethod !== 'none' && refundMethod !== 'original_payment_methods') {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        'Cancellation refund choice is invalid',
        400,
      )
    }
    const restock = input.restock === undefined ? false : input.restock
    const notifyCustomer = input.notifyCustomer === undefined
      ? false : input.notifyCustomer
    if (typeof restock !== 'boolean' || typeof notifyCustomer !== 'boolean') {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        'Cancellation options are invalid',
        400,
      )
    }
    return {
      type: 'cancel',
      reason: reason as ShopifyOrderCancellationReason,
      ...(staffNote ? { staffNote } : {}),
      refundMethod,
      restock,
      notifyCustomer,
    }
  }
  if (input.type === 'cancel_order_after_fulfillment_reversal') {
    const predecessorAuthorizationGlobalId = globalId(
      input.predecessorAuthorizationGlobalId,
      AUTHORIZATION_GLOBAL_ID,
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      'A valid fulfillment-reversal authorization is required',
    )
    const reason = input.reason === undefined ? 'STAFF' : input.reason
    if (![
      'CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF',
    ].includes(String(reason))) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        'Cancellation reason is invalid',
        400,
      )
    }
    const staffNote = optionalText(
      input.staffNote,
      'Cancellation staff note',
      255,
    )
    return {
      type: 'cancel_order_after_fulfillment_reversal',
      predecessorAuthorizationGlobalId,
      reason: reason as ShopifyOrderCancellationReason,
      ...(staffNote ? { staffNote } : {}),
      refundMethod: 'none',
      restock: false,
      notifyCustomer: false,
    }
  }
  if (input.type === 'set_line_quantity') {
    const lineItemGid = String(input.lineItemGid || '').trim()
    if (!SHOPIFY_LINE_ITEM_GID.test(lineItemGid)) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        'A valid Shopify LineItem GID is required',
        400,
      )
    }
    const staffNote = optionalText(
      input.staffNote,
      'Order edit staff note',
      255,
    )
    return {
      type: 'set_line_quantity',
      lineItemGid,
      quantity: integer(input.quantity, 'Shopify line quantity'),
      ...(staffNote ? { staffNote } : {}),
    }
  }
  if (input.type === 'save_order') {
    const tagAdds = normalizedTags(input.tagAdds, 'Shopify tags to add')
    const tagRemoves = normalizedTags(
      input.tagRemoves,
      'Shopify tags to remove',
    )
    if (tagAdds.some((tag) => tagRemoves.includes(tag))) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        'Shopify tag changes are contradictory',
        400,
      )
    }
    if (!Array.isArray(input.lineQuantities) || input.lineQuantities.length > 250) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        'Shopify order line changes are invalid',
        400,
      )
    }
    const lineQuantities = input.lineQuantities.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(
          'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
          'Shopify order line changes are invalid',
          400,
        )
      }
      const line = value as Record<string, unknown>
      const lineItemGid = String(line.lineItemGid || '').trim()
      if (!SHOPIFY_LINE_ITEM_GID.test(lineItemGid)) {
        fail(
          'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
          'A valid Shopify LineItem GID is required',
          400,
        )
      }
      return {
        lineItemGid,
        quantity: integer(line.quantity, 'Shopify line quantity'),
      }
    }).sort((left, right) => (
      left.lineItemGid < right.lineItemGid
        ? -1
        : left.lineItemGid > right.lineItemGid ? 1 : 0
    ))
    if (new Set(lineQuantities.map((line) => line.lineItemGid)).size
      !== lineQuantities.length) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        'Shopify order line changes contain duplicates',
        400,
      )
    }
    return {
      type: 'save_order',
      email: nullableActionText(input.email, 'Shopify order email', 254),
      phone: nullableActionText(input.phone, 'Shopify order phone', 64),
      poNumber: nullableActionText(
        input.poNumber,
        'Shopify order PO number',
        255,
      ),
      note: nullableActionText(
        input.note,
        'Shopify order note',
        5_000,
        true,
      ),
      shippingAddress: normalizedShippingAddress(input.shippingAddress),
      tagAdds,
      tagRemoves,
      lineQuantities,
    }
  }
  fail(
    'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
    'Supported actions are add_tag, cancel_fulfillment, cancel, cancel_order_after_fulfillment_reversal, set_line_quantity, and save_order',
    400,
  )
}

function actionEvidence(action: ShopifyOrderManagementAction) {
  if (action.type === 'add_tag') {
    return {
      action: action.type,
      fulfillmentGid: null,
      expectedFulfillmentUpdatedAt: null,
      predecessorAuthorizationGlobalId: null,
      lineItemGid: null,
      requestedQuantity: null,
      tagHash: shopifyOrderManagementEvidenceHash({
        schema: 'shopify-order-management-tag-v1',
        tag: action.tag,
      }),
      cancelReason: null,
      staffNoteHash: null,
      cancelRefundMethod: null,
      cancelRestock: null,
      cancelNotifyCustomer: null,
    }
  }
  if (action.type === 'cancel_fulfillment') {
    return {
      action: action.type,
      fulfillmentGid: action.fulfillmentGid,
      expectedFulfillmentUpdatedAt: action.expectedFulfillmentUpdatedAt,
      predecessorAuthorizationGlobalId: null,
      lineItemGid: null,
      requestedQuantity: null,
      tagHash: null,
      cancelReason: null,
      staffNoteHash: null,
      cancelRefundMethod: null,
      cancelRestock: null,
      cancelNotifyCustomer: null,
    }
  }
  if (
    action.type === 'cancel'
    || action.type === 'cancel_order_after_fulfillment_reversal'
  ) {
    return {
      action: action.type,
      fulfillmentGid: null,
      expectedFulfillmentUpdatedAt: null,
      predecessorAuthorizationGlobalId:
        action.type === 'cancel_order_after_fulfillment_reversal'
          ? action.predecessorAuthorizationGlobalId
          : null,
      lineItemGid: null,
      requestedQuantity: null,
      tagHash: null,
      cancelReason: action.reason || 'STAFF',
      cancelRefundMethod: action.refundMethod || 'none',
      cancelRestock: action.restock ?? false,
      cancelNotifyCustomer: action.notifyCustomer ?? false,
      staffNoteHash: action.staffNote
        ? shopifyOrderManagementEvidenceHash({
            schema: 'shopify-order-management-staff-note-v1',
            staffNote: action.staffNote,
          })
        : null,
    }
  }
  if (action.type === 'save_order') {
    return {
      action: action.type,
      fulfillmentGid: null,
      expectedFulfillmentUpdatedAt: null,
      predecessorAuthorizationGlobalId: null,
      lineItemGid: null,
      requestedQuantity: null,
      tagHash: null,
      cancelReason: null,
      staffNoteHash: null,
      cancelRefundMethod: null,
      cancelRestock: null,
      cancelNotifyCustomer: null,
    }
  }
  return {
    action: action.type,
    fulfillmentGid: null,
    expectedFulfillmentUpdatedAt: null,
    predecessorAuthorizationGlobalId: null,
    lineItemGid: action.lineItemGid,
    requestedQuantity: action.quantity,
    tagHash: null,
    cancelReason: null,
    cancelRefundMethod: null,
    cancelRestock: null,
    cancelNotifyCustomer: null,
    staffNoteHash: action.staffNote
      ? shopifyOrderManagementEvidenceHash({
          schema: 'shopify-order-management-staff-note-v1',
          staffNote: action.staffNote,
        })
      : null,
  }
}

type ShopifyOrderManagementProviderSnapshotInput = Readonly<{
  orderGlobalId: string
  expectedSourceHash: string
  providerOrderUpdatedAt: string
  providerOrderObservedAt: string
  providerOrderTest: boolean
  action: ShopifyOrderManagementAction['type']
  fulfillmentGid: string | null
  expectedFulfillmentUpdatedAt: string | null
  predecessorAuthorizationGlobalId: string | null
  expectedLineQuantity: number | null
  requestedProjectionHash: string | null
  requiresOrderEdits: boolean
  cancellationPaymentEvidence:
    ShopifyOrderCancellationPaymentEvidenceBinding | null
  cancelRefundMethod: ShopifyOrderCancellationRefundMethod | null
  cancelRestock: boolean | null
  cancelNotifyCustomer: boolean | null
}>

function providerSnapshotHash(
  input: ShopifyOrderManagementProviderSnapshotInput,
) {
  const cancellation = input.action === 'cancel'
    || input.action === 'cancel_order_after_fulfillment_reversal'
  return shopifyOrderManagementEvidenceHash({
    schema: cancellation
      ? 'shopify-order-management-provider-snapshot-v3'
      : 'shopify-order-management-provider-snapshot-v1',
    orderGlobalId: input.orderGlobalId,
    expectedSourceHash: input.expectedSourceHash,
    providerOrderUpdatedAt: input.providerOrderUpdatedAt,
    providerOrderObservedAt: input.providerOrderObservedAt,
    providerOrderTest: input.providerOrderTest,
    ...(input.action === 'cancel_fulfillment'
      ? {
          fulfillmentGid: input.fulfillmentGid,
          expectedFulfillmentUpdatedAt:
            input.expectedFulfillmentUpdatedAt,
        }
      : {}),
    ...(input.action === 'cancel_order_after_fulfillment_reversal'
      ? {
          predecessorAuthorizationGlobalId:
            input.predecessorAuthorizationGlobalId,
        }
      : {}),
    ...(cancellation
      ? {
          cancellationPaymentEvidence: input.cancellationPaymentEvidence,
          cancelRefundMethod: input.cancelRefundMethod,
          cancelRestock: input.cancelRestock,
          cancelNotifyCustomer: input.cancelNotifyCustomer,
        }
      : {}),
    expectedLineQuantity: input.expectedLineQuantity,
    requestedProjectionHash: input.requestedProjectionHash,
    requiresOrderEdits: input.requiresOrderEdits,
  })
}

function legacyCancellationProviderSnapshotHash(
  input: ShopifyOrderManagementProviderSnapshotInput,
) {
  return shopifyOrderManagementEvidenceHash({
    schema: 'shopify-order-management-provider-snapshot-v2',
    orderGlobalId: input.orderGlobalId,
    expectedSourceHash: input.expectedSourceHash,
    providerOrderUpdatedAt: input.providerOrderUpdatedAt,
    providerOrderObservedAt: input.providerOrderObservedAt,
    providerOrderTest: input.providerOrderTest,
    ...(input.action === 'cancel_order_after_fulfillment_reversal'
      ? {
          predecessorAuthorizationGlobalId:
            input.predecessorAuthorizationGlobalId,
        }
      : {}),
    cancellationPaymentEvidence: input.cancellationPaymentEvidence,
    expectedLineQuantity: input.expectedLineQuantity,
    requestedProjectionHash: input.requestedProjectionHash,
    requiresOrderEdits: input.requiresOrderEdits,
  })
}

export function shopifyOrderManagementCancellationPaymentEvidenceMatchesSnapshot(
  authorization: ShopifyOrderManagementAuthorization,
  evidence: unknown,
) {
  if (
    authorization.action !== 'cancel'
    && authorization.action !== 'cancel_order_after_fulfillment_reversal'
  ) {
    return false
  }
  try {
    const cancellationPaymentEvidence =
      normalizeCancellationPaymentEvidence(evidence, true)
    if (!cancellationPaymentEvidence) return false
    const snapshotInput = {
      orderGlobalId: authorization.orderGlobalId,
      expectedSourceHash: authorization.expectedSourceHash,
      providerOrderUpdatedAt: authorization.providerOrderUpdatedAt,
      providerOrderObservedAt: authorization.providerOrderObservedAt,
      providerOrderTest: authorization.providerOrderTest,
      action: authorization.action,
      fulfillmentGid: authorization.fulfillmentGid,
      expectedFulfillmentUpdatedAt:
        authorization.expectedFulfillmentUpdatedAt,
      predecessorAuthorizationGlobalId:
        authorization.predecessorAuthorizationGlobalId,
      expectedLineQuantity: authorization.expectedLineQuantity,
      requestedProjectionHash: authorization.requestedProjectionHash,
      requiresOrderEdits: authorization.requiresOrderEdits,
      cancellationPaymentEvidence,
      cancelRefundMethod: authorization.cancelRefundMethod,
      cancelRestock: authorization.cancelRestock,
      cancelNotifyCustomer: authorization.cancelNotifyCustomer,
    }
    return providerSnapshotHash(snapshotInput) === authorization.providerSnapshotHash
      || (
        authorization.cancellationPaymentEvidence === null
        && legacyCancellationProviderSnapshotHash(snapshotInput)
          === authorization.providerSnapshotHash
      )
  } catch (error) {
    if (error instanceof ShopifyOrderManagementPersistenceError) return false
    throw error
  }
}

function projectionHash(value: unknown, required: boolean) {
  if (!required && (value === undefined || value === null || value === '')) {
    return null
  }
  const normalized = String(value || '').trim().toLowerCase()
  if (!SHA256.test(normalized)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      'A valid requested Shopify order projection hash is required',
      400,
    )
  }
  return normalized
}

function expectedLineQuantity(
  value: unknown,
  action: ShopifyOrderManagementAction,
) {
  if (action.type !== 'set_line_quantity') {
    if (value !== undefined && value !== null) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
        'Expected line quantity applies only to a line quantity action',
        400,
      )
    }
    return null
  }
  const expected = integer(value, 'Expected current Shopify line quantity', 1)
  if (action.quantity >= expected) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      'The first line-edit slice permits only a quantity decrease or removal',
      400,
    )
  }
  return expected
}

function intentHash(
  action: ShopifyOrderManagementAction,
  reason: string,
  expectedLineQuantityValue: number | null,
) {
  return shopifyOrderManagementEvidenceHash({
    schema: 'shopify-order-management-intent-v1',
    action,
    reason,
    expectedLineQuantity: expectedLineQuantityValue,
  })
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function authorization(
  row: AuthorizationRow,
  replayed = false,
): ShopifyOrderManagementAuthorization {
  const expectedOrderRowVersion = Number(row.expected_order_row_version)
  if (!Number.isSafeInteger(expectedOrderRowVersion)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_EVIDENCE_INVALID',
      'Stored Shopify order management row version is invalid',
      500,
    )
  }
  const providerWriteCount = row.provider_write_count === null
    || row.provider_write_count === undefined
    ? null
    : Number(row.provider_write_count)
  const providerWriteControlRowVersion =
    row.provider_write_control_row_version === null
      ? null
      : Number(row.provider_write_control_row_version)
  if ((
    providerWriteControlRowVersion !== null
    && (!Number.isSafeInteger(providerWriteControlRowVersion)
      || providerWriteControlRowVersion < 1
      || !row.provider_write_scope_digest
      || !SHA256.test(row.provider_write_scope_digest))
  ) || (
    providerWriteControlRowVersion === null
    && row.provider_write_scope_digest !== null
  )) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_EVIDENCE_INVALID',
      'Stored Provider writes binding is invalid',
      500,
    )
  }
  return {
    authorizationGlobalId: row.global_id,
    organizationId: row.organization_id,
    accountGlobalId: row.integration_account_global_id,
    provider: 'shopify',
    accountEnvironment: row.account_environment,
    externalAccountId: row.external_account_id,
    shopDomain: row.shop_domain,
    credentialGeneration: Number(row.credential_generation),
    legacyActivationState: row.activation_state,
    legacyActivationRevision: row.activation_revision === null
      ? null
      : Number(row.activation_revision),
    providerWriteControlRowVersion,
    providerWriteScopeDigest: row.provider_write_scope_digest,
    orderGlobalId: row.order_global_id,
    externalOrderId: row.external_order_id,
    orderNumber: row.order_number,
    expectedOrderRowVersion,
    expectedSourceHash: row.expected_source_hash,
    acceptedObservationId: row.accepted_observation_id,
    acceptedProviderOrderUpdatedAt:
      iso(row.accepted_provider_order_updated_at),
    providerOrderUpdatedAt: iso(row.provider_order_updated_at)!,
    providerOrderObservedAt: iso(row.provider_order_observed_at)!,
    providerOrderTest: row.provider_order_test,
    providerSnapshotHash: row.provider_snapshot_hash,
    action: row.action,
    fulfillmentGid: row.fulfillment_gid,
    expectedFulfillmentUpdatedAt:
      iso(row.expected_fulfillment_updated_at),
    predecessorAuthorizationGlobalId:
      row.predecessor_authorization_global_id || null,
    predecessorFulfillmentGid: row.predecessor_fulfillment_gid || null,
    lineItemGid: row.line_item_id,
    expectedLineQuantity: row.expected_line_quantity === null
      ? null : Number(row.expected_line_quantity),
    requestedQuantity: row.requested_quantity === null
      ? null : Number(row.requested_quantity),
    tagHash: row.tag_hash,
    cancelReason: row.cancel_reason,
    cancelRefundMethod: row.cancel_refund_method,
    cancelRestock: row.cancel_restock,
    cancelNotifyCustomer: row.cancel_notify_customer,
    cancellationPaymentEvidence: row.cancellation_payment_evidence === null
      ? null
      : normalizeCancellationPaymentEvidence(
          row.cancellation_payment_evidence,
          true,
        ),
    staffNoteHash: row.staff_note_hash,
    requestedProjectionHash: row.requested_projection_hash || null,
    requiresOrderEdits: row.requires_order_edits === true,
    authorizationReason: row.authorization_reason,
    intentHash: row.intent_hash,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.effective_status || row.status,
    storedStatus: row.status,
    authorizedBy: row.authorized_by,
    authorizedRole: row.authorized_role,
    providerAttemptGlobalId: row.provider_attempt_global_id || null,
    processingLeaseExpiresAt: iso(row.processing_lease_expires_at),
    latestOutcomeGlobalId: row.latest_outcome_global_id || null,
    latestOutcomeState: row.latest_outcome_state || null,
    reconciliationResolution: row.reconciliation_resolution || null,
    providerWriteCount,
    providerReference: row.provider_reference || null,
    errorCode: row.error_code || null,
    preparedAt: iso(row.prepared_at)!,
    expiresAt: iso(row.expires_at)!,
    processingAt: iso(row.processing_at),
    completedAt: iso(row.completed_at),
    replayed,
  }
}

const AUTHORIZATION_SELECT = `SELECT
  authz.*,
  CASE
    WHEN authz.status = 'prepared'
     AND authz.expires_at <= clock_timestamp()
    THEN 'expired'
    ELSE authz.status
  END AS effective_status,
  attempt.global_id AS provider_attempt_global_id,
  attempt.attempt_hash AS provider_attempt_hash,
  attempt.processing_lease_expires_at,
  CASE
    WHEN attempt.processing_lease_expires_at IS NULL THEN NULL
    ELSE attempt.processing_lease_expires_at <= clock_timestamp()
  END AS processing_lease_expired,
  outcome.global_id AS latest_outcome_global_id,
  outcome.outcome_state AS latest_outcome_state,
  outcome.reconciliation_resolution,
  outcome.provider_write_count,
  outcome.provider_reference,
  outcome.error_code,
  predecessor.global_id AS predecessor_authorization_global_id,
  predecessor.fulfillment_gid AS predecessor_fulfillment_gid
FROM operations_shopify_order_management_authorizations authz
LEFT JOIN operations_shopify_order_management_attempts attempt
  ON attempt.organization_id = authz.organization_id
 AND attempt.id = authz.provider_attempt_id
LEFT JOIN operations_shopify_order_management_outcomes outcome
  ON outcome.organization_id = authz.organization_id
 AND outcome.id = authz.latest_outcome_id
LEFT JOIN operations_shopify_order_management_authorizations predecessor
  ON predecessor.organization_id = authz.organization_id
 AND predecessor.id = authz.predecessor_authorization_id`

async function requireActorRole(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string
    requiresCancellationAuthority?: boolean
  },
) {
  const result = await client.query<{ role: 'owner' | 'admin' | 'member' }>(
    `SELECT membership.role
     FROM app_user_organization_memberships membership
     WHERE membership.organization_id = $1::uuid
       AND membership.user_email = $2
       AND membership.status = 'active'
       AND (
         membership.role = 'owner'
         OR COALESCE(
           (membership.permissions->>'manageOperations')::boolean,
           false
         )
       )
       AND (
         NOT $3::boolean
         OR membership.role = 'owner'
         OR (
           membership.role = 'admin'
           AND COALESCE(
             (membership.permissions->>'manageOperations')::boolean,
             false
           )
           AND COALESCE(
             (membership.permissions->>'executeWarehouse')::boolean,
             false
           )
         )
       )
     FOR SHARE`,
    [
      input.organizationId,
      input.actorEmail,
      input.requiresCancellationAuthority === true,
    ],
  )
  const role = result.rows[0]?.role
  if (role !== 'owner' && role !== 'admin' && role !== 'member') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_FORBIDDEN',
      'Shopify order management requires Operations-management permission',
      403,
    )
  }
  return role
}

async function readBinding(
  client: PoolClient,
  input: {
    organizationId: string
    accountGlobalId: string
    orderGlobalId: string
    fulfillmentGid: string | null
    expectedFulfillmentUpdatedAt: string | null
    predecessorAuthorizationGlobalId: string | null
  },
) {
  const result = await client.query<BindingRow>(
    `SELECT
       account.id::text AS integration_account_id,
       account.global_id AS integration_account_global_id,
       account.environment AS account_environment,
       account.external_account_id,
       account.configuration->>'shopDomain' AS shop_domain,
       account.commerce_credential_generation AS credential_generation,
       credential.external_account_id AS credential_external_account_id,
       credential.credential_version,
       credential.auth_mode,
       credential.verification_status,
       credential.last_error_code AS credential_last_error_code,
       provider_control.row_version AS provider_write_control_row_version,
       provider_control.requested_mode AS provider_write_requested_mode,
       provider_control.bound_granted_scope_digest
         AS provider_write_scope_digest,
       provider_control.bound_granted_scopes
         AS provider_write_bound_scopes,
       (
         provider_control.requested_mode = 'on'
         AND provider_control.row_version > 0
         AND provider_control.bound_credential_generation =
               account.commerce_credential_generation
         AND provider_control.bound_granted_scopes =
               operations_commerce_granted_scope_snapshot(
                 account.configuration
               )
         AND 'write_orders' = ANY(provider_control.bound_granted_scopes)
         AND provider_control.bound_granted_scope_digest =
               operations_commerce_granted_scope_digest(
                 operations_commerce_granted_scope_snapshot(
                   account.configuration
                 )
               )
       ) AS provider_write_binding_current,
       order_row.id::text AS order_id,
       order_row.global_id AS order_global_id,
       order_row.external_order_id,
       order_row.order_number,
       order_row.row_version::text AS order_row_version,
       order_row.status AS order_status,
       order_row.archived_at,
       order_row.source_payload->>'sourceHash' AS source_hash,
       target.accepted_source_hash,
       accepted.id::text AS accepted_observation_id,
       operations_shopify_order_management_snapshot_updated_at(
         accepted.normalized_snapshot
       ) AS accepted_provider_order_updated_at,
       target.latest_source_hash,
       target.material_state,
       ocr_order_has_zero_downstream(
         order_row.organization_id, order_row.id
       ) AS zero_downstream,
       CASE
         WHEN $4::text IS NULL OR $5::timestamptz IS NULL THEN false
         ELSE operations_shopify_fulfillment_reversal_is_safe(
           order_row.organization_id,
           order_row.id,
           $4,
           $5::timestamptz
         )
       END AS fulfillment_reversal_safe,
       predecessor.id::text AS predecessor_authorization_id,
       predecessor.global_id AS predecessor_authorization_global_id,
       predecessor.fulfillment_gid AS predecessor_fulfillment_gid,
       CASE
         WHEN predecessor.id IS NULL THEN false
         ELSE operations_shopify_post_reversal_order_cancellation_is_safe(
           order_row.organization_id,
           order_row.id,
           predecessor.id
         )
       END AS post_reversal_order_cancellation_safe
     FROM operations_orders order_row
     JOIN operations_integration_accounts account
       ON account.organization_id = order_row.organization_id
      AND account.id = order_row.integration_account_id
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_commerce_provider_write_control_current provider_control
       ON provider_control.organization_id = account.organization_id
      AND provider_control.integration_account_id = account.id
     JOIN operations_commerce_order_revision_targets target
       ON target.organization_id = order_row.organization_id
      AND target.order_id = order_row.id
     LEFT JOIN operations_shopify_order_management_authorizations predecessor
       ON predecessor.organization_id = order_row.organization_id
      AND predecessor.order_id = order_row.id
      AND predecessor.integration_account_id = account.id
      AND predecessor.external_order_id = order_row.external_order_id
      AND predecessor.global_id = $6
      AND predecessor.action = 'cancel_fulfillment'
     LEFT JOIN operations_commerce_order_revision_observations accepted
       ON accepted.organization_id = target.organization_id
      AND accepted.id = target.accepted_observation_id
      AND accepted.integration_account_id = target.integration_account_id
      AND accepted.target_id = target.id
      AND accepted.order_id = target.order_id
      AND accepted.provider = target.provider
      AND accepted.external_order_id = order_row.external_order_id
      AND accepted.source_hash = target.accepted_source_hash
      AND accepted.canonical_row_version = order_row.row_version
     WHERE order_row.organization_id = $1::uuid
       AND account.global_id = $2
       AND order_row.global_id = $3
     FOR UPDATE OF order_row, account, credential, target`,
    [
      input.organizationId,
      input.accountGlobalId,
      input.orderGlobalId,
      input.fulfillmentGid,
      input.expectedFulfillmentUpdatedAt,
      input.predecessorAuthorizationGlobalId,
    ],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_FOUND',
      'The exact imported Shopify order was not found',
      404,
    )
  }
  return row
}

function assertCurrentBinding(
  row: BindingRow,
  input: {
    expectedOrderRowVersion: number
    expectedSourceHash: string
    action: ShopifyOrderManagementAction['type']
    providerOrderUpdatedAt: string
    requiresOrderEdits?: boolean
  },
) {
  const fulfillmentReversal = input.action === 'cancel_fulfillment'
  const postReversalOrderCancellation =
    input.action === 'cancel_order_after_fulfillment_reversal'
  if (
    !['sandbox', 'production'].includes(row.account_environment)
    || !row.external_account_id
    || !row.shop_domain
    || row.credential_generation < 1
    || row.credential_external_account_id !== row.external_account_id
    || row.credential_version !== row.credential_generation
    || row.auth_mode !== 'shopify_client_credentials'
    || row.verification_status !== 'verified'
    || row.credential_last_error_code !== null
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACCOUNT_NOT_CURRENT',
      'The Shopify account or credential is not current',
    )
  }
  if (
    row.provider_write_requested_mode !== 'on'
    || row.provider_write_binding_current !== true
    || Number(row.provider_write_control_row_version) < 1
    || !row.provider_write_scope_digest
    || !SHA256.test(row.provider_write_scope_digest)
    || (input.requiresOrderEdits
      && !row.provider_write_bound_scopes?.includes('write_order_edits'))
    || (fulfillmentReversal
      && !row.provider_write_bound_scopes?.includes(
        'write_merchant_managed_fulfillment_orders',
      ))
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_PROVIDER_WRITES_OFF',
      'Turn Provider writes On for this Shopify connection before saving changes',
    )
  }
  if (
    Number(row.order_row_version) !== input.expectedOrderRowVersion
    || (
      fulfillmentReversal
        ? row.order_status !== 'cancelled'
        : postReversalOrderCancellation
          ? row.order_status !== 'cancelled'
        : row.order_status !== 'imported'
    )
    || row.archived_at !== null
    || row.source_hash !== input.expectedSourceHash
    || row.accepted_source_hash !== input.expectedSourceHash
    || (
      input.action === 'add_tag'
        ? ![
            'current',
            'review_required',
            'provider_cancelled',
            'provider_fulfilled',
          ].includes(row.material_state)
        : fulfillmentReversal
          ? row.material_state !== 'provider_fulfilled'
        : postReversalOrderCancellation
          ? !['provider_fulfilled', 'review_required'].includes(
              row.material_state,
            )
        : (
            !row.accepted_observation_id
            || !row.accepted_provider_order_updated_at
            || iso(row.accepted_provider_order_updated_at)
              !== input.providerOrderUpdatedAt
            || (row.latest_source_hash !== null
              && row.latest_source_hash !== input.expectedSourceHash)
            || row.material_state !== 'current'
          )
    )
    || (
      fulfillmentReversal
        ? row.fulfillment_reversal_safe !== true
        : postReversalOrderCancellation
          ? row.post_reversal_order_cancellation_safe !== true
        : row.zero_downstream !== true
    )
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
      fulfillmentReversal
        ? 'The order changed or is no longer eligible for fulfillment reversal'
        : postReversalOrderCancellation
          ? 'The order changed or is no longer eligible for cancellation after fulfillment reversal'
        : 'The order changed, left Imported status, or has downstream warehouse work',
    )
  }
}

export async function prepareShopifyOrderManagementInPostgres(
  input: PrepareShopifyOrderManagementInput,
): Promise<ShopifyOrderManagementAuthorization> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const authorizedBy = actorEmail(input.actorEmail)
  const accountGlobalId = globalId(
    input.accountGlobalId,
    ACCOUNT_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_ACCOUNT_REQUIRED',
    'A valid Shopify commerce account Global ID is required',
  )
  const orderGlobalId = globalId(
    input.orderGlobalId,
    ORDER_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_ORDER_REQUIRED',
    'A valid Operations order Global ID is required',
  )
  const expectedOrderRowVersion = integer(
    input.expectedOrderRowVersion,
    'Expected order row version',
  )
  const expectedSourceHash = sourceHash(input.expectedSourceHash)
  const action = normalizeShopifyOrderManagementAction(input.action)
  const cancellation = action.type === 'cancel'
    || action.type === 'cancel_order_after_fulfillment_reversal'
  const cancellationPaymentEvidence = normalizeCancellationPaymentEvidence(
    input.cancellationPaymentEvidence,
    cancellation,
  )
  const requestedProjectionHash = projectionHash(
    input.requestedProjectionHash,
    action.type === 'save_order',
  )
  if (action.type !== 'save_order' && requestedProjectionHash !== null) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ACTION_INVALID',
      'Requested order projection applies only to a combined order save',
      400,
    )
  }
  const requiresOrderEdits = action.type === 'save_order'
    && action.lineQuantities.length > 0
  const expectedLineQuantityValue = expectedLineQuantity(
    input.expectedLineQuantity,
    action,
  )
  const key = idempotencyKey(input.idempotencyKey)
  const reason = authorizationReason(input.reason)
  const actionFacts = actionEvidence(action)
  const exactIntentHash = intentHash(
    action,
    reason,
    expectedLineQuantityValue,
  )
  const requestHash = shopifyOrderManagementEvidenceHash({
    schema: cancellation
      ? 'shopify-order-management-preparation-request-v2'
      : 'shopify-order-management-preparation-request-v1',
    organizationId: scopedOrganizationId,
    actorEmail: authorizedBy,
    accountGlobalId,
    orderGlobalId,
    expectedOrderRowVersion,
    expectedSourceHash,
    intentHash: exactIntentHash,
    requestedProjectionHash,
    ...(cancellation ? { cancellationPaymentEvidence } : {}),
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-management:${scopedOrganizationId}:${accountGlobalId}:${key}`,
    )
    const role = await requireActorRole(client, {
      organizationId: scopedOrganizationId,
      actorEmail: authorizedBy,
      requiresCancellationAuthority: action.type === 'cancel'
        || action.type === 'cancel_order_after_fulfillment_reversal',
    })
    const existing = await client.query<AuthorizationRow>(
      `${AUTHORIZATION_SELECT}
       WHERE authz.organization_id = $1::uuid
         AND authz.integration_account_global_id = $2
         AND authz.idempotency_key = $3
       FOR UPDATE OF authz`,
      [scopedOrganizationId, accountGlobalId, key],
    )
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        fail(
          'SHOPIFY_ORDER_MANAGEMENT_IDEMPOTENCY_CONFLICT',
          'The idempotency key was already used for a different order action',
        )
      }
      return authorization(existing.rows[0], true)
    }

    const providerOrderUpdatedAt = timestamp(
      input.providerOrderUpdatedAt,
      'Provider order update time',
    )
    const providerOrderObservedAt = timestamp(
      input.providerOrderObservedAt,
      'Provider order observation time',
    )
    if (typeof input.providerOrderTest !== 'boolean') {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_SNAPSHOT_INVALID',
        'The exact Shopify order test flag is required',
        400,
      )
    }
    const providerOrderTest = input.providerOrderTest
    if (
      (
        action.type === 'cancel_fulfillment'
        || action.type === 'cancel_order_after_fulfillment_reversal'
        || action.type === 'set_line_quantity'
        || requiresOrderEdits
      )
      && !providerOrderTest
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_TEST_ORDER_REQUIRED',
        'Fulfillment reversal and line quantity changes require a Shopify test order',
        409,
      )
    }
    const providerSnapshotHashValue = providerSnapshotHash({
      orderGlobalId,
      expectedSourceHash,
      providerOrderUpdatedAt,
      providerOrderObservedAt,
      providerOrderTest,
      action: action.type,
      fulfillmentGid: actionFacts.fulfillmentGid,
      expectedFulfillmentUpdatedAt:
        actionFacts.expectedFulfillmentUpdatedAt,
      predecessorAuthorizationGlobalId:
        actionFacts.predecessorAuthorizationGlobalId,
      expectedLineQuantity: expectedLineQuantityValue,
      requestedProjectionHash,
      requiresOrderEdits,
      cancellationPaymentEvidence,
      cancelRefundMethod: actionFacts.cancelRefundMethod,
      cancelRestock: actionFacts.cancelRestock,
      cancelNotifyCustomer: actionFacts.cancelNotifyCustomer,
    })

    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-management-order:${scopedOrganizationId}:${orderGlobalId}`,
    )
    const unresolved = await client.query<{ global_id: string; status: string }>(
      `SELECT global_id, status
       FROM operations_shopify_order_management_authorizations
       WHERE organization_id = $1::uuid
         AND order_global_id = $2
         AND status IN ('processing', 'unknown')
       LIMIT 1
       FOR UPDATE`,
      [scopedOrganizationId, orderGlobalId],
    )
    if (unresolved.rows[0]) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_UNRESOLVED_WRITE',
        'A processing or unknown Shopify write must be reconciled before another action',
      )
    }
    const binding = await readBinding(client, {
      organizationId: scopedOrganizationId,
      accountGlobalId,
      orderGlobalId,
      fulfillmentGid: actionFacts.fulfillmentGid,
      expectedFulfillmentUpdatedAt:
        actionFacts.expectedFulfillmentUpdatedAt,
      predecessorAuthorizationGlobalId:
        actionFacts.predecessorAuthorizationGlobalId,
    })
    assertCurrentBinding(binding, {
      expectedOrderRowVersion,
      expectedSourceHash,
      action: action.type,
      providerOrderUpdatedAt,
      requiresOrderEdits,
    })
    const acceptedObservationId = [
      'add_tag', 'cancel_fulfillment',
      'cancel_order_after_fulfillment_reversal',
    ].includes(action.type)
      ? null : binding.accepted_observation_id
    const acceptedProviderOrderUpdatedAt = [
      'add_tag', 'cancel_fulfillment',
      'cancel_order_after_fulfillment_reversal',
    ].includes(action.type)
      ? null : iso(binding.accepted_provider_order_updated_at)

    const inserted = await client.query<AuthorizationRow>(
      `WITH prepared_clock AS (
         SELECT clock_timestamp() AS prepared_at
       )
       INSERT INTO operations_shopify_order_management_authorizations (
         organization_id, integration_account_id,
         integration_account_global_id, provider, account_environment,
         external_account_id, shop_domain, credential_generation,
         provider_write_control_row_version, provider_write_scope_digest,
         order_id, order_global_id,
         external_order_id, order_number, expected_order_row_version,
         expected_source_hash, provider_order_updated_at,
         provider_order_observed_at, provider_order_test,
         provider_snapshot_hash, action, fulfillment_gid,
         expected_fulfillment_updated_at, line_item_id,
         expected_line_quantity, requested_quantity,
         tag_hash, cancel_reason, staff_note_hash,
         requested_projection_hash, requires_order_edits,
         authorization_reason,
         intent_hash,
         idempotency_key, request_hash, status, authorized_by,
         authorized_role, accepted_observation_id,
         accepted_provider_order_updated_at, predecessor_authorization_id,
         cancel_refund_method, cancel_restock, cancel_notify_customer,
         cancellation_payment_evidence,
         prepared_at, expires_at
       )
       SELECT
         $1::uuid, $2::uuid, $3, 'shopify', $4, $5, $6, $7,
         $8, $9, $10::uuid, $11, $12, $13, $14::bigint, $15,
         $16::timestamptz, $17::timestamptz, $18, $19, $20, $21,
         $22::timestamptz, $23, $24, $25, $26, $27, $28, $29,
         $30, $31, $32, $33, $34, 'prepared', $35, $36,
         $37::uuid, $38::timestamptz, $39::uuid,
         $40, $41::boolean, $42::boolean, $43::jsonb,
         prepared_clock.prepared_at,
         prepared_clock.prepared_at + interval '5 minutes'
       FROM prepared_clock
       RETURNING *`,
      [
        scopedOrganizationId,
        binding.integration_account_id,
        binding.integration_account_global_id,
        binding.account_environment,
        binding.external_account_id,
        binding.shop_domain,
        binding.credential_generation,
        Number(binding.provider_write_control_row_version),
        binding.provider_write_scope_digest,
        binding.order_id,
        binding.order_global_id,
        binding.external_order_id,
        binding.order_number,
        expectedOrderRowVersion,
        expectedSourceHash,
        providerOrderUpdatedAt,
        providerOrderObservedAt,
        providerOrderTest,
        providerSnapshotHashValue,
        actionFacts.action,
        actionFacts.fulfillmentGid,
        actionFacts.expectedFulfillmentUpdatedAt,
        actionFacts.lineItemGid,
        expectedLineQuantityValue,
        actionFacts.requestedQuantity,
        actionFacts.tagHash,
        actionFacts.cancelReason,
        actionFacts.staffNoteHash,
        requestedProjectionHash,
        requiresOrderEdits,
        reason,
        exactIntentHash,
        key,
        requestHash,
        authorizedBy,
        role,
        acceptedObservationId,
        acceptedProviderOrderUpdatedAt,
        binding.predecessor_authorization_id,
        actionFacts.cancelRefundMethod,
        actionFacts.cancelRestock,
        actionFacts.cancelNotifyCustomer,
        cancellationPaymentEvidence === null
          ? null : JSON.stringify(cancellationPaymentEvidence),
      ],
    )
    const row = inserted.rows[0]
    await recordAuditEvent({
      actor: authorizedBy,
      eventType: 'operations.shopify_order_management.prepared',
      aggregateType: 'operations.shopify_order_management_authorization',
      aggregateId: row.global_id,
      subject: row.order_global_id,
      organizationId: scopedOrganizationId,
      eventKey: `operations:shopify-order-management:${row.global_id}:prepared`,
      payload: {
        accountGlobalId: row.integration_account_global_id,
        orderGlobalId: row.order_global_id,
        externalOrderId: row.external_order_id,
        action: row.action,
        credentialGeneration: row.credential_generation,
        providerWriteControlRowVersion:
          row.provider_write_control_row_version,
        providerWriteScopeDigest: row.provider_write_scope_digest,
        expectedOrderRowVersion,
        expectedSourceHash,
        acceptedObservationId,
        acceptedProviderOrderUpdatedAt,
        providerSnapshotHash: providerSnapshotHashValue,
        intentHash: exactIntentHash,
        authorizationReason: reason,
        expectedLineQuantity: expectedLineQuantityValue,
        fulfillmentGid: actionFacts.fulfillmentGid,
        expectedFulfillmentUpdatedAt:
          actionFacts.expectedFulfillmentUpdatedAt,
        predecessorAuthorizationGlobalId:
          actionFacts.predecessorAuthorizationGlobalId,
        predecessorFulfillmentGid: binding.predecessor_fulfillment_gid,
        requestedProjectionHash,
        requiresOrderEdits,
        cancelRefundMethod: actionFacts.cancelRefundMethod,
        cancelRestock: actionFacts.cancelRestock,
        cancelNotifyCustomer: actionFacts.cancelNotifyCustomer,
        cancellationPaymentEvidence,
        expiresAt: iso(row.expires_at),
        providerWrites: 0,
      },
    }, client)
    return authorization({
      ...row,
      predecessor_authorization_global_id:
        actionFacts.predecessorAuthorizationGlobalId,
      predecessor_fulfillment_gid: binding.predecessor_fulfillment_gid,
    })
  })
}

export async function claimShopifyOrderManagementInPostgres(
  input: ClaimShopifyOrderManagementInput,
): Promise<ClaimedShopifyOrderManagementAction> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const claimedBy = actorEmail(input.actorEmail)
  const authorizationGlobalId = globalId(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_REQUIRED',
    'A valid Shopify order management authorization is required',
  )
  const action = normalizeShopifyOrderManagementAction(input.action)
  const expectedLineQuantityValue = expectedLineQuantity(
    input.expectedLineQuantity,
    action,
  )
  const reason = authorizationReason(input.reason)
  const exactIntentHash = intentHash(
    action,
    reason,
    expectedLineQuantityValue,
  )

  const result = await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-management-claim:${scopedOrganizationId}:${authorizationGlobalId}`,
    )
    const role = await requireActorRole(client, {
      organizationId: scopedOrganizationId,
      actorEmail: claimedBy,
      requiresCancellationAuthority: action.type === 'cancel'
        || action.type === 'cancel_order_after_fulfillment_reversal',
    })
    const selected = await client.query<AuthorizationRow>(
      `${AUTHORIZATION_SELECT}
       WHERE authz.organization_id = $1::uuid
         AND authz.global_id = $2
       FOR UPDATE OF authz`,
      [scopedOrganizationId, authorizationGlobalId],
    )
    const row = selected.rows[0]
    if (!row) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_NOT_FOUND',
        'The Shopify order management authorization was not found',
        404,
      )
    }
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-provider-writes:${scopedOrganizationId}:${row.integration_account_global_id}`,
    )
    if (
      row.authorized_by !== claimedBy
      || row.authorized_role !== role
      || row.authorization_reason !== reason
      || row.expected_line_quantity !== expectedLineQuantityValue
      || row.requires_order_edits !== (
        action.type === 'save_order' && action.lineQuantities.length > 0
      )
      || (action.type === 'save_order') !== Boolean(
        row.requested_projection_hash,
      )
      || row.intent_hash !== exactIntentHash
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_MISMATCH',
        'Actor, role, or exact order action changed after preparation',
      )
    }
    if (row.status !== 'prepared') {
      fail(
        row.status === 'processing' || row.status === 'unknown'
          ? 'SHOPIFY_ORDER_MANAGEMENT_UNRESOLVED_WRITE'
          : 'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_CONSUMED',
        'This authorization cannot dispatch another Shopify write',
      )
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      const expired = await client.query<AuthorizationRow>(
        `UPDATE operations_shopify_order_management_authorizations
         SET status = 'expired', completed_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'prepared'
         RETURNING *`,
        [scopedOrganizationId, row.id],
      )
      await recordAuditEvent({
        actor: claimedBy,
        eventType: 'operations.shopify_order_management.expired',
        aggregateType: 'operations.shopify_order_management_authorization',
        aggregateId: row.global_id,
        subject: row.order_global_id,
        organizationId: scopedOrganizationId,
        eventKey: `operations:shopify-order-management:${row.global_id}:expired`,
        payload: { action: row.action, providerWrites: 0 },
      }, client)
      return { expired: true as const, row: expired.rows[0] }
    }
    const current = await client.query<{ current: boolean }>(
      `SELECT operations_shopify_order_management_is_current(
         $1::uuid, $2::uuid, true
       ) AS current`,
      [scopedOrganizationId, row.id],
    )
    if (current.rows[0]?.current !== true) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
        'The account, credential, Provider writes control, order, source, or warehouse state changed',
      )
    }
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-management-order:${scopedOrganizationId}:${row.order_global_id}`,
    )
    const attemptHash = shopifyOrderManagementEvidenceHash({
      schema: 'shopify-order-management-provider-attempt-v1',
      authorizationGlobalId: row.global_id,
      organizationId: row.organization_id,
      accountGlobalId: row.integration_account_global_id,
      credentialGeneration: row.credential_generation,
      providerWriteControlRowVersion:
        row.provider_write_control_row_version,
      providerWriteScopeDigest: row.provider_write_scope_digest,
      orderGlobalId: row.order_global_id,
      externalOrderId: row.external_order_id,
      expectedOrderRowVersion: Number(row.expected_order_row_version),
      expectedSourceHash: row.expected_source_hash,
      acceptedObservationId: row.accepted_observation_id,
      acceptedProviderOrderUpdatedAt:
        iso(row.accepted_provider_order_updated_at),
      providerSnapshotHash: row.provider_snapshot_hash,
      cancelRefundMethod: row.cancel_refund_method,
      cancelRestock: row.cancel_restock,
      cancelNotifyCustomer: row.cancel_notify_customer,
      cancellationPaymentEvidence: row.cancellation_payment_evidence,
      ...(row.action === 'cancel_fulfillment'
        ? {
            fulfillmentGid: row.fulfillment_gid,
            expectedFulfillmentUpdatedAt:
              iso(row.expected_fulfillment_updated_at),
          }
        : {}),
      ...(row.action === 'cancel_order_after_fulfillment_reversal'
        ? {
            predecessorAuthorizationGlobalId:
              row.predecessor_authorization_global_id,
          }
        : {}),
      expectedLineQuantity: row.expected_line_quantity,
      requestedProjectionHash: row.requested_projection_hash,
      requiresOrderEdits: row.requires_order_edits,
      intentHash: row.intent_hash,
    })
    const attempted = await client.query<{
      id: string
      global_id: string
      claimed_at: TimestampValue
      processing_lease_expires_at: TimestampValue
    }>(
      `WITH claim_clock AS (
         SELECT clock_timestamp() AS claimed_at
       )
       INSERT INTO operations_shopify_order_management_attempts (
         organization_id, authorization_id, integration_account_id,
         integration_account_global_id, provider, external_account_id,
         credential_generation, provider_write_control_row_version,
         provider_write_scope_digest, order_id,
         order_global_id, external_order_id, expected_order_row_version,
         expected_source_hash, provider_snapshot_hash, action,
         fulfillment_gid, expected_fulfillment_updated_at, intent_hash,
         expected_line_quantity, requested_projection_hash,
         requires_order_edits, attempt_hash, dispatch_state, claimed_by,
         accepted_observation_id, accepted_provider_order_updated_at,
         predecessor_authorization_id,
         cancel_refund_method, cancel_restock, cancel_notify_customer,
         cancellation_payment_evidence, claimed_at,
         processing_lease_expires_at
       ) SELECT
         $1::uuid, $2::uuid, $3::uuid, $4, 'shopify', $5, $6, $7,
         $8, $9::uuid, $10, $11, $12::bigint, $13, $14, $15,
         $16, $17::timestamptz, $18, $19, $20, $21, $22,
         'authorized', $23, $24::uuid, $25::timestamptz, $26::uuid,
         $27, $28::boolean, $29::boolean, $30::jsonb,
         claim_clock.claimed_at,
         claim_clock.claimed_at + interval '5 minutes'
       FROM claim_clock
       RETURNING id::text, global_id, claimed_at,
                 processing_lease_expires_at`,
      [
        scopedOrganizationId,
        row.id,
        row.integration_account_id,
        row.integration_account_global_id,
        row.external_account_id,
        row.credential_generation,
        row.provider_write_control_row_version,
        row.provider_write_scope_digest,
        row.order_id,
        row.order_global_id,
        row.external_order_id,
        row.expected_order_row_version,
        row.expected_source_hash,
        row.provider_snapshot_hash,
        row.action,
        row.fulfillment_gid,
        row.expected_fulfillment_updated_at,
        row.intent_hash,
        row.expected_line_quantity,
        row.requested_projection_hash,
        row.requires_order_edits,
        attemptHash,
        claimedBy,
        row.accepted_observation_id,
        row.accepted_provider_order_updated_at,
        row.predecessor_authorization_id,
        row.cancel_refund_method,
        row.cancel_restock,
        row.cancel_notify_customer,
        row.cancellation_payment_evidence === null
          ? null : JSON.stringify(row.cancellation_payment_evidence),
      ],
    )
    const attempt = attempted.rows[0]
    const updated = await client.query<AuthorizationRow>(
      `UPDATE operations_shopify_order_management_authorizations
       SET status = 'processing', provider_attempt_id = $3::uuid,
           processing_at = $4::timestamptz, updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND status = 'prepared'
       RETURNING *`,
      [scopedOrganizationId, row.id, attempt.id, attempt.claimed_at],
    )
    if (updated.rowCount !== 1) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_CLAIM_CONFLICT',
        'The Shopify provider attempt could not be claimed atomically',
      )
    }
    await recordAuditEvent({
      actor: claimedBy,
      eventType: 'operations.shopify_order_management.provider_attempt_committed',
      aggregateType: 'operations.shopify_order_management_authorization',
      aggregateId: row.global_id,
      subject: row.order_global_id,
      organizationId: scopedOrganizationId,
      eventKey: `operations:shopify-order-management:${attempt.global_id}:committed`,
      payload: {
        providerAttemptGlobalId: attempt.global_id,
        accountGlobalId: row.integration_account_global_id,
        orderGlobalId: row.order_global_id,
        externalOrderId: row.external_order_id,
        action: row.action,
        credentialGeneration: row.credential_generation,
        providerWriteControlRowVersion:
          row.provider_write_control_row_version,
        providerWriteScopeDigest: row.provider_write_scope_digest,
        expectedOrderRowVersion: Number(row.expected_order_row_version),
        expectedSourceHash: row.expected_source_hash,
        acceptedObservationId: row.accepted_observation_id,
        acceptedProviderOrderUpdatedAt:
          iso(row.accepted_provider_order_updated_at),
        providerSnapshotHash: row.provider_snapshot_hash,
        fulfillmentGid: row.fulfillment_gid,
        expectedFulfillmentUpdatedAt:
          iso(row.expected_fulfillment_updated_at),
        predecessorAuthorizationGlobalId:
          row.predecessor_authorization_global_id || null,
        predecessorFulfillmentGid: row.predecessor_fulfillment_gid || null,
        expectedLineQuantity: row.expected_line_quantity,
        requestedProjectionHash: row.requested_projection_hash,
        requiresOrderEdits: row.requires_order_edits,
        cancelRefundMethod: row.cancel_refund_method,
        cancelRestock: row.cancel_restock,
        cancelNotifyCustomer: row.cancel_notify_customer,
        intentHash: row.intent_hash,
        authorizationReason: row.authorization_reason,
        attemptHash,
        processingLeaseExpiresAt: iso(attempt.processing_lease_expires_at),
        providerWrites: 0,
        networkCalls: 0,
      },
    }, client)
    return {
      expired: false as const,
      row: {
        ...updated.rows[0],
        predecessor_authorization_global_id:
          row.predecessor_authorization_global_id || null,
        predecessor_fulfillment_gid:
          row.predecessor_fulfillment_gid || null,
      },
      attempt,
      attemptHash,
    }
  })

  if (result.expired) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_EXPIRED',
      'The five-minute Shopify order authorization expired before dispatch',
      410,
    )
  }
  const mapped = authorization({
    ...result.row,
    provider_attempt_global_id: result.attempt.global_id,
    processing_lease_expires_at:
      result.attempt.processing_lease_expires_at,
  })
  return {
    ...mapped,
    status: 'processing',
    storedStatus: 'processing',
    providerAttemptGlobalId: result.attempt.global_id,
    processingLeaseExpiresAt:
      iso(result.attempt.processing_lease_expires_at)!,
    attemptHash: result.attemptHash,
    claimedAt: iso(result.attempt.claimed_at)!,
    actionInput: action,
  }
}

function optionalProviderReference(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  const normalized = String(value).trim()
  if (
    normalized.length < 1
    || normalized.length > 512
    || !SAFE_TEXT.test(normalized)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_OUTCOME_INVALID',
      'Provider result reference is invalid',
      400,
    )
  }
  return normalized
}

function normalizedErrorCode(value: unknown, required: boolean) {
  if (!required && (value === undefined || value === null || value === '')) {
    return null
  }
  const normalized = String(value || '').trim().toUpperCase()
  if (!ERROR_CODE.test(normalized)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_OUTCOME_INVALID',
      'A safe provider outcome error code is required',
      400,
    )
  }
  return normalized
}

function providerWriteCount(
  value: unknown,
  input: {
    outcome: 'succeeded' | 'failed' | 'unknown' | 'reconciled'
  },
) {
  if (value === null || value === undefined) {
    if (input.outcome === 'unknown' || input.outcome === 'reconciled') {
      return null
    }
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_OUTCOME_INVALID',
      'A known provider write count is required for this outcome',
      400,
    )
  }
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 253) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_OUTCOME_INVALID',
      'Provider write count must be an integer from zero through 253',
      400,
    )
  }
  return normalized
}

async function selectAuthorizationForOutcome(
  client: PoolClient,
  input: {
    organizationId: string
    authorizationGlobalId: string
    providerAttemptGlobalId: string
  },
) {
  const selected = await client.query<AuthorizationRow & {
    provider_attempt_global_id: string | null
  }>(
    `${AUTHORIZATION_SELECT}
     WHERE authz.organization_id = $1::uuid
       AND authz.global_id = $2
       AND attempt.global_id = $3
     FOR UPDATE OF authz`,
    [
      input.organizationId,
      input.authorizationGlobalId,
      input.providerAttemptGlobalId,
    ],
  )
  const row = selected.rows[0]
  if (!row) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_NOT_FOUND',
      'The exact Shopify provider attempt was not found',
      404,
    )
  }
  return row
}

export async function recordShopifyOrderManagementOutcomeInPostgres(
  input: RecordShopifyOrderManagementOutcomeInput,
): Promise<ShopifyOrderManagementAuthorization> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const recordedBy = actorEmail(input.actorEmail)
  const authorizationGlobalId = globalId(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_REQUIRED',
    'A valid Shopify order management authorization is required',
  )
  const providerAttemptGlobalId = globalId(
    input.providerAttemptGlobalId,
    ATTEMPT_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_REQUIRED',
    'A valid Shopify provider attempt is required',
  )
  if (!['succeeded', 'failed', 'unknown'].includes(input.outcome)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_OUTCOME_INVALID',
      'Provider outcome must be succeeded, failed, or unknown',
      400,
    )
  }
  const providerReference = optionalProviderReference(input.providerReference)
  const errorCode = normalizedErrorCode(
    input.errorCode,
    input.outcome !== 'succeeded',
  )
  const evidenceHash = shopifyOrderManagementEvidenceHash({
    schema: 'shopify-order-management-provider-outcome-v1',
    outcome: input.outcome,
    evidence: input.evidence,
  })
  const exactProviderWriteCount = providerWriteCount(
    input.providerWriteCount,
    { outcome: input.outcome },
  )

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-management-outcome:${scopedOrganizationId}:${authorizationGlobalId}`,
    )
    const row = await selectAuthorizationForOutcome(client, {
      organizationId: scopedOrganizationId,
      authorizationGlobalId,
      providerAttemptGlobalId,
    })
    if (
      row.status !== 'processing'
      || row.authorized_by !== recordedBy
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_OUTCOME_CONFLICT',
        'The exact processing attempt does not belong to this actor',
      )
    }
    const inserted = await client.query<{
      id: string
      global_id: string
      recorded_at: TimestampValue
    }>(
      `INSERT INTO operations_shopify_order_management_outcomes (
         organization_id, authorization_id, provider_attempt_id,
         outcome_state, reconciliation_resolution, provider_write_count,
         provider_reference, evidence_hash, error_code, recorded_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, NULL, $5, $6, $7, $8, $9
       )
       RETURNING id::text, global_id, recorded_at`,
      [
        scopedOrganizationId,
        row.id,
        row.provider_attempt_id,
        input.outcome,
        exactProviderWriteCount,
        providerReference,
        evidenceHash,
        errorCode,
        recordedBy,
      ],
    )
    const outcome = inserted.rows[0]
    const updated = await client.query<AuthorizationRow>(
      `UPDATE operations_shopify_order_management_authorizations
       SET status = $3, latest_outcome_id = $4::uuid,
           completed_at = $5::timestamptz, updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND status = 'processing'
       RETURNING *`,
      [
        scopedOrganizationId,
        row.id,
        input.outcome,
        outcome.id,
        outcome.recorded_at,
      ],
    )
    if (updated.rowCount !== 1) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_OUTCOME_CONFLICT',
        'The provider outcome could not be committed atomically',
      )
    }
    await recordAuditEvent({
      actor: recordedBy,
      eventType: `operations.shopify_order_management.${input.outcome}`,
      aggregateType: 'operations.shopify_order_management_authorization',
      aggregateId: row.global_id,
      subject: row.order_global_id,
      organizationId: scopedOrganizationId,
      eventKey: `operations:shopify-order-management:${outcome.global_id}:recorded`,
      payload: {
        providerAttemptGlobalId,
        outcomeGlobalId: outcome.global_id,
        accountGlobalId: row.integration_account_global_id,
        orderGlobalId: row.order_global_id,
        externalOrderId: row.external_order_id,
        action: row.action,
        evidenceHash,
        providerReference,
        errorCode,
        providerWrites: exactProviderWriteCount,
      },
    }, client)
    return authorization({
      ...updated.rows[0],
      provider_attempt_global_id: providerAttemptGlobalId,
      latest_outcome_global_id: outcome.global_id,
      latest_outcome_state: input.outcome,
      provider_write_count: exactProviderWriteCount,
      provider_reference: providerReference,
      error_code: errorCode,
    })
  })
}

export async function recoverStaleShopifyOrderManagementAttemptInPostgres(
  input: RecoverStaleShopifyOrderManagementAttemptInput,
): Promise<RecoverStaleShopifyOrderManagementAttemptResult> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const recoveredBy = actorEmail(input.actorEmail)
  const authorizationGlobalId = globalId(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_REQUIRED',
    'A valid Shopify order management authorization is required',
  )
  const providerAttemptGlobalId = globalId(
    input.providerAttemptGlobalId,
    ATTEMPT_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_REQUIRED',
    'A valid Shopify provider attempt is required',
  )

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-management-outcome:${scopedOrganizationId}:${authorizationGlobalId}`,
    )
    const role = await requireActorRole(client, {
      organizationId: scopedOrganizationId,
      actorEmail: recoveredBy,
    })
    const row = await selectAuthorizationForOutcome(client, {
      organizationId: scopedOrganizationId,
      authorizationGlobalId,
      providerAttemptGlobalId,
    })
    if (row.status !== 'processing') {
      return Object.freeze({
        authorization: authorization(row),
        recovered: false,
      })
    }
    if (row.processing_lease_expired !== true) {
      return Object.freeze({
        authorization: authorization(row),
        recovered: false,
      })
    }
    const processingLeaseExpiresAt = iso(row.processing_lease_expires_at)
    if (!processingLeaseExpiresAt || !row.provider_attempt_hash) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_EVIDENCE_INVALID',
        'The durable Shopify processing lease evidence is incomplete',
        500,
      )
    }
    const evidenceHash = shopifyOrderManagementEvidenceHash({
      schema: 'shopify-order-management-stale-processing-recovery-v1',
      authorizationGlobalId: row.global_id,
      providerAttemptGlobalId,
      attemptHash: row.provider_attempt_hash,
      processingLeaseExpiresAt,
    })
    const inserted = await client.query<{
      id: string
      global_id: string
      recorded_at: TimestampValue
    }>(
      `INSERT INTO operations_shopify_order_management_outcomes (
         organization_id, authorization_id, provider_attempt_id,
         outcome_state, reconciliation_resolution, provider_write_count,
         provider_reference, evidence_hash, error_code, recorded_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'unknown', NULL, NULL, NULL,
         $4, $5, $6
       )
       RETURNING id::text, global_id, recorded_at`,
      [
        scopedOrganizationId,
        row.id,
        row.provider_attempt_id,
        evidenceHash,
        SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED_CODE,
        recoveredBy,
      ],
    )
    const outcome = inserted.rows[0]
    const updated = await client.query<AuthorizationRow>(
      `UPDATE operations_shopify_order_management_authorizations
       SET status = 'unknown', latest_outcome_id = $3::uuid,
           completed_at = $4::timestamptz, updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND status = 'processing'
       RETURNING *`,
      [scopedOrganizationId, row.id, outcome.id, outcome.recorded_at],
    )
    if (updated.rowCount !== 1) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_RECOVERY_CONFLICT',
        'The stale Shopify processing attempt could not be recovered atomically',
      )
    }
    await recordAuditEvent({
      actor: recoveredBy,
      eventType:
        'operations.shopify_order_management.processing_lease_expired',
      aggregateType: 'operations.shopify_order_management_authorization',
      aggregateId: row.global_id,
      subject: row.order_global_id,
      organizationId: scopedOrganizationId,
      eventKey: `operations:shopify-order-management:${outcome.global_id}:processing-lease-expired`,
      payload: {
        providerAttemptGlobalId,
        outcomeGlobalId: outcome.global_id,
        accountGlobalId: row.integration_account_global_id,
        orderGlobalId: row.order_global_id,
        externalOrderId: row.external_order_id,
        action: row.action,
        authorizedBy: row.authorized_by,
        authorizedRole: row.authorized_role,
        recoveredBy,
        recoveredRole: role,
        evidenceHash,
        processingLeaseExpiresAt,
        errorCode: SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED_CODE,
        providerWrites: null,
        providerRetryAuthorized: false,
      },
    }, client)
    return Object.freeze({
      authorization: authorization({
        ...updated.rows[0],
        provider_attempt_global_id: providerAttemptGlobalId,
        provider_attempt_hash: row.provider_attempt_hash,
        processing_lease_expires_at: row.processing_lease_expires_at,
        processing_lease_expired: true,
        latest_outcome_global_id: outcome.global_id,
        latest_outcome_state: 'unknown',
        reconciliation_resolution: null,
        provider_write_count: null,
        provider_reference: null,
        error_code:
          SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED_CODE,
      }),
      recovered: true,
    })
  })
}

export async function reconcileShopifyOrderManagementOutcomeInPostgres(
  input: ReconcileShopifyOrderManagementOutcomeInput,
): Promise<ShopifyOrderManagementAuthorization> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const recordedBy = actorEmail(input.actorEmail)
  const authorizationGlobalId = globalId(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_REQUIRED',
    'A valid Shopify order management authorization is required',
  )
  const providerAttemptGlobalId = globalId(
    input.providerAttemptGlobalId,
    ATTEMPT_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_REQUIRED',
    'A valid Shopify provider attempt is required',
  )
  if (input.resolution !== 'applied' && input.resolution !== 'not_applied') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RECONCILIATION_INVALID',
      'Reconciliation must prove applied or not_applied',
      400,
    )
  }
  const providerReference = optionalProviderReference(input.providerReference)
  const evidenceHash = shopifyOrderManagementEvidenceHash({
    schema: 'shopify-order-management-reconciliation-v1',
    resolution: input.resolution,
    evidence: input.evidence,
  })
  const requestedProviderWriteCount = providerWriteCount(
    input.providerWriteCount,
    { outcome: 'reconciled' },
  )

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-management-outcome:${scopedOrganizationId}:${authorizationGlobalId}`,
    )
    await requireActorRole(client, {
      organizationId: scopedOrganizationId,
      actorEmail: recordedBy,
    })
    const row = await selectAuthorizationForOutcome(client, {
      organizationId: scopedOrganizationId,
      authorizationGlobalId,
      providerAttemptGlobalId,
    })
    if (row.status !== 'unknown') {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_RECONCILIATION_CONFLICT',
        'Only the exact unknown attempt can be reconciled by a qualified operator',
      )
    }
    const exactProviderWriteCount = requestedProviderWriteCount
      ?? (row.provider_write_count === null
        || row.provider_write_count === undefined
        ? null
        : Number(row.provider_write_count))
    const inserted = await client.query<{
      id: string
      global_id: string
      recorded_at: TimestampValue
    }>(
      `INSERT INTO operations_shopify_order_management_outcomes (
         organization_id, authorization_id, provider_attempt_id,
         outcome_state, reconciliation_resolution, provider_write_count,
         provider_reference, evidence_hash, error_code, recorded_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'reconciled', $4, $5, $6, $7,
         NULL, $8
       )
       RETURNING id::text, global_id, recorded_at`,
      [
        scopedOrganizationId,
        row.id,
        row.provider_attempt_id,
        input.resolution,
        exactProviderWriteCount,
        providerReference,
        evidenceHash,
        recordedBy,
      ],
    )
    const outcome = inserted.rows[0]
    const updated = await client.query<AuthorizationRow>(
      `UPDATE operations_shopify_order_management_authorizations
       SET status = 'reconciled', latest_outcome_id = $3::uuid,
           completed_at = $4::timestamptz, updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND status = 'unknown'
       RETURNING *`,
      [scopedOrganizationId, row.id, outcome.id, outcome.recorded_at],
    )
    if (updated.rowCount !== 1) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_RECONCILIATION_CONFLICT',
        'The provider reconciliation could not be committed atomically',
      )
    }
    await recordAuditEvent({
      actor: recordedBy,
      eventType: 'operations.shopify_order_management.reconciled',
      aggregateType: 'operations.shopify_order_management_authorization',
      aggregateId: row.global_id,
      subject: row.order_global_id,
      organizationId: scopedOrganizationId,
      eventKey: `operations:shopify-order-management:${outcome.global_id}:recorded`,
      payload: {
        providerAttemptGlobalId,
        outcomeGlobalId: outcome.global_id,
        accountGlobalId: row.integration_account_global_id,
        orderGlobalId: row.order_global_id,
        externalOrderId: row.external_order_id,
        action: row.action,
        resolution: input.resolution,
        authorizedBy: row.authorized_by,
        reconciledBy: recordedBy,
        evidenceHash,
        providerReference,
        providerWrites: exactProviderWriteCount,
      },
    }, client)
    return authorization({
      ...updated.rows[0],
      provider_attempt_global_id: providerAttemptGlobalId,
      latest_outcome_global_id: outcome.global_id,
      latest_outcome_state: 'reconciled',
      reconciliation_resolution: input.resolution,
      provider_write_count: exactProviderWriteCount,
      provider_reference: providerReference,
      error_code: null,
    })
  })
}

export async function readShopifyOrderManagementHealthFromPostgres(): Promise<
  ShopifyOrderManagementHealth
> {
  const result = await query<{
    prepared: string | number
    processing: string | number
    stale_processing: string | number
    unknown: string | number
    latest_unknown_at: TimestampValue | null
    last_completed_at: TimestampValue | null
    known_provider_write_outcome_count: string | number
    known_provider_write_sum: string | number
  }>(
    `SELECT
       count(*) FILTER (
         WHERE authz.status = 'prepared'
           AND authz.expires_at > clock_timestamp()
       ) AS prepared,
       count(*) FILTER (WHERE authz.status = 'processing') AS processing,
       count(*) FILTER (
         WHERE authz.status = 'processing'
           AND attempt.processing_lease_expires_at <= clock_timestamp()
       ) AS stale_processing,
       count(*) FILTER (WHERE authz.status = 'unknown') AS unknown,
       (
         SELECT max(unknown_outcome.recorded_at)
         FROM operations_shopify_order_management_outcomes unknown_outcome
         WHERE unknown_outcome.outcome_state = 'unknown'
       ) AS latest_unknown_at,
       max(authz.completed_at) FILTER (
         WHERE authz.status IN (
           'succeeded', 'failed', 'unknown', 'reconciled', 'expired'
         )
       ) AS last_completed_at,
       count(outcome.provider_write_count)
         AS known_provider_write_outcome_count,
       COALESCE(sum(outcome.provider_write_count), 0)
         AS known_provider_write_sum
     FROM operations_shopify_order_management_authorizations authz
     LEFT JOIN operations_shopify_order_management_attempts attempt
       ON attempt.organization_id = authz.organization_id
      AND attempt.id = authz.provider_attempt_id
     LEFT JOIN operations_shopify_order_management_outcomes outcome
       ON outcome.organization_id = authz.organization_id
      AND outcome.id = authz.latest_outcome_id`,
  )
  const row = result.rows[0]
  return Object.freeze({
    prepared: Number(row?.prepared || 0),
    processing: Number(row?.processing || 0),
    staleProcessing: Number(row?.stale_processing || 0),
    unknown: Number(row?.unknown || 0),
    latestUnknownAt: iso(row?.latest_unknown_at),
    lastCompletedAt: iso(row?.last_completed_at),
    knownProviderWriteOutcomeCount: Number(
      row?.known_provider_write_outcome_count || 0,
    ),
    knownProviderWriteSum: Number(row?.known_provider_write_sum || 0),
  })
}

export async function readShopifyOrderManagementAuthorizationInPostgres(input: {
  organizationId: unknown
  authorizationGlobalId: unknown
}): Promise<ShopifyOrderManagementAuthorization | null> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const authorizationGlobalId = globalId(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_REQUIRED',
    'A valid Shopify order management authorization is required',
  )
  const result = await query<AuthorizationRow>(
    `${AUTHORIZATION_SELECT}
     WHERE authz.organization_id = $1::uuid
       AND authz.global_id = $2
     LIMIT 1`,
    [scopedOrganizationId, authorizationGlobalId],
  )
  return result.rows[0] ? authorization(result.rows[0]) : null
}

export async function readShopifyOrderManagementAuthorizationByAttemptInPostgres(
  input: {
    organizationId: unknown
    attemptGlobalId: unknown
  },
): Promise<ShopifyOrderManagementAuthorization | null> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const attemptGlobalId = globalId(
    input.attemptGlobalId,
    ATTEMPT_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_REQUIRED',
    'A valid Shopify provider attempt is required',
  )
  const result = await query<AuthorizationRow>(
    `${AUTHORIZATION_SELECT}
     WHERE authz.organization_id = $1::uuid
       AND attempt.global_id = $2
     LIMIT 1`,
    [scopedOrganizationId, attemptGlobalId],
  )
  return result.rows[0] ? authorization(result.rows[0]) : null
}

export async function listShopifyOrderManagementAuthorizationsInPostgres(input: {
  organizationId: unknown
  orderGlobalId?: unknown
  limit?: unknown
}): Promise<ShopifyOrderManagementAuthorization[]> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const orderGlobalId = input.orderGlobalId === undefined
    ? null
    : globalId(
        input.orderGlobalId,
        ORDER_GLOBAL_ID,
        'SHOPIFY_ORDER_MANAGEMENT_ORDER_REQUIRED',
        'A valid Operations order Global ID is required',
      )
  const requestedLimit = input.limit === undefined
    ? 25 : integer(input.limit, 'Order management read limit', 1)
  const limit = Math.min(requestedLimit, 100)
  const result = await query<AuthorizationRow>(
    `${AUTHORIZATION_SELECT}
     WHERE authz.organization_id = $1::uuid
       AND ($2::text IS NULL OR authz.order_global_id = $2)
     ORDER BY authz.prepared_at DESC, authz.id DESC
     LIMIT $3`,
    [scopedOrganizationId, orderGlobalId, limit],
  )
  return result.rows.map((row) => authorization(row))
}

export async function readShopifyOrderManagementTargetInPostgres(input: {
  organizationId: unknown
  orderGlobalId: unknown
}): Promise<ShopifyOrderManagementTarget | null> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const orderGlobalId = globalId(
    input.orderGlobalId,
    ORDER_GLOBAL_ID,
    'SHOPIFY_ORDER_MANAGEMENT_ORDER_REQUIRED',
    'A valid Operations order Global ID is required',
  )
  const result = await query<{
    account_global_id: string
    account_display_name: string
    account_environment: string
    external_account_id: string | null
    shop_domain: string | null
    commerce_credential_generation: number
    credential_current: boolean
    provider_write_control_row_version: string | number
    provider_write_requested_mode: 'off' | 'on'
    provider_write_scope_digest: string | null
    provider_write_binding_current: boolean
    order_global_id: string
    external_order_id: string
    order_number: string
    order_row_version: string | number
    order_status: string
    source_hash: string | null
    accepted_source_hash: string
    accepted_provider_updated_at: TimestampValue | null
    latest_source_hash: string | null
    material_state: string
    latest_observed_at: TimestampValue | null
    latest_provider_updated_at: string | null
    latest_provider_order_test: string | null
    zero_downstream: boolean
    reversible_external_fulfillment_gid: string | null
    reversible_external_fulfillment_updated_at: TimestampValue | null
    fulfillment_reversal_safe: boolean
    post_reversal_order_cancellation_safe: boolean
    predecessor_authorization_global_id: string | null
  }>(
    `SELECT
       account.global_id AS account_global_id,
       account.display_name AS account_display_name,
       account.environment AS account_environment,
       account.external_account_id,
       account.configuration->>'shopDomain' AS shop_domain,
       account.commerce_credential_generation,
       (
         account.provider = 'shopify'
         AND account.integration_type = 'commerce'
         AND account.status = 'active'
         AND account.external_account_id IS NOT NULL
         AND credential.external_account_id = account.external_account_id
         AND credential.credential_version =
               account.commerce_credential_generation
         AND credential.auth_mode = 'shopify_client_credentials'
         AND credential.verification_status = 'verified'
         AND credential.last_error_code IS NULL
       ) AS credential_current,
       provider_control.row_version AS provider_write_control_row_version,
       provider_control.requested_mode AS provider_write_requested_mode,
       provider_control.bound_granted_scope_digest
         AS provider_write_scope_digest,
       (
         provider_control.requested_mode = 'on'
         AND provider_control.row_version > 0
         AND provider_control.bound_credential_generation =
               account.commerce_credential_generation
         AND provider_control.bound_granted_scopes =
               operations_commerce_granted_scope_snapshot(
                 account.configuration
               )
         AND 'write_orders' = ANY(provider_control.bound_granted_scopes)
         AND provider_control.bound_granted_scope_digest =
               operations_commerce_granted_scope_digest(
                 operations_commerce_granted_scope_snapshot(
                   account.configuration
                 )
               )
       ) AS provider_write_binding_current,
       order_row.global_id AS order_global_id,
       order_row.external_order_id,
       order_row.order_number,
       order_row.row_version::text AS order_row_version,
       order_row.status AS order_status,
       order_row.source_payload->>'sourceHash' AS source_hash,
       target.accepted_source_hash,
       operations_shopify_order_management_snapshot_updated_at(
         accepted_observation.normalized_snapshot
       ) AS accepted_provider_updated_at,
       target.latest_source_hash,
       target.material_state,
       COALESCE(latest_read.observed_at, observation.observed_at)
         AS latest_observed_at,
       observation.normalized_snapshot #>> '{order,providerUpdatedAt}'
         AS latest_provider_updated_at,
       observation.normalized_snapshot #>> '{order,providerFacts,testOrder}'
         AS latest_provider_order_test,
       ocr_order_has_zero_downstream(
         order_row.organization_id, order_row.id
       ) AS zero_downstream,
       external_reconciliation.provider_fulfillment_id
         AS reversible_external_fulfillment_gid,
       external_reconciliation.provider_fulfillment_updated_at
         AS reversible_external_fulfillment_updated_at,
       CASE
         WHEN external_reconciliation.id IS NULL THEN false
         ELSE operations_shopify_fulfillment_reversal_is_safe(
           order_row.organization_id,
           order_row.id,
           external_reconciliation.provider_fulfillment_id,
           external_reconciliation.provider_fulfillment_updated_at
         )
       END AS fulfillment_reversal_safe,
       post_reversal_predecessor.global_id
         AS predecessor_authorization_global_id,
       (post_reversal_predecessor.id IS NOT NULL)
         AS post_reversal_order_cancellation_safe
     FROM operations_orders order_row
     JOIN operations_integration_accounts account
       ON account.organization_id = order_row.organization_id
      AND account.id = order_row.integration_account_id
     LEFT JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_commerce_provider_write_control_current provider_control
       ON provider_control.organization_id = account.organization_id
      AND provider_control.integration_account_id = account.id
     JOIN operations_commerce_order_revision_targets target
       ON target.organization_id = order_row.organization_id
      AND target.order_id = order_row.id
     LEFT JOIN operations_commerce_order_revision_observations observation
       ON observation.organization_id = target.organization_id
      AND observation.id = target.latest_observation_id
     LEFT JOIN operations_commerce_order_revision_observations
       accepted_observation
       ON accepted_observation.organization_id = target.organization_id
      AND accepted_observation.id = target.accepted_observation_id
      AND accepted_observation.integration_account_id =
            target.integration_account_id
      AND accepted_observation.target_id = target.id
      AND accepted_observation.order_id = target.order_id
      AND accepted_observation.provider = target.provider
      AND accepted_observation.external_order_id = order_row.external_order_id
      AND accepted_observation.source_hash = target.accepted_source_hash
      AND accepted_observation.canonical_row_version = order_row.row_version
     LEFT JOIN operations_commerce_order_revision_reads latest_read
       ON latest_read.organization_id = target.organization_id
      AND latest_read.id = target.latest_read_id
     LEFT JOIN operations_shopify_external_fulfillment_reconciliations
       external_reconciliation
       ON external_reconciliation.organization_id = order_row.organization_id
      AND external_reconciliation.order_id = order_row.id
     LEFT JOIN LATERAL (
       SELECT candidate.id, candidate.global_id
       FROM operations_shopify_order_management_authorizations candidate
       WHERE candidate.organization_id = order_row.organization_id
         AND candidate.order_id = order_row.id
         AND candidate.integration_account_id = account.id
         AND candidate.external_order_id = order_row.external_order_id
         AND candidate.action = 'cancel_fulfillment'
         AND operations_shopify_post_reversal_order_cancellation_is_safe(
               order_row.organization_id,
               order_row.id,
               candidate.id
             )
       ORDER BY candidate.completed_at DESC, candidate.id DESC
       LIMIT 1
     ) post_reversal_predecessor ON true
     WHERE order_row.organization_id = $1::uuid
       AND order_row.global_id = $2
       AND order_row.source_provider = 'shopify'
       AND account.provider = 'shopify'
       AND account.integration_type = 'commerce'
     LIMIT 1`,
    [scopedOrganizationId, orderGlobalId],
  )
  const row = result.rows[0]
  if (!row) return null
  const latestOpen = await query<AuthorizationRow>(
    `${AUTHORIZATION_SELECT}
     WHERE authz.organization_id = $1::uuid
       AND authz.order_global_id = $2
       AND (
         authz.status IN ('processing', 'unknown')
         OR (
           authz.status = 'prepared'
           AND authz.expires_at > clock_timestamp()
         )
       )
     ORDER BY authz.prepared_at DESC, authz.id DESC
     LIMIT 1`,
    [scopedOrganizationId, orderGlobalId],
  )
  const providerUpdatedAtDate = row.latest_provider_updated_at
    ? new Date(row.latest_provider_updated_at)
    : null
  const providerUpdatedAt = providerUpdatedAtDate
    && Number.isFinite(providerUpdatedAtDate.getTime())
    ? providerUpdatedAtDate.toISOString()
    : null
  const providerOrderTest = row.latest_provider_order_test === 'true'
    ? true
    : row.latest_provider_order_test === 'false' ? false : null
  return {
    organizationId: scopedOrganizationId,
    accountGlobalId: row.account_global_id,
    accountDisplayName: row.account_display_name,
    accountEnvironment: row.account_environment,
    externalAccountId: row.external_account_id,
    shopDomain: row.shop_domain,
    credentialGeneration: Number(row.commerce_credential_generation),
    credentialCurrent: row.credential_current === true,
    providerWriteControlRowVersion: Number(
      row.provider_write_control_row_version,
    ),
    providerWriteRequestedMode: row.provider_write_requested_mode,
    providerWriteBindingCurrent:
      row.provider_write_binding_current === true,
    providerWriteScopeDigest: row.provider_write_scope_digest,
    orderGlobalId: row.order_global_id,
    externalOrderId: row.external_order_id,
    orderNumber: row.order_number,
    orderRowVersion: Number(row.order_row_version),
    orderStatus: row.order_status,
    sourceHash: row.source_hash,
    acceptedSourceHash: row.accepted_source_hash,
    acceptedProviderUpdatedAt: iso(row.accepted_provider_updated_at),
    latestSourceHash: row.latest_source_hash,
    materialState: row.material_state,
    latestObservedAt: iso(row.latest_observed_at),
    latestProviderUpdatedAt: providerUpdatedAt,
    latestProviderOrderTest: providerOrderTest,
    zeroDownstream: row.zero_downstream === true,
    reversibleExternalFulfillmentGid:
      row.reversible_external_fulfillment_gid,
    reversibleExternalFulfillmentUpdatedAt:
      iso(row.reversible_external_fulfillment_updated_at),
    fulfillmentReversalSafe: row.fulfillment_reversal_safe === true,
    postReversalOrderCancellationSafe:
      row.post_reversal_order_cancellation_safe === true,
    postReversalOrderCancellationPredecessorGlobalId:
      row.predecessor_authorization_global_id,
    latestOpenAuthorization: latestOpen.rows[0]
      ? authorization(latestOpen.rows[0]) : null,
  }
}
