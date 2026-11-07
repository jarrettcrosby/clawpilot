#!/usr/bin/env node
// Run only in the disposable, network-isolated Node24 Linux container. This
// exercises the real emitted socket client and signature verifier, not any DB,
// real writer closure, external provider, service, or live signing key.
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {constants,createHash,createPublicKey,generateKeyPairSync,randomBytes,sign} from 'node:crypto'
import {once} from 'node:events'
import {chmodSync,chownSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {createConnection,createServer} from 'node:net'
import {networkInterfaces} from 'node:os'
import {dirname,join} from 'node:path'
import {createInterface} from 'node:readline'

const ROOT='/run/recovery-fixture',LIB=join(ROOT,'emitted'),PARENT=join(ROOT,'custody'),SOCKET=join(PARENT,'window.sock')
const UID={custodian:17001,controller:17002,outsider:17003},GROUP=17010,OUTSIDE_GROUP=17011
const keyId='fixture-independent-custodian'
const now=()=>Math.floor(Date.now()/1000)
const sha=value=>createHash('sha256').update(value).digest('hex')
const require=createRequire(import.meta.url)
const fixtureInput=()=>JSON.parse(readFileSync(0,'utf8'))
const childIdentity=(uid,gid)=>{
  assert.equal(process.geteuid(),uid);assert.equal(process.getegid(),gid)
  assert.ok(process.getgroups().every(group=>group===gid),'Unexpected supplementary group')
}
assert.equal(process.platform,'linux')
assert.equal(process.versions.node,'24.22.1')
assert.ok(process.execArgv.includes('--conditions=react-server'))
assert.ok(Object.values(networkInterfaces()).flat().every(nic=>nic.internal),'External network interface not allowed')

if(process.argv[2]==='--custodian'){
  childIdentity(UID.custodian,GROUP)
  const {nativeEmailCanonicalJson:json}=require(join(LIB,'lib/crm/nativeEmailPublication.js'))
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:3072})
  let accepted=0
  const server=createServer(socket=>{
    accepted++
    socket.setTimeout(2000,()=>socket.destroy())
    socket.on('error',()=>socket.destroy())
    const parts=[];let size=0
    socket.on('data',chunk=>{
      size+=chunk.length
      if(size>8192){socket.destroy();return}
      parts.push(chunk)
      if(chunk.at(-1)!==10)return
      const wire=Buffer.concat(parts,size).toString('utf8'),challenge=JSON.parse(wire)
      assert.equal(json(challenge)+'\n',wire)
      const {purpose,version,...pins}=challenge
      assert.equal(purpose,'clawpilot-native-email-recovery-custody-challenge-v2');assert.equal(version,2)
      assert.equal(pins.storeBindingFingerprint,sha('store binding'))
      const proof={...pins,version:2,purpose:'clawpilot-native-email-recovery-custody-v2',keyId,issuedAt:now(),
        postgresObservationHash:sha('fixture-pg'),mariaObservationHash:sha('fixture-maria'),retainedClosure:true}
      const signature=sign('sha256',Buffer.from(json(proof),'ascii'),
        {key:privateKey,padding:constants.RSA_PKCS1_PADDING}).toString('base64')
      socket.end(json({proof,signature})+'\n')
    })
  })
  server.listen(SOCKET,()=>{
    chmodSync(SOCKET,0o660)
    const st=lstatSync(SOCKET)
    assert.equal(st.uid,UID.custodian);assert.equal(st.gid,GROUP);assert.equal(st.mode&0o777,0o660)
    process.stdout.write(JSON.stringify({publicKey:publicKey.export({type:'spki',format:'pem'})})+'\n')
  })
  process.stdin.resume()
  process.stdin.once('end',()=>server.close(()=>process.stdout.write(JSON.stringify({accepted})+'\n')))
}else if(['--controller','--same-uid','--outsider'].includes(process.argv[2])){
  const role=process.argv[2],same=role==='--same-uid',outsider=role==='--outsider'
  childIdentity(same?UID.custodian:outsider?UID.outsider:UID.controller,outsider?OUTSIDE_GROUP:GROUP)
  const {requestNativeEmailRecoveryCustody}=require(join(LIB,'lib/crm/nativeEmailRecoveryCustodySocket.js'))
  const {verifyNativeEmailRecoveryCustodyProof}=require(join(LIB,'lib/crm/nativeEmailRecoveryCustodyProof.js'))
  const {expected,publicKey}=fixtureInput()
  const request={socketPath:SOCKET,custodianUid:UID.custodian,challenge:{version:2,
    purpose:'clawpilot-native-email-recovery-custody-challenge-v2',...expected}}
  if(same)await assert.rejects(requestNativeEmailRecoveryCustody(request),error=>error.code==='legacy_dispatch_custody_socket_configuration')
  else if(outsider){
    await assert.rejects(requestNativeEmailRecoveryCustody(request),error=>error.code==='legacy_dispatch_custody_socket_path')
    // Direct kernel proof too: the caller cannot bypass the client's path guard.
    await assert.rejects(new Promise((resolve,reject)=>{
      const socket=createConnection(SOCKET)
      socket.once('connect',()=>{socket.destroy();resolve()})
      socket.once('error',reject)
    }),error=>error.code==='EACCES')
  }else{
    const envelope=await requestNativeEmailRecoveryCustody(request)
    const anchor={keyId,key:createPublicKey(publicKey)}
    const observation=verifyNativeEmailRecoveryCustodyProof({envelope,expected,anchor,nowSeconds:now()})
    assert.equal(observation.postgresObservationHash,sha('fixture-pg'))
    assert.equal(observation.mariaObservationHash,sha('fixture-maria'))
    assert.throws(()=>verifyNativeEmailRecoveryCustodyProof({envelope,expected:{...expected,phase:'after'},anchor,nowSeconds:now()}),
      error=>error.code==='legacy_dispatch_custody_binding')
  }
}else{
  childIdentity(0,0)
  assert.equal(process.argv.length,3)
  const pin=/^--manifest-sha256=([a-f0-9]{64})(?![\s\S])/u.exec(process.argv[2])?.[1]
  assert.ok(pin,'An exact build manifest SHA-256 is required')
  const mounts=readFileSync('/proc/self/mountinfo','utf8').split('\n').map(line=>line.split(' '))
  assert.ok(mounts.some(parts=>parts[4]==='/build'&&parts[5].split(',').includes('ro')))
  assert.ok(mounts.some(parts=>parts[4]===ROOT&&parts[parts.indexOf('-')+1]==='tmpfs'))
  const root=lstatSync(ROOT)
  assert.ok(root.isDirectory());assert.equal(root.uid,0);assert.equal(root.mode&0o777,0o755)
  const manifestBytes=readFileSync('/build/build-manifest.json'),manifest=JSON.parse(manifestBytes)
  assert.equal(sha(manifestBytes),pin)
  assert.equal(manifest.purpose,'clawpilot-native-email-recovery-private-operator-build')
  assert.equal(manifest.requiredNodeCondition,'react-server')
  // Host build directories are often mode 0700; expose only these rehashed
  // public-code outputs in a root-owned tmpfs view, never the host build mount.
  for(const file of ['package.json','node_modules/server-only/package.json','node_modules/server-only/empty.js',
    'node_modules/server-only/index.js','lib/crm/nativeEmailPublication.js','lib/crm/nativeEmailRecoveryCustodySocket.js',
    'lib/crm/nativeEmailRecoveryCustodyProof.js']){
    const source=join('/build',file),bytes=readFileSync(source),destination=join(LIB,file)
    assert.ok(lstatSync(source).isFile());assert.equal(sha(bytes),manifest.outputs[file],file)
    mkdirSync(dirname(destination),{recursive:true,mode:0o755})
    writeFileSync(destination,bytes,{flag:'wx',mode:0o644})
  }
  mkdirSync(PARENT,{mode:0o750});chmodSync(PARENT,0o750);chownSync(PARENT,UID.custodian,GROUP)
  const run=(role)=>['--conditions=react-server',process.argv[1],role]
  const custodian=spawn(process.execPath,run('--custodian'),{env:{},uid:UID.custodian,gid:GROUP,
    stdio:['pipe','pipe','inherit'],timeout:20000,killSignal:'SIGKILL'})
  const stopped=once(custodian,'exit')
  const lines=createInterface({input:custodian.stdout}), iterator=lines[Symbol.asyncIterator]()
  try{
    const ready=await iterator.next();assert.equal(ready.done,false)
    const {publicKey}=JSON.parse(ready.value)
    const expected={nonce:randomBytes(32).toString('hex'),phase:'before',fenceEpoch:'11111111-1111-4111-8111-111111111111',
      expiresAt:now()+120,targetFingerprint:sha('target'),storeBindingFingerprint:sha('store binding'),
      operationId:sha('operation'),requestFingerprint:sha('request'),
      controllerConfigHash:sha('config'),producerInventoryHash:sha('inventory')}
    const input=JSON.stringify({publicKey,expected})
    for(const [role,uid,gid] of [['--controller',UID.controller,GROUP],['--same-uid',UID.custodian,GROUP],
      ['--outsider',UID.outsider,OUTSIDE_GROUP]]){
      const result=spawnSync(process.execPath,run(role),{env:{},uid,gid,input,encoding:'utf8',timeout:6000,maxBuffer:16384})
      assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'')
    }
    custodian.stdin.end()
    const summary=await iterator.next();assert.equal(summary.done,false)
    assert.deepEqual(JSON.parse(summary.value),{accepted:1})
    assert.deepEqual(await stopped,[0,null])
    console.log(JSON.stringify({distinctUidWireProven:true,untrustedGroupKernelDenied:true,sameUidClientRejected:true,
      acceptedConnections:1,manifestSha256:pin,syntheticSigner:true,realWriterClosureProven:false,productionTouched:false}))
  }finally{
    custodian.stdin.destroy();lines.close()
    if(custodian.exitCode===null&&custodian.signalCode===null)custodian.kill('SIGKILL')
  }
}
