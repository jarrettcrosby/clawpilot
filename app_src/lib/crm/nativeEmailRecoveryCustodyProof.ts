import 'server-only'
import { constants, verify, type KeyObject } from 'node:crypto'
import { types } from 'node:util'
import { nativeEmailCanonicalJson, requireNativeEmail } from './nativeEmailPublication'

export type NativeEmailRecoveryCustodyExpected = Readonly<{
  nonce: string
  phase: 'before' | 'after'
  fenceEpoch: string
  expiresAt: number
  targetFingerprint: string
  storeBindingFingerprint: string
  operationId: string
  requestFingerprint: string
  controllerConfigHash: string
  producerInventoryHash: string
}>

type CustodyEvidence = Readonly<{
  postgresObservationHash: string
  mariaObservationHash: string
  issuedAt: number
}>

const purpose = 'clawpilot-native-email-recovery-custody-v2' as const
const challengePurpose = 'clawpilot-native-email-recovery-custody-challenge-v2' as const
export type NativeEmailRecoveryCustodyChallenge = NativeEmailRecoveryCustodyExpected & Readonly<{
  version: 2
  purpose: typeof challengePurpose
}>
const hash = /^[a-f0-9]{64}(?![\s\S])/u
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const keyId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u
const rsa3072Signature = /^[A-Za-z0-9+/]{512}(?![\s\S])/u
const expectedHashes = ['nonce', 'targetFingerprint', 'storeBindingFingerprint', 'operationId', 'requestFingerprint',
  'controllerConfigHash', 'producerInventoryHash'] as const
const expectedKeys = [...expectedHashes, 'phase', 'fenceEpoch', 'expiresAt'] as const
const evidenceHashes = ['postgresObservationHash', 'mariaObservationHash'] as const
const proofKeys = ['version', 'purpose', 'keyId', 'issuedAt', 'retainedClosure', ...expectedKeys, ...evidenceHashes] as const

function need(value: unknown, code: string): asserts value {
  requireNativeEmail(value, 'legacy_dispatch_custody_' + code)
}

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'shape')
  need(Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    return field?.enumerable && 'value' in field
  }), 'shape')
}

function matches(value: unknown, expression: RegExp): value is string {
  return typeof value === 'string' && expression.test(value)
}

function epoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validExpected(value: Record<string, unknown>): boolean {
  return expectedHashes.every(field => matches(value[field], hash)) && matches(value.fenceEpoch, uuid)
    && (value.phase === 'before' || value.phase === 'after') && epoch(value.expiresAt)
}

/** Strict wire validation, shared by both sides of the local socket. */
export function assertNativeEmailRecoveryCustodyChallenge(value: unknown): asserts value is NativeEmailRecoveryCustodyChallenge {
  exact(value, ['version', 'purpose', ...expectedKeys])
  need(value.version === 2 && value.purpose === challengePurpose, 'challenge_domain')
  need(validExpected(value), 'challenge_binding')
}

/** Wire version/shape only. A receipt is not authenticated until the full
 * verifier below checks the pinned signer and challenge. */
export function assertNativeEmailRecoveryCustodyEnvelopeVersion(value: unknown): asserts value is {
  proof: Record<string, unknown>; signature: unknown
} {
  exact(value, ['proof', 'signature'])
  exact(value.proof, proofKeys)
  need(value.proof.version === 2 && value.proof.purpose === purpose, 'domain')
  need(matches(value.proof.storeBindingFingerprint, hash), 'store_binding')
}

function publicAnchor(value: unknown): KeyObject {
  need(value && !types.isProxy(value) && types.isKeyObject(value), 'trust_anchor')
  let key: KeyObject
  try { key = structuredClone(value) } catch { need(false, 'trust_anchor') }
  need(key.type === 'public' && key.asymmetricKeyType === 'rsa'
    && key.asymmetricKeyDetails?.modulusLength === 3072, 'trust_anchor')
  return key
}

/** Verifies one challenge-bound assertion from an independent custodian. The
 * signature is evidence of its retained closure, not an enforcement mechanism
 * or permission to reopen writers. A caller must supply a fresh unpredictable
 * nonce for every observation request and discard it after that exchange. */
export function verifyNativeEmailRecoveryCustodyProof(input: {
  envelope: unknown
  expected: NativeEmailRecoveryCustodyExpected
  anchor: { keyId: string; key: KeyObject }
  nowSeconds: number
}): CustodyEvidence {
  exact(input, ['envelope', 'expected', 'anchor', 'nowSeconds'])
  const { envelope, expected, anchor, nowSeconds } = input
  need(epoch(nowSeconds), 'clock')
  exact(expected, expectedKeys)
  need(validExpected(expected), 'expected_binding')
  exact(anchor, ['keyId', 'key'])
  need(matches(anchor.keyId, keyId), 'trust_anchor')
  const key = publicAnchor(anchor.key)

  assertNativeEmailRecoveryCustodyEnvelopeVersion(envelope)
  const { proof, signature } = envelope
  need(proof.keyId === anchor.keyId && proof.retainedClosure === true, 'domain')
  need(expectedKeys.every(field => proof[field] === expected[field]), 'binding')
  const { issuedAt, expiresAt, postgresObservationHash, mariaObservationHash } = proof
  need(epoch(issuedAt) && epoch(expiresAt) && issuedAt <= nowSeconds && nowSeconds - issuedAt <= 15
    && nowSeconds < expiresAt && expiresAt - issuedAt <= 900, 'expiry')
  need(matches(postgresObservationHash, hash) && matches(mariaObservationHash, hash), 'observation_hash')
  need(matches(signature, rsa3072Signature) && verify('sha256',
    Buffer.from(nativeEmailCanonicalJson(proof), 'ascii'), { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(signature, 'base64')), 'signature')
  return Object.freeze({ postgresObservationHash, mariaObservationHash, issuedAt })
}
