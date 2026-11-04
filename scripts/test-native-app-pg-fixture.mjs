#!/usr/bin/env node
import assert from 'node:assert/strict'
import {combinedFixtureEditors,boundedNativeAclProfile,assertCombinedNativeScaleHandoff,nativeFixtureScaleEmailCount} from './lib/native-app-postgres-acceptance.mjs'
import {nativeRuntimeFixtureProfile} from './lib/native-runtime-fixture-profile.mjs'
assert.equal(nativeRuntimeFixtureProfile().phpVersion,'8.3.35')
assert.equal(nativeRuntimeFixtureProfile('8.3.36').image,'clawpilot-suitecrm-native-acceptance:8.10.1-php83-8.3.36')
assert.ok(Object.isFrozen(nativeRuntimeFixtureProfile('8.3.36')))
for(const value of ['8.3','latest','8.3.37','__proto__',null,{},['8.3.36']])assert.throws(()=>nativeRuntimeFixtureProfile(value))
console.log('PASS named PHP fixture selection preserves the original default and refuses unknown/unpinned profiles; pure only')
assert.equal(nativeFixtureScaleEmailCount(),318)
assert.equal(nativeFixtureScaleEmailCount(334),334)
for(const value of [0,1,317,319,329,335,500,501,'334','latest',null,{},[334],NaN,Infinity])assert.throws(()=>nativeFixtureScaleEmailCount(value))
console.log('PASS named synthetic history selection preserves 318 and explicitly admits 334 only; not native/live capacity proof')
const binding={pipeline_id:'pipeline',owner_id:'owner',readers_json:JSON.stringify(['editor-a','editor-b','owner','viewer']),capability_policy_json:null}
const row=(edit=['editor-a','editor-b','owner'],remove=edit)=>({pipelineId:'pipeline',capabilities:{edit,delete:remove}})
assert.deepEqual([...combinedFixtureEditors(binding,[row(),row()])],['editor-a','editor-b','owner'])
assert.equal(combinedFixtureEditors(binding,[row()]).has('viewer'),false)
for(const rows of [[row(),row(['owner'])],[row(['owner'],[])],[row(['outside','owner'])],[row(['editor-a'])]])
  assert.throws(()=>combinedFixtureEditors(binding,rows))
assert.deepEqual([...combinedFixtureEditors(binding,[])],['owner'])
assert.deepEqual([...combinedFixtureEditors({...binding,capability_policy_json:JSON.stringify({futureCreate:{edit:['owner']}})},[row()])],['owner'])
console.log('PASS legacy fixture retains observed editors, refuses nonuniform or foreign writers, and keeps v2 future intent explicit; pure only')
const metric={milliseconds:1.25,queries:12,preparedExecutions:0,gcRuns:0,gcCollected:0,peakBytes:1048576}
const profile={version:2,emailCount:318,principalCount:12,constructorIterations:1000,
 fullScan:{...metric},usersAndHydration:{...metric},factoryConstructor:{...metric},directConstructor:{...metric}}
assert.deepEqual(boundedNativeAclProfile(profile),profile)
assert.ok(boundedNativeAclProfile({...profile,fullScan:{...metric,queries:null}}))
for(const mutate of [v=>{v.nativeIdentity='private'},v=>{v.emailCount=501},v=>{v.principalCount=0},
 v=>{v.constructorIterations=1001},v=>{v.fullScan.extra='private'},v=>{v.fullScan.milliseconds=Infinity},
 v=>{v.fullScan.milliseconds=30001},v=>{v.fullScan.queries='secret'},v=>{v.fullScan.gcRuns=-1},
 v=>{v.fullScan.peakBytes=1e12},v=>{delete v.factoryConstructor}]){
 const value=JSON.parse(JSON.stringify(profile));mutate(value);assert.throws(()=>boundedNativeAclProfile(value))
}
console.log('PASS private native profiling accepts bounded numeric metrics only, never identity/provider fields; not performance/native proof')
const scale={status:'committed',emailCount:318,principalCount:12,durationMs:4255,commitDeadlineSeconds:5,productionScaleProven:false}
const handoff=(revoke=scale,grant=scale,marker='NATIVE_AUTHORITY_V2_SCALE_BOTH_PASSED=1')=>[
 'NATIVE_AUTHORITY_V2_SCALE='+JSON.stringify(revoke),'NATIVE_AUTHORITY_V2_SCALE_GRANT='+JSON.stringify(grant),marker].join('\n')
assert.deepEqual(assertCombinedNativeScaleHandoff(handoff()),{revoke:scale,grant:scale})
const reviewedScale={...scale,emailCount:334}
assert.deepEqual(assertCombinedNativeScaleHandoff(handoff(reviewedScale,reviewedScale),334),{revoke:reviewedScale,grant:reviewedScale})
for(const [input,expected]of [[handoff(),334],[handoff(reviewedScale,reviewedScale),318],
 [handoff(reviewedScale,scale),334],[handoff(reviewedScale,{...reviewedScale,status:'deadline_held'}),334],
 [handoff(reviewedScale,{...reviewedScale,commitDeadlineSeconds:6}),334],[handoff(),329],[handoff(),500]])
 assert.throws(()=>assertCombinedNativeScaleHandoff(input,expected))
assert.equal(assertCombinedNativeScaleHandoff(handoff(scale,{...scale,durationMs:5001})).grant.commitDeadlineSeconds,5)
for(const input of [handoff({...scale,status:'deadline_held'}),handoff(scale,{...scale,status:'deadline_held'}),
 handoff(scale,{...scale,durationMs:30001}),handoff(scale,scale,''),handoff()+'\n'+handoff(),
 handoff({...scale,productionScaleProven:true}),handoff({...scale,emailCount:1}),handoff({...scale,commitDeadlineSeconds:6})])
 assert.throws(()=>assertCombinedNativeScaleHandoff(input))
console.log('PASS combined native handoff refuses held/missing/duplicate scale receipts before app tests; unchanged deadlines/coverage, pure only')
