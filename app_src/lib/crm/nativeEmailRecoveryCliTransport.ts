import 'server-only'
import {createHash} from 'node:crypto'
import {lstatSync,readFileSync} from 'node:fs'
import {isAbsolute} from 'node:path'
import {nativeEmailCanonicalJson, nativeEmailDigest, prepareNativeEmailPublication, requireNativeEmail,
  type NativeEmailPublicationRequest} from './nativeEmailPublication'
import {createNativeEmailRecoveryDuplexCommandRunner, type NativeEmailRecoveryDuplexCommandRunner} from './nativeEmailRecoveryDuplexRunner'
import {createNativeEmailRecoveryReadyChallenge} from './nativeEmailRecoveryReadyProof'
import type {NativeEmailRecoveryDispatchPermit,NativeEmailRecoveryWriterFence} from './nativeEmailRecoveryDispatchPermit'

export type NativeEmailRecoveryCliTarget = Readonly<{
  projectId:string;environmentId:string;serviceId:string;deploymentId:string;deploymentInstanceId:string;replicaId:string;nativeInstanceId:string;
  database:string;databasePrincipal:string;mariaStoreFingerprint:string;serviceUserId:string;oauthClientId:string;cliSourceHash:string;imagePackageHash:string;
}>
type Options = {target:NativeEmailRecoveryCliTarget;railwayBinary:string;railwayBinarySha256:string;
  railwayIdentityFile:string;transportAttestationKey:Buffer}
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const ID=/^[A-Za-z0-9][A-Za-z0-9-]{0,35}(?![\s\S])/u
const HASH=/^[0-9a-f]{64}(?![\s\S])/u
const CLI='/opt/clawpilot/native-email-recovery-cli.php'
const targetKeys=['projectId','environmentId','serviceId','deploymentId','deploymentInstanceId','replicaId','nativeInstanceId',
  'database','databasePrincipal','mariaStoreFingerprint','serviceUserId','oauthClientId','cliSourceHash','imagePackageHash'] as const
const matches=(v:unknown,re:RegExp):v is string=>typeof v==='string'&&re.test(v)
function need(v:unknown,code:string):asserts v{requireNativeEmail(v,'legacy_dispatch_transport_'+code)}
type Action='prepare'|'publish'|'resolve'
type Packet=Readonly<{request:NativeEmailPublicationRequest;permit:NativeEmailRecoveryDispatchPermit}>
export type NativeEmailRecoveryDeferredPublish=Readonly<{request:NativeEmailPublicationRequest;fence:NativeEmailRecoveryWriterFence;
  authorize:()=>Promise<NativeEmailRecoveryDispatchPermit>}>

function checkedTarget(input:NativeEmailRecoveryCliTarget):NativeEmailRecoveryCliTarget {
  need(input&&Reflect.ownKeys(input).length===targetKeys.length&&targetKeys.every(k=>{
    const d=Object.getOwnPropertyDescriptor(input,k);return d?.enumerable&&'value' in d
  }),'target_shape')
  const t=Object.freeze({...input})
  need([t.projectId,t.environmentId,t.serviceId,t.deploymentId,t.deploymentInstanceId,t.replicaId].every(x=>matches(x,UUID))
    &&[t.nativeInstanceId,t.serviceUserId,t.oauthClientId].every(x=>matches(x,ID))
    &&matches(t.database,/^[A-Za-z0-9_]{1,64}(?![\s\S])/u)
    &&matches(t.databasePrincipal,/^[A-Za-z0-9_]{1,64}@[A-Za-z0-9_.:%-]{1,255}(?![\s\S])/u)
    &&[t.mariaStoreFingerprint,t.cliSourceHash,t.imagePackageHash].every(value=>matches(value,HASH)),'target_invalid')
  return t
}
export function nativeEmailRecoveryCliTargetFingerprint(target:NativeEmailRecoveryCliTarget) {
  return nativeEmailDigest(checkedTarget(target))
}

/** Narrow SSH command. No email bytes are written until this same child
 * attests the exact target and fence. Never forwards database credentials,
 * signing key or attestation key. The explicit pre-registered identity
 * avoids interactive key registration. Neither opens a window nor retries. */
export function createNativeEmailRecoveryCliTransport(options:Options,
  run:NativeEmailRecoveryDuplexCommandRunner=createNativeEmailRecoveryDuplexCommandRunner()) {
  const {railwayBinary,railwayBinarySha256,railwayIdentityFile,transportAttestationKey}=options, t=checkedTarget(options.target)
  need(typeof railwayBinary==='string'&&isAbsolute(railwayBinary)&&matches(railwayBinarySha256,HASH)
    &&typeof railwayIdentityFile==='string'&&isAbsolute(railwayIdentityFile)&&!railwayIdentityFile.includes('\0')
    &&typeof run==='function','binary_config')
  need(Buffer.isBuffer(transportAttestationKey)&&transportAttestationKey.length===32,'ready_key')
  const attestationKey=Buffer.from(transportAttestationKey)
  const targetFingerprint=nativeEmailRecoveryCliTargetFingerprint(t)
  const checkedRequest=(request:NativeEmailPublicationRequest)=>{
    const {command,nativePolicyFingerprint,allowedReaderSuiteCrmUserIds}=request
    const verified=prepareNativeEmailPublication({command,nativePolicyFingerprint,allowedReaderSuiteCrmUserIds})
    need(verified.command.version===2&&verified.command.mode==='publish'&&verified.command.expectedRecordFingerprint===null
      &&verified.commandHash===request.commandHash&&verified.requestFingerprint===request.requestFingerprint,'packet_scope')
    return verified
  }
  const encode=(verified:NativeEmailPublicationRequest,permit:NativeEmailRecoveryDispatchPermit,action:Action,
    fence?:NativeEmailRecoveryWriterFence)=>{
    need(permit?.proof?.action===action&&verified.command.operationId===permit.proof.operationId
      &&verified.commandHash===permit.proof.commandHash&&verified.requestFingerprint===permit.proof.requestFingerprint
      &&targetFingerprint===permit.proof.targetFingerprint&&(!fence||permit.proof.fenceEpoch===fence.fenceEpoch
        &&Number.isSafeInteger(permit.proof.expiresAt)&&permit.proof.expiresAt<=fence.expiresAt),'packet_scope')
    const stdin=nativeEmailCanonicalJson({command:verified.command,nativePolicyFingerprint:verified.nativePolicyFingerprint,
      allowedReaderSuiteCrmUserIds:verified.allowedReaderSuiteCrmUserIds,permit})+'\n'
    need(Buffer.byteLength(stdin,'utf8')<=650_000,'packet_bound')
    return stdin
  }
  const execute=async(action:Action,fenceEpoch:string,expiresAt:number,stdin:string|(()=>Promise<string>),exactFence=false)=>{
    const stat=lstatSync(railwayBinary)
    need(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o022)===0&&stat.size<=268435456
      &&createHash('sha256').update(readFileSync(railwayBinary)).digest('hex')===railwayBinarySha256,'binary_changed')
    let identity: ReturnType<typeof lstatSync>
    try { identity=lstatSync(railwayIdentityFile) } catch { need(false,'identity_file') }
    need(identity.isFile()&&!identity.isSymbolicLink()&&identity.uid===process.geteuid?.()
      &&[0o400,0o600].includes(Number(identity.mode)&0o7777)&&identity.size>0&&identity.size<=131072,'identity_file')
    const challenge=createNativeEmailRecoveryReadyChallenge({action,targetFingerprint,fenceEpoch,
      permitExpiresAt:expiresAt,...(exactFence?{expectedFenceExpiresAt:expiresAt}:{})},attestationKey)
    let readyVerified=false,authorizationRequested=false
    const gatedInput=typeof stdin==='string'?stdin:async()=>{
      need(readyVerified&&!authorizationRequested,'authorization_before_ready_or_reentered')
      authorizationRequested=true
      return stdin()
    }
    const output=await run({program:railwayBinary,args:['ssh','--project',t.projectId,'--environment',t.environmentId,
      '--service',t.serviceId,'--deployment-instance',t.deploymentInstanceId,'--identity-file',railwayIdentityFile,
      '--','php',CLI,action,challenge.nonce],stdin:gatedInput,verifyReady:line=>{
      if(readyVerified)return false
      return readyVerified=challenge.verifyReady(line)
    }})
    need(readyVerified&&(typeof stdin==='string'||authorizationRequested),'destination_unverified')
    need(typeof output==='string'&&Buffer.byteLength(output,'utf8')<=1250000,'output_bound')
    let value:unknown
    try{value=JSON.parse(output)}catch{need(false,'output_json')}
    need(value&&typeof value==='object'&&!Array.isArray(value)&&output===nativeEmailCanonicalJson(value)+'\n','output_canonical')
    return value
  }
  return Object.freeze({targetFingerprint,async exchange({request,permit}:Packet){
    const action=permit?.proof?.action
    need(action==='prepare'||action==='publish'||action==='resolve','packet_scope')
    need(action!=='publish','publish_requires_readiness')
    return execute(action,permit.proof.fenceEpoch,permit.proof.expiresAt,encode(checkedRequest(request),permit,action))
  },async exchangePublish({request,fence:input,authorize}:NativeEmailRecoveryDeferredPublish){
    const verified=checkedRequest(request),fence=Object.freeze({...input})
    need(fence.targetFingerprint===targetFingerprint&&matches(fence.fenceEpoch,UUID)&&typeof authorize==='function','packet_scope')
    return execute('publish',fence.fenceEpoch,fence.expiresAt,async()=>encode(verified,await authorize(),'publish',fence),true)
  }})
}
