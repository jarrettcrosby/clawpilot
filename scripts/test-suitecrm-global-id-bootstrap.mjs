#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(
  resolve(process.cwd(), 'services/suitecrm/bootstrap-global-id.php'),
  'utf8',
)
const entrypoint = readFileSync(
  resolve(process.cwd(), 'services/suitecrm/entrypoint.sh'),
  'utf8',
)

function section(start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing ${start}`)
  assert.notEqual(endIndex, -1, `missing ${end}`)
  return source.slice(startIndex, endIndex)
}

function assertOrdered(haystack, needles, label) {
  let cursor = -1
  for (const needle of needles) {
    const next = haystack.indexOf(needle, cursor + 1)
    assert.notEqual(next, -1, `${label} missing ${needle}`)
    assert.ok(next > cursor, `${label} has ${needle} out of order`)
    cursor = next
  }
}

assert.match(
  source,
  /const CLAWPILOT_GLOBAL_ID_MIN_LENGTH = 32;/,
  'SuiteCRM Global IDs retain headroom without imposing UUID-length values',
)

const currentDefinition = section(
  'function global_id_definition_is_current',
  'function refresh_and_verify_global_id_field',
)
assert.match(
  currentDefinition,
  /\(int\) \(\$definition\['len'\] \?\? 0\) >= CLAWPILOT_GLOBAL_ID_MIN_LENGTH/,
  'the vardef convergence check must reject the legacy length 9',
)

const refresh = section(
  'function refresh_and_verify_global_id_field',
  'function ensure_global_id_field',
)
assertOrdered(refresh, [
  'VardefManager::clearVardef($module, $objectName);',
  "unset($GLOBALS['dictionary'][$objectName]);",
  'VardefManager::refreshVardefs($module, $objectName);',
  "$GLOBALS['reload_vardefs'] = true;",
  '$freshBean = BeanFactory::newBean($module);',
  '$definitionLength = (int) ($definition[\'len\'] ?? 0);',
  '$definitionLength < CLAWPILOT_GLOBAL_ID_MIN_LENGTH',
  '$persisted = $dynamic->getFieldWidget($module, CLAWPILOT_GLOBAL_ID_FIELD);',
  'DBManagerFactory::getInstance()->get_columns($tableName);',
], 'SuiteCRM stale-vardef repair')
assert.match(
  refresh,
  /\$persistedLength < CLAWPILOT_GLOBAL_ID_MIN_LENGTH/,
  'fields_meta_data length is a hard bootstrap postcondition',
)
assert.match(
  refresh,
  /\$columnLength < CLAWPILOT_GLOBAL_ID_MIN_LENGTH/,
  'the physical custom-table column length is a hard bootstrap postcondition',
)
assert.match(
  refresh,
  /\['varchar', 'char'\]/,
  'the physical Global ID column remains text',
)

const ensure = section(
  'function ensure_global_id_field',
  'function expose_note_occurred_at_in_view',
)
assert.match(
  ensure,
  /\(int\) \(\$existing->len \?\? 0\) < CLAWPILOT_GLOBAL_ID_MIN_LENGTH/,
  'persisted legacy metadata forces a repair even if the cache is newer',
)
assert.match(
  ensure,
  /\$fieldLength = max\(\s*CLAWPILOT_GLOBAL_ID_MIN_LENGTH,\s*\(int\) \(\$field->len \?\? 0\),\s*\(int\) \(\$definition\['len'\] \?\? 0\)\s*\);/s,
  'bootstrap widens short fields and never narrows a longer installed field',
)
assertOrdered(ensure, [
  '$field->save($dynamic);',
  'refresh_and_verify_global_id_field($module);',
  "$dynamic->setLabel('en_us', CLAWPILOT_GLOBAL_ID_LABEL, 'Global ID');",
], 'SuiteCRM field save and refresh')

assert.match(
  source,
  /ensure_global_id_field\('Users', false\);/,
  'the same widening and postconditions cover Users',
)
assert.match(
  source,
  /ensure_global_id_field\('Emails', false, false\);/,
  'native SuiteCRM Emails receive an API-visible Global ID without unsafe layout rewrites',
)
assert.doesNotMatch(
  source,
  /\$modules = \[[\s\S]*'Emails',[\s\S]*\];/,
  'Emails is excluded from generic layout and unified-search management',
)
assert.match(
  entrypoint,
  /php -l "\$EMAILS_LISTVIEW_METADATA"[\s\S]*\.clawpilot-invalid/,
  'a syntactically invalid generated Email list layout is preserved outside the PHP load path',
)

console.log('SuiteCRM Global ID bootstrap contract passed')
