import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import { publishExactCrmEmails } from '@/lib/crm/exactEmailPublication'
import { ExactEmailPublicationHeld } from '@/lib/persistence/crmExactEmailPublication'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { appPublicUrl } from '@/lib/publicUrl'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { resolvePipelineSpaceAccess } from '@/lib/tenancy'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
const MAX_BYTES = 8 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/i
const HASH = /^[a-f0-9]{64}(?![\s\S])/i
const GMAIL_ID = /^[a-f0-9]{1,128}(?![\s\S])/i
class CommandError extends Error {
  constructor(message:string,readonly status=400) {super(message)}
}
function json(payload:Record<string,unknown>,status=200) {
  return NextResponse.json(payload,{status,headers:{'Cache-Control':'private, no-store, max-age=0',
    Pragma:'no-cache','X-Content-Type-Options':'nosniff',Vary:'Cookie, Origin'}})
}
async function boundedJson(req:NextRequest):Promise<Record<string,unknown>> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers.get('content-type') || '')) {
    throw new CommandError('A JSON publication command is required',415)
  }
  const length = req.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length)>MAX_BYTES)) {
    throw new CommandError('Publication command is too large',413)
  }
  if (!req.body) throw new CommandError('A publication command is required')
  const reader=req.body.getReader(),chunks:Uint8Array[]=[]
  let size=0
  try {
    while (true) {
      const part=await reader.read()
      if(part.done) break
      size+=part.value.byteLength
      if(size>MAX_BYTES) {
        await reader.cancel().catch(()=>undefined)
        throw new CommandError('Publication command is too large',413)
      }
      chunks.push(part.value)
    }
  } finally {reader.releaseLock()}
  const bytes=new Uint8Array(size)
  let offset=0
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  let value:unknown
  try {value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
  catch {throw new CommandError('A valid UTF-8 JSON publication command is required')}
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new CommandError('A JSON publication object is required')
  return value as Record<string,unknown>
}

export async function POST(req:NextRequest) {
  try {
    if(!isBrowserSameOriginRequest({headers:req.headers,requestOrigin:req.nextUrl.origin,trustedOrigins:[appPublicUrl()]})) {
      throw new CommandError('Email publication requires a same-origin browser request',403)
    }
    const session=await requestSession(req)
    if(!session?.authenticatedUser || !session.effectiveUser) throw new CommandError('Unauthorized',401)
    if(session.impersonating || session.authenticatedUser!==session.effectiveUser) {
      throw new CommandError('Exit user view before publishing email',403)
    }
    const actor=await requireRequestUser(req)
    if(!actor.organizationId || actor.email!==session.effectiveUser
      || session.activeWorkspaceOrganizationId && session.activeWorkspaceOrganizationId!==actor.organizationId) {
      throw new CommandError('Email publication requires the active workspace pipeline owner',403)
    }
    if(!isPostgresStorageEnabled()) throw new CommandError('Email publication requires Postgres storage',503)
    const body=await boundedJson(req),allowed=['pipelineId','connectionId','messageIds','apply','expectedDigest']
    if(Object.keys(body).some(key=>!allowed.includes(key))
      || typeof body.pipelineId!=='string' || !UUID.test(body.pipelineId)
      || typeof body.connectionId!=='string' || !/^[A-Za-z0-9_-]{1,200}(?![\s\S])/.test(body.connectionId)
      || !Array.isArray(body.messageIds) || body.messageIds.length<1 || body.messageIds.length>25
      || body.messageIds.some(id=>typeof id!=='string' || !GMAIL_ID.test(id))
      || body.apply!==undefined && typeof body.apply!=='boolean') {
      throw new CommandError('Provide a pipeline, linked mailbox, and 1–25 unique Gmail message IDs')
    }
    const messageIds=(body.messageIds as string[]).map(id=>id.toLowerCase())
    if(new Set(messageIds).size!==messageIds.length) throw new CommandError('Gmail message IDs must be unique')
    const apply=body.apply===true
    if(apply && (typeof body.expectedDigest!=='string' || !HASH.test(body.expectedDigest))
      || !apply && Object.hasOwn(body,'expectedDigest')) {
      throw new CommandError('Apply requires the digest from the reviewed publication preview')
    }
    if(apply && process.env.CLAWPILOT_CRM_SYNC_MAINTENANCE==='1') {
      throw new CommandError('CRM sync is temporarily paused for maintenance',503)
    }
    const pipeline=await resolvePipelineSpaceAccess({actorEmail:actor,pipelineId:body.pipelineId})
      .catch(()=>{throw new CommandError('Pipeline owner access is required',403)})
    if(pipeline.id!==body.pipelineId.toLowerCase() || pipeline.ownerEmail!==actor.email
      || pipeline.workspaceOrganizationId!==actor.organizationId) {
      throw new CommandError('Pipeline owner access is required in the active workspace',403)
    }
    const publication=await publishExactCrmEmails({ownerEmail:actor.email,workspaceId:actor.organizationId,
      pipelineId:pipeline.id,connectionId:body.connectionId,messageIds,apply,
      ...(apply?{expectedDigest:(body.expectedDigest as string).toLowerCase()}:{})})
    return json({ok:true,publication})
  } catch(error) {
    if(error instanceof CommandError) return json({ok:false,error:error.message},error.status)
    if(error instanceof ExactEmailPublicationHeld) return json({ok:false,error:error.message},409)
    if(error instanceof Error && error.message==='Unauthorized') return json({ok:false,error:'Unauthorized'},401)
    return json({ok:false,error:'Email publication is unavailable'},500)
  }
}
