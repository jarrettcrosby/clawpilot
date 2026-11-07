// The default lane tests the actual adapter and its SQL/error boundaries
// without any network. --real-pg18 uses only an owned disposable local DB.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import * as crypto from 'node:crypto'
import {EventEmitter} from 'node:events'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import * as net from 'node:net'
import {join} from 'node:path'
import * as tls from 'node:tls'
import {test} from 'node:test'

const require=createRequire(new URL('../app_src/package.json',import.meta.url))
const ts=require('typescript')
const load=(relative,deps)=>{
  const file=new URL(relative,import.meta.url)
  const source=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const module={exports:{}}
  new Function('require','module','exports',source)(key=>{assert.ok(Object.hasOwn(deps,key),`Unexpected import: ${key}`);return deps[key]},module,module.exports)
  return module.exports
}
const protocol=load('../app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const create=Pool=>load('../app_src/lib/crm/nativeEmailRecoveryPrivatePostgres.ts',{
  'server-only':{},pg:{Pool},'node:net':net,'node:tls':tls,'./nativeEmailPublication':protocol,
}).createNativeEmailRecoveryPrivatePostgres
const target={host:'private.example.test',port:5432,database:'scope',user:'operator_role',systemIdentifier:'7345261137799120010',databaseOid:'15399'}
const observation={database_name:target.database,database_oid:target.databaseOid,system_identifier:target.systemIdentifier,
  session_role:target.user,effective_role:target.user,pid:314,backend_started_at:'2026-11-07T01:52:01.000001Z',
  primary_server:true,using_tls:true,transaction_profile:true,restricted_login:true,no_role_membership:true,no_ownership_or_create:true}
const held=name=>error=>error instanceof protocol.NativeEmailPublicationHeld&&error.code===`legacy_dispatch_private_postgres_${name}`
function fake({proofs=[],commitError,commitCommand='COMMIT',rollbackError,connectError}={}){
  let pool,observations=0
  const events=[]
  const client={query:async sql=>{
    if(sql.startsWith('SELECT d.datname')){events.push('observe');const row=proofs[observations++]??observation
      if(row instanceof Error)throw row
      return {rows:[row]}}
    if(sql==='COMMIT'){events.push(sql);if(commitError)throw commitError;return {command:commitCommand}}
    if(sql==='ROLLBACK'){events.push(sql);if(rollbackError)throw rollbackError;return {command:sql}}
    events.push(sql);return {command:'SET',rows:[]}
  },release:broken=>events.push(broken?'discard':'release')}
  class Pool extends EventEmitter{
    constructor(options){super();this.options=options;pool=this}
    async connect(){events.push('connect');if(connectError)throw connectError;return client}
    async end(){events.push('close')}
  }
  return {make:options=>create(Pool)({target,password:'fixture-not-a-secret',...options}),events,pool:()=>pool}
}

test('pins the full TLS destination, one idle backend and bounded read-committed transactions',async()=>{
  const fixture=fake(),mutable={...target},adapter=fixture.make({target:mutable})
  mutable.host='different.example.test'
  const cfg=fixture.pool().options
  assert.equal(cfg.host,target.host);assert.equal(cfg.port,target.port);assert.equal(cfg.database,target.database)
  assert.equal(cfg.user,target.user);assert.equal(cfg.connectionString,undefined);assert.equal(cfg.ssl.rejectUnauthorized,true)
  assert.ok(cfg.ssl.checkServerIdentity('different.example.test',{subjectaltname:'DNS:different.example.test'}))
  assert.equal(cfg.ssl.checkServerIdentity('different.example.test',{subjectaltname:'DNS:private.example.test'}),undefined)
  assert.deepEqual([cfg.max,cfg.connectionTimeoutMillis,cfg.statement_timeout,cfg.lock_timeout,cfg.idle_in_transaction_session_timeout],
    [1,3000,8000,2500,10000])
  assert.equal(adapter.sessionPin(),null)
  assert.equal(await adapter.transaction(async client=>{assert.equal(adapter.sessionPin(),null);await client.query('fixture work');return 42}),42)
  assert.deepEqual(adapter.sessionPin(),{role:target.user,pid:observation.pid,backendStartedAt:observation.backend_started_at})
  assert.ok(Object.isFrozen(adapter.sessionPin()))
  assert.deepEqual(fixture.events,['connect','BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    "SET LOCAL search_path=pg_catalog,public; SET LOCAL TIME ZONE 'UTC'; SET LOCAL row_security=on",
    'observe','fixture work','observe','COMMIT','release'])
  await adapter.close();await adapter.close();assert.equal(fixture.events.filter(x=>x==='close').length,1)
})

test('refuses ambient PG overrides, config aliases, remote plaintext and ambiguous host inputs',async()=>{
  const fixture=fake()
  for(const host of ['','example.test.','example.test/other','/tmp/postgres','a@b','[::1]','example.test\n'])
    assert.throws(()=>fixture.make({target:{...target,host}}),held('target'))
  assert.throws(()=>fixture.make({connectionString:'postgresql://not-approved'}),held('configuration'))
  assert.throws(()=>fixture.make({allowLoopbackFixture:true}),held('tls_configuration'))
  assert.throws(()=>fixture.make({allowLoopbackFixture:true,target:{...target,host:'localhost'}}),held('tls_configuration'))
  const old=process.env.PGREPLICATION
  try{process.env.PGREPLICATION='database';assert.throws(()=>fixture.make(),held('ambient_configuration'))}
  finally{if(old===undefined)delete process.env.PGREPLICATION;else process.env.PGREPLICATION=old}
  const testFixture=fake({proofs:[{...observation,using_tls:false},{...observation,using_tls:false}]}),local=testFixture.make({
    allowLoopbackFixture:true,target:{...target,host:'127.0.0.1'},
  })
  assert.equal(testFixture.pool().options.ssl,false)
  await local.transaction(async()=>true);await local.close()
})

test('rejects any identity, TLS, authority or transaction profile mismatch before calling the DAL',async()=>{
  for(const [key,value] of [['database_name','elsewhere'],['database_oid','1'],['system_identifier','99'],['session_role','wrong'],
    ['effective_role','wrong'],['primary_server',false],['using_tls',false],['transaction_profile',false],['restricted_login',false],
    ['no_role_membership',false],['no_ownership_or_create',false],['pid',0],['backend_started_at','invalid']]){
    const f=fake({proofs:[{...observation,[key]:value}]}),adapter=f.make()
    await assert.rejects(adapter.transaction(async()=>assert.fail(`unexpected work: ${key}`)),held('identity_unproven'))
    assert.deepEqual(f.events.slice(-2),['ROLLBACK','discard']);assert.equal(adapter.sessionPin(),null);await adapter.close()
  }
})

test('holds on reconnect or changed effective role between observation and commit',async()=>{
  const fixture=fake({proofs:[observation,observation,{...observation,pid:315}]});const adapter=fixture.make()
  await adapter.transaction(async()=>true)
  await assert.rejects(adapter.transaction(async()=>assert.fail('backend moved')),held('identity_unproven'))
  await assert.rejects(adapter.transaction(async()=>true),held('connection_unavailable'))
  await adapter.close()
  const changed=fake({proofs:[observation,{...observation,effective_role:'wrong'}]}),after=changed.make()
  await assert.rejects(after.transaction(async()=>true),held('identity_unproven'))
  assert.ok(!changed.events.includes('COMMIT'));await after.close()
})

test('never retries, rolls back, or reconnects after a lost or invalid commit acknowledgement',async()=>{
  for(const behavior of [{commitError:new Error('sensitive synthetic transport detail')},{commitCommand:'ROLLBACK'}]){
    const fixture=fake(behavior),adapter=fixture.make()
    await assert.rejects(adapter.transaction(async()=>true),held('commit_outcome_unknown'))
    assert.deepEqual(fixture.events.slice(-2),['COMMIT','discard'])
    await assert.rejects(adapter.transaction(async()=>true),held('connection_unavailable'))
    assert.equal(fixture.events.filter(x=>x==='connect').length,1);assert.equal(adapter.sessionPin(),null);await adapter.close()
  }
})

test('preserves a reviewed hold on clean rollback but discards a failed rollback or idle client',async()=>{
  const review=new protocol.NativeEmailPublicationHeld('fixture_exact_hold')
  const fixture=fake(),adapter=fixture.make()
  await assert.rejects(adapter.transaction(async()=>{throw review}),error=>error===review)
  assert.deepEqual(fixture.events.slice(-2),['ROLLBACK','release'])
  assert.equal(await adapter.transaction(async()=>true),true)
  fixture.pool().emit('error',new Error('secret fixture text'))
  await assert.rejects(adapter.transaction(async()=>true),held('connection_unavailable'));await adapter.close()
  const broken=fake({rollbackError:new Error('secret fixture text')}),second=broken.make()
  await assert.rejects(second.transaction(async()=>{throw new Error('another fixture secret')}),held('transaction_failed'))
  assert.equal(broken.events.at(-1),'discard');await assert.rejects(second.transaction(async()=>true),held('connection_unavailable'));await second.close()
})

test('refuses concurrent transaction callbacks and keeps connection errors redacted',async()=>{
  const fixture=fake(),adapter=fixture.make()
  let finish,start
  const running=new Promise(resolve=>{start=resolve}),allowEnd=new Promise(resolve=>{finish=resolve})
  const one=adapter.transaction(async()=>{start();await allowEnd})
  await running
  try{await assert.rejects(adapter.transaction(async()=>true),held('connection_unavailable'))}
  finally{finish();await one;await adapter.close()}
  const failed=fake({connectError:new Error('synthetic password and destination')}),second=failed.make()
  await assert.rejects(second.transaction(async()=>true),held('transaction_failed'))
  await second.close()
})

if(process.argv.slice(2).includes('--real-pg18'))test('checks a real isolated PostgreSQL 18 restricted SCRAM/TLS login and rejects role or create-right drift',async()=>{
  const fixturePath=mkdtempSync('/private/tmp/clawpilot-private-pg-')
  assert.match(fixturePath,/^\/private\/tmp\/clawpilot-private-pg-[a-zA-Z0-9]+$/u)
  const bin='/opt/homebrew/opt/postgresql@18/bin',data=join(fixturePath,'db'),log=join(fixturePath,'server.log')
  const key=join(fixturePath,'fixture-key.pem'),cert=join(fixturePath,'fixture-cert.pem')
  const {Pool}=require('pg')
  const port=await new Promise((resolve,reject)=>{const listener=net.createServer();listener.on('error',reject)
    listener.listen(0,'127.0.0.1',()=>{const value=listener.address().port;listener.close(error=>error?reject(error):resolve(value))})})
  const call=(name,args)=>execFileSync(join(bin,name),args,{encoding:'utf8',timeout:15000,stdio:'pipe'})
  let started=false,admin,client
  try{
    const passwordFile=join(fixturePath,'bootstrap-pw')
    writeFileSync(passwordFile,randomBytes(24).toString('hex')+'\n',{mode:0o600,flag:'wx'})
    call('initdb',['-D',data,'-U','fixture_owner','--auth-local=trust','--auth-host=scram-sha-256','--pwfile',passwordFile,'--no-sync','--no-instructions'])
    rmSync(passwordFile)
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-noenc','-sha256','-days','1','-keyout',key,'-out',cert,
      '-subj','/CN=clawpilot-recovery-fixture.invalid','-addext','subjectAltName=IP:127.0.0.1'],{timeout:10000,stdio:'pipe'})
    call('pg_ctl',['-D',data,'-l',log,'-o',`-h 127.0.0.1 -p ${port} -k ${fixturePath} -c timezone=UTC -c ssl=on -c ssl_cert_file=${cert} -c ssl_key_file=${key}`,
      '-w','-t','10','start']);started=true
    admin=new Pool({host:fixturePath,port,database:'postgres',user:'fixture_owner',ssl:false,max:1,connectionTimeoutMillis:2000})
    const proof=(await admin.query(`SELECT current_database() AS database,d.oid::text AS oid,p.system_identifier::text AS identifier
      FROM pg_database d CROSS JOIN pg_control_system() p WHERE d.datname=current_database()`)).rows[0]
    assert.equal(proof.database,'postgres')
    await admin.query('CREATE ROLE operator_role LOGIN NOINHERIT; CREATE ROLE alternate_role NOLOGIN; REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC')
    const password=randomBytes(24).toString('hex')
    await admin.query(`ALTER ROLE operator_role PASSWORD '${password}'`)
    const cfg={target:{host:'127.0.0.1',port,database:'postgres',user:'operator_role',systemIdentifier:proof.identifier,databaseOid:proof.oid},
      password,allowLoopbackFixture:true}
    const open=()=>create(Pool)(cfg)
    client=open();await assert.rejects(client.transaction(async()=>assert.fail('missing observer privilege')),held('identity_unproven'));await client.close()
    await admin.query('GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO operator_role')
    client=open();assert.equal(await client.transaction(async db=>(await db.query('SELECT 37 AS verified')).rows[0].verified),37)
    assert.equal(client.sessionPin().role,'operator_role')
    await client.close()
    client=create(Pool)({target:cfg.target,password,tlsCa:readFileSync(cert,'utf8')})
    assert.equal(await client.transaction(async db=>(await db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl),true)
    await admin.query('GRANT alternate_role TO operator_role')
    await assert.rejects(client.transaction(async()=>assert.fail('alternate role')),held('identity_unproven'))
    await client.close()
    await admin.query('REVOKE alternate_role FROM operator_role; GRANT CREATE ON SCHEMA public TO operator_role')
    client=open();await assert.rejects(client.transaction(async()=>assert.fail('unexpected create authority')),held('identity_unproven'))
  }finally{
    try{if(client)await client.close()}finally{try{if(admin)await admin.end()}finally{
      if(started)call('pg_ctl',['-D',data,'-m','fast','-w','-t','10','stop'])
      rmSync(fixturePath,{recursive:true,force:true})
    }}
  }
})
