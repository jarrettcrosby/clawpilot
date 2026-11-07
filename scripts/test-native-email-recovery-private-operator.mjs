#!/usr/bin/env node
// Composition only. The separate joined test proves the real DAL/native
// commit; these fixtures prove CLI approval, exact selection, and custody order.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import test, {after} from 'node:test'

const require=createRequire(new URL('../app_src/package.json',import.meta.url)),ts=require('typescript')
function load(file,mocks={}){
  const m={exports:{}}
  const js=ts.transpileModule(fs.readFileSync(new URL(`../app_src/${file}.ts`,import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const localRequire=name=>Object.hasOwn(mocks,name)?mocks[name]:name==='server-only'?{}:require(name)
  new Function('require','module','exports',js)(localRequire,m,m.exports)
  return m.exports
}
const protocol=load('lib/crm/nativeEmailPublication')
const storeBinding=load('lib/crm/nativeEmailRecoveryStoreBinding',{'./nativeEmailPublication':protocol})
const verify=load('lib/crm/nativeEmailRecoveryCustodyProof',{'./nativeEmailPublication':protocol})
const release=load('lib/crm/legacyEmailRecoveryReleaseApproval',{'./nativeEmailPublication':protocol})
const json=value=>protocol.nativeEmailCanonicalJson(value)+'\n'
const digest=value=>crypto.createHash('sha256').update(value).digest('hex')
const hash=n=>digest(String(n)),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const keys=Array.from({length:3},()=>crypto.generateKeyPairSync('rsa',{modulusLength:3072}))
const pem=key=>key.export({format:'pem',type:key.type==='private'?'pkcs8':'spki'})
const sign=(proof,key)=>({proof,signature:crypto.sign('sha256',Buffer.from(protocol.nativeEmailCanonicalJson(proof),'ascii'),key).toString('base64')})
const root=fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(),'clawpilot-recovery-command-')))
after(()=>fs.rmSync(root,{recursive:true}))
const now=()=>Math.floor(Date.now()/1000)
const targetFingerprint=hash('native-target')

function fixture({rejectPhase,wrongReceipt=false,badInspect=false,wrongKey=false,wrongCa=false,stageAction,
  extraStageSecrets=false,extraStageConfig=false,wrongStageIntent=false}={}){
  const folder=fs.mkdtempSync(path.join(root,'case-')),events=[],nonces=new Set()
  const actualSelection={holdId:id(1),outboxId:id(2),nativeOperationId:hash(3),requestFingerprint:hash(4)}
  const [custody,dispatch,approvalKey]=keys
  const target={selected:{ownerEmail:'synthetic@example.invalid',workspaceId:id(13),pipelineId:id(12),
    connectionId:'synthetic-mailbox',messageIds:['123abc']},holdId:id(1),outboxId:id(2),retiredOutboxId:id(9),lockToken:id(14),
    retirementReceiptHash:hash('retired'),expectedOrganizations:{primaryNativeId:id(16),nativeIds:[id(15),id(16)]}}
  const stagePins={...actualSelection,retiredOutboxId:id(9),localId:id(10),nativeId:id(11),globalId:'gi1234567',
    pipelineId:id(12),workspaceId:id(13),sourceFingerprint:hash('source'),retirementReceiptHash:hash('retired'),activationReceiptHash:hash('activation')}
  const stageProof={version:1,purpose:'clawpilot-private-legacy-email-release-v1',keyId:'release',...stagePins,
    issuedAt:now(),expiresAt:now()+110}
  const approval=sign(stageProof,approvalKey.privateKey)
  const signed=release.verifyLegacyEmailRecoveryReleaseApproval({envelope:approval,
    operatorAnchor:{keyId:'release',key:approvalKey.publicKey},nowSeconds:now()})
  const stageReceipt={state:'staged',holdId:id(1),outboxId:id(2),retiredOutboxId:id(9),intentHash:signed.intentHash,receiptHash:hash('staged')}
  const stageApi=load('lib/crm/nativeEmailRecoveryPrivateStage',{'./nativeEmailPublication':protocol,
    './legacyEmailRecoveryReleaseApproval':release,'../persistence/crmLegacyEmailRecoveryStage':{
      async previewExactLegacyEmailRecoveryStagePrivately(tx,selected){
        assert.equal(typeof tx,'function');assert.deepEqual(selected,target);events.push('db:stage-preview')
        return {pins:stagePins,inspectionDigest:hash('stage inspection')}
      },
      async stageExactLegacyEmailRecoveryPrivately(tx,selected,verified){
        assert.equal(typeof tx,'function');assert.deepEqual(selected,target)
        release.assertVerifiedLegacyEmailRecoveryReleaseApproval(verified);assert.deepEqual(verified,signed)
        events.push('db:stage');return stageReceipt
      },
      async resolveExactLegacyEmailStagePrivately(tx,retained){
        assert.equal(typeof tx,'function');assert.deepEqual(retained,{holdId:id(1),outboxId:id(2),retiredOutboxId:id(9),intentHash:signed.intentHash})
        events.push('db:stage-inspect');return stageReceipt
      },
    }})
  const selection=stageAction==='stage-preview'?{holdId:id(1),outboxId:id(2),...stageApi.nativeEmailRecoveryStagePreviewPins(target)}:actualSelection
  const native={fixture:true,mariaStoreFingerprint:hash('native database')}
  const cfg={version:1,purpose:stageAction?'clawpilot-private-native-email-staging':'clawpilot-private-native-email-recovery',selection,native,
    postgres:{host:'127.0.0.1',port:5432,database:'fixture',user:'fixture_recovery',systemIdentifier:'12345678',databaseOid:'16',tlsCaSha256:hash('synthetic-ca')},
    ...(stageAction?{target,intentHash:stageAction==='stage-preview'?null:wrongStageIntent?hash('wrong stage intent'):signed.intentHash,
      ...(extraStageConfig?{dispatch:{keyId:'unexpected-dispatch',publicKey:pem(dispatch.publicKey)}}:{})}:
      {leaseOwner:id(7),railway:{binary:'/usr/bin/true',binarySha256:hash('binary'),identityFile:'/tmp/synthetic-identity'},
        dispatch:{keyId:'dispatch',publicKey:pem(dispatch.publicKey)}}),
    release:{keyId:'release',publicKey:pem(approvalKey.publicKey)},
    custody:{keyId:'custody',publicKey:pem(custody.publicKey),socketPath:'/tmp/not-connected/custody.sock',uid:0,
      fenceEpoch:id(8),expiresAt:now()+180,producerInventoryHash:hash('producer-set')}}
  const write=(name,data)=>{const target=path.join(folder,name);fs.writeFileSync(target,json(data),{flag:'wx',mode:0o600});return target}
  const config=write('config',cfg),secrets=write('secrets',{postgresPassword:'synthetic-only',postgresTlsCa:wrongCa?'wrong-ca':'synthetic-ca',
    ...(!stageAction||extraStageSecrets?{dispatchPrivateKey:pem((wrongKey?custody:dispatch).privateKey),
      transportAttestationKey:Buffer.alloc(32,3).toString('base64')}:{})})
  const reviewed=stageAction==='stage-preview'||stageAction==='stage-inspect'?path.join(folder,'absent-approval'):write('approval',approval)
  const configHash=digest(json(cfg))
  const mocks={
    '../lib/crm/nativeEmailRecoveryStoreBinding':storeBinding,
    '../lib/crm/nativeEmailPublication':protocol,'../lib/crm/nativeEmailRecoveryCustodyProof':verify,
    '../lib/crm/legacyEmailRecoveryReleaseApproval':release,'../lib/crm/nativeEmailRecoveryPrivateStage':stageApi,
    '../lib/crm/nativeEmailAccountRepairOperator':{
      isNativeEmailAccountRepairAction:action=>['repair-preview','repair','repair-inspect'].includes(action),
      runNativeEmailAccountRepairPrivateOperator:async input=>{
        events.push('repair-handler')
        return {action:input.action,config:input.readConfig(),configHash:input.configHash,explicitOperation:input.explicitOperation,
          approval:input.action==='repair'?input.readApproval():undefined}
      },
    },
    '../lib/crm/nativeEmailArchiveOperator':{
      isNativeEmailArchiveAction:action=>['archive','archive-inspect'].includes(action),
      runNativeEmailArchivePrivateOperator:async input=>{
        events.push('archive-handler')
        return {action:input.action,config:input.readConfig(),configHash:input.configHash,explicitOperation:input.explicitOperation,
          approval:input.action==='archive'?input.readApproval():undefined}
      },
    },
    '../lib/crm/nativeEmailRecoveryPrivatePostgres':{createNativeEmailRecoveryPrivatePostgres:()=>({
      close:async()=>events.push('db:closed'),transaction:async fn=>{events.push('db:read');return fn({query:async()=>({rows:[{
        enabled:true,active_operation_id:null,active_transition_id:null,active_initial_enrollment_id:null,
        state:badInspect?'unknown':'committed',released_operation_id:selection.nativeOperationId,release_fingerprint:selection.requestFingerprint,
        admission_fingerprint:selection.requestFingerprint,has_receipt:true}]})})}})},
    '../lib/crm/nativeEmailRecoveryCliTransport':{
      nativeEmailRecoveryCliTargetFingerprint:target=>{assert.deepEqual(target,native);return targetFingerprint},
      createNativeEmailRecoveryCliTransport:()=>{assert.equal(stageAction,undefined,'stage must not initialize transport');return {targetFingerprint}},
    },
    '../lib/crm/nativeEmailRecoveryDispatchPermit':{createNativeEmailRecoveryDispatchSigner:()=>{
      assert.equal(stageAction,undefined,'stage must not initialize a dispatch signer');return {}
    }},
    '../lib/persistence/crmNativeEmailPublication':{createPrivateLegacyEmailRecoveryPersistence:options=>{
      assert.equal(stageAction,undefined,'stage must not initialize publication persistence');return options
    }},
    '../lib/crm/nativeEmailRecoveryCustodySocket':{requestNativeEmailRecoveryCustody:async({challenge})=>{
      assert.equal(challenge.controllerConfigHash,configHash);assert.equal(challenge.operationId,selection.nativeOperationId)
      assert.equal(challenge.requestFingerprint,selection.requestFingerprint)
      const {database,databaseOid,systemIdentifier}=cfg.postgres
      assert.equal(challenge.storeBindingFingerprint,storeBinding.nativeEmailRecoveryStoreBindingFingerprint({targetFingerprint,
        postgresStoreFingerprint:storeBinding.nativeEmailPostgresStoreFingerprint({database,databaseOid,systemIdentifier}),
        mariaStoreFingerprint:native.mariaStoreFingerprint}))
      assert.ok(!nonces.has(challenge.nonce));nonces.add(challenge.nonce);events.push(`custody:${challenge.phase}`)
      if(rejectPhase===challenge.phase)throw Error('fixture_custody_lost')
      return sign({...challenge,purpose:'clawpilot-native-email-recovery-custody-v2',keyId:'custody',issuedAt:now(),retainedClosure:true,
        postgresObservationHash:hash('pg-observation'),mariaObservationHash:hash('maria-observation'),
        ...(wrongReceipt?{producerInventoryHash:hash('wrong-inventory')}:{})},custody.privateKey)
    }},
    '../lib/crm/nativeEmailRecoveryMaintenanceOperator':{createNativeEmailRecoveryMaintenanceOperator:({persistence})=>{
      const run=action=>persistence.maintenanceDispatch.withVerifiedFence(async fence=>{
        assert.equal(fence.targetFingerprint,targetFingerprint);assert.deepEqual(persistence.selection,selection)
        assert.equal(!!persistence.initialApproval,action==='publish');events.push(`native:${action}`);return {synchronized:true}
      });return {publish:()=>run('publish'),resolve:()=>run('resolve')}
    }},
  }
  const {runNativeEmailRecoveryPrivateOperator:run}=load('ops/native-email-recovery',mocks)
  const args=action=>[`--action=${action}`,`--config=${config}`,`--config-sha256=${configHash}`,`--secrets=${secrets}`,
    ...(['publish','resolve','stage'].includes(action)?[`--approve-operation=${selection.nativeOperationId}`]:[]),
    ...(['publish','stage'].includes(action)?[`--approval=${reviewed}`,`--approval-sha256=${digest(json(approval))}`]:[])]
  return {run,args,events,config,reviewed,stagePins,stageReceipt,selection,cfg}
}

test('repair CLI routes only its three named actions and separates UUID approval from normal SHA pins',async()=>{
  const f=fixture(),mutating=f.args('stage').map(arg=>arg==='--action=stage'?'--action=repair':
    arg.startsWith('--approve-operation=')?`--approve-operation=${id(99)}`:arg)
  const result=await f.run(mutating)
  assert.equal(result.action,'repair');assert.equal(result.explicitOperation,id(99));assert.deepEqual(result.config,f.cfg)
  assert.equal(result.approval.proof.purpose,'clawpilot-private-legacy-email-release-v1') // Handler's separate verifier rejects that proof.
  assert.deepEqual(f.events,['repair-handler'])
  for(const action of ['repair-preview','repair-inspect']){
    const read=f.args(action)
    assert.equal((await f.run(read)).action,action)
    await assert.rejects(f.run([...read,`--approve-operation=${id(99)}`]),/unexpected_approval/u)
    await assert.rejects(f.run([...read,`--approval=${f.reviewed}`]),/unexpected_approval/u)
  }
  await assert.rejects(f.run(f.args('stage').map(arg=>arg==='--action=stage'?'--action=repair':arg)),/explicit_operation_approval/u)
  await assert.rejects(f.run(mutating.filter(arg=>!arg.startsWith('--approval-sha256='))),/release_approval_pin/u)
})

test('archive CLI requires explicit UUID and pinned review for writes; inspection takes no approval',async()=>{
  const f=fixture(),args=f.args('stage').map(arg=>arg==='--action=stage'?'--action=archive':
    arg.startsWith('--approve-operation=')?`--approve-operation=${id(98)}`:arg)
  const result=await f.run(args)
  assert.equal(result.action,'archive');assert.equal(result.explicitOperation,id(98));assert.deepEqual(result.config,f.cfg)
  assert.deepEqual(f.events,['archive-handler'])
  assert.equal((await f.run(f.args('archive-inspect'))).action,'archive-inspect')
  await assert.rejects(f.run([...f.args('archive-inspect'),`--approve-operation=${id(98)}`]),/unexpected_approval/u)
  await assert.rejects(f.run([...f.args('archive-inspect'),`--approval=${f.reviewed}`]),/unexpected_approval/u)
  await assert.rejects(f.run(args.filter(arg=>!arg.startsWith('--approve-operation='))),/explicit_operation_approval/u)
  await assert.rejects(f.run(args.filter(arg=>!arg.startsWith('--approval-sha256='))),/release_approval_pin/u)
})

test('one signed publish and exact resolve require distinct before/after challenges; inspect never invokes native',async()=>{
  for(const action of ['publish','resolve','inspect']){
    const f=fixture(),result=await f.run(f.args(action))
    assert.equal(result.action,action);assert.match(result.observationsDigest,/^[0-9a-f]{64}$/u)
    assert.deepEqual(f.events,action==='inspect'?['custody:before','db:read','custody:after','db:closed']:
      ['custody:before','custody:before',`native:${action}`,'custody:after','custody:after','db:closed'])
  }
})
test('wrong custody signature scope cannot touch SQL or run native',async()=>{
  const f=fixture({wrongReceipt:true});await assert.rejects(f.run(f.args('publish')))
  assert.deepEqual(f.events,['custody:before','db:closed'])
})
test('losing custody after the attempt suppresses success and does not retry',async()=>{
  const f=fixture({rejectPhase:'after'});await assert.rejects(f.run(f.args('publish')),/fixture_custody_lost/u)
  assert.deepEqual(f.events,['custody:before','custody:before','native:publish','custody:after','custody:after','db:closed'])
})
test('operation approval, protected files, signer binding and inconsistent terminal reads fail closed',async()=>{
  const f=fixture(),wrong=f.args('resolve').map(arg=>arg.startsWith('--approve-operation=')?`--approve-operation=${hash('wrong')}`:arg)
  await assert.rejects(f.run(wrong),/explicit_operation_approval/u);assert.deepEqual(f.events,[])
  fs.chmodSync(f.config,0o644);await assert.rejects(f.run(f.args('inspect')),/file_protection/u);assert.deepEqual(f.events,[])
  const bad=fixture({wrongKey:true});await assert.rejects(bad.run(bad.args('resolve')),/dispatch_key_mismatch/u);assert.deepEqual(bad.events,[])
  const badCa=fixture({wrongCa:true});await assert.rejects(badCa.run(badCa.args('resolve')),/database_ca_pin/u);assert.deepEqual(badCa.events,[])
  const inspect=fixture({badInspect:true});await assert.rejects(inspect.run(inspect.args('inspect')),/inspect_scope/u)
  assert.deepEqual(inspect.events,['custody:before','db:read','custody:after','db:closed'])
})

test('exact staging actions use separate DB-only configuration, one fenced action and no native dispatch',async()=>{
  for(const stageAction of ['stage-preview','stage','stage-inspect']){
    const f=fixture({stageAction})
    if(stageAction!=='stage')assert.equal(fs.existsSync(f.reviewed),false)
    const result=await f.run(f.args(stageAction))
    assert.equal(result.action,stageAction);assert.equal(result.operationId,f.selection.nativeOperationId)
    assert.equal(result.successfulObservations,4);assert.match(result.observationsDigest,/^[0-9a-f]{64}$/u)
    assert.deepEqual(result.result,stageAction==='stage-preview'?{pins:f.stagePins,inspectionDigest:hash('stage inspection')}:f.stageReceipt)
    assert.deepEqual(f.events,['custody:before','custody:before',`db:${stageAction}`,'custody:after','custody:after','db:closed'])
  }
})
test('CLI rejects stage/publish scope crossovers and dispatch credentials before opening the fence',async()=>{
  const publish=fixture();await assert.rejects(publish.run(publish.args('stage')),/shape|config_scope/u)
  assert.deepEqual(publish.events,[])
  const staged=fixture({stageAction:'stage'});await assert.rejects(staged.run(staged.args('publish')),/shape|config_scope/u)
  assert.deepEqual(staged.events,[])
  const preview=fixture({stageAction:'stage-preview'});await assert.rejects(preview.run(preview.args('stage-inspect')),/stage_intent/u)
  assert.deepEqual(preview.events,[])
  const excess=fixture({stageAction:'stage',extraStageSecrets:true});await assert.rejects(excess.run(excess.args('stage')),/shape|secret_shape/u)
  assert.deepEqual(excess.events,[])
  const config=fixture({stageAction:'stage',extraStageConfig:true});await assert.rejects(config.run(config.args('stage')),/shape/u)
  assert.deepEqual(config.events,[])
})
test('a stage write requires both the explicit operation and signed retained intent, and never retries after lost custody',async()=>{
  const staged=fixture({stageAction:'stage'})
  await assert.rejects(staged.run(staged.args('stage').filter(arg=>!arg.startsWith('--approve-operation='))),/explicit_operation_approval/u)
  await assert.rejects(staged.run(staged.args('stage').filter(arg=>!arg.startsWith('--approval='))),/release_approval_pin/u)
  assert.deepEqual(staged.events,[])
  const wrong=fixture({stageAction:'stage',wrongStageIntent:true});await assert.rejects(wrong.run(wrong.args('stage')),/stage_intent/u)
  assert.deepEqual(wrong.events,[])
  const lost=fixture({stageAction:'stage',rejectPhase:'after'});await assert.rejects(lost.run(lost.args('stage')),/fixture_custody_lost/u)
  assert.deepEqual(lost.events,['custody:before','custody:before','db:stage','custody:after','custody:after','db:closed'])
})
