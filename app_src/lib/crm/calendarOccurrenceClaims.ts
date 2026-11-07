import 'server-only'
import type { PoolClient } from 'pg'

type ProviderTuple = { pipelineId: string; calendarId: string; externalEventId: string }
type VerifiedTuple = ProviderTuple & { meetingId: string }
type VerifiedOccurrence = VerifiedTuple & { occurrenceKey: string }
type MoveOccurrence = Omit<ProviderTuple, 'pipelineId'> & { occurrenceKey: string }
type OccurrenceOwnership = {
  claim_meeting_id: string | null; claim_reference_code: string | null
  bound_meeting_id: string | null; bound_occurrence_key: string | null
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const KEY = /^[0-9a-f]{64}(?![\s\S])/u
const CALENDAR = /^[\x21-\x7e]{1,1024}(?![\s\S])/u
const EVENT = /^[\x21-\x7e]{1,1000}(?![\s\S])/u

function validTuple(input: ProviderTuple) {
  return UUID.test(input.pipelineId) && CALENDAR.test(input.calendarId)
    && input.calendarId.toLowerCase() !== 'primary' && EVENT.test(input.externalEventId)
}

/** Acquire before any CRM meeting row locks in this transaction. All discovery
 * and outbound evidence writers use the same scoped order. */
export async function lockCalendarOccurrencePipeline(client: PoolClient, pipelineId: string): Promise<void> {
  if (!UUID.test(pipelineId)) throw new Error('Invalid Calendar occurrence pipeline')
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`crm-calendar-occurrence:${pipelineId}`])
}

export async function readCalendarOccurrenceOwnership(
  client: PoolClient, input: ProviderTuple & { occurrenceKey: string | null },
): Promise<OccurrenceOwnership> {
  if (!validTuple(input) || (input.occurrenceKey !== null && !KEY.test(input.occurrenceKey))) {
    throw new Error('Invalid Calendar occurrence evidence')
  }
  const result = await client.query<OccurrenceOwnership>(`SELECT claim.meeting_id::text AS claim_meeting_id,
      meeting.reference_code AS claim_reference_code, binding.meeting_id::text AS bound_meeting_id,
      binding.occurrence_key AS bound_occurrence_key
    FROM (VALUES (1)) AS witness(value)
    LEFT JOIN crm_calendar_occurrence_claims claim ON claim.pipeline_id=$1::uuid AND claim.occurrence_key=$4
    LEFT JOIN crm_meetings meeting ON meeting.pipeline_id=claim.pipeline_id AND meeting.id=claim.meeting_id
    LEFT JOIN crm_calendar_occurrence_bindings binding ON binding.pipeline_id=$1::uuid
      AND binding.calendar_id=$2 AND binding.external_event_id=$3`, [
    input.pipelineId, input.calendarId, input.externalEventId, input.occurrenceKey,
  ])
  return result.rows[0]
}

/** Retained proof is not authority to write the old provider tuple. */
export async function readVerifiedCalendarOccurrence(client: PoolClient, input: VerifiedTuple): Promise<string | null> {
  if (!validTuple(input) || !UUID.test(input.meetingId)) throw new Error('Invalid Calendar occurrence evidence')
  const result = await client.query<{ occurrence_key: string }>(`SELECT occurrence_key
    FROM crm_calendar_occurrence_bindings WHERE pipeline_id=$1::uuid AND meeting_id=$2::uuid
      AND calendar_id=$3 AND external_event_id=$4`, [input.pipelineId, input.meetingId, input.calendarId, input.externalEventId])
  return result.rows[0]?.occurrence_key || null
}

function requireOccurrence(input: VerifiedOccurrence) {
  if (!validTuple(input) || !UUID.test(input.meetingId) || !KEY.test(input.occurrenceKey)) {
    throw new Error('Invalid Calendar occurrence evidence')
  }
}

async function lockCurrentCalendarTuple(client: PoolClient, input: VerifiedTuple): Promise<boolean> {
  const meeting = await client.query(`SELECT 1 FROM crm_meetings WHERE pipeline_id=$1::uuid AND id=$2::uuid
    AND source_payload->>'calendarId'=$3 AND external_event_id=$4 FOR UPDATE`, [
    input.pipelineId, input.meetingId, input.calendarId, input.externalEventId,
  ])
  return meeting.rowCount === 1
}

async function retainOccurrenceBinding(client: PoolClient, input: VerifiedOccurrence): Promise<'claimed' | 'unchanged' | 'conflict'> {
  const current = await readCalendarOccurrenceOwnership(client, input)
  if (current.claim_meeting_id && current.claim_meeting_id !== input.meetingId) return 'conflict'
  if (current.bound_meeting_id) {
    return current.bound_meeting_id === input.meetingId && current.bound_occurrence_key === input.occurrenceKey
      ? 'unchanged' : 'conflict'
  }
  if (!current.claim_meeting_id) {
    await client.query(`INSERT INTO crm_calendar_occurrence_claims(pipeline_id, occurrence_key, meeting_id)
      VALUES ($1::uuid,$2,$3::uuid)`, [input.pipelineId, input.occurrenceKey, input.meetingId])
  }
  await client.query(`INSERT INTO crm_calendar_occurrence_bindings(pipeline_id, calendar_id, external_event_id, occurrence_key, meeting_id)
    VALUES ($1::uuid,$2,$3,$4,$5::uuid)`, [input.pipelineId, input.calendarId, input.externalEventId, input.occurrenceKey, input.meetingId])
  return 'claimed'
}

/** A trusted exact provider observation may retain identity for the currently
 * bound meeting, never change that binding or transfer a key to another row.
 * Caller must hold the pipeline lock before locking or staging the meeting. */
export async function claimVerifiedCalendarOccurrence(
  client: PoolClient, input: VerifiedOccurrence,
): Promise<'claimed' | 'unchanged' | 'conflict'> {
  requireOccurrence(input)
  if (!await lockCurrentCalendarTuple(client, input)) return 'conflict'
  return retainOccurrenceBinding(client, input)
}

/** Retain the verified destination before the action deletes its source. The
 * caller owns the action lease and verified provider response. A reservation
 * never changes the meeting's current Calendar, and is not write authority. */
export async function reserveVerifiedCalendarMoveDestination(client: PoolClient, input: {
  pipelineId: string; meetingId: string; source: MoveOccurrence; destination: MoveOccurrence
}): Promise<'claimed' | 'unchanged' | 'conflict'> {
  const source = { ...input.source, pipelineId: input.pipelineId, meetingId: input.meetingId }
  const destination = { ...input.destination, pipelineId: input.pipelineId, meetingId: input.meetingId }
  requireOccurrence(source)
  requireOccurrence(destination)
  if (source.calendarId === destination.calendarId && source.externalEventId === destination.externalEventId) return 'conflict'
  await lockCalendarOccurrencePipeline(client, input.pipelineId)
  if (!await lockCurrentCalendarTuple(client, source)
    || await readVerifiedCalendarOccurrence(client, source) !== source.occurrenceKey) return 'conflict'
  // A pre-ledger meeting may already own one of these exact provider tuples.
  // Detect it even if no occurrence key has been hydrated for that row yet.
  const other = await client.query(`SELECT 1 FROM crm_meetings
    WHERE pipeline_id=$1::uuid AND id<>$2::uuid
      AND ((source_payload->>'calendarId'=$3 AND external_event_id=$4)
        OR (source_payload->>'calendarId'=$5 AND external_event_id=$6)) LIMIT 1`, [
    input.pipelineId, input.meetingId, source.calendarId, source.externalEventId,
    destination.calendarId, destination.externalEventId,
  ])
  if (other.rowCount) return 'conflict'
  return retainOccurrenceBinding(client, destination)
}

/** An unkeyed provider-linked meeting or uncertain Calendar delivery can still
 * be the owner of an incoming copy. Do not allocate a first-seen meeting until
 * known exact tuples are hydrated and unresolved writes are settled. */
export async function calendarOccurrenceCreationHeld(client: PoolClient, pipelineId: string): Promise<boolean> {
  const result = await client.query<{ held: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM crm_meetings m WHERE m.pipeline_id=$1::uuid AND NULLIF(m.external_event_id,'') IS NOT NULL
      AND (m.provider IN ('google-calendar','maton') OR NULLIF(m.source_payload->>'calendarId','') IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM crm_calendar_occurrence_bindings b WHERE b.pipeline_id=m.pipeline_id
        AND b.meeting_id=m.id AND b.calendar_id=m.source_payload->>'calendarId' AND b.external_event_id=m.external_event_id)
    ) OR EXISTS (
      SELECT 1 FROM crm_integration_actions a WHERE a.pipeline_id=$1::uuid AND a.app='google-calendar'
        AND a.action_type='create_calendar_event' AND a.status IN ('queued','processing','failed','dead')
    ) AS held`, [pipelineId])
  return result.rows[0]?.held !== false
}
