#!/usr/bin/env node
// Actual claim SQL, authority migrations, audience and role logic. Synthetic
// mailbox/source data only; no native server, provider, session or deployment proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'
import {loadNativeRootReaderFixtureModules} from './lib/native-root-reader-fixture-modules.mjs'
assert.deepEqual(process.argv.slice(2),['--postgres'],'Explicit --postgres required')
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript'),{Pool}=require('pg')
function run(source,deps={}) {
  const module={exports:{}}
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{
    assert.ok(Object.hasOwn(deps,name),`Unexpected dependency ${name}`);return deps[name]})
  return module.exports
}
const source=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8')
const load=(path,deps)=>run(source(path),deps)
function declarations(path,names) {
  const ast=ts.createSourceFile(path,source(path),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
  return names.map(name=>{
    const node=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name
      ||ts.isVariableStatement(node)&&node.declarationList.declarations.some(value=>value.name.getText(ast)===name))
    assert.ok(node,`Actual ${name} must exist`);return node.getText(ast)
  }).join('\n')
}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const eligibility=load('app_src/lib/crm/nativeEmailEligibility.ts',{'./nativeEmailPublication':protocol})
const stable=load('app_src/lib/crm/stableId.ts',{'node:crypto':crypto})
const projection=load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts',{'node:crypto':crypto})
const roots=loadNativeRootReaderFixtureModules(load,protocol)
const audienceApi=run(`import {suiteCrmEmailAudienceFingerprint} from 'projection';\nimport {nativeEmailPrincipalIsEligible,nativeEmailEffectivePipelinePrincipals} from 'eligibility';\nimport {collectNativeEmailRootSourcesWithClient,projectNativeEmailRootReaders} from 'roots';\n`
  +declarations('app_src/lib/users.ts',['OWNER_PERMISSIONS','normalizePermissions','permissionsForRole'])+'\n'
  +declarations('app_src/lib/persistence/crm.ts',['reviewedEmailAudienceUnderNativeControlWithClient']),{projection,eligibility,roots})
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const hash=value=>crypto.createHash('sha256').update(value).digest('hex')
const selection={ownerEmail:'owner@example.test',workspaceId:id(1),pipelineId:id(2),connectionId:id(3),messageIds:['a1','a2','a3']}
const container=`clawpilot-exact-email-${process.pid}-${crypto.randomUUID().slice(0,8)}`
const image=process.env.CLAWPILOT_TEST_POSTGRES_IMAGE||'pgvector/pgvector:pg16'
assert.match(image,/^pgvector\/pgvector:pg(?:16|18)$/u,'Use an already cached approved image')
const checks=[]
async function check(name,fn){await fn();checks.push(name);console.log(`PASS ${name}`)}
let pool,started=false
try {
  execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
    '-e','POSTGRES_PASSWORD=exact_email_fixture','-e','POSTGRES_DB=exact_email_fixture','-p','127.0.0.1::5432',image]),
  {timeout:60000,stdio:'pipe'});started=true
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
  assert.ok(port)
  pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'exact_email_fixture',database:'exact_email_fixture',
    ssl:false,max:3,connectionTimeoutMillis:1000,statement_timeout:5000})
  const deadline=Date.now()+30000
  while(true){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>=deadline)throw error;await new Promise(r=>setTimeout(r,100))}}
  assert.equal((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count,'0')
  const query=(sql,params)=>pool.query(sql,params)
  const withTransaction=async fn=>{const tx=await pool.connect();try{await tx.query('BEGIN');const value=await fn(tx);await tx.query('COMMIT');return value}
    catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}}
  await query(`CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,organization_id uuid);
    CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean NOT NULL DEFAULT false);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean DEFAULT false);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,shared_by text,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,
      PRIMARY KEY(user_email,organization_id));
    CREATE TABLE user_maton_connections(owner_email text,connection_id text,app text,source text,status text,is_selected boolean,account_email text,remote_updated_at timestamptz);
    CREATE TABLE crm_email_mailboxes(id uuid PRIMARY KEY,owner_email text,provider text);
    CREATE TABLE crm_email_mailbox_bindings(owner_email text,connection_id text,mailbox_id uuid REFERENCES crm_email_mailboxes(id),account_email text,verified_at timestamptz,
      PRIMARY KEY(owner_email,connection_id));
    CREATE TABLE crm_email_sources(id uuid PRIMARY KEY,mailbox_id uuid REFERENCES crm_email_mailboxes(id),owner_email text,
      provider_message_id text,provider_thread_id text,evidence_hash text,UNIQUE(mailbox_id,provider_message_id));
    CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,canonical_source_id uuid REFERENCES crm_email_sources(id),
      provider_message_id text,provider_thread_id text,suitecrm_id text,reference_code text,suitecrm_module text,source_hash text,source_payload jsonb DEFAULT '{}',
      suitecrm_synced_at timestamptz,sync_status text DEFAULT 'pending',sync_error text,metadata jsonb DEFAULT '{}',updated_at timestamptz DEFAULT now(),
      UNIQUE(pipeline_id,canonical_source_id));
    CREATE TABLE sync_outbox(id uuid PRIMARY KEY,aggregate_type text,aggregate_id text,operation text,target_system text,payload jsonb,
      status text DEFAULT 'queued',attempts integer DEFAULT 0,idempotency_key text,lock_token text,locked_at timestamptz,
      available_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(target_system,idempotency_key));
    INSERT INTO workspace_organizations VALUES('${id(1)}',false);
    INSERT INTO app_users VALUES('owner@example.test','active','owner-native','owner','{}','${id(1)}');
    INSERT INTO app_user_organization_memberships VALUES('owner@example.test','${id(1)}','active','owner','{}',NULL);
    INSERT INTO pipeline_spaces(id,owner_email,workspace_organization_id) VALUES('${id(2)}','owner@example.test','${id(1)}');
    INSERT INTO user_maton_connections VALUES('owner@example.test','${id(3)}','google-mail','maton','ACTIVE',true,'mailbox@example.test',now()-interval '1 hour');
    INSERT INTO crm_email_mailboxes VALUES('${id(4)}','owner@example.test','gmail');
    INSERT INTO crm_email_mailbox_bindings VALUES('owner@example.test','${id(3)}','${id(4)}','mailbox@example.test',now());`)
  for(const name of ['0375_crm_native_email_publication_admission.sql','0376_crm_native_email_publication_work_context.sql',
    '0377_crm_native_email_authority_transitions.sql','0378_crm_native_email_capability_policies.sql',
    '0379_crm_native_email_app_only_lifecycle.sql','0380_crm_native_email_grant_attempts.sql',
    '0381_crm_native_email_identity_quiescence.sql','0392_crm_root_employee_access_registry.sql']) {
    await withTransaction(tx=>tx.query(source(`db/migrations/${name}`)))
  }
  const api=load('app_src/lib/persistence/crmExactEmailPublication.ts',{'node:crypto':crypto,'./postgres':{withTransaction},
    './crm':audienceApi,'../crm/stableId':stable,'../crm/nativeEmailPublication':protocol})
  const audience=await withTransaction(async tx=>{await tx.query('SELECT * FROM crm_native_email_publication_control FOR UPDATE')
    return audienceApi.reviewedEmailAudienceUnderNativeControlWithClient(tx,id(2))})
  for(let n=1;n<=4;n++) {
    const sourceHash=hash(`source-${n}`),localId=id(20+n)
    await query('INSERT INTO crm_email_sources VALUES($1,$2,$3,$4,$5,$6)',[id(10+n),id(4),selection.ownerEmail,`a${n}`,'b1',hash(`evidence-${n}`)])
    await query(`INSERT INTO crm_interactions(id,pipeline_id,canonical_source_id,provider_message_id,provider_thread_id,suitecrm_id,reference_code,suitecrm_module,source_hash)
      VALUES($1,$2,$3,$4,'b1',$5,$6,'Emails',$7)`,[localId,id(2),id(10+n),`a${n}`,id(30+n),`gi123456${n}`,sourceHash])
    const payload={entity:'interactions',localId,pipelineId:id(2),suiteCrmId:id(30+n),suiteCrmModule:'Emails',
      attributes:{global_id_c:`gi123456${n}`,assigned_user_id:'owner-native'},emailProjection:{audience}}
    await query(`INSERT INTO sync_outbox(id,aggregate_type,aggregate_id,operation,target_system,payload,idempotency_key)
      VALUES($1,'crm_interactions',$2,'upsert_record','suitecrm',$3::jsonb,$4)`,
    [id(40+n),localId,JSON.stringify(payload),`crm:interactions:v4:${localId}:Emails:${sourceHash}`])
  }
  const queue=async()=> (await query('SELECT id,status,attempts,lock_token,payload FROM sync_outbox ORDER BY id')).rows
  await check('disabled authority cannot preview or claim; no legacy fallback',async()=>{
    await assert.rejects(api.previewExactEmailPublicationInPostgres(selection),/unavailable or changed/)
    assert.ok((await queue()).every(row=>row.status==='queued'&&row.attempts===0))
  })
  await query(`UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,
    native_policy_fingerprint=$1,activation_receipt_hash=$2`,[hash('synthetic policy'),hash('synthetic activation')])
  let preview
  await check('real audience and SQL preview returns only exact messages without changing queue',async()=>{
    preview=await api.previewExactEmailPublicationInPostgres(selection)
    assert.deepEqual(preview.messages.map(row=>row.messageId),selection.messageIds)
    assert.ok((await queue()).every(row=>row.status==='queued'&&row.attempts===0))
  })
  await check('real concurrent claims serialize; exactly one claims three and unrelated row never changes',async()=>{
    const before=(await queue())[3]
    const outcomes=await Promise.allSettled([api.claimExactEmailPublicationInPostgres(selection,preview.digest),
      api.claimExactEmailPublicationInPostgres(selection,preview.digest)])
    assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1)
    const result=outcomes.find(row=>row.status==='fulfilled').value
    assert.deepEqual(result.items.map(row=>row.id),[id(41),id(42),id(43)])
    assert.deepEqual((await queue())[3],before)
    assert.ok((await queue()).slice(0,3).every(row=>row.attempts===1&&row.status==='processing'))
  })
  await check('same-revision terminal-success replay is a no-op and not native delivery proof',async()=>{
    await query("UPDATE sync_outbox SET status='succeeded',lock_token=NULL WHERE id=ANY($1::uuid[])",[[id(41),id(42),id(43)]])
    const result=await api.claimExactEmailPublicationInPostgres(selection,preview.digest)
    assert.equal(result.items.length,0);assert.equal(result.alreadyCompleted,3)
    assert.ok((await queue()).slice(0,3).every(row=>row.attempts===1))
  })
  await check('busy third item rolls back the complete batch before any claim',async()=>{
    await query("UPDATE sync_outbox SET status='queued' WHERE id=ANY($1::uuid[])",[[id(41),id(42)]])
    await query("UPDATE sync_outbox SET status='processing',lock_token='busy' WHERE id=$1",[id(43)])
    const before=await queue()
    await assert.rejects(api.claimExactEmailPublicationInPostgres(selection,preview.digest),/unavailable or changed/)
    assert.deepEqual(await queue(),before)
  })
  await check('changed JSONB source payload rejects old approval without touching selected leases',async()=>{
    await query("UPDATE sync_outbox SET payload=jsonb_set(payload,'{attributes,description}','\"new content\"'::jsonb) WHERE id=$1",[id(41)])
    const before=await queue()
    await assert.rejects(api.claimExactEmailPublicationInPostgres(selection,preview.digest),/unavailable or changed/)
    assert.deepEqual(await queue(),before)
  })
  await check('owner, workspace, mailbox and canonical source constraints cannot cross tenants',async()=>{
    const before=await queue()
    for(const mutation of [{ownerEmail:'other@example.test'},{workspaceId:id(999)},{pipelineId:id(999)},
      {connectionId:id(999)},{messageIds:['a1','a2','ff']}]) {
      await assert.rejects(api.previewExactEmailPublicationInPostgres({...selection,...mutation}),/unavailable or changed/)
    }
    assert.deepEqual(await queue(),before)
  })
  console.log(`PASS ${checks.length} exact publication real PostgreSQL groups; synthetic data, no provider/native/deployment proof`)
} finally {
  try{if(pool)await pool.end()}
  finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{timeout:30000,stdio:'pipe'})}
}
