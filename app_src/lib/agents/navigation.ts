const PENDING_AGENT_TASK_KEY = 'clawpilot_pending_agent_task'

export type PendingAgentTask = {
  taskId: string
  agentId: string
}

export function queueAgentTaskOpen(taskId: string, agentId: string) {
  try {
    sessionStorage.setItem(PENDING_AGENT_TASK_KEY, JSON.stringify({ taskId, agentId }))
  } catch {
    // The same-screen event remains available when browser storage is unavailable.
  }
}

export function consumeAgentTaskOpen(): PendingAgentTask | null {
  try {
    const raw = sessionStorage.getItem(PENDING_AGENT_TASK_KEY)
    sessionStorage.removeItem(PENDING_AGENT_TASK_KEY)
    if (!raw) return null

    const value = JSON.parse(raw) as Partial<PendingAgentTask>
    const taskId = String(value.taskId || '').trim()
    const agentId = String(value.agentId || '').trim()
    return taskId && agentId ? { taskId, agentId } : null
  } catch {
    return null
  }
}
