#!/usr/bin/env node
// Actual adapter/SQL, synthetic native receipts + audience/enqueue callbacks.
// No live DATABASE_URL, provider, application-actor or deployment proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as util from 'node:util'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'
const args=process.argv.slice(2)
assert.ok(args.length===1&&/^--postgres(?:=(?:16|18))?$/u.test(args[0]),'Explicit --postgres or --postgres=16|18 required')
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript'),{Pool}=require('pg')
function load(path,deps){const module={exports:{}};const source=readFileSync(new URL(`../${path}`,import.meta.url),'utf8')
  const code=ts.transpileModule(source,{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),`Unexpected dependency ${name}`);return deps[name]});return module.exports}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const storeApi=load('app_src/lib/crm/nativeEmailPublicationPostgres.ts',{'./nativeEmailPublication':protocol})
const work=load('app_src/lib/crm/nativeEmailPublicationWorkContext.ts',{'./nativeEmailPublication':protocol})
const transport=load('app_src/lib/crm/nativeEmailPublicationTransport.ts',{'./nativeEmailPublication':protocol})
const releaseApproval=load('app_src/lib/crm/legacyEmailRecoveryReleaseApproval.ts',{'server-only':{},'node:crypto':crypto,
  'node:util':util,'./nativeEmailPublication':protocol})
const dispatchPermit=load('app_src/lib/crm/nativeEmailRecoveryDispatchPermit.ts',{'server-only':{},'node:crypto':crypto,
  'node:util':util,'./nativeEmailPublication':protocol})
const maintenanceOperator=load('app_src/lib/crm/nativeEmailRecoveryMaintenanceOperator.ts',{'server-only':{},
  './nativeEmailPublication':protocol,'./nativeEmailPublicationTransport':transport})
const worker=load('app_src/lib/crm/nativeEmailPublicationWorker.ts',{'node:crypto':crypto,'./nativeEmailPublication':protocol})
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
const explicitMajor=args[0].split('=')[1]
const image=explicitMajor?`pgvector/pgvector:pg${explicitMajor}`:process.env.CLAWPILOT_TEST_POSTGRES_IMAGE||'pgvector/pgvector:pg16'
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
  await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,organization_id uuid);
    CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean NOT NULL DEFAULT false);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean DEFAULT false,
      crm_last_synced_at timestamptz,updated_at timestamptz DEFAULT now(),sync_enabled boolean DEFAULT true,sheet_id text);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,shared_by text,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,PRIMARY KEY(user_email,organization_id));
    CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,suitecrm_module text,
      source_hash text,source_key text,source_payload jsonb DEFAULT '{}',metadata jsonb DEFAULT '{}',sync_status text DEFAULT 'pending',
      sync_error text,suitecrm_synced_at timestamptz,updated_at timestamptz DEFAULT now(),organization_id uuid,contact_id uuid,
      provider_message_id text);
    CREATE TABLE crm_organizations(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,name text,source_payload jsonb DEFAULT '{}');
    CREATE TABLE crm_contacts(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,organization_id uuid,full_name text,source_payload jsonb DEFAULT '{}');
    CREATE TABLE crm_interaction_organizations(pipeline_id uuid,interaction_id uuid,organization_id uuid,is_primary boolean DEFAULT false,
      sort_order integer DEFAULT 0,PRIMARY KEY(interaction_id,organization_id));
    CREATE UNIQUE INDEX fixture_interaction_one_primary ON crm_interaction_organizations(interaction_id) WHERE is_primary;
    CREATE TABLE crm_interaction_contacts(pipeline_id uuid,interaction_id uuid,contact_id uuid,is_primary boolean DEFAULT false,
      sort_order integer DEFAULT 0,PRIMARY KEY(interaction_id,contact_id));
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
  // This small worker schema has no full initial-enrollment inventory. Mirror
  // its control barrier here; the joined fixture applies migration 0398 itself.
  await query(`ALTER TABLE crm_native_email_publication_control ADD COLUMN active_initial_enrollment_id text
    CHECK(active_initial_enrollment_id IS NULL OR (NOT enabled AND active_operation_id IS NULL AND active_transition_id IS NULL))`)
  // Mirror the four actual 0398 statement fences used by the 0408 guards;
  // the joined full-schema fixture exercises the real enrollment migration.
  await query(`CREATE FUNCTION clawpilot_crm_native_initial_source_fence() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE active text;
    BEGIN
      SELECT active_initial_enrollment_id INTO active FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Native initial control missing' USING ERRCODE='55000'; END IF;
      IF active IS NOT NULL THEN RAISE EXCEPTION 'Native initial enrollment pins all reviewed sources and writers' USING ERRCODE='55000'; END IF;
      RETURN NULL;
    END $$;
    DO $$ DECLARE t text; BEGIN
      FOREACH t IN ARRAY ARRAY['crm_interactions','crm_organizations','crm_contacts','crm_interaction_organizations'] LOOP
        EXECUTE format('CREATE TRIGGER crm_native_initial_source_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.clawpilot_crm_native_initial_source_fence()',t);
      END LOOP;
    END $$`)
  // The worker fixture synthesizes parked jobs rather than running 0406/0407.
  // Mirror just the consumed archive scope used by 0408's identity probe.
  await query(`CREATE SCHEMA crm_legacy_email_retirement;
    CREATE TABLE crm_legacy_email_retirement.retained(batch uuid PRIMARY KEY,local_id uuid,pipeline_id uuid,historical_provider_outcome text);
    CREATE TABLE crm_legacy_email_retirement.consumed(batch uuid PRIMARY KEY)`)
  for (const name of ['0404_crm_legacy_email_recovery_holds.sql','0405_crm_legacy_email_recovery_settlement.sql',
    '0408_crm_legacy_email_recovery_relationship_fence.sql'])
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
    '../crm/nativeEmailAuthorityTransition':authorityApi,'../crm/legacyEmailRecoveryReleaseApproval':releaseApproval,
    '../crm/nativeEmailRecoveryDispatchPermit':dispatchPermit,
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
  const signing=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
  function signPrivateProof(proof,nowSeconds) {
    const signature=crypto.sign('sha256',Buffer.from(protocol.nativeEmailCanonicalJson(proof),'ascii'),signing.privateKey).toString('base64')
    return releaseApproval.verifyLegacyEmailRecoveryReleaseApproval({envelope:{proof,signature},
      operatorAnchor:{keyId:'fixture-operator',key:signing.publicKey},nowSeconds})
  }
  async function seedPrivateRelationships(tx,interaction,archivedPayload) {
    const {number,pipelineId,localId}=interaction
    const [primary,related,unrelated]=[1,2,3].map(n=>({local:id(5000+number*10+n),native:id(6000+number*10+n)}))
    const [first,second,peer]=[1,2,3].map(n=>({local:id(7000+number*10+n),native:id(8000+number*10+n)}))
    for(const [i,account] of [primary,related,unrelated].entries()) {
      await tx.query('INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id,name) VALUES($1,$2,$3,$4)',
        [account.local,pipelineId,account.native,`Fixture account ${i}`])
    }
    for(const [i,contact] of [first,second,peer].entries()) {
      await tx.query('INSERT INTO crm_contacts(id,pipeline_id,suitecrm_id,organization_id,full_name) VALUES($1,$2,$3,$4,$5)',
        [contact.local,pipelineId,contact.native,[primary,related,unrelated][i].local,`Fixture contact ${i}`])
    }
    await tx.query('UPDATE crm_interactions SET organization_id=$2,contact_id=$3 WHERE id=$1',[localId,primary.local,first.local])
    await tx.query('INSERT INTO crm_interaction_organizations(pipeline_id,interaction_id,organization_id,is_primary) VALUES($1,$2,$3,true),($1,$2,$4,false)',
      [pipelineId,localId,primary.local,related.local])
    await tx.query('INSERT INTO crm_interaction_contacts(pipeline_id,interaction_id,contact_id) VALUES($1,$2,$3),($1,$2,$4)',[pipelineId,localId,first.local,second.local])
    const accounts=[primary.native,related.native],contacts=[first.native,second.native]
    const contactAccounts=[{contactId:first.native,accountId:primary.native},{contactId:second.native,accountId:related.native}]
    const relationships=[...accounts.map(relatedBeanId=>({linkFieldName:'accounts',relatedModuleName:'Accounts',relatedBeanId})),
      ...contacts.map(relatedBeanId=>({linkFieldName:'contacts',relatedModuleName:'Contacts',relatedBeanId}))]
    return {primary,related,unrelated,first,second,peer,payload:{...archivedPayload,
      attributes:{...archivedPayload.attributes,parent_type:'Accounts',parent_id:primary.native},relationships,
      emailProjection:{...archivedPayload.emailProjection,accounts,contacts,contactAccounts}}}
  }
  async function stagePrivate(number,clockOffset=0,withRelationships=false) {
    const {item:retired,interaction}=await seed(number,1,id(12))
    return withTransaction(async tx=>{
      await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
      await tx.query("UPDATE crm_interactions SET sync_status='failed' WHERE id=$1",[interaction.localId])
      const original=(await tx.query("DELETE FROM sync_outbox WHERE id=$1 RETURNING *",[retired.id])).rows[0]
      assert.equal(original.id,retired.id)
      await tx.query(`INSERT INTO crm_legacy_email_retirement.retained(batch,local_id,pipeline_id,historical_provider_outcome)
        VALUES($1,$2,$3,'unknown')`,[retired.id,interaction.localId,interaction.pipelineId])
      await tx.query('INSERT INTO crm_legacy_email_retirement.consumed(batch) VALUES($1)',[retired.id])
      const outboxId=id(3200+number),holdId=id(3300+number),lockToken=id(3400+number)
      const links=withRelationships?await seedPrivateRelationships(tx,interaction,original.payload):null
      const item={...retired,id:outboxId,lockToken}
      const persisted=await tx.query(`INSERT INTO sync_outbox(id,aggregate_type,aggregate_id,operation,target_system,payload,status,
        attempts,idempotency_key,lock_token,locked_at,available_at) VALUES($1,$2,$3,$4,'suitecrm',$5,'processing',1,$6,$7,now(),'infinity') RETURNING payload`,
      [outboxId,item.aggregateType,item.aggregateId,item.operation,links?.payload??item.payload,item.idempotencyKey,lockToken])
      item.payload=persisted.rows[0].payload
      const {request}=await adapterApi.previewPrivateLegacyEmailRecoveryCandidate(tx,item)
      const source=(await tx.query(`SELECT encode(digest(to_jsonb(i)::text,'sha256'),'hex') AS fingerprint
        FROM crm_interactions i WHERE id=$1`,[interaction.localId])).rows[0]
      const clock=Number((await tx.query('SELECT floor(extract(epoch FROM clock_timestamp())) AS second')).rows[0].second)
      const activationReceiptHash=(await tx.query('SELECT activation_receipt_hash FROM crm_native_email_publication_control')).rows[0].activation_receipt_hash
      const retirementReceiptHash=hash(`synthetic retired exact ${number}`)
      const proof={version:1,purpose:'clawpilot-private-legacy-email-release-v1',keyId:'fixture-operator',holdId,outboxId,
        retiredOutboxId:retired.id,localId:interaction.localId,nativeId:interaction.nativeId,globalId:interaction.globalId,
        pipelineId:interaction.pipelineId,workspaceId:id(1),sourceFingerprint:source.fingerprint,retirementReceiptHash,
        activationReceiptHash,requestFingerprint:request.requestFingerprint,nativeOperationId:request.command.operationId,
        issuedAt:clock+clockOffset,expiresAt:clock+clockOffset+120}
      const approval=signPrivateProof(proof,proof.issuedAt)
      await tx.query(`INSERT INTO crm_legacy_email_recovery_holds(outbox_id,retired_outbox_id,operation_id,local_id,pipeline_id,
        native_id,global_id,retirement_receipt_hash,release_intent_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [outboxId,retired.id,holdId,interaction.localId,interaction.pipelineId,interaction.nativeId,interaction.globalId,retirementReceiptHash,approval.intentHash])
      const selection={holdId,outboxId,nativeOperationId:request.command.operationId,requestFingerprint:request.requestFingerprint}
      const privateStore=adapterApi.createPrivateLegacyEmailRecoveryPersistence({selection,transaction:withTransaction,initialApproval:approval})
      return {item,request,privateStore,selection,original,approval,proof,links,interaction}
    })
  }
  await check('private held commit resolves its exact durable operation after response loss and never publishes twice',async()=>{
    const f=await stagePrivate(30),peer=(await seed(31)).item
    const peerBefore=await outbox(peer),sourceBefore=await stored(f.item),holdBefore=(await query(
      'SELECT * FROM crm_legacy_email_recovery_holds WHERE outbox_id=$1',[f.item.id])).rows[0]
    const bound=command=>assert.deepEqual(command,f.request.command)
    let receipt,publishes=0,resolves=0,holdCode
    const client={async prepare(command){bound(command);assert.equal(activeTransactions.size,0)},
      async publish(command){bound(command);assert.equal(activeTransactions.size,0);publishes++;receipt=nativeReceipt(f.request);throw Error('synthetic lost commit response')},
      async resolveOrCancel(command){bound(command);assert.equal(activeTransactions.size,0);resolves++;return {...receipt,replayed:true}}}
    const processor=worker.createNativeEmailPublicationWorker({...f.privateStore,async hold(...args){holdCode=args[1];await f.privateStore.hold(...args)}},client,owner)
    assert.deepEqual(await f.privateStore.loadItem(),f.item)
    await assert.rejects(()=>adapter.candidate(f.item),held('native_work_source_missing'))
    assert.deepEqual(await processor.process(f.item,8),{handled:true,status:'held'})
    assert.equal(holdCode,'native_outcome_unknown')
    assert.equal((await store.get(f.selection.nativeOperationId)).state,'unknown')
    assert.equal((await outbox(f.item)).status,'processing');assert.deepEqual(await stored(f.item),sourceBefore)
    await assert.rejects(()=>adapter.claimResolution(f.selection.nativeOperationId,owner),held('native_work_source_missing'))
    await assert.rejects(()=>store.settle(f.selection.nativeOperationId,receipt,async()=>{}),e=>e.code==='55000')
    assert.equal((await store.get(f.selection.nativeOperationId)).state,'unknown')
    await assert.rejects(()=>f.privateStore.claimResolution(hash('other'),owner),held('legacy_release_operation_changed'))
    const replay=adapterApi.createPrivateLegacyEmailRecoveryPersistence({selection:f.selection,transaction:withTransaction})
    await assert.rejects(()=>replay.loadItem(),held('native_publication_not_available'))
    assert.deepEqual(await worker.createNativeEmailPublicationWorker(replay,client,owner).resume(),{
      enabled:true,blocked:false,settled:{synchronized:true,pipelineId:f.request.command.pipelineId,outboxId:f.item.id}})
    assert.equal(publishes,1);assert.equal(resolves,1)
    assert.equal((await control()).active_operation_id,null)
    assert.equal((await store.get(f.selection.nativeOperationId)).receipt.result.recordFingerprint,receipt.result.recordFingerprint)
    const done=await outbox(f.item);assert.equal(done.status,'succeeded');assert.equal(done.available_at,Infinity)
    const source=await stored(f.item);assert.equal(source.sync_status,'synced')
    assert.equal(source.metadata.suiteCrmEmailProjection.operationId,f.selection.nativeOperationId)
    assert.deepEqual(await outbox(peer),peerBefore);assert.equal(await outbox({id:f.original.id}),undefined)
    assert.deepEqual((await query('SELECT * FROM crm_legacy_email_recovery_holds WHERE outbox_id=$1',[f.item.id])).rows[0],holdBefore)
    assert.equal((await processor.resume()).settled,undefined)
    assert.equal((await query("SELECT count(*) AS n FROM sync_outbox WHERE payload->>'triggerId'=$1",[f.item.id])).rows[0].n,'0')
    await assert.rejects(query('UPDATE sync_outbox SET available_at=now() WHERE id=$1',[f.item.id]),e=>e.code==='55000')
  })
  await check('private held cancellation is terminal, keeps infinity and does not rewrite original source',async()=>{
    const f=await stagePrivate(32),source=await stored(f.item)
    const c=await f.privateStore.candidate(f.item),a=await f.privateStore.admit(f.item,c,owner)
    assert.equal(await f.privateStore.markDispatched(a.admission.request,a.lease),true)
    const settled=await f.privateStore.settle(a.admission.request,a.lease,nativeReceipt(f.request,true))
    assert.equal(settled.synchronized,false)
    const row=await outbox(f.item);assert.equal(row.status,'dead');assert.equal(row.available_at,Infinity)
    assert.deepEqual(await stored(f.item),source)
    assert.equal((await store.get(f.selection.nativeOperationId)).state,'cancelled')
    assert.equal((await control()).active_operation_id,null)
  })
  await check('rollback after private settlement preserves the active pointer, source and outbox together',async()=>{
    const f=await stagePrivate(33),source=await stored(f.item),queue=await outbox(f.item)
    const c=await f.privateStore.candidate(f.item),a=await f.privateStore.admit(f.item,c,owner)
    assert.equal(await f.privateStore.markDispatched(a.admission.request,a.lease),true)
    const beforeCommit=new Error('synthetic rollback after SQL finalizer')
    const faulting=adapterApi.createPrivateLegacyEmailRecoveryPersistence({selection:f.selection,transaction:fn=>withTransaction(async tx=>{
      const result=await fn(tx)
      if(result?.state==='committed')throw beforeCommit
      return result
    })})
    const receipt=nativeReceipt(f.request)
    await assert.rejects(()=>faulting.settle(a.admission.request,a.lease,receipt),e=>e===beforeCommit)
    assert.equal((await control()).active_operation_id,f.selection.nativeOperationId)
    assert.equal((await store.get(f.selection.nativeOperationId)).state,'dispatched')
    assert.deepEqual(await stored(f.item),source);assert.deepEqual(await outbox(f.item),queue)
    assert.equal((await query('SELECT count(*) AS n FROM crm_legacy_email_recovery_settlements WHERE native_operation_id=$1',
      [f.selection.nativeOperationId])).rows[0].n,'0')
    assert.equal((await f.privateStore.settle(a.admission.request,a.lease,receipt)).synchronized,true)
  })
  await check('expired staging approval can be renewed for the identical held intent without rewriting the hold',async()=>{
    const f=await stagePrivate(34,-300)
    const savedHold=async()=> (await query('SELECT * FROM crm_legacy_email_recovery_holds WHERE outbox_id=$1',[f.item.id])).rows[0]
    const before=await savedHold()
    await assert.rejects(()=>f.privateStore.loadItem(),held('legacy_release_approval_expired'))
    assert.equal((await control()).active_operation_id,null)
    const now=Number((await query('SELECT floor(extract(epoch FROM clock_timestamp())) AS s')).rows[0].s)
    const proof={...f.proof,issuedAt:now,expiresAt:now+120}
    const privateWith=initialApproval=>adapterApi.createPrivateLegacyEmailRecoveryPersistence({selection:f.selection,transaction:withTransaction,initialApproval})
    await assert.rejects(()=>privateWith(signPrivateProof({...proof,retirementReceiptHash:hash('unreviewed archive')},now)).loadItem(),
      held('legacy_release_approval_preimage_changed'))
    const renewed=signPrivateProof(proof,now),next=privateWith(renewed)
    assert.equal(renewed.intentHash,f.approval.intentHash);assert.notEqual(renewed.approvalHash,f.approval.approvalHash)
    const item=await next.loadItem(),c=await next.candidate(item),a=await next.admit(item,c,owner)
    const row=(await query('SELECT intent_hash,approval_hash FROM crm_legacy_email_recovery_releases WHERE outbox_id=$1',[item.id])).rows[0]
    assert.deepEqual(row,{intent_hash:renewed.intentHash,approval_hash:renewed.approvalHash})
    assert.deepEqual(await savedHold(),before)
    const substitute=privateWith(signPrivateProof({...proof,expiresAt:now+119},now))
    await assert.rejects(()=>substitute.markDispatched(a.admission.request,a.lease),held('legacy_release_dispatch_approval_changed'))
    assert.equal((await store.get(f.selection.nativeOperationId)).state,'admitted')
    assert.equal(await next.markDispatched(a.admission.request,a.lease),true)
    assert.equal((await next.settle(a.admission.request,a.lease,nativeReceipt(f.request))).synchronized,true)
  })
  await check('reviewed two-company Email refuses live Account, Contact and link drift before admission',async()=>{
    const f=await stagePrivate(35,0,true),{primary,related,first,second,unrelated}=f.links
    const before=await stored(f.item),parked=await outbox(f.item)
    const expectedProjection={parentType:'Accounts',parentId:primary.native,accounts:[primary.native,related.native],contacts:[first.native,second.native],
      contactAccounts:[{contactId:first.native,accountId:primary.native},{contactId:second.native,accountId:related.native}]}
    const actual=(await query('SELECT public.clawpilot_crm_legacy_email_live_relationships($1,$2) AS projection',
      [f.interaction.localId,f.interaction.pipelineId])).rows[0].projection
    assert.deepEqual(actual,expectedProjection)
    assert.deepEqual(await f.privateStore.loadItem(),f.item)
    const denied=held('legacy_release_relationships_changed')
    const candidate=await f.privateStore.candidate(f.item)
    // Use the lower-level store and SQL registration without the adapter's
    // mapping check. The database must still refuse a stale exact command.
    const rawAdmission=transaction=>new storeApi.PostgresNativeEmailPublicationStore(transaction).admit({
      command:f.request.command,nativePolicyFingerprint:f.request.nativePolicyFingerprint,
      allowedReaderSuiteCrmUserIds:f.request.allowedReaderSuiteCrmUserIds},async(tx,request)=>{
      await work.registerNativeEmailPublicationWork(tx,request,candidate.context,owner,async()=>{})
      await tx.query('SELECT clawpilot_crm_legacy_email_register_release($1,$2,$3,$4,$5,$6,$7,$8)',[
        f.selection.holdId,f.item.id,f.selection.nativeOperationId,f.request.requestFingerprint,
        f.approval.activationReceiptHash,f.approval.intentHash,f.approval.approvalHash,f.approval.sourceFingerprint])
    })
    const repeatableRead=fn=>withTransaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');return fn(tx)})
    await assert.rejects(()=>rawAdmission(repeatableRead),e=>e.code==='55000'&&/requires READ COMMITTED/.test(e.message))
    const changePrimary='UPDATE crm_interaction_organizations SET is_primary=$3 WHERE interaction_id=$1 AND organization_id=$2'
    await query(changePrimary,[f.interaction.localId,primary.local,false])
    await assert.rejects(()=>f.privateStore.admit(f.item,candidate,owner),denied)
    await query(changePrimary,[f.interaction.localId,related.local,true])
    await assert.rejects(()=>rawAdmission(withTransaction),e=>e.code==='55000'&&/admission relationships changed/.test(e.message))
    await query(changePrimary,[f.interaction.localId,related.local,false])
    await query(changePrimary,[f.interaction.localId,primary.local,true])
    const accountMap='UPDATE crm_organizations SET suitecrm_id=$2 WHERE id=$1'
    await query(accountMap,[related.local,id(9991)])
    await assert.rejects(()=>f.privateStore.admit(f.item,candidate,owner),denied)
    await assert.rejects(()=>rawAdmission(withTransaction),e=>e.code==='55000'&&/admission relationships changed/.test(e.message))
    await query(accountMap,[related.local,related.native])
    await query('DELETE FROM crm_interaction_contacts WHERE interaction_id=$1 AND contact_id=$2',[f.interaction.localId,second.local])
    await assert.rejects(()=>f.privateStore.loadItem(),denied)
    await query('INSERT INTO crm_interaction_contacts(interaction_id,contact_id,pipeline_id) VALUES($1,$2,$3)',
      [f.interaction.localId,second.local,f.interaction.pipelineId])
    const contactOwner='UPDATE crm_contacts SET organization_id=$2 WHERE id=$1'
    let prepared=0,published=0,resolved=0,holdCode
    const client={async prepare(command){assert.deepEqual(command,f.request.command);assert.equal(activeTransactions.size,0);prepared++
      await query(contactOwner,[first.local,unrelated.local])},
      async publish(){published++;throw Error('drifted Email must not publish')},
      async resolveOrCancel(){resolved++;throw Error('unadmitted Email must not resolve')}}
    const processor=worker.createNativeEmailPublicationWorker({...f.privateStore,async hold(...args){holdCode=args[1];await f.privateStore.hold(...args)}},client,owner)
    assert.deepEqual(await processor.process(f.item,8),{handled:true,status:'held'})
    assert.deepEqual({prepared,published,resolved,holdCode},{prepared:1,published:0,resolved:0,holdCode:'legacy_release_relationships_changed'})
    assert.deepEqual(await stored(f.item),before,'Relationship drift did not touch the pinned interaction row')
    assert.deepEqual(await outbox(f.item),parked,'The held replacement must remain unchanged')
    assert.equal((await control()).active_operation_id,null)
    assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_publication_admissions WHERE operation_id=$1',
      [f.selection.nativeOperationId])).rows[0].n,0)
    assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_publication_work WHERE operation_id=$1',
      [f.selection.nativeOperationId])).rows[0].n,0)
    assert.equal((await query('SELECT count(*)::int AS n FROM crm_legacy_email_recovery_releases WHERE native_operation_id=$1',
      [f.selection.nativeOperationId])).rows[0].n,0)
    await query(contactOwner,[first.local,primary.local])
    assert.deepEqual((await f.privateStore.candidate(f.item)).request,f.request)
  })
  await check('admitted private Email fences related writes through unknown and releases them after exact settlement',async()=>{
    const f=await stagePrivate(36,0,true),{primary,related,first,second,peer,unrelated}=f.links
    const other=(await seed(37,1,id(12))).interaction
    await query(`CREATE ROLE fixture_relationship_writer NOLOGIN;
      GRANT SELECT, UPDATE(updated_at) ON crm_native_email_publication_control TO fixture_relationship_writer;
      GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON crm_organizations,crm_contacts,
        crm_interaction_organizations,crm_interaction_contacts TO fixture_relationship_writer`)
    const ordinary=(sql,args)=>withTransaction(async tx=>{
      await tx.query('SET LOCAL ROLE fixture_relationship_writer')
      return tx.query(sql,args)
    })
    assert.deepEqual((await ordinary(`SELECT has_table_privilege(current_user,'crm_legacy_email_recovery_holds','SELECT') AS hold,
      has_table_privilege(current_user,'crm_legacy_email_recovery_releases','SELECT') AS release`)).rows[0],{hold:false,release:false})
    const candidate=await f.privateStore.candidate(f.item)
    const stale=await pool.connect();let admission
    try {
      await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await stale.query('SET LOCAL ROLE fixture_relationship_writer')
      assert.equal((await stale.query('SELECT active_operation_id FROM crm_native_email_publication_control WHERE singleton')).rows[0].active_operation_id,null)
      admission=await f.privateStore.admit(f.item,candidate,owner)
      await assert.rejects(()=>stale.query('DELETE FROM crm_interaction_contacts WHERE interaction_id=$1 AND contact_id=$2',
        [f.interaction.localId,second.local]),e=>e.code==='40001')
    } finally { await stale.query('ROLLBACK');stale.release() }
    const request=admission.admission.request,lease=admission.lease
    assert.equal((await store.get(request.command.operationId)).state,'admitted')
    const reject=e=>e.code==='55000'
    const contactOwner='UPDATE crm_contacts SET organization_id=$2 WHERE id=$1'
    const contactDelete='DELETE FROM crm_interaction_contacts WHERE interaction_id=$1 AND contact_id=$2'
    const accountDelete='DELETE FROM crm_interaction_organizations WHERE interaction_id=$1 AND organization_id=$2'
    const contactAdd='INSERT INTO crm_interaction_contacts(interaction_id,contact_id,pipeline_id) VALUES($1,$2,$3)'
    const accountAdd='INSERT INTO crm_interaction_organizations(interaction_id,organization_id,pipeline_id) VALUES($1,$2,$3)'
    const assertWriteRejected=async(sql,args)=>assert.rejects(()=>ordinary(sql,args),reject)
    await assertWriteRejected(contactOwner,[first.local,related.local])
    await assertWriteRejected('UPDATE crm_contacts SET suitecrm_id=$2 WHERE id=$1',[second.local,id(9992)])
    await assertWriteRejected('UPDATE crm_organizations SET suitecrm_id=$2 WHERE id=$1',[primary.local,id(9993)])
    await assertWriteRejected('UPDATE crm_organizations SET suitecrm_id=$2 WHERE id=$1',[related.local,id(9994)])
    await assertWriteRejected(contactDelete,[f.interaction.localId,second.local])
    await assertWriteRejected(accountDelete,[f.interaction.localId,related.local])
    await assertWriteRejected(contactAdd,[f.interaction.localId,peer.local,f.interaction.pipelineId])
    await assertWriteRejected(accountAdd,[f.interaction.localId,unrelated.local,f.interaction.pipelineId])
    await assertWriteRejected('TRUNCATE crm_interaction_contacts',[])
    assert.equal((await ordinary(contactAdd,[other.localId,peer.local,other.pipelineId])).rowCount,1)
    assert.equal((await ordinary(accountAdd,[other.localId,unrelated.local,other.pipelineId])).rowCount,1)
    // OLD and NEW both matter: refuse moving an unrelated membership into the held Email.
    await assertWriteRejected('UPDATE crm_interaction_contacts SET interaction_id=$2 WHERE interaction_id=$1',[other.localId,f.interaction.localId])
    await assertWriteRejected('UPDATE crm_interaction_organizations SET interaction_id=$2 WHERE interaction_id=$1',[other.localId,f.interaction.localId])
    assert.equal((await ordinary('UPDATE crm_organizations SET name=$2 WHERE id=$1',[primary.local,'Renamed, mapping unchanged'])).rowCount,1)
    assert.equal((await ordinary('UPDATE crm_contacts SET full_name=$2 WHERE id=$1',[first.local,'Renamed Contact'])).rowCount,1)
    assert.equal((await ordinary('UPDATE crm_organizations SET suitecrm_id=$2 WHERE id=$1',[unrelated.local,id(9995)])).rowCount,1)
    assert.equal(await f.privateStore.markDispatched(request,lease),true)
    await f.privateStore.markUnknown(request.command.operationId)
    assert.equal((await store.get(request.command.operationId)).state,'unknown')
    await assertWriteRejected(contactDelete,[f.interaction.localId,second.local])
    await assertWriteRejected(accountDelete,[f.interaction.localId,related.local])
    const resolution=await f.privateStore.claimResolution(request.command.operationId,owner)
    const settled=await f.privateStore.settle(resolution.admission.request,resolution.lease,nativeReceipt(request))
    assert.equal(settled.synchronized,true);assert.equal((await control()).active_operation_id,null)
    assert.equal((await ordinary(contactDelete,[f.interaction.localId,second.local])).rowCount,1)
    assert.equal((await ordinary(accountDelete,[f.interaction.localId,related.local])).rowCount,1)
    assert.equal((await ordinary(contactOwner,[first.local,unrelated.local])).rowCount,1)
  })
  const dispatchKeys=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
  const targetFingerprint=hash('synthetic maintenance target'),fenceEpoch=id(9900),dispatchKeyId='fixture-dispatch'
  const dispatchSigner=dispatchPermit.createNativeEmailRecoveryDispatchSigner({keyId:dispatchKeyId,key:dispatchKeys.privateKey,targetFingerprint})
  const databaseSecond=async()=>Number((await query('SELECT floor(extract(epoch FROM clock_timestamp())) AS second')).rows[0].second)
  const fenceFor=async()=>({fenceEpoch,targetFingerprint,expiresAt:await databaseSecond()+75})
  const configured=(f,{initialApproval=f.approval,withVerifiedFence=async run=>run(await fenceFor())}={})=>
    adapterApi.createPrivateLegacyEmailRecoveryPersistence({selection:f.selection,transaction:withTransaction,
      ...(initialApproval===null?{}:{initialApproval}),
      maintenanceDispatch:{signer:dispatchSigner,withVerifiedFence}})
  const admissionState=async f=>(await query('SELECT state FROM crm_native_email_publication_admissions WHERE operation_id=$1',
    [f.selection.nativeOperationId])).rows[0]?.state
  async function assertDispatchRefused(privateStore,intent,code) {
    let nativeCalls=0
    await assert.rejects(()=>intent.action==='publish'
      ?privateStore.withMaintenancePublish(intent.request,intent.lease,async scope=>{await scope.authorize();nativeCalls++})
      :privateStore.withMaintenanceDispatch(intent,async()=>{nativeCalls++}),held(code))
    assert.equal(nativeCalls,0,'Refused maintenance action must not call its native transport')
  }
  async function assertSignedDispatch(f,action,scope,fence,lease=null) {
    assert.equal(activeTransactions.size,0,'Native transport must start only after its authorization transaction commits')
    assert.deepEqual(scope.request,f.request)
    const {proof,signature}=scope.permit
    assert.deepEqual(Object.keys(scope.permit).sort(),['proof','signature'])
    assert.deepEqual(proof,{version:1,purpose:'clawpilot-native-email-recovery-dispatch-v1',keyId:dispatchKeyId,action,
      operationId:f.request.command.operationId,requestFingerprint:f.request.requestFingerprint,commandHash:f.request.commandHash,
      approvalHash:f.approval.approvalHash,targetFingerprint,fenceEpoch,leaseOwner:lease?.owner??null,leaseFence:lease?.fence??null,
      issuedAt:proof.issuedAt,expiresAt:proof.expiresAt})
    const now=await databaseSecond()
    assert.ok(Number.isSafeInteger(proof.issuedAt)&&Number.isSafeInteger(proof.expiresAt)&&proof.issuedAt<=now&&now<proof.expiresAt)
    assert.ok(proof.expiresAt-proof.issuedAt<=30&&proof.expiresAt<=fence.expiresAt)
    assert.ok(proof.expiresAt<=f.approval.expiresAt||action==='resolve')
    if(lease)assert.ok(proof.expiresAt<=Math.floor(Date.parse(lease.expiresAt)/1000))
    assert.match(signature,/^[A-Za-z0-9+/]{512}$/u)
    const canonical=Buffer.from(protocol.nativeEmailCanonicalJson(proof),'ascii')
    assert.ok(crypto.verify('sha256',canonical,{key:dispatchKeys.publicKey,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(signature,'base64')))
    assert.equal(crypto.verify('sha256',canonical,signing.publicKey,Buffer.from(signature,'base64')),false,
      'The review key and the dispatch key are distinct authorities')
  }
  await check('maintenance preparation signs only the exact staged Email while the private fence is held',async()=>{
    const f=await stagePrivate(38,0,true),fence={...await fenceFor(),expiresAt:await databaseSecond()+15}
    let heldFence=false,nativeCalls=0
    const privateStore=configured(f,{withVerifiedFence:async run=>{
      assert.equal(activeTransactions.size,0);assert.equal(heldFence,false);heldFence=true
      try {return await run(fence)} finally {heldFence=false}
    }})
    await assertDispatchRefused(f.privateStore,{action:'prepare',item:f.item},'legacy_dispatch_unconfigured')
    await assertDispatchRefused(privateStore,{action:'prepare',item:{...f.item,lockToken:id(9901)}})
    const prepare={action:'prepare',item:f.item}
    const fabricated=configured(f,{withVerifiedFence:async()=> 'fabricated preparation result'})
    await assertDispatchRefused(fabricated,prepare,'legacy_dispatch_fence_incomplete')
    let swallowed
    const hidesFailure=configured(f,{withVerifiedFence:async run=>{
      try {await run({...fence,expiresAt:1})} catch(error) {swallowed=error}
      await assert.rejects(()=>run(fence),held('legacy_dispatch_fence_reentered'))
      return 'fabricated result after swallowed authorization failure'
    }})
    await assertDispatchRefused(hidesFailure,prepare,'legacy_dispatch_fence_incomplete')
    assert.ok(held('legacy_dispatch_authorization_expired')(swallowed),'Fixture must swallow the real authorization denial')
    let pending
    const returnsEarly=configured(f,{withVerifiedFence:async run=>{
      pending=run(fence)
      // Retain the exact callback promise; attach a rejection observer now so
      // we can explicitly await its denial after the wrapper has released.
      void pending.catch(()=>{})
      return 'fabricated result before awaiting the fence callback'
    }})
    try {
      await assertDispatchRefused(returnsEarly,prepare,'legacy_dispatch_fence_incomplete')
    } finally {
      assert.ok(pending,'Fixture must start the authorization callback before releasing the fence')
      await assert.rejects(()=>pending,held('legacy_dispatch_fence_released'))
    }
    assert.equal(activeTransactions.size,0)
    assert.equal(await admissionState(f),undefined);assert.equal((await outbox(f.item)).status,'processing')
    const candidate=await privateStore.candidate(f.item)
    const unregisteredLease={operationId:f.request.command.operationId,owner,fence:1,
      expiresAt:new Date((fence.expiresAt+5)*1000).toISOString(),context:candidate.context}
    for(const action of ['publish','resolve'])await assertDispatchRefused(privateStore,{action,request:f.request,lease:unregisteredLease})
    const output=await privateStore.withMaintenanceDispatch({action:'prepare',item:f.item},async scope=>{
      nativeCalls++;assert.equal(heldFence,true);await assertSignedDispatch(f,'prepare',scope,fence)
      assert.equal(await admissionState(f),undefined);assert.equal((await control()).active_operation_id,null)
      return 'synthetic-preparation-result'
    })
    assert.equal(output,'synthetic-preparation-result');assert.equal(heldFence,false);assert.equal(nativeCalls,1)
    assert.equal(await admissionState(f),undefined)
    assert.equal((await outbox(f.item)).status,'processing')
  })
  await check('maintenance publish commits its dispatch exactly once and only resolves a lost native outcome',async()=>{
    const f=await stagePrivate(39,0,true),fence=await fenceFor()
    let nativePublishes=0,nativeResolves=0,heldFence=false
    const withVerifiedFence=async run=>{
      assert.equal(activeTransactions.size,0);assert.equal(heldFence,false);heldFence=true
      try {return await run(fence)} finally {heldFence=false}
    }
    const privateStore=configured(f,{withVerifiedFence})
    const candidate=await privateStore.candidate(f.item),{admission,lease}=await privateStore.admit(f.item,candidate,owner)
    const request=admission.request
    const publish={action:'publish',request,lease}
    assert.equal(await admissionState(f),'admitted')
    assert.equal(await privateStore.maintenancePublishState(request),'admitted')
    await assert.rejects(()=>privateStore.maintenancePublishState({...request,commandHash:hash('wrong state lookup command')}),
      held('legacy_release_operation_changed'))
    await assert.rejects(()=>privateStore.markDispatched(request,lease),held('legacy_dispatch_permit_required'))
    await assert.rejects(()=>privateStore.withMaintenanceDispatch(publish,async()=>{throw Error('old path must not exchange')}),
      held('legacy_dispatch_publish_requires_readiness'))
    await assertDispatchRefused(privateStore,{action:'prepare',item:f.item})
    await assertDispatchRefused(privateStore,{...publish,lease:{...lease,fence:lease.fence+1}})
    await assertDispatchRefused(privateStore,{...publish,request:{...request,commandHash:hash('other command')}})
    for(const [invalid,code] of [[{...fence,expiresAt:await databaseSecond()-1},'legacy_dispatch_authorization_expired'],
      [{...fence,targetFingerprint:hash('different target')},'legacy_dispatch_fence_invalid'],
      [{targetFingerprint,expiresAt:fence.expiresAt},'legacy_dispatch_fence_invalid']]) {
      const denied=configured(f,{withVerifiedFence:async run=>run(invalid)})
      await assertDispatchRefused(denied,publish,code)
      assert.equal(await admissionState(f),'admitted','Invalid fence must not durably dispatch its Email')
    }
    const unverified=Error('synthetic zero-byte destination refusal')
    let escapedAuthorize
    await assert.rejects(()=>privateStore.withMaintenancePublish(request,lease,async scope=>{
      assert.equal(heldFence,true);assert.equal(activeTransactions.size,0)
      assert.deepEqual(scope.request,request);assert.deepEqual(scope.fence,fence)
      escapedAuthorize=scope.authorize
      throw unverified
    }),error=>error===unverified)
    await assert.rejects(()=>escapedAuthorize(),held('legacy_dispatch_fence_released'))
    await assert.rejects(()=>privateStore.withMaintenancePublish(request,lease,async()=> 'unverified fake success'),
      held('legacy_dispatch_authorization_incomplete'))
    assert.equal(await privateStore.maintenancePublishState(request),'admitted',
      'No verified connection or authorization must leave the exact operation resumable')
    const resumedAdmission=await configured(f,{withVerifiedFence}).claimResolution(request.command.operationId,owner)
    assert.equal(resumedAdmission.admission.state,'admitted');assert.deepEqual(resumedAdmission.lease,lease)
    const lost=Error('synthetic lost native publish response')
    const fakeReceipt=nativeReceipt(request)
    let verifiedBeforeLoss=false
    await assert.rejects(()=>privateStore.withMaintenancePublish(request,lease,async scope=>{
      assert.equal(heldFence,true);assert.equal(activeTransactions.size,0)
      assert.equal(await admissionState(f),'admitted','No CAS before the ready callback authorizes this exchange')
      const permit=await scope.authorize()
      await assert.rejects(()=>scope.authorize(),held('legacy_dispatch_authorization_reentered'))
      nativePublishes++;await assertSignedDispatch(f,'publish',{request:scope.request,permit},fence,lease)
      assert.equal(await admissionState(f),'dispatched','Native transport must see the committed dispatch state')
      assert.equal(await privateStore.maintenancePublishState(request),'dispatched')
      verifiedBeforeLoss=true
      throw lost
    }),error=>verifiedBeforeLoss&&(error===lost||held()(error)))
    assert.equal(heldFence,false);assert.equal(verifiedBeforeLoss,true)
    const afterLoss=await admissionState(f)
    assert.ok(['dispatched','unknown'].includes(afterLoss));assert.equal((await outbox(f.item)).status,'processing')
    // A new adapter in the same lease cannot mint a second publish permit.
    await assertDispatchRefused(configured(f,{withVerifiedFence}),publish,'legacy_dispatch_already_dispatched')
    if(afterLoss==='dispatched')await privateStore.markUnknown(request.command.operationId)
    const recovery=configured(f,{initialApproval:null,withVerifiedFence})
    const current=await recovery.claimResolution(request.command.operationId,owner)
    const resolve={action:'resolve',request:current.admission.request,lease:current.lease}
    await assertDispatchRefused(recovery,{...resolve,lease:{...current.lease,owner:id(9902)}})
    await assertDispatchRefused(recovery,{...resolve,lease:{...current.lease,fence:current.lease.fence+1}})
    const receipt=await recovery.withMaintenanceDispatch(resolve,async scope=>{
      nativeResolves++;assert.equal(heldFence,true);await assertSignedDispatch(f,'resolve',scope,fence,current.lease)
      assert.equal(await admissionState(f),'unknown');return {...fakeReceipt,replayed:true}
    })
    assert.equal(heldFence,false)
    assert.equal((await recovery.settle(resolve.request,resolve.lease,receipt)).synchronized,true)
    assert.equal(await admissionState(f),'committed');assert.equal((await outbox(f.item)).status,'succeeded')
    await assertDispatchRefused(recovery,resolve)
    assert.deepEqual({nativePublishes,nativeResolves},{nativePublishes:1,nativeResolves:1})
  })
  await check('maintenance resolution can tombstone an admitted operation without ever dispatching it',async()=>{
    const f=await stagePrivate(40),privateStore=configured(f)
    const candidate=await privateStore.candidate(f.item)
    await privateStore.admit(f.item,candidate,owner)
    const fence=await fenceFor(),recovery=configured(f,{initialApproval:null,withVerifiedFence:async run=>run(fence)})
    const {admission,lease}=await recovery.claimResolution(f.request.command.operationId,owner)
    let nativeResolves=0
    const receipt=await recovery.withMaintenanceDispatch({action:'resolve',request:admission.request,lease},async scope=>{
      nativeResolves++;await assertSignedDispatch(f,'resolve',scope,fence,lease)
      assert.equal(await admissionState(f),'admitted');return nativeReceipt(admission.request,true)
    })
    assert.equal((await recovery.settle(admission.request,lease,receipt)).synchronized,false)
    assert.equal(nativeResolves,1);assert.equal(await admissionState(f),'cancelled')
    assert.equal((await outbox(f.item)).status,'dead');assert.equal((await control()).active_operation_id,null)
  })
  await check('private maintenance operator leaves first dispatch unadmitted until ready, then exactly resolves a lost response',async()=>{
    const f=await stagePrivate(41,0,true),actions=[],fenceExits=[]
    const noSend=Error('synthetic unverified destination; zero bytes sent')
    const lost=Error('synthetic native commit with a lost response')
    let activeFence=null,nativeRecord=null,publishConnections=0,committedLease,exchangeError
    const withVerifiedFence=async run=>{
      assert.equal(activeFence,null);assert.equal(activeTransactions.size,0)
      const fence=await fenceFor();activeFence=fence
      try {return await run(fence)} finally {
        try {
          assert.equal(activeFence,fence);assert.equal(activeTransactions.size,0)
          fenceExits.push({action:actions.at(-1),admission:await admissionState(f),outbox:(await outbox(f.item)).status,
            activeOperationId:(await control()).active_operation_id})
        } finally {activeFence=null}
      }
    }
    const persistence=configured(f,{withVerifiedFence})
    const candidate=await persistence.candidate(f.item)
    const parked=await outbox(f.item)
    const durableDispatch=async()=>(await query(`SELECT
      (SELECT count(*)::int FROM crm_legacy_email_recovery_releases WHERE native_operation_id=$1) AS registrations,
      (SELECT count(*)::int FROM crm_native_email_publication_admissions WHERE operation_id=$1) AS admissions,
      (SELECT count(*)::int FROM crm_native_email_publication_work WHERE operation_id=$1) AS leases,
      active_operation_id FROM crm_native_email_publication_control WHERE singleton`,
    [f.selection.nativeOperationId])).rows[0]
    const assertUnadmitted=async()=>{
      assert.equal(await persistence.maintenancePublishState(f.request),'not_admitted')
      assert.deepEqual(await durableDispatch(),{registrations:0,admissions:0,leases:0,active_operation_id:null})
      assert.deepEqual(await outbox(f.item),parked)
    }
    await assertUnadmitted()
    const now=await databaseSecond()
    const expiredProof={...f.proof,issuedAt:now-120,expiresAt:now-1}
    const expiredApproval=configured(f,{initialApproval:signPrivateProof(expiredProof,expiredProof.issuedAt)})
    await assert.rejects(()=>expiredApproval.withMaintenanceInitialPublish(f.item,candidate,owner,async(scope,lease)=>{
      assert.equal(lease(),null);await scope.authorize()
    }),held('legacy_release_approval_expired'))
    await assertUnadmitted()
    const expiredFence=configured(f,{withVerifiedFence:async run=>run({...await fenceFor(),expiresAt:now-1})})
    await assert.rejects(()=>expiredFence.withMaintenanceInitialPublish(f.item,candidate,owner,async(scope,lease)=>{
      assert.equal(lease(),null);await scope.authorize()
    }),held('legacy_dispatch_authorization_expired'))
    await assertUnadmitted()
    let abandonedReady
    await assert.rejects(()=>persistence.withMaintenanceInitialPublish(f.item,candidate,owner,async(scope,lease)=>{
      assert.equal(lease(),null);abandonedReady=scope.authorize
      return 'synthetic success without ready approval'
    }),held('legacy_dispatch_authorization_incomplete'))
    await assert.rejects(()=>abandonedReady(),held('legacy_dispatch_fence_released'))
    await assertUnadmitted()
    // The deliberately rejected direct call also acquired the external fence,
    // but is not part of the following operator-level exchange trace.
    fenceExits.length=0
    const exchange=async packet=>{
      assert.ok(activeFence,'Native exchange requires its writer fence');assert.equal(activeTransactions.size,0)
      const {request,permit:{proof:{action}}}=packet
      if(action==='prepare') {
        assert.deepEqual(actions,publishConnections===0?[]:['prepare','publish-not-sent'])
        await assertUnadmitted()
        await assertSignedDispatch(f,action,packet,activeFence)
        actions.push(action)
        const {version,suiteCrmId,globalId,pipelineId,generation,audienceFingerprint,expectedRecordFingerprint,
          capabilityPolicyFingerprint,principalSuiteCrmUserIds,expectedCapabilities}=request.command
        return {version,suiteCrmId,globalId,pipelineId,generation,audienceFingerprint,expectedRecordFingerprint,
          capabilityPolicyFingerprint,principalSuiteCrmUserIds,expectedCapabilities}
      }
      assert.equal(action,'resolve');assert.deepEqual(actions,['prepare','publish-not-sent','prepare','publish']);assert.ok(nativeRecord)
      const leaseRow=(await query(`SELECT lease_owner AS owner,lease_fence AS fence,lease_until AS "expiresAt"
        FROM crm_native_email_publication_work WHERE operation_id=$1`,[f.selection.nativeOperationId])).rows[0]
      assert.ok(leaseRow);assert.equal(leaseRow.owner,owner)
      await assertSignedDispatch(f,action,packet,activeFence,{...leaseRow,fence:Number(leaseRow.fence)})
      assert.equal(await admissionState(f),'unknown');actions.push(action)
      return {...nativeRecord,replayed:true}
    }
    const exchangePublish=async scope=>{
      assert.ok(activeFence,'Native exchange requires its writer fence');assert.equal(activeTransactions.size,0)
      assert.deepEqual(scope.fence,activeFence);assert.equal(nativeRecord,null)
      assert.equal(committedLease(),null);await assertUnadmitted()
      if(++publishConnections===1){
        assert.deepEqual(actions,['prepare']);actions.push('publish-not-sent');throw noSend
      }
      assert.deepEqual(actions,['prepare','publish-not-sent','prepare'])
      const permit=await scope.authorize()
      assert.equal(activeTransactions.size,0)
      await assert.rejects(async()=>scope.authorize(),held('legacy_dispatch_authorization_reentered'))
      const admittedLease=committedLease()
      assert.ok(admittedLease);assert.equal(admittedLease.operationId,f.selection.nativeOperationId)
      const leaseRow=(await query(`SELECT lease_owner AS owner,lease_fence AS fence,lease_until AS "expiresAt"
        FROM crm_native_email_publication_work WHERE operation_id=$1`,[f.selection.nativeOperationId])).rows[0]
      assert.ok(leaseRow);assert.equal(leaseRow.owner,owner)
      assert.equal(admittedLease.owner,leaseRow.owner);assert.equal(admittedLease.fence,Number(leaseRow.fence))
      await assertSignedDispatch(f,'publish',{request:scope.request,permit},activeFence,admittedLease)
      assert.deepEqual(await durableDispatch(),{registrations:1,admissions:1,leases:1,active_operation_id:f.selection.nativeOperationId})
      assert.equal(await admissionState(f),'dispatched')
      nativeRecord=nativeReceipt(scope.request);actions.push('publish')
      throw lost
    }
    const first=maintenanceOperator.createNativeEmailRecoveryMaintenanceOperator({
      persistence:{...persistence,withMaintenanceInitialPublish:(item,expected,leaseOwner,run)=>
        persistence.withMaintenanceInitialPublish(item,expected,leaseOwner,(scope,getLease)=>{
          committedLease=getLease
          return run(scope,getLease)
        })},exchange,exchangePublish:async scope=>{
          try{return await exchangePublish(scope)}catch(error){exchangeError=error;throw error}
        },owner})
    await assert.rejects(()=>first.publish(),error=>error===noSend)
    await assertUnadmitted();assert.throws(()=>committedLease(),held('legacy_dispatch_fence_released'));assert.equal(nativeRecord,null)
    await assert.rejects(()=>first.resolve(),held())
    assert.deepEqual(actions,['prepare','publish-not-sent'],'Known zero-byte failure cannot tombstone the reviewed email')
    await assert.rejects(()=>first.publish(),held('native_outcome_unknown'))
    assert.equal(exchangeError,lost,'Only the intended synthetic native response loss may drive reconciliation')
    assert.ok(nativeRecord);assert.equal(activeFence,null);assert.equal(await admissionState(f),'unknown')
    await assert.rejects(()=>first.publish(),held())
    assert.deepEqual(actions,['prepare','publish-not-sent','prepare','publish'],'An ambiguous publish must not restart preparation or publication')
    // New controller instance, no review envelope: resolve only the registered
    // operation and exact live lease rather than granting another dispatch.
    const resumed=maintenanceOperator.createNativeEmailRecoveryMaintenanceOperator({
      persistence:configured(f,{initialApproval:null,withVerifiedFence}),exchange,exchangePublish,owner})
    assert.deepEqual(await resumed.resolve(),{synchronized:true,pipelineId:f.request.command.pipelineId,outboxId:f.item.id})
    assert.equal(activeFence,null);assert.deepEqual(actions,['prepare','publish-not-sent','prepare','publish','resolve'])
    assert.equal(publishConnections,2)
    assert.deepEqual(fenceExits,[
      {action:'prepare',admission:undefined,outbox:'processing',activeOperationId:null},
      {action:'publish-not-sent',admission:undefined,outbox:'processing',activeOperationId:null},
      {action:'prepare',admission:undefined,outbox:'processing',activeOperationId:null},
      {action:'publish',admission:'unknown',outbox:'processing',activeOperationId:f.selection.nativeOperationId},
      {action:'resolve',admission:'committed',outbox:'succeeded',activeOperationId:null},
    ])
    assert.equal((await stored(f.item)).metadata.suiteCrmEmailProjection.operationId,f.selection.nativeOperationId)
    await assert.rejects(()=>resumed.resolve(),held('legacy_dispatch_no_unresolved_operation'))
    assert.deepEqual(actions,['prepare','publish-not-sent','prepare','publish','resolve'])
  })
  console.log(`PASS ${checks.length} real adapter/PostgreSQL groups; synthetic receipts/audience/enqueue, no native/application-authorization/deployment proof`)
}finally{
  try{if(pool)await pool.end()}
  finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{timeout:30000,stdio:'pipe'})}
}
