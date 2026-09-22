import { NextRequest, NextResponse } from 'next/server'
import { ModuleAccessError } from '@/lib/moduleAuthorization'
import {
  readShortLinkDomainPreferences,
  resolveShortLinkActor,
  saveShortLinkDefaultDomain,
  ShortLinkRequestError,
} from '@/lib/shortlinks'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function errorResponse(error: unknown) {
  if (error instanceof ModuleAccessError) {
    return NextResponse.json({ ok: false, error: error.message, code: error.code, module: error.module }, { status: error.status })
  }
  if (error instanceof ShortLinkRequestError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status })
  }
  const message = error instanceof Error ? error.message : 'Short-link preference request failed'
  if (message === 'Unauthorized') return NextResponse.json({ ok: false, error: message }, { status: 401 })
  console.error('[shortlinks/preferences] request failed', error)
  return NextResponse.json({ ok: false, error: 'Short-link preference request failed' }, { status: 500 })
}

async function responseForActor(req: NextRequest, save = false) {
  const actor = await resolveShortLinkActor(req)
  if (actor.service) throw new ShortLinkRequestError('Service clients cannot change user preferences', 403)
  if (save) {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new ShortLinkRequestError('Request body must be valid JSON')
    }
    const input = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {}
    await saveShortLinkDefaultDomain(actor, input.defaultDomain)
  }
  return NextResponse.json({ ok: true, ...await readShortLinkDomainPreferences(actor) })
}

export async function GET(req: NextRequest) {
  try { return await responseForActor(req) } catch (error) { return errorResponse(error) }
}

export async function PUT(req: NextRequest) {
  try { return await responseForActor(req, true) } catch (error) { return errorResponse(error) }
}
