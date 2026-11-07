#!/usr/bin/env node
// Exact operator selection and sequencing with the real approval verifier.
// The separate PostgreSQL suite proves the real stage and readback functions.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as util from 'node:util'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
function load(name, dependencies = {}) {
  const source = readFileSync(new URL(`../app_src/lib/crm/${name}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  const allowed = { 'server-only': {}, 'node:crypto': crypto, 'node:util': util, ...dependencies }
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(Object.hasOwn(allowed, name), name)
    return allowed[name]
  }, module, module.exports)
  return module.exports
}
const native = load('nativeEmailPublication')
const { nativeEmailDigest: hash, nativeEmailCanonicalJson: json } = native
const approval = load('legacyEmailRecoveryReleaseApproval', { './nativeEmailPublication': native })
const operatorKey = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })
const now = 1783404000
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const target = () => ({ selected: { ownerEmail: 'synthetic@example.invalid', workspaceId: id(1), pipelineId: id(2),
  connectionId: 'synthetic-mailbox', messageIds: ['123abc'] }, holdId: id(3), outboxId: id(4), retiredOutboxId: id(5),
  lockToken: id(6), retirementReceiptHash: hash('archive receipt'),
  expectedOrganizations: { primaryNativeId: id(10), nativeIds: [id(9), id(10)] } })
const selection = () => ({ holdId: id(3), outboxId: id(4), nativeOperationId: hash('real operation'), requestFingerprint: hash('real request') })
const pins = () => ({ ...selection(), retiredOutboxId: id(5), localId: id(7), nativeId: id(8), globalId: 'gi1234567',
  pipelineId: id(2), workspaceId: id(1), sourceFingerprint: hash('source'), retirementReceiptHash: hash('archive receipt'),
  activationReceiptHash: hash('activation') })
function approved(changes = {}) {
  const proof = { version: 1, purpose: 'clawpilot-private-legacy-email-release-v1', keyId: 'synthetic-reviewer',
    ...pins(), issuedAt: now - 1, expiresAt: now + 100, ...changes }
  const signature = crypto.sign('sha256', Buffer.from(json(proof), 'ascii'),
    { key: operatorKey.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64')
  return approval.verifyLegacyEmailRecoveryReleaseApproval({ envelope: { proof, signature },
    operatorAnchor: { keyId: proof.keyId, key: operatorKey.publicKey }, nowSeconds: now })
}

function fixture({ wrongPreview, lostAck, inspectUnknown = false } = {}) {
  const events = []
  const tx = () => assert.fail('fixture substitutes the full DAL calls, not a database')
  const verified = approved()
  const receipt = { state: 'staged', holdId: id(3), outboxId: id(4), retiredOutboxId: id(5),
    intentHash: verified.intentHash, receiptHash: hash('staged receipt') }
  const api = load('nativeEmailRecoveryPrivateStage', {
    './nativeEmailPublication': native, './legacyEmailRecoveryReleaseApproval': approval,
    '../persistence/crmLegacyEmailRecoveryStage': {
      async previewExactLegacyEmailRecoveryStagePrivately(transaction, selected) {
        assert.equal(transaction, tx); events.push(['preview', selected])
        return { pins: { ...pins(), ...wrongPreview }, inspectionDigest: hash('inspection') }
      },
      async stageExactLegacyEmailRecoveryPrivately(transaction, selected, signed) {
        assert.equal(transaction, tx); events.push(['stage', selected, signed])
        if (lostAck) throw lostAck
        return receipt
      },
      async resolveExactLegacyEmailStagePrivately(transaction, selected) {
        assert.equal(transaction, tx); events.push(['inspect', selected])
        return inspectUnknown ? { state: 'unknown' } : receipt
      },
    },
  })
  const input = (action = 'stage') => ({ action, target: target(), transaction: tx,
    selection: action === 'stage-preview' ? { holdId: id(3), outboxId: id(4), ...api.nativeEmailRecoveryStagePreviewPins(target()) } : selection(),
    intentHash: action === 'stage-preview' ? undefined : verified.intentHash, approval: action === 'stage' ? verified : undefined })
  return { ...api, input, events, verified, receipt }
}

test('preview commits to one mailbox message, ordered organizations, primary and exact target before DAL', async () => {
  const f = fixture(), request = f.input('stage-preview')
  const parsed = f.parseNativeEmailRecoveryStageTarget(request.target)
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.selected.messageIds) && Object.isFrozen(parsed.expectedOrganizations.nativeIds))
  assert.deepEqual(parsed, request.target)
  assert.notEqual(request.selection.nativeOperationId, request.selection.requestFingerprint)
  const result = await f.runNativeEmailRecoveryPrivateStage(request)
  assert.deepEqual(result, { pins: pins(), inspectionDigest: hash('inspection') })
  assert.deepEqual(f.events, [['preview', parsed]])
  const alternate = { ...request.target, expectedOrganizations: { ...request.target.expectedOrganizations, primaryNativeId: id(9) } }
  assert.notDeepEqual(f.nativeEmailRecoveryStagePreviewPins(alternate), f.nativeEmailRecoveryStagePreviewPins(request.target))
  await assert.rejects(f.runNativeEmailRecoveryPrivateStage({ ...request, target: alternate }), /preview_scope/)
  assert.equal(f.events.length, 1)
})

test('malformed or noncanonical selectors are rejected without accessing caller getters or starting DAL work', async () => {
  const f = fixture(), request = f.input()
  const malformed = [
    { ...target(), extra: 'unrecognized' }, { ...target(), outboxId: target().retiredOutboxId },
    { ...target(), selected: { ...target().selected, messageIds: ['123abc', '456def'] } },
    { ...target(), expectedOrganizations: { primaryNativeId: id(10), nativeIds: [id(10), id(9)] } },
    { ...target(), expectedOrganizations: { primaryNativeId: id(10), nativeIds: [id(10), id(10)] } },
    { ...target(), expectedOrganizations: { primaryNativeId: id(10), nativeIds: [id(9)] } },
    { ...target(), expectedOrganizations: { primaryNativeId: id(10), nativeIds: Array.from({ length: 26 }, (_, index) => id(index + 10)) } },
    { ...target(), selected: { ...target().selected, messageIds: [,'123abc'] } },
  ]
  const accessor = { ...target(), get expectedOrganizations() { assert.fail('must not invoke caller getter') } }
  malformed.push(accessor, new Proxy(target(), { ownKeys() { assert.fail('must not invoke proxy trap') } }))
  for (const candidate of malformed) await assert.rejects(f.runNativeEmailRecoveryPrivateStage({ ...request, target: candidate }))
  assert.deepEqual(f.events, [])
})

test('preview refuses drift or accidental exposure instead of emitting a misleading review', async () => {
  for (const wrongPreview of [{ holdId: id(44) }, { retiredOutboxId: id(44) }, { pipelineId: id(44) }, { attributes: { body: 'private' } }]) {
    const f = fixture({ wrongPreview })
    await assert.rejects(f.runNativeEmailRecoveryPrivateStage(f.input('stage-preview')), /preview_receipt/)
    assert.equal(f.events.length, 1)
  }
})

test('stage requires a verified release bound to every supplied operation and target pin', async () => {
  const f = fixture(), request = f.input()
  await assert.rejects(f.runNativeEmailRecoveryPrivateStage({ ...request, approval: { ...f.verified } }), /unverified/)
  await assert.rejects(f.runNativeEmailRecoveryPrivateStage({ ...request, intentHash: hash('wrong intent') }), /approval_scope/)
  for (const change of [{ nativeOperationId: hash('wrong operation') }, { requestFingerprint: hash('wrong request') }]) {
    await assert.rejects(f.runNativeEmailRecoveryPrivateStage({ ...request, selection: { ...request.selection, ...change } }), /approval_scope/)
  }
  const other = approved({ retiredOutboxId: id(55) })
  await assert.rejects(f.runNativeEmailRecoveryPrivateStage({ ...request, approval: other, intentHash: other.intentHash }), /approval_scope/)
  assert.deepEqual(f.events, [])
  assert.deepEqual(await f.runNativeEmailRecoveryPrivateStage(request), f.receipt)
  assert.deepEqual(f.events, [['stage', target(), f.verified]])
})

test('unknown stage outcomes are never retried; explicit inspect uses the retained receipt pins without a live signature', async () => {
  const lostAck = new Error('stage acknowledgement lost'), f = fixture({ lostAck })
  await assert.rejects(f.runNativeEmailRecoveryPrivateStage(f.input()), error => error === lostAck)
  assert.deepEqual(f.events.map(([action]) => action), ['stage'])
  const request = f.input('stage-inspect')
  await assert.rejects(f.runNativeEmailRecoveryPrivateStage({ ...request, approval: f.verified }), /inspect_scope/)
  assert.deepEqual(await f.runNativeEmailRecoveryPrivateStage(request), f.receipt)
  assert.deepEqual(f.events[1], ['inspect', { holdId: id(3), outboxId: id(4), retiredOutboxId: id(5), intentHash: f.verified.intentHash }])
  const unknown = fixture({ inspectUnknown: true })
  assert.deepEqual(await unknown.runNativeEmailRecoveryPrivateStage(unknown.input('stage-inspect')), { state: 'unknown' })
  assert.deepEqual(unknown.events.map(([action]) => action), ['inspect'])
})
