#!/usr/bin/env node
// Actual TS/PHP wire validators and pure native metadata comparison. No SQL,
// native permission execution, identity mutation, browser or production proof.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as crypto from 'node:crypto'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),ts=createRequire(resolve(root,'app_src/package.json'))('typescript'),cache=new Map()
function load(path){if(cache.has(path))return cache.get(path).exports
 const module={exports:{}};cache.set(path,module)
 new Function('require','module','exports',ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(
  name=>name==='node:crypto'?crypto:load(resolve(dirname(path),name+'.ts')),module,module.exports)
 return module.exports}
const wire=load(resolve(root,'app_src/lib/crm/nativeEmailAuthorityTransition.ts'))
const protocol=load(resolve(root,'app_src/lib/crm/nativeEmailPublication.ts'))
const fixture=JSON.parse(execFileSync(process.execPath,['scripts/test-native-email-authority-runtime.mjs','--emit-role-fixture'],{cwd:root,encoding:'utf8'}))
const copy=x=>JSON.parse(JSON.stringify(x)),base=copy(fixture.promotion.revoke);delete base.roleChanges
const principals=JSON.parse(base.bindings.find(b=>b.before.capability_policy_json!==null).before.capability_policy_json).principalSuiteCrmUserIds
assert.ok(principals.length>=2)
const links=principals.slice(0,2).map((userId,index)=>({userId,globalId:`gu123456${7+index}`,username:`gu123456${7+index}`}))
const command={...base,identityLinks:[links[0]]},commands=[]
const add=(label,value,accepted)=>commands.push({label,value,accepted})
add('one canonical existing identity',command,true)
add('two sorted distinct identities',{...base,identityLinks:links},true)
add('alphanumeric identity',{...base,identityLinks:[{...links[0],globalId:'gu0123456789av',username:'gu0123456789av'}]},true)
for(const [label,change]of[
 ['empty identity list',c=>{c.identityLinks=[]}],['null identities',c=>{c.identityLinks=null}],
 ['unknown key',c=>{c.identityLinks[0].create=true}],['unknown principal',c=>{c.identityLinks[0].userId='unknown-native'}],
 ['wrong prefix',c=>{c.identityLinks[0].globalId='ga1234567'}],['wrong username',c=>{c.identityLinks[0].username='other'}],
 ['uppercase reference',c=>{c.identityLinks[0].globalId='GU1234567';c.identityLinks[0].username='GU1234567'}],
 ['duplicate target',c=>{c.identityLinks.push(copy(c.identityLinks[0]))}],
 ['duplicate permanent reference',c=>{c.identityLinks=links.map(link=>({...link,globalId:links[0].globalId,username:links[0].globalId}))}],
 ['unordered identities',c=>{c.identityLinks=copy(links).reverse()}],
 ['mixed retained role and identity request',c=>{c.roleChanges=copy(fixture.promotion.revoke.roleChanges)}],
]){const value=copy(command);change(value);add(label,value,false)}
const expectedCommands=commands.map(({label,value,accepted})=>{
 let result;try{result={accepted:true,hash:wire.prepareNativeEmailAuthorityCommand(value).commandHash}}catch{result={accepted:false}}
 assert.equal(result.accepted,accepted,label);return result
})
const desired={kind:'synthetic-identity-contract',userEmail:'user@example.test'},revoke={...copy(command),desiredAppChangeHash:protocol.nativeEmailDigest(desired)}
const grant={...copy(revoke),phase:'grant',operationId:protocol.nativeEmailDigest('identity-contract-grant'),
 generationFrom:revoke.generationTo,generationTo:revoke.generationTo+1,
 beforePolicyFingerprint:revoke.afterPolicyFingerprint,afterPolicyFingerprint:revoke.afterPolicyFingerprint,
 bindings:revoke.bindings.map(pair=>({before:copy(pair.after),after:{...copy(pair.after),generation:String(revoke.generationTo+1)}})),
 capabilities:revoke.capabilities.map(c=>({...c,before:copy(c.after),after:copy(c.after)})),membershipChanges:[]}
grant.beforeBindingsFingerprint=protocol.nativeEmailDigest(grant.bindings.map(p=>p.before));grant.afterBindingsFingerprint=protocol.nativeEmailDigest(grant.bindings.map(p=>p.after))
const plan={version:1,desiredAppChange:desired,expectedAppAuthorityBeforeFingerprint:protocol.nativeEmailDigest('before'),
 expectedAppAuthorityAfterFingerprint:protocol.nativeEmailDigest('after'),revoke,grant}
assert.ok(wire.prepareNativeEmailAuthorityTransition(plan).planHash)
const changed=copy(plan);changed.grant.identityLinks[0]={...links[0],globalId:'gu9999999',username:'gu9999999'}
assert.throws(()=>wire.prepareNativeEmailAuthorityTransition(changed),e=>e.code==='authority_transition_chain')
console.log('PASS identity proof stays identical across revoke and grant; changed proof cannot enter a signed chain')
const row=link=>({id:link.userId,user_name:link.username,status:'Active',deleted:'0'})
const custom=link=>({id_c:link.userId,global_id_c:link.globalId})
const valid={links:copy(links),users:links.map(row),custom:links.map(custom)},metadata=[]
metadata.push({label:'two complete matching native accounts',value:valid,accepted:true})
const unrelatedId='zz-unrelated',unrelated={id:unrelatedId,user_name:'ordinary-user',status:'Inactive',deleted:'1'}
metadata.push({label:'unrelated retained native user is preserved',value:{...copy(valid),users:[...valid.users,unrelated],
 custom:[...valid.custom,{id_c:unrelatedId,global_id_c:null}]},accepted:true})
for(const [label,change]of[
 ['missing native user',c=>{c.users.pop()}],['missing custom identity',c=>{c.custom.pop()}],
 ['wrong active account',c=>{c.users[0].status='Inactive'}],['deleted account',c=>{c.users[0].deleted='1'}],
 ['wrong native username',c=>{c.users[0].user_name='other'}],['wrong native Global ID',c=>{c.custom[0].global_id_c='gu9999999'}],
 ['duplicate custom claim',c=>{c.custom.push({id_c:unrelatedId,global_id_c:links[0].globalId})}],
 ['case folded custom duplicate',c=>{c.custom.push({id_c:unrelatedId,global_id_c:links[0].globalId.toUpperCase()})}],
 ['case folded username duplicate',c=>{c.users.push({...unrelated,user_name:links[0].username.toUpperCase()})}],
 ['noncanonical selected custom identity',c=>{c.custom[0].global_id_c=links[0].globalId.toUpperCase()}],
 ['unknown metadata field',c=>{c.users[0].is_admin=true}],['duplicate custom row',c=>{c.custom.push(copy(c.custom[0]))}],
 ['unordered native users',c=>{c.users.reverse()}],['unordered native custom rows',c=>{c.custom.reverse()}],
 ['malformed reference',c=>{c.links[0].globalId='gu123';c.links[0].username='gu123'}],
]){const value=copy(valid);change(value);metadata.push({label,value,accepted:false})}
const actual=JSON.parse(execFileSync('docker',['run','--rm','-i','--pull=never','--network','none','--read-only',
 '--memory=256m','--cpus=1','--pids-limit=64','--mount',`type=bind,source=${resolve(root,'services/suitecrm/email-audience')},target=/source,readonly`,
 '--mount',`type=bind,source=${resolve(root,'scripts/fixtures/native-email-identity-link-contract.php')},target=/fixture.php,readonly`,
 '--entrypoint','php','php:8.3.35-cli-alpine','/fixture.php'],{cwd:root,encoding:'utf8',input:JSON.stringify({commands:commands.map(c=>c.value),metadata:metadata.map(c=>c.value)}),timeout:30000}))
assert.deepEqual(actual.commands,expectedCommands,'Actual TS and PHP identity command acceptance/hashes must match')
assert.deepEqual(actual.metadata,metadata.map(c=>c.accepted),metadata.map(c=>c.label).join('; '))
console.log(`PASS ${commands.length} actual TS/PHP identity wire cases and ${metadata.length} pure native metadata cases; no SQL/native grant/production proof`)
