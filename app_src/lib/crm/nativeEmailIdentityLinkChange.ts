import { requireNativeEmail } from './nativeEmailPublication'
import { nativeEmailEligibilityRowJson } from './nativeEmailWorkspaceUserEligibility'
import type { NativeEmailAuthorityIdentityLink } from './nativeEmailAuthorityTransition'

export const NATIVE_EMAIL_IDENTITY_USER_KEYS = ['email','status','suitecrm_user_id','role','permissions','organization_id',
  'reference_code','crm_user_enabled','suitecrm_username'] as const
export type NativeEmailUserIdentityLinkChange = {
  kind: 'user_identity_link_v1'; workspaceId: string; userEmail: string
  actorScope: { workspaceId: string; ancestryJson: string }
  // Derived from the locked actor, every real membership and retained pipeline
  // intent. Native generations are separate and must not enter this preimage.
  contextFingerprint: string
  appUser: { beforeJson: string; afterJson: string }
  nativeIdentity: NativeEmailAuthorityIdentityLink
}
export type NativeEmailUserIdentityLinkRequest = { workspaceId:string;userEmail:string;nativeIdentity:NativeEmailAuthorityIdentityLink }
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/,GU=/^gu(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/
function exact(value: unknown,keys: readonly string[]): asserts value is Record<string,unknown> {
  requireNativeEmail(value && typeof value==='object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort()),'identity_link_change_shape')
}
function json(value: unknown): unknown {
  requireNativeEmail(typeof value==='string' && value.length<=100000,'identity_link_row_invalid')
  let parsed: unknown
  try{parsed=JSON.parse(value)}catch{requireNativeEmail(false,'identity_link_row_invalid')}
  requireNativeEmail(nativeEmailEligibilityRowJson(parsed)===value,'identity_link_row_noncanonical')
  return parsed
}
function userRow(value: unknown) {
  const row=json(value);exact(row,NATIVE_EMAIL_IDENTITY_USER_KEYS)
  requireNativeEmail(typeof row.email==='string' && EMAIL.test(row.email) && row.email===row.email.toLowerCase()
    && ['active','invited','disabled'].includes(String(row.status)) && ['owner','admin','member'].includes(String(row.role))
    && (row.organization_id===null || typeof row.organization_id==='string' && UUID.test(row.organization_id))
    && row.permissions && typeof row.permissions==='object' && !Array.isArray(row.permissions)
    && Object.values(row.permissions).every(value=>typeof value==='boolean')
    && row.crm_user_enabled===true && typeof row.reference_code==='string' && GU.test(row.reference_code),
  'identity_link_user_invalid')
  return row
}
export function normalizeNativeEmailUserIdentityLinkRequest(value:unknown):NativeEmailUserIdentityLinkRequest {
  exact(value,['workspaceId','userEmail','nativeIdentity']);exact(value.nativeIdentity,['userId','globalId','username'])
  requireNativeEmail(typeof value.workspaceId==='string'&&UUID.test(value.workspaceId)&&typeof value.userEmail==='string'
    &&EMAIL.test(value.userEmail)&&value.userEmail===value.userEmail.toLowerCase()
    &&typeof value.nativeIdentity.userId==='string'&&/^[a-z0-9][a-z0-9-]{0,35}(?![\s\S])/i.test(value.nativeIdentity.userId)
    &&typeof value.nativeIdentity.globalId==='string'&&GU.test(value.nativeIdentity.globalId)
    &&value.nativeIdentity.username===value.nativeIdentity.globalId,'identity_link_selection_invalid')
  const result=JSON.parse(JSON.stringify(value)) as NativeEmailUserIdentityLinkRequest
  Object.freeze(result.nativeIdentity);return Object.freeze(result)
}
/** Exact first-link source contract. This pure validator supplies no actor
 * authorization, native identity verification, database write or grant. The
 * source store must reconstruct the complete locked context at every phase. */
export function prepareNativeEmailUserIdentityLinkChange(value: unknown): NativeEmailUserIdentityLinkChange {
  exact(value,['kind','workspaceId','userEmail','actorScope','contextFingerprint','appUser','nativeIdentity'])
  normalizeNativeEmailUserIdentityLinkRequest({workspaceId:value.workspaceId,userEmail:value.userEmail,nativeIdentity:value.nativeIdentity})
  requireNativeEmail(value.kind==='user_identity_link_v1' && typeof value.workspaceId==='string' && UUID.test(value.workspaceId)
    && typeof value.userEmail==='string' && EMAIL.test(value.userEmail) && value.userEmail===value.userEmail.toLowerCase()
    && typeof value.contextFingerprint==='string' && /^[a-f0-9]{64}(?![\s\S])/.test(value.contextFingerprint),
  'identity_link_selection_invalid')
  exact(value.actorScope,['workspaceId','ancestryJson'])
  requireNativeEmail(typeof value.actorScope.workspaceId==='string' && UUID.test(value.actorScope.workspaceId),'identity_link_actor_scope')
  const ancestry=json(value.actorScope.ancestryJson)
  requireNativeEmail(Array.isArray(ancestry) && ancestry.length>0 && ancestry.length<=100,'identity_link_actor_scope')
  const seen=new Set<string>();let previousParent: string|null=null
  ancestry.forEach((entry,index)=>{
    exact(entry,['id','parent_id','is_demo'])
    requireNativeEmail(typeof entry.id==='string' && UUID.test(entry.id) && !seen.has(entry.id)
      && (entry.parent_id===null || typeof entry.parent_id==='string' && UUID.test(entry.parent_id))
      && typeof entry.is_demo==='boolean' && (index===0?entry.id===value.workspaceId:entry.id===previousParent),
    'identity_link_actor_scope')
    seen.add(entry.id);previousParent=entry.parent_id as string|null
  })
  requireNativeEmail(ancestry.at(-1).id===value.actorScope.workspaceId && ancestry[0].is_demo===false
    && ancestry.at(-1).is_demo===false,'identity_link_actor_scope')
  exact(value.appUser,['beforeJson','afterJson']);const before=userRow(value.appUser.beforeJson),after=userRow(value.appUser.afterJson)
  exact(value.nativeIdentity,['userId','globalId','username'])
  requireNativeEmail(typeof value.nativeIdentity.userId==='string' && /^[a-z0-9][a-z0-9-]{0,35}(?![\s\S])/i.test(value.nativeIdentity.userId)
    && value.nativeIdentity.globalId===before.reference_code && value.nativeIdentity.username===before.reference_code
    && before.email===value.userEmail && before.suitecrm_user_id===null && before.suitecrm_username===null
    && after.suitecrm_user_id===value.nativeIdentity.userId && after.suitecrm_username===before.reference_code
    && nativeEmailEligibilityRowJson({...before,suitecrm_user_id:after.suitecrm_user_id,suitecrm_username:after.suitecrm_username})
      ===value.appUser.afterJson,'identity_link_delta_invalid')
  const result=JSON.parse(JSON.stringify(value)) as NativeEmailUserIdentityLinkChange
  Object.freeze(result.actorScope);Object.freeze(result.appUser);Object.freeze(result.nativeIdentity)
  return Object.freeze(result)
}
