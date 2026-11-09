import 'server-only'
import { snapshotLegacyEmailTerminalHoldReview, verifyLegacyEmailTerminalHoldApproval,
  type LegacyEmailTerminalHoldManifest, type LegacyEmailTerminalHoldReview } from '../crm/legacyEmailRetirementApproval'
import { requireNativeEmail } from '../crm/nativeEmailPublication'
import type { withTransaction } from './postgres'

type Transaction = typeof withTransaction
const HASH=/^[a-f0-9]{64}(?![\s\S])/u
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const ROLE=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}(?![\s\S])/u
export type TerminalHoldPins=Readonly<{operationId:string;manifestDigest:string;approvalDigest:string}>
type TerminalHoldReceipt=TerminalHoldPins&{state:'committed';rows:number;historicalProviderOutcome:'unknown';receiptHash:string}
function need(value:unknown,code:string):asserts value {requireNativeEmail(value,'legacy_terminal_hold_'+code)}

/** Trusted private adapter only. No default connection, custody/absence
 * observer, role grant, production binding, archive, or native dispatch is
 * provided. The installed controller must prove and retain the independent
 * live fence through both commits, not infer it from the signed review. */
export async function holdExactLegacyEmailsPrivately(input: LegacyEmailTerminalHoldReview, dependencies: {
  withLiveFence<T>(manifest:Readonly<LegacyEmailTerminalHoldManifest>, action:()=>Promise<T>):Promise<T>;
  attestTransaction:Transaction; holdTransaction:Transaction;
  expectedRoles:Readonly<{attestor:string;controller:string}>;
  retainResolutionPins(pins:TerminalHoldPins):Promise<void>;
}): Promise<TerminalHoldPins> {
  const {review,canonical,manifestDigest}=snapshotLegacyEmailTerminalHoldReview(input)
  const {attestTransaction,holdTransaction}=dependencies
  const {attestor,controller}=dependencies.expectedRoles
  need(typeof attestor==='string'&&ROLE.test(attestor)&&typeof controller==='string'&&ROLE.test(controller)
    &&attestor!==controller&&attestTransaction!==holdTransaction,'roles_not_separated')
  let invoked=false, committed:TerminalHoldPins|undefined
  const result=await dependencies.withLiveFence(review.expectedManifest,async()=>{
    need(!invoked,'fence_callback_reused');invoked=true
    const pins=await attestTransaction(async tx=>{
      await tx.query("SET LOCAL TIME ZONE 'UTC'")
      const rows=(await tx.query('SELECT session_user AS login,current_user AS role,floor(extract(epoch FROM clock_timestamp()))::bigint AS second')).rows
      need(rows.length===1&&rows[0].login===attestor&&rows[0].role===attestor,'attestor_login_changed')
      const proof=verifyLegacyEmailTerminalHoldApproval({...review,nowSeconds:Number(rows[0].second)})
      need(proof.manifestDigest===manifestDigest,'manifest_changed')
      const exact=Object.freeze({operationId:proof.operationId,manifestDigest:proof.manifestDigest,approvalDigest:proof.approvalEnvelopeDigest})
      // If either COMMIT response is lost, reconcile this exact operation
      // with a read-only observer. Never mint fresh pins or retry on timeout.
      await dependencies.retainResolutionPins(exact)
      const result=await tx.query(`INSERT INTO crm_legacy_email_terminal_hold.verified_batch
        (batch,manifest,manifest_canonical,manifest_hash,fence_hash,approval_hash,valid_until)
        VALUES($1::uuid,$2::text::jsonb,$2::text,$3,$4,$5,to_timestamp($6))`,
        [exact.operationId,canonical,exact.manifestDigest,proof.fenceEnvelopeDigest,exact.approvalDigest,proof.expiresAt])
      need(result.rowCount===1,'attestation_count_changed')
      return exact
    })
    await holdTransaction(async tx=>{
      await tx.query("SET LOCAL TIME ZONE 'UTC'")
      const roles=(await tx.query('SELECT session_user AS login,current_user AS role')).rows
      need(roles.length===1&&roles[0].login===controller&&roles[0].role===controller,'controller_login_changed')
      const rows=(await tx.query('SELECT crm_legacy_email_terminal_hold.hold($1::uuid,$2::uuid[],$3) AS count',
        [pins.operationId,review.expectedManifest.rows.map(row=>row.outboxId),pins.approvalDigest])).rows
      need(rows.length===1&&rows[0].count===review.expectedManifest.rows.length,'hold_count_changed')
    })
    committed=pins
    return pins
  })
  need(committed&&result===committed,'fence_result_unverified')
  return committed
}

export async function resolveExactLegacyEmailTerminalHoldPrivately(transaction:Transaction,pins:TerminalHoldPins):
  Promise<Readonly<TerminalHoldReceipt|{state:'unknown'}>> {
  const {operationId,manifestDigest,approvalDigest}=pins
  need(typeof operationId==='string'&&UUID.test(operationId)&&typeof manifestDigest==='string'&&HASH.test(manifestDigest)
    &&typeof approvalDigest==='string'&&HASH.test(approvalDigest),'resolution_invalid')
  return transaction(async tx=>{
    const rows=(await tx.query('SELECT crm_legacy_email_terminal_hold.resolve($1::uuid,$2,$3) AS receipt',
      [operationId,manifestDigest,approvalDigest])).rows
    need(rows.length===1,'receipt_invalid')
    const receipt=rows[0].receipt
    if(receipt?.state==='unknown'&&Object.keys(receipt).length===1) return Object.freeze({state:'unknown' as const})
    need(receipt?.state==='committed'&&Object.keys(receipt).length===7&&receipt.operationId===operationId
      &&receipt.manifestDigest===manifestDigest&&receipt.approvalDigest===approvalDigest&&receipt.historicalProviderOutcome==='unknown'
      &&Number.isInteger(receipt.rows)&&receipt.rows>0&&receipt.rows<=25&&typeof receipt.receiptHash==='string'
      &&HASH.test(receipt.receiptHash),'receipt_invalid')
    return Object.freeze({state:'committed' as const,operationId,manifestDigest,approvalDigest,rows:receipt.rows,
      historicalProviderOutcome:'unknown' as const,receiptHash:receipt.receiptHash})
  })
}
