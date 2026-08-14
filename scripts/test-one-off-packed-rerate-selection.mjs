import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(
  new URL('../app_src/lib/persistence/operationOneOffShipping.ts', import.meta.url),
  'utf8',
)
const require = createRequire(import.meta.url)
const ts = require('../app_src/node_modules/typescript')
const sourceFile = ts.createSourceFile(
  'operationOneOffShipping.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)
const declaration = sourceFile.statements.find((statement) => (
  ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'packedRerateCarrierSelections'
))
assert.ok(declaration, 'packed rerate carrier selection projector must exist')

const functionSource = declaration.getText(sourceFile).replace(/^export\s+/, '')
const compiled = ts.transpileModule(functionSource, {
  compilerOptions: {
    module: ts.ModuleKind.None,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const context = {
  fail(code, message, status = 409) {
    const error = new Error(message)
    error.code = code
    error.status = status
    throw error
  },
}
vm.runInNewContext(
  `${compiled}\nglobalThis.subject = packedRerateCarrierSelections`,
  context,
)
const subject = context.subject
const json = (value) => JSON.parse(JSON.stringify(value))

const packageCode = (packageKey, providerPackageCode) => ({
  packageKey,
  catalogEntryId: 'box',
  catalogVersion: 'operations.package_catalog.v1',
  providerPackageCode,
})
const ups = {
  selectionKey: 'ups_rest:gia0000001:gac0000001:v4',
  provider: 'ups_rest',
  integrationAccountGlobalId: 'gia0000001',
  carrierAccountGlobalId: 'gac0000001',
  credentialVersion: 4,
  packageCodes: [packageCode('parcel-a', '02')],
}
const fedex = {
  selectionKey: 'fedex_rest:gia0000002:gac0000002:v7',
  provider: 'fedex_rest',
  integrationAccountGlobalId: 'gia0000002',
  carrierAccountGlobalId: 'gac0000002',
  credentialVersion: 7,
  packageCodes: [packageCode('parcel-a', 'YOUR_PACKAGING')],
}
const wwex = {
  selectionKey: 'wwex_speedship:gia0000003:none:v2',
  provider: 'wwex_speedship',
  integrationAccountGlobalId: 'gia0000003',
  carrierAccountGlobalId: null,
  credentialVersion: 2,
  packageCodes: [packageCode('parcel-a', '02')],
}

assert.deepEqual(json(subject(1, [ups, fedex, wwex])), [
  {
    provider: 'ups_rest',
    integrationAccountGlobalId: 'gia0000001',
    carrierAccountGlobalId: 'gac0000001',
  },
  {
    provider: 'fedex_rest',
    integrationAccountGlobalId: 'gia0000002',
    carrierAccountGlobalId: 'gac0000002',
  },
  {
    provider: 'wwex_speedship',
    integrationAccountGlobalId: 'gia0000003',
    carrierAccountGlobalId: null,
  },
])

// A carrier account enabled after planning is deliberately absent: packed
// rerating projects only the immutable planning snapshot it is given.
assert.deepEqual(json(subject(1, [fedex])), [{
  provider: 'fedex_rest',
  integrationAccountGlobalId: 'gia0000002',
  carrierAccountGlobalId: 'gac0000002',
}])

const assertUnavailable = (schemaVersion, selections) => assert.throws(
  () => subject(schemaVersion, selections),
  (error) => (
    error.code === 'OPERATIONS_ONE_OFF_PACKED_RATE_CARRIER_SELECTION_UNAVAILABLE'
    && error.status === 409
  ),
)
assertUnavailable(null, null)
assertUnavailable(1, [fedex, ups])
assertUnavailable(1, [ups, { ...ups }])
assertUnavailable(1, [{ ...ups, selectionKey: `${ups.selectionKey}-changed` }])
assertUnavailable(1, [{ ...wwex, carrierAccountGlobalId: 'gac0000003' }])
assertUnavailable(1, [{
  ...ups,
  packageCodes: [packageCode('parcel-b', '02'), packageCode('parcel-a', '02')],
}])

assert.match(
  source,
  /planning_quote\.required_carrier_selections\s+AS planning_required_carrier_selections/,
)
assert.match(
  source,
  /planning_quote\.carrier_selection_schema_version\s+AS planning_carrier_selection_schema_version/,
)
assert.match(
  source,
  /selectedCarriers:\s*packedRerateCarrierSelections\(\s*context\.planning_carrier_selection_schema_version,\s*context\.planning_required_carrier_selections/,
)
assert.doesNotMatch(functionSource, /enabledOneOff|enabledCarrier|workspaceCarriers/)

console.log('one-off packed rerate carrier selection contracts passed')
