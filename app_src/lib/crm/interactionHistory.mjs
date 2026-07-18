function eventTime(record) {
  const value = record?.occurredAt || record?.updatedAt || ''
  const timestamp = Date.parse(String(value))
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function annotateInteractionEventHistory(records) {
  const input = Array.isArray(records) ? records : []
  const actionById = new Map()
  const grouped = new Map()

  for (const record of input) {
    const providerMessageId = String(record?.providerMessageId || '').trim()
    const interactionType = String(record?.interactionType || '').trim().toLowerCase()
    if (!providerMessageId || interactionType !== 'meeting') continue
    const group = grouped.get(providerMessageId) || []
    group.push(record)
    grouped.set(providerMessageId, group)
  }

  for (const group of grouped.values()) {
    group
      .slice()
      .sort((left, right) => eventTime(left) - eventTime(right) || String(left?.id || '').localeCompare(String(right?.id || '')))
      .forEach((record, index) => {
        const deliveryStatus = String(record?.deliveryStatus || '').trim().toLowerCase()
        const action = deliveryStatus === 'cancelled' ? 'Cancelled' : index === 0 ? 'Created' : 'Updated'
        actionById.set(String(record?.id || ''), action)
      })
  }

  return input.map((record) => ({
    ...record,
    eventAction: actionById.get(String(record?.id || '')) || '',
  }))
}
