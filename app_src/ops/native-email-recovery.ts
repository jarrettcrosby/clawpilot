/** Private executable for one exact reviewed Email. It cannot archive, grant
 * privileges, enter/leave maintenance, or invoke an ordinary worker. */
import 'server-only'
import {createHash,createPrivateKey,createPublicKey,randomBytes,type KeyObject} from 'node:crypto'
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync} from 'node:fs'
import {dirname,isAbsolute} from 'node:path'
import {createPrivateLegacyEmailRecoveryPersistence} from '../lib/persistence/crmNativeEmailPublication'
import {createNativeEmailRecoveryMaintenanceOperator} from '../lib/crm/nativeEmailRecoveryMaintenanceOperator'
import {createNativeEmailRecoveryCliTransport,nativeEmailRecoveryCliTargetFingerprint,type NativeEmailRecoveryCliTarget} from '../lib/crm/nativeEmailRecoveryCliTransport'
import {createNativeEmailRecoveryDispatchSigner,type NativeEmailRecoveryWriterFence} from '../lib/crm/nativeEmailRecoveryDispatchPermit'
import {createNativeEmailRecoveryPrivatePostgres} from '../lib/crm/nativeEmailRecoveryPrivatePostgres'
import {requestNativeEmailRecoveryCustody} from '../lib/crm/nativeEmailRecoveryCustodySocket'
import {verifyNativeEmailRecoveryCustodyProof} from '../lib/crm/nativeEmailRecoveryCustodyProof'
import {nativeEmailPostgresStoreFingerprint,nativeEmailRecoveryStoreBindingFingerprint} from '../lib/crm/nativeEmailRecoveryStoreBinding'
import {verifyLegacyEmailRecoveryReleaseApproval} from '../lib/crm/legacyEmailRecoveryReleaseApproval'
import {nativeEmailRecoveryStagePreviewPins,parseNativeEmailRecoveryStageTarget,
  runNativeEmailRecoveryPrivateStage} from '../lib/crm/nativeEmailRecoveryPrivateStage'
import {isNativeEmailAccountRepairAction,runNativeEmailAccountRepairPrivateOperator,
  type NativeEmailAccountRepairAction} from '../lib/crm/nativeEmailAccountRepairOperator'
import {isNativeEmailArchiveAction,runNativeEmailArchivePrivateOperator,
  type NativeEmailArchiveAction} from '../lib/crm/nativeEmailArchiveOperator'
import {NativeEmailPublicationHeld,nativeEmailCanonicalJson,nativeEmailDigest,requireNativeEmail} from '../lib/crm/nativeEmailPublication'

type Row=Record<string,unknown>
type Pin={keyId:string;publicKey:string}
type Selection={holdId:string;outboxId:string;nativeOperationId:string;requestFingerprint:string}
type CommonConfig={version:1;selection:Selection;
  native:NativeEmailRecoveryCliTarget;postgres:{host:string;port:number;database:string;user:string;systemIdentifier:string;databaseOid:string;tlsCaSha256:string};
  release:Pin;
  custody:Pin&{socketPath:string;uid:number;fenceEpoch:string;expiresAt:number;producerInventoryHash:string}}
type PublishConfig=CommonConfig&{purpose:'clawpilot-private-native-email-recovery';leaseOwner:string;
  railway:{binary:string;binarySha256:string;identityFile:string};dispatch:Pin}
type StageConfig=CommonConfig&{purpose:'clawpilot-private-native-email-staging';target:ReturnType<typeof parseNativeEmailRecoveryStageTarget>;intentHash:string|null}
type Config=PublishConfig|StageConfig
type DatabaseSecrets={postgresPassword:string;postgresTlsCa:string}
type PublishSecrets=DatabaseSecrets&{dispatchPrivateKey:string;transportAttestationKey:string}
type StageAction='stage-preview'|'stage'|'stage-inspect'
type RecoveryAction='publish'|'resolve'|'inspect'|StageAction
type Action=RecoveryAction|NativeEmailAccountRepairAction|NativeEmailArchiveAction
const isStage=(action:RecoveryAction):action is StageAction=>action==='stage-preview'||action==='stage'||action==='stage-inspect'
const HASH=/^[a-f0-9]{64}(?![\s\S])/u,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const KEY_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex')
const now=()=>Math.floor(Date.now()/1000)
const matches=(value:unknown,pattern:RegExp):value is string=>typeof value==='string'&&pattern.test(value)
const absolute=(value:unknown):value is string=>typeof value==='string'&&value.length<=4096&&isAbsolute(value)&&!/\p{Cc}/u.test(value)
function need(value:unknown,code:string):asserts value{requireNativeEmail(value,'private_native_email_recovery_'+code)}
function exact(value:unknown,keys:readonly string[]):asserts value is Row {
  need(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,'shape')
  need(Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)),'shape')
}
function options(args:string[]):Record<string,string>&{action:Action;config:string;secrets:string}{
  const value:Record<string,string>={}
  for(const argument of args){const m=/^--(action|config|config-sha256|secrets|approve-operation|approval|approval-sha256)=(.{1,4096})(?![\s\S])/u.exec(argument)
    need(m&&!Object.hasOwn(value,m[1]),'argument');value[m[1]]=m[2]}
  const action=value.action
  need(action==='publish'||action==='resolve'||action==='inspect'||action==='stage-preview'||action==='stage'||action==='stage-inspect'
    ||isNativeEmailAccountRepairAction(action)||isNativeEmailArchiveAction(action),'action')
  need(absolute(value.config)&&absolute(value.secrets)&&matches(value['config-sha256'],HASH),'config_pin')
  if(action==='inspect'||action==='stage-preview'||action==='stage-inspect'||action==='repair-preview'||action==='repair-inspect'||action==='archive-inspect')
    need(value['approve-operation']===undefined,'unexpected_approval')
  else need(matches(value['approve-operation'],action==='repair'||action==='archive'?UUID:HASH),'explicit_operation_approval')
  if(action==='publish'||action==='stage'||action==='repair'||action==='archive')
    need(absolute(value.approval)&&matches(value['approval-sha256'],HASH),'release_approval_pin')
  else need(value.approval===undefined&&value['approval-sha256']===undefined,'unexpected_approval')
  return {...value,action,config:value.config,secrets:value.secrets}
}

function protectedJson(path:string,pin?:string):unknown {
  need(absolute(path)&&realpathSync(dirname(path))===dirname(path),'file_directory')
  const directory=lstatSync(dirname(path)),uid=process.geteuid?.()
  need(directory.isDirectory()&&directory.uid===uid&&(directory.mode&0o7777)===0o700,'file_directory')
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try {
    const before=fstatSync(fd),named=lstatSync(path)
    need(before.isFile()&&named.dev===before.dev&&named.ino===before.ino&&before.uid===uid&&before.nlink===1
      &&[0o400,0o600].includes(before.mode&0o7777)&&before.size>0&&before.size<=65536,'file_protection')
    const bytes=Buffer.alloc(before.size+1)
    try {
      let read=0,count=0
      while(read<bytes.length&&(count=readSync(fd,bytes,read,bytes.length-read,null))>0)read+=count
      const after=fstatSync(fd)
      const content=bytes.subarray(0,read)
      need(read===before.size&&before.size===after.size&&before.ctimeMs===after.ctimeMs
        &&before.mtimeMs===after.mtimeMs&&(!pin||sha(content)===pin),'file_changed')
      const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(content)
      const parsed:unknown=JSON.parse(raw)
      // Reject duplicate keys, ambiguous Unicode and encodings, and surprises
      // between approval digest, parser and custodial challenge.
      need(raw===nativeEmailCanonicalJson(parsed)+'\n','file_canonical')
      return parsed
    } finally {bytes.fill(0)}
  } finally {closeSync(fd)}
}
function configValue(value:unknown,action:RecoveryAction):Config {
  const staging=isStage(action)
  exact(value,['version','purpose','selection','native','postgres','release','custody',
    ...(staging?['target','intentHash']:['leaseOwner','railway','dispatch'])])
  need(value.version===1&&value.purpose===(staging?'clawpilot-private-native-email-staging':'clawpilot-private-native-email-recovery'),'config_scope')
  exact(value.selection,['holdId','outboxId','nativeOperationId','requestFingerprint'])
  need(matches(value.selection.holdId,UUID)&&matches(value.selection.outboxId,UUID)&&matches(value.selection.nativeOperationId,HASH)
    &&matches(value.selection.requestFingerprint,HASH),'selection')
  exact(value.postgres,['host','port','database','user','systemIdentifier','databaseOid','tlsCaSha256'])
  need(matches(value.postgres.tlsCaSha256,HASH),'database_ca_pin')
  if(!staging){
    need(matches(value.leaseOwner,UUID),'config_scope')
    exact(value.railway,['binary','binarySha256','identityFile'])
    need(absolute(value.railway.binary)&&absolute(value.railway.identityFile)&&matches(value.railway.binarySha256,HASH),'railway')
    exact(value.dispatch,['keyId','publicKey'])
  }
  exact(value.release,['keyId','publicKey'])
  exact(value.custody,['keyId','publicKey','socketPath','uid','fenceEpoch','expiresAt','producerInventoryHash'])
  for(const pin of [value.release,value.custody,...(!staging?[value.dispatch as Row]:[])]){
    need(matches(pin.keyId,KEY_ID)&&typeof pin.publicKey==='string'&&pin.publicKey.length<=4096,'trust_anchor')
  }
  const {custody}=value
  need(absolute(custody.socketPath)&&typeof custody.uid==='number'&&Number.isSafeInteger(custody.uid)&&custody.uid>=0
    &&custody.uid!==process.geteuid?.()&&matches(custody.fenceEpoch,UUID)&&matches(custody.producerInventoryHash,HASH)
    &&typeof custody.expiresAt==='number'&&Number.isSafeInteger(custody.expiresAt)&&custody.expiresAt>now()
    &&custody.expiresAt-now()<=900,'custody_window')
  if(staging){
    const target=parseNativeEmailRecoveryStageTarget(value.target)
    need(target.holdId===value.selection.holdId&&target.outboxId===value.selection.outboxId,'stage_selection')
    if(action==='stage-preview'){
      const pins=nativeEmailRecoveryStagePreviewPins(target)
      need(value.intentHash===null&&pins.nativeOperationId===value.selection.nativeOperationId
        &&pins.requestFingerprint===value.selection.requestFingerprint,'stage_preview_selection')
    }else need(matches(value.intentHash,HASH),'stage_intent')
    return {...value,target} as unknown as StageConfig
  }
  return value as unknown as PublishConfig
}
function secretsValue(value:unknown,staging:boolean):DatabaseSecrets|PublishSecrets {
  exact(value,['postgresPassword','postgresTlsCa',...(staging?[]:['dispatchPrivateKey','transportAttestationKey'])])
  need(typeof value.postgresPassword==='string'&&value.postgresPassword.length>0&&value.postgresPassword.length<=1024
    &&typeof value.postgresTlsCa==='string'&&value.postgresTlsCa.length<=32768,'secret_shape')
  if(!staging)need(typeof value.dispatchPrivateKey==='string'&&value.dispatchPrivateKey.length<=8192
    &&matches(value.transportAttestationKey,/^[A-Za-z0-9+/]{43}=(?![\s\S])/u),'secret_shape')
  return value as unknown as DatabaseSecrets|PublishSecrets
}
function anchor(pin:Pin){
  const key=createPublicKey(pin.publicKey)
  need(key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails?.modulusLength===3072,'trust_anchor')
  return {keyId:pin.keyId,key}
}
const keyFingerprint=(key:KeyObject)=>sha(key.export({format:'der',type:'spki'}))

function dispatchFor(config:PublishConfig,secrets:PublishSecrets,trustedDispatch:ReturnType<typeof anchor>){
  const dispatchKey=createPrivateKey(secrets.dispatchPrivateKey)
  need(keyFingerprint(createPublicKey(dispatchKey))===keyFingerprint(trustedDispatch.key),'dispatch_key_mismatch')
  const readyKey=Buffer.from(secrets.transportAttestationKey,'base64')
  try {
    need(readyKey.toString('base64')===secrets.transportAttestationKey,'attestation_key')
    const transport=createNativeEmailRecoveryCliTransport({target:config.native,railwayBinary:config.railway.binary,
      railwayBinarySha256:config.railway.binarySha256,railwayIdentityFile:config.railway.identityFile,transportAttestationKey:readyKey})
    const signer=createNativeEmailRecoveryDispatchSigner({keyId:trustedDispatch.keyId,key:dispatchKey,targetFingerprint:transport.targetFingerprint})
    return {transport,signer}
  } finally {readyKey.fill(0)}
}

export async function runNativeEmailRecoveryPrivateOperator(args:string[]) {
  const uid=process.geteuid?.()
  need(process.versions.node.split('.')[0]==='24'&&typeof uid==='number'&&uid>0,'runtime')
  need(!process.env.DATABASE_URL&&!process.env.DATABASE_PRIVATE_URL,'ordinary_database_configuration')
  const opts=options(args),configHash=opts['config-sha256']
  const action=opts.action
  const inputs={
    configHash,readConfig:()=>protectedJson(opts.config,configHash),
    readSecrets:()=>protectedJson(opts.secrets),readApproval:()=>protectedJson(opts.approval,opts['approval-sha256']),
    explicitOperation:opts['approve-operation'],readJournal:protectedJson,
  }
  if(isNativeEmailAccountRepairAction(action))return runNativeEmailAccountRepairPrivateOperator({action,...inputs})
  if(isNativeEmailArchiveAction(action))return runNativeEmailArchivePrivateOperator({action,...inputs})
  const config=configValue(protectedJson(opts.config,configHash),action)
  const {selection,custody}=config
  if(opts.action==='publish'||opts.action==='resolve'||opts.action==='stage')
    need(opts['approve-operation']===selection.nativeOperationId,'explicit_operation_approval')
  const trustedCustody=anchor(custody),trustedRelease=anchor(config.release)
  const trustedDispatch=config.purpose==='clawpilot-private-native-email-recovery'?anchor(config.dispatch):undefined
  const anchors=[trustedCustody,trustedRelease,...(trustedDispatch?[trustedDispatch]:[])]
  need(new Set(anchors.map(value=>keyFingerprint(value.key))).size===anchors.length
    &&new Set(anchors.map(value=>value.keyId)).size===anchors.length,'independent_anchors')
  const secrets=secretsValue(protectedJson(opts.secrets),isStage(action))
  const {tlsCaSha256,...databaseTarget}=config.postgres
  need(sha(Buffer.from(secrets.postgresTlsCa,'utf8'))===tlsCaSha256,'database_ca_pin')
  const initialApproval=opts.action==='publish'||opts.action==='stage'?verifyLegacyEmailRecoveryReleaseApproval({
    envelope:protectedJson(opts.approval,opts['approval-sha256']),operatorAnchor:trustedRelease,nowSeconds:now()}):undefined
  if(initialApproval)need(Object.entries(selection).every(([k,v])=>initialApproval[k as keyof Selection]===v),'approval_selection')
  if(config.purpose==='clawpilot-private-native-email-staging'&&initialApproval)need(initialApproval.intentHash===config.intentHash,'stage_intent')
  const dispatch=config.purpose==='clawpilot-private-native-email-recovery'&&trustedDispatch&&'dispatchPrivateKey' in secrets
    ?dispatchFor(config,secrets,trustedDispatch):undefined
  const targetFingerprint=dispatch?.transport.targetFingerprint??nativeEmailRecoveryCliTargetFingerprint(config.native)
  const storeBindingFingerprint=nativeEmailRecoveryStoreBindingFingerprint({
    targetFingerprint,mariaStoreFingerprint:config.native.mariaStoreFingerprint,
    postgresStoreFingerprint:nativeEmailPostgresStoreFingerprint({
      database:databaseTarget.database,databaseOid:databaseTarget.databaseOid,systemIdentifier:databaseTarget.systemIdentifier,
    }),
  })
  const fence=Object.freeze({fenceEpoch:custody.fenceEpoch,expiresAt:custody.expiresAt,targetFingerprint})
  let retaining=false,inside=false
  const observations:string[]=[]
  const observe=async(phase:'before'|'after')=>{
    need(now()+(phase==='before'?8:0)<fence.expiresAt,'custody_expired')
    const expected=Object.freeze({...fence,nonce:randomBytes(32).toString('hex'),phase,operationId:selection.nativeOperationId,
      requestFingerprint:selection.requestFingerprint,controllerConfigHash:configHash,producerInventoryHash:custody.producerInventoryHash,
      storeBindingFingerprint})
    const envelope=await requestNativeEmailRecoveryCustody({socketPath:custody.socketPath,custodianUid:custody.uid,
      challenge:Object.freeze({version:2,purpose:'clawpilot-native-email-recovery-custody-challenge-v2',...expected})})
    verifyNativeEmailRecoveryCustodyProof({envelope,expected,anchor:trustedCustody,nowSeconds:now()})
    observations.push(nativeEmailDigest(envelope))
  }
  const withVerifiedFence=async<T>(run:(verified:NativeEmailRecoveryWriterFence)=>Promise<T>)=>{
    need(retaining&&!inside,'custody_scope');inside=true
    try {
      await observe('before')
      try {return await run(fence)} finally {await observe('after')}
    } finally {inside=false}
  }
  const db=createNativeEmailRecoveryPrivatePostgres({target:databaseTarget,password:secrets.postgresPassword,tlsCa:secrets.postgresTlsCa})
  try {
    // No child command or private SQL before an independently attested window.
    await observe('before');retaining=true
    let result:unknown
    try {
      if(isStage(action)){
        need(config.purpose==='clawpilot-private-native-email-staging'&&!dispatch,'stage_config')
        result=await withVerifiedFence(()=>runNativeEmailRecoveryPrivateStage({action,target:config.target,selection,
          intentHash:config.intentHash??undefined,approval:initialApproval,transaction:db.transaction}))
      }else if(opts.action==='inspect')result=await db.transaction(async tx=>{
        const status=await tx.query(`SELECT c.enabled,c.active_operation_id,c.active_transition_id,c.active_initial_enrollment_id,
          a.state,r.native_operation_id AS released_operation_id,
          r.request_fingerprint AS release_fingerprint,a.request_fingerprint AS admission_fingerprint,
          a.native_receipt IS NOT NULL AS has_receipt
          FROM public.crm_native_email_publication_control c
          JOIN public.crm_legacy_email_recovery_holds h ON h.operation_id=$1 AND h.outbox_id=$2
          LEFT JOIN public.crm_legacy_email_recovery_releases r ON r.hold_id=h.operation_id AND r.outbox_id=h.outbox_id
          LEFT JOIN public.crm_native_email_publication_admissions a ON a.operation_id=$3
          WHERE c.singleton`,[selection.holdId,selection.outboxId,selection.nativeOperationId])
        const row=status.rows[0]
        need(status.rows.length===1&&row.enabled===true&&row.active_transition_id===null&&row.active_initial_enrollment_id===null
          &&(row.active_operation_id===null||row.active_operation_id===selection.nativeOperationId),'inspect_scope')
        const terminal=row.state==='committed'||row.state==='cancelled'
        const active=row.state==='admitted'||row.state==='dispatched'||row.state==='unknown'
        need(row.state===null?row.released_operation_id===null&&row.release_fingerprint===null
          &&row.admission_fingerprint===null&&row.active_operation_id===null
          :(terminal||active)&&row.released_operation_id===selection.nativeOperationId
            &&row.release_fingerprint===selection.requestFingerprint&&row.admission_fingerprint===selection.requestFingerprint
            &&row.active_operation_id===(terminal?null:selection.nativeOperationId)&&row.has_receipt===terminal,'inspect_scope')
        return {state:row.state??'not_admitted',hasReceipt:terminal}
      })
      else {
        need(config.purpose==='clawpilot-private-native-email-recovery'&&dispatch,'dispatch_config')
        const {signer,transport}=dispatch
        const persistence=createPrivateLegacyEmailRecoveryPersistence({selection,initialApproval,transaction:db.transaction,
          maintenanceDispatch:{signer,withVerifiedFence}})
        const operator=createNativeEmailRecoveryMaintenanceOperator({persistence,owner:config.leaseOwner,
          exchange:transport.exchange,exchangePublish:transport.exchangePublish})
        const settled=await (opts.action==='publish'?operator.publish():operator.resolve())
        result={synchronized:settled.synchronized===true}
      }
    } finally {retaining=false;await observe('after')}
    return {action:opts.action,operationId:selection.nativeOperationId,fenceEpoch:fence.fenceEpoch,successfulObservations:observations.length,
      observationsDigest:nativeEmailDigest(observations),result}
  } finally {await db.close()}
}

if(require.main===module)void runNativeEmailRecoveryPrivateOperator(process.argv.slice(2)).then(result=>{
  process.stdout.write(nativeEmailCanonicalJson(result)+'\n')
}).catch(error=>{
  const code=error instanceof NativeEmailPublicationHeld?error.code:'private_native_email_recovery_outcome_held'
  process.stderr.write(nativeEmailCanonicalJson({code,retryAutomatically:false,releaseWriterPause:false})+'\n');process.exitCode=1
})
