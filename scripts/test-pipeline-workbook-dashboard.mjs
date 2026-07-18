#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(process.cwd(), 'app_src/lib/pipelineProvisioning.ts'), 'utf8')
const projectionSource = readFileSync(resolve(process.cwd(), 'app_src/lib/crm/workbookProjection.ts'), 'utf8')
const legacySource = readFileSync(resolve(process.cwd(), 'app_src/lib/pipelineLegacyWorkbook.ts'), 'utf8')

for (const tutorialText of [
  'Only the Opportunities tab is operator-editable.',
  'Status controls lifecycle reporting and formulas.',
  'Stage controls where an opportunity appears on the pipeline board.',
  'Probability controls weighted active value:',
  'Expected Close controls when opportunity value appears in the sales forecast.',
  'Products are selected as a multi-select field in ClawPilot',
  'Hidden record IDs preserve exact CRM relationships',
]) {
  assert.ok(source.includes(tutorialText), `Start Here tutorial missing: ${tutorialText}`)
}
assert.doesNotMatch(source, /Start Here[\s\S]{0,1800}(?:Eigen Racing)/i)
assert.match(source, /title === 'Start Here' \? 'C' : 'B'/)
assert.match(source, /'Start Here': \[64, 190, 720\]/)

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
  ['Interactions 61-90 days', 'Interactions!G5:G,">="&TODAY()-90', 'Interactions!G5:G,"<"&TODAY()-60'],
  ['Interactions 31-60 days', 'Interactions!G5:G,">="&TODAY()-60', 'Interactions!G5:G,"<"&TODAY()-30'],
  ['Interactions last 30 days', 'Interactions!G5:G,">="&TODAY()-30', 'Interactions!G5:G,"<="&TODAY()'],
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

const configureBlock = source.slice(
  source.indexOf('export async function configurePipelineTabsWithRequest'),
  source.indexOf('export async function configurePipelineTabs('),
)
assert.match(source, /const GENERATED_HEADER_CLEAR_RANGES = EXPECTED_TABS\.map/)
assert.match(source, /const GENERATED_REPORT_CLEAR_RANGES = \[\s*"'Start Here'!B4:ZZZ",\s*"'Calculations'!B4:ZZZ",\s*"'Dashboard'!B4:ZZZ",\s*\] as const/)
assert.match(configureBlock, /body: \{ ranges: \[\.\.\.GENERATED_HEADER_CLEAR_RANGES, \.\.\.GENERATED_REPORT_CLEAR_RANGES\] \}/)
assert.ok(configureBlock.indexOf('unmergeCells') < configureBlock.indexOf('/values:batchClear'))
assert.ok(configureBlock.indexOf('/values:batchClear') < configureBlock.indexOf('/values:batchUpdate'))
assert.match(configureBlock, /const dataColumn = title === 'Dashboard' \? 'P' : title === 'Start Here' \? 'C' : 'B'/)

const verificationBlock = source.slice(
  source.indexOf('async function verifyPipelineTabsAndHeaders'),
  source.indexOf('const shortLinkActor'),
)
assert.match(verificationBlock, /const startColumn = title === 'Dashboard' \? 'P' : title === 'Start Here' \? 'C' : 'B'/)
assert.match(verificationBlock, /title === 'Start Here'\s*\? 'D'/)

assert.match(source, /conditionalFormats\?: unknown\[\]/)
assert.match(source, /bandedRanges\?: Array<\{ bandedRangeId\?: number \}>/)
assert.match(source, /basicFilter\?: unknown/)
assert.match(source, /charts\?: Array<\{ chartId\?: number \}>/)
assert.match(configureBlock, /deleteConditionalFormatRule/)
assert.match(configureBlock, /deleteBanding/)
assert.match(configureBlock, /clearBasicFilter/)
assert.match(configureBlock, /deleteEmbeddedObject/)

const chartRequestBlock = source.slice(
  source.indexOf('function dashboardChartRequests'),
  source.indexOf('function dashboardValueWrites'),
)
assert.equal((chartRequestBlock.match(/\n\s+chart\(\{/g) || []).length, 4)
assert.match(chartRequestBlock, /startColumnIndex: DASHBOARD_HELPER_COLUMN_INDEX/)
assert.match(chartRequestBlock, /startColumnIndex: DASHBOARD_HELPER_COLUMN_INDEX \+ 1/)
assert.match(chartRequestBlock, /hiddenDimensionStrategy: 'SHOW_ALL'/)
assert.match(chartRequestBlock, /widthPixels: 440/)
assert.match(chartRequestBlock, /heightPixels: 250/)
for (const chartContract of [
  { title: 'Opportunity lifecycle', start: 6, end: 10, row: 9, column: 1, type: 'COLUMN' },
  { title: 'Pipeline value', start: 11, end: 14, row: 9, column: 7, type: 'COLUMN' },
  { title: 'CRM records', start: 14, end: 17, row: 24, column: 1, type: 'BAR' },
  { title: 'Interactions, last 90 days', start: 17, end: 20, row: 24, column: 7, type: 'COLUMN' },
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

const dashboardWrites = source.slice(
  source.indexOf('function dashboardValueWrites'),
  source.indexOf('function googleBorder'),
)
for (const cell of ['B5', 'B6', 'E5', 'E6', 'H5', 'H6', 'K5', 'K6', 'B9', 'B24', 'B40']) {
  assert.ok(dashboardWrites.includes(`'Dashboard'!${cell}`), `Dashboard write missing ${cell}`)
}
assert.match(source, /const DASHBOARD_HELPER_COLUMN_INDEX = 15/)
assert.match(source, /properties: \{ hiddenByUser: true \}/)
assert.match(source, /hideGridlines: true/)
assert.match(source, /tabColor: googleColor\(WORKBOOK_TAB_COLORS\[title\]\)/)
assert.match(source, /properties: \{ pixelSize \}/)
assert.match(source, /tableBandingRequest/)
assert.match(source, /setBasicFilter/)

assert.match(source, /pattern: '0\.0"%"'/)
assert.match(source, /numeric\(10, 'NUMBER_BETWEEN', \['0', '100'\]\)/)
for (const contract of [
  "dropdown(1, 'E')",
  "dropdown(3, 'B')",
  "dropdown(5, 'F')",
  "dropdown(6, 'D')",
  "dropdown(7, 'H')",
  "dropdown(8, 'G')",
]) {
  assert.ok(source.includes(contract), `Opportunity validation missing ${contract}`)
}
assert.match(source, /editable: title === 'Opportunities'/)
assert.match(source, /PROTECTION_PREFIX/)
assert.match(source, /generated \$\{title\}/)
assert.match(source, /opportunity identifiers and headers/)

assert.match(source, /applyPipelineWorkbookBrandingWithRequest/)
assert.match(source, /range: `'\$\{title\}'!B1`/)
assert.match(source, /range: `'\$\{title\}'!C1`/)
assert.match(source, /range: `'\$\{title\}'!C2`/)
assert.match(source, /function workbookBrandMark/)
assert.doesNotMatch(source, /=IMAGE\(/)
const brandingBlock = source.slice(
  source.indexOf('export async function applyPipelineWorkbookBrandingWithRequest'),
  source.indexOf('export async function applyPipelineWorkbookBranding('),
)
assert.ok(
  brandingBlock.indexOf('/v4/spreadsheets/${sheetId}:batchUpdate')
    < brandingBlock.lastIndexOf('/v4/spreadsheets/${sheetId}/values:batchUpdate'),
  'branding cells must be written after header merges are reconciled',
)

assert.match(source, /title === 'Dropdowns' && !newlyProvisionedTitles\.has\(title\)/)
assert.match(source, /if \(preserveConfiguredDropdowns\) return writes/)
assert.doesNotMatch(source.slice(initialRowsStart, source.indexOf('export class PipelineProvisioningRequestError')), /\n\s+Opportunities\s*:/)
assert.match(projectionSource, /await configurePipelineTabs\(runtime, input\.context\.sheetId\)[\s\S]{0,260}await applyPipelineWorkbookBranding/)
assert.match(projectionSource, /const branding = await readPipelineWorkbookBranding\(input\.context\.pipelineId\)/)
assert.match(projectionSource, /await configureLegacyPipelineTabs\(input\.context\.sheetId\)[\s\S]{0,180}await applyLegacyPipelineWorkbookBranding\(input\.context\.sheetId, branding\)/)
assert.match(legacySource, /applyPipelineWorkbookBrandingWithRequest\(matonSheetsJson, sheetId, branding\)/)

console.log('pipeline workbook dashboard contract tests passed')
