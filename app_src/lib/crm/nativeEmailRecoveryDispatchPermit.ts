import 'server-only'
import { constants, sign, type KeyObject } from 'node:crypto'
import { types } from 'node:util'
import { nativeEmailCanonicalJson, prepareNativeEmailPublication, requireNativeEmail,
  type NativeEmailPublicationRequest } from './nativeEmailPublication'

export type NativeEmailRecoveryDispatchAction = 'prepare' | 'publish' | 'resolve'
export type NativeEmailRecoveryWriterFence = Readonly<{fenceEpoch:string;targetFingerprint:string;expiresAt:number}>
type DispatchProof = Readonly<{
  version:1;purpose:'clawpilot-native-email-recovery-dispatch-v1';keyId:string;action:NativeEmailRecoveryDispatchAction;
  operationId:string;requestFingerprint:string;commandHash:string;approvalHash:string;targetFingerprint:string;
  fenceEpoch:string;leaseOwner:string|null;leaseFence:number|null;issuedAt:number;expiresAt:number;
}>
export type NativeEmailRecoveryDispatchPermit = Readonly<{proof:DispatchProof;signature:string}>
type DispatchAuthorization = Readonly<{
  action:NativeEmailRecoveryDispatchAction;request:NativeEmailPublicationRequest;approvalHash:string;
  fence:NativeEmailRecoveryWriterFence;leaseOwner:string|null;leaseFence:number|null;nowSeconds:number;
  authorizationExpiresAt:number;
}>
type DispatchSigner = Readonly<{signPermit(value:DispatchAuthorization):NativeEmailRecoveryDispatchPermit}>
const signers = new WeakSet<object>()
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const HASH=/^[a-f0-9]{64}(?![\s\S])/u
const KEY_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0
const matches=(value:unknown,re:RegExp):value is string=>typeof value==='string'&&re.test(value)
function need(value:unknown,code:string):asserts value { requireNativeEmail(value,'legacy_dispatch_'+code) }

/** Explicit private signer; nothing reads an app environment key, installs a
 * route, or decides whether a database phase or writer fence is authorized.
 * The DAL must attest those independently and only release the result after
 * its transaction commits. Trust is scoped to a pinned maintenance target. */
export function createNativeEmailRecoveryDispatchSigner(options:{keyId:string;key:KeyObject;targetFingerprint:string}):DispatchSigner {
  const {keyId,targetFingerprint,key:sourceKey}=options
  need(matches(keyId,KEY_ID)&&matches(targetFingerprint,HASH)&&!types.isProxy(sourceKey)&&types.isKeyObject(sourceKey),'signer_invalid')
  let key:KeyObject
  try { key=structuredClone(sourceKey) } catch { need(false,'signer_invalid') }
  need(key.type==='private'&&key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails?.modulusLength===3072,'signer_invalid')
  const signer=Object.freeze({signPermit(value:DispatchAuthorization) {
    const {action,request,approvalHash,fence,leaseOwner,leaseFence,nowSeconds,authorizationExpiresAt}=value
    need(['prepare','publish','resolve'].includes(action),'action_invalid')
    need(fence&&fence.targetFingerprint===targetFingerprint&&matches(fence.fenceEpoch,UUID)
      &&positive(fence.expiresAt)&&positive(nowSeconds)&&positive(authorizationExpiresAt),'fence_invalid')
    need(action==='prepare'?leaseOwner===null&&leaseFence===null:matches(leaseOwner,UUID)&&positive(leaseFence),'lease_invalid')
    const normalized=prepareNativeEmailPublication({command:request.command,nativePolicyFingerprint:request.nativePolicyFingerprint,
      allowedReaderSuiteCrmUserIds:request.allowedReaderSuiteCrmUserIds})
    need(normalized.command.version===2&&normalized.command.mode==='publish'&&normalized.command.expectedRecordFingerprint===null
      &&normalized.requestFingerprint===request.requestFingerprint&&normalized.commandHash===request.commandHash
      &&matches(approvalHash,HASH),'request_changed')
    const expiresAt=Math.min(nowSeconds+30,fence.expiresAt,authorizationExpiresAt)
    need(positive(expiresAt)&&expiresAt>nowSeconds,'authorization_expired')
    const proof:DispatchProof=Object.freeze({version:1,purpose:'clawpilot-native-email-recovery-dispatch-v1',keyId,action,
      operationId:normalized.command.operationId,requestFingerprint:normalized.requestFingerprint,commandHash:normalized.commandHash,
      approvalHash,targetFingerprint,fenceEpoch:fence.fenceEpoch,leaseOwner,leaseFence,issuedAt:nowSeconds,expiresAt})
    const signature=sign('sha256',Buffer.from(nativeEmailCanonicalJson(proof),'ascii'),{key,padding:constants.RSA_PKCS1_PADDING}).toString('base64')
    return Object.freeze({proof,signature})
  }})
  signers.add(signer)
  return signer
}

export function assertNativeEmailRecoveryDispatchSigner(value:unknown):asserts value is DispatchSigner {
  need(value&&typeof value==='object'&&signers.has(value),'signer_unverified')
}

/** Must verify/hold both writer sets through the one remote call. A fence
 * epoch in a permit is a binding, not proof that any writer is paused. */
export type NativeEmailRecoveryMaintenanceDispatch = Readonly<{
  signer:DispatchSigner;
  withVerifiedFence:<T>(run:(fence:NativeEmailRecoveryWriterFence)=>Promise<T>)=>Promise<T>;
}>
