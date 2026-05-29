import { getThread, updateThreadMeta, upsertThreadMessage } from './threadStore.mjs'

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return Array.from(new Set(tags.map(String)))
}

export async function processThreadTurn({ agentId, text, taskId, responder, status, tags, file = undefined }) {
  const cleanAgentId = String(agentId || '')
  const cleanText = String(text || '').trim()
  const cleanTaskId = taskId ? String(taskId) : undefined
  const requestedTags = normalizeTags(tags)

  if (!cleanAgentId || !cleanText) {
    throw new Error('agentId and text required')
  }

  await upsertThreadMessage({
    agentId: cleanAgentId,
    text: cleanText,
    role: 'user',
    taskId: cleanTaskId,
    status: status || 'queued',
    tags: requestedTags,
  }, file)

  await updateThreadMeta({
    agentId: cleanAgentId,
    taskId: cleanTaskId,
    status: 'running',
    tags: requestedTags,
  }, file)

  try {
    const reply = await responder.respond({ agentId: cleanAgentId, text: cleanText, taskId: cleanTaskId })
    await upsertThreadMessage({
      agentId: cleanAgentId,
      text: String(reply?.text || ''),
      role: (reply?.role === 'system' || reply?.role === 'agent') ? reply.role : 'agent',
      taskId: reply?.taskId ? String(reply.taskId) : cleanTaskId,
      status: 'replied',
      tags: requestedTags,
    }, file)

    return { ok: true, thread: getThread({ agentId: cleanAgentId, taskId: cleanTaskId }, file) }
  } catch (e) {
    const errMsg = String(e?.message || e || 'Responder failure')
    const failedTags = normalizeTags([...requestedTags, 'error'])

    await upsertThreadMessage({
      agentId: cleanAgentId,
      text: `Responder failed: ${errMsg}`,
      role: 'system',
      taskId: cleanTaskId,
      status: 'failed',
      tags: failedTags,
    }, file)

    return {
      ok: false,
      error: errMsg,
      thread: getThread({ agentId: cleanAgentId, taskId: cleanTaskId }, file),
    }
  }
}
