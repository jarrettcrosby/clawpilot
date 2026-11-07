#!/usr/bin/env node
// Synthetic keys and inputs only; no database, network or provider activity.
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
  const source = readFileSync(new URL(`../app_src/lib/crm/${name}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(dependency => {
    if (dependency === 'server-only') return {}
    if (dependency === 'node:crypto') return crypto
    if (dependency === 'node:util') return util
    assert.equal(dependency, './nativeEmailPublication')
    return load('nativeEmailPublication')
  }, module, module.exports)
  modules.set(name, module.exports)
  return module.exports
}

const { nativeEmailCanonicalJson: json, nativeEmailDigest: hash } = load('nativeEmailPublication')
const { verifyLegacyEmailAccountRepairApproval: verify, assertVerifiedLegacyEmailAccountRepairApproval: assertVerified }
  = load('legacyEmailAccountRepairApproval')
const operator = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })
const now = 1783404000
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const purpose = 'clawpilot-private-legacy-email-account-repair-v1'
const scope = () => ({
  operationId: uid(1), reviewDigest: hash('review'), fenceEpoch: uid(2), targetFingerprint: hash('target'),
})
const proof = changes => ({
  version: 1, purpose, keyId: 'repair-review', ...scope(), issuedAt: now - 1, expiresAt: now + 30, ...changes,
})
const sign = (p, key = operator.privateKey) => ({
  proof: p,
  signature: crypto.sign('sha256', Buffer.from(json(p), 'ascii'), {
    key, padding: crypto.constants.RSA_PKCS1_PADDING,
  }).toString('base64'),
})
const request = (envelope = sign(proof()), expected = scope()) => ({
  envelope, expected, operatorAnchor: { keyId: 'repair-review', key: operator.publicKey }, nowSeconds: now,
})
const hasCode = code => error => error.code === 'legacy_email_account_repair_approval_' + code
const rejects = (value, code) => assert.throws(() => verify(value), hasCode(code))

test('exact approved repair is canonical, immutable, detached, and runtime-branded', () => {
  const r = request(), p = r.envelope.proof, approved = verify(r)
  assert.deepEqual(approved, { ...p, approvalDigest: hash(r.envelope) })
  assert.ok(Object.isFrozen(approved))
  assert.doesNotThrow(() => assertVerified(approved))
  assert.deepEqual(verify(request({
    signature: r.envelope.signature, proof: Object.fromEntries(Object.entries(p).reverse()),
  }, Object.assign(Object.create(null), scope()))), approved)
  r.expected.reviewDigest = hash('changed expected review')
  p.reviewDigest = hash('changed signed review')
  r.envelope.signature = 'replaced'
  assert.equal(approved.reviewDigest, hash('review'))
  assert.throws(() => { approved.reviewDigest = hash('write') }, TypeError)
  for (const forged of [{ ...approved }, structuredClone(approved), new Proxy(approved, {}), null, true])
    assert.throws(() => assertVerified(forged), hasCode('unverified'))
})

test('review, action, target, operation and retained fence are pinned', () => {
  const replaced = {
    operationId: uid(11), reviewDigest: hash('other review'), fenceEpoch: uid(12), targetFingerprint: hash('other target'),
  }
  const r = request()
  for (const [field, value] of Object.entries(replaced)) {
    const replacementProof = { ...r.envelope.proof, [field]: value }
    const replacementScope = { ...r.expected, [field]: value }
    rejects(request(sign(replacementProof)), 'scope')
    rejects(request({ ...r.envelope, proof: replacementProof }, replacementScope), 'signature')
    assert.notEqual(verify(request(sign(replacementProof), replacementScope)).approvalDigest,
      verify(r).approvalDigest)
  }
  rejects(request(sign(proof({ purpose: 'clawpilot-private-legacy-email-release-v1' }))), 'domain')
  rejects(request(sign(proof({ version: 2 }))), 'domain')
  rejects(request(sign(proof({ keyId: 'untrusted-reviewer' }))), 'domain')
})

test('only a present, positive safe-integer approval window of at most 120 seconds is accepted', () => {
  const approved = verify(request(sign(proof({ issuedAt: now, expiresAt: now + 120 }))))
  assert.equal(approved.issuedAt, now)
  assert.equal(approved.expiresAt, now + 120)
  for (const dates of [{ issuedAt: now + 1 }, { expiresAt: now }, { expiresAt: now + 120 },
    { issuedAt: 0 }, { issuedAt: '1783403999' }, { expiresAt: '1783404120' }]) {
    rejects(request(sign(proof(dates))), 'expiry')
  }
  for (const nowSeconds of [0, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, String(now)]) {
    rejects({ ...request(), nowSeconds }, 'clock')
  }
})

test('uses exactly the anchored public RSA-3072 key and no caller-owned key methods', () => {
  rejects(request(sign(proof(), other.privateKey)), 'signature')
  const anchor = key => ({ ...request(), operatorAnchor: { keyId: 'repair-review', key } })
  rejects(anchor(operator.privateKey), 'trust_anchor')
  rejects(anchor(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey), 'trust_anchor')
  rejects(anchor(crypto.generateKeyPairSync('ed25519').publicKey), 'trust_anchor')
  const wrapped = structuredClone(operator.publicKey)
  let reads = 0
  for (const key of ['export', 'type', 'asymmetricKeyType', 'asymmetricKeyDetails']) {
    Object.defineProperty(wrapped, key, { get() { reads++; throw Error('must not read override') } })
  }
  const trusted = anchor(wrapped)
  assert.doesNotThrow(() => verify(trusted))
  rejects({ ...trusted, envelope: sign(proof(), other.privateKey) }, 'signature')
  assert.equal(reads, 0)
})

test('rejects malformed signatures, malformed pins, extra or hidden fields, proxies and accessors', () => {
  const r = request()
  rejects({ ...r, extra: true }, 'shape')
  rejects({ ...r, expected: { ...r.expected, extra: true } }, 'shape')
  rejects({ ...r, envelope: { ...r.envelope, [Symbol('hidden')]: true } }, 'shape')
  rejects({ ...r, envelope: { ...r.envelope, proof: { ...r.envelope.proof, issuer: 'extra' } } }, 'shape')
  rejects({ ...r, expected: Object.assign(Object.create({ inherited: true }), r.expected) }, 'shape')
  rejects({ ...r, expected: new Proxy(r.expected, { ownKeys() { throw Error('must not inspect proxy') } }) }, 'shape')
  let reads = 0
  const accessor = { ...r.envelope.proof }
  Object.defineProperty(accessor, 'fenceEpoch', { enumerable: true, get() { reads++; return uid(2) } })
  rejects({ ...r, envelope: { ...r.envelope, proof: accessor } }, 'shape')
  assert.equal(reads, 0)
  rejects(request(sign(proof({ fenceEpoch: uid(2) + '\n' }))), 'scope')
  rejects(request(sign(proof({ targetFingerprint: 'F'.repeat(64) }))), 'scope')
  for (const signature of [r.envelope.signature + '\n', r.envelope.signature.slice(0, -1) + '=',
    'A'.repeat(512), 'A'.repeat(511)]) {
    rejects({ ...r, envelope: { ...r.envelope, signature } }, 'signature')
  }
})
