// Isolated joined test only. The local argv shim can reach one owned Docker
// container on a verified Unix socket, never Railway or a remote host.
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {existsSync,lstatSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {createNativeJointRecoveryMaintenanceClient,JOINT_LEGACY_EMAIL_NATIVE_IDENTITY,
  loadNativeJointLegacyEmailRecoveryApp} from './native-joint-legacy-email-recovery.mjs'
import {holdNativeJointOriginalEmail,stageNativeJointOriginalEmail} from './native-joint-held-original-stage.mjs'
import {openNativeJointHeldOriginalPostgresRoles} from './native-joint-held-original-postgres-role.mjs'

export {holdNativeJointOriginalEmail}
export const HELD_ORIGINAL_FIXTURE_SOURCES=Object.freeze(['scripts/lib/native-joint-held-original-recovery.mjs',
  'scripts/lib/native-joint-held-original-stage.mjs','scripts/lib/native-joint-held-original-postgres-role.mjs'])
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const emptyNative={emails:0,custom:0,global:0,text:0,groups:0,managed:0,operations:0}
const singleNative=Object.fromEntries(Object.keys(emptyNative).map(key=>[key,1]))

/** The real default transport owns the ready check and brands the response.
 * Unlike the archive fixture this must not inject a custom untrusted runner. */
export function createNativeJointHeldOriginalTransport({maintenanceCli,target,root,dockerBinary,dockerSocket,containerId,
  railwayIdentityFile,transportAttestationKey,assertOutsideTransaction}) {
  assert.match(containerId,/^[0-9a-f]{64}$/u)
  assert.ok(lstatSync(dockerSocket).isSocket()&&lstatSync(dockerBinary).isFile())
  assert.match(process.execPath,/^\/[^\r\n ]+$/u)
  const binary=join(root,'held-original-local-only-transport.cjs'),rejected=join(root,'held-original-first-publish-rejected')
  const script='/opt/clawpilot/native-email-recovery-cli.php'
  const expected=['ssh','--project',target.projectId,'--environment',target.environmentId,'--service',target.serviceId,
    '--deployment-instance',target.deploymentInstanceId,'--identity-file',railwayIdentityFile,'--','php',script]
  const dockerArgs=['--host','unix://'+dockerSocket,'exec','--interactive',containerId,'php','-d','memory_limit=384M','-d','display_errors=0',script]
  const encoded=JSON.stringify
  writeFileSync(binary,`#!${process.execPath}\n'use strict';
const fs=require('node:fs'),{spawn}=require('node:child_process');
const args=process.argv.slice(2),[action,nonce]=args.slice(-2);
if(JSON.stringify(args.slice(0,-2))!==${encoded(encoded(expected))}||!['prepare','publish','resolve'].includes(action)||!/^[0-9a-f]{64}$/.test(nonce))process.exit(64);
if(action==='publish'){
 let reject=false;
 try {fs.writeFileSync(${encoded(rejected)},'intentional pre-authentication refusal\\n',{flag:'wx',mode:0o600});reject=true}
 catch(error){if(error?.code!=='EEXIST')process.exit(65)}
 if(reject)process.exit(66);
}
const child=spawn(${encoded(dockerBinary)},[...${encoded(dockerArgs)},action,nonce],{stdio:'inherit'});
child.once('error',()=>process.exit(67));child.once('exit',(code)=>process.exit(code===null?68:code));\n`,{flag:'wx',mode:0o700})
  const bridge=maintenanceCli.createNativeEmailRecoveryCliTransport({target,railwayBinary:binary,
    railwayBinarySha256:sha(readFileSync(binary)),railwayIdentityFile,transportAttestationKey})
  const attestedActions=[]
  let firstPublishRejectedBeforeAuthentication=false
  return Object.freeze({targetFingerprint:bridge.targetFingerprint,attestedActions,
    get firstPublishRejectedBeforeAuthentication(){return firstPublishRejectedBeforeAuthentication},
    async exchange(packet){assertOutsideTransaction();const result=await bridge.exchange(packet)
      assertOutsideTransaction();attestedActions.push(packet.permit.proof.action);return result},
    async exchangePublish(packet){
      assertOutsideTransaction()
      let authorized=false
      try {
        const result=await bridge.exchangePublish({...packet,authorize:async()=>{
          assert.equal(authorized,false);authorized=true;return packet.authorize()
        }})
        assertOutsideTransaction();assert.ok(authorized);attestedActions.push('publish');return result
      }catch(error){
        if(!firstPublishRejectedBeforeAuthentication&&!authorized&&existsSync(rejected)){
          firstPublishRejectedBeforeAuthentication=true
          throw Error('legacy_dispatch_transport_destination_unverified')
        }
        throw error
      }
    }})
}

export async function runNativeJointHeldOriginalRecovery({query,withTransaction,getPostgresPool,authority,deadline,
  assertOutsideTransaction,inspectNative,held,maintenance,app}) {
  assert.ok(Date.now()<deadline&&maintenance&&app?.maintenanceCli&&held?.receipt?.state==='committed')
  const {pipelineId,workspaceId,ownerNativeId}=authority,{outboxId,holdId,localId}=held
  const {suiteCrmId,globalId}=JOINT_LEGACY_EMAIL_NATIVE_IDENTITY
  // Match production's single module instance: a receipt authenticated by
  // the default transport must reach this DAL's same private WeakMap.
  const roles=await openNativeJointHeldOriginalPostgresRoles({ownerTransaction:withTransaction,ownerPool:getPostgresPool(),held})
  const outside=()=>{assertOutsideTransaction();assert.equal(roles.count(),0)}
  try {
    const {selection,receipt,approval}=await stageNativeJointOriginalEmail({query,app,held,transaction:roles.transaction,
      attestTransaction:roles.attestTransaction,attestorUser:roles.attestorUser,pinOperation:roles.pinOperation})
    const {nativeOperationId,requestFingerprint}=selection
    assert.equal(selection.outboxId,outboxId);assert.equal(selection.holdId,holdId)
    const readRelease=async()=>(await roles.transaction(tx=>tx.query(
      'SELECT crm_legacy_email_terminal_hold.resolve_release($1::uuid,$2,$3,$4) AS value',
      [outboxId,receipt.receiptHash,nativeOperationId,requestFingerprint]))).rows[0].value
    assert.deepEqual(await readRelease(),{state:'staged'})
    const unrelated=async()=>(await query(`SELECT id::text,encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS fingerprint
      FROM sync_outbox o WHERE id<>$1 ORDER BY id`,[outboxId])).rows
    const original=async()=>(await query(`SELECT id::text,idempotency_key,to_jsonb(o)::text AS bytes FROM sync_outbox o WHERE id=$1`,[outboxId])).rows[0]
    const beforeQueue=await unrelated(),before=await original()
    assert.deepEqual(await inspectNative(null),emptyNative)
    const native=createNativeJointRecoveryMaintenanceClient({app,maintenance,deadline,assertOutsideTransaction:outside,inspectNative,
      target:{suiteCrmId,globalId,localId,pipelineId,workspaceId,ownerNativeId,operationId:nativeOperationId,
        requestFingerprint,approvalHash:approval.approvalHash}})
    const base={selection,transaction:roles.transaction,maintenanceDispatch:native.maintenanceDispatch}
    const heldOriginal={stageReceiptHash:receipt.receiptHash,nativeAuthorityInstanceId:held.nativeAuthorityInstanceId,
      receiptAttestor:{user:roles.attestorUser,transaction:roles.attestTransaction}}
    const persistence=app.persistence.createPrivateLegacyEmailRecoveryPersistence({...base,heldOriginal:{...heldOriginal,initialApproval:approval}})
    const owner=randomUUID(),operatorFor=persistence=>app.maintenanceOperator.createNativeEmailRecoveryMaintenanceOperator({persistence,
      exchange:native.exchange,exchangePublish:native.exchangePublish,owner})
    const operator=operatorFor(persistence)
    await assert.rejects(()=>operator.publish(),error=>[error.code,error.message].includes('legacy_dispatch_transport_destination_unverified'))
    assert.deepEqual(await readRelease(),{state:'staged'});assert.deepEqual(await original(),before)
    assert.deepEqual(await inspectNative(null),emptyNative)
    assert.deepEqual(native.evidence().calls.map(call=>call.action),['prepare'])
    await assert.rejects(()=>operator.publish(),error=>error.code==='native_outcome_unknown')
    assert.deepEqual(await readRelease(),{state:'dispatched'})
    const afterLost=await inspectNative(nativeOperationId)
    assert.deepEqual(afterLost,singleNative)
    await assert.rejects(()=>operator.publish(),error=>error.code==='legacy_dispatch_resolution_required')
    assert.deepEqual(await original(),before)
    const ordinaryApp=loadNativeJointLegacyEmailRecoveryApp({query:(sql,params)=>roles.ordinaryTransaction(tx=>tx.query(sql,params)),
      withTransaction:roles.ordinaryTransaction,getPostgresPool:()=>{throw Error('Ordinary fixture cannot obtain an owner pool')}})
    let ordinaryCalls=0
    const deny=async()=>{ordinaryCalls++;throw Error('Ordinary worker cannot access a held original')}
    const ordinary=ordinaryApp.worker.createNativeEmailPublicationWorker(ordinaryApp.persistence.createPostgresNativeEmailWorkerPersistence(),
      {prepare:deny,publish:deny,resolveOrCancel:deny})
    assert.deepEqual(await ordinary.resume(),{enabled:true,blocked:true});assert.equal(ordinaryCalls,0)
    const resolver=operatorFor(app.persistence.createPrivateLegacyEmailRecoveryPersistence({...base,heldOriginal}))
    assert.deepEqual(await resolver.resolve(),{synchronized:true,pipelineId,outboxId})
    await assert.rejects(()=>resolver.resolve(),error=>error.code==='legacy_dispatch_no_unresolved_operation')
    assert.deepEqual(await readRelease(),{state:'committed'})
    assert.deepEqual(await inspectNative(nativeOperationId),afterLost)
    assert.deepEqual(native.evidence().calls.map(call=>call.action),['prepare','prepare','publish','resolve'])
    assert.deepEqual(await unrelated(),beforeQueue)
    const terminal=(await query(`SELECT o.id::text,o.idempotency_key,o.status,i.sync_status,
      (SELECT count(*)::int FROM sync_outbox other WHERE other.aggregate_id=i.id::text AND other.target_system='suitecrm') AS jobs,
      r.row_fingerprint AS original_fingerprint,a.state,a.native_receipt IS NOT NULL AS has_receipt
      FROM sync_outbox o JOIN crm_legacy_email_terminal_hold.held r ON r.outbox_id=o.id
      JOIN crm_interactions i ON i.id=r.local_id JOIN crm_native_email_publication_admissions a ON a.operation_id=$2 WHERE o.id=$1`,
    [outboxId,nativeOperationId])).rows
    assert.deepEqual(terminal,[{id:outboxId,idempotency_key:before.idempotency_key,status:'succeeded',sync_status:'synced',jobs:1,
      original_fingerprint:held.originalFingerprint,state:'committed',has_receipt:true}])
    return {kind:'actual-local-joined-held-original-email-recovery',passed:true,syntheticSource:true,productionTouched:false,
      sameOriginalOutbox:true,originalFingerprint:held.originalFingerprint,stageReceiptHash:receipt.receiptHash,
      nativeResponseLossRecovered:true,ordinaryWorkerNativeCalls:ordinaryCalls,actualNativeAccountLinks:held.accounts.length,
      actualNativeContactLinks:held.contacts.length,unrelatedQueueUnchanged:true,distinctReceiptAttestor:true,native:native.evidence()}
  } finally {await roles.close()}
}
