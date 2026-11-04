import type { PoolClient } from 'pg'
import { query, withTransaction } from './postgres'
import { enqueuePipelineSyncOutboxWithClient } from './pipeline'
import { reviewedEmailAudienceUnderNativeControlWithClient, type CrmOutboxItem } from './crm'
import { crmSourceHash } from '../crm/stableId'
import { nativeEmailDigest, prepareNativeEmailPublication, requireNativeEmail,
  type NativeEmailPublicationRequest, type NativeEmailCapabilityPins } from '../crm/nativeEmailPublication'
import { prepareNativeEmailCapabilityContract, type NativeEmailCapabilityContract } from '../crm/nativeEmailCapabilityContract'
import { prepareNativeEmailAuthorityTransition, prepareNativeEmailAuthorityCommand, verifyNativeEmailAuthorityReceipt,
  nativeEmailAuthorityReceiptHash, nativeEmailAuthorityPhaseCommand, type NativeEmailAuthorityTransitionPlan,
  type NativeEmailAppAuthorityCommitReceipt, type NativeEmailGrantAttempt } from '../crm/nativeEmailAuthorityTransition'
import { PostgresNativeEmailPublicationStore } from '../crm/nativeEmailPublicationPostgres'
import { assertNativeEmailPublicationWorkLease, claimNativeEmailPublicationResolution, registerNativeEmailPublicationWork,
  type NativeEmailPublicationWorkContext, type NativeEmailPublicationWorkLease } from '../crm/nativeEmailPublicationWorkContext'
import { verifyNativeEmailPublicationReceipt } from '../crm/nativeEmailPublicationTransport'
import type { NativeEmailWorkerCandidate, NativeEmailWorkerMode, NativeEmailWorkerPersistence,
  NativeEmailWorkerSettlement } from '../crm/nativeEmailPublicationWorker'

const HASH = /^[a-f0-9]{64}(?![\s\S])/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const same = (left: unknown, right: unknown) => nativeEmailDigest(left) === nativeEmailDigest(right)
type Row = Record<string, unknown>
const input = ({ command, nativePolicyFingerprint, allowedReaderSuiteCrmUserIds }: NativeEmailPublicationRequest) =>
  ({ command, nativePolicyFingerprint, allowedReaderSuiteCrmUserIds })
function checkControl(row: Row | undefined): NativeEmailWorkerMode {
  requireNativeEmail(row && typeof row.enabled === 'boolean'
    && (row.active_operation_id === null || typeof row.active_operation_id === 'string' && HASH.test(row.active_operation_id))
    && (row.active_transition_id === null || typeof row.active_transition_id === 'string' && HASH.test(row.active_transition_id)),
  'native_publication_control_missing')
  requireNativeEmail(row.enabled || row.active_operation_id === null && row.active_transition_id === null, 'disabled_mode_has_active_admission')
  requireNativeEmail(row.active_operation_id === null || row.active_transition_id === null, 'native_publication_control_inconsistent')
  if (row.enabled) requireNativeEmail(Number.isSafeInteger(Number(row.generation)) && Number(row.generation) > 0
    && Number(row.verified_generation) === Number(row.generation)
    && typeof row.native_policy_fingerprint === 'string' && HASH.test(row.native_policy_fingerprint)
    && typeof row.activation_receipt_hash === 'string' && HASH.test(row.activation_receipt_hash), 'native_policy_not_verified')
  return { enabled: row.enabled, activeOperationId: row.active_operation_id as string | null,
    activeTransitionId: row.active_transition_id as string | null }
}
async function control(tx: PoolClient): Promise<Row> {
  const result = await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
  requireNativeEmail(result.rows.length === 1, 'native_publication_control_missing')
  checkControl(result.rows[0]); return result.rows[0]
}
function supported(item: CrmOutboxItem): asserts item is CrmOutboxItem & { operation: 'upsert_record' } {
  requireNativeEmail(item.operation === 'upsert_record' && item.aggregateType === 'crm_interactions'
    && item.payload.entity === 'interactions' && item.payload.suiteCrmModule === 'Emails' && !item.payload.previousSuiteCrmModule
    && item.aggregateId === item.payload.localId && UUID.test(item.id) && UUID.test(item.aggregateId),
  'native_email_transition_not_supported')
}
async function rows(tx: PoolClient, localId: string, outboxId: string): Promise<{ interaction: Row; outbox: Row }> {
  // Stage/enqueue already takes interaction then outbox. Never invert that
  // order. The publication singleton is held first by every caller here.
  const i = await tx.query('SELECT * FROM crm_interactions WHERE id=$1::uuid FOR UPDATE', [localId])
  const o = await tx.query('SELECT * FROM sync_outbox WHERE id=$1::uuid FOR UPDATE', [outboxId])
  requireNativeEmail(i.rows.length === 1 && o.rows.length === 1, 'native_work_source_missing')
  return { interaction: i.rows[0], outbox: o.rows[0] }
}
function exactSource(item: CrmOutboxItem, current: { interaction: Row; outbox: Row }): string {
  supported(item)
  const { interaction: i, outbox: o } = current
  requireNativeEmail(i.pipeline_id === item.payload.pipelineId && i.suitecrm_id === item.payload.suiteCrmId
    && i.reference_code === item.payload.attributes.global_id_c && i.suitecrm_module === 'Emails'
    && !['true','1','yes'].includes(String((i.source_payload as Row | null)?.archived || '').toLowerCase())
    && typeof i.source_hash === 'string' && HASH.test(i.source_hash), 'native_email_source_changed')
  requireNativeEmail(o.target_system === 'suitecrm' && o.aggregate_type === 'crm_interactions'
    && o.aggregate_id === item.aggregateId && o.operation === 'upsert_record' && o.status === 'processing'
    && o.lock_token === item.lockToken && Number(o.attempts) === item.attempts
    && o.idempotency_key === item.idempotencyKey && crmSourceHash(o.payload) === crmSourceHash(item.payload)
    && item.idempotencyKey === `crm:interactions:v4:${item.aggregateId}:Emails:${i.source_hash}`,
  'native_email_outbox_claim_changed')
  return i.source_hash
}
/** Derive current capability evidence without rewriting immutable publication
 * receipts or adopting a fresh native content snapshot. Missing/gapped history
 * is a hold, never a futureCreate fallback. */
export async function advanceNativeEmailPublicationCapabilities(tx:PoolClient,request:NativeEmailPublicationRequest,pins:NativeEmailCapabilityPins,
  generation:number,policyFingerprint:string){
  let cursor=request.command.generation,policy=request.nativePolicyFingerprint,current=pins
  requireNativeEmail(cursor<=generation,'native_authority_history_generation')
  if(cursor!==generation){
    const history=await tx.query(`SELECT t.plan,t.plan_hash,t.desired_change_hash,t.app_state,t.app_commit,
      r.command AS revoke_command,r.command_hash AS revoke_hash,r.native_receipt AS revoke_receipt,r.receipt_hash AS revoke_receipt_hash,
      g.command AS grant_command,g.command_hash AS grant_hash,g.native_receipt AS grant_receipt,g.receipt_hash AS grant_receipt_hash,
      g.grant_attempt
      FROM crm_native_email_authority_transitions t
      JOIN crm_native_email_effective_authority_phases r ON r.transition_id=t.transition_id AND r.phase='revoke'
      JOIN crm_native_email_effective_authority_phases g ON g.transition_id=t.transition_id AND g.phase='grant'
      WHERE r.state='committed' AND g.state='committed' AND (r.command->>'generationFrom')::bigint >= $1
        AND (g.command->>'generationTo')::bigint <= $2
      ORDER BY (r.command->>'generationFrom')::bigint,t.transition_id LIMIT 257`,[cursor,generation])
    requireNativeEmail(history.rows.length<=256,'native_authority_history_bound')
    for(const row of history.rows){
      const {planHash,...input}=row.plan as NativeEmailAuthorityTransitionPlan,plan=prepareNativeEmailAuthorityTransition(input)
      const effectiveGrant=nativeEmailAuthorityPhaseCommand({plan,appCommit:row.app_commit as NativeEmailAppAuthorityCommitReceipt,
        ...(row.grant_attempt?{grantAttempt:row.grant_attempt as NativeEmailGrantAttempt}:{})},'grant')
      requireNativeEmail(plan.planHash===planHash && planHash===row.plan_hash && row.desired_change_hash===plan.revoke.desiredAppChangeHash
        && row.app_state==='committed' && plan.revoke.version===2 && plan.grant.version===2
        && same(row.revoke_command,plan.revoke) && same(row.grant_command,effectiveGrant),'native_authority_history_plan')
      const revokeRequest=prepareNativeEmailAuthorityCommand(plan.revoke),grantRequest=prepareNativeEmailAuthorityCommand(effectiveGrant)
      const revoke=verifyNativeEmailAuthorityReceipt(revokeRequest,row.revoke_receipt),grant=verifyNativeEmailAuthorityReceipt(grantRequest,row.grant_receipt)
      requireNativeEmail(revoke.state==='committed' && grant.state==='committed' && row.revoke_hash===revokeRequest.commandHash
        && row.grant_hash===grantRequest.commandHash && row.revoke_receipt_hash===nativeEmailAuthorityReceiptHash(revoke)
        && row.grant_receipt_hash===nativeEmailAuthorityReceiptHash(grant)
        && same(row.app_commit,{version:1,transitionId:plan.revoke.transitionId,planHash,desiredAppChangeHash:plan.revoke.desiredAppChangeHash,
          revokeReceiptHash:row.revoke_receipt_hash,appAuthorityBeforeFingerprint:plan.expectedAppAuthorityBeforeFingerprint,
          appAuthorityAfterFingerprint:plan.expectedAppAuthorityAfterFingerprint}),'native_authority_history_receipt')
      for(const command of [plan.revoke,plan.grant]){
        const pair=command.bindings.find(value=>value.before.pipeline_id===request.command.pipelineId)
        const entry=command.capabilities.find(value=>value.emailId===request.command.suiteCrmId)
        requireNativeEmail(command.generationFrom===cursor && command.beforePolicyFingerprint===policy && pair && entry
          && entry.globalId===request.command.globalId && entry.pipelineId===request.command.pipelineId
          && pair.before.workspace_id===request.command.workspaceId && 'capability_policy_fingerprint' in pair.before
          && pair.before.capability_policy_fingerprint===current.capabilityPolicyFingerprint
          && same(entry.before,current.expectedCapabilities),'native_authority_history_chain')
        requireNativeEmail('capability_policy_json' in pair.after && typeof pair.after.capability_policy_json==='string'
          && 'capability_policy_fingerprint' in pair.after && typeof pair.after.capability_policy_fingerprint==='string','native_authority_history_policy')
        const after=JSON.parse(pair.after.capability_policy_json) as NativeEmailCapabilityContract
        requireNativeEmail(same(after.principalSuiteCrmUserIds,current.principalSuiteCrmUserIds),'native_authority_history_principals')
        current={capabilityPolicyFingerprint:pair.after.capability_policy_fingerprint,principalSuiteCrmUserIds:after.principalSuiteCrmUserIds,
          expectedCapabilities:entry.after}
        cursor=command.generationTo;policy=command.afterPolicyFingerprint
      }
    }
  }
  requireNativeEmail(cursor===generation && policy===policyFingerprint,'native_authority_history_incomplete')
  return current
}
async function baseline(tx: PoolClient, item: CrmOutboxItem, interaction: Row, generation:number,policyFingerprint:string) {
  supported(item)
  const prior = await tx.query(`SELECT * FROM crm_native_email_publication_admissions
    WHERE pipeline_id=$1::uuid AND local_id=$2::uuid AND native_id=$3 AND global_id=$4 AND state='committed'
    ORDER BY updated_at DESC,operation_id DESC LIMIT 1`,
  [item.payload.pipelineId,item.aggregateId,item.payload.suiteCrmId,item.payload.attributes.global_id_c])
  if (prior.rows.length) {
    const r = prior.rows[0]
    const previous = prepareNativeEmailPublication({ command: r.command, nativePolicyFingerprint: r.native_policy_fingerprint,
      allowedReaderSuiteCrmUserIds: r.allowed_reader_ids })
    requireNativeEmail(previous.commandHash === r.command_hash && previous.requestFingerprint === r.request_fingerprint,
      'native_baseline_identity_changed')
    const receipt = verifyNativeEmailPublicationReceipt(previous, r.native_receipt)
    requireNativeEmail(receipt.state === 'committed' && receipt.result.projection?.version === 2,
      'native_existing_projection_baseline_required')
    const pins:NativeEmailCapabilityPins|null=receipt.result.version===2 ? {
      capabilityPolicyFingerprint:receipt.result.capabilityPolicyFingerprint,
      principalSuiteCrmUserIds:receipt.result.principalSuiteCrmUserIds,expectedCapabilities:receipt.result.expectedCapabilities,
    }:null
    const capabilityPins=pins?await advanceNativeEmailPublicationCapabilities(tx,previous,pins,generation,policyFingerprint):null
    return { fingerprint: receipt.result.recordFingerprint,capabilityPins,
      previousManaged: { accounts: receipt.result.projection.accounts, contacts: receipt.result.projection.contacts } }
  }
  const history = await tx.query(`SELECT EXISTS(SELECT 1 FROM sync_outbox WHERE target_system='suitecrm'
    AND aggregate_type='crm_interactions' AND aggregate_id=$1 AND status='succeeded'
    AND (payload->>'suiteCrmModule'='Emails' OR payload->>'previousSuiteCrmModule'='Emails')) AS present`, [item.aggregateId])
  const metadata = interaction.metadata as Row | null
  requireNativeEmail(interaction.suitecrm_synced_at === null && interaction.sync_status !== 'synced'
    && !metadata?.suiteCrmEmailProjection && !metadata?.suiteCrmEmailPublication
    && history.rows[0]?.present === false && !String(interaction.source_key || '').toLowerCase().startsWith('suitecrm'),
  'native_historical_baseline_required')
  // The native /prepare endpoint must additionally prove absence. A deterministic
  // local native ID alone is not evidence that a new Email already exists.
  return { fingerprint: null,capabilityPins:null, previousManaged: { accounts: [], contacts: [] } }
}
async function capabilityPolicy(tx:PoolClient,generation:number,audience:Awaited<ReturnType<typeof reviewedEmailAudienceUnderNativeControlWithClient>>){
  const result=await tx.query('SELECT pipeline_id,generation,policy,fingerprint FROM crm_native_email_capability_policies WHERE pipeline_id=$1::uuid',[audience.pipelineId])
  if(!result.rows.length)return null
  requireNativeEmail(result.rows.length===1,'native_capability_policy_ambiguous')
  const row=result.rows[0],policy=row.policy as NativeEmailCapabilityContract
  requireNativeEmail(Number(row.generation)===generation && policy && Array.isArray(policy.historical) && policy.historical.length===0,
    'native_capability_policy_generation_changed')
  // The table is a separately installed trust anchor, not a request parameter.
  // App readership is freshly evaluated. The complete native principal list
  // and future writes come from reviewed policy; only native ACL evaluation can
  // prove that inventory/effectiveness, never the app's user table alone.
  const checked=prepareNativeEmailCapabilityContract(policy,{
    binding:{pipelineId:audience.pipelineId,workspaceId:audience.workspaceId,ownerSuiteCrmId:audience.ownerSuiteCrmId,
      audienceFingerprint:audience.fingerprint,allowedReaderSuiteCrmUserIds:audience.allowedSuiteCrmUserIds},
    livePrincipalSuiteCrmUserIds:policy.principalSuiteCrmUserIds,approvedFutureCreate:policy.futureCreate,liveHistorical:[],
  })
  requireNativeEmail(checked.futurePolicyFingerprint===row.fingerprint && row.pipeline_id===audience.pipelineId,'native_capability_policy_fingerprint_changed')
  return {policy:checked.contract,fingerprint:checked.futurePolicyFingerprint}
}
function expectedCapabilityPins(policy:Awaited<ReturnType<typeof capabilityPolicy>>,before:Awaited<ReturnType<typeof baseline>>):NativeEmailCapabilityPins|null{
  if(!policy){requireNativeEmail(before.capabilityPins===null,'native_capability_policy_missing');return null}
  if(before.fingerprint!==null){
    requireNativeEmail(before.capabilityPins && before.capabilityPins.capabilityPolicyFingerprint===policy.fingerprint
      && same(before.capabilityPins.principalSuiteCrmUserIds,policy.policy.principalSuiteCrmUserIds),'native_v2_historical_capabilities_required')
    return before.capabilityPins
  }
  return {capabilityPolicyFingerprint:policy.fingerprint,principalSuiteCrmUserIds:policy.policy.principalSuiteCrmUserIds,
    expectedCapabilities:policy.policy.futureCreate}
}
async function candidate(tx: PoolClient, item: CrmOutboxItem): Promise<NativeEmailWorkerCandidate> {
  supported(item)
  const c = await control(tx)
  requireNativeEmail(c.active_transition_id === null, 'native_authority_transition_unresolved')
  requireNativeEmail(c.enabled === true && c.active_operation_id === null, 'native_publication_not_available')
  const current = await rows(tx, item.aggregateId, item.id), sourceHash = exactSource(item, current)
  const audience = await reviewedEmailAudienceUnderNativeControlWithClient(tx, item.payload.pipelineId)
  const projection = item.payload.emailProjection
  requireNativeEmail(projection && same(projection.audience, audience)
    && item.payload.attributes.assigned_user_id === audience.ownerSuiteCrmId, 'native_email_audience_changed')
  const links = item.payload.relationships || []
  requireNativeEmail(links.every(link => link.linkFieldName === 'accounts' && link.relatedModuleName === 'Accounts'
    || link.linkFieldName === 'contacts' && link.relatedModuleName === 'Contacts')
    && same(links.filter(link => link.linkFieldName === 'accounts').map(link => link.relatedBeanId).sort(), projection.accounts)
    && same(links.filter(link => link.linkFieldName === 'contacts').map(link => link.relatedBeanId).sort(), projection.contacts),
  'native_email_relationship_source_changed')
  const before = await baseline(tx, item, current.interaction,Number(c.generation),String(c.native_policy_fingerprint))
  const capabilities=expectedCapabilityPins(await capabilityPolicy(tx,Number(c.generation),audience),before)
  const payloadHash = crmSourceHash(item.payload)
  const operationId = nativeEmailDigest({ outboxId:item.id,idempotencyKey:item.idempotencyKey,payloadHash,
    attempt:item.attempts,claim:item.lockToken,generation:Number(c.generation) })
  const request = prepareNativeEmailPublication({ command: { ...(capabilities?{version:2 as const,...capabilities}:{version:1 as const}),operationId,mode:'publish',
    workspaceId:audience.workspaceId,pipelineId:item.payload.pipelineId,generation:Number(c.generation),
    audienceFingerprint:audience.fingerprint,suiteCrmId:item.payload.suiteCrmId,
    globalId:String(item.payload.attributes.global_id_c),localId:item.aggregateId,expectedRecordFingerprint:before.fingerprint,
    projection:{attributes:item.payload.attributes,accounts:projection.accounts,contacts:projection.contacts,
      contactAccounts:projection.contactAccounts,previousManaged:before.previousManaged} },
  nativePolicyFingerprint:String(c.native_policy_fingerprint),allowedReaderSuiteCrmUserIds:audience.allowedSuiteCrmUserIds })
  return { request, context:{kind:'outbox',outboxId:item.id,idempotencyKey:item.idempotencyKey!,sourceHash,payloadHash,attempt:item.attempts} }
}
async function resolutionAuthority(tx: PoolClient, request: NativeEmailPublicationRequest, context: NativeEmailPublicationWorkContext) {
  requireNativeEmail(request.command.mode === 'publish' && context.kind === 'outbox', 'repair_resolution_needs_reviewed_authority')
  const c = await control(tx)
  requireNativeEmail(c.enabled === true && c.active_transition_id === null && c.active_operation_id === request.command.operationId
    && Number(c.generation) === request.command.generation && c.native_policy_fingerprint === request.nativePolicyFingerprint,
  'native_resolution_policy_changed')
  const current = await rows(tx, request.command.localId, context.outboxId)
  const { interaction:i, outbox:o } = current
  const payload = o.payload as Row
  requireNativeEmail(i.pipeline_id === request.command.pipelineId && i.suitecrm_id === request.command.suiteCrmId
    && i.reference_code === request.command.globalId && o.target_system === 'suitecrm'
    && o.aggregate_type === 'crm_interactions' && o.aggregate_id === request.command.localId
    && o.operation === 'upsert_record' && o.status === 'processing' && o.idempotency_key === context.idempotencyKey
    && Number(o.attempts) === context.attempt && crmSourceHash(payload) === context.payloadHash
    && payload.pipelineId === request.command.pipelineId && payload.localId === request.command.localId
    && payload.suiteCrmId === request.command.suiteCrmId && payload.suiteCrmModule === 'Emails' && !payload.previousSuiteCrmModule,
  'native_resolution_identity_changed')
  const audience = await reviewedEmailAudienceUnderNativeControlWithClient(tx, request.command.pipelineId)
  requireNativeEmail(audience.workspaceId === request.command.workspaceId && audience.fingerprint === request.command.audienceFingerprint
    && same(audience.allowedSuiteCrmUserIds, request.allowedReaderSuiteCrmUserIds), 'native_resolution_audience_changed')
  const policy=await capabilityPolicy(tx,request.command.generation,audience)
  if(request.command.version===2)requireNativeEmail(policy && request.command.capabilityPolicyFingerprint===policy.fingerprint
    && same(request.command.principalSuiteCrmUserIds,policy.policy.principalSuiteCrmUserIds),'native_resolution_capability_policy_changed')
  else requireNativeEmail(policy===null,'native_resolution_requires_v2_policy')
  // Deliberately no original lockToken/lease-time or latest sourceHash check:
  // both may change while the immutable native operation awaits reconciliation.
  return current
}

/** Actual integration adapter, inert until the DB's separately approved policy
 * is enabled. No method activates policy or supplies historical approval. */
export function createPostgresNativeEmailWorkerPersistence(options: { maxAttempts?: number } = {}): NativeEmailWorkerPersistence {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(options.maxAttempts) || 8), 20))
  const store = new PostgresNativeEmailPublicationStore(withTransaction)
  return {
    async mode() {
      const result = await query('SELECT * FROM crm_native_email_publication_control WHERE singleton')
      requireNativeEmail(result.rows.length === 1, 'native_publication_control_missing')
      return checkControl(result.rows[0])
    },
    candidate: item => withTransaction(tx => candidate(tx, item)),
    async admit(item, expected, owner) {
      let lease: NativeEmailPublicationWorkLease | undefined
      const admission = await store.admit(input(expected.request), async (tx, request) => {
        const checked = await candidate(tx as PoolClient, item)
        requireNativeEmail(checked.request.requestFingerprint === request.requestFingerprint && same(checked.context, expected.context),
          'native_candidate_changed_before_admission')
        lease = await registerNativeEmailPublicationWork(tx, request, checked.context, owner, async (_sameTx, _request, context, action) => {
          requireNativeEmail(action === 'register' && same(context, checked.context), 'native_registration_authority_changed')
          // candidate above revalidated under the same control/interaction/outbox
          // locks. No provider I/O occurs between validation and registration.
        })
      })
      requireNativeEmail(lease, 'reconciliation_required')
      return { admission, lease }
    },
    markDispatched: (request, lease) => withTransaction(async tx => {
      // No child row, stale owner or expired lease can dispatch, even if a bare
      // store admission was created by another caller without this coordinator.
      await assertNativeEmailPublicationWorkLease(tx, request, lease)
      const result = await tx.query(`UPDATE crm_native_email_publication_admissions SET state='dispatched',updated_at=now()
        WHERE operation_id=$1 AND state='admitted' RETURNING operation_id`, [request.command.operationId])
      return result.rows.length === 1
    }),
    markUnknown: id => store.markUnknown(id),
    async claimResolution(operationId, owner) {
      const admission = await store.get(operationId)
      requireNativeEmail(!admission.receipt && admission.request.command.mode === 'publish', 'repair_resolution_needs_reviewed_authority')
      const lease = await withTransaction(tx => claimNativeEmailPublicationResolution(tx, admission.request, owner,
        async (sameTx, request, context) => { await resolutionAuthority(sameTx as PoolClient, request, context) }))
      return { admission, lease }
    },
    async settle(request, lease, value) {
      const receipt = verifyNativeEmailPublicationReceipt(request, value)
      const result: NativeEmailWorkerSettlement = { synchronized:false,pipelineId:request.command.pipelineId,outboxId:null }
      await store.settle(request.command.operationId, receipt, async (tx, admitted, terminal) => {
        verifyNativeEmailPublicationReceipt(admitted, terminal)
        const context = await assertNativeEmailPublicationWorkLease(tx, admitted, lease)
        requireNativeEmail(context.kind === 'outbox', 'repair_resolution_needs_reviewed_authority')
        const { interaction:i } = await resolutionAuthority(tx as PoolClient, admitted, context)
        const current = i.source_hash === context.sourceHash && i.suitecrm_module === 'Emails'
          && !['true','1','yes'].includes(String((i.source_payload as Row | null)?.archived || '').toLowerCase())
        await tx.query("SELECT set_config('clawpilot.crm_shared_write_v1','on',true)")
        // The immutable admission stores the complete verified receipt even for
        // a superseded source. Do not disguise it as a receipt for today's row.
        const committed = terminal.state === 'committed'
        const cancelledStatus = context.attempt >= maxAttempts ? 'dead' : 'failed'
        const completed = await tx.query(`UPDATE sync_outbox SET status=$2,last_error=$3,locked_at=NULL,lock_token=NULL,
          processed_at=CASE WHEN $2 IN ('succeeded','dead') THEN now() ELSE NULL END,
          available_at=CASE WHEN $2='failed' THEN now()+interval '30 seconds' ELSE available_at END,updated_at=now()
          WHERE id=$1::uuid AND status='processing' RETURNING id`,
        [context.outboxId,committed?'succeeded':cancelledStatus,committed?(current?null:'Native Email committed for superseded source'):'Native Email cancelled before write'])
        requireNativeEmail(completed.rows.length === 1, 'native_outbox_finalization_changed')
        if (committed && current) {
          const projection = { ...terminal.result.projection, operationId:admitted.command.operationId,
            sourceHash:context.sourceHash,capturedAt:new Date().toISOString(),
            ...(terminal.result.version===2?{capabilityPolicyFingerprint:terminal.result.capabilityPolicyFingerprint,
              principalSuiteCrmUserIds:terminal.result.principalSuiteCrmUserIds,expectedCapabilities:terminal.result.expectedCapabilities}:{}),
            audience:{fingerprint:terminal.result.audienceFingerprint,readerSuiteCrmUserIds:terminal.result.readerSuiteCrmUserIds} }
          await tx.query(`UPDATE crm_interactions SET sync_status='synced',sync_error=NULL,suitecrm_synced_at=now(),updated_at=now(),
            metadata=metadata || jsonb_build_object('suiteCrmEmailProjection',$2::jsonb) WHERE id=$1::uuid`,
          [admitted.command.localId,JSON.stringify(projection)])
          await tx.query('UPDATE pipeline_spaces SET crm_last_synced_at=now(),updated_at=now() WHERE id=$1::uuid', [admitted.command.pipelineId])
          const sheet = await tx.query(`SELECT id::text,sheet_id,owner_email FROM pipeline_spaces
            WHERE id=$1::uuid AND sync_enabled=true AND sheet_id IS NOT NULL`, [admitted.command.pipelineId])
          if (sheet.rows.length === 1) {
            const destination = sheet.rows[0]
            requireNativeEmail(typeof destination.id === 'string' && destination.id === admitted.command.pipelineId
              && typeof destination.sheet_id === 'string' && destination.sheet_id.length > 0
              && typeof destination.owner_email === 'string' && destination.owner_email.length > 0,
            'native_workbook_destination_invalid')
            await enqueuePipelineSyncOutboxWithClient(tx as PoolClient, {
              pipelineId:destination.id,sheetId:destination.sheet_id,aggregateType:'pipeline_crm_projection',
              aggregateId:destination.id,operation:'project_crm_workbook',actor:destination.owner_email,
              payload:{actorEmail:destination.owner_email,triggerId:context.outboxId,waitForCrmReadiness:true,
                nativeEmailPublicationOperationId:admitted.command.operationId},
              idempotencyKey:`crm-native-projection:${admitted.command.operationId}`,
            })
            result.projectionQueued = true
          }
        } else if (!committed && current) {
          await tx.query("UPDATE crm_interactions SET sync_status=$2,sync_error='Native Email cancelled before write',updated_at=now() WHERE id=$1::uuid",
            [admitted.command.localId,cancelledStatus === 'dead' ? 'failed' : 'pending'])
        }
        result.synchronized = committed && current; result.outboxId = context.outboxId
      })
      return result
    },
    async hold(item, code, maxAttempts) {
      await withTransaction(async tx => {
        const c = await control(tx)
        requireNativeEmail(c.enabled === true, 'native_publication_not_enabled')
        // Must check after taking the same singleton used by admission. This
        // handles a lost admission-COMMIT response without assuming no write.
        const pending = await tx.query(`SELECT 1 FROM crm_native_email_publication_work w
          JOIN crm_native_email_publication_admissions a USING(operation_id)
          WHERE w.work_kind='outbox' AND w.context->>'outboxId'=$1 AND a.state IN ('admitted','dispatched','unknown') LIMIT 1`, [item.id])
        if (pending.rows.length) return
        requireNativeEmail(/^[a-z][a-z0-9_]{0,99}$/.test(code), 'invalid_native_hold_code')
        const waitingForTransition = code === 'native_authority_transition_unresolved'
        if (waitingForTransition || (c.active_operation_id !== null || c.active_transition_id !== null)
          && ['another_publication_unresolved','native_publication_not_available'].includes(code)) {
          // A batch peer may have been claimed before an earlier item became
          // unknown. It has no admission or native write (read-only preparation
          // may have run); don't burn retries for that unrelated global barrier.
          // The explicit transition code also credits a claim if the transition
          // finished between candidate refusal and this transaction. The pending
          // work check above prevents crediting any admitted/unknown operation.
          await tx.query(`UPDATE sync_outbox SET status='queued',attempts=GREATEST(attempts-1,0),last_error=$3,
            locked_at=NULL,lock_token=NULL,available_at=now()+interval '30 seconds',updated_at=now()
            WHERE id=$1::uuid AND status='processing' AND lock_token=$2`,
          [item.id,item.lockToken,waitingForTransition || c.active_transition_id !== null
            ? 'Native Email waiting for authority transition' : 'Native Email waiting for unresolved publication'])
          return
        }
        await tx.query(`UPDATE sync_outbox SET status=$3,last_error=$4,locked_at=NULL,lock_token=NULL,
          available_at=now()+interval '60 seconds',processed_at=CASE WHEN $3='dead' THEN now() ELSE NULL END,updated_at=now()
          WHERE id=$1::uuid AND status='processing' AND lock_token=$2`,
        [item.id,item.lockToken,item.attempts>=maxAttempts?'dead':'failed',`Native Email held: ${code}`])
      })
    },
  }
}
