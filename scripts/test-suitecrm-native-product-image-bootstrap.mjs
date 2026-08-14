#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(
  resolve(process.cwd(), 'services/suitecrm/bootstrap-global-id.php'),
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
  /const CLAWPILOT_PRODUCT_IMAGE_FIELD = 'clawpilot_image_c';/,
  'the native product image field name is stable',
)
assert.match(
  source,
  /const CLAWPILOT_PRODUCT_IMAGE_LABEL = 'LBL_CLAWPILOT_PRODUCT_IMAGE';/,
  'the native product image label is stable',
)

const metadata = section(
  'const CLAWPILOT_PRODUCT_IMAGE_METADATA = [',
  '];',
)
for (const expected of [
  "'storage_type' => 'private-images'",
  "'createThumbnail' => true",
  "'thumbnailHeight' => 320",
  "'thumbnailWidth' => 320",
  "'preview' => true",
  "'upload_maxsize' => 2097152",
]) {
  assert.ok(metadata.includes(expected), `native image metadata is missing ${expected}`)
}

const metadataCheck = section(
  'function product_image_metadata_is_current',
  'function product_image_definition_is_current',
)
assert.match(
  metadataCheck,
  /foreach \(CLAWPILOT_PRODUCT_IMAGE_METADATA as \$key => \$expected\)/,
  'every managed media setting participates in convergence checks',
)
assert.match(
  metadataCheck,
  /html_entity_decode\(\$metadata, ENT_QUOTES \| ENT_HTML5, 'UTF-8'\)/,
  'persisted fields_meta_data JSON is checked after SuiteCRM HTML decoding',
)
assert.match(
  metadataCheck,
  /\$metadata\[\$key\] !== \$expected/,
  'metadata types and values are verified exactly',
)

const definitionCheck = section(
  'function product_image_definition_is_current',
  'function product_image_widget_is_current',
)
assert.match(definitionCheck, /\['type'\] \?\? ''\) === 'image'/)
assert.match(definitionCheck, /\['source'\] \?\? ''\) === 'non-db'/)
assert.match(
  definitionCheck,
  /product_image_metadata_is_current\(\$definition\['metadata'\] \?\? \[\]\)/,
)

const persistedCheck = section(
  'function product_image_widget_is_current',
  'function refresh_and_verify_product_image_field',
)
assert.match(persistedCheck, /\$widget->get_field_def\(\)/)
assert.match(persistedCheck, /product_image_metadata_is_current\(\$widget->metadata \?\? \[\]\)/)

const refresh = section(
  'function refresh_and_verify_product_image_field',
  'function expose_product_image_in_view',
)
assertOrdered(refresh, [
  'VardefManager::clearVardef(CLAWPILOT_PRODUCT_MODULE, $objectName);',
  "unset($GLOBALS['dictionary'][$objectName]);",
  'VardefManager::refreshVardefs(CLAWPILOT_PRODUCT_MODULE, $objectName);',
  "$GLOBALS['reload_vardefs'] = true;",
  '$freshBean = BeanFactory::newBean(CLAWPILOT_PRODUCT_MODULE);',
  'product_image_definition_is_current($definition)',
  '$dynamic->getFieldWidget(CLAWPILOT_PRODUCT_MODULE, CLAWPILOT_PRODUCT_IMAGE_FIELD);',
  'product_image_widget_is_current($persisted)',
], 'native image vardef and persisted-metadata verification')

const layout = section(
  'function expose_product_image_in_view',
  'function ensure_product_image_field',
)
assert.match(
  layout,
  /if \(!layout_contains_field\(\$parser->getLayout\(\), CLAWPILOT_PRODUCT_IMAGE_FIELD\)\)/,
  'layout insertion is idempotent',
)
assert.match(layout, /'name' => CLAWPILOT_PRODUCT_IMAGE_FIELD/)
assert.match(layout, /'label' => CLAWPILOT_PRODUCT_IMAGE_LABEL/)
assert.match(layout, /\$parser->handleSave\(false\)/)
assert.match(
  layout,
  /if \(!\$parser \|\| !layout_contains_field\(\$parser->getLayout\(\), CLAWPILOT_PRODUCT_IMAGE_FIELD\)\)/,
  'layout persistence is a hard postcondition',
)

const ensure = section(
  'function ensure_product_image_field',
  'function expose_note_occurred_at_in_view',
)
assert.match(
  ensure,
  /if \(!product_image_definition_is_current\(\$definition\) \|\| !product_image_widget_is_current\(\$existing\)\)/,
  'the field is only rewritten when its vardef or persisted metadata drifts',
)
assertOrdered(ensure, [
  "$field = get_widget('image');",
  "$field->name = $existing ? CLAWPILOT_PRODUCT_IMAGE_FIELD : 'clawpilot_image';",
  "$field->type = 'image';",
  '$field->metadata = CLAWPILOT_PRODUCT_IMAGE_METADATA;',
  "$field->storage_type = CLAWPILOT_PRODUCT_IMAGE_METADATA['storage_type'];",
  "$field->createThumbnail = CLAWPILOT_PRODUCT_IMAGE_METADATA['createThumbnail'];",
  "$field->thumbnailHeight = CLAWPILOT_PRODUCT_IMAGE_METADATA['thumbnailHeight'];",
  "$field->thumbnailWidth = CLAWPILOT_PRODUCT_IMAGE_METADATA['thumbnailWidth'];",
  "$field->preview = CLAWPILOT_PRODUCT_IMAGE_METADATA['preview'];",
  "$field->upload_maxsize = CLAWPILOT_PRODUCT_IMAGE_METADATA['upload_maxsize'];",
  '$field->save($dynamic);',
  'refresh_and_verify_product_image_field();',
  "expose_product_image_in_view('detailview');",
  "expose_product_image_in_view('editview');",
], 'native image creation and publication')

const bootstrapCalls = section(
  "ensure_note_occurred_at_field();",
  'fwrite(STDOUT',
)
assertOrdered(bootstrapCalls, [
  'ensure_product_image_field();',
  'hide_unowned_product_purchases_subpanel();',
  'rebuild_and_verify_global_search($globalSearchModules);',
], 'bootstrap execution')

assert.match(
  source,
  /SuiteCRM Global ID fields, native product image, owned layouts, and search metadata are ready/,
  'bootstrap output reports the native image postcondition',
)

console.log('SuiteCRM native product image bootstrap contract passed')
