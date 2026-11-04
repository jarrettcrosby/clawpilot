#!/usr/bin/env node
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(resolve(root, 'app_src/package.json'))('typescript'), cache = new Map()
function load(path) {
  const filename = resolve(root,path)
  if (cache.has(filename)) return cache.get(filename).exports
  const module={exports:{}}; cache.set(filename,module)
  const code=ts.transpileModule(readFileSync(filename,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText
  new Function('require','module','exports',code)(name=>name==='node:crypto'?crypto:
    load(resolve(dirname(filename),name+'.ts')),module,module.exports)
  return module.exports
}
const api=load('app_src/lib/crm/nativeEmailAuthorityTransport.ts'), wire=load('app_src/lib/crm/nativeEmailPublication.ts')
const fixture=JSON.parse(execFileSync(process.execPath,['scripts/test-native-email-authority-approval.mjs','--emit-fixture'],{cwd:root,encoding:'utf8'}))
const phase=JSON.parse(execFileSync(process.execPath,['scripts/test-native-email-authority-transition.mjs','--emit-fixture'],{cwd:root,encoding:'utf8'}))
const config={baseUrl:'https://crm.fixture.invalid/legacy',clientId:'synthetic-client',clientSecret:'synthetic-secret'}
const clone=x=>JSON.parse(JSON.stringify(x))
const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}})
const approved=()=>({version:1,operationId:fixture.revoke.command.operationId,transitionId:fixture.revoke.command.transitionId,
  phase:'revoke',commandHash:wire.nativeEmailDigest(fixture.revoke.command),proofHash:wire.nativeEmailDigest(fixture.revoke.envelope.proof),
  appCommitFingerprint:null,replayed:false})
function harness(status=200, response=approved()) {
  const calls=[],input=clone(config)
  const client=api.createSuiteCrmNativeEmailAuthorityClient(input,async(url,init)=>{
    calls.push({url,init})
    if(url.endsWith('/Api/access_token'))return json({access_token:'synthetic-access-token',expires_in:3600,token_type:'Bearer'})
    return json(typeof response==='function'?response(url):response,status)
  })
  return {client,calls,input}
}
let count=0
async function check(label,run){await run();count++;console.log('PASS '+label)}
await check('dedicated client is inert until called and pins origin credentials fixed routes and no redirects',async()=>{
  const h=harness();assert.equal(h.calls.length,0)
  h.input.baseUrl='https://foreign.fixture.invalid';h.input.clientId='foreign'
  assert.deepEqual(await h.client.approve(fixture.revoke.command,fixture.revoke.envelope),approved())
  assert.equal(h.calls.length,2)
  assert.equal(h.calls[0].url,config.baseUrl+'/Api/access_token')
  assert.equal(JSON.parse(h.calls[0].init.body).client_id,config.clientId)
  assert.equal(h.calls[1].url,config.baseUrl+'/Api/V8/custom/clawpilot-email-authority/approve')
  for(const call of h.calls){assert.equal(call.init.redirect,'error');assert.equal(call.init.cache,'no-store');assert.ok(call.init.signal)}
  assert.equal(h.calls[1].init.headers.Authorization,'Bearer synthetic-access-token')
})
await check('approve validates retained proof readback and rejects changed identity before network',async()=>{
  const h=harness(),bad=clone(fixture.revoke.envelope);bad.proof.oauthClientId='foreign'
  await assert.rejects(()=>h.client.approve(fixture.revoke.command,bad));assert.equal(h.calls.length,0)
  for(const mutate of [r=>{r.proofHash='0'.repeat(64)},r=>{r.appCommitFingerprint='0'.repeat(64)},
    r=>{r.replayed='true'},r=>{r.extra=true},r=>{r.operationId='0'.repeat(64)}]){
    const r=approved();mutate(r);await assert.rejects(()=>harness(200,r).client.approve(fixture.revoke.command,fixture.revoke.envelope))
  }
})
await check('execute and exact resolve verify native terminal envelopes without automatic resend',async()=>{
  const h=harness(200,url=>url.endsWith('/resolve')?{...phase.revokeReceipt,replayed:true}:phase.revokeReceipt)
  assert.equal((await h.client.execute(fixture.revoke.command)).state,'committed')
  assert.equal((await h.client.resolveOrCancel(fixture.revoke.command)).replayed,true)
  assert.equal(h.calls.length,3);assert.match(h.calls[1].url,/\/execute$/);assert.match(h.calls[2].url,/\/resolve$/)
})
await check('expired revoke cancellation verifies original proof and exact terminal result without fabricating cancellation',async()=>{
  // Transport-only fake HTTP: native integration separately checks the actual
  // signature and expiry; no changed fake signature is trusted by native code.
  const expired=clone(fixture.revoke.envelope)
  expired.proof.issuedAt=Math.floor(Date.now()/1000)-121;expired.proof.expiresAt=Math.floor(Date.now()/1000)-1
  const readback={...approved(),proofHash:wire.nativeEmailDigest(expired.proof)}
  const cancelled={...phase.revokeReceipt,state:'cancelled',result:null}
  for(const receipt of [cancelled,phase.revokeReceipt]){
    const h=harness(200,{approval:readback,receipt})
    const result=await h.client.cancelExpiredRevoke(fixture.revoke.command,expired)
    assert.equal(result.receipt.state,receipt.state)
    assert.equal(h.calls.length,2);assert.match(h.calls[1].url,/\/cancel-expired$/)
    assert.deepEqual(JSON.parse(h.calls[1].init.body).authorization,expired)
  }
  const h=harness()
  await assert.rejects(()=>h.client.cancelExpiredRevoke(fixture.revoke.command,fixture.revoke.envelope))
  await assert.rejects(()=>h.client.cancelExpiredRevoke(fixture.grant.command,fixture.grant.envelope))
  assert.equal(h.calls.length,0)
  for(const result of [{approval:{...readback,proofHash:'0'.repeat(64)},receipt:cancelled},
    {approval:readback,receipt:{state:'cancelled'}},{approval:readback,receipt:cancelled,extra:true}]){
    await assert.rejects(()=>harness(200,result).client.cancelExpiredRevoke(fixture.revoke.command,expired))
  }
  await assert.rejects(()=>harness(409,{error:'not cancellation'}).client.cancelExpiredRevoke(fixture.revoke.command,expired))
})
await check('expired grant and append-only retry cancellation retain exact command proof and truthful terminal result',async()=>{
  for(const entry of [fixture.grant,...fixture.grantAttempts]){
    const expired=clone(entry.envelope),command=entry.command
    expired.proof.issuedAt=Math.floor(Date.now()/1000)-121;expired.proof.expiresAt=Math.floor(Date.now()/1000)-1
    const approval={version:1,operationId:command.operationId,transitionId:command.transitionId,phase:'grant',
      commandHash:wire.nativeEmailDigest(command),proofHash:wire.nativeEmailDigest(expired.proof),
      appCommitFingerprint:wire.nativeEmailDigest(expired.proof.appCommit),replayed:false}
    const receipt={...phase.grantReceipt,operationId:command.operationId,commandHash:wire.nativeEmailDigest(command)}
    for(const terminal of [receipt,{...receipt,state:'cancelled',result:null}]){
      const h=harness(200,{approval,receipt:terminal}),result=await h.client.cancelExpired(command,expired)
      assert.equal(result.receipt.state,terminal.state);assert.deepEqual(JSON.parse(h.calls[1].init.body),{command,authorization:expired})
      assert.match(h.calls[1].url,/\/cancel-expired$/)
    }
    const h=harness();await assert.rejects(()=>h.client.cancelExpired(command,entry.envelope));assert.equal(h.calls.length,0)
  }
})
await check('HTTP error or malformed receipt remains unknown and never becomes cancellation or provider diagnostics',async()=>{
  for(const status of [400,401,403,404,409,500]){
    const h=harness(status,{error:'synthetic sensitive provider detail'})
    await assert.rejects(()=>h.client.execute(fixture.revoke.command),e=>e.code==='authority_transport_response_held'
      && !e.message.includes('sensitive'))
    assert.equal(h.calls.length,2)
  }
  await assert.rejects(()=>harness(200,{state:'cancelled'}).client.resolveOrCancel(fixture.revoke.command))
})
await check('unsafe endpoints credentials oversized streams and invalid JSON are refused',async()=>{
  for(const changed of [{baseUrl:'http://public.fixture.invalid'},{baseUrl:'https://user:pass@crm.fixture.invalid'},
    {baseUrl:'https://crm.fixture.invalid?redirect=elsewhere'},{baseUrl:'https://crm.fixture.invalid/#secret'},
    {clientId:'x\n'},{clientSecret:'has space'}])assert.throws(()=>api.createSuiteCrmNativeEmailAuthorityClient({...config,...changed}))
  for(const body of ['{bad json','x'.repeat(1000001)]){
    const client=api.createSuiteCrmNativeEmailAuthorityClient(config,async url=>url.endsWith('/Api/access_token')?
      json({access_token:'token',expires_in:3600,token_type:'Bearer'}):new Response(body))
    await assert.rejects(()=>client.execute(fixture.revoke.command))
  }
})
console.log(`Native authority transport passed ${count} local fake-HTTP checks. No provider call, native route or live credentials used.`)
