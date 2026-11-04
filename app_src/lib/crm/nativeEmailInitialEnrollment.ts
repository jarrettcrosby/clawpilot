import 'server-only'
import { nativeEmailCanonicalJson as json, nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'
import { NATIVE_EMAIL_CAPABILITY_SURFACES as SURFACES, prepareNativeEmailCapabilityContract,
  type NativeEmailCapabilityContract, type NativeEmailCapabilityMatrix } from './nativeEmailCapabilityContract'
import { prepareNativeEmailInitialInstallationLineage,
  type NativeEmailInitialInstallationLineage } from './nativeEmailInitialInstallationLineage'

type Surface = typeof SURFACES[number]
export type NativeEmailInitialEmailState = {
  localId: string; nativeId: string; globalId: string; pipelineId: string; workspaceId: string
  archived: boolean; recordFingerprint: string; capabilities: NativeEmailCapabilityMatrix
}
export type NativeEmailInitialDefaultRow = { id: string; action: Surface; aclAccess: number }
export type NativeEmailInitialPipeline = { groupId: string; policy: NativeEmailCapabilityContract }
export type NativeEmailInitialRevocation = { nativeId: string; surface: Surface; principalId: string }
type NativeEmailInitialEnrollmentFields = {
  version: 1; operationId: string; nativeInstanceId: string
  appGeneration: number; appSourceFingerprint: string
  nativePolicyBeforeFingerprint: string; nativeRuntimeBeforeFingerprint: string
  nativePolicyAfterFingerprint: string; nativeRuntimeAfterFingerprint: string
  principalSuiteCrmUserIds: string[]
  defaults: Array<{ before: NativeEmailInitialDefaultRow; after: NativeEmailInitialDefaultRow }>
  emails: Array<{ before: NativeEmailInitialEmailState; after: NativeEmailInitialEmailState }>
  pipelines: NativeEmailInitialPipeline[]; reviewedRevocations: NativeEmailInitialRevocation[]
  rootEmployeeGrants: []
}
export type NativeEmailInitialEnrollmentInput = NativeEmailInitialEnrollmentFields & (
  { kind: 'initial_enrollment_plan_v1' }
  | { kind: 'initial_enrollment_replan_v1'; installationLineage: NativeEmailInitialInstallationLineage }
)
/** Independent server-collected source and separately reviewed intent. This
 * type is NOT proof that collection, review, writer drain or authorization
 * actually occurred. No route/browser may supply it as authority. */
export type NativeEmailInitialEnrollmentEvidence = {
  complete: { appEmails: boolean; nativeEmails: boolean; nativePrincipals: boolean; pipelineAuthority: boolean; nativeDefaults: boolean }
  nativeInstanceId: string; appGeneration: number; appSourceFingerprint: string
  nativePolicyFingerprint: string; nativeRuntimeFingerprint: string
  principalSuiteCrmUserIds: string[]; emails: NativeEmailInitialEmailState[]
  defaults: NativeEmailInitialDefaultRow[]; approvedPipelines: NativeEmailInitialPipeline[]
  reviewedRevocations: NativeEmailInitialRevocation[]
}
const HASH = /^[a-f0-9]{64}(?![\s\S])/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const ID = /^[a-z0-9][a-z0-9-]{0,35}(?![\s\S])/i
const GLOBAL = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/
const same = (a: unknown,b: unknown) => json(a) === json(b)
function need(value: unknown,code: string): asserts value { requireNativeEmail(value,'initial_enrollment_'+code) }
function keys(value: unknown,expected: readonly string[]): asserts value is Record<string,unknown> {
  need(value && typeof value==='object' && !Array.isArray(value)
    && same(Object.keys(value).sort(),[...expected].sort()),'shape')
}
function matches(value: unknown,pattern: RegExp) { return typeof value==='string' && pattern.test(value) }
function list(value: unknown,max: number): asserts value is unknown[] {
  need(Array.isArray(value) && value.length<=max && Object.keys(value).length===value.length,'bound')
}
function ids(value: unknown): asserts value is string[] {
  list(value,500)
  need(value.every((id,index)=>matches(id,ID) && (index===0 || String(value[index-1])<String(id))),'principals')
}
function matrix(value: unknown,principals: string[]): asserts value is NativeEmailCapabilityMatrix {
  keys(value,SURFACES)
  for(const surface of SURFACES){ids(value[surface]);need(value[surface].every(id=>principals.includes(id)),'unknown_principal')}
  const readers=value.view;ids(readers)
  for(const surface of ['edit','delete'] as const){
    const writers=value[surface];ids(writers)
    need(writers.every(id=>readers.includes(id)),'write_without_read')
  }
}
function email(value: unknown,principals: string[]): asserts value is NativeEmailInitialEmailState {
  keys(value,['localId','nativeId','globalId','pipelineId','workspaceId','archived','recordFingerprint','capabilities'])
  need(['localId','pipelineId','workspaceId'].every(key=>matches(value[key],UUID))
    && matches(value.nativeId,ID) && matches(value.globalId,GLOBAL) && matches(value.recordFingerprint,HASH)
    && typeof value.archived==='boolean','email_identity')
  matrix(value.capabilities,principals)
}
function identity(value: NativeEmailInitialEmailState){const {capabilities,...rest}=value;void capabilities;return rest}
function defaultRow(value: unknown): asserts value is NativeEmailInitialDefaultRow {
  keys(value,['id','action','aclAccess']);need(matches(value.id,ID) && SURFACES.includes(value.action as Surface)
    && Number.isSafeInteger(value.aclAccess),'defaults')
}
const revokeKey = (row: NativeEmailInitialRevocation) => [row.nativeId,row.surface,row.principalId].join(':')
function revocations(value: unknown,principals: string[]): asserts value is NativeEmailInitialRevocation[] {
  list(value,125000);let prior=''
  for(const row of value){keys(row,['nativeId','surface','principalId'])
    need(matches(row.nativeId,ID) && SURFACES.includes(row.surface as Surface) && principals.includes(String(row.principalId)),'revocation')
    const key=revokeKey(row as NativeEmailInitialRevocation);need(key>prior,'revocation_order');prior=key}
}
function immutable<T>(value: T): T {
  if(value && typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value)}return value
}

/** PREPARATORY ONLY: fixed-shape intent and independent-source comparisons.
 * No SQL, native call, receipt, signature, drain, installer or activation.
 * The missing production executor must still authenticate the operator,
 * collect/fence every source, obtain exact approval and verify real execution.
 * Historical initial enrollment permits reviewed revocations only; new root
 * or reader/editor grants belong to the separate native-first workflows. */
export function prepareNativeEmailInitialEnrollment(value: NativeEmailInitialEnrollmentInput,
  evidence: NativeEmailInitialEnrollmentEvidence) {
  keys(value,['version','kind','operationId','nativeInstanceId','appGeneration','appSourceFingerprint',
    'nativePolicyBeforeFingerprint','nativeRuntimeBeforeFingerprint','nativePolicyAfterFingerprint','nativeRuntimeAfterFingerprint',
    'principalSuiteCrmUserIds','defaults','emails','pipelines','reviewedRevocations','rootEmployeeGrants',
    ...(value?.kind === 'initial_enrollment_replan_v1' ? ['installationLineage'] : [])])
  keys(evidence,['complete','nativeInstanceId','appGeneration','appSourceFingerprint','nativePolicyFingerprint','nativeRuntimeFingerprint',
    'principalSuiteCrmUserIds','emails','defaults','approvedPipelines','reviewedRevocations'])
  keys(evidence.complete,['appEmails','nativeEmails','nativePrincipals','pipelineAuthority','nativeDefaults'])
  need(Object.values(evidence.complete).every(flag=>flag===true),'incomplete_source')
  need(value.version===1 && ['initial_enrollment_plan_v1','initial_enrollment_replan_v1'].includes(value.kind) && matches(value.operationId,HASH)
    && matches(value.nativeInstanceId,ID) && Number.isSafeInteger(value.appGeneration) && value.appGeneration>0,'identity')
  for(const key of ['appSourceFingerprint','nativePolicyBeforeFingerprint','nativeRuntimeBeforeFingerprint',
    'nativePolicyAfterFingerprint','nativeRuntimeAfterFingerprint'] as const)need(matches(value[key],HASH),'fingerprint')
  if(value.kind === 'initial_enrollment_replan_v1') {
    const lineage = prepareNativeEmailInitialInstallationLineage(value.installationLineage, value.operationId)
    need(lineage.freshInstalledRuntimeFingerprint === value.nativeRuntimeBeforeFingerprint, 'replan_runtime_mismatch')
  }
  need(value.nativeInstanceId===evidence.nativeInstanceId && value.appGeneration===evidence.appGeneration
    && value.appSourceFingerprint===evidence.appSourceFingerprint
    && value.nativePolicyBeforeFingerprint===evidence.nativePolicyFingerprint
    && value.nativeRuntimeBeforeFingerprint===evidence.nativeRuntimeFingerprint,'source_drift')
  ids(value.principalSuiteCrmUserIds);ids(evidence.principalSuiteCrmUserIds)
  const principals=value.principalSuiteCrmUserIds
  need(principals.length>0 && same(principals,evidence.principalSuiteCrmUserIds),'principal_drift')
  list(value.rootEmployeeGrants,0)
  list(value.defaults,5);list(evidence.defaults,5);need(value.defaults.length===5 && evidence.defaults.length===5,'defaults')
  const defaults=new Set<string>(),defaultIds=new Set<string>();let previousDefault=''
  for(const delta of value.defaults){keys(delta,['before','after']);defaultRow(delta.before);defaultRow(delta.after)
    need(delta.before.action>previousDefault && !defaultIds.has(delta.before.id),'defaults')
    previousDefault=delta.before.action;defaultIds.add(delta.before.id);defaults.add(delta.before.action)
    need(delta.before.id===delta.after.id && delta.before.action===delta.after.action && delta.before.aclAccess===90
      && delta.after.aclAccess===(['view','list','export'].includes(delta.after.action)?80:75),'defaults')}
  need(defaults.size===5 && same(value.defaults.map(row=>row.before),evidence.defaults),'default_source_drift')
  list(value.emails,500);list(evidence.emails,500)
  need(value.emails.length>0 && value.emails.length===evidence.emails.length,'email_inventory')
  list(value.pipelines,100);list(evidence.approvedPipelines,100)
  need(value.pipelines.length>0 && same(value.pipelines,evidence.approvedPipelines),'future_policy_not_reviewed')
  const pipelines=new Map<string,NativeEmailInitialPipeline>(),groups=new Set<string>();let previousPipeline=''
  for(const row of value.pipelines){keys(row,['groupId','policy']);need(matches(row.groupId,UUID) && !groups.has(row.groupId),'group_identity')
    const p=row.policy;need(p && p.pipelineId>previousPipeline && p.historical.length===0,'pipeline_order')
    const prepared=prepareNativeEmailCapabilityContract(p,{binding:{pipelineId:p.pipelineId,workspaceId:p.workspaceId,
      ownerSuiteCrmId:p.ownerSuiteCrmId,audienceFingerprint:p.audienceFingerprint,allowedReaderSuiteCrmUserIds:p.futureCreate.view},
      livePrincipalSuiteCrmUserIds:principals,approvedFutureCreate:p.futureCreate,liveHistorical:[]})
    need(matches(p.workspaceId,UUID),'pipeline_identity');groups.add(row.groupId);previousPipeline=p.pipelineId
    pipelines.set(prepared.contract.pipelineId,row)}
  revocations(value.reviewedRevocations,principals);revocations(evidence.reviewedRevocations,principals)
  need(same(value.reviewedRevocations,evidence.reviewedRevocations),'revocations_not_reviewed')
  const actual: NativeEmailInitialRevocation[]=[],locals=new Set<string>(),natives=new Set<string>(),globals=new Set<string>()
  let previousEmail=''
  for(let index=0;index<value.emails.length;index++){
    const pair=value.emails[index];keys(pair,['before','after']);email(pair.before,principals);email(pair.after,principals)
    email(evidence.emails[index],principals)
    const before=pair.before,after=pair.after,pipeline=pipelines.get(before.pipelineId)
    need(before.nativeId>previousEmail && !locals.has(before.localId) && !natives.has(before.nativeId) && !globals.has(before.globalId),'duplicate_identity')
    previousEmail=before.nativeId;locals.add(before.localId);natives.add(before.nativeId);globals.add(before.globalId)
    need(same(before,evidence.emails[index]),'email_source_drift')
    need(same(identity(before),identity(after)),'historical_content_or_identity_changed')
    need(pipeline && pipeline.policy.workspaceId===before.workspaceId,'email_pipeline')
    for(const surface of SURFACES){
      need(after.capabilities[surface].every(id=>before.capabilities[surface].includes(id)),'historical_grant_forbidden')
      for(const principalId of before.capabilities[surface])if(!after.capabilities[surface].includes(principalId))
        actual.push({nativeId:before.nativeId,surface,principalId})
      if(surface!=='edit' && surface!=='delete')need(same(after.capabilities[surface],pipeline.policy.futureCreate.view),'reader_binding')
    }
  }
  actual.sort((a,b)=>revokeKey(a)<revokeKey(b)?-1:revokeKey(a)>revokeKey(b)?1:0)
  need(same(actual,value.reviewedRevocations),'unreviewed_capability_change')
  const canonical=json(value);need(Buffer.byteLength(canonical,'utf8')<=1800000,'size')
  return immutable({version:1 as const,kind:'native_email_initial_enrollment_preparation' as const,executable:false as const,
    activationReceipt:null,plan:JSON.parse(canonical) as NativeEmailInitialEnrollmentInput,planHash:nativeEmailDigest(value),
    sourceFingerprint:nativeEmailDigest(evidence),requires:['authenticated_source_collection','writer_drain','exact_operator_approval',
      'offline_installation','fenced_native_execution','native_terminal_receipt','atomic_pg_activation'] as const})
}

/** Compare with an independently retained reviewed pin, never a hash computed
 * from the untrusted candidate merely to make this validation pass. */
export function verifyNativeEmailInitialEnrollmentFingerprint(value: NativeEmailInitialEnrollmentInput,
  evidence: NativeEmailInitialEnrollmentEvidence,expectedPlanHash: string) {
  const prepared=prepareNativeEmailInitialEnrollment(value,evidence)
  need(matches(expectedPlanHash,HASH) && prepared.planHash===expectedPlanHash,'reviewed_plan_changed')
  return prepared
}
