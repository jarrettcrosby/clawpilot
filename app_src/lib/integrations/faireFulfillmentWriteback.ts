import {
  createFaireCommerceClient,
  FaireCommerceClientError,
  type FaireCommerceClient,
  type FaireCommerceClientOptions,
  type FaireMoneyInput,
  type FaireProviderWriteAuthorization,
  type FaireShipmentInput,
  type FaireVerifiedCredentialBinding,
} from '@/lib/integrations/faireCommerceClient'

const FAIRE_ORDER_ID = /^bo_[A-Za-z0-9_-]+$/
const FAIRE_SHIPMENT_ID = /^s_[A-Za-z0-9_-]+$/
const MAX_PACKAGES = 100

export type FaireFulfillmentWritebackMode = 'execute' | 'reconcile_unknown'

export type FaireFulfillmentWriteAttemptInput = {
  attemptId: unknown
  authorizationRevision: unknown
  state: 'authorized' | 'outcome_unknown'
}

export type FaireFulfillmentWriteAttemptResult = {
  attemptId: string
  authorizationRevision: number
  state: 'succeeded' | 'outcome_unknown'
}

export type FaireFulfillmentWritebackCredential = {
  accessToken: unknown
  applicationId?: unknown
  applicationSecret?: unknown
  binding: FaireVerifiedCredentialBinding
}

export type FaireFulfillmentPackageTracking = {
  packageReference: unknown
  carrier: unknown
  trackingCode: unknown
  makerCost?: FaireMoneyInput | null
}

export type FaireFulfillmentWritebackInput = {
  mode: FaireFulfillmentWritebackMode
  writeAttempt: FaireFulfillmentWriteAttemptInput
  credential: FaireFulfillmentWritebackCredential
  authorization: FaireProviderWriteAuthorization
  externalOrderId: unknown
  expectedShipDate?: unknown
  packages: readonly FaireFulfillmentPackageTracking[]
}

export type FaireFulfillmentReadOnlyReconciliationInput = Omit<
  FaireFulfillmentWritebackInput,
  'authorization' | 'mode'
> & {
  mode: 'reconcile_unknown'
}

export type FaireFulfillmentWritebackSuccess = {
  outcome: 'succeeded'
  writeAttempt: FaireFulfillmentWriteAttemptResult & { state: 'succeeded' }
  providerOrderId: string
  providerState: string
  providerShipmentReferences: string[]
  trackingCodes: string[]
  replayed: boolean
  reconciledUnknownOutcome: boolean
}

export type FaireFulfillmentWritebackUnknown = {
  outcome: 'unknown'
  writeAttempt: FaireFulfillmentWriteAttemptResult & {
    state: 'outcome_unknown'
  }
  providerOrderId: string
  providerState: string | null
  providerShipmentReferences: []
  trackingCodes: string[]
  replayed: false
  reconciledUnknownOutcome: true
  reason: 'shipment_write_outcome_unknown' | 'processing_write_outcome_unknown'
}

export type FaireFulfillmentWritebackResult =
  | FaireFulfillmentWritebackSuccess
  | FaireFulfillmentWritebackUnknown

export class FaireFulfillmentWritebackError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'FaireFulfillmentWritebackError'
  }
}

export type FaireFulfillmentWritebackDependencies = {
  createClient: (options: FaireCommerceClientOptions) => FaireCommerceClient
}

const DEFAULT_DEPENDENCIES: FaireFulfillmentWritebackDependencies = {
  createClient: createFaireCommerceClient,
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function clean(value: unknown, label: string, max = 255) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    !normalized
    || normalized.length > max
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_INPUT_INVALID',
      `${label} is invalid`,
    )
  }
  return normalized
}

function positiveRevision(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_AUTHORIZATION_INVALID',
      `${label} is invalid`,
    )
  }
  return Number(value)
}

function normalizedAuthority(input: FaireFulfillmentWritebackInput) {
  const credential = record(input?.credential)
  const binding = record(credential?.binding)
  const authorization = record(input?.authorization)
  if (
    !credential
    || !binding
    || binding.provider !== 'faire'
    || binding.environment !== 'production'
    || binding.connectionStatus !== 'active'
    || binding.verificationStatus !== 'verified'
    || !authorization
    || authorization.provider !== 'faire'
    || authorization.environment !== 'production'
    || authorization.scopeVerificationSource !== 'oauth_grant'
  ) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_AUTHORIZATION_INVALID',
      'A verified active Faire credential and write authorization are required',
    )
  }
  const accountGlobalId = clean(binding.accountGlobalId, 'Faire account global ID', 128)
  const externalAccountId = clean(binding.externalAccountId, 'Faire brand ID', 128)
  const credentialVersion = positiveRevision(
    binding.credentialVersion,
    'Faire credential version',
  )
  const capabilities = Array.isArray(authorization.capabilities)
    ? authorization.capabilities
    : []
  const verifiedWriteScopes = Array.isArray(authorization.verifiedWriteScopes)
    ? authorization.verifiedWriteScopes
    : []
  if (
    clean(authorization.accountGlobalId, 'Faire authorization account ID', 128)
      !== accountGlobalId
    || clean(authorization.externalAccountId, 'Faire authorization brand ID', 128)
      !== externalAccountId
    || positiveRevision(
      authorization.credentialVersion,
      'Faire authorization credential version',
    ) !== credentialVersion
    || !['order_processing', 'fulfillment_export', 'tracking_export'].every(
      (capability) => capabilities.includes(capability),
    )
    || !verifiedWriteScopes.includes('WRITE_ORDERS')
  ) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_AUTHORIZATION_STALE',
      'Faire fulfillment authorization is missing, stale, or mismatched',
    )
  }
  const authorizationRevision = positiveRevision(
    authorization.authorizationRevision,
    'Faire authorization revision',
  )
  return {
    credential: credential as FaireFulfillmentWritebackCredential,
    binding: binding as FaireVerifiedCredentialBinding,
    authorization: authorization as FaireProviderWriteAuthorization,
    authorizationRevision,
    externalAccountId,
  }
}

function normalizedReadAuthority(
  input: FaireFulfillmentReadOnlyReconciliationInput,
) {
  const credential = record(input?.credential)
  const binding = record(credential?.binding)
  if (
    !credential
    || !binding
    || binding.provider !== 'faire'
    || binding.environment !== 'production'
    || binding.connectionStatus !== 'active'
    || binding.verificationStatus !== 'verified'
  ) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_AUTHORIZATION_INVALID',
      'A verified active Faire credential is required for read-only reconciliation',
    )
  }
  return {
    credential: credential as FaireFulfillmentWritebackCredential,
    binding: binding as FaireVerifiedCredentialBinding,
    externalAccountId: clean(binding.externalAccountId, 'Faire brand ID', 128),
  }
}

function normalizeWriteAttempt(
  input: FaireFulfillmentWritebackInput,
  authorizationRevision: number,
) {
  const attempt = record(input?.writeAttempt)
  if (!attempt) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_ATTEMPT_INVALID',
      'A persisted Faire fulfillment write attempt is required',
    )
  }
  const attemptId = clean(attempt.attemptId, 'Faire write attempt ID', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(attemptId)) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_ATTEMPT_INVALID',
      'Faire write attempt ID is invalid',
    )
  }
  const attemptAuthorizationRevision = positiveRevision(
    attempt.authorizationRevision,
    'Faire write attempt authorization revision',
  )
  if (attemptAuthorizationRevision !== authorizationRevision) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_ATTEMPT_STALE',
      'Faire write attempt authorization is stale or mismatched',
    )
  }
  if (!['authorized', 'outcome_unknown'].includes(String(attempt.state || ''))) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_ATTEMPT_INVALID',
      'Faire write attempt state is invalid',
    )
  }
  if (input.mode === 'execute' && attempt.state !== 'authorized') {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_REEXECUTE_FORBIDDEN',
      'A Faire write with an unknown outcome may only be reconciled',
    )
  }
  if (input.mode === 'reconcile_unknown' && attempt.state !== 'outcome_unknown') {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_RECONCILIATION_STATE_REQUIRED',
      'Faire unknown-outcome reconciliation requires persisted unknown state',
    )
  }
  return {
    attemptId,
    authorizationRevision: attemptAuthorizationRevision,
  }
}

function normalizeReadOnlyWriteAttempt(
  input: FaireFulfillmentReadOnlyReconciliationInput,
) {
  const attempt = record(input?.writeAttempt)
  if (!attempt) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_ATTEMPT_INVALID',
      'A persisted Faire fulfillment write attempt is required',
    )
  }
  const attemptId = clean(attempt.attemptId, 'Faire write attempt ID', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(attemptId)) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_ATTEMPT_INVALID',
      'Faire write attempt ID is invalid',
    )
  }
  const authorizationRevision = positiveRevision(
    attempt.authorizationRevision,
    'Original Faire write attempt authorization revision',
  )
  if (attempt.state !== 'outcome_unknown') {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_RECONCILIATION_STATE_REQUIRED',
      'Faire unknown-outcome reconciliation requires persisted unknown state',
    )
  }
  return { attemptId, authorizationRevision }
}

function normalizePackages(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PACKAGES) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_PACKAGES_INVALID',
      `Faire fulfillment requires 1-${MAX_PACKAGES} packages`,
    )
  }
  const packageReferences = new Set<string>()
  const trackingCodes = new Set<string>()
  return value.map((candidate) => {
    const item = record(candidate)
    if (!item) {
      throw new FaireFulfillmentWritebackError(
        'FAIRE_FULFILLMENT_PACKAGES_INVALID',
        'Faire fulfillment package tracking is invalid',
      )
    }
    const packageReference = clean(item.packageReference, 'Package reference', 128)
    const carrier = clean(item.carrier, 'Carrier', 80)
    const trackingCode = clean(item.trackingCode, 'Tracking code', 255)
    if (packageReferences.has(packageReference) || trackingCodes.has(trackingCode)) {
      throw new FaireFulfillmentWritebackError(
        'FAIRE_FULFILLMENT_PACKAGES_DUPLICATE',
        'Package references and tracking codes must be unique',
      )
    }
    packageReferences.add(packageReference)
    trackingCodes.add(trackingCode)
    return {
      packageReference,
      carrier,
      trackingCode,
      ...(item.makerCost === undefined || item.makerCost === null
        ? {}
        : { makerCost: item.makerCost as FaireMoneyInput }),
    }
  })
}

function normalizeExpectedShipDate(value: unknown) {
  if (value === undefined || value === null) return value
  const candidate = typeof value === 'string' ? value.trim() : ''
  const parsed = candidate && candidate.length <= 80
    ? new Date(candidate)
    : new Date(Number.NaN)
  if (!Number.isFinite(parsed.getTime())) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_INPUT_INVALID',
      'Faire expected ship date is invalid',
    )
  }
  return parsed.toISOString()
}

function providerBrandId(profile: Record<string, unknown>) {
  const identifiers = [profile.brand_id, profile.brandId, profile.id]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => clean(value, 'Faire provider brand ID', 128))
  if (identifiers.length < 1 || identifiers.some((id) => id !== identifiers[0])) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_BRAND_CHANGED',
      'Faire returned conflicting or missing brand identity',
    )
  }
  return identifiers[0]
}

function exactOrder(value: unknown, expectedOrderId: string) {
  const order = record(value)
  const orderId = order ? clean(order.id, 'Faire provider order ID', 128) : ''
  if (!order || orderId !== expectedOrderId) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_ORDER_CHANGED',
      'Faire returned a different order identity',
    )
  }
  return order
}

function providerState(order: Record<string, unknown>) {
  return clean(order.state, 'Faire provider order state', 64).toUpperCase()
}

function shipmentEvidenceConflict(): never {
  throw new FaireFulfillmentWritebackError(
    'FAIRE_FULFILLMENT_PARTIAL_MATCH',
    'Faire already contains shipment evidence that does not exactly match the requested package tracking; manual reconciliation is required',
  )
}

function observedShipments(order: Record<string, unknown>) {
  if (order.shipments === undefined || order.shipments === null) return []
  if (!Array.isArray(order.shipments)) shipmentEvidenceConflict()

  const shipmentIds = new Set<string>()
  const trackingCodes = new Set<string>()
  const trackingIdentities = new Set<string>()
  return order.shipments.map((candidate) => {
    const shipment = record(candidate)
    if (!shipment) shipmentEvidenceConflict()
    const trackingCode = typeof shipment.tracking_code === 'string'
      ? shipment.tracking_code.trim()
      : ''
    const carrier = typeof shipment.carrier === 'string'
      ? shipment.carrier.trim()
      : ''
    const id = typeof shipment.id === 'string' ? shipment.id.trim() : ''
    const identity = `${carrier.toUpperCase()}\n${trackingCode}`
    if (
      !FAIRE_SHIPMENT_ID.test(id)
      || !trackingCode
      || trackingCode.length > 255
      || /[\u0000-\u001f\u007f]/.test(trackingCode)
      || !carrier
      || carrier.length > 80
      || /[\u0000-\u001f\u007f]/.test(carrier)
      || shipmentIds.has(id)
      || trackingCodes.has(trackingCode)
      || trackingIdentities.has(identity)
    ) {
      shipmentEvidenceConflict()
    }
    shipmentIds.add(id)
    trackingCodes.add(trackingCode)
    trackingIdentities.add(identity)
    return { trackingCode, carrier, id }
  })
}

function matchedShipments(
  order: Record<string, unknown>,
  packages: ReturnType<typeof normalizePackages>,
) {
  const observed = observedShipments(order)
  if (observed.length === 0) return null
  if (observed.length !== packages.length) shipmentEvidenceConflict()
  const matched = packages.map((item) => observed.find((shipment) => (
    shipment.trackingCode === item.trackingCode
    && shipment.carrier.toUpperCase() === item.carrier.toUpperCase()
  )))
  if (matched.some((shipment) => !shipment)) shipmentEvidenceConflict()
  return matched.map((shipment) => shipment!.id)
}

function successResult(
  order: Record<string, unknown>,
  orderId: string,
  writeAttempt: ReturnType<typeof normalizeWriteAttempt>,
  packages: ReturnType<typeof normalizePackages>,
  references: string[],
  replayed: boolean,
  reconciledUnknownOutcome: boolean,
): FaireFulfillmentWritebackSuccess {
  return {
    outcome: 'succeeded',
    writeAttempt: { ...writeAttempt, state: 'succeeded' },
    providerOrderId: orderId,
    providerState: providerState(order),
    providerShipmentReferences: references,
    trackingCodes: packages.map((item) => item.trackingCode),
    replayed,
    reconciledUnknownOutcome,
  }
}

function unknownResult(
  orderId: string,
  writeAttempt: ReturnType<typeof normalizeWriteAttempt>,
  packages: ReturnType<typeof normalizePackages>,
  reason: FaireFulfillmentWritebackUnknown['reason'],
  order?: Record<string, unknown> | null,
): FaireFulfillmentWritebackUnknown {
  return {
    outcome: 'unknown',
    writeAttempt: { ...writeAttempt, state: 'outcome_unknown' },
    providerOrderId: orderId,
    providerState: order ? providerState(order) : null,
    providerShipmentReferences: [],
    trackingCodes: packages.map((item) => item.trackingCode),
    replayed: false,
    reconciledUnknownOutcome: true,
    reason,
  }
}

function outcomeCanBeUnknown(error: unknown) {
  return error instanceof FaireCommerceClientError
    && (
      error.retryable
      || [
        'FAIRE_REQUEST_TIMEOUT',
        'FAIRE_RESPONSE_INVALID',
        'FAIRE_RESPONSE_TOO_LARGE',
        'FAIRE_UPSTREAM_UNAVAILABLE',
      ].includes(error.code)
    )
}

async function reconcileTracking(
  client: FaireCommerceClient,
  orderId: string,
  writeAttempt: ReturnType<typeof normalizeWriteAttempt>,
  packages: ReturnType<typeof normalizePackages>,
  reason: FaireFulfillmentWritebackUnknown['reason'],
  replayed = true,
  reconciledUnknownOutcome = true,
) {
  let order: Record<string, unknown>
  try {
    order = exactOrder(await client.getOrder(orderId), orderId)
  } catch {
    return unknownResult(orderId, writeAttempt, packages, reason)
  }
  const references = matchedShipments(order, packages)
  return references
    ? successResult(
      order,
      orderId,
      writeAttempt,
      packages,
      references,
      replayed,
      reconciledUnknownOutcome,
    )
    : unknownResult(orderId, writeAttempt, packages, reason, order)
}

/**
 * Reconciles an immutable unknown-outcome attempt with provider GETs only.
 * The client is intentionally constructed without write authorization, so a
 * credential rotation can restore observation without making the original
 * one-shot POST authority current again.
 */
export async function reconcileFaireFulfillmentWritebackReadOnly(
  input: FaireFulfillmentReadOnlyReconciliationInput,
  dependencies: FaireFulfillmentWritebackDependencies = DEFAULT_DEPENDENCIES,
): Promise<FaireFulfillmentWritebackResult> {
  if (input?.mode !== 'reconcile_unknown') {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_MODE_INVALID',
      'Faire read-only reconciliation mode must be explicit',
    )
  }
  const authority = normalizedReadAuthority(input)
  const writeAttempt = normalizeReadOnlyWriteAttempt(input)
  const orderId = clean(input.externalOrderId, 'Faire order ID', 128)
  if (!FAIRE_ORDER_ID.test(orderId)) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_ORDER_INVALID',
      'Faire order ID is invalid',
    )
  }
  const packages = normalizePackages(input.packages)
  const client = dependencies.createClient({
    accessToken: authority.credential.accessToken,
    applicationId: authority.credential.applicationId,
    applicationSecret: authority.credential.applicationSecret,
    credentialBinding: authority.binding,
  })
  const profile = await client.probeBrandProfile()
  if (providerBrandId(profile) !== authority.externalAccountId) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_BRAND_CHANGED',
      'Faire returned a different brand identity',
    )
  }
  return reconcileTracking(
    client,
    orderId,
    writeAttempt,
    packages,
    'shipment_write_outcome_unknown',
  )
}

/**
 * Writes one Faire shipment batch at most once per `execute` invocation.
 * Unknown outcomes are returned as terminal evidence, never as retryable
 * exceptions. A later worker must call `reconcile_unknown`, which is read-only,
 * until exact carrier/tracking identities are observed. The caller must durably
 * persist the returned `writeAttempt` state. A new provider write requires a
 * new operator authorization revision and a separately persisted attempt.
 */
export async function executeFaireFulfillmentWriteback(
  input: FaireFulfillmentWritebackInput,
  dependencies: FaireFulfillmentWritebackDependencies = DEFAULT_DEPENDENCIES,
): Promise<FaireFulfillmentWritebackResult> {
  if (!['execute', 'reconcile_unknown'].includes(String(input?.mode || ''))) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_MODE_INVALID',
      'Faire fulfillment mode must be explicit',
    )
  }
  const authority = normalizedAuthority(input)
  const writeAttempt = normalizeWriteAttempt(
    input,
    authority.authorizationRevision,
  )
  const orderId = clean(input.externalOrderId, 'Faire order ID', 128)
  if (!FAIRE_ORDER_ID.test(orderId)) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_ORDER_INVALID',
      'Faire order ID is invalid',
    )
  }
  const packages = normalizePackages(input.packages)
  const client = dependencies.createClient({
    accessToken: authority.credential.accessToken,
    applicationId: authority.credential.applicationId,
    applicationSecret: authority.credential.applicationSecret,
    credentialBinding: authority.binding,
    writeAuthorization: authority.authorization,
  })

  const profile = await client.probeBrandProfile()
  if (providerBrandId(profile) !== authority.externalAccountId) {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_BRAND_CHANGED',
      'Faire returned a different brand identity',
    )
  }

  const initialOrder = exactOrder(await client.getOrder(orderId), orderId)
  const existingReferences = matchedShipments(initialOrder, packages)
  if (existingReferences) {
    return successResult(
      initialOrder,
      orderId,
      writeAttempt,
      packages,
      existingReferences,
      true,
      input.mode === 'reconcile_unknown',
    )
  }
  if (input.mode === 'reconcile_unknown') {
    return unknownResult(
      orderId,
      writeAttempt,
      packages,
      'shipment_write_outcome_unknown',
      initialOrder,
    )
  }

  let order = initialOrder
  let state = providerState(order)
  if (state === 'NEW') {
    try {
      const expectedShipDate = normalizeExpectedShipDate(input.expectedShipDate)
      await client.moveOrderToProcessing(
        orderId,
        expectedShipDate === undefined ? undefined : { expectedShipDate },
      )
    } catch (error) {
      if (!outcomeCanBeUnknown(error)) throw error
      try {
        order = exactOrder(await client.getOrder(orderId), orderId)
      } catch {
        return unknownResult(
          orderId,
          writeAttempt,
          packages,
          'processing_write_outcome_unknown',
        )
      }
      const references = matchedShipments(order, packages)
      if (references) {
        return successResult(
          order,
          orderId,
          writeAttempt,
          packages,
          references,
          true,
          true,
        )
      }
      state = providerState(order)
      if (state !== 'PROCESSING') {
        return unknownResult(
          orderId,
          writeAttempt,
          packages,
          'processing_write_outcome_unknown',
          order,
        )
      }
    }
    if (state === 'NEW') {
      order = exactOrder(await client.getOrder(orderId), orderId)
      state = providerState(order)
    }
  }
  if (state !== 'PROCESSING') {
    throw new FaireFulfillmentWritebackError(
      'FAIRE_FULFILLMENT_ORDER_NOT_WRITABLE',
      `Faire order in ${state} cannot receive a new shipment batch`,
    )
  }

  const shipments: FaireShipmentInput[] = packages.map((item) => ({
    carrier: item.carrier,
    trackingCode: item.trackingCode,
    shippingType: 'SHIP_ON_YOUR_OWN',
    ...(item.makerCost ? { makerCost: item.makerCost } : {}),
  }))
  try {
    await client.addOrderShipments(orderId, shipments)
  } catch (error) {
    if (!outcomeCanBeUnknown(error)) throw error
    return reconcileTracking(
      client,
      orderId,
      writeAttempt,
      packages,
      'shipment_write_outcome_unknown',
    )
  }
  return reconcileTracking(
    client,
    orderId,
    writeAttempt,
    packages,
    'shipment_write_outcome_unknown',
    false,
    false,
  )
}
