#!/usr/bin/env node
// Actual hold DAL, approval and custody signature verifiers, and local journal.
// Transaction and custody I/O are synthetic, with no DB, network, or CLI.
import assert from 'node:assert/strict'
import {constants, generateKeyPairSync, sign} from 'node:crypto'
import * as fs from 'node:fs'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join, posix} from 'node:path'
import test, {after} from 'node:test'

const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript'),cache=new Map()
const noTransport=()=>assert.fail('hold must never start a native publisher or duplex transport')
function load(file){
  if(cache.has(file))return cache.get(file)
  const src=fs.readFileSync(new URL(`../app_src/${file}.ts`,import.meta.url),'utf8')
  const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const module={exports:{}}
  new Function('require','module','exports',js)(name=>{
    if(name==='server-only')return {}
    if(name==='./nativeEmailRecoveryDuplexRunner')return {createNativeEmailRecoveryDuplexCommandRunner:noTransport}
    if(name==='./nativeEmailRecoveryReadyProof')return {createNativeEmailRecoveryReadyChallenge:noTransport}
    if(name.startsWith('node:'))return require(name)
    assert.match(name,/^\.\.?\/[A-Za-z0-9./]+$/u)
    return load(posix.normalize(posix.join(posix.dirname(file),name)))
  },module,module.exports)
  cache.set(file,module.exports)
  return module.exports
}

const {nativeEmailCanonicalJson:json,nativeEmailDigest:hash}=load('lib/crm/nativeEmailPublication')
const {legacyEmailTerminalHoldManifestDigest:manifestHash}=load('lib/crm/legacyEmailRetirementApproval')
const {legacyEmailTerminalHoldPrivateDestination:makeDestination,legacyEmailTerminalHoldCustodySelection:makeCustodySelection,
  applyLegacyEmailTerminalHoldPrivately:apply,inspectLegacyEmailTerminalHoldPrivately:inspect}
  =load('lib/crm/legacyEmailTerminalHoldPrivateOperator')
const [absenceKey,operatorKey,custodianKey]=Array.from({length:3},()=>generateKeyPairSync('rsa',{modulusLength:3072}))
const signature=(proof,key)=>({proof,signature:sign('sha256',Buffer.from(json(proof),'ascii'),
  {key,padding:constants.RSA_PKCS1_PADDING}).toString('base64')})
const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'clawpilot-private-hold-tests-'))
after(()=>fs.rmSync(root,{recursive:true}))
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const now=()=>Math.floor(Date.now()/1000)
const code=expected=>error=>error?.code===expected

function fixture({lost,invalidCustodyAt,roleMismatch,storeMismatch,unrestricted,invalidReceipt,drift,lateClosure=false}={}){
  const directory=fs.mkdtempSync(join(root,'case-'))
  const destination={native:{projectId:id(1),environmentId:id(2),serviceId:id(3),deploymentId:id(4),
    deploymentInstanceId:id(5),replicaId:id(6),nativeInstanceId:'native-fixture',database:'suite_fixture',
    databasePrincipal:'fixture_writer@localhost',serviceUserId:'suite-service',oauthClientId:'suite-oauth',
    cliSourceHash:hash('cli'),imagePackageHash:hash('image'),mariaStoreFingerprint:hash('physical native database')},
    postgres:{database:'fixture_database',systemIdentifier:'18446744073709551615',databaseOid:'4294967295'},
    appCommit:'a'.repeat(40),nativeCommit:'b'.repeat(40)}
  const {scope,targetFingerprint,storeBindingFingerprint}=makeDestination(destination)
  const operationId=id(7),fenceEpoch=id(8),workspaceId=id(9),pipelineId=id(10)
  const manifest={version:1,action:'hold_exact_legacy_terminal_rows_in_place',operationId,scope,
    actorEmail:'owner@work.example.invalid',operatorAccountId:id(11),rootWorkspaceId:workspaceId,appGeneration:4,
    gateFingerprint:hash('gate'),appSourceFingerprint:hash('source'),fenceEpoch,fenceEvidenceFingerprint:hash('fence'),
    nativeAbsenceFingerprint:hash('absence'),historicalProviderOutcome:'unknown',publicationDisposition:'hold_without_publication',
    rows:[0,1,2].map(i=>({outboxId:id(20+i),localId:id(30+i),nativeId:id(40+i),globalId:'gi'+(1000000+i),
      workspaceId,pipelineId,attempts:8,rowFingerprint:hash(['row',i]),sourceFingerprint:hash(['source',i]),
      payloadFingerprint:hash(['payload',i]),keyFingerprint:hash(['key',i]),
      relationshipFingerprint:hash(['relationship',i]),providerIdentityFingerprint:hash(['provider',i])}))}
  const manifestDigest=manifestHash(manifest),start=now()
  const common={version:1,operationId,manifestDigest,audience:'clawpilot-private-legacy-email-hold-controller',
    issuedAt:start-3,expiresAt:start+105}
  const fenceEnvelope=signature({...common,keyId:'absence',purpose:'clawpilot-legacy-email-hold-fenced-absence-v1',
    issuer:'clawpilot-crm-hold-fence-attestor'},absenceKey.privateKey)
  const operatorEnvelope=signature({...common,keyId:'operator',purpose:'clawpilot-legacy-email-hold-review-v1',
    issuer:'clawpilot-crm-hold-operator',fenceEnvelopeDigest:hash(fenceEnvelope)},operatorKey.privateKey)
  const approvalDigest=hash(operatorEnvelope),resultPins={operationId,manifestDigest,approvalDigest}
  const outboxIds=manifest.rows.map(row=>row.outboxId),selection={...resultPins,fenceEpoch,outboxIds}
  const writerRoles={attestor:'hold_attestor',controller:'hold_controller'}
  const journalPath=join(directory,`terminal-hold-${operationId}.json`)
  const expectJournal={version:1,purpose:'clawpilot-private-legacy-email-terminal-hold-journal-v1',...resultPins,
    targetFingerprint:hash({version:1,purpose:'clawpilot-terminal-hold-journal-target-v1',targetFingerprint,
      attestorRole:writerRoles.attestor,controllerRole:writerRoles.controller}),fenceEpoch,expectedRows:outboxIds.length}
  const receipt={...resultPins,state:'committed',rows:outboxIds.length,receiptHash:hash('receipt'),historicalProviderOutcome:'unknown'}
  const events=[],nonces=new Set()
  let open=false,attested=false,committed=false,observations=0,early
  const makeLane=(kind,role)=>({role,transaction:async run=>{
    events.push(`${kind}:begin`)
    if(kind!=='observer'){assert.ok(open);assert.equal(fs.readFileSync(journalPath,'utf8'),json(expectJournal)+'\n')}
    const login=kind===roleMismatch?'wrong_login':role
    const value=await run({query:async (sql,args)=>{
      if(kind!=='observer')assert.ok(open)
      if(sql.includes('pg_catalog.pg_control_system()')){
        events.push(`${kind}:identity`)
        return {rows:[{database_name:destination.postgres.database,database_oid:destination.postgres.databaseOid,
          system_identifier:kind===storeMismatch?'1':destination.postgres.systemIdentifier,
          login,role,primary_server:true,read_only:kind==='observer'?'on':'off',read_committed:true,
          restricted_login:kind!==unrestricted}]}
      }
      if(sql==="SET LOCAL TIME ZONE 'UTC'"){assert.notEqual(kind,'observer');return {rows:[]}}
      if(sql.includes(' AS second')){assert.equal(kind,'attestor');return {rows:[{login,role,second:now()}]}}
      if(sql==='SELECT session_user AS login,current_user AS role'){assert.equal(kind,'controller');return {rows:[{login,role}]}}
      if(sql.includes('INSERT INTO crm_legacy_email_terminal_hold.verified_batch')){
        assert.equal(kind,'attestor');assert.equal(observations,1)
        assert.deepEqual(args,[operationId,json(manifest),manifestDigest,hash(fenceEnvelope),approvalDigest,common.expiresAt])
        events.push('attest');attested=true;return {rowCount:1}
      }
      if(sql.includes('crm_legacy_email_terminal_hold.hold(')){
        assert.equal(kind,'controller');assert.equal(observations,2);assert.ok(attested)
        assert.deepEqual(args,[operationId,outboxIds,approvalDigest]);events.push('hold')
        committed=true;return {rows:[{count:outboxIds.length}]}
      }
      if(sql.includes('crm_legacy_email_terminal_hold.resolve(')){
        assert.equal(kind,'observer');assert.equal(open,false);events.push('resolve')
        assert.deepEqual(args,[operationId,manifestDigest,approvalDigest])
        return {rows:[{receipt:committed?(invalidReceipt?invalidReceipt(receipt):receipt):{state:'unknown'}}]}
      }
      assert.fail('unexpected SQL')
    }})
    events.push(`${kind}:commit`)
    if(lost===kind)throw Error('raw connection diagnostic must not leak')
    return value
  }})
  const custody={anchor:{keyId:'custodian',key:custodianKey.publicKey},expiresAt:start+180,
    controllerConfigHash:hash('configuration'),producerInventoryHash:hash('producer inventory')}
  const applyInput={destination,journalDirectory:directory,selection,custody,review:{expectedManifest:manifest,
    fenceEnvelope,operatorEnvelope,fenceAnchor:{keyId:'absence',key:absenceKey.publicKey},
    operatorAnchor:{keyId:'operator',key:operatorKey.publicKey}},
    attestor:makeLane('attestor',writerRoles.attestor),controller:makeLane('controller',writerRoles.controller),
    withRetainedClosure:async run=>{
      assert.equal(open,false);events.push('closure:enter');open=true
      try{
        if(lateClosure){early=run();return {}}
        return await run()
      }finally{open=false;events.push('closure:exit')}
    },
    observeCustody:async (challenge,signal)=>{
      assert.ok(open);assert.equal(signal.aborted,false);assert.ok(Object.isFrozen(challenge))
      if(lateClosure)await Promise.resolve()
      const {version,purpose,...binding}=challenge
      assert.equal(version,2);assert.equal(purpose,'clawpilot-native-email-recovery-custody-challenge-v2')
      assert.equal(binding.targetFingerprint,targetFingerprint);assert.equal(binding.storeBindingFingerprint,storeBindingFingerprint)
      assert.equal(binding.fenceEpoch,fenceEpoch);assert.equal(binding.expiresAt,custody.expiresAt)
      assert.equal(binding.controllerConfigHash,custody.controllerConfigHash)
      assert.equal(binding.producerInventoryHash,custody.producerInventoryHash)
      const pins=makeCustodySelection({...resultPins,targetFingerprint})
      assert.equal(binding.operationId,pins.operationId);assert.equal(binding.requestFingerprint,pins.requestFingerprint)
      assert.ok(!nonces.has(binding.nonce));nonces.add(binding.nonce);++observations;events.push(challenge.phase)
      if(invalidCustodyAt===observations)binding.nonce='0'.repeat(64)
      return signature({...binding,version:2,purpose:'clawpilot-native-email-recovery-custody-v2',
        keyId:'custodian',issuedAt:now(),retainedClosure:true,postgresObservationHash:hash('pg observation'),
        mariaObservationHash:hash('maria observation')},custodianKey.privateKey)
    },
    rebuildManifest:async review=>{
      assert.ok(open);events.push('rebuild')
      assert.ok(Object.isFrozen(review)&&Object.isFrozen(review.outboxIds))
      assert.deepEqual(review,{scope,operationId,fenceEpoch,actorEmail:manifest.actorEmail,operatorAccountId:manifest.operatorAccountId,
        rootWorkspaceId:manifest.rootWorkspaceId,outboxIds})
      assert.equal(fs.existsSync(journalPath),false)
      return drift?{...manifest,appSourceFingerprint:hash('drift')}:structuredClone(manifest)
    },
  }
  const inspectInput={destination,journalDirectory:directory,pins:{...resultPins,fenceEpoch,expectedRows:outboxIds.length},
    writerRoles,observer:makeLane('observer','hold_observer')}
  return {applyInput,inspectInput,receipt,journalPath,events,outboxIds,expectJournal,early:()=>early}
}

test('three nonce-bound observations hold once; journal precedes both roles; separate observer reads exact receipt',async()=>{
  const f=fixture(),result=await apply(f.applyInput)
  assert.deepEqual(result,{state:'committed',operationId:f.receipt.operationId,rows:3,
    targetFingerprint:makeDestination(f.applyInput.destination).targetFingerprint})
  assert.deepEqual(f.events,['closure:enter','before','rebuild','attestor:begin','attestor:identity','attest','attestor:commit',
    'before','controller:begin','controller:identity','hold','controller:commit','after','closure:exit'])
  const bytes=fs.readFileSync(f.journalPath,'utf8')
  assert.equal(bytes,json(f.expectJournal)+'\n')
  assert.equal(fs.statSync(f.journalPath).mode&0o7777,0o600)
  assert.deepEqual(await inspect(f.inspectInput),f.receipt)
  assert.deepEqual(f.events.slice(-4),['observer:begin','observer:identity','resolve','observer:commit'])
  assert.equal(fs.readFileSync(f.journalPath,'utf8'),bytes)
})

test('unsigned preview, archive, changed scope, changed row set and shared signer never reach custody',async()=>{
  for(const alter of [
    input=>{delete input.review.expectedManifest.fenceEvidenceFingerprint},
    input=>{input.review.expectedManifest.action='archive_exact_legacy_terminal_rows_only'},
    input=>{input.destination.native.deploymentInstanceId=id(90);input.destination.nativeCommit='e'.repeat(40)},
    input=>{input.selection.outboxIds=[id(20),id(21),id(99)]},
    input=>{input.custody.anchor={keyId:'another-label',key:absenceKey.publicKey}},
    input=>{input.custody.anchor.keyId='absence'},
    input=>{input.controller.role=input.attestor.role},
    input=>{input.selection.approvalDigest='a'.repeat(64)},
  ]){
    const f=fixture();alter(f.applyInput)
    await assert.rejects(apply(f.applyInput),error=>error?.name==='NativeEmailPublicationHeld')
    assert.deepEqual(f.events,[]);assert.equal(fs.existsSync(f.journalPath),false)
  }
})

test('rejects bad initial custody or full-manifest drift before any journal or SQL',async()=>{
  for(const options of [{invalidCustodyAt:1},{drift:true}]){
    const f=fixture(options)
    await assert.rejects(apply(f.applyInput),options.drift?code('private_legacy_email_terminal_hold_manifest_drift'):
      code('legacy_dispatch_custody_binding'))
    assert.ok(!f.events.some(x=>x.includes(':begin')))
    assert.equal(fs.existsSync(f.journalPath),false)
  }
})

test('a replacement deployment instance requires fresh independently bound custody',async()=>{
  const f=fixture(),pinnedObserve=f.applyInput.observeCustody
  const pinnedTarget=makeDestination(f.applyInput.destination)
  f.applyInput.destination.native.deploymentInstanceId=id(95)
  assert.deepEqual(makeDestination(f.applyInput.destination).scope,pinnedTarget.scope)
  f.applyInput.observeCustody=(challenge,signal)=>pinnedObserve(Object.freeze({...challenge,
    targetFingerprint:pinnedTarget.targetFingerprint,storeBindingFingerprint:pinnedTarget.storeBindingFingerprint,
    ...makeCustodySelection({operationId:f.applyInput.selection.operationId,manifestDigest:f.applyInput.selection.manifestDigest,
      approvalDigest:f.applyInput.selection.approvalDigest,targetFingerprint:pinnedTarget.targetFingerprint})}),signal)
  await assert.rejects(apply(f.applyInput),code('legacy_dispatch_custody_binding'))
  assert.ok(!f.events.some(x=>x.includes(':begin')))
  assert.equal(fs.existsSync(f.journalPath),false)
})

test('rechecks nonce custody before the controller, and requires an authenticated after observation',async()=>{
  const before=fixture({invalidCustodyAt:2})
  await assert.rejects(apply(before.applyInput),code('legacy_dispatch_custody_binding'))
  assert.ok(before.events.includes('attest')&&!before.events.includes('controller:begin'))
  assert.deepEqual(await inspect(before.inspectInput),{state:'unknown'})
  const after=fixture({invalidCustodyAt:3})
  await assert.rejects(apply(after.applyInput),code('legacy_dispatch_custody_binding'))
  assert.ok(after.events.includes('hold'))
  assert.deepEqual(await inspect(after.inspectInput),after.receipt)
})

test('unknown commit outcome retains exact journal and does not apply again',async()=>{
  for(const lost of ['attestor','controller']){
    const f=fixture({lost})
    await assert.rejects(apply(f.applyInput),code('private_legacy_email_terminal_hold_direct_lane_failure'))
    const bytes=fs.readFileSync(f.journalPath,'utf8')
    const count=f.events.length
    await assert.rejects(apply(f.applyInput),code('legacy_email_terminal_hold_journal_already_reserved'))
    assert.equal(f.events.length,count,'retry does not even reopen custody')
    assert.equal(f.events.filter(x=>x==='attest').length,1)
    assert.equal(f.events.filter(x=>x==='hold').length,lost==='controller'?1:0)
    assert.deepEqual(await inspect(f.inspectInput),lost==='controller'?f.receipt:{state:'unknown'})
    assert.equal(fs.readFileSync(f.journalPath,'utf8'),bytes)
  }
})

test('rejects wrong physical, role, or restricted-login identity before that lane writes',async()=>{
  for(const [options,forbidden] of [[{roleMismatch:'attestor'},'attest'],[{storeMismatch:'controller'},'hold'],
    [{unrestricted:'controller'},'hold']]){
    const f=fixture(options)
    await assert.rejects(apply(f.applyInput),code('private_legacy_email_terminal_hold_physical_lane_identity'))
    assert.ok(!f.events.includes(forbidden))
  }
})

test('inspect refuses changed writer-role or count pins, write identities and unrelated receipts',async()=>{
  const f=fixture();await apply(f.applyInput)
  const events=f.events.length
  for(const input of [
    {...f.inspectInput,writerRoles:{...f.inspectInput.writerRoles,attestor:'spoofed_writer'}},
    {...f.inspectInput,pins:{...f.inspectInput.pins,expectedRows:2}},
    {...f.inspectInput,observer:{...f.inspectInput.observer,role:f.inspectInput.writerRoles.controller}},
  ])await assert.rejects(inspect(input),error=>error?.name==='NativeEmailPublicationHeld')
  assert.equal(f.events.length,events)
  for(const [options,reason] of [
    [{invalidReceipt:receipt=>({...receipt,rows:2})},'private_legacy_email_terminal_hold_receipt_count'],
    [{invalidReceipt:receipt=>({...receipt,operationId:id(91)})},'legacy_terminal_hold_receipt_invalid'],
    [{roleMismatch:'observer'},'private_legacy_email_terminal_hold_physical_lane_identity'],
  ]){
    const attempt=fixture(options);await apply(attempt.applyInput)
    await assert.rejects(inspect(attempt.inspectInput),code(reason))
  }
})

test('a closure that returns early cannot allow deferred writes',async()=>{
  const f=fixture({lateClosure:true})
  await assert.rejects(apply(f.applyInput),code('private_legacy_email_terminal_hold_closure_unverified'))
  await assert.rejects(f.early(),code('private_legacy_email_terminal_hold_closure_lost'))
  assert.ok(!f.events.some(x=>x.includes(':begin')))
  assert.equal(fs.existsSync(f.journalPath),false)
})

test('a direct transaction that returns before the identity check cannot allow a deferred write',async()=>{
  const f=fixture()
  let resolveIdentity,pending
  f.applyInput.attestor.transaction=async run=>{
    pending=run({query:sql=>{
      assert.match(sql,/pg_catalog\.pg_control_system\(\)/u)
      return new Promise(resolve=>{resolveIdentity=resolve})
    }})
    return {}
  }
  await assert.rejects(apply(f.applyInput),code('private_legacy_email_terminal_hold_direct_lane_result'))
  const p=f.applyInput.destination.postgres
  resolveIdentity({rows:[{database_name:p.database,database_oid:p.databaseOid,system_identifier:p.systemIdentifier,
    login:f.applyInput.attestor.role,role:f.applyInput.attestor.role,primary_server:true,read_only:'off',read_committed:true,restricted_login:true}]})
  await assert.rejects(pending,code('private_legacy_email_terminal_hold_direct_lane_lost'))
  assert.deepEqual(await inspect(f.inspectInput),{state:'unknown'})
})
