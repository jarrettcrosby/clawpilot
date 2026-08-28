#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function transpile(path) {
  return ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
}

function runModule(path, dependencies, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(path), {
    AbortController,
    Buffer,
    Headers,
    Response,
    TextDecoder,
    URL,
    URLSearchParams,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
      throw new Error(`Unexpected ${path} test import: ${specifier}`)
    },
    ...globals,
  }, { filename: path })
  return module.exports
}

const identity = {
  CAREER_SITE_SOURCE_APP: 'jarrett-career-agents',
  CAREER_SITE_OWNER_EMAIL: 'jarrett@suburbiasandwichco.com',
  CAREER_SITE_ORGANIZATION_ID: '405bb919-0364-4a88-8a62-b4c9da42cd8f',
}
const contract = runModule(
  'app_src/lib/careerSiteGmailSourceContract.ts',
  {
    '@/lib/careerSiteAgentContract': identity,
    'node:net': requireFromApp('node:net'),
  },
)

assert.equal(JSON.stringify(contract.parseCareerSiteGmailSourceRequest({})), JSON.stringify({
  maxMessagesPerAccount: 10,
}))
assert.equal(JSON.stringify(contract.parseCareerSiteGmailSourceRequest({
  query: ' from:recruiter@acme.com ',
  after: '2026-08-28T12:34:56-04:00',
  maxMessagesPerAccount: 25,
})), JSON.stringify({
  query: 'from:recruiter@acme.com',
  after: '2026-08-28T16:34:56.000Z',
  maxMessagesPerAccount: 25,
}))
for (const invalid of [
  null,
  [],
  { unknown: true },
  { query: '' },
  { query: 'line\nbreak' },
  { after: '2026-08-28' },
  { after: '2026-02-30T12:00:00Z' },
  { after: 'not-a-date' },
  { maxMessagesPerAccount: 0 },
  { maxMessagesPerAccount: 26 },
  { maxMessagesPerAccount: 1.5 },
  { maxMessagesPerAccount: '10' },
]) {
  assert.throws(
    () => contract.parseCareerSiteGmailSourceRequest(invalid),
    (error) => error?.name === 'CareerSiteGmailSourceRequestError',
  )
}

const originalEnvironment = {
  enabled: process.env.CAREER_SITE_AGENTS_ENABLED,
  owner: process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL,
  organization: process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID,
}
try {
  process.env.CAREER_SITE_AGENTS_ENABLED = '1'
  process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL = identity.CAREER_SITE_OWNER_EMAIL
  process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID = identity.CAREER_SITE_ORGANIZATION_ID
  assert.equal(
    JSON.stringify(contract.resolveCareerSiteGmailSourceConfiguration()),
    JSON.stringify({ enabled: true, sourceApp: identity.CAREER_SITE_SOURCE_APP, ownerEmail: identity.CAREER_SITE_OWNER_EMAIL, organizationId: identity.CAREER_SITE_ORGANIZATION_ID }),
  )
  process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL = 'other@example.com'
  assert.throws(
    () => contract.resolveCareerSiteGmailSourceConfiguration(),
    (error) => error?.name === 'CareerSiteGmailSourceConfigurationError',
  )
} finally {
  for (const [name, value] of [
    ['CAREER_SITE_AGENTS_ENABLED', originalEnvironment.enabled],
    ['CAREER_SITE_SUBMISSIONS_OWNER_EMAIL', originalEnvironment.owner],
    ['CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID', originalEnvironment.organization],
  ]) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

assert.equal(JSON.stringify(contract.extractPublicHttpsUrls([
  'See https://careers.acme.com/jobs/123?source=email and https://careers.acme.com/jobs/123?source=email.',
  'Reject http://careers.acme.com, https://user:pass@careers.acme.com, https://127.0.0.1/private, and https://service.internal/private.',
])), JSON.stringify(['https://careers.acme.com/jobs/123?source=email']))

const connectionRows = [
  { connectionId: 'connection-a-1', accountEmail: 'alpha@gmail.com', status: 'ACTIVE' },
  { connectionId: 'connection-a-2', accountEmail: 'alpha@gmail.com', status: 'ACTIVE' },
  { connectionId: 'connection-b', accountEmail: 'beta@gmail.com', status: 'ACTIVE' },
]
const providerCalls = []
let parseCalls = 0
const gmailSources = runModule(
  'app_src/lib/careerSiteGmailSources.ts',
  {
    '@/lib/careerSiteGmailSourceContract': contract,
    '@/lib/crm/emailIngestion': {
      decodeGmailBodyData(value) {
        return Buffer.from(String(value), 'base64url').toString('utf8')
      },
      parseGmailMessage(message) {
        parseCalls += 1
        return {
          externalMessageId: message.id,
          externalThreadId: message.threadId || null,
          senderEmail: message.sender,
          recipientEmails: [],
          subject: message.subject,
          receivedAt: message.receivedAt,
          snippet: message.snippet,
          bodyText: message.bodyText,
          markerReferences: [],
          historyId: null,
          labelIds: [],
          sizeEstimate: null,
        }
      },
    },
    '@/lib/maton': {
      async matonFetch(path, init, context) {
        providerCalls.push({ path, init, context })
        assert.equal(init.method, 'GET')
        assert.equal(context.ownerEmail, identity.CAREER_SITE_OWNER_EMAIL)
        assert.equal(context.app, 'google-mail')
        const connectionId = context.boundConnectionId
        if (path.includes('?maxResults=')) {
          return Response.json({ messages: [{ id: 'message-shared' }, { id: 'message-shared' }] })
        }
        const id = decodeURIComponent(path.match(/\/messages\/([^?]+)/)?.[1] || '')
        assert.equal(id, 'message-shared')
        const bodyText = `Body for ${connectionId} https://jobs.acme.com/${connectionId}${
          connectionId === 'connection-b' ? ` ${'x'.repeat(21_000)}` : ''
        }`
        const html = `<a href="https://apply.acme.com/${connectionId}">Apply</a>`
        return Response.json({
          id,
          threadId: `thread-${connectionId}`,
          sender: `recruiter@${connectionId}.com`,
          subject: `Role from ${connectionId}`,
          receivedAt: connectionId === 'connection-b'
            ? '2026-08-28T15:00:00.000Z'
            : '2026-08-28T14:00:00.000Z',
          snippet: bodyText,
          bodyText,
          payload: {
            mimeType: 'text/html',
            headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            body: { data: Buffer.from(html).toString('base64url') },
          },
        })
      },
    },
    '@/lib/persistence/matonCredentials': {
      async readActiveMatonConnectionsFromPostgres(input) {
        assert.equal(input.ownerEmail, identity.CAREER_SITE_OWNER_EMAIL)
        assert.equal(input.app, 'google-mail')
        return connectionRows
      },
    },
  },
)

const accounts = await gmailSources.getCareerSiteGmailAccounts(identity.CAREER_SITE_OWNER_EMAIL)
assert.equal(JSON.stringify(accounts), JSON.stringify([
  { accountEmail: 'alpha@gmail.com', status: 'ACTIVE' },
  { accountEmail: 'beta@gmail.com', status: 'ACTIVE' },
]))

const messages = await gmailSources.searchCareerSiteGmailMessages({
  ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
  request: {
    query: 'newer_than:7d',
    after: '2026-08-27T12:00:00.000Z',
    maxMessagesPerAccount: 2,
  },
})
assert.equal(messages.length, 2, 'same account/message must be deduplicated across bound connections')
assert.equal(
  JSON.stringify(messages.map((message) => message.accountEmail)),
  JSON.stringify(['beta@gmail.com', 'alpha@gmail.com']),
)
assert.ok(messages.every((message) => Object.keys(message).sort().join(',') === [
  'accountEmail',
  'bodyText',
  'externalMessageId',
  'externalThreadId',
  'from',
  'receivedAt',
  'snippet',
  'subject',
  'urls',
].sort().join(',')))
assert.ok(messages.every((message) => message.urls.some((url) => url.startsWith('https://apply.acme.com/'))))
assert.ok(messages.every((message) => message.snippet.length <= contract.MAX_GMAIL_SNIPPET_CHARS))
assert.ok(messages.every((message) => message.bodyText.length <= contract.MAX_GMAIL_BODY_TEXT_CHARS))
assert.equal(parseCalls, 3, 'every independently fetched full message must use parseGmailMessage')
assert.equal(providerCalls.filter((call) => call.path.includes('?maxResults=')).length, 3)
assert.deepEqual(
  new Set(providerCalls.map((call) => call.context.boundConnectionId)),
  new Set(['connection-a-1', 'connection-a-2', 'connection-b']),
)
assert.ok(providerCalls.every((call) => !Object.hasOwn(call.context, 'is_selected')))
assert.ok(providerCalls.filter((call) => call.path.includes('?maxResults=')).every((call) => {
  const parsed = new URL(call.path, 'https://gateway.maton.ai')
  return parsed.searchParams.get('maxResults') === '2'
    && parsed.searchParams.get('q') === 'after:1787832000 (newer_than:7d)'
}))

class NextResponse {
  static json(body, init = {}) {
    return { body, status: init.status || 200, headers: init.headers || {} }
  }
}
class ShortLinkRequestError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}
const routeCalls = []
const actor = {
  service: true,
  sourceApp: identity.CAREER_SITE_SOURCE_APP,
  ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
  organizationId: identity.CAREER_SITE_ORGANIZATION_ID,
}
const route = runModule(
  'app_src/app/api/career-site/sources/gmail/route.ts',
  {
    'next/server': { NextResponse },
    '@/lib/careerSiteGmailSourceContract': {
      ...contract,
      resolveCareerSiteGmailSourceConfiguration: () => ({
        enabled: true,
        sourceApp: identity.CAREER_SITE_SOURCE_APP,
        ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
        organizationId: identity.CAREER_SITE_ORGANIZATION_ID,
      }),
    },
    '@/lib/careerSiteGmailSources': {
      CareerSiteGmailSourceError: gmailSources.CareerSiteGmailSourceError,
      async getCareerSiteGmailAccounts(ownerEmail) {
        routeCalls.push({ kind: 'get', ownerEmail })
        return accounts
      },
      async searchCareerSiteGmailMessages(input) {
        routeCalls.push({ kind: 'post', input })
        return messages
      },
    },
    '@/lib/shortlinks': {
      ShortLinkRequestError,
      validateShortLinkConfiguration: () => {},
      resolveShortLinkActor: async () => actor,
    },
  },
)
const request = (body = '') => ({
  headers: { get: () => null },
  text: async () => body,
})
const getResponse = await route.GET(request())
assert.equal(getResponse.status, 200)
assert.equal(JSON.stringify(getResponse.body), JSON.stringify({ ok: true, accounts }))
assert.equal(getResponse.headers['Cache-Control'], 'private, no-store, max-age=0')

const postBody = JSON.stringify({ query: 'in:inbox', maxMessagesPerAccount: 2 })
const postResponse = await route.POST(request(postBody))
assert.equal(postResponse.status, 200)
assert.equal(JSON.stringify(postResponse.body), JSON.stringify({ ok: true, messages }))
assert.equal(routeCalls[1].input.ownerEmail, identity.CAREER_SITE_OWNER_EMAIL)
assert.equal(routeCalls[1].input.request.query, 'in:inbox')

const forbiddenRoute = runModule(
  'app_src/app/api/career-site/sources/gmail/route.ts',
  {
    'next/server': { NextResponse },
    '@/lib/careerSiteGmailSourceContract': {
      ...contract,
      resolveCareerSiteGmailSourceConfiguration: () => ({
        enabled: true,
        sourceApp: identity.CAREER_SITE_SOURCE_APP,
        ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
        organizationId: identity.CAREER_SITE_ORGANIZATION_ID,
      }),
    },
    '@/lib/careerSiteGmailSources': {
      CareerSiteGmailSourceError: gmailSources.CareerSiteGmailSourceError,
      getCareerSiteGmailAccounts: async () => { throw new Error('auth bypassed') },
      searchCareerSiteGmailMessages: async () => { throw new Error('auth bypassed') },
    },
    '@/lib/shortlinks': {
      ShortLinkRequestError,
      validateShortLinkConfiguration: () => {},
      resolveShortLinkActor: async () => ({ ...actor, sourceApp: 'jarrett-career-site' }),
    },
  },
)
const forbidden = await forbiddenRoute.GET(request())
assert.equal(forbidden.status, 403)
assert.equal(forbidden.body.code, 'CAREER_SITE_GMAIL_SOURCE_FORBIDDEN')

const routeSource = read('app_src/app/api/career-site/sources/gmail/route.ts')
for (const fragment of [
  "normalizedPath === '/api/career-site/sources/gmail'",
  "boundConnectionId: input.connection.connectionId",
  "method: 'GET'",
  "'Cache-Control': 'private, no-store, max-age=0'",
]) {
  const source = fragment.startsWith('normalizedPath')
    ? read('app_src/proxy.ts')
    : fragment.includes('boundConnectionId') || fragment.includes("method: 'GET'")
      ? read('app_src/lib/careerSiteGmailSources.ts')
      : routeSource
  assert.ok(source.includes(fragment), `Career Desk Gmail source is missing ${fragment}`)
}
assert.ok(!read('app_src/lib/careerSiteGmailSources.ts').includes('is_selected'))

const persistence = read('app_src/lib/persistence/matonCredentials.ts')
for (const fragment of [
  "AND status = 'ACTIVE'",
  "AND source = 'maton'",
  'readActiveMatonConnectionsFromPostgres',
]) {
  assert.ok(persistence.includes(fragment), `Active Maton connection query is missing ${fragment}`)
}

console.log('Career Desk multi-account Gmail source contract, route, and gateway verified')
