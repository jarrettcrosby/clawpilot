import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { logPipelineEvent } from '@/lib/pipelineLog'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import {
  isPostgresPipelineStoreEnabled,
  readPipelineSyncDiagnosticsFromPostgres,
} from '@/lib/persistence/pipeline'
import { requireRequestUser } from '@/lib/requestUser'
import {
  PIPELINE_SELECTION_COOKIE,
  isLegacyOwnerSheetPipeline,
  readPipelineProjectionForSpace,
  requirePipelineSheetContext,
  resolvePipelineSpaceAccess,
  type PipelineSpace,
} from '@/lib/tenancy'

const ROOT = path.join(process.cwd(), '..')
const NORM = process.env.PIPELINE_NORMALIZED_PATH || path.join(ROOT, 'data', 'pipeline', 'normalized', 'current.json')
const RAW = process.env.PIPELINE_RAW_PATH || path.join(path.dirname(path.dirname(NORM)), 'raw', 'last-sync.json')

export async function GET(req: NextRequest) {
  try {
    if (isPostgresPipelineStoreEnabled()) {
      let selectedPipeline: PipelineSpace | null = null
      try {
        const actor = await requireRequestUser(req)
        const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
        const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: selected })
          .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor.email }))
        selectedPipeline = pipeline
        const projection = await readPipelineProjectionForSpace(pipeline)
        const diagnostics = pipeline.syncEnabled
          ? await readPipelineSyncDiagnosticsFromPostgres({
              ...requirePipelineSheetContext(pipeline),
              includeLegacyOwnerItems: isLegacyOwnerSheetPipeline(pipeline),
            })
          : { outbox: {}, oldestPendingAt: null }

        logPipelineEvent({ module: 'pipeline-sync', action: 'status', result: 'ok', actor: actor.email, pipelineId: pipeline.id })
        return NextResponse.json({
          ok: true,
          syncedAt: projection?.syncedAt || null,
          summary: projection?.summary || null,
          diagnostics,
          storage: 'postgres',
          pipeline: { id: pipeline.id, name: pipeline.name, accessRole: pipeline.accessRole, syncEnabled: pipeline.syncEnabled },
        })
      } catch (error) {
        if (!shouldFallbackToFileOnDatabaseError() || !isLegacyOwnerSheetPipeline(selectedPipeline)) throw error
        console.warn('[pipeline-sync-status] Postgres read failed; falling back to file store', error)
      }
    }

    const normalized = fs.existsSync(NORM) ? JSON.parse(fs.readFileSync(NORM, 'utf-8')) : null
    const raw = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, 'utf-8')) : null

    logPipelineEvent({ module: 'pipeline-sync', action: 'status', result: 'ok' })
    return NextResponse.json({
      ok: true,
      syncedAt: normalized?.syncedAt || null,
      summary: normalized?.summary || null,
      diagnostics: raw?.counts || null,
      storage: 'file',
    })
  } catch (e: unknown) {
    logPipelineEvent({ module: 'pipeline-sync', action: 'status', result: 'error', detail: String(e) })
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
