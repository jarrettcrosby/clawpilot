import {
  extractPublicHttpsUrls,
  MAX_GMAIL_BODY_TEXT_CHARS,
  MAX_GMAIL_SNIPPET_CHARS,
  type CareerSiteGmailAccount,
  type CareerSiteGmailMessage,
  type CareerSiteGmailSourceRequest,
} from '@/lib/careerSiteGmailSourceContract'
import {
  decodeGmailBodyData,
  parseGmailMessage,
  type GmailMessage,
  type GmailMessagePart,
} from '@/lib/crm/emailIngestion'
import { matonFetch } from '@/lib/maton'
import {
  readActiveMatonConnectionsFromPostgres,
  type ActiveMatonGatewayConnection,
} from '@/lib/persistence/matonCredentials'

const GMAIL_APP = 'google-mail'
const GMAIL_MESSAGES_PATH = '/google-mail/gmail/v1/users/me/messages'
const MAX_ACTIVE_GMAIL_ACCOUNTS = 20
const MAX_RAW_URL_SOURCE_CHARS = 50_000
const MESSAGE_FETCH_CONCURRENCY = 5
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

type ActiveGmailConnection = ActiveMatonGatewayConnection & {
  accountEmail: string
}

export class CareerSiteGmailSourceError extends Error {
  constructor(
    message: string,
    readonly status: 502 | 503,
    readonly code: string,
  ) {
    super(message)
    this.name = 'CareerSiteGmailSourceError'
  }
}

function providerError(): CareerSiteGmailSourceError {
  return new CareerSiteGmailSourceError(
    'The Gmail source provider is temporarily unavailable',
    502,
    'CAREER_SITE_GMAIL_SOURCE_PROVIDER_FAILED',
  )
}

function configurationError(): CareerSiteGmailSourceError {
  return new CareerSiteGmailSourceError(
    'The Gmail source accounts are not configured safely',
    503,
    'CAREER_SITE_GMAIL_SOURCE_CONFIGURATION_INVALID',
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeMessageId(value: unknown): string {
  const identifier = typeof value === 'string' ? value.trim() : ''
  if (!identifier || identifier.length > 512 || !/^[\x21-\x7e]+$/.test(identifier)) {
    throw providerError()
  }
  return identifier
}

async function activeGmailConnections(ownerEmail: string): Promise<ActiveGmailConnection[]> {
  let connections: ActiveMatonGatewayConnection[]
  try {
    connections = await readActiveMatonConnectionsFromPostgres({
      ownerEmail,
      app: GMAIL_APP,
    })
  } catch {
    throw new CareerSiteGmailSourceError(
      'The Gmail source account registry is temporarily unavailable',
      503,
      'CAREER_SITE_GMAIL_SOURCE_REGISTRY_UNAVAILABLE',
    )
  }
  if (connections.length > MAX_ACTIVE_GMAIL_ACCOUNTS) throw configurationError()

  return connections.map((connection) => {
    const accountEmail = String(connection.accountEmail || '').trim().toLowerCase()
    if (
      connection.status !== 'ACTIVE'
      || !accountEmail
      || accountEmail.length > 320
      || !EMAIL_PATTERN.test(accountEmail)
      || !connection.connectionId
      || connection.connectionId.length > 512
      || !/^[\x21-\x7e]+$/.test(connection.connectionId)
    ) throw configurationError()
    return { ...connection, accountEmail }
  })
}

export async function getCareerSiteGmailAccounts(
  ownerEmail: string,
): Promise<CareerSiteGmailAccount[]> {
  const connections = await activeGmailConnections(ownerEmail)
  const accountEmails = Array.from(new Set(
    connections.map((connection) => connection.accountEmail),
  )).sort((left, right) => left.localeCompare(right))
  return accountEmails.map((accountEmail) => ({ accountEmail, status: 'ACTIVE' }))
}

async function gmailJson(
  input: { ownerEmail: string; connection: ActiveGmailConnection },
  path: string,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await matonFetch(path, { method: 'GET' }, {
      ownerEmail: input.ownerEmail,
      app: GMAIL_APP,
      boundConnectionId: input.connection.connectionId,
    })
  } catch {
    throw providerError()
  }
  if (!response.ok) throw providerError()
  try {
    const payload = asRecord(await response.json())
    if (!payload) throw providerError()
    return payload
  } catch (error) {
    if (error instanceof CareerSiteGmailSourceError) throw error
    throw providerError()
  }
}

function listedMessageIds(payload: Record<string, unknown>): string[] {
  if (payload.messages === undefined) return []
  if (!Array.isArray(payload.messages)) throw providerError()
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of payload.messages) {
    const message = asRecord(entry)
    const id = safeMessageId(message?.id)
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function gmailSearchQuery(request: CareerSiteGmailSourceRequest): string | null {
  const parts: string[] = []
  if (request.after) {
    parts.push(`after:${Math.max(0, Math.floor(new Date(request.after).getTime() / 1_000))}`)
  }
  if (request.query) parts.push(`(${request.query})`)
  return parts.length > 0 ? parts.join(' ') : null
}

async function listedMessages(input: {
  ownerEmail: string
  connection: ActiveGmailConnection
  request: CareerSiteGmailSourceRequest
}): Promise<string[]> {
  const parameters = new URLSearchParams({
    maxResults: String(input.request.maxMessagesPerAccount),
  })
  const query = gmailSearchQuery(input.request)
  if (query) parameters.set('q', query)
  const payload = await gmailJson(
    input,
    `${GMAIL_MESSAGES_PATH}?${parameters.toString()}`,
  )
  return listedMessageIds(payload).slice(0, input.request.maxMessagesPerAccount)
}

function header(part: GmailMessagePart, name: string): string {
  const normalized = name.toLowerCase()
  return Array.isArray(part.headers)
    ? String(part.headers.find((item) => item?.name?.toLowerCase() === normalized)?.value || '')
    : ''
}

function rawMessageUrlSources(message: GmailMessage): string[] {
  const sources: string[] = []
  let remaining = MAX_RAW_URL_SOURCE_CHARS
  const visit = (part: GmailMessagePart | undefined) => {
    if (!part || remaining <= 0 || String(part.filename || '').trim()) return
    if (typeof part.body?.data === 'string' && part.body.data) {
      const contentType = header(part, 'content-type')
      const mimeType = String(part.mimeType || contentType.split(';', 1)[0] || '')
        .trim()
        .toLowerCase()
      if (mimeType === 'text/plain' || mimeType === 'text/html') {
        const charset = contentType.match(/charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i)
        const decoded = decodeGmailBodyData(
          part.body.data,
          charset?.[1] || charset?.[2] || charset?.[3] || 'utf-8',
        )
        const source = decoded.slice(0, remaining)
        sources.push(source)
        remaining -= source.length
      }
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) visit(child)
    }
  }
  visit(message.payload)
  return sources
}

async function getMessage(input: {
  ownerEmail: string
  connection: ActiveGmailConnection
  messageId: string
}): Promise<CareerSiteGmailMessage> {
  const payload = await gmailJson(
    input,
    `${GMAIL_MESSAGES_PATH}/${encodeURIComponent(input.messageId)}?format=full`,
  )
  let parsed: ReturnType<typeof parseGmailMessage>
  try {
    parsed = parseGmailMessage(payload as GmailMessage)
  } catch {
    throw providerError()
  }
  if (parsed.externalMessageId !== input.messageId) throw providerError()
  const bodyText = parsed.bodyText.slice(0, MAX_GMAIL_BODY_TEXT_CHARS)
  const snippet = parsed.snippet.slice(0, MAX_GMAIL_SNIPPET_CHARS)
  return {
    accountEmail: input.connection.accountEmail,
    externalMessageId: parsed.externalMessageId,
    externalThreadId: parsed.externalThreadId,
    receivedAt: parsed.receivedAt,
    from: parsed.senderEmail,
    subject: parsed.subject,
    snippet,
    bodyText,
    urls: extractPublicHttpsUrls([
      snippet,
      bodyText,
      ...rawMessageUrlSources(payload as GmailMessage),
    ]),
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(values[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  )
  return results
}

export async function searchCareerSiteGmailMessages(input: {
  ownerEmail: string
  request: CareerSiteGmailSourceRequest
}): Promise<CareerSiteGmailMessage[]> {
  const connections = await activeGmailConnections(input.ownerEmail)
  const messages: CareerSiteGmailMessage[] = []
  const seen = new Set<string>()

  for (const connection of connections) {
    const messageIds = await listedMessages({
      ownerEmail: input.ownerEmail,
      connection,
      request: input.request,
    })
    const fetched = await mapWithConcurrency(
      messageIds,
      MESSAGE_FETCH_CONCURRENCY,
      (messageId) => getMessage({
        ownerEmail: input.ownerEmail,
        connection,
        messageId,
      }),
    )
    for (const message of fetched) {
      const key = `${message.accountEmail}\u0000${message.externalMessageId}`
      if (seen.has(key)) continue
      seen.add(key)
      messages.push(message)
    }
  }

  return messages.sort((left, right) => (
    right.receivedAt.localeCompare(left.receivedAt)
    || left.accountEmail.localeCompare(right.accountEmail)
    || left.externalMessageId.localeCompare(right.externalMessageId)
  ))
}
