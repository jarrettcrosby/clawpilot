import type { PoolClient } from 'pg'
import { query, withTransaction } from './postgres'
import { enqueuePipelineSyncOutboxWithClient } from './pipeline'
import { reviewedEmailAudienceUnderNativeControlWithClient, type CrmOutboxItem } from './crm'
import { crmSourceHash } from '../crm/stableId'
import { nativeEmailDigest, prepareNativeEmailPublication, requireNativeEmail,
  type NativeEmailAdmission, type NativeEmailPublicationRequest, type NativeEmailCapabilityPins } from '../crm/nativeEmailPublication'
import { prepareNativeEmailCapabilityContract, type NativeEmailCapabilityContract } from '../crm/nativeEmailCapabilityContract'
import { prepareNativeEmailAuthorityTransition, prepareNativeEmailAuthorityCommand, verifyNativeEmailAuthorityReceipt,
  nativeEmailAuthorityReceiptHash, nativeEmailAuthorityPhaseCommand, type NativeEmailAuthorityTransitionPlan,
  type NativeEmailAppAuthorityCommitReceipt, type NativeEmailGrantAttempt } from '../crm/nativeEmailAuthorityTransition'
import { PostgresNativeEmailPublicationStore, type NativeEmailSqlClient } from '../crm/nativeEmailPublicationPostgres'
import { assertNativeEmailPublicationWorkLease, claimNativeEmailPublicationResolution, registerNativeEmailPublicationWork,
  type NativeEmailPublicationWorkContext, type NativeEmailPublicationWorkLease } from '../crm/nativeEmailPublicationWorkContext'
import { verifyNativeEmailPublicationReceipt } from '../crm/nativeEmailPublicationTransport'
import { assertVerifiedLegacyEmailRecoveryReleaseApproval, type LegacyEmailRecoveryReleaseApproval } from '../crm/legacyEmailRecoveryReleaseApproval'
import { assertNativeEmailRecoveryDispatchSigner, type NativeEmailRecoveryDispatchPermit,
  type NativeEmailRecoveryMaintenanceDispatch, type NativeEmailRecoveryWriterFence } from '../crm/nativeEmailRecoveryDispatchPermit'
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
async function rows(tx: PoolClient, localId: string, outboxId: string, held = false): Promise<{ interaction: Row; outbox: Row }> {
  // Stage/enqueue already takes interaction then outbox. Never invert that
  // order. The publication singleton is held first by every caller here.
  const i = await tx.query('SELECT * FROM crm_interactions WHERE id=$1::uuid FOR UPDATE', [localId])
  const o = await tx.query(`SELECT * FROM sync_outbox WHERE id=$1::uuid
    AND (available_at IS NOT DISTINCT FROM 'infinity'::timestamptz)=$2::boolean FOR UPDATE`, [outboxId,held])
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
async function candidate(tx: PoolClient, item: CrmOutboxItem, held = false): Promise<NativeEmailWorkerCandidate> {
  supported(item)
  const c = await control(tx)
  requireNativeEmail(c.active_transition_id === null, 'native_authority_transition_unresolved')
  requireNativeEmail(c.enabled === true && c.active_operation_id === null, 'native_publication_not_available')
  return buildCandidate(tx,item,held,c,await rows(tx,item.aggregateId,item.id,held))
}
/** All callers hold publication control. Relationship writers take that same
 * lock before their row locks; an admitted private release keeps its exact
 * associations pinned across the native request, not a PG transaction. */
async function assertPrivateLegacyEmailRelationships(tx: PoolClient, localId: string, pipelineId: string,
  value: unknown, attributes: unknown) {
  const projection=value as {accounts?:unknown;contacts?:unknown;contactAccounts?:unknown}|null
  requireNativeEmail(projection && Array.isArray(projection.accounts) && Array.isArray(projection.contacts)
    && Array.isArray(projection.contactAccounts) && attributes && typeof attributes==='object',
  'legacy_release_relationships_changed')
  const {accounts,contacts,contactAccounts}=projection
  const {parent_type:parentType,parent_id:parentId}=attributes as Record<string,unknown>
  const result=await tx.query(`SELECT public.clawpilot_crm_legacy_email_live_relationships($1::uuid,$2::uuid) AS projection`,[localId,pipelineId])
  const live=result.rows[0]?.projection
  requireNativeEmail(typeof parentType==='string' && typeof parentId==='string'
    && result.rows.length===1 && live && same(live,{parentType,parentId,accounts,contacts,contactAccounts}),
    'legacy_release_relationships_changed')
}
async function buildCandidate(tx: PoolClient, item: CrmOutboxItem, held: boolean, c: Row,
  current: { interaction: Row; outbox: Row }): Promise<NativeEmailWorkerCandidate> {
  supported(item)
  const sourceHash = exactSource(item,current)
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
  if (held) await assertPrivateLegacyEmailRelationships(tx,item.aggregateId,item.payload.pipelineId,projection,item.payload.attributes)
  const before = await baseline(tx, item, current.interaction,Number(c.generation),String(c.native_policy_fingerprint))
  if (held) requireNativeEmail(before.fingerprint===null,'legacy_release_requires_create')
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
async function resolutionAuthority(tx: PoolClient, request: NativeEmailPublicationRequest, context: NativeEmailPublicationWorkContext, held = false) {
  requireNativeEmail(request.command.mode === 'publish' && context.kind === 'outbox', 'repair_resolution_needs_reviewed_authority')
  const c = await control(tx)
  requireNativeEmail(c.enabled === true && c.active_transition_id === null && c.active_operation_id === request.command.operationId
    && Number(c.generation) === request.command.generation && c.native_policy_fingerprint === request.nativePolicyFingerprint,
  'native_resolution_policy_changed')
  const current = await rows(tx, request.command.localId, context.outboxId, held)
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
            WHERE id=$1::uuid AND status='processing' AND lock_token=$2
              AND available_at IS DISTINCT FROM 'infinity'::timestamptz`,
          [item.id,item.lockToken,waitingForTransition || c.active_transition_id !== null
            ? 'Native Email waiting for authority transition' : 'Native Email waiting for unresolved publication'])
          return
        }
        await tx.query(`UPDATE sync_outbox SET status=$3,last_error=$4,locked_at=NULL,lock_token=NULL,
          available_at=now()+interval '60 seconds',processed_at=CASE WHEN $3='dead' THEN now() ELSE NULL END,updated_at=now()
          WHERE id=$1::uuid AND status='processing' AND lock_token=$2
            AND available_at IS DISTINCT FROM 'infinity'::timestamptz`,
        [item.id,item.lockToken,item.attempts>=maxAttempts?'dead':'failed',`Native Email held: ${code}`])
      })
    },
  }
}

type LegacyReleaseSelection = Pick<LegacyEmailRecoveryReleaseApproval,'holdId'|'outboxId'|'nativeOperationId'|'requestFingerprint'>
type LegacyReleaseOptions = { selection: LegacyReleaseSelection; transaction: typeof withTransaction;
  initialApproval?: Readonly<LegacyEmailRecoveryReleaseApproval>; maintenanceDispatch?: NativeEmailRecoveryMaintenanceDispatch }
type MaintenanceDispatchSelection = {action:'prepare';item:CrmOutboxItem}
  | {action:'publish'|'resolve';request:NativeEmailPublicationRequest;lease:NativeEmailPublicationWorkLease}
type MaintenancePublishAuthorization = Readonly<{request:NativeEmailPublicationRequest;fence:NativeEmailRecoveryWriterFence;
  authorize:()=>Promise<NativeEmailRecoveryDispatchPermit>}>
type MaintenanceInitialPublishRun<T> = (input:MaintenancePublishAuthorization,
  committedLease:()=>NativeEmailPublicationWorkLease|null)=>Promise<T>
function freezeMaintenanceValue<T>(value:T):T {
  if (value && typeof value==='object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freezeMaintenanceValue(nested)
    Object.freeze(value)
  }
  return value
}

/** Read-only preview under a private staging transaction, before its hold is
 * inserted. The preview does not authorize admission or expose an HTTP route. */
export function previewPrivateLegacyEmailRecoveryCandidate(tx: PoolClient,item: CrmOutboxItem) {
  return candidate(tx,item,true)
}

/** Derive the exact proposed command before staging a row. This computes a
 * review fingerprint only; it never registers or sends the operation. */
export async function previewUnstagedPrivateLegacyEmailRecoveryCandidate(tx: PoolClient,item: CrmOutboxItem,
  sourceFingerprint: string) {
  supported(item)
  const c=await control(tx)
  requireNativeEmail(c.enabled===true && c.active_operation_id===null && c.active_transition_id===null
    && c.active_initial_enrollment_id===null && item.attempts===1 && UUID.test(item.lockToken), 'legacy_stage_control_changed')
  const i=(await tx.query(`SELECT i.*,encode(public.digest(to_jsonb(i)::text,'sha256'),'hex') AS stage_source_fingerprint
    FROM crm_interactions i WHERE id=$1::uuid FOR UPDATE`,[item.aggregateId])).rows[0]
  requireNativeEmail(i && i.stage_source_fingerprint===sourceFingerprint,'legacy_stage_source_changed')
  const proposed=await buildCandidate(tx,item,true,c,{interaction:i,outbox:{target_system:'suitecrm',aggregate_type:item.aggregateType,
    aggregate_id:item.aggregateId,operation:item.operation,status:'processing',lock_token:item.lockToken,attempts:item.attempts,
    idempotency_key:item.idempotencyKey,payload:item.payload}})
  requireNativeEmail(proposed.request.command.version===2,'legacy_stage_requires_v2_policy')
  return {proposed,activationReceiptHash:String(c.activation_receipt_hash)}
}

/** Explicit one-item controller adapter. There is no default database or
 * provider configuration; the ordinary worker never constructs this adapter.
 * The supplied connection needs separately installed, restricted DB rights. */
export function createPrivateLegacyEmailRecoveryPersistence(options: LegacyReleaseOptions): NativeEmailWorkerPersistence & {
  loadItem(): Promise<CrmOutboxItem>
  withMaintenanceDispatch<T>(selection:MaintenanceDispatchSelection,run:(input:{request:NativeEmailPublicationRequest;
    permit:NativeEmailRecoveryDispatchPermit})=>Promise<T>):Promise<T>
  withMaintenancePublish<T>(request:NativeEmailPublicationRequest,lease:NativeEmailPublicationWorkLease,
    run:(input:MaintenancePublishAuthorization)=>Promise<T>):Promise<T>
  withMaintenanceInitialPublish<T>(item:CrmOutboxItem,expected:NativeEmailWorkerCandidate,owner:string,
    run:MaintenanceInitialPublishRun<T>):Promise<T>
  maintenancePublishState(request:NativeEmailPublicationRequest):Promise<NativeEmailAdmission['state']|'not_admitted'>
} {
  const { holdId,outboxId,nativeOperationId,requestFingerprint } = options.selection
  const { transaction: privateTransaction,initialApproval } = options
  const maintenance=options.maintenanceDispatch && Object.freeze({...options.maintenanceDispatch})
  requireNativeEmail([holdId,outboxId].every(v=>typeof v==='string' && UUID.test(v))
    && [nativeOperationId,requestFingerprint].every(v=>typeof v==='string' && HASH.test(v))
    && typeof privateTransaction==='function','legacy_release_selection_invalid')
  if (maintenance) {
    assertNativeEmailRecoveryDispatchSigner(maintenance.signer)
    requireNativeEmail(typeof maintenance.withVerifiedFence==='function','legacy_dispatch_fence_required')
  }
  const transaction: typeof withTransaction = action=>privateTransaction(async tx=>{
    // PostgreSQL row fingerprints include timestamptz JSON text. Match the
    // fixed clock rendering used by the exact archive and stage functions.
    await tx.query("SET LOCAL TIME ZONE 'UTC'")
    return action(tx)
  })
  if (initialApproval) {
    assertVerifiedLegacyEmailRecoveryReleaseApproval(initialApproval)
    requireNativeEmail(initialApproval.holdId===holdId && initialApproval.outboxId===outboxId
      && initialApproval.nativeOperationId===nativeOperationId && initialApproval.requestFingerprint===requestFingerprint,
    'legacy_release_approval_selection_changed')
  }
  const store = new PostgresNativeEmailPublicationStore(transaction)
  const selected = (request: NativeEmailPublicationRequest) => requireNativeEmail(
    request.command.operationId===nativeOperationId && request.requestFingerprint===requestFingerprint
      && request.command.mode==='publish' && request.command.expectedRecordFingerprint===null,'legacy_release_operation_changed')
  const databaseSecond=async(tx:PoolClient)=>{
    const result=await tx.query('SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS second')
    const second=Number(result.rows[0]?.second)
    requireNativeEmail(result.rows.length===1 && Number.isSafeInteger(second) && second>0,'legacy_release_clock_unavailable')
    return second
  }
  const approval = async (tx: PoolClient) => {
    requireNativeEmail(initialApproval,'legacy_release_approval_required')
    const second=await databaseSecond(tx)
    requireNativeEmail(second>=initialApproval.issuedAt && second<initialApproval.expiresAt,
      'legacy_release_approval_expired')
    return initialApproval
  }
  const lockedHold = async (tx: PoolClient) => {
    const c = await control(tx)
    requireNativeEmail(c.enabled===true && c.active_transition_id===null,'legacy_release_control_changed')
    const result = await tx.query(`SELECT h.*,p.workspace_organization_id::text AS workspace_id
      FROM crm_legacy_email_recovery_holds h JOIN pipeline_spaces p ON p.id=h.pipeline_id
      WHERE h.operation_id=$1::uuid AND h.outbox_id=$2::uuid`,[holdId,outboxId])
    requireNativeEmail(result.rows.length===1,'legacy_release_hold_missing')
    return { c,h:result.rows[0] }
  }
  const findRegistration = async (tx: PoolClient) => (await tx.query(`SELECT * FROM crm_legacy_email_recovery_releases
      WHERE hold_id=$1::uuid AND outbox_id=$2::uuid AND native_operation_id=$3`,[holdId,outboxId,nativeOperationId])).rows[0]
  const registration = async (tx: PoolClient) => {
    const r=await findRegistration(tx)
    requireNativeEmail(r && r.request_fingerprint===requestFingerprint,'legacy_release_registration_changed')
    return r
  }
  const verifyHold = async (tx: PoolClient, request: NativeEmailPublicationRequest,
    context: NativeEmailPublicationWorkContext, registered: boolean, readOnlyStatus=false) => {
    selected(request)
    requireNativeEmail(context.kind==='outbox' && context.outboxId===outboxId && context.attempt===1,'legacy_release_context_changed')
    const { c,h } = await lockedHold(tx)
    const cmd = request.command
    requireNativeEmail(h.local_id===cmd.localId && h.native_id===cmd.suiteCrmId && h.global_id===cmd.globalId
      && h.pipeline_id===cmd.pipelineId && h.workspace_id===cmd.workspaceId
      && Number(c.generation)===cmd.generation && c.native_policy_fingerprint===request.nativePolicyFingerprint,
    'legacy_release_identity_changed')
    const source = (await tx.query(`SELECT encode(public.digest(to_jsonb(i)::text,'sha256'),'hex') AS fingerprint
      FROM crm_interactions i WHERE i.id=$1::uuid`,[cmd.localId])).rows[0]?.fingerprint
    if (registered) {
      const r = await registration(tx)
      requireNativeEmail(Number(r.generation)===cmd.generation && r.activation_receipt_hash===c.activation_receipt_hash
        && r.intent_hash===h.release_intent_hash && r.source_fingerprint===source,'legacy_release_registration_changed')
      return
    }
    // An expired envelope cannot authorize new writes. Its previously verified
    // intent can still identify an untouched parked hold for read-only status.
    const a=readOnlyStatus?initialApproval:await approval(tx)
    requireNativeEmail(a,'legacy_release_approval_required')
    requireNativeEmail(a.localId===cmd.localId && a.nativeId===cmd.suiteCrmId && a.globalId===cmd.globalId
      && a.pipelineId===cmd.pipelineId && a.workspaceId===cmd.workspaceId && a.retiredOutboxId===h.retired_outbox_id
      && a.intentHash===h.release_intent_hash && a.retirementReceiptHash===h.retirement_receipt_hash
      && a.activationReceiptHash===c.activation_receipt_hash && a.sourceFingerprint===source,
    'legacy_release_approval_preimage_changed')
  }
  const resolveAuthority = async (tx: PoolClient, request: NativeEmailPublicationRequest, context: NativeEmailPublicationWorkContext) => {
    await resolutionAuthority(tx,request,context,true)
    await verifyHold(tx,request,context,true)
  }
  const makeCandidate = async (tx: PoolClient,item: CrmOutboxItem,readOnlyStatus=false) => {
    requireNativeEmail(item.id===outboxId,'legacy_release_outbox_changed')
    const result = await candidate(tx,item,true)
    await verifyHold(tx,result.request,result.context,false,readOnlyStatus)
    return result
  }
  const loadParkedItem=async(tx:PoolClient)=>{
    const { h }=await lockedHold(tx)
    const { outbox:o }=await rows(tx,h.local_id,outboxId,true)
    return {id:o.id,aggregateType:o.aggregate_type,aggregateId:o.aggregate_id,operation:o.operation,
      payload:o.payload,idempotencyKey:o.idempotency_key,attempts:Number(o.attempts),lockToken:o.lock_token} as CrmOutboxItem
  }
  const admissionAuthorizer=(item:CrmOutboxItem,expected:NativeEmailWorkerCandidate,owner:string,
    setLease:(lease:NativeEmailPublicationWorkLease)=>void)=>async(client:NativeEmailSqlClient,request:NativeEmailPublicationRequest)=>{
    const tx=client as PoolClient
    const current=await makeCandidate(tx,item)
    requireNativeEmail(same(current.request,request) && same(current.context,expected.context),'legacy_release_candidate_changed')
    setLease(await registerNativeEmailPublicationWork(tx,request,current.context,owner,async (_tx,_request,context,action) => {
      requireNativeEmail(action==='register' && same(context,current.context),'legacy_release_registration_changed')
    }))
    const a=await approval(tx)
    await tx.query('SELECT clawpilot_crm_legacy_email_register_release($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8)',
      [holdId,outboxId,nativeOperationId,requestFingerprint,a.activationReceiptHash,a.intentHash,a.approvalHash,a.sourceFingerprint])
  }
  const approveDispatch=async(tx:PoolClient,request:NativeEmailPublicationRequest)=>{
    await assertPrivateLegacyEmailRelationships(tx,request.command.localId,request.command.pipelineId,
      request.command.projection,request.command.projection?.attributes)
    const a=await approval(tx), admitted=await registration(tx)
    requireNativeEmail(a.approvalHash===admitted.approval_hash,'legacy_release_dispatch_approval_changed')
    const r=await tx.query(`UPDATE crm_native_email_publication_admissions SET state='dispatched',updated_at=now()
      WHERE operation_id=$1 AND state='admitted' RETURNING operation_id`,[nativeOperationId])
    return r.rows.length===1?a:null
  }
  const withFence=async<T>(run:(fence:NativeEmailRecoveryWriterFence,assertOpen:()=>void)=>Promise<T>):Promise<T>=>{
    requireNativeEmail(maintenance,'legacy_dispatch_unconfigured')
    const completed:{value:T}[]=[]
    let entered=false,closed=false,repeated=false
    const assertOpen=()=>requireNativeEmail(!closed,'legacy_dispatch_fence_released')
    const runUnderFence=async(verifiedFence:NativeEmailRecoveryWriterFence)=>{
      if(entered) repeated=true
      assertOpen()
      requireNativeEmail(!entered,'legacy_dispatch_fence_reentered')
      entered=true
      const value=await run(Object.freeze({...verifiedFence}),assertOpen)
      assertOpen()
      completed.push({value})
      return value
    }
    const protectedAction=(fence:NativeEmailRecoveryWriterFence)=>{
      const execution=runUnderFence(fence)
      // A broken adapter may detach the callback. Its rejection must still
      // reach an awaiting adapter but cannot become an unhandled rejection.
      void execution.catch(()=>{})
      return execution
    }
    try { await maintenance.withVerifiedFence(protectedAction) }
    finally { closed=true }
    requireNativeEmail(!repeated && completed.length===1,'legacy_dispatch_fence_incomplete')
    return completed[0].value
  }
  const lockedDispatchAuthorization=async(tx:PoolClient,request:NativeEmailPublicationRequest,
    lease:NativeEmailPublicationWorkLease)=>{
    selected(request)
    const context=await assertNativeEmailPublicationWorkLease(tx,request,lease)
    await resolveAuthority(tx,request,context)
    const registered=await registration(tx)
    const work=(await tx.query(`SELECT floor(extract(epoch FROM lease_until))::bigint AS expiry
      FROM crm_native_email_publication_work WHERE operation_id=$1`,[nativeOperationId])).rows[0]
    return {approvalHash:String(registered.approval_hash),leaseExpiresAt:Number(work?.expiry)}
  }
  const signFirstPublish=async(tx:PoolClient,request:NativeEmailPublicationRequest,lease:NativeEmailPublicationWorkLease,
    fence:NativeEmailRecoveryWriterFence,assertAuthorizing:()=>void)=>{
    requireNativeEmail(maintenance,'legacy_dispatch_unconfigured')
    const {approvalHash,leaseExpiresAt}=await lockedDispatchAuthorization(tx,request,lease)
    assertAuthorizing()
    const a=await approveDispatch(tx,request)
    requireNativeEmail(a,'legacy_dispatch_already_dispatched')
    const signed=maintenance.signer.signPermit({action:'publish',request,approvalHash,fence,
      leaseOwner:lease.owner,leaseFence:lease.fence,nowSeconds:await databaseSecond(tx),
      authorizationExpiresAt:Math.min(leaseExpiresAt,a.expiresAt)})
    assertAuthorizing()
    return signed
  }
  const withAuthorizedPublish=async<T>(request:NativeEmailPublicationRequest,
    commit:(fence:NativeEmailRecoveryWriterFence,assertAuthorizing:()=>void)=>
      Promise<{permit:NativeEmailRecoveryDispatchPermit;lease:NativeEmailPublicationWorkLease}>,
    run:MaintenanceInitialPublishRun<T>)=>{
    requireNativeEmail(maintenance && typeof run==='function','legacy_dispatch_unconfigured')
    return withFence(async(fence,assertOpen)=>{
      let open=true,invoked=false,committed:NativeEmailPublicationWorkLease|null=null
      const assertAuthorizing=()=>{assertOpen();requireNativeEmail(open,'legacy_dispatch_fence_released')}
      const authorize=()=>{
        const execution=(async()=>{
          assertAuthorizing()
          requireNativeEmail(!invoked,'legacy_dispatch_authorization_reentered')
          invoked=true
          const {permit,lease}=await commit(fence,assertAuthorizing)
          // Do not give the transport a permit or expose its settlement lease
          // until the one-use dispatch has committed and the fence is open.
          assertAuthorizing()
          committed=freezeMaintenanceValue(lease)
          return freezeMaintenanceValue(permit)
        })()
        void execution.catch(()=>{})
        return execution
      }
      try {
        const value=await run(Object.freeze({request,fence,authorize}),()=>{
          assertAuthorizing()
          return committed
        })
        requireNativeEmail(committed,'legacy_dispatch_authorization_incomplete')
        return value
      } finally {open=false}
    })
  }
  return {
    async loadItem() {
      return transaction(async tx => {
        const item=await loadParkedItem(tx)
        await makeCandidate(tx,item)
        return item
      })
    },
    mode: () => transaction(async tx => {
      const c=await control(tx)
      requireNativeEmail(c.enabled===true,'legacy_release_control_changed')
      return checkControl(c)
    }),
    candidate: item => transaction(tx=>makeCandidate(tx,item)),
    async admit(item,expected,owner) {
      selected(expected.request)
      let lease: NativeEmailPublicationWorkLease | undefined
      const admission=await store.admit(input(expected.request),admissionAuthorizer(item,expected,owner,value=>{lease=value}))
      requireNativeEmail(lease,'reconciliation_required')
      return {admission,lease}
    },
    markDispatched: (request,lease) => transaction(async tx => {
      requireNativeEmail(!maintenance,'legacy_dispatch_permit_required')
      selected(request)
      const context=await assertNativeEmailPublicationWorkLease(tx,request,lease)
      await resolveAuthority(tx,request,context)
      return !!await approveDispatch(tx,request)
    }),
    async withMaintenanceDispatch<T>(selection:MaintenanceDispatchSelection,run:(input:{request:NativeEmailPublicationRequest;
      permit:NativeEmailRecoveryDispatchPermit})=>Promise<T>) {
      requireNativeEmail(maintenance && typeof run==='function','legacy_dispatch_unconfigured')
      const exactSelection=structuredClone(selection)
      requireNativeEmail(exactSelection.action!=='publish','legacy_dispatch_publish_requires_readiness')
      return withFence(async(fence,assertOpen)=>{
        const packet=await transaction(async tx=>{
          const {action}=exactSelection
          if (action==='prepare') {
            const {request}=await makeCandidate(tx,exactSelection.item), a=await approval(tx)
            return {request,permit:maintenance.signer.signPermit({action,request,approvalHash:a.approvalHash,
              fence,leaseOwner:null,leaseFence:null,nowSeconds:await databaseSecond(tx),authorizationExpiresAt:a.expiresAt})}
          }
          requireNativeEmail(action==='resolve','legacy_dispatch_action_invalid')
          const {request,lease}=exactSelection
          const {approvalHash,leaseExpiresAt}=await lockedDispatchAuthorization(tx,request,lease)
          assertOpen()
          return {request,permit:maintenance.signer.signPermit({action,request,approvalHash,
            fence,leaseOwner:lease.owner,leaseFence:lease.fence,nowSeconds:await databaseSecond(tx),authorizationExpiresAt:leaseExpiresAt})}
        })
        // No process or network call until this transaction COMMIT returned.
        // Keep the independently verified writer fence across that call.
        assertOpen()
        return run(freezeMaintenanceValue(packet))
      })
    },
    async withMaintenancePublish<T>(request:NativeEmailPublicationRequest,lease:NativeEmailPublicationWorkLease,
      run:(input:MaintenancePublishAuthorization)=>Promise<T>) {
      const exactRequest=freezeMaintenanceValue(structuredClone(request)),exactLease=freezeMaintenanceValue(structuredClone(lease))
      selected(exactRequest)
      // Compatibility only for an existing admission with its original live
      // approval. Never create an admission here or replace its approval.
      return withAuthorizedPublish(exactRequest,(fence,assertAuthorizing)=>transaction(async tx=>({
        permit:await signFirstPublish(tx,exactRequest,exactLease,fence,assertAuthorizing),lease:exactLease,
      })),run)
    },
    async withMaintenanceInitialPublish<T>(item:CrmOutboxItem,expected:NativeEmailWorkerCandidate,owner:string,
      run:MaintenanceInitialPublishRun<T>) {
      const exactItem=freezeMaintenanceValue(structuredClone(item)),exactExpected=freezeMaintenanceValue(structuredClone(expected))
      const request=exactExpected.request
      selected(request)
      requireNativeEmail(same(prepareNativeEmailPublication(input(request)),request),'legacy_release_candidate_changed')
      // A connection that never proves readiness leaves nothing admitted. On
      // this exact connection, authorization performs registration, admission,
      // the first dispatch CAS and signing as a single short transaction.
      return withAuthorizedPublish(request,(fence,assertAuthorizing)=>transaction(async tx=>{
        let lease:NativeEmailPublicationWorkLease|undefined
        const admission=await store.admitInTransaction(tx,input(request),
          admissionAuthorizer(exactItem,exactExpected,owner,value=>{lease=value}))
        requireNativeEmail(lease && admission.state==='admitted' && !admission.receipt && same(admission.request,request),
          'legacy_dispatch_resolution_required')
        assertAuthorizing()
        // Migration 0405 checks the exact newly inserted release while its
        // admission is still `admitted`. Fire only that existing constraint
        // before advancing the row; any later failure still rolls it all back.
        await tx.query('SET CONSTRAINTS public.crm_legacy_email_release_binding IMMEDIATE')
        return {permit:await signFirstPublish(tx,request,lease,fence,assertAuthorizing),lease}
      }),run)
    },
    async maintenancePublishState(request) {
      const exactRequest=structuredClone(request)
      selected(exactRequest)
      requireNativeEmail(same(prepareNativeEmailPublication(input(exactRequest)),exactRequest),'legacy_release_operation_changed')
      return transaction(async tx=>{
        const c=await control(tx)
        requireNativeEmail(c.enabled===true && c.active_transition_id===null && c.active_initial_enrollment_id===null
          && (c.active_operation_id===null || c.active_operation_id===nativeOperationId),'legacy_release_control_changed')
        const admission=await store.findInTransaction(tx,nativeOperationId),registered=await findRegistration(tx)
        if (admission || registered) {
          requireNativeEmail(admission && registered?.request_fingerprint===requestFingerprint,'legacy_release_registration_changed')
          selected(admission.request)
          requireNativeEmail(same(admission.request,exactRequest),'legacy_release_operation_changed')
          requireNativeEmail(c.active_operation_id===(admission.receipt?null:nativeOperationId),'legacy_release_control_changed')
          return admission.state
        }
        requireNativeEmail(c.active_operation_id===null,'legacy_release_control_changed')
        const current=await makeCandidate(tx,await loadParkedItem(tx),true)
        requireNativeEmail(same(current.request,exactRequest),'legacy_release_operation_changed')
        requireNativeEmail(initialApproval,'legacy_release_approval_required')
        const cmd=exactRequest.command
        const untouched=await tx.query(`SELECT NOT EXISTS(SELECT 1 FROM crm_native_email_publication_admissions
          WHERE local_id=$1::uuid OR lower(native_id)=lower($2) OR lower(global_id)=lower($3))
          AND NOT EXISTS(SELECT 1 FROM sync_outbox WHERE id=$4::uuid) AS exact`,
        [cmd.localId,cmd.suiteCrmId,cmd.globalId,initialApproval.retiredOutboxId])
        requireNativeEmail(untouched.rows.length===1 && untouched.rows[0].exact===true,'legacy_release_registration_changed')
        return 'not_admitted'
      })
    },
    async markUnknown(id) {
      requireNativeEmail(id===nativeOperationId,'legacy_release_operation_changed')
      await transaction(registration)
      const admission=await store.get(id)
      selected(admission.request)
      await store.markUnknown(id)
    },
    async claimResolution(id,owner) {
      requireNativeEmail(id===nativeOperationId,'legacy_release_operation_changed')
      const admission=await store.get(id)
      selected(admission.request)
      requireNativeEmail(!admission.receipt,'reconciliation_required')
      const lease=await transaction(tx=>claimNativeEmailPublicationResolution(tx,admission.request,owner,
        (client,request,context)=>resolveAuthority(client as PoolClient,request,context)))
      return {admission,lease}
    },
    async settle(request,lease,value) {
      selected(request)
      const receipt=verifyNativeEmailPublicationReceipt(request,value)
      // The store can short-circuit a terminal replay without its callbacks.
      // Pin that read to this immutable hold as well, not just the request ID.
      await transaction(registration)
      const terminal=await store.settlePrivateRelease(nativeOperationId,receipt,async (client,admitted,value) => {
        verifyNativeEmailPublicationReceipt(admitted,value)
        const context=await assertNativeEmailPublicationWorkLease(client,admitted,lease)
        await resolveAuthority(client as PoolClient,admitted,context)
      },async (client,_admitted,value) => {
        const r=await client.query('SELECT clawpilot_crm_legacy_email_settle_release($1::uuid,$2,$3::uuid,$4::bigint) AS state',
          [holdId,nativeOperationId,lease.owner,lease.fence])
        requireNativeEmail(r.rows.length===1 && r.rows[0].state===value.state,'legacy_release_settlement_changed')
      })
      return {synchronized:terminal.state==='committed',pipelineId:request.command.pipelineId,outboxId}
    },
    // No generic fail, queue retry, or release. A missing outcome remains held.
    async hold(item) { requireNativeEmail(item.id===outboxId,'legacy_release_outbox_changed') },
  }
}
