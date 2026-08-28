const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/
const CAREER_SITE_SOURCE_APP = 'jarrett-career-agents'
const CAREER_SITE_OWNER_EMAIL = 'jarrett@suburbiasandwichco.com'
const CAREER_SITE_ORGANIZATION_ID = '405bb919-0364-4a88-8a62-b4c9da42cd8f'
const CLAWPILOT_LOCAL_ORIGIN = 'http://localhost:4002'
const MAX_INSTRUCTIONS_LENGTH = 16_000
const MAX_PROMPT_LENGTH = 180_000
const MAX_SCHEMA_BYTES = 64 * 1024

const AGENT_CONTRACTS = {
  scout: { schemaName: 'career_job_scout', webSearch: true },
  tailor: { schemaName: 'career_application_packet', webSearch: false },
  engagement: { schemaName: 'career_engagement_drafts', webSearch: false },
  inbox: { schemaName: 'career_inbox_draft', webSearch: false },
} as const

export type CareerSiteAgentType = keyof typeof AGENT_CONTRACTS

export type CareerSiteAgentRequest = {
  requestId: string
  agentType: CareerSiteAgentType
  schemaName: string
  instructions: string
  prompt: string
  outputSchema: Record<string, unknown>
  webSearch: boolean
}

export type CareerSiteAgentConfiguration = {
  enabled: boolean
  sourceApp: typeof CAREER_SITE_SOURCE_APP
  ownerEmail: typeof CAREER_SITE_OWNER_EMAIL
  organizationId: typeof CAREER_SITE_ORGANIZATION_ID
  connectUrl: string
}

export class CareerSiteAgentRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'CAREER_SITE_AGENT_REQUEST_INVALID',
  ) {
    super(message)
    this.name = 'CareerSiteAgentRequestError'
  }
}

export class CareerSiteAgentConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CareerSiteAgentConfigurationError'
  }
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw new CareerSiteAgentRequestError(`${label} must be text`)
  }
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (!text || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new CareerSiteAgentRequestError(`${label} is invalid`)
  }
  return text
}

function outputSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CareerSiteAgentRequestError('outputSchema must be a JSON object')
  }
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new CareerSiteAgentRequestError('outputSchema must be JSON serializable')
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new CareerSiteAgentRequestError('outputSchema is too large', 413, 'CAREER_SITE_AGENT_SCHEMA_TOO_LARGE')
  }
  return value as Record<string, unknown>
}

export function parseCareerSiteAgentRequest(value: unknown): CareerSiteAgentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CareerSiteAgentRequestError('Request body must be a JSON object')
  }
  const record = value as Record<string, unknown>
  const supportedFields = new Set([
    'requestId',
    'agentType',
    'schemaName',
    'instructions',
    'prompt',
    'outputSchema',
    'webSearch',
  ])
  const unsupported = Object.keys(record).find((field) => !supportedFields.has(field))
  if (unsupported) {
    throw new CareerSiteAgentRequestError(`Unsupported career agent field: ${unsupported}`)
  }

  const requestId = String(record.requestId || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(requestId)) {
    throw new CareerSiteAgentRequestError('requestId must be a UUID')
  }
  const agentType = String(record.agentType || '').trim().toLowerCase() as CareerSiteAgentType
  const contract = AGENT_CONTRACTS[agentType]
  if (!contract) {
    throw new CareerSiteAgentRequestError('agentType is not supported')
  }
  const schemaName = String(record.schemaName || '').trim()
  if (!SCHEMA_NAME_PATTERN.test(schemaName) || schemaName !== contract.schemaName) {
    throw new CareerSiteAgentRequestError('schemaName does not match the selected agent')
  }
  if (typeof record.webSearch !== 'boolean' || record.webSearch !== contract.webSearch) {
    throw new CareerSiteAgentRequestError('webSearch does not match the selected agent')
  }

  return {
    requestId,
    agentType,
    schemaName,
    instructions: requiredText(record.instructions, 'instructions', MAX_INSTRUCTIONS_LENGTH),
    prompt: requiredText(record.prompt, 'prompt', MAX_PROMPT_LENGTH),
    outputSchema: outputSchema(record.outputSchema),
    webSearch: record.webSearch,
  }
}

function connectUrl(): string {
  const configured = String(process.env.CLAWPILOT_PUBLIC_URL || '').trim()
  try {
    const url = new URL(configured || CLAWPILOT_LOCAL_ORIGIN)
    const loopback = process.env.NODE_ENV !== 'production'
      && url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    if (
      (!loopback && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.search
    ) throw new Error()
    url.pathname = '/'
    url.search = ''
    url.hash = 'agents'
    return url.toString()
  } catch {
    throw new CareerSiteAgentConfigurationError('ClawPilot public URL is invalid')
  }
}

export function resolveCareerSiteAgentConfiguration(): CareerSiteAgentConfiguration {
  const ownerEmail = String(process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL || '')
    .trim()
    .toLowerCase()
  const organizationId = String(process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID || '')
    .trim()
    .toLowerCase()
  if (
    ownerEmail !== CAREER_SITE_OWNER_EMAIL
    || organizationId !== CAREER_SITE_ORGANIZATION_ID
  ) {
    throw new CareerSiteAgentConfigurationError('Career Desk identity is not configured')
  }
  return {
    enabled: process.env.CAREER_SITE_AGENTS_ENABLED === '1',
    sourceApp: CAREER_SITE_SOURCE_APP,
    ownerEmail: CAREER_SITE_OWNER_EMAIL,
    organizationId: CAREER_SITE_ORGANIZATION_ID,
    connectUrl: connectUrl(),
  }
}
