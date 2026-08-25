import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CareerSiteMailConfigurationError,
  CareerSiteMailRequestError,
  careerSiteMailPayloadHash,
  parseCareerSiteMailRequest,
  resolveCareerSiteMailConfiguration,
} from '../../lib/careerSiteMailContract.ts'

const contactId = '7a217940-8ec0-4bb6-89e6-8a4e2bc75355'
const newsletterId = 'e24a11e7-100c-49da-b9ec-d59678a0ba29'
const requestId = '0b43bb55-f85e-4492-ab4a-7f22582137e5'

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
  })
  assert.equal(approval.data.organization, null)

  const approved = parseCareerSiteMailRequest({
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
  })
  assert.equal(approved.data.accessMode, 'view-only')
  assert.match(careerSiteMailPayloadHash(approved), /^[0-9a-f]{64}$/)
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
  }))
  assert.throws(() => parseCareerSiteMailRequest({
    messageType: 'approved-resume-link',
    idempotencyKey: `resume-approved/${requestId}`,
    data: {
      requestId,
      name: 'Morgan Hiring Manager',
      email: 'morgan@example.com',
      shortUrl: 'https://aiapp.eigenracing.com/s/not-a-career-link',
      variant: 'executive',
      documentStyle: 'ats',
      accessMode: 'view+download',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  }))
})

test('career mail configuration is exact and does not use global sender settings', () => {
  const configuration = resolveCareerSiteMailConfiguration({
    CAREER_SITE_SUBMISSIONS_ENABLED: '1',
    CAREER_SITE_SUBMISSIONS_OWNER_EMAIL: 'Jarrett@SuburbiaSandwichCo.com',
    CAREER_SITE_MAIL_FROM: 'INFO@SuburbiaSandwichCo.com',
    CAREER_SITE_MAIL_FROM_NAME: 'Jarrett Crosby',
    CAREER_SITE_MAIL_REPLY_TO: 'JarrettCrosby@gmail.com',
    CAREER_SITE_MAIL_APPROVAL_TO: 'JarrettCrosby@gmail.com',
    CLAWPILOT_MAIL_FROM: 'stewards@eigenracing.com',
  })
  assert.deepEqual(configuration, {
    enabled: true,
    sourceApp: 'jarrett-career-site',
    ownerEmail: 'jarrett@suburbiasandwichco.com',
    from: 'info@suburbiasandwichco.com',
    fromName: 'Jarrett Crosby',
    replyTo: 'jarrettcrosby@gmail.com',
    approvalTo: 'jarrettcrosby@gmail.com',
  })
  assert.throws(
    () => resolveCareerSiteMailConfiguration({
      CAREER_SITE_SUBMISSIONS_ENABLED: '1',
      CAREER_SITE_SUBMISSIONS_OWNER_EMAIL: 'jarrett@suburbiasandwichco.com',
      CAREER_SITE_MAIL_FROM: 'stewards@eigenracing.com',
      CAREER_SITE_MAIL_FROM_NAME: 'Jarrett Crosby',
      CAREER_SITE_MAIL_REPLY_TO: 'JarrettCrosby@gmail.com',
      CAREER_SITE_MAIL_APPROVAL_TO: 'JarrettCrosby@gmail.com',
    }),
    CareerSiteMailConfigurationError,
  )
})
