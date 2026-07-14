import { NextRequest, NextResponse } from 'next/server'
import {
  createShortLink,
  deleteShortLink,
  listShortLinks,
  resolveShortLinkActor,
  ShortLinkRequestError,
  updateShortLink,
} from '@/lib/shortlinks'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function errorResponse(error: unknown) {
  if (error instanceof ShortLinkRequestError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status })
  }
  const message = error instanceof Error ? error.message : 'Short-link request failed'
  if (message === 'Unauthorized') return NextResponse.json({ ok: false, error: message }, { status: 401 })
  console.error('[shortlinks] request failed', error)
  return NextResponse.json({ ok: false, error: 'Short-link request failed' }, { status: 500 })
}

async function requestBody(req: NextRequest) {
  try {
    return await req.json()
  } catch {
    throw new ShortLinkRequestError('Request body must be valid JSON')
  }
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveShortLinkActor(req)
    const params = new URL(req.url).searchParams
    const links = await listShortLinks(actor, {
      query: params.get('q'),
      tag: params.get('tag'),
      status: params.get('status'),
      sourceApp: params.get('source'),
    })
    return NextResponse.json({ ok: true, links })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveShortLinkActor(req)
    const link = await createShortLink(actor, await requestBody(req))
    return NextResponse.json({ ok: true, link }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const actor = await resolveShortLinkActor(req)
    const link = await updateShortLink(actor, await requestBody(req))
    return NextResponse.json({ ok: true, link })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const actor = await resolveShortLinkActor(req)
    await deleteShortLink(actor, new URL(req.url).searchParams.get('id'))
    return NextResponse.json({ ok: true })
  } catch (error) {
    return errorResponse(error)
  }
}
