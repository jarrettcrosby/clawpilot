#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(process.cwd(), 'app_src/lib/pipelineProvisioning.ts'), 'utf8')

for (const tutorialText of [
  'Only the Opportunities tab is operator-editable.',
  'Status',
  'Controls lifecycle reporting and formulas.',
  'Stage',
  'Controls where an opportunity appears on the pipeline board.',
  'Probability',
  'Controls weighted active value:',
  'Expected Close',
  'Controls when opportunity value appears in the sales forecast.',
  'Products are selected as a multi-select field in ClawPilot',
]) {
  assert.ok(source.includes(tutorialText), `Start Here tutorial missing: ${tutorialText}`)
}
assert.doesNotMatch(source, /Start Here[\s\S]{0,1800}(?:Jarrett|Eigen Racing)/i)

const formulaContract = [
  ['Total opportunities', '=COUNTA(Opportunities!C5:C)'],
  ['Open opportunities', '=COUNTIFS(Opportunities!C5:C,"<>",Opportunities!F5:F,"Open")'],
  ['On-hold opportunities', '=COUNTIFS(Opportunities!C5:C,"<>",Opportunities!F5:F,"On Hold")'],
  ['Active opportunities', 'Opportunities!F5:F,"<>Won"', 'Opportunities!F5:F,"<>Lost"', 'Opportunities!F5:F,"<>Closed"', 'Opportunities!F5:F,"<>Abandoned"'],
  ['Active pipeline value', '=SUMIFS(Opportunities!J5:J', 'Opportunities!F5:F,"<>Won"', 'Opportunities!F5:F,"<>Lost"', 'Opportunities!F5:F,"<>Closed"', 'Opportunities!F5:F,"<>Abandoned"'],
  ['Weighted active value', '=SUMPRODUCT(Opportunities!J5:J,Opportunities!K5:K/100', 'Opportunities!F5:F<>"Won"', 'Opportunities!F5:F<>"Lost"', 'Opportunities!F5:F<>"Closed"', 'Opportunities!F5:F<>"Abandoned"'],
  ['Won opportunities', 'Opportunities!F5:F,"Won"', 'Opportunities!F5:F,"Closed"'],
  ['Won value', '=SUMIFS(Opportunities!J5:J', 'Opportunities!F5:F,"Won"', 'Opportunities!F5:F,"Closed"'],
  ['Lost opportunities', 'Opportunities!F5:F,"Lost"', 'Opportunities!F5:F,"Abandoned"'],
  ['Win rate', '=IFERROR(C11/(C11+C13),0)'],
  ['Organizations', '=COUNTA(Organizations!C5:C)'],
  ['Contacts', '=COUNTA(Contacts!C5:C)'],
  ['Interactions', '=COUNTA(Interactions!C5:C)'],
]
const initialRowsStart = source.indexOf('const INITIAL_TAB_ROWS')
const calculationsBlock = source.slice(
  source.indexOf('  Calculations: [', initialRowsStart),
  source.indexOf('  Dashboard: [', initialRowsStart),
)

for (const [metric, ...fragments] of formulaContract) {
  const formulaLine = calculationsBlock.split('\n').find((line) => line.includes(`['${metric}'`)) || ''
  assert.ok(formulaLine, `missing generated metric: ${metric}`)
  for (const fragment of fragments) {
    assert.ok(formulaLine.includes(fragment), `${metric} formula missing ${fragment}`)
  }
}

assert.match(source, /const GENERATED_REPORT_CLEAR_RANGES = \[\s*"'Calculations'!B4:ZZZ",\s*"'Dashboard'!B4:ZZZ",\s*\] as const/)
assert.match(source, /\/values:batchClear`[\s\S]{0,180}body: \{ ranges: \[\.\.\.GENERATED_REPORT_CLEAR_RANGES\] \}/)
const clearRangesBlock = source.match(/const GENERATED_REPORT_CLEAR_RANGES = \[([\s\S]*?)\] as const/)?.[1] || ''
const clearRanges = [...clearRangesBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1])
assert.deepEqual(clearRanges, ["'Calculations'!B4:ZZZ", "'Dashboard'!B4:ZZZ"])
const configureBlock = source.slice(
  source.indexOf('export async function configurePipelineTabsWithRequest'),
  source.indexOf('export async function configurePipelineTabs('),
)
assert.ok(
  configureBlock.indexOf('/values:batchClear') < configureBlock.indexOf('/values:batchUpdate'),
  'generated report cells must be cleared before replacement values are written',
)
assert.match(configureBlock, /range: `'\$\{title\}'!B5`[\s\S]{0,100}values: INITIAL_TAB_ROWS\[title\]/)

assert.match(source, /charts\?: Array<\{ chartId\?: number \}>/)
assert.match(source, /charts\(chartId\)/)
assert.match(source, /title === 'Dashboard'[\s\S]{0,320}deleteEmbeddedObject: \{ objectId: chart\.chartId \}/)
assert.match(source, /formattingRequests\.push\(\.\.\.dashboardChartRequests\(sheetIdValue\)\)/)
assert.equal((source.match(/title: '(?:Opportunity lifecycle|Pipeline value|CRM records)'/g) || []).length, 3)
const chartRequestBlock = source.slice(
  source.indexOf('function dashboardChartRequests'),
  source.indexOf('export async function configurePipelineTabsWithRequest'),
)
assert.equal((chartRequestBlock.match(/\n\s+chart\(\{/g) || []).length, 3)
for (const chartContract of [
  { title: 'Opportunity lifecycle', start: 6, end: 10, row: 3, column: 4, type: 'COLUMN' },
  { title: 'Pipeline value', start: 11, end: 14, row: 18, column: 4, type: 'COLUMN' },
  { title: 'CRM records', start: 14, end: 17, row: 3, column: 13, type: 'BAR' },
]) {
  const chartStart = chartRequestBlock.indexOf(`title: '${chartContract.title}'`)
  const chartDefinition = chartRequestBlock.slice(chartStart, chartRequestBlock.indexOf('}),', chartStart) + 3)
  assert.ok(chartStart >= 0, `missing chart: ${chartContract.title}`)
  assert.ok(chartDefinition.includes(`startRowIndex: ${chartContract.start}`))
  assert.ok(chartDefinition.includes(`endRowIndex: ${chartContract.end}`))
  assert.ok(chartDefinition.includes(`anchorRowIndex: ${chartContract.row}`))
  assert.ok(chartDefinition.includes(`anchorColumnIndex: ${chartContract.column}`))
  assert.ok(chartDefinition.includes(`chartType: '${chartContract.type}'`))
}
const dashboardReconciliation = source.slice(
  source.indexOf("if (title === 'Dashboard')"),
  source.indexOf(
    'formattingRequests.push({\n      updateSheetProperties',
    source.indexOf("if (title === 'Dashboard')"),
  ),
)
assert.ok(
  dashboardReconciliation.indexOf('deleteEmbeddedObject')
    < dashboardReconciliation.indexOf('dashboardChartRequests'),
  'Dashboard charts must be deleted before the managed chart set is added',
)

assert.doesNotMatch(clearRangesBlock, /Opportunities|Dropdowns/, 'report cleanup must not clear operator-owned tabs')
assert.match(source, /title === 'Dropdowns' && !newlyProvisionedTitles\.has\(title\)/)
assert.match(source, /if \(preserveConfiguredDropdowns\) return writes/)
assert.doesNotMatch(source, /(?:Opportunities|Dropdowns)'!B5:[A-Z]+(?:\d+)?[^\n]*:clear/)
const initialRowsBlock = source.slice(
  source.indexOf('const INITIAL_TAB_ROWS'),
  source.indexOf('export class PipelineProvisioningRequestError'),
)
assert.doesNotMatch(initialRowsBlock, /\n\s+Opportunities\s*:/, 'Opportunities rows must never be seeded or replaced')

const dashboardTableBlock = source.slice(
  source.indexOf('  Dashboard: [', initialRowsStart),
  source.indexOf('  Dropdowns: [', initialRowsStart),
)
for (const [metric, reference] of [
  ['Total opportunities', '=Calculations!C5'],
  ['Active opportunities', '=Calculations!C8'],
  ['Open opportunities', '=Calculations!C6'],
  ['On-hold opportunities', '=Calculations!C7'],
  ['Won opportunities', '=Calculations!C11'],
  ['Lost opportunities', '=Calculations!C13'],
  ['Win rate', '=Calculations!C14'],
  ['Active pipeline value', '=Calculations!C9'],
  ['Weighted active value', '=Calculations!C10'],
  ['Won value', '=Calculations!C12'],
  ['Organizations', '=Calculations!C15'],
  ['Contacts', '=Calculations!C16'],
  ['Interactions', '=Calculations!C17'],
]) {
  assert.ok(dashboardTableBlock.includes(`['${metric}', '${reference}']`), `Dashboard table missing ${metric}`)
}

assert.match(source, /applyPipelineWorkbookBrandingWithRequest/)
assert.match(source, /range: `'\$\{title\}'!B1`/)
assert.match(source, /range: `'\$\{title\}'!C1`/)
assert.match(source, /range: `'\$\{title\}'!C2`/)

console.log('pipeline workbook dashboard contract tests passed')
