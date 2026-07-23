import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { decodeHtmlEntities } from '../app_src/lib/htmlEntities.mjs'

globalThis.__decodeHtmlEntities = decodeHtmlEntities

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')

async function importTypeScript(relativePath, { injectRuntime = false } = {}) {
  const url = new URL(relativePath, import.meta.url)
  const source = await readFile(url, 'utf8')
  let output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: url.pathname,
  }).outputText
  if (injectRuntime) {
    output = output.replace(/^import[^\n]+\n/gm, '')
    output = `
const listSuiteCrmCallsUpdatedSince = (...args) => globalThis.__suiteCrmCallTest.list(...args)
const stageCrmRecordInPostgres = (...args) => globalThis.__suiteCrmCallTest.stage(...args)
const archiveCrmRecordInPostgres = (...args) => globalThis.__suiteCrmCallTest.archive(...args)
const query = (...args) => globalThis.__suiteCrmCallTest.query(...args)
const decodeHtmlEntities = (value) => globalThis.__decodeHtmlEntities(value)
${output}`
  }
  const encoded = Buffer.from(output).toString('base64')
  return import(`data:text/javascript;base64,${encoded}`)
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

process.env.SUITECRM_BASE_URL = 'https://suitecrm.example.test'
process.env.SUITECRM_CLIENT_ID = 'client-id'
process.env.SUITECRM_CLIENT_SECRET = 'client-secret'

const client = await importTypeScript('../app_src/lib/crm/suiteCrmClient.ts')
const clientCalls = []
const fetchImpl = async (input, init) => {
  const url = new URL(String(input))
  clientCalls.push({ url, init })
  if (url.pathname === '/Api/access_token') {
    return jsonResponse({ access_token: 'token', expires_in: 3600 })
  }
  if (url.pathname === '/Api/V8/module/Calls') {
    return jsonResponse({
      data: [{
        id: 'call-1',
        type: 'Call',
        attributes: { name: 'A call', date_modified: '2026-07-23T12:00:00Z' },
      }],
      meta: { 'total-pages': '2' },
    })
  }
  if (init?.method === 'GET') return jsonResponse({}, 404)
  if (url.pathname === '/Api/V8/module' && (init?.method === 'POST' || init?.method === 'PATCH')) {
    const body = JSON.parse(String(init.body))
    return jsonResponse({ data: { id: body.data.id, type: body.data.type } })
  }
  if (init?.method === 'DELETE') return jsonResponse({})
  throw new Error(`Unexpected SuiteCRM request: ${init?.method} ${url.pathname}`)
}

const listed = await client.listSuiteCrmCallsUpdatedSince({
  updatedSince: '2026-07-23T11:00:00Z',
  page: 2,
  pageSize: 25,
}, fetchImpl)
assert.deepEqual(listed, {
  calls: [{
    id: 'call-1',
    attributes: { name: 'A call', date_modified: '2026-07-23T12:00:00Z' },
  }],
  totalPages: 2,
})
assert.equal(clientCalls[1].url.pathname, '/Api/V8/module/Calls')
assert.equal(clientCalls[1].url.searchParams.get('filter[date_modified][gte]'), '2026-07-23T11:00:00.000Z')
assert.equal(clientCalls[1].url.searchParams.get('page[number]'), '2')

function outboxRecord(overrides = {}) {
  return {
    entity: 'interactions',
    pipelineId: 'pipeline-1',
    localId: 'interaction-1',
    suiteCrmId: 'call-1',
    attributes: { name: 'A call' },
    ...overrides,
  }
}

await client.upsertSuiteCrmRecord(outboxRecord({ suiteCrmModule: 'Calls' }), fetchImpl)
assert.equal(clientCalls.at(-2).url.pathname, '/Api/V8/module/Calls/call-1')
assert.equal(JSON.parse(String(clientCalls.at(-1).init.body)).data.type, 'Calls')

await client.upsertSuiteCrmRecord(outboxRecord({ suiteCrmId: 'legacy-note-1' }), fetchImpl)
assert.equal(clientCalls.at(-2).url.pathname, '/Api/V8/module/Notes/legacy-note-1')
assert.equal(JSON.parse(String(clientCalls.at(-1).init.body)).data.type, 'Notes')

await client.upsertSuiteCrmRecord(outboxRecord({
  suiteCrmId: 'interaction-meeting-1',
  suiteCrmModule: 'Meetings',
}), fetchImpl)
assert.equal(clientCalls.at(-2).url.pathname, '/Api/V8/module/Meetings/interaction-meeting-1')
assert.equal(JSON.parse(String(clientCalls.at(-1).init.body)).data.type, 'Meetings')

await client.deleteSuiteCrmRecord(outboxRecord({ suiteCrmModule: 'Calls' }), fetchImpl)
assert.equal(clientCalls.at(-1).url.pathname, '/Api/V8/module/Calls/call-1')

await assert.rejects(
  client.upsertSuiteCrmRecord(outboxRecord({ suiteCrmModule: 'Tasks' }), fetchImpl),
  /SuiteCRM interaction module is invalid/,
)
await assert.rejects(
  client.deleteSuiteCrmRecord(outboxRecord({
    entity: 'organizations',
    suiteCrmModule: 'Calls',
  }), fetchImpl),
  /SuiteCRM record module does not match its entity/,
)

const ingestion = await importTypeScript(
  '../app_src/lib/crm/suiteCrmCallIngestion.ts',
  { injectRuntime: true },
)

assert.equal(ingestion.suiteCrmCallGlobalId({
  id: 'call',
  attributes: { global_id_c: ' GI0000042 ' },
}), 'gi0000042')
assert.equal(ingestion.suiteCrmCallGlobalId({
  id: 'call',
  attributes: { global_id_c: 'gm0000042' },
}), null)
assert.deepEqual(
  ingestion.parseSuiteCrmCallParent({ parent_type: 'Contacts', parent_id: 'contact-suitecrm-id' }),
  { status: 'valid', parent: { type: 'Contacts', id: 'contact-suitecrm-id' } },
)
assert.deepEqual(
  ingestion.parseSuiteCrmCallParent({ parent_type: 'Campaigns', parent_id: 'campaign-suitecrm-id' }),
  { status: 'invalid' },
)

function interactionRow(overrides = {}) {
  return {
    id: 'interaction-1',
    pipeline_id: 'pipeline-1',
    owner_email: 'owner@example.com',
    suitecrm_id: 'legacy-note-id',
    reference_code: 'gi0000001',
    source_key: 'crm-action:1',
    source_sheet_id: 'sheet-1',
    source_row_number: 12,
    source_payload: { source: 'crm-integration-action', actionId: 'action-1' },
    organization_id: 'organization-old',
    contact_id: null,
    contact_ids: [],
    lead_id: null,
    opportunity_id: 'opportunity-old',
    meeting_id: null,
    campaign_id: null,
    interaction_type: 'call',
    suitecrm_module: 'Notes',
    subject: 'Existing call',
    agent_email: 'owner@example.com',
    agent_name: 'Owner',
    occurred_at: '2026-07-23T10:00:00.000Z',
    description: 'Existing description',
    direction: 'outbound',
    activity_status: 'held',
    duration_minutes: 30,
    delivery_status: 'logged',
    provider_message_id: null,
    provider_thread_id: null,
    metadata: { actionType: 'log_call' },
    ...overrides,
  }
}

const changedCall = {
  id: 'native-call-1',
  attributes: {
    global_id_c: 'GI0000001',
    name: 'Updated &quot;call&quot;',
    description: 'Updated notes',
    date_start: '2026-07-24T09:15:00Z',
    date_modified: '2026-07-23T11:30:00Z',
    duration_hours: 1,
    duration_minutes: 15,
    direction: 'Inbound',
    status: 'Planned',
    parent_type: 'Contacts',
    parent_id: 'contact-suitecrm-id',
  },
}
const deletedCall = {
  id: 'native-call-deleted',
  attributes: {
    global_id_c: 'gi0000002',
    deleted: '1',
    date_modified: '2026-07-23T11:31:00Z',
  },
}
const unmatchedCall = {
  id: 'native-call-unmatched',
  attributes: {
    global_id_c: 'gi0000003',
    date_modified: '2026-07-23T11:32:00Z',
  },
}

const listCalls = []
const cursorWrites = []
const staged = []
const archived = []
globalThis.__suiteCrmCallTest = {
  list: async (input) => {
    listCalls.push(input)
    return { calls: [changedCall, deletedCall, unmatchedCall], totalPages: 1 }
  },
  stage: async (input) => {
    staged.push(input)
    return { id: input.localId, referenceCode: 'gi0000001' }
  },
  archive: async (input) => {
    archived.push(input)
    return { archived: true, changed: true, referenceCode: 'gi0000002' }
  },
  query: async (sql, parameters = []) => {
    if (sql.startsWith('SELECT value FROM app_settings')) return { rows: [] }
    if (sql.includes('INSERT INTO app_settings')) {
      cursorWrites.push(JSON.parse(parameters[1]))
      return { rows: [] }
    }
    if (sql.includes('FROM crm_interactions interaction')) {
      if (parameters[0] === changedCall.id) return { rows: [interactionRow()] }
      if (parameters[0] === deletedCall.id) {
        return {
          rows: [interactionRow({
            id: 'interaction-deleted',
            suitecrm_id: deletedCall.id,
            reference_code: 'gi0000002',
          })],
        }
      }
      return { rows: [] }
    }
    if (sql.includes('FROM crm_contacts contact')) {
      return { rows: [{ relationship_id: 'contact-1', organization_id: 'organization-1' }] }
    }
    throw new Error(`Unexpected query: ${sql}`)
  },
}

const counts = await ingestion.processSuiteCrmCallIngestion()
assert.deepEqual(counts, {
  pagesPolled: 1,
  callsListed: 3,
  callsMatched: 2,
  interactionsMatched: 2,
  interactionsStaged: 1,
  unchangedInteractions: 0,
  unmatchedCalls: 1,
  ambiguousInteractionMatches: 0,
  parentsResolved: 1,
  parentsUnresolved: 0,
  parentsAmbiguous: 0,
  interactionsArchived: 1,
  deletedCallsIgnored: 0,
  pending: false,
  errors: 0,
})
assert.equal(listCalls[0].updatedSince, '1970-01-01T00:00:00.000Z')
assert.equal(cursorWrites.at(-1).state, null)
assert.equal(staged.length, 1)
assert.equal(staged[0].emitSuiteCrmOutbox, false)
assert.equal(staged[0].sourcePayload.source, 'crm-integration-action')
assert.deepEqual(staged[0].sourcePayload.suiteCrmInbound, {
  module: 'Calls',
  id: 'native-call-1',
  globalId: 'gi0000001',
  dateModified: '2026-07-23T11:30:00.000Z',
  matchedBy: 'global_id_c',
  parent: { type: 'Contacts', id: 'contact-suitecrm-id' },
  parentResolution: 'resolved',
})
assert.deepEqual(staged[0].fields, {
  organizationId: 'organization-1',
  contactId: 'contact-1',
  contactIds: ['contact-1'],
  leadId: null,
  opportunityId: 'opportunity-old',
  meetingId: null,
  campaignId: null,
  parentSuiteCrmId: 'contact-suitecrm-id',
  parentSuiteCrmType: 'Contacts',
  interactionType: 'call',
  suiteCrmModule: 'Calls',
  subject: 'Updated "call"',
  agentEmail: 'owner@example.com',
  agentName: 'Owner',
  occurredAt: '2026-07-24T09:15:00.000Z',
  description: 'Updated notes',
  direction: 'inbound',
  activityStatus: 'planned',
  durationMinutes: 75,
  deliveryStatus: 'planned',
  providerMessageId: null,
  providerThreadId: null,
  metadata: { actionType: 'log_call' },
})
assert.deepEqual(archived, [{
  pipelineId: 'pipeline-1',
  entity: 'interactions',
  id: 'interaction-deleted',
  actorEmail: 'owner@example.com',
  emitSuiteCrmOutbox: false,
  archiveSource: 'suitecrm',
}])

const overlapCalls = []
globalThis.__suiteCrmCallTest = {
  list: async (input) => {
    overlapCalls.push(input)
    return { calls: [], totalPages: 1 }
  },
  stage: async () => {
    throw new Error('Overlap poll should not stage records')
  },
  archive: async () => {
    throw new Error('Overlap poll should not archive records')
  },
  query: async (sql) => {
    if (sql.startsWith('SELECT value FROM app_settings')) {
      return {
        rows: [{
          value: {
            state: null,
            lastPolledAt: '2026-07-23T12:00:00.000Z',
            lastError: null,
          },
        }],
      }
    }
    if (sql.includes('INSERT INTO app_settings')) return { rows: [] }
    throw new Error(`Unexpected overlap query: ${sql}`)
  },
}

const overlapCounts = await ingestion.processSuiteCrmCallIngestion()
assert.equal(overlapCounts.errors, 0)
assert.equal(overlapCalls.length, 1)
assert.equal(overlapCalls[0].updatedSince, '2026-07-23T11:55:00.000Z')

console.log('SuiteCRM native Calls transport and ingestion tests passed')
