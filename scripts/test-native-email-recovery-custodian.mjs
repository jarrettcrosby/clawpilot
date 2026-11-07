#!/usr/bin/env node
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {once} from 'node:events'
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs'
import {createRequire} from 'node:module'
import {createConnection,createServer} from 'node:net'
import {join} from 'node:path'
import * as util from 'node:util'
import test from 'node:test'

const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
function compile(name){
  const source=readFileSync(new URL(`../app_src/lib/crm/${name}.ts`,import.meta.url),'utf8')
  return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
}
function load(source,deps,runtime={}){
  const module={exports:{}}
  new Function('module','exports','require','setTimeout',source)(module,module.exports,key=>{
    assert.ok(Object.hasOwn(deps,key),`Unexpected dependency ${key}`);return deps[key]
  },runtime.setTimeout??setTimeout)
  return module.exports
}
const protocol=load(compile('nativeEmailPublication'),{'node:crypto':crypto})
const common={'server-only':{},'./nativeEmailPublication':protocol}
const store=load(compile('nativeEmailRecoveryStoreBinding'),{...common,'node:util':util})
const pg=load(compile('nativeEmailRecoveryPostgresFence'),{...common,'./nativeEmailRecoveryStoreBinding':store})
const maria=load(compile('nativeEmailRecoveryMariaFence'),{...common,'./nativeEmailRecoveryStoreBinding':store})
const proofProtocol=load(compile('nativeEmailRecoveryCustodyProof'),{...common,'node:crypto':crypto,'node:util':util})
const {verifyNativeEmailRecoveryCustodyProof:verify}=proofProtocol
const source=compile('nativeEmailRecoveryCustodian')
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),keyId='synthetic-custody-key'
const nonce=()=>crypto.randomBytes(32).toString('hex'), now=()=>Math.floor(Date.now()/1000)
const canonical=protocol.nativeEmailCanonicalJson, hash=protocol.nativeEmailDigest
const at=(offset=0)=>new Date(Date.now()+offset).toISOString().replace(/Z$/,'000Z')
const options=()=>{
  const pgIdentity={database:'crm_fixture',databaseOid:'23456',systemIdentifier:'7593016689639688026'}
  const mariaIdentity={database:'suite_fixture',hostname:'native-fixture',serverId:'512',serverVersion:'11.4.13-MariaDB',
    serverUid:Buffer.alloc(20,1).toString('base64')}
  const targetFingerprint=hash('native')
  const storeBindingFingerprint=store.nativeEmailRecoveryStoreBindingFingerprint({targetFingerprint,
    postgresStoreFingerprint:store.nativeEmailPostgresStoreFingerprint(pgIdentity),
    mariaStoreFingerprint:store.nativeEmailMariaStoreFingerprint(mariaIdentity)})
  return {
    pins:{fenceEpoch:'00000000-0000-4000-8000-000000000001',expiresAt:now()+90,targetFingerprint,storeBindingFingerprint,
      operationId:hash('exact-message'),requestFingerprint:hash('request'),controllerConfigHash:hash('config'),producerInventoryHash:hash('inventory')},
    postgresTarget:{...pgIdentity,verifierRole:'observer',ordinaryWriterRoles:['app']},postgresWriterRole:'private_recovery',
    mariaTarget:{...mariaIdentity,observer:{user:'fence_observer',host:'localhost'},ordinaryWriterAccounts:[{user:'writer',host:'%'}]},
    key:privateKey,keyId,
  }
}
const wire=(expected,overrides={})=>canonical({version:2,purpose:'clawpilot-native-email-recovery-custody-challenge-v2',...expected,...overrides})+'\n'

async function fixture(run,settings={}){
  const config=options(), events=[], sockets=new Set(), deadlines=[]
  if(settings.wrongStoreBinding)config.pins.storeBindingFingerprint=hash('wrong store binding')
  let retained=false,pgActive=false,mariaActive=false,includeWriter=false,waitedSignal
  const {createNativeEmailRecoveryCustodian}=load(source,{...common,'node:crypto':{...crypto,sign:(...args)=>{
    assert.equal(retained,true);assert.equal(pgActive,false);assert.equal(mariaActive,false);events.push('sign');return crypto.sign(...args)
  }},'node:util':util,'./nativeEmailRecoveryPostgresFence':pg,'./nativeEmailRecoveryMariaFence':maria,
  './nativeEmailRecoveryCustodyProof':proofProtocol,'./nativeEmailRecoveryStoreBinding':store},
  {setTimeout:settings.timeout?(run,ms)=>{deadlines.push(ms);return setTimeout(run,settings.timeout)}:setTimeout})
  const pgObserver=async(signal,action)=>{
    assert.equal(retained,true);assert.equal(pgActive,false);assert.equal(mariaActive,false)
    pgActive=true;events.push('pg:open')
    const t=config.postgresTarget, writer=config.postgresWriterRole, backendStartedAt=at(-10_000)
    const sessions=includeWriter?[{pid:89,role:writer,database_oid:t.databaseOid,backend_type:'client backend',state:'idle',
      in_transaction:false,backend_started_at:backendStartedAt}]:[]
    try {
      return await action({query:async(sql,parameters)=>{
        assert.equal(retained,true);assert.equal(pgActive,true)
        if(sql.includes('pg_stat_clear_snapshot'))return {rows:[{pid:87}]}
        assert.match(sql,/pg_stat_activity/)
        assert.deepEqual(parameters,[includeWriter?['app','observer',writer]:['app','observer']])
        if(settings.holdPg){
          waitedSignal=signal
          if(!signal.aborted)await once(signal,'abort')
          throw Error('aborted fixture SQL')
        }
        const row={database:t.database,database_oid:t.databaseOid,system_identifier:t.systemIdentifier,session_user:t.verifierRole,
          current_user:t.verifierRole,pid:87,stats_visible:true,track_activities:true,read_only:true,read_committed:true,in_recovery:false,
          observed_at:at(settings.stale?-20_000:0),prepared_count:'0',roles:[{role:t.verifierRole,can_login:true},
            {role:'app',can_login:settings.pgUnlocked===true},...sessions.map(session=>({role:session.role,can_login:true}))],activities:[{
              pid:87,role:t.verifierRole,database_oid:t.databaseOid,backend_type:'client backend',state:'active',in_transaction:true,
              backend_started_at:backendStartedAt},...sessions]}
        if(includeWriter)row.activities[1].backend_started_at=retainedPin.backendStartedAt
        return {rows:[row]}
      }})
    } finally {pgActive=false;events.push('pg:close')}
  }
  const mariaObserver=async(_signal,action)=>{
    assert.equal(retained,true);assert.equal(pgActive,false);assert.equal(mariaActive,false)
    mariaActive=true;events.push('maria:open')
    const t=config.mariaTarget
    const identity=()=>({database_name:t.database,hostname:t.hostname,server_id:t.serverId,server_version:t.serverVersion,server_uid:t.serverUid,
      current_user:'fence_observer@localhost',session_login_user:t.observer.user,connection_id:'812',current_role:null,autocommit:'ON',
      in_transaction:'0',event_scheduler:'OFF',wsrep_on:'OFF',wsrep_provider:'none',observed_at:at()})
    try {
      return await action({query:async(sql)=>{
        assert.equal(retained,true);assert.equal(mariaActive,true)
        if(sql.includes('USER_PRIVILEGES'))return {rows:[{connection_id:'812',direct_process_grants:'1'}]}
        if(sql.includes('mysql.global_priv'))return {rows:[{connection_id:'812',account_user:'writer',account_host:'%',
          account_locked:settings.mariaUnlocked?'0':'1'}]}
        if(sql.includes('PROCESSLIST'))return {rows:[{observer_connection_id:'812',connection_id:'812',process_user:t.observer.user,
          database_name:t.database,command_name:'Query'}]}
        if(sql==='XA RECOVER'||sql==='SHOW ALL SLAVES STATUS')return {rows:[]}
        assert.match(sql,/UTC_TIMESTAMP/);return {rows:[identity()]}
      }})
    } finally {mariaActive=false;events.push('maria:close')}
  }
  let retainedPin
  const retain=async(pins,_signal,action)=>{
    assert.deepEqual(pins,config.pins);assert.equal(retained,false)
    events.push('retained:enter');retained=true
    retainedPin={pid:89,role:settings.wrongWriter?'another_role':config.postgresWriterRole,backendStartedAt:at(-10_000)}
    try {
      if(settings.bypassRetention)return 'not observed'
      if(settings.unawaited){void action({authorizedIdleSessions:[]});return 'not retained'}
      const result=await action({authorizedIdleSessions:includeWriter?[retainedPin]:[]})
      if(settings.double)await action({authorizedIdleSessions:[]})
      if(settings.lostRetention)throw Error('fixture closure was lost')
      return result
    } finally {retained=false;events.push('retained:exit')}
  }
  const responder=createNativeEmailRecoveryCustodian({...config,withRetainedClosure:retain,
    withPostgresObserver:settings.bypassPg?async()=>({}):pgObserver,withMariaObserver:mariaObserver})
  const server=createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));responder(socket)
  })
  const dir=mkdtempSync(join(realpathSync('/tmp'),'cp-custodian-')), socketPath=join(dir,'gate.sock')
  const exchange=async(payload,write=socket=>socket.write(payload))=>{
    const client=createConnection({path:socketPath}),chunks=[]
    client.on('data',chunk=>chunks.push(chunk));client.on('error',()=>{})
    const closed=new Promise(resolve=>client.once('close',resolve))
    client.once('connect',()=>write(client))
    await closed;await new Promise(resolve=>setImmediate(resolve))
    return Buffer.concat(chunks).toString('utf8')
  }
  try {
    server.listen(socketPath);await once(server,'listening')
    await run({events,deadlines,exchange,expected:(phase='before',id=nonce())=>({...config.pins,nonce:id,phase}),
      includeWriter:()=>{includeWriter=true},getSignal:()=>waitedSignal})
  } finally {
    for(const socket of sockets)socket.destroy()
    if(server.listening){const stopped=once(server,'close');server.close();await stopped}
    rmSync(dir,{recursive:true})
  }
}

test('exact local socket protocol signs only after two real validators and closed observers',async()=>{
  await fixture(async f=>{
    for(const phase of ['before','after']){
      if(phase==='after')f.includeWriter()
      const expected=f.expected(phase), packet=wire(expected)
      const reply=await f.exchange(packet,socket=>{socket.write(packet.slice(0,4));setImmediate(()=>socket.write(packet.slice(4)))})
      const envelope=JSON.parse(reply)
      assert.equal(reply,canonical(envelope)+'\n')
      assert.equal(envelope.proof.version,2)
      assert.equal(envelope.proof.storeBindingFingerprint,expected.storeBindingFingerprint)
      const evidence=verify({envelope,expected,anchor:{keyId,key:publicKey},nowSeconds:now()})
      assert.match(evidence.postgresObservationHash,/^[a-f0-9]{64}$/u)
      assert.match(evidence.mariaObservationHash,/^[a-f0-9]{64}$/u)
      assert.doesNotMatch(reply,/fence_observer|private_recovery|observer|fixture/u)
      assert.equal(await f.exchange(packet),'','nonce replay must never sign twice')
    }
    const sequence=['retained:enter','pg:open','pg:close','maria:open','maria:close','sign','retained:exit']
    assert.deepEqual(f.events,[...sequence,...sequence])
  })
})

test('rejects challenge drift, invalid framing and client-supplied idle pins without observing',async()=>{
  await fixture(async f=>{
    for(const field of ['targetFingerprint','storeBindingFingerprint','operationId','requestFingerprint','controllerConfigHash','producerInventoryHash'])
      assert.equal(await f.exchange(wire(f.expected(),{[field]:hash(field)})),'')
    for(const [field,value] of Object.entries({fenceEpoch:'00000000-0000-4000-8000-000000000002',expiresAt:now()+70,
      version:1,purpose:'other',phase:'publish',nonce:'invalid',authorizedIdleSessions:[]}))
      assert.equal(await f.exchange(wire(f.expected(),{[field]:value})),'')
    const {storeBindingFingerprint:omitted,...legacy}=f.expected()
    assert.ok(omitted)
    assert.equal(await f.exchange(wire(legacy,{version:1,purpose:'clawpilot-native-email-recovery-custody-challenge-v1'})),'')
    assert.equal(await f.exchange(wire(legacy)),'')
    const good=wire(f.expected())
    for(const invalid of [good+good,' '+good,good.replace('\n','\r\n'),'{"oversized":"'+'x'.repeat(8192)+'"}\n',
      Buffer.from([0xff,0x0a])])assert.equal(await f.exchange(invalid),'')
    assert.deepEqual(f.events,[])
  })
})

test('matching request and configured pins cannot override the binding independently computed from both observed stores',async()=>{
  await fixture(async f=>{
    assert.equal(await f.exchange(wire(f.expected())),'')
    assert.deepEqual(f.events,['retained:enter','pg:open','pg:close','maria:open','maria:close','retained:exit'])
  },{wrongStoreBinding:true})
})

test('retained scope/observer wrappers cannot fabricate results; custody lost after sign suppresses reply',async()=>{
  for(const settings of [{bypassRetention:true},{unawaited:true},{bypassPg:true},{double:true},{lostRetention:true}]){
    await fixture(async f=>{
      assert.equal(await f.exchange(wire(f.expected())),'')
      if(settings.bypassRetention||settings.unawaited||settings.bypassPg)assert.ok(!f.events.includes('sign'))
      else assert.equal(f.events.filter(event=>event==='sign').length,1)
      assert.ok(f.events.includes('retained:exit'))
    },settings)
  }
})

test('actual drain validators reject an unlocked login, untrusted writer, and stale observation',async()=>{
  for(const settings of [{pgUnlocked:true},{mariaUnlocked:true},{wrongWriter:true},{stale:true}]){
    await fixture(async f=>{
      if(settings.wrongWriter)f.includeWriter()
      assert.equal(await f.exchange(wire(f.expected())),'')
      assert.ok(!f.events.includes('sign'))
      assert.equal(f.events.at(-1),'retained:exit')
    },settings)
  }
})

test('five-second deadline aborts a pending observer without signing or retrying',async()=>{
  await fixture(async f=>{
    const pending=f.exchange(wire(f.expected()))
    for(let poll=0;poll<20&&!f.getSignal();poll++)await new Promise(resolve=>setImmediate(resolve))
    assert.ok(f.getSignal())
    assert.equal(await f.exchange(wire(f.expected())),'','no overlapping dedicated observers')
    assert.equal(await pending,'')
    assert.equal(f.getSignal()?.aborted,true)
    assert.deepEqual(f.deadlines,[5000])
    assert.deepEqual(f.events,['retained:enter','pg:open','pg:close','retained:exit'])
  },{holdPg:true,timeout:75})
})
