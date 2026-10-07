import crypto from 'node:crypto'

export type GatewayEntity = 'company' | 'contact'
export const companyKeys = ['companyName','website','email','phone','addressLine1','addressLine2','city','region','postalCode','countryCode'] as const
export const contactKeys = ['displayName','email','phone','jobTitle'] as const
export type GatewayFields = Record<string, string | null>
export type GatewayScope = { workspaceOrganizationId: string; pipelineId: string; rootCompanyGlobalId: string }
export type GatewayRecord = {
 schemaVersion:1;sourceInstanceId:string;scope:GatewayScope;entity:GatewayEntity;recordId:string;globalId:string;companyGlobalId:string;
 resolution:{requestedGlobalId:string;canonicalGlobalId:string;status:'exact'|'alias'};version:string;status:'active';management:'crm'|'workspace'|'app-user';canPush:boolean;
 fields:GatewayFields;unavailableFields:string[];sourceFields?:{address?:string;country?:string}
}
export function gatewayGlobalId(value:unknown,entity:GatewayEntity):value is string{return typeof value==='string'&&new RegExp(`^g${entity==='company'?'a':'c'}(?:[0-9]{7}|[0-9a-v]{12})$`).test(value)}
export function gatewayUuid(value:unknown):value is string{return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)}
export function canonicalHash(value:unknown):string{
 const stable=(v:unknown):unknown=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,item])=>[k,stable(item)])):v
 return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}
export const normalizedEmail=(value:unknown)=>typeof value==='string'?value.trim().toLowerCase():''
export const normalizedName=(value:unknown)=>typeof value==='string'?value.trim().toLowerCase().replace(/\s+/gu,' '):''
export function gatewayObject(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_FIELDS');return value as Record<string,unknown>}
export function exactKeys(value:Record<string,unknown>,keys:readonly string[]){if(Object.keys(value).some(k=>!keys.includes(k)))throw new Error('INVALID_FIELDS')}
export function parseGatewayFields(entity:GatewayEntity,value:unknown,partial=false):GatewayFields{
 const input=gatewayObject(value),keys=entity==='company'?companyKeys:contactKeys;exactKeys(input,keys)
 if(!partial&&keys.some(k=>!Object.hasOwn(input,k)))throw new Error('INVALID_FIELDS')
 const lengths:Record<string,number>={companyName:120,displayName:160,website:2000,email:254,phone:80,addressLine1:200,addressLine2:200,city:120,region:120,postalCode:40,countryCode:2,jobTitle:160}
 for(const [key,v] of Object.entries(input)){
 if(v===null){if(key==='companyName'||key==='displayName')throw new Error('INVALID_FIELDS');continue}
 if(typeof v!=='string'||v!==v.trim()||!v||v.length>lengths[key]||/[\u0000-\u001f\u007f]/u.test(v))throw new Error('INVALID_FIELDS')
 if(key==='email'&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)||normalizedEmail(v)!==v))throw new Error('INVALID_FIELDS')
 if(key==='countryCode'&&!/^[A-Z]{2}$/.test(v))throw new Error('INVALID_FIELDS')
 if(key==='website'){const url=new URL(v);if(url.protocol!=='https:'||url.username||url.password)throw new Error('INVALID_FIELDS')}
 }
 return input as GatewayFields
}
export function mapGatewayFields(entity:GatewayEntity,row:Record<string,unknown>):{fields:GatewayFields;unavailableFields:string[];sourceFields?:{address?:string;country?:string}}{
 const text=(key:string)=>row[key]===null||row[key]===undefined||row[key]===''?null:String(row[key])
 if(entity==='contact')return {fields:{displayName:text('full_name'),email:text('email'),phone:text('phone_work'),jobTitle:text('job_title')},unavailableFields:[]}
 const fields:GatewayFields={companyName:text('name'),website:text('website'),email:text('email'),phone:text('phone'),addressLine1:null,addressLine2:null,city:text('billing_address_city'),region:text('billing_address_state'),postalCode:text('billing_address_postal_code'),countryCode:null}
 const unavailableFields:string[]=[],sourceFields:{address?:string;country?:string}={};const address=text('billing_address_street'),country=text('billing_address_country')
 if(address){const lines=address.split('\n');if(lines.length<=2&&lines.every(line=>line.length<=200&&!/[\r\u0000-\u001f\u007f]/u.test(line)&&line===line.trim()&&line.length>0)){
 fields.addressLine1=lines[0];fields.addressLine2=lines[1]??null
 }else{unavailableFields.push('addressLine1','addressLine2');sourceFields.address=address}}
 if(country){if(/^[A-Z]{2}$/.test(country))fields.countryCode=country;else{unavailableFields.push('countryCode');sourceFields.country=country}}
 return {fields,unavailableFields,...(Object.keys(sourceFields).length?{sourceFields}:{})}
}
export function gatewayVersion(scope:GatewayScope,sourceInstanceId:string,entity:GatewayEntity,row:Record<string,unknown>,parent:Record<string,unknown>):string{
 return canonicalHash({schemaVersion:1,scope,sourceInstanceId,entity,recordId:row.id,globalId:row.reference_code,parentId:parent.id,parentGlobalId:parent.reference_code,
 rowUpdatedAt:row.updated_at,sourceHash:row.source_hash,archived:gatewayObject(row.source_payload??{}).archived??false,
 management:{workspace:row.workspace_organization_id??null,appUser:row.app_user_email??null,pipelineUser:row.pipeline_user??false},fields:mapGatewayFields(entity,row)})
}
