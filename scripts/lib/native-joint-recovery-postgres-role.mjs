// Disposable joined fixture only. Do not use these synthetic RLS policies or
// credentials as a production role installer. The current DAL reads authority
// across multiple tables (including global native-user identity uniqueness).
// A live controller still needs an independently reviewed, row-scoped DB
// boundary and retained writer fencing; never grant the app an owner login.
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {createRequire} from 'node:module'

const {Pool}=createRequire(new URL('../../app_src/package.json',import.meta.url))('pg')
const database='initial_joint_fixture'
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const hash=/^[0-9a-f]{64}$/u
const scoped=['crm_interactions','sync_outbox','crm_native_email_publication_control','crm_native_email_publication_admissions',
  'crm_native_email_publication_work','crm_legacy_email_recovery_holds','crm_legacy_email_recovery_releases']
const recoveryFunctions=[
  'public.clawpilot_crm_legacy_email_register_release(uuid,uuid,text,text,text,text,text,text)',
  'public.clawpilot_crm_legacy_email_settle_release(uuid,text,uuid,bigint)',
  'public.clawpilot_crm_legacy_email_live_relationships(uuid,uuid)',
  'public.clawpilot_crm_legacy_email_provider_identity_unambiguous(uuid,uuid)',
]
const selectColumns={
  pipeline_spaces:'id,workspace_organization_id,owner_email,reference_access_disabled',
  workspace_organizations:'id,parent_id,organization_type,is_demo',
  app_users:'email,status,suitecrm_user_id',
  app_user_organization_memberships:'organization_id,user_email,status,role,permissions,trashed_at',
  pipeline_space_members:'pipeline_id,user_email,access_role',
  crm_operator_accounts:'id,root_workspace_id,owner_email,enabled,revision',
  crm_operator_workspace_bindings:'operator_account_id,workspace_id,enabled,revision',
  crm_root_employee_access_grants:'id,operator_account_id,user_email,source_workspace_id,enabled,revision',
  crm_native_email_capability_policies:'pipeline_id,generation,policy,fingerprint',
  crm_interaction_organizations:'pipeline_id,interaction_id,organization_id,is_primary',
  crm_interaction_contacts:'pipeline_id,interaction_id,contact_id',
  crm_organizations:'pipeline_id,id,suitecrm_id,source_payload',
  crm_contacts:'pipeline_id,id,suitecrm_id,organization_id,source_payload',
}

/** These control triggers are important parts of the authority contract.
 * Narrowing their firing columns to the actual integrity inputs is compatible
 * with the recovery role; disabling them or making their SQL return no rows
 * is not. A reviewed trigger-only definer is the alternative. */
export async function inspectNativeJointRecoveryControlTriggerBoundary(tx) {
  const authority=['activation_receipt_hash','enabled','generation','native_policy_fingerprint','verified_generation']
  const required={crm_root_control_sessions:['session_revocation',...authority,'active_transition_id'],
    crm_native_initial_control_complete:['initial_enrollment_integrity',...authority,'active_initial_enrollment_id'],
    crm_native_capability_control_complete:['capability_phase_integrity',...authority,'active_transition_id']}
  const {rows}=await tx.query(`SELECT t.tgname::text AS trigger,p.prosecdef AS definer,t.tgenabled IN ('O','A') AS enabled,
    ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
      WHERE a.attrelid=t.tgrelid AND a.attnum=ANY(t.tgattr::smallint[]) ORDER BY a.attname)::text[] AS columns
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid='public.crm_native_email_publication_control'::regclass AND t.tgname=ANY($1::text[]) AND NOT t.tgisinternal
    ORDER BY t.tgname`,[Object.keys(required)])
  return Object.freeze(rows.map(row=>{
    const [dependency,...inputs]=required[row.trigger]
    return Object.freeze({trigger:row.trigger,dependency,definer:row.definer,enabled:row.enabled,columns:Object.freeze(row.columns),
      authorityColumnsOnly:inputs.every(column=>row.columns.includes(column))
        && !row.columns.some(column=>['active_operation_id','updated_at'].includes(column))})
  }))
}

/** The parent owns and destroys the entire PostgreSQL fixture cluster. Call
 * only after staging the exact synthetic held row, before publish. Pass the
 * returned transaction directly to createPrivateLegacyEmailRecoveryPersistence
 * for BOTH initial and resolution instances; do not fall back to owner SQL.
 * Keep count() in the fixture's no-DB-transaction-during-transport assertion.
 * After the final readbacks call close() to drain the two synthetic logins.
 */
export async function openNativeJointRecoveryPostgresRoles({ownerTransaction,ownerPool,selection,archive}) {
  const {holdId,outboxId,nativeOperationId}=selection
  const {localId,retiredOutboxId,selected}=archive
  const {pipelineId}=selected
  const nativeId='6d7bbd67-dde9-4e53-89fd-29a86017d23a',globalId='gi9799999'
  assert.ok(typeof ownerTransaction==='function'&&[holdId,outboxId,localId,retiredOutboxId,pipelineId,nativeId].every(v=>uuid.test(v)))
  assert.ok(hash.test(nativeOperationId)&&outboxId!==retiredOutboxId)
  const endpoint=ownerPool.options
  assert.ok(endpoint.host==='127.0.0.1'&&endpoint.database===database&&Number.isInteger(Number(endpoint.port))&&Number(endpoint.port)>1023)
  const suffix=randomBytes(6).toString('hex'),privateRole=`crm_joint_recovery_${suffix}`,ordinaryRole=`crm_joint_ordinary_${suffix}`
  const password=()=>randomBytes(32).toString('hex'),privatePassword=password(),ordinaryPassword=password()
  const op=`'${nativeOperationId}'`,hold=`'${holdId}'::uuid`,outbox=`'${outboxId}'::uuid`,retired=`'${retiredOutboxId}'::uuid`,
    local=`'${localId}'::uuid`,pipeline=`'${pipelineId}'::uuid`
  const exactAdmission=`operation_id=${op} AND local_id=${local} AND pipeline_id=${pipeline} AND native_id='${nativeId}' AND global_id='${globalId}'`
  const privatePolicy=(table,action,using,check)=>`CREATE POLICY fixture_recovery_${action} ON public.${table} FOR ${action.toUpperCase()}
    TO ${privateRole}${using?` USING (${using})`:''}${check?` WITH CHECK (${check})`:''}`
  const ordinaryPolicy=(table,action,using,check)=>`CREATE POLICY fixture_ordinary_${action} ON public.${table} FOR ${action.toUpperCase()}
    TO ${ordinaryRole} USING (${using})${check?` WITH CHECK (${check})`:''}`

  await ownerTransaction(async tx=>{
    const {rows}=await tx.query(`SELECT current_database() AS database,current_user=session_user AS direct,
      (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owner_superuser,
      EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h
        JOIN public.crm_interactions i ON i.id=h.local_id JOIN public.sync_outbox o ON o.id=h.outbox_id
        WHERE h.operation_id=$1 AND h.outbox_id=$2 AND h.retired_outbox_id=$3 AND h.local_id=$4 AND h.pipeline_id=$5
        AND h.native_id=$6 AND h.global_id=$7 AND i.source_key LIKE 'joint-recovery:%'
        AND i.source_payload->>'fixtureOnly'='true' AND o.available_at='infinity'::timestamptz) AS exact`,
    [holdId,outboxId,retiredOutboxId,localId,pipelineId,nativeId,globalId])
    assert.deepEqual(rows,[{database,direct:true,owner_superuser:true,exact:true}])
    const boundary=await inspectNativeJointRecoveryControlTriggerBoundary(tx)
    const blocking=boundary.filter(row=>!row.enabled||!row.definer&&!row.authorityColumnsOnly)
    assert.deepEqual(blocking,[],'Restricted recovery needs scoped control-trigger execution, not wider invoker grants')
    const catalog=await tx.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_catalog.pg_class
      WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[])`,[scoped])
    assert.equal(catalog.rows.length,scoped.length)
    assert.ok(catalog.rows.every(r=>r.relrowsecurity===false&&r.relforcerowsecurity===false),'Fixture must start without row policies')
    for(const [role,secret] of [[privateRole,privatePassword],[ordinaryRole,ordinaryPassword]])
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1`)
    await tx.query(`GRANT USAGE ON SCHEMA public TO ${privateRole},${ordinaryRole}`)
    for(const table of scoped)await tx.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`)
    for(const [table,columns] of Object.entries(selectColumns))
      await tx.query(`GRANT SELECT (${columns}) ON public.${table} TO ${privateRole}`)
    // SELECT * plus a full row hash is intentional in the source DAL; RLS
    // limits it to the exact synthetic hold and rows needed for collision proof.
    await tx.query(`GRANT SELECT ON ${scoped.map(t=>`public.${t}`).join(',')} TO ${privateRole};
      GRANT UPDATE (updated_at) ON public.crm_interactions,public.sync_outbox TO ${privateRole};
      GRANT UPDATE (active_operation_id,updated_at) ON public.crm_native_email_publication_control TO ${privateRole};
      GRANT INSERT (operation_id,pipeline_id,local_id,native_id,global_id,generation,native_policy_fingerprint,command_hash,
        audience_fingerprint,command,allowed_reader_ids,request_fingerprint),UPDATE (state,native_receipt,updated_at)
        ON public.crm_native_email_publication_admissions TO ${privateRole};
      GRANT INSERT (operation_id,request_fingerprint,work_kind,context,context_hash,lease_owner,lease_fence,lease_until),
        UPDATE (lease_owner,lease_fence,lease_until,updated_at) ON public.crm_native_email_publication_work TO ${privateRole};
      GRANT EXECUTE ON FUNCTION ${recoveryFunctions.join(',')} TO ${privateRole};
      GRANT SELECT (id),UPDATE (available_at,updated_at,locked_at,lock_token,status,attempts,last_error)
        ON public.sync_outbox TO ${ordinaryRole};
      GRANT SELECT,UPDATE (updated_at) ON public.crm_native_email_publication_control TO ${ordinaryRole};
      GRANT SELECT (operation_id,state) ON public.crm_native_email_publication_admissions TO ${ordinaryRole};
      GRANT SELECT (operation_id,context,work_kind) ON public.crm_native_email_publication_work TO ${ordinaryRole}`)
    for(const sql of [
      privatePolicy('crm_interactions','select',`id=${local}`),
      privatePolicy('crm_interactions','update',`id=${local}`,'false'),
      privatePolicy('sync_outbox','select',`id IN (${outbox},${retired}) OR (target_system='suitecrm' AND aggregate_type='crm_interactions' AND aggregate_id=${local}::text)`),
      privatePolicy('sync_outbox','update',`id=${outbox}`,'false'),
      privatePolicy('crm_native_email_publication_control','select','singleton'),
      privatePolicy('crm_native_email_publication_control','update',`singleton AND (active_operation_id IS NULL OR active_operation_id=${op})`,
        `singleton AND (active_operation_id IS NULL OR active_operation_id=${op})`),
      privatePolicy('crm_native_email_publication_admissions','select',`operation_id=${op} OR local_id=${local} OR lower(native_id)='${nativeId}' OR lower(global_id)='${globalId}'`),
      privatePolicy('crm_native_email_publication_admissions','insert',null,exactAdmission),
      privatePolicy('crm_native_email_publication_admissions','update',exactAdmission,exactAdmission),
      privatePolicy('crm_native_email_publication_work','select',`operation_id=${op}`),
      privatePolicy('crm_native_email_publication_work','insert',null,`operation_id=${op} AND work_kind='outbox' AND context->>'outboxId'=${outbox}::text`),
      privatePolicy('crm_native_email_publication_work','update',`operation_id=${op}`,`operation_id=${op}`),
      privatePolicy('crm_legacy_email_recovery_holds','select',`operation_id=${hold} AND outbox_id=${outbox}`),
      privatePolicy('crm_legacy_email_recovery_releases','select',`hold_id=${hold} AND native_operation_id=${op}`),
      ordinaryPolicy('sync_outbox','select','true'),ordinaryPolicy('sync_outbox','update','true','true'),
      ordinaryPolicy('crm_native_email_publication_control','select','singleton'),
      ordinaryPolicy('crm_native_email_publication_control','update','singleton','false'),
      ordinaryPolicy('crm_native_email_publication_admissions','select','true'),ordinaryPolicy('crm_native_email_publication_work','select','true'),
    ])await tx.query(sql)
  })

  let active=0
  const connect=(user,password)=>new Pool({host:endpoint.host,port:endpoint.port,database,user,password,ssl:false,max:1,
    application_name:'clawpilot-joint-private-role-fixture',connectionTimeoutMillis:3000,statement_timeout:8000,
    lock_timeout:2500,idle_in_transaction_session_timeout:10000})
  const privatePool=connect(privateRole,privatePassword),ordinaryPool=connect(ordinaryRole,ordinaryPassword)
  const run=(pool,role)=>async action=>{
    const tx=await pool.connect();let broken=false
    active++
    try{
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await tx.query("SET LOCAL search_path=pg_catalog,public; SET LOCAL TIME ZONE 'UTC'")
      const proof=await tx.query(`SELECT current_database() AS database,current_user AS role,session_user=current_user AS direct,
        (SELECT NOT (rolsuper OR rolcreaterole OR rolbypassrls) FROM pg_catalog.pg_roles WHERE rolname=current_user) AS limited`)
      assert.deepEqual(proof.rows,[{database,role,direct:true,limited:true}])
      const result=await action(tx);await tx.query('COMMIT');return result
    }catch(error){try{await tx.query('ROLLBACK')}catch{broken=true}throw error}
    finally{active--;tx.release(broken)}
  }
  const transaction=run(privatePool,privateRole),ordinary=run(ordinaryPool,ordinaryRole)
  const denied=error=>error.code==='42501'
  const close=()=>Promise.all([privatePool.end(),ordinaryPool.end()])
  try{
    const visible=await transaction(async tx=>{
      const exact=(await tx.query('SELECT id::text FROM public.crm_interactions FOR UPDATE')).rows
      const parked=(await tx.query('SELECT id::text FROM public.sync_outbox WHERE id=$1 FOR UPDATE',[outboxId])).rows
      return {exact,parked}
    })
    assert.deepEqual(visible,{exact:[{id:localId}],parked:[{id:outboxId}]})
    await assert.rejects(transaction(tx=>tx.query('UPDATE public.app_users SET status=status WHERE false')),denied)
    await assert.rejects(transaction(tx=>tx.query('UPDATE public.crm_interactions SET subject=subject WHERE false')),denied)
    await assert.rejects(transaction(tx=>tx.query('UPDATE public.crm_native_email_publication_control SET enabled=enabled')),denied)
    await assert.rejects(transaction(tx=>tx.query('UPDATE public.crm_interactions SET updated_at=now() WHERE id=$1',[localId])),
      error=>['42501','55000'].includes(error.code))
    await assert.rejects(ordinary(tx=>tx.query('SELECT * FROM public.crm_legacy_email_recovery_holds')),denied)
    await assert.rejects(ordinary(tx=>tx.query('SELECT payload FROM public.sync_outbox WHERE id=$1',[outboxId])),denied)
    await assert.rejects(ordinary(tx=>tx.query('SELECT command FROM public.crm_native_email_publication_admissions')),denied)
    await ordinary(async tx=>{
      const result=await tx.query('SELECT has_function_privilege(current_user,f,\'EXECUTE\') AS allowed FROM unnest($1::text[]) AS f',[recoveryFunctions])
      assert.deepEqual(result.rows,recoveryFunctions.map(()=>({allowed:false})))
    })
    // Simulate even a direct ordinary queue write, stronger than the normal
    // claim query's infinity/admission exclusion. Leave the held row unchanged.
    await assert.rejects(ordinary(tx=>tx.query('UPDATE public.sync_outbox SET available_at=now() WHERE id=$1',[outboxId])),
      error=>error.code==='55000')
  }catch(error){await close();throw error}
  return Object.freeze({transaction,count:()=>active,close})
}
