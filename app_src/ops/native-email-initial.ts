/** PRIVATE operator executable; never imported by an app route or public UI.
 * Build once with scripts/build-native-email-initial-operator.mjs. No runtime
 * TypeScript loader, eval, browser JSON authority or automatic migration. */
import 'server-only'
import {constants as cryptoConstants,createHash,createPrivateKey,createPublicKey,verify} from 'node:crypto'
import {constants as fsConstants,existsSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,closeSync,writeFileSync,fsyncSync,realpathSync} from 'node:fs'
import {dirname,isAbsolute,resolve,sep} from 'node:path'
import {Pool} from 'pg'
import {nativeEmailCanonicalJson as json,NativeEmailPublicationHeld,requireNativeEmail} from '../lib/crm/nativeEmailPublication'
import {PostgresNativeEmailInitialEnrollmentStore,type NativeEmailInitialOperatorSelection} from '../lib/crm/nativeEmailInitialEnrollmentPostgres'
import {NativeEmailInitialEnrollmentOperator,type NativeEmailInitialPrepareInput} from '../lib/crm/nativeEmailInitialEnrollmentOperator'
import {NativeEmailInitialEnrollmentCliTransport,type NativeEmailInitialCliTarget} from '../lib/crm/nativeEmailInitialEnrollmentCliTransport'
import {createNativeEmailInitialApprovalIssuer} from '../lib/crm/nativeEmailInitialEnrollmentApproval'
import {NativeEmailInitialEnrollmentCoordinator} from '../lib/crm/nativeEmailInitialEnrollmentCoordinator'
import {createNativeEmailInitialStartupOriginIssuer,type NativeEmailInitialStartupOriginEnvelope} from '../lib/crm/nativeEmailInitialStartupOrigin'
import type {NativeEmailSqlTransaction} from '../lib/crm/nativeEmailPublicationPostgres'

type Row=Record<string,unknown>
type Config={version:1;purpose:'clawpilot-native-email-initial-private-operator';selection:NativeEmailInitialOperatorSelection;
  native:NativeEmailInitialCliTarget;databaseName:string;artifactDirectory:string;issuer:{keyId:string;publicKey:string}}
const HASH=/^[a-f0-9]{64}(?![\s\S])/
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex')
function need(value:unknown,code:string):asserts value{requireNativeEmail(value,'initial_private_operator_'+code)}
function exact(value:unknown,keys:string[]):asserts value is Row{need(value&&typeof value==='object'&&!Array.isArray(value)
  &&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort()),'shape')}
function privateDirectory(path:string){need(isAbsolute(path)&&realpathSync(path)===path,'private_path')
  const meta=lstatSync(path);need(meta.isDirectory()&&!meta.isSymbolicLink()&&meta.uid===process.getuid?.()&&(meta.mode&0o777)===0o700,'directory_protection')}
function privateRead(path:string,expectedHash?:string){need(isAbsolute(path),'private_path');privateDirectory(dirname(path))
  const fd=openSync(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW)
  try{const meta=fstatSync(fd),named=lstatSync(path);need(meta.isFile()&&!named.isSymbolicLink()&&named.dev===meta.dev&&named.ino===meta.ino
    &&meta.nlink===1&&meta.uid===process.getuid?.()
    &&(meta.mode&0o777)===0o600&&meta.size<=4194304,'file_protection');const bytes=readFileSync(fd,'utf8')
    need(Buffer.byteLength(bytes,'utf8')===meta.size&&(!expectedHash||HASH.test(expectedHash)&&hash(bytes)===expectedHash),'file_changed');return bytes
  }finally{closeSync(fd)}}
function privateWriteOnce(path:string,bytes:string){privateDirectory(dirname(path));need(Buffer.byteLength(bytes,'utf8')<=4194304,'file_bound')
  let fd:number
  try{fd=openSync(path,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_NOFOLLOW,0o600)}catch(e){
    if((e as NodeJS.ErrnoException).code==='EEXIST'){need(privateRead(path)===bytes,'immutable_file_changed');return}throw e}
  try{writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}
  const dir=openSync(dirname(path),fsConstants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}}
function options(args:string[]){const out:Record<string,string>={}
  for(const argument of args){const m=/^--(action|config|config-sha256|operation|source-sha256|source-artifact-sha256|root-source-artifact-sha256|predecessor-operation|approve-predecessor|plan-sha256|approve-operation)=(.+)(?![\s\S])/.exec(argument)
    need(m&&!Object.hasOwn(out,m[1]),'argument');out[m[1]]=m[2]}
  need(['preview','reserve','capture-source','capture-replan-source','recover-source','prepare-review','execute','resume','cancel-expired','publish-origin'].includes(out.action),'action')
  need(isAbsolute(out.config??'')&&HASH.test(out['config-sha256']??''),'config_pin')
  if(out.action!=='preview')need(HASH.test(out.operation??''),'operation')
  if(['reserve','capture-source','capture-replan-source','recover-source','prepare-review'].includes(out.action))need(HASH.test(out['source-sha256']??''),'source_pin')
  if(out.action==='recover-source')need(HASH.test(out['source-artifact-sha256']??''),'source_artifact_pin')
  else need(out['source-artifact-sha256']===undefined,'unexpected_source_artifact_pin')
  if(['execute','publish-origin'].includes(out.action))need(HASH.test(out['plan-sha256']??''),'review_pin')
  if(out.action==='capture-replan-source')need(HASH.test(out['predecessor-operation']??'')
    &&out['predecessor-operation']!==out.operation&&out['approve-predecessor']===out['predecessor-operation']
    &&HASH.test(out['root-source-artifact-sha256']??''),'explicit_predecessor_approval')
  else need(['predecessor-operation','approve-predecessor','root-source-artifact-sha256'].every(key=>out[key]===undefined),'unexpected_replan_selection')
  if(['reserve','capture-replan-source','recover-source','execute','cancel-expired','publish-origin'].includes(out.action))need(out['approve-operation']===out.operation,'explicit_operation_approval')
  else need(out['approve-operation']===undefined,'unexpected_approval')
  return out}
function readConfig(path:string,pin:string):Config{const value=JSON.parse(privateRead(path,pin))
  exact(value,['version','purpose','selection','native','databaseName','artifactDirectory','issuer'])
  need(value.version===1&&value.purpose==='clawpilot-native-email-initial-private-operator','config_domain')
  exact(value.selection,['actorEmail','operatorAccountId','rootWorkspaceId','nativeInstanceId']);exact(value.issuer,['keyId','publicKey'])
  need(typeof value.databaseName==='string'&&/^[A-Za-z0-9_]{1,64}(?![\s\S])/.test(value.databaseName)
    &&typeof value.artifactDirectory==='string'&&typeof value.issuer.keyId==='string'&&typeof value.issuer.publicKey==='string','config_value')
  privateDirectory(value.artifactDirectory)
  const c=value as unknown as Config;need(c.selection.nativeInstanceId===c.native.nativeInstanceId,'instance_binding');return c}

/** Fresh SQL authorization/origin verification is still required on every
 * command. Reuse the original signed bytes after an unknown transport outcome;
 * changing issuedAt and re-signing is not an immutable publication retry. */
export function reuseVerifiedNativeEmailInitialOrigin(fresh:NativeEmailInitialStartupOriginEnvelope,
  retained:unknown,publicKey:string,now=Date.now()):NativeEmailInitialStartupOriginEnvelope{
  exact(retained,['proof','signature']);exact(retained.proof,Object.keys(fresh.proof))
  const {issuedAt,...current}=fresh.proof;void issuedAt
  const {issuedAt:retainedAt,...previous}=retained.proof
  need(json(previous)===json(current)&&Number.isSafeInteger(retainedAt)&&Number(retainedAt)>0
    &&Number(retainedAt)<=Math.floor(now/1000)+30,'origin_retry_binding')
  const key=createPublicKey(publicKey)
  need(key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails?.modulusLength===3072&&typeof retained.signature==='string'
    &&/^[A-Za-z0-9+/]{512}(?![\s\S])/.test(retained.signature)
    &&verify('sha256',Buffer.from(json(retained.proof),'ascii'),{key,padding:cryptoConstants.RSA_PKCS1_PADDING},Buffer.from(retained.signature,'base64')),'origin_retry_signature')
  return retained as unknown as NativeEmailInitialStartupOriginEnvelope
}

/** Parse connection intent once. pg's connectionString parser accepts query
 * host/user/ssl overrides, so never pass it a URL after checking only hostname.
 * This remains a private server credential object, never a browser DTO. */
export function nativeEmailInitialOperatorDatabaseConfig(databaseUrl:string,expectedName:string){
  const url=new URL(databaseUrl),entries=[...url.searchParams.entries()]
  need(['postgres:','postgresql:'].includes(url.protocol)&&url.hash===''
    &&decodeURIComponent(url.pathname.slice(1))===expectedName,'database_destination')
  need(entries.length<=1&&entries.every(([key])=>key==='sslmode'),'database_query_override')
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname),sslmode=url.searchParams.get('sslmode')
  need(loopback?(sslmode===null||sslmode==='disable'||sslmode==='verify-full'):sslmode==='verify-full','database_tls')
  const user=decodeURIComponent(url.username),password=decodeURIComponent(url.password),port=Number(url.port||5432)
  need(user.length>0&&password.length>0&&Number.isSafeInteger(port)&&port>0&&port<=65535,'database_credentials')
  return {host:url.hostname==='[::1]'?'::1':url.hostname,port,user,password,database:expectedName,
    ssl:sslmode==='verify-full'?{rejectUnauthorized:true as const}:false as const}
}

export async function runNativeEmailInitialPrivateOperator(args:string[]){
  need(process.versions.node.split('.')[0]==='24','node_runtime')
  const o=options(args),config=readConfig(o.config,o['config-sha256'])
  need(process.env.DATABASE_URL&&!Object.keys(process.env).some(k=>/^NEXT_PUBLIC_.*(?:INITIAL|ISSUER).*PRIVATE_KEY/.test(k)),'database_configuration')
  const pool=new Pool({...nativeEmailInitialOperatorDatabaseConfig(process.env.DATABASE_URL,config.databaseName),
    max:2,connectionTimeoutMillis:5000,query_timeout:10000})
  try{
    const observed=await pool.query('SELECT current_database() AS database')
    need(observed.rows.length===1&&observed.rows[0].database===config.databaseName,'database_readback')
    const transaction:NativeEmailSqlTransaction=async fn=>{const client=await pool.connect()
      try{await client.query('BEGIN');const value=await fn({query:async(sql,values=[])=>client.query(sql,values)})
        await client.query('COMMIT');return value
      }catch(e){try{await client.query('ROLLBACK')}catch{/* Unknown outcome remains held, never retry the write. */}throw e}
      finally{client.release()}}
    const native=new NativeEmailInitialEnrollmentCliTransport(config.native),collector=new NativeEmailInitialEnrollmentOperator(transaction,config.selection,native)
    const verification={publicKey:config.issuer.publicKey,keyId:config.issuer.keyId,serviceUserId:config.native.serviceUserId,oauthClientId:config.native.oauthClientId}
    const bareStore=new PostgresNativeEmailInitialEnrollmentStore(transaction,config.selection,undefined,verification)
    if(o.action==='preview')return {action:o.action,...await bareStore.preview()}
    const operationId=o.operation
    // Retained SQL status/resolution never depends on local capture/review
    // files and cannot invoke the approval issuer. Pending native work uses
    // only its original stored signed execution and actual remote source.
    if(o.action==='resume'||o.action==='cancel-expired'){
      const neverIssue={async issue():Promise<never>{throw new Error('initial_private_operator_retained_action_cannot_issue')}}
      const coordinator=new NativeEmailInitialEnrollmentCoordinator(bareStore,neverIssue,native)
      const result=o.action==='resume'?await coordinator.resume(operationId):await coordinator.cancelExpired(operationId)
      return {action:o.action,operationId,...result}
    }
    const opDirectory=resolve(config.artifactDirectory,operationId)
    need(opDirectory.startsWith(config.artifactDirectory+sep),'operation_directory')
    try{mkdirSync(opDirectory,{mode:0o700})}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}privateDirectory(opDirectory)
    if(o.action==='reserve')return {action:o.action,...await bareStore.reserve(operationId,o['source-sha256'])}
    const privateKey=()=>{const value=process.env.CLAWPILOT_NATIVE_INITIAL_ISSUER_PRIVATE_KEY;need(value,'private_key_required')
      const key=createPrivateKey(value),publicKey=createPublicKey(key).export({type:'spki',format:'pem'})
      need(publicKey===config.issuer.publicKey,'private_key_destination');return key}
    const issuerConfig=()=>({privateKey:privateKey(),keyId:config.issuer.keyId,nativeInstanceId:config.native.nativeInstanceId,
      serviceUserId:config.native.serviceUserId,oauthClientId:config.native.oauthClientId})
    if(o.action==='publish-origin'){
      const fresh=await createNativeEmailInitialStartupOriginIssuer(transaction,config.selection,issuerConfig()).issue(operationId,o['plan-sha256'])
      const path=resolve(opDirectory,'activation-origin.json'),retained=existsSync(path)?privateRead(path):null
      // A lost acknowledgement/local file cannot authorize a timestamped
      // replacement of an already installed remote origin. Recover its exact
      // protected signed bytes, verify against fresh committed SQL facts, then
      // restore locally write-once and retry the same immutable publication.
      const remoteHash=await native.originStatus(operationId)
      const remote=remoteHash===null?null:await native.readOrigin(operationId,remoteHash)
      need(retained===null||remote===null||retained===remote,'origin_retry_conflict')
      const original=remote??retained
      const envelope=original?reuseVerifiedNativeEmailInitialOrigin(fresh,JSON.parse(original),config.issuer.publicKey):fresh
      need(original===null||original===json(envelope),'origin_retry_canonical')
      privateWriteOnce(path,json(envelope))
      return {action:o.action,...await native.publishOrigin(envelope)}
    }
    const sourcePath=resolve(opDirectory,'source.json'),reviewPath=resolve(opDirectory,'review.json')
    if(o.action==='capture-source'){
      const captured=await collector.captureSource(operationId,o['source-sha256'])
      privateWriteOnce(sourcePath,captured.sourceBytes)
      return {action:o.action,operationId,sourceArtifactDigest:captured.sourceArtifactDigest,emailCount:captured.source.mappings.length}
    }
    if(o.action==='capture-replan-source'){
      const predecessor=o['predecessor-operation'],rootSourceDigest=o['root-source-artifact-sha256']
      const before=await bareStore.readReplanContext(operationId,predecessor,rootSourceDigest)
      const captured=await collector.captureReplanSource(operationId,o['source-sha256'],before)
      const after=await bareStore.readReplanContext(operationId,predecessor,rootSourceDigest)
      need(json(before)===json(after),'replan_context_changed_during_native')
      privateWriteOnce(sourcePath,captured.sourceBytes)
      return {action:o.action,operationId,predecessorOperationId:predecessor,installationRootOperationId:before.rootOperationId,
        sourceArtifactDigest:captured.sourceArtifactDigest,emailCount:captured.source.mappings.length}
    }
    if(o.action==='recover-source'){
      const recovered=await collector.recoverRetainedSource(operationId,o['source-sha256'],o['source-artifact-sha256'])
      privateWriteOnce(sourcePath,recovered.sourceBytes)
      return {action:o.action,operationId,sourceArtifactDigest:recovered.sourceArtifactDigest,emailCount:recovered.source.mappings.length}
    }
    const sourceBytes=privateRead(sourcePath),sourceArtifactDigest=hash(sourceBytes)
    native.retainSourceDigest(operationId,sourceArtifactDigest)
    if(o.action==='prepare-review'){
      const previous=existsSync(reviewPath)?JSON.parse(privateRead(reviewPath)):null
      if(previous){exact(previous,['version','purpose','input','candidate']);need(previous.version===1
        &&previous.purpose==='clawpilot-native-email-initial-private-review','review_domain')}
      const input:NativeEmailInitialPrepareInput=previous?previous.input as NativeEmailInitialPrepareInput
        :{operationId,appSourceFingerprint:o['source-sha256'],sourceArtifactDigest,preparedAt:new Date().toISOString().slice(0,19).replace('T',' ')}
      need(input.operationId===operationId&&input.appSourceFingerprint===o['source-sha256']&&input.sourceArtifactDigest===sourceArtifactDigest,'retained_review_input')
      const candidate=await collector.prepareForReview(input)
      privateWriteOnce(reviewPath,json({version:1,purpose:'clawpilot-native-email-initial-private-review',input,candidate})+'\n')
      return {action:o.action,operationId,planHash:candidate.material.planHash,executable:false,emailCount:candidate.material.plan.emails.length,
        principalCount:candidate.material.plan.principalSuiteCrmUserIds.length,pipelineCount:candidate.material.plan.pipelines.length,
        reviewedRevocationCount:candidate.material.plan.reviewedRevocations.length,reviewArtifactSha256:hash(privateRead(reviewPath))}
    }
    const review=JSON.parse(privateRead(reviewPath));exact(review,['version','purpose','input','candidate'])
    need(review.version===1&&review.purpose==='clawpilot-native-email-initial-private-review','review_domain')
    const input=review.input as NativeEmailInitialPrepareInput
    need(input.operationId===operationId&&input.sourceArtifactDigest===sourceArtifactDigest,'source_review_binding')
    const expectedPlanHash=o['plan-sha256']??String((review.candidate as {material?:{planHash?:string}}).material?.planHash??'')
    need(HASH.test(expectedPlanHash),'review_pin')
    const reviewed={expectedPlanHash,read:()=>collector.readReviewedMaterial(input,expectedPlanHash)}
    const store=new PostgresNativeEmailInitialEnrollmentStore(transaction,config.selection,reviewed,verification)
    const issuer={issue:(op:string,pin:string)=>createNativeEmailInitialApprovalIssuer(store,issuerConfig()).issue(op,pin)}
    const coordinator=new NativeEmailInitialEnrollmentCoordinator(store,issuer,native)
    need(o.action==='execute','action')
    const result=await coordinator.execute(operationId,expectedPlanHash)
    return {action:o.action,operationId,...result}
  }finally{await pool.end()}
}

if(require.main===module){runNativeEmailInitialPrivateOperator(process.argv.slice(2))
  .then(value=>process.stdout.write(JSON.stringify(value)+'\n'))
  .catch(error=>{const code=error instanceof NativeEmailPublicationHeld?error.code:'initial_private_operator_outcome_held'
    process.stderr.write(JSON.stringify({held:true,code})+'\n');process.exitCode=1})}
