import 'server-only'
import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {lstatSync,readFileSync,realpathSync} from 'node:fs'
import {isAbsolute} from 'node:path'
import {nativeEmailCanonicalJson as json,requireNativeEmail} from './nativeEmailPublication'
import type {NativeEmailInitialSourceCollector,NativeEmailInitialReservedSource,NativeEmailInitialPreparationSource,
  NativeEmailInitialNativePreparationRequest} from './nativeEmailInitialEnrollmentOperator'
import type {NativeEmailInitialExecution} from './nativeEmailInitialEnrollmentPostgres'
import type {NativeEmailInitialOperatorTransport} from './nativeEmailInitialEnrollmentCoordinator'
import type {NativeEmailInitialStartupOriginEnvelope} from './nativeEmailInitialStartupOrigin'
import {prepareNativeEmailInitialReplanContext,nativeEmailInitialReplanContextFromLineage,
  type NativeEmailInitialReplanContext} from './nativeEmailInitialInstallationLineage'

type Row=Record<string,unknown>
export type NativeEmailInitialCliTarget={railwayBinary:string;railwayBinarySha256:string;railwayIdentityFile:string;
  projectId:string;environmentId:string;serviceId:string;deploymentInstanceId:string;
  nativeInstanceId:string;database:string;serviceUserId:string;oauthClientId:string;cliSourceHash:string;imagePackageHash:string}
type Command={program:string;args:string[];stdin?:string}
/** This injectable command boundary is for acceptance tests. Production uses
 * the fixed argv-only Railway SSH implementation below, never browser JSON,
 * a shell fragment, cached native output or a test TypeScript module loader. */
export type NativeEmailInitialCliCommandRunner=(command:Command)=>Promise<string>
const HASH=/^[a-f0-9]{64}(?![\s\S])/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const ID=/^[A-Za-z0-9][A-Za-z0-9-]{0,35}(?![\s\S])/
const NATIVE_CLI='/opt/clawpilot/native-email-initial-cli.php',ARTIFACT_CLI='/opt/clawpilot/native-email-initial-artifacts.php'
const BOOTSTRAP_LEAVES=['vendor/autoload.php','public/legacy/include/entryPoint.php','public/legacy/config.php','public/legacy/config_override.php',
  'public/legacy/include/modules_override.php','public/legacy/custom/include/custom_utils.php',
  'public/legacy/custom/application/Ext/Utils/custom_utils.ext.php','public/legacy/custom/application/Ext/Include/modules.ext.php',
  'public/legacy/custom/include/database/MysqliManager.php']
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex')
function need(value:unknown,code:string):asserts value{requireNativeEmail(value,'initial_cli_transport_'+code)}
function exact(value:unknown,keys:string[]):asserts value is Row{need(value&&typeof value==='object'&&!Array.isArray(value)
  &&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort()),'shape')}
function identityFile(path:string){
  let stat:ReturnType<typeof lstatSync>,canonicalPath:string
  try{stat=lstatSync(path);canonicalPath=realpathSync(path)}catch{need(false,'identity_file')}
  need(canonicalPath===path&&stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===process.geteuid?.()&&stat.nlink===1
    &&[0o400,0o600].includes(Number(stat.mode)&0o7777)&&stat.size>0&&stat.size<=131072,'identity_file')
}
// Transport metadata has fixed filesystem-path keys in bootstrapPins. It is
// NOT the native permission wire grammar; do not relax that shared validator.
function artifactJson(value:unknown):string{
  function visit(v:unknown,depth:number):unknown{need(depth<=40,'artifact_depth')
    if(v===null||typeof v==='boolean')return v
    if(typeof v==='number'){need(Number.isSafeInteger(v),'artifact_number');return v}
    if(typeof v==='string'){need(Buffer.from(v,'utf8').toString('utf8')===v,'artifact_unicode');return v}
    if(Array.isArray(v)){need(Object.keys(v).length===v.length,'artifact_array');return v.map(x=>visit(x,depth+1))}
    need(v&&typeof v==='object'&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null),'artifact_object')
    return Object.fromEntries(Object.keys(v).sort().map(key=>[String(visit(key,depth+1)),visit((v as Row)[key],depth+1)]))
  }
  return JSON.stringify(visit(value,0)).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')
}
function parse(bytes:string):Row{need(typeof bytes==='string'&&Buffer.byteLength(bytes,'utf8')<=4194304,'output_bound')
  let value:unknown;try{value=JSON.parse(bytes)}catch{need(false,'output_json')}
  need(value&&typeof value==='object'&&!Array.isArray(value)&&bytes===artifactJson(value)+'\n','output_canonical');return value as Row}

/** Railway handles its own authenticated SSH session. Do not pass the app's
 * DATABASE_URL, RSA private key or arbitrary process environment to its child.
 * A timeout/nonzero exit is an UNKNOWN remote outcome; this never retries. */
export function createNativeEmailInitialCliCommandRunner(timeoutMs=60000,terminationGraceMs=2000):NativeEmailInitialCliCommandRunner{
  need(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000&&Number.isSafeInteger(terminationGraceMs)
    &&terminationGraceMs>0&&terminationGraceMs<=2000,'command_deadline')
  return command=>new Promise((resolve,reject)=>{
  // Fixed, nonsecret mode satisfies Next's ProcessEnv augmentation without
  // inheriting the application environment or its development-only options.
  const env:NodeJS.ProcessEnv={NODE_ENV:'production'}
  for(const key of ['PATH','HOME','USER','LOGNAME','TMPDIR','SSH_AUTH_SOCK','RAILWAY_API_TOKEN','RAILWAY_TOKEN','RAILWAY_CONFIG_DIR'])
    if(process.env[key]!==undefined)env[key]=process.env[key]
  const child=spawn(command.program,command.args,{env,stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32'})
  const chunks:Buffer[]=[];let size=0,failed=false,settled=false,killTimer:ReturnType<typeof setTimeout>|undefined
  const terminate=(signal:NodeJS.Signals)=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal)
    else child.kill(signal)}catch{/* The exact owned child/group may already have exited. */}}
  const stop=()=>{if(failed)return;failed=true
    if(!settled){settled=true;reject(new Error('initial_cli_transport_remote_outcome_unknown'))}
    terminate('SIGTERM');killTimer=setTimeout(()=>{terminate('SIGKILL');child.stdout.destroy();child.stderr.destroy();child.stdin.destroy()},terminationGraceMs)}
  const timer=setTimeout(stop,timeoutMs)
  child.stdout.on('data',(bytes:Buffer)=>{size+=bytes.length;if(size>4194304)stop();else chunks.push(bytes)})
  // Drain but never expose provider stderr (which may contain credentials).
  child.stderr.on('data',()=>{})
  child.on('error',()=>{clearTimeout(timer);stop()})
  child.on('close',code=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);if(settled)return;settled=true
    if(failed||code!==0)reject(new Error('initial_cli_transport_remote_outcome_unknown'));else resolve(Buffer.concat(chunks).toString('utf8'))})
  child.stdin.on('error',stop)
  child.stdin.end(command.stdin??'')
  })
}
export const runNativeEmailInitialCliCommand=createNativeEmailInitialCliCommandRunner()

/** Private authenticated operator adapter. The real SQL collector constructs
 * mappings/plan and independently checks complete native source and forecasts.
 * This class only stages root-private immutable artifacts and invokes fixed
 * commands. It neither fabricates installation proof nor settles PG from an
 * execute acknowledgement. All remote calls happen outside PG transactions. */
export class NativeEmailInitialEnrollmentCliTransport implements NativeEmailInitialSourceCollector,NativeEmailInitialOperatorTransport{
  private readonly target:Readonly<NativeEmailInitialCliTarget>
  constructor(target:NativeEmailInitialCliTarget,private readonly run:NativeEmailInitialCliCommandRunner=runNativeEmailInitialCliCommand){
    exact(target,['railwayBinary','railwayBinarySha256','railwayIdentityFile','projectId','environmentId','serviceId','deploymentInstanceId',
      'nativeInstanceId','database','serviceUserId','oauthClientId','cliSourceHash','imagePackageHash'])
    need(typeof target.railwayBinary==='string'&&isAbsolute(target.railwayBinary)&&HASH.test(target.railwayBinarySha256)
      &&typeof target.railwayIdentityFile==='string'&&isAbsolute(target.railwayIdentityFile)&&!target.railwayIdentityFile.includes('\0')
      &&[target.projectId,target.environmentId,target.serviceId,target.deploymentInstanceId].every(id=>typeof id==='string'&&UUID.test(id)),'target')
    need([target.nativeInstanceId,target.serviceUserId,target.oauthClientId].every(id=>ID.test(id))
      &&/^[A-Za-z0-9_]{1,64}(?![\s\S])/.test(target.database)&&HASH.test(target.cliSourceHash)&&HASH.test(target.imagePackageHash),'native_identity')
    // The SHA-pinned operator configuration approves this exact path. Verify
    // filesystem metadata without reading the credential or choosing a default.
    identityFile(target.railwayIdentityFile)
    this.target=Object.freeze({...target})
  }
  private command(script:string,args:string[],stdin?:string){
    const t=this.target,stat=lstatSync(t.railwayBinary)
    need(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o022)===0&&stat.size<=268435456
      &&hash(readFileSync(t.railwayBinary))===t.railwayBinarySha256,'railway_binary_changed')
    identityFile(t.railwayIdentityFile)
    return this.run({program:t.railwayBinary,args:['ssh','--project',t.projectId,'--environment',t.environmentId,'--service',t.serviceId,
      '--deployment-instance',t.deploymentInstanceId,'--identity-file',t.railwayIdentityFile,
      '--','php',script,...args],...(stdin===undefined?{}:{stdin})})
  }
  private async bootstrap(operationId:string){need(HASH.test(operationId),'operation')
    const value=parse(await this.command(ARTIFACT_CLI,['bootstrap','--operation='+operationId,'--quiescent']))
    exact(value,['version','purpose','operationId','cliSourceHash','imagePackageHash','bootstrapPins','activeArtifactHash'])
    need(value.version===1&&value.purpose==='clawpilot-native-email-initial-bootstrap-pins'&&value.operationId===operationId
      &&value.cliSourceHash===this.target.cliSourceHash&&value.imagePackageHash===this.target.imagePackageHash
      &&(value.activeArtifactHash===null||typeof value.activeArtifactHash==='string'&&HASH.test(value.activeArtifactHash)),'bootstrap_binding')
    exact(value.bootstrapPins,BOOTSTRAP_LEAVES)
    need(Object.values(value.bootstrapPins).every(v=>v===null||typeof v==='string'&&HASH.test(v)),'bootstrap_hashes')
    return value as Row&{bootstrapPins:Record<string,string|null>;activeArtifactHash:string|null}
  }
  private async stage(source:NativeEmailInitialReservedSource|NativeEmailInitialPreparationSource,
    plan:NativeEmailInitialNativePreparationRequest['plan']|null,preparedAt:string|null,authorization:NativeEmailInitialExecution['approval']|null,
    requestedContext?:NativeEmailInitialReplanContext){
    need(source.nativeInstanceId===this.target.nativeInstanceId,'source_destination')
    const installationContext=plan?.kind==='initial_enrollment_replan_v1'
      ?nativeEmailInitialReplanContextFromLineage(plan.installationLineage,source.operationId)
      :requestedContext?prepareNativeEmailInitialReplanContext(requestedContext,source.operationId):undefined
    need(!requestedContext||plan===null,'source_context_only')
    const observed=await this.bootstrap(source.operationId),t=this.target
    const artifact={version:installationContext?2:1,purpose:installationContext?'clawpilot-native-email-initial-replan-cli-artifact':'clawpilot-native-email-initial-cli-artifact',operationId:source.operationId,
      nativeInstanceId:source.nativeInstanceId,appGeneration:source.appGeneration,appSourceFingerprint:source.appSourceFingerprint,
      sourceArtifactDigest:'sourceArtifactDigest' in source?source.sourceArtifactDigest:null,database:t.database,serviceUserId:t.serviceUserId,
      oauthClientId:t.oauthClientId,cliSourceHash:t.cliSourceHash,imagePackageHash:t.imagePackageHash,bootstrapPins:observed.bootstrapPins,
      mappings:plan===null?source.mappings:null,plan,preparedAt,authorization,...(installationContext?{installationContext}:{})}
    const bytes=artifactJson(artifact)+'\n',sha=hash(bytes)
    const result=parse(await this.command(ARTIFACT_CLI,['stage-input','--operation='+source.operationId,'--sha256='+sha,
      '--previous='+(observed.activeArtifactHash??'none'),'--quiescent'],bytes))
    exact(result,['operationId','sha256','replayed']);need(result.operationId===source.operationId&&result.sha256===sha&&typeof result.replayed==='boolean','stage_binding')
    return sha
  }
  async inspectSource(source:NativeEmailInitialReservedSource){
    const artifactHash=await this.stage(source,null,null,null)
    const bytes=await this.command(NATIVE_CLI,['inspect-source','--operation='+source.operationId,'--artifact-sha256='+artifactHash,'--quiescent'])
    const parsed=parse(bytes);need(parsed.purpose==='clawpilot-native-email-initial-source','source_domain')
    const sourceArtifactDigest=hash(bytes),retained=parse(await this.command(ARTIFACT_CLI,['retain-source','--operation='+source.operationId,
      '--sha256='+sourceArtifactDigest,'--quiescent'],bytes))
    exact(retained,['operationId','sourceArtifactDigest']);need(retained.operationId===source.operationId&&retained.sourceArtifactDigest===sourceArtifactDigest,'source_retention')
    return bytes
  }
  async inspectInstalledSource(source:NativeEmailInitialReservedSource,value:NativeEmailInitialReplanContext){
    const context=prepareNativeEmailInitialReplanContext(value,source.operationId)
    const artifactHash=await this.stage(source,null,null,null,context)
    const bytes=await this.command(NATIVE_CLI,['inspect-installed-source','--operation='+source.operationId,'--artifact-sha256='+artifactHash,'--quiescent'])
    const parsed=parse(bytes)
    need(parsed.version===2&&parsed.purpose==='clawpilot-native-email-initial-installed-source'
      &&json(parsed.installationContext)===json(context),'installed_source_domain')
    const sourceArtifactDigest=hash(bytes),retained=parse(await this.command(ARTIFACT_CLI,['retain-source','--operation='+source.operationId,
      '--sha256='+sourceArtifactDigest,'--quiescent'],bytes))
    exact(retained,['operationId','sourceArtifactDigest'])
    need(retained.operationId===source.operationId&&retained.sourceArtifactDigest===sourceArtifactDigest,'source_retention')
    return bytes
  }
  async readSource(source:NativeEmailInitialPreparationSource){need(HASH.test(source.sourceArtifactDigest),'source_digest')
    const status=await this.sourceStatus(source)
    need(status.sourceArtifactDigest===source.sourceArtifactDigest,'source_changed')
    const bytes=await this.command(ARTIFACT_CLI,['read-source','--operation='+source.operationId,'--sha256='+source.sourceArtifactDigest,'--quiescent'])
    need(hash(bytes)===source.sourceArtifactDigest,'source_changed');return bytes
  }
  /** Actual protected retained-file metadata. This comparison is not source
   * approval, a SQL reservation, native compatibility or activation proof. */
  async sourceStatus(source:Pick<NativeEmailInitialReservedSource,'operationId'|'nativeInstanceId'|'appGeneration'|'appSourceFingerprint'>){
    need(HASH.test(source.operationId)&&source.nativeInstanceId===this.target.nativeInstanceId
      &&Number.isSafeInteger(source.appGeneration)&&source.appGeneration>0&&HASH.test(source.appSourceFingerprint),'source_destination')
    const value=parse(await this.command(ARTIFACT_CLI,['source-status','--operation='+source.operationId,'--quiescent']))
    exact(value,['version','purpose','operationId','nativeInstanceId','appGeneration','appSourceFingerprint','sourceArtifactDigest','activeArtifactHash'])
    need(value.version===1&&value.purpose==='clawpilot-native-email-initial-retained-source-status'
      &&value.operationId===source.operationId&&value.nativeInstanceId===source.nativeInstanceId&&value.appGeneration===source.appGeneration
      &&value.appSourceFingerprint===source.appSourceFingerprint&&typeof value.sourceArtifactDigest==='string'&&HASH.test(value.sourceArtifactDigest)
      &&typeof value.activeArtifactHash==='string'&&HASH.test(value.activeArtifactHash),'retained_source_binding')
    return {sourceArtifactDigest:value.sourceArtifactDigest,activeArtifactHash:value.activeArtifactHash}
  }
  private async preparation(action:'project'|'prepare',request:NativeEmailInitialNativePreparationRequest){
    const artifactHash=await this.stage(request.source,request.plan,request.preparedAt,null)
    const result=parse(await this.command(NATIVE_CLI,[action,'--operation='+request.source.operationId,'--artifact-sha256='+artifactHash,
      '--plan-sha256='+hash(json(request.plan)),'--with-installation-proof','--quiescent']))
    exact(result,['forecast','installationJournalFingerprint'])
    need(result.forecast&&typeof result.forecast==='object'&&!Array.isArray(result.forecast)
      &&typeof result.installationJournalFingerprint==='string'&&HASH.test(result.installationJournalFingerprint),'installation_proof')
    return {forecast:result.forecast,installationJournalFingerprint:result.installationJournalFingerprint}
  }
  project(request:NativeEmailInitialNativePreparationRequest){return this.preparation('project',request)}
  prepare(request:NativeEmailInitialNativePreparationRequest){return this.preparation('prepare',request)}
  private async execution(action:'execute'|'resolve'|'cancel-expired',execution:NativeEmailInitialExecution){
    const {plan,approval}=execution
    need(execution.planHash===hash(json(plan))&&approval.proof.planHash===execution.planHash,'execution_plan')
    // Source digest is retained by the actual native installation journal. Its
    // original bytes must be supplied by the reviewed source capture, not
    // derived from changed native content or a caller "complete" flag.
    let sourceArtifactDigest=this.sourceDigests.get(plan.operationId)
    if(!sourceArtifactDigest&&action!=='execute'){
      // Recovery/resolution uses the actual retained SQL execution. It may
      // recover its original remote digest, never create/renew an approval.
      sourceArtifactDigest=(await this.sourceStatus(plan)).sourceArtifactDigest
      this.retainSourceDigest(plan.operationId,sourceArtifactDigest)
    }
    need(sourceArtifactDigest&&HASH.test(sourceArtifactDigest),'retained_source_digest_required')
    if(plan.kind==='initial_enrollment_replan_v1')need(sourceArtifactDigest===plan.installationLineage.freshSourceArtifactDigest,'replan_source_digest_changed')
    const source={operationId:plan.operationId,nativeInstanceId:plan.nativeInstanceId,appGeneration:plan.appGeneration,
      appSourceFingerprint:plan.appSourceFingerprint,mappings:[],sourceArtifactDigest}
    const artifactHash=await this.stage(source,plan,approval.proof.preparedAt,approval)
    const args=[action,'--operation='+plan.operationId,'--artifact-sha256='+artifactHash,'--plan-sha256='+execution.planHash,'--quiescent']
    if(action!=='resolve')args.push('--approve-operation='+plan.operationId)
    return parse(await this.command(NATIVE_CLI,args))
  }
  private readonly sourceDigests=new Map<string,string>()
  /** Immutable digest from the protected original source capture/review. */
  retainSourceDigest(operationId:string,sourceArtifactDigest:string){need(HASH.test(operationId)&&HASH.test(sourceArtifactDigest),'source_digest')
    const previous=this.sourceDigests.get(operationId);need(!previous||previous===sourceArtifactDigest,'source_digest_changed')
    this.sourceDigests.set(operationId,sourceArtifactDigest)}
  execute(execution:NativeEmailInitialExecution){return this.execution('execute',execution)}
  resolve(execution:NativeEmailInitialExecution){return this.execution('resolve',execution)}
  cancelExpired(execution:NativeEmailInitialExecution){return this.execution('cancel-expired',execution)}
  async originStatus(operationId:string){need(HASH.test(operationId),'operation')
    const value=parse(await this.command(ARTIFACT_CLI,['origin-status','--operation='+operationId,'--quiescent']))
    exact(value,['version','purpose','operationId','originSha256'])
    need(value.version===1&&value.purpose==='clawpilot-native-email-initial-retained-origin-status'&&value.operationId===operationId
      &&(value.originSha256===null||typeof value.originSha256==='string'&&HASH.test(value.originSha256)),'origin_status_binding')
    return value.originSha256 as string|null
  }
  async readOrigin(operationId:string,expectedHash:string){need(HASH.test(operationId)&&HASH.test(expectedHash),'origin_digest')
    const bytes=await this.command(ARTIFACT_CLI,['read-origin','--operation='+operationId,'--sha256='+expectedHash,'--quiescent'])
    need(hash(bytes)===expectedHash,'origin_changed')
    const value=parse(bytes+'\n');exact(value,['proof','signature'])
    need(value.proof&&typeof value.proof==='object'&&!Array.isArray(value.proof)
      &&(value.proof as Row).operationId===operationId
      &&(value.proof as Row).purpose==='clawpilot-native-email-initial-activation-origin','origin_domain')
    return bytes
  }
  async publishOrigin(envelope:NativeEmailInitialStartupOriginEnvelope){const bytes=json(envelope),sha=hash(bytes)
    const result=parse(await this.command(ARTIFACT_CLI,['publish-origin','--operation='+envelope.proof.operationId,'--sha256='+sha,'--quiescent'],bytes))
    exact(result,['operationId','originSha256']);need(result.operationId===envelope.proof.operationId&&result.originSha256===sha,'origin_publish')
    return result
  }
}
