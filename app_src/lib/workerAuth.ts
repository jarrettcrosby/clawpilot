import crypto from 'crypto'
import type { NextRequest } from 'next/server'
import { requireActiveAppUser } from '@/lib/users'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AgentDispatchWorkerContext = {
  operatorId: string
  boardId: string
}
function secureEqual(left: string, right: string): boolean {
  if (!left || !right) return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

export async function resolveAgentDispatchWorker(req: NextRequest): Promise<AgentDispatchWorkerContext | null> {
  if (req.headers.get('x-clawpilot-worker') !== 'agent-dispatch') return null
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (expected.length < 32 || !secureEqual(expected, provided)) return null
  const operatorId = String(req.headers.get('x-clawpilot-operator') || '').trim().toLowerCase()
  const boardId = String(req.headers.get('x-clawpilot-board-id') || '').trim().toLowerCase()
  if (!operatorId.includes('@') || !UUID_PATTERN.test(boardId)) return null
  const operator = await requireActiveAppUser(operatorId)
  return { operatorId: operator.email, boardId }
}
