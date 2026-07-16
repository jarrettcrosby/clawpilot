#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { crmDateOnly } from '../app_src/lib/crm/dateOnly.mjs'

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
  'opportunityProducts(body?.products ?? body?.name)',
  "join(', ')",
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
assert.match(mutationRoute, /opportunityProductName\(updates\.products \?\? updates\.name\)/)
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
assert.match(component, /newOpportunity\.products/)
assert.match(component, /Select one or more configured pipeline products/)
assert.match(component, /products: deal\.name\.split/)
assert.doesNotMatch(component, /multiple\s+freeSolo\s+options=\{products\}/)
assert.match(component, /Select an organization already in CRM/)
assert.match(component, /Add organization/)
assert.match(component, /record\.relationshipType === 'customer'/)
assert.match(component, /'Idempotency-Key': newOpportunityMutationKey/)
assert.doesNotMatch(component, /actor: 'Jarrett'/)
assert.match(component, /pipelineAccess === 'owner' \|\| pipelineAccess === 'editor'/)
assert.doesNotMatch(component, /canEdit\s*=\s*!pipelineSyncEnabled/, 'Sheet sync must not control CRM edit access')

assert.equal(crmDateOnly('2026-08-14'), '2026-08-14')
assert.equal(crmDateOnly('2026-08-14T00:00:00.000Z'), '2026-08-14')
assert.equal(crmDateOnly(new Date(2026, 7, 14)), '2026-08-14')
assert.equal(crmDateOnly('Fri Aug 14'), '')

const syncStatus = read('app_src/app/api/pipeline/sync-status/route.ts')
assert.match(syncStatus, /readCrmSummaryFromPostgres/)
assert.match(syncStatus, /pendingSync: crmSummary\.pendingSync/)
assert.match(syncStatus, /failedSync: crmSummary\.failedSync/)

console.log('pipeline opportunity workflow contract tests passed')
