import { NextRequest, NextResponse } from 'next/server'
import { logPipelineEvent } from '@/lib/pipelineLog'
import { syncPipelineFromSheets } from '@/lib/pipelineSync'
import { isPostgresPipelineStoreEnabled } from '@/lib/persistence/pipeline'
import { requireRequestUser } from '@/lib/requestUser'
import { PIPELINE_SELECTION_COOKIE, requireResourceEditor, resolvePipelineSpaceAccess } from '@/lib/tenancy'

export async function POST(req: NextRequest) {
  try {
    let actorEmail = 'ClawPilot'
    let pipelineId: string | undefined
    if (isPostgresPipelineStoreEnabled()) {
      const actor = await requireRequestUser(req)
      actorEmail = actor.email
      const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
      const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selected })
        .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor.email }))
      requireResourceEditor(pipeline)
      if (!pipeline.syncEnabled) {
        return NextResponse.json({ ok: false, error: 'This pipeline is app-managed and has no external sync source' }, { status: 400 })
      }
      pipelineId = pipeline.id
    }
    const result = await syncPipelineFromSheets()
    logPipelineEvent({ module: 'pipeline-sync', action: 'pull', result: 'ok', detail: result.summary, actor: actorEmail, pipelineId })
    return NextResponse.json({ ok: true, result, projectionStorage: result.projectionStorage })
  } catch (e: unknown) {
    logPipelineEvent({ module: 'pipeline-sync', action: 'pull', result: 'error', detail: String(e) })
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
