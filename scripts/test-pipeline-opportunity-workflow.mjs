#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { crmDateOnly } from '../app_src/lib/crm/dateOnly.mjs'
import { splitPipelineProductNames } from '../app_src/lib/pipeline/productNames.mjs'
import {
  isActivePipelineStatus,
  isTerminalPipelineStatus,
  summarizePipeline,
} from '../app_src/lib/pipeline/analytics.mjs'
import {
  BASE_PIPELINE_WORKFLOW,
  createBasePipelineDropdownCatalog,
} from '../app_src/lib/pipeline/baseTemplate.mjs'
import {
  commitNumericDraft,
  numericDraftFromValue,
  sanitizeNumericDraft,
} from '../app_src/lib/pipeline/numericDraft.mjs'

const root = process.cwd()
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')

const route = read('app_src/app/api/pipeline/route.ts')
for (const fragment of [
  'Idempotency-Key is required for opportunity creation',
  'requireResourceEditor(pipeline)',
  "entity: 'organizations'",
  "relationshipType !== 'customer'",
  "entity: 'opportunities'",
  'createCrmOpportunityInPostgres',
  'readPipelineCatalogInPostgres',
  'requestedProductIds',
  'productIds: products.map((product) => product.id)',
  'ownerContactId: ownerPerson?.id || null',
  'contactIds',
]) {
  assert.ok(route.includes(fragment), `pipeline opportunity route missing ${fragment}`)
}
assert.doesNotMatch(route, /upsertPipelineProjectionInPostgres/, 'the UI must not bypass CRM authority')
assert.doesNotMatch(route, /appendPipelineSheetRow/, 'the UI must not write a guessed Sheet row directly')

const mutationRoute = read('app_src/app/api/pipeline/opportunity/[id]/route.ts')
assert.match(mutationRoute, /readCrmOpportunityInPostgres/)
assert.match(mutationRoute, /stageCrmRecordInPostgres/)
assert.match(mutationRoute, /appendCrmOpportunityCommentInPostgres/)
assert.match(mutationRoute, /updateCrmOpportunityInPostgres/)
assert.match(mutationRoute, /expectedUpdatedAt/)
assert.match(mutationRoute, /readPipelineCatalogInPostgres/)
assert.match(mutationRoute, /requestedProductIds/)
assert.match(mutationRoute, /productIds: products\.map/)
assert.match(mutationRoute, /ownerContactId:/)
assert.match(mutationRoute, /At least one product is required/)
assert.doesNotMatch(mutationRoute, /sourceRowNumber\s*[-+]/, 'opportunity edits must not derive a Sheet row number')
assert.doesNotMatch(mutationRoute, /upsertPipelineProjectionInPostgres/)

const crmPersistence = read('app_src/lib/persistence/crm.ts')
assert.match(crmPersistence, /appendCrmOpportunityCommentInPostgres/)
assert.match(crmPersistence, /createCrmOpportunityInPostgres/)
assert.match(crmPersistence, /updateCrmOpportunityInPostgres/)
assert.match(crmPersistence, /pg_advisory_xact_lock/)
assert.match(crmPersistence, /FOR UPDATE OF opportunity/)
assert.match(crmPersistence, /source: 'clawpilot-pipeline-comment'/)
assert.match(crmPersistence, /pipeline-opportunity-update:/)
assert.match(crmPersistence, /crm-opportunity-create:/)
assert.match(crmPersistence, /requestFingerprint/)
assert.match(crmPersistence, /Idempotency-Key was already used with a different opportunity payload/)

assert.doesNotMatch(route, /resolvePipelineSpaceAccess\(\{ actorEmail: actor\.email, pipelineId: selected \}\)\s*\.catch/)
assert.doesNotMatch(mutationRoute, /resolvePipelineSpaceAccess\(\{ actorEmail: actor\.email, pipelineId: selected \}\)\s*\.catch/)

const component = read('app_src/components/pipeline/PipelineSection.tsx')
assert.match(component, /New opportunity/)
assert.match(component, /newOpportunity\.productIds/)
assert.match(component, /Select one or more products owned by this organization/)
assert.match(component, /productIds: newOpportunity\.productIds/)
assert.match(component, /ownerContactId: newOpportunity\.ownerContactId/)
assert.match(component, /fetch\('\/api\/pipeline\/catalog'/)
assert.match(component, /aria-label="Open pipeline setup"/)
assert.match(component, /title="Configure pipeline"/)
assert.match(component, /Add products and workflow choices before creating the first opportunity/)
assert.match(component, />\s*Open setup\s*<\/Button>/)
assert.doesNotMatch(component, /multiple\s+freeSolo/, 'products must come from the tenant catalog')
assert.match(component, /Select an organization already in CRM/)
assert.match(component, /Associated contacts/)
assert.match(component, /Select one or more contacts, then save the opportunity/)
assert.match(component, /Save opportunity/)
assert.match(component, /value=\{numericDrafts\.value\}/)
assert.match(component, /value=\{numericDrafts\.probability\}/)
assert.match(component, /commitNumericDraft\(numericDrafts\.value/)
assert.match(component, /commitNumericDraft\(numericDrafts\.probability/)
assert.match(component, /setNumericDrafts\(\{[\s\S]*?numericDraftFromValue\(normalized\?\.value\)[\s\S]*?numericDraftFromValue\(normalized\?\.probability\)[\s\S]*?\}\)[\s\S]*?\}, \[deal\]\)/)
assert.match(component, /contactIds: newOpportunity\.contactIds/)
assert.match(component, /contactIds: deal\.contactIds/)
assert.match(component, /Add organization/)
assert.match(component, /record\.relationshipType === 'customer'/)
assert.match(component, /label="Loss Reason"[\s\S]*?<MenuItem value="">Not selected<\/MenuItem>/)
assert.match(component, /'Idempotency-Key': newOpportunityMutationKey/)
assert.doesNotMatch(component, /actor: 'Jarrett'/)
assert.match(component, /pipelineAccess === 'owner' \|\| pipelineAccess === 'editor'/)
assert.doesNotMatch(component, /canEdit\s*=\s*!pipelineSyncEnabled/, 'Sheet sync must not control CRM edit access')

let amountDraft = ''
for (const typedValue of ['1', '12', '123', '123.', '123.4', '123.45']) {
  amountDraft = sanitizeNumericDraft(typedValue)
  assert.equal(amountDraft, typedValue, `amount draft must preserve ${typedValue}`)
}
assert.deepEqual(
  commitNumericDraft(amountDraft, { minimum: 0, fallback: 0 }),
  { value: 123.45, draft: '123.45' },
)

let probabilityDraft = ''
for (const typedValue of ['7', '7.', '7.2', '7.25']) {
  probabilityDraft = sanitizeNumericDraft(typedValue)
  assert.equal(probabilityDraft, typedValue, `probability draft must preserve ${typedValue}`)
}
assert.deepEqual(
  commitNumericDraft(probabilityDraft, { minimum: 0, maximum: 100, fallback: 0 }),
  { value: 7.25, draft: '7.25' },
)
assert.equal(sanitizeNumericDraft(''), '')
assert.equal(sanitizeNumericDraft('-'), '-')
assert.equal(sanitizeNumericDraft('123.'), '123.')
assert.equal(sanitizeNumericDraft('$1,234.56'), '1234.56')
assert.deepEqual(commitNumericDraft('-', { minimum: 0, fallback: 0 }), { value: 0, draft: '0' })
assert.deepEqual(commitNumericDraft('-12.5', { minimum: 0, fallback: 0 }), { value: 0, draft: '0' })
assert.deepEqual(commitNumericDraft('125.5', { minimum: 0, maximum: 100, fallback: 0 }), { value: 100, draft: '100' })
assert.equal(numericDraftFromValue(987.654), '987.654')

const catalogRoute = read('app_src/app/api/pipeline/catalog/route.ts')
for (const fragment of [
  'requireResourceEditor(pipeline)',
  "action === 'upsert-person'",
  "action === 'upsert-product'",
  'readPipelineCatalogInPostgres',
  'upsertPipelineCatalogPersonInPostgres',
  'upsertPipelineCatalogProductInPostgres',
  'MAX_CSV_BYTES',
  'MAX_CSV_ROWS',
  'spreadsheet formula character',
]) {
  assert.ok(catalogRoute.includes(fragment), `pipeline catalog route missing ${fragment}`)
}

const catalogDialog = read('app_src/components/pipeline/PipelineCatalogDialog.tsx')
assert.match(catalogDialog, /ClawPilot access/)
assert.match(catalogDialog, /CRM only/)
assert.match(catalogDialog, /Download \$\{tab\} CSV template/)
assert.match(catalogDialog, /clawpilot-\$\{kind\}-template\.csv/)
assert.match(catalogDialog, /Workflow/)

const dropdownRoute = read('app_src/app/api/pipeline/dropdowns/route.ts')
assert.match(dropdownRoute, /EDITABLE_WORKFLOW_FIELDS/)
assert.match(dropdownRoute, /mergeEditableWorkflowCatalog/)
assert.match(dropdownRoute, /upsertAppManagedPipelineDropdownCatalogInPostgres/)
assert.match(dropdownRoute, /upsertPipelineDropdownCatalogAndEnqueueInPostgres/)

assert.equal(crmDateOnly('2026-08-14'), '2026-08-14')
assert.equal(crmDateOnly('2026-08-14T00:00:00.000Z'), '2026-08-14')
assert.equal(crmDateOnly(new Date(2026, 7, 14)), '2026-08-14')
assert.equal(crmDateOnly('Fri Aug 14'), '')

assert.deepEqual(
  splitPipelineProductNames('AAR, CAC, AAR, Merchant y140 & y182'),
  ['AAR', 'CAC', 'Merchant y140 & y182'],
)
assert.deepEqual(splitPipelineProductNames(['LDS', 'POD, TIA']), ['LDS', 'POD', 'TIA'])
assert.match(crmPersistence, /splitPipelineProductNames/)
assert.match(read('app_src/lib/persistence/pipeline.ts'), /rawValue\.toLowerCase\(\) === 'neogotiation'/)

assert.equal(isActivePipelineStatus('Open'), true)
assert.equal(isActivePipelineStatus('On Hold'), true)
assert.equal(isTerminalPipelineStatus('Closed'), true)
assert.equal(isTerminalPipelineStatus('Won'), true)
const analytics = summarizePipeline([
  { id: 'open', status: 'Open', stage: 'Proposal', value: 100, probability: 50, closeDate: '2026-08-01' },
  { id: 'hold', status: 'On Hold', stage: 'Needs Analysis', value: 200, probability: 25, closeDate: '2026-09-01' },
  { id: 'won', status: 'Closed', stage: 'Closed', value: 300, probability: 100, closeDate: '2026-06-01' },
  { id: 'lost', status: 'Lost', stage: 'Loss', value: 400, probability: 0, closeDate: '2026-05-01' },
  { id: 'conflict', status: 'Open', stage: 'Loss', value: 500, probability: 10, closeDate: '' },
], { now: '2026-07-16T12:00:00Z' })
assert.equal(analytics.totalCount, 5)
assert.equal(analytics.activeCount, 3)
assert.equal(analytics.onHoldCount, 1)
assert.equal(analytics.activeValue, 800)
assert.equal(analytics.weightedActiveValue, 150)
assert.equal(analytics.wonCount, 1)
assert.equal(analytics.lostCount, 1)
assert.equal(analytics.winRate, 50)
assert.deepEqual(analytics.lifecycleConflicts.map((deal) => deal.id), ['conflict'])
assert.deepEqual(analytics.missingCloseDate.map((deal) => deal.id), ['conflict'])

const baseCatalog = createBasePipelineDropdownCatalog('2026-07-16T12:00:00Z')
assert.deepEqual(BASE_PIPELINE_WORKFLOW.status, ['Open', 'On Hold', 'Won', 'Lost', 'Abandoned'])
assert.deepEqual(baseCatalog.dropdowns.product, [])
assert.deepEqual(baseCatalog.dropdowns.stage.map((option) => option.value), BASE_PIPELINE_WORKFLOW.stage)
assert.equal(baseCatalog.dropdowns.stage.every((option, index) => option.active && option.sort_order === index), true)
const tenancy = read('app_src/lib/tenancy.ts')
assert.match(tenancy, /ensureBasePipelineTemplate\(client, personalPipeline\.rows\[0\]\.id\)/)
assert.match(tenancy, /ensureBasePipelineTemplate\(client, result\.rows\[0\]\.id\)/)
assert.match(tenancy, /ON CONFLICT \(pipeline_id\) DO UPDATE/)
assert.match(tenancy, /\(\(EXCLUDED\.catalog->'dropdowns'\) - 'product'\)/)
assert.match(tenancy, /WHERE COALESCE\(jsonb_array_length/)

const syncStatus = read('app_src/app/api/pipeline/sync-status/route.ts')
assert.match(syncStatus, /readCrmSummaryFromPostgres/)
assert.match(syncStatus, /pendingSync: crmSummary\.pendingSync/)
assert.match(syncStatus, /failedSync: crmSummary\.failedSync/)

console.log('pipeline opportunity workflow contract tests passed')
