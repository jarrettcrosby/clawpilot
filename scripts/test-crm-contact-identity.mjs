#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const stableIds = read('app_src/lib/crm/stableId.ts')
const persistence = read('app_src/lib/persistence/crm.ts')
const route = read('app_src/app/api/crm/route.ts')
const workbook = read('app_src/lib/crm/workbookImport.ts')
const migration = read('db/migrations/0096_crm_contact_identity_aliases.sql')
const merge = read('scripts/merge-crm-contacts.mjs')
const contract = read('docs/modules/crm-and-reporting.md')

assert.match(stableIds, /export function contactNameIdentityKey/)
assert.match(persistence, /resolveContactStageIdentity/)
assert.match(persistence, /crm_contact_source_aliases/)
assert.match(persistence, /fieldMode === 'enrich'/)
assert.match(persistence, /Contact name is ambiguous/)
assert.match(persistence, /crm_reference_aliases/)
assert.match(persistence, /crm-app-user-profile:/)
assert.match(persistence, /contact\.app_user_email = \$2/)
assert.match(persistence, /contact\.reference_code = \$3/)
assert.match(persistence, /alias\.source_key = \$4/)
assert.match(persistence, /localId: existingProfile\?\.id \|\| null/)
assert.match(persistence, /fieldMode: existingProfile \? 'enrich' : 'replace'/)
assert.match(persistence, /organizationId: existingProfile\?\.organization_id \|\| organization\.id/)
assert.match(persistence, /clawpilotProfile: profilePayload/)
assert.match(persistence, /CRM profile identity resolves to multiple contacts/)
assert.match(persistence, /isRecoverableCrmProfileReconciliationError/)
assert.match(route, /isRecoverableCrmProfileReconciliationError\(error\)/)
assert.match(route, /\[crm\] profile reconciliation deferred/)
assert.match(contract, /It never reparents the Contact on a read/)
assert.match(contract, /Pipeline membership, active-user, and other authorization failures are not recoverable/)
assert.match(workbook, /fieldMode: 'enrich'/)
assert.match(workbook, /normalizedName\(`\$\{organizationName\}:\$\{fullName\}`\)/)

for (const contract of [
  'crm_contact_source_aliases',
  'crm_reference_aliases',
  'crm_contact_merges',
  'crm_contact_merge_outbox_dependencies',
  'release_crm_contact_merge_outbox_dependents',
]) {
  assert.match(migration, new RegExp(contract))
}
assert.match(migration, /append-only/)
assert.match(merge, /--apply/)
assert.match(merge, /--confirm/)
assert.match(merge, /BEGIN ISOLATION LEVEL SERIALIZABLE/)
assert.match(merge, /validateForeignKeyCoverage/)
assert.match(merge, /assertNoInFlightWork/)
assert.match(merge, /crm_contact_merge_outbox_dependencies/)
assert.match(merge, /DELETE FROM crm_contacts/)
assert.match(merge, /dryRun: !options\.apply/)

const help = spawnSync(process.execPath, ['scripts/merge-crm-contacts.mjs', '--help'], {
  cwd: root,
  encoding: 'utf8',
})
assert.equal(help.status, 0, help.stderr)
assert.match(help.stdout, /dry-run by default/)
assert.match(help.stdout, /merge:<duplicate>:into:<survivor>/)

console.log('CRM Contact identity and guarded merge contracts passed')
