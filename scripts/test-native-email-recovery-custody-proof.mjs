#!/usr/bin/env node
// Synthetic custody assertions and keys only; no database or network.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as util from 'node:util'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(new URL('../app_src/lib/crm/' + name + '.ts', import.meta.url), 'utf8')
  const emitted = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const m = { exports: {} }
  new Function('require', 'module', 'exports', emitted)(dependency => {
    if (dependency === 'server-only') return {}
    if (dependency === 'node:crypto') return crypto
    if (dependency === 'node:util') return util
    assert.equal(dependency, './nativeEmailPublication')
    return load('nativeEmailPublication')
  }, m, m.exports)
  modules.set(name, m.exports)
  return m.exports
}

const { nativeEmailCanonicalJson: json, nativeEmailDigest: hash } = load('nativeEmailPublication')
const { verifyNativeEmailRecoveryCustodyProof: verify } = load('nativeEmailRecoveryCustodyProof')
const custodian = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })
const now = 1783404000
const uuid = '00000000-0000-4000-8000-000000000001'
const expected = () => ({ nonce: hash('nonce'), phase: 'before', fenceEpoch: uuid, expiresAt: now + 300,
  targetFingerprint: hash('target'), storeBindingFingerprint: hash('target stores'), operationId: hash('operation'), requestFingerprint: hash('request'),
  controllerConfigHash: hash('config'), producerInventoryHash: hash('inventory') })
const proof = () => ({ version: 2, purpose: 'clawpilot-native-email-recovery-custody-v2', keyId: 'custody-independent',
  issuedAt: now - 3, retainedClosure: true, postgresObservationHash: hash('pg'), mariaObservationHash: hash('maria'), ...expected() })
const sign = (value, key = custodian.privateKey) => ({ proof: value, signature: crypto.sign('sha256', Buffer.from(json(value), 'ascii'),
  { key, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64') })
const input = (envelope = sign(proof())) => ({ envelope, expected: expected(),
  anchor: { keyId: 'custody-independent', key: custodian.publicKey }, nowSeconds: now })
const held = (value, code) => assert.throws(() => verify(value), error => error.code === 'legacy_dispatch_custody_' + code)

test('returns only frozen observation digests and issue time from canonical signed evidence', () => {
  const r = input(), reversed = Object.fromEntries(Object.entries(r.envelope.proof).reverse())
  const evidence = verify({ ...r, envelope: { signature: r.envelope.signature, proof: reversed } })
  assert.ok(Object.isFrozen(evidence))
  assert.deepEqual(evidence, { postgresObservationHash: hash('pg'), mariaObservationHash: hash('maria'), issuedAt: now - 3 })
  reversed.postgresObservationHash = hash('changed')
  assert.equal(evidence.postgresObservationHash, hash('pg'))
})

test('even correctly signed assertions cannot cross nonce, phase, window, target, stores, operation, request, configuration or inventory', () => {
  const changes = { nonce: hash('new nonce'), phase: 'after', fenceEpoch: '00000000-0000-4000-8000-000000000002',
    expiresAt: now + 299, targetFingerprint: hash('other target'), storeBindingFingerprint: hash('other stores'), operationId: hash('other operation'),
    requestFingerprint: hash('other request'), controllerConfigHash: hash('other config'), producerInventoryHash: hash('other inventory') }
  const r = input()
  for (const [field, change] of Object.entries(changes)) {
    held(input(sign({ ...proof(), [field]: change })), 'binding')
    held({ ...r, expected: { ...r.expected, [field]: change } }, 'binding')
  }
  const after = { ...expected(), phase: 'after', nonce: hash('fresh after nonce') }
  const envelope = sign({ ...proof(), ...after })
  assert.doesNotThrow(() => verify({ ...r, expected: after, envelope }))
  held({ ...r, expected: after }, 'binding')
})

test('signed assertions require independent pinned RSA-3072 identity, domain, and retained closure', () => {
  held(input(sign(proof(), other.privateKey)), 'signature')
  const r = input()
  held({ ...r, anchor: { ...r.anchor, key: custodian.privateKey } }, 'trust_anchor')
  const short = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  held({ ...r, anchor: { ...r.anchor, key: short.publicKey } }, 'trust_anchor')
  held(input(sign({ ...proof(), keyId: 'other-custodian' })), 'domain')
  held(input(sign({ ...proof(), purpose: 'clawpilot-native-email-recovery-dispatch-v1' })), 'domain')
  held(input(sign({ ...proof(), retainedClosure: false })), 'domain')
  held(input(sign({ ...proof(), version: 1 })), 'domain')
  held(input(sign({ ...proof(), purpose: 'clawpilot-native-email-recovery-custody-v1' })), 'domain')
  const legacy = { ...proof(), version: 1, purpose: 'clawpilot-native-email-recovery-custody-v1' }
  delete legacy.storeBindingFingerprint
  held(input(sign(legacy)), 'shape')
  held({ ...r, envelope: { ...r.envelope, signature: r.envelope.signature + '\n' } }, 'signature')
  const wrapped = structuredClone(custodian.publicKey)
  let reads = 0
  for (const field of ['type', 'asymmetricKeyType', 'asymmetricKeyDetails', 'export']) {
    Object.defineProperty(wrapped, field, { get() { reads++; throw Error('not a trusted key property') } })
  }
  assert.doesNotThrow(() => verify({ ...r, anchor: { ...r.anchor, key: wrapped } }))
  assert.equal(reads, 0)
})

test('enforces fresh non-future observation, a strictly live expiry, and a window of at most fifteen minutes', () => {
  for (const issuedAt of [now - 15, now]) {
    const expiresAt = issuedAt + 900
    const r = input(sign({ ...proof(), issuedAt, expiresAt }))
    assert.equal(verify({ ...r, expected: { ...r.expected, expiresAt } }).issuedAt, issuedAt)
  }
  for (const issuedAt of [now - 16, now + 1, 0]) held(input(sign({ ...proof(), issuedAt })), 'expiry')
  for (const expiresAt of [now, now - 1, now + 898]) {
    const r = input(sign({ ...proof(), expiresAt }))
    held({ ...r, expected: { ...r.expected, expiresAt } }, 'expiry')
  }
  for (const nowSeconds of [0, NaN, 1.5, String(now)]) held({ ...input(), nowSeconds }, 'clock')
})

test('observations are strict digests covered by the signature; malformed shapes do not invoke accessors or proxy traps', () => {
  const r = input()
  for (const field of ['postgresObservationHash', 'mariaObservationHash']) {
    held(input({ ...r.envelope, proof: { ...r.envelope.proof, [field]: hash('forged') } }), 'signature')
    held(input(sign({ ...proof(), [field]: 'F'.repeat(64) })), 'observation_hash')
  }
  held({ ...r, expected: { ...r.expected, nonce: r.expected.nonce + '\n' } }, 'expected_binding')
  held(input(sign({ ...proof(), storeBindingFingerprint: 'F'.repeat(64) })), 'store_binding')
  const noBinding = { ...r.expected }
  delete noBinding.storeBindingFingerprint
  held({ ...r, expected: noBinding }, 'shape')
  held(input({ ...r.envelope, proof: { ...proof(), [Symbol('not signed')]: true } }), 'shape')
  held({ ...r, anchor: { ...r.anchor, extra: true } }, 'shape')
  let calls = 0
  const throwTrap = () => { calls++; throw Error('untrusted trap') }
  held(input({ ...r.envelope, proof: new Proxy(proof(), { get: throwTrap, ownKeys: throwTrap }) }), 'shape')
  const accessor = { ...proof() }
  Object.defineProperty(accessor, 'retainedClosure', { enumerable: true, get: throwTrap })
  held(input({ ...r.envelope, proof: accessor }), 'shape')
  assert.equal(calls, 0)
})
