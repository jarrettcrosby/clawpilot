// Combined actual app runtime + PostgreSQL + actual SuiteCRM OAuth/routes.
// Session authentication, existing-account lookup, local network tunnelling
// and downstream permission-sync/audit sinks are explicit fixture edges.
// No production configuration or external provider is used.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,resolve} from 'node:path'
import * as crypto from 'node:crypto'

/** Disposable reviewed initial enrollment, never a production entry point.
 * Existing native bindings may already be beyond generation one. Align the
 * disabled app control BEFORE policy insertion; guard and activation remain
 * in the same real PostgreSQL transaction and roll back together. */
export async function enrollCombinedNativeSnapshot(transaction,before,digest){
  await transaction(async tx=>{
    const changed=await tx.query(`UPDATE crm_native_email_publication_control SET generation=$1
      WHERE singleton AND NOT enabled AND active_operation_id IS NULL AND active_transition_id IS NULL`,[before.generation])
    assert.equal(changed.rowCount,1,'Initial fixture enrollment requires disabled, drained control')
    for(const b of before.bindings)if(b.capability_policy_json!==null)await tx.query(
      'INSERT INTO crm_native_email_capability_policies(pipeline_id,generation,policy,fingerprint) VALUES($1,$2,$3::jsonb,$4)',
      [b.pipeline_id,b.generation,b.capability_policy_json,b.capability_policy_fingerprint])
    await tx.query(`UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,
      native_policy_fingerprint=$1,activation_receipt_hash=$2 WHERE singleton`,
    [before.nativePolicyFingerprint,digest(['synthetic-combined-initial-enrollment',before])])
  })
}

/** Consistent disposable app intent for an existing native baseline. Legacy
 * scopes have no future policy: require one uniform observed edit/delete set
 * rather than silently labelling every retained native editor as a viewer. */
export function combinedFixtureEditors(binding,capabilities){
  if(binding.capability_policy_json!==null)return new Set(JSON.parse(binding.capability_policy_json).futureCreate.edit)
  const rows=capabilities.filter(row=>row.pipelineId===binding.pipeline_id),readers=JSON.parse(binding.readers_json)
  const writers=rows[0]?.capabilities.edit??[binding.owner_id]
  assert.ok(writers.includes(binding.owner_id)&&writers.every(id=>readers.includes(id)),'Legacy fixture writers must belong to its reviewed reader scope')
  for(const row of rows){assert.deepEqual(row.capabilities.edit,writers,'Legacy fixture historical edits are not a uniform role mapping')
    assert.deepEqual(row.capabilities.delete,writers,'Legacy fixture edit/delete rights cannot be collapsed to an inferred role')}
  return new Set(writers)
}

/** Private fixture metrics only. No arbitrary native output/identity can enter
 * the result or error artifact through this numeric profiling side channel. */
export function boundedNativeAclProfile(value){
  const keys=(row,expected)=>assert.deepEqual(Object.keys(row).sort(),[...expected].sort())
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value))
  keys(value,['version','emailCount','principalCount','constructorIterations','fullScan','usersAndHydration','factoryConstructor','directConstructor'])
  assert.equal(value.version,2)
  for(const field of ['emailCount','principalCount'])assert.ok(Number.isInteger(value[field])&&value[field]>=1&&value[field]<=500)
  assert.equal(value.constructorIterations,1000)
  for(const name of ['fullScan','usersAndHydration','factoryConstructor','directConstructor']){
    const row=value[name];assert.ok(row&&typeof row==='object'&&!Array.isArray(row))
    keys(row,['milliseconds','queries','preparedExecutions','gcRuns','gcCollected','peakBytes'])
    assert.ok(Number.isFinite(row.milliseconds)&&row.milliseconds>=0&&row.milliseconds<=30000)
    for(const field of ['queries','preparedExecutions','gcRuns','gcCollected','peakBytes'])
      assert.ok(['queries','preparedExecutions'].includes(field)&&row[field]===null||Number.isSafeInteger(row[field])&&row[field]>=0&&row[field]<=1e10)
  }
  return value
}

// A scale revoke may commit while its grant safely holds/rolls back. That
// restrictive state is not a valid combined-app baseline. Validate the real
// receipts before handoff, without relaxing coverage or the native deadline.
// Named synthetic history profiles, not arbitrary capacity claims. Preserve
// the original 318 baseline; 334 covers the read-only 329-row production
// snapshot plus the exact five reviewed recovery candidates. Both retain the
// fixture's full 12-principal matrix and the native five-second deadline.
export function nativeFixtureScaleEmailCount(value=318){
  assert.ok(value===318||value===334,'Use the original 318 or reviewed 334 synthetic history profile')
  return value
}
export function assertCombinedNativeScaleHandoff(output,expectedEmailCount=318){
  expectedEmailCount=nativeFixtureScaleEmailCount(expectedEmailCount)
  const lines=output.split('\n')
  const read=prefix=>{const selected=lines.filter(line=>line.startsWith(prefix));assert.equal(selected.length,1,`One ${prefix} receipt required`)
    const value=JSON.parse(selected[0].slice(prefix.length))
    assert.deepEqual(Object.keys(value).sort(),['status','emailCount','principalCount','durationMs','commitDeadlineSeconds','productionScaleProven'].sort())
    assert.equal(value.emailCount,expectedEmailCount);assert.ok(Number.isInteger(value.principalCount)&&value.principalCount>=12&&value.principalCount<=500)
    assert.equal(value.commitDeadlineSeconds,5);assert.equal(value.productionScaleProven,false)
    assert.ok(Number.isFinite(value.durationMs)&&value.durationMs>=0&&value.durationMs<=30000)
    assert.equal(value.status,'committed',`Native scale handoff held: ${prefix}${value.status}; ${value.durationMs.toFixed(3)} ms; unchanged 5000 ms cap`)
    // This outer stopwatch includes return overhead. The actual native
    // transaction enforces the five-second cap; do not invent another clock.
    return value}
  const revoke=read('NATIVE_AUTHORITY_V2_SCALE='),grant=read('NATIVE_AUTHORITY_V2_SCALE_GRANT=')
  assert.equal(lines.filter(line=>line==='NATIVE_AUTHORITY_V2_SCALE_BOTH_PASSED=1').length,1,'Both timed native commits must pass before app handoff')
  return{revoke,grant}
}

export async function runNativeAppPostgresAcceptance({appName,pgName,keys,root:repositoryRoot}){
  const require=createRequire(resolve(repositoryRoot,'app_src/package.json')),ts=require('typescript'),{Pool}=require('pg')
  const docker=(args,options={})=>execFileSync('docker',args,{encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024,stdio:['pipe','pipe','pipe'],...options})
  const config=JSON.parse(docker(['exec',appName,'cat','/tmp/native-app-pg-config.json']))
  assert.match(config.clientId,/^[a-f0-9-]{36}$/);assert.ok(config.identities.length>0&&config.identities.length<=500)
  const port=docker(['port',pgName,'5432/tcp']).match(/^127\.0\.0\.1:(\d+)\s*$/)?.[1];assert.ok(port)
  const pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'combined_fixture_only',database:'combined_fixture',
    max:4,connectionTimeoutMillis:1000,statement_timeout:10000})
  const boundaryFailures=[]
  const failure=(stage,error)=>{const code=typeof error?.code==='string'&&/^[A-Z0-9]{5}$/.test(error.code)?error.code:null
    boundaryFailures.push({stage,name:/^[A-Za-z]{1,64}$/.test(String(error?.name))?String(error.name):null,code,
      databaseMessage:code?String(error.message).slice(0,200):null})}
  const query=(text,values)=>pool.query(text,values)
  const transaction=async run=>{const tx=await pool.connect();try{await tx.query('BEGIN');const value=await run(tx);await tx.query('COMMIT');return value}
    catch(error){failure('postgres-transaction',error);await tx.query('ROLLBACK');throw error}finally{tx.release()}}
  const env=Object.fromEntries(Object.entries({BASE_URL:'https://combined-native.invalid',CLIENT_ID:config.clientId,CLIENT_SECRET:config.clientSecret,
    KEY_ID:config.keyId,INSTANCE_ID:config.nativeInstanceId,SERVICE_USER_ID:config.serviceUserId,
    PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()}).map(([key,value])=>['CLAWPILOT_NATIVE_EMAIL_AUTHORITY_'+key,value]))
  const modules=new Map(),overrides=new Map(),sourcePath=p=>resolve(repositoryRoot,p)
  function load(path){path=resolve(path);if(overrides.has(path))return overrides.get(path);if(modules.has(path))return modules.get(path).exports
    const module={exports:{}};modules.set(path,module)
    const code=ts.transpileModule(readFileSync(path,'utf8'),{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
    new Function('module','exports','require','process',code)(module,module.exports,name=>{
      if(name.startsWith('@/lib/'))return load(sourcePath('app_src/lib/'+name.slice(6)+'.ts'))
      if(!name.startsWith('.'))return require(name)
      if(name.endsWith('.mjs'))return require(resolve(dirname(path),name))
      return load(resolve(dirname(path),name.endsWith('.ts')?name:name+'.ts'))
    },{env})
    return module.exports
  }
  overrides.set(sourcePath('app_src/lib/persistence/postgres.ts'),{query,withTransaction:transaction})
  overrides.set(sourcePath('app_src/lib/persistence/pipeline.ts'),{enqueuePipelinePermissionSyncWithClient:(tx,payload)=>
    tx.query("INSERT INTO combined_effects(kind,payload) VALUES('permission-sync',$1::jsonb)",[JSON.stringify(payload)])})
  overrides.set(sourcePath('app_src/lib/auditWriter.ts'),{recordAuditEvent:(payload,tx)=>
    tx.query("INSERT INTO combined_effects(kind,payload) VALUES('audit',$1::jsonb)",[JSON.stringify(payload)])})
  const requests=[],guardCodes=[]
  let phase='connect',nativeTokenId=null,loseGrantReply=false,discardedGrantReply=false
  const protocolPath=sourcePath('app_src/lib/crm/nativeEmailPublication.ts'),unwrappedProtocol=load(protocolPath)
  overrides.set(protocolPath,{...unwrappedProtocol,requireNativeEmail:(condition,code)=>{
    if(!condition)guardCodes.push(code)
    return unwrappedProtocol.requireNativeEmail(condition,code)
  }})
  async function bridgeFetch(url,options){
    const parsed=new URL(String(url));assert.equal(parsed.origin,'https://combined-native.invalid')
    assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store')
    options.signal?.throwIfAborted()
    const input=JSON.stringify({path:parsed.pathname,body:options.body,headers:options.headers})
    const result=JSON.parse(docker(['exec','--interactive',appName,'php','/fixture/native-app-pg-http.php'],{input}))
    if(parsed.pathname==='/Api/access_token'&&result.status===200){
      // Retain only a disposable token's verified native jti for a read-only
      // CLI diagnostic if the real HTTP boundary is held. Never emit bearer.
      const jwt=JSON.parse(result.body).access_token
      if(typeof jwt==='string'&&jwt.split('.').length===3){const claims=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url').toString());
        if(typeof claims.jti==='string'&&/^[a-f0-9]{80}$/.test(claims.jti))nativeTokenId=claims.jti}
    }
    const commandPhase=/\/(?:execute|resolve)$/.test(parsed.pathname)?JSON.parse(options.body).phase:null
    const resolved=parsed.pathname.endsWith('/resolve')&&result.status===200?{replayed:JSON.parse(result.body).replayed}:{}
    requests.push({path:parsed.pathname,status:result.status,...(commandPhase?{phase:commandPhase}:{}),...resolved})
    if(loseGrantReply&&parsed.pathname.endsWith('/execute')&&commandPhase==='grant'&&result.status===200){
      loseGrantReply=false;discardedGrantReply=true
      throw new TypeError('Synthetic lost response after actual native grant HTTP 200')
    }
    return new Response(result.body,{status:result.status,headers:result.headers})
  }
  const transportPath=sourcePath('app_src/lib/crm/nativeEmailAuthorityTransport.ts'),transport=load(transportPath)
  overrides.set(transportPath,{...transport,createSuiteCrmNativeEmailAuthorityClient:input=>transport.createSuiteCrmNativeEmailAuthorityClient(input,bridgeFetch)})
  // Reviewed fixture profile: native phases still have their unchanged five-
  // second commit deadline; the PG lease is 20 seconds solely to exercise real
  // expiry without a two-minute test sleep. Production default remains 120.
  const storePath=sourcePath('app_src/lib/crm/nativeEmailAuthorityTransitionPostgres.ts'),adapter=load(storePath)
  class FixtureStore extends adapter.PostgresNativeEmailAuthorityTransitionStore{
    constructor(tx,options,effects){super(tx,{...options,leaseSeconds:20},effects)}
    async settlePhase(...args){try{return await super.settlePhase(...args)}catch(error){failure('settle-phase',error);throw error}}
    async commitAppChange(...args){try{return await super.commitAppChange(...args)}catch(error){failure('commit-app',error);throw error}}
  }
  overrides.set(storePath,{...adapter,PostgresNativeEmailAuthorityTransitionStore:FixtureStore})
  const native=transport.createSuiteCrmNativeEmailAuthorityClient({baseUrl:'https://combined-native.invalid',clientId:config.clientId,clientSecret:config.clientSecret},bridgeFetch)
  const runtime=load(sourcePath('app_src/lib/crm/nativeEmailAuthorityRuntime.ts'))
  const userRuntime=load(sourcePath('app_src/lib/crm/nativeEmailWorkspaceUserRuntime.ts'))
  const protocol=load(sourcePath('app_src/lib/crm/nativeEmailPublication.ts'))
  const recovery=load(sourcePath('app_src/lib/crm/nativeEmailSharingRecovery.ts'))
  const readInspection=load(sourcePath('app_src/lib/crm/nativeEmailAuthorityPlan.ts')).readNativeEmailAuthorityInspection
  const email=id=>'native-'+id.toLowerCase()+'@example.test',checks=[]
  let nativeAclProfile=null,inspectionSelection=null
  const check=async(name,run)=>{phase=name;await run();checks.push(name);console.log('PASS '+name)}
  try{
    const deadline=Date.now()+30000
    while(true){try{await query('SELECT 1');break}catch(error){if(Date.now()>=deadline)throw error;await new Promise(r=>setTimeout(r,100))}}
    assert.equal((await query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count,'0')
    phase='rollback-only-native-acl-cost-profile'
    nativeAclProfile=boundedNativeAclProfile(JSON.parse(docker(['exec',appName,'php','/fixture/native-app-pg.php','profile-acl'])))
    console.log('NATIVE_ACL_COST_PROFILE='+JSON.stringify(nativeAclProfile))
    phase='actual-native-inspection'
    const before=readInspection(await native.inspect()),bindings=before.bindings
    const contentBefore=JSON.parse(docker(['exec',appName,'php','/fixture/native-app-pg.php','content'])).contentDigest
    phase='actual-native-owner-scope-selection'
    inspectionSelection={bindingCount:bindings.length,
      ownedV2BindingCount:bindings.filter(b=>b.capability_policy_json!==null&&b.owner_id===config.serviceUserId).length,
      scopeEmailCount:0,nonOwnerReaderCount:0,fullyReadOnlyReaderCount:0}
    const binding=bindings.find(b=>b.capability_policy_json!==null&&b.owner_id===config.serviceUserId)
    assert.ok(binding,'Actual v2 owner scope required')
    phase='actual-native-read-only-member-selection'
    const scopeEmails=before.capabilities.filter(c=>c.pipelineId===binding.pipeline_id)
    const nonOwners=JSON.parse(binding.readers_json).filter(id=>id!==binding.owner_id)
    const readOnly=nonOwners.filter(id=>scopeEmails.every(c=>!c.capabilities.edit.includes(id)&&!c.capabilities.delete.includes(id)))
    inspectionSelection={...inspectionSelection,scopeEmailCount:scopeEmails.length,
      nonOwnerReaderCount:nonOwners.length,fullyReadOnlyReaderCount:readOnly.length}
    const reader=readOnly[0]
    assert.ok(reader,'Actual read-only native member required')
    phase='disposable-schema-and-exact-native-metadata'
    assert.ok(before.principalSuiteCrmUserIds.includes(config.existingIdentityLink.userId))
    assert.ok(before.bindings.every(b=>!JSON.parse(b.readers_json).includes(config.existingIdentityLink.userId)))
    await query(`CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,organization_id uuid,updated_at timestamptz DEFAULT now(),display_name text,
        reference_code text,crm_user_enabled boolean NOT NULL DEFAULT false,suitecrm_username text);
      CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean NOT NULL DEFAULT false,parent_id uuid,
        organization_type text NOT NULL DEFAULT 'root',name text NOT NULL DEFAULT 'Combined native fixture');
      CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean NOT NULL DEFAULT false,name text NOT NULL);
      CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,shared_by text,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(pipeline_id,user_email));
      CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,
        trashed_by text,pre_trash_status text,updated_by text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(user_email,organization_id));
      CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,suitecrm_module text,suitecrm_synced_at timestamptz,subject text DEFAULT 'Synthetic',description text DEFAULT '');
      CREATE TABLE sync_outbox(target_system text,operation text,status text);
      CREATE TABLE app_sessions(effective_user_email text,active_workspace_organization_id uuid,revoked_at timestamptz,revoked_reason text);
      CREATE TABLE combined_effects(kind text,payload jsonb);`)
    for(const workspace of new Set(bindings.map(b=>b.workspace_id)))await query('INSERT INTO workspace_organizations(id) VALUES($1)',[workspace])
    for(const id of before.principalSuiteCrmUserIds)await query("INSERT INTO app_users(email,status,suitecrm_user_id,role,permissions,organization_id) VALUES($1,'active',$2,'member','{}',$3)",
      [email(id),id===config.existingIdentityLink.userId?null:id,bindings[0].workspace_id])
    await query('UPDATE app_users SET reference_code=$2,crm_user_enabled=true WHERE email=$1',[email(config.existingIdentityLink.userId),config.existingIdentityLink.globalId])
    for(const b of bindings){
      await query('INSERT INTO pipeline_spaces VALUES($1,$2,$3,false,$4)',[b.pipeline_id,email(b.owner_id),b.workspace_id,'Combined synthetic pipeline'])
      const readers=JSON.parse(b.readers_json),editors=combinedFixtureEditors(b,before.capabilities)
      for(const id of readers){const role=id===b.owner_id?'owner':'member'
        await query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,status,role,permissions,trashed_at)
          VALUES($1,$2,'active',$3,'{}',NULL) ON CONFLICT(user_email,organization_id) DO UPDATE
          SET role=CASE WHEN excluded.role='owner' THEN 'owner' ELSE app_user_organization_memberships.role END`,[email(id),b.workspace_id,role])
        if(id!==b.owner_id)await query("INSERT INTO pipeline_space_members VALUES($1,$2,$3,$4,now(),now())",
          [b.pipeline_id,email(id),editors.has(id)?'editor':'viewer',email(b.owner_id)])
      }
    }
    for(const row of config.identities)await query("INSERT INTO crm_interactions(id,pipeline_id,suitecrm_id,reference_code,suitecrm_module,suitecrm_synced_at) VALUES($1,$2,$3,$4,'Emails',now())",
      [row.local_id,row.pipeline_id,row.email_id,row.global_id])
    phase='actual-postgres-migrations'
    for(const file of ['0375_crm_native_email_publication_admission.sql','0376_crm_native_email_publication_work_context.sql',
      '0377_crm_native_email_authority_transitions.sql','0378_crm_native_email_capability_policies.sql','0379_crm_native_email_app_only_lifecycle.sql',
      '0380_crm_native_email_grant_attempts.sql','0381_crm_native_email_identity_quiescence.sql','0382_crm_native_email_mapped_settings.sql',
      '0383_crm_native_email_user_eligibility.sql','0384_crm_native_email_member_role_changes.sql','0386_crm_native_email_first_access_grants.sql',
      '0387_crm_native_email_shared_app_only_lifecycle.sql','0391_crm_native_email_unshared_workspace_enrollment.sql',
      '0392_crm_root_employee_access_registry.sql','0394_crm_native_root_source_fences.sql','0395_crm_native_email_existing_identity_links.sql',
      '0396_crm_root_native_read_receipts.sql','0397_crm_native_root_registry_changes.sql']){
      phase='actual-postgres-migration:'+file
      await transaction(tx=>tx.query(readFileSync(sourcePath('db/migrations/'+file),'utf8')))
    }
    // Disposable initial enrollment only, before activation. No production
    // activation authority or automatic adoption is inferred from this seed.
    phase='reviewed-synthetic-initial-enrollment'
    // Explicit root employee intent must preserve the existing native reader,
    // not create an extra reader/principal. Seed only this isolated test scope
    // before enrollment; production registry changes need their own protocol.
    const rootId='00000000-0000-4000-8000-999999999991',accountId='00000000-0000-4000-8000-999999999992'
    assert.ok(!bindings.some(b=>b.workspace_id===rootId))
    await query('INSERT INTO workspace_organizations(id) VALUES($1)',[rootId])
    for(const [userId,role]of[[binding.owner_id,'owner'],[reader,'member']])await query(
      `INSERT INTO app_user_organization_memberships(user_email,organization_id,status,role,permissions,trashed_at)
       VALUES($1,$2,'active',$3,'{"viewCrm":true}',NULL)`,[email(userId),rootId,role])
    await query(`INSERT INTO crm_operator_accounts(id,root_workspace_id,owner_email,enabled,created_by,updated_by)
      VALUES($1,$2,$3,true,$3,$3)`,[accountId,rootId,email(binding.owner_id)])
    await query(`INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by)
      VALUES($1,$2,$3,true,$3,$3)`,[accountId,binding.workspace_id,email(binding.owner_id)])
    await query(`INSERT INTO crm_root_employee_access_grants(operator_account_id,user_email,source_workspace_id,enabled,created_by,updated_by)
      VALUES($1,$2,$3,true,$4,$4)`,[accountId,email(reader),rootId,email(binding.owner_id)])
    await query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,status,role,permissions,trashed_at)
      VALUES($1,$2,'active','member','{"viewCrm":true}',NULL)`,[email(config.existingIdentityLink.userId),rootId])
    await query(`INSERT INTO crm_root_employee_access_grants(operator_account_id,user_email,source_workspace_id,enabled,created_by,updated_by)
      VALUES($1,$2,$3,true,$4,$4)`,[accountId,email(config.existingIdentityLink.userId),rootId,email(binding.owner_id)])
    await enrollCombinedNativeSnapshot(transaction,before,protocol.nativeEmailDigest)
    const selected={actorEmail:email(binding.owner_id),workspaceId:binding.workspace_id,pipelineId:binding.pipeline_id,userEmail:email(reader),accessRole:'editor'}
    await check('real app runtime and PostgreSQL drive actual OAuth native revoke, app commit, then editor grant',async()=>{
      assert.equal(await runtime.changePipelineMemberWithNativeAuthority(selected),true)
      assert.equal((await query('SELECT access_role FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2',[selected.pipelineId,selected.userEmail])).rows[0].access_role,'editor')
      const state=readInspection(await native.inspect())
      for(const entry of state.capabilities.filter(e=>e.pipelineId===binding.pipeline_id)){
        assert.ok(entry.capabilities.view.includes(reader));assert.ok(entry.capabilities.edit.includes(reader));assert.ok(entry.capabilities.delete.includes(reader))}
      assert.equal((await query('SELECT active_transition_id FROM crm_native_email_publication_control')).rows[0].active_transition_id,null)
      assert.equal((await query('SELECT count(*) FROM combined_effects')).rows[0].count,'2')
    })
    await check('completed identical request is idempotent with no extra native call or app audit',async()=>{
      const count=requests.length;assert.equal(await runtime.changePipelineMemberWithNativeAuthority(selected),true);assert.equal(requests.length,count)
      assert.equal((await query('SELECT count(*) FROM combined_effects')).rows[0].count,'2')
      assert.equal(await recovery.getPendingPipelineSharingChange(selected.actorEmail,selected.workspaceId),null)
    })
    await check('real native demotion preserves reads, removes historical writes and returns matching PostgreSQL pins',async()=>{
      assert.equal(await runtime.changePipelineMemberWithNativeAuthority({...selected,accessRole:'viewer'}),true)
      const after=readInspection(await native.inspect()),app=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
      for(const entry of after.capabilities.filter(e=>e.pipelineId===binding.pipeline_id)){
        assert.ok(entry.capabilities.view.includes(reader));assert.ok(!entry.capabilities.edit.includes(reader));assert.ok(!entry.capabilities.delete.includes(reader))}
      assert.equal(Number(app.generation),after.generation);assert.equal(app.native_policy_fingerprint,after.nativePolicyFingerprint)
      assert.equal(app.active_transition_id,null);assert.equal(app.active_operation_id,null)
      assert.equal((await query('SELECT count(*) FROM combined_effects')).rows[0].count,'4')
      assert.equal(JSON.parse(docker(['exec',appName,'php','/fixture/native-app-pg.php','content'])).contentDigest,contentBefore)
      assert.equal((await query("SELECT count(*) FROM crm_native_email_authority_phases WHERE state='committed'")).rows[0].count,'4')
    })
    await check('lost actual native grant response retains owned discoverable pending state and cannot steal its live lease',async()=>{
      loseGrantReply=true
      await assert.rejects(()=>runtime.changePipelineMemberWithNativeAuthority(selected),error=>error instanceof runtime.NativeEmailAccessPendingError)
      assert.equal(discardedGrantReply,true,'Only an actually committed native HTTP 200 may be the injected lost response')
      const control=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0],tid=control.active_transition_id
      assert.match(tid,/^[a-f0-9]{64}$/)
      assert.equal((await query('SELECT access_role FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2',
        [selected.pipelineId,selected.userEmail])).rows[0].access_role,'editor')
      assert.equal((await query('SELECT count(*) FROM combined_effects')).rows[0].count,'6')
      const pending=await recovery.getPendingPipelineSharingChange(selected.actorEmail,selected.workspaceId)
      assert.equal(pending.transitionId,tid);assert.equal(pending.accessRole,'editor');assert.equal(pending.userEmail,selected.userEmail)
      const lease=await query(`SELECT state,lease_owner::text,lease_fence::text,lease_until::text,lease_until>clock_timestamp() AS live
        FROM crm_native_email_authority_phases WHERE transition_id=$1 AND phase='grant'`,[tid])
      assert.equal(lease.rows[0].state,'unknown');assert.equal(lease.rows[0].live,true)
      const requestCount=requests.length
      await assert.rejects(()=>recovery.resumePipelineSharingChange(selected.actorEmail,selected.workspaceId,tid),
        error=>error instanceof runtime.NativeEmailAccessPendingError&&error.transitionId===tid)
      assert.equal(requests.length,requestCount,'A live lease blocks before any new native call')
      const unchanged=await query(`SELECT state,lease_owner::text,lease_fence::text,lease_until::text,lease_until>clock_timestamp() AS live
        FROM crm_native_email_authority_phases WHERE transition_id=$1 AND phase='grant'`,[tid])
      assert.deepEqual(unchanged.rows,lease.rows,'Early Resume must not alter or extend the old lease')
    })
    await check('post-expiry Resume resolves the real native receipt without repeating grant, app mutation or audit',async()=>{
      const tid=(await query('SELECT active_transition_id FROM crm_native_email_publication_control')).rows[0].active_transition_id
      const deadline=Date.now()+25000
      while((await query("SELECT lease_until>clock_timestamp() AS live FROM crm_native_email_authority_phases WHERE transition_id=$1 AND phase='grant'",[tid])).rows[0].live){
        assert.ok(Date.now()<deadline,'Reviewed fixture lease must expire by the real database clock')
        await new Promise(resolve=>setTimeout(resolve,250))
      }
      const executeCount=requests.filter(r=>r.path.endsWith('/execute')).length
      await recovery.resumePipelineSharingChange(selected.actorEmail,selected.workspaceId,tid)
      assert.equal(requests.filter(r=>r.path.endsWith('/execute')).length,executeCount)
      assert.ok(requests.some(r=>r.path.endsWith('/resolve')&&r.phase==='grant'&&r.replayed===true))
      assert.equal((await query('SELECT count(*) FROM combined_effects')).rows[0].count,'6')
      assert.equal((await query('SELECT active_transition_id FROM crm_native_email_publication_control')).rows[0].active_transition_id,null)
      assert.equal(await recovery.getPendingPipelineSharingChange(selected.actorEmail,selected.workspaceId),null)
      const calls=requests.length
      await assert.rejects(()=>recovery.resumePipelineSharingChange(selected.actorEmail,selected.workspaceId,tid),
        error=>error instanceof runtime.NativeEmailAccessPendingError&&error.transitionId===null)
      assert.equal(requests.length,calls,'Stale Resume must not admit or execute a replacement change')
    })
    await check('after real lost-response recovery a fresh demotion restores the original viewer and matching app/native pins',async()=>{
      assert.equal(await runtime.changePipelineMemberWithNativeAuthority({...selected,accessRole:'viewer'}),true)
      const after=readInspection(await native.inspect()),control=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
      assert.equal(Number(control.generation),after.generation);assert.equal(control.native_policy_fingerprint,after.nativePolicyFingerprint)
      assert.equal(control.active_transition_id,null);assert.equal(control.active_operation_id,null)
      for(const entry of after.capabilities.filter(e=>e.pipelineId===binding.pipeline_id)){
        assert.ok(entry.capabilities.view.includes(reader));assert.ok(!entry.capabilities.edit.includes(reader));assert.ok(!entry.capabilities.delete.includes(reader))}
      assert.equal((await query('SELECT count(*) FROM combined_effects')).rows[0].count,'8')
      assert.equal((await query("SELECT count(*) FROM crm_native_email_authority_phases WHERE state='committed'")).rows[0].count,'8')
      assert.equal(JSON.parse(docker(['exec',appName,'php','/fixture/native-app-pg.php','content'])).contentDigest,contentBefore)
    })
    await check('removing an explicit editor share retains inherited root reads but revokes actual native historical and future writes',async()=>{
      assert.equal(await runtime.changePipelineMemberWithNativeAuthority(selected),true)
      const promoted=readInspection(await native.inspect())
      for(const entry of promoted.capabilities.filter(e=>e.pipelineId===binding.pipeline_id))assert.ok(entry.capabilities.edit.includes(reader))
      assert.equal(await runtime.changePipelineMemberWithNativeAuthority({...selected,accessRole:null}),true)
      assert.equal((await query('SELECT count(*) FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2',
        [selected.pipelineId,selected.userEmail])).rows[0].count,'0','Do not manufacture a viewer share to preserve inheritance')
      const after=readInspection(await native.inspect()),control=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
      for(const entry of after.capabilities.filter(e=>e.pipelineId===binding.pipeline_id)){
        for(const surface of ['view','list','export'])assert.ok(entry.capabilities[surface].includes(reader))
        for(const surface of ['edit','delete'])assert.ok(!entry.capabilities[surface].includes(reader))
      }
      const future=JSON.parse(after.bindings.find(b=>b.pipeline_id===binding.pipeline_id).capability_policy_json).futureCreate
      for(const surface of ['view','list','export'])assert.ok(future[surface].includes(reader))
      for(const surface of ['edit','delete'])assert.ok(!future[surface].includes(reader))
      assert.equal(Number(control.generation),after.generation);assert.equal(control.native_policy_fingerprint,after.nativePolicyFingerprint)
      assert.equal(control.active_transition_id,null);assert.equal(control.active_operation_id,null)
      assert.equal((await query('SELECT count(*) FROM combined_effects')).rows[0].count,'12')
      assert.equal((await query('SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS allowed',
        [binding.pipeline_id,binding.workspace_id,reader])).rows[0].allowed,true)
      assert.ok((await query('SELECT workspace_id::text FROM clawpilot_crm_root_read_workspaces($1)',[email(reader)])).rows
        .some(row=>row.workspace_id===binding.workspace_id),'Actual committed native grant supplies the computed root read proof')
      assert.equal(JSON.parse(docker(['exec',appName,'php','/fixture/native-app-pg.php','content'])).contentDigest,contentBefore)
    })
    await check('root employee CRM denial and restoration use actual native-first user access without losing independent organization access',async()=>{
      await query('INSERT INTO app_sessions(effective_user_email,active_workspace_organization_id) VALUES($1,$2)',[email(reader),rootId])
      const original=readInspection(await native.inspect()),request={workspaceId:rootId,userEmail:email(reader),
        action:{kind:'access',role:'member',permissions:{viewCrm:false}}}
      phase='root employee CRM denial: actual native-first access transition'
      assert.equal(await userRuntime.changeWorkspaceUserWithNativeAuthority(selected.actorEmail,request,rootId),true)
      assert.equal((await query('SELECT status FROM app_users WHERE email=$1',[email(reader)])).rows[0].status,'active')
      assert.equal((await query('SELECT status FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',
        [email(reader),selected.workspaceId])).rows[0].status,'active','Keep the separate real business membership')
      const denied=readInspection(await native.inspect())
      assert.deepEqual((await query('SELECT workspace_id::text FROM clawpilot_crm_root_read_workspaces($1)',[email(reader)])).rows,[])
      for(const entry of denied.capabilities.filter(e=>e.pipelineId===binding.pipeline_id))
        for(const surface of ['view','list','export','edit','delete'])assert.ok(!entry.capabilities[surface].includes(reader))
      assert.deepEqual(denied.capabilities.filter(e=>e.pipelineId!==binding.pipeline_id),original.capabilities.filter(e=>e.pipelineId!==binding.pipeline_id))
      assert.equal((await query('SELECT revoked_reason FROM app_sessions WHERE effective_user_email=$1 AND active_workspace_organization_id=$2',
        [email(reader),rootId])).rows[0].revoked_reason,'workspace_access_changed')
      phase='root employee CRM restoration: retained read-only native rights'
      assert.equal(await userRuntime.changeWorkspaceUserWithNativeAuthority(selected.actorEmail,
        {...request,action:{kind:'access',role:'member',permissions:{viewCrm:true}}},rootId),true)
      const restored=readInspection(await native.inspect()),control=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
      assert.deepEqual(restored.capabilities,original.capabilities,'Restore the retained read matrix, not historical editor rights')
      assert.equal(Number(control.generation),restored.generation);assert.equal(control.native_policy_fingerprint,restored.nativePolicyFingerprint)
      assert.equal(control.active_transition_id,null);assert.equal(control.active_operation_id,null)
      assert.equal((await query('SELECT count(*) FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2',
        [selected.pipelineId,selected.userEmail])).rows[0].count,'0')
      assert.equal((await query('SELECT count(*) FROM combined_effects')).rows[0].count,'14')
      assert.ok((await query('SELECT workspace_id::text FROM clawpilot_crm_root_read_workspaces($1)',[email(reader)])).rows
        .some(row=>row.workspace_id===binding.workspace_id),'Restoration re-enables exact root reads only after the real native grant')
      assert.equal(JSON.parse(docker(['exec',appName,'php','/fixture/native-app-pg.php','content'])).contentDigest,contentBefore)
    })
    await check('normal user identity sync and saved-change Resume recover a lost actual native grant without provider rediscovery and keep the existing account a scoped viewer',async()=>{
      const identity=config.existingIdentityLink,targetEmail=email(identity.userId),initial=readInspection(await native.inspect())
      assert.ok(initial.capabilities.every(entry=>!entry.capabilities.view.includes(identity.userId)))
      await query('INSERT INTO app_sessions(effective_user_email,active_workspace_organization_id) VALUES($1,$2)',[targetEmail,rootId])
      // Account discovery/metadata lookup is a read-only fixture edge. The
      // actual native executor independently rechecks this exact account in
      // both real transactions; no native creation/rename API is supplied.
      let identityLookupUnavailable=false,identityLookups=0
      overrides.set(sourcePath('app_src/lib/crm/suiteCrmClient.ts'),{
        findSuiteCrmUser:async selected=>{assert.deepEqual(selected,{globalId:identity.globalId});return{id:identity.userId,globalId:identity.globalId}},
        inspectSuiteCrmUserIdentity:async selected=>{identityLookups++;assert.ok(!identityLookupUnavailable,'Saved identity recovery must not rediscover the provider account')
          assert.equal(selected.suiteCrmUserId,identity.userId);assert.equal(selected.referenceCode,identity.globalId);return{verified:true}},
      })
      const users=load(sourcePath('app_src/lib/users.ts'))
      const recovery=load(sourcePath('app_src/lib/crm/nativeEmailWorkspaceUserRecovery.ts'))
      const actor={email:selected.actorEmail,status:'active',role:'owner',permissions:users.OWNER_PERMISSIONS,organizationId:rootId}
      loseGrantReply=true
      await assert.rejects(users.syncAppUserSuiteCrmIdentity({actorEmail:actor,email:targetEmail,organizationId:rootId}),
        error=>error instanceof runtime.NativeEmailAccessPendingError&&/^[a-f0-9]{64}$/.test(error.transitionId))
      identityLookupUnavailable=true
      const tid=(await query('SELECT active_transition_id FROM crm_native_email_publication_control')).rows[0].active_transition_id
      assert.match(tid,/^[a-f0-9]{64}$/)
      assert.deepEqual(await recovery.getPendingWorkspaceUserAuthorityChange(selected.actorEmail,rootId),{
        transitionId:tid,userEmail:targetEmail,workspaceId:rootId,actionKind:'identity_link'})
      const beforeResumeCalls=requests.length,beforeResumeLookups=identityLookups
      await assert.rejects(recovery.resumeWorkspaceUserAuthorityChange(selected.actorEmail,rootId,tid),
        error=>error instanceof runtime.NativeEmailAccessPendingError&&error.transitionId===tid)
      assert.equal(requests.length,beforeResumeCalls);assert.equal(identityLookups,beforeResumeLookups)
      const expiryDeadline=Date.now()+25000
      while((await query("SELECT lease_until>clock_timestamp() AS live FROM crm_native_email_authority_phases WHERE transition_id=$1 AND phase='grant'",[tid])).rows[0].live){
        assert.ok(Date.now()<expiryDeadline,'Existing-identity fixture lease must expire on the actual database clock')
        await new Promise(resolve=>setTimeout(resolve,250))
      }
      const executeCount=requests.filter(r=>r.path.endsWith('/execute')).length
      const result=await recovery.resumeWorkspaceUserAuthorityChange(selected.actorEmail,rootId,tid)
      assert.equal(requests.filter(r=>r.path.endsWith('/execute')).length,executeCount,'Identity receipt resolution must not execute another native grant')
      assert.equal(identityLookups,beforeResumeLookups)
      assert.deepEqual(result,{userEmail:targetEmail,workspaceId:rootId})
      assert.equal((await query('SELECT suitecrm_user_id FROM app_users WHERE email=$1',[targetEmail])).rows[0].suitecrm_user_id,identity.userId)
      assert.equal(await recovery.getPendingWorkspaceUserAuthorityChange(selected.actorEmail,rootId),null)
      const after=readInspection(await native.inspect()),control=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
      for(const entry of after.capabilities){
        if(entry.pipelineId===binding.pipeline_id){
          for(const surface of ['view','list','export'])assert.ok(entry.capabilities[surface].includes(identity.userId))
          for(const surface of ['edit','delete'])assert.ok(!entry.capabilities[surface].includes(identity.userId))
        }else assert.deepEqual(entry,initial.capabilities.find(row=>row.emailId===entry.emailId),'Foreign/unbound native scope is unchanged')
      }
      const future=JSON.parse(after.bindings.find(b=>b.pipeline_id===binding.pipeline_id).capability_policy_json).futureCreate
      for(const surface of ['view','list','export'])assert.ok(future[surface].includes(identity.userId))
      for(const surface of ['edit','delete'])assert.ok(!future[surface].includes(identity.userId))
      assert.equal((await query('SELECT count(*) FROM pipeline_space_members WHERE user_email=$1',[targetEmail])).rows[0].count,'0')
      assert.equal((await query('SELECT revoked_reason FROM app_sessions WHERE effective_user_email=$1',[targetEmail])).rows[0].revoked_reason,'crm_identity_linked')
      assert.equal(control.active_transition_id,null);assert.equal(Number(control.generation),after.generation)
      assert.ok((await query('SELECT workspace_id::text FROM clawpilot_crm_root_read_workspaces($1)',[targetEmail])).rows
        .some(row=>row.workspace_id===binding.workspace_id),'Existing-account identity recovery supplies exact scoped native read proof')
      assert.equal(control.native_policy_fingerprint,after.nativePolicyFingerprint)
      const calls=requests.length,effects=(await query('SELECT count(*) FROM combined_effects')).rows[0].count
      identityLookupUnavailable=false
      assert.equal((await users.syncAppUserSuiteCrmIdentity({actorEmail:actor,email:targetEmail,organizationId:rootId})).identitySync,'verified')
      assert.equal(requests.length,calls);assert.equal((await query('SELECT count(*) FROM combined_effects')).rows[0].count,effects)
      assert.equal(JSON.parse(docker(['exec',appName,'php','/fixture/native-app-pg.php','content'])).contentDigest,contentBefore)
    })
    const rootRuntime=load(sourcePath('app_src/lib/crm/nativeEmailRootRegistryRuntime.ts'))
    // Only the authenticated session edge is supplied by this fixture. The
    // actual route derives its owner/workspace, and the real DAL discovers
    // before/after intent under control before invoking the private runtime.
    overrides.set(sourcePath('app_src/lib/requestUser.ts'),{
      requestSession:async()=>({authenticatedUser:selected.actorEmail,effectiveUser:selected.actorEmail,impersonating:false}),
      requireRequestUser:async()=>({email:selected.actorEmail,organizationId:rootId}),
    })
    const {NextRequest}=require('next/server'),rootApi=load(sourcePath('app_src/app/api/crm/root-access/route.ts'))
    const rootRequest=body=>new NextRequest('https://combined-owner.invalid/api/crm/root-access',{
      method:body?'POST':'GET',headers:{Origin:'https://combined-owner.invalid','Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})})
    const rootSettings=async()=>{
      const response=await rootApi.GET(rootRequest());assert.equal(response.status,200)
      const payload=await response.json();assert.equal(payload.ok,true);assert.equal(payload.settings.workspaceId,rootId)
      return payload.settings
    }
    const registryRequest=async enabled=>({action:'employee',userEmail:email(config.existingIdentityLink.userId),enabled,
      registryVersion:(await rootSettings()).registryVersion})
    await check('normal owner settings API and DAL revoke a mapped root employee through actual native OAuth without deleting intent or changing unrelated scopes',async()=>{
      const original=readInspection(await native.inspect()),userId=config.existingIdentityLink.userId
      const response=await rootApi.POST(rootRequest(await registryRequest(false)));assert.equal(response.status,200)
      const payload=await response.json();assert.equal(payload.ok,true)
      assert.equal(payload.settings.employees.find(row=>row.email===email(userId)).enabled,false)
      const after=readInspection(await native.inspect())
      for(const entry of after.capabilities){
        if(entry.pipelineId===binding.pipeline_id)for(const surface of ['view','list','export','edit','delete'])assert.ok(!entry.capabilities[surface].includes(userId))
        else assert.deepEqual(entry,original.capabilities.find(row=>row.emailId===entry.emailId),'Unrelated native scope is preserved')
      }
      assert.equal((await query('SELECT enabled FROM crm_root_employee_access_grants WHERE operator_account_id=$1 AND user_email=$2',
        [accountId,email(userId)])).rows[0].enabled,false)
      assert.equal(await rootRuntime.getPendingRootEmployeeCrmRegistryChange(selected.actorEmail,rootId),null)
      assert.equal((await query('SELECT count(*) FROM pipeline_space_members WHERE user_email=$1',[email(userId)])).rows[0].count,'0')
      assert.equal(JSON.parse(docker(['exec',appName,'php','/fixture/native-app-pg.php','content'])).contentDigest,contentBefore)
    })
    await check('normal owner settings discover and Resume a lost actual native grant without re-execution and restore only viewer rights',async()=>{
      const userId=config.existingIdentityLink.userId,source=await registryRequest(true)
      loseGrantReply=true
      const response=await rootApi.POST(rootRequest(source));assert.equal(response.status,409)
      const pendingResponse=await response.json();assert.match(pendingResponse.transitionId,/^[a-f0-9]{64}$/)
      const tid=(await query('SELECT active_transition_id FROM crm_native_email_publication_control')).rows[0].active_transition_id
      assert.equal(pendingResponse.transitionId,tid)
      assert.deepEqual(await rootRuntime.getPendingRootEmployeeCrmRegistryChange(selected.actorEmail,rootId),{
        transitionId:tid,workspaceId:rootId,operatorAccountId:accountId,changes:1})
      assert.equal(await rootRuntime.getPendingRootEmployeeCrmRegistryChange(selected.actorEmail,binding.workspace_id),null)
      assert.deepEqual((await rootSettings()).pending,{transitionId:tid,changes:1})
      const beforeCalls=requests.length,beforeEffects=(await query('SELECT count(*) FROM combined_effects')).rows[0].count
      const live=await rootApi.POST(rootRequest({action:'resume',transitionId:tid}));assert.equal(live.status,409)
      assert.equal((await live.json()).transitionId,tid)
      assert.equal(requests.length,beforeCalls,'A live unknown lease cannot be stolen')
      const expiryDeadline=Date.now()+25000
      while((await query("SELECT lease_until>clock_timestamp() AS live FROM crm_native_email_authority_phases WHERE transition_id=$1 AND phase='grant'",[tid])).rows[0].live){
        assert.ok(Date.now()<expiryDeadline,'Root registry fixture lease must expire on the actual database clock')
        await new Promise(resolve=>setTimeout(resolve,250))
      }
      const executeCount=requests.filter(r=>r.path.endsWith('/execute')).length
      const resumed=await rootApi.POST(rootRequest({action:'resume',transitionId:tid}));assert.equal(resumed.status,200)
      const completed=await resumed.json();assert.equal(completed.ok,true);assert.equal(completed.settings.pending,null)
      assert.equal(requests.filter(r=>r.path.endsWith('/execute')).length,executeCount,'Resolve the committed receipt; never repeat a grant')
      assert.equal((await query('SELECT count(*) FROM combined_effects')).rows[0].count,beforeEffects)
      assert.equal(await rootRuntime.getPendingRootEmployeeCrmRegistryChange(selected.actorEmail,rootId),null)
      const after=readInspection(await native.inspect())
      for(const entry of after.capabilities.filter(row=>row.pipelineId===binding.pipeline_id)){
        for(const surface of ['view','list','export'])assert.ok(entry.capabilities[surface].includes(userId))
        for(const surface of ['edit','delete'])assert.ok(!entry.capabilities[surface].includes(userId))
      }
      const future=JSON.parse(after.bindings.find(row=>row.pipeline_id===binding.pipeline_id).capability_policy_json).futureCreate
      for(const surface of ['view','list','export'])assert.ok(future[surface].includes(userId))
      for(const surface of ['edit','delete'])assert.ok(!future[surface].includes(userId))
      const control=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
      assert.equal(control.active_transition_id,null);assert.equal(Number(control.generation),after.generation)
      assert.equal(control.native_policy_fingerprint,after.nativePolicyFingerprint)
      assert.equal(JSON.parse(docker(['exec',appName,'php','/fixture/native-app-pg.php','content'])).contentDigest,contentBefore)
    })
    assert.ok(requests.every(r=>r.status===200));assert.ok(requests.some(r=>r.path==='/Api/access_token'))
    return {version:1,checks,postgres:true,actualApplicationCoordinator:true,actualNativeOAuthAndRoutes:true,
      nativeEmailCount:before.capabilities.length,nativePrincipalCount:before.principalSuiteCrmUserIds.length,requests,nativeAclProfile,
      lostActualNativeGrantResponse:discardedGrantReply,testLeaseSeconds:20,productionLeaseDefaultSeconds:120,
      actualOwnerSettingsApi:true,actualOwnerSettingsDal:true,
      sourceScope:'Actual user identity sync, sharing/user coordinators, owner root settings API/DAL, saved recovery/store/planner/issuer/transport and native HTTP; session authentication and account discovery are fixture edges and downstream sync/audit sinks use fixture tables; root registry management browser UI is not exercised here',
      browserProof:false,productionScaleProven:false,productionTouched:false}
  }catch(error){
    const last=requests.at(-1),code=typeof error?.code==='string'&&/^[a-zA-Z0-9_]{1,100}$/.test(error.code)?error.code:null
    let nativeDiagnostic=null,nativeHoldCodes=[],nativeDeadlineProfiles=[]
    if(nativeTokenId)try{nativeDiagnostic=JSON.parse(docker(['exec','--interactive',appName,'php','/fixture/native-app-pg.php','diagnose'],{input:nativeTokenId}))}catch{}
    try{const log=docker(['exec',appName,'tail','-n','80','/tmp/native-http.log'])
      nativeHoldCodes=[...log.matchAll(/CLAWPILOT_NATIVE_AUTHORITY_HELD=([a-z0-9_]{1,100})/g)].map(m=>m[1]).slice(-8)
      nativeDeadlineProfiles=[...log.matchAll(/CLAWPILOT_NATIVE_DEADLINE_PROFILE=(\{[^\n]{1,1000}\})/g)].slice(-2).map(m=>{
        const row=JSON.parse(m[1]),allowed=['policy_fence','approval','runtime_before','identities','acl_before','memberships',
          'permission_rows','acl_after','runtime_after','receipt','commit_recheck']
        assert.ok(Object.keys(row).every(key=>allowed.includes(key)&&typeof row[key]==='number'&&Number.isFinite(row[key])&&row[key]>=0))
        return row
      })}catch{}
    const databaseGuard=code&&/^[A-Z0-9]{5}$/.test(code)?String(error.message).slice(0,250):null
    throw new Error('Combined app/PG/native held: '+JSON.stringify({phase,code,databaseGuard,boundaryFailures:boundaryFailures.slice(-8),guardCodes:guardCodes.slice(-8),lastNativeRequest:last??null,nativeDiagnostic,nativeHoldCodes,nativeDeadlineProfiles,nativeAclProfile,inspectionSelection}),{cause:error})
  }finally{await pool.end()}
}
