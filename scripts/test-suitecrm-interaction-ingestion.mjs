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
const listSuiteCrmNotesUpdatedSince = (...args) => globalThis.__suiteCrmInteractionTest.list(...args)
const stageCrmRecordInPostgres = (...args) => globalThis.__suiteCrmInteractionTest.stage(...args)
const query = (...args) => globalThis.__suiteCrmInteractionTest.query(...args)
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
  assert.equal(url.pathname, '/Api/V8/module/Notes')
  return jsonResponse({
    data: [{
      id: 'note-1',
      type: 'Note',
      attributes: { name: 'A note', date_modified: '2026-07-15T12:00:00Z' },
    }],
    meta: { 'total-pages': '3' },
  })
}

const listed = await client.listSuiteCrmNotesUpdatedSince({
  updatedSince: '2026-07-15T11:00:00Z',
  page: 2,
  pageSize: 50,
}, fetchImpl)
assert.equal(listed.totalPages, 3)
assert.deepEqual(listed.notes, [{
  id: 'note-1',
  attributes: { name: 'A note', date_modified: '2026-07-15T12:00:00Z' },
}])
assert.equal(clientCalls.length, 2)
assert.equal(clientCalls[0].url.pathname, '/Api/access_token')
assert.equal(clientCalls[1].url.searchParams.get('filter[date_modified][gte]'), '2026-07-15T11:00:00.000Z')
assert.equal(clientCalls[1].url.searchParams.get('page[number]'), '2')
assert.equal(clientCalls[1].url.searchParams.get('page[size]'), '50')
assert.equal(clientCalls[1].url.searchParams.get('sort'), 'date_modified')
await assert.rejects(
  client.listSuiteCrmNotesUpdatedSince({ updatedSince: 'not-a-date', page: 1 }, fetchImpl),
  /SuiteCRM note cursor is invalid/,
)

const ingestion = await importTypeScript(
  '../app_src/lib/crm/suiteCrmInteractionIngestion.ts',
  { injectRuntime: true },
)

assert.equal(ingestion.suiteCrmNoteGlobalId({
  id: 'note',
  attributes: { global_id_c: ' GI0000042 ' },
}), 'gi0000042')
assert.equal(ingestion.suiteCrmNoteGlobalId({
  id: 'note',
  attributes: { global_id_c: 'go0000042' },
}), null)
for (const type of ['Accounts', 'Contacts', 'Leads', 'Opportunities', 'Meetings']) {
  assert.deepEqual(
    ingestion.parseSuiteCrmNoteParent({ parent_type: type, parent_id: `${type}-id` }),
    { status: 'valid', parent: { type, id: `${type}-id` } },
  )
}
assert.deepEqual(ingestion.parseSuiteCrmNoteParent({}), { status: 'none' })
assert.deepEqual(
  ingestion.parseSuiteCrmNoteParent({ parent_type: 'Campaigns', parent_id: 'campaign-id' }),
  { status: 'invalid' },
)

function interactionRow(overrides = {}) {
  return {
    id: 'interaction-1',
    pipeline_id: 'pipeline-1',
    owner_email: 'owner@example.com',
    suitecrm_id: 'existing-note-id',
    reference_code: 'gi0000001',
    source_key: 'crm-action:1',
    source_sheet_id: 'sheet-1',
    source_row_number: 12,
    source_payload: { source: 'crm-integration-action', actionId: 'action-1' },
    organization_id: 'organization-old',
    contact_id: null,
    lead_id: null,
    opportunity_id: 'opportunity-old',
    meeting_id: null,
    campaign_id: 'campaign-1',
    interaction_type: 'email',
    subject: 'Existing subject',
    agent_name: 'owner@example.com',
    occurred_at: '2026-07-15T10:00:00.000Z',
    description: 'Existing description',
    direction: 'outbound',
    delivery_status: 'sent',
    provider_message_id: 'message-1',
    provider_thread_id: 'thread-1',
    metadata: { actionType: 'send_email' },
    ...overrides,
  }
}

const changedNote = {
  id: 'note-changed',
  attributes: {
    global_id_c: 'GI0000001',
    name: 'Updated &quot;subject&quot;',
    description: 'Updated description',
    date_entered: '2026-07-15T10:30:00Z',
    date_modified: '2026-07-15T11:30:00Z',
    parent_type: 'Contacts',
    parent_id: 'contact-suitecrm-id',
  },
}
const ambiguousIdentityNote = {
  id: 'note-ambiguous-identity',
  attributes: {
    global_id_c: 'gi0000002',
    name: 'Ambiguous',
    date_modified: '2026-07-15T11:31:00Z',
  },
}
const unmatchedNote = {
  id: 'note-unmatched',
  attributes: { name: 'Unmatched', date_modified: '2026-07-15T11:32:00Z' },
}
const deletedNote = {
  id: 'note-deleted',
  attributes: { deleted: '1', date_modified: '2026-07-15T11:33:00Z' },
}
const unresolvedParentNote = {
  id: 'note-unresolved-parent',
  attributes: {
    name: 'Existing subject',
    description: 'Existing description',
    date_entered: '2026-07-15T10:00:00Z',
    date_modified: '2026-07-15T11:34:00Z',
    parent_type: 'Campaigns',
    parent_id: 'campaign-suitecrm-id',
  },
}
const ambiguousParentNote = {
  id: 'note-ambiguous-parent',
  attributes: {
    name: 'Existing subject',
    description: 'Existing description',
    date_entered: '2026-07-15T10:00:00Z',
    date_modified: '2026-07-15T11:35:00Z',
    parent_type: 'Meetings',
    parent_id: 'meeting-suitecrm-id',
  },
}

const listCalls = []
const cursorWrites = []
const staged = []
globalThis.__suiteCrmInteractionTest = {
  list: async (input) => {
    listCalls.push(input)
    if (input.page === 1) {
      return {
        notes: [changedNote, ambiguousIdentityNote, unmatchedNote, deletedNote],
        totalPages: 2,
      }
    }
    return { notes: [unresolvedParentNote, ambiguousParentNote], totalPages: 2 }
  },
  stage: async (input) => {
    staged.push(input)
    return { id: input.localId, referenceCode: 'gi0000001' }
  },
  query: async (sql, parameters = []) => {
    if (sql.startsWith('SELECT value FROM app_settings')) return { rows: [] }
    if (sql.includes('INSERT INTO app_settings')) {
      cursorWrites.push(JSON.parse(parameters[1]))
      return { rows: [] }
    }
    if (sql.includes('FROM crm_interactions interaction')) {
      if (parameters[0] === changedNote.id) return { rows: [interactionRow()] }
      if (parameters[0] === ambiguousIdentityNote.id) {
        return {
          rows: [
            interactionRow({ id: 'ambiguous-1', pipeline_id: 'pipeline-2' }),
            interactionRow({ id: 'ambiguous-2', pipeline_id: 'pipeline-2' }),
          ],
        }
      }
      if (parameters[0] === unresolvedParentNote.id) {
        return { rows: [interactionRow({ id: 'interaction-2', suitecrm_id: unresolvedParentNote.id })] }
      }
      if (parameters[0] === ambiguousParentNote.id) {
        return { rows: [interactionRow({ id: 'interaction-3', suitecrm_id: ambiguousParentNote.id })] }
      }
      return { rows: [] }
    }
    if (sql.includes('FROM crm_contacts contact')) {
      return { rows: [{ relationship_id: 'contact-1', organization_id: 'organization-1' }] }
    }
    if (sql.includes('FROM crm_meetings meeting')) {
      return {
        rows: [
          { relationship_id: 'meeting-1', organization_id: 'organization-1' },
          { relationship_id: 'meeting-2', organization_id: 'organization-1' },
        ],
      }
    }
    throw new Error(`Unexpected query: ${sql}`)
  },
}

const counts = await ingestion.processSuiteCrmInteractionIngestion()
assert.deepEqual(counts, {
  pagesPolled: 2,
  notesListed: 6,
  notesMatched: 3,
  interactionsMatched: 3,
  interactionsStaged: 1,
  unchangedInteractions: 2,
  unmatchedNotes: 1,
  ambiguousInteractionMatches: 1,
  parentsResolved: 1,
  parentsUnresolved: 1,
  parentsAmbiguous: 1,
  deletedNotesIgnored: 1,
  pending: false,
  errors: 0,
})
assert.equal(listCalls[0].updatedSince, '1970-01-01T00:00:00.000Z')
assert.deepEqual(listCalls.map((call) => call.page), [1, 2])
assert.equal(cursorWrites.at(-1).state, null)
assert.equal(staged.length, 1)
assert.equal(staged[0].localId, 'interaction-1')
assert.equal(staged[0].sourceKey, 'crm-action:1')
assert.equal(staged[0].sourceSheetId, 'sheet-1')
assert.equal(staged[0].sourceRowNumber, 12)
assert.equal(staged[0].actorEmail, 'owner@example.com')
assert.equal(staged[0].emitSuiteCrmOutbox, false)
assert.equal(staged[0].sourcePayload.source, 'crm-integration-action')
assert.deepEqual(staged[0].sourcePayload.suiteCrmInbound, {
  module: 'Notes',
  id: 'note-changed',
  globalId: 'gi0000001',
  dateModified: '2026-07-15T11:30:00.000Z',
  matchedBy: 'global_id_c',
  parent: { type: 'Contacts', id: 'contact-suitecrm-id' },
  parentResolution: 'resolved',
})
assert.deepEqual(staged[0].fields, {
  organizationId: 'organization-1',
  contactId: 'contact-1',
  leadId: null,
  opportunityId: 'opportunity-old',
  meetingId: null,
  campaignId: 'campaign-1',
  parentSuiteCrmId: 'contact-suitecrm-id',
  parentSuiteCrmType: 'Contacts',
  interactionType: 'email',
  subject: 'Updated "subject"',
  agentName: 'owner@example.com',
  occurredAt: '2026-07-15T10:30:00.000Z',
  description: 'Updated description',
  direction: 'outbound',
  deliveryStatus: 'sent',
  providerMessageId: 'message-1',
  providerThreadId: 'thread-1',
  metadata: { actionType: 'send_email' },
})

const overlapCalls = []
globalThis.__suiteCrmInteractionTest = {
  list: async (input) => {
    overlapCalls.push(input)
    return { notes: [], totalPages: 1 }
  },
  stage: async () => {
    throw new Error('Overlap poll should not stage records')
  },
  query: async (sql, parameters = []) => {
    if (sql.startsWith('SELECT value FROM app_settings')) {
      return {
        rows: [{
          value: {
            state: null,
            lastPolledAt: '2026-07-15T12:00:00.000Z',
            lastError: null,
          },
        }],
      }
    }
    if (sql.includes('INSERT INTO app_settings')) return { rows: [], parameters }
    throw new Error(`Unexpected overlap query: ${sql}`)
  },
}

const overlapCounts = await ingestion.processSuiteCrmInteractionIngestion()
assert.equal(overlapCounts.errors, 0)
assert.equal(overlapCalls.length, 1)
assert.equal(overlapCalls[0].updatedSince, '2026-07-15T11:55:00.000Z')

console.log('SuiteCRM interaction ingestion tests passed')
