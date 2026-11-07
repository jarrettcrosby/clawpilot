#!/usr/bin/env node
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {once} from 'node:events'
import {chmodSync,lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs'
import {createRequire} from 'node:module'
import {createConnection,createServer} from 'node:net'
import * as path from 'node:path'
import * as util from 'node:util'
import test from 'node:test'

const appRequire=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=appRequire('typescript')
function compile(file){
  const source=readFileSync(new URL(`../app_src/lib/crm/${file}.ts`,import.meta.url),'utf8')
  return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
}
function load(source,dependencies,runtime={}){
  const module={exports:{}}
  new Function('module','exports','require','process','setTimeout',source)(module,module.exports,id=>{
    assert.ok(Object.hasOwn(dependencies,id),`Unexpected dependency ${id}`);return dependencies[id]
  },runtime.process??process,runtime.setTimeout??setTimeout)
  return module.exports
}
const protocol=load(compile('nativeEmailPublication'),{'node:crypto':crypto})
const proofProtocol=load(compile('nativeEmailRecoveryCustodyProof'),{'server-only':{},'node:crypto':crypto,'node:util':util,
  './nativeEmailPublication':protocol})
const socketSource=compile('nativeEmailRecoveryCustodySocket'),controllerUid=501,custodianUid=730
const hash=protocol.nativeEmailDigest, wire=value=>protocol.nativeEmailCanonicalJson(value)+'\n'
const pins={phase:'before',nonce:hash('nonce'),fenceEpoch:'11111111-1111-4111-8111-111111111111',
  expiresAt:Math.floor(Date.now()/1000)+120,targetFingerprint:hash('target'),storeBindingFingerprint:hash('stores'),
  operationId:hash('operation'),requestFingerprint:hash('request'),controllerConfigHash:hash('config'),producerInventoryHash:hash('inventory')}
const requested=Object.freeze({version:2,purpose:'clawpilot-native-email-recovery-custody-challenge-v2',...pins})
const requestWire=wire(requested)
const response={proof:{version:2,purpose:'clawpilot-native-email-recovery-custody-v2',keyId:'fixture',issuedAt:pins.expiresAt-100,
  retainedClosure:true,postgresObservationHash:hash('pg'),mariaObservationHash:hash('maria'),...pins},signature:'A'.repeat(512)}
const good=wire(response)
const held=code=>error=>error instanceof protocol.NativeEmailPublicationHeld&&error.code===`legacy_dispatch_custody_socket_${code}`

// Actual UNIX framing/EOF/socket teardown, injected ownership metadata only.
// This one-user test does not claim host permissions of a live custodian.
async function fixture(handler,run,options={}){
  const root=mkdtempSync(path.join(realpathSync('/tmp'),'cp-custody-')), socketPath=path.join(root,'gate.sock')
  const sockets=new Set(), reads=new Map(), requests=[]
  let connects=0,closed=0
  const server=createServer(socket=>{
    sockets.add(socket)
    socket.once('close',()=>{sockets.delete(socket);closed++})
    socket.on('error',()=>{})
    let wire='',started=false
    socket.on('data',bytes=>{
      wire+=bytes.toString('utf8')
      if(wire.includes('\n')&&!started){started=true;requests.push(wire);handler(socket)}
    })
  })
  try {
    server.listen(socketPath);await once(server,'listening');chmodSync(socketPath,0o660)
    const read=(entry,settings)=>{
      assert.deepEqual(settings,{bigint:true})
      const real=lstatSync(entry,settings),num=(reads.get(entry)??0)+1;reads.set(entry,num)
      const overrides=entry===root?{uid:BigInt(custodianUid),mode:(real.mode&~0o7777n)|0o750n}
        :entry===socketPath?{uid:BigInt(custodianUid)}:{uid:0n,mode:(real.mode&~0o7777n)|0o755n}
      const pinned=Object.assign(Object.create(Object.getPrototypeOf(real)),real,overrides)
      return options.stat?.(pinned,{entry,root,socketPath,num})??pinned
    }
    const {requestNativeEmailRecoveryCustody}=load(socketSource,{'server-only':{},'node:fs':{lstatSync:read},'node:net':{
      createConnection:args=>{connects++;return createConnection(args)},
    },'node:path':path,'node:util':util,'./nativeEmailPublication':protocol,'./nativeEmailRecoveryCustodyProof':proofProtocol},
    {process:{geteuid:()=>options.controllerUid??controllerUid},setTimeout:options.setTimeout})
    await run({request:overrides=>requestNativeEmailRecoveryCustody({socketPath,custodianUid,challenge:requested,...overrides}),
      socketPath,requests,reads,counts:()=>({connects,closed})})
  } finally {
    for(const socket of sockets)socket.destroy()
    if(server.listening){const stopped=once(server,'close');server.close();await stopped}
    rmSync(root,{recursive:true})
  }
}

test('real Unix exchange writes one canonical request and accepts one fragmented reply at EOF',async()=>{
  await fixture(socket=>{socket.write(good.slice(0,3));setImmediate(()=>socket.end(good.slice(3)))},async f=>{
    assert.deepEqual(await f.request(),response)
    assert.deepEqual(f.requests,[requestWire]);assert.equal(f.counts().connects,1)
    assert.equal(f.reads.get(f.socketPath),3)
  })
})
test('rejects relative, noncanonical, overlong, newline and same-user configurations before connecting',async()=>{
  await fixture(()=>assert.fail('unsafe connection'),async f=>{
    for(const socketPath of ['gate.sock','/run/../custody.sock','/run/./custody.sock','/run//custody.sock',
      '/run/custody.sock\n','/run/\0custody.sock','/run/'+ 'a'.repeat(100)])
      await assert.rejects(f.request({socketPath}),held('configuration'))
    for(const uid of [controllerUid,-1,1.5,0xffffffff])await assert.rejects(f.request({custodianUid:uid}),held('configuration'))
    assert.equal(f.counts().connects,0)
  })
  await fixture(()=>assert.fail('root controller connected'),async f=>{
    await assert.rejects(f.request(),held('configuration'));assert.equal(f.counts().connects,0)
  },{controllerUid:0})
})
test('rejects unsafe ancestor, parent, and socket metadata before connecting',async()=>{
  for(const scenario of ['ancestorWritable','ancestorOwner','parentOwner','parentMode','socketOwner','socketMode','socketLinks','socketKind']){
    await fixture(()=>assert.fail(scenario),async f=>{
      await assert.rejects(f.request(),held('path'));assert.equal(f.counts().connects,0)
    },{stat(stat,{entry,root,socketPath}){
      const changeMode=mode=>{stat.mode=(stat.mode&~0o7777n)|BigInt(mode)}
      if(entry==='/'){
        if(scenario==='ancestorWritable')changeMode(0o777)
        if(scenario==='ancestorOwner')stat.uid=BigInt(controllerUid)
      }
      if(entry===root){
        if(scenario==='parentOwner')stat.uid=0n
        if(scenario==='parentMode')changeMode(0o770)
      }
      if(entry===socketPath){
        if(scenario==='socketOwner')stat.uid=0n
        if(scenario==='socketMode')changeMode(0o666)
        if(scenario==='socketLinks')stat.nlink=2n
        if(scenario==='socketKind'){stat.isSocket=()=>false;stat.isSymbolicLink=()=>true}
      }
      return stat
    }})
  }
})
test('inode replacement on connect sends no bytes; drift before EOF never returns a result',async()=>{
  for(const driftAt of [2,3])await fixture(socket=>socket.end(good),async f=>{
    await assert.rejects(f.request(),held('path'))
    assert.deepEqual(f.requests,driftAt===2?[]:[requestWire]);assert.equal(f.counts().connects,1)
  },{stat(stat,{entry,socketPath,num}){if(entry===socketPath&&num===driftAt)stat.ino++;return stat}})
})
test('rejects malformed, noncanonical, extra, oversize, and invalid-UTF8 response frames',async()=>{
  for(const reply of ['',good.trim(),good+'x',good+good,'{"b":2,"a":1}\n','{"proof":1,"proof":2}\n',
    '{ "proof": "yes" }\n',good.replace('\n','\r\n'),'[]\n','\ufeff'+good,
    '{"proof":"'+'x'.repeat(8192)+'"}\n',Buffer.from([0x7b,0xff,0x7d,0x0a])]){
    await fixture(socket=>socket.end(reply),async f=>{
      await assert.rejects(f.request(),held('frame'));assert.equal(f.counts().connects,1)
    })
  }
  await fixture(socket=>{socket.write(good);setImmediate(()=>socket.end(good))},async f=>{
    await assert.rejects(f.request(),held('frame'));assert.equal(f.counts().connects,1)
  })
})
test('absolute deadline rejects a complete line without EOF and tears down without retries',async()=>{
  const deadlines=[]
  await fixture(socket=>socket.write(good),async f=>{
    await assert.rejects(f.request(),held('timeout'))
    assert.deepEqual(deadlines,[5000]);assert.deepEqual(f.requests,[requestWire]);assert.equal(f.counts().connects,1)
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.counts().closed,1)
  },{setTimeout(callback,ms){deadlines.push(ms);return setTimeout(callback,70)}})
})
test('oversized or accessor request never opens a connection',async()=>{
  await fixture(()=>assert.fail('unsafe request'),async f=>{
    const accessor={get nonce(){assert.fail('must not invoke accessor')}}
    for(const challenge of [{value:'x'.repeat(8192)},accessor,{nested:accessor},[],null,new Proxy(requested,{})])
      await assert.rejects(f.request({challenge}),held('request'))
    assert.equal(f.counts().connects,0)
  })
})
test('v1 or missing store binding is rejected on both sides of the socket',async()=>{
  const {storeBindingFingerprint:omitted,...legacy}=requested
  assert.ok(omitted)
  await fixture(()=>assert.fail('downgrade connected'),async f=>{
    for(const challenge of [legacy,{...requested,storeBindingFingerprint:'missing'},
      {...legacy,version:1,purpose:'clawpilot-native-email-recovery-custody-challenge-v1'}])
      await assert.rejects(f.request({challenge}),held('request'))
    assert.equal(f.counts().connects,0)
  })
  const {storeBindingFingerprint:old,...legacyProof}=response.proof
  assert.equal(old,pins.storeBindingFingerprint)
  for(const proof of [legacyProof,{...legacyProof,version:1,purpose:'clawpilot-native-email-recovery-custody-v1'},
    {...response.proof,storeBindingFingerprint:'missing'}])await fixture(socket=>socket.end(wire({...response,proof})),async f=>{
    await assert.rejects(f.request(),held('frame'))
    assert.equal(f.counts().connects,1)
  })
})
