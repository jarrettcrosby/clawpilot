import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const LOG_FILE = path.join(process.cwd(), '..', 'data', 'logs', 'pipeline-events.jsonl')

type PipelineActivity = {
  id: string
  module: 'pipeline'
  type: 'updated' | 'moved' | 'comment'
  message: string
  timestamp: string
  actor: string
  changedBy?: string
  opportunityId?: string
  opportunityName?: string
  organization?: string
  fromStage?: string
  toStage?: string
}

function normalizeType(v: unknown): PipelineActivity['type'] | null {
  const s = String(v || '').toLowerCase()
  if (s === 'updated' || s === 'moved' || s === 'comment') return s
  return null
}

export async function GET() {
  try {
    if (!fs.existsSync(LOG_FILE)) return NextResponse.json([])

    const raw = fs.readFileSync(LOG_FILE, 'utf-8')
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const out: PipelineActivity[] = []

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      try {
        const row = JSON.parse(line)
        const activityType = normalizeType(row?.activityType)
        if (!activityType) continue

        const timestamp = String(row?.ts || row?.timestamp || '')
        if (!timestamp) continue

        const id = `${String(row?.recordId || 'pipeline')}-${timestamp}-${activityType}`
        out.push({
          id,
          module: 'pipeline',
          type: activityType,
          message: String(row?.message || `Pipeline ${activityType}`),
          timestamp,
          actor: String(row?.changedBy || row?.actor || 'Jarrett'),
          changedBy: row?.changedBy ? String(row.changedBy) : undefined,
          opportunityId: row?.recordId ? String(row.recordId) : undefined,
          opportunityName: row?.opportunityName ? String(row.opportunityName) : undefined,
          organization: row?.organization ? String(row.organization) : undefined,
          fromStage: row?.fromStage ? String(row.fromStage) : undefined,
          toStage: row?.toStage ? String(row.toStage) : undefined,
        })
      } catch {
        // ignore malformed lines
      }
    }

    return NextResponse.json(out.slice(0, 300))
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
