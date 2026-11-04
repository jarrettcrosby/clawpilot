#!/usr/bin/env node
// Actual adapter/SQL, synthetic native receipts + audience/enqueue callbacks.
// No live DATABASE_URL, provider, application-actor or deployment proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'
assert.deepEqual(process.argv.slice(2),['--postgres'],'Explicit --postgres required')
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript'),{Pool}=require('pg')
function load(path,deps){const module={exports:{}};const source=readFileSync(new URL(`../${path}`,import.meta.url),'utf8')
  const code=ts.transpileModule(source,{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),`Unexpected dependency ${name}`);return deps[name]});return module.exports}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const storeApi=load('app_src/lib/crm/nativeEmailPublicationPostgres.ts',{'./nativeEmailPublication':protocol})
const work=load('app_src/lib/crm/nativeEmailPublicationWorkContext.ts',{'./nativeEmailPublication':protocol})
const transport=load('app_src/lib/crm/nativeEmailPublicationTransport.ts',{'./nativeEmailPublication':protocol})
const stable=load('app_src/lib/crm/stableId.ts',{'node:crypto':crypto})
const audienceApi=load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts',{'node:crypto':crypto})
const capabilityApi=load('app_src/lib/crm/nativeEmailCapabilityContract.ts',{'node:crypto':crypto,'./nativeEmailPublication':protocol})
const authorityApi=load('app_src/lib/crm/nativeEmailAuthorityTransition.ts',{'./nativeEmailPublication':protocol,
  './suiteCrmNativeEmailProjection':audienceApi,'./nativeEmailCapabilityContract':capabilityApi})
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex')
const clone=value=>JSON.parse(JSON.stringify(value))
const held=code=>error=>error?.name==='NativeEmailPublicationHeld'&&(!code||error.code===code)
const checks=[]
async function check(name,run){await run();checks.push(name);console.log(`PASS ${name}`)}
const container=`clawpilot-native-worker-${process.pid}-${crypto.randomUUID().slice(0,8)}`
const image=process.env.CLAWPILOT_TEST_POSTGRES_IMAGE||'pgvector/pgvector:pg16'
assert.match(image,/^pgvector\/pgvector:pg(?:16|18)$/u,'Use an already cached approved image')
let pool,started=false
try {
  execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
    '-e','POSTGRES_PASSWORD=native_worker_fixture','-e','POSTGRES_DB=native_worker_fixture','-p','127.0.0.1::5432',image]),{timeout:60000,stdio:'pipe'});started=true
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1];assert.ok(port)
  pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'native_worker_fixture',database:'native_worker_fixture',ssl:false,
    max:3,connectionTimeoutMillis:1000,statement_timeout:5000})
  const deadline=Date.now()+30000
  while(true){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>=deadline)throw error;await new Promise(r=>setTimeout(r,100))}}
  assert.equal((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count,'0')
  const query=(sql,values)=>pool.query(sql,values),activeTransactions=new Set()
  const withTransaction=async callback=>{const tx=await pool.connect()
    try{await tx.query('BEGIN');activeTransactions.add(tx);const result=await callback(tx);await tx.query('COMMIT');return result}
    catch(error){await tx.query('ROLLBACK');throw error}finally{activeTransactions.delete(tx);tx.release()}}
  await query(`CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,organization_id uuid);
    CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean NOT NULL DEFAULT false);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean DEFAULT false,
      crm_last_synced_at timestamptz,updated_at timestamptz DEFAULT now(),sync_enabled boolean DEFAULT true,sheet_id text);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,shared_by text,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,PRIMARY KEY(user_email,organization_id));
    CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,suitecrm_module text,
      source_hash text,source_key text,source_payload jsonb DEFAULT '{}',metadata jsonb DEFAULT '{}',sync_status text DEFAULT 'pending',
      sync_error text,suitecrm_synced_at timestamptz,updated_at timestamptz DEFAULT now());
    CREATE TABLE sync_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),aggregate_type text,aggregate_id text,operation text,target_system text,
      payload jsonb,status text DEFAULT 'queued',attempts integer DEFAULT 0,idempotency_key text,lock_token text,locked_at timestamptz,
      last_error text,available_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now(),processed_at timestamptz,updated_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX fixture_outbox_idempotency ON sync_outbox(target_system,idempotency_key) WHERE idempotency_key IS NOT NULL;
    INSERT INTO pipeline_spaces(id,owner_email,workspace_organization_id,sheet_id) VALUES('${id(2)}','owner@example.test','${id(1)}','fixture-sheet'),
      ('${id(12)}','owner@example.test','${id(1)}','fixture-v2-sheet');`)
  for(const name of ['0375_crm_native_email_publication_admission.sql','0376_crm_native_email_publication_work_context.sql',
    '0377_crm_native_email_authority_transitions.sql','0378_crm_native_email_capability_policies.sql',
    '0379_crm_native_email_app_only_lifecycle.sql','0380_crm_native_email_grant_attempts.sql',
    '0381_crm_native_email_identity_quiescence.sql'])
    await withTransaction(tx=>tx.query(readFileSync(new URL(`../db/migrations/${name}`,import.meta.url),'utf8')))
  const audience={policy:'pipeline-internal',ownerSuiteCrmId:'admin',allowedSuiteCrmUserIds:['admin','reader'],workspaceId:id(1),pipelineId:id(2),fingerprint:''}
  audience.fingerprint=audienceApi.suiteCrmEmailAudienceFingerprint(audience)
  const v2Audience={...audience,pipelineId:id(12),fingerprint:''};v2Audience.fingerprint=audienceApi.suiteCrmEmailAudienceFingerprint(v2Audience)
  const audiences=new Map([[id(2),audience],[id(12),v2Audience]])
  const capabilityPolicy={version:2,pipelineId:id(12),workspaceId:id(1),ownerSuiteCrmId:'admin',audienceFingerprint:v2Audience.fingerprint,
    principalSuiteCrmUserIds:['admin','denied','reader'],futureCreate:{view:['admin','reader'],list:['admin','reader'],export:['admin','reader'],
      edit:['admin','reader'],delete:['admin','reader']},historical:[]}
  const capabilityFingerprint=capabilityApi.prepareNativeEmailCapabilityContract(capabilityPolicy,{
    binding:{pipelineId:id(12),workspaceId:id(1),ownerSuiteCrmId:'admin',audienceFingerprint:v2Audience.fingerprint,allowedReaderSuiteCrmUserIds:['admin','reader']},
    livePrincipalSuiteCrmUserIds:capabilityPolicy.principalSuiteCrmUserIds,approvedFutureCreate:capabilityPolicy.futureCreate,liveHistorical:[],
  }).futurePolicyFingerprint
  await check('trusted v2 policy is empty by default and only exact disabled-generation install is allowed',async()=>{
    assert.equal((await query('SELECT count(*) AS n FROM crm_native_email_capability_policies')).rows[0].n,'0')
    await assert.rejects(()=>query('INSERT INTO crm_native_email_capability_policies VALUES($1,999,$2::jsonb,$3)',[id(12),JSON.stringify(capabilityPolicy),capabilityFingerprint]),/generation differs/)
    await query('INSERT INTO crm_native_email_capability_policies VALUES($1,1,$2::jsonb,$3)',[id(12),JSON.stringify(capabilityPolicy),capabilityFingerprint])
    assert.equal((await query('SELECT verified_generation FROM crm_native_email_publication_control')).rows[0].verified_generation,null)
  })
  let failEnqueue=false
  const adapterApi=load('app_src/lib/persistence/crmNativeEmailPublication.ts',{
    './postgres':{query,withTransaction},
    './crm':{reviewedEmailAudienceUnderNativeControlWithClient:async(tx,pipelineId)=>{
      assert.ok(activeTransactions.has(tx));assert.ok(audiences.has(pipelineId));return clone(audiences.get(pipelineId))}},
    './pipeline':{enqueuePipelineSyncOutboxWithClient:async(tx,input)=>{
      assert.ok(activeTransactions.has(tx),'Durable intent must share settlement transaction')
      assert.equal(input.operation,'project_crm_workbook');assert.equal(input.payload.waitForCrmReadiness,true)
      const result=await tx.query(`INSERT INTO sync_outbox(aggregate_type,aggregate_id,operation,target_system,payload,idempotency_key)
        VALUES($1,$2,$3,'google_sheets',$4::jsonb,$5) ON CONFLICT(target_system,idempotency_key) WHERE idempotency_key IS NOT NULL
        DO UPDATE SET updated_at=sync_outbox.updated_at RETURNING id,status`,
      [input.aggregateType,input.aggregateId,input.operation,JSON.stringify({...input.payload,pipelineId:input.pipelineId,sheetId:input.sheetId}),`pipeline:${input.pipelineId}:${input.idempotencyKey}`])
      if(failEnqueue)throw Error('synthetic pipeline enqueue failure')
      return result.rows[0]
    }},
    '../crm/stableId':stable,'../crm/nativeEmailPublication':protocol,'../crm/nativeEmailPublicationPostgres':storeApi,
    '../crm/nativeEmailPublicationWorkContext':work,'../crm/nativeEmailPublicationTransport':transport,
    '../crm/nativeEmailCapabilityContract':capabilityApi,
    '../crm/nativeEmailAuthorityTransition':authorityApi,
  })
  const adapter=adapterApi.createPostgresNativeEmailWorkerPersistence({maxAttempts:8})
  const store=new storeApi.PostgresNativeEmailPublicationStore(withTransaction),owner=id(500)
  const control=async()=>(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  const stored=async item=>(await query('SELECT * FROM crm_interactions WHERE id=$1',[item.aggregateId])).rows[0]
  const outbox=async item=>(await query('SELECT * FROM sync_outbox WHERE id=$1',[item.id])).rows[0]
  let sequence=10
  async function enqueue(interaction,revision,attempt=1){
    sequence++
    const sourceHash=hash(`source-${interaction.number}-${revision}`)
    const attributes={global_id_c:interaction.globalId,name:`Synthetic ${revision}`,date_sent_received:'2026-10-30 13:00:00',
      type:'archived',status:'read',parent_type:'',parent_id:'',assigned_user_id:'admin',description:'Synthetic plain body',description_html:''}
    const pipelineId=interaction.pipelineId??id(2)
    const payload={entity:'interactions',pipelineId,localId:interaction.localId,suiteCrmId:interaction.nativeId,suiteCrmModule:'Emails',
      attributes,emailProjection:{version:1,accounts:[],contacts:[],contactAccounts:[],previousManaged:{accounts:[],contacts:[]},audience:clone(audiences.get(pipelineId))}}
    await query("UPDATE crm_interactions SET source_hash=$2,sync_status='pending' WHERE id=$1",[interaction.localId,sourceHash])
    const item={id:id(1000+sequence),aggregateType:'crm_interactions',aggregateId:interaction.localId,operation:'upsert_record',
      idempotencyKey:`crm:interactions:v4:${interaction.localId}:Emails:${sourceHash}`,attempts:attempt,lockToken:id(2000+sequence),payload}
    await query(`INSERT INTO sync_outbox(id,aggregate_type,aggregate_id,operation,target_system,payload,status,attempts,idempotency_key,lock_token,locked_at)
      VALUES($1,$2,$3,$4,'suitecrm',$5::jsonb,'processing',$6,$7,$8,now())`,
    [item.id,item.aggregateType,item.aggregateId,item.operation,JSON.stringify(payload),attempt,item.idempotencyKey,item.lockToken])
    item.payload=(await outbox(item)).payload // same JSONB shape as actual claim
    return item
  }
  async function seed(number,attempt=1,pipelineId=id(2)){
    const interaction={number,pipelineId,localId:id(100+number),nativeId:id(200+number),globalId:`gi${String(number).padStart(7,'0')}`}
    await query(`INSERT INTO crm_interactions(id,pipeline_id,suitecrm_id,reference_code,suitecrm_module,source_hash,source_key)
      VALUES($1,$2,$3,$4,'Emails',$5,$6)`,[interaction.localId,pipelineId,interaction.nativeId,interaction.globalId,hash('initial'),`fixture:${number}`])
    return {interaction,item:await enqueue(interaction,'initial',attempt)}
  }
  function nativeReceipt(request,cancelled=false){
    const c=request.command,p=c.projection,source=p.attributes,recordFingerprint=hash(`native-${c.operationId}`)
    const projection={version:2,suiteCrmId:c.suiteCrmId,sourceAttributes:clone(source),attributes:{...source,created_by:'admin',deleted:'0',
      description_html:'<p>Synthetic plain body</p>',from_addr_name:'',to_addrs_names:'',cc_addrs_names:'',bcc_addrs_names:'',reply_to_addrs_names:''},
      accounts:clone(p.accounts),contacts:clone(p.contacts),contactAccounts:clone(p.contactAccounts),snapshotFingerprint:recordFingerprint,
      dateSentReceivedUtc:'2026-10-30T13:00:00Z'}
    return {version:c.version,operationId:c.operationId,commandHash:request.commandHash,replayed:false,state:cancelled?'cancelled':'committed',
      result:cancelled?null:{version:c.version,...(c.version===2?{capabilityPolicyFingerprint:c.capabilityPolicyFingerprint,
        principalSuiteCrmUserIds:clone(c.principalSuiteCrmUserIds),expectedCapabilities:clone(c.expectedCapabilities)}:{}),
        mode:'publish',suiteCrmId:c.suiteCrmId,globalId:c.globalId,pipelineId:c.pipelineId,generation:c.generation,
        audienceFingerprint:c.audienceFingerprint,recordFingerprint,readerSuiteCrmUserIds:clone(request.allowedReaderSuiteCrmUserIds),projection}}
  }
  async function admit(item){const candidate=await adapter.candidate(item),a=await adapter.admit(item,candidate,owner)
    assert.equal(await adapter.markDispatched(a.admission.request,a.lease),true);return {...a,request:a.admission.request}}
  await check('actual adapter is disabled until synthetic fixture policy activation',async()=>{
    assert.deepEqual(await adapter.mode(),{enabled:false,activeOperationId:null,activeTransitionId:null})
    const {item}=await seed(1)
    await assert.rejects(()=>adapter.candidate(item),held('native_publication_not_available'))
    await query('UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,native_policy_fingerprint=$1,activation_receipt_hash=$2',
      [hash('policy'),hash('synthetic-activation')])
  })
  await check('exact-current commit stores actual v2 projection and durable workbook intent atomically',async()=>{
    const {item}=await seed(2),a=await admit(item),receipt=nativeReceipt(a.request),result=await adapter.settle(a.request,a.lease,receipt)
    assert.equal(result.synchronized,true);assert.equal(result.projectionQueued,true)
    const row=await stored(item);assert.equal(row.sync_status,'synced');assert.ok(row.suitecrm_synced_at)
    assert.equal(row.metadata.suiteCrmEmailProjection.version,2);assert.equal(row.metadata.suiteCrmEmailProjection.operationId,a.request.command.operationId)
    assert.equal(row.metadata.suiteCrmEmailProjection.attributes.description_html,'<p>Synthetic plain body</p>')
    assert.equal((await outbox(item)).status,'succeeded');assert.equal((await control()).active_operation_id,null)
    assert.equal((await query("SELECT count(*) AS n FROM sync_outbox WHERE target_system='google_sheets' AND payload->>'nativeEmailPublicationOperationId'=$1",[a.request.command.operationId])).rows[0].n,'1')
    const replay=await adapter.settle(a.request,a.lease,{...receipt,replayed:true});assert.equal(replay.synchronized,false);assert.equal(replay.projectionQueued,undefined)
  })
  await check('superseded commit retains next CAS baseline without marking the newer source synced',async()=>{
    const {item,interaction}=await seed(3),a=await admit(item),receipt=nativeReceipt(a.request),next=await enqueue(interaction,'newer')
    assert.equal((await adapter.settle(a.request,a.lease,receipt)).synchronized,false)
    assert.equal((await stored(item)).sync_status,'pending');assert.deepEqual((await stored(item)).metadata,{})
    assert.equal((await outbox(item)).status,'succeeded');assert.match((await outbox(item)).last_error,/superseded/)
    assert.equal((await adapter.candidate(next)).request.command.expectedRecordFingerprint,receipt.result.recordFingerprint)
    assert.deepEqual((await store.get(a.request.command.operationId)).receipt,receipt)
  })
  await check('unknown outcome resists ordinary hold and resolves despite expired original outbox claim',async()=>{
    const {item}=await seed(4),a=await admit(item);await adapter.markUnknown(a.request.command.operationId)
    await query("UPDATE sync_outbox SET locked_at=now()-interval '1 hour',lock_token=$2 WHERE id=$1",[item.id,id(900)])
    const before=await outbox(item);await adapter.hold(item,'native_outcome_unknown',8)
    assert.deepEqual(await outbox(item),before);assert.equal((await control()).active_operation_id,a.request.command.operationId)
    // Original claim expired; work lease remains owned. Actual work-lease expiry
    // and takeover are covered in the separate guarded work-context acceptance.
    const recovery=await adapter.claimResolution(a.request.command.operationId,owner)
    await adapter.settle(recovery.admission.request,recovery.lease,nativeReceipt(a.request,true))
    assert.equal((await outbox(item)).status,'failed');assert.equal((await stored(item)).sync_status,'pending')
    await query("UPDATE sync_outbox SET status='processing',attempts=attempts+1,locked_at=now(),lock_token=$2 WHERE id=$1",[item.id,id(901)])
    const retry={...item,attempts:2,lockToken:id(901)},candidate=await adapter.candidate(retry)
    assert.notEqual(candidate.request.command.operationId,a.request.command.operationId);assert.equal(candidate.request.command.expectedRecordFingerprint,null)
    const b=await adapter.admit(retry,candidate,owner);await adapter.markDispatched(b.admission.request,b.lease)
    await adapter.settle(b.admission.request,b.lease,nativeReceipt(b.admission.request));assert.equal((await outbox(item)).status,'succeeded')
  })
  await check('cancellation at current retry budget is dead rather than unclaimable failed',async()=>{
    const {item}=await seed(5,8),a=await admit(item);await adapter.settle(a.request,a.lease,nativeReceipt(a.request,true))
    assert.equal((await outbox(item)).status,'dead');assert.ok((await outbox(item)).processed_at)
    assert.equal((await stored(item)).sync_status,'failed');assert.equal((await control()).active_operation_id,null)
  })
  await check('historical v1 prior successful jobs and missing reviewed baselines hold without admission',async()=>{
    for(const number of [6,7,8,9]){
      const {item}=await seed(number)
      if(number===6)await query('UPDATE crm_interactions SET metadata=$2::jsonb WHERE id=$1',[item.aggregateId,JSON.stringify({suiteCrmEmailProjection:{version:1}})])
      if(number===7)await query('UPDATE crm_interactions SET suitecrm_synced_at=now() WHERE id=$1',[item.aggregateId])
      if(number===8)await query(`INSERT INTO sync_outbox(aggregate_type,aggregate_id,operation,target_system,payload,status)
        VALUES('crm_interactions',$1,'upsert_record','suitecrm',$2::jsonb,'succeeded')`,[item.aggregateId,JSON.stringify(item.payload)])
      if(number===9)await query("UPDATE crm_interactions SET source_key='suitecrm:imported' WHERE id=$1",[item.aggregateId])
      await assert.rejects(()=>adapter.candidate(item),held('native_historical_baseline_required'));assert.equal((await control()).active_operation_id,null)
    }
  })
  await check('dispatch and settlement reject stale work owner fence without changing admission',async()=>{
    const {item}=await seed(10),candidate=await adapter.candidate(item),a=await adapter.admit(item,candidate,owner),stale={...a.lease,fence:a.lease.fence+1}
    await assert.rejects(()=>adapter.markDispatched(a.admission.request,stale),held('work_lease_not_owned'))
    assert.equal((await store.get(candidate.request.command.operationId)).state,'admitted')
    await adapter.markDispatched(a.admission.request,a.lease)
    await assert.rejects(()=>adapter.settle(a.admission.request,stale,nativeReceipt(a.admission.request)),held('work_lease_not_owned'))
    assert.equal((await outbox(item)).status,'processing');await adapter.settle(a.admission.request,a.lease,nativeReceipt(a.admission.request))
  })
  await check('failed durable enqueue rolls back receipt metadata source status and outbox completion',async()=>{
    const {item}=await seed(11),a=await admit(item),receipt=nativeReceipt(a.request);failEnqueue=true
    await assert.rejects(()=>adapter.settle(a.request,a.lease,receipt),/synthetic pipeline enqueue failure/);failEnqueue=false
    assert.equal((await store.get(a.request.command.operationId)).state,'dispatched')
    assert.equal((await stored(item)).sync_status,'pending');assert.deepEqual((await stored(item)).metadata,{})
    assert.equal((await outbox(item)).status,'processing')
    assert.equal((await query("SELECT count(*) AS n FROM sync_outbox WHERE target_system='google_sheets' AND payload->>'nativeEmailPublicationOperationId'=$1",[a.request.command.operationId])).rows[0].n,'0')
    await adapter.settle(a.request,a.lease,receipt);assert.equal((await store.get(a.request.command.operationId)).state,'committed')
  })
  await check('enabled v2 policy cannot mutate disappear downgrade or enter old v1 authority transition',async()=>{
    for(const sql of ['DELETE FROM crm_native_email_capability_policies','TRUNCATE crm_native_email_capability_policies',
      "UPDATE crm_native_email_capability_policies SET policy=jsonb_set(policy,'{version}','1')",
      'UPDATE crm_native_email_capability_policies SET generation=generation+1'])
      await assert.rejects(()=>query(sql),/require disabled publication/)
    await assert.rejects(()=>query('UPDATE crm_native_email_publication_control SET active_transition_id=$1',[hash('unapproved-transition')]),/capability transition version|does not match current authority/)
    assert.equal((await control()).active_transition_id,null)
  })
  await check('v2 create uses reviewed editor policy and rejects SQL NULL missing pins wrong versions before truthful commit',async()=>{
    const {item,interaction}=await seed(20,1,id(12)),a=await admit(item),receipt=nativeReceipt(a.request)
    assert.equal(a.request.command.version,2);assert.equal(a.request.command.capabilityPolicyFingerprint,capabilityFingerprint)
    assert.deepEqual(a.request.command.expectedCapabilities.edit,['admin','reader'])
    assert.deepEqual(a.request.command.principalSuiteCrmUserIds,['admin','denied','reader'])
    const malformed=[]
    const missing=clone(receipt);delete missing.result.expectedCapabilities;malformed.push(missing)
    const nullPin=clone(receipt);nullPin.result.capabilityPolicyFingerprint=null;malformed.push(nullPin)
    const wrongVersion=clone(receipt);wrongVersion.version=1;malformed.push(wrongVersion)
    const wrongResultVersion=clone(receipt);wrongResultVersion.result.version=1;malformed.push(wrongResultVersion)
    const narrowed=clone(receipt);narrowed.result.expectedCapabilities.edit=['admin'];malformed.push(narrowed)
    for(const value of malformed){
      await assert.rejects(()=>query("UPDATE crm_native_email_publication_admissions SET state='committed',native_receipt=$2::jsonb WHERE operation_id=$1",
        [a.request.command.operationId,JSON.stringify(value)]),/crm_native_email_versioned_receipt/)
      assert.equal((await store.get(a.request.command.operationId)).state,'dispatched')
    }
    await adapter.settle(a.request,a.lease,receipt)
    const metadata=(await stored(item)).metadata.suiteCrmEmailProjection
    assert.equal(metadata.capabilityPolicyFingerprint,capabilityFingerprint);assert.deepEqual(metadata.expectedCapabilities,capabilityPolicy.futureCreate)
    const next=await enqueue(interaction,'v2-update'),updated=await admit(next)
    assert.equal(updated.request.command.expectedRecordFingerprint,receipt.result.recordFingerprint)
    assert.deepEqual(updated.request.command.expectedCapabilities,receipt.result.expectedCapabilities)
    await adapter.settle(updated.request,updated.lease,nativeReceipt(updated.request))
  })
  async function insertSyntheticHistoricalReceipt(request){
    // Explicit synthetic reviewed-history fixture, NOT a production installer.
    // This exercises retained immutable command/receipt readback in the adapter.
    const c=request.command,value=nativeReceipt(request)
    await query(`INSERT INTO crm_native_email_publication_admissions(operation_id,pipeline_id,local_id,native_id,global_id,generation,
      native_policy_fingerprint,command_hash,audience_fingerprint,command,allowed_reader_ids,request_fingerprint,state,native_receipt)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,'committed',$13::jsonb)`,
    [c.operationId,c.pipelineId,c.localId,c.suiteCrmId,c.globalId,c.generation,request.nativePolicyFingerprint,request.commandHash,c.audienceFingerprint,
      JSON.stringify(c),JSON.stringify(request.allowedReaderSuiteCrmUserIds),request.requestFingerprint,JSON.stringify(value)])
    return value
  }
  await check('existing v2 historical writes are preserved per receipt rather than widened to future-create policy',async()=>{
    const {item}=await seed(21,1,id(12)),fresh=await adapter.candidate(item)
    const request=protocol.prepareNativeEmailPublication({command:{...fresh.request.command,operationId:hash('reviewed-historical-v2'),
      expectedCapabilities:{...fresh.request.command.expectedCapabilities,edit:['admin'],delete:['admin']}},
      nativePolicyFingerprint:fresh.request.nativePolicyFingerprint,allowedReaderSuiteCrmUserIds:fresh.request.allowedReaderSuiteCrmUserIds})
    const prior=await insertSyntheticHistoricalReceipt(request),candidate=await adapter.candidate(item)
    assert.deepEqual(candidate.request.command.expectedCapabilities.edit,['admin'])
    assert.equal(candidate.request.command.expectedRecordFingerprint,prior.result.recordFingerprint)
    const a=await adapter.admit(item,candidate,owner);await adapter.markDispatched(a.admission.request,a.lease)
    await adapter.settle(a.admission.request,a.lease,nativeReceipt(a.admission.request))
  })
  await check('v1 historical receipt cannot be guessed into v2; no v2 policy is inferred for ordinary v1 pipeline',async()=>{
    const {item}=await seed(22,1,id(12)),fresh=await adapter.candidate(item)
    const {capabilityPolicyFingerprint,principalSuiteCrmUserIds,expectedCapabilities,...fields}=fresh.request.command
    const legacy=protocol.prepareNativeEmailPublication({command:{...fields,version:1,operationId:hash('reviewed-historical-v1')},
      nativePolicyFingerprint:fresh.request.nativePolicyFingerprint,allowedReaderSuiteCrmUserIds:fresh.request.allowedReaderSuiteCrmUserIds})
    await insertSyntheticHistoricalReceipt(legacy)
    await assert.rejects(()=>adapter.candidate(item),held('native_v2_historical_capabilities_required'))
    assert.equal((await control()).active_operation_id,null)
    assert.equal((await adapter.candidate((await seed(23)).item)).request.command.version,1)
  })
  await check('v2 unknown cancellation keeps its version and rejects mixed-version SQL tombstone',async()=>{
    const {item}=await seed(24,1,id(12)),a=await admit(item),cancelled=nativeReceipt(a.request,true)
    await adapter.markUnknown(a.request.command.operationId)
    await assert.rejects(()=>query("UPDATE crm_native_email_publication_admissions SET state='cancelled',native_receipt=$2::jsonb WHERE operation_id=$1",
      [a.request.command.operationId,JSON.stringify({...cancelled,version:1})]),/crm_native_email_versioned_receipt/)
    const resolution=await adapter.claimResolution(a.request.command.operationId,owner)
    await adapter.settle(resolution.admission.request,resolution.lease,cancelled)
    assert.equal((await store.get(a.request.command.operationId)).receipt.version,2)
    assert.equal((await outbox(item)).status,'failed');assert.equal((await control()).active_operation_id,null)
  })
  console.log(`PASS ${checks.length} real adapter/PostgreSQL groups; synthetic receipts/audience/enqueue, no native/application-authorization/deployment proof`)
}finally{
  try{if(pool)await pool.end()}
  finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{timeout:30000,stdio:'pipe'})}
}
