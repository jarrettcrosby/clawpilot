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
const MEETING_ID = '44444444-4444-4444-8444-444444444444'
const ACTION_ID = '55555555-5555-4555-8555-555555555555'
const ACTOR_EMAIL = 'operator@suburbiasandwichco.com'
const CREDENTIAL_OWNER_EMAIL = 'jarrett@suburbiasandwichco.com'
const ORGANIZER_EMAIL = 'jarrett@bposupplychain.com'
const SECONDARY_CALENDAR_EMAIL = 'warehouse@bposupplychain.com'
const CONNECTION_ID = 'calendar-connection'
const PERSONAL_CONNECTION_ID = 'personal-calendar-connection'
const PREVIOUS_OWNER_EMAIL = 'calendar-owner@legacy.example.com'
const PREVIOUS_CONNECTION_ID = 'previous-calendar-connection'
const PREVIOUS_CALENDAR_EMAIL = 'legacy-calendar@example.com'
const CONTACT_REFERENCE = 'gc1234567'
const MEETING_REFERENCE = 'gm1234567'
const MEETING_ALIAS_REFERENCE = 'gm7654321'

const communicationSnapshot = {
  organizationId: ORGANIZATION_ID,
  credentialOwnerEmail: CREDENTIAL_OWNER_EMAIL,
  connectionId: CONNECTION_ID,
  accountEmail: CREDENTIAL_OWNER_EMAIL,
  identityEmail: ORGANIZER_EMAIL,
  calendarId: 'primary',
  source: 'organization',
}

const contactTarget = {
  entity: 'contacts',
  id: CONTACT_ID,
  referenceCode: CONTACT_REFERENCE,
  name: 'Calendar Recipient',
  email: 'recipient@example.com',
  emailOptOut: false,
  phone: null,
  organizationId: null,
  suiteCrmId: null,
}

function actionRow(overrides = {}) {
  return {
    id: ACTION_ID,
    pipeline_id: PIPELINE_ID,
    actor_email: ACTOR_EMAIL,
    provider: 'maton',
    app: 'google-calendar',
    action_type: 'create_calendar_event',
    aggregate_type: 'crm_contact',
    aggregate_id: CONTACT_ID,
    reference_code: CONTACT_REFERENCE,
    payload: {},
    status: 'queued',
    attempts: 0,
    available_at: new Date('2026-09-02T12:00:00.000Z'),
    locked_at: null,
    lock_token: null,
    external_id: null,
    response_summary: {},
    last_error: null,
    idempotency_key: 'calendar-action-test',
    workspace_organization_id: ORGANIZATION_ID,
    communication_credential_owner_email: CREDENTIAL_OWNER_EMAIL,
    communication_connection_id: CONNECTION_ID,
    communication_account_email: CREDENTIAL_OWNER_EMAIL,
    communication_identity_email: ORGANIZER_EMAIL,
    communication_calendar_id: 'primary',
    communication_binding_source: 'organization',
    processed_at: null,
    created_at: new Date('2026-09-02T12:00:00.000Z'),
    updated_at: new Date('2026-09-02T12:00:00.000Z'),
    ...overrides,
  }
}

const commonMocks = {
  '@/lib/globalIds.mjs': {
    GLOBAL_ID_MAX_LENGTH: 64,
    globalIdFragment,
    globalIdPattern,
  },
  '@/lib/users': { normalizeUserEmail },
  '@/lib/tenancy': {
    listPipelineSpaces: async (_actor, options) => {
      assert.equal(options.ensureDefaults, false)
      return [{ id: PIPELINE_ID, accessRole: 'editor' }]
    },
    requireResourceEditor: (pipeline) => {
      if (pipeline.accessRole === 'viewer') throw new Error('This resource is view-only')
    },
  },
  '@/lib/zonedDateTime': {
    zonedDateTimeToIso(value) {
      const parsed = new Date(String(value || ''))
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
    },
  },
}

let resolutionFailure = null
let resolutionCalls = 0
let insertedParameters = null
let preparedExistingAction = null
let preparedTargetReads = 0
let preparedMeetingTarget = {
  ...contactTarget,
  entity: 'meetings',
  id: MEETING_ID,
  referenceCode: MEETING_REFERENCE,
  shortUrl: 'https://clawpilot.example/m/gm1234567',
  externalEventId: null,
  sourcePayload: {},
}
const prepareClient = {
  async query(sql, parameters = []) {
    if (sql.includes('INSERT INTO audit_events')) return { rows: [], rowCount: 1 }
    if (!sql.includes('WITH inserted AS')) throw new Error(`unexpected prepare SQL: ${sql.slice(0, 80)}`)
    insertedParameters = parameters
    return {
      rows: [actionRow({
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
        created: true,
        matches_intent: true,
      })],
      rowCount: 1,
    }
  },
}

const prepareRuntime = loadTypeScriptModule('app_src/lib/crm/integrationActions.ts', {
  ...commonMocks,
  '@/lib/integrations/matonGatewayCredentials': {
    resolveUserMatonGatewayCredential: async () => { throw new Error('not expected') },
  },
  '@/lib/maton': { matonFetch: async () => { throw new Error('not expected') } },
  '@/lib/persistence/crm': {
    readCrmRecordByReference: async ({ referenceCode }) => {
      preparedTargetReads += 1
      return referenceCode === MEETING_REFERENCE ? preparedMeetingTarget : contactTarget
    },
    resolveCrmReferenceCode: async (value) => value,
    stageCrmRecordWithClient: async () => { throw new Error('not expected') },
    stageCrmRecordInPostgres: async () => { throw new Error('not expected') },
  },
  '@/lib/persistence/organizationCommunications': {
    OrganizationCommunicationPersistenceError,
    resolvePipelineCommunicationScopeInPostgres: async () => ({ organizationId: ORGANIZATION_ID }),
    resolvePipelineCommunicationSnapshotInPostgres: async () => {
      resolutionCalls += 1
      if (resolutionFailure) throw resolutionFailure
      return communicationSnapshot
    },
  },
  '@/lib/persistence/postgres': {
    query: async (sql, parameters = []) => {
      if (sql.includes('FROM crm_meetings') && sql.includes('source_hash')) {
        return preparedExistingAction
          ? {
              rows: [{
                id: MEETING_ID,
                suitecrm_id: 'suitecrm-meeting-id',
                reference_code: MEETING_REFERENCE,
                source_hash: 'meeting-source-hash',
              }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM crm_integration_actions') && sql.includes('idempotency_key')) {
        const scopedReplay = sql.includes('pipeline_id = $2::uuid')
        const scopeMatches = !scopedReplay || (
          preparedExistingAction?.actor_email === parameters[0]
          && preparedExistingAction?.pipeline_id === parameters[1]
        )
        const rows = preparedExistingAction && scopeMatches ? [preparedExistingAction] : []
        return { rows, rowCount: rows.length }
      }
      return { rows: [], rowCount: 0 }
    },
    withTransaction: async (work) => work(prepareClient),
  },
})

const baseCalendarPayload = {
  subject: 'BPO discovery',
  startsAt: '2026-09-03T14:00:00.000Z',
  endsAt: '2026-09-03T14:30:00.000Z',
  timezone: 'America/New_York',
}

resolutionFailure = new OrganizationCommunicationPersistenceError(
  'missing',
  409,
  'ORGANIZATION_COMMUNICATION_CONNECTION_REQUIRED',
)
await assert.rejects(
  prepareRuntime.enqueueCrmIntegrationAction({
    pipelineId: PIPELINE_ID,
    actorEmail: ACTOR_EMAIL,
    actionType: 'create_calendar_event',
    referenceCode: CONTACT_REFERENCE,
    payload: baseCalendarPayload,
  }),
  (error) => error?.code === 'CRM_COMMUNICATION_CONNECTION_REQUIRED',
)

const transientResolutionError = new Error('organization communication database unavailable')
resolutionFailure = transientResolutionError
await assert.rejects(
  prepareRuntime.enqueueCrmIntegrationAction({
    pipelineId: PIPELINE_ID,
    actorEmail: ACTOR_EMAIL,
    actionType: 'create_calendar_event',
    referenceCode: CONTACT_REFERENCE,
    payload: baseCalendarPayload,
  }),
  (error) => error === transientResolutionError,
  'transient communication resolution errors must not be rewritten as missing connections',
)

resolutionFailure = new OrganizationCommunicationPersistenceError(
  'binding invalid',
  409,
  'ORGANIZATION_COMMUNICATION_BINDING_INVALID',
)
await assert.rejects(
  prepareRuntime.enqueueCrmIntegrationAction({
    pipelineId: PIPELINE_ID,
    actorEmail: ACTOR_EMAIL,
    actionType: 'create_calendar_event',
    referenceCode: CONTACT_REFERENCE,
    payload: baseCalendarPayload,
  }),
  (error) => error?.code === 'ORGANIZATION_COMMUNICATION_BINDING_INVALID',
)

resolutionFailure = null
await prepareRuntime.enqueueCrmIntegrationAction({
  pipelineId: PIPELINE_ID,
  actorEmail: ACTOR_EMAIL,
  actionType: 'create_calendar_event',
  referenceCode: CONTACT_REFERENCE,
  payload: baseCalendarPayload,
  idempotencyKey: 'prepare-owner-snapshot',
})
assert.equal(insertedParameters[11], CREDENTIAL_OWNER_EMAIL)
assert.equal(JSON.parse(insertedParameters[8]).meetingMode, 'google_meet')

const mutableMeetingRequest = {
  pipelineId: PIPELINE_ID,
  actorEmail: ACTOR_EMAIL,
  actionType: 'create_calendar_event',
  referenceCode: MEETING_REFERENCE,
  payload: baseCalendarPayload,
  idempotencyKey: 'calendar-action-lost-response-replay',
}
const initiallyQueuedMeeting = await prepareRuntime.enqueueCrmIntegrationAction(mutableMeetingRequest)
const queuedMeetingPayload = JSON.parse(insertedParameters[8])
preparedExistingAction = actionRow({
  id: initiallyQueuedMeeting.action.id,
  aggregate_type: 'crm_meeting',
  aggregate_id: MEETING_ID,
  reference_code: MEETING_REFERENCE,
  payload: queuedMeetingPayload,
  idempotency_key: mutableMeetingRequest.idempotencyKey,
  status: 'succeeded',
  external_id: 'provider-event-id',
  response_summary: { eventId: 'provider-event-id' },
})
preparedMeetingTarget = {
  ...preparedMeetingTarget,
  externalEventId: 'provider-event-id',
  sourcePayload: {
    calendarOwnerEmail: CREDENTIAL_OWNER_EMAIL,
    calendarConnectionId: CONNECTION_ID,
    calendarId: 'primary',
    calendarOrganizerEmail: ORGANIZER_EMAIL,
  },
}
const readsBeforeLostResponseReplay = preparedTargetReads
const resolutionsBeforeLostResponseReplay = resolutionCalls
const lostResponseReplay = await prepareRuntime.enqueueCrmIntegrationAction(mutableMeetingRequest)
assert.equal(lostResponseReplay.created, false)
assert.equal(lostResponseReplay.action.id, initiallyQueuedMeeting.action.id)
assert.equal(
  preparedTargetReads,
  readsBeforeLostResponseReplay,
  'same-key replay must return before mutable provider-enriched meeting evidence is re-derived',
)
assert.equal(
  resolutionCalls,
  resolutionsBeforeLostResponseReplay,
  'same-key replay must not re-resolve a potentially changed organization default',
)
await assert.rejects(
  prepareRuntime.enqueueCrmIntegrationAction({
    ...mutableMeetingRequest,
    payload: { ...baseCalendarPayload, subject: 'Different calendar action intent' },
  }),
  (error) => error?.code === 'CRM_ACTION_IDEMPOTENCY_CONFLICT',
)

const routeClientIntent = {
  contract: 'crm-calendar-action-v1',
  pipelineId: PIPELINE_ID,
  actorEmail: ACTOR_EMAIL,
  actionType: 'create_calendar_event',
  referenceCode: MEETING_REFERENCE,
  payload: baseCalendarPayload,
  calendarSelection: null,
}
const routeClientRequestHash = prepareRuntime.crmIntegrationClientRequestHash(routeClientIntent)
assert.equal(
  routeClientRequestHash,
  prepareRuntime.crmIntegrationClientRequestHash({
    calendarSelection: null,
    payload: baseCalendarPayload,
    referenceCode: MEETING_REFERENCE,
    actionType: 'create_calendar_event',
    actorEmail: ACTOR_EMAIL,
    pipelineId: PIPELINE_ID,
    contract: 'crm-calendar-action-v1',
  }),
  'client request hashing must be independent of JSON object key order',
)
preparedExistingAction = actionRow({
  aggregate_type: 'crm_meeting',
  aggregate_id: MEETING_ID,
  reference_code: MEETING_REFERENCE,
  payload: { ...queuedMeetingPayload, _clientRequestHash: routeClientRequestHash },
  idempotency_key: mutableMeetingRequest.idempotencyKey,
  status: 'succeeded',
  external_id: 'provider-event-id',
  response_summary: { eventId: 'provider-event-id' },
})
const routeReplay = await prepareRuntime.replayCrmIntegrationActionByIdempotencyKey({
  pipelineId: PIPELINE_ID,
  actorEmail: ACTOR_EMAIL,
  actionType: 'create_calendar_event',
  referenceCode: MEETING_REFERENCE,
  idempotencyKey: mutableMeetingRequest.idempotencyKey,
  clientRequestHash: routeClientRequestHash,
})
assert.equal(routeReplay.action.id, ACTION_ID)
assert.equal(routeReplay.aggregateId, MEETING_ID)
const canonicalReplayRow = preparedExistingAction
const aliasRouteClientRequestHash = prepareRuntime.crmIntegrationClientRequestHash({
  ...routeClientIntent,
  referenceCode: MEETING_ALIAS_REFERENCE,
})
preparedExistingAction = actionRow({
  aggregate_type: 'crm_meeting',
  aggregate_id: MEETING_ID,
  reference_code: MEETING_REFERENCE,
  payload: { ...queuedMeetingPayload, _clientRequestHash: aliasRouteClientRequestHash },
  idempotency_key: mutableMeetingRequest.idempotencyKey,
  status: 'succeeded',
  external_id: 'provider-event-id',
  response_summary: { eventId: 'provider-event-id' },
})
const aliasRouteReplay = await prepareRuntime.replayCrmIntegrationActionByIdempotencyKey({
  pipelineId: PIPELINE_ID,
  actorEmail: ACTOR_EMAIL,
  actionType: 'create_calendar_event',
  referenceCode: MEETING_ALIAS_REFERENCE,
  idempotencyKey: mutableMeetingRequest.idempotencyKey,
  clientRequestHash: aliasRouteClientRequestHash,
})
assert.equal(aliasRouteReplay.action.id, ACTION_ID)
assert.equal(aliasRouteReplay.referenceCode, MEETING_REFERENCE)
preparedExistingAction = canonicalReplayRow
await assert.rejects(
  prepareRuntime.replayCrmIntegrationActionByIdempotencyKey({
    pipelineId: PIPELINE_ID,
    actorEmail: ACTOR_EMAIL,
    actionType: 'create_calendar_event',
    referenceCode: MEETING_REFERENCE,
    idempotencyKey: mutableMeetingRequest.idempotencyKey,
    clientRequestHash: prepareRuntime.crmIntegrationClientRequestHash({
      ...routeClientIntent,
      payload: { ...baseCalendarPayload, subject: 'Changed retry payload' },
    }),
  }),
  (error) => error?.code === 'CRM_ACTION_IDEMPOTENCY_CONFLICT',
  'a same-key replay with different immutable client intent must conflict',
)
assert.equal(
  await prepareRuntime.replayCrmIntegrationActionByIdempotencyKey({
    pipelineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    actorEmail: ACTOR_EMAIL,
    actionType: 'create_calendar_event',
    referenceCode: MEETING_REFERENCE,
    idempotencyKey: mutableMeetingRequest.idempotencyKey,
    clientRequestHash: routeClientRequestHash,
  }),
  null,
  'an action key in another pipeline must not be observable',
)
assert.equal(
  await prepareRuntime.replayCrmIntegrationActionByIdempotencyKey({
    pipelineId: PIPELINE_ID,
    actorEmail: 'another-actor@example.com',
    actionType: 'create_calendar_event',
    referenceCode: MEETING_REFERENCE,
    idempotencyKey: mutableMeetingRequest.idempotencyKey,
    clientRequestHash: routeClientRequestHash,
  }),
  null,
  'an action key owned by another actor must not be observable',
)

const nativeMeetingRequestHash = prepareRuntime.crmIntegrationClientRequestHash({
  contract: 'crm-meeting-save-v1',
  pipelineId: PIPELINE_ID,
  actorEmail: ACTOR_EMAIL,
  entity: 'meetings',
  id: null,
  fields: { subject: 'BPO discovery' },
})
const nativeMeetingActionKey = 'crm:meeting-calendar:native-lost-response'
preparedExistingAction = actionRow({
  aggregate_type: 'crm_meeting',
  aggregate_id: MEETING_ID,
  reference_code: MEETING_REFERENCE,
  payload: { ...queuedMeetingPayload, _clientRequestHash: nativeMeetingRequestHash },
  idempotency_key: nativeMeetingActionKey,
  status: 'succeeded',
  external_id: 'provider-event-id',
})
const nativeMeetingReplay = await prepareRuntime.replayCrmMeetingSaveByIdempotencyKey({
  pipelineId: PIPELINE_ID,
  actorEmail: ACTOR_EMAIL,
  idempotencyKey: nativeMeetingActionKey,
  clientRequestHash: nativeMeetingRequestHash,
})
assert.equal(nativeMeetingReplay.created, false)
assert.equal(nativeMeetingReplay.reused, true)
assert.equal(nativeMeetingReplay.staged.id, MEETING_ID)
assert.equal(nativeMeetingReplay.staged.referenceCode, MEETING_REFERENCE)
assert.equal(nativeMeetingReplay.staged.shortUrl, 'https://clawpilot.example/m/gm1234567')
preparedExistingAction = null

const resolutionCallsBeforeOverride = resolutionCalls
const reviewedMeetingSelection = {
  organizationId: ORGANIZATION_ID,
  credentialOwnerEmail: ACTOR_EMAIL,
  connectionId: 'personal-calendar-connection',
  accountEmail: ACTOR_EMAIL,
  identityEmail: ACTOR_EMAIL,
  calendarId: ACTOR_EMAIL,
  source: 'meeting-override',
}
await prepareRuntime.enqueueCrmIntegrationAction({
  pipelineId: PIPELINE_ID,
  actorEmail: ACTOR_EMAIL,
  actionType: 'create_calendar_event',
  referenceCode: CONTACT_REFERENCE,
  payload: baseCalendarPayload,
  idempotencyKey: 'prepare-reviewed-calendar-override',
  communicationOverride: reviewedMeetingSelection,
})
assert.equal(
  resolutionCalls,
  resolutionCallsBeforeOverride,
  'a provider-verified per-meeting selection must be snapshotted without rebinding the organization default',
)
assert.equal(insertedParameters[10], ORGANIZATION_ID)
assert.equal(insertedParameters[11], ACTOR_EMAIL)
assert.equal(insertedParameters[12], 'personal-calendar-connection')
assert.equal(insertedParameters[13], ACTOR_EMAIL)
assert.equal(insertedParameters[14], ACTOR_EMAIL)
assert.equal(insertedParameters[15], ACTOR_EMAIL)
assert.equal(insertedParameters[16], 'meeting-override')

await assert.rejects(
  prepareRuntime.enqueueCrmIntegrationAction({
    pipelineId: PIPELINE_ID,
    actorEmail: ACTOR_EMAIL,
    actionType: 'create_calendar_event',
    referenceCode: CONTACT_REFERENCE,
    payload: baseCalendarPayload,
    communicationOverride: {
      ...reviewedMeetingSelection,
      credentialOwnerEmail: 'another-actor@example.com',
    },
  }),
  (error) => error?.code === 'CRM_CALENDAR_SELECTION_FORBIDDEN',
  'the action layer must reject a Calendar snapshot owned by another actor',
)

await assert.rejects(
  prepareRuntime.enqueueCrmIntegrationAction({
    pipelineId: PIPELINE_ID,
    actorEmail: ACTOR_EMAIL,
    actionType: 'create_calendar_event',
    referenceCode: CONTACT_REFERENCE,
    payload: { ...baseCalendarPayload, meetingMode: 'in_person' },
  }),
  /requires a location/,
)
await assert.rejects(
  prepareRuntime.enqueueCrmIntegrationAction({
    pipelineId: PIPELINE_ID,
    actorEmail: ACTOR_EMAIL,
    actionType: 'create_calendar_event',
    referenceCode: CONTACT_REFERENCE,
    payload: { ...baseCalendarPayload, meetingMode: 'custom_link', customJoinUrl: 'http://unsafe.example.com' },
  }),
  /valid HTTPS meeting URL/,
)

let atomicAction = null
let atomicStageCalls = 0
let atomicInsideTransaction = false
let atomicRequestLockAcquired = false
const atomicClient = {
  async query(sql, parameters = []) {
    if (sql.includes('pg_advisory_xact_lock')) {
      assert.match(parameters[0], /^crm-meeting-save:/)
      atomicRequestLockAcquired = true
      return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 }
    }
    if (sql.includes('WHERE actor_email = $1 AND idempotency_key = $2') && sql.includes('FOR UPDATE')) {
      return { rows: atomicAction ? [atomicAction] : [], rowCount: atomicAction ? 1 : 0 }
    }
    if (sql.includes('WITH inserted AS')) {
      atomicAction = actionRow({
        actor_email: parameters[1], provider: parameters[2], app: parameters[3], action_type: parameters[4],
        aggregate_type: parameters[5], aggregate_id: parameters[6], reference_code: parameters[7],
        payload: JSON.parse(parameters[8]), idempotency_key: parameters[9],
        workspace_organization_id: parameters[10], communication_credential_owner_email: parameters[11],
        communication_connection_id: parameters[12], communication_account_email: parameters[13],
        communication_identity_email: parameters[14], communication_calendar_id: parameters[15],
        communication_binding_source: parameters[16], created: true, matches_intent: true,
      })
      return { rows: [atomicAction], rowCount: 1 }
    }
    if (sql.includes('SELECT id::text, suitecrm_id, reference_code, source_hash')) {
      return { rows: [{ id: MEETING_ID, suitecrm_id: 'suitecrm-meeting-id', reference_code: MEETING_REFERENCE, source_hash: 'meeting-source-hash' }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO audit_events')) return { rows: [], rowCount: 1 }
    throw new Error(`unexpected atomic SQL: ${sql.slice(0, 100)}`)
  },
}
const atomicRuntime = loadTypeScriptModule('app_src/lib/crm/integrationActions.ts', {
  ...commonMocks,
  '@/lib/integrations/matonGatewayCredentials': { resolveUserMatonGatewayCredential: async () => { throw new Error('not expected') } },
  '@/lib/maton': { matonFetch: async () => { throw new Error('not expected') } },
  '@/lib/persistence/crm': {
    readCrmRecordByReference: async () => ({
      ...contactTarget,
      entity: 'meetings',
      id: MEETING_ID,
      referenceCode: MEETING_REFERENCE,
      shortUrl: 'https://clawpilot.example/m/gm1234567',
    }),
    resolveCrmReferenceCode: async (value) => value,
    stageCrmRecordWithClient: async (_client, input) => {
      assert.equal(atomicInsideTransaction, true, 'meeting staging must run inside the Calendar-action transaction')
      assert.equal(atomicRequestLockAcquired, true, 'concurrent retries must serialize before meeting staging')
      atomicStageCalls += 1
      assert.equal(input.entity, 'meetings')
      return {
        id: MEETING_ID,
        suiteCrmId: 'suitecrm-meeting-id',
        referenceCode: MEETING_REFERENCE,
        shortUrl: 'https://clawpilot.example/m/gm1234567',
        sourceHash: 'meeting-source-hash',
      }
    },
    stageCrmRecordInPostgres: async () => { throw new Error('not expected') },
  },
  '@/lib/persistence/organizationCommunications': {
    OrganizationCommunicationPersistenceError,
    resolvePipelineCommunicationSnapshotInPostgres: async () => communicationSnapshot,
  },
  '@/lib/persistence/postgres': {
    query: async () => ({ rows: [], rowCount: 0 }),
    withTransaction: async (work) => {
      atomicInsideTransaction = true
      try { return await work(atomicClient) } finally { atomicInsideTransaction = false }
    },
  },
})
const atomicStageInput = {
  entity: 'meetings', pipelineId: PIPELINE_ID, sourceKey: 'crm:meeting-record:durable-request', actorEmail: ACTOR_EMAIL,
  sourcePayload: { source: 'clawpilot' },
  fields: {
    contactId: CONTACT_ID, subject: 'BPO discovery', startsAt: baseCalendarPayload.startsAt,
    endsAt: baseCalendarPayload.endsAt, timezone: baseCalendarPayload.timezone,
    attendeeEmails: ['recipient@example.com'], status: 'planned',
  },
}
const durableRequest = {
  stageInput: atomicStageInput,
  payload: { ...baseCalendarPayload, attendeeEmails: ['recipient@example.com'] },
  idempotencyKey: 'crm:meeting-calendar:durable-request',
  communication: communicationSnapshot,
}
const firstAtomicSave = await atomicRuntime.stageCrmMeetingAndEnqueueCalendarAction(durableRequest)
assert.equal(firstAtomicSave.created, true)
assert.equal(atomicStageCalls, 1)
atomicAction = actionRow({
  ...atomicAction,
  status: 'succeeded', external_id: 'delivered-event-id', response_summary: { eventId: 'delivered-event-id' },
})
const replayedAtomicSave = await atomicRuntime.stageCrmMeetingAndEnqueueCalendarAction(durableRequest)
assert.equal(replayedAtomicSave.created, false)
assert.equal(replayedAtomicSave.reused, true)
assert.equal(replayedAtomicSave.action.id, firstAtomicSave.action.id)
assert.equal(atomicStageCalls, 1, 'a retry after a lost response must not restage or duplicate the meeting')
await assert.rejects(
  atomicRuntime.stageCrmMeetingAndEnqueueCalendarAction({
    ...durableRequest,
    payload: { ...durableRequest.payload, subject: 'Different meeting intent' },
  }),
  (error) => error?.code === 'CRM_ACTION_IDEMPOTENCY_CONFLICT',
  'reusing a meeting-save key for a different request must fail closed',
)

let providerResult = 'success'
let existingCalendarEvent = null
let currentRow = actionRow()
let stageCalls = []
let providerRequests = []
let terminalMeetingFailure = null
let retryUpdate = null
let retryMeetingUpdate = null
let joinUrlClearCount = 0
let communicationScopeFailure = null
let activeCommunicationSnapshot = communicationSnapshot

const processQuery = async (sql, parameters = []) => {
  if (sql.includes('SELECT organization_id::text, contact_id::text, lead_id::text')) {
    return {
      rows: [{
        organization_id: null,
        contact_id: CONTACT_ID,
        lead_id: null,
        opportunity_id: null,
        source_key: `crm-action:${ACTION_ID}:meeting`,
        source_payload: stageCalls[0]?.sourcePayload || {},
      }],
      rowCount: 1,
    }
  }
  if (sql.includes('SELECT suitecrm_id FROM crm_contacts')) {
    return { rows: [{ suitecrm_id: null }], rowCount: 1 }
  }
  if (sql.includes('UPDATE crm_integration_action_attempts attempt') && sql.includes('SET connection_id')) {
    return { rows: [], rowCount: 1 }
  }
  if (sql.includes('SELECT external_event_id, external_event_url, join_url')) {
    return { rows: existingCalendarEvent ? [existingCalendarEvent] : [], rowCount: existingCalendarEvent ? 1 : 0 }
  }
  if (sql.includes('SET join_url = NULL')) {
    joinUrlClearCount += 1
    return { rows: [], rowCount: 1 }
  }
  if (sql.includes('SELECT * FROM crm_integration_actions') && !sql.includes('FOR UPDATE')) {
    return { rows: [currentRow], rowCount: 1 }
  }
  throw new Error(`unexpected process query: ${sql.slice(0, 100)}`)
}

const transactionClient = {
  async query(sql, parameters = []) {
    if (sql.includes('SELECT *') && sql.includes('FROM crm_integration_actions') && sql.includes('FOR UPDATE')) {
      return { rows: [currentRow], rowCount: 1 }
    }
    if (sql.includes("SET status = 'queued'") && sql.includes("'operatorRetry'")) {
      retryUpdate = parameters
      currentRow = actionRow({
        ...currentRow,
        status: 'queued',
        last_error: null,
        response_summary: {
          ...(currentRow.response_summary || {}),
          operatorRetry: {
            reviewed: parameters[3],
            reason: parameters[4],
            authorizedThroughAttempt: parameters[5],
          },
        },
      })
      return { rows: [currentRow], rowCount: 1 }
    }
    if (sql.includes('UPDATE crm_integration_actions') && sql.includes('SET status = $3')) {
      currentRow = actionRow({
        ...currentRow,
        status: parameters[2],
        last_error: parameters[3],
        response_summary: {
          ...(currentRow.response_summary || {}),
          ...JSON.parse(parameters[5]),
        },
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE crm_meetings') && sql.includes("'calendarDeliveryStatus', 'failed'")) {
      terminalMeetingFailure = { sql, parameters }
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE crm_meetings') && sql.includes("'calendarDeliveryStatus', 'queued'")) {
      retryMeetingUpdate = { sql, parameters }
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
    if (sql.includes('UPDATE crm_integration_actions') && sql.includes('SET external_id = COALESCE')) {
      currentRow = actionRow({
        ...currentRow,
        external_id: parameters[2],
        response_summary: JSON.parse(parameters[3]),
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE crm_integration_actions') && sql.includes("SET status = 'succeeded'")) {
      currentRow = actionRow({
        ...currentRow,
        status: 'succeeded',
        external_id: parameters[2],
        response_summary: JSON.parse(parameters[3]),
        last_error: null,
        processed_at: new Date('2026-09-02T12:05:00.000Z'),
      })
      return { rows: [], rowCount: 1 }
    }
    if (
      sql.includes('crm_integration_action_attempts')
      || sql.includes('INSERT INTO audit_events')
      || sql.includes('crm_campaign_recipients')
    ) {
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected transaction SQL: ${sql.slice(0, 100)}`)
  },
}

const processRuntime = loadTypeScriptModule('app_src/lib/crm/integrationActions.ts', {
  ...commonMocks,
  '@/lib/integrations/matonGatewayCredentials': {
    resolveUserMatonGatewayCredential: async ({ ownerEmail, boundConnectionId }) => ({
      connectionId: boundConnectionId,
      accountEmail: ownerEmail === PREVIOUS_OWNER_EMAIL
        ? PREVIOUS_OWNER_EMAIL
        : ownerEmail === ACTOR_EMAIL
          ? ACTOR_EMAIL
          : CREDENTIAL_OWNER_EMAIL,
      ownerEmail,
    }),
  },
  '@/lib/maton': {
    matonFetch: async (pathname, init = {}, context = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      providerRequests.push({ pathname, init, context, body })
      if (pathname.includes('/calendarList?')) {
        const items = context.boundConnectionId === PERSONAL_CONNECTION_ID
          ? [{
              id: ACTOR_EMAIL,
              summary: 'Operator Calendar',
              primary: true,
              accessRole: 'owner',
            }]
          : context.boundConnectionId === PREVIOUS_CONNECTION_ID
          ? [{
              id: PREVIOUS_CALENDAR_EMAIL,
              summary: 'Legacy Calendar',
              primary: true,
              accessRole: 'owner',
            }]
          : [
              {
                id: ORGANIZER_EMAIL,
                summary: 'BPO Supply Chain',
                primary: true,
                accessRole: 'owner',
              },
              {
                id: SECONDARY_CALENDAR_EMAIL,
                summary: 'BPO Warehouse',
                accessRole: 'writer',
              },
            ]
        return new Response(JSON.stringify({ items }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (providerResult === 'calendar-400') {
        return new Response(JSON.stringify({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: `Invalid conference request ${'S'.repeat(120)}`,
          },
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      if (providerResult === 'delete-403' && init.method === 'DELETE') {
        return new Response(JSON.stringify({
          error: { code: 403, status: 'PERMISSION_DENIED', message: 'Calendar owner cannot delete this event' },
        }), { status: 403, headers: { 'Content-Type': 'application/json' } })
      }
      if (providerResult === 'lost-post-response' && init.method === 'POST') {
        return new Response(JSON.stringify({ error: { code: 409, message: 'Event already exists' } }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (providerResult === 'lost-post-response' && (init.method || 'GET') === 'GET' && pathname.includes('/events/')) {
        return new Response(JSON.stringify({
          id: MEETING_REFERENCE,
          extendedProperties: { private: { clawpilotMeetingReference: MEETING_REFERENCE } },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (providerResult === 'lost-post-response' && init.method === 'DELETE') {
        return new Response(null, { status: 404 })
      }
      return new Response(JSON.stringify({
        id: 'provider-event-id',
        htmlLink: 'https://calendar.google.com/event?eid=test',
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  },
  '@/lib/persistence/crm': {
    readCrmRecordByReference: async ({ referenceCode }) => referenceCode === MEETING_REFERENCE
      ? { ...contactTarget, entity: 'meetings', id: MEETING_ID, referenceCode: MEETING_REFERENCE }
      : contactTarget,
    resolveCrmReferenceCode: async (value) => value,
    stageCrmRecordWithClient: async () => { throw new Error('not expected') },
    stageCrmRecordInPostgres: async (input) => {
      stageCalls.push(input)
      return {
        id: MEETING_ID,
        referenceCode: MEETING_REFERENCE,
        shortUrl: 'https://clawpilot.example/m/gm1234567',
        sourceHash: 'meeting-source-hash',
      }
    },
  },
  '@/lib/persistence/organizationCommunications': {
    OrganizationCommunicationPersistenceError,
    resolvePipelineCommunicationScopeInPostgres: async () => {
      if (communicationScopeFailure) throw communicationScopeFailure
      return { organizationId: ORGANIZATION_ID }
    },
    resolvePipelineCommunicationSnapshotInPostgres: async () => activeCommunicationSnapshot,
  },
  '@/lib/persistence/postgres': {
    query: processQuery,
    withTransaction: async (work) => work(transactionClient),
  },
})

function leasedCalendarAction(payloadOverrides = {}, actionOverrides = {}) {
  const row = actionRow({
    status: 'processing',
    attempts: 1,
    lock_token: 'lease-token',
    payload: {
      ...baseCalendarPayload,
      description: 'Discuss requirements',
      location: '',
      attendeeEmails: ['recipient@example.com'],
      meetingStatus: 'scheduled',
      ...payloadOverrides,
    },
    ...actionOverrides,
  })
  currentRow = row
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
    processedAt: null,
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

async function processMode(mode, fields = {}, actionOverrides = {}) {
  providerResult = 'success'
  existingCalendarEvent = null
  providerRequests = []
  stageCalls = []
  terminalMeetingFailure = null
  joinUrlClearCount = 0
  const payload = mode ? { meetingMode: mode, ...fields } : fields
  const result = await processRuntime.processCrmIntegrationAction(leasedCalendarAction(payload, actionOverrides))
  assert.equal(result.status, 'succeeded', result.lastError || `${mode || 'legacy'} meeting failed`)
  const write = providerRequests.find((request) => request.init.method === 'POST')
  assert.ok(write, `${mode || 'legacy'} meeting must create a Calendar event`)
  return write
}

const legacyMeetWrite = await processMode(null)
assert.match(legacyMeetWrite.pathname, /conferenceDataVersion=1/)
assert.equal(legacyMeetWrite.body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet')
assert.equal(stageCalls.at(-1).sourcePayload.calendarOwnerEmail, CREDENTIAL_OWNER_EMAIL)
assert.equal(stageCalls.at(-1).sourcePayload.calendarConnectionId, CONNECTION_ID)
assert.equal(stageCalls.at(-1).sourcePayload.calendarOrganizerEmail, ORGANIZER_EMAIL)
assert.equal(currentRow.response_summary.calendarId, ORGANIZER_EMAIL)
assert.equal(currentRow.response_summary.calendarSummary, 'BPO Supply Chain')
assert.equal(currentRow.response_summary.calendarAccessRole, 'owner')
assert.equal(currentRow.response_summary.accountEmail, CREDENTIAL_OWNER_EMAIL)
assert.equal(currentRow.response_summary.organizerEmail, ORGANIZER_EMAIL)

const inPersonWrite = await processMode('in_person', { location: '100 Logistics Way' })
assert.doesNotMatch(inPersonWrite.pathname, /conferenceDataVersion/)
assert.equal(Object.hasOwn(inPersonWrite.body, 'conferenceData'), false)
assert.equal(inPersonWrite.body.location, '100 Logistics Way')
assert.equal(stageCalls.at(-1).fields.joinUrl, null)

activeCommunicationSnapshot = {
  ...communicationSnapshot,
  identityEmail: SECONDARY_CALENDAR_EMAIL,
  calendarId: SECONDARY_CALENDAR_EMAIL,
}
const secondaryCalendarWrite = await processMode(
  'in_person',
  { location: '200 Fulfillment Way' },
  {
    communication_identity_email: SECONDARY_CALENDAR_EMAIL,
    communication_calendar_id: SECONDARY_CALENDAR_EMAIL,
  },
)
activeCommunicationSnapshot = communicationSnapshot
assert.match(secondaryCalendarWrite.pathname, /warehouse%40bposupplychain\.com/)
assert.ok(
  providerRequests.some((request) => request.pathname.includes('minAccessRole=writer')),
  'Calendar execution must verify the snapshotted selection from a bounded writable-calendar list',
)
assert.equal(currentRow.response_summary.calendarSummary, 'BPO Warehouse')
assert.equal(currentRow.response_summary.calendarAccessRole, 'writer')

const personalCalendarWrite = await processMode(
  'google_meet',
  {},
  {
    workspace_organization_id: ORGANIZATION_ID,
    communication_credential_owner_email: ACTOR_EMAIL,
    communication_connection_id: PERSONAL_CONNECTION_ID,
    communication_account_email: ACTOR_EMAIL,
    communication_identity_email: ACTOR_EMAIL,
    communication_calendar_id: ACTOR_EMAIL,
    communication_binding_source: 'meeting-override',
  },
)
assert.match(personalCalendarWrite.pathname, /operator%40suburbiasandwichco\.com/)
assert.equal(personalCalendarWrite.context.ownerEmail, ACTOR_EMAIL)
assert.equal(personalCalendarWrite.context.boundConnectionId, PERSONAL_CONNECTION_ID)

providerRequests = []
stageCalls = []
communicationScopeFailure = new OrganizationCommunicationPersistenceError(
  'former member',
  403,
  'ORGANIZATION_COMMUNICATION_MEMBERSHIP_REQUIRED',
)
const removedActorResult = await processRuntime.processCrmIntegrationAction(leasedCalendarAction())
assert.equal(removedActorResult.status, 'dead')
assert.match(removedActorResult.lastError, /no longer authorized/)
assert.equal(providerRequests.length, 0, 'a removed actor must fail before any Calendar provider request')
communicationScopeFailure = null

providerRequests = []
stageCalls = []
activeCommunicationSnapshot = {
  ...communicationSnapshot,
  connectionId: 'new-organization-calendar-connection',
}
const reboundDestinationResult = await processRuntime.processCrmIntegrationAction(leasedCalendarAction())
assert.equal(reboundDestinationResult.status, 'dead')
assert.match(reboundDestinationResult.lastError, /no longer matches the active binding/)
assert.equal(providerRequests.length, 0, 'a replaced organization Calendar binding must fail before provider I/O')
activeCommunicationSnapshot = communicationSnapshot

const customLink = 'https://video.example.com/rooms/bpo-demo'
const customWrite = await processMode('custom_link', { customJoinUrl: customLink })
assert.doesNotMatch(customWrite.pathname, /conferenceDataVersion/)
assert.equal(Object.hasOwn(customWrite.body, 'conferenceData'), false)
assert.equal(customWrite.body.location, customLink)
assert.equal(stageCalls.at(-1).fields.joinUrl, customLink)

function previousCalendarSnapshot(overrides = {}) {
  return {
    eventId: 'existing-event-id',
    credentialOwnerEmail: CREDENTIAL_OWNER_EMAIL,
    connectionId: CONNECTION_ID,
    calendarId: 'primary',
    organizerEmail: ORGANIZER_EMAIL,
    ...overrides,
  }
}

async function processExistingMeeting(payloadOverrides, previous, mode = 'success') {
  providerResult = mode
  providerRequests = []
  stageCalls = []
  terminalMeetingFailure = null
  joinUrlClearCount = 0
  existingCalendarEvent = {
    external_event_id: previous.eventId,
    external_event_url: 'https://calendar.google.com/event?eid=existing',
    join_url: 'https://meet.google.com/old-meet-link',
    source_payload: {
      calendarOwnerEmail: previous.credentialOwnerEmail,
      calendarConnectionId: previous.connectionId,
      calendarId: previous.calendarId,
      calendarOrganizerEmail: previous.organizerEmail,
    },
  }
  const result = await processRuntime.processCrmIntegrationAction(leasedCalendarAction(
    { ...payloadOverrides, previousCalendar: previous },
    { aggregate_type: 'crm_meeting', aggregate_id: MEETING_ID, reference_code: MEETING_REFERENCE },
  ))
  assert.equal(result.status, 'succeeded', result.lastError || 'existing meeting update failed')
  return providerRequests
}

const sameCalendar = previousCalendarSnapshot()
let updateRequests = await processExistingMeeting(
  { meetingMode: 'in_person', location: '300 Distribution Drive' },
  sameCalendar,
)
const meetToInPerson = updateRequests.find((request) => request.init.method === 'PATCH')
assert.ok(meetToInPerson, 'an existing event on the selected Calendar must be patched in place')
assert.match(meetToInPerson.pathname, /conferenceDataVersion=1/)
assert.equal(meetToInPerson.body.conferenceData, null, 'Meet-to-in-person must explicitly clear conference data')
assert.equal(meetToInPerson.body.location, '300 Distribution Drive')
assert.equal(stageCalls.at(-1).fields.joinUrl, null)
assert.equal(joinUrlClearCount, 1, 'the final non-Meet state must clear the persisted Meet URL')

updateRequests = await processExistingMeeting(
  { meetingMode: 'google_meet', location: '' },
  sameCalendar,
)
const inPersonToMeet = updateRequests.find((request) => request.init.method === 'PATCH')
assert.ok(inPersonToMeet)
assert.match(inPersonToMeet.pathname, /conferenceDataVersion=1/)
assert.equal(inPersonToMeet.body.location, null, 'in-person-to-Meet must explicitly clear the old location')
assert.equal(inPersonToMeet.body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet')
assert.equal(stageCalls.at(-1).fields.joinUrl, 'https://meet.google.com/abc-defg-hij')

const oldCalendar = previousCalendarSnapshot({
  credentialOwnerEmail: ACTOR_EMAIL,
  connectionId: PREVIOUS_CONNECTION_ID,
  calendarId: PREVIOUS_CALENDAR_EMAIL,
  organizerEmail: PREVIOUS_CALENDAR_EMAIL,
})
updateRequests = await processExistingMeeting(
  { meetingMode: 'in_person', location: '400 Fulfillment Avenue' },
  oldCalendar,
)
const destinationCreateIndex = updateRequests.findIndex((request) => request.init.method === 'POST')
const oldDeleteIndex = updateRequests.findIndex((request) => request.init.method === 'DELETE')
assert.ok(destinationCreateIndex >= 0 && oldDeleteIndex > destinationCreateIndex, 'a Calendar move must create the destination before deleting the source')
assert.match(updateRequests[destinationCreateIndex].pathname, /calendars\/primary\/events/)
assert.equal(updateRequests[destinationCreateIndex].context.boundConnectionId, CONNECTION_ID)
assert.match(updateRequests[oldDeleteIndex].pathname, /legacy-calendar%40example\.com\/events\/existing-event-id/)
assert.equal(updateRequests[oldDeleteIndex].context.ownerEmail, ACTOR_EMAIL)
assert.equal(updateRequests[oldDeleteIndex].context.boundConnectionId, PREVIOUS_CONNECTION_ID)

updateRequests = await processExistingMeeting(
  { meetingMode: 'in_person', location: '500 Retry Road' },
  oldCalendar,
  'lost-post-response',
)
assert.equal(updateRequests.filter((request) => request.init.method === 'POST').length, 1)
assert.equal(updateRequests.filter((request) => request.init.method === 'PATCH').length, 1, 'a lost destination response must reconcile the deterministic event in place')
assert.equal(updateRequests.filter((request) => request.init.method === 'DELETE').length, 1)
assert.ok(
  updateRequests.some((request) => (request.init.method || 'GET') === 'GET' && request.pathname.includes(`/events/${MEETING_REFERENCE}`)),
  'a 409 retry must verify that the destination event belongs to the same ClawPilot meeting',
)

providerResult = 'delete-403'
providerRequests = []
stageCalls = []
terminalMeetingFailure = null
existingCalendarEvent = {
  external_event_id: oldCalendar.eventId,
  external_event_url: 'https://calendar.google.com/event?eid=old-calendar',
  join_url: null,
  source_payload: {
    calendarOwnerEmail: oldCalendar.credentialOwnerEmail,
    calendarConnectionId: oldCalendar.connectionId,
    calendarId: oldCalendar.calendarId,
    calendarOrganizerEmail: oldCalendar.organizerEmail,
  },
}
const failedMove = await processRuntime.processCrmIntegrationAction(leasedCalendarAction(
  {
    meetingMode: 'in_person',
    location: '550 Durable Move Drive',
    previousCalendar: oldCalendar,
  },
  { aggregate_type: 'crm_meeting', aggregate_id: MEETING_ID, reference_code: MEETING_REFERENCE },
))
assert.equal(failedMove.status, 'dead')
assert.equal(failedMove.externalId, 'provider-event-id')
assert.equal(
  failedMove.responseSummary.calendarMove.state,
  'destination-written-source-delete-pending',
  'destination evidence must survive an old-Calendar delete failure',
)
assert.equal(failedMove.responseSummary.calendarMove.sourceEventId, oldCalendar.eventId)
assert.equal(failedMove.responseSummary.calendarMove.destinationEventId, 'provider-event-id')
assert.equal(providerRequests.filter((request) => request.init.method === 'POST').length, 1)

const durableMoveSummary = structuredClone(failedMove.responseSummary)
providerResult = 'success'
providerRequests = []
stageCalls = []
terminalMeetingFailure = null
const resumedMove = await processRuntime.processCrmIntegrationAction(leasedCalendarAction(
  {
    meetingMode: 'in_person',
    location: '550 Durable Move Drive',
    previousCalendar: oldCalendar,
  },
  {
    aggregate_type: 'crm_meeting',
    aggregate_id: MEETING_ID,
    reference_code: MEETING_REFERENCE,
    attempts: 2,
    external_id: 'provider-event-id',
    response_summary: durableMoveSummary,
  },
))
assert.equal(resumedMove.status, 'succeeded', resumedMove.lastError || 'durable Calendar move retry failed')
assert.equal(
  providerRequests.filter((request) => request.init.method === 'POST').length,
  0,
  'a move retry must reuse durable destination evidence rather than create another event',
)
assert.equal(providerRequests.filter((request) => request.init.method === 'DELETE').length, 1)
assert.equal(Object.hasOwn(resumedMove.responseSummary, 'calendarMove'), false)

providerResult = 'success'
providerRequests = []
stageCalls = []
terminalMeetingFailure = null
const formerMemberCalendar = previousCalendarSnapshot({
  credentialOwnerEmail: PREVIOUS_OWNER_EMAIL,
  connectionId: PREVIOUS_CONNECTION_ID,
  calendarId: PREVIOUS_CALENDAR_EMAIL,
  organizerEmail: PREVIOUS_CALENDAR_EMAIL,
})
existingCalendarEvent = {
  external_event_id: formerMemberCalendar.eventId,
  external_event_url: 'https://calendar.google.com/event?eid=former-member',
  join_url: null,
  source_payload: {
    calendarOwnerEmail: formerMemberCalendar.credentialOwnerEmail,
    calendarConnectionId: formerMemberCalendar.connectionId,
    calendarId: formerMemberCalendar.calendarId,
    calendarOrganizerEmail: formerMemberCalendar.organizerEmail,
  },
}
const formerMemberMove = await processRuntime.processCrmIntegrationAction(leasedCalendarAction(
  {
    meetingMode: 'in_person',
    location: '600 Security Street',
    previousCalendar: formerMemberCalendar,
  },
  { aggregate_type: 'crm_meeting', aggregate_id: MEETING_ID, reference_code: MEETING_REFERENCE },
))
assert.equal(formerMemberMove.status, 'dead')
assert.match(formerMemberMove.lastError, /no longer authorized/)
assert.equal(
  providerRequests.some((request) => request.context.ownerEmail === PREVIOUS_OWNER_EMAIL),
  false,
  'a former organization member credential must never be used to inspect or mutate its old Calendar',
)
assert.equal(
  providerRequests.some((request) => request.init.method === 'POST'),
  false,
  'authorization of the old Calendar identity must happen before creating the destination event',
)

providerResult = 'calendar-400'
providerRequests = []
stageCalls = []
terminalMeetingFailure = null
existingCalendarEvent = null
const failed = await processRuntime.processCrmIntegrationAction(leasedCalendarAction({ meetingMode: 'google_meet' }))
assert.equal(failed.status, 'dead', 'non-retryable Google 400 responses must terminate immediately')
assert.equal(failed.responseSummary.providerStatus, 400)
assert.equal(failed.responseSummary.providerCode, 'INVALID_ARGUMENT')
assert.match(failed.responseSummary.providerError, /Invalid conference request/)
assert.doesNotMatch(failed.responseSummary.providerError, /S{80}/, 'provider secrets/tokens must be redacted')
assert.ok(failed.responseSummary.providerError.length <= 500)
assert.ok(terminalMeetingFailure, 'terminal Calendar failure must mark the staged meeting delivery failed')
assert.match(terminalMeetingFailure.sql, /SET status = 'failed'/)

providerResult = 'delete-403'
providerRequests = []
stageCalls = []
terminalMeetingFailure = null
existingCalendarEvent = {
  external_event_id: 'event-to-delete',
  external_event_url: 'https://calendar.google.com/event?eid=delete',
  join_url: null,
  source_payload: {
    calendarOwnerEmail: CREDENTIAL_OWNER_EMAIL,
    calendarConnectionId: CONNECTION_ID,
    calendarId: 'primary',
    calendarOrganizerEmail: ORGANIZER_EMAIL,
  },
}
const deleteFailure = await processRuntime.processCrmIntegrationAction(leasedCalendarAction(
  { meetingMode: 'in_person', location: '100 Logistics Way', meetingStatus: 'cancelled' },
  { aggregate_type: 'crm_meeting', aggregate_id: MEETING_ID, reference_code: MEETING_REFERENCE },
))
assert.equal(deleteFailure.status, 'dead')
assert.equal(deleteFailure.responseSummary.providerCode, 'PERMISSION_DENIED')
assert.match(deleteFailure.responseSummary.providerError, /cannot delete this event/)
assert.ok(providerRequests.some((request) => request.init.method === 'DELETE'))

currentRow = actionRow({
  status: 'dead',
  attempts: 5,
  response_summary: { providerCode: 'INVALID_ARGUMENT' },
  last_error: 'bad request',
})
await assert.rejects(
  processRuntime.retryCrmIntegrationAction({
    actionId: ACTION_ID,
    pipelineId: PIPELINE_ID,
    actorEmail: ACTOR_EMAIL,
  }),
  (error) => error?.code === 'CRM_ACTION_RETRY_REVIEW_REQUIRED',
)

currentRow = actionRow({
  status: 'dead',
  attempts: 5,
  workspace_organization_id: null,
  communication_credential_owner_email: null,
  communication_connection_id: null,
  communication_account_email: null,
  communication_identity_email: null,
  communication_calendar_id: null,
  communication_binding_source: null,
})
await assert.rejects(
  processRuntime.retryCrmIntegrationAction({
    actionId: ACTION_ID,
    pipelineId: PIPELINE_ID,
    actorEmail: ACTOR_EMAIL,
    reviewed: true,
    reason: 'The organization Calendar binding was reviewed',
  }),
  (error) => error?.code === 'CRM_ACTION_COMMUNICATION_SNAPSHOT_REQUIRED',
  'historical actions must not silently bind to the actor default during retry',
)

currentRow = actionRow({ status: 'dead', attempts: 5, last_error: 'provider rejected request' })
retryUpdate = null
retryMeetingUpdate = null
const retried = await processRuntime.retryCrmIntegrationAction({
  actionId: ACTION_ID,
  pipelineId: PIPELINE_ID,
  actorEmail: ACTOR_EMAIL,
  reviewed: true,
  reason: 'Corrected meeting contract and reviewed the exact BPO Calendar identity',
})
assert.equal(retried.status, 'queued')
assert.equal(retryUpdate[5], 6, 'dead action retry must authorize exactly one new attempt')
assert.equal(retried.responseSummary.operatorRetry.reviewed, true)
assert.ok(retryMeetingUpdate, 'reviewed Calendar retry must return its delivery state to queued')
assert.doesNotMatch(retryMeetingUpdate.sql, /sync_status/, 'Calendar retry must not overwrite SuiteCRM sync state')

const actionRoute = read('app_src/app/api/crm/actions/route.ts')
assert.ok(actionRoute.includes('export async function PATCH'))
assert.ok(actionRoute.includes("body.reviewed !== true"))
assert.ok(actionRoute.includes('retryCrmIntegrationAction'))

const crmTypes = read('app_src/lib/crm/types.ts')
for (const field of [
  'calendarDeliveryStatus',
  'calendarDeliveryError',
  'calendarOwnerEmail',
  'calendarConnectionId',
  'calendarOrganizerEmail',
  'calendarId',
  'meetingMode',
  'customJoinUrl',
]) {
  assert.ok(crmTypes.includes(`${field}:`), `CRM meeting response type must expose ${field}`)
}
const crmPersistence = read('app_src/lib/persistence/crm.ts')
for (const fragment of [
  'sourcePayload.calendarDeliveryStatus',
  'calendarDeliveryError: nullable(sourcePayload.calendarDeliveryError)',
  'calendarOwnerEmail: nullable(sourcePayload.calendarOwnerEmail)',
  'calendarConnectionId: nullable(sourcePayload.calendarConnectionId)',
  'calendarOrganizerEmail: nullable(sourcePayload.calendarOrganizerEmail)',
  'calendarId: nullable(sourcePayload.calendarId)',
  "rawMeetingMode as CrmMeeting['meetingMode']",
  'customJoinUrl: nullable(sourcePayload.customJoinUrl)',
]) {
  assert.ok(crmPersistence.includes(fragment), `CRM meeting response mapper missing ${fragment}`)
}

console.log('CRM Calendar delivery contract tests passed')
