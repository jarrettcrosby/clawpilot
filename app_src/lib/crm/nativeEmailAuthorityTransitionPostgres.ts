import { nativeEmailCanonicalJson, nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'
import { prepareNativeEmailAuthorityCommand, prepareNativeEmailAuthorityTransition, verifyNativeEmailAuthorityReceipt,
  nativeEmailAuthorityReceiptHash, nativeEmailAuthorityPhaseCommand, type NativeEmailGrantAttempt,
  type NativeEmailAuthorityClaim, type NativeEmailAuthorityReceipt, type NativeEmailAuthorityCapabilities,
  type NativeEmailAuthorityTransitionInput, type NativeEmailAuthorityTransitionPlan, type NativeEmailAuthorityTransitionRecord,
  type NativeEmailAuthorityTransitionStore, type NativeEmailAppAuthorityCommitReceipt } from './nativeEmailAuthorityTransition'
import type { NativeEmailSqlClient, NativeEmailSqlTransaction } from './nativeEmailPublicationPostgres'
import type { NativeEmailAuthorityApprovalEnvelope, NativeEmailAuthorityApprovalStore } from './nativeEmailAuthorityApproval'
import { verifyNativeEmailAuthorityApprovalReadback } from './nativeEmailAuthorityTransport'
import { prepareNativeEmailCapabilityContract, type NativeEmailCapabilityContract } from './nativeEmailCapabilityContract'
import { nativeEmailPrincipalIsEligible, nativeEmailEffectivePipelinePrincipals, nativeEmailManualPipelinePrincipals,
  nativeEmailEffectiveRoleChanges, type NativeEmailRootReaderProjection } from './nativeEmailEligibility'
import { collectNativeEmailRootSourcesWithClient, projectNativeEmailRootReaders,
  collectNativeEmailRootRegistryPreviewWithClient, prepareRootEmployeeCrmRegistryChange } from './nativeEmailRootReaders'
import type { RootEmployeeCrmRegistryChange } from './rootEmployeeCrmRegistryChange'
import { NATIVE_EMAIL_IDENTITY_USER_KEYS, normalizeNativeEmailUserIdentityLinkRequest, prepareNativeEmailUserIdentityLinkChange,
  type NativeEmailUserIdentityLinkChange } from './nativeEmailIdentityLinkChange'
import { prepareNativeEmailWorkspaceUserEligibilityChange, normalizeNativeEmailWorkspaceUserEligibilityRequest,
  nativeEmailEligibilityRowJson, nativeEmailEligibilityFinalCapabilities, NATIVE_EMAIL_USER_AUTHORITY_KEYS, NATIVE_EMAIL_MEMBERSHIP_AUTHORITY_KEYS,
  type NativeEmailWorkspaceUserEligibilityChange, type NativeEmailWorkspaceUserEligibilityRequest } from './nativeEmailWorkspaceUserEligibility'

type Phase = 'revoke' | 'grant'
type JsonRow = Record<string, unknown>
export type NativeEmailPipelineMemberRow = { pipeline_id:string; user_email:string; access_role:'viewer'|'editor';
  shared_by:string|null; created_at:string; updated_at:string }
export type NativeEmailPipelineMemberChange = { kind:'pipeline_members_v1';
  changes:Array<{before:NativeEmailPipelineMemberRow|null; after:NativeEmailPipelineMemberRow|null}> }
export type NativeEmailAppAuthorityChange = NativeEmailPipelineMemberChange | NativeEmailWorkspaceUserEligibilityChange | NativeEmailUserIdentityLinkChange | RootEmployeeCrmRegistryChange
export function prepareNativeEmailAppAuthorityChange(value:unknown):NativeEmailAppAuthorityChange {
  if(value&&typeof value==='object'){
    if((value as JsonRow).kind==='root_registry_v1')return prepareRootEmployeeCrmRegistryChange(value)
    if((value as JsonRow).kind==='workspace_user_eligibility_v1')return prepareNativeEmailWorkspaceUserEligibilityChange(value)
    if((value as JsonRow).kind==='user_identity_link_v1')return prepareNativeEmailUserIdentityLinkChange(value)
  }
  return prepareNativeEmailPipelineMemberChange(value)
}
export type NativeEmailAuthorityPostgresOptions = { actorEmail:string; actorWorkspaceId?:string; leaseSeconds?:number;
  approvalIdentity:{keyId:string;nativeInstanceId:string;serviceUserId:string;oauthClientId:string} }
const same = (a:unknown,b:unknown) => nativeEmailCanonicalJson(a) === nativeEmailCanonicalJson(b)
const HASH=/^[a-f0-9]{64}(?![\s\S])/, UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/
function exact(value:unknown,keys:string[]): asserts value is JsonRow {
  requireNativeEmail(value && typeof value==='object' && !Array.isArray(value)
    && same(Object.keys(value).sort(),[...keys].sort()),'authority_pg_shape')
}
function immutable<T>(value:T):T {
  if(value && typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value)}
  return value
}
function clone<T>(value:T):T { return JSON.parse(nativeEmailCanonicalJson(value)) as T }
/** Snapshot JSON is not the PHP wire command. Encode object/array identity
 * explicitly so legitimate empty permission objects retain their meaning
 * without weakening the wire canonicalizer's empty-object rejection. */
export function encodeNativeEmailAuthoritySnapshotJson(value:unknown):unknown {
  if(value===null)return ['null']
  if(Array.isArray(value))return ['array',value.map(encodeNativeEmailAuthoritySnapshotJson)]
  if(typeof value==='object')return ['object',Object.entries(value as JsonRow).sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([name,item])=>[name,encodeNativeEmailAuthoritySnapshotJson(item)])]
  requireNativeEmail(['string','number','boolean'].includes(typeof value)
    && (typeof value!=='number'||Number.isFinite(value)),'authority_snapshot_json_invalid')
  return [typeof value,value]
}
const key=(row:NativeEmailPipelineMemberRow)=>row.pipeline_id+'\0'+row.user_email
export function prepareNativeEmailPipelineMemberChange(value:unknown):NativeEmailPipelineMemberChange {
  exact(value,['kind','changes'])
  requireNativeEmail(value.kind==='pipeline_members_v1' && Array.isArray(value.changes)
    && value.changes.length>0 && value.changes.length<=100,'authority_member_change_unsupported')
  let previous=''
  for(const change of value.changes){
    exact(change,['before','after'])
    requireNativeEmail(change.before!==null||change.after!==null,'authority_member_empty_change')
    for(const row of [change.before,change.after].filter(value=>value!==null)){
      exact(row,['pipeline_id','user_email','access_role','shared_by','created_at','updated_at'])
      requireNativeEmail(typeof row.pipeline_id==='string' && UUID.test(row.pipeline_id)
        && typeof row.user_email==='string' && EMAIL.test(row.user_email) && row.user_email===row.user_email.toLowerCase()
        && ['viewer','editor'].includes(String(row.access_role))
        && (row.shared_by===null || typeof row.shared_by==='string' && EMAIL.test(row.shared_by))
        && ['created_at','updated_at'].every(field=>typeof row[field]==='string' && Number.isFinite(Date.parse(row[field] as string))),
      'authority_member_row_invalid')
    }
    const row=change.before ?? change.after
    if(change.before!==null && change.after!==null){
      const before=change.before as NativeEmailPipelineMemberRow,after=change.after as NativeEmailPipelineMemberRow
      requireNativeEmail(before.access_role!==after.access_role
        && same({...before,access_role:after.access_role,updated_at:after.updated_at},after)
        && Date.parse(after.updated_at)>=Date.parse(before.updated_at),'authority_member_role_change_invalid')
    }
    const next=key(row as NativeEmailPipelineMemberRow)
    requireNativeEmail(next>previous,'authority_member_change_order');previous=next
  }
  return immutable(clone(value) as NativeEmailPipelineMemberChange)
}
type Scope = {pipeline:JsonRow;workspace:JsonRow;principals:JsonRow[];members:NativeEmailPipelineMemberRow[];
  rootReaders?:NativeEmailRootReaderProjection[]}
type Snapshot={version:1;pipelines:Scope[];emails:Array<{emailId:string;globalId:string;pipelineId:string}>;lifecycle?:JsonRow;registry?:unknown}
type Stored={control:JsonRow;row:JsonRow;phases:Record<Phase,JsonRow>;record:NativeEmailAuthorityTransitionRecord}
const projectionSql=(alias:string,keys:readonly string[])=>`jsonb_build_object(${keys.map(key=>`'${key}',${alias}.${key}`).join(',')})`
const userEligibility=(user:JsonRow,membership:JsonRow)=>nativeEmailPrincipalIsEligible({email:user.email,status:user.status,
  suitecrm_user_id:user.suitecrm_user_id,native_identity_count:1,membership_status:membership.status,
  membership_role:membership.role,membership_permissions:membership.permissions,membership_trashed_at:membership.trashed_at})

/** Internal exact-authority adapter; no activation. An active workspace owner
 * who also owns each changed pipeline can authorize exact membership/role changes.
 * Typed workspace eligibility changes independently recheck the scoped user
 * administrator and retain pipeline membership intent and restoration evidence.
 * Native identity provisioning and pipeline-owner changes remain explicit
 * unsupported holds. Cancelled grants use append-only exact retries.
 * Native full-binding/ACL
 * coverage is independently verified by the native executor; PostgreSQL checks
 * all locally known published Email identities, never an invented native audit. */
export class PostgresNativeEmailAuthorityTransitionStore implements NativeEmailAuthorityTransitionStore, NativeEmailAuthorityApprovalStore {
  private readonly options:NativeEmailAuthorityPostgresOptions
  private readonly leaseSeconds:number
  constructor(private readonly transaction:NativeEmailSqlTransaction,options:NativeEmailAuthorityPostgresOptions,
    private readonly appCommitEffects?:(tx:NativeEmailSqlClient,change:NativeEmailAppAuthorityChange)=>Promise<void>){
    requireNativeEmail(typeof options.actorEmail==='string' && EMAIL.test(options.actorEmail)
      && options.actorEmail===options.actorEmail.toLowerCase(),'authority_actor_invalid')
    requireNativeEmail(options.actorWorkspaceId===undefined||typeof options.actorWorkspaceId==='string'
      && UUID.test(options.actorWorkspaceId),'authority_actor_workspace_invalid')
    this.leaseSeconds=options.leaseSeconds??120
    requireNativeEmail(Number.isInteger(this.leaseSeconds) && this.leaseSeconds>=1 && this.leaseSeconds<=300,'authority_lease_bound')
    exact(options.approvalIdentity,['keyId','nativeInstanceId','serviceUserId','oauthClientId'])
    for(const value of Object.values(options.approvalIdentity))requireNativeEmail(typeof value==='string'
      && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}(?![\s\S])/.test(value),'authority_approval_identity')
    this.options=immutable(clone(options))
  }
  private async control(tx:NativeEmailSqlClient){
    const result=await tx.query('SELECT *,extract(epoch FROM clock_timestamp())::double precision AS now_epoch FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
    requireNativeEmail(result.rows.length===1,'authority_control_missing');return result.rows[0]
  }
  private active(control:JsonRow,plan:NativeEmailAuthorityTransitionPlan){
    requireNativeEmail(control.enabled===true && control.active_transition_id===plan.revoke.transitionId
      && control.active_operation_id===null && Number(control.verified_generation)===Number(control.generation),
    'authority_transition_not_active')
  }
  private async userState(tx:NativeEmailSqlClient,email:string){
    const users=await tx.query(`SELECT ${projectionSql('u',NATIVE_EMAIL_USER_AUTHORITY_KEYS)} AS authority,
      (SELECT count(*)::int FROM app_users duplicate WHERE duplicate.suitecrm_user_id=u.suitecrm_user_id) AS identity_count
      FROM app_users u WHERE email=$1`,[email])
    requireNativeEmail(users.rows.length===1,'authority_user_missing')
    const user=users.rows[0].authority as JsonRow
    const memberships=(await tx.query(`SELECT ${projectionSql('m',NATIVE_EMAIL_MEMBERSHIP_AUTHORITY_KEYS)} AS authority,w.is_demo
      FROM app_user_organization_memberships m JOIN workspace_organizations w ON w.id=m.organization_id
      WHERE m.user_email=$1 ORDER BY m.organization_id`,[email])).rows as Array<{authority:JsonRow;is_demo:boolean}>
    const intent=(await tx.query(`SELECT p.id::text,p.owner_email,p.workspace_organization_id::text,
      m.user_email,m.access_role,m.shared_by,m.created_at::text
      FROM pipeline_spaces p LEFT JOIN pipeline_space_members m ON m.pipeline_id=p.id AND m.user_email=$1
      WHERE p.owner_email=$1 OR m.user_email=$1 ORDER BY p.id`,[email])).rows
    return {user,memberships,intent,identityCount:Number(users.rows[0].identity_count)}
  }
  private async authorizeUserChange(tx:NativeEmailSqlClient,workspaceId:string,userEmail:string,afterRole:unknown,identitySelfOwner=false){
    const actor=(await tx.query(`SELECT u.status AS user_status,m.status,m.role,m.permissions,m.trashed_at,
      m.organization_id::text AS source_workspace_id,u.organization_id::text AS default_workspace_id,w.is_demo
      FROM app_users u JOIN app_user_organization_memberships m ON m.user_email=u.email
        AND m.organization_id=COALESCE($2::uuid,u.organization_id)
      JOIN workspace_organizations w ON w.id=m.organization_id WHERE u.email=$1`,
    [this.options.actorEmail,this.options.actorWorkspaceId??null])).rows[0]
    const target=(await tx.query('SELECT role FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2::uuid',
      [userEmail,workspaceId])).rows[0]
    requireNativeEmail(actor?.user_status==='active'&&actor.status==='active'&&actor.trashed_at===null&&actor.is_demo===false
      && ['owner','admin'].includes(String(actor.role))&&actor.permissions&&typeof actor.permissions==='object'
      && !Array.isArray(actor.permissions)&&(actor.role==='owner'||(actor.permissions as JsonRow).manageUserAccess===true)
      && target&&(target.role!=='owner'||identitySelfOwner&&userEmail===this.options.actorEmail&&actor.role==='owner')
      &&(actor.role==='owner'||target.role==='member'&&afterRole!=='admin'),
    'authority_actor_user_access_denied')
    const ancestry=(await tx.query(`WITH RECURSIVE ancestors AS (
      SELECT id,parent_id,is_demo,ARRAY[id] AS path,0 AS depth FROM workspace_organizations WHERE id=$1::uuid
      UNION ALL SELECT parent.id,parent.parent_id,parent.is_demo,child.path||parent.id,child.depth+1
      FROM workspace_organizations parent JOIN ancestors child ON parent.id=child.parent_id
      WHERE child.id<>$2::uuid AND NOT parent.id=ANY(child.path) AND child.depth<99
    ) SELECT id::text,parent_id::text,is_demo FROM ancestors ORDER BY depth`,[workspaceId,actor.source_workspace_id])).rows
    requireNativeEmail(ancestry.length>0&&ancestry.at(-1)?.id===actor.source_workspace_id
      &&ancestry[0].is_demo===false,'authority_actor_user_access_denied')
    return {email:this.options.actorEmail,workspaceId:actor.source_workspace_id,userStatus:actor.user_status,
      defaultWorkspaceId:actor.default_workspace_id,status:actor.status,role:actor.role,
      permissionsJson:nativeEmailEligibilityRowJson(actor.permissions),trashedAt:actor.trashed_at,
      actorScope:{workspaceId:String(actor.source_workspace_id),ancestryJson:nativeEmailEligibilityRowJson(ancestry)}}
  }
  private async identityLinkState(tx:NativeEmailSqlClient,workspaceId:string,userEmail:string,nativeId:string,current:'before'|'after'){
    const state=await this.userState(tx,userEmail)
    requireNativeEmail(state.memberships.length<=500&&state.intent.length<=500,'authority_identity_context_bound')
    const selected=state.memberships.find(row=>row.authority.organization_id===workspaceId)
    requireNativeEmail(selected?.is_demo===false&&selected.authority.trashed_at===null,'authority_identity_target_unavailable')
    const actor=await this.authorizeUserChange(tx,workspaceId,userEmail,selected.authority.role,true)
    const rows=(await tx.query(`SELECT ${projectionSql('u',NATIVE_EMAIL_IDENTITY_USER_KEYS)} AS authority
      FROM app_users u WHERE email=$1`,[userEmail])).rows
    requireNativeEmail(rows.length===1,'authority_user_missing')
    // Native Users IDs use a case-insensitive database collation. Retained
    // mixed-case app mappings must not be mistaken for an unclaimed account.
    const claims=(await tx.query('SELECT email FROM app_users WHERE lower(suitecrm_user_id)=lower($1) ORDER BY email',[nativeId])).rows
    requireNativeEmail(current==='before'?claims.length===0:claims.length===1&&claims[0].email===userEmail,
      'authority_identity_already_claimed')
    const context={actor,memberships:state.memberships,intent:state.intent}
    return {user:rows[0].authority as JsonRow,actor,
      contextFingerprint:nativeEmailDigest(encodeNativeEmailAuthoritySnapshotJson(context))}
  }
  private async identityLinkSnapshots(tx:NativeEmailSqlClient,change:NativeEmailUserIdentityLinkChange,current:'before'|'after'){
    const state=await this.identityLinkState(tx,change.workspaceId,change.userEmail,change.nativeIdentity.userId,current)
    requireNativeEmail(same(state.actor.actorScope,change.actorScope)&&state.contextFingerprint===change.contextFingerprint
      &&nativeEmailEligibilityRowJson(state.user)===change.appUser[current==='before'?'beforeJson':'afterJson'],
    'authority_identity_context_changed')
    return {before:{userJson:change.appUser.beforeJson,actor:state.actor,contextFingerprint:state.contextFingerprint},
      after:{userJson:change.appUser.afterJson,actor:state.actor,contextFingerprint:state.contextFingerprint},restoration:null}
  }
  /** Read-only first-existing-account preimage. It is not admission, account
   * creation or a grant; the native executor must still verify the exact
   * existing identity under its own transaction, and the typed app ledger
   * authorizes only the eventual exact local mapping. */
  async previewUserIdentityLink(request:{workspaceId:string;userEmail:string;nativeIdentity:NativeEmailUserIdentityLinkChange['nativeIdentity']},pipelineIds:string[]){
    request=normalizeNativeEmailUserIdentityLinkRequest(request)
    return this.transaction(async tx=>{
      await this.control(tx)
      const state=await this.identityLinkState(tx,request.workspaceId,request.userEmail,request.nativeIdentity.userId,'before')
      const change=prepareNativeEmailUserIdentityLinkChange({kind:'user_identity_link_v1',...request,
        actorScope:state.actor.actorScope,contextFingerprint:state.contextFingerprint,
        appUser:{beforeJson:nativeEmailEligibilityRowJson(state.user),afterJson:nativeEmailEligibilityRowJson({...state.user,
          suitecrm_user_id:request.nativeIdentity.userId,suitecrm_username:request.nativeIdentity.username})}})
      const snapshots=await this.snapshots(tx,change,pipelineIds,'before')
      return {desiredAppChange:change,appAuthorityBeforeFingerprint:nativeEmailDigest(snapshots.before),
        appAuthorityAfterFingerprint:nativeEmailDigest(snapshots.after),snapshots:immutable(snapshots)}
    })
  }
  private derivedUserStatus(memberships:Array<{authority:unknown;is_demo:unknown}>){
    const real=memberships.filter(row=>row.is_demo===false&&(row.authority as JsonRow).trashed_at===null)
    return real.some(row=>(row.authority as JsonRow).status==='active')?'active':
      real.some(row=>(row.authority as JsonRow).status==='invited')?'invited':'disabled'
  }
  private async latestUserRevocation(tx:NativeEmailSqlClient,userEmail:string,workspaceId:string){
    // Query only true eligible->ineligible losses. Unlimited unrelated access
    // toggles do not exhaust a scan budget or make an older loss authoritative.
    const eligible=(stage:'before'|'after')=>`((plan->'desiredAppChange'->'appUser'->>'${stage}Json')::jsonb->>'status'='active'
      AND (plan->'desiredAppChange'->'membership'->>'${stage}Json')::jsonb->>'status'='active'
      AND (plan->'desiredAppChange'->'membership'->>'${stage}Json')::jsonb->'trashed_at'='null'::jsonb
      AND ((plan->'desiredAppChange'->'membership'->>'${stage}Json')::jsonb->>'role'='owner'
        OR COALESCE((plan->'desiredAppChange'->'membership'->>'${stage}Json')::jsonb->'permissions'->>'viewCrm','true')='true'))`
    return (await tx.query(`SELECT transition_id,plan_hash,plan FROM crm_native_email_authority_transitions
      WHERE app_state='committed' AND plan->'desiredAppChange'->>'kind'='workspace_user_eligibility_v1'
        AND plan->'desiredAppChange'->>'userEmail'=$1 AND plan->'desiredAppChange'->>'workspaceId'=$2
        AND ${eligible('before')} AND NOT ${eligible('after')}
      ORDER BY (plan->'revoke'->>'generationFrom')::bigint DESC,created_at DESC,transition_id DESC LIMIT 1`,[userEmail,workspaceId])).rows[0]
  }
  private async restorationPlan(tx:NativeEmailSqlClient,change:NativeEmailWorkspaceUserEligibilityChange){
    if(!change.restoreFrom)return null
    const latest=await this.latestUserRevocation(tx,change.userEmail,change.workspaceId)
    requireNativeEmail(latest?.transition_id===change.restoreFrom.transitionId&&latest.plan_hash===change.restoreFrom.planHash,
      'authority_user_restore_not_latest')
    const found=(await tx.query(`SELECT t.plan,t.plan_hash,t.app_state,t.app_commit,r.native_receipt AS revoke_receipt,
      r.receipt_hash AS revoke_receipt_hash,COALESCE(a.state,g.state) AS grant_state,
      COALESCE(a.native_receipt,g.native_receipt) AS grant_receipt,COALESCE(a.receipt_hash,g.receipt_hash) AS grant_receipt_hash,
      COALESCE(a.command,g.command) AS grant_command,a.grant_attempt
      FROM crm_native_email_authority_transitions t
      JOIN crm_native_email_authority_phases r ON r.transition_id=t.transition_id AND r.phase='revoke'
      JOIN crm_native_email_authority_phases g ON g.transition_id=t.transition_id AND g.phase='grant'
      LEFT JOIN LATERAL (SELECT state,native_receipt,receipt_hash,command,grant_attempt FROM crm_native_email_authority_grant_attempts
        WHERE transition_id=t.transition_id ORDER BY ordinal DESC LIMIT 1) a ON true WHERE t.transition_id=$1`,
    [change.restoreFrom.transitionId])).rows[0]
    requireNativeEmail(found&&found.app_state==='committed'&&found.app_commit&&found.grant_state==='committed'
      && found.plan_hash===change.restoreFrom.planHash,'authority_user_restore_provenance')
    const {planHash,...input}=found.plan as NativeEmailAuthorityTransitionPlan,plan=prepareNativeEmailAuthorityTransition(input)
    requireNativeEmail(planHash===plan.planHash&&planHash===change.restoreFrom.planHash,'authority_user_restore_provenance')
    const original=prepareNativeEmailWorkspaceUserEligibilityChange(plan.desiredAppChange)
    const beforeUser=JSON.parse(original.appUser.beforeJson),beforeMember=JSON.parse(original.membership.beforeJson)
    requireNativeEmail(original.workspaceId===change.workspaceId&&original.userEmail===change.userEmail
      && original.pipelineIntentFingerprint===change.pipelineIntentFingerprint
      && beforeUser.suitecrm_user_id===JSON.parse(change.appUser.afterJson).suitecrm_user_id
      && userEligibility(beforeUser,beforeMember)&&!userEligibility(JSON.parse(original.appUser.afterJson),JSON.parse(original.membership.afterJson)),
    'authority_user_restore_provenance')
    const receipt=verifyNativeEmailAuthorityReceipt(prepareNativeEmailAuthorityCommand(plan.revoke),found.revoke_receipt)
    const expectedGrant=nativeEmailAuthorityPhaseCommand({plan,appCommit:found.app_commit as NativeEmailAppAuthorityCommitReceipt,
      ...(found.grant_attempt?{grantAttempt:found.grant_attempt as NativeEmailGrantAttempt}:{})},'grant')
    requireNativeEmail(same(expectedGrant,found.grant_command),'authority_user_restore_provenance')
    const grantReceipt=verifyNativeEmailAuthorityReceipt(prepareNativeEmailAuthorityCommand(expectedGrant),found.grant_receipt)
    requireNativeEmail(receipt.state==='committed'&&nativeEmailAuthorityReceiptHash(receipt)===found.revoke_receipt_hash
      &&grantReceipt.state==='committed'&&nativeEmailAuthorityReceiptHash(grantReceipt)===found.grant_receipt_hash
      &&same(found.app_commit,this.appReceipt(plan,receipt)),'authority_user_restore_provenance')
    return plan
  }
  private async lifecycleSnapshots(tx:NativeEmailSqlClient,change:NativeEmailWorkspaceUserEligibilityChange,current:'before'|'after'){
    const state=await this.userState(tx,change.userEmail)
    requireNativeEmail(state.identityCount===1&&nativeEmailDigest(encodeNativeEmailAuthoritySnapshotJson(state.intent))===change.pipelineIntentFingerprint,
      'authority_user_intent_changed')
    const selected=state.memberships.find(row=>(row.authority as JsonRow).organization_id===change.workspaceId)
    requireNativeEmail(selected?.is_demo===false&&nativeEmailEligibilityRowJson(state.user)===change.appUser[current+'Json' as 'beforeJson'|'afterJson']
      && nativeEmailEligibilityRowJson(selected.authority)===change.membership[current+'Json' as 'beforeJson'|'afterJson'],'authority_user_preimage_changed')
    const actor=await this.authorizeUserChange(tx,change.workspaceId,change.userEmail,JSON.parse(change.membership.afterJson).role)
    requireNativeEmail(same(actor.actorScope,change.actorScope),'authority_user_actor_scope_changed')
    const beforeUser=JSON.parse(change.appUser.beforeJson),afterUser=JSON.parse(change.appUser.afterJson)
    const beforeMember=JSON.parse(change.membership.beforeJson),afterMember=JSON.parse(change.membership.afterJson)
    const gaining=!userEligibility(beforeUser,beforeMember)&&userEligibility(afterUser,afterMember)
    const latestRevocation=gaining?await this.latestUserRevocation(tx,change.userEmail,change.workspaceId):null
    // A first access grant has no restoration lineage. A recorded revocation
    // must never be relabeled as a first grant to discard its retained rights
    // or bypass its verified completion/provenance checks.
    requireNativeEmail(same(change.restoreFrom,latestRevocation?{
      transitionId:String(latestRevocation.transition_id),planHash:String(latestRevocation.plan_hash),
    }:null),'authority_user_restore_provenance')
    if(change.userEmail===this.options.actorEmail){
      requireNativeEmail(afterMember.status==='active'&&afterMember.trashed_at===null
        &&(afterMember.role==='owner'||afterMember.permissions.manageUserAccess===true),'authority_user_self_demotion')
      actor.userStatus=beforeUser.status;actor.status=beforeMember.status;actor.role=beforeMember.role
      actor.permissionsJson=nativeEmailEligibilityRowJson(beforeMember.permissions);actor.trashedAt=beforeMember.trashed_at
    }
    const stages={} as Record<'before'|'after',JsonRow>
    for(const stage of ['before','after'] as const){
      const memberships=state.memberships.map(row=>({...row,authority:JSON.parse(nativeEmailEligibilityRowJson(row.authority)) as JsonRow}))
      memberships.find(row=>row.authority.organization_id===change.workspaceId)!.authority=JSON.parse(change.membership[stage+'Json' as 'beforeJson'|'afterJson'])
      if(change.demoMembership){
        const demo=JSON.parse(change.demoMembership.beforeJson),at=memberships.findIndex(row=>row.authority.organization_id===demo.organization_id)
        if(current==='before')requireNativeEmail(at>=0&&memberships[at].is_demo===true
          && nativeEmailEligibilityRowJson(memberships[at].authority)===change.demoMembership.beforeJson,'authority_user_demo_changed')
        else requireNativeEmail(at<0,'authority_user_demo_changed')
        if(stage==='after'&&at>=0)memberships.splice(at,1)
        if(stage==='before'&&at<0)memberships.push({authority:demo,is_demo:true})
      }
      memberships.sort((a,b)=>String(a.authority.organization_id)<String(b.authority.organization_id)?-1:1)
      const user=JSON.parse(change.appUser[stage+'Json' as 'beforeJson'|'afterJson'])
      if(stage==='after')requireNativeEmail(user.status===this.derivedUserStatus(memberships),'authority_user_global_status_changed')
      stages[stage]={userJson:nativeEmailEligibilityRowJson(user),membershipsJson:nativeEmailEligibilityRowJson(memberships),
        actor,intentFingerprint:change.pipelineIntentFingerprint,restoreFrom:change.restoreFrom}
    }
    const restoration=await this.restorationPlan(tx,change)
    return {...stages,restoration}
  }
  async previewWorkspaceUserEligibility(request:NativeEmailWorkspaceUserEligibilityRequest,pipelineIds:string[]){
    const selection=normalizeNativeEmailWorkspaceUserEligibilityRequest(request)
    return this.transaction(async tx=>{
      await this.control(tx)
      const state=await this.userState(tx,selection.userEmail)
      const selected=state.memberships.find(row=>(row.authority as JsonRow).organization_id===selection.workspaceId)
      requireNativeEmail(selected?.is_demo===false&&state.identityCount===1,'authority_user_missing')
      const before=selected.authority as JsonRow,after={...before},action=selection.action
      const actor=await this.authorizeUserChange(tx,selection.workspaceId,selection.userEmail,action.kind==='access'?action.role:before.role)
      const self=selection.userEmail===this.options.actorEmail
      if(action.kind==='status'){
        requireNativeEmail(before.trashed_at===null&&!(action.status==='active'&&before.status==='invited')
          && !(self&&action.status==='disabled'),'authority_user_status_invalid');after.status=action.status
      }else if(action.kind==='trash'){
        requireNativeEmail(!self,'authority_user_self_trash')
        if(Boolean(before.trashed_at)===action.trashed)return {unchanged:true as const}
        if(action.trashed){after.status='disabled';after.pre_trash_status=before.status;after.trashed_by=this.options.actorEmail
          after.trashed_at=(await tx.query('SELECT to_jsonb(transaction_timestamp()) AS stamp')).rows[0].stamp}
        else{requireNativeEmail(['active','invited','disabled'].includes(String(before.pre_trash_status)),'authority_user_restore_status_missing')
          after.status=before.pre_trash_status;after.pre_trash_status=null;after.trashed_at=null;after.trashed_by=null}
      }else{
        requireNativeEmail(before.trashed_at===null,'authority_user_trashed');after.role=action.role;after.permissions=JSON.parse(action.permissionsJson)
        if(self)requireNativeEmail((after.permissions as JsonRow).manageUserAccess===true,'authority_user_self_demotion')
      }
      if(nativeEmailEligibilityRowJson(before)===nativeEmailEligibilityRowJson(after))return {unchanged:true as const}
      const next=state.memberships.map(row=>({...row,authority:(row.authority as JsonRow).organization_id===selection.workspaceId?after:row.authority}))
      const demoAllowed=next.some(row=>row.is_demo===false&&(row.authority as JsonRow).status==='active'
        &&(row.authority as JsonRow).trashed_at===null&&((row.authority as JsonRow).role==='owner'
          ||((row.authority as JsonRow).permissions as JsonRow).accessDemo===true))
      const demos=next.filter(row=>row.is_demo===true)
      requireNativeEmail(demos.length<=1,'authority_user_demo_ambiguous')
      const demo=!demoAllowed&&demos.length?demos[0]:null
      const finalMemberships=demo?next.filter(row=>row!==demo):next
      const nextUser={...state.user,status:this.derivedUserStatus(finalMemberships)}
      const draft:NativeEmailWorkspaceUserEligibilityChange={kind:'workspace_user_eligibility_v1',...selection,
        actorScope:actor.actorScope,
        pipelineIntentFingerprint:nativeEmailDigest(encodeNativeEmailAuthoritySnapshotJson(state.intent)),
        appUser:{beforeJson:nativeEmailEligibilityRowJson(state.user),afterJson:nativeEmailEligibilityRowJson(nextUser)},
        membership:{beforeJson:nativeEmailEligibilityRowJson(before),afterJson:nativeEmailEligibilityRowJson(after)},
        demoMembership:demo?{beforeJson:nativeEmailEligibilityRowJson(demo.authority),afterJson:null}:null,restoreFrom:null}
      if(!userEligibility(state.user,before)&&userEligibility(nextUser,after)){
        const original=await this.latestUserRevocation(tx,selection.userEmail,selection.workspaceId)
        if(original)draft.restoreFrom={transitionId:String(original.transition_id),planHash:String(original.plan_hash)}
      }
      const change=prepareNativeEmailWorkspaceUserEligibilityChange(draft),snapshots=await this.snapshots(tx,change,pipelineIds,'before')
      return {desiredAppChange:change,appAuthorityBeforeFingerprint:nativeEmailDigest(snapshots.before),
        appAuthorityAfterFingerprint:nativeEmailDigest(snapshots.after),snapshots:immutable(snapshots)}
    })
  }
  private async snapshots(tx:NativeEmailSqlClient,change:NativeEmailAppAuthorityChange,pipelineIds:string[],current:'before'|'after'){
    requireNativeEmail(pipelineIds.length>0 && pipelineIds.length<=100 && same([...new Set(pipelineIds)].sort(),pipelineIds)
      && pipelineIds.every(id=>UUID.test(id)),'authority_pipeline_scope')
    const memberChanges=change.kind==='pipeline_members_v1'?change.changes:[]
    const changed=new Set(memberChanges.map(delta=>(delta.before??delta.after)!.pipeline_id))
    requireNativeEmail([...changed].every(id=>pipelineIds.includes(id)),'authority_unbound_member_change')
    const before:Snapshot={version:1,pipelines:[],emails:[]},after:Snapshot={version:1,pipelines:[],emails:[]}
    const lifecycle=change.kind==='workspace_user_eligibility_v1'?await this.lifecycleSnapshots(tx,change,current)
      :change.kind==='user_identity_link_v1'?await this.identityLinkSnapshots(tx,change,current):null
    const registry=change.kind==='root_registry_v1'?await collectNativeEmailRootRegistryPreviewWithClient(tx,{
      actorEmail:this.options.actorEmail,actorWorkspaceId:this.options.actorWorkspaceId??'',change,pipelineIds,current}):null
    if(registry)requireNativeEmail(registry.contextFingerprint===(change as RootEmployeeCrmRegistryChange).contextFingerprint,
      'authority_root_registry_context_changed')
    const rootSources=registry?[]:await collectNativeEmailRootSourcesWithClient(tx,pipelineIds)
    const hasRoots=registry?registry.before.length>0||registry.after.length>0:rootSources.length>0
    if(registry){before.registry=registry.registryBefore;after.registry=registry.registryAfter}
    if(lifecycle){before.lifecycle=lifecycle.before;after.lifecycle=lifecycle.after}
    for(const pipelineId of pipelineIds){
      // Control is already locked. These source reads never reverse its lock
      // order. Every authority mutation entry point/trigger shares that fence.
      const found=await tx.query(`SELECT jsonb_build_object('id',p.id,'owner_email',p.owner_email,
        'workspace_organization_id',p.workspace_organization_id,'reference_access_disabled',p.reference_access_disabled) AS pipeline,
        jsonb_build_object('id',w.id,'is_demo',w.is_demo) AS workspace
        FROM pipeline_spaces p JOIN workspace_organizations w ON w.id=p.workspace_organization_id WHERE p.id=$1::uuid`,[pipelineId])
      requireNativeEmail(found.rows.length===1,'authority_pipeline_missing')
      const pipeline=found.rows[0].pipeline as JsonRow,workspace=found.rows[0].workspace as JsonRow
      requireNativeEmail(pipeline.reference_access_disabled===false && workspace.is_demo===false,'authority_pipeline_unavailable')
      const members=(await tx.query('SELECT to_jsonb(m) AS member FROM pipeline_space_members m WHERE pipeline_id=$1::uuid ORDER BY user_email',[pipelineId])).rows.map(row=>row.member as NativeEmailPipelineMemberRow)
      const beforeMembers=new Map(members.map(row=>[row.user_email,row])),afterMembers=new Map(beforeMembers)
      for(const delta of memberChanges.filter(value=>(value.before??value.after)!.pipeline_id===pipelineId)){
        const member=(delta.before??delta.after)!
        requireNativeEmail(member.user_email!==pipeline.owner_email,'authority_owner_member_change_unsupported')
        requireNativeEmail(same(beforeMembers.get(member.user_email)??null,delta[current]),'authority_member_preimage_changed')
        const normalized=(await tx.query('SELECT to_jsonb(jsonb_populate_record(NULL::pipeline_space_members,$1::jsonb)) AS member',[nativeEmailCanonicalJson(member)])).rows[0]?.member
        requireNativeEmail(same(normalized,member),'authority_member_timestamp_not_canonical')
        if(delta.after)requireNativeEmail(delta.after.shared_by===(delta.before?delta.before.shared_by:this.options.actorEmail),
          'authority_member_sharer_changed')
        if(delta.before)beforeMembers.set(member.user_email,delta.before);else beforeMembers.delete(member.user_email)
        if(delta.after)afterMembers.set(member.user_email,delta.after);else afterMembers.delete(member.user_email)
      }
      const emails=[...new Set([String(pipeline.owner_email),...beforeMembers.keys(),...afterMembers.keys()])].sort()
      requireNativeEmail(emails.length<=500,'authority_principal_bound')
      const principals=(await tx.query(`SELECT u.email,u.status,u.suitecrm_user_id,u.role AS global_role,u.permissions AS global_permissions,
        u.organization_id::text AS global_organization_id,m.organization_id::text AS workspace_id,m.status AS membership_status,
        m.role AS membership_role,m.permissions AS membership_permissions,m.trashed_at::text AS membership_trashed_at,
        (SELECT count(*)::int FROM app_users duplicate WHERE duplicate.suitecrm_user_id=u.suitecrm_user_id) AS native_identity_count
        FROM app_users u LEFT JOIN app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=$1::uuid
        WHERE u.email=ANY($2::text[]) ORDER BY u.email`,[workspace.id,emails])).rows
      requireNativeEmail(principals.length===emails.length,'authority_principal_missing')
      const nativeIds=new Set<string>()
      for(const principal of principals){
        nativeEmailPrincipalIsEligible(principal,false,true)
        requireNativeEmail(principal.suitecrm_user_id===null||!nativeIds.has(String(principal.suitecrm_user_id)),'authority_principal_denied_or_ambiguous')
        if(principal.suitecrm_user_id!==null)nativeIds.add(String(principal.suitecrm_user_id))
      }
      // Sharing belongs to the current pipeline owner, not every workspace
      // administrator. A member/admin who owns this pipeline retains the same
      // sharing workflow; the complete scope below must still prove that owner
      // is active, mapped and CRM-eligible before admission or app commit.
      if(changed.has(pipelineId))requireNativeEmail(pipeline.owner_email===this.options.actorEmail,'authority_actor_not_owner')
      for(const delta of memberChanges.filter(value=>value.after?.pipeline_id===pipelineId))
        requireNativeEmail(principals.find(principal=>principal.email===delta.after!.user_email)?.workspace_id===workspace.id,
          'authority_member_workspace_missing')
      const principalSnapshot=(stage:'before'|'after')=>principals.map(principal=>{
        const value={...principal}
        if(change.kind==='user_identity_link_v1'&&principal.email===change.userEmail){
          const user=JSON.parse(change.appUser[stage==='before'?'beforeJson':'afterJson'])
          value.suitecrm_user_id=user.suitecrm_user_id;value.native_identity_count=user.suitecrm_user_id===null?0:1
        }
        if(change.kind==='workspace_user_eligibility_v1'&&principal.email===change.userEmail){
          const user=JSON.parse(change.appUser[stage+'Json' as 'beforeJson'|'afterJson']) as JsonRow
          value.status=user.status
          if(workspace.id===change.workspaceId){
            const membership=JSON.parse(change.membership[stage+'Json' as 'beforeJson'|'afterJson']) as JsonRow
            value.membership_status=membership.status;value.membership_role=membership.role
            value.membership_permissions=membership.permissions;value.membership_trashed_at=membership.trashed_at
          }
        }
        return {...value,global_permissions:encodeNativeEmailAuthoritySnapshotJson(value.global_permissions),
          membership_permissions:encodeNativeEmailAuthoritySnapshotJson(value.membership_permissions)}
      })
      const memberOrder=(a:NativeEmailPipelineMemberRow,b:NativeEmailPipelineMemberRow)=>a.user_email<b.user_email?-1:a.user_email>b.user_email?1:0
      const rootProjection=(stage:'before'|'after')=>projectNativeEmailRootReaders({sources:registry?registry[stage]:rootSources,pipelineId,
        workspaceId:String(workspace.id),stage,...(change.kind==='workspace_user_eligibility_v1'?{lifecycle:change}
          :change.kind==='user_identity_link_v1'?{identityLink:change}:{})})
      const beforeScope={pipeline,workspace,principals:principalSnapshot('before'),members:[...beforeMembers.values()].sort(memberOrder),
        ...(hasRoots?{rootReaders:rootProjection('before')}:{})}
      const afterScope={pipeline,workspace,principals:principalSnapshot('after'),members:[...afterMembers.values()].sort(memberOrder),
        ...(hasRoots?{rootReaders:rootProjection('after')}:{})}
      nativeEmailEffectivePipelinePrincipals(beforeScope);nativeEmailEffectivePipelinePrincipals(afterScope)
      before.pipelines.push(beforeScope);after.pipelines.push(afterScope)
    }
    // All locally known published native Emails, including archived records.
    // A missing/legacy ambiguous identity holds rather than dropping coverage.
    const known=(await tx.query(`SELECT i.suitecrm_id AS "emailId",i.reference_code AS "globalId",i.pipeline_id::text AS "pipelineId"
      FROM crm_interactions i WHERE i.suitecrm_module='Emails' AND (i.suitecrm_synced_at IS NOT NULL OR EXISTS(
        SELECT 1 FROM crm_native_email_publication_admissions a WHERE a.local_id=i.id AND a.state='committed'))
      ORDER BY i.suitecrm_id,i.id LIMIT 501`)).rows as Snapshot['emails']
    requireNativeEmail(known.length<=500 && new Set(known.map(row=>row.emailId)).size===known.length
      && new Set(known.map(row=>row.globalId)).size===known.length && known.every(row=>pipelineIds.includes(row.pipelineId)
        && typeof row.emailId==='string' && typeof row.globalId==='string'),'authority_email_coverage_unbound')
    before.emails=clone(known);after.emails=clone(known)
    return {before,after,restoration:lifecycle?.restoration??null}
  }
  /** Read-only evidence builder; does not authorize a caller-supplied plan or
   * native snapshot. Caller must retain exact full bindings, native ACL matrix,
   * policy pins and separately reviewed native approval evidence. */
  async previewMemberChange(value:unknown,pipelineIds:string[]){
    const change=prepareNativeEmailPipelineMemberChange(value)
    return this.transaction(async tx=>{await this.control(tx);const snapshots=await this.snapshots(tx,change,pipelineIds,'before')
      return {desiredAppChange:change,appAuthorityBeforeFingerprint:nativeEmailDigest(snapshots.before),
        appAuthorityAfterFingerprint:nativeEmailDigest(snapshots.after),snapshots:immutable(snapshots)}})
  }
  /** Private typed registry source builder. The actor/root come from the
   * authenticated coordinator options, never a mutable default organization.
   * Admission, exact app ledger and native receipts are still required. */
  async previewRootRegistryChange(value:unknown,pipelineIds:string[]){
    const proposed=prepareRootEmployeeCrmRegistryChange(value)
    return this.transaction(async tx=>{
      await this.control(tx)
      const source=await collectNativeEmailRootRegistryPreviewWithClient(tx,{actorEmail:this.options.actorEmail,
        actorWorkspaceId:this.options.actorWorkspaceId??'',change:proposed,pipelineIds,current:'before'})
      const change=prepareRootEmployeeCrmRegistryChange({...proposed,contextFingerprint:source.contextFingerprint})
      const snapshots=await this.snapshots(tx,change,pipelineIds,'before')
      return {desiredAppChange:change,appAuthorityBeforeFingerprint:nativeEmailDigest(snapshots.before),
        appAuthorityAfterFingerprint:nativeEmailDigest(snapshots.after),snapshots:immutable(snapshots)}
    })
  }
  private validateMatrix(plan:NativeEmailAuthorityTransitionPlan,snapshots:{before:Snapshot;after:Snapshot;restoration:NativeEmailAuthorityTransitionPlan|null}){
    const selected=prepareNativeEmailAppAuthorityChange(plan.desiredAppChange)
    if(selected.kind==='user_identity_link_v1')requireNativeEmail(plan.revoke.version===2&&plan.grant.version===2
      &&same(plan.revoke.identityLinks,[selected.nativeIdentity])&&same(plan.grant.identityLinks,[selected.nativeIdentity]),
    'authority_identity_link_phase_scope')
    else requireNativeEmail(!Object.hasOwn(plan.revoke,'identityLinks')&&!Object.hasOwn(plan.grant,'identityLinks'),
      'authority_identity_link_action_unsupported')
    requireNativeEmail(nativeEmailDigest(snapshots.before)===plan.expectedAppAuthorityBeforeFingerprint
      && nativeEmailDigest(snapshots.after)===plan.expectedAppAuthorityAfterFingerprint,'authority_app_snapshot_changed')
    requireNativeEmail(same(snapshots.before.emails,plan.revoke.capabilities.map(({emailId,globalId,pipelineId})=>({emailId,globalId,pipelineId}))),
      'authority_email_matrix_coverage_changed')
    for(const stage of ['before','after'] as const){
      const command=stage==='before'?plan.revoke:plan.grant
      for(const scope of snapshots[stage].pipelines){
        const binding=command.bindings.find(pair=>pair[stage].pipeline_id===scope.pipeline.id)?.[stage]
        const effective=nativeEmailEffectivePipelinePrincipals(scope)
        const readers=effective.map(row=>String(row.suitecrm_user_id)).sort()
        const writers=nativeEmailManualPipelinePrincipals(scope).filter(row=>row.email===scope.pipeline.owner_email
          || scope.members.some(member=>member.user_email===row.email && member.access_role==='editor')).map(row=>String(row.suitecrm_user_id)).sort()
        requireNativeEmail(binding && binding.workspace_id===scope.workspace.id
          && binding.owner_id===scope.principals.find(row=>row.email===scope.pipeline.owner_email)?.suitecrm_user_id
          && same(JSON.parse(binding.readers_json),readers),'authority_binding_app_scope_changed')
        for(const entry of command.capabilities.filter(row=>row.pipelineId===scope.pipeline.id)){
          for(const surface of ['view','list','export'] as const)requireNativeEmail(same(entry[stage][surface],readers),'authority_reader_matrix_changed')
          if(command.version===1 || !('capability_policy_json' in binding) || binding.capability_policy_json===null)
            for(const surface of ['edit','delete'] as const)requireNativeEmail(same(entry[stage][surface],writers),'authority_writer_matrix_changed')
        }
      }
    }
    if(plan.revoke.version===2){
      const appChange=prepareNativeEmailAppAuthorityChange(plan.desiredAppChange)
      const changes=appChange.kind==='pipeline_members_v1'?appChange.changes:[]
      const expectedRoles=nativeEmailEffectiveRoleChanges(changes,snapshots.before.pipelines,snapshots.after.pipelines)
      requireNativeEmail(same(plan.revoke.roleChanges??[],expectedRoles) && same(plan.grant.roleChanges??[],expectedRoles),
        'authority_role_change_app_scope')
      for(const pair of plan.revoke.bindings){
        if(!('capability_policy_json' in pair.before) || pair.before.capability_policy_json===null)continue
        const scope=snapshots.before.pipelines.find(value=>value.pipeline.id===pair.before.pipeline_id)!
        const deltas=changes.filter(change=>(change.before??change.after)!.pipeline_id===pair.before.pipeline_id)
        const demoted=new Set(deltas.filter(change=>change.before?.access_role==='editor' && change.after?.access_role!=='editor')
          .map(change=>String(scope.principals.find(value=>value.email===change.before!.user_email)!.suitecrm_user_id)))
        const effective=nativeEmailEffectivePipelinePrincipals(snapshots.after.pipelines.find(value=>value.pipeline.id===pair.before.pipeline_id)!)
        const manual=nativeEmailManualPipelinePrincipals(snapshots.after.pipelines.find(value=>value.pipeline.id===pair.before.pipeline_id)!)
        const addedEditors=new Set(deltas.filter(change=>change.after?.access_role==='editor')
          .flatMap(change=>manual.filter(value=>value.email===change.after!.user_email).map(value=>String(value.suitecrm_user_id))))
        if(appChange.kind==='user_identity_link_v1')for(const principal of manual)
          if(principal.email===appChange.userEmail&&snapshots.after.pipelines.find(value=>value.pipeline.id===pair.before.pipeline_id)!
            .members.some(member=>member.user_email===principal.email&&member.access_role==='editor'))addedEditors.add(String(principal.suitecrm_user_id))
        const checkWrites=(before:Record<string,string[]>,after:Record<string,string[]>)=>{
          for(const surface of ['edit','delete']){
            const readers=new Set(effective.map(value=>String(value.suitecrm_user_id)))
            const expected=[...new Set([...before[surface].filter(id=>readers.has(id)&&!demoted.has(id)),...addedEditors])].sort()
            requireNativeEmail(same(after[surface],expected),'authority_unrelated_writer_change')
          }
        }
        const final=plan.grant.bindings.find(value=>value.after.pipeline_id===pair.before.pipeline_id)!.after
        if(appChange.kind==='workspace_user_eligibility_v1'){
          requireNativeEmail('capability_policy_json' in final&&final.capability_policy_json!==null,'authority_user_policy_missing')
          const readers=effective.map(row=>String(row.suitecrm_user_id)).sort()
          const expected=(emailId:string|null,before:NativeEmailAuthorityCapabilities)=>nativeEmailEligibilityFinalCapabilities({
            change:appChange,restoration:snapshots.restoration,pipelineId:pair.before.pipeline_id,emailId,readers,before})
          requireNativeEmail(same(JSON.parse(final.capability_policy_json as string).futureCreate,
            expected(null,JSON.parse(pair.before.capability_policy_json as string).futureCreate)),'authority_user_future_rights_changed')
          for(const entry of plan.revoke.capabilities.filter(value=>value.pipelineId===pair.before.pipeline_id))
            requireNativeEmail(same(plan.grant.capabilities.find(value=>value.emailId===entry.emailId)!.after,
              expected(entry.emailId,entry.before)),'authority_user_historical_rights_changed')
          continue
        }
        checkWrites(JSON.parse(pair.before.capability_policy_json as string).futureCreate,
          JSON.parse(('capability_policy_json' in final ? final.capability_policy_json : null) as string).futureCreate)
        for(const entry of plan.revoke.capabilities.filter(value=>value.pipelineId===pair.before.pipeline_id))
          checkWrites(entry.before,plan.grant.capabilities.find(value=>value.emailId===entry.emailId)!.after)
      }
    }
  }
  /** The immutable native command retains exact JSON string bytes; this PG
   * jsonb trust anchor compares their decoded policy and stable future hash. */
  private async validatePolicies(tx:NativeEmailSqlClient,plan:NativeEmailAuthorityTransitionPlan,generation:number){
    const rows=(await tx.query('SELECT pipeline_id,generation,policy,fingerprint FROM crm_native_email_capability_policies ORDER BY pipeline_id')).rows
    if(plan.revoke.version===1){requireNativeEmail(rows.length===0,'authority_v2_policy_requires_v2_transition');return}
    const bindings=generation===plan.revoke.generationFrom?plan.revoke.bindings.map(pair=>pair.before)
      :generation===plan.revoke.generationTo?plan.revoke.bindings.map(pair=>pair.after)
      :generation===plan.grant.generationTo?plan.grant.bindings.map(pair=>pair.after):null
    requireNativeEmail(bindings,'authority_policy_generation_changed')
    const pinned=bindings.filter(binding=>'capability_policy_json' in binding && binding.capability_policy_json!==null)
    requireNativeEmail(rows.length===pinned.length,'authority_policy_inventory_changed')
    for(const binding of pinned){
      requireNativeEmail('capability_policy_json' in binding && 'capability_policy_fingerprint' in binding,'authority_policy_binding_missing')
      const policy=JSON.parse(binding.capability_policy_json as string) as NativeEmailCapabilityContract
      const checked=prepareNativeEmailCapabilityContract(policy,{binding:{pipelineId:binding.pipeline_id,workspaceId:binding.workspace_id,
        ownerSuiteCrmId:binding.owner_id,audienceFingerprint:binding.audience_fingerprint,allowedReaderSuiteCrmUserIds:JSON.parse(binding.readers_json)},
        livePrincipalSuiteCrmUserIds:policy.principalSuiteCrmUserIds,approvedFutureCreate:policy.futureCreate,liveHistorical:[]})
      const row=rows.find(value=>value.pipeline_id===binding.pipeline_id)
      requireNativeEmail(policy.historical.length===0 && row && Number(row.generation)===generation && same(row.policy,policy)
        && row.fingerprint===checked.futurePolicyFingerprint && row.fingerprint===binding.capability_policy_fingerprint,'authority_policy_pin_changed')
    }
  }
  private async validateAuthority(tx:NativeEmailSqlClient,plan:NativeEmailAuthorityTransitionPlan,current:'before'|'after'){
    const change=prepareNativeEmailAppAuthorityChange(plan.desiredAppChange)
    requireNativeEmail(plan.revoke.pendingPublicationCommand===null && plan.grant.pendingPublicationCommand===null,'authority_pending_publication_unsupported')
    const snapshots=await this.snapshots(tx,change,plan.revoke.bindings.map(pair=>pair.before.pipeline_id),current)
    this.validateMatrix(plan,snapshots);return change
  }
  private async read(tx:NativeEmailSqlClient,control:JsonRow,id:string):Promise<Stored>{
    requireNativeEmail(typeof id==='string' && HASH.test(id),'authority_transition_id_invalid')
    const rows=await tx.query('SELECT * FROM crm_native_email_authority_transitions WHERE transition_id=$1 FOR UPDATE',[id])
    requireNativeEmail(rows.rows.length===1,'authority_transition_missing');const row=rows.rows[0]
    requireNativeEmail(row.actor_email===this.options.actorEmail,'authority_actor_changed')
    const {planHash,...input}=row.plan as NativeEmailAuthorityTransitionPlan,plan=prepareNativeEmailAuthorityTransition(input)
    requireNativeEmail(plan.planHash===planHash && planHash===row.plan_hash && plan.revoke.transitionId===id
      && plan.revoke.desiredAppChangeHash===row.desired_change_hash,'authority_stored_plan_changed')
    const phases={} as Record<Phase,JsonRow>
    const states={} as Pick<NativeEmailAuthorityTransitionRecord,Phase>
    for(const phase of ['revoke','grant'] as const){
      const found=await tx.query('SELECT *,lease_until>clock_timestamp() AS lease_live FROM crm_native_email_authority_phases WHERE transition_id=$1 AND phase=$2 FOR UPDATE',[id,phase])
      requireNativeEmail(found.rows.length===1,'authority_phase_missing');const p=found.rows[0],request=prepareNativeEmailAuthorityCommand(plan[phase])
      requireNativeEmail(same(p.command,request.command) && p.command_hash===request.commandHash && p.operation_id===request.command.operationId,
        'authority_stored_command_changed')
      const receipt=p.native_receipt===null?null:verifyNativeEmailAuthorityReceipt(request,p.native_receipt)
      requireNativeEmail(['prepared','dispatched','unknown','committed','cancelled'].includes(String(p.state))
        && (['committed','cancelled'].includes(String(p.state)))===(receipt!==null)
        && (!receipt || receipt.state===p.state && nativeEmailAuthorityReceiptHash(receipt)===p.receipt_hash),'authority_stored_receipt_changed')
      phases[phase]=p;states[phase]={state:p.state as NativeEmailAuthorityTransitionRecord[Phase]['state'],receipt}
    }
    const appCommit=row.app_commit as NativeEmailAppAuthorityCommitReceipt|null
    requireNativeEmail((row.app_state==='committed')===(appCommit!==null) && row.app_state!=='applying','authority_partial_app_commit')
    if(appCommit)requireNativeEmail(states.revoke.receipt?.state==='committed' && same(appCommit,this.appReceipt(plan,states.revoke.receipt)),
      'authority_stored_app_commit_changed')
    const record:NativeEmailAuthorityTransitionRecord={enabled:control.enabled===true,plan,...states,appCommit,grantApproval:null}
    for(const phase of ['revoke','grant'] as const){
      if(phases[phase].approval_envelope)this.checkEnvelope(record,phase,phases[phase].approval_envelope as NativeEmailAuthorityApprovalEnvelope,control,false)
      if(phases[phase].approval_readback){
        const readback=verifyNativeEmailAuthorityApprovalReadback(plan[phase],phases[phase].approval_envelope as NativeEmailAuthorityApprovalEnvelope,phases[phase].approval_readback)
        if(phase==='grant')record.grantApproval={operationId:readback.operationId,commandHash:readback.commandHash,appCommitFingerprint:readback.appCommitFingerprint!}
      }
    }
    // Insert guards prove immutable contiguous lineage. Recheck the original
    // anchor and immediate predecessor at read time, without an unbounded scan.
    const attempts=(await tx.query(`SELECT *,lease_until>clock_timestamp() AS lease_live
      FROM crm_native_email_authority_grant_attempts WHERE transition_id=$1 ORDER BY ordinal DESC LIMIT 2 FOR UPDATE`,[id])).rows.reverse()
    let previous:JsonRow=phases.grant
    for(const [index,attempt] of attempts.entries()){
      const metadata=attempt.grant_attempt as NativeEmailGrantAttempt
      requireNativeEmail(appCommit && states.grant.state==='cancelled' && states.grant.receipt?.state==='cancelled'
        && Number(attempt.ordinal)===metadata.ordinal && Number.isSafeInteger(metadata.ordinal)
        && metadata.ordinal>0 && metadata.ordinal<=10000,'authority_grant_attempt_origin')
      if(index>0 || metadata.ordinal===1)requireNativeEmail(previous.state==='cancelled'
        && previous.native_receipt && metadata.previousOperationId===previous.operation_id
        && metadata.previousCommandHash===previous.command_hash
        && metadata.previousCancellationReceiptHash===previous.receipt_hash
        && (index===0 || Number(previous.ordinal)+1===metadata.ordinal),'authority_grant_attempt_lineage')
      const attemptRecord:NativeEmailAuthorityTransitionRecord={...record,grantAttempt:metadata,grantApproval:null}
      const request=prepareNativeEmailAuthorityCommand(nativeEmailAuthorityPhaseCommand(attemptRecord,'grant'))
      requireNativeEmail(same(attempt.command,request.command) && attempt.command_hash===request.commandHash
        && attempt.operation_id===request.command.operationId,'authority_stored_command_changed')
      const receipt=attempt.native_receipt===null?null:verifyNativeEmailAuthorityReceipt(request,attempt.native_receipt)
      requireNativeEmail(['prepared','dispatched','unknown','committed','cancelled'].includes(String(attempt.state))
        && ['committed','cancelled'].includes(String(attempt.state))===(receipt!==null)
        && (!receipt || receipt.state===attempt.state && nativeEmailAuthorityReceiptHash(receipt)===attempt.receipt_hash),
      'authority_stored_receipt_changed')
      attemptRecord.grant={state:attempt.state as NativeEmailAuthorityTransitionRecord['grant']['state'],receipt}
      if(attempt.approval_envelope)this.checkEnvelope(attemptRecord,'grant',attempt.approval_envelope as NativeEmailAuthorityApprovalEnvelope,control,false)
      if(attempt.approval_readback){
        const readback=verifyNativeEmailAuthorityApprovalReadback(request.command,attempt.approval_envelope as NativeEmailAuthorityApprovalEnvelope,attempt.approval_readback)
        attemptRecord.grantApproval={operationId:readback.operationId,commandHash:readback.commandHash,appCommitFingerprint:readback.appCommitFingerprint!}
      }
      Object.assign(record,attemptRecord)
      previous=attempt
    }
    if(attempts.length)phases.grant=attempts[attempts.length-1]
    return {control,row,phases,record}
  }
  private appReceipt(plan:NativeEmailAuthorityTransitionPlan,receipt:NativeEmailAuthorityReceipt):NativeEmailAppAuthorityCommitReceipt {
    requireNativeEmail(receipt.state==='committed','authority_revoke_not_committed')
    return {version:1,transitionId:plan.revoke.transitionId,planHash:plan.planHash,desiredAppChangeHash:plan.revoke.desiredAppChangeHash,
      revokeReceiptHash:nativeEmailAuthorityReceiptHash(receipt),appAuthorityBeforeFingerprint:plan.expectedAppAuthorityBeforeFingerprint,
      appAuthorityAfterFingerprint:plan.expectedAppAuthorityAfterFingerprint}
  }
  private async authorize(tx:NativeEmailSqlClient,stored:Stored,active=true){
    if(active)this.active(stored.control,stored.record.plan)
    await this.validateAuthority(tx,stored.record.plan,stored.record.appCommit?'after':'before')
    await this.validatePolicies(tx,stored.record.plan,Number(stored.control.generation))
  }
  async admit(input:NativeEmailAuthorityTransitionInput):Promise<NativeEmailAuthorityTransitionRecord>{
    const plan=prepareNativeEmailAuthorityTransition(input),id=plan.revoke.transitionId
    return this.transaction(async tx=>{
      const control=await this.control(tx)
      const existing=await tx.query('SELECT plan_hash FROM crm_native_email_authority_transitions WHERE transition_id=$1',[id])
      if(existing.rows.length){requireNativeEmail(existing.rows[0].plan_hash===plan.planHash,'authority_transition_conflict')
        const stored=await this.read(tx,control,id);await this.authorize(tx,stored,stored.record.grant.state!=='committed' && stored.row.app_state!=='aborted');return stored.record}
      requireNativeEmail(control.enabled===true && control.active_transition_id===null && control.active_operation_id===null
        && Number(control.generation)===plan.revoke.generationFrom && Number(control.verified_generation)===plan.revoke.generationFrom
        && control.native_policy_fingerprint===plan.revoke.beforePolicyFingerprint,'authority_admission_control_changed')
      const change=await this.validateAuthority(tx,plan,'before')
      await this.validatePolicies(tx,plan,Number(control.generation))
      await tx.query(`INSERT INTO crm_native_email_authority_transitions(transition_id,plan_hash,desired_change_hash,plan,actor_email)
        VALUES($1,$2,$3,$4::jsonb,$5)`,[id,plan.planHash,plan.revoke.desiredAppChangeHash,nativeEmailCanonicalJson(plan),this.options.actorEmail])
      for(const phase of ['revoke','grant'] as const)await tx.query(`INSERT INTO crm_native_email_authority_phases
        (transition_id,phase,operation_id,command_hash,command) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [id,phase,plan[phase].operationId,nativeEmailDigest(plan[phase]),nativeEmailCanonicalJson(plan[phase])])
      if(change.kind==='root_registry_v1'){
        await tx.query(`INSERT INTO crm_native_email_authority_root_changes
          (transition_id,ordinal,registry_table,operator_account_id,row_key,before_row,after_row)
          SELECT $1,ordinal,registry_table,operator_account_id,row_key,before_row,after_row
          FROM clawpilot_crm_root_registry_change_rows($2::jsonb)`,[id,nativeEmailCanonicalJson(change)])
      }else if(change.kind==='workspace_user_eligibility_v1'||change.kind==='user_identity_link_v1'){
        await tx.query(`INSERT INTO crm_native_email_authority_user_changes
          (transition_id,ordinal,source_table,user_email,organization_id,before_row,after_row)
          SELECT $1,ordinal,source_table,user_email,organization_id,before_row,after_row
          FROM clawpilot_native_email_user_change_rows($2::jsonb)`,[id,nativeEmailCanonicalJson(change)])
      }else for(const [ordinal,delta] of change.changes.entries()){
        const row=(delta.before??delta.after)!
        await tx.query(`INSERT INTO crm_native_email_authority_member_changes(transition_id,ordinal,pipeline_id,user_email,before_row,after_row)
          VALUES($1,$2,$3::uuid,$4,$5::jsonb,$6::jsonb)`,[id,ordinal,row.pipeline_id,row.user_email,
          delta.before===null?null:nativeEmailCanonicalJson(delta.before),delta.after===null?null:nativeEmailCanonicalJson(delta.after)])
      }
      await tx.query('UPDATE crm_native_email_publication_control SET active_transition_id=$1,updated_at=clock_timestamp() WHERE singleton',[id])
      return (await this.read(tx,await this.control(tx),id)).record
    })
  }
  async load(id:string){return this.transaction(async tx=>{const stored=await this.read(tx,await this.control(tx),id)
    await this.authorize(tx,stored,false);return immutable(stored.record)})}
  private checkEnvelope(record:NativeEmailAuthorityTransitionRecord,phase:Phase,envelope:NativeEmailAuthorityApprovalEnvelope,control:JsonRow,fresh:boolean){
    exact(envelope,['proof','signature'])
    const p=envelope.proof,c=nativeEmailAuthorityPhaseCommand(record,phase),retry=phase==='grant' && !!record.grantAttempt
    exact(p,['version','purpose','issuer','audience','keyId','nativeInstanceId','issuedAt','expiresAt','operationId','transitionId','planHash',
      'commandHash','desiredAppChangeHash','phase','serviceUserId','oauthClientId','revokeOperationId','revokeCommandHash','appCommit',
      ...(retry?['grantAttempt']:[])])
    requireNativeEmail(p.version===(retry?2:1) && (!retry || 'grantAttempt' in p && same(p.grantAttempt,record.grantAttempt))
      && p.purpose==='clawpilot-native-email-authority-approval' && p.issuer==='clawpilot-pg-authority'
      && p.audience==='clawpilot-suitecrm-authority' && p.operationId===c.operationId && p.transitionId===c.transitionId
      && p.planHash===record.plan.planHash && p.commandHash===nativeEmailDigest(c) && p.desiredAppChangeHash===c.desiredAppChangeHash
      && p.phase===phase && Object.entries(this.options.approvalIdentity).every(([field,value])=>p[field as keyof typeof this.options.approvalIdentity]===value)
      && Number.isSafeInteger(p.issuedAt) && Number.isSafeInteger(p.expiresAt) && p.issuedAt>0 && p.expiresAt>p.issuedAt
      && p.expiresAt-p.issuedAt<=300 && (!fresh || p.issuedAt<=Number(control.now_epoch)+30 && p.expiresAt>Number(control.now_epoch))
      && typeof envelope.signature==='string' && /^[A-Za-z0-9+/]{512}(?![\s\S])/.test(envelope.signature),'authority_approval_changed')
    requireNativeEmail(phase==='revoke' ? p.appCommit===null && p.revokeOperationId===null && p.revokeCommandHash===null
      : record.appCommit!==null && same(p.appCommit,record.appCommit) && p.revokeOperationId===record.plan.revoke.operationId
        && p.revokeCommandHash===nativeEmailDigest(record.plan.revoke),'authority_approval_commit_changed')
  }
  private async updatePhase(tx:NativeEmailSqlClient,stored:Stored,phase:Phase,assignments:string,values:unknown[]=[]){
    const retry=phase==='grant' && !!stored.record.grantAttempt
    const table=retry?'crm_native_email_authority_grant_attempts':'crm_native_email_authority_phases'
    const field=retry?'ordinal':'phase',selector=retry?stored.record.grantAttempt!.ordinal:phase
    // assignments and identifiers are internal literals, never caller input.
    await tx.query(`UPDATE ${table} SET ${assignments},updated_at=clock_timestamp() WHERE transition_id=$1 AND ${field}=$2`,
      [stored.record.plan.revoke.transitionId,selector,...values])
  }
  async issueApproval(id:string,phase:Phase,create:(record:NativeEmailAuthorityTransitionRecord)=>NativeEmailAuthorityApprovalEnvelope){
    return this.transaction(async tx=>{
      const stored=await this.read(tx,await this.control(tx),id)
      const p=stored.phases[phase]
      await this.authorize(tx,stored,!p?.approval_envelope)
      if(p?.approval_envelope)return clone(p.approval_envelope as NativeEmailAuthorityApprovalEnvelope)
      requireNativeEmail(p && stored.record[phase].state==='prepared' && (phase==='revoke'?!stored.record.appCommit:!!stored.record.appCommit),
        'authority_approval_phase_not_prepared')
      const envelope=create(immutable(clone(stored.record)))
      this.checkEnvelope(stored.record,phase,envelope,stored.control,true)
      await this.updatePhase(tx,stored,phase,'approval_envelope=$3::jsonb',[nativeEmailCanonicalJson(envelope)])
      return clone(envelope)
    })
  }
  /** Internal authenticated transport result only, never a user POST body. */
  async recordApprovalReadback(id:string,phase:Phase,value:unknown){
    return this.transaction(async tx=>{
      const stored=await this.read(tx,await this.control(tx),id);await this.authorize(tx,stored)
      const p=stored.phases[phase]
      requireNativeEmail(p?.approval_envelope && stored.record[phase].state==='prepared','authority_approval_not_issued')
      const readback={...verifyNativeEmailAuthorityApprovalReadback(nativeEmailAuthorityPhaseCommand(stored.record,phase),p.approval_envelope as NativeEmailAuthorityApprovalEnvelope,value),replayed:false}
      if(p.approval_readback)requireNativeEmail(same(p.approval_readback,readback),'authority_approval_readback_conflict')
      else await this.updatePhase(tx,stored,phase,'approval_readback=$3::jsonb',[nativeEmailCanonicalJson(readback)])
      return clone(readback)
    })
  }
  private phaseReady(stored:Stored,phase:Phase){
    requireNativeEmail(['revoke','grant'].includes(phase),'authority_phase_invalid')
    requireNativeEmail(phase==='revoke'?stored.record.appCommit===null:
      stored.record.revoke.state==='committed' && !!stored.record.appCommit && !!stored.record.grantApproval,'authority_phase_order')
    const command=nativeEmailAuthorityPhaseCommand(stored.record,phase)
    requireNativeEmail(Number(stored.control.generation)===command.generationFrom
      && stored.control.native_policy_fingerprint===command.beforePolicyFingerprint,'authority_phase_generation_changed')
  }
  async claimPhase(id:string,phase:Phase,owner:string){
    requireNativeEmail(typeof owner==='string' && UUID.test(owner),'authority_lease_owner_invalid')
    return this.transaction(async tx=>{
      const stored=await this.read(tx,await this.control(tx),id);await this.authorize(tx,stored);this.phaseReady(stored,phase)
      const p=stored.phases[phase]
      requireNativeEmail(['prepared','dispatched','unknown'].includes(String(p.state)) && p.approval_readback,'authority_phase_not_claimable')
      // An expired immutable approval is never re-signed or executed. Exact
      // resolve/cancel is still permitted, so expiry cannot strand the barrier.
      const action=p.state==='prepared' && (p.approval_envelope as NativeEmailAuthorityApprovalEnvelope).proof.expiresAt>Number(stored.control.now_epoch)
        ?'execute' as const:'resolve' as const
      if(action==='execute')this.checkEnvelope(stored.record,phase,p.approval_envelope as NativeEmailAuthorityApprovalEnvelope,stored.control,true)
      let fence=Number(p.lease_fence)
      if(p.lease_live)requireNativeEmail(p.lease_owner===owner,'authority_lease_busy')
      else{fence++;requireNativeEmail(Number.isSafeInteger(fence),'authority_lease_fence_exhausted')
        await this.updatePhase(tx,stored,phase,`lease_owner=$3::uuid,lease_fence=$4,
          lease_until=clock_timestamp()+($5::int*interval '1 second')`,[owner,fence,this.leaseSeconds])}
      if(p.state==='prepared')await this.updatePhase(tx,stored,phase,"state='dispatched'")
      return {record:(await this.read(tx,stored.control,id)).record,claim:{owner,fence},action}
    })
  }
  private claim(stored:Stored,phase:Phase,claim:NativeEmailAuthorityClaim){
    requireNativeEmail(stored.phases[phase]?.lease_live===true && stored.phases[phase].lease_owner===claim.owner
      && Number(stored.phases[phase].lease_fence)===claim.fence && Number.isSafeInteger(claim.fence),'authority_lease_stale')
  }
  async markUnknown(id:string,phase:Phase,claim:NativeEmailAuthorityClaim){
    await this.transaction(async tx=>{const stored=await this.read(tx,await this.control(tx),id);await this.authorize(tx,stored)
      this.phaseReady(stored,phase);this.claim(stored,phase,claim)
      requireNativeEmail(['dispatched','unknown'].includes(stored.record[phase].state),'authority_unknown_not_dispatched')
      if(stored.record[phase].state!=='unknown')await this.updatePhase(tx,stored,phase,"state='unknown'")})
  }
  async settlePhase(id:string,phase:Phase,claim:NativeEmailAuthorityClaim,value:NativeEmailAuthorityReceipt){
    return this.transaction(async tx=>{
      const stored=await this.read(tx,await this.control(tx),id)
      const receipt=verifyNativeEmailAuthorityReceipt(prepareNativeEmailAuthorityCommand(nativeEmailAuthorityPhaseCommand(stored.record,phase)),value)
      if(stored.record[phase].receipt){await this.authorize(tx,stored,false)
        requireNativeEmail(nativeEmailAuthorityReceiptHash(stored.record[phase].receipt!)===nativeEmailAuthorityReceiptHash(receipt),'authority_receipt_conflict');return stored.record}
      await this.authorize(tx,stored);this.phaseReady(stored,phase);this.claim(stored,phase,claim)
      requireNativeEmail(['dispatched','unknown'].includes(stored.record[phase].state),'authority_settle_not_dispatched')
      await this.updatePhase(tx,stored,phase,'state=$3,native_receipt=$4::jsonb,receipt_hash=$5',
        [receipt.state,nativeEmailCanonicalJson({...receipt,replayed:false}),nativeEmailAuthorityReceiptHash(receipt)])
      if(receipt.state==='committed'){
        const c=nativeEmailAuthorityPhaseCommand(stored.record,phase)
        if(c.version===2)for(const pair of c.bindings){
          const binding=pair.after
          if(!('capability_policy_json' in binding) || binding.capability_policy_json===null)continue
          requireNativeEmail('capability_policy_fingerprint' in binding,'authority_policy_binding_missing')
          const updated=await tx.query(`UPDATE crm_native_email_capability_policies SET generation=$2,policy=$3::jsonb,fingerprint=$4
            WHERE pipeline_id=$1::uuid RETURNING pipeline_id`,[binding.pipeline_id,c.generationTo,binding.capability_policy_json,binding.capability_policy_fingerprint])
          requireNativeEmail(updated.rows.length===1,'authority_policy_update_missing')
        }
        await tx.query(`UPDATE crm_native_email_publication_control SET generation=$1,verified_generation=$1,native_policy_fingerprint=$2,
          activation_receipt_hash=$3,active_transition_id=CASE WHEN $4='grant' THEN NULL ELSE active_transition_id END,updated_at=clock_timestamp() WHERE singleton`,
        [c.generationTo,c.afterPolicyFingerprint,nativeEmailAuthorityReceiptHash(receipt),phase])
        await this.validatePolicies(tx,stored.record.plan,c.generationTo)
      }
      return (await this.read(tx,await this.control(tx),id)).record
    })
  }
  async commitAppChange(id:string,expectedPlanHash:string){
    return this.transaction(async tx=>{
      const stored=await this.read(tx,await this.control(tx),id)
      requireNativeEmail(stored.record.plan.planHash===expectedPlanHash,'authority_app_plan_changed')
      if(stored.record.appCommit){await this.authorize(tx,stored,false);return stored.record}
      await this.authorize(tx,stored)
      requireNativeEmail(stored.record.revoke.state==='committed' && stored.record.revoke.receipt
        && stored.record.grant.state==='prepared' && Number(stored.control.generation)===stored.record.plan.revoke.generationTo
        && stored.control.native_policy_fingerprint===stored.record.plan.revoke.afterPolicyFingerprint,'authority_app_commit_before_revoke')
      const change=prepareNativeEmailAppAuthorityChange(stored.record.plan.desiredAppChange)
      await tx.query("UPDATE crm_native_email_authority_transitions SET app_state='applying',applying_xid=txid_current(),updated_at=clock_timestamp() WHERE transition_id=$1",[id])
      if(change.kind==='root_registry_v1'){
        for(const delta of change.changes){
          const row=JSON.parse(delta.afterJson) as JsonRow
          const table=delta.table==='account'?'crm_operator_accounts':delta.table==='binding'?'crm_operator_workspace_bindings':'crm_root_employee_access_grants'
          const columns=delta.table==='account'?['id','root_workspace_id','owner_email','enabled','revision']
            :delta.table==='binding'?['operator_account_id','workspace_id','owner_email','enabled','revision']
              :['id','operator_account_id','user_email','source_workspace_id','enabled','revision']
          let updated
          if(delta.beforeJson===null)updated=await tx.query(`INSERT INTO ${table}(${columns.join(',')},created_by,updated_by)
            SELECT ${columns.map(key=>'r.'+key).join(',')},$2,$2 FROM jsonb_populate_record(NULL::${table},$1::jsonb) r RETURNING 1`,
          [delta.afterJson,this.options.actorEmail])
          else updated=await tx.query(`UPDATE ${table} SET enabled=($1::jsonb->>'enabled')::boolean,
            revision=($1::jsonb->>'revision')::bigint,updated_by=$2,updated_at=clock_timestamp()
            WHERE ${delta.table==='binding'?'workspace_id':'id'}=$3::uuid
              ${delta.table==='account'?'':'AND operator_account_id=$4::uuid'} RETURNING 1`,delta.table==='account'
                ?[delta.afterJson,this.options.actorEmail,row.id]:[delta.afterJson,this.options.actorEmail,
                  delta.table==='binding'?row.workspace_id:row.id,change.operatorAccountId])
          requireNativeEmail(updated.rows.length===1,'authority_root_registry_row_missing')
        }
      }else if(change.kind==='user_identity_link_v1'){
        const updated=await tx.query(`UPDATE app_users SET suitecrm_user_id=$2,suitecrm_username=$3,updated_at=clock_timestamp()
          WHERE email=$1 RETURNING email`,[change.userEmail,change.nativeIdentity.userId,change.nativeIdentity.username])
        requireNativeEmail(updated.rows.length===1,'authority_identity_user_missing')
      }else if(change.kind==='workspace_user_eligibility_v1'){
        const member=JSON.parse(change.membership.afterJson),user=JSON.parse(change.appUser.afterJson)
        await tx.query(`UPDATE app_user_organization_memberships SET status=$3,role=$4,permissions=$5::jsonb,
          trashed_at=$6::timestamptz,trashed_by=$7,pre_trash_status=$8,updated_by=$9,updated_at=clock_timestamp()
          WHERE user_email=$1 AND organization_id=$2::uuid`,[change.userEmail,change.workspaceId,member.status,member.role,
          nativeEmailEligibilityRowJson(member.permissions),member.trashed_at,member.trashed_by,member.pre_trash_status,this.options.actorEmail])
        if(change.demoMembership){const demo=JSON.parse(change.demoMembership.beforeJson)
          await tx.query('DELETE FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2::uuid',[change.userEmail,demo.organization_id])}
        if(change.appUser.beforeJson!==change.appUser.afterJson)await tx.query(
          'UPDATE app_users SET status=$2,updated_at=clock_timestamp() WHERE email=$1',[change.userEmail,user.status])
      }else for(const delta of change.changes){
        if(delta.before && delta.after)await tx.query(`UPDATE pipeline_space_members SET access_role=$3,updated_at=$4::timestamptz
          WHERE pipeline_id=$1::uuid AND user_email=$2`,[delta.after.pipeline_id,delta.after.user_email,delta.after.access_role,delta.after.updated_at])
        else if(delta.after)await tx.query('INSERT INTO pipeline_space_members SELECT (jsonb_populate_record(NULL::pipeline_space_members,$1::jsonb)).*',[nativeEmailCanonicalJson(delta.after)])
        else await tx.query('DELETE FROM pipeline_space_members WHERE pipeline_id=$1::uuid AND user_email=$2',[delta.before!.pipeline_id,delta.before!.user_email])
      }
      await this.validateAuthority(tx,stored.record.plan,'after')
      // Internal caller only, within the same exact-delta transaction. A failed
      // audit/permission-sync enqueue rolls back the app change and its receipt.
      if(this.appCommitEffects)await this.appCommitEffects(tx,change)
      const receipt=this.appReceipt(stored.record.plan,stored.record.revoke.receipt)
      await tx.query("UPDATE crm_native_email_authority_transitions SET app_state='committed',applying_xid=NULL,app_commit=$2::jsonb,updated_at=clock_timestamp() WHERE transition_id=$1",
        [id,nativeEmailCanonicalJson(receipt)])
      return (await this.read(tx,stored.control,id)).record
    })
  }
  /** A retained authenticated cancellation, never TTL/absence, admits a new
   * grant identity. Exact parent selection makes concurrent retries idempotent.
   * Native content, memberships, generations and app receipt remain unchanged. */
  async retryCancelledGrant(id:string,expectedOperationId:string){
    requireNativeEmail(typeof expectedOperationId==='string' && HASH.test(expectedOperationId),'authority_grant_retry_identity')
    return this.transaction(async tx=>{
      const stored=await this.read(tx,await this.control(tx),id)
      const command=nativeEmailAuthorityPhaseCommand(stored.record,'grant')
      if(command.operationId!==expectedOperationId){
        await this.authorize(tx,stored,stored.record.grant.state!=='committed')
        requireNativeEmail(stored.record.grantAttempt?.previousOperationId===expectedOperationId
          && stored.record.grant.state!=='cancelled','authority_grant_retry_stale')
        return immutable(stored.record)
      }
      await this.authorize(tx,stored)
      requireNativeEmail(stored.row.app_state==='committed' && stored.record.appCommit
        && stored.record.revoke.state==='committed' && stored.record.grant.state==='cancelled'
        && stored.record.grant.receipt?.state==='cancelled'
        && stored.phases.grant.approval_envelope && stored.phases.grant.approval_readback
        && Number(stored.control.generation)===command.generationFrom
        && stored.control.native_policy_fingerprint===command.beforePolicyFingerprint,'authority_grant_retry_not_cancelled')
      const grantAttempt:NativeEmailGrantAttempt={ordinal:(stored.record.grantAttempt?.ordinal??0)+1,
        originalOperationId:stored.record.plan.grant.operationId,originalCommandHash:nativeEmailDigest(stored.record.plan.grant),
        previousOperationId:command.operationId,previousCommandHash:nativeEmailDigest(command),
        previousCancellationReceiptHash:nativeEmailAuthorityReceiptHash(stored.record.grant.receipt)}
      requireNativeEmail(grantAttempt.ordinal<=10000,'authority_grant_attempt_bound')
      const next=nativeEmailAuthorityPhaseCommand({...stored.record,grantAttempt},'grant')
      await tx.query(`INSERT INTO crm_native_email_authority_grant_attempts
        (transition_id,phase,ordinal,grant_attempt,operation_id,command_hash,command)
        VALUES($1,'grant',$2,$3::jsonb,$4,$5,$6::jsonb)`,[id,grantAttempt.ordinal,nativeEmailCanonicalJson(grantAttempt),
        next.operationId,nativeEmailDigest(next),nativeEmailCanonicalJson(next)])
      return immutable((await this.read(tx,stored.control,id)).record)
    })
  }
  /** Exact retained native cancellation only. No timeout, lost response or
   * missing row constitutes cancellation, and cancelled grants cannot use this. */
  async closeCancelledRevoke(id:string){
    return this.transaction(async tx=>{
      const stored=await this.read(tx,await this.control(tx),id)
      await this.authorize(tx,stored,stored.row.app_state!=='aborted')
      if(stored.row.app_state==='aborted')return {aborted:true as const,record:stored.record}
      requireNativeEmail(stored.row.app_state==='prepared' && stored.record.revoke.state==='cancelled'
        && stored.record.revoke.receipt?.state==='cancelled' && stored.record.appCommit===null
        && stored.record.grant.state==='prepared' && stored.phases.grant.approval_envelope===null
        && stored.phases.grant.approval_readback===null && stored.phases.grant.lease_owner===null
        && Number(stored.control.generation)===stored.record.plan.revoke.generationFrom
        && stored.control.native_policy_fingerprint===stored.record.plan.revoke.beforePolicyFingerprint,'authority_abort_not_safe')
      const applied=await tx.query('SELECT count(*)::int AS count FROM crm_native_email_authority_member_changes WHERE transition_id=$1 AND applied',[id])
      requireNativeEmail(applied.rows[0]?.count===0,'authority_abort_app_changed')
      if(['workspace_user_eligibility_v1','user_identity_link_v1'].includes(String((stored.record.plan.desiredAppChange as JsonRow).kind))){
        const userApplied=await tx.query('SELECT count(*)::int AS count FROM crm_native_email_authority_user_changes WHERE transition_id=$1 AND applied',[id])
        requireNativeEmail(userApplied.rows[0]?.count===0,'authority_abort_app_changed')
      }
      if((stored.record.plan.desiredAppChange as JsonRow).kind==='root_registry_v1'){
        const rootApplied=await tx.query('SELECT count(*)::int AS count FROM crm_native_email_authority_root_changes WHERE transition_id=$1 AND applied',[id])
        requireNativeEmail(rootApplied.rows[0]?.count===0,'authority_abort_app_changed')
      }
      await tx.query("UPDATE crm_native_email_authority_transitions SET app_state='aborted',updated_at=clock_timestamp() WHERE transition_id=$1",[id])
      await tx.query('UPDATE crm_native_email_publication_control SET active_transition_id=NULL,updated_at=clock_timestamp() WHERE singleton')
      return {aborted:true as const,record:stored.record}
    })
  }
}
