export type PipelineBriefOpportunityInput = {
  referenceCode: string
  name: string
  organization: string
  stage: string
  status: string
  value: number
  probability: number
  expectedClose: string | null
  touches30d: number
  touches90d: number
  totalTouches: number
  inbound30d: number
  outbound30d: number
  email30d: number
  call30d: number
  meeting30d: number
  lastTouchAt: string | null
}

export type PipelineBriefCadence = 'no-history' | 'lagging' | 'on-track' | 'above-normal'

export type PipelineBriefOpportunityInsight = PipelineBriefOpportunityInput & {
  cadence: PipelineBriefCadence
  benchmark30d: number
  benchmarkLabel: string
  daysSinceLastTouch: number | null
  daysToClose: number | null
  recommendedAction: string
  priorityScore: number
}

export type PipelineBriefStageBenchmark = {
  stage: string
  opportunities: number
  medianTouches30d: number
  averageTouches30d: number
}

export type PipelineEngagementInsights = {
  opportunities: PipelineBriefOpportunityInsight[]
  stageBenchmarks: PipelineBriefStageBenchmark[]
  untouched: number
  stale: number
  lagging: number
  aboveNormal: number
  closingWithin30Days: number
  overdueCloseDates: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function normalizedStage(value: string): string {
  return value.trim() || 'Unstaged'
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.map(finite).sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function daysSince(value: string | null, now: Date): number | null {
  if (!value) return null
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, Math.floor((now.getTime() - timestamp) / DAY_MS))
}

function daysUntil(value: string | null, now: Date): number | null {
  if (!value) return null
  const timestamp = new Date(`${value.slice(0, 10)}T23:59:59.999Z`).getTime()
  if (!Number.isFinite(timestamp)) return null
  return Math.ceil((timestamp - now.getTime()) / DAY_MS)
}

function actionFor(input: {
  opportunity: PipelineBriefOpportunityInput
  cadence: PipelineBriefCadence
  daysSinceLastTouch: number | null
  daysToClose: number | null
  benchmark30d: number
}): string {
  const actions: string[] = []
  if (input.opportunity.totalTouches === 0) {
    actions.push('Schedule and log the first opportunity touch')
  } else if (input.daysSinceLastTouch !== null && input.daysSinceLastTouch >= 14) {
    actions.push(`Re-engage; the last linked touch was ${input.daysSinceLastTouch} days ago`)
  } else if (input.cadence === 'lagging') {
    actions.push(`Add a touch to reach the ${input.benchmark30d}-touch 30-day benchmark`)
  }

  if (input.daysToClose !== null && input.daysToClose < 0) {
    actions.push('Update the overdue expected close date and confirm the next step')
  } else if (input.daysToClose !== null && input.daysToClose <= 14) {
    actions.push('Confirm the close plan, decision owner, and next meeting')
  }

  if (input.cadence === 'above-normal' && actions.length === 0) {
    actions.push('Touch volume is above normal; verify that activity is advancing the stage')
  }
  if (actions.length === 0) actions.push('Maintain the current cadence and keep the next action dated')
  return actions.slice(0, 2).join('; ')
}

export function buildPipelineEngagementInsights(
  opportunities: PipelineBriefOpportunityInput[],
  now = new Date(),
): PipelineEngagementInsights {
  const stages = new Map<string, PipelineBriefOpportunityInput[]>()
  for (const opportunity of opportunities) {
    const stage = normalizedStage(opportunity.stage)
    stages.set(stage, [...(stages.get(stage) || []), opportunity])
  }

  const overallMedian = median(opportunities.map((opportunity) => opportunity.touches30d))
  const stageBenchmarks = Array.from(stages.entries()).map(([stage, rows]) => ({
    stage,
    opportunities: rows.length,
    medianTouches30d: median(rows.map((row) => row.touches30d)),
    averageTouches30d: rows.length > 0
      ? Math.round((rows.reduce((total, row) => total + finite(row.touches30d), 0) / rows.length) * 10) / 10
      : 0,
  })).sort((left, right) => left.stage.localeCompare(right.stage))
  const benchmarkByStage = new Map(stageBenchmarks.map((benchmark) => [benchmark.stage, benchmark]))

  const insights = opportunities.map((opportunity): PipelineBriefOpportunityInsight => {
    const stage = normalizedStage(opportunity.stage)
    const stageBenchmark = benchmarkByStage.get(stage)
    const useStageBenchmark = Boolean(stageBenchmark && stageBenchmark.opportunities >= 2)
    const benchmark30d = Math.round(useStageBenchmark
      ? stageBenchmark?.medianTouches30d || 0
      : overallMedian)
    const benchmarkLabel = useStageBenchmark
      ? `${stage} stage median`
      : 'pipeline median'
    const lastTouchAge = daysSince(opportunity.lastTouchAt, now)
    const closeAge = daysUntil(opportunity.expectedClose, now)

    let cadence: PipelineBriefCadence = 'on-track'
    if (opportunity.totalTouches === 0) {
      cadence = 'no-history'
    } else if ((lastTouchAge !== null && lastTouchAge >= 14) || opportunity.touches30d < benchmark30d) {
      cadence = 'lagging'
    } else if (
      opportunity.touches30d >= Math.max(benchmark30d + 2, Math.ceil(benchmark30d * 1.5))
      && opportunity.touches30d > 0
    ) {
      cadence = 'above-normal'
    }

    const priorityScore = (opportunity.totalTouches === 0 ? 100 : 0)
      + (lastTouchAge === null ? 0 : Math.min(lastTouchAge, 60))
      + (closeAge !== null && closeAge < 0 ? 80 : 0)
      + (closeAge !== null && closeAge >= 0 && closeAge <= 14 ? 35 : 0)
      + (cadence === 'lagging' ? 25 : 0)
      + Math.min(Math.log10(Math.max(opportunity.value, 1)) * 4, 24)

    return {
      ...opportunity,
      cadence,
      benchmark30d,
      benchmarkLabel,
      daysSinceLastTouch: lastTouchAge,
      daysToClose: closeAge,
      recommendedAction: actionFor({
        opportunity,
        cadence,
        daysSinceLastTouch: lastTouchAge,
        daysToClose: closeAge,
        benchmark30d,
      }),
      priorityScore,
    }
  }).sort((left, right) => right.priorityScore - left.priorityScore || right.value - left.value)

  return {
    opportunities: insights,
    stageBenchmarks,
    untouched: insights.filter((opportunity) => opportunity.cadence === 'no-history').length,
    stale: insights.filter((opportunity) => (
      opportunity.daysSinceLastTouch !== null && opportunity.daysSinceLastTouch >= 14
    )).length,
    lagging: insights.filter((opportunity) => opportunity.cadence === 'lagging').length,
    aboveNormal: insights.filter((opportunity) => opportunity.cadence === 'above-normal').length,
    closingWithin30Days: insights.filter((opportunity) => (
      opportunity.daysToClose !== null && opportunity.daysToClose >= 0 && opportunity.daysToClose <= 30
    )).length,
    overdueCloseDates: insights.filter((opportunity) => (
      opportunity.daysToClose !== null && opportunity.daysToClose < 0
    )).length,
  }
}
