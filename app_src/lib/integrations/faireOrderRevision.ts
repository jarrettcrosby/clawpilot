import {
  decryptCommerceCredential,
  encryptCommerceCandidateSnapshot,
  normalizeCommerceAccountGlobalId,
  normalizeCommerceOrganizationId,
} from '@/lib/integrations/commerceCredentialCrypto'
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
  commerceOrderRevisionHash,
} from '@/lib/integrations/commerceOrderRevisionEvidence'
import type {
  CommerceDataField,
  CommerceMoneySet,
  CommerceNormalizedOrder,
} from '@/lib/operations/commerceNormalization'
import { commerceSourceHash } from '@/lib/operations/commerceNormalization'
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
  version: 'faire-canonical-order-revision-v1'
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
    money: {
      subtotalMinor: string | null
      shippingMinor: string | null
      taxMinor: string | null
      discountMinor: string | null
      totalMinor: string | null
      headerState: CommerceNormalizedOrder['headerMoney']['state']
    }
    requestedDeliveryAt: string | null
    partyFingerprint: string
    shipToFingerprint: string
    lines: Array<{
      externalLineId: string
      externalProductId: string | null
      externalVariantId: string | null
      sku: string | null
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
  providerReads: 2
  providerWrites: 0
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
  kind: 'party' | 'ship_to'
}) {
  const value = input.field as unknown as Record<string, unknown>
  return encryptCommerceCandidateSnapshot(
    value,
    input.target.organizationId,
    input.target.accountGlobalId,
    input.target.externalOrderId,
    commerceSourceHash(value),
    input.kind,
  ).hash
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

export function faireCanonicalOrderRevisionSnapshot(input: {
  target: FaireCanonicalOrderRevisionTarget
  order: CommerceNormalizedOrder
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
  const lines = input.order.lines.map((line) => ({
    externalLineId: line.identity.value,
    externalProductId: identityValue(line.productIdentity),
    externalVariantId: identityValue(line.variantIdentity),
    sku: line.sku,
    orderedQuantity: line.orderedQuantity,
    currentQuantity: line.currentQuantity,
    cancelledQuantity: line.cancelledQuantity,
    fulfilledQuantity: line.fulfilledQuantity,
    unfulfilledQuantity: line.unfulfilledQuantity,
    returnedQuantity: line.returnedQuantity,
    removedOrRefundedQuantity: line.removedOrRefundedQuantity,
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
    version: 'faire-canonical-order-revision-v1',
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
      canonicalStates: input.order.canonicalStates,
      currency: input.order.currency,
      money: {
        subtotalMinor: moneyMinor(input.order.subtotal),
        shippingMinor: moneyMinor(input.order.shipping),
        taxMinor: moneyMinor(input.order.tax),
        discountMinor: moneyMinor(input.order.discount),
        totalMinor: moneyMinor(input.order.total),
        headerState: input.order.headerMoney.state,
      },
      requestedDeliveryAt: input.order.requestedDeliveryAt.state === 'available'
        ? input.order.requestedDeliveryAt.value
        : null,
      partyFingerprint: protectedFingerprint({
        field: input.order.party,
        target,
        kind: 'party',
      }),
      shipToFingerprint: protectedFingerprint({
        field: input.order.shipTo,
        target,
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
    observedAt,
  })
  return {
    sourceRevision: snapshot.order.sourceRevision,
    sourceHash: snapshot.order.sourceHash,
    revisionHash: faireCanonicalOrderRevisionHash(snapshot),
    snapshot,
    providerReads: 2,
    providerWrites: 0,
  }
}
