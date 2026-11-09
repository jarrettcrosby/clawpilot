import 'server-only'
import type { PoolClient } from 'pg'
import { assertVerifiedLegacyHeldEmailRecoveryApproval, type LegacyHeldEmailRecoveryApproval } from '../crm/legacyHeldEmailRecoveryApproval'
import { nativeEmailCanonicalJson, nativeEmailDigest, requireNativeEmail } from '../crm/nativeEmailPublication'
import type { SuiteCrmOutboxRecord } from '../crm/types'
import { reviewedEmailAudienceUnderNativeControlWithClient, type CrmOutboxItem } from './crm'
import { previewUnstagedPrivateLegacyEmailRecoveryCandidate } from './crmNativeEmailPublication'
import type { withTransaction } from './postgres'

type Transaction=typeof withTransaction
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const HASH=/^[0-9a-f]{64}(?![\s\S])/u
const GLOBAL=/^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const ROLE=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}(?![\s\S])/u

export type HeldOriginalRecoveryTarget=Readonly<{holdId:string;outboxId:string;holdReceiptHash:string;lockToken:string}>
export type HeldOriginalRecoveryPins=Omit<LegacyHeldEmailRecoveryApproval,
  'version'|'purpose'|'keyId'|'issuedAt'|'expiresAt'|'intentHash'|'approvalHash'>
export type HeldOriginalRecoveryReadPins=Readonly<{outboxId:string;intentHash:string;approvalHash:string}>
export type HeldOriginalRecoveryStageReceipt=HeldOriginalRecoveryReadPins&Readonly<{state:'staged';holdBatchId:string;receiptHash:string}>

function need(value:unknown,code:string):asserts value { requireNativeEmail(value,'legacy_held_email_stage_'+code) }
function matches(value:unknown,pattern:RegExp):value is string { return typeof value==='string'&&pattern.test(value) }
function snapshotTarget(target:HeldOriginalRecoveryTarget):HeldOriginalRecoveryTarget {
  const {holdId,outboxId,holdReceiptHash,lockToken}=target
  need([holdId,outboxId,lockToken].every(value=>matches(value,UUID))&&matches(holdReceiptHash,HASH),'target_invalid')
  return Object.freeze({holdId,outboxId,holdReceiptHash,lockToken})
}
function snapshotReadPins(target:HeldOriginalRecoveryReadPins):HeldOriginalRecoveryReadPins {
  const {outboxId,intentHash,approvalHash}=target
  need(matches(outboxId,UUID)&&matches(intentHash,HASH)&&matches(approvalHash,HASH),'read_pins_invalid')
  return Object.freeze({outboxId,intentHash,approvalHash})
}
async function directLogin(tx:PoolClient) {
  await tx.query("SET LOCAL TIME ZONE 'UTC'")
  const {rows}=await tx.query<{login:string;role:string;direct:boolean;second:string}>(`SELECT session_user::text AS login,
    current_user::text AS role,current_setting('role')='none' AND current_setting('transaction_isolation')='read committed' AS direct,
    floor(extract(epoch FROM clock_timestamp()))::bigint AS second`)
  const row=rows[0],second=Number(row?.second)
  need(rows.length===1&&matches(row.login,ROLE)&&row.login===row.role&&row.direct===true&&Number.isSafeInteger(second)&&second>0,'login_unproven')
  return {login:row.login,second}
}
type Original={local_id:string;pipeline_id:string;workspace_id:string;native_id:string;global_id:string;
  native_authority_instance_id:string;original_fingerprint:string;source_fingerprint:string;
  relationship_fingerprint:string;provider_identity_fingerprint:string;idempotency_key:string}

async function prepare(tx:PoolClient,target:HeldOriginalRecoveryTarget) {
  // All source/membership writers take this singleton before row locks. The
  // shared candidate builder later takes the interaction row, never outbox
  // first. Keep the current policy and exact app mappings consistent.
  const {rows:control}=await tx.query<{ready:boolean}>(`SELECT enabled AND verified_generation=generation
    AND active_operation_id IS NULL AND active_transition_id IS NULL AND active_initial_enrollment_id IS NULL AS ready
    FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE`)
  need(control.length===1&&control[0].ready===true,'authority_changed')
  const {rows}=await tx.query<Original>(`SELECT h.local_id::text,h.pipeline_id::text,h.workspace_id::text,h.native_id,h.global_id,
    b.manifest#>>'{scope,nativeAuthorityInstanceId}' AS native_authority_instance_id,h.row_fingerprint AS original_fingerprint,
    evidence.source_fingerprint,evidence.relationship_fingerprint,evidence.provider_identity_fingerprint,o.idempotency_key
    FROM crm_legacy_email_terminal_hold.held h
    JOIN crm_legacy_email_terminal_hold.verified_batch b USING(batch)
    JOIN crm_legacy_email_terminal_hold.consumed c USING(batch)
    JOIN public.sync_outbox o ON o.id=h.outbox_id
    JOIN public.crm_interactions i ON i.id=h.local_id AND i.pipeline_id=h.pipeline_id
    JOIN LATERAL jsonb_array_elements(b.manifest->'rows') reviewed(row_data) ON reviewed.row_data->>'outboxId'=o.id::text
    CROSS JOIN LATERAL (SELECT encode(public.digest(to_jsonb(i)::text,'sha256'),'hex') AS source_fingerprint,
      crm_legacy_email_terminal_hold.relationship_fingerprint(i.id) AS relationship_fingerprint,
      crm_legacy_email_terminal_hold.provider_identity_fingerprint(i.id) AS provider_identity_fingerprint) evidence
    WHERE h.outbox_id=$1::uuid AND h.batch=$2::uuid AND c.receipt_hash=$3::text
      AND c.consumed_at<b.valid_until AND c.held_rows=jsonb_array_length(b.manifest->'rows')
      AND o.status='dead' AND o.attempts=8 AND o.last_error='native_projection_proof_unavailable'
      AND o.lock_token IS NULL AND o.locked_at IS NULL AND o.processed_at IS NOT NULL
      AND o.target_system='suitecrm' AND o.aggregate_type='crm_interactions' AND o.operation='upsert_record'
      AND o.aggregate_id=h.local_id::text AND to_jsonb(o)=h.original
      AND i.suitecrm_module='Emails' AND i.suitecrm_id=h.native_id AND i.reference_code=h.global_id
      AND i.sync_status='failed' AND i.suitecrm_synced_at IS NULL
      AND reviewed.row_data->>'localId'=h.local_id::text AND reviewed.row_data->>'pipelineId'=h.pipeline_id::text
      AND reviewed.row_data->>'workspaceId'=h.workspace_id::text AND reviewed.row_data->>'nativeId'=h.native_id
      AND reviewed.row_data->>'globalId'=h.global_id AND reviewed.row_data->>'rowFingerprint'=h.row_fingerprint
      AND reviewed.row_data->>'sourceFingerprint'=evidence.source_fingerprint
      AND reviewed.row_data->>'relationshipFingerprint'=evidence.relationship_fingerprint
      AND reviewed.row_data->>'providerIdentityFingerprint'=evidence.provider_identity_fingerprint
      AND EXISTS(SELECT 1 FROM public.crm_operator_accounts a JOIN public.workspace_organizations root ON root.id=a.root_workspace_id
        JOIN public.app_users u ON u.email=a.owner_email
        JOIN public.app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=root.id
        JOIN public.crm_operator_workspace_bindings binding ON binding.operator_account_id=a.id AND binding.owner_email=a.owner_email
        JOIN public.workspace_organizations w ON w.id=binding.workspace_id
        JOIN public.pipeline_spaces p ON p.workspace_organization_id=w.id
        WHERE a.id::text=b.manifest->>'operatorAccountId' AND a.owner_email=b.manifest->>'actorEmail'
          AND root.id::text=b.manifest->>'rootWorkspaceId' AND a.enabled AND binding.enabled
          AND root.parent_id IS NULL AND root.organization_type='root' AND NOT root.is_demo
          AND u.status='active' AND u.role='owner' AND m.status='active' AND m.trashed_at IS NULL AND m.role='owner'
          AND w.id=h.workspace_id AND p.id=h.pipeline_id AND NOT w.is_demo AND NOT p.reference_access_disabled)`,
  [target.outboxId,target.holdId,target.holdReceiptHash])
  const original=rows[0]
  need(rows.length===1&&[original.local_id,original.pipeline_id,original.workspace_id,original.native_id].every(value=>matches(value,UUID))
    &&matches(original.native_authority_instance_id,/^[A-Za-z0-9][A-Za-z0-9-]{0,35}(?![\s\S])/u)&&matches(original.global_id,GLOBAL)
    &&[original.original_fingerprint,original.source_fingerprint,original.relationship_fingerprint,original.provider_identity_fingerprint]
      .every(value=>matches(value,HASH))&&typeof original.idempotency_key==='string','consumed_hold_unproven')
  const audience=await reviewedEmailAudienceUnderNativeControlWithClient(tx,original.pipeline_id)
  need(audience.workspaceId===original.workspace_id,'audience_scope_changed')
  // JSONB must render the postimage before the existing worker hashes parsed
  // JSON. Hash the persisted SQL representation independently for stage SQL.
  const postimage=(await tx.query<{payload:SuiteCrmOutboxRecord;fingerprint:string}>(`SELECT payload,
    encode(public.digest(payload::text,'sha256'),'hex') AS fingerprint FROM (
      SELECT jsonb_set(o.payload,'{emailProjection,audience}',$2::jsonb,true) AS payload
      FROM public.sync_outbox o WHERE o.id=$1::uuid) exact`,[target.outboxId,audience])).rows
  const row=postimage[0]
  const payload=row?.payload,projection=payload?.emailProjection
  const primary=payload?.attributes?.parent_id, accounts=projection?.accounts
  need(postimage.length===1&&matches(row.fingerprint,HASH)&&payload?.attributes?.parent_type==='Accounts'
    &&matches(primary,UUID)&&projection?.version===1&&Array.isArray(accounts)&&accounts.length>=1&&accounts.length<=25
    &&accounts.every((value,index)=>matches(value,UUID)&&(index===0||value>accounts[index-1]))&&accounts.includes(primary)
    &&Array.isArray(projection.previousManaged?.accounts)&&projection.previousManaged.accounts.length===0
    &&Array.isArray(projection.previousManaged?.contacts)&&projection.previousManaged.contacts.length===0,'placement_unproven')
  const item:CrmOutboxItem={id:target.outboxId,aggregateType:'crm_interactions',aggregateId:original.local_id,
    operation:'upsert_record',payload,idempotencyKey:original.idempotency_key,attempts:1,lockToken:target.lockToken}
  const {proposed,activationReceiptHash}=await previewUnstagedPrivateLegacyEmailRecoveryCandidate(tx,item,original.source_fingerprint)
  const {command,requestFingerprint}=proposed.request
  need(command.version===2&&command.mode==='publish'&&command.expectedRecordFingerprint===null
    &&command.localId===original.local_id&&command.suiteCrmId===original.native_id&&command.globalId===original.global_id
    &&command.pipelineId===original.pipeline_id&&command.workspaceId===original.workspace_id&&matches(activationReceiptHash,HASH),
  'exact_candidate_changed')
  const pins:HeldOriginalRecoveryPins=Object.freeze({holdBatchId:target.holdId,outboxId:target.outboxId,lockToken:target.lockToken,
    holdReceiptHash:target.holdReceiptHash,localId:command.localId,nativeId:command.suiteCrmId,globalId:command.globalId,
    pipelineId:command.pipelineId,workspaceId:command.workspaceId,nativeAuthorityInstanceId:original.native_authority_instance_id,
    originalFingerprint:original.original_fingerprint,sourceFingerprint:original.source_fingerprint,
    relationshipFingerprint:original.relationship_fingerprint,providerIdentityFingerprint:original.provider_identity_fingerprint,
    activationReceiptHash,stagedPayloadFingerprint:row.fingerprint,requestFingerprint,nativeOperationId:command.operationId,
    generation:command.generation,primaryAccountId:primary,accountIds:Object.freeze([...accounts])})
  return {pins,payload}
}

/** Private one-record preview. The transaction must pin the exact DB and role.
 * Only review pins leave the transaction, never the stored or projected Email. */
export function previewHeldOriginalRecovery(transaction:Transaction,target:HeldOriginalRecoveryTarget) {
  const exact=snapshotTarget(target)
  return transaction(async tx=>{
    await directLogin(tx)
    return Object.freeze({pins:(await prepare(tx,exact)).pins})
  })
}

/** Record a verified signature through the independent, scoped attestor
 * connection. This does not stage a claim or authorize any provider call. */
export function attestHeldOriginalRecoveryApproval(input:{attestTransaction:Transaction;attestorUser:string;approval:unknown}) {
  const {attestTransaction,attestorUser,approval}=input
  assertVerifiedLegacyHeldEmailRecoveryApproval(approval)
  need(matches(attestorUser,ROLE),'attestor_invalid')
  const {intentHash,approvalHash,...proof}=approval
  const readPins=snapshotReadPins({outboxId:proof.outboxId,intentHash,approvalHash})
  const canonical=nativeEmailCanonicalJson(proof)
  return attestTransaction(async tx=>{
    const {login,second}=await directLogin(tx)
    need(login===attestorUser&&proof.issuedAt<=second&&second<proof.expiresAt,'attestation_login_or_expiry_changed')
    const result=await tx.query(`INSERT INTO crm_legacy_email_terminal_hold.verified_recovery
      (outbox_id,proof,proof_canonical,proof_hash,intent_hash,approval_hash,valid_until)
      VALUES($1::uuid,$2::text::jsonb,$2::text,$3,$4,$5,to_timestamp($6))`,
    [readPins.outboxId,canonical,nativeEmailDigest(proof),readPins.intentHash,readPins.approvalHash,proof.expiresAt])
    need(result.rowCount===1,'attestation_count_changed')
    return readPins
  })
}

function stageReceipt(value:unknown,pins:HeldOriginalRecoveryReadPins,expectedBatch?:string):HeldOriginalRecoveryStageReceipt {
  const r=value as Partial<HeldOriginalRecoveryStageReceipt>|null
  need(r?.state==='staged'&&Object.keys(r).length===6&&r.outboxId===pins.outboxId&&r.intentHash===pins.intentHash
    &&r.approvalHash===pins.approvalHash&&matches(r.holdBatchId,UUID)&&(expectedBatch===undefined||r.holdBatchId===expectedBatch)
    &&matches(r.receiptHash,HASH),'receipt_unproven')
  return Object.freeze({...pins,state:'staged',holdBatchId:r.holdBatchId,receiptHash:r.receiptHash})
}

/** Stage once, with independently attested review and exact DB-side CAS.
 * Never retry either write after an ambiguous COMMIT acknowledgement. */
export async function stageHeldOriginalRecovery(input:{transaction:Transaction;attestTransaction:Transaction;
  attestorUser:string;target:HeldOriginalRecoveryTarget;approval:unknown}):Promise<HeldOriginalRecoveryStageReceipt> {
  const {transaction,attestTransaction,attestorUser,approval}=input
  const exact=snapshotTarget(input.target)
  assertVerifiedLegacyHeldEmailRecoveryApproval(approval)
  need(matches(attestorUser,ROLE)&&transaction!==attestTransaction&&approval.holdBatchId===exact.holdId
    &&approval.outboxId===exact.outboxId&&approval.holdReceiptHash===exact.holdReceiptHash&&approval.lockToken===exact.lockToken,
  'approval_target_changed')
  const verifyCandidate=async (tx:PoolClient)=>{
    const {login,second}=await directLogin(tx)
    need(login!==attestorUser&&approval.issuedAt<=second&&second<approval.expiresAt,'controller_login_or_expiry_changed')
    const prepared=await prepare(tx,exact)
    need((Object.keys(prepared.pins) as (keyof HeldOriginalRecoveryPins)[]).every(key=>
      nativeEmailCanonicalJson(prepared.pins[key])===nativeEmailCanonicalJson(approval[key])),'approval_intent_changed')
    return prepared
  }
  // Validate before registering an approval, then repeat under the stage
  // transaction; the attestation itself must not hold the controller lock.
  await transaction(async tx=>{ await verifyCandidate(tx) })
  const readPins=await attestHeldOriginalRecoveryApproval({attestTransaction,attestorUser,approval})
  return transaction(async tx=>{
    const {payload}=await verifyCandidate(tx)
    const {rows}=await tx.query(`SELECT crm_legacy_email_terminal_hold.stage_recovery($1::uuid,$2::text,$3::jsonb) AS receipt`,
      [readPins.outboxId,readPins.approvalHash,payload])
    need(rows.length===1,'receipt_unproven')
    return stageReceipt(rows[0].receipt,readPins,exact.holdId)
  })
}

/** Read-only stage evidence, not current native publication or delivery proof. */
export function inspectHeldOriginalRecovery(transaction:Transaction,input:HeldOriginalRecoveryReadPins):
  Promise<HeldOriginalRecoveryStageReceipt|Readonly<{state:'unknown'}>> {
  const pins=snapshotReadPins(input)
  return transaction(async tx=>{
    await directLogin(tx)
    const {rows}=await tx.query(`SELECT crm_legacy_email_terminal_hold.resolve_recovery($1::uuid,$2::text,$3::text) AS receipt`,
      [pins.outboxId,pins.intentHash,pins.approvalHash])
    need(rows.length===1,'receipt_unproven')
    const receipt=rows[0].receipt
    if(receipt?.state==='unknown'&&Object.keys(receipt).length===1) return Object.freeze({state:'unknown' as const})
    return stageReceipt(receipt,pins)
  })
}
