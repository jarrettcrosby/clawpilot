#!/usr/bin/env node
// Pure wire-contract tests: no SQL, native endpoint, credentials or provider I/O.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
function load(path, dependencies) {
  const module = { exports: {} }
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('module', 'exports', 'require', compiled)(module, module.exports, name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`)
    return dependencies[name]
  })
  return module.exports
}
const api = load('app_src/lib/crm/nativeEmailPublication.ts', { 'node:crypto': crypto })
const transport = load('app_src/lib/crm/nativeEmailPublicationTransport.ts', { './nativeEmailPublication': api })
const copy = value => JSON.parse(JSON.stringify(value))
const held = error => error?.name === 'NativeEmailPublicationHeld'
const pinKeys = ['capabilityPolicyFingerprint', 'principalSuiteCrmUserIds', 'expectedCapabilities']
const pins = value => Object.fromEntries(pinKeys.map(key => [key, copy(value[key])]))
function fixture() {
  const attributes = { global_id_c: 'gi1234567', name: 'Synthetic v2 Email', date_sent_received: '2026-10-30T13:00:00.000Z',
    type: 'archived', status: 'read', parent_type: '', parent_id: '', assigned_user_id: 'admin', description: 'Synthetic content', description_html: '',
    from_addr_name: 'sender@example.test', to_addrs_names: 'reader@example.test', cc_addrs_names: '', bcc_addrs_names: '', reply_to_addrs_names: '' }
  const command = { version: 2, operationId: 'a'.repeat(64), mode: 'publish', workspaceId: 'workspace',
    pipelineId: '11111111-1111-4111-8111-111111111111', generation: 1, audienceFingerprint: 'b'.repeat(64),
    suiteCrmId: 'native-email', globalId: 'gi1234567', localId: '22222222-2222-4222-8222-222222222222', expectedRecordFingerprint: null,
    projection: { attributes, accounts: [], contacts: [], contactAccounts: [], previousManaged: { accounts: [], contacts: [] } },
    capabilityPolicyFingerprint: 'd'.repeat(64), principalSuiteCrmUserIds: ['admin', 'denied', 'editor', 'viewer'],
    expectedCapabilities: { view: ['admin', 'editor', 'viewer'], list: ['admin', 'editor', 'viewer'], export: ['admin', 'editor', 'viewer'],
      edit: ['admin', 'editor'], delete: ['admin'] } }
  const input = { command, nativePolicyFingerprint: 'e'.repeat(64), allowedReaderSuiteCrmUserIds: ['viewer', 'admin', 'editor'] }
  const request = api.prepareNativeEmailPublication(input)
  const receipt = { version: 2, operationId: command.operationId, commandHash: request.commandHash, state: 'committed', replayed: false,
    result: { version: 2, mode: 'publish', suiteCrmId: command.suiteCrmId, globalId: command.globalId, pipelineId: command.pipelineId,
      generation: 1, audienceFingerprint: command.audienceFingerprint, recordFingerprint: 'c'.repeat(64), readerSuiteCrmUserIds: ['admin', 'editor', 'viewer'],
      ...pins(command), projection: { version: 2, suiteCrmId: command.suiteCrmId, sourceAttributes: copy(attributes),
        attributes: { ...attributes, date_sent_received: '2026-10-30 13:00:00', created_by: 'admin', deleted: '0', description_html: 'Native HTML' },
        accounts: [], contacts: [], contactAccounts: [], snapshotFingerprint: 'c'.repeat(64), dateSentReceivedUtc: '2026-10-30T13:00:00Z' } } }
  const prepared = { version: 2, suiteCrmId: command.suiteCrmId, globalId: command.globalId, pipelineId: command.pipelineId,
    generation: 1, audienceFingerprint: command.audienceFingerprint, expectedRecordFingerprint: null, ...pins(command) }
  return { input, request, command, receipt, prepared }
}

test('v2 immutable command hash includes policy, complete principal inventory and all capabilities', () => {
  const { input, request } = fixture()
  assert.equal(request.command.version, 2)
  assert.deepEqual(request.allowedReaderSuiteCrmUserIds, ['admin', 'editor', 'viewer'])
  for (const mutate of [c => { c.capabilityPolicyFingerprint = 'f'.repeat(64) },
    c => { c.principalSuiteCrmUserIds.push('zz-denied') }, c => { c.expectedCapabilities.edit = ['admin'] }]) {
    const changed = copy(input); mutate(changed.command)
    const next = api.prepareNativeEmailPublication(changed)
    assert.notEqual(next.commandHash, request.commandHash)
    assert.notEqual(next.requestFingerprint, request.requestFingerprint)
  }
  input.command.expectedCapabilities.edit.push('viewer')
  assert.deepEqual(request.command.expectedCapabilities.edit, ['admin', 'editor'])
})

test('v2 requires exact keys and rejects missing, extra or downgraded command shape', () => {
  for (const mutate of [...pinKeys.map(key => c => { delete c[key] }), c => { c.version = 1 },
    c => { c.version = 3 }, c => { c.authorized = true }, c => { c.expectedCapabilities.create = ['admin'] }]) {
    const { input } = fixture(); mutate(input.command)
    assert.throws(() => api.prepareNativeEmailPublication(input), held)
  }
})

test('v2 policy and inventory have strict identity, order, uniqueness and finite bounds', () => {
  const invalidInventories = [[], ['viewer', 'admin'], ['admin', 'admin'], ['admin', 'bad\n'], ['a'.repeat(37)],
    [true], ['admin', 'missing-viewers'], Array.from({ length: 501 }, (_, n) => `p${String(n).padStart(3, '0')}`)]
  for (const inventory of invalidInventories) {
    const { input } = fixture(); input.command.principalSuiteCrmUserIds = inventory
    assert.throws(() => api.prepareNativeEmailPublication(input), held)
  }
  for (const value of ['', 'd'.repeat(64) + '\n', ['d'.repeat(64)], true]) {
    const { input } = fixture(); input.command.capabilityPolicyFingerprint = value
    assert.throws(() => api.prepareNativeEmailPublication(input), held)
  }
})

test('all read surfaces exactly bind request readers and write surfaces stay within readers', () => {
  for (const mutate of [c => { c.view = ['admin'] }, c => { c.list = ['admin'] }, c => { c.export = ['admin'] },
    c => { c.edit.push('denied'); c.edit.sort() }, c => { c.delete = ['unknown'] },
    c => { c.edit.reverse() }, c => { c.delete.push('admin') }, c => { c.view = ['admin', 'editor', 'viewer\n'] }]) {
    const { input } = fixture(); mutate(input.command.expectedCapabilities)
    assert.throws(() => api.prepareNativeEmailPublication(input), held)
  }
  const { input } = fixture(); input.command.expectedCapabilities.delete = []
  assert.deepEqual(api.prepareNativeEmailPublication(input).command.expectedCapabilities.delete, [])
})

test('v2 committed result preserves the exact capability pins and full projection check', () => {
  const { request, receipt } = fixture()
  assert.equal(transport.verifyNativeEmailPublicationReceipt(request, receipt), receipt)
  for (const mutate of [r => { r.capabilityPolicyFingerprint = 'f'.repeat(64) },
    r => { r.principalSuiteCrmUserIds.push('zz-denied') }, r => { r.expectedCapabilities.edit = ['admin'] },
    r => { r.expectedCapabilities.delete = [] }, r => { r.expectedCapabilities.list = ['admin'] }]) {
    const changed = copy(receipt); mutate(changed.result)
    assert.throws(() => transport.verifyNativeEmailPublicationReceipt(request, changed), held)
  }
  const bodyDrift = copy(receipt); bodyDrift.result.projection.attributes.description = 'Changed body'
  assert.throws(() => transport.verifyNativeEmailPublicationReceipt(request, bodyDrift), held)
  const readerDrift = copy(receipt); readerDrift.result.readerSuiteCrmUserIds = ['admin']
  assert.throws(() => transport.verifyNativeEmailPublicationReceipt({ ...request, allowedReaderSuiteCrmUserIds: ['admin'] }, readerDrift), held,
    'Terminal validation independently binds all read surfaces to the request readers')
})

test('v2 refuses downgraded terminal envelopes and results, including cancellation', () => {
  const { request, receipt } = fixture()
  for (const mutate of [r => { r.version = 1 }, r => { r.result.version = 1 },
    ...pinKeys.map(key => r => { delete r.result[key] }), r => { r.result.extra = true }]) {
    const changed = copy(receipt); mutate(changed)
    assert.throws(() => api.verifyNativeEmailTerminalReceipt(request, changed), held)
  }
  const cancelled = { ...receipt, state: 'cancelled', result: null }
  assert.equal(api.verifyNativeEmailTerminalReceipt(request, cancelled).version, 2)
  assert.throws(() => api.verifyNativeEmailTerminalReceipt(request, { ...cancelled, version: 1 }), held)
})

test('v2 preparation binds all three policy pins and rejects downgrades or omissions', async () => {
  const { command, prepared } = fixture()
  await transport.verifyNativeEmailPreparation(command, async () => prepared)
  for (const mutate of [r => { r.capabilityPolicyFingerprint = 'f'.repeat(64) },
    r => { r.principalSuiteCrmUserIds.push('zz-denied') }, r => { r.expectedCapabilities.edit = ['admin'] },
    r => { r.version = 1 }, ...pinKeys.map(key => r => { delete r[key] }), r => { r.extra = true }]) {
    const changed = copy(prepared); mutate(changed)
    await assert.rejects(transport.verifyNativeEmailPreparation(command, async () => changed), held)
  }
})

test('v2 bridge sends the exact stored command on fixed prepare/publish/resolve paths', async () => {
  const { command, prepared } = fixture(), calls = []
  const request = async (path, init) => { calls.push({ path, init }); return prepared }
  await transport.verifyNativeEmailPreparation(command, request)
  const bridge = transport.nativeEmailPublicationBridge(request)
  await bridge.publish(command); await bridge.resolveOrCancel(command)
  assert.deepEqual(calls.map(call => call.path.split('/').at(-1)), ['prepare', 'publish', 'resolve'])
  for (const { init } of calls) assert.equal(init.body, api.nativeEmailCanonicalJson(command))
})

test('v2 historical repair keeps the original record fingerprint and exact capability evidence', () => {
  const { input, receipt } = fixture()
  input.command.mode = 'repair'; input.command.projection = null; input.command.expectedRecordFingerprint = 'c'.repeat(64)
  const request = api.prepareNativeEmailPublication(input)
  receipt.commandHash = request.commandHash; receipt.result.mode = 'repair'; receipt.result.projection = null
  transport.verifyNativeEmailPublicationReceipt(request, receipt)
  const wrongPins = copy(receipt); wrongPins.result.expectedCapabilities.edit = ['admin']
  assert.throws(() => transport.verifyNativeEmailPublicationReceipt(request, wrongPins), held)
  receipt.result.recordFingerprint = 'f'.repeat(64)
  assert.throws(() => transport.verifyNativeEmailPublicationReceipt(request, receipt), held)
})

test('v1 commands, preparation and committed/cancelled receipts remain compatible and cannot accept v2 fields', async () => {
  const { input, receipt, prepared } = fixture()
  input.command.version = 1; receipt.version = 1; receipt.result.version = 1; prepared.version = 1
  for (const key of pinKeys) { delete input.command[key]; delete receipt.result[key]; delete prepared[key] }
  const request = api.prepareNativeEmailPublication(input); receipt.commandHash = request.commandHash
  assert.equal(request.command.version, 1)
  await transport.verifyNativeEmailPreparation(request.command, async () => prepared)
  transport.verifyNativeEmailPublicationReceipt(request, receipt)
  api.verifyNativeEmailTerminalReceipt(request, { ...receipt, state: 'cancelled', result: null })
  const injected = copy(receipt); injected.result.capabilityPolicyFingerprint = 'd'.repeat(64)
  assert.throws(() => api.verifyNativeEmailTerminalReceipt(request, injected), held)
  await assert.rejects(transport.verifyNativeEmailPreparation(request.command, async () => ({ ...prepared, expectedCapabilities: {} })), held)
})
