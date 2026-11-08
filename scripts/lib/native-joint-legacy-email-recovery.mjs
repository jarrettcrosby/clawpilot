// Local joined fixture wiring only. PostgreSQL and native responses remain real;
// synthetic authority/seeding belongs to the guarded parent rehearsal.
import assert from 'node:assert/strict'
import { constants, createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {openNativeJointRecoveryPostgresRoles} from './native-joint-recovery-postgres-role.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../app_src/package.json', import.meta.url))
const entries = Object.freeze({
  exactPublication: 'app_src/lib/persistence/crmExactEmailPublication.ts',
  crm: 'app_src/lib/persistence/crm.ts',
  persistence: 'app_src/lib/persistence/crmNativeEmailPublication.ts',
  retirement: 'app_src/lib/persistence/crmLegacyEmailRetirement.ts',
  retirementApproval: 'app_src/lib/crm/legacyEmailRetirementApproval.ts',
  accountRepair: 'app_src/lib/persistence/crmLegacyEmailAccountRepair.ts',
  recoveryStage: 'app_src/lib/persistence/crmLegacyEmailRecoveryStage.ts',
  heldStage: 'app_src/lib/persistence/crmHeldOriginalRecoveryStage.ts',
  terminalHold: 'app_src/lib/persistence/crmLegacyEmailTerminalHold.ts',
  heldApproval: 'app_src/lib/crm/legacyHeldEmailRecoveryApproval.ts',
  releaseApproval: 'app_src/lib/crm/legacyEmailRecoveryReleaseApproval.ts',
  maintenanceSigner: 'app_src/lib/crm/nativeEmailRecoveryDispatchPermit.ts',
  maintenanceOperator: 'app_src/lib/crm/nativeEmailRecoveryMaintenanceOperator.ts',
  maintenanceCli: 'app_src/lib/crm/nativeEmailRecoveryCliTransport.ts',
  maintenanceDuplex: 'app_src/lib/crm/nativeEmailRecoveryDuplexRunner.ts',
  worker: 'app_src/lib/crm/nativeEmailPublicationWorker.ts',
  transport: 'app_src/lib/crm/nativeEmailPublicationTransport.ts',
  protocol: 'app_src/lib/crm/nativeEmailPublication.ts',
})
const postgres = 'app_src/lib/persistence/postgres.ts'
const allowedExternal = new Set(['crypto','fs','next/headers','node:child_process','node:crypto','node:fs','node:net','node:path','node:util','pg','server-only','sharp'])
const compiled = new Map()
const sha = x => createHash('sha256').update(x).digest('hex')
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const nativeUserId = /^[a-z0-9][a-z0-9-]{0,63}(?![\s\S])/iu
const hash = /^[0-9a-f]{64}$/u

export const JOINT_LEGACY_EMAIL_NATIVE_IDENTITY = Object.freeze({
  suiteCrmId: '6d7bbd67-dde9-4e53-89fd-29a86017d23a', globalId: 'gi9799999',
})
const fixtureBody='Synthetic recovery body: one native commit.'
export const JOINT_LEGACY_EMAIL_BODY_SHA256=sha(fixtureBody)

function resolveLocal(parent, name) {
  const base = name.startsWith('@/') ? `app_src/${name.slice(2)}` : path.posix.join(path.posix.dirname(parent), name)
  assert.ok(base.startsWith('app_src/'), 'Recovery fixture import escaped app_src')
  const found = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`]
    .find(candidate => existsSync(path.join(root,candidate)) && statSync(path.join(root,candidate)).isFile())
  assert.ok(found, `Unresolved recovery fixture source: ${base}`)
  return found
}

function collect(file, ts) {
  if (compiled.has(file)) return
  const source = readFileSync(path.join(root,file),'utf8')
  const code = ts.transpileModule(source,{fileName:file.endsWith('.mjs')?`${file}.ts`:file,
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  compiled.set(file,{code,sourceSha256:sha(source)})
  const syntax = ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text==='require') {
      assert.ok(node.arguments.length===1 && ts.isStringLiteral(node.arguments[0]),'Dynamic recovery fixture imports are not admitted')
      const name=node.arguments[0].text
      if (name.startsWith('.') || name.startsWith('@/')) collect(resolveLocal(file,name),ts)
      else assert.ok(allowedExternal.has(name),`Unreviewed recovery fixture dependency: ${name}`)
    }
    ts.forEachChild(node,visit)
  }
  visit(syntax)
}

/** Parent hashes these exact dependencies into its rehearsal evidence before
 * starting resources; load also rejects source drift after transpilation. */
export function nativeJointLegacyEmailRecoverySources() {
  const ts = require('typescript')
  for (const file of Object.values(entries)) collect(file,ts)
  return Object.freeze([...compiled.keys(),'scripts/lib/native-joint-legacy-email-recovery.mjs',
    'scripts/lib/native-joint-recovery-postgres-role.mjs'].sort())
}

export function loadNativeJointLegacyEmailRecoveryApp({query,withTransaction,getPostgresPool}) {
  assert.ok([query,withTransaction,getPostgresPool].every(fn=>typeof fn==='function'))
  nativeJointLegacyEmailRecoverySources()
  const modules=new Map()
  const fixtureProcess=Object.freeze({env:Object.freeze({NODE_ENV:'test',TZ:'UTC',CLAWPILOT_STORAGE:'postgres',
    CLAWPILOT_DB_FALLBACK_TO_FILE:'false',DATABASE_URL:'postgresql://synthetic.invalid/never-connected'}),cwd:()=>root,
    geteuid:()=>process.geteuid()})
  // The real runner needs local process-group signals. Its fixture child is
  // Docker on an exact Unix socket, not Railway, so no Railway credentials,
  // SSH agent, or Docker configuration overrides reach that child.
  const localDuplexProcess=Object.freeze({platform:process.platform,kill:process.kill.bind(process),
    env:Object.freeze({PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR})})
  const noFetch=()=>{throw Error('Joined recovery uses only its bounded local fixture transport')}
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports
    const retained=compiled.get(file)
    assert.ok(retained&&sha(readFileSync(path.join(root,file),'utf8'))===retained.sourceSha256,'Recovery fixture source drift')
    const module={exports:{}};modules.set(file,module)
    // Same realm preserves the production canonicalizer's strict plain-object
    // checks when it receives actual PostgreSQL objects and real receipts.
    new Function('require','module','exports','process','fetch',retained.code)(name=>{
      if (name.startsWith('.') || name.startsWith('@/')) return load(resolveLocal(file,name))
      assert.ok(allowedExternal.has(name),'Unexpected recovery fixture dependency')
      return name==='server-only'?require('next/dist/compiled/server-only/empty.js'):require(name)
    },module,module.exports,file===entries.maintenanceDuplex?localDuplexProcess:fixtureProcess,noFetch)
    if (file===postgres) Object.assign(module.exports,{query,withTransaction,getPostgresPool})
    return module.exports
  }
  return Object.freeze(Object.fromEntries(Object.entries(entries).map(([k,file])=>[k,load(file)])))
}

/** Use the actual application transport protocol against one loopback-only
 * PHP bridge. An optional response loss occurs AFTER actual native COMMIT. */
export function createNativeJointLegacyEmailClient({transport,invokeNative,assertOutsideTransaction,target,deadline,loseCommittedResponse=false}) {
  assert.ok(transport&&typeof transport.nativeEmailPublicationBridge==='function'&&typeof transport.verifyNativeEmailPreparation==='function')
  assert.ok(typeof invokeNative==='function'&&typeof assertOutsideTransaction==='function'&&Number.isSafeInteger(deadline))
  const {suiteCrmId,globalId,localId,pipelineId,workspaceId,ownerNativeId,operationId}=target
  assert.equal(suiteCrmId,JOINT_LEGACY_EMAIL_NATIVE_IDENTITY.suiteCrmId);assert.equal(globalId,JOINT_LEGACY_EMAIL_NATIVE_IDENTITY.globalId)
  assert.ok([localId,pipelineId,workspaceId].every(x=>typeof x==='string'&&uuid.test(x)))
  assert.ok(typeof ownerNativeId==='string'&&nativeUserId.test(ownerNativeId))
  assert.ok(typeof operationId==='string'&&hash.test(operationId))
  const calls=[];let lostResponse=false
  const request=async (route,init)=>{
    assert.ok(Date.now()<deadline,'Joined recovery native deadline exceeded')
    assertOutsideTransaction()
    const match=/^\/Api\/V8\/custom\/clawpilot-email-publication\/(prepare|publish|resolve)$/u.exec(route)
    assert.ok(match&&init?.method==='POST'&&typeof init.body==='string'&&Buffer.byteLength(init.body)<=32768,'Unexpected joined recovery native request')
    const action=match[1],command=JSON.parse(init.body)
    assert.equal(command.mode,'publish');assert.equal(command.expectedRecordFingerprint,null)
    assert.deepEqual([command.suiteCrmId,command.globalId,command.localId,command.pipelineId,command.workspaceId,command.operationId],
      [suiteCrmId,globalId,localId,pipelineId,workspaceId,operationId])
    assert.equal(command.projection?.attributes?.assigned_user_id,ownerNativeId)
    assert.equal(command.projection?.attributes?.global_id_c,globalId)
    assert.ok(!calls.some(c=>c.action===action),'A joined recovery action may be dispatched only once')
    assert.equal(action==='prepare'?0:action==='publish'?1:2,calls.length,'Joined recovery action order changed')
    init.signal?.throwIfAborted()
    const call={action,commandSha256:sha(init.body),nativeResponseSha256:null,lostCommittedResponse:false};calls.push(call)
    const value=await invokeNative(action,init.body)
    assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'Actual native response required')
    call.nativeResponseSha256=sha(JSON.stringify(value))
    if (action==='publish'&&loseCommittedResponse) {
      assert.equal(value.operationId,operationId);assert.equal(value.state,'committed');assert.equal(value.replayed,false)
      lostResponse=true;call.lostCommittedResponse=true
      throw Error('Deliberate loss after one actual synthetic native commit')
    }
    init.signal?.throwIfAborted()
    return value
  }
  const client=Object.freeze({...transport.nativeEmailPublicationBridge(request),prepare:command=>transport.verifyNativeEmailPreparation(command,request)})
  return Object.freeze({client,evidence:()=>({calls:calls.map(x=>({...x})),lostResponse})})
}

const coreCounts={emails:0,custom:0,global:0,text:0,groups:0,managed:0,operations:0}
const exactSignature=(protocol,proof,key)=>sign('sha256',Buffer.from(protocol.nativeEmailCanonicalJson(proof),'ascii'),
  {key,padding:constants.RSA_PKCS1_PADDING}).toString('base64')

/** Exercise the actual private operator through the bounded exchange supplied
 * by the parent. It owns the real CLI, independently observed writer fence,
 * target binding and public-route denial checks, not this helper. */
export function createNativeJointRecoveryMaintenanceClient({app,maintenance,target,deadline,assertOutsideTransaction,inspectNative}) {
  assert.ok(maintenance&&typeof maintenance.withVerifiedFence==='function'&&typeof maintenance.exchange==='function'
    &&typeof maintenance.exchangePublish==='function')
  const signer=app.maintenanceSigner.createNativeEmailRecoveryDispatchSigner(maintenance.signer)
  const targetFingerprint=maintenance.signer.targetFingerprint
  const maintenanceDispatch=Object.freeze({signer,withVerifiedFence:maintenance.withVerifiedFence})
  const calls=[];let lostResponse=false,prepareStayedUnpublished=false
  const expectedActions=['prepare','prepare','publish','resolve']
  const checkRequest=request=>{
    assert.ok(Date.now()<deadline,'Joined maintenance recovery deadline exceeded')
    assertOutsideTransaction()
    const {command}=request
    assert.equal(command.version,2);assert.equal(command.mode,'publish');assert.equal(command.expectedRecordFingerprint,null)
    assert.deepEqual([command.suiteCrmId,command.globalId,command.localId,command.pipelineId,command.workspaceId,command.operationId,
      command.projection?.attributes?.assigned_user_id,command.projection?.attributes?.global_id_c],
    [target.suiteCrmId,target.globalId,target.localId,target.pipelineId,target.workspaceId,target.operationId,
      target.ownerNativeId,target.globalId])
    assert.equal(request.requestFingerprint,target.requestFingerprint)
  }
  const signedCall=(action,request,permit)=>{
    assertOutsideTransaction()
    assert.equal(action,expectedActions[calls.length],'Joined maintenance recovery action order changed')
    assert.equal(permit.proof.action,action)
    assert.equal(permit.proof.commandHash,request.commandHash)
    assert.equal(permit.proof.requestFingerprint,target.requestFingerprint)
    assert.equal(permit.proof.approvalHash,target.approvalHash)
    assert.equal(permit.proof.targetFingerprint,targetFingerprint)
    const call={action,commandSha256:request.commandHash,permitSha256:app.protocol.nativeEmailDigest(permit),
      nativeResponseSha256:null,lostCommittedResponse:false};calls.push(call)
    return call
  }
  const completeCall=async (call,request,value)=>{
    assertOutsideTransaction()
    const {action}=call
    assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'Actual native maintenance response required')
    call.nativeResponseSha256=sha(JSON.stringify(value))
    if (action==='prepare') {
      assert.deepEqual(await inspectNative(null),coreCounts,'Private prepare must not publish or register a native operation')
      prepareStayedUnpublished=true
    }
    if (action==='publish'||action==='resolve') {
      const receipt=app.transport.verifyNativeEmailPublicationReceipt(request,value)
      assert.equal(receipt.operationId,target.operationId);assert.equal(receipt.state,'committed')
      assert.equal(receipt.replayed,action==='resolve')
    }
    if (action==='publish') {
      // The parent exchange already invoked the native CLI and returned the
      // exact, valid committed receipt. Simulate losing that response here.
      lostResponse=true;call.lostCommittedResponse=true
      throw Error('Deliberate loss after one actual synthetic maintenance commit')
    }
    return value
  }
  const exchange=async packet=>{
    const {request,permit}=packet,{action}=permit.proof
    checkRequest(request);assert.ok(['prepare','resolve'].includes(action))
    const call=signedCall(action,request,permit)
    return completeCall(call,request,await maintenance.exchange(packet))
  }
  const exchangePublish=async ({request,fence,authorize})=>{
    checkRequest(request);assert.equal(fence.targetFingerprint,targetFingerprint)
    let call
    const value=await maintenance.exchangePublish({request,fence,authorize:async()=>{
      assert.equal(call,undefined,'Private publish may authorize only once')
      const permit=await authorize();call=signedCall('publish',request,permit);return permit
    }})
    assert.ok(call,'Successful private publish must have obtained its permit after readiness')
    return completeCall(call,request,value)
  }
  return Object.freeze({maintenanceDispatch,exchange,exchangePublish,evidence:()=>({calls:calls.map(x=>({...x})),lostResponse,privateCliInvoked:true,
    prepareStayedUnpublished})})
}

async function repairNativeJointLegacyEmail({app,query,withTransaction,getPostgresPool,assertNativeAbsent,target}) {
  const attestor='crm_joint_account_repair_attestor',repair='crm_joint_account_repair_writer'
  const pwd=sha(randomUUID()),pg=getPostgresPool().options
  assert.equal(pg.host,'127.0.0.1');assert.equal(pg.database,'initial_joint_fixture')
  for(const role of [attestor,repair])await query(`CREATE ROLE ${role} LOGIN PASSWORD '${pwd}' NOSUPERUSER NOCREATEROLE`)
  await query(`GRANT USAGE ON SCHEMA crm_legacy_email_retirement TO ${attestor},${repair};
    GRANT INSERT ON crm_legacy_email_retirement.account_repair_approvals TO ${attestor};
    GRANT EXECUTE ON FUNCTION crm_legacy_email_retirement.preview_account_repair(jsonb) TO ${attestor};
    GRANT EXECUTE ON FUNCTION crm_legacy_email_retirement.repair_account_links(uuid,jsonb,text),
      crm_legacy_email_retirement.read_account_repair(uuid,text) TO ${repair}`)
  const {Pool}=require('pg'),pools=[attestor,repair].map(user=>new Pool({host:pg.host,port:pg.port,database:pg.database,
    user,password:pwd,max:1,ssl:false,statement_timeout:10000}))
  const transact=pool=>async fn=>{const client=await pool.connect();try{
    await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}}
  const [attestTransaction,repairTransaction]=pools.map(transact)
  try{
    await assertNativeAbsent()
    const preview=await app.accountRepair.previewExactLegacyEmailAccountRepairPrivately(attestTransaction,target)
    const keyId='joined-synthetic-account-repair',keypair=generateKeyPairSync('rsa',{modulusLength:3072})
    const now=Number((await query('SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS s')).rows[0].s)
    const expected={operationId:randomUUID(),reviewDigest:preview.reviewDigest,fenceEpoch:randomUUID(),targetFingerprint:sha('isolated repair fixture')}
    const proof={version:1,purpose:'clawpilot-private-legacy-email-account-repair-v1',keyId,...expected,issuedAt:now,expiresAt:now+120}
    let pins,observations=0
    const repaired=await app.accountRepair.repairExactLegacyEmailAccountsPrivately({target,authorization:{expected,
      operatorAnchor:{keyId,key:keypair.publicKey},envelope:{proof,signature:exactSignature(app.protocol,proof,keypair.privateKey)}}},
    {expectedRoles:{attestor,repair},attestTransaction,repairTransaction,withLiveFence:async(scope,run)=>{
      assert.deepEqual(scope,expected);await assertNativeAbsent();observations++
      try{return await run()}finally{await assertNativeAbsent();observations++}
    },retainResolutionPins:async value=>{
      pins=value
      assert.deepEqual(await app.accountRepair.inspectExactLegacyEmailAccountRepairPrivately(repairTransaction,pins),{state:'unknown'})
    }})
    assert.equal(observations,2)
    assert.deepEqual(await app.accountRepair.inspectExactLegacyEmailAccountRepairPrivately(repairTransaction,pins),repaired)
    assert.equal(repaired.state,'committed')
    const retained=(await withTransaction(async tx=>tx.query(`SELECT
      (SELECT count(*)::int FROM crm_interactions WHERE id=$1) AS emails,
      (SELECT count(*)::int FROM sync_outbox WHERE aggregate_type='crm_interactions' AND aggregate_id=$1::text) AS jobs,
      r.original_source->>'organization_id' AS old_primary,
      i.organization_id::text AS new_primary,
      o.status, o.attempts, o.payload#>>'{attributes,parent_id}' AS native_parent
      FROM crm_legacy_email_retirement.account_repairs r JOIN crm_interactions i ON i.id=r.local_id
      JOIN sync_outbox o ON o.id=r.outbox_id WHERE r.operation_id=$2`,[target.localId,pins.operationId]))).rows
    assert.deepEqual(retained,[{emails:1,jobs:1,old_primary:target.oldPrimaryId,new_primary:target.newPrimaryId,
      status:'dead',attempts:8,native_parent:target.newPrimaryNativeId}])
    return {operationId:pins.operationId,reviewDigest:pins.reviewDigest,receiptHash:repaired.receiptHash,
      directSeparatedPostgresLogins:true,preservedSingleTerminalJob:true,checkedNativeAbsenceBeforeAndAfter:true}
  }finally{await Promise.all(pools.map(pool=>pool.end()))}
}

/** Synthetic source construction before RootA; exercise the real archive
 * controller using two restricted logins. The isolated container check is not
 * an attestation that any production writer is paused. */
export async function archiveNativeJointLegacyEmail({query,withTransaction,getPostgresPool,authority,assertNativeAbsent,related,repairFirst=false,seedOnly=false}) {
  assert.ok(!seedOnly||!repairFirst,'The same-original fixture must begin with already reviewed links')
  const {actorEmail,pipelineId,workspaceId,ownerNativeId}=authority
  assert.match(actorEmail,/^[^@]+@[^@]+\.invalid$/u)
  assert.ok([pipelineId,workspaceId].every(x=>typeof x==='string'&&uuid.test(x)))
  assert.ok(typeof ownerNativeId==='string'&&nativeUserId.test(ownerNativeId))
  assert.ok(Array.isArray(related)&&related.length===2&&related.every(row=>uuid.test(row.accountId)&&uuid.test(row.contactId)))
  const accounts=related.map(row=>row.accountId).sort()
  assert.equal(new Set(related.flatMap(row=>[row.accountId,row.contactId])).size,4)
  const originalPairs=repairFirst?[related[1]]:related
  const originalAccounts=originalPairs.map(row=>row.accountId).sort(),contacts=originalPairs.map(row=>row.contactId).sort()
  const localPairs=related.map(()=>({organizationId:randomUUID(),contactId:randomUUID()}))
  const contactAccounts=contacts.map(contactId=>related.find(row=>row.contactId===contactId))
  const relationships=[...originalAccounts.map(relatedBeanId=>({linkFieldName:'accounts',relatedModuleName:'Accounts',relatedBeanId})),
    ...contacts.map(relatedBeanId=>({linkFieldName:'contacts',relatedModuleName:'Contacts',relatedBeanId}))]
  const app=loadNativeJointLegacyEmailRecoveryApp({query,withTransaction,getPostgresPool})
  const {suiteCrmId,globalId}=JOINT_LEGACY_EMAIL_NATIVE_IDENTITY
  const [localId,retiredOutboxId,mailboxId,sourceId]=Array.from({length:4},()=>randomUUID())
  const connectionId='joint-legacy-recovery-'+randomUUID(),messageId='a'+randomUUID().replaceAll('-',''),threadId='b'+randomUUID().replaceAll('-','')
  const evidence={fixtureOnly:true,kind:'synthetic_canonical_inbox_receipt',messageId,threadId,body:fixtureBody,
    from:'Synthetic Sender <joint-recovery-sender@example.invalid>',to:'Synthetic Inbox <joint-recovery-mailbox@example.invalid>'}
  const sourceHash=sha(JSON.stringify(evidence)),accountEmail='joint-recovery-mailbox@example.invalid'
  const selected={ownerEmail:actorEmail,pipelineId,workspaceId,connectionId,messageIds:[messageId]}
  const beforeQueue=(await query("SELECT id::text,encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS sha FROM sync_outbox o ORDER BY id")).rows
  await withTransaction(async tx=>{
    await tx.query("SET LOCAL TIME ZONE 'UTC'")
    await tx.query("SELECT set_config('clawpilot.crm_shared_write_v1','on',true)")
    const c=(await tx.query(`SELECT enabled,generation,active_operation_id,active_transition_id,active_initial_enrollment_id
      FROM crm_native_email_publication_control WHERE singleton FOR UPDATE`)).rows[0]
    assert.equal(c.enabled,false);assert.equal(c.active_operation_id,null);assert.equal(c.active_transition_id,null)
    assert.equal(c.active_initial_enrollment_id,null)
    await tx.query('INSERT INTO user_maton_credentials(owner_email,login_email) VALUES($1,$2) ON CONFLICT(owner_email) DO NOTHING',[actorEmail,accountEmail])
    await tx.query(`INSERT INTO user_maton_connections(owner_email,connection_id,name,app,status,account_email,is_selected,source)
      VALUES($1,$2,'Joined synthetic recovery inbox','google-mail','ACTIVE',$3,true,'maton')`,[actorEmail,connectionId,accountEmail])
    await tx.query(`INSERT INTO crm_email_mailboxes(id,owner_email,provider,provider_account_id,account_email,verified_at)
      VALUES($1,$2,'gmail',$3,$4,clock_timestamp())`,[mailboxId,actorEmail,'joint-synthetic:'+mailboxId,accountEmail])
    await tx.query(`INSERT INTO crm_email_mailbox_bindings(owner_email,connection_id,mailbox_id,account_email,verified_at)
      VALUES($1,$2,$3,$4,clock_timestamp())`,[actorEmail,connectionId,mailboxId,accountEmail])
    await tx.query(`INSERT INTO crm_email_sources(id,mailbox_id,owner_email,provider_message_id,provider_thread_id,intake_pipeline_id,
      intake_workspace_id,observed_connection_id,observed_account_email,evidence,evidence_hash,provenance)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{"fixtureOnly":true}'::jsonb)`,
      [sourceId,mailboxId,actorEmail,messageId,threadId,pipelineId,workspaceId,connectionId,accountEmail,evidence,sourceHash])
    // These are explicit synthetic app mappings to two already existing,
    // independently read native Account/Contact pairs; no provider is called.
    for(const [index,{accountId,contactId}] of related.entries()){
      const {organizationId:org,contactId:contact}=localPairs[index],key='joint-recovery-related:'+index
      const sourcePayload={fixtureOnly:true}
      await tx.query(`INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id,source_key,identity_key,name,account_type,
        relationship_type,source_payload,source_hash,sync_status,suitecrm_synced_at,reference_code)
        VALUES($1,$2,$3,$4,$4,$5,$6,'customer',$7,$8,'synced',now(),allocate_crm_reference('ga'))`,
      [org,pipelineId,accountId,key,'Synthetic recovery company '+index,index===0?'Customer':'Supplier',sourcePayload,sha(key)])
      await tx.query(`INSERT INTO crm_contacts(id,pipeline_id,organization_id,suitecrm_id,source_key,identity_key,full_name,
        last_name,source_payload,source_hash,sync_status,suitecrm_synced_at,reference_code)
        VALUES($1,$2,$3,$4,$5,$5,$6,$6,$7,$8,'synced',now(),allocate_crm_reference('gc'))`,
      [contact,pipelineId,org,contactId,key,'Synthetic recovery contact '+index,sourcePayload,sha(key)])
    }
    const initialPrimary=repairFirst?1:0,primary=localPairs[initialPrimary]
    await tx.query(`INSERT INTO crm_interactions(id,pipeline_id,canonical_source_id,provider_message_id,provider_thread_id,
      source_key,subject,source_hash,suitecrm_id,suitecrm_module,reference_code,sync_status,sync_error,source_payload,metadata,
      organization_id,contact_id)
      VALUES($1,$2,$3,$4,$5,$6,'Synthetic privately held recovery Email',$7,$8,'Emails',$9,'failed',
        'Synthetic legacy provider outcome unknown','{"fixtureOnly":true}'::jsonb,'{}'::jsonb,$10,$11)`,
      [localId,pipelineId,sourceId,messageId,threadId,'joint-recovery:'+messageId,sourceHash,suiteCrmId,globalId,
        primary.organizationId,primary.contactId])
    for(const [index,{organizationId:org,contactId:contact}] of localPairs.entries()){
      if(repairFirst&&index!==initialPrimary)continue
      await tx.query(`INSERT INTO crm_interaction_organizations(pipeline_id,interaction_id,organization_id,is_primary,sort_order)
        VALUES($1,$2,$3,$4,$5)`,[pipelineId,localId,org,index===initialPrimary,repairFirst?0:index])
      await tx.query(`INSERT INTO crm_interaction_contacts(pipeline_id,interaction_id,contact_id,is_primary,sort_order)
        VALUES($1,$2,$3,$4,$5)`,[pipelineId,localId,contact,index===initialPrimary,repairFirst?0:index])
    }
    const audience={policy:'pipeline-internal',pipelineId,workspaceId,ownerSuiteCrmId:ownerNativeId,
      allowedSuiteCrmUserIds:[ownerNativeId],fingerprint:sha('synthetic preactivation legacy audience')}
    const payload={entity:'interactions',localId,pipelineId,suiteCrmId,suiteCrmModule:'Emails',attributes:{global_id_c:globalId,
      name:'Synthetic privately held recovery Email',date_sent_received:'2026-10-30 13:00:00',type:'archived',status:'read',
      parent_type:'Accounts',parent_id:related[initialPrimary].accountId,assigned_user_id:ownerNativeId,description:evidence.body,description_html:'',
      from_addr_name:evidence.from,to_addrs_names:evidence.to,
      cc_addrs_names:'',bcc_addrs_names:'',reply_to_addrs_names:''},
    relationships,emailProjection:{version:1,accounts:originalAccounts,contacts,contactAccounts,previousManaged:{accounts:[],contacts:[]},audience}}
    const idempotencyKey=`crm:interactions:v4:${localId}:Emails:${sourceHash}`
    await tx.query(`INSERT INTO sync_outbox(id,aggregate_type,aggregate_id,operation,target_system,payload,status,
      attempts,idempotency_key,processed_at,last_error) VALUES($1,'crm_interactions',$2,'upsert_record','suitecrm',$3,
      'dead',8,$4,now(),'native_projection_proof_unavailable')`,[retiredOutboxId,localId,payload,idempotencyKey])
  })
  const reviewedOriginal=await withTransaction(async tx=>{
    await tx.query("SET LOCAL TIME ZONE 'UTC'")
    const fingerprints=(await tx.query(`SELECT encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS "rowFingerprint",
      encode(public.digest(to_jsonb(i)::text,'sha256'),'hex') AS "sourceFingerprint",
      encode(public.digest(o.payload::text,'sha256'),'hex') AS "payloadFingerprint",
      encode(public.digest(o.idempotency_key,'sha256'),'hex') AS "keyFingerprint"
      FROM sync_outbox o JOIN crm_interactions i ON i.id::text=o.aggregate_id WHERE o.id=$1`,[retiredOutboxId])).rows[0]
    const generation=Number((await tx.query('SELECT generation FROM crm_native_email_publication_control WHERE singleton')).rows[0].generation)
    return {generation,row:{outboxId:retiredOutboxId,localId,pipelineId,workspaceId,nativeId:suiteCrmId,
      globalId,attempts:8,...fingerprints}}
  })
  if(seedOnly){
    await assertNativeAbsent()
    return {beforeQueue,selected,localId,retiredOutboxId,accounts,contacts,localPairs,related,
      originalFingerprint:reviewedOriginal.row.rowFingerprint}
  }
  let repaired=null
  if(repairFirst) {
    repaired=await repairNativeJointLegacyEmail({app,query,withTransaction,getPostgresPool,assertNativeAbsent,
      target:{outboxId:retiredOutboxId,localId,pipelineId,workspaceId,globalId,nativeId:suiteCrmId,
        oldPrimaryId:localPairs[1].organizationId,newPrimaryId:localPairs[0].organizationId,
        oldPrimaryNativeId:related[1].accountId,newPrimaryNativeId:related[0].accountId}})
  }
  const reviewedRow=repaired?await withTransaction(async tx=>{
    await tx.query("SET LOCAL TIME ZONE 'UTC'")
    const fingerprints=(await tx.query(`SELECT encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS "rowFingerprint",
      encode(public.digest(to_jsonb(i)::text,'sha256'),'hex') AS "sourceFingerprint",
      encode(public.digest(o.payload::text,'sha256'),'hex') AS "payloadFingerprint",
      encode(public.digest(o.idempotency_key,'sha256'),'hex') AS "keyFingerprint"
      FROM sync_outbox o JOIN crm_interactions i ON i.id::text=o.aggregate_id WHERE o.id=$1`,[retiredOutboxId])).rows[0]
    return {...reviewedOriginal,row:{...reviewedOriginal.row,...fingerprints}}
  }):reviewedOriginal
  if(repaired)assert.notEqual(reviewedRow.row.rowFingerprint,reviewedOriginal.row.rowFingerprint,'Archive must be newly signed over corrected bytes')
  const attestor='crm_joint_retirement_attestor',controller='crm_joint_retirement_controller'
  const pwd=sha(randomUUID()), pg=getPostgresPool().options
  assert.equal(pg.host,'127.0.0.1');assert.equal(pg.database,'initial_joint_fixture')
  for(const role of [attestor,controller])await query(`CREATE ROLE ${role} LOGIN PASSWORD '${pwd}' NOSUPERUSER NOCREATEROLE`)
  await query(`GRANT USAGE ON SCHEMA crm_legacy_email_retirement TO ${attestor},${controller};
    GRANT INSERT ON crm_legacy_email_retirement.verified_batch,crm_legacy_email_retirement.review TO ${attestor};
    GRANT EXECUTE ON FUNCTION crm_legacy_email_retirement.retire(uuid,uuid[],text) TO ${controller}`)
  const {Pool}=require('pg'),pools=[attestor,controller].map(user=>new Pool({host:pg.host,port:pg.port,database:pg.database,
    user,password:pwd,max:1,ssl:false,statement_timeout:10000}))
  const transact=pool=>async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r}
    catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
  const fenceKey=generateKeyPairSync('rsa',{modulusLength:3072}),operator=generateKeyPairSync('rsa',{modulusLength:3072})
  const expectedManifest={version:1,action:'archive_exact_legacy_terminal_rows_only',operationId:randomUUID(),publicationDisposition:'reviewed_recovery',
    scope:{projectId:randomUUID(),environmentId:randomUUID(),postgresDatabaseFingerprint:sha('synthetic pg'),appCommit:'a'.repeat(40),
      nativeDeploymentId:randomUUID(),nativeReplicaId:randomUUID(),nativeCommit:'b'.repeat(40),nativeDatabaseFingerprint:sha('synthetic maria')},
    actorEmail,operatorAccountId:authority.operatorAccountId,rootWorkspaceId:authority.rootWorkspaceId,appGeneration:reviewedRow.generation,
    gateFingerprint:sha('synthetic local gate'),appSourceFingerprint:reviewedRow.row.sourceFingerprint,fenceEpoch:randomUUID(),
    fenceEvidenceFingerprint:sha('isolated fixture no workers'),nativeAbsenceFingerprint:sha('native fixture exact zero'),
    historicalProviderOutcome:'unknown',rows:[reviewedRow.row]}
  const nowSeconds=Number((await query('SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS s')).rows[0].s)
  const common={version:1,audience:'clawpilot-private-legacy-email-retirement-controller',operationId:expectedManifest.operationId,
    manifestDigest:app.retirementApproval.legacyEmailRetirementManifestDigest(expectedManifest),issuedAt:nowSeconds,expiresAt:nowSeconds+120}
  const envelope=(proof,key)=>({proof,signature:exactSignature(app.protocol,proof,key)})
  const fenceEnvelope=envelope({...common,keyId:'synthetic-fence',issuer:'clawpilot-crm-fence-attestor',purpose:'clawpilot-legacy-email-fenced-absence-v1'},fenceKey.privateKey)
  const operatorEnvelope=envelope({...common,keyId:'synthetic-operator',issuer:'clawpilot-crm-retirement-operator',
    purpose:'clawpilot-legacy-email-retirement-review-v1',fenceEnvelopeDigest:app.protocol.nativeEmailDigest(fenceEnvelope)},operator.privateKey)
  let pins,receipt
  try{
    await app.retirement.archiveExactLegacyEmailsPrivately({expectedManifest,fenceEnvelope,operatorEnvelope,
      fenceAnchor:{keyId:'synthetic-fence',key:fenceKey.publicKey},operatorAnchor:{keyId:'synthetic-operator',key:operator.publicKey}},
    {expectedRoles:{attestor,controller},attestTransaction:transact(pools[0]),retireTransaction:transact(pools[1]),
      withLiveFence:async(_,action)=>{await assertNativeAbsent();const result=await action();await assertNativeAbsent();return result},
      retainResolutionPins:async value=>{pins=value}})
    receipt=await app.retirement.resolveExactLegacyEmailArchivePrivately(withTransaction,pins)
    assert.equal(receipt.state,'committed');assert.equal(receipt.rows,1);assert.equal(receipt.historicalProviderOutcome,'unknown')
  }finally{await Promise.all(pools.map(pool=>pool.end()))}
  assert.deepEqual((await query("SELECT id::text,encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS sha FROM sync_outbox o ORDER BY id")).rows,beforeQueue)
  return {selected,receipt,localId,retiredOutboxId,accounts,contacts,localPairs,related,repaired,
    preservedContactIndex:repairFirst?1:0,originalFingerprint:reviewedRow.row.rowFingerprint}
}

export async function runNativeJointLegacyEmailRecovery({query,withTransaction,getPostgresPool,authority,deadline,
  invokeNative,assertOutsideTransaction,inspectNative,archive,maintenance,scopedRecoveryPostgres=false}) {
  const {pipelineId,workspaceId,ownerNativeId}=authority
  assert.ok(Date.now()<deadline&&typeof inspectNative==='function'&&archive?.receipt.state==='committed')
  const app=loadNativeJointLegacyEmailRecoveryApp({query,withTransaction,getPostgresPool})
  const {suiteCrmId,globalId}=JOINT_LEGACY_EMAIL_NATIVE_IDENTITY
  const {localId,retiredOutboxId,selected,receipt:retirement}=archive
  const [holdId,outboxId,lockToken,owner]=Array.from({length:4},()=>randomUUID())
  const nativeBefore=await inspectNative(null)
  assert.deepEqual(nativeBefore,coreCounts,'Fixture must start with a clean native identity')
  const beforeQueue=(await query("SELECT id::text,encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS sha FROM sync_outbox o ORDER BY id")).rows
  const target={selected,retiredOutboxId,retirementReceiptHash:retirement.receiptHash,holdId,outboxId,lockToken,
    expectedOrganizations:{primaryNativeId:archive.related[0].accountId,nativeIds:archive.accounts}}
  const aliasId=randomUUID()
  const withLegacyAlias=async check=>{
    const key='synthetic-provider-alias:'+aliasId
    assert.equal((await query(`INSERT INTO crm_interactions(id,pipeline_id,provider_message_id,source_key,subject,
      source_hash,suitecrm_id,suitecrm_module,reference_code)
      VALUES($1,$2,$3,$4,'Synthetic separate legacy alias',$5,$6,'Emails','gi9788888')`,
    [aliasId,pipelineId,selected.messageIds[0],key,sha(key),randomUUID()])).rowCount,1)
    try { await check() }
    finally { assert.equal((await query('DELETE FROM crm_interactions WHERE id=$1',[aliasId])).rowCount,1) }
  }
  await withLegacyAlias(async()=>{
    await assert.rejects(app.recoveryStage.previewExactLegacyEmailRecoveryStagePrivately(withTransaction,target),/unavailable or changed/)
  })
  const planned=await app.recoveryStage.previewExactLegacyEmailRecoveryStagePrivately(withTransaction,target)
  const keyId='joint-synthetic-legacy-release',keypair=generateKeyPairSync('rsa',{modulusLength:3072})
  const nowSeconds=Number((await query('SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS s')).rows[0].s)
  const proof={version:1,purpose:'clawpilot-private-legacy-email-release-v1',keyId,...planned.pins,issuedAt:nowSeconds,expiresAt:nowSeconds+120}
  const initialApproval=app.releaseApproval.verifyLegacyEmailRecoveryReleaseApproval({envelope:{proof,signature:exactSignature(app.protocol,proof,keypair.privateKey)},
    operatorAnchor:{keyId,key:keypair.publicKey},nowSeconds})
  // Sharing a single Email does not make the primary Account interchangeable,
  // and an archived placement with a missing account cannot be staged as-is.
  for(const expectedOrganizations of [
    {...target.expectedOrganizations,primaryNativeId:archive.related[1].accountId},
    {...target.expectedOrganizations,nativeIds:[archive.related[0].accountId]},
  ]) {
    const mismatched={...target,expectedOrganizations}
    await assert.rejects(app.recoveryStage.previewExactLegacyEmailRecoveryStagePrivately(withTransaction,mismatched),
      /legacy_stage_approved_organizations_changed/)
    await assert.rejects(app.recoveryStage.stageExactLegacyEmailRecoveryPrivately(withTransaction,mismatched,initialApproval),
      /legacy_stage_approved_organizations_changed/)
  }
  // Change one approved Contact mapping without editing the Email source row.
  // The original approved preview must now fail before creating a staged hold.
  const first=archive.localPairs[archive.preservedContactIndex],unexpectedNativeId=randomUUID()
  const remap=nativeId=>query('UPDATE crm_contacts SET suitecrm_id=$1 WHERE id=$2',[nativeId,first.contactId])
  assert.equal((await remap(unexpectedNativeId)).rowCount,1)
  try {
    await assert.rejects(app.recoveryStage.stageExactLegacyEmailRecoveryPrivately(withTransaction,target,initialApproval),/legacy_release_relationships_changed/)
  } finally { assert.equal((await remap(archive.related[archive.preservedContactIndex].contactId)).rowCount,1) }
  await assert.rejects(app.recoveryStage.stageExactLegacyEmailRecoveryPrivately(withTransaction,
    {...target,lockToken:randomUUID()},initialApproval),/legacy_stage_approval_changed/)
  assert.deepEqual(await app.recoveryStage.resolveExactLegacyEmailStagePrivately(withTransaction,initialApproval),{state:'unknown'})
  // A mutation in the caller while its transaction opens must not change the
  // exact lock and command snapshotted before any await in the real adapter.
  const detached=structuredClone(target)
  const stageReceipt=await app.recoveryStage.stageExactLegacyEmailRecoveryPrivately(fn=>withTransaction(tx=>{
    detached.lockToken=randomUUID();return fn(tx)
  }),detached,initialApproval)
  assert.deepEqual(await app.recoveryStage.resolveExactLegacyEmailStagePrivately(withTransaction,initialApproval),stageReceipt)
  const exactArchive=(await query(`SELECT r.original_hash AS fingerprint,
      (r.original->'payload') #- '{emailProjection,audience}' = o.payload #- '{emailProjection,audience}' AS content_unchanged,
      r.original#>'{payload,emailProjection,audience}' IS DISTINCT FROM o.payload#>'{emailProjection,audience}' AS refreshed_audience,
      r.original->>'idempotency_key'=o.idempotency_key AS same_source_key,
      o.lock_token=$3 AS approved_lock
    FROM crm_legacy_email_retirement.retained r CROSS JOIN sync_outbox o WHERE r.outbox_id=$1 AND o.id=$2`,
  [retiredOutboxId,outboxId,lockToken])).rows
  assert.deepEqual(exactArchive,[{fingerprint:archive.originalFingerprint,content_unchanged:true,refreshed_audience:true,same_source_key:true,approved_lock:true}])
  const staged={initialApproval,inspectionDigest:planned.inspectionDigest,selection:{holdId,outboxId,
    nativeOperationId:planned.pins.nativeOperationId,requestFingerprint:planned.pins.requestFingerprint}}
  // The public exact path cannot see a privately parked replacement.
  await assert.rejects(app.exactPublication.previewExactEmailPublicationInPostgres(selected),/unavailable or changed/)
  await assert.rejects(withTransaction(tx=>tx.query('UPDATE sync_outbox SET available_at=now() WHERE id=$1',[outboxId])),
    error=>error.code==='55000')
  const roles=scopedRecoveryPostgres?await openNativeJointRecoveryPostgresRoles({ownerTransaction:withTransaction,
    ownerPool:getPostgresPool(),selection:staged.selection,archive}):null
  try {
  const assertPrivateTransactionClosed=()=>{assertOutsideTransaction();if(roles)assert.equal(roles.count(),0)}
  const {nativeOperationId}=staged.selection
  const nativeTarget={suiteCrmId,globalId,localId,pipelineId,workspaceId,ownerNativeId,operationId:nativeOperationId}
  const native=maintenance?createNativeJointRecoveryMaintenanceClient({app,maintenance,deadline,assertOutsideTransaction:assertPrivateTransactionClosed,inspectNative,
    target:{...nativeTarget,approvalHash:initialApproval.approvalHash,requestFingerprint:staged.selection.requestFingerprint}})
    :createNativeJointLegacyEmailClient({transport:app.transport,invokeNative,assertOutsideTransaction,deadline,
      target:nativeTarget,loseCommittedResponse:true})
  const controller={selection:staged.selection,transaction:roles?.transaction??withTransaction,
    ...(maintenance?{maintenanceDispatch:native.maintenanceDispatch}:{})}
  const initial=app.persistence.createPrivateLegacyEmailRecoveryPersistence({...controller,initialApproval:staged.initialApproval})
  // A parked job has not been admitted and cannot itself pin related rows.
  // Keep the account set identical and remove only its primary designation.
  const setPrimary=value=>withTransaction(async tx=>{
    await tx.query("SELECT set_config('clawpilot.crm_shared_write_v1','on',true)")
    return tx.query(`UPDATE crm_interaction_organizations SET is_primary=$3
      WHERE interaction_id=$1 AND organization_id=$2`,[localId,archive.localPairs[0].organizationId,value])
  })
  assert.equal((await setPrimary(false)).rowCount,1)
  try {
    await assert.rejects(()=>initial.loadItem(),/legacy_release_relationships_changed/)
  } finally { assert.equal((await setPrimary(true)).rowCount,1) }
  await withLegacyAlias(async()=>{
    await assert.rejects(()=>initial.loadItem(),/legacy_release_relationships_changed/)
  })
  if (maintenance) {
    const initialOperator=app.maintenanceOperator.createNativeEmailRecoveryMaintenanceOperator({persistence:initial,exchange:native.exchange,
      exchangePublish:native.exchangePublish,owner})
    const exactUnadmittedState=async()=>(await query(`SELECT c.active_operation_id,
      (SELECT count(*)::int FROM crm_legacy_email_recovery_releases WHERE hold_id=$2 OR outbox_id=$3 OR native_operation_id=$1) AS registrations,
      (SELECT count(*)::int FROM crm_native_email_publication_admissions WHERE operation_id=$1) AS admissions,
      (SELECT count(*)::int FROM crm_native_email_publication_work WHERE operation_id=$1) AS work_leases,
      (SELECT count(*)::int FROM crm_legacy_email_recovery_settlements WHERE native_operation_id=$1) AS settlements,
      (SELECT encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') FROM sync_outbox o WHERE o.id=$3) AS outbox_fingerprint
      FROM crm_native_email_publication_control c WHERE c.singleton`,[nativeOperationId,holdId,outboxId])).rows
    const [beforeRejection]=await exactUnadmittedState()
    assert.match(beforeRejection?.outbox_fingerprint??'',hash)
    assert.deepEqual(beforeRejection,{active_operation_id:null,registrations:0,admissions:0,work_leases:0,settlements:0,
      outbox_fingerprint:beforeRejection.outbox_fingerprint})
    await assert.rejects(()=>initialOperator.publish(),error=>[error.code,error.message].includes('legacy_dispatch_transport_destination_unverified'))
    assert.deepEqual(await exactUnadmittedState(),[beforeRejection],
      'Destination rejection before readiness must not change the reviewed outbox or create a registration, admission, work lease, active operation, or receipt')
    assert.deepEqual(await inspectNative(null),coreCounts,'Destination rejection before authorization must leave native records untouched')
    assert.deepEqual(native.evidence().calls.map(call=>call.action),['prepare'],'No signed publish may be recorded before readiness')
    // The same exact approval remains unspent. Prepare again and allow only
    // the new publish handshake to commit admission and consume its permit.
    await assert.rejects(()=>initialOperator.publish(),error=>error.code==='native_outcome_unknown')
    await assert.rejects(()=>initialOperator.publish(),error=>error.code==='native_publication_not_available')
    assert.deepEqual(native.evidence().calls.map(call=>call.action),['prepare','prepare','publish'])
  } else {
    const firstWorker=app.worker.createNativeEmailPublicationWorker(initial,native.client,owner)
    assert.deepEqual(await firstWorker.process(await initial.loadItem(),8),{handled:true,status:'held'})
  }
  const unknown=(await query('SELECT state,native_receipt FROM crm_native_email_publication_admissions WHERE operation_id=$1',[nativeOperationId])).rows[0]
  assert.deepEqual(unknown,{state:'unknown',native_receipt:null});assert.ok(native.evidence().lostResponse)
  await assert.rejects(()=>remap(unexpectedNativeId),error=>error.code==='55000'&&/pins its linked Contact mappings/.test(error.message))
  await assert.rejects(()=>query('DELETE FROM crm_interaction_contacts WHERE interaction_id=$1 AND contact_id=$2',[localId,first.contactId]),
    error=>error.code==='55000'&&/pins its Account and Contact links/.test(error.message))
  const afterLost=await inspectNative(nativeOperationId)
  assert.deepEqual(afterLost,{emails:1,custom:1,global:1,text:1,groups:1,managed:1,operations:1},'One actual native commit must exist before PG settlement')
  let ordinaryCalls=0;const deny=async()=>{ordinaryCalls++;throw Error('Ordinary native worker cannot access private held recovery')}
  const ordinary=app.worker.createNativeEmailPublicationWorker(app.persistence.createPostgresNativeEmailWorkerPersistence(),
    {prepare:deny,publish:deny,resolveOrCancel:deny})
  assert.deepEqual(await ordinary.resume(),{enabled:true,blocked:true});assert.equal(ordinaryCalls,0)
  // New controller instance, no initial approval needed for resolving the
  // already durable admission; use the same still-live exact work owner.
  const resolution=app.persistence.createPrivateLegacyEmailRecoveryPersistence(controller)
  const settled={synchronized:true,pipelineId,outboxId}
  if (maintenance) {
    const resolver=app.maintenanceOperator.createNativeEmailRecoveryMaintenanceOperator({persistence:resolution,exchange:native.exchange,
      exchangePublish:native.exchangePublish,owner})
    assert.deepEqual(await resolver.resolve(),settled)
    await assert.rejects(()=>resolver.resolve(),error=>error.code==='legacy_dispatch_no_unresolved_operation')
  } else {
    const resumed=await app.worker.createNativeEmailPublicationWorker(resolution,native.client,owner).resume()
    assert.deepEqual(resumed,{enabled:true,blocked:false,settled})
  }
  assert.deepEqual(native.evidence().calls.map(call=>call.action),maintenance?['prepare','prepare','publish','resolve']:['prepare','publish','resolve'])
  assert.deepEqual(await inspectNative(nativeOperationId),afterLost,'Exact resolution must not create another native row or operation')
  const row=(await query(`SELECT o.status,o.attempts,o.available_at='infinity'::timestamptz AS parked,o.lock_token,
      i.sync_status,i.metadata#>>'{suiteCrmEmailProjection,operationId}' AS synced_operation,
      a.state,r.state AS settlement,c.active_operation_id,
      r.receipt_hash=encode(public.digest(a.native_receipt::text,'sha256'),'hex') AS receipt_matches
    FROM sync_outbox o JOIN crm_legacy_email_recovery_holds h ON h.outbox_id=o.id JOIN crm_interactions i ON i.id=h.local_id
    JOIN crm_legacy_email_recovery_releases lr ON lr.hold_id=h.operation_id
    JOIN crm_native_email_publication_admissions a ON a.operation_id=lr.native_operation_id
    JOIN crm_legacy_email_recovery_settlements r ON r.native_operation_id=a.operation_id
    CROSS JOIN crm_native_email_publication_control c WHERE c.singleton AND o.id=$1`,[outboxId])).rows
  assert.deepEqual(row,[{status:'succeeded',attempts:1,parked:true,lock_token:null,sync_status:'synced',synced_operation:nativeOperationId,
    state:'committed',settlement:'committed',active_operation_id:null,receipt_matches:true}])
  assert.deepEqual((await query("SELECT id::text,encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS sha FROM sync_outbox o WHERE id<>$1 ORDER BY id",[outboxId])).rows,beforeQueue)
  assert.equal((await query('SELECT count(*)::int AS n FROM sync_outbox WHERE id=$1',[retiredOutboxId])).rows[0].n,0)
  return {kind:'actual-local-joined-private-held-legacy-email-recovery',passed:true,syntheticSource:true,actualArchiveStagingProven:true,
    retirementReceiptHash:retirement.receiptHash,stageReceiptHash:stageReceipt.receiptHash,originalFingerprint:archive.originalFingerprint,
    historicalProviderOutcome:'unknown',productionTouched:false,roleSeparatedProductionAuthorityProven:false,
    existingActivationReused:true,exactAppInspectionDigest:staged.inspectionDigest,nativeBefore,afterLost,
    nativeResponseLossRecovered:true,actualPgTerminalReceipt:true,ordinaryWorkerNativeCalls:ordinaryCalls,unrelatedQueueUnchanged:true,
    actualNativeAccountLinks:archive.accounts.length,actualNativeContactLinks:archive.contacts.length,
    reviewedOrganizationPlacementGuardProven:true,missingPrimaryAfterStageRejected:true,legacyProviderAliasRejectedBeforeAndAfterStage:true,
    accountRepairBeforeArchive:archive.repaired,
    staleContactMappingRejectedBeforeStage:true,selectedRelationshipsProtectedWhileOutcomeUnknown:true,
    actualPrivateMaintenanceOperator:!!maintenance,scopedPostgresFixtureProven:!!roles,
    preAuthenticationPublishRejectionLeftNoAdmissionRegistrationLeaseReceiptOrNativeRecord:!!maintenance,
    native:native.evidence()}
  } finally {if(roles)await roles.close()}
}
