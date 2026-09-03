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

const calendarSelectionMigration = read('db/migrations/0345_organization_calendar_selection.sql')
for (const fragment of [
  'DROP CONSTRAINT IF EXISTS organization_communication_bindings_calendar_id_valid',
  'char_length(calendar_id) BETWEEN 1 AND 1024',
  "calendar_id !~ '[[:cntrl:]]'",
  "communication_binding_source IN ('organization', 'user-default', 'meeting-override')",
]) {
  assert.ok(calendarSelectionMigration.includes(fragment), `Calendar selection migration missing ${fragment}`)
}

const emailSenderSelectionMigration = read('db/migrations/0346_organization_email_sender_selection.sql')
for (const fragment of [
  'DROP CONSTRAINT IF EXISTS crm_integration_actions_communication_snapshot_valid',
  "'email-override'",
  'communication_credential_owner_email IS NOT NULL',
  'communication_connection_id IS NOT NULL',
  'communication_account_email IS NOT NULL',
  'communication_identity_email IS NOT NULL',
]) {
  assert.ok(
    emailSenderSelectionMigration.includes(fragment),
    `Email sender selection migration missing ${fragment}`,
  )
}

const persistence = read('app_src/lib/persistence/organizationCommunications.ts')
for (const fragment of [
  'resolvePipelineCommunicationSnapshotInPostgres',
  'resolvePipelineCommunicationScopeInPostgres',
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
  'boundConnectionId: action.communicationConnectionId',
  '/settings/sendAs/${encodeURIComponent(senderEmail)}',
  '/google-calendar/calendar/v3/users/me/calendarList?',
  'The queued Calendar organizer no longer matches its reviewed identity',
  "calendarIdentifier(selectedConnection.calendarId, 'Queued Calendar ID')",
  'communication: action.communication',
  "error.code === 'ORGANIZATION_COMMUNICATION_CONNECTION_REQUIRED'",
  'throw await providerRequestError(app, response)',
  "'calendarDeliveryStatus', 'failed'",
  "'CRM_ACTION_COMMUNICATION_SNAPSHOT_REQUIRED'",
  "type CalendarMeetingMode = 'google_meet' | 'in_person' | 'custom_link'",
  "meetingMode === 'google_meet'",
  "? 'conferenceDataVersion=1&sendUpdates=all'",
  'communicationOverride?: PipelineCommunicationSnapshot',
  "value?.source !== 'meeting-override'",
  'stageCrmMeetingAndEnqueueCalendarAction',
  'previousCalendar',
  'conferenceData: null',
  'location: eventLocation || (!createDestinationEvent ? null : undefined)',
  "value?.source !== 'email-override'",
  "actionType === 'send_campaign'",
  "await verifiedGmailSelectionForAction(action)",
  'senderAccountEmail: action.communication?.accountEmail',
]) {
  assert.ok(actionRuntime.includes(fragment), `CRM communication runtime missing ${fragment}`)
}

const route = read('app_src/app/api/integrations/communications/route.ts')
assert.ok(route.includes('requireManager(actor)'))
const communicationGet = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function PATCH'))
assert.ok(!communicationGet.includes('requireManager(actor)'), 'read-only provider choices must be available to CRM editors')
assert.ok(communicationGet.includes('canManageOrganizationCommunications(actor)'))
assert.ok(communicationGet.includes('{ ...communication, bindings: [] }'), 'non-managers must not receive organization binding credential metadata')
assert.ok(route.includes("'gmailSendAsEmail', 'calendarId'"))
assert.ok(route.includes("String(body.action || '').trim() !== 'bind'"))

const crmRoute = read('app_src/app/api/crm/route.ts')
assert.ok(crmRoute.includes('calendarActionUnavailable'))
assert.ok(crmRoute.includes("error.code === 'ORGANIZATION_COMMUNICATION_CONNECTION_REQUIRED'"))
assert.ok(crmRoute.includes("code: 'CRM_COMMUNICATION_CONNECTION_REQUIRED'"))
assert.ok(crmRoute.includes('resolveVerifiedPipelineCalendarSelection'))
assert.ok(crmRoute.includes('stageCrmMeetingAndEnqueueCalendarAction'))
assert.ok(crmRoute.includes('meetingSaveIdempotencyKey'))
assert.ok(crmRoute.includes('CRM_IMPERSONATION_FORBIDDEN'))
const crmActionRoute = read('app_src/app/api/crm/actions/route.ts')
assert.ok(crmActionRoute.includes("'calendarConnectionId'"))
assert.ok(crmActionRoute.includes("'gmailConnectionId'"))
assert.ok(crmActionRoute.includes("'gmailSendAsEmail'"))
assert.ok(crmActionRoute.includes('resolveVerifiedPipelineCalendarSelection'))
assert.ok(crmActionRoute.includes('resolveVerifiedPipelineGmailSelection'))
assert.ok(crmActionRoute.includes('communicationOverride'))
assert.ok(crmActionRoute.includes('CRM_ACTION_IMPERSONATION_FORBIDDEN'))

const healthRoute = read('app_src/app/api/health/route.ts')
for (const fragment of [
  'organization_email_sender_selection_applied',
  "filename = '0346_organization_email_sender_selection.sql'",
  "'2c10df72a620bd2f78ed472846b56841c77ba69836e61fd13b8533590e154e81'",
  "LIKE '%email-override%'",
]) {
  assert.ok(healthRoute.includes(fragment), `Email sender migration readiness missing ${fragment}`)
}
assert.ok(
  (healthRoute.match(/row\?\.organization_email_sender_selection_applied/g) || []).length >= 2,
  'Email sender migration must gate both migrationsCurrent and public health errors',
)
const suiteCrmMeetingIngestion = read('app_src/lib/crm/suiteCrmMeetingIngestion.ts')
assert.ok(suiteCrmMeetingIngestion.includes("error.code === 'CRM_COMMUNICATION_CONNECTION_REQUIRED'"))

class TestCrmIntegrationActionError extends Error {
  constructor(message, status = 400, code = 'CRM_ACTION_INVALID') {
    super(message)
    this.status = status
    this.code = code
  }
}
const nextServerMock = {
  NextRequest: class {},
  NextResponse: {
    json(payload, init = {}) {
      return new Response(JSON.stringify(payload), {
        status: init.status || 200,
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      })
    },
  },
}
let routeSession = {
  authenticatedUser: 'admin@example.com',
  effectiveUser: 'member@example.com',
  impersonating: true,
}
let guardedUserLookupCount = 0
const guardedRequestUserMock = {
  requestSession: async () => routeSession,
  requireRequestUser: async () => {
    guardedUserLookupCount += 1
    throw new Error('write guard should run before user lookup')
  },
}
const crmWriteRoute = loadTypeScriptModule('app_src/app/api/crm/route.ts', {
  'next/server': nextServerMock,
  '@/lib/globalIds.mjs': { GLOBAL_ID_MAX_LENGTH: 64 },
  '@/lib/crm/types': { CRM_ENTITIES: ['organizations', 'contacts', 'products', 'leads', 'opportunities', 'meetings', 'interactions', 'campaigns'] },
  '@/lib/currency': { isIso4217CurrencyCode: () => true },
  '@/lib/crm/integrationActions': {
    CrmIntegrationActionError: TestCrmIntegrationActionError,
    stageCrmMeetingAndEnqueueCalendarAction: async () => { throw new Error('not expected') },
  },
  '@/lib/integrations/organizationCommunications': {},
  '@/lib/crm/boardProjection': {},
  '@/lib/persistence/crm': {},
  '@/lib/organizations': {},
  '@/lib/crm/suiteCrmPublicUrl': {},
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/persistence/organizationCommunications': { OrganizationCommunicationPersistenceError: class extends Error {} },
  '@/lib/persistence/measurementPreferences': {},
  '@/lib/operations/authorization': {},
  '@/lib/requestUser': guardedRequestUserMock,
  '@/lib/users': {},
  '@/lib/tenancy': {},
})
const impersonatedRequest = { headers: new Headers(), cookies: { get: () => undefined } }
let guardedResponse = await crmWriteRoute.POST(impersonatedRequest)
assert.equal(guardedResponse.status, 403)
assert.equal((await guardedResponse.json()).code, 'CRM_IMPERSONATION_FORBIDDEN')
routeSession = { ...routeSession, impersonating: false }
guardedResponse = await crmWriteRoute.PATCH(impersonatedRequest)
assert.equal(guardedResponse.status, 403)
assert.equal((await guardedResponse.json()).code, 'CRM_IMPERSONATION_FORBIDDEN')

routeSession = { ...routeSession, impersonating: true }
const crmActionWriteRoute = loadTypeScriptModule('app_src/app/api/crm/actions/route.ts', {
  'next/server': nextServerMock,
  '@/lib/crm/integrationActions': {
    CrmIntegrationActionError: TestCrmIntegrationActionError,
  },
  '@/lib/integrations/organizationCommunications': {},
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/requestUser': guardedRequestUserMock,
  '@/lib/tenancy': {},
})
guardedResponse = await crmActionWriteRoute.POST(impersonatedRequest)
assert.equal(guardedResponse.status, 403)
assert.equal((await guardedResponse.json()).code, 'CRM_ACTION_IMPERSONATION_FORBIDDEN')
routeSession = { ...routeSession, impersonating: false }
guardedResponse = await crmActionWriteRoute.PATCH(impersonatedRequest)
assert.equal(guardedResponse.status, 403)
assert.equal((await guardedResponse.json()).code, 'CRM_ACTION_IMPERSONATION_FORBIDDEN')

routeSession = { ...routeSession, impersonating: true }
const communicationsRoute = loadTypeScriptModule('app_src/app/api/integrations/communications/route.ts', {
  'next/server': nextServerMock,
  '@/lib/browserSameOrigin': { isBrowserSameOriginRequest: () => true },
  '@/lib/integrations/organizationCommunications': {
    getOrganizationCommunicationState: async () => {
      throw new Error('impersonation must be rejected before enumerating personal connections')
    },
    sanitizeOrganizationCommunicationError: (error) => ({
      message: error instanceof Error ? error.message : 'unexpected error',
      status: 500,
      code: 'UNEXPECTED',
    }),
  },
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/publicUrl': { appPublicUrl: () => 'https://clawpilot.example' },
  '@/lib/requestUser': guardedRequestUserMock,
  '@/lib/users': {},
})
guardedResponse = await communicationsRoute.GET(impersonatedRequest)
assert.equal(guardedResponse.status, 403)
assert.equal((await guardedResponse.json()).code, 'ORGANIZATION_COMMUNICATION_IMPERSONATION_FORBIDDEN')
assert.equal(guardedUserLookupCount, 0, 'impersonation writes must be rejected before resolving an effective actor')

const ROUTE_PIPELINE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ROUTE_ACTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ROUTE_ACTOR_EMAIL = 'operator@example.com'
const ROUTE_REFERENCE = 'gm1234567'
const ROUTE_EXACT_HASH = 'a'.repeat(64)
const ROUTE_CHANGED_HASH = 'b'.repeat(64)
const ROUTE_DEFAULT_HASH = 'c'.repeat(64)
const replayedActionView = {
  id: ROUTE_ACTION_ID,
  pipelineId: ROUTE_PIPELINE_ID,
  provider: 'maton',
  app: 'google-calendar',
  actionType: 'create_calendar_event',
  referenceCode: ROUTE_REFERENCE,
  status: 'succeeded',
  attempts: 1,
  availableAt: '2026-09-02T12:00:00.000Z',
  externalId: 'google-event-id',
  responseSummary: { eventId: 'google-event-id' },
  communication: null,
  lastError: null,
  processedAt: '2026-09-02T12:00:01.000Z',
  createdAt: '2026-09-02T12:00:00.000Z',
  updatedAt: '2026-09-02T12:00:01.000Z',
}
const validRouteRequestUserMock = {
  requestSession: async () => ({
    authenticatedUser: ROUTE_ACTOR_EMAIL,
    effectiveUser: ROUTE_ACTOR_EMAIL,
    impersonating: false,
  }),
  requireRequestUser: async () => ({ email: ROUTE_ACTOR_EMAIL }),
}
const validTenancyMock = {
  PIPELINE_SELECTION_COOKIE: 'clawpilot-pipeline',
  requireResourceEditor: () => {},
  resolvePipelineSpaceAccess: async () => ({ id: ROUTE_PIPELINE_ID }),
}
const routeClientHash = (value) => {
  if (
    value?.payload?.subject === 'Changed retry intent'
    || value?.fields?.subject === 'Changed retry intent'
  ) return ROUTE_CHANGED_HASH
  if (
    value?.calendarSelection === null
    || value?.gmailSelection === null
    || (value?.fields && !value.fields.calendarConnectionId && !value.fields.calendarId)
  ) return ROUTE_DEFAULT_HASH
  return ROUTE_EXACT_HASH
}
let actionCalendarResolutionCalls = 0
let actionEnqueueCalls = 0
let mutableCalendarState = 'revoked'
const replayingActionRoute = loadTypeScriptModule('app_src/app/api/crm/actions/route.ts', {
  'next/server': nextServerMock,
  '@/lib/crm/integrationActions': {
    CrmIntegrationActionError: TestCrmIntegrationActionError,
    crmIntegrationClientRequestHash: routeClientHash,
    replayCrmIntegrationActionByIdempotencyKey: async (input) => {
      if (![ROUTE_EXACT_HASH, ROUTE_DEFAULT_HASH].includes(input.clientRequestHash)) {
        throw new TestCrmIntegrationActionError(
          'Idempotency key was already used for a different CRM action',
          409,
          'CRM_ACTION_IDEMPOTENCY_CONFLICT',
        )
      }
      return { action: replayedActionView, aggregateId: ROUTE_ACTION_ID, referenceCode: ROUTE_REFERENCE }
    },
    enqueueCrmIntegrationAction: async () => {
      actionEnqueueCalls += 1
      throw new Error('an exact replay must not enqueue again')
    },
  },
  '@/lib/integrations/organizationCommunications': {
    resolveVerifiedPipelineCalendarSelection: async () => {
      actionCalendarResolutionCalls += 1
      if (mutableCalendarState === 'revoked') throw new Error('Calendar connection was revoked')
      return { connectionId: 'changed-binding' }
    },
  },
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/requestUser': validRouteRequestUserMock,
  '@/lib/tenancy': validTenancyMock,
})
function crmActionRequest(subject, options = {}) {
  const includeSelection = options.includeSelection !== false
  const raw = JSON.stringify({
    actionType: 'create_calendar_event',
    referenceCode: ROUTE_REFERENCE,
    payload: {
      subject,
      startsAt: '2026-09-03T14:00:00.000Z',
      endsAt: '2026-09-03T14:30:00.000Z',
      timezone: 'America/New_York',
    },
    ...(includeSelection ? {
      calendarConnectionId: 'revoked-or-rebound-connection',
      calendarId: 'jarrett@bposupplychain.com',
    } : {}),
    idempotencyKey: options.idempotencyKey || 'route-lost-response-key',
  })
  return {
    headers: new Headers({ 'content-length': String(Buffer.byteLength(raw)) }),
    cookies: { get: () => undefined },
    text: async () => raw,
  }
}
let replayResponse = await replayingActionRoute.POST(crmActionRequest('Original meeting intent'))
assert.equal(replayResponse.status, 200)
assert.equal((await replayResponse.json()).action.id, ROUTE_ACTION_ID)
assert.equal(actionCalendarResolutionCalls, 0, 'lost-response replay must survive a revoked Calendar connection')
assert.equal(actionEnqueueCalls, 0)
mutableCalendarState = 'changed-binding'
replayResponse = await replayingActionRoute.POST(crmActionRequest('Original meeting intent', {
  includeSelection: false,
  idempotencyKey: 'route-default-binding-lost-response-key',
}))
assert.equal(replayResponse.status, 200)
assert.equal(actionCalendarResolutionCalls, 0, 'lost-response replay must ignore a changed organization Calendar binding')
const actionConflictResponse = await replayingActionRoute.POST(crmActionRequest('Changed retry intent'))
assert.equal(actionConflictResponse.status, 409)
assert.equal((await actionConflictResponse.json()).code, 'CRM_ACTION_IDEMPOTENCY_CONFLICT')
assert.equal(actionCalendarResolutionCalls, 0, 'same-key/different-payload conflict must precede Calendar resolution')

let actionGmailResolutionCalls = 0
let actionEmailEnqueueCalls = 0
const replayingEmailActionRoute = loadTypeScriptModule('app_src/app/api/crm/actions/route.ts', {
  'next/server': nextServerMock,
  '@/lib/crm/integrationActions': {
    CrmIntegrationActionError: TestCrmIntegrationActionError,
    crmIntegrationClientRequestHash: routeClientHash,
    replayCrmIntegrationActionByIdempotencyKey: async (input) => {
      if (![ROUTE_EXACT_HASH, ROUTE_DEFAULT_HASH].includes(input.clientRequestHash)) {
        throw new TestCrmIntegrationActionError(
          'Idempotency key was already used for a different CRM action',
          409,
          'CRM_ACTION_IDEMPOTENCY_CONFLICT',
        )
      }
      return { action: replayedActionView, aggregateId: ROUTE_ACTION_ID, referenceCode: ROUTE_REFERENCE }
    },
    enqueueCrmIntegrationAction: async () => {
      actionEmailEnqueueCalls += 1
      throw new Error('an exact email replay must not enqueue again')
    },
  },
  '@/lib/integrations/organizationCommunications': {
    resolveVerifiedPipelineCalendarSelection: async () => {
      throw new Error('Calendar resolution is not expected for an email action')
    },
    resolveVerifiedPipelineGmailSelection: async () => {
      actionGmailResolutionCalls += 1
      throw new Error('Gmail connection was revoked')
    },
  },
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/requestUser': validRouteRequestUserMock,
  '@/lib/tenancy': validTenancyMock,
})
function crmEmailActionRequest(subject, options = {}) {
  const includeSelection = options.includeSelection !== false
  const raw = JSON.stringify({
    actionType: options.actionType || 'send_email',
    referenceCode: ROUTE_REFERENCE,
    payload: { subject, text: 'Reviewed email body' },
    ...(includeSelection ? {
      gmailConnectionId: 'revoked-or-rebound-gmail-connection',
      gmailSendAsEmail: 'stewards@eigenracing.com',
    } : {}),
    idempotencyKey: options.idempotencyKey || 'route-email-lost-response-key',
  })
  return {
    headers: new Headers({ 'content-length': String(Buffer.byteLength(raw)) }),
    cookies: { get: () => undefined },
    text: async () => raw,
  }
}
replayResponse = await replayingEmailActionRoute.POST(crmEmailActionRequest('Original email intent'))
assert.equal(replayResponse.status, 200)
assert.equal((await replayResponse.json()).action.id, ROUTE_ACTION_ID)
assert.equal(actionGmailResolutionCalls, 0, 'lost-response replay must survive a revoked Gmail connection')
assert.equal(actionEmailEnqueueCalls, 0)
replayResponse = await replayingEmailActionRoute.POST(crmEmailActionRequest('Original email intent', {
  includeSelection: false,
  idempotencyKey: 'route-email-default-lost-response-key',
}))
assert.equal(replayResponse.status, 200)
assert.equal(actionGmailResolutionCalls, 0, 'default Gmail lost-response replay must precede mutable binding resolution')
const emailConflictResponse = await replayingEmailActionRoute.POST(crmEmailActionRequest('Changed retry intent'))
assert.equal(emailConflictResponse.status, 409)
assert.equal((await emailConflictResponse.json()).code, 'CRM_ACTION_IDEMPOTENCY_CONFLICT')
assert.equal(actionGmailResolutionCalls, 0, 'same-key/different-email conflict must precede Gmail resolution')
const incompleteGmailRequest = crmEmailActionRequest('Incomplete Gmail selection')
incompleteGmailRequest.text = async () => JSON.stringify({
  actionType: 'send_email',
  referenceCode: ROUTE_REFERENCE,
  payload: { subject: 'Incomplete Gmail selection', text: 'Reviewed email body' },
  gmailConnectionId: 'gmail-connection-without-alias',
  idempotencyKey: 'route-email-incomplete-key',
})
const incompleteGmailResponse = await replayingEmailActionRoute.POST(incompleteGmailRequest)
assert.equal(incompleteGmailResponse.status, 400)
assert.equal((await incompleteGmailResponse.json()).code, 'CRM_GMAIL_SELECTION_INCOMPLETE')

let nativeCalendarResolutionCalls = 0
let nativeHierarchyCalls = 0
let nativeStageCalls = 0
const replayingNativeMeetingRoute = loadTypeScriptModule('app_src/app/api/crm/route.ts', {
  'next/server': nextServerMock,
  '@/lib/globalIds.mjs': { GLOBAL_ID_MAX_LENGTH: 64 },
  '@/lib/crm/types': { CRM_ENTITIES: ['organizations', 'contacts', 'products', 'leads', 'opportunities', 'meetings', 'interactions', 'campaigns'] },
  '@/lib/currency': { isIso4217CurrencyCode: () => true },
  '@/lib/crm/integrationActions': {
    CrmIntegrationActionError: TestCrmIntegrationActionError,
    crmIntegrationClientRequestHash: routeClientHash,
    replayCrmMeetingSaveByIdempotencyKey: async (input) => {
      if (![ROUTE_EXACT_HASH, ROUTE_DEFAULT_HASH].includes(input.clientRequestHash)) {
        throw new TestCrmIntegrationActionError(
          'Idempotency key was already used for a different CRM action',
          409,
          'CRM_ACTION_IDEMPOTENCY_CONFLICT',
        )
      }
      return {
        action: replayedActionView,
        created: false,
        reused: true,
        staged: {
          id: ROUTE_ACTION_ID,
          suiteCrmId: 'suitecrm-meeting-id',
          referenceCode: ROUTE_REFERENCE,
          shortUrl: `https://clawpilot.example/m/${ROUTE_REFERENCE}`,
          sourceHash: 'persisted-meeting-source-hash',
        },
      }
    },
    stageCrmMeetingAndEnqueueCalendarAction: async () => {
      nativeStageCalls += 1
      throw new Error('an exact meeting replay must not stage again')
    },
  },
  '@/lib/integrations/organizationCommunications': {
    resolveVerifiedPipelineCalendarSelection: async () => {
      nativeCalendarResolutionCalls += 1
      throw new Error('Calendar connection was revoked')
    },
  },
  '@/lib/crm/boardProjection': {},
  '@/lib/persistence/crm': {
    ensurePipelineCrmHierarchy: async () => {
      nativeHierarchyCalls += 1
      throw new Error('an exact meeting replay must not restage CRM hierarchy')
    },
  },
  '@/lib/organizations': {},
  '@/lib/crm/suiteCrmPublicUrl': {},
  '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
  '@/lib/persistence/organizationCommunications': {
    OrganizationCommunicationPersistenceError: class extends Error {},
    resolvePipelineCommunicationSnapshotInPostgres: async () => {
      nativeCalendarResolutionCalls += 1
      throw new Error('Organization Calendar binding changed')
    },
  },
  '@/lib/persistence/measurementPreferences': {},
  '@/lib/operations/authorization': {},
  '@/lib/requestUser': validRouteRequestUserMock,
  '@/lib/users': {},
  '@/lib/tenancy': validTenancyMock,
})
function nativeMeetingRequest(subject, options = {}) {
  const includeSelection = options.includeSelection !== false
  return {
    headers: new Headers(),
    cookies: { get: () => undefined },
    json: async () => ({
      entity: 'meetings',
      idempotencyKey: options.idempotencyKey || 'native-lost-response-key',
      fields: {
        subject,
        startsAt: '2026-09-03T14:00:00.000Z',
        endsAt: '2026-09-03T14:30:00.000Z',
        timezone: 'America/New_York',
        ...(includeSelection ? {
          calendarConnectionId: 'revoked-or-rebound-connection',
          calendarId: 'jarrett@bposupplychain.com',
        } : {}),
      },
    }),
  }
}
replayResponse = await replayingNativeMeetingRoute.POST(nativeMeetingRequest('Original meeting intent'))
assert.equal(replayResponse.status, 200)
assert.equal((await replayResponse.json()).record.referenceCode, ROUTE_REFERENCE)
assert.equal(nativeCalendarResolutionCalls, 0, 'native replay must precede selected/default Calendar resolution')
assert.equal(nativeHierarchyCalls, 0, 'native replay must precede mutable CRM restaging')
assert.equal(nativeStageCalls, 0)
replayResponse = await replayingNativeMeetingRoute.POST(nativeMeetingRequest('Original meeting intent', {
  includeSelection: false,
  idempotencyKey: 'native-default-binding-lost-response-key',
}))
assert.equal(replayResponse.status, 200)
assert.equal(nativeCalendarResolutionCalls, 0, 'native replay must ignore a changed organization Calendar default')
const nativeConflictResponse = await replayingNativeMeetingRoute.POST(nativeMeetingRequest('Changed retry intent'))
assert.equal(nativeConflictResponse.status, 409)
assert.equal((await nativeConflictResponse.json()).code, 'CRM_ACTION_IDEMPOTENCY_CONFLICT')
assert.equal(nativeCalendarResolutionCalls, 0)

const writes = []
let providerMode = 'alias-accepted'
const providerRequests = []
const service = loadTypeScriptModule('app_src/lib/integrations/organizationCommunications.ts', {
  '@/lib/integrations/matonGatewayCredentials': {
    resolveUserMatonGatewayCredential: async ({ ownerEmail, app, boundConnectionId }) => {
      if (boundConnectionId === 'other-actor-connection') throw new Error('connection owner mismatch')
      return {
        apiKey: 'secret-not-returned',
        connectionId: boundConnectionId,
        accountEmail: boundConnectionId === 'personal-calendar-connection'
          ? 'jarrettcrosby@gmail.com'
          : ownerEmail,
        app,
      }
    },
  },
  '@/lib/integrations/matonCredentials': {
    getMatonCredentialState: async () => ({
      connections: [
        {
          connectionId: 'mail-connection',
          name: 'Suburbia Gmail',
          app: 'google-mail',
          accountEmail: 'jarrett@suburbiasandwichco.com',
          status: 'ACTIVE',
          source: 'maton',
          selected: true,
        },
        {
          connectionId: 'personal-mail-connection',
          name: 'Personal Gmail',
          app: 'google-mail',
          accountEmail: 'jarrettcrosby@gmail.com',
          status: 'ACTIVE',
          source: 'maton',
          selected: false,
        },
        {
          connectionId: 'calendar-connection',
          name: 'Suburbia Google Calendar',
          app: 'google-calendar',
          accountEmail: 'jarrett@suburbiasandwichco.com',
          status: 'ACTIVE',
          source: 'maton',
          selected: true,
        },
        {
          connectionId: 'personal-calendar-connection',
          name: 'Personal Google Calendar',
          app: 'google-calendar',
          accountEmail: 'jarrettcrosby@gmail.com',
          status: 'ACTIVE',
          source: 'maton',
          selected: false,
        },
      ],
    }),
  },
  '@/lib/maton': {
    matonFetch: async (pathname, _init, context) => {
      providerRequests.push({ pathname, context })
      if (pathname.endsWith('/profile')) {
        return new Response(JSON.stringify({
          emailAddress: context.boundConnectionId === 'personal-mail-connection'
            ? 'jarrettcrosby@gmail.com'
            : 'jarrett@suburbiasandwichco.com',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (pathname.endsWith('/settings/sendAs')) {
        if (context.boundConnectionId === 'personal-mail-connection') {
          return new Response(JSON.stringify({ sendAs: [
            {
              sendAsEmail: 'jarrettcrosby@gmail.com',
              verificationStatus: 'accepted',
              isDefault: true,
            },
            {
              sendAsEmail: 'stewards@eigenracing.com',
              verificationStatus: 'accepted',
              isDefault: false,
            },
            {
              sendAsEmail: 'pending@example.com',
              verificationStatus: 'pending',
              isDefault: false,
            },
          ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ sendAs: [
          {
            sendAsEmail: 'jarrett@suburbiasandwichco.com',
            verificationStatus: 'accepted',
            isDefault: true,
          },
          {
            sendAsEmail: 'jarrett@bposupplychain.com',
            verificationStatus: providerMode === 'alias-accepted' ? 'accepted' : 'pending',
            isDefault: false,
          },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (pathname.includes('/calendarList?')) {
        if (context.boundConnectionId === 'personal-calendar-connection') {
          return new Response(JSON.stringify({ items: [
            {
              id: 'jarrettcrosby@gmail.com',
              summary: 'Jarrett personal',
              primary: true,
              accessRole: 'owner',
            },
          ] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ items: [
          {
            id: 'jarrett@suburbiasandwichco.com',
            summary: 'Suburbia primary calendar',
            primary: true,
            accessRole: 'owner',
          },
          {
            id: 'jarrett@bposupplychain.com',
            summary: 'BPO Supply Chain',
            accessRole: 'writer',
          },
          {
            id: 'readonly@example.com',
            summary: 'Read only',
            accessRole: 'reader',
          },
        ] }), {
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
    resolvePipelineCommunicationScopeInPostgres: async () => ({
      organizationId: '11111111-1111-4111-8111-111111111111',
    }),
    upsertOrganizationCommunicationBindingInPostgres: async (input) => writes.push(input),
  },
  '@/lib/users': { normalizeUserEmail },
})

assert.equal(service.normalizeOrganizationCommunicationApp('gmail'), 'google-mail')
assert.equal(service.normalizeOrganizationCommunicationApp('calendar'), 'google-calendar')
assert.throws(() => service.normalizeOrganizationCommunicationApp('drive'), /Gmail or Google Calendar/)

const gmailState = await service.bindOrganizationCommunication({
  organizationId: '11111111-1111-4111-8111-111111111111',
  actorEmail: 'jarrett@suburbiasandwichco.com',
  app: 'google-mail',
  connectionId: 'mail-connection',
  identityEmail: 'jarrett@bposupplychain.com',
})
assert.equal(writes[0].identityEmail, 'jarrett@bposupplychain.com')
assert.equal(writes[0].accountEmail, 'jarrett@suburbiasandwichco.com')
assert.equal(writes[0].calendarId, null)
assert.ok(providerRequests.some((request) => request.pathname.endsWith('/settings/sendAs')))
assert.ok(providerRequests.every((request) => [
  'mail-connection',
  'personal-mail-connection',
  'calendar-connection',
  'personal-calendar-connection',
].includes(request.context.boundConnectionId)))
assert.equal(
  JSON.stringify(gmailState.availableConnections.find((connection) => connection.connectionId === 'mail-connection')?.gmailSendAsIdentities),
  JSON.stringify([
    { email: 'jarrett@suburbiasandwichco.com', verificationStatus: 'accepted', isDefault: true },
    { email: 'jarrett@bposupplychain.com', verificationStatus: 'accepted', isDefault: false },
  ]),
)
assert.equal(
  gmailState.availableConnections.find((connection) => connection.connectionId === 'calendar-connection')?.calendars.length,
  2,
  'read-only calendars must not be offered',
)
assert.equal(
  JSON.stringify(gmailState.availableConnections
    .filter((connection) => connection.app === 'google-mail')
    .map((connection) => ({
      connectionId: connection.connectionId,
      identities: connection.gmailSendAsIdentities,
    }))),
  JSON.stringify([{
    connectionId: 'mail-connection',
    identities: [
      { email: 'jarrett@suburbiasandwichco.com', verificationStatus: 'accepted', isDefault: true },
      { email: 'jarrett@bposupplychain.com', verificationStatus: 'accepted', isDefault: false },
    ],
  }, {
    connectionId: 'personal-mail-connection',
    identities: [
      { email: 'jarrettcrosby@gmail.com', verificationStatus: 'accepted', isDefault: true },
      { email: 'pending@example.com', verificationStatus: 'pending', isDefault: false },
      { email: 'stewards@eigenracing.com', verificationStatus: 'accepted', isDefault: false },
    ],
  }]),
  'All linked Gmail accounts and provider-reported aliases must remain distinguishable for the UI',
)

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
const writesBeforeEmailSelections = writes.length
const bpoEmailSelection = await service.resolveVerifiedPipelineGmailSelection({
  pipelineId: '22222222-2222-4222-8222-222222222222',
  actorEmail: 'jarrett@suburbiasandwichco.com',
  connectionId: 'mail-connection',
  gmailSendAsEmail: 'jarrett@bposupplychain.com',
})
assert.equal(JSON.stringify(bpoEmailSelection), JSON.stringify({
  organizationId: '11111111-1111-4111-8111-111111111111',
  credentialOwnerEmail: 'jarrett@suburbiasandwichco.com',
  connectionId: 'mail-connection',
  accountEmail: 'jarrett@suburbiasandwichco.com',
  identityEmail: 'jarrett@bposupplychain.com',
  calendarId: null,
  source: 'email-override',
}))
const stewardsEmailSelection = await service.resolveVerifiedPipelineGmailSelection({
  pipelineId: '22222222-2222-4222-8222-222222222222',
  actorEmail: 'jarrett@suburbiasandwichco.com',
  connectionId: 'personal-mail-connection',
  gmailSendAsEmail: 'stewards@eigenracing.com',
})
assert.equal(stewardsEmailSelection.accountEmail, 'jarrettcrosby@gmail.com')
assert.equal(stewardsEmailSelection.identityEmail, 'stewards@eigenracing.com')
assert.equal(stewardsEmailSelection.connectionId, 'personal-mail-connection')
assert.equal(stewardsEmailSelection.source, 'email-override')
assert.equal(
  writes.length,
  writesBeforeEmailSelections,
  'Per-send Gmail selection must not mutate the organization default binding',
)
await assert.rejects(
  service.resolveVerifiedPipelineGmailSelection({
    pipelineId: '22222222-2222-4222-8222-222222222222',
    actorEmail: 'jarrett@suburbiasandwichco.com',
    connectionId: 'personal-mail-connection',
    gmailSendAsEmail: 'pending@example.com',
  }),
  (error) => error?.code === 'ORGANIZATION_COMMUNICATION_SENDER_NOT_VERIFIED',
)
await assert.rejects(
  service.resolveVerifiedPipelineGmailSelection({
    pipelineId: '22222222-2222-4222-8222-222222222222',
    actorEmail: 'jarrett@suburbiasandwichco.com',
    connectionId: 'other-actor-connection',
    gmailSendAsEmail: 'other@example.com',
  }),
  (error) => error?.code === 'ORGANIZATION_COMMUNICATION_CONNECTION_INVALID',
)

await service.bindOrganizationCommunication({
  organizationId: '11111111-1111-4111-8111-111111111111',
  actorEmail: 'jarrett@suburbiasandwichco.com',
  app: 'google-calendar',
  connectionId: 'calendar-connection',
  calendarId: 'jarrett@bposupplychain.com',
})
assert.equal(writes[1].identityEmail, 'jarrett@bposupplychain.com')
assert.equal(writes[1].accountEmail, 'jarrett@suburbiasandwichco.com')
assert.equal(writes[1].calendarId, 'jarrett@bposupplychain.com')

await assert.rejects(
  service.bindOrganizationCommunication({
    organizationId: '11111111-1111-4111-8111-111111111111',
    actorEmail: 'jarrett@suburbiasandwichco.com',
    app: 'google-calendar',
    connectionId: 'calendar-connection',
    calendarId: 'readonly@example.com',
  }),
  (error) => error?.code === 'ORGANIZATION_COMMUNICATION_CALENDAR_NOT_WRITABLE',
)

await assert.rejects(
  service.bindOrganizationCommunication({
    organizationId: '11111111-1111-4111-8111-111111111111',
    actorEmail: 'jarrett@suburbiasandwichco.com',
    app: 'google-calendar',
    connectionId: 'calendar-connection',
    calendarId: 'jarrett@bposupplychain.com',
    identityEmail: 'jarrett@suburbiasandwichco.com',
  }),
  /organizer identity is derived/,
)

const writesBeforeMeetingSelections = writes.length
const bpoMeetingSelection = await service.resolveVerifiedPipelineCalendarSelection({
  pipelineId: '22222222-2222-4222-8222-222222222222',
  actorEmail: 'jarrett@suburbiasandwichco.com',
  connectionId: 'calendar-connection',
  calendarId: 'jarrett@bposupplychain.com',
})
assert.equal(bpoMeetingSelection.organizationId, '11111111-1111-4111-8111-111111111111')
assert.equal(bpoMeetingSelection.credentialOwnerEmail, 'jarrett@suburbiasandwichco.com')
assert.equal(bpoMeetingSelection.connectionId, 'calendar-connection')
assert.equal(bpoMeetingSelection.accountEmail, 'jarrett@suburbiasandwichco.com')
assert.equal(bpoMeetingSelection.identityEmail, 'jarrett@bposupplychain.com')
assert.equal(bpoMeetingSelection.calendarId, 'jarrett@bposupplychain.com')
assert.equal(bpoMeetingSelection.source, 'meeting-override')

const personalMeetingSelection = await service.resolveVerifiedPipelineCalendarSelection({
  pipelineId: '22222222-2222-4222-8222-222222222222',
  actorEmail: 'jarrett@suburbiasandwichco.com',
  connectionId: 'personal-calendar-connection',
  calendarId: 'jarrettcrosby@gmail.com',
})
assert.equal(personalMeetingSelection.connectionId, 'personal-calendar-connection')
assert.equal(personalMeetingSelection.accountEmail, 'jarrettcrosby@gmail.com')
assert.equal(personalMeetingSelection.identityEmail, 'jarrettcrosby@gmail.com')
assert.equal(personalMeetingSelection.calendarId, 'jarrettcrosby@gmail.com')
assert.equal(personalMeetingSelection.source, 'meeting-override')
assert.equal(
  writes.length,
  writesBeforeMeetingSelections,
  'per-meeting Calendar selection must not mutate the organization default binding',
)

await assert.rejects(
  service.resolveVerifiedPipelineCalendarSelection({
    pipelineId: '22222222-2222-4222-8222-222222222222',
    actorEmail: 'jarrett@suburbiasandwichco.com',
    connectionId: 'calendar-connection',
    calendarId: 'readonly@example.com',
  }),
  (error) => error?.code === 'ORGANIZATION_COMMUNICATION_CALENDAR_NOT_WRITABLE',
)

await assert.rejects(
  service.resolveVerifiedPipelineCalendarSelection({
    pipelineId: '22222222-2222-4222-8222-222222222222',
    actorEmail: 'jarrett@suburbiasandwichco.com',
    connectionId: 'other-actor-connection',
    calendarId: 'other@example.com',
  }),
  (error) => error?.code === 'ORGANIZATION_COMMUNICATION_CONNECTION_INVALID',
)

console.log('organization communications contract tests passed')
