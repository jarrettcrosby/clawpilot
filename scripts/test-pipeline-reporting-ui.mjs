#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8')
const dashboard = read('app_src/components/pipeline/PipelineDashboard.tsx')
const section = read('app_src/components/pipeline/PipelineSection.tsx')
const insights = read('app_src/components/pipeline/PipelineInsights.tsx')
const reportHook = read('app_src/components/pipeline/usePipelineReport.ts')
const homeDashboard = read('app_src/components/dashboard/DashboardSection.tsx')
const dashboardBootstrap = read('app_src/lib/dashboardBootstrapServer.ts')
const crmPersistence = read('app_src/lib/persistence/crm.ts')

for (const fragment of [
  "useState<ReportPreset>('last_3_calendar_months')",
  "new URLSearchParams({ preset })",
  "params.set('startDate', customStart)",
  "params.set('endDate', customEnd)",
  "fetch(`/api/pipeline/report?${params.toString()}`",
]) {
  assert.ok(reportHook.includes(fragment), `shared pipeline report hook missing contract: ${fragment}`)
}
for (const fragment of [
  'Reporting period',
  'Last 30 days',
  'Last 3 calendar months',
  'Year to date',
  'Custom range',
]) {
  assert.ok(dashboard.includes(fragment), `pipeline dashboard missing reporting-period contract: ${fragment}`)
}

assert.match(dashboard, /MetricCard primary label="Active pipeline value · current snapshot" value=\{snapshot \? money\(snapshot\.activePipelineValue\) : '—'\}/)
assert.match(dashboard, /MetricCard primary label="Weighted pipeline value · current snapshot" value=\{snapshot \? money\(snapshot\.weightedPipelineValue\) : '—'\}/)
assert.match(dashboard, /snapshot\.activeOpportunities/)
assert.match(dashboard, /snapshot\.lifetimeWinRate/)
assert.match(dashboard, /snapshot\?\.totalContacts \?\? totalContacts/)
assert.match(dashboard, /snapshot\?\.opportunitiesByStage \|\| null/)
assert.match(dashboard, /Contacts added · selected period/)
assert.match(dashboard, /Total contacts · current/)
assert.match(dashboard, /Interactions · selected period/)
assert.match(dashboard, /Opportunities created · selected period/)
assert.match(dashboard, /Lifetime win rate/)
assert.doesNotMatch(dashboard, /MetricCard primary label="Potential value"/)

for (const type of ['directMail', 'linkedIn', 'email', 'call', 'inPerson', 'note', 'campaign', 'other']) {
  assert.match(dashboard, new RegExp(`key: '${type}'`), `interaction chart missing ${type}`)
}
assert.match(dashboard, /interactionsByMonth/)
assert.match(dashboard, /<GroupedInteractions months=\{activity\?\.interactionsByMonth \|\| \[\]\}/)
assert.match(dashboard, /if \(!count\) return null/)
assert.match(dashboard, /component="table"/)
assert.match(dashboard, /View interaction data table/)
assert.match(dashboard, /aria-label=\{`Interaction counts for \$\{periodLabel\}`\}/)
assert.match(dashboard, /Six-month horizon:/)
assert.match(dashboard, /Outside or unscheduled:/)
assert.match(dashboard, /Current active totals:/)
assert.match(dashboard, /RevenueByStage forecast=\{snapshot\?\.forecast \|\| null\}/)
assert.match(dashboard, /PotentialVsProbable snapshot=\{snapshot\}/)
assert.match(dashboard, /snapshot\.forecast\.outsideOrUnscheduledPotential/)
assert.match(dashboard, /snapshot\.forecast\.outsideOrUnscheduledWeighted/)
assert.doesNotMatch(dashboard, /activeDeals/)
assert.doesNotMatch(dashboard, /deals\.filter/)

assert.match(dashboard, /function ChartMarkTooltip/)
assert.match(dashboard, /enterTouchDelay=\{0\}/)
assert.match(dashboard, /leaveTouchDelay=\{3500\}/)
assert.match(dashboard, /tabIndex=\{0\}/)
assert.match(dashboard, /data-chart-mark/)
assert.match(dashboard, /:focus-visible/)
assert.match(dashboard, /month\.label} · \$\{type\.label}: \$\{count\.toLocaleString/)
assert.match(dashboard, /forecastMonthLabel\(month\.month\)} · \$\{stage}: \$\{money\(value\)\}/)
assert.match(dashboard, /forecastMonthLabel\(month\.month\)} · Potential: \$\{money/)
assert.match(dashboard, /forecastMonthLabel\(month\.month\)} · Probable: \$\{money/)
assert.doesNotMatch(dashboard, /report\.period\.timeZone === timeZone/)
assert.doesNotMatch(dashboard, /new URLSearchParams\(\{ preset, timeZone \}\)/)
assert.match(dashboard, /customPeriodGuidance/)
assert.match(dashboard, /color: MATERIAL\.muted/)
assert.match(dashboard, /direction=\{\{ xs: 'column', sm: 'row' \}\}/)
assert.match(dashboard, /width: \{ xs: '100%', sm: 165 \}/)
assert.doesNotMatch(dashboard, /fetch\('\/api\/pipeline\/report/)

assert.match(dashboard, /function forecastMonthLabel/)
assert.match(insights, /Active pipeline · current snapshot/)
assert.match(insights, /Lifetime win rate/)
assert.match(insights, /snapshot\.activePipelineValue/)
assert.match(insights, /snapshot\.weightedPipelineValue/)
assert.match(insights, /snapshot\?\.activeOpportunities/)
assert.match(insights, /snapshot\?\.onHoldOpportunities/)
assert.match(insights, /snapshot\?\.wonOpportunities/)
assert.match(insights, /snapshot\.lifetimeWinRate/)
assert.match(insights, /snapshot\?\.activeByStage/)
assert.match(insights, /snapshot\?\.activeByCloseQuarter/)
assert.match(insights, /snapshot\.attention\.total/)
assert.match(insights, /Largest among loaded opportunity details/)
assert.match(insights, /up to 1,000 recently updated opportunity rows/)
assert.match(insights, /enterTouchDelay=\{0\}/)
assert.match(insights, /&:focus-visible/)

const dealMapperStart = section.indexOf('function dealFromLooseShape')
const dealMapperEnd = section.indexOf('\nfunction getAssociatedContacts', dealMapperStart)
assert.ok(dealMapperStart >= 0 && dealMapperEnd > dealMapperStart, 'dealFromLooseShape boundary missing')
const dealMapper = section.slice(dealMapperStart, dealMapperEnd)
assert.doesNotMatch(dealMapper, /Math\.round/, 'deal mapping must preserve decimal values and probabilities')
assert.match(dealMapper, /Number\.isFinite\(Number\(row\.value\)\)/)
assert.match(dealMapper, /Number\.isFinite\(Number\(row\.probability\)\)/)
assert.doesNotMatch(section, /timeZone=\{dateTimeSettings\.timeZone\}/)
assert.match(section, /totalContacts=\{typeof syncSurface\.summary\?\.contacts === 'number' \? syncSurface\.summary\.contacts : null\}/)
assert.match(section, /const dashboardReportRevision = useMemo/)
assert.match(section, /const pipelineReporting = usePipelineReport/)
assert.match(section, /reportRevision: dashboardReportRevision/)
assert.match(section, /reporting=\{pipelineReporting\}/)
assert.match(section, /snapshot=\{pipelineReporting\.snapshot\}/)
assert.match(section, /pipelineReporting\.snapshot\?\.activePipelineValue/)
assert.match(section, /pipelineReporting\.snapshot\?\.weightedPipelineValue/)
assert.match(section, /pipelineReporting\.snapshot\?\.activeOpportunities/)
assert.match(section, /pipelineReporting\.snapshot\?\.highPriorityActiveOpportunities/)
assert.match(section, /pipelineReporting\.snapshot\?\.wonOpportunities/)
assert.doesNotMatch(section, /pipelineSummary\.(activeValue|weightedActiveValue|activeCount|wonCount)/)
const dashboardRenderStart = section.indexOf('<PipelineDashboard\n')
const dashboardRenderEnd = section.indexOf('/>', dashboardRenderStart)
assert.ok(dashboardRenderStart >= 0 && dashboardRenderEnd > dashboardRenderStart, 'PipelineDashboard render boundary missing')
assert.doesNotMatch(section.slice(dashboardRenderStart, dashboardRenderEnd), /deals=\{deals\}/)
assert.match(section, /valueRaw/)
assert.doesNotMatch(section, /value: Math\.round\(Number\(deal\.value/)
assert.doesNotMatch(section, /probability: Math\.round\(Number\(deal\.probability/)

assert.equal((reportHook.match(/fetch\(`\/api\/pipeline\/report/g) || []).length, 1, 'pipeline reporting must have one shared fetch owner')
assert.match(reportHook, /loadedReportRevision === reportRevision/)
assert.match(reportHook, /syncRevision/)
assert.match(reportHook, /window\.setInterval\(\(\) =>/)
assert.match(reportHook, /}, 60_000\)/)
assert.match(reportHook, /setDayRefreshRevision\(nextDay\)/)
assert.match(reportHook, /window\.clearInterval\(interval\)/)
assert.match(reportHook, /const \[retryRevision, setRetryRevision\] = useState\(0\)/)
assert.match(reportHook, /const retryReport = \(\) =>/)
assert.match(reportHook, /setRetryRevision\(\(current\) => current \+ 1\)/)
assert.match(dashboard, /onClick=\{retryReport\}>Retry</)

for (const label of [
  'Total opportunities',
  'Active opportunities',
  'Active pipeline value',
  'Weighted pipeline value',
]) {
  assert.ok(homeDashboard.includes(label), `home dashboard missing honest pipeline label: ${label}`)
}
assert.doesNotMatch(homeDashboard, /\['Open value'/)
assert.match(dashboardBootstrap, /activeOpportunities: summary\.activeOpportunities/)
assert.match(dashboardBootstrap, /activePipelineValue: summary\.activePipelineValue/)
assert.match(dashboardBootstrap, /weightedPipelineValue: summary\.weightedPipelineValue/)
assert.match(crmPersistence, /readCrmPipelineValueSnapshotWithClient/)
assert.match(crmPersistence, /activePipelineValue: valueSnapshot\.activePipelineValue/)
assert.match(crmPersistence, /weightedPipelineValue: valueSnapshot\.weightedPipelineValue/)

console.log('pipeline reporting UI contract tests passed')
