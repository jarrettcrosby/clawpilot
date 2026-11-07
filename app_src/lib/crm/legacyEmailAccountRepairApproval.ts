import 'server-only'
import { constants, verify, type KeyObject } from 'node:crypto'
import { types } from 'node:util'
import { nativeEmailCanonicalJson, nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'

export type LegacyEmailAccountRepairApprovalScope = Readonly<{
  operationId: string
  reviewDigest: string
  fenceEpoch: string
  targetFingerprint: string
}>

const purpose = 'clawpilot-private-legacy-email-account-repair-v1' as const
type RepairProof = LegacyEmailAccountRepairApprovalScope & Readonly<{
  version: 1
  purpose: typeof purpose
  keyId: string
  issuedAt: number
  expiresAt: number
}>
declare const verifiedAccountRepairApproval: unique symbol
export type LegacyEmailAccountRepairApproval = RepairProof & Readonly<{
  approvalDigest: string
  [verifiedAccountRepairApproval]: true
}>

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const hash = /^[0-9a-f]{64}(?![\s\S])/u
const keyId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u
// RSA-3072 gives 384 bytes, exactly 512 unpadded Base64 characters.
const signature = /^[A-Za-z0-9+/]{512}(?![\s\S])/u
const scopeKeys = ['operationId', 'reviewDigest', 'fenceEpoch', 'targetFingerprint'] as const
const proofKeys = ['version', 'purpose', 'keyId', ...scopeKeys, 'issuedAt', 'expiresAt'] as const
const verifiedApprovals = new WeakSet<object>()

function need(value: unknown, code: string): asserts value {
  requireNativeEmail(value, 'legacy_email_account_repair_' + code)
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'approval_shape')
  need(Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable && 'value' in descriptor
  }), 'approval_shape')
}

function epoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validScope(scope: Record<string, unknown>): boolean {
  return matches(scope.operationId, uuid) && matches(scope.fenceEpoch, uuid)
    && matches(scope.reviewDigest, hash) && matches(scope.targetFingerprint, hash)
}

function snapshotKey(value: unknown): KeyObject {
  need(value && !types.isProxy(value) && types.isKeyObject(value), 'approval_trust_anchor')
  let copied: KeyObject
  // Use the native key handle rather than caller-supplied export or metadata.
  try { copied = structuredClone(value) }
  catch { need(false, 'approval_trust_anchor') }
  need(copied.type === 'public' && copied.asymmetricKeyType === 'rsa'
    && copied.asymmetricKeyDetails?.modulusLength === 3072, 'approval_trust_anchor')
  return copied
}

/** Verify one operator decision for the exact reviewed repair on the pinned
 * target. A valid signature does not prove current database state or a live
 * writer fence. A separate, independently anchored custodian must attest to
 * retained closure; the runner must bind that proof and check consumption and
 * expiry again under the locked database transaction. */
export function verifyLegacyEmailAccountRepairApproval(input: {
  envelope: unknown
  operatorAnchor: { keyId: string; key: KeyObject }
  expected: LegacyEmailAccountRepairApprovalScope
  nowSeconds: number
}): LegacyEmailAccountRepairApproval {
  exact(input, ['envelope', 'operatorAnchor', 'expected', 'nowSeconds'])
  const { envelope, operatorAnchor, expected, nowSeconds } = input
  need(epoch(nowSeconds), 'approval_clock')
  exact(operatorAnchor, ['keyId', 'key'])
  const trustedId = operatorAnchor.keyId
  need(matches(trustedId, keyId), 'approval_trust_anchor')
  exact(expected, scopeKeys)
  need(validScope(expected), 'approval_scope')
  exact(envelope, ['proof', 'signature'])
  const { proof, signature: wireSignature } = envelope
  exact(proof, proofKeys)
  need(proof.version === 1 && proof.purpose === purpose && proof.keyId === trustedId, 'approval_domain')
  need(validScope(proof) && scopeKeys.every(field => proof[field] === expected[field]), 'approval_scope')
  need(epoch(proof.issuedAt) && epoch(proof.expiresAt) && proof.issuedAt <= nowSeconds
    && nowSeconds < proof.expiresAt && proof.expiresAt - proof.issuedAt <= 120, 'approval_expiry')

  const signedProof = Object.fromEntries(proofKeys.map(field => [field, proof[field]])) as RepairProof
  const canonical = nativeEmailCanonicalJson(signedProof)
  need(matches(wireSignature, signature) && verify('sha256', Buffer.from(canonical, 'ascii'),
    { key: snapshotKey(operatorAnchor.key), padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(wireSignature, 'base64')), 'approval_signature')
  const approved = Object.freeze({
    ...signedProof,
    approvalDigest: nativeEmailDigest({ proof: signedProof, signature: wireSignature }),
  }) as LegacyEmailAccountRepairApproval
  verifiedApprovals.add(approved)
  return approved
}

/** Copied, serialized, and structurally cast values cannot assert approval. */
export function assertVerifiedLegacyEmailAccountRepairApproval(value: unknown): asserts value is LegacyEmailAccountRepairApproval {
  need(value && typeof value === 'object' && verifiedApprovals.has(value), 'approval_unverified')
}
