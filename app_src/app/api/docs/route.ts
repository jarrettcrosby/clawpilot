import { NextRequest, NextResponse } from 'next/server'
import {
  ensureApplicationUserGuide,
  ensureUserBriefs,
  listLocalRepositoryDocuments,
  listUserDocuments,
  refreshUserBriefs,
  syncRepositoryDocuments,
} from '@/lib/documents'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
import { BOARD_SELECTION_COOKIE, PIPELINE_SELECTION_COOKIE } from '@/lib/tenancy'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Document request failed'
  const status = message === 'Unauthorized' ? 401 : 500
  return NextResponse.json({ ok: false, error: message }, { status })
}

async function documentPayload(req: NextRequest, refresh: boolean) {
  const search = new URL(req.url).searchParams.get('q') || ''
  if (!isPostgresStorageEnabled()) return listLocalRepositoryDocuments(search)
  const actor = await requireRequestUser(req)
  await ensureApplicationUserGuide(actor)
  const selection = {
    boardId: req.cookies.get(BOARD_SELECTION_COOKIE)?.value || null,
    pipelineId: req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || null,
  }
  if (refresh) await refreshUserBriefs(actor, selection)
  else if (!search) await ensureUserBriefs(actor, selection)
  await syncRepositoryDocuments(actor, { force: refresh })
  return listUserDocuments(actor, search)
}

export async function GET(req: NextRequest) {
  try {
    return NextResponse.json(await documentPayload(req, false))
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    return NextResponse.json(await documentPayload(req, true))
  } catch (error) {
    return errorResponse(error)
  }
}
