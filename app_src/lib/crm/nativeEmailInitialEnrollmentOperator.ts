import 'server-only'
import {createHash} from 'node:crypto'
import {nativeEmailCanonicalJson as json,nativeEmailDigest as digest,requireNativeEmail} from './nativeEmailPublication'
import type {NativeEmailSqlTransaction} from './nativeEmailPublicationPostgres'
import type {NativeEmailInitialOperatorSelection,NativeEmailInitialReviewedMaterial} from './nativeEmailInitialEnrollmentPostgres'
import {nativeEmailEffectivePipelinePrincipals} from './nativeEmailEligibility'
import {collectNativeEmailRootSourcesWithClient,projectNativeEmailRootReaders} from './nativeEmailRootReaders'
import {suiteCrmEmailAudienceFingerprint} from './suiteCrmNativeEmailProjection'
import {NATIVE_EMAIL_CAPABILITY_SURFACES as SURFACES,type NativeEmailCapabilityMatrix} from './nativeEmailCapabilityContract'
import {prepareNativeEmailInitialReplanContext,finalizeNativeEmailInitialInstallationLineage,effectiveNativeEmailInitialInstallationJournalFingerprint,
  type NativeEmailInitialReplanContext} from './nativeEmailInitialInstallationLineage'
import {prepareNativeEmailInitialEnrollment,verifyNativeEmailInitialEnrollmentFingerprint,
  type NativeEmailInitialEnrollmentInput,type NativeEmailInitialEnrollmentEvidence,type NativeEmailInitialEmailState,
  type NativeEmailInitialDefaultRow,type NativeEmailInitialPipeline,type NativeEmailInitialRevocation} from './nativeEmailInitialEnrollment'

type Row=Record<string,unknown>
export type NativeEmailInitialMapping=Omit<NativeEmailInitialEmailState,'capabilities'>
export type NativeEmailInitialReservedSource={operationId:string;nativeInstanceId:string;appGeneration:number;
  appSourceFingerprint:string;mappings:NativeEmailInitialMapping[]}
export type NativeEmailInitialPreparationSource=NativeEmailInitialReservedSource&{sourceArtifactDigest:string}
export type NativeEmailInitialPrepareInput={operationId:string;appSourceFingerprint:string;sourceArtifactDigest:string;preparedAt:string}
export type NativeEmailInitialNativePreparationRequest={source:NativeEmailInitialPreparationSource;plan:NativeEmailInitialEnrollmentInput;preparedAt:string}
/** Privileged private adapter only. inspectSource must invoke the authenticated
 * fixed native CLI; readSource must read its retained exact original bytes, not
 * rerun stock inspection after installation. Both preparation methods run the
 * actual rollback-only CLI and obtain the journal pin from the SAME protected
 * installer-helper verification. This port is not implemented by a browser
 * JSON body, completeness flag, cached forecast, or this module's test loader. */
export type NativeEmailInitialSourceCollector={
  inspectSource(source:NativeEmailInitialReservedSource):Promise<string>
  inspectInstalledSource?(source:NativeEmailInitialReservedSource,context:NativeEmailInitialReplanContext):Promise<string>
  readSource(source:NativeEmailInitialPreparationSource):Promise<string>
  project(request:NativeEmailInitialNativePreparationRequest):Promise<{forecast:unknown;installationJournalFingerprint:string}>
  prepare(request:NativeEmailInitialNativePreparationRequest):Promise<{forecast:unknown;installationJournalFingerprint:string}>
}
type Authority={pipelineId:string;workspaceId:string;ownerSuiteCrmId:string;readers:string[];writers:string[]}
type Collected={source:NativeEmailInitialReservedSource;authority:Authority[]}
type NativeSourceFields={nativePolicyFingerprint:string;nativeRuntimeFingerprint:string;
  principalSuiteCrmUserIds:string[];emails:NativeEmailInitialEmailState[];defaults:NativeEmailInitialDefaultRow[]}
type NativeSource=NativeSourceFields&({version:1;purpose:'clawpilot-native-email-initial-source'}
  |{version:2;purpose:'clawpilot-native-email-initial-installed-source';installationContext:NativeEmailInitialReplanContext})
type Forecast={version:1;purpose:string;operationId:string;planHash:string;preparedAt:string;deltaFingerprint:string;
  nativeDelta:Row;result:Row;policies:unknown[]}
const HASH=/^[a-f0-9]{64}(?![\s\S])/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const ID=/^[A-Za-z0-9][A-Za-z0-9-]{0,35}(?![\s\S])/,GLOBAL=/^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/
const same=(a:unknown,b:unknown)=>json(a)===json(b),copy=<T>(value:T):T=>JSON.parse(json(value)) as T
function need(value:unknown,code:string):asserts value{requireNativeEmail(value,'initial_source_'+code)}
function hash(value:unknown):asserts value is string{need(typeof value==='string'&&HASH.test(value),'hash')}
function exact(value:unknown,keys:string[]):asserts value is Row{need(value&&typeof value==='object'&&!Array.isArray(value)
  &&same(Object.keys(value).sort(),[...keys].sort()),'shape')}
function list(value:unknown,max:number):asserts value is unknown[]{need(Array.isArray(value)&&value.length<=max&&Object.keys(value).length===value.length,'bound')}
function ids(value:unknown):asserts value is string[]{list(value,500);need(value.every((id,index)=>typeof id==='string'&&ID.test(id)&&(index===0||String(value[index-1])<id)),'principal_inventory')}
function utc(value:unknown):asserts value is string{need(typeof value==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?![\s\S])/.test(value),'prepared_at')
  const date=new Date(value.replace(' ','T')+'Z');need(Number.isFinite(date.getTime())&&date.toISOString().slice(0,19).replace('T',' ')===value,'prepared_at')}
function identity(value:NativeEmailInitialMapping){const {recordFingerprint,...rest}=value;void recordFingerprint;return rest}
function mapping(value:unknown):asserts value is NativeEmailInitialMapping{exact(value,['localId','nativeId','globalId','pipelineId','workspaceId','archived','recordFingerprint'])
  need(['localId','pipelineId','workspaceId'].every(key=>typeof value[key]==='string'&&UUID.test(value[key]))
    &&typeof value.nativeId==='string'&&ID.test(value.nativeId)&&typeof value.globalId==='string'&&GLOBAL.test(value.globalId)
    &&typeof value.archived==='boolean','email_mapping');hash(value.recordFingerprint)}
function matrix(value:unknown,principals:string[]):asserts value is NativeEmailCapabilityMatrix{exact(value,[...SURFACES]);for(const surface of SURFACES){ids(value[surface]);need(value[surface].every(id=>principals.includes(id)),'unknown_native_principal')}
  need(['edit','delete'].every(surface=>(value[surface] as string[]).every(id=>(value.view as string[]).includes(id))),'write_without_read')}
function groupId(operationId:string,pipelineId:string){const bytes=createHash('sha256').update('clawpilot-native-initial-group-v1\0'+operationId+'\0'+pipelineId).digest().subarray(0,16)
  bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`}
const revokeKey=(r:NativeEmailInitialRevocation)=>[r.nativeId,r.surface,r.principalId].join(':')

/** Actual SQL source collector and candidate preparation, not a public action,
 * reservation writer, signer, native executor or activation mechanism. The
 * separately constructed real DAL still reauthorizes/rebuilds future policies
 * at issuance. No native/provider I/O is performed while a PG lock is held. */
export class NativeEmailInitialEnrollmentOperator{
  private readonly selection:NativeEmailInitialOperatorSelection
  private readonly native:NativeEmailInitialSourceCollector
  constructor(private readonly transaction:NativeEmailSqlTransaction,selection:NativeEmailInitialOperatorSelection,native:NativeEmailInitialSourceCollector){
    exact(selection,['actorEmail','operatorAccountId','rootWorkspaceId','nativeInstanceId'])
    need(typeof selection.actorEmail==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(selection.actorEmail)&&selection.actorEmail===selection.actorEmail.toLowerCase()
      &&UUID.test(selection.operatorAccountId)&&UUID.test(selection.rootWorkspaceId)&&ID.test(selection.nativeInstanceId),'selection')
    need(typeof transaction==='function'&&native&&['inspectSource','readSource','project','prepare'].every(key=>typeof native[key as keyof NativeEmailInitialSourceCollector]==='function'),'ports_required')
    this.selection=Object.freeze({...selection});this.native=Object.freeze({inspectSource:native.inspectSource.bind(native),readSource:native.readSource.bind(native),project:native.project.bind(native),prepare:native.prepare.bind(native),
      ...(native.inspectInstalledSource?{inspectInstalledSource:native.inspectInstalledSource.bind(native)}:{})})
  }
  private async collect(operationId:string,expectedSourceFingerprint:string):Promise<Collected>{hash(operationId);hash(expectedSourceFingerprint)
    return this.transaction(async tx=>{
      const controls=(await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')).rows
      need(controls.length===1,'control_missing');const control=controls[0],s=this.selection,generation=Number(control.generation)
      need(control.singleton===true&&control.enabled===false&&control.active_initial_enrollment_id===operationId
        &&control.active_operation_id===null&&control.active_transition_id===null&&Number.isSafeInteger(generation)&&generation>0,'barrier_changed')
      const owners=(await tx.query(`SELECT a.id FROM crm_operator_accounts a
        JOIN workspace_organizations w ON w.id=a.root_workspace_id JOIN app_users u ON u.email=a.owner_email
        JOIN app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=w.id
        WHERE a.id=$1::uuid AND a.root_workspace_id=$2::uuid AND a.owner_email=$3 AND a.enabled
          AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo
          AND u.status='active' AND u.role='owner' AND m.status='active' AND m.trashed_at IS NULL AND m.role='owner'`,
      [s.operatorAccountId,s.rootWorkspaceId,s.actorEmail])).rows;need(owners.length===1,'operator_denied')
      const reservations=(await tx.query(`SELECT r.*,encode(digest(r.source_snapshot::text,'sha256'),'hex') AS retained_fingerprint
        FROM crm_native_email_initial_reservations r WHERE operation_id=$1 FOR UPDATE`,[operationId])).rows
      need(reservations.length===1,'reservation_missing');const reservation=reservations[0]
      need(reservation.actor_email===s.actorEmail&&reservation.operator_account_id===s.operatorAccountId&&reservation.root_workspace_id===s.rootWorkspaceId
        &&reservation.native_instance_id===s.nativeInstanceId&&reservation.operation_id===operationId&&reservation.state==='reserved'
        &&Number(reservation.generation)===generation&&reservation.source_fingerprint===expectedSourceFingerprint
        &&reservation.retained_fingerprint===expectedSourceFingerprint,'reservation_changed')
      const snapshots=(await tx.query(`SELECT snapshot,encode(digest(snapshot::text,'sha256'),'hex') AS fingerprint,
        snapshot IS NOT DISTINCT FROM (SELECT source_snapshot FROM crm_native_email_initial_reservations WHERE operation_id=$1)
          AS snapshot_matches_reservation
        FROM (SELECT clawpilot_crm_native_initial_source_snapshot() AS snapshot) q`,[operationId])).rows
      // SQL snapshots contain general JSON (including legitimate empty objects),
      // not the stricter native wire grammar. SQL owns BOTH hashes and equality.
      need(snapshots.length===1&&snapshots[0].fingerprint===expectedSourceFingerprint&&snapshots[0].snapshot_matches_reservation===true,'source_changed')
      const snapshot=snapshots[0].snapshot;exact(snapshot,['version','generation','users','memberships','workspaces','pipelines','pipelineMembers','operatorAccounts','operatorBindings','employeeGrants','emails','pendingOutbox','capabilityPolicies'])
      need(snapshot.version===1&&Number(snapshot.generation)===generation,'snapshot_generation');list(snapshot.emails,500);need(snapshot.emails.length>0,'email_inventory')
      const mappings=snapshot.emails as NativeEmailInitialMapping[],locals=new Set<string>(),globals=new Set<string>();let previous=''
      for(const row of mappings){mapping(row);need(row.nativeId>previous&&!locals.has(row.localId)&&!globals.has(row.globalId),'duplicate_mapping');previous=row.nativeId;locals.add(row.localId);globals.add(row.globalId)}
      list(snapshot.pendingOutbox,10000)
      const demoQuarantines:Array<{id:string;rowFingerprint:string}>=[],pendingIds=new Set<string>()
      for(const pending of snapshot.pendingOutbox){need(pending&&typeof pending==='object'&&!Array.isArray(pending),'pending_writer');const p=pending as Row
        need(p.operation!=='upsert_user_identity','pending_writer')
        if(p.status==='queued'&&p.attempts===0&&p.lockedAt===null&&p.lockToken===null&&p.hasError===false&&p.processedAt===null)continue
        // Retain exact terminal demo rows in the original immutable snapshot.
        // SQL independently checks their full preimage and current demo binding;
        // neither this metadata nor an is_demo flag alone authorizes a bypass.
        need(p.targetSystem==='suitecrm'&&typeof p.id==='string'&&UUID.test(p.id)&&!pendingIds.has(p.id),'pending_writer')
        hash(p.rowFingerprint);pendingIds.add(p.id);demoQuarantines.push({id:p.id,rowFingerprint:p.rowFingerprint})}
      if(demoQuarantines.length){
        const rows=(await tx.query(`SELECT expected.id::text AS id,
          public.clawpilot_crm_native_initial_demo_quarantine(expected.id,expected.row_fingerprint) AS quarantined
          FROM unnest($1::uuid[],$2::text[]) AS expected(id,row_fingerprint) ORDER BY expected.id`,
        [demoQuarantines.map(row=>row.id),demoQuarantines.map(row=>row.rowFingerprint)])).rows
        const verified=new Set<string>()
        need(rows.length===demoQuarantines.length,'pending_writer')
        for(const row of rows){need(typeof row.id==='string'&&pendingIds.has(row.id)&&!verified.has(row.id)&&row.quarantined===true,'pending_writer');verified.add(row.id)}
      }
      const pipelines=(await tx.query(`SELECT p.id::text,p.owner_email,p.workspace_organization_id::text,p.reference_access_disabled
        FROM pipeline_spaces p JOIN workspace_organizations w ON w.id=p.workspace_organization_id
        JOIN crm_operator_workspace_bindings b ON b.workspace_id=w.id
        WHERE b.operator_account_id=$1::uuid AND b.owner_email=$2 AND b.enabled AND NOT w.is_demo
          AND NOT p.reference_access_disabled ORDER BY p.id LIMIT 101`,[s.operatorAccountId,s.actorEmail])).rows
      need(pipelines.length>0&&pipelines.length<=100&&new Set(pipelines.map(row=>row.id)).size===pipelines.length,'pipeline_bound')
      const pipelineIds=pipelines.map(row=>String(row.id));need(pipelineIds.every(id=>UUID.test(id)),'pipeline_identity')
      need(mappings.every(row=>pipelines.some(p=>p.id===row.pipelineId&&p.workspace_organization_id===row.workspaceId)),'unbound_email_inventory')
      const roots=await collectNativeEmailRootSourcesWithClient(tx,pipelineIds),authority:Authority[]=[]
      for(const pipeline of pipelines){const pipelineId=String(pipeline.id),workspaceId=String(pipeline.workspace_organization_id);need(UUID.test(workspaceId),'workspace_identity')
        const members=(await tx.query(`SELECT user_email,access_role FROM pipeline_space_members WHERE pipeline_id=$1::uuid ORDER BY user_email`,[pipelineId])).rows as Array<{user_email:string;access_role:string}>
        const emails=[...new Set([String(pipeline.owner_email),...members.map(row=>row.user_email)])].sort();need(emails.length<=500,'principal_bound')
        const principals=(await tx.query(`SELECT u.email,u.status,u.suitecrm_user_id,m.organization_id::text AS workspace_id,
          m.status AS membership_status,m.role AS membership_role,m.permissions AS membership_permissions,m.trashed_at::text AS membership_trashed_at,
          (SELECT count(*)::int FROM app_users duplicate WHERE lower(duplicate.suitecrm_user_id)=lower(u.suitecrm_user_id)) AS native_identity_count
          FROM app_users u LEFT JOIN app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=$1::uuid
          WHERE u.email=ANY($2::text[]) ORDER BY u.email`,[workspaceId,emails])).rows
        need(principals.length===emails.length,'principal_missing')
        const rootReaders=projectNativeEmailRootReaders({sources:roots,pipelineId,workspaceId,stage:'before'})
        const effective=nativeEmailEffectivePipelinePrincipals({pipeline,principals,members,rootReaders},false)
        const owner=principals.find(row=>row.email===pipeline.owner_email);need(owner&&typeof owner.suitecrm_user_id==='string','owner_native_identity')
        const editors=new Set(members.filter(row=>row.access_role==='editor').map(row=>row.user_email))
        const readers=effective.map(row=>String(row.suitecrm_user_id)).sort()
        const writers=effective.filter(row=>row.email===pipeline.owner_email||editors.has(String(row.email))).map(row=>String(row.suitecrm_user_id)).sort()
        ids(readers);ids(writers);authority.push({pipelineId,workspaceId,ownerSuiteCrmId:owner.suitecrm_user_id,readers,writers})
      }
      return copy({source:{operationId,nativeInstanceId:s.nativeInstanceId,appGeneration:generation,appSourceFingerprint:expectedSourceFingerprint,mappings},authority})
    })
  }
  async collectReservedSource(operationId:string,expectedSourceFingerprint:string):Promise<NativeEmailInitialReservedSource>{return (await this.collect(operationId,expectedSourceFingerprint)).source}
  private async nativeRead<T>(read:()=>Promise<T>):Promise<T>{try{return await read()}catch{need(false,'native_collection_held')}}
  private parseSource(bytes:string,source:NativeEmailInitialReservedSource):NativeSource{
    need(typeof bytes==='string'&&Buffer.byteLength(bytes,'utf8')<=1800000,'native_source_bound');let value:unknown
    try{value=JSON.parse(bytes)}catch{need(false,'native_source_json')}
    need(value&&typeof value==='object'&&!Array.isArray(value),'native_source_domain')
    const installed=(value as Row).version===2
    exact(value,['version','purpose','nativePolicyFingerprint','nativeRuntimeFingerprint','principalSuiteCrmUserIds','emails','defaults',
      ...(installed?['installationContext']:[])])
    need((installed?value.version===2&&value.purpose==='clawpilot-native-email-initial-installed-source'
      :value.version===1&&value.purpose==='clawpilot-native-email-initial-source')&&bytes===json(value)+'\n','native_source_domain')
    if(installed)prepareNativeEmailInitialReplanContext(value.installationContext,source.operationId)
    hash(value.nativePolicyFingerprint);hash(value.nativeRuntimeFingerprint);ids(value.principalSuiteCrmUserIds);need(value.principalSuiteCrmUserIds.length>0,'native_principals')
    list(value.emails,500);need(value.emails.length===source.mappings.length,'native_email_inventory')
    for(let i=0;i<value.emails.length;i++){const row=value.emails[i];exact(row,['localId','nativeId','globalId','pipelineId','workspaceId','archived','recordFingerprint','capabilities'])
      const {capabilities,...nativeMapping}=row;mapping(nativeMapping);matrix(capabilities,value.principalSuiteCrmUserIds)
      // SQL fingerprints bind app rows; native fingerprints bind native content.
      need(same(identity(nativeMapping),identity(source.mappings[i])),'native_mapping_changed')}
    list(value.defaults,5);need(value.defaults.length===5,'native_defaults');let previousDefault='';const defaultIds=new Set<string>()
    for(const row of value.defaults){exact(row,['id','action','aclAccess']);need(typeof row.id==='string'&&ID.test(row.id)&&!defaultIds.has(row.id)
      &&typeof row.action==='string'&&SURFACES.includes(row.action as typeof SURFACES[number])&&row.action>previousDefault&&row.aclAccess===90,'native_defaults')
      defaultIds.add(row.id);previousDefault=row.action}
    return value as unknown as NativeSource
  }
  async captureSource(operationId:string,expectedSourceFingerprint:string){
    const collected=await this.collect(operationId,expectedSourceFingerprint)
    const bytes=await this.nativeRead(()=>this.native.inspectSource(copy(collected.source)))
    need(this.parseSource(bytes,collected.source).version===1,'stock_source_required')
    need(same(await this.collect(operationId,expectedSourceFingerprint),collected),'source_changed_during_native')
    return {source:copy(collected.source),sourceBytes:bytes,sourceArtifactDigest:createHash('sha256').update(bytes,'utf8').digest('hex')}
  }
  /** Explicit private replacement-operation capture. The context is a
   * comparison request, not authority: the real DAL must derive/recheck it
   * from retained cancelled SQL history, and the native adapter independently
   * verifies its actual tombstones, installation and fresh current state.
   * No historical source bytes, old matrices or expired approvals are reused. */
  async captureReplanSource(operationId:string,expectedSourceFingerprint:string,value:NativeEmailInitialReplanContext){
    const context=prepareNativeEmailInitialReplanContext(value,operationId)
    need(typeof this.native.inspectInstalledSource==='function','installed_source_port_required')
    const collected=await this.collect(operationId,expectedSourceFingerprint)
    const bytes=await this.nativeRead(()=>this.native.inspectInstalledSource!(copy(collected.source),context))
    const native=this.parseSource(bytes,collected.source)
    need(native.version===2&&same(native.installationContext,context),'installed_source_context_changed')
    need(same(await this.collect(operationId,expectedSourceFingerprint),collected),'source_changed_during_native')
    return {source:copy(collected.source),sourceBytes:bytes,sourceArtifactDigest:createHash('sha256').update(bytes,'utf8').digest('hex')}
  }
  /** SAME-operation forward recovery only. The independent source-artifact pin
   * must come from the retained capture/review, never from this read's output.
   * Installation may already be complete: do not rerun stock inspection, change
   * the reservation, manufacture approval, or adopt a different native source. */
  async recoverRetainedSource(operationId:string,expectedSourceFingerprint:string,expectedSourceArtifactDigest:string){
    hash(expectedSourceArtifactDigest)
    const collected=await this.collect(operationId,expectedSourceFingerprint)
    const bytes=await this.nativeRead(()=>this.native.readSource({...copy(collected.source),sourceArtifactDigest:expectedSourceArtifactDigest}))
    need(typeof bytes==='string'&&createHash('sha256').update(bytes,'utf8').digest('hex')===expectedSourceArtifactDigest,'source_artifact_changed')
    this.parseSource(bytes,collected.source)
    need(same(await this.collect(operationId,expectedSourceFingerprint),collected),'source_changed_during_native')
    return {source:copy(collected.source),sourceBytes:bytes,sourceArtifactDigest:expectedSourceArtifactDigest}
  }
  private plan(collected:Collected,native:NativeSource,sourceArtifactDigest:string):{plan:NativeEmailInitialEnrollmentInput;evidence:NativeEmailInitialEnrollmentEvidence}{
    const {source,authority}=collected,principals=native.principalSuiteCrmUserIds
    const pipelines:NativeEmailInitialPipeline[]=authority.map(a=>{
      need(a.readers.every(id=>principals.includes(id)),'app_reader_missing_native_principal')
      const futureCreate={view:[...a.readers],list:[...a.readers],export:[...a.readers],edit:[...a.writers],delete:[...a.writers]}
      return {groupId:groupId(source.operationId,a.pipelineId),policy:{version:2,pipelineId:a.pipelineId,workspaceId:a.workspaceId,ownerSuiteCrmId:a.ownerSuiteCrmId,
        audienceFingerprint:suiteCrmEmailAudienceFingerprint({policy:'pipeline-internal',ownerSuiteCrmId:a.ownerSuiteCrmId,allowedSuiteCrmUserIds:a.readers,
          workspaceId:a.workspaceId,pipelineId:a.pipelineId,fingerprint:''}),principalSuiteCrmUserIds:[...principals],futureCreate,historical:[]}}
    })
    const emails=native.emails.map(before=>{const a=authority.find(row=>row.pipelineId===before.pipelineId);need(a,'historical_pipeline_missing')
      const after={...copy(before),capabilities:{view:[...a.readers],list:[...a.readers],export:[...a.readers],
        edit:before.capabilities.edit.filter(id=>a.writers.includes(id)),delete:before.capabilities.delete.filter(id=>a.writers.includes(id))}}
      return {before:copy(before),after}})
    const reviewedRevocations:NativeEmailInitialRevocation[]=emails.flatMap(({before,after})=>SURFACES.flatMap(surface=>
      before.capabilities[surface].filter(id=>!after.capabilities[surface].includes(id)).map(principalId=>({nativeId:before.nativeId,surface,principalId}))))
      .sort((a,b)=>revokeKey(a)<revokeKey(b)?-1:revokeKey(a)>revokeKey(b)?1:0)
    const base:Extract<NativeEmailInitialEnrollmentInput,{kind:'initial_enrollment_plan_v1'}>={version:1,kind:'initial_enrollment_plan_v1',operationId:source.operationId,nativeInstanceId:source.nativeInstanceId,
      appGeneration:source.appGeneration,appSourceFingerprint:source.appSourceFingerprint,nativePolicyBeforeFingerprint:native.nativePolicyFingerprint,
      nativeRuntimeBeforeFingerprint:native.nativeRuntimeFingerprint,
      // Before pins are explicitly provisional here; only actual project may
      // replace them with observed deterministic after pins before strictprepare.
      nativePolicyAfterFingerprint:native.nativePolicyFingerprint,nativeRuntimeAfterFingerprint:native.nativeRuntimeFingerprint,
      principalSuiteCrmUserIds:[...principals],defaults:native.defaults.map(before=>({before:copy(before),after:{...copy(before),aclAccess:['edit','delete'].includes(before.action)?75:80}})),
      emails,pipelines,reviewedRevocations,rootEmployeeGrants:[]}
    const plan:NativeEmailInitialEnrollmentInput=native.version===2?{...base,kind:'initial_enrollment_replan_v1',
      installationLineage:finalizeNativeEmailInitialInstallationLineage(native.installationContext,source.operationId,sourceArtifactDigest,native.nativeRuntimeFingerprint)}:base
    const evidence:NativeEmailInitialEnrollmentEvidence={complete:{appEmails:true,nativeEmails:true,nativePrincipals:true,pipelineAuthority:true,nativeDefaults:true},
      nativeInstanceId:source.nativeInstanceId,appGeneration:source.appGeneration,appSourceFingerprint:source.appSourceFingerprint,
      nativePolicyFingerprint:native.nativePolicyFingerprint,nativeRuntimeFingerprint:native.nativeRuntimeFingerprint,
      principalSuiteCrmUserIds:[...principals],emails:copy(native.emails),defaults:copy(native.defaults),approvedPipelines:copy(pipelines),reviewedRevocations:copy(reviewedRevocations)}
    prepareNativeEmailInitialEnrollment(plan,evidence);return {plan,evidence}
  }
  private forecast(value:unknown,plan:NativeEmailInitialEnrollmentInput,preparedAt:string):Forecast{
    exact(value,['version','purpose','operationId','planHash','preparedAt','deltaFingerprint','nativeDelta','result','policies'])
    need(value.version===1&&value.purpose==='clawpilot-native-email-initial-enrollment-forecast'&&value.operationId===plan.operationId
      &&value.planHash===digest(plan)&&value.preparedAt===preparedAt,'forecast_binding');hash(value.deltaFingerprint)
    exact(value.nativeDelta,['version','purpose','operationId','planHash','preparedAt','changes','result','policies']);const delta=value.nativeDelta
    need(delta.version===1&&delta.purpose==='clawpilot-native-email-initial-policy-delta'&&delta.operationId===plan.operationId&&delta.planHash===value.planHash
      &&delta.preparedAt===preparedAt&&same(delta.result,value.result)&&same(delta.policies,value.policies)&&digest(delta)===value.deltaFingerprint
      &&Buffer.byteLength(json(delta),'utf8')<=1800000,'delta_binding')
    exact(delta.changes,['acl_actions','securitygroups','securitygroups_users','securitygroups_records']);for(const changes of Object.values(delta.changes))list(changes,10000)
    exact(value.result,['generation','appSourceFingerprint','beforePolicyFingerprint','afterPolicyFingerprint','sourceRuntimeFingerprint',
      'installedRuntimeFingerprint','runtimeFingerprint','identityFingerprint','capabilitiesFingerprint','bindingsFingerprint','defaultsFingerprint','emailCount','principalCount'])
    const r=value.result;for(const key of ['beforePolicyFingerprint','afterPolicyFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint','runtimeFingerprint',
      'identityFingerprint','capabilitiesFingerprint','bindingsFingerprint','defaultsFingerprint'])hash(r[key])
    need(r.generation===plan.appGeneration&&r.appSourceFingerprint===plan.appSourceFingerprint&&r.beforePolicyFingerprint===plan.nativePolicyBeforeFingerprint
      &&r.sourceRuntimeFingerprint===plan.nativeRuntimeBeforeFingerprint&&r.emailCount===plan.emails.length&&r.principalCount===plan.principalSuiteCrmUserIds.length,'forecast_source')
    const policies=plan.pipelines.map(({policy})=>{const future={...policy};delete (future as Partial<typeof future>).historical
      return {pipelineId:policy.pipelineId,generation:plan.appGeneration,policy,fingerprint:digest(future)}})
    need(same(value.policies,policies),'forecast_policies')
    const bindings=plan.pipelines.map(({groupId,policy:p})=>{const future={...p};delete (future as Partial<typeof future>).historical
      return {pipeline_id:p.pipelineId,workspace_id:p.workspaceId,group_id:groupId,generation:String(plan.appGeneration),owner_id:p.ownerSuiteCrmId,
        readers_json:json(p.futureCreate.view),audience_fingerprint:p.audienceFingerprint,policy_fingerprint:r.afterPolicyFingerprint,runtime_fingerprint:r.runtimeFingerprint,
        capability_policy_json:json(p),capability_policy_fingerprint:digest(future),enabled:'1'}})
    need(r.identityFingerprint===digest(plan.emails.map(({after})=>{const {capabilities,...row}=after;void capabilities;return row}))
      &&r.capabilitiesFingerprint===digest(plan.emails.map(({after})=>({emailId:after.nativeId,globalId:after.globalId,pipelineId:after.pipelineId,capabilities:after.capabilities})))
      &&r.bindingsFingerprint===digest(bindings)&&r.defaultsFingerprint===digest(plan.defaults.map(row=>row.after)),'forecast_inventory')
    return copy(value as unknown as Forecast)
  }
  async prepareForReview(input:NativeEmailInitialPrepareInput){exact(input,['operationId','appSourceFingerprint','sourceArtifactDigest','preparedAt']);hash(input.sourceArtifactDigest);utc(input.preparedAt)
    const collected=await this.collect(input.operationId,input.appSourceFingerprint),source={...collected.source,sourceArtifactDigest:input.sourceArtifactDigest}
    const bytes=await this.nativeRead(()=>this.native.readSource(copy(source)));need(typeof bytes==='string'&&createHash('sha256').update(bytes,'utf8').digest('hex')===input.sourceArtifactDigest,'source_artifact_changed')
    const native=this.parseSource(bytes,collected.source),candidate=this.plan(collected,native,input.sourceArtifactDigest)
    const projected=await this.nativeRead(()=>this.native.project({source:copy(source),plan:copy(candidate.plan),preparedAt:input.preparedAt}))
    exact(projected,['forecast','installationJournalFingerprint']);hash(projected.installationJournalFingerprint)
    if(candidate.plan.kind==='initial_enrollment_replan_v1')need(projected.installationJournalFingerprint===
      effectiveNativeEmailInitialInstallationJournalFingerprint(candidate.plan.installationLineage,candidate.plan.operationId),'replan_installation_journal_changed')
    const first=this.forecast(projected.forecast,candidate.plan,input.preparedAt)
    if(candidate.plan.kind==='initial_enrollment_replan_v1')need(first.result.installedRuntimeFingerprint===
      candidate.plan.installationLineage.freshInstalledRuntimeFingerprint,'replan_installed_runtime_changed')
    candidate.plan.nativePolicyAfterFingerprint=String(first.result.afterPolicyFingerprint);candidate.plan.nativeRuntimeAfterFingerprint=String(first.result.runtimeFingerprint)
    const prepared=await this.nativeRead(()=>this.native.prepare({source:copy(source),plan:copy(candidate.plan),preparedAt:input.preparedAt}))
    exact(prepared,['forecast','installationJournalFingerprint']);hash(prepared.installationJournalFingerprint)
    const final=this.forecast(prepared.forecast,candidate.plan,input.preparedAt)
    need(prepared.installationJournalFingerprint===projected.installationJournalFingerprint&&same(first.result,final.result)
      &&same(first.nativeDelta.changes,final.nativeDelta.changes)&&same(first.policies,final.policies),'native_changed_between_preparations')
    need(final.result.afterPolicyFingerprint===candidate.plan.nativePolicyAfterFingerprint&&final.result.runtimeFingerprint===candidate.plan.nativeRuntimeAfterFingerprint,'strict_after_pins')
    need(same(await this.collect(input.operationId,input.appSourceFingerprint),collected),'source_changed_during_native')
    const verified=prepareNativeEmailInitialEnrollment(candidate.plan,candidate.evidence)
    const material:NativeEmailInitialReviewedMaterial={plan:copy(verified.plan),evidence:copy(candidate.evidence),planHash:verified.planHash,preparedAt:input.preparedAt,
      nativeDelta:copy(final.nativeDelta),deltaFingerprint:final.deltaFingerprint,sourceRuntimeFingerprint:native.nativeRuntimeFingerprint,
      installedRuntimeFingerprint:String(final.result.installedRuntimeFingerprint),installationJournalFingerprint:prepared.installationJournalFingerprint}
    return {kind:'native_email_initial_operator_review_candidate' as const,executable:false as const,material}
  }
  /** The review pin must be independently retained by the private operator.
   * This never manufactures approval from the candidate it just calculated. */
  async readReviewedMaterial(input:NativeEmailInitialPrepareInput,expectedPlanHash:string):Promise<NativeEmailInitialReviewedMaterial>{hash(expectedPlanHash)
    const candidate=await this.prepareForReview(input);verifyNativeEmailInitialEnrollmentFingerprint(candidate.material.plan,candidate.material.evidence,expectedPlanHash)
    need(candidate.material.planHash===expectedPlanHash,'review_changed');return copy(candidate.material)}
}
