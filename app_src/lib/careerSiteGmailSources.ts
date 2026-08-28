import {
  extractPublicHttpsUrls,
  GMAIL_SOURCE_DEADLINE_MS,
  MAX_GMAIL_ACTIVE_ACCOUNTS,
  MAX_GMAIL_BODY_TEXT_CHARS,
  MAX_GMAIL_RESPONSE_BYTES,
  MAX_GMAIL_SNIPPET_CHARS,
  MAX_GMAIL_TOTAL_MESSAGES,
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
  readMatonCredentialReadinessFromPostgres,
  type ActiveMatonGatewayConnection,
} from '@/lib/persistence/matonCredentials'

const GMAIL_APP = 'google-mail'
const GMAIL_MESSAGES_PATH = '/google-mail/gmail/v1/users/me/messages'
const MAX_RAW_URL_SOURCE_CHARS = 50_000
const GMAIL_REQUEST_CONCURRENCY = 5
export const CAREER_GMAIL_IMMUTABLE_QUERY = '{"job alert" recruiter recruiting hiring application interview subject:(job OR role)}'
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

type ActiveGmailConnection = ActiveMatonGatewayConnection & {
  accountEmail: string
}

type GmailMessageCandidate = {
  connection: ActiveGmailConnection
  messageId: string
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

class SkippableGmailMessageError extends Error {
  constructor() {
    super('The Gmail message is unavailable')
    this.name = 'SkippableGmailMessageError'
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
  if (connections.length > MAX_GMAIL_ACTIVE_ACCOUNTS) throw configurationError()

  const accountEmails = new Set<string>()
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
      || accountEmails.has(accountEmail)
    ) throw configurationError()
    accountEmails.add(accountEmail)
    return { ...connection, accountEmail }
  })
}

export async function getCareerSiteGmailSourceReadiness(
  ownerEmail: string,
): Promise<{ ready: boolean; activeAccountCount: number }> {
  let credentialReady: boolean
  try {
    credentialReady = await readMatonCredentialReadinessFromPostgres(ownerEmail)
  } catch {
    throw new CareerSiteGmailSourceError(
      'The Gmail source credential registry is temporarily unavailable',
      503,
      'CAREER_SITE_GMAIL_SOURCE_REGISTRY_UNAVAILABLE',
    )
  }
  const connections = await activeGmailConnections(ownerEmail)
  return {
    ready: credentialReady && connections.length > 0,
    activeAccountCount: connections.length,
  }
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
  input: {
    ownerEmail: string
    connection: ActiveGmailConnection
    signal: AbortSignal
  },
  path: string,
  operation: 'list' | 'get',
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await matonFetch(path, { method: 'GET', signal: input.signal }, {
      ownerEmail: input.ownerEmail,
      app: GMAIL_APP,
      boundConnectionId: input.connection.connectionId,
    })
  } catch {
    throw providerError()
  }
  if (!response.ok) {
    if (operation === 'get' && [400, 404, 410, 422].includes(response.status)) {
      throw new SkippableGmailMessageError()
    }
    throw providerError()
  }
  try {
    const payload = asRecord(await response.json())
    if (!payload) {
      if (operation === 'get') throw new SkippableGmailMessageError()
      throw providerError()
    }
    return payload
  } catch (error) {
    if (
      error instanceof CareerSiteGmailSourceError
      || error instanceof SkippableGmailMessageError
    ) throw error
    if (operation === 'get') throw new SkippableGmailMessageError()
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
    let id: string
    try {
      id = safeMessageId(message?.id)
    } catch {
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function gmailSearchQuery(request: CareerSiteGmailSourceRequest): string {
  const parts: string[] = [`(${CAREER_GMAIL_IMMUTABLE_QUERY})`]
  if (request.after) {
    parts.push(`after:${Math.max(0, Math.floor(new Date(request.after).getTime() / 1_000))}`)
  }
  if (request.query) parts.push(`(${request.query})`)
  return parts.join(' ')
}

async function listedMessages(input: {
  ownerEmail: string
  connection: ActiveGmailConnection
  request: CareerSiteGmailSourceRequest
  signal: AbortSignal
}): Promise<string[]> {
  const parameters = new URLSearchParams({
    maxResults: String(input.request.maxMessagesPerAccount),
  })
  parameters.set('q', gmailSearchQuery(input.request))
  const payload = await gmailJson(
    input,
    `${GMAIL_MESSAGES_PATH}?${parameters.toString()}`,
    'list',
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
  signal: AbortSignal
}): Promise<CareerSiteGmailMessage | null> {
  let payload: Record<string, unknown>
  try {
    payload = await gmailJson(
      input,
      `${GMAIL_MESSAGES_PATH}/${encodeURIComponent(input.messageId)}?format=full`,
      'get',
    )
  } catch (error) {
    if (error instanceof SkippableGmailMessageError) return null
    throw error
  }
  let parsed: ReturnType<typeof parseGmailMessage>
  try {
    parsed = parseGmailMessage(payload as GmailMessage)
  } catch {
    return null
  }
  const senderEmail = String(parsed.senderEmail || '').trim().toLowerCase()
  if (
    parsed.externalMessageId !== input.messageId
    || !senderEmail
    || senderEmail.length > 320
    || !EMAIL_PATTERN.test(senderEmail)
  ) return null
  const bodyText = parsed.bodyText.slice(0, MAX_GMAIL_BODY_TEXT_CHARS).trim()
  const snippet = parsed.snippet.slice(0, MAX_GMAIL_SNIPPET_CHARS).trim()
  if (!bodyText && !snippet) return null
  let urls: string[]
  try {
    urls = extractPublicHttpsUrls([
      snippet,
      bodyText,
      ...rawMessageUrlSources(payload as GmailMessage),
    ])
  } catch {
    urls = extractPublicHttpsUrls([snippet, bodyText])
  }
  return {
    accountEmail: input.connection.accountEmail,
    externalMessageId: parsed.externalMessageId,
    externalThreadId: parsed.externalThreadId,
    receivedAt: parsed.receivedAt,
    from: senderEmail,
    subject: parsed.subject,
    snippet,
    bodyText,
    urls,
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < values.length && !signal?.aborted) {
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

function boundedCandidates(
  listed: Array<{ connection: ActiveGmailConnection; messageIds: string[] }>,
): GmailMessageCandidate[] {
  const candidates: GmailMessageCandidate[] = []
  for (let index = 0; candidates.length < MAX_GMAIL_TOTAL_MESSAGES; index += 1) {
    let added = false
    for (const account of listed) {
      const messageId = account.messageIds[index]
      if (!messageId) continue
      candidates.push({ connection: account.connection, messageId })
      added = true
      if (candidates.length >= MAX_GMAIL_TOTAL_MESSAGES) return candidates
    }
    if (!added) return candidates
  }
  return candidates
}

function boundedResponseMessages(
  messages: CareerSiteGmailMessage[],
): CareerSiteGmailMessage[] {
  const bounded: CareerSiteGmailMessage[] = []
  let bytes = Buffer.byteLength('{"ok":true,"messages":[]}', 'utf8')
  for (const message of messages) {
    const serializedBytes = Buffer.byteLength(JSON.stringify(message), 'utf8')
    const separatorBytes = bounded.length > 0 ? 1 : 0
    if (bytes + separatorBytes + serializedBytes > MAX_GMAIL_RESPONSE_BYTES) continue
    bytes += separatorBytes + serializedBytes
    bounded.push(message)
  }
  return bounded
}

function searchAbortError(timedOut: boolean): CareerSiteGmailSourceError {
  return new CareerSiteGmailSourceError(
    timedOut
      ? 'The Gmail source search exceeded its safe execution window'
      : 'The Gmail source search was cancelled',
    503,
    timedOut
      ? 'CAREER_SITE_GMAIL_SOURCE_DEADLINE_EXCEEDED'
      : 'CAREER_SITE_GMAIL_SOURCE_CANCELLED',
  )
}

export async function searchCareerSiteGmailMessages(input: {
  ownerEmail: string
  request: CareerSiteGmailSourceRequest
  signal?: AbortSignal
}): Promise<CareerSiteGmailMessage[]> {
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort()
  if (input.signal?.aborted) controller.abort()
  else input.signal?.addEventListener('abort', cancel, { once: true })
  const deadline = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, GMAIL_SOURCE_DEADLINE_MS)

  try {
    if (controller.signal.aborted) throw searchAbortError(false)
    const connections = await activeGmailConnections(input.ownerEmail)
    const listed = await mapWithConcurrency(
      connections,
      GMAIL_REQUEST_CONCURRENCY,
      async (connection) => ({
        connection,
        messageIds: await listedMessages({
          ownerEmail: input.ownerEmail,
          connection,
          request: input.request,
          signal: controller.signal,
        }),
      }),
      controller.signal,
    )
    if (controller.signal.aborted) throw searchAbortError(timedOut)
    const fetched = await mapWithConcurrency(
      boundedCandidates(listed),
      GMAIL_REQUEST_CONCURRENCY,
      (candidate) => getMessage({
        ownerEmail: input.ownerEmail,
        connection: candidate.connection,
        messageId: candidate.messageId,
        signal: controller.signal,
      }),
      controller.signal,
    )
    if (controller.signal.aborted) throw searchAbortError(timedOut)
    const eligible = fetched
      .filter((message): message is CareerSiteGmailMessage => Boolean(message))
      .slice(0, MAX_GMAIL_TOTAL_MESSAGES)
    return boundedResponseMessages(eligible).sort((left, right) => (
      right.receivedAt.localeCompare(left.receivedAt)
      || left.accountEmail.localeCompare(right.accountEmail)
      || left.externalMessageId.localeCompare(right.externalMessageId)
    ))
  } catch (error) {
    const wasAborted = controller.signal.aborted
    if (!wasAborted) controller.abort()
    if (wasAborted) throw searchAbortError(timedOut)
    throw error
  } finally {
    clearTimeout(deadline)
    input.signal?.removeEventListener('abort', cancel)
  }
}
