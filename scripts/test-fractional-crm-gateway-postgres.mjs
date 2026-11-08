#!/usr/bin/env node
// Real migrations and production gateway/staging SQL; no .env/provider access.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {readdirSync,readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import {normalizeCrmBoardCard} from '../app_src/lib/crm/boardCard.mjs'
import {decodeHtmlEntities} from '../app_src/lib/htmlEntities.mjs'
import {isFractionalCrmGatewayPath} from '../app_src/lib/fractionalCrmGatewayPath.mjs'
import {disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs} from './lib/disposable-postgres-docker.mjs'
import {applyMigrationSqlForTest} from './lib/postgres-test-migrations.mjs'
import {inspectFractionalFolderSenderSources,runFractionalCustomerFolderJoined} from './lib/fractional-customer-folder-joined.mjs'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),{Pool}=require('pg'),ts=require('typescript')
const args=process.argv.slice(2)
let joined=false,fractionalRoot=null,fractionalCommit=null,reviewedLegacyClaim=false
for(const arg of args){
 if(arg==='--with-fractional-folder-sender'){assert.equal(joined,false);joined=true}
 else if(arg==='--with-reviewed-legacy-claim'){assert.equal(reviewedLegacyClaim,false);reviewedLegacyClaim=true}
 else if(arg.startsWith('--fractional-root=')){assert.equal(fractionalRoot,null);fractionalRoot=arg.slice('--fractional-root='.length)}
 else if(arg.startsWith('--fractional-commit=')){assert.equal(fractionalCommit,null);fractionalCommit=arg.slice('--fractional-commit='.length)}
 else throw Error('Use [--with-fractional-folder-sender --fractional-root=/absolute/reviewed/Fractional --fractional-commit=FULL40] [--with-reviewed-legacy-claim]')
}
assert.equal(joined,fractionalRoot!==null&&fractionalCommit!==null,'Joined sender requires an explicit root and full commit; no Desktop fallback is permitted')
if(!joined){assert.equal(fractionalRoot,null);assert.equal(fractionalCommit,null)
 console.log('FRACTIONAL_FOLDER_JOINED_SKIPPED=No external sender root/commit selected; this run proves the ClawPilot gateway only')}
const joinedSources=joined?await inspectFractionalFolderSenderSources(ts,{root:fractionalRoot,commit:fractionalCommit}):null
const reviewedLegacyCommit='44aadaf5f9907d5f6fb2e473ba7de1a258dcfdb3'
const legacyCrmSource=reviewedLegacyClaim?execFileSync('git',['show',`${reviewedLegacyCommit}:app_src/lib/persistence/crm.ts`],
 {cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:10000}):null
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8')
function load(path,deps={},environment={},source=read(path)){const module={exports:{}};vm.runInNewContext(ts.transpileModule(source,{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
 {module,exports:module.exports,Buffer,URL,URLSearchParams,Request,Response,AbortSignal,Date,Error,Set,Map,process:{env:environment},require(name){if(Object.hasOwn(deps,name))return deps[name];if(name==='node:crypto')return require(name);return new Proxy({__esModule:true},{get(target,key){if(key==='__esModule')return true;return ()=>{throw new Error(`Unexpected integration dependency ${name}:${String(key)}`)}}})}}, {filename:path});return module.exports}
const container=`clawpilot-fractional-crm-test-${process.pid}-${randomUUID().slice(0,8)}`;let started=false,pool
try{
 execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never','-e','POSTGRES_PASSWORD=fractional_gateway_fixture','-e','POSTGRES_DB=fractional_gateway_fixture','-p','127.0.0.1::5432','pgvector/pgvector:pg16']),{timeout:60000,stdio:'pipe'});started=true
 const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1];assert.ok(port)
 pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'fractional_gateway_fixture',database:'fractional_gateway_fixture',ssl:false,max:6,connectionTimeoutMillis:1000,statement_timeout:15000})
 const deadline=Date.now()+30000;for(;;){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>deadline)throw error;await new Promise(resolve=>setTimeout(resolve,100))}}
 const historicalProductMigration='0373_fractional_crm_product_read.sql',folderCapabilityMigration='0403_fractional_crm_customer_folder_capability.sql'
 const migrationFiles=readdirSync(new URL('../db/migrations/',import.meta.url)).filter(f=>/^\d+_.+\.sql$/u.test(f)).sort()
 const folderUpgrade=migrationFiles.indexOf(folderCapabilityMigration),historicalProduct=migrationFiles.indexOf(historicalProductMigration)
 assert.ok(historicalProduct>=0&&folderUpgrade>historicalProduct,'The published product-capability migration must precede the folder upgrade')
 assert.equal(createHash('sha256').update(read(`db/migrations/${historicalProductMigration}`)).digest('hex'),
  '0e01f96a2862c22e785cd16a49a5079d0e9492f7503e155941b45e111b64a764','Do not rewrite the published 0373 migration')
 const applyMigrations=async files=>{const c=await pool.connect();try{
  for(const file of files)await applyMigrationSqlForTest(c,file,read(`db/migrations/${file}`))
 }finally{c.release()}}
 await applyMigrations(migrationFiles.slice(0,folderUpgrade))
 let beforeCommit=null
 const query=(sql,args)=>pool.query(sql,args),withTransaction=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);if(beforeCommit)await beforeCommit();await c.query('COMMIT');return result}catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}}
 const auth=load('app_src/lib/fractionalCrmGatewayAuth.ts'),model=load('app_src/lib/crm/fractionalGatewayModel.ts'),stable=load('app_src/lib/crm/stableId.ts')
 const audit=load('app_src/lib/auditWriter.ts',{'@/lib/persistence/postgres':{query},'next/headers':{headers:()=>{throw new Error('No browser context')}},'@/lib/authAttribution':{verifyAuthAttributionHeaders:()=>null}})
 const authority=load('app_src/lib/persistence/crmNativeEmailAuthority.ts')
 const crmPath='app_src/lib/persistence/crm.ts'
 const crmDeps={'@/lib/persistence/crmNativeEmailAuthority':authority,'@/lib/crm/stableId':stable,'@/lib/persistence/postgres':{query,withTransaction},'@/lib/persistence/config':{isPostgresStorageEnabled:()=>true},'@/lib/publicUrl':{appPublicUrl:()=> 'https://clawpilot.example.invalid'},'@/lib/shortlinks':{shortLinkUrl:code=>`https://clawpilot.example.invalid/s/${code}`},'@/lib/auditWriter':audit}
 const crm=load(crmPath,crmDeps)
 const folderLinks=load('app_src/lib/crm/customerFolderLinks.ts'),folderContract=load('app_src/lib/crm/fractionalCustomerFolder.ts',{'./customerFolderLinks':folderLinks})
 const scopedProjection=load('app_src/lib/crm/fractionalFolderBoardProjection.ts',{'@/lib/fractionalCrmGatewayAuth':auth,'@/lib/persistence/crm':crm})
 const gateway=load('app_src/lib/persistence/fractionalCrmGateway.ts',{'@/lib/persistence/crmNativeEmailAuthority':authority,'@/lib/crm/fractionalCustomerFolder':folderContract,'@/lib/crm/fractionalFolderBoardProjection':scopedProjection,'@/lib/persistence/postgres':{query,withTransaction},'@/lib/persistence/crm':crm,'@/lib/fractionalCrmGatewayAuth':auth,'@/lib/crm/fractionalGatewayModel':model})
 const org=randomUUID(),pipeline=randomUUID(),root=randomUUID(),instance=randomUUID(),deployment=randomUUID(),credentialId=randomUUID(),owner='gateway.owner@example.invalid'
 await pool.query("INSERT INTO app_users(email,role,status,activated_at) VALUES($1,'owner','active',now())",[owner])
 await pool.query("INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by) VALUES($1,'Gateway fixture','root',$2,$2)",[org,owner])
 await pool.query("INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,is_default,created_by,updated_by) VALUES($1,$2,'owner','active',true,$1,$1)",[owner,org])
 await pool.query("INSERT INTO pipeline_spaces(id,name,owner_email,is_default,workspace_organization_id) VALUES($1,'Gateway fixture',$2,true,$3)",[pipeline,owner,org])
 const ga=(await pool.query('SELECT reference_code FROM workspace_organizations WHERE id=$1',[org])).rows[0].reference_code
 await pool.query(`INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id,source_key,identity_key,reference_code,name,source_hash,workspace_organization_id,relationship_type,created_by,updated_by)
 VALUES($1::uuid,$2,$1::text,'gateway-root','gateway-root',$3,'Gateway root','root',$4,'workspace_root',$5,$5)`,[root,pipeline,ga,org,owner])
 let checks=0
 const check=(condition,message)=>{assert.ok(condition,message);checks++},denied=async(fn,code)=>{await assert.rejects(fn,error=>error.code===code);checks++}
 const historicalProductCredentialId=randomUUID(),folderOnlyCredentialId=randomUUID()
 const tokenFor=id=>`fcg_${id.replaceAll('-','')}_${'F'.repeat(43)}`
 const insertCompatibilityCredential=(db,id,capabilities)=>db.query(`INSERT INTO fractional_crm_gateway_credentials
  (id,token_hash,source_instance_id,workspace_organization_id,pipeline_id,root_company_global_id,capabilities,
   fractional_deployment_id,fractional_organization_id,actor_email,expires_at,enabled)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,'fractional-fixture',$9,now()+interval '1 hour',true)`,
 [id,auth.hashFractionalCrmGatewayToken(tokenFor(id)),instance,org,pipeline,ga,capabilities,deployment,owner])
 const isCapabilityCheck=error=>error.code==='23514'&&error.constraint==='fractional_crm_gateway_credentials_capabilities_check'
 const allCompatibilityCredentials=async()=> (await pool.query('SELECT to_jsonb(c) AS credential FROM fractional_crm_gateway_credentials c ORDER BY c.id')).rows
 const authenticateCompatibilityCredential=(id,capability)=>auth.authenticateFractionalCrmGateway(
  new Request('https://clawpilot.example.invalid/api/integrations/fractional-crm/v1/products',{headers:{authorization:`Bearer ${tokenFor(id)}`}}),
  {origin:'https://clawpilot.example.invalid',sourceInstanceId:instance},gateway.readFractionalCrmCredential,capability)
 await insertCompatibilityCredential(pool,historicalProductCredentialId,['crm.product.read'])
 await assert.rejects(insertCompatibilityCredential(pool,folderOnlyCredentialId,['crm.customer-folder.write']),isCapabilityCheck);checks++
 const historicalRows=await allCompatibilityCredentials()
 check(historicalRows.length===1&&historicalRows[0].credential.enabled&&historicalRows[0].credential.revoked_at===null,
  'historical schema has an enabled, unrevoked product-only credential')
 const historicalPrincipal=await authenticateCompatibilityCredential(historicalProductCredentialId,'crm.product.read')
 await applyMigrations([folderCapabilityMigration])
 assert.deepEqual(await allCompatibilityCredentials(),historicalRows,'0403 changes only the allowed capability vocabulary, not existing rows or grants');checks++
 assert.deepEqual(await authenticateCompatibilityCredential(historicalProductCredentialId,'crm.product.read'),historicalPrincipal,
  'the original token and exact product scope still authenticate after 0403');checks++
 await denied(()=>authenticateCompatibilityCredential(historicalProductCredentialId,'crm.customer-folder.write'),'CAPABILITY_DENIED')
 await insertCompatibilityCredential(pool,folderOnlyCredentialId,['crm.customer-folder.write'])
 const vocabularyProbe=await pool.connect();try{
  await vocabularyProbe.query('BEGIN')
  await insertCompatibilityCredential(vocabularyProbe,randomUUID(),['crm.product.read','crm.customer-folder.write']);checks++
  await assert.rejects(insertCompatibilityCredential(vocabularyProbe,randomUUID(),['crm.unreviewed.write']),isCapabilityCheck);checks++
 }finally{try{await vocabularyProbe.query('ROLLBACK')}finally{vocabularyProbe.release()}}
 check((await allCompatibilityCredentials()).length===2,'only two explicitly provisioned compatibility fixture credentials exist')
 await applyMigrations(migrationFiles.slice(folderUpgrade+1))
 const inheritedProductPrincipal=await authenticateCompatibilityCredential(historicalProductCredentialId,'crm.product.read')
 const folderOnlyPrincipal=await authenticateCompatibilityCredential(folderOnlyCredentialId,'crm.customer-folder.write')
 const product=(await pool.query(`INSERT INTO crm_products(pipeline_id,source_key,name,product_type,price,currency,active,source_hash)
  VALUES($1,$2,'Retained catalog service','Service',12.34,'USD',true,'fixture') RETURNING id,reference_code`,[pipeline,randomUUID()])).rows[0]
 const readProduct=await gateway.readFractionalCrmProduct(inheritedProductPrincipal,product.reference_code)
 check(readProduct.recordId===product.id&&readProduct.scope.pipelineId===pipeline&&readProduct.sourceInstanceId===instance
  &&readProduct.pricingAuthority==='stored_catalog_value'&&readProduct.invoiceDefaultVerified===false,
  'the preserved credential reads the same scoped catalog without certifying a default invoice price')
 const listProduct=await gateway.listFractionalCrmProducts(inheritedProductPrincipal,{limit:10})
 assert.deepEqual(Array.from(listProduct.items,item=>item.globalId),[product.reference_code]);checks++
 await denied(()=>gateway.readFractionalCrmProduct(folderOnlyPrincipal,product.reference_code),'CAPABILITY_DENIED')
 await denied(()=>gateway.listFractionalCrmProducts(folderOnlyPrincipal,{limit:10}),'CAPABILITY_DENIED')
 await denied(()=>gateway.readFractionalCrmProduct({...inheritedProductPrincipal,pipelineId:randomUUID()},product.reference_code),'CAPABILITY_DENIED')
 await denied(()=>gateway.readFractionalCrmCustomerFolder(inheritedProductPrincipal,ga,'compatibility-fixture-customer'),'CAPABILITY_DENIED')
 check((await allCompatibilityCredentials()).some(row=>JSON.stringify(row)===JSON.stringify(historicalRows[0])),
  'all migrations and scoped reads preserve the full historical credential')
 const stage=fields=>withTransaction(c=>crm.stageCrmRecordWithClient(c,{entity:'organizations',pipelineId:pipeline,sourceKey:`seed:${randomUUID()}`,createOnly:true,identityKeyOverride:`seed:${randomUUID()}`,actorEmail:owner,fields:{name:fields.name,parentOrganizationId:root,...fields}}))
 const a=await stage({name:'Existing A',website:'https://existing-a.example.invalid',accountType:'Customer',description:'Customer notes\nBPO Supply Chain Drive: https://bposupplychain.com/s/customer'}),b=await stage({name:'Existing B'}),hidden=await stage({name:'Ungrant company'})
 const stageContact=(parent,name,email,extra={})=>withTransaction(c=>crm.stageCrmRecordWithClient(c,{entity:'contacts',pipelineId:pipeline,sourceKey:`seed:${randomUUID()}`,actorEmail:owner,fields:{organizationId:parent.id,organizationSuiteCrmId:parent.suiteCrmId,fullName:name,email,...extra}}))
 const ca=await stageContact(a,'Existing Contact','contact-a@example.invalid',{description:'Private note retained',emailOptOut:true,phoneMobile:'999'}),cb=await stageContact(b,'Other Contact','contact-b@example.invalid'),ch=await stageContact(hidden,'Hidden Contact','hidden@example.invalid')
 const capabilities=['crm.company.read','crm.contact.read','crm.company.write','crm.contact.write','crm.onboarding.write']
 const fixtureToken=`fcg_${credentialId.replaceAll('-','')}_${'F'.repeat(43)}`
 await pool.query(`INSERT INTO fractional_crm_gateway_credentials(id,token_hash,source_instance_id,workspace_organization_id,pipeline_id,root_company_global_id,allowed_company_global_ids,capabilities,fractional_deployment_id,fractional_organization_id,actor_email,expires_at,enabled)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'fractional-fixture',$10,now()+interval '1 hour',true)`,[credentialId,auth.hashFractionalCrmGatewayToken(fixtureToken),instance,org,pipeline,ga,[a.referenceCode,b.referenceCode],capabilities,deployment,owner])
 let principal=await gateway.readFractionalCrmCredential(credentialId)
 const organization=await gateway.readFractionalCrmOrganization(principal)
 check(organization.entity==='organization'&&organization.recordId===root&&organization.globalId===ga&&organization.name==='Gateway root','organization read returns only the bound workspace root')
 check(Object.keys(organization).length===8&&!('fields' in organization)&&!('actorEmail' in organization),'organization metadata has no private or writable company fields')
 await denied(()=>gateway.readFractionalCrmCompany(principal,ga),'RECORD_NOT_FOUND')
 await denied(()=>gateway.readFractionalCrmOrganization({...principal,workspaceOrganizationId:randomUUID()}),'CAPABILITY_DENIED')
 await pool.query('UPDATE crm_organizations SET name=$2 WHERE id=$1',[root,'Renamed workspace'])
 const renamedOrganization=await gateway.readFractionalCrmOrganization(principal)
 check(renamedOrganization.name==='Renamed workspace'&&renamedOrganization.version!==organization.version,'saved organization rename advances the source version')
 await pool.query('UPDATE crm_organizations SET name=$2 WHERE id=$1',[root,'Gateway root'])
 await pool.query('UPDATE fractional_crm_gateway_credentials SET capabilities=array_remove(capabilities,$2) WHERE id=$1',[credentialId,'crm.company.read'])
 await denied(()=>gateway.readFractionalCrmOrganization(principal),'CAPABILITY_DENIED')
 await pool.query('UPDATE fractional_crm_gateway_credentials SET capabilities=$2 WHERE id=$1',[credentialId,capabilities])
 await pool.query("UPDATE app_user_organization_memberships SET role='member' WHERE organization_id=$1 AND user_email=$2",[org,owner])
 await denied(()=>gateway.readFractionalCrmOrganization(principal),'RECORD_NOT_FOUND')
 await pool.query("UPDATE app_user_organization_memberships SET role='owner' WHERE organization_id=$1 AND user_email=$2",[org,owner])
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
 // Folder transport is deliberately a separate resource. The existing company
 // wire format stays unchanged and a GA allowlist alone is not a source mapping.
 const folderUrl='https://app.bposupplychain.com/s/d_customer',nextFolder='https://app.bposupplychain.com/s/d_renamed'
 const folderActor={...actor,customerId:'reuse-existing'}
 const board=randomUUID()
 await pool.query("INSERT INTO project_boards(id,name,owner_email,workspace_organization_id) VALUES($1,'CRM Board',$2,$3)",[board,owner,org])
 await pool.query('INSERT INTO crm_board_projections(board_id,pipeline_id,workspace_organization_id) VALUES($1,$2,$3)',[board,pipeline,org])
 const projection=load('app_src/lib/crm/boardProjection.ts',{'@/lib/persistence/postgres':{query,withTransaction},
  '@/lib/persistence/config':{isPostgresStorageEnabled:()=>true},'@/lib/persistence/crmNativeEmailAuthority':authority,
  '@/lib/persistence/crm':{...crm,ensurePipelineCrmReferenceLinks:async()=>{}},
  '@/lib/crm/boardCard.mjs':{normalizeCrmBoardCard},'@/lib/htmlEntities.mjs':{decodeHtmlEntities},
  '@/lib/shortlinks':{shortLinkUrl:code=>`https://fixture.example.test/s/${code}`}})
 await projection.reconcileCrmBoardProjectionsForPipeline({pipelineId:pipeline})
 const card=async()=> (await pool.query('SELECT card_id,payload FROM crm_board_cards WHERE board_id=$1 AND entity_id=$2',[board,a.id])).rows[0]
 const originalCard=await card()
 await pool.query(`UPDATE crm_board_cards SET payload=jsonb_set(payload,'{comments}','[{"id":"retained-comment","text":"Operator card note"}]') WHERE card_id=$1`,[originalCard.card_id])
 const boundary=load('app_src/lib/fractionalCrmGatewayHttp.ts',{'./fractionalCrmGatewayAuth':auth,
  './fractionalCrmGatewayPath.mjs':{isFractionalCrmGatewayPath},'./crm/fractionalCustomerFolder':folderContract})
 let legacyReconciliations=0
 const services={...gateway,updateFractionalCrmCustomerFolder:(...args)=>gateway.updateFractionalCrmCustomerFolder(...args,async input=>{
  legacyReconciliations++;await projection.reconcileCrmBoardProjectionsForPipeline(input)
 })}
 const folderHttp=async(command,{company=a.referenceCode,customerId=folderActor.customerId,status=200}={})=>{
  const origin='https://clawpilot.example.invalid',query=new URLSearchParams({sourceInstanceId:instance,workspaceOrganizationId:org,pipelineId:pipeline,rootCompanyGlobalId:ga,customerId})
  const response=await boundary.handleFractionalCrmGateway(new Request(`${origin}/api/integrations/fractional-crm/v1/companies/${company}/customer-folder?${query}`,{
   method:command?'PATCH':'GET',headers:{authorization:`Bearer ${fixtureToken}`,...(command?{'content-type':'application/json','if-match':`"${command.ifMatch}"`,'idempotency-key':command.idempotencyKey}:{})},
   ...(command?{body:JSON.stringify({schemaVersion:1,folderUrl:command.folderUrl,assertedFractionalActor:command.assertedFractionalActor})}:{})}),services,
  {FRACTIONAL_CRM_GATEWAY_ENABLED:'1',FRACTIONAL_CRM_GATEWAY_ORIGIN:origin,FRACTIONAL_CRM_GATEWAY_SOURCE_INSTANCE_ID:instance})
  const body=await response.json();assert.equal(response.status,status,body.error);return body
 }
 await denied(()=>gateway.readFractionalCrmCustomerFolder(principal,a.referenceCode,'unknown-source-customer'),'RECORD_NOT_FOUND')
 const emptyFolder=await gateway.readFractionalCrmCustomerFolder(principal,a.referenceCode,folderActor.customerId)
 check((await folderHttp()).version===emptyFolder.version,'actual machine HTTP authentication and live database read agree on scoped folder version')
 check(emptyFolder.status==='unlinked'&&emptyFolder.folderUrl===null&&emptyFolder.globalId===a.referenceCode,'only an exact persisted source-customer binding reads folder state')
 const folderCommand={schemaVersion:1,folderUrl,ifMatch:emptyFolder.version,idempotencyKey:'gateway-folder-first',assertedFractionalActor:folderActor}
 beforeCommit=async()=>{beforeCommit=null;throw Error('synthetic folder commit failure')}
 await assert.rejects(gateway.updateFractionalCrmCustomerFolder(principal,a.referenceCode,folderCommand),/synthetic folder commit failure/);checks++
 check((await pool.query('SELECT count(*)::int AS n FROM crm_fractional_customer_folders')).rows[0].n===0,'failed commit rolls back folder binding and publication')
 check((await gateway.readFractionalCrmCustomerFolder(principal,a.referenceCode,folderActor.customerId)).version===emptyFolder.version,'failed publication retains the original description/version')
 const appliedFolder=await folderHttp(folderCommand)
 check(appliedFolder.status==='published'&&appliedFolder.folderUrl===folderUrl&&appliedFolder.recordId===a.id,'authoritative Fractional folder publishes onto the existing global Account')
 const savedDescription=(await pool.query('SELECT description FROM crm_organizations WHERE id=$1',[a.id])).rows[0].description
 check(savedDescription.startsWith('Customer notes\nBPO Supply Chain Drive: https://bposupplychain.com/s/customer')&&savedDescription.endsWith(`Fractional Customer Folder: ${folderUrl}`),'publication preserves notes and customer-specific BPO reference')
 await projection.reconcileCrmBoardProjectionsForPipeline({pipelineId:pipeline})
 const publishedCard=await card()
 check(publishedCard.card_id===originalCard.card_id&&publishedCard.payload.crm.referenceCode===a.referenceCode
  &&publishedCard.payload.desc===savedDescription&&publishedCard.payload.comments[0].id==='retained-comment','actual Project-card projection retains identity/comments and receives both customer-folder links')
 const effects=async()=> (await pool.query(`SELECT (SELECT count(*) FROM audit_events) AS audit,(SELECT count(*) FROM sync_outbox) AS outbox,
  (SELECT count(*) FROM fractional_crm_gateway_operations) AS receipts,(SELECT last_published_url FROM crm_fractional_customer_folders WHERE account_id=$1) AS url`,[a.id])).rows[0]
 const firstEffects=await effects()
 check((await folderHttp(folderCommand)).version===appliedFolder.version,'lost successful response replays the exact durable receipt through authenticated HTTP and card projection')
 assert.deepEqual(await effects(),firstEffects);checks++
 await denied(()=>gateway.updateFractionalCrmCustomerFolder(principal,a.referenceCode,{...folderCommand,idempotencyKey:'gateway-folder-stale'}),'VERSION_CONFLICT')
 await denied(()=>gateway.updateFractionalCrmCustomerFolder(principal,a.referenceCode,{...folderCommand,folderUrl:nextFolder}),'IDEMPOTENCY_CONFLICT')
 await denied(()=>gateway.updateFractionalCrmCustomerFolder(principal,companyAlias,{...folderCommand,idempotencyKey:'gateway-folder-alias'}),'IDENTITY_CONFLICT')
 await denied(()=>gateway.updateFractionalCrmCustomerFolder(principal,b.referenceCode,{...folderCommand,idempotencyKey:'gateway-folder-wrong-company'}),'MANAGED_RECORD')
 const anotherSource=request('other-fractional-customer','Existing A','contact-a@example.invalid',a.referenceCode)
 await gateway.resolveOrCreateFractionalCrmOnboarding(principal,anotherSource,'gateway-map-same-company')
 await denied(()=>gateway.readFractionalCrmCustomerFolder(principal,a.referenceCode,'other-fractional-customer'),'FOLDER_BINDING_CONFLICT')
 await pool.query('UPDATE crm_organizations SET description=$2 WHERE id=$1',[a.id,savedDescription+'\nNew operator note'])
 await denied(()=>gateway.updateFractionalCrmCustomerFolder(principal,a.referenceCode,{...folderCommand,ifMatch:appliedFolder.version,idempotencyKey:'gateway-folder-old-notes',folderUrl:nextFolder}),'VERSION_CONFLICT')
 const currentFolder=await gateway.readFractionalCrmCustomerFolder(principal,a.referenceCode,folderActor.customerId)
 const changedFolder=await gateway.updateFractionalCrmCustomerFolder(principal,a.referenceCode,{...folderCommand,ifMatch:currentFolder.version,idempotencyKey:'gateway-folder-update',folderUrl:nextFolder})
 check(changedFolder.folderUrl===nextFolder&&(await pool.query('SELECT description FROM crm_organizations WHERE id=$1',[a.id])).rows[0].description.endsWith('New operator note'),'fresh CAS updates authoritative reference without losing intervening notes')
 const operatorDescription=(await pool.query('SELECT description FROM crm_organizations WHERE id=$1',[a.id])).rows[0].description.replace(`Fractional Customer Folder: ${nextFolder}\n`,'')
 await pool.query('UPDATE crm_organizations SET description=$2 WHERE id=$1',[a.id,operatorDescription])
 const removedFolder=await gateway.readFractionalCrmCustomerFolder(principal,a.referenceCode,folderActor.customerId)
 check(removedFolder.status==='manual_override'&&removedFolder.folderUrl===null,'manual link removal is visible as an override rather than reinserted')
 await denied(()=>gateway.updateFractionalCrmCustomerFolder(principal,a.referenceCode,{...folderCommand,ifMatch:removedFolder.version,idempotencyKey:'gateway-folder-manual-removed'}),'FOLDER_MANUAL_REVIEW_REQUIRED')
 await pool.query("UPDATE app_user_organization_memberships SET role='admin',permissions=jsonb_build_object('viewCrm',false) WHERE organization_id=$1 AND user_email=$2",[org,owner])
 await denied(()=>gateway.updateFractionalCrmCustomerFolder(principal,a.referenceCode,folderCommand),'RECORD_NOT_FOUND')
 await pool.query("UPDATE app_user_organization_memberships SET role='owner',permissions='{}'::jsonb WHERE organization_id=$1 AND user_email=$2",[org,owner])
 await pool.query('UPDATE fractional_crm_gateway_credentials SET allowed_company_global_ids=array_remove(allowed_company_global_ids,$2) WHERE id=$1',[credentialId,a.referenceCode])
 await denied(()=>gateway.updateFractionalCrmCustomerFolder(principal,a.referenceCode,folderCommand),'RECORD_NOT_FOUND')
 await pool.query('UPDATE fractional_crm_gateway_credentials SET allowed_company_global_ids=array_append(allowed_company_global_ids,$2) WHERE id=$1',[credentialId,a.referenceCode])
 await assert.rejects(pool.query('UPDATE crm_fractional_customer_folders SET customer_id=$2,local_id=$2 WHERE account_id=$1',[a.id,'other-fractional-customer']),error=>error.code==='P0001');checks++
 const blocked=request('needs-review','Existing A','new@example.invalid'),counts=(await pool.query('SELECT (SELECT count(*) FROM crm_organizations) AS companies,(SELECT count(*) FROM crm_contacts) AS contacts,(SELECT count(*) FROM fractional_crm_source_mappings) AS mappings,(SELECT count(*) FROM sync_outbox) AS outbox')).rows[0]
 const review=await gateway.resolveOrCreateFractionalCrmOnboarding(principal,blocked,'gateway-onboard-weak');check(review.status==='review_required'&&review.reasonCodes.includes('COMPANY_CANDIDATES'),'name match never authorizes reuse');check(review.candidates[0].displayName==='Existing A'&&review.candidates[0].companyName==='Existing A'&&review.candidates[0].email===null,'review labels describe authorized canonical candidates')
 assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM crm_organizations) AS companies,(SELECT count(*) FROM crm_contacts) AS contacts,(SELECT count(*) FROM fractional_crm_source_mappings) AS mappings,(SELECT count(*) FROM sync_outbox) AS outbox')).rows[0],counts);checks++
 const relationship=await gateway.resolveOrCreateFractionalCrmOnboarding(principal,request('cross-company','Brand New','contact-b@example.invalid'),'gateway-onboard-cross');check(relationship.status==='review_required'&&relationship.reasonCodes.includes('CONTACT_RELATIONSHIP_REVIEW'),'pair review creates neither record')
 await pool.query(`INSERT INTO crm_customer_folder_settings(workspace_id,shared_drive_id,customers_parent_id,
  service_account_email,parent_name,enabled,revision,updated_by)
  VALUES($1,'fixture_bpo_drive','fixture_bpo_customers','fixture@service.example.invalid','01 Customers',true,1,$2)`,[org,owner])
 check((await pool.query('SELECT count(*)::int AS n FROM crm_customer_folder_jobs')).rows[0].n===0,
  'Enabling BPO automation does not enroll existing Fractional customers')
 await gateway.resolveOrCreateFractionalCrmOnboarding(principal,reuse,'gateway-onboard-reuse-with-bpo-enabled')
 check((await pool.query('SELECT count(*)::int AS n FROM crm_customer_folder_jobs')).rows[0].n===0,
  'Explicit reuse of an existing customer does not backfill a BPO folder')
 const fresh=request('new-customer',"Unique O'Neil &amp; <x>",'unique-new@example.invalid'),results=await Promise.all([gateway.resolveOrCreateFractionalCrmOnboarding(principal,fresh,'gateway-create-pair'),gateway.resolveOrCreateFractionalCrmOnboarding(principal,fresh,'gateway-create-pair')]);
 check(results[0].company.record.globalId===results[1].company.record.globalId&&results[0].contact.record.globalId===results[1].contact.record.globalId,'concurrent exact retry creates one pair')
 check(results.some(r=>r.replayed===true),'retry is visibly acknowledged')
 check(results[0].company.record.fields.companyName===fresh.company.fields.companyName,'canonical Postgres preserves apostrophe, literal entity and angle brackets')
 check((await gateway.readFractionalCrmCustomerFolder(principal,results[0].company.record.globalId,fresh.origin.customerId)).status==='unlinked','new Fractional customer is typed Customer and can receive its authoritative folder reference')
 const bpoJobs=(await pool.query('SELECT * FROM crm_customer_folder_jobs')).rows
 check(bpoJobs.length===1&&bpoJobs[0].account_id===results[0].company.record.recordId
  &&bpoJobs[0].account_global_id===results[0].company.record.globalId&&bpoJobs[0].workspace_id===org
  &&bpoJobs[0].pipeline_id===pipeline&&bpoJobs[0].actor_email===owner&&bpoJobs[0].config_revision==='1'
  &&bpoJobs[0].status==='queued','new source-bound customer atomically queues exactly one independent BPO folder job')
 await gateway.resolveOrCreateFractionalCrmOnboarding(principal,fresh,'gateway-create-pair')
 check((await pool.query('SELECT count(*)::int AS n FROM crm_customer_folder_jobs')).rows[0].n===1,
  'Lost-response replay never duplicates or resets the BPO job')
 const createdFolder=await gateway.readFractionalCrmCustomerFolder(principal,results[0].company.record.globalId,fresh.origin.customerId)
 const fractionalCreatedUrl='https://drive.google.com/drive/folders/fractional_verified_fixture'
 await gateway.updateFractionalCrmCustomerFolder(principal,results[0].company.record.globalId,{
  ...folderCommand,ifMatch:createdFolder.version,idempotencyKey:'gateway-new-fractional-folder',folderUrl:fractionalCreatedUrl,
  assertedFractionalActor:{...actor,customerId:fresh.origin.customerId}})
 assert.deepEqual((await pool.query('SELECT * FROM crm_customer_folder_jobs')).rows,bpoJobs);checks++
 await projection.reconcileCrmBoardProjectionsForPipeline({pipelineId:pipeline})
 const newCard=(await pool.query('SELECT payload FROM crm_board_cards WHERE board_id=$1 AND entity_id=$2',
  [board,results[0].company.record.recordId])).rows[0].payload
 check(newCard.crm.referenceCode===results[0].company.record.globalId
  &&newCard.desc.includes(`Fractional Customer Folder: ${fractionalCreatedUrl}`),
  'Fractional-created folder reaches the same Global-ID account card without consuming the independent BPO job')
 const rollbackRequest=request('rollback-bpo-customer','New Rollback BPO Customer','rollback-bpo@example.invalid')
 const beforeRollback=(await pool.query(`SELECT (SELECT count(*) FROM crm_organizations) AS accounts,
  (SELECT count(*) FROM crm_customer_folder_jobs) AS jobs,(SELECT count(*) FROM fractional_crm_gateway_operations) AS receipts,
  (SELECT count(*) FROM fractional_crm_source_mappings) AS mappings`)).rows[0]
 beforeCommit=async()=>{beforeCommit=null;throw new Error('fixture_account_and_folder_rollback')}
 await assert.rejects(()=>gateway.resolveOrCreateFractionalCrmOnboarding(principal,rollbackRequest,'gateway-create-bpo-rollback'),
  /fixture_account_and_folder_rollback/);checks++
 assert.deepEqual((await pool.query(`SELECT (SELECT count(*) FROM crm_organizations) AS accounts,
  (SELECT count(*) FROM crm_customer_folder_jobs) AS jobs,(SELECT count(*) FROM fractional_crm_gateway_operations) AS receipts,
  (SELECT count(*) FROM fractional_crm_source_mappings) AS mappings`)).rows[0],beforeRollback);checks++
 await pool.query('UPDATE crm_customer_folder_settings SET enabled=false,revision=2 WHERE workspace_id=$1',[org])
 const paused=request('paused-bpo-customer','New Paused BPO Customer','paused-bpo@example.invalid')
 const pausedResult=await gateway.resolveOrCreateFractionalCrmOnboarding(principal,paused,'gateway-create-bpo-paused')
 check(pausedResult.status==='created'&&(await pool.query('SELECT count(*)::int AS n FROM crm_customer_folder_jobs')).rows[0].n===1,
  'Paused BPO automation does not prevent Fractional onboarding or queue provider work')
 await pool.query('UPDATE fractional_crm_gateway_credentials SET allowed_company_global_ids=array_remove(allowed_company_global_ids,$2) WHERE id=$1',[credentialId,results[0].company.record.globalId])
 await denied(()=>gateway.resolveOrCreateFractionalCrmOnboarding(principal,fresh,'gateway-create-pair'),'RECORD_NOT_FOUND')
 await pool.query('UPDATE fractional_crm_gateway_credentials SET allowed_company_global_ids=array_append(allowed_company_global_ids,$2) WHERE id=$1',[credentialId,results[0].company.record.globalId])
 principal=await gateway.readFractionalCrmCredential(credentialId)
 const staleReview=request('stale-review','Existing A','another@example.invalid');staleReview.reviewDecisionToken='x'.repeat(43);check((await gateway.resolveOrCreateFractionalCrmOnboarding(principal,staleReview,'gateway-bogus-review')).reasonCodes.includes('REVIEW_STALE'),'caller cannot forge review decision')
 const duplicateDifferentSource=await gateway.resolveOrCreateFractionalCrmOnboarding(principal,request('another-new-source',"Unique O'Neil &amp; <x>",'unique-new@example.invalid'),'gateway-create-duplicate');check(duplicateDifferentSource.status==='review_required','different source ID cannot create duplicate same-company invitation')
 const narrowCompany=pausedResult.company.record.globalId,narrowAccount=pausedResult.company.record.recordId
 const narrowScope={company:narrowCompany,customerId:paused.origin.customerId}
 const narrowFolderUrl='https://drive.google.com/drive/folders/exact_fixture_folder_id'
 const otherNarrowFolderUrl='https://drive.google.com/drive/folders/other_fixture_folder_id'
 const adoptedDescription='Keep operator notes\nBPO Supply Chain Drive: https://bposupplychain.com/s/customer\nFractional Customer Folder: '+narrowFolderUrl
 const adopt=await stage({name:'Existing folder adoption fixture',accountType:'Customer',description:adoptedDescription})
 await pool.query('UPDATE fractional_crm_gateway_credentials SET allowed_company_global_ids=array_append(allowed_company_global_ids,$2) WHERE id=$1',[credentialId,adopt.referenceCode])
 const adoptSource=request('folder-adopt-source','Existing folder adoption fixture','fixture-adopt@example.invalid',adopt.referenceCode)
 await gateway.resolveOrCreateFractionalCrmOnboarding(principal,adoptSource,'gateway-adopt-folder-mapping')
 const stalePrincipal=principal
 await pool.query('UPDATE fractional_crm_gateway_credentials SET capabilities=$2 WHERE id=$1',[credentialId,['crm.company.read','crm.customer-folder.write']])
 principal=await gateway.readFractionalCrmCredential(credentialId)
 const exactBefore=await folderHttp(undefined,narrowScope)
 const exactCommand={...folderCommand,folderUrl:narrowFolderUrl,ifMatch:exactBefore.version,idempotencyKey:'gateway-scoped-initial',
  assertedFractionalActor:{...actor,customerId:narrowScope.customerId}}
 const narrowState=async()=> (await pool.query(`SELECT
   (SELECT to_jsonb(a) FROM crm_organizations a WHERE id=$1) AS account,
   (SELECT to_jsonb(b) FROM crm_fractional_customer_folders b WHERE account_id=$1) AS binding,
   (SELECT to_jsonb(c) FROM crm_board_cards c WHERE board_id=$2 AND entity_id=$1) AS card,
   (SELECT count(*) FROM fractional_crm_gateway_operations) AS receipts,
   (SELECT count(*) FROM sync_outbox) AS outbox,
   (SELECT count(*) FROM audit_events) AS audit,
   (SELECT count(*) FROM crm_customer_folder_jobs) AS bpo_jobs`,[narrowAccount,board])).rows[0]
 const noCardBefore=await narrowState()
 assert.equal(noCardBefore.card,null)
 check((await folderHttp(exactCommand,{...narrowScope,status:409})).error==='FOLDER_CARD_REVIEW_REQUIRED','missing exact card fails safely')
 assert.deepEqual(await narrowState(),noCardBefore);checks++
 await projection.reconcileCrmBoardProjectionsForPipeline({pipelineId:pipeline})
 await pool.query("UPDATE crm_board_cards SET payload=jsonb_set(payload,'{comments}',$3::jsonb) WHERE board_id=$1 AND entity_id=$2",[board,narrowAccount,JSON.stringify([{id:'narrow-comment',text:'Retain this'}])])
 await pool.query("UPDATE crm_organizations SET description='Unrelated description drift' WHERE id=$1",[narrowAccount])
 const drift=await folderHttp(undefined,narrowScope),driftedState=await narrowState()
 check((await folderHttp({...exactCommand,ifMatch:drift.version},{...narrowScope,status:409})).error==='FOLDER_CARD_REVIEW_REQUIRED','narrow grant cannot project unrelated description drift')
 assert.deepEqual(await narrowState(),driftedState);checks++
 await pool.query('UPDATE crm_organizations SET description=$2 WHERE id=$1',[narrowAccount,noCardBefore.account.description])
 const pendingAccount=await narrowState()
 check((await folderHttp(exactCommand,{...narrowScope,status:409})).error==='FOLDER_ACCOUNT_REVIEW_REQUIRED','the narrow command cannot replace an unfinished native Account projection')
 assert.deepEqual(await narrowState(),pendingAccount);checks++
 await pool.query("UPDATE crm_organizations SET sync_status='synced',suitecrm_synced_at=now() WHERE id=$1",[narrowAccount])
 const cleanBefore=await narrowState(),legacyBefore=legacyReconciliations
 const unrelated=async()=> (await pool.query(`SELECT
   (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.board_id,c.entity_type,c.entity_id) FROM crm_board_cards c WHERE c.entity_id<>$1::uuid) AS cards,
   (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.slug) FROM short_links l) AS links,
   (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM sync_outbox s WHERE s.aggregate_id<>$1::text) AS outbox`,[narrowAccount])).rows[0]
 const unrelatedBefore=await unrelated()
 await denied(()=>gateway.updateFractionalCrmCompany(stalePrincipal,narrowCompany,{...exactCommand,fields:{companyName:'Not authorized'}}),'CAPABILITY_DENIED')
 await denied(()=>gateway.updateFractionalCrmCustomerFolder(stalePrincipal,narrowCompany,{...exactCommand,folderUrl}),'INVALID_FOLDER_URL')
 check((await gateway.readFractionalCrmCompany(principal,narrowCompany)).canPush===false,'folder grant does not enable generic company profile pushes')
 await denied(()=>gateway.updateFractionalCrmCustomerFolder(stalePrincipal,narrowCompany,{...exactCommand,assertedFractionalActor:{...actor,customerId:'unknown'}}),'RECORD_NOT_FOUND')
 await denied(()=>gateway.updateFractionalCrmCustomerFolder({...stalePrincipal,workspaceOrganizationId:randomUUID()},narrowCompany,exactCommand),'CAPABILITY_DENIED')
 beforeCommit=async()=>{beforeCommit=null;throw Error('scoped folder projection rollback')}
 await assert.rejects(()=>gateway.updateFractionalCrmCustomerFolder(stalePrincipal,narrowCompany,exactCommand),/scoped folder projection rollback/);checks++
 assert.deepEqual(await narrowState(),cleanBefore);checks++
 const scopedPublished=await folderHttp(exactCommand,narrowScope),publishedState=await narrowState()
 check(scopedPublished.status==='published'&&scopedPublished.folderUrl===narrowFolderUrl&&publishedState.card.payload.crm.referenceCode===narrowCompany
  &&publishedState.card.payload.desc===publishedState.account.description&&publishedState.card.payload.comments[0].id==='narrow-comment',
  'narrow publish updates the exact account and pre-existing card while preserving its operator state')
 const patchRow=(await pool.query("SELECT id,operation,payload FROM sync_outbox WHERE aggregate_id=$1 AND idempotency_key LIKE 'crm:organizations:description-v1:%'",[narrowAccount])).rows[0]
 check(patchRow.operation==='patch_account_description','folder work uses a dedicated operation, never a generic upsert')
 const nativePatch=patchRow.payload
 assert.deepEqual(nativePatch,{entity:'organizations',pipelineId:pipeline,localId:narrowAccount,suiteCrmId:cleanBefore.account.suitecrm_id,
  attributes:{global_id_c:narrowCompany,description:publishedState.account.description},
  accountDescriptionPatch:{previousDescription:cleanBefore.account.description??''}});checks++
 assert.equal(publishedState.account.source_key,cleanBefore.account.source_key);assert.equal(publishedState.account.identity_key,cleanBefore.account.identity_key);checks+=2
 assert.deepEqual(await unrelated(),unrelatedBefore);checks++
 check(legacyReconciliations===legacyBefore&&publishedState.bpo_jobs===cleanBefore.bpo_jobs,'narrow request does not reconcile a pipeline or queue a BPO folder')
 assert.deepEqual(await folderHttp(exactCommand,narrowScope),scopedPublished);assert.deepEqual(await narrowState(),publishedState);checks+=2
 for(const url of [null,otherNarrowFolderUrl]){
  const response=await folderHttp({...exactCommand,folderUrl:url,ifMatch:scopedPublished.version,idempotencyKey:'gateway-scoped-change-'+String(Boolean(url))},{...narrowScope,status:409})
  assert.equal(response.error,'FOLDER_MANUAL_REVIEW_REQUIRED');checks++
 }
 check((await folderHttp({...exactCommand,folderUrl:otherNarrowFolderUrl},{...narrowScope,status:409})).error==='IDEMPOTENCY_CONFLICT','different URL cannot reuse a scoped publication key')
 await pool.query("UPDATE sync_outbox SET available_at='2000-01-01T00:00:00Z' WHERE id=$1",[patchRow.id])
 // The old claim operation allowlist is also checked in shallow CI. The
 // optional reviewed checkout test executes the actual predecessor code.
 const legacyCandidate=(await pool.query(`SELECT id FROM sync_outbox WHERE target_system='suitecrm'
   AND operation IN ('upsert_record', 'delete_record', 'reproject_record', 'upsert_user_identity')
   AND status IN ('queued','failed') AND attempts<8 AND available_at<=now()
   ORDER BY available_at,created_at LIMIT 1`)).rows[0]
 check(legacyCandidate&&legacyCandidate.id!==patchRow.id,'legacy claim allowlist excludes the highest-priority folder job')
 if(legacyCrmSource){
  for(const expiredLease of [false,true]){
   const rollbackLegacyClaim=async fn=>{const c=await pool.connect();try{
    await c.query('BEGIN')
    if(expiredLease)await c.query("UPDATE sync_outbox SET status='processing', attempts=1, locked_at='2000-01-01T00:00:00Z', lock_token='expired-folder-fixture' WHERE id=$1",[patchRow.id])
    const claimed=await fn(c)
    const seen=(await c.query('SELECT status,attempts,lock_token FROM sync_outbox WHERE id=$1',[patchRow.id])).rows[0]
    assert.deepEqual(seen,{status:expiredLease?'failed':'queued',attempts:expiredLease?1:0,lock_token:null});checks++
    return claimed
   }finally{try{await c.query('ROLLBACK')}finally{c.release()}}}
   const legacyCrm=load(crmPath,{...crmDeps,'@/lib/persistence/postgres':{query,withTransaction:rollbackLegacyClaim}}, {},legacyCrmSource)
   const claimed=await legacyCrm.claimSuiteCrmOutboxInPostgres({limit:1})
   check(claimed.length===1&&claimed[0].id!==patchRow.id,'actual pre-fix worker never claims the queued or reclaimed folder job')
  }
  console.log(`PASS exact legacy claim at ${reviewedLegacyCommit}; no dedicated folder work selected or delivered`)
 }
 const claimed=await crm.claimSuiteCrmOutboxInPostgres({limit:1});let patchItem=claimed[0]
 check(claimed.length===1&&patchItem.id===patchRow.id&&patchItem.operation==='patch_account_description'&&patchItem.attempts===1,
   'current worker claims the highest-priority dedicated job')
 const genericSpoof={...patchItem,operation:'upsert_record'}
 await assert.rejects(crm.withVerifiedSuiteCrmRecordLifecycle(genericSpoof,
  async()=>assert.fail('spoofed generic patch must not dispatch')),/publication scope changed/);checks++
 await assert.rejects(crm.completeSuiteCrmOutboxInPostgres(genericSpoof),/publication scope changed/);checks++
 await assert.rejects(crm.withVerifiedSuiteCrmRecordLifecycle({...patchItem,idempotencyKey:'stale-revision'},
  async()=>assert.fail('stale patch must not dispatch')),/identity changed/);checks++
 check(await crm.failSuiteCrmOutboxInPostgres({item:patchItem,error:'fixture description retry'})==='failed'
   &&(await narrowState()).account.sync_status==='pending','a failed exact attempt stays pending for compatible retry')
 await pool.query("UPDATE sync_outbox SET available_at='2000-01-01T00:00:00Z' WHERE id=$1",[patchRow.id])
 const retry=await crm.claimSuiteCrmOutboxInPostgres({limit:1});patchItem=retry[0]
 check(retry.length===1&&patchItem.id===patchRow.id&&patchItem.attempts===2,'dedicated retry reacquires the same exact job')
 check(await crm.withVerifiedSuiteCrmRecordLifecycle(patchItem,async()=>true),'current exact patch may dispatch through the existing lease/revision guard')
 await crm.completeSuiteCrmOutboxInPostgres(patchItem)
 check((await narrowState()).account.sync_status==='synced','ordinary completion updates only the exact current description revision')
 check((await pool.query('SELECT status FROM sync_outbox WHERE id=$1',[patchItem.id])).rows[0].status==='succeeded','exact description job reaches a durable completed status')
 assert.deepEqual(await unrelated(),unrelatedBefore);checks++
 const adoptScope={company:adopt.referenceCode,customerId:adoptSource.origin.customerId}
 const adoptRead=await folderHttp(undefined,adoptScope)
 const readAdoptCard=async()=> (await pool.query('SELECT to_jsonb(c) AS card FROM crm_board_cards c WHERE board_id=$1 AND entity_id=$2',[board,adopt.id])).rows[0].card
 const adoptCardBefore=await readAdoptCard()
 const adopted=await folderHttp({...folderCommand,folderUrl:narrowFolderUrl,ifMatch:adoptRead.version,idempotencyKey:'gateway-scoped-adoption',assertedFractionalActor:{...actor,customerId:adoptScope.customerId}},adoptScope)
 check(adoptRead.status==='manual_override'&&adopted.status==='published','existing matching manual reference is adopted')
 assert.deepEqual(await readAdoptCard(),adoptCardBefore);checks++
 await pool.query('UPDATE crm_organizations SET description=$2 WHERE id=$1',[narrowAccount,'Operator removed link'])
 await projection.reconcileCrmBoardProjectionsForPipeline({pipelineId:pipeline})
 check((await folderHttp(exactCommand,{...narrowScope,status:409})).error==='FOLDER_MANUAL_REVIEW_REQUIRED','scoped replay cannot restore an operator-removed link')
 const queuedBeforeArchive=(await pool.query(`INSERT INTO sync_outbox(aggregate_type,aggregate_id,operation,target_system,payload,status,idempotency_key)
   SELECT aggregate_type,aggregate_id,operation,target_system,payload,'queued','fixture-pending-folder-archive' FROM sync_outbox WHERE id=$1
   RETURNING id`,[patchItem.id])).rows[0].id
 await crm.archiveCrmRecordInPostgres({pipelineId:pipeline,entity:'organizations',id:narrowAccount,actorEmail:owner,emitSuiteCrmOutbox:false})
 check((await pool.query('SELECT id,status FROM sync_outbox WHERE id=ANY($1::uuid[])',[[queuedBeforeArchive,patchItem.id]])).rows.length===1
   &&(await pool.query('SELECT status FROM sync_outbox WHERE id=$1',[patchItem.id])).rows[0].status==='succeeded',
   'archive removes unclaimed dedicated writes without erasing completed delivery evidence')
 await pool.query('UPDATE fractional_crm_gateway_credentials SET capabilities=$2 WHERE id=$1',[credentialId,['crm.company.read']])
 await denied(()=>gateway.updateFractionalCrmCustomerFolder(stalePrincipal,narrowCompany,exactCommand),'CAPABILITY_DENIED')
 await pool.query('UPDATE fractional_crm_gateway_credentials SET capabilities=$2 WHERE id=$1',[credentialId,capabilities])
 principal=await gateway.readFractionalCrmCredential(credentialId)
 await pool.query("UPDATE crm_contacts SET source_payload=jsonb_set(source_payload,'{archived}','true') WHERE id=$1",[cb.id]);await denied(()=>gateway.readFractionalCrmContact(principal,b.referenceCode,cb.referenceCode),'RECORD_RETIRED')
 await assert.rejects(()=>pool.query('UPDATE fractional_crm_gateway_credentials SET token_hash=$2 WHERE id=$1',[credentialId,'b'.repeat(64)]),error=>error.code==='P0001'&&error.message.includes('credential identity is immutable'));checks++
 // The opt-in fixture prepares existing cards across this synthetic pipeline.
 // Run it only after assertions that intentionally exercise a missing card.
 if(joinedSources){const joined=await runFractionalCustomerFolderJoined({Pool,connectionOptions:{host:'127.0.0.1',port:Number(port),user:'postgres',password:'fractional_gateway_fixture',ssl:false,connectionTimeoutMillis:1000},capture:joinedSources,
  load,query,gateway,projection,stage,onboardingRequest:request,fixture:{org,pipeline,rootGlobalId:ga,instance,deployment,onboardingCredentialId:credentialId,board,auth,isGatewayPath:isFractionalCrmGatewayPath,folderContract,fractionalOrganizationId:'fractional-fixture'}})
  assert.equal(joined.passed,true);check(joined.folderOnlyMachineCredential===true,'actual joined sender uses an independently scoped credential');console.log(`FRACTIONAL_FOLDER_JOINED_EVIDENCE=${JSON.stringify(joined)}`)}
 await pool.query('UPDATE fractional_crm_gateway_credentials SET revoked_at=now() WHERE id=$1',[credentialId]);await denied(()=>gateway.readFractionalCrmOrganization(principal),'UNAUTHORIZED');await denied(()=>gateway.resolveOrCreateFractionalCrmOnboarding(principal,fresh,'gateway-create-pair'),'UNAUTHORIZED')
 check((await pool.query('SELECT count(*)::int AS n FROM app_users')).rows[0].n===1,'gateway creates no login or invitation user')
 console.log(`PASS ${checks} gateway PostgreSQL assertions; all migrations; real CRM staging/outbox; no external calls`)
}finally{try{if(pool)await pool.end()}finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{timeout:30000,stdio:'pipe'})}}
