import { NextRequest, NextResponse } from 'next/server'
import { requireRequestUser, requestSession } from '@/lib/requestUser'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import { RootCrmSettingsError } from '@/lib/crm/rootEmployeeCrmSettings'
import { NativeEmailAccessPendingError } from '@/lib/crm/nativeEmailAuthorityRuntime'
import { readRootEmployeeCrmSettings, changeRootEmployeeCrmSettings } from '@/lib/persistence/crmRootEmployeeSettings'

export const runtime='nodejs'
export const dynamic='force-dynamic'
export const revalidate=0
const json=(value:Record<string,unknown>,status=200)=>NextResponse.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})
function errorResponse(error:unknown){
  if(error instanceof RootCrmSettingsError)return json({ok:false,error:error.message,code:error.code},error.status)
  if(error instanceof NativeEmailAccessPendingError)return json({ok:false,error:error.message,code:error.code,transitionId:error.transitionId},409)
  if(error instanceof Error&&error.message==='Unauthorized')return json({ok:false,error:'Unauthorized'},401)
  if(error&&typeof error==='object'&&'status' in error&&error.status===403)return json({ok:false,error:'Owner access is required.'},403)
  return json({ok:false,error:'CRM access settings could not be confirmed. Reload before trying again.'},500)
}
async function context(req:NextRequest){
  const session=await requestSession(req)
  if(session&&(session.impersonating||session.authenticatedUser!==session.effectiveUser))throw new RootCrmSettingsError('Exit user view before managing CRM access.',403)
  const actor=await requireRequestUser(req)
  if(!actor.organizationId)throw new RootCrmSettingsError('Select the organization whose CRM scope you manage.',403)
  return {email:actor.email,workspaceId:actor.organizationId}
}
async function boundedBody(req:NextRequest){
  if((req.headers.get('content-type')||'').split(';')[0].trim()!=='application/json')throw new RootCrmSettingsError('JSON is required.',415)
  const size=Number(req.headers.get('content-length')||0)
  if(!Number.isFinite(size)||size<0||size>8192)throw new RootCrmSettingsError('Request is too large.',413)
  const chunks:Uint8Array[]=[];let length=0
  const reader=req.body?.getReader()
  if(reader)try{
    for(;;){const result=await reader.read();if(result.done)break;length+=result.value.byteLength
      if(length>8192){await reader.cancel();throw new RootCrmSettingsError('Request is too large.',413)}chunks.push(result.value)}
  }finally{reader.releaseLock()}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))}catch{throw new RootCrmSettingsError('Check the request.',400)}
}
export async function GET(req:NextRequest){
  try{const actor=await context(req);return json({ok:true,settings:await readRootEmployeeCrmSettings(actor.email,actor.workspaceId)})}
  catch(error){return errorResponse(error)}
}
export async function POST(req:NextRequest){
  if (process.env.CLAWPILOT_CRM_SYNC_MAINTENANCE === '1') {
    return NextResponse.json({ ok: false, error: 'CRM sync is temporarily paused for maintenance' }, {
      status: 503, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '60' },
    })
  }
  try{
    if(!isBrowserSameOriginRequest({headers:req.headers,requestOrigin:req.nextUrl.origin}))return json({ok:false,error:'Same-origin request required.'},403)
    const actor=await context(req),body=await boundedBody(req)
    await changeRootEmployeeCrmSettings(actor.email,actor.workspaceId,body)
    return json({ok:true,settings:await readRootEmployeeCrmSettings(actor.email,actor.workspaceId)})
  }catch(error){return errorResponse(error)}
}
