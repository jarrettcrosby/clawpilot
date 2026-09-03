import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

type TimestampValue = string | Date

export type OrganizationCommunicationApp = 'google-mail' | 'google-calendar'
export type OrganizationCommunicationBindingSource = 'organization' | 'user-default' | 'meeting-override'
export type OrganizationCommunicationBindingStatus = 'active' | 'disabled'

type OrganizationCommunicationBindingRow = {
  organization_id: string
  app: OrganizationCommunicationApp
  credential_owner_email: string
  maton_connection_id: string
  account_email: string
  identity_email: string
  calendar_id: string | null
  status: OrganizationCommunicationBindingStatus
  verified_at: TimestampValue
  verified_by: string | null
  created_by: string | null
  updated_by: string | null
  created_at: TimestampValue
  updated_at: TimestampValue
}

type PipelineCommunicationResolutionRow = {
  organization_id: string
  actor_membership_status: string | null
  organization_binding_exists: boolean
  organization_binding_valid: boolean
  credential_owner_email: string | null
  connection_id: string | null
  account_email: string | null
  identity_email: string | null
  calendar_id: string | null
  source: OrganizationCommunicationBindingSource | null
}

export type OrganizationCommunicationBinding = {
  organizationId: string
  app: OrganizationCommunicationApp
  credentialOwnerEmail: string
  connectionId: string
  accountEmail: string
  identityEmail: string
  calendarId: string | null
  status: OrganizationCommunicationBindingStatus
  verifiedAt: string
  verifiedBy: string | null
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

export type PipelineCommunicationSnapshot = {
  organizationId: string
  credentialOwnerEmail: string
  connectionId: string
  accountEmail: string
  identityEmail: string
  calendarId: string | null
  source: OrganizationCommunicationBindingSource
}

export type PipelineCommunicationScope = {
  organizationId: string
}

export class OrganizationCommunicationPersistenceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'ORGANIZATION_COMMUNICATION_INVALID',
  ) {
    super(message)
    this.name = 'OrganizationCommunicationPersistenceError'
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const CONNECTION_ID_PATTERN = /^[\x21-\x7e]+$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

function iso(value: TimestampValue): string {
  return new Date(value).toISOString()
}

function binding(row: OrganizationCommunicationBindingRow): OrganizationCommunicationBinding {
  return {
    organizationId: row.organization_id,
    app: row.app,
    credentialOwnerEmail: row.credential_owner_email,
    connectionId: row.maton_connection_id,
    accountEmail: row.account_email,
    identityEmail: row.identity_email,
    calendarId: row.calendar_id,
    status: row.status,
    verifiedAt: iso(row.verified_at),
    verifiedBy: row.verified_by,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function normalizeUuid(value: string, label: string): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(normalized)) {
    throw new OrganizationCommunicationPersistenceError(
      `A valid ${label} is required`,
      400,
      'ORGANIZATION_COMMUNICATION_SCOPE_INVALID',
    )
  }
  return normalized
}

function normalizeApp(value: OrganizationCommunicationApp): OrganizationCommunicationApp {
  if (value !== 'google-mail' && value !== 'google-calendar') {
    throw new OrganizationCommunicationPersistenceError(
      'Communication application must be Gmail or Google Calendar',
    )
  }
  return value
}

function normalizeEmail(value: string, label: string): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (
    normalized.length < 3
    || normalized.length > 254
    || !EMAIL_PATTERN.test(normalized)
    || !CONNECTION_ID_PATTERN.test(normalized)
  ) {
    throw new OrganizationCommunicationPersistenceError(`A valid ${label} is required`)
  }
  return normalized
}

function normalizeOptionalEmail(value: string | null | undefined, label: string): string | null {
  const normalized = String(value || '').trim()
  return normalized ? normalizeEmail(normalized, label) : null
}

function normalizeConnectionId(value: string): string {
  const normalized = String(value || '').trim()
  if (
    !normalized
    || normalized.length > 512
    || !CONNECTION_ID_PATTERN.test(normalized)
  ) {
    throw new OrganizationCommunicationPersistenceError('A valid Maton connection is required')
  }
  return normalized
}

function normalizeCalendarId(
  app: OrganizationCommunicationApp,
  value: string | null,
): string | null {
  const normalized = String(value || '').trim()
  if (app === 'google-mail') {
    if (normalized) {
      throw new OrganizationCommunicationPersistenceError('Gmail bindings cannot select a calendar')
    }
    return null
  }
  if (!normalized || normalized.length > 1024 || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new OrganizationCommunicationPersistenceError('A valid Google Calendar ID is required')
  }
  return normalized
}

async function requireActiveMembership(
  client: PoolClient,
  input: {
    organizationId: string
    userEmail: string
    label: 'actor' | 'credential owner'
  },
): Promise<void> {
  const result = await client.query<{ status: string }>(
    `SELECT membership.status
     FROM app_user_organization_memberships membership
     WHERE membership.organization_id = $1::uuid
       AND membership.user_email = $2
     FOR SHARE`,
    [input.organizationId, input.userEmail],
  )
  if (result.rows[0]?.status !== 'active') {
    throw new OrganizationCommunicationPersistenceError(
      `The communication ${input.label} must be an active organization member`,
      403,
      'ORGANIZATION_COMMUNICATION_MEMBERSHIP_REQUIRED',
    )
  }
}

export async function listOrganizationCommunicationBindingsInPostgres(
  organizationId: string,
): Promise<OrganizationCommunicationBinding[]> {
  const normalizedOrganizationId = normalizeUuid(organizationId, 'organization ID')
  const result = await query<OrganizationCommunicationBindingRow>(
    `SELECT
       organization_id::text,
       app,
       credential_owner_email,
       maton_connection_id,
       account_email,
       identity_email,
       calendar_id,
       status,
       verified_at,
       verified_by,
       created_by,
       updated_by,
       created_at,
       updated_at
     FROM organization_communication_bindings
     WHERE organization_id = $1::uuid
     ORDER BY app ASC`,
    [normalizedOrganizationId],
  )
  return result.rows.map(binding)
}

export async function readOrganizationCommunicationBindingInPostgres(input: {
  organizationId: string
  app: OrganizationCommunicationApp
}): Promise<OrganizationCommunicationBinding | null> {
  const organizationId = normalizeUuid(input.organizationId, 'organization ID')
  const app = normalizeApp(input.app)
  const result = await query<OrganizationCommunicationBindingRow>(
    `SELECT
       organization_id::text,
       app,
       credential_owner_email,
       maton_connection_id,
       account_email,
       identity_email,
       calendar_id,
       status,
       verified_at,
       verified_by,
       created_by,
       updated_by,
       created_at,
       updated_at
     FROM organization_communication_bindings
     WHERE organization_id = $1::uuid
       AND app = $2
     LIMIT 1`,
    [organizationId, app],
  )
  return result.rows[0] ? binding(result.rows[0]) : null
}

export async function upsertOrganizationCommunicationBindingInPostgres(input: {
  organizationId: string
  app: OrganizationCommunicationApp
  credentialOwnerEmail: string
  connectionId: string
  accountEmail?: string | null
  identityEmail: string | null
  calendarId: string | null
  actorEmail: string
}): Promise<OrganizationCommunicationBinding> {
  const organizationId = normalizeUuid(input.organizationId, 'organization ID')
  const app = normalizeApp(input.app)
  const credentialOwnerEmail = normalizeEmail(input.credentialOwnerEmail, 'credential owner email')
  const actorEmail = normalizeEmail(input.actorEmail, 'actor email')
  const connectionId = normalizeConnectionId(input.connectionId)
  const verifiedAccountEmail = normalizeOptionalEmail(input.accountEmail, 'provider account email')
  const identityEmail = normalizeOptionalEmail(input.identityEmail, 'communication identity email')
  if (!identityEmail) {
    throw new OrganizationCommunicationPersistenceError(
      'A verified communication identity email is required',
    )
  }
  const calendarId = normalizeCalendarId(app, input.calendarId)

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `organization-communication-binding:${organizationId}:${app}`,
    )
    await requireActiveMembership(client, {
      organizationId,
      userEmail: actorEmail,
      label: 'actor',
    })
    if (credentialOwnerEmail !== actorEmail) {
      await requireActiveMembership(client, {
        organizationId,
        userEmail: credentialOwnerEmail,
        label: 'credential owner',
      })
    }

    const connectionResult = await client.query<{ account_email: string | null }>(
      `SELECT connection.account_email
       FROM user_maton_connections connection
       WHERE connection.owner_email = $1
         AND connection.connection_id = $2
         AND connection.app = $3
         AND connection.status = 'ACTIVE'
         AND connection.source = 'maton'
       FOR SHARE`,
      [credentialOwnerEmail, connectionId, app],
    )
    const connection = connectionResult.rows[0]
    if (!connection) {
      throw new OrganizationCommunicationPersistenceError(
        'The selected Maton connection is not active for this credential owner and application',
        409,
        'ORGANIZATION_COMMUNICATION_CONNECTION_INVALID',
      )
    }
    const storedAccountEmail = normalizeOptionalEmail(
      connection.account_email,
      'stored provider account email',
    )
    if (
      verifiedAccountEmail
      && storedAccountEmail
      && verifiedAccountEmail !== storedAccountEmail
    ) {
      throw new OrganizationCommunicationPersistenceError(
        'The verified provider account does not match the stored Maton connection',
        409,
        'ORGANIZATION_COMMUNICATION_ACCOUNT_MISMATCH',
      )
    }
    const accountEmail = storedAccountEmail ?? verifiedAccountEmail
    if (!accountEmail) {
      throw new OrganizationCommunicationPersistenceError(
        'A verified provider account email is required',
        409,
        'ORGANIZATION_COMMUNICATION_ACCOUNT_REQUIRED',
      )
    }

    const result = await client.query<OrganizationCommunicationBindingRow>(
      `INSERT INTO organization_communication_bindings (
         organization_id,
         app,
         credential_owner_email,
         maton_connection_id,
         account_email,
         identity_email,
         calendar_id,
         status,
         verified_at,
         verified_by,
         created_by,
         updated_by,
         created_at,
         updated_at
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, 'active', now(), $8, $8, $8, now(), now()
       )
       ON CONFLICT (organization_id, app) DO UPDATE SET
         credential_owner_email = EXCLUDED.credential_owner_email,
         maton_connection_id = EXCLUDED.maton_connection_id,
         account_email = EXCLUDED.account_email,
         identity_email = EXCLUDED.identity_email,
         calendar_id = EXCLUDED.calendar_id,
         status = 'active',
         verified_at = now(),
         verified_by = EXCLUDED.verified_by,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING
         organization_id::text,
         app,
         credential_owner_email,
         maton_connection_id,
         account_email,
         identity_email,
         calendar_id,
         status,
         verified_at,
         verified_by,
         created_by,
         updated_by,
         created_at,
         updated_at`,
      [
        organizationId,
        app,
        credentialOwnerEmail,
        connectionId,
        accountEmail,
        identityEmail,
        calendarId,
        actorEmail,
      ],
    )
    const saved = binding(result.rows[0])
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'organization.communication_binding.upserted',
      aggregateType: 'organization_communication_binding',
      aggregateId: `${organizationId}:${app}`,
      organizationId,
      payload: {
        app,
        credentialOwnerEmail,
        connectionId,
        accountEmail,
        identityEmail,
        calendarId,
        status: 'active',
      },
    }, client)
    return saved
  })
}

export async function deleteOrganizationCommunicationBindingInPostgres(input: {
  organizationId: string
  app: OrganizationCommunicationApp
  actorEmail: string
}): Promise<boolean> {
  const organizationId = normalizeUuid(input.organizationId, 'organization ID')
  const app = normalizeApp(input.app)
  const actorEmail = normalizeEmail(input.actorEmail, 'actor email')
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `organization-communication-binding:${organizationId}:${app}`,
    )
    await requireActiveMembership(client, {
      organizationId,
      userEmail: actorEmail,
      label: 'actor',
    })
    const deleted = await client.query<{
      credential_owner_email: string
      maton_connection_id: string
    }>(
      `DELETE FROM organization_communication_bindings
       WHERE organization_id = $1::uuid
         AND app = $2
       RETURNING credential_owner_email, maton_connection_id`,
      [organizationId, app],
    )
    const previous = deleted.rows[0]
    if (!previous) return false
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'organization.communication_binding.deleted',
      aggregateType: 'organization_communication_binding',
      aggregateId: `${organizationId}:${app}`,
      organizationId,
      payload: {
        app,
        credentialOwnerEmail: previous.credential_owner_email,
        connectionId: previous.maton_connection_id,
      },
    }, client)
    return true
  })
}

export async function resolvePipelineCommunicationScopeInPostgres(input: {
  pipelineId: string
  actorEmail: string
}): Promise<PipelineCommunicationScope> {
  const pipelineId = normalizeUuid(input.pipelineId, 'pipeline ID')
  const actorEmail = normalizeEmail(input.actorEmail, 'actor email')
  const result = await query<{
    organization_id: string
    actor_membership_status: string | null
  }>(
    `SELECT
       pipeline.workspace_organization_id::text AS organization_id,
       actor_membership.status AS actor_membership_status
     FROM pipeline_spaces pipeline
     LEFT JOIN app_user_organization_memberships actor_membership
       ON actor_membership.organization_id = pipeline.workspace_organization_id
      AND actor_membership.user_email = $2
     WHERE pipeline.id = $1::uuid
     LIMIT 1`,
    [pipelineId, actorEmail],
  )
  const row = result.rows[0]
  if (!row) {
    throw new OrganizationCommunicationPersistenceError(
      'The communication pipeline was not found',
      404,
      'ORGANIZATION_COMMUNICATION_PIPELINE_NOT_FOUND',
    )
  }
  if (row.actor_membership_status !== 'active') {
    throw new OrganizationCommunicationPersistenceError(
      'The communication actor must be an active pipeline organization member',
      403,
      'ORGANIZATION_COMMUNICATION_MEMBERSHIP_REQUIRED',
    )
  }
  return { organizationId: row.organization_id }
}

export async function resolvePipelineCommunicationSnapshotInPostgres(input: {
  pipelineId: string
  actorEmail: string
  app: OrganizationCommunicationApp
}): Promise<PipelineCommunicationSnapshot> {
  const pipelineId = normalizeUuid(input.pipelineId, 'pipeline ID')
  const actorEmail = normalizeEmail(input.actorEmail, 'actor email')
  const app = normalizeApp(input.app)
  const result = await query<PipelineCommunicationResolutionRow>(
    `WITH pipeline_scope AS (
       SELECT
         pipeline.workspace_organization_id AS organization_id,
         actor_membership.status AS actor_membership_status
       FROM pipeline_spaces pipeline
       LEFT JOIN app_user_organization_memberships actor_membership
         ON actor_membership.organization_id = pipeline.workspace_organization_id
        AND actor_membership.user_email = $2
       WHERE pipeline.id = $1::uuid
     ), configured_binding AS (
       SELECT
         binding.credential_owner_email,
         binding.maton_connection_id AS connection_id,
         binding.account_email,
         binding.identity_email,
         binding.calendar_id,
         (
           binding.status = 'active'
           AND owner_membership.status = 'active'
           AND connection.owner_email IS NOT NULL
           AND connection.app = binding.app
           AND connection.status = 'ACTIVE'
           AND connection.source = 'maton'
           AND (
             connection.account_email IS NULL
             OR connection.account_email IS NOT DISTINCT FROM binding.account_email
           )
           AND binding.identity_email IS NOT NULL
           AND (
             (binding.app = 'google-mail' AND binding.calendar_id IS NULL)
             OR (
               binding.app = 'google-calendar'
               AND binding.calendar_id IS NOT NULL
               AND binding.calendar_id = btrim(binding.calendar_id)
               AND char_length(binding.calendar_id) BETWEEN 1 AND 1024
               AND binding.calendar_id !~ '[[:cntrl:]]'
             )
           )
         ) AS valid
       FROM pipeline_scope scope
       JOIN organization_communication_bindings binding
         ON binding.organization_id = scope.organization_id
        AND binding.app = $3
       LEFT JOIN app_user_organization_memberships owner_membership
         ON owner_membership.organization_id = binding.organization_id
        AND owner_membership.user_email = binding.credential_owner_email
       LEFT JOIN user_maton_connections connection
         ON connection.owner_email = binding.credential_owner_email
        AND connection.connection_id = binding.maton_connection_id
       LIMIT 1
     ), organization_binding AS (
       SELECT
         configured_binding.credential_owner_email,
         configured_binding.connection_id,
         configured_binding.account_email,
         configured_binding.identity_email,
         configured_binding.calendar_id
       FROM configured_binding
       WHERE configured_binding.valid
     ), user_default AS (
       SELECT
         connection.owner_email AS credential_owner_email,
         connection.connection_id,
         connection.account_email,
         connection.account_email AS identity_email,
         CASE WHEN connection.app = 'google-calendar' THEN 'primary' ELSE NULL END AS calendar_id
       FROM pipeline_scope scope
       JOIN user_maton_connections connection
         ON connection.owner_email = $2
        AND connection.app = $3
        AND connection.status = 'ACTIVE'
        AND connection.source = 'maton'
        AND connection.is_selected
       WHERE scope.actor_membership_status = 'active'
         AND connection.account_email IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM configured_binding)
       LIMIT 1
     ), resolved AS (
       SELECT
         organization_binding.credential_owner_email,
         organization_binding.connection_id,
         organization_binding.account_email,
         organization_binding.identity_email,
         organization_binding.calendar_id,
         'organization'::text AS source,
         0 AS priority
       FROM organization_binding
       UNION ALL
       SELECT
         user_default.credential_owner_email,
         user_default.connection_id,
         user_default.account_email,
         user_default.identity_email,
         user_default.calendar_id,
         'user-default'::text AS source,
         1 AS priority
       FROM user_default
     )
     SELECT
       scope.organization_id::text,
       scope.actor_membership_status,
       EXISTS (SELECT 1 FROM configured_binding) AS organization_binding_exists,
       COALESCE((SELECT configured_binding.valid FROM configured_binding), false)
         AS organization_binding_valid,
       selected.credential_owner_email,
       selected.connection_id,
       selected.account_email,
       selected.identity_email,
       selected.calendar_id,
       selected.source
     FROM pipeline_scope scope
     LEFT JOIN LATERAL (
       SELECT *
       FROM resolved
       ORDER BY priority ASC
       LIMIT 1
     ) selected ON true`,
    [pipelineId, actorEmail, app],
  )
  const row = result.rows[0]
  if (!row) {
    throw new OrganizationCommunicationPersistenceError(
      'The communication pipeline was not found',
      404,
      'ORGANIZATION_COMMUNICATION_PIPELINE_NOT_FOUND',
    )
  }
  if (row.actor_membership_status !== 'active') {
    throw new OrganizationCommunicationPersistenceError(
      'The communication actor must be an active pipeline organization member',
      403,
      'ORGANIZATION_COMMUNICATION_MEMBERSHIP_REQUIRED',
    )
  }
  if (row.organization_binding_exists && !row.organization_binding_valid) {
    throw new OrganizationCommunicationPersistenceError(
      'The organization communication binding is no longer active or no longer matches its stored Maton connection',
      409,
      'ORGANIZATION_COMMUNICATION_BINDING_INVALID',
    )
  }
  if (
    !row.credential_owner_email
    || !row.connection_id
    || !row.account_email
    || !row.identity_email
    || !row.source
  ) {
    throw new OrganizationCommunicationPersistenceError(
      'No active organization or user-default communication connection is available',
      409,
      'ORGANIZATION_COMMUNICATION_CONNECTION_REQUIRED',
    )
  }
  const snapshot = {
    organizationId: row.organization_id,
    credentialOwnerEmail: row.credential_owner_email,
    connectionId: row.connection_id,
    accountEmail: row.account_email,
    identityEmail: row.identity_email,
    calendarId: row.calendar_id,
  }
  if (row.source === 'organization') return { ...snapshot, source: 'organization' }
  return { ...snapshot, source: 'user-default' }
}
