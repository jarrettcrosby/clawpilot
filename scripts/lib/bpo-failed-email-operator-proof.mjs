import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { sharedEmailCanonicalJson } from './bpo-shared-email-projection.mjs'

const HASH=/^[a-f0-9]{64}(?![\s\S])/u
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const GLOBAL=/^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const LABEL=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?![\s\S])/u
const UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(?![\s\S])/u
const ID_FIELDS=['workspaceId','pipelineId','interactionId','jobId','nativeId']
const HASH_FIELDS=['inventoryFingerprint','preimageFingerprint','projectionFingerprint','appOriginFingerprint',
  'appDeploymentFingerprint','nativeOriginFingerprint','nativeDeploymentFingerprint']
const TARGET=[...ID_FIELDS,'globalId',...HASH_FIELDS]
const ABSENT=[...TARGET,'version','state','observedAt','evidenceFingerprint']
const need=(ok,code)=>{if(!ok)throw new Error(`Exact BPO Email evidence held: ${code}`)}
const match=(value,re)=>typeof value==='string'&&re.test(value)
const record=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length
  &&keys.every(key=>Object.hasOwn(value,key))
const equal=(left,right)=>sharedEmailCanonicalJson(left)===sharedEmailCanonicalJson(right)
const digest=value=>createHash('sha256').update(value).digest('hex')
const currentStamp=value=>match(value,UTC)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const keyFingerprint=key=>digest(createPublicKey(key.type==='public'?key.export({type:'spki',format:'pem'}):key).export({type:'spki',format:'der'}))
function rsaKey(material,type){
  let key
  try { key=material?.type===type?material:type==='private'?createPrivateKey(material):createPublicKey(material) }
  catch { need(false,'key') }
  need(key?.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails?.modulusLength===3072,'key')
  return key
}
function exactTarget(target){
  return record(target,TARGET)&&ID_FIELDS.every(field=>match(target[field],UUID))&&match(target.globalId,GLOBAL)
    &&HASH_FIELDS.every(field=>match(target[field],HASH))
}
function signed(key,proof){
  return {proof,signature:sign('RSA-SHA256',Buffer.from(sharedEmailCanonicalJson(proof)),key).toString('base64')}
}

/** Only the private operator who authenticated the native console may sign a
 * readback. The App has only this separate public key; native create approval
 * uses an independent private key and different proof purpose. */
export function createBpoFailedEmailOperatorProofs({createKey,createKeyId,readbackKey,readbackKeyId,releaseFingerprint,slots}) {
  need(match(createKeyId,LABEL)&&match(readbackKeyId,LABEL)&&createKeyId!==readbackKeyId&&match(releaseFingerprint,HASH)
    &&Array.isArray(slots)&&slots.length===19,'review_configuration')
  const writer=rsaKey(createKey,'private'), reader=rsaKey(readbackKey,'private')
  need(keyFingerprint(writer)!==keyFingerprint(reader),'separate_keys')
  const byId=new Map()
  for(const row of slots){
    need(record(row,['target','slotFingerprint','nonce'])&&exactTarget(row.target)&&match(row.slotFingerprint,HASH)&&match(row.nonce,HASH)
      &&!byId.has(row.target.interactionId),'review_slot')
    byId.set(row.target.interactionId,structuredClone(row))
  }
  need(new Set(slots.map(row=>row.nonce)).size===19,'review_nonce')
  function pinned(target,evidence,state){
    const row=byId.get(target?.interactionId)
    need(row&&exactTarget(target)&&equal(row.target,target)&&evidence?.version===1&&evidence.state===state
      &&evidence.nativeId===target.nativeId&&evidence.globalId===target.globalId
      &&evidence.projectionFingerprint===target.projectionFingerprint&&match(evidence.policyStateFingerprint,HASH)
      &&currentStamp(evidence.observedAt),'native_evidence_scope')
    return row
  }
  return Object.freeze({
    bindAbsence(target,evidence){
      pinned(target,evidence,'absent')
      need(evidence.journalReady===true&&match(evidence.evidenceFingerprint,HASH),'absence_unproven')
      return signed(reader,{purpose:'clawpilot-shared-bpo-email-absence-v1',keyId:readbackKeyId,
        result:{...target,version:1,state:'absent',observedAt:evidence.observedAt,evidenceFingerprint:evidence.evidenceFingerprint}})
    },
    createPermit(target,evidence,claim){
      const row=pinned(target,evidence,'absent')
      need(evidence.journalReady===true&&match(evidence.evidenceFingerprint,HASH)
        &&claim?.state==='dispatch-once'&&equal(claim.target,target)&&equal(claim.dispatchClaim?.target,target)
        &&claim.dispatchClaim.evidenceFingerprint===evidence.evidenceFingerprint&&claim.dispatchClaim.observedAt===evidence.observedAt
        &&currentStamp(claim.dispatchClaim.claimedAt)
        &&Date.parse(claim.dispatchClaim.claimedAt)-Date.parse(evidence.observedAt)>=0
        &&Date.parse(claim.dispatchClaim.claimedAt)-Date.parse(evidence.observedAt)<=60_000,'dispatch_claim')
      const issuedAt=Math.floor(Date.parse(evidence.observedAt)/1000)
      return signed(writer,{version:1,purpose:'clawpilot-shared-bpo-email-create-v1',issuedAt,expiresAt:issuedAt+60,scope:{
        action:'create-missing',keyId:createKeyId,workspaceId:target.workspaceId,pipelineId:target.pipelineId,lane:'failed',
        localId:target.interactionId,nativeId:target.nativeId,globalId:target.globalId,releaseFingerprint,
        appDeploymentFingerprint:target.appDeploymentFingerprint,nativeDeploymentFingerprint:target.nativeDeploymentFingerprint,
        appOriginFingerprint:target.appOriginFingerprint,nativeOriginFingerprint:target.nativeOriginFingerprint,
        inventoryFingerprint:target.inventoryFingerprint,slotFingerprint:row.slotFingerprint,projectionFingerprint:target.projectionFingerprint,
        policyStateFingerprint:evidence.policyStateFingerprint,nonce:row.nonce,
      }})
    },
    bindReadback(target,evidence){
      pinned(target,evidence,'exact')
      need(['created','exact-existing'].includes(evidence.kind)&&match(evidence.snapshotFingerprint,HASH)
        &&match(evidence.receiptFingerprint,HASH),'readback_unproven')
      return signed(reader,{purpose:'clawpilot-shared-bpo-email-readback-v1',keyId:readbackKeyId,result:{...target,
        version:1,state:'exact',kind:evidence.kind,snapshotFingerprint:evidence.snapshotFingerprint,
        receiptFingerprint:evidence.receiptFingerprint,observedAt:evidence.observedAt}})
    },
  })
}

export function createBpoFailedEmailAbsenceVerifier({publicKeyPem,keyId}) {
  need(match(keyId,LABEL)&&typeof publicKeyPem==='string'&&publicKeyPem.length<=1024
    &&/^-----BEGIN PUBLIC KEY-----\r?\n/.test(publicKeyPem),'key')
  const key=rsaKey(publicKeyPem,'public')
  return (envelope,target)=>{
    need(exactTarget(target)&&record(envelope,['proof','signature'])&&record(envelope.proof,['purpose','keyId','result'])
      &&envelope.proof.purpose==='clawpilot-shared-bpo-email-absence-v1'&&envelope.proof.keyId===keyId
      &&record(envelope.proof.result,ABSENT),'absence_envelope')
    const result=envelope.proof.result
    need(result.version===1&&result.state==='absent'&&currentStamp(result.observedAt)&&match(result.evidenceFingerprint,HASH)
      &&TARGET.every(field=>result[field]===target[field]),'absence_binding')
    const sig=envelope.signature
    need(match(sig,/^[a-zA-Z0-9+/]{512}(?![\s\S])/u),'absence_signature')
    const bytes=Buffer.from(sig,'base64')
    need(bytes.length===384&&bytes.toString('base64')===sig
      &&verify('RSA-SHA256',Buffer.from(sharedEmailCanonicalJson(envelope.proof)),key,bytes),'absence_signature')
    return Object.freeze({...result})
  }
}
