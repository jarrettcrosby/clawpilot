import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { createBpoFailedEmailAppSettler } from './lib/bpo-failed-email-app-settlement.mjs'
import { createBpoFailedEmailAppHandoff, prepareBpoFailedEmailCandidate } from './lib/bpo-failed-email-app-handoff.mjs'
import { describeBpoFailedEmailRepairInventory } from './lib/bpo-failed-email-repair-plan.mjs'
import { prepareBpoSharedEmailProjection, sharedEmailCanonicalJson } from './lib/bpo-shared-email-projection.mjs'
import { createSharedBpoEmailReceiptVerifier } from './lib/bpo-shared-email-receipt-proof.mjs'

const workspaceId='c6c49765-9bf6-4223-9261-7553499f5d92',pipelineId='587c8746-ecf6-40ae-8c50-e456f99ad555'
const uuid=n=>`9407544f-22f4-44db-81ba-${String(n).padStart(12,'0')}`
const sha=value=>createHash('sha256').update(value).digest('hex')
const slots=Array.from({length:19},(_,i)=>({interactionId:uuid(i+1),jobId:uuid(i+30),nativeId:uuid(i+60),
  globalId:`gi${String(i+1).padStart(7,'0')}`,providerMessageId:`test-${i}`,
  interactionFingerprint:sha(`interaction-${i}`),jobFingerprint:sha(`job-${i}`),preimageFingerprint:sha(`preimage-${i}`),
  projectionFingerprint:sha(`projection-${i}`)}))
const app={originFingerprint:sha('app-origin'),deploymentFingerprint:sha('app-release')}
const suiteCrm={originFingerprint:sha('native-origin'),deploymentFingerprint:sha('native-release')}
const fixture=()=>structuredClone({workspaceId,pipelineId,app,suiteCrm,original11:slots.slice(0,11),later8:slots.slice(11)})
const verified=(target,override={})=>({...target,version:1,state:'exact',kind:'created',snapshotFingerprint:sha('native snapshot'),
  receiptFingerprint:sha('native receipt'),observedAt:new Date().toISOString(),...override})
const settings=(review,overrides={})=>({review,expectedInventoryFingerprint:describeBpoFailedEmailRepairInventory(review),
  verifyNativeReceipt:async(_,target)=>verified(target),attestAppDeployment:async()=>app.deploymentFingerprint,...overrides})

test('wrong immutable inventory, out-of-scope slot, rejected native receipt, wrong deployment and forged receipt never start writes',async()=>{
  const client=new EventEmitter(); let sqlCount=0,proofCount=0
  client.query=async()=>{sqlCount++;throw new Error('unexpected database access')}
  const review=fixture(), defaultInput={client,interactionId:slots[0].interactionId,receiptEnvelope:{}}
  assert.throws(()=>createBpoFailedEmailAppSettler(settings(review,{expectedInventoryFingerprint:sha('different')})),/inventory_pin/u)
  const scoped=createBpoFailedEmailAppSettler(settings(review,{verifyNativeReceipt:async()=>{proofCount++;throw new Error('private')} }))
  await assert.rejects(scoped.settle({...defaultInput,interactionId:uuid(899)}),/not_in_exact_review/u)
  assert.equal(proofCount,0)
  await assert.rejects(scoped.settle(defaultInput),error=>error.message.endsWith('independent_evidence_unavailable')&&!error.message.includes('private'))
  const drift=createBpoFailedEmailAppSettler(settings(review,{attestAppDeployment:async()=>sha('other release')}))
  await assert.rejects(drift.settle(defaultInput),/deployment_changed/u)
  const forged=createBpoFailedEmailAppSettler(settings(review,{verifyNativeReceipt:async(_,target)=>verified(target,{jobId:uuid(100)})}))
  await assert.rejects(forged.settle(defaultInput),/native_receipt_binding/u)
  assert.equal(sqlCount,0)
})

const pgBin=process.env.CLAWPILOT_TEST_LOCAL_PG_BIN,pgModule=process.env.CLAWPILOT_TEST_PG_MODULE
test('actual local PostgreSQL rolls back unexpected changes and settles one exact terminal job with read-only recovery after lost response',{
  skip:!pgBin||!pgModule,
},async()=>{
  const {Client}=createRequire(import.meta.url)(pgModule)
  const dir=mkdtempSync('/tmp/clawpilot-bpo-settlement-'),data=join(dir,'pg')
  const command=(program,...args)=>execFileSync(join(pgBin,program),args,{stdio:'pipe',timeout:25000})
  let client, started=false
  try {
    command('initdb','-D',data,'-A','trust','--no-locale','-E','UTF8')
    command('pg_ctl','-D',data,'-l',join(dir,'postgres.log'),'-o',`-h '' -k ${dir} -p 55433`,'-w','start')
    started=true
    client=new Client({host:dir,port:55433,database:'postgres',user:process.env.USER});await client.connect()
    await client.query(`SET TIME ZONE 'UTC';
      CREATE TABLE app_settings(key text PRIMARY KEY,value jsonb NOT NULL);
      CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean NOT NULL DEFAULT false);
      CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,workspace_organization_id uuid,reference_access_disabled boolean NOT NULL DEFAULT false);
      CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,provider_message_id text,
        sync_status text,sync_error text,suitecrm_module text,suitecrm_synced_at timestamptz,updated_at timestamptz,
        organization_id uuid,contact_id uuid,source_key text,source_hash text,description text,metadata jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}');
      CREATE TABLE sync_outbox(id uuid PRIMARY KEY,aggregate_type text,aggregate_id text,target_system text,operation text,
        status text,attempts int,last_error text,processed_at timestamptz,created_at timestamptz,updated_at timestamptz,locked_at timestamptz,lock_token uuid,
        payload jsonb,idempotency_key text);
      CREATE TABLE crm_organizations(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,source_payload jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE crm_contacts(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,organization_id uuid,source_payload jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE crm_interaction_organizations(pipeline_id uuid,interaction_id uuid,organization_id uuid,is_primary boolean);
      CREATE TABLE crm_interaction_contacts(pipeline_id uuid,interaction_id uuid,contact_id uuid);
      CREATE TABLE crm_contact_merge_outbox_dependencies(dependent_outbox_id uuid,prerequisite_outbox_id uuid);
      CREATE TABLE audit_events(actor text,subject text,event_type text,event_key text UNIQUE,aggregate_type text,aggregate_id text,
        organization_id uuid,is_system boolean,payload jsonb);
      CREATE TABLE crm_native_email_publication_control(singleton boolean PRIMARY KEY,enabled boolean,active_operation_id text,
        active_transition_id text,active_initial_enrollment_id text);
      CREATE TABLE crm_native_email_publication_admissions(local_id uuid,native_id text,global_id text,state text);
      CREATE TABLE crm_legacy_email_recovery_holds(outbox_id uuid,retired_outbox_id uuid,local_id uuid,native_id text,global_id text);
      CREATE SCHEMA crm_legacy_email_terminal_hold;
      CREATE TABLE crm_legacy_email_terminal_hold.held(outbox_id uuid,local_id uuid,native_id text,global_id text);
      CREATE SCHEMA crm_legacy_email_retirement;
      CREATE TABLE crm_legacy_email_retirement.retained(outbox_id uuid,local_id uuid,native_id text,global_id text);
      CREATE TABLE crm_legacy_email_retirement.serial(singleton boolean PRIMARY KEY);
      INSERT INTO crm_legacy_email_retirement.serial VALUES(true);
      INSERT INTO crm_native_email_publication_control VALUES(true,false,NULL,NULL,NULL)`)
    const marker=uuid(999), review=fixture(), reviewed=[...review.original11,...review.later8]
    await client.query("INSERT INTO app_settings VALUES('deployment.database.identity',jsonb_build_object('id',$1::text))",[marker])
    await client.query('INSERT INTO workspace_organizations(id) VALUES($1)',[workspaceId])
    await client.query('INSERT INTO pipeline_spaces(id,workspace_organization_id) VALUES($1,$2)',[pipelineId,workspaceId])
    const {rows:[origin]}=await client.query(`SELECT d.datname,d.oid::text,c.system_identifier::text FROM pg_database d
      CROSS JOIN pg_control_system() c WHERE d.datname=current_database()`)
    review.app.originFingerprint=sha('["clawpilot-bpo-failed-email-postgres-v1", '
      +[origin.datname,origin.oid,origin.system_identifier,marker].map(value=>JSON.stringify(value)).join(', ')+']')
    const companies=[['airspace',uuid(300)],['globus',uuid(301)]]
    const people=[['casey',uuid(400),uuid(300)],['globus-contact',uuid(401),uuid(301)]]
    for(const [nativeId,localId] of companies) await client.query('INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id) VALUES($1,$2,$3)',[localId,pipelineId,nativeId])
    for(const [nativeId,localId,accountId] of people) await client.query('INSERT INTO crm_contacts(id,pipeline_id,suitecrm_id,organization_id) VALUES($1,$2,$3,$4)',[localId,pipelineId,nativeId,accountId])
    const liveRelationships={parentType:'Accounts',parentId:'globus',accounts:['airspace','globus'],contacts:['casey','globus-contact'],
      contactAccounts:[{contactId:'casey',accountId:'airspace'},{contactId:'globus-contact',accountId:'globus'}]}
    const proofAttributes={name:'Synthetic Email',date_sent_received:'2026-11-09T01:02:03Z',type:'archived',status:'read',
      parent_type:'Accounts',parent_id:'globus',assigned_user_id:'fixture-author',description:'Synthetic private body',description_html:'',from_addr_name:'fixture@example.invalid'}
    for(const [index,slot] of reviewed.entries()) {
      await client.query(`INSERT INTO crm_interactions(id,pipeline_id,suitecrm_id,reference_code,provider_message_id,sync_status,sync_error,
        suitecrm_module,organization_id,contact_id,source_key,source_hash,description)
        VALUES($1,$2,$3,$4,$5,'failed','failure','Emails',$6,$7,$8,$9,$10)`,[slot.interactionId,pipelineId,slot.nativeId,slot.globalId,
        slot.providerMessageId,uuid(301),uuid(401),`fixture-${index}`,sha(`source-${index}`),proofAttributes.description])
      for(const [name,localId] of companies) await client.query('INSERT INTO crm_interaction_organizations VALUES($1,$2,$3,$4)',[pipelineId,slot.interactionId,localId,name==='globus'])
      for(const [,localId] of people) await client.query('INSERT INTO crm_interaction_contacts VALUES($1,$2,$3)',[pipelineId,slot.interactionId,localId])
      const payload={entity:'interactions',localId:slot.interactionId,pipelineId,suiteCrmModule:'Emails',suiteCrmId:slot.nativeId,
        attributes:{...proofAttributes,global_id_c:slot.globalId},emailProjection:{version:1,accounts:liveRelationships.accounts,
          contacts:liveRelationships.contacts,contactAccounts:liveRelationships.contactAccounts,previousManaged:{accounts:[],contacts:[]},audience:{ignored:true}},
        relationships:[...liveRelationships.accounts.map(id=>({linkFieldName:'accounts',relatedModuleName:'Accounts',relatedBeanId:id})),
          ...liveRelationships.contacts.map(id=>({linkFieldName:'contacts',relatedModuleName:'Contacts',relatedBeanId:id}))]}
      await client.query(`INSERT INTO sync_outbox(id,aggregate_type,aggregate_id,target_system,operation,status,attempts,last_error,
        processed_at,created_at,payload,idempotency_key) VALUES($1,'crm_interactions',$2,'suitecrm','upsert_record','dead',8,
        'native_projection_proof_unavailable','2026-11-09','2026-11-09',$3,$4)`,[slot.jobId,slot.interactionId,JSON.stringify(payload),
        `crm:interactions:v4:${slot.interactionId}:Emails:${sha(`source-${index}`)}`])
      const {rows:[source]}=await client.query(`SELECT to_jsonb(i)::text AS interaction,to_jsonb(o)::text AS job,
        jsonb_build_array(to_jsonb(i),to_jsonb(o))::text AS both FROM crm_interactions i CROSS JOIN sync_outbox o WHERE i.id=$1 AND o.id=$2`,
      [slot.interactionId,slot.jobId])
      const {projectionFingerprint}=prepareBpoSharedEmailProjection({payload,pin:{...slot,projectionFingerprint:undefined},pipelineId,liveRelationships})
      Object.assign(slot,{projectionFingerprint,interactionFingerprint:sha(source.interaction),jobFingerprint:sha(source.job),preimageFingerprint:sha(source.both)})
    }
    const first=reviewed[0],keyId='synthetic-native-readback', keys=generateKeyPairSync('rsa',{modulusLength:3072})
    const proof={purpose:'clawpilot-shared-bpo-email-readback-v1',keyId,result:verified({workspaceId,pipelineId,
      inventoryFingerprint:describeBpoFailedEmailRepairInventory(review),interactionId:first.interactionId,jobId:first.jobId,
      nativeId:first.nativeId,globalId:first.globalId,preimageFingerprint:first.preimageFingerprint,
      projectionFingerprint:first.projectionFingerprint,appOriginFingerprint:review.app.originFingerprint,
      appDeploymentFingerprint:review.app.deploymentFingerprint,nativeOriginFingerprint:review.suiteCrm.originFingerprint,
      nativeDeploymentFingerprint:review.suiteCrm.deploymentFingerprint})}
    const receiptEnvelope={proof,signature:sign('RSA-SHA256',Buffer.from(sharedEmailCanonicalJson(proof)),keys.privateKey).toString('base64')}
    const verifyNativeReceipt=createSharedBpoEmailReceiptVerifier({publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}),keyId})
    const settler=createBpoFailedEmailAppSettler(settings(review,{verifyNativeReceipt})),input={client,interactionId:first.interactionId,receiptEnvelope}
    const {attestAppDeployment,expectedInventoryFingerprint}=settings(review)
    const toCandidate=({projectionFingerprint:_,...row})=>row
    const candidateManifestJson=JSON.stringify({version:1,readOnly:true,purpose:'clawpilot-bpo-terminal-email-candidate-inventory',
      originFingerprint:review.app.originFingerprint,original11:review.original11.map(toCandidate),later8:review.later8.map(toCandidate)})
    const candidate=await prepareBpoFailedEmailCandidate({client,interactionId:first.interactionId,candidateManifestJson,
      expectedManifestFingerprint:sha(candidateManifestJson),appDeploymentFingerprint:review.app.deploymentFingerprint,attestAppDeployment})
    assert.equal(candidate.projectionFingerprint,first.projectionFingerprint)
    const handoff=createBpoFailedEmailAppHandoff({review,expectedInventoryFingerprint,attestAppDeployment,
      verifyNativeAbsence:async(_,target)=>({...target,version:1,state:'absent',evidenceFingerprint:sha('synthetic absence'),
        observedAt:new Date(Date.now()-1000).toISOString()})})
    assert.equal((await handoff.inspect({client,interactionId:first.interactionId})).state,'ready')
    const contender=new Client({host:dir,port:55433,database:'postgres',user:process.env.USER})
    await contender.connect()
    let dispatch
    try {
      const claimed=await Promise.all([client,contender].map(connection=>handoff.claim({client:connection,interactionId:first.interactionId,absenceEvidence:{}})))
      assert.deepEqual(claimed.map(result=>result.state).sort(),['dispatch-once','reconcile-only'])
      dispatch=claimed.find(result=>result.state==='dispatch-once')
    } finally {await contender.end()}
    assert.deepEqual(dispatch.projection,candidate.projection)
    assert.equal((await handoff.claim({client,interactionId:first.interactionId,absenceEvidence:{}})).state,'reconcile-only')
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM audit_events WHERE event_type='system.crm.bpo_shared_email_dispatch_claimed'`)).rows[0].n,1)
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM sync_outbox WHERE status='dead' AND attempts=8`)).rows[0].n,19)
    const counts=async()=> (await client.query(`SELECT (SELECT count(*)::int FROM sync_outbox WHERE status='succeeded') AS jobs,
      (SELECT count(*)::int FROM crm_interactions WHERE sync_status='synced') AS interactions,
      (SELECT count(*)::int FROM audit_events WHERE event_type='system.crm.bpo_shared_email_settled') AS audit`)).rows[0]
    assert.equal((await settler.resolve(input)).state,'unsettled')
    assert.deepEqual(await counts(),{jobs:0,interactions:0,audit:0})
    await client.query(`INSERT INTO crm_contact_merge_outbox_dependencies VALUES($1,$2)`,[reviewed[1].jobId,first.jobId])
    await assert.rejects(settler.settle(input),/contact_merge_dependency/u)
    await client.query('DELETE FROM crm_contact_merge_outbox_dependencies')
    await client.query(`UPDATE crm_contacts SET organization_id=$1 WHERE id=$2`,[uuid(301),uuid(400)])
    await assert.rejects(settler.settle(input),/relationships_changed/u)
    await client.query(`UPDATE crm_contacts SET organization_id=$1 WHERE id=$2`,[uuid(300),uuid(400)])
    await client.query(`CREATE FUNCTION bad_source_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.description:='unexpected drift';RETURN NEW;END$$;
      CREATE TRIGGER bad_source_change BEFORE UPDATE OF sync_status ON crm_interactions FOR EACH ROW EXECUTE FUNCTION bad_source_change()`)
    await assert.rejects(settler.settle(input),/unexpected_postimage/u)
    assert.deepEqual(await counts(),{jobs:0,interactions:0,audit:0})
    await client.query('DROP TRIGGER bad_source_change ON crm_interactions')
    const lost={query:async(sql,values)=>{const result=await client.query(sql,values);if(sql==='COMMIT')throw new Error('synthetic loss');return result},
      on:client.on.bind(client),removeListener:client.removeListener.bind(client)}
    await assert.rejects(settler.settle({...input,client:lost}),/settlement_commit_unproven/u)
    await client.end()
    client=new Client({host:dir,port:55433,database:'postgres',user:process.env.USER});await client.connect()
    input.client=client
    const resolved=await settler.resolve(input)
    assert.equal(resolved.state,'settled');assert.equal(resolved.replayed,true)
    assert.deepEqual(await settler.settle(input),resolved)
    assert.deepEqual(await counts(),{jobs:1,interactions:1,audit:1})
    const {rows:[final]}=await client.query(`SELECT o.status,o.attempts,o.payload,i.sync_status,i.metadata,i.description,
      o.processed_at=i.suitecrm_synced_at AS same_time FROM crm_interactions i JOIN sync_outbox o ON o.aggregate_id=i.id::text WHERE i.id=$1`,[first.interactionId])
    assert.equal(final.attempts,8);assert.equal(final.same_time,true);assert.equal(final.description,proofAttributes.description)
    assert.deepEqual(final.metadata.suiteCrmEmailProjection.accounts,liveRelationships.accounts)
    assert.equal(final.payload.attributes.description,proofAttributes.description)
    assert.ok(!JSON.stringify(final.metadata).includes(proofAttributes.description))
    assert.ok(!JSON.stringify((await client.query('SELECT payload FROM audit_events')).rows).includes(proofAttributes.description))
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM sync_outbox WHERE status='dead' AND attempts=8`)).rows[0].n,18)
  } finally {
    if(client)await client.end()
    if(started)command('pg_ctl','-D',data,'-m','fast','-w','stop')
    rmSync(dir,{recursive:true})
  }
})
