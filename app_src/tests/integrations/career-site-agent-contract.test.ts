import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  CareerSiteAgentRequestError,
  parseCareerSiteAgentRequest,
  resolveCareerSiteAgentConfiguration,
} from '../../lib/careerSiteAgentContract.ts'

const baseline = {
  requestId: 'e2f7c6dd-18cb-4fb1-a747-42f7f829b20d',
  agentType: 'tailor',
  schemaName: 'career_application_packet',
  instructions: 'Draft only from supplied evidence.',
  prompt: '{"job":"example"}',
  outputSchema: {
    type: 'object',
    properties: { result: { type: 'string' } },
    required: ['result'],
    additionalProperties: false,
  },
  webSearch: false,
}

const originalEnvironment = {
  CAREER_SITE_AGENTS_ENABLED: process.env.CAREER_SITE_AGENTS_ENABLED,
  CAREER_SITE_SUBMISSIONS_OWNER_EMAIL: process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL,
  CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID: process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID,
  CLAWPILOT_PUBLIC_URL: process.env.CLAWPILOT_PUBLIC_URL,
  NODE_ENV: process.env.NODE_ENV,
}

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('accepts the exact bounded contract for each Career Desk agent', () => {
  assert.deepEqual(parseCareerSiteAgentRequest(baseline), baseline)
  assert.equal(parseCareerSiteAgentRequest({
    ...baseline,
    agentType: 'scout',
    schemaName: 'career_job_scout',
    webSearch: true,
  }).webSearch, true)
})

test('rejects mismatched capabilities and unexpected request fields', () => {
  assert.throws(
    () => parseCareerSiteAgentRequest({ ...baseline, webSearch: true }),
    CareerSiteAgentRequestError,
  )
  assert.throws(
    () => parseCareerSiteAgentRequest({ ...baseline, extra: 'nope' }),
    CareerSiteAgentRequestError,
  )
  assert.throws(
    () => parseCareerSiteAgentRequest({
      ...baseline,
      agentType: 'inbox',
      schemaName: 'career_job_scout',
    }),
    CareerSiteAgentRequestError,
  )
})

test('requires the exact Career Desk service identity and exposes the Agents login surface', () => {
  process.env.CAREER_SITE_AGENTS_ENABLED = '1'
  process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL = 'jarrett@suburbiasandwichco.com'
  process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID = '405bb919-0364-4a88-8a62-b4c9da42cd8f'
  process.env.CLAWPILOT_PUBLIC_URL = 'https://aiapp.eigenracing.com'

  assert.deepEqual(resolveCareerSiteAgentConfiguration(), {
    enabled: true,
    sourceApp: 'jarrett-career-agents',
    ownerEmail: 'jarrett@suburbiasandwichco.com',
    organizationId: '405bb919-0364-4a88-8a62-b4c9da42cd8f',
    connectUrl: 'https://aiapp.eigenracing.com/#agents',
  })

  delete process.env.CLAWPILOT_PUBLIC_URL
  process.env.NODE_ENV = 'development'
  assert.equal(
    resolveCareerSiteAgentConfiguration().connectUrl,
    'http://localhost:4002/#agents',
  )

  process.env.NODE_ENV = 'production'
  assert.throws(() => resolveCareerSiteAgentConfiguration())
  process.env.CLAWPILOT_PUBLIC_URL = 'https://aiapp.eigenracing.com'

  process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL = 'other@example.com'
  assert.throws(() => resolveCareerSiteAgentConfiguration())
})
