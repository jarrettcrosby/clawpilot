#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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

function loadTypeScriptModule(path, mocks = {}) {
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
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

function normalizeUserEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (!email || email.length > 254 || !/^[\x21-\x7e]+$/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid ASCII email address is required')
  }
  return email
}

const migration = read('db/migrations/0018_user_maton_credentials.sql')
for (const fragment of [
  'owner_email text PRIMARY KEY REFERENCES app_users(email)',
  'api_key_ciphertext bytea',
  'api_key_iv bytea',
  'api_key_tag bytea',
  'PRIMARY KEY (owner_email, connection_id)',
  'account_email text',
  'is_selected boolean NOT NULL DEFAULT false',
  'WHERE is_selected',
]) {
  assert.ok(migration.includes(fragment), `Maton migration missing ${fragment}`)
}
assert.ok(!migration.includes('api_key text'), 'Maton migration must not store a plaintext API key')

const persistenceSource = read('app_src/lib/persistence/matonCredentials.ts')
for (const fragment of [
  'WHERE owner_email = $1',
  'PRIMARY KEY (owner_email, connection_id)',
  "source = 'maton'",
  'connection_id = ANY($2::text[])',
  'SET is_selected = false',
  'SET is_selected = true',
  'maton.credential.revoked',
]) {
  const source = fragment.startsWith('PRIMARY KEY') ? migration : persistenceSource
  assert.ok(source.includes(fragment), `Maton persistence contract missing ${fragment}`)
}
assert.ok(!persistenceSource.includes('authorization_url'))
assert.ok(!persistenceSource.includes('console.'))
const credentialUpdateSource = persistenceSource.slice(
  persistenceSource.indexOf('export async function updateMatonCredentialInPostgres'),
  persistenceSource.indexOf('export async function syncMatonConnectionsInPostgres'),
)
assert.ok(credentialUpdateSource.includes("DELETE FROM user_maton_connections WHERE owner_email = $1"))
assert.ok(credentialUpdateSource.includes('input.refreshedConnections'))
assert.ok(persistenceSource.includes("candidate.status = 'ACTIVE'"))
const revokeSource = persistenceSource.slice(persistenceSource.indexOf('export async function revokeMatonCredentialInPostgres'))
assert.ok(revokeSource.includes('UPDATE user_maton_credentials'), 'revoke must preserve the Maton profile row')
assert.ok(revokeSource.includes('DELETE FROM user_maton_connections WHERE owner_email = $1'), 'revoke must delete owner connections')
assert.ok(!revokeSource.includes('DELETE FROM user_maton_credentials'), 'revoke must preserve the login email')

const routeSource = read('app_src/app/api/integrations/maton/route.ts')
assert.ok(routeSource.includes('credential,'))
assert.ok(routeSource.includes('platformCredentialAvailable: platformCredentialAvailable'))
assert.ok(routeSource.includes("action === 'update-credential'"))
assert.ok(!routeSource.includes("action === 'profile'"))
assert.ok(!routeSource.includes("action === 'api-key'"))
assert.ok(!routeSource.includes('MATON_API_KEY'))
assert.ok(!routeSource.includes('console.'))

const serviceSource = read('app_src/lib/integrations/matonCredentials.ts')
const updateServiceSource = serviceSource.slice(
  serviceSource.indexOf('export async function updateMatonCredential'),
  serviceSource.indexOf('export async function refreshMatonConnections'),
)
assert.ok(
  updateServiceSource.indexOf('await listMatonConnections(normalized)')
    < updateServiceSource.indexOf('return updateMatonCredentialInPostgres'),
  'candidate key validation must precede the credential mutation',
)

const usersMock = { normalizeUserEmail }
const configMock = { isHostedRuntime: () => false }
process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY = 'maton-test-encryption-key-0123456789abcdef'
delete process.env.MATON_CONNECTIONS_API_BASE_URL

const cryptoModule = loadTypeScriptModule('app_src/lib/integrations/matonCredentialCrypto.ts', {
  crypto,
  '@/lib/persistence/config': configMock,
  '@/lib/users': usersMock,
})

const secretOne = 'maton-alice-api-key-00000000-ABCD'
const encryptedOne = cryptoModule.encryptMatonApiKey(secretOne, 'alice@example.com')
assert.equal(encryptedOne.iv.length, 12)
assert.equal(encryptedOne.tag.length, 16)
assert.ok(!encryptedOne.ciphertext.includes(Buffer.from(secretOne)))
assert.equal(cryptoModule.decryptMatonApiKey(encryptedOne, 'alice@example.com'), secretOne)
assert.throws(
  () => cryptoModule.decryptMatonApiKey(encryptedOne, 'bob@example.com'),
  /could not be decrypted/,
  'owner-bound AAD must reject cross-user decryption',
)
const encryptedAgain = cryptoModule.encryptMatonApiKey(secretOne, 'alice@example.com')
assert.notDeepEqual(encryptedAgain.iv, encryptedOne.iv, 'AES-GCM rotation must use a fresh nonce')

const clientModule = loadTypeScriptModule('app_src/lib/integrations/matonClient.ts', {
  '@/lib/integrations/matonCredentialCrypto': cryptoModule,
})

assert.equal(clientModule.normalizeMatonCreateApp('Gmail'), 'google-mail')
assert.equal(clientModule.normalizeMatonCreateApp('notion'), 'notion')
assert.equal(clientModule.normalizeMatonCreateApp('microsoft-teams'), 'microsoft-teams')
assert.throws(() => clientModule.normalizeMatonCreateApp('bad app'), /valid Maton application ID/)
assert.throws(() => clientModule.normalizeMatonCreateApp('-invalid'), /valid Maton application ID/)

const listRequests = []
const listed = await clientModule.listMatonConnections(secretOne, {
  fetchImpl: async (url, init) => {
    listRequests.push({ url, init })
    return new Response(JSON.stringify({
      connections: [
        {
          connection_id: 'mail-connection-1',
          app: 'google-mail',
          status: 'ACTIVE',
          method: 'oauth2',
          creation_time: '2026-07-01T12:00:00Z',
          last_updated_time: '2026-07-02T12:00:00Z',
          metadata: { email: 'first@example.com', session_token: 'must-not-survive' },
        },
        {
          connection_id: 'mail-connection-2',
          app: 'google-mail',
          status: 'ACTIVE',
          method: 'oauth2',
          account_email: 'second@example.com',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  },
})
assert.equal(listRequests[0].url, 'https://api.maton.ai/connections')
assert.equal(listRequests[0].init.method, 'GET')
assert.equal(listRequests[0].init.headers.Authorization, `Bearer ${secretOne}`)
assert.equal(listed.length, 2, 'multiple connections for the same app must not collapse')
assert.equal(listed[0].accountEmail, 'first@example.com')
assert.ok(!JSON.stringify(listed).includes('session_token'))

await assert.rejects(
  clientModule.listMatonConnections(secretOne, {
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: secretOne } }), { status: 401 }),
  }),
  (error) => error?.code === 'invalid-key' && !error.message.includes(secretOne),
)

assert.equal(
  clientModule.validateMatonAuthorizationUrl('https://connect.maton.ai/oauth/start?request=abc'),
  'https://connect.maton.ai/oauth/start?request=abc',
)
for (const invalidUrl of [
  'http://connect.maton.ai/oauth/start',
  'https://connect.maton.ai.evil.example/oauth/start',
  'https://user@connect.maton.ai/oauth/start',
  'https://connect.maton.ai:444/oauth/start',
]) {
  assert.throws(() => clientModule.validateMatonAuthorizationUrl(invalidUrl), /valid authorization URL/)
}
assert.throws(() => clientModule.resolveMatonApiBaseUrl('https://gateway.maton.ai'), /not configured safely/)
assert.throws(() => clientModule.resolveMatonApiBaseUrl('http://api.maton.ai'), /not configured safely/)

const createRequests = []
const created = await clientModule.createMatonConnection(secretOne, { app: 'google-drive', name: 'Primary Drive' }, {
  fetchImpl: async (url, init) => {
    createRequests.push({ url, init })
    return new Response(JSON.stringify({
      connection_id: 'drive-connection-1',
      app: 'google-drive',
      status: 'PENDING',
      method: 'oauth2',
      authorization_url: 'https://connect.maton.ai/oauth/start?request=drive-1',
    }), { status: 200 })
  },
})
assert.equal(createRequests[0].url, 'https://api.maton.ai/connections')
assert.equal(createRequests[0].init.method, 'POST')
assert.deepEqual(JSON.parse(createRequests[0].init.body), { app: 'google-drive' })
assert.equal(created.connection.connectionId, 'drive-connection-1')
assert.equal(created.authorizationUrl, 'https://connect.maton.ai/oauth/start?request=drive-1')

const NOW = '2026-07-14T13:00:00.000Z'
const stateByOwner = new Map()
const secretByOwner = new Map()
const calls = { updates: [], syncs: [], imports: [], selects: [], lists: [], creates: [] }

function emptyState() {
  return {
    configured: false,
    loginEmail: null,
    keyLastFour: null,
    keyVersion: 0,
    keyRotatedAt: null,
    keyRevokedAt: null,
    connections: [],
    createdAt: null,
    updatedAt: null,
  }
}

function stateFor(ownerEmail) {
  if (!stateByOwner.has(ownerEmail)) stateByOwner.set(ownerEmail, emptyState())
  return stateByOwner.get(ownerEmail)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function storedConnection(connection, previous) {
  return {
    ...connection,
    selected: previous?.selected === true,
    lastRefreshedAt: connection.source === 'maton' ? NOW : previous?.lastRefreshedAt || null,
    createdAt: previous?.createdAt || NOW,
    updatedAt: NOW,
  }
}

function ensureDefaults(state) {
  for (const app of new Set(state.connections.filter((item) => item.source === 'maton').map((item) => item.app))) {
    for (const connection of state.connections) {
      if (connection.app === app && connection.selected && (connection.source !== 'maton' || connection.status !== 'ACTIVE')) {
        connection.selected = false
      }
    }
    if (state.connections.some((item) => item.app === app && item.selected && item.status === 'ACTIVE')) continue
    const candidates = state.connections
      .filter((item) => item.app === app && item.source === 'maton' && item.status === 'ACTIVE')
    if (candidates[0]) candidates[0].selected = true
  }
}

function syncState(input) {
  const state = stateFor(input.ownerEmail)
  if (input.replaceRemote) state.connections = state.connections.filter((item) => item.source !== 'maton')
  for (const connection of input.connections) {
    const index = state.connections.findIndex((item) => item.connectionId === connection.connectionId)
    const previous = index >= 0 ? state.connections[index] : null
    const next = storedConnection({ ...connection, name: previous?.name || connection.name }, previous)
    if (index >= 0) state.connections[index] = next
    else state.connections.push(next)
  }
  ensureDefaults(state)
  state.updatedAt = NOW
  return clone(state)
}

const persistenceMock = {
  async readMatonCredentialStateFromPostgres(ownerEmail) {
    return clone(stateFor(ownerEmail))
  },
  async readEncryptedMatonApiKeyFromPostgres(ownerEmail) {
    const value = secretByOwner.get(ownerEmail)
    return value ? { ciphertext: value.ciphertext, iv: value.iv, tag: value.tag } : null
  },
  async updateMatonCredentialInPostgres(input) {
    calls.updates.push(input)
    const state = stateFor(input.ownerEmail)
    if (input.setLoginEmail) state.loginEmail = input.loginEmail
    if (input.apiKey) {
      secretByOwner.set(input.ownerEmail, input.apiKey)
      state.configured = true
      state.keyLastFour = input.apiKey.lastFour
      state.keyVersion += 1
      state.keyRotatedAt = NOW
      state.keyRevokedAt = null
      state.connections = []
      for (const connection of input.refreshedConnections) {
        state.connections.push(storedConnection(connection, null))
      }
      ensureDefaults(state)
    }
    for (const connection of input.connectionUpserts) {
      const index = state.connections.findIndex((item) => item.connectionId === connection.connectionId)
      const next = storedConnection(connection, index >= 0 ? state.connections[index] : null)
      if (index >= 0) state.connections[index] = next
      else state.connections.push(next)
    }
    state.connections = state.connections.filter((item) => !input.connectionRemovals.includes(item.connectionId))
    state.createdAt ||= NOW
    state.updatedAt = NOW
    return clone(state)
  },
  async syncMatonConnectionsInPostgres(input) {
    calls.syncs.push(input)
    assert.ok(secretByOwner.has(input.ownerEmail), 'remote sync must use an owner with a stored key')
    return syncState(input)
  },
  async importPlatformMatonCredentialInPostgres(input) {
    calls.imports.push(input)
    if (secretByOwner.has(input.ownerEmail)) throw new Error('A per-user Maton credential is already configured')
    secretByOwner.set(input.ownerEmail, input.apiKey)
    const state = stateFor(input.ownerEmail)
    state.configured = true
    state.keyLastFour = input.apiKey.lastFour
    state.keyVersion = 1
    state.keyRotatedAt = NOW
    state.createdAt = NOW
    return syncState({ ...input, replaceRemote: true })
  },
  async selectMatonConnectionInPostgres(input) {
    calls.selects.push(input)
    const state = stateFor(input.ownerEmail)
    const target = state.connections.find((item) => item.connectionId === input.connectionId && item.source === 'maton')
    if (!target) throw new Error('Maton connection was not found')
    for (const connection of state.connections) {
      if (connection.app === target.app) connection.selected = connection.connectionId === target.connectionId
    }
    return clone(state)
  },
  async revokeMatonCredentialInPostgres(ownerEmail) {
    const state = stateFor(ownerEmail)
    state.configured = false
    state.keyLastFour = null
    state.keyRotatedAt = null
    state.keyRevokedAt = NOW
    state.connections = []
    state.updatedAt = NOW
    secretByOwner.delete(ownerEmail)
    return clone(state)
  },
}

let remoteConnections = []
let listFailure = null
let createResult = null
const serviceClientMock = {
  ...clientModule,
  async listMatonConnections(apiKey) {
    calls.lists.push(apiKey)
    if (listFailure) throw listFailure
    return clone(remoteConnections)
  },
  async createMatonConnection(apiKey, input) {
    calls.creates.push({ apiKey, input })
    if (!createResult) throw new Error('missing mocked create result')
    return clone(createResult)
  },
}

const serviceModule = loadTypeScriptModule('app_src/lib/integrations/matonCredentials.ts', {
  '@/lib/integrations/matonClient': serviceClientMock,
  '@/lib/integrations/matonCredentialCrypto': cryptoModule,
  '@/lib/persistence/matonCredentials': persistenceMock,
  '@/lib/users': usersMock,
})

const alice = 'alice@example.com'
const bob = 'bob@example.com'
let aliceState = await serviceModule.updateMatonCredential(alice, {
  action: 'update-credential',
  loginEmail: 'alice.maton@example.com',
  apiKey: secretOne,
})
assert.equal(aliceState.keyLastFour, 'ABCD')
assert.equal(aliceState.loginEmail, 'alice.maton@example.com')
assert.ok(!JSON.stringify(aliceState).includes(secretOne), 'API state must mask the key')
assert.ok(!JSON.stringify(calls.updates[0]).includes(secretOne), 'persistence input must contain only encrypted key material')
assert.equal((await serviceModule.getMatonCredentialState(bob)).configured, false, 'another user must not see Alice state')
assert.equal(cryptoModule.decryptMatonApiKey(secretByOwner.get(alice), alice), secretOne)

await serviceModule.updateMatonCredential(alice, {
  action: 'update-credential',
  connections: {
    upsert: [
      { name: 'Mail one', app: 'gmail', connectionId: 'manual-mail-1', status: 'ACTIVE' },
      { name: 'Mail two', app: 'google-mail', connectionId: 'manual-mail-2', status: 'ACTIVE' },
    ],
  },
})
assert.equal(stateFor(alice).connections.length, 2)
const firstCiphertext = Buffer.from(secretByOwner.get(alice).ciphertext)
const firstIv = Buffer.from(secretByOwner.get(alice).iv)
const firstTag = Buffer.from(secretByOwner.get(alice).tag)
const stateBeforeRejectedRotation = clone(stateFor(alice))
const updatesBeforeRejectedRotation = calls.updates.length
const rejectedSecret = 'maton-rejected-api-key-11111111-RJCT'
listFailure = new clientModule.MatonClientError('Maton API key was rejected', 'invalid-key')
await assert.rejects(
  serviceModule.updateMatonCredential(alice, {
    action: 'update-credential',
    loginEmail: 'rejected-change@example.com',
    apiKey: rejectedSecret,
  }),
  (error) => error?.status === 422 && error?.code === 'MATON_KEY_REJECTED',
)
assert.equal(calls.lists.at(-1), rejectedSecret)
assert.equal(calls.updates.length, updatesBeforeRejectedRotation, 'rejected key must not reach persistence')
assert.deepEqual(stateFor(alice), stateBeforeRejectedRotation, 'rejected key must preserve profile, version, and connections')
assert.deepEqual(secretByOwner.get(alice).ciphertext, firstCiphertext)
assert.deepEqual(secretByOwner.get(alice).iv, firstIv)
assert.deepEqual(secretByOwner.get(alice).tag, firstTag)
assert.equal(cryptoModule.decryptMatonApiKey(secretByOwner.get(alice), alice), secretOne)

const unavailableSecret = 'maton-unavailable-api-key-11111111-FAIL'
listFailure = new clientModule.MatonClientError('Maton connections API request failed', 'unavailable')
await assert.rejects(
  serviceModule.updateMatonCredential(alice, {
    action: 'update-credential',
    loginEmail: 'unavailable-change@example.com',
    apiKey: unavailableSecret,
  }),
  (error) => error?.status === 502 && error?.code === 'MATON_UPSTREAM_ERROR',
)
assert.equal(calls.lists.at(-1), unavailableSecret)
assert.equal(calls.updates.length, updatesBeforeRejectedRotation, 'unavailable validation must not reach persistence')
assert.deepEqual(stateFor(alice), stateBeforeRejectedRotation)
listFailure = null

remoteConnections = [
  {
    connectionId: 'mail-connection-1', name: 'google-mail', app: 'google-mail', status: 'ACTIVE', method: 'oauth2',
    accountEmail: 'first@example.com', source: 'maton', remoteCreatedAt: NOW, remoteUpdatedAt: NOW,
  },
  {
    connectionId: 'mail-connection-2', name: 'google-mail', app: 'google-mail', status: 'ACTIVE', method: 'oauth2',
    accountEmail: 'second@example.com', source: 'maton', remoteCreatedAt: NOW, remoteUpdatedAt: NOW,
  },
  {
    connectionId: 'sheet-connection-1', name: 'google-sheets', app: 'google-sheets', status: 'ACTIVE', method: 'oauth2',
    accountEmail: 'alice@example.com', source: 'maton', remoteCreatedAt: NOW, remoteUpdatedAt: NOW,
  },
  {
    connectionId: 'drive-pending-1', name: 'google-drive', app: 'google-drive', status: 'PENDING', method: 'oauth2',
    accountEmail: null, source: 'maton', remoteCreatedAt: NOW, remoteUpdatedAt: NOW,
  },
]
const secretTwo = 'maton-alice-api-key-11111111-WXYZ'
const syncsBeforeRotation = calls.syncs.length
aliceState = await serviceModule.updateMatonCredential(alice, {
  action: 'update-credential',
  loginEmail: 'alice.rotated@example.com',
  apiKey: secretTwo,
})
assert.equal(aliceState.keyVersion, 2)
assert.equal(aliceState.keyLastFour, 'WXYZ')
assert.equal(aliceState.loginEmail, 'alice.rotated@example.com')
assert.equal(aliceState.connections.length, 4, 'rotation must immediately store the validated remote snapshot')
assert.equal(aliceState.connections.some((connection) => connection.source === 'manual'), false)
assert.equal(
  aliceState.connections.filter((connection) => connection.app === 'google-mail' && connection.selected).length,
  1,
)
assert.equal(
  aliceState.connections.filter((connection) => connection.app === 'google-sheets' && connection.selected).length,
  1,
)
assert.equal(aliceState.connections.find((connection) => connection.connectionId === 'drive-pending-1').selected, false)
assert.ok(aliceState.connections.filter((connection) => connection.selected).every((connection) => connection.status === 'ACTIVE'))
assert.equal(calls.syncs.length, syncsBeforeRotation, 'rotation must not require a separate refresh mutation')
assert.equal(calls.updates.at(-1).refreshedConnections.length, remoteConnections.length)
assert.equal(calls.lists.at(-1), secretTwo)
assert.ok(!JSON.stringify(calls.updates.at(-1)).includes(secretTwo))
assert.notDeepEqual(secretByOwner.get(alice).ciphertext, firstCiphertext)
assert.equal(cryptoModule.decryptMatonApiKey(secretByOwner.get(alice), alice), secretTwo)

await assert.rejects(
  serviceModule.updateMatonCredential(alice, { action: 'update-credential', apiKey: 'short' }),
  /valid Maton API key/,
)
await assert.rejects(
  serviceModule.updateMatonCredential(alice, { action: 'profile', loginEmail: 'alice@example.com' }),
  /Unsupported Maton action/,
)
await assert.rejects(
  serviceModule.updateMatonCredential(alice, {
    action: 'update-credential',
    ownerEmail: bob,
    loginEmail: 'alice@example.com',
  }),
  /Unsupported Maton credential field/,
)
await assert.rejects(
  serviceModule.updateMatonCredential(alice, {
    action: 'update-credential',
    connections: { upsert: [{ app: 'bad app', name: 'Bad', connectionId: 'bad-id' }] },
  }),
  /lowercase app identifier/,
)

remoteConnections = [
  {
    connectionId: 'mail-connection-1', name: 'google-mail', app: 'google-mail', status: 'ACTIVE', method: 'oauth2',
    accountEmail: 'first@example.com', source: 'maton', remoteCreatedAt: NOW, remoteUpdatedAt: NOW,
  },
  {
    connectionId: 'mail-connection-2', name: 'google-mail', app: 'google-mail', status: 'ACTIVE', method: 'oauth2',
    accountEmail: 'second@example.com', source: 'maton', remoteCreatedAt: NOW, remoteUpdatedAt: NOW,
  },
]
aliceState = await serviceModule.refreshMatonConnections(alice)
assert.equal(aliceState.connections.length, 2)
assert.equal(aliceState.connections.filter((connection) => connection.selected).length, 1)
assert.equal(calls.syncs.at(-1).ownerEmail, alice)

listFailure = new clientModule.MatonClientError('Maton API key was rejected', 'invalid-key')
await assert.rejects(
  serviceModule.refreshMatonConnections(alice),
  (error) => error?.status === 422 && error?.code === 'MATON_KEY_REJECTED',
)
listFailure = null

createResult = {
  connection: {
    connectionId: 'drive-connection-2', name: 'google-drive', app: 'google-drive', status: 'PENDING', method: 'oauth2',
    accountEmail: null, source: 'maton', remoteCreatedAt: null, remoteUpdatedAt: null,
  },
  authorizationUrl: 'https://connect.maton.ai/oauth/start?request=drive-2',
}
const createServiceResult = await serviceModule.createUserMatonConnection(alice, { app: 'google-drive' })
assert.equal(createServiceResult.authorizationUrl, 'https://connect.maton.ai/oauth/start?request=drive-2')
assert.equal(calls.creates.at(-1).input.app, 'google-drive')
await assert.rejects(
  serviceModule.createUserMatonConnection(alice, { app: 'bad app' }),
  /valid Maton app/,
)

remoteConnections.push({
  connectionId: 'drive-pending-1', name: 'google-drive', app: 'google-drive', status: 'PENDING', method: 'oauth2',
  accountEmail: null, source: 'maton', remoteCreatedAt: NOW, remoteUpdatedAt: NOW,
})
await assert.rejects(
  serviceModule.selectUserMatonConnection(alice, 'drive-pending-1'),
  (error) => error?.status === 409 && error?.code === 'MATON_CONNECTION_INACTIVE',
)

aliceState = await serviceModule.selectUserMatonConnection(alice, 'mail-connection-2')
assert.equal(aliceState.connections.find((item) => item.connectionId === 'mail-connection-2').selected, true)
assert.equal(calls.selects.at(-1).ownerEmail, alice)
await assert.rejects(
  serviceModule.selectUserMatonConnection(alice, 'not-owned-connection'),
  (error) => error?.status === 404,
)

process.env.APP_LOGIN_EMAIL = 'owner@example.com'
process.env.MATON_API_KEY = 'maton-platform-api-key-22222222-IJKL'
const ownerState = await serviceModule.getMatonCredentialState('owner@example.com')
assert.equal(serviceModule.platformCredentialAvailable('owner@example.com', ownerState), true)
assert.equal(serviceModule.platformCredentialAvailable('admin@example.com', emptyState()), false)
await assert.rejects(
  serviceModule.importPlatformMatonCredential('admin@example.com'),
  (error) => error?.status === 403,
)
remoteConnections = [{
  connectionId: 'sheet-connection-1', name: 'google-sheets', app: 'google-sheets', status: 'ACTIVE', method: 'oauth2',
  accountEmail: 'owner@example.com', source: 'maton', remoteCreatedAt: NOW, remoteUpdatedAt: NOW,
}]
const imported = await serviceModule.importPlatformMatonCredential('owner@example.com')
assert.equal(imported.keyLastFour, 'IJKL')
assert.equal(imported.connections.length, 1)
assert.ok(!JSON.stringify(imported).includes(process.env.MATON_API_KEY))
assert.equal(serviceModule.platformCredentialAvailable('owner@example.com', imported), false)

const revokeOwner = 'revoke@example.com'
await serviceModule.updateMatonCredential(revokeOwner, {
  action: 'update-credential',
  loginEmail: 'revoke.maton@example.com',
  apiKey: 'maton-revoke-api-key-33333333-MNOP',
  connections: {
    upsert: [{ app: 'google-drive', name: 'Drive', connectionId: 'revoke-drive-1', status: 'ACTIVE' }],
  },
})
const revokedState = await serviceModule.revokeMatonCredential(revokeOwner)
assert.equal(revokedState.configured, false)
assert.equal(revokedState.loginEmail, 'revoke.maton@example.com')
assert.equal(revokedState.connections.length, 0)
assert.equal(secretByOwner.has(revokeOwner), false)

let actorEmail = alice
let postgresEnabled = true
const nextServerMock = {
  NextRequest: class NextRequest {},
  NextResponse: {
    json(payload, init = {}) {
      return new Response(JSON.stringify(payload), {
        status: init.status || 200,
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      })
    },
  },
}
const routeModule = loadTypeScriptModule('app_src/app/api/integrations/maton/route.ts', {
  'next/server': nextServerMock,
  '@/lib/integrations/matonCredentials': serviceModule,
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => postgresEnabled },
  '@/lib/requestUser': { requireRequestUser: async () => ({ email: actorEmail }) },
})

let response = await routeModule.GET(new Request('http://clawpilot.test/api/integrations/maton'))
let payload = await response.json()
assert.equal(response.status, 200)
assert.ok(payload.credential)
assert.equal(typeof payload.platformCredentialAvailable, 'boolean')
assert.equal(payload.integration, undefined)
assert.ok(!JSON.stringify(payload).includes(secretTwo))

response = await routeModule.PATCH(new Request('http://clawpilot.test/api/integrations/maton', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'update-credential', loginEmail: 'new-alice@example.com' }),
}))
payload = await response.json()
assert.equal(response.status, 200)
assert.equal(payload.credential.loginEmail, 'new-alice@example.com')

response = await routeModule.PATCH(new Request('http://clawpilot.test/api/integrations/maton', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'profile', loginEmail: 'alias@example.com' }),
}))
assert.equal(response.status, 400, 'non-canonical update aliases must be rejected')

actorEmail = bob
response = await routeModule.GET(new Request('http://clawpilot.test/api/integrations/maton'))
payload = await response.json()
assert.equal(payload.credential.configured, false)
assert.equal(payload.credential.loginEmail, null)

postgresEnabled = false
response = await routeModule.GET(new Request('http://clawpilot.test/api/integrations/maton'))
payload = await response.json()
assert.equal(response.status, 503)
assert.equal(payload.code, 'MATON_POSTGRES_REQUIRED')

console.log('PASS test-maton-user-credentials')
