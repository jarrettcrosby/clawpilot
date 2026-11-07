#!/usr/bin/env node
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as util from 'node:util'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import test from 'node:test'

const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
function load(name,deps){
  const input=readFileSync(new URL(`../app_src/lib/crm/${name}.ts`,import.meta.url),'utf8')
  const {outputText}=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}})
  const module={exports:{}}
  new Function('module','exports','require',outputText)(module,module.exports,key=>{
    assert.ok(Object.hasOwn(deps,key),`Unexpected dependency ${key}`)
    return deps[key]
  })
  return module.exports
}
const protocol=load('nativeEmailPublication',{'node:crypto':crypto})
const stores=load('nativeEmailRecoveryStoreBinding',{'server-only':{},'node:util':util,'./nativeEmailPublication':protocol})
const {observeNativeEmailRecoveryMariaFence:observe}=load('nativeEmailRecoveryMariaFence',
  {'server-only':{},'./nativeEmailPublication':protocol,'./nativeEmailRecoveryStoreBinding':stores})
const start='2026-11-07T01:10:20.123456Z', end='2026-11-07T01:10:20.234567Z'
const target={database:'crm_fixture',hostname:'native-fixture',serverId:'512',serverVersion:'11.4.13-MariaDB-ubu2404',
  serverUid:Buffer.alloc(20,1).toString('base64'),
  observer:{user:'fence_observer',host:'localhost'},ordinaryWriterAccounts:[{user:'writer',host:'%'},
    {user:'app',host:'10.25.%'},{user:'app',host:'localhost'}]}
const identity=(at)=>({database_name:target.database,hostname:target.hostname,server_id:target.serverId,
  server_version:target.serverVersion,server_uid:target.serverUid,
  current_user:'fence_observer@localhost',session_login_user:'fence_observer',connection_id:'812',
  current_role:null,autocommit:'ON',in_transaction:'0',event_scheduler:'OFF',wsrep_on:'OFF',wsrep_provider:'none',observed_at:at})
const drain=()=>({observer_connection_id:'812',connection_id:'812',process_user:'fence_observer',database_name:target.database,command_name:'Query'})
const plan=()=>[[identity(start)],[{connection_id:'812',direct_process_grants:'1'}],target.ordinaryWriterAccounts.map(a=>({
  connection_id:'812',account_user:a.user,account_host:a.host,account_locked:'1'})),[drain()],[],[],[drain()],[identity(end)]]
const names=['identity','process_privilege','account_locks','clients','xa','replication','clients','identity']
function connected(change=()=>{},failAt=-1){
  const queries=[], result=plan()
  change(result)
  return {queries,client:{query:async(sql,parameters)=>{
    const idx=queries.length
    queries.push([sql,parameters])
    const name=names[idx]
    assert.ok(name,'unexpected observer command')
    assert.match(sql,/^(?:SELECT |XA RECOVER$|SHOW ALL SLAVES STATUS$)/u)
    assert.doesNotMatch(sql,/\b(?:ALTER|UPDATE|INSERT|DELETE|CREATE|DROP|LOCK TABLES|SET ROLE|KILL)\b/u)
    if(name==='identity'){
      assert.match(sql,/@@GLOBAL\.server_uid AS server_uid/u)
      assert.match(sql,/CURRENT_USER\(\).*SESSION_USER\(\)/s)
      assert.match(sql,/@@GLOBAL\.event_scheduler.*@@GLOBAL\.wsrep_on.*@@GLOBAL\.wsrep_provider/s)
    }
    if(name==='process_privilege'){
      assert.match(sql,/FROM information_schema\.USER_PRIVILEGES WHERE BINARY GRANTEE=BINARY \? AND PRIVILEGE_TYPE='PROCESS'/u)
      assert.deepEqual(parameters,["'fence_observer'@'localhost'"])
    }
    if(name==='account_locks'){
      assert.match(sql,/JSON_TYPE\(JSON_EXTRACT\(Priv,'\$\.account_locked'\)\)='BOOLEAN'/u)
      assert.match(sql,/FROM mysql\.global_priv WHERE BINARY User IN \(\?,\?\) LIMIT 25/u)
      assert.doesNotMatch(sql,/SELECT\s+\*|authentication_string|SELECT\s+Priv\b|JSON_DETAILED/iu)
      assert.deepEqual(parameters,['app','writer'])
    }
    if(name==='clients'){
      assert.match(sql,/information_schema\.PROCESSLIST LIMIT 2/u)
      assert.doesNotMatch(sql,/\bINFO\b|WHERE|\bHOST\b/u)
    }
    if(idx===failAt)throw Error('private fixture credentials and server detail')
    return {rows:result[idx]}
  }}}
}
const held=code=>error=>error instanceof protocol.NativeEmailPublicationHeld&&error.code===`legacy_dispatch_maria_fence_${code}`

test('only reads exact server metadata, then returns a redacted, bounded observation',async()=>{
  const {client,queries}=connected()
  const proof=await observe(client,target)
  assert.ok(Object.isFrozen(proof))
  assert.deepEqual(proof,{version:1,observationStartedAt:start,observedAt:end,
    storeFingerprint:protocol.nativeEmailDigest({version:1,purpose:'clawpilot-native-email-custody-maria-store-v1',
      database:target.database,hostname:target.hostname,serverId:target.serverId,serverVersion:target.serverVersion,serverUid:target.serverUid}),
    targetFingerprint:protocol.nativeEmailDigest({...target,ordinaryWriterAccounts:[target.ordinaryWriterAccounts[1],
      target.ordinaryWriterAccounts[2],target.ordinaryWriterAccounts[0]]}),closedOrdinaryAccounts:3,otherClients:0,
    preparedTransactions:0,inboundReplicationChannels:0,eventSchedulerOff:true,wsrepDisabled:true})
  assert.doesNotMatch(JSON.stringify(proof),/fence_observer|localhost|native-fixture|crm_fixture|11\.4\.13|812|10\.25\./u)
  assert.ok(!JSON.stringify(proof).includes(target.serverUid))
  assert.equal(queries.length,8)
})

test('fails on target, direct observer, connection, or timestamp drift before or after the reads',async()=>{
  for(const idx of [0,7]){
    for(const [field,value] of Object.entries({database_name:'other',hostname:'other',server_id:'513',
      server_version:'11.4.14-MariaDB-ubu2404',server_uid:Buffer.alloc(20,2).toString('base64'),
      current_user:'fence_observer@%',session_login_user:'proxied_observer',connection_id:'0'}))
      await assert.rejects(observe(connected(r=>r[idx][0][field]=value).client,target),held('identity_unproven'))
    for(const server_uid of [undefined,null,'unknown','A'.repeat(26)+'B='])
      await assert.rejects(observe(connected(r=>r[idx][0].server_uid=server_uid).client,target),held('identity_unproven'))
    for(const [field,value] of Object.entries({current_role:'routed-role',autocommit:'OFF',in_transaction:'1'}))
      await assert.rejects(observe(connected(r=>r[idx][0][field]=value).client,target),held('observer_session_unproven'))
    for(const observed_at of ['2026-02-31T01:10:20.123456Z',null,start+'\n'])
      await assert.rejects(observe(connected(r=>r[idx][0].observed_at=observed_at).client,target),held('observation_clock_unproven'))
  }
  await assert.rejects(observe(connected(r=>r[7][0].connection_id='999').client,target),held('connection_changed'))
  await assert.rejects(observe(connected(r=>r[7][0].observed_at='2026-11-07T01:10:20.123455Z').client,target),held('observation_clock_unproven'))
})

test('refuses a missing direct PROCESS grant or malformed grant response',async()=>{
  for(const mutate of [r=>r[1][0].direct_process_grants='0',r=>r[1][0].direct_process_grants=1,r=>r[1][0].connection_id='813'])
    await assert.rejects(observe(connected(mutate).client,target),held('process_visibility_unproven'))
  await assert.rejects(observe(connected(r=>r[1]=[]).client,target),held('observation_shape'))
})

test('requires every expected ordinary account locked and rejects unknown host variants, even locked ones',async()=>{
  const drifts=[r=>r[2][1].account_locked='0',r=>r[2][1].account_locked=true,r=>r[2].pop(),
    r=>r[2].push({...r[2][1],account_host:'new-host'}),r=>r[2][1].account_host='another',r=>r[2][1]=r[2][2],
    r=>r[2][1].connection_id='999',r=>r[2][1].account_user='other']
  for(const mutate of drifts)await assert.rejects(observe(connected(mutate).client,target),held('account_locks_unproven'))
})

test('refuses all additional clients and unverified process visibility at either drain sample',async()=>{
  for(const idx of [3,6]){
    const drifts=[r=>r[idx].push({...drain(),process_user:'other',connection_id:'813',database_name:'other_db'}),
      r=>r[idx]=[],r=>r[idx][0].command_name='Sleep',r=>r[idx][0].command_name={toString:()=> 'Query'},
      r=>r[idx][0].observer_connection_id='813',r=>r[idx][0].connection_id='813',r=>r[idx][0].process_user='unknown',r=>r[idx][0].database_name=null]
    for(const mutate of drifts)await assert.rejects(observe(connected(mutate).client,target),held('client_drain_unproven'))
  }
})

test('holds for events, wsrep, prepared transactions, and any inbound channel',async()=>{
  for(const idx of [0,7]){
    for(const [field,value] of Object.entries({event_scheduler:'ON',wsrep_on:'ON',wsrep_provider:'galera'}))
      await assert.rejects(observe(connected(r=>r[idx][0][field]=value).client,target),held('background_writers_unproven'))
    await assert.rejects(observe(connected(r=>delete r[idx][0].wsrep_provider).client,target),held('background_writers_unproven'))
  }
  for(const [idx,code] of [[4,'prepared_transactions_present'],[5,'inbound_replication_present']]){
    await assert.rejects(observe(connected(r=>r[idx]=[{data:'private fixture identity'}]).client,target),error=>
      held(code)(error)&&!error.message.includes('private fixture identity'))
    await assert.rejects(observe(connected(r=>r[idx]=null).client,target),held('observation_shape'))
  }
})

test('read failures are sanitized and never converted into proof of absence',async()=>{
  for(let idx=0;idx<8;idx++)await assert.rejects(observe(connected(()=>{},idx).client,target),error=>
    held('observation_failed')(error)&&!error.message.includes('private fixture credentials'))
})

test('rejects malformed pins and inventory without accessing the observer',async()=>{
  const invalid=[{database:'crm_fixture\n'},{hostname:'other/x'},{serverId:'0'},{serverId:'4294967296'},
    {serverVersion:'8.0.1-MySQL'},{serverUid:undefined},{serverUid:'unknown'},{serverUid:'A'.repeat(26)+'B='},
    {observer:{user:"fence'obs",host:'localhost'}},{ordinaryWriterAccounts:[]},
    {ordinaryWriterAccounts:[target.observer]},{ordinaryWriterAccounts:[{...target.observer,host:'%'}]},
    {ordinaryWriterAccounts:[target.ordinaryWriterAccounts[0],target.ordinaryWriterAccounts[0]]}]
  for(const change of invalid){
    const {queries,client}=connected()
    await assert.rejects(observe(client,{...target,...change}),error=>held('target_invalid')(error)||held('inventory_invalid')(error))
    assert.equal(queries.length,0)
  }
})
