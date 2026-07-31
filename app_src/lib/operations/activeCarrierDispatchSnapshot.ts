import { createHash } from 'node:crypto'

export type ActiveCarrierDispatchProvider = 'ups_rest' | 'fedex_rest'
export type ActiveCarrierBillingRelationship =
  | 'sender'
  | 'recipient'
  | 'third_party'

export class ActiveCarrierDispatchSnapshotError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ActiveCarrierDispatchSnapshotError'
    this.code = code
  }
}

export interface ActiveCarrierDispatchEntityReference {
  readonly id: string
  readonly globalId: string
}

export interface ActiveCarrierDispatchAttemptReference
  extends ActiveCarrierDispatchEntityReference {
  readonly attemptNumber: number
}

export interface ActiveCarrierDispatchCarrierAccountReference
  extends ActiveCarrierDispatchEntityReference {
  readonly configurationRevision: number
  readonly accountNumberFingerprint: string
  readonly registeredOriginFingerprint: string
  readonly allowedBillingRelationships:
    readonly ActiveCarrierBillingRelationship[]
}

export interface ActiveCarrierDispatchCredentialReference {
  readonly revision: number
  readonly fingerprint: string
}

export interface ActiveCarrierDispatchBillingSnapshot {
  readonly relationship: ActiveCarrierBillingRelationship
  readonly payerAccountNumberFingerprint: string
  readonly payerCountryCode: string
  readonly payerPostalCode: string
}

export interface ActiveCarrierDispatchAddressSnapshot {
  readonly contactName: string
  readonly companyName: string | null
  readonly phone: string | null
  readonly email: string | null
  readonly line1: string
  readonly line2: string | null
  readonly line3: string | null
  readonly city: string
  readonly region: string | null
  readonly postalCode: string
  readonly countryCode: string
  readonly residential: boolean
}

export interface ActiveCarrierDispatchServiceSnapshot {
  readonly code: string
  readonly name: string
}

export interface ActiveCarrierDispatchRerateDispatchBinding {
  readonly organization: ActiveCarrierDispatchEntityReference
  readonly order: ActiveCarrierDispatchEntityReference
  readonly plan: ActiveCarrierDispatchEntityReference
  readonly warehouse: ActiveCarrierDispatchEntityReference
  readonly originFingerprint: string
  readonly destinationFingerprint: string
  readonly billingFingerprint: string
  readonly orderedPackageSetFingerprint: string
  readonly packageCount: number
}

export interface ActiveCarrierDispatchRerateDispatchBindingInput {
  readonly organization: ActiveCarrierDispatchEntityReference
  readonly order: ActiveCarrierDispatchEntityReference
  readonly plan: ActiveCarrierDispatchEntityReference
  readonly warehouse: ActiveCarrierDispatchEntityReference
  readonly origin: ActiveCarrierDispatchAddressSnapshot
  readonly destination: ActiveCarrierDispatchAddressSnapshot
  readonly billing: ActiveCarrierDispatchBillingSnapshot
  readonly packages: readonly ActiveCarrierDispatchPackageSnapshot[]
}

export interface ActiveCarrierDispatchSelectedRateEvidence
  extends ActiveCarrierDispatchEntityReference {
  readonly rerateRun: ActiveCarrierDispatchEntityReference
  readonly rerateInputHash: string
  readonly rerateResultHash: string
  readonly reratePurpose: 'fulfillment_execution'
  readonly ratePurpose: 'cartonization_shipment_rate'
  readonly status: 'succeeded'
  readonly environment: 'production'
  readonly provider: ActiveCarrierDispatchProvider
  readonly providerReference: string
  readonly requestHash: string
  readonly integrationAccountId: string
  readonly carrierAccountId: string
  readonly accountNumberFingerprint: string
  readonly credentialRevision: number
  readonly credentialFingerprint: string
  readonly adapterVersion: string
  readonly completedAt: string
  readonly expiresAt: string
  readonly amountMinor: number
  readonly currency: string
  readonly service: ActiveCarrierDispatchServiceSnapshot
  readonly dispatchBinding: ActiveCarrierDispatchRerateDispatchBinding
}

export interface ActiveCarrierDispatchDimensionsMm {
  readonly length: number
  readonly width: number
  readonly height: number
}

export interface ActiveCarrierDispatchPackageSnapshot {
  readonly packageId: string
  readonly packageGlobalId: string
  readonly packageNumber: number
  readonly dimensionsMm: ActiveCarrierDispatchDimensionsMm
  readonly weightGrams: number
}

export interface ActiveCarrierDispatchSnapshotInput {
  readonly snapshotAt: string
  readonly environment: 'production'
  readonly organization: ActiveCarrierDispatchEntityReference
  readonly order: ActiveCarrierDispatchEntityReference
  readonly plan: ActiveCarrierDispatchEntityReference
  readonly warehouse: ActiveCarrierDispatchEntityReference
  readonly carrierAttempt: ActiveCarrierDispatchAttemptReference
  readonly provider: ActiveCarrierDispatchProvider
  readonly integrationAccount: ActiveCarrierDispatchEntityReference
  readonly carrierAccount: ActiveCarrierDispatchCarrierAccountReference
  readonly credential: ActiveCarrierDispatchCredentialReference
  readonly billing: ActiveCarrierDispatchBillingSnapshot
  readonly origin: ActiveCarrierDispatchAddressSnapshot
  readonly destination: ActiveCarrierDispatchAddressSnapshot
  readonly selectedRateEvidence: ActiveCarrierDispatchSelectedRateEvidence
  readonly packages: readonly ActiveCarrierDispatchPackageSnapshot[]
  readonly adapterVersion: string
}

export interface ActiveCarrierDispatchSnapshotEvidence {
  readonly schemaVersion: 1
  readonly operation: 'create_multi_package_shipment'
  readonly snapshotAt: string
  readonly environment: 'production'
  readonly organization: ActiveCarrierDispatchEntityReference
  readonly order: ActiveCarrierDispatchEntityReference
  readonly plan: ActiveCarrierDispatchEntityReference
  readonly warehouse: ActiveCarrierDispatchEntityReference
  readonly carrierAttempt: ActiveCarrierDispatchAttemptReference
  readonly provider: ActiveCarrierDispatchProvider
  readonly integrationAccount: ActiveCarrierDispatchEntityReference
  readonly carrierAccount: ActiveCarrierDispatchCarrierAccountReference
  readonly credential: ActiveCarrierDispatchCredentialReference
  readonly billing: ActiveCarrierDispatchBillingSnapshot
  readonly origin: ActiveCarrierDispatchAddressSnapshot
  readonly destination: ActiveCarrierDispatchAddressSnapshot
  readonly selectedRateEvidence: ActiveCarrierDispatchSelectedRateEvidence
  readonly service: ActiveCarrierDispatchServiceSnapshot
  readonly selectedAmountMinor: number
  readonly currency: string
  readonly packages: readonly ActiveCarrierDispatchPackageSnapshot[]
  readonly packageCount: number
  readonly adapterVersion: string
  readonly dispatchRequestFingerprint: string
  readonly providerIdempotencyIdentity: string
  readonly snapshotHashAlgorithm: 'sha256'
}

export interface ActiveCarrierDispatchSnapshot
  extends ActiveCarrierDispatchSnapshotEvidence {
  readonly snapshotHash: string
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u
const BILLING_RELATIONSHIP_ORDER: readonly ActiveCarrierBillingRelationship[] = [
  'sender',
  'recipient',
  'third_party',
]

function fail(code: string, message: string): never {
  throw new ActiveCarrierDispatchSnapshotError(code, message)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
      `${field} must be an object`,
    )
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: object,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys)
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
  if (unexpected.length > 0) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
      `${field} contains unsupported fields`,
    )
  }
}

function text(value: unknown, field: string, maximum = 200): string {
  if (typeof value !== 'string') {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
      `${field} must be text`,
    )
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
      `${field} is invalid`,
    )
  }
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (normalized.length < 1 || normalized.length > maximum) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
      `${field} is invalid`,
    )
  }
  return normalized
}

function nullableText(
  value: unknown,
  field: string,
  maximum: number,
): string | null {
  if (value === null || value === undefined || value === '') return null
  return text(value, field, maximum)
}

function uuid(value: unknown, field: string): string {
  const normalized = text(value, field, 36).toLowerCase()
  if (!UUID_PATTERN.test(normalized)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_IDENTITY_INVALID',
      `${field} must be a UUID`,
    )
  }
  return normalized
}

function globalId(value: unknown, field: string, pattern: RegExp): string {
  const normalized = text(value, field, 32).toLowerCase()
  if (!pattern.test(normalized)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_IDENTITY_INVALID',
      `${field} is invalid`,
    )
  }
  return normalized
}

function fingerprint(value: unknown, field: string): string {
  const normalized = text(value, field, 64).toLowerCase()
  if (!SHA256_PATTERN.test(normalized)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_CREDENTIAL_INVALID',
      `${field} must be a SHA-256 fingerprint`,
    )
  }
  return normalized
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
      `${field} must be a positive safe integer`,
    )
  }
  return Number(value)
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
      `${field} must be a non-negative safe integer`,
    )
  }
  return Number(value)
}

function countryCode(value: unknown, field: string): string {
  const normalized = text(value, field, 2).toUpperCase()
  if (!/^[A-Z]{2}$/u.test(normalized)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
      `${field} must be a two-letter country code`,
    )
  }
  return normalized
}

function currencyCode(value: unknown, field: string): string {
  const normalized = text(value, field, 3).toUpperCase()
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
      `${field} must be a three-letter currency code`,
    )
  }
  return normalized
}

function instant(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length > 40
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
      `${field} must be an ISO 8601 instant`,
    )
  }
  const normalized = value
  const match = ISO_INSTANT_PATTERN.exec(normalized)
  const parsed = Date.parse(normalized)
  if (!match || !Number.isFinite(parsed)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
      `${field} must be an ISO 8601 instant`,
    )
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const calendarDate = new Date(Date.UTC(year, month - 1, day))
  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
      `${field} must be an ISO 8601 instant`,
    )
  }
  return new Date(parsed).toISOString()
}

function entityReference(
  value: unknown,
  field: string,
  expectedGlobalId: RegExp,
): ActiveCarrierDispatchEntityReference {
  const source = record(value, field)
  assertExactKeys(source, ['id', 'globalId'], field)
  return {
    id: uuid(source.id, `${field}.id`),
    globalId: globalId(source.globalId, `${field}.globalId`, expectedGlobalId),
  }
}

function attemptReference(
  value: unknown,
): ActiveCarrierDispatchAttemptReference {
  const source = record(value, 'carrierAttempt')
  assertExactKeys(source, ['id', 'globalId', 'attemptNumber'], 'carrierAttempt')
  const identity = entityReference(
    { id: source.id, globalId: source.globalId },
    'carrierAttempt',
    /^gaca[0-9]{7}$/u,
  )
  return {
    ...identity,
    attemptNumber: positiveInteger(
      source.attemptNumber,
      'carrierAttempt.attemptNumber',
    ),
  }
}

function addressSnapshot(
  value: unknown,
  field: string,
): ActiveCarrierDispatchAddressSnapshot {
  const source = record(value, field)
  assertExactKeys(source, [
    'contactName',
    'companyName',
    'phone',
    'email',
    'line1',
    'line2',
    'line3',
    'city',
    'region',
    'postalCode',
    'countryCode',
    'residential',
  ], field)
  if (typeof source.residential !== 'boolean') {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
      `${field}.residential must be boolean`,
    )
  }
  const email = nullableText(source.email, `${field}.email`, 254)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
      `${field}.email is invalid`,
    )
  }
  return {
    contactName: text(source.contactName, `${field}.contactName`, 100),
    companyName: nullableText(source.companyName, `${field}.companyName`, 120),
    phone: nullableText(source.phone, `${field}.phone`, 40),
    email,
    line1: text(source.line1, `${field}.line1`, 160),
    line2: nullableText(source.line2, `${field}.line2`, 120),
    line3: nullableText(source.line3, `${field}.line3`, 120),
    city: text(source.city, `${field}.city`, 100),
    region: nullableText(source.region, `${field}.region`, 100),
    postalCode: text(source.postalCode, `${field}.postalCode`, 32),
    countryCode: countryCode(source.countryCode, `${field}.countryCode`),
    residential: source.residential,
  }
}

function serviceSnapshot(
  value: unknown,
  field: string,
): ActiveCarrierDispatchServiceSnapshot {
  const source = record(value, field)
  assertExactKeys(source, ['code', 'name'], field)
  return {
    code: text(source.code, `${field}.code`, 80),
    name: text(source.name, `${field}.name`, 160),
  }
}

function allowedBillingRelationships(
  value: unknown,
): readonly ActiveCarrierBillingRelationship[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_BILLING_INVALID',
      'carrierAccount.allowedBillingRelationships must contain 1-3 relationships',
    )
  }
  const relationships = value.map((entry) => {
    if (!BILLING_RELATIONSHIP_ORDER.includes(
      entry as ActiveCarrierBillingRelationship,
    )) {
      fail(
        'OPERATIONS_ACTIVE_DISPATCH_BILLING_INVALID',
        'carrierAccount.allowedBillingRelationships contains an invalid relationship',
      )
    }
    return entry as ActiveCarrierBillingRelationship
  })
  if (new Set(relationships).size !== relationships.length) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_BILLING_INVALID',
      'carrierAccount.allowedBillingRelationships must be unique',
    )
  }
  return BILLING_RELATIONSHIP_ORDER.filter((entry) =>
    relationships.includes(entry))
}

function billingSnapshot(value: unknown): ActiveCarrierDispatchBillingSnapshot {
  const source = record(value, 'billing')
  assertExactKeys(source, [
    'relationship',
    'payerAccountNumberFingerprint',
    'payerCountryCode',
    'payerPostalCode',
  ], 'billing')
  if (!BILLING_RELATIONSHIP_ORDER.includes(
    source.relationship as ActiveCarrierBillingRelationship,
  )) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_BILLING_INVALID',
      'Carrier billing relationship is invalid',
    )
  }
  return {
    relationship: source.relationship as ActiveCarrierBillingRelationship,
    payerAccountNumberFingerprint: fingerprint(
      source.payerAccountNumberFingerprint,
      'billing.payerAccountNumberFingerprint',
    ),
    payerCountryCode: countryCode(
      source.payerCountryCode,
      'billing.payerCountryCode',
    ),
    payerPostalCode: text(
      source.payerPostalCode,
      'billing.payerPostalCode',
      32,
    ),
  }
}

function normalizedPostalCode(value: string) {
  return value.toUpperCase().replace(/[\s-]/gu, '')
}

function registeredOriginFingerprint(
  origin: ActiveCarrierDispatchAddressSnapshot,
): string {
  if (!origin.region) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_CARRIER_ACCOUNT_INVALID',
      'Active dispatch origin must include the registered carrier-account region',
    )
  }
  return createHash('sha256')
    .update(JSON.stringify({
      line1: origin.line1.toLowerCase(),
      line2: origin.line2?.toLowerCase() || null,
      city: origin.city.toLowerCase(),
      region: origin.region.toLowerCase(),
      postalCode: origin.postalCode.toLowerCase().replace(/[\s-]/gu, ''),
      countryCode: origin.countryCode,
    }), 'utf8')
    .digest('hex')
}

function packageSnapshot(
  value: unknown,
  index: number,
): ActiveCarrierDispatchPackageSnapshot {
  const field = `packages[${index}]`
  const source = record(value, field)
  assertExactKeys(source, [
    'packageId',
    'packageGlobalId',
    'packageNumber',
    'dimensionsMm',
    'weightGrams',
  ], field)
  const dimensions = record(source.dimensionsMm, `${field}.dimensionsMm`)
  assertExactKeys(
    dimensions,
    ['length', 'width', 'height'],
    `${field}.dimensionsMm`,
  )
  return {
    packageId: uuid(source.packageId, `${field}.packageId`),
    packageGlobalId: globalId(
      source.packageGlobalId,
      `${field}.packageGlobalId`,
      /^gpa[0-9]{7}$/u,
    ),
    packageNumber: positiveInteger(
      source.packageNumber,
      `${field}.packageNumber`,
    ),
    dimensionsMm: {
      length: positiveInteger(dimensions.length, `${field}.dimensionsMm.length`),
      width: positiveInteger(dimensions.width, `${field}.dimensionsMm.width`),
      height: positiveInteger(dimensions.height, `${field}.dimensionsMm.height`),
    },
    weightGrams: positiveInteger(source.weightGrams, `${field}.weightGrams`),
  }
}

function orderedPackageSet(value: unknown): readonly ActiveCarrierDispatchPackageSnapshot[] {
  if (!Array.isArray(value)) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_PACKAGE_COUNT_INVALID',
      'Active carrier dispatch packages must be an array',
    )
  }
  if (value.length < 1 || value.length > 50) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_PACKAGE_COUNT_INVALID',
      'Active carrier dispatch requires between 1 and 50 packages',
    )
  }
  const packages = value.map(packageSnapshot)
  const packageIds = new Set<string>()
  const packageGlobalIds = new Set<string>()
  const packageNumbers = new Set<number>()
  let previousPackageNumber = 0
  for (const packageRow of packages) {
    if (
      packageIds.has(packageRow.packageId)
      || packageGlobalIds.has(packageRow.packageGlobalId)
      || packageNumbers.has(packageRow.packageNumber)
    ) {
      fail(
        'OPERATIONS_ACTIVE_DISPATCH_PACKAGE_IDENTITY_INVALID',
        'Active dispatch package IDs, Global IDs, and numbers must be unique',
      )
    }
    if (packageRow.packageNumber <= previousPackageNumber) {
      fail(
        'OPERATIONS_ACTIVE_DISPATCH_PACKAGE_ORDER_INVALID',
        'Active dispatch packages must be ordered by ascending package number',
      )
    }
    packageIds.add(packageRow.packageId)
    packageGlobalIds.add(packageRow.packageGlobalId)
    packageNumbers.add(packageRow.packageNumber)
    previousPackageNumber = packageRow.packageNumber
  }
  return packages
}

function rerateDispatchBinding(
  value: unknown,
): ActiveCarrierDispatchRerateDispatchBinding {
  const field = 'selectedRateEvidence.dispatchBinding'
  const source = record(value, field)
  assertExactKeys(source, [
    'organization',
    'order',
    'plan',
    'warehouse',
    'originFingerprint',
    'destinationFingerprint',
    'billingFingerprint',
    'orderedPackageSetFingerprint',
    'packageCount',
  ], field)
  return {
    organization: entityReference(
      source.organization,
      `${field}.organization`,
      /^ga[0-9]{7}$/u,
    ),
    order: entityReference(
      source.order,
      `${field}.order`,
      /^gor[0-9]{7}$/u,
    ),
    plan: entityReference(
      source.plan,
      `${field}.plan`,
      /^gfp[0-9]{7}$/u,
    ),
    warehouse: entityReference(
      source.warehouse,
      `${field}.warehouse`,
      /^gwh[0-9]{7}$/u,
    ),
    originFingerprint: fingerprint(
      source.originFingerprint,
      `${field}.originFingerprint`,
    ),
    destinationFingerprint: fingerprint(
      source.destinationFingerprint,
      `${field}.destinationFingerprint`,
    ),
    billingFingerprint: fingerprint(
      source.billingFingerprint,
      `${field}.billingFingerprint`,
    ),
    orderedPackageSetFingerprint: fingerprint(
      source.orderedPackageSetFingerprint,
      `${field}.orderedPackageSetFingerprint`,
    ),
    packageCount: positiveInteger(
      source.packageCount,
      `${field}.packageCount`,
    ),
  }
}

function selectedRateEvidence(
  value: unknown,
): ActiveCarrierDispatchSelectedRateEvidence {
  const source = record(value, 'selectedRateEvidence')
  assertExactKeys(source, [
    'id',
    'globalId',
    'rerateRun',
    'rerateInputHash',
    'rerateResultHash',
    'reratePurpose',
    'ratePurpose',
    'status',
    'environment',
    'provider',
    'providerReference',
    'requestHash',
    'integrationAccountId',
    'carrierAccountId',
    'accountNumberFingerprint',
    'credentialRevision',
    'credentialFingerprint',
    'adapterVersion',
    'completedAt',
    'expiresAt',
    'amountMinor',
    'currency',
    'service',
    'dispatchBinding',
  ], 'selectedRateEvidence')
  if (
    source.reratePurpose !== 'fulfillment_execution'
    || source.ratePurpose !== 'cartonization_shipment_rate'
    || source.status !== 'succeeded'
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
      'Selected rate evidence must be one successful fulfillment rerate',
    )
  }
  if (source.environment !== 'production') {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_PRODUCTION_REQUIRED',
      'Selected rate evidence must use the production environment',
    )
  }
  if (source.provider !== 'ups_rest' && source.provider !== 'fedex_rest') {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
      'Selected rate evidence provider must be UPS or FedEx REST',
    )
  }
  const identity = entityReference(
    { id: source.id, globalId: source.globalId },
    'selectedRateEvidence',
    /^grq[0-9]{7}$/u,
  )
  return {
    ...identity,
    rerateRun: entityReference(
      source.rerateRun,
      'selectedRateEvidence.rerateRun',
      /^gprr[0-9]{7}$/u,
    ),
    rerateInputHash: fingerprint(
      source.rerateInputHash,
      'selectedRateEvidence.rerateInputHash',
    ),
    rerateResultHash: fingerprint(
      source.rerateResultHash,
      'selectedRateEvidence.rerateResultHash',
    ),
    reratePurpose: 'fulfillment_execution',
    ratePurpose: 'cartonization_shipment_rate',
    status: 'succeeded',
    environment: 'production',
    provider: source.provider,
    providerReference: text(
      source.providerReference,
      'selectedRateEvidence.providerReference',
      200,
    ),
    requestHash: fingerprint(
      source.requestHash,
      'selectedRateEvidence.requestHash',
    ),
    integrationAccountId: uuid(
      source.integrationAccountId,
      'selectedRateEvidence.integrationAccountId',
    ),
    carrierAccountId: uuid(
      source.carrierAccountId,
      'selectedRateEvidence.carrierAccountId',
    ),
    accountNumberFingerprint: fingerprint(
      source.accountNumberFingerprint,
      'selectedRateEvidence.accountNumberFingerprint',
    ),
    credentialRevision: positiveInteger(
      source.credentialRevision,
      'selectedRateEvidence.credentialRevision',
    ),
    credentialFingerprint: fingerprint(
      source.credentialFingerprint,
      'selectedRateEvidence.credentialFingerprint',
    ),
    adapterVersion: text(
      source.adapterVersion,
      'selectedRateEvidence.adapterVersion',
      128,
    ),
    completedAt: instant(
      source.completedAt,
      'selectedRateEvidence.completedAt',
    ),
    expiresAt: instant(source.expiresAt, 'selectedRateEvidence.expiresAt'),
    amountMinor: nonNegativeInteger(
      source.amountMinor,
      'selectedRateEvidence.amountMinor',
    ),
    currency: currencyCode(source.currency, 'selectedRateEvidence.currency'),
    service: serviceSnapshot(
      source.service,
      'selectedRateEvidence.service',
    ),
    dispatchBinding: rerateDispatchBinding(source.dispatchBinding),
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

function canonicalFingerprint(kind: string, value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ kind, value })), 'utf8')
    .digest('hex')
}

function dispatchBindingFromValidated(
  input: ActiveCarrierDispatchRerateDispatchBindingInput,
): ActiveCarrierDispatchRerateDispatchBinding {
  return {
    organization: input.organization,
    order: input.order,
    plan: input.plan,
    warehouse: input.warehouse,
    originFingerprint: canonicalFingerprint(
      'active-carrier-dispatch-origin-v1',
      input.origin,
    ),
    destinationFingerprint: canonicalFingerprint(
      'active-carrier-dispatch-destination-v1',
      input.destination,
    ),
    billingFingerprint: canonicalFingerprint(
      'active-carrier-dispatch-billing-v1',
      input.billing,
    ),
    orderedPackageSetFingerprint: canonicalFingerprint(
      'active-carrier-dispatch-ordered-packages-v1',
      input.packages,
    ),
    packageCount: input.packages.length,
  }
}

export function createActiveCarrierDispatchRerateBinding(
  input: ActiveCarrierDispatchRerateDispatchBindingInput,
): ActiveCarrierDispatchRerateDispatchBinding {
  const source = record(input, 'rerateDispatchBinding')
  assertExactKeys(source, [
    'organization',
    'order',
    'plan',
    'warehouse',
    'origin',
    'destination',
    'billing',
    'packages',
  ], 'rerateDispatchBinding')
  return deepFreeze(dispatchBindingFromValidated({
    organization: entityReference(
      source.organization,
      'rerateDispatchBinding.organization',
      /^ga[0-9]{7}$/u,
    ),
    order: entityReference(
      source.order,
      'rerateDispatchBinding.order',
      /^gor[0-9]{7}$/u,
    ),
    plan: entityReference(
      source.plan,
      'rerateDispatchBinding.plan',
      /^gfp[0-9]{7}$/u,
    ),
    warehouse: entityReference(
      source.warehouse,
      'rerateDispatchBinding.warehouse',
      /^gwh[0-9]{7}$/u,
    ),
    origin: addressSnapshot(source.origin, 'origin'),
    destination: addressSnapshot(source.destination, 'destination'),
    billing: billingSnapshot(source.billing),
    packages: orderedPackageSet(source.packages),
  }))
}

function sameEntityReference(
  left: ActiveCarrierDispatchEntityReference,
  right: ActiveCarrierDispatchEntityReference,
) {
  return left.id === right.id && left.globalId === right.globalId
}

function hashValidatedEvidence(
  evidence: ActiveCarrierDispatchSnapshotEvidence,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(evidence)), 'utf8')
    .digest('hex')
}

function providerIdempotencyIdentity(input: {
  readonly organization: ActiveCarrierDispatchEntityReference
  readonly carrierAttempt: ActiveCarrierDispatchAttemptReference
  readonly provider: ActiveCarrierDispatchProvider
  readonly dispatchRequestFingerprint: string
}): string {
  // Persistence must bind one carrier-attempt identity to exactly one validated
  // dispatch-request fingerprint. A retry may reuse this identity only when its
  // stored fingerprint matches; a changed request requires a new attempt.
  const immutableAttemptDigest = createHash('sha256')
    .update(JSON.stringify(canonicalize({
      operation: 'create_multi_package_shipment',
      organization: input.organization,
      carrierAttempt: input.carrierAttempt,
      provider: input.provider,
      dispatchRequestFingerprint: input.dispatchRequestFingerprint,
    })), 'utf8')
    .digest('hex')
  return `clawpilot:${input.provider}:${input.carrierAttempt.globalId}:${immutableAttemptDigest.slice(0, 32)}`
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

export function createActiveCarrierDispatchSnapshot(
  input: ActiveCarrierDispatchSnapshotInput,
): ActiveCarrierDispatchSnapshot {
  const source = record(input, 'dispatchSnapshot')
  assertExactKeys(source, [
    'snapshotAt',
    'environment',
    'organization',
    'order',
    'plan',
    'warehouse',
    'carrierAttempt',
    'provider',
    'integrationAccount',
    'carrierAccount',
    'credential',
    'billing',
    'origin',
    'destination',
    'selectedRateEvidence',
    'packages',
    'adapterVersion',
  ], 'dispatchSnapshot')
  if (source.environment !== 'production') {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_PRODUCTION_REQUIRED',
      'Active carrier dispatch requires the production environment',
    )
  }
  if (source.provider !== 'ups_rest' && source.provider !== 'fedex_rest') {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
      'Active carrier dispatch provider must be UPS or FedEx REST',
    )
  }

  const snapshotAt = instant(source.snapshotAt, 'snapshotAt')
  const organization = entityReference(
    source.organization,
    'organization',
    /^ga[0-9]{7}$/u,
  )
  const order = entityReference(source.order, 'order', /^gor[0-9]{7}$/u)
  const plan = entityReference(source.plan, 'plan', /^gfp[0-9]{7}$/u)
  const warehouse = entityReference(
    source.warehouse,
    'warehouse',
    /^gwh[0-9]{7}$/u,
  )
  const carrierAttempt = attemptReference(source.carrierAttempt)
  const integrationAccount = entityReference(
    source.integrationAccount,
    'integrationAccount',
    /^gia[0-9]{7}$/u,
  )

  const carrierSource = record(source.carrierAccount, 'carrierAccount')
  assertExactKeys(carrierSource, [
    'id',
    'globalId',
    'configurationRevision',
    'accountNumberFingerprint',
    'registeredOriginFingerprint',
    'allowedBillingRelationships',
  ], 'carrierAccount')
  const carrierReference = entityReference(
    { id: carrierSource.id, globalId: carrierSource.globalId },
    'carrierAccount',
    /^gac[0-9]{7}$/u,
  )
  const carrierAccount: ActiveCarrierDispatchCarrierAccountReference = {
    ...carrierReference,
    configurationRevision: positiveInteger(
      carrierSource.configurationRevision,
      'carrierAccount.configurationRevision',
    ),
    accountNumberFingerprint: fingerprint(
      carrierSource.accountNumberFingerprint,
      'carrierAccount.accountNumberFingerprint',
    ),
    registeredOriginFingerprint: fingerprint(
      carrierSource.registeredOriginFingerprint,
      'carrierAccount.registeredOriginFingerprint',
    ),
    allowedBillingRelationships: allowedBillingRelationships(
      carrierSource.allowedBillingRelationships,
    ),
  }

  const credentialSource = record(source.credential, 'credential')
  assertExactKeys(credentialSource, ['revision', 'fingerprint'], 'credential')
  const credential: ActiveCarrierDispatchCredentialReference = {
    revision: positiveInteger(credentialSource.revision, 'credential.revision'),
    fingerprint: fingerprint(
      credentialSource.fingerprint,
      'credential.fingerprint',
    ),
  }

  const billing = billingSnapshot(source.billing)
  if (!carrierAccount.allowedBillingRelationships.includes(
    billing.relationship,
  )) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_BILLING_INVALID',
      'Selected billing relationship is not allowed by this carrier-account revision',
    )
  }
  if (
    billing.relationship === 'sender'
    && billing.payerAccountNumberFingerprint
      !== carrierAccount.accountNumberFingerprint
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_BILLING_INVALID',
      'Sender billing must use the selected production carrier account',
    )
  }

  const origin = addressSnapshot(source.origin, 'origin')
  if (
    registeredOriginFingerprint(origin)
    !== carrierAccount.registeredOriginFingerprint
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_CARRIER_ACCOUNT_INVALID',
      'Active dispatch origin does not match the selected carrier-account registered origin',
    )
  }
  const destination = addressSnapshot(source.destination, 'destination')
  const billingAddress = billing.relationship === 'sender' ? origin : destination
  if (
    billing.relationship !== 'third_party'
    && (
      billing.payerCountryCode !== billingAddress.countryCode
      || normalizedPostalCode(billing.payerPostalCode)
        !== normalizedPostalCode(billingAddress.postalCode)
    )
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_BILLING_INVALID',
      `${billing.relationship === 'sender' ? 'Sender' : 'Recipient'} billing country and postal code must match its dispatch address`,
    )
  }
  const packages = orderedPackageSet(source.packages)
  const dispatchBinding = dispatchBindingFromValidated({
    organization,
    order,
    plan,
    warehouse,
    origin,
    destination,
    billing,
    packages,
  })

  const rateEvidence = selectedRateEvidence(source.selectedRateEvidence)
  if (
    rateEvidence.provider !== source.provider
    || rateEvidence.integrationAccountId !== integrationAccount.id
    || rateEvidence.carrierAccountId !== carrierAccount.id
    || rateEvidence.accountNumberFingerprint
      !== carrierAccount.accountNumberFingerprint
    || rateEvidence.credentialRevision !== credential.revision
    || rateEvidence.credentialFingerprint !== credential.fingerprint
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
      'Selected rate evidence does not match the exact provider, account, and credential revision',
    )
  }
  if (
    !sameEntityReference(rateEvidence.dispatchBinding.organization, organization)
    || !sameEntityReference(rateEvidence.dispatchBinding.order, order)
    || !sameEntityReference(rateEvidence.dispatchBinding.plan, plan)
    || !sameEntityReference(rateEvidence.dispatchBinding.warehouse, warehouse)
    || rateEvidence.dispatchBinding.originFingerprint
      !== dispatchBinding.originFingerprint
    || rateEvidence.dispatchBinding.destinationFingerprint
      !== dispatchBinding.destinationFingerprint
    || rateEvidence.dispatchBinding.billingFingerprint
      !== dispatchBinding.billingFingerprint
    || rateEvidence.dispatchBinding.orderedPackageSetFingerprint
      !== dispatchBinding.orderedPackageSetFingerprint
    || rateEvidence.dispatchBinding.packageCount !== dispatchBinding.packageCount
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_RATE_BINDING_MISMATCH',
      'Selected production rerate does not bind the exact dispatch order, plan, warehouse, addresses, billing, and ordered packages',
    )
  }
  const snapshotTime = Date.parse(snapshotAt)
  const completedTime = Date.parse(rateEvidence.completedAt)
  const expiryTime = Date.parse(rateEvidence.expiresAt)
  if (
    completedTime > snapshotTime
    || expiryTime <= completedTime
    || snapshotTime >= expiryTime
  ) {
    fail(
      'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_EXPIRED',
      'Selected production rerate must be completed and unexpired at snapshot time',
    )
  }
  const adapterVersion = text(source.adapterVersion, 'adapterVersion', 128)
  const dispatchRequestFingerprint = canonicalFingerprint(
    'active-carrier-dispatch-provider-request-v1',
    {
      environment: 'production',
      organization,
      order,
      plan,
      warehouse,
      provider: source.provider,
      integrationAccount,
      carrierAccount,
      credential,
      billing,
      origin,
      destination,
      service: rateEvidence.service,
      packages,
      adapterVersion,
    },
  )

  const evidence: ActiveCarrierDispatchSnapshotEvidence = {
    schemaVersion: 1,
    operation: 'create_multi_package_shipment',
    snapshotAt,
    environment: 'production',
    organization,
    order,
    plan,
    warehouse,
    carrierAttempt,
    provider: source.provider,
    integrationAccount,
    carrierAccount,
    credential,
    billing,
    origin,
    destination,
    selectedRateEvidence: rateEvidence,
    service: rateEvidence.service,
    selectedAmountMinor: rateEvidence.amountMinor,
    currency: rateEvidence.currency,
    packages,
    packageCount: packages.length,
    adapterVersion,
    dispatchRequestFingerprint,
    providerIdempotencyIdentity: providerIdempotencyIdentity({
      organization,
      carrierAttempt,
      provider: source.provider,
      dispatchRequestFingerprint,
    }),
    snapshotHashAlgorithm: 'sha256',
  }
  return deepFreeze({
    ...evidence,
    snapshotHash: hashValidatedEvidence(evidence),
  })
}
