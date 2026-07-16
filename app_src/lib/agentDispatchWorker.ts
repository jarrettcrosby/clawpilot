import {
  claimAgentDispatchOutboxInPostgres,
  completeAgentDispatchOutboxInPostgres,
  failAgentDispatchOutboxInPostgres,
  type AgentDispatchOutboxItem,
} from '@/lib/persistence/agentDispatch'

class AgentDispatchHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function internalBaseUrl() {
  const port = String(process.env.PORT || 4002)
  return `http://127.0.0.1:${port}`
}

function workerSecret() {
  const secret = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '').trim()
  if (!secret) throw new Error('PIPELINE_OUTBOX_WORKER_SECRET is required')
  return secret
}

async function internalJson(input: {
  item: AgentDispatchOutboxItem
  path: string
  method?: 'POST' | 'PATCH'
  body: Record<string, unknown>
  timeoutMs: number
}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    const response = await fetch(`${internalBaseUrl()}${input.path}`, {
      method: input.method || 'POST',
      headers: {
        Authorization: `Bearer ${workerSecret()}`,
        'Content-Type': 'application/json',
        'X-ClawPilot-Worker': 'agent-dispatch',
        'X-ClawPilot-Operator': input.item.operatorId,
        'X-ClawPilot-Board-Id': input.item.boardId,
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload: Record<string, unknown> = {}
    if (text) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>
      } catch {
        payload = { error: text.slice(0, 1000) }
      }
    }
    if (!response.ok) {
      const message = String(payload.error || `Internal agent request failed with HTTP ${response.status}`)
      throw new AgentDispatchHttpError(message, response.status)
    }
    return payload
  } catch (error) {
    if (error instanceof AgentDispatchHttpError) throw error
    if (controller.signal.aborted) throw new AgentDispatchHttpError('Internal agent request timed out', 504)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function markDispatchState(
  item: AgentDispatchOutboxItem,
  status: 'queued' | 'running' | 'succeeded' | 'failed',
  error?: string,
) {
  await internalJson({
    item,
    path: '/api/tasks',
    method: 'PATCH',
    timeoutMs: 15_000,
    body: {
      id: item.taskId,
      _agentDispatchState: {
        id: item.dispatchId,
        status,
        attempts: item.attempts,
        error,
      },
    },
  })
}

async function executeDispatch(item: AgentDispatchOutboxItem, onResultPersisted: () => void) {
  await markDispatchState(item, 'running')
  await internalJson({
    item,
    path: '/api/agents/threads',
    timeoutMs: 180_000,
    body: {
      agentId: item.agentId,
      taskId: item.taskId,
      text: item.text,
      tags: ['agent-dispatch', item.trigger],
      dispatchId: item.dispatchId,
      dispatchAttempt: item.attempts,
    },
  })
  onResultPersisted()
  await markDispatchState(item, 'succeeded')
}

function isPermanentFailure(error: unknown) {
  return error instanceof AgentDispatchHttpError
    && [400, 401, 403, 404, 409, 410, 422].includes(error.status)
}

export async function processAgentDispatchOutbox(input: {
  limit?: number
  maxAttempts?: number
} = {}) {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 5), 10))
  const items = await claimAgentDispatchOutboxInPostgres({ limit: input.limit, maxAttempts })
  const results: Array<{ id: string; trigger: string; status: 'succeeded' | 'failed' | 'dead' }> = []

  for (const item of items) {
    let resultPersisted = false
    try {
      await executeDispatch(item, () => { resultPersisted = true })
      await completeAgentDispatchOutboxInPostgres(item)
      results.push({ id: item.dispatchId, trigger: item.trigger, status: 'succeeded' })
      continue
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = await failAgentDispatchOutboxInPostgres({
        item,
        error: message,
        maxAttempts: isPermanentFailure(error) ? item.attempts : maxAttempts,
      })
      if (!resultPersisted) {
        try {
          await markDispatchState(item, status === 'dead' ? 'failed' : 'queued', message)
        } catch (stateError) {
          console.error('[agent-dispatch] unable to record task dispatch state', stateError)
        }
      }
      results.push({ id: item.dispatchId, trigger: item.trigger, status })
    }
  }

  return {
    claimed: items.length,
    succeeded: results.filter((result) => result.status === 'succeeded').length,
    failed: results.filter((result) => result.status === 'failed').length,
    dead: results.filter((result) => result.status === 'dead').length,
    items: results,
  }
}
