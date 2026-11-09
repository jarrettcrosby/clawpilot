// Guarded joined fixture only. The signing keys and scope below are synthetic;
// this file never provides deployment credentials or a production fence.
import assert from 'node:assert/strict'
import {constants,createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto'
import {createRequire} from 'node:module'
import {archiveNativeJointLegacyEmail,JOINT_LEGACY_EMAIL_NATIVE_IDENTITY,loadNativeJointLegacyEmailRecoveryApp}
  from './native-joint-legacy-email-recovery.mjs'

const {Pool}=createRequire(new URL('../../app_src/package.json',import.meta.url))('pg')
const schema='crm_legacy_email_terminal_hold'
const database='initial_joint_fixture'
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const hash=/^[a-f0-9]{64}$/u
const digest=value=>createHash('sha256').update(value).digest('hex')
const wrap=(protocol,proof,key)=>({proof,signature:sign('sha256',Buffer.from(protocol.nativeEmailCanonicalJson(proof),'ascii'),
  {key,padding:constants.RSA_PKCS1_PADDING}).toString('base64')})
const exact=({rows})=>{assert.equal(rows.length,1);return rows[0]}
const transactionFor=pool=>async action=>{
  const tx=await pool.connect()
  try {await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');const result=await action(tx);await tx.query('COMMIT');return result}
  catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
}
const utc=tx=>tx.query("SET LOCAL TIME ZONE 'UTC'")
const dbSecond=async query=>Number(exact(await query('SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS second')).second)
const queueHashes=async query=>(await query(`SELECT id::text,encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS sha
  FROM public.sync_outbox o ORDER BY id`)).rows

export async function holdNativeJointOriginalEmail({query,withTransaction,getPostgresPool,authority,assertNativeAbsent,related}) {
  const endpoint=getPostgresPool().options
  assert.equal(endpoint.host,'127.0.0.1');assert.equal(endpoint.database,database)
  const port=Number(endpoint.port)
  assert.ok(Number.isInteger(port)&&port>1023&&port<=65535)
  const {actorEmail,pipelineId,workspaceId,operatorAccountId,rootWorkspaceId,nativeInstanceId}=authority
  assert.ok([pipelineId,workspaceId,operatorAccountId,rootWorkspaceId].every(value=>uuid.test(value)))
  assert.match(nativeInstanceId,/^[A-Za-z0-9][A-Za-z0-9-]{0,35}$/u)
  assert.match(actorEmail,/^[^@]+@[^@]+\.invalid$/u);assert.equal(typeof assertNativeAbsent,'function')
  const seed=await archiveNativeJointLegacyEmail({query,withTransaction,getPostgresPool,authority,assertNativeAbsent,related,
    repairFirst:false,seedOnly:true})
  const {localId,retiredOutboxId:outboxId}=seed
  const {suiteCrmId:nativeId,globalId}=JOINT_LEGACY_EMAIL_NATIVE_IDENTITY
  const app=loadNativeJointLegacyEmailRecoveryApp({query,withTransaction,getPostgresPool})
  const {protocol,retirementApproval,terminalHold}=app
  const before=await withTransaction(async tx=>{
    await utc(tx)
    const fingerprints=exact(await tx.query(`SELECT encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS "rowFingerprint",
      encode(public.digest(to_jsonb(i)::text,'sha256'),'hex') AS "sourceFingerprint",
      encode(public.digest(o.payload::text,'sha256'),'hex') AS "payloadFingerprint",
      encode(public.digest(o.idempotency_key,'sha256'),'hex') AS "keyFingerprint",
      ${schema}.relationship_fingerprint(i.id) AS "relationshipFingerprint",
      ${schema}.provider_identity_fingerprint(i.id) AS "providerIdentityFingerprint"
      FROM public.sync_outbox o JOIN public.crm_interactions i ON i.id::text=o.aggregate_id
      WHERE o.id=$1::uuid AND i.id=$2::uuid AND o.status='dead' AND o.attempts=8 AND i.sync_status='failed'`,[outboxId,localId]))
    assert.ok(Object.values(fingerprints).every(value=>hash.test(value)))
    const gate=exact(await tx.query(`SELECT c.enabled,c.generation,c.active_operation_id,c.active_transition_id,c.active_initial_enrollment_id,
      ${schema}.gate_fingerprint() AS gate,encode(public.digest(s.snapshot::text,'sha256'),'hex') AS source,s.snapshot
      FROM public.crm_native_email_publication_control c
      CROSS JOIN (SELECT public.clawpilot_crm_native_initial_source_snapshot() AS snapshot) s WHERE c.singleton`))
    assert.equal(gate.enabled,false);assert.equal(gate.active_operation_id,null);assert.equal(gate.active_transition_id,null)
    assert.equal(gate.active_initial_enrollment_id,null)
    assert.equal(gate.snapshot.pendingOutbox.find(row=>row.id===outboxId)?.rowFingerprint,fingerprints.rowFingerprint)
    return {fingerprints,gate,queue:await queueHashes(tx.query.bind(tx))}
  })
  assert.equal(before.fingerprints.rowFingerprint,seed.originalFingerprint)
  const holdId=randomUUID()
  const expectedManifest={version:1,action:'hold_exact_legacy_terminal_rows_in_place',operationId:holdId,
    publicationDisposition:'hold_without_publication',scope:{projectId:randomUUID(),environmentId:randomUUID(),
      postgresDatabaseFingerprint:digest('joined disposable PostgreSQL'),appCommit:'a'.repeat(40),nativeDeploymentId:randomUUID(),
      nativeReplicaId:randomUUID(),nativeCommit:'b'.repeat(40),nativeDatabaseFingerprint:digest('joined disposable MariaDB'),
      nativeAuthorityInstanceId:nativeInstanceId},actorEmail,operatorAccountId,rootWorkspaceId,appGeneration:Number(before.gate.generation),
    gateFingerprint:before.gate.gate,appSourceFingerprint:before.gate.source,fenceEpoch:randomUUID(),
    fenceEvidenceFingerprint:digest('joined isolated app and native writers'),nativeAbsenceFingerprint:digest('joined exact native absence'),
    historicalProviderOutcome:'unknown',rows:[{outboxId,localId,pipelineId,workspaceId,nativeId,globalId,attempts:8,...before.fingerprints}]}
  const suffix=randomBytes(5).toString('hex'),attestor=`crm_joint_hold_attestor_${suffix}`,controller=`crm_joint_hold_controller_${suffix}`
  const pools=[]
  let receipt
  try{
    for(const user of [attestor,controller]){
      const password=randomBytes(32).toString('hex')
      await query(`CREATE ROLE ${user} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`)
      pools.push(new Pool({host:'127.0.0.1',port,database,user,password,ssl:false,max:1,statement_timeout:10000,connectionTimeoutMillis:2500}))
    }
    await query(`GRANT USAGE ON SCHEMA ${schema} TO ${attestor},${controller};
      GRANT INSERT (batch,manifest,manifest_canonical,manifest_hash,fence_hash,approval_hash,valid_until) ON ${schema}.verified_batch TO ${attestor};
      GRANT EXECUTE ON FUNCTION ${schema}.hold(uuid,uuid[],text) TO ${controller}`)
    const fenceKey=generateKeyPairSync('rsa',{modulusLength:3072}),operatorKey=generateKeyPairSync('rsa',{modulusLength:3072})
    const now=await dbSecond(query),manifestDigest=retirementApproval.legacyEmailTerminalHoldManifestDigest(expectedManifest)
    const common={version:1,audience:'clawpilot-private-legacy-email-hold-controller',operationId:holdId,manifestDigest,
      issuedAt:now,expiresAt:now+120}
    const fenceEnvelope=wrap(protocol,{...common,keyId:'joint-hold-fence',issuer:'clawpilot-crm-hold-fence-attestor',
      purpose:'clawpilot-legacy-email-hold-fenced-absence-v1'},fenceKey.privateKey)
    const operatorEnvelope=wrap(protocol,{...common,keyId:'joint-hold-operator',issuer:'clawpilot-crm-hold-operator',
      purpose:'clawpilot-legacy-email-hold-review-v1',fenceEnvelopeDigest:protocol.nativeEmailDigest(fenceEnvelope)},operatorKey.privateKey)
    let retainedPins
    const pins=await terminalHold.holdExactLegacyEmailsPrivately({expectedManifest,fenceEnvelope,operatorEnvelope,
      fenceAnchor:{keyId:'joint-hold-fence',key:fenceKey.publicKey},operatorAnchor:{keyId:'joint-hold-operator',key:operatorKey.publicKey}},
    {expectedRoles:{attestor,controller},attestTransaction:transactionFor(pools[0]),holdTransaction:transactionFor(pools[1]),
      retainResolutionPins:async value=>{retainedPins=value},
      withLiveFence:async(manifest,action)=>{
        assert.equal(manifest.operationId,holdId)
        await assertNativeAbsent();const result=await action();await assertNativeAbsent();return result
      }})
    assert.deepEqual(pins,retainedPins)
    receipt=await terminalHold.resolveExactLegacyEmailTerminalHoldPrivately(withTransaction,pins)
    assert.equal(receipt.state,'committed');assert.equal(receipt.operationId,holdId);assert.equal(receipt.rows,1)
    assert.equal(receipt.historicalProviderOutcome,'unknown');assert.match(receipt.receiptHash,hash)
  }finally{await Promise.all(pools.map(pool=>pool.end()))}
  const after=await withTransaction(async tx=>{
    await utc(tx)
    return {queue:await queueHashes(tx.query.bind(tx)),snapshot:exact(await tx.query(
      'SELECT public.clawpilot_crm_native_initial_source_snapshot() AS snapshot')).snapshot}
  })
  assert.deepEqual(after.queue,before.queue,'Holding the original changed an outbox row')
  assert.deepEqual(after.snapshot,before.gate.snapshot,'Holding the original changed the enrollment inventory')
  return {...seed,outboxId,holdId,receipt,nativeAuthorityInstanceId:nativeInstanceId,
    originalFingerprint:before.fingerprints.rowFingerprint,sourceFingerprint:before.fingerprints.sourceFingerprint}
}

export async function stageNativeJointOriginalEmail({query,app,held,transaction,attestTransaction,attestorUser,pinOperation}) {
  const {protocol,heldStage,heldApproval}=app
  assert.equal(held.receipt.state,'committed');assert.equal(held.outboxId,held.retiredOutboxId)
  assert.notEqual(transaction,attestTransaction)
  const target={holdId:held.holdId,outboxId:held.outboxId,holdReceiptHash:held.receipt.receiptHash,lockToken:randomUUID()}
  const before=await query(`SELECT encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS fingerprint,
    encode(public.digest(to_jsonb(i)::text,'sha256'),'hex') AS source,to_jsonb(o)->>'created_at' AS created_at,o.idempotency_key,o.status
    FROM public.sync_outbox o JOIN public.crm_interactions i ON i.id::text=o.aggregate_id WHERE o.id=$1::uuid`,[held.outboxId])
  const terminal=exact(before)
  assert.equal(terminal.status,'dead');assert.equal(terminal.fingerprint,held.originalFingerprint)
  assert.equal(terminal.source,held.sourceFingerprint)
  const otherBefore=(await queueHashes(query)).filter(row=>row.id!==held.outboxId)
  const {pins}=await heldStage.previewHeldOriginalRecovery(transaction,target)
  assert.equal(pins.outboxId,held.outboxId);assert.equal(pins.holdBatchId,held.holdId);assert.equal(pins.lockToken,target.lockToken)
  assert.equal(pins.nativeAuthorityInstanceId,held.nativeAuthorityInstanceId)
  assert.equal(pins.holdReceiptHash,held.receipt.receiptHash);assert.equal(pins.originalFingerprint,held.originalFingerprint)
  assert.equal(pins.primaryAccountId,held.related[0].accountId);assert.deepEqual(pins.accountIds,held.accounts)
  const keyId='joint-held-original-recovery',keypair=generateKeyPairSync('rsa',{modulusLength:3072}),now=await dbSecond(query)
  const proof={version:1,purpose:'clawpilot-private-legacy-held-email-recovery-v1',keyId,issuedAt:now,expiresAt:now+120,...pins}
  const approval=heldApproval.verifyLegacyHeldEmailRecoveryApproval({envelope:wrap(protocol,proof,keypair.privateKey),
    operatorAnchor:{keyId,key:keypair.publicKey},nowSeconds:now})
  const selection=Object.freeze({holdId:held.holdId,outboxId:held.outboxId,nativeOperationId:approval.nativeOperationId,
    requestFingerprint:approval.requestFingerprint})
  await pinOperation?.(selection)
  const read={outboxId:held.outboxId,intentHash:approval.intentHash,approvalHash:approval.approvalHash}
  assert.deepEqual(await heldStage.inspectHeldOriginalRecovery(transaction,read),{state:'unknown'})
  const receipt=await heldStage.stageHeldOriginalRecovery({transaction,attestTransaction,attestorUser,target,approval})
  assert.equal(receipt.state,'staged');assert.equal(receipt.holdBatchId,held.holdId);assert.equal(receipt.outboxId,held.outboxId)
  assert.equal(receipt.intentHash,approval.intentHash);assert.equal(receipt.approvalHash,approval.approvalHash);assert.match(receipt.receiptHash,hash)
  assert.deepEqual(await heldStage.inspectHeldOriginalRecovery(transaction,read),receipt)
  assert.deepEqual(await heldStage.inspectHeldOriginalRecovery(transaction,{...read,approvalHash:digest('wrong stage approval')}),{state:'unknown'})
  const current=exact(await query(`SELECT o.id::text,o.idempotency_key,o.status,o.attempts,o.lock_token,o.available_at::text,
    to_jsonb(o)->>'created_at' AS created_at,encode(public.digest(to_jsonb(i)::text,'sha256'),'hex') AS source,
    h.row_fingerprint AS original_fingerprint,(SELECT count(*)::int FROM public.sync_outbox x
      WHERE x.idempotency_key=o.idempotency_key) AS same_key_count
    FROM public.sync_outbox o JOIN public.crm_interactions i ON i.id::text=o.aggregate_id
    JOIN ${schema}.held h ON h.outbox_id=o.id WHERE o.id=$1::uuid`,[held.outboxId]))
  assert.deepEqual(current,{id:held.outboxId,idempotency_key:terminal.idempotency_key,status:'processing',attempts:1,
    lock_token:target.lockToken,available_at:'infinity',created_at:terminal.created_at,source:held.sourceFingerprint,
    original_fingerprint:held.originalFingerprint,same_key_count:1})
  assert.deepEqual((await queueHashes(query)).filter(row=>row.id!==held.outboxId),otherBefore)
  return Object.freeze({selection,receipt,approval})
}
