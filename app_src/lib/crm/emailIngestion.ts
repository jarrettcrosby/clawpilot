import crypto from 'node:crypto'
import { decodeHtmlEntities } from '@/lib/htmlEntities.mjs'
import { globalIdFragment } from '@/lib/globalIds.mjs'
import { captureEmailAddressHeaders, type EmailAddressHeaders } from '@/lib/crm/emailAddressHeaders'
import { CRM_EMAIL_PATTERN as EMAIL_PATTERN, crmParticipantEmailCandidatesSql, ordinaryGmailArchiveAddress,
  orderOrdinarySharedGmailContacts } from '@/lib/crm/participantEligibility'
import { sharedSuiteCrmEmailScope } from '@/lib/crm/suiteCrmNativeEmailProjection'
import {
  assertSameRetainedGmailEvidence, gmailMessageSourceKey, normalizeGmailMessageEvidence,
  retainedGmailMessageEvidence, verifyGmailMailboxBinding,
  GmailIdentityError,
  type GmailMessageEvidence, type VerifiedGmailMailboxIdentity,
} from '@/lib/crm/emailIdentity'
import { assertCaseyGmailAdoption, prepareCaseyGmailAdoption, prepareBoundedLegacyGmailAdoption, selectLateContactGmailMessages,
  type GmailReviewedHistoricalAdoption } from '@/lib/crm/emailReconciliation'
import { CASEY_FIRST_SEEN_SCOPE, CASEY_PAIR, assertCaseyFirstSeenEvidence, assertCaseyFirstSeenMailbox,
  assertCaseyFirstSeenPlacement, isCaseyGmailScope, matchesCaseyPair, type CaseyGmailScope } from '@/lib/crm/caseyGmailReview'
import { matonFetch } from '@/lib/maton'
import {
  enrichCrmEmailInteractionParticipantsInPostgres,
  readCrmRecordByReference,
  stageCrmRecordInPostgres,
  stageOrdinarySharedGmailInteractionInPostgres,
  stageReviewedGmailInteractionsInPostgres,
  type StageInteractionInput,
} from '@/lib/persistence/crm'
import { readVerifiedGmailMailboxIdentityInPostgres, recordGmailMessageIntakeInPostgres,
  readGmailMailboxLabelRepairSnapshotInPostgres, type GmailMailboxLabelRepairScope } from '@/lib/persistence/crmEmailIdentity'
import { query } from '@/lib/persistence/postgres'
import { resolvePipelineSpaceAccess } from '@/lib/tenancy'
import { recordAuditEvent } from '@/lib/auditWriter'

const GMAIL_APP = 'google-mail'
const GMAIL_LIST_PATH = '/google-mail/gmail/v1/users/me/messages'
const GMAIL_PAGE_SIZE = 100
const MAX_PAGES_PER_MAILBOX = 10
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000
const POLL_OVERLAP_MS = 5 * 60 * 1000
const MAX_INTERACTION_DESCRIPTION_CHARS = 50_000
const MAX_SUBJECT_CHARS = 500
const MAX_SNIPPET_CHARS = 2_000

export type GmailHeader = {
  name?: string
  value?: string
}

export type GmailMessagePart = {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: {
    attachmentId?: string
    size?: number
    data?: string
  }
  parts?: GmailMessagePart[]
}

export type GmailMessage = {
  id?: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  historyId?: string
  internalDate?: string
  sizeEstimate?: number
  payload?: GmailMessagePart
}

export type ParsedGmailMessage = {
  externalMessageId: string
  externalThreadId: string | null
  senderEmail: string
  recipientEmails: string[]
  subject: string
  receivedAt: string
  snippet: string
  bodyText: string
  markerReferences: string[]
  historyId: string | null
  labelIds: string[]
  sizeEstimate: number | null
  emailAddressHeaders: EmailAddressHeaders
}

export type EmailIngestionCounts = {
  activeMailboxes: number
  mailboxesPolled: number
  pendingMailboxes: number
  messagesListed: number
  messagesFetched: number
  authMessagesSkipped: number
  messagesStored: number
  duplicateMessages: number
  markerReferences: number
  invalidReferences: number
  senderMatches: number
  archiveMessages: number
  archiveMatches: number
  unmatchedMessages: number
  interactions: number
  links: number
  errors: number
}

type SelectedMailbox = {
  owner_email: string
  connection_id: string
  account_email: string | null
}

type OwnedPipeline = {
  id: string
  is_default: boolean
}

export type ReviewedGmailAssociation = {
  messageId: string
  threadId: string
  primaryOrganizationReference: string
  contactReferences: string[]
}

type CursorRow = {
  cursor_value: string | null
  last_polled_at: string | Date | null
}

type PollCursor = {
  since: string
  pollStartedAt: string
  pageToken?: string
}

type StoredInboundMessage = {
  id: string
  pipelineId: string
  inserted: boolean
  identityStatus?: 'verified' | 'unknown'
  sourceId?: string
}

type CrmReferenceRecord = Awaited<ReturnType<typeof readCrmRecordByReference>>
type ReferenceTarget = {
  record: CrmReferenceRecord
  pipelineId: string
  matchedBy: 'marker' | 'sender-email' | 'archive-email' | 'participant-email'
  matchedEmail?: string
  ordinaryShared?: { organizationId: string; email: string }
}

type MessageProcessResult = {
  inserted: boolean
  markerReferences: number
  invalidReferences: number
  senderMatches: number
  archiveMessage: boolean
  archiveMatches: number
  unmatched: boolean
  interactions: number
  links: number
}

export class SafeEmailIngestionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafeEmailIngestionError'
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function cleanSingleLine(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

export function archiveMailboxEmail(): string {
  return ordinaryGmailArchiveAddress()
}

function safeIdentifier(value: unknown, required: boolean): string | null {
  const identifier = typeof value === 'string' ? value.trim() : ''
  if (!identifier) {
    if (required) throw new SafeEmailIngestionError('Gmail returned an invalid message identifier')
    return null
  }
  if (identifier.length > 512 || !/^[\x21-\x7e]+$/.test(identifier)) {
    throw new SafeEmailIngestionError('Gmail returned an invalid message identifier')
  }
  return identifier
}

function headerValues(part: GmailMessagePart | undefined, name: string): string[] {
  if (!Array.isArray(part?.headers)) return []
  const normalizedName = name.toLowerCase()
  return part.headers.flatMap((header) => (
    typeof header?.name === 'string'
      && header.name.toLowerCase() === normalizedName
      && typeof header.value === 'string'
      ? [header.value]
      : []
  ))
}

function firstHeader(part: GmailMessagePart | undefined, name: string): string {
  return headerValues(part, name)[0] || ''
}

export function truncateEmailImportContent(value: unknown): string {
  const content = typeof value === 'string' ? value : ''
  const boundaryIndex = content.search(/%xx/i)
  return boundaryIndex >= 0 ? content.slice(0, boundaryIndex) : content
}

export function parseCrmMarkerReferences(value: unknown): string[] {
  const searchable = truncateEmailImportContent(value)
  const references: string[] = []
  const seen = new Set<string>()

  const markerPattern = new RegExp(
    `%gslt(${globalIdFragment(['ga', 'gc', 'gi', 'gk', 'gl', 'gm', 'go'])})(?![A-Za-z0-9_])`,
    'gi',
  )
  for (const match of searchable.matchAll(markerPattern)) {
    const reference = match[1].toLowerCase()
    if (seen.has(reference)) continue
    seen.add(reference)
    references.push(reference)
  }
  return references
}

export function extractEmailAddresses(value: unknown): string[] {
  const input = typeof value === 'string' ? value : ''
  const matches = input.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi) || []
  return Array.from(new Set(matches.map((email) => email.toLowerCase())))
}

export function stripHtmlToText(value: unknown): string {
  const html = typeof value === 'string' ? value : ''
  return decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/?(?:address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function contentCharset(part: GmailMessagePart): string {
  const contentType = firstHeader(part, 'content-type')
  const match = contentType.match(/charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i)
  return cleanSingleLine(match?.[1] || match?.[2] || match?.[3] || 'utf-8', 100)
}

export function decodeGmailBodyData(value: unknown, charset = 'utf-8'): string {
  const encoded = typeof value === 'string' ? value.trim() : ''
  if (!encoded) return ''
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new SafeEmailIngestionError('Gmail returned invalid message body data')
  }
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const bytes = Buffer.from(padded, 'base64')
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function collectMessageBodies(part: GmailMessagePart, plain: string[], html: string[]): void {
  if (cleanSingleLine(part.filename, 500)) return
  const contentType = firstHeader(part, 'content-type').split(';', 1)[0]
  const mimeType = cleanSingleLine(part.mimeType || contentType, 100).toLowerCase()
  const data = part.body?.data
  if (typeof data === 'string' && data) {
    if (mimeType === 'text/plain') plain.push(decodeGmailBodyData(data, contentCharset(part)))
    else if (mimeType === 'text/html') html.push(decodeGmailBodyData(data, contentCharset(part)))
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) collectMessageBodies(child, plain, html)
  }
}

export function extractGmailMessageBody(payload: GmailMessagePart | null | undefined): string {
  if (!payload) return ''
  const plain: string[] = []
  const html: string[] = []
  collectMessageBodies(payload, plain, html)
  const selected = plain.some((part) => part.trim())
    ? plain.join('\n')
    : stripHtmlToText(html.join('\n'))
  return selected
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

/** Authentication notifications are not customer correspondence or CRM records. */
export function isClawPilotAuthEmail(message: GmailMessage): boolean {
  const subjects = headerValues(message.payload, 'subject')
  if (subjects.length !== 1) return false
  // Both products use matonMail.authMagicCodeContent. Keep this an exact
  // producer allowlist, not a broad filter for customer discussions of codes.
  const subject = subjects[0].trim().toLowerCase()
  const product = subject === 'your clawpilot sign-in code' ? 'ClawPilot'
    : subject === 'your career desk sign-in code' ? 'Career Desk' : null
  if (!product) return false

  // Use the actual top-level From address, never a matching Reply-To, quoted
  // message header, display-name address, or CRM contact identity.
  const fromHeaders = headerValues(message.payload, 'from')
  if (fromHeaders.length !== 1) return false
  const fromHeader = fromHeaders[0].trim()
  const namedAddress = fromHeader.match(/^(?:"[^"]*"\s*|[^<>,"]*)<([^<>]+)>$/)
  const from = (namedAddress?.[1] || fromHeader).trim().toLowerCase()
  const senders = new Set([
    process.env.CLAWPILOT_MAIL_FROM,
    process.env.CLAWPILOT_AUTH_MAIL_FROM,
    ...String(process.env.CLAWPILOT_AUTH_MAIL_ADDITIONAL_SENDERS || '').split(','),
    // Preserve recognition of messages issued before a configured sender change.
    'stewards@eigenracing.com',
  ].map((value) => String(value || '').trim().toLowerCase()).filter((value) => EMAIL_PATTERN.test(value)))
  if (!EMAIL_PATTERN.test(from) || !senders.has(from)) return false

  const purposes = headerValues(message.payload, 'x-clawpilot-message-purpose')
  if (purposes.length > 0) {
    return purposes.length === 1 && purposes[0].trim().toLowerCase() === 'auth-magic-code'
  }

  // Older notifications lack the purpose header. Match the entire original
  // template, not a keyword or a quoted code inside a customer's discussion.
  const body = extractGmailMessageBody(message.payload).replace(/\s+/g, ' ').trim()
  const legacyTemplate = body.match(/^(ClawPilot|Career Desk) sign-in (?:Your sign-in code is:|Use this code to sign in:) \d{6} This code expires in 15 minutes and can be used once\. If you did not request this code, ignore this email\.$/)
  return legacyTemplate?.[1] === product
}

function receivedAt(message: GmailMessage): string {
  const internalDate = Number(message.internalDate)
  if (Number.isFinite(internalDate) && internalDate > 0) {
    return new Date(internalDate).toISOString()
  }
  const headerDate = Date.parse(firstHeader(message.payload, 'date'))
  return new Date(Number.isFinite(headerDate) ? headerDate : Date.now()).toISOString()
}

export function parseGmailMessage(message: GmailMessage): ParsedGmailMessage {
  const externalMessageId = safeIdentifier(message?.id, true) as string
  const senderValues = ['from', 'sender', 'reply-to', 'return-path']
    .flatMap((name) => headerValues(message.payload, name))
  const recipientValues = ['to', 'cc', 'bcc', 'delivered-to', 'x-original-to', 'x-forwarded-to', 'resent-to']
    .flatMap((name) => headerValues(message.payload, name))
  const decodedBodyText = extractGmailMessageBody(message.payload)
  const bodyText = truncateEmailImportContent(decodedBodyText)
  const snippet = decodedBodyText === bodyText
    ? truncateEmailImportContent(cleanSingleLine(message.snippet, MAX_SNIPPET_CHARS))
    : cleanSingleLine(bodyText, MAX_SNIPPET_CHARS)
  const sizeEstimate = Number(message.sizeEstimate)

  return {
    externalMessageId,
    externalThreadId: safeIdentifier(message.threadId, false),
    senderEmail: senderValues.flatMap(extractEmailAddresses)[0] || '',
    recipientEmails: Array.from(new Set(recipientValues.flatMap(extractEmailAddresses))),
    subject: cleanSingleLine(firstHeader(message.payload, 'subject'), MAX_SUBJECT_CHARS),
    receivedAt: receivedAt(message),
    snippet,
    bodyText,
    markerReferences: parseCrmMarkerReferences(bodyText),
    historyId: safeIdentifier(message.historyId, false),
    labelIds: Array.isArray(message.labelIds)
      ? message.labelIds.map((label) => cleanSingleLine(label, 100)).filter(Boolean)
      : [],
    sizeEstimate: Number.isFinite(sizeEstimate) && sizeEstimate >= 0 ? sizeEstimate : null,
    emailAddressHeaders: captureEmailAddressHeaders(message.payload?.headers),
  }
}

export function sanitizeEmailIngestionError(error: unknown): string {
  return error instanceof SafeEmailIngestionError
    ? cleanSingleLine(error.message, 500)
    : 'Inbound Gmail ingestion failed'
}

function cursorKey(connectionId: string): string {
  const digest = crypto.createHash('sha256').update(connectionId).digest('hex')
  return `inbound:${digest}`
}

function validDate(value: unknown): Date | null {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function parsePollCursor(value: string | null): PollCursor | null {
  if (!value) return null
  try {
    const parsed = asRecord(JSON.parse(value))
    const since = validDate(parsed?.since)
    const pollStartedAt = validDate(parsed?.pollStartedAt)
    const pageToken = typeof parsed?.pageToken === 'string' ? parsed.pageToken : undefined
    if (!since || !pollStartedAt) return null
    if (pageToken && (pageToken.length > 4096 || /[\u0000-\u001f\u007f]/.test(pageToken))) return null
    return {
      since: since.toISOString(),
      pollStartedAt: pollStartedAt.toISOString(),
      ...(pageToken ? { pageToken } : {}),
    }
  } catch {
    return null
  }
}

async function readCursor(ownerEmail: string, key: string): Promise<CursorRow | null> {
  const result = await query<CursorRow>(
    `SELECT cursor_value, last_polled_at
     FROM crm_integration_cursors
     WHERE owner_email = $1 AND app = $2 AND cursor_key = $3`,
    [ownerEmail, GMAIL_APP, key],
  )
  return result.rows[0] || null
}

async function writeCursor(input: {
  ownerEmail: string
  key: string
  state: PollCursor | null
  lastPolledAt: string
  error: string | null
}): Promise<void> {
  await query(
    `INSERT INTO crm_integration_cursors (
       owner_email, app, cursor_key, cursor_value, last_polled_at, last_error, updated_at
     )
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, now())
     ON CONFLICT (owner_email, app, cursor_key) DO UPDATE SET
       cursor_value = EXCLUDED.cursor_value,
       last_polled_at = EXCLUDED.last_polled_at,
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [
      input.ownerEmail,
      GMAIL_APP,
      input.key,
      input.state ? JSON.stringify(input.state) : null,
      input.lastPolledAt,
      input.error,
    ],
  )
}

async function selectedMailboxes(): Promise<SelectedMailbox[]> {
  const result = await query<SelectedMailbox>(
    `SELECT app_user.email AS owner_email, connection.connection_id, connection.account_email
     FROM app_users app_user
     JOIN user_maton_connections connection ON connection.owner_email = app_user.email
     WHERE app_user.status = 'active'
       AND connection.app = $1
       AND connection.status = 'ACTIVE'
       AND connection.source = 'maton'
       AND connection.is_selected
     ORDER BY app_user.email ASC`,
    [GMAIL_APP],
  )
  return result.rows
}

async function gmailJson(
  mailbox: SelectedMailbox,
  pathname: string,
  operation: 'list' | 'get',
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await matonFetch(pathname, { method: 'GET' }, {
      ownerEmail: mailbox.owner_email,
      app: GMAIL_APP,
      boundConnectionId: mailbox.connection_id,
    })
  } catch {
    throw new SafeEmailIngestionError('Gmail gateway request failed')
  }
  if (!response.ok) {
    throw new SafeEmailIngestionError(`Gmail ${operation} request failed with status ${response.status}`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new SafeEmailIngestionError(`Gmail ${operation} returned an invalid response`)
  }
  const record = asRecord(payload)
  if (!record) throw new SafeEmailIngestionError(`Gmail ${operation} returned an invalid response`)
  return record
}

function listedMessageIds(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.messages)) return []
  const ids = payload.messages.flatMap((value) => {
    const message = asRecord(value)
    const id = typeof message?.id === 'string' ? message.id.trim() : ''
    return id && id.length <= 512 && /^[\x21-\x7e]+$/.test(id) ? [id] : []
  })
  return Array.from(new Set(ids))
}

function nextPageToken(payload: Record<string, unknown>): string | null {
  if (payload.nextPageToken === undefined || payload.nextPageToken === null || payload.nextPageToken === '') return null
  const token = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : ''
  if (!token || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new SafeEmailIngestionError('Gmail list returned an invalid page token')
  }
  return token
}

async function listGmailPage(mailbox: SelectedMailbox, state: PollCursor) {
  const after = Math.max(0, Math.floor(new Date(state.since).getTime() / 1000))
  const parameters = new URLSearchParams({
    maxResults: String(GMAIL_PAGE_SIZE),
    // A customer's conversation includes both received and sent messages.
    // CRM routing below still requires positive, organization-safe evidence.
    q: `after:${after} -in:drafts`,
  })
  if (state.pageToken) parameters.set('pageToken', state.pageToken)
  const payload = await gmailJson(mailbox, `${GMAIL_LIST_PATH}?${parameters}`, 'list')
  return {
    ids: listedMessageIds(payload),
    nextPageToken: nextPageToken(payload),
  }
}

async function getGmailMessage(mailbox: SelectedMailbox, messageId: string, metadataOnly = false): Promise<GmailMessage> {
  const format = metadataOnly ? 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject' : 'format=full'
  const payload = await gmailJson(
    mailbox,
    `${GMAIL_LIST_PATH}/${encodeURIComponent(messageId)}?${format}`,
    'get',
  )
  return payload as GmailMessage
}

async function gmailMailboxProfile(mailbox: SelectedMailbox): Promise<{ accountEmail: string }> {
  const profile = await gmailJson(mailbox, '/google-mail/gmail/v1/users/me/profile', 'get')
  const accountEmail = typeof profile.emailAddress === 'string' ? profile.emailAddress.trim().toLowerCase() : ''
  if (!EMAIL_PATTERN.test(accountEmail) || (mailbox.account_email
    && accountEmail !== mailbox.account_email.toLowerCase())) {
    throw new SafeEmailIngestionError('Gmail profile does not match the selected account')
  }
  return { accountEmail }
}

export async function readGmailMailboxProfileForOwner(input: { ownerEmail: string; connectionId: string }) {
  const mailbox = (await selectedMailboxes()).find(row => row.owner_email === input.ownerEmail
    && row.connection_id === input.connectionId)
  if (!mailbox) throw new SafeEmailIngestionError('The selected Gmail connection is not active for this owner')
  return gmailMailboxProfile(mailbox)
}

/** Explicit owner-reviewed label repair only. This fresh observation does NOT
 * verify a Google subject, repair a label, or authorize historical messages.
 * Normal ingestion and the ordinary verification reader remain strict above. */
export async function readGmailMailboxLabelRepairObservationForOwner(input: GmailMailboxLabelRepairScope) {
  const before = await readGmailMailboxLabelRepairSnapshotInPostgres(input)
  let accountEmail: string, observedAt: string
  try {
    const deadline = Date.now() + 12_000
    const response = await matonFetch('/google-mail/gmail/v1/users/me/profile', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
    }, { ownerEmail: input.ownerEmail, app: GMAIL_APP, boundConnectionId: input.connectionId })
    if (!response.ok || !response.body) throw new Error()
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0, timedOut = false
    const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}) }, Math.max(1, deadline - Date.now()))
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 8192) { await reader.cancel(); throw new Error() }
        chunks.push(part.value)
      }
      if (timedOut || Date.now() >= deadline) throw new Error()
    } finally { clearTimeout(timer); reader.releaseLock() }
    const body = asRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    accountEmail = typeof body?.emailAddress === 'string' ? body.emailAddress.trim().toLowerCase() : ''
    if (!EMAIL_PATTERN.test(accountEmail)) throw new Error()
    observedAt = new Date().toISOString()
  } catch { throw new SafeEmailIngestionError('The selected Gmail profile could not be freshly observed') }
  const after = await readGmailMailboxLabelRepairSnapshotInPostgres(input)
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new SafeEmailIngestionError('The selected Gmail connection changed during verification')
  return { snapshot: after, accountEmail, observedAt }
}

async function verifiedMailbox(mailbox: SelectedMailbox): Promise<{
  mailboxIdentity: VerifiedGmailMailboxIdentity | null
  observedAccountEmail: string
}> {
  const { accountEmail: observedAccountEmail } = await gmailMailboxProfile(mailbox)
  // A profile email is a current label, not a stable Google subject. Only a
  // trusted independently verified binding can supply canonical mailbox ID.
  const mailboxIdentity = await readVerifiedGmailMailboxIdentityInPostgres({
    ownerEmail: mailbox.owner_email, connectionId: mailbox.connection_id, accountEmail: observedAccountEmail,
  })
  return { observedAccountEmail, mailboxIdentity: mailboxIdentity ? verifyGmailMailboxBinding({
    identity: mailboxIdentity, connectionId: mailbox.connection_id, profileEmail: observedAccountEmail,
    observedAt: new Date().toISOString(),
  }) : null }
}

function fullGmailEvidence(raw: GmailMessage, parsed: ParsedGmailMessage): GmailMessageEvidence {
  // Routing markers can deliberately truncate CRM text. Canonical evidence must
  // retain the full normalized provider body, not that presentation truncation.
  const subjects = headerValues(raw.payload, 'subject')
  if (!raw.internalDate || !Number.isFinite(Number(raw.internalDate))
    || Number(raw.internalDate) <= 0) throw new SafeEmailIngestionError('Complete Gmail message evidence is unavailable')
  return normalizeGmailMessageEvidence({ ...parsed,
    subject: cleanSingleLine(subjects[0] || '', 2 * 1024 * 1024), bodyText: extractGmailMessageBody(raw.payload),
  })
}

function hasIncompleteInlineGmailText(part: GmailMessagePart | undefined): boolean {
  if (!part || cleanSingleLine(part.filename, 500)) return false
  const type = cleanSingleLine(part.mimeType || firstHeader(part, 'content-type').split(';', 1)[0], 100).toLowerCase()
  const missingText = (type === 'text/plain' || type === 'text/html') && !part.body?.data?.trim()
    && (Boolean(part.body?.attachmentId) || Number(part.body?.size) > 0)
  return missingText || (Array.isArray(part.parts) && part.parts.some(hasIncompleteInlineGmailText))
}

/** Capture only an already-delivered message through its original verified
 * mailbox snapshot. This function can never send mail or choose a replacement
 * connection. A missing/stale snapshot is held, not upgraded retrospectively. */
export async function captureDeliveredGmailMessage(input: {
  ownerEmail: string
  connectionId: string
  mailboxIdentity: VerifiedGmailMailboxIdentity
  accountEmail: string
  pipelineId: string
  messageId: string
  threadId: string | null
}): Promise<{ canonicalSourceId: string; inboundMessageId: string }> {
  if (!input.mailboxIdentity) throw new SafeEmailIngestionError('Original delivered Gmail mailbox identity is unavailable')
  try { verifyGmailMailboxBinding({ identity: input.mailboxIdentity, connectionId: input.connectionId,
    profileEmail: input.accountEmail, observedAt: new Date().toISOString() }) }
  catch { throw new SafeEmailIngestionError('Original delivered Gmail mailbox snapshot is invalid') }
  const mailbox = (await selectedMailboxes()).find(row => row.owner_email === input.ownerEmail
    && row.connection_id === input.connectionId)
  if (!mailbox) throw new SafeEmailIngestionError('Original delivered Gmail mailbox identity is unavailable')
  const current = await verifiedMailbox(mailbox)
  if (!current.mailboxIdentity || current.observedAccountEmail !== input.accountEmail
    || current.mailboxIdentity.mailboxId !== input.mailboxIdentity.mailboxId
    || current.mailboxIdentity.providerAccountId !== input.mailboxIdentity.providerAccountId
    || current.mailboxIdentity.verifiedAt !== input.mailboxIdentity.verifiedAt
    || current.mailboxIdentity.verifiedConnectionId !== input.connectionId) {
    throw new SafeEmailIngestionError('Original delivered Gmail mailbox identity changed; source capture is held')
  }
  const ownedIntakes = await query<{ id: string; is_default: boolean }>(
    `SELECT pipeline.id::text, pipeline.is_default FROM pipeline_spaces pipeline
     JOIN app_users owner_user ON owner_user.email = pipeline.owner_email AND owner_user.status = 'active'
     JOIN app_user_organization_memberships membership ON membership.organization_id = pipeline.workspace_organization_id
       AND membership.user_email = pipeline.owner_email AND membership.status = 'active'
     WHERE pipeline.owner_email = $1 AND NOT pipeline.reference_access_disabled
       AND (pipeline.id = $2::uuid OR pipeline.is_default)
     ORDER BY pipeline.id LIMIT 26`, [input.ownerEmail, input.pipelineId],
  )
  const requestedOwned = ownedIntakes.rows.find(pipeline => pipeline.id === input.pipelineId)
  const defaults = ownedIntakes.rows.filter(pipeline => pipeline.is_default)
  const intakePipeline = requestedOwned || (defaults.length === 1 ? defaults[0] : null)
  if (!intakePipeline || ownedIntakes.rows.length > 25) {
    throw new SafeEmailIngestionError('An unambiguous original mailbox-owner intake pipeline is unavailable')
  }
  const raw = await getGmailMessage(mailbox, safeIdentifier(input.messageId, true)!)
  const message = parseGmailMessage(raw)
  if (message.externalMessageId !== input.messageId || message.externalThreadId !== input.threadId
    || !message.labelIds.includes('SENT') || message.labelIds.some(label => ['DRAFT', 'SPAM', 'TRASH'].includes(label))
    || isClawPilotAuthEmail(raw)) throw new SafeEmailIngestionError('Exact delivered Gmail message identity is unavailable')
  const stored = await storeInboundMessage({ ownerEmail: input.ownerEmail, pipelineId: intakePipeline.id,
    message, mailboxIdentity: input.mailboxIdentity, connectionId: input.connectionId,
    observedAccountEmail: current.observedAccountEmail, messageEvidence: fullGmailEvidence(raw, message) })
  if (stored.identityStatus !== 'verified' || !stored.sourceId) throw new SafeEmailIngestionError('Delivered Gmail source remains unknown or conflicts with retained evidence')
  return { canonicalSourceId: stored.sourceId, inboundMessageId: stored.id }
}

async function storeInboundMessage(input: {
  ownerEmail: string
  pipelineId: string
  message: ParsedGmailMessage
  mailboxIdentity: VerifiedGmailMailboxIdentity | null
  connectionId: string
  observedAccountEmail: string
  messageEvidence: GmailMessageEvidence
}): Promise<StoredInboundMessage> {
  const message = input.message
  const rawMetadata = {
    provider: 'gmail',
    emailAddressHeaders: message.emailAddressHeaders,
    historyId: message.historyId,
    labelIds: message.labelIds,
    sizeEstimate: message.sizeEstimate,
    archiveIntake: isArchiveMessage(message),
    archiveAddress: isArchiveMessage(message) ? archiveMailboxEmail() : null,
  }
  return recordGmailMessageIntakeInPostgres({ ownerEmail: input.ownerEmail,
    connectionId: input.connectionId, intakePipelineId: input.pipelineId,
    mailboxIdentity: input.mailboxIdentity, observedAccountEmail: input.observedAccountEmail,
    observedAt: new Date().toISOString(), messageEvidence: input.messageEvidence, rawMetadata })
}

type MessageRoutingInput = {
  ownerEmail: string
  mailboxEmail?: string | null
  selfAddresses?: string[]
  defaultPipelineId: string
  ownedPipelines: OwnedPipeline[]
  message: ParsedGmailMessage
  mailboxIdentity?: VerifiedGmailMailboxIdentity | null
  connectionId?: string
  observedAccountEmail?: string
  messageEvidence?: GmailMessageEvidence
}

async function configuredMailboxAddresses(mailbox: SelectedMailbox): Promise<string[]> {
  const result = await query<{ account_email: string; identity_email: string }>(
    `SELECT account_email, identity_email
     FROM organization_communication_bindings
     WHERE credential_owner_email = $1 AND maton_connection_id = $2
       AND app = 'google-mail' AND status = 'active' AND verified_at IS NOT NULL`,
    [mailbox.owner_email, mailbox.connection_id],
  )
  return result.rows.flatMap((row) => [row.account_email, row.identity_email])
}

/** Only actual participants are routing evidence. Quoted text and delivery
 * aliases must never cause an ordinary message to enter another organization. */
export function ordinaryParticipantAddresses(input: MessageRoutingInput): string[] {
  const headers = input.message.emailAddressHeaders
  if (headers.from?.length !== 1) return []
  const excluded = new Set([
    archiveMailboxEmail(), input.ownerEmail, input.mailboxEmail || '',
    ...(input.selfAddresses || []),
    ...(input.message.labelIds.includes('SENT') ? [headers.from[0].address] : []),
  ].map((email) => email.trim().toLowerCase()))
  return Array.from(new Set([
    ...headers.from, ...(headers.to || []), ...(headers.cc || []), ...(headers.bcc || []),
  ].map((mailbox) => mailbox.address.toLowerCase())))
    .filter((email) => EMAIL_PATTERN.test(email) && !excluded.has(email))
}

async function participantEmailTargets(input: MessageRoutingInput): Promise<ReferenceTarget[]> {
  const emails = ordinaryParticipantAddresses(input)
  if (!emails.length) return []
  const matches = await query<{ pipeline_id: string; reference_code: string; email: string }>(
    crmParticipantEmailCandidatesSql(),
    [input.ownedPipelines.map((pipeline) => pipeline.id), emails],
  )
  // No primary-workspace tie breaker: an ambiguous message stays unlinked.
  if (!matches.rows.length || matches.rows.length > 100
    || new Set(matches.rows.map((row) => row.pipeline_id)).size !== 1) return []
  for (const email of emails) {
    if (new Set(matches.rows.filter((row) => row.email === email)
      .map((row) => row.reference_code)).size > 1) return []
  }
  const targets: ReferenceTarget[] = []
  for (const row of matches.rows) {
    const record = await readCrmRecordByReference({ pipelineId: row.pipeline_id, referenceCode: row.reference_code })
    if (!emails.includes(row.email) || record.email?.trim().toLowerCase() !== row.email) return []
    targets.push({
      record,
      pipelineId: row.pipeline_id,
      matchedBy: 'participant-email',
      matchedEmail: row.email,
    })
  }
  const organizationIds = [...new Set(targets.map((target) => target.record.organizationId || target.record.id))]
  if (organizationIds.length > 1) {
    // One owned pipeline is still mandatory. Only the explicit BPO shared
    // scope may automatically link more than one company to a single Email.
    const scope = sharedSuiteCrmEmailScope(targets[0].pipelineId)
    if (!scope || targets.some((target) => target.record.entity !== 'contacts'
      || !target.record.organizationId || !target.matchedEmail)) return []
    const companies = await query<{ id: string; account_type: string | null }>(
      `SELECT company.id::text, company.account_type FROM crm_organizations company
       JOIN pipeline_spaces pipeline ON pipeline.id = company.pipeline_id
       WHERE pipeline.id = $1::uuid AND pipeline.workspace_organization_id = $2::uuid
         AND company.id = ANY($3::uuid[])
         AND COALESCE(lower(company.source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')`,
      [scope.pipelineId, scope.workspaceId, organizationIds],
    )
    const accountTypes = new Map(companies.rows.map((company) => [company.id, company.account_type]))
    if (accountTypes.size !== organizationIds.length || organizationIds.some((id) => !accountTypes.has(id))) return []
    return orderOrdinarySharedGmailContacts(targets.map((target) => ({
      target, organizationId: target.record.organizationId!, email: target.matchedEmail!, referenceCode: target.record.referenceCode,
    })), accountTypes, input.message.senderEmail).map(({ target, organizationId, email }) => ({
      ...target, ordinaryShared: { organizationId, email },
    }))
  }
  return targets.sort((left, right) => (
    Number(right.record.email?.toLowerCase() === input.message.senderEmail)
    - Number(left.record.email?.toLowerCase() === input.message.senderEmail)
    || left.record.referenceCode.localeCompare(right.record.referenceCode)
  ))
}

function isArchiveMessage(message: ParsedGmailMessage): boolean {
  const archiveEmail = archiveMailboxEmail()
  return message.recipientEmails.some((email) => email.toLowerCase() === archiveEmail)
}

export function archiveCandidateAddresses(
  message: ParsedGmailMessage,
  ownerEmail: string,
  mailboxEmail?: string | null,
): string[] {
  const excluded = new Set([
    archiveMailboxEmail(),
    ownerEmail.trim().toLowerCase(),
    String(mailboxEmail || '').trim().toLowerCase(),
  ].filter(Boolean))
  const candidates = [
    message.senderEmail,
    ...message.recipientEmails,
    ...extractEmailAddresses(message.bodyText),
    ...extractEmailAddresses(message.snippet),
  ]
  return Array.from(new Set(candidates.map((email) => email.toLowerCase())))
    .filter((email) => EMAIL_PATTERN.test(email) && !excluded.has(email))
}

async function archiveEmailTargets(input: {
  ownerEmail: string
  mailboxEmail?: string | null
  defaultPipelineId: string
  ownedPipelines: OwnedPipeline[]
  message: ParsedGmailMessage
}): Promise<ReferenceTarget[]> {
  const emails = archiveCandidateAddresses(input.message, input.ownerEmail, input.mailboxEmail)
  if (emails.length === 0) return []
  const matches = await query<{
    pipeline_id: string
    reference_code: string
    email: string
  }>(
    `SELECT pipeline_id::text, reference_code, lower(btrim(email)) AS email
     FROM (
       SELECT pipeline_id, reference_code, email FROM crm_contacts
       UNION ALL
       SELECT pipeline_id, reference_code, email FROM crm_leads
       UNION ALL
       SELECT pipeline_id, reference_code, email FROM crm_organizations
     ) candidate
     WHERE pipeline_id = ANY($1::uuid[])
       AND lower(btrim(email)) = ANY($2::text[])
     ORDER BY email ASC,
       CASE WHEN pipeline_id = $3::uuid THEN 0 ELSE 1 END,
       reference_code ASC`,
    [input.ownedPipelines.map((pipeline) => pipeline.id), emails, input.defaultPipelineId],
  )

  const rowsByEmail = new Map<string, typeof matches.rows>()
  for (const row of matches.rows) {
    const rows = rowsByEmail.get(row.email) || []
    rows.push(row)
    rowsByEmail.set(row.email, rows)
  }

  const targets: ReferenceTarget[] = []
  const seen = new Set<string>()
  for (const email of emails) {
    const rows = rowsByEmail.get(email) || []
    const references = Array.from(new Set(rows.map((row) => row.reference_code)))
    if (references.length !== 1) continue
    const referenceCode = references[0]
    const row = rows.find((candidate) => candidate.pipeline_id === input.defaultPipelineId) || rows[0]
    if (!row) continue
    const key = `${row.pipeline_id}:${referenceCode}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({
      record: await readCrmRecordByReference({
        pipelineId: row.pipeline_id,
        referenceCode,
      }),
      pipelineId: row.pipeline_id,
      matchedBy: 'archive-email',
    })
  }
  return targets
}

async function explicitReferenceTarget(input: {
  defaultPipelineId: string
  ownedPipelines: OwnedPipeline[]
  referenceCode: string
}): Promise<ReferenceTarget | null> {
  const matches: ReferenceTarget[] = []
  for (const pipeline of input.ownedPipelines) {
    try {
      matches.push({
        record: await readCrmRecordByReference({
          pipelineId: pipeline.id,
          referenceCode: input.referenceCode,
        }),
        pipelineId: pipeline.id,
        matchedBy: 'marker',
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'CRM record not found') continue
      throw error
    }
  }
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]
  if (/^g[ac]/.test(input.referenceCode)) {
    return matches.find((match) => match.pipelineId === input.defaultPipelineId) || matches[0]
  }
  throw new SafeEmailIngestionError('CRM reference resolved ambiguously across owned pipelines')
}

async function referenceTargets(input: MessageRoutingInput): Promise<{
  targets: ReferenceTarget[]
  invalidReferences: number
  senderMatches: number
  archiveMessage: boolean
  archiveMatches: number
}> {
  const archiveMessage = isArchiveMessage(input.message)
  if (input.message.markerReferences.length === 0) {
    if (archiveMessage) {
      const targets = await archiveEmailTargets(input)
      return {
        targets,
        invalidReferences: 0,
        senderMatches: 0,
        archiveMessage: true,
        archiveMatches: targets.length,
      }
    }
    const targets = await participantEmailTargets(input)
    return {
      targets,
      invalidReferences: 0,
      senderMatches: targets.length,
      archiveMessage: false,
      archiveMatches: 0,
    }
  }

  const targets: ReferenceTarget[] = []
  let invalidReferences = 0
  for (const referenceCode of input.message.markerReferences) {
    const target = await explicitReferenceTarget({
      defaultPipelineId: input.defaultPipelineId,
      ownedPipelines: input.ownedPipelines,
      referenceCode,
    })
    if (target) targets.push(target)
    else invalidReferences += 1
  }
  return {
    targets,
    invalidReferences,
    senderMatches: 0,
    archiveMessage,
    archiveMatches: 0,
  }
}

function interactionRelations(record: CrmReferenceRecord) {
  const parentSuiteCrmType = ({
    organizations: 'Accounts',
    contacts: 'Contacts',
    leads: 'Leads',
    opportunities: 'Opportunities',
    meetings: 'Meetings',
    campaigns: 'Campaigns',
  } as const)[record.entity as Exclude<CrmReferenceRecord['entity'], 'interactions' | 'products'>] || null
  return {
    organizationId: record.entity === 'organizations' ? record.id : record.organizationId,
    contactId: record.entity === 'contacts' ? record.id : null,
    leadId: record.entity === 'leads' ? record.id : null,
    opportunityId: record.entity === 'opportunities' ? record.id : null,
    meetingId: record.entity === 'meetings' ? record.id : null,
    campaignId: record.entity === 'campaigns' ? record.id : null,
    parentSuiteCrmId: parentSuiteCrmType ? record.suiteCrmId : null,
    parentSuiteCrmType: parentSuiteCrmType || undefined,
  }
}

function interactionSourceKey(ownerEmail: string, messageId: string, referenceCode: string): string {
  const digest = crypto.createHash('sha256')
    .update(ownerEmail)
    .update('\u0000')
    .update(messageId)
    .update('\u0000')
    .update(referenceCode)
    .digest('hex')
  return `gmail:inbound:${digest}`
}

async function completedLinks(inboundMessageId: string): Promise<Map<string, string>> {
  const result = await query<{ reference_code: string; interaction_id: string | null }>(
    `SELECT reference_code, interaction_id::text
     FROM crm_inbound_message_links
     WHERE inbound_message_id = $1::uuid`,
    [inboundMessageId],
  )
  return new Map(result.rows.flatMap((row) => (
    row.interaction_id ? [[row.reference_code, row.interaction_id] as const] : []
  )))
}

type ReferenceTargetGroup = {
  primary: ReferenceTarget
  targets: ReferenceTarget[]
}

const TARGET_PRIORITY: Record<CrmReferenceRecord['entity'], number> = {
  contacts: 0,
  leads: 1,
  opportunities: 2,
  meetings: 3,
  campaigns: 4,
  organizations: 5,
  interactions: 6,
  products: 7,
}

function groupReferenceTargets(targets: ReferenceTarget[]): ReferenceTargetGroup[] {
  const unique = Array.from(new Map(targets.map((target) => (
    [`${target.pipelineId}:${target.record.referenceCode}`, target] as const
  ))).values())
  if (unique.length && unique.every((target) => target.matchedBy === 'participant-email')) {
    return [{ primary: unique[0], targets: unique }]
  }
  const organizations = unique.filter((target) => target.record.entity === 'organizations')
  const groups = unique
    .filter((target) => target.record.entity !== 'organizations')
    .sort((left, right) => TARGET_PRIORITY[left.record.entity] - TARGET_PRIORITY[right.record.entity])
    .map((primary) => ({ primary, targets: [primary] }))

  for (const organization of organizations) {
    const related = groups.filter((group) => (
      group.primary.pipelineId === organization.pipelineId
      && group.primary.record.organizationId === organization.record.id
    ))
    if (related.length === 1) related[0].targets.push(organization)
    else groups.push({ primary: organization, targets: [organization] })
  }
  return groups
}

async function existingProviderInteraction(input: {
  group: ReferenceTargetGroup
  message: ParsedGmailMessage
  ownerEmail: string
  mailboxIdentity: VerifiedGmailMailboxIdentity
}): Promise<string | undefined> {
  const otherPlacement = await query<{ placement_conflict: boolean }>(
    `SELECT true AS placement_conflict FROM crm_email_sources source
     JOIN crm_interactions interaction ON interaction.canonical_source_id = source.id
     WHERE source.mailbox_id = $1::uuid AND source.owner_email = $2 AND source.provider_message_id = $3
       AND interaction.pipeline_id <> $4::uuid LIMIT 1`,
    [input.mailboxIdentity.mailboxId, input.ownerEmail, input.message.externalMessageId, input.group.primary.pipelineId],
  )
  if (otherPlacement.rows.length) throw new SafeEmailIngestionError('Canonical Gmail message already has another CRM placement; explicit review is required')
  // Message/thread IDs and old reference-based source keys cannot establish an
  // original mailbox. Keep unknown/foreign candidates visible so they hold
  // rather than disappear from this lookup and cause an inferred duplicate.
  const values = [input.group.primary.pipelineId, input.message.externalMessageId]
  const existing = await query<{ id: string; provider_thread_id: string | null; suitecrm_module: string | null
    canonical_source_id: string | null; source_mailbox_id: string | null; source_owner_email: string | null
    source_message_id: string | null; source_thread_id: string | null; source_provider: string | null
    source_provider_account_id: string | null; mailbox_owner_email: string | null }>(
    `SELECT interaction.id::text, interaction.provider_thread_id, interaction.suitecrm_module,
       interaction.canonical_source_id::text, source.mailbox_id::text AS source_mailbox_id,
       source.owner_email AS source_owner_email, source.provider_message_id AS source_message_id,
       source.provider_thread_id AS source_thread_id, mailbox.provider AS source_provider,
       mailbox.provider_account_id AS source_provider_account_id, mailbox.owner_email AS mailbox_owner_email
     FROM crm_interactions interaction
     LEFT JOIN crm_email_sources source ON source.id = interaction.canonical_source_id
     LEFT JOIN crm_email_mailboxes mailbox ON mailbox.id = source.mailbox_id
     WHERE interaction.pipeline_id = $1::uuid AND interaction.provider_message_id = $2
       AND interaction.interaction_type = 'email'
     ORDER BY interaction.id LIMIT 2`,
    values,
  )
  if (existing.rows.length > 1) throw new SafeEmailIngestionError('Gmail message has ambiguous CRM interactions')
  const candidate = existing.rows[0]
  if (candidate && (!candidate.canonical_source_id || candidate.suitecrm_module !== 'Emails'
    || candidate.source_mailbox_id !== input.mailboxIdentity.mailboxId
    || candidate.source_owner_email !== input.ownerEmail || candidate.mailbox_owner_email !== input.ownerEmail
    || candidate.source_provider !== 'gmail' || candidate.source_provider_account_id !== input.mailboxIdentity.providerAccountId
    || candidate.source_message_id !== input.message.externalMessageId || candidate.source_thread_id !== input.message.externalThreadId)) {
    throw new SafeEmailIngestionError('Existing Gmail interaction has unknown or conflicting canonical mailbox provenance; explicit review is required')
  }
  if (candidate && candidate.provider_thread_id !== input.message.externalThreadId) {
    throw new SafeEmailIngestionError('Gmail message has a conflicting CRM thread identity')
  }
  if (candidate && !input.group.primary.ordinaryShared) {
    await enrichExistingParticipantInteraction({ ...input, interactionId: candidate.id, apply: false })
  }
  return candidate?.id
}

async function enrichExistingParticipantInteraction(input: {
  group: ReferenceTargetGroup
  message: ParsedGmailMessage
  ownerEmail: string
  mailboxIdentity: VerifiedGmailMailboxIdentity
  interactionId: string
  apply: boolean
}): Promise<void> {
  if (!input.group.targets.every((target) => target.matchedBy === 'participant-email')) return
  const targets = input.group.targets.map((target) => {
    if (target.record.entity !== 'contacts' && target.record.entity !== 'leads') {
      throw new SafeEmailIngestionError('Existing Gmail interaction has conflicting CRM participant evidence')
    }
    return { id: target.record.id, entity: target.record.entity,
      referenceCode: target.record.referenceCode, organizationId: target.record.organizationId,
      email: target.matchedEmail || target.record.email }
  })
  try {
    await enrichCrmEmailInteractionParticipantsInPostgres({
      pipelineId: input.group.primary.pipelineId, interactionId: input.interactionId,
      ownerEmail: input.ownerEmail, providerMessageId: input.message.externalMessageId,
      mailboxId: input.mailboxIdentity.mailboxId,
      providerThreadId: input.message.externalThreadId, targets, apply: input.apply,
    })
  } catch {
    throw new SafeEmailIngestionError('Existing Gmail interaction has conflicting CRM participant evidence')
  }
}

function inboundInteractionInput(input: {
  ownerEmail: string
  inboundMessage: StoredInboundMessage
  message: ParsedGmailMessage
  target: ReferenceTarget
  relatedReferences: string[]
  contactIds?: string[]
  organizationIds?: string[]
  mailboxIdentity?: VerifiedGmailMailboxIdentity | null
}): StageInteractionInput {
  const referenceCode = input.target.record.referenceCode
  const relations = interactionRelations(input.target.record)
  const description = (input.message.bodyText || input.message.snippet || 'Inbound email received.')
    .slice(0, MAX_INTERACTION_DESCRIPTION_CHARS)
  return {
    entity: 'interactions',
    pipelineId: input.target.pipelineId,
    sourceKey: input.mailboxIdentity && input.target.matchedBy === 'participant-email'
      ? gmailMessageSourceKey(input.mailboxIdentity, input.message.externalMessageId)
      : interactionSourceKey(input.ownerEmail, input.message.externalMessageId, referenceCode),
    actorEmail: input.ownerEmail,
    sourcePayload: {
      source: 'gmail-inbound',
      matchedBy: input.target.matchedBy,
      referenceCode,
      relatedReferences: input.relatedReferences,
      canonicalSourceId: input.inboundMessage.sourceId || null,
    },
    fields: {
      ...relations,
      ...(input.organizationIds?.length ? { organizationIds: input.organizationIds } : {}),
      ...(input.contactIds?.length ? { contactIds: input.contactIds } : {}),
      interactionType: 'email',
      subject: input.message.subject || 'Inbound email',
      agentEmail: input.ownerEmail,
      agentName: input.ownerEmail,
      occurredAt: input.message.receivedAt,
      description,
      direction: input.message.labelIds.includes('SENT') ? 'outbound' : 'inbound',
      deliveryStatus: input.message.labelIds.includes('SENT') ? 'sent' : 'received',
      providerMessageId: input.message.externalMessageId,
      providerThreadId: input.message.externalThreadId,
      metadata: {
        source: 'gmail-inbound',
        inboundMessageId: input.inboundMessage.id,
        matchedBy: input.target.matchedBy,
        referenceCode,
        relatedReferences: input.relatedReferences,
        canonicalSourceId: input.inboundMessage.sourceId || null,
      },
    },
  }
}

async function stageInboundInteraction(input: Parameters<typeof inboundInteractionInput>[0]): Promise<string> {
  const staged = await stageCrmRecordInPostgres(inboundInteractionInput(input))
  return staged.id
}

async function linkInboundTarget(input: {
  inboundMessageId: string
  target: ReferenceTarget
  interactionId: string
}): Promise<number> {
  const referenceCode = input.target.record.referenceCode
  const aggregateType = `crm_${input.target.record.entity}`
  const linked = await query(
    `INSERT INTO crm_inbound_message_links (
       inbound_message_id, reference_code, aggregate_type, aggregate_id, interaction_id, created_at
     )
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, now())
     ON CONFLICT (inbound_message_id, reference_code) DO UPDATE SET
       aggregate_type = EXCLUDED.aggregate_type,
       aggregate_id = EXCLUDED.aggregate_id,
       interaction_id = EXCLUDED.interaction_id
     WHERE (
       crm_inbound_message_links.aggregate_type,
       crm_inbound_message_links.aggregate_id,
       crm_inbound_message_links.interaction_id
     ) IS DISTINCT FROM (
       EXCLUDED.aggregate_type,
       EXCLUDED.aggregate_id,
       EXCLUDED.interaction_id
     )`,
    [input.inboundMessageId, referenceCode, aggregateType, input.target.record.id, input.interactionId],
  )
  return linked.rowCount || 0
}

async function updateInboundMessagePrimary(input: {
  inboundMessageId: string
  interactionId: string
  target: ReferenceTarget
}): Promise<void> {
  const relations = interactionRelations(input.target.record)
  await query(
    `UPDATE crm_inbound_messages SET
       interaction_id = COALESCE(interaction_id, $2::uuid),
       organization_id = COALESCE(organization_id, $3::uuid),
       contact_id = COALESCE(contact_id, $4::uuid),
       lead_id = COALESCE(lead_id, $5::uuid)
     WHERE id = $1::uuid AND (
       interaction_id, organization_id, contact_id, lead_id
     ) IS DISTINCT FROM (
       COALESCE(interaction_id, $2::uuid), COALESCE(organization_id, $3::uuid),
       COALESCE(contact_id, $4::uuid), COALESCE(lead_id, $5::uuid)
     )`,
    [
      input.inboundMessageId,
      input.interactionId,
      relations.organizationId,
      relations.contactId,
      relations.leadId,
    ],
  )
}

function routingFingerprint(targets: ReferenceTarget[]): string {
  return JSON.stringify({
    sharedPrimary: targets[0]?.ordinaryShared ? targets[0].record.id : null,
    targets: targets.map((target) => ({
      pipeline: target.pipelineId, reference: target.record.referenceCode,
      id: target.record.id, entity: target.record.entity,
      organization: target.record.organizationId, matchedBy: target.matchedBy,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  })
}

async function processMessage(
  input: MessageRoutingInput,
  reviewedRouting?: string,
): Promise<MessageProcessResult> {
  if (!input.connectionId || !input.observedAccountEmail || !input.messageEvidence) {
    throw new SafeEmailIngestionError('Gmail intake requires current verified-or-unknown source provenance')
  }
  const store = () => storeInboundMessage({ ownerEmail: input.ownerEmail, pipelineId: input.defaultPipelineId,
    message: input.message, mailboxIdentity: input.mailboxIdentity || null, connectionId: input.connectionId!,
    observedAccountEmail: input.observedAccountEmail!, messageEvidence: input.messageEvidence! })
  const held = (inbound: StoredInboundMessage): MessageProcessResult => ({ inserted: inbound.inserted,
    markerReferences: input.message.markerReferences.length, invalidReferences: 0, senderMatches: 0,
    archiveMessage: isArchiveMessage(input.message), archiveMatches: 0, unmatched: true, interactions: 0, links: 0 })
  // Acquisition remains useful without a stable verified account, but no contact,
  // marker or current selected-account label can turn unknown provenance into a match.
  if (!input.mailboxIdentity) return held(await store())
  // Acquisition is independent of matching. Normal polling retains truthful
  // current evidence even when CRM routing is ambiguous/held. Explicit recovery
  // still verifies its reviewed target CAS before any intake write.
  const acquired = reviewedRouting ? null : await store()
  if (acquired && acquired.identityStatus !== 'verified') return held(acquired)
  // Recovery must recheck live membership and routing before even caching the
  // message. Never silently substitute a different target after preview.
  const eligiblePipelines = reviewedRouting
    ? await ownedPipelines(input.ownerEmail, input.defaultPipelineId)
    : input.ownedPipelines
  const resolved = await referenceTargets({
    ownerEmail: input.ownerEmail,
    mailboxEmail: input.mailboxEmail,
    selfAddresses: input.selfAddresses,
    defaultPipelineId: input.defaultPipelineId,
    ownedPipelines: eligiblePipelines,
    message: input.message,
  })
  if (reviewedRouting && (resolved.invalidReferences
    || resolved.targets.some((target) => target.pipelineId !== input.defaultPipelineId)
    || routingFingerprint(resolved.targets) !== reviewedRouting)) {
    throw new SafeEmailIngestionError('Message routing changed after review; preview recovery again')
  }
  const groups = groupReferenceTargets(resolved.targets)
  if (groups.length > 1) return held(acquired || await store())
  const planned = []
  for (const group of groups) {
    // Validate an existing email's customer/mapping evidence before caching or
    // creating links. Apply rechecks under locks before native enrichment.
    const existingInteractionId = await existingProviderInteraction({
      group, message: input.message, ownerEmail: input.ownerEmail,
      mailboxIdentity: input.mailboxIdentity,
    })
    planned.push({ group, existingInteractionId })
  }
  const inboundMessage = acquired || await store()
  if (inboundMessage.identityStatus !== 'verified') return held(inboundMessage)
  const existingLinks = await completedLinks(inboundMessage.id)
  let interactions = 0
  let links = 0

  for (const { group, existingInteractionId } of planned) {
    const relatedReferences = group.targets.map((target) => target.record.referenceCode)
    const linkedInteractionIds = relatedReferences
      .map((referenceCode) => existingLinks.get(referenceCode))
      .filter((interactionId): interactionId is string => Boolean(interactionId))
    // A previous link is evidence to validate, not permission to redirect the
    // current message to an unrelated interaction or another pipeline.
    if (linkedInteractionIds.some((interactionId) => interactionId !== existingInteractionId)) {
      throw new SafeEmailIngestionError('Gmail message has conflicting existing CRM links')
    }
    const sharedPrimary = group.primary.ordinaryShared
    if (existingInteractionId && !sharedPrimary) await enrichExistingParticipantInteraction({
      group, message: input.message, ownerEmail: input.ownerEmail,
      mailboxIdentity: input.mailboxIdentity,
      interactionId: existingInteractionId, apply: true,
    })
    const staging = {
      ownerEmail: input.ownerEmail,
      inboundMessage,
      message: input.message,
      target: group.primary,
      relatedReferences,
      contactIds: group.targets.filter((target) => target.record.entity === 'contacts').map((target) => target.record.id),
      mailboxIdentity: input.mailboxIdentity,
    }
    let interactionId: string
    if (sharedPrimary) {
      const targets = group.targets.map(({ record, ordinaryShared }) => {
        if (!ordinaryShared) throw new SafeEmailIngestionError('Gmail message has incomplete shared participant evidence')
        return { id: record.id, referenceCode: record.referenceCode, ...ordinaryShared }
      })
      const organizationIds = [sharedPrimary.organizationId, ...[...new Set(targets.map((target) => target.organizationId))]
        .filter((id) => id !== sharedPrimary.organizationId).sort()]
      const contactIds = [group.primary.record.id, ...staging.contactIds.filter((id) => id !== group.primary.record.id).sort()]
      const result = await stageOrdinarySharedGmailInteractionInPostgres({
        interaction: inboundInteractionInput({ ...staging, organizationIds, contactIds }),
        mailboxId: input.mailboxIdentity.mailboxId, targets, expectedExistingInteractionId: existingInteractionId || null,
      })
      interactionId = result.id
      if (result.inserted) interactions += 1
    } else {
      interactionId = existingInteractionId || await stageInboundInteraction(staging)
      if (!existingInteractionId) interactions += 1
    }
    await updateInboundMessagePrimary({
      inboundMessageId: inboundMessage.id,
      interactionId,
      target: group.primary,
    })
    for (const target of group.targets) {
      if (existingLinks.has(target.record.referenceCode)) continue
      links += await linkInboundTarget({
        inboundMessageId: inboundMessage.id,
        target,
        interactionId,
      })
      existingLinks.set(target.record.referenceCode, interactionId)
    }
  }

  return {
    inserted: inboundMessage.inserted,
    markerReferences: input.message.markerReferences.length,
    invalidReferences: resolved.invalidReferences,
    senderMatches: resolved.senderMatches,
    archiveMessage: resolved.archiveMessage,
    archiveMatches: resolved.archiveMatches,
    unmatched: resolved.targets.length === 0,
    interactions,
    links,
  }
}

async function ownedPipelines(ownerEmail: string, defaultPipelineId: string): Promise<OwnedPipeline[]> {
  const result = await query<OwnedPipeline>(
    `SELECT pipeline.id::text, pipeline.is_default
     FROM pipeline_spaces pipeline
     JOIN app_user_organization_memberships membership
       ON membership.organization_id = pipeline.workspace_organization_id
       AND membership.user_email = pipeline.owner_email AND membership.status = 'active'
     WHERE pipeline.owner_email = $1 AND pipeline.reference_access_disabled = false
     ORDER BY CASE WHEN pipeline.id = $2::uuid THEN 0 ELSE 1 END, pipeline.created_at ASC, pipeline.id ASC`,
    [ownerEmail, defaultPipelineId],
  )
  if (!result.rows.some((pipeline) => pipeline.id === defaultPipelineId)) {
    throw new SafeEmailIngestionError('CRM pipeline is unavailable for Gmail ingestion')
  }
  return result.rows
}

function reviewedAssociationSelection(value: unknown, messageIds: string[]): ReviewedGmailAssociation[] | undefined {
  if (value === undefined) return undefined
  const invalid = () => new SafeEmailIngestionError('An exact reviewed association is required for every selected message')
  if (!Array.isArray(value) || value.length !== messageIds.length) throw invalid()
  const associations = value.map((entry) => {
    const record = asRecord(entry)
    if (!record || Object.keys(record).sort().join(',') !== 'contactReferences,messageId,primaryOrganizationReference,threadId'
      || typeof record.messageId !== 'string' || !/^[a-f0-9]{1,128}$/i.test(record.messageId)
      || typeof record.threadId !== 'string' || !/^[a-f0-9]{1,128}$/i.test(record.threadId)
      || typeof record.primaryOrganizationReference !== 'string'
      || !/^ga(?:[0-9]{7}|[0-9a-v]{12})$/i.test(record.primaryOrganizationReference)
      || !Array.isArray(record.contactReferences) || !record.contactReferences.length || record.contactReferences.length > 25
      || record.contactReferences.some((reference) => typeof reference !== 'string'
        || !/^gc(?:[0-9]{7}|[0-9a-v]{12})$/i.test(reference))) throw invalid()
    const contactReferences = (record.contactReferences as string[]).map((reference) => reference.toLowerCase()).sort()
    if (new Set(contactReferences).size !== contactReferences.length) throw invalid()
    return {
      messageId: record.messageId.toLowerCase(), threadId: record.threadId.toLowerCase(),
      primaryOrganizationReference: record.primaryOrganizationReference.toLowerCase(), contactReferences,
    }
  }).sort((left, right) => left.messageId.localeCompare(right.messageId))
  const selected = messageIds.map((id) => id.toLowerCase()).sort()
  if (new Set(associations.map((association) => association.messageId)).size !== selected.length
    || associations.some((association, index) => association.messageId !== selected[index])) throw invalid()
  return associations
}

function stableEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableEvidence)
  const record = asRecord(value)
  return record
    ? Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableEvidence(record[key])]))
    : value
}

function historicalReviewProviderEvidence(raw: GmailMessage): GmailMessage {
  const evidence = { ...raw }
  // Reading a message can change its Gmail history cursor and UNREAD label.
  // Neither participates in historical CRM eligibility, direction or placement.
  // Keep the full message payload, all other label membership (including SENT),
  // and the separate locked CRM target fingerprint in the reviewed digest.
  delete evidence.historyId
  if (raw.labelIds === undefined) evidence.labelIds = []
  else if (Array.isArray(raw.labelIds) && raw.labelIds.every(label => typeof label === 'string')) {
    evidence.labelIds = [...new Set(raw.labelIds.filter(label => label !== 'UNREAD'))].sort()
  }
  return evidence
}

async function reviewedParticipantTargets(routing: MessageRoutingInput, association: ReviewedGmailAssociation) {
  const unavailable = () => new SafeEmailIngestionError('Reviewed contacts must be unambiguous current participants in the owned pipeline')
  if (routing.message.externalThreadId !== association.threadId) throw unavailable()
  const participantEmails = ordinaryParticipantAddresses(routing)
  if (!participantEmails.length) throw unavailable()
  // Use the same accounting-mirror and archived-candidate policy as normal
  // intake. Review selects a bounded subset, never overrides email ambiguity.
  const candidates = await query<{ pipeline_id: string; reference_code: string; email: string }>(
    crmParticipantEmailCandidatesSql(),
    [routing.ownedPipelines.map((pipeline) => pipeline.id), participantEmails],
  )
  if (candidates.rows.length > 100 || candidates.rows.some((candidate) => candidate.pipeline_id !== routing.defaultPipelineId)) throw unavailable()
  for (const email of participantEmails) {
    if (new Set(candidates.rows.filter((candidate) => candidate.email === email)
      .map((candidate) => `${candidate.pipeline_id}:${candidate.reference_code}`)).size > 1) throw unavailable()
  }
  const targets: ReferenceTarget[] = []
  for (const referenceCode of association.contactReferences) {
    const candidate = candidates.rows.find((row) => row.reference_code === referenceCode)
    if (!candidate || !participantEmails.includes(candidate.email)) throw unavailable()
    const record = await readCrmRecordByReference({ pipelineId: routing.defaultPipelineId, referenceCode })
      .catch(() => { throw unavailable() })
    if (record.entity !== 'contacts' || record.referenceCode !== referenceCode || !record.organizationId
      || record.email?.trim().toLowerCase() !== candidate.email) throw unavailable()
    targets.push({ record, pipelineId: routing.defaultPipelineId, matchedBy: 'participant-email', matchedEmail: candidate.email })
  }
  const primary = await readCrmRecordByReference({
    pipelineId: routing.defaultPipelineId, referenceCode: association.primaryOrganizationReference,
  }).catch(() => { throw unavailable() })
  if (primary.entity !== 'organizations' || primary.referenceCode !== association.primaryOrganizationReference
    || !targets.some((target) => target.record.organizationId === primary.id)) throw unavailable()
  const organizations = await query<{ id: string; reference_code: string }>(
    `SELECT id::text, reference_code FROM crm_organizations
     WHERE pipeline_id = $1::uuid AND id = ANY($2::uuid[])
       AND COALESCE(lower(source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')`,
    [routing.defaultPipelineId, [...new Set(targets.map((target) => target.record.organizationId))]],
  )
  if (organizations.rows.length !== new Set(targets.map((target) => target.record.organizationId)).size) throw unavailable()
  const companyTargets: ReferenceTarget[] = []
  for (const organization of [...organizations.rows].sort((left, right) => left.reference_code.localeCompare(right.reference_code))) {
    const record = await readCrmRecordByReference({ pipelineId: routing.defaultPipelineId, referenceCode: organization.reference_code })
      .catch(() => { throw unavailable() })
    if (record.entity !== 'organizations' || record.id !== organization.id
      || record.referenceCode !== organization.reference_code) throw unavailable()
    companyTargets.push({ record, pipelineId: routing.defaultPipelineId, matchedBy: 'participant-email' })
  }
  const allowedReferences = new Set([
    ...association.contactReferences, ...organizations.rows.map((organization) => organization.reference_code),
  ])
  // An explicit reference may reinforce the review, but a conflicting marker
  // must not be silently discarded in favor of the operator's selection.
  if (routing.message.markerReferences.some((reference) => !allowedReferences.has(reference))) {
    throw new SafeEmailIngestionError('Explicit message references conflict with the reviewed association')
  }
  return { primary, targets, companyTargets, participantEmails,
    organizationReferences: organizations.rows.map((organization) => organization.reference_code).sort() }
}

/** Discovery only for the two pinned IDs. The candidate picker gets headers
 * and authorized CRM contact choices, not email bodies or a mailbox search. */
export async function readCaseyFirstSeenGmailCandidates(input: { ownerEmail: string; connectionId: string; pipelineId: string }) {
  try {
    if (!matchesCaseyPair({ ...input, messageIds: CASEY_PAIR.messageIds })) throw new Error()
    const mailbox = (await selectedMailboxes()).find(entry => entry.owner_email === input.ownerEmail && entry.connection_id === input.connectionId)
    if (!mailbox) throw new Error()
    const { mailboxIdentity } = await verifiedMailbox(mailbox)
    if (!mailboxIdentity) throw new Error()
    assertCaseyFirstSeenMailbox(mailboxIdentity)
    const pipelines = await ownedPipelines(input.ownerEmail, input.pipelineId)
    const selfAddresses = await configuredMailboxAddresses(mailbox)
    const candidates = await query<{ pipeline_id: string; entity: string; reference_code: string; email: string }>(
      crmParticipantEmailCandidatesSql(), [pipelines.map(pipeline => pipeline.id), [CASEY_PAIR.sender, CASEY_PAIR.customerContact]],
    )
    if (candidates.rows.length !== 2 || candidates.rows.some(candidate => candidate.pipeline_id !== input.pipelineId
      || candidate.entity !== 'contacts') || new Set(candidates.rows.map(candidate => candidate.email)).size !== 2) throw new Error()
    const messages = []
    for (const messageId of CASEY_PAIR.messageIds) {
      const raw = await getGmailMessage(mailbox, messageId, true)
      const message = parseGmailMessage(raw)
      if (message.externalMessageId !== messageId || isClawPilotAuthEmail(raw)) throw new Error()
      assertCaseyFirstSeenEvidence({ evidence: fullGmailEvidence(raw, message), labelIds: message.labelIds })
      const association = { messageId, threadId: CASEY_PAIR.threadId, primaryOrganizationReference: CASEY_PAIR.primary,
        contactReferences: candidates.rows.map(candidate => candidate.reference_code).sort() }
      const resolved = await reviewedParticipantTargets({ ownerEmail: input.ownerEmail, mailboxEmail: mailbox.account_email,
        selfAddresses, defaultPipelineId: input.pipelineId, ownedPipelines: pipelines, message }, association)
      assertCaseyFirstSeenPlacement({ primaryOrganization: resolved.primary,
        organizations: resolved.companyTargets.map(target => ({ id: target.record.id, referenceCode: target.record.referenceCode })),
        contacts: resolved.targets.map(target => ({ email: target.matchedEmail!, organizationId: target.record.organizationId! })) })
      const participantContacts = resolved.targets.map(target => {
        const contact = target.record
        if (contact.entity !== 'contacts' || !target.matchedEmail || !contact.organizationId) throw new Error()
        const company = resolved.companyTargets.find(value => value.record.id === contact.organizationId)?.record
        if (company?.entity !== 'organizations') throw new Error()
        return { id: contact.id, reference: contact.referenceCode, name: contact.name.slice(0, 300),
          email: target.matchedEmail, organizationId: company.id, organizationReference: company.referenceCode, company: company.name.slice(0, 300) }
      })
      messages.push({ messageId, threadId: association.threadId, subject: message.subject || '(No subject)', receivedAt: message.receivedAt,
        legacy: false, admissionScope: CASEY_FIRST_SEEN_SCOPE, participantEmails: resolved.participantEmails,
        participantContacts, participantContactIds: participantContacts.map(contact => contact.id) })
    }
    return messages
  } catch {
    throw new SafeEmailIngestionError('Both exact Casey messages and their verified mailbox and participant links are required')
  }
}

async function reconcileReviewedGmailMessages(input: {
  ownerEmail: string
  connectionId: string
  pipelineId: string
  apply?: boolean
  expectedDigest?: string
  associations: ReviewedGmailAssociation[]
  mailbox: SelectedMailbox
  pipelines: OwnedPipeline[]
  selfAddresses: string[]
  mailboxIdentity: VerifiedGmailMailboxIdentity
  observedAccountEmail: string
  lateContactEmail?: string
  decisionKind?: 'review' | 'correction' | 'late-contact'
  correctionReason?: string
  admissionScope?: CaseyGmailScope
}) {
  const firstSeen = input.admissionScope === CASEY_FIRST_SEEN_SCOPE
  if (firstSeen) {
    try { assertCaseyFirstSeenMailbox(input.mailboxIdentity) }
    catch { throw new SafeEmailIngestionError('The selected Gmail mailbox does not match the reviewed Casey mailbox') }
  }
  const planned = []
  for (const association of input.associations) {
    const raw = await getGmailMessage(input.mailbox, association.messageId)
    const message = parseGmailMessage(raw)
    if (message.externalMessageId !== association.messageId || isClawPilotAuthEmail(raw)
      || message.labelIds.some((label) => ['DRAFT', 'SPAM', 'TRASH'].includes(label))) {
      throw new SafeEmailIngestionError('The selected message is not eligible for CRM recovery')
    }
    const routing = { ownerEmail: input.ownerEmail, mailboxEmail: input.mailbox.account_email,
      selfAddresses: input.selfAddresses, defaultPipelineId: input.pipelineId, ownedPipelines: input.pipelines, message }
    const resolved = await reviewedParticipantTargets(routing, association)
    if (input.lateContactEmail && !resolved.targets.some(target => target.matchedEmail === input.lateContactEmail!.trim().toLowerCase())) {
      throw new SafeEmailIngestionError('The late contact must be one of the exact reviewed message participants')
    }
    const cached = firstSeen ? null : await query<Record<string, unknown> & { id: string; pipeline_id: string }>(
      `SELECT message.* FROM crm_inbound_messages message
       WHERE owner_email = $1 AND external_message_id = $2`,
      [input.ownerEmail, message.externalMessageId],
    )
    if (cached && cached.rows.length !== 1) throw new SafeEmailIngestionError('Reviewed cross-company recovery requires an existing owned cached Gmail message')
    const messageEvidence = fullGmailEvidence(raw, message)
    if (firstSeen && (hasIncompleteInlineGmailText(raw.payload) || !messageEvidence.bodyText
      || /^(?:inbound email received\.?|\(no content\)|\[no message body\])$/i.test(messageEvidence.bodyText))) {
      throw new SafeEmailIngestionError('Complete Gmail message body is required for the Casey review')
    }
    let legacyAdoption: GmailReviewedHistoricalAdoption | undefined
    try {
      const scope = { pipelineId: input.pipelineId, messageIds: input.associations.map(value => value.messageId),
        threadId: association.threadId, primaryOrganization: { id: resolved.primary.id, referenceCode: resolved.primary.referenceCode },
        organizations: resolved.companyTargets.map(target => ({ id: target.record.id, referenceCode: target.record.referenceCode })) }
      if (!cached) {
        assertCaseyFirstSeenEvidence({ evidence: messageEvidence, labelIds: message.labelIds })
        assertCaseyFirstSeenPlacement({ ...scope, contacts: resolved.targets.map(target => ({ email: target.matchedEmail!,
          organizationId: target.record.organizationId! })) })
      } else {
        const retainedEvidence = retainedGmailMessageEvidence(cached.rows[0])
        assertSameRetainedGmailEvidence(retainedEvidence, messageEvidence)
        const retainedMetadata = asRecord(cached.rows[0].raw_metadata)
        if (input.admissionScope === 'casey-reviewed-two-v1') {
          legacyAdoption = prepareCaseyGmailAdoption({ scope: { ...scope, ownerEmail: input.ownerEmail,
            connectionId: input.connectionId, inboundMessageId: cached.rows[0].id, intakePipelineId: cached.rows[0].pipeline_id },
          identity: input.mailboxIdentity, adoptedAt: new Date().toISOString(), cached: retainedEvidence, current: messageEvidence })
          if (cached.rows[0].mailbox_id && !retainedMetadata?.legacyAdoption) throw new Error('Historical admission proof is required')
          if (retainedMetadata?.legacyAdoption) {
            const previous = retainedMetadata.legacyAdoption as typeof legacyAdoption
            assertCaseyGmailAdoption(previous)
            // Reverification may renew the current label/time, never the original
            // unknown provenance, immutable subject, retained evidence or placement.
            const oldPins: Partial<typeof previous> = { ...previous }; delete oldPins.accountEmail; delete oldPins.identityVerifiedAt
            const newPins: Partial<typeof legacyAdoption> = { ...legacyAdoption }; delete newPins.accountEmail; delete newPins.identityVerifiedAt
            if (JSON.stringify(stableEvidence(oldPins)) !== JSON.stringify(stableEvidence(newPins))) throw new Error('Historical admission proof changed')
          }
        } else legacyAdoption = cached.rows[0].mailbox_id && !retainedMetadata?.legacyAdoption ? undefined : prepareBoundedLegacyGmailAdoption({
          scope, identity: input.mailboxIdentity, adoptedAt: new Date().toISOString(), cached: retainedEvidence, current: messageEvidence,
        })
      }
    } catch (error) {
      throw new SafeEmailIngestionError(error instanceof GmailIdentityError
        ? 'Retained Gmail content or identity changed; a matching complete source is required'
        : input.admissionScope ? 'Casey Gmail admission is outside the explicitly reviewed two-message scope'
          : 'Legacy Gmail adoption is outside the explicitly reviewed three-message scope')
    }
    const relatedReferences = [...association.contactReferences, ...resolved.organizationReferences].sort()
    const interaction: StageInteractionInput = {
      entity: 'interactions', pipelineId: input.pipelineId, actorEmail: input.ownerEmail,
      sourceKey: gmailMessageSourceKey(input.mailboxIdentity, message.externalMessageId),
      sourcePayload: { source: 'gmail-inbound', matchedBy: 'reviewed-participants',
        referenceCode: resolved.primary.referenceCode, relatedReferences },
      fields: {
        organizationId: resolved.primary.id, contactIds: resolved.targets.map((target) => target.record.id),
        interactionType: 'email', subject: message.subject || 'Inbound email',
        agentEmail: input.ownerEmail, agentName: input.ownerEmail, occurredAt: message.receivedAt,
        description: (message.bodyText || message.snippet || 'Inbound email received.').slice(0, MAX_INTERACTION_DESCRIPTION_CHARS),
        direction: message.labelIds.includes('SENT') ? 'outbound' : 'inbound',
        deliveryStatus: message.labelIds.includes('SENT') ? 'sent' : 'received',
        providerMessageId: message.externalMessageId, providerThreadId: message.externalThreadId,
        metadata: { source: 'gmail-inbound', matchedBy: 'reviewed-participants',
          referenceCode: resolved.primary.referenceCode, relatedReferences },
      },
    }
    const persistence = {
      ownerEmail: input.ownerEmail, pipelineId: input.pipelineId, connectionId: input.connectionId,
      providerMessageId: message.externalMessageId, providerThreadId: message.externalThreadId,
      participantEmails: resolved.participantEmails,
      mailboxIdentity: input.mailboxIdentity, messageEvidence,
      ...(legacyAdoption ? { legacyAdoption } : {}),
      ...(input.admissionScope ? { admissionScope: input.admissionScope } : {}),
      ...(firstSeen ? { firstSeenLabelIds: [...new Set(message.labelIds)].sort() } : {}),
      ...(input.lateContactEmail ? { lateContactEmail: input.lateContactEmail } : {}),
      decisionKind: input.decisionKind || 'review',
      ...(input.correctionReason ? { correctionReason: input.correctionReason } : {}),
      primaryOrganization: { id: resolved.primary.id, referenceCode: resolved.primary.referenceCode },
      contactTargets: resolved.targets.map((target) => ({ id: target.record.id,
        referenceCode: target.record.referenceCode, email: target.matchedEmail!, organizationId: target.record.organizationId! })),
      interaction,
    }
    planned.push({ association, raw, routing, resolved, persistence })
  }
  if (input.lateContactEmail) selectLateContactGmailMessages({
    messageIds: input.associations.map(association => association.messageId), participantEmail: input.lateContactEmail,
    messages: planned.map(plan => plan.persistence.messageEvidence),
  })
  const snapshots = await stageReviewedGmailInteractionsInPostgres({ messages: planned.map((plan) => plan.persistence), apply: false })
    .catch(() => { throw new SafeEmailIngestionError('Reviewed Gmail association evidence is unavailable or has changed') })
  const digest = crypto.createHash('sha256').update(JSON.stringify(stableEvidence({
    version: firstSeen ? 3 : 4, ownerEmail: input.ownerEmail, connectionId: input.connectionId,
    decisionKind: input.decisionKind || 'review', correctionReason: input.correctionReason || null,
    lateContactEmail: input.lateContactEmail || null,
    ...(input.admissionScope ? { admissionScope: input.admissionScope } : {}),
    pipelineId: input.pipelineId, mailboxEmail: input.mailbox.account_email,
    selfAddresses: [...input.selfAddresses].sort(),
    messages: planned.map((plan, index) => ({ association: plan.association, raw: firstSeen
      ? { evidence: plan.persistence.messageEvidence, labelIds: plan.persistence.firstSeenLabelIds }
      : historicalReviewProviderEvidence(plan.raw),
      targets: plan.resolved.targets.map((target) => ({ id: target.record.id,
        reference: target.record.referenceCode, email: target.matchedEmail, organization: target.record.organizationId })),
      organizationReferences: plan.resolved.organizationReferences, targetFingerprint: snapshots[index].targetFingerprint,
    })),
  }))).digest('hex')
  const messages = planned.map((plan, index) => ({
    messageId: plan.routing.message.externalMessageId, threadId: plan.routing.message.externalThreadId,
    subject: plan.routing.message.subject, receivedAt: plan.routing.message.receivedAt,
    direction: plan.routing.message.labelIds.includes('SENT') ? 'outbound' : 'inbound',
    primaryOrganizationReference: plan.association.primaryOrganizationReference,
    contactReferences: plan.association.contactReferences, organizationReferences: plan.resolved.organizationReferences,
    targetReferences: [...plan.association.contactReferences, ...plan.resolved.organizationReferences].sort(),
    alreadyLinked: snapshots[index].alreadyLinked,
  }))
  if (!input.apply) return { applied: false, digest, pipelineId: input.pipelineId, messages }
  if (!input.expectedDigest || input.expectedDigest !== digest) {
    throw new SafeEmailIngestionError('Gmail recovery changed after preview; review a fresh preview before applying')
  }
  // The persistence batch locks and validates every message/target fingerprint
  // before its first stage; no earlier message can be partially applied when a
  // later reviewed message has changed concurrently.
  const results = await stageReviewedGmailInteractionsInPostgres({
    messages: planned.map((plan, index) => ({ ...plan.persistence,
      expectedExistingInteractionId: snapshots[index].interactionId,
      expectedTargetFingerprint: snapshots[index].targetFingerprint })),
    apply: true,
  }).catch(() => { throw new SafeEmailIngestionError('Reviewed Gmail association evidence changed before apply; preview recovery again') })
  // Decision, cache links, native relationships, audit and outbox intent are
  // committed together. Follow-up writes here would split that atomic result.
  const interactions = results.filter((result, index) => !snapshots[index].interactionId && result.applied).length
  const links = results.reduce((total, result) => total + (result.linksAdded || 0), 0)
  return { applied: true, digest, pipelineId: input.pipelineId, messages, interactions, links }
}

/** Explicit operator recovery of reviewed messages, never a cursor reset or a
 * mailbox-wide replay. Preview is read-only; apply refetches and verifies the
 * content/routing digest before creating any CRM activity. */
export async function reconcileGmailMessages(input: {
  ownerEmail: string
  connectionId: string
  pipelineId: string
  messageIds: string[]
  reviewedAssociations?: ReviewedGmailAssociation[]
  apply?: boolean
  expectedDigest?: string
  lateContactEmail?: string
  decisionKind?: 'review' | 'correction' | 'late-contact'
  correctionReason?: string
  admissionScope?: CaseyGmailScope
}) {
  const ownerEmail = String(input.ownerEmail || '').trim().toLowerCase()
  if (input.decisionKind && !['review', 'correction', 'late-contact'].includes(input.decisionKind)) {
    throw new SafeEmailIngestionError('Gmail reconciliation decision kind is invalid')
  }
  if (input.decisionKind === 'correction' && (typeof input.correctionReason !== 'string'
    || !input.correctionReason.trim() || input.correctionReason.trim().length > 500)) {
    throw new SafeEmailIngestionError('An explicit correction reason of at most 500 characters is required')
  }
  if (input.decisionKind === 'late-contact' && !EMAIL_PATTERN.test(input.lateContactEmail || '')) {
    throw new SafeEmailIngestionError('Late-contact reconciliation requires one exact participant email')
  }
  if (!EMAIL_PATTERN.test(ownerEmail)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.pipelineId)
    || !Array.isArray(input.messageIds) || !input.messageIds.length || input.messageIds.length > 25
    || input.messageIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{1,128}$/i.test(id))
    || new Set(input.messageIds).size !== input.messageIds.length
    || (input.apply !== undefined && typeof input.apply !== 'boolean')) {
    throw new SafeEmailIngestionError('A bounded, exact Gmail recovery selection is required')
  }
  const reviewedAssociations = reviewedAssociationSelection(input.reviewedAssociations, input.messageIds)
  if (input.admissionScope !== undefined && (!isCaseyGmailScope(input.admissionScope)
    || !matchesCaseyPair({ ...input, ownerEmail }) || input.decisionKind !== 'review'
    || input.correctionReason !== undefined || input.lateContactEmail !== undefined || !reviewedAssociations
    || reviewedAssociations.some(association => association.threadId !== CASEY_PAIR.threadId
      || association.primaryOrganizationReference !== CASEY_PAIR.primary))) {
    throw new SafeEmailIngestionError('Casey Gmail admission requires the exact separately reviewed two-message scope')
  }
  const mailbox = (await selectedMailboxes()).find((entry) => (
    entry.owner_email === ownerEmail && entry.connection_id === input.connectionId
  ))
  if (!mailbox) throw new SafeEmailIngestionError('The selected Gmail connection is not active for this owner')
  const pipelines = await ownedPipelines(ownerEmail, input.pipelineId)
  const selfAddresses = await configuredMailboxAddresses(mailbox)
  const identity = await verifiedMailbox(mailbox)
  if (!identity.mailboxIdentity) throw new SafeEmailIngestionError('Gmail recovery requires an independently verified mailbox identity')
  if (reviewedAssociations) return reconcileReviewedGmailMessages({
    ownerEmail, connectionId: input.connectionId, pipelineId: input.pipelineId,
    apply: input.apply, expectedDigest: input.expectedDigest, associations: reviewedAssociations,
    mailbox, pipelines, selfAddresses, mailboxIdentity: identity.mailboxIdentity,
    observedAccountEmail: identity.observedAccountEmail, lateContactEmail: input.lateContactEmail,
    decisionKind: input.decisionKind, correctionReason: input.correctionReason?.trim(),
    admissionScope: input.admissionScope,
  })
  if (input.lateContactEmail) throw new SafeEmailIngestionError('Late-contact reconciliation requires exact reviewed message associations')
  if (input.decisionKind === 'correction' || input.decisionKind === 'late-contact') {
    throw new SafeEmailIngestionError('This reconciliation decision requires exact reviewed message associations')
  }
  const planned: Array<{ routing: MessageRoutingInput; targets: ReferenceTarget[] }> = []
  const messages: Array<{
    messageId: string; subject: string; receivedAt: string; direction: string;
    targetReferences: string[]; alreadyLinked: boolean;
  }> = []
  for (const messageId of [...input.messageIds].sort()) {
    const raw = await getGmailMessage(mailbox, messageId)
    const message = parseGmailMessage(raw)
    if (message.externalMessageId !== messageId || isClawPilotAuthEmail(raw)
      || message.labelIds.some((label) => ['DRAFT', 'SPAM', 'TRASH'].includes(label))) {
      throw new SafeEmailIngestionError('The selected message is not eligible for CRM recovery')
    }
    const routing = { ownerEmail, mailboxEmail: mailbox.account_email, selfAddresses,
      defaultPipelineId: input.pipelineId, ownedPipelines: pipelines, message,
      ...identity, connectionId: input.connectionId, messageEvidence: fullGmailEvidence(raw, message) }
    const cachedIdentity = await query<{ mailbox_id: string | null }>(
      `SELECT mailbox_id::text FROM crm_inbound_messages WHERE owner_email = $1 AND external_message_id = $2`,
      [ownerEmail, message.externalMessageId],
    )
    if (cachedIdentity.rows[0] && cachedIdentity.rows[0].mailbox_id !== identity.mailboxIdentity.mailboxId) {
      throw new SafeEmailIngestionError('Legacy or different-mailbox Gmail evidence requires explicit bounded adoption review')
    }
    const resolved = await referenceTargets(routing)
    if (!resolved.targets.length || resolved.invalidReferences
      || resolved.targets.some((target) => target.pipelineId !== input.pipelineId)) {
      throw new SafeEmailIngestionError('Message routing is ambiguous or does not match the reviewed pipeline')
    }
    const groups = groupReferenceTargets(resolved.targets)
    if (groups.length !== 1) throw new SafeEmailIngestionError('Multiple CRM message groups require explicit association review')
    let alreadyLinked = true
    for (const group of groups) {
      const existingInteractionId = await existingProviderInteraction({
        group, message, ownerEmail,
        mailboxIdentity: identity.mailboxIdentity,
      })
      if (!existingInteractionId) alreadyLinked = false
    }
    planned.push({ routing, targets: resolved.targets })
    messages.push({ messageId, subject: message.subject, receivedAt: message.receivedAt,
      direction: message.labelIds.includes('SENT') ? 'outbound' : 'inbound',
      targetReferences: resolved.targets.map((target) => target.record.referenceCode).sort(),
      alreadyLinked })
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify({
    version: 2, ownerEmail, connectionId: input.connectionId, pipelineId: input.pipelineId,
    mailboxIdentity: identity.mailboxIdentity,
    messages: planned.map(({ routing, targets }) => ({
      id: routing.message.externalMessageId, thread: routing.message.externalThreadId,
      subject: routing.message.subject, receivedAt: routing.message.receivedAt,
      body: routing.message.bodyText, headers: routing.message.emailAddressHeaders,
      sent: routing.message.labelIds.includes('SENT'),
      targets: targets.map((target) => ({ pipeline: target.pipelineId,
        reference: target.record.referenceCode, id: target.record.id, organization: target.record.organizationId })),
    })),
  })).digest('hex')
  if (!input.apply) return { applied: false, digest, pipelineId: input.pipelineId, messages }
  if (!input.expectedDigest || input.expectedDigest !== digest) {
    throw new SafeEmailIngestionError('Gmail recovery changed after preview; review a fresh preview before applying')
  }
  const reviewedRouting = planned.map(({ targets }) => routingFingerprint(targets))
  await recordAuditEvent({ actor: ownerEmail, eventType: 'crm.email_recovery.requested',
    aggregateType: 'pipeline_space', aggregateId: input.pipelineId,
    eventKey: `crm-email-recovery:${ownerEmail}:${input.pipelineId}:${digest}`,
    payload: { digest, messageIds: input.messageIds, providerWrites: 0 } })
  let interactions = 0, links = 0
  for (const [index, { routing }] of planned.entries()) {
    const result = await processMessage(routing, reviewedRouting[index])
    interactions += result.interactions
    links += result.links
  }
  return { applied: true, digest, pipelineId: input.pipelineId, messages, interactions, links }
}

/** Explicit bounded reconciliation, not an automatic history grant on contact
 * creation. The same reviewed transaction revalidates current targets and source. */
export async function reconcileLateContactGmailMessages(input: {
  ownerEmail: string
  connectionId: string
  pipelineId: string
  participantEmail: string
  messageIds: string[]
  reviewedAssociations: ReviewedGmailAssociation[]
  apply?: boolean
  expectedDigest?: string
}) {
  const participantEmail = typeof input.participantEmail === 'string' ? input.participantEmail.trim().toLowerCase() : ''
  if (!EMAIL_PATTERN.test(participantEmail)) throw new SafeEmailIngestionError('One exact late-contact email is required')
  return reconcileGmailMessages({ ...input, lateContactEmail: participantEmail, decisionKind: 'late-contact' })
}

function newCounts(activeMailboxes: number): EmailIngestionCounts {
  return {
    activeMailboxes,
    mailboxesPolled: 0,
    pendingMailboxes: 0,
    messagesListed: 0,
    messagesFetched: 0,
    authMessagesSkipped: 0,
    messagesStored: 0,
    duplicateMessages: 0,
    markerReferences: 0,
    invalidReferences: 0,
    senderMatches: 0,
    archiveMessages: 0,
    archiveMatches: 0,
    unmatchedMessages: 0,
    interactions: 0,
    links: 0,
    errors: 0,
  }
}

async function pollMailbox(mailbox: SelectedMailbox, counts: EmailIngestionCounts): Promise<void> {
  const key = cursorKey(mailbox.connection_id)
  const existingCursor = await readCursor(mailbox.owner_email, key)
  const now = new Date()
  const previousPoll = validDate(existingCursor?.last_polled_at)
  let state = parsePollCursor(existingCursor?.cursor_value || null) || {
    since: new Date(
      previousPoll
        ? previousPoll.getTime() - POLL_OVERLAP_MS
        : now.getTime() - INITIAL_LOOKBACK_MS,
    ).toISOString(),
    pollStartedAt: now.toISOString(),
  }

  try {
    await writeCursor({
      ownerEmail: mailbox.owner_email,
      key,
      state,
      lastPolledAt: now.toISOString(),
      error: null,
    })
    const pipeline = await resolvePipelineSpaceAccess({ actorEmail: mailbox.owner_email })
    if (pipeline.ownerEmail !== mailbox.owner_email) {
      throw new SafeEmailIngestionError('CRM pipeline is unavailable for Gmail ingestion')
    }
    const pipelines = await ownedPipelines(mailbox.owner_email, pipeline.id)
    const selfAddresses = await configuredMailboxAddresses(mailbox)
    const identity = await verifiedMailbox(mailbox)

    for (let page = 0; page < MAX_PAGES_PER_MAILBOX; page += 1) {
      const listed = await listGmailPage(mailbox, state)
      counts.messagesListed += listed.ids.length

      for (const messageId of listed.ids) {
        const rawMessage = await getGmailMessage(mailbox, messageId)
        const message = parseGmailMessage(rawMessage)
        if (message.externalMessageId !== messageId) {
          throw new SafeEmailIngestionError('Gmail returned a mismatched message identifier')
        }
        counts.messagesFetched += 1
        if (isClawPilotAuthEmail(rawMessage)) {
          counts.authMessagesSkipped += 1
          continue
        }
        const processed = await processMessage({
          ownerEmail: mailbox.owner_email,
          mailboxEmail: mailbox.account_email,
          selfAddresses,
          defaultPipelineId: pipeline.id,
          ownedPipelines: pipelines,
          message,
          ...identity, connectionId: mailbox.connection_id, messageEvidence: fullGmailEvidence(rawMessage, message),
        })
        if (processed.inserted) counts.messagesStored += 1
        else counts.duplicateMessages += 1
        counts.markerReferences += processed.markerReferences
        counts.invalidReferences += processed.invalidReferences
        counts.senderMatches += processed.senderMatches
        if (processed.archiveMessage) counts.archiveMessages += 1
        counts.archiveMatches += processed.archiveMatches
        if (processed.unmatched) counts.unmatchedMessages += 1
        counts.interactions += processed.interactions
        counts.links += processed.links
      }

      if (!listed.nextPageToken) {
        await writeCursor({
          ownerEmail: mailbox.owner_email,
          key,
          state: null,
          lastPolledAt: state.pollStartedAt,
          error: null,
        })
        counts.mailboxesPolled += 1
        return
      }

      state = { ...state, pageToken: listed.nextPageToken }
      await writeCursor({
        ownerEmail: mailbox.owner_email,
        key,
        state,
        lastPolledAt: new Date().toISOString(),
        error: null,
      })
    }

    counts.mailboxesPolled += 1
    counts.pendingMailboxes += 1
  } catch (error) {
    counts.errors += 1
    await writeCursor({
      ownerEmail: mailbox.owner_email,
      key,
      state,
      lastPolledAt: new Date().toISOString(),
      error: sanitizeEmailIngestionError(error),
    })
  }
}

export async function processInboundGmailIngestion(): Promise<EmailIngestionCounts> {
  const mailboxes = await selectedMailboxes()
  const counts = newCounts(mailboxes.length)
  for (const mailbox of mailboxes) await pollMailbox(mailbox, counts)
  return counts
}
