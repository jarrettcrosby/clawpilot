import { NextRequest, NextResponse } from 'next/server'
import {
  createCrmProductCategoryInPostgres,
  listCrmProductCategoriesInPostgres,
} from '@/lib/persistence/crm'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
import {
  PIPELINE_SELECTION_COOKIE,
  requireResourceEditor,
  resolvePipelineSpaceAccess,
} from '@/lib/tenancy'

async function selectedPipeline(req: NextRequest, actorEmail: string) {
  const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
  return resolvePipelineSpaceAccess({ actorEmail, pipelineId: selected })
    .catch(() => resolvePipelineSpaceAccess({ actorEmail }))
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Product category request failed'
  const status = message === 'Unauthorized' ? 401 : /view-only|denied/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 400
  return NextResponse.json({ ok: false, error: message }, { status })
}

export async function GET(req: NextRequest) {
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json({ ok: false, error: 'CRM requires Postgres storage' }, { status: 409 })
  }
  try {
    const actor = await requireRequestUser(req)
    const pipeline = await selectedPipeline(req, actor.email)
    const categories = await listCrmProductCategoriesInPostgres(pipeline.id)
    return NextResponse.json({ ok: true, categories })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json({ ok: false, error: 'CRM requires Postgres storage' }, { status: 409 })
  }
  try {
    const actor = await requireRequestUser(req)
    const pipeline = await selectedPipeline(req, actor.email)
    requireResourceEditor(pipeline)
    const body = await req.json()
    const name = String(body?.name || '').trim()
    const parentId = String(body?.parentId || '').trim() || null
    if (parentId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parentId)) {
      throw new Error('Parent product category is invalid')
    }
    const category = await createCrmProductCategoryInPostgres({
      pipelineId: pipeline.id,
      parentId,
      name,
      actorEmail: actor.email,
    })
    return NextResponse.json({ ok: true, category }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
