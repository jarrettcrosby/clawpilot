import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  inspectCommerceOrderNativeActivityWithClient,
  appendCommerceOrderNativeActivityWithClient,
  commerceOrderNativeActivityJoinSql,
  COMMERCE_ORDER_NATIVE_MESSAGE_SQL,
  COMMERCE_ORDER_NATIVE_ACTOR_SQL,
  COMMERCE_ORDER_NATIVE_ACTION_SQL,
  COMMERCE_ORDER_NATIVE_REDACTED_SQL,
} from '@/lib/persistence/commerceOrderNativeActivity'
import {
  appendCommerceOrderTrackingUrlEvidenceWithClient,
  inspectCommerceOrderTrackingUrlEvidenceWithClient,
  commerceOrderTrackingUrlEvidenceJoinSql,
  COMMERCE_ORDER_TRACKING_URL_VALUE_SQL,
} from '@/lib/persistence/commerceOrderTrackingUrlEvidence'
import { recordAuditEvent } from '@/lib/auditWriter'
import { hasEffectiveShopifyScope } from '@/lib/integrations/commerceCapabilities'
import {
  COMMERCE_ORDER_SYNC_CURSOR_AAD_VERSION,
  decryptCommerceOrderSyncCursor,
  encryptCommerceOrderSyncCursor,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  resolveCommerceOrderRevisionEvidenceKeyConfig,
  summarizeCommerceOrderRevisionEvidenceKeyReadiness,
} from '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'
import {
  commerceReadAccountSql,
} from '@/lib/integrations/commerceReadRuntime'
import { isHostedRuntime } from '@/lib/persistence/config'
import { commerceStoreSyncRunningSql } from '@/lib/operations/commerceStoreSync'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'
import {
  assertCommerceStoreSyncProviderReadLeaseCurrentWithClient,
  commerceStoreSyncProviderReadIntentFingerprint,
  type CommerceStoreSyncProviderReadLease,
} from '@/lib/persistence/commerceStoreSync'
import {
  assessCommerceOrderHistoryAdmissionWithClient,
  lockCommerceOrderHistoryAdmissionWithClient,
} from '@/lib/persistence/commerceOrderHistoryAdmission'
import {
  commerceOrderHistoryCompletionMeaning,
  commerceOrderHistoryCoverageBasis,
  commerceOrderHistoryRequestedFrom,
  type CommerceOrderHistoryMode,
} from '@/lib/integrations/commerceOrderHistoryPolicy'

const POLICY_VERSION = 'commerce-order-sync-policy-v1'
const BACKFILL_LEASE = '10 minutes'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const BACKFILL_GLOBAL_ID_PATTERN = /^gcob(?:[0-9]{7}|[0-9a-v]{12})$/u
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const ORDER_READ_ACCOUNT_SQL = commerceReadAccountSql('account', {
  developmentRequiresActive: true,
  capability: 'orders_history',
})
const STORE_SYNC_RUNNING_SQL = commerceStoreSyncRunningSql('account')

export function commerceOrderSyncAccountLockKey(input: {
  organizationId: string
  accountGlobalId: string
}) {
  return `commerce-order-sync-account:${input.organizationId}:${input.accountGlobalId}`
}

const OBSERVATION_KINDS = new Set([
  'historical_backfill',
  'scheduled_poll',
  'webhook_exact_read',
  'manual_exact_read',
] as const)
const EVENT_KINDS = new Set([
  'order_created',
  'order_updated',
  'order_cancelled',
  'order_closed',
  'payment_updated',
  'fulfillment_created',
  'fulfillment_updated',
  'shipment_created',
  'tracking_updated',
  'refund_created',
  'refund_updated',
  'return_created',
  'return_updated',
  'return_state_observed',
  'provider_activity',
] as const)
const INVENTORY_EFFECT_KINDS = new Set([
  'none',
  'order_demand',
  'provider_reservation_signal',
  'restock_instruction',
  'unknown',
] as const)
const PROVIDER_ATTRIBUTION_SOURCES = new Set([
  'provider_staff',
  'provider_system',
  'unavailable',
] as const)

type CommerceProvider = 'shopify' | 'faire'
type CommerceOrderObservationKind =
  | 'historical_backfill'
  | 'scheduled_poll'
  | 'webhook_exact_read'
  | 'manual_exact_read'
type CommerceOrderEventKind =
  | 'order_created'
  | 'order_updated'
  | 'order_cancelled'
  | 'order_closed'
  | 'payment_updated'
  | 'fulfillment_created'
  | 'fulfillment_updated'
  | 'shipment_created'
  | 'tracking_updated'
  | 'refund_created'
  | 'refund_updated'
  | 'return_created'
  | 'return_updated'
  | 'return_state_observed'
  | 'provider_activity'
type InventoryEffectKind =
  | 'none'
  | 'order_demand'
  | 'provider_reservation_signal'
  | 'restock_instruction'
  | 'unknown'
type ProviderAttributionSource =
  | 'provider_staff'
  | 'provider_system'
  | 'unavailable'

export class CommerceOrderSyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'CommerceOrderSyncError'
  }
}

export type CommerceOrderHistoryReadinessInput = {
  provider: CommerceProvider
  authMode: string
  grantedScopes?: readonly string[]
  requestedScopes?: readonly string[]
}

export function commerceOrderHistoryReadiness(
  input: CommerceOrderHistoryReadinessInput,
) {
  if (input.provider === 'shopify') {
    const authModeCompatible = input.authMode === 'shopify_client_credentials'
    const granted = Array.isArray(input.grantedScopes)
      ? [...input.grantedScopes]
      : []
    const currentOrdersReadable = authModeCompatible && hasEffectiveShopifyScope(
      granted,
      'read_orders',
    )
    const readAllOrdersGranted = hasEffectiveShopifyScope(
      granted,
      'read_all_orders',
    )
    const blockers = [
      ...(authModeCompatible ? [] : ['COMMERCE_ORDER_SYNC_AUTH_MODE_INCOMPATIBLE']),
      ...(currentOrdersReadable ? [] : ['SHOPIFY_READ_ORDERS_REQUIRED']),
    ]
    return {
      provider: input.provider,
      currentOrdersReadable,
      historicalOrdersReadable: currentOrdersReadable,
      readAllOrdersGranted,
      fullHistoricalCoverageReady:
        currentOrdersReadable && readAllOrdersGranted,
      coverageBasis: 'shopify_rolling_60_days' as const,
      completionMeaning: readAllOrdersGranted
        ? 'shopify_fixed_window_orders_complete' as const
        : 'shopify_fixed_window_read_attempt_complete' as const,
      continuousTransport: 'scheduled_poll' as const,
      providerEventProcessorState: 'processor_pending' as const,
      pollingCadenceMinutes: 30 as const,
      blockers,
      providerWrites: 0 as const,
    }
  }
  const requested = new Set(
    Array.isArray(input.requestedScopes) ? input.requestedScopes : [],
  )
  const authModeCompatible = ['faire_brand_token', 'faire_oauth']
    .includes(input.authMode)
  const currentOrdersReadable = authModeCompatible && (
    input.authMode === 'faire_brand_token' || requested.has('READ_ORDERS')
  )
  return {
    provider: input.provider,
    currentOrdersReadable,
    historicalOrdersReadable: currentOrdersReadable,
    coverageBasis: 'faire_provider_available_orders' as const,
    completionMeaning: 'faire_provider_available_orders_complete' as const,
    continuousTransport: 'scheduled_poll' as const,
    providerEventProcessorState: 'unsupported' as const,
    pollingCadenceMinutes: 5 as const,
    blockers: [
      ...(authModeCompatible ? [] : ['COMMERCE_ORDER_SYNC_AUTH_MODE_INCOMPATIBLE']),
      ...(currentOrdersReadable ? [] : ['FAIRE_READ_ORDERS_REQUIRED']),
    ],
    providerWrites: 0 as const,
  }
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function text(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 1,
) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function optionalText(value: unknown, label: string, maximum: number) {
  if (value === null || value === undefined || value === '') return null
  return text(value, label, maximum)
}

function optionalHttpUrl(value: unknown, label: string) {
  const normalized = optionalText(value, label, 2_048)
  if (!normalized) return null
  try {
    const parsed = new URL(normalized)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('unsupported protocol')
    }
    return parsed.toString()
  } catch {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
}

function iso(value: unknown, label: string, optional: true): string | null
function iso(value: unknown, label: string, optional?: false): string
function iso(value: unknown, label: string, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) {
    return null
  }
  const candidate = typeof value === 'string' ? value : ''
  const parsed = new Date(candidate)
  if (!candidate || Number.isNaN(parsed.getTime())) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return parsed.toISOString()
}

function optionalMinor(value: unknown, label: string) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return Number(value)
}

function observationLineMoney(
  currencyValue: unknown,
  amountValue: unknown,
  label: string,
) {
  const currency = optionalText(currencyValue, `${label} currency`, 3)
  const amountMinor = optionalMinor(amountValue, label)
  if (
    (currency === null) !== (amountMinor === null)
    || (currency !== null && !/^[A-Z]{3}$/u.test(currency))
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      `${label} is incomplete`,
      400,
    )
  }
  return { currency, amountMinor }
}

export function normalizeCommerceOrderQuantity(
  value: unknown,
  label: string,
  optional: true,
): number | null
export function normalizeCommerceOrderQuantity(
  value: unknown,
  label: string,
  optional?: false,
): number
export function normalizeCommerceOrderQuantity(
  value: unknown,
  label: string,
  optional = false,
): number | null {
  if (optional && (value === null || value === undefined)) return null
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return value
}

const quantity = normalizeCommerceOrderQuantity

function count(value: unknown, label: string) {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return value
}

function sensitiveEvidenceRetentionDays() {
  const raw = process.env.COMMERCE_ORDER_SENSITIVE_EVIDENCE_RETENTION_DAYS
  const days = raw === undefined || raw === '' ? 400 : Number(raw)
  if (!Number.isSafeInteger(days) || days < 1 || days > 400) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_RETENTION_INVALID',
      'Commerce order sensitive-evidence retention must be 1-400 days',
      503,
    )
  }
  return days
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
) {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return value as T
}

export type CommerceOrderObservationLineInput = {
  externalLineId: string
  externalProductId?: string | null
  externalVariantId?: string | null
  sku?: string | null
  titleSnapshot?: string | null
  variantTitleSnapshot?: string | null
  vendorSnapshot?: string | null
  originalQuantity: number
  currentQuantity?: number | null
  unfulfilledQuantity?: number | null
  fulfilledQuantity?: number | null
  returnedQuantity?: number | null
  requiresShipping?: boolean | null
  unitPriceCurrency?: string | null
  unitPriceMinor?: number | null
  subtotalCurrency?: string | null
  subtotalMinor?: number | null
  discountCurrency?: string | null
  discountMinor?: number | null
  taxCurrency?: string | null
  taxMinor?: number | null
}

export type CommerceOrderEventObservationInput = {
  externalEventId?: string | null
  externalSubjectId?: string | null
  eventKind: CommerceOrderEventKind
  eventStatus?: string | null
  quantity?: number | null
  amountMinor?: number | null
  currency?: string | null
  inventoryEffectKind?: InventoryEffectKind
  attributionSource: ProviderAttributionSource
  providerActorFingerprint?: string | null
  providerLocationId?: string | null
  trackingCarrier?: string | null
  trackingNumber?: string | null
  trackingUrl?: string | null
  providerMessage?: string | null
  providerActorDisplayName?: string | null
  occurredAt: string
}

export type CommerceOrderObservationInput = {
  observationKind: CommerceOrderObservationKind
  externalOrderId: string
  orderNumber: string
  sourceRevision: string
  sourceHash: string
  rawLifecycleState?: string | null
  rawPaymentState?: string | null
  rawFulfillmentState?: string | null
  rawReturnState?: string | null
  canonicalLifecycleState: 'open' | 'closed' | 'cancelled' | 'unknown'
  canonicalPaymentState:
    | 'authorized'
    | 'paid'
    | 'partially_paid'
    | 'partially_refunded'
    | 'pending'
    | 'refunded'
    | 'voided'
    | 'unknown'
  canonicalFulfillmentState:
    | 'unfulfilled'
    | 'partial'
    | 'fulfilled'
    | 'on_hold'
    | 'unknown'
  canonicalReturnState:
    | 'none'
    | 'requested'
    | 'in_progress'
    | 'returned'
    | 'unknown'
  currency?: string | null
  providerTotalMinor?: number | null
  providerInventoryReservationState?:
    | 'reported_reserved'
    | 'reported_not_reserved'
    | 'unavailable'
  providerCreatedAt?: string | null
  providerProcessedAt?: string | null
  providerUpdatedAt?: string | null
  providerCancelledAt?: string | null
  providerClosedAt?: string | null
  observedAt: string
  providerReadCount: number
  nativeActivityState?: 'complete' | 'partial' | 'unavailable'
  nativeActivityReason?: string | null
  nativeActivityFetchedCount?: number
  lines: readonly CommerceOrderObservationLineInput[]
  events?: readonly CommerceOrderEventObservationInput[]
}

type NormalizedObservation = ReturnType<
  typeof normalizeCommerceOrderObservationInput
>

export function commerceOrderObservationKindForSession(
  sessionKind: 'historical_backfill' | 'continuous_poll',
): CommerceOrderObservationKind {
  return sessionKind === 'continuous_poll'
    ? 'scheduled_poll'
    : 'historical_backfill'
}

export function assertCommerceOrderSyncObservationKinds(
  sessionKind: 'historical_backfill' | 'continuous_poll',
  observationKinds: readonly CommerceOrderObservationKind[],
) {
  const expected = commerceOrderObservationKindForSession(sessionKind)
  if (observationKinds.some((kind) => kind !== expected)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'An order sync page contains the wrong observation kind',
      400,
    )
  }
  return expected
}

export function normalizeCommerceOrderObservationInput(
  input: CommerceOrderObservationInput,
) {
  const observationKind = enumValue(
    input.observationKind,
    OBSERVATION_KINDS,
    'Observation kind',
  )
  const externalOrderId = text(input.externalOrderId, 'External order ID', 512)
  const observedAt = iso(input.observedAt, 'Observation time')
  const currency = input.currency
    ? text(input.currency, 'Currency', 3)
    : null
  if (currency && !/^[A-Z]{3}$/u.test(currency)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Currency is invalid',
      400,
    )
  }
  const providerTotalMinor = optionalMinor(
    input.providerTotalMinor,
    'Provider order total',
  )
  if ((currency === null) !== (providerTotalMinor === null)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Provider order money is incomplete',
      400,
    )
  }
  if (!HASH_PATTERN.test(text(input.sourceHash, 'Source hash', 64))) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Source hash is invalid',
      400,
    )
  }
  if (!Array.isArray(input.lines)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Provider order lines are invalid',
      400,
    )
  }
  const lines = input.lines.map(
    (line) => {
      const unitPrice = observationLineMoney(
        line.unitPriceCurrency,
        line.unitPriceMinor,
        'Provider line unit price',
      )
      const subtotal = observationLineMoney(
        line.subtotalCurrency,
        line.subtotalMinor,
        'Provider line subtotal',
      )
      const discount = observationLineMoney(
        line.discountCurrency,
        line.discountMinor,
        'Provider line discount',
      )
      const tax = observationLineMoney(
        line.taxCurrency,
        line.taxMinor,
        'Provider line tax',
      )
      return {
        externalLineId: text(line.externalLineId, 'External line ID', 512),
        externalProductId: optionalText(
          line.externalProductId,
          'External product ID',
          512,
        ),
        externalVariantId: optionalText(
          line.externalVariantId,
          'External variant ID',
          512,
        ),
        sku: optionalText(line.sku, 'SKU', 512),
        titleSnapshot: optionalText(line.titleSnapshot, 'Line title', 512),
        variantTitleSnapshot: optionalText(
          line.variantTitleSnapshot,
          'Line variant title',
          512,
        ),
        vendorSnapshot: optionalText(line.vendorSnapshot, 'Line vendor', 512),
        originalQuantity: quantity(line.originalQuantity, 'Original quantity'),
        currentQuantity: quantity(
          line.currentQuantity,
          'Current quantity',
          true,
        ),
        unfulfilledQuantity: quantity(
          line.unfulfilledQuantity,
          'Unfulfilled quantity',
          true,
        ),
        fulfilledQuantity: quantity(
          line.fulfilledQuantity,
          'Fulfilled quantity',
          true,
        ),
        returnedQuantity: quantity(
          line.returnedQuantity,
          'Returned quantity',
          true,
        ),
        requiresShipping: typeof line.requiresShipping === 'boolean'
          ? line.requiresShipping
          : null,
        unitPriceCurrency: unitPrice.currency,
        unitPriceMinor: unitPrice.amountMinor,
        subtotalCurrency: subtotal.currency,
        subtotalMinor: subtotal.amountMinor,
        discountCurrency: discount.currency,
        discountMinor: discount.amountMinor,
        taxCurrency: tax.currency,
        taxMinor: tax.amountMinor,
      }
    },
  )
  if (new Set(lines.map((line) => line.externalLineId)).size !== lines.length) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'External order line identities must be unique',
      400,
    )
  }
  for (const line of lines) {
    if (
      (line.currentQuantity !== null
        && line.currentQuantity > line.originalQuantity)
      || (line.unfulfilledQuantity !== null
        && (
          line.currentQuantity === null
          || line.unfulfilledQuantity > line.currentQuantity
        ))
      || (line.fulfilledQuantity !== null
        && (
          line.currentQuantity === null
          || line.fulfilledQuantity > line.currentQuantity
          || line.fulfilledQuantity > line.originalQuantity
        ))
      || (
        line.currentQuantity !== null
        && line.unfulfilledQuantity !== null
        && line.fulfilledQuantity !== null
        && line.currentQuantity
          !== line.unfulfilledQuantity + line.fulfilledQuantity
      )
      || (line.returnedQuantity !== null
        && line.returnedQuantity > line.originalQuantity)
    ) {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_SYNC_INPUT_INVALID',
        'Provider line quantities are internally inconsistent',
        400,
      )
    }
  }
  if (input.events !== undefined && !Array.isArray(input.events)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Provider order events are invalid',
      400,
    )
  }
  const events = (input.events || []).map(
    (event) => {
      const attributionSource = enumValue(
        event.attributionSource,
        PROVIDER_ATTRIBUTION_SOURCES,
        'Provider event attribution',
      )
      const providerActorFingerprint = optionalText(
        event.providerActorFingerprint,
        'Provider actor fingerprint',
        64,
      )
      if (
        (attributionSource === 'provider_staff')
          !== Boolean(providerActorFingerprint)
        || (
          providerActorFingerprint
          && !HASH_PATTERN.test(providerActorFingerprint)
        )
      ) {
        throw new CommerceOrderSyncError(
          'COMMERCE_ORDER_SYNC_INPUT_INVALID',
          'Provider staff attribution evidence is invalid',
          400,
        )
      }
      const eventCurrency = event.currency
        ? text(event.currency, 'Event currency', 3)
        : null
      const amountMinor = optionalMinor(event.amountMinor, 'Event amount')
      if (
        (eventCurrency === null) !== (amountMinor === null)
        || (eventCurrency && !/^[A-Z]{3}$/u.test(eventCurrency))
      ) {
        throw new CommerceOrderSyncError(
          'COMMERCE_ORDER_SYNC_INPUT_INVALID',
          'Provider event money is incomplete',
          400,
        )
      }
      const occurredAt = iso(event.occurredAt, 'Event occurrence time')
      if (
        new Date(occurredAt).getTime()
          > new Date(observedAt).getTime() + 5 * 60 * 1_000
      ) {
        throw new CommerceOrderSyncError(
          'COMMERCE_ORDER_SYNC_INPUT_INVALID',
          'Provider event time is later than the bounded observation clock skew',
          400,
        )
      }
      const normalized = {
        externalEventId: optionalText(
          event.externalEventId,
          'External event ID',
          512,
        ),
        externalSubjectId: optionalText(
          event.externalSubjectId,
          'External event subject ID',
          512,
        ),
        eventKind: enumValue(event.eventKind, EVENT_KINDS, 'Event kind'),
        eventStatus: optionalText(event.eventStatus, 'Event status', 128),
        quantity: quantity(event.quantity, 'Event quantity', true),
        amountMinor,
        currency: eventCurrency,
        inventoryEffectKind: enumValue(
          event.inventoryEffectKind || 'none',
          INVENTORY_EFFECT_KINDS,
          'Inventory effect kind',
        ),
        attributionSource,
        providerActorFingerprint,
        providerLocationId: optionalText(
          event.providerLocationId,
          'Provider location ID',
          512,
        ),
        trackingCarrier: optionalText(
          event.trackingCarrier,
          'Tracking carrier',
          255,
        ),
        trackingNumber: optionalText(
          event.trackingNumber,
          'Tracking number',
          512,
        ),
        trackingUrl: optionalHttpUrl(event.trackingUrl, 'Tracking URL'),
        providerMessage: event.providerMessage == null ? null : (() => {
          if (typeof event.providerMessage !== 'string') {
            throw new CommerceOrderSyncError('COMMERCE_ORDER_SYNC_INPUT_INVALID', 'Provider message is invalid', 400)
          }
          const value = event.providerMessage.trim()
          if (value.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
            throw new CommerceOrderSyncError('COMMERCE_ORDER_SYNC_INPUT_INVALID', 'Provider message is invalid', 400)
          }
          return value || null
        })(),
        providerActorDisplayName: optionalText(event.providerActorDisplayName, 'Provider actor display name', 255),
        occurredAt,
      }
      if (normalized.eventKind === 'provider_activity' && (
        !normalized.externalEventId || normalized.externalSubjectId !== externalOrderId
        || normalized.trackingNumber !== null || normalized.trackingUrl !== null
        || normalized.providerActorFingerprint !== null
        || normalized.quantity !== null || normalized.amountMinor !== null
        || normalized.inventoryEffectKind !== 'none'
      )) {
        throw new CommerceOrderSyncError('COMMERCE_ORDER_SYNC_INPUT_INVALID', 'Native provider activity identity is invalid', 400)
      }
      const sensitiveIdentifiers = [
        normalized.trackingNumber,
        normalized.trackingUrl,
        normalized.providerActorFingerprint,
      ].filter((value): value is string => Boolean(value))
      const durableIdentifiers = [
        normalized.externalEventId,
        normalized.externalSubjectId,
      ].filter((value): value is string => Boolean(value))
      const embedsSensitiveSegment = durableIdentifiers.some(
        (identifier) => sensitiveIdentifiers.some(
          (sensitive) => identifier === sensitive
            || identifier.startsWith(`${sensitive}:`)
            || identifier.endsWith(`:${sensitive}`)
            || identifier.includes(`:${sensitive}:`),
        ),
      )
      if (embedsSensitiveSegment) {
        throw new CommerceOrderSyncError(
          'COMMERCE_ORDER_SYNC_INPUT_INVALID',
          'Sensitive provider evidence must not be embedded in durable identifiers',
          400,
        )
      }
      const privacyMinimizedEvent = Object.fromEntries(
        Object.entries(normalized).filter(([key]) => (
          key !== 'trackingNumber'
          && key !== 'trackingUrl'
          && key !== 'providerActorFingerprint'
          && key !== 'providerMessage'
          && key !== 'providerActorDisplayName'
          && !(normalized.eventKind === 'provider_activity' && [
            'eventStatus', 'attributionSource', 'quantity', 'amountMinor', 'currency',
            'inventoryEffectKind', 'providerLocationId', 'trackingCarrier',
          ].includes(key))
        )),
      )
      return {
        ...normalized,
        eventHash: hash({
          providerOrderId: externalOrderId,
          ...privacyMinimizedEvent,
        }),
      }
    },
  )
  const normalized = {
    observationKind,
    externalOrderId,
    orderNumber: text(input.orderNumber, 'Order number', 255),
    sourceRevision: text(input.sourceRevision, 'Source revision', 512),
    rawLifecycleState: optionalText(
      input.rawLifecycleState,
      'Raw lifecycle state',
      64,
    ),
    rawPaymentState: optionalText(input.rawPaymentState, 'Raw payment state', 64),
    rawFulfillmentState: optionalText(
      input.rawFulfillmentState,
      'Raw fulfillment state',
      64,
    ),
    rawReturnState: optionalText(input.rawReturnState, 'Raw return state', 64),
    canonicalLifecycleState: input.canonicalLifecycleState,
    canonicalPaymentState: input.canonicalPaymentState,
    canonicalFulfillmentState: input.canonicalFulfillmentState,
    canonicalReturnState: input.canonicalReturnState,
    currency,
    providerTotalMinor,
    providerInventoryReservationState:
      input.providerInventoryReservationState || 'unavailable',
    providerCreatedAt: iso(
      input.providerCreatedAt,
      'Provider order creation time',
      true,
    ),
    providerProcessedAt: iso(
      input.providerProcessedAt,
      'Provider order processing time',
      true,
    ),
    providerUpdatedAt: iso(
      input.providerUpdatedAt,
      'Provider order update time',
      true,
    ),
    providerCancelledAt: iso(
      input.providerCancelledAt,
      'Provider order cancellation time',
      true,
    ),
    providerClosedAt: iso(
      input.providerClosedAt,
      'Provider order close time',
      true,
    ),
    observedAt,
    providerReadCount: (() => {
      const value = count(input.providerReadCount, 'Provider read count')
      if (value < 1 || value > 8) {
        throw new CommerceOrderSyncError(
          'COMMERCE_ORDER_SYNC_INPUT_INVALID',
          'Provider read count is invalid',
          400,
        )
      }
      return value
    })(),
    ...(input.nativeActivityState === undefined ? {} : {
      nativeActivityState: enumValue(input.nativeActivityState,
        new Set(['complete', 'partial', 'unavailable'] as const), 'Native activity coverage'),
      nativeActivityReason: optionalText(input.nativeActivityReason, 'Native activity reason', 255),
      nativeActivityFetchedCount: (() => {
        const value = count(input.nativeActivityFetchedCount, 'Native activity fetched count')
        if (value > 500) throw new CommerceOrderSyncError('COMMERCE_ORDER_SYNC_INPUT_INVALID', 'Native activity count exceeds the bounded read', 400)
        return value
      })(),
    }),
    lines,
    events,
  }
  const providerRevisionFacts = Object.fromEntries(
    Object.entries(normalized).filter(([key]) => ![
      'observedAt',
      'providerReadCount',
      'observationKind',
    ].includes(key)),
  )
  return {
    ...normalized,
    sourceHash: hash({
      ...providerRevisionFacts,
      events: normalized.events.map((event) => Object.fromEntries(
        Object.entries(event).filter(([key]) => ![
          'trackingNumber',
          'providerActorFingerprint',
          'eventHash',
          'providerMessage',
          'providerActorDisplayName',
          ...(event.eventKind === 'provider_activity' ? [
            'eventStatus', 'attributionSource', 'quantity', 'amountMinor', 'currency',
            'inventoryEffectKind', 'providerLocationId', 'trackingCarrier',
          ] : []),
          ...(event.eventKind === 'return_state_observed'
            ? ['occurredAt']
            : []),
        ].includes(key)),
      )),
    }),
  }
}

const normalizeObservation = normalizeCommerceOrderObservationInput

type ObservationPersistenceContext = {
  organizationId: string
  integrationAccountId: string
  provider: CommerceProvider
  credentialGeneration: number
  backfillSessionId: string | null
  manualProviderReadLeaseId: string | null
}

async function appendObservationsWithClient(
  client: PoolClient,
  context: ObservationPersistenceContext,
  values: readonly NormalizedObservation[],
) {
  let appended = 0
  let preserved = 0
  let linesAppended = 0
  let eventsAppended = 0
  for (const observation of [...values].sort((left, right) => (
    left.externalOrderId.localeCompare(right.externalOrderId)
  ))) {
    let observationWasPreserved = false
    // Serialize first materialization across intake, scheduled, manual, and
    // webhook paths. Existing identities remain eligible for later provider
    // revisions even when the order predates the frozen admission floor.
    await lockCommerceOrderHistoryAdmissionWithClient(client, {
      organizationId: context.organizationId,
      integrationAccountId: context.integrationAccountId,
      provider: context.provider,
      externalOrderId: observation.externalOrderId,
    })
    const admission = await assessCommerceOrderHistoryAdmissionWithClient(
      client,
      {
        organizationId: context.organizationId,
        integrationAccountId: context.integrationAccountId,
        provider: context.provider,
        externalOrderId: observation.externalOrderId,
        providerCreatedAt: observation.providerCreatedAt,
        locksHeld: true,
      },
    )
    if (admission.reason === 'policy_missing') {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_HISTORY_POLICY_MISSING',
        'The immutable order-history policy is unavailable',
        409,
      )
    }
    if (admission.reason === 'provider_created_at_required') {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_HISTORY_POLICY_EVIDENCE_INVALID',
        'Provider order creation time is required by the frozen history policy',
        409,
      )
    }
    if (!admission.admitted) continue
    // Content equality is compared only with the latest observation so a
    // truthful A -> B -> A state cycle remains appendable, while an unchanged
    // poll at a later observation clock remains a no-op.
    const latestObservationRow = (
      await client.query<{
        id: string
        global_id: string
        order_id: string | null
        source_hash: string
        observation_kind: CommerceOrderObservationKind
        manual_provider_read_lease_id: string | null
      }>(
        `SELECT id::text, global_id, order_id::text, source_hash,
                observation_kind, manual_provider_read_lease_id::text
         FROM operations_commerce_order_observations
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND provider = $3
           AND external_order_id = $4
         ORDER BY observed_at DESC, id DESC
         LIMIT 1
         FOR SHARE`,
        [
          context.organizationId,
          context.integrationAccountId,
          context.provider,
          observation.externalOrderId,
        ],
      )
    ).rows[0]
    const exactObservation = ['manual_exact_read', 'webhook_exact_read']
      .includes(observation.observationKind)
    const exactLineageMatches = (
      observation.observationKind !== 'manual_exact_read'
      || latestObservationRow?.manual_provider_read_lease_id
        === context.manualProviderReadLeaseId
    )
    let observationRow: { id: string; global_id: string; order_id: string | null; source_hash: string } | undefined = latestObservationRow?.source_hash
        === observation.sourceHash
      && (
        !exactObservation
        || (
          latestObservationRow.observation_kind === observation.observationKind
          && exactLineageMatches
        )
      )
      ? latestObservationRow
      : (
          await client.query<{
            id: string
            global_id: string
            order_id: string | null
            source_hash: string
            observation_kind: CommerceOrderObservationKind
            manual_provider_read_lease_id: string | null
          }>(
            `SELECT id::text, global_id, order_id::text, source_hash,
                    observation_kind, manual_provider_read_lease_id::text
             FROM operations_commerce_order_observations
             WHERE organization_id = $1::uuid
               AND integration_account_id = $2::uuid
               AND provider = $3
               AND external_order_id = $4
               AND source_hash = $5
               AND observed_at = $6::timestamptz
               AND (
                 NOT $7::boolean
                 OR (
                   observation_kind = $8
                   AND (
                     $8 <> 'manual_exact_read'
                     OR manual_provider_read_lease_id = $9::uuid
                   )
                 )
               )
             LIMIT 1
             FOR SHARE`,
            [
              context.organizationId,
              context.integrationAccountId,
              context.provider,
              observation.externalOrderId,
              observation.sourceHash,
              observation.observedAt,
              exactObservation,
              observation.observationKind,
              context.manualProviderReadLeaseId,
            ],
          )
        ).rows[0]
    const urlEnrichments = await inspectCommerceOrderTrackingUrlEvidenceWithClient(
      client, context, observation, {
        requireRetained: Boolean(observationRow),
        conflict: () => {
          throw new CommerceOrderSyncError(
            'COMMERCE_ORDER_SYNC_SENSITIVE_REVISION_CONFLICT',
            'Sensitive provider evidence changed without a new provider revision', 409,
          )
        },
      },
    )
    const nativeSnapshots = await inspectCommerceOrderNativeActivityWithClient(client, context, observation)
    // A matching hash may belong to an old, sealed observation whose URL was
    // never retained. Capture this actual read under its current authority;
    // do not mutate that parent or append children to its expired lease.
    if (urlEnrichments.length || nativeSnapshots.length) observationRow = undefined
    if (observationRow) {
      preserved += 1
      observationWasPreserved = true
    }
    const inserted = observationRow ? null : await client.query<{
      id: string
      global_id: string
      order_id: string | null
      source_hash: string
    }>(
      `INSERT INTO operations_commerce_order_observations (
         organization_id, integration_account_id, backfill_session_id,
         order_id, provider, credential_generation, observation_kind,
         external_order_id, order_number, source_revision, source_hash,
         raw_lifecycle_state, raw_payment_state, raw_fulfillment_state,
         raw_return_state, canonical_lifecycle_state,
         canonical_payment_state, canonical_fulfillment_state,
         canonical_return_state, currency, provider_total_minor,
         provider_inventory_reservation_state, provider_created_at,
         provider_processed_at, provider_updated_at, provider_cancelled_at,
         provider_closed_at, observed_at, provider_read_count,
         manual_provider_read_lease_id, native_activity_state,
         native_activity_reason, native_activity_fetched_count
       )
       SELECT
         $1::uuid, $2::uuid, $3::uuid, canonical.id, $4, $5, $6,
         $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
         $18, $19, $20, $21, $22::timestamptz, $23::timestamptz,
         $24::timestamptz, $25::timestamptz, $26::timestamptz,
         $27::timestamptz, $28, $29::uuid, $30, $31, $32
       FROM (SELECT 1) singleton
       LEFT JOIN LATERAL (
         SELECT orders.id
         FROM operations_orders orders
         WHERE orders.organization_id = $1::uuid
           AND orders.integration_account_id = $2::uuid
           AND orders.source_provider = $4
           AND orders.external_order_id = $7
         LIMIT 1
       ) canonical ON true
       ON CONFLICT (
         organization_id, integration_account_id, provider,
         external_order_id, observation_kind, observed_at, source_hash,
         backfill_session_id, webhook_target_id, webhook_dirty_version,
         manual_provider_read_lease_id
       ) DO NOTHING
       RETURNING id::text, global_id, order_id::text, source_hash`,
      [
        context.organizationId,
        context.integrationAccountId,
        context.backfillSessionId,
        context.provider,
        context.credentialGeneration,
        observation.observationKind,
        observation.externalOrderId,
        observation.orderNumber,
        observation.sourceRevision,
        observation.sourceHash,
        observation.rawLifecycleState,
        observation.rawPaymentState,
        observation.rawFulfillmentState,
        observation.rawReturnState,
        observation.canonicalLifecycleState,
        observation.canonicalPaymentState,
        observation.canonicalFulfillmentState,
        observation.canonicalReturnState,
        observation.currency,
        observation.providerTotalMinor,
        observation.providerInventoryReservationState,
        observation.providerCreatedAt,
        observation.providerProcessedAt,
        observation.providerUpdatedAt,
        observation.providerCancelledAt,
        observation.providerClosedAt,
        observation.observedAt,
        observation.providerReadCount,
        context.manualProviderReadLeaseId,
        observation.nativeActivityState || null,
        observation.nativeActivityReason || null,
        observation.nativeActivityFetchedCount ?? null,
      ],
    )
    observationRow = observationRow || inserted?.rows[0]
    if (inserted?.rows[0]) {
      appended += 1
    } else if (!observationRow) {
      preserved += 1
      observationWasPreserved = urlEnrichments.length === 0 && nativeSnapshots.length === 0
      observationRow = (
          await client.query<{
            id: string
            global_id: string
            order_id: string | null
            source_hash: string
            observation_kind: CommerceOrderObservationKind
            manual_provider_read_lease_id: string | null
          }>(
            `SELECT id::text, global_id, order_id::text, source_hash,
                    observation_kind, manual_provider_read_lease_id::text
             FROM operations_commerce_order_observations
             WHERE organization_id = $1::uuid
               AND integration_account_id = $2::uuid
               AND provider = $3
               AND external_order_id = $4
               AND source_hash = $5
               AND observed_at = $6::timestamptz
               AND observation_kind = $7
               AND (
                 $7 <> 'manual_exact_read'
                 OR manual_provider_read_lease_id = $8::uuid
               )
             LIMIT 1`,
            [
              context.organizationId,
              context.integrationAccountId,
              context.provider,
              observation.externalOrderId,
              observation.sourceHash,
              observation.observedAt,
              observation.observationKind,
              context.manualProviderReadLeaseId,
            ],
          )
      ).rows[0]
    }
    if (!observationRow) {
      throw new Error('Commerce order observation conflict could not be resolved')
    }
    if (observationWasPreserved) continue
    for (const line of observation.lines) {
      const lineResult = await client.query(
        `INSERT INTO operations_commerce_order_observation_lines (
           organization_id, observation_id, external_line_id,
           external_product_id, external_variant_id, sku,
           title_snapshot, variant_title_snapshot, vendor_snapshot,
           original_quantity, current_quantity, unfulfilled_quantity,
           fulfilled_quantity, returned_quantity, requires_shipping,
           unit_price_currency, unit_price_minor,
           subtotal_currency, subtotal_minor,
           discount_currency, discount_minor, tax_currency, tax_minor
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15,
           $16, $17, $18, $19, $20, $21, $22, $23
         )
         ON CONFLICT (
           organization_id, observation_id, external_line_id
         ) DO NOTHING`,
        [
          context.organizationId,
          observationRow.id,
          line.externalLineId,
          line.externalProductId,
          line.externalVariantId,
          line.sku,
          line.titleSnapshot,
          line.variantTitleSnapshot,
          line.vendorSnapshot,
          line.originalQuantity,
          line.currentQuantity,
          line.unfulfilledQuantity,
          line.fulfilledQuantity,
          line.returnedQuantity,
          line.requiresShipping,
          line.unitPriceCurrency,
          line.unitPriceMinor,
          line.subtotalCurrency,
          line.subtotalMinor,
          line.discountCurrency,
          line.discountMinor,
          line.taxCurrency,
          line.taxMinor,
        ],
      )
      linesAppended += Number(lineResult.rowCount || 0)
    }
    for (const event of observation.events) {
      const duplicateEvent = await client.query(
        `SELECT 1
         FROM operations_commerce_order_event_observations
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND provider = $3
           AND external_order_id = $4
           AND event_hash = $5
         LIMIT 1
         FOR SHARE`,
        [
          context.organizationId,
          context.integrationAccountId,
          context.provider,
          observation.externalOrderId,
          event.eventHash,
        ],
      )
      if (duplicateEvent.rows[0]) continue
      const eventResult = await client.query(
        `INSERT INTO operations_commerce_order_event_observations (
           organization_id, integration_account_id, observation_id,
           order_id, provider, external_order_id, external_event_id,
           external_subject_id, event_hash, event_kind, event_status,
           quantity, amount_minor, currency, inventory_effect_kind,
           attribution_source, provider_actor_fingerprint,
           provider_location_id, tracking_carrier, tracking_number,
           tracking_url,
           sensitive_evidence_expires_at, occurred_at, observed_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
           $20, $21, LEAST($22::timestamptz, $24::timestamptz)
             + make_interval(days => $23),
           $22::timestamptz, $24::timestamptz
         )
         ON CONFLICT (
           organization_id, integration_account_id, provider,
           external_order_id, event_hash
         ) DO NOTHING`,
        [
          context.organizationId,
          context.integrationAccountId,
          observationRow.id,
          observationRow.order_id,
          context.provider,
          observation.externalOrderId,
          event.externalEventId,
          event.externalSubjectId,
          event.eventHash,
          event.eventKind,
          event.eventKind === 'provider_activity' ? null : event.eventStatus,
          event.quantity,
          event.amountMinor,
          event.currency,
          event.inventoryEffectKind,
          event.eventKind === 'provider_activity' ? 'unavailable' : event.attributionSource,
          event.eventKind === 'provider_activity' ? null : event.providerActorFingerprint,
          event.providerLocationId,
          event.trackingCarrier,
          event.trackingNumber,
          event.trackingUrl,
          event.occurredAt,
          sensitiveEvidenceRetentionDays(),
          observation.observedAt,
        ],
      )
      eventsAppended += Number(eventResult.rowCount || 0)
    }
    await appendCommerceOrderTrackingUrlEvidenceWithClient(
      client, context, observation, observationRow.id, urlEnrichments,
    )
    await appendCommerceOrderNativeActivityWithClient(client, context, observation, observationRow.id, nativeSnapshots)
  }
  return {
    appended,
    preserved,
    linesAppended,
    eventsAppended,
  }
}

/**
 * Persists one manager-requested exact provider order read in the same
 * append-only evidence ledger used by webhook hydration and scheduled order
 * history. The provider read is fenced separately by the caller; this method
 * only accepts the exact account, credential generation, and order identity
 * covered by that lease.
 */
export async function appendCommerceOrderWorkbenchExactReadInPostgres(input: {
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  provider: CommerceProvider
  credentialGeneration: number
  externalOrderId: string
  providerReadLease: CommerceStoreSyncProviderReadLease
  observation: CommerceOrderObservationInput
}) {
  if (
    !UUID_PATTERN.test(input.organizationId)
    || !UUID_PATTERN.test(input.integrationAccountId)
    || !Number.isSafeInteger(input.credentialGeneration)
    || input.credentialGeneration < 1
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Exact order-history authority is invalid',
      400,
    )
  }
  const observation = normalizeObservation(input.observation)
  const providerReadCountValid = input.provider === 'shopify'
    ? observation.providerReadCount >= 3 && observation.providerReadCount <= 5
    : observation.providerReadCount === 2
  if (
    observation.observationKind !== 'manual_exact_read'
    || observation.externalOrderId !== input.externalOrderId
    || !providerReadCountValid
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Exact order-history evidence does not match the refreshed order',
      400,
    )
  }
  return withTransaction(async (client) => {
    const account = await client.query<{ integration_account_id: string }>(
      `SELECT account.id::text AS integration_account_id
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version = $4
        AND credential.external_account_id = account.external_account_id
        AND (
          (account.provider = 'shopify'
            AND credential.auth_mode = 'shopify_client_credentials')
          OR (account.provider = 'faire'
            AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
        )
        AND credential.verification_status = 'verified'
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.global_id = $3
         AND account.integration_type = 'commerce'
         AND account.provider = $5
         AND account.status = 'active'
         AND account.commerce_credential_generation = $4
       LIMIT 1
       FOR SHARE OF account, credential`,
      [
        input.organizationId,
        input.integrationAccountId,
        input.accountGlobalId,
        input.credentialGeneration,
        input.provider,
      ],
    )
    if (!account.rows[0]) {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_HISTORY_ACCOUNT_INELIGIBLE',
        'The exact verified commerce connection changed before history was saved',
      )
    }
    // Match intake's account -> store-control ordering without upgrading
    // this exact-read path's existing shared account/credential locks.
    await assertCommerceStoreSyncProviderReadLeaseCurrentWithClient(client, {
      organizationId: input.organizationId,
      integrationAccountId: input.integrationAccountId,
      lease: input.providerReadLease,
      authorityKind: 'manual_read_only',
      readKind: 'order_history',
    })
    const admission = await assessCommerceOrderHistoryAdmissionWithClient(
      client,
      {
        organizationId: input.organizationId,
        integrationAccountId: input.integrationAccountId,
        provider: input.provider,
        externalOrderId: observation.externalOrderId,
        providerCreatedAt: observation.providerCreatedAt,
      },
    )
    if (admission.reason === 'policy_missing') {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_HISTORY_POLICY_MISSING',
        'The immutable order-history policy is unavailable',
        409,
      )
    }
    if (admission.reason === 'provider_created_at_required') {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_HISTORY_POLICY_EVIDENCE_INVALID',
        'Provider order creation time is required by the frozen history policy',
        409,
      )
    }
    if (!admission.admitted) {
      const excluded = await client.query(
        `UPDATE operations_commerce_store_sync_read_leases
         SET history_exclusion_code =
               'COMMERCE_ORDER_HISTORY_POLICY_EXCLUDED',
             history_excluded_external_order_id = $4,
             history_excluded_provider_created_at = $5::timestamptz
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND id = $3::uuid
           AND authority_kind = 'manual_read_only'
           AND read_kind = 'order_history'
           AND captured_at IS NOT NULL
           AND released_at IS NULL
         RETURNING id`,
        [
          input.organizationId,
          input.integrationAccountId,
          input.providerReadLease.id,
          observation.externalOrderId,
          observation.providerCreatedAt,
        ],
      )
      if (!excluded.rows[0]) {
        throw new CommerceOrderSyncError(
          'COMMERCE_ORDER_HISTORY_REPLAY_INVALID',
          'The exact order-history exclusion could not be retained',
          500,
        )
      }
      return Object.freeze({
        status: 'excluded' as const,
        code: 'COMMERCE_ORDER_HISTORY_POLICY_EXCLUDED' as const,
        appended: 0,
        preserved: 0,
        linesAppended: 0,
        eventsAppended: 0,
        providerReads: observation.providerReadCount,
        providerWrites: 0 as const,
      })
    }
    const persisted = await appendObservationsWithClient(client, {
      organizationId: input.organizationId,
      integrationAccountId: input.integrationAccountId,
      provider: input.provider,
      credentialGeneration: input.credentialGeneration,
      backfillSessionId: null,
      manualProviderReadLeaseId: input.providerReadLease.id,
    }, [observation])
    return Object.freeze({
      ...persisted,
      providerReads: observation.providerReadCount,
      providerWrites: 0 as const,
    })
  })
}

export type CommerceOrderWorkbenchExactReadReplay = {
  status: 'captured' | 'unavailable' | 'in_progress' | 'excluded'
  code: string | null
  providerReads: 0
  providerWrites: 0
}

/**
 * Resolves an exact-order read command before repeating provider I/O. A
 * completed capture replays from its immutable observation lineage; a prior
 * unavailable result remains a no-write replay for the same command key.
 */
export async function readCommerceOrderWorkbenchExactReadReplayInPostgres(
  input: {
    organizationId: string
    integrationAccountId: string
    provider: CommerceProvider
    externalOrderId: string
    intentKey: string
  },
): Promise<CommerceOrderWorkbenchExactReadReplay | null> {
  if (
    !UUID_PATTERN.test(input.organizationId)
    || !UUID_PATTERN.test(input.integrationAccountId)
    || !input.externalOrderId.trim()
    || !input.intentKey.trim()
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Exact order-history replay evidence is invalid',
      400,
    )
  }
  const fingerprint = commerceStoreSyncProviderReadIntentFingerprint({
    organizationId: input.organizationId,
    integrationAccountId: input.integrationAccountId,
    authorityKind: 'manual_read_only',
    readKind: 'order_history',
    intentKey: input.intentKey,
  })
  const result = await query<{
    captured_at: Date | null
    released_at: Date | null
    release_reason: 'completed' | 'failed' | 'expired' | null
    observation_id: string | null
    observation_external_order_id: string | null
    history_exclusion_code: string | null
    history_excluded_external_order_id: string | null
  }>(
    `SELECT lease.captured_at, lease.released_at, lease.release_reason,
            lease.history_exclusion_code,
            lease.history_excluded_external_order_id,
            observation.id::text AS observation_id,
            observation.external_order_id AS observation_external_order_id
     FROM operations_commerce_store_sync_read_leases lease
     JOIN operations_integration_accounts account
       ON account.organization_id = lease.organization_id
      AND account.id = lease.integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider = $4
     LEFT JOIN operations_commerce_order_observations observation
       ON observation.organization_id = lease.organization_id
      AND observation.integration_account_id = lease.integration_account_id
      AND observation.manual_provider_read_lease_id = lease.id
      AND observation.provider = $4
      AND observation.observation_kind = 'manual_exact_read'
     WHERE lease.organization_id = $1::uuid
       AND lease.integration_account_id = $2::uuid
       AND lease.authority_kind = 'manual_read_only'
       AND lease.read_kind = 'order_history'
       AND lease.intent_fingerprint_sha256 = $3
     ORDER BY observation.observed_at DESC NULLS LAST,
              observation.id DESC NULLS LAST
     LIMIT 1`,
    [
      input.organizationId,
      input.integrationAccountId,
      fingerprint,
      input.provider,
    ],
  )
  const retained = result.rows[0]
  if (!retained) return null
  if (retained.history_exclusion_code) {
    if (
      retained.history_exclusion_code
        !== 'COMMERCE_ORDER_HISTORY_POLICY_EXCLUDED'
      || retained.history_excluded_external_order_id
        !== input.externalOrderId
      || !retained.captured_at
    ) {
      return null
    }
    return {
      status: 'excluded',
      code: retained.history_exclusion_code,
      providerReads: 0,
      providerWrites: 0,
    }
  }
  if (retained.observation_id) {
    if (retained.observation_external_order_id !== input.externalOrderId) {
      return null
    }
    if (!retained.captured_at) {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_HISTORY_REPLAY_INVALID',
        'Exact order-history replay evidence is incomplete',
        500,
      )
    }
    return {
      status: 'captured',
      code: null,
      providerReads: 0,
      providerWrites: 0,
    }
  }
  if (retained.captured_at) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_HISTORY_REPLAY_INVALID',
      'Exact order-history capture is missing its observation',
      500,
    )
  }
  if (!retained.released_at) {
    return {
      status: 'in_progress',
      code: 'COMMERCE_ORDER_HISTORY_REFRESH_IN_PROGRESS',
      providerReads: 0,
      providerWrites: 0,
    }
  }
  return {
    status: 'unavailable',
    code: retained.release_reason === 'completed'
      ? 'COMMERCE_ORDER_HISTORY_PREVIOUSLY_UNAVAILABLE'
      : 'COMMERCE_ORDER_HISTORY_PREVIOUS_ATTEMPT_FAILED',
    providerReads: 0,
    providerWrites: 0,
  }
}

type AccountRow = {
  integration_account_id: string
  provider: CommerceProvider
  status: 'active' | 'disabled' | 'error'
  commerce_credential_generation: number
  configuration: Record<string, unknown>
  external_account_id: string | null
  credential_external_account_id: string | null
  auth_mode: string
  verification_status: 'unverified' | 'verified' | 'failed'
  webhook_verification_status: 'unverified' | 'verified' | 'failed' | 'not_applicable'
  credential_version: number
  activation_state: string | null
  store_sync_running: boolean
  runtime_readable: boolean
  order_history_mode: CommerceOrderHistoryMode
  order_history_ingestion_floor: Date | null
  order_history_frozen_at: Date
}

async function lockAccount(
  client: PoolClient,
  organizationId: string,
  accountGlobalId: string,
) {
  const result = await client.query<AccountRow>(
    `SELECT account.id::text AS integration_account_id,
            account.provider, account.status,
            account.commerce_credential_generation,
            account.configuration, account.external_account_id,
            credential.external_account_id AS credential_external_account_id,
            credential.auth_mode,
            credential.verification_status,
            credential.webhook_verification_status,
            credential.credential_version,
            activation.state AS activation_state,
            ${STORE_SYNC_RUNNING_SQL} AS store_sync_running,
            ${ORDER_READ_ACCOUNT_SQL} AS runtime_readable,
            history.history_mode AS order_history_mode,
            history.ingestion_floor AS order_history_ingestion_floor,
            history.frozen_at AS order_history_frozen_at
     FROM operations_integration_accounts account
     LEFT JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
      AND credential.credential_version = account.commerce_credential_generation
     LEFT JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     LEFT JOIN operations_commerce_order_history_policies history
       ON history.organization_id = account.organization_id
      AND history.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider IN ('shopify', 'faire')
     LIMIT 1
     FOR UPDATE OF account`,
    [organizationId, accountGlobalId],
  )
  const account = result.rows[0]
  if (!account) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_ACCOUNT_NOT_FOUND',
      'The commerce connection is unavailable',
      404,
    )
  }
  if (!account.order_history_mode || !account.order_history_frozen_at) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_HISTORY_POLICY_MISSING',
      'The immutable order-history policy is unavailable',
      409,
    )
  }
  return account
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function commerceOrderHistoryWindow(account: AccountRow) {
  const requestedFrom = account.order_history_ingestion_floor?.toISOString()
    || commerceOrderHistoryRequestedFrom(
      account.order_history_mode,
      account.order_history_frozen_at,
    )?.toISOString()
    || null
  return {
    mode: account.order_history_mode,
    requestedFrom,
    coverageBasis: commerceOrderHistoryCoverageBasis(
      account.provider,
      account.order_history_mode,
    ),
  }
}

export async function requestCommerceOrderBackfillInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  actorEmail: string
  idempotencyKey: string
  reason: string
}) {
  const organizationId = text(input.organizationId, 'Organization ID', 64)
  if (!UUID_PATTERN.test(organizationId)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Organization ID is invalid',
      400,
    )
  }
  const accountGlobalId = text(input.accountGlobalId, 'Account Global ID', 32)
  const actorEmail = text(input.actorEmail, 'Actor email', 320).toLowerCase()
  const idempotencyKey = text(input.idempotencyKey, 'Idempotency key', 200, 8)
  const reason = text(input.reason, 'Backfill reason', 500, 10)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      commerceOrderSyncAccountLockKey({ organizationId, accountGlobalId }),
    )
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-backfill-request:${organizationId}:${accountGlobalId}`,
    )
    const account = await lockAccount(client, organizationId, accountGlobalId)
    const historyWindow = commerceOrderHistoryWindow(account)
    const requestHash = hash({
      policyVersion: POLICY_VERSION,
      accountGlobalId,
      provider: account.provider,
      credentialGeneration: account.commerce_credential_generation,
      orderHistoryMode: historyWindow.mode,
      requestedFrom: historyWindow.requestedFrom,
      reason,
      authority: 'provider',
      providerWrites: 0,
    })
    const existing = await client.query<{
      global_id: string
      request_hash: string
      status: string
      last_error_code: string | null
      provider: CommerceProvider
      credential_generation: number
      completed_at: Date | null
    }>(
      `SELECT global_id, request_hash, status, last_error_code,
              provider, credential_generation, completed_at
       FROM operations_commerce_order_backfill_sessions
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND idempotency_key = $3
       LIMIT 1`,
      [organizationId, account.integration_account_id, idempotencyKey],
    )
    if (existing.rows[0]) {
      if (
        existing.rows[0].request_hash !== requestHash
        || existing.rows[0].provider !== account.provider
        || existing.rows[0].credential_generation
          !== account.commerce_credential_generation
      ) {
        throw new CommerceOrderSyncError(
          'COMMERCE_ORDER_SYNC_IDEMPOTENCY_CONFLICT',
          'This retry key belongs to a different historical order request',
        )
      }
      return {
        globalId: existing.rows[0].global_id,
        provider: existing.rows[0].provider,
        status: existing.rows[0].status,
        blockerCode: existing.rows[0].last_error_code,
        replayed: true,
        providerWrites: 0 as const,
      }
    }
    const active = await client.query<{ global_id: string }>(
      `SELECT global_id
       FROM operations_commerce_order_backfill_sessions
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND status IN ('pending', 'processing', 'failed')
       LIMIT 1
       FOR UPDATE`,
      [organizationId, account.integration_account_id],
    )
    if (active.rows[0]) {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_SYNC_ALREADY_ACTIVE',
        'This connection already has an active historical order session',
      )
    }
    const readiness = commerceOrderHistoryReadiness({
      provider: account.provider,
      authMode: account.auth_mode,
      grantedScopes: stringArray(account.configuration.grantedScopes),
      requestedScopes: stringArray(account.configuration.requestedScopes),
    })
    const accountBlocker = account.status !== 'active'
      ? 'COMMERCE_ORDER_SYNC_ACCOUNT_INELIGIBLE'
      : account.verification_status !== 'verified'
        || account.credential_version
          !== account.commerce_credential_generation
        || account.credential_external_account_id
          !== account.external_account_id
        ? 'COMMERCE_ORDER_SYNC_CREDENTIAL_INELIGIBLE'
        : !account.store_sync_running
          ? 'COMMERCE_ORDER_SYNC_PAUSED'
          : null
    const blockerCode = accountBlocker || readiness.blockers[0] || null
    const webhookSubscriptions = jsonRecord(
      account.configuration.orderWebhookSubscriptions,
    )
    const currentShopifyEventProcessorReady = account.provider === 'shopify'
      && account.webhook_verification_status === 'verified'
      && webhookSubscriptions?.accountGlobalId === accountGlobalId
      && Number(webhookSubscriptions?.credentialGeneration)
        === account.commerce_credential_generation
      && webhookSubscriptions?.discoveryState === 'succeeded'
      && webhookSubscriptions?.ready === true
      && webhookSubscriptions?.subscriptionReady === true
      && webhookSubscriptions?.exactReadProcessorReady === true
    const clock = (
      await client.query<{ now: Date }>(
        `SELECT date_trunc('milliseconds', clock_timestamp()) AS now`,
      )
    ).rows[0].now.toISOString()
    const requestedFrom = historyWindow.requestedFrom
    const policy = await client.query<{ revision: number }>(
      `INSERT INTO operations_commerce_order_sync_policies (
         organization_id, integration_account_id,
         historical_observation_enabled, continuous_observation_enabled,
         continuous_transport, provider_event_processor_state, revision,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, true, true, 'scheduled_poll', $3, 1, $4, $4
       )
       ON CONFLICT (organization_id, integration_account_id)
       DO UPDATE SET
         historical_observation_enabled = true,
         continuous_observation_enabled = true,
         continuous_transport = CASE
           WHEN $5 = 'shopify'
             AND $6::boolean
             AND EXCLUDED.continuous_transport = 'scheduled_poll'
             AND EXCLUDED.provider_event_processor_state = 'processor_pending'
             AND operations_commerce_order_sync_policies.continuous_transport
               = 'webhook_signal_plus_poll'
             AND operations_commerce_order_sync_policies
               .provider_event_processor_state = 'available'
           THEN 'webhook_signal_plus_poll'
           ELSE 'scheduled_poll'
         END,
         provider_event_processor_state = CASE
           WHEN $5 = 'shopify'
             AND $6::boolean
             AND EXCLUDED.continuous_transport = 'scheduled_poll'
             AND EXCLUDED.provider_event_processor_state = 'processor_pending'
             AND operations_commerce_order_sync_policies.continuous_transport
               = 'webhook_signal_plus_poll'
             AND operations_commerce_order_sync_policies
               .provider_event_processor_state = 'available'
           THEN 'available'
           ELSE EXCLUDED.provider_event_processor_state
         END,
         created_by = COALESCE(
           operations_commerce_order_sync_policies.created_by,
           EXCLUDED.created_by
         ),
         revision = operations_commerce_order_sync_policies.revision + 1,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING revision`,
      [
        organizationId,
        account.integration_account_id,
        readiness.providerEventProcessorState,
        actorEmail,
        account.provider,
        currentShopifyEventProcessorReady,
      ],
    )
    const queryHash = hash({
      policyVersion: POLICY_VERSION,
      provider: account.provider,
      credentialGeneration: account.commerce_credential_generation,
      coverageBasis: historyWindow.coverageBasis,
      readAllOrdersConfigured:
        'readAllOrdersGranted' in readiness
          ? readiness.readAllOrdersGranted
          : false,
      requestedFrom,
      requestedThrough: clock,
      includeTerminalOrders: true,
      providerWrites: 0,
    })
    const inserted = await client.query<{
      global_id: string
      status: string
    }>(
      `INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider,
         credential_generation, policy_revision, coverage_basis,
         read_all_orders_scope_observed, return_history_state, status,
         requested_from, requested_through, last_error_code,
         idempotency_key, request_hash, query_hash, requested_by, reason,
         completed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, NULL, 'unknown', $7,
         $8::timestamptz, $9::timestamptz, $10, $11, $12, $13,
         $14, $15,
         CASE WHEN $7 = 'blocked' THEN now() ELSE NULL END
       )
       RETURNING global_id, status`,
      [
        organizationId,
        account.integration_account_id,
        account.provider,
        account.commerce_credential_generation,
        policy.rows[0].revision,
        historyWindow.coverageBasis,
        blockerCode ? 'blocked' : 'pending',
        requestedFrom,
        clock,
        blockerCode,
        idempotencyKey,
        requestHash,
        queryHash,
        actorEmail,
        reason,
      ],
    )
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'commerce.order_history.requested',
      aggregateType: 'operations.commerce_order_backfill_session',
      aggregateId: inserted.rows[0].global_id,
      organizationId,
      eventKey: `commerce-order-history:${inserted.rows[0].global_id}`,
      payload: {
        accountGlobalId,
        provider: account.provider,
        status: inserted.rows[0].status,
        blockerCode,
        coverageBasis: historyWindow.coverageBasis,
        orderHistoryMode: historyWindow.mode,
        readAllOrdersConfigured:
          'readAllOrdersGranted' in readiness
            ? readiness.readAllOrdersGranted
            : false,
        requestedFrom,
        requestedThrough: clock,
        providerWrites: 0,
      },
    }, client)
    return {
      globalId: inserted.rows[0].global_id,
      provider: account.provider,
      status: inserted.rows[0].status,
      blockerCode,
      replayed: false,
      providerWrites: 0 as const,
    }
  })
}

export type CommerceOrderHistoryScheduleAllResult = Readonly<{
  totalEligibleAccounts: number
  scheduledAccounts: number
  alreadyScheduledAccounts: number
  deferredAccounts: number
  newSessions: number
  resumedSessions: number
  newDeferredRefreshes: number
  alreadyDeferredRefreshes: number
  providerWrites: 0
}>

type CommerceOrderHistoryScheduleReceiptRow = {
  request_hash: string
  status: 'processing' | 'succeeded' | 'failed'
  result_payload: unknown
}

function nonnegativeSafeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validatedCommerceOrderHistoryScheduleAllResult(
  value: unknown,
): CommerceOrderHistoryScheduleAllResult {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  const legacyDeferredShape = Boolean(record)
    && record?.deferredAccounts === undefined
    && record?.newDeferredRefreshes === undefined
    && record?.alreadyDeferredRefreshes === undefined
  const deferredAccounts = legacyDeferredShape ? 0 : record?.deferredAccounts
  const newDeferredRefreshes = legacyDeferredShape
    ? 0
    : record?.newDeferredRefreshes
  const alreadyDeferredRefreshes = legacyDeferredShape
    ? 0
    : record?.alreadyDeferredRefreshes
  if (
    !record
    || !nonnegativeSafeInteger(record.totalEligibleAccounts)
    || !nonnegativeSafeInteger(record.scheduledAccounts)
    || !nonnegativeSafeInteger(record.alreadyScheduledAccounts)
    || !nonnegativeSafeInteger(deferredAccounts)
    || !nonnegativeSafeInteger(record.newSessions)
    || !nonnegativeSafeInteger(record.resumedSessions)
    || !nonnegativeSafeInteger(newDeferredRefreshes)
    || !nonnegativeSafeInteger(alreadyDeferredRefreshes)
    || Number(record.totalEligibleAccounts)
      !== Number(record.scheduledAccounts)
        + Number(record.alreadyScheduledAccounts)
        + Number(deferredAccounts)
    || Number(record.scheduledAccounts)
      !== Number(record.newSessions) + Number(record.resumedSessions)
    || Number(deferredAccounts)
      !== Number(newDeferredRefreshes)
        + Number(alreadyDeferredRefreshes)
    || record.providerWrites !== 0
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_HISTORY_SCHEDULE_ALL_RESULT_INVALID',
      'The retained provider-history refresh schedule is invalid',
      500,
    )
  }
  return Object.freeze({
    totalEligibleAccounts: Number(record.totalEligibleAccounts),
    scheduledAccounts: Number(record.scheduledAccounts),
    alreadyScheduledAccounts: Number(record.alreadyScheduledAccounts),
    deferredAccounts: Number(deferredAccounts),
    newSessions: Number(record.newSessions),
    resumedSessions: Number(record.resumedSessions),
    newDeferredRefreshes: Number(newDeferredRefreshes),
    alreadyDeferredRefreshes: Number(alreadyDeferredRefreshes),
    providerWrites: 0,
  })
}

type CommerceOrderHistorySchedulePolicyRow = {
  revision: number
  authority: string
  historical_observation_enabled: boolean
  continuous_observation_enabled: boolean
  historical_refresh_requested_at: Date | null
  historical_refresh_requested_by: string | null
  historical_refresh_idempotency_key: string | null
}

type CommerceOrderHistoryActiveSessionRow = {
  id: string
  provider: CommerceProvider
  session_kind: 'historical_backfill' | 'continuous_poll'
  credential_generation: number
  policy_revision: number
  status: 'pending' | 'processing' | 'failed'
  attempt_count: number
  max_attempts: number
  page_count: number
  max_pages: number
  available_now: boolean
  lease_current: boolean
}

function commerceOrderHistoryAccountEligible(account: AccountRow) {
  const readiness = commerceOrderHistoryReadiness({
    provider: account.provider,
    authMode: account.auth_mode,
    grantedScopes: stringArray(account.configuration.grantedScopes),
    requestedScopes: stringArray(account.configuration.requestedScopes),
  })
  return {
    eligible: account.runtime_readable
      && account.status === 'active'
      && account.external_account_id !== null
      && account.credential_external_account_id === account.external_account_id
      && account.verification_status === 'verified'
      && account.credential_version === account.commerce_credential_generation
      && account.store_sync_running
      && readiness.currentOrdersReadable,
    readiness,
  }
}

function commerceOrderHistorySessionLineageCurrent(input: {
  active: CommerceOrderHistoryActiveSessionRow
  account: AccountRow
  policy: CommerceOrderHistorySchedulePolicyRow | null
}) {
  const { active, account, policy } = input
  return Boolean(policy)
    && policy?.authority === 'provider'
    && active.provider === account.provider
    && active.credential_generation === account.commerce_credential_generation
    && active.policy_revision === policy?.revision
    && (
      active.session_kind === 'historical_backfill'
        ? policy?.historical_observation_enabled
        : policy?.continuous_observation_enabled
    )
}

function commerceOrderHistorySessionExhausted(
  active: CommerceOrderHistoryActiveSessionRow,
) {
  // attempt_count includes the currently leased attempt. It is exhausted only
  // after that final lease is no longer valid; otherwise the provider result
  // must be allowed to commit against its existing token.
  return active.page_count >= active.max_pages
    || (
      active.attempt_count >= active.max_attempts
      && !(active.status === 'processing' && active.lease_current)
    )
}

async function terminalizeUnusableCommerceOrderHistorySessionWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    active: CommerceOrderHistoryActiveSessionRow
    staleAuthority: boolean
  },
) {
  const errorCode = input.staleAuthority
    ? 'COMMERCE_ORDER_SYNC_AUTHORITY_STALE'
    : input.active.page_count >= input.active.max_pages
      ? 'COMMERCE_ORDER_SYNC_PAGE_LIMIT'
      : 'COMMERCE_ORDER_SYNC_RETRY_EXHAUSTED'
  const status = input.staleAuthority ? 'blocked' : 'dead'
  const result = await client.query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = $3,
         last_error_code = $4,
         cursor_ciphertext = NULL,
         cursor_iv = NULL,
         cursor_tag = NULL,
         cursor_key_id = NULL,
         cursor_hash = NULL,
         cursor_encryption_version = NULL,
         cursor_aad_version = NULL,
         locked_at = NULL,
         locked_by = NULL,
         lock_token = NULL,
         lease_expires_at = NULL,
         completed_at = clock_timestamp(),
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND status IN ('pending', 'processing', 'failed')`,
    [input.organizationId, input.active.id, status, errorCode],
  )
  if (result.rowCount !== 1) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_HISTORY_SCHEDULE_ALL_SESSION_CHANGED',
      'A provider-history session changed while it was being replaced',
    )
  }
}

async function createCommerceOrderHistoricalRefreshWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    accountGlobalId: string
    account: AccountRow
    policy: CommerceOrderHistorySchedulePolicyRow | null
    actorEmail: string
    idempotencyKey: string
    clock: Date
  },
) {
  const readiness = commerceOrderHistoryReadiness({
    provider: input.account.provider,
    authMode: input.account.auth_mode,
    grantedScopes: stringArray(input.account.configuration.grantedScopes),
    requestedScopes: stringArray(input.account.configuration.requestedScopes),
  })
  const historyWindow = commerceOrderHistoryWindow(input.account)
  const policyRevision = input.policy
    ? (
        await client.query<{ revision: number }>(
          `UPDATE operations_commerce_order_sync_policies
           SET historical_observation_enabled = true,
               continuous_observation_enabled = true,
               continuous_next_poll_at = LEAST(
                 continuous_next_poll_at,
                 now()
               ),
               historical_refresh_requested_at = NULL,
               historical_refresh_requested_by = NULL,
               historical_refresh_idempotency_key = NULL,
               revision = revision + 1,
               updated_by = $3,
               updated_at = now()
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND authority = 'provider'
           RETURNING revision`,
          [
            input.organizationId,
            input.account.integration_account_id,
            input.actorEmail,
          ],
        )
      ).rows[0]?.revision
    : (
        await client.query<{ revision: number }>(
          `INSERT INTO operations_commerce_order_sync_policies (
             organization_id, integration_account_id,
             historical_observation_enabled,
             continuous_observation_enabled, continuous_transport,
             provider_event_processor_state, revision,
             continuous_next_poll_at, created_by, updated_by
           ) VALUES (
             $1::uuid, $2::uuid, true, true, 'scheduled_poll', $3,
             1, now(), $4, $4
           )
           RETURNING revision`,
          [
            input.organizationId,
            input.account.integration_account_id,
            readiness.providerEventProcessorState,
            input.actorEmail,
          ],
        )
      ).rows[0]?.revision
  if (!Number.isSafeInteger(policyRevision) || Number(policyRevision) < 1) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_HISTORY_SCHEDULE_ALL_POLICY_LOST',
      'Provider-history refresh authority changed while it was being scheduled',
    )
  }
  const requestedThrough = input.clock.toISOString()
  const requestedFrom = historyWindow.requestedFrom
  const sessionIdempotencyKey =
    `refresh-all:${input.idempotencyKey}:${input.accountGlobalId}`
  const requestHash = hash({
    policyVersion: POLICY_VERSION,
    action: 'schedule_all_commerce_order_history_refreshes',
    accountGlobalId: input.accountGlobalId,
    provider: input.account.provider,
    credentialGeneration: input.account.commerce_credential_generation,
    orderHistoryMode: historyWindow.mode,
    requestedFrom,
    authority: 'provider',
    providerWrites: 0,
  })
  const queryHash = hash({
    policyVersion: POLICY_VERSION,
    provider: input.account.provider,
    credentialGeneration: input.account.commerce_credential_generation,
    coverageBasis: historyWindow.coverageBasis,
    readAllOrdersConfigured:
      'readAllOrdersGranted' in readiness
        ? readiness.readAllOrdersGranted
        : false,
    requestedFrom,
    requestedThrough,
    includeTerminalOrders: true,
    providerWrites: 0,
  })
  const inserted = await client.query(
    `INSERT INTO operations_commerce_order_backfill_sessions (
       organization_id, integration_account_id, provider,
       credential_generation, policy_revision, coverage_basis,
       read_all_orders_scope_observed, return_history_state, status,
       requested_from, requested_through, idempotency_key, request_hash,
       query_hash, requested_by, reason
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, NULL, 'unknown', 'pending',
       $7::timestamptz, $8::timestamptz, $9, $10, $11, $12,
       'Refresh all provider-authoritative order history'
     )`,
    [
      input.organizationId,
      input.account.integration_account_id,
      input.account.provider,
      input.account.commerce_credential_generation,
      policyRevision,
      historyWindow.coverageBasis,
      requestedFrom,
      requestedThrough,
      sessionIdempotencyKey,
      requestHash,
      queryHash,
      input.actorEmail,
    ],
  )
  if (inserted.rowCount !== 1) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_HISTORY_SCHEDULE_ALL_NOT_QUEUED',
      'A provider-history refresh session was not queued',
      500,
    )
  }
}

/**
 * Enqueues a bounded provider-authoritative history pass for every currently
 * readable commerce account in one organization. Existing claimable sessions
 * remain authoritative and are resumed when retry backoff delayed them; a new
 * historical session is created only when the account has no active session.
 *
 * This is scheduling only. Provider reads remain in the existing history
 * worker and every provider-write count remains zero.
 */
export async function scheduleAllCommerceOrderHistoryRefreshesInPostgres(
  input: {
    organizationId: string
    actorEmail: string
    idempotencyKey: string
  },
): Promise<CommerceOrderHistoryScheduleAllResult> {
  const organizationId = text(input.organizationId, 'Organization ID', 64)
  if (!UUID_PATTERN.test(organizationId)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_HISTORY_SCHEDULE_ALL_INVALID',
      'Provider-history refresh schedule input is invalid',
      400,
    )
  }
  const actorEmail = text(input.actorEmail, 'Actor email', 320).toLowerCase()
  const idempotencyKey = text(
    input.idempotencyKey,
    'Idempotency key',
    120,
    8,
  )
  const requestHash = hash({
    action: 'schedule_all_commerce_order_history_refreshes',
    organizationId,
    actorEmail,
    providerWrites: 0,
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-history-schedule-all:${organizationId}`,
    )
    const existing = await client.query<CommerceOrderHistoryScheduleReceiptRow>(
      `SELECT request_hash, status, result_payload
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = 'operations.commerce_order_history.schedule_all'
         AND idempotency_key = $2
       FOR UPDATE`,
      [organizationId, idempotencyKey],
    )
    const receipt = existing.rows[0] || null
    if (receipt && receipt.request_hash !== requestHash) {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_HISTORY_SCHEDULE_ALL_IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used for a different provider-history refresh schedule',
      )
    }
    if (receipt?.status === 'succeeded') {
      return validatedCommerceOrderHistoryScheduleAllResult(
        receipt.result_payload,
      )
    }
    if (receipt?.status === 'processing') {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_HISTORY_SCHEDULE_ALL_IN_PROGRESS',
        'This exact provider-history refresh schedule is already in progress',
      )
    }
    if (receipt?.status === 'failed') {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_HISTORY_SCHEDULE_ALL_PREVIOUSLY_FAILED',
        'This provider-history refresh schedule previously failed. Retry with a new Idempotency-Key.',
      )
    }

    const candidateAccounts = await client.query<{ account_global_id: string }>(
      `SELECT account.global_id AS account_global_id
       FROM operations_integration_accounts account
       WHERE account.organization_id = $1::uuid
         AND account.integration_type = 'commerce'
         AND account.provider IN ('shopify', 'faire')
       ORDER BY account.global_id`,
      [organizationId],
    )
    const clock = (
      await client.query<{ now: Date }>(
        `SELECT date_trunc('milliseconds', clock_timestamp()) AS now`,
      )
    ).rows[0].now
    let totalEligibleAccounts = 0
    let newSessions = 0
    let resumedSessions = 0
    let alreadyScheduledAccounts = 0
    let newDeferredRefreshes = 0
    let alreadyDeferredRefreshes = 0

    for (const candidate of candidateAccounts.rows) {
      await acquireTransactionAdvisoryLock(
        client,
        commerceOrderSyncAccountLockKey({
          organizationId,
          accountGlobalId: candidate.account_global_id,
        }),
      )
      await acquireTransactionAdvisoryLock(
        client,
        `commerce-order-backfill-request:${organizationId}:${candidate.account_global_id}`,
      )
      const account = await lockAccount(
        client,
        organizationId,
        candidate.account_global_id,
      )
      const eligibility = commerceOrderHistoryAccountEligible(account)
      if (!eligibility.eligible) continue
      totalEligibleAccounts += 1

      const policy = (
        await client.query<CommerceOrderHistorySchedulePolicyRow>(
          `SELECT revision, authority, historical_observation_enabled,
                  continuous_observation_enabled,
                  historical_refresh_requested_at,
                  historical_refresh_requested_by,
                  historical_refresh_idempotency_key
           FROM operations_commerce_order_sync_policies
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
           FOR UPDATE`,
          [organizationId, account.integration_account_id],
        )
      ).rows[0] || null
      let active: CommerceOrderHistoryActiveSessionRow | null = (
        await client.query<CommerceOrderHistoryActiveSessionRow>(
          `SELECT id::text, provider, session_kind,
                  credential_generation, policy_revision, status,
                  attempt_count, max_attempts, page_count, max_pages,
                  available_at <= clock_timestamp() AS available_now,
                  COALESCE(lease_expires_at > clock_timestamp(), false)
                    AS lease_current
           FROM operations_commerce_order_backfill_sessions
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND status IN ('pending', 'processing', 'failed')
           LIMIT 1
           FOR UPDATE`,
          [organizationId, account.integration_account_id],
        )
      ).rows[0] || null

      if (active) {
        const lineageCurrent = commerceOrderHistorySessionLineageCurrent({
          active,
          account,
          policy,
        })
        const exhausted = commerceOrderHistorySessionExhausted(active)
        if (!lineageCurrent || exhausted) {
          await terminalizeUnusableCommerceOrderHistorySessionWithClient(
            client,
            {
              organizationId,
              active,
              staleAuthority: !lineageCurrent,
            },
          )
          active = null
        }
      }

      if (active?.session_kind === 'continuous_poll') {
        if (policy?.historical_refresh_requested_at) {
          alreadyDeferredRefreshes += 1
        } else {
          const deferred = await client.query(
            `UPDATE operations_commerce_order_sync_policies
             SET historical_refresh_requested_at = $3::timestamptz,
                 historical_refresh_requested_by = $4,
                 historical_refresh_idempotency_key = $5,
                 updated_by = $4,
                 updated_at = now()
             WHERE organization_id = $1::uuid
               AND integration_account_id = $2::uuid
               AND authority = 'provider'
               AND historical_refresh_requested_at IS NULL`,
            [
              organizationId,
              account.integration_account_id,
              clock.toISOString(),
              actorEmail,
              idempotencyKey,
            ],
          )
          if (deferred.rowCount !== 1) {
            throw new CommerceOrderSyncError(
              'COMMERCE_ORDER_HISTORY_SCHEDULE_ALL_DEFER_LOST',
              'A provider-history follow-up changed while it was being retained',
            )
          }
          newDeferredRefreshes += 1
        }
        continue
      }

      if (active) {
        if (
          (active.status === 'processing' && active.lease_current)
          || (active.status !== 'processing' && active.available_now)
        ) {
          alreadyScheduledAccounts += 1
          continue
        }
        const resumed = active.status === 'processing'
          ? await client.query(
              `UPDATE operations_commerce_order_backfill_sessions
               SET status = 'failed',
                   last_error_code = 'COMMERCE_ORDER_SYNC_LEASE_EXPIRED',
                   available_at = now(),
                   locked_at = NULL,
                   locked_by = NULL,
                   lock_token = NULL,
                   lease_expires_at = NULL,
                   completed_at = NULL,
                   updated_at = now()
               WHERE organization_id = $1::uuid
                 AND id = $2::uuid
                 AND status = 'processing'
                 AND lease_expires_at <= clock_timestamp()
                 AND attempt_count < max_attempts
                 AND page_count < max_pages`,
              [organizationId, active.id],
            )
          : await client.query(
              `UPDATE operations_commerce_order_backfill_sessions
               SET available_at = now(), updated_at = now()
               WHERE organization_id = $1::uuid
                 AND id = $2::uuid
                 AND status IN ('pending', 'failed')
                 AND attempt_count < max_attempts
                 AND page_count < max_pages`,
              [organizationId, active.id],
            )
        if (resumed.rowCount !== 1) {
          throw new CommerceOrderSyncError(
            'COMMERCE_ORDER_HISTORY_SCHEDULE_ALL_RESUME_LOST',
            'A provider-history session changed while it was being resumed',
          )
        }
        resumedSessions += 1
        continue
      }

      await createCommerceOrderHistoricalRefreshWithClient(client, {
        organizationId,
        accountGlobalId: candidate.account_global_id,
        account,
        policy,
        actorEmail: policy?.historical_refresh_requested_by || actorEmail,
        idempotencyKey:
          policy?.historical_refresh_idempotency_key || idempotencyKey,
        clock,
      })
      newSessions += 1
    }

    const scheduledAccounts = newSessions + resumedSessions
    const deferredAccounts =
      newDeferredRefreshes + alreadyDeferredRefreshes
    const result = validatedCommerceOrderHistoryScheduleAllResult({
      totalEligibleAccounts,
      scheduledAccounts,
      alreadyScheduledAccounts,
      deferredAccounts,
      newSessions,
      resumedSessions,
      newDeferredRefreshes,
      alreadyDeferredRefreshes,
      providerWrites: 0,
    })
    const retained = await client.query(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id, result_payload, completed_at
       ) VALUES (
         $1::uuid, 'operations.commerce_order_history.schedule_all', $2, $3,
         $4, 'succeeded', $5::uuid, $6::jsonb, now()
       )`,
      [
        organizationId,
        idempotencyKey,
        requestHash,
        actorEmail,
        randomUUID(),
        JSON.stringify(result),
      ],
    )
    if (retained.rowCount !== 1) {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_HISTORY_SCHEDULE_ALL_NOT_RETAINED',
        'The provider-history refresh schedule was not retained',
        500,
      )
    }
    return result
  })
}

export async function materializeDeferredCommerceOrderHistoryRefreshesInPostgres(
  input: { limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(Number(input.limit || 1), 5))
  return withTransaction(async (client) => {
    const candidates = await client.query<{
      organization_id: string
      account_global_id: string
    }>(
      `SELECT policy.organization_id::text,
              account.global_id AS account_global_id
       FROM operations_commerce_order_sync_policies policy
       JOIN operations_integration_accounts account
         ON account.organization_id = policy.organization_id
        AND account.id = policy.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version
            = account.commerce_credential_generation
        AND credential.external_account_id = account.external_account_id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = policy.organization_id
       WHERE policy.historical_refresh_requested_at IS NOT NULL
         AND policy.authority = 'provider'
         AND ${ORDER_READ_ACCOUNT_SQL}
         AND credential.verification_status = 'verified'
         AND (
           (account.provider = 'shopify'
             AND credential.auth_mode = 'shopify_client_credentials'
             AND (
               COALESCE(account.configuration->'grantedScopes', '[]'::jsonb)
                 ? 'read_orders'
               OR COALESCE(
                 account.configuration->'grantedScopes', '[]'::jsonb
               ) ? 'write_orders'
             ))
           OR (account.provider = 'faire'
             AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth')
             AND (
               credential.auth_mode = 'faire_brand_token'
               OR COALESCE(
                 account.configuration->'requestedScopes', '[]'::jsonb
               ) ? 'READ_ORDERS'
             ))
         )
         AND ${STORE_SYNC_RUNNING_SQL}
         AND NOT EXISTS (
           SELECT 1
           FROM operations_commerce_order_backfill_sessions active
           WHERE active.organization_id = policy.organization_id
             AND active.integration_account_id = policy.integration_account_id
             AND active.status IN ('pending', 'processing', 'failed')
         )
       ORDER BY policy.historical_refresh_requested_at,
                policy.organization_id,
                policy.integration_account_id
       LIMIT $1`,
      [limit],
    )
    let materialized = 0
    let skipped = 0
    for (const candidate of candidates.rows) {
      await acquireTransactionAdvisoryLock(
        client,
        commerceOrderSyncAccountLockKey({
          organizationId: candidate.organization_id,
          accountGlobalId: candidate.account_global_id,
        }),
      )
      await acquireTransactionAdvisoryLock(
        client,
        `commerce-order-backfill-request:${candidate.organization_id}:${candidate.account_global_id}`,
      )
      const account = await lockAccount(
        client,
        candidate.organization_id,
        candidate.account_global_id,
      )
      const eligibility = commerceOrderHistoryAccountEligible(account)
      const policy = (
        await client.query<CommerceOrderHistorySchedulePolicyRow>(
          `SELECT revision, authority, historical_observation_enabled,
                  continuous_observation_enabled,
                  historical_refresh_requested_at,
                  historical_refresh_requested_by,
                  historical_refresh_idempotency_key
           FROM operations_commerce_order_sync_policies
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
           FOR UPDATE`,
          [candidate.organization_id, account.integration_account_id],
        )
      ).rows[0] || null
      if (
        !eligibility.eligible
        || !policy?.historical_refresh_requested_at
        || !policy.historical_refresh_requested_by
        || !policy.historical_refresh_idempotency_key
      ) {
        skipped += 1
        continue
      }
      const active = await client.query(
        `SELECT 1
         FROM operations_commerce_order_backfill_sessions
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND status IN ('pending', 'processing', 'failed')
         LIMIT 1
         FOR UPDATE`,
        [candidate.organization_id, account.integration_account_id],
      )
      if (active.rows[0]) {
        skipped += 1
        continue
      }
      const clock = (
        await client.query<{ now: Date }>(
          `SELECT date_trunc('milliseconds', clock_timestamp()) AS now`,
        )
      ).rows[0].now
      await createCommerceOrderHistoricalRefreshWithClient(client, {
        organizationId: candidate.organization_id,
        accountGlobalId: candidate.account_global_id,
        account,
        policy,
        actorEmail: policy.historical_refresh_requested_by,
        idempotencyKey: policy.historical_refresh_idempotency_key,
        clock,
      })
      materialized += 1
    }
    return {
      materialized,
      skipped,
      providerWrites: 0 as const,
    }
  })
}

export type CommerceOrderBackfillJob = {
  id: string
  globalId: string
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  provider: CommerceProvider
  sessionKind: 'historical_backfill' | 'continuous_poll'
  credentialGeneration: number
  policyRevision: number
  requestedFrom: string | null
  requestedThrough: string
  queryHash: string
  pageCount: number
  attemptCount: number
  maxAttempts: number
  maxPages: number
  lockToken: string
}

export async function ensureContinuousCommerceOrderPollsInPostgres(input: {
  limit?: number
}) {
  const limit = Math.max(1, Math.min(Number(input.limit || 1), 5))
  return withTransaction(async (client) => {
    const candidates = await client.query<{
      organization_id: string
      integration_account_id: string
      account_global_id: string
      provider: CommerceProvider
      credential_generation: number
      policy_revision: number
      continuous_high_watermark: Date
      created_by: string
      configuration: Record<string, unknown>
      history_mode: CommerceOrderHistoryMode
      ingestion_floor: Date | null
      clock: Date
    }>(
      `SELECT policy.organization_id::text,
              policy.integration_account_id::text,
              account.global_id AS account_global_id,
              account.provider,
              account.commerce_credential_generation
                AS credential_generation,
              policy.revision AS policy_revision,
              policy.continuous_high_watermark,
              COALESCE(policy.updated_by, policy.created_by) AS created_by,
              account.configuration,
              history.history_mode,
              history.ingestion_floor,
              date_trunc('milliseconds', clock_timestamp()) AS clock
       FROM operations_commerce_order_sync_policies policy
       JOIN operations_integration_accounts account
         ON account.organization_id = policy.organization_id
        AND account.id = policy.integration_account_id
       JOIN operations_commerce_order_history_policies history
         ON history.organization_id = account.organization_id
        AND history.integration_account_id = account.id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version
            = account.commerce_credential_generation
        AND credential.external_account_id = account.external_account_id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = policy.organization_id
       WHERE policy.authority = 'provider'
         AND policy.continuous_observation_enabled
         AND policy.historical_refresh_requested_at IS NULL
         AND policy.continuous_high_watermark IS NOT NULL
         AND policy.continuous_next_poll_at <= now()
         AND COALESCE(policy.updated_by, policy.created_by) IS NOT NULL
         AND ${ORDER_READ_ACCOUNT_SQL}
         AND credential.verification_status = 'verified'
         AND (
           (account.provider = 'shopify'
             AND credential.auth_mode = 'shopify_client_credentials')
           OR (account.provider = 'faire'
             AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
         )
         AND ${STORE_SYNC_RUNNING_SQL}
         AND (
           (account.provider = 'shopify' AND (
             COALESCE(account.configuration->'grantedScopes', '[]'::jsonb)
               ? 'read_orders'
             OR COALESCE(account.configuration->'grantedScopes', '[]'::jsonb)
               ? 'write_orders'
           ))
           OR (account.provider = 'faire' AND (
             credential.auth_mode = 'faire_brand_token'
             OR COALESCE(account.configuration->'requestedScopes', '[]'::jsonb)
               ? 'READ_ORDERS'
           ))
         )
         AND NOT EXISTS (
           SELECT 1
           FROM operations_commerce_order_backfill_sessions active
           WHERE active.organization_id = policy.organization_id
             AND active.integration_account_id = policy.integration_account_id
             AND active.status IN ('pending', 'processing', 'failed')
         )
       ORDER BY policy.continuous_next_poll_at,
                policy.organization_id, policy.integration_account_id
       FOR UPDATE OF policy SKIP LOCKED
       LIMIT $1`,
      [limit],
    )
    let scheduled = 0
    for (const candidate of candidates.rows) {
      const through = candidate.clock.toISOString()
      const highWatermark = candidate.continuous_high_watermark.getTime()
      const overlapMs = candidate.provider === 'shopify'
        ? 15 * 60 * 1_000
        : 60 * 60 * 1_000
      const earliest = candidate.ingestion_floor?.getTime() || 0
      const providerReadableFloor = candidate.provider === 'shopify'
        ? candidate.clock.getTime() - 60 * 24 * 60 * 60 * 1_000
        : 0
      const from = new Date(Math.max(
        highWatermark - overlapMs,
        earliest,
        providerReadableFloor,
      ))
        .toISOString()
      const coverageBasis = candidate.provider === 'shopify'
        ? 'shopify_updated_at_overlap'
        : 'faire_updated_at_overlap_unfenced'
      const requestHash = hash({
        policyVersion: POLICY_VERSION,
        sessionKind: 'continuous_poll',
        accountGlobalId: candidate.account_global_id,
        requestedFrom: from,
        requestedThrough: through,
        providerWrites: 0,
      })
      const queryHash = hash({
        policyVersion: POLICY_VERSION,
        sessionKind: 'continuous_poll',
        provider: candidate.provider,
        credentialGeneration: candidate.credential_generation,
        coverageBasis,
        requestedFrom: from,
        requestedThrough: through,
        includeTerminalOrders: true,
        providerWrites: 0,
      })
      const inserted = await client.query(
        `INSERT INTO operations_commerce_order_backfill_sessions (
           organization_id, integration_account_id, provider, session_kind,
           read_all_orders_scope_observed, return_history_state,
           credential_generation,
           policy_revision, coverage_basis, status, requested_from,
           requested_through, idempotency_key, request_hash, query_hash,
           requested_by, reason
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'continuous_poll', NULL, 'unknown',
           $4, $5, $6, 'pending', $7::timestamptz, $8::timestamptz,
           $9, $10, $11, $12,
           'Scheduled provider-authoritative order observation'
         ) ON CONFLICT DO NOTHING`,
        [
          candidate.organization_id,
          candidate.integration_account_id,
          candidate.provider,
          candidate.credential_generation,
          candidate.policy_revision,
          coverageBasis,
          from,
          through,
          `continuous:${candidate.account_global_id}:${through}`,
          requestHash,
          queryHash,
          candidate.created_by,
        ],
      )
      scheduled += Number(inserted.rowCount || 0)
    }
    return { scheduled, providerWrites: 0 as const }
  })
}

export async function claimCommerceOrderBackfillsInPostgres(input: {
  workerId: string
  limit?: number
}) {
  const workerId = text(input.workerId, 'Worker ID', 200)
  const limit = Math.max(1, Math.min(Number(input.limit || 1), 5))
  const result = await query<{
    id: string
    global_id: string
    organization_id: string
    integration_account_id: string
    account_global_id: string
    provider: CommerceProvider
    session_kind: 'historical_backfill' | 'continuous_poll'
    credential_generation: number
    policy_revision: number
    requested_from: Date | null
    requested_through: Date
    query_hash: string
    page_count: number
    attempt_count: number
    max_attempts: number
    max_pages: number
    lock_token: string
  }>(
    `WITH stale_candidates AS (
       SELECT session.id
       FROM operations_commerce_order_backfill_sessions session
       WHERE session.status IN ('pending', 'processing', 'failed')
         AND NOT EXISTS (
           SELECT 1
           FROM operations_integration_accounts account
           JOIN operations_commerce_credentials credential
             ON credential.organization_id = account.organization_id
            AND credential.integration_account_id = account.id
            AND credential.credential_version
                = account.commerce_credential_generation
            AND credential.external_account_id = account.external_account_id
            AND credential.verification_status = 'verified'
            AND (
              (account.provider = 'shopify'
                AND credential.auth_mode = 'shopify_client_credentials')
              OR (account.provider = 'faire'
                AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
            )
           JOIN operations_commerce_order_sync_policies policy
             ON policy.organization_id = account.organization_id
            AND policy.integration_account_id = account.id
            AND policy.revision = session.policy_revision
            AND policy.authority = 'provider'
           JOIN operations_activation_scopes activation
             ON activation.organization_id = account.organization_id
           WHERE account.organization_id = session.organization_id
             AND account.id = session.integration_account_id
             AND account.integration_type = 'commerce'
             AND account.provider = session.provider
             AND account.commerce_credential_generation
                 = session.credential_generation
             AND ${ORDER_READ_ACCOUNT_SQL}
             AND (
               (session.session_kind = 'historical_backfill'
                 AND policy.historical_observation_enabled)
               OR (session.session_kind = 'continuous_poll'
                 AND policy.continuous_observation_enabled)
             )
         )
       ORDER BY session.created_at, session.id
       FOR UPDATE OF session SKIP LOCKED
       LIMIT $1
     ), stale_terminalized AS (
       UPDATE operations_commerce_order_backfill_sessions stale
       SET status = 'blocked',
           last_error_code = 'COMMERCE_ORDER_SYNC_AUTHORITY_STALE',
           cursor_ciphertext = NULL,
           cursor_iv = NULL,
           cursor_tag = NULL,
           cursor_key_id = NULL,
           cursor_hash = NULL,
           cursor_encryption_version = NULL,
           cursor_aad_version = NULL,
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           completed_at = now(),
           updated_at = now()
       FROM stale_candidates
       WHERE stale.id = stale_candidates.id
       RETURNING stale.id
     ), terminalized AS (
       UPDATE operations_commerce_order_backfill_sessions expired
       SET status = 'dead',
           last_error_code = CASE
             WHEN expired.page_count >= expired.max_pages
               THEN 'COMMERCE_ORDER_SYNC_PAGE_LIMIT'
             ELSE 'COMMERCE_ORDER_SYNC_RETRY_EXHAUSTED'
           END,
           cursor_ciphertext = NULL,
           cursor_iv = NULL,
           cursor_tag = NULL,
           cursor_key_id = NULL,
           cursor_hash = NULL,
           cursor_encryption_version = NULL,
           cursor_aad_version = NULL,
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           completed_at = now(),
           updated_at = now()
       WHERE expired.status IN ('pending', 'processing', 'failed')
         AND NOT EXISTS (
           SELECT 1 FROM stale_candidates
           WHERE stale_candidates.id = expired.id
         )
         AND (
           expired.page_count >= expired.max_pages
           OR (
             expired.status = 'processing'
             AND expired.lease_expires_at <= now()
             AND expired.attempt_count >= expired.max_attempts
           )
         )
       RETURNING expired.id
     ), candidates AS (
       SELECT session.id
       FROM operations_commerce_order_backfill_sessions session
       JOIN operations_commerce_order_sync_policies policy
         ON policy.organization_id = session.organization_id
        AND policy.integration_account_id = session.integration_account_id
       JOIN operations_integration_accounts account
         ON account.organization_id = session.organization_id
        AND account.id = session.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version = session.credential_generation
        AND credential.external_account_id = account.external_account_id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = session.organization_id
       WHERE (
         session.status IN ('pending', 'failed')
         OR (
           session.status = 'processing'
           AND session.lease_expires_at <= now()
         )
       )
         AND account.integration_type = 'commerce'
         AND session.available_at <= now()
         AND session.attempt_count < session.max_attempts
         AND session.page_count < session.max_pages
         AND (
           (session.session_kind = 'historical_backfill'
             AND policy.historical_observation_enabled)
           OR (session.session_kind = 'continuous_poll'
             AND policy.continuous_observation_enabled)
         )
         AND policy.authority = 'provider'
         AND policy.revision = session.policy_revision
         AND ${ORDER_READ_ACCOUNT_SQL}
         AND account.commerce_credential_generation
             = session.credential_generation
         AND account.provider = session.provider
         AND credential.verification_status = 'verified'
         AND (
           (account.provider = 'shopify'
             AND credential.auth_mode = 'shopify_client_credentials')
           OR (account.provider = 'faire'
             AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
         )
         AND ${STORE_SYNC_RUNNING_SQL}
         AND NOT EXISTS (
           SELECT 1
           FROM stale_terminalized stale
           WHERE stale.id = session.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM terminalized exhausted
           WHERE exhausted.id = session.id
         )
       ORDER BY session.available_at, session.created_at, session.id
       FOR UPDATE OF session SKIP LOCKED
       LIMIT $1
     )
     UPDATE operations_commerce_order_backfill_sessions session
     SET status = 'processing',
         attempt_count = attempt_count + 1,
         locked_at = now(),
         locked_by = $2,
         lock_token = gen_random_uuid(),
         lease_expires_at = now() + interval '${BACKFILL_LEASE}',
         started_at = COALESCE(started_at, now()),
         last_error_code = NULL,
         updated_at = now()
     FROM candidates, operations_integration_accounts account
     WHERE session.id = candidates.id
       AND account.organization_id = session.organization_id
       AND account.id = session.integration_account_id
     RETURNING session.id::text, session.global_id,
               session.organization_id::text,
               session.integration_account_id::text,
               account.global_id AS account_global_id,
               session.provider, session.session_kind,
               session.credential_generation,
               session.policy_revision, session.requested_from,
               session.requested_through,
               session.query_hash, session.page_count,
               session.attempt_count, session.max_attempts,
               session.max_pages,
               session.lock_token::text`,
    [limit, workerId],
  )
  return result.rows.map((row): CommerceOrderBackfillJob => ({
    id: row.id,
    globalId: row.global_id,
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    accountGlobalId: row.account_global_id,
    provider: row.provider,
    sessionKind: row.session_kind,
    credentialGeneration: row.credential_generation,
    policyRevision: row.policy_revision,
    requestedFrom: row.requested_from?.toISOString() || null,
    requestedThrough: row.requested_through.toISOString(),
    queryHash: row.query_hash,
    pageCount: row.page_count,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    maxPages: row.max_pages,
    lockToken: row.lock_token,
  }))
}

export async function readCommerceOrderBackfillCursorFromPostgres(
  job: CommerceOrderBackfillJob,
) {
  const row = (
    await query<{
      page_count: number
      query_hash: string
      cursor_ciphertext: Buffer | null
      cursor_iv: Buffer | null
      cursor_tag: Buffer | null
      cursor_key_id: string | null
      cursor_hash: string | null
      cursor_encryption_version: number | null
      cursor_aad_version: string | null
    }>(
      `SELECT session.page_count, session.query_hash,
              session.cursor_ciphertext, session.cursor_iv,
              session.cursor_tag, session.cursor_key_id,
              session.cursor_hash, session.cursor_encryption_version,
              session.cursor_aad_version
       FROM operations_commerce_order_backfill_sessions session
       JOIN operations_commerce_order_sync_policies policy
         ON policy.organization_id = session.organization_id
        AND policy.integration_account_id = session.integration_account_id
       JOIN operations_integration_accounts account
         ON account.organization_id = session.organization_id
        AND account.id = session.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version = session.credential_generation
        AND credential.external_account_id = account.external_account_id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = session.organization_id
       WHERE session.organization_id = $1::uuid
         AND session.id = $2::uuid
         AND session.global_id = $3
         AND session.status = 'processing'
         AND session.lock_token = $4::uuid
         AND session.lease_expires_at > now()
         AND account.global_id = $5
         AND session.integration_account_id = $6::uuid
         AND session.provider = $7
         AND session.session_kind = $8
         AND session.credential_generation = $9
         AND session.policy_revision = $10
         AND session.query_hash = $11
         AND session.requested_from IS NOT DISTINCT FROM $12::timestamptz
         AND session.requested_through = $13::timestamptz
         AND ${ORDER_READ_ACCOUNT_SQL}
         AND account.commerce_credential_generation
             = session.credential_generation
         AND credential.verification_status = 'verified'
         AND (
           (account.provider = 'shopify'
             AND credential.auth_mode = 'shopify_client_credentials')
           OR (account.provider = 'faire'
             AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
         )
         AND ${STORE_SYNC_RUNNING_SQL}
         AND policy.authority = 'provider'
         AND (
           (session.session_kind = 'historical_backfill'
             AND policy.historical_observation_enabled)
           OR (session.session_kind = 'continuous_poll'
             AND policy.continuous_observation_enabled)
         )
         AND policy.revision = session.policy_revision
       LIMIT 1`,
      [
        job.organizationId,
        job.id,
        job.globalId,
        job.lockToken,
        job.accountGlobalId,
        job.integrationAccountId,
        job.provider,
        job.sessionKind,
        job.credentialGeneration,
        job.policyRevision,
        job.queryHash,
        job.requestedFrom,
        job.requestedThrough,
      ],
    )
  ).rows[0]
  if (
    !row
    || row.page_count !== job.pageCount
      || row.query_hash !== job.queryHash
      || job.pageCount >= job.maxPages
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_AUTHORITY_STALE',
      'Historical order read authority changed before the provider read',
    )
  }
  if (row.page_count === 0) {
    if (
      row.cursor_ciphertext
      || row.cursor_iv
      || row.cursor_tag
      || row.cursor_key_id
      || row.cursor_hash
      || row.cursor_encryption_version
      || row.cursor_aad_version
    ) {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_SYNC_CURSOR_INVALID',
        'Historical order continuation evidence is invalid',
      )
    }
    return null
  }
  if (
    !row.cursor_ciphertext
    || !row.cursor_iv
    || !row.cursor_tag
    || !row.cursor_key_id
    || !row.cursor_hash
    || row.cursor_encryption_version !== 1
    || row.cursor_aad_version !== COMMERCE_ORDER_SYNC_CURSOR_AAD_VERSION
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_CURSOR_INVALID',
      'Historical order continuation evidence is invalid',
    )
  }
  try {
    return decryptCommerceOrderSyncCursor({
      ciphertext: row.cursor_ciphertext,
      iv: row.cursor_iv,
      tag: row.cursor_tag,
      keyId: row.cursor_key_id,
      hash: row.cursor_hash,
      encryptionVersion: row.cursor_encryption_version,
      aadVersion: row.cursor_aad_version,
    }, job.organizationId, job.accountGlobalId, job.provider, job.id,
    job.pageCount, job.queryHash).orderCursor
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_CURSOR_INVALID',
      'Historical order continuation evidence is invalid',
    )
  }
}

export async function appendCommerceOrderBackfillPageInPostgres(input: {
  job: CommerceOrderBackfillJob
  providerReadLease: CommerceStoreSyncProviderReadLease
  pageNumber: number
  providerRecordsSeen: number
  observations: readonly CommerceOrderObservationInput[]
  hasNextPage: boolean
  nextProviderCursor: string | null
  readAllOrdersScopeObserved: boolean | null
  returnHistoryScopeObserved: boolean | null
}) {
  if (!BACKFILL_GLOBAL_ID_PATTERN.test(input.job.globalId)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Backfill job identity is invalid',
      400,
    )
  }
  if (!UUID_PATTERN.test(input.job.lockToken)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Backfill lease identity is invalid',
      400,
    )
  }
  const pageNumber = count(input.pageNumber, 'Page number')
  if (pageNumber < 1 || pageNumber !== input.job.pageCount + 1) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_PAGE_SEQUENCE_INVALID',
      'Historical order pages must be appended sequentially',
    )
  }
  const providerRecordsSeen = count(
    input.providerRecordsSeen,
    'Provider record count',
  )
  const providerPageLimit = input.job.provider === 'shopify' ? 5 : 50
  if (providerRecordsSeen > providerPageLimit) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_PAGE_COUNT_INVALID',
      'Provider order history page exceeds the bounded record limit',
      400,
    )
  }
  if (providerRecordsSeen < input.observations.length) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_PAGE_COUNT_INVALID',
      'Historical order observations exceed the provider page count',
      400,
    )
  }
  if (
    input.hasNextPage
      !== Boolean(input.nextProviderCursor)
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_CONTINUATION_INVALID',
      'Historical order continuation evidence is invalid',
      400,
    )
  }
  const observations = input.observations.map(normalizeObservation)
  assertCommerceOrderSyncObservationKinds(
    input.job.sessionKind,
    observations.map((observation) => observation.observationKind),
  )
  if (
    input.job.provider === 'shopify'
      ? typeof input.readAllOrdersScopeObserved !== 'boolean'
        || typeof input.returnHistoryScopeObserved !== 'boolean'
      : input.readAllOrdersScopeObserved !== null
        || input.returnHistoryScopeObserved !== null
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_SCOPE_EVIDENCE_INVALID',
      'Provider order history scope evidence is invalid',
      400,
    )
  }
  if (input.hasNextPage && pageNumber >= input.job.maxPages) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_PAGE_LIMIT',
      'Provider order history exceeded the absolute page limit',
    )
  }
  if (
    input.job.sessionKind === 'continuous_poll'
    || input.job.requestedFrom !== null
  ) {
    const fromTime = input.job.requestedFrom
      ? new Date(input.job.requestedFrom).getTime()
      : Number.NaN
    const throughTime = new Date(input.job.requestedThrough).getTime()
    for (const observation of observations) {
      const boundary = input.job.sessionKind === 'historical_backfill'
        ? observation.providerCreatedAt
        : observation.providerUpdatedAt
      const boundaryTime = boundary ? new Date(boundary).getTime() : Number.NaN
      if (
        !Number.isFinite(fromTime)
        || !Number.isFinite(boundaryTime)
        || boundaryTime < fromTime
        || boundaryTime > throughTime
      ) {
        throw new CommerceOrderSyncError(
          'COMMERCE_ORDER_SYNC_WINDOW_EVIDENCE_INVALID',
          'Provider order evidence falls outside the sealed sync window',
          409,
        )
      }
    }
  }
  const returnHistoryState = input.job.provider === 'faire'
    ? 'provider_embedded'
    : input.returnHistoryScopeObserved
      ? 'available'
      : 'unavailable'
  return withTransaction(async (client) => {
    // The session validation below already requires UPDATE(account). Take
    // that same lock before the lease assertion locks the store control,
    // matching intake capture/reservation instead of inverting their order.
    await client.query(
      `SELECT id
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid AND id = $2::uuid
       FOR UPDATE`,
      [input.job.organizationId, input.job.integrationAccountId],
    )
    await assertCommerceStoreSyncProviderReadLeaseCurrentWithClient(client, {
      organizationId: input.job.organizationId,
      integrationAccountId: input.job.integrationAccountId,
      lease: input.providerReadLease,
      authorityKind: 'automatic',
      readKind: 'order_history',
    })
    const session = (
      await client.query<{
        id: string
        provider: CommerceProvider
        credential_generation: number
        query_hash: string
        page_count: number
        lock_token: string
        session_kind: 'historical_backfill' | 'continuous_poll'
        policy_revision: number
        integration_account_id: string
        requested_from: Date | null
        requested_through: Date
        read_all_orders_scope_observed: boolean | null
        return_history_state: string
        history_mode: CommerceOrderHistoryMode
        ingestion_floor: Date | null
      }>(
        `SELECT session.id::text, session.provider,
                session.credential_generation, session.query_hash,
                session.page_count, session.lock_token::text,
                session.session_kind, session.policy_revision,
                session.integration_account_id::text,
                session.requested_from, session.requested_through,
                session.read_all_orders_scope_observed,
                session.return_history_state,
                history.history_mode,
                history.ingestion_floor
         FROM operations_commerce_order_backfill_sessions session
         JOIN operations_commerce_order_sync_policies policy
           ON policy.organization_id = session.organization_id
          AND policy.integration_account_id = session.integration_account_id
         JOIN operations_commerce_order_history_policies history
           ON history.organization_id = session.organization_id
          AND history.integration_account_id = session.integration_account_id
          AND history.provider = session.provider
         JOIN operations_integration_accounts account
           ON account.organization_id = session.organization_id
          AND account.id = session.integration_account_id
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
          AND credential.credential_version = session.credential_generation
          AND credential.external_account_id = account.external_account_id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = session.organization_id
         WHERE session.organization_id = $1::uuid
           AND session.id = $2::uuid
           AND session.global_id = $3
           AND session.status = 'processing'
           AND session.lock_token = $4::uuid
           AND session.lease_expires_at > now()
           AND account.global_id = $5
           AND session.integration_account_id = $6::uuid
           AND session.provider = $7
           AND session.session_kind = $8
           AND session.credential_generation = $9
           AND session.policy_revision = $10
           AND session.query_hash = $11
           AND session.requested_from IS NOT DISTINCT FROM $12::timestamptz
           AND session.requested_through = $13::timestamptz
           AND ${ORDER_READ_ACCOUNT_SQL}
           AND account.commerce_credential_generation
               = session.credential_generation
           AND credential.verification_status = 'verified'
           AND (
             (account.provider = 'shopify'
               AND credential.auth_mode = 'shopify_client_credentials')
             OR (account.provider = 'faire'
               AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
           )
           AND ${STORE_SYNC_RUNNING_SQL}
           AND policy.authority = 'provider'
           AND (
             (session.session_kind = 'historical_backfill'
               AND policy.historical_observation_enabled)
             OR (session.session_kind = 'continuous_poll'
               AND policy.continuous_observation_enabled)
           )
           AND policy.revision = session.policy_revision
         LIMIT 1
         FOR UPDATE OF session, account`,
        [
          input.job.organizationId,
          input.job.id,
          input.job.globalId,
          input.job.lockToken,
          input.job.accountGlobalId,
          input.job.integrationAccountId,
          input.job.provider,
          input.job.sessionKind,
          input.job.credentialGeneration,
          input.job.policyRevision,
          input.job.queryHash,
          input.job.requestedFrom,
          input.job.requestedThrough,
        ],
      )
    ).rows[0]
    if (
      !session
      || session.provider !== input.job.provider
      || session.credential_generation !== input.job.credentialGeneration
      || session.integration_account_id !== input.job.integrationAccountId
      || session.session_kind !== input.job.sessionKind
      || session.policy_revision !== input.job.policyRevision
      || session.query_hash !== input.job.queryHash
      || session.page_count + 1 !== pageNumber
      || (session.requested_from?.toISOString() || null)
        !== input.job.requestedFrom
      || session.requested_through.toISOString() !== input.job.requestedThrough
      || (
        session.read_all_orders_scope_observed !== null
        && session.read_all_orders_scope_observed
          !== input.readAllOrdersScopeObserved
      )
      || (
        session.return_history_state !== 'unknown'
        && session.return_history_state !== returnHistoryState
      )
    ) {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_SYNC_LEASE_LOST',
        'The historical order session changed before this page was saved',
      )
    }
    const persisted = await appendObservationsWithClient(client, {
      organizationId: input.job.organizationId,
      integrationAccountId: input.job.integrationAccountId,
      provider: input.job.provider,
      credentialGeneration: input.job.credentialGeneration,
      backfillSessionId: input.job.id,
      manualProviderReadLeaseId: null,
    }, observations)
    const ingestionFloorTime = session.ingestion_floor?.getTime() ?? null
    const providerDates = observations
      .map((observation) => observation.providerCreatedAt)
      .filter((value): value is string => Boolean(value))
      .filter((value) => (
        ingestionFloorTime === null
        || new Date(value).getTime() >= ingestionFloorTime
      ))
      .sort()
    const status = input.hasNextPage ? 'pending' : 'succeeded'
    const completenessState = input.hasNextPage
      ? 'unknown'
      : input.job.sessionKind === 'continuous_poll'
        ? 'unknown'
        : commerceOrderHistoryCompletionMeaning({
            provider: input.job.provider,
            mode: session.history_mode,
            readAllOrdersGranted:
              input.readAllOrdersScopeObserved === true,
          })
    const protectedCursor = input.nextProviderCursor
      ? encryptCommerceOrderSyncCursor(
          { orderCursor: input.nextProviderCursor },
          input.job.organizationId,
          input.job.accountGlobalId,
          input.job.provider,
          input.job.id,
          pageNumber,
          input.job.queryHash,
        )
      : null
    const updated = await client.query(
      `UPDATE operations_commerce_order_backfill_sessions
       SET status = $5,
           completeness_state = $6,
           cursor_ciphertext = $7,
           cursor_iv = $8,
           cursor_tag = $9,
           cursor_key_id = $10,
           cursor_hash = $11,
           cursor_encryption_version = $12,
           cursor_aad_version = $13,
           read_all_orders_scope_observed = $20,
           return_history_state = $21,
           page_count = page_count + 1,
           attempt_count = 0,
           provider_records_seen = provider_records_seen + $14,
           observations_appended = observations_appended + $15,
           observations_preserved = observations_preserved + $16,
           oldest_provider_order_at = CASE
             WHEN $17::timestamptz IS NULL THEN oldest_provider_order_at
             ELSE LEAST(
               COALESCE(oldest_provider_order_at, $17::timestamptz),
               $17::timestamptz
             )
           END,
           newest_provider_order_at = CASE
             WHEN $18::timestamptz IS NULL THEN newest_provider_order_at
             ELSE GREATEST(
               COALESCE(newest_provider_order_at, $18::timestamptz),
               $18::timestamptz
             )
           END,
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           completed_at = CASE WHEN $5 = 'succeeded' THEN now() ELSE NULL END,
           available_at = now(),
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND global_id = $3
         AND status = 'processing'
         AND lock_token = $4::uuid
         AND query_hash = $19
         AND integration_account_id = $22::uuid
         AND provider = $23
         AND session_kind = $24
         AND credential_generation = $25
         AND policy_revision = $26
         AND requested_from IS NOT DISTINCT FROM $27::timestamptz
         AND requested_through = $28::timestamptz
         AND (
           read_all_orders_scope_observed IS NULL
           OR read_all_orders_scope_observed IS NOT DISTINCT FROM $20
         )
         AND return_history_state IN ('unknown', $21)`,
      [
        input.job.organizationId,
        input.job.id,
        input.job.globalId,
        input.job.lockToken,
        status,
        completenessState,
        protectedCursor?.ciphertext || null,
        protectedCursor?.iv || null,
        protectedCursor?.tag || null,
        protectedCursor?.keyId || null,
        protectedCursor?.hash || null,
        protectedCursor?.encryptionVersion || null,
        protectedCursor?.aadVersion || null,
        providerRecordsSeen,
        persisted.appended,
        persisted.preserved,
        providerDates[0] || null,
        providerDates.at(-1) || null,
        input.job.queryHash,
        input.readAllOrdersScopeObserved,
        returnHistoryState,
        input.job.integrationAccountId,
        input.job.provider,
        input.job.sessionKind,
        input.job.credentialGeneration,
        input.job.policyRevision,
        input.job.requestedFrom,
        input.job.requestedThrough,
      ],
    )
    if (updated.rowCount !== 1) {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_SYNC_LEASE_LOST',
        'The historical order session lease was lost before completion',
      )
    }
    if (status === 'succeeded') {
      await client.query(
        `UPDATE operations_commerce_order_sync_policies
         SET continuous_high_watermark = GREATEST(
               COALESCE(continuous_high_watermark, $3::timestamptz),
               $3::timestamptz
             ),
             continuous_next_poll_at = now() + CASE
               WHEN $5 = 'faire' THEN interval '5 minutes'
               ELSE interval '30 minutes'
             END,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND revision = $4
           AND authority = 'provider'
           AND continuous_observation_enabled`,
        [
          input.job.organizationId,
          input.job.integrationAccountId,
          input.job.requestedThrough,
          input.job.policyRevision,
          input.job.provider,
        ],
      )
    }
    await recordAuditEvent({
      actor: null,
      isSystem: true,
      eventType: 'commerce.order_history.page_observed',
      aggregateType: 'operations.commerce_order_backfill_session',
      aggregateId: input.job.globalId,
      organizationId: input.job.organizationId,
      eventKey: `commerce-order-history-page:${input.job.globalId}:${pageNumber}`,
      payload: {
        provider: input.job.provider,
        sessionKind: input.job.sessionKind,
        pageNumber,
        providerRecordsSeen,
        observationsAppended: persisted.appended,
        observationsPreserved: persisted.preserved,
        linesAppended: persisted.linesAppended,
        eventsAppended: persisted.eventsAppended,
        hasNextPage: input.hasNextPage,
        status,
        completenessState,
        providerWrites: 0,
      },
    }, client)
    return {
      status,
      completenessState,
      pageNumber,
      providerRecordsSeen,
      ...persisted,
      providerWrites: 0 as const,
    }
  })
}

function safeErrorCode(error: unknown) {
  const candidate = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(candidate)
    ? candidate
    : 'COMMERCE_ORDER_SYNC_FAILED'
}

const BLOCKED_BACKFILL_ERROR_CODES = new Set([
  'COMMERCE_ORDER_HISTORY_ACCOUNT_INELIGIBLE',
  'COMMERCE_ORDER_SYNC_AUTHORITY_STALE',
  'SHOPIFY_READ_ORDERS_REQUIRED',
  'FAIRE_READ_ORDERS_REQUIRED',
  'SHOPIFY_ACCESS_DENIED',
  'SHOPIFY_CLIENT_CREDENTIALS_REJECTED',
  'SHOPIFY_APP_NOT_INSTALLED',
  'SHOPIFY_SHOP_NOT_PERMITTED',
  'FAIRE_ACCESS_DENIED',
  'COMMERCE_ORDER_SYNC_SENSITIVE_REVISION_CONFLICT',
])

const DEAD_BACKFILL_ERROR_CODES = new Set([
  'COMMERCE_ORDER_SYNC_CURSOR_INVALID',
  'COMMERCE_ORDER_HISTORY_CURSOR_INVALID',
  'SHOPIFY_ORDER_HISTORY_WINDOW_INVALID',
  'FAIRE_ORDER_HISTORY_WINDOW_INVALID',
  'COMMERCE_ORDER_SYNC_PAGE_LIMIT',
  'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
  'COMMERCE_ORDER_HISTORY_NORMALIZATION_REJECTED',
  'COMMERCE_ORDER_SYNC_WINDOW_EVIDENCE_INVALID',
  'SHOPIFY_ORDER_HISTORY_READ_ORDERS_QUEUE_SLA_EXCEEDED',
])

export async function failCommerceOrderBackfillInPostgres(input: {
  job: CommerceOrderBackfillJob
  error: unknown
}) {
  const code = safeErrorCode(input.error)
  const terminalStatus = BLOCKED_BACKFILL_ERROR_CODES.has(code)
    ? 'blocked'
    : DEAD_BACKFILL_ERROR_CODES.has(code)
      ? 'dead'
      : null
  const result = await query<{ status: 'failed' | 'dead' | 'blocked' }>(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = CASE
           WHEN $6::text IS NOT NULL THEN $6
           WHEN attempt_count >= max_attempts THEN 'dead'
           ELSE 'failed'
         END,
         last_error_code = $5,
         available_at = now() + LEAST(
           interval '30 minutes',
           interval '30 seconds' * power(2, GREATEST(0, attempt_count - 1))
         ),
         locked_at = NULL,
         locked_by = NULL,
         lock_token = NULL,
         lease_expires_at = NULL,
         cursor_ciphertext = CASE
           WHEN $6::text IS NOT NULL OR attempt_count >= max_attempts
             THEN NULL ELSE cursor_ciphertext END,
         cursor_iv = CASE
           WHEN $6::text IS NOT NULL OR attempt_count >= max_attempts
             THEN NULL ELSE cursor_iv END,
         cursor_tag = CASE
           WHEN $6::text IS NOT NULL OR attempt_count >= max_attempts
             THEN NULL ELSE cursor_tag END,
         cursor_key_id = CASE
           WHEN $6::text IS NOT NULL OR attempt_count >= max_attempts
             THEN NULL ELSE cursor_key_id END,
         cursor_hash = CASE
           WHEN $6::text IS NOT NULL OR attempt_count >= max_attempts
             THEN NULL ELSE cursor_hash END,
         cursor_encryption_version = CASE
           WHEN $6::text IS NOT NULL OR attempt_count >= max_attempts
             THEN NULL ELSE cursor_encryption_version END,
         cursor_aad_version = CASE
           WHEN $6::text IS NOT NULL OR attempt_count >= max_attempts
             THEN NULL ELSE cursor_aad_version END,
         completed_at = CASE
           WHEN $6::text IS NOT NULL OR attempt_count >= max_attempts
             THEN now()
           ELSE NULL
         END,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND global_id = $3
       AND status = 'processing'
       AND lock_token = $4::uuid
     RETURNING status`,
    [
      input.job.organizationId,
      input.job.id,
      input.job.globalId,
      input.job.lockToken,
      code,
      terminalStatus,
    ],
  )
  if (!result.rows[0]) {
    return { leaseLost: true, code, providerWrites: 0 as const }
  }
  return {
    leaseLost: false,
    status: result.rows[0].status,
    code,
    providerWrites: 0 as const,
  }
}

async function parkCommerceOrderBackfillInPostgres(input: {
  job: CommerceOrderBackfillJob
  errorCode: string
}) {
  if (!/^INTEGRATION_CREDENTIAL_RUNTIME_[A-Z0-9_]{1,96}$/u.test(input.errorCode)
      && input.errorCode !== 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED') {
    throw new Error('Commerce order backfill parking reason is invalid')
  }
  const result = await query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = 'pending',
         attempt_count = GREATEST(0, attempt_count - 1),
         available_at = now(),
         locked_at = NULL,
         locked_by = NULL,
         lock_token = NULL,
         lease_expires_at = NULL,
         last_error_code = $5,
         completed_at = NULL,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND global_id = $3
       AND status = 'processing'
       AND lock_token = $4::uuid
     RETURNING id`,
    [
      input.job.organizationId,
      input.job.id,
      input.job.globalId,
      input.job.lockToken,
      input.errorCode,
    ],
  )
  return {
    parked: result.rowCount === 1,
    providerWrites: 0 as const,
  }
}

export async function parkCommerceOrderBackfillForStoreSyncPauseInPostgres(
  input: { job: CommerceOrderBackfillJob },
) {
  return parkCommerceOrderBackfillInPostgres({
    ...input,
    errorCode: 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED',
  })
}

export async function parkCommerceOrderBackfillForRuntimeMaintenanceInPostgres(
  input: { job: CommerceOrderBackfillJob; errorCode: string },
) {
  return parkCommerceOrderBackfillInPostgres(input)
}

export async function readCommerceOrderSyncStateFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
}) {
  const result = await query<{
    provider: CommerceProvider
    auth_mode: string
    configuration: Record<string, unknown>
    policy_revision: number | null
    historical_observation_enabled: boolean | null
    continuous_observation_enabled: boolean | null
    continuous_transport: string | null
    provider_event_processor_state: string | null
    session_global_id: string | null
    session_kind: string | null
    session_status: string | null
    completeness_state: string | null
    coverage_basis: string | null
    provider_records_seen: string | null
    observations_appended: string | null
    observations_preserved: string | null
    last_error_code: string | null
    last_completed_at: Date | null
    requested_from: Date | null
    requested_through: Date | null
    read_all_orders_scope_observed: boolean | null
    return_history_state: string | null
    history_mode: CommerceOrderHistoryMode | null
    ingestion_floor: Date | null
    history_frozen_at: Date | null
  }>(
    `SELECT account.provider, credential.auth_mode, account.configuration,
            policy.revision AS policy_revision,
            policy.historical_observation_enabled,
            policy.continuous_observation_enabled,
            policy.continuous_transport,
            policy.provider_event_processor_state,
            latest.global_id AS session_global_id,
            latest.session_kind,
            latest.status AS session_status,
            latest.completeness_state,
            latest.coverage_basis,
            latest.provider_records_seen::text,
            latest.observations_appended::text,
            latest.observations_preserved::text,
            latest.last_error_code,
            latest.completed_at AS last_completed_at,
            latest.requested_from, latest.requested_through,
            latest.read_all_orders_scope_observed,
            latest.return_history_state,
            history.history_mode,
            history.ingestion_floor,
            history.frozen_at AS history_frozen_at
     FROM operations_integration_accounts account
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
      AND credential.credential_version = account.commerce_credential_generation
      AND credential.external_account_id = account.external_account_id
     LEFT JOIN operations_commerce_order_sync_policies policy
       ON policy.organization_id = account.organization_id
      AND policy.integration_account_id = account.id
     LEFT JOIN operations_commerce_order_history_policies history
       ON history.organization_id = account.organization_id
      AND history.integration_account_id = account.id
     LEFT JOIN LATERAL (
       SELECT session.*
       FROM operations_commerce_order_backfill_sessions session
       WHERE session.organization_id = account.organization_id
         AND session.integration_account_id = account.id
         AND session.session_kind = 'historical_backfill'
       ORDER BY session.created_at DESC, session.id DESC
       LIMIT 1
     ) latest ON true
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider IN ('shopify', 'faire')
     LIMIT 1`,
    [input.organizationId, input.accountGlobalId],
  )
  const row = result.rows[0]
  if (!row) return null
  const readiness = commerceOrderHistoryReadiness({
    provider: row.provider,
    authMode: row.auth_mode,
    grantedScopes: stringArray(row.configuration.grantedScopes),
    requestedScopes: stringArray(row.configuration.requestedScopes),
  })
  return {
    provider: row.provider,
    authority: 'provider' as const,
    readiness,
    orderHistoryPolicy:
      row.history_mode && row.history_frozen_at
        ? {
            mode: row.history_mode,
            ingestionFloor: row.ingestion_floor?.toISOString() || null,
            frozenAt: row.history_frozen_at.toISOString(),
          }
        : null,
    policy: row.policy_revision === null ? null : {
      revision: row.policy_revision,
      historicalObservationEnabled:
        row.historical_observation_enabled === true,
      continuousObservationEnabled:
        row.continuous_observation_enabled === true,
      continuousTransport: row.continuous_transport,
      providerEventProcessorState: row.provider_event_processor_state,
      pollingCadenceMinutes: readiness.pollingCadenceMinutes,
    },
    latestBackfill: row.session_global_id ? {
      globalId: row.session_global_id,
      sessionKind: row.session_kind,
      status: row.session_status,
      completenessState: row.completeness_state,
      coverageBasis: row.coverage_basis,
      providerRecordsSeen: Number(row.provider_records_seen || 0),
      observationsAppended: Number(row.observations_appended || 0),
      observationsPreserved: Number(row.observations_preserved || 0),
      lastErrorCode: row.last_error_code,
      completedAt: row.last_completed_at?.toISOString() || null,
      requestedFrom: row.requested_from?.toISOString() || null,
      requestedThrough: row.requested_through?.toISOString() || null,
      readAllOrdersScopeObserved: row.read_all_orders_scope_observed,
      returnHistoryState: row.return_history_state,
    } : null,
    providerWrites: 0 as const,
  }
}

export async function redactExpiredCommerceOrderSensitiveEvidenceInPostgres(
  input: { limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(Number(input.limit || 250), 1000))
  const result = await query<{ redacted: number }>(
    `WITH base AS (SELECT redact_expired_commerce_order_sensitive_evidence($1) AS count),
       urls AS (SELECT CASE WHEN base.count < $1
         THEN redact_expired_commerce_order_tracking_url_evidence($1-base.count) ELSE 0 END AS count FROM base),
       native AS (SELECT CASE WHEN base.count+urls.count < $1
         THEN redact_expired_commerce_order_native_activity_evidence($1-base.count-urls.count) ELSE 0 END AS count FROM base,urls)
     SELECT (base.count+urls.count+native.count)::integer AS redacted FROM base,urls,native`,
    [limit],
  )
  return {
    redacted: Number(result.rows[0]?.redacted || 0),
    retentionDaysMaximum: 400,
    providerWrites: 0 as const,
  }
}

export async function readCommerceOrderSyncHealthFromPostgres() {
  const result = await query<{
    pending: number
    processing: number
    stale_processing: number
    failed: number
    dead: number
    historical_dead: number
    blocked: number
    historical_blocked: number
    overdue_polls: number
    scheduled_poll_policies: number
    webhook_signal_plus_poll_policies: number
    paused_retained_sessions: number
    expired_sensitive_evidence: number
    last_completed_at: Date | null
  }>(
    `WITH active_sessions AS (
       SELECT session.*,
              operations_commerce_store_sync_is_running(
                session.organization_id,
                session.integration_account_id
              ) AS store_sync_running
       FROM operations_commerce_order_backfill_sessions session
       WHERE session.status IN ('pending', 'processing', 'failed')
     ), active_health AS (
       SELECT
         count(*) FILTER (
           WHERE session.status = 'pending' AND session.store_sync_running
         )::integer AS pending,
         count(*) FILTER (
           WHERE session.status = 'processing' AND session.store_sync_running
         )::integer AS processing,
         count(*) FILTER (
           WHERE session.status = 'processing'
             AND session.store_sync_running
             AND session.lease_expires_at <= now()
         )::integer AS stale_processing,
         count(*) FILTER (
           WHERE session.status = 'failed' AND session.store_sync_running
         )::integer AS failed,
         count(*) FILTER (
           WHERE NOT session.store_sync_running
         )::integer AS paused_retained_sessions
       FROM active_sessions session
     ), terminal_totals AS (
       SELECT
         count(*) FILTER (WHERE session.status = 'dead')::integer
           AS total_dead,
         count(*) FILTER (WHERE session.status = 'blocked')::integer
           AS total_blocked,
         max(session.completed_at) AS last_completed_at
       FROM operations_commerce_order_backfill_sessions session
     ), latest_stream_sessions AS (
       SELECT DISTINCT ON (
         session.organization_id,
         session.integration_account_id,
         session.session_kind
       )
         session.organization_id,
         session.integration_account_id,
         session.provider,
         session.session_kind,
         session.credential_generation,
         session.policy_revision,
         session.status
       FROM operations_commerce_order_backfill_sessions session
       ORDER BY session.organization_id,
                session.integration_account_id,
                session.session_kind,
                session.created_at DESC,
                session.id DESC
     ), terminal_heads AS (
       SELECT session.*,
              operations_commerce_provider_read_authority_is_current(
                session.organization_id,
                session.integration_account_id,
                'automatic'
              )
              AND EXISTS (
                SELECT 1
                FROM operations_integration_accounts account
                JOIN operations_commerce_credentials credential
                  ON credential.organization_id = account.organization_id
                 AND credential.integration_account_id = account.id
                 AND credential.credential_version =
                       session.credential_generation
                 AND credential.external_account_id =
                       account.external_account_id
                JOIN operations_commerce_order_sync_policies policy
                  ON policy.organization_id = account.organization_id
                 AND policy.integration_account_id = account.id
                WHERE account.organization_id = session.organization_id
                  AND account.id = session.integration_account_id
                  AND account.integration_type = 'commerce'
                  AND account.provider = session.provider
                  AND ${ORDER_READ_ACCOUNT_SQL}
                  AND account.commerce_credential_generation =
                        session.credential_generation
                  AND credential.verification_status = 'verified'
                  AND (
                    (account.provider = 'shopify'
                      AND credential.auth_mode =
                            'shopify_client_credentials')
                    OR (account.provider = 'faire'
                      AND credential.auth_mode IN (
                        'faire_brand_token', 'faire_oauth'
                      ))
                  )
                  AND policy.authority = 'provider'
                  AND policy.revision = session.policy_revision
                  AND (
                    (session.session_kind = 'historical_backfill'
                      AND policy.historical_observation_enabled)
                    OR (session.session_kind = 'continuous_poll'
                      AND policy.continuous_observation_enabled)
                  )
              ) AS current_authority
       FROM latest_stream_sessions session
       WHERE session.status IN ('dead', 'blocked')
     ), terminal_health AS (
       SELECT
         count(*) FILTER (
           WHERE session.status = 'dead' AND session.current_authority
         )::integer AS dead,
         count(*) FILTER (
           WHERE session.status = 'blocked' AND session.current_authority
         )::integer AS blocked
       FROM terminal_heads session
     )
     SELECT
       active.pending,
       active.processing,
       active.stale_processing,
       active.failed,
       terminal.dead,
       GREATEST(totals.total_dead - terminal.dead, 0)::integer
         AS historical_dead,
       terminal.blocked,
       GREATEST(totals.total_blocked - terminal.blocked, 0)::integer
         AS historical_blocked,
       active.paused_retained_sessions,
       (SELECT count(*)::integer
        FROM operations_commerce_order_sync_policies policy
        WHERE policy.continuous_observation_enabled
          AND policy.continuous_high_watermark IS NOT NULL
          AND policy.continuous_next_poll_at <= now()
          AND operations_commerce_store_sync_is_running(
            policy.organization_id, policy.integration_account_id
          )) AS overdue_polls,
       (SELECT count(*)::integer
        FROM operations_commerce_order_sync_policies policy
        WHERE policy.continuous_observation_enabled
          AND operations_commerce_store_sync_is_running(
            policy.organization_id, policy.integration_account_id
          )
          AND policy.continuous_transport = 'scheduled_poll')
         AS scheduled_poll_policies,
       (SELECT count(*)::integer
        FROM operations_commerce_order_sync_policies policy
        WHERE policy.continuous_observation_enabled
          AND operations_commerce_store_sync_is_running(
            policy.organization_id, policy.integration_account_id
          )
          AND policy.continuous_transport = 'webhook_signal_plus_poll')
         AS webhook_signal_plus_poll_policies,
       ((SELECT count(*)::integer
        FROM operations_commerce_order_event_observations event
        WHERE event.sensitive_evidence_redacted_at IS NULL
          AND event.sensitive_evidence_expires_at <= now()
          AND (
            event.provider_actor_fingerprint IS NOT NULL
            OR event.tracking_number IS NOT NULL
            OR event.tracking_url IS NOT NULL
          )) + (SELECT count(*)::integer
        FROM operations_commerce_order_tracking_url_evidence evidence
        WHERE evidence.sensitive_evidence_redacted_at IS NULL
          AND evidence.sensitive_evidence_expires_at <= now()
          AND (evidence.tracking_url IS NOT NULL OR evidence.tracking_number IS NOT NULL
            OR evidence.provider_actor_fingerprint IS NOT NULL))
        + (SELECT count(*)::integer
        FROM operations_commerce_order_native_activity_evidence evidence
        WHERE evidence.sensitive_evidence_redacted_at IS NULL
          AND evidence.sensitive_evidence_expires_at <= now()
          AND (evidence.provider_action IS NOT NULL OR evidence.provider_message IS NOT NULL
            OR evidence.provider_actor_display_name IS NOT NULL))) AS expired_sensitive_evidence,
       totals.last_completed_at
     FROM active_health active
     CROSS JOIN terminal_totals totals
     CROSS JOIN terminal_health terminal`,
  )
  const row = result.rows[0]
  const scheduledPollPolicies = Number(row?.scheduled_poll_policies || 0)
  const webhookSignalPlusPollPolicies = Number(
    row?.webhook_signal_plus_poll_policies || 0,
  )
  const transport = scheduledPollPolicies > 0
    ? webhookSignalPlusPollPolicies > 0
      ? 'mixed' as const
      : 'scheduled_poll' as const
    : webhookSignalPlusPollPolicies > 0
      ? 'webhook_signal_plus_poll' as const
      : 'none' as const
  return {
    pending: Number(row?.pending || 0),
    processing: Number(row?.processing || 0),
    staleProcessing: Number(row?.stale_processing || 0),
    failed: Number(row?.failed || 0),
    dead: Number(row?.dead || 0),
    historicalDead: Number(row?.historical_dead || 0),
    blocked: Number(row?.blocked || 0),
    historicalBlocked: Number(row?.historical_blocked || 0),
    pausedRetainedSessions: Number(row?.paused_retained_sessions || 0),
    overduePolls: Number(row?.overdue_polls || 0),
    continuousTransportCounts: {
      scheduledPoll: scheduledPollPolicies,
      webhookSignalPlusPoll: webhookSignalPlusPollPolicies,
    },
    transport,
    expiredSensitiveEvidence: Number(row?.expired_sensitive_evidence || 0),
    lastCompletedAt: row?.last_completed_at?.toISOString() || null,
    pollingCadenceMinutes: { shopify: 30, faire: 5 } as const,
    providerWrites: 0 as const,
  }
}

export async function readCommerceOrderSyncCursorKeyReadinessFromPostgres() {
  const references = await query<{
    referenced_key_ids: string[]
    sealed_cursor_count: number
  }>(
    `SELECT COALESCE(
              array_agg(DISTINCT cursor_key_id ORDER BY cursor_key_id)
                FILTER (WHERE cursor_key_id IS NOT NULL),
              ARRAY[]::text[]
            ) AS referenced_key_ids,
            count(*) FILTER (
              WHERE cursor_ciphertext IS NOT NULL
            )::integer AS sealed_cursor_count
     FROM operations_commerce_order_backfill_sessions`,
  )
  const referencedKeyIds = references.rows[0]?.referenced_key_ids || []
  const sealedCursorCount = Number(
    references.rows[0]?.sealed_cursor_count || 0,
  )
  try {
    const configuration = resolveCommerceOrderRevisionEvidenceKeyConfig({
      environment: process.env,
      hosted: isHostedRuntime(),
    })
    return {
      ...summarizeCommerceOrderRevisionEvidenceKeyReadiness(configuration, {
        referencedKeyIds,
        unpurgedProtectedReadCount: sealedCursorCount,
      }),
      sealedCursorCount,
    }
  } catch {
    return {
      status: 'blocked' as const,
      ready: false,
      activeKeyId: null,
      configuredKeyIds: [] as string[],
      referencedKeyIds,
      missingReferencedKeyIds: referencedKeyIds,
      invalidReferencedKeyIdCount: 0,
      unpurgedProtectedReadCount: sealedCursorCount,
      sealedCursorCount,
    }
  }
}

export type CommerceOrderHistorySummary = {
  observationGlobalId: string
  externalOrderId: string
  orderNumber: string
  orderGlobalId: string | null
  provider: CommerceProvider
  lifecycleState: string
  paymentState: string
  fulfillmentState: string
  returnState: string
  orderedQuantity: number
  currentQuantity: number | null
  unfulfilledQuantity: number | null
  fulfilledQuantity: number | null
  currency: string | null
  totalMinor: number | null
  lastProviderUpdatedAt: string | null
  lastObservedAt: string
  shipmentCount: number
  trackingCount: number
  latestTrackingCarrier: string | null
  latestTrackingNumber: string | null
  providerWrites: 0
}

export type CommerceOrderHistorySummaryPage = {
  items: CommerceOrderHistorySummary[]
  nextCursorObservationGlobalId: string | null
  snapshotObservationGlobalId: string | null
  providerWrites: 0
}

function databaseSafeInteger(
  value: string | number | null,
  label: string,
  optional = false,
) {
  if (value === null && optional) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_EVIDENCE_INVALID',
      `${label} is outside the supported integer range`,
      500,
    )
  }
  return parsed
}

export async function readCommerceOrderHistorySummariesFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
  cursorObservationGlobalId?: string | null
  snapshotObservationGlobalId?: string | null
  limit?: number
}): Promise<CommerceOrderHistorySummaryPage> {
  const limit = Math.max(1, Math.min(Number(input.limit || 25), 100))
  const cursor = input.cursorObservationGlobalId
    ? text(input.cursorObservationGlobalId, 'Observation cursor', 32)
    : null
  const requestedSnapshot = input.snapshotObservationGlobalId
    ? text(input.snapshotObservationGlobalId, 'Observation snapshot', 32)
    : null
  if ((cursor === null) !== (requestedSnapshot === null)) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_HISTORY_CURSOR_INVALID',
      'Observation cursor and snapshot must be supplied together',
      400,
    )
  }
  if (cursor && requestedSnapshot) {
    const scoped = await query<{
      cursor_exists: boolean
      snapshot_exists: boolean
    }>(
       `WITH account AS (
         SELECT id, organization_id, provider
         FROM operations_integration_accounts
         WHERE organization_id = $1::uuid
           AND global_id = $2
           AND integration_type = 'commerce'
           AND provider IN ('shopify', 'faire')
         LIMIT 1
       )
       SELECT EXISTS (
                SELECT 1
                FROM operations_commerce_order_observations observation
                JOIN account
                  ON account.organization_id = observation.organization_id
                 AND account.id = observation.integration_account_id
                 AND account.provider = observation.provider
                WHERE observation.global_id = $3
              ) AS cursor_exists,
              EXISTS (
                SELECT 1
                FROM operations_commerce_order_observations observation
                JOIN account
                  ON account.organization_id = observation.organization_id
                 AND account.id = observation.integration_account_id
                 AND account.provider = observation.provider
                WHERE observation.global_id = $4
              ) AS snapshot_exists`,
      [
        input.organizationId,
        input.accountGlobalId,
        cursor,
        requestedSnapshot,
      ],
    )
    if (!scoped.rows[0]?.cursor_exists || !scoped.rows[0]?.snapshot_exists) {
      throw new CommerceOrderSyncError(
        'COMMERCE_ORDER_HISTORY_CURSOR_INVALID',
        'Observation cursor or snapshot is unavailable for this account',
        400,
      )
    }
  }
  const result = await query<{
    observation_global_id: string
    external_order_id: string
    order_number: string
    order_global_id: string | null
    provider: CommerceProvider
    lifecycle_state: string
    payment_state: string
    fulfillment_state: string
    return_state: string
    ordered_quantity: string
    current_quantity: string | null
    unfulfilled_quantity: string | null
    fulfilled_quantity: string | null
    currency: string | null
    total_minor: string | null
    last_provider_updated_at: Date | null
    last_observed_at: Date
    shipment_count: number
    tracking_count: number
    latest_tracking_carrier: string | null
    latest_tracking_number: string | null
    snapshot_observation_global_id: string
  }>(
    `WITH account AS (
       SELECT id, organization_id, provider
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND integration_type = 'commerce'
         AND provider IN ('shopify', 'faire')
       LIMIT 1
     ), snapshot AS (
       SELECT observation.created_at, observation.id, observation.global_id
       FROM operations_commerce_order_observations observation
       JOIN account
         ON account.organization_id = observation.organization_id
        AND account.id = observation.integration_account_id
        AND account.provider = observation.provider
       WHERE (
         ($4::text IS NULL AND observation.id = (
           SELECT newest.id
           FROM operations_commerce_order_observations newest
           JOIN account newest_account
             ON newest_account.organization_id = newest.organization_id
            AND newest_account.id = newest.integration_account_id
            AND newest_account.provider = newest.provider
           ORDER BY newest.created_at DESC, newest.id DESC
           LIMIT 1
         ))
         OR observation.global_id = $4
       )
       ORDER BY observation.created_at DESC, observation.id DESC
       LIMIT 1
     ), ranked AS (
       SELECT observation.*,
              row_number() OVER (
                PARTITION BY observation.external_order_id
                ORDER BY observation.observed_at DESC, observation.id DESC
              ) AS recency
       FROM operations_commerce_order_observations observation
       JOIN account
         ON account.organization_id = observation.organization_id
        AND account.id = observation.integration_account_id
        AND account.provider = observation.provider
       JOIN snapshot
         ON (observation.created_at, observation.id)
              <= (snapshot.created_at, snapshot.id)
     ), latest AS (
       SELECT * FROM ranked WHERE recency = 1
     ), boundary AS (
       SELECT observation.observed_at, observation.id
       FROM operations_commerce_order_observations observation
       JOIN account
         ON account.organization_id = observation.organization_id
        AND account.id = observation.integration_account_id
        AND account.provider = observation.provider
       JOIN snapshot
         ON (observation.created_at, observation.id)
              <= (snapshot.created_at, snapshot.id)
       WHERE observation.global_id = $3
     )
     SELECT latest.global_id AS observation_global_id,
            latest.external_order_id, latest.order_number,
            canonical.global_id AS order_global_id,
            latest.provider,
            latest.canonical_lifecycle_state AS lifecycle_state,
            latest.canonical_payment_state AS payment_state,
            latest.canonical_fulfillment_state AS fulfillment_state,
            latest.canonical_return_state AS return_state,
            COALESCE(lines.ordered_quantity, 0)::text AS ordered_quantity,
            lines.current_quantity::text,
            lines.unfulfilled_quantity::text,
            lines.fulfilled_quantity::text,
            latest.currency, latest.provider_total_minor::text AS total_minor,
            latest.provider_updated_at AS last_provider_updated_at,
            latest.observed_at AS last_observed_at,
            COALESCE(events.shipment_count, 0)::integer AS shipment_count,
            COALESCE(events.tracking_count, 0)::integer AS tracking_count,
            tracking.tracking_carrier AS latest_tracking_carrier,
            tracking.tracking_number AS latest_tracking_number,
            snapshot.global_id AS snapshot_observation_global_id
     FROM latest
     CROSS JOIN snapshot
     LEFT JOIN LATERAL (
       SELECT exact_order.global_id
       FROM operations_orders exact_order
       WHERE exact_order.organization_id = latest.organization_id
         AND exact_order.integration_account_id = latest.integration_account_id
         AND exact_order.source_provider = latest.provider
         AND exact_order.external_order_id = latest.external_order_id
       ORDER BY exact_order.created_at, exact_order.id
       LIMIT 1
     ) canonical ON true
     LEFT JOIN LATERAL (
       SELECT sum(line.original_quantity) AS ordered_quantity,
              CASE WHEN count(*) FILTER (
                WHERE line.current_quantity IS NULL
              ) = 0 THEN sum(line.current_quantity) END AS current_quantity,
              CASE WHEN count(*) FILTER (
                WHERE line.unfulfilled_quantity IS NULL
              ) = 0 THEN sum(line.unfulfilled_quantity) END
                AS unfulfilled_quantity,
              CASE WHEN count(*) FILTER (
                WHERE line.fulfilled_quantity IS NULL
              ) = 0 THEN sum(line.fulfilled_quantity) END
                AS fulfilled_quantity
       FROM operations_commerce_order_observation_lines line
       WHERE line.organization_id = latest.organization_id
         AND line.observation_id = latest.id
     ) lines ON true
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE event.event_kind IN (
                'fulfillment_created', 'shipment_created'
              ))::integer AS shipment_count,
              count(*) FILTER (
                WHERE event.event_kind = 'tracking_updated'
                  AND event.tracking_number IS NOT NULL
              )::integer AS tracking_count
       FROM operations_commerce_order_event_observations event
       JOIN operations_commerce_order_observations event_observation
         ON event_observation.organization_id = event.organization_id
        AND event_observation.id = event.observation_id
       WHERE event.organization_id = latest.organization_id
         AND event.integration_account_id = latest.integration_account_id
         AND event.provider = latest.provider
         AND event.external_order_id = latest.external_order_id
         AND (event_observation.created_at, event_observation.id)
              <= (snapshot.created_at, snapshot.id)
     ) events ON true
     LEFT JOIN LATERAL (
       SELECT event.tracking_carrier, event.tracking_number
       FROM operations_commerce_order_event_observations event
       JOIN operations_commerce_order_observations event_observation
         ON event_observation.organization_id = event.organization_id
        AND event_observation.id = event.observation_id
       WHERE event.organization_id = latest.organization_id
         AND event.integration_account_id = latest.integration_account_id
         AND event.provider = latest.provider
         AND event.external_order_id = latest.external_order_id
         AND (event_observation.created_at, event_observation.id)
              <= (snapshot.created_at, snapshot.id)
         AND event.event_kind = 'tracking_updated'
         AND event.sensitive_evidence_expires_at > now()
       ORDER BY event.occurred_at DESC,
                (event.tracking_number IS NOT NULL) DESC,
                event.external_event_id DESC NULLS LAST,
                event.id DESC
       LIMIT 1
     ) tracking ON true
     WHERE (
       $3::text IS NULL
       OR EXISTS (SELECT 1 FROM boundary)
     ) AND (
       $3::text IS NULL
       OR (latest.observed_at, latest.id) < (
         SELECT observed_at, id FROM boundary
       )
     )
     ORDER BY latest.observed_at DESC, latest.id DESC
     LIMIT $5`,
    [
      input.organizationId,
      input.accountGlobalId,
      cursor,
      requestedSnapshot,
      limit + 1,
    ],
  )
  const rows = result.rows.slice(0, limit)
  const items = rows.map((row): CommerceOrderHistorySummary => ({
    observationGlobalId: row.observation_global_id,
    externalOrderId: row.external_order_id,
    orderNumber: row.order_number,
    orderGlobalId: row.order_global_id,
    provider: row.provider,
    lifecycleState: row.lifecycle_state,
    paymentState: row.payment_state,
    fulfillmentState: row.fulfillment_state,
    returnState: row.return_state,
    orderedQuantity: databaseSafeInteger(
      row.ordered_quantity,
      'Historical ordered quantity',
    ) as number,
    currentQuantity: row.current_quantity === null
      ? null : databaseSafeInteger(
          row.current_quantity,
          'Historical current quantity',
          true,
        ),
    unfulfilledQuantity: row.unfulfilled_quantity === null
      ? null : databaseSafeInteger(
          row.unfulfilled_quantity,
          'Historical unfulfilled quantity',
          true,
        ),
    fulfilledQuantity: row.fulfilled_quantity === null
      ? null : databaseSafeInteger(
          row.fulfilled_quantity,
          'Historical fulfilled quantity',
          true,
        ),
    currency: row.currency,
    totalMinor: row.total_minor === null
      ? null
      : databaseSafeInteger(row.total_minor, 'Historical order total', true),
    lastProviderUpdatedAt: row.last_provider_updated_at?.toISOString() || null,
    lastObservedAt: row.last_observed_at.toISOString(),
    shipmentCount: row.shipment_count,
    trackingCount: row.tracking_count,
    latestTrackingCarrier: row.latest_tracking_carrier,
    latestTrackingNumber: row.latest_tracking_number,
    providerWrites: 0,
  }))
  return {
    items,
    nextCursorObservationGlobalId: result.rows.length > limit
      ? items.at(-1)?.observationGlobalId || null
      : null,
    snapshotObservationGlobalId:
      result.rows[0]?.snapshot_observation_global_id || requestedSnapshot || null,
    providerWrites: 0,
  }
}

export type CommerceOrderEvidenceTimelineEntry = {
  evidenceSource: 'provider' | 'clawpilot'
  evidenceGlobalId: string
  eventKind: string
  eventStatus: string | null
  occurredAt: string
  attributionSource: string
  actorEmail: string | null
  providerActorFingerprint: string | null
  locationReference: string | null
  payload: Record<string, unknown>
}

export type CommerceOrderEvidenceTimelinePage = {
  items: CommerceOrderEvidenceTimelineEntry[]
  truncated: boolean
  limit: 500
  providerWrites: 0
}

export async function readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres(
  input: {
    organizationId: string
    accountGlobalId: string
    externalOrderId: string
    providerObservationKinds?: readonly CommerceOrderObservationKind[]
  },
): Promise<CommerceOrderEvidenceTimelinePage> {
  const providerObservationKinds = input.providerObservationKinds || null
  if (
    providerObservationKinds
    && (
      providerObservationKinds.length < 1
      || new Set(providerObservationKinds).size
        !== providerObservationKinds.length
      || providerObservationKinds.some((kind) => !OBSERVATION_KINDS.has(kind))
    )
  ) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_INPUT_INVALID',
      'Provider observation-kind anchor is invalid',
      400,
    )
  }
  const result = await query<{
    evidence_source: 'provider' | 'clawpilot'
    required_line_snapshot: boolean
    evidence_global_id: string
    event_kind: string
    event_status: string | null
    occurred_at: Date
    attribution_source: string
    actor_email: string | null
    provider_actor_fingerprint: string | null
    location_reference: string | null
    payload: Record<string, unknown>
  }>(
    `WITH account AS (
       SELECT id, organization_id, provider
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND integration_type = 'commerce'
         AND provider IN ('shopify', 'faire')
       LIMIT 1
     ), canonical AS (
       SELECT orders.id
       FROM operations_orders orders
       JOIN account
         ON account.organization_id = orders.organization_id
        AND account.id = orders.integration_account_id
        AND account.provider = orders.source_provider
       WHERE orders.external_order_id = $3
       LIMIT 1
     ), latest_observation AS (
       SELECT observation.*
       FROM operations_commerce_order_observations observation
       JOIN account
         ON account.organization_id = observation.organization_id
        AND account.id = observation.integration_account_id
        AND account.provider = observation.provider
       WHERE observation.external_order_id = $3
         AND (
           $4::text[] IS NULL
           OR observation.observation_kind = ANY($4::text[])
         )
       ORDER BY COALESCE(
                  observation.provider_updated_at,
                  observation.observed_at
                ) DESC,
                observation.observed_at DESC,
                observation.id DESC
       LIMIT 1
     )
     SELECT 'provider'::text AS evidence_source,
            false AS required_line_snapshot,
            event.global_id AS evidence_global_id,
            event.event_kind, ${COMMERCE_ORDER_NATIVE_ACTION_SQL} AS event_status,
            event.occurred_at,
            CASE WHEN event.sensitive_evidence_expires_at <= now()
                   AND event.attribution_source = 'provider_staff'
              THEN 'unavailable' ELSE event.attribution_source END,
            event.actor_email,
            CASE WHEN event.sensitive_evidence_expires_at > now()
              THEN event.provider_actor_fingerprint ELSE NULL END,
            event.provider_location_id AS location_reference,
            jsonb_strip_nulls(jsonb_build_object(
              'externalSubjectId', event.external_subject_id,
              'quantity', event.quantity,
              'amountMinor', event.amount_minor,
              'currency', event.currency,
              'inventoryEffectKind', event.inventory_effect_kind,
              'trackingCarrier', event.tracking_carrier,
              'trackingNumber', CASE
                WHEN event.sensitive_evidence_expires_at > now()
                  THEN event.tracking_number ELSE NULL END,
              'trackingUrl', ${COMMERCE_ORDER_TRACKING_URL_VALUE_SQL},
              'providerMessage', ${COMMERCE_ORDER_NATIVE_MESSAGE_SQL},
              'providerActorDisplayName', ${COMMERCE_ORDER_NATIVE_ACTOR_SQL},
              'nativeActivityRedacted', CASE WHEN event.event_kind = 'provider_activity'
                THEN ${COMMERCE_ORDER_NATIVE_REDACTED_SQL} ELSE NULL END,
              'sensitiveEvidenceRedactedAt',
                event.sensitive_evidence_redacted_at
            )) AS payload
     FROM operations_commerce_order_event_observations event
     JOIN account
       ON account.organization_id = event.organization_id
      AND account.id = event.integration_account_id
      AND account.provider = event.provider
     JOIN operations_commerce_order_observations event_observation
       ON event_observation.organization_id = event.organization_id
      AND event_observation.id = event.observation_id
      AND event_observation.integration_account_id
          = event.integration_account_id
      AND event_observation.provider = event.provider
      AND event_observation.external_order_id = event.external_order_id
     ${commerceOrderTrackingUrlEvidenceJoinSql(`$4::text[] IS NULL OR EXISTS (
       SELECT 1 FROM latest_observation anchor
       WHERE (COALESCE(url_observation.provider_updated_at, url_observation.observed_at),
              url_observation.observed_at, url_observation.id)
         <= (COALESCE(anchor.provider_updated_at, anchor.observed_at), anchor.observed_at, anchor.id)
         AND url_observation.observed_at <= anchor.observed_at
     )`)}
     ${commerceOrderNativeActivityJoinSql(`$4::text[] IS NULL OR EXISTS (
       SELECT 1 FROM latest_observation anchor
       WHERE (COALESCE(native_observation.provider_updated_at, native_observation.observed_at),
              native_observation.observed_at, native_observation.id)
         <= (COALESCE(anchor.provider_updated_at, anchor.observed_at), anchor.observed_at, anchor.id)
         AND native_observation.observed_at <= anchor.observed_at
     )`)}
     WHERE event.external_order_id = $3
       AND (
         $4::text[] IS NULL
         OR EXISTS (
           SELECT 1
           FROM latest_observation anchor
           WHERE (
             COALESCE(
               event_observation.provider_updated_at,
               event_observation.observed_at
             ),
             event_observation.observed_at,
             event_observation.id
           ) <= (
             COALESCE(anchor.provider_updated_at, anchor.observed_at),
             anchor.observed_at,
             anchor.id
           )
             AND (event.event_kind <> 'provider_activity'
               OR event_observation.observed_at <= anchor.observed_at)
         )
       )
     UNION ALL
     SELECT 'provider'::text AS evidence_source,
            true AS required_line_snapshot,
            latest.global_id AS evidence_global_id,
            'order_lines_snapshot'::text AS event_kind,
            NULL::text AS event_status,
            COALESCE(latest.provider_updated_at, latest.observed_at)
              AS occurred_at,
            'provider_system'::text AS attribution_source,
            NULL::text AS actor_email,
            NULL::text AS provider_actor_fingerprint,
            NULL::text AS location_reference,
            jsonb_build_object(
              'observationGlobalId', latest.global_id,
              'observedAt', latest.observed_at,
              'inventorySemantics', 'order_demand',
              'lines', COALESCE(lines.payload, '[]'::jsonb)
            ) || CASE WHEN latest.native_activity_state IS NULL THEN '{}'::jsonb
              ELSE jsonb_strip_nulls(jsonb_build_object(
                'nativeActivityState', latest.native_activity_state,
                'nativeActivityReason', latest.native_activity_reason,
                'nativeActivityFetchedCount', latest.native_activity_fetched_count
              )) END AS payload
     FROM latest_observation latest
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'externalLineId', line.external_line_id,
                'externalProductId', line.external_product_id,
                'externalVariantId', line.external_variant_id,
                'sku', line.sku,
                'titleSnapshot', line.title_snapshot,
                'variantTitleSnapshot', line.variant_title_snapshot,
                'vendorSnapshot', line.vendor_snapshot,
                'originalQuantity', line.original_quantity,
                'currentQuantity', line.current_quantity,
                'unfulfilledQuantity', line.unfulfilled_quantity,
                'fulfilledQuantity', line.fulfilled_quantity,
                'returnedQuantity', line.returned_quantity,
                'requiresShipping', line.requires_shipping,
                'unitPriceCurrency', line.unit_price_currency,
                'unitPriceMinor', line.unit_price_minor::text,
                'subtotalCurrency', line.subtotal_currency,
                'subtotalMinor', line.subtotal_minor::text,
                'discountCurrency', line.discount_currency,
                'discountMinor', line.discount_minor::text,
                'taxCurrency', line.tax_currency,
                'taxMinor', line.tax_minor::text
              )) ORDER BY line.external_line_id) AS payload
       FROM operations_commerce_order_observation_lines line
       WHERE line.organization_id = latest.organization_id
         AND line.observation_id = latest.id
     ) lines ON true
     UNION ALL
     SELECT 'clawpilot'::text AS evidence_source,
            false AS required_line_snapshot,
            domain.global_id AS evidence_global_id,
            domain.event_type AS event_kind,
            NULL::text AS event_status,
            domain.occurred_at,
            CASE WHEN domain.event_type IN (
                'operations.pick.assigned', 'operations.pick.reassigned',
                'operations.pick.manager_unassigned',
                'operations.pick.completed'
              ) AND EXISTS (
                SELECT 1
                FROM app_user_organization_memberships membership
                WHERE membership.organization_id = domain.organization_id
                  AND membership.user_email = domain.actor_email
                  AND membership.status IN ('active', 'disabled')
              ) THEN 'clawpilot_user' ELSE 'unavailable' END,
            CASE WHEN domain.event_type IN (
                'operations.pick.assigned', 'operations.pick.reassigned',
                'operations.pick.manager_unassigned',
                'operations.pick.completed'
              ) AND EXISTS (
                SELECT 1
                FROM app_user_organization_memberships membership
                WHERE membership.organization_id = domain.organization_id
                  AND membership.user_email = domain.actor_email
                  AND membership.status IN ('active', 'disabled')
              ) THEN domain.actor_email ELSE NULL END,
            NULL::text, NULL::text,
            CASE
              WHEN domain.event_type IN (
                'operations.pick.assigned', 'operations.pick.reassigned',
                'operations.pick.manager_unassigned'
              ) THEN jsonb_strip_nulls(jsonb_build_object(
                'assignedTo', CASE
                  WHEN jsonb_typeof(domain.payload -> 'assignedTo') = 'string'
                   AND EXISTS (
                     SELECT 1
                     FROM app_user_organization_memberships membership
                     WHERE membership.organization_id = domain.organization_id
                       AND membership.user_email = domain.payload ->> 'assignedTo'
                       AND membership.status IN ('active', 'disabled')
                   ) THEN domain.payload -> 'assignedTo'
                  ELSE NULL
                END,
                'previousAssignedTo', CASE
                  WHEN jsonb_typeof(domain.payload -> 'previousAssignedTo')
                        = 'string'
                   AND EXISTS (
                     SELECT 1
                     FROM app_user_organization_memberships membership
                     WHERE membership.organization_id = domain.organization_id
                       AND membership.user_email
                         = domain.payload ->> 'previousAssignedTo'
                       AND membership.status IN ('active', 'disabled')
                   ) THEN domain.payload -> 'previousAssignedTo'
                  ELSE NULL
                END
              ))
              WHEN domain.event_type = 'operations.pick.completed'
                THEN jsonb_strip_nulls(jsonb_build_object(
                  'quantity', CASE
                    WHEN jsonb_typeof(domain.payload -> 'quantity') = 'number'
                      THEN domain.payload -> 'quantity'
                    ELSE NULL
                  END
                ))
              ELSE '{}'::jsonb
            END AS payload
     FROM operations_domain_events domain
     JOIN canonical ON canonical.id = domain.aggregate_id
     WHERE domain.organization_id = $1::uuid
       AND domain.aggregate_type = 'operations.order'
     ORDER BY required_line_snapshot DESC,
              occurred_at DESC, evidence_global_id DESC
     LIMIT 501`,
    [
      input.organizationId,
      input.accountGlobalId,
      text(input.externalOrderId, 'External order ID', 512),
      providerObservationKinds,
    ],
  )
  const requiredLineSnapshot = result.rows.find(
    (row) => row.required_line_snapshot,
  )
  const retained = [
    ...(requiredLineSnapshot ? [requiredLineSnapshot] : []),
    ...result.rows
      .filter((row) => !row.required_line_snapshot)
      .slice(0, requiredLineSnapshot ? 499 : 500),
  ].sort((left, right) => (
    left.occurred_at.getTime() - right.occurred_at.getTime()
      || left.evidence_global_id.localeCompare(right.evidence_global_id)
  ))
  return {
    items: retained.map((row) => ({
    evidenceSource: row.evidence_source,
    evidenceGlobalId: row.evidence_global_id,
    eventKind: row.event_kind,
    eventStatus: row.event_status,
    occurredAt: row.occurred_at.toISOString(),
    attributionSource: row.attribution_source,
    actorEmail: row.actor_email,
    providerActorFingerprint: row.provider_actor_fingerprint,
    locationReference: row.location_reference,
    payload: row.payload,
    })),
    truncated: result.rows.length > retained.length,
    limit: 500,
    providerWrites: 0,
  }
}

export async function readCommerceOrderEvidenceTimelineFromPostgres(input: {
  organizationId: string
  orderGlobalId: string
}) {
  const result = await query<{
    evidence_source: 'provider' | 'clawpilot'
    evidence_global_id: string
    event_kind: string
    event_status: string | null
    occurred_at: Date
    attribution_source: string
    actor_email: string | null
    provider_actor_fingerprint: string | null
    location_reference: string | null
    payload: Record<string, unknown>
  }>(
    `WITH target AS (
       SELECT id, organization_id, integration_account_id, source_provider,
              external_order_id
       FROM operations_orders
       WHERE organization_id = $1::uuid
         AND global_id = $2
       LIMIT 1
     )
     SELECT 'provider'::text AS evidence_source,
            event.global_id AS evidence_global_id,
            event.event_kind, ${COMMERCE_ORDER_NATIVE_ACTION_SQL} AS event_status,
            event.occurred_at,
            CASE WHEN event.sensitive_evidence_expires_at <= now()
                   AND event.attribution_source = 'provider_staff'
              THEN 'unavailable' ELSE event.attribution_source END,
            event.actor_email,
            CASE WHEN event.sensitive_evidence_expires_at > now()
              THEN event.provider_actor_fingerprint ELSE NULL END,
            event.provider_location_id AS location_reference,
            jsonb_strip_nulls(jsonb_build_object(
              'externalSubjectId', event.external_subject_id,
              'quantity', event.quantity,
              'amountMinor', event.amount_minor,
              'currency', event.currency,
              'inventoryEffectKind', event.inventory_effect_kind,
              'trackingCarrier', event.tracking_carrier,
              'trackingNumber', CASE
                WHEN event.sensitive_evidence_expires_at > now()
                  THEN event.tracking_number ELSE NULL END,
              'trackingUrl', ${COMMERCE_ORDER_TRACKING_URL_VALUE_SQL},
              'providerMessage', ${COMMERCE_ORDER_NATIVE_MESSAGE_SQL},
              'providerActorDisplayName', ${COMMERCE_ORDER_NATIVE_ACTOR_SQL},
              'nativeActivityRedacted', CASE WHEN event.event_kind = 'provider_activity'
                THEN ${COMMERCE_ORDER_NATIVE_REDACTED_SQL} ELSE NULL END
            )) AS payload
     FROM operations_commerce_order_event_observations event
     JOIN target
       ON target.organization_id = event.organization_id
      AND target.integration_account_id = event.integration_account_id
      AND target.source_provider = event.provider
      AND target.external_order_id = event.external_order_id
     ${commerceOrderTrackingUrlEvidenceJoinSql()}
     ${commerceOrderNativeActivityJoinSql()}
     UNION ALL
     SELECT 'clawpilot'::text AS evidence_source,
            domain.global_id AS evidence_global_id,
            domain.event_type AS event_kind,
            NULL::text AS event_status,
            domain.occurred_at,
            CASE WHEN domain.event_type IN (
                'operations.pick.assigned', 'operations.pick.reassigned',
                'operations.pick.manager_unassigned',
                'operations.pick.completed'
              ) AND EXISTS (
                SELECT 1
                FROM app_user_organization_memberships membership
                WHERE membership.organization_id = domain.organization_id
                  AND membership.user_email = domain.actor_email
                  AND membership.status IN ('active', 'disabled')
              ) THEN 'clawpilot_user' ELSE 'unavailable' END
              AS attribution_source,
            CASE WHEN domain.event_type IN (
                'operations.pick.assigned', 'operations.pick.reassigned',
                'operations.pick.manager_unassigned',
                'operations.pick.completed'
              ) AND EXISTS (
                SELECT 1
                FROM app_user_organization_memberships membership
                WHERE membership.organization_id = domain.organization_id
                  AND membership.user_email = domain.actor_email
                  AND membership.status IN ('active', 'disabled')
              ) THEN domain.actor_email ELSE NULL END,
            NULL::text AS provider_actor_fingerprint,
            NULL::text AS location_reference,
            CASE
              WHEN domain.event_type IN (
                'operations.pick.assigned', 'operations.pick.reassigned',
                'operations.pick.manager_unassigned'
              ) THEN jsonb_strip_nulls(jsonb_build_object(
                'assignedTo', CASE
                  WHEN jsonb_typeof(domain.payload -> 'assignedTo') = 'string'
                   AND EXISTS (
                     SELECT 1
                     FROM app_user_organization_memberships membership
                     WHERE membership.organization_id = domain.organization_id
                       AND membership.user_email = domain.payload ->> 'assignedTo'
                       AND membership.status IN ('active', 'disabled')
                   ) THEN domain.payload -> 'assignedTo'
                  ELSE NULL
                END,
                'previousAssignedTo', CASE
                  WHEN jsonb_typeof(domain.payload -> 'previousAssignedTo')
                        = 'string'
                   AND EXISTS (
                     SELECT 1
                     FROM app_user_organization_memberships membership
                     WHERE membership.organization_id = domain.organization_id
                       AND membership.user_email
                         = domain.payload ->> 'previousAssignedTo'
                       AND membership.status IN ('active', 'disabled')
                   ) THEN domain.payload -> 'previousAssignedTo'
                  ELSE NULL
                END
              ))
              WHEN domain.event_type = 'operations.pick.completed'
                THEN jsonb_strip_nulls(jsonb_build_object(
                  'quantity', CASE
                    WHEN jsonb_typeof(domain.payload -> 'quantity') = 'number'
                      THEN domain.payload -> 'quantity'
                    ELSE NULL
                  END
                ))
              ELSE '{}'::jsonb
            END AS payload
     FROM operations_domain_events domain
     JOIN target
       ON target.organization_id = domain.organization_id
      AND domain.aggregate_type = 'operations.order'
      AND domain.aggregate_id = target.id
     ORDER BY occurred_at, evidence_global_id`,
    [input.organizationId, input.orderGlobalId],
  )
  return result.rows.map((row) => ({
    evidenceSource: row.evidence_source,
    evidenceGlobalId: row.evidence_global_id,
    eventKind: row.event_kind,
    eventStatus: row.event_status,
    occurredAt: row.occurred_at.toISOString(),
    attributionSource: row.attribution_source,
    actorEmail: row.actor_email,
    providerActorFingerprint: row.provider_actor_fingerprint,
    locationReference: row.location_reference,
    payload: row.payload,
  }))
}
