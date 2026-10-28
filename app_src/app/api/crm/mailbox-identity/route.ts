import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import { googleSsoClientConfiguration, GoogleSsoError, verifyGoogleIdentityToken } from '@/lib/googleSso'
import { readGmailMailboxProfileForOwner } from '@/lib/crm/emailIngestion'
import { bindVerifiedGmailMailboxInPostgres, readVerifiedGmailMailboxIdentityInPostgres } from '@/lib/persistence/crmEmailIdentity'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query } from '@/lib/persistence/postgres'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { resolvePipelineSpaceAccess } from '@/lib/tenancy'
import { appPublicUrl } from '@/lib/publicUrl'
import { SESSION_POLICY } from '@/lib/authSessions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const response = (body: unknown, status = 200) => NextResponse.json(body, { status,
  headers: { 'Cache-Control': 'private, no-store', Pragma: 'no-cache', Vary: 'Cookie, Origin' } })

async function owner(req: NextRequest, pipelineId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pipelineId)) throw new Error('Exact pipeline required')
  const session = await requestSession(req)
  if (!session?.authenticatedUser || session.impersonating || session.authenticatedUser !== session.effectiveUser) throw new Error('Owner session required')
  const actor = await requireRequestUser(req)
  const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId })
  if (pipeline.id !== pipelineId || actor.email !== session.effectiveUser || pipeline.ownerEmail !== actor.email
    || !actor.organizationId || pipeline.workspaceOrganizationId !== actor.organizationId
    || (session.activeWorkspaceOrganizationId && session.activeWorkspaceOrganizationId !== actor.organizationId)) throw new Error('Owner session required')
  if (!isPostgresStorageEnabled()) throw new Error('Postgres required')
  return { actor, pipeline, session }
}

export async function GET(req: NextRequest) {
  try {
    const { actor } = await owner(req, req.nextUrl.searchParams.get('pipelineId') || '')
    const connections = await query<{ connection_id: string; account_email: string }>(`SELECT connection_id,account_email
      FROM user_maton_connections WHERE owner_email=$1 AND app='google-mail' AND source='maton'
      AND status='ACTIVE' AND is_selected ORDER BY connection_id`, [actor.email])
    const mailboxes = await Promise.all(connections.rows.map(async row => ({ connectionId: row.connection_id,
      accountEmail: row.account_email, verified: Boolean(await readVerifiedGmailMailboxIdentityInPostgres({
        ownerEmail: actor.email, connectionId: row.connection_id, accountEmail: row.account_email })) })))
    return response({ ok: true, clientId: googleSsoClientConfiguration().clientId, mailboxes })
  } catch { return response({ ok: false, error: 'Pipeline owner access is required' }, 403) }
}

export async function POST(req: NextRequest) {
  try {
    if (!isBrowserSameOriginRequest({ headers: req.headers, requestOrigin: req.nextUrl.origin, trustedOrigins: [appPublicUrl()] })) {
      return response({ ok: false, error: 'A same-origin browser request is required' }, 403)
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers.get('content-type') || '') || !req.body) return response({ ok: false }, 415)
    const reader = req.body.getReader(); let size = 0; const chunks: Uint8Array[] = []
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break
        size += part.value.byteLength
        if (size > 12 * 1024) { await reader.cancel(); return response({ ok: false, error: 'Request too large' }, 413) }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).sort().join(',') !== 'connectionId,idToken,pipelineId'
      || typeof body.pipelineId !== 'string' || typeof body.connectionId !== 'string'
      || !/^[\w-]{1,200}$/.test(body.connectionId)) return response({ ok: false, error: 'Invalid identity command' }, 400)
    const { actor, session } = await owner(req, body.pipelineId)
    const age = Date.now() - Date.parse(session.lastAuthenticatedAt)
    if (!Number.isFinite(age) || age < 0 || age > SESSION_POLICY.recentAuthSeconds * 1000) {
      return response({ ok: false, error: 'Sign in again before verifying a mailbox identity' }, 403)
    }
    const identity = await verifyGoogleIdentityToken(body.idToken)
    const profile = await readGmailMailboxProfileForOwner({ ownerEmail: actor.email, connectionId: body.connectionId })
    const result = await bindVerifiedGmailMailboxInPostgres({ ownerEmail: actor.email, connectionId: body.connectionId,
      identity, observedAccountEmail: profile.accountEmail })
    return response({ ok: true, ...result })
  } catch (error) {
    return response({ ok: false, error: error instanceof GoogleSsoError ? error.message : 'Mailbox identity could not be verified' },
      error instanceof GoogleSsoError ? error.status : 409)
  }
}
