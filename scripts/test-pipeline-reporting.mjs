#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_PIPELINE_REPORTING_PRESET,
  PipelineReportingPeriodError,
  normalizePipelineReportingPeriod,
} from '../app_src/lib/pipeline/reportingPeriod.mjs'
import { normalizePipelineReportingSnapshot } from '../app_src/lib/pipeline/reportingSnapshot.mjs'

const nyNow = '2026-08-29T02:00:00.000Z'
const defaultPeriod = normalizePipelineReportingPeriod({
  now: nyNow,
  timeZone: 'America/New_York',
})

assert.deepEqual(defaultPeriod, {
  preset: DEFAULT_PIPELINE_REPORTING_PRESET,
  label: 'Last 3 calendar months',
  startDate: '2026-06-01',
  endDate: '2026-08-28',
  snapshotDate: '2026-08-28',
  timeZone: 'America/New_York',
  startAt: '2026-06-01T04:00:00.000Z',
  endAtExclusive: '2026-08-29T04:00:00.000Z',
})

assert.deepEqual(
  normalizePipelineReportingPeriod({
    preset: 'last_30_days',
    now: nyNow,
    timeZone: 'America/New_York',
  }),
  {
    preset: 'last_30_days',
    label: 'Last 30 days',
    startDate: '2026-07-30',
    endDate: '2026-08-28',
    snapshotDate: '2026-08-28',
    timeZone: 'America/New_York',
    startAt: '2026-07-30T04:00:00.000Z',
    endAtExclusive: '2026-08-29T04:00:00.000Z',
  },
)

assert.deepEqual(
  normalizePipelineReportingPeriod({
    preset: 'year_to_date',
    now: nyNow,
    timeZone: 'America/New_York',
  }),
  {
    preset: 'year_to_date',
    label: 'Year to date',
    startDate: '2026-01-01',
    endDate: '2026-08-28',
    snapshotDate: '2026-08-28',
    timeZone: 'America/New_York',
    startAt: '2026-01-01T05:00:00.000Z',
    endAtExclusive: '2026-08-29T04:00:00.000Z',
  },
)

const springForward = normalizePipelineReportingPeriod({
  preset: 'custom',
  startDate: '2026-03-08',
  endDate: '2026-03-08',
  timeZone: 'America/New_York',
})
assert.equal(springForward.startAt, '2026-03-08T05:00:00.000Z')
assert.equal(springForward.endAtExclusive, '2026-03-09T04:00:00.000Z')
assert.equal(Date.parse(springForward.endAtExclusive) - Date.parse(springForward.startAt), 23 * 60 * 60 * 1000)

const fallBack = normalizePipelineReportingPeriod({
  preset: 'custom',
  startDate: '2026-11-01',
  endDate: '2026-11-01',
  timeZone: 'America/New_York',
})
assert.equal(fallBack.startAt, '2026-11-01T04:00:00.000Z')
assert.equal(fallBack.endAtExclusive, '2026-11-02T05:00:00.000Z')
assert.equal(Date.parse(fallBack.endAtExclusive) - Date.parse(fallBack.startAt), 25 * 60 * 60 * 1000)

const midnightGap = normalizePipelineReportingPeriod({
  preset: 'custom',
  startDate: '2026-03-08',
  endDate: '2026-03-08',
  timeZone: 'America/Havana',
})
assert.equal(midnightGap.startAt, '2026-03-08T05:00:00.000Z')
assert.equal(midnightGap.endAtExclusive, '2026-03-09T04:00:00.000Z')

const customInclusive = normalizePipelineReportingPeriod({
  preset: 'custom',
  startDate: '2026-02-27',
  endDate: '2026-03-01',
  timeZone: 'UTC',
})
assert.deepEqual(
  {
    label: customInclusive.label,
    startAt: customInclusive.startAt,
    endAtExclusive: customInclusive.endAtExclusive,
  },
  {
    label: 'Custom: 2026-02-27 to 2026-03-01',
    startAt: '2026-02-27T00:00:00.000Z',
    endAtExclusive: '2026-03-02T00:00:00.000Z',
  },
)

assert.equal(
  normalizePipelineReportingPeriod({
    preset: 'custom',
    startDate: '2026-08-01',
    endDate: '2026-08-01',
    timeZone: 'Not/A_Time_Zone',
  }).timeZone,
  'UTC',
)

function assertPeriodError(input, code) {
  assert.throws(
    () => normalizePipelineReportingPeriod(input),
    (error) => error instanceof PipelineReportingPeriodError
      && error.status === 400
      && error.code === code,
  )
}

assertPeriodError(
  { preset: 'custom', startDate: '2026-02-30', endDate: '2026-03-01', timeZone: 'UTC' },
  'PIPELINE_REPORTING_DATE_INVALID',
)
assertPeriodError(
  { preset: 'custom', startDate: '2026-03-01', timeZone: 'UTC' },
  'PIPELINE_REPORTING_DATE_INVALID',
)
assertPeriodError(
  { preset: 'custom', startDate: '2026-03-02', endDate: '2026-03-01', timeZone: 'UTC' },
  'PIPELINE_REPORTING_RANGE_INVALID',
)
assertPeriodError(
  { preset: 'custom', startDate: '2020-01-01', endDate: '2026-01-01', timeZone: 'UTC' },
  'PIPELINE_REPORTING_RANGE_TOO_LARGE',
)
assertPeriodError(
  { preset: 'last_quarter', timeZone: 'UTC' },
  'PIPELINE_REPORTING_PRESET_INVALID',
)

const uncappedSnapshot = normalizePipelineReportingSnapshot({
  totalContacts: '2501',
  totalOpportunities: '3207',
  activeOpportunities: '1207',
  openOpportunities: '1001',
  onHoldOpportunities: '206',
  highPriorityActiveOpportunities: '1105',
  wonOpportunities: '1401',
  lostOpportunities: '599',
  activePipelineValue: '9876543.21',
  weightedPipelineValue: '3456789.12',
  opportunitiesByStage: JSON.stringify([
    { stage: 'Proposal', count: 1103 },
    { stage: 'Closed', count: 1401 },
  ]),
  activeByStage: JSON.stringify([
    { label: 'Proposal', count: 1103, value: 7000000.5, weighted: 2450000.175 },
  ]),
  activeByCloseQuarter: JSON.stringify([
    { label: 'Q3 2026', count: 807, value: 6500000.25, weighted: 2275000.0875 },
  ]),
  attentionTotal: '1503',
  attentionLifecycleConflicts: '10',
  attentionOverdue: '1490',
  attentionMissingCloseDate: '3',
  attentionInvalidProbability: '2',
  forecastMonths: JSON.stringify([
    {
      month: '2026-08',
      potential: 1500000.25,
      weighted: 525000.125,
      stages: [{ stage: 'Proposal', value: 1500000.25 }],
    },
  ]),
  outsideOrUnscheduledPotential: '8376542.96',
  outsideOrUnscheduledWeighted: '2931788.995',
})
assert.deepEqual(uncappedSnapshot, {
  totalContacts: 2501,
  totalOpportunities: 3207,
  activeOpportunities: 1207,
  openOpportunities: 1001,
  onHoldOpportunities: 206,
  highPriorityActiveOpportunities: 1105,
  wonOpportunities: 1401,
  lostOpportunities: 599,
  activePipelineValue: 9876543.21,
  weightedPipelineValue: 3456789.12,
  lifetimeWinRate: 70.05,
  opportunitiesByStage: [
    { stage: 'Proposal', count: 1103 },
    { stage: 'Closed', count: 1401 },
  ],
  activeByStage: [{ label: 'Proposal', count: 1103, value: 7000000.5, weighted: 2450000.175 }],
  activeByCloseQuarter: [{ label: 'Q3 2026', count: 807, value: 6500000.25, weighted: 2275000.0875 }],
  attention: {
    total: 1503,
    lifecycleConflicts: 10,
    overdue: 1490,
    missingCloseDate: 3,
    invalidProbability: 2,
  },
  forecast: {
    months: [{
      month: '2026-08',
      potential: 1500000.25,
      weighted: 525000.125,
      stages: [{ stage: 'Proposal', value: 1500000.25 }],
    }],
    outsideOrUnscheduledPotential: 8376542.96,
    outsideOrUnscheduledWeighted: 2931788.995,
  },
})

const crmSource = readFileSync(resolve(process.cwd(), 'app_src/lib/persistence/crm.ts'), 'utf8')
assert.match(crmSource, /export async function readCrmPipelineActivityReportFromPostgres/)
assert.match(crmSource, /pipeline\.workspace_organization_id = \$2::uuid/)
assert.match(crmSource, /COALESCE\(interaction\.occurred_at, interaction\.created_at\) >= bounds\.start_at/)
assert.match(crmSource, /COALESCE\(interaction\.occurred_at, interaction\.created_at\) < bounds\.end_at/)
assert.match(crmSource, /contact\.created_at >= bounds\.start_at[\s\S]*contact\.created_at < bounds\.end_at/)
assert.match(crmSource, /opportunity\.created_at >= bounds\.start_at[\s\S]*opportunity\.created_at < bounds\.end_at/)
assert.match(crmSource, /generate_series\(/)
assert.match(crmSource, /AS active_opportunities/)
assert.match(crmSource, /AS open_opportunities/)
assert.match(crmSource, /AS on_hold_opportunities/)
assert.match(crmSource, /AS high_priority_active_opportunities/)
assert.match(crmSource, /AS active_pipeline_value/)
assert.match(crmSource, /AS weighted_pipeline_value/)
assert.match(crmSource, /AS won_opportunities/)
assert.match(crmSource, /AS lost_opportunities/)
assert.match(crmSource, /AS opportunity_stage_counts/)
assert.match(crmSource, /active_stage_summary AS/)
assert.match(crmSource, /active_close_quarter_summary AS/)
assert.match(crmSource, /attention_summary AS/)
assert.match(crmSource, /GROUP BY date_trunc\('month', opportunity\.expected_close\)::date, opportunity\.stage_key/)
assert.match(crmSource, /GROUP BY opportunity\.stage_key/)
assert.match(crmSource, /GROUP BY lower\(COALESCE\(NULLIF\(btrim\(opportunity\.stage\), ''\), 'Unstaged'\)\)/)
assert.match(crmSource, /forecast_month_totals AS/)
assert.match(crmSource, /forecast_stage_totals AS/)
assert.match(crmSource, /forecast_summary AS/)
assert.match(crmSource, /AS forecast_months/)
assert.match(crmSource, /outside_or_unscheduled_potential/)
assert.match(crmSource, /outside_or_unscheduled_weighted/)
assert.match(crmSource, /normalizePipelineReportingSnapshot/)
assert.match(crmSource, /lower\(btrim\(COALESCE\(opportunity\.status, ''\)\)\)/)
for (const bucket of ['direct_mail', 'linked_in', 'email', 'call', 'in_person', 'note', 'campaign', 'other']) {
  assert.match(crmSource, new RegExp(`interaction_bucket = '${bucket}'`))
}

const routeSource = readFileSync(resolve(process.cwd(), 'app_src/app/api/pipeline/report/route.ts'), 'utf8')
assert.match(routeSource, /const actor = await requireRequestUser\(req\)/)
assert.match(routeSource, /req\.cookies\.get\(PIPELINE_SELECTION_COOKIE\)/)
assert.match(routeSource, /pipelineId: selectedPipelineId/)
assert.match(routeSource, /error\.message === 'Pipeline access denied'/)
assert.match(routeSource, /resolvePipelineSpaceAccess\(\{ actorEmail: actor \}\)/)
assert.match(routeSource, /timeZone: actor\.timezone/)
assert.match(routeSource, /readCrmPipelineActivityReportFromPostgres/)
assert.match(routeSource, /const \{ snapshot, \.\.\.activity \} = report/)
assert.match(routeSource, /snapshot,\s*activity,/)
assert.match(routeSource, /console\.error\('\[pipeline-report\] unexpected reporting failure', error\)/)
assert.match(routeSource, /error: 'Unable to load pipeline reporting'/)
assert.match(routeSource, /code: 'PIPELINE_REPORTING_FAILED'/)
for (const field of ['preset', 'label', 'startDate', 'endDate', 'snapshotDate', 'timeZone']) {
  assert.match(routeSource, new RegExp(`${field}: period\\.${field}`))
}

console.log('pipeline reporting period and source contract tests passed')
