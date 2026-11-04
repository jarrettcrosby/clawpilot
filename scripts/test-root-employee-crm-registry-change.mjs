#!/usr/bin/env node
// Pure proposed-source contract only; no SQL/native admission or authorization.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import * as crypto from 'node:crypto'
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript')
function load(path,deps){const module={exports:{}};new Function('module','exports','require',ts.transpileModule(
 readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(
 module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]});return module.exports}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const {prepareRootEmployeeCrmRegistryChange:prepare}=load('app_src/lib/crm/rootEmployeeCrmRegistryChange.ts',{'./nativeEmailPublication':protocol})
const json=protocol.nativeEmailCanonicalJson,id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const account={id:id(1),root_workspace_id:id(2),owner_email:'owner@example.test',enabled:true,revision:'1'}
const binding={operator_account_id:id(1),workspace_id:id(3),owner_email:account.owner_email,enabled:true,revision:'1'}
const grant={id:id(4),operator_account_id:id(1),user_email:'employee@example.test',source_workspace_id:id(2),enabled:true,revision:'1'}
const change={kind:'root_registry_v1',workspaceId:id(2),operatorAccountId:id(1),ownerEmail:account.owner_email,
 actorScope:{workspaceId:id(2),ancestryJson:json([{id:id(2),parent_id:null,is_demo:false}])},contextFingerprint:'a'.repeat(64),
 changes:[['account',account],['binding',binding],['grant',grant]].map(([table,row])=>({table,beforeJson:null,afterJson:json(row)}))}
const copy=value=>JSON.parse(JSON.stringify(value));let checks=0
function accepted(value){assert.deepEqual(prepare(value),value);checks++}
function denied(mutate){const value=copy(change);mutate(value);assert.throws(()=>prepare(value));checks++}
accepted(change)
const update=copy(change);update.changes=update.changes.map(c=>({table:c.table,beforeJson:c.afterJson,
 afterJson:json({...JSON.parse(c.afterJson),enabled:false,revision:'2'})}));accepted(update)
for(const key of ['id','root_workspace_id','owner_email']){const value=copy(update);const row=JSON.parse(value.changes[0].afterJson);
 row[key]=key==='owner_email'?'other@example.test':id(99);value.changes[0].afterJson=json(row);assert.throws(()=>prepare(value));checks++}
for(const mutate of [v=>{v.extra=true},v=>{v.workspaceId=id(99)},v=>{v.ownerEmail='Owner@example.test'},
 v=>{v.contextFingerprint='untrusted'},v=>{v.actorScope.workspaceId=id(3)},
 v=>{v.actorScope.ancestryJson=json([{id:id(2),parent_id:id(3),is_demo:false}])},
 v=>{v.actorScope.ancestryJson=json([{id:id(2),parent_id:null,is_demo:true}])},
 v=>{v.changes=[]},v=>{v.changes.reverse()},v=>{v.changes.push(copy(v.changes[2]))},
 v=>{v.changes[0].table='app_users'},v=>{v.changes[0].afterJson=null},v=>{v.changes[0].afterJson=JSON.stringify(account)},
 v=>{v.changes[1].afterJson=json({...binding,operator_account_id:id(99)})},
 v=>{v.changes[1].afterJson=json({...binding,owner_email:'other@example.test'})},
 v=>{v.changes[2].afterJson=json({...grant,source_workspace_id:id(3)})},
 v=>{v.changes[2].afterJson=json({...grant,user_email:account.owner_email})},
 v=>{v.changes[2].afterJson=json({...grant,enabled:'true'})},
 v=>{v.changes[2].afterJson=json({...grant,revision:'01'})},
 v=>{v.changes[2].afterJson=json({...grant,revision:'9007199254740992'})},
 v=>{v.changes[2].afterJson=json({...grant,revision:'2'})},
 v=>{v.changes[2].afterJson=json({...grant,default_workspace:id(99)})},
 v=>{v.changes.push({table:'grant',beforeJson:null,afterJson:json({...grant,id:id(5)})})},
])denied(mutate)
for(const mutate of [v=>{v.changes[2].afterJson=json({...grant,revision:'2'})},
 v=>{v.changes[2].afterJson=json({...grant,enabled:false,revision:'3'})},
 v=>{v.changes[2].afterJson=json({...grant,enabled:false,revision:'2',source_workspace_id:id(3)})}]){
 const value=copy(update);mutate(value);assert.throws(()=>prepare(value));checks++}
const frozen=prepare(change);assert.ok(Object.isFrozen(frozen)&&Object.isFrozen(frozen.changes)&&Object.isFrozen(frozen.changes[0])&&Object.isFrozen(frozen.actorScope));checks++
const mutable=copy(change),prepared=prepare(mutable);mutable.changes[0].afterJson='{}';assert.equal(prepared.changes[0].afterJson,change.changes[0].afterJson);checks++
console.log(`PASS ${checks} exact root registry source-contract checks; no authorization, SQL/native write or access granted`)
