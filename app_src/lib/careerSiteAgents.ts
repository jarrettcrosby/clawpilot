import crypto from 'node:crypto'
import { getChatGPTConnection, getValidChatGPTCredential } from '@/lib/agents/chatgptAuth'
import { runChatGPTCodexStructuredResponse } from '@/lib/agents/chatgptResponses'
import { AGENT_SECURITY_POLICY, serializePromptSection } from '@/lib/agents/promptSecurity'
import type { CareerSiteAgentRequest } from '@/lib/careerSiteAgentContract'

const DEFAULT_CODEX_MODEL = 'gpt-5.4'

export type CareerSiteAgentStatus = {
  connected: boolean
  provider: 'chatgpt-codex'
  label: string
  email?: string
  planType?: string
  expiresAt?: string
  model: string
}

export type CareerSiteAgentConnectionHealth = {
  connected: boolean
}

export class CareerSiteAgentConnectionError extends Error {
  constructor(message = 'Connect ChatGPT in ClawPilot before running Career Desk agents') {
    super(message)
    this.name = 'CareerSiteAgentConnectionError'
  }
}

function model(): string {
  return String(process.env.OPENAI_CODEX_AGENT_MODEL || DEFAULT_CODEX_MODEL).trim()
    || DEFAULT_CODEX_MODEL
}

export async function getCareerSiteAgentStatus(operatorId: string): Promise<CareerSiteAgentStatus> {
  const connection = await getChatGPTConnection(operatorId)
  const plan = connection.planType
    ? connection.planType.replace(/\b\w/g, (character) => character.toUpperCase())
    : ''
  return {
    connected: connection.connected,
    provider: 'chatgpt-codex',
    label: connection.connected
      ? plan ? `ChatGPT ${plan}` : 'ChatGPT connected'
      : 'Connect ChatGPT',
    ...(connection.email ? { email: connection.email } : {}),
    ...(connection.planType ? { planType: connection.planType } : {}),
    ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}),
    model: model(),
  }
}

export async function getCareerSiteAgentConnectionHealth(
  operatorId: string,
): Promise<CareerSiteAgentConnectionHealth> {
  const connection = await getChatGPTConnection(operatorId)
  return { connected: connection.connected }
}

function sessionId(operatorId: string, request: CareerSiteAgentRequest): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${operatorId.trim().toLowerCase()}\ncareer-desk\n${request.agentType}`)
    .digest('hex')
    .slice(0, 24)
  return `clawpilot_career_${request.agentType}_${digest}`
}

function responseId(operatorId: string, requestId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${operatorId.trim().toLowerCase()}\n${requestId}`)
    .digest('hex')
    .slice(0, 32)
  return `clawpilot-chatgpt-${digest}`
}

function careerInstructions(request: CareerSiteAgentRequest): string {
  return [
    'You are a bounded Career Desk worker running inside ClawPilot for the authenticated owner.',
    'You may research public job sources or draft private career materials only as the selected agent requires. You cannot submit an application, post, react, send a message, access a private browser session, or claim any external action occurred.',
    'Return exactly one JSON object matching the supplied strict schema. Do not wrap the JSON in Markdown.',
    AGENT_SECURITY_POLICY,
    'Career Desk role instructions:',
    request.instructions,
  ].join('\n\n')
}

export async function runCareerSiteAgent(input: {
  operatorId: string
  request: CareerSiteAgentRequest
}) {
  const status = await getCareerSiteAgentStatus(input.operatorId)
  if (!status.connected) throw new CareerSiteAgentConnectionError()

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 240_000)
  const prompt = serializePromptSection(
    'CAREER_DESK_REQUEST',
    'authenticated-operator-request',
    input.request.prompt,
  )

  async function execute(forceRefresh = false) {
    const credential = await getValidChatGPTCredential(input.operatorId, { forceRefresh })
    return runChatGPTCodexStructuredResponse({
      credential,
      model: status.model,
      instructions: careerInstructions(input.request),
      prompt,
      sessionId: sessionId(input.operatorId, input.request),
      outputSchema: {
        name: input.request.schemaName,
        schema: input.request.outputSchema,
      },
      webSearch: input.request.webSearch,
      signal: controller.signal,
    })
  }

  try {
    let result: Awaited<ReturnType<typeof execute>>
    try {
      result = await execute()
    } catch (error) {
      const upstreamStatus = error && typeof error === 'object'
        ? Number((error as { status?: unknown }).status)
        : 0
      if (upstreamStatus !== 401) throw error
      result = await execute(true)
    }
    return {
      responseId: responseId(input.operatorId, input.request.requestId),
      outputText: result.text,
      sourceUrls: result.citations.map((citation) => citation.url),
      model: status.model,
    }
  } finally {
    clearTimeout(timeout)
  }
}
