import { constants, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { nativeEmailCanonicalJson, nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'
import { nativeEmailAuthorityReceiptHash, prepareNativeEmailAuthorityCommand, prepareNativeEmailAuthorityTransition,
  verifyNativeEmailAuthorityReceipt, nativeEmailAuthorityPhaseCommand, type NativeEmailGrantAttempt, type NativeEmailAppAuthorityCommitReceipt,
  type NativeEmailAuthorityTransitionRecord } from './nativeEmailAuthorityTransition'

export type NativeEmailAuthorityApprovalProof = {
  purpose: 'clawpilot-native-email-authority-approval'; issuer: 'clawpilot-pg-authority'
  audience: 'clawpilot-suitecrm-authority'; keyId: string; nativeInstanceId: string
  issuedAt: number; expiresAt: number; operationId: string; transitionId: string; planHash: string
  commandHash: string; desiredAppChangeHash: string; phase: 'revoke' | 'grant'
  serviceUserId: string; oauthClientId: string; revokeOperationId: string | null; revokeCommandHash: string | null
  appCommit: NativeEmailAppAuthorityCommitReceipt | null
} & ({version:1}|{version:2;grantAttempt:NativeEmailGrantAttempt})
export type NativeEmailAuthorityApprovalEnvelope = { proof: NativeEmailAuthorityApprovalProof; signature: string }
export interface NativeEmailAuthorityApprovalStore {
  /** A real implementation must lock control -> durable transition, authenticate
   * the original actor/scope, verify exact current authority and immutable plan,
   * and persist the envelope ONCE in that transaction. Existing envelopes are
   * returned byte-for-byte: no renewed expiry. Callback is local CPU only, never
   * provider I/O. A caller-supplied record is not an implementation of this trust
   * boundary. A failed commit must not expose an unpersisted approval. */
  issueApproval(transitionId: string, phase: 'revoke' | 'grant',
    create: (record: NativeEmailAuthorityTransitionRecord) => NativeEmailAuthorityApprovalEnvelope):
      Promise<NativeEmailAuthorityApprovalEnvelope>
}
export type NativeEmailAuthorityIssuerConfig = {
  privateKey: string | KeyObject; keyId: string; nativeInstanceId: string
  serviceUserId: string; oauthClientId: string; ttlSeconds?: number
}
const HASH = /^[a-f0-9]{64}(?![\s\S])/
const ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}(?![\s\S])/
const PROOF_KEYS = ['version','purpose','issuer','audience','keyId','nativeInstanceId','issuedAt','expiresAt',
  'operationId','transitionId','planHash','commandHash','desiredAppChangeHash','phase','serviceUserId','oauthClientId',
  'revokeOperationId','revokeCommandHash','appCommit']
const COMMIT_KEYS = ['version','transitionId','planHash','desiredAppChangeHash','revokeReceiptHash',
  'appAuthorityBeforeFingerprint','appAuthorityAfterFingerprint']
const same = (a: unknown, b: unknown) => nativeEmailCanonicalJson(a) === nativeEmailCanonicalJson(b)
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireNativeEmail(value && typeof value === 'object' && !Array.isArray(value)
    && same(Object.keys(value).sort(), [...keys].sort()), 'authority_approval_shape')
}
function checkedRecord(record: NativeEmailAuthorityTransitionRecord, transitionId: string, phase: 'revoke' | 'grant') {
  requireNativeEmail(record && record.enabled === true && record.plan, 'authority_approval_disabled')
  const { planHash, ...input } = record.plan, plan = prepareNativeEmailAuthorityTransition(input)
  requireNativeEmail(plan.planHash === planHash && plan.revoke.transitionId === transitionId
    && record[phase]?.state === 'prepared' && record[phase]?.receipt === null
    && plan.revoke.pendingPublicationCommand === null, 'authority_approval_phase_not_prepared')
  if (phase === 'revoke') requireNativeEmail(!record.grantAttempt && record.appCommit === null && record.grantApproval === null
    && record.grant.state === 'prepared' && record.grant.receipt === null, 'authority_approval_revoke_changed')
  else {
    requireNativeEmail(record.revoke.state === 'committed' && record.revoke.receipt && record.appCommit,
      'authority_approval_grant_before_commit')
    const receipt = verifyNativeEmailAuthorityReceipt(prepareNativeEmailAuthorityCommand(plan.revoke), record.revoke.receipt)
    const expected = { version:1, transitionId, planHash, desiredAppChangeHash:plan.revoke.desiredAppChangeHash,
      revokeReceiptHash:nativeEmailAuthorityReceiptHash(receipt),
      appAuthorityBeforeFingerprint:plan.expectedAppAuthorityBeforeFingerprint,
      appAuthorityAfterFingerprint:plan.expectedAppAuthorityAfterFingerprint }
    requireNativeEmail(same(record.appCommit, expected), 'authority_approval_app_commit_changed')
    nativeEmailAuthorityPhaseCommand(record,'grant')
  }
  return plan
}
function proofBytes(proof: NativeEmailAuthorityApprovalProof): Buffer {
  const bytes = nativeEmailCanonicalJson(proof)
  requireNativeEmail(bytes.length <= 4096 && !/[^\x20-\x7e]/.test(bytes), 'authority_approval_non_ascii')
  return Buffer.from(bytes, 'ascii')
}

/** No route, activation, environment-key lookup or native call. The private key
 * must be independently provisioned on the trusted application service. Only
 * the verified durable store can supply the record being signed. */
export function createNativeEmailAuthorityApprovalIssuer(store: NativeEmailAuthorityApprovalStore,
  config: NativeEmailAuthorityIssuerConfig, now: () => number = Date.now) {
  config = { ...config }
  requireNativeEmail(store && typeof store.issueApproval === 'function', 'authority_approval_store_required')
  for (const key of ['keyId','nativeInstanceId','serviceUserId','oauthClientId'] as const) {
    requireNativeEmail(typeof config[key] === 'string' && ID.test(config[key])
      && (!['serviceUserId','oauthClientId'].includes(key) || config[key].length <= 36), 'authority_approval_issuer_identity')
  }
  const ttl = config.ttlSeconds ?? 120
  requireNativeEmail(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 300, 'authority_approval_expiry')
  let privateKey: KeyObject
  try { privateKey = typeof config.privateKey === 'string' ? createPrivateKey(config.privateKey) : config.privateKey }
  catch { requireNativeEmail(false, 'authority_approval_private_key_invalid') }
  requireNativeEmail(privateKey! && privateKey!.type === 'private' && privateKey!.asymmetricKeyType === 'rsa'
    && privateKey!.asymmetricKeyDetails?.modulusLength === 3072, 'authority_approval_private_key_invalid')
  const publicKey = createPublicKey(privateKey!)
  const clock = () => {
    const epoch = Math.floor(now() / 1000)
    requireNativeEmail(Number.isSafeInteger(epoch) && epoch > 0, 'authority_approval_clock_invalid')
    return epoch
  }
  const validateEnvelope = (value: NativeEmailAuthorityApprovalEnvelope, transitionId: string, phase: 'revoke' | 'grant') => {
    exact(value, ['proof','signature']); exact(value.proof, [...PROOF_KEYS,...(value.proof?.version===2?['grantAttempt']:[])])
    const p = value.proof
    requireNativeEmail((p.version === 1 || p.version===2 && phase==='grant') && p.purpose === 'clawpilot-native-email-authority-approval'
      && p.issuer === 'clawpilot-pg-authority' && p.audience === 'clawpilot-suitecrm-authority'
      && p.phase === phase && p.transitionId === transitionId, 'authority_approval_proof_identity')
    for (const key of ['keyId','nativeInstanceId','serviceUserId','oauthClientId'] as const)
      requireNativeEmail(p[key] === config[key], 'authority_approval_proof_destination')
    for (const key of ['operationId','transitionId','planHash','commandHash','desiredAppChangeHash'] as const)
      requireNativeEmail(typeof p[key] === 'string' && HASH.test(p[key]), 'authority_approval_hash')
    requireNativeEmail(Number.isSafeInteger(p.issuedAt) && Number.isSafeInteger(p.expiresAt) && p.issuedAt > 0
      && p.issuedAt <= clock() + 30 && p.expiresAt > p.issuedAt && p.expiresAt - p.issuedAt <= 300,
    'authority_approval_expiry')
    if (phase === 'revoke') requireNativeEmail(p.revokeOperationId === null && p.revokeCommandHash === null
      && p.appCommit === null, 'authority_approval_revoke_evidence')
    else {
      requireNativeEmail(typeof p.revokeOperationId === 'string' && HASH.test(p.revokeOperationId)
        && typeof p.revokeCommandHash === 'string' && HASH.test(p.revokeCommandHash), 'authority_approval_revoke_evidence')
      exact(p.appCommit, COMMIT_KEYS)
      requireNativeEmail(p.appCommit.version === 1 && p.appCommit.transitionId === transitionId
        && p.appCommit.planHash === p.planHash && p.appCommit.desiredAppChangeHash === p.desiredAppChangeHash,
      'authority_approval_app_commit_changed')
      for (const key of ['transitionId','planHash','desiredAppChangeHash','revokeReceiptHash',
        'appAuthorityBeforeFingerprint','appAuthorityAfterFingerprint'] as const)
        requireNativeEmail(typeof p.appCommit[key] === 'string' && HASH.test(p.appCommit[key]), 'authority_approval_hash')
    }
    if(p.version===2){
      const a=p.grantAttempt
      exact(a,['ordinal','originalOperationId','originalCommandHash','previousOperationId','previousCommandHash','previousCancellationReceiptHash'])
      requireNativeEmail(Number.isSafeInteger(a.ordinal)&&a.ordinal>0,'authority_grant_attempt_shape')
      for(const key of ['originalOperationId','originalCommandHash','previousOperationId','previousCommandHash','previousCancellationReceiptHash'] as const)
        requireNativeEmail(typeof a[key]==='string'&&HASH.test(a[key]),'authority_approval_hash')
      requireNativeEmail(p.operationId===nativeEmailDigest({version:1,purpose:'clawpilot-native-email-grant-attempt',
        transitionId:p.transitionId,planHash:p.planHash,...a,appCommitFingerprint:nativeEmailDigest(p.appCommit)}),
      'authority_grant_attempt_identity')
    }
    requireNativeEmail(typeof value.signature === 'string' && /^[A-Za-z0-9+/]{512}(?![\s\S])/.test(value.signature)
      && verify('sha256', proofBytes(p as NativeEmailAuthorityApprovalProof),
        { key:publicKey, padding:constants.RSA_PKCS1_PADDING }, Buffer.from(value.signature, 'base64')),
    'authority_approval_signature_invalid')
  }
  return { async issue(transitionId: string, phase: 'revoke' | 'grant') {
    requireNativeEmail(typeof transitionId === 'string' && HASH.test(transitionId)
      && ['revoke','grant'].includes(phase), 'authority_approval_selection')
    const envelope = await store.issueApproval(transitionId, phase, record => {
      const plan = checkedRecord(record, transitionId, phase), command = nativeEmailAuthorityPhaseCommand(record,phase), issuedAt = clock()
      const proof: NativeEmailAuthorityApprovalProof = {
        ...(phase==='grant'&&record.grantAttempt?{version:2 as const,grantAttempt:JSON.parse(nativeEmailCanonicalJson(record.grantAttempt))}:{version:1 as const}),
        purpose:'clawpilot-native-email-authority-approval', issuer:'clawpilot-pg-authority',
        audience:'clawpilot-suitecrm-authority', keyId:config.keyId, nativeInstanceId:config.nativeInstanceId,
        issuedAt, expiresAt:issuedAt + ttl, operationId:command.operationId, transitionId, planHash:plan.planHash,
        commandHash:nativeEmailDigest(command), desiredAppChangeHash:command.desiredAppChangeHash, phase,
        serviceUserId:config.serviceUserId, oauthClientId:config.oauthClientId,
        revokeOperationId:phase === 'grant' ? plan.revoke.operationId : null,
        revokeCommandHash:phase === 'grant' ? nativeEmailDigest(plan.revoke) : null,
        appCommit:phase === 'grant' ? JSON.parse(nativeEmailCanonicalJson(record.appCommit)) : null,
      }
      const created = { proof, signature:sign('sha256', proofBytes(proof),
        { key:privateKey!, padding:constants.RSA_PKCS1_PADDING }).toString('base64') }
      validateEnvelope(created, transitionId, phase)
      return created
    })
    // Existing expired approvals can be inspected/reconciled, never silently
    // renewed here. The native executor independently enforces live expiry.
    validateEnvelope(envelope, transitionId, phase)
    return JSON.parse(nativeEmailCanonicalJson(envelope)) as NativeEmailAuthorityApprovalEnvelope
  } }
}
