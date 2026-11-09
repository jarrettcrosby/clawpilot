import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createBpoFailedEmailAppHandoff, prepareBpoFailedEmailCandidate } from './lib/bpo-failed-email-app-handoff.mjs'
import { describeBpoFailedEmailRepairInventory } from './lib/bpo-failed-email-repair-plan.mjs'
import { prepareBpoSharedEmailProjection } from './lib/bpo-shared-email-projection.mjs'

const WORKSPACE='c6c49765-9bf6-4223-9261-7553499f5d92', PIPELINE='587c8746-ecf6-40ae-8c50-e456f99ad555'
const sha=text=>createHash('sha256').update(text).digest('hex'), uuid=n=>`9587544f-22f4-44db-81ba-${String(n).padStart(12,'0')}`
const at='2026-11-09T00:00:05.000Z', seen='2026-11-09T00:00:01.000Z'
const liveRelationships={accounts:['airspace','globus'],contacts:['casey','globus-contact'],contactAccounts:[{contactId:'casey',accountId:'airspace'},
  {contactId:'globus-contact',accountId:'globus'}],parentType:'Accounts',parentId:'globus'}
const sample='Synthetic body must never appear in the audit'
function fixture(){
  const app={originFingerprint:sha('app origin'),deploymentFingerprint:sha('app release')}
  const suiteCrm={originFingerprint:sha('native origin'),deploymentFingerprint:sha('native release')}
  const entries=Array.from({length:19},(_,i)=>({interactionId:uuid(i+1),jobId:uuid(i+30),nativeId:uuid(i+60),globalId:`gi${String(i+1).padStart(7,'0')}`,
    providerMessageId:`synthetic-${i}`,interactionFingerprint:sha(`interaction-${i}`),jobFingerprint:sha(`job-${i}`),preimageFingerprint:sha(`preimage-${i}`),
    projectionFingerprint:sha(`projection-${i}`)}))
  const pin=entries[0]
  const payload={entity:'interactions',localId:pin.interactionId,pipelineId:PIPELINE,suiteCrmModule:'Emails',suiteCrmId:pin.nativeId,
    attributes:{global_id_c:pin.globalId,name:'Synthetic private email',date_sent_received:'2026-11-09T00:00:00Z',type:'archived',status:'read',
      parent_type:'Accounts',parent_id:'globus',assigned_user_id:'fixture-author',description:sample,description_html:'',from_addr_name:'author@example.invalid'},
    emailProjection:{version:1,accounts:liveRelationships.accounts,contacts:liveRelationships.contacts,contactAccounts:liveRelationships.contactAccounts,
      previousManaged:{accounts:[],contacts:[]},audience:{ignored:true}},
    relationships:[...liveRelationships.accounts.map(relatedBeanId=>({linkFieldName:'accounts',relatedModuleName:'Accounts',relatedBeanId})),
      ...liveRelationships.contacts.map(relatedBeanId=>({linkFieldName:'contacts',relatedModuleName:'Contacts',relatedBeanId}))]}
  pin.projectionFingerprint=prepareBpoSharedEmailProjection({payload,pin:{...pin,projectionFingerprint:undefined},pipelineId:PIPELINE,
    liveRelationships}).projectionFingerprint
  const review={workspaceId:WORKSPACE,pipelineId:PIPELINE,app,suiteCrm,original11:entries.slice(0,11),later8:entries.slice(11)}
  const raw={version:1,readOnly:true,purpose:'clawpilot-bpo-terminal-email-candidate-inventory',originFingerprint:app.originFingerprint,
    original11:review.original11.map(({projectionFingerprint,...row})=>row),later8:review.later8.map(({projectionFingerprint,...row})=>row)}
  const opts={review,expectedInventoryFingerprint:describeBpoFailedEmailRepairInventory(review),attestAppDeployment:async()=>app.deploymentFingerprint,
    verifyNativeAbsence:async(evidence,target)=>({...target,version:1,state:'absent',observedAt:seen,evidenceFingerprint:sha('native absence'),...evidence})}
  const recorded=[], state={audit:null,drift:false,loss:false,links:liveRelationships}
  const client=new EventEmitter()
  client.query=async(sql,args)=>{
    recorded.push(sql)
    if(sql.includes('pg_control_system'))return {rows:[{snapshotProtected:true,originFingerprint:app.originFingerprint}]}
    if(sql.startsWith('SELECT to_char'))return {rows:[{at,direct:true}]}
    if(sql.startsWith('WITH slots'))return {rows:[{...pin,workspaceId:WORKSPACE,pipelineId:PIPELINE,syncStatus:'failed',
      terminalLatestJob:true,unclaimed:true,uniqueIdentity:true,...(state.drift?{jobFingerprint:sha('changed')}:null)}]}
    if(sql.startsWith('SELECT 1 FROM public.crm_contact_merge'))return {rows:[]}
    if(sql.startsWith('SELECT payload FROM public.sync_outbox'))return {rows:[{payload}]}
    if(sql.startsWith('WITH target'))return {rows:[{links:state.links}]}
    if(sql.startsWith('SELECT event_type'))return {rows:state.audit?[state.audit]:[]}
    if(sql.startsWith('INSERT INTO public.audit_events')){
      assert.equal(state.audit,null)
      state.audit={event_type:args[0],aggregate_type:'crm_interactions',aggregate_id:args[2],organization_id:args[3],is_system:true,payload:JSON.parse(args[4])}
    }
    if(sql==='COMMIT'&&state.loss)throw new Error('Synthetic commit reply lost')
    return {rows:[{}],command:sql}
  }
  return {client,pin,opts,raw,recorded,state,input:{client,interactionId:pin.interactionId}}
}

test('raw immutable App candidate computes exact projection read-only; mismatches and mapping drift hold',async()=>{
  const f=fixture(), text=JSON.stringify(f.raw), args={...f.input,candidateManifestJson:text,expectedManifestFingerprint:sha(text),
    appDeploymentFingerprint:f.opts.review.app.deploymentFingerprint,attestAppDeployment:f.opts.attestAppDeployment}
  const prepared=await prepareBpoFailedEmailCandidate(args)
  assert.equal(prepared.projectionFingerprint,f.pin.projectionFingerprint)
  assert.equal(prepared.projection.attributes.description,sample)
  assert.ok(f.recorded[0].endsWith('READ ONLY'))
  assert.equal(f.recorded.at(-1),'ROLLBACK')
  assert.doesNotMatch(f.recorded.join('\n'),/INSERT INTO|FOR UPDATE|\bCOMMIT\b/u)
  await assert.rejects(prepareBpoFailedEmailCandidate({...args,expectedManifestFingerprint:sha('wrong')}),/candidate_inventory_pin/u)
  f.state.drift=true
  await assert.rejects(prepareBpoFailedEmailCandidate(args),/slot_preimage_changed/u)
  f.state.drift=false;f.state.links={...liveRelationships,parentId:'airspace'}
  await assert.rejects(prepareBpoFailedEmailCandidate(args),/relationships_changed/u)
})

test('claim requires exact fresh native absence and commits one body-free audit; repeat is readback only',async()=>{
  const f=fixture(), handoff=createBpoFailedEmailAppHandoff(f.opts)
  assert.equal((await handoff.inspect(f.input)).state,'ready')
  assert.equal(f.state.audit,null)
  await assert.rejects(handoff.claim(f.input),/native_absence_binding/u)
  await assert.rejects(handoff.claim({...f.input,absenceEvidence:{state:'exact'}}),/native_absence_binding/u)
  await assert.rejects(handoff.claim({...f.input,absenceEvidence:{observedAt:'2026-11-08T00:00:01.000Z'}}),/native_absence_stale/u)
  await assert.rejects(handoff.claim({...f.input,absenceEvidence:{nativeId:uuid(999)}}),/native_absence_binding/u)
  const result=await handoff.claim({...f.input,absenceEvidence:{}})
  assert.equal(result.state,'dispatch-once')
  assert.deepEqual(result.dispatchClaim.target,result.target)
  assert.equal(f.recorded.at(-1),'COMMIT')
  assert.ok(!JSON.stringify(f.state.audit).includes(sample))
  assert.equal((await handoff.inspect(f.input)).state,'reconcile-only')
  assert.equal((await handoff.claim(f.input)).state,'reconcile-only')
  assert.equal(f.recorded.at(-1),'ROLLBACK')
  assert.equal(f.recorded.filter(sql=>sql.startsWith('INSERT INTO')).length,1)
  assert.doesNotMatch(f.recorded.join('\n'),/UPDATE public\.(?:sync_outbox|crm_interactions)/u)
})

test('lost App COMMIT never hands out authority; inspect or repeat can only reconcile durable prior',async()=>{
  const f=fixture(), handoff=createBpoFailedEmailAppHandoff(f.opts)
  f.state.loss=true
  await assert.rejects(handoff.claim({...f.input,absenceEvidence:{}}),/dispatch_commit_unproven/u)
  assert.equal((await createBpoFailedEmailAppHandoff(f.opts).inspect(f.input)).state,'reconcile-only')
  assert.equal((await handoff.claim({...f.input,absenceEvidence:{}})).state,'reconcile-only')
  assert.equal(f.recorded.filter(sql=>sql.startsWith('INSERT INTO')).length,1)
  f.state.audit.payload.target.globalId='gi7777777'
  await assert.rejects(handoff.inspect(f.input),/dispatch_audit_binding/u)
})
