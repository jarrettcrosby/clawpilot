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
import {verifyLegacyHeldEmailRecoveryApproval} from '../lib/crm/legacyHeldEmailRecoveryApproval'
import {attestHeldOriginalRecoveryApproval,inspectHeldOriginalRecovery,previewHeldOriginalRecovery,
  stageHeldOriginalRecovery} from '../lib/persistence/crmHeldOriginalRecoveryStage'
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
type PublishConfig=CommonConfig&{leaseOwner:string;railway:{binary:string;binarySha256:string;identityFile:string};dispatch:Pin}&(
  {purpose:'clawpilot-private-native-email-recovery'}|{purpose:'clawpilot-private-held-original-email-recovery';stageReceiptHash:string;receiptAttestorUser:string})
type StageConfig=CommonConfig&{purpose:'clawpilot-private-native-email-staging';target:ReturnType<typeof parseNativeEmailRecoveryStageTarget>;intentHash:string|null}
type HeldStageTarget={holdId:string;outboxId:string;holdReceiptHash:string;lockToken:string}
type HeldStageConfig=CommonConfig&{purpose:'clawpilot-private-held-original-email-staging';target:HeldStageTarget;
  intentHash:string|null;approvalHash:string|null;receiptAttestorUser:string}
type Config=PublishConfig|StageConfig|HeldStageConfig
type DatabaseSecrets={postgresPassword:string;postgresTlsCa:string}
type PublishSecrets=DatabaseSecrets&{dispatchPrivateKey:string;transportAttestationKey:string;receiptAttestorPassword?:string}
type StageAction='stage-preview'|'stage'|'stage-inspect'
type HeldStageAction='held-stage-preview'|'held-stage'|'held-stage-inspect'|'held-stage-attest'
type RecoveryAction='publish'|'resolve'|'inspect'|StageAction|HeldStageAction
type Action=RecoveryAction|NativeEmailAccountRepairAction|NativeEmailArchiveAction
const isStage=(action:RecoveryAction):action is StageAction=>action==='stage-preview'||action==='stage'||action==='stage-inspect'
const isHeldStage=(action:RecoveryAction):action is HeldStageAction=>action==='held-stage-preview'||action==='held-stage'
  ||action==='held-stage-inspect'||action==='held-stage-attest'
const isHeldStageWrite=(action:RecoveryAction)=>action==='held-stage'||action==='held-stage-attest'
const HASH=/^[a-f0-9]{64}(?![\s\S])/u,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const KEY_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u
const DB_ROLE=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}(?![\s\S])/u
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
    ||action==='held-stage-preview'||action==='held-stage'||action==='held-stage-inspect'||action==='held-stage-attest'
    ||isNativeEmailAccountRepairAction(action)||isNativeEmailArchiveAction(action),'action')
  need(absolute(value.config)&&absolute(value.secrets)&&matches(value['config-sha256'],HASH),'config_pin')
  if(action==='inspect'||action==='stage-preview'||action==='stage-inspect'||action==='repair-preview'||action==='repair-inspect'||action==='archive-inspect')
    need(value['approve-operation']===undefined,'unexpected_approval')
  else if(action==='held-stage-preview'||action==='held-stage-inspect')need(value['approve-operation']===undefined,'unexpected_approval')
  else need(matches(value['approve-operation'],action==='repair'||action==='archive'?UUID:HASH),'explicit_operation_approval')
  if(action==='publish'||action==='stage'||action==='held-stage'||action==='held-stage-attest'||action==='repair'||action==='archive')
    need(absolute(value.approval)&&matches(value['approval-sha256'],HASH),'release_approval_pin')
  else need(value.approval===undefined&&value['approval-sha256']===undefined,'unexpected_approval')
  return {...value,action,config:value.config,secrets:value.secrets}
}
function heldStagePreviewPins(target:HeldStageTarget){
  return {nativeOperationId:nativeEmailDigest({version:1,purpose:'clawpilot-held-original-stage-preview-operation-v1',target}),
    requestFingerprint:nativeEmailDigest({version:1,purpose:'clawpilot-held-original-stage-preview-request-v1',target})}
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
  const heldStaging=isHeldStage(action),staging=isStage(action)||heldStaging
  const held=!staging&&value!==null&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'purpose')?.value==='clawpilot-private-held-original-email-recovery'
  exact(value,['version','purpose','selection','native','postgres','release','custody',
    ...(staging?['target','intentHash']:['leaseOwner','railway','dispatch']),...(held?['stageReceiptHash','receiptAttestorUser']:[]),
    ...(heldStaging?['approvalHash','receiptAttestorUser']:[])])
  need(value.version===1&&value.purpose===(heldStaging?'clawpilot-private-held-original-email-staging':staging?'clawpilot-private-native-email-staging':held?
    'clawpilot-private-held-original-email-recovery':'clawpilot-private-native-email-recovery'),'config_scope')
  exact(value.selection,['holdId','outboxId','nativeOperationId','requestFingerprint'])
  need(matches(value.selection.holdId,UUID)&&matches(value.selection.outboxId,UUID)&&matches(value.selection.nativeOperationId,HASH)
    &&matches(value.selection.requestFingerprint,HASH),'selection')
  exact(value.postgres,['host','port','database','user','systemIdentifier','databaseOid','tlsCaSha256'])
  need(matches(value.postgres.tlsCaSha256,HASH),'database_ca_pin')
  if(held||heldStaging)need(matches(value.receiptAttestorUser,DB_ROLE)
    &&value.receiptAttestorUser!==value.postgres.user,'receipt_attestor_scope')
  if(held)need(matches(value.stageReceiptHash,HASH),'stage_receipt_pin')
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
  if(heldStaging){
    exact(value.target,['holdId','outboxId','holdReceiptHash','lockToken'])
    const {holdId,outboxId,holdReceiptHash,lockToken}=value.target
    need(holdId===value.selection.holdId&&outboxId===value.selection.outboxId&&matches(holdReceiptHash,HASH)&&matches(lockToken,UUID),
      'held_stage_scope')
    const target=Object.freeze({holdId,outboxId,holdReceiptHash,lockToken}) as HeldStageTarget
    const pins=heldStagePreviewPins(target)
    if(action==='held-stage-preview')need(value.intentHash===null&&value.approvalHash===null&&pins.nativeOperationId===value.selection.nativeOperationId
      &&pins.requestFingerprint===value.selection.requestFingerprint,'held_stage_preview_selection')
    else need(matches(value.intentHash,HASH)&&matches(value.approvalHash,HASH)&&pins.nativeOperationId!==value.selection.nativeOperationId
      &&pins.requestFingerprint!==value.selection.requestFingerprint,'held_stage_intent')
    return {...value,target} as unknown as HeldStageConfig
  }
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
function secretsValue(value:unknown,staging:boolean,held:boolean):DatabaseSecrets|PublishSecrets {
  exact(value,['postgresPassword','postgresTlsCa',...(staging?[]:['dispatchPrivateKey','transportAttestationKey']),...(held?['receiptAttestorPassword']:[])])
  need(typeof value.postgresPassword==='string'&&value.postgresPassword.length>0&&value.postgresPassword.length<=1024
    &&typeof value.postgresTlsCa==='string'&&value.postgresTlsCa.length<=32768,'secret_shape')
  if(!staging)need(typeof value.dispatchPrivateKey==='string'&&value.dispatchPrivateKey.length<=8192
    &&matches(value.transportAttestationKey,/^[A-Za-z0-9+/]{43}=(?![\s\S])/u),'secret_shape')
  if(held)need(typeof value.receiptAttestorPassword==='string'&&value.receiptAttestorPassword.length>0
    &&value.receiptAttestorPassword.length<=1024&&value.receiptAttestorPassword!==value.postgresPassword,'receipt_attestor_secret')
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
  if(opts.action==='publish'||opts.action==='resolve'||opts.action==='stage'||isHeldStageWrite(action))
    need(opts['approve-operation']===selection.nativeOperationId,'explicit_operation_approval')
  const trustedCustody=anchor(custody),trustedRelease=anchor(config.release)
  const held=config.purpose==='clawpilot-private-held-original-email-recovery'?config:undefined
  const heldStage=config.purpose==='clawpilot-private-held-original-email-staging'?config:undefined
  const trustedDispatch='dispatch' in config?anchor(config.dispatch):undefined
  const anchors=[trustedCustody,trustedRelease,...(trustedDispatch?[trustedDispatch]:[])]
  need(new Set(anchors.map(value=>keyFingerprint(value.key))).size===anchors.length
    &&new Set(anchors.map(value=>value.keyId)).size===anchors.length,'independent_anchors')
  const secrets=secretsValue(protectedJson(opts.secrets),isStage(action)||isHeldStage(action),!!held||isHeldStageWrite(action))
  const {tlsCaSha256,...databaseTarget}=config.postgres
  need(sha(Buffer.from(secrets.postgresTlsCa,'utf8'))===tlsCaSha256,'database_ca_pin')
  const initialApproval=!held&&(opts.action==='publish'||opts.action==='stage')?verifyLegacyEmailRecoveryReleaseApproval({
    envelope:protectedJson(opts.approval,opts['approval-sha256']),operatorAnchor:trustedRelease,nowSeconds:now()}):undefined
  if(initialApproval)need(Object.entries(selection).every(([k,v])=>initialApproval[k as keyof Selection]===v),'approval_selection')
  const heldApproval=((held&&opts.action==='publish')||(heldStage&&isHeldStageWrite(action)))?verifyLegacyHeldEmailRecoveryApproval({
    envelope:protectedJson(opts.approval,opts['approval-sha256']),operatorAnchor:trustedRelease,nowSeconds:now()}):undefined
  if(heldApproval)need(heldApproval.holdBatchId===selection.holdId&&heldApproval.outboxId===selection.outboxId
    &&heldApproval.nativeOperationId===selection.nativeOperationId&&heldApproval.requestFingerprint===selection.requestFingerprint
    &&heldApproval.nativeAuthorityInstanceId===config.native.nativeInstanceId,'approval_selection')
  if(heldStage&&heldApproval)need(heldApproval.intentHash===heldStage.intentHash
    &&heldApproval.holdReceiptHash===heldStage.target.holdReceiptHash&&heldApproval.lockToken===heldStage.target.lockToken
    &&(action!=='held-stage'||heldApproval.approvalHash===heldStage.approvalHash),'held_stage_approval_scope')
  if(config.purpose==='clawpilot-private-native-email-staging'&&initialApproval)need(initialApproval.intentHash===config.intentHash,'stage_intent')
  const dispatch='dispatch' in config&&trustedDispatch&&'dispatchPrivateKey' in secrets
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
  let receiptDb:ReturnType<typeof createNativeEmailRecoveryPrivatePostgres>|undefined
  const receiptAttestor=(user:string)=>{
    need('receiptAttestorPassword' in secrets&&secrets.receiptAttestorPassword,'receipt_attestor_secret')
    need(!receiptDb,'receipt_attestor_reused')
    receiptDb=createNativeEmailRecoveryPrivatePostgres({target:{...databaseTarget,user},password:secrets.receiptAttestorPassword,
      tlsCa:secrets.postgresTlsCa})
    return receiptDb.transaction
  }
  try {
    // No child command or private SQL before an independently attested window.
    await observe('before');retaining=true
    let result:unknown
    try {
      if(isHeldStage(action)){
        need(heldStage&&!dispatch,'held_stage_config')
        result=await withVerifiedFence(async()=>{
          if(action==='held-stage-preview'){
            const preview=await previewHeldOriginalRecovery(db.transaction,heldStage.target)
            need(preview.pins.nativeAuthorityInstanceId===heldStage.native.nativeInstanceId&&preview.pins.holdBatchId===selection.holdId
              &&preview.pins.outboxId===selection.outboxId&&preview.pins.holdReceiptHash===heldStage.target.holdReceiptHash
              &&preview.pins.lockToken===heldStage.target.lockToken,'held_stage_native_scope')
            return preview
          }
          need(heldStage.intentHash&&heldStage.approvalHash,'held_stage_intent')
          const stagePins={outboxId:selection.outboxId,intentHash:heldStage.intentHash,approvalHash:heldStage.approvalHash}
          if(action==='held-stage-inspect'){
            const staged=await inspectHeldOriginalRecovery(db.transaction,stagePins)
            need(staged.state==='unknown'||staged.holdBatchId===selection.holdId,'held_stage_receipt_scope')
            return staged
          }
          need(heldApproval,'held_stage_approval_scope')
          const attestorUser=heldStage.receiptAttestorUser
          if(action==='held-stage-attest'){
            const staged=await inspectHeldOriginalRecovery(db.transaction,stagePins)
            need(staged.state==='staged'&&staged.holdBatchId===selection.holdId,'held_stage_receipt_scope')
            return attestHeldOriginalRecoveryApproval({attestTransaction:receiptAttestor(attestorUser),attestorUser,approval:heldApproval})
          }
          return stageHeldOriginalRecovery({transaction:db.transaction,attestTransaction:receiptAttestor(attestorUser),attestorUser,
            target:heldStage.target,approval:heldApproval})
        })
      }else if(isStage(action)){
        need(config.purpose==='clawpilot-private-native-email-staging'&&!dispatch,'stage_config')
        result=await withVerifiedFence(()=>runNativeEmailRecoveryPrivateStage({action,target:config.target,selection,
          intentHash:config.intentHash??undefined,approval:initialApproval,transaction:db.transaction}))
      }else if(opts.action==='inspect'&&held)result=await db.transaction(async tx=>{
        const rows=(await tx.query('SELECT crm_legacy_email_terminal_hold.resolve_release($1::uuid,$2,$3,$4) AS value',
          [selection.outboxId,held.stageReceiptHash,selection.nativeOperationId,selection.requestFingerprint])).rows
        const state=rows[0]?.value?.state
        need(rows.length===1&&['staged','dispatched','committed','cancelled','unknown'].includes(state),'inspect_scope')
        return {state,hasReceipt:state==='committed'||state==='cancelled'}
      })
      else if(opts.action==='inspect')result=await db.transaction(async tx=>{
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
        need('dispatch' in config&&dispatch,'dispatch_config')
        const {signer,transport}=dispatch
        const persistenceOptions={selection,transaction:db.transaction,maintenanceDispatch:{signer,withVerifiedFence}}
        let persistence:ReturnType<typeof createPrivateLegacyEmailRecoveryPersistence>
        if(held){
          persistence=createPrivateLegacyEmailRecoveryPersistence({...persistenceOptions,heldOriginal:{stageReceiptHash:held.stageReceiptHash,
            nativeAuthorityInstanceId:held.native.nativeInstanceId,initialApproval:heldApproval,
            receiptAttestor:{user:held.receiptAttestorUser,transaction:receiptAttestor(held.receiptAttestorUser)}}})
        }else persistence=createPrivateLegacyEmailRecoveryPersistence({...persistenceOptions,initialApproval})
        const operator=createNativeEmailRecoveryMaintenanceOperator({persistence,owner:config.leaseOwner,
          exchange:transport.exchange,exchangePublish:transport.exchangePublish})
        const settled=await (opts.action==='publish'?operator.publish():operator.resolve())
        result={synchronized:settled.synchronized===true}
      }
    } finally {retaining=false;await observe('after')}
    return {action:opts.action,operationId:selection.nativeOperationId,fenceEpoch:fence.fenceEpoch,successfulObservations:observations.length,
      observationsDigest:nativeEmailDigest(observations),result}
  } finally {try {await receiptDb?.close()} finally {await db.close()}}
}

if(require.main===module)void runNativeEmailRecoveryPrivateOperator(process.argv.slice(2)).then(result=>{
  process.stdout.write(nativeEmailCanonicalJson(result)+'\n')
}).catch(error=>{
  const code=error instanceof NativeEmailPublicationHeld?error.code:'private_native_email_recovery_outcome_held'
  process.stderr.write(nativeEmailCanonicalJson({code,retryAutomatically:false,releaseWriterPause:false})+'\n');process.exitCode=1
})
