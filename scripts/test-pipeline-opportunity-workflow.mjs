#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { crmDateOnly } from '../app_src/lib/crm/dateOnly.mjs'
import { splitPipelineProductNames } from '../app_src/lib/pipeline/productNames.mjs'

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
assert.match(component, /contactIds: newOpportunity\.contactIds/)
assert.match(component, /contactIds: deal\.contactIds/)
assert.match(component, /Add organization/)
assert.match(component, /record\.relationshipType === 'customer'/)
assert.match(component, /'Idempotency-Key': newOpportunityMutationKey/)
assert.doesNotMatch(component, /actor: 'Jarrett'/)
assert.match(component, /pipelineAccess === 'owner' \|\| pipelineAccess === 'editor'/)
assert.doesNotMatch(component, /canEdit\s*=\s*!pipelineSyncEnabled/, 'Sheet sync must not control CRM edit access')

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

const syncStatus = read('app_src/app/api/pipeline/sync-status/route.ts')
assert.match(syncStatus, /readCrmSummaryFromPostgres/)
assert.match(syncStatus, /pendingSync: crmSummary\.pendingSync/)
assert.match(syncStatus, /failedSync: crmSummary\.failedSync/)

console.log('pipeline opportunity workflow contract tests passed')
