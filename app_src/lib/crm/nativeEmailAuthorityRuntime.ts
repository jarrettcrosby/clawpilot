import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { withTransaction } from '../persistence/postgres'
import { lockCrmNativeEmailAuthorityWithClient } from '../persistence/crmNativeEmailAuthority'
import { enqueuePipelinePermissionSyncWithClient } from '../persistence/pipeline'
import { recordAuditEvent } from '../auditWriter'
import { nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'
import { PostgresNativeEmailAuthorityTransitionStore, prepareNativeEmailPipelineMemberChange,
  type NativeEmailPipelineMemberRow } from './nativeEmailAuthorityTransitionPostgres'
import { createNativeEmailAuthorityApprovalIssuer } from './nativeEmailAuthorityApproval'
import { createSuiteCrmNativeEmailAuthorityClient } from './nativeEmailAuthorityTransport'
import { createNativeEmailAuthorityTransitionCoordinator, nativeEmailAuthorityPhaseCommand } from './nativeEmailAuthorityTransition'
import { buildNativeEmailMemberTransition, readNativeEmailAuthorityInspection } from './nativeEmailAuthorityPlan'
import { nativeEmailPrincipalIsEligible } from './nativeEmailEligibility'

export class NativeEmailAccessPendingError extends Error {
  readonly status = 409
  readonly code = 'CRM_ACCESS_CHANGE_PENDING'
  constructor(readonly transitionId: string | null = null) {
    super('CRM access could not be confirmed yet. No unverified access was granted. An administrator may need to resume the pending change.')
    this.name = 'NativeEmailAccessPendingError'
  }
}
type Selection = { actorEmail: string; workspaceId: string; pipelineId: string; userEmail: string; accessRole: 'viewer'|'editor'|null }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function nativeEmailAuthorityConfiguration() {
  // Independent dedicated credentials. Never borrow the general CRM OAuth
  // client, generate a key on demand, activate policy, or fall back to legacy.
  const value = (key:string) => {
    const result = process.env['CLAWPILOT_NATIVE_EMAIL_AUTHORITY_' + key]
    requireNativeEmail(typeof result === 'string' && result.length > 0, 'authority_runtime_not_configured')
    return result
  }
  return { baseUrl:value('BASE_URL'),clientId:value('CLIENT_ID'),clientSecret:value('CLIENT_SECRET'),
    keyId:value('KEY_ID'),nativeInstanceId:value('INSTANCE_ID'),serviceUserId:value('SERVICE_USER_ID'),privateKey:value('PRIVATE_KEY') }
}
/** Resume only an already admitted exact operation. Sharing and user lifecycle
 * use the same bounded receipt/expiry recovery; neither may skip native proof,
 * recycle an expired approval, or unlock the app while an outcome is unknown. */
export async function resumeNativeEmailAuthorityChange(input: {
  store: PostgresNativeEmailAuthorityTransitionStore
  client: ReturnType<typeof createSuiteCrmNativeEmailAuthorityClient>
  config: ReturnType<typeof nativeEmailAuthorityConfiguration>
  transitionId: string
}): Promise<true> {
  const {store,client,config,transitionId}=input
  const issuer=createNativeEmailAuthorityApprovalIssuer(store,{...config,oauthClientId:config.clientId})
  const leaseOwner=randomUUID()
  const coordinator=createNativeEmailAuthorityTransitionCoordinator(store,client,leaseOwner)
  // A later identical authenticated request resumes the latest durable attempt.
  for(let step=0;step<6;step++){
    const record=await store.load(transitionId)
    if(record.grant.state==='committed')return true
    if(record.revoke.state==='cancelled'){
      await store.closeCancelledRevoke(transitionId)
      throw new NativeEmailAccessPendingError()
    }
    if(record.grant.state==='cancelled'){
      await store.retryCancelledGrant(transitionId,nativeEmailAuthorityPhaseCommand(record,'grant').operationId)
      continue
    }
    const phase=record.appCommit?'grant':'revoke'
    if(record[phase].state==='prepared'){
      const envelope=await issuer.issue(transitionId,phase)
      const command=nativeEmailAuthorityPhaseCommand(record,phase)
      if(envelope.proof.expiresAt<=Math.floor(Date.now()/1000)){
        const cancelled=await client.cancelExpired(command,envelope)
        await store.recordApprovalReadback(transitionId,phase,cancelled.approval)
        const claim=await store.claimPhase(transitionId,phase,leaseOwner)
        await store.settlePhase(transitionId,phase,claim.claim,cancelled.receipt)
        if(cancelled.receipt.state==='cancelled'){
          if(phase==='revoke'){
            await store.closeCancelledRevoke(transitionId)
            throw new NativeEmailAccessPendingError()
          }
          continue
        }
      }else await store.recordApprovalReadback(transitionId,phase,await client.approve(command,envelope))
    }
    const result=await coordinator.step(transitionId)
    if(result.state==='complete')return true
    if(result.state==='held'&&result.code==='authority_phase_cancelled')continue
    if(result.state==='held')throw new NativeEmailAccessPendingError(transitionId)
  }
  throw new NativeEmailAccessPendingError(transitionId)
}
/** Real sharing-path integration. Disabled policy is the only legacy return.
 * Enabled failures never fall through to a SQL member write. The original
 * actor and desired selection must match to resume an existing durable saga. */
export async function changePipelineMemberWithNativeAuthority(selection: Selection, expectedTransitionId?: string): Promise<boolean> {
  let transitionId: string | null = null
  try {
    requireNativeEmail(UUID.test(selection.workspaceId) && UUID.test(selection.pipelineId)
      && EMAIL.test(selection.actorEmail) && selection.actorEmail === selection.actorEmail.toLowerCase()
      && EMAIL.test(selection.userEmail) && selection.userEmail === selection.userEmail.toLowerCase()
      && ['viewer','editor',null].includes(selection.accessRole), 'authority_runtime_selection')
    if (expectedTransitionId !== undefined) requireNativeEmail(typeof expectedTransitionId === 'string'
      && /^[a-f0-9]{64}(?![\s\S])/.test(expectedTransitionId), 'authority_resume_identity_invalid')
    const selected = await withTransaction(async tx => {
      await lockCrmNativeEmailAuthorityWithClient(tx)
      const control = (await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton')).rows[0]
      requireNativeEmail(control && typeof control.enabled === 'boolean', 'authority_control_missing')
      if (expectedTransitionId !== undefined) requireNativeEmail(control.enabled
        && control.active_transition_id === expectedTransitionId, 'authority_resume_changed')
      if (!control.enabled) return { disabled:true as const }
      requireNativeEmail(control.active_operation_id === null, 'authority_publication_not_drained')
      const owner = (await tx.query(`SELECT p.owner_email,m.role,m.status,m.trashed_at,m.permissions,u.status AS user_status,
        u.suitecrm_user_id,(SELECT count(*)::int FROM app_users identity_user WHERE identity_user.suitecrm_user_id=u.suitecrm_user_id) AS native_identity_count
        FROM pipeline_spaces p JOIN app_user_organization_memberships m ON m.user_email=p.owner_email
          AND m.organization_id=p.workspace_organization_id JOIN app_users u ON u.email=p.owner_email
        WHERE p.id=$1::uuid AND p.workspace_organization_id=$2::uuid AND NOT p.reference_access_disabled`,
      [selection.pipelineId,selection.workspaceId])).rows[0]
      if (owner?.owner_email === selection.actorEmail && owner.suitecrm_user_id === null && owner.native_identity_count === 0) {
        requireNativeEmail(control.active_transition_id === null && control.active_initial_enrollment_id === null,
          'authority_unmanaged_scope_busy')
        const beforeValue: unknown = (await tx.query('SELECT to_jsonb(m) AS member FROM pipeline_space_members m WHERE pipeline_id=$1::uuid AND user_email=$2',
          [selection.pipelineId,selection.userEmail])).rows[0]?.member ?? null
        requireNativeEmail(beforeValue === null || typeof beforeValue === 'object' && !Array.isArray(beforeValue), 'authority_unmanaged_member_shape')
        const before = beforeValue as Record<string,unknown> | null
        const retained = (await tx.query('SELECT public.clawpilot_crm_native_unmanaged_pipeline_retained($1::uuid) AS unmanaged',
          [selection.pipelineId])).rows
        requireNativeEmail(retained.length === 1 && retained[0].unmanaged === true, 'authority_unmanaged_scope_unproven')
        if ((before?.access_role ?? null) === selection.accessRole) return { disabled:false as const,unchanged:true as const }
        const afterValue: unknown = selection.accessRole === null ? null : (await tx.query(`SELECT jsonb_build_object(
          'pipeline_id',$1::text,'user_email',$2::text,'access_role',$3::text,'shared_by',$4::text,
          'created_at',COALESCE($5::timestamptz,transaction_timestamp()),'updated_at',transaction_timestamp()) AS member`,
        [selection.pipelineId,selection.userEmail,selection.accessRole,before ? before.shared_by : selection.actorEmail,before?.created_at ?? null])).rows[0].member
        requireNativeEmail(afterValue === null || typeof afterValue === 'object' && !Array.isArray(afterValue), 'authority_unmanaged_member_shape')
        const after = afterValue as Record<string,unknown> | null
        const allowed = (await tx.query('SELECT public.clawpilot_crm_native_unmanaged_app_change($1,$2::jsonb,$3::jsonb) AS allowed',
          ['pipeline_space_members',before === null ? null : JSON.stringify(before),after === null ? null : JSON.stringify(after)])).rows
        requireNativeEmail(allowed.length === 1 && allowed[0].allowed === true, 'authority_unmanaged_change_denied')
        if (after === null) await tx.query('DELETE FROM pipeline_space_members WHERE pipeline_id=$1::uuid AND user_email=$2',
          [selection.pipelineId,selection.userEmail])
        else if (before) await tx.query(`UPDATE pipeline_space_members SET access_role=$3,updated_at=$4::timestamptz
          WHERE pipeline_id=$1::uuid AND user_email=$2`,[selection.pipelineId,selection.userEmail,selection.accessRole,after.updated_at])
        else await tx.query(`INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by,created_at,updated_at)
          VALUES($1::uuid,$2,$3,$4,$5::timestamptz,$6::timestamptz)`,
        [selection.pipelineId,selection.userEmail,selection.accessRole,after.shared_by,after.created_at,after.updated_at])
        await enqueuePipelinePermissionSyncWithClient(tx,{pipelineId:selection.pipelineId,actor:selection.actorEmail})
        await recordAuditEvent({actor:selection.actorEmail,eventType:after ? 'pipeline.space.shared' : 'pipeline.space.share.removed',
          aggregateType:'pipeline_space',aggregateId:selection.pipelineId,organizationId:selection.workspaceId,
          payload:{pipelineId:selection.pipelineId,userEmail:selection.userEmail,accessRole:selection.accessRole,
            organizationId:selection.workspaceId,unmanagedAppOnly:true,nativeAuthority:false}},tx)
        return {disabled:false as const,unmanaged:true as const}
      }
      requireNativeEmail(owner?.owner_email === selection.actorEmail && nativeEmailPrincipalIsEligible({
        email:owner.owner_email,status:owner.user_status,suitecrm_user_id:owner.suitecrm_user_id,native_identity_count:owner.native_identity_count,
        membership_role:owner.role,membership_status:owner.status,membership_trashed_at:owner.trashed_at,membership_permissions:owner.permissions,
      }) && selection.userEmail !== selection.actorEmail,
      'authority_actor_not_owner')
      if (control.active_transition_id) return { disabled:false as const,activeId:String(control.active_transition_id) }
      const existing = (await tx.query('SELECT to_jsonb(m) AS member FROM pipeline_space_members m WHERE pipeline_id=$1::uuid AND user_email=$2',
        [selection.pipelineId,selection.userEmail])).rows[0]?.member as NativeEmailPipelineMemberRow|undefined
      if ((existing?.access_role ?? null) === selection.accessRole) return { disabled:false as const,unchanged:true as const }
      const next = selection.accessRole === null ? null : (await tx.query(`SELECT jsonb_build_object(
        'pipeline_id',$1::text,'user_email',$2::text,'access_role',$3::text,'shared_by',$4::text,
        'created_at',COALESCE($5::timestamptz,transaction_timestamp()),'updated_at',transaction_timestamp()) AS member`,
      [selection.pipelineId,selection.userEmail,selection.accessRole,existing ? existing.shared_by : selection.actorEmail,
        existing?.created_at??null])).rows[0].member as NativeEmailPipelineMemberRow
      return { disabled:false as const,change:prepareNativeEmailPipelineMemberChange({ kind:'pipeline_members_v1',
        changes:[{ before:existing ?? null,after:next }] }) }
    })
    if (selected.disabled) return false
    if ('unmanaged' in selected) return true
    if ('unchanged' in selected) return true
    const config = nativeEmailAuthorityConfiguration(), client = createSuiteCrmNativeEmailAuthorityClient(config)
    const store = new PostgresNativeEmailAuthorityTransitionStore(withTransaction,
      { actorEmail:selection.actorEmail,approvalIdentity:{ keyId:config.keyId,nativeInstanceId:config.nativeInstanceId,
        serviceUserId:config.serviceUserId,oauthClientId:config.clientId } }, async (tx,change) => {
        requireNativeEmail(change.kind === 'pipeline_members_v1', 'authority_runtime_effect_kind')
        requireNativeEmail(change.changes.length === 1, 'authority_runtime_effect_scope')
        const delta = change.changes[0], row = (delta.after ?? delta.before)!
        requireNativeEmail(row.pipeline_id === selection.pipelineId && row.user_email === selection.userEmail,
          'authority_runtime_effect_scope')
        await enqueuePipelinePermissionSyncWithClient(tx as PoolClient,{ pipelineId:row.pipeline_id,actor:selection.actorEmail })
        await recordAuditEvent({ actor:selection.actorEmail,eventType:delta.after ? 'pipeline.space.shared' : 'pipeline.space.share.removed',
          aggregateType:'pipeline_space',aggregateId:row.pipeline_id,organizationId:selection.workspaceId,
          payload:{ pipelineId:row.pipeline_id,userEmail:row.user_email,accessRole:delta.after?.access_role ?? null,
            organizationId:selection.workspaceId,nativeAuthority:true } },tx as PoolClient)
      })
    if ('activeId' in selected) {
      const pendingId = selected.activeId!
      const active = await store.load(pendingId)
      const change = prepareNativeEmailPipelineMemberChange(active.plan.desiredAppChange)
      requireNativeEmail(change.changes.length === 1 && (change.changes[0].after ?? change.changes[0].before)!.pipeline_id === selection.pipelineId
        && (change.changes[0].after ?? change.changes[0].before)!.user_email === selection.userEmail
        && (change.changes[0].after?.access_role ?? null) === selection.accessRole, 'authority_other_change_pending')
      // The singleton ID is private until the owned, exact action is verified.
      transitionId = pendingId
    } else {
      requireNativeEmail('change' in selected && selected.change, 'authority_runtime_change_missing')
      const inspection = readNativeEmailAuthorityInspection(await client.inspect())
      const app = await store.previewMemberChange(selected.change,inspection.bindings.map(row => row.pipeline_id))
      transitionId = nativeEmailDigest(['pipeline-membership',randomUUID()])
      const plan = await buildNativeEmailMemberTransition({ app,inspection,transitionId,
        timestamp:new Date().toISOString().slice(0,19).replace('T',' '),newMembershipId:randomUUID,forecast:client.project })
      // The store independently derives the hash from the exact input shape.
      const {planHash,...input}=plan;void planHash
      await store.admit(input)
    }
    return await resumeNativeEmailAuthorityChange({store,client,config,transitionId})
  } catch (error) {
    if (error instanceof NativeEmailAccessPendingError) throw error
    // Preserve a resumable ID without leaking native rows, signatures, SQL or
    // credential configuration to the browser. Durable evidence retains cause.
    throw new NativeEmailAccessPendingError(transitionId)
  }
}
