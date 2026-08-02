import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  normalizeShopifyCheckoutPlanRatePolicy,
  type ShopifyCheckoutPlanRatePolicy,
} from '@/lib/operations/shopifyCheckoutPlanRatePolicy'
import {
  normalizeShopifyCheckoutRateWarmPolicy,
  type ShopifyCheckoutRateWarmPolicy,
} from '@/lib/operations/shopifyCheckoutRateWarmPolicy'
import {
  acquireTransactionAdvisoryLock,
  getPostgresPool,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

export const MAX_SHOPIFY_CHECKOUT_MATERIALS = 8
export const MAX_SHOPIFY_CHECKOUT_LINES = 500
export const MAX_SHOPIFY_CHECKOUT_PACKAGES = 50
export const MAX_SHOPIFY_CHECKOUT_OFFERS = 100
export const MAX_SHOPIFY_CHECKOUT_PROVIDER_ATTEMPTS = 2
export const SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION =
  'shopify-checkout-line-pack-evidence-v1' as const
export const SHOPIFY_CHECKOUT_RECEIPT_PACKAGE_LEVELS = [
  'each',
  'inner_pack',
  'case',
  'pallet',
] as const
const SHOPIFY_CHECKOUT_PERSISTENCE_STATEMENT_TIMEOUT_MS = 500
const SHOPIFY_CHECKOUT_CLAIM_STATEMENT_TIMEOUT_MS = 750
const SHOPIFY_CHECKOUT_RECEIPT_CLAIM_MAX_ATTEMPTS = 2
const SHOPIFY_CHECKOUT_TRANSIENT_CLAIM_SQLSTATES = new Set([
  '40001',
  '40P01',
  '55P03',
])

export type ShopifyCheckoutCarrierProvider = 'ups_rest' | 'fedex_rest'
export type ShopifyCarrierServiceRegistrationState =
  | 'unconfigured'
  | 'shadow_simulated'
  | 'registered'
  | 'disabled'
  | 'error'
export type ShopifyCheckoutRateReceiptStatus =
  | 'processing'
  | 'succeeded'
  | 'failed'

type TimestampValue = string | Date

export class ShopifyCheckoutRatingPersistenceError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export type ShopifyCarrierServiceConfigWriteInput = {
  organizationId: string
  accountGlobalId: string
  expectedRowVersion?: number | null
  credentialGeneration: number
  activationRevision: number
  callbackTokenVersion: number
  callbackTokenHash: string
  policyRevision: number
  policyHash: string
  policySnapshot: Record<string, unknown>
  warehouseGlobalId: string
  materials: Array<{
    materialGlobalId: string
    expectedRowVersion: number
  }>
  carriers: Array<{
    provider: ShopifyCheckoutCarrierProvider
    carrierAccountGlobalId: string
  }>
  inventoryMaxAgeSeconds: number
  quoteTtlSeconds: number
  orderReconciliationWindowSeconds: number
  algorithmVersion: string
  actorEmail: string
}

export type NormalizedShopifyCarrierServiceConfigInput =
  Omit<
    ShopifyCarrierServiceConfigWriteInput,
    'expectedRowVersion' | 'materials'
  > & {
    expectedRowVersion: number | null
    materials: Array<{
      selectionSequence: number
      materialGlobalId: string
      expectedRowVersion: number
    }>
  }

export type ShopifyCarrierServicePlanRatePolicyWriteInput = {
  organizationId: string
  accountGlobalId: string
  expectedRowVersion: number
  planRateOptimization: ShopifyCheckoutPlanRatePolicy
  actorEmail: string
}

export type ShopifyCarrierServiceRateWarmPolicyWriteInput = {
  organizationId: string
  accountGlobalId: string
  expectedRowVersion: number
  checkoutRateWarm: ShopifyCheckoutRateWarmPolicy
  actorEmail: string
}

export type ShopifyCarrierServiceConfig = {
  id: string
  globalId: string
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  accountEnvironment: 'mock' | 'sandbox' | 'production'
  accountStatus: 'active' | 'disabled' | 'error'
  warehouseId: string
  warehouseGlobalId: string
  warehouseName: string
  checkoutBrandNameOverride: string | null
  registeredServiceName: string | null
  serviceGid: string | null
  registrationState: ShopifyCarrierServiceRegistrationState
  credentialGeneration: number
  activationRevision: number
  callbackTokenVersion: number
  policyRevision: number
  policyHash: string
  policySnapshot: Record<string, unknown>
  inventoryMaxAgeSeconds: number
  quoteTtlSeconds: number
  orderReconciliationWindowSeconds: number
  algorithmVersion: string
  lastErrorCode: string | null
  rowVersion: number
  ready: boolean
  materials: ShopifyCheckoutRatingMaterial[]
  carriers: ShopifyCheckoutRatingCarrierBinding[]
  createdAt: string
  updatedAt: string
}

export type ShopifyCheckoutRatingMaterial = {
  selectionSequence: number
  materialId: string
  materialGlobalId: string
  materialCode: string
  materialName: string
  expectedRowVersion: number
  currentRowVersion: number
  ratedOuterDimensionsMm: {
    length: number | null
    width: number | null
    height: number | null
  }
  tareWeightGrams: number | null
  maxWeightGrams: number | null
  evidenceType: string | null
  evidenceReference: string | null
  evidenceConfirmedAt: string | null
  stockGlobalId: string | null
  stockRowVersion: number | null
  stockAvailable: boolean
  stockOnHandQuantity: number | null
}

export type ShopifyCheckoutRatingCarrierBinding = {
  provider: ShopifyCheckoutCarrierProvider
  carrierAccountId: string
  carrierAccountGlobalId: string
  credentialVersion: number
  displayName: string
  accountStatus: 'needs_configuration' | 'active' | 'disabled'
  integrationStatus: 'active' | 'disabled' | 'error'
  environment: 'mock' | 'sandbox' | 'production'
}

export type ShopifyCheckoutRatingAccount = {
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  storeEntityName: string
  environment: 'mock' | 'sandbox' | 'production'
  externalAccountId: string
  registrationState: 'shadow_simulated' | 'registered'
  configGlobalId: string
  configRowVersion: number
  credentialGeneration: number
  registrationActivationRevision: number
  activationState: 'shadow' | 'active'
  activationRevision: number
  callbackTokenVersion: number
  policyRevision: number
  policyHash: string
  policySnapshot: Record<string, unknown>
  warehouseId: string
  warehouseGlobalId: string
  warehouseName: string
  warehouseTimezone: string
  warehouseAddress: Record<string, unknown>
  inventoryMaxAgeSeconds: number
  quoteTtlSeconds: number
  orderReconciliationWindowSeconds: number
  algorithmVersion: string
  materials: ShopifyCheckoutRatingMaterial[]
  carriers: ShopifyCheckoutRatingCarrierBinding[]
}

export type ShopifyCheckoutReceiptLineSnapshotV1 = {
  snapshotVersion: typeof SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION
  productGid: string
  variantGid: string
  productGlobalId: string
  packMappingGlobalId: string
  packMappingRowVersion: number
  packEvidenceHash: string
  packProfileVersionGlobalId: string
  packProfileVersionRowVersion: number
  packageLevel: typeof SHOPIFY_CHECKOUT_RECEIPT_PACKAGE_LEVELS[number]
  baseEachQuantity: number
  shipsAsOwnPackage: boolean
  inventoryLevelGlobalIds: string[]
  quantity: number
  unitWeightGrams: number
}

export type ShopifyCheckoutReceiptLineInput = {
  lineKey: string
  providerVariantId: string
  sku?: string | null
  quantity: number
  unitWeightGrams: number
  requiresShipping: boolean
  lineSnapshot: ShopifyCheckoutReceiptLineSnapshotV1
}

export type ShopifyCheckoutReceiptClaimInput = {
  organizationId: string
  accountGlobalId: string
  expectedConfigRowVersion: number
  expectedActivationState: 'shadow' | 'active'
  expectedActivationRevision: number
  requestFingerprint: string
  destinationFingerprint: string
  carrierDestinationFingerprint: string
  redactedRequestSnapshot: Record<string, unknown>
  currency: string
  cacheKey?: string
  idempotencyKey: string
  inventorySnapshotHash: string
  inventorySnapshotAt: string
  claimedBy: string
  leaseSeconds?: number
  deadlineAt?: string | Date | null
  signal?: AbortSignal
  lines: ShopifyCheckoutReceiptLineInput[]
}

export type NormalizedShopifyCheckoutReceiptLine =
  ShopifyCheckoutReceiptLineInput & {
    sku: string | null
    lineHash: string
  }

export type NormalizedShopifyCheckoutReceiptClaimInput =
  Omit<
    ShopifyCheckoutReceiptClaimInput,
    'cacheKey' | 'leaseSeconds' | 'lines'
  > & {
    cacheKey: string
    leaseSeconds: number
    deadlineAt: string | null
    requestEvidenceHash: string
    lineQuantityFingerprint: string
    lines: NormalizedShopifyCheckoutReceiptLine[]
  }

type ShopifyCheckoutPackageInputBase = {
  packageKey: string
  packageSequence: number
  ratedOuterDimensionsMm: {
    length: number
    width: number
    height: number
  }
  contentWeightGrams: number
  tareWeightGrams: number
  allocations: Array<{
    lineKey: string
    quantity: number
  }>
  packageSnapshot: Record<string, unknown>
}

export type ShopifyCheckoutPackageInput =
  | ShopifyCheckoutPackageInputBase & {
      planningMethod?: 'approved_recipe'
      materialGlobalId: string
      materialRowVersion: number
      materialStockGlobalId: string
      materialStockRowVersion: number
      materialStockOnHandQuantity: number
      packProfileVersionGlobalId?: never
      packProfileVersionRowVersion?: never
      selfPackageLineKey?: never
    }
  | ShopifyCheckoutPackageInputBase & {
      planningMethod: 'self_package'
      materialGlobalId?: never
      materialRowVersion?: never
      materialStockGlobalId?: never
      materialStockRowVersion?: never
      materialStockOnHandQuantity?: never
      packProfileVersionGlobalId: string
      packProfileVersionRowVersion: number
      selfPackageLineKey: string
    }

export type ShopifyCheckoutOfferInput = {
  provider: ShopifyCheckoutCarrierProvider
  carrierAccountGlobalId: string
  rateEvidenceGlobalId: string
  shopifyServiceCode: string
  serviceCode: string
  serviceName: string
  carrierCostMinor: number
  customerChargeMinor: number
  subsidyReason?: string | null
  currency: string
  minDeliveryDate?: string | null
  maxDeliveryDate?: string | null
  offerSnapshot: Record<string, unknown>
}

export type ShopifyCheckoutProviderAttemptInput = {
  provider: ShopifyCheckoutCarrierProvider
  carrierAccountGlobalId: string
  rateEvidenceGlobalId: string
  status: 'succeeded' | 'degraded'
  failureCode: string | null
  attemptSnapshot: Record<string, unknown>
}

export type CompleteShopifyCheckoutRateReceiptInput = {
  organizationId: string
  receiptGlobalId: string
  leaseToken: string
  packagePlanHash: string
  resultSnapshot: Record<string, unknown>
  deadlineAt?: string | Date | null
  packages: ShopifyCheckoutPackageInput[]
  providerAttempts: ShopifyCheckoutProviderAttemptInput[]
  offers: ShopifyCheckoutOfferInput[]
}

export type ShopifyCheckoutRateReceiptLine = {
  lineKey: string
  providerVariantId: string
  sku: string | null
  quantity: number
  unitWeightGrams: number
  requiresShipping: boolean
  lineHash: string
  lineSnapshot: Record<string, unknown>
  snapshotVersion:
    typeof SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION | null
  packEvidenceHash: string | null
}

type ShopifyCheckoutRateReceiptPackageBase = {
  packageKey: string
  packageSequence: number
  ratedOuterDimensionsMm: {
    length: number
    width: number
    height: number
  }
  contentWeightGrams: number
  tareWeightGrams: number
  grossWeightGrams: number
  carrierParcelSnapshot: Record<string, unknown>
  packageHash: string
  packageSnapshot: Record<string, unknown>
  allocations: Array<{
    lineKey: string
    quantity: number
    allocationHash: string
  }>
}

export type ShopifyCheckoutRateReceiptPackage =
  | ShopifyCheckoutRateReceiptPackageBase & {
      planningMethod: 'approved_recipe'
      materialGlobalId: string
      materialRowVersion: number
      materialStockGlobalId: string
      materialStockRowVersion: number
      materialStockOnHandQuantity: number
      packProfileVersionGlobalId: null
      packProfileVersionRowVersion: null
      selfPackageLineKey: null
    }
  | ShopifyCheckoutRateReceiptPackageBase & {
      planningMethod: 'self_package'
      materialGlobalId: null
      materialRowVersion: null
      materialStockGlobalId: null
      materialStockRowVersion: null
      materialStockOnHandQuantity: null
      packProfileVersionGlobalId: string
      packProfileVersionRowVersion: number
      selfPackageLineKey: string
    }

export type ShopifyCheckoutRateReceiptOffer = {
  provider: ShopifyCheckoutCarrierProvider
  carrierAccountGlobalId: string
  credentialVersion: number
  rateEvidenceGlobalId: string
  carrierRequestHash: string
  carrierResponseRateHash: string
  shopifyServiceCode: string
  serviceCode: string
  serviceName: string
  carrierCostMinor: number
  customerChargeMinor: number
  checkoutAdjustmentMinor: number
  checkoutAdjustmentKind: 'none' | 'subsidy'
  checkoutAdjustmentReason: string | null
  currency: string
  packageCount: number
  packagePlanHash: string
  minDeliveryDate: string | null
  maxDeliveryDate: string | null
  offerHash: string
  offerSnapshot: Record<string, unknown>
}

export type ShopifyCheckoutRateReceiptProviderAttempt = {
  provider: ShopifyCheckoutCarrierProvider
  carrierAccountGlobalId: string
  credentialVersion: number
  rateEvidenceGlobalId: string
  carrierRequestHash: string
  status: 'succeeded' | 'degraded'
  failureCode: string | null
  attemptHash: string
  attemptSnapshot: Record<string, unknown>
}

export type ShopifyCheckoutRateReceipt = {
  id: string
  globalId: string
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  configId: string
  configGlobalId: string
  configRowVersion: number
  credentialGeneration: number
  activationState: 'shadow' | 'active'
  activationRevision: number
  policyRevision: number
  policyHash: string
  warehouseId: string
  warehouseGlobalId: string
  algorithmVersion: string
  requestFingerprint: string
  destinationFingerprint: string
  carrierDestinationFingerprint: string
  lineQuantityFingerprint: string
  requestEvidenceHash: string
  redactedRequestSnapshot: Record<string, unknown>
  currency: string
  idempotencyKey: string
  status: ShopifyCheckoutRateReceiptStatus
  leaseToken: string | null
  leaseExpiresAt: string | null
  claimedBy: string | null
  attemptCount: number
  packagePlanHash: string | null
  resultHash: string | null
  resultSnapshot: Record<string, unknown> | null
  errorCode: string | null
  providerWriteCount: 0
  inventorySnapshotHash: string
  inventorySnapshotAt: string
  inventoryRefreshVersion: number
  reconciliationWindowSeconds: number
  reconciliationDeadlineAt: string
  expiresAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  lines: ShopifyCheckoutRateReceiptLine[]
  packages: ShopifyCheckoutRateReceiptPackage[]
  providerAttempts: ShopifyCheckoutRateReceiptProviderAttempt[]
  offers: ShopifyCheckoutRateReceiptOffer[]
}

export type ShopifyCheckoutRateReceiptClaim =
  | {
      kind: 'claimed'
      receiptGlobalId: string
      leaseToken: string
    }
  | {
      kind: 'in_progress' | 'cached' | 'idempotent_replay'
      receipt: ShopifyCheckoutRateReceipt
    }

export type ShopifyCheckoutRateReconciliation = {
  globalId: string
  supersedesReconciliationGlobalId: string | null
  accountGlobalId: string
  orderCandidateGlobalId: string
  receiptGlobalId: string | null
  orderGlobalId: string
  sourceExternalOrderId: string
  sourceOrderCreatedAt: string | null
  sourceLineQuantityFingerprint: string | null
  sourceDestinationFingerprint: string | null
  sourceCurrency: string
  sourceShippingChargeMinor: number | null
  sourceShopifyServiceCode: string | null
  candidateSetHash: string
  selectedCarrierAccountGlobalId: string | null
  selectedRateEvidenceGlobalId: string | null
  selectedCarrierProvider: ShopifyCheckoutCarrierProvider | null
  selectedServiceCode: string | null
  selectedOfferHash: string | null
  selectedCustomerChargeMinor: number | null
  selectedCurrency: string | null
  outcome: ShopifyCheckoutRateReconciliationOutcome
  matchMethod: string
  candidateCount: number
  matchEvidence: Record<string, unknown>
  idempotencyKey: string
  providerWriteCount: 0
  createdBy: string | null
  createdAt: string
}

export type ShopifyCheckoutRateReconciliationOutcome =
  | 'matched'
  | 'ambiguous'
  | 'rejected'
  | 'expired'

export function classifyShopifyCheckoutRateReconciliationOutcome(input: {
  exactCandidateCount: number
  potentialCandidateCount: number
}): ShopifyCheckoutRateReconciliationOutcome {
  if (
    !Number.isSafeInteger(input.exactCandidateCount)
    || input.exactCandidateCount < 0
    || !Number.isSafeInteger(input.potentialCandidateCount)
    || input.potentialCandidateCount < input.exactCandidateCount
  ) {
    throw new ShopifyCheckoutRatingPersistenceError(
      'SHOPIFY_CHECKOUT_RECONCILIATION_COUNTS_INVALID',
      'Shopify checkout reconciliation candidate counts are invalid',
      500,
    )
  }
  if (input.exactCandidateCount === 1) return 'matched'
  if (input.exactCandidateCount > 1) return 'ambiguous'
  return input.potentialCandidateCount > 0 ? 'expired' : 'rejected'
}

export function shopifyCheckoutRateOutcomeAllowsFulfillment(
  outcome: ShopifyCheckoutRateReconciliationOutcome | null | undefined,
) {
  return outcome === 'matched'
}

type ConfigRow = QueryResultRow & {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  account_global_id: string
  account_environment: 'mock' | 'sandbox' | 'production'
  account_status: 'active' | 'disabled' | 'error'
  warehouse_id: string
  warehouse_global_id: string
  warehouse_name: string
  checkout_brand_name_override: string | null
  registered_service_name: string | null
  service_gid: string | null
  registration_state: ShopifyCarrierServiceRegistrationState
  credential_generation: number
  activation_revision: number
  callback_token_version: number
  policy_revision: string | number
  policy_hash: string
  policy_snapshot: Record<string, unknown>
  inventory_max_age_seconds: number
  quote_ttl_seconds: number
  order_reconciliation_window_seconds: number
  algorithm_version: string
  last_error_code: string | null
  row_version: string | number
  ready: boolean
  created_at: TimestampValue
  updated_at: TimestampValue
}

type MaterialRow = QueryResultRow & {
  selection_sequence: number
  material_id: string
  material_global_id: string
  material_code: string
  material_name: string
  expected_row_version: string | number
  current_row_version: string | number
  rated_outer_length_mm: number | null
  rated_outer_width_mm: number | null
  rated_outer_height_mm: number | null
  tare_weight_grams: number | null
  max_weight_grams: number | null
  evidence_type: string | null
  evidence_reference: string | null
  evidence_confirmed_at: TimestampValue | null
  stock_global_id: string | null
  stock_row_version: string | number | null
  stock_available: boolean | null
  stock_on_hand_quantity: number | null
}

type CarrierBindingRow = QueryResultRow & {
  carrier_provider: ShopifyCheckoutCarrierProvider
  carrier_account_id: string
  carrier_account_global_id: string
  credential_version: number
  display_name: string
  account_status: 'needs_configuration' | 'active' | 'disabled'
  integration_status: 'active' | 'disabled' | 'error'
  environment: 'mock' | 'sandbox' | 'production'
}

type CallbackAccountRow = QueryResultRow & {
  organization_id: string
  integration_account_id: string
  account_global_id: string
  store_entity_name: string
  environment: 'mock' | 'sandbox' | 'production'
  external_account_id: string
  registration_state: 'shadow_simulated' | 'registered'
  config_id: string
  config_global_id: string
  config_row_version: string | number
  credential_generation: number
  registration_activation_revision: number
  activation_state: 'shadow' | 'active'
  activation_revision: number
  callback_token_version: number
  policy_revision: string | number
  policy_hash: string
  policy_snapshot: Record<string, unknown>
  warehouse_id: string
  warehouse_global_id: string
  warehouse_name: string
  warehouse_timezone: string
  warehouse_address: Record<string, unknown>
  inventory_max_age_seconds: number
  quote_ttl_seconds: number
  order_reconciliation_window_seconds: number
  algorithm_version: string
}

type ReceiptRow = QueryResultRow & {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  account_global_id: string
  config_id: string
  config_global_id: string
  config_row_version: string | number
  credential_generation: number
  activation_state: 'shadow' | 'active'
  activation_revision: number
  policy_revision: string | number
  policy_hash: string
  warehouse_id: string
  warehouse_global_id: string
  algorithm_version: string
  request_fingerprint: string
  destination_fingerprint: string
  carrier_destination_fingerprint: string
  line_quantity_fingerprint: string
  request_evidence_hash: string
  redacted_request_snapshot: Record<string, unknown>
  currency: string
  idempotency_key: string
  status: ShopifyCheckoutRateReceiptStatus
  lease_token: string | null
  lease_expires_at: TimestampValue | null
  claimed_by: string | null
  attempt_count: number
  package_plan_hash: string | null
  result_hash: string | null
  result_snapshot: Record<string, unknown> | null
  error_code: string | null
  provider_write_count: 0
  inventory_snapshot_hash: string
  inventory_snapshot_at: TimestampValue
  inventory_refresh_version: string | number
  reconciliation_window_seconds: number
  reconciliation_deadline_at: TimestampValue
  expires_at: TimestampValue | null
  completed_at: TimestampValue | null
  created_at: TimestampValue
  updated_at: TimestampValue
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const RECEIPT_GLOBAL_ID = /^gsqr(?:[0-9]{7}|[0-9a-v]{12})$/
const WAREHOUSE_GLOBAL_ID = /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/
const MATERIAL_GLOBAL_ID = /^gmat(?:[0-9]{7}|[0-9a-v]{12})$/
const PACKAGING_STOCK_GLOBAL_ID = /^gmas(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCT_GLOBAL_ID = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/
const PACK_MAPPING_GLOBAL_ID = /^gcvm(?:[0-9]{7}|[0-9a-v]{12})$/
const PACK_PROFILE_VERSION_GLOBAL_ID = /^gppv(?:[0-9]{7}|[0-9a-v]{12})$/
const INVENTORY_LEVEL_GLOBAL_ID = /^giil(?:[0-9]{7}|[0-9a-v]{12})$/
const CARRIER_ACCOUNT_GLOBAL_ID = /^gac(?:[0-9]{7}|[0-9a-v]{12})$/
const RATE_EVIDENCE_GLOBAL_ID = /^grq(?:[0-9]{7}|[0-9a-v]{12})$/
const ORDER_CANDIDATE_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/
const SHOPIFY_PRODUCT_GID = /^gid:\/\/shopify\/Product\/[0-9]+$/
const SHOPIFY_PRODUCT_VARIANT_GID =
  /^gid:\/\/shopify\/ProductVariant\/[0-9]+$/
const SHOPIFY_RATE_SERVICE_CODE =
  /^clawpilot:(ups|fedex):[A-Za-z0-9][A-Za-z0-9._-]{0,56}$/
const SHOPIFY_SERVICE_GID =
  /^gid:\/\/shopify\/DeliveryCarrierService\/[0-9]+$/

export function shopifyCheckoutRateLineageIsRequired(
  serviceCode: string | null | undefined,
) {
  return typeof serviceCode === 'string'
    && SHOPIFY_RATE_SERVICE_CODE.test(serviceCode.trim())
}

const CUSTOMER_OR_SECRET_KEYS = new Set([
  'authorization',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'secret',
  'secretid',
  'password',
  'apikey',
  'privatekey',
  'xshopifyaccesstoken',
  'email',
  'customeremail',
  'recipientemail',
  'contactemail',
  'shippingemail',
  'phone',
  'customerphone',
  'recipientphone',
  'contactphone',
  'shippingphone',
  'name',
  'firstname',
  'lastname',
  'company',
  'customer',
  'customerid',
  'address',
  'address1',
  'address2',
  'line1',
  'line2',
  'city',
  'region',
  'province',
  'state',
  'postalcode',
  'zipcode',
  'zip',
  'country',
  'countrycode',
  'latitude',
  'longitude',
])

function fail(code: string, message: string, status = 400): never {
  throw new ShopifyCheckoutRatingPersistenceError(code, message, status)
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    fail(
      'SHOPIFY_CHECKOUT_INTEGER_INVALID',
      `${label} must be an integer between ${minimum} and ${maximum}`,
    )
  }
  return parsed
}

function textValue(value: unknown, label: string, max: number) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < 1
    || normalized.length > max
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail(
      'SHOPIFY_CHECKOUT_TEXT_INVALID',
      `${label} is missing or invalid`,
    )
  }
  return normalized
}

function matchValue(
  value: unknown,
  pattern: RegExp,
  label: string,
) {
  const normalized = textValue(value, label, 512)
  if (!pattern.test(normalized)) {
    fail(
      'SHOPIFY_CHECKOUT_IDENTIFIER_INVALID',
      `${label} is invalid`,
    )
  }
  return normalized
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function optionalDeadline(
  value: string | Date | null | undefined,
  label: string,
) {
  if (value === undefined || value === null) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) {
    fail(
      'SHOPIFY_CHECKOUT_DEADLINE_INVALID',
      `${label} is invalid`,
    )
  }
  return parsed.toISOString()
}

function requirePersistenceDeadline(deadlineAt: string) {
  if (Date.now() >= Date.parse(deadlineAt)) {
    fail(
      'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED',
      'Shopify checkout persistence exceeded the callback deadline',
      504,
    )
  }
}

function requirePersistenceAvailable(
  deadlineAt: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    fail(
      'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED',
      'Shopify checkout persistence was cancelled',
      504,
    )
  }
  requirePersistenceDeadline(deadlineAt)
}

function deadlineFencedClient(
  client: PoolClient,
  deadlineAt: string,
  signal?: AbortSignal,
): PoolClient {
  return new Proxy(client, {
    get(target, property) {
      if (property !== 'query') return Reflect.get(target, property, target)
      return (...args: unknown[]) => {
        requirePersistenceAvailable(deadlineAt, signal)
        return Reflect.apply(target.query, target, args)
      }
    },
  }) as PoolClient
}

async function configureCheckoutStatementTimeout(input: {
  client: PoolClient
  deadlineAt: string
  maximumMs: number
  signal?: AbortSignal
  commitBufferMs?: number
}) {
  requirePersistenceAvailable(input.deadlineAt, input.signal)
  const remainingMs = Date.parse(input.deadlineAt) - Date.now()
    - (input.commitBufferMs ?? 0)
  if (remainingMs < 1) {
    requirePersistenceAvailable(input.deadlineAt, input.signal)
    fail(
      'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED',
      'Shopify checkout persistence exceeded the callback deadline',
      504,
    )
  }
  await input.client.query(
    `SELECT set_config('statement_timeout', $1, true)`,
    [`${Math.max(1, Math.min(remainingMs, input.maximumMs))}ms`],
  )
  requirePersistenceAvailable(input.deadlineAt, input.signal)
}

async function acquireShopifyCheckoutClient(
  deadlineAt: string,
  signal?: AbortSignal,
) {
  requirePersistenceAvailable(deadlineAt, signal)
  const connection = getPostgresPool().connect()
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null
  let abortListener: (() => void) | null = null
  const fence = new Promise<null>((resolve) => {
    const remainingMs = Math.max(1, Date.parse(deadlineAt) - Date.now())
    deadlineTimer = setTimeout(() => resolve(null), remainingMs)
    if (signal) {
      abortListener = () => resolve(null)
      signal.addEventListener('abort', abortListener, { once: true })
    }
  })
  try {
    const client = await Promise.race([connection, fence])
    if (client === null) {
      void connection.then((lateClient) => lateClient.release()).catch(() => null)
      requirePersistenceAvailable(deadlineAt, signal)
      fail(
        'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED',
        'Shopify checkout persistence exceeded the callback deadline',
        504,
      )
    }
    try {
      requirePersistenceAvailable(deadlineAt, signal)
    } catch (error) {
      client.release()
      throw error
    }
    return client
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer)
    if (signal && abortListener) {
      signal.removeEventListener('abort', abortListener)
    }
  }
}

async function withShopifyCheckoutDeadlineTransaction<T>(
  deadlineAt: string | null,
  callback: (client: PoolClient) => Promise<T>,
  options?: {
    signal?: AbortSignal
    statementTimeoutMs?: number
  },
) {
  if (!deadlineAt) return withTransaction(callback)
  const client = await acquireShopifyCheckoutClient(
    deadlineAt,
    options?.signal,
  )
  let transactionStarted = false
  let transactionCommitted = false
  try {
    requirePersistenceAvailable(deadlineAt, options?.signal)
    await client.query('BEGIN')
    transactionStarted = true
    requirePersistenceAvailable(deadlineAt, options?.signal)
    await configureCheckoutStatementTimeout({
      client,
      deadlineAt,
      maximumMs: options?.statementTimeoutMs
        ?? SHOPIFY_CHECKOUT_PERSISTENCE_STATEMENT_TIMEOUT_MS,
      signal: options?.signal,
    })
    const result = await callback(deadlineFencedClient(
      client,
      deadlineAt,
      options?.signal,
    ))
    requirePersistenceAvailable(deadlineAt, options?.signal)
    const deadline = await client.query<{ within_deadline: boolean }>(
      `SELECT clock_timestamp() < $1::timestamptz AS within_deadline`,
      [deadlineAt],
    )
    if (deadline.rows[0]?.within_deadline !== true) {
      fail(
        'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED',
        'Shopify checkout persistence exceeded the callback deadline',
        504,
      )
    }
    await configureCheckoutStatementTimeout({
      client,
      deadlineAt,
      maximumMs: options?.statementTimeoutMs
        ?? SHOPIFY_CHECKOUT_PERSISTENCE_STATEMENT_TIMEOUT_MS,
      signal: options?.signal,
      commitBufferMs: 25,
    })
    await client.query('COMMIT')
    transactionCommitted = true
    return result
  } catch (error) {
    if (transactionStarted && !transactionCommitted) {
      await client.query('ROLLBACK').catch(() => null)
    }
    requirePersistenceAvailable(deadlineAt, options?.signal)
    throw error
  } finally {
    client.release()
  }
}

function postgresSqlState(error: unknown) {
  const candidate = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : null
  return typeof candidate === 'string' && /^[0-9A-Z]{5}$/.test(candidate)
    ? candidate
    : null
}

function locallyTimedOutShopifyCheckoutStatement(error: unknown) {
  const message = error && typeof error === 'object'
    ? (error as { message?: unknown }).message
    : null
  return postgresSqlState(error) === '57014'
    && message === 'canceling statement due to statement timeout'
}

export function shopifyCheckoutReceiptClaimRetryDisposition(input: {
  error: unknown
  attempt: number
  deadlineAt: string | null
  nowMs?: number
}) {
  if (
    input.deadlineAt
    && (input.nowMs ?? Date.now()) >= Date.parse(input.deadlineAt)
  ) {
    return {
      retry: false,
      reasonCode: 'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED',
      message: 'Shopify checkout persistence exceeded the callback deadline',
      status: 504,
    } as const
  }
  const sqlState = postgresSqlState(input.error)
  if (
    (
      sqlState !== null
      && SHOPIFY_CHECKOUT_TRANSIENT_CLAIM_SQLSTATES.has(sqlState)
    )
    || locallyTimedOutShopifyCheckoutStatement(input.error)
  ) {
    if (
      input.attempt < SHOPIFY_CHECKOUT_RECEIPT_CLAIM_MAX_ATTEMPTS
    ) {
      return {
        retry: true,
        reasonCode: null,
        message: null,
        status: null,
      } as const
    }
  }
  if (locallyTimedOutShopifyCheckoutStatement(input.error)) {
    return {
      retry: false,
      reasonCode: 'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_DB_TIMEOUT',
      message: 'Shopify checkout receipt claim timed out',
      status: 503,
    } as const
  }
  if (sqlState === '57014') {
    return {
      retry: false,
      reasonCode: 'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_CANCELLED',
      message: 'Shopify checkout receipt claim was cancelled',
      status: 503,
    } as const
  }
  if (sqlState === '55P03') {
    return {
      retry: false,
      reasonCode: 'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_LOCK_TIMEOUT',
      message: 'Shopify checkout receipt claim could not acquire its lock',
      status: 503,
    } as const
  }
  if (sqlState === '40001' || sqlState === '40P01') {
    return {
      retry: false,
      reasonCode: 'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_RETRY_EXHAUSTED',
      message: 'Shopify checkout receipt claim exhausted its safe database retry',
      status: 503,
    } as const
  }
  return {
    retry: false,
    reasonCode: null,
    message: null,
    status: null,
  } as const
}

export async function executeShopifyCheckoutReceiptClaimWithRetry<T>(input: {
  deadlineAt: string | null
  signal?: AbortSignal
  executeAttempt: (attempt: number) => Promise<T>
}): Promise<T> {
  for (
    let attempt = 1;
    attempt <= SHOPIFY_CHECKOUT_RECEIPT_CLAIM_MAX_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await input.executeAttempt(attempt)
    } catch (error) {
      const disposition = shopifyCheckoutReceiptClaimRetryDisposition({
        error,
        attempt,
        deadlineAt: input.deadlineAt,
      })
      if (!disposition.retry) {
        if (
          disposition.reasonCode
          && disposition.message
          && disposition.status
        ) {
          fail(
            disposition.reasonCode,
            disposition.message,
            disposition.status,
          )
        }
        throw error
      }
      if (input.deadlineAt) {
        requirePersistenceAvailable(input.deadlineAt, input.signal)
      }
    }
  }
  fail(
    'SHOPIFY_CHECKOUT_RECEIPT_CLAIM_RETRY_EXHAUSTED',
    'Shopify checkout receipt claim exhausted its safe database retry',
    503,
  )
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

export function shopifyCheckoutRatingHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

export function shopifyCheckoutLineQuantityFingerprint(
  lines: readonly {
    providerVariantId: string
    quantity: number
  }[],
) {
  const quantities = new Map<string, number>()
  for (const line of lines) {
    const providerVariantId = textValue(
      line.providerVariantId,
      'Provider variant ID',
      255,
    )
    const quantity = integer(line.quantity, 'Line quantity', 1, 100000)
    const total = (quantities.get(providerVariantId) || 0) + quantity
    if (!Number.isSafeInteger(total) || total > 100000000) {
      fail(
        'SHOPIFY_CHECKOUT_LINE_QUANTITY_INVALID',
        'Aggregated checkout line quantity is invalid',
      )
    }
    quantities.set(providerVariantId, total)
  }
  if (quantities.size < 1) {
    fail(
      'SHOPIFY_CHECKOUT_LINE_COUNT_INVALID',
      'Checkout requires at least one shippable line',
    )
  }
  const canonical = [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([providerVariantId, quantity]) => (
      `${Buffer.byteLength(providerVariantId, 'utf8')}:`
      + `${providerVariantId}=${quantity}`
    ))
    .join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function assertShopifyCheckoutCustomerNeutralEvidence(
  value: Record<string, unknown>,
  label = 'Checkout evidence',
) {
  if (
    !value
    || Array.isArray(value)
    || typeof value !== 'object'
  ) {
    fail(
      'SHOPIFY_CHECKOUT_EVIDENCE_INVALID',
      `${label} must be an object`,
    )
  }
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > 1048576) {
    fail(
      'SHOPIFY_CHECKOUT_EVIDENCE_TOO_LARGE',
      `${label} exceeds the retained evidence limit`,
    )
  }
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(
      node as Record<string, unknown>,
    )) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (CUSTOMER_OR_SECRET_KEYS.has(normalizedKey)) {
        fail(
          'SHOPIFY_CHECKOUT_EVIDENCE_NOT_NEUTRAL',
          `${label} contains a customer or secret field: ${key}`,
        )
      }
      visit(child)
    }
  }
  visit(value)
}

export function normalizeShopifyCheckoutReceiptLineSnapshotV1(
  value: unknown,
  label = 'Checkout line snapshot',
): ShopifyCheckoutReceiptLineSnapshotV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_INVALID',
      `${label} must be an object`,
    )
  }
  const snapshot = value as Record<string, unknown>
  assertShopifyCheckoutCustomerNeutralEvidence(snapshot, label)
  if (
    snapshot.snapshotVersion
      !== SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION
  ) {
    fail(
      'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_VERSION_INVALID',
      `${label} version is unsupported`,
    )
  }
  const packageLevel = textValue(
    snapshot.packageLevel,
    `${label} package level`,
    32,
  )
  if (!SHOPIFY_CHECKOUT_RECEIPT_PACKAGE_LEVELS.includes(
    packageLevel as typeof SHOPIFY_CHECKOUT_RECEIPT_PACKAGE_LEVELS[number],
  )) {
    fail(
      'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_INVALID',
      `${label} package level is unsupported`,
    )
  }
  if (typeof snapshot.shipsAsOwnPackage !== 'boolean') {
    fail(
      'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_INVALID',
      `${label} own-package flag must be boolean`,
    )
  }
  if (
    !Array.isArray(snapshot.inventoryLevelGlobalIds)
    || snapshot.inventoryLevelGlobalIds.length < 1
    || snapshot.inventoryLevelGlobalIds.length > 500
  ) {
    fail(
      'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_INVALID',
      `${label} must retain 1-500 inventory-level Global IDs`,
    )
  }
  const inventoryLevelGlobalIds = snapshot.inventoryLevelGlobalIds
    .map((globalId, index) => matchValue(
      globalId,
      INVENTORY_LEVEL_GLOBAL_ID,
      `${label} inventory-level Global ID ${index + 1}`,
    ))
    .sort((left, right) => left.localeCompare(right))
  if (new Set(inventoryLevelGlobalIds).size !== inventoryLevelGlobalIds.length) {
    fail(
      'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_INVALID',
      `${label} inventory-level Global IDs must be unique`,
    )
  }
  return {
    snapshotVersion: SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION,
    productGid: matchValue(
      snapshot.productGid,
      SHOPIFY_PRODUCT_GID,
      `${label} provider product GID`,
    ),
    variantGid: matchValue(
      snapshot.variantGid,
      SHOPIFY_PRODUCT_VARIANT_GID,
      `${label} provider variant GID`,
    ),
    productGlobalId: matchValue(
      snapshot.productGlobalId,
      PRODUCT_GLOBAL_ID,
      `${label} product Global ID`,
    ),
    packMappingGlobalId: matchValue(
      snapshot.packMappingGlobalId,
      PACK_MAPPING_GLOBAL_ID,
      `${label} pack mapping Global ID`,
    ),
    packMappingRowVersion: integer(
      snapshot.packMappingRowVersion,
      `${label} pack mapping row version`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    packEvidenceHash: matchValue(
      snapshot.packEvidenceHash,
      SHA256,
      `${label} pack evidence hash`,
    ),
    packProfileVersionGlobalId: matchValue(
      snapshot.packProfileVersionGlobalId,
      PACK_PROFILE_VERSION_GLOBAL_ID,
      `${label} pack profile version Global ID`,
    ),
    packProfileVersionRowVersion: integer(
      snapshot.packProfileVersionRowVersion,
      `${label} pack profile version row version`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    packageLevel:
      packageLevel as ShopifyCheckoutReceiptLineSnapshotV1['packageLevel'],
    baseEachQuantity: integer(
      snapshot.baseEachQuantity,
      `${label} base-each quantity`,
      1,
      100000,
    ),
    shipsAsOwnPackage: snapshot.shipsAsOwnPackage,
    inventoryLevelGlobalIds,
    quantity: integer(
      snapshot.quantity,
      `${label} quantity`,
      1,
      100000,
    ),
    unitWeightGrams: integer(
      snapshot.unitWeightGrams,
      `${label} unit weight`,
      1,
      1000000,
    ),
  }
}

export function readShopifyCheckoutReceiptLineSnapshotEvidence(
  value: unknown,
): {
  snapshotVersion:
    typeof SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION | null
  packEvidenceHash: string | null
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { snapshotVersion: null, packEvidenceHash: null }
  }
  const snapshot = value as Record<string, unknown>
  if (
    snapshot.snapshotVersion
      !== SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION
  ) {
    return { snapshotVersion: null, packEvidenceHash: null }
  }
  const normalized = normalizeShopifyCheckoutReceiptLineSnapshotV1(snapshot)
  return {
    snapshotVersion: SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION,
    packEvidenceHash: normalized.packEvidenceHash,
  }
}

export function hydrateShopifyCheckoutRateReceiptLine(
  input: {
    lineKey: string
    providerVariantId: string
    sku: string | null
    quantity: number
    unitWeightGrams: number
    requiresShipping: boolean
    lineHash: string
    lineSnapshot: Record<string, unknown>
  },
): ShopifyCheckoutRateReceiptLine {
  const retainedLine = {
    lineKey: input.lineKey,
    providerVariantId: input.providerVariantId,
    sku: input.sku,
    quantity: input.quantity,
    unitWeightGrams: input.unitWeightGrams,
    requiresShipping: input.requiresShipping,
    lineSnapshot: input.lineSnapshot,
  }
  if (shopifyCheckoutRatingHash(retainedLine) !== input.lineHash) {
    fail(
      'SHOPIFY_CHECKOUT_LINE_HASH_MISMATCH',
      `Stored checkout line ${input.lineKey} does not match its immutable hash`,
      409,
    )
  }
  const snapshotEvidence =
    readShopifyCheckoutReceiptLineSnapshotEvidence(input.lineSnapshot)
  const lineSnapshot = snapshotEvidence.snapshotVersion === null
    ? input.lineSnapshot
    : normalizeShopifyCheckoutReceiptLineSnapshotV1(
        input.lineSnapshot,
        `Stored checkout line ${input.lineKey} snapshot`,
      )
  if (
    snapshotEvidence.snapshotVersion !== null
    && (
      lineSnapshot.variantGid !== input.providerVariantId
      || lineSnapshot.quantity !== input.quantity
      || lineSnapshot.unitWeightGrams !== input.unitWeightGrams
    )
  ) {
    fail(
      'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_MISMATCH',
      `Stored checkout line ${input.lineKey} snapshot disagrees with its row`,
      409,
    )
  }
  return {
    ...retainedLine,
    lineHash: input.lineHash,
    lineSnapshot,
    snapshotVersion: snapshotEvidence.snapshotVersion,
    packEvidenceHash: snapshotEvidence.packEvidenceHash,
  }
}

function assertPolicyHash(
  policyHash: string,
  policySnapshot: Record<string, unknown>,
) {
  if (shopifyCheckoutRatingHash(policySnapshot) !== policyHash) {
    fail(
      'SHOPIFY_CHECKOUT_POLICY_HASH_MISMATCH',
      'Policy hash does not match the normalized policy snapshot',
      409,
    )
  }
}

export function normalizeShopifyCarrierServiceConfigInput(
  input: ShopifyCarrierServiceConfigWriteInput,
): NormalizedShopifyCarrierServiceConfigInput {
  const organizationId = matchValue(
    input.organizationId,
    UUID,
    'Organization ID',
  )
  const accountGlobalId = matchValue(
    input.accountGlobalId,
    ACCOUNT_GLOBAL_ID,
    'Shopify account Global ID',
  )
  const warehouseGlobalId = matchValue(
    input.warehouseGlobalId,
    WAREHOUSE_GLOBAL_ID,
    'Warehouse Global ID',
  )
  const callbackTokenHash = matchValue(
    input.callbackTokenHash,
    SHA256,
    'Callback token hash',
  )
  const policyHash = matchValue(
    input.policyHash,
    SHA256,
    'Policy hash',
  )
  assertShopifyCheckoutCustomerNeutralEvidence(
    input.policySnapshot,
    'CarrierService policy snapshot',
  )
  assertPolicyHash(policyHash, input.policySnapshot)
  if (
    !Array.isArray(input.materials)
    || input.materials.length < 1
    || input.materials.length > MAX_SHOPIFY_CHECKOUT_MATERIALS
  ) {
    fail(
      'SHOPIFY_CHECKOUT_MATERIAL_COUNT_INVALID',
      `Select between 1 and ${MAX_SHOPIFY_CHECKOUT_MATERIALS} packaging materials`,
    )
  }
  const materialIds = new Set<string>()
  const materials = input.materials.map((material, index) => {
    const materialGlobalId = matchValue(
      material.materialGlobalId,
      MATERIAL_GLOBAL_ID,
      'Packaging material Global ID',
    )
    if (materialIds.has(materialGlobalId)) {
      fail(
        'SHOPIFY_CHECKOUT_MATERIAL_DUPLICATE',
        'A packaging material can be selected only once',
      )
    }
    materialIds.add(materialGlobalId)
    return {
      selectionSequence: index + 1,
      materialGlobalId,
      expectedRowVersion: integer(
        material.expectedRowVersion,
        'Packaging material row version',
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    }
  })
  if (!Array.isArray(input.carriers) || input.carriers.length !== 2) {
    fail(
      'SHOPIFY_CHECKOUT_CARRIER_BINDINGS_INVALID',
      'Exactly one UPS and one FedEx carrier account are required',
    )
  }
  const carriers = input.carriers.map((binding) => ({
    provider: binding.provider,
    carrierAccountGlobalId: matchValue(
      binding.carrierAccountGlobalId,
      CARRIER_ACCOUNT_GLOBAL_ID,
      'Carrier account Global ID',
    ),
  })).sort((left, right) => left.provider.localeCompare(right.provider))
  if (
    carriers[0]?.provider !== 'fedex_rest'
    || carriers[1]?.provider !== 'ups_rest'
    || carriers[0].carrierAccountGlobalId
      === carriers[1].carrierAccountGlobalId
  ) {
    fail(
      'SHOPIFY_CHECKOUT_CARRIER_BINDINGS_INVALID',
      'Exactly one distinct UPS and one distinct FedEx account are required',
    )
  }
  const inventoryMaxAgeSeconds = integer(
    input.inventoryMaxAgeSeconds,
    'Inventory maximum age',
    30,
    86400,
  )
  const quoteTtlSeconds = integer(
    input.quoteTtlSeconds,
    'Quote TTL',
    30,
    900,
  )
  if (quoteTtlSeconds > inventoryMaxAgeSeconds) {
    fail(
      'SHOPIFY_CHECKOUT_TTL_EXCEEDS_INVENTORY_FRESHNESS',
      'Quote TTL cannot exceed the inventory freshness window',
    )
  }
  return {
    ...input,
    organizationId,
    accountGlobalId,
    expectedRowVersion: input.expectedRowVersion === undefined
      || input.expectedRowVersion === null
      ? null
      : integer(
          input.expectedRowVersion,
          'Configuration row version',
          0,
          Number.MAX_SAFE_INTEGER,
        ),
    credentialGeneration: integer(
      input.credentialGeneration,
      'Credential generation',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    activationRevision: integer(
      input.activationRevision,
      'Activation revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    callbackTokenVersion: integer(
      input.callbackTokenVersion,
      'Callback token version',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    callbackTokenHash,
    policyRevision: integer(
      input.policyRevision,
      'Policy revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    policyHash,
    warehouseGlobalId,
    materials,
    carriers,
    inventoryMaxAgeSeconds,
    quoteTtlSeconds,
    orderReconciliationWindowSeconds: integer(
      input.orderReconciliationWindowSeconds,
      'Order reconciliation window',
      60,
      172800,
    ),
    algorithmVersion: textValue(
      input.algorithmVersion,
      'Algorithm version',
      160,
    ),
    actorEmail: textValue(input.actorEmail, 'Actor email', 320),
  }
}

export function normalizeShopifyCheckoutReceiptClaimInput(
  input: ShopifyCheckoutReceiptClaimInput,
): NormalizedShopifyCheckoutReceiptClaimInput {
  if (
    !Array.isArray(input.lines)
    || input.lines.length < 1
    || input.lines.length > MAX_SHOPIFY_CHECKOUT_LINES
  ) {
    fail(
      'SHOPIFY_CHECKOUT_LINE_COUNT_INVALID',
      `Checkout requires 1-${MAX_SHOPIFY_CHECKOUT_LINES} retained lines`,
    )
  }
  assertShopifyCheckoutCustomerNeutralEvidence(
    input.redactedRequestSnapshot,
    'Redacted Shopify request snapshot',
  )
  const lineKeys = new Set<string>()
  const lines = input.lines.map((line) => {
    const lineKey = textValue(line.lineKey, 'Line key', 120)
    if (lineKeys.has(lineKey)) {
      fail(
        'SHOPIFY_CHECKOUT_LINE_DUPLICATE',
        'Checkout line keys must be unique',
      )
    }
    lineKeys.add(lineKey)
    if (line.requiresShipping !== true) {
      fail(
        'SHOPIFY_CHECKOUT_NONSHIPPING_LINE_INVALID',
        'Checkout rating receipts retain shippable lines only',
      )
    }
    const normalizedLine = {
      lineKey,
      providerVariantId: textValue(
        line.providerVariantId,
        'Provider variant ID',
        255,
      ),
      sku: line.sku === undefined || line.sku === null
        || String(line.sku).trim() === ''
        ? null
        : textValue(line.sku, 'SKU', 255),
      quantity: integer(
        line.quantity,
        'Line quantity',
        1,
        100000,
      ),
      unitWeightGrams: integer(
        line.unitWeightGrams,
        'Line unit weight',
        1,
        1000000,
      ),
      requiresShipping: true,
    }
    const lineSnapshot = normalizeShopifyCheckoutReceiptLineSnapshotV1(
      line.lineSnapshot,
      `Line ${lineKey} snapshot`,
    )
    if (
      lineSnapshot.variantGid !== normalizedLine.providerVariantId
      || lineSnapshot.quantity !== normalizedLine.quantity
      || lineSnapshot.unitWeightGrams !== normalizedLine.unitWeightGrams
    ) {
      fail(
        'SHOPIFY_CHECKOUT_LINE_SNAPSHOT_MISMATCH',
        `Line ${lineKey} snapshot disagrees with retained line evidence`,
      )
    }
    const normalized = { ...normalizedLine, lineSnapshot }
    return {
      ...normalized,
      lineHash: shopifyCheckoutRatingHash(normalized),
    }
  }).sort((left, right) => left.lineKey.localeCompare(right.lineKey))
  const currency = textValue(input.currency, 'Currency', 3).toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    fail('SHOPIFY_CHECKOUT_CURRENCY_INVALID', 'Currency must be ISO 4217')
  }
  const inventorySnapshotAt = new Date(input.inventorySnapshotAt)
  if (Number.isNaN(inventorySnapshotAt.valueOf())) {
    fail(
      'SHOPIFY_CHECKOUT_INVENTORY_TIMESTAMP_INVALID',
      'Inventory snapshot time is invalid',
    )
  }
  const destinationFingerprint = matchValue(
    input.destinationFingerprint,
    SHA256,
    'Destination fingerprint',
  )
  const carrierDestinationFingerprint = matchValue(
    input.carrierDestinationFingerprint,
    SHA256,
    'Carrier destination fingerprint',
  )
  const requestFingerprint = matchValue(
    input.requestFingerprint,
    SHA256,
    'Request fingerprint',
  )
  const inventorySnapshotHash = matchValue(
    input.inventorySnapshotHash,
    SHA256,
    'Inventory snapshot hash',
  )
  if (!['shadow', 'active'].includes(input.expectedActivationState)) {
    fail(
      'SHOPIFY_CHECKOUT_ACTIVATION_STATE_INVALID',
      'Expected activation state must be Shadow or Active',
    )
  }
  const expectedConfigRowVersion = integer(
    input.expectedConfigRowVersion,
    'Expected configuration row version',
    0,
    Number.MAX_SAFE_INTEGER,
  )
  const expectedActivationRevision = integer(
    input.expectedActivationRevision,
    'Expected activation revision',
    1,
    Number.MAX_SAFE_INTEGER,
  )
  const lineQuantityFingerprint =
    shopifyCheckoutLineQuantityFingerprint(lines)
  const requestEvidenceHash = shopifyCheckoutRatingHash({
    requestFingerprint,
    destinationFingerprint,
    carrierDestinationFingerprint,
    lineQuantityFingerprint,
    inventorySnapshotHash,
    expectedConfigRowVersion,
    expectedActivationState: input.expectedActivationState,
    expectedActivationRevision,
    request: input.redactedRequestSnapshot,
    lines,
  })
  const idempotencyKey = textValue(
    input.idempotencyKey,
    'Idempotency key',
    200,
  )
  const cacheKey = textValue(
    input.cacheKey ?? idempotencyKey,
    'Checkout cache key',
    200,
  )
  if (
    idempotencyKey !== cacheKey
    && !idempotencyKey.startsWith(`${cacheKey}:attempt:`)
  ) {
    fail(
      'SHOPIFY_CHECKOUT_ATTEMPT_KEY_INVALID',
      'Checkout attempt key must remain within its stable cache fence',
    )
  }
  return {
    ...input,
    organizationId: matchValue(
      input.organizationId,
      UUID,
      'Organization ID',
    ),
    accountGlobalId: matchValue(
      input.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    requestFingerprint,
    destinationFingerprint,
    carrierDestinationFingerprint,
    inventorySnapshotHash,
    expectedConfigRowVersion,
    expectedActivationState: input.expectedActivationState,
    expectedActivationRevision,
    requestEvidenceHash,
    lineQuantityFingerprint,
    currency,
    cacheKey,
    idempotencyKey,
    inventorySnapshotAt: inventorySnapshotAt.toISOString(),
    claimedBy: textValue(input.claimedBy, 'Claimed by', 200),
    deadlineAt: optionalDeadline(
      input.deadlineAt,
      'Checkout claim deadline',
    ),
    leaseSeconds: integer(
      input.leaseSeconds ?? 10,
      'Claim lease',
      3,
      30,
    ),
    lines,
  }
}

export function shopifyCheckoutPackagePlanHash(input: {
  packages: Array<{
    packageKey: string
    packageSequence: number
    planningMethod?: 'approved_recipe' | 'self_package'
    materialGlobalId?: string | null
    materialRowVersion?: number | null
    materialStockGlobalId?: string | null
    materialStockRowVersion?: number | null
    materialStockOnHandQuantity?: number | null
    packProfileVersionGlobalId?: string | null
    packProfileVersionRowVersion?: number | null
    selfPackageLineKey?: string | null
    ratedOuterDimensionsMm: {
      length: number
      width: number
      height: number
    }
    contentWeightGrams: number
    tareWeightGrams: number
    allocations: Array<{ lineKey: string; quantity: number }>
    packageSnapshot: Record<string, unknown>
  }>
}) {
  const normalized = input.packages
    .map((item) => ({
      packageKey: item.packageKey,
      packageSequence: item.packageSequence,
      planningMethod: item.planningMethod ?? 'approved_recipe',
      materialGlobalId: item.materialGlobalId ?? null,
      materialRowVersion: item.materialRowVersion ?? null,
      materialStockGlobalId: item.materialStockGlobalId ?? null,
      materialStockRowVersion: item.materialStockRowVersion ?? null,
      materialStockOnHandQuantity:
        item.materialStockOnHandQuantity ?? null,
      packProfileVersionGlobalId:
        item.packProfileVersionGlobalId ?? null,
      packProfileVersionRowVersion:
        item.packProfileVersionRowVersion ?? null,
      selfPackageLineKey: item.selfPackageLineKey ?? null,
      ratedOuterDimensionsMm: item.ratedOuterDimensionsMm,
      contentWeightGrams: item.contentWeightGrams,
      tareWeightGrams: item.tareWeightGrams,
      allocations: [...item.allocations].sort((left, right) => (
        left.lineKey.localeCompare(right.lineKey)
      )).map((allocation) => ({
        lineKey: allocation.lineKey,
        quantity: allocation.quantity,
      })),
      packageSnapshot: item.packageSnapshot,
    }))
    .sort((left, right) => (
      left.packageSequence - right.packageSequence
      || left.packageKey.localeCompare(right.packageKey)
    ))
  return shopifyCheckoutRatingHash(normalized)
}

function material(row: MaterialRow): ShopifyCheckoutRatingMaterial {
  return {
    selectionSequence: Number(row.selection_sequence),
    materialId: row.material_id,
    materialGlobalId: row.material_global_id,
    materialCode: row.material_code,
    materialName: row.material_name,
    expectedRowVersion: Number(row.expected_row_version),
    currentRowVersion: Number(row.current_row_version),
    ratedOuterDimensionsMm: {
      length: row.rated_outer_length_mm,
      width: row.rated_outer_width_mm,
      height: row.rated_outer_height_mm,
    },
    tareWeightGrams: row.tare_weight_grams,
    maxWeightGrams: row.max_weight_grams,
    evidenceType: row.evidence_type,
    evidenceReference: row.evidence_reference,
    evidenceConfirmedAt: iso(row.evidence_confirmed_at),
    stockGlobalId: row.stock_global_id,
    stockRowVersion:
      row.stock_row_version === null ? null : Number(row.stock_row_version),
    stockAvailable: row.stock_available === true,
    stockOnHandQuantity: row.stock_on_hand_quantity,
  }
}

function carrierBinding(
  row: CarrierBindingRow,
): ShopifyCheckoutRatingCarrierBinding {
  return {
    provider: row.carrier_provider,
    carrierAccountId: row.carrier_account_id,
    carrierAccountGlobalId: row.carrier_account_global_id,
    credentialVersion: row.credential_version,
    displayName: row.display_name,
    accountStatus: row.account_status,
    integrationStatus: row.integration_status,
    environment: row.environment,
  }
}

const CONFIG_SELECT = `SELECT
    config.id::text,
    config.global_id,
    config.organization_id::text,
    config.integration_account_id::text,
    account.global_id AS account_global_id,
    account.environment AS account_environment,
    account.status AS account_status,
    config.warehouse_id::text,
    warehouse.global_id AS warehouse_global_id,
    warehouse.name AS warehouse_name,
    config.checkout_brand_name_override,
    config.registered_service_name,
    config.service_gid,
    config.registration_state,
    config.credential_generation,
    config.activation_revision,
    config.callback_token_version,
    config.policy_revision::text,
    config.policy_hash,
    config.policy_snapshot,
    config.inventory_max_age_seconds,
    config.quote_ttl_seconds,
    config.order_reconciliation_window_seconds,
    config.algorithm_version,
    config.last_error_code,
    config.row_version::text,
    (
      operations_shopify_carrier_service_config_is_ready(
        config.organization_id, config.id
      )
      AND (
        config.registration_state = 'shadow_simulated'
        OR (
          config.registration_state = 'registered'
          AND config.registered_service_name IS NOT DISTINCT FROM
            COALESCE(
              NULLIF(
                regexp_replace(
                  btrim(config.checkout_brand_name_override),
                  '[[:space:]]+', ' ', 'g'
                ),
                ''
              ),
              NULLIF(
                regexp_replace(
                  btrim(account.configuration ->> 'accountName'),
                  '[[:space:]]+', ' ', 'g'
                ),
                ''
              )
            )
        )
      )
    ) AS ready,
    config.created_at,
    config.updated_at
  FROM operations_shopify_carrier_service_configs config
  JOIN operations_integration_accounts account
    ON account.organization_id = config.organization_id
   AND account.id = config.integration_account_id
  JOIN operations_warehouses warehouse
    ON warehouse.organization_id = config.organization_id
   AND warehouse.id = config.warehouse_id`

async function runHydrationQueries<T extends readonly unknown[]>(
  client: PoolClient | null,
  tasks: { [K in keyof T]: () => Promise<T[K]> },
): Promise<T> {
  const runnable = tasks as readonly (() => Promise<unknown>)[]
  if (!client) {
    return Promise.all(runnable.map((task) => task())) as unknown as Promise<T>
  }
  const results: unknown[] = []
  for (const task of runnable) {
    results.push(await task())
  }
  return results as unknown as T
}

async function readConfigChildren(
  client: PoolClient | null,
  input: { organizationId: string; configId: string },
) {
  const run = <T extends QueryResultRow>(sql: string, values: unknown[]) => (
    client ? client.query<T>(sql, values) : query<T>(sql, values)
  )
  const [materials, carriers] = await runHydrationQueries(client, [
    () => run<MaterialRow>(
      `SELECT
         selected.selection_sequence,
         material.id::text AS material_id,
         material.global_id AS material_global_id,
         material.code AS material_code,
         material.name AS material_name,
         selected.packaging_material_row_version::text
           AS expected_row_version,
         material.row_version::text AS current_row_version,
         material.rated_outer_length_mm,
         material.rated_outer_width_mm,
         material.rated_outer_height_mm,
         material.tare_weight_grams,
         material.max_weight_grams,
         material.rated_outer_dimension_evidence_type AS evidence_type,
         material.rated_outer_dimension_evidence_reference
           AS evidence_reference,
         material.rated_outer_dimension_confirmed_at
           AS evidence_confirmed_at,
         stock.global_id AS stock_global_id,
         stock.row_version::text AS stock_row_version,
         stock.is_available AS stock_available,
         stock.on_hand_quantity AS stock_on_hand_quantity
       FROM operations_shopify_carrier_service_config_materials selected
       JOIN operations_shopify_carrier_service_configs config
         ON config.organization_id = selected.organization_id
        AND config.id = selected.config_id
       JOIN operations_packaging_materials material
         ON material.organization_id = selected.organization_id
        AND material.id = selected.packaging_material_id
       LEFT JOIN operations_packaging_material_stock stock
         ON stock.organization_id = material.organization_id
        AND stock.packaging_material_id = material.id
        AND stock.warehouse_id = config.warehouse_id
       WHERE selected.organization_id = $1::uuid
         AND selected.config_id = $2::uuid
       ORDER BY selected.selection_sequence`,
      [input.organizationId, input.configId],
    ),
    () => run<CarrierBindingRow>(
      `SELECT
         selected.carrier_provider,
         carrier_account.id::text AS carrier_account_id,
         carrier_account.global_id AS carrier_account_global_id,
         credential.credential_version,
         carrier_account.display_name,
         carrier_account.status AS account_status,
         integration.status AS integration_status,
         integration.environment
       FROM operations_shopify_carrier_service_config_carriers selected
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id = selected.organization_id
        AND carrier_account.id = selected.carrier_account_id
       JOIN operations_integration_accounts integration
         ON integration.organization_id = carrier_account.organization_id
        AND integration.id = carrier_account.integration_account_id
       JOIN operations_carrier_credentials credential
         ON credential.organization_id = integration.organization_id
        AND credential.integration_account_id = integration.id
       WHERE selected.organization_id = $1::uuid
         AND selected.config_id = $2::uuid
       ORDER BY selected.carrier_provider`,
      [input.organizationId, input.configId],
    ),
  ] as const)
  return {
    materials: materials.rows.map(material),
    carriers: carriers.rows.map(carrierBinding),
  }
}

async function readConfigRowWithClient(
  client: PoolClient | null,
  input: { organizationId: string; accountGlobalId: string },
): Promise<ConfigRow | null> {
  const result = client
    ? await client.query<ConfigRow>(
        `${CONFIG_SELECT}
         WHERE config.organization_id = $1::uuid
           AND account.global_id = $2`,
        [input.organizationId, input.accountGlobalId],
      )
    : await query<ConfigRow>(
        `${CONFIG_SELECT}
         WHERE config.organization_id = $1::uuid
           AND account.global_id = $2`,
        [input.organizationId, input.accountGlobalId],
      )
  return result.rows[0] || null
}

function checkoutReceiptClaimConfig(row: ConfigRow) {
  return {
    id: row.id,
    integrationAccountId: row.integration_account_id,
    warehouseId: row.warehouse_id,
    registrationState: row.registration_state,
    credentialGeneration: row.credential_generation,
    policyRevision: Number(row.policy_revision),
    policyHash: row.policy_hash,
    inventoryMaxAgeSeconds: row.inventory_max_age_seconds,
    algorithmVersion: row.algorithm_version,
    rowVersion: Number(row.row_version),
    ready: row.ready,
  }
}

async function readConfigWithClient(
  client: PoolClient | null,
  input: { organizationId: string; accountGlobalId: string },
): Promise<ShopifyCarrierServiceConfig | null> {
  const row = await readConfigRowWithClient(client, input)
  if (!row) return null
  const children = await readConfigChildren(client, {
    organizationId: input.organizationId,
    configId: row.id,
  })
  return {
    id: row.id,
    globalId: row.global_id,
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    accountGlobalId: row.account_global_id,
    accountEnvironment: row.account_environment,
    accountStatus: row.account_status,
    warehouseId: row.warehouse_id,
    warehouseGlobalId: row.warehouse_global_id,
    warehouseName: row.warehouse_name,
    checkoutBrandNameOverride: row.checkout_brand_name_override,
    registeredServiceName: row.registered_service_name,
    serviceGid: row.service_gid,
    registrationState: row.registration_state,
    credentialGeneration: row.credential_generation,
    activationRevision: row.activation_revision,
    callbackTokenVersion: row.callback_token_version,
    policyRevision: Number(row.policy_revision),
    policyHash: row.policy_hash,
    policySnapshot: row.policy_snapshot,
    inventoryMaxAgeSeconds: row.inventory_max_age_seconds,
    quoteTtlSeconds: row.quote_ttl_seconds,
    orderReconciliationWindowSeconds:
      row.order_reconciliation_window_seconds,
    algorithmVersion: row.algorithm_version,
    lastErrorCode: row.last_error_code,
    rowVersion: Number(row.row_version),
    ready: row.ready,
    materials: children.materials,
    carriers: children.carriers,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  }
}

export async function readShopifyCarrierServiceConfigFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
}) {
  return readConfigWithClient(null, {
    organizationId: matchValue(
      input.organizationId,
      UUID,
      'Organization ID',
    ),
    accountGlobalId: matchValue(
      input.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
  })
}

function checkoutBrandNameOverride(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null
  }
  const normalized = String(value)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
  if (
    normalized.length < 1
    || normalized.length > 120
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail(
      'SHOPIFY_CHECKOUT_BRAND_NAME_INVALID',
      'Customer-facing store name must be 1-120 characters',
    )
  }
  return normalized
}

export async function updateShopifyCarrierServiceBrandNameOverrideInPostgres(
  rawInput: {
    organizationId: string
    accountGlobalId: string
    expectedRowVersion: number
    checkoutBrandNameOverride?: string | null
    actorEmail: string
  },
) {
  const input = {
    organizationId: matchValue(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    accountGlobalId: matchValue(
      rawInput.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    expectedRowVersion: integer(
      rawInput.expectedRowVersion,
      'Configuration row version',
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    checkoutBrandNameOverride: checkoutBrandNameOverride(
      rawInput.checkoutBrandNameOverride,
    ),
    actorEmail: textValue(rawInput.actorEmail, 'Actor email', 320),
  }
  return withTransaction(async (client) => {
    const identity = await client.query<{ id: string }>(
      `SELECT config.id::text
       FROM operations_shopify_carrier_service_configs config
       JOIN operations_integration_accounts account
         ON account.organization_id = config.organization_id
        AND account.id = config.integration_account_id
       WHERE config.organization_id = $1::uuid
         AND account.global_id = $2`,
      [input.organizationId, input.accountGlobalId],
    )
    if (!identity.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_NOT_FOUND',
        'CarrierService configuration was not found',
        404,
      )
    }
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-authorization:${input.organizationId}:${
        identity.rows[0].id
      }`,
    )
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-config:${input.organizationId}:${input.accountGlobalId}`,
    )
    const current = await readConfigWithClient(client, input)
    if (!current) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_NOT_FOUND',
        'CarrierService configuration was not found',
        404,
      )
    }
    if (current.rowVersion !== input.expectedRowVersion) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT',
        'CarrierService configuration changed. Refresh and try again.',
        409,
      )
    }
    if (
      current.checkoutBrandNameOverride
      === input.checkoutBrandNameOverride
    ) {
      return current
    }
    const unsafeAuthorization = await client.query<{ global_id: string }>(
      `SELECT authorized_mutation.global_id
       FROM operations_shopify_carrier_service_mutation_authorizations
         authorized_mutation
       LEFT JOIN operations_shopify_carrier_service_mutation_attempts attempt
         ON attempt.organization_id = authorized_mutation.organization_id
        AND attempt.authorization_id = authorized_mutation.id
       LEFT JOIN operations_shopify_carrier_service_mutation_outcomes outcome
         ON outcome.organization_id = attempt.organization_id
        AND outcome.attempt_id = attempt.id
       LEFT JOIN operations_shopify_carrier_service_mutation_resolutions
         resolution
         ON resolution.organization_id = attempt.organization_id
        AND resolution.attempt_id = attempt.id
       WHERE authorized_mutation.organization_id = $1::uuid
         AND authorized_mutation.config_id = $2::uuid
         AND authorized_mutation.config_row_version = $3::bigint
         AND (
           (
             outcome.outcome = 'failed'
             AND outcome.provider_write_count = 0
           )
           OR resolution.disposition = 'confirmed_not_applied'
           OR (
             attempt.id IS NULL
             AND authorized_mutation.expires_at <= now()
           )
         ) IS NOT TRUE
       LIMIT 1`,
      [input.organizationId, current.id, current.rowVersion],
    )
    if (unsafeAuthorization.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_BRAND_NAME_AUTHORIZATION_ACTIVE',
        'Resolve the current CarrierService provider authorization before changing its customer-facing name',
        409,
      )
    }
    const updated = await client.query<{
      global_id: string
      row_version: string
    }>(
      `UPDATE operations_shopify_carrier_service_configs
       SET checkout_brand_name_override = $3,
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND row_version = $5
       RETURNING global_id, row_version::text`,
      [
        input.organizationId,
        current.id,
        input.checkoutBrandNameOverride,
        input.actorEmail,
        input.expectedRowVersion,
      ],
    )
    if (!updated.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT',
        'CarrierService configuration changed. Refresh and try again.',
        409,
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.shopify_carrier_service.brand_name_changed',
      aggregateType: 'operations.shopify_carrier_service_config',
      aggregateId: updated.rows[0].global_id,
      subject: input.accountGlobalId,
      organizationId: input.organizationId,
      eventKey:
        `operations:shopify-carrier-service:${
          updated.rows[0].global_id
        }:brand-name-version:${updated.rows[0].row_version}`,
      payload: {
        accountGlobalId: input.accountGlobalId,
        priorOverride: current.checkoutBrandNameOverride,
        newOverride: input.checkoutBrandNameOverride,
        overrideConfigured:
          input.checkoutBrandNameOverride !== null,
        effectiveNameSource:
          input.checkoutBrandNameOverride === null
            ? 'provider_verified_shop_name'
            : 'administrator_override',
        rowVersion: Number(updated.rows[0].row_version),
      },
    }, client)
    return readConfigWithClient(client, input)
  })
}

/**
 * Repair only the local activation-revision fence for a registered Shopify
 * CarrierService after an exact, immutable Shadow-to-Active transition. No
 * Shopify request or callback-token rotation occurs in this transaction.
 */
export async function repairShopifyCarrierServiceActiveRevisionBindingInPostgres(
  rawInput: {
    organizationId: string
    accountGlobalId: string
    expectedRowVersion: number
    expectedActivationRevision: number
    actorEmail: string
  },
) {
  const input = {
    organizationId: matchValue(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    accountGlobalId: matchValue(
      rawInput.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    expectedRowVersion: integer(
      rawInput.expectedRowVersion,
      'Configuration row version',
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    expectedActivationRevision: integer(
      rawInput.expectedActivationRevision,
      'Active Operations revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    actorEmail: textValue(rawInput.actorEmail, 'Actor email', 320),
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      'commerce-active-transition:' + input.organizationId,
    )
    const identity = await client.query<{ id: string }>(
      `SELECT config.id::text
       FROM operations_shopify_carrier_service_configs config
       JOIN operations_integration_accounts account
         ON account.organization_id = config.organization_id
        AND account.id = config.integration_account_id
       WHERE config.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'`,
      [input.organizationId, input.accountGlobalId],
    )
    if (!identity.rows[0]) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_ACTIVE_REBIND_CONFIG_NOT_FOUND',
        'Registered Shopify CarrierService configuration was not found',
        404,
      )
    }
    await acquireTransactionAdvisoryLock(
      client,
      'shopify-carrier-service-authorization:'
        + input.organizationId + ':' + identity.rows[0].id,
    )
    await acquireTransactionAdvisoryLock(
      client,
      'shopify-carrier-service-config:'
        + input.organizationId + ':' + input.accountGlobalId,
    )
    await acquireTransactionAdvisoryLock(
      client,
      'shopify-carrier-service-config-mutation:'
        + input.organizationId + ':' + input.accountGlobalId,
    )
    const facts = await client.query<{
      config_id: string
      config_global_id: string
      integration_account_id: string
      registration_state: ShopifyCarrierServiceRegistrationState
      service_gid: string | null
      credential_generation: number
      config_activation_revision: number
      callback_token_version: number
      row_version: string
      account_environment: string
      account_status: string
      account_credential_generation: number
      credential_version: number | null
      verification_status: string | null
      activation_state: string
      activation_revision: number
      callback_ready: boolean
    }>(
      `SELECT
         config.id::text AS config_id,
         config.global_id AS config_global_id,
         config.integration_account_id::text,
         config.registration_state,
         config.service_gid,
         config.credential_generation,
         config.activation_revision AS config_activation_revision,
         config.callback_token_version,
         config.row_version::text,
         account.environment AS account_environment,
         account.status AS account_status,
         account.commerce_credential_generation
           AS account_credential_generation,
         credential.credential_version,
         credential.verification_status,
         activation.state AS activation_state,
         activation.revision AS activation_revision,
         operations_shopify_carrier_service_config_is_ready(
           config.organization_id,
           config.id
         ) AS callback_ready
       FROM operations_shopify_carrier_service_configs config
       JOIN operations_integration_accounts account
         ON account.organization_id = config.organization_id
        AND account.id = config.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = config.organization_id
       WHERE config.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
       FOR UPDATE OF config, account, credential, activation`,
      [input.organizationId, input.accountGlobalId],
    )
    const current = facts.rows[0]
    if (!current) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_ACTIVE_REBIND_CONFIG_NOT_FOUND',
        'Registered Shopify CarrierService configuration was not found',
        404,
      )
    }
    if (Number(current.row_version) !== input.expectedRowVersion) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_ACTIVE_REBIND_VERSION_CONFLICT',
        'CarrierService configuration changed. Refresh and try again.',
        409,
      )
    }
    if (
      current.activation_state !== 'active'
      || current.activation_revision !== input.expectedActivationRevision
    ) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_ACTIVE_REBIND_ACTIVATION_DRIFT',
        'Operations Active authority changed. Refresh and review the current state.',
        409,
      )
    }
    if (
      current.registration_state !== 'registered'
      || !current.service_gid
      || !SHOPIFY_SERVICE_GID.test(current.service_gid)
      || current.account_environment !== 'sandbox'
      || current.account_status !== 'active'
      || current.verification_status !== 'verified'
      || current.credential_generation
        !== current.account_credential_generation
      || current.credential_generation !== current.credential_version
    ) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_ACTIVE_REBIND_NOT_ELIGIBLE',
        'The exact registered and verified Shopify CarrierService is not eligible for a local authority repair',
        409,
      )
    }
    if (
      current.config_activation_revision === current.activation_revision
    ) {
      if (current.callback_ready !== true) {
        fail(
          'SHOPIFY_CARRIER_SERVICE_ACTIVE_REBIND_READINESS_FAILED',
          'The Shopify CarrierService has another callback-readiness error',
          409,
        )
      }
      return readConfigWithClient(client, input)
    }
    const sourceTransition = await client.query<{
      global_id: string
    }>(
      `SELECT transition.global_id
       FROM operations_commerce_active_transitions transition
       JOIN operations_commerce_active_transition_preparations prepared
         ON prepared.organization_id = transition.organization_id
        AND prepared.id = transition.preparation_id
       CROSS JOIN LATERAL jsonb_array_elements(prepared.cohort)
         AS cohort(member)
       WHERE transition.organization_id = $1::uuid
         AND transition.from_activation_state = 'shadow'
         AND transition.to_activation_state = 'active'
         AND transition.from_activation_revision = $2
         AND transition.to_activation_revision = $3
         AND (cohort.member->>'accountId')::uuid = $4::uuid
         AND cohort.member->>'accountGlobalId' = $5
         AND cohort.member->>'provider' = 'shopify'
         AND (cohort.member->>'credentialGeneration')::integer = $6
         AND cohort.member->'writeCapabilities'
           ? 'shipping_rate_callbacks'
         AND operations_commerce_active_capability_claim_is_current(
           transition.organization_id,
           transition.id,
           $5,
           'shipping_rate_callbacks'
         )
       ORDER BY transition.activated_at DESC
       LIMIT 1`,
      [
        input.organizationId,
        current.config_activation_revision,
        current.activation_revision,
        current.integration_account_id,
        input.accountGlobalId,
        current.credential_generation,
      ],
    )
    const transition = sourceTransition.rows[0]
    if (!transition) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_ACTIVE_REBIND_TRANSITION_REQUIRED',
        'No exact current Active transition authorizes this Shopify callback revision repair',
        409,
      )
    }
    const unsafeAuthorization = await client.query<{ global_id: string }>(
      `SELECT authorized_mutation.global_id
       FROM operations_shopify_carrier_service_mutation_authorizations
         authorized_mutation
       LEFT JOIN operations_shopify_carrier_service_mutation_attempts attempt
         ON attempt.organization_id = authorized_mutation.organization_id
        AND attempt.authorization_id = authorized_mutation.id
       LEFT JOIN operations_shopify_carrier_service_mutation_outcomes outcome
         ON outcome.organization_id = attempt.organization_id
        AND outcome.attempt_id = attempt.id
       LEFT JOIN operations_shopify_carrier_service_mutation_resolutions
         resolution
         ON resolution.organization_id = attempt.organization_id
        AND resolution.attempt_id = attempt.id
       WHERE authorized_mutation.organization_id = $1::uuid
         AND authorized_mutation.config_id = $2::uuid
         AND authorized_mutation.config_row_version = $3::bigint
         AND (
           (
             outcome.outcome = 'failed'
             AND outcome.provider_write_count = 0
           )
           OR resolution.disposition = 'confirmed_not_applied'
           OR (
             attempt.id IS NULL
             AND authorized_mutation.expires_at <= now()
           )
         ) IS NOT TRUE
       LIMIT 1`,
      [input.organizationId, current.config_id, current.row_version],
    )
    if (unsafeAuthorization.rows[0]) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_ACTIVE_REBIND_MUTATION_UNRESOLVED',
        'Resolve the current Shopify CarrierService provider mutation before repairing Active callback authority',
        409,
      )
    }
    const updated = await client.query<{
      activation_revision: number
      row_version: string
    }>(
      `UPDATE operations_shopify_carrier_service_configs
       SET activation_revision = $3,
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND registration_state = 'registered'
         AND service_gid = $5
         AND credential_generation = $6
         AND activation_revision = $7
         AND callback_token_version = $8
         AND row_version = $9::bigint
       RETURNING activation_revision, row_version::text`,
      [
        input.organizationId,
        current.config_id,
        current.activation_revision,
        input.actorEmail,
        current.service_gid,
        current.credential_generation,
        current.config_activation_revision,
        current.callback_token_version,
        input.expectedRowVersion,
      ],
    )
    if (
      updated.rows[0]?.activation_revision !== current.activation_revision
      || Number(updated.rows[0]?.row_version) !== input.expectedRowVersion + 1
    ) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_ACTIVE_REBIND_VERSION_CONFLICT',
        'CarrierService configuration changed during Active authority repair',
        409,
      )
    }
    const rebound = await readConfigWithClient(client, input)
    if (!rebound?.ready) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_ACTIVE_REBIND_READINESS_FAILED',
        'The Shopify CarrierService did not become callback-ready after its local authority repair',
        409,
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType:
        'operations.shopify_carrier_service.activation_revision_rebound',
      aggregateType: 'operations.shopify_carrier_service_config',
      aggregateId: current.config_global_id,
      subject: input.accountGlobalId,
      organizationId: input.organizationId,
      eventKey:
        'operations:shopify-carrier-service:' + current.config_global_id
        + ':active-revision:' + current.activation_revision,
      payload: {
        transitionGlobalId: transition.global_id,
        accountGlobalId: input.accountGlobalId,
        serviceGid: current.service_gid,
        fromActivationRevision: current.config_activation_revision,
        activationRevision: current.activation_revision,
        fromRowVersion: input.expectedRowVersion,
        rowVersion: rebound.rowVersion,
        callbackTokenVersionRetained: current.callback_token_version,
        providerWrites: 0,
        callbackTokenRotations: 0,
        repair: true,
      },
    }, client)
    return rebound
  })
}

export async function upsertShopifyCarrierServiceConfigInPostgres(
  rawInput: ShopifyCarrierServiceConfigWriteInput,
) {
  const input = normalizeShopifyCarrierServiceConfigInput(rawInput)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-active-transition:${input.organizationId}`,
    )
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-config:${input.organizationId}:${input.accountGlobalId}`,
    )
    const accountResult = await client.query<{
      id: string
      credential_generation: number
      credential_version: number | null
      verification_status: string | null
      activation_revision: number
      activation_state: string
      account_environment: 'mock' | 'sandbox' | 'production'
    }>(
      `SELECT
         account.id::text,
         account.commerce_credential_generation AS credential_generation,
         credential.credential_version,
         credential.verification_status,
         activation.revision AS activation_revision,
         activation.state AS activation_state,
         account.environment AS account_environment
       FROM operations_integration_accounts account
       LEFT JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
       FOR UPDATE OF account, activation`,
      [input.organizationId, input.accountGlobalId],
    )
    const account = accountResult.rows[0]
    if (!account) {
      fail(
        'SHOPIFY_CHECKOUT_ACCOUNT_NOT_FOUND',
        'Shopify commerce account was not found',
        404,
      )
    }
    if (
      account.credential_generation !== input.credentialGeneration
      || account.credential_version !== input.credentialGeneration
      || account.verification_status !== 'verified'
      || account.activation_revision !== input.activationRevision
      || !['shadow', 'active'].includes(account.activation_state)
    ) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_FENCE_STALE',
        'Shopify credential or Operations activation changed',
        409,
      )
    }
    if (account.account_environment !== 'sandbox') {
      fail(
        'SHOPIFY_CHECKOUT_SANDBOX_REQUIRED',
        'This development CarrierService callback supports sandbox Shopify accounts only',
        409,
      )
    }
    const warehouse = await client.query<{ id: string }>(
      `SELECT id::text
       FROM operations_warehouses
       WHERE organization_id = $1::uuid
         AND global_id = $2
       LIMIT 1`,
      [input.organizationId, input.warehouseGlobalId],
    )
    if (!warehouse.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_WAREHOUSE_NOT_FOUND',
        'Selected warehouse was not found',
        404,
      )
    }
    const existing = await client.query<{
      id: string
      global_id: string
      row_version: string
      registration_state: ShopifyCarrierServiceRegistrationState
      service_gid: string | null
    }>(
      `SELECT
         config.id::text,
         config.global_id,
         config.row_version::text,
         config.registration_state,
         config.service_gid
       FROM operations_shopify_carrier_service_configs config
       WHERE config.organization_id = $1::uuid
         AND config.integration_account_id = $2::uuid
       FOR UPDATE`,
      [input.organizationId, account.id],
    )
    const current = existing.rows[0]
    if (
      current
      && (
        input.expectedRowVersion === null
        || Number(current.row_version) !== input.expectedRowVersion
      )
    ) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT',
        'CarrierService configuration changed. Refresh and try again.',
        409,
      )
    }
    if (!current && input.expectedRowVersion !== null) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT',
        'CarrierService configuration does not exist at that version',
        409,
      )
    }
    if (
      current
      && (
        current.registration_state === 'registered'
        || current.service_gid !== null
      )
    ) {
      fail(
        'SHOPIFY_CHECKOUT_REGISTRATION_DISABLE_REQUIRED',
        'Disable the provider CarrierService before changing callback configuration',
        409,
      )
    }
    const configResult = current
      ? await client.query<{ id: string; global_id: string; row_version: string }>(
          `UPDATE operations_shopify_carrier_service_configs
           SET warehouse_id = $3::uuid,
               registration_state = 'unconfigured',
               service_gid = NULL,
               registered_service_name = NULL,
               credential_generation = $4,
               activation_revision = $5,
               callback_token_version = $6,
               callback_token_hash = $7,
               policy_revision = $8,
               policy_hash = $9,
               policy_snapshot = $10::jsonb,
               inventory_max_age_seconds = $11,
               quote_ttl_seconds = $12,
               order_reconciliation_window_seconds = $13,
               algorithm_version = $14,
               last_error_code = NULL,
               row_version = row_version + 1,
               updated_by = $15,
               updated_at = now()
           WHERE organization_id = $1::uuid
             AND id = $2::uuid
           RETURNING id::text, global_id, row_version::text`,
          [
            input.organizationId,
            current.id,
            warehouse.rows[0].id,
            input.credentialGeneration,
            input.activationRevision,
            input.callbackTokenVersion,
            input.callbackTokenHash,
            input.policyRevision,
            input.policyHash,
            JSON.stringify(input.policySnapshot),
            input.inventoryMaxAgeSeconds,
            input.quoteTtlSeconds,
            input.orderReconciliationWindowSeconds,
            input.algorithmVersion,
            input.actorEmail,
          ],
        )
      : await client.query<{ id: string; global_id: string; row_version: string }>(
          `INSERT INTO operations_shopify_carrier_service_configs (
             organization_id, integration_account_id, warehouse_id,
             registration_state, credential_generation, activation_revision,
             callback_token_version, callback_token_hash,
             policy_revision, policy_hash, policy_snapshot,
             inventory_max_age_seconds, quote_ttl_seconds,
             order_reconciliation_window_seconds, algorithm_version,
             created_by, updated_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, 'unconfigured', $4, $5,
             $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $15
           )
           RETURNING id::text, global_id, row_version::text`,
          [
            input.organizationId,
            account.id,
            warehouse.rows[0].id,
            input.credentialGeneration,
            input.activationRevision,
            input.callbackTokenVersion,
            input.callbackTokenHash,
            input.policyRevision,
            input.policyHash,
            JSON.stringify(input.policySnapshot),
            input.inventoryMaxAgeSeconds,
            input.quoteTtlSeconds,
            input.orderReconciliationWindowSeconds,
            input.algorithmVersion,
            input.actorEmail,
          ],
        )
    const config = configResult.rows[0]
    await client.query(
      `DELETE FROM operations_shopify_carrier_service_config_carriers
       WHERE organization_id = $1::uuid AND config_id = $2::uuid`,
      [input.organizationId, config.id],
    )
    await client.query(
      `DELETE FROM operations_shopify_carrier_service_config_materials
       WHERE organization_id = $1::uuid AND config_id = $2::uuid`,
      [input.organizationId, config.id],
    )
    const selectedMaterials = await client.query<{
      id: string
      global_id: string
      row_version: string
    }>(
      `SELECT id::text, global_id, row_version::text
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid
         AND global_id = ANY($2::text[])`,
      [
        input.organizationId,
        input.materials.map((item) => item.materialGlobalId),
      ],
    )
    const materialByGlobalId = new Map(
      selectedMaterials.rows.map((row) => [row.global_id, row]),
    )
    for (const selected of input.materials) {
      const row = materialByGlobalId.get(selected.materialGlobalId)
      if (
        !row
        || Number(row.row_version) !== selected.expectedRowVersion
      ) {
        fail(
          'SHOPIFY_CHECKOUT_MATERIAL_VERSION_CONFLICT',
          `Packaging material ${selected.materialGlobalId} changed or is unavailable`,
          409,
        )
      }
    }
    await client.query(
      `INSERT INTO operations_shopify_carrier_service_config_materials (
         organization_id, config_id, selection_sequence,
         packaging_material_id, packaging_material_row_version
       )
       SELECT
         $1::uuid,
         $2::uuid,
         selected.selection_sequence,
         material.id,
         selected.expected_row_version
       FROM jsonb_to_recordset($3::jsonb) AS selected(
         selection_sequence integer,
         material_global_id text,
         expected_row_version bigint
       )
       JOIN operations_packaging_materials material
         ON material.organization_id = $1::uuid
        AND material.global_id = selected.material_global_id`,
      [
        input.organizationId,
        config.id,
        JSON.stringify(input.materials.map((item) => ({
          selection_sequence: item.selectionSequence,
          material_global_id: item.materialGlobalId,
          expected_row_version: item.expectedRowVersion,
        }))),
      ],
    )
    const selectedCarriers = await client.query<{
      id: string
      global_id: string
      provider: ShopifyCheckoutCarrierProvider
      environment: 'mock' | 'sandbox' | 'production'
    }>(
      `SELECT
         carrier_account.id::text,
         carrier_account.global_id,
         integration.provider,
         integration.environment
       FROM operations_carrier_accounts carrier_account
       JOIN operations_integration_accounts integration
         ON integration.organization_id = carrier_account.organization_id
        AND integration.id = carrier_account.integration_account_id
       WHERE carrier_account.organization_id = $1::uuid
         AND carrier_account.global_id = ANY($2::text[])
         AND integration.integration_type = 'carrier'
         AND integration.provider IN ('ups_rest', 'fedex_rest')
         AND integration.environment = 'sandbox'`,
      [
        input.organizationId,
        input.carriers.map((item) => item.carrierAccountGlobalId),
      ],
    )
    const carrierByGlobalId = new Map(
      selectedCarriers.rows.map((row) => [row.global_id, row]),
    )
    for (const selected of input.carriers) {
      const row = carrierByGlobalId.get(selected.carrierAccountGlobalId)
      if (
        !row
        || row.provider !== selected.provider
        || row.environment !== 'sandbox'
      ) {
        fail(
          'SHOPIFY_CHECKOUT_CARRIER_ACCOUNT_INVALID',
          `Carrier account ${selected.carrierAccountGlobalId} is unavailable`,
          409,
        )
      }
    }
    await client.query(
      `INSERT INTO operations_shopify_carrier_service_config_carriers (
         organization_id, config_id, carrier_provider, carrier_account_id
       )
       SELECT
         $1::uuid,
         $2::uuid,
         selected.provider,
         carrier_account.id
       FROM jsonb_to_recordset($3::jsonb) AS selected(
         provider text,
         carrier_account_global_id text
       )
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id = $1::uuid
        AND carrier_account.global_id
          = selected.carrier_account_global_id`,
      [
        input.organizationId,
        config.id,
        JSON.stringify(input.carriers.map((item) => ({
          provider: item.provider,
          carrier_account_global_id: item.carrierAccountGlobalId,
        }))),
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.shopify_carrier_service.configured',
      aggregateType: 'operations.shopify_carrier_service_config',
      aggregateId: config.global_id,
      subject: input.accountGlobalId,
      organizationId: input.organizationId,
      eventKey:
        `operations:shopify-carrier-service:${config.global_id}:version:${config.row_version}`,
      payload: {
        accountGlobalId: input.accountGlobalId,
        warehouseGlobalId: input.warehouseGlobalId,
        credentialGeneration: input.credentialGeneration,
        activationRevision: input.activationRevision,
        policyRevision: input.policyRevision,
        policyHash: input.policyHash,
        callbackTokenVersion: input.callbackTokenVersion,
        materialGlobalIds: input.materials.map(
          (item) => item.materialGlobalId,
        ),
        carrierAccountGlobalIds: input.carriers.map(
          (item) => item.carrierAccountGlobalId,
        ),
        rowVersion: Number(config.row_version),
      },
    }, client)
    return readConfigWithClient(client, input)
  })
}

/**
 * Updates only the tenant-owned carton-plan/rate objective. Provider
 * registration, service GID, callback token/hash, warehouse, carrier
 * bindings, and material bindings are intentionally outside this command.
 */
export async function updateShopifyCarrierServicePlanRatePolicyInPostgres(
  rawInput: ShopifyCarrierServicePlanRatePolicyWriteInput,
) {
  const input = {
    organizationId: matchValue(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    accountGlobalId: matchValue(
      rawInput.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    expectedRowVersion: integer(
      rawInput.expectedRowVersion,
      'Configuration row version',
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    planRateOptimization: normalizeShopifyCheckoutPlanRatePolicy(
      rawInput.planRateOptimization,
    ),
    actorEmail: textValue(rawInput.actorEmail, 'Actor email', 320),
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-config:${input.organizationId}:${input.accountGlobalId}`,
    )
    const currentResult = await client.query<{
      id: string
      global_id: string
      row_version: string
      policy_revision: string
      policy_hash: string
      policy_snapshot: Record<string, unknown>
      registration_state: ShopifyCarrierServiceRegistrationState
      service_gid: string | null
      callback_token_version: number
      activation_state: string
      account_environment: string
      account_status: string
      credential_generation: number
      credential_version: number | null
      verification_status: string | null
    }>(
      `SELECT
         config.id::text,
         config.global_id,
         config.row_version::text,
         config.policy_revision::text,
         config.policy_hash,
         config.policy_snapshot,
         config.registration_state,
         config.service_gid,
         config.callback_token_version,
         activation.state AS activation_state,
         account.environment AS account_environment,
         account.status AS account_status,
         account.commerce_credential_generation AS credential_generation,
         credential.credential_version,
         credential.verification_status
       FROM operations_shopify_carrier_service_configs config
       JOIN operations_integration_accounts account
         ON account.organization_id = config.organization_id
        AND account.id = config.integration_account_id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = config.organization_id
       LEFT JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE config.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
       FOR UPDATE OF config, account, activation`,
      [input.organizationId, input.accountGlobalId],
    )
    const current = currentResult.rows[0]
    if (!current) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_CONFIG_REQUIRED',
        'Save the Shopify checkout-rating configuration first',
        404,
      )
    }
    if (Number(current.row_version) !== input.expectedRowVersion) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT',
        'CarrierService configuration changed. Refresh and try again.',
        409,
      )
    }
    if (
      current.activation_state !== 'shadow'
      || current.account_environment !== 'sandbox'
      || current.account_status !== 'active'
      || current.verification_status !== 'verified'
      || current.credential_version !== current.credential_generation
    ) {
      fail(
        'SHOPIFY_CHECKOUT_POLICY_SHADOW_REQUIRED',
        'A verified sandbox Shopify account in Operations Shadow is required',
        409,
      )
    }
    const policySnapshot = {
      ...current.policy_snapshot,
      planRateOptimization: input.planRateOptimization,
    }
    assertShopifyCheckoutCustomerNeutralEvidence(
      policySnapshot,
      'CarrierService policy snapshot',
    )
    const policyHash = shopifyCheckoutRatingHash(policySnapshot)
    const updated = await client.query<{
      global_id: string
      row_version: string
      policy_revision: string
    }>(
      `UPDATE operations_shopify_carrier_service_configs
       SET policy_revision = policy_revision + 1,
           policy_hash = $3,
           policy_snapshot = $4::jsonb,
           row_version = row_version + 1,
           updated_by = $5,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND row_version = $6
       RETURNING global_id, row_version::text, policy_revision::text`,
      [
        input.organizationId,
        current.id,
        policyHash,
        JSON.stringify(policySnapshot),
        input.actorEmail,
        input.expectedRowVersion,
      ],
    )
    if (!updated.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT',
        'CarrierService configuration changed. Refresh and try again.',
        409,
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType:
        'operations.shopify_carrier_service.plan_rate_policy_updated',
      aggregateType: 'operations.shopify_carrier_service_config',
      aggregateId: current.global_id,
      subject: input.accountGlobalId,
      organizationId: input.organizationId,
      eventKey:
        `operations:shopify-carrier-service:${current.global_id}:`
        + `plan-rate-policy:${updated.rows[0].policy_revision}`,
      payload: {
        accountGlobalId: input.accountGlobalId,
        priorPolicyRevision: Number(current.policy_revision),
        policyRevision: Number(updated.rows[0].policy_revision),
        priorPolicyHash: current.policy_hash,
        policyHash,
        registrationState: current.registration_state,
        providerRegistrationRetained: true,
        serviceGidRetained: current.service_gid,
        callbackTokenVersionRetained: current.callback_token_version,
        callbackTokenHashRetained: true,
        rowVersion: Number(updated.rows[0].row_version),
      },
    }, client)
    return readConfigWithClient(client, input)
  })
}

/**
 * Updates only the customer-neutral tenant rate-warming policy. Enabling is
 * constrained below to a verified sandbox account while Operations is in
 * Shadow; the storefront app proxy separately restricts reads to an exact
 * Shopify Customer GID with a simulated Checkout audience policy.
 */
export async function updateShopifyCarrierServiceRateWarmPolicyInPostgres(
  rawInput: ShopifyCarrierServiceRateWarmPolicyWriteInput,
) {
  const input = {
    organizationId: matchValue(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    accountGlobalId: matchValue(
      rawInput.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    expectedRowVersion: integer(
      rawInput.expectedRowVersion,
      'Configuration row version',
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    checkoutRateWarm: normalizeShopifyCheckoutRateWarmPolicy(
      rawInput.checkoutRateWarm,
    ),
    actorEmail: textValue(rawInput.actorEmail, 'Actor email', 320),
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-config:${input.organizationId}:${input.accountGlobalId}`,
    )
    const currentResult = await client.query<{
      id: string
      global_id: string
      row_version: string
      policy_revision: string
      policy_hash: string
      policy_snapshot: Record<string, unknown>
      registration_state: ShopifyCarrierServiceRegistrationState
      service_gid: string | null
      callback_token_version: number
      activation_state: string
      account_environment: string
      account_status: string
      credential_generation: number
      credential_version: number | null
      verification_status: string | null
    }>(
      `SELECT
         config.id::text,
         config.global_id,
         config.row_version::text,
         config.policy_revision::text,
         config.policy_hash,
         config.policy_snapshot,
         config.registration_state,
         config.service_gid,
         config.callback_token_version,
         activation.state AS activation_state,
         account.environment AS account_environment,
         account.status AS account_status,
         account.commerce_credential_generation AS credential_generation,
         credential.credential_version,
         credential.verification_status
       FROM operations_shopify_carrier_service_configs config
       JOIN operations_integration_accounts account
         ON account.organization_id = config.organization_id
        AND account.id = config.integration_account_id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = config.organization_id
       LEFT JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE config.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
       FOR UPDATE OF config, account, activation`,
      [input.organizationId, input.accountGlobalId],
    )
    const current = currentResult.rows[0]
    if (!current) {
      fail(
        'SHOPIFY_CARRIER_SERVICE_CONFIG_REQUIRED',
        'Save the Shopify checkout-rating configuration first',
        404,
      )
    }
    if (Number(current.row_version) !== input.expectedRowVersion) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT',
        'CarrierService configuration changed. Refresh and try again.',
        409,
      )
    }
    if (
      current.activation_state !== 'shadow'
      || current.account_environment !== 'sandbox'
      || current.account_status !== 'active'
      || current.verification_status !== 'verified'
      || current.credential_version !== current.credential_generation
    ) {
      fail(
        'SHOPIFY_CHECKOUT_RATE_WARM_POLICY_SHADOW_REQUIRED',
        'A verified sandbox Shopify account in Operations Shadow is required',
        409,
      )
    }
    const policySnapshot = {
      ...current.policy_snapshot,
      checkoutRateWarm: input.checkoutRateWarm,
    }
    assertShopifyCheckoutCustomerNeutralEvidence(
      policySnapshot,
      'CarrierService policy snapshot',
    )
    const policyHash = shopifyCheckoutRatingHash(policySnapshot)
    const updated = await client.query<{
      global_id: string
      row_version: string
      policy_revision: string
    }>(
      `UPDATE operations_shopify_carrier_service_configs
       SET policy_revision = policy_revision + 1,
           policy_hash = $3,
           policy_snapshot = $4::jsonb,
           row_version = row_version + 1,
           updated_by = $5,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND row_version = $6
       RETURNING global_id, row_version::text, policy_revision::text`,
      [
        input.organizationId,
        current.id,
        policyHash,
        JSON.stringify(policySnapshot),
        input.actorEmail,
        input.expectedRowVersion,
      ],
    )
    if (!updated.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT',
        'CarrierService configuration changed. Refresh and try again.',
        409,
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType:
        'operations.shopify_carrier_service.rate_warm_policy_updated',
      aggregateType: 'operations.shopify_carrier_service_config',
      aggregateId: current.global_id,
      subject: input.accountGlobalId,
      organizationId: input.organizationId,
      eventKey:
        `operations:shopify-carrier-service:${current.global_id}:`
        + `rate-warm-policy:${updated.rows[0].policy_revision}`,
      payload: {
        accountGlobalId: input.accountGlobalId,
        priorPolicyRevision: Number(current.policy_revision),
        policyRevision: Number(updated.rows[0].policy_revision),
        priorPolicyHash: current.policy_hash,
        policyHash,
        enabled: input.checkoutRateWarm.enabled,
        registrationState: current.registration_state,
        providerRegistrationRetained: true,
        serviceGidRetained: current.service_gid,
        callbackTokenVersionRetained: current.callback_token_version,
        callbackTokenHashRetained: true,
        rowVersion: Number(updated.rows[0].row_version),
      },
    }, client)
    return readConfigWithClient(client, input)
  })
}

export async function finalizeShopifyCarrierServiceRegistrationInPostgres(
  rawInput: {
    organizationId: string
    accountGlobalId: string
    expectedRowVersion: number
    activationRevision?: number
    registrationState:
      | 'shadow_simulated'
      | 'registered'
      | 'disabled'
      | 'error'
    serviceGid?: string | null
    lastErrorCode?: string | null
    actorEmail: string
  },
) {
  const input = {
    ...rawInput,
    organizationId: matchValue(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    accountGlobalId: matchValue(
      rawInput.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    expectedRowVersion: integer(
      rawInput.expectedRowVersion,
      'Configuration row version',
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    activationRevision: rawInput.activationRevision === undefined
      ? null
      : integer(
          rawInput.activationRevision,
          'Activation revision',
          1,
          Number.MAX_SAFE_INTEGER,
        ),
    serviceGid: rawInput.serviceGid === undefined
      || rawInput.serviceGid === null
      ? null
      : matchValue(rawInput.serviceGid, SHOPIFY_SERVICE_GID, 'Service GID'),
    lastErrorCode: rawInput.lastErrorCode === undefined
      || rawInput.lastErrorCode === null
      ? null
      : textValue(rawInput.lastErrorCode, 'Registration error code', 128),
    actorEmail: textValue(rawInput.actorEmail, 'Actor email', 320),
  }
  if (
    (input.registrationState === 'registered' && !input.serviceGid)
    || (input.registrationState === 'shadow_simulated' && input.serviceGid)
    || (input.registrationState === 'disabled' && input.serviceGid)
    || (input.registrationState === 'error' && !input.lastErrorCode)
    || (
      input.registrationState !== 'error'
      && input.lastErrorCode
    )
  ) {
    fail(
      'SHOPIFY_CHECKOUT_REGISTRATION_STATE_INVALID',
      'CarrierService registration result is internally inconsistent',
    )
  }
  if (
    input.registrationState === 'registered'
    || input.registrationState === 'disabled'
  ) {
    fail(
      'SHOPIFY_CHECKOUT_SCOPED_MUTATION_FINALIZER_REQUIRED',
      'Registered or disabled Shopify provider state requires the exact one-time mutation finalizer',
      409,
    )
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-carrier-service-config:${input.organizationId}:${input.accountGlobalId}`,
    )
    const current = await readConfigWithClient(client, input)
    if (!current) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_NOT_FOUND',
        'CarrierService configuration was not found',
        404,
      )
    }
    if (current.rowVersion !== input.expectedRowVersion) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT',
        'CarrierService configuration changed. Refresh and try again.',
        409,
      )
    }
    if (
      current.registrationState === 'registered'
      || current.serviceGid !== null
    ) {
      fail(
        'SHOPIFY_CHECKOUT_EXACT_DELETE_REQUIRED',
        'The exact registered Shopify CarrierService must be removed through its one-time delete transition',
        409,
      )
    }
    if (
      ['shadow_simulated', 'registered'].includes(input.registrationState)
      && (
        current.accountEnvironment !== 'sandbox'
        || current.carriers.length !== 2
        || current.carriers.some(
          (carrier) => carrier.environment !== 'sandbox',
        )
      )
    ) {
      fail(
        'SHOPIFY_CHECKOUT_SANDBOX_REQUIRED',
        'This development CarrierService callback can register sandbox accounts only',
        409,
      )
    }
    const retainedServiceGid = input.registrationState === 'error'
      && current.serviceGid
      ? current.serviceGid
      : input.serviceGid
    const activation = await client.query<{
      revision: number
      state: string
    }>(
      `SELECT revision, state
       FROM operations_activation_scopes
       WHERE organization_id = $1::uuid
       FOR SHARE`,
      [input.organizationId],
    )
    const currentActivation = activation.rows[0]
    if (
      !currentActivation
      || (
        input.activationRevision !== null
        && input.activationRevision !== currentActivation.revision
      )
    ) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_FENCE_STALE',
        'Operations activation changed before registration finalization',
        409,
      )
    }
    const updated = await client.query<{
      global_id: string
      row_version: string
    }>(
      `UPDATE operations_shopify_carrier_service_configs
       SET registration_state = $3,
           service_gid = $4,
           registered_service_name = NULL,
           last_error_code = $5,
           activation_revision = $6,
           row_version = row_version + 1,
           updated_by = $7,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND row_version = $8
       RETURNING global_id, row_version::text`,
      [
        input.organizationId,
        current.id,
        input.registrationState,
        retainedServiceGid,
        input.lastErrorCode,
        currentActivation.revision,
        input.actorEmail,
        input.expectedRowVersion,
      ],
    )
    if (!updated.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT',
        'CarrierService configuration changed. Refresh and try again.',
        409,
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType:
        `operations.shopify_carrier_service.${input.registrationState}`,
      aggregateType: 'operations.shopify_carrier_service_config',
      aggregateId: updated.rows[0].global_id,
      subject: input.accountGlobalId,
      organizationId: input.organizationId,
      eventKey:
        `operations:shopify-carrier-service:${updated.rows[0].global_id}:version:${updated.rows[0].row_version}`,
      payload: {
        accountGlobalId: input.accountGlobalId,
        registrationState: input.registrationState,
        serviceGid: retainedServiceGid,
        lastErrorCode: input.lastErrorCode,
        activationRevision: currentActivation.revision,
        rowVersion: Number(updated.rows[0].row_version),
      },
    }, client)
    return readConfigWithClient(client, input)
  })
}

export async function lookupShopifyCheckoutRatingAccountByGlobalIdInPostgres(
  rawInput: {
    accountGlobalId: string
    callbackTokenHash: string
    allowShadowSimulation?: boolean
  },
): Promise<ShopifyCheckoutRatingAccount | null> {
  const input = {
    accountGlobalId: matchValue(
      rawInput.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    callbackTokenHash: matchValue(
      rawInput.callbackTokenHash,
      SHA256,
      'Callback token hash',
    ),
    allowShadowSimulation: rawInput.allowShadowSimulation === true,
  }
  const result = await query<CallbackAccountRow>(
    `SELECT
       config.organization_id::text,
       config.integration_account_id::text,
       account.global_id AS account_global_id,
       CASE
         WHEN config.registration_state = 'registered'
           THEN config.registered_service_name
         ELSE COALESCE(
           NULLIF(
             regexp_replace(
               btrim(config.checkout_brand_name_override),
               '[[:space:]]+', ' ', 'g'
             ),
             ''
           ),
           NULLIF(
             regexp_replace(
               btrim(account.configuration ->> 'accountName'),
               '[[:space:]]+', ' ', 'g'
             ),
             ''
           )
         )
       END AS store_entity_name,
       account.environment,
       account.external_account_id,
       config.registration_state,
       config.id::text AS config_id,
       config.global_id AS config_global_id,
       config.row_version::text AS config_row_version,
       config.credential_generation,
       config.activation_revision AS registration_activation_revision,
       activation.state AS activation_state,
       activation.revision AS activation_revision,
       config.callback_token_version,
       config.policy_revision::text,
       config.policy_hash,
       config.policy_snapshot,
       config.warehouse_id::text,
       warehouse.global_id AS warehouse_global_id,
       warehouse.name AS warehouse_name,
       warehouse.timezone AS warehouse_timezone,
       warehouse.address AS warehouse_address,
       config.inventory_max_age_seconds,
       config.quote_ttl_seconds,
       config.order_reconciliation_window_seconds,
       config.algorithm_version
     FROM operations_shopify_carrier_service_configs config
     JOIN operations_integration_accounts account
       ON account.organization_id = config.organization_id
      AND account.id = config.integration_account_id
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = config.organization_id
      AND warehouse.id = config.warehouse_id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = config.organization_id
     WHERE account.global_id = $1
       AND config.callback_token_hash = $2
       AND account.environment = 'sandbox'
       AND COALESCE(
         NULLIF(
           regexp_replace(
             btrim(config.checkout_brand_name_override),
             '[[:space:]]+', ' ', 'g'
           ),
           ''
         ),
         NULLIF(
           regexp_replace(
             btrim(account.configuration ->> 'accountName'),
             '[[:space:]]+', ' ', 'g'
           ),
           ''
         )
       ) IS NOT NULL
       AND (
         (
           config.registration_state = 'registered'
           AND config.registered_service_name IS NOT DISTINCT FROM
             COALESCE(
               NULLIF(
                 regexp_replace(
                   btrim(config.checkout_brand_name_override),
                   '[[:space:]]+', ' ', 'g'
                 ),
                 ''
               ),
               NULLIF(
                 regexp_replace(
                   btrim(account.configuration ->> 'accountName'),
                   '[[:space:]]+', ' ', 'g'
                 ),
                 ''
               )
             )
         )
         OR (
           $3::boolean = true
           AND config.registration_state = 'shadow_simulated'
         )
       )
       AND operations_shopify_carrier_service_config_is_ready(
         config.organization_id, config.id
       )
     LIMIT 1`,
    [
      input.accountGlobalId,
      input.callbackTokenHash,
      input.allowShadowSimulation,
    ],
  )
  const row = result.rows[0]
  if (!row) return null
  const children = await readConfigChildren(null, {
    organizationId: row.organization_id,
    configId: row.config_id,
  })
  return {
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    accountGlobalId: row.account_global_id,
    storeEntityName: textValue(
      row.store_entity_name,
      'Provider-verified Shopify store entity name',
      255,
    ),
    environment: row.environment,
    externalAccountId: row.external_account_id,
    registrationState: row.registration_state,
    configGlobalId: row.config_global_id,
    configRowVersion: Number(row.config_row_version),
    credentialGeneration: row.credential_generation,
    registrationActivationRevision: row.registration_activation_revision,
    activationState: row.activation_state,
    activationRevision: row.activation_revision,
    callbackTokenVersion: row.callback_token_version,
    policyRevision: Number(row.policy_revision),
    policyHash: row.policy_hash,
    policySnapshot: row.policy_snapshot,
    warehouseId: row.warehouse_id,
    warehouseGlobalId: row.warehouse_global_id,
    warehouseName: row.warehouse_name,
    warehouseTimezone: row.warehouse_timezone,
    warehouseAddress: row.warehouse_address,
    inventoryMaxAgeSeconds: row.inventory_max_age_seconds,
    quoteTtlSeconds: row.quote_ttl_seconds,
    orderReconciliationWindowSeconds:
      row.order_reconciliation_window_seconds,
    algorithmVersion: row.algorithm_version,
    materials: children.materials,
    carriers: children.carriers,
  }
}

const RECEIPT_SELECT = `SELECT
    receipt.id::text,
    receipt.global_id,
    receipt.organization_id::text,
    receipt.integration_account_id::text,
    account.global_id AS account_global_id,
    receipt.config_id::text,
    config.global_id AS config_global_id,
    receipt.config_row_version::text,
    receipt.credential_generation,
    receipt.activation_state,
    receipt.activation_revision,
    receipt.policy_revision::text,
    receipt.policy_hash,
    receipt.warehouse_id::text,
    warehouse.global_id AS warehouse_global_id,
    receipt.algorithm_version,
    receipt.request_fingerprint,
    receipt.destination_fingerprint,
    receipt.carrier_destination_fingerprint,
    receipt.line_quantity_fingerprint,
    receipt.request_evidence_hash,
    receipt.redacted_request_snapshot,
    receipt.currency,
    receipt.idempotency_key,
    receipt.status,
    receipt.lease_token::text,
    receipt.lease_expires_at,
    receipt.claimed_by,
    receipt.attempt_count,
    receipt.package_plan_hash,
    receipt.result_hash,
    receipt.result_snapshot,
    receipt.error_code,
    receipt.provider_write_count,
    receipt.inventory_snapshot_hash,
    receipt.inventory_snapshot_at,
    receipt.inventory_refresh_version::text,
    receipt.reconciliation_window_seconds,
    receipt.reconciliation_deadline_at,
    receipt.expires_at,
    receipt.completed_at,
    receipt.created_at,
    receipt.updated_at
  FROM operations_shopify_checkout_rate_receipts receipt
  JOIN operations_integration_accounts account
    ON account.organization_id = receipt.organization_id
   AND account.id = receipt.integration_account_id
  JOIN operations_shopify_carrier_service_configs config
    ON config.organization_id = receipt.organization_id
   AND config.id = receipt.config_id
  JOIN operations_warehouses warehouse
    ON warehouse.organization_id = receipt.organization_id
   AND warehouse.id = receipt.warehouse_id`

async function readReceiptChildren(
  client: PoolClient | null,
  input: { organizationId: string; receiptId: string },
) {
  const run = <T extends QueryResultRow>(sql: string, values: unknown[]) => (
    client ? client.query<T>(sql, values) : query<T>(sql, values)
  )
  const [
    lineResult,
    packageResult,
    allocationResult,
    offerResult,
    providerAttemptResult,
  ] = await runHydrationQueries(client, [
      () => run<QueryResultRow & {
        line_key: string
        provider_variant_id: string
        sku: string | null
        quantity: number
        unit_weight_grams: number
        requires_shipping: boolean
        line_hash: string
        line_snapshot: Record<string, unknown>
      }>(
        `SELECT
           line_key, provider_variant_id, sku, quantity,
           unit_weight_grams, requires_shipping, line_hash, line_snapshot
         FROM operations_shopify_checkout_rate_receipt_lines
         WHERE organization_id = $1::uuid AND receipt_id = $2::uuid
         ORDER BY line_key`,
        [input.organizationId, input.receiptId],
      ),
      () => run<QueryResultRow & {
        package_key: string
        package_sequence: number
        planning_method: 'approved_recipe' | 'self_package'
        material_global_id: string | null
        packaging_material_row_version: string | number | null
        material_stock_global_id: string | null
        packaging_material_stock_row_version: string | number | null
        packaging_material_stock_on_hand_quantity: number | null
        pack_profile_version_global_id: string | null
        pack_profile_version_row_version: string | number | null
        self_package_line_key: string | null
        rated_outer_length_mm: number
        rated_outer_width_mm: number
        rated_outer_height_mm: number
        content_weight_grams: number
        tare_weight_grams: number
        gross_weight_grams: number
        carrier_parcel_snapshot: Record<string, unknown>
        package_hash: string
        package_snapshot: Record<string, unknown>
      }>(
        `SELECT
           package.package_key,
           package.package_sequence,
           package.planning_method,
           material.global_id AS material_global_id,
           package.packaging_material_row_version::text,
           stock.global_id AS material_stock_global_id,
           package.packaging_material_stock_row_version::text,
           package.packaging_material_stock_on_hand_quantity,
           profile_version.global_id AS pack_profile_version_global_id,
           package.pack_profile_version_row_version::text,
           package.self_package_line_key,
           package.rated_outer_length_mm,
           package.rated_outer_width_mm,
           package.rated_outer_height_mm,
           package.content_weight_grams,
           package.tare_weight_grams,
           package.gross_weight_grams,
           package.carrier_parcel_snapshot,
           package.package_hash,
           package.package_snapshot
         FROM operations_shopify_checkout_rate_receipt_packages package
         LEFT JOIN operations_packaging_materials material
           ON material.organization_id = package.organization_id
          AND material.id = package.packaging_material_id
         LEFT JOIN operations_packaging_material_stock stock
           ON stock.organization_id = package.organization_id
          AND stock.id = package.packaging_material_stock_id
         LEFT JOIN operations_product_pack_profile_versions profile_version
           ON profile_version.organization_id = package.organization_id
          AND profile_version.id = package.pack_profile_version_id
         WHERE package.organization_id = $1::uuid
           AND package.receipt_id = $2::uuid
         ORDER BY package.package_sequence, package.package_key`,
        [input.organizationId, input.receiptId],
      ),
      () => run<QueryResultRow & {
        package_key: string
        line_key: string
        quantity: number
        allocation_hash: string
      }>(
        `SELECT package_key, line_key, quantity, allocation_hash
         FROM operations_shopify_checkout_rate_receipt_allocations
         WHERE organization_id = $1::uuid AND receipt_id = $2::uuid
         ORDER BY package_key, line_key`,
        [input.organizationId, input.receiptId],
      ),
      () => run<QueryResultRow & {
        carrier_provider: ShopifyCheckoutCarrierProvider
        carrier_account_global_id: string
        credential_version: number
        rate_evidence_global_id: string
        carrier_request_hash: string
        carrier_response_rate_hash: string
        shopify_service_code: string
        service_code: string
        service_name: string
        carrier_cost_minor: string | number
        customer_charge_minor: string | number
        checkout_adjustment_minor: string | number
        checkout_adjustment_kind: 'none' | 'subsidy'
        checkout_adjustment_reason: string | null
        currency: string
        package_count: number
        package_plan_hash: string
        min_delivery_date: string | null
        max_delivery_date: string | null
        offer_hash: string
        offer_snapshot: Record<string, unknown>
      }>(
        `SELECT
           offer.carrier_provider,
           carrier_account.global_id AS carrier_account_global_id,
           rate_evidence.credential_version,
           rate_evidence.global_id AS rate_evidence_global_id,
           offer.carrier_request_hash,
           offer.carrier_response_rate_hash,
           offer.shopify_service_code,
           offer.service_code, offer.service_name,
           carrier_cost_minor::text, customer_charge_minor::text,
           checkout_adjustment_minor::text,
           checkout_adjustment_kind, checkout_adjustment_reason,
           currency, package_count, package_plan_hash,
           min_delivery_date::text, max_delivery_date::text,
           offer_hash, offer_snapshot
         FROM operations_shopify_checkout_rate_receipt_offers offer
         JOIN operations_carrier_accounts carrier_account
           ON carrier_account.organization_id = offer.organization_id
          AND carrier_account.id = offer.carrier_account_id
         JOIN operations_carrier_rate_requests rate_evidence
           ON rate_evidence.organization_id = offer.organization_id
          AND rate_evidence.id = offer.carrier_rate_request_id
         WHERE offer.organization_id = $1::uuid
           AND offer.receipt_id = $2::uuid
         ORDER BY offer.carrier_provider, offer.service_code`,
        [input.organizationId, input.receiptId],
      ),
      () => run<QueryResultRow & {
        carrier_provider: ShopifyCheckoutCarrierProvider
        carrier_account_global_id: string
        credential_version: number
        rate_evidence_global_id: string
        carrier_request_hash: string
        attempt_status: 'succeeded' | 'degraded'
        failure_code: string | null
        attempt_hash: string
        attempt_snapshot: Record<string, unknown>
      }>(
        `SELECT
           attempt.carrier_provider,
           carrier_account.global_id AS carrier_account_global_id,
           rate_evidence.credential_version,
           rate_evidence.global_id AS rate_evidence_global_id,
           attempt.carrier_request_hash,
           attempt.attempt_status,
           attempt.failure_code,
           attempt.attempt_hash,
           attempt.attempt_snapshot
         FROM
           operations_shopify_checkout_rate_receipt_provider_attempts
             attempt
         JOIN operations_carrier_accounts carrier_account
           ON carrier_account.organization_id = attempt.organization_id
          AND carrier_account.id = attempt.carrier_account_id
         JOIN operations_carrier_rate_requests rate_evidence
           ON rate_evidence.organization_id = attempt.organization_id
          AND rate_evidence.id = attempt.carrier_rate_request_id
         WHERE attempt.organization_id = $1::uuid
           AND attempt.receipt_id = $2::uuid
         ORDER BY attempt.carrier_provider`,
        [input.organizationId, input.receiptId],
      ),
    ] as const)
  const allocations = new Map<string, Array<{
    lineKey: string
    quantity: number
    allocationHash: string
  }>>()
  for (const row of allocationResult.rows) {
    const list = allocations.get(row.package_key) || []
    list.push({
      lineKey: row.line_key,
      quantity: row.quantity,
      allocationHash: row.allocation_hash,
    })
    allocations.set(row.package_key, list)
  }
  return {
    lines: lineResult.rows.map((row) => hydrateShopifyCheckoutRateReceiptLine({
      lineKey: row.line_key,
      providerVariantId: row.provider_variant_id,
      sku: row.sku,
      quantity: row.quantity,
      unitWeightGrams: row.unit_weight_grams,
      requiresShipping: row.requires_shipping,
      lineHash: row.line_hash,
      lineSnapshot: row.line_snapshot,
    })),
    packages: packageResult.rows.map((row): ShopifyCheckoutRateReceiptPackage => {
      const common = {
        packageKey: row.package_key,
        packageSequence: row.package_sequence,
        ratedOuterDimensionsMm: {
          length: row.rated_outer_length_mm,
          width: row.rated_outer_width_mm,
          height: row.rated_outer_height_mm,
        },
        contentWeightGrams: row.content_weight_grams,
        tareWeightGrams: row.tare_weight_grams,
        grossWeightGrams: row.gross_weight_grams,
        carrierParcelSnapshot: row.carrier_parcel_snapshot,
        packageHash: row.package_hash,
        packageSnapshot: row.package_snapshot,
        allocations: allocations.get(row.package_key) || [],
      }
      if (row.planning_method === 'self_package') {
        if (
          !row.pack_profile_version_global_id
          || row.pack_profile_version_row_version === null
          || !row.self_package_line_key
        ) {
          throw new Error('Stored self-package evidence is incomplete')
        }
        return {
          ...common,
          planningMethod: 'self_package',
          materialGlobalId: null,
          materialRowVersion: null,
          materialStockGlobalId: null,
          materialStockRowVersion: null,
          materialStockOnHandQuantity: null,
          packProfileVersionGlobalId:
            row.pack_profile_version_global_id,
          packProfileVersionRowVersion:
            Number(row.pack_profile_version_row_version),
          selfPackageLineKey: row.self_package_line_key,
        }
      }
      if (
        !row.material_global_id
        || row.packaging_material_row_version === null
        || !row.material_stock_global_id
        || row.packaging_material_stock_row_version === null
        || row.packaging_material_stock_on_hand_quantity === null
      ) {
        throw new Error('Stored approved-recipe package evidence is incomplete')
      }
      return {
        ...common,
        planningMethod: 'approved_recipe',
        materialGlobalId: row.material_global_id,
        materialRowVersion: Number(row.packaging_material_row_version),
        materialStockGlobalId: row.material_stock_global_id,
        materialStockRowVersion:
          Number(row.packaging_material_stock_row_version),
        materialStockOnHandQuantity:
          row.packaging_material_stock_on_hand_quantity,
        packProfileVersionGlobalId: null,
        packProfileVersionRowVersion: null,
        selfPackageLineKey: null,
      }
    }),
    providerAttempts: providerAttemptResult.rows.map(
      (row): ShopifyCheckoutRateReceiptProviderAttempt => ({
        provider: row.carrier_provider,
        carrierAccountGlobalId: row.carrier_account_global_id,
        credentialVersion: row.credential_version,
        rateEvidenceGlobalId: row.rate_evidence_global_id,
        carrierRequestHash: row.carrier_request_hash,
        status: row.attempt_status,
        failureCode: row.failure_code,
        attemptHash: row.attempt_hash,
        attemptSnapshot: row.attempt_snapshot,
      }),
    ),
    offers: offerResult.rows.map(
      (row): ShopifyCheckoutRateReceiptOffer => ({
        provider: row.carrier_provider,
        carrierAccountGlobalId: row.carrier_account_global_id,
        credentialVersion: row.credential_version,
        rateEvidenceGlobalId: row.rate_evidence_global_id,
        carrierRequestHash: row.carrier_request_hash,
        carrierResponseRateHash: row.carrier_response_rate_hash,
        shopifyServiceCode: row.shopify_service_code,
        serviceCode: row.service_code,
        serviceName: row.service_name,
        carrierCostMinor: Number(row.carrier_cost_minor),
        customerChargeMinor: Number(row.customer_charge_minor),
        checkoutAdjustmentMinor: Number(row.checkout_adjustment_minor),
        checkoutAdjustmentKind: row.checkout_adjustment_kind,
        checkoutAdjustmentReason: row.checkout_adjustment_reason,
        currency: row.currency,
        packageCount: row.package_count,
        packagePlanHash: row.package_plan_hash,
        minDeliveryDate: row.min_delivery_date,
        maxDeliveryDate: row.max_delivery_date,
        offerHash: row.offer_hash,
        offerSnapshot: row.offer_snapshot,
      }),
    ),
  }
}

async function receiptFromRow(
  client: PoolClient | null,
  row: ReceiptRow,
): Promise<ShopifyCheckoutRateReceipt> {
  const children = await readReceiptChildren(client, {
    organizationId: row.organization_id,
    receiptId: row.id,
  })
  return {
    id: row.id,
    globalId: row.global_id,
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    accountGlobalId: row.account_global_id,
    configId: row.config_id,
    configGlobalId: row.config_global_id,
    configRowVersion: Number(row.config_row_version),
    credentialGeneration: row.credential_generation,
    activationState: row.activation_state,
    activationRevision: row.activation_revision,
    policyRevision: Number(row.policy_revision),
    policyHash: row.policy_hash,
    warehouseId: row.warehouse_id,
    warehouseGlobalId: row.warehouse_global_id,
    algorithmVersion: row.algorithm_version,
    requestFingerprint: row.request_fingerprint,
    destinationFingerprint: row.destination_fingerprint,
    carrierDestinationFingerprint:
      row.carrier_destination_fingerprint,
    lineQuantityFingerprint: row.line_quantity_fingerprint,
    requestEvidenceHash: row.request_evidence_hash,
    redactedRequestSnapshot: row.redacted_request_snapshot,
    currency: row.currency,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    leaseToken: row.lease_token,
    leaseExpiresAt: iso(row.lease_expires_at),
    claimedBy: row.claimed_by,
    attemptCount: row.attempt_count,
    packagePlanHash: row.package_plan_hash,
    resultHash: row.result_hash,
    resultSnapshot: row.result_snapshot,
    errorCode: row.error_code,
    providerWriteCount: 0,
    inventorySnapshotHash: row.inventory_snapshot_hash,
    inventorySnapshotAt: iso(row.inventory_snapshot_at) as string,
    inventoryRefreshVersion: Number(row.inventory_refresh_version),
    reconciliationWindowSeconds: row.reconciliation_window_seconds,
    reconciliationDeadlineAt:
      iso(row.reconciliation_deadline_at) as string,
    expiresAt: iso(row.expires_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    ...children,
  }
}

async function readReceiptByGlobalId(
  client: PoolClient | null,
  input: { organizationId: string; receiptGlobalId: string },
) {
  const result = client
    ? await client.query<ReceiptRow>(
        `${RECEIPT_SELECT}
         WHERE receipt.organization_id = $1::uuid
           AND receipt.global_id = $2`,
        [input.organizationId, input.receiptGlobalId],
      )
    : await query<ReceiptRow>(
        `${RECEIPT_SELECT}
         WHERE receipt.organization_id = $1::uuid
           AND receipt.global_id = $2`,
        [input.organizationId, input.receiptGlobalId],
      )
  return result.rows[0]
    ? receiptFromRow(client, result.rows[0])
    : null
}

function assertIdempotentReceipt(
  row: ReceiptRow,
  input: NormalizedShopifyCheckoutReceiptClaimInput,
) {
  if (
    row.request_fingerprint !== input.requestFingerprint
    || row.destination_fingerprint !== input.destinationFingerprint
    || row.carrier_destination_fingerprint
      !== input.carrierDestinationFingerprint
    || row.line_quantity_fingerprint !== input.lineQuantityFingerprint
    || row.request_evidence_hash !== input.requestEvidenceHash
    || row.inventory_snapshot_hash !== input.inventorySnapshotHash
    || row.currency !== input.currency
  ) {
    fail(
      'SHOPIFY_CHECKOUT_IDEMPOTENCY_CONFLICT',
      'Idempotency key was already used for a different checkout request',
      409,
    )
  }
}

async function lockCleanShopifyInventoryRefreshVersion(
  client: PoolClient,
  input: { organizationId: string; integrationAccountId: string },
) {
  await acquireTransactionAdvisoryLock(
    client,
    `shopify-inventory-watermark:${input.organizationId}:${input.integrationAccountId}`,
  )
  const result = await client.query<{
    dirty_version: string
    reconciled_version: string
  }>(
    `SELECT dirty_version::text, reconciled_version::text
     FROM operations_shopify_inventory_refresh_watermarks
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
     LIMIT 1
     FOR SHARE`,
    [input.organizationId, input.integrationAccountId],
  )
  const row = result.rows[0]
  if (!row) return 0
  const dirtyVersion = Number(row.dirty_version)
  const reconciledVersion = Number(row.reconciled_version)
  if (
    !Number.isSafeInteger(dirtyVersion)
    || !Number.isSafeInteger(reconciledVersion)
    || dirtyVersion !== reconciledVersion
  ) {
    fail(
      'SHOPIFY_CHECKOUT_INVENTORY_REFRESH_PENDING',
      'Shopify inventory changed and authoritative reconciliation is pending',
      409,
    )
  }
  return dirtyVersion
}

async function claimShopifyCheckoutRateReceiptOnceInPostgres(
  input: NormalizedShopifyCheckoutReceiptClaimInput,
): Promise<ShopifyCheckoutRateReceiptClaim> {
  return withShopifyCheckoutDeadlineTransaction(
    input.deadlineAt,
    async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-checkout-receipt:${input.organizationId}:${input.accountGlobalId}:${input.requestFingerprint}`,
    )
    const configRow = await readConfigRowWithClient(client, input)
    const config = configRow
      ? checkoutReceiptClaimConfig(configRow)
      : null
    if (
      !config
      || !config.ready
      || !['shadow_simulated', 'registered'].includes(
        config.registrationState,
      )
    ) {
      fail(
        'SHOPIFY_CHECKOUT_CONFIG_NOT_READY',
        'Shopify checkout rating is not configured',
        409,
      )
    }
    if (config.rowVersion !== input.expectedConfigRowVersion) {
      fail(
        'SHOPIFY_CHECKOUT_CONTEXT_STALE',
        'CarrierService configuration changed before checkout claim',
        409,
      )
    }
    const activationResult = await client.query<{
      state: 'shadow' | 'active'
      revision: number
    }>(
      `SELECT state, revision
       FROM operations_activation_scopes
       WHERE organization_id = $1::uuid
         AND state IN ('shadow', 'active')
       FOR SHARE`,
      [input.organizationId],
    )
    const activation = activationResult.rows[0]
    if (!activation) {
      fail(
        'SHOPIFY_CHECKOUT_ACTIVATION_NOT_READY',
        'Operations must be in Shadow or Active for checkout rating',
        409,
      )
    }
    if (
      activation.state !== input.expectedActivationState
      || activation.revision !== input.expectedActivationRevision
    ) {
      fail(
        'SHOPIFY_CHECKOUT_CONTEXT_STALE',
        'Operations activation changed before checkout claim',
        409,
      )
    }
    const inventoryRefreshVersion =
      await lockCleanShopifyInventoryRefreshVersion(client, {
        organizationId: input.organizationId,
        integrationAccountId: config.integrationAccountId,
      })
    const cached = await client.query<ReceiptRow>(
      `${RECEIPT_SELECT}
       WHERE receipt.organization_id = $1::uuid
         AND receipt.integration_account_id = $2::uuid
         AND receipt.request_fingerprint = $3
         AND receipt.policy_hash = $4
         AND receipt.config_id = $5::uuid
         AND receipt.config_row_version = $6
         AND receipt.inventory_snapshot_hash = $7
         AND receipt.inventory_snapshot_at >= now() - make_interval(secs => $8)
         AND receipt.activation_revision = $9
         AND receipt.activation_state = $10
         AND receipt.inventory_refresh_version = $12::bigint
         AND (
           receipt.idempotency_key = $11
           OR left(receipt.idempotency_key, length($11) + 9)
             = $11 || ':attempt:'
         )
         AND receipt.status IN ('succeeded', 'failed')
         AND receipt.expires_at > now()
       ORDER BY receipt.completed_at DESC, receipt.id
       LIMIT 1
       FOR SHARE OF receipt`,
      [
        input.organizationId,
        config.integrationAccountId,
        input.requestFingerprint,
        config.policyHash,
        config.id,
        config.rowVersion,
        input.inventorySnapshotHash,
        config.inventoryMaxAgeSeconds,
        activation.revision,
        activation.state,
        input.cacheKey,
        inventoryRefreshVersion,
      ],
    )
    if (cached.rows[0]) {
      return {
        kind: 'cached',
        receipt: await receiptFromRow(client, cached.rows[0]),
      }
    }
    const existing = await client.query<ReceiptRow>(
      `${RECEIPT_SELECT}
       WHERE receipt.organization_id = $1::uuid
         AND receipt.integration_account_id = $2::uuid
         AND receipt.idempotency_key = $3
       FOR UPDATE OF receipt`,
      [
        input.organizationId,
        config.integrationAccountId,
        input.idempotencyKey,
      ],
    )
    if (existing.rows[0]) {
      assertIdempotentReceipt(existing.rows[0], input)
      if (
        existing.rows[0].config_id !== config.id
        || Number(existing.rows[0].config_row_version)
          !== config.rowVersion
        || existing.rows[0].policy_hash !== config.policyHash
        || existing.rows[0].activation_revision !== activation.revision
        || existing.rows[0].activation_state !== activation.state
        || Number(existing.rows[0].inventory_refresh_version)
          !== inventoryRefreshVersion
      ) {
        fail(
          'SHOPIFY_CHECKOUT_IDEMPOTENCY_FENCE_STALE',
          'Idempotency key belongs to an older checkout configuration',
          409,
        )
      }
      if (
        existing.rows[0].status !== 'processing'
        || (
          existing.rows[0].lease_expires_at
          && new Date(existing.rows[0].lease_expires_at) > new Date()
        )
      ) {
        return {
          kind: existing.rows[0].status === 'processing'
            ? 'in_progress'
            : 'idempotent_replay',
          receipt: await receiptFromRow(client, existing.rows[0]),
        }
      }
      if (existing.rows[0].attempt_count >= 20) {
        fail(
          'SHOPIFY_CHECKOUT_RECEIPT_ATTEMPTS_EXHAUSTED',
          'Expired checkout receipt exceeded its reclaim limit',
          409,
        )
      }
      const leaseToken = randomUUID()
      const reclaimed = await client.query<{
        global_id: string
      }>(
        `UPDATE operations_shopify_checkout_rate_receipts
         SET lease_token = $3::uuid,
             lease_expires_at = now() + make_interval(secs => $4),
             claimed_by = $5,
             attempt_count = attempt_count + 1,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'processing'
           AND lease_expires_at <= now()
           AND attempt_count < 20
         RETURNING global_id`,
        [
          input.organizationId,
          existing.rows[0].id,
          leaseToken,
          input.leaseSeconds,
          input.claimedBy,
        ],
      )
      if (!reclaimed.rows[0]) {
        fail(
          'SHOPIFY_CHECKOUT_RECEIPT_RECLAIM_CONFLICT',
          'Checkout receipt was claimed by another worker',
          409,
        )
      }
      return {
        kind: 'claimed',
        receiptGlobalId: reclaimed.rows[0].global_id,
        leaseToken,
      }
    }
    const inProgress = await client.query<ReceiptRow>(
      `${RECEIPT_SELECT}
       WHERE receipt.organization_id = $1::uuid
         AND receipt.integration_account_id = $2::uuid
         AND receipt.request_fingerprint = $3
         AND receipt.policy_hash = $4
         AND receipt.config_id = $5::uuid
         AND receipt.config_row_version = $6
         AND receipt.inventory_snapshot_hash = $7
         AND receipt.activation_revision = $8
         AND receipt.activation_state = $9
         AND receipt.inventory_refresh_version = $11::bigint
         AND (
           receipt.idempotency_key = $10
           OR left(receipt.idempotency_key, length($10) + 9)
             = $10 || ':attempt:'
         )
         AND receipt.status = 'processing'
       ORDER BY receipt.created_at DESC, receipt.id DESC
       LIMIT 1
       FOR UPDATE OF receipt`,
      [
        input.organizationId,
        config.integrationAccountId,
        input.requestFingerprint,
        config.policyHash,
        config.id,
        config.rowVersion,
        input.inventorySnapshotHash,
        activation.revision,
        activation.state,
        input.cacheKey,
        inventoryRefreshVersion,
      ],
    )
    if (inProgress.rows[0]) {
      assertIdempotentReceipt(inProgress.rows[0], input)
      if (
        inProgress.rows[0].lease_expires_at
        && new Date(inProgress.rows[0].lease_expires_at) > new Date()
      ) {
        return {
          kind: 'in_progress',
          receipt: await receiptFromRow(client, inProgress.rows[0]),
        }
      }
      if (inProgress.rows[0].attempt_count >= 20) {
        fail(
          'SHOPIFY_CHECKOUT_RECEIPT_ATTEMPTS_EXHAUSTED',
          'Expired checkout receipt exceeded its reclaim limit',
          409,
        )
      }
      const leaseToken = randomUUID()
      const reclaimed = await client.query<{ global_id: string }>(
        `UPDATE operations_shopify_checkout_rate_receipts
         SET lease_token = $3::uuid,
             lease_expires_at = now() + make_interval(secs => $4),
             claimed_by = $5,
             attempt_count = attempt_count + 1,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'processing'
           AND lease_expires_at <= now()
           AND attempt_count < 20
         RETURNING global_id`,
        [
          input.organizationId,
          inProgress.rows[0].id,
          leaseToken,
          input.leaseSeconds,
          input.claimedBy,
        ],
      )
      if (!reclaimed.rows[0]) {
        fail(
          'SHOPIFY_CHECKOUT_RECEIPT_RECLAIM_CONFLICT',
          'Checkout receipt was claimed by another worker',
          409,
        )
      }
      return {
        kind: 'claimed',
        receiptGlobalId: reclaimed.rows[0].global_id,
        leaseToken,
      }
    }
    const leaseToken = randomUUID()
    const inserted = await client.query<{
      id: string
      global_id: string
    }>(
      `INSERT INTO operations_shopify_checkout_rate_receipts (
         organization_id, integration_account_id, config_id,
         config_row_version, credential_generation, activation_revision,
         activation_state, policy_revision, policy_hash,
         warehouse_id, algorithm_version,
         request_fingerprint, destination_fingerprint,
         line_quantity_fingerprint, request_evidence_hash,
         redacted_request_snapshot, currency,
         idempotency_key, status, lease_token, lease_expires_at,
         claimed_by, line_count, inventory_snapshot_hash,
         inventory_snapshot_at, carrier_destination_fingerprint,
         inventory_refresh_version
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9,
         $10::uuid, $11, $12, $13, $14, $15, $16::jsonb, $17, $18,
         'processing', $19::uuid,
         now() + make_interval(secs => $20), $21, $22, $23,
         $24::timestamptz, $25, $26::bigint
       )
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        config.integrationAccountId,
        config.id,
        config.rowVersion,
        config.credentialGeneration,
        activation.revision,
        activation.state,
        config.policyRevision,
        config.policyHash,
        config.warehouseId,
        config.algorithmVersion,
        input.requestFingerprint,
        input.destinationFingerprint,
        input.lineQuantityFingerprint,
        input.requestEvidenceHash,
        JSON.stringify(input.redactedRequestSnapshot),
        input.currency,
        input.idempotencyKey,
        leaseToken,
        input.leaseSeconds,
        input.claimedBy,
        input.lines.length,
        input.inventorySnapshotHash,
        input.inventorySnapshotAt,
        input.carrierDestinationFingerprint,
        inventoryRefreshVersion,
      ],
    )
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipt_lines (
         organization_id, receipt_id, line_key, provider_variant_id,
         sku, quantity, unit_weight_grams, requires_shipping,
         line_hash, line_snapshot
       )
       SELECT
         $1::uuid, $2::uuid, line.line_key, line.provider_variant_id,
         line.sku, line.quantity, line.unit_weight_grams,
         line.requires_shipping, line.line_hash, line.line_snapshot
       FROM jsonb_to_recordset($3::jsonb) AS line(
         line_key text,
         provider_variant_id text,
         sku text,
         quantity integer,
         unit_weight_grams integer,
         requires_shipping boolean,
         line_hash text,
         line_snapshot jsonb
       )`,
      [
        input.organizationId,
        inserted.rows[0].id,
        JSON.stringify(input.lines.map((line) => ({
          line_key: line.lineKey,
          provider_variant_id: line.providerVariantId,
          sku: line.sku,
          quantity: line.quantity,
          unit_weight_grams: line.unitWeightGrams,
          requires_shipping: line.requiresShipping,
          line_hash: line.lineHash,
          line_snapshot: line.lineSnapshot,
        }))),
      ],
    )
    return {
      kind: 'claimed',
      receiptGlobalId: inserted.rows[0].global_id,
      leaseToken,
    }
    },
    {
      signal: input.signal,
      statementTimeoutMs: SHOPIFY_CHECKOUT_CLAIM_STATEMENT_TIMEOUT_MS,
    },
  )
}

export async function claimShopifyCheckoutRateReceiptInPostgres(
  rawInput: ShopifyCheckoutReceiptClaimInput,
): Promise<ShopifyCheckoutRateReceiptClaim> {
  const input = normalizeShopifyCheckoutReceiptClaimInput(rawInput)
  return executeShopifyCheckoutReceiptClaimWithRetry({
    deadlineAt: input.deadlineAt,
    signal: input.signal,
    executeAttempt: () => (
      claimShopifyCheckoutRateReceiptOnceInPostgres(input)
    ),
  })
}

function normalizeCompletion(
  input: CompleteShopifyCheckoutRateReceiptInput,
) {
  if (
    !Array.isArray(input.packages)
    || input.packages.length < 1
    || input.packages.length > MAX_SHOPIFY_CHECKOUT_PACKAGES
  ) {
    fail(
      'SHOPIFY_CHECKOUT_PACKAGE_COUNT_INVALID',
      `Checkout result requires 1-${MAX_SHOPIFY_CHECKOUT_PACKAGES} packages`,
    )
  }
  if (
    !Array.isArray(input.offers)
    || input.offers.length < 1
    || input.offers.length > MAX_SHOPIFY_CHECKOUT_OFFERS
  ) {
    fail(
      'SHOPIFY_CHECKOUT_OFFER_COUNT_INVALID',
      `Checkout result requires 1-${MAX_SHOPIFY_CHECKOUT_OFFERS} offers`,
    )
  }
  const packageKeys = new Set<string>()
  const packageSequences = new Set<number>()
  const packages = input.packages.map((item) => {
    const packageKey = textValue(item.packageKey, 'Package key', 100)
    const packageSequence = integer(
      item.packageSequence,
      'Package sequence',
      1,
      MAX_SHOPIFY_CHECKOUT_PACKAGES,
    )
    if (
      packageKeys.has(packageKey)
      || packageSequences.has(packageSequence)
    ) {
      fail(
        'SHOPIFY_CHECKOUT_PACKAGE_DUPLICATE',
        'Package keys and sequences must be unique',
      )
    }
    packageKeys.add(packageKey)
    packageSequences.add(packageSequence)
    if (!Array.isArray(item.allocations) || item.allocations.length < 1) {
      fail(
        'SHOPIFY_CHECKOUT_ALLOCATION_REQUIRED',
        'Every package requires at least one line allocation',
      )
    }
    const allocationLines = new Set<string>()
    const allocations = item.allocations.map((allocation) => {
      const lineKey = textValue(
        allocation.lineKey,
        'Allocation line key',
        120,
      )
      if (allocationLines.has(lineKey)) {
        fail(
          'SHOPIFY_CHECKOUT_ALLOCATION_DUPLICATE',
          'A line can appear only once in each package',
        )
      }
      allocationLines.add(lineKey)
      const quantity = integer(
        allocation.quantity,
        'Allocation quantity',
        1,
        100000,
      )
      return {
        lineKey,
        quantity,
        allocationHash: shopifyCheckoutRatingHash({
          packageKey,
          lineKey,
          quantity,
        }),
      }
    }).sort((left, right) => left.lineKey.localeCompare(right.lineKey))
    assertShopifyCheckoutCustomerNeutralEvidence(
      item.packageSnapshot,
      `Package ${packageKey} snapshot`,
    )
    const planningMethod = item.planningMethod ?? 'approved_recipe'
    const common = {
      packageKey,
      packageSequence,
      ratedOuterDimensionsMm: {
        length: integer(
          item.ratedOuterDimensionsMm?.length,
          'Rated outer length',
          1,
          100000,
        ),
        width: integer(
          item.ratedOuterDimensionsMm?.width,
          'Rated outer width',
          1,
          100000,
        ),
        height: integer(
          item.ratedOuterDimensionsMm?.height,
          'Rated outer height',
          1,
          100000,
        ),
      },
      contentWeightGrams: integer(
        item.contentWeightGrams,
        'Content weight',
        1,
        100000000,
      ),
      tareWeightGrams: integer(
        item.tareWeightGrams,
        'Tare weight',
        0,
        1000000,
      ),
      allocations,
      packageSnapshot: item.packageSnapshot,
    }
    const normalized = planningMethod === 'self_package'
      ? {
          ...common,
          planningMethod,
          materialGlobalId: null,
          materialRowVersion: null,
          materialStockGlobalId: null,
          materialStockRowVersion: null,
          materialStockOnHandQuantity: null,
          packProfileVersionGlobalId: matchValue(
            item.packProfileVersionGlobalId,
            PACK_PROFILE_VERSION_GLOBAL_ID,
            'Pack profile version Global ID',
          ),
          packProfileVersionRowVersion: integer(
            item.packProfileVersionRowVersion,
            'Pack profile version row version',
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          selfPackageLineKey: textValue(
            item.selfPackageLineKey,
            'Self-package line key',
            120,
          ),
        }
      : {
          ...common,
          planningMethod: 'approved_recipe' as const,
          materialGlobalId: matchValue(
            item.materialGlobalId,
            MATERIAL_GLOBAL_ID,
            'Packaging material Global ID',
          ),
          materialRowVersion: integer(
            item.materialRowVersion,
            'Packaging material row version',
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          materialStockGlobalId: matchValue(
            item.materialStockGlobalId,
            PACKAGING_STOCK_GLOBAL_ID,
            'Packaging material stock Global ID',
          ),
          materialStockRowVersion: integer(
            item.materialStockRowVersion,
            'Packaging material stock row version',
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          materialStockOnHandQuantity: integer(
            item.materialStockOnHandQuantity,
            'Packaging material stock on-hand quantity',
            1,
            Number.MAX_SAFE_INTEGER,
          ),
          packProfileVersionGlobalId: null,
          packProfileVersionRowVersion: null,
          selfPackageLineKey: null,
        }
    if (
      planningMethod === 'self_package'
      && (
        common.tareWeightGrams !== 0
        || allocations.length !== 1
        || allocations[0].lineKey !== normalized.selfPackageLineKey
        || allocations[0].quantity !== 1
      )
    ) {
      fail(
        'SHOPIFY_CHECKOUT_SELF_PACKAGE_SHAPE_INVALID',
        'Each self-packaged sell unit must be one zero-tare parcel allocated to exactly one line unit',
      )
    }
    return {
      ...normalized,
      packageHash: shopifyCheckoutRatingHash(normalized),
    }
  }).sort((left, right) => (
    left.packageSequence - right.packageSequence
    || left.packageKey.localeCompare(right.packageKey)
  ))
  const packagePlanHash = shopifyCheckoutPackagePlanHash({ packages })
  if (
    matchValue(
      input.packagePlanHash,
      SHA256,
      'Package plan hash',
    ) !== packagePlanHash
  ) {
    fail(
      'SHOPIFY_CHECKOUT_PACKAGE_PLAN_HASH_MISMATCH',
      'Package plan hash does not match exact package allocations',
      409,
    )
  }
  const offerKeys = new Set<string>()
  const offers = input.offers.map((offer) => {
    const provider = offer.provider
    if (!['ups_rest', 'fedex_rest'].includes(provider)) {
      fail(
        'SHOPIFY_CHECKOUT_OFFER_PROVIDER_INVALID',
        'Checkout offers support UPS and FedEx only',
      )
    }
    const serviceCode = textValue(
      offer.serviceCode,
      'Service code',
      80,
    )
    const carrierAccountGlobalId = matchValue(
      offer.carrierAccountGlobalId,
      CARRIER_ACCOUNT_GLOBAL_ID,
      'Carrier account Global ID',
    )
    const rateEvidenceGlobalId = matchValue(
      offer.rateEvidenceGlobalId,
      RATE_EVIDENCE_GLOBAL_ID,
      'Carrier rate evidence Global ID',
    )
    const shopifyServiceCode = matchValue(
      offer.shopifyServiceCode,
      SHOPIFY_RATE_SERVICE_CODE,
      'Shopify service code',
    )
    const key = shopifyServiceCode
    if (offerKeys.has(key)) {
      fail(
        'SHOPIFY_CHECKOUT_OFFER_DUPLICATE',
        'Carrier service offers must be unique',
      )
    }
    offerKeys.add(key)
    const currency = textValue(
      offer.currency,
      'Offer currency',
      3,
    ).toUpperCase()
    if (!/^[A-Z]{3}$/.test(currency)) {
      fail(
        'SHOPIFY_CHECKOUT_CURRENCY_INVALID',
        'Offer currency must be ISO 4217',
      )
    }
    assertShopifyCheckoutCustomerNeutralEvidence(
      offer.offerSnapshot,
      `${key} offer snapshot`,
    )
    const carrierCostMinor = integer(
      offer.carrierCostMinor,
      'Carrier cost',
      0,
      Number.MAX_SAFE_INTEGER,
    )
    const customerChargeMinor = integer(
      offer.customerChargeMinor,
      'Customer charge',
      0,
      Number.MAX_SAFE_INTEGER,
    )
    const checkoutAdjustmentMinor =
      customerChargeMinor - carrierCostMinor
    if (checkoutAdjustmentMinor > 0) {
      fail(
        'SHOPIFY_CHECKOUT_MARKUP_NOT_ALLOWED',
        'Checkout rating cannot apply MUD or an undisclosed markup',
      )
    }
    const checkoutAdjustmentKind = checkoutAdjustmentMinor < 0
      ? 'subsidy' as const
      : 'none' as const
    const checkoutAdjustmentReason = checkoutAdjustmentKind === 'subsidy'
      ? textValue(
          offer.subsidyReason,
          'Checkout subsidy reason',
          160,
        )
      : null
    if (
      checkoutAdjustmentReason !== null
      && checkoutAdjustmentReason.length < 3
    ) {
      fail(
        'SHOPIFY_CHECKOUT_SUBSIDY_REASON_INVALID',
        'Checkout subsidy reason must contain at least 3 characters',
      )
    }
    const normalized = {
      provider,
      carrierAccountGlobalId,
      rateEvidenceGlobalId,
      shopifyServiceCode,
      serviceCode,
      serviceName: textValue(
        offer.serviceName,
        'Service name',
        160,
      ),
      carrierCostMinor,
      customerChargeMinor,
      checkoutAdjustmentMinor,
      checkoutAdjustmentKind,
      checkoutAdjustmentReason,
      currency,
      minDeliveryDate: offer.minDeliveryDate || null,
      maxDeliveryDate: offer.maxDeliveryDate || null,
      packageCount: packages.length,
      packagePlanHash,
      offerSnapshot: offer.offerSnapshot,
    }
    return {
      ...normalized,
      offerHash: shopifyCheckoutRatingHash(normalized),
    }
  }).sort((left, right) => (
    left.provider.localeCompare(right.provider)
    || left.serviceCode.localeCompare(right.serviceCode)
  ))
  if (
    !Array.isArray(input.providerAttempts)
    || input.providerAttempts.length
      !== MAX_SHOPIFY_CHECKOUT_PROVIDER_ATTEMPTS
  ) {
    fail(
      'SHOPIFY_CHECKOUT_PROVIDER_ATTEMPT_COUNT_INVALID',
      `Checkout result requires exactly ${MAX_SHOPIFY_CHECKOUT_PROVIDER_ATTEMPTS} carrier attempts`,
    )
  }
  const attemptProviders = new Set<string>()
  const attemptAccounts = new Set<string>()
  const providerAttempts = input.providerAttempts.map((attempt) => {
    const provider = attempt.provider
    if (!['ups_rest', 'fedex_rest'].includes(provider)) {
      fail(
        'SHOPIFY_CHECKOUT_PROVIDER_ATTEMPT_PROVIDER_INVALID',
        'Checkout provider attempts support UPS and FedEx only',
      )
    }
    const carrierAccountGlobalId = matchValue(
      attempt.carrierAccountGlobalId,
      CARRIER_ACCOUNT_GLOBAL_ID,
      'Carrier account Global ID',
    )
    if (
      attemptProviders.has(provider)
      || attemptAccounts.has(carrierAccountGlobalId)
    ) {
      fail(
        'SHOPIFY_CHECKOUT_PROVIDER_ATTEMPT_DUPLICATE',
        'Checkout provider attempts must use unique carriers and accounts',
      )
    }
    attemptProviders.add(provider)
    attemptAccounts.add(carrierAccountGlobalId)
    const rateEvidenceGlobalId = matchValue(
      attempt.rateEvidenceGlobalId,
      RATE_EVIDENCE_GLOBAL_ID,
      'Carrier rate evidence Global ID',
    )
    if (!['succeeded', 'degraded'].includes(attempt.status)) {
      fail(
        'SHOPIFY_CHECKOUT_PROVIDER_ATTEMPT_STATUS_INVALID',
        'Checkout provider attempt status is invalid',
      )
    }
    const failureCode = attempt.status === 'degraded'
      ? textValue(
          attempt.failureCode,
          'Provider failure code',
          128,
        )
      : null
    if (
      attempt.status === 'succeeded'
      && attempt.failureCode !== null
    ) {
      fail(
        'SHOPIFY_CHECKOUT_PROVIDER_ATTEMPT_FAILURE_INVALID',
        'Successful provider attempts cannot retain a failure code',
      )
    }
    if (
      failureCode !== null
      && (
        failureCode.length < 3
        || !/^[A-Z0-9_]+$/.test(failureCode)
      )
    ) {
      fail(
        'SHOPIFY_CHECKOUT_PROVIDER_ATTEMPT_FAILURE_INVALID',
        'Degraded provider attempts require a stable failure code',
      )
    }
    assertShopifyCheckoutCustomerNeutralEvidence(
      attempt.attemptSnapshot,
      `${provider} provider attempt snapshot`,
    )
    const normalized = {
      provider,
      carrierAccountGlobalId,
      rateEvidenceGlobalId,
      status: attempt.status,
      failureCode,
      attemptSnapshot: attempt.attemptSnapshot,
    }
    return {
      ...normalized,
      attemptHash: shopifyCheckoutRatingHash(normalized),
    }
  }).sort((left, right) => left.provider.localeCompare(right.provider))
  if (!providerAttempts.some((attempt) => attempt.status === 'succeeded')) {
    fail(
      'SHOPIFY_CHECKOUT_PROVIDER_ATTEMPT_SUCCESS_REQUIRED',
      'A successful checkout receipt requires at least one carrier offer',
    )
  }
  for (const attempt of providerAttempts) {
    const matchingOffers = offers.filter((offer) => (
      offer.provider === attempt.provider
      && offer.carrierAccountGlobalId
        === attempt.carrierAccountGlobalId
      && offer.rateEvidenceGlobalId === attempt.rateEvidenceGlobalId
    ))
    if (
      (attempt.status === 'succeeded' && matchingOffers.length < 1)
      || (attempt.status === 'degraded' && matchingOffers.length > 0)
    ) {
      fail(
        'SHOPIFY_CHECKOUT_PROVIDER_ATTEMPT_OFFER_MISMATCH',
        'Checkout offers must map exactly to successful carrier attempts',
      )
    }
  }
  if (offers.some((offer) => !providerAttempts.some((attempt) => (
    attempt.status === 'succeeded'
    && attempt.provider === offer.provider
    && attempt.carrierAccountGlobalId
      === offer.carrierAccountGlobalId
    && attempt.rateEvidenceGlobalId === offer.rateEvidenceGlobalId
  )))) {
    fail(
      'SHOPIFY_CHECKOUT_PROVIDER_ATTEMPT_OFFER_MISMATCH',
      'Every checkout offer requires matching successful carrier evidence',
    )
  }
  assertShopifyCheckoutCustomerNeutralEvidence(
    input.resultSnapshot,
    'Checkout result snapshot',
  )
  return {
    organizationId: matchValue(
      input.organizationId,
      UUID,
      'Organization ID',
    ),
    receiptGlobalId: matchValue(
      input.receiptGlobalId,
      RECEIPT_GLOBAL_ID,
      'Receipt Global ID',
    ),
    leaseToken: matchValue(input.leaseToken, UUID, 'Lease token'),
    packagePlanHash,
    resultSnapshot: input.resultSnapshot,
    resultHash: shopifyCheckoutRatingHash(input.resultSnapshot),
    deadlineAt: optionalDeadline(
      input.deadlineAt,
      'Checkout completion deadline',
    ),
    packages,
    providerAttempts,
    offers,
  }
}

export async function completeShopifyCheckoutRateReceiptInPostgres(
  rawInput: CompleteShopifyCheckoutRateReceiptInput,
) {
  const input = normalizeCompletion(rawInput)
  return withShopifyCheckoutDeadlineTransaction(
    input.deadlineAt,
    async (client) => {
    const receiptScope = await client.query<{
      integration_account_id: string
    }>(
      `SELECT integration_account_id::text
       FROM operations_shopify_checkout_rate_receipts
       WHERE organization_id = $1::uuid
         AND global_id = $2
       LIMIT 1`,
      [input.organizationId, input.receiptGlobalId],
    )
    if (!receiptScope.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_RECEIPT_LEASE_STALE',
        'Checkout receipt lease expired or was already finalized',
        409,
      )
    }
    const inventoryRefreshVersion =
      await lockCleanShopifyInventoryRefreshVersion(client, {
        organizationId: input.organizationId,
        integrationAccountId:
          receiptScope.rows[0].integration_account_id,
      })
    const locked = await client.query<{
      id: string
      currency: string
      inventory_refresh_version: string | number
    }>(
      `SELECT receipt.id::text, receipt.currency,
              receipt.inventory_refresh_version::text
       FROM operations_shopify_checkout_rate_receipts receipt
       JOIN operations_shopify_carrier_service_configs config
         ON config.organization_id = receipt.organization_id
        AND config.id = receipt.config_id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = receipt.organization_id
       WHERE receipt.organization_id = $1::uuid
         AND receipt.global_id = $2
         AND receipt.status = 'processing'
         AND receipt.lease_token = $3::uuid
         AND receipt.lease_expires_at > now()
         AND receipt.config_row_version = config.row_version
         AND receipt.policy_hash = config.policy_hash
         AND receipt.activation_revision = activation.revision
         AND receipt.activation_state = activation.state
         AND receipt.inventory_snapshot_at >= now() - make_interval(
           secs => config.inventory_max_age_seconds
         )
         AND operations_shopify_carrier_service_config_is_ready(
           config.organization_id, config.id
         )
       FOR UPDATE OF receipt`,
      [
        input.organizationId,
        input.receiptGlobalId,
        input.leaseToken,
      ],
    )
    if (!locked.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_RECEIPT_LEASE_STALE',
        'Checkout receipt lease expired or was already finalized',
        409,
      )
    }
    if (
      Number(locked.rows[0].inventory_refresh_version)
        !== inventoryRefreshVersion
    ) {
      fail(
        'SHOPIFY_CHECKOUT_INVENTORY_REFRESH_VERSION_STALE',
        'Shopify inventory changed after this checkout request was claimed',
        409,
      )
    }
    if (input.offers.some(
      (offer) => offer.currency !== locked.rows[0].currency,
    )) {
      fail(
        'SHOPIFY_CHECKOUT_CURRENCY_MISMATCH',
        'Every offer must use the checkout request currency',
      )
    }
    await client.query(
       `INSERT INTO operations_shopify_checkout_rate_receipt_packages (
         organization_id, receipt_id, package_key, package_sequence,
         planning_method,
         packaging_material_id, packaging_material_row_version,
         packaging_material_stock_id,
         packaging_material_stock_row_version,
         packaging_material_stock_on_hand_quantity,
         pack_profile_version_id, pack_profile_version_row_version,
         self_package_line_key,
         rated_outer_length_mm, rated_outer_width_mm,
         rated_outer_height_mm, content_weight_grams, tare_weight_grams,
         gross_weight_grams, allocation_count, package_hash,
         package_snapshot
       )
       SELECT
         $1::uuid,
         $2::uuid,
         package.package_key,
         package.package_sequence,
         package.planning_method,
         material.id,
         package.material_row_version,
         stock.id,
         package.material_stock_row_version,
         package.material_stock_on_hand_quantity,
         profile_version.id,
         package.pack_profile_version_row_version,
         package.self_package_line_key,
         package.rated_outer_length_mm,
         package.rated_outer_width_mm,
         package.rated_outer_height_mm,
         package.content_weight_grams,
         package.tare_weight_grams,
         package.content_weight_grams + package.tare_weight_grams,
         package.allocation_count,
         package.package_hash,
         package.package_snapshot
       FROM jsonb_to_recordset($3::jsonb) AS package(
         package_key text,
         package_sequence integer,
         planning_method text,
         material_global_id text,
         material_row_version bigint,
         material_stock_global_id text,
         material_stock_row_version bigint,
         material_stock_on_hand_quantity integer,
         pack_profile_version_global_id text,
         pack_profile_version_row_version bigint,
         self_package_line_key text,
         rated_outer_length_mm integer,
         rated_outer_width_mm integer,
         rated_outer_height_mm integer,
         content_weight_grams integer,
         tare_weight_grams integer,
         allocation_count integer,
         package_hash text,
         package_snapshot jsonb
       )
       LEFT JOIN operations_packaging_materials material
         ON material.organization_id = $1::uuid
        AND material.global_id = package.material_global_id
        AND package.planning_method = 'approved_recipe'
       JOIN operations_shopify_checkout_rate_receipts receipt
         ON receipt.organization_id = $1::uuid
        AND receipt.id = $2::uuid
       LEFT JOIN operations_packaging_material_stock stock
         ON stock.organization_id = $1::uuid
        AND stock.global_id = package.material_stock_global_id
        AND stock.packaging_material_id = material.id
        AND stock.warehouse_id = receipt.warehouse_id
        AND package.planning_method = 'approved_recipe'
       LEFT JOIN operations_product_pack_profile_versions profile_version
         ON profile_version.organization_id = $1::uuid
        AND profile_version.global_id =
              package.pack_profile_version_global_id
        AND package.planning_method = 'self_package'`,
      [
        input.organizationId,
        locked.rows[0].id,
        JSON.stringify(input.packages.map((item) => ({
          package_key: item.packageKey,
          package_sequence: item.packageSequence,
          planning_method: item.planningMethod,
          material_global_id: item.materialGlobalId,
          material_row_version: item.materialRowVersion,
          material_stock_global_id: item.materialStockGlobalId,
          material_stock_row_version: item.materialStockRowVersion,
          material_stock_on_hand_quantity:
            item.materialStockOnHandQuantity,
          pack_profile_version_global_id:
            item.packProfileVersionGlobalId,
          pack_profile_version_row_version:
            item.packProfileVersionRowVersion,
          self_package_line_key: item.selfPackageLineKey,
          rated_outer_length_mm: item.ratedOuterDimensionsMm.length,
          rated_outer_width_mm: item.ratedOuterDimensionsMm.width,
          rated_outer_height_mm: item.ratedOuterDimensionsMm.height,
          content_weight_grams: item.contentWeightGrams,
          tare_weight_grams: item.tareWeightGrams,
          allocation_count: item.allocations.length,
          package_hash: item.packageHash,
          package_snapshot: item.packageSnapshot,
        }))),
      ],
    )
    const allocations = input.packages.flatMap((item) => (
      item.allocations.map((allocation) => ({
        package_key: item.packageKey,
        line_key: allocation.lineKey,
        quantity: allocation.quantity,
        allocation_hash: allocation.allocationHash,
      }))
    ))
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
         organization_id, receipt_id, package_key, line_key,
         quantity, allocation_hash
       )
       SELECT
         $1::uuid, $2::uuid, allocation.package_key,
         allocation.line_key, allocation.quantity,
         allocation.allocation_hash
       FROM jsonb_to_recordset($3::jsonb) AS allocation(
         package_key text,
         line_key text,
         quantity integer,
         allocation_hash text
       )`,
      [
        input.organizationId,
        locked.rows[0].id,
        JSON.stringify(allocations),
      ],
    )
    await client.query(
      `INSERT INTO
         operations_shopify_checkout_rate_receipt_provider_attempts (
           organization_id, receipt_id, carrier_provider,
           carrier_account_id, carrier_rate_request_id,
           carrier_rate_purpose, carrier_request_hash,
           attempt_status, failure_code, attempt_hash, attempt_snapshot
         )
       SELECT
         $1::uuid, $2::uuid, attempt.provider,
         carrier_account.id, rate_evidence.id,
         'cartonization_shipment_rate', rate_evidence.request_hash,
         attempt.attempt_status, attempt.failure_code,
         attempt.attempt_hash, attempt.attempt_snapshot
       FROM jsonb_to_recordset($3::jsonb) AS attempt(
         provider text,
         carrier_account_global_id text,
         rate_evidence_global_id text,
         attempt_status text,
         failure_code text,
         attempt_hash text,
         attempt_snapshot jsonb
       )
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id = $1::uuid
        AND carrier_account.global_id =
              attempt.carrier_account_global_id
       JOIN operations_carrier_rate_requests rate_evidence
         ON rate_evidence.organization_id = $1::uuid
        AND rate_evidence.global_id = attempt.rate_evidence_global_id`,
      [
        input.organizationId,
        locked.rows[0].id,
        JSON.stringify(input.providerAttempts.map((attempt) => ({
          provider: attempt.provider,
          carrier_account_global_id: attempt.carrierAccountGlobalId,
          rate_evidence_global_id: attempt.rateEvidenceGlobalId,
          attempt_status: attempt.status,
          failure_code: attempt.failureCode,
          attempt_hash: attempt.attemptHash,
          attempt_snapshot: attempt.attemptSnapshot,
        }))),
      ],
    )
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipt_offers (
         organization_id, receipt_id, carrier_provider,
         carrier_account_id, carrier_rate_request_id,
         carrier_rate_purpose, carrier_request_hash,
         carrier_response_rate_hash,
         shopify_service_code, service_code,
         service_name, carrier_cost_minor, customer_charge_minor,
         checkout_adjustment_minor, checkout_adjustment_kind,
         checkout_adjustment_reason,
         currency, package_count, package_plan_hash,
         min_delivery_date, max_delivery_date, offer_hash, offer_snapshot
       )
       SELECT
         $1::uuid, $2::uuid, offer.provider,
         carrier_account.id, rate_evidence.id,
         'cartonization_shipment_rate', rate_evidence.request_hash,
         selected_rate.response_rate_hash,
         offer.shopify_service_code, offer.service_code,
         offer.service_name, offer.carrier_cost_minor,
         offer.customer_charge_minor, offer.checkout_adjustment_minor,
         offer.checkout_adjustment_kind, offer.checkout_adjustment_reason,
         offer.currency,
         offer.package_count, offer.package_plan_hash,
         offer.min_delivery_date, offer.max_delivery_date,
         offer.offer_hash, offer.offer_snapshot
       FROM jsonb_to_recordset($3::jsonb) AS offer(
         provider text,
         carrier_account_global_id text,
         rate_evidence_global_id text,
         shopify_service_code text,
         service_code text,
         service_name text,
         carrier_cost_minor bigint,
         customer_charge_minor bigint,
         checkout_adjustment_minor bigint,
         checkout_adjustment_kind text,
         checkout_adjustment_reason text,
         currency text,
         package_count integer,
         package_plan_hash text,
         min_delivery_date date,
         max_delivery_date date,
         offer_hash text,
         offer_snapshot jsonb
       )
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id = $1::uuid
        AND carrier_account.global_id = offer.carrier_account_global_id
       JOIN operations_carrier_rate_requests rate_evidence
         ON rate_evidence.organization_id = $1::uuid
        AND rate_evidence.global_id = offer.rate_evidence_global_id
       JOIN LATERAL (
         SELECT
           encode(
             digest(min(rate.value::text), 'sha256'),
             'hex'
           ) AS response_rate_hash
         FROM jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(rate_evidence.redacted_response->'rates')
               = 'array'
             THEN rate_evidence.redacted_response->'rates'
             ELSE '[]'::jsonb
           END
         ) rate(value)
         WHERE lower(rate.value->>'serviceCode')
           = lower(offer.service_code)
         HAVING count(*) = 1
       ) selected_rate ON true`,
      [
        input.organizationId,
        locked.rows[0].id,
        JSON.stringify(input.offers.map((offer) => ({
          provider: offer.provider,
          carrier_account_global_id: offer.carrierAccountGlobalId,
          rate_evidence_global_id: offer.rateEvidenceGlobalId,
          shopify_service_code: offer.shopifyServiceCode,
          service_code: offer.serviceCode,
          service_name: offer.serviceName,
          carrier_cost_minor: offer.carrierCostMinor,
          customer_charge_minor: offer.customerChargeMinor,
          checkout_adjustment_minor: offer.checkoutAdjustmentMinor,
          checkout_adjustment_kind: offer.checkoutAdjustmentKind,
          checkout_adjustment_reason: offer.checkoutAdjustmentReason,
          currency: offer.currency,
          package_count: offer.packageCount,
          package_plan_hash: offer.packagePlanHash,
          min_delivery_date: offer.minDeliveryDate,
          max_delivery_date: offer.maxDeliveryDate,
          offer_hash: offer.offerHash,
          offer_snapshot: offer.offerSnapshot,
        }))),
      ],
    )
    const updated = await client.query<{ global_id: string }>(
      `UPDATE operations_shopify_checkout_rate_receipts receipt
       SET status = 'succeeded',
           lease_token = NULL,
           lease_expires_at = NULL,
           package_count = $4,
           offer_count = $5,
           package_plan_hash = $6,
           result_hash = $7,
           result_snapshot = $8::jsonb,
           completed_at = now(),
           expires_at = now() + make_interval(
             secs => config.quote_ttl_seconds
           ),
           updated_at = now()
       FROM
         operations_shopify_carrier_service_configs config,
         operations_activation_scopes activation
       WHERE receipt.organization_id = $1::uuid
         AND receipt.id = $2::uuid
         AND receipt.status = 'processing'
         AND receipt.lease_token = $3::uuid
         AND config.organization_id = receipt.organization_id
         AND config.id = receipt.config_id
         AND activation.organization_id = receipt.organization_id
         AND receipt.config_row_version = config.row_version
         AND receipt.policy_hash = config.policy_hash
         AND receipt.activation_revision = activation.revision
         AND receipt.activation_state = activation.state
         AND receipt.inventory_snapshot_at >= now() - make_interval(
           secs => config.inventory_max_age_seconds
         )
         AND operations_shopify_carrier_service_config_is_ready(
           config.organization_id, config.id
         )
       RETURNING receipt.global_id`,
      [
        input.organizationId,
        locked.rows[0].id,
        input.leaseToken,
        input.packages.length,
        input.offers.length,
        input.packagePlanHash,
        input.resultHash,
        JSON.stringify(input.resultSnapshot),
      ],
    )
    if (!updated.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_RECEIPT_FINALIZE_CONFLICT',
        'Checkout receipt could not be finalized',
        409,
      )
    }
    return readReceiptByGlobalId(client, {
      organizationId: input.organizationId,
      receiptGlobalId: updated.rows[0].global_id,
    })
    },
  )
}

export async function failShopifyCheckoutRateReceiptInPostgres(rawInput: {
  organizationId: string
  receiptGlobalId: string
  leaseToken: string
  errorCode: string
  resultSnapshot: Record<string, unknown>
  cacheSeconds?: number
  deadlineAt?: string | Date | null
}) {
  assertShopifyCheckoutCustomerNeutralEvidence(
    rawInput.resultSnapshot,
    'Checkout failure snapshot',
  )
  const input = {
    organizationId: matchValue(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    receiptGlobalId: matchValue(
      rawInput.receiptGlobalId,
      RECEIPT_GLOBAL_ID,
      'Receipt Global ID',
    ),
    leaseToken: matchValue(rawInput.leaseToken, UUID, 'Lease token'),
    errorCode: textValue(rawInput.errorCode, 'Error code', 128),
    resultSnapshot: rawInput.resultSnapshot,
    resultHash: shopifyCheckoutRatingHash(rawInput.resultSnapshot),
    deadlineAt: optionalDeadline(
      rawInput.deadlineAt,
      'Checkout failure deadline',
    ),
    cacheSeconds: integer(
      rawInput.cacheSeconds ?? 30,
      'Failure cache duration',
      1,
      300,
    ),
  }
  return withShopifyCheckoutDeadlineTransaction(
    input.deadlineAt,
    async (client) => {
    const receiptScope = await client.query<{
      integration_account_id: string
      inventory_refresh_version: string | number
    }>(
      `SELECT integration_account_id::text,
              inventory_refresh_version::text
       FROM operations_shopify_checkout_rate_receipts
       WHERE organization_id = $1::uuid
         AND global_id = $2
       LIMIT 1`,
      [input.organizationId, input.receiptGlobalId],
    )
    if (!receiptScope.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_RECEIPT_LEASE_STALE',
        'Checkout receipt lease expired or was already finalized',
        409,
      )
    }
    const inventoryRefreshVersion =
      await lockCleanShopifyInventoryRefreshVersion(client, {
        organizationId: input.organizationId,
        integrationAccountId:
          receiptScope.rows[0].integration_account_id,
      })
    if (
      Number(receiptScope.rows[0].inventory_refresh_version)
        !== inventoryRefreshVersion
    ) {
      fail(
        'SHOPIFY_CHECKOUT_INVENTORY_REFRESH_VERSION_STALE',
        'Shopify inventory changed after this checkout request was claimed',
        409,
      )
    }
    const updated = await client.query<{ global_id: string }>(
      `UPDATE operations_shopify_checkout_rate_receipts
       SET status = 'failed',
           lease_token = NULL,
           lease_expires_at = NULL,
           result_hash = $4,
           result_snapshot = $5::jsonb,
           error_code = $6,
           completed_at = now(),
           expires_at = now() + make_interval(secs => $7),
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND status = 'processing'
         AND lease_token = $3::uuid
         AND lease_expires_at > now()
       RETURNING global_id`,
      [
        input.organizationId,
        input.receiptGlobalId,
        input.leaseToken,
        input.resultHash,
        JSON.stringify(input.resultSnapshot),
        input.errorCode,
        input.cacheSeconds,
      ],
    )
    if (!updated.rows[0]) {
      fail(
        'SHOPIFY_CHECKOUT_RECEIPT_LEASE_STALE',
        'Checkout receipt lease expired or was already finalized',
        409,
      )
    }
    return readReceiptByGlobalId(client, {
      organizationId: input.organizationId,
      receiptGlobalId: updated.rows[0].global_id,
    })
    },
  )
}

export async function readCachedShopifyCheckoutRateReceiptInPostgres(
  rawInput: {
    organizationId: string
    accountGlobalId: string
    requestFingerprint: string
    inventorySnapshotHash: string
    cacheKey?: string
    idempotencyKey?: string
  },
) {
  const input = {
    organizationId: matchValue(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    accountGlobalId: matchValue(
      rawInput.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Shopify account Global ID',
    ),
    requestFingerprint: matchValue(
      rawInput.requestFingerprint,
      SHA256,
      'Request fingerprint',
    ),
    inventorySnapshotHash: matchValue(
      rawInput.inventorySnapshotHash,
      SHA256,
      'Inventory snapshot hash',
    ),
    cacheKey: textValue(
      rawInput.cacheKey ?? rawInput.idempotencyKey,
      'Checkout cache key',
      200,
    ),
  }
  return withTransaction(async (client) => {
    const account = await client.query<{ id: string }>(
      `SELECT id::text
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND provider = 'shopify'
         AND integration_type = 'commerce'
       LIMIT 1`,
      [input.organizationId, input.accountGlobalId],
    )
    if (!account.rows[0]) return null
    const inventoryRefreshVersion =
      await lockCleanShopifyInventoryRefreshVersion(client, {
        organizationId: input.organizationId,
        integrationAccountId: account.rows[0].id,
      })
    const result = await client.query<ReceiptRow>(
      `${RECEIPT_SELECT}
     JOIN operations_shopify_carrier_service_configs current_config
       ON current_config.organization_id = receipt.organization_id
      AND current_config.integration_account_id
        = receipt.integration_account_id
     JOIN operations_activation_scopes current_activation
       ON current_activation.organization_id = receipt.organization_id
     WHERE receipt.organization_id = $1::uuid
       AND account.global_id = $2
       AND receipt.request_fingerprint = $3
       AND receipt.inventory_snapshot_hash = $4
       AND (
         receipt.idempotency_key = $5
         OR left(receipt.idempotency_key, length($5) + 9)
           = $5 || ':attempt:'
       )
       AND receipt.status IN ('succeeded', 'failed')
       AND receipt.expires_at > now()
       AND receipt.inventory_snapshot_at >= now() - make_interval(
         secs => current_config.inventory_max_age_seconds
       )
       AND receipt.config_id = current_config.id
       AND receipt.config_row_version = current_config.row_version
       AND receipt.policy_hash = current_config.policy_hash
       AND receipt.activation_revision = current_activation.revision
       AND receipt.activation_state = current_activation.state
       AND receipt.inventory_refresh_version = $6::bigint
       AND operations_shopify_carrier_service_config_is_ready(
         current_config.organization_id, current_config.id
       )
     ORDER BY receipt.completed_at DESC, receipt.id
     LIMIT 1`,
    [
      input.organizationId,
      input.accountGlobalId,
      input.requestFingerprint,
      input.inventorySnapshotHash,
      input.cacheKey,
      inventoryRefreshVersion,
    ],
  )
    return result.rows[0] ? receiptFromRow(client, result.rows[0]) : null
  })
}

type ReconciliationRow = QueryResultRow & {
  global_id: string
  supersedes_reconciliation_global_id: string | null
  account_global_id: string
  order_candidate_global_id: string
  receipt_global_id: string | null
  order_global_id: string
  source_external_order_id: string
  source_order_created_at: TimestampValue | null
  source_line_quantity_fingerprint: string | null
  source_destination_fingerprint: string | null
  source_currency: string
  source_shipping_charge_minor: string | number | null
  source_shopify_service_code: string | null
  candidate_set_hash: string
  selected_carrier_account_global_id: string | null
  selected_rate_evidence_global_id: string | null
  selected_carrier_provider: ShopifyCheckoutCarrierProvider | null
  selected_service_code: string | null
  selected_offer_hash: string | null
  selected_customer_charge_minor: string | number | null
  selected_currency: string | null
  outcome: ShopifyCheckoutRateReconciliation['outcome']
  match_method: string
  candidate_count: number
  match_evidence: Record<string, unknown>
  idempotency_key: string
  provider_write_count: 0
  created_by: string | null
  created_at: TimestampValue
}

const RECONCILIATION_SELECT = `SELECT
    reconciliation.global_id,
    reconciliation.match_evidence
      ->> 'supersedesReconciliationGlobalId'
      AS supersedes_reconciliation_global_id,
    account.global_id AS account_global_id,
    candidate.global_id AS order_candidate_global_id,
    receipt.global_id AS receipt_global_id,
    operation_order.global_id AS order_global_id,
    reconciliation.source_external_order_id,
    reconciliation.source_order_created_at,
    reconciliation.source_line_quantity_fingerprint,
    reconciliation.source_destination_fingerprint,
    reconciliation.source_currency,
    reconciliation.source_shipping_charge_minor::text,
    reconciliation.source_shopify_service_code,
    reconciliation.candidate_set_hash,
    carrier_account.global_id AS selected_carrier_account_global_id,
    rate_evidence.global_id AS selected_rate_evidence_global_id,
    reconciliation.selected_carrier_provider,
    reconciliation.selected_service_code,
    reconciliation.selected_offer_hash,
    reconciliation.selected_customer_charge_minor::text,
    reconciliation.selected_currency,
    reconciliation.outcome,
    reconciliation.match_method,
    reconciliation.candidate_count,
    reconciliation.match_evidence,
    reconciliation.idempotency_key,
    reconciliation.provider_write_count,
    reconciliation.created_by,
    reconciliation.created_at
  FROM operations_shopify_checkout_rate_reconciliations reconciliation
  JOIN operations_integration_accounts account
    ON account.organization_id = reconciliation.organization_id
   AND account.id = reconciliation.integration_account_id
  JOIN operations_commerce_order_candidates candidate
    ON candidate.organization_id = reconciliation.organization_id
   AND candidate.id = reconciliation.order_candidate_id
  LEFT JOIN operations_shopify_checkout_rate_receipts receipt
    ON receipt.organization_id = reconciliation.organization_id
   AND receipt.id = reconciliation.receipt_id
  JOIN operations_orders operation_order
    ON operation_order.organization_id = reconciliation.organization_id
   AND operation_order.id = reconciliation.order_id
  LEFT JOIN operations_carrier_accounts carrier_account
    ON carrier_account.organization_id = reconciliation.organization_id
   AND carrier_account.id = reconciliation.selected_carrier_account_id
  LEFT JOIN operations_carrier_rate_requests rate_evidence
    ON rate_evidence.organization_id = reconciliation.organization_id
   AND rate_evidence.id
     = reconciliation.selected_carrier_rate_request_id`

const CURRENT_RECONCILIATION_SELECT = RECONCILIATION_SELECT.replace(
  'FROM operations_shopify_checkout_rate_reconciliations reconciliation',
  'FROM operations_shopify_checkout_rate_current_reconciliations reconciliation',
)

function reconciliationFromRow(
  row: ReconciliationRow,
): ShopifyCheckoutRateReconciliation {
  return {
    globalId: row.global_id,
    supersedesReconciliationGlobalId:
      row.supersedes_reconciliation_global_id || null,
    accountGlobalId: row.account_global_id,
    orderCandidateGlobalId: row.order_candidate_global_id,
    receiptGlobalId: row.receipt_global_id,
    orderGlobalId: row.order_global_id,
    sourceExternalOrderId: row.source_external_order_id,
    sourceOrderCreatedAt: iso(row.source_order_created_at),
    sourceLineQuantityFingerprint: row.source_line_quantity_fingerprint,
    sourceDestinationFingerprint: row.source_destination_fingerprint,
    sourceCurrency: row.source_currency,
    sourceShippingChargeMinor:
      row.source_shipping_charge_minor === null
        ? null
        : Number(row.source_shipping_charge_minor),
    sourceShopifyServiceCode: row.source_shopify_service_code,
    candidateSetHash: row.candidate_set_hash,
    selectedCarrierAccountGlobalId:
      row.selected_carrier_account_global_id,
    selectedRateEvidenceGlobalId: row.selected_rate_evidence_global_id,
    selectedCarrierProvider: row.selected_carrier_provider,
    selectedServiceCode: row.selected_service_code,
    selectedOfferHash: row.selected_offer_hash,
    selectedCustomerChargeMinor:
      row.selected_customer_charge_minor === null
        ? null
        : Number(row.selected_customer_charge_minor),
    selectedCurrency: row.selected_currency,
    outcome: row.outcome,
    matchMethod: row.match_method,
    candidateCount: row.candidate_count,
    matchEvidence: row.match_evidence,
    idempotencyKey: row.idempotency_key,
    providerWriteCount: 0,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) as string,
  }
}

type ReconcileShopifyCheckoutRateForOrderCandidateInput = {
  organizationId: string
  orderCandidateGlobalId: string
  idempotencyKey: string
  actorEmail: string
}

function normalizeReconcileShopifyCheckoutRateForOrderCandidateInput(
  rawInput: ReconcileShopifyCheckoutRateForOrderCandidateInput,
) {
  return {
    organizationId: matchValue(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    orderCandidateGlobalId: matchValue(
      rawInput.orderCandidateGlobalId,
      ORDER_CANDIDATE_GLOBAL_ID,
      'Order candidate Global ID',
    ),
    idempotencyKey: textValue(
      rawInput.idempotencyKey,
      'Idempotency key',
      200,
    ),
    actorEmail: textValue(rawInput.actorEmail, 'Actor email', 320),
  }
}

export async function
reconcileShopifyCheckoutRateForOrderCandidateWithClient(
  client: PoolClient,
  rawInput: ReconcileShopifyCheckoutRateForOrderCandidateInput,
): Promise<ShopifyCheckoutRateReconciliation> {
  const input = {
    ...normalizeReconcileShopifyCheckoutRateForOrderCandidateInput(rawInput),
  }
  await acquireTransactionAdvisoryLock(
    client,
    `shopify-checkout-reconciliation:${input.organizationId}:${input.orderCandidateGlobalId}`,
  )
  const existing = await client.query<ReconciliationRow>(
      `${CURRENT_RECONCILIATION_SELECT}
       WHERE reconciliation.organization_id = $1::uuid
         AND candidate.global_id = $2
       LIMIT 1`,
      [input.organizationId, input.orderCandidateGlobalId],
    )
    if (existing.rows[0]) {
      if (
        existing.rows[0].idempotency_key !== input.idempotencyKey
      ) {
        fail(
          'SHOPIFY_CHECKOUT_RECONCILIATION_EXISTS',
          'This Shopify order already has an immutable checkout decision',
          409,
        )
      }
      return reconciliationFromRow(existing.rows[0])
    }
    const candidateResult = await client.query<{
      id: string
      integration_account_id: string
      account_global_id: string
      canonical_order_id: string | null
      order_global_id: string | null
      external_order_id: string
      provider_created_at: TimestampValue | null
      line_quantity_fingerprint: string | null
      checkout_destination_fingerprint: string | null
      currency_code: string
      shipping_minor: string | number | null
      checkout_shipping_service_code: string | null
      workflow_state: string
      provider: string
      subtotal_minor: string | number | null
    }>(
      `SELECT
         candidate.id::text,
         candidate.integration_account_id::text,
         account.global_id AS account_global_id,
         candidate.canonical_order_id::text,
         operation_order.global_id AS order_global_id,
         candidate.external_order_id,
         candidate.provider_created_at,
         operations_shopify_checkout_order_line_quantity_fingerprint(
           candidate.organization_id,
           candidate.id
         ) AS line_quantity_fingerprint,
         candidate.checkout_destination_fingerprint,
         candidate.currency_code,
         candidate.shipping_minor::text,
         candidate.checkout_shipping_service_code,
         candidate.workflow_state,
         candidate.provider,
         candidate.subtotal_minor::text
       FROM operations_commerce_order_candidates candidate
       JOIN operations_integration_accounts account
         ON account.organization_id = candidate.organization_id
        AND account.id = candidate.integration_account_id
       LEFT JOIN operations_orders operation_order
         ON operation_order.organization_id = candidate.organization_id
        AND operation_order.id = candidate.canonical_order_id
       WHERE candidate.organization_id = $1::uuid
         AND candidate.global_id = $2
       FOR UPDATE OF candidate`,
      [input.organizationId, input.orderCandidateGlobalId],
    )
    const candidate = candidateResult.rows[0]
    if (
      !candidate
      || candidate.provider !== 'shopify'
      || candidate.workflow_state !== 'promoted'
      || !candidate.canonical_order_id
      || !candidate.order_global_id
    ) {
      fail(
        'SHOPIFY_CHECKOUT_ORDER_NOT_READY',
        'A promoted Shopify order candidate is required',
        409,
      )
    }
    const exactMatches = await client.query<{
      receipt_id: string
      receipt_global_id: string
      offer_carrier_provider: ShopifyCheckoutCarrierProvider
      offer_carrier_account_id: string
      offer_carrier_rate_request_id: string
      offer_service_code: string
      offer_shopify_service_code: string
      offer_hash: string
      offer_customer_charge_minor: string | number
      offer_currency: string
    }>(
      `SELECT *
       FROM operations_shopify_checkout_rate_match_candidates(
         $1::uuid, $2::uuid, true
       )`,
      [input.organizationId, candidate.id],
    )
    const potential = await client.query<{ candidate_count: number }>(
      `SELECT count(*)::integer AS candidate_count
       FROM operations_shopify_checkout_rate_match_candidates(
         $1::uuid, $2::uuid, false
       )`,
      [input.organizationId, candidate.id],
    )
    const candidateSetHash = createHash('sha256').update(
      exactMatches.rows.map((match) => (
        `${match.receipt_global_id}:${match.offer_hash}`
      )).sort().join('\n'),
      'utf8',
    ).digest('hex')
    const exactCandidateCount = exactMatches.rowCount || 0
    const potentialCandidateCount =
      potential.rows[0]?.candidate_count || 0
    const selected = exactCandidateCount === 1
      ? exactMatches.rows[0]
      : null
    const equivalentReceiptGlobalIds = selected
      ? (await client.query<{ receipt_global_id: string }>(
          `SELECT receipt_global_id
           FROM operations_shopify_checkout_rate_match_family_members(
             $1::uuid, $2::uuid, $3::uuid, true
           )`,
          [input.organizationId, candidate.id, selected.receipt_id],
        )).rows.map((row) => row.receipt_global_id)
      : []
    if (
      selected
      && !equivalentReceiptGlobalIds.includes(selected.receipt_global_id)
    ) {
      fail(
        'SHOPIFY_CHECKOUT_MATCH_FAMILY_INVALID',
        'Shopify checkout match-family evidence is invalid',
        500,
      )
    }
    const outcome = classifyShopifyCheckoutRateReconciliationOutcome({
      exactCandidateCount,
      potentialCandidateCount,
    })
    const evidence = {
      version: 'shopify-exact-rate-reconciliation-v2-match-family',
      matchFamilyVersion: 'shopify-material-equivalence-v1',
      orderCandidateGlobalId: input.orderCandidateGlobalId,
      accountGlobalId: candidate.account_global_id,
      exactCandidateCount,
      potentialCandidateCount,
      candidateSetHash,
      matchedReceiptGlobalId: selected?.receipt_global_id || null,
      equivalentReceiptGlobalIds,
      equivalentReceiptCount: equivalentReceiptGlobalIds.length,
      canonicalReceiptSelection: selected ? 'latest_before_order' : null,
      zeroValueMerchandiseAllowed:
        Number(candidate.subtotal_minor || 0) === 0,
      providerWrites: 0,
    }
    assertShopifyCheckoutCustomerNeutralEvidence(
      evidence,
      'Shopify checkout reconciliation evidence',
    )
    const inserted = await client.query<ReconciliationRow>(
      `WITH inserted AS (
         INSERT INTO operations_shopify_checkout_rate_reconciliations (
           organization_id, integration_account_id, order_candidate_id,
           receipt_id, order_id, source_external_order_id,
           source_order_created_at, source_line_quantity_fingerprint,
           source_destination_fingerprint, source_currency,
           source_shipping_charge_minor, source_shopify_service_code,
           candidate_set_hash, selected_carrier_provider,
           selected_carrier_account_id, selected_carrier_rate_request_id,
           selected_service_code, selected_offer_hash,
           selected_customer_charge_minor, selected_currency,
           outcome, match_method, candidate_count, match_evidence,
           idempotency_key, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
           $7::timestamptz, $8, $9, $10, $11, $12, $13, $14,
           $15::uuid, $16::uuid, $17, $18, $19, $20, $21,
           'shopify_exact_rate_v1', $22, $23::jsonb, $24, $25
         )
         RETURNING *
       )
       ${RECONCILIATION_SELECT.replace(
         'FROM operations_shopify_checkout_rate_reconciliations reconciliation',
         'FROM inserted reconciliation',
       )}
       WHERE reconciliation.organization_id = $1::uuid`,
      [
        input.organizationId,
        candidate.integration_account_id,
        candidate.id,
        selected?.receipt_id || null,
        candidate.canonical_order_id,
        candidate.external_order_id,
        candidate.provider_created_at
          ? iso(candidate.provider_created_at)
          : null,
        candidate.line_quantity_fingerprint,
        candidate.checkout_destination_fingerprint,
        candidate.currency_code,
        candidate.shipping_minor,
        candidate.checkout_shipping_service_code,
        candidateSetHash,
        selected?.offer_carrier_provider || null,
        selected?.offer_carrier_account_id || null,
        selected?.offer_carrier_rate_request_id || null,
        selected?.offer_service_code || null,
        selected?.offer_hash || null,
        selected?.offer_customer_charge_minor ?? null,
        selected?.offer_currency || null,
        outcome,
        exactCandidateCount,
        JSON.stringify(evidence),
        input.idempotencyKey,
        input.actorEmail,
      ],
    )
    const reconciliation = reconciliationFromRow(inserted.rows[0])
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: `operations.shopify_checkout_rate.${outcome}`,
      aggregateType: 'operations.shopify_checkout_rate_reconciliation',
      aggregateId: reconciliation.globalId,
      subject: input.orderCandidateGlobalId,
      organizationId: input.organizationId,
      eventKey:
        `operations:shopify-checkout-reconciliation:${input.orderCandidateGlobalId}`,
      payload: evidence,
    }, client)
  return reconciliation
}

export async function
reconcileShopifyCheckoutRateForOrderCandidateInPostgres(
  rawInput: ReconcileShopifyCheckoutRateForOrderCandidateInput,
): Promise<ShopifyCheckoutRateReconciliation> {
  return withTransaction((client) => (
    reconcileShopifyCheckoutRateForOrderCandidateWithClient(client, rawInput)
  ))
}

export async function readShopifyCheckoutRateReconciliationsInPostgres(
  rawInput: {
    organizationId: string
    receiptGlobalId: string
    limit?: number
  },
): Promise<ShopifyCheckoutRateReconciliation[]> {
  const input = {
    organizationId: matchValue(
      rawInput.organizationId,
      UUID,
      'Organization ID',
    ),
    receiptGlobalId: matchValue(
      rawInput.receiptGlobalId,
      RECEIPT_GLOBAL_ID,
      'Receipt Global ID',
    ),
    limit: integer(rawInput.limit ?? 50, 'Result limit', 1, 100),
  }
  const result = await query<ReconciliationRow>(
    `${CURRENT_RECONCILIATION_SELECT}
     WHERE reconciliation.organization_id = $1::uuid
       AND receipt.global_id = $2
     ORDER BY reconciliation.created_at DESC, reconciliation.id
     LIMIT $3`,
    [
      input.organizationId,
      input.receiptGlobalId,
      input.limit,
    ],
  )
  return result.rows.map(reconciliationFromRow)
}
