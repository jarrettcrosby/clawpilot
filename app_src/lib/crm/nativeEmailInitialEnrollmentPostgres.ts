import 'server-only'
import {constants,createPublicKey,verify,type KeyObject} from 'node:crypto'
import {nativeEmailCanonicalJson as json,nativeEmailDigest as digest,requireNativeEmail} from './nativeEmailPublication'
import type {NativeEmailSqlClient,NativeEmailSqlTransaction} from './nativeEmailPublicationPostgres'
import type {NativeEmailInitialApprovalEnvelope,NativeEmailInitialApprovalRecord,NativeEmailInitialApprovalStore} from './nativeEmailInitialEnrollmentApproval'
import {verifyNativeEmailInitialEnrollmentFingerprint} from './nativeEmailInitialEnrollment'
import {nativeEmailEffectivePipelinePrincipals} from './nativeEmailEligibility'
import {collectNativeEmailRootSourcesWithClient,projectNativeEmailRootReaders} from './nativeEmailRootReaders'
import {suiteCrmEmailAudienceFingerprint} from './suiteCrmNativeEmailProjection'
import {prepareNativeEmailInitialInstallationLineage,prepareNativeEmailInitialReplanContext,
  nativeEmailInitialInstallationLineageDigest,effectiveNativeEmailInitialInstallationJournalFingerprint,
  nativeEmailInitialReplanContextFromLineage,type NativeEmailInitialReplanContext} from './nativeEmailInitialInstallationLineage'

type Row=Record<string,unknown>
export type NativeEmailInitialOperatorSelection={actorEmail:string;operatorAccountId:string;rootWorkspaceId:string;nativeInstanceId:string}
export type NativeEmailInitialReviewedMaterial=Omit<NativeEmailInitialApprovalRecord,'state'|'publicationEnabled'|'barrierOperationId'>
export type NativeEmailInitialExecution={plan:NativeEmailInitialApprovalRecord['plan'];planHash:string;
  nativeDelta:Record<string,unknown>;approval:NativeEmailInitialApprovalEnvelope}
/** Private authenticated native transport only. resolve MUST freshly run the
 * native resolver's full ledger/current-policy readback, never return a cached
 * execution response or caller-supplied receipt. No provider I/O under PG locks.
 * An offline CLI adapter and its deployment/runtime proof are separate gates. */
export type NativeEmailInitialResolver={resolve(execution:NativeEmailInitialExecution):Promise<unknown>}
export type NativeEmailInitialApprovalVerification={publicKey:string|KeyObject;keyId:string;serviceUserId:string;oauthClientId:string}
const HASH=/^[a-f0-9]{64}(?![\s\S])/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const same=(a:unknown,b:unknown)=>json(a)===json(b)
const copy=<T>(value:T):T=>JSON.parse(json(value)) as T
function need(value:unknown,code:string):asserts value{requireNativeEmail(value,'initial_pg_'+code)}
function hash(value:unknown):asserts value is string{need(typeof value==='string'&&HASH.test(value),'hash')}
function exact(value:unknown,keys:string[]):asserts value is Row{
  need(value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort()),'shape')
}

/** Real SQL reservation/admission/settlement, not a new public API or an
 * authentication mechanism. Construct only inside an authenticated private
 * operator workflow. Review material must come from its protected, independently
 * pinned source/native/install evidence; a browser JSON body is not that proof.
 * SQL independently reauthorizes the owner and rebuilds every source and future
 * reader/editor set. The signer persists once before exposing an envelope.
 * The native resolver is deliberately not replaced by a JSON "verified" flag. */
export class PostgresNativeEmailInitialEnrollmentStore implements NativeEmailInitialApprovalStore{
  private readonly selection:NativeEmailInitialOperatorSelection
  private readonly reviewed?:{expectedPlanHash:string;read:()=>Promise<NativeEmailInitialReviewedMaterial>}
  private readonly verification?:Omit<NativeEmailInitialApprovalVerification,'publicKey'>&{publicKey:KeyObject}
  constructor(private readonly transaction:NativeEmailSqlTransaction,selection:NativeEmailInitialOperatorSelection,
    reviewed?:{expectedPlanHash:string;read:()=>Promise<NativeEmailInitialReviewedMaterial>},verification?:NativeEmailInitialApprovalVerification){
    exact(selection,['actorEmail','operatorAccountId','rootWorkspaceId','nativeInstanceId'])
    need(typeof selection.actorEmail==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(selection.actorEmail)
      &&selection.actorEmail===selection.actorEmail.toLowerCase(),'actor')
    need(UUID.test(selection.operatorAccountId)&&UUID.test(selection.rootWorkspaceId)
      &&/^[A-Za-z0-9][A-Za-z0-9-]{0,35}(?![\s\S])/.test(selection.nativeInstanceId),'selection')
    if(reviewed){hash(reviewed.expectedPlanHash);need(typeof reviewed.read==='function','review_required')}
    this.selection=Object.freeze({...selection})
    this.reviewed=reviewed?Object.freeze({...reviewed}):undefined
    if(verification){
      const publicKey=typeof verification.publicKey==='string'?createPublicKey(verification.publicKey):verification.publicKey
      need(publicKey.type==='public'&&publicKey.asymmetricKeyType==='rsa'&&publicKey.asymmetricKeyDetails?.modulusLength===3072,'verification_key')
      need(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}(?![\s\S])/.test(verification.keyId)
        &&[verification.serviceUserId,verification.oauthClientId].every(id=>/^[A-Za-z0-9][A-Za-z0-9-]{0,35}(?![\s\S])/.test(id)),'verification_identity')
      this.verification=Object.freeze({...verification,publicKey})
    }
  }
  private async lock(tx:NativeEmailSqlClient){
    const rows=(await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')).rows
    need(rows.length===1,'control_missing');return rows[0]
  }
  private async authorize(tx:NativeEmailSqlClient){const s=this.selection
    const rows=(await tx.query(`SELECT a.id FROM crm_operator_accounts a
      JOIN workspace_organizations w ON w.id=a.root_workspace_id JOIN app_users u ON u.email=a.owner_email
      JOIN app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=w.id
      WHERE a.id=$1::uuid AND a.root_workspace_id=$2::uuid AND a.owner_email=$3 AND a.enabled
        AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo
        AND u.status='active' AND u.role='owner' AND m.status='active' AND m.trashed_at IS NULL AND m.role='owner'`,
    [s.operatorAccountId,s.rootWorkspaceId,s.actorEmail])).rows
    need(rows.length===1,'operator_denied')
  }
  private selected(row:Row){const s=this.selection
    need(row.actor_email===s.actorEmail&&row.operator_account_id===s.operatorAccountId&&row.root_workspace_id===s.rootWorkspaceId
      &&row.native_instance_id===s.nativeInstanceId,'retained_selection')
  }
  private async source(tx:NativeEmailSqlClient){
    const rows=(await tx.query(`SELECT snapshot,encode(digest(snapshot::text,'sha256'),'hex') AS fingerprint
      FROM (SELECT clawpilot_crm_native_initial_source_snapshot() AS snapshot) q`)).rows
    need(rows.length===1&&rows[0].snapshot&&typeof rows[0].snapshot==='object','source_missing')
    hash(rows[0].fingerprint);return {snapshot:rows[0].snapshot as Row,fingerprint:rows[0].fingerprint}
  }
  private async reservation(tx:NativeEmailSqlClient,operationId:string){
    const rows=(await tx.query('SELECT * FROM crm_native_email_initial_reservations WHERE operation_id=$1 FOR UPDATE',[operationId])).rows
    need(rows.length===1,'reservation_missing');this.selected(rows[0]);return rows[0]
  }
  private async retained(tx:NativeEmailSqlClient,operationId:string){
    const rows=(await tx.query('SELECT * FROM crm_native_email_initial_enrollments WHERE operation_id=$1 FOR UPDATE',[operationId])).rows
    need(rows.length<=1,'duplicate_enrollment');if(rows.length)this.selected(rows[0]);return rows[0]??null
  }
  private execution(row:Row):NativeEmailInitialExecution{
    const plan=row.plan as NativeEmailInitialApprovalRecord['plan'],nativeDelta=row.native_delta as Row
    const approval=row.approval_envelope as NativeEmailInitialApprovalEnvelope
    need(row.plan_canonical===json(plan)&&row.plan_hash===digest(plan)&&row.native_delta_canonical===json(nativeDelta)
      &&row.delta_fingerprint===digest(nativeDelta)&&row.approval_canonical===json(approval)&&row.approval_hash===digest(approval)
      &&plan.operationId===row.operation_id&&approval.proof.operationId===row.operation_id
      &&approval.proof.planHash===row.plan_hash&&approval.proof.deltaFingerprint===row.delta_fingerprint,'stored_evidence')
    this.verifyApproval(approval)
    return copy({plan,planHash:String(row.plan_hash),nativeDelta,approval})
  }
  private verifyApproval(envelope:NativeEmailInitialApprovalEnvelope){
    need(this.verification,'verification_required');exact(envelope,['proof','signature'])
    exact(envelope.proof,['version','purpose','issuer','audience','keyId','nativeInstanceId','serviceUserId','oauthClientId',
      'issuedAt','expiresAt','operationId','planHash','appGeneration','appSourceFingerprint','preparedAt','deltaFingerprint',
      'sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint'])
    const p=envelope.proof,v=this.verification
    need(p.version===1&&p.purpose==='clawpilot-native-email-initial-enrollment-approval'&&p.issuer==='clawpilot-pg-initial-enrollment'
      &&p.audience==='clawpilot-suitecrm-initial-enrollment'&&p.nativeInstanceId===this.selection.nativeInstanceId
      &&p.keyId===v.keyId&&p.serviceUserId===v.serviceUserId&&p.oauthClientId===v.oauthClientId
      &&typeof envelope.signature==='string'&&/^[A-Za-z0-9+/]{512}(?![\s\S])/.test(envelope.signature),'approval_domain')
    const bytes=json(p);need(bytes.length<=4096&&!/[^\x20-\x7e]/.test(bytes)
      &&verify('sha256',Buffer.from(bytes,'ascii'),{key:v.publicKey,padding:constants.RSA_PKCS1_PADDING},Buffer.from(envelope.signature,'base64')),'approval_signature')
  }
  /** Historical rows are summarized by SQL after hashing their retained full
   * canonical bytes. Avoid loading 500 complete Email plans/source snapshots.
   * The RSA verifier below binds those exact plan/delta hashes; it does not
   * replay any ancestor's old content or capability matrix as current state. */
  private async cancelledHistory(tx:NativeEmailSqlClient,operationId:string){
    const rows=(await tx.query(`SELECT e.operation_id,e.actor_email,e.operator_account_id::text,e.root_workspace_id::text,
      e.native_instance_id,e.generation::text,e.source_fingerprint,e.state,e.plan_hash,e.delta_fingerprint,
      e.approval_envelope,e.approval_canonical,e.approval_hash,e.native_receipt,e.receipt_canonical,e.receipt_hash,
      e.plan->>'kind' AS plan_kind,e.plan->>'operationId' AS plan_operation_id,
      e.plan->>'nativeInstanceId' AS plan_native_instance_id,e.plan->>'appGeneration' AS plan_generation,
      e.plan->>'appSourceFingerprint' AS plan_source_fingerprint,
      e.plan->>'nativeRuntimeBeforeFingerprint' AS plan_runtime_before,e.plan->'installationLineage' AS installation_lineage,
      (e.plan_canonical::jsonb=e.plan AND encode(digest(e.plan_canonical,'sha256'),'hex')=e.plan_hash
        AND e.native_delta_canonical::jsonb=e.native_delta AND encode(digest(e.native_delta_canonical,'sha256'),'hex')=e.delta_fingerprint
        AND e.source_snapshot=r.source_snapshot AND e.source_fingerprint=r.source_fingerprint
        AND encode(digest(r.source_snapshot::text,'sha256'),'hex')=r.source_fingerprint
        AND (e.actor_email,e.operator_account_id,e.root_workspace_id,e.native_instance_id,e.generation)
          IS NOT DISTINCT FROM (r.actor_email,r.operator_account_id,r.root_workspace_id,r.native_instance_id,r.generation)
        AND r.state='cancelled' AND r.settling_xid=e.settling_xid) AS retained_evidence_valid
      FROM crm_native_email_initial_enrollments e
      JOIN crm_native_email_initial_reservations r ON r.operation_id=e.operation_id
      WHERE e.native_instance_id=$1 AND e.operation_id<>$2 ORDER BY e.operation_id COLLATE "C"
      LIMIT 501 FOR SHARE OF e,r`,[this.selection.nativeInstanceId,operationId])).rows
    need(rows.length<=500,'replan_history_bound')
    const missing=(await tx.query(`SELECT r.operation_id FROM crm_native_email_initial_reservations r
      LEFT JOIN crm_native_email_initial_enrollments e ON e.operation_id=r.operation_id
      WHERE r.native_instance_id=$1 AND r.operation_id<>$2 AND e.operation_id IS NULL LIMIT 1`,
    [this.selection.nativeInstanceId,operationId])).rows
    need(missing.length===0,'replan_unresolved_reservation')
    for(const row of rows){
      const p=(row.approval_envelope as NativeEmailInitialApprovalEnvelope)?.proof
      need(row.state==='cancelled'&&row.retained_evidence_valid===true
        &&row.operator_account_id===this.selection.operatorAccountId&&row.root_workspace_id===this.selection.rootWorkspaceId
        &&row.native_instance_id===this.selection.nativeInstanceId,'replan_history_selection')
      hash(row.operation_id);hash(row.plan_hash);hash(row.delta_fingerprint);hash(row.approval_hash);hash(row.receipt_hash)
      const approval=row.approval_envelope as NativeEmailInitialApprovalEnvelope
      need(row.approval_canonical===json(approval)&&row.approval_hash===digest(approval),'replan_approval_bytes')
      this.verifyApproval(approval)
      need(p.operationId===row.operation_id&&p.planHash===row.plan_hash&&p.deltaFingerprint===row.delta_fingerprint
        &&p.sourceRuntimeFingerprint===row.plan_runtime_before
        &&p.appGeneration===Number(row.generation)&&p.appSourceFingerprint===row.source_fingerprint
        &&row.plan_operation_id===row.operation_id&&row.plan_native_instance_id===row.native_instance_id
        &&row.plan_generation===String(row.generation)&&row.plan_source_fingerprint===row.source_fingerprint
        &&Number.isSafeInteger(p.issuedAt)&&p.issuedAt>0&&Number.isSafeInteger(p.expiresAt)
        &&p.expiresAt>p.issuedAt&&p.expiresAt-p.issuedAt<=300,'replan_approval_binding')
      for(const field of ['sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint'] as const)hash(p[field])
      const receipt=row.native_receipt
      exact(receipt,['version','purpose','operationId','planHash','approvalHash','state','result'])
      need(row.receipt_canonical===json(receipt)&&row.receipt_hash===digest(receipt)
        &&receipt.version===1&&receipt.purpose==='clawpilot-native-email-initial-enrollment-receipt'
        &&receipt.operationId===row.operation_id&&receipt.planHash===row.plan_hash&&receipt.approvalHash===row.approval_hash
        &&receipt.state==='cancelled'&&receipt.result===null,'replan_cancelled_receipt')
    }
    return rows
  }
  private historyFingerprint(rows:Row[]){
    return digest([...rows].sort((a,b)=>String(a.operation_id)<String(b.operation_id)?-1:1).map(row=>({
      operationId:row.operation_id,planHash:row.plan_hash,deltaFingerprint:row.delta_fingerprint,
      approvalHash:row.approval_hash,cancellationReceiptHash:row.receipt_hash})))
  }
  private async replanContext(tx:NativeEmailSqlClient,operationId:string,predecessorOperationId:string,rootSourceArtifactDigest:string){
    const rows=await this.cancelledHistory(tx,operationId);need(rows.length>0,'replan_history_missing')
    const byId=new Map(rows.map(row=>[String(row.operation_id),row])),chain:Row[]=[],seen=new Set<string>()
    let current=predecessorOperationId
    for(;;){const row=byId.get(current);need(row&&!seen.has(current),'replan_chain_missing_or_cycle');seen.add(current);chain.unshift(row)
      if(row.plan_kind==='initial_enrollment_plan_v1'){need(row.installation_lineage===null,'replan_root_shape');break}
      need(row.plan_kind==='initial_enrollment_replan_v1','replan_plan_kind')
      const lineage=prepareNativeEmailInitialInstallationLineage(row.installation_lineage,current)
      need(lineage.freshInstalledRuntimeFingerprint===row.plan_runtime_before,'replan_runtime_changed')
      current=lineage.predecessorOperationId
    }
    need(chain.length===rows.length,'replan_history_branch')
    const root=chain[0],rootProof=(root.approval_envelope as NativeEmailInitialApprovalEnvelope).proof
    const contextFor=(before:Row[]):NativeEmailInitialReplanContext=>{
      const prior=before.at(-1)!;return prepareNativeEmailInitialReplanContext({version:1,
        purpose:'clawpilot-native-email-initial-replan-context',rootOperationId:root.operation_id,
        rootInstallationJournalFingerprint:rootProof.installationJournalFingerprint,rootSourceArtifactDigest,
        rootStockRuntimeFingerprint:rootProof.sourceRuntimeFingerprint,predecessorOperationId:prior.operation_id,
        predecessorPlanHash:prior.plan_hash,predecessorApprovalHash:prior.approval_hash,
        predecessorCancellationReceiptHash:prior.receipt_hash,previousLineageHash:prior.plan_kind==='initial_enrollment_plan_v1'
          ?null:nativeEmailInitialInstallationLineageDigest(prior.installation_lineage,String(prior.operation_id)),
        depth:before.length,cancelledHistoryFingerprint:this.historyFingerprint(before)},operationId)
    }
    for(let index=1;index<chain.length;index++){
      const row=chain[index],lineage=prepareNativeEmailInitialInstallationLineage(row.installation_lineage,String(row.operation_id))
      const {freshInstalledRuntimeFingerprint}=lineage
      need(same(nativeEmailInitialReplanContextFromLineage(lineage,String(row.operation_id)),contextFor(chain.slice(0,index))),
        'replan_historical_lineage_changed')
      const proof=(row.approval_envelope as NativeEmailInitialApprovalEnvelope).proof
      need(proof.sourceRuntimeFingerprint===freshInstalledRuntimeFingerprint&&proof.installedRuntimeFingerprint===freshInstalledRuntimeFingerprint
        &&proof.installationJournalFingerprint===effectiveNativeEmailInitialInstallationJournalFingerprint(lineage,String(row.operation_id)),
      'replan_historical_installation_changed')
    }
    const context=contextFor(chain)
    // SQL independently reconstructs the same durable chain under its guards.
    // It cannot verify RSA or the original install manifest; those are separate.
    const nativeSql=(await tx.query('SELECT clawpilot_crm_native_initial_replan_context($1,$2,$3) AS context',
      [operationId,predecessorOperationId,rootSourceArtifactDigest])).rows
    need(nativeSql.length===1&&same(nativeSql[0].context,context),'replan_sql_context_changed')
    return context
  }
  /** AFTER B reservation, before native installed-source capture. The supplied
   * root-source digest is an independent pin, NOT a reconstructed manifest.
   * Native's actual immutable installer helper must verify it before signing. */
  async readReplanContext(operationId:string,predecessorOperationId:string,rootSourceArtifactDigest:string){
    hash(operationId);hash(predecessorOperationId);hash(rootSourceArtifactDigest)
    return this.transaction(async tx=>{
      const c=await this.lock(tx);await this.authorize(tx);const r=await this.reservation(tx,operationId)
      need(c.enabled===false&&c.active_initial_enrollment_id===operationId&&c.active_operation_id===null&&c.active_transition_id===null
        &&r.state==='reserved'&&Number(r.generation)===Number(c.generation),'barrier_changed')
      need((await this.source(tx)).fingerprint===r.source_fingerprint,'source_changed')
      return this.replanContext(tx,operationId,predecessorOperationId,rootSourceArtifactDigest)
    })
  }
  /** Read-only preview. The returned hash is a comparison pin, not authority.
   * reserve rechecks under the same control-first ordering before any write. */
  async preview(){return this.transaction(async tx=>{
    const control=await this.lock(tx);await this.authorize(tx);const source=await this.source(tx)
    return {generation:Number(control.generation),publicationEnabled:control.enabled===true,
      activeOperationId:control.active_initial_enrollment_id as string|null,sourceFingerprint:source.fingerprint}
  })}
  async reserve(operationId:string,expectedSourceFingerprint:string){hash(operationId);hash(expectedSourceFingerprint)
    return this.transaction(async tx=>{
      const c=await this.lock(tx);await this.authorize(tx)
      const retained=(await tx.query('SELECT * FROM crm_native_email_initial_reservations WHERE operation_id=$1',[operationId])).rows[0]
      if(retained){this.selected(retained);need(retained.source_fingerprint===expectedSourceFingerprint,'reservation_pin_changed')
        return {operationId,state:String(retained.state),sourceFingerprint:String(retained.source_fingerprint),generation:Number(retained.generation)}}
      need(c.enabled===false&&c.active_initial_enrollment_id===null&&c.active_operation_id===null&&c.active_transition_id===null,'not_disabled_idle')
      const source=await this.source(tx);need(source.fingerprint===expectedSourceFingerprint,'source_changed')
      const s=this.selection
      await tx.query(`INSERT INTO crm_native_email_initial_reservations(operation_id,actor_email,operator_account_id,root_workspace_id,
        native_instance_id,generation,source_snapshot,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [operationId,s.actorEmail,s.operatorAccountId,s.rootWorkspaceId,s.nativeInstanceId,c.generation,JSON.stringify(source.snapshot),source.fingerprint])
      return {operationId,state:'reserved',sourceFingerprint:source.fingerprint,generation:Number(c.generation)}
    })
  }
  private async futurePolicies(tx:NativeEmailSqlClient,material:NativeEmailInitialReviewedMaterial){
    const plan=material.plan,ids=plan.pipelines.map(row=>row.policy.pipelineId)
    const roots=await collectNativeEmailRootSourcesWithClient(tx,ids)
    for(const {policy} of plan.pipelines){
      const found=(await tx.query(`SELECT p.id::text,p.owner_email,p.workspace_organization_id::text,p.reference_access_disabled
        FROM pipeline_spaces p JOIN workspace_organizations w ON w.id=p.workspace_organization_id
        JOIN crm_operator_workspace_bindings b ON b.workspace_id=w.id
        WHERE p.id=$1::uuid AND b.operator_account_id=$2::uuid AND b.owner_email=$3 AND b.enabled
          AND NOT w.is_demo AND NOT p.reference_access_disabled`,[policy.pipelineId,this.selection.operatorAccountId,this.selection.actorEmail])).rows
      need(found.length===1&&found[0].workspace_organization_id===policy.workspaceId,'pipeline_unbound')
      const pipeline=found[0],members=(await tx.query(`SELECT user_email,access_role FROM pipeline_space_members
        WHERE pipeline_id=$1::uuid ORDER BY user_email`,[policy.pipelineId])).rows as Array<{user_email:string;access_role:string}>
      const emails=[...new Set([String(pipeline.owner_email),...members.map(row=>row.user_email)])].sort()
      need(emails.length<=500,'principal_bound')
      const principals=(await tx.query(`SELECT u.email,u.status,u.suitecrm_user_id,m.organization_id::text AS workspace_id,
        m.status AS membership_status,m.role AS membership_role,m.permissions AS membership_permissions,m.trashed_at::text AS membership_trashed_at,
        (SELECT count(*)::int FROM app_users duplicate WHERE lower(duplicate.suitecrm_user_id)=lower(u.suitecrm_user_id)) AS native_identity_count
        FROM app_users u LEFT JOIN app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=$1::uuid
        WHERE u.email=ANY($2::text[]) ORDER BY u.email`,[policy.workspaceId,emails])).rows
      need(principals.length===emails.length,'principal_missing')
      const rootReaders=projectNativeEmailRootReaders({sources:roots,pipelineId:policy.pipelineId,workspaceId:policy.workspaceId,stage:'before'})
      const effective=nativeEmailEffectivePipelinePrincipals({pipeline,principals,members,rootReaders},false)
      const readers=effective.map(row=>String(row.suitecrm_user_id)).sort(),owner=principals.find(row=>row.email===pipeline.owner_email)
      need(owner&&typeof owner.suitecrm_user_id==='string'&&readers.every(id=>plan.principalSuiteCrmUserIds.includes(id)),'principal_native_inventory')
      const editors=new Set(members.filter(row=>row.access_role==='editor').map(row=>row.user_email))
      const writers=effective.filter(row=>row.email===pipeline.owner_email||editors.has(String(row.email))).map(row=>String(row.suitecrm_user_id)).sort()
      const future={view:readers,list:readers,export:readers,edit:writers,delete:writers}
      need(same(policy.futureCreate,future)&&policy.ownerSuiteCrmId===owner.suitecrm_user_id,'future_authority_changed')
      need(policy.audienceFingerprint===suiteCrmEmailAudienceFingerprint({policy:'pipeline-internal',ownerSuiteCrmId:owner.suitecrm_user_id,
        allowedSuiteCrmUserIds:readers,workspaceId:policy.workspaceId,pipelineId:policy.pipelineId,fingerprint:''}),'audience_changed')
    }
  }
  async issueApproval(operationId:string,create:(record:NativeEmailInitialApprovalRecord)=>NativeEmailInitialApprovalEnvelope){
    hash(operationId);need(this.reviewed,'review_required')
    // Protected local evidence loading is outside the database transaction.
    // The independent review pin is retained by this store, not recomputed as
    // approval from whatever JSON the callback happens to return.
    const material=copy(await this.reviewed.read()),expectedPlanHash=this.reviewed.expectedPlanHash
    verifyNativeEmailInitialEnrollmentFingerprint(material.plan,material.evidence,expectedPlanHash)
    need(material.planHash===expectedPlanHash&&material.plan.operationId===operationId
      &&material.plan.nativeInstanceId===this.selection.nativeInstanceId,'review_changed')
    return this.transaction(async tx=>{
      const c=await this.lock(tx);await this.authorize(tx);const r=await this.reservation(tx,operationId),existing=await this.retained(tx,operationId)
      if(existing){need(existing.plan_hash===expectedPlanHash,'retained_review_changed');return this.execution(existing).approval}
      need(c.enabled===false&&c.active_initial_enrollment_id===operationId&&r.state==='reserved'
        &&Number(r.generation)===material.plan.appGeneration&&r.source_fingerprint===material.plan.appSourceFingerprint,'barrier_changed')
      const source=await this.source(tx);need(source.fingerprint===r.source_fingerprint,'source_changed')
      if(material.plan.kind==='initial_enrollment_replan_v1'){
        const lineage=prepareNativeEmailInitialInstallationLineage(material.plan.installationLineage,operationId)
        const context=await this.replanContext(tx,operationId,lineage.predecessorOperationId,lineage.rootSourceArtifactDigest)
        const {freshInstalledRuntimeFingerprint}=lineage
        need(same(nativeEmailInitialReplanContextFromLineage(lineage,operationId),context)
          &&freshInstalledRuntimeFingerprint===material.plan.nativeRuntimeBeforeFingerprint
          &&freshInstalledRuntimeFingerprint===material.sourceRuntimeFingerprint
          &&freshInstalledRuntimeFingerprint===material.installedRuntimeFingerprint
          &&material.installationJournalFingerprint===effectiveNativeEmailInitialInstallationJournalFingerprint(lineage,operationId),
        'replan_review_changed')
      }else need((await this.cancelledHistory(tx,operationId)).length===0,'direct_plan_after_cancelled_history')
      await this.futurePolicies(tx,material)
      const envelope=create({...material,state:'reserved',publicationEnabled:false,barrierOperationId:operationId})
      this.verifyApproval(envelope)
      const s=this.selection,delta=material.nativeDelta
      await tx.query(`INSERT INTO crm_native_email_initial_enrollments(operation_id,plan,plan_canonical,plan_hash,native_delta,native_delta_canonical,
        delta_fingerprint,approval_envelope,approval_canonical,approval_hash,actor_email,operator_account_id,root_workspace_id,native_instance_id,
        generation,source_snapshot,source_fingerprint) VALUES($1,$2::jsonb,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)`,
      [operationId,json(material.plan),json(material.plan),expectedPlanHash,json(delta),json(delta),digest(delta),json(envelope),json(envelope),digest(envelope),
        s.actorEmail,s.operatorAccountId,s.rootWorkspaceId,s.nativeInstanceId,material.plan.appGeneration,JSON.stringify(source.snapshot),source.fingerprint])
      return copy(envelope)
    })
  }
  private async held(tx:NativeEmailSqlClient,operationId:string){
    const c=await this.lock(tx);await this.authorize(tx);const r=await this.reservation(tx,operationId),row=await this.retained(tx,operationId)
    need(row,'enrollment_missing');const execution=this.execution(row)
    if(row.state!=='activated'&&row.state!=='cancelled'){
      need(c.enabled===false&&c.active_initial_enrollment_id===operationId&&r.state==='reserved'
        &&Number(c.generation)===Number(row.generation),'barrier_changed')
      need((await this.source(tx)).fingerprint===row.source_fingerprint,'source_changed')
      if(execution.plan.kind==='initial_enrollment_replan_v1'){
        const lineage=execution.plan.installationLineage
        const context=await this.replanContext(tx,operationId,lineage.predecessorOperationId,lineage.rootSourceArtifactDigest)
        need(same(nativeEmailInitialReplanContextFromLineage(lineage,operationId),context),'replan_execution_changed')
      }
    }
    return {c,r,row,execution}
  }
  /** Private operator command/status only, never an ordinary browser DTO. A
   * terminal result reports retained settlement, not current native readiness. */
  async readExecution(operationId:string){hash(operationId);return this.transaction(async tx=>{
    const {row,execution}=await this.held(tx,operationId)
    const clock=(await tx.query('SELECT floor(extract(epoch FROM clock_timestamp()))::text AS epoch')).rows[0]
    const nowEpoch=Number(clock?.epoch);need(Number.isSafeInteger(nowEpoch)&&nowEpoch>0,'clock')
    return {state:String(row.state),execution,receiptHash:row.receipt_hash as string|null,nowEpoch}
  })}
  async markDispatched(operationId:string){hash(operationId);return this.transaction(async tx=>{
    const {row,execution}=await this.held(tx,operationId)
    need(row.state==='admitted','dispatch_requires_unattempted_admission')
    await tx.query("UPDATE crm_native_email_initial_enrollments SET state='dispatched',updated_at=clock_timestamp() WHERE operation_id=$1",[operationId])
    return execution
  })}
  async markUnknown(operationId:string){hash(operationId);await this.transaction(async tx=>{
    const {row}=await this.held(tx,operationId)
    if(row.state==='activated'||row.state==='cancelled')return
    need(row.state==='dispatched'||row.state==='unknown','unknown_requires_dispatch')
    if(row.state!=='unknown')await tx.query("UPDATE crm_native_email_initial_enrollments SET state='unknown',updated_at=clock_timestamp() WHERE operation_id=$1",[operationId])
  })}
  async resolveAndSettle(operationId:string,native:NativeEmailInitialResolver){hash(operationId);need(native&&typeof native.resolve==='function','resolver_required')
    const retained=await this.transaction(async tx=>{
      const {row,execution}=await this.held(tx,operationId);return {execution,approvalHash:String(row.approval_hash)}
    })
    // This MUST be an actual authenticated fresh native resolve. An unknown or
    // failed transport leaves the durable barrier untouched; never redispatch.
    const value=await native.resolve(retained.execution)
    exact(value,['version','purpose','operationId','planHash','approvalHash','state','result'])
    need(value.version===1&&value.purpose==='clawpilot-native-email-initial-enrollment-receipt'
      &&value.operationId===operationId&&value.planHash===retained.execution.planHash&&value.approvalHash===retained.approvalHash,'native_receipt_binding')
    need(value.state==='committed'||value.state==='cancelled','native_not_terminal')
    need(value.state==='committed'?same(value.result,retained.execution.nativeDelta.result):value.result===null,'native_result_changed')
    return this.transaction(async tx=>{
      const {row}=await this.held(tx,operationId)
      need(row.approval_hash===retained.approvalHash,'approval_changed')
      if(row.state==='activated'||row.state==='cancelled'){
        need(row.receipt_canonical===json(value)&&row.receipt_hash===digest(value),'terminal_conflict')
        return {state:String(row.state),receiptHash:String(row.receipt_hash)}
      }
      const state=value.state==='committed'?'activated':'cancelled',receiptHash=digest(value)
      await tx.query(`UPDATE crm_native_email_initial_enrollments SET state=$2,native_receipt=$3::text::jsonb,receipt_canonical=$3::text,
        receipt_hash=$4,settling_xid=txid_current(),updated_at=clock_timestamp() WHERE operation_id=$1`,[operationId,state,json(value),receiptHash])
      await tx.query(`UPDATE crm_native_email_initial_reservations SET state=$2,settling_xid=txid_current(),updated_at=clock_timestamp()
        WHERE operation_id=$1`,[operationId,state])
      if(state==='activated'){
        const policies=retained.execution.nativeDelta.policies
        need(Array.isArray(policies),'policies_missing')
        for(const p of policies){exact(p,['pipelineId','generation','policy','fingerprint'])
          await tx.query(`INSERT INTO crm_native_email_capability_policies(pipeline_id,generation,policy,fingerprint)
            VALUES($1::uuid,$2,$3::jsonb,$4) ON CONFLICT(pipeline_id) DO UPDATE SET generation=excluded.generation,
              policy=excluded.policy,fingerprint=excluded.fingerprint`,[p.pipelineId,p.generation,json(p.policy),p.fingerprint])}
        await tx.query(`UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,
          native_policy_fingerprint=$2,activation_receipt_hash=$3,active_initial_enrollment_id=NULL,updated_at=clock_timestamp()
          WHERE singleton AND active_initial_enrollment_id=$1`,
        [operationId,(retained.execution.nativeDelta.result as Row).afterPolicyFingerprint,receiptHash])
      }else await tx.query('UPDATE crm_native_email_publication_control SET active_initial_enrollment_id=NULL,updated_at=clock_timestamp() WHERE singleton')
      return {state,receiptHash}
    })
  }
}
