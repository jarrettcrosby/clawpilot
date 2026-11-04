import 'server-only'
import {constants,createPrivateKey,createPublicKey,sign,verify,type KeyObject} from 'node:crypto'
import {nativeEmailCanonicalJson as json,nativeEmailDigest as digest,requireNativeEmail} from './nativeEmailPublication'
import {createNativeEmailInitialApprovalIssuer,type NativeEmailInitialIssuerConfig,
  type NativeEmailInitialApprovalEnvelope} from './nativeEmailInitialEnrollmentApproval'
import type {NativeEmailInitialOperatorSelection} from './nativeEmailInitialEnrollmentPostgres'
import type {NativeEmailInitialEnrollmentInput} from './nativeEmailInitialEnrollment'
import type {NativeEmailSqlTransaction} from './nativeEmailPublicationPostgres'
import {prepareNativeEmailInitialInstallationLineage,effectiveNativeEmailInitialInstallationJournalFingerprint} from './nativeEmailInitialInstallationLineage'

type Row=Record<string,unknown>
type NativeEmailInitialStartupOriginFields={
  purpose:'clawpilot-native-email-initial-activation-origin';issuer:'clawpilot-pg-initial-enrollment'
  audience:'clawpilot-suitecrm-startup';keyId:string;nativeInstanceId:string;serviceUserId:string;oauthClientId:string;issuedAt:number
  operationId:string;planHash:string;approvalHash:string;deltaFingerprint:string;initialReceiptHash:string;originGeneration:number
  appSourceFingerprint:string;installationJournalFingerprint:string;sourceRuntimeFingerprint:string;installedRuntimeFingerprint:string;runtimeFingerprint:string
  identities:Array<{nativeId:string;globalId:string;localId:string;pipelineId:string;workspaceId:string}>
  pipelines:Array<{pipelineId:string;workspaceId:string;groupId:string}>
}
export type NativeEmailInitialStartupOriginProof=NativeEmailInitialStartupOriginFields&(
  {version:1}|{version:2;installationRootOperationId:string;installationLineageHash:string})
export type NativeEmailInitialStartupOriginEnvelope={proof:NativeEmailInitialStartupOriginProof;signature:string}
const HASH=/^[a-f0-9]{64}(?![\s\S])/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const ID=/^[A-Za-z0-9][A-Za-z0-9-]{0,35}(?![\s\S])/
function need(value:unknown,code:string):asserts value{requireNativeEmail(value,'initial_startup_origin_'+code)}
function hash(value:unknown):asserts value is string{need(typeof value==='string'&&HASH.test(value),'hash')}
function exact(value:unknown,keys:string[]):asserts value is Row{
  need(value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort()),'shape')
}
function anchors(plan:NativeEmailInitialEnrollmentInput){
  need(plan&&Array.isArray(plan.emails)&&plan.emails.length>0&&plan.emails.length<=500
    &&Array.isArray(plan.pipelines)&&plan.pipelines.length>0&&plan.pipelines.length<=100,'inventory')
  const identities=plan.emails.map(({after:e})=>({nativeId:e.nativeId,globalId:e.globalId,localId:e.localId,pipelineId:e.pipelineId,workspaceId:e.workspaceId}))
  const pipelines=plan.pipelines.map(({groupId,policy:p})=>({pipelineId:p.pipelineId,workspaceId:p.workspaceId,groupId}))
  const locals=new Set<string>(),globals=new Set<string>();let prior=''
  for(const e of identities){need(ID.test(e.nativeId)&&e.nativeId>prior&&/^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/.test(e.globalId)
      &&[e.localId,e.pipelineId,e.workspaceId].every(id=>UUID.test(id))&&!locals.has(e.localId)&&!globals.has(e.globalId),'identity')
    prior=e.nativeId;locals.add(e.localId);globals.add(e.globalId)}
  prior='';const groups=new Set<string>()
  for(const p of pipelines){need(p.pipelineId>prior&&[p.pipelineId,p.workspaceId,p.groupId].every(id=>UUID.test(id))&&!groups.has(p.groupId),'pipeline')
    prior=p.pipelineId;groups.add(p.groupId)}
  need(identities.every(e=>pipelines.some(p=>p.pipelineId===e.pipelineId&&p.workspaceId===e.workspaceId)),'unbound_identity')
  return {identities,pipelines}
}
function installationOrigin(plan:NativeEmailInitialEnrollmentInput,approval:NativeEmailInitialApprovalEnvelope){
  if(plan.kind==='initial_enrollment_plan_v1'){
    need(!Object.hasOwn(plan,'installationLineage'),'direct_lineage_forbidden')
    return {version:1 as const}
  }
  need(plan.kind==='initial_enrollment_replan_v1','plan_kind')
  const lineage=prepareNativeEmailInitialInstallationLineage(plan.installationLineage,plan.operationId),p=approval.proof
  need(lineage.freshInstalledRuntimeFingerprint===plan.nativeRuntimeBeforeFingerprint
    &&p.sourceRuntimeFingerprint===lineage.freshInstalledRuntimeFingerprint
    &&p.installedRuntimeFingerprint===lineage.freshInstalledRuntimeFingerprint
    &&p.installationJournalFingerprint===effectiveNativeEmailInitialInstallationJournalFingerprint(lineage,plan.operationId),
  'replan_installation_binding')
  return {version:2 as const,installationRootOperationId:lineage.rootOperationId,installationLineageHash:digest(lineage)}
}

/** Private operator issuer for an immutable historical activation FACT, not
 * current PG/native synchronization, readiness, or anti-restore protection.
 * No public endpoint, expiry-based permission, source mutation or startup flag.
 * The transaction returns only genuinely committed SQL origin rows; signing is
 * deliberately AFTER its successful COMMIT/return. Unknown outcomes must be
 * reread, never signed from an in-transaction callback or claimed receipt.
 * Native startup must independently verify retained origin anchors and FULL
 * current native invariants; it must not replay old content/capability matrices. */
export function createNativeEmailInitialStartupOriginIssuer(transaction:NativeEmailSqlTransaction,
  selection:NativeEmailInitialOperatorSelection,config:NativeEmailInitialIssuerConfig,now:()=>number=Date.now){
  selection=Object.freeze({...selection});config=Object.freeze({...config})
  need(typeof transaction==='function'&&typeof selection.actorEmail==='string'
    &&/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(selection.actorEmail)&&selection.actorEmail===selection.actorEmail.toLowerCase()
    &&UUID.test(selection.operatorAccountId)&&UUID.test(selection.rootWorkspaceId)&&ID.test(selection.nativeInstanceId)
    &&selection.nativeInstanceId===config.nativeInstanceId,'selection')
  let key:KeyObject
  try{key=typeof config.privateKey==='string'?createPrivateKey(config.privateKey):config.privateKey}catch{need(false,'private_key')}
  need(key?.type==='private'&&key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails?.modulusLength===3072,'private_key')
  const publicKey=createPublicKey(key!)
  // Reuse the exact approval-domain verifier on actual committed envelope
  // bytes below. Its read-only closure can never invoke an admission/signing
  // callback; this is validation, not a substitute initial-enrollment store.
  const validateApproval=async(envelope:NativeEmailInitialApprovalEnvelope,operationId:string,planHash:string)=>{
    const validator=createNativeEmailInitialApprovalIssuer({async issueApproval(id){need(id===operationId,'approval_operation');return envelope}},config,now)
    return validator.issue(operationId,planHash)
  }
  return {async issue(operationId:string,expectedPlanHash:string):Promise<NativeEmailInitialStartupOriginEnvelope>{
    hash(operationId);hash(expectedPlanHash)
    const retained=await transaction(async tx=>{
      const controls=(await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')).rows
      need(controls.length===1&&controls[0].enabled===true&&controls[0].active_initial_enrollment_id===null,'activation_not_committed')
      const s=selection,authorized=(await tx.query(`SELECT a.id FROM crm_operator_accounts a
        JOIN workspace_organizations w ON w.id=a.root_workspace_id JOIN app_users u ON u.email=a.owner_email
        JOIN app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=w.id
        WHERE a.id=$1::uuid AND a.root_workspace_id=$2::uuid AND a.owner_email=$3 AND a.enabled
          AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo
          AND u.status='active' AND u.role='owner' AND m.status='active' AND m.trashed_at IS NULL AND m.role='owner'`,
      [s.operatorAccountId,s.rootWorkspaceId,s.actorEmail])).rows
      need(authorized.length===1,'operator_denied')
      const rows=(await tx.query(`SELECT to_jsonb(e) AS enrollment,to_jsonb(r) AS reservation,
        encode(digest(e.source_snapshot::text,'sha256'),'hex') AS actual_source_fingerprint
        FROM crm_native_email_initial_enrollments e JOIN crm_native_email_initial_reservations r USING(operation_id)
        WHERE e.operation_id=$1 FOR SHARE OF e,r`,[operationId])).rows
      need(rows.length===1,'origin_missing');const row=rows[0],e=row.enrollment as Row,r=row.reservation as Row
      for(const item of [e,r])need(item.state==='activated'&&item.actor_email===s.actorEmail&&item.operator_account_id===s.operatorAccountId
        &&item.root_workspace_id===s.rootWorkspaceId&&item.native_instance_id===s.nativeInstanceId,'origin_selection')
      need(e.generation===r.generation&&e.source_fingerprint===r.source_fingerprint&&e.settling_xid===r.settling_xid
        &&e.source_fingerprint===row.actual_source_fingerprint&&Number.isSafeInteger(Number(e.generation))&&Number(e.generation)>0
        &&Number(controls[0].generation)>=Number(e.generation),'origin_generation')
      const plan=e.plan as NativeEmailInitialEnrollmentInput,delta=e.native_delta as Row,receipt=e.native_receipt as Row
      const approval=e.approval_envelope as NativeEmailInitialApprovalEnvelope
      need(e.plan_hash===expectedPlanHash&&e.plan_canonical===json(plan)&&digest(plan)===expectedPlanHash
        &&e.native_delta_canonical===json(delta)&&e.delta_fingerprint===digest(delta)
        &&e.approval_canonical===json(approval)&&e.approval_hash===digest(approval)
        &&e.receipt_canonical===json(receipt)&&e.receipt_hash===digest(receipt),'retained_bytes')
      exact(receipt,['version','purpose','operationId','planHash','approvalHash','state','result'])
      need(receipt.version===1&&receipt.purpose==='clawpilot-native-email-initial-enrollment-receipt'&&receipt.state==='committed'
        &&receipt.operationId===operationId&&receipt.planHash===expectedPlanHash&&receipt.approvalHash===e.approval_hash
        &&json(receipt.result)===json(delta.result),'receipt_binding')
      const p=approval.proof,result=receipt.result as Row
      need(plan.operationId===operationId&&plan.nativeInstanceId===s.nativeInstanceId&&plan.appGeneration===Number(e.generation)
        &&plan.appSourceFingerprint===e.source_fingerprint&&p.operationId===operationId&&p.planHash===expectedPlanHash
        &&p.appGeneration===plan.appGeneration&&p.appSourceFingerprint===plan.appSourceFingerprint&&p.deltaFingerprint===e.delta_fingerprint
        &&result.generation===plan.appGeneration&&result.appSourceFingerprint===plan.appSourceFingerprint
        &&result.afterPolicyFingerprint===plan.nativePolicyAfterFingerprint&&result.runtimeFingerprint===plan.nativeRuntimeAfterFingerprint
        &&result.sourceRuntimeFingerprint===p.sourceRuntimeFingerprint&&p.sourceRuntimeFingerprint===plan.nativeRuntimeBeforeFingerprint
        &&result.installedRuntimeFingerprint===p.installedRuntimeFingerprint&&delta.operationId===operationId&&delta.planHash===expectedPlanHash,'origin_binding')
      const inventory=anchors(plan),installation=installationOrigin(plan,approval)
      for(const value of [e.approval_hash,e.delta_fingerprint,e.receipt_hash,e.source_fingerprint,p.installationJournalFingerprint,
        p.sourceRuntimeFingerprint,p.installedRuntimeFingerprint,result.runtimeFingerprint])hash(value)
      return {plan,approval,approvalHash:String(e.approval_hash),deltaFingerprint:String(e.delta_fingerprint),initialReceiptHash:String(e.receipt_hash),inventory,installation}
    })
    // No proof/signature exists if the transaction above failed or its COMMIT
    // response was lost. Only a subsequent fresh committed-origin read retries.
    const approval=await validateApproval(retained.approval,operationId,expectedPlanHash),p=approval.proof
    const issuedAt=Math.floor(now()/1000);need(Number.isSafeInteger(issuedAt)&&issuedAt>0,'clock')
    const proof:NativeEmailInitialStartupOriginProof={...retained.installation,purpose:'clawpilot-native-email-initial-activation-origin',
      issuer:'clawpilot-pg-initial-enrollment',audience:'clawpilot-suitecrm-startup',keyId:config.keyId,nativeInstanceId:config.nativeInstanceId,
      serviceUserId:config.serviceUserId,oauthClientId:config.oauthClientId,issuedAt,operationId,planHash:expectedPlanHash,
      approvalHash:retained.approvalHash,deltaFingerprint:retained.deltaFingerprint,initialReceiptHash:retained.initialReceiptHash,
      originGeneration:retained.plan.appGeneration,appSourceFingerprint:retained.plan.appSourceFingerprint,
      installationJournalFingerprint:p.installationJournalFingerprint,sourceRuntimeFingerprint:p.sourceRuntimeFingerprint,
      installedRuntimeFingerprint:p.installedRuntimeFingerprint,runtimeFingerprint:retained.plan.nativeRuntimeAfterFingerprint,...retained.inventory}
    const bytes=json(proof);need(bytes.length<=262144&&!/[^\x20-\x7e]/.test(bytes),'proof_size')
    const signature=sign('sha256',Buffer.from(bytes,'ascii'),{key:key!,padding:constants.RSA_PKCS1_PADDING}).toString('base64')
    need(/^[A-Za-z0-9+/]{512}(?![\s\S])/.test(signature)&&verify('sha256',Buffer.from(bytes,'ascii'),
      {key:publicKey,padding:constants.RSA_PKCS1_PADDING},Buffer.from(signature,'base64')),'signature')
    return {proof,signature}
  }}
}
