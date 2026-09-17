import crypto from 'node:crypto'
import { decodeHtmlEntities } from '@/lib/htmlEntities.mjs'
import { globalIdFragment } from '@/lib/globalIds.mjs'
import { captureEmailAddressHeaders, type EmailAddressHeaders } from '@/lib/crm/emailAddressHeaders'
import { matonFetch } from '@/lib/maton'
import {
  readCrmRecordByReference,
  stageCrmRecordInPostgres,
} from '@/lib/persistence/crm'
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
const DEFAULT_ARCHIVE_EMAIL = 'archive@eigenracing.com'
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

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
}

type CrmReferenceRecord = Awaited<ReturnType<typeof readCrmRecordByReference>>
type ReferenceTarget = {
  record: CrmReferenceRecord
  pipelineId: string
  matchedBy: 'marker' | 'sender-email' | 'archive-email' | 'participant-email'
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
  const configured = String(process.env.CLAWPILOT_ARCHIVE_EMAIL || '').trim().toLowerCase()
  return EMAIL_PATTERN.test(configured) ? configured : DEFAULT_ARCHIVE_EMAIL
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

async function getGmailMessage(mailbox: SelectedMailbox, messageId: string): Promise<GmailMessage> {
  const payload = await gmailJson(
    mailbox,
    `${GMAIL_LIST_PATH}/${encodeURIComponent(messageId)}?format=full`,
    'get',
  )
  return payload as GmailMessage
}

async function storeInboundMessage(input: {
  ownerEmail: string
  pipelineId: string
  message: ParsedGmailMessage
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
  const inserted = await query<{ id: string; pipeline_id: string }>(
    `INSERT INTO crm_inbound_messages (
       owner_email, pipeline_id, external_message_id, external_thread_id,
       sender_email, recipient_emails, subject, received_at, snippet, body_text,
       marker_references, raw_metadata, created_at
     )
     VALUES (
       $1, $2::uuid, $3, $4, $5, $6::text[], $7, $8::timestamptz,
       $9, $10, $11::text[], $12::jsonb, now()
     )
     ON CONFLICT (owner_email, external_message_id) DO NOTHING
     RETURNING id::text, pipeline_id::text`,
    [
      input.ownerEmail,
      input.pipelineId,
      message.externalMessageId,
      message.externalThreadId,
      message.senderEmail,
      message.recipientEmails,
      message.subject,
      message.receivedAt,
      message.snippet || null,
      message.bodyText || null,
      message.markerReferences,
      JSON.stringify(rawMetadata),
    ],
  )
  if (inserted.rows[0]) {
    return {
      id: inserted.rows[0].id,
      pipelineId: inserted.rows[0].pipeline_id,
      inserted: true,
    }
  }

  const existing = await query<{ id: string; pipeline_id: string }>(
    `SELECT id::text, pipeline_id::text
     FROM crm_inbound_messages
     WHERE owner_email = $1 AND external_message_id = $2`,
    [input.ownerEmail, message.externalMessageId],
  )
  if (!existing.rows[0]) throw new SafeEmailIngestionError('Inbound message persistence failed')
  return {
    id: existing.rows[0].id,
    pipelineId: existing.rows[0].pipeline_id,
    inserted: false,
  }
}

type MessageRoutingInput = {
  ownerEmail: string
  mailboxEmail?: string | null
  selfAddresses?: string[]
  defaultPipelineId: string
  ownedPipelines: OwnedPipeline[]
  message: ParsedGmailMessage
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
    `SELECT pipeline_id::text, reference_code, lower(btrim(email)) AS email
     FROM (
       SELECT pipeline_id, reference_code, email FROM crm_contacts
       WHERE COALESCE(lower(source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')
       UNION ALL
       SELECT pipeline_id, reference_code, email FROM crm_leads
       WHERE COALESCE(lower(source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')
     ) candidate
     WHERE pipeline_id = ANY($1::uuid[]) AND lower(btrim(email)) = ANY($2::text[])
     ORDER BY reference_code ASC
     LIMIT 101`,
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
    targets.push({
      record: await readCrmRecordByReference({ pipelineId: row.pipeline_id, referenceCode: row.reference_code }),
      pipelineId: row.pipeline_id,
      matchedBy: 'participant-email',
    })
  }
  // A conversation spanning unrelated customer accounts needs explicit markers
  // or archive review, not an implicit copy into every matched CRM account.
  if (new Set(targets.map((target) => target.record.organizationId || target.record.id)).size !== 1) return []
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
  scopeToSourceKey: boolean
}): Promise<string | undefined> {
  // A legacy marker/archive message can intentionally create one interaction
  // per reference. Preserve those groups by their stable source keys. Ordinary
  // participant mail has one group and can reuse an existing app-sent record.
  const values = [input.group.primary.pipelineId, input.message.externalMessageId]
  if (input.scopeToSourceKey) values.push(interactionSourceKey(
    input.ownerEmail, input.message.externalMessageId, input.group.primary.record.referenceCode,
  ))
  // Do not filter by thread in SQL: a null legacy thread is reusable, while a
  // conflicting non-null thread must not disappear and cause a duplicate.
  const existing = await query<{ id: string; provider_thread_id: string | null }>(
    `SELECT id::text, provider_thread_id FROM crm_interactions
     WHERE pipeline_id = $1::uuid AND provider_message_id = $2
       AND interaction_type = 'email'
       ${input.scopeToSourceKey ? 'AND source_key = $3' : ''}
     ORDER BY id LIMIT 2`,
    values,
  )
  if (existing.rows.length > 1) throw new SafeEmailIngestionError('Gmail message has ambiguous CRM interactions')
  const candidate = existing.rows[0]
  if (candidate?.provider_thread_id != null
    && candidate.provider_thread_id !== input.message.externalThreadId) {
    throw new SafeEmailIngestionError('Gmail message has a conflicting CRM thread identity')
  }
  return candidate?.id
}

async function stageInboundInteraction(input: {
  ownerEmail: string
  inboundMessage: StoredInboundMessage
  message: ParsedGmailMessage
  target: ReferenceTarget
  relatedReferences: string[]
  contactIds?: string[]
}): Promise<string> {
  const referenceCode = input.target.record.referenceCode
  const relations = interactionRelations(input.target.record)
  const description = (input.message.bodyText || input.message.snippet || 'Inbound email received.')
    .slice(0, MAX_INTERACTION_DESCRIPTION_CHARS)
  const staged = await stageCrmRecordInPostgres({
    entity: 'interactions',
    pipelineId: input.target.pipelineId,
    sourceKey: interactionSourceKey(input.ownerEmail, input.message.externalMessageId, referenceCode),
    actorEmail: input.ownerEmail,
    sourcePayload: {
      source: 'gmail-inbound',
      matchedBy: input.target.matchedBy,
      referenceCode,
      relatedReferences: input.relatedReferences,
    },
    fields: {
      ...relations,
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
      },
    },
  })

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
     WHERE id = $1::uuid`,
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
  return JSON.stringify(targets.map((target) => ({
    pipeline: target.pipelineId, reference: target.record.referenceCode,
    id: target.record.id, entity: target.record.entity,
    organization: target.record.organizationId, matchedBy: target.matchedBy,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
}

async function processMessage(
  input: MessageRoutingInput,
  reviewedRouting?: string,
): Promise<MessageProcessResult> {
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
  const inboundMessage = await storeInboundMessage({
    ownerEmail: input.ownerEmail,
    pipelineId: input.defaultPipelineId,
    message: input.message,
  })
  const existingLinks = await completedLinks(inboundMessage.id)
  let interactions = 0
  let links = 0

  const groups = groupReferenceTargets(resolved.targets)
  for (const group of groups) {
    const relatedReferences = group.targets.map((target) => target.record.referenceCode)
    const linkedInteractionIds = relatedReferences
      .map((referenceCode) => existingLinks.get(referenceCode))
      .filter((interactionId): interactionId is string => Boolean(interactionId))
    const existingInteractionId = await existingProviderInteraction({
      group, message: input.message, ownerEmail: input.ownerEmail,
      scopeToSourceKey: groups.filter((candidate) => candidate.primary.pipelineId === group.primary.pipelineId).length > 1,
    })
    // A previous link is evidence to validate, not permission to redirect the
    // current message to an unrelated interaction or another pipeline.
    if (linkedInteractionIds.some((interactionId) => interactionId !== existingInteractionId)) {
      throw new SafeEmailIngestionError('Gmail message has conflicting existing CRM links')
    }
    const interactionId = existingInteractionId || await stageInboundInteraction({
      ownerEmail: input.ownerEmail,
      inboundMessage,
      message: input.message,
      target: group.primary,
      relatedReferences,
      contactIds: group.targets.filter((target) => target.record.entity === 'contacts').map((target) => target.record.id),
    })
    if (!existingInteractionId) interactions += 1
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

/** Explicit operator recovery of reviewed messages, never a cursor reset or a
 * mailbox-wide replay. Preview is read-only; apply refetches and verifies the
 * content/routing digest before creating any CRM activity. */
export async function reconcileGmailMessages(input: {
  ownerEmail: string
  connectionId: string
  pipelineId: string
  messageIds: string[]
  apply?: boolean
  expectedDigest?: string
}) {
  const ownerEmail = String(input.ownerEmail || '').trim().toLowerCase()
  if (!EMAIL_PATTERN.test(ownerEmail)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.pipelineId)
    || !Array.isArray(input.messageIds) || !input.messageIds.length || input.messageIds.length > 25
    || input.messageIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{1,128}$/i.test(id))
    || new Set(input.messageIds).size !== input.messageIds.length
    || (input.apply !== undefined && typeof input.apply !== 'boolean')) {
    throw new SafeEmailIngestionError('A bounded, exact Gmail recovery selection is required')
  }
  const mailbox = (await selectedMailboxes()).find((entry) => (
    entry.owner_email === ownerEmail && entry.connection_id === input.connectionId
  ))
  if (!mailbox) throw new SafeEmailIngestionError('The selected Gmail connection is not active for this owner')
  const pipelines = await ownedPipelines(ownerEmail, input.pipelineId)
  const selfAddresses = await configuredMailboxAddresses(mailbox)
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
      defaultPipelineId: input.pipelineId, ownedPipelines: pipelines, message }
    const resolved = await referenceTargets(routing)
    if (!resolved.targets.length || resolved.invalidReferences
      || resolved.targets.some((target) => target.pipelineId !== input.pipelineId)) {
      throw new SafeEmailIngestionError('Message routing is ambiguous or does not match the reviewed pipeline')
    }
    const groups = groupReferenceTargets(resolved.targets)
    let alreadyLinked = true
    for (const group of groups) {
      const existingInteractionId = await existingProviderInteraction({
        group, message, ownerEmail,
        scopeToSourceKey: groups.filter((candidate) => candidate.primary.pipelineId === group.primary.pipelineId).length > 1,
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
    version: 1, ownerEmail, connectionId: input.connectionId, pipelineId: input.pipelineId,
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
