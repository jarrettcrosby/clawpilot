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

const migration = read('db/migrations/0344_organization_communication_bindings.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS organization_communication_bindings',
  'PRIMARY KEY (organization_id, app)',
  "app IN ('google-mail', 'google-calendar')",
  'communication_credential_owner_email',
  'communication_connection_id',
  'communication_identity_email',
  'communication_binding_source',
]) {
  assert.ok(migration.includes(fragment), `Organization communication migration missing ${fragment}`)
}

const persistence = read('app_src/lib/persistence/organizationCommunications.ts')
for (const fragment of [
  'resolvePipelineCommunicationSnapshotInPostgres',
  'workspace_organization_id',
  'organization_communication_bindings',
  "connection.status = 'ACTIVE'",
  'connection.account_email IS NOT NULL',
  'connection.is_selected',
  "'organization'::text AS source",
  "'user-default'::text AS source",
]) {
  assert.ok(persistence.includes(fragment), `Organization communication persistence missing ${fragment}`)
}
assert.ok(
  persistence.indexOf('FROM organization_communication_bindings')
    < persistence.indexOf('connection.is_selected'),
  'Organization binding lookup must precede the compatibility fallback',
)
assert.ok(
  persistence.includes('AND NOT EXISTS (SELECT 1 FROM configured_binding)'),
  'User-default selection must only be a compatibility fallback when no organization binding exists',
)

const actionRuntime = read('app_src/lib/crm/integrationActions.ts')
for (const fragment of [
  'resolvePipelineCommunicationSnapshotInPostgres',
  'communication_credential_owner_email',
  'communication_connection_id',
  'communication_identity_email',
  'communication_binding_source',
  'existing.communication_identity_email IS NOT DISTINCT FROM $15',
  'existing.communication_binding_source IS NOT DISTINCT FROM $17',
  'boundConnectionId: action.communicationConnectionId || undefined',
  '/settings/sendAs/${encodeURIComponent(senderEmail)}',
  '/google-calendar/calendar/v3/users/me/calendarList/primary',
  'The queued Calendar account no longer matches its reviewed identity',
  'selectedConnection.calendarId || \'primary\'',
  'communication: action.communication',
]) {
  assert.ok(actionRuntime.includes(fragment), `CRM communication runtime missing ${fragment}`)
}

const route = read('app_src/app/api/integrations/communications/route.ts')
assert.ok(route.includes('requireManager(actor)'))
assert.ok(route.includes("requireOnlyFields(body, ['action', 'app', 'connectionId', 'identityEmail'])"))
assert.ok(route.includes("String(body.action || '').trim() !== 'bind'"))

const crmRoute = read('app_src/app/api/crm/route.ts')
assert.ok(crmRoute.includes('calendarActionUnavailable'))
assert.ok(crmRoute.includes("error.code === 'CRM_COMMUNICATION_CONNECTION_REQUIRED'"))
const suiteCrmMeetingIngestion = read('app_src/lib/crm/suiteCrmMeetingIngestion.ts')
assert.ok(suiteCrmMeetingIngestion.includes("error.code === 'CRM_COMMUNICATION_CONNECTION_REQUIRED'"))

const writes = []
let providerMode = 'alias-accepted'
const providerRequests = []
const service = loadTypeScriptModule('app_src/lib/integrations/organizationCommunications.ts', {
  '@/lib/integrations/matonGatewayCredentials': {
    resolveUserMatonGatewayCredential: async ({ ownerEmail, app, boundConnectionId }) => ({
      apiKey: 'secret-not-returned',
      connectionId: boundConnectionId,
      accountEmail: ownerEmail,
      app,
    }),
  },
  '@/lib/integrations/matonCredentials': {
    getMatonCredentialState: async () => ({
      connections: [{
        connectionId: 'mail-connection',
        name: 'Primary Gmail',
        app: 'google-mail',
        accountEmail: 'jarrett@suburbiasandwichco.com',
        status: 'ACTIVE',
        source: 'maton',
        selected: true,
      }],
    }),
  },
  '@/lib/maton': {
    matonFetch: async (pathname, _init, context) => {
      providerRequests.push({ pathname, context })
      if (pathname.endsWith('/profile')) {
        return new Response(JSON.stringify({ emailAddress: 'jarrett@suburbiasandwichco.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (pathname.includes('/settings/sendAs/')) {
        return new Response(JSON.stringify({
          sendAsEmail: 'jarrett@bposupplychain.com',
          verificationStatus: providerMode === 'alias-accepted' ? 'accepted' : 'pending',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (pathname.endsWith('/calendarList/primary')) {
        return new Response(JSON.stringify({ id: 'jarrett@bposupplychain.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    },
  },
  '@/lib/persistence/organizationCommunications': {
    deleteOrganizationCommunicationBindingInPostgres: async () => {},
    listOrganizationCommunicationBindingsInPostgres: async () => [],
    upsertOrganizationCommunicationBindingInPostgres: async (input) => writes.push(input),
  },
  '@/lib/users': { normalizeUserEmail },
})

assert.equal(service.normalizeOrganizationCommunicationApp('gmail'), 'google-mail')
assert.equal(service.normalizeOrganizationCommunicationApp('calendar'), 'google-calendar')
assert.throws(() => service.normalizeOrganizationCommunicationApp('drive'), /Gmail or Google Calendar/)

await service.bindOrganizationCommunication({
  organizationId: '11111111-1111-4111-8111-111111111111',
  actorEmail: 'jarrett@suburbiasandwichco.com',
  app: 'google-mail',
  connectionId: 'mail-connection',
  identityEmail: 'jarrett@bposupplychain.com',
})
assert.equal(writes[0].identityEmail, 'jarrett@bposupplychain.com')
assert.equal(writes[0].accountEmail, 'jarrett@suburbiasandwichco.com')
assert.equal(writes[0].calendarId, null)
assert.ok(providerRequests.some((request) => request.pathname.includes('/settings/sendAs/jarrett%40bposupplychain.com')))
assert.ok(providerRequests.every((request) => request.context.boundConnectionId === 'mail-connection'))

providerMode = 'alias-pending'
await assert.rejects(
  service.bindOrganizationCommunication({
    organizationId: '11111111-1111-4111-8111-111111111111',
    actorEmail: 'jarrett@suburbiasandwichco.com',
    app: 'google-mail',
    connectionId: 'mail-connection',
    identityEmail: 'jarrett@bposupplychain.com',
  }),
  (error) => error?.code === 'ORGANIZATION_COMMUNICATION_SENDER_NOT_VERIFIED',
)

providerMode = 'alias-accepted'
await service.bindOrganizationCommunication({
  organizationId: '11111111-1111-4111-8111-111111111111',
  actorEmail: 'jarrett@suburbiasandwichco.com',
  app: 'google-calendar',
  connectionId: 'calendar-connection',
})
assert.equal(writes[1].identityEmail, 'jarrett@bposupplychain.com')
assert.equal(writes[1].calendarId, 'primary')

console.log('organization communications contract tests passed')
