const TERMINAL_STATUSES = new Set(['closed', 'won', 'lost', 'abandoned'])
const WON_STATUSES = new Set(['closed', 'won'])
const LOST_STATUSES = new Set(['lost', 'abandoned'])
const TERMINAL_STAGES = new Set(['closed', 'closed delayed', 'won', 'loss'])

function normalized(value) {
  return String(value || '').trim().toLowerCase()
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

export function isTerminalPipelineStatus(status) {
  return TERMINAL_STATUSES.has(normalized(status))
}

export function isActivePipelineStatus(status) {
  return !isTerminalPipelineStatus(status)
}

export function isWonPipelineStatus(status) {
  return WON_STATUSES.has(normalized(status))
}

export function isLostPipelineStatus(status) {
  return LOST_STATUSES.has(normalized(status))
}

export function isTerminalPipelineStage(stage) {
  return TERMINAL_STAGES.has(normalized(stage))
}

function validDate(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? new Date(timestamp) : null
}

function startOfDay(value) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

/**
 * Produce one status-driven pipeline summary and a separate data-quality queue.
 * Status remains authoritative for totals; contradictory stages are surfaced for repair.
 *
 * @param {Array<Record<string, any>>} records
 * @param {{ now?: Date | string | number }} [options]
 */
export function summarizePipeline(records, options = {}) {
  const deals = Array.isArray(records) ? records : []
  const now = startOfDay(options.now || new Date())
  const active = deals.filter((deal) => isActivePipelineStatus(deal.status))
  const open = deals.filter((deal) => normalized(deal.status) === 'open')
  const onHold = deals.filter((deal) => normalized(deal.status) === 'on hold')
  const won = deals.filter((deal) => isWonPipelineStatus(deal.status))
  const lost = deals.filter((deal) => isLostPipelineStatus(deal.status))
  const lifecycleConflicts = deals.filter((deal) => (
    isActivePipelineStatus(deal.status) !== !isTerminalPipelineStage(deal.stage)
  ))
  const overdue = active.filter((deal) => {
    const closeDate = validDate(deal.expectedClose || deal.closeDate)
    return closeDate ? startOfDay(closeDate).getTime() < now.getTime() : false
  })
  const missingCloseDate = active.filter((deal) => !validDate(deal.expectedClose || deal.closeDate))
  const invalidProbability = deals.filter((deal) => {
    const probability = Number(deal.probability)
    return !Number.isFinite(probability) || probability < 0 || probability > 100
  })
  const valueOf = (deal) => finiteNumber(deal.value ?? deal.amount)
  const probabilityOf = (deal) => finiteNumber(deal.probability)
  const sum = (items, selector) => items.reduce((total, item) => total + selector(item), 0)
  const decidedCount = won.length + lost.length

  return {
    totalCount: deals.length,
    activeCount: active.length,
    openCount: open.length,
    onHoldCount: onHold.length,
    wonCount: won.length,
    lostCount: lost.length,
    activeValue: sum(active, valueOf),
    weightedActiveValue: sum(active, (deal) => valueOf(deal) * (probabilityOf(deal) / 100)),
    wonValue: sum(won, valueOf),
    winRate: decidedCount > 0 ? (won.length / decidedCount) * 100 : 0,
    active,
    won,
    lost,
    lifecycleConflicts,
    overdue,
    missingCloseDate,
    invalidProbability,
    needsAttentionCount: new Set([
      ...lifecycleConflicts.map((deal) => deal.id),
      ...overdue.map((deal) => deal.id),
      ...missingCloseDate.map((deal) => deal.id),
      ...invalidProbability.map((deal) => deal.id),
    ].filter(Boolean)).size,
  }
}
