import crypto from 'node:crypto'
import { matonFetch } from '@/lib/maton'
import {
  readCrmRecordByReference,
  stageCrmRecordInPostgres,
} from '@/lib/persistence/crm'
import { query } from '@/lib/persistence/postgres'
import { resolvePipelineSpaceAccess } from '@/lib/tenancy'

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
}

export type EmailIngestionCounts = {
  activeMailboxes: number
  mailboxesPolled: number
  pendingMailboxes: number
  messagesListed: number
  messagesFetched: number
  messagesStored: number
  duplicateMessages: number
  markerReferences: number
  invalidReferences: number
  senderMatches: number
  unmatchedMessages: number
  interactions: number
  links: number
  errors: number
}

type SelectedMailbox = {
  owner_email: string
  connection_id: string
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
  matchedBy: 'marker' | 'sender-email'
}

type MessageProcessResult = {
  inserted: boolean
  markerReferences: number
  invalidReferences: number
  senderMatches: number
  unmatched: boolean
  interactions: number
  links: number
}

class SafeEmailIngestionError extends Error {
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

  for (const match of searchable.matchAll(/%gslt(g[aciklmo][0-9]{7})(?![A-Za-z0-9_])/gi)) {
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

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '...',
    lt: '<',
    mdash: '-',
    nbsp: ' ',
    ndash: '-',
    quot: '"',
  }
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi, (encoded, entity: string) => {
    const normalized = entity.toLowerCase()
    if (normalized.startsWith('#')) {
      const radix = normalized.startsWith('#x') ? 16 : 10
      const digits = normalized.slice(radix === 16 ? 2 : 1)
      const codePoint = Number.parseInt(digits, radix)
      if (
        !Number.isFinite(codePoint)
        || codePoint <= 0
        || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) return '\uFFFD'
      return String.fromCodePoint(codePoint)
    }
    return named[normalized] ?? encoded
  })
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
  const recipientValues = ['to', 'cc', 'delivered-to', 'x-original-to']
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
    `SELECT app_user.email AS owner_email, connection.connection_id
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
    q: `after:${after} -in:sent -in:drafts`,
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
    historyId: message.historyId,
    labelIds: message.labelIds,
    sizeEstimate: message.sizeEstimate,
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

async function senderEmailTarget(pipelineId: string, senderEmail: string): Promise<ReferenceTarget[]> {
  if (!senderEmail) return []
  const matches = await query<{ reference_code: string }>(
    `SELECT reference_code
     FROM (
       SELECT reference_code
       FROM crm_contacts
       WHERE pipeline_id = $1::uuid AND lower(btrim(email)) = $2
       UNION ALL
       SELECT reference_code
       FROM crm_leads
       WHERE pipeline_id = $1::uuid AND lower(btrim(email)) = $2
     ) candidate
     ORDER BY reference_code ASC
     LIMIT 2`,
    [pipelineId, senderEmail.toLowerCase()],
  )
  if (matches.rows.length !== 1) return []
  return [{
    record: await readCrmRecordByReference({
      pipelineId,
      referenceCode: matches.rows[0].reference_code,
    }),
    pipelineId,
    matchedBy: 'sender-email',
  }]
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

async function referenceTargets(input: {
  defaultPipelineId: string
  ownedPipelines: OwnedPipeline[]
  message: ParsedGmailMessage
}): Promise<{ targets: ReferenceTarget[]; invalidReferences: number; senderMatches: number }> {
  if (input.message.markerReferences.length === 0) {
    const targets = await senderEmailTarget(input.defaultPipelineId, input.message.senderEmail)
    return { targets, invalidReferences: 0, senderMatches: targets.length }
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
  return { targets, invalidReferences, senderMatches: 0 }
}

function interactionRelations(record: CrmReferenceRecord) {
  return {
    organizationId: record.entity === 'organizations' ? record.id : record.organizationId,
    contactId: record.entity === 'contacts' ? record.id : null,
    leadId: record.entity === 'leads' ? record.id : null,
    opportunityId: record.entity === 'opportunities' ? record.id : null,
    meetingId: record.entity === 'meetings' ? record.id : null,
    campaignId: record.entity === 'campaigns' ? record.id : null,
    parentSuiteCrmId: record.entity === 'opportunities' ? record.suiteCrmId : null,
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

async function completedLinks(inboundMessageId: string): Promise<Set<string>> {
  const result = await query<{ reference_code: string; interaction_id: string | null }>(
    `SELECT reference_code, interaction_id::text
     FROM crm_inbound_message_links
     WHERE inbound_message_id = $1::uuid`,
    [inboundMessageId],
  )
  return new Set(result.rows.filter((row) => row.interaction_id).map((row) => row.reference_code))
}

async function stageInboundInteraction(input: {
  ownerEmail: string
  inboundMessage: StoredInboundMessage
  message: ParsedGmailMessage
  target: ReferenceTarget
}): Promise<{ interactionId: string; linked: number }> {
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
    },
    fields: {
      ...relations,
      interactionType: 'email',
      subject: input.message.subject || 'Inbound email',
      agentName: input.message.senderEmail,
      occurredAt: input.message.receivedAt,
      description,
      direction: 'inbound',
      deliveryStatus: 'received',
      providerMessageId: input.message.externalMessageId,
      providerThreadId: input.message.externalThreadId,
      metadata: {
        source: 'gmail-inbound',
        inboundMessageId: input.inboundMessage.id,
        matchedBy: input.target.matchedBy,
        referenceCode,
      },
    },
  })

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
    [input.inboundMessage.id, referenceCode, aggregateType, input.target.record.id, staged.id],
  )

  await query(
    `UPDATE crm_inbound_messages SET
       interaction_id = COALESCE(interaction_id, $2::uuid),
       organization_id = CASE WHEN interaction_id IS NULL THEN $3::uuid ELSE organization_id END,
       contact_id = CASE WHEN interaction_id IS NULL THEN $4::uuid ELSE contact_id END,
       lead_id = CASE WHEN interaction_id IS NULL THEN $5::uuid ELSE lead_id END
     WHERE id = $1::uuid`,
    [
      input.inboundMessage.id,
      staged.id,
      relations.organizationId,
      relations.contactId,
      relations.leadId,
    ],
  )
  return { interactionId: staged.id, linked: linked.rowCount || 0 }
}

async function processMessage(input: {
  ownerEmail: string
  defaultPipelineId: string
  ownedPipelines: OwnedPipeline[]
  message: ParsedGmailMessage
}): Promise<MessageProcessResult> {
  const inboundMessage = await storeInboundMessage({
    ownerEmail: input.ownerEmail,
    pipelineId: input.defaultPipelineId,
    message: input.message,
  })
  const resolved = await referenceTargets({
    defaultPipelineId: input.defaultPipelineId,
    ownedPipelines: input.ownedPipelines,
    message: input.message,
  })
  const existingLinks = await completedLinks(inboundMessage.id)
  let interactions = 0
  let links = 0

  for (const target of resolved.targets) {
    if (existingLinks.has(target.record.referenceCode)) continue
    const result = await stageInboundInteraction({
      ownerEmail: input.ownerEmail,
      inboundMessage,
      message: input.message,
      target,
    })
    interactions += 1
    links += result.linked
    existingLinks.add(target.record.referenceCode)
  }

  return {
    inserted: inboundMessage.inserted,
    markerReferences: input.message.markerReferences.length,
    invalidReferences: resolved.invalidReferences,
    senderMatches: resolved.senderMatches,
    unmatched: resolved.targets.length === 0,
    interactions,
    links,
  }
}

async function ownedPipelines(ownerEmail: string, defaultPipelineId: string): Promise<OwnedPipeline[]> {
  const result = await query<OwnedPipeline>(
    `SELECT id::text, is_default
     FROM pipeline_spaces
     WHERE owner_email = $1
     ORDER BY CASE WHEN id = $2::uuid THEN 0 ELSE 1 END, created_at ASC, id ASC`,
    [ownerEmail, defaultPipelineId],
  )
  if (!result.rows.some((pipeline) => pipeline.id === defaultPipelineId)) {
    throw new SafeEmailIngestionError('CRM pipeline is unavailable for Gmail ingestion')
  }
  return result.rows
}

function newCounts(activeMailboxes: number): EmailIngestionCounts {
  return {
    activeMailboxes,
    mailboxesPolled: 0,
    pendingMailboxes: 0,
    messagesListed: 0,
    messagesFetched: 0,
    messagesStored: 0,
    duplicateMessages: 0,
    markerReferences: 0,
    invalidReferences: 0,
    senderMatches: 0,
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
        const processed = await processMessage({
          ownerEmail: mailbox.owner_email,
          defaultPipelineId: pipeline.id,
          ownedPipelines: pipelines,
          message,
        })
        if (processed.inserted) counts.messagesStored += 1
        else counts.duplicateMessages += 1
        counts.markerReferences += processed.markerReferences
        counts.invalidReferences += processed.invalidReferences
        counts.senderMatches += processed.senderMatches
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
