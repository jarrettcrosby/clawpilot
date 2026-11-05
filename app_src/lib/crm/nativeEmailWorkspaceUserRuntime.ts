import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { withTransaction } from '../persistence/postgres'
import { lockCrmNativeEmailAuthorityWithClient } from '../persistence/crmNativeEmailAuthority'
import { recordAuditEvent } from '../auditWriter'
import { removeWorkspaceFromPendingInvitationsWithClient } from '../invitationWorkspaceScope'
import { nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'
import { PostgresNativeEmailAuthorityTransitionStore } from './nativeEmailAuthorityTransitionPostgres'
import { createSuiteCrmNativeEmailAuthorityClient } from './nativeEmailAuthorityTransport'
import { buildNativeEmailMemberTransition, readNativeEmailAuthorityInspection } from './nativeEmailAuthorityPlan'
import { NativeEmailAccessPendingError, nativeEmailAuthorityConfiguration, resumeNativeEmailAuthorityChange } from './nativeEmailAuthorityRuntime'
import { normalizeNativeEmailWorkspaceUserEligibilityRequest, prepareNativeEmailWorkspaceUserEligibilityChange,
  type NativeEmailWorkspaceUserEligibilityRequest } from './nativeEmailWorkspaceUserEligibility'
import { normalizeNativeEmailUserIdentityLinkRequest, prepareNativeEmailUserIdentityLinkChange,
  type NativeEmailUserIdentityLinkRequest } from './nativeEmailIdentityLinkChange'

/** First link to an already-existing canonical native account. The normal
 * users workflow supplies an independently inspected ID, never browser-sent
 * permissions. Both native phases verify its exact metadata again. A later
 * identical sync resumes the retained operation even after the local mapping
 * committed; it cannot report success while the grant outcome is unknown. */
export async function linkExistingUserWithNativeAuthority(actorEmail:string,request:NativeEmailUserIdentityLinkRequest,
  actorWorkspaceId?:string|null,expectedTransitionId?:string):Promise<boolean>{
  let transitionId:string|null=null
  try{
    request=normalizeNativeEmailUserIdentityLinkRequest(request)
    if(expectedTransitionId!==undefined)requireNativeEmail(/^[a-f0-9]{64}(?![\s\S])/.test(expectedTransitionId),'authority_resume_identity_invalid')
    requireNativeEmail(typeof actorEmail==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(actorEmail)
      &&actorEmail===actorEmail.toLowerCase(),'authority_identity_actor_invalid')
    const selected=await withTransaction(async tx=>{
      await lockCrmNativeEmailAuthorityWithClient(tx)
      const control=(await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton')).rows[0]
      requireNativeEmail(control&&typeof control.enabled==='boolean','authority_control_missing')
      if(!control.enabled){requireNativeEmail(expectedTransitionId===undefined,'authority_resume_changed');return {legacy:true as const}}
      requireNativeEmail(control.active_operation_id===null,'authority_publication_not_drained')
      if(expectedTransitionId!==undefined){
        requireNativeEmail(control.active_transition_id===null||control.active_transition_id===expectedTransitionId,'authority_resume_changed')
        return {legacy:false as const,activeId:expectedTransitionId}
      }
      if(control.active_transition_id)return {legacy:false as const,activeId:String(control.active_transition_id)}
      return {legacy:false as const}
    })
    if(selected.legacy)return false
    const config=nativeEmailAuthorityConfiguration(),client=createSuiteCrmNativeEmailAuthorityClient(config)
    const store=new PostgresNativeEmailAuthorityTransitionStore(withTransaction,{actorEmail,actorWorkspaceId:actorWorkspaceId??undefined,
      approvalIdentity:{keyId:config.keyId,nativeInstanceId:config.nativeInstanceId,serviceUserId:config.serviceUserId,oauthClientId:config.clientId}},
    async(tx,value)=>{
      const change=prepareNativeEmailUserIdentityLinkChange(value)
      requireNativeEmail(change.workspaceId===request.workspaceId&&change.userEmail===request.userEmail
        &&nativeEmailDigest(change.nativeIdentity)===nativeEmailDigest(request.nativeIdentity),'authority_identity_effect_scope')
      // Mapping can enable native reads. Rotate out pre-existing app sessions;
      // local module grants, memberships and invitations remain unchanged.
      await tx.query(`UPDATE app_sessions SET revoked_at=COALESCE(revoked_at,now()),revoked_reason='crm_identity_linked'
        WHERE effective_user_email=$1 AND revoked_at IS NULL`,[change.userEmail])
      await recordAuditEvent({actor:actorEmail,eventType:'user.crm_identity.synced',aggregateType:'app_user',aggregateId:change.userEmail,
        subject:change.userEmail,organizationId:change.workspaceId,payload:{referenceCode:change.nativeIdentity.globalId,
          suiteCrmUsername:change.nativeIdentity.username,identitySync:'mapping_committed',nativeGrantPending:true,nativeAuthority:true,transitionId}},tx as PoolClient)
    })
    if('activeId' in selected){
      const active=await store.load(selected.activeId!),change=prepareNativeEmailUserIdentityLinkChange(active.plan.desiredAppChange)
      requireNativeEmail(change.workspaceId===request.workspaceId&&change.userEmail===request.userEmail
        &&nativeEmailDigest(change.nativeIdentity)===nativeEmailDigest(request.nativeIdentity),'authority_other_change_pending')
      transitionId=selected.activeId!
    }else{
      const inspection=readNativeEmailAuthorityInspection(await client.inspect())
      const app=await store.previewUserIdentityLink(request,inspection.bindings.map(binding=>binding.pipeline_id))
      const proposedId=nativeEmailDigest(['existing-user-identity-link',randomUUID()])
      const plan=await buildNativeEmailMemberTransition({app,inspection,transitionId:proposedId,timestamp:new Date().toISOString().slice(0,19).replace('T',' '),
        newMembershipId:randomUUID,forecast:client.project})
      const {planHash,...input}=plan;void planHash
      await store.admit(input)
      transitionId=proposedId
    }
    return await resumeNativeEmailAuthorityChange({store,client,config,transitionId})
  }catch(error){
    if(error instanceof NativeEmailAccessPendingError)throw error
    throw new NativeEmailAccessPendingError(transitionId)
  }
}

/** Resume from the exact owned durable selection, not from another provider
 * account lookup. In particular an already-committed local mapping cannot
 * hide an unknown native grant, and a temporary general-CRM lookup outage
 * cannot strand receipt resolution using the dedicated authority client. */
export async function resumePendingExistingUserIdentityWithNativeAuthority(actorEmail:string,workspaceId:string,userEmail:string,
  expectedTransitionId:string,actorWorkspaceId?:string|null):Promise<true>{
  try{
    requireNativeEmail(/^[a-f0-9]{64}(?![\s\S])/.test(expectedTransitionId),'authority_resume_identity_invalid')
    const desired=await withTransaction(async tx=>{
      await lockCrmNativeEmailAuthorityWithClient(tx)
      const control=(await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton')).rows[0]
      requireNativeEmail(control?.enabled===true&&control.active_operation_id===null
        &&(control.active_transition_id===null||control.active_transition_id===expectedTransitionId),'authority_resume_changed')
      const rows=(await tx.query(`SELECT plan->'desiredAppChange' AS desired FROM crm_native_email_authority_transitions
        WHERE transition_id=$1 AND actor_email=$2 AND plan->'desiredAppChange'->>'kind'='user_identity_link_v1'
          AND plan->'desiredAppChange'->>'workspaceId'=$3 AND plan->'desiredAppChange'->>'userEmail'=$4`,
      [expectedTransitionId,actorEmail,workspaceId,userEmail])).rows
      requireNativeEmail(rows.length===1,'authority_other_change_pending')
      return prepareNativeEmailUserIdentityLinkChange(rows[0].desired)
    })
    const complete=await linkExistingUserWithNativeAuthority(actorEmail,{workspaceId,userEmail,nativeIdentity:desired.nativeIdentity},
      actorWorkspaceId,expectedTransitionId)
    requireNativeEmail(complete,'authority_resume_changed');return true
  }catch(error){
    if(error instanceof NativeEmailAccessPendingError)throw error
    throw new NativeEmailAccessPendingError()
  }
}

/** The normal admin entrypoints call this before any access mutation. Only
 * disabled policy or an unmapped app-only user may use their legacy SQL path.
 * Enabled mapped changes must settle native revocation before the exact app
 * commit, with session revocation and audit in that same transaction. */
export async function changeWorkspaceUserWithNativeAuthority(
  actorEmail: string,
  request: NativeEmailWorkspaceUserEligibilityRequest,
  actorWorkspaceId?: string | null,
  expectedTransitionId?: string,
): Promise<boolean> {
  let transitionId: string | null = null
  try {
    const normalized=normalizeNativeEmailWorkspaceUserEligibilityRequest(request)
    if(expectedTransitionId!==undefined){
      requireNativeEmail(typeof expectedTransitionId==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(expectedTransitionId),'authority_resume_identity_invalid')
    }
    const selected=await withTransaction(async tx=>{
      await lockCrmNativeEmailAuthorityWithClient(tx)
      const control=(await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton')).rows[0]
      requireNativeEmail(control && typeof control.enabled==='boolean','authority_control_missing')
      if(expectedTransitionId!==undefined)requireNativeEmail(control.enabled
        && control.active_transition_id===expectedTransitionId,'authority_resume_changed')
      if(!control.enabled)return {legacy:true as const}
      requireNativeEmail(control.active_operation_id===null,'authority_publication_not_drained')
      if(control.active_transition_id)return {legacy:false as const,activeId:String(control.active_transition_id)}
      const target=(await tx.query('SELECT suitecrm_user_id FROM app_users WHERE email=$1',[normalized.userEmail])).rows
      requireNativeEmail(target.length===1,'authority_target_missing')
      if(target[0].suitecrm_user_id===null)return {legacy:true as const}
      return {legacy:false as const}
    })
    if(selected.legacy)return false
    const config=nativeEmailAuthorityConfiguration(),client=createSuiteCrmNativeEmailAuthorityClient(config)
    const store=new PostgresNativeEmailAuthorityTransitionStore(withTransaction,{actorEmail,actorWorkspaceId:actorWorkspaceId??undefined,approvalIdentity:{
      keyId:config.keyId,nativeInstanceId:config.nativeInstanceId,serviceUserId:config.serviceUserId,oauthClientId:config.clientId,
    }},async (tx,value)=>{
      const change=prepareNativeEmailWorkspaceUserEligibilityChange(value)
      requireNativeEmail(change.workspaceId===normalized.workspaceId && change.userEmail===normalized.userEmail
        && nativeEmailDigest(change.action)===nativeEmailDigest(normalized.action),'authority_user_effect_scope')
      const previous=JSON.parse(change.membership.beforeJson) as Record<string,unknown>
      const next=JSON.parse(change.membership.afterJson) as Record<string,unknown>
      // Scoped access edits invalidate existing app sessions, including those
      // with cached module grants. No canonical identity or foreign membership
      // changes here. Repeated committed requests do not repeat these effects.
      await tx.query(`UPDATE app_sessions SET revoked_at=COALESCE(revoked_at,now()),
        revoked_reason=$3 WHERE effective_user_email=$1 AND active_workspace_organization_id=$2::uuid
        AND revoked_at IS NULL`,[change.userEmail,change.workspaceId,
        change.action.kind==='trash'&&change.action.trashed?'workspace_user_trashed':'workspace_access_changed'])
      const invitationChanges=change.action.kind==='trash'&&change.action.trashed
        ?await removeWorkspaceFromPendingInvitationsWithClient(tx as PoolClient,
          {email:change.userEmail,organizationId:change.workspaceId}):null
      if(change.demoMembership){
        const demoWorkspaceId=JSON.parse(change.demoMembership.beforeJson).organization_id as string
        await tx.query(`UPDATE app_sessions SET revoked_at=COALESCE(revoked_at,now()),revoked_reason='demo_access_removed'
          WHERE effective_user_email=$1 AND active_workspace_organization_id=$2::uuid AND revoked_at IS NULL`,
        [change.userEmail,demoWorkspaceId])
      }
      await recordAuditEvent({actor:actorEmail,eventType:change.action.kind==='trash'
        ?change.action.trashed?'user.trashed':'user.restored'
        :change.action.kind==='access'?'user.access.updated':'user.status.updated',
      aggregateType:'app_user',aggregateId:change.userEmail,subject:change.userEmail,organizationId:change.workspaceId,
      payload:{organizationId:change.workspaceId,previousStatus:previous.status,status:next.status,
        previousRole:previous.role,role:next.role,
        ...(change.action.kind==='access'?{permissions:next.permissions}:{}),
        ...(invitationChanges?{invitationChanges}:{}),nativeAuthority:true,transitionId}},tx as PoolClient)
    })
    if('activeId' in selected){
      const pendingId=selected.activeId!
      const active=await store.load(pendingId)
      const change=prepareNativeEmailWorkspaceUserEligibilityChange(active.plan.desiredAppChange)
      requireNativeEmail(change.workspaceId===normalized.workspaceId && change.userEmail===normalized.userEmail
        && nativeEmailDigest(change.action)===nativeEmailDigest(normalized.action),'authority_other_change_pending')
      transitionId=pendingId
    }else{
      const inspection=readNativeEmailAuthorityInspection(await client.inspect())
      const app=await store.previewWorkspaceUserEligibility(request,inspection.bindings.map(binding=>binding.pipeline_id))
      if('unchanged' in app)return true
      transitionId=nativeEmailDigest(['workspace-user-eligibility',randomUUID()])
      const plan=await buildNativeEmailMemberTransition({app,inspection,transitionId,
        timestamp:new Date().toISOString().slice(0,19).replace('T',' '),newMembershipId:randomUUID,forecast:client.project})
      const {planHash,...input}=plan;void planHash
      await store.admit(input)
    }
    return await resumeNativeEmailAuthorityChange({store,client,config,transitionId})
  }catch(error){
    if(error instanceof NativeEmailAccessPendingError)throw error
    // Provider rows, SQL and permission evidence never reach browser errors.
    throw new NativeEmailAccessPendingError(transitionId)
  }
}
