#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as publicOriginRouting from '../app_src/lib/publicOriginRouting.mjs'

const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
const copy=value=>JSON.parse(JSON.stringify(value))
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
function load(path,mocks) {
  const module={exports:{}}
  const output=ts.transpileModule(readFileSync(new URL(`../${path}`,import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
  }).outputText
  new Function('module','exports','require','process',output)(module,module.exports,
    name=>{assert.ok(name in mocks,`Unexpected dependency: ${name}`);return mocks[name]},{env:{}})
  return module.exports
}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const selected={ownerEmail:'owner@example.test',workspaceId:uuid(1),pipelineId:uuid(2),connectionId:uuid(3),
  messageIds:['a1','a2','a3']}
function harness(mutate=()=>{}) {
  const audience={workspaceId:selected.workspaceId,pipelineId:selected.pipelineId,ownerSuiteCrmId:'owner-native',
    allowedSuiteCrmUserIds:['owner-native'],fingerprint:'b'.repeat(64),policy:'pipeline-internal'}
  const state={control:{enabled:true,generation:3,verified_generation:3,native_policy_fingerprint:'a'.repeat(64),
      activation_receipt_hash:'b'.repeat(64),active_operation_id:null,active_transition_id:null},
    owners:[{id:selected.pipelineId}],mailboxes:[{id:uuid(4),verified_at:'2026-10-30 12:00:00+00',account_email:'mailbox@example.test'}],
    sources:[],interactions:[],outboxes:[],audience,sourceConflict:false,interactionConflict:false}
  for(let n=1;n<=4;n++) {
    const source={id:uuid(10+n),provider_message_id:`a${n}`,provider_thread_id:'b1',evidence_hash:hash(`source${n}`)}
    const interaction={id:uuid(20+n),canonical_source_id:source.id,pipeline_id:selected.pipelineId,
      provider_message_id:source.provider_message_id,provider_thread_id:source.provider_thread_id,reference_code:`gi123456${n}`,
      suitecrm_id:uuid(30+n),suitecrm_module:'Emails',source_hash:hash(`interaction${n}`),source_payload:{}}
    const outbox={id:uuid(40+n),aggregate_type:'crm_interactions',aggregate_id:interaction.id,target_system:'suitecrm',
      operation:'upsert_record',status:'queued',ready:true,unresolved:false,attempts:0,lock_token:null,
      idempotency_key:`crm:interactions:v4:${interaction.id}:Emails:${interaction.source_hash}`,
      payload:{entity:'interactions',localId:interaction.id,pipelineId:selected.pipelineId,suiteCrmId:interaction.suitecrm_id,
        suiteCrmModule:'Emails',attributes:{global_id_c:interaction.reference_code,assigned_user_id:'owner-native'},
        emailProjection:{audience:copy(audience)},relationships:[]}}
    state.sources.push(source);state.interactions.push(interaction);state.outboxes.push(outbox)
  }
  mutate(state)
  const calls=[],writes=[]
  const client={async query(sql,params=[]) {
    calls.push({sql,params})
    if(sql.includes('FROM crm_native_email_publication_control')) {
      assert.match(sql,/WHERE singleton FOR UPDATE/);return {rows:state.control?[state.control]:[]}
    }
    if(sql.includes('FROM pipeline_spaces pipeline')) {
      assert.match(sql,/pipeline\.workspace_organization_id=\$2::uuid/)
      assert.match(sql,/pipeline\.owner_email=\$3/)
      assert.match(sql,/membership\.trashed_at IS NULL/)
      assert.deepEqual(copy(params),[selected.pipelineId,selected.workspaceId,selected.ownerEmail])
      return {rows:state.owners}
    }
    if(sql.includes('FROM crm_email_mailboxes')) {
      assert.match(sql,/binding\.connection_id=\$2/)
      assert.match(sql,/connection\.status='ACTIVE' AND connection\.is_selected/)
      assert.match(sql,/remote_updated_at.*<=binding\.verified_at/)
      assert.match(sql,/FOR SHARE OF mailbox,binding,connection/)
      assert.deepEqual(copy(params),[selected.ownerEmail,selected.connectionId]);return {rows:state.mailboxes}
    }
    if(sql.includes('AS source_conflict')) {
      assert.match(sql,/source\.owner_email=\$1 OR source\.mailbox_id=\$2::uuid/)
      assert.match(sql,/lower\(btrim\(source\.provider_message_id\)\)=ANY\(\$3::text\[\]\)/)
      assert.match(sql,/pipeline\.owner_email=\$1 AND interaction\.id<>ALL\(\$5::uuid\[\]\)/)
      assert.match(sql,/interaction\.canonical_source_id=ANY\(\$4::uuid\[\]\)/)
      assert.deepEqual(copy(params.slice(0,3)),[selected.ownerEmail,uuid(4),selected.messageIds])
      return {rows:[{source_conflict:state.sourceConflict,interaction_conflict:state.interactionConflict}]}
    }
    if(sql.includes('FROM crm_email_sources')) {
      assert.match(sql,/mailbox_id=\$1::uuid AND owner_email=\$2/)
      assert.match(sql,/provider_message_id=ANY\(\$3::text\[\]\)/)
      assert.equal(params[0],uuid(4));assert.equal(params[1],selected.ownerEmail)
      return {rows:state.sources.filter(row=>params[2].includes(row.provider_message_id))}
    }
    if(sql.includes('FROM crm_interactions')) {
      assert.match(sql,/pipeline_id=\$1::uuid AND canonical_source_id=ANY\(\$2::uuid\[\]\)/)
      assert.match(sql,/ORDER BY id FOR UPDATE/)
      return {rows:state.interactions.filter(row=>row.pipeline_id===params[0] && params[1].includes(row.canonical_source_id))}
    }
    if(sql.includes('FROM sync_outbox outbox')) {
      assert.match(sql,/aggregate_id=ANY\(\$1::text\[\]\) AND outbox\.idempotency_key=ANY\(\$2::text\[\]\)/)
      assert.match(sql,/context->>'outboxId'=outbox\.id::text/)
      assert.match(sql,/admission\.state IN \('admitted','dispatched','unknown'\)/)
      assert.match(sql,/ORDER BY outbox.id FOR UPDATE OF outbox/)
      return {rows:copy(state.outboxes.filter(row=>params[0].includes(row.aggregate_id)&&params[1].includes(row.idempotency_key)))}
    }
    if(sql.startsWith('UPDATE sync_outbox')) {
      assert.match(sql,/AND aggregate_id=\$3 AND idempotency_key=\$4 AND payload=\$5::jsonb/)
      assert.match(sql,/AND status IN \('queued','failed'\) AND attempts=\$6 AND available_at<=now\(\)/)
      const row=state.outboxes.find(o=>o.id===params[0]&&o.aggregate_id===params[2]&&o.idempotency_key===params[3]
        &&JSON.stringify(o.payload)===params[4]&&o.attempts===params[5]&&['queued','failed'].includes(o.status)&&o.ready)
      if(!row)return {rows:[]}
      row.status='processing';row.attempts++;row.lock_token=params[1];writes.push(row.id)
      return {rows:[{id:row.id}]}
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  }}
  const api=load('app_src/lib/persistence/crmExactEmailPublication.ts',{
    'node:crypto':crypto,'../crm/stableId':{crmSourceHash:hash},'../crm/nativeEmailPublication':protocol,
    './crm':{reviewedEmailAudienceUnderNativeControlWithClient:async()=>state.audience},
    './postgres':{withTransaction:async fn=>{const before=copy(state);try{return await fn(client)}catch(error){
      Object.assign(state,before);throw error}}},
  })
  return {api,state,calls,writes}
}

test('preview is exact-message scoped and contains no body, mailbox address, source content, or provider subject',async()=>{
  const h=harness(),result=await h.api.previewExactEmailPublicationInPostgres(selected)
  assert.equal(h.writes.length,0)
  assert.deepEqual(copy(result.messages.map(row=>row.messageId)),selected.messageIds)
  assert.deepEqual(Object.keys(result).sort(),['digest','messages','pipelineId'])
  assert.ok(result.messages.every(row=>Object.keys(row).sort().join(',')==='globalId,messageId,status'))
  assert.doesNotMatch(JSON.stringify(result),/mailbox@example|source_hash|attributes|emailProjection|provider_account/)
  assert.match(h.calls[0].sql,/publication_control.*WHERE singleton FOR UPDATE/)
  const i=h.calls.findIndex(call=>call.sql.includes('FROM crm_interactions'))
  assert.ok(i<h.calls.findIndex(call=>call.sql.includes('FROM sync_outbox outbox')))
})
test('apply claims only exact current source and payload; unrelated queue rows stay untouched',async()=>{
  const h=harness(),other=copy(h.state.outboxes[3]),preview=await h.api.previewExactEmailPublicationInPostgres(selected)
  const result=await h.api.claimExactEmailPublicationInPostgres(selected,preview.digest)
  assert.equal(result.items.length,3);assert.equal(result.alreadyCompleted,0)
  assert.deepEqual(copy(result.items.map(row=>row.id)),[uuid(41),uuid(42),uuid(43)])
  assert.deepEqual(h.state.outboxes[3],other)
  assert.ok(result.items.every(row=>row.attempts===1&&row.lockToken))
  assert.equal(h.calls.filter(call=>call.sql.includes('SuiteCRM worker lease expired')).length,0)
})
test('same reviewed revision is idempotent after terminal success without requeue or native call authority',async()=>{
  const h=harness(),preview=await h.api.previewExactEmailPublicationInPostgres(selected)
  await h.api.claimExactEmailPublicationInPostgres(selected,preview.digest)
  for(const row of h.state.outboxes.slice(0,3))row.status='succeeded'
  h.writes.length=0
  const result=await h.api.claimExactEmailPublicationInPostgres(selected,preview.digest)
  assert.equal(result.items.length,0);assert.equal(result.alreadyCompleted,3);assert.equal(h.writes.length,0)
})
test('policy, audience, source, mailbox verification or payload drift invalidates preview before claims',async()=>{
  const mutations=[s=>s.control.generation=s.control.verified_generation=4,
    s=>s.control.native_policy_fingerprint='f'.repeat(64),s=>s.control.activation_receipt_hash='f'.repeat(64),
    s=>s.mailboxes[0].verified_at='2026-10-31 12:00:00+00',s=>s.sources[0].evidence_hash='f'.repeat(64),
    s=>s.outboxes[0].payload.attributes.description='new source body',
    s=>s.interactions[0].source_hash='f'.repeat(64),s=>s.audience.fingerprint='f'.repeat(64)]
  for(const mutate of mutations){const h=harness(),p=await h.api.previewExactEmailPublicationInPostgres(selected)
    mutate(h.state);await assert.rejects(h.api.claimExactEmailPublicationInPostgres(selected,p.digest),/unavailable or changed/)
    assert.equal(h.writes.length,0)}
})
test('a later same-owner collision holds the complete reviewed selection without claiming any job',async()=>{
  for(const key of ['sourceConflict','interactionConflict']){
    const h=harness(),preview=await h.api.previewExactEmailPublicationInPostgres(selected)
    h.state[key]=true
    const before=copy(h.state.outboxes)
    await assert.rejects(h.api.claimExactEmailPublicationInPostgres(selected,preview.digest),/unavailable or changed/)
    assert.deepEqual(h.state.outboxes,before)
    assert.equal(h.writes.length,0)
  }
})
test('all owner, mailbox, source, archive, duplicate and relationship audience constraints are checked before claim',async()=>{
  const mutations=[s=>s.owners=[],s=>s.mailboxes=[],s=>s.sources.pop()&&s.sources.shift(),
    s=>s.interactions[0].source_payload.archived=true,s=>s.interactions[0].provider_message_id='a4',
    s=>s.interactions[0].provider_thread_id='b2',s=>s.interactions[0].canonical_source_id=s.interactions[1].canonical_source_id,
    s=>s.interactions[0].pipeline_id=uuid(999),s=>s.interactions[0].suitecrm_module='Notes',
    s=>s.outboxes.push(copy(s.outboxes[0])),s=>s.outboxes[0].payload.previousSuiteCrmModule='Notes',
    s=>s.outboxes[0].payload.attributes.assigned_user_id='other',
    s=>s.outboxes[0].payload.emailProjection.audience.workspaceId=uuid(999)]
  for(const mutate of mutations){const h=harness(mutate)
    await assert.rejects(h.api.previewExactEmailPublicationInPostgres(selected),/unavailable or changed/)
    assert.equal(h.writes.length,0)}
})
test('disabled, unverified, unresolved and active-authority modes never fall back or resume globally',async()=>{
  for(const mutate of [s=>s.control=null,s=>s.control.enabled=false,s=>s.control.verified_generation=2,
    s=>s.control.active_operation_id='c'.repeat(64),s=>s.control.active_transition_id='d'.repeat(64),
    s=>s.outboxes[0].unresolved=true]) {
    const h=harness(mutate)
    await assert.rejects(h.api.previewExactEmailPublicationInPostgres(selected),/unavailable or changed/)
    assert.equal(h.writes.length,0)
  }
})
test('one busy, exhausted or delayed selection holds the complete batch; no expired lease recycling',async()=>{
  for(const mutate of [s=>s.outboxes[2].status='processing',s=>s.outboxes[2].status='dead',
    s=>s.outboxes[2].ready=false,s=>s.outboxes[2].attempts=8]) {
    const h=harness(mutate),p=await h.api.previewExactEmailPublicationInPostgres(selected)
    await assert.rejects(h.api.claimExactEmailPublicationInPostgres(selected,p.digest),/unavailable or changed/)
    assert.equal(h.writes.length,0)
  }
})
test('selection must be bounded, unique, normalized and bound to one owner/workspace/pipeline/mailbox',async()=>{
  for(const change of [{messageIds:[]},{messageIds:['a1','a1']},{messageIds:['A1']},{messageIds:['invalid']},
    {messageIds:Array.from({length:26},(_,i)=>i.toString(16))},{pipelineId:'bad'},{workspaceId:'bad'},
    {ownerEmail:'Owner@example.test'},{connectionId:'../other'}]) {
    const h=harness();await assert.rejects(h.api.previewExactEmailPublicationInPostgres({...selected,...change}))
    assert.equal(h.calls.length,0)
  }
})

function routeHarness(options={}) {
  const calls=[]
  const actor={email:selected.ownerEmail,organizationId:selected.workspaceId,...options.actor}
  const session=options.noSession?null:{authenticatedUser:actor.email,effectiveUser:actor.email,impersonating:false,
    activeWorkspaceOrganizationId:actor.organizationId,...options.session}
  class ExactEmailPublicationHeld extends Error {}
  const api=load('app_src/app/api/crm/email-publication/route.ts',{
    'next/server':{NextResponse:{json:(body,init)=>({body,...init})}},
    '@/lib/browserSameOrigin':load('app_src/lib/browserSameOrigin.ts',{'./publicOriginRouting.mjs':publicOriginRouting}),
    '@/lib/publicUrl':{appPublicUrl:()=> 'https://app.example.test'},
    '@/lib/requestUser':{requestSession:async()=>session,requireRequestUser:async()=>actor},
    '@/lib/persistence/config':{isPostgresStorageEnabled:()=>options.postgres!==false},
    '@/lib/tenancy':{resolvePipelineSpaceAccess:async()=>({id:selected.pipelineId,ownerEmail:actor.email,
      workspaceOrganizationId:actor.organizationId,...options.pipeline})},
    '@/lib/persistence/crmExactEmailPublication':{ExactEmailPublicationHeld},
    '@/lib/crm/exactEmailPublication':{publishExactCrmEmails:async input=>{calls.push(input);if(options.error)throw options.error
      return {applied:input.apply,digest:'a'.repeat(64)}}},
  })
  async function request(body={pipelineId:selected.pipelineId,connectionId:selected.connectionId,messageIds:selected.messageIds},headers={}) {
    const req=new Request('https://app.example.test/api/crm/email-publication',{method:'POST',
      headers:{origin:'https://app.example.test','content-type':'application/json',...headers},
      body:typeof body==='string'?body:JSON.stringify(body)})
    req.nextUrl=new URL(req.url);return api.POST(req)
  }
  return {api,request,calls}
}
test('route is same-origin, authenticated non-impersonated pipeline-owner only',async()=>{
  for(const options of [{noSession:true},{session:{impersonating:true}},{session:{authenticatedUser:'another@example.test'}},
    {session:{activeWorkspaceOrganizationId:uuid(900)}},{pipeline:{ownerEmail:'another@example.test'}},
    {pipeline:{workspaceOrganizationId:uuid(900)}}]) {
    const h=routeHarness(options),r=await h.request();assert.ok([401,403].includes(r.status));assert.equal(h.calls.length,0)
  }
  const h=routeHarness();assert.equal((await h.request(undefined,{origin:'https://evil.example.test'})).status,403)
  assert.equal(h.calls.length,0);assert.equal(h.api.GET,undefined)
})
test('route requires exact identities and an apply digest, and rejects operator authority injection',async()=>{
  const command={pipelineId:selected.pipelineId,connectionId:selected.connectionId,messageIds:selected.messageIds}
  for(const change of [{apply:true},{apply:true,expectedDigest:'bad'},{expectedDigest:'a'.repeat(64)},
    {limit:3},{ownerEmail:'other@example.test'},{workspaceId:uuid(1)},{outboxIds:[uuid(41)]},{messageIds:[]}]) {
    const h=routeHarness();assert.equal((await h.request({...command,...change})).status,400);assert.equal(h.calls.length,0)
  }
  const h=routeHarness(),r=await h.request({...command,apply:true,expectedDigest:'a'.repeat(64)})
  assert.equal(r.status,200);assert.deepEqual(copy(h.calls[0]),{...selected,apply:true,expectedDigest:'a'.repeat(64)})
  assert.match(r.headers['Cache-Control'],/private.*no-store/)
})
test('route rejects oversized, invalid and foreign input before publication and suppresses private errors',async()=>{
  for(const [body,headers,status] of [['x'.repeat(8193),{},413],['{',{},400],['{}',{'content-type':'text/plain'},415],['[]',{},400]]) {
    const h=routeHarness();assert.equal((await h.request(body,headers)).status,status);assert.equal(h.calls.length,0)
  }
  const h=routeHarness({error:new Error('private native details')})
  const r=await h.request();assert.equal(r.status,500);assert.doesNotMatch(JSON.stringify(r),/private native details/)
})
test('executor invokes native coordinator only for exact returned items and never resume or generic fallback',async()=>{
  const calls=[],item={id:uuid(41)},preview={digest:'a'.repeat(64),pipelineId:selected.pipelineId,messages:[]}
  const api=load('app_src/lib/crm/exactEmailPublication.ts',{
    '../persistence/crmExactEmailPublication':{previewExactEmailPublicationInPostgres:async()=>preview,
      claimExactEmailPublicationInPostgres:async()=>({preview,items:[item],alreadyCompleted:2,maxAttempts:8})},
    '../persistence/crmNativeEmailPublication':{createPostgresNativeEmailWorkerPersistence:()=>({})},
    './suiteCrmClient':{createSuiteCrmNativeEmailPublicationClient:()=>({})},
    './nativeEmailPublicationWorker':{createNativeEmailPublicationWorker:()=>({
      resume:async()=>{throw new Error('Global resume must not be called')},
      process:async value=>{calls.push(value);return {handled:false}},
    })},
  })
  assert.equal((await api.publishExactCrmEmails(selected)).applied,false);assert.equal(calls.length,0)
  const result=await api.publishExactCrmEmails({...selected,apply:true,expectedDigest:preview.digest})
  assert.deepEqual(calls,[item]);assert.equal(result.succeeded,0);assert.equal(result.held,1)
  assert.equal(result.alreadyCompleted,2)
})
