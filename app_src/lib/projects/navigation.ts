const PENDING_PROJECT_TASK_KEY = 'clawpilot_pending_project_task'

export function queueProjectTaskOpen(taskId: string) {
  try {
    sessionStorage.setItem(PENDING_PROJECT_TASK_KEY, String(taskId).trim())
  } catch {
    // The same-screen event remains available when browser storage is unavailable.
  }
}

export function consumeProjectTaskOpen(): string | null {
  try {
    const taskId = String(sessionStorage.getItem(PENDING_PROJECT_TASK_KEY) || '').trim()
    sessionStorage.removeItem(PENDING_PROJECT_TASK_KEY)
    return taskId || null
  } catch {
    return null
  }
}
