#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')

const route = read('app_src/app/api/pipeline/route.ts')
for (const fragment of [
  'Idempotency-Key is required for opportunity creation',
  'requireResourceEditor(pipeline)',
  "entity: 'organizations'",
  "relationshipType !== 'customer'",
  "entity: 'opportunities'",
  'stageCrmRecordInPostgres',
  'readCrmOpportunityInPostgres',
]) {
  assert.ok(route.includes(fragment), `pipeline opportunity route missing ${fragment}`)
}
assert.doesNotMatch(route, /upsertPipelineProjectionInPostgres/, 'the UI must not bypass CRM authority')
assert.doesNotMatch(route, /appendPipelineSheetRow/, 'the UI must not write a guessed Sheet row directly')

const mutationRoute = read('app_src/app/api/pipeline/opportunity/[id]/route.ts')
assert.match(mutationRoute, /readCrmOpportunityInPostgres/)
assert.match(mutationRoute, /stageCrmRecordInPostgres/)
assert.match(mutationRoute, /expectedUpdatedAt/)
assert.doesNotMatch(mutationRoute, /sourceRowNumber\s*[-+]/, 'opportunity edits must not derive a Sheet row number')
assert.doesNotMatch(mutationRoute, /upsertPipelineProjectionInPostgres/)

const component = read('app_src/components/pipeline/PipelineSection.tsx')
assert.match(component, /New opportunity/)
assert.match(component, /Select an organization already in CRM/)
assert.match(component, /Add organization/)
assert.match(component, /record\.relationshipType === 'customer'/)
assert.match(component, /'Idempotency-Key': newOpportunityMutationKey/)
assert.match(component, /pipelineAccess === 'owner' \|\| pipelineAccess === 'editor'/)
assert.doesNotMatch(component, /canEdit\s*=\s*!pipelineSyncEnabled/, 'Sheet sync must not control CRM edit access')

const syncStatus = read('app_src/app/api/pipeline/sync-status/route.ts')
assert.match(syncStatus, /readCrmSummaryFromPostgres/)
assert.match(syncStatus, /pendingSync: crmSummary\.pendingSync/)
assert.match(syncStatus, /failedSync: crmSummary\.failedSync/)

console.log('pipeline opportunity workflow contract tests passed')
