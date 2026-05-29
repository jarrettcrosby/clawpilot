import type { NextApiRequest, NextApiResponse } from 'next'
import fs from 'fs'
import path from 'path'
import { ensureNotFrozen } from '@/lib/freeze'

// Advisory-only checklist API with optional dev-only persistence.
// - GET /api/checklist/[taskId] => returns persisted checklist items for the task (if present)
// - POST /api/checklist/[taskId] => validates item; when CHECKLIST_PERSIST_DEV=true persists under TASKS_PATH (dev-only), otherwise returns advisory echo

function readJsonFile(p: string) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
function writeJsonFileSafe(p: string, obj: unknown) {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  // backup original
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak')
  fs.renameSync(tmp, p)
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const { taskId } = req.query
  const TASKS_PATH = process.env.TASKS_PATH || path.resolve(process.cwd(), '../../data-dev/tasks.json')
  const PERSIST = (process.env.CHECKLIST_PERSIST_DEV || '').toLowerCase() === 'true'

  if (req.method === 'POST') {
    const freeze = ensureNotFrozen()
    if (freeze) return res.status(423).json(freeze)
    try {
      const item = req.body
      if (!item || typeof item !== 'object') return res.status(400).json({ error: 'invalid payload' })
      if (!item.id || !item.text || !item.status) return res.status(422).json({ error: 'missing required fields: id,text,status' })

      if (PERSIST) {
        // attempt to read tasks file and append item to matching task.checklist
        const tasks = readJsonFile(TASKS_PATH)
        if (!Array.isArray(tasks)) {
          return res.status(500).json({ error: 'tasks data invalid or missing at TASKS_PATH', TASKS_PATH })
        }
        const tIdx = tasks.findIndex(t => String(t.id) === String(taskId))
        if (tIdx < 0) {
          return res.status(404).json({ error: `task not found: ${taskId}`, TASKS_PATH })
        }
        const task = tasks[tIdx]
        task.checklist = task.checklist || []
        // preserve backward compatibility: do not remove existing fields
        task.checklist.push(item)
        // safe write with backup
        writeJsonFileSafe(TASKS_PATH, tasks)
        return res.status(200).json({ advisory: false, persisted: true, taskId, item })
      }

      // advisory-only path
      return res.status(200).json({ advisory: true, persisted: false, taskId, item })
    } catch (e) {
      return res.status(500).json({ error: 'validation error', detail: String(e) })
    }
  }

  if (req.method === 'GET') {
    const TASKS_PATH = process.env.TASKS_PATH || path.resolve(process.cwd(), '../../data-dev/tasks.json')
    const tasks = readJsonFile(TASKS_PATH)
    if (!Array.isArray(tasks)) return res.status(204).end()
    const task = tasks.find(t => String(t.id) === String(taskId))
    if (!task) return res.status(204).end()
    return res.status(200).json({ taskId, checklist: task.checklist || [] })
  }

  res.setHeader('Allow', ['GET', 'POST'])
  return res.status(405).end()
}
