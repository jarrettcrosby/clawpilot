import { createHash } from 'node:crypto'
import { hasEffectiveShopifyScope } from '@/lib/integrations/commerceCapabilities'
import {
  commerceProviderStaffEvidenceFingerprint,
  decryptCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import { normalizeFaireCommerce } from '@/lib/integrations/faireCommerceNormalizer'
import {
  getFaireOrder,
  listFaireOrders,
  probeFaireBrandProfile,
} from '@/lib/integrations/faireCommerceClient'
import { normalizeShopifyCommerce } from '@/lib/integrations/shopifyCommerceNormalizer'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  shopifyAdminGraphql,
} from '@/lib/integrations/shopifyCommerceClient'
import type {
  CommerceNormalizationContext,
  CommerceNormalizedOrder,
} from '@/lib/operations/commerceNormalization'
import {
  commerceMoneyFromDecimal,
  integerCommerceMinorUnits,
} from '@/lib/operations/commerceNormalization'
import {
  CommerceOrderSyncError,
  type CommerceOrderEventObservationInput,
  type CommerceOrderObservationInput,
} from '@/lib/persistence/commerceOrderSync'
import {
  readCommerceRuntimeCredentialFromPostgres,
  type CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'

const SHOPIFY_PAGE_SIZE = 5
const SHOPIFY_LINE_LIMIT = 50
// Shopify returns Order.fulfillments as a bounded list rather than a cursor
// connection. Real multi-parcel wholesale orders can legitimately exceed 20
// fulfillments, so retain a production-sized envelope without letting one
// large order terminate the account-wide history stream.
const SHOPIFY_FULFILLMENT_LIMIT = 100
const SHOPIFY_TRACKING_LIMIT = 10
const SHOPIFY_REFUND_LIMIT = 100
const SHOPIFY_RETURN_LIMIT = 20
const SHOPIFY_ADJUSTMENT_LINE_LIMIT = SHOPIFY_LINE_LIMIT
const FAIRE_PAGE_SIZE = 50
const FAIRE_LINE_LIMIT = 250
const FAIRE_LIFECYCLE_COLLECTION_LIMIT = 100
const FAIRE_NESTED_ITEM_LIMIT = 250
const FAIRE_TRACKING_LIMIT = 20
const PROVIDER_TIMEOUT_MS = 15_000
const MAX_CURSOR_LENGTH = 4_096
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1_000
const SHOPIFY_READ_ORDERS_QUEUE_SLA_MS = 10 * 60 * 1_000

type JsonRecord = Record<string, unknown>

export type CommerceOrderHistoryPageInput = {
  organizationId: string
  accountGlobalId: string
  expectedCredentialGeneration: number
  requestedFrom: string | null
  requestedThrough: string
  providerCursor: string | null
  observedAt?: string
  mode?: 'historical_backfill' | 'continuous_poll'
}

export type CommerceOrderHistoryPage = {
  provider: 'shopify' | 'faire'
  observations: readonly CommerceOrderObservationInput[]
  nextProviderCursor: string | null
  providerRowsSeen: number
  providerReads: number
  providerWrites: 0
  readAllOrdersScopeObserved: boolean | null
  returnHistoryScopeObserved: boolean | null
}

export type ExactShopifyOrderHistoryInput = {
  organizationId: string
  accountGlobalId: string
  expectedCredentialGeneration: number
  externalOrderId: string
  observedAt?: string
  observationKind: 'webhook_exact_read' | 'manual_exact_read'
}

export type ExactShopifyOrderHistoryRead = {
  provider: 'shopify'
  observation: CommerceOrderObservationInput
  providerReads: 3
  providerWrites: 0
  readAllOrdersScopeObserved: boolean
  returnHistoryScopeObserved: boolean
}

export type ExactFaireOrderHistoryInput = {
  organizationId: string
  accountGlobalId: string
  expectedCredentialGeneration: number
  externalOrderId: string
  observedAt?: string
  observationKind: 'manual_exact_read'
}

export type ExactFaireOrderHistoryRead = {
  provider: 'faire'
  observation: CommerceOrderObservationInput
  providerReads: 2
  providerWrites: 0
  readAllOrdersScopeObserved: null
  returnHistoryScopeObserved: null
}

const exactShopifyOrderHistoryReadAttempts = new WeakMap<object, number>()
const exactFaireOrderHistoryReadAttempts = new WeakMap<object, number>()

/**
 * Returns the number of Shopify network reads attempted before an exact-order
 * read failed. The count is request-local diagnostic evidence; it deliberately
 * does not change the provider error's public code or status.
 */
export function exactShopifyOrderHistoryProviderReads(error: unknown) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return null
  }
  return exactShopifyOrderHistoryReadAttempts.get(error as object) ?? null
}

/**
 * Returns the number of Faire network reads attempted before an exact-order
 * read failed. This is diagnostic evidence only and never changes the
 * provider error exposed by the route.
 */
export function exactFaireOrderHistoryProviderReads(error: unknown) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return null
  }
  return exactFaireOrderHistoryReadAttempts.get(error as object) ?? null
}

function retainExactShopifyOrderHistoryReadAttempts(
  error: unknown,
  providerReads: number,
): never {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    exactShopifyOrderHistoryReadAttempts.set(error as object, providerReads)
  }
  throw error
}

function retainExactFaireOrderHistoryReadAttempts(
  error: unknown,
  providerReads: number,
): never {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    exactFaireOrderHistoryReadAttempts.set(error as object, providerReads)
  }
  throw error
}

function historyError(code: string, message: string, status = 409): never {
  throw new CommerceOrderSyncError(code, message, status)
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function records(value: unknown) {
  if (Array.isArray(value)) {
    const entries = value.map(asRecord)
    return entries.every((entry) => entry !== null)
      ? entries as JsonRecord[]
      : []
  }
  const container = asRecord(value)
  const values = container?.nodes ?? container?.items
  if (!Array.isArray(values)) return []
  const entries = values.map(asRecord)
  return entries.every((entry) => entry !== null)
    ? entries as JsonRecord[]
    : []
}

function providerResponseInvalid(label: string): never {
  historyError(
    'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
    `${label} is invalid`,
    502,
  )
}

function strictRecordArray(
  value: unknown,
  label: string,
  options: { optional?: boolean } = {},
) {
  if ((value === null || value === undefined) && options.optional) return []
  if (!Array.isArray(value)) providerResponseInvalid(label)
  const result: JsonRecord[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) providerResponseInvalid(label)
    result.push(record)
  }
  return result
}

function assertCollectionLimit(
  values: readonly unknown[],
  limit: number,
  label: string,
) {
  if (values.length > limit) {
    historyError(
      'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
      `${label} exceeds the bounded history limit`,
      409,
    )
  }
}

function strictOptionalTextFact(value: unknown, label: string) {
  // Shopify can return an exact empty string for optional String fields such
  // as an order-line SKU. Treat that provider-valid representation the same
  // as null while continuing to reject whitespace-only and non-string facts.
  if (value === null || value === undefined || value === '') return
  if (!exactString(value)) providerResponseInvalid(label)
}

function strictOptionalBooleanFact(value: unknown, label: string) {
  if (value === null || value === undefined) return
  if (typeof value !== 'boolean') providerResponseInvalid(label)
}

function strictOptionalQuantityFact(value: unknown, label: string) {
  if (value === null || value === undefined) return
  if (normalizeCommerceHistoryProviderQuantity(value) === null) {
    providerResponseInvalid(label)
  }
}

function strictOptionalIsoFact(value: unknown, label: string) {
  if (value === null || value === undefined) return
  optionalProviderIso(value, label)
}

function strictRequiredIsoFact(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') {
    providerResponseInvalid(label)
  }
  optionalProviderIso(value, label)
}

function strictRequiredTextFact(value: unknown, label: string) {
  if (!exactString(value)) providerResponseInvalid(label)
}

function strictConnection(
  value: unknown,
  label: string,
  options: { optional?: boolean } = {},
) {
  if ((value === null || value === undefined) && options.optional) {
    return { values: [] as JsonRecord[], hasNextPage: false, endCursor: null }
  }
  const connection = asRecord(value)
  if (!connection || !Object.hasOwn(connection, 'nodes')) {
    providerResponseInvalid(label)
  }
  const values = strictRecordArray(connection.nodes, `${label} nodes`)
  const pageInfo = asRecord(connection.pageInfo)
  if (!pageInfo || typeof pageInfo.hasNextPage !== 'boolean') {
    providerResponseInvalid(`${label} page information`)
  }
  const endCursor = pageInfo.endCursor
  if (
    endCursor !== null
    && endCursor !== undefined
    && (
      typeof endCursor !== 'string'
      || !endCursor.trim()
      || endCursor.trim().length > MAX_CURSOR_LENGTH
    )
  ) {
    providerResponseInvalid(`${label} end cursor`)
  }
  return {
    values,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: typeof endCursor === 'string' ? endCursor.trim() : null,
  }
}

function requiredIso(value: unknown, label: string) {
  const parsed = typeof value === 'string' ? new Date(value) : new Date('')
  if (Number.isNaN(parsed.getTime())) {
    historyError('COMMERCE_ORDER_HISTORY_WINDOW_INVALID', `${label} is invalid`, 400)
  }
  return parsed.toISOString()
}

function optionalProviderIso(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !value.trim()) {
    historyError(
      'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
      `${label} is invalid`,
      502,
    )
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    historyError(
      'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
      `${label} is invalid`,
      502,
    )
  }
  return parsed.toISOString()
}

function boundedCursor(value: unknown, current: string | null = null) {
  if (value === null || value === undefined || value === '') return null
  const cursor = typeof value === 'string' ? value.trim() : ''
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH || cursor === current) {
    historyError(
      'COMMERCE_ORDER_HISTORY_CURSOR_INVALID',
      'The provider returned an invalid historical-order cursor',
      502,
    )
  }
  return cursor
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function commerceProviderStaffFingerprint(input: {
  organizationId: string
  accountGlobalId: string
  provider: 'shopify' | 'faire'
  staffId: unknown
}) {
  const identity = exactString(input.staffId)
  if (!identity) return null
  return commerceProviderStaffEvidenceFingerprint({
    ...input,
    staffId: identity,
  })
}

function exactString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function optionalProviderText(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') return null
  const normalized = exactString(value)
  if (!normalized) {
    historyError(
      'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
      `${label} is invalid`,
      502,
    )
  }
  return normalized
}

function optionalProviderTrackingUrl(value: unknown) {
  const normalized = optionalProviderText(value, 'Provider tracking URL')
  if (!normalized) return null
  if (normalized.length > 2_048) {
    providerResponseInvalid('Provider tracking URL')
  }
  try {
    const parsed = new URL(normalized)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      providerResponseInvalid('Provider tracking URL')
    }
    return parsed.toString()
  } catch {
    providerResponseInvalid('Provider tracking URL')
  }
}

export function normalizeCommerceHistoryProviderQuantity(value: unknown) {
  return (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
  ) ? value : null
}

const nonnegativeNumber = normalizeCommerceHistoryProviderQuantity

export function sumCommerceHistoryProviderQuantities(value: unknown) {
  const entries = records(value)
  if (!entries.length) return null
  const quantities = entries.map((entry) => nonnegativeNumber(entry.quantity))
  if (quantities.some((entry) => entry === null)) return null
  const sum = (quantities as number[]).reduce((total, entry) => total + entry, 0)
  return Number.isSafeInteger(sum) ? sum : null
}

/**
 * Shopify exposes removed/refunded units through LineItem.currentQuantity,
 * but a physical return is only attributable to an order line through Refund
 * and Return line records. A processed Return and its later restocking Refund
 * can describe the same units, so retain the larger exact total instead of
 * adding the two provider representations and double-counting them.
 */
export function shopifyOrderHistoryReturnedQuantities(value: unknown) {
  const source = asRecord(value)
  if (!source) providerResponseInvalid('Shopify historical-order detail')
  const refundedReturns = new Map<string, number>()
  const processedReturns = new Map<string, number>()
  const add = (target: Map<string, number>, identity: string, quantity: number) => {
    const next = (target.get(identity) || 0) + quantity
    if (!Number.isSafeInteger(next)) {
      providerResponseInvalid('Shopify returned line quantity')
    }
    target.set(identity, next)
  }

  for (const refund of strictRecordArray(source.refunds, 'Shopify refund rows')) {
    const connection = strictConnection(
      refund.refundLineItems,
      'Shopify refund line rows',
    )
    for (const line of connection.values) {
      const restockType = exactString(line.restockType)
      if (!['RETURN', 'LEGACY_RESTOCK'].includes(restockType || '')) continue
      const lineItem = asRecord(line.lineItem)
      const externalLineId = exactString(lineItem?.id)
      const quantity = normalizeCommerceHistoryProviderQuantity(line.quantity)
      if (!externalLineId || quantity === null) {
        providerResponseInvalid('Shopify refund line attribution')
      }
      add(refundedReturns, externalLineId, quantity)
    }
  }

  const returns = strictConnection(
    source.returns,
    'Shopify return rows',
    { optional: true },
  )
  for (const providerReturn of returns.values) {
    const connection = strictConnection(
      providerReturn.returnLineItems,
      'Shopify return line rows',
    )
    for (const line of connection.values) {
      if (exactString(line.__typename) !== 'ReturnLineItem') continue
      const fulfillmentLine = asRecord(line.fulfillmentLineItem)
      const orderLine = asRecord(fulfillmentLine?.lineItem)
      const externalLineId = exactString(orderLine?.id)
      const processed = normalizeCommerceHistoryProviderQuantity(
        line.processedQuantity,
      )
      const refunded = normalizeCommerceHistoryProviderQuantity(
        line.refundedQuantity,
      )
      if (!externalLineId || processed === null || refunded === null) {
        providerResponseInvalid('Shopify return line attribution')
      }
      add(processedReturns, externalLineId, Math.max(processed, refunded))
    }
  }

  return new Map([...new Set([
    ...refundedReturns.keys(),
    ...processedReturns.keys(),
  ])].map((externalLineId) => [
    externalLineId,
    Math.max(
      refundedReturns.get(externalLineId) || 0,
      processedReturns.get(externalLineId) || 0,
    ),
  ]))
}

function money(order: CommerceNormalizedOrder) {
  if (order.total.state !== 'available') return { currency: null, minor: null }
  const amount = order.total.value.primary.amountMinor
  const minor = Number(amount)
  return Number.isSafeInteger(minor)
    ? { currency: order.total.value.primary.currency, minor }
    : { currency: null, minor: null }
}

function lineMoney(
  field: CommerceNormalizedOrder['lines'][number]['unitPrice'] | undefined,
) {
  if (!field || field.state !== 'available') return null
  const amountMinor = Number(field.value.primary.amountMinor)
  return Number.isSafeInteger(amountMinor)
    ? { currency: field.value.primary.currency, amountMinor }
    : null
}

function refundMoney(refund: JsonRecord) {
  const providerMoney = asRecord(asRecord(refund.totalRefundedSet)?.shopMoney)
  const hasProviderMoney = refund.totalRefundedSet !== null
    && refund.totalRefundedSet !== undefined
  const hasMinorMoney = (
    refund.amount_cents !== null && refund.amount_cents !== undefined
  ) || (
    refund.total_cents !== null && refund.total_cents !== undefined
  )
  if (!hasProviderMoney && !hasMinorMoney) {
    return { amountMinor: null, currency: null }
  }
  try {
    const exact = providerMoney
      ? commerceMoneyFromDecimal(providerMoney.amount, providerMoney.currencyCode)
      : integerCommerceMinorUnits(
          refund.amount_cents ?? refund.total_cents,
          refund.currency ?? refund.currency_code,
        )
    const minor = Number(exact.amountMinor)
    if (!Number.isSafeInteger(minor)) throw new Error('unsafe refund amount')
    return { amountMinor: minor, currency: exact.currency }
  } catch {
    providerResponseInvalid('Provider refund money')
  }
}

function providerEvents(
  provider: 'shopify' | 'faire',
  order: CommerceNormalizedOrder,
  source: JsonRecord,
  observedAt: string,
) {
  const events: CommerceOrderEventObservationInput[] = []
  const push = (event: CommerceOrderEventObservationInput | null) => {
    if (event) events.push(event)
  }
  if (order.providerCreatedAt) {
    push({
      externalEventId: `${order.identity.value}:created`,
      eventKind: 'order_created',
      inventoryEffectKind: 'order_demand',
      attributionSource: 'provider_system',
      occurredAt: order.providerCreatedAt,
    })
  }
  if (order.providerUpdatedAt && order.providerUpdatedAt !== order.providerCreatedAt) {
    push({
      externalEventId: `${order.identity.value}:updated:${order.providerUpdatedAt}`,
      eventKind: 'order_updated',
      eventStatus: order.rawStates.lifecycle,
      attributionSource: 'provider_system',
      occurredAt: order.providerUpdatedAt,
    })
  }
  if (order.providerUpdatedAt) {
    push({
      externalEventId:
        `${order.identity.value}:payment-state:${order.providerUpdatedAt}`,
      externalSubjectId: order.identity.value,
      eventKind: 'payment_updated',
      eventStatus: order.rawStates.payment,
      attributionSource: 'provider_system',
      occurredAt: order.providerUpdatedAt,
    })
    // Faire exposes the order-level updated_at revision used by its history
    // feed. Shopify Return has no updatedAt field, and Shopify does not promise
    // that Order.updatedAt is the revision clock for a nested Return. Shopify
    // return history therefore uses only exact Return milestone timestamps
    // below instead of backdating the current state onto the parent order.
    if (provider === 'faire') {
      push({
        externalEventId:
          `${order.identity.value}:return-state:${order.providerUpdatedAt}`,
        externalSubjectId: order.identity.value,
        eventKind: 'return_updated',
        eventStatus: order.rawStates.returns,
        attributionSource: 'provider_system',
        occurredAt: order.providerUpdatedAt,
      })
    }
  }
  if (order.providerCancelledAt) {
    push({
      externalEventId: `${order.identity.value}:cancelled`,
      eventKind: 'order_cancelled',
      inventoryEffectKind: 'unknown',
      attributionSource: 'provider_system',
      occurredAt: order.providerCancelledAt,
    })
  }
  if (order.providerClosedAt) {
    push({
      externalEventId: `${order.identity.value}:closed`,
      eventKind: 'order_closed',
      attributionSource: 'provider_system',
      occurredAt: order.providerClosedAt,
    })
  }
  const fulfillmentCollections = provider === 'shopify'
    ? strictRecordArray(source.fulfillments, 'Shopify fulfillment rows')
    : strictRecordArray(
        source.shipments ?? source.fulfillments,
        'Faire shipment rows',
        { optional: true },
      )
  for (const [fulfillmentIndex, fulfillment] of fulfillmentCollections.entries()) {
    const id = optionalProviderText(
      fulfillment.id ?? fulfillment.shipment_id ?? fulfillment.fulfillment_id,
      'Provider fulfillment identity',
    )
    const createdAt = optionalProviderIso(
      fulfillment.createdAt ?? fulfillment.created_at ?? fulfillment.shipped_at,
      'Provider fulfillment creation time',
    )
    const updatedAt = optionalProviderIso(
      fulfillment.updatedAt ?? fulfillment.updated_at ?? fulfillment.delivered_at,
      'Provider fulfillment update time',
    )
    const location = asRecord(fulfillment.location)
      ?? asRecord(asRecord(fulfillment.assignedLocation)?.location)
    const trackingValue = fulfillment.trackingInfo
      ?? fulfillment.tracking_info
      ?? fulfillment.tracking_numbers
    const nestedTracking = strictRecordArray(
      trackingValue,
      `${provider} fulfillment tracking rows`,
      { optional: true },
    )
    const flatTrackingNumber = optionalProviderText(
      fulfillment.tracking_number ?? fulfillment.trackingNumber
        ?? fulfillment.tracking_code,
      'Provider tracking number',
    )
    const tracking = nestedTracking.length
      ? nestedTracking
      : flatTrackingNumber
        ? [{
            number: flatTrackingNumber,
            company: fulfillment.carrier ?? fulfillment.carrier_name,
          }]
        : []
    const trackingRevisionAt = provider === 'shopify'
      ? optionalProviderIso(
          fulfillment.updatedAt,
          'Shopify fulfillment tracking revision time',
        )
      : optionalProviderIso(
          fulfillment.updated_at ?? fulfillment.updatedAt,
          'Faire shipment tracking revision time',
        )
    if (tracking.length && !trackingRevisionAt) {
      providerResponseInvalid(
        `${provider} tracking-bearing fulfillment update time`,
      )
    }
    if (createdAt) {
      push({
        externalEventId: id,
        externalSubjectId: id,
        eventKind: provider === 'faire' ? 'shipment_created' : 'fulfillment_created',
        inventoryEffectKind: 'none',
        attributionSource: 'unavailable',
        providerLocationId: exactString(
          location?.id ?? fulfillment.location_id ?? fulfillment.warehouse_id,
        ),
        occurredAt: createdAt,
      })
    }
    if (updatedAt && updatedAt !== createdAt) {
      push({
        externalEventId: id ? `${id}:updated:${updatedAt}` : null,
        externalSubjectId: id,
        eventKind: provider === 'faire' ? 'tracking_updated' : 'fulfillment_updated',
        eventStatus: exactString(
          fulfillment.status ?? fulfillment.displayStatus ?? fulfillment.state,
        ),
        attributionSource: 'unavailable',
        providerLocationId: exactString(
          location?.id ?? fulfillment.location_id ?? fulfillment.warehouse_id,
        ),
        occurredAt: updatedAt,
      })
      if (provider === 'shopify') {
        push({
          externalEventId: id ? `${id}:tracking-state:${updatedAt}` : null,
          externalSubjectId: id,
          eventKind: 'tracking_updated',
          eventStatus: exactString(
            fulfillment.status ?? fulfillment.displayStatus,
          ),
          attributionSource: 'unavailable',
          providerLocationId: exactString(
            location?.id ?? fulfillment.location_id,
          ),
          occurredAt: updatedAt,
        })
      }
    }
    for (const [trackingIndex, item] of tracking.entries()) {
      const number = optionalProviderText(
        item.number ?? item.tracking_number,
        'Provider tracking number',
      )
      const occurredAt = trackingRevisionAt
      if (!number || !occurredAt) continue
      push({
        externalEventId:
          `${id || order.identity.value}:tracking:${fulfillmentIndex}`
          + `:${trackingIndex}:${occurredAt}`,
        externalSubjectId: id,
        eventKind: 'tracking_updated',
        eventStatus: exactString(fulfillment.status ?? fulfillment.state),
        attributionSource: 'unavailable',
        providerLocationId: exactString(location?.id ?? fulfillment.location_id),
        trackingCarrier: exactString(item.company ?? item.carrier),
        trackingNumber: number,
        trackingUrl: optionalProviderTrackingUrl(
          item.url ?? item.tracking_url,
        ),
        occurredAt,
      })
    }
  }
  for (const refund of strictRecordArray(
    source.refunds,
    `${provider} refund rows`,
    { optional: provider === 'faire' },
  )) {
    const id = optionalProviderText(
      refund.id ?? refund.refund_id,
      'Provider refund identity',
    )
    const createdAt = optionalProviderIso(
      refund.createdAt ?? refund.created_at ?? refund.processedAt
        ?? refund.processed_at,
      'Provider refund creation time',
    )
    const updatedAt = optionalProviderIso(
      refund.updatedAt ?? refund.updated_at,
      'Provider refund update time',
    )
    if (!createdAt) continue
    const exactMoney = refundMoney(refund)
    const refundItems = provider === 'shopify'
      ? strictConnection(
          refund.refundLineItems,
          'Shopify refund line rows',
        ).values
      : strictRecordArray(
          refund.refundLineItems ?? refund.items,
          `${provider} refund item rows`,
          { optional: true },
        )
    const restocks = refundItems.some(
      (line) => ['RETURN', 'CANCEL', 'LEGACY_RESTOCK'].includes(
        exactString(line.restockType ?? line.restock_type) || '',
      ),
    )
    const hasMutableRefundFacts = (
      refund.status !== null && refund.status !== undefined
    ) || (
      refund.totalRefundedSet !== null
        && refund.totalRefundedSet !== undefined
    ) || (
      refund.amount_cents !== null && refund.amount_cents !== undefined
    ) || (
      refund.total_cents !== null && refund.total_cents !== undefined
    ) || refundItems.length > 0
    if (hasMutableRefundFacts && !updatedAt) {
      providerResponseInvalid(`${provider} refund update time`)
    }
    push({
      externalEventId: id ? `${id}:created` : null,
      externalSubjectId: id,
      eventKind: 'refund_created',
      inventoryEffectKind: 'unknown',
      attributionSource: 'unavailable',
      occurredAt: createdAt,
    })
    if (updatedAt) {
      push({
        externalEventId: id ? `${id}:updated:${updatedAt}` : null,
        externalSubjectId: id,
        eventKind: 'refund_updated',
        eventStatus: exactString(refund.status),
        amountMinor: exactMoney.amountMinor,
        currency: exactMoney.currency,
        inventoryEffectKind: restocks ? 'restock_instruction' : 'unknown',
        attributionSource: 'unavailable',
        occurredAt: updatedAt,
      })
    }
  }
  for (const providerReturn of strictRecordArray(
    asRecord(source.returns)?.nodes ?? source.returns,
    `${provider} return rows`,
    { optional: true },
  )) {
    const id = optionalProviderText(
      providerReturn.id ?? providerReturn.return_id,
      'Provider return identity',
    )
    const createdAt = optionalProviderIso(
      providerReturn.createdAt ?? providerReturn.created_at
        ?? providerReturn.requested_at,
      'Provider return time',
    )
    if (!createdAt) continue
    push({
      externalEventId: id ? `${id}:created` : null,
      externalSubjectId: id,
      eventKind: 'return_created',
      inventoryEffectKind: 'unknown',
      attributionSource: 'unavailable',
      occurredAt: createdAt,
    })

    if (provider === 'shopify') {
      const approvedAt = optionalProviderIso(
        providerReturn.requestApprovedAt,
        'Shopify return approval time',
      )
      const closedAt = optionalProviderIso(
        providerReturn.closedAt,
        'Shopify return close time',
      )
      // These are milestone facts, not snapshots of the Return's current
      // status. A return can be reopened after closedAt, so stamping the later
      // status onto the older milestone would rewrite history.
      if (approvedAt) {
        push({
          externalEventId: id ? `${id}:approved:${approvedAt}` : null,
          externalSubjectId: id,
          eventKind: 'return_updated',
          eventStatus: 'approved',
          inventoryEffectKind: 'unknown',
          attributionSource: 'unavailable',
          occurredAt: approvedAt,
        })
      }
      if (closedAt) {
        push({
          externalEventId: id ? `${id}:closed:${closedAt}` : null,
          externalSubjectId: id,
          eventKind: 'return_updated',
          eventStatus: 'closed',
          inventoryEffectKind: 'unknown',
          attributionSource: 'unavailable',
          occurredAt: closedAt,
        })
      }
      const state = exactString(providerReturn.status)
      const quantity = normalizeCommerceHistoryProviderQuantity(
        providerReturn.totalQuantity,
      )
      const stateIdentity = hash({
        id,
        state,
        quantity,
        createdAt,
        approvedAt,
        closedAt,
      })
      push({
        externalEventId: id
          ? `${id}:state-observed:${stateIdentity.slice(0, 24)}`
          : null,
        externalSubjectId: id,
        eventKind: 'return_state_observed',
        eventStatus: state,
        quantity,
        inventoryEffectKind: 'unknown',
        attributionSource: 'provider_system',
        occurredAt: observedAt,
      })
      continue
    }

    const updatedAt = optionalProviderIso(
      providerReturn.updated_at ?? providerReturn.updatedAt,
      'Faire return update time',
    )
    const hasMutableReturnFacts = (
      providerReturn.status !== null && providerReturn.status !== undefined
    ) || (
      providerReturn.state !== null && providerReturn.state !== undefined
    ) || (
      providerReturn.total_quantity !== null
        && providerReturn.total_quantity !== undefined
    ) || (
      providerReturn.totalQuantity !== null
        && providerReturn.totalQuantity !== undefined
    )
    if (hasMutableReturnFacts && !updatedAt) {
      providerResponseInvalid('Faire return update time')
    }
    if (updatedAt) {
      push({
        externalEventId:
          `${id || order.identity.value}:state:${updatedAt}`,
        externalSubjectId: id,
        eventKind: 'return_updated',
        eventStatus: exactString(
          providerReturn.status ?? providerReturn.state,
        ),
        quantity: normalizeCommerceHistoryProviderQuantity(
          providerReturn.totalQuantity ?? providerReturn.total_quantity,
        ),
        inventoryEffectKind: 'unknown',
        attributionSource: 'unavailable',
        occurredAt: updatedAt,
      })
    }
  }
  return events
}

export function privacyMinimizedCommerceOrderEventEvidence(
  event: CommerceOrderEventObservationInput,
) {
  return Object.fromEntries(Object.entries(event).filter(([key]) => (
    key !== 'trackingNumber'
      && key !== 'providerActorFingerprint'
      && !(
        event.eventKind === 'return_state_observed'
          && key === 'occurredAt'
      )
  )))
}

export function commerceOrderHistoryObservation(
  provider: 'shopify' | 'faire',
  order: CommerceNormalizedOrder,
  source: JsonRecord,
  observedAt: string,
  providerReadCount: number,
  observationKind:
    | 'historical_backfill'
    | 'scheduled_poll'
    | 'webhook_exact_read'
    | 'manual_exact_read',
): CommerceOrderObservationInput {
  const orderMoney = money(order)
  const returnedQuantities = provider === 'shopify'
    ? shopifyOrderHistoryReturnedQuantities(source)
    : new Map<string, number>()
  const events = providerEvents(
    provider,
    order,
    source,
    observedAt,
  )
  const minimized = {
    externalOrderId: order.identity.value,
    orderNumber: order.orderNumber,
    providerCreatedAt: order.providerCreatedAt,
    providerProcessedAt: order.providerProcessedAt,
    providerUpdatedAt: order.providerUpdatedAt,
    providerCancelledAt: order.providerCancelledAt,
    providerClosedAt: order.providerClosedAt,
    rawStates: order.rawStates,
    canonicalStates: order.canonicalStates,
    money: orderMoney,
    lines: order.lines.map((line) => ({
      id: line.identity.value,
      product: line.productIdentity.state === 'available'
        ? line.productIdentity.value.value
        : null,
      variant: line.variantIdentity.state === 'available'
        ? line.variantIdentity.value.value
        : null,
      sku: line.sku,
      title: line.titleSnapshot,
      variantTitle: line.variantTitleSnapshot,
      vendor: line.vendorSnapshot,
      ordered: line.orderedQuantity,
      current: line.currentQuantity,
      unfulfilled: line.unfulfilledQuantity,
      fulfilled: line.fulfilledQuantity,
      returned: returnedQuantities.get(line.identity.value)
        ?? line.returnedQuantity,
      requiresShipping: line.requiresShipping,
      unitPrice: lineMoney(line.unitPrice),
      subtotal: lineMoney(line.lineSubtotal),
      discount: lineMoney(line.lineDiscount),
      tax: lineMoney(line.lineTax),
    })),
    events: events.map(privacyMinimizedCommerceOrderEventEvidence),
  }
  return {
    observationKind,
    externalOrderId: order.identity.value,
    orderNumber: order.orderNumber,
    sourceRevision: order.providerUpdatedAt || order.providerCreatedAt
      || `provider:${hash(minimized).slice(0, 24)}`,
    sourceHash: hash(minimized),
    rawLifecycleState: order.rawStates.lifecycle,
    rawPaymentState: order.rawStates.payment,
    rawFulfillmentState: order.rawStates.fulfillment,
    rawReturnState: order.rawStates.returns,
    canonicalLifecycleState: order.canonicalStates.lifecycle,
    canonicalPaymentState: order.canonicalStates.payment,
    canonicalFulfillmentState: order.canonicalStates.fulfillment === 'scheduled'
      ? 'on_hold'
      : order.canonicalStates.fulfillment,
    canonicalReturnState: order.canonicalStates.returns,
    currency: orderMoney.currency,
    providerTotalMinor: orderMoney.minor,
    providerInventoryReservationState: provider === 'shopify'
      ? source.confirmed === true
        ? 'reported_reserved'
        : source.confirmed === false
          ? 'reported_not_reserved'
          : 'unavailable'
      : 'unavailable',
    providerCreatedAt: order.providerCreatedAt,
    providerProcessedAt: order.providerProcessedAt,
    providerUpdatedAt: order.providerUpdatedAt,
    providerCancelledAt: order.providerCancelledAt,
    providerClosedAt: order.providerClosedAt,
    observedAt,
    providerReadCount,
    lines: minimized.lines.map((line) => ({
      externalLineId: line.id,
      externalProductId: line.product,
      externalVariantId: line.variant,
      sku: line.sku,
      titleSnapshot: line.title,
      variantTitleSnapshot: line.variantTitle,
      vendorSnapshot: line.vendor,
      originalQuantity: line.ordered,
      currentQuantity: line.current,
      unfulfilledQuantity: line.unfulfilled,
      fulfilledQuantity: line.fulfilled,
      returnedQuantity: line.returned,
      requiresShipping: line.requiresShipping,
      unitPriceCurrency: line.unitPrice?.currency || null,
      unitPriceMinor: line.unitPrice?.amountMinor ?? null,
      subtotalCurrency: line.subtotal?.currency || null,
      subtotalMinor: line.subtotal?.amountMinor ?? null,
      discountCurrency: line.discount?.currency || null,
      discountMinor: line.discount?.amountMinor ?? null,
      taxCurrency: line.tax?.currency || null,
      taxMinor: line.tax?.amountMinor ?? null,
    })),
    events,
  }
}

export function shopifyHistoricalOrderSearchWindow(input: {
  requestedFrom: string | null
  requestedThrough: string
  mode?: 'historical_backfill' | 'continuous_poll'
}) {
  const from = requiredIso(input.requestedFrom, 'Shopify historical start time')
  const through = requiredIso(input.requestedThrough, 'Shopify historical end time')
  const duration = new Date(through).getTime() - new Date(from).getTime()
  if (duration < 0 || duration > SIXTY_DAYS_MS) {
    historyError(
      'SHOPIFY_ORDER_HISTORY_WINDOW_INVALID',
      'Shopify history v1 requires one fixed window of no more than 60 days',
      400,
    )
  }
  return input.mode === 'continuous_poll'
    ? `status:any updated_at:>='${from}' updated_at:<='${through}'`
    : `status:any created_at:>='${from}' created_at:<='${through}'`
}

export function assertShopifyOrderHistoryWindowAccessible(input: {
  requestedFrom: string
  requestedThrough: string
  observedAt: string
  readAllOrdersGranted: boolean
}) {
  if (input.readAllOrdersGranted) return
  requiredIso(input.requestedFrom, 'Shopify history start')
  const through = new Date(requiredIso(
    input.requestedThrough,
    'Shopify history end',
  ))
  const observed = new Date(requiredIso(input.observedAt, 'Observation time'))
  const queueAge = observed.getTime() - through.getTime()
  if (queueAge < 0 || queueAge > SHOPIFY_READ_ORDERS_QUEUE_SLA_MS) {
    historyError(
      'SHOPIFY_ORDER_HISTORY_READ_ORDERS_QUEUE_SLA_EXCEEDED',
      'The exact 60-day Shopify read_orders attempt missed its bounded execution window',
      409,
    )
  }
}

export function shopifyOrderHistoryListQuery(
  mode: 'historical_backfill' | 'continuous_poll' = 'historical_backfill',
) {
  const sortKey = mode === 'continuous_poll' ? 'UPDATED_AT' : 'CREATED_AT'
  return `query ClawPilotCommerceOrderHistoryIds($after: String, $query: String!) {
  orders(first: ${SHOPIFY_PAGE_SIZE}, after: $after, query: $query, sortKey: ${sortKey}, reverse: false) {
    nodes { id createdAt updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`
}

export function shopifyOrderHistoryDetailQuery(includeReturns: boolean) {
  return `query ClawPilotCommerceOrderHistoryDetail($id: ID!) {
  order(id: $id) {
    id name createdAt processedAt updatedAt cancelledAt closedAt confirmed
    displayFinancialStatus displayFulfillmentStatus returnStatus currencyCode
    currentSubtotalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
    currentShippingPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
    currentTotalTaxSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
    currentTotalDiscountsSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
    currentTotalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
    lineItems(first: ${SHOPIFY_LINE_LIMIT + 1}) {
      nodes {
        id title variantTitle sku vendor quantity currentQuantity unfulfilledQuantity requiresShipping
        originalUnitPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        originalTotalSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        discountedTotalSet(withCodeDiscounts: true) { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        totalDiscountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        unfulfilledOriginalTotalSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        unfulfilledDiscountedTotalSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        product { id } variant { id }
      }
      pageInfo { hasNextPage endCursor }
    }
    fulfillments(first: ${SHOPIFY_FULFILLMENT_LIMIT + 1}) {
      id name status displayStatus createdAt updatedAt deliveredAt inTransitAt
      location { id }
      trackingInfo(first: ${SHOPIFY_TRACKING_LIMIT + 1}) { company number url }
    }
    refunds {
      id createdAt processedAt updatedAt
      totalRefundedSet { shopMoney { amount currencyCode } }
      refundLineItems(first: ${SHOPIFY_ADJUSTMENT_LINE_LIMIT + 1}) {
        nodes { quantity restockType lineItem { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
    ${includeReturns ? `returns(first: ${SHOPIFY_RETURN_LIMIT + 1}) {
      nodes {
        id name status createdAt closedAt requestApprovedAt totalQuantity
        returnLineItems(first: ${SHOPIFY_ADJUSTMENT_LINE_LIMIT + 1}) {
          nodes {
            __typename id quantity processedQuantity refundedQuantity
            ... on ReturnLineItem {
              fulfillmentLineItem { lineItem { id } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage }
    }` : ''}
  }
}`
}

function strictMoneyFact(
  value: unknown,
  label: string,
  options: { required?: boolean; requireShopMoney?: boolean } = {},
) {
  if ((value === null || value === undefined) && options.required) {
    providerResponseInvalid(label)
  }
  if (value === null || value === undefined) return
  const moneySet = asRecord(value)
  if (!moneySet) providerResponseInvalid(label)
  let moneyCount = 0
  for (const key of ['shopMoney', 'presentmentMoney'] as const) {
    if (moneySet[key] === null || moneySet[key] === undefined) continue
    moneyCount += 1
    const money = asRecord(moneySet[key])
    if (!money) providerResponseInvalid(`${label} ${key}`)
    const amount = money.amount
    if (
      !(
        (typeof amount === 'number' && Number.isFinite(amount))
        || (typeof amount === 'string' && /^-?\d+(?:\.\d+)?$/u.test(amount))
      )
      || !/^[A-Z]{3}$/u.test(exactString(money.currencyCode) || '')
    ) {
      providerResponseInvalid(`${label} ${key}`)
    }
  }
  if (moneyCount < 1) providerResponseInvalid(label)
  if (options.requireShopMoney && !asRecord(moneySet.shopMoney)) {
    providerResponseInvalid(`${label} shopMoney`)
  }
}

export function assertShopifyOrderHistoryDetailEvidence(
  order: unknown,
  includeReturns: boolean,
) {
  const source = asRecord(order)
  if (!source) providerResponseInvalid('Shopify historical-order detail')
  strictRequiredTextFact(source.id, 'Shopify order identity')
  strictRequiredTextFact(source.name, 'Shopify order number')
  strictRequiredTextFact(source.createdAt, 'Shopify order creation time')
  strictRequiredTextFact(source.updatedAt, 'Shopify order update time')
  if (typeof source.confirmed !== 'boolean') {
    providerResponseInvalid('Shopify reservation signal')
  }
  for (const [key, label] of [
    ['createdAt', 'creation'],
    ['updatedAt', 'update'], ['cancelledAt', 'cancellation'],
    ['closedAt', 'close'],
  ] as const) {
    strictOptionalIsoFact(source[key], `Shopify order ${label} time`)
  }
  requiredIso(source.processedAt, 'Shopify order processing time')
  strictRequiredTextFact(source.currencyCode, 'Shopify order currencyCode')
  strictRequiredTextFact(
    source.displayFulfillmentStatus,
    'Shopify order displayFulfillmentStatus',
  )
  strictRequiredTextFact(source.returnStatus, 'Shopify order returnStatus')
  strictOptionalTextFact(
    source.displayFinancialStatus,
    'Shopify order displayFinancialStatus',
  )
  for (const key of [
    'currentSubtotalPriceSet', 'currentShippingPriceSet',
    'currentTotalTaxSet', 'currentTotalDiscountsSet', 'currentTotalPriceSet',
  ] as const) {
    strictMoneyFact(source[key], `Shopify order ${key}`, {
      required: true,
      requireShopMoney: true,
    })
  }

  const lines = strictConnection(source.lineItems, 'Shopify order lines')
  if (lines.values.length > SHOPIFY_LINE_LIMIT || lines.hasNextPage) {
    historyError(
      'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
      'A Shopify historical order exceeds the bounded line-item page',
      409,
    )
  }
  for (const line of lines.values) {
    strictRequiredTextFact(line.id, 'Shopify order-line identity')
    strictRequiredTextFact(line.title, 'Shopify order-line title')
    for (const key of ['sku', 'vendor', 'variantTitle'] as const) {
      strictOptionalTextFact(line[key], `Shopify order-line ${key}`)
    }
    for (const key of ['quantity', 'currentQuantity', 'unfulfilledQuantity'] as const) {
      if (normalizeCommerceHistoryProviderQuantity(line[key]) === null) {
        providerResponseInvalid(`Shopify order-line ${key}`)
      }
    }
    if (typeof line.requiresShipping !== 'boolean') {
      providerResponseInvalid('Shopify order-line requires-shipping fact')
    }
    for (const key of ['product', 'variant'] as const) {
      if (line[key] === null || line[key] === undefined) continue
      const identity = asRecord(line[key])
      if (!identity) providerResponseInvalid(`Shopify order-line ${key}`)
      strictRequiredTextFact(identity.id, `Shopify order-line ${key} identity`)
    }
    for (const key of [
      'originalUnitPriceSet', 'originalTotalSet', 'discountedTotalSet',
      'totalDiscountSet', 'unfulfilledOriginalTotalSet',
      'unfulfilledDiscountedTotalSet',
    ] as const) {
      strictMoneyFact(line[key], `Shopify order-line ${key}`, {
        required: true,
        requireShopMoney: true,
      })
    }
  }

  const fulfillments = strictRecordArray(
    source.fulfillments,
    'Shopify fulfillment rows',
  )
  if (fulfillments.length > SHOPIFY_FULFILLMENT_LIMIT) {
    historyError(
      'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
      'A Shopify historical order exceeds the bounded fulfillment page',
      409,
    )
  }
  for (const fulfillment of fulfillments) {
    strictRequiredTextFact(fulfillment.id, 'Shopify fulfillment identity')
    for (const key of ['status', 'displayStatus'] as const) {
      strictOptionalTextFact(fulfillment[key], `Shopify fulfillment ${key}`)
    }
    strictRequiredIsoFact(
      fulfillment.updatedAt,
      'Shopify fulfillment update time',
    )
    for (const key of ['createdAt', 'deliveredAt', 'inTransitAt'] as const) {
      strictOptionalIsoFact(fulfillment[key], `Shopify fulfillment ${key}`)
    }
    const tracking = strictRecordArray(
      fulfillment.trackingInfo,
      'Shopify fulfillment tracking rows',
    )
    if (tracking.length > SHOPIFY_TRACKING_LIMIT) {
      historyError(
        'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
        'A Shopify fulfillment exceeds the bounded tracking page',
        409,
      )
    }
    for (const item of tracking) {
      strictOptionalTextFact(item.company, 'Shopify tracking carrier')
      strictOptionalTextFact(item.number, 'Shopify tracking number')
      strictOptionalTextFact(item.url, 'Shopify tracking URL')
    }
  }

  const refunds = strictRecordArray(source.refunds, 'Shopify refund rows')
  assertCollectionLimit(refunds, SHOPIFY_REFUND_LIMIT, 'Shopify refund rows')
  for (const refund of refunds) {
    strictRequiredTextFact(refund.id, 'Shopify refund identity')
    strictOptionalIsoFact(refund.createdAt, 'Shopify refund createdAt')
    strictRequiredIsoFact(refund.processedAt, 'Shopify refund processedAt')
    strictRequiredIsoFact(refund.updatedAt, 'Shopify refund updatedAt')
    strictMoneyFact(refund.totalRefundedSet, 'Shopify refund total', {
      required: true,
      requireShopMoney: true,
    })
    const refundLines = strictConnection(
      refund.refundLineItems,
      'Shopify refund line rows',
    )
    if (
      refundLines.values.length > SHOPIFY_ADJUSTMENT_LINE_LIMIT
      || refundLines.hasNextPage
    ) {
      historyError(
        'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
        'A Shopify refund exceeds the bounded line-item page',
        409,
      )
    }
    for (const line of refundLines.values) {
      if (normalizeCommerceHistoryProviderQuantity(line.quantity) === null) {
        providerResponseInvalid('Shopify refund line quantity')
      }
      strictRequiredTextFact(line.restockType, 'Shopify refund restock type')
      const lineItem = asRecord(line.lineItem)
      if (!lineItem) providerResponseInvalid('Shopify refund order line')
      strictRequiredTextFact(lineItem.id, 'Shopify refund order-line identity')
    }
  }

  const returns = strictConnection(
    source.returns,
    'Shopify return rows',
    { optional: !includeReturns },
  )
  if (returns.values.length > SHOPIFY_RETURN_LIMIT || returns.hasNextPage) {
    historyError(
      'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
      'A Shopify historical order exceeds the bounded return page',
      409,
    )
  }
  for (const providerReturn of returns.values) {
    strictRequiredTextFact(providerReturn.id, 'Shopify return identity')
    strictRequiredTextFact(providerReturn.name, 'Shopify return name')
    strictRequiredTextFact(providerReturn.status, 'Shopify return status')
    if (normalizeCommerceHistoryProviderQuantity(
      providerReturn.totalQuantity,
    ) === null) {
      providerResponseInvalid('Shopify return total quantity')
    }
    strictRequiredIsoFact(providerReturn.createdAt, 'Shopify return createdAt')
    for (const key of ['closedAt', 'requestApprovedAt'] as const) {
      strictOptionalIsoFact(providerReturn[key], `Shopify return ${key}`)
    }
    const returnLines = strictConnection(
      providerReturn.returnLineItems,
      'Shopify return line rows',
    )
    if (
      returnLines.values.length > SHOPIFY_ADJUSTMENT_LINE_LIMIT
      || returnLines.hasNextPage
    ) {
      historyError(
        'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
        'A Shopify return exceeds the bounded line-item page',
        409,
      )
    }
    for (const line of returnLines.values) {
      strictRequiredTextFact(line.__typename, 'Shopify return line type')
      strictRequiredTextFact(line.id, 'Shopify return line identity')
      for (const key of [
        'quantity', 'processedQuantity', 'refundedQuantity',
      ] as const) {
        if (normalizeCommerceHistoryProviderQuantity(line[key]) === null) {
          providerResponseInvalid(`Shopify return line ${key}`)
        }
      }
      if (line.__typename === 'ReturnLineItem') {
        const fulfillmentLine = asRecord(line.fulfillmentLineItem)
        const orderLine = asRecord(fulfillmentLine?.lineItem)
        if (!orderLine) providerResponseInvalid('Shopify return order line')
        strictRequiredTextFact(
          orderLine.id,
          'Shopify return order-line identity',
        )
      }
    }
  }
  return source
}

export function assertFaireOrderHistoryDetailEvidence(order: unknown) {
  const source = asRecord(order)
  if (!source) providerResponseInvalid('Faire historical-order detail')
  strictRequiredTextFact(source.id ?? source.order_id, 'Faire order identity')
  strictRequiredTextFact(source.created_at, 'Faire order creation time')
  strictRequiredTextFact(source.updated_at, 'Faire order update time')
  for (const key of ['display_id', 'order_number'] as const) {
    strictOptionalTextFact(source[key], `Faire order ${key}`)
  }
  for (const key of [
    'state', 'status', 'payment_state', 'financial_status',
    'fulfillment_state', 'return_state',
  ] as const) {
    strictOptionalTextFact(source[key], `Faire order ${key}`)
  }
  for (const key of [
    'created_at', 'processing_at', 'processed_at', 'updated_at',
    'cancelled_at', 'delivered_at', 'closed_at',
  ] as const) {
    strictOptionalIsoFact(source[key], `Faire order ${key}`)
  }
  const items = strictRecordArray(
    source.items ?? source.order_items,
    'Faire order-item rows',
  )
  assertCollectionLimit(items, FAIRE_LINE_LIMIT, 'Faire order-item rows')
  for (const line of items) {
    strictRequiredTextFact(line.id ?? line.order_item_id, 'Faire order-line identity')
    if (normalizeCommerceHistoryProviderQuantity(line.quantity) === null) {
      providerResponseInvalid('Faire order-line quantity')
    }
    strictOptionalBooleanFact(
      line.requires_shipping,
      'Faire order-line requires-shipping fact',
    )
    for (const key of ['state', 'status', 'sku'] as const) {
      strictOptionalTextFact(line[key], `Faire order-line ${key}`)
    }
  }
  for (const key of ['shipments', 'fulfillments', 'refunds', 'returns'] as const) {
    const values = strictRecordArray(
      source[key],
      `Faire ${key} rows`,
      { optional: true },
    )
    assertCollectionLimit(
      values,
      FAIRE_LIFECYCLE_COLLECTION_LIMIT,
      `Faire ${key} rows`,
    )
    for (const value of values) {
      strictRequiredTextFact(
        value.id ?? value.shipment_id ?? value.fulfillment_id
          ?? value.refund_id ?? value.return_id,
        `Faire ${key} identity`,
      )
      for (const timestampKey of [
        'created_at', 'updated_at', 'processed_at', 'shipped_at',
        'delivered_at', 'requested_at',
      ] as const) {
        strictOptionalIsoFact(
          value[timestampKey],
          `Faire ${key} ${timestampKey}`,
        )
      }
      for (const textKey of ['state', 'status', 'carrier', 'carrier_name'] as const) {
        strictOptionalTextFact(value[textKey], `Faire ${key} ${textKey}`)
      }
      for (const nestedKey of [
        'trackingInfo', 'tracking_info', 'tracking_numbers',
      ] as const) {
        if (value[nestedKey] === null || value[nestedKey] === undefined) continue
        const tracking = strictRecordArray(
          value[nestedKey],
          `Faire ${key} tracking rows`,
        )
        assertCollectionLimit(
          tracking,
          FAIRE_TRACKING_LIMIT,
          `Faire ${key} tracking rows`,
        )
        for (const item of tracking) {
          strictOptionalTextFact(
            item.number ?? item.tracking_number ?? item.tracking_code,
            `Faire ${key} tracking number`,
          )
          strictOptionalTextFact(
            item.company ?? item.carrier,
            `Faire ${key} tracking carrier`,
          )
        }
      }
      for (const nestedKey of [
        'items', 'refundLineItems', 'fulfillmentLineItems',
      ] as const) {
        if (value[nestedKey] === null || value[nestedKey] === undefined) continue
        const nested = strictRecordArray(
          value[nestedKey],
          `Faire ${key} item rows`,
        )
        assertCollectionLimit(
          nested,
          FAIRE_NESTED_ITEM_LIMIT,
          `Faire ${key} item rows`,
        )
        for (const item of nested) {
          strictOptionalQuantityFact(
            item.quantity,
            `Faire ${key} item quantity`,
          )
        }
      }
      strictOptionalTextFact(
        value.tracking_number ?? value.trackingNumber ?? value.tracking_code,
        `Faire ${key} tracking number`,
      )
      strictOptionalTextFact(value.staff_id, `Faire ${key} staff identity`)
      if (value.totalRefundedSet !== null && value.totalRefundedSet !== undefined) {
        strictMoneyFact(value.totalRefundedSet, `Faire ${key} total`)
      }
      for (const moneyKey of ['amount_cents', 'total_cents'] as const) {
        if (value[moneyKey] === null || value[moneyKey] === undefined) continue
        if (
          typeof value[moneyKey] !== 'number'
          || !Number.isSafeInteger(value[moneyKey])
        ) {
          providerResponseInvalid(`Faire ${key} ${moneyKey}`)
        }
      }
      for (const currencyKey of ['currency', 'currency_code'] as const) {
        if (value[currencyKey] === null || value[currencyKey] === undefined) continue
        if (!/^[A-Z]{3}$/u.test(exactString(value[currencyKey]) || '')) {
          providerResponseInvalid(`Faire ${key} ${currencyKey}`)
        }
      }
      if (key === 'returns') {
        strictRequiredIsoFact(
          value.created_at ?? value.requested_at,
          'Faire return creation time',
        )
        const hasMutableReturnFacts = (
          value.status !== null && value.status !== undefined
        ) || (
          value.state !== null && value.state !== undefined
        ) || (
          value.total_quantity !== null && value.total_quantity !== undefined
        ) || (
          value.totalQuantity !== null && value.totalQuantity !== undefined
        )
        if (hasMutableReturnFacts) {
          strictRequiredIsoFact(value.updated_at, 'Faire return update time')
        }
        strictOptionalQuantityFact(
          value.total_quantity ?? value.totalQuantity,
          'Faire return total quantity',
        )
      }
    }
  }
  return source
}

function context(runtime: CommerceRuntimeCredentialRecord, observedAt: string) {
  return {
    organizationId: runtime.organizationId,
    integrationAccountId: runtime.integrationAccountId,
    externalAccountId: runtime.externalAccountId,
    apiVersion: runtime.provider === 'shopify' ? '2026-07' : 'v2',
    observedAt,
    credentialGeneration: runtime.credentialVersion,
    retentionExpiresAt: new Date(
      new Date(observedAt).getTime() + 30 * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    sourceState: 'stale',
  } satisfies CommerceNormalizationContext
}

async function runtimeFor(input: Pick<
  CommerceOrderHistoryPageInput,
  'organizationId' | 'accountGlobalId' | 'expectedCredentialGeneration'
>) {
  const runtime = await readCommerceRuntimeCredentialFromPostgres({
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
  })
  if (
    !runtime
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
    || runtime.credentialVersion !== input.expectedCredentialGeneration
    || (runtime.provider === 'shopify'
      && runtime.authMode !== 'shopify_client_credentials')
    || (runtime.provider === 'faire'
      && !['faire_brand_token', 'faire_oauth'].includes(runtime.authMode))
  ) {
    historyError(
      'COMMERCE_ORDER_HISTORY_ACCOUNT_INELIGIBLE',
      'The exact verified commerce connection changed before history was read',
    )
  }
  return runtime
}

export function shopifyOrderHistoryPageEvidence(
  value: unknown,
  current: string | null = null,
) {
  const connection = strictConnection(value, 'Shopify historical-order page')
  if (connection.values.length > SHOPIFY_PAGE_SIZE) {
    providerResponseInvalid('Shopify historical-order page size')
  }
  const identities = connection.values.map((order) => exactString(order.id))
  if (
    identities.some((identity) => !identity)
    || new Set(identities).size !== identities.length
  ) {
    providerResponseInvalid('Shopify historical-order identities')
  }
  if (connection.hasNextPage && !connection.endCursor) {
    providerResponseInvalid('Shopify historical-order continuation')
  }
  // Shopify's final-page endCursor is the final edge identity, not a promise of
  // another page. It is type-checked above but ignored when hasNextPage=false.
  return {
    orders: connection.values,
    nextCursor: connection.hasNextPage
      ? boundedCursor(connection.endCursor, current)
      : null,
  }
}

export function faireOrderHistoryPageEvidence(
  value: unknown,
  current: string | null = null,
) {
  const page = asRecord(value)
  if (!page) providerResponseInvalid('Faire historical-order page')
  const orders = strictRecordArray(page.orders, 'Faire historical-order rows')
  if (orders.length > FAIRE_PAGE_SIZE) {
    providerResponseInvalid('Faire historical-order page size')
  }
  const identities = orders.map((order) => exactString(order.id ?? order.order_id))
  if (
    identities.some((identity) => !identity)
    || new Set(identities).size !== identities.length
  ) {
    providerResponseInvalid('Faire historical-order identities')
  }

  const containers: JsonRecord[] = [page]
  for (const key of ['pagination', 'page_info', 'pageInfo'] as const) {
    if (page[key] === null || page[key] === undefined) continue
    const container = asRecord(page[key])
    if (!container) providerResponseInvalid(`Faire ${key}`)
    containers.push(container)
  }
  const flags: boolean[] = []
  const cursors: string[] = []
  for (const container of containers) {
    for (const key of [
      'truncated', 'has_more', 'hasNextPage', 'has_next_page',
    ] as const) {
      if (!Object.hasOwn(container, key)) continue
      if (typeof container[key] !== 'boolean') {
        providerResponseInvalid('Faire historical-order pagination flag')
      }
      flags.push(container[key] as boolean)
    }
    for (const key of ['cursor', 'next_cursor', 'nextCursor'] as const) {
      if (!Object.hasOwn(container, key) || container[key] === null) continue
      const cursor = boundedCursor(container[key], current)
      if (!cursor) providerResponseInvalid('Faire historical-order continuation')
      cursors.push(cursor)
    }
  }
  if (new Set(flags).size > 1 || new Set(cursors).size > 1) {
    providerResponseInvalid('Faire historical-order pagination consistency')
  }
  const hasNext = flags.length ? flags[0] : cursors.length > 0
  if (hasNext && cursors.length < 1) {
    providerResponseInvalid('Faire historical-order continuation')
  }
  if (!hasNext && cursors.length) {
    providerResponseInvalid('Faire final historical-order page')
  }
  return { orders, nextCursor: hasNext ? cursors[0] : null }
}

function completeConnection(values: readonly JsonRecord[]) {
  return { nodes: values, pageInfo: { hasNextPage: false, endCursor: null } }
}

function completeFairePage(page: JsonRecord, values: readonly JsonRecord[]) {
  return {
    ...page,
    orders: values,
    truncated: false,
    has_more: false,
    hasNextPage: false,
    cursor: null,
    next_cursor: null,
    nextCursor: null,
    pagination: { has_more: false, hasNextPage: false, cursor: null },
    page_info: null,
    pageInfo: null,
  }
}

function exactFaireBrand(profile: unknown, expected: string) {
  const value = asRecord(profile)
  const identities = [value?.id, value?.brand_id, value?.brandId]
    .filter((entry) => entry !== null && entry !== undefined)
  if (
    identities.length < 1
    || identities.some((entry) => exactString(entry) !== expected)
  ) {
    historyError(
      'COMMERCE_ORDER_HISTORY_ACCOUNT_CHANGED',
      'Faire returned a different brand identity',
    )
  }
}

function assertFaireBrandScope(values: readonly JsonRecord[], expected: string) {
  for (const value of values) {
    const brand = asRecord(value.brand)
    const identities = [value.brand_id, value.brandId, brand?.id]
      .filter((entry) => entry !== null && entry !== undefined)
    if (identities.some((entry) => exactString(entry) !== expected)) {
      historyError(
        'COMMERCE_ORDER_HISTORY_ACCOUNT_CHANGED',
        'Faire returned an order for a different brand identity',
      )
    }
  }
}

export function faireOrderHistoryListWindow(input: {
  requestedFrom: string | null
  requestedThrough: string
  mode?: 'historical_backfill' | 'continuous_poll'
}) {
  if (input.mode === 'continuous_poll' && !input.requestedFrom) {
    historyError(
      'FAIRE_ORDER_HISTORY_WINDOW_INVALID',
      'Faire continuous history requires an updated-at overlap start time',
      400,
    )
  }
  const requestedFrom = input.requestedFrom
    ? requiredIso(input.requestedFrom, 'Faire historical start time')
    : null
  const requestedThrough = requiredIso(
    input.requestedThrough,
    'Faire historical end time',
  )
  const duration = requestedFrom
    ? new Date(requestedThrough).getTime() - new Date(requestedFrom).getTime()
    : 0
  if (
    input.mode === 'continuous_poll'
    && requestedFrom
    && (duration < 0 || duration > SIXTY_DAYS_MS)
  ) {
    historyError(
      'FAIRE_ORDER_HISTORY_WINDOW_INVALID',
      'Faire continuous history requires a bounded window of no more than 60 days',
      400,
    )
  }
  return {
    requestedFrom,
    requestedThrough,
    updatedAtMin: input.mode === 'continuous_poll' ? requestedFrom : null,
  }
}

async function readShopifyHistoryPage(
  runtime: CommerceRuntimeCredentialRecord,
  input: CommerceOrderHistoryPageInput,
  observedAt: string,
): Promise<CommerceOrderHistoryPage> {
  if (!input.requestedFrom) {
    historyError(
      'SHOPIFY_ORDER_HISTORY_WINDOW_INVALID',
      'Shopify history requires a fixed rolling 60-day start time',
      400,
    )
  }
  const search = shopifyHistoricalOrderSearchWindow(input)
  const secret = decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (secret.provider !== 'shopify') {
    historyError('COMMERCE_ORDER_HISTORY_CREDENTIAL_INVALID', 'The credential provider changed')
  }
  const shopDomain = normalizeShopifyShopDomain(runtime.configuration.shopDomain)
  const grant = await requestShopifyAccessToken({
    shopDomain,
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
  }, { timeoutMs: PROVIDER_TIMEOUT_MS })
  const credential = { shopDomain, accessToken: grant.accessToken }
  const probe = await probeShopifyConnection(credential, {
    timeoutMs: PROVIDER_TIMEOUT_MS,
  })
  if (probe.shopId !== runtime.externalAccountId) {
    historyError(
      'COMMERCE_ORDER_HISTORY_ACCOUNT_CHANGED',
      'Shopify returned a different store identity',
    )
  }
  const readOrders = hasEffectiveShopifyScope(grant.grantedScopes, 'read_orders')
    && hasEffectiveShopifyScope(probe.grantedScopes, 'read_orders')
  if (!readOrders) {
    historyError(
      'SHOPIFY_READ_ORDERS_REQUIRED',
      'Shopify must grant read_orders for the rolling 60-day history window',
    )
  }
  const readAllOrders = hasEffectiveShopifyScope(
    grant.grantedScopes,
    'read_all_orders',
  ) && hasEffectiveShopifyScope(probe.grantedScopes, 'read_all_orders')
  const readReturns = hasEffectiveShopifyScope(grant.grantedScopes, 'read_returns')
    && hasEffectiveShopifyScope(probe.grantedScopes, 'read_returns')
  assertShopifyOrderHistoryWindowAccessible({
    requestedFrom: input.requestedFrom,
    requestedThrough: input.requestedThrough,
    observedAt,
    readAllOrdersGranted: readAllOrders,
  })
  const listData = await shopifyAdminGraphql<JsonRecord>(credential, {
    query: shopifyOrderHistoryListQuery(input.mode),
    operationName: 'ClawPilotCommerceOrderHistoryIds',
    variables: { after: input.providerCursor, query: search },
  }, { timeoutMs: PROVIDER_TIMEOUT_MS })
  const connection = asRecord(listData.orders)
  if (!connection) {
    historyError(
      'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
      'Shopify returned an invalid historical-order page',
      502,
    )
  }
  const listEvidence = shopifyOrderHistoryPageEvidence(
    connection,
    input.providerCursor,
  )
  const listedOrders = listEvidence.orders
  const listedIds = listedOrders.map((entry) => exactString(entry.id))
  if (
    listedIds.some((entry) => !entry)
    || new Set(listedIds).size !== listedIds.length
  ) {
    historyError(
      'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
      'Shopify returned invalid historical-order identities',
      502,
    )
  }
  const sourceOrders: JsonRecord[] = []
  for (const listedId of listedIds as string[]) {
    const detailData = await shopifyAdminGraphql<JsonRecord>(credential, {
      query: shopifyOrderHistoryDetailQuery(readReturns),
      operationName: 'ClawPilotCommerceOrderHistoryDetail',
      variables: { id: listedId },
    }, { timeoutMs: PROVIDER_TIMEOUT_MS })
    const order = asRecord(detailData.order)
    if (!order || exactString(order.id) !== listedId) {
      historyError(
        'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
        'Shopify exact-order history hydration changed identity',
        502,
      )
    }
    sourceOrders.push(order)
  }
  sourceOrders.forEach((order) => {
    assertShopifyOrderHistoryDetailEvidence(order, readReturns)
  })
  const throughTime = new Date(input.requestedThrough).getTime()
  const windowSourceOrders = input.mode === 'continuous_poll'
    ? sourceOrders.filter((order) => {
        const updatedAt = optionalProviderIso(
          order.updatedAt,
          'Shopify hydrated order update time',
        )
        // Exact hydration can race past the sealed list high-water. Advance the
        // deterministic list cursor, but leave that newer revision for the next
        // overlapping scheduled poll.
        return updatedAt !== null
          && new Date(updatedAt).getTime() <= throughTime
      })
    : sourceOrders
  const normalized = normalizeShopifyCommerce({
    data: {
      products: completeConnection([]),
      orders: completeConnection(windowSourceOrders),
    },
    shopDomain,
  }, context(runtime, observedAt))
  if (
    normalized.rejections.length
    || normalized.orders.some((order) => order.lineItemsTruncated)
  ) {
    historyError(
      'COMMERCE_ORDER_HISTORY_NORMALIZATION_REJECTED',
      'A Shopify historical order could not be normalized without loss',
      409,
    )
  }
  const sourceById = new Map(
    windowSourceOrders.map((entry) => [exactString(entry.id), entry]),
  )
  return {
    provider: 'shopify',
    observations: normalized.orders.map((order) => commerceOrderHistoryObservation(
      'shopify',
      order,
      sourceById.get(order.identity.value) || {},
      observedAt,
      3 + sourceOrders.length,
      input.mode === 'continuous_poll'
        ? 'scheduled_poll'
        : 'historical_backfill',
    )),
    nextProviderCursor: listEvidence.nextCursor,
    providerRowsSeen: listedOrders.length,
    providerReads: 3 + sourceOrders.length,
    providerWrites: 0,
    readAllOrdersScopeObserved: readAllOrders,
    returnHistoryScopeObserved: readReturns,
  }
}

async function readFaireHistoryPage(
  runtime: CommerceRuntimeCredentialRecord,
  input: CommerceOrderHistoryPageInput,
  observedAt: string,
): Promise<CommerceOrderHistoryPage> {
  const { requestedFrom, requestedThrough, updatedAtMin } =
    faireOrderHistoryListWindow(input)
  const secret = decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (secret.provider !== 'faire') {
    historyError('COMMERCE_ORDER_HISTORY_CREDENTIAL_INVALID', 'The credential provider changed')
  }
  if (secret.authMode === 'faire_oauth' && !secret.scopes.includes('READ_ORDERS')) {
    historyError(
      'FAIRE_READ_ORDERS_REQUIRED',
      'Faire must grant READ_ORDERS for provider-available order history',
    )
  }
  const options = secret.authMode === 'faire_oauth'
    ? {
        accessToken: secret.accessToken,
        applicationId: secret.applicationId,
        applicationSecret: secret.applicationSecret,
        timeoutMs: PROVIDER_TIMEOUT_MS,
      }
    : { accessToken: secret.accessToken, timeoutMs: PROVIDER_TIMEOUT_MS }
  exactFaireBrand(await probeFaireBrandProfile(options), runtime.externalAccountId)
  const page = asRecord(await listFaireOrders(options, {
    cursor: input.providerCursor,
    updatedAtMin,
    limit: FAIRE_PAGE_SIZE,
  }))
  if (!page) {
    historyError(
      'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
      'Faire returned an invalid historical-order page',
      502,
    )
  }
  const pageEvidence = faireOrderHistoryPageEvidence(page, input.providerCursor)
  const sourceOrders = pageEvidence.orders
  const sourceIds = sourceOrders.map((entry) => exactString(
    entry.id ?? entry.order_id,
  ))
  if (
    sourceIds.some((entry) => !entry)
    || new Set(sourceIds).size !== sourceIds.length
  ) {
    providerResponseInvalid('Faire historical-order identities')
  }
  sourceOrders.forEach(assertFaireOrderHistoryDetailEvidence)
  assertFaireBrandScope(sourceOrders, runtime.externalAccountId)
  const normalized = normalizeFaireCommerce({
    brand: { id: runtime.externalAccountId },
    orders: completeFairePage(page, sourceOrders),
    products: completeFairePage({ products: [] }, []),
  }, context(runtime, observedAt))
  if (
    normalized.rejections.length
    || normalized.orders.some((order) => order.lineItemsTruncated)
  ) {
    historyError(
      'COMMERCE_ORDER_HISTORY_NORMALIZATION_REJECTED',
      'A Faire historical order could not be normalized without loss',
      409,
    )
  }
  const fromTime = requestedFrom ? new Date(requestedFrom).getTime() : null
  const throughTime = new Date(requestedThrough).getTime()
  const windowOrders = normalized.orders.filter((order) => {
    if (input.mode !== 'continuous_poll') return true
    if (!order.providerUpdatedAt || fromTime === null) {
      historyError(
        'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
        'Faire returned an order without the updated-at fact required by the fixed window',
        502,
      )
    }
    const updatedAt = new Date(order.providerUpdatedAt).getTime()
    if (updatedAt < fromTime) {
      historyError(
        'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
        'Faire returned an order before the requested updated-at boundary',
        502,
      )
    }
    // Faire exposes updated_at_min but no matching upper-bound parameter. Rows
    // that moved after this session's sealed high-water are left for the next
    // overlapping poll instead of being attributed to the earlier window.
    return updatedAt <= throughTime
  })
  const sourceById = new Map(sourceOrders.map((entry) => [
    exactString(entry.id ?? entry.order_id),
    entry,
  ]))
  return {
    provider: 'faire',
    observations: windowOrders.map((order) => commerceOrderHistoryObservation(
      'faire',
      order,
      sourceById.get(order.identity.value) || {},
      observedAt,
      2,
      input.mode === 'continuous_poll'
        ? 'scheduled_poll'
        : 'historical_backfill',
    )),
    nextProviderCursor: pageEvidence.nextCursor,
    providerRowsSeen: sourceOrders.length,
    providerReads: 2,
    providerWrites: 0,
    readAllOrdersScopeObserved: null,
    returnHistoryScopeObserved: null,
  }
}

/**
 * Performs one exact-account provider-read page only. It does not persist a
 * cursor, promote into operations_orders, mutate inventory, or call a provider
 * write. The worker must seal the returned cursor on the exact sync session
 * before acknowledging the page.
 */
export async function readCommerceOrderHistoryPage(
  input: CommerceOrderHistoryPageInput,
): Promise<CommerceOrderHistoryPage> {
  const observedAt = requiredIso(input.observedAt || new Date().toISOString(), 'Observation time')
  const runtime = await runtimeFor(input)
  return runtime.provider === 'shopify'
    ? readShopifyHistoryPage(runtime, input, observedAt)
    : readFaireHistoryPage(runtime, input, observedAt)
}

/**
 * Reads one exact Shopify Order GID for an explicitly authorized hydration.
 * This path performs token, shop/scope probe, and exact order reads only. It
 * does not list orders, retain the webhook payload, advance a cursor, mutate a
 * provider, or write inventory/canonical Operations state.
 */
export async function readExactShopifyOrderHistoryObservation(
  input: ExactShopifyOrderHistoryInput,
): Promise<ExactShopifyOrderHistoryRead> {
  const observedAt = requiredIso(
    input.observedAt || new Date().toISOString(),
    'Observation time',
  )
  const externalOrderId = exactString(input.externalOrderId)
  if (!externalOrderId
      || !/^gid:\/\/shopify\/Order\/[1-9][0-9]{0,20}$/u.test(externalOrderId)) {
    historyError(
      'SHOPIFY_ORDER_HISTORY_EXACT_ID_INVALID',
      'The exact Shopify Order GID is invalid',
      400,
    )
  }
  const runtime = await runtimeFor(input)
  if (runtime.provider !== 'shopify') {
    historyError(
      'SHOPIFY_ORDER_HISTORY_ACCOUNT_REQUIRED',
      'Exact Shopify order reads require a Shopify connection',
    )
  }
  const secret = decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (secret.provider !== 'shopify') {
    historyError(
      'COMMERCE_ORDER_HISTORY_CREDENTIAL_INVALID',
      'The credential provider changed',
    )
  }
  const shopDomain = normalizeShopifyShopDomain(runtime.configuration.shopDomain)
  let providerReads = 0
  try {
    providerReads += 1
    const grant = await requestShopifyAccessToken({
      shopDomain,
      clientId: secret.clientId,
      clientSecret: secret.clientSecret,
    }, { timeoutMs: PROVIDER_TIMEOUT_MS })
    const credential = { shopDomain, accessToken: grant.accessToken }
    providerReads += 1
    const probe = await probeShopifyConnection(credential, {
      timeoutMs: PROVIDER_TIMEOUT_MS,
    })
    if (probe.shopId !== runtime.externalAccountId) {
      historyError(
        'COMMERCE_ORDER_HISTORY_ACCOUNT_CHANGED',
        'Shopify returned a different store identity',
      )
    }
    const readOrders = hasEffectiveShopifyScope(grant.grantedScopes, 'read_orders')
      && hasEffectiveShopifyScope(probe.grantedScopes, 'read_orders')
    if (!readOrders) {
      historyError(
        'SHOPIFY_READ_ORDERS_REQUIRED',
        'Shopify must grant read_orders for exact order reads',
      )
    }
    const readAllOrders = hasEffectiveShopifyScope(
      grant.grantedScopes,
      'read_all_orders',
    ) && hasEffectiveShopifyScope(probe.grantedScopes, 'read_all_orders')
    const readReturns = hasEffectiveShopifyScope(grant.grantedScopes, 'read_returns')
      && hasEffectiveShopifyScope(probe.grantedScopes, 'read_returns')
    providerReads += 1
    const detail = await shopifyAdminGraphql<JsonRecord>(credential, {
      query: shopifyOrderHistoryDetailQuery(readReturns),
      operationName: 'ClawPilotCommerceOrderHistoryDetail',
      variables: { id: externalOrderId },
    }, { timeoutMs: PROVIDER_TIMEOUT_MS })
    const source = asRecord(detail.order)
    if (detail.order === null || detail.order === undefined) {
      historyError(
        'SHOPIFY_ORDER_HISTORY_EXACT_ORDER_UNAVAILABLE',
        'Shopify no longer makes this exact order available to the connection',
        404,
      )
    }
    if (!source || exactString(source.id) !== externalOrderId) {
      historyError(
        'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
        'Shopify exact-order hydration changed identity',
        502,
      )
    }
    assertShopifyOrderHistoryDetailEvidence(source, readReturns)
    const normalized = normalizeShopifyCommerce({
      data: {
        products: completeConnection([]),
        orders: completeConnection([source]),
      },
      shopDomain,
    }, context(runtime, observedAt))
    if (
      normalized.rejections.length
      || normalized.orders.length !== 1
      || normalized.orders[0].identity.value !== externalOrderId
      || normalized.orders[0].lineItemsTruncated
    ) {
      historyError(
        'COMMERCE_ORDER_HISTORY_NORMALIZATION_REJECTED',
        'The Shopify exact-order read could not be normalized without loss',
        409,
      )
    }
    return {
      provider: 'shopify',
      observation: commerceOrderHistoryObservation(
        'shopify',
        normalized.orders[0],
        source,
        observedAt,
        3,
        input.observationKind,
      ),
      providerReads: 3,
      providerWrites: 0,
      readAllOrdersScopeObserved: readAllOrders,
      returnHistoryScopeObserved: readReturns,
    }
  } catch (error) {
    retainExactShopifyOrderHistoryReadAttempts(error, providerReads)
  }
}

/**
 * Reads one exact Faire order for an explicitly authorized manual refresh.
 * Faire exposes the complete current order, including embedded shipments,
 * through GET /orders/{id}. This path verifies the brand before the exact
 * read, performs no list scan, advances no cursor, and issues no provider
 * write.
 */
export async function readExactFaireOrderHistoryObservation(
  input: ExactFaireOrderHistoryInput,
): Promise<ExactFaireOrderHistoryRead> {
  const observedAt = requiredIso(
    input.observedAt || new Date().toISOString(),
    'Observation time',
  )
  const externalOrderId = exactString(input.externalOrderId)
  if (
    !externalOrderId
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(externalOrderId)
  ) {
    historyError(
      'FAIRE_ORDER_HISTORY_EXACT_ID_INVALID',
      'The exact Faire order ID is invalid',
      400,
    )
  }
  const runtime = await runtimeFor(input)
  if (runtime.provider !== 'faire') {
    historyError(
      'FAIRE_ORDER_HISTORY_ACCOUNT_REQUIRED',
      'Exact Faire order reads require a Faire connection',
    )
  }
  const secret = decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (secret.provider !== 'faire') {
    historyError(
      'COMMERCE_ORDER_HISTORY_CREDENTIAL_INVALID',
      'The credential provider changed',
    )
  }
  if (secret.authMode === 'faire_oauth' && !secret.scopes.includes('READ_ORDERS')) {
    historyError(
      'FAIRE_READ_ORDERS_REQUIRED',
      'Faire must grant READ_ORDERS for exact order reads',
    )
  }
  const options = secret.authMode === 'faire_oauth'
    ? {
        accessToken: secret.accessToken,
        applicationId: secret.applicationId,
        applicationSecret: secret.applicationSecret,
        timeoutMs: PROVIDER_TIMEOUT_MS,
      }
    : { accessToken: secret.accessToken, timeoutMs: PROVIDER_TIMEOUT_MS }
  let providerReads = 0
  try {
    providerReads += 1
    exactFaireBrand(
      await probeFaireBrandProfile(options),
      runtime.externalAccountId,
    )
    providerReads += 1
    const source = asRecord(await getFaireOrder(options, externalOrderId))
    if (
      !source
      || exactString(source.id ?? source.order_id) !== externalOrderId
    ) {
      historyError(
        'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
        'Faire exact-order hydration changed identity',
        502,
      )
    }
    assertFaireOrderHistoryDetailEvidence(source)
    assertFaireBrandScope([source], runtime.externalAccountId)
    const normalized = normalizeFaireCommerce({
      brand: { id: runtime.externalAccountId },
      orders: completeFairePage({ orders: [source] }, [source]),
      products: completeFairePage({ products: [] }, []),
    }, context(runtime, observedAt))
    if (
      normalized.rejections.length
      || normalized.orders.length !== 1
      || normalized.orders[0].identity.value !== externalOrderId
      || normalized.orders[0].lineItemsTruncated
    ) {
      historyError(
        'COMMERCE_ORDER_HISTORY_NORMALIZATION_REJECTED',
        'The Faire exact-order read could not be normalized without loss',
        409,
      )
    }
    return {
      provider: 'faire',
      observation: commerceOrderHistoryObservation(
        'faire',
        normalized.orders[0],
        source,
        observedAt,
        2,
        input.observationKind,
      ),
      providerReads: 2,
      providerWrites: 0,
      readAllOrdersScopeObserved: null,
      returnHistoryScopeObserved: null,
    }
  } catch (error) {
    retainExactFaireOrderHistoryReadAttempts(error, providerReads)
  }
}
