import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import {
  CAREER_SITE_SUBMISSION_SHEET_HEADERS,
  CareerSiteSubmissionConfigurationError,
  CareerSiteSubmissionRequestError,
  CareerSiteSubmissionSheetBoundaryError,
  assertPrivateCareerSiteSheetBoundary,
  careerSiteSubmissionPayloadHash,
  careerSiteSubmissionSheetRow,
  parseCareerSiteSubmission,
  resolveCareerSiteSubmissionConfiguration,
} from '../../lib/careerSiteSubmissionContract.ts'

const contactId = '11111111-1111-4111-8111-111111111111'
const resumeId = '22222222-2222-4222-8222-222222222222'
const newsletterId = '33333333-3333-4333-8333-333333333333'
const organizationId = '405bb919-0364-4a88-8a62-b4c9da42cd8f'

test('normalizes a bounded contact submission without adding consent', () => {
  const submission = parseCareerSiteSubmission({
    submissionId: contactId.toUpperCase(),
    formType: 'contact',
    name: '  Avery   Recruiter ',
    email: ' Avery.Recruiter@Example.com ',
    organization: ' Example   Company ',
    interest: 'leadership',
    message: 'I would like to discuss a VP supply-chain transformation role.',
    sourceUrl: 'https://jarrett.suburbiasandwichco.com/contact?campaign=private#form',
  })

  assert.equal(submission.externalSubmissionId, contactId)
  assert.equal(submission.requesterName, 'Avery Recruiter')
  assert.equal(submission.requesterEmail, 'avery.recruiter@example.com')
  assert.equal(submission.requesterOrganization, 'Example Company')
  assert.equal(submission.newsletterConsent, false)
  assert.equal(submission.networkInterest, false)
  assert.equal(submission.roleFit, false)
  assert.equal(submission.sourceUrl, 'https://jarrett.suburbiasandwichco.com/contact')
})

test('keeps résumé networking and role-fit choices separate from newsletter consent', () => {
  const submission = parseCareerSiteSubmission({
    submissionId: resumeId,
    formType: 'resume-request',
    name: 'Morgan Hiring Manager',
    email: 'morgan@example.com',
    message: 'Director role in Fairfield County',
    networkInterest: true,
    roleFit: true,
    resumeVariant: 'executive',
  })

  assert.equal(submission.networkInterest, true)
  assert.equal(submission.roleFit, true)
  assert.equal(submission.newsletterConsent, false)
  assert.equal(submission.resumeVariant, 'executive')
  assert.throws(
    () => parseCareerSiteSubmission({
      submissionId: resumeId,
      formType: 'resume-request',
      name: 'Morgan Hiring Manager',
      email: 'morgan@example.com',
      newsletterConsent: true,
      resumeVariant: 'executive',
    }),
    CareerSiteSubmissionRequestError,
  )
  for (const missing of ['networkInterest', 'roleFit'] as const) {
    const body: Record<string, unknown> = {
      submissionId: resumeId,
      formType: 'resume-request',
      name: 'Morgan Hiring Manager',
      email: 'morgan@example.com',
      networkInterest: false,
      roleFit: false,
      resumeVariant: 'executive',
    }
    delete body[missing]
    assert.throws(
      () => parseCareerSiteSubmission(body),
      (error: unknown) => (
        error instanceof CareerSiteSubmissionRequestError
        && error.message === `${missing} must be explicitly true or false`
      ),
    )
  }
})

test('requires an exact private My Drive owner and service-account permission boundary', () => {
  const valid = {
    sheetId: '1abc_DEF-234',
    ownerEmail: 'jarrett@suburbiasandwichco.com',
    serviceAccountEmail: 'clawpilot@project.iam.gserviceaccount.com',
    file: {
      id: '1abc_DEF-234',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      trashed: false,
      writersCanShare: false,
      capabilities: { canEdit: true },
      owners: [{ emailAddress: 'jarrett@suburbiasandwichco.com' }],
    },
    permissions: [
      {
        id: 'owner-permission',
        type: 'user',
        role: 'owner',
        emailAddress: 'jarrett@suburbiasandwichco.com',
      },
      {
        id: 'service-permission',
        type: 'user',
        role: 'writer',
        emailAddress: 'clawpilot@project.iam.gserviceaccount.com',
      },
    ],
  }
  assert.doesNotThrow(() => assertPrivateCareerSiteSheetBoundary(valid))

  const invalidBoundaries = [
    { ...valid, file: { ...valid.file, driveId: 'shared-drive-id' } },
    { ...valid, file: { ...valid.file, writersCanShare: true } },
    {
      ...valid,
      file: {
        ...valid.file,
        owners: [{ emailAddress: 'someone-else@example.com' }],
      },
    },
    {
      ...valid,
      permissions: [
        ...valid.permissions,
        { id: 'public-permission', type: 'anyone', role: 'reader' },
      ],
    },
    {
      ...valid,
      permissions: valid.permissions.map((permission) => (
        permission.role === 'writer' ? { ...permission, role: 'reader' } : permission
      )),
    },
    {
      ...valid,
      permissions: [
        ...valid.permissions,
        { id: 'published-permission', type: 'anyone', role: 'publishedReader', view: 'published' },
      ],
    },
  ]
  for (const boundary of invalidBoundaries) {
    assert.throws(
      () => assertPrivateCareerSiteSheetBoundary(boundary),
      CareerSiteSubmissionSheetBoundaryError,
    )
  }
})

test('requires a standalone explicit newsletter opt-in', () => {
  const submission = parseCareerSiteSubmission({
    submissionId: newsletterId,
    formType: 'newsletter',
    email: 'viewer@example.com',
    newsletterConsent: true,
  })
  assert.equal(submission.newsletterConsent, true)
  assert.equal(submission.requesterName, null)

  assert.throws(
    () => parseCareerSiteSubmission({
      submissionId: newsletterId,
      formType: 'newsletter',
      email: 'viewer@example.com',
    }),
    CareerSiteSubmissionRequestError,
  )
  assert.throws(
    () => parseCareerSiteSubmission({
      submissionId: newsletterId,
      formType: 'newsletter',
      email: 'viewer@example.com',
      newsletterConsent: true,
      organization: 'Unrelated field',
    }),
    CareerSiteSubmissionRequestError,
  )
})

test('rejects unknown transport and secret-bearing fields', () => {
  assert.throws(
    () => parseCareerSiteSubmission({
      submissionId: contactId,
      formType: 'contact',
      name: 'Avery Recruiter',
      email: 'avery@example.com',
      interest: 'leadership',
      message: 'This is a valid-length contact message.',
      turnstileToken: 'must-not-cross-the-service-boundary',
    }),
    (error: unknown) => (
      error instanceof CareerSiteSubmissionRequestError
      && error.code === 'CAREER_SITE_SUBMISSION_FIELD_INVALID'
    ),
  )
  assert.throws(
    () => parseCareerSiteSubmission({
      submissionId: contactId,
      formType: 'contact',
      name: 'Avery Recruiter',
      email: 'avery@example.com',
      interest: 'leadership',
      message: 'This is a valid-length contact message.',
      sourceUrl: 'https://example.com/career-site',
    }),
    (error: unknown) => (
      error instanceof CareerSiteSubmissionRequestError
      && error.code === 'CAREER_SITE_SUBMISSION_SOURCE_URL_INVALID'
    ),
  )
})

test('uses stable normalized hashes and a Sheet row with no link or token columns', () => {
  const submission = parseCareerSiteSubmission({
    submissionId: contactId,
    formType: 'contact',
    name: 'Formula Test',
    email: 'formula@example.com',
    interest: 'other',
    message: '=HYPERLINK("https://example.com", "do not evaluate")',
  })
  assert.equal(
    careerSiteSubmissionPayloadHash(submission),
    careerSiteSubmissionPayloadHash({ ...submission }),
  )
  const row = careerSiteSubmissionSheetRow({
    ...submission,
    sourceApp: 'jarrett-career-site',
    ownerEmail: 'jarrett@suburbiasandwichco.com',
    createdAt: '2026-08-25T12:00:00.000Z',
  })
  assert.equal(row[9], 'Interest: other\n=HYPERLINK("https://example.com", "do not evaluate")')
  assert.equal(row[11], 'New')
  assert.equal(row[14], 'Not applicable')
  assert.equal(row[16], 'jarrett@suburbiasandwichco.com')
  assert.equal(row[18], '')
  assert.equal(row.length, CAREER_SITE_SUBMISSION_SHEET_HEADERS.length)
  assert.deepEqual(CAREER_SITE_SUBMISSION_SHEET_HEADERS, [
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
  ])
  assert.doesNotMatch(CAREER_SITE_SUBMISSION_SHEET_HEADERS.join(' '), /token|short.?link url|resume url/i)
})

test('initializes only safe tracker lifecycle fields for resume and newsletter rows', () => {
  const resume = parseCareerSiteSubmission({
    submissionId: resumeId,
    formType: 'resume-request',
    name: 'Morgan Hiring Manager',
    email: 'morgan@example.com',
    networkInterest: true,
    roleFit: false,
    resumeVariant: 'servicenow',
    sourceUrl: 'https://jarrett.suburbiasandwichco.com/brief/servicenow',
  })
  const resumeRow = careerSiteSubmissionSheetRow({
    ...resume,
    sourceApp: 'jarrett-career-site',
    ownerEmail: 'jarrett@suburbiasandwichco.com',
    createdAt: '2026-08-25T12:00:00.000Z',
  })
  assert.equal(resumeRow[6], 'servicenow')
  assert.equal(resumeRow[7], 'Yes')
  assert.equal(resumeRow[8], 'No')
  assert.equal(resumeRow[10], 'No')
  assert.equal(resumeRow[11], 'New')
  assert.equal(resumeRow[12], '')
  assert.equal(resumeRow[13], '')
  assert.equal(resumeRow[14], 'Pending')
  assert.equal(resumeRow[15], 'https://jarrett.suburbiasandwichco.com/brief/servicenow')

  const newsletter = parseCareerSiteSubmission({
    submissionId: newsletterId,
    formType: 'newsletter',
    email: 'viewer@example.com',
    newsletterConsent: true,
  })
  const newsletterRow = careerSiteSubmissionSheetRow({
    ...newsletter,
    sourceApp: 'jarrett-career-site',
    ownerEmail: 'jarrett@suburbiasandwichco.com',
    createdAt: '2026-08-25T12:00:00.000Z',
  })
  assert.equal(newsletterRow[7], '')
  assert.equal(newsletterRow[8], '')
  assert.equal(newsletterRow[10], 'Yes')
  assert.equal(newsletterRow[14], 'Not applicable')
})

test('configuration is disabled by default and fails closed when enabled incompletely', () => {
  assert.deepEqual(resolveCareerSiteSubmissionConfiguration({}), {
    enabled: false,
    sourceApp: 'jarrett-career-site',
    ownerEmail: null,
    organizationId: null,
    sheetId: null,
    sheetTab: 'Submissions',
    sheetHeaderRow: 4,
  })
  assert.throws(
    () => resolveCareerSiteSubmissionConfiguration({ CAREER_SITE_SUBMISSIONS_ENABLED: '1' }),
    CareerSiteSubmissionConfigurationError,
  )
  assert.deepEqual(resolveCareerSiteSubmissionConfiguration({
    CAREER_SITE_SUBMISSIONS_ENABLED: '1',
    CAREER_SITE_SUBMISSIONS_OWNER_EMAIL: 'Jarrett@SuburbiaSandwichCo.com',
    CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID: organizationId,
    CAREER_SITE_SUBMISSIONS_SHEET_ID: '1abc_DEF-234',
  }), {
    enabled: true,
    sourceApp: 'jarrett-career-site',
    ownerEmail: 'jarrett@suburbiasandwichco.com',
    organizationId,
    sheetId: '1abc_DEF-234',
    sheetTab: 'Submissions',
    sheetHeaderRow: 4,
  })
  assert.throws(
    () => resolveCareerSiteSubmissionConfiguration({
      CAREER_SITE_SUBMISSIONS_SHEET_HEADER_ROW: '0',
    }),
    CareerSiteSubmissionConfigurationError,
  )
  assert.throws(
    () => resolveCareerSiteSubmissionConfiguration({
      CAREER_SITE_SUBMISSIONS_ENABLED: '1',
      CAREER_SITE_SUBMISSIONS_OWNER_EMAIL: 'other@suburbiasandwichco.com',
      CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID: organizationId,
      CAREER_SITE_SUBMISSIONS_SHEET_ID: '1abc_DEF-234',
    }),
    CareerSiteSubmissionConfigurationError,
  )
})
