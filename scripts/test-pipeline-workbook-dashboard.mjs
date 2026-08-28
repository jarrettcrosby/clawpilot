#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(process.cwd(), 'app_src/lib/pipelineProvisioning.ts'), 'utf8')
const projectionSource = readFileSync(resolve(process.cwd(), 'app_src/lib/crm/workbookProjection.ts'), 'utf8')
const legacySource = readFileSync(resolve(process.cwd(), 'app_src/lib/pipelineLegacyWorkbook.ts'), 'utf8')
const rebuildRoute = readFileSync(resolve(process.cwd(), 'app_src/app/api/crm/workbook/rebuild/route.ts'), 'utf8')
const pipelineDocs = readFileSync(resolve(process.cwd(), 'docs/modules/pipeline-and-sync.md'), 'utf8')

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
assert.match(source, /Enter a percentage from 0 to 100 with up to two decimal places\./)
assert.doesNotMatch(source, /Enter a whole percent/)
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
  ['Open opportunities value', '=SUMIFS(Opportunities!J5:J', 'Opportunities!F5:F,"Open"'],
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
assert.match(source, /const GENERATED_DROPDOWN_CLEAR_RANGE = "'Dropdowns'!B4:ZZZ"/)
assert.match(configureBlock, /\.\.\.GENERATED_HEADER_CLEAR_RANGES,\s*\.\.\.GENERATED_REPORT_CLEAR_RANGES,\s*GENERATED_DROPDOWN_CLEAR_RANGE/)
assert.match(configureBlock, /const gridExpansionRequests =/)
assert.match(configureBlock, /title === 'Dashboard'\s*\? DASHBOARD_HELPER_END_COLUMN_INDEX/)
assert.ok(
  configureBlock.indexOf('gridExpansionRequests.length > 0') < configureBlock.indexOf('/values:batchClear'),
  'dashboard helper columns must exist before generated values are written',
)
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
assert.match(configureBlock, /filteredRowsIncluded: true/)
const validationResetIndex = configureBlock.indexOf('filteredRowsIncluded: true')
const opportunityValidationIndex = configureBlock.indexOf('...opportunityValidationRequests(sheetIdValue, rowCount)')
assert.ok(validationResetIndex >= 0, 'managed workbook ranges must clear legacy validation')
assert.ok(
  validationResetIndex < opportunityValidationIndex,
  'legacy validation must clear before current opportunity rules are applied',
)
assert.doesNotMatch(
  configureBlock.slice(configureBlock.indexOf('for (const chart of sheet.charts || [])') - 120, configureBlock.indexOf('for (const chart of sheet.charts || [])')),
  /title === 'Dashboard'/,
)

const chartRequestBlock = source.slice(
  source.indexOf('function dashboardChartRequests'),
  source.indexOf('function dashboardValueWrites'),
)
assert.equal((chartRequestBlock.match(/\n\s+chartShell\(\{/g) || []).length, 4)
assert.match(chartRequestBlock, /hiddenDimensionStrategy: 'SHOW_ALL'/)
assert.match(chartRequestBlock, /fontName: 'Roboto'/)
assert.match(chartRequestBlock, /widthPixels: 440/)
assert.match(chartRequestBlock, /heightPixels: 250/)
for (const chartContract of [
  { title: 'Opportunities by stage', start: 3, end: 13, row: 9, column: 1, type: 'BAR', helper: 'DASHBOARD_STAGE_HELPER_COLUMN_INDEX' },
  { title: 'Interactions, last 3 calendar months', start: 3, end: 7, row: 9, column: 7, type: 'COLUMN', helper: 'DASHBOARD_INTERACTION_HELPER_COLUMN_INDEX' },
  { title: 'Potential Revenue by Stage, Next 2 Quarters', start: 3, end: 10, row: 24, column: 1, type: 'COLUMN', helper: 'DASHBOARD_FORECAST_STAGE_HELPER_COLUMN_INDEX' },
  { title: 'Potential vs probable value', start: 3, end: 10, row: 24, column: 7, type: 'COLUMN', helper: 'DASHBOARD_FORECAST_VALUE_HELPER_COLUMN_INDEX' },
]) {
  const chartStart = chartRequestBlock.indexOf(`title: '${chartContract.title}'`)
  const chartDefinition = chartRequestBlock.slice(chartStart, chartRequestBlock.indexOf('}),', chartStart) + 3)
  assert.ok(chartStart >= 0, `missing chart: ${chartContract.title}`)
  assert.ok(chartDefinition.includes(`startRowIndex: ${chartContract.start}`))
  assert.ok(chartDefinition.includes(`endRowIndex: ${chartContract.end}`))
  assert.ok(chartDefinition.includes(`anchorRowIndex: ${chartContract.row}`))
  assert.ok(chartDefinition.includes(`anchorColumnIndex: ${chartContract.column}`))
  assert.ok(chartDefinition.includes(`chartType: '${chartContract.type}'`))
  assert.ok(chartDefinition.includes(`domainColumnIndex: ${chartContract.helper}`))
}
assert.match(chartRequestBlock, /title: 'Interactions, last 3 calendar months'/)
assert.doesNotMatch(chartRequestBlock, /Interactions, last quarter/)
assert.match(chartRequestBlock, /stackedType: 'NOT_STACKED'/)
assert.match(chartRequestBlock, /title: 'Opportunities by stage'[\s\S]*legendPosition: 'TOP_LEGEND'/)
assert.match(chartRequestBlock, /seriesColors: opportunityStageColors/)
assert.match(chartRequestBlock, /title: 'Potential Revenue by Stage, Next 2 Quarters'[\s\S]*stackedType: 'STACKED'/)
assert.match(chartRequestBlock, /title: 'Potential Revenue by Stage, Next 2 Quarters'[\s\S]*legendPosition: 'TOP_LEGEND'/)
assert.match(chartRequestBlock, /title: 'Potential Revenue by Stage, Next 2 Quarters'[\s\S]*valueAxisTitle: 'Potential revenue'/)
assert.match(chartRequestBlock, /title: 'Month ending'/)

const dashboardWrites = source.slice(
  source.indexOf('function dashboardValueWrites'),
  source.indexOf('function googleBorder'),
)
for (const label of ['Direct Mail', 'LinkedIn', 'Email', 'Call', 'In Person', 'Note', 'Campaign', 'Other']) {
  assert.match(dashboardWrites, new RegExp(`label: '${label}'`))
}
assert.match(dashboardWrites, /const opportunityStages = OPPORTUNITY_STAGE_PALETTE\.map/)
assert.match(dashboardWrites, /\['Stage', \.\.\.opportunityStages\]/)
assert.match(dashboardWrites, /=IF\(\$S\$\{5 \+ rowIndex\}=\$\{seriesColumn\}\$4,COUNTIFS/)
assert.match(source, /Interactions: \['Priority', 'Type', 'Owner', 'Organization', 'Agent', 'Date', 'Opportunity', 'Contact', 'Notes'\]/)
assert.match(dashboardWrites, /Interactions!\$C\$5:\$C/)
assert.match(dashboardWrites, /Interactions!\$G\$5:\$G/)
assert.match(
  dashboardWrites,
  /const normalizedInteractionTypeRange = 'ARRAYFORMULA\(LOWER\(REGEXREPLACE\(TRIM\(Interactions!\$C\$5:\$C\),"\[\\\\s_-\]\+"," "\)\)\)'/,
)
assert.match(dashboardWrites, /\{ label: 'Direct Mail', aliases: \['direct mail', 'directmail'\] \}/)
assert.match(dashboardWrites, /\{ label: 'Call', aliases: \['call', 'calls', 'phone', 'phone call'\] \}/)
assert.match(dashboardWrites, /=SUMPRODUCT\(--ARRAYFORMULA\(REGEXMATCH\(\$\{normalizedInteractionTypeRange\},\$\{aliasPattern\}\)\)/)
assert.match(dashboardWrites, /const aliasPattern = `"\^\(\$\{type\.aliases\.join\('\|'\)\}\)\$"`/)
assert.doesNotMatch(
  dashboardWrites,
  /COUNTIFS\(Interactions!\$C\$5:\$C/,
  'interaction buckets must not compare unnormalized Sheet type values directly',
)
const normalizeInteractionVariant = (value) => value.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
assert.equal(normalizeInteractionVariant('  Direct_Mail  '), 'direct mail')
assert.equal(normalizeInteractionVariant('phone-call'), 'phone call')
assert.match(projectionSource, /replace\(\/\[\\s_-\]\+\/g, ' '\)/)
assert.match(projectionSource, /\['direct mail', 'directmail'\]\.includes\(normalized\)\) return 'Direct Mail'/)
assert.match(projectionSource, /\['call', 'calls', 'phone', 'phone call'\]\.includes\(normalized\)\) return 'Call'/)
assert.match(dashboardWrites, /const interactionTrackerRows = \[-2, -1, 0\]/)
assert.ok(
  dashboardWrites.includes('Interactions!$G$5:$G,"<"&($${interactionMonthColumn}${sheetRow}+1)'),
  'interaction month range must include final-day datetimes with an exclusive next-day bound',
)
assert.doesNotMatch(
  dashboardWrites,
  /Interactions!\$G\$5:\$G,"<="&\$\$\{interactionMonthColumn\}/,
  'interaction month range must not stop at midnight on the final day',
)
assert.match(dashboardWrites, /const forecastStages = \['Closed', 'Closed Delayed', 'Proposal', 'Demo', 'Needs Analysis', 'Qualified Lead', 'Identified Lead'\]/)
assert.match(dashboardWrites, /forecastStageRows/)
assert.match(dashboardWrites, /=SUMIFS\(Opportunities!\$J\$5:\$J/)
assert.match(dashboardWrites, /Potential|forecastValueRows/)
assert.match(dashboardWrites, /\{ label: 'Other', aliases: \[\] \}/)
assert.match(dashboardWrites, /COUNTIFS\(\$\{monthCriteria\}\)-SUM/)
assert.match(dashboardWrites, /interactionTypes\.map\(\(type\) => type\.label\)/)
for (const cell of ['B5', 'B6', 'H5', 'H6', 'B8', 'D8', 'F8', 'I8', 'K8', 'B9', 'B24', 'B40']) {
  assert.ok(dashboardWrites.includes(`'Dashboard'!${cell}`), `Dashboard write missing ${cell}`)
}
assert.ok(
  dashboardWrites.includes(`{ range: "'Dashboard'!H5", majorDimension: 'ROWS' as const, values: [['WEIGHTED PIPELINE VALUE']] }`),
  'Dashboard H5 must identify the weighted pipeline metric',
)
assert.ok(
  dashboardWrites.includes(`{ range: "'Dashboard'!H6", majorDimension: 'ROWS' as const, values: [['=Calculations!C10']] }`),
  'Dashboard H6 must bind to the weighted active value calculation',
)
assert.doesNotMatch(dashboardWrites, /values: \[\['POTENTIAL VALUE'\]\]/)
for (const card of [
  { cell: 'B8', label: 'CONTACTS · CURRENT', binding: 'Calculations!C16', format: '#,##0' },
  { cell: 'D8', label: 'INTERACTIONS · ALL-TIME', binding: 'Calculations!C17', format: '#,##0' },
  { cell: 'F8', label: 'OPPS · CURRENT TOTAL', binding: 'Calculations!C5', format: '#,##0' },
  { cell: 'I8', label: 'WON OPPS · LIFETIME', binding: 'Calculations!C11', format: '#,##0' },
  { cell: 'K8', label: 'WIN RATE · LIFETIME', binding: 'Calculations!C14', format: '0.0%' },
]) {
  const expected = `{ range: "'Dashboard'!${card.cell}", majorDimension: 'ROWS' as const, values: [['="${card.label}  "&TEXT(${card.binding},"${card.format}")']] }`
  assert.ok(dashboardWrites.includes(expected), `${card.cell} must identify its calculation scope and exact binding`)
}
assert.match(dashboardWrites, /Grouped interactions use CRM activity type and UTC calendar months/)

const dashboardFormatting = source.slice(
  source.indexOf('function dashboardLayoutRequests'),
  source.indexOf('export async function configurePipelineTabsWithRequest'),
)
assert.match(
  dashboardFormatting,
  /startColumnIndex: 1, endColumnIndex: 2, type: 'CURRENCY', pattern: '\$#,##0\.00'/,
)
assert.match(
  dashboardFormatting,
  /startColumnIndex: 7, endColumnIndex: 8, type: 'CURRENCY', pattern: '\$#,##0\.00'/,
)
assert.match(source, /const DASHBOARD_MATERIAL =/)
assert.match(source, /fontFamily: 'Roboto Mono'/)
for (const range of ['S4', 'AC4', 'AL4', 'AT4']) {
  assert.ok(dashboardWrites.includes(`'Dashboard'!${range}`), `Dashboard helper write missing ${range}`)
}
assert.match(source, /const DASHBOARD_HELPER_COLUMN_INDEX = 15/)
assert.match(source, /const DASHBOARD_STAGE_HELPER_COLUMN_INDEX = 18/)
assert.match(source, /const DASHBOARD_INTERACTION_HELPER_COLUMN_INDEX = 28/)
assert.match(source, /const interactionSeriesColors = \[[^\]]*'#78909C'\]/)
assert.match(source, /const DASHBOARD_FORECAST_STAGE_HELPER_COLUMN_INDEX = 37/)
assert.match(source, /const DASHBOARD_FORECAST_VALUE_HELPER_COLUMN_INDEX = 45/)
assert.match(source, /const DASHBOARD_HELPER_END_COLUMN_INDEX = 48/)
assert.match(source, /properties: \{ hiddenByUser: true \}/)
assert.match(source, /hideGridlines: true/)
assert.match(source, /tabColor: googleColor\(WORKBOOK_TAB_COLORS\[title\]\)/)
assert.match(source, /properties: \{ pixelSize \}/)
assert.match(source, /tableBandingRequest/)
assert.match(source, /setBasicFilter/)
assert.match(source, /function opportunityStageConditionalFormatting/)
assert.match(source, /columnIndex: 6/)
assert.match(source, /\.\.\.opportunityStageConditionalFormatting\(sheetIdValue, rowCount\)/)

assert.match(source, /pattern: '0\.00"%"'/)
assert.doesNotMatch(source, /pattern: '0\.0"%"'/)
assert.match(projectionSource, /record\.stage, record\.lossReason, record\.source, record\.value, record\.probability,/)
assert.match(pipelineDocs, /Probability is stored as a number from 0 through 100 with up to two decimal places/)
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

assert.match(configureBlock, /const configuredDropdownRows = canonicalConfiguredDropdownRows/)
assert.match(configureBlock, /range: "'Dropdowns'!B4"[\s\S]{0,120}values: configuredDropdownRows/)
assert.doesNotMatch(source, /preserveConfiguredDropdowns/)
assert.match(source, /function canonicalConfiguredDropdownRows/)
assert.match(source, /const CANONICAL_DROPDOWN_KEYS = \['owner', 'product', 'stage', 'priority', 'status', 'source', 'loss_reason'\]/)
assert.match(source, /const keys = orderedDropdownKeys\(catalog\)/)
assert.match(configureBlock, /configuredDropdownColumnCount/)
assert.match(configureBlock, /Math\.max\(TAB_HEADERS\.Dropdowns\.length, configuredDropdownRows\[0\]\.length\)/)
assert.doesNotMatch(source.slice(initialRowsStart, source.indexOf('export class PipelineProvisioningRequestError')), /\n\s+Opportunities\s*:/)
assert.match(projectionSource, /await configurePipelineTabs\(runtime, input\.context\.sheetId\)[\s\S]{0,260}await applyPipelineWorkbookBranding/)
assert.match(projectionSource, /const branding = await readPipelineWorkbookBranding\(input\.context\.pipelineId\)/)
assert.match(projectionSource, /await configureLegacyPipelineTabs\(input\.context\.sheetId\)[\s\S]{0,180}await applyLegacyPipelineWorkbookBranding\(input\.context\.sheetId, branding\)/)
assert.match(legacySource, /applyPipelineWorkbookBrandingWithRequest\(matonSheetsJson, sheetId, branding\)/)
assert.match(projectionSource, /function workbookInteractionType/)
assert.match(projectionSource, /googleSheetsDateTime\(record\.occurredAt\)/)
assert.match(projectionSource, /timestamp \/ 86_400_000\) \+ 25_569/)
assert.match(source, /const PIPELINE_WORKBOOK_TIME_ZONE = 'Etc\/UTC'/)
assert.match(source, /fields=spreadsheetId,properties\(timeZone\),sheets/)
assert.match(configureBlock, /metadata\.properties\?\.timeZone !== PIPELINE_WORKBOOK_TIME_ZONE/)
assert.match(configureBlock, /updateSpreadsheetProperties:[\s\S]{0,180}properties: \{ timeZone: PIPELINE_WORKBOOK_TIME_ZONE \}[\s\S]{0,80}fields: 'timeZone'/)
assert.match(projectionSource, /configurePipelineTabs pins managed workbooks to Etc\/UTC/)
assert.match(pipelineDocs, /Managed workbooks are pinned to `Etc\/UTC`/)
assert.match(source, /export async function rebuildPipelineGoogleWorkbook/)
assert.match(source, /pipeline-sheet-retired/)
assert.match(source, /export async function rebuildPipelineTabsWithRequest/)
const resetBlock = source.slice(
  source.indexOf('export async function rebuildPipelineTabsWithRequest'),
  source.indexOf('function googleColor'),
)
assert.match(resetBlock, /addSheet: \{ properties: \{ sheetId: scratchSheetId, title: 'ClawPilot rebuild' \} \}/)
assert.match(resetBlock, /deleteSheet: \{ sheetId: sheet\.properties\?\.sheetId \}/)
assert.match(resetBlock, /EXPECTED_TABS\.forEach/)
assert.match(resetBlock, /await configurePipelineTabsWithRequest/)
assert.match(legacySource, /export async function rebuildLegacyPipelineTabs/)
assert.match(rebuildRoute, /isLegacyOwnerSheetPipeline\(pipeline\)/)
assert.match(rebuildRoute, /await rebuildLegacyPipelineTabs\(previousContext\.sheetId\)/)
assert.match(rebuildRoute, /await pushDropdownsToSheet\(dropdownCatalog/)
const rebuildBlock = source.slice(
  source.indexOf('export async function rebuildPipelineGoogleWorkbook'),
  source.indexOf('export async function provisionPipelineGoogleResources'),
)
assert.match(rebuildBlock, /readPipelineDropdownCatalogForSpaceInPostgres\(pipeline\.id\)/)
assert.match(rebuildBlock, /replaceManagedPipelineDropdowns\(\{ runtime, sheetId, catalog: dropdownCatalog \}\)/)

console.log('pipeline workbook dashboard contract tests passed')
