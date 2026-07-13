type AgentTurnInput = {
  taskId: string
  agentId: string
  text: string
}

function responseMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') return fallback
  const value = payload as Record<string, unknown>
  return typeof value.error === 'string' && value.error.trim() ? value.error : fallback
}

export async function triggerAgentTurn(input: AgentTurnInput) {
  const response = await fetch('/api/agents/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(responseMessage(payload, 'Agent execution failed.'))
  return payload
}

export function assignmentKickoffText() {
  return 'This task was just assigned to you. Review the task context and identify the next concrete step. Do not claim work that has not been completed.'
}
