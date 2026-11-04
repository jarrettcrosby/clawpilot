import { NextRequest, NextResponse } from 'next/server'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { resolvePipelineSpaceAccess, requireResourceEditor } from '@/lib/tenancy'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import { readCustomerFolderControls } from '@/lib/persistence/crmCustomerFolderControls'
import { applyCustomerFolderCommand } from '@/lib/crm/customerFolderControlService'
import { customerFolderUuid, parseCustomerFolderCommand, CustomerFolderCommandError } from '@/lib/crm/customerFolderControls'
import { CustomerFolderHeldError } from '@/lib/crm/customerDriveFolders'

export const runtime='nodejs'
export const dynamic='force-dynamic'
export const revalidate=0
const json=(body:Record<string,unknown>,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}})
function errorResponse(error:unknown) {
  if(error instanceof CustomerFolderCommandError)return json({ok:false,error:'Check the folder command and use a Google Drive folder URL.',code:error.code},400)
  if(error instanceof CustomerFolderHeldError)return json({ok:false,error:'Folder work could not proceed. Refresh its status and review the setup.',code:error.code},
    ['customer_folder_access_denied','customer_folder_admin_required','customer_folder_customer_editor_required'].includes(error.code)?403:409)
  if(error instanceof Error&&error.message==='Unauthorized')return json({ok:false,error:'Unauthorized'},401)
  if(error instanceof Error&&['Pipeline access denied','This resource is view-only'].includes(error.message))return json({ok:false,error:'CRM access is required.'},403)
  if(error&&typeof error==='object'&&'status' in error&&error.status===403)return json({ok:false,error:'CRM access is required.'},403)
  return json({ok:false,error:'Customer folder controls are unavailable. No success has been confirmed.'},500)
}
async function context(req:NextRequest,pipelineId:string,write=false) {
  if(!isPostgresStorageEnabled())throw new CustomerFolderHeldError('customer_folder_postgres_required')
  if(write){const session=await requestSession(req)
    if(session?.impersonating||session&&session.authenticatedUser!==session.effectiveUser) {
      throw new CustomerFolderHeldError('customer_folder_exit_user_view')
    }}
  const actor=await requireRequestUser(req)
  // Never silently substitute a default/cookie pipeline for a rejected ID.
  const pipeline=await resolvePipelineSpaceAccess({actorEmail:actor,pipelineId})
  if(write)requireResourceEditor(pipeline)
  return actor
}
export async function GET(req:NextRequest) {
  try {
    const url=new URL(req.url),pipelineId=customerFolderUuid(url.searchParams.get('pipelineId')),
      accountId=customerFolderUuid(url.searchParams.get('accountId')),actor=await context(req,pipelineId)
    const state=await readCustomerFolderControls({pipelineId,accountId,actorEmail:actor.email})
    return json({ok:true,state})
  }catch(error){return errorResponse(error)}
}
export async function POST(req:NextRequest) {
  try {
    if(!isBrowserSameOriginRequest({headers:req.headers,requestOrigin:new URL(req.url).origin}))return json({ok:false,error:'Same-origin request required.'},403)
    const declared=Number(req.headers.get('content-length')||0)
    if(!Number.isFinite(declared)||declared<0||declared>8192)return json({ok:false,error:'Request is too large.'},413)
    // Enforce the bound while streaming, not after req.text() has buffered an
    // unbounded chunked body in the long-lived Railway process.
    const chunks:Uint8Array[]=[]
    let bytes=0
    const reader=req.body?.getReader()
    if(reader)try{
      while(true){const {done,value}=await reader.read();if(done)break
        bytes+=value.byteLength
        if(bytes>8192){await reader.cancel();return json({ok:false,error:'Request is too large.'},413)}
        chunks.push(value)
      }
    }finally{reader.releaseLock()}
    let body:unknown
    try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))}catch{throw new CustomerFolderCommandError()}
    const command=parseCustomerFolderCommand(body),actor=await context(req,command.pipelineId,true)
    return json({ok:true,state:await applyCustomerFolderCommand(command,actor.email)})
  }catch(error){return errorResponse(error)}
}
