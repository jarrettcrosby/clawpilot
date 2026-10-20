import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import {
  CalendarDiscoveryConfigurationError,
  configureCalendarDiscoverySource,
  listCalendarDiscoverySources,
} from '@/lib/crm/calendarDiscoveryPersistence'
import { getOrganizationCommunicationState } from '@/lib/integrations/organizationCommunications'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { appPublicUrl } from '@/lib/publicUrl'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { resolvePipelineSpaceAccess } from '@/lib/tenancy'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: {
    'Cache-Control': 'private, no-store', Vary: 'Cookie, Origin', 'X-Content-Type-Options': 'nosniff',
  } })
}

async function scope(req: NextRequest, pipelineId: unknown) {
  const session = await requestSession(req)
  if (!session?.authenticatedUser || session.impersonating || session.authenticatedUser !== session.effectiveUser) {
    throw new CalendarDiscoveryConfigurationError('Sign in as yourself to manage calendar imports', 401)
  }
  const actor = await requireRequestUser(req)
  if (actor.email !== session.effectiveUser || !actor.organizationId
    || (session.activeWorkspaceOrganizationId && session.activeWorkspaceOrganizationId !== actor.organizationId)) {
    throw new CalendarDiscoveryConfigurationError('Calendar imports require your active signed-in organization', 403)
  }
  if (!isPostgresStorageEnabled()) throw new CalendarDiscoveryConfigurationError('Calendar imports require Postgres', 503)
  if (typeof pipelineId !== 'string' || !UUID.test(pipelineId)) {
    throw new CalendarDiscoveryConfigurationError('Select a pipeline', 400)
  }
  const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId })
  if (pipeline.id !== pipelineId || pipeline.ownerEmail !== actor.email
    || pipeline.workspaceOrganizationId !== actor.organizationId) {
    throw new CalendarDiscoveryConfigurationError('Only the active organization pipeline owner can manage calendar imports', 403)
  }
  return { pipelineId, actorEmail: actor.email, organizationId: actor.organizationId! }
}

function failure(error: unknown) {
  if (error instanceof CalendarDiscoveryConfigurationError) return json({ ok: false, error: error.message }, error.status)
  if (error instanceof Error && error.message === 'Unauthorized') return json({ ok: false, error: 'Unauthorized' }, 401)
  return json({ ok: false, error: 'Calendar imports are unavailable. Check the selected organization and calendar connection.' }, 409)
}

export async function GET(req: NextRequest) {
  try {
    const input = await scope(req, req.nextUrl.searchParams.get('pipelineId'))
    const sources = await listCalendarDiscoverySources(input)
    const state = await getOrganizationCommunicationState(input)
    return json({ ok: true, sources, connections: state.availableConnections.filter((row) => row.app === 'google-calendar') })
  } catch (error) { return failure(error) }
}

export async function PUT(req: NextRequest) {
  try {
    if (!isBrowserSameOriginRequest({ headers: req.headers, requestOrigin: req.nextUrl.origin, trustedOrigins: [appPublicUrl()] })) {
      throw new CalendarDiscoveryConfigurationError('Calendar imports require a same-origin browser request', 403)
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers.get('content-type') || '')) {
      throw new CalendarDiscoveryConfigurationError('A JSON calendar import command is required', 415)
    }
    const reader = req.body?.getReader()
    if (!reader) throw new CalendarDiscoveryConfigurationError('A calendar import command is required', 400)
    const parts: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 8192) {
          await reader.cancel()
          throw new CalendarDiscoveryConfigurationError('Calendar import command is too large', 413)
        }
        parts.push(part.value)
      }
    } finally { reader.releaseLock() }
    let body: Record<string, unknown>
    try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) }
    catch { throw new CalendarDiscoveryConfigurationError('A valid calendar import command is required', 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['pipelineId', 'connectionId', 'calendarId', 'enabled'].includes(key))
      || typeof body.enabled !== 'boolean' || typeof body.connectionId !== 'string'
      || !/^[\x21-\x7e]{1,512}$/.test(body.connectionId) || typeof body.calendarId !== 'string'
      || !/^[\x21-\x7e]{1,1024}$/.test(body.calendarId) || body.calendarId === 'primary') {
      throw new CalendarDiscoveryConfigurationError('Choose a linked account and exact calendar, then enable or pause imports', 400)
    }
    const input = await scope(req, body.pipelineId)
    const sources = await configureCalendarDiscoverySource({ ...input,
      connectionId: body.connectionId, calendarId: body.calendarId, enabled: body.enabled })
    return json({ ok: true, sources })
  } catch (error) { return failure(error) }
}
