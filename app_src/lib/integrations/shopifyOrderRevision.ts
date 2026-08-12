import {
  readCommerceShopifyOrderRevisionEnvelope,
} from '@/lib/integrations/commerceIntake'
import {
  encryptCommerceCandidateSnapshot,
} from '@/lib/integrations/commerceCredentialCrypto'
import type {
  CommerceDataField,
  CommerceMoneySet,
  CommerceNormalizedOrder,
} from '@/lib/operations/commerceNormalization'
import { commerceSourceHash } from '@/lib/operations/commerceNormalization'
import {
  commerceOrderRevisionHash,
} from '@/lib/integrations/commerceOrderRevisionEvidence'
import type {
  CommerceOrderRevisionClaim,
} from '@/lib/persistence/commerceOrderRevisions'

const SHA256 = /^[a-f0-9]{64}$/u

export type ShopifyCanonicalOrderRevisionSnapshot = Readonly<{
  version: 'shopify-canonical-order-revision-v1'
  provider: 'shopify'
  accountGlobalId: string
  integrationAccountId: string
  externalAccountId: string
  credentialVersion: number
  canonicalOrderGlobalId: string
  canonicalOrderRowVersion: number
  observedAt: string
  order: Readonly<{
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
    money: Readonly<{
      subtotalMinor: string | null
      shippingMinor: string | null
      taxMinor: string | null
      discountMinor: string | null
      totalMinor: string | null
      headerState: CommerceNormalizedOrder['headerMoney']['state']
    }>
    requestedDeliveryAt: string | null
    partyFingerprint: string
    shipToFingerprint: string
    lines: ReadonlyArray<Readonly<{
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
    }>>
  }>
}>

export type ShopifyCanonicalOrderRevisionEvidence = Readonly<{
  sourceHash: string
  sourceRevision: string
  revisionHash: string
  snapshot: ShopifyCanonicalOrderRevisionSnapshot
  providerReads: 2 | 3
  providerWrites: 0
}>

export function shopifyCanonicalOrderRevisionHash(
  snapshot: ShopifyCanonicalOrderRevisionSnapshot,
) {
  return commerceOrderRevisionHash(snapshot)
}

export type ShopifyOrderRevisionDependencies = Readonly<{
  readExactOrder: typeof readCommerceShopifyOrderRevisionEnvelope
}>

const DEFAULT_DEPENDENCIES: ShopifyOrderRevisionDependencies = {
  readExactOrder: readCommerceShopifyOrderRevisionEnvelope,
}

export class ShopifyOrderRevisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ShopifyOrderRevisionError'
  }
}

function protectedFingerprint<T>(input: {
  field: CommerceDataField<T>
  claim: CommerceOrderRevisionClaim
  kind: 'party' | 'ship_to'
}) {
  const value = input.field as unknown as Record<string, unknown>
  return encryptCommerceCandidateSnapshot(
    value,
    input.claim.organizationId,
    input.claim.accountGlobalId,
    input.claim.externalOrderId,
    commerceSourceHash(value),
    input.kind,
  ).hash
}

function identityValue<T extends { value: string }>(field: CommerceDataField<T>) {
  return field.state === 'available' ? field.value.value : null
}

function moneyMinor(field: CommerceDataField<CommerceMoneySet>) {
  return field.state === 'available'
    ? field.value.primary.amountMinor.toString()
    : null
}

function assertTarget(claim: CommerceOrderRevisionClaim) {
  if (claim.provider !== 'shopify') {
    throw new ShopifyOrderRevisionError(
      'SHOPIFY_ORDER_REVISION_TARGET_INVALID',
      'Shopify exact revision target is invalid',
    )
  }
}

export function shopifyCanonicalOrderRevisionSnapshot(input: {
  claim: CommerceOrderRevisionClaim
  order: CommerceNormalizedOrder
  observedAt: string
}): ShopifyCanonicalOrderRevisionSnapshot {
  assertTarget(input.claim)
  const observedAt = new Date(input.observedAt)
  if (
    Number.isNaN(observedAt.getTime())
    || input.order.identity.provider !== 'shopify'
    || input.order.identity.resourceType !== 'order'
    || input.order.identity.value !== input.claim.externalOrderId
    || input.order.lineItemsTruncated
    || input.order.sourceStale
    || !SHA256.test(input.order.sourceHash)
  ) {
    throw new ShopifyOrderRevisionError(
      'SHOPIFY_ORDER_REVISION_NORMALIZATION_INVALID',
      'Shopify exact order revision normalization is incomplete or mismatched',
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
  })).sort((left, right) => left.externalLineId.localeCompare(right.externalLineId))
  return Object.freeze({
    version: 'shopify-canonical-order-revision-v1',
    provider: 'shopify',
    accountGlobalId: input.claim.accountGlobalId,
    integrationAccountId: input.claim.integrationAccountId,
    externalAccountId: input.claim.externalAccountId,
    credentialVersion: input.claim.credentialVersion,
    canonicalOrderGlobalId: input.claim.canonicalOrderGlobalId,
    canonicalOrderRowVersion: input.claim.canonicalOrderRowVersion,
    observedAt: observedAt.toISOString(),
    order: Object.freeze({
      externalOrderId: input.claim.externalOrderId,
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
      money: Object.freeze({
        subtotalMinor: moneyMinor(input.order.subtotal),
        shippingMinor: moneyMinor(input.order.shipping),
        taxMinor: moneyMinor(input.order.tax),
        discountMinor: moneyMinor(input.order.discount),
        totalMinor: moneyMinor(input.order.total),
        headerState: input.order.headerMoney.state,
      }),
      requestedDeliveryAt: input.order.requestedDeliveryAt.state === 'available'
        ? input.order.requestedDeliveryAt.value
        : null,
      partyFingerprint: protectedFingerprint({
        field: input.order.party,
        claim: input.claim,
        kind: 'party',
      }),
      shipToFingerprint: protectedFingerprint({
        field: input.order.shipTo,
        claim: input.claim,
        kind: 'ship_to',
      }),
      lines: Object.freeze(lines),
    }),
  })
}

export async function inspectShopifyCanonicalOrderRevision(
  claim: CommerceOrderRevisionClaim,
  dependencies: ShopifyOrderRevisionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ShopifyCanonicalOrderRevisionEvidence> {
  assertTarget(claim)
  let exact: Awaited<ReturnType<typeof readCommerceShopifyOrderRevisionEnvelope>>
  try {
    exact = await dependencies.readExactOrder({
      organizationId: claim.organizationId,
      accountGlobalId: claim.accountGlobalId,
      integrationAccountId: claim.integrationAccountId,
      externalAccountId: claim.externalAccountId,
      externalOrderId: claim.externalOrderId,
      expectedCredentialVersion: claim.credentialVersion,
    })
  } catch (error) {
    if (error instanceof ShopifyOrderRevisionError) throw error
    throw new ShopifyOrderRevisionError(
      'SHOPIFY_ORDER_REVISION_PROVIDER_READ_FAILED',
      'Shopify exact order revision read failed',
      true,
    )
  }
  if (
    exact.providerWrites !== 0
    || exact.envelope.provider !== 'shopify'
    || exact.envelope.orders.length !== 1
    || exact.envelope.rejections.length !== 0
  ) {
    throw new ShopifyOrderRevisionError(
      'SHOPIFY_ORDER_REVISION_NORMALIZATION_REJECTED',
      'Shopify exact order revision could not be normalized',
    )
  }
  const snapshot = shopifyCanonicalOrderRevisionSnapshot({
    claim,
    order: exact.envelope.orders[0],
    observedAt: exact.observedAt,
  })
  return Object.freeze({
    sourceHash: snapshot.order.sourceHash,
    sourceRevision: snapshot.order.sourceRevision,
    revisionHash: shopifyCanonicalOrderRevisionHash(snapshot),
    snapshot,
    providerReads: exact.providerReads,
    providerWrites: 0 as const,
  })
}
