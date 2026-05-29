import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import path from 'path'
import fs from 'fs'
import { logPipelineEvent } from '@/lib/pipelineLog'

export async function POST() {
  try {
    const root = path.join(process.cwd(), '..')
    const script = path.join(root, 'scripts', 'maton_sync_pipeline.py')

    const out: string = await new Promise((resolve, reject) => {
      execFile(script, [], { cwd: root, timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message))
        resolve(stdout || '{}')
      })
    })

    const parsed = JSON.parse(out)

    // After the sync script runs, it now writes directly to PIPELINE_NORMALIZED_PATH (dev) when set.
    // Keep the route lightweight: just verify the expected target exists (script performs the write + verification).

    logPipelineEvent({ module: 'pipeline-sync', action: 'pull', result: 'ok', detail: parsed?.summary })
    return NextResponse.json({ ok: true, result: parsed })
  } catch (e: unknown) {
    logPipelineEvent({ module: 'pipeline-sync', action: 'pull', result: 'error', detail: String(e) })
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
