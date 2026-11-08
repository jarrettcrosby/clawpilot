#!/usr/bin/env node
// Pure evidence-port fixtures only. No DB, network, browser or signing keys.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import test from 'node:test'

const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript'),cache=new Map()
function load(name){
  if(cache.has(name))return cache.get(name)
  const src=readFileSync(new URL(`../app_src/lib/crm/${name}.ts`,import.meta.url),'utf8')
  const emitted=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const module={exports:{}}
  new Function('require','module','exports',emitted)(id=>id==='server-only'?{}:id.startsWith('node:')?require(id):load(id.slice(2)),module,module.exports)
  cache.set(name,module.exports);return module.exports
}
const {previewLegacyEmailTerminalHold:preview}=load('legacyEmailTerminalHoldPreview')
const {legacyEmailTerminalHoldManifestDigest:holdDigest}=load('legacyEmailRetirementApproval')
const {nativeEmailDigest:hash}=load('nativeEmailPublication')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const initialRows=()=>[11,12].map(n=>({outboxId:id(n),localId:id(n+20),nativeId:id(n+40),globalId:`gi${String(n).padStart(7,'0')}`,
  pipelineId:id(10),workspaceId:id(9),attempts:8,rowFingerprint:hash(['row',n]),sourceFingerprint:hash(['source',n]),
  payloadFingerprint:hash(['payload',n]),keyFingerprint:hash(['key',n]),relationshipFingerprint:hash(['relationship',n]),
  providerIdentityFingerprint:hash(['provider',n])}))
const counts=()=>({emails:0,customById:0,customByGlobal:0,emailText:0,beanLinks:0,addressLinks:0,securityGroupLinks:0,managedIdentities:0,nativeOperations:0})
function fixture({patchApp,patchNative}={}){
  const target={operationId:id(1),scope:{projectId:id(2),environmentId:id(3),postgresDatabaseFingerprint:hash('PG'),appCommit:'a'.repeat(40),
    nativeDeploymentId:id(4),nativeReplicaId:id(5),nativeCommit:'b'.repeat(40),nativeDatabaseFingerprint:hash('Maria'),nativeAuthorityInstanceId:id(6)},
  actorEmail:'root@preview.example.invalid',operatorAccountId:id(7),rootWorkspaceId:id(9),fenceEpoch:id(8),outboxIds:[id(11),id(12)],
  postgresObserverFingerprint:hash('PG direct read observer'),nativeObserverFingerprint:hash('Maria direct read observer')}
  const history=[],signals=[]
  const bind=(r,native)=>({phase:r.phase,observationId:r.observationId,candidateFingerprint:r.candidateFingerprint,
    storeFingerprint:native?r.target.scope.nativeDatabaseFingerprint:r.target.scope.postgresDatabaseFingerprint,
    observerFingerprint:native?r.target.nativeObserverFingerprint:r.target.postgresObserverFingerprint,observedAtMs:Date.now()})
  const observeApp=async(r,signal)=>{
    history.push(r);signals.push(signal)
    const result={...bind(r,false),appGeneration:5,gateFingerprint:hash('gate'),appSourceFingerprint:hash('app'),
      authorityDisabledIdle:true,operatorRootVerified:true,rows:initialRows()}
    return patchApp?await patchApp(result,r):result
  }
  const observeNative=async(r,signal)=>{
    history.push(r);signals.push(signal)
    const result={...bind(r,true),stockSchemaAbsenceFingerprint:hash('exact stock schema absence'),
      rows:r.identities.map(row=>({...row,counts:counts()}))}
    return patchNative?await patchNative(result,r):result
  }
  return {input:{target,timeoutMs:1000,observeApp,observeNative},history,signals}
}
const refused=(input,code)=>assert.rejects(preview(input),error=>error?.code===`legacy_terminal_hold_preview_${code}`)

test('brackets a candidate-bound exact absence read and emits only an unsigned, non-executable review draft',async()=>{
  const {input,history,signals}=fixture(), result=await preview(input)
  assert.deepEqual(history.map(x=>x.phase),['appBefore','nativeAbsence','appAfter'])
  assert.equal(new Set(history.map(x=>x.observationId)).size,3)
  assert.equal(new Set(history.map(x=>x.candidateFingerprint)).size,1)
  assert.deepEqual(history[1].identities,initialRows().map(({outboxId,localId,nativeId,globalId})=>({outboxId,localId,nativeId,globalId})))
  assert.ok(history.every(x=>Object.isFrozen(x)&&Object.isFrozen(x.target)&&Object.isFrozen(x.target.scope)&&Object.isFrozen(x.target.outboxIds)))
  assert.ok(Object.isFrozen(history[1].identities)&&history[1].identities.every(Object.isFrozen))
  assert.equal(new Set(signals).size,1);assert.equal(signals[0].aborted,true)
  assert.deepEqual(Object.keys(result).sort(),['count','holdAuthorized','liveFenceProven','manifestDraft','previewDigest','reviewOnly'])
  assert.equal(result.count,2);assert.equal(result.reviewOnly,true);assert.equal(result.holdAuthorized,false);assert.equal(result.liveFenceProven,false)
  assert.match(result.previewDigest,/^[0-9a-f]{64}$/u)
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.manifestDraft)&&Object.isFrozen(result.manifestDraft.rows))
  assert.deepEqual(result.manifestDraft.rows,initialRows())
  assert.equal(result.manifestDraft.historicalProviderOutcome,'unknown')
  assert.equal(Object.hasOwn(result.manifestDraft,'fenceEvidenceFingerprint'),false)
  assert.throws(()=>holdDigest(result.manifestDraft),error=>error.code==='legacy_email_retirement_shape')
  const testCompleteDigest=holdDigest({...result.manifestDraft,fenceEvidenceFingerprint:hash('test-only fence placeholder')})
  assert.notEqual(result.previewDigest,testCompleteDigest)
})

test('rejects unbounded, missing, duplicate or unsorted reviewed ID sets before any observer starts',async()=>{
  for(const values of [[],[id(11),id(11)],[id(12),id(11)],[id(11).toUpperCase().replace('0000','ABCD')],
    Array.from({length:26},(_,n)=>id(11+n)),Object.assign([id(11)],{extra:true})]){
    const {input,history}=fixture();input.target.outboxIds=values
    await refused(input,'exact_ids');assert.equal(history.length,0)
  }
  const {input,history}=fixture()
  input.target.nativeObserverFingerprint=input.target.postgresObserverFingerprint
  await refused(input,'target_binding');assert.equal(history.length,0)
  input.target.nativeObserverFingerprint=hash('new native observer');input.target.scope.appCommit='not a commit'
  await refused(input,'target_identity');assert.equal(history.length,0)
})

test('refuses extra, missing, unreviewed or duplicate app identities before native lookup',async()=>{
  for(const [change,code] of [
    [value=>value.rows.push(initialRows()[0]),'app_rows'],[value=>value.rows.pop(),'app_rows'],
    [value=>{value.rows[1].outboxId=id(99)},'app_rows'],[value=>{value.rows[1].outboxId=id(11)},'app_rows'],
    [value=>{value.rows[0].body='must not leave source'},'app_row_shape'],
  ]){
    const {input,history}=fixture({patchApp:value=>{change(value);return value}})
    await refused(input,code);assert.deepEqual(history.map(r=>r.phase),['appBefore'])
  }
  for(const key of ['localId','nativeId','globalId','keyFingerprint']){
    const {input,history}=fixture({patchApp:value=>{value.rows[1][key]=value.rows[0][key];return value}})
    await assert.rejects(preview(input),error=>error.code==='legacy_email_retirement_duplicate_row_identity')
    assert.deepEqual(history.map(r=>r.phase),['appBefore'])
  }
  const {input,history}=fixture({patchApp:value=>{value.rows[0].attempts=7;return value}})
  await assert.rejects(preview(input),error=>error.code==='legacy_email_retirement_row_identity')
  assert.deepEqual(history.map(r=>r.phase),['appBefore'])
})

test('refuses stale, replayed, wrong-store, wrong-observer and unbound responses',async()=>{
  for(const [field,replacement] of Object.entries({storeFingerprint:hash('other PG'),observerFingerprint:hash('other observer'),
    phase:'appAfter',observationId:id(1),candidateFingerprint:hash('other candidate')})){
    const {input,history}=fixture({patchApp:value=>({...value,[field]:replacement})})
    await refused(input,'observation_binding');assert.equal(history.length,1)
  }
  for(const [field,replacement] of Object.entries({storeFingerprint:hash('other Maria'),observerFingerprint:hash('other native observer'),
    phase:'appBefore',observationId:id(1),candidateFingerprint:hash('other candidate')})){
    const {input,history}=fixture({patchNative:value=>({...value,[field]:replacement})})
    await refused(input,'observation_binding');assert.equal(history.length,2)
  }
  for(const offset of [-60_000,60_000]){
    const {input}=fixture({patchNative:value=>({...value,observedAtMs:Date.now()+offset})})
    await refused(input,'observation_clock')
  }
  let appA
  const {input}=fixture({patchApp:(value,request)=>{
    if(request.phase==='appBefore'){appA=value;return value}
    return appA
  }})
  await refused(input,'observation_binding')
})

test('any native existence, orphan, identity substitution or malformed count holds the preview',async()=>{
  for(const key of Object.keys(counts())){
    const {input,history}=fixture({patchNative:value=>{value.rows[0].counts[key]=1;return value}})
    await refused(input,'native_not_absent');assert.equal(history.length,2)
  }
  for(const [change,code] of [
    [value=>{delete value.stockSchemaAbsenceFingerprint},'native_shape'],
    [value=>{value.stockSchemaAbsenceFingerprint='0'.repeat(64)},'native_stock_schema'],
    [value=>{value.stockSchemaAbsenceFingerprint='not a receipt'},'native_stock_schema'],
    [value=>{delete value.rows[0].counts.emailText},'native_count_shape'],
    [value=>{value.rows[0].counts.emailText='0'},'native_not_absent'],
    [value=>{value.rows[0].counts.unreviewed=0},'native_count_shape'],
    [value=>{value.rows[0].globalId='gi0000025'},'native_rows'],
    [value=>{value.rows.reverse()},'native_rows'],[value=>{value.rows[1]=value.rows[0]},'native_rows'],
    [value=>{value.rows.push(value.rows[0])},'native_rows'],[value=>{value.rows.pop()},'native_rows'],
  ]){
    const {input}=fixture({patchNative:value=>{change(value);return value}})
    await refused(input,code)
  }
})

test('requires the second app snapshot to equal the first and both authority proofs to remain valid',async()=>{
  for(const change of [value=>{value.appGeneration++},value=>{value.gateFingerprint=hash('new gate')},
    value=>{value.appSourceFingerprint=hash('new snapshot')},value=>{value.rows[1].payloadFingerprint=hash('changed bytes')},
    value=>{value.rows[0].relationshipFingerprint=hash('new placement')},value=>{value.rows[0].providerIdentityFingerprint=hash('new alias')}]){
    const {input,history}=fixture({patchApp:(value,request)=>{if(request.phase==='appAfter')change(value);return value}})
    await refused(input,'app_drift');assert.deepEqual(history.map(r=>r.phase),['appBefore','nativeAbsence','appAfter'])
  }
  for(const key of ['authorityDisabledIdle','operatorRootVerified']){
    const {input}=fixture({patchApp:(value,request)=>({...value,[key]:request.phase==='appBefore'})})
    await refused(input,'app_authority')
  }
  const {input}=fixture({patchNative:value=>({...value,observedAtMs:Date.now()-500})})
  await refused(input,'observation_order')
  let accessed=false
  const malformed=fixture({patchApp:(value,request)=>{
    if(request.phase==='appAfter')value.rows[0].rowFingerprint={get unexpected(){accessed=true;return 'untrusted'}}
    return value
  }})
  await assert.rejects(preview(malformed.input),error=>error.code==='legacy_email_retirement_row_fingerprint')
  assert.equal(accessed,false,'Refuse non-scalar evidence before canonicalization')
})

test('snapshots caller-owned target and observed rows before a later callback can mutate them',async()=>{
  let first
  const {input}=fixture({patchApp:(value,r)=>{
    if(r.phase==='appBefore')first=value
    return value
  },patchNative:value=>{
    input.target.scope.nativeCommit='c'.repeat(40);input.target.outboxIds[0]=id(99)
    first.rows[0].relationshipFingerprint=hash('late mutation')
    return value
  }})
  const result=await preview(input)
  assert.equal(result.manifestDraft.scope.nativeCommit,'b'.repeat(40))
  assert.deepEqual(result.manifestDraft.rows,initialRows())
})

test('observer failure is redacted and a hard deadline aborts even a non-cooperative observation',async()=>{
  const failed=fixture({patchNative:()=>{throw new Error('private fixture driver detail')}})
  await assert.rejects(preview(failed.input),error=>error.code==='legacy_terminal_hold_preview_observation_failed'
    &&!error.message.includes('private fixture driver detail'))
  const waiting=fixture({patchNative:()=>new Promise(()=>{})});waiting.input.timeoutMs=40
  await refused(waiting.input,'timeout');assert.deepEqual(waiting.history.map(r=>r.phase),['appBefore','nativeAbsence'])
  assert.ok(waiting.signals.every(signal=>signal.aborted))
  const outOfRange=fixture();outOfRange.input.timeoutMs=5001
  await refused(outOfRange.input,'observer_configuration');assert.equal(outOfRange.history.length,0)
  const unsolicited=fixture();unsolicited.input.apply=true
  await refused(unsolicited.input,'observer_configuration');assert.equal(unsolicited.history.length,0)
})
