import { isIP } from 'node:net'

export const CAREER_SITE_LINKEDIN_SOURCE_APP = 'jarrett-career-agents'
export const CAREER_SITE_LINKEDIN_OWNER_EMAIL = 'jarrett@suburbiasandwichco.com'
export const CAREER_SITE_LINKEDIN_ORGANIZATION_ID = '405bb919-0364-4a88-8a62-b4c9da42cd8f'
export const CAREER_SITE_LINKEDIN_MAX_RESULTS = 50
export const CAREER_SITE_LINKEDIN_MAX_SESSION_BYTES = 4 * 1024 * 1024

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const LEASE_TOKEN_PATTERN = UUID_PATTERN
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i

export type CareerSiteLinkedInConnectionStatus =
  | 'disconnected'
  | 'authenticating'
  | 'connected'
  | 'reauth_required'
  | 'restricted'
  | 'error'

export type CareerSiteLinkedInAuthStatus =
  | 'queued'
  | 'claimed'
  | 'awaiting_user'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'cancelled'

export type CareerSiteLinkedInScanStatus =
  | 'queued'
  | 'claimed'
  | 'awaiting_auth'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type CareerSiteLinkedInAuthPrompt = {
  kind: 'login' | 'mfa' | 'checkpoint' | 'none'
  message: string | null
}

export type CareerSiteLinkedInConnectRequest = {
  requestId: string
  returnUrl: string
}

export type CareerSiteLinkedInScanFilters = {
  keywords: string[]
  locations: string[]
  minimumSalary: number | null
}

export type CareerSiteLinkedInScanRequest = {
  requestId: string
  scope: 'jobs'
  maximum: number
  filters: CareerSiteLinkedInScanFilters
}

export type CareerSiteLinkedInJob = {
  externalId: string
  url: string
  title: string
  company: string
  location: string | null
  description: string
  salaryText: string | null
  postedAt: string | null
}

export type CareerSiteLinkedInSessionEnvelope = {
  algorithm: 'A256GCM'
  version: 1
  ciphertext: string
  iv: string
  tag: string
}

export type CareerSiteLinkedInWorkerClaimRequest = {
  workerId: string
  capabilities: Array<'interactive_auth' | 'jobs_read'>
}

export type CareerSiteLinkedInWorkerReportRequest = {
  leaseId: string
  leaseToken: string
  status: 'awaiting_auth' | 'running' | 'succeeded' | 'failed' | 'restricted'
  authState: CareerSiteLinkedInAuthPrompt | null
  encryptedSessionEnvelope: CareerSiteLinkedInSessionEnvelope | null
  jobs: CareerSiteLinkedInJob[]
  evidence: {
    event: 'live_token_redeemed' | 'page_state'
    capturedAt: string
    memberName: string | null
    profileUrl: string | null
    sessionExpiresAt: string | null
  } | null
  errorCode: string | null
  errorMessage: string | null
}

export type CareerSiteLinkedInConfiguration = {
  enabled: boolean
  sourceApp: typeof CAREER_SITE_LINKEDIN_SOURCE_APP
  ownerEmail: typeof CAREER_SITE_LINKEDIN_OWNER_EMAIL
  organizationId: typeof CAREER_SITE_LINKEDIN_ORGANIZATION_ID
  workerPublicUrl: string
  workerToken: string
  workerHmacSecret: string
}

export class CareerSiteLinkedInRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'CAREER_SITE_LINKEDIN_REQUEST_INVALID',
  ) {
    super(message)
    this.name = 'CareerSiteLinkedInRequestError'
  }
}

export class CareerSiteLinkedInConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CareerSiteLinkedInConfigurationError'
  }
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CareerSiteLinkedInRequestError(`${label} must be a JSON object`)
  }
  const record = value as Record<string, unknown>
  const allowed = new Set(fields)
  const unsupported = Object.keys(record).find((field) => !allowed.has(field))
  if (unsupported) {
    throw new CareerSiteLinkedInRequestError(`Unsupported ${label} field: ${unsupported}`)
  }
  return record
}

function uuid(value: unknown, label: string): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(normalized)) {
    throw new CareerSiteLinkedInRequestError(`${label} must be a UUID`)
  }
  return normalized
}

function boundedText(
  value: unknown,
  label: string,
  maximum: number,
  options: { nullable?: boolean; empty?: boolean } = {},
): string | null {
  if (options.nullable && (value === null || value === undefined)) return null
  if (typeof value !== 'string') {
    throw new CareerSiteLinkedInRequestError(`${label} must be text`)
  }
  const normalized = value.replace(/\r\n?/g, '\n').trim()
  if (
    (!options.empty && !normalized)
    || normalized.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    throw new CareerSiteLinkedInRequestError(`${label} is invalid`)
  }
  return normalized
}

function publicHttpsUrl(value: unknown, label: string, options: {
  linkedIn?: boolean
  nullable?: boolean
} = {}): string | null {
  if (options.nullable && (value === null || value === undefined)) return null
  const raw = boundedText(value, label, 2_048)
  try {
    const url = new URL(raw || '')
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || (url.port && url.port !== '443')
      || isIP(hostname) !== 0
      || !hostname.includes('.')
      || /(?:^|\.)(?:localhost|local|internal|invalid)$/.test(hostname)
      || (options.linkedIn && hostname !== 'linkedin.com' && !hostname.endsWith('.linkedin.com'))
    ) throw new Error()
    url.hostname = hostname
    return url.toString()
  } catch {
    throw new CareerSiteLinkedInRequestError(`${label} must be a public HTTPS URL`)
  }
}

function isoTimestamp(value: unknown, label: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined)) return null
  if (typeof value !== 'string' || !RFC3339_TIMESTAMP.test(value)) {
    throw new CareerSiteLinkedInRequestError(`${label} must be an ISO timestamp`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new CareerSiteLinkedInRequestError(`${label} must be an ISO timestamp`)
  }
  return parsed.toISOString()
}

function textList(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 10) {
    throw new CareerSiteLinkedInRequestError(`${label} must contain at most 10 values`)
  }
  const normalized = value.map((item, index) => (
    boundedText(item, `${label}[${index}]`, 100) as string
  ))
  if (new Set(normalized.map((item) => item.toLowerCase())).size !== normalized.length) {
    throw new CareerSiteLinkedInRequestError(`${label} must not contain duplicates`)
  }
  return normalized
}

function optionalErrorCode(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const code = String(value).trim().toUpperCase()
  if (!ERROR_CODE_PATTERN.test(code)) {
    throw new CareerSiteLinkedInRequestError('errorCode is invalid')
  }
  return code
}

export function parseCareerSiteLinkedInConnectRequest(
  value: unknown,
): CareerSiteLinkedInConnectRequest {
  const record = exactRecord(value, ['requestId', 'returnUrl'], 'LinkedIn connect request')
  const requestId = uuid(record.requestId, 'requestId')
  const returnUrl = publicHttpsUrl(record.returnUrl, 'returnUrl') as string
  const parsed = new URL(returnUrl)
  const attemptIds = parsed.searchParams.getAll('attemptId')
  const destinations = parsed.searchParams.getAll('destination')
  if (
    parsed.origin !== 'https://jarrett.suburbiasandwichco.com'
    || parsed.pathname !== '/career/linkedin/return'
    || [...parsed.searchParams.keys()].some(
      (key) => key !== 'attemptId' && key !== 'destination',
    )
    || attemptIds.length !== 1
    || attemptIds[0] !== requestId
    || destinations.length !== 1
    || !['overview', 'agents', 'settings'].includes(destinations[0] || '')
    || parsed.hash
  ) {
    throw new CareerSiteLinkedInRequestError(
      'returnUrl must be the matching Career Desk LinkedIn return URL',
    )
  }
  return { requestId, returnUrl }
}

export function parseCareerSiteLinkedInScanRequest(
  value: unknown,
): CareerSiteLinkedInScanRequest {
  const record = exactRecord(
    value,
    ['requestId', 'scope', 'maximum', 'filters'],
    'LinkedIn scan request',
  )
  if (record.scope !== 'jobs') {
    throw new CareerSiteLinkedInRequestError('scope must be jobs')
  }
  if (
    typeof record.maximum !== 'number'
    || !Number.isSafeInteger(record.maximum)
    || record.maximum < 1
    || record.maximum > CAREER_SITE_LINKEDIN_MAX_RESULTS
  ) {
    throw new CareerSiteLinkedInRequestError(
      `maximum must be an integer from 1 to ${CAREER_SITE_LINKEDIN_MAX_RESULTS}`,
    )
  }
  const filters = exactRecord(
    record.filters === undefined ? {} : record.filters,
    ['keywords', 'locations', 'minimumSalary'],
    'LinkedIn scan filters',
  )
  const minimumSalary = filters.minimumSalary === undefined || filters.minimumSalary === null
    ? null
    : filters.minimumSalary
  if (
    minimumSalary !== null
    && (
      typeof minimumSalary !== 'number'
      || !Number.isSafeInteger(minimumSalary)
      || minimumSalary < 0
      || minimumSalary > 2_000_000
    )
  ) {
    throw new CareerSiteLinkedInRequestError(
      'minimumSalary must be a whole number from 0 to 2000000',
    )
  }
  return {
    requestId: uuid(record.requestId, 'requestId'),
    scope: 'jobs',
    maximum: record.maximum,
    filters: {
      keywords: textList(filters.keywords, 'keywords'),
      locations: textList(filters.locations, 'locations'),
      minimumSalary,
    },
  }
}

function parseJob(value: unknown, index: number): CareerSiteLinkedInJob {
  const record = exactRecord(
    value,
    [
      'externalId', 'url', 'title', 'company', 'location', 'description',
      'salaryText', 'postedAt',
    ],
    `jobs[${index}]`,
  )
  const externalId = boundedText(record.externalId, `jobs[${index}].externalId`, 30) as string
  if (!/^\d{5,30}$/.test(externalId)) {
    throw new CareerSiteLinkedInRequestError(`jobs[${index}].externalId is invalid`)
  }
  const suppliedUrl = publicHttpsUrl(record.url, `jobs[${index}].url`, { linkedIn: true }) as string
  const parsedUrl = new URL(suppliedUrl)
  const pathJobId = parsedUrl.pathname.match(/^\/jobs\/view\/(\d{5,30})\/?$/)?.[1]
  const queryJobId = parsedUrl.searchParams.get('currentJobId')
  const queryPath = /^\/jobs\/(?:search|search-results)\/?$/.test(parsedUrl.pathname)
  const observedJobIds = [pathJobId, queryPath ? queryJobId : null].filter(Boolean)
  if (
    observedJobIds.length === 0
    || observedJobIds.some((jobId) => jobId !== externalId)
  ) {
    throw new CareerSiteLinkedInRequestError(`jobs[${index}].url does not match externalId`)
  }
  return {
    externalId,
    url: `https://www.linkedin.com/jobs/view/${externalId}/`,
    title: boundedText(record.title, `jobs[${index}].title`, 240) as string,
    company: boundedText(record.company, `jobs[${index}].company`, 240) as string,
    location: boundedText(record.location, `jobs[${index}].location`, 240, { nullable: true }),
    description: boundedText(record.description, `jobs[${index}].description`, 20_000) as string,
    salaryText: boundedText(record.salaryText, `jobs[${index}].salaryText`, 500, { nullable: true }),
    postedAt: isoTimestamp(record.postedAt, `jobs[${index}].postedAt`, true),
  }
}

function parsePrompt(value: unknown): CareerSiteLinkedInAuthPrompt | null {
  if (value === null || value === undefined) return null
  const record = exactRecord(value, ['kind', 'message'], 'authState')
  if (!['login', 'mfa', 'checkpoint', 'none'].includes(String(record.kind))) {
    throw new CareerSiteLinkedInRequestError('authState.kind is invalid')
  }
  boundedText(record.message, 'authState.message', 500, { nullable: true })
  const kind = record.kind as CareerSiteLinkedInAuthPrompt['kind']
  const safeMessages: Record<CareerSiteLinkedInAuthPrompt['kind'], string | null> = {
    login: 'Sign in to LinkedIn in the live browser.',
    mfa: 'Complete LinkedIn multi-factor authentication in the live browser.',
    checkpoint: 'Complete the LinkedIn security checkpoint in the live browser.',
    none: null,
  }
  return { kind, message: safeMessages[kind] }
}

function parseEnvelope(value: unknown): CareerSiteLinkedInSessionEnvelope | null {
  if (value === null || value === undefined) return null
  const record = exactRecord(
    value,
    ['algorithm', 'version', 'ciphertext', 'iv', 'tag'],
    'encryptedSessionEnvelope',
  )
  if (record.algorithm !== 'A256GCM' || record.version !== 1) {
    throw new CareerSiteLinkedInRequestError('encryptedSessionEnvelope metadata is invalid')
  }
  const ciphertext = boundedText(
    record.ciphertext,
    'encryptedSessionEnvelope.ciphertext',
    Math.ceil(CAREER_SITE_LINKEDIN_MAX_SESSION_BYTES * 4 / 3) + 8,
  ) as string
  const iv = boundedText(record.iv, 'encryptedSessionEnvelope.iv', 32) as string
  const tag = boundedText(record.tag, 'encryptedSessionEnvelope.tag', 32) as string
  if (
    !BASE64URL_PATTERN.test(ciphertext)
    || !BASE64URL_PATTERN.test(iv)
    || !BASE64URL_PATTERN.test(tag)
    || Buffer.from(ciphertext, 'base64url').byteLength > CAREER_SITE_LINKEDIN_MAX_SESSION_BYTES
    || Buffer.from(iv, 'base64url').byteLength !== 12
    || Buffer.from(tag, 'base64url').byteLength !== 16
  ) {
    throw new CareerSiteLinkedInRequestError('encryptedSessionEnvelope is invalid')
  }
  return { algorithm: 'A256GCM', version: 1, ciphertext, iv, tag }
}

export function parseCareerSiteLinkedInWorkerClaimRequest(
  value: unknown,
): CareerSiteLinkedInWorkerClaimRequest {
  const record = exactRecord(value, ['workerId', 'capabilities'], 'LinkedIn worker claim')
  const workerId = String(record.workerId || '').trim()
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new CareerSiteLinkedInRequestError('workerId is invalid')
  }
  if (!Array.isArray(record.capabilities) || record.capabilities.length < 1 || record.capabilities.length > 2) {
    throw new CareerSiteLinkedInRequestError('capabilities must contain supported worker capabilities')
  }
  const capabilities = record.capabilities.map((value) => String(value))
  if (
    new Set(capabilities).size !== capabilities.length
    || capabilities.some((value) => !['interactive_auth', 'jobs_read'].includes(value))
  ) {
    throw new CareerSiteLinkedInRequestError('capabilities contain an unsupported or duplicate value')
  }
  return {
    workerId,
    capabilities: capabilities as CareerSiteLinkedInWorkerClaimRequest['capabilities'],
  }
}

export function parseCareerSiteLinkedInWorkerReportRequest(
  value: unknown,
): CareerSiteLinkedInWorkerReportRequest {
  const record = exactRecord(
    value,
    [
      'leaseId', 'leaseToken', 'status', 'authState', 'encryptedSessionEnvelope',
      'jobs', 'evidence', 'errorCode', 'errorMessage',
    ],
    'LinkedIn worker report',
  )
  const status = String(record.status)
  if (!['awaiting_auth', 'running', 'succeeded', 'failed', 'restricted'].includes(status)) {
    throw new CareerSiteLinkedInRequestError('status is invalid')
  }
  const jobs = record.jobs === undefined ? [] : record.jobs
  if (!Array.isArray(jobs) || jobs.length > CAREER_SITE_LINKEDIN_MAX_RESULTS) {
    throw new CareerSiteLinkedInRequestError(
      `jobs must contain at most ${CAREER_SITE_LINKEDIN_MAX_RESULTS} results`,
    )
  }
  const seenExternalIds = new Set<string>()
  const normalizedJobs: CareerSiteLinkedInJob[] = []
  for (let index = 0; index < jobs.length; index += 1) {
    try {
      const job = parseJob(jobs[index], index)
      if (job.description.length < 40 || seenExternalIds.has(job.externalId)) continue
      seenExternalIds.add(job.externalId)
      normalizedJobs.push(job)
    } catch {
      // Provider pages are mutable. Invalid candidates are ignored instead of
      // poisoning the exact scan run; the remaining candidates retain order.
    }
  }
  let evidence: CareerSiteLinkedInWorkerReportRequest['evidence'] = null
  if (record.evidence !== null && record.evidence !== undefined) {
    const item = exactRecord(
      record.evidence,
      ['event', 'capturedAt', 'memberName', 'profileUrl', 'sessionExpiresAt'],
      'evidence',
    )
    if (!['live_token_redeemed', 'page_state'].includes(String(item.event))) {
      throw new CareerSiteLinkedInRequestError('evidence.event is invalid')
    }
    const profileUrl = publicHttpsUrl(item.profileUrl, 'evidence.profileUrl', {
      linkedIn: true,
      nullable: true,
    })
    if (profileUrl) {
      const parsedProfile = new URL(profileUrl)
      if (!/^\/in\/[A-Za-z0-9%._~-]+\/?$/.test(parsedProfile.pathname)) {
        throw new CareerSiteLinkedInRequestError('evidence.profileUrl is not a LinkedIn profile URL')
      }
      parsedProfile.search = ''
      parsedProfile.hash = ''
      parsedProfile.hostname = 'www.linkedin.com'
      evidence = {
        event: item.event as 'live_token_redeemed' | 'page_state',
        capturedAt: isoTimestamp(item.capturedAt, 'evidence.capturedAt') as string,
        memberName: boundedText(item.memberName, 'evidence.memberName', 200, { nullable: true }),
        profileUrl: parsedProfile.toString(),
        sessionExpiresAt: isoTimestamp(item.sessionExpiresAt, 'evidence.sessionExpiresAt', true),
      }
    } else evidence = {
      event: item.event as 'live_token_redeemed' | 'page_state',
      capturedAt: isoTimestamp(item.capturedAt, 'evidence.capturedAt') as string,
      memberName: boundedText(item.memberName, 'evidence.memberName', 200, { nullable: true }),
      profileUrl: null,
      sessionExpiresAt: isoTimestamp(item.sessionExpiresAt, 'evidence.sessionExpiresAt', true),
    }
  }
  const errorCode = optionalErrorCode(record.errorCode)
  boundedText(record.errorMessage, 'errorMessage', 1_000, { nullable: true })
  const errorMessage = null
  if (['failed', 'restricted'].includes(status) && !errorCode) {
    throw new CareerSiteLinkedInRequestError('failed reports require errorCode')
  }
  if (status !== 'succeeded' && normalizedJobs.length > 0) {
    throw new CareerSiteLinkedInRequestError('jobs are only accepted with a succeeded report')
  }
  return {
    leaseId: uuid(record.leaseId, 'leaseId'),
    leaseToken: uuid(record.leaseToken, 'leaseToken'),
    status: status as CareerSiteLinkedInWorkerReportRequest['status'],
    authState: parsePrompt(record.authState),
    encryptedSessionEnvelope: parseEnvelope(record.encryptedSessionEnvelope),
    jobs: normalizedJobs,
    evidence,
    errorCode,
    errorMessage,
  }
}

function workerPublicUrl(): string {
  try {
    const url = publicHttpsUrl(
      String(process.env.CAREER_LINKEDIN_BROWSER_PUBLIC_URL || '').trim(),
      'CAREER_LINKEDIN_BROWSER_PUBLIC_URL',
    )
    if (!url) throw new Error()
    const parsed = new URL(url)
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error()
    return parsed.toString()
  } catch {
    throw new CareerSiteLinkedInConfigurationError('LinkedIn browser worker URL is invalid')
  }
}

export function resolveCareerSiteLinkedInConfiguration(): CareerSiteLinkedInConfiguration {
  const ownerEmail = String(process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL || '').trim().toLowerCase()
  const organizationId = String(process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID || '').trim().toLowerCase()
  if (
    ownerEmail !== CAREER_SITE_LINKEDIN_OWNER_EMAIL
    || organizationId !== CAREER_SITE_LINKEDIN_ORGANIZATION_ID
  ) {
    throw new CareerSiteLinkedInConfigurationError('Career Desk LinkedIn identity is not configured')
  }
  const workerToken = String(process.env.CAREER_LINKEDIN_BROWSER_WORKER_TOKEN || '').trim()
  const workerHmacSecret = String(
    process.env.CAREER_LINKEDIN_BROWSER_WORKER_HMAC_SECRET || '',
  ).trim()
  let shortLinkSecrets: string[] = []
  try {
    const clients = JSON.parse(String(process.env.SHORTLINK_SERVICE_CLIENTS_JSON || '[]')) as unknown
    if (Array.isArray(clients)) {
      shortLinkSecrets = clients.flatMap((client) => (
        client && typeof client === 'object' && typeof (client as { secret?: unknown }).secret === 'string'
          ? [(client as { secret: string }).secret]
          : []
      ))
    }
  } catch {
    // The existing short-link validator owns malformed client configuration.
  }
  const otherSecrets = [
    process.env.PIPELINE_OUTBOX_WORKER_SECRET,
    process.env.CAREER_SITE_AGENT_SERVICE_SECRET,
    ...shortLinkSecrets,
  ].filter(Boolean)
  if (
    workerToken.length < 32
    || workerToken.length > 512
    || workerHmacSecret.length < 32
    || workerHmacSecret.length > 512
    || /[\u0000-\u001f\u007f]/.test(workerToken)
    || /[\u0000-\u001f\u007f]/.test(workerHmacSecret)
    || workerToken === workerHmacSecret
    || otherSecrets.includes(workerToken)
    || otherSecrets.includes(workerHmacSecret)
  ) {
    throw new CareerSiteLinkedInConfigurationError(
      'LinkedIn browser worker secret is missing or not isolated',
    )
  }
  return {
    enabled: process.env.CAREER_SITE_LINKEDIN_ENABLED === '1',
    sourceApp: CAREER_SITE_LINKEDIN_SOURCE_APP,
    ownerEmail: CAREER_SITE_LINKEDIN_OWNER_EMAIL,
    organizationId: CAREER_SITE_LINKEDIN_ORGANIZATION_ID,
    workerPublicUrl: workerPublicUrl(),
    workerToken,
    workerHmacSecret,
  }
}

export function assertLinkedInUuid(value: unknown, label: string): string {
  return uuid(value, label)
}

export function assertLinkedInLeaseToken(value: unknown): string {
  const token = String(value || '').trim().toLowerCase()
  if (!LEASE_TOKEN_PATTERN.test(token)) {
    throw new CareerSiteLinkedInRequestError('leaseToken must be a UUID')
  }
  return token
}
