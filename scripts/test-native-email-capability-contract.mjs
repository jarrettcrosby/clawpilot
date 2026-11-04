#!/usr/bin/env node
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import test, { after } from 'node:test'
const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
function load(path, dependencies) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { fileName: path, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  assert.deepEqual((output.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error), [])
  const module = { exports: {} }
  new Function('module', 'exports', 'require', output.outputText)(module, module.exports, name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`); return dependencies[name]
  })
  return module.exports
}
const wire = load('app_src/lib/crm/nativeEmailPublication.ts', { 'node:crypto': crypto })
const api = load('app_src/lib/crm/nativeEmailCapabilityContract.ts', { 'node:crypto': crypto, './nativeEmailPublication': wire })
const copy = value => JSON.parse(JSON.stringify(value))
function fixture() {
  const readers = ['admin', 'editor', 'viewer'], principals = ['admin', 'editor', 'outsider', 'viewer']
  const binding = { pipelineId: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace', ownerSuiteCrmId: 'admin',
    allowedReaderSuiteCrmUserIds: readers, audienceFingerprint: '' }
  binding.audienceFingerprint = crypto.createHash('sha256').update(JSON.stringify({ policy: 'pipeline-internal', ownerSuiteCrmId: 'admin',
    allowedSuiteCrmUserIds: readers, workspaceId: binding.workspaceId, pipelineId: binding.pipelineId })).digest('hex')
  const futureCreate = { view: [...readers], list: [...readers], export: [...readers], edit: ['admin', 'editor'], delete: ['admin'] }
  const historical = [{ suiteCrmId: 'native-email-1', globalId: 'gi1234567',
    capabilities: { ...copy(futureCreate), delete: ['admin', 'editor'] } }]
  const contract = { version: 2, pipelineId: binding.pipelineId, workspaceId: binding.workspaceId, ownerSuiteCrmId: binding.ownerSuiteCrmId,
    audienceFingerprint: binding.audienceFingerprint, principalSuiteCrmUserIds: [...principals], futureCreate, historical }
  const evidence = { binding, livePrincipalSuiteCrmUserIds: principals, approvedFutureCreate: copy(futureCreate), liveHistorical: copy(historical) }
  return { contract, evidence }
}
const parity = []
function accepts(value) {
  const prepared = api.prepareNativeEmailCapabilityContract(value.contract, value.evidence)
  if (value.expectedFingerprint) api.verifyNativeEmailCapabilityFingerprint(value.contract, value.evidence, value.expectedFingerprint, value.fingerprintScope)
  if (value.selection) api.verifyNativeEmailCapabilityReadback(value.contract, value.evidence, value.selection, value.readback)
  parity.push({ vector: copy(value), expected: { ok: true, fingerprint: prepared.fingerprint,
    futurePolicyFingerprint: prepared.futurePolicyFingerprint, historicalFingerprint: prepared.historicalFingerprint } }); return prepared
}
function refuses(value, pattern) {
  assert.throws(() => {
    api.prepareNativeEmailCapabilityContract(value.contract, value.evidence)
    if (value.expectedFingerprint) api.verifyNativeEmailCapabilityFingerprint(value.contract, value.evidence, value.expectedFingerprint, value.fingerprintScope)
    if (value.selection) api.verifyNativeEmailCapabilityReadback(value.contract, value.evidence, value.selection, value.readback)
  }, pattern)
  parity.push({ vector: copy(value), expected: { ok: false } })
}
test('explicit future-create editors and distinct historical delete rights are preserved', () => {
  const f = fixture(), prepared = accepts(f)
  assert.deepEqual(prepared.contract.futureCreate.edit, ['admin', 'editor'])
  assert.deepEqual(prepared.contract.historical[0].capabilities.delete, ['admin', 'editor'])
  assert.deepEqual(prepared.contract.futureCreate.delete, ['admin'])
  assert.notEqual(prepared.contract, f.contract)
  assert.equal(prepared.fingerprint, wire.nativeEmailDigest(f.contract))
  assert.throws(() => { prepared.contract.futureCreate.edit.push('viewer') }, TypeError)
})
test('durable v2 fingerprint pins every reviewed capability and preserved record', () => {
  const f = fixture(), fingerprint = api.prepareNativeEmailCapabilityContract(f.contract, f.evidence).fingerprint
  accepts({ ...f, expectedFingerprint: fingerprint })
  refuses({ ...f, expectedFingerprint: '0'.repeat(64) }, /fingerprint_changed/)
  f.contract.futureCreate.delete.push('editor'); f.evidence.approvedFutureCreate = copy(f.contract.futureCreate)
  refuses({ ...f, expectedFingerprint: fingerprint }, /fingerprint_changed/)
})
test('new verified history changes operation evidence but not the durable future policy pin', () => {
  const f = fixture(), initial = accepts(f)
  f.contract.historical.push({ suiteCrmId: 'native-email-2', globalId: 'gi7654321', capabilities: copy(f.contract.futureCreate) })
  f.evidence.liveHistorical = copy(f.contract.historical)
  const next = accepts({ ...f, expectedFingerprint: initial.futurePolicyFingerprint, fingerprintScope: 'future-policy' })
  assert.equal(next.futurePolicyFingerprint, initial.futurePolicyFingerprint)
  assert.notEqual(next.fingerprint, initial.fingerprint)
  assert.notEqual(next.historicalFingerprint, initial.historicalFingerprint)
  refuses({ ...f, expectedFingerprint: initial.historicalFingerprint, fingerprintScope: 'historical' }, /fingerprint_changed/)
})
test('future writes cannot be inferred from readers or historical capabilities', () => {
  for (const mutate of [f => { delete f.contract.futureCreate }, f => { f.contract.futureCreate.edit = ['admin', 'editor', 'viewer'] },
    f => { f.contract.futureCreate.delete = ['admin', 'editor'] }]) {
    const f = fixture(); mutate(f); refuses(f)
  }
})
test('whole live principal inventory includes denied outsiders and detects new principals', () => {
  const omitted = fixture(); omitted.contract.principalSuiteCrmUserIds.splice(2, 1); refuses(omitted, /inventory_changed/)
  const added = fixture(); added.evidence.livePrincipalSuiteCrmUserIds.splice(2, 0, 'new-user'); refuses(added, /inventory_changed/)
  const duplicate = fixture(); duplicate.contract.principalSuiteCrmUserIds.push('viewer'); refuses(duplicate, /principal_ids/)
})
test('exact reader binding and write-without-read checks reject expansion and narrowing', () => {
  for (const surface of ['view', 'list', 'export']) {
    const f = fixture(); f.contract.futureCreate[surface] = ['admin', 'editor']; refuses(f, /reader_binding/)
  }
  const writes = fixture(); writes.contract.futureCreate.edit = ['admin', 'outsider']; refuses(writes, /write_without_read/)
  const unknown = fixture(); unknown.contract.futureCreate.edit = ['admin', 'unknown']; refuses(unknown, /unknown_principal/)
})
test('complete historical matrices cannot omit, swap, or silently narrow existing editors', () => {
  for (const mutate of [f => { f.contract.historical = [] }, f => { f.contract.historical[0].globalId = 'gi7654321' },
    f => { f.contract.historical[0].capabilities.edit = ['admin'] }]) {
    const f = fixture(); mutate(f); refuses(f, /history_changed/)
  }
})
test('readback distinguishes future creation from exact historical identity without fallback', () => {
  const f = fixture()
  accepts({ ...f, selection: { mode: 'future-create' }, readback: {
    principalSuiteCrmUserIds: f.contract.principalSuiteCrmUserIds, capabilities: f.contract.futureCreate } })
  accepts({ ...f, selection: { mode: 'historical', suiteCrmId: 'native-email-1', globalId: 'gi1234567' }, readback: {
    principalSuiteCrmUserIds: f.contract.principalSuiteCrmUserIds, capabilities: f.contract.historical[0].capabilities } })
  refuses({ ...f, selection: { mode: 'historical', suiteCrmId: 'missing', globalId: 'gi1234567' }, readback: {
    principalSuiteCrmUserIds: f.contract.principalSuiteCrmUserIds, capabilities: f.contract.futureCreate } }, /historical_record_missing/)
  refuses({ ...f, selection: { mode: 'future-create' }, readback: {
    principalSuiteCrmUserIds: f.contract.principalSuiteCrmUserIds, capabilities: f.contract.historical[0].capabilities } }, /readback_changed/)
})
test('scope fingerprint, exact keys, ordering, ASCII identity, and bounded inputs fail closed', () => {
  for (const mutate of [f => { f.contract.pipelineId = '22222222-2222-4222-8222-222222222222' },
    f => { f.contract.audienceFingerprint = 'a'.repeat(64); f.evidence.binding.audienceFingerprint = f.contract.audienceFingerprint },
    f => { f.contract.extra = true }, f => { f.contract.futureCreate.edit.reverse() },
    f => { f.contract.principalSuiteCrmUserIds[0] += '\n' }, f => { f.contract.version = 1 },
    f => { f.contract.historical = Array(501).fill(f.contract.historical[0]) }]) {
    const f = fixture(); mutate(f); refuses(f)
  }
  const sparse = fixture(); delete sparse.contract.principalSuiteCrmUserIds[1]
  assert.throws(() => api.prepareNativeEmailCapabilityContract(sparse.contract, sparse.evidence), /principal_ids/)
})
test('v1 unexpected-write denial remains while v2 requires independently pinned capability authority', () => {
  const source = readFileSync(new URL('../services/suitecrm/email-audience/NativeEmailPublisher.php', import.meta.url), 'utf8')
  assert.match(source, /unexpected_native_write_access/)
  assert.match(source, /\$c\['version'\]===1[\s\S]*?capability_version_required[\s\S]*?return null;/)
  assert.match(source, /\$policy!==null\s*\?\s*\$this->assertCapabilities\(\$c,\$b\)\s*:\s*\$this->assertReaders/)
  assert.match(source, /capability_policy_missing/)
  assert.match(source, /ClawPilotNativeEmailCapabilityContract::prepare/)
  assert.match(source, /hash_equals\(\$prepared\['futurePolicyFingerprint'\],\$b\['capability_policy_fingerprint'\]\)/)
  assert.match(source, /hash_equals\(\$prepared\['futurePolicyFingerprint'\],\$c\['capabilityPolicyFingerprint'\]\)/)
  assert.match(source, /capability_identity_unreviewed/)
  assert.match(readFileSync(new URL('../services/suitecrm/email-audience/NativeEmailCapabilityContract.php', import.meta.url), 'utf8'), /version'\]===2/)
})
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && (args[0] === '--emit-fixture' || args[0].startsWith('--php=')),
  'Optional --emit-fixture or --php=/absolute/php only; no Docker or live access')
if (args[0]?.startsWith('--php=')) test('pure PHP verifier agrees with every TypeScript acceptance and refusal vector', () => {
  const binary = args[0].slice('--php='.length); assert.ok(binary.startsWith('/'))
  const output = execFileSync(binary, ['scripts/fixtures/native-email-audience-real/native-email-capability-contract.php'], {
    input: JSON.stringify(parity.map(v => v.vector)), encoding: 'utf8', timeout: 10000,
  })
  assert.deepEqual(JSON.parse(output), parity.map(v => v.expected))
})
if (args[0] === '--emit-fixture') after(() => {
  console.log('CLAWPILOT_NATIVE_CAPABILITY_FIXTURE=' + JSON.stringify({ version: 1, vectors: parity.map(v => v.vector), expected: parity.map(v => v.expected) }))
})
