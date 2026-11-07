import 'server-only'
import type { PoolClient } from 'pg'
import { assertVerifiedLegacyEmailRecoveryReleaseApproval, type LegacyEmailRecoveryReleaseApproval } from '../crm/legacyEmailRecoveryReleaseApproval'
import { requireNativeEmail } from '../crm/nativeEmailPublication'
import type { SuiteCrmOutboxRecord } from '../crm/types'
import { reviewedEmailAudienceUnderNativeControlWithClient, type CrmOutboxItem } from './crm'
import { inspectExactLegacyEmailRecoveryWithClient, type ExactEmailPublicationSelection } from './crmExactEmailPublication'
import { previewUnstagedPrivateLegacyEmailRecoveryCandidate } from './crmNativeEmailPublication'
import type { withTransaction } from './postgres'

type Transaction = typeof withTransaction
type ExpectedOrganizations = {primaryNativeId:string;nativeIds:string[]}
type StageTarget = { selected: ExactEmailPublicationSelection; retiredOutboxId: string; retirementReceiptHash: string;
  holdId: string; outboxId: string; lockToken: string; expectedOrganizations:ExpectedOrganizations }
type StageReceipt = {state:'staged';holdId:string;outboxId:string;retiredOutboxId:string;intentHash:string;receiptHash:string}
const HASH = /^[a-f0-9]{64}(?![\s\S])/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[0-9a-f]{12}(?![\s\S])/

function validateTarget(target: StageTarget) {
  requireNativeEmail([target.retiredOutboxId,target.holdId,target.outboxId,target.lockToken]
    .every(v=>typeof v==='string' && UUID.test(v)) && target.retiredOutboxId!==target.outboxId
    && typeof target.retirementReceiptHash==='string' && HASH.test(target.retirementReceiptHash),'legacy_stage_target_invalid')
  const expected=target.expectedOrganizations
  requireNativeEmail(expected&&UUID.test(expected.primaryNativeId)
    && Array.isArray(expected.nativeIds)&&expected.nativeIds.length>0&&expected.nativeIds.length<=25
    && expected.nativeIds.every((value,index)=>UUID.test(value)&&(index===0||value>expected.nativeIds[index-1]))
    && expected.nativeIds.includes(expected.primaryNativeId),'legacy_stage_approved_organizations_invalid')
}
function snapshotTarget(target: StageTarget): StageTarget {
  const {retiredOutboxId,retirementReceiptHash,holdId,outboxId,lockToken,selected,expectedOrganizations}=target
  requireNativeEmail(selected && Array.isArray(selected.messageIds),'legacy_stage_target_invalid')
  validateTarget(target)
  const {ownerEmail,workspaceId,pipelineId,connectionId,messageIds}=selected
  const copy={retiredOutboxId,retirementReceiptHash,holdId,outboxId,lockToken,
    selected:{ownerEmail,workspaceId,pipelineId,connectionId,messageIds:[...messageIds]},
    expectedOrganizations:{primaryNativeId:expectedOrganizations.primaryNativeId,nativeIds:[...expectedOrganizations.nativeIds]}}
  validateTarget(copy)
  return copy
}
async function prepare(tx: PoolClient,target: StageTarget) {
  validateTarget(target)
  const original=(await tx.query('SELECT clawpilot_crm_legacy_email_stage_source($1::uuid,$2) AS source',
    [target.retiredOutboxId,target.retirementReceiptHash])).rows[0]?.source
  requireNativeEmail(original && original.retiredOutboxId===target.retiredOutboxId
    && original.retirementReceiptHash===target.retirementReceiptHash && typeof original.originalFingerprint==='string'
    && HASH.test(original.originalFingerprint) && typeof original.idempotencyKey==='string','legacy_stage_archive_unknown')
  const inspection=await inspectExactLegacyEmailRecoveryWithClient(tx,target.selected,{
    oldOutboxId:target.retiredOutboxId,localId:original.localId,nativeId:original.nativeId,globalId:original.globalId,
    pipelineId:original.pipelineId,workspaceId:original.workspaceId,sourceFingerprint:original.sourceFingerprint,
    retirementReceiptDigest:target.retirementReceiptHash,
  })
  const audience=await reviewedEmailAudienceUnderNativeControlWithClient(tx,original.pipelineId)
  const archived=original.payload as SuiteCrmOutboxRecord
  requireNativeEmail(archived?.entity==='interactions' && archived.suiteCrmModule==='Emails' && !archived.previousSuiteCrmModule
    && archived.localId===original.localId && archived.pipelineId===original.pipelineId && archived.suiteCrmId===original.nativeId
    && archived.attributes?.global_id_c===original.globalId && archived.attributes.assigned_user_id===audience.ownerSuiteCrmId
    && archived.emailProjection?.version===1 && Array.isArray(archived.emailProjection.previousManaged?.accounts)
    && archived.emailProjection.previousManaged.accounts.length===0 && Array.isArray(archived.emailProjection.previousManaged?.contacts)
    && archived.emailProjection.previousManaged.contacts.length===0,'legacy_stage_archive_payload_changed')
  // Archival is immutable; it is not an association-correction mechanism.
  // Refuse old placement bytes even if the operator supplies a signature for
  // them. The same guard runs under the staging transaction, not just preview.
  const expected=target.expectedOrganizations
  requireNativeEmail(archived.attributes.parent_type==='Accounts'&&archived.attributes.parent_id===expected.primaryNativeId
    && Array.isArray(archived.emailProjection.accounts)&&archived.emailProjection.accounts.length===expected.nativeIds.length
    && archived.emailProjection.accounts.every((value,index)=>value===expected.nativeIds[index]),'legacy_stage_approved_organizations_changed')
  const primary=await tx.query<{native_id:string}>(`SELECT a.suitecrm_id AS native_id
    FROM public.crm_interactions i JOIN public.crm_organizations a
      ON a.pipeline_id=i.pipeline_id AND a.id=i.organization_id
    JOIN public.crm_interaction_organizations edge ON edge.pipeline_id=i.pipeline_id
      AND edge.interaction_id=i.id AND edge.organization_id=a.id AND edge.is_primary
    WHERE i.id=$1::uuid AND i.pipeline_id=$2::uuid`,[original.localId,original.pipelineId])
  requireNativeEmail(primary.rows.length===1&&primary.rows[0].native_id===expected.primaryNativeId,
    'legacy_stage_approved_organizations_changed')
  // The established outbox payload hash depends on the persisted JSONB key
  // order, including inside a replacement audience. Preview the exact SQL
  // postimage so the signed operation is identical when the worker reads it.
  const postimage=await tx.query<{ payload: SuiteCrmOutboxRecord }>(`SELECT
    jsonb_set($1::jsonb,'{emailProjection,audience}',$2::jsonb,true) AS payload`,[archived,audience])
  requireNativeEmail(postimage.rows.length===1 && postimage.rows[0].payload,'legacy_stage_postimage_unavailable')
  const item: CrmOutboxItem={id:target.outboxId,aggregateType:'crm_interactions',aggregateId:original.localId,
    operation:'upsert_record',payload:postimage.rows[0].payload,
    idempotencyKey:original.idempotencyKey,attempts:1,lockToken:target.lockToken}
  // The shared candidate builder rechecks the archived associations, including
  // each Contact's current owning Account, just as it will at admission.
  const {proposed,activationReceiptHash}=await previewUnstagedPrivateLegacyEmailRecoveryCandidate(tx,item,original.sourceFingerprint)
  const pins={holdId:target.holdId,outboxId:target.outboxId,retiredOutboxId:target.retiredOutboxId,localId:proposed.request.command.localId,
    nativeId:proposed.request.command.suiteCrmId,globalId:proposed.request.command.globalId,pipelineId:proposed.request.command.pipelineId,
    workspaceId:proposed.request.command.workspaceId,sourceFingerprint:String(original.sourceFingerprint),
    retirementReceiptHash:target.retirementReceiptHash,activationReceiptHash,requestFingerprint:proposed.request.requestFingerprint,
    nativeOperationId:proposed.request.command.operationId}
  return {pins,inspectionDigest:inspection.digest,audience}
}

/** Private review-only plan; no original payload or provider credentials leave
 * the transaction. The selected source and approved claim are re-derived when
 * staging. Native absence is freshly checked by the publisher before dispatch. */
export function previewExactLegacyEmailRecoveryStagePrivately(transaction: Transaction,target: StageTarget) {
  const exactTarget=snapshotTarget(target)
  return transaction(async tx=>{
    await tx.query("SET LOCAL TIME ZONE 'UTC'")
    const {pins,inspectionDigest}=await prepare(tx,exactTarget)
    return Object.freeze({pins:Object.freeze(pins),inspectionDigest})
  })
}

function stageReceipt(value: unknown, pins: Pick<StageReceipt,'holdId'|'outboxId'|'retiredOutboxId'|'intentHash'>) {
  const r=value as Partial<StageReceipt> | null
  requireNativeEmail(r?.state==='staged' && r.holdId===pins.holdId && r.outboxId===pins.outboxId
    && r.retiredOutboxId===pins.retiredOutboxId && r.intentHash===pins.intentHash
    && typeof r.receiptHash==='string' && HASH.test(r.receiptHash),'legacy_stage_receipt_invalid')
  return Object.freeze({...pins,state:'staged' as const,receiptHash:r.receiptHash})
}

/** Called only with the separately provisioned private staging login. No
 * default credentials, live fence, provider call or public route is installed. */
export function stageExactLegacyEmailRecoveryPrivately(transaction: Transaction,target: StageTarget,approval: unknown) {
  assertVerifiedLegacyEmailRecoveryReleaseApproval(approval)
  const exactTarget=snapshotTarget(target)
  return transaction(async tx=>{
    await tx.query("SET LOCAL TIME ZONE 'UTC'")
    const {pins,audience}=await prepare(tx,exactTarget)
    requireNativeEmail((Object.keys(pins) as Array<keyof typeof pins>).every(key=>pins[key]===approval[key]),'legacy_stage_approval_changed')
    const row=(await tx.query(`SELECT clawpilot_crm_legacy_email_stage($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) AS receipt`,
      [pins.holdId,pins.outboxId,pins.retiredOutboxId,exactTarget.lockToken,pins.retirementReceiptHash,pins.activationReceiptHash,
        approval.intentHash,approval.approvalHash,approval.issuedAt,approval.expiresAt,audience])).rows[0]
    return stageReceipt(row?.receipt,{holdId:pins.holdId,outboxId:pins.outboxId,retiredOutboxId:pins.retiredOutboxId,intentHash:approval.intentHash})
  })
}

export function resolveExactLegacyEmailStagePrivately(transaction: Transaction,
  approved: Pick<LegacyEmailRecoveryReleaseApproval,'holdId'|'outboxId'|'retiredOutboxId'|'intentHash'>) {
  const {holdId,outboxId,retiredOutboxId,intentHash}=approved
  requireNativeEmail([holdId,outboxId,retiredOutboxId].every(v=>typeof v==='string' && UUID.test(v))
    && typeof intentHash==='string' && HASH.test(intentHash),'legacy_stage_resolution_invalid')
  return transaction(async tx=>{
    const value=(await tx.query('SELECT clawpilot_crm_legacy_email_stage_read($1::uuid,$2) AS receipt',[holdId,intentHash])).rows[0]?.receipt
    if(value?.state==='unknown') return Object.freeze({state:'unknown' as const})
    return stageReceipt(value,{holdId,outboxId,retiredOutboxId,intentHash})
  })
}
