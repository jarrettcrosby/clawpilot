import type { ProductAgentId } from '@/lib/agents/routing'
import { isOpenClawExecutionEnabled } from '@/lib/persistence/config'

export type AgentProvider = 'openai' | 'openclaw' | 'none'

export type AgentRuntime = {
  provider: AgentProvider
  ready: boolean
  status: 'ready' | 'not-configured'
  label: string
  model?: string
}

const AGENT_INSTRUCTIONS: Record<ProductAgentId, string> = {
  projects: 'Own project planning and delivery. Turn the selected task into concrete, sequenced work and report only actions, evidence, blockers, and the next step.',
  pipeline: 'Own pipeline operations. Maintain accurate opportunity context, identify follow-ups, and report concrete changes, evidence, blockers, and the next step.',
  docs: 'Own working documentation. Produce concise, durable notes and report concrete changes, evidence, blockers, and the next step.',
  calendar: 'Own scheduling coordination. Identify conflicts and decisions, then report concrete changes, evidence, blockers, and the next step.',
  clawpilot: 'Act as the ClawPilot coordinator. Use the selected task as the sole work scope, choose the next concrete move, and report actions, evidence, blockers, and the next step.',
}

export function getAgentRuntime(): AgentRuntime {
  const requested = String(process.env.CLAWPILOT_AGENT_PROVIDER || 'auto').trim().toLowerCase()
  const openAIKey = String(process.env.OPENAI_API_KEY || '').trim()
  const model = String(process.env.OPENAI_AGENT_MODEL || 'gpt-5-mini').trim()

  if (requested === 'none') {
    return { provider: 'none', ready: false, status: 'not-configured', label: 'Execution provider not connected' }
  }

  if (requested === 'openai') {
    return openAIKey
      ? { provider: 'openai', ready: true, status: 'ready', label: 'OpenAI configured', model }
      : { provider: 'openai', ready: false, status: 'not-configured', label: 'OpenAI key required', model }
  }

  if (requested === 'openclaw') {
    return isOpenClawExecutionEnabled()
      ? { provider: 'openclaw', ready: true, status: 'ready', label: 'OpenClaw connected' }
      : { provider: 'openclaw', ready: false, status: 'not-configured', label: 'OpenClaw disabled' }
  }

  if (openAIKey) return { provider: 'openai', ready: true, status: 'ready', label: 'OpenAI configured', model }
  if (isOpenClawExecutionEnabled()) return { provider: 'openclaw', ready: true, status: 'ready', label: 'OpenClaw connected' }
  return { provider: 'none', ready: false, status: 'not-configured', label: 'Execution provider not connected' }
}

function extractResponseText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string') return payload.output_text.trim()

  const output = Array.isArray(payload.output) ? payload.output : []
  const parts: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as unknown[]
      : []
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue
      const text = (entry as Record<string, unknown>).text
      if (typeof text === 'string' && text.trim()) parts.push(text.trim())
    }
  }
  return parts.join('\n').trim()
}

export async function runOpenAIAgent(input: {
  agentId: ProductAgentId
  taskContext: string
  userText: string
  conversation?: Array<{ role: string; text: string }>
}): Promise<string> {
  const runtime = getAgentRuntime()
  if (runtime.provider !== 'openai' || !runtime.ready) {
    throw new Error('OpenAI execution is not configured')
  }

  const history = (input.conversation || [])
    .slice(-8)
    .map((message) => `${message.role}: ${message.text}`)
    .join('\n')
  const prompt = [
    `Task context:\n${input.taskContext}`,
    history ? `Recent task thread:\n${history}` : null,
    `Operator request:\n${input.userText}`,
    'Reply using exactly these headings: Changed, Remaining, Waiting on. Use "none" when there is no blocker. Do not claim an external action unless the supplied context proves it occurred.',
  ].filter(Boolean).join('\n\n')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: runtime.model,
        instructions: AGENT_INSTRUCTIONS[input.agentId],
        input: prompt,
        max_output_tokens: 1200,
        store: false,
      }),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const error = payload.error && typeof payload.error === 'object'
        ? String((payload.error as Record<string, unknown>).message || '')
        : ''
      throw new Error(error || `OpenAI request failed with status ${response.status}`)
    }

    const text = extractResponseText(payload)
    if (!text) throw new Error('OpenAI returned an empty response')
    return text
  } finally {
    clearTimeout(timeout)
  }
}
