import { createHash } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import type {
  CarrierWholeShipmentRateDestination,
  CarrierWholeShipmentRateParcel,
  CarrierWholeShipmentRateParty,
  CarrierWholeShipmentRateRequestEvidence,
  ParsedCarrierWholeShipmentRateResponse,
  PreparedCarrierWholeShipmentRateRequest,
} from '@/lib/integrations/carrierWholeShipmentRateFoundation'
import {
  carrierWholeShipmentRateAddressFingerprints,
  sealPreparedCarrierWholeShipmentRateRequest,
} from '@/lib/integrations/carrierWholeShipmentRateFoundation'
import { carrierAccountNumberFingerprint } from '@/lib/integrations/carrierCredentialCrypto'
import {
  createActiveCarrierDispatchRerateBinding,
  type ActiveCarrierBillingRelationship,
  type ActiveCarrierDispatchAddressSnapshot,
  type ActiveCarrierDispatchBillingSnapshot,
  type ActiveCarrierDispatchCarrierAccountReference,
  type ActiveCarrierDispatchCredentialReference,
  type ActiveCarrierDispatchEntityReference,
  type ActiveCarrierDispatchPackageSnapshot,
  type ActiveCarrierDispatchProvider,
  type ActiveCarrierDispatchSelectedRateEvidence,
} from '@/lib/operations/activeCarrierDispatchSnapshot'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'
import { orderShipToStorageValue } from '@/lib/operations/orderShipTo'
import {
  readOperationsOrderShipmentAddressInPostgres,
} from '@/lib/persistence/operationsOrderShipmentAddress'
import {
  assertCommerceOrderRevisionExecutionCurrent,
  CommerceOrderRevisionGateError,
} from '@/lib/persistence/commerceOrderRevisions'

type JsonObject = Record<string, unknown>
type RerateTerminalState = 'succeeded' | 'failed' | 'unknown'

export class ProductionFulfillmentReratePersistenceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'ProductionFulfillmentReratePersistenceError'
    this.code = code
    this.status = status
  }
}

export type PrepareProductionFulfillmentRerateInput = {
  organizationId: unknown
  activeExecutionGlobalId: unknown
  activeShipmentGroupGlobalId: unknown
  expectedActivationRevision: unknown
  destination: ActiveCarrierDispatchAddressSnapshot
  currency: unknown
  idempotencyKey: unknown
  actorEmail: unknown
}

export type ProductionFulfillmentRerateRun = {
  id: string
  globalId: string
  organization: ActiveCarrierDispatchEntityReference
  activeExecution: ActiveCarrierDispatchEntityReference
  activeShipmentGroup: ActiveCarrierDispatchEntityReference
  order: ActiveCarrierDispatchEntityReference
  plan: ActiveCarrierDispatchEntityReference
  warehouse: ActiveCarrierDispatchEntityReference
  activationRevision: number
  purpose: 'fulfillment_execution'
  environment: 'production'
  currency: string
  inputHash: string
  destination: ActiveCarrierDispatchAddressSnapshot
  destinationFingerprint: string
  orderedPackageSetFingerprint: string
  packages: readonly ActiveCarrierDispatchPackageSnapshot[]
  packageCount: number
  idempotencyKey: string
  preparedAt: string
  replayed: boolean
}

export type PrepareProductionFulfillmentRerateAttemptInput = {
  organizationId: unknown
  rerateRunGlobalId: unknown
  provider: ActiveCarrierDispatchProvider
  integrationAccountGlobalId: unknown
  carrierAccountGlobalId: unknown
  origin: ActiveCarrierDispatchAddressSnapshot
  billing: ActiveCarrierDispatchBillingSnapshot
  preparedRequest: PreparedCarrierWholeShipmentRateRequest
  idempotencyKey: unknown
  actorEmail: unknown
}

export type ProductionFulfillmentRerateAttempt = {
  id: string
  globalId: string
  rerateRunId: string
  rerateRunGlobalId: string
  attemptNumber: number
  state: 'prepared'
  provider: ActiveCarrierDispatchProvider
  environment: 'production'
  integrationAccount: ActiveCarrierDispatchEntityReference
  carrierAccount: ActiveCarrierDispatchCarrierAccountReference
  credential: ActiveCarrierDispatchCredentialReference
  origin: ActiveCarrierDispatchAddressSnapshot
  originFingerprint: string
  billing: ActiveCarrierDispatchBillingSnapshot
  billingFingerprint: string
  adapterVersion: string
  requestHash: string
  redactedRequest: CarrierWholeShipmentRateRequestEvidence
  idempotencyKey: string
  persistedAt: string
  replayed: boolean
}

export type FailedProductionFulfillmentRerateOutcome = {
  state: 'failed' | 'unknown'
  errorCode: unknown
  providerReference?: unknown
  redactedResponse: JsonObject
}

export type SucceededProductionFulfillmentRerateOutcome = {
  state: 'succeeded'
  parsedResponse: ParsedCarrierWholeShipmentRateResponse
}

export type FinalizeProductionFulfillmentRerateAttemptInput = {
  organizationId: unknown
  attemptGlobalId: unknown
  outcome:
    | FailedProductionFulfillmentRerateOutcome
    | SucceededProductionFulfillmentRerateOutcome
}

export type ProductionFulfillmentRerateOffer = {
  id: string
  globalId: string
  provider: ActiveCarrierDispatchProvider
  serviceCode: string
  serviceName: string
  amountMinor: number
  currency: string
  transitDays: number | null
  deliveryAt: string | null
  offerHash: string
  expiresAt: string
}

export type ProductionFulfillmentRerateResult = {
  id: string
  globalId: string
  rerateRunGlobalId: string
  attemptGlobalId: string
  state: RerateTerminalState
  providerReference: string | null
  errorCode: string | null
  resultHash: string
  completedAt: string
  expiresAt: string | null
  offers: readonly ProductionFulfillmentRerateOffer[]
  replayed: boolean
}

export type SelectProductionFulfillmentRerateOfferInput = {
  organizationId: unknown
  rerateRunGlobalId: unknown
  offerGlobalId: unknown
  selectionReason: unknown
  idempotencyKey: unknown
  selectedBy: unknown
}

export type ProductionFulfillmentRerateSelection = {
  id: string
  globalId: string
  rerateRunGlobalId: string
  attemptGlobalId: string
  resultGlobalId: string
  offerGlobalId: string
  provider: ActiveCarrierDispatchProvider
  serviceCode: string
  serviceName: string
  amountMinor: number
  currency: string
  expiresAt: string
  selectionReason: string
  selectedAt: string
  replayed: boolean
}

export type ProductionFulfillmentRerateDispatchContext = {
  environment: 'production'
  organization: ActiveCarrierDispatchEntityReference
  order: ActiveCarrierDispatchEntityReference
  plan: ActiveCarrierDispatchEntityReference
  warehouse: ActiveCarrierDispatchEntityReference
  provider: ActiveCarrierDispatchProvider
  integrationAccount: ActiveCarrierDispatchEntityReference
  carrierAccount: ActiveCarrierDispatchCarrierAccountReference
  credential: ActiveCarrierDispatchCredentialReference
  billing: ActiveCarrierDispatchBillingSnapshot
  origin: ActiveCarrierDispatchAddressSnapshot
  destination: ActiveCarrierDispatchAddressSnapshot
  selectedRateEvidence: ActiveCarrierDispatchSelectedRateEvidence
  packages: readonly ActiveCarrierDispatchPackageSnapshot[]
  adapterVersion: string
}

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const GLOBAL_IDS = {
  organization: /^ga(?:[0-9]{7}|[0-9a-v]{12})$/u,
  activeExecution: /^gaex(?:[0-9]{7}|[0-9a-v]{12})$/u,
  activeShipmentGroup: /^gash(?:[0-9]{7}|[0-9a-v]{12})$/u,
  order: /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u,
  plan: /^gfp(?:[0-9]{7}|[0-9a-v]{12})$/u,
  warehouse: /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/u,
  package: /^gpa(?:[0-9]{7}|[0-9a-v]{12})$/u,
  integrationAccount: /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u,
  carrierAccount: /^gac(?:[0-9]{7}|[0-9a-v]{12})$/u,
  run: /^gafr(?:[0-9]{7}|[0-9a-v]{12})$/u,
  attempt: /^gara(?:[0-9]{7}|[0-9a-v]{12})$/u,
  result: /^garr(?:[0-9]{7}|[0-9a-v]{12})$/u,
  offer: /^garo(?:[0-9]{7}|[0-9a-v]{12})$/u,
  selection: /^gars(?:[0-9]{7}|[0-9a-v]{12})$/u,
} as const
const FORBIDDEN_EVIDENCE_KEYS = new Set([
  'accesstoken',
  'accountnumber',
  'authorization',
  'clientsecret',
  'credentialciphertext',
  'credentialiv',
  'credentialtag',
  'password',
  'payeraccountnumber',
  'refreshtoken',
  'secret',
])
const PRODUCTION_RERATE_RESULT_TTL_MS = 5 * 60 * 1000
const PRODUCTION_RERATE_MAX_TTL_MS = 15 * 60 * 1000

function fail(code: string, message: string, status = 409): never {
  throw new ProductionFulfillmentReratePersistenceError(code, message, status)
}

async function requireCurrentCommerceRevision(
  client: PoolClient,
  input: {
    organizationId: string
    orderId: string
    operation: 'rate' | 'select_rate' | 'label'
  },
) {
  try {
    await assertCommerceOrderRevisionExecutionCurrent(client, input)
  } catch (error) {
    if (error instanceof CommerceOrderRevisionGateError) {
      fail(error.code, error.message, error.status)
    }
    throw error
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

function fingerprint(kind: string, value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ kind, value })), 'utf8')
    .digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as JsonObject)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function requiredText(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string') {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', `${label} is required`, 400)
  }
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function optionalText(value: unknown, label: string, maximum = 200): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredText(value, label, maximum)
}

function requiredUuid(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 36).toLowerCase()
  if (!UUID.test(normalized)) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function requiredGlobalId(
  value: unknown,
  label: string,
  pattern: RegExp,
): string {
  const normalized = requiredText(value, label, 20).toLowerCase()
  if (!pattern.test(normalized)) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function requiredHash(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 64).toLowerCase()
  if (!SHA256.test(normalized)) {
    fail('OPERATIONS_PRODUCTION_RERATE_HASH_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function nonNegativeInteger(value: unknown, label: string): number {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function requiredInstant(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 48)
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', `${label} is invalid`, 400)
  }
  return new Date(parsed).toISOString()
}

function currency(value: unknown): string {
  const normalized = requiredText(value, 'Currency', 3).toUpperCase()
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', 'Currency is invalid', 400)
  }
  return normalized
}

function actorEmail(value: unknown): string {
  const normalized = requiredText(value, 'Actor email', 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', 'Actor email is invalid', 400)
  }
  return normalized
}

function idempotencyKey(value: unknown): string {
  const normalized = requiredText(value, 'Idempotency key', 200)
  if (normalized.length < 8) {
    fail(
      'OPERATIONS_PRODUCTION_RERATE_IDEMPOTENCY_INVALID',
      'Idempotency key must contain at least eight characters',
      400,
    )
  }
  return normalized
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', `${label} must be an object`, 400)
  }
  return value as JsonObject
}

function assertRedactedEvidence(value: unknown, label: string): JsonObject {
  const root = jsonObject(value, label)
  const encoded = JSON.stringify(root)
  if (Buffer.byteLength(encoded, 'utf8') > 262_144) {
    fail('OPERATIONS_PRODUCTION_RERATE_EVIDENCE_INVALID', `${label} is too large`, 400)
  }
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    for (const [key, child] of Object.entries(candidate as JsonObject)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
      if (FORBIDDEN_EVIDENCE_KEYS.has(normalizedKey)) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_EVIDENCE_NOT_REDACTED',
          `${label} contains forbidden secret or account-number material`,
          400,
        )
      }
      visit(child)
    }
  }
  visit(root)
  return root
}

function normalizeAddress(
  value: ActiveCarrierDispatchAddressSnapshot,
  label: string,
): ActiveCarrierDispatchAddressSnapshot {
  const source = jsonObject(value, label)
  const countryCode = requiredText(source.countryCode, `${label} country`, 2)
    .toUpperCase()
  if (!/^[A-Z]{2}$/u.test(countryCode)) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', `${label} country is invalid`, 400)
  }
  if (typeof source.residential !== 'boolean') {
    fail(
      'OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID',
      `${label} residential classification is required`,
      400,
    )
  }
  return {
    contactName: requiredText(source.contactName, `${label} contact name`, 100),
    companyName: optionalText(source.companyName, `${label} company name`, 120),
    phone: optionalText(source.phone, `${label} phone`, 40),
    email: optionalText(source.email, `${label} email`, 254),
    line1: requiredText(source.line1, `${label} line 1`, 160),
    line2: optionalText(source.line2, `${label} line 2`, 120),
    line3: optionalText(source.line3, `${label} line 3`, 120),
    city: requiredText(source.city, `${label} city`, 100),
    region: optionalText(source.region, `${label} region`, 100),
    postalCode: requiredText(source.postalCode, `${label} postal code`, 32),
    countryCode,
    residential: source.residential,
  }
}

function normalizeBilling(
  value: ActiveCarrierDispatchBillingSnapshot,
): ActiveCarrierDispatchBillingSnapshot {
  const source = jsonObject(value, 'Billing')
  const relationship = source.relationship
  if (
    relationship !== 'sender'
    && relationship !== 'recipient'
    && relationship !== 'third_party'
  ) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', 'Billing relationship is invalid', 400)
  }
  const payerCountryCode = requiredText(
    source.payerCountryCode,
    'Billing payer country',
    2,
  ).toUpperCase()
  if (!/^[A-Z]{2}$/u.test(payerCountryCode)) {
    fail('OPERATIONS_PRODUCTION_RERATE_INPUT_INVALID', 'Billing country is invalid', 400)
  }
  return {
    relationship,
    payerAccountNumberFingerprint: requiredHash(
      source.payerAccountNumberFingerprint,
      'Billing payer account-number fingerprint',
    ),
    payerCountryCode,
    payerPostalCode: requiredText(source.payerPostalCode, 'Billing postal code', 32),
  }
}

function amountMinor(amount: unknown): number {
  const normalized = requiredText(amount, 'Carrier amount', 24)
  if (!/^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$/u.test(normalized)) {
    fail('OPERATIONS_PRODUCTION_RERATE_OFFER_INVALID', 'Carrier amount is invalid', 409)
  }
  const [whole, fraction = ''] = normalized.split('.')
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return nonNegativeInteger(minor, 'Carrier amount')
}

function resultDeliveryAt(value: string | null): string | null {
  if (!value) return null
  const parsed = Date.parse(`${value}T23:59:59.999Z`)
  if (!Number.isFinite(parsed)) {
    fail('OPERATIONS_PRODUCTION_RERATE_OFFER_INVALID', 'Delivery date is invalid', 409)
  }
  return new Date(parsed).toISOString()
}

async function runInTransaction<T>(
  client: PoolClient | undefined,
  callback: (transaction: PoolClient) => Promise<T>,
): Promise<T> {
  return client ? callback(client) : withTransaction(callback)
}

function postgresConflict(error: unknown, fallbackCode: string): never {
  if (error instanceof ProductionFulfillmentReratePersistenceError) throw error
  const message = error instanceof Error ? error.message : String(error)
  if (/production fulfillment rerate selection destination or currency is stale/iu.test(message)) {
    fail(
      'OPERATIONS_PRODUCTION_RERATE_SELECTION_DESTINATION_OR_CURRENCY_STALE',
      'The order destination or currency changed after production rerating',
      409,
    )
  }
  if (/production fulfillment rerate selection integration, account, or credential revision is stale/iu.test(message)) {
    fail(
      'OPERATIONS_PRODUCTION_RERATE_SELECTION_AUTHORITY_STALE',
      'The production carrier integration, account, or credential changed after rerating',
      409,
    )
  }
  if (/duplicate key|unique constraint|immutable|mismatch|requires|expired/iu.test(message)) {
    fail(fallbackCode, message, 409)
  }
  throw error
}

type RerateRunRow = QueryResultRow & {
  id: string
  global_id: string
  organization_id: string
  organization_global_id: string
  active_execution_id: string
  active_execution_global_id: string
  active_shipment_group_id: string
  active_shipment_group_global_id: string
  order_id: string
  order_global_id: string
  plan_id: string
  plan_global_id: string
  warehouse_id: string
  warehouse_global_id: string
  activation_revision: number
  currency: string
  input_hash: string
  destination_snapshot: JsonObject
  destination_fingerprint: string
  ordered_package_set_fingerprint: string
  package_count: number
  idempotency_key: string
  prepared_at: Date | string
}

type ReratePackageRow = QueryResultRow & {
  package_id: string
  package_global_id: string
  package_number: number
  length_mm: number
  width_mm: number
  height_mm: number
  weight_grams: number
}

type ActiveExecutionContextRow = QueryResultRow & {
  organization_global_id: string
  active_execution_id: string
  active_execution_global_id: string
  active_shipment_group_id: string
  active_shipment_group_global_id: string
  order_id: string
  order_global_id: string
  plan_id: string
  plan_global_id: string
  warehouse_id: string
  warehouse_global_id: string
  source_fulfillment_pack_rate_run_id: string
  activation_revision: number
  order_currency: string
  group_currency: string
}

function packageSnapshotFromRow(
  row: ReratePackageRow,
): ActiveCarrierDispatchPackageSnapshot {
  return {
    packageId: requiredUuid(row.package_id, 'Package ID'),
    packageGlobalId: requiredGlobalId(
      row.package_global_id,
      'Package Global ID',
      GLOBAL_IDS.package,
    ),
    packageNumber: positiveInteger(row.package_number, 'Package number'),
    dimensionsMm: {
      length: positiveInteger(row.length_mm, 'Package length'),
      width: positiveInteger(row.width_mm, 'Package width'),
      height: positiveInteger(row.height_mm, 'Package height'),
    },
    weightGrams: positiveInteger(row.weight_grams, 'Package weight'),
  }
}

function roundPhysicalQuantityUp(
  numerator: number,
  denominator: number,
): number {
  const thousandths = Math.floor(numerator / denominator)
    + (numerator % denominator === 0 ? 0 : 1)
  return thousandths / 1_000
}

/**
 * Convert the immutable millimetre/gram package ledger to the one canonical
 * IN/LB carrier request representation. Both conversions round upward to the
 * nearest thousandth so rating never understates a package's physical size.
 */
export function carrierWholeShipmentRateParcelsFromRunPackages(
  packages: readonly ActiveCarrierDispatchPackageSnapshot[],
): readonly CarrierWholeShipmentRateParcel[] {
  if (!Array.isArray(packages) || packages.length < 1 || packages.length > 50) {
    fail(
      'OPERATIONS_PRODUCTION_RERATE_PACKAGE_SET_INVALID',
      'Production rerating requires 1-50 immutable ordered packages',
      400,
    )
  }
  const converted = packages.map((entry, index) => {
    if (entry.packageNumber !== index + 1) {
      fail(
        'OPERATIONS_PRODUCTION_RERATE_PACKAGE_SET_INVALID',
        'Production rerate packages must be ordered contiguously by package number',
        400,
      )
    }
    const lengthMm = positiveInteger(
      entry.dimensionsMm.length,
      `Package ${entry.packageNumber} length`,
    )
    const widthMm = positiveInteger(
      entry.dimensionsMm.width,
      `Package ${entry.packageNumber} width`,
    )
    const heightMm = positiveInteger(
      entry.dimensionsMm.height,
      `Package ${entry.packageNumber} height`,
    )
    const weightGrams = positiveInteger(
      entry.weightGrams,
      `Package ${entry.packageNumber} weight`,
    )
    if (
      lengthMm > 2_743
      || widthMm > 2_743
      || heightMm > 2_743
      || weightGrams > 68_038
    ) {
      fail(
        'OPERATIONS_PRODUCTION_RERATE_PACKAGE_SET_INVALID',
        'Carrier rate package dimensions or weight exceed the supported maximum',
        400,
      )
    }
    return {
      description: `Fulfillment package ${entry.packageNumber}`,
      length: roundPhysicalQuantityUp(lengthMm * 10_000, 254),
      width: roundPhysicalQuantityUp(widthMm * 10_000, 254),
      height: roundPhysicalQuantityUp(heightMm * 10_000, 254),
      dimensionUnit: 'IN' as const,
      weight: roundPhysicalQuantityUp(
        weightGrams * 100_000_000,
        45_359_237,
      ),
      weightUnit: 'LB' as const,
    }
  })
  return deepFreeze(converted)
}

export function carrierRatePartyFromActiveOrigin(
  origin: ActiveCarrierDispatchAddressSnapshot,
): CarrierWholeShipmentRateParty {
  if (
    origin.countryCode !== 'US'
    || !origin.region
    || !/^[A-Z]{2}$/u.test(origin.region)
    || !origin.phone
    || origin.line3
  ) {
    fail(
      'OPERATIONS_PRODUCTION_RERATE_REQUEST_BINDING_MISMATCH',
      'Carrier request origin must be the exact supported US origin snapshot',
    )
  }
  return {
    name: origin.contactName,
    phone: origin.phone,
    line1: origin.line1,
    line2: origin.line2,
    city: origin.city,
    region: origin.region,
    postalCode: origin.postalCode,
    countryCode: 'US',
    residential: origin.residential,
  }
}

export function carrierRateDestinationFromActive(
  destination: ActiveCarrierDispatchAddressSnapshot,
): CarrierWholeShipmentRateDestination {
  if (
    destination.countryCode !== 'US'
    || !destination.region
    || !/^[A-Z]{2}$/u.test(destination.region)
    || destination.line3
  ) {
    fail(
      'OPERATIONS_PRODUCTION_RERATE_REQUEST_BINDING_MISMATCH',
      'Carrier request destination must be the exact supported US destination snapshot',
    )
  }
  return {
    name: destination.contactName,
    line1: destination.line1,
    line2: destination.line2,
    city: destination.city,
    region: destination.region,
    postalCode: destination.postalCode,
    countryCode: 'US',
    residential: destination.residential,
  }
}

function sameOrderDestination(
  orderDestination: JsonObject,
  destination: ActiveCarrierDispatchAddressSnapshot,
): boolean {
  const normalized = (value: unknown) => String(value || '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()
  const normalizedPostal = (value: unknown) => normalized(value).replace(/[\s-]/gu, '')
  const orderCountry = orderDestination.countryCode || orderDestination.country
  return (
    normalized(orderDestination.name) === normalized(destination.contactName)
    && normalized(orderDestination.line1) === normalized(destination.line1)
    && normalized(orderDestination.line2) === normalized(destination.line2)
    && normalized(orderDestination.city) === normalized(destination.city)
    && normalized(orderDestination.region) === normalized(destination.region)
    && normalizedPostal(orderDestination.postalCode)
      === normalizedPostal(destination.postalCode)
    && normalized(orderCountry) === normalized(destination.countryCode)
  )
}

async function readReratePackages(
  client: PoolClient,
  organizationId: string,
  rerateRunId: string,
): Promise<readonly ActiveCarrierDispatchPackageSnapshot[]> {
  const result = await client.query<ReratePackageRow>(
    `SELECT package_id::text, package_global_id, package_number,
            length_mm, width_mm, height_mm, weight_grams
     FROM operations_production_fulfillment_rerate_packages
     WHERE organization_id = $1::uuid
       AND rerate_run_id = $2::uuid
     ORDER BY package_number, package_global_id`,
    [organizationId, rerateRunId],
  )
  return result.rows.map(packageSnapshotFromRow)
}

async function loadRerateRun(
  client: PoolClient,
  organizationId: string,
  rerateRunId: string,
  replayed: boolean,
): Promise<ProductionFulfillmentRerateRun> {
  const result = await client.query<RerateRunRow>(
    `SELECT run.id::text, run.global_id,
            run.organization_id::text, organization.reference_code
              AS organization_global_id,
            run.active_fulfillment_execution_id::text AS active_execution_id,
            execution.global_id AS active_execution_global_id,
            run.active_shipment_group_id::text AS active_shipment_group_id,
            shipment_group.global_id AS active_shipment_group_global_id,
            run.order_id::text, orders.global_id AS order_global_id,
            run.plan_id::text, plan.global_id AS plan_global_id,
            run.warehouse_id::text, warehouse.global_id AS warehouse_global_id,
            run.activation_revision, run.currency, run.input_hash,
            run.destination_snapshot, run.destination_fingerprint,
            run.ordered_package_set_fingerprint, run.package_count,
            run.idempotency_key, run.prepared_at
     FROM operations_production_fulfillment_rerate_runs run
     JOIN workspace_organizations organization
       ON organization.id = run.organization_id
     JOIN operations_active_fulfillment_executions execution
       ON execution.organization_id = run.organization_id
      AND execution.id = run.active_fulfillment_execution_id
     JOIN operations_active_shipment_groups shipment_group
       ON shipment_group.organization_id = run.organization_id
      AND shipment_group.id = run.active_shipment_group_id
     JOIN operations_orders orders
       ON orders.organization_id = run.organization_id
      AND orders.id = run.order_id
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = run.organization_id
      AND plan.id = run.plan_id
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = run.organization_id
      AND warehouse.id = run.warehouse_id
     WHERE run.organization_id = $1::uuid
       AND run.id = $2::uuid
     LIMIT 1`,
    [organizationId, rerateRunId],
  )
  const row = result.rows[0]
  if (!row) {
    fail('OPERATIONS_PRODUCTION_RERATE_NOT_FOUND', 'Production rerate was not found', 404)
  }
  const packages = await readReratePackages(client, organizationId, row.id)
  if (packages.length !== Number(row.package_count)) {
    fail(
      'OPERATIONS_PRODUCTION_RERATE_PACKAGE_SET_INVALID',
      'Production rerate package evidence is incomplete',
    )
  }
  return deepFreeze({
    id: requiredUuid(row.id, 'Rerate run ID'),
    globalId: requiredGlobalId(row.global_id, 'Rerate run Global ID', GLOBAL_IDS.run),
    organization: {
      id: requiredUuid(row.organization_id, 'Organization ID'),
      globalId: requiredGlobalId(
        row.organization_global_id,
        'Organization Global ID',
        GLOBAL_IDS.organization,
      ),
    },
    activeExecution: {
      id: requiredUuid(row.active_execution_id, 'Active execution ID'),
      globalId: requiredGlobalId(
        row.active_execution_global_id,
        'Active execution Global ID',
        GLOBAL_IDS.activeExecution,
      ),
    },
    activeShipmentGroup: {
      id: requiredUuid(row.active_shipment_group_id, 'Active shipment group ID'),
      globalId: requiredGlobalId(
        row.active_shipment_group_global_id,
        'Active shipment group Global ID',
        GLOBAL_IDS.activeShipmentGroup,
      ),
    },
    order: {
      id: requiredUuid(row.order_id, 'Order ID'),
      globalId: requiredGlobalId(row.order_global_id, 'Order Global ID', GLOBAL_IDS.order),
    },
    plan: {
      id: requiredUuid(row.plan_id, 'Plan ID'),
      globalId: requiredGlobalId(row.plan_global_id, 'Plan Global ID', GLOBAL_IDS.plan),
    },
    warehouse: {
      id: requiredUuid(row.warehouse_id, 'Warehouse ID'),
      globalId: requiredGlobalId(
        row.warehouse_global_id,
        'Warehouse Global ID',
        GLOBAL_IDS.warehouse,
      ),
    },
    activationRevision: positiveInteger(row.activation_revision, 'Activation revision'),
    purpose: 'fulfillment_execution',
    environment: 'production',
    currency: currency(row.currency),
    inputHash: requiredHash(row.input_hash, 'Rerate input hash'),
    destination: normalizeAddress(
      row.destination_snapshot as unknown as ActiveCarrierDispatchAddressSnapshot,
      'Destination',
    ),
    destinationFingerprint: requiredHash(
      row.destination_fingerprint,
      'Destination fingerprint',
    ),
    orderedPackageSetFingerprint: requiredHash(
      row.ordered_package_set_fingerprint,
      'Package-set fingerprint',
    ),
    packages,
    packageCount: packages.length,
    idempotencyKey: idempotencyKey(row.idempotency_key),
    preparedAt: new Date(row.prepared_at).toISOString(),
    replayed,
  })
}

export async function prepareProductionFulfillmentRerateInPostgres(
  input: PrepareProductionFulfillmentRerateInput,
  suppliedClient?: PoolClient,
): Promise<ProductionFulfillmentRerateRun> {
  const organizationId = requiredUuid(input.organizationId, 'Organization ID')
  const activeExecutionGlobalId = requiredGlobalId(
    input.activeExecutionGlobalId,
    'Active execution Global ID',
    GLOBAL_IDS.activeExecution,
  )
  const activeShipmentGroupGlobalId = requiredGlobalId(
    input.activeShipmentGroupGlobalId,
    'Active shipment group Global ID',
    GLOBAL_IDS.activeShipmentGroup,
  )
  const expectedRevision = positiveInteger(
    input.expectedActivationRevision,
    'Expected activation revision',
  )
  const destination = normalizeAddress(input.destination, 'Destination')
  const expectedCurrency = currency(input.currency)
  const requestIdempotencyKey = idempotencyKey(input.idempotencyKey)
  const email = actorEmail(input.actorEmail)

  try {
    return await runInTransaction(suppliedClient, async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:production-rerate:${organizationId}:${activeShipmentGroupGlobalId}`,
      )
      const contextResult = await client.query<ActiveExecutionContextRow>(
        `SELECT organization.reference_code AS organization_global_id,
                execution.id::text AS active_execution_id,
                execution.global_id AS active_execution_global_id,
                shipment_group.id::text AS active_shipment_group_id,
                shipment_group.global_id AS active_shipment_group_global_id,
                execution.order_id::text AS order_id,
                orders.global_id AS order_global_id,
                execution.plan_id::text AS plan_id,
                plan.global_id AS plan_global_id,
                execution.warehouse_id::text AS warehouse_id,
                warehouse.global_id AS warehouse_global_id,
                shadow.fulfillment_pack_rate_run_id::text
                  AS source_fulfillment_pack_rate_run_id,
                execution.activation_revision,
                orders.currency AS order_currency,
                shipment_group.currency AS group_currency
         FROM operations_active_fulfillment_executions execution
         JOIN workspace_organizations organization
           ON organization.id = execution.organization_id
         JOIN operations_active_shipment_groups shipment_group
           ON shipment_group.organization_id = execution.organization_id
          AND shipment_group.active_fulfillment_execution_id = execution.id
         JOIN operations_fulfillment_executions shadow
           ON shadow.organization_id = execution.organization_id
          AND shadow.id = execution.shadow_fulfillment_execution_id
         JOIN operations_orders orders
           ON orders.organization_id = execution.organization_id
          AND orders.id = execution.order_id
         JOIN operations_fulfillment_plans plan
           ON plan.organization_id = execution.organization_id
          AND plan.id = execution.plan_id
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = execution.organization_id
          AND warehouse.id = execution.warehouse_id
         WHERE execution.organization_id = $1::uuid
           AND execution.global_id = $2
           AND shipment_group.global_id = $3
         LIMIT 1
         FOR SHARE OF execution, shipment_group, shadow, orders, plan,
           warehouse`,
        [organizationId, activeExecutionGlobalId, activeShipmentGroupGlobalId],
      )
      const context = contextResult.rows[0]
      if (!context) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_ACTIVE_EXECUTION_NOT_FOUND',
          'Active fulfillment execution was not found',
          404,
        )
      }
      await requireCurrentCommerceRevision(client, {
        organizationId,
        orderId: context.order_id,
        operation: 'rate',
      })
      if (
        Number(context.activation_revision) !== expectedRevision
      ) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_EXECUTION_REVISION_CHANGED',
          'Production rerating no longer matches the exact fulfillment execution lineage',
        )
      }
      if (
        currency(context.order_currency) !== expectedCurrency
        || currency(context.group_currency) !== expectedCurrency
      ) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_CURRENCY_MISMATCH',
          'Production rerate currency must match the canonical order and shipment group',
        )
      }
      const operationalDestination =
        await readOperationsOrderShipmentAddressInPostgres({
          organizationId,
          orderGlobalId: context.order_global_id,
          client,
        })
      if (!sameOrderDestination(
        orderShipToStorageValue(operationalDestination.value),
        destination,
      )) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_DESTINATION_MISMATCH',
          'Production rerate destination must match the canonical order',
        )
      }

      const packageResult = await client.query<ReratePackageRow>(
        `SELECT active_package.package_id::text,
                package.global_id AS package_global_id,
                active_package.package_number,
                package.length_mm, package.width_mm, package.height_mm,
                package.weight_grams
         FROM operations_active_execution_packages active_package
         JOIN operations_packages package
           ON package.organization_id = active_package.organization_id
          AND package.id = active_package.package_id
         WHERE active_package.organization_id = $1::uuid
           AND active_package.active_fulfillment_execution_id = $2::uuid
           AND active_package.active_shipment_group_id = $3::uuid
         ORDER BY active_package.package_number, package.global_id
         FOR SHARE OF active_package, package`,
        [
          organizationId,
          context.active_execution_id,
          context.active_shipment_group_id,
        ],
      )
      if (packageResult.rows.length < 1 || packageResult.rows.length > 50) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_PACKAGE_SET_INVALID',
          'Production rerating requires the exact 1-50 Active packages',
        )
      }
      const packages = packageResult.rows.map(packageSnapshotFromRow)
      const destinationFingerprint = fingerprint(
        'active-carrier-dispatch-destination-v1',
        destination,
      )
      const orderedPackageSetFingerprint = fingerprint(
        'active-carrier-dispatch-ordered-packages-v1',
        packages,
      )
      const inputHash = fingerprint('production-fulfillment-rerate-input-v1', {
        organizationId,
        activeExecutionId: context.active_execution_id,
        activeShipmentGroupId: context.active_shipment_group_id,
        orderId: context.order_id,
        planId: context.plan_id,
        warehouseId: context.warehouse_id,
        sourceFulfillmentPackRateRunId:
          context.source_fulfillment_pack_rate_run_id,
        activationRevision: expectedRevision,
        purpose: 'fulfillment_execution',
        environment: 'production',
        currency: expectedCurrency,
        destination,
        packages,
      })

      const existing = await client.query<{
        id: string
        input_hash: string
      }>(
        `SELECT id::text, input_hash
         FROM operations_production_fulfillment_rerate_runs
         WHERE organization_id = $1::uuid
           AND idempotency_key = $2
         LIMIT 1
         FOR UPDATE`,
        [organizationId, requestIdempotencyKey],
      )
      if (existing.rows[0]) {
        if (existing.rows[0].input_hash !== inputHash) {
          fail(
            'OPERATIONS_PRODUCTION_RERATE_IDEMPOTENCY_CONFLICT',
            'Idempotency key is already bound to different production rerate evidence',
          )
        }
        return loadRerateRun(client, organizationId, existing.rows[0].id, true)
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO operations_production_fulfillment_rerate_runs (
           organization_id, active_fulfillment_execution_id,
           active_shipment_group_id, order_id, plan_id, warehouse_id,
           source_fulfillment_pack_rate_run_id, activation_revision,
           purpose, environment, currency, input_hash,
           destination_snapshot, destination_fingerprint,
           ordered_package_set_fingerprint, package_count,
           idempotency_key, actor_email
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, $8, 'fulfillment_execution', 'production', $9, $10,
           $11::jsonb, $12, $13, $14, $15, $16
         )
         RETURNING id::text`,
        [
          organizationId,
          context.active_execution_id,
          context.active_shipment_group_id,
          context.order_id,
          context.plan_id,
          context.warehouse_id,
          context.source_fulfillment_pack_rate_run_id,
          expectedRevision,
          expectedCurrency,
          inputHash,
          JSON.stringify(destination),
          destinationFingerprint,
          orderedPackageSetFingerprint,
          packages.length,
          requestIdempotencyKey,
          email,
        ],
      )
      const rerateRunId = inserted.rows[0].id
      for (const packageRow of packages) {
        const packageHash = fingerprint('production-fulfillment-rerate-package-v1', packageRow)
        const sourcePackage = packageResult.rows.find(
          (row) => row.package_id === packageRow.packageId,
        )!
        await client.query(
          `INSERT INTO operations_production_fulfillment_rerate_packages (
             organization_id, rerate_run_id,
             active_fulfillment_execution_id, active_shipment_group_id,
             package_id, package_global_id, package_key, package_number,
             length_mm, width_mm, height_mm, weight_grams, package_hash
           )
           SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                  active_package.package_id, $5, active_package.package_key,
                  $6, $7, $8, $9, $10, $11
           FROM operations_active_execution_packages active_package
           WHERE active_package.organization_id = $1::uuid
             AND active_package.active_fulfillment_execution_id = $3::uuid
             AND active_package.active_shipment_group_id = $4::uuid
             AND active_package.package_id = $12::uuid`,
          [
            organizationId,
            rerateRunId,
            context.active_execution_id,
            context.active_shipment_group_id,
            packageRow.packageGlobalId,
            packageRow.packageNumber,
            packageRow.dimensionsMm.length,
            packageRow.dimensionsMm.width,
            packageRow.dimensionsMm.height,
            packageRow.weightGrams,
            packageHash,
            sourcePackage.package_id,
          ],
        )
      }
      return loadRerateRun(client, organizationId, rerateRunId, false)
    })
  } catch (error) {
    postgresConflict(error, 'OPERATIONS_PRODUCTION_RERATE_PREPARE_CONFLICT')
  }
}

type CarrierBindingRow = QueryResultRow & {
  integration_account_id: string
  integration_account_global_id: string
  integration_status: string
  provider: string
  environment: string
  carrier_account_id: string
  carrier_account_global_id: string
  carrier_account_status: string
  carrier_account_configuration_revision: number
  account_number_fingerprint: string
  registered_origin_fingerprint: string
  sender_name: string
  registered_address: JsonObject
  allow_sender_billing: boolean
  allow_recipient_billing: boolean
  allow_third_party_billing: boolean
  credential_revision: number
  credential_fingerprint: string
  credential_verification_status: string
}

type AttemptRow = QueryResultRow & {
  id: string
  global_id: string
  rerate_run_id: string
  rerate_run_global_id: string
  attempt_number: number
  provider: ActiveCarrierDispatchProvider
  integration_account_id: string
  integration_account_global_id: string
  carrier_account_id: string
  carrier_account_global_id: string
  carrier_account_configuration_revision: number
  account_number_fingerprint: string
  registered_origin_fingerprint: string
  credential_revision: number
  credential_fingerprint: string
  origin_snapshot: JsonObject
  origin_fingerprint: string
  billing_relationship: ActiveCarrierBillingRelationship
  payer_account_number_fingerprint: string
  payer_country_code: string
  payer_postal_code: string
  billing_snapshot: JsonObject
  billing_fingerprint: string
  adapter_version: string
  idempotency_key: string
  request_hash: string
  redacted_request: JsonObject
  persisted_at: Date | string
  current_configuration_revision: number
  current_credential_revision: number
  current_credential_fingerprint: string
  allow_sender_billing: boolean
  allow_recipient_billing: boolean
  allow_third_party_billing: boolean
}

function allowedBillingRelationships(input: {
  allow_sender_billing: boolean
  allow_recipient_billing: boolean
  allow_third_party_billing: boolean
}): readonly ActiveCarrierBillingRelationship[] {
  return [
    ...(input.allow_sender_billing ? ['sender' as const] : []),
    ...(input.allow_recipient_billing ? ['recipient' as const] : []),
    ...(input.allow_third_party_billing ? ['third_party' as const] : []),
  ]
}

function registeredAddressFingerprint(value: JsonObject): string {
  return createHash('sha256')
    .update(JSON.stringify({
      line1: String(value.line1 || '').trim().toLowerCase(),
      line2: value.line2
        ? String(value.line2).trim().toLowerCase()
        : null,
      city: String(value.city || '').trim().toLowerCase(),
      region: String(value.region || '').trim().toLowerCase(),
      postalCode: String(value.postalCode || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]/gu, ''),
      countryCode: String(value.countryCode || '').trim().toUpperCase(),
    }), 'utf8')
    .digest('hex')
}

function sameRegisteredOrigin(
  registered: JsonObject,
  senderName: string,
  origin: ActiveCarrierDispatchAddressSnapshot,
): boolean {
  const normalized = (value: unknown) => String(value || '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()
  const normalizedPostal = (value: unknown) => normalized(value).replace(/[\s-]/gu, '')
  return (
    normalized(senderName) === normalized(origin.contactName)
    && normalized(registered.line1) === normalized(origin.line1)
    && normalized(registered.line2) === normalized(origin.line2)
    && normalized(registered.city) === normalized(origin.city)
    && normalized(registered.region) === normalized(origin.region)
    && normalizedPostal(registered.postalCode) === normalizedPostal(origin.postalCode)
    && normalized(registered.countryCode) === normalized(origin.countryCode)
  )
}

async function loadRerateAttempt(
  client: PoolClient,
  organizationId: string,
  attemptId: string,
  replayed: boolean,
  requireCurrentBinding = true,
): Promise<ProductionFulfillmentRerateAttempt> {
  const result = await client.query<AttemptRow>(
    `SELECT attempt.id::text, attempt.global_id,
            attempt.rerate_run_id::text, run.global_id AS rerate_run_global_id,
            attempt.attempt_number, attempt.provider,
            attempt.integration_account_id::text,
            integration.global_id AS integration_account_global_id,
            attempt.carrier_account_id::text,
            carrier_account.global_id AS carrier_account_global_id,
            attempt.carrier_account_configuration_revision,
            attempt.account_number_fingerprint,
            attempt.registered_origin_fingerprint,
            attempt.credential_revision, attempt.credential_fingerprint,
            attempt.origin_snapshot, attempt.origin_fingerprint,
            attempt.billing_relationship,
            attempt.payer_account_number_fingerprint,
            attempt.payer_country_code, attempt.payer_postal_code,
            attempt.billing_snapshot, attempt.billing_fingerprint,
            attempt.adapter_version, attempt.idempotency_key,
            attempt.request_hash, attempt.redacted_request,
            attempt.persisted_at,
            carrier_account.configuration_revision
              AS current_configuration_revision,
            credential.credential_version AS current_credential_revision,
            credential.credential_fingerprint AS current_credential_fingerprint,
            carrier_account.allow_sender_billing,
            carrier_account.allow_recipient_billing,
            carrier_account.allow_third_party_billing
     FROM operations_production_fulfillment_rerate_attempts attempt
     JOIN operations_production_fulfillment_rerate_runs run
       ON run.organization_id = attempt.organization_id
      AND run.id = attempt.rerate_run_id
     JOIN operations_integration_accounts integration
       ON integration.organization_id = attempt.organization_id
      AND integration.id = attempt.integration_account_id
     JOIN operations_carrier_accounts carrier_account
       ON carrier_account.organization_id = attempt.organization_id
      AND carrier_account.id = attempt.carrier_account_id
     JOIN operations_carrier_credentials credential
       ON credential.organization_id = attempt.organization_id
      AND credential.integration_account_id = attempt.integration_account_id
     WHERE attempt.organization_id = $1::uuid
       AND attempt.id = $2::uuid
     LIMIT 1`,
    [organizationId, attemptId],
  )
  const row = result.rows[0]
  if (!row) {
    fail('OPERATIONS_PRODUCTION_RERATE_ATTEMPT_NOT_FOUND', 'Rerate attempt was not found', 404)
  }
  if (
    requireCurrentBinding
    && (
    Number(row.current_configuration_revision)
      !== Number(row.carrier_account_configuration_revision)
    || Number(row.current_credential_revision) !== Number(row.credential_revision)
    || row.current_credential_fingerprint !== row.credential_fingerprint
    )
  ) {
    fail(
      'OPERATIONS_PRODUCTION_RERATE_BINDING_STALE',
      'Carrier account or credential changed after rerate preparation',
    )
  }
  const relationships = allowedBillingRelationships(row)
  if (requireCurrentBinding && !relationships.includes(row.billing_relationship)) {
    fail(
      'OPERATIONS_PRODUCTION_RERATE_BILLING_STALE',
      'Carrier billing permissions changed after rerate preparation',
    )
  }
  return deepFreeze({
    id: requiredUuid(row.id, 'Rerate attempt ID'),
    globalId: requiredGlobalId(
      row.global_id,
      'Rerate attempt Global ID',
      GLOBAL_IDS.attempt,
    ),
    rerateRunId: requiredUuid(row.rerate_run_id, 'Rerate run ID'),
    rerateRunGlobalId: requiredGlobalId(
      row.rerate_run_global_id,
      'Rerate run Global ID',
      GLOBAL_IDS.run,
    ),
    attemptNumber: positiveInteger(row.attempt_number, 'Attempt number'),
    state: 'prepared',
    provider: row.provider,
    environment: 'production',
    integrationAccount: {
      id: requiredUuid(row.integration_account_id, 'Integration account ID'),
      globalId: requiredGlobalId(
        row.integration_account_global_id,
        'Integration account Global ID',
        GLOBAL_IDS.integrationAccount,
      ),
    },
    carrierAccount: {
      id: requiredUuid(row.carrier_account_id, 'Carrier account ID'),
      globalId: requiredGlobalId(
        row.carrier_account_global_id,
        'Carrier account Global ID',
        GLOBAL_IDS.carrierAccount,
      ),
      configurationRevision: positiveInteger(
        row.carrier_account_configuration_revision,
        'Carrier account configuration revision',
      ),
      accountNumberFingerprint: requiredHash(
        row.account_number_fingerprint,
        'Carrier account-number fingerprint',
      ),
      registeredOriginFingerprint: requiredHash(
        row.registered_origin_fingerprint,
        'Registered origin fingerprint',
      ),
      allowedBillingRelationships: relationships,
    },
    credential: {
      revision: positiveInteger(row.credential_revision, 'Credential revision'),
      fingerprint: requiredHash(row.credential_fingerprint, 'Credential fingerprint'),
    },
    origin: normalizeAddress(
      row.origin_snapshot as unknown as ActiveCarrierDispatchAddressSnapshot,
      'Origin',
    ),
    originFingerprint: requiredHash(row.origin_fingerprint, 'Origin fingerprint'),
    billing: normalizeBilling(
      row.billing_snapshot as unknown as ActiveCarrierDispatchBillingSnapshot,
    ),
    billingFingerprint: requiredHash(row.billing_fingerprint, 'Billing fingerprint'),
    adapterVersion: requiredText(row.adapter_version, 'Adapter version', 128),
    requestHash: requiredHash(row.request_hash, 'Request hash'),
    redactedRequest: assertRedactedEvidence(
      row.redacted_request,
      'Redacted request',
    ) as CarrierWholeShipmentRateRequestEvidence,
    idempotencyKey: idempotencyKey(row.idempotency_key),
    persistedAt: new Date(row.persisted_at).toISOString(),
    replayed,
  })
}

export async function prepareProductionFulfillmentRerateAttemptInPostgres(
  input: PrepareProductionFulfillmentRerateAttemptInput,
  suppliedClient?: PoolClient,
): Promise<ProductionFulfillmentRerateAttempt> {
  const organizationId = requiredUuid(input.organizationId, 'Organization ID')
  const rerateRunGlobalId = requiredGlobalId(
    input.rerateRunGlobalId,
    'Rerate run Global ID',
    GLOBAL_IDS.run,
  )
  if (input.provider !== 'ups_rest' && input.provider !== 'fedex_rest') {
    fail('OPERATIONS_PRODUCTION_RERATE_PROVIDER_INVALID', 'Carrier provider is invalid', 400)
  }
  const integrationAccountGlobalId = requiredGlobalId(
    input.integrationAccountGlobalId,
    'Integration account Global ID',
    GLOBAL_IDS.integrationAccount,
  )
  const carrierAccountGlobalId = requiredGlobalId(
    input.carrierAccountGlobalId,
    'Carrier account Global ID',
    GLOBAL_IDS.carrierAccount,
  )
  const origin = normalizeAddress(input.origin, 'Origin')
  const billing = normalizeBilling(input.billing)
  const requestIdempotencyKey = idempotencyKey(input.idempotencyKey)
  const email = actorEmail(input.actorEmail)

  try {
    return await runInTransaction(suppliedClient, async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:production-rerate-attempt:${organizationId}:${rerateRunGlobalId}`,
      )
      const runResult = await client.query<{
        id: string
        package_count: number
        currency: string
        destination_snapshot: JsonObject
        activation_revision: number
      }>(
        `SELECT run.id::text, run.package_count, run.currency,
                run.destination_snapshot, run.activation_revision
         FROM operations_production_fulfillment_rerate_runs run
         WHERE run.organization_id = $1::uuid
           AND run.global_id = $2
         LIMIT 1
         FOR SHARE OF run`,
        [organizationId, rerateRunGlobalId],
      )
      const run = runResult.rows[0]
      if (!run) {
        fail('OPERATIONS_PRODUCTION_RERATE_NOT_FOUND', 'Production rerate was not found', 404)
      }
      const runPackages = await readReratePackages(
        client,
        organizationId,
        run.id,
      )
      if (runPackages.length !== Number(run.package_count)) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_PACKAGE_SET_INVALID',
          'Production rerate does not contain the complete immutable package set',
        )
      }
      const carrierParcels = carrierWholeShipmentRateParcelsFromRunPackages(
        runPackages,
      )
      const runDestination = normalizeAddress(
        run.destination_snapshot as unknown as ActiveCarrierDispatchAddressSnapshot,
        'Destination',
      )

      const bindingResult = await client.query<CarrierBindingRow>(
        `SELECT integration.id::text AS integration_account_id,
                integration.global_id AS integration_account_global_id,
                integration.status AS integration_status,
                integration.provider, integration.environment,
                carrier_account.id::text AS carrier_account_id,
                carrier_account.global_id AS carrier_account_global_id,
                carrier_account.status AS carrier_account_status,
                carrier_account.configuration_revision
                  AS carrier_account_configuration_revision,
                carrier_account.account_number_fingerprint,
                carrier_account.registered_address_fingerprint
                  AS registered_origin_fingerprint,
                carrier_account.sender_name,
                carrier_account.registered_address,
                carrier_account.allow_sender_billing,
                carrier_account.allow_recipient_billing,
                carrier_account.allow_third_party_billing,
                credential.credential_version AS credential_revision,
                credential.credential_fingerprint,
                credential.verification_status
                  AS credential_verification_status
         FROM operations_integration_accounts integration
         JOIN operations_carrier_accounts carrier_account
           ON carrier_account.organization_id = integration.organization_id
          AND carrier_account.integration_account_id = integration.id
         JOIN operations_carrier_credentials credential
           ON credential.organization_id = integration.organization_id
          AND credential.integration_account_id = integration.id
         WHERE integration.organization_id = $1::uuid
           AND integration.global_id = $2
           AND carrier_account.global_id = $3
         LIMIT 1
         FOR SHARE OF integration, carrier_account, credential`,
        [organizationId, integrationAccountGlobalId, carrierAccountGlobalId],
      )
      const binding = bindingResult.rows[0]
      if (!binding) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_CARRIER_BINDING_NOT_FOUND',
          'Production carrier account and credential were not found',
          404,
        )
      }
      if (
        binding.provider !== input.provider
        || binding.environment !== 'production'
        || binding.integration_status !== 'active'
        || binding.carrier_account_status !== 'active'
        || binding.credential_verification_status !== 'verified'
      ) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_CARRIER_BINDING_INELIGIBLE',
          'Production rerating requires one active verified production carrier binding',
        )
      }
      if (
        registeredAddressFingerprint(binding.registered_address)
          !== binding.registered_origin_fingerprint
        || !sameRegisteredOrigin(binding.registered_address, binding.sender_name, origin)
      ) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_ORIGIN_MISMATCH',
          'Rerate origin must match the selected carrier account registered origin',
        )
      }
      const relationships = allowedBillingRelationships(binding)
      if (!relationships.includes(billing.relationship)) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_BILLING_INVALID',
          'Selected billing relationship is not allowed for this carrier account',
        )
      }
      if (
        billing.relationship === 'sender'
        && billing.payerAccountNumberFingerprint
          !== binding.account_number_fingerprint
      ) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_BILLING_INVALID',
          'Sender billing must use the selected carrier account',
        )
      }
      const billingAddress = billing.relationship === 'sender' ? origin : null
      if (
        billingAddress
        && (
          billing.payerCountryCode !== billingAddress.countryCode
          || billing.payerPostalCode.replace(/[\s-]/gu, '').toUpperCase()
            !== billingAddress.postalCode.replace(/[\s-]/gu, '').toUpperCase()
        )
      ) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_BILLING_INVALID',
          'Sender billing postal code and country must match the origin',
        )
      }
      if (billing.relationship !== 'sender') {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_BILLING_UNSUPPORTED',
          'Production rerating currently requires sender billing so every provider-body account number can be verified against the selected durable account',
        )
      }

      const carrierOrigin = carrierRatePartyFromActiveOrigin(origin)
      const carrierDestination = carrierRateDestinationFromActive(runDestination)
      let sealedRequest: ReturnType<
        typeof sealPreparedCarrierWholeShipmentRateRequest
      >
      try {
        sealedRequest = sealPreparedCarrierWholeShipmentRateRequest(
          input.preparedRequest,
          {
            origin: carrierOrigin,
            destination: carrierDestination,
            matchesAccountNumber: (accountNumber) => (
              carrierAccountNumberFingerprint(
                organizationId,
                input.provider,
                'production',
                accountNumber,
              ) === binding.account_number_fingerprint
            ),
          },
        )
      } catch {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_REQUEST_INTEGRITY_INVALID',
          'Prepared carrier request failed the exact account, address, and rate-only integrity check',
          400,
        )
      }
      const adapterVersion = sealedRequest.adapterVersion
      const requestHash = sealedRequest.requestHash
      const redactedRequest = assertRedactedEvidence(
        sealedRequest.redactedRequest,
        'Redacted request',
      ) as CarrierWholeShipmentRateRequestEvidence

      const safeBinding = redactedRequest.binding
      const safeBilling = redactedRequest.billing
      let carrierAddressFingerprints: ReturnType<
        typeof carrierWholeShipmentRateAddressFingerprints
      >
      try {
        carrierAddressFingerprints = carrierWholeShipmentRateAddressFingerprints({
          origin: carrierOrigin,
          destination: carrierDestination,
        })
      } catch {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_REQUEST_BINDING_MISMATCH',
          'Carrier request address evidence does not match the immutable rerate run',
        )
      }
      if (
        sealedRequest.provider !== input.provider
        || sealedRequest.environment !== 'production'
        || redactedRequest.provider !== input.provider
        || redactedRequest.environment !== 'production'
        || redactedRequest.purpose !== 'fulfillment_execution'
        || redactedRequest.rateScope !== 'multi_package_shipment'
        || redactedRequest.expectedCurrency !== currency(run.currency)
        || redactedRequest.packageCount !== Number(run.package_count)
        || !exactJson(redactedRequest.shipment.parcels, carrierParcels)
        || redactedRequest.shipment.originFingerprint
          !== carrierAddressFingerprints.originFingerprint
        || redactedRequest.shipment.destinationFingerprint
          !== carrierAddressFingerprints.destinationFingerprint
        || safeBinding.organizationId !== organizationId
        || safeBinding.integrationAccountId !== binding.integration_account_id
        || safeBinding.carrierAccountId !== binding.carrier_account_id
        || safeBinding.credentialRevision !== Number(binding.credential_revision)
        || safeBinding.credentialFingerprint !== binding.credential_fingerprint
        || safeBinding.accountNumberFingerprint !== binding.account_number_fingerprint
        || safeBilling.relationship !== billing.relationship
        || safeBilling.payerAccountNumberFingerprint
          !== billing.payerAccountNumberFingerprint
        || safeBilling.payerCountryCode !== billing.payerCountryCode
        || safeBilling.payerPostalCode !== billing.payerPostalCode
      ) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_REQUEST_BINDING_MISMATCH',
          'Prepared carrier request does not match the exact run packages, addresses, account, credential, billing, and currency',
        )
      }

      const originFingerprint = fingerprint(
        'active-carrier-dispatch-origin-v1',
        origin,
      )
      const billingFingerprint = fingerprint(
        'active-carrier-dispatch-billing-v1',
        billing,
      )
      const preparedHash = fingerprint('production-fulfillment-rerate-attempt-v1', {
        rerateRunId: run.id,
        provider: input.provider,
        integrationAccountId: binding.integration_account_id,
        carrierAccountId: binding.carrier_account_id,
        carrierAccountConfigurationRevision:
          Number(binding.carrier_account_configuration_revision),
        accountNumberFingerprint: binding.account_number_fingerprint,
        registeredOriginFingerprint: binding.registered_origin_fingerprint,
        credentialRevision: Number(binding.credential_revision),
        credentialFingerprint: binding.credential_fingerprint,
        origin,
        billing,
        adapterVersion,
        requestHash,
        redactedRequest,
      })
      const existing = await client.query<{
        id: string
        rerate_run_id: string
        provider: string
        integration_account_id: string
        carrier_account_id: string
        carrier_account_configuration_revision: number
        account_number_fingerprint: string
        registered_origin_fingerprint: string
        credential_revision: number
        credential_fingerprint: string
        origin_snapshot: JsonObject
        billing_snapshot: JsonObject
        adapter_version: string
        request_hash: string
        redacted_request: JsonObject
      }>(
        `SELECT id::text, rerate_run_id::text, provider,
                integration_account_id::text, carrier_account_id::text,
                carrier_account_configuration_revision,
                account_number_fingerprint, registered_origin_fingerprint,
                credential_revision, credential_fingerprint,
                origin_snapshot, billing_snapshot, adapter_version,
                request_hash, redacted_request
         FROM operations_production_fulfillment_rerate_attempts
         WHERE organization_id = $1::uuid
           AND idempotency_key = $2
         LIMIT 1
         FOR UPDATE`,
        [organizationId, requestIdempotencyKey],
      )
      if (existing.rows[0]) {
        const existingPreparedHash = fingerprint(
          'production-fulfillment-rerate-attempt-v1',
          {
            rerateRunId: existing.rows[0].rerate_run_id,
            provider: existing.rows[0].provider,
            integrationAccountId: existing.rows[0].integration_account_id,
            carrierAccountId: existing.rows[0].carrier_account_id,
            carrierAccountConfigurationRevision:
              Number(existing.rows[0].carrier_account_configuration_revision),
            accountNumberFingerprint: existing.rows[0].account_number_fingerprint,
            registeredOriginFingerprint: existing.rows[0].registered_origin_fingerprint,
            credentialRevision: Number(existing.rows[0].credential_revision),
            credentialFingerprint: existing.rows[0].credential_fingerprint,
            origin: existing.rows[0].origin_snapshot,
            billing: existing.rows[0].billing_snapshot,
            adapterVersion: existing.rows[0].adapter_version,
            requestHash: existing.rows[0].request_hash,
            redactedRequest: existing.rows[0].redacted_request,
          },
        )
        if (existingPreparedHash !== preparedHash) {
          fail(
            'OPERATIONS_PRODUCTION_RERATE_IDEMPOTENCY_CONFLICT',
            'Idempotency key is already bound to a different provider attempt',
          )
        }
        return loadRerateAttempt(client, organizationId, existing.rows[0].id, true)
      }

      const latest = await client.query<{
        attempt_number: number
        result_state: RerateTerminalState | null
      }>(
        `SELECT attempt.attempt_number, result.state AS result_state
         FROM operations_production_fulfillment_rerate_attempts attempt
         LEFT JOIN operations_production_fulfillment_rerate_results result
           ON result.organization_id = attempt.organization_id
          AND result.attempt_id = attempt.id
         WHERE attempt.organization_id = $1::uuid
           AND attempt.rerate_run_id = $2::uuid
           AND attempt.provider = $3
         ORDER BY attempt.attempt_number DESC
         LIMIT 1
         FOR UPDATE OF attempt`,
        [organizationId, run.id, input.provider],
      )
      const prior = latest.rows[0]
      if (prior && prior.result_state !== 'failed') {
        fail(
          prior.result_state === 'unknown'
            ? 'OPERATIONS_PRODUCTION_RERATE_UNKNOWN_RECONCILIATION_REQUIRED'
            : 'OPERATIONS_PRODUCTION_RERATE_ATTEMPT_OPEN_OR_SUCCEEDED',
          prior.result_state === 'unknown'
            ? 'Unknown carrier outcome requires reconciliation and cannot be retried'
            : 'Only a known failed rerate attempt may be retried',
        )
      }
      const attemptNumber = prior ? Number(prior.attempt_number) + 1 : 1
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO operations_production_fulfillment_rerate_attempts (
           organization_id, rerate_run_id, attempt_number, state,
           provider, environment, integration_account_id, carrier_account_id,
           carrier_account_configuration_revision,
           account_number_fingerprint, registered_origin_fingerprint,
           credential_revision, credential_fingerprint,
           sender_name_snapshot, origin_snapshot, origin_fingerprint,
           billing_relationship, payer_account_number_fingerprint,
           payer_country_code, payer_postal_code,
           billing_snapshot, billing_fingerprint,
           adapter_version, idempotency_key, request_hash,
           redacted_request, actor_email
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'prepared', $4, 'production',
           $5::uuid, $6::uuid, $7, $8, $9, $10, $11, $12,
           $13::jsonb, $14, $15, $16, $17, $18,
           $19::jsonb, $20, $21, $22, $23, $24::jsonb, $25
         )
         RETURNING id::text`,
        [
          organizationId,
          run.id,
          attemptNumber,
          input.provider,
          binding.integration_account_id,
          binding.carrier_account_id,
          Number(binding.carrier_account_configuration_revision),
          binding.account_number_fingerprint,
          binding.registered_origin_fingerprint,
          Number(binding.credential_revision),
          binding.credential_fingerprint,
          binding.sender_name,
          JSON.stringify(origin),
          originFingerprint,
          billing.relationship,
          billing.payerAccountNumberFingerprint,
          billing.payerCountryCode,
          billing.payerPostalCode,
          JSON.stringify(billing),
          billingFingerprint,
          adapterVersion,
          requestIdempotencyKey,
          requestHash,
          JSON.stringify(redactedRequest),
          email,
        ],
      )
      return loadRerateAttempt(client, organizationId, inserted.rows[0].id, false)
    })
  } catch (error) {
    postgresConflict(error, 'OPERATIONS_PRODUCTION_RERATE_ATTEMPT_CONFLICT')
  }
}

type ResultRow = QueryResultRow & {
  id: string
  global_id: string
  rerate_run_global_id: string
  attempt_global_id: string
  state: RerateTerminalState
  provider_reference: string | null
  error_code: string | null
  result_hash: string
  redacted_response: JsonObject
  completed_at: Date | string
  expires_at: Date | string | null
}

type OfferRow = QueryResultRow & {
  id: string
  global_id: string
  provider: ActiveCarrierDispatchProvider
  service_code: string
  service_name: string
  amount_minor: string | number
  currency: string
  transit_days: number | null
  delivery_at: Date | string | null
  offer_hash: string
  normalized_offer: JsonObject
  expires_at: Date | string
}

function instantOrNull(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

async function readRerateOffers(
  client: PoolClient,
  organizationId: string,
  resultId: string,
): Promise<readonly ProductionFulfillmentRerateOffer[]> {
  const result = await client.query<OfferRow>(
    `SELECT id::text, global_id, provider, service_code, service_name,
            amount_minor::text, currency, transit_days, delivery_at,
            offer_hash, normalized_offer, expires_at
     FROM operations_production_fulfillment_rerate_offers
     WHERE organization_id = $1::uuid
       AND result_id = $2::uuid
     ORDER BY amount_minor, service_code, global_id`,
    [organizationId, resultId],
  )
  return result.rows.map((row) => deepFreeze({
    id: requiredUuid(row.id, 'Rerate offer ID'),
    globalId: requiredGlobalId(row.global_id, 'Rerate offer Global ID', GLOBAL_IDS.offer),
    provider: row.provider,
    serviceCode: requiredText(row.service_code, 'Service code', 80),
    serviceName: requiredText(row.service_name, 'Service name', 160),
    amountMinor: nonNegativeInteger(row.amount_minor, 'Offer amount'),
    currency: currency(row.currency),
    transitDays: row.transit_days === null
      ? null
      : nonNegativeInteger(row.transit_days, 'Transit days'),
    deliveryAt: instantOrNull(row.delivery_at),
    offerHash: requiredHash(row.offer_hash, 'Offer hash'),
    expiresAt: requiredInstant(new Date(row.expires_at).toISOString(), 'Offer expiration'),
  }))
}

async function loadRerateResult(
  client: PoolClient,
  organizationId: string,
  resultId: string,
  replayed: boolean,
): Promise<ProductionFulfillmentRerateResult> {
  const result = await client.query<ResultRow>(
    `SELECT result.id::text, result.global_id,
            run.global_id AS rerate_run_global_id,
            attempt.global_id AS attempt_global_id,
            result.state, result.provider_reference, result.error_code,
            result.result_hash, result.redacted_response,
            result.completed_at, result.expires_at
     FROM operations_production_fulfillment_rerate_results result
     JOIN operations_production_fulfillment_rerate_runs run
       ON run.organization_id = result.organization_id
      AND run.id = result.rerate_run_id
     JOIN operations_production_fulfillment_rerate_attempts attempt
       ON attempt.organization_id = result.organization_id
      AND attempt.id = result.attempt_id
     WHERE result.organization_id = $1::uuid
       AND result.id = $2::uuid
     LIMIT 1`,
    [organizationId, resultId],
  )
  const row = result.rows[0]
  if (!row) {
    fail('OPERATIONS_PRODUCTION_RERATE_RESULT_NOT_FOUND', 'Rerate result was not found', 404)
  }
  const offers = await readRerateOffers(client, organizationId, row.id)
  if ((row.state === 'succeeded') !== (offers.length > 0)) {
    fail(
      'OPERATIONS_PRODUCTION_RERATE_RESULT_INCOMPLETE',
      'Rerate result and normalized offer evidence are incomplete',
    )
  }
  return deepFreeze({
    id: requiredUuid(row.id, 'Rerate result ID'),
    globalId: requiredGlobalId(row.global_id, 'Rerate result Global ID', GLOBAL_IDS.result),
    rerateRunGlobalId: requiredGlobalId(
      row.rerate_run_global_id,
      'Rerate run Global ID',
      GLOBAL_IDS.run,
    ),
    attemptGlobalId: requiredGlobalId(
      row.attempt_global_id,
      'Rerate attempt Global ID',
      GLOBAL_IDS.attempt,
    ),
    state: row.state,
    providerReference: optionalText(row.provider_reference, 'Provider reference', 200),
    errorCode: optionalText(row.error_code, 'Error code', 128),
    resultHash: requiredHash(row.result_hash, 'Rerate result hash'),
    completedAt: requiredInstant(new Date(row.completed_at).toISOString(), 'Completed at'),
    expiresAt: instantOrNull(row.expires_at),
    offers,
    replayed,
  })
}

export async function finalizeProductionFulfillmentRerateAttemptInPostgres(
  input: FinalizeProductionFulfillmentRerateAttemptInput,
  suppliedClient?: PoolClient,
): Promise<ProductionFulfillmentRerateResult> {
  const organizationId = requiredUuid(input.organizationId, 'Organization ID')
  const attemptGlobalId = requiredGlobalId(
    input.attemptGlobalId,
    'Rerate attempt Global ID',
    GLOBAL_IDS.attempt,
  )

  try {
    return await runInTransaction(suppliedClient, async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:production-rerate-finalize:${organizationId}:${attemptGlobalId}`,
      )
      const attemptIdentity = await client.query<{
        id: string
        rerate_run_id: string
      }>(
        `SELECT id::text, rerate_run_id::text
         FROM operations_production_fulfillment_rerate_attempts
         WHERE organization_id = $1::uuid
           AND global_id = $2
         LIMIT 1
         FOR SHARE`,
        [organizationId, attemptGlobalId],
      )
      const identity = attemptIdentity.rows[0]
      if (!identity) {
        fail('OPERATIONS_PRODUCTION_RERATE_ATTEMPT_NOT_FOUND', 'Rerate attempt was not found', 404)
      }
      // The exact terminal outcome must remain recordable even if account or
      // credential configuration rotates while the already-persisted network
      // request is in flight. Offer selection performs the current-binding
      // check later and fails closed on any drift.
      const attempt = await loadRerateAttempt(
        client,
        organizationId,
        identity.id,
        false,
        false,
      )
      const run = await loadRerateRun(
        client,
        organizationId,
        identity.rerate_run_id,
        false,
      )
      const existingResult = await client.query<ResultRow>(
        `SELECT result.id::text, result.global_id,
                run.global_id AS rerate_run_global_id,
                attempt.global_id AS attempt_global_id,
                result.state, result.provider_reference, result.error_code,
                result.result_hash, result.redacted_response,
                result.completed_at, result.expires_at
         FROM operations_production_fulfillment_rerate_results result
         JOIN operations_production_fulfillment_rerate_runs run
           ON run.organization_id = result.organization_id
          AND run.id = result.rerate_run_id
         JOIN operations_production_fulfillment_rerate_attempts attempt
           ON attempt.organization_id = result.organization_id
          AND attempt.id = result.attempt_id
         WHERE result.organization_id = $1::uuid
           AND result.attempt_id = $2::uuid
         LIMIT 1
         FOR SHARE OF result`,
        [organizationId, attempt.id],
      )
      const existing = existingResult.rows[0]
      const serverClockResult = await client.query<{ server_now: Date | string }>(
        'SELECT clock_timestamp() AS server_now',
      )
      const serverTimestamp = new Date(
        serverClockResult.rows[0].server_now,
      ).toISOString()

      let state: RerateTerminalState
      let providerReference: string | null
      let errorCode: string | null
      let resultHash: string
      let redactedResponse: JsonObject
      let completedAt: string
      let expiresAt: string | null
      let normalizedOffers: Array<{
        serviceCode: string
        serviceName: string
        amountMinor: number
        currency: string
        rateType: string | null
        transitDays: number | null
        deliveryAt: string | null
        offerHash: string
        normalizedOffer: JsonObject
      }> = []

      if (input.outcome.state === 'succeeded') {
        const response = input.outcome.parsedResponse
        state = 'succeeded'
        providerReference = requiredText(
          response.evidence.providerReference,
          'Provider reference',
          200,
        )
        errorCode = null
        const providerCompletedAt = requiredInstant(
          response.evidence.completedAt,
          'Provider completed at',
        )
        const providerRequestedAt = requiredInstant(
          response.evidence.requestedAt,
          'Provider requested at',
        )
        completedAt = existing
          ? new Date(existing.completed_at).toISOString()
          : serverTimestamp
        if (existing && existing.expires_at === null) {
          fail(
            'OPERATIONS_PRODUCTION_RERATE_FINALIZATION_CONFLICT',
            'Existing successful provider result is missing its immutable expiration',
          )
        }
        expiresAt = existing
          ? new Date(existing.expires_at as Date | string).toISOString()
          : new Date(
              Date.parse(completedAt) + PRODUCTION_RERATE_RESULT_TTL_MS,
            ).toISOString()
        redactedResponse = assertRedactedEvidence(
          response.evidence.redactedResponse,
          'Redacted response',
        )
        if (
          response.provider !== attempt.provider
          || response.environment !== 'production'
          || response.purpose !== 'fulfillment_execution'
          || response.rateScope !== 'multi_package_shipment'
          || response.packageCount !== run.packageCount
          || response.expectedCurrency !== run.currency
          || response.evidence.requestHash !== attempt.requestHash
          || response.evidence.redactedResponse.packageCount !== run.packageCount
          || response.evidence.redactedResponse.provider !== attempt.provider
          || response.evidence.redactedResponse.environment !== 'production'
          || response.evidence.redactedResponse.purpose !== 'fulfillment_execution'
          || response.evidence.redactedResponse.rateScope !== 'multi_package_shipment'
          || !exactJson(response.evidence.redactedRequest, attempt.redactedRequest)
          || response.rates.length < 1
          || response.rates.length > 100
          || Date.parse(providerRequestedAt) > Date.parse(providerCompletedAt)
          || Date.parse(expiresAt) <= Date.parse(completedAt)
          || Date.parse(expiresAt) - Date.parse(completedAt)
            > PRODUCTION_RERATE_MAX_TTL_MS
          || (
            !existing
            && Date.parse(expiresAt) <= Date.parse(serverTimestamp)
          )
        ) {
          fail(
            'OPERATIONS_PRODUCTION_RERATE_RESULT_BINDING_MISMATCH',
            'Successful provider response does not match the exact durable attempt and unexpired production run',
          )
        }
        const providerPayloadHash = requiredHash(
          response.evidence.providerPayloadHash,
          'Provider payload hash',
        )
        const normalizedRateEvidence = response.rates.map((rate) => {
          const serviceCode = requiredText(rate.serviceCode, 'Service code', 80)
          const serviceName = requiredText(rate.serviceName, 'Service name', 160)
          const rateCurrency = currency(rate.currency)
          if (rateCurrency !== run.currency) {
            fail(
              'OPERATIONS_PRODUCTION_RERATE_CURRENCY_MISMATCH',
              'Every normalized provider offer must use the exact run currency',
            )
          }
          const transitDays = rate.transitDays === null
            ? null
            : nonNegativeInteger(rate.transitDays, 'Transit days')
          return {
            serviceCode,
            serviceName,
            amountMinor: amountMinor(rate.amount),
            currency: rateCurrency,
            rateType: optionalText(rate.rateType, 'Rate type', 120),
            transitDays,
            deliveryAt: resultDeliveryAt(rate.deliveryDate),
          }
        })
        if (new Set(normalizedRateEvidence.map((rate) => rate.serviceCode)).size
          !== normalizedRateEvidence.length) {
          fail(
            'OPERATIONS_PRODUCTION_RERATE_OFFER_INVALID',
            'Provider response contains duplicate service codes',
          )
        }
        resultHash = fingerprint('production-fulfillment-rerate-result-v1', {
          attemptId: attempt.id,
          requestHash: attempt.requestHash,
          providerPayloadHash,
          providerReference,
          completedAt,
          expiresAt,
          redactedResponse,
          rates: normalizedRateEvidence,
        })
        normalizedOffers = normalizedRateEvidence.map((offer) => {
          const normalizedOffer = canonicalize({
            ...offer,
            provider: attempt.provider,
          }) as JsonObject
          return {
            ...offer,
            normalizedOffer,
            offerHash: fingerprint('production-fulfillment-rerate-offer-v1', {
              resultHash,
              offer: normalizedOffer,
            }),
          }
        })
      } else {
        state = input.outcome.state
        providerReference = optionalText(
          input.outcome.providerReference,
          'Provider reference',
          200,
        )
        errorCode = requiredText(input.outcome.errorCode, 'Error code', 128).toUpperCase()
        if (!/^[A-Z0-9_]{3,128}$/u.test(errorCode)) {
          fail('OPERATIONS_PRODUCTION_RERATE_RESULT_INVALID', 'Error code is invalid', 400)
        }
        redactedResponse = assertRedactedEvidence(
          input.outcome.redactedResponse,
          'Redacted response',
        )
        completedAt = existing
          ? new Date(existing.completed_at).toISOString()
          : serverTimestamp
        expiresAt = null
        resultHash = fingerprint('production-fulfillment-rerate-result-v1', {
          attemptId: attempt.id,
          requestHash: attempt.requestHash,
          state,
          providerReference,
          errorCode,
          completedAt,
          redactedResponse,
        })
      }

      if (existing) {
        if (
          existing.state !== state
          || existing.provider_reference !== providerReference
          || existing.error_code !== errorCode
          || existing.result_hash !== resultHash
          || new Date(existing.completed_at).toISOString() !== completedAt
          || instantOrNull(existing.expires_at) !== expiresAt
          || !exactJson(existing.redacted_response, redactedResponse)
        ) {
          fail(
            'OPERATIONS_PRODUCTION_RERATE_FINALIZATION_CONFLICT',
            'Provider attempt was already finalized with different immutable evidence',
          )
        }
        const loaded = await loadRerateResult(client, organizationId, existing.id, true)
        if (
          loaded.offers.length !== normalizedOffers.length
          || loaded.offers.some((offer) => !normalizedOffers.some(
            (expected) => expected.offerHash === offer.offerHash,
          ))
        ) {
          fail(
            'OPERATIONS_PRODUCTION_RERATE_FINALIZATION_CONFLICT',
            'Existing provider result has different normalized offer evidence',
          )
        }
        return loaded
      }

      const insertedResult = await client.query<{ id: string }>(
        `INSERT INTO operations_production_fulfillment_rerate_results (
           organization_id, rerate_run_id, attempt_id, state,
           provider_reference, error_code, result_hash,
           redacted_response, completed_at, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
           $8::jsonb, $9::timestamptz, $10::timestamptz
         )
         RETURNING id::text`,
        [
          organizationId,
          run.id,
          attempt.id,
          state,
          providerReference,
          errorCode,
          resultHash,
          JSON.stringify(redactedResponse),
          completedAt,
          expiresAt,
        ],
      )
      const resultId = insertedResult.rows[0].id
      for (const offer of normalizedOffers) {
        await client.query(
          `INSERT INTO operations_production_fulfillment_rerate_offers (
             organization_id, rerate_run_id, attempt_id, result_id,
             provider, service_code, service_name, amount_minor, currency,
             transit_days, delivery_at, offer_hash, normalized_offer, expires_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             $5, $6, $7, $8, $9, $10, $11::timestamptz,
             $12, $13::jsonb, $14::timestamptz
           )`,
          [
            organizationId,
            run.id,
            attempt.id,
            resultId,
            attempt.provider,
            offer.serviceCode,
            offer.serviceName,
            offer.amountMinor,
            offer.currency,
            offer.transitDays,
            offer.deliveryAt,
            offer.offerHash,
            JSON.stringify(offer.normalizedOffer),
            expiresAt,
          ],
        )
      }
      return loadRerateResult(client, organizationId, resultId, false)
    })
  } catch (error) {
    postgresConflict(error, 'OPERATIONS_PRODUCTION_RERATE_FINALIZATION_CONFLICT')
  }
}

type SelectionRow = QueryResultRow & {
  id: string
  global_id: string
  rerate_run_id: string
  rerate_run_global_id: string
  attempt_id: string
  attempt_global_id: string
  result_id: string
  result_global_id: string
  offer_id: string
  offer_global_id: string
  provider: ActiveCarrierDispatchProvider
  service_code: string
  service_name: string
  amount_minor: string | number
  currency: string
  expires_at: Date | string
  selection_reason: string
  selected_at: Date | string
}

async function loadRerateSelection(
  client: PoolClient,
  organizationId: string,
  selectionId: string,
  replayed: boolean,
): Promise<ProductionFulfillmentRerateSelection> {
  const result = await client.query<SelectionRow>(
    `SELECT selection.id::text, selection.global_id,
            selection.rerate_run_id::text, run.global_id AS rerate_run_global_id,
            selection.attempt_id::text, attempt.global_id AS attempt_global_id,
            selection.result_id::text, result.global_id AS result_global_id,
            selection.offer_id::text, offer.global_id AS offer_global_id,
            selection.provider, selection.service_code, selection.service_name,
            selection.amount_minor::text, selection.currency,
            selection.expires_at, selection.selection_reason,
            selection.selected_at
     FROM operations_production_fulfillment_rerate_selections selection
     JOIN operations_production_fulfillment_rerate_runs run
       ON run.organization_id = selection.organization_id
      AND run.id = selection.rerate_run_id
     JOIN operations_production_fulfillment_rerate_attempts attempt
       ON attempt.organization_id = selection.organization_id
      AND attempt.id = selection.attempt_id
     JOIN operations_production_fulfillment_rerate_results result
       ON result.organization_id = selection.organization_id
      AND result.id = selection.result_id
     JOIN operations_production_fulfillment_rerate_offers offer
       ON offer.organization_id = selection.organization_id
      AND offer.id = selection.offer_id
     WHERE selection.organization_id = $1::uuid
       AND selection.id = $2::uuid
     LIMIT 1`,
    [organizationId, selectionId],
  )
  const row = result.rows[0]
  if (!row) {
    fail('OPERATIONS_PRODUCTION_RERATE_SELECTION_NOT_FOUND', 'Rerate selection was not found', 404)
  }
  return deepFreeze({
    id: requiredUuid(row.id, 'Rerate selection ID'),
    globalId: requiredGlobalId(
      row.global_id,
      'Rerate selection Global ID',
      GLOBAL_IDS.selection,
    ),
    rerateRunGlobalId: requiredGlobalId(
      row.rerate_run_global_id,
      'Rerate run Global ID',
      GLOBAL_IDS.run,
    ),
    attemptGlobalId: requiredGlobalId(
      row.attempt_global_id,
      'Rerate attempt Global ID',
      GLOBAL_IDS.attempt,
    ),
    resultGlobalId: requiredGlobalId(
      row.result_global_id,
      'Rerate result Global ID',
      GLOBAL_IDS.result,
    ),
    offerGlobalId: requiredGlobalId(
      row.offer_global_id,
      'Rerate offer Global ID',
      GLOBAL_IDS.offer,
    ),
    provider: row.provider,
    serviceCode: requiredText(row.service_code, 'Service code', 80),
    serviceName: requiredText(row.service_name, 'Service name', 160),
    amountMinor: nonNegativeInteger(row.amount_minor, 'Selected amount'),
    currency: currency(row.currency),
    expiresAt: requiredInstant(new Date(row.expires_at).toISOString(), 'Selection expiration'),
    selectionReason: requiredText(row.selection_reason, 'Selection reason', 500),
    selectedAt: requiredInstant(new Date(row.selected_at).toISOString(), 'Selected at'),
    replayed,
  })
}

type SelectableOfferRow = QueryResultRow & {
  server_now: Date | string
  offer_id: string
  offer_global_id: string
  rerate_run_id: string
  order_id: string
  active_fulfillment_execution_id: string
  active_shipment_group_id: string
  attempt_id: string
  result_id: string
  provider: ActiveCarrierDispatchProvider
  service_code: string
  service_name: string
  amount_minor: string | number
  currency: string
  integration_account_id: string
  carrier_account_id: string
  carrier_account_configuration_revision: number
  account_number_fingerprint: string
  registered_origin_fingerprint: string
  credential_revision: number
  credential_fingerprint: string
  adapter_version: string
  provider_reference: string
  input_hash: string
  result_hash: string
  origin_fingerprint: string
  destination_fingerprint: string
  billing_fingerprint: string
  ordered_package_set_fingerprint: string
  destination_snapshot: JsonObject
  expires_at: Date | string
  result_state: RerateTerminalState
  activation_revision: number
}

export async function selectProductionFulfillmentRerateOfferInPostgres(
  input: SelectProductionFulfillmentRerateOfferInput,
  suppliedClient?: PoolClient,
): Promise<ProductionFulfillmentRerateSelection> {
  const organizationId = requiredUuid(input.organizationId, 'Organization ID')
  const rerateRunGlobalId = requiredGlobalId(
    input.rerateRunGlobalId,
    'Rerate run Global ID',
    GLOBAL_IDS.run,
  )
  const offerGlobalId = requiredGlobalId(
    input.offerGlobalId,
    'Rerate offer Global ID',
    GLOBAL_IDS.offer,
  )
  const selectionReason = requiredText(input.selectionReason, 'Selection reason', 500)
  if (selectionReason.length < 3) {
    fail('OPERATIONS_PRODUCTION_RERATE_SELECTION_INVALID', 'Selection reason is too short', 400)
  }
  const requestIdempotencyKey = idempotencyKey(input.idempotencyKey)
  const selectedBy = actorEmail(input.selectedBy)
  const commandType = 'select-production-rerate-offer'
  const requestHash = fingerprint(
    'production-fulfillment-rerate-selection-command-v1',
    {
      rerateRunGlobalId,
      offerGlobalId,
      selectionReason,
    },
  )

  try {
    return await runInTransaction(suppliedClient, async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:production-rerate-selection-command:${organizationId}:${requestIdempotencyKey}`,
      )
      const priorReceipt = await client.query<{
        request_hash: string
        status: 'processing' | 'succeeded' | 'failed'
        result_global_id: string | null
      }>(
        `SELECT request_hash, status, result_global_id
         FROM operations_command_receipts
         WHERE organization_id = $1::uuid
           AND command_type = $2
           AND idempotency_key = $3
         LIMIT 1
         FOR UPDATE`,
        [organizationId, commandType, requestIdempotencyKey],
      )
      const receipt = priorReceipt.rows[0]
      if (receipt) {
        if (receipt.request_hash !== requestHash) {
          fail(
            'OPERATIONS_PRODUCTION_RERATE_SELECTION_IDEMPOTENCY_CONFLICT',
            'This idempotency key was already used for a different production rerate selection',
            409,
          )
        }
        if (receipt.status === 'succeeded' && receipt.result_global_id) {
          const priorSelection = await client.query<{ id: string }>(
            `SELECT id::text
             FROM operations_production_fulfillment_rerate_selections
             WHERE organization_id = $1::uuid
               AND global_id = $2
             LIMIT 1
             FOR SHARE`,
            [organizationId, receipt.result_global_id],
          )
          if (!priorSelection.rows[0]) {
            fail(
              'OPERATIONS_PRODUCTION_RERATE_SELECTION_RECEIPT_INVALID',
              'The completed selection receipt no longer resolves to its immutable result',
              409,
            )
          }
          return loadRerateSelection(
            client,
            organizationId,
            priorSelection.rows[0].id,
            true,
          )
        }
        fail(
          'OPERATIONS_PRODUCTION_RERATE_SELECTION_COMMAND_IN_PROGRESS',
          'This production rerate selection command is already being processed',
          409,
        )
      }
      const createdReceipt = await client.query<{ id: string }>(
        `INSERT INTO operations_command_receipts (
           organization_id, command_type, idempotency_key, request_hash,
           actor_email, status, correlation_id
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, 'processing', gen_random_uuid()
         )
         RETURNING id::text`,
        [
          organizationId,
          commandType,
          requestIdempotencyKey,
          requestHash,
          selectedBy,
        ],
      )
      await acquireTransactionAdvisoryLock(
        client,
        `operations:production-rerate-select:${organizationId}:${rerateRunGlobalId}`,
      )
      const existing = await client.query<{
        id: string
        offer_global_id: string
      }>(
        `SELECT selection.id::text,
                offer.global_id AS offer_global_id
         FROM operations_production_fulfillment_rerate_selections selection
         JOIN operations_production_fulfillment_rerate_runs run
           ON run.organization_id = selection.organization_id
          AND run.id = selection.rerate_run_id
         JOIN operations_production_fulfillment_rerate_offers offer
           ON offer.organization_id = selection.organization_id
          AND offer.id = selection.offer_id
         WHERE selection.organization_id = $1::uuid
           AND run.global_id = $2
         LIMIT 1
         FOR SHARE OF selection, run, offer`,
        [organizationId, rerateRunGlobalId],
      )
      if (existing.rows[0]) {
        if (existing.rows[0].offer_global_id !== offerGlobalId) {
          fail(
            'OPERATIONS_PRODUCTION_RERATE_SELECTION_CONFLICT',
            'Rerate run already selected a different immutable offer',
          )
        }
        // This is a historical command replay, not fresh dispatch authority.
        // Dispatch resolution independently revalidates expiration,
        // destination, and provider configuration before any write.
        const selection = await loadRerateSelection(
          client,
          organizationId,
          existing.rows[0].id,
          true,
        )
        await client.query(
          `UPDATE operations_command_receipts
           SET status = 'succeeded',
               result_global_id = $2,
               result_payload = $3::jsonb,
               error_code = NULL,
               error_message = NULL,
               completed_at = now(),
               updated_at = now()
           WHERE id = $1::uuid`,
          [
            createdReceipt.rows[0].id,
            selection.globalId,
            JSON.stringify(selection),
          ],
        )
        return selection
      }
      const candidateResult = await client.query<SelectableOfferRow>(
        `SELECT clock_timestamp() AS server_now,
                offer.id::text AS offer_id, offer.global_id AS offer_global_id,
                run.id::text AS rerate_run_id,
                run.order_id::text,
                run.active_fulfillment_execution_id::text,
                run.active_shipment_group_id::text,
                attempt.id::text AS attempt_id,
                result.id::text AS result_id,
                offer.provider, offer.service_code, offer.service_name,
                offer.amount_minor::text, offer.currency,
                attempt.integration_account_id::text,
                attempt.carrier_account_id::text,
                attempt.carrier_account_configuration_revision,
                attempt.account_number_fingerprint,
                attempt.registered_origin_fingerprint,
                attempt.credential_revision, attempt.credential_fingerprint,
                attempt.adapter_version, result.provider_reference,
                run.input_hash, result.result_hash,
                attempt.origin_fingerprint, run.destination_fingerprint,
                attempt.billing_fingerprint,
                run.ordered_package_set_fingerprint,
                run.destination_snapshot,
                offer.expires_at, result.state AS result_state,
                run.activation_revision
         FROM operations_production_fulfillment_rerate_offers offer
         JOIN operations_production_fulfillment_rerate_results result
           ON result.organization_id = offer.organization_id
          AND result.id = offer.result_id
         JOIN operations_production_fulfillment_rerate_attempts attempt
           ON attempt.organization_id = offer.organization_id
          AND attempt.id = offer.attempt_id
         JOIN operations_production_fulfillment_rerate_runs run
           ON run.organization_id = offer.organization_id
          AND run.id = offer.rerate_run_id
         WHERE offer.organization_id = $1::uuid
           AND offer.global_id = $2
           AND run.global_id = $3
         LIMIT 1
         FOR SHARE OF offer, result, attempt, run`,
        [organizationId, offerGlobalId, rerateRunGlobalId],
      )
      const candidate = candidateResult.rows[0]
      if (!candidate) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_OFFER_NOT_FOUND',
          'Offer does not belong to the requested organization and rerate run',
          404,
        )
      }
      if (
        candidate.result_state !== 'succeeded'
        || !candidate.provider_reference
        || Date.parse(new Date(candidate.expires_at).toISOString())
          <= Date.parse(new Date(candidate.server_now).toISOString())
      ) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_OFFER_INELIGIBLE',
          'Only one currently unexpired exact production carrier offer may be selected',
        )
      }

      // Lock every mutable row used as current selection authority in one
      // stable order. These SHARE locks remain held through the insert and its
      // database trigger, so a concurrent order, account, or credential update
      // cannot invalidate evidence between validation and commit.
      const orderResult = await client.query<{
        currency: string
        order_global_id: string
      }>(
        `SELECT orders.currency, orders.global_id AS order_global_id
         FROM operations_orders orders
         WHERE orders.organization_id = $1::uuid
           AND orders.id = $2::uuid
         LIMIT 1
         FOR SHARE`,
        [organizationId, candidate.order_id],
      )
      const currentOrder = orderResult.rows[0]
      const candidateDestination = normalizeAddress(
        candidate.destination_snapshot as unknown as ActiveCarrierDispatchAddressSnapshot,
        'Destination',
      )
      const currentOperationalDestination = currentOrder
        ? await readOperationsOrderShipmentAddressInPostgres({
            organizationId,
            orderGlobalId: currentOrder.order_global_id,
            client,
          })
        : null
      if (
        !currentOrder
        || currency(currentOrder.currency) !== currency(candidate.currency)
        || !currentOperationalDestination
        || !sameOrderDestination(
          orderShipToStorageValue(currentOperationalDestination.value),
          candidateDestination,
        )
      ) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_SELECTION_DESTINATION_OR_CURRENCY_STALE',
          'The order destination or currency changed after production rerating',
          409,
        )
      }
      await requireCurrentCommerceRevision(client, {
        organizationId,
        orderId: candidate.order_id,
        operation: 'select_rate',
      })
      const integrationResult = await client.query<{
        integration_type: string
        provider: string
        environment: string
        status: string
      }>(
        `SELECT integration_type, provider, environment, status
         FROM operations_integration_accounts
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
         LIMIT 1
         FOR SHARE`,
        [organizationId, candidate.integration_account_id],
      )
      const integration = integrationResult.rows[0]
      const carrierAccountResult = await client.query<{
        status: string
        configuration_revision: number
        account_number_fingerprint: string
        registered_address_fingerprint: string
      }>(
        `SELECT status, configuration_revision,
                account_number_fingerprint, registered_address_fingerprint
         FROM operations_carrier_accounts
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND id = $3::uuid
         LIMIT 1
         FOR SHARE`,
        [
          organizationId,
          candidate.integration_account_id,
          candidate.carrier_account_id,
        ],
      )
      const carrierAccount = carrierAccountResult.rows[0]
      const credentialResult = await client.query<{
        verification_status: string
        credential_version: number
        credential_fingerprint: string
      }>(
        `SELECT verification_status, credential_version,
                credential_fingerprint
         FROM operations_carrier_credentials
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
         LIMIT 1
         FOR SHARE`,
        [organizationId, candidate.integration_account_id],
      )
      const credential = credentialResult.rows[0]
      if (
        !integration
        || integration.integration_type !== 'carrier'
        || integration.provider !== candidate.provider
        || integration.environment !== 'production'
        || integration.status !== 'active'
        || !carrierAccount
        || carrierAccount.status !== 'active'
        || Number(carrierAccount.configuration_revision)
          !== Number(candidate.carrier_account_configuration_revision)
        || carrierAccount.account_number_fingerprint
          !== candidate.account_number_fingerprint
        || carrierAccount.registered_address_fingerprint
          !== candidate.registered_origin_fingerprint
        || !credential
        || credential.verification_status !== 'verified'
        || Number(credential.credential_version)
          !== Number(candidate.credential_revision)
        || credential.credential_fingerprint !== candidate.credential_fingerprint
      ) {
        fail(
          'OPERATIONS_PRODUCTION_RERATE_SELECTION_AUTHORITY_STALE',
          'The production carrier integration, account, or credential changed after rerating',
          409,
        )
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO operations_production_fulfillment_rerate_selections (
           organization_id, rerate_run_id,
           active_fulfillment_execution_id, active_shipment_group_id,
           attempt_id, result_id, offer_id,
           provider, service_code, service_name, amount_minor, currency,
           integration_account_id, carrier_account_id,
           carrier_account_configuration_revision,
           account_number_fingerprint, registered_origin_fingerprint,
           credential_revision, credential_fingerprint, adapter_version,
           provider_reference, input_hash, result_hash,
           origin_fingerprint, destination_fingerprint, billing_fingerprint,
           ordered_package_set_fingerprint, expires_at,
           selection_reason, selected_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, $7::uuid,
           $8, $9, $10, $11, $12,
           $13::uuid, $14::uuid, $15, $16, $17, $18, $19, $20,
           $21, $22, $23, $24, $25, $26, $27, $28::timestamptz,
           $29, $30
         )
         RETURNING id::text`,
        [
          organizationId,
          candidate.rerate_run_id,
          candidate.active_fulfillment_execution_id,
          candidate.active_shipment_group_id,
          candidate.attempt_id,
          candidate.result_id,
          candidate.offer_id,
          candidate.provider,
          candidate.service_code,
          candidate.service_name,
          candidate.amount_minor,
          candidate.currency,
          candidate.integration_account_id,
          candidate.carrier_account_id,
          Number(candidate.carrier_account_configuration_revision),
          candidate.account_number_fingerprint,
          candidate.registered_origin_fingerprint,
          Number(candidate.credential_revision),
          candidate.credential_fingerprint,
          candidate.adapter_version,
          candidate.provider_reference,
          candidate.input_hash,
          candidate.result_hash,
          candidate.origin_fingerprint,
          candidate.destination_fingerprint,
          candidate.billing_fingerprint,
          candidate.ordered_package_set_fingerprint,
          new Date(candidate.expires_at).toISOString(),
          selectionReason,
          selectedBy,
        ],
      )
      const selection = await loadRerateSelection(
        client,
        organizationId,
        inserted.rows[0].id,
        false,
      )
      await client.query(
        `UPDATE operations_command_receipts
         SET status = 'succeeded',
             result_global_id = $2,
             result_payload = $3::jsonb,
             error_code = NULL,
             error_message = NULL,
             completed_at = now(),
             updated_at = now()
         WHERE id = $1::uuid`,
        [
          createdReceipt.rows[0].id,
          selection.globalId,
          JSON.stringify(selection),
        ],
      )
      return selection
    })
  } catch (error) {
    postgresConflict(error, 'OPERATIONS_PRODUCTION_RERATE_SELECTION_CONFLICT')
  }
}

type DispatchSelectionRow = QueryResultRow & {
  server_now: Date | string
  selection_id: string
  selection_global_id: string
  selection_expires_at: Date | string
  selected_at: Date | string
  rerate_run_id: string
  rerate_run_global_id: string
  rerate_input_hash: string
  destination_snapshot: JsonObject
  destination_fingerprint: string
  ordered_package_set_fingerprint: string
  package_count: number
  activation_revision: number
  organization_id: string
  organization_global_id: string
  order_id: string
  order_global_id: string
  current_order_currency: string
  plan_id: string
  plan_global_id: string
  warehouse_id: string
  warehouse_global_id: string
  provider: ActiveCarrierDispatchProvider
  integration_account_id: string
  integration_account_global_id: string
  integration_type: string
  integration_provider: string
  integration_environment: string
  integration_status: string
  carrier_account_id: string
  carrier_account_global_id: string
  carrier_account_status: string
  carrier_account_configuration_revision: number
  current_carrier_account_configuration_revision: number
  account_number_fingerprint: string
  current_account_number_fingerprint: string
  registered_origin_fingerprint: string
  current_registered_origin_fingerprint: string
  allow_sender_billing: boolean
  allow_recipient_billing: boolean
  allow_third_party_billing: boolean
  credential_revision: number
  current_credential_revision: number
  credential_fingerprint: string
  current_credential_fingerprint: string
  credential_verification_status: string
  origin_snapshot: JsonObject
  origin_fingerprint: string
  billing_snapshot: JsonObject
  billing_fingerprint: string
  adapter_version: string
  request_hash: string
  result_state: RerateTerminalState
  rerate_result_hash: string
  provider_reference: string
  completed_at: Date | string
  result_expires_at: Date | string
  service_code: string
  service_name: string
  amount_minor: string | number
  currency: string
}

export async function loadProductionFulfillmentRerateDispatchContextInPostgres(
  organizationIdInput: unknown,
  selectionGlobalIdInput: unknown,
  suppliedClient?: PoolClient,
): Promise<ProductionFulfillmentRerateDispatchContext> {
  const organizationId = requiredUuid(organizationIdInput, 'Organization ID')
  const selectionGlobalId = requiredGlobalId(
    selectionGlobalIdInput,
    'Rerate selection Global ID',
    GLOBAL_IDS.selection,
  )
  return runInTransaction(suppliedClient, async (client) => {
    const result = await client.query<DispatchSelectionRow>(
      `SELECT clock_timestamp() AS server_now,
              selection.id::text AS selection_id,
              selection.global_id AS selection_global_id,
              selection.expires_at AS selection_expires_at,
              selection.selected_at,
              run.id::text AS rerate_run_id,
              run.global_id AS rerate_run_global_id,
              run.input_hash AS rerate_input_hash,
              run.destination_snapshot, run.destination_fingerprint,
              run.ordered_package_set_fingerprint, run.package_count,
              run.activation_revision,
              run.organization_id::text AS organization_id,
              organization.reference_code AS organization_global_id,
              run.order_id::text AS order_id,
              orders.global_id AS order_global_id,
              orders.currency AS current_order_currency,
              run.plan_id::text AS plan_id, plan.global_id AS plan_global_id,
              run.warehouse_id::text AS warehouse_id,
              warehouse.global_id AS warehouse_global_id,
              selection.provider,
              selection.integration_account_id::text AS integration_account_id,
              integration.global_id AS integration_account_global_id,
              integration.integration_type, integration.provider AS integration_provider,
              integration.environment AS integration_environment,
              integration.status AS integration_status,
              selection.carrier_account_id::text AS carrier_account_id,
              carrier_account.global_id AS carrier_account_global_id,
              carrier_account.status AS carrier_account_status,
              selection.carrier_account_configuration_revision,
              carrier_account.configuration_revision
                AS current_carrier_account_configuration_revision,
              selection.account_number_fingerprint,
              carrier_account.account_number_fingerprint
                AS current_account_number_fingerprint,
              selection.registered_origin_fingerprint,
              carrier_account.registered_address_fingerprint
                AS current_registered_origin_fingerprint,
              carrier_account.allow_sender_billing,
              carrier_account.allow_recipient_billing,
              carrier_account.allow_third_party_billing,
              selection.credential_revision,
              credential.credential_version AS current_credential_revision,
              selection.credential_fingerprint,
              credential.credential_fingerprint AS current_credential_fingerprint,
              credential.verification_status AS credential_verification_status,
              attempt.origin_snapshot, selection.origin_fingerprint,
              attempt.billing_snapshot, selection.billing_fingerprint,
              selection.adapter_version, attempt.request_hash,
              result.state AS result_state,
              selection.result_hash AS rerate_result_hash,
              selection.provider_reference, result.completed_at,
              result.expires_at AS result_expires_at,
              selection.service_code, selection.service_name,
              selection.amount_minor::text, selection.currency
       FROM operations_production_fulfillment_rerate_selections selection
       JOIN operations_production_fulfillment_rerate_runs run
         ON run.organization_id = selection.organization_id
        AND run.id = selection.rerate_run_id
       JOIN operations_production_fulfillment_rerate_attempts attempt
         ON attempt.organization_id = selection.organization_id
        AND attempt.id = selection.attempt_id
       JOIN operations_production_fulfillment_rerate_results result
         ON result.organization_id = selection.organization_id
        AND result.id = selection.result_id
       JOIN workspace_organizations organization
         ON organization.id = selection.organization_id
       JOIN operations_orders orders
         ON orders.organization_id = selection.organization_id
        AND orders.id = run.order_id
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = selection.organization_id
        AND plan.id = run.plan_id
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = selection.organization_id
        AND warehouse.id = run.warehouse_id
       JOIN operations_integration_accounts integration
         ON integration.organization_id = selection.organization_id
        AND integration.id = selection.integration_account_id
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id = selection.organization_id
        AND carrier_account.integration_account_id = selection.integration_account_id
        AND carrier_account.id = selection.carrier_account_id
       JOIN operations_carrier_credentials credential
         ON credential.organization_id = selection.organization_id
        AND credential.integration_account_id = selection.integration_account_id
       WHERE selection.organization_id = $1::uuid
         AND selection.global_id = $2
       LIMIT 1
       FOR SHARE OF selection, run, attempt, result, orders, plan, warehouse,
         integration, carrier_account, credential`,
      [organizationId, selectionGlobalId],
    )
    const row = result.rows[0]
    if (!row) {
      fail('OPERATIONS_PRODUCTION_RERATE_SELECTION_NOT_FOUND', 'Rerate selection was not found', 404)
    }
    await requireCurrentCommerceRevision(client, {
      organizationId,
      orderId: row.order_id,
      operation: 'label',
    })
    const serverNow = Date.parse(new Date(row.server_now).toISOString())
    if (
      row.result_state !== 'succeeded'
      || row.integration_type !== 'carrier'
      || row.integration_provider !== row.provider
      || row.integration_environment !== 'production'
      || row.integration_status !== 'active'
      || row.carrier_account_status !== 'active'
      || row.credential_verification_status !== 'verified'
      || Number(row.current_carrier_account_configuration_revision)
        !== Number(row.carrier_account_configuration_revision)
      || row.current_account_number_fingerprint !== row.account_number_fingerprint
      || row.current_registered_origin_fingerprint !== row.registered_origin_fingerprint
      || Number(row.current_credential_revision) !== Number(row.credential_revision)
      || row.current_credential_fingerprint !== row.credential_fingerprint
      || new Date(row.selection_expires_at).toISOString()
        !== new Date(row.result_expires_at).toISOString()
      || serverNow < Date.parse(new Date(row.selected_at).toISOString())
      || serverNow >= Date.parse(new Date(row.selection_expires_at).toISOString())
    ) {
      fail(
        'OPERATIONS_PRODUCTION_RERATE_DISPATCH_CONTEXT_STALE',
        'Selected rate evidence is expired or no longer matches the current production carrier account and credential binding',
      )
    }

    const packages = await readReratePackages(client, organizationId, row.rerate_run_id)
    if (packages.length !== Number(row.package_count)) {
      fail(
        'OPERATIONS_PRODUCTION_RERATE_PACKAGE_SET_INVALID',
        'Selected rerate does not contain the complete immutable package set',
      )
    }
    const organization: ActiveCarrierDispatchEntityReference = {
      id: requiredUuid(row.organization_id, 'Organization ID'),
      globalId: requiredGlobalId(
        row.organization_global_id,
        'Organization Global ID',
        GLOBAL_IDS.organization,
      ),
    }
    const order: ActiveCarrierDispatchEntityReference = {
      id: requiredUuid(row.order_id, 'Order ID'),
      globalId: requiredGlobalId(row.order_global_id, 'Order Global ID', GLOBAL_IDS.order),
    }
    const plan: ActiveCarrierDispatchEntityReference = {
      id: requiredUuid(row.plan_id, 'Plan ID'),
      globalId: requiredGlobalId(row.plan_global_id, 'Plan Global ID', GLOBAL_IDS.plan),
    }
    const warehouse: ActiveCarrierDispatchEntityReference = {
      id: requiredUuid(row.warehouse_id, 'Warehouse ID'),
      globalId: requiredGlobalId(
        row.warehouse_global_id,
        'Warehouse Global ID',
        GLOBAL_IDS.warehouse,
      ),
    }
    const origin = normalizeAddress(
      row.origin_snapshot as unknown as ActiveCarrierDispatchAddressSnapshot,
      'Origin',
    )
    const destination = normalizeAddress(
      row.destination_snapshot as unknown as ActiveCarrierDispatchAddressSnapshot,
      'Destination',
    )
    const currentOperationalDestination =
      await readOperationsOrderShipmentAddressInPostgres({
        organizationId,
        orderGlobalId: row.order_global_id,
        client,
      })
    if (
      currency(row.current_order_currency) !== currency(row.currency)
      || !sameOrderDestination(
        orderShipToStorageValue(currentOperationalDestination.value),
        destination,
      )
    ) {
      fail(
        'OPERATIONS_PRODUCTION_RERATE_ORDER_BINDING_STALE',
        'Current order currency or destination no longer matches the selected rerate',
      )
    }
    const billing = normalizeBilling(
      row.billing_snapshot as unknown as ActiveCarrierDispatchBillingSnapshot,
    )
    const dispatchBinding = createActiveCarrierDispatchRerateBinding({
      organization,
      order,
      plan,
      warehouse,
      origin,
      destination,
      billing,
      packages,
    })
    if (
      dispatchBinding.originFingerprint !== row.origin_fingerprint
      || dispatchBinding.destinationFingerprint !== row.destination_fingerprint
      || dispatchBinding.billingFingerprint !== row.billing_fingerprint
      || dispatchBinding.orderedPackageSetFingerprint
        !== row.ordered_package_set_fingerprint
      || dispatchBinding.packageCount !== Number(row.package_count)
    ) {
      fail(
        'OPERATIONS_PRODUCTION_RERATE_DISPATCH_BINDING_MISMATCH',
        'Immutable rerate snapshots do not reproduce the selected dispatch binding',
      )
    }
    const relationships = allowedBillingRelationships(row)
    if (!relationships.includes(billing.relationship)) {
      fail(
        'OPERATIONS_PRODUCTION_RERATE_BILLING_STALE',
        'Selected billing relationship is no longer permitted by the carrier account',
      )
    }
    const integrationAccount: ActiveCarrierDispatchEntityReference = {
      id: requiredUuid(row.integration_account_id, 'Integration account ID'),
      globalId: requiredGlobalId(
        row.integration_account_global_id,
        'Integration account Global ID',
        GLOBAL_IDS.integrationAccount,
      ),
    }
    const carrierAccount: ActiveCarrierDispatchCarrierAccountReference = {
      id: requiredUuid(row.carrier_account_id, 'Carrier account ID'),
      globalId: requiredGlobalId(
        row.carrier_account_global_id,
        'Carrier account Global ID',
        GLOBAL_IDS.carrierAccount,
      ),
      configurationRevision: positiveInteger(
        row.carrier_account_configuration_revision,
        'Carrier account configuration revision',
      ),
      accountNumberFingerprint: requiredHash(
        row.account_number_fingerprint,
        'Carrier account-number fingerprint',
      ),
      registeredOriginFingerprint: requiredHash(
        row.registered_origin_fingerprint,
        'Registered origin fingerprint',
      ),
      allowedBillingRelationships: relationships,
    }
    const credential: ActiveCarrierDispatchCredentialReference = {
      revision: positiveInteger(row.credential_revision, 'Credential revision'),
      fingerprint: requiredHash(row.credential_fingerprint, 'Credential fingerprint'),
    }
    const selectedRateEvidence: ActiveCarrierDispatchSelectedRateEvidence = {
      id: requiredUuid(row.selection_id, 'Rerate selection ID'),
      globalId: requiredGlobalId(
        row.selection_global_id,
        'Rerate selection Global ID',
        GLOBAL_IDS.selection,
      ),
      rerateRun: {
        id: requiredUuid(row.rerate_run_id, 'Rerate run ID'),
        globalId: requiredGlobalId(
          row.rerate_run_global_id,
          'Rerate run Global ID',
          GLOBAL_IDS.run,
        ),
      },
      rerateInputHash: requiredHash(row.rerate_input_hash, 'Rerate input hash'),
      rerateResultHash: requiredHash(row.rerate_result_hash, 'Rerate result hash'),
      reratePurpose: 'fulfillment_execution',
      ratePurpose: 'cartonization_shipment_rate',
      status: 'succeeded',
      environment: 'production',
      provider: row.provider,
      providerReference: requiredText(row.provider_reference, 'Provider reference', 200),
      requestHash: requiredHash(row.request_hash, 'Request hash'),
      integrationAccountId: integrationAccount.id,
      carrierAccountId: carrierAccount.id,
      accountNumberFingerprint: carrierAccount.accountNumberFingerprint,
      credentialRevision: credential.revision,
      credentialFingerprint: credential.fingerprint,
      adapterVersion: requiredText(row.adapter_version, 'Adapter version', 128),
      completedAt: requiredInstant(
        new Date(row.completed_at).toISOString(),
        'Completed at',
      ),
      expiresAt: requiredInstant(
        new Date(row.selection_expires_at).toISOString(),
        'Selection expiration',
      ),
      amountMinor: nonNegativeInteger(row.amount_minor, 'Selected amount'),
      currency: currency(row.currency),
      service: {
        code: requiredText(row.service_code, 'Service code', 80),
        name: requiredText(row.service_name, 'Service name', 160),
      },
      dispatchBinding,
    }
    return deepFreeze({
      environment: 'production',
      organization,
      order,
      plan,
      warehouse,
      provider: row.provider,
      integrationAccount,
      carrierAccount,
      credential,
      billing,
      origin,
      destination,
      selectedRateEvidence,
      packages,
      adapterVersion: selectedRateEvidence.adapterVersion,
    })
  })
}
