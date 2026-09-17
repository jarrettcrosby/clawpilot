import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import { reconcileGmailMessages, SafeEmailIngestionError } from '@/lib/crm/emailIngestion'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { appPublicUrl } from '@/lib/publicUrl'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { resolvePipelineSpaceAccess } from '@/lib/tenancy'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_BYTES = 8 * 1024
const IDENTIFIER = /^[A-Za-z0-9_-]{1,200}$/
const PIPELINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const GMAIL_ID = /^[a-f0-9]{1,128}$/i
const DIGEST = /^[a-f0-9]{64}$/i

class RecoveryCommandError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: {
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Origin',
  } })
}

async function boundedJson(req: NextRequest): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers.get('content-type') || '')) {
    throw new RecoveryCommandError('A JSON recovery command is required', 415)
  }
  const length = req.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
    throw new RecoveryCommandError('Recovery command is too large', 413)
  }
  if (!req.body) throw new RecoveryCommandError('A recovery command is required')
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RecoveryCommandError('Recovery command is too large', 413)
      }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let body: unknown
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new RecoveryCommandError('A valid UTF-8 JSON recovery command is required') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RecoveryCommandError('A JSON recovery object is required')
  }
  return body as Record<string, unknown>
}

export async function POST(req: NextRequest) {
  try {
    if (!isBrowserSameOriginRequest({ headers: req.headers,
      requestOrigin: req.nextUrl.origin, trustedOrigins: [appPublicUrl()] })) {
      throw new RecoveryCommandError('Email recovery requires a same-origin browser request', 403)
    }
    const session = await requestSession(req)
    // This operator action never accepts the local-development authentication fallback.
    if (!session?.authenticatedUser || !session.effectiveUser) {
      throw new RecoveryCommandError('Unauthorized', 401)
    }
    if (session.impersonating || session.authenticatedUser !== session.effectiveUser) {
      throw new RecoveryCommandError('Exit user view before recovering email', 403)
    }
    const actor = await requireRequestUser(req)
    if (!actor.organizationId || actor.email !== session.effectiveUser
      || (session.activeWorkspaceOrganizationId
        && session.activeWorkspaceOrganizationId !== actor.organizationId)) {
      throw new RecoveryCommandError('Email recovery requires the active workspace owner', 403)
    }
    if (!isPostgresStorageEnabled()) {
      throw new RecoveryCommandError('Email recovery requires Postgres storage', 503)
    }
    const body = await boundedJson(req)
    const allowed = ['pipelineId', 'connectionId', 'messageIds', 'apply', 'expectedDigest']
    if (Object.keys(body).some((key) => !allowed.includes(key))
      || typeof body.pipelineId !== 'string' || !PIPELINE_ID.test(body.pipelineId)
      || typeof body.connectionId !== 'string' || !IDENTIFIER.test(body.connectionId)
      || !Array.isArray(body.messageIds) || body.messageIds.length < 1 || body.messageIds.length > 25
      || body.messageIds.some((id) => typeof id !== 'string' || !GMAIL_ID.test(id))
      || (body.apply !== undefined && typeof body.apply !== 'boolean')) {
      throw new RecoveryCommandError('Provide a pipeline, linked mailbox, and 1–25 unique Gmail message IDs')
    }
    const messageIds = (body.messageIds as string[]).map((id) => id.toLowerCase())
    if (new Set(messageIds).size !== messageIds.length) {
      throw new RecoveryCommandError('Gmail message IDs must be unique')
    }
    const apply = body.apply === true
    if ((apply && (typeof body.expectedDigest !== 'string' || !DIGEST.test(body.expectedDigest)))
      || (!apply && Object.hasOwn(body, 'expectedDigest'))) {
      throw new RecoveryCommandError('Apply requires the digest from the reviewed dry run')
    }
    const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId: body.pipelineId })
      .catch(() => { throw new RecoveryCommandError('Pipeline owner access is required', 403) })
    if (pipeline.id !== body.pipelineId || pipeline.ownerEmail !== actor.email
      || pipeline.workspaceOrganizationId !== actor.organizationId) {
      throw new RecoveryCommandError('Pipeline owner access is required in the active workspace', 403)
    }
    const recovery = await reconcileGmailMessages({
      ownerEmail: actor.email, connectionId: body.connectionId, pipelineId: pipeline.id,
      messageIds, apply,
      ...(apply ? { expectedDigest: (body.expectedDigest as string).toLowerCase() } : {}),
    })
    return json({ ok: true, recovery })
  } catch (error) {
    if (error instanceof RecoveryCommandError) return json({ ok: false, error: error.message }, error.status)
    if (error instanceof SafeEmailIngestionError) return json({ ok: false, error: error.message }, 409)
    if (error instanceof Error && error.message === 'Unauthorized') return json({ ok: false, error: 'Unauthorized' }, 401)
    return json({ ok: false, error: 'Email recovery is unavailable' }, 500)
  }
}
