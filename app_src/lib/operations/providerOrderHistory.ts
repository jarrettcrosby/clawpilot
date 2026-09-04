import type { CommerceOrderEvidenceTimelinePage } from '@/lib/persistence/commerceOrderSync'
import type { OperationsNativeActivityCoverage, OperationsProviderOrderHistory } from './types'

type PresentableTimelineEvent = {
  evidenceSource: string
  eventKind: string
  eventStatus: string | null
  occurredAt: string
  locationReference?: string | null
  payload: Record<string, unknown>
}

/**
 * Shopify exposes a fulfillment's tracking status alongside its tracking
 * numbers. Keep every concrete package/change, but do not display a second
 * generic status row for the same fulfillment, timestamp, and status.
 * This is presentation only: retained provider/audit evidence is untouched.
 */
export function presentCommerceOrderTimelineEvents<T extends PresentableTimelineEvent>(
  events: readonly T[],
): T[] {
  const trackingKey = (event: T) => {
    const subject = optionalTimelineText(event.payload.externalSubjectId)
    return event.evidenceSource === 'provider'
      && event.eventKind === 'tracking_updated'
      && subject
      ? JSON.stringify([
          subject, event.occurredAt, event.eventStatus,
          event.locationReference || null,
        ])
      : null
  }
  const hasTracking = (event: T) => Boolean(
    optionalTimelineText(event.payload.trackingNumber)
    || optionalTimelineText(event.payload.trackingUrl),
  )
  const concreteTracking = new Set(events.flatMap((event) => {
    const key = trackingKey(event)
    return key && hasTracking(event) ? [key] : []
  }))
  return events.filter((event) => {
    const key = trackingKey(event)
    return !key
      || hasTracking(event)
      || Boolean(optionalTimelineText(event.payload.sensitiveEvidenceRedactedAt))
      || !concreteTracking.has(key)
  })
}

function optionalTimelineText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function optionalTimelineInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null
}

export function nativeActivityCoverageFromPayload(
  payload: Record<string, unknown> | undefined,
  truncated = false,
): OperationsNativeActivityCoverage | undefined {
  const state = payload?.nativeActivityState
  const count = optionalTimelineInteger(payload?.nativeActivityFetchedCount)
  if ((state !== 'complete' && state !== 'partial' && state !== 'unavailable')
    || count === null || count < 0 || count > 500) return undefined
  return { state, reason: optionalTimelineText(payload?.nativeActivityReason),
    fetchedCount: count, displayTruncated: truncated }
}

function optionalTimelineMinor(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value)
  }
  if (typeof value !== 'string' || !/^-?[0-9]+$/u.test(value)) return null
  const parsed = BigInt(value)
  return parsed >= BigInt(Number.MIN_SAFE_INTEGER)
      && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
    ? value
    : null
}

export function emptyOperationsProviderOrderHistory(
  observedAt: string | null = null,
): OperationsProviderOrderHistory {
  return {
    observedAt,
    currency: null,
    providerTotalMinor: null,
    currentLines: [],
    events: [],
    providerWrites: 0,
  }
}

/**
 * Projects append-only provider evidence without changing local order demand.
 * Callers own the freshness decision that makes a timeline current.
 */
export function operationsProviderHistoryFromTimeline(
  timeline: CommerceOrderEvidenceTimelinePage,
): OperationsProviderOrderHistory {
  const providerEvents = presentCommerceOrderTimelineEvents(timeline.items).filter((event) => (
    event.evidenceSource === 'provider'
  ))
  const lineSnapshot = providerEvents.find((event) => (
    event.eventKind === 'order_lines_snapshot'
  )) || null
  const rawLines = Array.isArray(lineSnapshot?.payload.lines)
    ? lineSnapshot.payload.lines
    : []
  const nativeActivity = nativeActivityCoverageFromPayload(lineSnapshot?.payload, timeline.truncated)
  const currentLines = rawLines.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const line = value as Record<string, unknown>
    const externalLineId = optionalTimelineText(line.externalLineId)
    const orderedQuantity = optionalTimelineInteger(line.originalQuantity)
    if (!externalLineId || orderedQuantity === null) return []
    return [{
      externalLineId,
      externalProductId: optionalTimelineText(line.externalProductId),
      externalVariantId: optionalTimelineText(line.externalVariantId),
      sku: optionalTimelineText(line.sku),
      titleSnapshot: optionalTimelineText(line.titleSnapshot),
      variantTitleSnapshot: optionalTimelineText(line.variantTitleSnapshot),
      vendorSnapshot: optionalTimelineText(line.vendorSnapshot),
      orderedQuantity,
      currentQuantity: optionalTimelineInteger(line.currentQuantity),
      fulfilledQuantity: optionalTimelineInteger(line.fulfilledQuantity),
      unfulfilledQuantity: optionalTimelineInteger(line.unfulfilledQuantity),
      returnedQuantity: optionalTimelineInteger(line.returnedQuantity),
      requiresShipping: typeof line.requiresShipping === 'boolean'
        ? line.requiresShipping
        : null,
      unitPriceCurrency: optionalTimelineText(line.unitPriceCurrency),
      unitPriceMinor: optionalTimelineMinor(line.unitPriceMinor),
      subtotalCurrency: optionalTimelineText(line.subtotalCurrency),
      subtotalMinor: optionalTimelineMinor(line.subtotalMinor),
      discountCurrency: optionalTimelineText(line.discountCurrency),
      discountMinor: optionalTimelineMinor(line.discountMinor),
      taxCurrency: optionalTimelineText(line.taxCurrency),
      taxMinor: optionalTimelineMinor(line.taxMinor),
    }]
  })
  return {
    observedAt: optionalTimelineText(lineSnapshot?.payload.observedAt),
    currency: null,
    providerTotalMinor: null,
    ...(nativeActivity ? { nativeActivity } : {}),
    currentLines,
    events: providerEvents.flatMap((event) => {
      if (event.eventKind === 'order_lines_snapshot') return []
      const trackingNumber = optionalTimelineText(event.payload.trackingNumber)
      const trackingUrl = optionalTimelineText(event.payload.trackingUrl)
      return [{
        globalId: event.evidenceGlobalId,
        kind: event.eventKind,
        status: event.eventStatus,
        occurredAt: event.occurredAt,
        externalSubjectId: optionalTimelineText(
          event.payload.externalSubjectId,
        ),
        quantity: optionalTimelineInteger(event.payload.quantity),
        amountMinor: optionalTimelineInteger(event.payload.amountMinor),
        currency: optionalTimelineText(event.payload.currency),
        trackingCarrier: optionalTimelineText(event.payload.trackingCarrier),
        trackingNumber,
        trackingUrl,
        trackingRedacted: event.eventKind === 'tracking_updated'
          && trackingNumber === null
          && trackingUrl === null
          && optionalTimelineText(
            event.payload.sensitiveEvidenceRedactedAt,
          ) !== null,
        ...(event.eventKind === 'provider_activity' ? {
          providerMessage: optionalTimelineText(event.payload.providerMessage),
          providerActorDisplayName: optionalTimelineText(event.payload.providerActorDisplayName),
          nativeActivityRedacted: event.payload.nativeActivityRedacted === true,
        } : {}),
      }]
    }),
    providerWrites: 0,
  }
}
