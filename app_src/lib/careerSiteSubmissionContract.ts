import { createHash } from 'node:crypto'

const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const GOOGLE_RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
const OWNER_EMAIL_MAX_LENGTH = 254
const REQUESTER_EMAIL_MAX_LENGTH = 160
const CAREER_SITE_SOURCE_APP = 'jarrett-career-site'
const CAREER_SITE_PUBLIC_ORIGIN = 'https://jarrett.suburbiasandwichco.com'

const CONTACT_INTERESTS = new Set([
  'leadership',
  'advisory',
  'product',
  'media',
  'other',
])
const RESUME_VARIANTS = new Set(['executive', 'servicenow', 'odyssey'])
const FORM_TYPES = new Set(['contact', 'resume-request', 'newsletter'])
const REQUEST_FIELDS = new Set([
  'submissionId',
  'formType',
  'name',
  'email',
  'organization',
  'interest',
  'message',
  'networkInterest',
  'roleFit',
  'newsletterConsent',
  'resumeVariant',
  'sourceUrl',
])

export type CareerSiteSubmissionFormType = 'contact' | 'resume-request' | 'newsletter'

export type NormalizedCareerSiteSubmission = {
  externalSubmissionId: string
  formType: CareerSiteSubmissionFormType
  requesterName: string | null
  requesterEmail: string
  requesterOrganization: string | null
  interest: 'leadership' | 'advisory' | 'product' | 'media' | 'other' | null
  message: string | null
  networkInterest: boolean
  roleFit: boolean
  newsletterConsent: boolean
  resumeVariant: 'executive' | 'servicenow' | 'odyssey' | null
  sourceUrl: string | null
}

export type CareerSiteSubmissionSheetRecord = NormalizedCareerSiteSubmission & {
  sourceApp: string
  ownerEmail: string
  createdAt: string
}

export type CareerSiteSubmissionConfiguration = {
  enabled: boolean
  sourceApp: typeof CAREER_SITE_SOURCE_APP
  ownerEmail: string | null
  sheetId: string | null
  sheetTab: string
  sheetHeaderRow: number
}

export class CareerSiteSubmissionRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'CAREER_SITE_SUBMISSION_INVALID',
  ) {
    super(message)
    this.name = 'CareerSiteSubmissionRequestError'
  }
}

export class CareerSiteSubmissionConfigurationError extends Error {
  constructor(
    message: string,
    readonly code = 'CAREER_SITE_SUBMISSIONS_CONFIGURATION_INVALID',
  ) {
    super(message)
    this.name = 'CareerSiteSubmissionConfigurationError'
  }
}

function normalizeEmail(value: unknown, label: string, maxLength: number) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (
    !email
    || email.length > maxLength
    || !EMAIL_PATTERN.test(email)
    || !/^[\x21-\x7e]+$/.test(email)
  ) {
    throw new CareerSiteSubmissionRequestError(
      `${label} must be a valid email address`,
      400,
      'CAREER_SITE_SUBMISSION_EMAIL_INVALID',
    )
  }
  return email
}

function cleanSingleLine(
  value: unknown,
  label: string,
  options: { required?: boolean; min?: number; max: number },
) {
  if (value === undefined || value === null || value === '') {
    if (options.required) {
      throw new CareerSiteSubmissionRequestError(`${label} is required`)
    }
    return null
  }
  if (typeof value !== 'string') {
    throw new CareerSiteSubmissionRequestError(`${label} must be text`)
  }
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (
    !cleaned
    || cleaned.length < (options.min || 0)
    || cleaned.length > options.max
    || /[\u0000-\u001f\u007f]/.test(cleaned)
  ) {
    throw new CareerSiteSubmissionRequestError(`${label} is invalid`)
  }
  return cleaned
}

function cleanMessage(
  value: unknown,
  label: string,
  options: { required?: boolean; min?: number; max: number },
) {
  if (value === undefined || value === null || value === '') {
    if (options.required) {
      throw new CareerSiteSubmissionRequestError(`${label} is required`)
    }
    return null
  }
  if (typeof value !== 'string') {
    throw new CareerSiteSubmissionRequestError(`${label} must be text`)
  }
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  if (
    !cleaned
    || cleaned.length < (options.min || 0)
    || cleaned.length > options.max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cleaned)
  ) {
    throw new CareerSiteSubmissionRequestError(`${label} is invalid`)
  }
  return cleaned
}

function optionalBoolean(value: unknown, label: string) {
  if (value === undefined) return false
  if (typeof value !== 'boolean') {
    throw new CareerSiteSubmissionRequestError(`${label} must be true or false`)
  }
  return value
}

function optionalSourceUrl(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 500) {
    throw new CareerSiteSubmissionRequestError('sourceUrl is invalid')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CareerSiteSubmissionRequestError('sourceUrl is invalid')
  }
  const allowed = new URL(CAREER_SITE_PUBLIC_ORIGIN)
  if (
    url.protocol !== allowed.protocol
    || url.hostname !== allowed.hostname
    || url.port
    || url.username
    || url.password
  ) {
    throw new CareerSiteSubmissionRequestError(
      'sourceUrl must be on the Jarrett Crosby career site',
      400,
      'CAREER_SITE_SUBMISSION_SOURCE_URL_INVALID',
    )
  }
  url.search = ''
  url.hash = ''
  return url.toString()
}

function rejectUnexpectedFields(record: Record<string, unknown>) {
  const unsupported = Object.keys(record).find((field) => !REQUEST_FIELDS.has(field))
  if (unsupported) {
    throw new CareerSiteSubmissionRequestError(
      `Unsupported career-site submission field: ${unsupported}`,
      400,
      'CAREER_SITE_SUBMISSION_FIELD_INVALID',
    )
  }
}

export function parseCareerSiteSubmission(value: unknown): NormalizedCareerSiteSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CareerSiteSubmissionRequestError('Request body must be a JSON object')
  }
  const record = value as Record<string, unknown>
  rejectUnexpectedFields(record)

  const externalSubmissionId = String(record.submissionId || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(externalSubmissionId)) {
    throw new CareerSiteSubmissionRequestError(
      'submissionId must be a UUID',
      400,
      'CAREER_SITE_SUBMISSION_ID_INVALID',
    )
  }
  const formTypeValue = String(record.formType || '').trim().toLowerCase()
  if (!FORM_TYPES.has(formTypeValue)) {
    throw new CareerSiteSubmissionRequestError(
      'formType must be contact, resume-request, or newsletter',
      400,
      'CAREER_SITE_SUBMISSION_FORM_INVALID',
    )
  }
  const formType = formTypeValue as CareerSiteSubmissionFormType
  const requesterEmail = normalizeEmail(record.email, 'email', REQUESTER_EMAIL_MAX_LENGTH)
  const requesterOrganization = cleanSingleLine(record.organization, 'organization', { max: 120 })
  const networkInterest = optionalBoolean(record.networkInterest, 'networkInterest')
  const roleFit = optionalBoolean(record.roleFit, 'roleFit')
  const newsletterConsent = optionalBoolean(record.newsletterConsent, 'newsletterConsent')
  const sourceUrl = optionalSourceUrl(record.sourceUrl)

  if (formType === 'contact') {
    const requesterName = cleanSingleLine(record.name, 'name', { required: true, min: 2, max: 100 })
    const interest = String(record.interest || '').trim().toLowerCase()
    if (!CONTACT_INTERESTS.has(interest)) {
      throw new CareerSiteSubmissionRequestError('contact interest is invalid')
    }
    if (networkInterest || roleFit || newsletterConsent || record.resumeVariant !== undefined) {
      throw new CareerSiteSubmissionRequestError(
        'Contact submissions cannot imply résumé or newsletter consent',
        400,
        'CAREER_SITE_SUBMISSION_CONSENT_INVALID',
      )
    }
    return {
      externalSubmissionId,
      formType,
      requesterName,
      requesterEmail,
      requesterOrganization,
      interest: interest as NormalizedCareerSiteSubmission['interest'],
      message: cleanMessage(record.message, 'message', { required: true, min: 12, max: 3000 }),
      networkInterest: false,
      roleFit: false,
      newsletterConsent: false,
      resumeVariant: null,
      sourceUrl,
    }
  }

  if (formType === 'resume-request') {
    const requesterName = cleanSingleLine(record.name, 'name', { required: true, min: 2, max: 100 })
    const resumeVariant = String(record.resumeVariant || '').trim().toLowerCase()
    if (!RESUME_VARIANTS.has(resumeVariant)) {
      throw new CareerSiteSubmissionRequestError('resumeVariant is invalid')
    }
    if (newsletterConsent || record.interest !== undefined) {
      throw new CareerSiteSubmissionRequestError(
        'Résumé requests do not create newsletter consent',
        400,
        'CAREER_SITE_SUBMISSION_CONSENT_INVALID',
      )
    }
    return {
      externalSubmissionId,
      formType,
      requesterName,
      requesterEmail,
      requesterOrganization,
      interest: null,
      message: cleanMessage(record.message, 'context', { max: 1000 }),
      networkInterest,
      roleFit,
      newsletterConsent: false,
      resumeVariant: resumeVariant as NormalizedCareerSiteSubmission['resumeVariant'],
      sourceUrl,
    }
  }

  if (
    newsletterConsent !== true
    || record.name !== undefined
    || record.organization !== undefined
    || record.interest !== undefined
    || record.message !== undefined
    || networkInterest
    || roleFit
    || record.resumeVariant !== undefined
  ) {
    throw new CareerSiteSubmissionRequestError(
      'Newsletter submissions require separate explicit consent and no unrelated fields',
      400,
      'CAREER_SITE_SUBMISSION_CONSENT_INVALID',
    )
  }
  return {
    externalSubmissionId,
    formType,
    requesterName: null,
    requesterEmail,
    requesterOrganization: null,
    interest: null,
    message: null,
    networkInterest: false,
    roleFit: false,
    newsletterConsent: true,
    resumeVariant: null,
    sourceUrl,
  }
}

export function careerSiteSubmissionPayloadHash(input: NormalizedCareerSiteSubmission) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export const CAREER_SITE_SUBMISSION_SHEET_HEADERS = [
  'Submission ID',
  'Submitted At (UTC)',
  'Submission Type',
  'Full Name',
  'Email',
  'Organization',
  'Resume Variant',
  'Network Interest',
  'Role Fit',
  'Message / Interest',
  'Marketing Consent',
  'Status',
  'Approval Mode',
  'Resume Edition',
  'Shortlink Status',
  'Source URL',
  'ClawPilot Owner',
  'Last Updated At (UTC)',
  'Internal Notes',
] as const

export function careerSiteSubmissionSheetRow(input: CareerSiteSubmissionSheetRecord): string[] {
  const submittedAt = new Date(input.createdAt).toISOString()
  const messageOrInterest = input.formType === 'contact'
    ? [`Interest: ${input.interest}`, input.message].filter(Boolean).join('\n')
    : input.message || ''
  return [
    input.externalSubmissionId,
    submittedAt,
    input.formType,
    input.requesterName || '',
    input.requesterEmail,
    input.requesterOrganization || '',
    input.resumeVariant || '',
    input.formType === 'resume-request' ? (input.networkInterest ? 'Yes' : 'No') : '',
    input.formType === 'resume-request' ? (input.roleFit ? 'Yes' : 'No') : '',
    messageOrInterest,
    input.newsletterConsent ? 'Yes' : 'No',
    'New',
    '',
    '',
    input.formType === 'resume-request' ? 'Pending' : 'Not applicable',
    input.sourceUrl || '',
    input.ownerEmail,
    submittedAt,
    '',
  ]
}

export function resolveCareerSiteSubmissionConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): CareerSiteSubmissionConfiguration {
  const enabledValue = String(environment.CAREER_SITE_SUBMISSIONS_ENABLED || '0').trim()
  if (enabledValue !== '0' && enabledValue !== '1') {
    throw new CareerSiteSubmissionConfigurationError(
      'CAREER_SITE_SUBMISSIONS_ENABLED must be 0 or 1',
    )
  }
  const enabled = enabledValue === '1'
  const sheetTab = String(environment.CAREER_SITE_SUBMISSIONS_SHEET_TAB || 'Submissions').trim()
  if (!sheetTab || sheetTab.length > 100 || /[\u0000-\u001f\u007f]/.test(sheetTab)) {
    throw new CareerSiteSubmissionConfigurationError(
      'CAREER_SITE_SUBMISSIONS_SHEET_TAB is invalid',
    )
  }
  const sheetHeaderRowValue = String(environment.CAREER_SITE_SUBMISSIONS_SHEET_HEADER_ROW || '4').trim()
  const sheetHeaderRow = Number(sheetHeaderRowValue)
  if (!/^\d+$/.test(sheetHeaderRowValue) || !Number.isInteger(sheetHeaderRow) || sheetHeaderRow < 1 || sheetHeaderRow > 1000) {
    throw new CareerSiteSubmissionConfigurationError(
      'CAREER_SITE_SUBMISSIONS_SHEET_HEADER_ROW must be an integer from 1 through 1000',
    )
  }
  if (!enabled) {
    return {
      enabled: false,
      sourceApp: CAREER_SITE_SOURCE_APP,
      ownerEmail: null,
      sheetId: null,
      sheetTab,
      sheetHeaderRow,
    }
  }

  let ownerEmail: string
  try {
    ownerEmail = normalizeEmail(
      environment.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL,
      'CAREER_SITE_SUBMISSIONS_OWNER_EMAIL',
      OWNER_EMAIL_MAX_LENGTH,
    )
  } catch {
    throw new CareerSiteSubmissionConfigurationError(
      'CAREER_SITE_SUBMISSIONS_OWNER_EMAIL must be a valid email address',
    )
  }
  const sheetId = String(environment.CAREER_SITE_SUBMISSIONS_SHEET_ID || '').trim()
  if (!GOOGLE_RESOURCE_ID_PATTERN.test(sheetId)) {
    throw new CareerSiteSubmissionConfigurationError(
      'CAREER_SITE_SUBMISSIONS_SHEET_ID must be a valid Google Sheet ID',
    )
  }
  return {
    enabled: true,
    sourceApp: CAREER_SITE_SOURCE_APP,
    ownerEmail,
    sheetId,
    sheetTab,
    sheetHeaderRow,
  }
}
