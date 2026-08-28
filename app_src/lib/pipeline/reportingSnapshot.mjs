function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function stageCounts(value) {
  let rows = value
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows)
    } catch {
      rows = []
    }
  }
  if (!Array.isArray(rows)) return []

  return rows
    .map((row) => ({
      stage: String(row?.stage || 'Unstaged').trim() || 'Unstaged',
      count: Math.max(0, Math.trunc(finiteNumber(row?.count))),
    }))
    .filter((row) => row.count > 0)
}

function forecastMonths(value) {
  let rows = value
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows)
    } catch {
      rows = []
    }
  }
  if (!Array.isArray(rows)) return []

  return rows.map((row) => ({
    month: /^\d{4}-\d{2}$/.test(String(row?.month || '')) ? String(row.month) : '',
    potential: finiteNumber(row?.potential),
    weighted: finiteNumber(row?.weighted),
    stages: Array.isArray(row?.stages)
      ? row.stages.map((stage) => ({
          stage: String(stage?.stage || 'Unstaged').trim() || 'Unstaged',
          value: finiteNumber(stage?.value),
        }))
      : [],
  })).filter((row) => row.month)
}

function valueGroups(value) {
  let rows = value
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows)
    } catch {
      rows = []
    }
  }
  if (!Array.isArray(rows)) return []
  return rows.map((row) => ({
    label: String(row?.label || 'Unspecified').trim() || 'Unspecified',
    count: Math.max(0, Math.trunc(finiteNumber(row?.count))),
    value: finiteNumber(row?.value),
    weighted: finiteNumber(row?.weighted),
  }))
}

/**
 * Normalize one database aggregate into the dashboard's authoritative snapshot.
 * This function intentionally operates on aggregate values rather than loaded
 * opportunity rows, so the dashboard is not limited by the list endpoint cap.
 *
 * @param {Record<string, unknown>} input
 */
export function normalizePipelineReportingSnapshot(input) {
  const wonOpportunities = Math.max(0, Math.trunc(finiteNumber(input.wonOpportunities)))
  const lostOpportunities = Math.max(0, Math.trunc(finiteNumber(input.lostOpportunities)))
  const decidedOpportunities = wonOpportunities + lostOpportunities

  return {
    totalContacts: Math.max(0, Math.trunc(finiteNumber(input.totalContacts))),
    totalOpportunities: Math.max(0, Math.trunc(finiteNumber(input.totalOpportunities))),
    activeOpportunities: Math.max(0, Math.trunc(finiteNumber(input.activeOpportunities))),
    openOpportunities: Math.max(0, Math.trunc(finiteNumber(input.openOpportunities))),
    onHoldOpportunities: Math.max(0, Math.trunc(finiteNumber(input.onHoldOpportunities))),
    highPriorityActiveOpportunities: Math.max(0, Math.trunc(finiteNumber(input.highPriorityActiveOpportunities))),
    wonOpportunities,
    lostOpportunities,
    activePipelineValue: finiteNumber(input.activePipelineValue),
    weightedPipelineValue: finiteNumber(input.weightedPipelineValue),
    lifetimeWinRate: decidedOpportunities > 0 ? (wonOpportunities / decidedOpportunities) * 100 : 0,
    opportunitiesByStage: stageCounts(input.opportunitiesByStage),
    activeByStage: valueGroups(input.activeByStage),
    activeByCloseQuarter: valueGroups(input.activeByCloseQuarter),
    attention: {
      total: Math.max(0, Math.trunc(finiteNumber(input.attentionTotal))),
      lifecycleConflicts: Math.max(0, Math.trunc(finiteNumber(input.attentionLifecycleConflicts))),
      overdue: Math.max(0, Math.trunc(finiteNumber(input.attentionOverdue))),
      missingCloseDate: Math.max(0, Math.trunc(finiteNumber(input.attentionMissingCloseDate))),
      invalidProbability: Math.max(0, Math.trunc(finiteNumber(input.attentionInvalidProbability))),
    },
    forecast: {
      months: forecastMonths(input.forecastMonths),
      outsideOrUnscheduledPotential: finiteNumber(input.outsideOrUnscheduledPotential),
      outsideOrUnscheduledWeighted: finiteNumber(input.outsideOrUnscheduledWeighted),
    },
  }
}
