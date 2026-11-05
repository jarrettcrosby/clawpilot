import crypto from 'node:crypto'
import type { EmailAddressHeaders } from '@/lib/crm/emailAddressHeaders'

const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const GMAIL_ID = /^[\x21-\x7e]{1,512}$/
const MAX_EVIDENCE_TEXT = 2 * 1024 * 1024

/** This is returned by the trusted, durable provider-account verifier, never
 * constructed from a selected connection label, contact, or request metadata. */
export type VerifiedGmailMailboxIdentity = {
  version: 1
  provider: 'gmail'
  mailboxId: string
  providerAccountId: string
  accountEmail: string
  verifiedAt: string
  verifiedConnectionId: string
}

export type GmailMessageEvidence = {
  version: 1
  messageId: string
  threadId: string | null
  senderEmail: string
  recipientEmails: string[]
  subject: string
  receivedAt: string
  snippet: string
  bodyText: string
  markerReferences: string[]
  emailAddressHeaders: EmailAddressHeaders
}

export type GmailIntakeProvenance = {
  version: 1
  provider: 'gmail'
  mailboxKey: string
  providerAccountId: string
  accountEmail: string
  ownerEmail: string
  observedConnectionId: string
  identityVerifiedAt: string
  observedAt: string
  intakePipelineId: string
  intakeWorkspaceOrganizationId: string
  evidenceHash: string
}

export class GmailIdentityError extends Error {
  constructor(message: string) { super(message); this.name = 'GmailIdentityError' }
}

function required(value: unknown, maximum = 512): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) throw new GmailIdentityError('Gmail identity evidence is invalid')
  return value
}

function email(value: unknown): string {
  const result = required(value, 254).toLowerCase()
  if (!EMAIL.test(result)) throw new GmailIdentityError('Gmail address evidence is invalid')
  return result
}

function timestamp(value: unknown): string {
  const raw = Object.prototype.toString.call(value) === '[object Date]'
    ? (value as Date).toISOString() : required(value, 64)
  const time = new Date(raw)
  if (!Number.isFinite(time.getTime())) throw new GmailIdentityError('Gmail timestamp evidence is invalid')
  return time.toISOString()
}

function text(value: unknown): string {
  if (value == null) return ''
  if (typeof value !== 'string' || value.length > MAX_EVIDENCE_TEXT) throw new GmailIdentityError('Gmail retained evidence is invalid or too large')
  return value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()
}

function sortedStrings(value: unknown, normalize: (value: unknown) => string): string[] {
  if (!Array.isArray(value) || value.length > 500) throw new GmailIdentityError('Gmail list evidence is invalid')
  return Array.from(new Set(value.map(normalize))).sort()
}

function addressHeaders(value: unknown): EmailAddressHeaders {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { version?: unknown }).version !== 1) {
    throw new GmailIdentityError('Complete retained Gmail address headers are required')
  }
  const headers = value as Record<string, unknown>
  const result: EmailAddressHeaders = { version: 1 }
  for (const kind of ['from', 'to', 'cc', 'bcc'] as const) {
    if (headers[kind] === undefined) continue
    if (!Array.isArray(headers[kind]) || (headers[kind] as unknown[]).length > 50) throw new GmailIdentityError('Gmail header evidence is invalid')
    const seen = new Set<string>()
    result[kind] = (headers[kind] as Array<{ address?: unknown; displayName?: unknown }>).map((mailbox) => {
      if (!mailbox || typeof mailbox !== 'object' || Array.isArray(mailbox)) throw new GmailIdentityError('Gmail header evidence is invalid')
      const address = email(mailbox.address)
      if (seen.has(address)) throw new GmailIdentityError('Duplicate retained Gmail address evidence')
      seen.add(address)
      const displayName = mailbox.displayName === undefined ? '' : text(mailbox.displayName)
      return { address, ...(displayName ? { displayName } : {}) }
    }).sort((a, b) => a.address.localeCompare(b.address))
  }
  return result
}

export function gmailEvidenceHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Provider account subject is the stable key. Reconnects, aliases, owners and
 * CRM placements deliberately do not participate in it. */
export function gmailMailboxKey(identity: VerifiedGmailMailboxIdentity): string {
  if (identity.version !== 1 || identity.provider !== 'gmail') throw new GmailIdentityError('Verified Gmail mailbox identity is required')
  return `gmail:${gmailEvidenceHash(['gmail', required(identity.providerAccountId)])}`
}

export function verifyGmailMailboxBinding(input: {
  identity: VerifiedGmailMailboxIdentity
  connectionId: string
  profileEmail: unknown
  observedAt: string
}): VerifiedGmailMailboxIdentity {
  const identity = input.identity
  gmailMailboxKey(identity)
  if (required(identity.verifiedConnectionId) !== required(input.connectionId)
    || email(identity.accountEmail) !== email(input.profileEmail)
    || new Date(timestamp(identity.verifiedAt)).getTime() > new Date(timestamp(input.observedAt)).getTime()) {
    throw new GmailIdentityError('Gmail connection no longer matches its verified provider account')
  }
  // Validation may use Date, but the binding CAS token must retain PostgreSQL
  // microseconds. JS Date/ISO serialization would silently truncate them.
  return { ...identity, accountEmail: email(identity.accountEmail), verifiedAt: identity.verifiedAt }
}

export function normalizeGmailMessageEvidence(input: {
  externalMessageId: string
  externalThreadId: string | null
  senderEmail: string
  recipientEmails: string[]
  subject: string
  receivedAt: string | Date
  snippet: string
  bodyText: string
  markerReferences: string[]
  emailAddressHeaders: EmailAddressHeaders
}): GmailMessageEvidence {
  const messageId = required(input.externalMessageId)
  const threadId = input.externalThreadId === null ? null : required(input.externalThreadId)
  if (!GMAIL_ID.test(messageId) || (threadId !== null && !GMAIL_ID.test(threadId))) throw new GmailIdentityError('Exact Gmail message identity is required')
  return { version: 1, messageId, threadId, senderEmail: input.senderEmail === '' ? '' : email(input.senderEmail),
    recipientEmails: sortedStrings(input.recipientEmails, email), subject: text(input.subject),
    receivedAt: timestamp(input.receivedAt), snippet: text(input.snippet), bodyText: text(input.bodyText),
    markerReferences: sortedStrings(input.markerReferences, value => required(value, 64).toLowerCase()),
    emailAddressHeaders: addressHeaders(input.emailAddressHeaders) }
}

export function gmailMessageSourceKey(identity: VerifiedGmailMailboxIdentity, messageId: string): string {
  if (!GMAIL_ID.test(messageId)) throw new GmailIdentityError('Exact Gmail message identity is required')
  return `gmail:message:${gmailEvidenceHash([gmailMailboxKey(identity), messageId])}`
}

export function gmailIntakeProvenance(input: {
  identity: VerifiedGmailMailboxIdentity
  ownerEmail: string
  connectionId: string
  observedAt: string
  intakePipelineId: string
  intakeWorkspaceOrganizationId: string
  evidence: GmailMessageEvidence
}): GmailIntakeProvenance {
  verifyGmailMailboxBinding({ identity: input.identity, connectionId: input.connectionId,
    profileEmail: input.identity.accountEmail, observedAt: input.observedAt })
  return { version: 1, provider: 'gmail', mailboxKey: gmailMailboxKey(input.identity),
    providerAccountId: required(input.identity.providerAccountId), accountEmail: email(input.identity.accountEmail),
    ownerEmail: email(input.ownerEmail), observedConnectionId: required(input.connectionId),
    identityVerifiedAt: timestamp(input.identity.verifiedAt), observedAt: timestamp(input.observedAt),
    intakePipelineId: required(input.intakePipelineId), intakeWorkspaceOrganizationId: required(input.intakeWorkspaceOrganizationId),
    evidenceHash: gmailEvidenceHash(input.evidence) }
}

export function retainedGmailMessageEvidence(row: Record<string, unknown>): GmailMessageEvidence {
  const metadata = row.raw_metadata as Record<string, unknown> | undefined
  if (metadata?.provider !== 'gmail') throw new GmailIdentityError('Retained Gmail provider evidence is required')
  return normalizeGmailMessageEvidence({ externalMessageId: row.external_message_id as string,
    externalThreadId: row.external_thread_id as string | null, senderEmail: row.sender_email as string,
    recipientEmails: row.recipient_emails as string[], subject: row.subject as string,
    receivedAt: row.received_at as string | Date, snippet: row.snippet as string, bodyText: row.body_text as string,
    markerReferences: row.marker_references as string[], emailAddressHeaders: metadata.emailAddressHeaders as EmailAddressHeaders })
}

/** Comparing two hashes binds a review; comparing the normalized evidence first
 * establishes content equality. Mutable provider labels/history are not content. */
export function assertSameRetainedGmailEvidence(cached: GmailMessageEvidence, current: GmailMessageEvidence): string {
  const retained = gmailEvidenceHash(cached)
  if (retained !== gmailEvidenceHash(current)) throw new GmailIdentityError('Retained Gmail content or identity differs from the current provider message')
  return retained
}
