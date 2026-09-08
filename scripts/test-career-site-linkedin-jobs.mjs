#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const identity = {
  CAREER_SITE_SOURCE_APP: 'jarrett-career-agents',
  CAREER_SITE_OWNER_EMAIL: 'jarrett@suburbiasandwichco.com',
  CAREER_SITE_ORGANIZATION_ID: '405bb919-0364-4a88-8a62-b4c9da42cd8f',
}
function load(path, dependencies) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, AbortController, Buffer, URL, Response, Headers, clearTimeout, setTimeout,
    process: { env: { CAREER_SITE_AGENTS_ENABLED: '1', CAREER_SITE_SUBMISSIONS_OWNER_EMAIL: identity.CAREER_SITE_OWNER_EMAIL, CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID: identity.CAREER_SITE_ORGANIZATION_ID } },
    require(specifier) { if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]; throw new Error(`Unexpected import ${specifier}`) },
  }, { filename: path })
  return module.exports
}
const contract = load('app_src/lib/careerSiteLinkedInJobsContract.ts', { '@/lib/careerSiteAgentContract': identity })
assert.equal(contract.parseCareerSiteLinkedInJobsRequest({}).query, 'supply chain')
assert.equal(contract.parseCareerSiteLinkedInJobsRequest({}).maxJobs, 10)
for (const invalid of [null, [], { url: 'https://evil.test' }, { maxJobs: 11 }, { maxJobs: 0 }, { query: '\n' }, { query: 'a\nb' }, { query: 'x?count=1000' }, { query: 'x'.repeat(181) }]) {
  assert.throws(() => contract.parseCareerSiteLinkedInJobsRequest(invalid))
}
assert.equal(contract.resolveCareerSiteLinkedInJobsConfiguration().sourceApp, identity.CAREER_SITE_SOURCE_APP)
const now = new Date('2026-09-04T12:00:00Z')
function candidate(id = '12345678') {
  return { isRestricted: false, jobPostingUrl: `https://www.linkedin.com/ad-library/job/detail/${id}`, jobDetails: {
    jobTitle: 'Vice President, Supply Chain Operations', organizationName: 'Acme', jobLocation: 'New York, New York, United States',
    jobDescription: 'Lead distribution and fulfillment operations, inventory control, and a multi-site supply chain organization. Build a strong team.',
    jobListTimeInMilliseconds: now.getTime() - 86_400_000,
  } }
}
const normalized = contract.normalizeCareerSiteLinkedInJob(candidate(), now)
assert.equal(normalized.sourceUrl, 'https://www.linkedin.com/jobs/view/12345678')
assert.equal(normalized.availability, 'unverified')
for (const title of ['Senior Solution Sales Executive', 'Advisory Solution Consultant', 'Director of Procurement', 'Head of Value Engineering', 'Senior AI Transformation Director']) {
  assert.ok(contract.normalizeCareerSiteLinkedInJob({ ...candidate(), jobDetails: { ...candidate().jobDetails, jobTitle: title } }, now), title)
}
for (const change of [
  { isRestricted: true }, { isRestricted: undefined },
  { jobPostingUrl: 'https://www.linkedin.com.evil.test/ad-library/job/detail/12345678' },
  { jobPostingUrl: 'http://www.linkedin.com/ad-library/job/detail/12345678' },
  { jobPostingUrl: 'https://a:b@www.linkedin.com/ad-library/job/detail/12345678' },
  { jobPostingUrl: 'https://www.linkedin.com/ad-library/job/detail/12345678?x=1' },
]) assert.equal(contract.normalizeCareerSiteLinkedInJob({ ...candidate(), ...change }, now), null)
for (const change of [
  { jobTitle: 'Medical Staff Coordinator I' }, { jobTitle: 'Director, Clinical Nursing' },
  { jobTitle: 'Principal Application & AI Security Engineer' }, { jobTitle: 'Senior Financial Analyst, Operations & Supply Chain' },
  { jobLocation: 'London, England, United Kingdom' }, { jobLocation: 'Tbilisi, Georgia' },
  { jobDescription: 'Short' }, { jobListTimeInMilliseconds: now.getTime() - 46 * 86_400_000 },
  { jobListTimeInMilliseconds: '1788393585000' }, { jobListTimeInMilliseconds: now.getTime() + 2 * 86_400_000 },
  { jobCloseTimeInMilliseconds: now.getTime() - 10 }, { jobStatus: 'CLOSED' },
]) assert.equal(contract.normalizeCareerSiteLinkedInJob({ ...candidate(), jobDetails: { ...candidate().jobDetails, ...change } }, now), null)

let replies = []
let calls = []
let credentialError = false
const runtime = load('app_src/lib/careerSiteLinkedInJobs.ts', {
  '@/lib/careerSiteLinkedInJobsContract': contract,
  '@/lib/integrations/matonGatewayCredentials': { async resolveUserMatonGatewayCredential(input) {
    assert.equal(input.ownerEmail, identity.CAREER_SITE_OWNER_EMAIL); assert.equal(input.app, 'linkedin')
    if (credentialError) throw Object.assign(new Error('secret upstream diagnostic'), { code: credentialError === 'registry' ? 'unavailable' : 'missing-connection' })
    return { apiKey: 'not-for-output', connectionId: 'bound-connection' }
  } },
  '@/lib/maton': { async matonFetch(path, init, context) {
    assert.equal(init.method, 'GET'); assert.equal(init.headers['LinkedIn-Version'], '202605')
    assert.equal(context.app, 'linkedin'); assert.equal(context.boundConnectionId, 'bound-connection')
    calls.push(path)
    const next = replies.shift()
    assert.ok(next, 'no unbounded extra requests')
    return next
  } },
})
function response(value, status = 200) { return new Response(JSON.stringify(value), { status }) }
const ownerEmail = identity.CAREER_SITE_OWNER_EMAIL
replies = [response({ id: 'owner-profile' })]
const status = await runtime.getCareerSiteLinkedInJobsStatus(ownerEmail)
assert.equal(status.connected, true); assert.equal(status.jobsSupported, true); assert.equal(status.inboxSupported, false)
const liveCandidate = candidate()
liveCandidate.jobDetails.jobListTimeInMilliseconds = Date.now() - 86_400_000
replies = [response({ elements: [liveCandidate, liveCandidate], paging: { links: [{ href: 'https://evil.test' }] } })]
calls = []
const result = await runtime.searchCareerSiteLinkedInJobs({ ownerEmail, request: { query: 'supply chain', maxJobs: 10 } })
assert.equal(result.jobs.length, 1); assert.equal(result.scannedCount, 2); assert.equal(result.filteredCount, 1)
assert.equal(result.availability, 'unverified'); assert.equal(result.coverage, 'paid-job-posts')
assert.ok(calls[0].includes('keyword=supply%20chain')); assert.equal(calls.length, 1)
assert.ok(!JSON.stringify(result).includes('not-for-output'))
replies = [response({}, 500), response({ elements: [] })]
calls = []
await runtime.searchCareerSiteLinkedInJobs({ ownerEmail, request: { query: 'supply chain', maxJobs: 1 } })
assert.equal(calls.length, 2, 'retry transient GET once')
for (const [http, code] of [[403, 'CAREER_SITE_LINKEDIN_MATON_PERMISSION_REQUIRED'], [426, 'CAREER_SITE_LINKEDIN_MATON_VERSION_EXPIRED']]) {
  replies = [response({ error: 'secret upstream diagnostic' }, http)]
  await assert.rejects(runtime.getCareerSiteLinkedInJobsStatus(ownerEmail), (error) => error.code === code && !error.message.includes('secret'))
}
replies = [response({ elements: [liveCandidate, ...Array(3).fill(liveCandidate)] })]
await assert.rejects(runtime.searchCareerSiteLinkedInJobs({ ownerEmail, request: { query: 'supply chain', maxJobs: 10 } }))
const rejectedCandidate = { ...liveCandidate, isRestricted: true }
replies = Array.from({ length: 8 }, () => response({ elements: Array(3).fill(rejectedCandidate) }))
calls = []
const bounded = await runtime.searchCareerSiteLinkedInJobs({ ownerEmail, request: { query: 'supply chain', maxJobs: 10 } })
assert.equal(bounded.scannedCount, 24); assert.equal(bounded.jobs.length, 0); assert.equal(calls.length, 8)
replies = [response({}, 500), ...Array.from({ length: 7 }, () => response({ elements: Array(3).fill(rejectedCandidate) }))]
calls = []
const retryBounded = await runtime.searchCareerSiteLinkedInJobs({ ownerEmail, request: { query: 'supply chain', maxJobs: 10 } })
assert.equal(calls.length, 8, 'retry attempts share the total request budget')
assert.equal(retryBounded.scannedCount, 21)
credentialError = true
await assert.rejects(runtime.getCareerSiteLinkedInJobsStatus(ownerEmail), (error) => error.code === 'CAREER_SITE_LINKEDIN_MATON_NOT_CONNECTED')
credentialError = 'registry'
await assert.rejects(runtime.getCareerSiteLinkedInJobsStatus(ownerEmail), (error) => error.code === 'CAREER_SITE_LINKEDIN_MATON_REGISTRY_UNAVAILABLE')

let actor = { service: true, sourceApp: identity.CAREER_SITE_SOURCE_APP, ownerEmail, organizationId: identity.CAREER_SITE_ORGANIZATION_ID }
let serviceCalls = 0
class ShortLinkRequestError extends Error {}
const route = load('app_src/app/api/career-site/sources/linkedin/jobs/route.ts', {
  'next/server': { NextResponse: { json(value, options) { return new Response(JSON.stringify(value), { ...options, headers: { ...options.headers, 'content-type': 'application/json' } }) } } },
  '@/lib/careerSiteLinkedInJobsContract': contract,
  '@/lib/careerSiteLinkedInJobs': {
    async getCareerSiteLinkedInJobsStatus() { serviceCalls += 1; return status },
    async searchCareerSiteLinkedInJobs() { serviceCalls += 1; return result },
  },
  '@/lib/shortlinks': { ShortLinkRequestError, async resolveShortLinkActor() { return actor }, validateShortLinkConfiguration(input) { assert.equal(input.requireServiceClient, true) } },
})
function request(body = '{}', headers = {}) { return new Request('https://app.test/api/career-site/sources/linkedin/jobs', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }) }
assert.equal((await route.POST(request())).status, 200)
assert.match((await route.GET(request())).headers.get('cache-control'), /no-store/)
assert.equal((await route.POST(request('{'))).status, 400)
assert.equal((await route.POST(request('{}', { 'content-type': 'text/plain' }))).status, 415)
assert.equal((await route.POST(request(' '.repeat(4097)))).status, 413)
for (const wrong of [{ service: false }, { ownerEmail: 'other@acme.com' }, { organizationId: 'other-org' }, { sourceApp: 'other-app' }]) {
  const original = actor
  actor = { ...original, ...wrong }
  const before = serviceCalls
  assert.equal((await route.POST(request())).status, 403)
  assert.equal(serviceCalls, before, 'unauthorized request never calls provider')
  actor = original
}
console.log('Career Site Maton LinkedIn jobs: request, candidate, bounded runtime, retry, capability, and isolated route tests passed')
