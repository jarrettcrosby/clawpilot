import {
  CAREER_SITE_ORGANIZATION_ID,
  CAREER_SITE_OWNER_EMAIL,
  CAREER_SITE_SOURCE_APP,
} from '@/lib/careerSiteAgentContract'
import { isIP } from 'node:net'

const MAX_QUERY_CHARS = 500
export const DEFAULT_GMAIL_MESSAGES_PER_ACCOUNT = 10
export const MAX_GMAIL_MESSAGES_PER_ACCOUNT = 25
export const MAX_GMAIL_ACTIVE_ACCOUNTS = 10
export const MAX_GMAIL_TOTAL_MESSAGES = 50
export const MAX_GMAIL_SNIPPET_CHARS = 2_000
export const MAX_GMAIL_BODY_TEXT_CHARS = 20_000
export const MAX_GMAIL_PUBLIC_URLS = 20
export const MAX_GMAIL_RESPONSE_BYTES = 4 * 1024 * 1024
export const GMAIL_SOURCE_DEADLINE_MS = 85_000

const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i

export type CareerSiteGmailSourceRequest = {
  query?: string
  after?: string
  maxMessagesPerAccount: number
}

export type CareerSiteGmailAccount = {
  accountEmail: string
  status: 'ACTIVE'
}

export type CareerSiteGmailMessage = {
  accountEmail: string
  externalMessageId: string
  externalThreadId: string | null
  receivedAt: string
  from: string
  subject: string
  snippet: string
  bodyText: string
  urls: string[]
}

export type CareerSiteGmailSourceConfiguration = {
  enabled: boolean
  sourceApp: typeof CAREER_SITE_SOURCE_APP
  ownerEmail: typeof CAREER_SITE_OWNER_EMAIL
  organizationId: typeof CAREER_SITE_ORGANIZATION_ID
}

export class CareerSiteGmailSourceRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'CAREER_SITE_GMAIL_SOURCE_REQUEST_INVALID',
  ) {
    super(message)
    this.name = 'CareerSiteGmailSourceRequestError'
  }
}

export class CareerSiteGmailSourceConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CareerSiteGmailSourceConfigurationError'
  }
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host.length > 253 || isIP(host) !== 0) return false
  if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return false
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.invalid')
    || host.endsWith('.test')
    || /^(?:.+\.)?example\.(?:com|net|org)$/.test(host)
  ) return false
  return host.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))
}

export function extractPublicHttpsUrls(values: readonly string[]): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const source = typeof value === 'string' ? value.slice(0, 100_000) : ''
    const matches = source.match(/https:\/\/[^\s<>"'`\\]+/gi) || []
    for (const match of matches) {
      const candidate = match
        .replace(/&amp;/gi, '&')
        .replace(/[),.;:!?\]}]+$/g, '')
      if (!candidate || candidate.length > 2_048) continue
      try {
        const url = new URL(candidate)
        if (
          url.protocol !== 'https:'
          || url.username
          || url.password
          || (url.port && url.port !== '443')
          || !isPublicHostname(url.hostname)
        ) continue
        url.hostname = url.hostname.toLowerCase()
        const normalized = url.toString()
        if (normalized.length > 2_048) continue
        if (seen.has(normalized)) continue
        seen.add(normalized)
        urls.push(normalized)
        if (urls.length >= MAX_GMAIL_PUBLIC_URLS) return urls
      } catch {
        // Unparseable provider content is not a public URL.
      }
    }
  }
  return urls
}

function optionalQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new CareerSiteGmailSourceRequestError('query must be text')
  }
  const query = value.trim()
  const tokens = query.split(/\s+/)
  const isOr = (token: string) => token.toUpperCase() === 'OR'
  const normalizedTokens = tokens.map((token) => isOr(token) ? 'OR' : token)
  if (
    !query
    || query.length > MAX_QUERY_CHARS
    || /[\u0000-\u001f\u007f]/.test(query)
    || isOr(tokens[0])
    || isOr(tokens[tokens.length - 1])
    || tokens.some((token, index) => (
      ['AND', 'AROUND'].includes(token.toUpperCase())
      || (isOr(token) && isOr(tokens[index - 1] || ''))
      || (!isOr(token)
        && !/^-?(?:[a-z][a-z0-9_-]{0,63}:)?[a-z0-9][a-z0-9@._+\/-]{0,255}$/i.test(token))
    ))
  ) {
    throw new CareerSiteGmailSourceRequestError(
      'query must contain only safe Gmail refinement tokens',
    )
  }
  return normalizedTokens.join(' ')
}

function optionalAfter(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !RFC3339_TIMESTAMP.test(value)) {
    throw new CareerSiteGmailSourceRequestError('after must be an ISO timestamp')
  }
  const [datePart, timePart] = value.split('T')
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute, second] = timePart.slice(0, 8).split(':').map(Number)
  const calendarDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day
    || calendarDate.getUTCHours() !== hour
    || calendarDate.getUTCMinutes() !== minute
    || calendarDate.getUTCSeconds() !== second
  ) {
    throw new CareerSiteGmailSourceRequestError('after must be an ISO timestamp')
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new CareerSiteGmailSourceRequestError('after must be an ISO timestamp')
  }
  return parsed.toISOString()
}

function maximumMessages(value: unknown): number {
  if (value === undefined) return DEFAULT_GMAIL_MESSAGES_PER_ACCOUNT
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 1
    || value > MAX_GMAIL_MESSAGES_PER_ACCOUNT
  ) {
    throw new CareerSiteGmailSourceRequestError(
      `maxMessagesPerAccount must be an integer from 1 to ${MAX_GMAIL_MESSAGES_PER_ACCOUNT}`,
    )
  }
  return value
}

export function parseCareerSiteGmailSourceRequest(
  value: unknown,
): CareerSiteGmailSourceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CareerSiteGmailSourceRequestError('Request body must be a JSON object')
  }
  const record = value as Record<string, unknown>
  const supportedFields = new Set(['query', 'after', 'maxMessagesPerAccount'])
  const unsupported = Object.keys(record).find((field) => !supportedFields.has(field))
  if (unsupported) {
    throw new CareerSiteGmailSourceRequestError(
      `Unsupported Career Desk Gmail source field: ${unsupported}`,
    )
  }

  const query = optionalQuery(record.query)
  const after = optionalAfter(record.after)
  return {
    ...(query ? { query } : {}),
    ...(after ? { after } : {}),
    maxMessagesPerAccount: maximumMessages(record.maxMessagesPerAccount),
  }
}

export function resolveCareerSiteGmailSourceConfiguration(): CareerSiteGmailSourceConfiguration {
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
    throw new CareerSiteGmailSourceConfigurationError(
      'Career Desk Gmail source identity is not configured',
    )
  }
  return {
    enabled: process.env.CAREER_SITE_AGENTS_ENABLED === '1',
    sourceApp: CAREER_SITE_SOURCE_APP,
    ownerEmail: CAREER_SITE_OWNER_EMAIL,
    organizationId: CAREER_SITE_ORGANIZATION_ID,
  }
}
