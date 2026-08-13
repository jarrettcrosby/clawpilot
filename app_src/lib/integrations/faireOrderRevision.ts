import {
  commerceOrderRevisionProtectedContentFingerprint,
  decryptCommerceCredential,
  encryptCommerceOrderRevisionProtectedSnapshot,
  normalizeCommerceAccountGlobalId,
  normalizeCommerceOrganizationId,
} from '@/lib/integrations/commerceCredentialCrypto'
import type { EncryptedCommerceOrderRevisionValue } from '@/lib/integrations/commerceCredentialCrypto'
import {
  getFaireOrder,
  probeFaireBrandProfile,
  type FaireCommerceClientOptions,
} from '@/lib/integrations/faireCommerceClient'
import {
  normalizeFaireCommerce,
} from '@/lib/integrations/faireCommerceNormalizer'
import {
  commerceReadCredentialEligible,
} from '@/lib/integrations/commerceReadRuntime'
import {
  commerceOrderRevisionProtectedPlaintext,
  commerceOrderRevisionHash,
} from '@/lib/integrations/commerceOrderRevisionEvidence'
import type {
  CommerceDataField,
  CommerceMoneySet,
  CommerceNormalizedOrder,
} from '@/lib/operations/commerceNormalization'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'

const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u
const FAIRE_RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const MAX_FAIRE_ORDER_LINES = 500
const REVISION_RETENTION_DAYS = 30
const REQUIRED_OAUTH_SCOPES = ['READ_BRAND', 'READ_ORDERS'] as const

export type FaireCanonicalOrderRevisionTarget = {
  organizationId: string
  accountGlobalId: string
  integrationAccountId: string
  externalAccountId: string
  credentialVersion: number
  canonicalOrderGlobalId: string
  canonicalOrderRowVersion: number
  externalOrderId: string
}

export type FaireCanonicalOrderRevisionSnapshot = {
  version: 'faire-canonical-order-revision-v2'
  provider: 'faire'
  accountGlobalId: string
  integrationAccountId: string
  externalAccountId: string
  credentialVersion: number
  canonicalOrderGlobalId: string
  canonicalOrderRowVersion: number
  observedAt: string
  order: {
    externalOrderId: string
    orderNumber: string
    sourceHash: string
    sourceRevision: string
    providerCreatedAt: string | null
    providerProcessedAt: string | null
    providerUpdatedAt: string | null
    providerCancelledAt: string | null
    providerClosedAt: string | null
    rawStates: CommerceNormalizedOrder['rawStates']
    canonicalStates: CommerceNormalizedOrder['canonicalStates']
    currency: string
    providerRevisionState: {
      orderState: string | null
      shipmentCount: number | null
      lineStateBasis: 'all_processing' | 'not_all_processing' | 'incomplete'
      quantityBasis: 'exact_order_item_quantity' | 'unavailable'
    }
    money: {
      subtotalMinor: string | null
      shippingMinor: string | null
      taxMinor: string | null
      discountMinor: string | null
      totalMinor: string | null
      headerState: CommerceNormalizedOrder['headerMoney']['state']
      reconciliationMode:
        | 'discount_separate'
        | 'discount_in_subtotal'
        | 'unreconciled'
    }
    requestedDeliveryAt: string | null
    partyFingerprint: string
    shipToFingerprint: string
    lines: Array<{
      externalLineId: string
      externalProductId: string | null
      externalVariantId: string | null
      sku: string | null
      titleSnapshot: string
      variantTitleSnapshot: string | null
      orderedQuantity: number
      currentQuantity: number | null
      cancelledQuantity: number | null
      fulfilledQuantity: number | null
      unfulfilledQuantity: number | null
      returnedQuantity: number | null
      removedOrRefundedQuantity: number | null
      unitMultiplier: number | null
      physicalUnitQuantity: number
      requiresShipping: boolean
      unitPriceMinor: string | null
      lineSubtotalMinor: string | null
      sourceHash: string
    }>
  }
}

export type FaireCanonicalOrderRevisionEvidence = {
  sourceRevision: string
  sourceHash: string
  revisionHash: string
  snapshot: FaireCanonicalOrderRevisionSnapshot
  protectedParty: ProtectedRevisionSnapshot | null
  protectedShipTo: ProtectedRevisionSnapshot | null
  providerReads: 2
  providerWrites: 0
}

export type ProtectedRevisionSnapshot = EncryptedCommerceOrderRevisionValue & {
  contentFingerprint: string
}

export class FaireOrderRevisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'FaireOrderRevisionError'
  }
}

export type FaireOrderRevisionDependencies = {
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  decryptCredential: typeof decryptCommerceCredential
  probeBrandProfile: typeof probeFaireBrandProfile
  getOrder: typeof getFaireOrder
  normalize: typeof normalizeFaireCommerce
  credentialEligible: typeof commerceReadCredentialEligible
}

const DEFAULT_DEPENDENCIES: FaireOrderRevisionDependencies = {
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  decryptCredential: decryptCommerceCredential,
  probeBrandProfile: probeFaireBrandProfile,
  getOrder: getFaireOrder,
  normalize: normalizeFaireCommerce,
  credentialEligible: commerceReadCredentialEligible,
}

function fail(code: string, message: string, retryable = false): never {
  throw new FaireOrderRevisionError(code, message, retryable)
}

function boundedText(value: unknown, label: string, maximum = 512) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail('FAIRE_ORDER_REVISION_TARGET_INVALID', `${label} is invalid`)
  }
  return value
}

function positiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail('FAIRE_ORDER_REVISION_TARGET_INVALID', `${label} is invalid`)
  }
  return Number(value)
}

function nonnegativeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail('FAIRE_ORDER_REVISION_TARGET_INVALID', `${label} is invalid`)
  }
  return Number(value)
}

function normalizeTarget(
  input: FaireCanonicalOrderRevisionTarget,
): FaireCanonicalOrderRevisionTarget {
  let organizationId: string
  let accountGlobalId: string
  try {
    organizationId = normalizeCommerceOrganizationId(input.organizationId)
    accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  } catch {
    return fail(
      'FAIRE_ORDER_REVISION_TARGET_INVALID',
      'Faire order revision target is invalid',
    )
  }
  const integrationAccountId = boundedText(
    input.integrationAccountId,
    'Faire integration account ID',
    64,
  )
  const externalAccountId = boundedText(
    input.externalAccountId,
    'Faire brand ID',
  )
  const canonicalOrderGlobalId = boundedText(
    input.canonicalOrderGlobalId,
    'Canonical order Global ID',
    32,
  )
  const externalOrderId = boundedText(
    input.externalOrderId,
    'Faire order ID',
    128,
  )
  if (
    !ACCOUNT_GLOBAL_ID.test(accountGlobalId)
    || !ORDER_GLOBAL_ID.test(canonicalOrderGlobalId)
    || !FAIRE_RESOURCE_ID.test(externalOrderId)
  ) {
    fail(
      'FAIRE_ORDER_REVISION_TARGET_INVALID',
      'Faire order revision target identity is invalid',
    )
  }
  return {
    organizationId,
    accountGlobalId,
    integrationAccountId,
    externalAccountId,
    credentialVersion: positiveInteger(
      input.credentialVersion,
      'Faire credential generation',
    ),
    canonicalOrderGlobalId,
    canonicalOrderRowVersion: nonnegativeInteger(
      input.canonicalOrderRowVersion,
      'Canonical order row version',
    ),
    externalOrderId,
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactBrandIdentity(value: unknown, expectedBrandId: string) {
  const profile = record(value)
  const identifiers = profile
    ? [profile.id, profile.brand_id, profile.brandId]
        .filter((candidate) => candidate !== undefined && candidate !== null)
    : []
  if (
    identifiers.length < 1
    || identifiers.some((candidate) => candidate !== expectedBrandId)
  ) {
    fail(
      'FAIRE_ORDER_REVISION_ACCOUNT_CHANGED',
      'Faire returned a different brand identity',
    )
  }
}

function exactOrderIdentity(
  value: unknown,
  expectedOrderId: string,
  expectedBrandId: string,
) {
  const order = record(value)
  if (!order || (order.id ?? order.order_id) !== expectedOrderId) {
    fail(
      'FAIRE_ORDER_REVISION_ORDER_CHANGED',
      'Faire returned a different order identity',
      true,
    )
  }
  const nestedBrand = record(order.brand)
  const brandIdentifiers = [
    order.brand_id,
    order.brandId,
    nestedBrand?.id,
  ].filter((candidate) => candidate !== undefined && candidate !== null)
  if (brandIdentifiers.some((candidate) => candidate !== expectedBrandId)) {
    fail(
      'FAIRE_ORDER_REVISION_ACCOUNT_CHANGED',
      'Faire returned order data for a different brand',
    )
  }
  const items = order.items ?? order.order_items
  const itemRecord = record(items)
  if (
    !Array.isArray(items)
    && !Array.isArray(itemRecord?.nodes)
    && !Array.isArray(itemRecord?.edges)
  ) {
    fail(
      'FAIRE_ORDER_REVISION_LINES_INVALID',
      'Faire exact order revision did not include a complete line set',
    )
  }
  const lines = Array.isArray(items)
    ? items
    : Array.isArray(itemRecord?.nodes)
      ? itemRecord.nodes
      : Array.isArray(itemRecord?.edges)
        ? itemRecord.edges
      : []
  const page = record(
    itemRecord?.pagination ?? itemRecord?.page_info ?? itemRecord?.pageInfo,
  )
  const truncated = (
    order.items_truncated === true
    || itemRecord?.truncated === true
    || itemRecord?.has_more === true
    || itemRecord?.hasNextPage === true
    || page?.has_more === true
    || page?.hasNextPage === true
    || Boolean(
      itemRecord?.next_cursor
      ?? itemRecord?.nextCursor
      ?? itemRecord?.cursor
      ?? page?.next_cursor
      ?? page?.nextCursor
      ?? page?.cursor,
    )
  )
  if (lines.length > MAX_FAIRE_ORDER_LINES || truncated) {
    fail(
      'FAIRE_ORDER_REVISION_LINES_TRUNCATED',
      'Faire order lines exceed the bounded exact-read limit',
    )
  }
  return order
}

function optionsForCredential(
  credential: ReturnType<typeof decryptCommerceCredential>,
): FaireCommerceClientOptions {
  if (credential.provider !== 'faire') {
    fail(
      'FAIRE_ORDER_REVISION_CREDENTIAL_INVALID',
      'Stored commerce credential is not a Faire credential',
    )
  }
  if (credential.authMode === 'faire_oauth') {
    if (
      REQUIRED_OAUTH_SCOPES.some(
        (scope) => !credential.scopes.includes(scope),
      )
    ) {
      fail(
        'FAIRE_ORDER_REVISION_SCOPE_REQUIRED',
        'Faire exact order revision reads require READ_BRAND and READ_ORDERS',
      )
    }
    return {
      accessToken: credential.accessToken,
      applicationId: credential.applicationId,
      applicationSecret: credential.applicationSecret,
      timeoutMs: 15_000,
    }
  }
  return {
    accessToken: credential.accessToken,
    timeoutMs: 15_000,
  }
}

function protectedFingerprint<T>(input: {
  field: CommerceDataField<T>
  target: FaireCanonicalOrderRevisionTarget
  sourceHash: string
  kind: 'party' | 'ship_to'
}) {
  const value = commerceOrderRevisionProtectedPlaintext(input.field, input.kind)
  return value ? commerceOrderRevisionProtectedContentFingerprint(
    value,
    input.target.organizationId,
    input.target.accountGlobalId,
    input.target.externalOrderId,
    input.kind,
  ) : commerceOrderRevisionHash({
    kind: input.kind,
    state: input.field.state,
  })
}

function protectedRevisionSnapshot<T>(input: {
  field: CommerceDataField<T>
  target: FaireCanonicalOrderRevisionTarget
  sourceHash: string
  kind: 'party' | 'ship_to'
}) {
  const value = commerceOrderRevisionProtectedPlaintext(input.field, input.kind)
  if (!value) return null
  const encrypted = encryptCommerceOrderRevisionProtectedSnapshot(
    value,
    input.target.organizationId,
    input.target.accountGlobalId,
    input.target.externalOrderId,
    input.sourceHash,
    input.kind,
  )
  return {
    ...encrypted,
    contentFingerprint: commerceOrderRevisionProtectedContentFingerprint(
      value,
      input.target.organizationId,
      input.target.accountGlobalId,
      input.target.externalOrderId,
      input.kind,
    ),
  }
}

function identityValue<T extends { value: string }>(
  field: CommerceDataField<T>,
) {
  return field.state === 'available' ? field.value.value : null
}

function moneyMinor(field: CommerceDataField<CommerceMoneySet>) {
  return field.state === 'available'
    ? field.value.primary.amountMinor.toString()
    : null
}

function moneyReconciliationMode(order: CommerceNormalizedOrder) {
  const values = [
    moneyMinor(order.subtotal),
    moneyMinor(order.shipping),
    moneyMinor(order.tax),
    moneyMinor(order.discount),
    moneyMinor(order.total),
  ]
  if (values.some((value) => value === null)) return 'unreconciled' as const
  const [subtotal, shipping, tax, discount, total] = values.map((value) => (
    BigInt(value as string)
  ))
  if (discount === BigInt(0)) {
    return total === subtotal + shipping + tax
      ? 'discount_separate' as const
      : 'unreconciled' as const
  }
  if (total === subtotal - discount + shipping + tax) {
    return 'discount_separate' as const
  }
  if (total === subtotal + shipping + tax) {
    return 'discount_in_subtotal' as const
  }
  return 'unreconciled' as const
}

type FaireExactUnstartedLine = Readonly<{
  externalLineId: string
  quantity: number
}>

type FaireExactUnstartedRevisionFacts = Readonly<{
  eligible: boolean
  orderState: string | null
  shipmentCount: number | null
  lineStateBasis: 'all_processing' | 'not_all_processing' | 'incomplete'
  lines: ReadonlyMap<string, FaireExactUnstartedLine> | null
}>

function exactConnectionValues(value: unknown) {
  if (Array.isArray(value)) return value
  const connection = record(value)
  if (Array.isArray(connection?.nodes)) return connection.nodes
  if (Array.isArray(connection?.edges)) {
    return connection.edges.map((edge) => record(edge)?.node ?? edge)
  }
  return null
}

function exactFaireUnstartedRevisionFacts(
  providerOrder: unknown,
  normalizedOrder: CommerceNormalizedOrder,
): FaireExactUnstartedRevisionFacts {
  const source = record(providerOrder)
  const rawOrderState = typeof source?.state === 'string'
    ? source.state.trim().toUpperCase()
    : null
  const normalizedOrderState = typeof normalizedOrder.rawStates.lifecycle === 'string'
    ? normalizedOrder.rawStates.lifecycle.trim().toUpperCase()
    : null
  if (rawOrderState !== normalizedOrderState) {
    fail(
      'FAIRE_ORDER_REVISION_PROVIDER_FACTS_INCOMPLETE',
      'Faire exact order lifecycle state is mismatched',
    )
  }
  const shipmentCount = Array.isArray(source?.shipments)
    ? source.shipments.length
    : null
  const rawLines = exactConnectionValues(source?.items ?? source?.order_items)
  const potentiallyEligible = (
    rawOrderState === 'NEW'
    && shipmentCount === 0
  )
  if (!potentiallyEligible || !rawLines || rawLines.length !== normalizedOrder.lines.length) {
    return {
      eligible: false,
      orderState: rawOrderState,
      shipmentCount,
      lineStateBasis: rawLines ? 'not_all_processing' : 'incomplete',
      lines: null,
    }
  }
  const normalizedById = new Map(normalizedOrder.lines.map((line) => (
    [line.identity.value, line] as const
  )))
  if (normalizedById.size !== normalizedOrder.lines.length) {
    fail(
      'FAIRE_ORDER_REVISION_PROVIDER_FACTS_INCOMPLETE',
      'Faire exact order revision line identities are not unique',
    )
  }
  const lines = new Map<string, FaireExactUnstartedLine>()
  for (const rawValue of rawLines) {
    const rawLine = record(rawValue)
    const externalLineId = rawLine?.id ?? rawLine?.order_item_id ?? rawLine?.item_id
    const state = typeof rawLine?.state === 'string'
      ? rawLine.state.trim().toUpperCase()
      : ''
    if (
      typeof externalLineId !== 'string'
      || !normalizedById.has(externalLineId)
      || lines.has(externalLineId)
      || state !== 'PROCESSING'
    ) {
      return {
        eligible: false,
        orderState: rawOrderState,
        shipmentCount,
        lineStateBasis: state && state !== 'PROCESSING'
          ? 'not_all_processing'
          : 'incomplete',
        lines: null,
      }
    }
    const quantity = rawLine?.quantity
    if (!Number.isSafeInteger(quantity) || Number(quantity) < 1) {
      return {
        eligible: false,
        orderState: rawOrderState,
        shipmentCount,
        lineStateBasis: 'incomplete',
        lines: null,
      }
    }
    const normalizedLine = normalizedById.get(externalLineId)
    if (
      normalizedLine?.orderedQuantity !== Number(quantity)
      || normalizedLine.productIdentity.state !== 'available'
      || normalizedLine.variantIdentity.state !== 'available'
      || rawLine?.product_id !== normalizedLine.productIdentity.value.value
      || rawLine?.variant_id !== normalizedLine.variantIdentity.value.value
      || typeof rawLine?.sku !== 'string'
      || rawLine.sku !== normalizedLine.sku
    ) {
      return {
        eligible: false,
        orderState: rawOrderState,
        shipmentCount,
        lineStateBasis: 'incomplete',
        lines: null,
      }
    }
    lines.set(externalLineId, {
      externalLineId,
      quantity: Number(quantity),
    })
  }
  return {
    eligible: true,
    orderState: rawOrderState,
    shipmentCount,
    lineStateBasis: 'all_processing',
    lines,
  }
}

export function faireCanonicalOrderRevisionSnapshot(input: {
  target: FaireCanonicalOrderRevisionTarget
  order: CommerceNormalizedOrder
  providerOrder: unknown
  observedAt: string
}): FaireCanonicalOrderRevisionSnapshot {
  const target = normalizeTarget(input.target)
  if (
    input.order.identity.provider !== 'faire'
    || input.order.identity.resourceType !== 'order'
    || input.order.identity.value !== target.externalOrderId
    || input.order.lineItemsTruncated
    || input.order.sourceStale
    || !SHA256.test(input.order.sourceHash)
  ) {
    fail(
      'FAIRE_ORDER_REVISION_NORMALIZATION_INVALID',
      'Faire exact order revision normalization is incomplete or mismatched',
    )
  }
  const observedAt = new Date(input.observedAt)
  if (Number.isNaN(observedAt.getTime())) {
    fail(
      'FAIRE_ORDER_REVISION_NORMALIZATION_INVALID',
      'Faire exact order revision observation time is invalid',
    )
  }
  const exactFacts = exactFaireUnstartedRevisionFacts(
    input.providerOrder,
    input.order,
  )
  const lines = input.order.lines.map((line) => ({
    externalLineId: line.identity.value,
    externalProductId: identityValue(line.productIdentity),
    externalVariantId: identityValue(line.variantIdentity),
    sku: line.sku,
    titleSnapshot: line.titleSnapshot,
    variantTitleSnapshot: line.variantTitleSnapshot,
    orderedQuantity: line.orderedQuantity,
    currentQuantity: exactFacts.eligible
      ? exactFacts.lines?.get(line.identity.value)?.quantity ?? null
      : line.currentQuantity,
    cancelledQuantity: exactFacts.eligible ? 0 : line.cancelledQuantity,
    fulfilledQuantity: exactFacts.eligible ? 0 : line.fulfilledQuantity,
    unfulfilledQuantity: exactFacts.eligible
      ? exactFacts.lines?.get(line.identity.value)?.quantity ?? null
      : line.unfulfilledQuantity,
    returnedQuantity: exactFacts.eligible ? 0 : line.returnedQuantity,
    removedOrRefundedQuantity: exactFacts.eligible
      ? 0
      : line.removedOrRefundedQuantity,
    unitMultiplier: line.unitMultiplier,
    physicalUnitQuantity: line.physicalUnitQuantity,
    requiresShipping: line.requiresShipping,
    unitPriceMinor: moneyMinor(line.unitPrice),
    lineSubtotalMinor: moneyMinor(line.lineSubtotal),
    sourceHash: line.sourceHash,
  })).sort((left, right) => (
    left.externalLineId.localeCompare(right.externalLineId)
  ))
  return {
    version: 'faire-canonical-order-revision-v2',
    provider: 'faire',
    accountGlobalId: target.accountGlobalId,
    integrationAccountId: target.integrationAccountId,
    externalAccountId: target.externalAccountId,
    credentialVersion: target.credentialVersion,
    canonicalOrderGlobalId: target.canonicalOrderGlobalId,
    canonicalOrderRowVersion: target.canonicalOrderRowVersion,
    observedAt: observedAt.toISOString(),
    order: {
      externalOrderId: target.externalOrderId,
      orderNumber: input.order.orderNumber,
      sourceHash: input.order.sourceHash,
      sourceRevision: input.order.providerUpdatedAt || input.order.sourceHash,
      providerCreatedAt: input.order.providerCreatedAt,
      providerProcessedAt: input.order.providerProcessedAt,
      providerUpdatedAt: input.order.providerUpdatedAt,
      providerCancelledAt: input.order.providerCancelledAt,
      providerClosedAt: input.order.providerClosedAt,
      rawStates: input.order.rawStates,
      canonicalStates: exactFacts.eligible ? {
          ...input.order.canonicalStates,
          lifecycle: 'open',
          fulfillment: 'unfulfilled',
          returns: 'none',
        } : input.order.canonicalStates,
      currency: input.order.currency,
      providerRevisionState: {
        orderState: exactFacts.orderState,
        shipmentCount: exactFacts.shipmentCount,
        lineStateBasis: exactFacts.lineStateBasis,
        quantityBasis: exactFacts.eligible
          ? 'exact_order_item_quantity'
          : 'unavailable',
      },
      money: {
        subtotalMinor: moneyMinor(input.order.subtotal),
        shippingMinor: moneyMinor(input.order.shipping),
        taxMinor: moneyMinor(input.order.tax),
        discountMinor: moneyMinor(input.order.discount),
        totalMinor: moneyMinor(input.order.total),
        headerState: input.order.headerMoney.state,
        reconciliationMode: moneyReconciliationMode(input.order),
      },
      requestedDeliveryAt: input.order.requestedDeliveryAt.state === 'available'
        ? input.order.requestedDeliveryAt.value
        : null,
      partyFingerprint: protectedFingerprint({
        field: input.order.party,
        target,
        sourceHash: input.order.sourceHash,
        kind: 'party',
      }),
      shipToFingerprint: protectedFingerprint({
        field: input.order.shipTo,
        target,
        sourceHash: input.order.sourceHash,
        kind: 'ship_to',
      }),
      lines,
    },
  }
}

export function faireCanonicalOrderRevisionHash(
  snapshot: FaireCanonicalOrderRevisionSnapshot,
) {
  // Observation time, credential rotation, and the local canonical row
  // version are audit fences, not provider revision content. Excluding them
  // keeps the same exact Faire revision idempotent across bounded polls.
  return commerceOrderRevisionHash(snapshot)
}

export async function inspectFaireCanonicalOrderRevision(
  input: FaireCanonicalOrderRevisionTarget,
  dependencies: FaireOrderRevisionDependencies = DEFAULT_DEPENDENCIES,
): Promise<FaireCanonicalOrderRevisionEvidence> {
  const target = normalizeTarget(input)
  const runtime = await dependencies.readRuntimeCredential({
    organizationId: target.organizationId,
    accountGlobalId: target.accountGlobalId,
  })
  if (
    !runtime
    || runtime.provider !== 'faire'
    || runtime.organizationId !== target.organizationId
    || runtime.integrationAccountId !== target.integrationAccountId
    || runtime.globalId !== target.accountGlobalId
    || runtime.externalAccountId !== target.externalAccountId
    || runtime.credentialVersion !== target.credentialVersion
    || !dependencies.credentialEligible(runtime)
  ) {
    fail(
      'FAIRE_ORDER_REVISION_AUTHORITY_STALE',
      'Faire order revision authority is missing, stale, or mismatched',
    )
  }
  let credential: ReturnType<typeof decryptCommerceCredential>
  try {
    credential = dependencies.decryptCredential(
      runtime.encrypted,
      runtime.organizationId,
      runtime.provider,
      runtime.environment,
      runtime.externalAccountId,
    )
  } catch {
    return fail(
      'FAIRE_ORDER_REVISION_CREDENTIAL_INVALID',
      'Stored Faire credential could not be decrypted',
    )
  }
  const options = optionsForCredential(credential)
  const observedAt = new Date().toISOString()
  let profile: unknown
  let source: unknown
  try {
    profile = await dependencies.probeBrandProfile(options)
    exactBrandIdentity(profile, target.externalAccountId)
    source = await dependencies.getOrder(options, target.externalOrderId)
  } catch (error) {
    if (error instanceof FaireOrderRevisionError) throw error
    return fail(
      'FAIRE_ORDER_REVISION_PROVIDER_READ_FAILED',
      'Faire exact order revision read failed',
      true,
    )
  }
  const orderSource = exactOrderIdentity(
    source,
    target.externalOrderId,
    target.externalAccountId,
  )
  const context = {
    organizationId: target.organizationId,
    integrationAccountId: target.integrationAccountId,
    externalAccountId: target.externalAccountId,
    apiVersion: 'v2',
    observedAt,
    credentialGeneration: target.credentialVersion,
    retentionExpiresAt: new Date(
      Date.parse(observedAt)
        + REVISION_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    sourceState: 'current' as const,
  }
  const envelope = dependencies.normalize({
    brand: { id: target.externalAccountId },
    orders: { orders: [orderSource] },
    products: { products: [] },
  }, context)
  if (
    envelope.provider !== 'faire'
    || envelope.orders.length !== 1
    || envelope.rejections.length !== 0
  ) {
    fail(
      'FAIRE_ORDER_REVISION_NORMALIZATION_REJECTED',
      'Faire exact order revision could not be normalized',
    )
  }
  const snapshot = faireCanonicalOrderRevisionSnapshot({
    target,
    order: envelope.orders[0],
    providerOrder: orderSource,
    observedAt,
  })
  const protectedParty = protectedRevisionSnapshot({
    field: envelope.orders[0].party,
    target,
    sourceHash: snapshot.order.sourceHash,
    kind: 'party',
  })
  const protectedShipTo = protectedRevisionSnapshot({
    field: envelope.orders[0].shipTo,
    target,
    sourceHash: snapshot.order.sourceHash,
    kind: 'ship_to',
  })
  return {
    sourceRevision: snapshot.order.sourceRevision,
    sourceHash: snapshot.order.sourceHash,
    revisionHash: faireCanonicalOrderRevisionHash(snapshot),
    snapshot,
    protectedParty,
    protectedShipTo,
    providerReads: 2,
    providerWrites: 0,
  }
}
