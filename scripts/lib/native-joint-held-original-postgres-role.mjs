// Disposable same-original acceptance fixture ONLY. The parent owns the
// entire synthetic database. These grants/policies are not a live installer.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { inspectNativeJointRecoveryControlTriggerBoundary } from './native-joint-recovery-postgres-role.mjs'

const {Pool}=createRequire(new URL('../../app_src/package.json',import.meta.url))('pg')
const database='initial_joint_fixture',schema='crm_legacy_email_terminal_hold'
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,hash=/^[0-9a-f]{64}$/u
const globalCode=/^gi(?:[0-9]{7}|[0-9a-v]{12})$/u
const tables=['public.crm_interactions','public.sync_outbox','public.crm_native_email_publication_control',
  'public.crm_native_email_publication_admissions','public.crm_native_email_publication_work',
  ...['held','verified_batch','consumed','verified_recovery','staged','released','verified_receipts'].map(name=>`${schema}.${name}`),
  ...['crm_interaction_organizations','crm_interaction_contacts','crm_organizations','crm_contacts'].map(name=>`public.${name}`)]
const procedures=[`${schema}.stage_recovery(uuid,text,jsonb)`,`${schema}.resolve_recovery(uuid,text,text)`,
  `${schema}.register_release(uuid,text)`,`${schema}.claim_resolution(uuid,text,uuid)`,
  `${schema}.settle_release(uuid,text,uuid,bigint,jsonb)`,`${schema}.resolve_release(uuid,text,text,text)`,
  `${schema}.relationship_fingerprint(uuid)`,`${schema}.provider_identity_fingerprint(uuid)`,
  'public.clawpilot_crm_legacy_email_live_relationships(uuid,uuid)',
  'public.clawpilot_crm_legacy_email_provider_identity_unambiguous(uuid,uuid)']

// The real audience collector needs complete authority input in its synthetic
// fixture, including uniqueness of a native identity across application users.
// These are read-only columns, not unrestricted access to application records.
const authorityColumns={
  pipeline_spaces:'id,workspace_organization_id,owner_email,reference_access_disabled',
  workspace_organizations:'id,parent_id,organization_type,is_demo',
  app_users:'email,role,status,suitecrm_user_id',
  app_user_organization_memberships:'organization_id,user_email,status,role,permissions,trashed_at',
  pipeline_space_members:'pipeline_id,user_email,access_role',
  crm_operator_accounts:'id,root_workspace_id,owner_email,enabled,revision',
  crm_operator_workspace_bindings:'operator_account_id,workspace_id,owner_email,enabled,revision',
  crm_root_employee_access_grants:'id,operator_account_id,user_email,source_workspace_id,enabled,revision',
  crm_native_email_capability_policies:'pipeline_id,generation,policy,fingerprint',
  crm_interaction_organizations:'pipeline_id,interaction_id,organization_id,is_primary',
  crm_interaction_contacts:'pipeline_id,interaction_id,contact_id',
  crm_organizations:'pipeline_id,id,suitecrm_id,source_payload',
  crm_contacts:'pipeline_id,id,suitecrm_id,organization_id,source_payload',
}

export async function openNativeJointHeldOriginalPostgresRoles({ownerTransaction,ownerPool,held}) {
  const {outboxId,holdId,localId,selected:{pipelineId,workspaceId}}=held
  const endpoint=ownerPool.options
  assert.ok(typeof ownerTransaction==='function'&&[outboxId,holdId,localId,pipelineId,workspaceId].every(v=>uuid.test(v)))
  assert.ok(endpoint.host==='127.0.0.1'&&endpoint.database===database&&endpoint.ssl===false
    &&Number.isInteger(Number(endpoint.port))&&Number(endpoint.port)>1023)
  const suffix=randomBytes(6).toString('hex'),controllerUser=`crm_joint_held_controller_${suffix}`,
    attestorUser=`crm_joint_held_attestor_${suffix}`,ordinaryUser=`crm_joint_held_ordinary_${suffix}`
  const passwords=new Map([controllerUser,attestorUser,ordinaryUser].map(user=>[user,randomBytes(32).toString('hex')]))
  const outbox=`'${outboxId}'::uuid`,batch=`'${holdId}'::uuid`,local=`'${localId}'::uuid`,pipeline=`'${pipelineId}'::uuid`
  const workspace=`'${workspaceId}'::uuid`
  const policy=(table,action,user,using,check)=>`CREATE POLICY fixture_held_${user===controllerUser?'controller':user===attestorUser?'attestor':'ordinary'}_${action}
    ON ${table} FOR ${action.toUpperCase()} TO ${user}${using?` USING (${using})`:''}${check?` WITH CHECK (${check})`:''}`

  const identity=await ownerTransaction(async tx=>{
    const proof=await tx.query(`SELECT current_database() AS database,current_user=session_user AS direct,
      (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser`)
    assert.deepEqual(proof.rows,[{database,direct:true,superuser:true}])
    const target=await tx.query(`SELECT h.native_id,h.global_id,i.organization_id AS primary_account FROM ${schema}.held h
      JOIN ${schema}.verified_batch v USING(batch) JOIN ${schema}.consumed c USING(batch)
      JOIN public.crm_interactions i ON i.id=h.local_id AND i.pipeline_id=h.pipeline_id
      JOIN public.sync_outbox o ON o.id=h.outbox_id
      WHERE h.outbox_id=$1::uuid AND h.batch=$2::uuid AND h.local_id=$3::uuid
      AND h.pipeline_id=$4::uuid AND h.workspace_id=$5::uuid AND c.held_rows=1
      AND c.consumed_at<v.valid_until AND c.receipt_hash=${schema}.receipt_fingerprint(h.batch)
      AND i.source_key LIKE 'joint-recovery:%' AND i.source_payload->>'fixtureOnly'='true'
      AND i.suitecrm_module='Emails' AND i.suitecrm_id=h.native_id AND i.reference_code=h.global_id
      AND o.target_system='suitecrm' AND o.aggregate_type='crm_interactions' AND o.aggregate_id=h.local_id::text
      AND o.status='dead' AND o.attempts=8 AND o.last_error='native_projection_proof_unavailable'
      AND to_jsonb(o)=h.original AND NOT EXISTS(SELECT 1 FROM ${schema}.held other WHERE other.outbox_id<>h.outbox_id)
      AND NOT EXISTS(SELECT 1 FROM ${schema}.staged s WHERE s.outbox_id=h.outbox_id)`,
    [outboxId,holdId,localId,pipelineId,workspaceId])
    assert.ok(target.rows.length===1&&uuid.test(target.rows[0].native_id)&&globalCode.test(target.rows[0].global_id),
      'Expected one unopened synthetic held original')
    const primary=target.rows[0].primary_account
    assert.ok(uuid.test(primary),'Expected the synthetic original to have a primary account')
    const proceduresByOid=await tx.query(`SELECT f::regprocedure::oid AS oid FROM unnest($1::text[]) AS f`,[procedures])
    assert.equal(proceduresByOid.rows.length,procedures.length)
    const boundary=await inspectNativeJointRecoveryControlTriggerBoundary(tx)
    assert.equal(boundary.length,3,'Expected all control-integrity triggers')
    assert.deepEqual(boundary.filter(row=>!row.enabled||!row.definer&&!row.authorityColumnsOnly),[],
      'Restricted recovery must not widen grants for unrelated authority triggers')
    const catalog=await tx.query(`SELECT c.relrowsecurity,c.relforcerowsecurity
      FROM unnest($1::text[]) AS t(name) JOIN pg_catalog.pg_class c ON c.oid=to_regclass(t.name)`,[tables])
    assert.equal(catalog.rows.length,tables.length)
    assert.ok(catalog.rows.every(r=>!r.relrowsecurity&&!r.relforcerowsecurity),'Requires a fresh joined fixture database')
    for(const [user,password] of passwords) await tx.query(`CREATE ROLE ${user} LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1`)
    await tx.query(`GRANT USAGE ON SCHEMA public TO ${controllerUser},${attestorUser},${ordinaryUser};
      GRANT USAGE ON SCHEMA ${schema} TO ${controllerUser},${attestorUser}`)
    for(const table of tables) await tx.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    for(const [table,columns] of Object.entries(authorityColumns))
      await tx.query(`GRANT SELECT (${columns}) ON public.${table} TO ${controllerUser}`)
    // Relationship fingerprints serialize every column of the exact edge.
    // These two tables are RLS-scoped below to the single held interaction.
    await tx.query(`GRANT SELECT ON public.crm_interaction_organizations,public.crm_interaction_contacts TO ${controllerUser}`)
    await tx.query(`GRANT SELECT ON ${tables.slice(0,5).join(',')} TO ${controllerUser};
      GRANT UPDATE (updated_at) ON public.crm_interactions,public.sync_outbox,public.crm_native_email_publication_work TO ${controllerUser};
      GRANT UPDATE (active_operation_id,updated_at) ON public.crm_native_email_publication_control TO ${controllerUser};
      GRANT INSERT (operation_id,pipeline_id,local_id,native_id,global_id,generation,native_policy_fingerprint,command_hash,
        audience_fingerprint,command,allowed_reader_ids,request_fingerprint), UPDATE (state,updated_at)
        ON public.crm_native_email_publication_admissions TO ${controllerUser};
      GRANT INSERT (operation_id,request_fingerprint,work_kind,context,context_hash,lease_owner,lease_fence,lease_until)
        ON public.crm_native_email_publication_work TO ${controllerUser};
      GRANT SELECT (outbox_id,batch,local_id,pipeline_id,workspace_id,native_id,global_id,row_fingerprint,original)
        ON ${schema}.held TO ${controllerUser};
      GRANT SELECT (batch,manifest,valid_until) ON ${schema}.verified_batch TO ${controllerUser};
      GRANT SELECT (batch,consumed_at,held_rows,receipt_hash) ON ${schema}.consumed TO ${controllerUser};
      GRANT SELECT (outbox_id,receipt_hash,intent_hash) ON ${schema}.staged TO ${controllerUser};
      GRANT SELECT (outbox_id,native_operation_id,request_fingerprint,approval_hash,stage_receipt_hash) ON ${schema}.released TO ${controllerUser};
      GRANT SELECT (outbox_id,approval_hash,proof,intent_hash) ON ${schema}.verified_recovery TO ${controllerUser};
      GRANT INSERT (outbox_id,proof,proof_canonical,proof_hash,intent_hash,approval_hash,valid_until)
        ON ${schema}.verified_recovery TO ${attestorUser};
      GRANT INSERT (native_operation_id,receipt_hash,lease_fence) ON ${schema}.verified_receipts TO ${attestorUser};
      GRANT EXECUTE ON FUNCTION ${procedures.join(',')} TO ${controllerUser};
      GRANT SELECT (id,available_at,status,attempts,locked_at,lock_token,last_error),
        UPDATE (available_at,status,attempts,locked_at,lock_token,last_error,updated_at) ON public.sync_outbox TO ${ordinaryUser};
      GRANT SELECT,UPDATE (updated_at) ON public.crm_native_email_publication_control TO ${ordinaryUser};
      GRANT SELECT (operation_id,state) ON public.crm_native_email_publication_admissions TO ${ordinaryUser};
      GRANT SELECT (operation_id,work_kind) ON public.crm_native_email_publication_work TO ${ordinaryUser}`)
    const c=(table,action,using,check)=>policy(table,action,controllerUser,using,check)
    const o=(table,action,using,check)=>policy(table,action,ordinaryUser,using,check)
    for(const sql of [
      c('public.crm_interactions','select',`id=${local} AND pipeline_id=${pipeline}`),
      c('public.crm_interactions','update',`id=${local} AND pipeline_id=${pipeline}`,'false'),
      c('public.sync_outbox','select',`id=${outbox}`),c('public.sync_outbox','update',`id=${outbox}`,'false'),
      c('public.crm_native_email_publication_control','select','singleton'),
      c('public.crm_native_email_publication_control','update','singleton AND active_operation_id IS NULL','false'),
      c(`${schema}.held`,'select',`batch=${batch} AND outbox_id=${outbox}`),
      c(`${schema}.verified_batch`,'select',`batch=${batch}`),c(`${schema}.consumed`,'select',`batch=${batch}`),
      c(`${schema}.staged`,'select',`outbox_id=${outbox}`),
      c('public.crm_interaction_organizations','select',`pipeline_id=${pipeline} AND interaction_id=${local}`),
      c('public.crm_interaction_contacts','select',`pipeline_id=${pipeline} AND interaction_id=${local}`),
      c('public.crm_organizations','select',`pipeline_id=${pipeline} AND (id='${primary}'::uuid OR id IN
        (SELECT organization_id FROM public.crm_interaction_organizations WHERE pipeline_id=${pipeline} AND interaction_id=${local}))`),
      c('public.crm_contacts','select',`pipeline_id=${pipeline} AND id IN
        (SELECT contact_id FROM public.crm_interaction_contacts WHERE pipeline_id=${pipeline} AND interaction_id=${local})`),
      o('public.sync_outbox','select',`id=${outbox}`),o('public.sync_outbox','update',`id=${outbox}`,`id=${outbox}`),
      o('public.crm_native_email_publication_control','select','singleton'),
      o('public.crm_native_email_publication_control','update','singleton','false'),
    ]) await tx.query(sql)
    return {...target.rows[0],procedureOids:proceduresByOid.rows.map(row=>row.oid)}
  })

  let active=0,pinStarted=false,closed=false
  const connect=user=>new Pool({host:endpoint.host,port:endpoint.port,database,user,password:passwords.get(user),ssl:false,max:1,
    application_name:'clawpilot-joint-held-original-fixture',connectionTimeoutMillis:3000,statement_timeout:8000,
    lock_timeout:2500,idle_in_transaction_session_timeout:10000})
  const controller=connect(controllerUser),attestor=connect(attestorUser),ordinary=connect(ordinaryUser)
  const run=(pool,user)=>async action=>{
    assert.equal(closed,false,'Fixture roles are closed')
    const tx=await pool.connect();let broken=false
    active++
    try{
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await tx.query("SET LOCAL search_path=pg_catalog,public; SET LOCAL TIME ZONE 'UTC'")
      const proof=await tx.query(`SELECT current_database() AS database,current_user::text AS role,
        session_user=current_user AND current_setting('role')='none' AS direct,
        (SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolinherit)
          FROM pg_catalog.pg_roles WHERE rolname=current_user) AS limited`)
      assert.deepEqual(proof.rows,[{database,role:user,direct:true,limited:true}])
      const result=await action(tx);await tx.query('COMMIT');return result
    }catch(error){try{await tx.query('ROLLBACK')}catch{broken=true}throw error}
    finally{active--;tx.release(broken)}
  }
  const transaction=run(controller,controllerUser),attestTransaction=run(attestor,attestorUser),ordinaryTransaction=run(ordinary,ordinaryUser)
  const close=()=>{closed=true;return Promise.all([controller.end(),attestor.end(),ordinary.end()])}
  const denied=error=>error.code==='42501',fenced=error=>['42501','55000'].includes(error.code)
  const pinOperation=async({nativeOperationId,requestFingerprint})=>{
    assert.ok(!closed&&!pinStarted&&active===0&&hash.test(nativeOperationId)&&hash.test(requestFingerprint),
      'Pin one exact reviewed operation before approval attestation')
    pinStarted=true
    const op=`'${nativeOperationId}'`,request=`'${requestFingerprint}'`
    const admission=`operation_id=${op} AND request_fingerprint=${request} AND local_id=${local} AND pipeline_id=${pipeline}
      AND native_id='${identity.native_id}' AND global_id='${identity.global_id}'`
    const work=`operation_id=${op} AND request_fingerprint=${request} AND work_kind='outbox' AND context->>'outboxId'=${outbox}::text`
    const review=`outbox_id=${outbox} AND proof->>'nativeOperationId'=${op} AND proof->>'requestFingerprint'=${request}`
    const c=(table,action,using,check)=>policy(table,action,controllerUser,using,check)
    await ownerTransaction(async tx=>{
      const {rows}=await tx.query(`SELECT NOT EXISTS(SELECT 1 FROM ${schema}.verified_recovery WHERE outbox_id=$1)
        AND NOT EXISTS(SELECT 1 FROM ${schema}.staged WHERE outbox_id=$1)
        AND NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions WHERE operation_id=$2)
        AND NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_work WHERE operation_id=$2) AS fresh`,[outboxId,nativeOperationId])
      assert.deepEqual(rows,[{fresh:true}])
      await tx.query(`ALTER POLICY fixture_held_controller_update ON public.crm_native_email_publication_control
        USING (singleton AND (active_operation_id IS NULL OR active_operation_id=${op}))
        WITH CHECK (singleton AND active_operation_id=${op})`)
      for(const sql of [
        c('public.crm_native_email_publication_admissions','select',admission),
        c('public.crm_native_email_publication_admissions','insert',null,`${admission} AND state='admitted' AND native_receipt IS NULL`),
        // The UPDATE policy must make live dispatched/terminal rows lockable
        // to inspect; only NULL-receipt dispatched postimages can be written.
        c('public.crm_native_email_publication_admissions','update',admission,`${admission} AND state='dispatched' AND native_receipt IS NULL`),
        c('public.crm_native_email_publication_work','select',work),
        c('public.crm_native_email_publication_work','insert',null,`${work} AND lease_fence=1`),
        c('public.crm_native_email_publication_work','update',work,'false'),
        c(`${schema}.verified_recovery`,'select',review),
        c(`${schema}.released`,'select',`outbox_id=${outbox} AND native_operation_id=${op} AND request_fingerprint=${request}`),
        policy(`${schema}.verified_recovery`,'insert',attestorUser,null,`${review} AND proof->>'holdBatchId'=${batch}::text
          AND proof->>'localId'=${local}::text AND proof->>'pipelineId'=${pipeline}::text AND proof->>'workspaceId'=${workspace}::text
          AND proof->>'nativeId'='${identity.native_id}' AND proof->>'globalId'='${identity.global_id}' AND attestor=current_user`),
        policy(`${schema}.verified_receipts`,'insert',attestorUser,null,`native_operation_id=${op} AND attestor=current_user`),
        policy('public.crm_native_email_publication_admissions','select',ordinaryUser,`operation_id=${op}`),
        policy('public.crm_native_email_publication_work','select',ordinaryUser,`operation_id=${op}`),
      ]) await tx.query(sql)
    })
  }

  try{
    const visible=await transaction(async tx=>{
      const interaction=(await tx.query('SELECT id::text FROM public.crm_interactions FOR UPDATE')).rows
      const job=(await tx.query('SELECT id::text FROM public.sync_outbox FOR UPDATE')).rows
      const hold=(await tx.query(`SELECT outbox_id::text FROM ${schema}.held`)).rows
      return {interaction,job,hold}
    })
    assert.deepEqual(visible,{interaction:[{id:localId}],job:[{id:outboxId}],hold:[{outbox_id:outboxId}]})
    await assert.rejects(transaction(tx=>tx.query('UPDATE public.app_users SET status=status WHERE false')),denied)
    await assert.rejects(transaction(tx=>tx.query('UPDATE public.crm_interactions SET subject=subject WHERE false')),denied)
    await assert.rejects(transaction(tx=>tx.query('UPDATE public.crm_native_email_publication_control SET enabled=enabled WHERE false')),denied)
    await assert.rejects(transaction(tx=>tx.query('UPDATE public.crm_native_email_publication_admissions SET native_receipt=NULL WHERE false')),denied)
    await assert.rejects(transaction(tx=>tx.query('UPDATE public.crm_native_email_publication_work SET lease_fence=2 WHERE false')),denied)
    await assert.rejects(transaction(tx=>tx.query(`INSERT INTO ${schema}.verified_receipts(native_operation_id,receipt_hash,lease_fence)
      SELECT repeat('a',64),repeat('b',64),1 WHERE false`)),denied)
    await assert.rejects(transaction(tx=>tx.query('UPDATE public.crm_interactions SET updated_at=now() WHERE id=$1',[localId])),fenced)
    await assert.rejects(attestTransaction(tx=>tx.query('SELECT * FROM public.crm_interactions')),denied)
    await assert.rejects(attestTransaction(tx=>tx.query(`SELECT * FROM ${schema}.verified_receipts`)),denied)
    await assert.rejects(ordinaryTransaction(tx=>tx.query(`SELECT * FROM ${schema}.held`)),denied)
    await assert.rejects(ordinaryTransaction(tx=>tx.query('SELECT payload FROM public.sync_outbox WHERE id=$1',[outboxId])),denied)
    await assert.rejects(ordinaryTransaction(tx=>tx.query('SELECT command FROM public.crm_native_email_publication_admissions')),denied)
    for(const restricted of [ordinaryTransaction,attestTransaction]) await restricted(async tx=>{
      const {rows}=await tx.query(`SELECT has_function_privilege(current_user,f,'EXECUTE') AS allowed
        FROM unnest($1::oid[]) AS f`,[identity.procedureOids])
      assert.deepEqual(rows,procedures.map(()=>({allowed:false})))
    })
    await assert.rejects(ordinaryTransaction(tx=>tx.query('UPDATE public.sync_outbox SET available_at=now() WHERE id=$1',[outboxId])),
      error=>error.code==='55000')
  }catch(error){await close();throw error}
  return Object.freeze({transaction,attestTransaction,attestorUser,ordinaryTransaction,pinOperation,count:()=>active,close})
}
