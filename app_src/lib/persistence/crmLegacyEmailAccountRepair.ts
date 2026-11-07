import 'server-only'
import { verifyLegacyEmailAccountRepairApproval } from '../crm/legacyEmailAccountRepairApproval'
import { nativeEmailCanonicalJson, requireNativeEmail } from '../crm/nativeEmailPublication'
import type { withTransaction } from './postgres'

type Transaction = typeof withTransaction
type Verification = Parameters<typeof verifyLegacyEmailAccountRepairApproval>[0]
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const hash = /^[a-f0-9]{64}(?![\s\S])/u
const globalId = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const accountReference = /^ga(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const targetKeys = ['outboxId','localId','pipelineId','workspaceId','globalId','nativeId','oldPrimaryId',
  'newPrimaryId','oldPrimaryNativeId','newPrimaryNativeId'] as const
export type LegacyEmailAccountRepairTarget = Readonly<Record<typeof targetKeys[number],string>>
type Pins = Readonly<{ operationId:string; approvalDigest:string; reviewDigest:string }>
const matches=(value:unknown,pattern:RegExp):value is string=>typeof value==='string'&&pattern.test(value)
function need(value:unknown,code:string):asserts value {
  requireNativeEmail(value,'legacy_account_repair_'+code)
}
function exact(value: unknown,keys:readonly string[]):asserts value is Record<string,unknown> {
  need(value&&typeof value==='object'&&!Array.isArray(value)
    && (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)
    && Reflect.ownKeys(value).length===keys.length
    && keys.every(key=>{
      const descriptor=Object.getOwnPropertyDescriptor(value,key)
      return descriptor?.enumerable&&'value' in descriptor
    }),'shape')
}
export function parseLegacyEmailAccountRepairTarget(value:unknown):LegacyEmailAccountRepairTarget {
  // The shared canonical encoder rejects proxies, accessors and non-plain
  // data before any caller-owned object is retained across awaits.
  const data:unknown=JSON.parse(nativeEmailCanonicalJson(value))
  exact(data,targetKeys)
  need(targetKeys.every(key=>matches(data[key],key==='globalId'?globalId:uuid))
    && data.oldPrimaryId!==data.newPrimaryId&&data.oldPrimaryNativeId!==data.newPrimaryNativeId,'target')
  return Object.freeze(data) as LegacyEmailAccountRepairTarget
}
function readPreview(value:unknown,target:LegacyEmailAccountRepairTarget) {
  exact(value,['review','reviewDigest'])
  const {review,reviewDigest}=value
  exact(review,['version','purpose','target','generation','oldPrimaryReference','newPrimaryReference',
    'sourceDigest','outboxDigest','edgeDigest','nextPayloadDigest'])
  need(review.version===1&&review.purpose==='clawpilot-exact-legacy-email-account-repair-review-v1'
    && nativeEmailCanonicalJson(parseLegacyEmailAccountRepairTarget(review.target))===nativeEmailCanonicalJson(target)
    && typeof review.generation==='number'&&Number.isSafeInteger(review.generation)&&review.generation>0
    && matches(review.oldPrimaryReference,accountReference)&&matches(review.newPrimaryReference,accountReference)
    && review.oldPrimaryReference!==review.newPrimaryReference
    && [review.sourceDigest,review.outboxDigest,review.edgeDigest,review.nextPayloadDigest,reviewDigest].every(value=>matches(value,hash)),
  'preview')
  return Object.freeze({review:Object.freeze({...review,target}),reviewDigest:reviewDigest as string,generation:review.generation})
}
function exactReceipt(value:unknown,pins:Pins) {
  exact(value,['state','operationId','reviewDigest','receiptHash'])
  need(value.state==='committed'&&value.operationId===pins.operationId&&value.reviewDigest===pins.reviewDigest
    && matches(value.receiptHash,hash),'receipt')
  return Object.freeze({state:'committed' as const,operationId:pins.operationId,reviewDigest:pins.reviewDigest,receiptHash:value.receiptHash})
}

/** No provider/worker calls or SQL writes. The plan locks exact source rows
 * briefly in a READ COMMITTED transaction; never retain it across review. */
export function previewExactLegacyEmailAccountRepairPrivately(transaction:Transaction,input:LegacyEmailAccountRepairTarget) {
  const target=parseLegacyEmailAccountRepairTarget(input)
  return transaction(async tx=>{
    const result=await tx.query('SELECT crm_legacy_email_retirement.preview_account_repair($1::jsonb) AS result',[target])
    return readPreview(result.rows[0]?.result,target)
  })
}

/** Not a public route. Live use requires independent held writer custody and
 * two separate, pre-provisioned direct DB logins. The fence provider must keep
 * both app/native writers drained through the final COMMIT; a signature or an
 * attestor password alone does not prove that boundary. */
export async function repairExactLegacyEmailAccountsPrivately(input:{
  target:LegacyEmailAccountRepairTarget
  authorization:Omit<Verification,'nowSeconds'>
},deps:{
  attestTransaction:Transaction; repairTransaction:Transaction
  expectedRoles:Readonly<{attestor:string;repair:string}>
  withLiveFence<T>(scope:Readonly<Verification['expected']>,run:()=>Promise<T>):Promise<T>
  retainResolutionPins(pins:Pins):Promise<void>
}) {
  const target=parseLegacyEmailAccountRepairTarget(input.target)
  const expected=Object.freeze(JSON.parse(nativeEmailCanonicalJson(input.authorization.expected)) as Verification['expected'])
  const envelope=JSON.parse(nativeEmailCanonicalJson(input.authorization.envelope)) as unknown
  const operatorAnchor=Object.freeze({keyId:input.authorization.operatorAnchor.keyId,key:structuredClone(input.authorization.operatorAnchor.key)})
  const {attestor,repair}=deps.expectedRoles
  need(typeof attestor==='string'&&typeof repair==='string'&&attestor.length>0&&repair.length>0&&attestor!==repair
    && deps.attestTransaction!==deps.repairTransaction,'role_separation')
  // Refuse malformed approvals before calling the external fence provider;
  // the authorization is independently reverified against the DB clock.
  verifyLegacyEmailAccountRepairApproval({envelope,expected,operatorAnchor,nowSeconds:Math.floor(Date.now()/1000)})
  return deps.withLiveFence(expected,async()=>{
    const pins=await deps.attestTransaction(async tx=>{
      const clock=await tx.query('SELECT session_user AS login,current_user AS role,floor(extract(epoch FROM clock_timestamp()))::bigint AS second')
      const identity=clock.rows[0]
      need(identity?.login===attestor&&identity.role===attestor,'attestor_login')
      const approval=verifyLegacyEmailAccountRepairApproval({envelope,expected,operatorAnchor,nowSeconds:Number(identity.second)})
      const plan=await tx.query('SELECT crm_legacy_email_retirement.preview_account_repair($1::jsonb) AS result',[target])
      const current=readPreview(plan.rows[0]?.result,target)
      need(current.reviewDigest===approval.reviewDigest,'review_changed')
      await tx.query(`INSERT INTO crm_legacy_email_retirement.account_repair_approvals
        (operation_id,generation,review_digest,approval_digest,fence_epoch,expires_at)
        VALUES($1,$2,$3,$4,$5,to_timestamp($6))`,[approval.operationId,current.generation,approval.reviewDigest,
        approval.approvalDigest,approval.fenceEpoch,approval.expiresAt])
      return Object.freeze({operationId:approval.operationId,reviewDigest:approval.reviewDigest,approvalDigest:approval.approvalDigest})
    })
    await deps.retainResolutionPins(pins)
    return deps.repairTransaction(async tx=>{
      const identity=(await tx.query('SELECT session_user AS login,current_user AS role')).rows[0]
      need(identity?.login===repair&&identity.role===repair,'repair_login')
      const result=await tx.query('SELECT crm_legacy_email_retirement.repair_account_links($1::uuid,$2::jsonb,$3) AS result',
        [pins.operationId,target,pins.approvalDigest])
      return exactReceipt(result.rows[0]?.result,pins)
    })
  })
}

/** A timeout or lost COMMIT reply permits only this readback, not retry. */
export function inspectExactLegacyEmailAccountRepairPrivately(transaction:Transaction,input:Pins) {
  const pins=Object.freeze({...input})
  need(matches(pins.operationId,uuid)&&matches(pins.approvalDigest,hash)&&matches(pins.reviewDigest,hash),'receipt_pins')
  return transaction(async tx=>{
    const result=await tx.query('SELECT crm_legacy_email_retirement.read_account_repair($1::uuid,$2) AS result',[pins.operationId,pins.approvalDigest])
    const value=result.rows[0]?.result
    if(value?.state==='unknown'){
      exact(value,['state'])
      return Object.freeze({state:'unknown' as const})
    }
    return exactReceipt(value,pins)
  })
}
