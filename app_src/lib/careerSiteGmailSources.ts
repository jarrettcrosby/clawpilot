import {
  extractPublicHttpsUrls,
  GMAIL_SOURCE_DEADLINE_MS,
  MAX_GMAIL_ACTIVE_ACCOUNTS,
  MAX_GMAIL_BODY_TEXT_CHARS,
  MAX_GMAIL_MESSAGES_PER_ACCOUNT,
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
const GMAIL_LIST_PAGE_SIZE = MAX_GMAIL_MESSAGES_PER_ACCOUNT
const MAX_GMAIL_LIST_PAGES_PER_ACCOUNT = 4
const MAX_GMAIL_CANDIDATES_PER_ACCOUNT = (
  GMAIL_LIST_PAGE_SIZE * MAX_GMAIL_LIST_PAGES_PER_ACCOUNT
)
const MAX_GMAIL_TOTAL_CANDIDATES = MAX_GMAIL_TOTAL_MESSAGES * 4
const GMAIL_CANDIDATE_FETCH_BATCH_SIZE = GMAIL_REQUEST_CONCURRENCY * 2
const MAX_GMAIL_PAGE_TOKEN_CHARS = 2_048
export const CAREER_GMAIL_IMMUTABLE_QUERY = '{"job alert" "recommended jobs" "jobs you may be interested in" "new matches for you" recruiter recruiting hiring application "talent acquisition" "hiring manager" interview "your application" "application update" subject:(job OR role OR position OR opportunity)} -in:spam -in:trash'
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

type ActiveGmailConnection = ActiveMatonGatewayConnection & {
  accountEmail: string
}

type GmailMessageCandidate = {
  connection: ActiveGmailConnection
  messageId: string
}

type CareerGmailMessageSignals = {
  senderEmail: string
  subject: string
  snippet: string
  bodyText: string
  labelIds: readonly string[]
  listUnsubscribe: string
  listId?: string
  feedbackId?: string
  precedence: string
  autoSubmitted: string
}

const DIRECT_RECRUITING_PATTERN = /\b(?:recruiter|recruiting|talent acquisition|talent partner|hiring manager|headhunter|executive search|sourcer|sourcing (?:for|a candidate))\b/i
const INTERVIEW_PATTERN = /\b(?:interview|phone screen|screening call|candidate interview|meet (?:the|our) hiring (?:manager|team))\b/i
const APPLICATION_STATUS_PATTERN = /\b(?:your application|application (?:for|to|status|update)|thank you for appl(?:y|ying)|we (?:have )?received your application|candidate (?:portal|profile|application)|next steps? (?:for|in) (?:your )?application)\b/i
const JOB_ALERT_PATTERN = /\b(?:job alert|new jobs? (?:for|matching)|recommended jobs?|jobs? you may be interested in|new matches for you)\b/i
const ROLE_PATTERN = /\b(?:job|role|position|opening|vacancy|career opportunity|leadership opportunity|employment opportunity)\b/i
const EXECUTIVE_TITLE_PATTERN = /\b(?:vp|svp|evp|vice president|director|head of|chief (?:operating|technology|information|financial|supply chain|people|commercial) officer|coo|cto|cio|cfo|cpo)\b/i
const EMPLOYMENT_CONTEXT_PATTERN = /\b(?:hiring|candidate|resume|résumé|compensation|salary|employment|career|job description|requisition)\b/i
const HUMAN_OUTREACH_PATTERN = /\b(?:(?:came across|found|reviewed|saw|noticed) your (?:profile|background|experience)|your (?:profile|background|experience) (?:(?:caught|grabbed) my (?:eye|attention)|stood out|(?:aligns|matches|fits))|(?:strong|great|excellent|good|potential) fit|would you be open|open to (?:a |an )?(?:quick )?(?:call|chat|conversation|discussion|hearing|learning|exploring)|quick (?:call|chat|conversation)|connect (?:about|regarding|to discuss)|discuss (?:a|an|the|this) (?:job|role|position|opportunity))\b/i
const INTERVIEW_SCHEDULING_PATTERN = /\b(?:schedule|scheduled|scheduling|availability|available times?|calendar|appointment|zoom|microsoft teams|google meet|reschedule)\b/i
const MEDIA_INTERVIEW_PATTERN = /\b(?:podcast|show|episode|publication|article|webinar|guest appearance|on camera|livestream|live stream)\b/i
const CONSUMER_PROMOTION_PATTERN = /\b(?:apr|auto loans?|car loans?|mortgage|refinanc(?:e|ing)|credit cards?|checking account|savings account|cash back|rewards points?|insurance quote|pre-?approved|limited[- ]time offer|coupon|percent off|\d{1,2}% off|shop now)\b/i
const NON_EMPLOYMENT_APPLICATION_PATTERN = /\b(?:admissions?|college|university|mba|degree program|enrollment|student|mortgage|loan|credit|rental|lease|apartment|insurance|membership|grant application)\b/i
const MARKETING_SUBJECT_PATTERN = /\b(?:sale|save \$|save \d|newsletter|weekly digest|exclusive offer|special offer|member offer|ends (?:today|soon)|new cars?|travel deals?)\b/i
const MARKETING_SENDER_PATTERN = /(?:^|[.@_+-])(?:marketing|newsletter|offers?|promotions?|deals?)(?:[.@_+-]|$)/i
const BOOKING_CTA_PATTERN = /\bbook now\b/i
const CAREER_COACHING_SUBJECT_PATTERN = /\b(?:interview|career|job search|resume|résumé) (?:coach(?:ing)?|prep(?:aration)?)\b/i
const RECRUITING_SENDER_PATTERN = /^(?:recruiter|recruiting|talent|careers?|jobs?|people)(?:[.+_-][^@]+)?@/i
const JOB_PLATFORM_DOMAINS = [
  'ashbyhq.com',
  'bamboohr.com',
  'greenhouse.io',
  'icims.com',
  'indeed.com',
  'jobvite.com',
  'lever.co',
  'linkedin.com',
  'myworkday.com',
  'myworkdayjobs.com',
  'oraclecloud.com',
  'successfactors.com',
  'smartrecruiters.com',
  'ultipro.com',
  'workablemail.com',
  'workday.com',
  'ziprecruiter.com',
] as const

function senderDomain(senderEmail: string): string {
  return senderEmail.split('@').pop()?.toLowerCase() || ''
}

function knownJobPlatform(senderEmail: string): boolean {
  const domain = senderDomain(senderEmail)
  return JOB_PLATFORM_DOMAINS.some((candidate) => (
    domain === candidate || domain.endsWith(`.${candidate}`)
  ))
}

/**
 * Gmail search is only a coarse candidate selector. This second deterministic
 * gate prevents generic uses of "application" or "opportunity" in consumer
 * marketing from becoming Career Desk inbox records.
 */
export function careerGmailMessageIsRelevant(
  input: CareerGmailMessageSignals,
): boolean {
  const labels = new Set(input.labelIds.map((label) => label.trim().toUpperCase()))
  if (labels.has('SPAM') || labels.has('TRASH')) return false

  const subject = input.subject.slice(0, 1_000)
  const searchable = [subject, input.snippet, input.bodyText.slice(0, 12_000)].join('\n')
  const directRecruiting = (
    DIRECT_RECRUITING_PATTERN.test(searchable)
    || DIRECT_RECRUITING_PATTERN.test(input.senderEmail)
    || RECRUITING_SENDER_PATTERN.test(input.senderEmail)
  )
  const interview = INTERVIEW_PATTERN.test(searchable)
  const applicationStatus = APPLICATION_STATUS_PATTERN.test(searchable)
  const jobAlert = JOB_ALERT_PATTERN.test(searchable)
  const humanOutreach = HUMAN_OUTREACH_PATTERN.test(searchable)
  const executiveTitle = EXECUTIVE_TITLE_PATTERN.test(searchable)
  const employmentContext = EMPLOYMENT_CONTEXT_PATTERN.test(searchable)
  const explicitRole = ROLE_PATTERN.test(searchable)
  const roleEvidence = explicitRole || executiveTitle
  const jobPlatform = knownJobPlatform(input.senderEmail)
  const recruitingSender = (
    DIRECT_RECRUITING_PATTERN.test(input.senderEmail)
    || RECRUITING_SENDER_PATTERN.test(input.senderEmail)
    || jobPlatform
  )
  const employmentApplicationProvenance = (
    applicationStatus
    && /\b(?:hiring manager|candidate|requisition|job application|employment application)\b/i.test(searchable)
  )
  const personalizedRoleOutreach = humanOutreach && roleEvidence
  const independentEmploymentProvenance = (
    employmentContext
    || directRecruiting
    || jobPlatform
    || employmentApplicationProvenance
  )
  const applicationRoleEvidence = explicitRole || executiveTitle
  const applicationCareerContext = (
    applicationStatus
    && (independentEmploymentProvenance || applicationRoleEvidence)
  )
  const employmentInterview = (
    interview
    && (independentEmploymentProvenance || personalizedRoleOutreach)
  )
  const interviewScheduling = interview && INTERVIEW_SCHEDULING_PATTERN.test(searchable)
  const roleWithCareerContext = (
    roleEvidence
    && (independentEmploymentProvenance || humanOutreach)
  )
  const platformMessage = (
    jobPlatform
    && (roleEvidence || applicationCareerContext || interview || jobAlert)
  )
  if (
    !directRecruiting
    && !interview
    && !applicationCareerContext
    && !jobAlert
    && !personalizedRoleOutreach
    && !roleWithCareerContext
    && !platformMessage
  ) return false

  const nonEmploymentApplicationOrInterview = (
    (applicationStatus || interview)
    && NON_EMPLOYMENT_APPLICATION_PATTERN.test(searchable)
    && !independentEmploymentProvenance
    && !personalizedRoleOutreach
    && !(applicationStatus && explicitRole && executiveTitle)
  )
  const mediaInterview = (
    interview
    && MEDIA_INTERVIEW_PATTERN.test(searchable)
    && !recruitingSender
    && !employmentApplicationProvenance
  )
  if (nonEmploymentApplicationOrInterview || mediaInterview) return false

  const bookingPromotion = (
    BOOKING_CTA_PATTERN.test(searchable)
    && (
      CAREER_COACHING_SUBJECT_PATTERN.test(subject)
      || MARKETING_SUBJECT_PATTERN.test(subject)
      || MARKETING_SENDER_PATTERN.test(input.senderEmail)
    )
    && !directRecruiting
    && !jobPlatform
    && !personalizedRoleOutreach
  )
  if (bookingPromotion) return false

  const consumerPromotion = (
    CONSUMER_PROMOTION_PATTERN.test(subject)
    || CONSUMER_PROMOTION_PATTERN.test(searchable)
  )
  const explicitCareerSubject = (
    DIRECT_RECRUITING_PATTERN.test(subject)
    || JOB_ALERT_PATTERN.test(subject)
    || ROLE_PATTERN.test(subject)
    || EXECUTIVE_TITLE_PATTERN.test(subject)
  )
  if (consumerPromotion && !explicitCareerSubject) return false

  const bulkMessage = (
    labels.has('CATEGORY_PROMOTIONS')
    || labels.has('CATEGORY_SOCIAL')
    || labels.has('CATEGORY_FORUMS')
    || Boolean(String(input.listUnsubscribe || '').trim())
    || Boolean(String(input.listId || '').trim())
    || Boolean(String(input.feedbackId || '').trim())
    || MARKETING_SENDER_PATTERN.test(input.senderEmail)
    || /\b(?:bulk|list|junk)\b/i.test(input.precedence)
    || /\bauto-(?:generated|replied)\b/i.test(input.autoSubmitted)
  )
  if (bulkMessage) {
    return (
      jobAlert
      || employmentInterview
      || interviewScheduling
      || applicationCareerContext
      || platformMessage
      || (humanOutreach && roleEvidence && !MARKETING_SUBJECT_PATTERN.test(subject))
    )
  }

  return (
    interview
    || jobAlert
    || applicationCareerContext
    || platformMessage
    || roleWithCareerContext
    || (directRecruiting && (roleEvidence || humanOutreach))
    || (humanOutreach && roleEvidence)
  )
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

function listedNextPageToken(payload: Record<string, unknown>): string | null {
  if (payload.nextPageToken === undefined) return null
  const token = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : ''
  if (
    !token
    || token !== token.trim()
    || token.length > MAX_GMAIL_PAGE_TOKEN_CHARS
    || !/^[\x21-\x7e]+$/.test(token)
  ) throw providerError()
  return token
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
  const candidateLimit = Math.min(
    MAX_GMAIL_CANDIDATES_PER_ACCOUNT,
    Math.max(
      GMAIL_LIST_PAGE_SIZE,
      input.request.maxMessagesPerAccount * MAX_GMAIL_LIST_PAGES_PER_ACCOUNT,
    ),
  )
  const messageIds: string[] = []
  const seenMessageIds = new Set<string>()
  const seenPageTokens = new Set<string>()
  let pageToken: string | null = null

  for (
    let page = 0;
    page < MAX_GMAIL_LIST_PAGES_PER_ACCOUNT && messageIds.length < candidateLimit;
    page += 1
  ) {
    const parameters = new URLSearchParams({
      maxResults: String(GMAIL_LIST_PAGE_SIZE),
      q: gmailSearchQuery(input.request),
    })
    if (pageToken) parameters.set('pageToken', pageToken)
    const payload = await gmailJson(
      input,
      `${GMAIL_MESSAGES_PATH}?${parameters.toString()}`,
      'list',
    )
    for (const messageId of listedMessageIds(payload)) {
      if (seenMessageIds.has(messageId)) continue
      seenMessageIds.add(messageId)
      messageIds.push(messageId)
      if (messageIds.length >= candidateLimit) return messageIds
    }
    const nextPageToken = listedNextPageToken(payload)
    if (!nextPageToken) return messageIds
    if (seenPageTokens.has(nextPageToken)) throw providerError()
    seenPageTokens.add(nextPageToken)
    pageToken = nextPageToken
  }
  return messageIds
}

function header(part: GmailMessagePart | undefined, name: string): string {
  const normalized = name.toLowerCase()
  return Array.isArray(part?.headers)
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
  if (!careerGmailMessageIsRelevant({
    senderEmail,
    subject: parsed.subject,
    snippet,
    bodyText,
    labelIds: parsed.labelIds,
    listUnsubscribe: header(payload.payload as GmailMessagePart, 'list-unsubscribe'),
    listId: header(payload.payload as GmailMessagePart, 'list-id'),
    feedbackId: header(payload.payload as GmailMessagePart, 'feedback-id'),
    precedence: header(payload.payload as GmailMessagePart, 'precedence'),
    autoSubmitted: header(payload.payload as GmailMessagePart, 'auto-submitted'),
  })) return null
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
  for (let index = 0; candidates.length < MAX_GMAIL_TOTAL_CANDIDATES; index += 1) {
    let added = false
    for (const account of listed) {
      const messageId = account.messageIds[index]
      if (!messageId) continue
      candidates.push({ connection: account.connection, messageId })
      added = true
      if (candidates.length >= MAX_GMAIL_TOTAL_CANDIDATES) return candidates
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
    const candidates = boundedCandidates(listed)
    const eligible: CareerSiteGmailMessage[] = []
    const eligibleByAccount = new Map<string, number>()
    for (
      let offset = 0;
      offset < candidates.length && eligible.length < MAX_GMAIL_TOTAL_MESSAGES;
      offset += GMAIL_CANDIDATE_FETCH_BATCH_SIZE
    ) {
      const fetched = await mapWithConcurrency(
        candidates.slice(offset, offset + GMAIL_CANDIDATE_FETCH_BATCH_SIZE),
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
      for (const message of fetched) {
        if (!message) continue
        const accountCount = eligibleByAccount.get(message.accountEmail) || 0
        if (accountCount >= input.request.maxMessagesPerAccount) continue
        eligible.push(message)
        eligibleByAccount.set(message.accountEmail, accountCount + 1)
        if (eligible.length >= MAX_GMAIL_TOTAL_MESSAGES) break
      }
      if (connections.every((connection) => (
        (eligibleByAccount.get(connection.accountEmail) || 0)
          >= input.request.maxMessagesPerAccount
      ))) break
    }
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
