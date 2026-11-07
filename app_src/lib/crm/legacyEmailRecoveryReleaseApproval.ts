import 'server-only'
import { constants, verify, type KeyObject } from 'node:crypto'
import { types } from 'node:util'
import { nativeEmailCanonicalJson, nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'

type ReleaseProof = {
  version: 1
  purpose: 'clawpilot-private-legacy-email-release-v1'
  keyId: string
  holdId: string
  outboxId: string
  retiredOutboxId: string
  localId: string
  nativeId: string
  globalId: string
  pipelineId: string
  workspaceId: string
  sourceFingerprint: string
  retirementReceiptHash: string
  activationReceiptHash: string
  requestFingerprint: string
  nativeOperationId: string
  issuedAt: number
  expiresAt: number
}

export type LegacyEmailRecoveryReleaseApproval = ReleaseProof & { intentHash: string; approvalHash: string }

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const globalId = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const hash = /^[0-9a-f]{64}(?![\s\S])/u
const keyId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u
const signature = /^[A-Za-z0-9+/]{512}(?![\s\S])/u
const purpose = 'clawpilot-private-legacy-email-release-v1' as const
const identityKeys = ['holdId','outboxId','retiredOutboxId','localId','nativeId','pipelineId','workspaceId'] as const
const fingerprintKeys = ['sourceFingerprint','retirementReceiptHash','activationReceiptHash','requestFingerprint','nativeOperationId'] as const
const intentKeys = [...identityKeys,'globalId',...fingerprintKeys] as const
const proofKeys = ['version','purpose','keyId','globalId','issuedAt','expiresAt',...identityKeys,...fingerprintKeys] as const
const verifiedApprovals = new WeakSet<object>()

function need(value: unknown, code: string): asserts value {
  requireNativeEmail(value, 'legacy_email_recovery_release_' + code)
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'shape')
  need(Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable && 'value' in descriptor
  }), 'shape')
}

function epoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function snapshotKey(value: unknown): KeyObject {
  need(value && !types.isProxy(value) && types.isKeyObject(value), 'trust_anchor')
  // Clone the actual native key. Caller-owned accessors, an overridden export
  // method, or later mutation of the original JS wrapper cannot swap keys.
  let key: KeyObject
  try { key = structuredClone(value) }
  catch { need(false, 'trust_anchor') }
  need(key.type === 'public' && key.asymmetricKeyType === 'rsa'
    && key.asymmetricKeyDetails?.modulusLength === 3072, 'trust_anchor')
  return key
}

/** Verifies one signed release; does not grant database privileges, check the
 * current claim/activation, or authorize re-dispatch after an unknown outcome.
 * The private controller must compare all pins under its locked transaction and
 * enforce the expiry against the database clock before first admission. */
export function verifyLegacyEmailRecoveryReleaseApproval(input: {
  envelope: unknown
  operatorAnchor: { keyId: string; key: KeyObject }
  nowSeconds: number
}): Readonly<LegacyEmailRecoveryReleaseApproval> {
  exact(input, ['envelope','operatorAnchor','nowSeconds'])
  const { envelope, operatorAnchor, nowSeconds } = input
  need(epoch(nowSeconds), 'clock')
  exact(operatorAnchor, ['keyId','key'])
  const trustedId = operatorAnchor.keyId
  need(matches(trustedId, keyId), 'trust_anchor')
  exact(envelope, ['proof','signature'])
  const { proof, signature: wireSignature } = envelope
  exact(proof, proofKeys)
  need(proof.version === 1 && proof.purpose === purpose && proof.keyId === trustedId, 'domain')
  need(identityKeys.every(key => matches(proof[key], uuid)) && matches(proof.globalId, globalId)
    && proof.outboxId !== proof.retiredOutboxId, 'identity')
  need(fingerprintKeys.every(key => matches(proof[key], hash)), 'fingerprint')
  need(epoch(proof.issuedAt) && epoch(proof.expiresAt) && proof.issuedAt <= nowSeconds
    && nowSeconds < proof.expiresAt && proof.expiresAt - proof.issuedAt <= 120, 'expiry')

  const signedProof = Object.fromEntries(proofKeys.map(key => [key, proof[key]])) as ReleaseProof
  const canonical = nativeEmailCanonicalJson(signedProof)
  need(matches(wireSignature, signature) && verify('sha256', Buffer.from(canonical, 'ascii'),
    { key:snapshotKey(operatorAnchor.key), padding:constants.RSA_PKCS1_PADDING }, Buffer.from(wireSignature, 'base64')), 'signature')
  // A new trusted signature may renew the same unadmitted intent. It cannot
  // change any selected row, source, policy or command bound to the hold.
  const intentHash = nativeEmailDigest({ version:1,purpose:'clawpilot-private-legacy-email-release-intent-v1',
    ...Object.fromEntries(intentKeys.map(key=>[key,signedProof[key]])) })
  const approved = Object.freeze({ ...signedProof,intentHash,approvalHash:nativeEmailDigest({proof:signedProof,signature:wireSignature}) })
  verifiedApprovals.add(approved)
  return approved
}

/** Structural casts, serialization and copies cannot mint a verified approval. */
export function assertVerifiedLegacyEmailRecoveryReleaseApproval(value: unknown): asserts value is Readonly<LegacyEmailRecoveryReleaseApproval> {
  need(value && typeof value === 'object' && verifiedApprovals.has(value), 'unverified')
}
