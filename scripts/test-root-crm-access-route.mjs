#!/usr/bin/env node
// Actual route, request parser, same-origin policy and Next Request/Response.
// Session and DAL are explicit mocks; actual DAL is covered by disposable PG.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript')
const next=require('next/server')
function load(path,deps){const module={exports:{}}
 new Function('module','exports','require',ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(
  module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]});return module.exports}
const contract=load('app_src/lib/crm/rootEmployeeCrmSettings.ts',{})
const publicOrigins=await import('../app_src/lib/publicOriginRouting.mjs')
const sameOrigin=load('app_src/lib/browserSameOrigin.ts',{'./publicOriginRouting.mjs':publicOrigins})
const owner='owner@example.invalid',workspace='00000000-0000-4000-8000-000000000001',hash='a'.repeat(64)
class NativeEmailAccessPendingError extends Error{status=409;code='CRM_NATIVE_EMAIL_ACCESS_PENDING';transitionId=hash}
let session,actor,reads,writes,readError,writeError
const route=load('app_src/app/api/crm/root-access/route.ts',{
 'next/server':next,'@/lib/requestUser':{requestSession:async()=>session,requireRequestUser:async()=>{if(!actor)throw Error('Unauthorized');return actor}},
 '@/lib/browserSameOrigin':sameOrigin,'@/lib/crm/rootEmployeeCrmSettings':contract,
 '@/lib/crm/nativeEmailAuthorityRuntime':{NativeEmailAccessPendingError},
 '@/lib/persistence/crmRootEmployeeSettings':{
  readRootEmployeeCrmSettings:async(...args)=>{reads.push(args);if(readError)throw readError;return{workspaceId:workspace,registryVersion:hash}},
  changeRootEmployeeCrmSettings:async(email,id,value)=>{const parsed=contract.parseRootCrmSettingsRequest(value);writes.push([email,id,parsed]);if(writeError)throw writeError},
 }})
const request=(body,{headers={},method=body===undefined?'GET':'POST'}={})=>new next.NextRequest('https://aiapp.bposupplychain.com/api/crm/root-access',{
 method,headers:{Origin:'https://aiapp.bposupplychain.com','Content-Type':'application/json',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})})
function reset(){session={authenticatedUser:owner,effectiveUser:owner,impersonating:false};actor={email:owner,organizationId:workspace};reads=[];writes=[];readError=null;writeError=null}
let groups=0
async function check(name,fn){reset();await fn();groups++;console.log('PASS '+name)}
const configure={action:'configure',enabled:true,workspaceIds:[workspace],registryVersion:hash}
await check('fresh session organization, no-store and safe minimal response are enforced for every request',async()=>{
 const response=await route.GET(request());assert.equal(response.status,200);assert.deepEqual(reads,[[owner,workspace]])
 assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('x-content-type-options'),'nosniff')
 const result=await route.POST(request(configure));assert.equal(result.status,200)
 assert.deepEqual(writes,[[owner,workspace,configure]]);assert.equal(reads.length,2)
})
await check('unauthenticated, impersonated and organization-less requests cannot reach the DAL',async()=>{
 actor=null;assert.equal((await route.GET(request())).status,401)
 actor={email:owner,organizationId:workspace};session.impersonating=true
 assert.equal((await route.POST(request(configure))).status,403)
 session={authenticatedUser:'admin@example.invalid',effectiveUser:owner};assert.equal((await route.GET(request())).status,403)
 session={authenticatedUser:owner,effectiveUser:owner};actor.organizationId=null
 assert.equal((await route.GET(request())).status,403);assert.deepEqual(reads,[]);assert.deepEqual(writes,[])
})
await check('cross-origin and malformed or oversized bodies fail before any write',async()=>{
 for(const headers of [{Origin:'https://attacker.invalid'},{'Sec-Fetch-Site':'cross-site'}])
  assert.equal((await route.POST(request(configure,{headers}))).status,403)
 for(const [body,headers,status]of [['not JSON',{},400],['{}',{'Content-Type':'text/plain'},415],['{}',{'Content-Length':'9000'},413],[' '.repeat(8193),{},413]])
  assert.equal((await route.POST(request(body,{headers}))).status,status)
 assert.deepEqual(writes,[]);assert.deepEqual(reads,[])
})
await check('strict browser contract rejects authority rows, actor/default workspace hints and malformed choices',async()=>{
 const bad=[null,[],{}, {...configure,workspaceId:workspace},{...configure,actorEmail:owner},{...configure,operatorAccountId:workspace},
  {...configure,changes:[]},{...configure,enabled:'true'},{...configure,registryVersion:'a'.repeat(63)},
  {...configure,workspaceIds:[]},{...configure,workspaceIds:[workspace,workspace]},{...configure,workspaceIds:[workspace.toUpperCase()]},
  {action:'employee',userEmail:'Upper@example.invalid',enabled:true,registryVersion:hash},
  {action:'resume',transitionId:hash,enabled:true},{action:'resume',transitionId:'bad'}]
 // This numeric fixture UUID has no letters, so use an uppercase alphabetic UUID explicitly.
 bad[11]={...configure,workspaceIds:['AAAAAAAA-0000-4000-8000-000000000001']}
 for(const value of bad)assert.throws(()=>contract.parseRootCrmSettingsRequest(value),error=>error instanceof contract.RootCrmSettingsError)
 assert.deepEqual(contract.parseRootCrmSettingsRequest({action:'resume',transitionId:hash}),{action:'resume',transitionId:hash})
 assert.deepEqual(writes,[])
})
await check('stale and pending results remain failures; private SQL/provider errors are never serialized',async()=>{
 writeError=new contract.RootCrmSettingsError('Reload settings.',409,'ROOT_CRM_SETTINGS_STALE')
 let response=await route.POST(request(configure));assert.equal(response.status,409);assert.equal(reads.length,0)
 writeError=new NativeEmailAccessPendingError('Saved access change pending.')
 response=await route.POST(request(configure));assert.equal(response.status,409);assert.equal((await response.json()).transitionId,hash)
 writeError=new Error('private provider token and SQL details')
 response=await route.POST(request(configure));assert.equal(response.status,500);assert.ok(!JSON.stringify(await response.json()).includes('private provider'))
 readError=new contract.RootCrmSettingsError('Owner only.',403);assert.equal((await route.GET(request())).status,403)
})
console.log(`PASS ${groups} actual route/strict-input groups; mocked session/DAL, no database/native/browser/production proof`)
