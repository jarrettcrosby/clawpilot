import { requireNativeEmail } from './nativeEmailPublication'
import type { NativeEmailAuthorityCapabilities, NativeEmailAuthorityTransitionPlan } from './nativeEmailAuthorityTransition'

export type NativeEmailWorkspaceUserEligibilityRequest = { workspaceId:string;userEmail:string;action:
  {kind:'status';status:'active'|'disabled'} | {kind:'trash';trashed:boolean} |
  {kind:'access';role:'admin'|'member';permissions:Record<string,boolean>} }
export type NativeEmailWorkspaceUserEligibilityAction = {kind:'status';status:'active'|'disabled'} |
  {kind:'trash';trashed:boolean} | {kind:'access';role:'admin'|'member';permissionsJson:string}
export type NativeEmailWorkspaceUserEligibilityChange = {
  kind:'workspace_user_eligibility_v1';workspaceId:string;userEmail:string;action:NativeEmailWorkspaceUserEligibilityAction
  actorScope:{workspaceId:string;ancestryJson:string}
  pipelineIntentFingerprint:string
  appUser:{beforeJson:string;afterJson:string};membership:{beforeJson:string;afterJson:string}
  demoMembership:null|{beforeJson:string;afterJson:null}
  restoreFrom:null|{transitionId:string;planHash:string}
}
export const NATIVE_EMAIL_USER_AUTHORITY_KEYS=['email','status','suitecrm_user_id','role','permissions','organization_id'] as const
export const NATIVE_EMAIL_MEMBERSHIP_AUTHORITY_KEYS=['user_email','organization_id','status','role','permissions','trashed_at','trashed_by','pre_trash_status'] as const
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const email=/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/
function exact(value:unknown,keys:readonly string[]): asserts value is Record<string,unknown>{
  requireNativeEmail(value&&typeof value==='object'&&!Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort()),'authority_user_change_shape')
}
/** Embedded authority JSON uses its own canonical string, so {} permissions
 * remain distinct from [] without weakening the native command wire format. */
export function nativeEmailEligibilityRowJson(value:unknown):string{
  const sorted=(input:unknown):unknown=>{
    if(Array.isArray(input))return input.map(sorted)
    if(input&&typeof input==='object')return Object.fromEntries(Object.entries(input).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,sorted(item)]))
    requireNativeEmail(input===null||['string','boolean','number'].includes(typeof input),'authority_user_json_invalid')
    return input
  }
  return JSON.stringify(sorted(value))
}
function row(value:unknown,keys:readonly string[]):Record<string,unknown>{
  requireNativeEmail(typeof value==='string'&&value.length<=100000,'authority_user_row_invalid')
  let parsed:unknown
  try{parsed=JSON.parse(value)}catch{requireNativeEmail(false,'authority_user_row_invalid')}
  exact(parsed,keys)
  requireNativeEmail(nativeEmailEligibilityRowJson(parsed)===value,'authority_user_row_noncanonical')
  requireNativeEmail(parsed.permissions&&typeof parsed.permissions==='object'&&!Array.isArray(parsed.permissions)
    && Object.values(parsed.permissions).every(value=>typeof value==='boolean'),'authority_user_permissions_invalid')
  requireNativeEmail(['active','invited','disabled'].includes(String(parsed.status))
    && ['owner','admin','member'].includes(String(parsed.role)),'authority_user_row_invalid')
  return parsed
}
export function normalizeNativeEmailWorkspaceUserEligibilityRequest(value:NativeEmailWorkspaceUserEligibilityRequest){
  exact(value,['workspaceId','userEmail','action'])
  requireNativeEmail(typeof value.workspaceId==='string'&&uuid.test(value.workspaceId)
    && typeof value.userEmail==='string'&&email.test(value.userEmail)&&value.userEmail===value.userEmail.toLowerCase(),'authority_user_request_invalid')
  const input=value.action as Record<string,unknown>
  let action:NativeEmailWorkspaceUserEligibilityAction
  if(input?.kind==='status'){exact(input,['kind','status']);requireNativeEmail(['active','disabled'].includes(String(input.status)),'authority_user_request_invalid')
    action={kind:'status',status:input.status as 'active'|'disabled'}}
  else if(input?.kind==='trash'){exact(input,['kind','trashed']);requireNativeEmail(typeof input.trashed==='boolean','authority_user_request_invalid')
    action={kind:'trash',trashed:input.trashed}}
  else{exact(input,['kind','role','permissions']);requireNativeEmail(input.kind==='access'&&['admin','member'].includes(String(input.role))
      && input.permissions&&typeof input.permissions==='object'&&!Array.isArray(input.permissions)
      && Object.values(input.permissions).every(value=>typeof value==='boolean'),'authority_user_request_invalid')
    action={kind:'access',role:input.role as 'admin'|'member',permissionsJson:nativeEmailEligibilityRowJson(input.permissions)}}
  return {workspaceId:value.workspaceId as string,userEmail:value.userEmail as string,action}
}
export function prepareNativeEmailWorkspaceUserEligibilityChange(value:unknown):NativeEmailWorkspaceUserEligibilityChange{
  exact(value,['kind','workspaceId','userEmail','action','actorScope','pipelineIntentFingerprint','appUser','membership','demoMembership','restoreFrom'])
  requireNativeEmail(value.kind==='workspace_user_eligibility_v1','authority_user_change_unsupported')
  exact(value.actorScope,['workspaceId','ancestryJson'])
  requireNativeEmail(typeof value.actorScope.workspaceId==='string'&&uuid.test(value.actorScope.workspaceId)
    &&typeof value.actorScope.ancestryJson==='string'&&value.actorScope.ancestryJson.length<=20000,'authority_user_actor_scope')
  let ancestry:unknown
  try{ancestry=JSON.parse(value.actorScope.ancestryJson)}catch{requireNativeEmail(false,'authority_user_actor_scope')}
  requireNativeEmail(Array.isArray(ancestry)&&ancestry.length>0&&ancestry.length<=100
    &&nativeEmailEligibilityRowJson(ancestry)===value.actorScope.ancestryJson,'authority_user_actor_scope')
  const seen=new Set<string>()
  for(const [index,node] of ancestry.entries()){
    exact(node,['id','parent_id','is_demo'])
    requireNativeEmail(typeof node.id==='string'&&uuid.test(node.id)&&!seen.has(node.id)
      &&(node.parent_id===null||typeof node.parent_id==='string'&&uuid.test(node.parent_id))
      &&typeof node.is_demo==='boolean'
      &&(index===0?node.id===value.workspaceId:ancestry[index-1].parent_id===node.id),'authority_user_actor_scope')
    seen.add(node.id)
  }
  requireNativeEmail(ancestry.at(-1).id===value.actorScope.workspaceId
    &&ancestry[0].is_demo===false&&ancestry.at(-1).is_demo===false,'authority_user_actor_scope')
  requireNativeEmail(typeof value.pipelineIntentFingerprint==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(value.pipelineIntentFingerprint),'authority_user_intent_invalid')
  const action=value.action as NativeEmailWorkspaceUserEligibilityAction
  let request:NativeEmailWorkspaceUserEligibilityRequest
  if(action?.kind==='access'){
    exact(action,['kind','role','permissionsJson'])
    requireNativeEmail(typeof action.permissionsJson==='string','authority_user_request_invalid')
    let permissions:Record<string,boolean>
    try{permissions=JSON.parse(action.permissionsJson)}catch{requireNativeEmail(false,'authority_user_request_invalid')}
    request={workspaceId:String(value.workspaceId),userEmail:String(value.userEmail),action:{kind:'access',role:action.role,permissions:permissions!}}
  }else request={workspaceId:String(value.workspaceId),userEmail:String(value.userEmail),action}
  requireNativeEmail(nativeEmailEligibilityRowJson(normalizeNativeEmailWorkspaceUserEligibilityRequest(request).action)
    ===nativeEmailEligibilityRowJson(action),'authority_user_request_invalid')
  exact(value.appUser,['beforeJson','afterJson']);exact(value.membership,['beforeJson','afterJson'])
  const before=row(value.appUser.beforeJson,NATIVE_EMAIL_USER_AUTHORITY_KEYS),after=row(value.appUser.afterJson,NATIVE_EMAIL_USER_AUTHORITY_KEYS)
  requireNativeEmail(before.email===value.userEmail&&after.email===value.userEmail
    && typeof before.suitecrm_user_id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,35}(?![\s\S])/.test(before.suitecrm_user_id)
    && nativeEmailEligibilityRowJson({...before,status:after.status})===value.appUser.afterJson,'authority_user_identity_change_unsupported')
  const mb=row(value.membership.beforeJson,NATIVE_EMAIL_MEMBERSHIP_AUTHORITY_KEYS),ma=row(value.membership.afterJson,NATIVE_EMAIL_MEMBERSHIP_AUTHORITY_KEYS)
  requireNativeEmail(mb.user_email===value.userEmail&&ma.user_email===value.userEmail&&mb.organization_id===value.workspaceId
    && ma.organization_id===value.workspaceId&&mb.role!=='owner'&&ma.role!=='owner'
    && value.membership.beforeJson!==value.membership.afterJson,'authority_user_membership_invalid')
  for(const membership of [mb,ma]){
    requireNativeEmail(membership.trashed_at===null?membership.trashed_by===null&&membership.pre_trash_status===null:
      typeof membership.trashed_at==='string'&&Number.isFinite(Date.parse(membership.trashed_at))
      &&typeof membership.trashed_by==='string'&&email.test(membership.trashed_by)&&membership.status==='disabled'
      &&['active','invited','disabled'].includes(String(membership.pre_trash_status)),'authority_user_trash_invalid')
  }
  let expected:Record<string,unknown>
  if(action.kind==='status'){
    requireNativeEmail(mb.trashed_at===null&&!(mb.status==='invited'&&action.status==='active'),'authority_user_status_invalid')
    expected={...mb,status:action.status}
  }else if(action.kind==='access'){
    requireNativeEmail(mb.trashed_at===null,'authority_user_trashed')
    expected={...mb,role:action.role,permissions:JSON.parse(action.permissionsJson)}
  }else if(action.trashed){
    requireNativeEmail(mb.trashed_at===null&&ma.trashed_at!==null,'authority_user_trash_invalid')
    expected={...mb,status:'disabled',pre_trash_status:mb.status,trashed_at:ma.trashed_at,trashed_by:ma.trashed_by}
  }else{
    requireNativeEmail(mb.trashed_at!==null,'authority_user_restore_status_missing')
    expected={...mb,status:mb.pre_trash_status,trashed_at:null,trashed_by:null,pre_trash_status:null}
  }
  requireNativeEmail(nativeEmailEligibilityRowJson(expected)===value.membership.afterJson,'authority_user_action_delta_mismatch')
  if(value.demoMembership!==null){exact(value.demoMembership,['beforeJson','afterJson'])
    const demo=row(value.demoMembership.beforeJson,NATIVE_EMAIL_MEMBERSHIP_AUTHORITY_KEYS)
    requireNativeEmail(value.demoMembership.afterJson===null&&demo.user_email===value.userEmail&&demo.organization_id!==value.workspaceId,'authority_user_demo_invalid')}
  if(value.restoreFrom!==null){exact(value.restoreFrom,['transitionId','planHash'])
    requireNativeEmail(Object.values(value.restoreFrom).every(item=>typeof item==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(item)),'authority_user_restore_provenance')}
  return JSON.parse(JSON.stringify(value)) as NativeEmailWorkspaceUserEligibilityChange
}

/** Access grants provide read access, not invented historical/future write
 * rights. A restoration additionally restores only proven per-record/future
 * rights, never editor defaults across all historical Emails. New Emails
 * during suspension gain reads but no invented historical edit/delete grant. */
export function nativeEmailEligibilityFinalCapabilities(input:{change:NativeEmailWorkspaceUserEligibilityChange;
  restoration:NativeEmailAuthorityTransitionPlan|null;pipelineId:string;emailId:string|null;
  readers:string[];before:NativeEmailAuthorityCapabilities}):NativeEmailAuthorityCapabilities{
  const nativeId=JSON.parse(input.change.appUser.afterJson).suitecrm_user_id as string
  let original:NativeEmailAuthorityCapabilities|null=null
  if(input.change.restoreFrom){
    const plan=input.restoration
    requireNativeEmail(plan&&plan.planHash===input.change.restoreFrom.planHash
      &&plan.revoke.transitionId===input.change.restoreFrom.transitionId,'authority_user_restore_provenance')
    if(input.emailId===null){
      const binding=plan.revoke.bindings.find(pair=>pair.before.pipeline_id===input.pipelineId)?.before
      if(binding&&'capability_policy_json' in binding&&binding.capability_policy_json!==null)
        original=JSON.parse(binding.capability_policy_json as string).futureCreate
    }else original=plan.revoke.capabilities.find(row=>row.emailId===input.emailId&&row.pipelineId===input.pipelineId)?.before??null
  }
  return Object.fromEntries(['view','list','export','edit','delete'].map(surface=>[surface,
    surface==='edit'||surface==='delete'?[...new Set([
      ...input.before[surface].filter(id=>input.readers.includes(id)),
      ...(input.readers.includes(nativeId)&&original?.[surface].includes(nativeId)?[nativeId]:[]),
    ])].sort():[...input.readers]])) as NativeEmailAuthorityCapabilities
}
