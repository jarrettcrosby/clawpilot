#!/usr/bin/env node
// Default pure unit contract; optional guarded PG mode exercises real SQL/DAL.
// The privileged native adapter/review are ALWAYS synthetic: no native auth,
// dispatch, activation, production or readiness proof is supplied by this gate.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,isAbsolute,join,relative,resolve} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import {execFileSync,spawnSync} from 'node:child_process'
import {readdirSync} from 'node:fs'
import {disposablePostgresDockerArgs,createDisposablePostgresRuntime} from './lib/disposable-postgres-docker.mjs'
import {applyMigrationSqlForTest} from './lib/postgres-test-migrations.mjs'

const options={}
for(const arg of process.argv.slice(2)){
 const pg=/^--postgres-major=(16|18)$/.exec(arg)
 if(pg){assert.equal(options.postgresMajor,undefined);options.postgresMajor=pg[1]}
 else if(arg.startsWith('--build=')){assert.equal(options.build,undefined);options.build=arg.slice(8)}
 else throw Error('Use [--postgres-major=16|18] [--build=/absolute/generated-operator-directory]')
}
const postgresMajor=options.postgresMajor
assert.ok(!options.build||postgresMajor&&isAbsolute(options.build),'Compiled build mode requires an explicit PostgreSQL major and absolute build directory')
let compiledBuild=null
function verifyCompiledBuild(){
 if(!options.build)return
 assert.equal(process.versions.node.split('.')[0],'24');assert.ok(process.execArgv.includes('--conditions=react-server'),'Compiled PG mode requires ordinary Node --conditions=react-server')
 const root=resolve(options.build);assert.equal(realpathSync(root),root);assert.ok(lstatSync(root).isDirectory())
 const manifest=JSON.parse(readFileSync(join(root,'build-manifest.json'),'utf8'))
 assert.equal(manifest.version,1);assert.equal(manifest.purpose,'clawpilot-native-email-initial-private-operator-build')
 assert.equal(manifest.nodeMajor,24);assert.equal(manifest.requiredNodeCondition,'react-server');assert.equal(manifest.entry,'ops/native-email-initial.js')
 const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
 for(const [base,inventory]of [[root,manifest.outputs],[resolve('app_src'),manifest.sources]]){
  assert.ok(inventory&&typeof inventory==='object'&&!Array.isArray(inventory)&&Object.keys(inventory).length>0&&Object.keys(inventory).length<250)
  for(const [file,expected]of Object.entries(inventory)){
   assert.ok(!isAbsolute(file)&&relative(base,resolve(base,file))===file&&!file.startsWith('..'),'Build manifest path must remain inside its fixed tree')
   assert.match(expected,/^[a-f0-9]{64}$/);assert.equal(digest(readFileSync(resolve(base,file))),expected,'Compiled build/source drift: '+file)
  }
 }
 const compiledRequire=createRequire(join(root,manifest.entry))
 compiledBuild={root,entry:join(root,manifest.entry),manifest,
  Operator:compiledRequire(join(root,'lib/crm/nativeEmailInitialEnrollmentOperator.js')).NativeEmailInitialEnrollmentOperator,
  Store:compiledRequire(join(root,'lib/crm/nativeEmailInitialEnrollmentPostgres.js')).PostgresNativeEmailInitialEnrollmentStore,
  createIssuer:compiledRequire(join(root,'lib/crm/nativeEmailInitialEnrollmentApproval.js')).createNativeEmailInitialApprovalIssuer}
}
verifyCompiledBuild()
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript'),cache=new Map(),sourceHashes={}
sourceHashes[resolve('scripts/test-native-email-initial-enrollment-operator.mjs')]=crypto.createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')
function load(path){path=resolve(path);if(cache.has(path))return cache.get(path).exports
 const module={exports:{}};cache.set(path,module);const bytes=readFileSync(path,'utf8');sourceHashes[path]=crypto.createHash('sha256').update(bytes).digest('hex')
 const compiled=ts.transpileModule(bytes,{fileName:path,reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}})
 assert.deepEqual(compiled.diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error),[],'Operator dependency syntax')
 new Function('require','module','exports',compiled.outputText)(name=>name==='server-only'?{}:name.startsWith('node:')?require(name):load(resolve(dirname(path),name+'.ts')),module,module.exports)
 return module.exports}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts'),json=protocol.nativeEmailCanonicalJson,hash=protocol.nativeEmailDigest
const {NativeEmailInitialEnrollmentOperator:Operator}=load('app_src/lib/crm/nativeEmailInitialEnrollmentOperator.ts')
const lineageApi=load('app_src/lib/crm/nativeEmailInitialInstallationLineage.ts')
const copy=value=>JSON.parse(json(value)),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
// A PostgreSQL JSONB value is not a native wire payload; preserve empty objects.
const sqlCopy=value=>JSON.parse(JSON.stringify(value))
const surfaces=['view','list','export','edit','delete'],op=hash('reserved-operator'),fp=hash('SQL-owned-fingerprint-fixture-not-real-PG')
const selection={actorEmail:'owner@example.invalid',operatorAccountId:id(1),rootWorkspaceId:id(2),nativeInstanceId:'operator-private-native'}
const pipelineIds=[id(10),id(11),id(12)],principals=['admin','editor','outsider','trash-native','viewer']
const caps=(readers,writers=readers)=>({view:[...readers],list:[...readers],export:[...readers],edit:[...writers],delete:[...writers]})
const afterPolicy=hash('native-projected-policy'),afterRuntime=hash('native-projected-runtime'),installed=hash('actual-installed-fixture'),journal=hash('protected-installer-fixture')
const byteHash=bytes=>crypto.createHash('sha256').update(bytes,'utf8').digest('hex')
// File-path object keys are private proof metadata, not native permission wire
// keys. Hash a sorted [path, sha] inventory without relaxing the wire grammar.
const migrationInventoryFingerprint=inventory=>hash(Object.entries(inventory).sort(([a],[b])=>a<b?-1:a>b?1:0))
function fixture(){
 const mappings=[0,1].map(i=>({localId:id(30+i),nativeId:id(40+i),globalId:'gi'+String(1000000+i),pipelineId:pipelineIds[i],workspaceId:selection.rootWorkspaceId,
  archived:i===0,recordFingerprint:hash(['app-row',i])}))
 const snapshot={version:1,generation:'7',users:[],memberships:[],workspaces:[],pipelines:[],pipelineMembers:[],operatorAccounts:[],operatorBindings:[],employeeGrants:[],
  emails:copy(mappings),pendingOutbox:[],capabilityPolicies:[]}
 const state={ownerAllowed:true,control:{singleton:true,generation:'7',enabled:false,active_operation_id:null,active_transition_id:null,active_initial_enrollment_id:op},snapshot,
  reservation:{operation_id:op,actor_email:selection.actorEmail,operator_account_id:selection.operatorAccountId,root_workspace_id:selection.rootWorkspaceId,
   native_instance_id:selection.nativeInstanceId,generation:'7',state:'reserved',source_snapshot:copy(snapshot),source_fingerprint:fp,retained_fingerprint:fp},
  pipelines:pipelineIds.map(pid=>({id:pid,owner_email:selection.actorEmail,workspace_organization_id:selection.rootWorkspaceId,reference_access_disabled:false})),
  members:[['app-only','editor'],['denied','editor'],['editor','editor'],['trash','editor'],['viewer','viewer']].map(([name,role])=>({user_email:name+'@example.invalid',access_role:role})),
  nativeSource:{version:1,purpose:'clawpilot-native-email-initial-source',nativePolicyFingerprint:hash('actual-native-before-policy-fixture'),nativeRuntimeFingerprint:hash('actual-stock-runtime-fixture'),
   principalSuiteCrmUserIds:[...principals],emails:mappings.map((m,i)=>({...m,recordFingerprint:hash(['native-content',i]),capabilities:caps(principals,i===0?principals:['admin'])})),
   defaults:['delete','edit','export','list','view'].map((action,i)=>({id:id(60+i),action,aclAccess:90}))},
  sql:[],nativeCalls:[],transactions:0,afterNative:null,modifyForecast:null,quarantineEvidence:new Map(),quarantineResult:null,unmanagedPipelines:new Set()}
 const principalRows=()=>[
  {email:selection.actorEmail,suitecrm_user_id:'admin',membership_role:'owner',membership_permissions:{viewCrm:false}},
  {email:'editor@example.invalid',suitecrm_user_id:'editor',membership_role:'member',membership_permissions:{viewCrm:true}},
  {email:'viewer@example.invalid',suitecrm_user_id:'viewer',membership_role:'member',membership_permissions:{}},
  {email:'denied@example.invalid',suitecrm_user_id:'outsider',membership_role:'member',membership_permissions:{viewCrm:false}},
  {email:'trash@example.invalid',suitecrm_user_id:'trash-native',membership_role:'member',membership_permissions:{viewCrm:true},membership_status:'disabled',membership_trashed_at:'2026-01-01T00:00:00.000Z'},
  {email:'app-only@example.invalid',suitecrm_user_id:null,membership_role:'member',membership_permissions:{viewCrm:true}},
 ].map(row=>({status:'active',workspace_id:selection.rootWorkspaceId,membership_status:'active',membership_trashed_at:null,native_identity_count:row.suitecrm_user_id===null?0:1,...row}))
 const query=async(sql,values=[])=>{state.sql.push({sql,values:copy(values)});assert.ok(/^\s*SELECT/.test(sql),'Source collector may not write SQL')
  if(sql.includes('SELECT * FROM crm_native_email_publication_control'))return {rows:[copy(state.control)]}
  if(sql.includes('SELECT singleton FROM crm_native_email_publication_control'))return {rows:[{singleton:true}]}
  if(sql.includes('SELECT a.id FROM crm_operator_accounts'))return {rows:state.ownerAllowed&&json(values)===json([selection.operatorAccountId,selection.rootWorkspaceId,selection.actorEmail])?[{id:selection.operatorAccountId}]:[]}
  if(sql.includes('FROM crm_native_email_initial_reservations r'))return {rows:[sqlCopy(state.reservation)]}
  if(sql.includes('clawpilot_crm_native_initial_source_snapshot()'))return {rows:[{snapshot:sqlCopy(state.snapshot),fingerprint:fp,
   snapshot_matches_reservation:isDeepStrictEqual(state.snapshot,state.reservation.source_snapshot)}]}
  if(sql.includes('clawpilot_crm_native_initial_demo_quarantine(')){
   assert.match(sql,/FROM unnest\(\$1::uuid\[\],\$2::text\[\]\)/)
   const pending=state.snapshot.pendingOutbox.filter(row=>!(row.status==='queued'&&row.attempts===0&&row.lockedAt===null
    &&row.lockToken===null&&row.hasError===false&&row.processedAt===null))
   assert.deepEqual(values,[pending.map(row=>row.id),pending.map(row=>row.rowFingerprint)],'Batch lookup must use the exact retained IDs and full-row hashes')
   return {rows:state.quarantineResult??values[0].map((rowId,index)=>({id:rowId,quarantined:state.quarantineEvidence.get(rowId)===values[1][index]}))}
  }
  if(sql.includes('FROM pipeline_spaces p JOIN workspace_organizations'))return {rows:copy(state.pipelines)}
  if(sql.includes('clawpilot_crm_native_unmanaged_pipeline_footprint('))return {rows:[{unmanaged:state.unmanagedPipelines.has(values[0])}]}
  if(sql.includes('SELECT DISTINCT g.id::text'))return {rows:[]}
  if(sql.includes('FROM pipeline_space_members WHERE'))return {rows:copy(state.members)}
  if(sql.includes('FROM app_users u LEFT JOIN app_user_organization_memberships'))return {rows:principalRows().filter(row=>values[1].includes(row.email))}
  throw Error('Unexpected synthetic query shape')}
 const transaction=async fn=>{state.transactions++;try{return await fn({query})}finally{state.transactions--}}
 function nativeForecast(request){const {plan,preparedAt}=request
  const policies=plan.pipelines.map(({policy})=>{const future={...policy};delete future.historical;return {pipelineId:policy.pipelineId,generation:plan.appGeneration,policy,fingerprint:hash(future)}})
  const bindings=plan.pipelines.map(({groupId,policy:p})=>{const future={...p};delete future.historical;return {pipeline_id:p.pipelineId,workspace_id:p.workspaceId,group_id:groupId,generation:String(plan.appGeneration),
   owner_id:p.ownerSuiteCrmId,readers_json:json(p.futureCreate.view),audience_fingerprint:p.audienceFingerprint,policy_fingerprint:afterPolicy,runtime_fingerprint:afterRuntime,
   capability_policy_json:json(p),capability_policy_fingerprint:hash(future),enabled:'1'}})
  const result={generation:plan.appGeneration,appSourceFingerprint:plan.appSourceFingerprint,beforePolicyFingerprint:plan.nativePolicyBeforeFingerprint,afterPolicyFingerprint:afterPolicy,
   sourceRuntimeFingerprint:plan.nativeRuntimeBeforeFingerprint,installedRuntimeFingerprint:installed,runtimeFingerprint:afterRuntime,
   identityFingerprint:hash(plan.emails.map(({after})=>{const row={...after};delete row.capabilities;return row})),
   capabilitiesFingerprint:hash(plan.emails.map(({after})=>({emailId:after.nativeId,globalId:after.globalId,pipelineId:after.pipelineId,capabilities:after.capabilities}))),
   bindingsFingerprint:hash(bindings),defaultsFingerprint:hash(plan.defaults.map(row=>row.after)),emailCount:plan.emails.length,principalCount:principals.length}
  const delta={version:1,purpose:'clawpilot-native-email-initial-policy-delta',operationId:plan.operationId,planHash:hash(plan),preparedAt,
   changes:{acl_actions:[],securitygroups:[],securitygroups_users:[],securitygroups_records:[]},result,policies}
  const forecast={version:1,purpose:'clawpilot-native-email-initial-enrollment-forecast',operationId:plan.operationId,planHash:hash(plan),preparedAt,deltaFingerprint:hash(delta),nativeDelta:delta,result,policies}
  return {forecast,installationJournalFingerprint:journal}}
 const call=async(name,read)=>{assert.equal(state.transactions,0,'No privileged native call may run under a PG transaction');state.nativeCalls.push(name);const result=read();if(state.afterNative)state.afterNative(name);return result}
 const port={inspectSource:source=>call('inspectSource',()=>{assert.deepEqual(source.mappings,state.snapshot.emails);return json(state.nativeSource)+'\n'}),
  readSource:()=>call('readSource',()=>json(state.nativeSource)+'\n'),project:request=>call('project',()=>{const value=nativeForecast(request);state.modifyForecast?.('project',value);return value}),
  prepare:request=>call('prepare',()=>{assert.equal(request.plan.nativePolicyAfterFingerprint,afterPolicy);assert.equal(request.plan.nativeRuntimeAfterFingerprint,afterRuntime)
   const value=nativeForecast(request);state.modifyForecast?.('prepare',value);return value})}
 const operator=new Operator(transaction,selection,port),input=()=>({operationId:op,appSourceFingerprint:fp,sourceArtifactDigest:byteHash(json(state.nativeSource)+'\n'),preparedAt:'2026-11-03 19:00:00'})
 return {state,operator,input,port,transaction}}
function installedFixture(){
 const f=fixture(),rootOperationId=hash('cancelled-original-root')
 const context={version:1,purpose:'clawpilot-native-email-initial-replan-context',rootOperationId,
  rootInstallationJournalFingerprint:hash('actual-root-journal-fixture'),rootSourceArtifactDigest:hash('independently-retained-root-source'),
  rootStockRuntimeFingerprint:hash('old-stock-runtime-provenance'),predecessorOperationId:rootOperationId,
  predecessorPlanHash:hash('cancelled-original-plan'),predecessorApprovalHash:hash('cancelled-original-approval'),
  predecessorCancellationReceiptHash:hash('actual-cancelled-receipt'),previousLineageHash:null,depth:1,
  cancelledHistoryFingerprint:hash('complete-actual-history-fixture')}
 f.state.nativeSource={...f.state.nativeSource,version:2,purpose:'clawpilot-native-email-initial-installed-source',
  nativeRuntimeFingerprint:installed,installationContext:context}
 f.state.modifyForecast=(stage,value)=>{void stage
  value.installationJournalFingerprint=hash({version:1,purpose:'clawpilot-native-email-initial-effective-installation',
   rootInstallationJournalFingerprint:context.rootInstallationJournalFingerprint,
   installationLineageHash:hash(lineageApi.finalizeNativeEmailInitialInstallationLineage(context,op,f.input().sourceArtifactDigest,installed))})}
 const port={...f.port,inspectInstalledSource:async(source,requested)=>{
  assert.equal(f.state.transactions,0);assert.deepEqual(source.mappings,f.state.snapshot.emails);assert.deepEqual(requested,context)
  f.state.nativeCalls.push('inspectInstalledSource');f.state.afterNative?.('inspectInstalledSource');return json(f.state.nativeSource)+'\n'}}
 return {...f,context,port,operator:new Operator(f.transaction,selection,port)}
}
let checks=0
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name)}
const held=pattern=>error=>pattern.test(String(error?.code??error?.message??error))
function retainedQuarantine(index){return {id:id(120+index),targetSystem:'suitecrm',aggregateType:index===0?'crm_products':'crm_interactions',
 aggregateId:id(130+index),operation:index===0?'upsert_record':'reproject_record',status:'dead',attempts:index===0?1:4,
 lockedAt:null,lockToken:null,hasError:true,processedAt:'2026-10-01T00:00:00.000Z',availableAt:'infinity',rowFingerprint:hash(['retained-demo-quarantine',index])}}
function withQuarantine(f=fixture()){
 f.state.snapshot.pendingOutbox=[retainedQuarantine(0),retainedQuarantine(1)]
 f.state.reservation.source_snapshot=sqlCopy(f.state.snapshot)
 f.state.quarantineEvidence=new Map(f.state.snapshot.pendingOutbox.map(row=>[row.id,row.rowFingerprint]))
 return f
}
await check('private migration metadata fingerprints sorted path-value pairs without relaxing native permission wire keys',()=>{
 const first={'/absolute/db/migrations/0398_fixture.sql':'a'.repeat(64),'/absolute/db/migrations/0001_fixture.sql':'b'.repeat(64)}
 assert.throws(()=>hash(first),held(/invalid_json_key/))
 assert.equal(migrationInventoryFingerprint(first),migrationInventoryFingerprint(Object.fromEntries(Object.entries(first).reverse())))
 assert.notEqual(migrationInventoryFingerprint(first),migrationInventoryFingerprint({...first,'/absolute/db/migrations/0398_fixture.sql':'c'.repeat(64)}))
})
await check('actual query contract locks control first and returns only complete reserved mapping DTO',async()=>{
 const f=fixture(),value=await f.operator.collectReservedSource(op,fp);assert.equal(f.state.sql[0].sql,'SELECT * FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
 assert.deepEqual(Object.keys(value).sort(),['operationId','nativeInstanceId','appGeneration','appSourceFingerprint','mappings'].sort());assert.equal(value.mappings.length,2)
 assert.equal(f.state.nativeCalls.length,0);assert.ok(f.state.sql.some(row=>row.sql.includes('clawpilot_crm_native_initial_source_snapshot()')))
 assert.ok(f.state.sql.some(row=>row.sql.includes('SELECT DISTINCT g.id::text')),'Existing root readership must be collected, not inferred')
})
await check('general SQL metadata permits empty permissions objects without weakening native wire grammar',async()=>{
 const f=fixture();f.state.snapshot.users=[{email:selection.actorEmail,permissions:{}}];f.state.reservation.source_snapshot=sqlCopy(f.state.snapshot)
 assert.equal((await f.operator.prepareForReview(f.input())).material.plan.emails.length,2)
 f.state.snapshot.users[0].permissions.viewCrm=false
 await assert.rejects(f.operator.collectReservedSource(op,fp),held(/source_changed/))
})
await check('candidate covers empty future pipelines and preserves exact native content/archive/editor intersections',async()=>{
 const f=fixture(),captured=await f.operator.captureSource(op,fp);assert.equal(captured.sourceArtifactDigest,f.input().sourceArtifactDigest)
 assert.notEqual(f.state.snapshot.emails[0].recordFingerprint,f.state.nativeSource.emails[0].recordFingerprint,'App/native hashes are different domains')
 const candidate=await f.operator.prepareForReview(f.input()),m=candidate.material;assert.equal(candidate.executable,false);assert.equal(m.plan.pipelines.length,3)
 assert.deepEqual(m.plan.pipelines[2].policy.futureCreate,caps(['admin','editor','viewer'],['admin','editor']))
 assert.equal(m.plan.emails[0].after.archived,true);assert.deepEqual(m.plan.emails[0].after.capabilities.edit,['admin','editor'])
 assert.deepEqual(m.plan.emails[1].after.capabilities.edit,['admin']);assert.equal(m.plan.emails[0].after.recordFingerprint,f.state.nativeSource.emails[0].recordFingerprint)
 assert.deepEqual(m.plan.rootEmployeeGrants,[]);assert.deepEqual(f.state.nativeCalls,['inspectSource','readSource','project','prepare'])
 const again=await f.operator.prepareForReview(f.input());assert.equal(again.material.planHash,m.planHash)
 assert.deepEqual(await f.operator.readReviewedMaterial(f.input(),m.planHash),m)
 await assert.rejects(f.operator.readReviewedMaterial(f.input(),'f'.repeat(64)),held(/reviewed_plan_changed/))
})
await check('same-operation forward recovery reads exact independently pinned retained bytes without fresh stock inspection',async()=>{
 const f=fixture(),input=f.input(),before=sqlCopy(f.state.reservation)
 const value=await f.operator.recoverRetainedSource(op,fp,input.sourceArtifactDigest)
 assert.equal(value.sourceBytes,json(f.state.nativeSource)+'\n');assert.equal(value.sourceArtifactDigest,input.sourceArtifactDigest)
 assert.deepEqual(value.source.mappings,f.state.snapshot.emails);assert.deepEqual(f.state.nativeCalls,['readSource'])
 assert.equal(f.state.sql.filter(row=>row.sql==='SELECT * FROM crm_native_email_publication_control WHERE singleton FOR UPDATE').length,2)
 assert.deepEqual(f.state.reservation,before);assert.equal(f.state.control.active_initial_enrollment_id,op)
})
await check('replacement source is fresh installed observation and its separate byte digest is signed into lineage',async()=>{
 const f=installedFixture(),captured=await f.operator.captureReplanSource(op,fp,f.context)
 assert.equal(captured.sourceArtifactDigest,f.input().sourceArtifactDigest)
 const m=(await f.operator.prepareForReview(f.input())).material
 assert.equal(m.plan.kind,'initial_enrollment_replan_v1')
 assert.equal(m.plan.installationLineage.freshSourceArtifactDigest,captured.sourceArtifactDigest)
 assert.equal(m.plan.installationLineage.freshInstalledRuntimeFingerprint,installed)
 assert.equal(m.plan.installationLineage.rootStockRuntimeFingerprint,f.context.rootStockRuntimeFingerprint)
 assert.notEqual(m.sourceRuntimeFingerprint,m.plan.installationLineage.rootStockRuntimeFingerprint)
 assert.equal(m.sourceRuntimeFingerprint,installed);assert.equal(m.installedRuntimeFingerprint,installed)
 assert.equal(m.installationJournalFingerprint,lineageApi.effectiveNativeEmailInitialInstallationJournalFingerprint(m.plan.installationLineage,op))
 assert.deepEqual(f.state.nativeCalls,['inspectInstalledSource','readSource','project','prepare'])
 assert.equal(Object.hasOwn(JSON.parse(captured.sourceBytes).installationContext,'freshSourceArtifactDigest'),false)
 assert.deepEqual(m.plan.rootEmployeeGrants,[])
})
await check('replacement capture cannot fall back to stock, add caller authority or escape current SQL ownership',async()=>{
 const f=fixture();await assert.rejects(f.operator.captureReplanSource(op,fp,installedFixture().context),held(/installed_source_port_required/))
 const g=installedFixture();await assert.rejects(g.operator.captureSource(op,fp),held(/stock_source_required/))
 const h=installedFixture();await assert.rejects(h.operator.captureReplanSource(op,fp,{...h.context,approved:true}),held(/shape/))
 assert.deepEqual(h.state.nativeCalls,[])
 const i=installedFixture();i.state.afterNative=name=>{if(name==='inspectInstalledSource')i.state.ownerAllowed=false}
 await assert.rejects(i.operator.captureReplanSource(op,fp,i.context),held(/operator_denied/))
 assert.deepEqual(i.state.nativeCalls,['inspectInstalledSource'])
})
await check('replacement context, effective journal and fresh installed runtime mismatch fail before approval',async()=>{
 const f=installedFixture(),expected={...f.context};f.state.nativeSource.installationContext={...f.context,rootSourceArtifactDigest:hash('wrong-root')}
 await assert.rejects(f.operator.captureReplanSource(op,fp,expected),held(/installed_source_context_changed/))
 const g=installedFixture();g.state.modifyForecast=(_,value)=>{value.installationJournalFingerprint=journal}
 await assert.rejects(g.operator.prepareForReview(g.input()),held(/replan_installation_journal_changed/))
 const h=installedFixture(),prior=h.state.modifyForecast;h.state.modifyForecast=(stage,value)=>{prior(stage,value)
  value.forecast.result.installedRuntimeFingerprint=hash('wrong-installed-runtime');value.forecast.deltaFingerprint=hash(value.forecast.nativeDelta)}
 await assert.rejects(h.operator.prepareForReview(h.input()),held(/replan_installed_runtime_changed/))
})
await check('retained source recovery refuses a different digest, incomplete identities and caller completeness claims',async()=>{
 const f=fixture();await assert.rejects(f.operator.recoverRetainedSource(op,fp,hash('wrong-independent-pin')),held(/source_artifact_changed/))
 for(const mutate of [f=>f.state.nativeSource.emails.pop(),f=>{f.state.nativeSource.emails[0].pipelineId=id(99)},
  f=>{f.state.nativeSource.complete=true},f=>{f.state.nativeSource.principalSuiteCrmUserIds.push('viewer')}]){
  const g=fixture();mutate(g);await assert.rejects(g.operator.recoverRetainedSource(op,fp,g.input().sourceArtifactDigest),held(/native_email_inventory|native_mapping_changed|shape|principal_inventory/))
  assert.deepEqual(g.state.nativeCalls,['readSource'])
 }
})
await check('retained recovery reauthorizes the SQL reservation before and after privileged remote reads',async()=>{
 const f=fixture();f.state.ownerAllowed=false
 await assert.rejects(f.operator.recoverRetainedSource(op,fp,f.input().sourceArtifactDigest),held(/operator_denied/));assert.deepEqual(f.state.nativeCalls,[])
 const g=fixture();g.state.afterNative=name=>{if(name==='readSource')g.state.ownerAllowed=false}
 await assert.rejects(g.operator.recoverRetainedSource(op,fp,g.input().sourceArtifactDigest),held(/operator_denied/));assert.deepEqual(g.state.nativeCalls,['readSource'])
 const h=fixture();h.state.reservation.state='cancelled'
 await assert.rejects(h.operator.recoverRetainedSource(op,fp,h.input().sourceArtifactDigest),held(/reservation_changed/));assert.deepEqual(h.state.nativeCalls,[])
})
await check('disabled publication, exact selection/reservation/generation/source and current root ownership are independently required',async()=>{
 for(const mutate of [f=>{f.state.ownerAllowed=false},f=>{f.state.control.enabled=true},f=>{f.state.control.active_initial_enrollment_id=hash('other')},
  f=>{f.state.reservation.actor_email='other@example.invalid'},f=>{f.state.reservation.generation='8'},f=>{f.state.reservation.retained_fingerprint=hash('other')},
  f=>{f.state.reservation.state='cancelled'},f=>{f.state.snapshot.generation='8'}]){const f=fixture();mutate(f);await assert.rejects(f.operator.prepareForReview(f.input()),held(/operator_denied|barrier_changed|reservation_changed|source_changed/));assert.deepEqual(f.state.nativeCalls,[])}
})
await check('global mapped inventory cannot be silently subsetted, duplicated or assigned to another operator',async()=>{
 for(const mutate of [f=>{f.state.pipelines=f.state.pipelines.slice(1)},f=>{f.state.snapshot.emails[1].nativeId=f.state.snapshot.emails[0].nativeId;f.state.reservation.source_snapshot=copy(f.state.snapshot)},
  f=>{f.state.snapshot.emails[0].workspaceId=id(99);f.state.reservation.source_snapshot=copy(f.state.snapshot)}]){const f=fixture();mutate(f);await assert.rejects(f.operator.collectReservedSource(op,fp),held(/unbound_email_inventory|duplicate_mapping/))}
 const f=fixture();f.state.snapshot.pendingOutbox=[{operation:'upsert_user_identity',status:'queued',attempts:0,lockedAt:null,lockToken:null,hasError:false,processedAt:null}];f.state.reservation.source_snapshot=copy(f.state.snapshot)
 await assert.rejects(f.operator.collectReservedSource(op,fp),held(/pending_writer/))
})
await check('exact terminal quarantine is independently batch-verified while all original source evidence is retained',async()=>{
 const f=withQuarantine(),before=sqlCopy(f.state.snapshot)
 const value=await f.operator.collectReservedSource(op,fp)
 assert.deepEqual(value.mappings,before.emails)
 assert.equal(f.state.sql.filter(row=>row.sql.includes('clawpilot_crm_native_initial_demo_quarantine(')).length,1,
  'Two retained dead rows require one bounded batch, not one query per row')
 assert.deepEqual(f.state.nativeCalls,[])
 assert.deepEqual(f.state.snapshot,before);assert.deepEqual(f.state.reservation.source_snapshot,before)
 const material=(await f.operator.prepareForReview(f.input())).material
 assert.equal(material.plan.emails.length,2);assert.equal(material.plan.pipelines.length,3)
 assert.deepEqual(f.state.snapshot.pendingOutbox,before.pendingOutbox)
 assert.deepEqual(material.plan.rootEmployeeGrants,[])
 const replan=withQuarantine(installedFixture()),captured=await replan.operator.captureReplanSource(op,fp,replan.context)
 assert.equal(captured.source.mappings.length,2)
 assert.equal((await replan.operator.prepareForReview(replan.input())).material.plan.kind,'initial_enrollment_replan_v1')
 assert.deepEqual(replan.state.snapshot.pendingOutbox,before.pendingOutbox)
})
await check('unverified, missing, duplicate, substituted and nonboolean quarantine responses hold before native access',async()=>{
 const known=[retainedQuarantine(0),retainedQuarantine(1)]
 for(const rows of [[],[{id:known[0].id,quarantined:true}],
  [{id:known[0].id,quarantined:true},{id:known[0].id,quarantined:true}],
  [{id:known[0].id,quarantined:true},{id:id(999),quarantined:true}],
  [{id:known[0].id,quarantined:true},{id:known[1].id,quarantined:false}],
  [{id:known[0].id,quarantined:true},{id:known[1].id,quarantined:null}],
  [{id:known[0].id,quarantined:true},{id:known[1].id,quarantined:'true'}],
  [...known.map(row=>({id:row.id,quarantined:true})),{id:id(999),quarantined:true}],
 ]){const f=withQuarantine();f.state.quarantineResult=rows
  await assert.rejects(f.operator.captureSource(op,fp),held(/pending_writer/));assert.deepEqual(f.state.nativeCalls,[])}
 for(const mutate of [f=>{f.state.snapshot.pendingOutbox[0].rowFingerprint=hash('changed-full-outbox-row')},
  f=>{f.state.snapshot.pendingOutbox[0].id=id(999)},f=>{f.state.snapshot.pendingOutbox[0].targetSystem='other'},
  f=>{f.state.snapshot.pendingOutbox[0].rowFingerprint='invalid'},
  f=>{f.state.snapshot.pendingOutbox[1].id=f.state.snapshot.pendingOutbox[0].id},
  f=>{f.state.snapshot.pendingOutbox[0].operation='upsert_user_identity'},
 ]){const f=withQuarantine();mutate(f);f.state.reservation.source_snapshot=sqlCopy(f.state.snapshot)
  await assert.rejects(f.operator.captureSource(op,fp),held(/pending_writer|hash/));assert.deepEqual(f.state.nativeCalls,[])}
})
await check('ordinary dead, failed, processing and retried work cannot inherit demo classification; untouched queued work still needs no bypass',async()=>{
 for(const status of ['dead','failed','processing','queued']){const f=withQuarantine()
  f.state.snapshot.pendingOutbox[0].status=status;f.state.quarantineEvidence.clear()
  f.state.reservation.source_snapshot=sqlCopy(f.state.snapshot)
  await assert.rejects(f.operator.collectReservedSource(op,fp),held(/pending_writer/));assert.deepEqual(f.state.nativeCalls,[])}
 const f=fixture();f.state.snapshot.pendingOutbox=[{operation:'upsert_record',status:'queued',attempts:0,
  lockedAt:null,lockToken:null,hasError:false,processedAt:null}];f.state.reservation.source_snapshot=sqlCopy(f.state.snapshot)
 assert.equal((await f.operator.collectReservedSource(op,fp)).mappings.length,2)
 assert.equal(f.state.sql.some(row=>row.sql.includes('clawpilot_crm_native_initial_demo_quarantine(')),false)
})
await check('source artifact bytes and native complete inventory must match independently; no completeness JSON accepted',async()=>{
 for(const mutate of [f=>{f.state.nativeSource.emails.pop()},f=>{f.state.nativeSource.emails[0].archived=false},f=>{f.state.nativeSource.emails[0].pipelineId=id(99)},
  f=>{f.state.nativeSource.complete=true},f=>{f.state.nativeSource.principalSuiteCrmUserIds.push('viewer')}]){const f=fixture();mutate(f);await assert.rejects(f.operator.prepareForReview(f.input()),held(/native_email_inventory|native_mapping_changed|shape|principal_inventory/))}
 const f=fixture(),old=f.input();f.state.nativeSource.emails[0].recordFingerprint=hash('changed-native-body');await assert.rejects(f.operator.prepareForReview(old),held(/source_artifact_changed/))
})
await check('history never receives new readers/editors; current denied, trashed and app-only users are not native readers',async()=>{
 const f=fixture();for(const e of f.state.nativeSource.emails)for(const surface of surfaces)e.capabilities[surface]=e.capabilities[surface].filter(id=>id!=='viewer')
 await assert.rejects(f.operator.prepareForReview(f.input()),held(/historical_grant_forbidden/));assert.deepEqual(f.state.nativeCalls,['readSource'])
 const g=fixture(),m=(await g.operator.prepareForReview(g.input())).material;assert.deepEqual(m.plan.emails[0].after.capabilities.view,['admin','editor','viewer'])
 for(const row of m.plan.emails)for(const surface of surfaces)assert.ok(row.after.capabilities[surface].every(id=>row.before.capabilities[surface].includes(id)))
})
await check('only SQL-proven unmanaged pipelines are omitted; complete immutable source and every historical mapping stay retained',async()=>{
 const f=fixture(),personal=id(98)
 f.state.pipelines.push({id:personal,owner_email:'app-only@example.invalid',workspace_organization_id:selection.rootWorkspaceId,reference_access_disabled:false})
 f.state.snapshot.pipelines=copy(f.state.pipelines);f.state.reservation.source_snapshot=sqlCopy(f.state.snapshot)
 f.state.unmanagedPipelines.add(personal)
 const before=sqlCopy(f.state.snapshot),prepared=await f.operator.prepareForReview(f.input())
 assert.equal(prepared.material.plan.pipelines.length,3);assert.equal(prepared.material.plan.emails.length,2)
 assert.ok(!prepared.material.plan.pipelines.some(p=>p.policy.pipelineId===personal))
 assert.deepEqual(f.state.snapshot,before);assert.deepEqual(f.state.reservation.source_snapshot,before)
 f.state.unmanagedPipelines.clear()
 await assert.rejects(f.operator.collectReservedSource(op,fp),held(/authority_owner_ineligible|owner_native_identity/))
 const unsafe=fixture();unsafe.state.unmanagedPipelines.add(pipelineIds[0])
 await assert.rejects(unsafe.operator.collectReservedSource(op,fp),held(/unbound_email_inventory/))
})
await check('native requests occur outside SQL locks and SQL authority is recollected after native I/O',async()=>{
 const f=fixture();f.state.afterNative=name=>{if(name==='inspectSource')f.state.ownerAllowed=false}
 await assert.rejects(f.operator.captureSource(op,fp),held(/operator_denied/));assert.deepEqual(f.state.nativeCalls,['inspectSource'])
 const g=fixture();g.state.afterNative=name=>{if(name==='prepare')g.state.ownerAllowed=false}
 await assert.rejects(g.operator.prepareForReview(g.input()),held(/operator_denied/));assert.equal(g.state.transactions,0)
})
await check('forecast/source/journal/delta cross-binding and native error sanitization stay held',async()=>{
 for(const mutate of [(stage,v)=>{if(stage==='prepare')v.installationJournalFingerprint=hash('other')},(stage,v)=>{if(stage==='project')v.forecast.planHash=hash('other')},
  (stage,v)=>{if(stage==='prepare'){v.forecast.result.emailCount=99;v.forecast.deltaFingerprint=hash(v.forecast.nativeDelta)}},
  (stage,v)=>{if(stage==='prepare'){v.forecast.result.capabilitiesFingerprint=hash('other');v.forecast.deltaFingerprint=hash(v.forecast.nativeDelta)}}]){
  const f=fixture();f.state.modifyForecast=mutate;await assert.rejects(f.operator.prepareForReview(f.input()),held(/native_changed_between_preparations|forecast_binding|forecast_source|forecast_inventory/))}
 const f=fixture();const bad=new Operator(f.transaction,selection,{...f.port,inspectSource:async()=>{throw Error('sensitive-native-provider-detail')}})
 await assert.rejects(bad.captureSource(op,fp),e=>held(/native_collection_held/)(e)&&!String(e).includes('sensitive-native-provider-detail'))
})
let postgresProof=null
if(postgresMajor){
 assert.equal(process.versions.node.split('.')[0],'24','Guarded PG mode requires the bundled Node24 runtime')
 const {Pool}=require('pg'),runtime=createDisposablePostgresRuntime(),name='clawpilot-initial-operator-pg'+postgresMajor+'-'+process.pid+'-'+crypto.randomUUID().slice(0,8)
 let pool,started=false,active=0,privateRoot=null,privateOwner=null;const statements=[],migrationHashes={}
 try{
  const launch=disposablePostgresDockerArgs(['run','--rm','-d','--name',name,'--pull','never','-e','POSTGRES_PASSWORD=initial_operator_fixture',
   '-e','POSTGRES_DB=initial_operator_fixture','-p','127.0.0.1::5432','pgvector/pgvector:pg'+postgresMajor],{runtime})
  started=true;execFileSync('docker',launch,{stdio:'pipe',timeout:60000})
  const port=execFileSync('docker',['port',name,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/)?.[1];assert.ok(port)
  pool=new Pool({host:'127.0.0.1',port:Number(port),database:'initial_operator_fixture',user:'postgres',password:'initial_operator_fixture',ssl:false,max:3,statement_timeout:10000})
  const until=Date.now()+30000;for(;;){try{await pool.query('SELECT 1');break}catch(e){if(Date.now()>until)throw e;await new Promise(r=>setTimeout(r,100))}}
  const transaction=async fn=>{const client=await pool.connect();active++;const queries=[];statements.push(queries)
   try{await client.query('BEGIN');const value=await fn({query(sql,values=[]){queries.push(sql);return client.query(sql,values)}});await client.query('COMMIT');return value}
   catch(e){await client.query('ROLLBACK');throw e}finally{active--;client.release()}}
  const migrate=await pool.connect();try{for(const file of readdirSync('db/migrations').filter(n=>/^\d+_.+\.sql$/.test(n)).sort()){
   const path=resolve('db/migrations',file),bytes=readFileSync(path,'utf8');migrationHashes[path]=byteHash(bytes);await applyMigrationSqlForTest(migrate,file,bytes)}}finally{migrate.release()}
  const q=(sql,values=[])=>pool.query(sql,values)
  const users={owner:['admin','owner'],editor:['editor','member'],viewer:['viewer','member'],denied:['outsider','member'],trash:['trash-native','member'],'app-only':[null,'member']}
  for(const [user,[native,role]]of Object.entries(users))await q(`WITH ref AS(SELECT allocate_crm_reference('gu') AS code)
   INSERT INTO app_users(email,role,status,suitecrm_user_id,suitecrm_username,reference_code,crm_user_enabled)
   SELECT $1,$2,'active',$3,CASE WHEN $3::text IS NULL THEN NULL ELSE code END,code,$4 FROM ref`,[user+'@example.invalid',role,native,native!==null])
  await q(`INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by) VALUES($1,'Actual private operator fixture','root',$2,$2)`,[selection.rootWorkspaceId,selection.actorEmail])
  for(const user of Object.keys(users))await q(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
   VALUES($1,$2,$3,'active',$4,$5,$5)`,[user+'@example.invalid',selection.rootWorkspaceId,user==='owner'?'owner':'member',user==='owner'?{}:{viewCrm:user!=='denied'},selection.actorEmail])
  await q(`UPDATE app_user_organization_memberships SET status='disabled',trashed_at=now(),trashed_by=$1,pre_trash_status='active' WHERE user_email='trash@example.invalid'`,[selection.actorEmail])
  await q(`INSERT INTO crm_operator_accounts(id,root_workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)`,[selection.operatorAccountId,selection.rootWorkspaceId,selection.actorEmail])
  await q(`INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)`,[selection.operatorAccountId,selection.rootWorkspaceId,selection.actorEmail])
  for(const pid of pipelineIds){await q('INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,$2,$3,$4)',[pid,'Initial operator pipeline '+pid,selection.actorEmail,selection.rootWorkspaceId])
   for(const user of Object.keys(users).filter(v=>v!=='owner'))await q('INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role) VALUES($1,$2,$3)',[pid,user+'@example.invalid',user==='viewer'?'viewer':'editor'])}
  const unmanagedPipeline=id(98)
  await q('INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,$2,$3,$4)',
   [unmanagedPipeline,'Existing app-only personal pipeline','app-only@example.invalid',selection.rootWorkspaceId])
  for(let i=0;i<2;i++)await q(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,suitecrm_synced_at,reference_code,source_payload)
   VALUES($1,$2,$3,'Synthetic native source port counterpart',$4,$5,'Emails',now(),allocate_crm_reference('gi'),$6)`,
  [id(30+i),pipelineIds[i],'operator-real-sql-'+i,hash(['sql-source',i]),id(40+i),{archived:i===0}])
  const demoWorkspace='10000000-0000-4000-8000-000000000001',demoOwner='demo-system@clawpilot.example',demoPipeline=id(110)
  await q(`INSERT INTO workspace_organizations(id,name,organization_type,is_demo,created_by,updated_by) VALUES($1,'Synthetic demo excluded','root',true,$2,$2)`,[demoWorkspace,selection.actorEmail])
  await q('INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id,reference_access_disabled) VALUES($1,$2,$3,$4,true)',[id(91),'Demo pipeline',selection.actorEmail,demoWorkspace])
  for(let i=0;i<2;i++)await q(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,suitecrm_synced_at,reference_code,source_payload)
   VALUES($1,$2,$3,'Seeded demo only',$4,$5,'Emails',now(),allocate_crm_reference('gi'),$6)`,[id(92+i),id(91),'operator-demo-'+i,hash(['demo',i]),'demo-suitecrm-interaction-'+(i+1),{source:'demo',synthetic:true}])
  const demoJobs=[id(113),id(114)],demoMarker='Demo pipeline quarantined; immutable CRM identity evidence preserved'
  await q("INSERT INTO app_users(email,role,status,crm_user_enabled) VALUES($1,'member','active',false)",[demoOwner])
  await q('UPDATE app_users SET organization_id=$1 WHERE email=$2',[demoWorkspace,demoOwner])
  await q(`INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id,sync_enabled,reference_access_disabled)
   VALUES($1,'Disabled demo source',$2,$3,false,true)`,[demoPipeline,demoOwner,demoWorkspace])
  await q(`INSERT INTO crm_products(id,pipeline_id,source_key,name,source_hash,suitecrm_id,source_payload)
   VALUES($1,$2,'quickbooks:item:operator-quarantine','Retained synthetic product',$3,'demo-suitecrm-product-1',
   '{"provider":"quickbooks","synthetic":true}')`,[id(111),demoPipeline,hash('operator-quarantine-product')])
  await q(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,source_payload)
   VALUES($1,$2,'operator-quarantine-interaction','Retained synthetic email',$3,'demo-suitecrm-interaction-1','Emails',
   '{"source":"demo","synthetic":true}')`,[id(112),demoPipeline,hash('operator-quarantine-interaction')])
  for(const [index,entity,recordId,nativeId,operation]of [
   [0,'products',id(111),'demo-suitecrm-product-1','upsert_record'],
   [1,'interactions',id(112),'demo-suitecrm-interaction-1','reproject_record'],
  ])await q(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload,status,attempts,last_error,available_at,processed_at)
    VALUES($1,'suitecrm',$2,$3,$4,$5,'dead',$6,$7,'infinity',now())`,
   [demoJobs[index],'crm_'+entity,recordId,operation,{entity,pipelineId:demoPipeline,localId:recordId,suiteCrmId:nativeId,
    attributes:{name:'Synthetic retained quarantine'},...(entity==='interactions'?{suiteCrmModule:'Emails',previousSuiteCrmModule:'Notes'}:{})},index===0?1:4,demoMarker])
  const retainedDemoJobs=async()=>(await q('SELECT id::text,to_jsonb(s)::text AS retained FROM sync_outbox s WHERE id=ANY($1::uuid[]) ORDER BY id',[demoJobs])).rows
  const demoJobsBefore=await retainedDemoJobs()
  const Store=compiledBuild?.Store??load('app_src/lib/crm/nativeEmailInitialEnrollmentPostgres.ts').PostgresNativeEmailInitialEnrollmentStore
  const createIssuer=compiledBuild?.createIssuer??load('app_src/lib/crm/nativeEmailInitialEnrollmentApproval.ts').createNativeEmailInitialApprovalIssuer
  const ActualOperator=compiledBuild?.Operator??Operator
  const realStore=new Store(transaction,selection),preview=await realStore.preview();let cliKeys=null,compiledCliProof=null
  if(compiledBuild){
   privateRoot=realpathSync(mkdtempSync(join(tmpdir(),'clawpilot-initial-operator-private-pg.')))
   assert.equal(lstatSync(privateRoot).mode&0o777,0o700);privateOwner=crypto.randomUUID()
   writeFileSync(join(privateRoot,'owner.json'),JSON.stringify({owner:privateOwner,pid:process.pid})+'\n',{flag:'wx',mode:0o600})
   const artifacts=join(privateRoot,'artifacts');mkdirSync(artifacts,{mode:0o700})
   cliKeys=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
   const binary=realpathSync('/usr/bin/false'),publicKey=cliKeys.publicKey.export({type:'spki',format:'pem'})
   const config={version:1,purpose:'clawpilot-native-email-initial-private-operator',selection,
    native:{railwayBinary:binary,railwayBinarySha256:byteHash(readFileSync(binary)),projectId:id(101),environmentId:id(102),serviceId:id(103),
     nativeInstanceId:selection.nativeInstanceId,database:'synthetic_native_never_called',serviceUserId:'admin',oauthClientId:id(80),
     cliSourceHash:hash('synthetic-native-cli-not-called'),imagePackageHash:hash('synthetic-native-image-not-called')},
    databaseName:'initial_operator_fixture',artifactDirectory:artifacts,issuer:{keyId:'operator-real-sql-fixture',publicKey}}
   const configFile=(value,name)=>{const path=join(privateRoot,name),bytes=JSON.stringify(value)+'\n';writeFileSync(path,bytes,{flag:'wx',mode:0o600});return {path,pin:byteHash(bytes)}}
   const selected=configFile(config,'operator.json'),wrongActor=configFile({...config,selection:{...selection,actorEmail:'viewer@example.invalid'}},'wrong-actor.json')
   const url='postgresql://postgres:initial_operator_fixture@127.0.0.1:'+port+'/initial_operator_fixture'
   const invoke=(action,extra=[],selectedConfig=selected,success=true)=>{
    const args=['--conditions=react-server',compiledBuild.entry,'--action='+action,'--config='+selectedConfig.path,'--config-sha256='+selectedConfig.pin,...extra]
    const child=spawnSync(process.execPath,args,{encoding:'utf8',timeout:20000,maxBuffer:1048576,
     env:{PATH:process.env.PATH,HOME:process.env.HOME,DATABASE_URL:url}})
    assert.equal(child.error,undefined,'Owned compiled CLI process failed before a result')
    assert.equal(child.signal,null);assert.equal(child.status,success?0:1,'Compiled CLI status: '+child.stderr)
    assert.equal(success?child.stderr:child.stdout,'');return JSON.parse(success?child.stdout:child.stderr)
   }
   await check('REAL compiled private CLI authorizes preview/reserve against PG and preserves immutable approved reservation retries',async()=>{
    assert.deepEqual(invoke('preview'),{action:'preview',...preview})
    const reserveArgs=['--operation='+op,'--source-sha256='+preview.sourceFingerprint,'--approve-operation='+op]
    const reserved=invoke('reserve',reserveArgs);assert.equal(reserved.action,'reserve');assert.equal(reserved.operationId,op)
    assert.equal(reserved.state,'reserved');assert.equal(reserved.sourceFingerprint,preview.sourceFingerprint);assert.equal(reserved.generation,preview.generation)
    const row=(await q('SELECT * FROM crm_native_email_initial_reservations WHERE operation_id=$1',[op])).rows[0]
    assert.equal(row.actor_email,selection.actorEmail);assert.equal(row.operator_account_id,selection.operatorAccountId)
    assert.equal(row.root_workspace_id,selection.rootWorkspaceId);assert.equal(row.native_instance_id,selection.nativeInstanceId)
    assert.deepEqual(invoke('reserve',reserveArgs),reserved)
    assert.deepEqual((await q('SELECT * FROM crm_native_email_initial_reservations WHERE operation_id=$1',[op])).rows[0],row)
    assert.deepEqual(invoke('preview'),{action:'preview',...preview,activeOperationId:op})
   })
   await check('REAL compiled private CLI denies wrong root actor and source pins without changing PG reservation or enabling publication',async()=>{
    const before=(await q('SELECT * FROM crm_native_email_initial_reservations WHERE operation_id=$1',[op])).rows[0]
    assert.equal(invoke('preview',[],wrongActor,false).code,'initial_pg_operator_denied')
    const refused=invoke('reserve',['--operation='+op,'--source-sha256='+hash('wrong-reviewed-sql-source'),'--approve-operation='+op],selected,false)
    assert.equal(refused.code,'initial_pg_reservation_pin_changed')
    assert.deepEqual((await q('SELECT * FROM crm_native_email_initial_reservations WHERE operation_id=$1',[op])).rows[0],before)
    assert.equal((await q('SELECT enabled FROM crm_native_email_publication_control WHERE singleton')).rows[0].enabled,false)
   })
   compiledCliProof={actualPool:true,actualPrivateCliPreview:true,actualPrivateCliReservation:true,approvedRetryImmutable:true,
    wrongActorDenied:true,wrongSourcePinDenied:true,nativeCommandConfigured:'/usr/bin/false',nativeCommandExercised:false}
  }
  await realStore.reserve(op,preview.sourceFingerprint)
  const current=(await q('SELECT clawpilot_crm_native_initial_source_snapshot() AS snapshot')).rows[0].snapshot,f=fixture()
  f.state.snapshot=sqlCopy(current);f.state.nativeSource.emails=current.emails.map((m,i)=>({...m,recordFingerprint:hash(['actual-sql-synthetic-native-content',i]),capabilities:caps(principals,i===0?principals:['admin'])}))
  const actualPort=Object.fromEntries(Object.entries(f.port).map(([method,run])=>[method,async request=>{assert.equal(active,0,'Actual PG locks must be released before native port');return run(request)}]))
  const operator=new ActualOperator(transaction,selection,actualPort),input={operationId:op,appSourceFingerprint:preview.sourceFingerprint,sourceArtifactDigest:byteHash(json(f.state.nativeSource)+'\n'),preparedAt:'2026-11-03 19:00:00'}
  await check('REAL PG collector uses durable reserve, SQL JSONB equality/hash and excludes seeded demo mappings',async()=>{
   const source=await operator.collectReservedSource(op,preview.sourceFingerprint);assert.equal(source.mappings.length,2);assert.equal(source.appGeneration,preview.generation)
   assert.ok(current.memberships.some(m=>m.user_email===selection.actorEmail&&Object.keys(m.permissions).length===0),'Real source must contain the seeded legitimate empty membership permissions object')
   assert.deepEqual(source.mappings.map(m=>m.nativeId),[id(40),id(41)]);assert.ok(statements.every(queries=>queries[0].includes('crm_native_email_publication_control')&&queries[0].includes('FOR UPDATE')))
   assert.equal(current.pendingOutbox.length,2)
   const batches=statements.flat().filter(sql=>sql.includes('clawpilot_crm_native_initial_demo_quarantine('))
   assert.equal(batches.length,1,'Actual SQL collector independently verifies both retained demo rows in one batch')
   assert.deepEqual(await retainedDemoJobs(),demoJobsBefore)
   assert.ok(current.pipelines.some(p=>p.id===unmanagedPipeline),'Unmanaged app pipeline remains in immutable global source')
   assert.equal((await q('SELECT clawpilot_crm_native_unmanaged_pipeline_footprint($1::uuid) AS allowed',[unmanagedPipeline])).rows[0].allowed,true)
   assert.equal((await q('SELECT clawpilot_crm_native_unmanaged_pipeline_retained($1::uuid) AS allowed',[unmanagedPipeline])).rows[0].allowed,false,
    'A reservation/source-selection proof cannot authorize active app sharing')
  })
  let material
  await check('REAL PG operator derives all three future policies and existing issuer independently admits exact reviewed material',async()=>{
   await operator.captureSource(op,preview.sourceFingerprint);material=(await operator.prepareForReview(input)).material
   assert.equal(material.plan.pipelines.length,3);assert.equal(material.plan.emails[0].after.archived,true)
   assert.deepEqual(material.plan.emails[0].after.capabilities.edit,['admin','editor']);assert.deepEqual(material.plan.emails[1].after.capabilities.edit,['admin'])
   const keys=cliKeys??crypto.generateKeyPairSync('rsa',{modulusLength:3072}),publicKey=keys.publicKey.export({type:'spki',format:'pem'})
   const identity={keyId:'operator-real-sql-fixture',serviceUserId:'admin',oauthClientId:id(80)}
   const reviewedStore=new Store(transaction,selection,{expectedPlanHash:material.planHash,read:()=>operator.readReviewedMaterial(input,material.planHash)},{publicKey,...identity})
   const issuer=createIssuer(reviewedStore,{privateKey:keys.privateKey,nativeInstanceId:selection.nativeInstanceId,...identity})
   const approval=await issuer.issue(op,material.planHash);assert.equal(approval.proof.planHash,material.planHash)
   const row=(await q('SELECT state,plan_hash FROM crm_native_email_initial_enrollments WHERE operation_id=$1',[op])).rows[0]
   assert.equal(row.state,'admitted');assert.equal(row.plan_hash,material.planHash)
   const control=(await q('SELECT enabled,active_initial_enrollment_id FROM crm_native_email_publication_control WHERE singleton')).rows[0]
   assert.equal(control.enabled,false);assert.equal(control.active_initial_enrollment_id,op)
   assert.deepEqual(await retainedDemoJobs(),demoJobsBefore,'Actual issuer admission must preserve both terminal demo outbox receipts')
  })
  await check('REAL PG barrier blocks authority drift and independently denies wrong current operator selection',async()=>{
   await assert.rejects(q("UPDATE app_user_organization_memberships SET permissions='{}'::jsonb WHERE user_email='editor@example.invalid'"),e=>e.code==='55000')
   const wrong=new ActualOperator(transaction,{...selection,actorEmail:'viewer@example.invalid'},actualPort)
   await assert.rejects(wrong.collectReservedSource(op,preview.sourceFingerprint),held(/operator_denied/))
   assert.equal((await operator.collectReservedSource(op,preview.sourceFingerprint)).mappings.length,2)
  })
  for(const [path,sha]of Object.entries(migrationHashes))assert.equal(byteHash(readFileSync(path)),sha,'Migration changed during actual collector gate')
  verifyCompiledBuild()
  postgresProof={major:Number(postgresMajor),actualSqlCollector:true,actualAppReservation:true,actualIssuerAdmission:true,
   actualCompiledModuleExecution:!!compiledBuild,compiledCliProof,
   terminalDemoQuarantineRows:demoJobs.length,actualQuarantineBatchLookup:true,quarantineEvidenceUnchanged:isDeepStrictEqual(await retainedDemoJobs(),demoJobsBefore),
   nativeCollectorSynthetic:true,reviewApprovalSynthetic:true,nativeDispatch:false,activation:false,migrationSourcesFingerprint:migrationInventoryFingerprint(migrationHashes)}
 }finally{
  try{if(pool)await pool.end()}finally{
   try{if(started)assert.equal(runtime.cleanup(),true)}finally{
    if(privateRoot){assert.equal(JSON.parse(readFileSync(join(privateRoot,'owner.json'),'utf8')).owner,privateOwner)
     assert.equal(realpathSync(privateRoot),privateRoot);assert.match(privateRoot,/\/clawpilot-initial-operator-private-pg\.[A-Za-z0-9]+$/)
     rmSync(privateRoot,{recursive:true})}
   }
  }
 }
}
for(const [path,sha]of Object.entries(sourceHashes))assert.equal(crypto.createHash('sha256').update(readFileSync(path)).digest('hex'),sha,'Source changed during operator unit gate: '+path)
console.log(JSON.stringify({kind:'native-initial-operator-contract',checks,sourceHashes,realSqlDatabase:!!postgresProof,postgresProof,realNativeCollector:false,privateAdapterUnwired:true,production:false}))
