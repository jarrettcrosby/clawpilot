import assert from 'node:assert/strict'
import {after,test} from 'node:test'
import {existsSync,mkdtempSync,readFileSync,rmdirSync,unlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createNativeEmailRecoveryDuplexCommandRunner} from '../app_src/lib/crm/nativeEmailRecoveryDuplexRunner.ts'

const scratch=mkdtempSync(join(tmpdir(),'clawpilot-duplex-proof-'))
const markers=[]
after(()=>{for(const marker of markers)if(existsSync(marker))unlinkSync(marker);rmdirSync(scratch)})
const auth='{"ready":"synthetic-bound-challenge"}'
const receipt='{"receipt":"fixture-only"}\n'
const packet='{"marker":"synthetic-private-packet"}\n'
const unknown='legacy_dispatch_transport_remote_outcome_unknown'
const unverified='legacy_dispatch_transport_destination_unverified'
const invalid='legacy_dispatch_transport_command_invalid'
const error=(code)=>({name:'Error',message:code})

// Use a real spawned child. The marker records exactly what the child reads,
// including any data that arrives while its initial challenge is withheld.
const childFixture=String.raw`
  const {appendFileSync}=require('node:fs');
  const [mode,path,auth,receipt]=process.argv.slice(1);
  let announced=false;
  process.stdin.on('data',bytes=>{
    if(!announced)appendFileSync(path+'.early',bytes);
    appendFileSync(path,bytes);
  });
  process.stdin.on('end',()=>{
    if(!announced)return;
    if(mode==='post-fail'){process.stderr.write('never expose remote diagnostics');process.exitCode=41;return;}
    if(mode==='empty-reply')return;
    if(mode==='duplicate-after-packet'){process.stdout.write(auth+'\n'+receipt);return;}
    if(mode==='oversize-reply'){process.stdout.write(Buffer.alloc(1_250_001,0x78));return;}
    if(mode==='invalid-reply-utf8'){process.stdout.write(Buffer.from([0xc3]));return;}
    process.stdout.write(receipt);
  });
  setTimeout(()=>{
    if(mode==='timeout')return;
    if(mode==='early-exit')process.exit(0);
    if(mode==='wrong-ready'){process.stderr.write('never expose remote diagnostics');process.stdout.write('{"wrong":true}\n');return;}
    if(mode==='duplicate-ready'){process.stdout.write(auth+'\n'+auth+'\n');return;}
    if(mode==='premature-receipt'){process.stdout.write(auth+'\n'+receipt);return;}
    if(mode==='oversize-ready'){process.stdout.write(Buffer.alloc(4097,0x78));return;}
    if(mode==='invalid-ready-utf8'){process.stdout.write(Buffer.from([0xc3,0x0a]));return;}
    if(mode==='empty-ready'){process.stdout.write('\n');return;}
    if(mode==='polluted-env'&&process.env.CLAWPILOT_TEST_PRIVATE_SENTINEL){process.stdout.write('incorrect-environment\n');return;}
    if(mode==='backpressure')process.stdin.pause();
    process.stdout.write(auth.slice(0,7));
    setTimeout(()=>{
      announced=true;process.stdout.write(auth.slice(7)+'\n');
      if(mode==='backpressure')setTimeout(()=>process.stdin.resume(),35);
    },15);
  },40);
`

function fixture(mode,options={}){
  const marker=join(scratch,String(markers.length))
  markers.push(marker,marker+'.early')
  let observed=0
  const run=createNativeEmailRecoveryDuplexCommandRunner(options.timeout??1500,100)
  const promise=run({program:process.execPath,args:['-e',childFixture,mode,marker,auth,receipt],
    stdin:options.packet??packet,verifyReady(line){observed++;return (options.verify??(line=>line===auth))(line)}})
  return {promise,observed:()=>observed,received:()=>existsSync(marker)?readFileSync(marker,'utf8'):'',
    premature:()=>existsSync(marker+'.early')?readFileSync(marker+'.early','utf8'):''}
}

test('authenticates a fragmented frame on the same child, then delivers the packet exactly once',async()=>{
  const subject=fixture('good')
  assert.equal(await subject.promise,receipt)
  assert.equal(subject.premature(),'')
  assert.equal(subject.received(),packet)
  assert.equal(subject.observed(),1)
})

test('delivers a bounded Unicode packet once even with initial child-side backpressure',async()=>{
  const large='λ'.repeat(200_000)+'\n'
  const subject=fixture('backpressure',{packet:large})
  assert.equal(await subject.promise,receipt)
  assert.equal(subject.premature(),'')
  assert.equal(subject.received(),large)
  assert.equal(subject.observed(),1)
})

test('requests deferred authorization only after the same child verifies, then writes once',async()=>{
  let authorized=0, verified=false
  const subject=fixture('good',{verify:line=>verified=line===auth,packet:async()=>{
    assert.equal(verified,true);authorized++;return packet
  }})
  assert.equal(await subject.promise,receipt)
  assert.equal(authorized,1)
  assert.equal(subject.premature(),'')
  assert.equal(subject.received(),packet)
  const refused=fixture('wrong-ready',{packet:async()=>{authorized++;return packet}})
  await assert.rejects(refused.promise,error(unverified))
  assert.equal(authorized,1)
  assert.equal(refused.received(),'')
})

for(const mode of ['wrong-ready','duplicate-ready','premature-receipt','oversize-ready','invalid-ready-utf8','empty-ready','early-exit','timeout']){
  test(`writes zero packet bytes before ${mode} failure`,async()=>{
    const subject=fixture(mode,{timeout:mode==='timeout'?150:1500})
    await assert.rejects(subject.promise,error(unverified))
    assert.equal(subject.premature(),'')
    assert.equal(subject.received(),'')
  })
}

test('rejects verifier exceptions and non-boolean or asynchronous verifier responses without writing',async()=>{
  for(const verify of [()=>{throw new Error('synthetic verifier secret')},()=>1,()=>Promise.resolve(true)]){
    const subject=fixture('good',{verify})
    await assert.rejects(subject.promise,error(unverified))
    assert.equal(subject.received(),'')
  }
})

for(const mode of ['post-fail','empty-reply','duplicate-after-packet','oversize-reply','invalid-reply-utf8']){
  test(`classifies ${mode} as unknown once the authenticated packet was sent`,async()=>{
    const subject=fixture(mode)
    await assert.rejects(subject.promise,error(unknown))
    assert.equal(subject.premature(),'')
    assert.equal(subject.received(),packet)
  })
}

test('does not forward unapproved environment variables to the child',async()=>{
  const key='CLAWPILOT_TEST_PRIVATE_SENTINEL', previous=process.env[key]
  try{
    process.env[key]='synthetic-do-not-inherit'
    const subject=fixture('polluted-env')
    assert.equal(await subject.promise,receipt)
    assert.equal(subject.received(),packet)
  }finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous}
})

test('rejects malformed input and maps a pre-authentication spawn error without exposing the path',async()=>{
  const run=createNativeEmailRecoveryDuplexCommandRunner(300,100)
  const args={program:process.execPath,args:[],stdin:packet,verifyReady:()=>true}
  await assert.rejects(run({...args,program:'relative-cli'}),error(invalid))
  await assert.rejects(run({...args,args:[null]}),error(invalid))
  await assert.rejects(run({...args,stdin:'a'.repeat(650_001)}),error(invalid))
  await assert.rejects(run({...args,stdin:'\ud800'}),error(invalid))
  await assert.rejects(run({...args,program:join(scratch,'nonexistent-private-binary')}),error(unverified))
})
