#!/usr/bin/env node
// Actual pure value module only. No issuer, SQL, native CLI or provider calls.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import * as crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'

assert.equal(process.versions.node.split('.')[0], '24', 'Use the supported bundled Node24 runtime')
assert.equal(process.argv.length, 2, 'This focused pure test takes no runtime target or mutation arguments')
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const cache = new Map()
function load(name) {
  if (cache.has(name)) return cache.get(name)
  const module = {exports: {}}
  const source = readFileSync(new URL(`../app_src/lib/crm/${name}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }}).outputText
  new Function('require', 'module', 'exports', code)(specifier => {
    if (specifier === 'node:crypto') return crypto
    assert.ok(specifier.startsWith('./'), 'Only the local pure helper graph may be loaded')
    return load(specifier.slice(2))
  }, module, module.exports)
  cache.set(name, module.exports)
  return module.exports
}
const {NativeEmailPublicationHeld: Held, nativeEmailCanonicalJson: canonical} = load('nativeEmailPublication')
const {prepareNativeEmailInitialInstallationLineage: prepare,
  nativeEmailInitialInstallationLineageDigest: digest, prepareNativeEmailInitialReplanContext: prepareContext,
  finalizeNativeEmailInitialInstallationLineage: finalize, nativeEmailInitialReplanContextFromLineage: fromLineage,
  effectiveNativeEmailInitialInstallationJournalFingerprint: effectiveJournal} = load('nativeEmailInitialInstallationLineage')
const hash = value => createHash('sha256').update(value).digest('hex')
const current = hash('current-operation')
const hashKeys = ['rootOperationId', 'rootInstallationJournalFingerprint', 'rootSourceArtifactDigest',
  'rootStockRuntimeFingerprint', 'predecessorOperationId', 'predecessorPlanHash', 'predecessorApprovalHash',
  'predecessorCancellationReceiptHash', 'cancelledHistoryFingerprint', 'freshSourceArtifactDigest',
  'freshInstalledRuntimeFingerprint']
function first() {
  return {version: 1, purpose: 'clawpilot-native-email-initial-installation-lineage',
    ...Object.fromEntries(hashKeys.map(key => [key, hash(key)])),
    predecessorOperationId: hash('rootOperationId'), previousLineageHash: null, depth: 1}
}
function repeated(depth = 2) {
  return {...first(), predecessorOperationId: hash('cancelled-predecessor'),
    previousLineageHash: digest(first(), hash('prior-current-operation')), depth}
}
function context(value = first()) {
  const {freshSourceArtifactDigest, freshInstalledRuntimeFingerprint, ...anchors} = value
  void freshSourceArtifactDigest; void freshInstalledRuntimeFingerprint
  return {...anchors, purpose: 'clawpilot-native-email-initial-replan-context'}
}
const rejects = (value, operation = current, code) => assert.throws(() => prepare(value, operation),
  error => error instanceof Held && (!code || error.code === `initial_installation_lineage_${code}`))
let checks = 0
function check(label, run) {run(); checks++; console.log(`PASS ${label}`)}

check('first cancelled-predecessor values produce a frozen defensive canonical copy', () => {
  const value = first(), prepared = prepare(value, current)
  assert.deepEqual(prepared, value)
  assert.notEqual(prepared, value)
  assert.equal(Object.isFrozen(prepared), true)
  assert.throws(() => {prepared.rootOperationId = hash('mutation')}, TypeError)
  value.rootSourceArtifactDigest = hash('later-input-mutation')
  assert.notEqual(prepared.rootSourceArtifactDigest, value.rootSourceArtifactDigest)
  assert.equal(Object.hasOwn(prepared, 'currentOperationId'), false)
})
check('repeated lineage values accept depths two and five hundred without claiming chain proof', () => {
  for (const depth of [2, 3, 499, 500]) assert.equal(prepare(repeated(depth), current).depth, depth)
})
check('key order and null-prototype inputs yield the same independently computed canonical digest', () => {
  const value = repeated(), reordered = Object.fromEntries(Object.entries(value).reverse())
  const nullPrototype = Object.assign(Object.create(null), reordered)
  const expectedJson = JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
  assert.equal(canonical(prepare(value, current)), expectedJson)
  assert.equal(digest(value, current), hash(expectedJson))
  assert.equal(digest(reordered, current), digest(value, current))
  assert.equal(digest(nullPrototype, current), digest(value, current))
  assert.equal(Object.getPrototypeOf(prepare(nullPrototype, current)), Object.prototype)
})
check('nonobjects, arrays, custom prototypes and non-data properties are refused', () => {
  for (const value of [null, undefined, false, 1, 'lineage', [], new Date(), () => first(),
    Object.assign(Object.create({inherited: true}), first())]) rejects(value, current, 'shape')
  let reads = 0
  const getter = first()
  Object.defineProperty(getter, 'rootOperationId', {enumerable: true, get() {reads++; return hash('rootOperationId')}})
  rejects(getter, current, 'shape'); assert.equal(reads, 0)
  const hidden = first()
  Object.defineProperty(hidden, 'depth', {value: 1, enumerable: false})
  rejects(hidden, current, 'shape')
})
check('every required field is mandatory and unknown, alias, symbol and hidden fields are rejected', () => {
  for (const key of Object.keys(first())) {const value = first(); delete value[key]; rejects(value, current, 'shape')}
  for (const key of ['operationId', 'root_operation_id', 'predecessor', 'sourceArtifactDigest',
    'freshSourceDigest', 'currentOperationId', 'signature', 'sql', 'approved']) rejects({...first(), [key]: hash('extra')}, current, 'shape')
  const symbol = first(); symbol[Symbol('alias')] = 'unknown'; rejects(symbol, current, 'shape')
  const hidden = first(); Object.defineProperty(hidden, 'alias', {value: true}); rejects(hidden, current, 'shape')
})
check('the exact version and lineage purpose cannot be substituted', () => {
  for (const version of [0, 2, '1', null, undefined]) rejects({...first(), version}, current, 'domain')
  for (const purpose of ['', 'clawpilot-native-email-initial-source',
    'clawpilot-native-email-initial-installation-lineage\n', null]) rejects({...first(), purpose}, current, 'domain')
})
check('each operation or digest field requires exact lowercase sixty-four hex bytes', () => {
  const invalid = ['f'.repeat(63), 'f'.repeat(65), 'F'.repeat(64), 'g'.repeat(64), `${'f'.repeat(64)}\n`,
    `${'f'.repeat(64)}\r`, `${'f'.repeat(64)}\u2028`, ` ${'f'.repeat(64)}`, '', null, 7, {}, []]
  for (const key of hashKeys) for (const value of invalid) rejects({...first(), [key]: value}, current, 'hash')
  for (const previousLineageHash of invalid) if (previousLineageHash !== null) {
    rejects({...repeated(), previousLineageHash}, current, 'hash')
  }
  for (const operation of invalid) rejects(first(), operation, 'operation')
})
check('depth rejects coercion, fractional values, nonfinite values and out-of-bound integers', () => {
  for (const depth of [-1, 0, 501, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity,
    '1', true, null, undefined, 1n]) rejects({...first(), depth}, current, 'depth')
})
check('the current operation cannot be its own installation root or predecessor', () => {
  rejects({...first(), rootOperationId: current, predecessorOperationId: current}, current, 'self')
  rejects({...repeated(), rootOperationId: current}, current, 'self')
  rejects({...repeated(), predecessorOperationId: current}, current, 'self')
})
check('first and repeated predecessor forms cannot be mixed or partially upgraded', () => {
  rejects({...first(), predecessorOperationId: hash('not-root')}, current, 'predecessor')
  rejects({...first(), previousLineageHash: hash('unexpected-prior-lineage')}, current, 'predecessor')
  rejects({...repeated(), predecessorOperationId: first().rootOperationId}, current, 'predecessor')
  rejects({...repeated(), previousLineageHash: null}, current, 'predecessor')
  rejects({...first(), depth: 2}, current, 'predecessor')
  rejects({...repeated(), depth: 1}, current, 'predecessor')
})
check('every accepted lineage anchor and depth binds the digest', () => {
  const value = repeated(), original = digest(value, current)
  for (const key of [...hashKeys, 'previousLineageHash']) {
    const changed = {...value, [key]: hash(`changed-${key}`)}
    assert.notEqual(digest(changed, current), original, key)
  }
  assert.notEqual(digest({...value, depth: 3}, current), original)
})
check('digest entry point performs the same validation and errors reveal no supplied unknown payload', () => {
  const payload = 'PRIVATE_LINEAGE_VALUE_SENTINEL'
  assert.throws(() => digest({...first(), approval: payload}, current),
    error => error instanceof Held && error.code === 'initial_installation_lineage_shape' && !error.message.includes(payload))
  assert.throws(() => digest(first(), 'not-an-operation'), error => error instanceof Held
    && error.code === 'initial_installation_lineage_operation')
})
check('pre-capture context is canonical, copied and frozen without either fresh field', () => {
  for (const value of [first(), repeated(), repeated(500)]) {
    const input = context(value), prepared = prepareContext(input, current)
    assert.deepEqual(prepared, input); assert.notEqual(prepared, input); assert.equal(Object.isFrozen(prepared), true)
    assert.equal(Object.hasOwn(prepared, 'freshSourceArtifactDigest'), false)
    assert.equal(Object.hasOwn(prepared, 'freshInstalledRuntimeFingerprint'), false)
    assert.throws(() => {prepared.depth = 4}, TypeError)
  }
})
check('context refuses missing, extra, alias, wrong-purpose and circular fresh fields', () => {
  for (const key of Object.keys(context())) {
    const value = context(); delete value[key]
    assert.throws(() => prepareContext(value, current), error => error instanceof Held)
  }
  for (const [key, value] of [['freshSourceArtifactDigest', hash('self')], ['freshInstalledRuntimeFingerprint', hash('runtime')],
    ['sourceArtifactDigest', hash('alias')], ['operationId', current], ['sql', 'UPDATE anything']]) {
    assert.throws(() => prepareContext({...context(), [key]: value}, current), error => error instanceof Held)
  }
  assert.throws(() => prepareContext(first(), current), error => error instanceof Held)
  rejects(context(), current, 'shape')
  assert.throws(() => prepareContext({...context(), purpose: first().purpose}, current), error => error instanceof Held)
})
check('context retains all operation, digest, depth and first/repeated binding checks', () => {
  for (const mutate of [value => {value.rootOperationId = current}, value => {value.predecessorOperationId = current},
    value => {value.rootSourceArtifactDigest += '\n'}, value => {value.depth = 501},
    value => {value.depth = 2}, value => {value.previousLineageHash = hash('unexpected')}]) {
    const value = context(); mutate(value)
    assert.throws(() => prepareContext(value, current), error => error instanceof Held)
  }
  assert.throws(() => prepareContext(context(repeated()), 'invalid-current'), error => error instanceof Held)
  assert.throws(() => prepareContext({...context(repeated()), previousLineageHash: null}, current), error => error instanceof Held)
})
check('finalization appends a digest only after separate source bytes have been captured and hashed', () => {
  const input = context(repeated()), prepared = prepareContext(input, current)
  const capture = canonical({purpose: 'synthetic-current-source', context: prepared, currentRecordFingerprint: hash('record')})
  const sourceDigest = hash(capture), runtime = hash('actual-installed-runtime')
  const lineage = finalize(prepared, current, sourceDigest, runtime)
  assert.equal(lineage.freshSourceArtifactDigest, sourceDigest)
  assert.equal(lineage.freshInstalledRuntimeFingerprint, runtime)
  assert.equal(lineage.purpose, first().purpose); assert.equal(Object.isFrozen(lineage), true)
  assert.equal(capture.includes('freshSourceArtifactDigest'), false)
  assert.deepEqual(prepared, input)
  for (const bad of ['', 'F'.repeat(64), `${'a'.repeat(64)}\n`, null]) {
    assert.throws(() => finalize(prepared, current, bad, runtime), error => error instanceof Held)
    assert.throws(() => finalize(prepared, current, sourceDigest, bad), error => error instanceof Held)
  }
  assert.throws(() => finalize(lineage, current, sourceDigest, runtime), error => error instanceof Held)
})
check('lineage-to-context roundtrip preserves anchors and effective journal binds the full lineage', () => {
  const value=repeated(), anchors=fromLineage(value,current)
  assert.deepEqual(anchors,context(value)); assert.equal(Object.isFrozen(anchors),true)
  assert.deepEqual(finalize(anchors,current,value.freshSourceArtifactDigest,value.freshInstalledRuntimeFingerprint),value)
  assert.equal(effectiveJournal(value,current),hash(canonical({version:1,
    purpose:'clawpilot-native-email-initial-effective-installation',rootInstallationJournalFingerprint:value.rootInstallationJournalFingerprint,
    installationLineageHash:digest(value,current)})))
  assert.notEqual(effectiveJournal({...value,freshSourceArtifactDigest:hash('different-fresh-source')},current),effectiveJournal(value,current))
  assert.throws(()=>fromLineage({...value,depth:1},current),error=>error instanceof Held)
  assert.throws(()=>effectiveJournal({...value,unknown:true},current),error=>error instanceof Held)
})
console.log(`PASS ${checks} pure initial-installation lineage groups; value validation/digest only, no authority, cancellation or runtime proof`)
