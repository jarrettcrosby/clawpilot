#!/usr/bin/env node
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
function load(path, dependencies) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { fileName: path, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } })
  const module = { exports: {} }
  vm.runInNewContext(output.outputText, { module, exports: module.exports,
    Date, Error, JSON, Map, Number, Object, RegExp, Set, String,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`); return dependencies[name] },
  }, { filename: path })
  return module.exports
}
const projection = load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts', { 'node:crypto': crypto })
const { planNativeEmailAccessRepair } = load('app_src/lib/crm/nativeEmailAccessRepairPlan.ts', {
  'node:crypto': crypto, './suiteCrmNativeEmailProjection': projection,
})
const now = Date.parse('2026-10-30T03:00:00Z')
const policy = 'a'.repeat(64), content = 'b'.repeat(64), fence = 'c'.repeat(64)
const clone = value => JSON.parse(JSON.stringify(value))
function pipeline(pipelineId, readers, groupId = `group-${pipelineId}`) {
  const audience = { policy: 'pipeline-internal', ownerSuiteCrmId: 'admin', allowedSuiteCrmUserIds: readers,
    fingerprint: '', workspaceId: 'suburbia-workspace', pipelineId }
  audience.fingerprint = projection.suiteCrmEmailAudienceFingerprint(audience)
  return { audience, generation: 1, binding: { groupId, workspaceId: audience.workspaceId, pipelineId, generation: 1,
    audienceFingerprint: audience.fingerprint, memberSuiteCrmUserIds: [...readers], nativePolicyFingerprint: policy } }
}
function fixture() {
  return { version: 1, capturedAt: new Date(now).toISOString(),
    complete: { localEmails: true, nativeEmails: true, pipelineAudiences: true },
    nativePolicyFingerprint: policy, writerFence: { state: 'drained', generation: fence },
    pipelines: [pipeline('suburbia-pipeline', ['olivia', 'admin']), pipeline('private-pipeline', ['admin'])],
    localEmails: [
      { localId: 'local-1', globalId: 'gi1234567', nativeId: 'native-1', pipelineId: 'suburbia-pipeline', archived: false },
      { localId: 'local-2', globalId: 'gi2345678', nativeId: 'native-2', pipelineId: 'private-pipeline', archived: true },
    ],
    nativeEmails: [
      { nativeId: 'native-1', globalId: 'gi1234567', recordFingerprint: content, groupIds: [], readerSuiteCrmUserIds: ['admin'] },
      { nativeId: 'native-2', globalId: 'gi2345678', recordFingerprint: content, groupIds: [], readerSuiteCrmUserIds: ['admin'] },
    ],
  }
}
function plan(input = fixture(), clock = now) { return clone(planNativeEmailAccessRepair(input, clock)) }
function held(input, code, clock = now) {
  const result = plan(input, clock)
  assert.equal(result.status, 'held')
  assert.equal(result.executable, false)
  assert.ok(result.holds.some(hold => hold.code === code), JSON.stringify(result.holds))
  assert.deepEqual(result.commands, [])
  assert.deepEqual(result.futureBindings, [])
  return result
}

test('plans existing identity-preserving historical access and the same exact future bindings', () => {
  const input = fixture(), before = clone(input), result = plan(input)
  assert.equal(result.status, 'ready_for_review')
  assert.equal(result.executable, false)
  assert.equal(result.commands.length, 2)
  assert.deepEqual(input, before)
  const command = result.commands[0]
  assert.equal(command.action, 'attach_existing_email_to_verified_pipeline_group')
  assert.equal(command.localId, 'local-1')
  assert.equal(command.nativeId, 'native-1')
  assert.equal(command.globalId, 'gi1234567')
  assert.deepEqual(command.allowedSuiteCrmUserIds, ['admin', 'olivia'])
  assert.deepEqual(result.commands[1].allowedSuiteCrmUserIds, ['admin'])
  assert.equal(result.commands[1].archived, true)
  assert.equal(command.expectedNativeRecordFingerprint, content)
  assert.equal(command.expectedNativePolicyFingerprint, policy)
  assert.equal(result.futureBindings.length, 2)
  assert.equal(result.contract.createHistoricalEmail, false)
  assert.equal(result.contract.changeRolesOrGroupMembersDuringPublication, false)
  assert.equal(result.contract.fallbackToOrganizationGroup, false)
  assert.equal(result.contract.nativeTransactionRequired, true)
  assert.equal(result.contract.policyAndMembershipFenceRequired, true)
  assert.equal(result.contract.oldWriterDrainRequired, true)
  assert.equal(result.contract.secureNewUserDefaultsRequired, true)
  assert.equal(result.contract.pipelineReadAndWriteAuthorityMustRemainSeparate, true)
  assert.equal(Object.hasOwn(command, 'body'), false)
  assert.equal(Object.hasOwn(command, 'assignedUserId'), false)
})

test('plan and idempotency keys are deterministic across inventory and reader order', () => {
  const input = fixture(), expected = plan(input)
  input.pipelines.reverse(); input.localEmails.reverse(); input.nativeEmails.reverse()
  input.pipelines[1].audience.allowedSuiteCrmUserIds.reverse()
  input.pipelines[1].binding.memberSuiteCrmUserIds.reverse()
  input.complete = { pipelineAudiences: true, nativeEmails: true, localEmails: true }
  input.writerFence = { generation: fence, state: 'drained' }
  assert.deepEqual(plan(input), expected)
  assert.match(expected.commands[0].idempotencyKey, /^crm-email-access:v1:[a-f0-9]{64}$/)
})

test('confirmed exact group and reader set becomes unchanged, never a duplicate command', () => {
  const input = fixture()
  input.nativeEmails[0].groupIds = ['group-suburbia-pipeline']
  input.nativeEmails[0].readerSuiteCrmUserIds = ['olivia', 'admin']
  const result = plan(input)
  assert.equal(result.commands.length, 1)
  assert.equal(result.unchanged.length, 1)
  assert.equal(result.unchanged[0].nativeId, 'native-1')
})

test('same workspace does not broaden a private pipeline to organization readers', () => {
  const input = fixture()
  input.pipelines[1].binding.memberSuiteCrmUserIds.push('olivia')
  held(input, 'binding_drift')
})

test('revoked member or a newly added intended reader invalidates stale binding', () => {
  for (const readers of [['admin'], ['admin', 'olivia', 'new-reader']]) {
    const input = fixture(), audience = input.pipelines[0].audience
    audience.allowedSuiteCrmUserIds = readers
    audience.fingerprint = projection.suiteCrmEmailAudienceFingerprint(audience)
    held(input, 'binding_drift')
  }
})

test('a group attach cannot be claimed to remove an unexpected native reader', () => {
  const input = fixture()
  input.nativeEmails[1].readerSuiteCrmUserIds.push('olivia')
  held(input, 'unexpected_native_reader')
})

test('missing binding, binding generation or native policy drift hold', () => {
  for (const mutate of [
    input => { input.pipelines[0].binding = null },
    input => { input.pipelines[0].binding.generation = 2 },
    input => { input.pipelines[0].binding.nativePolicyFingerprint = 'd'.repeat(64) },
    input => { input.pipelines[0].binding.workspaceId = 'wrong-workspace' },
    input => { input.pipelines[0].binding.pipelineId = 'wrong-pipeline' },
  ]) {
    const input = fixture(); mutate(input)
    held(input, input.pipelines[0].binding === null ? 'missing_binding' : 'binding_drift')
  }
})

test('any missing native identity or row holds without creating replacement Emails', () => {
  for (const mutate of [input => { input.localEmails[0].nativeId = null }, input => { input.nativeEmails.shift() }]) {
    const input = fixture(); mutate(input)
    held(input, 'missing_native_email')
  }
})

test('unmapped native records hold rather than guess a pipeline', () => {
  const input = fixture(); input.localEmails.shift()
  held(input, 'unmapped_native_email')
})

test('global/native identity disagreement or absent native global ID hold', () => {
  for (const value of ['gi3456789', null]) {
    const input = fixture(); input.nativeEmails[0].globalId = value
    held(input, 'identity_mismatch')
  }
})

test('duplicate local IDs, global IDs or native mappings block entire manifest', () => {
  for (const field of ['localId', 'globalId', 'nativeId']) {
    const input = fixture(); input.localEmails[1][field] = input.localEmails[0][field]
    held(input, 'duplicate_local_identity')
  }
})

test('duplicate native IDs or global IDs block entire manifest', () => {
  for (const field of ['nativeId', 'globalId']) {
    const input = fixture(); input.nativeEmails[1][field] = input.nativeEmails[0][field]
    held(input, 'duplicate_native_identity')
  }
})

test('duplicate pipelines and shared group bindings are not accepted', () => {
  const input = fixture(); input.pipelines.push(clone(input.pipelines[0]))
  held(input, 'duplicate_pipeline')
  const other = fixture(); other.pipelines[1].binding.groupId = other.pipelines[0].binding.groupId
  held(other, 'duplicate_group_binding')
})

test('unknown pipeline or unmanaged/foreign existing group holds', () => {
  const input = fixture(); input.localEmails[0].pipelineId = 'unknown-pipeline'
  held(input, 'missing_pipeline')
  const other = fixture(); other.nativeEmails[0].groupIds = ['group-private-pipeline']
  held(other, 'unmanaged_group')
})

test('incomplete, future-dated, stale inventory and undrained writer hold', () => {
  for (const key of ['localEmails', 'nativeEmails', 'pipelineAudiences']) {
    const input = fixture(); input.complete[key] = false
    held(input, 'incomplete_inventory')
  }
  held(fixture(), 'stale_inventory', now - 1)
  held(fixture(), 'stale_inventory', now + 300_001)
  const input = fixture(); input.writerFence.state = 'not_drained'
  held(input, 'writer_not_drained')
})

test('bad audience fingerprint and missing owner refuse the whole plan', () => {
  const input = fixture(); input.pipelines[0].audience.fingerprint = 'd'.repeat(64)
  held(input, 'invalid_audience')
  const other = fixture(); other.pipelines[0].audience.allowedSuiteCrmUserIds = ['olivia']
  held(other, 'invalid_audience')
})

test('malformed types, unknown content fields, duplicate members and oversized snapshots fail closed', () => {
  for (const mutate of [
    input => { input.localEmails[0].localId = 123 },
    input => { input.nativeEmails[0].body = 'should never be accepted or returned' },
    input => { input.nativeEmails[0].groupIds = ['duplicate', 'duplicate'] },
    input => { input.pipelines[0].binding.memberSuiteCrmUserIds.push('olivia') },
    input => { input.pipelines[0].generation = 0 },
    input => { input.nativeEmails = Array(10_001).fill(input.nativeEmails[0]) },
    input => { input.nativePolicyFingerprint = 'not-a-digest' },
  ]) { const input = fixture(); mutate(input); held(input, 'invalid_input') }
})

test('content change and writer fence replacement invalidate the reviewed manifest', () => {
  const original = plan()
  const contentChanged = fixture(); contentChanged.nativeEmails[0].recordFingerprint = 'd'.repeat(64)
  const changed = plan(contentChanged)
  assert.notEqual(changed.manifestFingerprint, original.manifestFingerprint)
  assert.notEqual(changed.commands[0].idempotencyKey, original.commands[0].idempotencyKey)
  const fenced = fixture(); fenced.writerFence.generation = 'e'.repeat(64)
  assert.notEqual(plan(fenced).manifestFingerprint, original.manifestFingerprint)
})
