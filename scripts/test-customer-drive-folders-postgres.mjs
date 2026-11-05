#!/usr/bin/env node
// Actual coordinator, reservation SQL and migration in guarded disposable PG.
// Minimal app schema and synthetic Drive; actual CRM staging/outbox, audit and
// board projection. Not app UI/native/provider proof; shortlink upkeep excluded.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { normalizeCrmBoardCard } from '../app_src/lib/crm/boardCard.mjs'
import { decodeHtmlEntities } from '../app_src/lib/htmlEntities.mjs'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript'),{Pool}=require('pg')
const source=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
function load(path,deps={},allowUnused=false) {
  const module={exports:{}},code=ts.transpileModule(source(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{
    if(name.startsWith('node:'))return require(name)
    if(allowUnused&&!Object.hasOwn(deps,name))return new Proxy({},{get:(_,key)=>()=>assert.fail(`Unexpected external call ${name}.${String(key)}`)})
    assert.ok(Object.hasOwn(deps,name),`Unexpected import ${name}`);return deps[name]})
  return module.exports
}
const core=load('app_src/lib/crm/customerDriveFolders.ts'),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const scope={workspaceId:id(1),pipelineId:id(2),accountId:id(3),accountGlobalId:'ga1234567',sharedDriveId:'fixture-drive',
  customersParentId:'fixture-parent',serviceAccountEmail:'fixture@project.iam.gserviceaccount.com'}
const owner='owner@example.test',editor='editor@example.test',container='clawpilot-customer-folders-'+randomUUID().slice(0,8)
const environment={...process.env,CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE:'256m',CLAWPILOT_TEST_POSTGRES_MEMORY:'512m',CLAWPILOT_TEST_POSTGRES_CPUS:'0.5'}
let pool,started=false,passed=0,rollbackReservation=false,rollbackPublication=false
async function check(name,work){await work();passed++;console.log(`PASS ${name}`)}
try{
  execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','--detach','--name',container,'--pull','never',
    '-e','POSTGRES_PASSWORD=folder_fixture_only','-e','POSTGRES_DB=folder_fixture','-p','127.0.0.1::5432','pgvector/pgvector:pg16'],{environment}),
  {timeout:60000,stdio:'pipe'});started=true
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8'}).match(/^127\.0\.0\.1:(\d+)\s*$/)?.[1];assert.ok(port)
  pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'folder_fixture_only',database:'folder_fixture',connectionTimeoutMillis:1000})
  const query=(sql,values)=>pool.query(sql,values),deadline=Date.now()+30000
  while(true){try{await query('SELECT 1');break}catch(error){if(Date.now()>deadline)throw error;await new Promise(r=>setTimeout(r,100))}}
  const withTransaction=async work=>{const tx=await pool.connect();try{
    await tx.query('BEGIN');const result=await work(tx)
    if(rollbackReservation&&(await tx.query('SELECT count(*)::int AS n FROM crm_customer_drive_folders')).rows[0].n){
      throw Error('synthetic reservation transaction rollback')}
    if(rollbackPublication&&(await tx.query('SELECT count(*)::int AS n FROM sync_outbox')).rows[0].n){
      throw Error('synthetic publication transaction rollback')}
    await tx.query('COMMIT');return result
  }catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}}
  await query(`CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean DEFAULT false);
    CREATE TABLE app_users(email text PRIMARY KEY,status text,role text DEFAULT 'member');
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean DEFAULT false);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,PRIMARY KEY(user_email,organization_id));
    CREATE TABLE crm_organizations(id uuid PRIMARY KEY,pipeline_id uuid,reference_code text,workspace_organization_id uuid,account_type text,source_payload jsonb);`)
  await query(`ALTER TABLE crm_organizations ADD COLUMN suitecrm_id text, ADD COLUMN source_key text DEFAULT 'initial',
    ADD COLUMN identity_key text DEFAULT 'initial',ADD COLUMN parent_organization_id uuid,
    ADD COLUMN source_sheet_id text,ADD COLUMN source_row_number int,ADD COLUMN relationship_type text DEFAULT 'customer',
    ADD COLUMN priority text,ADD COLUMN name text DEFAULT 'Globus',ADD COLUMN account_manager text,
    ADD COLUMN website text,ADD COLUMN linkedin_url text,ADD COLUMN phone text,ADD COLUMN email text,ADD COLUMN email_opt_out boolean DEFAULT false,
    ADD COLUMN billing_address_street text,ADD COLUMN billing_address_city text,ADD COLUMN billing_address_state text,
    ADD COLUMN billing_address_postal_code text,ADD COLUMN billing_address_country text,ADD COLUMN description text,
    ADD COLUMN source_hash text DEFAULT 'before',ADD COLUMN sync_status text DEFAULT 'pending',ADD COLUMN sync_error text,
    ADD COLUMN created_by text,ADD COLUMN updated_by text,ADD COLUMN updated_at timestamptz DEFAULT now();
    CREATE TABLE crm_native_email_publication_control(singleton boolean PRIMARY KEY);
    INSERT INTO crm_native_email_publication_control VALUES(true);
    CREATE TABLE crm_native_email_publication_work(operation_id text,work_kind text,context jsonb);
    CREATE TABLE crm_native_email_publication_admissions(operation_id text,state text);
    CREATE TABLE audit_events(actor text,event_type text,aggregate_type text,aggregate_id text,payload jsonb,event_key text,
      subject text,organization_id uuid,is_system boolean);
    CREATE UNIQUE INDEX audit_key ON audit_events(event_key) WHERE event_key IS NOT NULL;
    CREATE TABLE project_boards(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,name text);
    CREATE TABLE crm_board_projections(board_id uuid PRIMARY KEY,pipeline_id uuid,workspace_organization_id uuid);
    CREATE TABLE crm_board_cards(board_id uuid,card_id text,pipeline_id uuid,entity_type text,entity_id uuid,reference_code text,
      payload jsonb,last_synced_description text,last_common_hash text,card_description_hash text,crm_description_hash text,
      sync_status text,conflict_at timestamptz,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(board_id,entity_type,entity_id));
    CREATE TABLE crm_contacts(id uuid,pipeline_id uuid,organization_id uuid,reference_code text,full_name text,email text,description text,
      updated_at timestamptz,source_payload jsonb);`)
  const outboxTable=source('db/migrations/0001_initial_railway_postgres.sql').match(/CREATE TABLE IF NOT EXISTS sync_outbox \([\s\S]*?\n\);/u)?.[0]
  assert.ok(outboxTable);await query(outboxTable);await query(source('db/migrations/0002_pipeline_outbox_worker.sql'))
  await query(source('db/migrations/0388_crm_customer_drive_folders.sql'))
  await query(source('db/migrations/0389_crm_customer_folder_jobs.sql'))
  await query('INSERT INTO workspace_organizations(id) VALUES($1)',[scope.workspaceId])
  await query('INSERT INTO app_users(email,status,role) VALUES($1,\'active\',\'owner\'),($2,\'active\',\'member\')',[owner,editor])
  await query('INSERT INTO pipeline_spaces(id,owner_email,workspace_organization_id) VALUES($1,$2,$3)',[scope.pipelineId,owner,scope.workspaceId])
  await query(`INSERT INTO app_user_organization_memberships VALUES($1,$3,'active','owner','{}',NULL),($2,$3,'active','member','{"viewCrm":true}',NULL)`,[owner,editor,scope.workspaceId])
  await query('INSERT INTO pipeline_space_members VALUES($1,$2,\'editor\')',[scope.pipelineId,editor])
  await query(`INSERT INTO crm_organizations(id,pipeline_id,reference_code,workspace_organization_id,account_type,source_payload)
    VALUES($1,$2,$3,NULL,'Customer','{}')`,[scope.accountId,scope.pipelineId,scope.accountGlobalId])
  const postgres={withTransaction,query},authority=load('app_src/lib/persistence/crmNativeEmailAuthority.ts')
  const audit=load('app_src/lib/auditWriter.ts',{'@/lib/persistence/postgres':postgres,
    'next/headers':{headers:async()=>{throw Error('No request in local fixture')}},'@/lib/authAttribution':{verifyAuthAttributionHeaders:()=>null}})
  const crm=load('app_src/lib/persistence/crm.ts',{'@/lib/persistence/postgres':postgres,
    '@/lib/persistence/crmNativeEmailAuthority':authority,'@/lib/crm/stableId':load('app_src/lib/crm/stableId.ts'),
    '@/lib/auditWriter':audit,'@/lib/publicUrl':{appPublicUrl:()=> 'http://localhost:4002'}},true)
  const links=load('app_src/lib/crm/customerFolderLinks.ts')
  const publication=load('app_src/lib/crm/customerFolderPublication.ts',{'./customerFolderLinks':links,'./customerDriveFolders':core})
  const storage=load('app_src/lib/persistence/crmCustomerFolders.ts',{'./postgres':postgres,'./crm':crm,
    './crmNativeEmailAuthority':authority,'../crm/customerDriveFolders':core,'../crm/customerFolderPublication':publication})
  const store=storage.postgresCustomerFolderStore(owner)
  const candidate=prefix=>({version:1,scope:{...scope},nodes:core.BPO_CUSTOMER_FOLDER_LAYOUT.map(([key,name],n)=>
    ({key,id:`${prefix}-${n}`,name:name||'Globus',adopted:false}))})
  await check('read is empty for exact active customer/editor; no reservation created by read',async()=>{
    assert.equal(await store.read(scope),null);assert.equal(await storage.postgresCustomerFolderStore(editor).read(scope),null)
    assert.equal((await query('SELECT count(*) FROM crm_customer_drive_folders')).rows[0].count,'0')
  })
  await check('actual concurrent SQL reservations converge on one immutable plan',async()=>{
    const [one,two]=await Promise.all([store.reserve(candidate('one')),store.reserve(candidate('two'))])
    assert.deepEqual(one,two);assert.equal((await query('SELECT count(*) FROM crm_customer_drive_folders')).rows[0].count,'1')
    assert.deepEqual(await store.read(scope),one)
  })
  await check('scope/parent/identity drift cannot adopt an existing reservation',async()=>{
    for(const [key,value] of [['pipelineId',id(9)],['accountGlobalId','ga7654321'],['workspaceId',id(9)],
      ['customersParentId','other-parent'],['sharedDriveId','other-drive'],['serviceAccountEmail','other@project.iam.gserviceaccount.com']]){
      await assert.rejects(store.read({...scope,[key]:value}))
    }
    const changed=candidate('changed');await assert.rejects(store.complete(changed),/reservation_changed/)
    assert.equal((await query('SELECT status FROM crm_customer_drive_folders')).rows[0].status,'reserved')
  })
  await check('viewer, disabled, trashed, CRM-denied, supplier, archived and workspace-root records are refused',async()=>{
    const attempts=[
      ["UPDATE pipeline_space_members SET access_role='viewer'", "UPDATE pipeline_space_members SET access_role='editor'"],
      ["UPDATE app_users SET status='disabled' WHERE email='editor@example.test'", "UPDATE app_users SET status='active'"],
      ["UPDATE app_user_organization_memberships SET trashed_at=now() WHERE user_email='editor@example.test'", "UPDATE app_user_organization_memberships SET trashed_at=NULL"],
      ["UPDATE app_user_organization_memberships SET permissions='{\"viewCrm\":false}' WHERE user_email='editor@example.test'", "UPDATE app_user_organization_memberships SET permissions='{\"viewCrm\":true}'"],
      ["UPDATE crm_organizations SET account_type='Supplier'", "UPDATE crm_organizations SET account_type='Customer'"],
      ["UPDATE crm_organizations SET source_payload='{\"archived\":true}'", "UPDATE crm_organizations SET source_payload='{}'"],
      [`UPDATE crm_organizations SET workspace_organization_id='${scope.workspaceId}'`, "UPDATE crm_organizations SET workspace_organization_id=NULL"],
    ]
    for(const [deny,restore] of attempts){await query(deny)
      await assert.rejects(storage.postgresCustomerFolderStore(editor).read(scope),/account_or_editor_unavailable/);await query(restore)}
  })
  await check('actual SQL rejects malformed/mismatched scope and reused root across customers',async()=>{
    const frozen=await store.read(scope)
    await assert.rejects(query("UPDATE crm_customer_drive_folders SET plan=plan-'scope'"),error=>error.code==='23514')
    await query(`INSERT INTO crm_organizations(id,pipeline_id,reference_code,workspace_organization_id,account_type,source_payload)
      VALUES($1,$2,$3,NULL,'Customer','{}')`,[id(4),scope.pipelineId,'ga7654321'])
    const other={...candidate('other'),scope:{...scope,accountId:id(4),accountGlobalId:'ga7654321'}}
    other.nodes[0].id=frozen.nodes[0].id
    await assert.rejects(store.reserve(other),error=>error.code==='23505')
    assert.deepEqual(await store.read(scope),frozen)
  })
  await query('DELETE FROM crm_customer_drive_folders')
  const initialDescription='Notes present before provisioning\nFractional Customer Folder: https://fractional.example.test/s/linked-customer'
  await query('UPDATE crm_organizations SET description=$1 WHERE id=$2',[initialDescription,scope.accountId])
  await check('manual BPO link blocks fresh reservation before any provider writes',async()=>{
    await query('UPDATE crm_organizations SET description=$1 WHERE id=$2',[initialDescription+'\nBPO Supply Chain Drive: https://bpo.example.test/s/manual',scope.accountId])
    await assert.rejects(store.reserve(candidate('manual-conflict')),/existing_link_requires_adoption/)
    assert.equal((await query('SELECT count(*) FROM crm_customer_drive_folders')).rows[0].count,'0')
    await query('UPDATE crm_organizations SET description=$1 WHERE id=$2',[initialDescription,scope.accountId])
  })
  // Real board graph/projection: one managed workspace account parents the
  // customer. No dummy tasks or alternate CRM identity are introduced.
  await query(`INSERT INTO crm_organizations(id,pipeline_id,reference_code,workspace_organization_id,account_type,source_payload,name)
    VALUES($1,$2,'ga0000005',$3,'Customer','{}','BPO Supply Chain')`,[id(5),scope.pipelineId,scope.workspaceId])
  await query('UPDATE crm_organizations SET parent_organization_id=$1 WHERE id=$2',[id(5),scope.accountId])
  await query("INSERT INTO project_boards VALUES($1,$2,$3,'CRM Board')",[id(6),owner,scope.workspaceId])
  await query('INSERT INTO crm_board_projections VALUES($1,$2,$3)',[id(6),scope.pipelineId,scope.workspaceId])
  const projections=load('app_src/lib/crm/boardProjection.ts',{'@/lib/persistence/postgres':postgres,
    '@/lib/persistence/config':{isPostgresStorageEnabled:()=>true},'@/lib/persistence/crmNativeEmailAuthority':authority,
    '@/lib/persistence/crm':{...crm,ensurePipelineCrmReferenceLinks:async()=>{}},
    '@/lib/crm/boardCard.mjs':{normalizeCrmBoardCard},'@/lib/htmlEntities.mjs':{decodeHtmlEntities},
    '@/lib/shortlinks':{shortLinkUrl:code=>`https://fixture.example.test/s/${code}`}})
  await projections.reconcileCrmBoardProjectionsForPipeline({pipelineId:scope.pipelineId})
  await query(`UPDATE crm_board_cards SET payload=jsonb_set(payload,'{comments}','[{"id":"preserve-comment","text":"Private card note"}]')
    WHERE entity_id=$1`,[scope.accountId])
  const card=async()=> (await query("SELECT payload FROM crm_board_cards WHERE entity_id=$1",[scope.accountId])).rows[0].payload
  let nextId=0,loseReply=false,creates=0
  const files=new Map([[scope.customersParentId,{id:scope.customersParentId,name:'01 Customers',mimeType:'application/vnd.google-apps.folder',
    driveId:scope.sharedDriveId,parents:[scope.sharedDriveId],trashed:false}]])
  const drive={get:async id=>structuredClone(files.get(id)??null),namedChildren:async(parent,name)=>
    [...files.values()].filter(f=>f.parents.includes(parent)&&f.name===name),
    generateIds:async count=>Array.from({length:count},()=>`durable-${++nextId}`),create:async input=>{
      const reserved=await query('SELECT plan,status FROM crm_customer_drive_folders')
      assert.equal(reserved.rows.filter(row=>row.plan.nodes.some(n=>n.id===input.id)).length,1,
        'provider create follows one exact COMMITTED reservation');creates++
      files.set(input.id,{id:input.id,name:input.name,mimeType:'application/vnd.google-apps.folder',driveId:scope.sharedDriveId,
        parents:[input.parentId],trashed:false,appProperties:input.properties})
      if(loseReply){loseReply=false;throw Error('synthetic lost provider response')}
    }}
  let failCardReconcile=false
  const provisioning=load('app_src/lib/crm/customerFolderProvisioning.ts',{'./customerDriveFolders':core,
    './customerDriveFolderGoogle':{customerFolderGoogleDrive:()=>drive,
      resolveCustomerFolderGoogleRuntime:async(parent,binding)=>{
        assert.equal(parent,scope.customersParentId)
        assert.deepEqual(binding,{serviceAccountEmail:scope.serviceAccountEmail,sharedDriveId:scope.sharedDriveId});return {fixture:true}}},
    '@/lib/persistence/crmCustomerFolders':storage,'./boardProjection':{reconcileCrmBoardProjectionsForPipeline:async input=>{
      if(failCardReconcile)throw Error('synthetic card reconciliation failure')
      return projections.reconcileCrmBoardProjectionsForPipeline(input)}}})
  const run=()=>provisioning.provisionCustomerAccountFolder({scope,customerName:'Globus',actorEmail:owner})
  await check('rolled-back reservation prevents every provider create',async()=>{
    rollbackReservation=true;await assert.rejects(run(),/transaction rollback/);rollbackReservation=false
    assert.equal(creates,0);assert.equal((await query('SELECT count(*) FROM crm_customer_drive_folders')).rows[0].count,'0')
  })
  await check('lost provider response leaves durable reservation and resumes the same folder IDs',async()=>{
    loseReply=true;await assert.rejects(run(),/lost provider response/)
    const before=(await query('SELECT plan,status FROM crm_customer_drive_folders')).rows[0]
    assert.equal(before.status,'reserved');assert.equal(creates,1)
    rollbackPublication=true;await assert.rejects(run(),/publication transaction rollback/);rollbackPublication=false
    assert.equal((await query('SELECT status FROM crm_customer_drive_folders')).rows[0].status,'reserved')
    assert.equal((await query('SELECT count(*) FROM sync_outbox')).rows[0].count,'0')
    assert.equal((await query('SELECT count(*) FROM audit_events')).rows[0].count,'0')
    assert.equal((await card()).desc,initialDescription)
    failCardReconcile=true;await assert.rejects(run(),/card reconciliation failure/);failCardReconcile=false
    assert.equal((await query('SELECT status FROM crm_customer_drive_folders')).rows[0].status,'ready')
    assert.equal((await query('SELECT count(*) FROM sync_outbox')).rows[0].count,'1')
    assert.equal((await card()).desc,initialDescription,'card failure cannot fabricate projection success')
    const completed=await run();assert.equal(completed.rootId,before.plan.nodes[0].id)
    const after=(await query('SELECT plan,status,verified_at FROM crm_customer_drive_folders')).rows[0]
    assert.deepEqual(after.plan,before.plan);assert.equal(after.status,'ready');assert.ok(after.verified_at)
    assert.equal(creates,8);assert.equal(files.size,9)
    await run();assert.equal(creates,8)
  })
  await check('real CRM/outbox/audit/card publication commits once and preserves identity, notes and Fractional URL',async()=>{
    const organization=(await query('SELECT * FROM crm_organizations WHERE id=$1',[scope.accountId])).rows[0]
    const outbox=(await query('SELECT * FROM sync_outbox')).rows
    assert.equal(outbox.length,1);assert.equal(outbox[0].aggregate_id,scope.accountId)
    assert.equal(outbox[0].target_system,'suitecrm');assert.equal(outbox[0].status,'queued')
    assert.equal(outbox[0].payload.attributes.global_id_c,scope.accountGlobalId)
    assert.equal(outbox[0].payload.attributes.description,organization.description)
    assert.equal(organization.reference_code,scope.accountGlobalId);assert.ok(organization.description.startsWith(initialDescription))
    assert.equal(links.parseCustomerFolderLinks(organization.description).values.fractionalCustomerFolderUrl,'https://fractional.example.test/s/linked-customer')
    const projected=await card();assert.equal(projected.desc,organization.description)
    assert.equal(projected.crm.referenceCode,scope.accountGlobalId);assert.equal(projected.comments[0].id,'preserve-comment')
    assert.equal((await query('SELECT count(*) FROM audit_events')).rows[0].count,'1')
  })
  await check('manual replacement and removal survive provisioning retries and appear on the real card',async()=>{
    for(const description of [initialDescription+'\nBPO Supply Chain Drive: https://bpo.example.test/s/operator-override',initialDescription]){
      await query('UPDATE crm_organizations SET description=$1 WHERE id=$2',[description,scope.accountId])
      await run();assert.equal((await card()).desc,description)
      assert.equal((await query('SELECT description FROM crm_organizations WHERE id=$1',[scope.accountId])).rows[0].description,description)
      assert.equal((await query('SELECT publication_status FROM crm_customer_drive_folders')).rows[0].publication_status,'manual_override')
      assert.equal((await query('SELECT count(*) FROM sync_outbox')).rows[0].count,'1')
      assert.equal((await query('SELECT count(*) FROM audit_events')).rows[0].count,'1')
      assert.equal(creates,8)
    }
  })
  const jobPersistence=load('app_src/lib/persistence/crmCustomerFolderJobs.ts',{'./postgres':postgres,'../crm/customerDriveFolders':core})
  await check('new-account trigger is opt-in, skips old-account edits, suppliers, demo and non-app sources, and rolls back with account',async()=>{
    assert.equal((await query('SELECT count(*) FROM crm_customer_folder_jobs')).rows[0].count,'0')
    await query(`INSERT INTO crm_customer_folder_settings(workspace_id,shared_drive_id,customers_parent_id,service_account_email,parent_name,enabled,revision,updated_by)
      VALUES($1,$2,$3,$4,'01 Customers',true,1,$5)`,[scope.workspaceId,scope.sharedDriveId,scope.customersParentId,scope.serviceAccountEmail,owner])
    await query(`UPDATE crm_organizations SET source_payload='{"source":"clawpilot"}',updated_by=$1 WHERE id=$2`,[owner,scope.accountId])
    assert.equal((await query('SELECT count(*) FROM crm_customer_folder_jobs')).rows[0].count,'0','editing an old customer does not backfill')
    const insert=async(n,type='Customer',payload={source:'clawpilot'},tx=pool)=>tx.query(`INSERT INTO crm_organizations(
      id,pipeline_id,reference_code,account_type,source_payload,updated_by,parent_organization_id,name)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,[id(n),scope.pipelineId,`ga${String(n).padStart(7,'0')}`,type,JSON.stringify(payload),owner,id(5),`Customer ${n}`])
    await insert(8);await insert(10,'Supplier');await insert(12,'Customer',{source:'external'})
    await query('UPDATE workspace_organizations SET is_demo=true WHERE id=$1',[scope.workspaceId]);await insert(11)
    await query('UPDATE workspace_organizations SET is_demo=false WHERE id=$1',[scope.workspaceId])
    await query('UPDATE crm_customer_folder_settings SET enabled=false');await insert(13)
    await query('UPDATE crm_customer_folder_settings SET enabled=true')
    await assert.rejects(withTransaction(async tx=>{await insert(9,'Customer',{source:'clawpilot'},tx);throw Error('new account rollback')}),/new account rollback/)
    assert.deepEqual((await query('SELECT account_id::text FROM crm_customer_folder_jobs ORDER BY account_id')).rows,[{account_id:id(8)}])
    await query("UPDATE crm_organizations SET account_type='Customer' WHERE id=$1",[id(10)])
    assert.equal((await query('SELECT count(*) FROM crm_customer_folder_jobs')).rows[0].count,'2','explicit supplier-to-customer conversion queues once')
    await query('UPDATE crm_organizations SET description=$1,source_payload=source_payload WHERE id=$2',['Later notes',id(8)])
    assert.equal((await query('SELECT count(*) FROM crm_customer_folder_jobs')).rows[0].count,'2')
  })
  let claimed
  await check('actual job claims serialize, conditional settlement rejects a foreign lease, and config drift holds context',async()=>{
    claimed=await Promise.all([jobPersistence.claimCustomerFolderJob(),jobPersistence.claimCustomerFolderJob()])
    assert.equal(new Set(claimed.map(job=>job.account_id)).size,2)
    for(const job of claimed){assert.equal((await jobPersistence.customerFolderJobContext(job)).scope.accountId,job.account_id)
      assert.equal(await jobPersistence.settleCustomerFolderJob({...job,lock_token:randomUUID()},{status:'ready'}),false)}
    assert.equal(await jobPersistence.claimCustomerFolderJob(),null)
    await query('UPDATE crm_customer_folder_settings SET revision=2')
    await assert.rejects(jobPersistence.customerFolderJobContext(claimed[0]),/configuration_or_lease_changed/)
    for(const job of claimed)assert.equal(await jobPersistence.settleCustomerFolderJob(job,{status:'held',errorCode:'customer_folder_configuration_or_lease_changed'}),true)
    await query('UPDATE crm_customer_folder_settings SET revision=1')
  })
  await check('actual worker processes a new triggered customer through provider reservation, CRM/outbox/audit and Project card',async()=>{
    await query(`INSERT INTO crm_organizations(id,pipeline_id,reference_code,account_type,source_payload,updated_by,parent_organization_id,name)
      VALUES($1,$2,'ga0000014','Customer','{"source":"clawpilot"}',$3,$4,'Customer 14')`,[id(14),scope.pipelineId,owner,id(5)])
    const worker=load('app_src/lib/crm/customerFolderJobs.ts',{'@/lib/persistence/crmCustomerFolderJobs':jobPersistence,
      '@/lib/integrations/googleWorkspaceClient':{GoogleWorkspaceClientError:class{}},
      './customerDriveFolders':core,'./customerFolderProvisioning':provisioning})
    const result=await worker.processCustomerFolderJobs({limit:1})
    assert.deepEqual(result,{claimed:1,ready:1,queued:0,held:0,leaseLost:0})
    const reservation=(await query('SELECT * FROM crm_customer_drive_folders WHERE account_id=$1',[id(14)])).rows[0]
    assert.equal(reservation.status,'ready');assert.equal(reservation.publication_status,'published')
    const organization=(await query('SELECT description FROM crm_organizations WHERE id=$1',[id(14)])).rows[0]
    const projected=(await query("SELECT payload FROM crm_board_cards WHERE entity_id=$1",[id(14)])).rows[0].payload
    assert.equal(projected.desc,organization.description);assert.equal(projected.crm.referenceCode,'ga0000014')
    const outbox=(await query('SELECT payload FROM sync_outbox WHERE aggregate_id=$1',[id(14)])).rows
    assert.equal(outbox.length,1);assert.equal(outbox[0].payload.attributes.description,organization.description)
    assert.equal((await query('SELECT status FROM crm_customer_folder_jobs WHERE account_id=$1',[id(14)])).rows[0].status,'ready')
    assert.equal(creates,16)
    assert.deepEqual(await worker.processCustomerFolderJobs(),{claimed:0,ready:0,queued:0,held:0,leaseLost:0})
    assert.equal(creates,16)
  })
  const controlContract=load('app_src/lib/crm/customerFolderControls.ts')
  const controls=load('app_src/lib/persistence/crmCustomerFolderControls.ts',{'./postgres':postgres,
    '@/lib/auditWriter':audit,'../crm/customerDriveFolders':core,'../crm/customerFolderControls':controlContract,
    '../crm/customerFolderLinks':links})
  const controlInput={pipelineId:scope.pipelineId,accountId:scope.accountId,actorEmail:owner}
  const configuration={...controlInput,parentId:scope.customersParentId,sharedDriveId:scope.sharedDriveId,
    serviceAccountEmail:scope.serviceAccountEmail,enabled:true,expectedRevision:1}
  await check('real control reads are scoped, minimal and show manual override; member editors cannot configure',async()=>{
    const state=await controls.readCustomerFolderControls(controlInput)
    assert.equal(state.account.globalId,scope.accountGlobalId);assert.equal(state.canConfigure,true)
    assert.equal(state.folder.publicationStatus,'manual_override')
    assert.ok(!JSON.stringify(state).includes('serviceAccount'));assert.ok(!JSON.stringify(state).includes(owner))
    const member=await controls.readCustomerFolderControls({...controlInput,actorEmail:editor})
    assert.equal(member.canEdit,true);assert.equal(member.canConfigure,false)
    await assert.rejects(controls.saveVerifiedCustomerFolderSettings({...configuration,actorEmail:editor}),/admin_required/)
    await query("UPDATE app_user_organization_memberships SET role='admin' WHERE user_email=$1",[editor])
    assert.equal((await controls.readCustomerFolderControls({...controlInput,actorEmail:editor})).canConfigure,false,
      'a workspace administrator cannot choose arbitrary parents accessible to the global service account')
    await assert.rejects(controls.saveVerifiedCustomerFolderSettings({...configuration,actorEmail:editor}),/admin_required/)
    await query("UPDATE app_user_organization_memberships SET role='member' WHERE user_email=$1",[editor])
    await assert.rejects(controls.readCustomerFolderControls({...controlInput,pipelineId:id(99)}),/access_denied/)
    await query("UPDATE pipeline_space_members SET access_role='viewer' WHERE user_email=$1",[editor])
    const viewer=await controls.readCustomerFolderControls({...controlInput,actorEmail:editor})
    assert.equal(viewer.canEdit,false);assert.equal(viewer.canConfigure,false)
    await query("UPDATE pipeline_space_members SET access_role='editor' WHERE user_email=$1",[editor])
  })
  await check('real setup CAS commits once, replays lost response once, and serializes conflicting administrator forms',async()=>{
    await controls.saveVerifiedCustomerFolderSettings(configuration)
    await controls.saveVerifiedCustomerFolderSettings(configuration)
    assert.equal((await controls.readCustomerFolderControls(controlInput)).settings.revision,2)
    const attempts=await Promise.allSettled(['parent-A','parent-B'].map(parentId=>controls.saveVerifiedCustomerFolderSettings(
      {...configuration,parentId,expectedRevision:2})))
    assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1)
    assert.equal(attempts.filter(row=>row.status==='rejected').length,1)
    await controls.saveVerifiedCustomerFolderSettings({...configuration,expectedRevision:3})
    assert.equal((await controls.readCustomerFolderControls(controlInput)).settings.revision,4)
  })
  await check('real exact customer request is idempotent; stale forms, changed adoption and live lease cannot reset it',async()=>{
    const request={action:'queue',pipelineId:scope.pipelineId,accountId:id(8),actorEmail:owner,expectedRevision:4,
      expectedJobVersion:0,requestKey:id(30)}
    await controls.requestCustomerFolderJob(request);await controls.requestCustomerFolderJob(request)
    const state=await controls.readCustomerFolderControls({...controlInput,accountId:id(8)})
    assert.equal(state.job.version,1);assert.equal(state.job.status,'queued')
    assert.equal((await query("SELECT count(*) FROM audit_events WHERE event_type='crm.customer_folders.requested'")).rows[0].count,'1')
    await assert.rejects(controls.requestCustomerFolderJob({...request,requestKey:id(31)}),/job_changed/)
    await assert.rejects(controls.requestCustomerFolderJob({...request,adoptRootId:'different-root'}),/request_changed/)
    const claimed=await jobPersistence.claimCustomerFolderJob()
    assert.equal(claimed.account_id,id(8))
    const before=(await query('SELECT * FROM crm_customer_folder_jobs WHERE account_id=$1',[id(8)])).rows[0]
    await controls.requestCustomerFolderJob(request)
    assert.deepEqual((await query('SELECT * FROM crm_customer_folder_jobs WHERE account_id=$1',[id(8)])).rows[0],before)
    await assert.rejects(controls.requestCustomerFolderJob({...request,expectedJobVersion:1,requestKey:id(31)}),/job_busy/)
    assert.equal(await jobPersistence.settleCustomerFolderJob(claimed,{status:'held',errorCode:'customer_folder_processing_held'}),true)
    await controls.requestCustomerFolderJob({...request,expectedJobVersion:1,requestKey:id(31),adoptRootId:'explicit-manual-root'})
    assert.equal((await controls.readCustomerFolderControls({...controlInput,accountId:id(8)})).job.version,2)
    await assert.rejects(controls.requestCustomerFolderJob({...request,actorEmail:editor,expectedJobVersion:2,requestKey:id(32),accountId:id(5)}),/customer_editor_required/)
  })
  await check('pausing existing settings changes no parent or prior folder and disables automatic enqueue without backfill',async()=>{
    const before=(await query('SELECT plan FROM crm_customer_drive_folders ORDER BY account_id')).rows
    await controls.pauseCustomerFolderSettings({...controlInput,parentId:scope.customersParentId,expectedRevision:4})
    await controls.pauseCustomerFolderSettings({...controlInput,parentId:scope.customersParentId,expectedRevision:4})
    const state=await controls.readCustomerFolderControls(controlInput)
    assert.equal(state.settings.enabled,false);assert.equal(state.settings.revision,5)
    const jobsBefore=(await query('SELECT count(*) FROM crm_customer_folder_jobs')).rows[0].count
    await query(`INSERT INTO crm_organizations(id,pipeline_id,reference_code,account_type,source_payload,updated_by,parent_organization_id,name)
      VALUES($1,$2,'ga0000015','Customer','{"source":"clawpilot"}',$3,$4,'Customer 15')`,[id(15),scope.pipelineId,owner,id(5)])
    assert.equal((await query('SELECT count(*) FROM crm_customer_folder_jobs')).rows[0].count,jobsBefore)
    await controls.saveVerifiedCustomerFolderSettings({...configuration,expectedRevision:5})
    assert.equal((await query('SELECT count(*) FROM crm_customer_folder_jobs')).rows[0].count,jobsBefore)
    assert.deepEqual((await query('SELECT plan FROM crm_customer_drive_folders ORDER BY account_id')).rows,before)
  })
  await check('revocation before read/complete prevents use or completion of a stored plan',async()=>{
    const plan=await store.read(scope)
    const beforeCreates=creates
    await query("UPDATE app_users SET status='disabled' WHERE email=$1",[owner])
    await assert.rejects(run(),/account_or_editor_unavailable/)
    await assert.rejects(store.complete(plan),/account_or_editor_unavailable/)
    assert.equal(creates,beforeCreates)
  })
  console.log(`${passed} customer folder PostgreSQL checks passed (actual CRM/outbox/audit/card; synthetic Drive; minimal app schema; shortlink maintenance excluded)`)
}finally{try{if(pool)await pool.end()}finally{
  if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{timeout:30000,stdio:'pipe'})
}}
