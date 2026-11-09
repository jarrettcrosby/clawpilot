import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { test } from 'node:test'
import { createBpoFailedEmailRepairOperator } from './lib/bpo-failed-email-repair-operator.mjs'
import { createBpoFailedEmailAbsenceVerifier, createBpoFailedEmailOperatorProofs } from './lib/bpo-failed-email-operator-proof.mjs'
import { sharedEmailCanonicalJson } from './lib/bpo-shared-email-projection.mjs'
import { createSharedBpoEmailReceiptVerifier } from './lib/bpo-shared-email-receipt-proof.mjs'
import { bpoFailedEmailSshArgs } from './lib/bpo-failed-email-repair-ssh.mjs'

const digest=value=>createHash('sha256').update(sharedEmailCanonicalJson(value)).digest('hex')
const sha=label=>createHash('sha256').update(label).digest('hex')
const uuid=value=>`10000000-0000-4000-8000-${String(value).padStart(12,'0')}`
const now='2026-11-09T20:10:01.000Z'
const { publicKey:writePub,privateKey:createKey }=generateKeyPairSync('rsa',{modulusLength:3072})
const { publicKey:readPub,privateKey:readbackKey }=generateKeyPairSync('rsa',{modulusLength:3072})
const keyId='readback-fixture', publicKeyPem=readPub.export({type:'spki',format:'pem'})

function fixture(){
  const interactionId=uuid(1),jobId=uuid(2),nativeId=uuid(3),globalId='gi123456789abc'
  const projection={suiteCrmId:nativeId,attributes:{global_id_c:globalId,description:'private test body'},expectedBeforeFingerprint:null}
  const target={workspaceId:uuid(4),pipelineId:uuid(5),interactionId,jobId,nativeId,globalId,
    projectionFingerprint:digest(projection),inventoryFingerprint:sha('inventory'),preimageFingerprint:sha('preimage'),
    appOriginFingerprint:sha('app origin'),appDeploymentFingerprint:sha('app deployment'),
    nativeOriginFingerprint:sha('native origin'),nativeDeploymentFingerprint:sha('native deployment')}
  const slots=[{target,slotFingerprint:sha('slot 0'),nonce:sha('nonce 0')},...Array.from({length:18},(_,i)=>({
    target:{...target,interactionId:uuid(i+10),jobId:uuid(i+30),nativeId:uuid(i+50),globalId:`gi${String(i+10).padStart(7,'0')}`},
    slotFingerprint:sha(`slot ${i+1}`),nonce:sha(`nonce ${i+1}`),
  }))]
  const trust=createBpoFailedEmailOperatorProofs({createKey,createKeyId:'create-fixture',readbackKey,readbackKeyId:keyId,
    releaseFingerprint:sha('release'),slots})
  const validateAbsence=createBpoFailedEmailAbsenceVerifier({publicKeyPem,keyId})
  const validateReadback=createSharedBpoEmailReceiptVerifier({publicKeyPem,keyId})
  const common={version:1,nativeId,globalId,projectionFingerprint:target.projectionFingerprint,
    policyStateFingerprint:sha('policy'),observedAt:now}
  const absence={...common,state:'absent',journalReady:true,evidenceFingerprint:sha('absence')}
  const exact={...common,state:'exact',kind:'created',snapshotFingerprint:sha('snapshot'),receiptFingerprint:sha('receipt')}
  const events=[], hooks={appState:'ready',nativeState:'absent',createThrows:false,appThrows:false,unresolved:false}
  let dispatchClaim=null
  const app={
    inspect:async()=>{events.push('app.inspect');return {state:dispatchClaim?'reconcile-only':hooks.appState,target,
      projection:dispatchClaim&&hooks.appChanged?{...projection,attributes:{...projection.attributes,description:'drifted'}}:projection,dispatchClaim}},
    claim:async(id,proof)=>{
      events.push('app.claim');assert.equal(id,interactionId)
      const observed=validateAbsence(proof,target)
      dispatchClaim={target,observedAt:observed.observedAt,evidenceFingerprint:observed.evidenceFingerprint,claimedAt:now}
      return {state:'dispatch-once',target,dispatchClaim}
    },
    settle:async(id,proof)=>{
      events.push('app.settle');assert.equal(id,interactionId);assert.equal(validateReadback(proof).snapshotFingerprint,exact.snapshotFingerprint)
      if(hooks.appThrows)throw new Error('lost App response')
      return {state:'settled',interactionId,jobId,receiptDigest:sha('settled')}
    },
    resolve:async()=>{events.push('app.resolve');return {state:'settled',interactionId,jobId,receiptDigest:sha('settled')}},
  }
  const native={
    inspect:async()=>{events.push('native.inspect');return hooks.nativeState==='absent'?absence:exact},
    create:async({localId,projection:command,permit})=>{
      events.push('native.create');assert.equal(localId,interactionId);assert.deepEqual(command,projection)
      assert.ok(verify('RSA-SHA256',Buffer.from(sharedEmailCanonicalJson(permit.proof)),writePub,Buffer.from(permit.signature,'base64')))
      assert.equal(permit.proof.scope.policyStateFingerprint,absence.policyStateFingerprint)
      assert.equal(permit.proof.scope.nonce,slots[0].nonce)
      if(hooks.createThrows)throw new Error('lost native response')
      return {state:'created'}
    },
    readback:async()=>{events.push('native.readback');return hooks.unresolved?absence:exact},
  }
  return {run:createBpoFailedEmailRepairOperator({app,native,trust}),events,hooks,interactionId,absence,target,trust,validateAbsence}
}

test('inspection is read-only; a missing native journal does not authorize create',async()=>{
  const f=fixture()
  f.absence.journalReady=false
  assert.equal((await f.run({action:'inspect',interactionId:f.interactionId})).state,'absent-journal-missing')
  assert.deepEqual(f.events,['app.inspect','native.inspect'])
  await assert.rejects(f.run({action:'repair',interactionId:f.interactionId}),/journal_not_ready/u)
  assert.ok(!f.events.includes('app.claim'))
})

test('lost write responses resolve only by independent native/App readback, never replay',async()=>{
  const f=fixture();f.hooks.createThrows=true;f.hooks.appThrows=true
  const result=await f.run({action:'repair',interactionId:f.interactionId})
  assert.equal(result.state,'settled')
  assert.deepEqual(f.events,['app.inspect','native.inspect','app.claim','app.inspect','native.create','native.readback','app.settle','app.resolve'])
  assert.doesNotMatch(JSON.stringify(result),/private test body/u)
})

test('an existing exact native copy needs no claim or create, and an unresolved previous attempt cannot be repeated',async()=>{
  const f=fixture();f.hooks.nativeState='exact';f.hooks.appState='reconcile-only'
  assert.equal((await f.run({action:'repair',interactionId:f.interactionId})).state,'settled')
  assert.deepEqual(f.events,['app.inspect','native.inspect','native.readback','app.settle'])
  const g=fixture();g.hooks.appState='reconcile-only'
  assert.equal((await g.run({action:'repair',interactionId:g.interactionId})).state,'prior-attempt-no-write')
  assert.deepEqual(g.events,['app.inspect','native.inspect'])
  const h=fixture();h.hooks.createThrows=true;h.hooks.unresolved=true
  assert.equal((await h.run({action:'repair',interactionId:h.interactionId})).state,'native-outcome-unproven')
  assert.deepEqual(h.events,['app.inspect','native.inspect','app.claim','app.inspect','native.create','native.readback'])
  const drift=fixture();drift.hooks.appChanged=true
  await assert.rejects(drift.run({action:'repair',interactionId:drift.interactionId}),/app_changed_after_claim/u)
  assert.deepEqual(drift.events,['app.inspect','native.inspect','app.claim','app.inspect'])
})

test('absence evidence is slot-bound and native create cannot be signed without the confirmed App claim',()=>{
  const f=fixture(), proof=f.trust.bindAbsence(f.target,f.absence)
  assert.throws(()=>f.validateAbsence(proof,{...f.target,jobId:uuid(100)}),/absence_binding/u)
  assert.throws(()=>f.trust.createPermit(f.target,f.absence,{target:f.target,state:'reconcile-only'}),/dispatch_claim/u)
})

test('SSH arguments fix project, service, instance and private command; no user shell or other action',()=>{
  const pin={deploymentInstanceId:uuid(1),pinsFingerprint:sha('protected server config'),identityFile:'/private/synthetic-key'}
  const args=bpoFailedEmailSshArgs({side:'native',action:'readback',...pin})
  assert.ok(args.includes('6975e7e2-3986-4453-8cc2-8367aa9b6405')&&args.includes(pin.deploymentInstanceId))
  assert.equal(args.at(-1),`exec php /opt/clawpilot/native-email-shared-repair-cli.php readback --pins-sha256=${pin.pinsFingerprint}`)
  assert.throws(()=>bpoFailedEmailSshArgs({side:'native',action:'settle',...pin}),/exact_ssh_selection/u)
  assert.throws(()=>bpoFailedEmailSshArgs({side:'app',action:'inspect; true',...pin}),/exact_ssh_selection/u)
})
