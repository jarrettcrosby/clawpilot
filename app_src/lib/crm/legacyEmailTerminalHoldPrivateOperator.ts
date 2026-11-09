import 'server-only'
import {createHash, randomBytes, type KeyObject} from 'node:crypto'
import {closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync} from 'node:fs'
import {dirname, isAbsolute, join, resolve} from 'node:path'
import {types} from 'node:util'
import {holdExactLegacyEmailsPrivately, resolveExactLegacyEmailTerminalHoldPrivately}
  from '../persistence/crmLegacyEmailTerminalHold'
import type {withTransaction} from '../persistence/postgres'
import {legacyEmailTerminalHoldManifestDigest, snapshotLegacyEmailTerminalHoldReview,
  verifyLegacyEmailTerminalHoldApproval, type LegacyEmailTerminalHoldManifest, type LegacyEmailTerminalHoldReview}
  from './legacyEmailRetirementApproval'
import {parseLegacyEmailTerminalHoldJournal, reserveLegacyEmailTerminalHoldJournal,
  type LegacyEmailTerminalHoldJournal} from './legacyEmailTerminalHoldJournal'
import {nativeEmailRecoveryCliTargetFingerprint, type NativeEmailRecoveryCliTarget} from './nativeEmailRecoveryCliTransport'
import {verifyNativeEmailRecoveryCustodyProof, type NativeEmailRecoveryCustodyChallenge,
  type NativeEmailRecoveryCustodyExpected} from './nativeEmailRecoveryCustodyProof'
import {nativeEmailPostgresStoreFingerprint, nativeEmailRecoveryStoreBindingFingerprint} from './nativeEmailRecoveryStoreBinding'
import {nativeEmailCanonicalJson, nativeEmailDigest, NativeEmailPublicationHeld, requireNativeEmail} from './nativeEmailPublication'

type Transaction = typeof withTransaction
type PostgresIdentity = Parameters<typeof nativeEmailPostgresStoreFingerprint>[0]
type Anchor = Readonly<{keyId:string;key:KeyObject}>
type Destination = Readonly<{
  native:NativeEmailRecoveryCliTarget;postgres:PostgresIdentity;appCommit:string;nativeCommit:string
}>
type Selection = Readonly<{operationId:string;manifestDigest:string;approvalDigest:string;fenceEpoch:string;outboxIds:readonly string[]}>
type Custody = Readonly<{anchor:Anchor;expiresAt:number;controllerConfigHash:string;producerInventoryHash:string}>
type DirectLane = Readonly<{role:string;transaction:Transaction}>
type RebuildSelection = Readonly<Pick<LegacyEmailTerminalHoldManifest,
  'operationId'|'scope'|'fenceEpoch'|'actorEmail'|'operatorAccountId'|'rootWorkspaceId'> & {outboxIds:readonly string[]}>
const JOURNAL='clawpilot-private-legacy-email-terminal-hold-journal-v1' as const
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const HASH=/^[0-9a-f]{64}(?![\s\S])/u
const COMMIT=/^[0-9a-f]{40}(?![\s\S])/u
const NAME=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}(?![\s\S])/u
const KEY=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u
const matches=(value:unknown,re:RegExp):value is string=>typeof value==='string'&&re.test(value)
const now=()=>Math.floor(Date.now()/1000)
const canonical=nativeEmailCanonicalJson
const prefix='private_legacy_email_terminal_hold_'
function need(value:unknown,code:string):asserts value {requireNativeEmail(value,prefix+code)}
function exact(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown> {
  need(value&&typeof value==='object'&&!types.isProxy(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
    &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{
      const d=Object.getOwnPropertyDescriptor(value,key)
      return d?.enumerable&&'value' in d
    }),'shape')
}
async function bounded<T>(run:()=>Promise<T>,code:string):Promise<T> {
  try{return await run()}catch(error){
    if(error instanceof NativeEmailPublicationHeld&&/^[a-z0-9_]{1,110}$/u.test(error.code))throw error
    need(false,code)
  }
}

export function legacyEmailTerminalHoldPrivateDestination(input:Destination) {
  exact(input,['native','postgres','appCommit','nativeCommit'])
  const {native,postgres,appCommit,nativeCommit}=input
  need(native&&typeof native==='object'&&!types.isProxy(native)&&matches(appCommit,COMMIT)&&matches(nativeCommit,COMMIT),'destination')
  const nativeFingerprint=nativeEmailRecoveryCliTargetFingerprint(native)
  const postgresDatabaseFingerprint=nativeEmailPostgresStoreFingerprint(postgres)
  const scope=Object.freeze({projectId:native.projectId,environmentId:native.environmentId,appCommit,nativeCommit,
    nativeDeploymentId:native.deploymentId,nativeReplicaId:native.replicaId,nativeAuthorityInstanceId:native.nativeInstanceId,
    nativeDatabaseFingerprint:native.mariaStoreFingerprint,postgresDatabaseFingerprint})
  const targetFingerprint=nativeEmailDigest({version:1,purpose:'clawpilot-terminal-hold-destination-v1',scope,nativeFingerprint})
  const storeBindingFingerprint=nativeEmailRecoveryStoreBindingFingerprint({targetFingerprint,
    postgresStoreFingerprint:postgresDatabaseFingerprint,mariaStoreFingerprint:scope.nativeDatabaseFingerprint})
  return Object.freeze({scope,targetFingerprint,storeBindingFingerprint,postgres:Object.freeze({...postgres})})
}

/** Hash-only, operation-specific inputs for the independently owned custodian. */
export function legacyEmailTerminalHoldCustodySelection(input:Readonly<{
  operationId:string;manifestDigest:string;approvalDigest:string;targetFingerprint:string
}>) {
  exact(input,['operationId','manifestDigest','approvalDigest','targetFingerprint'])
  const {operationId,manifestDigest,approvalDigest,targetFingerprint}=input
  need(matches(operationId,UUID)&&[manifestDigest,approvalDigest,targetFingerprint].every(x=>matches(x,HASH)),'custody_selection')
  return Object.freeze({operationId:nativeEmailDigest({version:1,purpose:'clawpilot-terminal-hold-custody-operation-v1',operationId}),
    requestFingerprint:nativeEmailDigest({version:1,purpose:'clawpilot-terminal-hold-custody-request-v1',
      action:'hold_without_publication',manifestDigest,approvalDigest,targetFingerprint})})
}

function selectedRows(input:Selection) {
  exact(input,['operationId','manifestDigest','approvalDigest','fenceEpoch','outboxIds'])
  const {outboxIds,...pins}=input
  need(Array.isArray(outboxIds)&&!types.isProxy(outboxIds)&&Object.getPrototypeOf(outboxIds)===Array.prototype
    &&outboxIds.length>=1&&outboxIds.length<=25&&Reflect.ownKeys(outboxIds).length===outboxIds.length+1,'outbox_selection')
  const rows=Array.from({length:outboxIds.length},(_,index)=>{
    const d=Object.getOwnPropertyDescriptor(outboxIds,String(index))
    need(d?.enumerable&&'value' in d&&matches(d.value,UUID),'outbox_selection')
    return d.value as string
  })
  need(rows.every((row,index)=>index===0||rows[index-1]<row),'outbox_selection')
  return Object.freeze({...pins,outboxIds:Object.freeze(rows)})
}
function anchor(input:Anchor) {
  exact(input,['keyId','key'])
  need(matches(input.keyId,KEY)&&types.isKeyObject(input.key)&&!types.isProxy(input.key),'anchor')
  const key=structuredClone(input.key)
  need(key.type==='public'&&key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails?.modulusLength===3072,'anchor')
  return Object.freeze({keyId:input.keyId,key})
}

function journalPath(directory:string,operationId:string) {
  need(typeof directory==='string'&&isAbsolute(directory)&&resolve(directory)===directory&&directory!=='/'
    &&!/[\p{Cc}]/u.test(directory)&&Buffer.byteLength(directory,'utf8')<=3900&&matches(operationId,UUID),'journal_path')
  return join(directory,`terminal-hold-${operationId}.json`)
}
const journalTargetFingerprint=(targetFingerprint:string,attestorRole:string,controllerRole:string)=>
  nativeEmailDigest({version:1,purpose:'clawpilot-terminal-hold-journal-target-v1',targetFingerprint,attestorRole,controllerRole})
function requireUnattempted(path:string) {
  try{lstatSync(path)}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return
    need(false,'journal_unreadable')
  }
  requireNativeEmail(false,'legacy_email_terminal_hold_journal_already_reserved')
}
function readPins(path:string,expected:LegacyEmailTerminalHoldJournal) {
  try{
    const directory=dirname(path)
    const dir=lstatSync(directory)
    need(realpathSync(directory)===directory&&dir.isDirectory()&&dir.uid===process.geteuid?.()
      &&(dir.mode&0o7777)===0o700,'journal_directory')
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
    try{
      const before=fstatSync(fd)
      const verify=()=>{
        const named=lstatSync(path),current=fstatSync(fd),parent=lstatSync(directory)
        need(parent.dev===dir.dev&&parent.ino===dir.ino&&parent.mode===dir.mode&&parent.uid===dir.uid
          &&current.dev===before.dev&&current.ino===before.ino&&named.dev===before.dev&&named.ino===before.ino
          &&current.isFile()&&current.uid===dir.uid&&current.nlink===1&&(current.mode&0o7777)===0o600
          &&current.size===before.size&&current.size>0&&current.size<=4096,'journal_file')
      }
      verify()
      const bytes=readFileSync(fd,'utf8')
      verify()
      const pins=parseLegacyEmailTerminalHoldJournal(JSON.parse(bytes))
      need(bytes===canonical(expected)+'\n'&&canonical(pins)===canonical(expected),'journal_changed')
      return pins
    }finally{closeSync(fd)}
  }catch(error){
    if(error instanceof NativeEmailPublicationHeld)throw error
    need(false,'journal_unreadable')
  }
}

const IDENTITY=`SELECT d.datname::text AS database_name,d.oid::text AS database_oid,
  ctl.system_identifier::text AS system_identifier,SESSION_USER::text AS login,CURRENT_USER::text AS role,
  NOT pg_catalog.pg_is_in_recovery() AS primary_server,
  pg_catalog.current_setting('transaction_read_only') AS read_only,
  pg_catalog.current_setting('transaction_isolation')='read committed' AS read_committed,
  r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS restricted_login
  FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() ctl
  JOIN pg_catalog.pg_roles r ON r.rolname=SESSION_USER
  WHERE d.datname=pg_catalog.current_database()`

function direct(lane:DirectLane,postgres:PostgresIdentity,readOnly:boolean,guard:()=>void):Transaction {
  exact(lane,['role','transaction'])
  const {role,transaction}=lane
  need(matches(role,NAME)&&typeof transaction==='function','direct_lane')
  return async run=>{
    let calls=0,active=true
    const checkLane=()=>{need(active&&calls===1,'direct_lane_lost');guard()}
    const state:{result?:{value:Awaited<ReturnType<typeof run>>}}={}
    try{return await bounded(async()=>{
      guard()
      const returned=await transaction(tx=>{
        need(++calls===1,'direct_lane_reused')
        const pending=(async()=>{
          checkLane()
          const {rows}=await tx.query(IDENTITY)
          const row=rows[0]
          need(rows.length===1&&row?.database_name===postgres.database&&row.database_oid===postgres.databaseOid
            &&row.system_identifier===postgres.systemIdentifier&&row.login===role&&row.role===role
            &&row.primary_server===true&&row.read_only===(readOnly?'on':'off')&&row.read_committed===true
            &&row.restricted_login===true,'physical_lane_identity')
          checkLane()
          const checked=new Proxy(tx,{get(target,key){
            if(key==='query')return (...args:unknown[])=>{checkLane();return Reflect.apply(target.query,target,args)}
            return Reflect.get(target,key,target)
          }})
          const result={value:await run(checked)}
          checkLane()
          state.result=result
          return result
        })()
        void pending.catch(()=>{})
        return pending
      })
      guard()
      need(calls===1&&state.result&&returned===state.result,'direct_lane_result')
      return returned.value
    },'direct_lane_failure')}finally{active=false}
  }
}

/** The host must actually retain both writer closures and separately verify
 * the direct transaction/custody capabilities. Neither this library nor an
 * observed nonce response establishes the fence. There is no replay path. */
export async function applyLegacyEmailTerminalHoldPrivately(input:{
  selection:Selection;destination:Destination;journalDirectory:string;review:LegacyEmailTerminalHoldReview;custody:Custody
  attestor:DirectLane;controller:DirectLane
  withRetainedClosure<T>(run:()=>Promise<T>):Promise<T>
  observeCustody(challenge:NativeEmailRecoveryCustodyChallenge,signal:AbortSignal):Promise<unknown>
  rebuildManifest(selection:RebuildSelection):Promise<unknown>
}) {
  exact(input,['selection','destination','journalDirectory','review','custody','attestor','controller',
    'withRetainedClosure','observeCustody','rebuildManifest'])
  const {selection,destination,journalDirectory,custody,attestor,controller,withRetainedClosure,observeCustody,rebuildManifest}=input
  exact(custody,['anchor','expiresAt','controllerConfigHash','producerInventoryHash'])
  const {expiresAt,controllerConfigHash,producerInventoryHash}=custody
  const custodian=anchor(custody.anchor)
  const {review,canonical:approvedBytes,manifestDigest}=snapshotLegacyEmailTerminalHoldReview(input.review)
  const {scope,targetFingerprint,storeBindingFingerprint,postgres}=legacyEmailTerminalHoldPrivateDestination(destination)
  const {outboxIds,...pins}=selectedRows(selection)
  const manifest=review.expectedManifest
  need(manifestDigest===pins.manifestDigest&&manifest.operationId===pins.operationId&&manifest.fenceEpoch===pins.fenceEpoch
    &&manifest.fenceEvidenceFingerprint!=='0'.repeat(64)&&manifest.nativeAbsenceFingerprint!=='0'.repeat(64)
    &&canonical(manifest.scope)===canonical(scope)&&canonical(manifest.rows.map(row=>row.outboxId))===canonical(outboxIds),'review_scope')
  const approved=verifyLegacyEmailTerminalHoldApproval({...review,nowSeconds:now()})
  need(approved.approvalEnvelopeDigest===pins.approvalDigest,'approval_pins')
  const anchors=[review.fenceAnchor,review.operatorAnchor,custodian]
  need(new Set(anchors.map(a=>a.keyId)).size===3
    &&new Set(anchors.map(a=>createHash('sha256').update(a.key.export({format:'der',type:'spki'})).digest('hex'))).size===3,'distinct_anchors')
  need(matches(controllerConfigHash,HASH)&&matches(producerInventoryHash,HASH)&&Number.isSafeInteger(expiresAt)
    &&expiresAt>now()+8&&expiresAt<=now()+900&&approved.expiresAt<=expiresAt,'custody_window')
  exact(attestor,['role','transaction']);exact(controller,['role','transaction'])
  const attestorRole=attestor.role,controllerRole=controller.role
  need(attestorRole!==controllerRole&&attestor.transaction!==controller.transaction,'role_separation')
  need([withRetainedClosure,observeCustody,rebuildManifest].every(fn=>typeof fn==='function'),'private_dependencies')
  const path=journalPath(journalDirectory,pins.operationId)
  const expected=parseLegacyEmailTerminalHoldJournal({version:1,purpose:JOURNAL,...pins,expectedRows:outboxIds.length,
    targetFingerprint:journalTargetFingerprint(targetFingerprint,attestorRole,controllerRole)})
  // A completed or partial journal already decides the next action (inspect
  // only). The O_EXCL reservation below still arbitrates simultaneous starts.
  requireUnattempted(path)
  const rebuildSelection=Object.freeze({scope,operationId:pins.operationId,fenceEpoch:pins.fenceEpoch,
    actorEmail:manifest.actorEmail,operatorAccountId:manifest.operatorAccountId,rootWorkspaceId:manifest.rootWorkspaceId,outboxIds})
  const custodySelection=legacyEmailTerminalHoldCustodySelection({operationId:pins.operationId,
    manifestDigest,approvalDigest:pins.approvalDigest,targetFingerprint})
  let open=true,calls=0
  const completion:{result?:Readonly<{state:'committed';operationId:string;rows:number;targetFingerprint:string}>}={}
  const checkClosure=()=>need(open&&calls===1,'closure_lost')
  const guard=()=>{checkClosure();need(now()<approved.expiresAt&&now()<expiresAt,'approval_expired')}
  const observe=async(phase:'before'|'after')=>{
    checkClosure()
    need(now()+(phase==='before'?8:0)<expiresAt,'custody_expired')
    const expected:NativeEmailRecoveryCustodyExpected=Object.freeze({
      nonce:randomBytes(32).toString('hex'),phase,fenceEpoch:pins.fenceEpoch,expiresAt,
      targetFingerprint,storeBindingFingerprint,...custodySelection,controllerConfigHash,producerInventoryHash,
    })
    const challenge=Object.freeze({version:2 as const,purpose:'clawpilot-native-email-recovery-custody-challenge-v2' as const,...expected})
    const abort=new AbortController()
    const deadline=setTimeout(()=>abort.abort(),5000)
    let response:unknown
    try{
      const timeout=new Promise<never>((_resolve,reject)=>abort.signal.addEventListener('abort',
        ()=>reject(new NativeEmailPublicationHeld(prefix+'custody_timeout')),{once:true}))
      response=await bounded(()=>Promise.race([observeCustody(challenge,abort.signal),timeout]),'custody_observation_failed')
    }finally{clearTimeout(deadline)}
    checkClosure()
    need(!abort.signal.aborted,'custody_timeout')
    verifyNativeEmailRecoveryCustodyProof({envelope:response,expected,anchor:custodian,nowSeconds:now()})
  }
  const directAttestor=direct(attestor,postgres,false,guard),directController=direct(controller,postgres,false,guard)
  try{
    const returned=await bounded(()=>withRetainedClosure(()=>{
      ++calls
      const pending=(async()=>{
        guard()
        await observe('before')
        guard()
        try{
          const rebuilt=await bounded(()=>rebuildManifest(rebuildSelection),'manifest_observation_failed')
          guard()
          need(legacyEmailTerminalHoldManifestDigest(rebuilt)===manifestDigest&&canonical(rebuilt)===approvedBytes,'manifest_drift')
          const result=await holdExactLegacyEmailsPrivately(review,{
            expectedRoles:{attestor:attestorRole,controller:controllerRole},
            withLiveFence:async (inside,run)=>{
              guard()
              need(legacyEmailTerminalHoldManifestDigest(inside)===manifestDigest&&canonical(inside)===approvedBytes,'manifest_drift')
              reserveLegacyEmailTerminalHoldJournal(path,expected)
              readPins(path,expected)
              return run()
            },
            retainResolutionPins:async value=>{
              guard()
              need(value.operationId===pins.operationId&&value.manifestDigest===manifestDigest
                &&value.approvalDigest===pins.approvalDigest,'adapter_pins')
              readPins(path,expected)
            },
            attestTransaction:directAttestor,
            holdTransaction:async run=>{
              guard();readPins(path,expected)
              await observe('before')
              guard();readPins(path,expected)
              return directController(run)
            },
          })
          need(result.operationId===pins.operationId&&result.manifestDigest===manifestDigest&&result.approvalDigest===pins.approvalDigest,'adapter_pins')
        }finally{await observe('after')}
        readPins(path,expected)
        completion.result=Object.freeze({state:'committed',operationId:pins.operationId,rows:outboxIds.length,targetFingerprint})
        return completion.result
      })()
      void pending.catch(()=>{})
      return pending
    }),'closure_failed')
    need(completion.result&&returned===completion.result&&calls===1,'closure_unverified')
    return completion.result
  }finally{open=false}
}

/** Inspect the original journal only. This does not require an unexpired
 * approval and cannot re-arm, apply, settle, or retry an uncertain attempt. */
export async function inspectLegacyEmailTerminalHoldPrivately(input:{
  destination:Destination;journalDirectory:string
  pins:Omit<LegacyEmailTerminalHoldJournal,'version'|'purpose'|'targetFingerprint'>
  writerRoles:Readonly<{attestor:string;controller:string}>;observer:DirectLane
}) {
  exact(input,['destination','journalDirectory','pins','writerRoles','observer'])
  const {destination,journalDirectory,pins,writerRoles,observer}=input
  exact(pins,['operationId','manifestDigest','approvalDigest','fenceEpoch','expectedRows'])
  exact(writerRoles,['attestor','controller']);exact(observer,['role','transaction'])
  need([writerRoles.attestor,writerRoles.controller,observer.role].every(role=>matches(role,NAME))
    &&new Set([writerRoles.attestor,writerRoles.controller,observer.role]).size===3,'observer_role')
  const {targetFingerprint,postgres}=legacyEmailTerminalHoldPrivateDestination(destination)
  const expected=parseLegacyEmailTerminalHoldJournal({version:1,purpose:JOURNAL,...pins,
    targetFingerprint:journalTargetFingerprint(targetFingerprint,writerRoles.attestor,writerRoles.controller)})
  const path=journalPath(journalDirectory,expected.operationId)
  const retained=readPins(path,expected)
  const result=await resolveExactLegacyEmailTerminalHoldPrivately(direct(observer,postgres,true,()=>{}),retained)
  need(result.state==='unknown'||result.rows===retained.expectedRows,'receipt_count')
  readPins(path,expected)
  return result
}
