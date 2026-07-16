import crypto from 'crypto'
import type { ProductAgentId } from '@/lib/agents/routing'
import { getChatGPTConnection, getValidChatGPTCredential } from '@/lib/agents/chatgptAuth'
import { runChatGPTCodexResponse } from '@/lib/agents/chatgptResponses'
import { isOpenClawExecutionEnabled } from '@/lib/persistence/config'

export type AgentProvider = 'openai' | 'openai-codex' | 'openclaw' | 'none'

export type AgentRuntime = {
  provider: AgentProvider
  ready: boolean
  status: 'ready' | 'not-configured'
  label: string
  model?: string
  auth?: {
    connected: boolean
    email?: string
    planType?: string
    expiresAt?: string
  }
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
  const codexModel = String(process.env.OPENAI_CODEX_AGENT_MODEL || 'gpt-5.4').trim()

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

  if (requested === 'openai-codex' || requested === 'chatgpt' || requested === 'codex') {
    return {
      provider: 'openai-codex',
      ready: false,
      status: 'not-configured',
      label: 'Connect ChatGPT',
      model: codexModel,
      auth: { connected: false },
    }
  }

  if (openAIKey) return { provider: 'openai', ready: true, status: 'ready', label: 'OpenAI configured', model }
  if (isOpenClawExecutionEnabled()) return { provider: 'openclaw', ready: true, status: 'ready', label: 'OpenClaw connected' }
  return {
    provider: 'openai-codex',
    ready: false,
    status: 'not-configured',
    label: 'Connect ChatGPT',
    model: codexModel,
    auth: { connected: false },
  }
}

export async function getAgentRuntimeForOperator(operatorId: string): Promise<AgentRuntime> {
  const runtime = getAgentRuntime()
  if (runtime.provider !== 'openai-codex') return runtime
  try {
    const connection = await getChatGPTConnection(operatorId)
    if (!connection.connected) return runtime
    const plan = connection.planType ? connection.planType.replace(/\b\w/g, (character) => character.toUpperCase()) : ''
    return {
      ...runtime,
      ready: true,
      status: 'ready',
      label: plan ? `ChatGPT ${plan}` : 'ChatGPT connected',
      auth: connection,
    }
  } catch {
    return { ...runtime, label: 'ChatGPT connection unavailable' }
  }
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

type AgentTurnInput = {
  agentId: ProductAgentId
  taskContext: string
  userText: string
  conversation?: Array<{ role: string; text: string }>
}

export function stableAgentProfileId(operatorId: string, agentId: ProductAgentId): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${String(operatorId || '').trim().toLowerCase()}\n${agentId}`)
    .digest('hex')
    .slice(0, 24)
  return `clawpilot_${agentId}_${digest}`
}

function buildAgentPrompt(input: AgentTurnInput): string {
  const history = (input.conversation || [])
    .slice(-8)
    .map((message) => `${message.role}: ${message.text}`)
    .join('\n')
  return [
    `Task context:\n${input.taskContext}`,
    history ? `Recent task thread:\n${history}` : null,
    `Operator request:\n${input.userText}`,
    'Reply using exactly these headings: Changed, Remaining, Waiting on, Learned.',
    'Learned must contain one reusable operating lesson from this work, or "none". Keep it generic and exclude names, organizations, emails, IDs, URLs, customer data, and task-specific facts.',
    'Use "none" when there is no blocker. Do not claim an external action unless the supplied context proves it occurred.',
  ].filter(Boolean).join('\n\n')
}

export async function runOpenAIAgent(input: AgentTurnInput): Promise<string> {
  const runtime = getAgentRuntime()
  if (runtime.provider !== 'openai' || !runtime.ready) {
    throw new Error('OpenAI execution is not configured')
  }
  const prompt = buildAgentPrompt(input)

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

export async function runChatGPTAgent(input: AgentTurnInput & {
  operatorId: string
  taskId: string
}): Promise<string> {
  const runtime = await getAgentRuntimeForOperator(input.operatorId)
  if (runtime.provider !== 'openai-codex' || !runtime.ready || !runtime.model) {
    throw new Error('Connect ChatGPT before sending an agent message')
  }
  const prompt = buildAgentPrompt(input)
  const sessionId = stableAgentProfileId(input.operatorId, input.agentId)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)

  async function execute(forceRefresh = false) {
    const credential = await getValidChatGPTCredential(input.operatorId, { forceRefresh })
    return runChatGPTCodexResponse({
      credential,
      model: runtime.model!,
      instructions: AGENT_INSTRUCTIONS[input.agentId],
      prompt,
      sessionId,
      signal: controller.signal,
    })
  }

  try {
    try {
      return await execute()
    } catch (error) {
      const status = error && typeof error === 'object' ? Number((error as { status?: unknown }).status) : 0
      if (status !== 401) throw error
      return await execute(true)
    }
  } finally {
    clearTimeout(timeout)
  }
}
