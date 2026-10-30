type Meeting = Record<string, unknown>
const text = (record: Meeting, key: string) => typeof record[key] === 'string' ? record[key].trim() : ''

/** Import provenance is not an invitation-delivery receipt. */
export function meetingCalendarPresentation(record: Meeting): {
  label: string; color: 'default' | 'success' | 'warning' | 'error'
} {
  const status = text(record, 'status').toLowerCase()
  const delivery = text(record, 'calendarDeliveryStatus').toLowerCase()
  if (status === 'cancelled' || delivery === 'cancelled') return { label: 'Cancelled', color: 'default' }
  if (delivery === 'failed') return { label: 'Failed', color: 'error' }
  if (delivery === 'queued') return { label: 'Pending', color: 'warning' }
  if (delivery === 'not-configured') return { label: 'Not configured', color: 'warning' }
  if (status === 'completed') return { label: 'Completed', color: 'default' }
  if (delivery === 'sent') return { label: 'Delivered', color: 'success' }
  if (record.calendarImported === true && text(record, 'provider') === 'google-calendar'
    && text(record, 'externalEventId') && text(record, 'calendarId')) {
    return { label: 'Imported from Google Calendar', color: 'default' }
  }
  if (status === 'planned') return { label: 'Not sent', color: 'default' }
  return { label: 'Not verified', color: 'default' }
}

/** Presentation only: never merges, removes, or edits persisted occurrences. */
export function meetingDisplayRows<T extends Meeting>(records: T[], groupRecurring: boolean, now: number) {
  const groups = new Map<string, T[]>()
  records.forEach((record, index) => {
    const identity = ['pipelineId', 'calendarOwnerEmail', 'calendarConnectionId', 'calendarId', 'recurringEventId']
      .map(key => text(record, key))
    const state = meetingCalendarPresentation(record)
    const canGroup = groupRecurring && record.calendarImported === true
      && text(record, 'provider') === 'google-calendar' && Boolean(text(record, 'externalEventId')) && identity.every(Boolean)
      && !['Cancelled', 'Failed', 'Pending', 'Not configured'].includes(state.label)
      && Number.isFinite(Date.parse(text(record, 'startsAt')))
    const key = canGroup ? JSON.stringify(identity) : `single:${index}`
    groups.set(key, [...(groups.get(key) || []), record])
  })
  return [...groups.values()].map(occurrences => {
    const sorted = [...occurrences].sort((a, b) => Date.parse(text(a, 'startsAt')) - Date.parse(text(b, 'startsAt')))
    const record = sorted.find(item => Date.parse(text(item, 'startsAt')) >= now) || sorted[sorted.length - 1]
    return { record, occurrenceCount: occurrences.length }
  })
}
