import { NextRequest, NextResponse } from 'next/server'
import { projectCrmWorkbook } from '@/lib/crm/workbookProjection'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
import {
  PIPELINE_SELECTION_COOKIE,
  requirePipelineSheetContext,
  resolvePipelineSpaceAccess,
} from '@/lib/tenancy'

export async function POST(req: NextRequest) {
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json({ ok: false, error: 'CRM workbook projection requires Postgres storage' }, { status: 409 })
  }
  try {
    const actor = await requireRequestUser(req)
    const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
    const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId: selected })
      .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor }))
    if (pipeline.ownerEmail !== actor.email || pipeline.accessRole !== 'owner') {
      return NextResponse.json({ ok: false, error: 'Only the pipeline owner can refresh its CRM workbook' }, { status: 403 })
    }
    const result = await projectCrmWorkbook({
      context: requirePipelineSheetContext(pipeline),
      actorEmail: actor.email,
    })
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CRM workbook projection failed'
    return NextResponse.json({ ok: false, error: message }, { status: message === 'Unauthorized' ? 401 : 400 })
  }
}
