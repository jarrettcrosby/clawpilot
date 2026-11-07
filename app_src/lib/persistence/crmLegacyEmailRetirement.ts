import 'server-only'
import { legacyEmailRetirementManifestDigest, verifyLegacyEmailRetirementApproval,
  type LegacyEmailRetirementManifest } from '../crm/legacyEmailRetirementApproval'
import { nativeEmailCanonicalJson, requireNativeEmail } from '../crm/nativeEmailPublication'
import type { withTransaction } from './postgres'

type Transaction = typeof withTransaction
type RetirementReview = Omit<Parameters<typeof verifyLegacyEmailRetirementApproval>[0],'nowSeconds'>
type RetirementPins = { operationId: string; manifestDigest: string; approvalDigest: string }
type RetirementReceipt = RetirementPins & { state: 'committed'; rows: number; historicalProviderOutcome: 'unknown'; receiptHash: string }
const HASH = /^[a-f0-9]{64}(?![\s\S])/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/

/** The installed operator adapter owns and independently verifies the actual
 * external writer pause/drain for both stores, exact runtime identities and
 * native absence. It must keep the fence through both transaction COMMITs.
 * A signed manifest, DB role or local test is not that fence. No default
 * database, provider, web route or live fence implementation is supplied. */
export async function archiveExactLegacyEmailsPrivately(review: RetirementReview, dependencies: {
  withLiveFence<T>(manifest: Readonly<LegacyEmailRetirementManifest>, action: () => Promise<T>): Promise<T>;
  attestTransaction: Transaction; retireTransaction: Transaction;
  expectedRoles: Readonly<{attestor: string; controller: string}>;
  retainResolutionPins(pins: Readonly<RetirementPins>): Promise<void>;
}) {
  const expectedDigest=legacyEmailRetirementManifestDigest(review.expectedManifest)
  const manifest=JSON.parse(nativeEmailCanonicalJson(review.expectedManifest)) as LegacyEmailRetirementManifest
  Object.freeze(manifest.scope)
  for(const row of manifest.rows) Object.freeze(row)
  Object.freeze(manifest.rows)
  Object.freeze(manifest)
  const {attestor,controller}=dependencies.expectedRoles
  requireNativeEmail(dependencies.attestTransaction!==dependencies.retireTransaction && typeof attestor==='string'
    && typeof controller==='string' && attestor.length>0 && controller.length>0 && attestor!==controller,'legacy_archive_roles_not_separated')
  return dependencies.withLiveFence(manifest,async()=>{
    const reviewed=await dependencies.attestTransaction(async tx=>{
      await tx.query("SET LOCAL TIME ZONE 'UTC'")
      const clock=(await tx.query('SELECT session_user AS login,current_user AS role,floor(extract(epoch FROM clock_timestamp()))::bigint AS second')).rows[0]
      requireNativeEmail(clock?.login===attestor && clock.role===attestor,'legacy_archive_attestor_login_changed')
      const approved=verifyLegacyEmailRetirementApproval({...review,expectedManifest:manifest,nowSeconds:Number(clock?.second)})
      requireNativeEmail(approved.manifestDigest===expectedDigest,'legacy_archive_manifest_changed')
      await tx.query(`INSERT INTO crm_legacy_email_retirement.verified_batch
        (batch,generation,fence_epoch,valid_until,expected_rows,manifest_hash,fence_hash,approval_hash,publication_disposition)
        VALUES($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9)`,[approved.operationId,manifest.appGeneration,manifest.fenceEpoch,
        approved.expiresAt,manifest.rows.length,approved.manifestDigest,approved.fenceEnvelopeDigest,approved.approvalEnvelopeDigest,
        manifest.publicationDisposition])
      for(const row of manifest.rows) await tx.query(`INSERT INTO crm_legacy_email_retirement.review
        (batch,outbox_id,generation,outbox_hash,source_hash,fence_epoch,valid_until,attestation,local_id,pipeline_id,workspace_id,native_id,global_id,payload_hash,key_hash)
        VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7),'verified_fenced_absence',$8,$9,$10,$11,$12,$13,$14)`,
      [approved.operationId,row.outboxId,manifest.appGeneration,row.rowFingerprint,row.sourceFingerprint,manifest.fenceEpoch,
        approved.expiresAt,row.localId,row.pipelineId,row.workspaceId,row.nativeId,row.globalId,row.payloadFingerprint,row.keyFingerprint])
      return approved
    })
    const pins=Object.freeze({operationId:reviewed.operationId,manifestDigest:reviewed.manifestDigest,approvalDigest:reviewed.approvalEnvelopeDigest})
    // The operator must retain these exact reviewed pins before execution; a
    // disconnect is resolved with the read-only receipt, never a second write.
    await dependencies.retainResolutionPins(pins)
    await dependencies.retireTransaction(async tx=>{
      await tx.query("SET LOCAL TIME ZONE 'UTC'")
      const role=(await tx.query('SELECT session_user AS login,current_user AS role')).rows[0]
      requireNativeEmail(role?.login===controller && role.role===controller,'legacy_archive_controller_login_changed')
      const result=await tx.query('SELECT crm_legacy_email_retirement.retire($1::uuid,$2::uuid[],$3) AS count',
        [pins.operationId,manifest.rows.map(row=>row.outboxId),pins.approvalDigest])
      requireNativeEmail(result.rows.length===1 && result.rows[0].count===manifest.rows.length,'legacy_archive_count_changed')
    })
    return pins
  })
}

export async function resolveExactLegacyEmailArchivePrivately(transaction: Transaction, pins: RetirementPins):
  Promise<Readonly<RetirementReceipt | {state:'unknown'}>> {
  const {operationId,manifestDigest,approvalDigest}=pins
  requireNativeEmail(UUID.test(operationId) && HASH.test(manifestDigest) && HASH.test(approvalDigest),'legacy_archive_resolution_invalid')
  return transaction(async tx=>{
    const receipt=(await tx.query('SELECT crm_legacy_email_retirement.resolve($1::uuid,$2,$3) AS receipt',
      [operationId,manifestDigest,approvalDigest])).rows[0]?.receipt
    if(receipt?.state==='unknown') return Object.freeze({state:'unknown' as const})
    requireNativeEmail(receipt?.state==='committed' && receipt.operationId===operationId && receipt.manifestDigest===manifestDigest
      && receipt.approvalDigest===approvalDigest && receipt.historicalProviderOutcome==='unknown'
      && Number.isInteger(receipt.rows) && receipt.rows>0 && receipt.rows<=25 && HASH.test(receipt.receiptHash),'legacy_archive_receipt_invalid')
    return Object.freeze({state:'committed' as const,operationId,manifestDigest,approvalDigest,rows:receipt.rows,
      historicalProviderOutcome:'unknown' as const,receiptHash:receipt.receiptHash})
  })
}
