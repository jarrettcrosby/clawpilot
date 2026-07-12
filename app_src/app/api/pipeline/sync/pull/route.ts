import { NextResponse } from 'next/server'
import { logPipelineEvent } from '@/lib/pipelineLog'
import { syncPipelineFromSheets } from '@/lib/pipelineSync'

export async function POST() {
  try {
    const result = await syncPipelineFromSheets()
    logPipelineEvent({ module: 'pipeline-sync', action: 'pull', result: 'ok', detail: result.summary })
    return NextResponse.json({ ok: true, result, projectionStorage: result.projectionStorage })
  } catch (e: unknown) {
    logPipelineEvent({ module: 'pipeline-sync', action: 'pull', result: 'error', detail: String(e) })
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
