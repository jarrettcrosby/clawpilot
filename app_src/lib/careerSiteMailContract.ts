import { createHash } from 'node:crypto'

const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CAREER_SITE_SOURCE_APP = 'jarrett-career-site'
const CAREER_SITE_OWNER_EMAIL = 'jarrett@suburbiasandwichco.com'
const CAREER_SITE_MAIL_FROM = 'info@suburbiasandwichco.com'
const CAREER_SITE_MAIL_FROM_NAME = 'Jarrett Crosby'
const CAREER_SITE_MAIL_REPLY_TO = 'jarrettcrosby@gmail.com'
const CAREER_SITE_MAIL_APPROVAL_TO = 'jarrettcrosby@gmail.com'
const CAREER_SITE_PRODUCTION_ORIGIN = 'https://jarrett.suburbiasandwichco.com'
const CAREER_SITE_ORGANIZATION_ID = '405bb919-0364-4a88-8a62-b4c9da42cd8f'

const MESSAGE_TYPES = new Set([
  'contact-notification',
  'newsletter-request',
  'resume-approval-request',
  'approved-resume-link',
])
const CONTACT_INTERESTS = new Set(['leadership', 'advisory', 'product', 'media', 'other'])
const RESUME_VARIANTS = new Set(['executive', 'servicenow', 'odyssey'])
const DOCUMENT_STYLES = new Set(['ats', 'coffee-between-chapters'])
const ACCESS_MODES = new Set(['view-only', 'view+download'])
const TOP_LEVEL_FIELDS = new Set(['messageType', 'idempotencyKey', 'data'])

export type CareerSiteMailMessageType =
  | 'contact-notification'
  | 'newsletter-request'
  | 'resume-approval-request'
  | 'approved-resume-link'

type ContactNotificationData = {
  submissionId: string
  name: string
  email: string
  organization: string | null
  interest: 'leadership' | 'advisory' | 'product' | 'media' | 'other'
  message: string
}

type NewsletterRequestData = {
  submissionId: string
  email: string
}

type ResumeApprovalRequestData = {
  requestId: string
  name: string
  email: string
  organization: string | null
  context: string | null
  networkInterest: boolean
  roleFit: boolean
  variant: 'executive' | 'servicenow' | 'odyssey'
  approvalUrl: string
}

type ApprovedResumeLinkData = {
  requestId: string
  name: string
  email: string
  shortUrl: string
  variant: 'executive' | 'servicenow' | 'odyssey'
  documentStyle: 'ats' | 'coffee-between-chapters'
  accessMode: 'view-only' | 'view+download'
  expiresAt: string
}

export type NormalizedCareerSiteMailRequest =
  | { messageType: 'contact-notification'; idempotencyKey: string; data: ContactNotificationData }
  | { messageType: 'newsletter-request'; idempotencyKey: string; data: NewsletterRequestData }
  | { messageType: 'resume-approval-request'; idempotencyKey: string; data: ResumeApprovalRequestData }
  | { messageType: 'approved-resume-link'; idempotencyKey: string; data: ApprovedResumeLinkData }

export type CareerSiteMailConfiguration = {
  enabled: boolean
  sourceApp: typeof CAREER_SITE_SOURCE_APP
  ownerEmail: typeof CAREER_SITE_OWNER_EMAIL | null
  organizationId: string | null
  from: typeof CAREER_SITE_MAIL_FROM | null
  fromName: typeof CAREER_SITE_MAIL_FROM_NAME | null
  replyTo: typeof CAREER_SITE_MAIL_REPLY_TO | null
  approvalTo: typeof CAREER_SITE_MAIL_APPROVAL_TO | null
  shortLinkOrigin: string | null
  approvalOrigins: readonly string[] | null
}

export class CareerSiteMailRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'CAREER_SITE_MAIL_INVALID',
  ) {
    super(message)
    this.name = 'CareerSiteMailRequestError'
  }
}

export class CareerSiteMailConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CareerSiteMailConfigurationError'
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CareerSiteMailRequestError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string) {
  const unsupported = Object.keys(value).find((field) => !allowed.has(field))
  if (unsupported) {
    throw new CareerSiteMailRequestError(
      `Unsupported ${label} field: ${unsupported}`,
      400,
      'CAREER_SITE_MAIL_FIELD_INVALID',
    )
  }
}

function email(value: unknown, label: string) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (
    !normalized
    || normalized.length > 160
    || !EMAIL_PATTERN.test(normalized)
    || !/^[\x21-\x7e]+$/.test(normalized)
  ) {
    throw new CareerSiteMailRequestError(`${label} must be a valid email address`)
  }
  return normalized
}

function uuid(value: unknown, label: string) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!UUID_PATTERN.test(normalized)) {
    throw new CareerSiteMailRequestError(`${label} must be a UUID`)
  }
  return normalized
}

function singleLine(
  value: unknown,
  label: string,
  options: { required?: boolean; min?: number; max: number },
) {
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new CareerSiteMailRequestError(`${label} is required`)
    return null
  }
  if (typeof value !== 'string') throw new CareerSiteMailRequestError(`${label} must be text`)
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (
    !normalized
    || normalized.length < (options.min || 0)
    || normalized.length > options.max
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new CareerSiteMailRequestError(`${label} is invalid`)
  }
  return normalized
}

function message(value: unknown, label: string, options: { required?: boolean; min?: number; max: number }) {
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new CareerSiteMailRequestError(`${label} is required`)
    return null
  }
  if (typeof value !== 'string') throw new CareerSiteMailRequestError(`${label} must be text`)
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  if (
    !normalized
    || normalized.length < (options.min || 0)
    || normalized.length > options.max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    throw new CareerSiteMailRequestError(`${label} is invalid`)
  }
  return normalized
}

function boolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') {
    throw new CareerSiteMailRequestError(`${label} must be explicitly true or false`)
  }
  return value
}

function selection<T extends string>(value: unknown, allowed: ReadonlySet<string>, label: string): T {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!allowed.has(normalized)) throw new CareerSiteMailRequestError(`${label} is invalid`)
  return normalized as T
}

function approvalUrl(value: unknown, allowedOrigins: readonly string[]) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw.length > 12_000) throw new CareerSiteMailRequestError('approvalUrl is invalid')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CareerSiteMailRequestError('approvalUrl is invalid')
  }
  const token = url.searchParams.get('token') || ''
  if (
    url.protocol !== 'https:'
    || !allowedOrigins.includes(url.origin)
    || url.port
    || url.username
    || url.password
    || url.pathname !== '/resume/approve'
    || url.hash
    || [...url.searchParams.keys()].some((key) => key !== 'token')
    || url.searchParams.getAll('token').length !== 1
    || token.length < 32
    || token.length > 12_000
    || /[\u0000-\u0020\u007f]/.test(token)
  ) {
    throw new CareerSiteMailRequestError('approvalUrl is invalid')
  }
  return url.toString()
}

function shortUrl(value: unknown, shortLinkOrigin: string, requestId: string) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw.length > 500) throw new CareerSiteMailRequestError('shortUrl is invalid')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CareerSiteMailRequestError('shortUrl is invalid')
  }
  const expectedPath = `/s/jc-${createHash('sha256').update(requestId, 'utf8').digest('hex').slice(0, 16)}`
  if (
    url.origin !== shortLinkOrigin
    || url.username
    || url.password
    || url.pathname !== expectedPath
    || url.search
    || url.hash
  ) {
    throw new CareerSiteMailRequestError('shortUrl is invalid')
  }
  return url.toString()
}

function expiry(value: unknown) {
  if (typeof value !== 'string' || value.length > 64) {
    throw new CareerSiteMailRequestError('expiresAt is invalid')
  }
  const parsed = Date.parse(value)
  const year = Number.isFinite(parsed) ? new Date(parsed).getUTCFullYear() : 0
  if (!Number.isFinite(parsed) || year < 2025 || year > 2100) {
    throw new CareerSiteMailRequestError('expiresAt is invalid')
  }
  return new Date(parsed).toISOString()
}

function parseContact(dataValue: unknown): ContactNotificationData {
  const data = record(dataValue, 'data')
  exactFields(data, new Set(['submissionId', 'name', 'email', 'organization', 'interest', 'message']), 'contact data')
  return {
    submissionId: uuid(data.submissionId, 'submissionId'),
    name: singleLine(data.name, 'name', { required: true, min: 2, max: 100 })!,
    email: email(data.email, 'email'),
    organization: singleLine(data.organization, 'organization', { max: 120 }),
    interest: selection(data.interest, CONTACT_INTERESTS, 'interest'),
    message: message(data.message, 'message', { required: true, min: 10, max: 3000 })!,
  }
}

function parseNewsletter(dataValue: unknown): NewsletterRequestData {
  const data = record(dataValue, 'data')
  exactFields(data, new Set(['submissionId', 'email']), 'newsletter data')
  return {
    submissionId: uuid(data.submissionId, 'submissionId'),
    email: email(data.email, 'email'),
  }
}

function parseResumeApproval(
  dataValue: unknown,
  approvalOrigins: readonly string[],
): ResumeApprovalRequestData {
  const data = record(dataValue, 'data')
  exactFields(data, new Set([
    'requestId', 'name', 'email', 'organization', 'context', 'networkInterest',
    'roleFit', 'variant', 'approvalUrl',
  ]), 'resume approval data')
  return {
    requestId: uuid(data.requestId, 'requestId'),
    name: singleLine(data.name, 'name', { required: true, min: 2, max: 100 })!,
    email: email(data.email, 'email'),
    organization: singleLine(data.organization, 'organization', { max: 120 }),
    context: message(data.context, 'context', { max: 2000 }),
    networkInterest: boolean(data.networkInterest, 'networkInterest'),
    roleFit: boolean(data.roleFit, 'roleFit'),
    variant: selection(data.variant, RESUME_VARIANTS, 'variant'),
    approvalUrl: approvalUrl(data.approvalUrl, approvalOrigins),
  }
}

function parseApprovedResume(dataValue: unknown, shortLinkOrigin: string): ApprovedResumeLinkData {
  const data = record(dataValue, 'data')
  exactFields(data, new Set([
    'requestId', 'name', 'email', 'shortUrl', 'variant', 'documentStyle',
    'accessMode', 'expiresAt',
  ]), 'approved resume data')
  const requestId = uuid(data.requestId, 'requestId')
  return {
    requestId,
    name: singleLine(data.name, 'name', { required: true, min: 2, max: 100 })!,
    email: email(data.email, 'email'),
    shortUrl: shortUrl(data.shortUrl, shortLinkOrigin, requestId),
    variant: selection(data.variant, RESUME_VARIANTS, 'variant'),
    documentStyle: selection(data.documentStyle, DOCUMENT_STYLES, 'documentStyle'),
    accessMode: selection(data.accessMode, ACCESS_MODES, 'accessMode'),
    expiresAt: expiry(data.expiresAt),
  }
}

export function parseCareerSiteMailRequest(
  value: unknown,
  options: { shortLinkOrigin?: string; approvalOrigins?: readonly string[] } = {},
): NormalizedCareerSiteMailRequest {
  const input = record(value, 'request')
  exactFields(input, TOP_LEVEL_FIELDS, 'career-site mail')
  const messageType = selection<CareerSiteMailMessageType>(input.messageType, MESSAGE_TYPES, 'messageType')
  const idempotencyKey = singleLine(input.idempotencyKey, 'idempotencyKey', {
    required: true,
    min: 10,
    max: 128,
  })!
  if (!/^[a-z][a-z0-9-]*\/[0-9a-f-]{36}$/.test(idempotencyKey)) {
    throw new CareerSiteMailRequestError('idempotencyKey is invalid')
  }

  const assertExpectedKey = (expectedKey: string) => {
    if (idempotencyKey === expectedKey) return
    throw new CareerSiteMailRequestError(
      'idempotencyKey does not match the message data',
      400,
      'CAREER_SITE_MAIL_IDEMPOTENCY_KEY_INVALID',
    )
  }
  if (messageType === 'contact-notification') {
    const data = parseContact(input.data)
    assertExpectedKey(`contact/${data.submissionId}`)
    return { messageType, idempotencyKey, data }
  }
  if (messageType === 'newsletter-request') {
    const data = parseNewsletter(input.data)
    assertExpectedKey(`newsletter/${data.submissionId}`)
    return { messageType, idempotencyKey, data }
  }
  if (messageType === 'resume-approval-request') {
    const approvalOrigins = options.approvalOrigins
      || resolveCareerSiteMailApprovalOrigins(process.env.CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON)
    const data = parseResumeApproval(input.data, approvalOrigins)
    assertExpectedKey(`resume-request/${data.requestId}`)
    return { messageType, idempotencyKey, data }
  }
  const allowedShortLinkOrigin = resolveCareerSiteShortLinkOrigin(
    options.shortLinkOrigin ?? process.env.SHORTLINK_PUBLIC_ORIGIN,
  )
  const data = parseApprovedResume(input.data, allowedShortLinkOrigin)
  assertExpectedKey(`resume-approved/${data.requestId}`)
  return { messageType, idempotencyKey, data }
}

function exactConfiguredEmail<T extends string>(value: unknown, expected: T, label: string): T {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized !== expected || !EMAIL_PATTERN.test(normalized)) {
    throw new CareerSiteMailConfigurationError(`${label} must be ${expected}`)
  }
  return normalized as T
}

export function resolveCareerSiteShortLinkOrigin(value: unknown) {
  const configured = typeof value === 'string' ? value.trim() : ''
  try {
    const url = new URL(configured)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      throw new Error('invalid short-link origin')
    }
    return url.origin
  } catch {
    throw new CareerSiteMailConfigurationError(
      'SHORTLINK_PUBLIC_ORIGIN must be a valid exact HTTPS origin',
    )
  }
}

function exactHttpsOrigin(value: unknown, label: string) {
  const configured = typeof value === 'string' ? value.trim() : ''
  try {
    const url = new URL(configured)
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      throw new Error('invalid exact origin')
    }
    return url.origin
  } catch {
    throw new CareerSiteMailConfigurationError(`${label} must contain exact HTTPS origins`)
  }
}

export function resolveCareerSiteMailApprovalOrigins(value: unknown): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof value === 'string' ? value : '')
  } catch {
    throw new CareerSiteMailConfigurationError(
      'CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON must be a JSON array of exact HTTPS origins',
    )
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 10) {
    throw new CareerSiteMailConfigurationError(
      'CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON must contain 1-10 exact HTTPS origins',
    )
  }
  const origins = parsed.map((origin) => exactHttpsOrigin(
    origin,
    'CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON',
  ))
  if (new Set(origins).size !== origins.length || !origins.includes(CAREER_SITE_PRODUCTION_ORIGIN)) {
    throw new CareerSiteMailConfigurationError(
      `CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON must contain ${CAREER_SITE_PRODUCTION_ORIGIN} without duplicates`,
    )
  }
  return Object.freeze(origins)
}

export function resolveCareerSiteMailConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): CareerSiteMailConfiguration {
  const enabled = String(environment.CAREER_SITE_SUBMISSIONS_ENABLED || '0').trim() === '1'
  if (!enabled) {
    return {
      enabled: false,
      sourceApp: CAREER_SITE_SOURCE_APP,
      ownerEmail: null,
      organizationId: null,
      from: null,
      fromName: null,
      replyTo: null,
      approvalTo: null,
      shortLinkOrigin: null,
      approvalOrigins: null,
    }
  }
  const ownerEmail = exactConfiguredEmail(
    environment.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL,
    CAREER_SITE_OWNER_EMAIL,
    'CAREER_SITE_SUBMISSIONS_OWNER_EMAIL',
  )
  const organizationId = String(
    environment.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID || '',
  ).trim().toLowerCase()
  if (organizationId !== CAREER_SITE_ORGANIZATION_ID) {
    throw new CareerSiteMailConfigurationError(
      `CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID must be ${CAREER_SITE_ORGANIZATION_ID}`,
    )
  }
  const from = exactConfiguredEmail(environment.CAREER_SITE_MAIL_FROM, CAREER_SITE_MAIL_FROM, 'CAREER_SITE_MAIL_FROM')
  const replyTo = exactConfiguredEmail(
    environment.CAREER_SITE_MAIL_REPLY_TO,
    CAREER_SITE_MAIL_REPLY_TO,
    'CAREER_SITE_MAIL_REPLY_TO',
  )
  const approvalTo = exactConfiguredEmail(
    environment.CAREER_SITE_MAIL_APPROVAL_TO,
    CAREER_SITE_MAIL_APPROVAL_TO,
    'CAREER_SITE_MAIL_APPROVAL_TO',
  )
  const fromName = String(environment.CAREER_SITE_MAIL_FROM_NAME || '').trim()
  if (fromName !== CAREER_SITE_MAIL_FROM_NAME || /[\r\n]/.test(fromName)) {
    throw new CareerSiteMailConfigurationError(`CAREER_SITE_MAIL_FROM_NAME must be ${CAREER_SITE_MAIL_FROM_NAME}`)
  }
  const shortLinkOrigin = resolveCareerSiteShortLinkOrigin(environment.SHORTLINK_PUBLIC_ORIGIN)
  const approvalOrigins = resolveCareerSiteMailApprovalOrigins(
    environment.CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON,
  )
  return {
    enabled: true,
    sourceApp: CAREER_SITE_SOURCE_APP,
    ownerEmail,
    organizationId,
    from,
    fromName: CAREER_SITE_MAIL_FROM_NAME,
    replyTo,
    approvalTo,
    shortLinkOrigin,
    approvalOrigins,
  }
}
