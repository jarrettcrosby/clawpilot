import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  CareerSiteLinkedInRequestError,
  parseCareerSiteLinkedInConnectRequest,
  parseCareerSiteLinkedInScanRequest,
  parseCareerSiteLinkedInWorkerClaimRequest,
  parseCareerSiteLinkedInWorkerReportRequest,
  resolveCareerSiteLinkedInConfiguration,
} from '../../lib/careerSiteLinkedInContract.ts'
import {
  careerSiteLinkedInRedemptionLeaseDigest,
  classifyCareerSiteLinkedInRedemption,
} from '../../lib/careerSiteLinkedInRedemption.ts'
import {
  careerSiteLinkedInReportBodyDigest,
  careerSiteLinkedInReportLeaseDigest,
  exactCareerSiteLinkedInReportReceipt,
} from '../../lib/careerSiteLinkedInReportReceipt.ts'

const originalEnvironment = {
  CAREER_SITE_LINKEDIN_ENABLED: process.env.CAREER_SITE_LINKEDIN_ENABLED,
  CAREER_SITE_SUBMISSIONS_OWNER_EMAIL: process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL,
  CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID: process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID,
  CAREER_LINKEDIN_BROWSER_PUBLIC_URL: process.env.CAREER_LINKEDIN_BROWSER_PUBLIC_URL,
  CAREER_LINKEDIN_BROWSER_WORKER_TOKEN: process.env.CAREER_LINKEDIN_BROWSER_WORKER_TOKEN,
  CAREER_LINKEDIN_BROWSER_WORKER_HMAC_SECRET: process.env.CAREER_LINKEDIN_BROWSER_WORKER_HMAC_SECRET,
  PIPELINE_OUTBOX_WORKER_SECRET: process.env.PIPELINE_OUTBOX_WORKER_SECRET,
  CAREER_SITE_AGENT_SERVICE_SECRET: process.env.CAREER_SITE_AGENT_SERVICE_SECRET,
  SHORTLINK_SERVICE_CLIENTS_JSON: process.env.SHORTLINK_SERVICE_CLIENTS_JSON,
}

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('connect accepts only an exact Career Desk return URL and never credential fields', () => {
  const request = {
    requestId: '0b43bb55-f85e-4492-ab4a-7f22582137e5',
    returnUrl: 'https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=0b43bb55-f85e-4492-ab4a-7f22582137e5&destination=settings',
  }
  assert.deepEqual(parseCareerSiteLinkedInConnectRequest(request), request)
  for (const returnUrl of [
    'https://attacker.example/career/linkedin/return?attemptId=0b43bb55-f85e-4492-ab4a-7f22582137e5&destination=settings',
    'https://jarrett.suburbiasandwichco.com/contact',
    'https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=0b43bb55-f85e-4492-ab4a-7f22582137e6&destination=settings',
    'https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=0B43BB55-F85E-4492-AB4A-7F22582137E5&destination=settings',
    'https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=0b43bb55-f85e-4492-ab4a-7f22582137e5&destination=jobs',
    'https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=0b43bb55-f85e-4492-ab4a-7f22582137e5&destination=settings&next=https://attacker.example',
    'https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=0b43bb55-f85e-4492-ab4a-7f22582137e5&attemptId=0b43bb55-f85e-4492-ab4a-7f22582137e5&destination=settings',
  ]) {
    assert.throws(
      () => parseCareerSiteLinkedInConnectRequest({ ...request, returnUrl }),
      CareerSiteLinkedInRequestError,
    )
  }
  assert.throws(
    () => parseCareerSiteLinkedInConnectRequest({ ...request, password: 'never' }),
    /Unsupported LinkedIn connect request field: password/,
  )
  assert.throws(
    () => parseCareerSiteLinkedInConnectRequest({ ...request, mfaCode: '123456' }),
    /Unsupported LinkedIn connect request field: mfaCode/,
  )
})

test('scan contract is bounded to job reads and fifty results', () => {
  const request = parseCareerSiteLinkedInScanRequest({
    requestId: 'fc064a86-4ac2-44ff-871d-4d56d724b2cb',
    scope: 'jobs',
    maximum: 50,
    filters: {
      keywords: ['operations', 'transformation'],
      locations: ['Tri-state'],
      minimumSalary: 180000,
    },
  })
  assert.equal(request.maximum, 50)
  assert.equal(request.filters.minimumSalary, 180000)
  assert.throws(
    () => parseCareerSiteLinkedInScanRequest({ ...request, maximum: 51 }),
    /maximum/,
  )
  assert.throws(
    () => parseCareerSiteLinkedInScanRequest({ ...request, scope: 'messages' }),
    /scope must be jobs/,
  )
  assert.throws(
    () => parseCareerSiteLinkedInScanRequest({
      ...request,
      filters: { ...request.filters, minimumSalary: 2_000_001 },
    }),
    /minimumSalary/,
  )
})

test('worker claim capabilities are exact and worker reports drop invalid candidates deterministically', () => {
  assert.deepEqual(parseCareerSiteLinkedInWorkerClaimRequest({
    workerId: 'linkedin-browser-1',
    capabilities: ['interactive_auth', 'jobs_read'],
  }), {
    workerId: 'linkedin-browser-1',
    capabilities: ['interactive_auth', 'jobs_read'],
  })
  const valid = {
    externalId: '1234567890',
    url: 'https://www.linkedin.com/jobs/view/1234567890',
    title: 'Vice President of Operations',
    company: 'Example Company',
    location: 'New York, NY',
    description: 'Lead a distributed operations organization through durable transformation.',
    salaryText: '$200,000-$240,000',
    postedAt: '2026-08-29T12:00:00Z',
  }
  const report = parseCareerSiteLinkedInWorkerReportRequest({
    leaseId: '5393ac34-ab46-49fc-96b5-1f7603f77ff1',
    leaseToken: '16ec95e8-3e32-4e7e-b019-84e9794797c9',
    status: 'succeeded',
    authState: null,
    encryptedSessionEnvelope: null,
    jobs: [
      valid,
      { ...valid, externalId: 'not-numeric' },
      { ...valid, externalId: '1234567890', title: 'Duplicate' },
      { ...valid, externalId: '9876543210', description: 'too short' },
    ],
    evidence: {
      event: 'page_state',
      capturedAt: '2026-08-29T12:01:00Z',
      memberName: 'Jarrett Crosby',
      profileUrl: 'https://www.linkedin.com/in/jarrettcrosby',
      sessionExpiresAt: null,
    },
    errorCode: null,
    errorMessage: null,
  })
  assert.deepEqual(report.jobs, [{
    ...valid,
    url: 'https://www.linkedin.com/jobs/view/1234567890/',
    postedAt: '2026-08-29T12:00:00.000Z',
  }])
  const mismatched = parseCareerSiteLinkedInWorkerReportRequest({
    ...report,
    jobs: [{ ...valid, url: 'https://www.linkedin.com/jobs/view/9999999999/' }],
  })
  assert.deepEqual(mismatched.jobs, [])
  const conflicting = parseCareerSiteLinkedInWorkerReportRequest({
    ...report,
    jobs: [{
      ...valid,
      url: 'https://www.linkedin.com/jobs/view/9999999999/?currentJobId=1234567890',
    }],
  })
  assert.deepEqual(conflicting.jobs, [])
  const nonJobPath = parseCareerSiteLinkedInWorkerReportRequest({
    ...report,
    jobs: [{ ...valid, url: 'https://www.linkedin.com/feed/?currentJobId=1234567890' }],
  })
  assert.deepEqual(nonJobPath.jobs, [])
  assert.throws(
    () => parseCareerSiteLinkedInWorkerReportRequest({ ...report, password: 'never' }),
    /Unsupported LinkedIn worker report field: password/,
  )
})

test('configuration requires isolated worker token, HMAC secret, and session service identity', () => {
  process.env.CAREER_SITE_LINKEDIN_ENABLED = '1'
  process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL = 'jarrett@suburbiasandwichco.com'
  process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID = '405bb919-0364-4a88-8a62-b4c9da42cd8f'
  process.env.CAREER_LINKEDIN_BROWSER_PUBLIC_URL = 'https://linkedin-browser.example.net'
  process.env.CAREER_LINKEDIN_BROWSER_WORKER_TOKEN = 'worker-bearer-token-0123456789abcdef'
  process.env.CAREER_LINKEDIN_BROWSER_WORKER_HMAC_SECRET = 'worker-hmac-secret-0123456789abcdef'
  process.env.SHORTLINK_SERVICE_CLIENTS_JSON = '[]'

  assert.deepEqual(resolveCareerSiteLinkedInConfiguration(), {
    enabled: true,
    sourceApp: 'jarrett-career-agents',
    ownerEmail: 'jarrett@suburbiasandwichco.com',
    organizationId: '405bb919-0364-4a88-8a62-b4c9da42cd8f',
    workerPublicUrl: 'https://linkedin-browser.example.net/',
    workerToken: 'worker-bearer-token-0123456789abcdef',
    workerHmacSecret: 'worker-hmac-secret-0123456789abcdef',
  })

  process.env.CAREER_LINKEDIN_BROWSER_WORKER_HMAC_SECRET = process.env.CAREER_LINKEDIN_BROWSER_WORKER_TOKEN
  assert.throws(() => resolveCareerSiteLinkedInConfiguration(), /not isolated/)
})

test('live-token redemption retries require the original fence or explicit recovery adoption', () => {
  const currentLeaseToken = '16ec95e8-3e32-4e7e-b019-84e9794797c9'
  const currentWorkerId = 'linkedin-browser-1'
  assert.equal(classifyCareerSiteLinkedInRedemption({
    redeemedAt: null,
    redeemedLeaseDigest: null,
    redeemedWorkerId: null,
    currentLeaseToken,
    currentWorkerId,
    attempts: 1,
  }), 'first')

  const redeemed = {
    redeemedAt: '2026-08-29T12:00:00.000Z',
    redeemedLeaseDigest: careerSiteLinkedInRedemptionLeaseDigest(currentLeaseToken),
    redeemedWorkerId: currentWorkerId,
  }
  assert.equal(classifyCareerSiteLinkedInRedemption({
    ...redeemed,
    currentLeaseToken,
    currentWorkerId,
    attempts: 1,
  }), 'idempotent')
  assert.equal(classifyCareerSiteLinkedInRedemption({
    ...redeemed,
    currentLeaseToken: '768e5fb2-8e87-4516-9a14-044fca59e3f2',
    currentWorkerId,
    attempts: 1,
  }), 'replay')
  assert.equal(classifyCareerSiteLinkedInRedemption({
    ...redeemed,
    currentLeaseToken,
    currentWorkerId: 'linkedin-browser-2',
    attempts: 1,
  }), 'replay')
  assert.equal(classifyCareerSiteLinkedInRedemption({
    ...redeemed,
    currentLeaseToken: '768e5fb2-8e87-4516-9a14-044fca59e3f2',
    currentWorkerId: 'linkedin-browser-2',
    attempts: 2,
  }), 'adopt')
})

test('committed awaiting-auth response loss accepts only the exact report receipt', () => {
  const rawBody = JSON.stringify({
    leaseId: '5393ac34-ab46-49fc-96b5-1f7603f77ff1',
    leaseToken: '16ec95e8-3e32-4e7e-b019-84e9794797c9',
    status: 'awaiting_auth',
    authState: { kind: 'login', message: null },
    encryptedSessionEnvelope: null,
    jobs: [],
    evidence: null,
    errorCode: 'LOGIN_REQUIRED',
    errorMessage: null,
  })
  const receipt = {
    bodyDigest: careerSiteLinkedInReportBodyDigest(rawBody),
    leaseDigest: careerSiteLinkedInReportLeaseDigest('16ec95e8-3e32-4e7e-b019-84e9794797c9'),
    workerId: 'linkedin-browser-1',
    status: 'awaiting_auth' as const,
  }
  const stored = {
    last_report_body_digest: receipt.bodyDigest,
    last_report_lease_digest: receipt.leaseDigest,
    last_report_worker_id: receipt.workerId,
    last_report_status: receipt.status,
  }
  assert.equal(exactCareerSiteLinkedInReportReceipt(stored, receipt), true)
  assert.equal(exactCareerSiteLinkedInReportReceipt(stored, {
    ...receipt,
    bodyDigest: careerSiteLinkedInReportBodyDigest(`${rawBody}\n`),
  }), false)
  assert.equal(exactCareerSiteLinkedInReportReceipt(stored, {
    ...receipt,
    leaseDigest: careerSiteLinkedInReportLeaseDigest('768e5fb2-8e87-4516-9a14-044fca59e3f2'),
  }), false)
  assert.equal(exactCareerSiteLinkedInReportReceipt(stored, {
    ...receipt,
    workerId: 'linkedin-browser-2',
  }), false)
})

test('committed terminal success response loss replays only the completing payload', () => {
  const succeededBody = JSON.stringify({
    leaseId: '5393ac34-ab46-49fc-96b5-1f7603f77ff1',
    leaseToken: '16ec95e8-3e32-4e7e-b019-84e9794797c9',
    status: 'succeeded',
    authState: { kind: 'none', message: null },
    encryptedSessionEnvelope: null,
    jobs: [],
    evidence: null,
    errorCode: null,
    errorMessage: null,
  })
  const receipt = {
    bodyDigest: careerSiteLinkedInReportBodyDigest(succeededBody),
    leaseDigest: careerSiteLinkedInReportLeaseDigest('16ec95e8-3e32-4e7e-b019-84e9794797c9'),
    workerId: 'linkedin-browser-1',
    status: 'succeeded' as const,
  }
  const stored = {
    last_report_body_digest: receipt.bodyDigest,
    last_report_lease_digest: receipt.leaseDigest,
    last_report_worker_id: receipt.workerId,
    last_report_status: receipt.status,
  }
  assert.equal(exactCareerSiteLinkedInReportReceipt(stored, receipt), true)
  assert.equal(exactCareerSiteLinkedInReportReceipt(stored, {
    ...receipt,
    bodyDigest: careerSiteLinkedInReportBodyDigest(succeededBody.replace('succeeded', 'failed')),
    status: 'failed',
  }), false)
})
