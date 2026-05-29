import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { logPipelineEvent } from '@/lib/pipelineLog'

const ROOT = path.join(process.cwd(), '..')
const NORM = process.env.PIPELINE_NORMALIZED_PATH || path.join(ROOT, 'data', 'pipeline', 'normalized', 'current.json')
const RAW = process.env.PIPELINE_RAW_PATH || path.join(path.dirname(path.dirname(NORM)), 'raw', 'last-sync.json')

export async function GET() {
  try {
    const normalized = fs.existsSync(NORM) ? JSON.parse(fs.readFileSync(NORM, 'utf-8')) : null
    const raw = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, 'utf-8')) : null

    logPipelineEvent({ module: 'pipeline-sync', action: 'status', result: 'ok' })
    return NextResponse.json({
      ok: true,
      syncedAt: normalized?.syncedAt || null,
      summary: normalized?.summary || null,
      diagnostics: raw?.counts || null,
    })
  } catch (e: unknown) {
    logPipelineEvent({ module: 'pipeline-sync', action: 'status', result: 'error', detail: String(e) })
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
