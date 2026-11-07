import 'server-only'
import {createHash,createPublicKey,randomBytes} from 'node:crypto'
import {isAbsolute} from 'node:path'
import {
  inspectExactLegacyEmailAccountRepairPrivately,parseLegacyEmailAccountRepairTarget,
  previewExactLegacyEmailAccountRepairPrivately,repairExactLegacyEmailAccountsPrivately,
} from '../persistence/crmLegacyEmailAccountRepair'
import type {withTransaction} from '../persistence/postgres'
import {verifyLegacyEmailAccountRepairApproval} from './legacyEmailAccountRepairApproval'
import {parseNativeEmailAccountRepairJournal,reserveNativeEmailAccountRepairJournal} from './nativeEmailAccountRepairJournal'
import {nativeEmailRecoveryCliTargetFingerprint,type NativeEmailRecoveryCliTarget} from './nativeEmailRecoveryCliTransport'
import {verifyNativeEmailRecoveryCustodyProof} from './nativeEmailRecoveryCustodyProof'
import {requestNativeEmailRecoveryCustody} from './nativeEmailRecoveryCustodySocket'
import {nativeEmailPostgresStoreFingerprint,nativeEmailRecoveryStoreBindingFingerprint} from './nativeEmailRecoveryStoreBinding'
import {createNativeEmailRecoveryPrivatePostgres,type NativeEmailRecoveryPrivatePostgresTarget} from './nativeEmailRecoveryPrivatePostgres'
import {nativeEmailCanonicalJson,nativeEmailDigest,requireNativeEmail} from './nativeEmailPublication'

export type NativeEmailAccountRepairAction='repair-preview'|'repair'|'repair-inspect'
export function isNativeEmailAccountRepairAction(value:unknown):value is NativeEmailAccountRepairAction {
  return value==='repair-preview'||value==='repair'||value==='repair-inspect'
}
const PURPOSE='clawpilot-private-native-email-account-repair'
const JOURNAL='clawpilot-private-native-email-account-repair-journal-v1'
const HASH=/^[a-f0-9]{64}(?![\s\S])/u
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const KEY=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u
const NAME=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}(?![\s\S])/u
const INTEGER=/^[1-9][0-9]{0,19}(?![\s\S])/u
const matches=(value:unknown,pattern:RegExp):value is string=>typeof value==='string'&&pattern.test(value)
const absolute=(value:unknown):value is string=>typeof value==='string'&&value.length<=4096&&isAbsolute(value)&&!/\p{Cc}/u.test(value)
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const now=()=>Math.floor(Date.now()/1000)
function need(value:unknown,code:string):asserts value {
  requireNativeEmail(value,'private_native_email_account_repair_'+code)
}
function exact(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown> {
  need(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype
    &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{
      const field=Object.getOwnPropertyDescriptor(value,key)
      return field?.enumerable&&'value' in field
    }),'shape')
}
function trustAnchor(pin:Record<string,unknown>) {
  need(matches(pin.keyId,KEY)&&typeof pin.publicKey==='string'&&pin.publicKey.length<=4096,'trust_anchor')
  const key=createPublicKey(pin.publicKey)
  need(key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails?.modulusLength===3072,'trust_anchor')
  return Object.freeze({keyId:pin.keyId,key})
}
const password=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=1024&&!value.includes('\0')
const validInt=(value:unknown,max:bigint):value is string=>matches(value,INTEGER)&&BigInt(value)<=max

export function nativeEmailAccountRepairTargetFingerprint(native:NativeEmailRecoveryCliTarget,
  database:Omit<NativeEmailRecoveryPrivatePostgresTarget,'user'>&{tlsCaSha256:string}) {
  return nativeEmailDigest({version:1,purpose:'clawpilot-native-email-account-repair-destination-v1',
    native:nativeEmailRecoveryCliTargetFingerprint(native),database})
}

/** The independent custodian can derive these stable challenge pins from the
 * reviewed target without a password, journal, approval file or DB session. */
export function nativeEmailAccountRepairCustodySelection(input:{
  target:unknown;operationId:string;reviewDigest:string;approvalDigest:string;targetFingerprint:string
}) {
  const {operationId,reviewDigest,approvalDigest,targetFingerprint}=input
  need(matches(operationId,UUID)&&[reviewDigest,approvalDigest,targetFingerprint].every(value=>matches(value,HASH)),'custody_selection')
  const target=parseLegacyEmailAccountRepairTarget(input.target)
  return Object.freeze({
    operationId:nativeEmailDigest({version:1,purpose:'clawpilot-native-email-account-repair-custody-operation-v1',operationId}),
    requestFingerprint:nativeEmailDigest({version:1,purpose:'clawpilot-native-email-account-repair-custody-request-v1',
      action:'repair',target,reviewDigest,approvalDigest,targetFingerprint}),
  })
}

/** Only reached from the unprivileged operator with hash-pinned canonical
 * config and protected file readers. This mode cannot dispatch to SuiteCRM.
 * Preview and inspection use dedicated read-side logins; the only mutating
 * action requires separate direct roles and an independently retained pause. */
export async function runNativeEmailAccountRepairPrivateOperator(input:{
  action:NativeEmailAccountRepairAction
  configHash:string
  explicitOperation:string|undefined
  readConfig():unknown
  readSecrets():unknown
  readApproval():unknown
  readJournal(path:string):unknown
}) {
  const {action,configHash,explicitOperation}=input
  need(isNativeEmailAccountRepairAction(action)&&matches(configHash,HASH),'action')
  const config=input.readConfig()
  const base=['version','purpose','action','native','postgres']
  const pins=['operationId','reviewDigest','approvalDigest','journal']
  exact(config,[...base,...(action==='repair-preview'?['target']:action==='repair-inspect'?pins:
    [...pins,'target','attestorUser','release','custody'])])
  need(config.version===1&&config.purpose===PURPOSE&&config.action===action,'config_scope')
  const postgres=config.postgres
  exact(postgres,['host','port','database','user','systemIdentifier','databaseOid','tlsCaSha256'])
  const {host,port,database,user,systemIdentifier,databaseOid,tlsCaSha256}=postgres
  need(typeof host==='string'&&host.length<=253&&/^[A-Za-z0-9.:_-]+$/u.test(host)
    &&typeof port==='number'&&Number.isSafeInteger(port)&&port>=1&&port<=65535&&matches(database,NAME)
    &&matches(user,NAME)&&validInt(systemIdentifier,BigInt('18446744073709551615'))&&validInt(databaseOid,BigInt('4294967295'))
    &&matches(tlsCaSha256,HASH),'postgres_target')
  const cluster=Object.freeze({host,port,database,systemIdentifier,databaseOid})
  const native=config.native as NativeEmailRecoveryCliTarget
  const targetFingerprint=nativeEmailAccountRepairTargetFingerprint(native,{...cluster,tlsCaSha256})
  const storeBindingFingerprint=nativeEmailRecoveryStoreBindingFingerprint({
    targetFingerprint,mariaStoreFingerprint:native.mariaStoreFingerprint,
    postgresStoreFingerprint:nativeEmailPostgresStoreFingerprint({database,databaseOid,systemIdentifier}),
  })
  const secrets=input.readSecrets()
  exact(secrets,['postgresPassword','postgresTlsCa',...(action==='repair'?['attestorPassword']:[])])
  const {postgresPassword,postgresTlsCa,attestorPassword}=secrets
  need(password(postgresPassword)&&typeof postgresTlsCa==='string'&&postgresTlsCa.length<=32768
    &&postgresTlsCa.startsWith('-----BEGIN CERTIFICATE-----')&&!postgresTlsCa.includes('\0')
    &&sha(Buffer.from(postgresTlsCa,'utf8'))===tlsCaSha256,'credentials')
  // Never keep even one repair role's idle session while observing the
  // retained fence or opening the other role. Unknown commits stay unknown.
  const transactionFor=(login:string,secret:string):typeof withTransaction=>async run=>{
    const db=createNativeEmailRecoveryPrivatePostgres({target:{...cluster,user:login},password:secret,tlsCa:postgresTlsCa})
    try{return await db.transaction(run)}finally{await db.close()}
  }
  const controller=transactionFor(user,postgresPassword)
  if(action==='repair-preview'){
    need(explicitOperation===undefined,'unexpected_approval')
    const target=parseLegacyEmailAccountRepairTarget(config.target)
    return {action,targetFingerprint,result:await previewExactLegacyEmailAccountRepairPrivately(controller,target)}
  }
  const {operationId,reviewDigest,approvalDigest,journal}=config
  need(matches(operationId,UUID)&&matches(reviewDigest,HASH)&&matches(approvalDigest,HASH)&&absolute(journal),'journal_pins')
  const basePins=Object.freeze({version:1 as const,purpose:JOURNAL,operationId,reviewDigest,approvalDigest,targetFingerprint})
  const readPins=()=>{
    const retained=parseNativeEmailAccountRepairJournal(input.readJournal(journal))
    need(Object.entries(basePins).every(([key,value])=>retained[key as keyof typeof retained]===value),'journal_changed')
    return retained
  }
  if(action==='repair-inspect'){
    need(explicitOperation===undefined,'unexpected_approval')
    // A fresh receipt-only login can resolve an unknown commit even after
    // the original approval expired or the custodian closed its window.
    const retained=readPins()
    return {action,operationId,targetFingerprint,result:await inspectExactLegacyEmailAccountRepairPrivately(controller,{
      operationId:retained.operationId,approvalDigest:retained.approvalDigest,reviewDigest:retained.reviewDigest,
    })}
  }
  need(explicitOperation===operationId,'explicit_operation')
  const {attestorUser,release,custody}=config
  need(matches(attestorUser,NAME)&&attestorUser!==user&&password(attestorPassword)&&attestorPassword!==postgresPassword,'role_separation')
  exact(release,['keyId','publicKey'])
  exact(custody,['keyId','publicKey','socketPath','uid','fenceEpoch','expiresAt','producerInventoryHash'])
  const operatorAnchor=trustAnchor(release),custodyAnchor=trustAnchor(custody)
  need(operatorAnchor.keyId!==custodyAnchor.keyId
    &&sha(operatorAnchor.key.export({format:'der',type:'spki'}))!==sha(custodyAnchor.key.export({format:'der',type:'spki'})),
  'independent_anchors')
  const {socketPath,uid,fenceEpoch,expiresAt,producerInventoryHash}=custody
  need(absolute(socketPath)&&typeof uid==='number'&&Number.isSafeInteger(uid)&&uid>=0&&uid!==process.geteuid?.()
    &&matches(fenceEpoch,UUID)&&matches(producerInventoryHash,HASH)
    &&typeof expiresAt==='number'&&Number.isSafeInteger(expiresAt)&&expiresAt>now()+8&&expiresAt-now()<=900,'custody_window')
  const target=parseLegacyEmailAccountRepairTarget(config.target)
  const expected=Object.freeze({operationId,reviewDigest,fenceEpoch,targetFingerprint})
  const envelope=input.readApproval()
  const approval=verifyLegacyEmailAccountRepairApproval({envelope,expected,operatorAnchor,nowSeconds:now()})
  need(approval.approvalDigest===approvalDigest&&approval.expiresAt<=expiresAt,'approval_pins')
  const retained=Object.freeze({...basePins,fenceEpoch})
  const custodySelection=nativeEmailAccountRepairCustodySelection({target,operationId,reviewDigest,approvalDigest,targetFingerprint})
  const observations:string[]=[]
  const observe=async(phase:'before'|'after')=>{
    need(now()+(phase==='before'?8:0)<expiresAt,'custody_expired')
    const challenge=Object.freeze({nonce:randomBytes(32).toString('hex'),phase,...custodySelection,
      targetFingerprint,fenceEpoch,expiresAt,controllerConfigHash:configHash,producerInventoryHash,storeBindingFingerprint})
    const reply=await requestNativeEmailRecoveryCustody({socketPath,custodianUid:uid,
      challenge:Object.freeze({version:2,purpose:'clawpilot-native-email-recovery-custody-challenge-v2',...challenge})})
    verifyNativeEmailRecoveryCustodyProof({envelope:reply,expected:challenge,anchor:custodyAnchor,nowSeconds:now()})
    observations.push(nativeEmailDigest(reply))
  }
  const sameJournal=()=>need(nativeEmailCanonicalJson(readPins())===nativeEmailCanonicalJson(retained),'journal_changed')
  let fenced=false
  const result=await repairExactLegacyEmailAccountsPrivately({target,authorization:{envelope,expected,operatorAnchor}},{
    expectedRoles:{attestor:attestorUser,repair:user},
    attestTransaction:transactionFor(attestorUser,attestorPassword),
    repairTransaction:async run=>{
      need(fenced,'custody_scope');sameJournal()
      // Fresh proof after attestation commits and closes, before the writer
      // connects. Recheck expiry before starting a new database transaction.
      await observe('before');sameJournal()
      need(now()<approval.expiresAt,'approval_expired')
      return controller(run)
    },
    withLiveFence:async(scope,run)=>{
      need(!fenced&&nativeEmailCanonicalJson(scope)===nativeEmailCanonicalJson(expected),'custody_scope')
      await observe('before')
      // Journal before either role can commit. A later failure (including
      // attestor COMMIT) is inspect-only; never reuse or remove this file.
      reserveNativeEmailAccountRepairJournal(journal,retained);sameJournal()
      fenced=true
      try{return await run()}finally{fenced=false;await observe('after')}
    },
    retainResolutionPins:async value=>{
      need(fenced&&value.operationId===operationId&&value.reviewDigest===reviewDigest&&value.approvalDigest===approvalDigest,'journal_changed')
      sameJournal()
    },
  })
  return {action,operationId,targetFingerprint,fenceEpoch,successfulObservations:observations.length,
    observationsDigest:nativeEmailDigest(observations),result}
}
