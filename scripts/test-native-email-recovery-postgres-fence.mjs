#!/usr/bin/env node
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as util from 'node:util'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import test from 'node:test'

const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
function load(name, deps) {
  const source=readFileSync(new URL(`../app_src/lib/crm/${name}.ts`,import.meta.url),'utf8')
  const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}})
  const module={exports:{}}
  new Function('module','exports','require',outputText)(module,module.exports,key=>{
    assert.ok(Object.hasOwn(deps,key),`Unexpected dependency ${key}`)
    return deps[key]
  })
  return module.exports
}
const protocol=load('nativeEmailPublication',{'node:crypto':crypto})
const stores=load('nativeEmailRecoveryStoreBinding',{'server-only':{},'node:util':util,'./nativeEmailPublication':protocol})
const {observeNativeEmailRecoveryPostgresFence:observe}=load('nativeEmailRecoveryPostgresFence',
  {'server-only':{},'./nativeEmailPublication':protocol,'./nativeEmailRecoveryStoreBinding':stores})
const at='2026-11-07T00:12:30.123456Z'
const target={database:'crm_fixture',databaseOid:'23456',systemIdentifier:'7593016689639688026',verifierRole:'observer',
  ordinaryWriterRoles:['worker','app'],authorizedIdleSessions:[{pid:89,role:'controlled_operator',backendStartedAt:at}]}
const defaultRow=()=>({database:'crm_fixture',database_oid:'23456',system_identifier:'7593016689639688026',
  session_user:'observer',current_user:'observer',pid:87,stats_visible:true,track_activities:true,read_only:true,read_committed:true,
  in_recovery:false,observed_at:at,prepared_count:'0',roles:[{role:'observer',can_login:true},{role:'app',can_login:false},
    {role:'worker',can_login:false},{role:'controlled_operator',can_login:true}],activities:[
      {pid:87,role:'observer',database_oid:'23456',backend_type:'client backend',state:'active',in_transaction:true,backend_started_at:at},
      {pid:88,role:null,role_oid:null,database_oid:null,backend_type:'walwriter',state:null,in_transaction:false,backend_started_at:at},
      {pid:89,role:'controlled_operator',database_oid:'23456',backend_type:'client backend',state:'idle',in_transaction:false,backend_started_at:at},
      {pid:90,role:'fixture_bootstrap',role_oid:'10',database_oid:null,backend_type:'logical replication launcher',state:null,
        in_transaction:false,backend_started_at:at},
      {pid:92,role:null,role_oid:null,database_oid:null,backend_type:'io worker',state:null,in_transaction:false,backend_started_at:at},
    ]})
function connected({mutate=()=>{},refreshPid=87,queryFailure}={}) {
  const queries=[]
  const query=async(sql, params)=>{
    queries.push([sql,params])
    if(queries.length===1){
      assert.match(sql,/pg_catalog\.pg_stat_clear_snapshot\(\)/)
      assert.equal(params,undefined)
      return {rows:[{pid:refreshPid}]}
    }
    assert.equal(queries.length,2)
    assert.match(sql,/FROM pg_catalog\.pg_stat_activity LIMIT 129/)
    assert.match(sql,/count\(\*\)::text FROM pg_catalog\.pg_prepared_xacts/)
    assert.match(sql,/pg_catalog\.pg_control_system\(\)/)
    assert.doesNotMatch(sql,/\b(?:ALTER|INSERT|UPDATE|DELETE|SET ROLE|pg_terminate_backend)\b/i)
    assert.deepEqual(params,[['app','controlled_operator','observer','worker']])
    if(queryFailure)throw queryFailure
    const row=defaultRow();mutate(row)
    return {rows:[row]}
  }
  return {client:{query},queries}
}
const held=code=>e=>e instanceof protocol.NativeEmailPublicationHeld&&e.code===`legacy_dispatch_postgres_fence_${code}`

test('observes a fresh bounded cluster snapshot and returns only redacted evidence',async()=>{
  const {client}=connected(), result=await observe(client,target)
  assert.ok(Object.isFrozen(result))
  assert.deepEqual(result,{version:1,observedAt:at,
    storeFingerprint:protocol.nativeEmailDigest({version:1,purpose:'clawpilot-native-email-custody-postgres-store-v1',
      database:target.database,databaseOid:target.databaseOid,systemIdentifier:target.systemIdentifier}),
    targetFingerprint:protocol.nativeEmailDigest({
    ...target,ordinaryWriterRoles:['app','worker']}),closedOrdinaryRoles:2,authorizedIdleSessions:1,preparedTransactions:0})
  assert.doesNotMatch(JSON.stringify(result),/controlled_operator|observer|crm_fixture|7593016689639688026/)
})

test('refuses a different database, cluster, identity, read replica or pooled backend',async()=>{
  for(const [key,value] of Object.entries({database:'wrong',database_oid:'23457',system_identifier:'1',
    current_user:'switched_role',session_user:'other_login',in_recovery:true})){
    await assert.rejects(observe(connected({mutate:r=>r[key]=value}).client,target),held('identity_unproven'))
  }
  await assert.rejects(observe(connected({refreshPid:86}).client,target),held('identity_unproven'))
})

test('refuses incomplete visibility, stale isolation, and any prepared xact across databases',async()=>{
  for(const key of ['stats_visible','track_activities','read_only','read_committed']){
    await assert.rejects(observe(connected({mutate:r=>r[key]=false}).client,target),held('visibility_unproven'))
  }
  for(const count of ['1',null,0]){
    await assert.rejects(observe(connected({mutate:r=>r.prepared_count=count}).client,target),held('prepared_transactions_present_or_unproven'))
  }
  await assert.rejects(observe(connected({queryFailure:new Error('private connection info')}).client,target),e=>
    held('observation_failed')(e)&&!e.message.includes('private connection info'))
})

test('refuses an ordinary login or a missing/ambiguous role observation',async()=>{
  const changes=[r=>r.roles[1].can_login=true,r=>r.roles.pop(),r=>r.roles[1]=r.roles[0]]
  for(const mutate of changes)await assert.rejects(observe(connected({mutate}).client,target),held('role_inventory_unproven'))
})

test('requires exact idle operator process identity and rejects all unknown sessions',async()=>{
  const extra={pid:91,role:'unapproved',database_oid:'1',backend_type:'client backend',state:'idle',in_transaction:false,backend_started_at:at}
  const changes=[r=>r.activities.push(extra),r=>r.activities[2].state='active',r=>r.activities[2].in_transaction=true,
    r=>r.activities[2].backend_started_at='2026-11-07T00:00:00.000000Z',r=>r.activities[1].backend_type='custom_background_worker',
    r=>r.activities[1].database_oid='23456',r=>r.activities[2].database_oid='1',r=>r.activities[3].role_oid='11',
    r=>r.activities[3].backend_type='logical replication worker']
  for(const mutate of changes)await assert.rejects(observe(connected({mutate}).client,target),held('unexpected_session'))
  for(const mutate of [r=>r.activities.splice(2,1),r=>r.activities.shift(),r=>r.activities.push(r.activities[0]),
    r=>r.activities=Array(129).fill(r.activities[0])]){
    await assert.rejects(observe(connected({mutate}).client,target),held('session_inventory_unproven'))
  }
  await assert.rejects(observe(connected({mutate:r=>r.activities[0].state='disabled'}).client,target),held('observer_session_unproven'))
})

test('does not query for malformed identities, duplicate ordinary roles or privileged-session overlap',async()=>{
  const invalid=[{database:'crm_fixture\n'},{databaseOid:'4294967296'},{systemIdentifier:'18446744073709551616'},
    {ordinaryWriterRoles:['app','app']},
    {ordinaryWriterRoles:['observer']},{authorizedIdleSessions:[{pid:89,role:'worker',backendStartedAt:at}]},
    {authorizedIdleSessions:[target.authorizedIdleSessions[0],target.authorizedIdleSessions[0]]}]
  for(const drift of invalid){
    const {client,queries}=connected()
    await assert.rejects(observe(client,{...target,...drift}),e=>held('target_invalid')(e)||held('inventory_invalid')(e))
    assert.equal(queries.length,0)
  }
})

test('store binding has exact canonical input, purpose, and distinct pins for both stores',()=>{
  const postgres={database:target.database,databaseOid:target.databaseOid,systemIdentifier:target.systemIdentifier}
  const maria={database:'crm_fixture',hostname:'maria-fixture',serverId:'1',serverVersion:'11.4.13-MariaDB',
    serverUid:Buffer.alloc(20,1).toString('base64')}
  const pins={targetFingerprint:'a'.repeat(64),postgresStoreFingerprint:stores.nativeEmailPostgresStoreFingerprint(postgres),
    mariaStoreFingerprint:stores.nativeEmailMariaStoreFingerprint(maria)}
  const binding=stores.nativeEmailRecoveryStoreBindingFingerprint(pins)
  assert.equal(binding,protocol.nativeEmailDigest({version:1,purpose:'clawpilot-native-email-custody-stores-v1',...pins}))
  for(const key of Object.keys(pins)){
    assert.notEqual(stores.nativeEmailRecoveryStoreBindingFingerprint({...pins,[key]:'d'.repeat(64)}),binding)
    assert.throws(()=>stores.nativeEmailRecoveryStoreBindingFingerprint({...pins,[key]:'D'.repeat(64)}),/store_binding_fingerprint/u)
  }
  assert.throws(()=>stores.nativeEmailRecoveryStoreBindingFingerprint({...pins,alias:'other'}),/store_binding_shape/u)
  assert.throws(()=>stores.nativeEmailPostgresStoreFingerprint({...postgres,databaseOid:42}),/store_binding_postgres_identity/u)
  assert.throws(()=>stores.nativeEmailPostgresStoreFingerprint({...postgres,get database(){return postgres.database}}),/store_binding_shape/u)
  assert.throws(()=>stores.nativeEmailMariaStoreFingerprint({...maria,serverUid:'unknown'}),/store_binding_maria_identity/u)
})
