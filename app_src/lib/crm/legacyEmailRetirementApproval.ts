import 'server-only'
import { constants, createHash, verify, type KeyObject } from 'node:crypto'
import { types } from 'node:util'
import { nativeEmailCanonicalJson, nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'

/** Verification only. The maintenance controller must acquire and verify a
 * live writer fence separately, recalculate the exact manifest from both
 * stores, and atomically consume the approval with the archive transaction.
 * A signed snapshot cannot create or keep that fence alive. */
export type LegacyEmailRetirementScope = {
  projectId: string; environmentId: string; postgresDatabaseFingerprint: string; appCommit: string
  nativeDeploymentId: string; nativeReplicaId: string; nativeCommit: string; nativeDatabaseFingerprint: string
}
export type LegacyEmailRetirementRow = {
  outboxId: string; localId: string; pipelineId: string; workspaceId: string; nativeId: string; globalId: string
  attempts: 8; rowFingerprint: string; sourceFingerprint: string; payloadFingerprint: string; keyFingerprint: string
}
export type LegacyEmailRetirementManifest = {
  version: 1; action: 'archive_exact_legacy_terminal_rows_only'; operationId: string; scope: LegacyEmailRetirementScope
  publicationDisposition: 'archive_only' | 'reviewed_recovery'
  actorEmail: string; operatorAccountId: string; rootWorkspaceId: string; appGeneration: number
  gateFingerprint: string; appSourceFingerprint: string; fenceEpoch: string
  fenceEvidenceFingerprint: string; nativeAbsenceFingerprint: string
  historicalProviderOutcome: 'unknown'; rows: LegacyEmailRetirementRow[]
}

const fenceDomain = 'clawpilot-legacy-email-fenced-absence-v1'
const reviewDomain = 'clawpilot-legacy-email-retirement-review-v1'
const audience = 'clawpilot-private-legacy-email-retirement-controller'
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const globalId = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const hash = /^[0-9a-f]{64}(?![\s\S])/u
const commit = /^[0-9a-f]{40}(?![\s\S])/u
const keyId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u
const signature = /^[A-Za-z0-9+/]{512}(?![\s\S])/u
const actor = /^[a-z0-9][a-z0-9.!#$%&'*+/=?^_\x60{|}~-]*@[a-z0-9.-]+\.[a-z0-9-]+(?![\s\S])/u
const ascii = /^[\x20-\x7e]+(?![\s\S])/u

function need(value: unknown, code: string): asserts value {
  requireNativeEmail(value, 'legacy_email_retirement_' + code)
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'shape')
  const actual = Reflect.ownKeys(value)
  need(actual.length === keys.length && keys.every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)
    return d?.enumerable && 'value' in d
  }), 'shape')
}
const manifestKeys = ['version','action','operationId','scope','publicationDisposition','actorEmail','operatorAccountId','rootWorkspaceId',
  'appGeneration','gateFingerprint','appSourceFingerprint','fenceEpoch','fenceEvidenceFingerprint','nativeAbsenceFingerprint',
  'historicalProviderOutcome','rows'] as const
const scopeKeys = ['projectId','environmentId','postgresDatabaseFingerprint','appCommit','nativeDeploymentId',
  'nativeReplicaId','nativeCommit','nativeDatabaseFingerprint'] as const
const rowKeys = ['outboxId','localId','pipelineId','workspaceId','nativeId','globalId','attempts',
  'rowFingerprint','sourceFingerprint','payloadFingerprint','keyFingerprint'] as const

export function legacyEmailRetirementManifestDigest(input: unknown) {
  exact(input, manifestKeys)
  need(input.version === 1 && input.action === 'archive_exact_legacy_terminal_rows_only'
    && input.historicalProviderOutcome === 'unknown'
    && (input.publicationDisposition === 'archive_only' || input.publicationDisposition === 'reviewed_recovery'), 'manifest_domain')
  need(matches(input.operationId, uuid) && matches(input.operatorAccountId, uuid) && matches(input.rootWorkspaceId, uuid)
    && matches(input.fenceEpoch, uuid) && matches(input.actorEmail, actor) && input.actorEmail.length <= 254
    && Number.isSafeInteger(input.appGeneration) && Number(input.appGeneration) > 0, 'manifest_identity')
  for (const k of ['gateFingerprint','appSourceFingerprint','fenceEvidenceFingerprint','nativeAbsenceFingerprint']) {
    need(matches(input[k], hash), 'manifest_fingerprint')
  }
  exact(input.scope, scopeKeys)
  for (const k of ['projectId','environmentId','nativeDeploymentId','nativeReplicaId']) need(matches(input.scope[k], uuid), 'scope')
  for (const k of ['appCommit','nativeCommit']) need(matches(input.scope[k], commit), 'scope')
  for (const k of ['postgresDatabaseFingerprint','nativeDatabaseFingerprint']) need(matches(input.scope[k], hash), 'scope')
  need(Array.isArray(input.rows) && input.rows.length >= 1 && input.rows.length <= 25, 'exact_rows')
  // Refuse non-JSON arrays and holes rather than serializing hidden values or
  // accepting an ambiguous order. This is the lock order for the outbox IDs.
  const rows = input.rows
  need(!types.isProxy(rows) && Object.getPrototypeOf(rows) === Array.prototype
    && Reflect.ownKeys(rows).length === rows.length + 1, 'exact_rows')
  let previous = ''
  const identities = new Map(['localId','nativeId','globalId','keyFingerprint'].map(k => [k, new Set<string>()]))
  for (let index = 0; index < rows.length; index++) {
    const d = Object.getOwnPropertyDescriptor(rows, String(index))
    need(d?.enumerable && 'value' in d, 'exact_rows')
    const row: unknown = d.value
    exact(row, rowKeys)
    need(matches(row.outboxId, uuid) && row.outboxId > previous, 'exact_row_order')
    previous = row.outboxId
    for (const k of ['localId','pipelineId','workspaceId','nativeId']) need(matches(row[k], uuid), 'row_identity')
    need(matches(row.globalId, globalId) && row.attempts === 8, 'row_identity')
    for (const k of ['rowFingerprint','sourceFingerprint','payloadFingerprint','keyFingerprint']) need(matches(row[k], hash), 'row_fingerprint')
    for (const [k, seen] of identities) {
      const v = row[k] as string
      need(!seen.has(v), 'duplicate_row_identity')
      seen.add(v)
    }
  }
  return nativeEmailDigest(input)
}

type TrustAnchor = { keyId: string; key: KeyObject }
function snapshotAnchor(anchor: TrustAnchor) {
  exact(anchor, ['keyId','key'])
  const { keyId: id, key } = anchor
  need(matches(id, keyId) && types.isKeyObject(key) && !types.isProxy(key), 'trust_anchor')
  // Verify with the exact key that was fingerprinted, not a second property
  // lookup on caller-owned anchor or key objects.
  let copied: KeyObject
  try {
    copied = structuredClone(key)
  } catch { need(false, 'trust_anchor') }
  need(copied.type === 'public' && copied.asymmetricKeyType === 'rsa' && copied.asymmetricKeyDetails?.modulusLength === 3072, 'trust_anchor')
  return Object.freeze({ keyId:id, key:copied,
    fingerprint:createHash('sha256').update(copied.export({ format:'der', type:'spki' })).digest('hex') })
}
const shared = ['version','purpose','issuer','audience','keyId','operationId','manifestDigest','issuedAt','expiresAt'] as const
function verifiedProof(envelope: unknown, anchor: TrustAnchor, purpose: string, issuer: string, operationId: string,
  digest: string, nowSeconds: number, fenceDigest?: string) {
  exact(envelope, ['proof','signature'])
  const proof = envelope.proof
  exact(proof, fenceDigest ? [...shared, 'fenceEnvelopeDigest'] : shared)
  need(proof.version === 1 && proof.purpose === purpose && proof.issuer === issuer && proof.audience === audience
    && proof.keyId === anchor.keyId && proof.operationId === operationId && proof.manifestDigest === digest
    && (!fenceDigest || proof.fenceEnvelopeDigest === fenceDigest), 'proof_binding')
  need(Number.isSafeInteger(proof.issuedAt) && Number.isSafeInteger(proof.expiresAt)
    && Number(proof.issuedAt) > 0 && Number(proof.issuedAt) <= nowSeconds && nowSeconds < Number(proof.expiresAt)
    && Number(proof.expiresAt) - Number(proof.issuedAt) <= 120, 'proof_expiry')
  const canonical = nativeEmailCanonicalJson(proof)
  need(canonical.length <= 2048 && ascii.test(canonical) && matches(envelope.signature, signature)
    && verify('sha256', Buffer.from(canonical, 'ascii'), { key:anchor.key, padding:constants.RSA_PKCS1_PADDING },
      Buffer.from(envelope.signature, 'base64')), 'signature')
  return { digest:nativeEmailDigest(envelope), issuedAt:Number(proof.issuedAt), expiresAt:Number(proof.expiresAt) }
}

export function verifyLegacyEmailRetirementApproval(input: {
  expectedManifest: LegacyEmailRetirementManifest
  fenceEnvelope: unknown
  operatorEnvelope: unknown
  fenceAnchor: TrustAnchor
  operatorAnchor: TrustAnchor
  /** Trusted controller clock, ideally the observed database clock. */
  nowSeconds: number
}) {
  exact(input, ['expectedManifest','fenceEnvelope','operatorEnvelope','fenceAnchor','operatorAnchor','nowSeconds'])
  const { expectedManifest, fenceEnvelope, operatorEnvelope, fenceAnchor, operatorAnchor, nowSeconds } = input
  need(Number.isSafeInteger(nowSeconds) && nowSeconds > 0, 'clock')
  const fenceKey = snapshotAnchor(fenceAnchor), operatorKey = snapshotAnchor(operatorAnchor)
  need(fenceKey.fingerprint !== operatorKey.fingerprint && fenceKey.keyId !== operatorKey.keyId,
    'distinct_trust_anchors')
  const manifestDigest = legacyEmailRetirementManifestDigest(expectedManifest)
  const operationId = expectedManifest.operationId
  const fence = verifiedProof(fenceEnvelope, fenceKey, fenceDomain, 'clawpilot-crm-fence-attestor',
    operationId, manifestDigest, nowSeconds)
  const approval = verifiedProof(operatorEnvelope, operatorKey, reviewDomain, 'clawpilot-crm-retirement-operator',
    operationId, manifestDigest, nowSeconds, fence.digest)
  need(approval.issuedAt >= fence.issuedAt && approval.expiresAt <= fence.expiresAt, 'approval_window')
  return Object.freeze({ manifestDigest, operationId, fenceEnvelopeDigest:fence.digest, approvalEnvelopeDigest:approval.digest,
    expiresAt:approval.expiresAt, historicalProviderOutcome:'unknown' as const, liveFenceProven:false as const,
    consumed:false as const })
}
