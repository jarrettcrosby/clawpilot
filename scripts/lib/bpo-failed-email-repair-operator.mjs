import { createHash } from 'node:crypto'
import { sharedEmailCanonicalJson } from './bpo-shared-email-projection.mjs'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const HASH=/^[a-f0-9]{64}(?![\s\S])/u
const TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(?![\s\S])/u
const hash=value=>typeof value==='string'&&HASH.test(value)
const stamp=value=>typeof value==='string'&&TIME.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const digest=value=>createHash('sha256').update(sharedEmailCanonicalJson(value)).digest('hex')
const need=(ok,code)=>{if(!ok)throw new Error(`Exact BPO Email operator held: ${code}`)}

/** One exact failed slot only. This composes private transports already bound
 * to the reviewed App, native service and physical database deployments.
 * Those adapters are not accepted from HTTP or from the input packet. Nothing
 * here provisions credentials, creates a second job, or retries a write. */
export function createBpoFailedEmailRepairOperator({app,native,trust}) {
  need(['inspect','claim','settle','resolve'].every(name=>typeof app?.[name]==='function')
    && ['inspect','create','readback'].every(name=>typeof native?.[name]==='function')
    && ['bindAbsence','createPermit','bindReadback'].every(name=>typeof trust?.[name]==='function'),'private_adapters')

  return async function runExactBpoEmailSlot({action,interactionId}) {
    need(['inspect','repair'].includes(action)&&typeof interactionId==='string'&&UUID.test(interactionId),'one_exact_slot')
    const slot=await app.inspect(interactionId)
    const {target,projection}=slot??{}
    need(['ready','reconcile-only'].includes(slot?.state)&&target?.interactionId===interactionId
      && target.nativeId===projection?.suiteCrmId&&target.globalId===projection?.attributes?.global_id_c
      && projection.expectedBeforeFingerprint===null&&hash(target.projectionFingerprint)
      && digest(projection)===target.projectionFingerprint,'app_projection')

    const nativeRequest={localId:interactionId,projection}
    const evidence=await native.inspect(nativeRequest)
    function scope(value){return value?.version===1&&value.nativeId===target.nativeId&&value.globalId===target.globalId
      && value.projectionFingerprint===target.projectionFingerprint&&hash(value.policyStateFingerprint)&&stamp(value.observedAt)}
    const absent=scope(evidence)&&evidence.state==='absent'&&hash(evidence.evidenceFingerprint)
    const exact=scope(evidence)&&evidence.state==='exact'&&['created','exact-existing'].includes(evidence.kind)
      &&hash(evidence.snapshotFingerprint)&&hash(evidence.receiptFingerprint)
    need(absent||exact,'native_placement_unproven')
    const result=state=>({state,interactionId,jobId:target.jobId})
    if(action==='inspect')return result(exact?'exact-reuse':slot.state==='reconcile-only'?'prior-attempt-no-write'
      :evidence.journalReady===true?'absent-ready':'absent-journal-missing')

    // Even an exact inspect does not substitute for the independent receipt
    // observer. An old local claim can never dispatch again, even if the
    // native record is not found after an ambiguous previous attempt.
    if(absent){
      if(slot.state==='reconcile-only')return result('prior-attempt-no-write')
      need(evidence.journalReady===true,'native_journal_not_ready')
      const absenceEvidence=await trust.bindAbsence(target,evidence)
      const claim=await app.claim(interactionId,absenceEvidence)
      need(claim?.state==='dispatch-once'||claim?.state==='reconcile-only','claim_unproven')
      if(claim.state==='dispatch-once'){
        const current=await app.inspect(interactionId)
        need(current?.state==='reconcile-only'&&digest(current.target)===digest(target)
          &&digest(current.projection)===target.projectionFingerprint
          &&digest(current.dispatchClaim)===digest(claim.dispatchClaim),'app_changed_after_claim')
        const permit=await trust.createPermit(target,evidence,claim)
        try { await native.create({...nativeRequest,permit}) }
        catch { /* A timeout or rejection is not proof of rollback. Observe only below. */ }
      }
    }
    let readback
    try { readback=await native.readback(nativeRequest) } catch { return result('native-outcome-unproven') }
    if(!scope(readback)||readback.state!=='exact'||!['created','exact-existing'].includes(readback.kind)
      ||!hash(readback.snapshotFingerprint)||!hash(readback.receiptFingerprint))return result('native-outcome-unproven')
    const receiptEnvelope=await trust.bindReadback(target,readback)
    let settled
    try { settled=await app.settle(interactionId,receiptEnvelope) }
    catch {
      // The transport must open a new pinned PG session for resolve. No
      // second native attempt or second App settlement occurs here.
      try { settled=await app.resolve(interactionId,receiptEnvelope) }
      catch { return result('app-outcome-unproven') }
    }
    if(settled?.state!=='settled'||settled.interactionId!==interactionId||settled.jobId!==target.jobId
      ||!hash(settled.receiptDigest))return result('app-outcome-unproven')
    return {...result('settled'),kind:readback.kind,receiptDigest:settled.receiptDigest}
  }
}
