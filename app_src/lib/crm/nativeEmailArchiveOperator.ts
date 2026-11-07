import 'server-only'
import {createHash,createPublicKey,randomBytes} from 'node:crypto'
import {isAbsolute} from 'node:path'
import {archiveExactLegacyEmailsPrivately,resolveExactLegacyEmailArchivePrivately} from '../persistence/crmLegacyEmailRetirement'
import type {withTransaction} from '../persistence/postgres'
import {legacyEmailRetirementManifestDigest,verifyLegacyEmailRetirementApproval,type LegacyEmailRetirementManifest} from './legacyEmailRetirementApproval'
import {parseNativeEmailArchiveJournal,reserveNativeEmailArchiveJournal} from './nativeEmailArchiveJournal'
import {nativeEmailRecoveryCliTargetFingerprint,type NativeEmailRecoveryCliTarget} from './nativeEmailRecoveryCliTransport'
import {verifyNativeEmailRecoveryCustodyProof} from './nativeEmailRecoveryCustodyProof'
import {requestNativeEmailRecoveryCustody} from './nativeEmailRecoveryCustodySocket'
import {nativeEmailPostgresStoreFingerprint,nativeEmailRecoveryStoreBindingFingerprint} from './nativeEmailRecoveryStoreBinding'
import {createNativeEmailRecoveryPrivatePostgres,type NativeEmailRecoveryPrivatePostgresTarget} from './nativeEmailRecoveryPrivatePostgres'
import {nativeEmailCanonicalJson,nativeEmailDigest,requireNativeEmail} from './nativeEmailPublication'

export type NativeEmailArchiveAction='archive'|'archive-inspect'
export const isNativeEmailArchiveAction=(value:unknown):value is NativeEmailArchiveAction=>value==='archive'||value==='archive-inspect'
const PURPOSE='clawpilot-private-native-email-archive'
const JOURNAL='clawpilot-private-native-email-archive-journal-v1'
const HASH=/^[a-f0-9]{64}(?![\s\S])/u,COMMIT=/^[a-f0-9]{40}(?![\s\S])/u,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const KEY=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u,NAME=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}(?![\s\S])/u
const INTEGER=/^[1-9][0-9]{0,19}(?![\s\S])/u
const matches=(value:unknown,pattern:RegExp):value is string=>typeof value==='string'&&pattern.test(value)
const absolute=(value:unknown):value is string=>typeof value==='string'&&value.length<=4096&&isAbsolute(value)&&!/\p{Cc}/u.test(value)
const password=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=1024&&!value.includes('\0')
const bounded=(value:unknown,max:string):value is string=>matches(value,INTEGER)&&BigInt(value)<=BigInt(max)
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const now=()=>Math.floor(Date.now()/1000)
function need(value:unknown,code:string):asserts value {requireNativeEmail(value,'private_native_email_archive_'+code)}
function exact(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown> {
  need(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype
    &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{
      const field=Object.getOwnPropertyDescriptor(value,key)
      return field?.enumerable&&'value' in field
    }),'shape')
}
function trust(pin:Record<string,unknown>) {
  need(matches(pin.keyId,KEY)&&typeof pin.publicKey==='string'&&pin.publicKey.length<=4096,'anchor')
  const key=createPublicKey(pin.publicKey)
  need(key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails?.modulusLength===3072,'anchor')
  return Object.freeze({keyId:pin.keyId,key})
}

export function nativeEmailArchiveDestination(input:{
  native:NativeEmailRecoveryCliTarget
  postgres:Omit<NativeEmailRecoveryPrivatePostgresTarget,'user'>&{tlsCaSha256:string}
  appCommit:string;nativeCommit:string;nativeDatabaseFingerprint:string
}) {
  need(matches(input.appCommit,COMMIT)&&matches(input.nativeCommit,COMMIT)&&matches(input.nativeDatabaseFingerprint,HASH),'destination')
  const native=nativeEmailRecoveryCliTargetFingerprint(input.native)
  need(input.nativeDatabaseFingerprint===input.native.mariaStoreFingerprint,'native_store_destination')
  const postgresDatabaseFingerprint=nativeEmailDigest({version:1,purpose:'clawpilot-native-email-archive-postgres-v1',...input.postgres})
  const scope=Object.freeze({projectId:input.native.projectId,environmentId:input.native.environmentId,postgresDatabaseFingerprint,
    appCommit:input.appCommit,nativeDeploymentId:input.native.deploymentId,nativeReplicaId:input.native.replicaId,
    nativeCommit:input.nativeCommit,nativeDatabaseFingerprint:input.nativeDatabaseFingerprint})
  const targetFingerprint=nativeEmailDigest({version:1,purpose:'clawpilot-native-email-archive-destination-v1',scope,native})
  return Object.freeze({scope,targetFingerprint})
}

/** Hash-only input for independent custodian setup. The reviewed manifest and
 * its archive-only scope are already included by the exact manifest digest. */
export function nativeEmailArchiveCustodySelection(input:{
  operationId:string;manifestDigest:string;approvalDigest:string;targetFingerprint:string
}) {
  const {operationId,manifestDigest,approvalDigest,targetFingerprint}=input
  need(matches(operationId,UUID)&&[manifestDigest,approvalDigest,targetFingerprint].every(x=>matches(x,HASH)),'custody_selection')
  return Object.freeze({
    operationId:nativeEmailDigest({version:1,purpose:'clawpilot-native-email-archive-custody-operation-v1',operationId}),
    requestFingerprint:nativeEmailDigest({version:1,purpose:'clawpilot-native-email-archive-custody-request-v1',
      action:'archive',manifestDigest,approvalDigest,targetFingerprint}),
  })
}

/** Retires exact dead PostgreSQL jobs only. No native transport, provider
 * dispatch, credentials from the app, implicit row selection or replay. */
export async function runNativeEmailArchivePrivateOperator(input:{
  action:NativeEmailArchiveAction;configHash:string;explicitOperation:string|undefined
  readConfig():unknown;readSecrets():unknown;readApproval():unknown;readJournal(path:string):unknown
}) {
  const {action,configHash,explicitOperation}=input
  need(isNativeEmailArchiveAction(action)&&matches(configHash,HASH),'action')
  const config=input.readConfig()
  exact(config,['version','purpose','action','native','postgres','appCommit','nativeCommit','nativeDatabaseFingerprint',
    'operationId','manifestDigest','approvalDigest','journal',...(action==='archive'?['attestorUser','absence','operator','custody']:[])])
  need(config.version===1&&config.purpose===PURPOSE&&config.action===action,'config_scope')
  const {native,postgres,operationId,manifestDigest,approvalDigest,journal,appCommit,nativeCommit,nativeDatabaseFingerprint}=config
  need(matches(operationId,UUID)&&matches(manifestDigest,HASH)&&matches(approvalDigest,HASH)&&absolute(journal),'journal_pins')
  exact(postgres,['host','port','database','user','systemIdentifier','databaseOid','tlsCaSha256'])
  const {host,port,database,user,systemIdentifier,databaseOid,tlsCaSha256}=postgres
  need(typeof host==='string'&&host.length<=253&&/^[A-Za-z0-9.:_-]+$/u.test(host)
    &&typeof port==='number'&&Number.isSafeInteger(port)&&port>=1&&port<=65535&&matches(database,NAME)&&matches(user,NAME)
    &&bounded(systemIdentifier,'18446744073709551615')&&bounded(databaseOid,'4294967295')&&matches(tlsCaSha256,HASH)
    &&matches(appCommit,COMMIT)&&matches(nativeCommit,COMMIT)&&matches(nativeDatabaseFingerprint,HASH),'postgres_target')
  const cluster=Object.freeze({host,port,database,systemIdentifier,databaseOid})
  const destination=nativeEmailArchiveDestination({native:native as NativeEmailRecoveryCliTarget,postgres:{...cluster,tlsCaSha256},
    appCommit,nativeCommit,nativeDatabaseFingerprint})
  const {targetFingerprint}=destination
  const storeBindingFingerprint=nativeEmailRecoveryStoreBindingFingerprint({
    targetFingerprint,mariaStoreFingerprint:(native as NativeEmailRecoveryCliTarget).mariaStoreFingerprint,
    postgresStoreFingerprint:nativeEmailPostgresStoreFingerprint({database,databaseOid,systemIdentifier}),
  })
  const secrets=input.readSecrets()
  exact(secrets,['postgresPassword','postgresTlsCa',...(action==='archive'?['attestorPassword']:[])])
  const {postgresPassword,postgresTlsCa,attestorPassword}=secrets
  need(password(postgresPassword)&&typeof postgresTlsCa==='string'&&postgresTlsCa.length<=32768
    &&postgresTlsCa.startsWith('-----BEGIN CERTIFICATE-----')&&!postgresTlsCa.includes('\0')
    &&sha(Buffer.from(postgresTlsCa,'utf8'))===tlsCaSha256,'credentials')
  const transactionFor=(login:string,secret:string):typeof withTransaction=>async run=>{
    const db=createNativeEmailRecoveryPrivatePostgres({target:{...cluster,user:login},password:secret,tlsCa:postgresTlsCa})
    try{return await db.transaction(run)}finally{await db.close()}
  }
  const controller=transactionFor(user,postgresPassword)
  const basePins=Object.freeze({version:1 as const,purpose:JOURNAL,operationId,manifestDigest,approvalDigest,targetFingerprint})
  const readPins=()=>{
    const retained=parseNativeEmailArchiveJournal(input.readJournal(journal))
    need(Object.entries(basePins).every(([key,value])=>retained[key as keyof typeof retained]===value),'journal_changed')
    return retained
  }
  if(action==='archive-inspect'){
    need(explicitOperation===undefined,'unexpected_approval')
    const retained=readPins()
    const receipt=await resolveExactLegacyEmailArchivePrivately(controller,{
      operationId:retained.operationId,manifestDigest:retained.manifestDigest,approvalDigest:retained.approvalDigest,
    })
    return {action,operationId,targetFingerprint,result:receipt}
  }
  need(explicitOperation===operationId,'explicit_operation')
  const {attestorUser,absence,operator,custody}=config
  need(matches(attestorUser,NAME)&&attestorUser!==user&&password(attestorPassword)&&attestorPassword!==postgresPassword,'role_separation')
  exact(absence,['keyId','publicKey']);exact(operator,['keyId','publicKey'])
  exact(custody,['keyId','publicKey','socketPath','uid','fenceEpoch','expiresAt','producerInventoryHash'])
  const fenceAnchor=trust(absence),operatorAnchor=trust(operator),custodyAnchor=trust(custody)
  const anchors=[fenceAnchor,operatorAnchor,custodyAnchor]
  need(new Set(anchors.map(anchor=>anchor.keyId)).size===3
    &&new Set(anchors.map(anchor=>sha(anchor.key.export({format:'der',type:'spki'})))).size===3,'independent_anchors')
  const {socketPath,uid,fenceEpoch,expiresAt,producerInventoryHash}=custody
  need(absolute(socketPath)&&typeof uid==='number'&&Number.isSafeInteger(uid)&&uid>=0&&uid!==process.geteuid?.()
    &&matches(fenceEpoch,UUID)&&matches(producerInventoryHash,HASH)
    &&typeof expiresAt==='number'&&Number.isSafeInteger(expiresAt)&&expiresAt>now()+8&&expiresAt-now()<=900,'custody_window')
  const signed=input.readApproval()
  exact(signed,['manifest','fenceEnvelope','operatorEnvelope'])
  need(legacyEmailRetirementManifestDigest(signed.manifest)===manifestDigest,'manifest_digest')
  const expectedManifest=signed.manifest as LegacyEmailRetirementManifest
  need(expectedManifest.operationId===operationId&&expectedManifest.fenceEpoch===fenceEpoch
    &&nativeEmailCanonicalJson(expectedManifest.scope)===nativeEmailCanonicalJson(destination.scope),'manifest_destination')
  const review={expectedManifest,fenceEnvelope:signed.fenceEnvelope,operatorEnvelope:signed.operatorEnvelope,fenceAnchor,operatorAnchor}
  const approved=verifyLegacyEmailRetirementApproval({...review,nowSeconds:now()})
  need(approved.approvalEnvelopeDigest===approvalDigest&&approved.expiresAt<=expiresAt,'approval_pins')
  const retained=Object.freeze({...basePins,fenceEpoch})
  const selection=nativeEmailArchiveCustodySelection({operationId,manifestDigest,approvalDigest,targetFingerprint})
  const observations:string[]=[]
  const observe=async(phase:'before'|'after')=>{
    need(now()+(phase==='before'?8:0)<expiresAt,'custody_expired')
    const challenge=Object.freeze({nonce:randomBytes(32).toString('hex'),phase,...selection,
      targetFingerprint,fenceEpoch,expiresAt,controllerConfigHash:configHash,producerInventoryHash,storeBindingFingerprint})
    const reply=await requestNativeEmailRecoveryCustody({socketPath,custodianUid:uid,
      challenge:Object.freeze({version:2,purpose:'clawpilot-native-email-recovery-custody-challenge-v2',...challenge})})
    verifyNativeEmailRecoveryCustodyProof({envelope:reply,expected:challenge,anchor:custodyAnchor,nowSeconds:now()})
    observations.push(nativeEmailDigest(reply))
  }
  const sameJournal=()=>need(nativeEmailCanonicalJson(readPins())===nativeEmailCanonicalJson(retained),'journal_changed')
  let fenced=false
  const result=await archiveExactLegacyEmailsPrivately(review,{
    expectedRoles:{attestor:attestorUser,controller:user},
    attestTransaction:transactionFor(attestorUser,attestorPassword),
    retireTransaction:async run=>{
      need(fenced,'custody_scope');sameJournal()
      await observe('before');sameJournal()
      need(now()<approved.expiresAt,'approval_expired')
      return controller(run)
    },
    withLiveFence:async(manifest,run)=>{
      need(!fenced&&legacyEmailRetirementManifestDigest(manifest)===manifestDigest,'custody_scope')
      await observe('before')
      reserveNativeEmailArchiveJournal(journal,retained);sameJournal()
      fenced=true
      try{return await run()}finally{fenced=false;await observe('after')}
    },
    retainResolutionPins:async value=>{
      need(fenced&&value.operationId===operationId&&value.manifestDigest===manifestDigest&&value.approvalDigest===approvalDigest,'journal_changed')
      sameJournal()
    },
  })
  return {action,operationId,targetFingerprint,fenceEpoch,successfulObservations:observations.length,
    observationsDigest:nativeEmailDigest(observations),result}
}
