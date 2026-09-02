#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}, globals = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    Buffer,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    setTimeout,
    structuredClone,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
      return nodeRequire(specifier)
    },
    ...globals,
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

function normalizeUserEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (!email || !/^[\x21-\x7e]+$/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid ASCII email address is required')
  }
  return email
}

const persistenceSource = read('app_src/lib/persistence/matonCredentials.ts')
const runtimeLookupSource = persistenceSource.slice(
  persistenceSource.indexOf('export async function resolveMatonGatewayCredentialFromPostgres'),
  persistenceSource.indexOf('export async function updateMatonCredentialInPostgres'),
)
for (const fragment of [
  'connection.owner_email = credential.owner_email',
  'connection.app = $2',
  "connection.status = 'ACTIVE'",
  "connection.source = 'maton'",
  'connection.connection_id = $3',
  'connection.is_selected',
  'credential.owner_email = $1',
]) {
  assert.ok(runtimeLookupSource.includes(fragment), `runtime credential lookup missing ${fragment}`)
}

const matonSource = read('app_src/lib/maton.ts')
for (const fragment of [
  'context?: MatonFetchContext',
  'resolveUserMatonGatewayCredential',
  'resolveConfiguredOwnerMatonGatewayCredential',
  "headers.set('Maton-Connection', credential.connectionId)",
  "redirect: 'error'",
  "cache: 'no-store'",
  "throw new Error('Maton gateway request failed')",
]) {
  assert.ok(matonSource.includes(fragment), `Maton runtime adapter missing ${fragment}`)
}
assert.ok(!matonSource.includes('console.'))

const mailSource = read('app_src/lib/matonMail.ts')
assert.ok(mailSource.includes('MATON_AUTH_GMAIL_CONNECTION_ID must differ from MATON_GMAIL_CONNECTION_ID'))
assert.ok(mailSource.includes('CLAWPILOT_AUTH_MAIL_FROM must differ from CLAWPILOT_MAIL_FROM'))
assert.ok(!mailSource.includes("'Maton-Connection'"))
assert.ok(mailSource.includes('mailFromAddress'))
assert.ok(mailSource.includes('matonPlatformMailFetch'))

const originalEnv = {
  APP_LOGIN_EMAIL: process.env.APP_LOGIN_EMAIL,
  CLAWPILOT_STORAGE: process.env.CLAWPILOT_STORAGE,
  DATABASE_URL: process.env.DATABASE_URL,
  MATON_API_KEY: process.env.MATON_API_KEY,
  MATON_API_KEY_FILE: process.env.MATON_API_KEY_FILE,
  MATON_BASE_URL: process.env.MATON_BASE_URL,
  MATON_GMAIL_CONNECTION_ID: process.env.MATON_GMAIL_CONNECTION_ID,
  MATON_AUTH_GMAIL_CONNECTION_ID: process.env.MATON_AUTH_GMAIL_CONNECTION_ID,
  CLAWPILOT_AUTH_MAIL_FROM: process.env.CLAWPILOT_AUTH_MAIL_FROM,
}

try {
  let postgresEnabled = true
  const lookupCalls = []
  const persistenceMock = {
    async resolveMatonGatewayCredentialFromPostgres(input) {
      lookupCalls.push(input)
      if (input.ownerEmail === 'missing@example.com') return { status: 'missing-key' }
      if (input.ownerEmail === 'no-connection@example.com') return { status: 'missing-connection' }
      if (input.boundConnectionId === 'not-owned') return { status: 'missing-connection' }
      return {
        status: 'resolved',
        credential: { ciphertext: Buffer.from('cipher'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) },
        connectionId: input.boundConnectionId || `${input.ownerEmail}:${input.app}:selected`,
      }
    },
  }
  const resolverModule = loadTypeScriptModule('app_src/lib/integrations/matonGatewayCredentials.ts', {
    '@/lib/integrations/matonCredentialCrypto': {
      decryptMatonApiKey(_credential, ownerEmail) { return `stored-key:${ownerEmail}` },
    },
    '@/lib/persistence/config': {
      isPostgresStorageEnabled() { return postgresEnabled },
    },
    '@/lib/persistence/matonCredentials': persistenceMock,
    '@/lib/users': { normalizeUserEmail },
  })

  const aliceSelected = await resolverModule.resolveUserMatonGatewayCredential({
    ownerEmail: 'Alice@Example.com',
    app: 'google-mail',
  })
  assert.equal(aliceSelected.apiKey, 'stored-key:alice@example.com')
  assert.equal(aliceSelected.connectionId, 'alice@example.com:google-mail:selected')
  assert.equal(lookupCalls.at(-1).ownerEmail, 'alice@example.com')
  assert.equal(lookupCalls.at(-1).app, 'google-mail')
  assert.equal(lookupCalls.at(-1).boundConnectionId, undefined)

  const aliceBound = await resolverModule.resolveUserMatonGatewayCredential({
    ownerEmail: 'alice@example.com',
    app: 'google-sheets',
    boundConnectionId: 'alice-sheets-bound',
  })
  assert.equal(aliceBound.connectionId, 'alice-sheets-bound')
  assert.equal(lookupCalls.at(-1).ownerEmail, 'alice@example.com')
  assert.equal(lookupCalls.at(-1).app, 'google-sheets')
  assert.equal(lookupCalls.at(-1).boundConnectionId, 'alice-sheets-bound')

  const bobSelected = await resolverModule.resolveUserMatonGatewayCredential({
    ownerEmail: 'bob@example.com',
    app: 'google-mail',
  })
  assert.equal(bobSelected.apiKey, 'stored-key:bob@example.com')
  assert.notEqual(bobSelected.connectionId, aliceSelected.connectionId)

  await assert.rejects(
    resolverModule.resolveUserMatonGatewayCredential({
      ownerEmail: 'alice@example.com',
      app: 'google-sheets',
      boundConnectionId: 'not-owned',
    }),
    (error) => error?.code === 'missing-connection' && !error.message.includes('not-owned'),
  )
  await assert.rejects(
    resolverModule.resolveUserMatonGatewayCredential({
      ownerEmail: 'missing@example.com',
      app: 'google-mail',
    }),
    (error) => error?.code === 'missing-key',
  )

  process.env.APP_LOGIN_EMAIL = 'owner@example.com'
  const ownerStored = await resolverModule.resolveConfiguredOwnerMatonGatewayCredential({ app: 'google-mail' })
  assert.equal(ownerStored.apiKey, 'stored-key:owner@example.com')
  assert.equal(lookupCalls.at(-1).ownerEmail, 'owner@example.com')
  process.env.APP_LOGIN_EMAIL = 'missing@example.com'
  assert.equal(await resolverModule.resolveConfiguredOwnerMatonGatewayCredential({ app: 'google-mail' }), null)
  process.env.APP_LOGIN_EMAIL = 'no-connection@example.com'
  await assert.rejects(
    resolverModule.resolveConfiguredOwnerMatonGatewayCredential({ app: 'google-mail' }),
    (error) => error?.code === 'missing-connection',
  )

  postgresEnabled = false
  await assert.rejects(
    resolverModule.resolveUserMatonGatewayCredential({ ownerEmail: 'alice@example.com', app: 'google-mail' }),
    (error) => error?.code === 'configuration',
  )
  assert.equal(await resolverModule.resolveConfiguredOwnerMatonGatewayCredential({ app: 'google-mail' }), null)
  postgresEnabled = true

  const gatewayCalls = { users: [], platformApps: [] }
  let platformCredential = null
  const gatewayMock = {
    normalizeMatonGatewayApp(value) {
      const app = String(value || '').trim().toLowerCase()
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(app)) throw new Error('A valid Maton app is required')
      return app
    },
    async resolveUserMatonGatewayCredential(input) {
      gatewayCalls.users.push(input)
      return { apiKey: `user-key:${input.ownerEmail}`, connectionId: input.boundConnectionId || 'user-selected-connection' }
    },
    async resolveConfiguredOwnerMatonGatewayCredential({ app }) {
      gatewayCalls.platformApps.push(app)
      return platformCredential
    },
  }
  const fetchCalls = []
  let fetchFailure = null
  const matonModule = loadTypeScriptModule('app_src/lib/maton.ts', {
    '@/lib/integrations/matonGatewayCredentials': gatewayMock,
  }, {
    async fetch(url, init) {
      fetchCalls.push({ url, init })
      if (fetchFailure) throw fetchFailure
      return new Response('{}', { status: 200 })
    },
  })

  process.env.MATON_BASE_URL = 'https://gateway.maton.ai'
  process.env.MATON_API_KEY = 'legacy-platform-key'
  process.env.MATON_GMAIL_CONNECTION_ID = 'legacy-gmail-connection'
  delete process.env.MATON_AUTH_GMAIL_CONNECTION_ID
  delete process.env.CLAWPILOT_AUTH_MAIL_FROM
  delete process.env.MATON_API_KEY_FILE

  assert.equal(matonModule.inferMatonGatewayApp('/google-calendar/calendar/v3/calendars/primary/events'), 'google-calendar')
  assert.equal(matonModule.inferMatonGatewayApp('/quickbooks/v3/company/1/invoice'), 'quickbooks')

  await matonModule.matonFetch(
    '/google-sheets/v4/spreadsheets/sheet-1',
    { method: 'GET' },
    { ownerEmail: 'alice@example.com', boundConnectionId: 'alice-sheets-bound' },
  )
  assert.equal(gatewayCalls.users.at(-1).ownerEmail, 'alice@example.com')
  assert.equal(gatewayCalls.users.at(-1).app, 'google-sheets')
  assert.equal(gatewayCalls.users.at(-1).boundConnectionId, 'alice-sheets-bound')
  assert.equal(fetchCalls.at(-1).init.headers.get('Authorization'), 'Bearer user-key:alice@example.com')
  assert.equal(fetchCalls.at(-1).init.headers.get('Maton-Connection'), 'alice-sheets-bound')
  assert.equal(fetchCalls.at(-1).init.redirect, 'error')
  assert.equal(fetchCalls.at(-1).init.cache, 'no-store')
  assert.ok(fetchCalls.at(-1).init.signal instanceof AbortSignal)

  platformCredential = { apiKey: 'stored-platform-key', connectionId: 'stored-platform-gmail' }
  await matonModule.matonFetch('/google-mail/gmail/v1/users/me/messages/send', { method: 'POST' })
  assert.equal(fetchCalls.at(-1).init.headers.get('Authorization'), 'Bearer stored-platform-key')
  assert.equal(fetchCalls.at(-1).init.headers.get('Maton-Connection'), 'stored-platform-gmail')
  assert.equal(gatewayCalls.platformApps.at(-1), 'google-mail')

  platformCredential = null
  await matonModule.matonFetch('/google-mail/gmail/v1/users/me/messages/send', { method: 'POST' })
  assert.equal(fetchCalls.at(-1).init.headers.get('Authorization'), 'Bearer legacy-platform-key')
  assert.equal(fetchCalls.at(-1).init.headers.get('Maton-Connection'), 'legacy-gmail-connection')

  platformCredential = { apiKey: 'wrong-stored-mail-key', connectionId: 'wrong-personal-gmail' }
  await matonModule.matonPlatformMailFetch('/google-mail/gmail/v1/users/me/messages/send', { method: 'POST' })
  assert.equal(fetchCalls.at(-1).init.headers.get('Authorization'), 'Bearer legacy-platform-key')
  assert.equal(fetchCalls.at(-1).init.headers.get('Maton-Connection'), 'legacy-gmail-connection')

  await matonModule.matonAuthMailFetch('/google-mail/gmail/v1/users/me/messages/send', { method: 'POST' })
  assert.equal(fetchCalls.at(-1).init.headers.get('Authorization'), 'Bearer legacy-platform-key')
  assert.equal(fetchCalls.at(-1).init.headers.get('Maton-Connection'), 'legacy-gmail-connection')

  const callsBeforeConnectionOnly = fetchCalls.length
  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'dedicated-auth-gmail-connection'
  await assert.rejects(
    matonModule.matonAuthMailFetch('/google-mail/gmail/v1/users/me/messages/send'),
    /MATON_AUTH_GMAIL_CONNECTION_ID and CLAWPILOT_AUTH_MAIL_FROM must be configured together/,
  )
  assert.equal(fetchCalls.length, callsBeforeConnectionOnly)

  delete process.env.MATON_AUTH_GMAIL_CONNECTION_ID
  process.env.CLAWPILOT_AUTH_MAIL_FROM = 'jarrettcrosby@gmail.com'
  const callsBeforeSenderOnly = fetchCalls.length
  await assert.rejects(
    matonModule.matonAuthMailFetch('/google-mail/gmail/v1/users/me/messages/send'),
    /MATON_AUTH_GMAIL_CONNECTION_ID and CLAWPILOT_AUTH_MAIL_FROM must be configured together/,
  )
  assert.equal(fetchCalls.length, callsBeforeSenderOnly)

  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'legacy-gmail-connection'
  await assert.rejects(
    matonModule.matonAuthMailFetch('/google-mail/gmail/v1/users/me/messages/send'),
    /MATON_AUTH_GMAIL_CONNECTION_ID must differ from MATON_GMAIL_CONNECTION_ID/,
  )
  assert.equal(fetchCalls.length, callsBeforeSenderOnly)

  process.env.MATON_AUTH_GMAIL_CONNECTION_ID = 'dedicated-auth-gmail-connection'
  await matonModule.matonAuthMailFetch('/google-mail/gmail/v1/users/me/messages/send', { method: 'POST' })
  assert.equal(fetchCalls.at(-1).init.headers.get('Authorization'), 'Bearer legacy-platform-key')
  assert.equal(fetchCalls.at(-1).init.headers.get('Maton-Connection'), 'dedicated-auth-gmail-connection')
  await assert.rejects(
    matonModule.matonAuthMailFetch('/google-calendar/calendar/v3/calendars/primary/events'),
    /Authentication mail requests must use the Google Mail gateway/,
  )

  platformCredential = null
  await matonModule.matonFetch('/google-sheets/v4/spreadsheets/sheet-2')
  assert.equal(fetchCalls.at(-1).init.headers.get('Authorization'), 'Bearer legacy-platform-key')
  assert.equal(fetchCalls.at(-1).init.headers.get('Maton-Connection'), null)

  const callsBeforeMismatch = fetchCalls.length
  await assert.rejects(
    matonModule.matonFetch(
      '/google-mail/gmail/v1/users/me/messages/send',
      undefined,
      { ownerEmail: 'alice@example.com', app: 'google-drive', boundConnectionId: 'secret-bound-id' },
    ),
    (error) => !error.message.includes('secret-bound-id'),
  )
  assert.equal(fetchCalls.length, callsBeforeMismatch)

  process.env.MATON_BASE_URL = 'http://gateway.maton.ai'
  await assert.rejects(
    matonModule.matonFetch('/google-mail/gmail/v1/users/me/messages/send'),
    /not configured safely/,
  )
  process.env.MATON_BASE_URL = 'https://gateway.maton.ai'
  await assert.rejects(matonModule.matonFetch('//evil.example/google-mail'), /safe Maton gateway path/)

  fetchFailure = new Error('upstream response contained secret-token-value')
  await assert.rejects(
    matonModule.matonFetch('/google-sheets/v4/spreadsheets/sheet-3'),
    (error) => error.message === 'Maton gateway request failed' && !error.message.includes('secret-token-value'),
  )

  console.log('PASS test-maton-runtime-credentials')
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
