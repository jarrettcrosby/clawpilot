import crypto from 'node:crypto'
import type {PoolClient} from 'pg'
import {query,withTransaction} from '@/lib/persistence/postgres'
import {stageCrmRecordWithClient} from '@/lib/persistence/crm'
import type {StageOrganizationInput,StageContactInput} from '@/lib/persistence/crm'
import {FractionalCrmGatewayError} from '@/lib/fractionalCrmGatewayAuth'
import type {FractionalCrmPrincipal,FractionalCrmCredential} from '@/lib/fractionalCrmGatewayAuth'
import {canonicalHash,exactKeys,gatewayGlobalId,gatewayObject,gatewayUuid,gatewayVersion,mapGatewayFields,normalizedEmail,normalizedName,parseGatewayFields} from '@/lib/crm/fractionalGatewayModel'
import type {GatewayEntity,GatewayFields,GatewayRecord} from '@/lib/crm/fractionalGatewayModel'

type Row=Record<string,unknown>
type Context={principal:FractionalCrmPrincipal;root:Row;actorEmail:string}
type WriteInput={ifMatch:string;idempotencyKey:string;fields:unknown;assertedFractionalActor:unknown}
const str=(row:Row,key:string)=>String(row[key]??'')
const nullable=(row:Row,key:string)=>row[key]===null||row[key]===undefined?null:String(row[key])
const fail=(status:number,code:string):never=>{throw new FractionalCrmGatewayError(status,code)}
function parse<T>(fn:()=>T):T{try{return fn()}catch(error){if(error instanceof FractionalCrmGatewayError)throw error;return fail(422,'INVALID_FIELDS')}}
const active=(row:Row)=>!['true','1','yes'].includes(String(gatewayObject(row.source_payload??{}).archived??'false').toLowerCase())
function credential(row:Row):FractionalCrmCredential{return {credentialId:str(row,'id'),tokenHash:str(row,'token_hash'),sourceInstanceId:str(row,'source_instance_id'),workspaceOrganizationId:str(row,'workspace_organization_id'),pipelineId:str(row,'pipeline_id'),rootCompanyGlobalId:str(row,'root_company_global_id'),
 allowedCompanyGlobalIds:row.allowed_company_global_ids as string[],capabilities:row.capabilities as FractionalCrmPrincipal['capabilities'],fractionalDeploymentId:str(row,'fractional_deployment_id'),fractionalOrganizationId:str(row,'fractional_organization_id'),actorEmail:str(row,'actor_email'),
 expiresAt:row.expires_at as Date,revokedAt:row.revoked_at as Date|null,enabled:row.enabled===true}}
export async function readFractionalCrmCredential(credentialId:string):Promise<FractionalCrmCredential|null>{
 if(!gatewayUuid(credentialId))return null
 const row=(await query('SELECT * FROM fractional_crm_gateway_credentials WHERE id=$1::uuid',[credentialId])).rows[0];return row?credential(row):null
}
async function context(client:PoolClient,supplied:FractionalCrmPrincipal,capability:FractionalCrmPrincipal['capabilities'][number],write=false,lockRecords=false):Promise<Context>{
 const row=(await client.query(`SELECT * FROM fractional_crm_gateway_credentials WHERE id=$1::uuid ${write?'FOR UPDATE':'FOR SHARE'}`,[supplied.credentialId])).rows[0]
 if(!row||!row.enabled||row.revoked_at||new Date(row.expires_at).getTime()<=Date.now())fail(401,'UNAUTHORIZED')
 const p=credential(row)
 for(const key of ['sourceInstanceId','workspaceOrganizationId','pipelineId','rootCompanyGlobalId','fractionalDeploymentId','fractionalOrganizationId'] as const)if(p[key]!==supplied[key])fail(403,'CAPABILITY_DENIED')
 if(!p.capabilities.includes(capability))fail(403,'CAPABILITY_DENIED')
 const bound=(await client.query(`SELECT ps.id FROM pipeline_spaces ps JOIN workspace_organizations wo ON wo.id=ps.workspace_organization_id
  JOIN app_user_organization_memberships m ON m.organization_id=wo.id AND m.user_email=$3 JOIN app_users u ON u.email=m.user_email
  WHERE ps.id=$1::uuid AND wo.id=$2::uuid AND wo.parent_id IS NULL AND NOT ps.reference_access_disabled
    AND m.status='active' AND m.role IN ('owner','admin') AND u.status='active' FOR SHARE OF ps,wo,m,u`,[p.pipelineId,p.workspaceOrganizationId,p.actorEmail])).rows[0]
 if(!bound)fail(404,'RECORD_NOT_FOUND')
 if(lockRecords){await client.query("SET LOCAL lock_timeout='3s'");await client.query('LOCK TABLE crm_organizations,crm_contacts IN EXCLUSIVE MODE')}
 const root=(await client.query('SELECT * FROM crm_organizations WHERE pipeline_id=$1::uuid AND reference_code=$2 FOR SHARE',[p.pipelineId,p.rootCompanyGlobalId])).rows[0]
 if(!root||!active(root)||root.workspace_organization_id!==p.workspaceOrganizationId||root.parent_organization_id!==null||root.relationship_type!=='workspace_root')fail(404,'RECORD_NOT_FOUND')
 return {principal:p,root,actorEmail:p.actorEmail}
}
function scope(ctx:Context){const {workspaceOrganizationId,pipelineId,rootCompanyGlobalId}=ctx.principal;return {workspaceOrganizationId,pipelineId,rootCompanyGlobalId}}
async function canonical(client:PoolClient,value:string,entity:GatewayEntity):Promise<string>{
 if(!gatewayGlobalId(value,entity))fail(422,'INVALID_GLOBAL_ID')
 let resolved=value;const seen=new Set<string>()
 for(let depth=0;depth<8;depth++){
 if(seen.has(resolved))fail(409,'IDENTITY_CONFLICT');seen.add(resolved)
 const row=(await client.query(`SELECT COALESCE(a.canonical_code,r.canonical_code) AS canonical_code
  FROM crm_reference_registry r LEFT JOIN crm_reference_aliases a ON a.alias_code=r.reference_code WHERE r.reference_code=$1`,[resolved])).rows[0]
 const next=String(row?.canonical_code??resolved)
 if(!gatewayGlobalId(next,entity))fail(409,'IDENTITY_CONFLICT')
 if(next===resolved)return resolved;resolved=next
 }
 return fail(409,'IDENTITY_CONFLICT')
}
async function companyRow(client:PoolClient,ctx:Context,requested:string,lock=false,allowUngrant=false):Promise<Row>{
 const ga=await canonical(client,requested,'company')
 if(ga===ctx.principal.rootCompanyGlobalId||(!allowUngrant&&!ctx.principal.allowedCompanyGlobalIds.includes(ga)))fail(404,'RECORD_NOT_FOUND')
 const candidate=(await client.query(`WITH RECURSIVE tree AS (SELECT id,ARRAY[id] AS seen,COALESCE(lower(source_payload->>'archived'),'false') NOT IN ('true','1','yes') AS active_path FROM crm_organizations WHERE pipeline_id=$1::uuid AND id=$2::uuid
  UNION ALL SELECT c.id,t.seen||c.id,COALESCE(lower(c.source_payload->>'archived'),'false') NOT IN ('true','1','yes') FROM crm_organizations c JOIN tree t ON c.parent_organization_id=t.id WHERE c.pipeline_id=$1::uuid AND NOT c.id=ANY(t.seen) AND cardinality(t.seen)<64 AND t.active_path)
  SELECT c.id,tree.seen FROM crm_organizations c JOIN tree ON tree.id=c.id WHERE c.pipeline_id=$1::uuid AND c.reference_code=$3`,[ctx.principal.pipelineId,ctx.root.id,ga])).rows[0]
 if(!candidate)fail(404,'RECORD_NOT_FOUND')
 const path=candidate.seen as string[],ancestorIds=path.slice(0,-1)
 // Lock the exact discovered ancestry, then validate every edge under those
 // locks. Native reparent/archive operations cannot invalidate this grant
 // between authorization and a conditional write or receipt replay.
 const ancestors=(await client.query(`SELECT * FROM crm_organizations WHERE pipeline_id=$1::uuid AND id=ANY($2::uuid[])
  ORDER BY array_position($2::uuid[],id) FOR SHARE`,[ctx.principal.pipelineId,ancestorIds])).rows
 if(ancestors.length!==ancestorIds.length||ancestors.some((r,i)=>r.id!==ancestorIds[i]||!active(r)||(i>0&&r.parent_organization_id!==ancestorIds[i-1])))fail(404,'RECORD_NOT_FOUND')
 const row=(await client.query(`SELECT * FROM crm_organizations WHERE pipeline_id=$1::uuid AND id=$2::uuid AND reference_code=$3 ${lock?'FOR UPDATE':'FOR SHARE'}`,[ctx.principal.pipelineId,candidate.id,ga])).rows[0]
 if(!row||row.parent_organization_id!==ancestorIds.at(-1))fail(404,'RECORD_NOT_FOUND');if(!active(row))fail(410,'RECORD_RETIRED');return row
}
async function contactRow(client:PoolClient,ctx:Context,parent:Row,requested:string,lock=false):Promise<Row>{
 const gc=await canonical(client,requested,'contact'),row=(await client.query(`SELECT * FROM crm_contacts WHERE pipeline_id=$1::uuid AND organization_id=$2::uuid AND reference_code=$3 ${lock?'FOR UPDATE':'FOR SHARE'}`,[ctx.principal.pipelineId,parent.id,gc])).rows[0]
 if(!row)fail(404,'RECORD_NOT_FOUND');if(!active(row))fail(410,'RECORD_RETIRED');return row
}
function envelope(ctx:Context,entity:GatewayEntity,row:Row,parent:Row,requested:string):GatewayRecord{
 const management=entity==='company'&&row.workspace_organization_id?'workspace':entity==='contact'&&(row.app_user_email||row.pipeline_user)?'app-user':'crm'
 return {schemaVersion:1,sourceInstanceId:ctx.principal.sourceInstanceId,scope:scope(ctx),entity,recordId:str(row,'id'),globalId:str(row,'reference_code'),companyGlobalId:str(parent,'reference_code'),
 resolution:{requestedGlobalId:requested,canonicalGlobalId:str(row,'reference_code'),status:requested===row.reference_code?'exact':'alias'},version:gatewayVersion(scope(ctx),ctx.principal.sourceInstanceId,entity,row,parent),status:'active',management,
 canPush:management==='crm'&&ctx.principal.capabilities.includes(entity==='company'?'crm.company.write':'crm.contact.write'),...mapGatewayFields(entity,row)}
}
export async function readFractionalCrmCompany(p:FractionalCrmPrincipal,ga:string){return withTransaction(async client=>{const ctx=await context(client,p,'crm.company.read'),row=await companyRow(client,ctx,ga);return envelope(ctx,'company',row,row,ga)})}
export async function readFractionalCrmContact(p:FractionalCrmPrincipal,ga:string,gc:string){return withTransaction(async client=>{const ctx=await context(client,p,'crm.contact.read'),parent=await companyRow(client,ctx,ga),row=await contactRow(client,ctx,parent,gc);return envelope(ctx,'contact',row,parent,gc)})}
export async function listFractionalCrmContacts(p:FractionalCrmPrincipal,ga:string,page:{limit?:number;cursor?:string|null}={}){return withTransaction(async client=>{
 const ctx=await context(client,p,'crm.contact.read'),parent=await companyRow(client,ctx,ga),limit=page.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)fail(422,'INVALID_PAGE')
 let after='';if(page.cursor){const value=parse(()=>JSON.parse(Buffer.from(page.cursor!,'base64url').toString('utf8'))) as Row;
 if(value.scope!==canonicalHash({credentialId:p.credentialId,scope:scope(ctx),company:parent.id})||!gatewayUuid(value.after))fail(422,'INVALID_PAGE');after=String(value.after)}
 const rows=(await client.query(`SELECT * FROM crm_contacts WHERE pipeline_id=$1::uuid AND organization_id=$2::uuid
  AND COALESCE(lower(source_payload->>'archived'),'false') NOT IN ('true','1','yes') AND ($3='' OR id>NULLIF($3,'')::uuid) ORDER BY id LIMIT $4`,[p.pipelineId,parent.id,after,limit+1])).rows
 const selected=rows.slice(0,limit);return {schemaVersion:1,sourceInstanceId:p.sourceInstanceId,scope:scope(ctx),items:selected.map(row=>envelope(ctx,'contact',row,parent,str(row,'reference_code'))),nextCursor:rows.length>limit?Buffer.from(JSON.stringify({scope:canonicalHash({credentialId:p.credentialId,scope:scope(ctx),company:parent.id}),after:selected.at(-1)!.id})).toString('base64url'):null}
 })}
function idempotency(value:string){if(!/^[A-Za-z0-9_-]{8,160}$/.test(value))fail(422,'INVALID_IDEMPOTENCY_KEY')}
async function operation<T>(client:PoolClient,ctx:Context,key:string,kind:string,input:unknown,apply:(operationId:string)=>Promise<T>):Promise<T>{
 idempotency(key);const hash=canonicalHash({scope:scope(ctx),sourceInstanceId:ctx.principal.sourceInstanceId,kind,input});
 const prior=(await client.query('SELECT request_hash,response FROM fractional_crm_gateway_operations WHERE credential_id=$1::uuid AND idempotency_key=$2',[ctx.principal.credentialId,key])).rows[0]
 if(prior){if(prior.request_hash!==hash)fail(409,'IDEMPOTENCY_CONFLICT')
 const response=prior.response as Row
 if(response.company){const old=gatewayObject(gatewayObject(response.company).record),current=await companyRow(client,ctx,String(old.globalId));if(current.id!==old.recordId)fail(409,'IDENTITY_CONFLICT')
 if(response.contact){const person=gatewayObject(gatewayObject(response.contact).record),contact=await contactRow(client,ctx,current,String(person.globalId));if(contact.id!==person.recordId)fail(409,'IDENTITY_CONFLICT')}}
 if(Array.isArray(response.candidates))for(const raw of response.candidates){const candidate=gatewayObject(raw),parent=await companyRow(client,ctx,String(candidate.companyGlobalId));if(candidate.entity==='contact')await contactRow(client,ctx,parent,String(candidate.globalId))}
 return {...response,...(kind==='onboarding'?{replayed:true}:{})} as T}
 const operationId=crypto.randomUUID(),response=await apply(operationId)
 const attribution=gatewayObject(input)
 await client.query('INSERT INTO fractional_crm_gateway_operations(id,credential_id,idempotency_key,request_hash,operation,response,asserted_actor,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[operationId,ctx.principal.credentialId,key,hash,kind,response,attribution.actor??{},attribution.origin??null]);return response
}
function originalCompany(row:Row):StageOrganizationInput['fields']{return {parentOrganizationId:nullable(row,'parent_organization_id'),workspaceOrganizationId:nullable(row,'workspace_organization_id'),relationshipType:row.relationship_type as 'customer',
 name:str(row,'name'),priority:str(row,'priority'),accountType:str(row,'account_type'),accountManager:str(row,'account_manager'),website:str(row,'website'),linkedinUrl:str(row,'linkedin_url'),phone:str(row,'phone'),email:str(row,'email'),emailOptOut:row.email_opt_out===true,
 address:str(row,'billing_address_street'),city:str(row,'billing_address_city'),state:str(row,'billing_address_state'),postalCode:str(row,'billing_address_postal_code'),country:str(row,'billing_address_country'),description:str(row,'description')}}
function originalContact(row:Row,parent:Row):StageContactInput['fields']{return {organizationId:str(parent,'id'),organizationSuiteCrmId:str(parent,'suitecrm_id'),fullName:str(row,'full_name'),firstName:str(row,'first_name'),lastName:str(row,'last_name'),
 priority:str(row,'priority'),contactType:str(row,'contact_type'),accountManager:str(row,'account_manager'),ownerUserReferenceCode:nullable(row,'owner_user_reference_code'),ownerEmail:nullable(row,'owner_email'),ownerDisplayName:nullable(row,'owner_display_name'),
 jobTitle:str(row,'job_title'),email:str(row,'email'),linkedinUrl:str(row,'linkedin_url'),phoneWork:str(row,'phone_work'),phoneMobile:str(row,'phone_mobile'),address:str(row,'primary_address_street'),city:str(row,'primary_address_city'),state:str(row,'primary_address_state'),postalCode:str(row,'primary_address_postal_code'),country:str(row,'primary_address_country'),description:str(row,'description'),emailOptOut:row.email_opt_out===true,pipelineUser:row.pipeline_user===true}}
async function stageFieldsUnsafe(client:PoolClient,ctx:Context,entity:GatewayEntity,row:Row|undefined,parent:Row,fields:GatewayFields,actor:unknown,createKey?:string){
 const meta={...gatewayObject(row?.source_payload??{}),fractionalGateway:{credentialId:ctx.principal.credentialId,assertedActor:actor}}
 if(entity==='company'){
 const base=row?originalCompany(row):{name:fields.companyName!,parentOrganizationId:str(parent,'id'),relationshipType:'customer' as const}
 const map:Record<string,keyof StageOrganizationInput['fields']>={companyName:'name',website:'website',email:'email',phone:'phone',city:'city',region:'state',postalCode:'postalCode',countryCode:'country'}
 for(const [key,target] of Object.entries(map))if(Object.hasOwn(fields,key))Object.assign(base,{[target]:fields[key]??''})
 if(Object.hasOwn(fields,'addressLine1')||Object.hasOwn(fields,'addressLine2')){
 const current=mapGatewayFields('company',row??{});if(row&&current.unavailableFields.includes('addressLine1')&&!(Object.hasOwn(fields,'addressLine1')&&Object.hasOwn(fields,'addressLine2')))fail(409,'ADDRESS_SHAPE_CONFLICT')
 base.address=[Object.hasOwn(fields,'addressLine1')?fields.addressLine1:current.fields.addressLine1,Object.hasOwn(fields,'addressLine2')?fields.addressLine2:current.fields.addressLine2].filter(v=>v!==null&&v!==undefined).join('\n')}
 return stageCrmRecordWithClient(client,{entity:'organizations',pipelineId:ctx.principal.pipelineId,localId:row?str(row,'id'):undefined,sourceKey:row?str(row,'source_key'):createKey!,actorEmail:ctx.actorEmail,
 sourcePayload:meta,fields:base,...(!row?{createOnly:true,identityKeyOverride:createKey}: {})})
 }
 const base=row?originalContact(row,parent):{organizationId:str(parent,'id'),organizationSuiteCrmId:str(parent,'suitecrm_id'),fullName:fields.displayName!}
 if(row&&Object.hasOwn(fields,'displayName')&&fields.displayName!==row.full_name&&(row.first_name||row.last_name))fail(409,'CONTACT_NAME_SHAPE_CONFLICT')
 const map={displayName:'fullName',email:'email',phone:'phoneWork',jobTitle:'jobTitle'} as const
 for(const [key,target] of Object.entries(map))if(Object.hasOwn(fields,key))Object.assign(base,{[target]:fields[key]??''})
 return stageCrmRecordWithClient(client,{entity:'contacts',pipelineId:ctx.principal.pipelineId,localId:row?str(row,'id'):undefined,sourceKey:row?str(row,'source_key'):createKey!,actorEmail:ctx.actorEmail,sourcePayload:meta,fields:base,preserveOwner:Boolean(row),...(!row?{createOnly:true}:{})})
}
async function stageFields(...args:Parameters<typeof stageFieldsUnsafe>){try{return await stageFieldsUnsafe(...args)}catch(error){
 if((error as {code?:string}).code==='23505'||error instanceof Error&&/identity already exists|aliases resolve|alias conflicts|alias belongs/u.test(error.message))fail(409,'IDENTITY_CONFLICT');throw error}}
async function update(p:FractionalCrmPrincipal,entity:GatewayEntity,ga:string,gc:string|undefined,input:WriteInput){return withTransaction(async client=>{
 const ctx=await context(client,p,entity==='company'?'crm.company.write':'crm.contact.write',true),fields=parse(()=>parseGatewayFields(entity,input.fields,true)),actor=parse(()=>gatewayObject(input.assertedFractionalActor))
 parse(()=>exactKeys(actor,['userId','organizationId','customerId']));if(actor.organizationId!==p.fractionalOrganizationId||Object.values(actor).some(v=>typeof v!=='string'||!v||v.length>200||/[\u0000-\u001f\u007f]/u.test(v)))fail(422,'INVALID_ACTOR')
 // Fresh authorization and parent binding precede even a historical receipt replay.
 const parent=await companyRow(client,ctx,ga,true),row=entity==='company'?parent:await contactRow(client,ctx,parent,gc!,true),before=envelope(ctx,entity,row,parent,gc??ga)
 if(before.resolution.status!=='exact')fail(409,'IDENTITY_CONFLICT');if(!before.canPush)fail(403,'CAPABILITY_DENIED')
 return operation(client,ctx,input.idempotencyKey,`update-${entity}`,{ga,gc:gc??null,ifMatch:input.ifMatch,fields,actor},async()=>{
 if(input.ifMatch!==before.version)fail(412,'VERSION_CONFLICT')
 if(!Object.keys(fields).length)return before
 if(entity==='contact'&&Object.hasOwn(fields,'email')&&normalizedEmail(fields.email)&&normalizedEmail(fields.email)!==normalizedEmail(row.email)){
 const exists=await client.query(`WITH RECURSIVE tree AS (SELECT id,ARRAY[id] AS seen,COALESCE(lower(source_payload->>'archived'),'false') NOT IN ('true','1','yes') AS active_path FROM crm_organizations WHERE pipeline_id=$1 AND id=$4
 UNION ALL SELECT c.id,t.seen||c.id,COALESCE(lower(c.source_payload->>'archived'),'false') NOT IN ('true','1','yes') FROM crm_organizations c JOIN tree t ON c.parent_organization_id=t.id WHERE c.pipeline_id=$1 AND NOT c.id=ANY(t.seen) AND cardinality(t.seen)<64 AND t.active_path)
 SELECT 1 FROM crm_contacts c JOIN crm_organizations o ON o.id=c.organization_id JOIN tree ON tree.id=o.id
 WHERE c.pipeline_id=$1 AND c.id<>$2 AND lower(btrim(c.email))=$3 AND o.reference_code=ANY($5::text[]) LIMIT 1`,[p.pipelineId,row.id,normalizedEmail(fields.email),ctx.root.id,ctx.principal.allowedCompanyGlobalIds]);if(exists.rowCount)fail(409,'CONTACT_RELATIONSHIP_REVIEW')}
 const staged=await stageFields(client,ctx,entity,row,parent,fields,actor)
 const afterRow=entity==='company'?await companyRow(client,ctx,staged.referenceCode,true):await contactRow(client,ctx,parent,staged.referenceCode,true),after=envelope(ctx,entity,afterRow,entity==='company'?afterRow:parent,gc??ga)
 if(after.recordId!==before.recordId||after.globalId!==before.globalId||Object.entries(fields).some(([key,value])=>after.unavailableFields.includes(key)||after.fields[key]!==value))fail(409,'CANONICAL_WRITE_MISMATCH')
 return after
 })
 })}
export const updateFractionalCrmCompany=(p:FractionalCrmPrincipal,ga:string,input:WriteInput)=>update(p,'company',ga,undefined,input)
export const updateFractionalCrmContact=(p:FractionalCrmPrincipal,ga:string,gc:string,input:WriteInput)=>update(p,'contact',ga,gc,input)

type OnboardingInput={schemaVersion:1;sourceInstanceId:string;origin:{deploymentId:string;organizationId:string;customerId:string;contactId?:string;onboardingId:string};
 company:{globalId:string|null;verifiedIdentifiers:{scheme:string;value:string;evidenceId:string}[];fields:GatewayFields};contact?:{globalId:string|null;fields:GatewayFields};
 allowCreate:{company:boolean;contact:boolean};reviewDecisionToken:string|null;actor:{fractionalUserId:string}}
function onboardingInput(value:unknown,p:FractionalCrmPrincipal):OnboardingInput{return parse(()=>{
 const input=gatewayObject(value);exactKeys(input,['schemaVersion','sourceInstanceId','origin','company','contact','allowCreate','reviewDecisionToken','actor'])
 const origin=gatewayObject(input.origin),company=gatewayObject(input.company),contact=input.contact===undefined?undefined:gatewayObject(input.contact),allow=gatewayObject(input.allowCreate),actor=gatewayObject(input.actor)
 exactKeys(origin,['deploymentId','organizationId','customerId','contactId','onboardingId']);exactKeys(company,['globalId','verifiedIdentifiers','fields']);if(contact)exactKeys(contact,['globalId','fields']);exactKeys(allow,['company','contact']);exactKeys(actor,['fractionalUserId'])
 const validText=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\u0000-\u001f\u007f]/u.test(v)
 if(input.schemaVersion!==1||input.sourceInstanceId!==p.sourceInstanceId||origin.deploymentId!==p.fractionalDeploymentId||origin.organizationId!==p.fractionalOrganizationId||!validText(origin.customerId)||!gatewayUuid(origin.onboardingId)||!validText(actor.fractionalUserId)||
 (contact?!gatewayUuid(origin.contactId):origin.contactId!==undefined)||typeof allow.company!=='boolean'||typeof allow.contact!=='boolean'||
 (company.globalId!==null&&!gatewayGlobalId(company.globalId,'company'))||(contact&&contact.globalId!==null&&!gatewayGlobalId(contact.globalId,'contact'))||
 !Array.isArray(company.verifiedIdentifiers)||company.verifiedIdentifiers.length>10||
 (input.reviewDecisionToken!==null&&(typeof input.reviewDecisionToken!=='string'||!/^[A-Za-z0-9_-]{43,256}$/u.test(input.reviewDecisionToken))))throw new Error('INVALID_FIELDS')
 const identifiers=company.verifiedIdentifiers.map(raw=>{const item=gatewayObject(raw);exactKeys(item,['scheme','value','evidenceId']);if(!validText(item.scheme)||!validText(item.value)||!gatewayUuid(item.evidenceId))throw new Error('INVALID_FIELDS');return item as OnboardingInput['company']['verifiedIdentifiers'][number]})
 return {schemaVersion:1,sourceInstanceId:p.sourceInstanceId,origin:origin as OnboardingInput['origin'],company:{globalId:company.globalId as string|null,verifiedIdentifiers:identifiers,fields:parseGatewayFields('company',company.fields)},
 ...(contact?{contact:{globalId:contact.globalId as string|null,fields:parseGatewayFields('contact',contact.fields)}}:{}),allowCreate:allow as OnboardingInput['allowCreate'],reviewDecisionToken:input.reviewDecisionToken as string|null,actor:actor as OnboardingInput['actor']}
 })}
async function sourceMapping(client:PoolClient,ctx:Context,input:OnboardingInput,entity:GatewayEntity){return (await client.query(`SELECT * FROM fractional_crm_source_mappings WHERE source_instance_id=$1 AND fractional_deployment_id=$2 AND fractional_organization_id=$3 AND customer_id=$4 AND entity=$5 AND local_id=$6`,
 [ctx.principal.sourceInstanceId,input.origin.deploymentId,input.origin.organizationId,input.origin.customerId,entity,entity==='company'?input.origin.customerId:input.origin.contactId])).rows[0] as Row|undefined}
async function mapSource(client:PoolClient,ctx:Context,input:OnboardingInput,entity:GatewayEntity,row:Row,parent:Row,operationId:string){
 const existing=await sourceMapping(client,ctx,input,entity)
 if(existing){if(existing.record_id!==row.id||existing.global_id!==row.reference_code||existing.company_global_id!==parent.reference_code||existing.pipeline_id!==ctx.principal.pipelineId||existing.workspace_organization_id!==ctx.principal.workspaceOrganizationId||existing.root_company_global_id!==ctx.principal.rootCompanyGlobalId)fail(409,'IDENTITY_CONFLICT');return}
 await client.query(`INSERT INTO fractional_crm_source_mappings(source_instance_id,workspace_organization_id,pipeline_id,root_company_global_id,fractional_deployment_id,fractional_organization_id,customer_id,entity,local_id,global_id,record_id,company_global_id,operation_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[ctx.principal.sourceInstanceId,ctx.principal.workspaceOrganizationId,ctx.principal.pipelineId,ctx.principal.rootCompanyGlobalId,input.origin.deploymentId,input.origin.organizationId,input.origin.customerId,entity,entity==='company'?input.origin.customerId:input.origin.contactId,row.reference_code,row.id,parent.reference_code,operationId])
}
function websiteHost(value:unknown){try{return new URL(String(value)).hostname.toLowerCase().replace(/^www\./u,'')}catch{return ''}}
/** Resolves both records before staging either. No user account or invitation is created. */
export async function resolveOrCreateFractionalCrmOnboarding(p:FractionalCrmPrincipal,value:unknown,idempotencyKey:string){return withTransaction(async client=>{
 const ctx=await context(client,p,'crm.onboarding.write',true,true),input=onboardingInput(value,ctx.principal)
 // The table lock covers non-gateway writers too, rather than relying on a
 // gateway-only advisory convention that an existing CSV import would bypass.
 return operation(client,ctx,idempotencyKey,'onboarding',input,async operationId=>{
 const base={schemaVersion:1,sourceInstanceId:p.sourceInstanceId,scope:scope(ctx),origin:input.origin,operationId,replayed:false}
 const allCompanies=(await client.query(`WITH RECURSIVE tree AS (SELECT id,ARRAY[id] AS seen,COALESCE(lower(source_payload->>'archived'),'false') NOT IN ('true','1','yes') AS active_path FROM crm_organizations WHERE pipeline_id=$1 AND id=$2
  UNION ALL SELECT c.id,t.seen||c.id,COALESCE(lower(c.source_payload->>'archived'),'false') NOT IN ('true','1','yes') FROM crm_organizations c JOIN tree t ON c.parent_organization_id=t.id WHERE c.pipeline_id=$1 AND NOT c.id=ANY(t.seen) AND cardinality(t.seen)<64 AND t.active_path)
  SELECT c.* FROM crm_organizations c JOIN tree ON tree.id=c.id WHERE c.pipeline_id=$1 AND c.reference_code=ANY($3::text[]) AND c.id<>$2 ORDER BY c.id LIMIT 1001`,[p.pipelineId,ctx.root.id,ctx.principal.allowedCompanyGlobalIds])).rows
 if(allCompanies.length>1000)fail(409,'DISCOVERY_LIMIT')
 const allContacts=(await client.query('SELECT * FROM crm_contacts WHERE pipeline_id=$1 AND organization_id=ANY($2::uuid[]) ORDER BY id LIMIT 10001',[p.pipelineId,allCompanies.map(r=>r.id)])).rows
 if(allContacts.length>10000)fail(409,'DISCOVERY_LIMIT')
 const candidateHash=canonicalHash({companies:allCompanies.map(r=>[r.id,r.reference_code,r.updated_at,r.source_hash,r.source_payload]),contacts:allContacts.map(r=>[r.id,r.reference_code,r.organization_id,r.updated_at,r.source_hash,r.source_payload])})
 const label=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value)?value:null
 const review=(code:string,candidates:Row[]=[],entity:GatewayEntity='company')=>({...base,status:'review_required',reasonCodes:[code],candidates:candidates.filter(active).map(r=>{
 const parent=entity==='company'?r:allCompanies.find(c=>c.id===r.organization_id)!,fields=mapGatewayFields(entity,r).fields
 return {entity,globalId:r.reference_code,recordId:r.id,companyGlobalId:parent.reference_code,version:gatewayVersion(scope(ctx),p.sourceInstanceId,entity,r,parent),
  displayName:label(fields[entity==='company'?'companyName':'displayName'],160),email:label(fields.email,254),companyName:label(mapGatewayFields('company',parent).fields.companyName,120)}
 })})
 const mappedCompany=await sourceMapping(client,ctx,input,'company'),mappedContact=input.contact?await sourceMapping(client,ctx,input,'contact'):undefined
 for(const mapping of [mappedCompany,mappedContact])if(mapping&&(mapping.pipeline_id!==p.pipelineId||mapping.workspace_organization_id!==p.workspaceOrganizationId||mapping.root_company_global_id!==p.rootCompanyGlobalId))return review('IDENTITY_CONFLICT')
 let chosenCompany:Row|undefined,companyMatchedBy='none'
 if(mappedCompany){chosenCompany=allCompanies.find(r=>r.id===mappedCompany.record_id&&r.reference_code===mappedCompany.global_id);if(!chosenCompany)return review('IDENTITY_CONFLICT');companyMatchedBy='source_mapping'}
 if(input.company.globalId){const requested=await canonical(client,input.company.globalId,'company'),found=allCompanies.find(r=>r.reference_code===requested);if(!found)fail(404,'RECORD_NOT_FOUND');if(chosenCompany&&chosenCompany.id!==found.id)return review('IDENTITY_CONFLICT');chosenCompany=found;companyMatchedBy=mappedCompany?'source_mapping':'explicit_id'}
 for(const verified of input.company.verifiedIdentifiers){const proof=(await client.query(`SELECT company_id FROM fractional_crm_verified_identifiers WHERE evidence_id=$1 AND source_instance_id=$2 AND workspace_organization_id=$3 AND pipeline_id=$4 AND scheme=$5 AND value=$6 AND revoked_at IS NULL FOR SHARE`,[verified.evidenceId,p.sourceInstanceId,p.workspaceOrganizationId,p.pipelineId,verified.scheme,verified.value])).rows[0]
 if(!proof)return review('IDENTIFIER_UNVERIFIED');const found=allCompanies.find(r=>r.id===proof.company_id);if(!found)fail(404,'RECORD_NOT_FOUND');if(chosenCompany&&chosenCompany.id!==found.id)return review('IDENTITY_CONFLICT');chosenCompany=found;companyMatchedBy=companyMatchedBy==='none'?'verified_identifier':companyMatchedBy}
 let decision:Row|undefined
 if(input.reviewDecisionToken){decision=(await client.query(`SELECT d.* FROM fractional_crm_review_decisions d JOIN app_user_organization_memberships m ON m.user_email=d.approved_by AND m.organization_id=$3 AND m.status='active' AND m.role IN ('owner','admin')
 JOIN app_users u ON u.email=m.user_email AND u.status='active' WHERE d.token_hash=$1 AND d.credential_id=$2 AND d.expires_at>now()`,[canonicalHash({token:input.reviewDecisionToken}),p.credentialId,p.workspaceOrganizationId])).rows[0]
 if(!decision||decision.request_hash!==canonicalHash({...input,reviewDecisionToken:null})||decision.candidate_hash!==candidateHash)return review('REVIEW_STALE')
 if(decision.company_global_id){const found=allCompanies.find(r=>r.reference_code===decision!.company_global_id);if(!found||chosenCompany&&chosenCompany.id!==found.id)return review('REVIEW_STALE');chosenCompany=found;companyMatchedBy='review_decision'}}
 if(chosenCompany&&!active(chosenCompany))return review('RETIRED_IDENTITY')
 if(!chosenCompany){const name=normalizedName(input.company.fields.companyName),host=websiteHost(input.company.fields.website);const weak=allCompanies.filter(r=>normalizedName(r.name)===name||(host&&websiteHost(r.website)===host))
 if(weak.some(r=>!active(r)))return review('RETIRED_IDENTITY');if(weak.length&&!decision?.allow_distinct_company)return review('COMPANY_CANDIDATES',weak)
 if(!input.allowCreate.company)return {...base,status:'not_found',reasonCodes:['COMPANY_NOT_FOUND']}
 }
 let chosenContact:Row|undefined,contactMatchedBy='none'
 if(input.contact){
 if(mappedContact){chosenContact=allContacts.find(r=>r.id===mappedContact.record_id&&r.reference_code===mappedContact.global_id);if(!chosenContact||!chosenCompany||chosenContact.organization_id!==chosenCompany.id)return review('IDENTITY_CONFLICT');contactMatchedBy='source_mapping'}
 if(input.contact.globalId){const requested=await canonical(client,input.contact.globalId,'contact'),found=allContacts.find(r=>r.reference_code===requested);if(!found)fail(404,'RECORD_NOT_FOUND');if(!chosenCompany||found.organization_id!==chosenCompany.id||chosenContact&&chosenContact.id!==found.id)return review('CONTACT_RELATIONSHIP_REVIEW');chosenContact=found;contactMatchedBy=mappedContact?'source_mapping':'explicit_id'}
 if(decision?.contact_global_id){const found=allContacts.find(r=>r.reference_code===decision!.contact_global_id);if(!found||!chosenCompany||found.organization_id!==chosenCompany.id||chosenContact&&chosenContact.id!==found.id)return review('REVIEW_STALE');chosenContact=found;contactMatchedBy='review_decision'}
 if(chosenContact&&!active(chosenContact))return review('RETIRED_IDENTITY')
 const email=normalizedEmail(input.contact.fields.email)
 if(chosenContact&&email!==normalizedEmail(chosenContact.email))return review('CONTACT_PROFILE_CONFLICT')
 if(!chosenContact&&!email)return review('CONTACT_EMAIL_REQUIRED')
 const matches=email?allContacts.filter(r=>normalizedEmail(r.email)===email):[]
 if(matches.some(r=>!active(r)))return review('RETIRED_IDENTITY')
 const foreign=matches.filter(r=>r.organization_id!==chosenCompany?.id)
 if(foreign.length)return review('CONTACT_RELATIONSHIP_REVIEW',matches,'contact')
 if(matches.length>1)return review('CONTACT_AMBIGUOUS',matches,'contact')
 if(!chosenContact&&matches.length){chosenContact=matches[0];contactMatchedBy='company_email'}
 // A hidden pipeline-wide identity collision is enforced by the existing
 // unique constraint at create-only staging, without discovering that record.
 if(!chosenContact&&!input.allowCreate.contact)return {...base,status:'not_found',reasonCodes:['CONTACT_NOT_FOUND']}
 }
 const companyCreated=!chosenCompany,contactCreated=Boolean(input.contact&&!chosenContact)
 if(companyCreated){if(ctx.principal.allowedCompanyGlobalIds.length>=1000)fail(409,'DISCOVERY_LIMIT')
 const staged=await stageFields(client,ctx,'company',undefined,ctx.root,input.company.fields,input.actor,`fractional:${p.fractionalDeploymentId}:${input.origin.customerId}`)
 await client.query('UPDATE fractional_crm_gateway_credentials SET allowed_company_global_ids=array_append(allowed_company_global_ids,$2) WHERE id=$1',[p.credentialId,staged.referenceCode]);ctx.principal.allowedCompanyGlobalIds.push(staged.referenceCode)
 chosenCompany=await companyRow(client,ctx,staged.referenceCode,true)
 }
 if(contactCreated){const staged=await stageFields(client,ctx,'contact',undefined,chosenCompany!,input.contact!.fields,input.actor,`fractional:${p.fractionalDeploymentId}:${input.origin.contactId}`);chosenContact=await contactRow(client,ctx,chosenCompany!,staged.referenceCode,true)}
 const companyRecord=envelope(ctx,'company',chosenCompany!,chosenCompany!,input.company.globalId??str(chosenCompany!,'reference_code'))
 if(companyCreated&&Object.entries(input.company.fields).some(([k,v])=>companyRecord.unavailableFields.includes(k)||companyRecord.fields[k]!==v))fail(409,'CANONICAL_WRITE_MISMATCH')
 await mapSource(client,ctx,input,'company',chosenCompany!,chosenCompany!,operationId)
 let contactResult:Row|undefined
 if(input.contact&&chosenContact){const record=envelope(ctx,'contact',chosenContact,chosenCompany!,input.contact.globalId??str(chosenContact,'reference_code'))
 if(contactCreated&&Object.entries(input.contact.fields).some(([k,v])=>record.unavailableFields.includes(k)||record.fields[k]!==v))fail(409,'CANONICAL_WRITE_MISMATCH')
 await mapSource(client,ctx,input,'contact',chosenContact,chosenCompany!,operationId);contactResult={record,outcome:contactCreated?'created':'reused',matchedBy:contactMatchedBy,requestedGlobalId:input.contact.globalId,canonicalGlobalId:chosenContact.reference_code}}
 return {...base,status:companyCreated||contactCreated?'created':'resolved',company:{record:companyRecord,outcome:companyCreated?'created':'reused',matchedBy:companyMatchedBy,requestedGlobalId:input.company.globalId,canonicalGlobalId:chosenCompany!.reference_code},...(contactResult?{contact:contactResult}:{})}
 })
 })}
