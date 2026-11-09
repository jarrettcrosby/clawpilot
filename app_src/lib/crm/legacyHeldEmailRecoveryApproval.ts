import 'server-only'
import { constants, verify, type KeyObject } from 'node:crypto'
import { types } from 'node:util'
import { nativeEmailCanonicalJson, nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'

const purpose='clawpilot-private-legacy-held-email-recovery-v1' as const
const identityKeys=['holdBatchId','outboxId','localId','nativeId','pipelineId','workspaceId','nativeAuthorityInstanceId','lockToken'] as const
const hashKeys=['holdReceiptHash','originalFingerprint','sourceFingerprint','relationshipFingerprint','providerIdentityFingerprint',
  'activationReceiptHash','stagedPayloadFingerprint','requestFingerprint','nativeOperationId'] as const
const intentKeys=[...identityKeys,...hashKeys,'globalId','generation','primaryAccountId','accountIds'] as const
const proofKeys=['version','purpose','keyId','issuedAt','expiresAt',...intentKeys] as const
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const GLOBAL=/^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const HASH=/^[0-9a-f]{64}(?![\s\S])/u
const KEY=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u
const SIGNATURE=/^[A-Za-z0-9+/]{512}(?![\s\S])/u
const approvals=new WeakSet<object>()

type HeldRecoveryIntent = Record<(typeof identityKeys)[number] | (typeof hashKeys)[number],string> & {
  globalId:string; generation:number; primaryAccountId:string; accountIds:readonly string[]
}
type HeldRecoveryProof = HeldRecoveryIntent & {
  version:1; purpose:typeof purpose; keyId:string; issuedAt:number; expiresAt:number
}
export type LegacyHeldEmailRecoveryApproval = Readonly<HeldRecoveryProof & {intentHash:string;approvalHash:string}>

function need(value:unknown,code:string):asserts value {requireNativeEmail(value,'legacy_held_email_recovery_'+code)}
function matches(value:unknown,pattern:RegExp):value is string {return typeof value==='string'&&pattern.test(value)}
function positiveInteger(value:unknown):value is number {return typeof value==='number'&&Number.isSafeInteger(value)&&value>0}
function exact(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown> {
  need(value&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)
    &&[Object.prototype,null].includes(Object.getPrototypeOf(value)),'shape')
  need(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{
    const field=Object.getOwnPropertyDescriptor(value,key)
    return field?.enumerable&&'value' in field
  }),'shape')
}

function exactAccounts(value:unknown,primary:unknown):readonly string[] {
  need(matches(primary,UUID)&&Array.isArray(value)&&!types.isProxy(value)&&Object.getPrototypeOf(value)===Array.prototype
    &&value.length>=1&&value.length<=25&&Reflect.ownKeys(value).length===value.length+1,'accounts')
  const result:string[]=[]
  for(let index=0;index<value.length;index++){
    const field=Object.getOwnPropertyDescriptor(value,String(index))
    need(field?.enumerable&&'value' in field&&matches(field.value,UUID)
      &&(index===0||field.value>result[index-1]),'accounts')
    result.push(field.value)
  }
  need(result.includes(primary),'accounts')
  return Object.freeze(result)
}

/** A held-job approval is distinct from a hold or archive release approval.
 * Its outbox ID is the original ID; there is no caller-supplied replacement
 * ID. The approved Accounts, relationship/provider fingerprints, exact
 * postimage and native command are all bound. The future private controller
 * must verify them under the current database authority, and prove native
 * absence/fencing separately before any admission or dispatch. */
export function verifyLegacyHeldEmailRecoveryApproval(input:{
  envelope:unknown; operatorAnchor:{keyId:string;key:KeyObject}; nowSeconds:number
}):LegacyHeldEmailRecoveryApproval {
  exact(input,['envelope','operatorAnchor','nowSeconds'])
  const {envelope,operatorAnchor,nowSeconds}=input
  need(positiveInteger(nowSeconds),'clock')
  exact(operatorAnchor,['keyId','key'])
  const {keyId,key}=operatorAnchor
  need(matches(keyId,KEY)&&types.isKeyObject(key)&&!types.isProxy(key),'anchor')
  let anchored:KeyObject
  try {anchored=structuredClone(key)} catch {need(false,'anchor')}
  need(anchored.type==='public'&&anchored.asymmetricKeyType==='rsa'&&anchored.asymmetricKeyDetails?.modulusLength===3072,'anchor')
  exact(envelope,['proof','signature'])
  const {proof,signature}=envelope
  exact(proof,proofKeys)
  need(proof.version===1&&proof.purpose===purpose&&proof.keyId===keyId,'domain')
  need(identityKeys.every(k=>matches(proof[k],k==='nativeAuthorityInstanceId'?/^[A-Za-z0-9][A-Za-z0-9-]{0,35}(?![\s\S])/u:UUID))
    &&matches(proof.globalId,GLOBAL)&&positiveInteger(proof.generation),'identity')
  need(hashKeys.every(k=>matches(proof[k],HASH)),'fingerprint')
  const accountIds=exactAccounts(proof.accountIds,proof.primaryAccountId)
  const {issuedAt,expiresAt}=proof
  need(positiveInteger(issuedAt)&&positiveInteger(expiresAt)&&issuedAt<=nowSeconds
    &&nowSeconds<expiresAt&&expiresAt-issuedAt<=120,'expiry')
  const signed={...proof,accountIds} as HeldRecoveryProof
  const canonical=nativeEmailCanonicalJson(signed)
  need(matches(signature,SIGNATURE)&&verify('sha256',Buffer.from(canonical,'ascii'),
    {key:anchored,padding:constants.RSA_PKCS1_PADDING},Buffer.from(signature,'base64')),'signature')
  const intentHash=nativeEmailDigest({version:1,purpose:'clawpilot-private-legacy-held-email-recovery-intent-v1',
    ...Object.fromEntries(intentKeys.map(k=>[k,signed[k]]))})
  const approval=Object.freeze({...signed,intentHash,approvalHash:nativeEmailDigest({proof:signed,signature})})
  approvals.add(approval)
  return approval
}

/** JSON copies or type assertions must never become trusted release input. */
export function assertVerifiedLegacyHeldEmailRecoveryApproval(value:unknown):asserts value is LegacyHeldEmailRecoveryApproval {
  need(value&&typeof value==='object'&&approvals.has(value),'unverified')
}
