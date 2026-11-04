import 'server-only'
import {constants,createPrivateKey,createPublicKey,sign,verify,type KeyObject} from 'node:crypto'
import {nativeEmailCanonicalJson as json,nativeEmailDigest,requireNativeEmail} from './nativeEmailPublication'
import {verifyNativeEmailInitialEnrollmentFingerprint,type NativeEmailInitialEnrollmentInput,
  type NativeEmailInitialEnrollmentEvidence} from './nativeEmailInitialEnrollment'

export type NativeEmailInitialApprovalProof={
  version:1;purpose:'clawpilot-native-email-initial-enrollment-approval';issuer:'clawpilot-pg-initial-enrollment'
  audience:'clawpilot-suitecrm-initial-enrollment';keyId:string;nativeInstanceId:string;serviceUserId:string;oauthClientId:string
  issuedAt:number;expiresAt:number;operationId:string;planHash:string;appGeneration:number;appSourceFingerprint:string
  preparedAt:string;deltaFingerprint:string;sourceRuntimeFingerprint:string;installedRuntimeFingerprint:string;installationJournalFingerprint:string
}
export type NativeEmailInitialApprovalEnvelope={proof:NativeEmailInitialApprovalProof;signature:string}
export type NativeEmailInitialApprovalRecord={
  state:'reserved';publicationEnabled:false;barrierOperationId:string
  plan:NativeEmailInitialEnrollmentInput;evidence:NativeEmailInitialEnrollmentEvidence;planHash:string
  preparedAt:string;nativeDelta:Record<string,unknown>;deltaFingerprint:string
  sourceRuntimeFingerprint:string;installedRuntimeFingerprint:string;installationJournalFingerprint:string
}
export interface NativeEmailInitialApprovalStore{
  /** Trusted DAL only: lock control -> retained source reservation, reauthorize original
   * root owner, compare the actual SQL-owned source snapshot and exact reviewed
   * plan/delta/journal, keep publication disabled, and persist this envelope
   * ONCE before returning. No provider I/O in create(). A supplied JSON record,
   * completeness boolean or failed transaction is NOT an implementation.
   * Existing approvals are returned unchanged, never renewed on a retry. */
  issueApproval(operationId:string,create:(record:NativeEmailInitialApprovalRecord)=>NativeEmailInitialApprovalEnvelope):Promise<NativeEmailInitialApprovalEnvelope>
}
export type NativeEmailInitialIssuerConfig={privateKey:string|KeyObject;keyId:string;nativeInstanceId:string;serviceUserId:string;oauthClientId:string;ttlSeconds?:number}
const HASH=/^[a-f0-9]{64}(?![\s\S])/,ID=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}(?![\s\S])/
const PROOF_KEYS=['version','purpose','issuer','audience','keyId','nativeInstanceId','serviceUserId','oauthClientId',
  'issuedAt','expiresAt','operationId','planHash','appGeneration','appSourceFingerprint','preparedAt','deltaFingerprint',
  'sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint']
function need(value:unknown,code:string):asserts value{requireNativeEmail(value,'initial_approval_'+code)}
function exact(value:unknown,keys:string[]):asserts value is Record<string,unknown>{
  need(value&&typeof value==='object'&&!Array.isArray(value)&&json(Object.keys(value).sort())===json([...keys].sort()),'shape')
}
function hash(value:unknown):asserts value is string{need(typeof value==='string'&&HASH.test(value),'hash')}
function utc(value:unknown):asserts value is string{
  need(typeof value==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?![\s\S])/.test(value),'prepared_at')
  const d=new Date(value.replace(' ','T')+'Z')
  need(Number.isFinite(d.getTime())&&d.toISOString().slice(0,19).replace('T',' ')===value,'prepared_at')
}
function bytes(proof:NativeEmailInitialApprovalProof){const text=json(proof)
  need(text.length<=4096&&!/[^\x20-\x7e]/.test(text),'non_ascii');return Buffer.from(text,'ascii')}

/** No route, activation, environment lookup, key generation or native call.
 * This signer requires a real durable DAL implementation; pure store fixtures
 * establish only the contract/signature, never a production admission. */
export function createNativeEmailInitialApprovalIssuer(store:NativeEmailInitialApprovalStore,config:NativeEmailInitialIssuerConfig,now:()=>number=Date.now){
  config={...config};need(store&&typeof store.issueApproval==='function','store_required')
  for(const key of ['keyId','nativeInstanceId','serviceUserId','oauthClientId'] as const)
    need(typeof config[key]==='string'&&ID.test(config[key])&&(!['serviceUserId','oauthClientId'].includes(key)||config[key].length<=36),'issuer_identity')
  const ttl=config.ttlSeconds??120;need(Number.isSafeInteger(ttl)&&ttl>0&&ttl<=300,'expiry')
  let privateKey:KeyObject
  try{privateKey=typeof config.privateKey==='string'?createPrivateKey(config.privateKey):config.privateKey}catch{need(false,'private_key')}
  need(privateKey!&&privateKey!.type==='private'&&privateKey!.asymmetricKeyType==='rsa'&&privateKey!.asymmetricKeyDetails?.modulusLength===3072,'private_key')
  const publicKey=createPublicKey(privateKey!)
  const clock=()=>{const value=Math.floor(now()/1000);need(Number.isSafeInteger(value)&&value>0,'clock');return value}
  const validate=(envelope:NativeEmailInitialApprovalEnvelope,operationId:string,planHash:string)=>{
    exact(envelope,['proof','signature']);exact(envelope.proof,PROOF_KEYS);const p=envelope.proof
    need(p.version===1&&p.purpose==='clawpilot-native-email-initial-enrollment-approval'&&p.issuer==='clawpilot-pg-initial-enrollment'
      &&p.audience==='clawpilot-suitecrm-initial-enrollment'&&p.operationId===operationId&&p.planHash===planHash,'domain_or_selection')
    for(const key of ['keyId','nativeInstanceId','serviceUserId','oauthClientId'] as const)need(p[key]===config[key],'destination')
    for(const key of ['operationId','planHash','appSourceFingerprint','deltaFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint'] as const)hash(p[key])
    need(Number.isSafeInteger(p.appGeneration)&&p.appGeneration>0,'generation');utc(p.preparedAt)
    need(Number.isSafeInteger(p.issuedAt)&&Number.isSafeInteger(p.expiresAt)&&p.issuedAt>0&&p.issuedAt<=clock()+30
      &&p.expiresAt>p.issuedAt&&p.expiresAt-p.issuedAt<=300&&Date.parse(p.preparedAt.replace(' ','T')+'Z')<=1000*(p.issuedAt+30),'expiry')
    need(typeof envelope.signature==='string'&&/^[A-Za-z0-9+/]{512}(?![\s\S])/.test(envelope.signature)
      &&verify('sha256',bytes(p),{key:publicKey,padding:constants.RSA_PKCS1_PADDING},Buffer.from(envelope.signature,'base64')),'signature')
  }
  return {async issue(operationId:string,expectedPlanHash:string){
    hash(operationId);hash(expectedPlanHash)
    const envelope=await store.issueApproval(operationId,record=>{
      exact(record,['state','publicationEnabled','barrierOperationId','plan','evidence','planHash','preparedAt','nativeDelta','deltaFingerprint',
        'sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint'])
      need(record.state==='reserved'&&record.publicationEnabled===false&&record.barrierOperationId===operationId,'durable_barrier')
      const prepared=verifyNativeEmailInitialEnrollmentFingerprint(record.plan,record.evidence,expectedPlanHash)
      need(record.planHash===expectedPlanHash&&prepared.plan.operationId===operationId,'reviewed_plan')
      utc(record.preparedAt)
      for(const key of ['deltaFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint'] as const)hash(record[key])
      need(record.sourceRuntimeFingerprint===record.plan.nativeRuntimeBeforeFingerprint,'source_runtime')
      exact(record.nativeDelta,['version','purpose','operationId','planHash','preparedAt','changes','result','policies'])
      const d=record.nativeDelta
      need(d.version===1&&d.purpose==='clawpilot-native-email-initial-policy-delta'&&d.operationId===operationId
        &&d.planHash===expectedPlanHash&&d.preparedAt===record.preparedAt&&nativeEmailDigest(d)===record.deltaFingerprint
        &&Buffer.byteLength(json(d),'utf8')<=1800000,'delta_binding')
      exact(d.changes,['acl_actions','securitygroups','securitygroups_users','securitygroups_records'])
      const result=d.result
      exact(result,['generation','appSourceFingerprint','beforePolicyFingerprint','afterPolicyFingerprint','sourceRuntimeFingerprint',
        'installedRuntimeFingerprint','runtimeFingerprint','identityFingerprint','capabilitiesFingerprint','bindingsFingerprint','defaultsFingerprint','emailCount','principalCount'])
      need(result.generation===record.plan.appGeneration&&result.appSourceFingerprint===record.plan.appSourceFingerprint
        &&result.beforePolicyFingerprint===record.plan.nativePolicyBeforeFingerprint&&result.afterPolicyFingerprint===record.plan.nativePolicyAfterFingerprint
        &&result.sourceRuntimeFingerprint===record.sourceRuntimeFingerprint&&result.installedRuntimeFingerprint===record.installedRuntimeFingerprint
        &&result.runtimeFingerprint===record.plan.nativeRuntimeAfterFingerprint&&result.emailCount===record.plan.emails.length
        &&result.principalCount===record.plan.principalSuiteCrmUserIds.length,'forecast_binding')
      for(const key of ['identityFingerprint','capabilitiesFingerprint','bindingsFingerprint','defaultsFingerprint'])hash(result[key])
      const policies=record.plan.pipelines.map(({policy})=>{const future={...policy};delete (future as Partial<typeof future>).historical
        return {pipelineId:policy.pipelineId,generation:record.plan.appGeneration,policy,fingerprint:nativeEmailDigest(future)}})
      need(json(d.policies)===json(policies),'policy_binding')
      const issuedAt=clock(),proof:NativeEmailInitialApprovalProof={version:1,purpose:'clawpilot-native-email-initial-enrollment-approval',
        issuer:'clawpilot-pg-initial-enrollment',audience:'clawpilot-suitecrm-initial-enrollment',keyId:config.keyId,nativeInstanceId:config.nativeInstanceId,
        serviceUserId:config.serviceUserId,oauthClientId:config.oauthClientId,issuedAt,expiresAt:issuedAt+ttl,operationId,planHash:expectedPlanHash,
        appGeneration:record.plan.appGeneration,appSourceFingerprint:record.plan.appSourceFingerprint,preparedAt:record.preparedAt,
        deltaFingerprint:record.deltaFingerprint,sourceRuntimeFingerprint:record.sourceRuntimeFingerprint,
        installedRuntimeFingerprint:record.installedRuntimeFingerprint,installationJournalFingerprint:record.installationJournalFingerprint}
      need(record.plan.nativeInstanceId===config.nativeInstanceId,'destination')
      const created={proof,signature:sign('sha256',bytes(proof),{key:privateKey!,padding:constants.RSA_PKCS1_PADDING}).toString('base64')}
      validate(created,operationId,expectedPlanHash);return created
    })
    // Expired retained approvals may be inspected/resolved but never renewed
    // here. The native executor independently refuses execution after expiry.
    validate(envelope,operationId,expectedPlanHash)
    return JSON.parse(json(envelope)) as NativeEmailInitialApprovalEnvelope
  }}
}
