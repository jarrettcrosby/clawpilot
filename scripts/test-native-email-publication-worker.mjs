#!/usr/bin/env node
// Focused synthetic orchestration checks. No DB, provider, application actor
// authorization, runtime deployment, native receipt fidelity or migration proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript')
function load(path,deps){
  const module={exports:{}}
  const source=readFileSync(new URL(`../${path}`,import.meta.url),'utf8')
  const code=ts.transpileModule(source,{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),`Unexpected dependency ${name}`);return deps[name]})
  return module.exports
}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const capability=load('app_src/lib/crm/nativeEmailCapabilityContract.ts',{'node:crypto':crypto,'./nativeEmailPublication':protocol})
const authority=load('app_src/lib/crm/nativeEmailAuthorityTransition.ts',{'./nativeEmailPublication':protocol,'./nativeEmailCapabilityContract':capability,
  './suiteCrmNativeEmailProjection':load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts',{'node:crypto':crypto})})
const api=load('app_src/lib/crm/nativeEmailPublicationWorker.ts',{'node:crypto':crypto,'./nativeEmailPublication':protocol})
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,hash=char=>char.repeat(64)
const clone=value=>JSON.parse(JSON.stringify(value))
function item(){return {id:id(1),aggregateType:'crm_interactions',aggregateId:id(2),operation:'upsert_record',idempotencyKey:'fixture',
  attempts:1,lockToken:id(3),payload:{entity:'interactions',pipelineId:id(4),localId:id(2),suiteCrmId:id(5),suiteCrmModule:'Emails',attributes:{name:'Synthetic'}}}}
function request(){return protocol.prepareNativeEmailPublication({command:{version:1,operationId:hash('a'),mode:'publish',workspaceId:id(6),
  pipelineId:id(4),generation:1,audienceFingerprint:hash('b'),suiteCrmId:id(5),globalId:'gi1234567',localId:id(2),
  expectedRecordFingerprint:null,projection:{attributes:{name:'Synthetic'}}},nativePolicyFingerprint:hash('c'),allowedReaderSuiteCrmUserIds:['admin']})}
function receipt(req=request()){return {version:1,operationId:req.command.operationId,commandHash:req.commandHash,state:'committed',replayed:false,
  result:{version:1,mode:'publish',suiteCrmId:id(5),globalId:'gi1234567',pipelineId:id(4),generation:1,audienceFingerprint:hash('b'),
    recordFingerprint:hash('d'),readerSuiteCrmUserIds:['admin'],projection:{version:2,synthetic:true}}}}
function fixture(){
  const events=[],req=request(),context={kind:'outbox',outboxId:id(1),idempotencyKey:'fixture',sourceHash:hash('f'),payloadHash:hash('e'),attempt:1}
  const lease={operationId:req.command.operationId,owner:id(7),fence:1,expiresAt:'2099-01-01T00:00:00Z',context}
  const state={enabled:true,activeOperationId:null,activeTransitionId:null,nativeState:'admitted',request:req,lease,receipt:null}
  const persistence={
    mode:async()=>{events.push('mode');return {enabled:state.enabled,activeOperationId:state.activeOperationId,activeTransitionId:state.activeTransitionId}},
    candidate:async()=>{events.push('candidate');return {request:state.request,context}},
    admit:async()=>{events.push('admit');state.activeOperationId=req.command.operationId;return {admission:{request:state.request,state:state.nativeState,receipt:state.receipt},lease:state.lease}},
    markDispatched:async(asked,held)=>{events.push('dispatch');assert.equal(asked.command.operationId,req.command.operationId);assert.equal(held,state.lease);state.nativeState='dispatched';return true},
    markUnknown:async()=>{events.push('unknown');state.nativeState='unknown'},
    claimResolution:async()=>{events.push('claim-resolution');return {admission:{request:state.request,state:state.nativeState,receipt:null},lease:state.lease}},
    settle:async()=>{events.push('settle');state.activeOperationId=null;return {synchronized:true,pipelineId:id(4),outboxId:id(1)}},
    hold:async(_item,code)=>{events.push(`hold:${code}`)},
  }
  const client={prepare:async()=>{events.push('prepare')},publish:async()=>{events.push('publish');return receipt(state.request)},
    resolveOrCancel:async()=>{events.push('resolve');return receipt(state.request)}}
  return {events,state,persistence,client,worker:api.createNativeEmailPublicationWorker(persistence,client,id(7))}
}
const checks=[]
async function check(name,callback){await callback();checks.push(name);console.log(`PASS ${name}`)}
await check('disabled DB mode permits legacy handling without invoking any native endpoint',async()=>{
  const f=fixture();f.state.enabled=false
  assert.deepEqual(await f.worker.resume(),{enabled:false,blocked:false})
  assert.deepEqual(await f.worker.process(item(),8),{handled:false})
  assert.deepEqual(f.events,['mode','mode'])
})
await check('fresh publication prepares before admission then checks owned dispatch before native mutation',async()=>{
  const f=fixture();const result=await f.worker.process(item(),8)
  assert.equal(result.handled,true);assert.equal(result.status,'succeeded')
  assert.deepEqual(f.events,['mode','candidate','prepare','admit','dispatch','publish','settle'])
})
await check('unknown native outcomes remain handled and never fall through to a legacy writer',async()=>{
  const f=fixture();f.client.publish=async()=>{f.events.push('publish');throw Error('network lost')}
  assert.deepEqual(await f.worker.process(item(),8),{handled:true,status:'held'})
  assert.equal(f.state.nativeState,'unknown');assert.equal(f.state.activeOperationId,hash('a'))
  assert.deepEqual(f.events.slice(-3),['publish','unknown','hold:native_outcome_unknown'])
  const second=await f.worker.process(item(),8);assert.equal(second.handled,true);assert.equal(second.status,'held')
  assert.equal(f.events.filter(e=>e==='publish').length,1)
})
await check('provider prepare failure cannot admit or publish and cannot expose provider error text',async()=>{
  const f=fixture();f.client.prepare=async()=>{throw Error('provider secret response')}
  assert.deepEqual(await f.worker.process(item(),8),{handled:true,status:'held'})
  assert.deepEqual(f.events,['mode','candidate','hold:native_email_publication_held'])
})
await check('active stored operation resolves before any fresh candidate is prepared',async()=>{
  const f=fixture();f.state.activeOperationId=hash('a');f.state.nativeState='unknown'
  const resumed=await f.worker.resume();assert.equal(resumed.blocked,false);assert.equal(resumed.settled.synchronized,true)
  await f.worker.process(item(),8)
  assert.ok(f.events.indexOf('resolve')<f.events.indexOf('candidate'))
  assert.deepEqual(f.events.slice(0,4),['mode','claim-resolution','resolve','settle'])
})
await check('busy or failed resolution blocks only native Email dispatch without sending fresh requests',async()=>{
  const f=fixture();f.state.activeOperationId=hash('a')
  f.persistence.claimResolution=async()=>{throw new protocol.NativeEmailPublicationHeld('work_lease_busy')}
  assert.deepEqual(await f.worker.resume(),{enabled:true,blocked:true})
  assert.deepEqual(await f.worker.process(item(),8),{handled:true,status:'held'})
  assert.equal(f.events.includes('prepare'),false);assert.equal(f.events.includes('publish'),false)
  const other=item();other.payload.suiteCrmModule='Calls'
  assert.deepEqual(await f.worker.process(other,8),{handled:false})
})
await check('authority transition holds resume and already-claimed Email peers without provider calls or legacy fallback',async()=>{
  const f=fixture();f.state.activeTransitionId=hash('f')
  assert.deepEqual(await f.worker.resume(),{enabled:true,blocked:true})
  assert.deepEqual(await f.worker.process(item(),8),{handled:true,status:'held'})
  assert.deepEqual(f.events,['mode','mode','hold:native_authority_transition_unresolved'])
  const other=item();other.payload.suiteCrmModule='Calls'
  assert.deepEqual(await f.worker.process(other,8),{handled:false})
  const previous=item();previous.payload.suiteCrmModule='Calls';previous.payload.previousSuiteCrmModule='Emails'
  assert.deepEqual(await f.worker.process(previous,8),{handled:true,status:'held'})
  assert.equal(f.events.includes('prepare'),false);assert.equal(f.events.includes('resolve'),false)
})
await check('current or previous Email delete/reproject transitions hold before any provider action',async()=>{
  for(const [operation,current,previous] of [['delete_record','Emails',undefined],['reproject_record','Calls','Emails'],
    ['reproject_record','Emails','Calls'],['upsert_record','Emails','Calls']]) {
    const f=fixture(),changed=item();changed.operation=operation;changed.payload.suiteCrmModule=current
    if(previous)changed.payload.previousSuiteCrmModule=previous
    assert.deepEqual(await f.worker.process(changed,8),{handled:true,status:'held'})
    assert.deepEqual(f.events,['mode','hold:native_email_transition_not_supported'])
  }
})
await check('DB mode is checked again per item and inconsistent or unreadable mode cannot fall back',async()=>{
  const f=fixture();f.state.enabled=false;await f.worker.resume();f.state.enabled=true
  assert.equal((await f.worker.process(item(),8)).handled,true)
  const inconsistent=fixture();inconsistent.state.enabled=false;inconsistent.state.activeOperationId=hash('a')
  await assert.rejects(()=>inconsistent.worker.process(item(),8),/disabled_mode_has_active_admission/)
  const unavailable=fixture();unavailable.persistence.mode=async()=>{throw Error('DB unavailable')}
  await assert.rejects(()=>unavailable.worker.process(item(),8),/DB unavailable/)
  assert.deepEqual(unavailable.events,[])
  for(const mode of [
    {enabled:false,activeOperationId:null},
    {enabled:false,activeOperationId:null,activeTransitionId:hash('f')},
    {enabled:true,activeOperationId:hash('a'),activeTransitionId:hash('f')},
    {enabled:true,activeOperationId:null,activeTransitionId:hash('f')+'\n'},
  ]) {
    const bad=fixture();bad.persistence.mode=async()=>mode
    await assert.rejects(()=>bad.worker.resume(),/native_publication_control_|disabled_mode_has_active_admission/)
    await assert.rejects(()=>bad.worker.process(item(),8),/native_publication_control_|disabled_mode_has_active_admission/)
    assert.deepEqual(bad.events,[],'Malformed transition state cannot opt back into legacy handling')
  }
})
await check('repair resolution requires separately reviewed authority and is never auto-authorized by command hash',async()=>{
  const f=fixture();f.state.activeOperationId=hash('a');f.state.request.command.mode='repair'
  assert.deepEqual(await f.worker.resume(),{enabled:true,blocked:true})
  assert.equal(f.events.includes('resolve'),false)
})
await check('missing work lease failed dispatch and terminal admission replay never emit a fresh publish',async()=>{
  const noLease=fixture();noLease.persistence.admit=async()=>{throw new protocol.NativeEmailPublicationHeld('reconciliation_required')}
  assert.equal((await noLease.worker.process(item(),8)).status,'held');assert.equal(noLease.events.includes('publish'),false)
  const stale=fixture();stale.persistence.markDispatched=async()=>false
  assert.equal((await stale.worker.process(item(),8)).status,'held');assert.equal(stale.events.includes('publish'),false)
  const replay=fixture();replay.state.receipt=receipt()
  assert.equal((await replay.worker.process(item(),8)).status,'held');assert.equal(replay.events.includes('publish'),false)
})
await check('finalization failure retains unresolved native operation and returns held rather than success',async()=>{
  const f=fixture();f.persistence.settle=async()=>{throw Error('local finalizer failed')}
  assert.deepEqual(await f.worker.process(item(),8),{handled:true,status:'held'})
  assert.equal(f.state.nativeState,'dispatched');assert.equal(f.state.activeOperationId,hash('a'))
})

await check('actual worker bypasses generic completion/failure for native handled work and resolves before claim',async()=>{
  const events=[]
  const actual=load('app_src/lib/crm/worker.ts',{
    '@/lib/crm/suiteCrmClient':{createSuiteCrmNativeEmailPublicationClient:()=>({}),
      deleteSuiteCrmRecord:async()=>assert.fail('legacy delete'),upsertSuiteCrmRecordWithResult:async()=>assert.fail('legacy upsert'),upsertSuiteCrmUserIdentity:async()=>assert.fail('legacy user')},
    '@/lib/crm/suiteCrmNativeEmailProjection':{SuiteCrmEmailProjectionHeldError:Error},
    '@/lib/crm/suiteCrmRecordLifecycleClient':{deleteSuiteCrmAccountContactVerified:async()=>assert.fail('native Email must not use account/contact delete')},
    '@/lib/persistence/crm':{claimSuiteCrmOutboxInPostgres:async()=>{events.push('claim');return [item()]},
      withVerifiedSuiteCrmRecordLifecycle:async()=>assert.fail('native handled Email must not enter generic record lifecycle'),
      completeSuiteCrmOutboxInPostgres:async()=>assert.fail('generic completion'),failSuiteCrmOutboxInPostgres:async()=>assert.fail('generic failure'),
      writeSuiteCrmWorkerHeartbeat:async()=>{},readCrmWorkbookProjectionReadiness:async()=>({ready:false})},
    '@/lib/persistence/pipeline':{},
    '@/lib/persistence/crmNativeEmailPublication':{createPostgresNativeEmailWorkerPersistence:()=>({})},
    '@/lib/crm/nativeEmailPublicationWorker':{touchesNativeEmail:api.touchesNativeEmail,
      createNativeEmailPublicationWorker:()=>({resume:async()=>{events.push('resume');return {enabled:true,blocked:false}},
        process:async()=>({handled:true,status:'held'})})},
  })
  const summary=await actual.processSuiteCrmOutbox()
  assert.deepEqual(events,['resume','claim']);assert.equal(summary.held,1);assert.equal(summary.succeeded,0);assert.equal(summary.failed,0)
})
await check('actual worker rechecks identity dispatch and holds enabled identity without blocking unrelated projections',async()=>{
  for(const allowed of [false,true]){
    const events=[],identity={id:id(80),aggregateType:'app_users',aggregateId:'synthetic@example.test',operation:'upsert_user_identity',
      payload:{localId:'synthetic@example.test',suiteCrmUserId:id(81),referenceCode:'gu1234567',username:'gu1234567'}}
    const note=item();note.id=id(82);note.payload.suiteCrmModule='Notes'
    const actual=load('app_src/lib/crm/worker.ts',{
      '@/lib/crm/suiteCrmClient':{createSuiteCrmNativeEmailPublicationClient:()=>({}),
        upsertSuiteCrmUserIdentity:async()=>{assert.equal(allowed,true);events.push('native.identity')},
        upsertSuiteCrmRecordWithResult:async()=>{events.push('native.note');return {productImageProjection:null}}},
      '@/lib/crm/suiteCrmNativeEmailProjection':{SuiteCrmEmailProjectionHeldError:Error},
      '@/lib/crm/suiteCrmRecordLifecycleClient':{deleteSuiteCrmAccountContactVerified:async()=>assert.fail('identity/note fixture cannot delete accounts or contacts')},
      '@/lib/persistence/crm':{claimSuiteCrmOutboxInPostgres:async()=>[identity,note],
        withVerifiedSuiteCrmRecordLifecycle:async(selected,publish)=>{assert.equal(selected,note);assert.equal(selected.payload.entity,'interactions');assert.equal(selected.payload.suiteCrmModule,'Notes');return publish()},
        mayDispatchSuiteCrmUserIdentityInPostgres:async selected=>{assert.equal(selected,identity);events.push('identity.recheck');return allowed},
        completeSuiteCrmOutboxInPostgres:async selected=>{events.push(selected===identity?'complete.identity':'complete.note')},
        failSuiteCrmOutboxInPostgres:async()=>assert.fail('policy hold must not burn attempts via generic failure'),
        writeSuiteCrmWorkerHeartbeat:async()=>{},readCrmWorkbookProjectionReadiness:async()=>({ready:false})},
      '@/lib/persistence/pipeline':{},
      '@/lib/persistence/crmNativeEmailPublication':{createPostgresNativeEmailWorkerPersistence:()=>({})},
      '@/lib/crm/nativeEmailPublicationWorker':{touchesNativeEmail:api.touchesNativeEmail,
        createNativeEmailPublicationWorker:()=>({resume:async()=>({enabled:!allowed,blocked:false}),process:async()=>({handled:false})})},
    })
    const summary=await actual.processSuiteCrmOutbox()
    assert.deepEqual(events,allowed?['identity.recheck','native.identity','complete.identity','native.note','complete.note']
      :['identity.recheck','native.note','complete.note'])
    assert.equal(summary.held,allowed?0:1);assert.equal(summary.succeeded,allowed?2:1);assert.equal(summary.failed,0)
  }
})
await check('actual worker wraps exact account/contact deletion, never using the legacy delete fallback',async()=>{
  for(const entity of ['organizations','contacts'])for(const held of [false,true]){
    const selected={id:id(90),aggregateType:`crm_${entity}`,aggregateId:id(91),operation:'delete_record',
      payload:{entity,pipelineId:id(4),localId:id(91),suiteCrmId:id(92),attributes:{global_id_c:entity==='organizations'?'ga1234567':'gc1234567'}}}
    const events=[];let guarded=false
    const actual=load('app_src/lib/crm/worker.ts',{
      '@/lib/crm/suiteCrmClient':{createSuiteCrmNativeEmailPublicationClient:()=>({}),
        deleteSuiteCrmRecord:async()=>assert.fail('Account/Contact delete cannot use generic native DELETE'),
        upsertSuiteCrmRecordWithResult:async()=>assert.fail('Delete must not upsert')},
      '@/lib/crm/suiteCrmRecordLifecycleClient':{deleteSuiteCrmAccountContactVerified:async payload=>{
        assert.equal(guarded,true);assert.equal(payload,selected.payload);events.push('verified-delete')}},
      '@/lib/crm/suiteCrmNativeEmailProjection':{SuiteCrmEmailProjectionHeldError:Error},
      '@/lib/persistence/crm':{claimSuiteCrmOutboxInPostgres:async()=>[selected],
        withVerifiedSuiteCrmRecordLifecycle:async(item,publish)=>{
          assert.equal(item,selected);events.push('lifecycle-guard')
          if(held)throw Error('CRM record synchronization identity changed')
          guarded=true;try{return await publish()}finally{guarded=false}
        },
        completeSuiteCrmOutboxInPostgres:async item=>{assert.equal(item,selected);assert.equal(guarded,false);events.push('complete')},
        failSuiteCrmOutboxInPostgres:async input=>{assert.equal(input.item,selected);events.push('failed');return 'failed'},
        writeSuiteCrmWorkerHeartbeat:async()=>{},readCrmWorkbookProjectionReadiness:async()=>({ready:false})},
      '@/lib/persistence/pipeline':{},
      '@/lib/persistence/crmNativeEmailPublication':{createPostgresNativeEmailWorkerPersistence:()=>({})},
      '@/lib/crm/nativeEmailPublicationWorker':{touchesNativeEmail:()=>false,
        createNativeEmailPublicationWorker:()=>({resume:async()=>({enabled:false,blocked:false}),process:async()=>({handled:false})})},
    })
    const summary=await actual.processSuiteCrmOutbox()
    assert.deepEqual(events,held?['lifecycle-guard','failed']:['lifecycle-guard','verified-delete','complete'])
    assert.equal(summary.succeeded,held?0:1);assert.equal(summary.failed,held?1:0)
  }
})
await check('adapter source enforces dispatch lease and preserves prior native receipt as superseded CAS baseline',()=>{
  const source=readFileSync(new URL('../app_src/lib/persistence/crmNativeEmailPublication.ts',import.meta.url),'utf8')
  assert.match(source,/markDispatched:[\s\S]*assertNativeEmailPublicationWorkLease[\s\S]*SET state='dispatched'/)
  assert.match(source,/state='committed'[\s\S]*ORDER BY updated_at DESC/)
  assert.match(source,/native_historical_baseline_required/)
  assert.match(source,/Native Email committed for superseded source/)
  assert.match(source,/if \(committed && current\)/)
  assert.match(source,/suiteCrmEmailProjection/)
})
await check('actual adapter transition mode fails closed and candidate rechecks the locked barrier',async()=>{
  const state={row:{enabled:true,active_operation_id:null,active_transition_id:hash('f'),generation:1,verified_generation:1,
    native_policy_fingerprint:hash('c'),activation_receipt_hash:hash('d')},pending:false,calls:[],outbox:{status:'processing',attempts:1,lock_token:id(3)}}
  const query=async(sql,params=[])=>{
    state.calls.push({sql,params})
    if(sql.startsWith('SELECT * FROM crm_native_email_publication_control'))return {rows:[clone(state.row)]}
    if(sql.includes('FROM crm_native_email_publication_work w'))return {rows:state.pending?[{one:1}]:[]}
    if(sql.includes("UPDATE sync_outbox SET status='queued',attempts=GREATEST(attempts-1,0)")){
      assert.match(sql,/WHERE id=\$1::uuid AND status='processing' AND lock_token=\$2/)
      assert.deepEqual(params.slice(0,2),[id(1),id(3)])
      if(state.outbox.status==='processing'&&state.outbox.lock_token===params[1]){
        state.outbox.status='queued';state.outbox.attempts--;state.outbox.lock_token=null
        return {rows:[{id:id(1)}]}
      }
      return {rows:[]}
    }
    throw Error(`Unexpected SQL during transition: ${sql}`)
  }
  const adapterApi=load('app_src/lib/persistence/crmNativeEmailPublication.ts',{
    './postgres':{query,withTransaction:callback=>callback({query})},'./pipeline':{},'./crm':{},
    '../crm/stableId':{},'../crm/nativeEmailPublication':protocol,
    '../crm/nativeEmailAuthorityTransition':authority,
    '../crm/nativeEmailCapabilityContract':load('app_src/lib/crm/nativeEmailCapabilityContract.ts',{'node:crypto':crypto,'./nativeEmailPublication':protocol}),
    '../crm/nativeEmailPublicationPostgres':{PostgresNativeEmailPublicationStore:class{}},
    '../crm/nativeEmailPublicationWorkContext':{},'../crm/nativeEmailPublicationTransport':{},
    '../crm/legacyEmailRecoveryReleaseApproval':{},
    '../crm/nativeEmailRecoveryDispatchPermit':{},
  })
  const adapter=adapterApi.createPostgresNativeEmailWorkerPersistence()
  assert.deepEqual(await adapter.mode(),{enabled:true,activeOperationId:null,activeTransitionId:hash('f')})
  const valid=clone(state.row)
  for(const patch of [
    {active_transition_id:undefined},{active_transition_id:hash('f')+'\n'},
    {enabled:false},{active_operation_id:hash('a')},
  ]){
    state.row={...valid,...patch}
    await assert.rejects(()=>adapter.mode(),/native_publication_control_|disabled_mode_has_active_admission/)
  }
  state.row=valid
  state.calls=[]
  await assert.rejects(()=>adapter.candidate(item()),/native_authority_transition_unresolved/)
  assert.equal(state.calls.length,1,'Candidate stops before source/outbox locks while transition holds')
  assert.match(state.calls[0].sql,/WHERE singleton FOR UPDATE$/)
  await adapter.hold(item(),'native_authority_transition_unresolved',8)
  assert.deepEqual(state.outbox,{status:'queued',attempts:0,lock_token:null})
  await adapter.hold(item(),'native_authority_transition_unresolved',8)
  assert.equal(state.outbox.attempts,0,'Replayed hold cannot double-credit the attempt')
  state.outbox={status:'processing',attempts:1,lock_token:id(3)}
  state.row.active_transition_id=null
  await adapter.hold(item(),'native_authority_transition_unresolved',8)
  assert.equal(state.outbox.attempts,0,'Completed transition between refusal and hold does not burn the claim')
  state.outbox={status:'processing',attempts:1,lock_token:id(3)};state.pending=true
  state.calls=[]
  await adapter.hold(item(),'native_authority_transition_unresolved',8)
  assert.deepEqual(state.outbox,{status:'processing',attempts:1,lock_token:id(3)})
  assert.ok(!state.calls.some(({sql})=>sql.startsWith('UPDATE')),'An admitted/unknown operation is never recycled or credited')
})
console.log(`PASS ${checks.length} synthetic worker/coordinator checks; no DB/native/application-authorization/deployment proof`)
