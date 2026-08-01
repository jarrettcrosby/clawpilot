import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import {
  BASE32HEX_GLOBAL_ID_SUFFIX_SOURCE,
  GLOBAL_ID_MAX_LENGTH,
  GLOBAL_ID_SUFFIX_SOURCE,
  LEGACY_GLOBAL_ID_SUFFIX_SOURCE,
  globalIdFragment,
  globalIdPattern,
  isGlobalId,
  normalizeGlobalId,
} from '../app_src/lib/globalIds.mjs'

assert.equal(LEGACY_GLOBAL_ID_SUFFIX_SOURCE, '[0-9]{7}')
assert.equal(BASE32HEX_GLOBAL_ID_SUFFIX_SOURCE, '[0-9a-v]{12}')
assert.equal(GLOBAL_ID_SUFFIX_SOURCE, '(?:[0-9]{7}|[0-9a-v]{12})')
assert.equal(GLOBAL_ID_MAX_LENGTH, 17)

const accountPattern = globalIdPattern('ga')
assert.match('ga1234567', accountPattern)
assert.match('ga0123456789av', accountPattern)
assert.doesNotMatch('gc1234567', accountPattern)
assert.doesNotMatch('ga0123456789aw', accountPattern)
assert.doesNotMatch('ga0123456789AV', accountPattern)
assert.doesNotMatch('ga12345678', accountPattern)
assert.doesNotMatch('ga0123456789a', accountPattern)
assert.doesNotMatch('ga0123456789av0', accountPattern)

const crmPattern = globalIdPattern(['ga', 'gc', 'gi', 'gk', 'gl', 'gm', 'go', 'gp'])
assert.match('gp7654321', crmPattern)
assert.match('giabcdefghijkl'.replace(/[w-z]/g, 'v'), crmPattern)
assert.doesNotMatch('gu1234567', crmPattern)
assert.equal(globalIdFragment(['ga', 'gc']), '(?:ga|gc)(?:[0-9]{7}|[0-9a-v]{12})')

assert.equal(isGlobalId('gac1234567', 'gac'), true)
assert.equal(isGlobalId('gac00000000000v', 'gac'), true)
assert.equal(isGlobalId('gac00000000000w', 'gac'), false)
assert.equal(normalizeGlobalId('  GAC00000000000V  ', 'gac'), 'gac00000000000v')
assert.equal(normalizeGlobalId('gac1234567', 'gia'), null)

assert.throws(() => globalIdPattern('g'), /Invalid Global ID prefix/)
assert.throws(() => globalIdPattern('ga|gc'), /Invalid Global ID prefix/)
assert.throws(() => globalIdPattern('gabcde'), /Invalid Global ID prefix/)
assert.throws(() => globalIdPattern([]), /At least one Global ID prefix/)

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
assert.match(
  packageJson.scripts.test,
  /npm run test:global-ids && npm run test:global-ids-postgres/,
  'The normal test gate must run the disposable-Postgres Global ID migration acceptance',
)

const deploymentAMigrationNames = readdirSync(resolve('db/migrations'))
  .filter((name) => /^(?:020[2-9]|021[0-8])_.+\.sql$/.test(name))
  .sort((left, right) => left.localeCompare(right))
assert.equal(deploymentAMigrationNames.length, 17)
for (const name of deploymentAMigrationNames) {
  const source = readFileSync(resolve('db/migrations', name), 'utf8')
  assert.match(source, /SET LOCAL lock_timeout = '5s';/)
  assert.match(source, /SET LOCAL statement_timeout = '25s';/)

  if (name >= '0204_') {
    const batch = source.match(
      /expand_global_id_compatibility_constraint_batch\((\d+), (\d+)\)/,
    )
    assert.ok(batch, `${name} must execute one generated constraint batch`)
    assert.ok(
      Number(batch[2]) - Number(batch[1]) + 1 <= 10,
      `${name} must validate no more than ten tables per transaction`,
    )
  }
}
assert.match(
  readFileSync(resolve('db/migrations/0202_global_id_alphanumeric_compatibility_core.sql'), 'utf8'),
  /Live development validation expressions measured below 100 ms/,
)

const finalMigration = deploymentAMigrationNames.at(-1)
assert.equal(
  finalMigration,
  '0218_global_id_alphanumeric_expand_141_149_and_catalog_gate.sql',
)
const healthRoute = readFileSync(resolve('app_src/app/api/health/route.ts'), 'utf8')
assert.match(healthRoute, new RegExp(finalMigration.replaceAll('.', '\\.')))
assert.match(healthRoute, /row\?\.global_id_alphanumeric_compatibility_applied/)
const predeploy = readFileSync(resolve('scripts/verify-predeploy.mjs'), 'utf8')
const operationsSection = readFileSync(
  resolve('app_src/components/operations/OperationsSection.tsx'),
  'utf8',
)
assert.match(
  operationsSection,
  /maxLength: 16,\s+pattern: 'gcte\(\?:\[0-9\]\{7\}\|\[0-9a-v\]\{12\}\)'/,
  'The cartonization evidence input must not truncate future-format Global IDs',
)
for (const name of deploymentAMigrationNames) {
  assert.match(predeploy, new RegExp(`db/migrations/${name.replaceAll('.', '\\.')}`))
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return ['.js', '.mjs', '.ts', '.tsx', '.mts'].includes(extname(entry.name))
      ? [path]
      : []
  })
}

const activeSourceFiles = [
  ...sourceFiles(resolve('app_src/app')),
  ...sourceFiles(resolve('app_src/components')),
  ...sourceFiles(resolve('app_src/lib')).filter((path) => !path.endsWith('/globalIds.mjs')),
  ...sourceFiles(resolve('scripts')).filter((path) => (
    !path.split('/').at(-1).startsWith('test-')
    && !path.endsWith('/inspect-global-id-postgres-catalog.mjs')
  )),
]
const numericSevenSource = /(?:\[0-9\]|\\d)\{7\}/
const dualFormatSource = /\[0-9a-v\]\{12\}/
const numericOnlyLines = activeSourceFiles.flatMap((path) => (
  readFileSync(path, 'utf8').split('\n').flatMap((line, index) => (
    numericSevenSource.test(line) && !dualFormatSource.test(line)
      ? [`${path}:${index + 1}:${line.trim()}`]
      : []
  ))
))
assert.deepEqual(
  numericOnlyLines,
  [],
  `Active source contains numeric-only Global ID validation:\n${numericOnlyLines.join('\n')}`,
)

const testSourceFiles = [
  ...sourceFiles(resolve('app_src/tests')),
  ...sourceFiles(resolve('scripts')).filter((path) => (
    path.split('/').at(-1).startsWith('test-')
    && !path.endsWith('/test-global-id-compatibility.mjs')
  )),
]
const numericAllocatorOutputAssertion =
  /assert\.match\(.*(?:globalId|global_id|referenceCode|reference_code)/i
const numericCatalogInspection = /position\('\[0-9\]\{7\}' IN pg_get_(?:constraint|function)def/
const historicalNumericMigrationAssertions = new Map([
  ['test-postgres-adapter-contracts.mjs', [
    "reference_code ~ '^gp[0-9]{7}$'",
    "CHECK (reference_code ~ '^gu[0-9]{7}$')",
  ]],
  ['test-commerce-normalization-schema.mjs', [
    "target_global_id ~ '^gcoc[0-9]{7}$'",
    "target_global_id ~ '^gcrj[0-9]{7}$'",
    "target_global_id ~ '^gcir[0-9]{7}$'",
  ]],
])
const staleNumericTestLines = testSourceFiles.flatMap((path) => (
  readFileSync(path, 'utf8').split('\n').flatMap((line, index) => {
    const normalizedLine = line.replaceAll('\\{', '{').replaceAll('\\}', '}')
    if (!numericSevenSource.test(normalizedLine) || dualFormatSource.test(normalizedLine)) {
      return []
    }
    const historicalAssertions = historicalNumericMigrationAssertions.get(
      path.split('/').at(-1),
    ) || []
    if (
      numericAllocatorOutputAssertion.test(normalizedLine)
      || numericCatalogInspection.test(normalizedLine)
      || historicalAssertions.some((assertion) => normalizedLine.includes(assertion))
    ) {
      return []
    }
    return [`${path}:${index + 1}:${line.trim()}`]
  })
))
assert.deepEqual(
  staleNumericTestLines,
  [],
  `Test source contains stale numeric-only Global ID expectations:\n${staleNumericTestLines.join('\n')}`,
)

console.log('Global ID compatibility checks passed')
