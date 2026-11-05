#!/usr/bin/env node
// Actual parser/runtime/production error class; mocked SQL/provider boundaries.
// This does not prove PostgreSQL authorization, native execution or UI wiring.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as crypto from 'node:crypto'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript')
const read=path=>readFileSync(path,'utf8')
function compile(source,deps){const module={exports:{}};new Function('module','exports','require',ts.transpileModule(source,
 {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(module,module.exports,
 name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]});return module.exports}
const load=(path,deps)=>compile(read(path),deps)
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const contract=load('app_src/lib/crm/rootEmployeeCrmRegistryChange.ts',{'./nativeEmailPublication':protocol})
const lock=load('app_src/lib/persistence/crmNativeEmailAuthority.ts',{})
const ast=ts.createSourceFile('runtime.ts',read('app_src/lib/crm/nativeEmailAuthorityRuntime.ts'),ts.ScriptTarget.Latest,true)
const errorNode=ast.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='NativeEmailAccessPendingError');assert.ok(errorNode)
const {NativeEmailAccessPendingError}=compile(errorNode.getText(ast),{})
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,owner='owner@example.test'
const json=protocol.nativeEmailCanonicalJson,request={kind:'root_registry_v1',workspaceId:id(2),operatorAccountId:id(1),ownerEmail:owner,
 actorScope:{workspaceId:id(2),ancestryJson:json([{id:id(2),parent_id:null,is_demo:false}])},contextFingerprint:'a'.repeat(64),
 changes:[{table:'account',beforeJson:null,afterJson:json({id:id(1),root_workspace_id:id(2),owner_email:owner,enabled:true,revision:'1'})}]}
let enabled=false,authorized=true,missingControl=false,queries=[],providerCalls=0,stores=0,metadata=[],metadataQueries=[]
const client={async query(sql,args){assert.match(sql.trim(),/^SELECT\b/u);queries.push({sql,args})
 if(sql.includes('SELECT singleton'))return {rows:[{singleton:true}]}
 if(sql.includes('SELECT * FROM crm_native_email_publication_control'))return {rows:missingControl?[]:[{enabled,active_operation_id:null,active_transition_id:null}]}
 assert.ok(sql.includes('SELECT u.email')&&sql.includes("m.role='owner'")&&sql.includes('a.root_workspace_id=w.id'))
 assert.deepEqual(args,[owner,id(2),id(1)]);return {rows:authorized?[{email:owner}]:[]}
}}
const unavailable=()=>{throw Error('Unexpected mutation/phase execution')}
const runtime=load('app_src/lib/crm/nativeEmailRootRegistryRuntime.ts',{
 'node:crypto':crypto,'../persistence/postgres':{withTransaction:async run=>run(client),query:async(sql,args)=>{
  metadataQueries.push({sql,args});assert.match(sql,/m\.role='owner'/u);assert.match(sql,/workspaceId' =\$2::text|workspaceId'=\$2::text/u);return {rows:metadata}}},
 '../persistence/crmNativeEmailAuthority':lock,'../auditWriter':{recordAuditEvent:unavailable},
 './nativeEmailPublication':protocol,'./rootEmployeeCrmRegistryChange':contract,
 './nativeEmailAuthorityTransitionPostgres':{PostgresNativeEmailAuthorityTransitionStore:class{constructor(){stores++;unavailable()}}},
 './nativeEmailAuthorityTransport':{createSuiteCrmNativeEmailAuthorityClient:unavailable},
 './nativeEmailAuthorityPlan':{buildNativeEmailMemberTransition:unavailable,readNativeEmailAuthorityInspection:unavailable},
 './nativeEmailAuthorityRuntime':{NativeEmailAccessPendingError,nativeEmailAuthorityConfiguration:()=>{providerCalls++;throw Error('Private configuration detail must not leak')},
  resumeNativeEmailAuthorityChange:unavailable},'./nativeEmailAuthorityTransition':{prepareNativeEmailAuthorityTransition:unavailable},
})
let groups=0
function reset(){enabled=false;authorized=true;missingControl=false;queries=[];providerCalls=0;stores=0;metadata=[];metadataQueries=[]}
async function check(name,run){reset();await run();groups++;console.log('PASS '+name)}
const held=error=>error instanceof NativeEmailAccessPendingError&&error.status===409&&error.transitionId===null
 &&!error.message.includes('Private')&&!error.message.includes('SELECT')
await check('disabled policy authorizes the actual immutable owner before returning the legacy sentinel without any provider or write',async()=>{
 assert.equal(await runtime.changeRootEmployeeCrmRegistryWithNativeAuthority(owner,id(2),request),false)
 assert.equal(queries.length,3);assert.equal(providerCalls,0);assert.equal(stores,0)
})
await check('nonowner denial occurs before provider configuration in enabled and disabled modes',async()=>{
 authorized=false
 for(const mode of [false,true]){enabled=mode;await assert.rejects(runtime.changeRootEmployeeCrmRegistryWithNativeAuthority(owner,id(2),request),held)}
 assert.equal(providerCalls,0);assert.equal(stores,0);assert.equal(queries.length,6)
})
await check('forged actor source, extra proposal fields, malformed root and invalid Resume IDs cannot reach SQL or provider',async()=>{
 for(const [email,workspace,value,tid]of [['other@example.test',id(2),request,undefined],[owner,id(3),request,undefined],
  [owner,'bad',request,undefined],[owner,id(2),{...request,defaultWorkspace:id(3)},undefined],[owner,id(2),request,'bad']])
  await assert.rejects(runtime.changeRootEmployeeCrmRegistryWithNativeAuthority(email,workspace,value,tid),held)
 assert.equal(queries.length,0);assert.equal(providerCalls,0);assert.equal(stores,0)
})
await check('missing control or disabled-policy Resume is held, never treated as a successful registry mutation',async()=>{
 missingControl=true;await assert.rejects(runtime.changeRootEmployeeCrmRegistryWithNativeAuthority(owner,id(2),request),held)
 missingControl=false;await assert.rejects(runtime.changeRootEmployeeCrmRegistryWithNativeAuthority(owner,id(2),request,'b'.repeat(64)),held)
 assert.equal(providerCalls,0);assert.equal(stores,0)
})
await check('enabled configuration failure remains held and never leaks private details or falls through to legacy SQL',async()=>{
 enabled=true;await assert.rejects(runtime.changeRootEmployeeCrmRegistryWithNativeAuthority(owner,id(2),request),held)
 assert.equal(providerCalls,1);assert.equal(stores,0);assert.equal(queries.length,3)
})
await check('absent owner-scoped pending work is one read and reveals no ID, plan or provider state',async()=>{
 assert.equal(await runtime.getPendingRootEmployeeCrmRegistryChange(owner,id(2)),null)
 assert.equal(metadataQueries.length,1);assert.deepEqual(metadataQueries[0].args,[owner,id(2),null])
 assert.equal(queries.length,0);assert.equal(providerCalls,0)
})
await check('unowned saved Resume is held after a bounded read, not recreated from request data',async()=>{
 await assert.rejects(runtime.resumeRootEmployeeCrmRegistryChange(owner,id(2),'b'.repeat(64)),held)
 assert.equal(metadataQueries.length,1);assert.deepEqual(metadataQueries[0].args,[owner,id(2),'b'.repeat(64)])
 assert.equal(queries.length,0);assert.equal(providerCalls,0)
})
console.log(`PASS ${groups} root registry early-authorization/recovery groups; mocked boundaries, no PG/native/UI/production proof`)
