#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const stableIds = read('app_src/lib/crm/stableId.ts')
const persistence = read('app_src/lib/persistence/crm.ts')
const workbook = read('app_src/lib/crm/workbookImport.ts')
const migration = read('db/migrations/0096_crm_contact_identity_aliases.sql')
const merge = read('scripts/merge-crm-contacts.mjs')

assert.match(stableIds, /export function contactNameIdentityKey/)
assert.match(persistence, /resolveContactStageIdentity/)
assert.match(persistence, /crm_contact_source_aliases/)
assert.match(persistence, /fieldMode === 'enrich'/)
assert.match(persistence, /Contact name is ambiguous/)
assert.match(persistence, /crm_reference_aliases/)
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
