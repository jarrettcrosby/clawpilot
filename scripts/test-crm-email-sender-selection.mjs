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
    URLSearchParams,
    clearTimeout,
    console,
    crypto: globalThis.crypto,
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
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid email')
  return email
}

function globalIdPattern(prefixes) {
  const values = Array.isArray(prefixes) ? prefixes : [prefixes]
  return new RegExp(`^(?:${values.join('|')})[a-z0-9]{7,48}$`, 'i')
}

function globalIdFragment(prefixes) {
  const values = Array.isArray(prefixes) ? prefixes : [prefixes]
  return `(?:${values.join('|')})[A-Za-z0-9]{7,48}`
}

class OrganizationCommunicationPersistenceError extends Error {
  constructor(message, status = 400, code = 'ORGANIZATION_COMMUNICATION_INVALID') {
    super(message)
    this.name = 'OrganizationCommunicationPersistenceError'
    this.status = status
    this.code = code
  }
}

const PIPELINE_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'
const CONTACT_ID = '33333333-3333-4333-8333-333333333333'
const CAMPAIGN_ID = '44444444-4444-4444-8444-444444444444'
const ACTION_ID = '55555555-5555-4555-8555-555555555555'
const ACTOR_EMAIL = 'operator@suburbiasandwichco.com'
const GMAIL_ACCOUNT = 'jarrettcrosby@gmail.com'
const SENDER_ALIAS = 'stewards@eigenracing.com'
const CONNECTION_ID = 'personal-gmail-connection'
const CONTACT_REFERENCE = 'gc1234567'
const SECOND_CONTACT_REFERENCE = 'gc7654321'
const CAMPAIGN_REFERENCE = 'gk1234567'

const communicationSnapshot = Object.freeze({
  organizationId: ORGANIZATION_ID,
  credentialOwnerEmail: ACTOR_EMAIL,
  connectionId: CONNECTION_ID,
  accountEmail: GMAIL_ACCOUNT,
  identityEmail: SENDER_ALIAS,
  calendarId: null,
  source: 'email-override',
})

const contactTarget = {
  entity: 'contacts',
  id: CONTACT_ID,
  referenceCode: CONTACT_REFERENCE,
  name: 'Email Recipient',
  email: 'recipient@example.com',
  emailOptOut: false,
  phone: null,
  organizationId: null,
  suiteCrmId: null,
}

const campaignTarget = {
  entity: 'campaigns',
  id: CAMPAIGN_ID,
  referenceCode: CAMPAIGN_REFERENCE,
  name: 'BPO launch',
  email: null,
  emailOptOut: false,
  phone: null,
  organizationId: ORGANIZATION_ID,
  suiteCrmId: null,
}

function actionRow(overrides = {}) {
  return {
    id: ACTION_ID,
    pipeline_id: PIPELINE_ID,
    actor_email: ACTOR_EMAIL,
    provider: 'maton',
    app: 'google-mail',
    action_type: 'send_email',
    aggregate_type: 'crm_contact',
    aggregate_id: CONTACT_ID,
    reference_code: CONTACT_REFERENCE,
    payload: {
      subject: 'Sender selection test',
      text: 'Delivery body',
      recipientEmail: contactTarget.email,
    },
    status: 'processing',
    attempts: 1,
    available_at: new Date('2026-09-03T12:00:00.000Z'),
    locked_at: new Date('2026-09-03T12:00:00.000Z'),
    lock_token: 'lease-token',
    external_id: null,
    response_summary: {},
    last_error: null,
    idempotency_key: 'email-sender-selection-test',
    workspace_organization_id: ORGANIZATION_ID,
    communication_credential_owner_email: ACTOR_EMAIL,
    communication_connection_id: CONNECTION_ID,
    communication_account_email: GMAIL_ACCOUNT,
    communication_identity_email: SENDER_ALIAS,
    communication_calendar_id: null,
    communication_binding_source: 'email-override',
    processed_at: null,
    created_at: new Date('2026-09-03T12:00:00.000Z'),
    updated_at: new Date('2026-09-03T12:00:00.000Z'),
    ...overrides,
  }
}

function leasedAction(row) {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    provider: row.provider,
    app: row.app,
    actionType: row.action_type,
    referenceCode: row.reference_code,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at.toISOString(),
    externalId: row.external_id,
    responseSummary: row.response_summary,
    communication: {
      organizationId: row.workspace_organization_id,
      credentialOwnerEmail: row.communication_credential_owner_email,
      connectionId: row.communication_connection_id,
      accountEmail: row.communication_account_email,
      identityEmail: row.communication_identity_email,
      calendarId: row.communication_calendar_id,
      source: row.communication_binding_source,
    },
    lastError: row.last_error,
    processedAt: row.processed_at,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    actorEmail: row.actor_email,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    lockToken: row.lock_token,
    idempotencyKey: row.idempotency_key,
    communicationCredentialOwnerEmail: row.communication_credential_owner_email,
    communicationConnectionId: row.communication_connection_id,
  }
}

const commonMocks = {
  '@/lib/globalIds.mjs': {
    GLOBAL_ID_MAX_LENGTH: 64,
    globalIdFragment,
    globalIdPattern,
  },
  '@/lib/users': { normalizeUserEmail },
  '@/lib/zonedDateTime': {
    zonedDateTimeToIso(value) {
      const parsed = new Date(String(value || ''))
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
    },
  },
}

let credentialMode = 'available'
let aliasMode = 'accepted'
let liveProfileEmail = GMAIL_ACCOUNT
let currentRow = actionRow()
let providerRequests = []
let targetReads = 0
let recipientMutations = 0
let childActionWrites = []
let interactionWrites = []
let campaignCountUpdates = 0

function reset(row) {
  currentRow = row
  providerRequests = []
  targetReads = 0
  recipientMutations = 0
  childActionWrites = []
  interactionWrites = []
  campaignCountUpdates = 0
}

function readActionResult() {
  return { rows: [currentRow], rowCount: 1 }
}

async function processQuery(sql, parameters = []) {
  if (sql.includes('UPDATE crm_integration_action_attempts attempt') && sql.includes('SET connection_id')) {
    return { rows: [], rowCount: 1 }
  }
  if (sql.includes("SELECT 'contacts'::text AS entity") && sql.includes('UNION ALL')) {
    targetReads += 1
    return {
      rows: [
        {
          entity: 'contacts',
          id: CONTACT_ID,
          reference_code: CONTACT_REFERENCE,
          first_name: 'Email',
          last_name: 'Recipient',
          full_name: 'Email Recipient',
          email: 'recipient@example.com',
          email_opt_out: false,
          organization_id: null,
          suitecrm_id: null,
        },
        {
          entity: 'contacts',
          id: '66666666-6666-4666-8666-666666666666',
          reference_code: SECOND_CONTACT_REFERENCE,
          first_name: 'Second',
          last_name: 'Recipient',
          full_name: 'Second Recipient',
          email: 'second@example.com',
          email_opt_out: false,
          organization_id: null,
          suitecrm_id: null,
        },
      ],
      rowCount: 2,
    }
  }
  if (sql.includes('SELECT * FROM crm_integration_actions')) return readActionResult()
  throw new Error(`unexpected process SQL: ${sql.slice(0, 120)}`)
}

const transactionClient = {
  async query(sql, parameters = []) {
    if (sql.includes('INSERT INTO crm_campaign_recipients')) {
      const writes = JSON.parse(parameters[2])
      recipientMutations += writes.length
      return {
        rows: writes.map((write, index) => ({
          id: index === 0
            ? '77777777-7777-4777-8777-777777777777'
            : '88888888-8888-4888-8888-888888888888',
          email: write.email,
          status: write.status,
        })),
        rowCount: writes.length,
      }
    }
    if (sql.includes('WITH inserted AS') && sql.includes('INSERT INTO crm_integration_actions')) {
      const child = actionRow({
        id: childActionWrites.length === 0
          ? '99999999-9999-4999-8999-999999999999'
          : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        actor_email: parameters[1],
        provider: parameters[2],
        app: parameters[3],
        action_type: parameters[4],
        aggregate_type: parameters[5],
        aggregate_id: parameters[6],
        reference_code: parameters[7],
        payload: JSON.parse(parameters[8]),
        idempotency_key: parameters[9],
        workspace_organization_id: parameters[10],
        communication_credential_owner_email: parameters[11],
        communication_connection_id: parameters[12],
        communication_account_email: parameters[13],
        communication_identity_email: parameters[14],
        communication_calendar_id: parameters[15],
        communication_binding_source: parameters[16],
        status: 'queued',
        attempts: 0,
        lock_token: null,
        locked_at: null,
        created: true,
        matches_intent: true,
      })
      childActionWrites.push({ child, parameters: [...parameters] })
      return { rows: [child], rowCount: 1 }
    }
    if (sql.includes('UPDATE crm_campaign_recipients') && sql.includes('SET integration_action_id')) {
      recipientMutations += 1
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE crm_campaigns campaign')) {
      campaignCountUpdates += 1
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE crm_integration_actions') && sql.includes('SET external_id = $3')) {
      currentRow = actionRow({
        ...currentRow,
        external_id: parameters[2],
        response_summary: JSON.parse(parameters[3]),
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes("UPDATE crm_integration_actions") && sql.includes("SET status = 'succeeded'")) {
      currentRow = actionRow({
        ...currentRow,
        status: 'succeeded',
        lock_token: null,
        locked_at: null,
        external_id: parameters[2] || currentRow.external_id,
        response_summary: JSON.parse(parameters[3]),
        last_error: null,
        processed_at: new Date('2026-09-03T12:05:00.000Z'),
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE crm_integration_actions') && sql.includes('SET status = $3')) {
      currentRow = actionRow({
        ...currentRow,
        status: parameters[2],
        last_error: parameters[3],
        lock_token: null,
        locked_at: null,
        processed_at: parameters[2] === 'dead' ? new Date('2026-09-03T12:05:00.000Z') : null,
      })
      return { rows: [], rowCount: 1 }
    }
    if (
      sql.includes('UPDATE crm_integration_action_attempts')
      || sql.includes('INSERT INTO audit_events')
    ) {
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected transaction SQL: ${sql.slice(0, 120)}`)
  },
}

const runtime = loadTypeScriptModule('app_src/lib/crm/integrationActions.ts', {
  ...commonMocks,
  '@/lib/integrations/matonGatewayCredentials': {
    resolveUserMatonGatewayCredential: async ({ ownerEmail, app, boundConnectionId }) => {
      assert.equal(ownerEmail, ACTOR_EMAIL)
      assert.equal(app, 'google-mail')
      assert.equal(boundConnectionId, CONNECTION_ID)
      if (credentialMode === 'missing') throw new Error('selected Gmail connection is unavailable')
      return {
        connectionId: CONNECTION_ID,
        accountEmail: GMAIL_ACCOUNT,
        ownerEmail: ACTOR_EMAIL,
      }
    },
  },
  '@/lib/maton': {
    matonFetch: async (pathname, init = {}, context = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      providerRequests.push({ pathname, init, context, body })
      assert.equal(context.ownerEmail, ACTOR_EMAIL)
      assert.equal(context.app, 'google-mail')
      assert.equal(context.boundConnectionId, CONNECTION_ID)
      if (pathname.endsWith('/users/me/profile')) {
        return new Response(JSON.stringify({ emailAddress: liveProfileEmail }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (pathname.includes('/settings/sendAs/')) {
        if (aliasMode === 'missing') {
          return new Response(JSON.stringify({ error: { code: 404, message: 'Send-as identity not found' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({
          sendAsEmail: SENDER_ALIAS,
          verificationStatus: aliasMode === 'accepted' ? 'accepted' : 'pending',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (pathname.endsWith('/messages/send')) {
        return new Response(JSON.stringify({ id: 'gmail-message-id', threadId: 'gmail-thread-id' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected provider request: ${pathname}`)
    },
  },
  '@/lib/persistence/crm': {
    readCrmRecordByReference: async ({ referenceCode }) => {
      if (referenceCode === CAMPAIGN_REFERENCE) return campaignTarget
      if (referenceCode === CONTACT_REFERENCE || referenceCode === SECOND_CONTACT_REFERENCE) return contactTarget
      throw new Error('record not found')
    },
    resolveCrmReferenceCode: async (value) => value,
    stageCrmRecordWithClient: async () => { throw new Error('not expected') },
    stageCrmRecordInPostgres: async (input) => {
      interactionWrites.push(input)
      return {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        referenceCode: 'gi1234567',
        sourceHash: 'interaction-source-hash',
      }
    },
  },
  '@/lib/persistence/organizationCommunications': {
    OrganizationCommunicationPersistenceError,
    resolvePipelineCommunicationScopeInPostgres: async () => ({ organizationId: ORGANIZATION_ID }),
    resolvePipelineCommunicationSnapshotInPostgres: async () => {
      throw new Error('an email override must not re-resolve the organization default')
    },
  },
  '@/lib/persistence/postgres': {
    query: processQuery,
    withTransaction: async (work) => work(transactionClient),
  },
})

function emailAction() {
  return leasedAction(currentRow)
}

function campaignAction() {
  const row = actionRow({
    provider: 'internal',
    app: 'crm',
    action_type: 'send_campaign',
    aggregate_type: 'crm_campaign',
    aggregate_id: CAMPAIGN_ID,
    reference_code: CAMPAIGN_REFERENCE,
    payload: {
      subject: 'Hello {{firstName}}',
      text: 'Hello {{name}}',
      recipientReferences: [CONTACT_REFERENCE, SECOND_CONTACT_REFERENCE],
    },
    idempotency_key: 'campaign-sender-selection-test',
  })
  reset(row)
  return leasedAction(row)
}

credentialMode = 'available'
aliasMode = 'accepted'
reset(actionRow())
const directResult = await runtime.processCrmIntegrationAction(emailAction(), { maxAttempts: 1 })
assert.equal(directResult.status, 'succeeded', directResult.lastError || 'direct email should succeed')
const sendRequest = providerRequests.find((request) => request.pathname.endsWith('/messages/send'))
assert.ok(sendRequest, 'the exact selected Gmail connection must send the message')
assert.equal(sendRequest.context.boundConnectionId, CONNECTION_ID)
const rawMessage = Buffer.from(sendRequest.body.raw, 'base64url').toString('utf8')
assert.match(rawMessage, new RegExp(`^From: <${SENDER_ALIAS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>\\r?$`, 'm'))
assert.equal(interactionWrites.length, 1)
assert.equal(interactionWrites[0].sourcePayload.senderEmail, SENDER_ALIAS)
assert.equal(interactionWrites[0].sourcePayload.senderAccountEmail, GMAIL_ACCOUNT)
assert.equal(interactionWrites[0].sourcePayload.communicationBindingSource, 'email-override')

// A provider primary is verified by the exact live profile, with no alias
// verificationStatus required. Cached account labels must not override a
// freshly reviewed, immutable account snapshot after a Workspace rename.
for (const primaryEmail of [GMAIL_ACCOUNT, 'jarrett@bposupplychain.com']) {
  liveProfileEmail = primaryEmail
  reset(actionRow({
    communication_account_email: primaryEmail,
    communication_identity_email: primaryEmail,
  }))
  const primaryResult = await runtime.processCrmIntegrationAction(emailAction(), { maxAttempts: 1 })
  assert.equal(primaryResult.status, 'succeeded', primaryResult.lastError || 'primary Gmail sender should succeed')
  assert.equal(providerRequests.some((request) => request.pathname.includes('/settings/sendAs/')), false)
  const primarySend = providerRequests.find((request) => request.pathname.endsWith('/messages/send'))
  assert.ok(primarySend)
  assert.equal(primarySend.context.boundConnectionId, CONNECTION_ID)
  assert.ok(Buffer.from(primarySend.body.raw, 'base64url').toString('utf8').includes(`From: <${primaryEmail}>`))
  assert.equal(interactionWrites[0].sourcePayload.senderEmail, primaryEmail)
  assert.equal(interactionWrites[0].sourcePayload.senderAccountEmail, primaryEmail)
}
reset(actionRow({ communication_identity_email: GMAIL_ACCOUNT }))
const staleAccountResult = await runtime.processCrmIntegrationAction(emailAction(), { maxAttempts: 1 })
assert.equal(staleAccountResult.status, 'dead')
assert.match(staleAccountResult.lastError, /queued Gmail account no longer matches its reviewed identity/)
assert.equal(providerRequests.some((request) => request.pathname.endsWith('/messages/send')), false)
assert.equal(interactionWrites.length, 0)
liveProfileEmail = GMAIL_ACCOUNT

credentialMode = 'missing'
aliasMode = 'accepted'
let invalidCampaign = campaignAction()
let missingCredentialResult = await runtime.processCrmIntegrationAction(invalidCampaign, { maxAttempts: 1 })
assert.equal(missingCredentialResult.status, 'dead')
assert.match(missingCredentialResult.lastError, /selected Gmail connection is unavailable/)
assert.equal(targetReads, 0, 'missing credentials must fail before campaign recipients are read')
assert.equal(recipientMutations, 0, 'missing credentials must fail before campaign recipients mutate')
assert.equal(childActionWrites.length, 0, 'missing credentials must fail before child actions are created')
assert.equal(interactionWrites.length, 0, 'missing credentials must fail before an interaction is staged')

credentialMode = 'available'
aliasMode = 'pending'
invalidCampaign = campaignAction()
const revokedAliasResult = await runtime.processCrmIntegrationAction(invalidCampaign, { maxAttempts: 1 })
assert.equal(revokedAliasResult.status, 'dead')
assert.match(revokedAliasResult.lastError, /no longer an accepted send-as identity/)
assert.equal(targetReads, 0, 'a revoked alias must fail before campaign recipients are read')
assert.equal(recipientMutations, 0, 'a revoked alias must fail before campaign recipients mutate')
assert.equal(childActionWrites.length, 0, 'a revoked alias must fail before child actions are created')
assert.equal(interactionWrites.length, 0, 'a revoked alias must fail before an interaction is staged')

credentialMode = 'available'
aliasMode = 'missing'
invalidCampaign = campaignAction()
const missingAliasResult = await runtime.processCrmIntegrationAction(invalidCampaign, { maxAttempts: 1 })
assert.equal(missingAliasResult.status, 'dead')
assert.match(missingAliasResult.lastError, /status 404/)
assert.equal(targetReads, 0, 'a missing alias must fail before campaign recipients are read')
assert.equal(recipientMutations, 0, 'a missing alias must fail before campaign recipients mutate')
assert.equal(childActionWrites.length, 0, 'a missing alias must fail before child actions are created')
assert.equal(interactionWrites.length, 0, 'a missing alias must fail before an interaction is staged')

credentialMode = 'available'
aliasMode = 'accepted'
const validCampaign = campaignAction()
const campaignResult = await runtime.processCrmIntegrationAction(validCampaign, { maxAttempts: 1 })
assert.equal(campaignResult.status, 'succeeded', campaignResult.lastError || 'valid campaign should fan out')
assert.equal(targetReads, 1)
assert.equal(childActionWrites.length, 2)
assert.equal(interactionWrites.length, 1)
for (const { child, parameters } of childActionWrites) {
  assert.equal(child.provider, 'maton')
  assert.equal(child.app, 'google-mail')
  assert.equal(child.action_type, 'send_email')
  assert.equal(parameters[10], communicationSnapshot.organizationId)
  assert.equal(parameters[11], communicationSnapshot.credentialOwnerEmail)
  assert.equal(parameters[12], communicationSnapshot.connectionId)
  assert.equal(parameters[13], communicationSnapshot.accountEmail)
  assert.equal(parameters[14], communicationSnapshot.identityEmail)
  assert.equal(parameters[15], communicationSnapshot.calendarId)
  assert.equal(parameters[16], communicationSnapshot.source)
}
assert.equal(interactionWrites[0].sourcePayload.senderEmail, SENDER_ALIAS)
assert.equal(interactionWrites[0].sourcePayload.senderAccountEmail, GMAIL_ACCOUNT)
assert.equal(interactionWrites[0].sourcePayload.communicationBindingSource, 'email-override')
assert.equal(campaignCountUpdates, 1)
assert.equal(providerRequests.filter((request) => request.pathname.endsWith('/messages/send')).length, 0)

console.log('CRM email sender selection tests passed')
