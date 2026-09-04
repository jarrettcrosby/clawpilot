import type { OperationsProviderOrderHistory } from './types'

type TrackingEvent = OperationsProviderOrderHistory['events'][number]

/** A drawer summary only; retain the original history and never borrow missing fields. */
export function currentOrderTrackingEvents<T extends TrackingEvent>(events: readonly T[]): T[] {
  const identity = (event: T) => {
    if (event.kind !== 'tracking_updated' || event.trackingRedacted) return null
    const parts = [event.externalSubjectId, event.trackingCarrier, event.trackingNumber]
    if (parts.some((part) => typeof part !== 'string' || !part.trim())) return null
    if (!Number.isFinite(Date.parse(event.occurredAt))) return null
    // Provider identifiers are opaque: do not trim, case-fold or coerce them.
    return JSON.stringify(parts)
  }
  const latest = new Map<string, number>()
  for (const event of events) {
    const key = identity(event)
    if (key !== null) latest.set(key, Math.max(
      latest.get(key) ?? -Infinity,
      Date.parse(event.occurredAt),
    ))
  }
  return events.filter((event) => {
    const key = identity(event)
    // Equal latest timestamps cannot establish which row supersedes the other.
    return key === null || Date.parse(event.occurredAt) === latest.get(key)
  })
}
