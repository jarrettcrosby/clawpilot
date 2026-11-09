import 'server-only'
import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { legacyEmailTerminalHoldManifestDigest, type LegacyEmailTerminalHoldManifest, type LegacyEmailTerminalHoldRow } from './legacyEmailRetirementApproval'
import { nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'

type Scope = Readonly<LegacyEmailTerminalHoldManifest['scope']>
type HoldRow = Readonly<LegacyEmailTerminalHoldRow>
type Phase = 'appBefore' | 'nativeAbsence' | 'appAfter'
type Identity = Pick<HoldRow, 'outboxId' | 'localId' | 'nativeId' | 'globalId'>

export type LegacyEmailTerminalHoldPreviewTarget = Readonly<{
  operationId: string; scope: Scope; actorEmail: string; operatorAccountId: string; rootWorkspaceId: string; fenceEpoch: string
  outboxIds: readonly string[]; postgresObserverFingerprint: string; nativeObserverFingerprint: string
}>
type Request<P extends Phase> = Readonly<{
  phase: P; observationId: string; candidateFingerprint: string; target: LegacyEmailTerminalHoldPreviewTarget
}>
export type LegacyEmailTerminalHoldAppObservationRequest = Request<'appBefore' | 'appAfter'>
export type LegacyEmailTerminalHoldNativeObservationRequest = Request<'nativeAbsence'> & Readonly<{ identities: readonly Identity[] }>
type Observation<P extends Phase> = Readonly<{
  phase: P; observationId: string; candidateFingerprint: string; storeFingerprint: string; observerFingerprint: string; observedAtMs: number
}>
export type LegacyEmailTerminalHoldAppObservation = Observation<'appBefore' | 'appAfter'> & Readonly<{
  appGeneration: number; gateFingerprint: string; appSourceFingerprint: string
  authorityDisabledIdle: true; operatorRootVerified: true; rows: readonly HoldRow[]
}>
const absenceKeys = ['emails','customById','customByGlobal','emailText','beanLinks','addressLinks','securityGroupLinks',
  'managedIdentities','nativeOperations'] as const
type Absence = Readonly<Record<(typeof absenceKeys)[number], 0>>
export type LegacyEmailTerminalHoldNativeObservation = Observation<'nativeAbsence'> & Readonly<{
  stockSchemaAbsenceFingerprint: string
  rows: readonly (Identity & Readonly<{ counts: Absence }>)[]
}>
export type LegacyEmailTerminalHoldManifestDraft = Readonly<Omit<LegacyEmailTerminalHoldManifest,
  'fenceEvidenceFingerprint' | 'scope' | 'rows'> & {scope: Scope; rows: readonly HoldRow[]}>

const scopeKeys = ['projectId','environmentId','postgresDatabaseFingerprint','appCommit','nativeDeploymentId',
  'nativeReplicaId','nativeCommit','nativeDatabaseFingerprint','nativeAuthorityInstanceId'] as const
const targetKeys = ['operationId','scope','actorEmail','operatorAccountId','rootWorkspaceId','fenceEpoch','outboxIds',
  'postgresObserverFingerprint','nativeObserverFingerprint'] as const
const observationKeys = ['phase','observationId','candidateFingerprint','storeFingerprint','observerFingerprint','observedAtMs'] as const
const appKeys = [...observationKeys,'appGeneration','gateFingerprint','appSourceFingerprint','authorityDisabledIdle','operatorRootVerified','rows'] as const
const identityKeys = ['outboxId','localId','nativeId','globalId'] as const
const rowKeys = [...identityKeys,'pipelineId','workspaceId','attempts','rowFingerprint','sourceFingerprint','payloadFingerprint',
  'keyFingerprint','relationshipFingerprint','providerIdentityFingerprint'] as const
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const HASH = /^[0-9a-f]{64}(?![\s\S])/u
const COMMIT = /^[0-9a-f]{40}(?![\s\S])/u
const ACTOR = /^[a-z0-9][a-z0-9.!#$%&'*+/=?^_\x60{|}~-]*@[a-z0-9.-]+\.[a-z0-9-]+(?![\s\S])/u
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9-]{0,35}(?![\s\S])/u
const MAX_ROWS = 25
const MAX_TIMEOUT_MS = 5000
// Database and app clocks can differ slightly, but a snapshot from before
// this invocation (or an implausibly future observation) is not usable.
const MAX_CLOCK_SKEW_MS = 1000
const NON_EMITTED_NO_CUSTODY_PLACEHOLDER = '0'.repeat(64)
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
function need(value: unknown, code: string): asserts value { requireNativeEmail(value, `legacy_terminal_hold_preview_${code}`) }
function exact(value: unknown, keys: readonly string[], code: string): asserts value is Record<string, unknown> {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype,null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => {
      const property = Object.getOwnPropertyDescriptor(value, key)
      return property?.enumerable && 'value' in property
    }), code)
}
function array(value: unknown, length: number, code: string): unknown[] {
  need(Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length === length && Reflect.ownKeys(value).length === length+1, code)
  const snapshot: unknown[] = []
  for (let index=0; index<length; index++) {
    const property = Object.getOwnPropertyDescriptor(value,String(index))
    need(property?.enumerable && 'value' in property, code)
    snapshot.push(property.value)
  }
  return snapshot
}
function snapshotTarget(input: unknown): LegacyEmailTerminalHoldPreviewTarget {
  exact(input,targetKeys,'target_shape')
  const {scope,outboxIds,operationId,actorEmail,operatorAccountId,rootWorkspaceId,fenceEpoch,postgresObserverFingerprint,nativeObserverFingerprint}=input
  exact(scope,scopeKeys,'scope_shape')
  need([operationId,operatorAccountId,rootWorkspaceId,fenceEpoch,scope.projectId,scope.environmentId,scope.nativeDeploymentId,
    scope.nativeReplicaId].every(value=>matches(value,UUID)) && matches(scope.nativeAuthorityInstanceId,INSTANCE)
    && [scope.appCommit,scope.nativeCommit].every(value=>matches(value,COMMIT))
    && matches(actorEmail,ACTOR) && actorEmail.length<=254,'target_identity')
  need([scope.postgresDatabaseFingerprint,scope.nativeDatabaseFingerprint,postgresObserverFingerprint,nativeObserverFingerprint]
    .every(value=>matches(value,HASH)) && scope.postgresDatabaseFingerprint!==scope.nativeDatabaseFingerprint
    && postgresObserverFingerprint!==nativeObserverFingerprint,'target_binding')
  need(Array.isArray(outboxIds) && !types.isProxy(outboxIds) && outboxIds.length>=1 && outboxIds.length<=MAX_ROWS,'exact_ids')
  const ids=array(outboxIds,outboxIds.length,'exact_ids')
  let previous=''
  for (const id of ids) { need(matches(id,UUID)&&id>previous,'exact_ids');previous=id }
  return Object.freeze({...input,scope:Object.freeze({...scope}),outboxIds:Object.freeze(ids)}) as LegacyEmailTerminalHoldPreviewTarget
}
function observation(value: Record<string,unknown>, request: Request<Phase>, startedAtMs: number, endedAtMs: number) {
  const {target,phase,observationId,candidateFingerprint}=request
  const native=phase==='nativeAbsence'
  need(value.phase===phase && value.observationId===observationId && value.candidateFingerprint===candidateFingerprint
    && value.storeFingerprint===(native?target.scope.nativeDatabaseFingerprint:target.scope.postgresDatabaseFingerprint)
    && value.observerFingerprint===(native?target.nativeObserverFingerprint:target.postgresObserverFingerprint),'observation_binding')
  const time=value.observedAtMs
  need(positiveInteger(time) && endedAtMs>=startedAtMs && time>=startedAtMs-MAX_CLOCK_SKEW_MS
    && time<=endedAtMs+MAX_CLOCK_SKEW_MS,'observation_clock')
  return time
}
function appSnapshot(value: unknown, request: LegacyEmailTerminalHoldAppObservationRequest, started: number, ended: number) {
  exact(value,appKeys,'app_shape')
  const observedAtMs=observation(value,request,started,ended)
  const {appGeneration,gateFingerprint,appSourceFingerprint}=value
  need(positiveInteger(appGeneration) && matches(gateFingerprint,HASH) && matches(appSourceFingerprint,HASH)
    && value.authorityDisabledIdle===true && value.operatorRootVerified===true,'app_authority')
  const rows=array(value.rows,request.target.outboxIds.length,'app_rows').map((row,index)=>{
    exact(row,rowKeys,'app_row_shape')
    need(row.outboxId===request.target.outboxIds[index],'app_rows')
    return Object.freeze({...row}) as HoldRow
  })
  return Object.freeze({observedAtMs,observationId:request.observationId,appGeneration,gateFingerprint,appSourceFingerprint,rows:Object.freeze(rows)})
}
function draft(target: LegacyEmailTerminalHoldPreviewTarget, app: ReturnType<typeof appSnapshot>, nativeAbsenceFingerprint: string):
  LegacyEmailTerminalHoldManifestDraft {
  return Object.freeze({version:1,action:'hold_exact_legacy_terminal_rows_in_place',publicationDisposition:'hold_without_publication',
    operationId:target.operationId,scope:target.scope,actorEmail:target.actorEmail,operatorAccountId:target.operatorAccountId,
    rootWorkspaceId:target.rootWorkspaceId,fenceEpoch:target.fenceEpoch,appGeneration:app.appGeneration,gateFingerprint:app.gateFingerprint,
    appSourceFingerprint:app.appSourceFingerprint,nativeAbsenceFingerprint,historicalProviderOutcome:'unknown',rows:app.rows})
}
function validateDraft(value: LegacyEmailTerminalHoldManifestDraft) {
  // Reuse the SQL contract's reviewed shape/identity checks, but do not emit
  // a full manifest or digest that an approval tool could sign as real custody.
  legacyEmailTerminalHoldManifestDigest({...value,fenceEvidenceFingerprint:NON_EMITTED_NO_CUSTODY_PLACEHOLDER})
}
function nativeSnapshot(value: unknown, request: LegacyEmailTerminalHoldNativeObservationRequest, started: number, ended: number) {
  exact(value,[...observationKeys,'stockSchemaAbsenceFingerprint','rows'],'native_shape')
  const observedAtMs=observation(value,request,started,ended)
  const stockSchemaAbsenceFingerprint=value.stockSchemaAbsenceFingerprint
  need(typeof stockSchemaAbsenceFingerprint==='string'&&HASH.test(stockSchemaAbsenceFingerprint)
    &&stockSchemaAbsenceFingerprint!==NON_EMITTED_NO_CUSTODY_PLACEHOLDER,'native_stock_schema')
  const rows=array(value.rows,request.identities.length,'native_rows').map((row,index)=>{
    exact(row,[...identityKeys,'counts'],'native_row_shape')
    need(identityKeys.every(key=>row[key]===request.identities[index][key]),'native_rows')
    exact(row.counts,absenceKeys,'native_count_shape')
    const counts=row.counts
    need(absenceKeys.every(key=>counts[key]===0),'native_not_absent')
    return Object.freeze({...request.identities[index],counts:Object.freeze({...counts})})
  })
  return Object.freeze({observedAtMs,observationId:request.observationId,stockSchemaAbsenceFingerprint,rows:Object.freeze(rows)})
}

/** Private, read-only preparation. The explicit ports must verify their own
 * pinned direct read-only connections and observe exactly the requested rows.
 * Echoed pins alone are not authentication. The Maria port must count all
 * matching native evidence, including deleted or orphaned records. A bracket
 * does not establish continuous closure; the separate authorized finalizer
 * must re-observe and rebuild the exact manifest under independent custody. */
export async function previewLegacyEmailTerminalHold(input: {
  target: LegacyEmailTerminalHoldPreviewTarget; timeoutMs: number
  observeApp(request: LegacyEmailTerminalHoldAppObservationRequest, signal: AbortSignal): Promise<unknown>
  observeNative(request: LegacyEmailTerminalHoldNativeObservationRequest, signal: AbortSignal): Promise<unknown>
}) {
  exact(input,['target','timeoutMs','observeApp','observeNative'],'observer_configuration')
  const {observeApp,observeNative,timeoutMs}=input
  const target=snapshotTarget(input.target)
  need(typeof observeApp==='function' && typeof observeNative==='function' && positiveInteger(timeoutMs)
    && timeoutMs<=MAX_TIMEOUT_MS,'observer_configuration')
  const candidateFingerprint=nativeEmailDigest({version:1,purpose:'clawpilot-legacy-terminal-hold-preview-target-v1',target})
  const abort=new AbortController(),started=performance.now()
  let timer: ReturnType<typeof setTimeout>|undefined
  const checkDeadline=()=>need(!abort.signal.aborted && performance.now()-started<timeoutMs,'timeout')
  const deadline=new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>{
      try { need(false,'timeout') } catch (error) { reject(error) }
      abort.abort()
    },timeoutMs)
  })
  const read=async <P extends Phase,R extends Request<P>,T>(request:R, fn:(request:R,signal:AbortSignal)=>Promise<unknown>,
    validate:(value:unknown,request:R,started:number,ended:number)=>T)=>{
    checkDeadline()
    const before=Date.now()
    let raw: unknown
    try { raw=await fn(request,abort.signal) } catch { checkDeadline();need(false,'observation_failed') }
    checkDeadline()
    return validate(raw,request,before,Date.now())
  }
  const makeRequest=<P extends Phase>(phase:P):Request<P>=>Object.freeze({phase,observationId:randomUUID(),candidateFingerprint,target})
  const work=async()=>{
    const appA=await read(makeRequest('appBefore'),observeApp,appSnapshot)
    validateDraft(draft(target,appA,NON_EMITTED_NO_CUSTODY_PLACEHOLDER))
    const identities=Object.freeze(appA.rows.map(({outboxId,localId,nativeId,globalId})=>Object.freeze({outboxId,localId,nativeId,globalId})))
    const native=await read(Object.freeze({...makeRequest('nativeAbsence'),identities}),observeNative,nativeSnapshot)
    const appB=await read(makeRequest('appAfter'),observeApp,appSnapshot)
    validateDraft(draft(target,appB,NON_EMITTED_NO_CUSTODY_PLACEHOLDER))
    const {observedAtMs:beforeTime,observationId:beforeId,...before}=appA
    const {observedAtMs:afterTime,observationId:afterId,...after}=appB
    need(beforeTime<=native.observedAtMs && native.observedAtMs<=afterTime,'observation_order')
    const beforeDigest=nativeEmailDigest(before)
    need(beforeDigest===nativeEmailDigest(after),'app_drift')
    const nativeAbsenceFingerprint=nativeEmailDigest({version:1,purpose:'clawpilot-legacy-terminal-hold-preview-native-absence-v1',
      candidateFingerprint,nativeDatabaseFingerprint:target.scope.nativeDatabaseFingerprint,
      nativeObserverFingerprint:target.nativeObserverFingerprint,native})
    const manifestDraft=draft(target,appA,nativeAbsenceFingerprint)
    validateDraft(manifestDraft)
    const previewDigest=nativeEmailDigest({version:1,purpose:'clawpilot-legacy-terminal-hold-preview-result-v1',
      candidateFingerprint,manifestDraft,appSnapshotDigest:beforeDigest,beforeId,afterId,beforeTime,afterTime})
    checkDeadline()
    return Object.freeze({count:manifestDraft.rows.length,previewDigest,manifestDraft,reviewOnly:true as const,
      liveFenceProven:false as const,holdAuthorized:false as const})
  }
  try { return await Promise.race([work(),deadline]) } finally { if(timer!==undefined)clearTimeout(timer);abort.abort() }
}
