import type { CommerceOrderEvidenceTimelinePage } from '@/lib/persistence/commerceOrderSync'
import type { OperationsProviderOrderHistory } from './types'

function optionalTimelineText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function optionalTimelineInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null
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
  const providerEvents = timeline.items.filter((event) => (
    event.evidenceSource === 'provider'
  ))
  const lineSnapshot = providerEvents.find((event) => (
    event.eventKind === 'order_lines_snapshot'
  )) || null
  const rawLines = Array.isArray(lineSnapshot?.payload.lines)
    ? lineSnapshot.payload.lines
    : []
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
      }]
    }),
    providerWrites: 0,
  }
}
