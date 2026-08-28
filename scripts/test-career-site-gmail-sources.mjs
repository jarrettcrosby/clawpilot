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
    clearTimeout,
    console,
    exports: module.exports,
    module,
    process,
    setTimeout,
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
assert.equal(contract.MAX_GMAIL_ACTIVE_ACCOUNTS, 10)
assert.equal(contract.MAX_GMAIL_TOTAL_MESSAGES, 50)
assert.equal(contract.MAX_GMAIL_PUBLIC_URLS, 20)
assert.equal(contract.MAX_GMAIL_RESPONSE_BYTES, 4 * 1024 * 1024)
assert.equal(contract.GMAIL_SOURCE_DEADLINE_MS, 85_000)
assert.equal(JSON.stringify(contract.parseCareerSiteGmailSourceRequest({
  query: ' from:recruiter@acme.com ',
  after: '2026-08-28T12:34:56-04:00',
  maxMessagesPerAccount: 25,
})), JSON.stringify({
  query: 'from:recruiter@acme.com',
  after: '2026-08-28T16:34:56.000Z',
  maxMessagesPerAccount: 25,
}))
assert.equal(
  contract.parseCareerSiteGmailSourceRequest({
    query: 'from:recruiter@acme.com newer_than:7d -label:spam',
  }).query,
  'from:recruiter@acme.com newer_than:7d -label:spam',
)
assert.equal(
  contract.parseCareerSiteGmailSourceRequest({
    query: 'recruiter or hiring OR opportunity OR application',
  }).query,
  'recruiter OR hiring OR opportunity OR application',
  'the exact consumer default must remain a safely grouped compatible refinement',
)
for (const invalid of [
  null,
  [],
  { unknown: true },
  { query: '' },
  { query: 'line\nbreak' },
  { query: 'foo) OR (in:anywhere' },
  { query: '{from:anyone@example.com in:anywhere}' },
  { query: 'foo | in:anywhere' },
  { query: '"arbitrary personal mail"' },
  { query: 'OR recruiter' },
  { query: 'recruiter OR' },
  { query: 'recruiter OR OR hiring' },
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
  'Reject http://careers.acme.com, https://user:pass@careers.acme.com, https://127.0.0.1/private, https://[2001:db8::1]/private, and https://service.internal/private.',
])), JSON.stringify(['https://careers.acme.com/jobs/123?source=email']))
assert.equal(
  contract.extractPublicHttpsUrls(Array.from(
    { length: 25 },
    (_, index) => `https://jobs${index}.acme.com/role`,
  )).length,
  20,
)
assert.equal(
  contract.extractPublicHttpsUrls([
    `https://jobs.acme.com/${'é'.repeat(400)}`,
  ]).length,
  0,
  'URL normalization must not expand beyond the consumer 2,048-character bound',
)

const connectionRows = [
  { connectionId: 'connection-a', accountEmail: 'alpha@gmail.com', status: 'ACTIVE' },
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
        assert.ok(init.signal instanceof AbortSignal)
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
      async readMatonCredentialReadinessFromPostgres(ownerEmail) {
        assert.equal(ownerEmail, identity.CAREER_SITE_OWNER_EMAIL)
        return true
      },
    },
  },
)

const accounts = await gmailSources.getCareerSiteGmailAccounts(identity.CAREER_SITE_OWNER_EMAIL)
assert.equal(JSON.stringify(accounts), JSON.stringify([
  { accountEmail: 'alpha@gmail.com', status: 'ACTIVE' },
  { accountEmail: 'beta@gmail.com', status: 'ACTIVE' },
]))
assert.equal(JSON.stringify(
  await gmailSources.getCareerSiteGmailSourceReadiness(identity.CAREER_SITE_OWNER_EMAIL),
), JSON.stringify({ ready: true, activeAccountCount: 2 }))

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
assert.equal(parseCalls, 2, 'every independently fetched full message must use parseGmailMessage')
assert.equal(providerCalls.filter((call) => call.path.includes('?maxResults=')).length, 2)
assert.deepEqual(
  new Set(providerCalls.map((call) => call.context.boundConnectionId)),
  new Set(['connection-a', 'connection-b']),
)
assert.ok(providerCalls.every((call) => !Object.hasOwn(call.context, 'is_selected')))
assert.ok(providerCalls.filter((call) => call.path.includes('?maxResults=')).every((call) => {
  const parsed = new URL(call.path, 'https://gateway.maton.ai')
  return parsed.searchParams.get('maxResults') === '2'
    && parsed.searchParams.get('q') === `(${gmailSources.CAREER_GMAIL_IMMUTABLE_QUERY}) after:1787832000 (newer_than:7d)`
    && !call.path.includes('{"job alert"')
}))

providerCalls.length = 0
parseCalls = 0
await gmailSources.searchCareerSiteGmailMessages({
  ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
  request: { maxMessagesPerAccount: 1 },
})
const emptyRequestListCalls = providerCalls.filter((call) => call.path.includes('?maxResults='))
assert.equal(emptyRequestListCalls.length, 2)
assert.ok(emptyRequestListCalls.every((call) => {
  const parsed = new URL(call.path, 'https://gateway.maton.ai')
  return parsed.searchParams.get('q') === `(${gmailSources.CAREER_GMAIL_IMMUTABLE_QUERY})`
    && !call.path.includes('{"job alert"')
}))

providerCalls.length = 0
await gmailSources.searchCareerSiteGmailMessages({
  ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
  request: {
    query: 'recruiter OR hiring OR opportunity OR application',
    maxMessagesPerAccount: 1,
  },
})
assert.ok(providerCalls.filter((call) => call.path.includes('?maxResults=')).every((call) => {
  const parsed = new URL(call.path, 'https://gateway.maton.ai')
  return parsed.searchParams.get('q') === `(${gmailSources.CAREER_GMAIL_IMMUTABLE_QUERY}) (recruiter OR hiring OR opportunity OR application)`
}))

function loadGmailSources({
  rows,
  matonFetch,
  parseGmailMessage,
  credentialReady = true,
  globals = {},
}) {
  return runModule(
    'app_src/lib/careerSiteGmailSources.ts',
    {
      '@/lib/careerSiteGmailSourceContract': contract,
      '@/lib/crm/emailIngestion': {
        decodeGmailBodyData(value) {
          return Buffer.from(String(value), 'base64url').toString('utf8')
        },
        parseGmailMessage,
      },
      '@/lib/maton': { matonFetch },
      '@/lib/persistence/matonCredentials': {
        async readActiveMatonConnectionsFromPostgres() {
          return rows
        },
        async readMatonCredentialReadinessFromPostgres() {
          if (credentialReady instanceof Error) throw credentialReady
          return credentialReady
        },
      },
    },
    globals,
  )
}

const forbiddenProvider = async () => {
  throw new Error('provider must not be called for ambiguous account configuration')
}
const unusedParser = () => {
  throw new Error('parser must not be called for ambiguous account configuration')
}
for (const invalidRows of [
  [
    { connectionId: 'duplicate-a', accountEmail: 'same@gmail.com', status: 'ACTIVE' },
    { connectionId: 'duplicate-b', accountEmail: ' SAME@gmail.com ', status: 'ACTIVE' },
  ],
  Array.from({ length: 11 }, (_, index) => ({
    connectionId: `overflow-${index}`,
    accountEmail: `overflow-${index}@gmail.com`,
    status: 'ACTIVE',
  })),
]) {
  const invalidSources = loadGmailSources({
    rows: invalidRows,
    matonFetch: forbiddenProvider,
    parseGmailMessage: unusedParser,
  })
  await assert.rejects(
    invalidSources.getCareerSiteGmailSourceReadiness(identity.CAREER_SITE_OWNER_EMAIL),
    (error) => error?.code === 'CAREER_SITE_GMAIL_SOURCE_CONFIGURATION_INVALID',
  )
}

const missingCredentialSources = loadGmailSources({
  rows: [{ connectionId: 'missing-key', accountEmail: 'missing@gmail.com', status: 'ACTIVE' }],
  credentialReady: false,
  matonFetch: forbiddenProvider,
  parseGmailMessage: unusedParser,
})
assert.equal(JSON.stringify(
  await missingCredentialSources.getCareerSiteGmailSourceReadiness(
    identity.CAREER_SITE_OWNER_EMAIL,
  ),
), JSON.stringify({ ready: false, activeAccountCount: 1 }))

const unavailableCredentialSources = loadGmailSources({
  rows: [],
  credentialReady: new Error('registry unavailable'),
  matonFetch: forbiddenProvider,
  parseGmailMessage: unusedParser,
})
await assert.rejects(
  unavailableCredentialSources.getCareerSiteGmailSourceReadiness(
    identity.CAREER_SITE_OWNER_EMAIL,
  ),
  (error) => error?.code === 'CAREER_SITE_GMAIL_SOURCE_REGISTRY_UNAVAILABLE',
)

const bulkRows = Array.from({ length: 10 }, (_, index) => ({
  connectionId: `bulk-${index}`,
  accountEmail: `bulk-${index}@gmail.com`,
  status: 'ACTIVE',
}))
let bulkListCalls = 0
let bulkGetCalls = 0
let bulkInFlight = 0
let bulkMaxInFlight = 0
const bulkSources = loadGmailSources({
  rows: bulkRows,
  async matonFetch(path, init, context) {
    assert.ok(init.signal instanceof AbortSignal)
    if (path.includes('?maxResults=')) {
      bulkListCalls += 1
      const parsed = new URL(path, 'https://gateway.maton.ai')
      assert.equal(parsed.searchParams.get('maxResults'), '25')
      assert.equal(parsed.searchParams.get('q'), `(${gmailSources.CAREER_GMAIL_IMMUTABLE_QUERY})`)
      const ids = Array.from({ length: 7 }, (_, index) => ({
        id: `${context.boundConnectionId}-message-${index}`,
      }))
      return Response.json({ messages: [...ids, ids[0]] })
    }
    bulkGetCalls += 1
    bulkInFlight += 1
    bulkMaxInFlight = Math.max(bulkMaxInFlight, bulkInFlight)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2))
    bulkInFlight -= 1
    const id = decodeURIComponent(path.match(/\/messages\/([^?]+)/)?.[1] || '')
    const publicUrls = Array.from(
      { length: 25 },
      (_, index) => `https://role-${index}.jobs.acme.com/${id}`,
    ).join(' ')
    return Response.json({
      id,
      threadId: `thread-${id}`,
      sender: `recruiter@${context.boundConnectionId}.com`,
      subject: `Role ${id}`,
      receivedAt: '2026-08-28T16:00:00.000Z',
      snippet: publicUrls,
      bodyText: publicUrls,
    })
  },
  parseGmailMessage(message) {
    return {
      externalMessageId: message.id,
      externalThreadId: message.threadId,
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
})
const bulkMessages = await bulkSources.searchCareerSiteGmailMessages({
  ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
  request: { maxMessagesPerAccount: 25 },
})
assert.equal(bulkMessages.length, 50, 'the response envelope must cap all accounts at 50 messages')
assert.equal(bulkListCalls, 10)
assert.equal(bulkGetCalls, 50)
assert.ok(bulkMaxInFlight > 1 && bulkMaxInFlight <= 5, 'all full-message reads must share concurrency five')
for (const row of bulkRows) {
  assert.equal(
    bulkMessages.filter((message) => message.accountEmail === row.accountEmail).length,
    5,
    'round-robin selection must preserve an equal account share before the global cap',
  )
}
assert.ok(bulkMessages.every((message) => message.urls.length === 20))

const malformedSources = loadGmailSources({
  rows: [{ connectionId: 'malformed', accountEmail: 'malformed@gmail.com', status: 'ACTIVE' }],
  async matonFetch(path) {
    if (path.includes('?maxResults=')) {
      return Response.json({ messages: [
        { id: 'valid' },
        null,
        { id: '' },
        { id: 'deleted' },
        { id: 'provider-rejected-message' },
        { id: 'invalid-json' },
        { id: 'throws' },
        { id: 'empty-sender' },
        { id: 'oversized-sender' },
        { id: 'attachment-only' },
        { id: 'whitespace-only' },
      ] })
    }
    const id = decodeURIComponent(path.match(/\/messages\/([^?]+)/)?.[1] || '')
    if (id === 'deleted') return new Response(null, { status: 404 })
    if (id === 'provider-rejected-message') return new Response(null, { status: 422 })
    if (id === 'invalid-json') {
      return new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return Response.json({ id })
  },
  parseGmailMessage(message) {
    if (message.id === 'throws') throw new Error('malformed provider message')
    const valid = message.id === 'valid'
    return {
      externalMessageId: message.id,
      externalThreadId: null,
      senderEmail: message.id === 'empty-sender'
        ? ''
        : message.id === 'oversized-sender'
          ? `${'a'.repeat(1_000)}@acme.com`
          : 'recruiter@acme.com',
      recipientEmails: [],
      subject: valid ? 'Valid role' : '',
      receivedAt: '2026-08-28T16:00:00.000Z',
      snippet: valid ? 'A real role' : message.id === 'whitespace-only' ? '   ' : '',
      bodyText: valid ? 'A real role' : message.id === 'whitespace-only' ? '\n\t' : '',
      markerReferences: [],
      historyId: null,
      labelIds: [],
      sizeEstimate: null,
    }
  },
})
const isolatedMessages = await malformedSources.searchCareerSiteGmailMessages({
  ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
  request: { maxMessagesPerAccount: 25 },
})
assert.equal(
  JSON.stringify(isolatedMessages.map((message) => message.externalMessageId)),
  JSON.stringify(['valid']),
)

let siblingAborted = false
const terminalFailureSources = loadGmailSources({
  rows: [
    { connectionId: 'terminal-failure', accountEmail: 'failure@gmail.com', status: 'ACTIVE' },
    { connectionId: 'waiting-sibling', accountEmail: 'waiting@gmail.com', status: 'ACTIVE' },
  ],
  async matonFetch(path, init, context) {
    if (path.includes('?maxResults=')) {
      return Response.json({ messages: [{ id: `${context.boundConnectionId}-message` }] })
    }
    if (context.boundConnectionId === 'terminal-failure') {
      return new Response('provider failed', { status: 500 })
    }
    await new Promise((resolveRequest, rejectRequest) => {
      if (init.signal.aborted) {
        siblingAborted = true
        rejectRequest(new Error('aborted'))
        return
      }
      init.signal.addEventListener('abort', () => {
        siblingAborted = true
        rejectRequest(new Error('aborted'))
      }, { once: true })
    })
    throw new Error('unreachable')
  },
  parseGmailMessage: unusedParser,
})
await assert.rejects(
  terminalFailureSources.searchCareerSiteGmailMessages({
    ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
    request: { maxMessagesPerAccount: 1 },
  }),
  (error) => error?.code === 'CAREER_SITE_GMAIL_SOURCE_PROVIDER_FAILED',
)
assert.equal(siblingAborted, true, 'a terminal provider failure must abort sibling reads')

const deadlineSources = loadGmailSources({
  rows: [{ connectionId: 'deadline', accountEmail: 'deadline@gmail.com', status: 'ACTIVE' }],
  matonFetch: forbiddenProvider,
  parseGmailMessage: unusedParser,
  globals: {
    setTimeout(callback) {
      callback()
      return 1
    },
    clearTimeout() {},
  },
})
await assert.rejects(
  deadlineSources.searchCareerSiteGmailMessages({
    ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
    request: { maxMessagesPerAccount: 1 },
  }),
  (error) => error?.code === 'CAREER_SITE_GMAIL_SOURCE_DEADLINE_EXCEEDED',
)

const byteBoundRows = Array.from({ length: 10 }, (_, index) => ({
  connectionId: `byte-bound-${index}`,
  accountEmail: `byte-bound-${index}@gmail.com`,
  status: 'ACTIVE',
}))
const rawLongUrls = Array.from(
  { length: 20 },
  (_, index) => `https://role-${index}.jobs.acme.com/${'a'.repeat(2_000)}`,
).join(' ')
const byteBoundSources = loadGmailSources({
  rows: byteBoundRows,
  async matonFetch(path, init, context) {
    assert.ok(init.signal instanceof AbortSignal)
    if (path.includes('?maxResults=')) {
      return Response.json({ messages: Array.from({ length: 5 }, (_, index) => ({
        id: `${context.boundConnectionId}-large-${index}`,
      })) })
    }
    const id = decodeURIComponent(path.match(/\/messages\/([^?]+)/)?.[1] || '')
    return Response.json({
      id,
      sender: `recruiter@${context.boundConnectionId}.com`,
      receivedAt: '2026-08-28T16:00:00.000Z',
      snippet: '界'.repeat(contract.MAX_GMAIL_SNIPPET_CHARS),
      bodyText: '界'.repeat(contract.MAX_GMAIL_BODY_TEXT_CHARS),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
        body: { data: Buffer.from(rawLongUrls).toString('base64url') },
      },
    })
  },
  parseGmailMessage(message) {
    return {
      externalMessageId: message.id,
      externalThreadId: null,
      senderEmail: message.sender,
      recipientEmails: [],
      subject: 'Large valid role',
      receivedAt: message.receivedAt,
      snippet: message.snippet,
      bodyText: message.bodyText,
      markerReferences: [],
      historyId: null,
      labelIds: [],
      sizeEstimate: null,
    }
  },
})
const byteBoundMessages = await byteBoundSources.searchCareerSiteGmailMessages({
  ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
  request: { maxMessagesPerAccount: 5 },
})
assert.ok(byteBoundMessages.length > 0 && byteBoundMessages.length < 50)
assert.ok(byteBoundMessages.every((message) => message.urls.length === 20))
assert.ok(
  Buffer.byteLength(JSON.stringify({ ok: true, messages: byteBoundMessages }), 'utf8')
    <= contract.MAX_GMAIL_RESPONSE_BYTES,
  'serialized response must fit the consumer byte ceiling',
)

let cancellationSignal
let markListStarted
const listStarted = new Promise((resolveStarted) => { markListStarted = resolveStarted })
const cancellationSources = loadGmailSources({
  rows: [{ connectionId: 'cancel', accountEmail: 'cancel@gmail.com', status: 'ACTIVE' }],
  async matonFetch(path, init) {
    assert.ok(path.includes('?maxResults='))
    cancellationSignal = init.signal
    markListStarted()
    await new Promise((resolveRequest, rejectRequest) => {
      if (init.signal.aborted) {
        rejectRequest(new Error('aborted'))
        return
      }
      init.signal.addEventListener('abort', () => rejectRequest(new Error('aborted')), { once: true })
    })
    throw new Error('unreachable')
  },
  parseGmailMessage: unusedParser,
})
const callerController = new AbortController()
const cancelledSearch = cancellationSources.searchCareerSiteGmailMessages({
  ownerEmail: identity.CAREER_SITE_OWNER_EMAIL,
  request: { maxMessagesPerAccount: 1 },
  signal: callerController.signal,
})
await listStarted
callerController.abort()
await assert.rejects(
  cancelledSearch,
  (error) => error?.code === 'CAREER_SITE_GMAIL_SOURCE_CANCELLED',
)
assert.equal(cancellationSignal.aborted, true)

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
const request = (body = '') => {
  const controller = new AbortController()
  return {
    controller,
    headers: { get: () => null },
    signal: controller.signal,
    text: async () => body,
  }
}
const getResponse = await route.GET(request())
assert.equal(getResponse.status, 200)
assert.equal(JSON.stringify(getResponse.body), JSON.stringify({ ok: true, accounts }))
assert.equal(getResponse.headers['Cache-Control'], 'private, no-store, max-age=0')

const postBody = JSON.stringify({ query: 'in:inbox', maxMessagesPerAccount: 2 })
const postRequest = request(postBody)
const postResponse = await route.POST(postRequest)
assert.equal(postResponse.status, 200)
assert.equal(JSON.stringify(postResponse.body), JSON.stringify({ ok: true, messages }))
assert.equal(routeCalls[1].input.ownerEmail, identity.CAREER_SITE_OWNER_EMAIL)
assert.equal(routeCalls[1].input.request.query, 'in:inbox')
assert.equal(routeCalls[1].input.signal, postRequest.signal)

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

const healthSource = read('app_src/app/api/health/route.ts')
for (const fragment of [
  'getCareerSiteGmailSourceReadiness',
  'careerSiteGmailSources',
  'activeAccountCount: 0',
  '...readiness',
  'Career Desk Gmail sources are not ready.',
  "warnings.push('Career Desk Gmail source readiness could not be verified.')",
  "errors.push('Career Desk Gmail source configuration is invalid.')",
]) {
  assert.ok(healthSource.includes(fragment), `Health readiness is missing ${fragment}`)
}
assert.ok(!healthSource.includes('getCareerSiteGmailAccounts('))
assert.equal(route.maxDuration, 120)

const persistence = read('app_src/lib/persistence/matonCredentials.ts')
for (const fragment of [
  "AND status = 'ACTIVE'",
  "AND source = 'maton'",
  'readActiveMatonConnectionsFromPostgres',
  'readMatonCredentialReadinessFromPostgres',
  'octet_length(api_key_ciphertext) BETWEEN 16 AND 4096',
  'octet_length(api_key_iv) = 12',
  'octet_length(api_key_tag) = 16',
  'key_revoked_at IS NULL',
]) {
  assert.ok(persistence.includes(fragment), `Active Maton connection query is missing ${fragment}`)
}

console.log('Career Desk multi-account Gmail source contract, route, and gateway verified')
