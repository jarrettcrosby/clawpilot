import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import test from 'node:test'
import {
  CareerSiteMailConfigurationError,
  CareerSiteMailRequestError,
  parseCareerSiteMailRequest,
  resolveCareerSiteMailConfiguration,
} from '../../lib/careerSiteMailContract.ts'

const contactId = '7a217940-8ec0-4bb6-89e6-8a4e2bc75355'
const newsletterId = 'e24a11e7-100c-49da-b9ec-d59678a0ba29'
const requestId = '0b43bb55-f85e-4492-ab4a-7f22582137e5'
const organizationId = '405bb919-0364-4a88-8a62-b4c9da42cd8f'
const approvalOrigins = [
  'https://jarrett.suburbiasandwichco.com',
  'https://jarrett-suburbia-preview-123.vercel.app',
]

test('parses the four exact career-site mail message contracts', () => {
  const contact = parseCareerSiteMailRequest({
    messageType: 'contact-notification',
    idempotencyKey: `contact/${contactId}`,
    data: {
      submissionId: contactId,
      name: 'Avery Recruiter',
      email: 'AVERY@example.com',
      organization: 'Example Company',
      interest: 'leadership',
      message: 'I would like to discuss a leadership role.',
    },
  })
  assert.equal(contact.data.email, 'avery@example.com')

  const newsletter = parseCareerSiteMailRequest({
    messageType: 'newsletter-request',
    idempotencyKey: `newsletter/${newsletterId}`,
    data: { submissionId: newsletterId, email: 'viewer@example.com' },
  })
  assert.equal(newsletter.messageType, 'newsletter-request')

  const approval = parseCareerSiteMailRequest({
    messageType: 'resume-approval-request',
    idempotencyKey: `resume-request/${requestId}`,
    data: {
      requestId,
      name: 'Morgan Hiring Manager',
      email: 'morgan@example.com',
      organization: '',
      context: 'Director role in Fairfield County',
      networkInterest: true,
      roleFit: false,
      variant: 'executive',
      approvalUrl: `https://jarrett-suburbia-preview-123.vercel.app/resume/approve?token=${'a'.repeat(64)}`,
    },
  }, { approvalOrigins })
  assert.equal(approval.data.organization, null)

  const approved = parseCareerSiteMailRequest({
    messageType: 'approved-resume-link',
    idempotencyKey: `resume-approved/${requestId}`,
    data: {
      requestId,
      name: 'Morgan Hiring Manager',
      email: 'morgan@example.com',
      shortUrl: 'https://eigenracing.com/s/jc-e932dd582ff22890',
      variant: 'executive',
      documentStyle: 'ats',
      accessMode: 'view-only',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  }, { shortLinkOrigin: 'https://eigenracing.com' })
  assert.equal(approved.data.accessMode, 'view-only')
})

test('rejects unknown fields and idempotency mismatches', () => {
  assert.throws(
    () => parseCareerSiteMailRequest({
      messageType: 'newsletter-request',
      idempotencyKey: `newsletter/${newsletterId}`,
      data: { submissionId: newsletterId, email: 'viewer@example.com', marketing: true },
    }),
    (error) => error instanceof CareerSiteMailRequestError
      && error.code === 'CAREER_SITE_MAIL_FIELD_INVALID',
  )
  assert.throws(
    () => parseCareerSiteMailRequest({
      messageType: 'newsletter-request',
      idempotencyKey: `newsletter/${contactId}`,
      data: { submissionId: newsletterId, email: 'viewer@example.com' },
    }),
    (error) => error instanceof CareerSiteMailRequestError
      && error.code === 'CAREER_SITE_MAIL_IDEMPOTENCY_KEY_INVALID',
  )
})

test('restricts action and secure-link hosts and paths', () => {
  assert.throws(() => parseCareerSiteMailRequest({
    messageType: 'resume-approval-request',
    idempotencyKey: `resume-request/${requestId}`,
    data: {
      requestId,
      name: 'Morgan Hiring Manager',
      email: 'morgan@example.com',
      networkInterest: false,
      roleFit: true,
      variant: 'executive',
      approvalUrl: `https://attacker.example/resume/approve?token=${'a'.repeat(64)}`,
    },
  }, { approvalOrigins }))
  assert.throws(() => parseCareerSiteMailRequest({
    messageType: 'resume-approval-request',
    idempotencyKey: `resume-request/${requestId}`,
    data: {
      requestId,
      name: 'Morgan Hiring Manager',
      email: 'morgan@example.com',
      networkInterest: false,
      roleFit: true,
      variant: 'executive',
      approvalUrl: `https://jarrett-suburbia-unlisted.vercel.app/resume/approve?token=${'a'.repeat(64)}`,
    },
  }, { approvalOrigins }))
  assert.throws(() => parseCareerSiteMailRequest({
    messageType: 'approved-resume-link',
    idempotencyKey: `resume-approved/${requestId}`,
    data: {
      requestId,
      name: 'Morgan Hiring Manager',
      email: 'morgan@example.com',
      shortUrl: 'https://eigenracing.com/s/not-a-career-link',
      variant: 'executive',
      documentStyle: 'ats',
      accessMode: 'view+download',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  }, { shortLinkOrigin: 'https://eigenracing.com' }))
  assert.throws(() => parseCareerSiteMailRequest({
    messageType: 'approved-resume-link',
    idempotencyKey: `resume-approved/${requestId}`,
    data: {
      requestId,
      name: 'Morgan Hiring Manager',
      email: 'morgan@example.com',
      shortUrl: 'https://eigenracing.com/s/jc-0123456789abcdef',
      variant: 'executive',
      documentStyle: 'ats',
      accessMode: 'view-only',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  }, { shortLinkOrigin: 'https://eigenracing.com' }))
  assert.throws(() => parseCareerSiteMailRequest({
    messageType: 'approved-resume-link',
    idempotencyKey: `resume-approved/${requestId}`,
    data: {
      requestId,
      name: 'Morgan Hiring Manager',
      email: 'morgan@example.com',
      shortUrl: 'https://aiapp.eigenracing.com/s/jc-0123456789abcdef',
      variant: 'executive',
      documentStyle: 'ats',
      accessMode: 'view-only',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  }, { shortLinkOrigin: 'https://eigenracing.com' }))
})

test('accepts the site maximum Unicode approval payload inside the 16KiB request envelope', () => {
  const maximum = {
    requestId,
    name: '界'.repeat(100),
    email: 'morgan@example.com',
    organization: '界'.repeat(120),
    context: '界'.repeat(1000),
    networkInterest: true,
    roleFit: true,
    variant: 'executive',
    purpose: 'resume-approval',
    version: 1,
    issuedAt: '2026-08-25T12:00:00.000Z',
    expiresAt: '2026-08-27T12:00:00.000Z',
  }
  const iv = Buffer.alloc(12, 1)
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 2), iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(maximum), 'utf8'),
    cipher.final(),
  ])
  const token = [
    'jca1',
    requestId,
    iv.toString('base64url'),
    encrypted.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.')
  assert.ok(token.length > 3072, 'regression fixture must exceed the former token cap')
  const request = {
    messageType: 'resume-approval-request',
    idempotencyKey: `resume-request/${requestId}`,
    data: {
      requestId,
      name: maximum.name,
      email: maximum.email,
      organization: maximum.organization,
      context: maximum.context,
      networkInterest: maximum.networkInterest,
      roleFit: maximum.roleFit,
      variant: maximum.variant,
      approvalUrl: `${approvalOrigins[1]}/resume/approve?token=${token}`,
    },
  }
  assert.ok(Buffer.byteLength(JSON.stringify(request), 'utf8') < 16 * 1024)
  const parsed = parseCareerSiteMailRequest(request, { approvalOrigins })
  assert.equal(parsed.data.approvalUrl, request.data.approvalUrl)
})

test('career mail configuration is exact and does not use global sender settings', () => {
  const configuration = resolveCareerSiteMailConfiguration({
    CAREER_SITE_SUBMISSIONS_ENABLED: '1',
    CAREER_SITE_SUBMISSIONS_OWNER_EMAIL: 'Jarrett@SuburbiaSandwichCo.com',
    CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID: organizationId,
    CAREER_SITE_MAIL_FROM: 'INFO@SuburbiaSandwichCo.com',
    CAREER_SITE_MAIL_FROM_NAME: 'Jarrett Crosby',
    CAREER_SITE_MAIL_REPLY_TO: 'JarrettCrosby@gmail.com',
    CAREER_SITE_MAIL_APPROVAL_TO: 'JarrettCrosby@gmail.com',
    SHORTLINK_PUBLIC_ORIGIN: 'https://eigenracing.com',
    CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON: JSON.stringify(approvalOrigins),
    CLAWPILOT_MAIL_FROM: 'stewards@eigenracing.com',
  })
  assert.deepEqual(configuration, {
    enabled: true,
    sourceApp: 'jarrett-career-site',
    ownerEmail: 'jarrett@suburbiasandwichco.com',
    organizationId,
    from: 'info@suburbiasandwichco.com',
    fromName: 'Jarrett Crosby',
    replyTo: 'jarrettcrosby@gmail.com',
    approvalTo: 'jarrettcrosby@gmail.com',
    shortLinkOrigin: 'https://eigenracing.com',
    approvalOrigins,
  })
  assert.throws(
    () => resolveCareerSiteMailConfiguration({
      CAREER_SITE_SUBMISSIONS_ENABLED: '1',
      CAREER_SITE_SUBMISSIONS_OWNER_EMAIL: 'jarrett@suburbiasandwichco.com',
      CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID: organizationId,
      CAREER_SITE_MAIL_FROM: 'stewards@eigenracing.com',
      CAREER_SITE_MAIL_FROM_NAME: 'Jarrett Crosby',
      CAREER_SITE_MAIL_REPLY_TO: 'JarrettCrosby@gmail.com',
      CAREER_SITE_MAIL_APPROVAL_TO: 'JarrettCrosby@gmail.com',
      SHORTLINK_PUBLIC_ORIGIN: 'https://eigenracing.com',
      CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON: JSON.stringify(approvalOrigins),
    }),
    CareerSiteMailConfigurationError,
  )
})
