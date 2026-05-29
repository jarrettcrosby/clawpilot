import fs from 'fs'
import path from 'path'

const LOG_FILE = process.env.PIPELINE_LOG_PATH || path.join(process.cwd(), '..', 'data', 'logs', 'pipeline-events.jsonl')

type PipelineLogEvent = {
  module: string
  action: string
  recordId?: string
  result: 'ok' | 'error' | 'conflict'
  actor?: string
  activityType?: 'updated' | 'moved' | 'comment'
  message?: string
  fromStage?: string
  toStage?: string
  changedBy?: string
  opportunityName?: string
  organization?: string
  detail?: unknown
}

export function logPipelineEvent(evt: PipelineLogEvent) {
  try {
    const dir = path.dirname(LOG_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const row = {
      ts: new Date().toISOString(),
      ...evt,
    }
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(row)}\n`, 'utf-8')
  } catch {
    // do not break requests on logging failures
  }
}
