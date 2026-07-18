import crypto from 'crypto'
import type { NextRequest } from 'next/server'
import { query } from '@/lib/persistence/postgres'
import type { AppUser } from '@/lib/users'
import { requireWorkspaceAppUser } from '@/lib/workspaceMemberships'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AgentDispatchWorkerContext = {
  operatorId: string
  boardId: string
  actor: AppUser
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
  const board = await query<{ workspace_organization_id: string }>(
    'SELECT workspace_organization_id::text FROM project_boards WHERE id = $1::uuid',
    [boardId],
  )
  if (!board.rows[0]) return null
  const actor = await requireWorkspaceAppUser(operatorId, board.rows[0].workspace_organization_id)
  return { operatorId: actor.email, boardId, actor }
}
