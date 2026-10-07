#!/usr/bin/env node
// Real migrations and production gateway/staging SQL; no .env/provider access.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {readdirSync,readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import {disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs} from './lib/disposable-postgres-docker.mjs'
import {applyMigrationSqlForTest} from './lib/postgres-test-migrations.mjs'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),{Pool}=require('pg'),ts=require('typescript')
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8')
function load(path,deps={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(read(path),{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
 {module,exports:module.exports,Buffer,URL,URLSearchParams,Date,Error,Set,Map,process:{env:{}},require(name){if(Object.hasOwn(deps,name))return deps[name];if(name==='node:crypto')return require(name);return new Proxy({__esModule:true},{get(target,key){if(key==='__esModule')return true;return ()=>{throw new Error(`Unexpected integration dependency ${name}:${String(key)}`)}}})}}, {filename:path});return module.exports}
const container=`clawpilot-fractional-crm-test-${process.pid}-${randomUUID().slice(0,8)}`;let started=false,pool
try{
 execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never','-e','POSTGRES_PASSWORD=fractional_gateway_fixture','-e','POSTGRES_DB=fractional_gateway_fixture','-p','127.0.0.1::5432','pgvector/pgvector:pg16']),{timeout:60000,stdio:'pipe'});started=true
 const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1];assert.ok(port)
 pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'fractional_gateway_fixture',database:'fractional_gateway_fixture',ssl:false,max:6,connectionTimeoutMillis:1000,statement_timeout:15000})
 const deadline=Date.now()+30000;for(;;){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>deadline)throw error;await new Promise(resolve=>setTimeout(resolve,100))}}
 const client=await pool.connect();try{for(const file of readdirSync(new URL('../db/migrations/',import.meta.url)).filter(f=>/^\d+_.+\.sql$/u.test(f)).sort())await applyMigrationSqlForTest(client,file,read(`db/migrations/${file}`))}finally{client.release()}
 let beforeCommit=null
 const query=(sql,args)=>pool.query(sql,args),withTransaction=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);if(beforeCommit)await beforeCommit();await c.query('COMMIT');return result}catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}}
 const auth=load('app_src/lib/fractionalCrmGatewayAuth.ts'),model=load('app_src/lib/crm/fractionalGatewayModel.ts'),stable=load('app_src/lib/crm/stableId.ts')
 const audit=load('app_src/lib/auditWriter.ts',{'@/lib/persistence/postgres':{query},'next/headers':{headers:()=>{throw new Error('No browser context')}},'@/lib/authAttribution':{verifyAuthAttributionHeaders:()=>null}})
 const crm=load('app_src/lib/persistence/crm.ts',{'@/lib/crm/stableId':stable,'@/lib/persistence/postgres':{query,withTransaction},'@/lib/persistence/config':{isPostgresStorageEnabled:()=>true},'@/lib/publicUrl':{appPublicUrl:()=> 'https://clawpilot.example.invalid'},'@/lib/shortlinks':{shortLinkUrl:code=>`https://clawpilot.example.invalid/s/${code}`},'@/lib/auditWriter':audit})
 const gateway=load('app_src/lib/persistence/fractionalCrmGateway.ts',{'@/lib/persistence/postgres':{query,withTransaction},'@/lib/persistence/crm':crm,'@/lib/fractionalCrmGatewayAuth':auth,'@/lib/crm/fractionalGatewayModel':model})
 const org=randomUUID(),pipeline=randomUUID(),root=randomUUID(),instance=randomUUID(),deployment=randomUUID(),credentialId=randomUUID(),owner='gateway.owner@example.invalid'
 await pool.query("INSERT INTO app_users(email,role,status,activated_at) VALUES($1,'owner','active',now())",[owner])
 await pool.query("INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by) VALUES($1,'Gateway fixture','root',$2,$2)",[org,owner])
 await pool.query("INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,is_default,created_by,updated_by) VALUES($1,$2,'owner','active',true,$1,$1)",[owner,org])
 await pool.query("INSERT INTO pipeline_spaces(id,name,owner_email,is_default,workspace_organization_id) VALUES($1,'Gateway fixture',$2,true,$3)",[pipeline,owner,org])
 const ga=(await pool.query('SELECT reference_code FROM workspace_organizations WHERE id=$1',[org])).rows[0].reference_code
 await pool.query(`INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id,source_key,identity_key,reference_code,name,source_hash,workspace_organization_id,relationship_type,created_by,updated_by)
 VALUES($1::uuid,$2,$1::text,'gateway-root','gateway-root',$3,'Gateway root','root',$4,'workspace_root',$5,$5)`,[root,pipeline,ga,org,owner])
 const stage=fields=>withTransaction(c=>crm.stageCrmRecordWithClient(c,{entity:'organizations',pipelineId:pipeline,sourceKey:`seed:${randomUUID()}`,createOnly:true,identityKeyOverride:`seed:${randomUUID()}`,actorEmail:owner,fields:{name:fields.name,parentOrganizationId:root,...fields}}))
 const a=await stage({name:'Existing A',website:'https://existing-a.example.invalid'}),b=await stage({name:'Existing B'}),hidden=await stage({name:'Ungrant company'})
 const stageContact=(parent,name,email,extra={})=>withTransaction(c=>crm.stageCrmRecordWithClient(c,{entity:'contacts',pipelineId:pipeline,sourceKey:`seed:${randomUUID()}`,actorEmail:owner,fields:{organizationId:parent.id,organizationSuiteCrmId:parent.suiteCrmId,fullName:name,email,...extra}}))
 const ca=await stageContact(a,'Existing Contact','contact-a@example.invalid',{description:'Private note retained',emailOptOut:true,phoneMobile:'999'}),cb=await stageContact(b,'Other Contact','contact-b@example.invalid'),ch=await stageContact(hidden,'Hidden Contact','hidden@example.invalid')
 const capabilities=['crm.company.read','crm.contact.read','crm.company.write','crm.contact.write','crm.onboarding.write']
 await pool.query(`INSERT INTO fractional_crm_gateway_credentials(id,token_hash,source_instance_id,workspace_organization_id,pipeline_id,root_company_global_id,allowed_company_global_ids,capabilities,fractional_deployment_id,fractional_organization_id,actor_email,expires_at,enabled)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'fractional-fixture',$10,now()+interval '1 hour',true)`,[credentialId,'a'.repeat(64),instance,org,pipeline,ga,[a.referenceCode,b.referenceCode],capabilities,deployment,owner])
 let principal=await gateway.readFractionalCrmCredential(credentialId),checks=0
 const check=(condition,message)=>{assert.ok(condition,message);checks++},denied=async(fn,code)=>{await assert.rejects(fn,error=>error.code===code);checks++}
 const before=(await pool.query('SELECT (SELECT count(*) FROM crm_organizations) AS companies,(SELECT count(*) FROM crm_contacts) AS contacts,(SELECT count(*) FROM sync_outbox) AS outbox')).rows[0]
 const company=await gateway.readFractionalCrmCompany(principal,a.referenceCode),contact=await gateway.readFractionalCrmContact(principal,a.referenceCode,ca.referenceCode)
 const after=(await pool.query('SELECT (SELECT count(*) FROM crm_organizations) AS companies,(SELECT count(*) FROM crm_contacts) AS contacts,(SELECT count(*) FROM sync_outbox) AS outbox')).rows[0];assert.deepEqual(after,before);checks++
 await denied(()=>gateway.readFractionalCrmCompany({...principal,pipelineId:randomUUID()},a.referenceCode),'CAPABILITY_DENIED')
 await denied(()=>gateway.readFractionalCrmCompany(principal,hidden.referenceCode),'RECORD_NOT_FOUND')
 await denied(()=>gateway.readFractionalCrmContact(principal,a.referenceCode,cb.referenceCode),'RECORD_NOT_FOUND')
 check((await gateway.listFractionalCrmContacts(principal,a.referenceCode,{limit:1})).items[0].globalId===ca.referenceCode,'contact paging stays within company')
 const companyAlias=`ga${randomUUID().replaceAll('-','').slice(0,12)}`
 await pool.query('INSERT INTO crm_reference_number_registry(number_value) VALUES($1)',[companyAlias.slice(2)])
 await pool.query("INSERT INTO crm_reference_registry(reference_code,prefix,canonical_code,status,entity_type) SELECT $1,prefix,reference_code,'alias',entity_type FROM crm_reference_registry WHERE reference_code=$2",[companyAlias,a.referenceCode])
 const aliased=await gateway.readFractionalCrmCompany(principal,companyAlias);check(aliased.globalId===a.referenceCode&&aliased.resolution.status==='alias','registry canonical alias resolves only to granted record')
 const retiredParent=await stage({name:'Retired intermediate'}),retiredChild=await stage({name:'Child under retired parent',parentOrganizationId:retiredParent.id})
 await pool.query('UPDATE fractional_crm_gateway_credentials SET allowed_company_global_ids=array_append(allowed_company_global_ids,$2) WHERE id=$1',[credentialId,retiredChild.referenceCode])
 await pool.query("UPDATE crm_organizations SET source_payload=jsonb_set(source_payload,'{archived}','true') WHERE id=$1",[retiredParent.id])
 await denied(()=>gateway.readFractionalCrmCompany(principal,retiredChild.referenceCode),'RECORD_NOT_FOUND')
 const actor={userId:'fractional-operator',organizationId:'fractional-fixture',customerId:'local-a'},patch={ifMatch:contact.version,idempotencyKey:'gateway-patch-one',fields:{phone:'123',jobTitle:'Operations'},assertedFractionalActor:actor}
 const updated=await gateway.updateFractionalCrmContact(principal,a.referenceCode,ca.referenceCode,patch);check(updated.fields.phone==='123','conditional update applies canonical field')
 const old=(await pool.query('SELECT description,email_opt_out,phone_mobile FROM crm_contacts WHERE id=$1',[ca.id])).rows[0];check(old.description==='Private note retained'&&old.email_opt_out&&old.phone_mobile==='999','nonwritable private metadata remains unchanged')
 check((await gateway.updateFractionalCrmContact(principal,a.referenceCode,ca.referenceCode,patch)).version===updated.version,'same request retries original receipt')
 await denied(()=>gateway.updateFractionalCrmContact(principal,a.referenceCode,ca.referenceCode,{...patch,idempotencyKey:'gateway-stale-one'}),'VERSION_CONFLICT')
 await denied(()=>gateway.updateFractionalCrmContact(principal,a.referenceCode,ca.referenceCode,{...patch,fields:{phone:'other'}}),'IDEMPOTENCY_CONFLICT')
 await denied(()=>gateway.updateFractionalCrmContact(principal,a.referenceCode,ca.referenceCode,{...patch,ifMatch:updated.version,idempotencyKey:'gateway-foreign-email',fields:{email:'contact-b@example.invalid'}}),'CONTACT_RELATIONSHIP_REVIEW')
 await denied(()=>gateway.updateFractionalCrmContact(principal,a.referenceCode,ca.referenceCode,{...patch,ifMatch:updated.version,idempotencyKey:'gateway-hidden-email',fields:{email:'hidden@example.invalid'}}),'IDENTITY_CONFLICT')
 check((await pool.query('SELECT organization_id FROM crm_contacts WHERE id=$1',[ch.id])).rows[0].organization_id===hidden.id,'hidden contact never reparents')
 const blankContact=await stageContact(b,'Blank Email Contact',''),clearable=await stageContact(a,'Clearable Contact','clearable@example.invalid')
 const clearBefore=await gateway.readFractionalCrmContact(principal,a.referenceCode,clearable.referenceCode),clearPatch={...patch,ifMatch:clearBefore.version,idempotencyKey:'gateway-clear-email',fields:{email:null}}
 const cleared=await gateway.updateFractionalCrmContact(principal,a.referenceCode,clearable.referenceCode,clearPatch)
 check(cleared.fields.email===null&&cleared.recordId===clearable.id&&cleared.companyGlobalId===a.referenceCode&&blankContact.id!==cleared.recordId,'blank email is not a cross-company identity; clearing preserves record and parent')
 check((await gateway.updateFractionalCrmContact(principal,a.referenceCode,clearable.referenceCode,clearPatch)).version===cleared.version,'null email clearing retries its immutable receipt')
 const liveAncestor=await stage({name:'Concurrent ancestor'}),liveChild=await stage({name:'Concurrent child',parentOrganizationId:liveAncestor.id})
 await pool.query('UPDATE fractional_crm_gateway_credentials SET allowed_company_global_ids=array_append(allowed_company_global_ids,$2) WHERE id=$1',[credentialId,liveChild.referenceCode])
 const liveBefore=await gateway.readFractionalCrmCompany(principal,liveChild.referenceCode)
 let notifyHeld,releaseHeld;const held=new Promise(r=>notifyHeld=r),release=new Promise(r=>releaseHeld=r)
 beforeCommit=async()=>{beforeCommit=null;notifyHeld();await release}
 const scopedWrite=gateway.updateFractionalCrmCompany(principal,liveChild.referenceCode,{...patch,ifMatch:liveBefore.version,idempotencyKey:'gateway-path-lock',fields:{phone:'321'}})
 await held;const native=await pool.connect(),nativePid=(await native.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
 let nativeCompleted=false;const nativeArchive=native.query("UPDATE crm_organizations SET source_payload=jsonb_set(source_payload,'{archived}','true') WHERE id=$1",[liveAncestor.id]).then(()=>{nativeCompleted=true})
 try{let waiting=false;for(let attempt=0;attempt<100;attempt++){const state=(await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[nativePid])).rows[0];if(state?.wait_event_type==='Lock'){waiting=true;break}if(nativeCompleted)break;await new Promise(r=>setTimeout(r,10))}
 check(waiting&&!nativeCompleted,'native ancestor archive waits until descendant conditional write commits')
 }finally{releaseHeld();await scopedWrite;await nativeArchive;native.release()}
 await denied(()=>gateway.readFractionalCrmCompany(principal,liveChild.referenceCode),'RECORD_NOT_FOUND')
 const attribution=(await pool.query("SELECT asserted_actor FROM fractional_crm_gateway_operations WHERE credential_id=$1 AND idempotency_key='gateway-patch-one'",[credentialId])).rows[0].asserted_actor
 check(attribution.userId===actor.userId&&attribution.organizationId===actor.organizationId,'immutable receipt retains asserted Fractional actor after later writes')
 const companyFields=name=>({companyName:name,website:null,email:null,phone:null,addressLine1:null,addressLine2:null,city:null,region:null,postalCode:null,countryCode:null})
 const request=(customerId,name,email,globalId=null)=>({schemaVersion:1,sourceInstanceId:instance,origin:{deploymentId:deployment,organizationId:'fractional-fixture',customerId,contactId:randomUUID(),onboardingId:randomUUID()},company:{globalId,verifiedIdentifiers:[],fields:companyFields(name)},contact:{globalId:null,fields:{displayName:'New Full Name',email,phone:null,jobTitle:null}},allowCreate:{company:true,contact:true},reviewDecisionToken:null,actor:{fractionalUserId:'operator'}})
 const reuse=request('reuse-existing','Untrusted replacement name','contact-a@example.invalid',a.referenceCode),reused=await gateway.resolveOrCreateFractionalCrmOnboarding(principal,reuse,'gateway-onboard-reuse')
 check(reused.status==='resolved'&&reused.company.record.globalId===a.referenceCode&&reused.contact.record.globalId===ca.referenceCode,'existing company/contact are reused without overwriting profiles')
 check(reused.company.record.fields.companyName===company.fields.companyName,'resolve never overwrites existing company')
 const blocked=request('needs-review','Existing A','new@example.invalid'),counts=(await pool.query('SELECT (SELECT count(*) FROM crm_organizations) AS companies,(SELECT count(*) FROM crm_contacts) AS contacts,(SELECT count(*) FROM fractional_crm_source_mappings) AS mappings,(SELECT count(*) FROM sync_outbox) AS outbox')).rows[0]
 const review=await gateway.resolveOrCreateFractionalCrmOnboarding(principal,blocked,'gateway-onboard-weak');check(review.status==='review_required'&&review.reasonCodes.includes('COMPANY_CANDIDATES'),'name match never authorizes reuse');check(review.candidates[0].displayName==='Existing A'&&review.candidates[0].companyName==='Existing A'&&review.candidates[0].email===null,'review labels describe authorized canonical candidates')
 assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM crm_organizations) AS companies,(SELECT count(*) FROM crm_contacts) AS contacts,(SELECT count(*) FROM fractional_crm_source_mappings) AS mappings,(SELECT count(*) FROM sync_outbox) AS outbox')).rows[0],counts);checks++
 const relationship=await gateway.resolveOrCreateFractionalCrmOnboarding(principal,request('cross-company','Brand New','contact-b@example.invalid'),'gateway-onboard-cross');check(relationship.status==='review_required'&&relationship.reasonCodes.includes('CONTACT_RELATIONSHIP_REVIEW'),'pair review creates neither record')
 const fresh=request('new-customer',"Unique O'Neil &amp; <x>",'unique-new@example.invalid'),results=await Promise.all([gateway.resolveOrCreateFractionalCrmOnboarding(principal,fresh,'gateway-create-pair'),gateway.resolveOrCreateFractionalCrmOnboarding(principal,fresh,'gateway-create-pair')]);
 check(results[0].company.record.globalId===results[1].company.record.globalId&&results[0].contact.record.globalId===results[1].contact.record.globalId,'concurrent exact retry creates one pair')
 check(results.some(r=>r.replayed===true),'retry is visibly acknowledged')
 check(results[0].company.record.fields.companyName===fresh.company.fields.companyName,'canonical Postgres preserves apostrophe, literal entity and angle brackets')
 await pool.query('UPDATE fractional_crm_gateway_credentials SET allowed_company_global_ids=array_remove(allowed_company_global_ids,$2) WHERE id=$1',[credentialId,results[0].company.record.globalId])
 await denied(()=>gateway.resolveOrCreateFractionalCrmOnboarding(principal,fresh,'gateway-create-pair'),'RECORD_NOT_FOUND')
 await pool.query('UPDATE fractional_crm_gateway_credentials SET allowed_company_global_ids=array_append(allowed_company_global_ids,$2) WHERE id=$1',[credentialId,results[0].company.record.globalId])
 principal=await gateway.readFractionalCrmCredential(credentialId)
 const staleReview=request('stale-review','Existing A','another@example.invalid');staleReview.reviewDecisionToken='x'.repeat(43);check((await gateway.resolveOrCreateFractionalCrmOnboarding(principal,staleReview,'gateway-bogus-review')).reasonCodes.includes('REVIEW_STALE'),'caller cannot forge review decision')
 const duplicateDifferentSource=await gateway.resolveOrCreateFractionalCrmOnboarding(principal,request('another-new-source',"Unique O'Neil &amp; <x>",'unique-new@example.invalid'),'gateway-create-duplicate');check(duplicateDifferentSource.status==='review_required','different source ID cannot create duplicate same-company invitation')
 await pool.query("UPDATE crm_contacts SET source_payload=jsonb_set(source_payload,'{archived}','true') WHERE id=$1",[cb.id]);await denied(()=>gateway.readFractionalCrmContact(principal,b.referenceCode,cb.referenceCode),'RECORD_RETIRED')
 await assert.rejects(()=>pool.query('UPDATE fractional_crm_gateway_credentials SET token_hash=$2 WHERE id=$1',[credentialId,'b'.repeat(64)]),error=>error.code==='P0001'&&error.message.includes('credential identity is immutable'));checks++
 await pool.query('UPDATE fractional_crm_gateway_credentials SET revoked_at=now() WHERE id=$1',[credentialId]);await denied(()=>gateway.resolveOrCreateFractionalCrmOnboarding(principal,fresh,'gateway-create-pair'),'UNAUTHORIZED')
 check((await pool.query('SELECT count(*)::int AS n FROM app_users')).rows[0].n===1,'gateway creates no login or invitation user')
 console.log(`PASS ${checks} gateway PostgreSQL assertions; all migrations; real CRM staging/outbox; no external calls`)
}finally{try{if(pool)await pool.end()}finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{timeout:30000,stdio:'pipe'})}}
