import crypto from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  processCalendarDiscovery,
  type CalendarDiscoveryCursor,
  type CalendarDiscoveryEvent,
  type CalendarDiscoverySource,
  type CalendarDiscoveryStore,
} from '@/lib/crm/calendarDiscovery'
import { crmParticipantEmailCandidatesSql } from '@/lib/crm/participantEligibility'
import { resolveVerifiedPipelineCalendarSelection } from '@/lib/integrations/organizationCommunications'
import { matonFetch } from '@/lib/maton'
import { stageCrmRecordWithClient } from '@/lib/persistence/crm'
import { getPostgresPool, query, withTransaction } from '@/lib/persistence/postgres'

type SourceRow = {
  id: string; pipeline_id: string; workspace_organization_id: string
  credential_owner_email: string; connection_id: string; calendar_id: string
  account_email: string; time_zone: string; enabled: boolean
  cursor_state: CalendarDiscoveryCursor | null
  last_polled_at: Date | string | null; last_error: string | null
}

export class CalendarDiscoveryConfigurationError extends Error {
  constructor(message: string, readonly status = 409) { super(message) }
}

const SOURCE_SELECT = `SELECT source.* FROM crm_calendar_discovery_sources source
  JOIN pipeline_spaces pipeline ON pipeline.id = source.pipeline_id
    AND pipeline.workspace_organization_id = source.workspace_organization_id
    AND lower(pipeline.owner_email) = source.credential_owner_email
    AND NOT pipeline.reference_access_disabled
  JOIN app_users app_user ON app_user.email = source.credential_owner_email AND app_user.status = 'active'
  JOIN app_user_organization_memberships membership
    ON membership.user_email = source.credential_owner_email
    AND membership.organization_id = source.workspace_organization_id AND membership.status = 'active'
  JOIN user_maton_connections connection
    ON connection.owner_email = source.credential_owner_email
    AND connection.connection_id = source.connection_id
    AND connection.app = 'google-calendar' AND connection.status = 'ACTIVE' AND connection.source = 'maton'`

function source(row: SourceRow): CalendarDiscoverySource {
  return {
    id: row.id, pipelineId: row.pipeline_id, workspaceOrganizationId: row.workspace_organization_id,
    credentialOwnerEmail: row.credential_owner_email, connectionId: row.connection_id,
    calendarId: row.calendar_id, accountEmail: row.account_email, timeZone: row.time_zone,
  }
}

function sameSource(row: SourceRow | undefined, expected: CalendarDiscoverySource): row is SourceRow {
  return Boolean(row?.enabled && row.id === expected.id && row.pipeline_id === expected.pipelineId
    && row.workspace_organization_id === expected.workspaceOrganizationId
    && row.credential_owner_email === expected.credentialOwnerEmail && row.connection_id === expected.connectionId
    && row.calendar_id === expected.calendarId && row.account_email === expected.accountEmail
    && row.time_zone === expected.timeZone)
}

async function lockedSource(client: PoolClient, expected: CalendarDiscoverySource) {
  const result = await client.query<SourceRow>(`${SOURCE_SELECT}
    WHERE source.id = $1::uuid AND source.enabled
    FOR SHARE OF source, pipeline, app_user, membership, connection`, [expected.id])
  return sameSource(result.rows[0], expected)
}

type MeetingRow = {
  id: string; source_key: string; source_payload: Record<string, unknown>
  organization_id: string | null; contact_id: string | null; lead_id: string | null
  opportunity_id: string | null; subject: string; description: string | null
  starts_at: Date | string; ends_at: Date | string; timezone: string
  location: string | null; attendee_emails: string[]; status: 'planned' | 'queued' | 'scheduled' | 'completed' | 'cancelled' | 'failed'
  external_event_url: string | null; join_url: string | null; event_hash: string | null
  updated_at: Date | string
}

async function reconcileEvent(current: CalendarDiscoverySource, event: CalendarDiscoveryEvent) {
  return withTransaction(async (client) => {
    if (!await lockedSource(client, current)) return { status: 'deferred' as const }
    // Serialize event identity across worker passes and reconnects before lookup.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `crm-calendar-discovery:${current.pipelineId}:${current.calendarId}:${event.externalEventId}`,
    ])
    const mapped = await client.query<MeetingRow>(`SELECT meeting.*, mapping.event_hash
      FROM crm_calendar_discovery_events mapping JOIN crm_meetings meeting
        ON meeting.pipeline_id = mapping.pipeline_id AND meeting.id = mapping.meeting_id
      WHERE mapping.pipeline_id = $1::uuid AND mapping.calendar_id = $2 AND mapping.external_event_id = $3
      FOR UPDATE OF meeting`, [current.pipelineId, current.calendarId, event.externalEventId])
    let meeting = mapped.rows[0]
    if (!meeting) {
      // Adopt an app-created event only with exact recorded calendar identity.
      // Never trust a provider description/reference alone to pick another event.
      const known = await client.query<MeetingRow>(`SELECT meeting.*, NULL::text AS event_hash
        FROM crm_meetings meeting
        WHERE meeting.pipeline_id = $1::uuid
          AND meeting.external_event_id = $2
          AND meeting.source_payload->>'calendarId' = $3
          AND lower(meeting.source_payload->>'calendarOwnerEmail') = $4
        ORDER BY meeting.id LIMIT 2 FOR UPDATE`, [
        current.pipelineId, event.externalEventId, current.calendarId, current.credentialOwnerEmail,
      ])
      if (known.rows.length > 1) return { status: 'ambiguous' as const }
      meeting = known.rows[0]
    }
    if (meeting && ['true', '1', 'yes'].includes(String(meeting.source_payload?.archived ?? '').toLowerCase())) {
      return { status: 'skipped' as const }
    }
    if (meeting && (!Number.isFinite(Date.parse(event.observedAt))
      || new Date(meeting.updated_at).getTime() > Date.parse(event.observedAt))) {
      // A page fetched before a local save must not overwrite that save even
      // if its outbound action has already completed by the time we get a lock.
      return { status: 'deferred' as const }
    }
    if (meeting) {
      const pending = await client.query(`SELECT 1 FROM crm_integration_actions
        WHERE pipeline_id = $1::uuid AND aggregate_type = 'crm_meeting' AND aggregate_id = $2
          AND app = 'google-calendar' AND action_type = 'create_calendar_event'
          AND status IN ('queued', 'processing', 'failed', 'dead') LIMIT 1`, [current.pipelineId, meeting.id])
      // Preserve unsent local intent, including a failed edit awaiting review.
      // No action lock: dispatch can hold that row while waiting for the meeting.
      if (pending.rowCount) return { status: 'deferred' as const }
    }
    if (!meeting && (!event.allowCreate || event.status === 'cancelled')) return { status: 'skipped' as const }
    if (!meeting && event.clawpilotMeetingReference) {
      // A marked but unrecognized event needs explicit reconciliation, not a copy.
      return { status: 'skipped' as const }
    }
    const candidates = event.status === 'cancelled' ? { rows: [] } : await client.query<{
      id: string; organization_id: string | null; email: string; entity: string
    }>(crmParticipantEmailCandidatesSql(), [[current.pipelineId], event.matchingAttendeeEmails])
    const contacts = candidates.rows.filter((row) => row.entity === 'contacts')
    if (candidates.rows.length > 100) return { status: 'ambiguous' as const }
    if (event.status !== 'cancelled') {
      if (!contacts.length) return { status: meeting ? 'skipped' as const : 'unmatched' as const }
      if (new Set(contacts.map((row) => row.organization_id || row.id)).size !== 1
        || contacts.some((row) => contacts.filter((other) => other.email === row.email).length > 1)) {
        return { status: 'ambiguous' as const }
      }
      // Never silently move an existing meeting to another customer account.
      if (meeting && meeting.organization_id !== contacts[0].organization_id) return { status: 'ambiguous' as const }
    }
    const contactIds = contacts.map((row) => row.id).sort()
    const digest = crypto.createHash('sha256').update(JSON.stringify({
      event: { ...event, observedAt: undefined }, contactIds,
    })).digest('hex')
    if (meeting?.event_hash === digest) return { status: 'unchanged' as const }
    const cancelled = event.status === 'cancelled'
    const existingPayload = meeting?.source_payload || {}
    const organizationId = cancelled ? meeting!.organization_id : contacts[0].organization_id
    const parent = organizationId ? await client.query<{ suitecrm_id: string | null }>(
      'SELECT suitecrm_id FROM crm_organizations WHERE pipeline_id = $1::uuid AND id = $2::uuid',
      [current.pipelineId, organizationId]) : { rows: [] }
    const googleMeet = event.joinUrl ? new URL(event.joinUrl).hostname === 'meet.google.com' : false
    const staged = await stageCrmRecordWithClient(client, {
      entity: 'meetings', pipelineId: current.pipelineId, actorEmail: current.credentialOwnerEmail,
      ...(meeting ? { localId: meeting.id } : {}),
      sourceKey: meeting?.source_key || `calendar-discovery:${crypto.createHash('sha256')
        .update(JSON.stringify([current.calendarId, event.externalEventId])).digest('hex')}`,
      sourcePayload: {
        ...existingPayload,
        ...(meeting ? {} : { source: 'google_calendar_discovery' }),
        calendarOwnerEmail: current.credentialOwnerEmail, calendarConnectionId: current.connectionId,
        calendarOrganizerEmail: current.calendarId, calendarId: current.calendarId,
        communicationOrganizationId: current.workspaceOrganizationId,
        calendarDiscovery: { sourceId: current.id, eventId: event.externalEventId,
          recurringEventId: event.recurringEventId, originalStartTime: event.originalStartTime },
        ...(cancelled ? {} : { meetingMode: googleMeet ? 'google_meet' : event.joinUrl ? 'custom_link' : event.location ? 'in_person' : 'unspecified',
          customJoinUrl: event.joinUrl && !googleMeet ? event.joinUrl : null }),
      },
      fields: {
        organizationId,
        organizationSuiteCrmId: parent.rows[0]?.suitecrm_id,
        parentSuiteCrmId: parent.rows[0]?.suitecrm_id,
        parentSuiteCrmType: parent.rows[0]?.suitecrm_id ? 'Accounts' : undefined,
        ...(cancelled ? { contactId: meeting!.contact_id } : { contactIds }),
        leadId: meeting?.lead_id, opportunityId: meeting?.opportunity_id,
        subject: cancelled ? meeting!.subject : event.subject,
        description: cancelled ? meeting!.description || '' : event.description,
        startsAt: cancelled ? new Date(meeting!.starts_at).toISOString() : event.startsAt!,
        endsAt: cancelled ? new Date(meeting!.ends_at).toISOString() : event.endsAt!,
        timezone: cancelled ? meeting!.timezone : event.timeZone,
        location: cancelled ? meeting!.location || '' : event.location,
        attendeeEmails: cancelled ? meeting!.attendee_emails : event.attendeeEmails,
        status: cancelled ? 'cancelled' : (meeting?.status === 'completed' ? 'completed' : 'scheduled'),
        provider: 'google-calendar', externalEventId: event.externalEventId,
        externalEventUrl: event.externalEventUrl || meeting?.external_event_url,
        joinUrl: cancelled ? meeting!.join_url : event.joinUrl,
        replaceConferenceDetails: !cancelled,
      },
    })
    await client.query(`INSERT INTO crm_calendar_discovery_events
      (pipeline_id, source_id, calendar_id, external_event_id, meeting_id, event_hash)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)
      ON CONFLICT (pipeline_id, calendar_id, external_event_id) DO UPDATE SET
        source_id = EXCLUDED.source_id, event_hash = EXCLUDED.event_hash, updated_at = now()`, [
      current.pipelineId, current.id, current.calendarId, event.externalEventId, staged.id, digest,
    ])
    return { status: meeting ? 'updated' as const : 'created' as const }
  })
}

export const calendarDiscoveryStore: CalendarDiscoveryStore = {
  async isAuthorized(current) {
    const rows = await query<SourceRow>(`${SOURCE_SELECT} WHERE source.id = $1::uuid AND source.enabled`, [current.id])
    return sameSource(rows.rows[0], current)
  },
  async readCursor(current) {
    const result = await query<SourceRow>(`${SOURCE_SELECT} WHERE source.id = $1::uuid AND source.enabled`, [current.id])
    if (!sameSource(result.rows[0], current)) throw new Error('Calendar import source is no longer authorized')
    return result.rows[0].cursor_state
  },
  async writeCursor(current, cursor, error = null) {
    await withTransaction(async (client) => {
      if (!await lockedSource(client, current)) throw new Error('Calendar import source is no longer authorized')
      await client.query(`UPDATE crm_calendar_discovery_sources SET cursor_state = $2::jsonb,
        last_polled_at = now(), last_error = $3, updated_at = now() WHERE id = $1::uuid`, [
        current.id, JSON.stringify(cursor), error ? 'Calendar import failed; the current page will be retried' : null,
      ])
    })
  },
  reconcileEvent,
}

export async function processCalendarDiscoveryInPostgres() {
  const lock = await getPostgresPool().connect()
  try {
    const acquired = await lock.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended('crm-calendar-discovery-worker', 0)) AS acquired`)
    if (!acquired.rows[0]?.acquired) return { busy: true }
    const result = await query<SourceRow>(`${SOURCE_SELECT}
      WHERE source.enabled AND (source.last_polled_at IS NULL OR source.last_polled_at < now() - interval '5 minutes')
      ORDER BY source.last_polled_at NULLS FIRST, source.id LIMIT 2`)
    return await processCalendarDiscovery({ sources: result.rows.map(source), store: calendarDiscoveryStore })
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtextextended('crm-calendar-discovery-worker', 0))`).catch(() => undefined)
    lock.release()
  }
}

async function requireOwnedScope(client: PoolClient, input: {
  pipelineId: string; organizationId: string; actorEmail: string
}) {
  const result = await client.query(`SELECT pipeline.id FROM pipeline_spaces pipeline
    JOIN app_users app_user ON app_user.email = pipeline.owner_email AND app_user.status = 'active'
    JOIN app_user_organization_memberships membership ON membership.user_email = app_user.email
      AND membership.organization_id = pipeline.workspace_organization_id AND membership.status = 'active'
    WHERE pipeline.id = $1::uuid AND pipeline.workspace_organization_id = $2::uuid
      AND pipeline.owner_email = $3 AND NOT pipeline.reference_access_disabled
    FOR SHARE OF pipeline, app_user, membership`, [input.pipelineId, input.organizationId, input.actorEmail])
  if (!result.rowCount) throw new CalendarDiscoveryConfigurationError('Only the active pipeline owner can configure calendar imports', 403)
}

export async function listCalendarDiscoverySources(input: { pipelineId: string; organizationId: string; actorEmail: string }) {
  return withTransaction(async (client) => {
    await requireOwnedScope(client, input)
    const result = await client.query<SourceRow>(`SELECT * FROM crm_calendar_discovery_sources
      WHERE pipeline_id = $1::uuid AND workspace_organization_id = $2::uuid AND credential_owner_email = $3
      ORDER BY calendar_id`, [input.pipelineId, input.organizationId, input.actorEmail])
    return result.rows.map((row) => ({ ...source(row), enabled: row.enabled,
      lastPolledAt: row.last_polled_at, lastError: row.last_error }))
  })
}

export async function configureCalendarDiscoverySource(input: {
  pipelineId: string; organizationId: string; actorEmail: string
  connectionId: string; calendarId: string; enabled: boolean
}) {
  await withTransaction((client) => requireOwnedScope(client, input))
  if (!input.enabled) {
    await withTransaction(async (client) => {
      await requireOwnedScope(client, input)
      await client.query(`UPDATE crm_calendar_discovery_sources SET enabled = false, updated_at = now()
        WHERE pipeline_id = $1::uuid AND workspace_organization_id = $2::uuid
          AND credential_owner_email = $3 AND calendar_id = $4`, [
        input.pipelineId, input.organizationId, input.actorEmail, input.calendarId,
      ])
    })
    return listCalendarDiscoverySources(input)
  }
  const verified = await resolveVerifiedPipelineCalendarSelection(input)
  if (verified.organizationId !== input.organizationId || verified.calendarId === 'primary' || !verified.calendarId) {
    throw new CalendarDiscoveryConfigurationError('Select an exact calendar in this organization')
  }
  const response = await matonFetch(`/google-calendar/calendar/v3/calendars/${encodeURIComponent(verified.calendarId)}`,
    { method: 'GET' }, { ownerEmail: input.actorEmail, app: 'google-calendar', boundConnectionId: verified.connectionId })
  if (!response.ok) throw new CalendarDiscoveryConfigurationError('The selected calendar could not be verified')
  const metadata = await response.json() as { id?: unknown; timeZone?: unknown }
  if (metadata.id !== verified.calendarId || typeof metadata.timeZone !== 'string') {
    throw new CalendarDiscoveryConfigurationError('The selected calendar returned an unexpected identity')
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: metadata.timeZone }).format() }
  catch { throw new CalendarDiscoveryConfigurationError('The selected calendar timezone is invalid') }
  await withTransaction(async (client) => {
    await requireOwnedScope(client, input)
    const credential = await client.query(`SELECT connection_id FROM user_maton_connections
      WHERE owner_email = $1 AND connection_id = $2 AND app = 'google-calendar'
        AND status = 'ACTIVE' AND source = 'maton' FOR SHARE`, [input.actorEmail, verified.connectionId])
    if (!credential.rowCount) throw new CalendarDiscoveryConfigurationError('The calendar connection is no longer active')
    const saved = await client.query(`INSERT INTO crm_calendar_discovery_sources
      (pipeline_id, workspace_organization_id, credential_owner_email, connection_id,
        calendar_id, account_email, time_zone, enabled, verified_at, created_by)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, true, now(), $3)
      ON CONFLICT (pipeline_id, calendar_id) DO UPDATE SET
        connection_id = EXCLUDED.connection_id, account_email = EXCLUDED.account_email,
        time_zone = EXCLUDED.time_zone, enabled = true, verified_at = now(),
        cursor_state = CASE WHEN (crm_calendar_discovery_sources.connection_id, crm_calendar_discovery_sources.account_email,
          crm_calendar_discovery_sources.time_zone) IS DISTINCT FROM
          (EXCLUDED.connection_id, EXCLUDED.account_email, EXCLUDED.time_zone)
          THEN NULL ELSE crm_calendar_discovery_sources.cursor_state END,
        last_polled_at = NULL, last_error = NULL, updated_at = now()
      WHERE crm_calendar_discovery_sources.credential_owner_email = EXCLUDED.credential_owner_email
        AND crm_calendar_discovery_sources.workspace_organization_id = EXCLUDED.workspace_organization_id
      RETURNING id`, [input.pipelineId, input.organizationId, input.actorEmail, verified.connectionId,
      verified.calendarId, verified.accountEmail, metadata.timeZone])
    if (!saved.rowCount) throw new CalendarDiscoveryConfigurationError('This calendar source belongs to a different pipeline owner', 403)
  })
  return listCalendarDiscoverySources(input)
}
