#!/usr/bin/env node
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const ACTOR = String(process.env.CLAWPILOT_RETIRE_ACTOR || '').trim().toLowerCase()
const CONFIRMATION = 'production-test-data-v1'
const INTERACTION_REFERENCES = ['gi4021276', 'gi9599849']
const EXPECTED_MEETING_REFERENCE = 'gm1880682'
const STALE_OUTBOX_ID = 'de18717c-05f1-49c7-bc40-094b516be2c3'

function fail(message) {
  console.error(`crm:retire-production-test-data failed: ${message}`)
  process.exit(1)
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')
if (process.env.CLAWPILOT_RETIRE_CONFIRM !== CONFIRMATION) {
  fail(`CLAWPILOT_RETIRE_CONFIRM=${CONFIRMATION} is required`)
}
if (!ACTOR) fail('CLAWPILOT_RETIRE_ACTOR is required')

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 30000,
})

async function queueSuiteCrmDelete(client, record) {
  await client.query(
    `DELETE FROM sync_outbox
     WHERE target_system = 'suitecrm'
       AND aggregate_type = $1
       AND aggregate_id = $2
       AND operation = 'upsert_record'`,
    [record.aggregateType, record.id],
  )
  if (!record.suiteCrmId) return 0
  const result = await client.query(
    `INSERT INTO sync_outbox (
       aggregate_type, aggregate_id, operation, target_system, payload,
       status, idempotency_key, attempts, created_at, available_at, updated_at
     )
     VALUES ($1, $2, 'delete_record', 'suitecrm', $3::jsonb,
       'queued', $4, 0, now(), now(), now())
     ON CONFLICT (target_system, idempotency_key)
     WHERE idempotency_key IS NOT NULL
     DO UPDATE SET
       payload = EXCLUDED.payload,
       status = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.status ELSE 'queued' END,
       attempts = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.attempts ELSE 0 END,
       last_error = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.last_error ELSE NULL END,
       available_at = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.available_at ELSE now() END,
       processed_at = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.processed_at ELSE NULL END,
       updated_at = now()
     RETURNING id`,
    [
      record.aggregateType,
      record.id,
      JSON.stringify({
        entity: record.entity,
        pipelineId: record.pipelineId,
        localId: record.id,
        suiteCrmId: record.suiteCrmId,
        attributes: {},
      }),
      `crm-delete:${record.entity}:${record.id}`,
    ],
  )
  return result.rowCount || 0
}

async function main() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('clawpilot-retire-production-test-data-v1'))`)

    const interactions = await client.query(
      `SELECT id::text, pipeline_id::text, suitecrm_id, reference_code, subject,
         meeting_id::text, provider_message_id
       FROM crm_interactions
       WHERE reference_code = ANY($1::text[])
       ORDER BY reference_code
       FOR UPDATE`,
      [INTERACTION_REFERENCES],
    )
    if (interactions.rows.length !== INTERACTION_REFERENCES.length) {
      throw new Error(`Expected ${INTERACTION_REFERENCES.length} test interactions; found ${interactions.rows.length}`)
    }
    const byReference = new Map(interactions.rows.map((row) => [row.reference_code, row]))
    if (byReference.get('gi4021276')?.subject !== 'Test of Archive Bot') {
      throw new Error('gi4021276 no longer matches the approved test record')
    }
    if (byReference.get('gi9599849')?.subject !== 'Meeting with Suburbia Sandwich Co') {
      throw new Error('gi9599849 no longer matches the approved test meeting interaction')
    }

    const meetingIds = interactions.rows.map((row) => row.meeting_id).filter(Boolean)
    const meetings = meetingIds.length === 0 ? { rows: [] } : await client.query(
      `SELECT id::text, pipeline_id::text, suitecrm_id, reference_code, subject,
         external_event_id, external_event_url
       FROM crm_meetings
       WHERE id = ANY($1::uuid[])
       ORDER BY reference_code
       FOR UPDATE`,
      [meetingIds],
    )
    if (meetings.rows.length !== 1 || meetings.rows[0].reference_code !== EXPECTED_MEETING_REFERENCE) {
      throw new Error('The linked test meeting no longer matches the approved cleanup scope')
    }

    let suiteCrmDeletesQueued = 0
    for (const row of interactions.rows) {
      suiteCrmDeletesQueued += await queueSuiteCrmDelete(client, {
        aggregateType: 'crm_interactions', entity: 'interactions', id: row.id,
        pipelineId: row.pipeline_id, suiteCrmId: row.suitecrm_id,
      })
    }
    for (const row of meetings.rows) {
      suiteCrmDeletesQueued += await queueSuiteCrmDelete(client, {
        aggregateType: 'crm_meetings', entity: 'meetings', id: row.id,
        pipelineId: row.pipeline_id, suiteCrmId: row.suitecrm_id,
      })
    }

    await client.query(
      `DELETE FROM crm_inbound_message_links WHERE reference_code = ANY($1::text[])`,
      [INTERACTION_REFERENCES],
    )
    await client.query(
      `UPDATE crm_inbound_messages
       SET marker_references = ARRAY(
         SELECT marker FROM unnest(marker_references) marker WHERE NOT marker = ANY($1::text[])
       )
       WHERE marker_references && $1::text[]`,
      [INTERACTION_REFERENCES],
    )

    const deletedInteractions = await client.query(
      `DELETE FROM crm_interactions
       WHERE reference_code = ANY($1::text[])
       RETURNING reference_code`,
      [INTERACTION_REFERENCES],
    )
    const deletedMeetings = await client.query(
      `DELETE FROM crm_meetings
       WHERE reference_code = $1
       RETURNING reference_code`,
      [EXPECTED_MEETING_REFERENCE],
    )
    const retiredReferences = [...INTERACTION_REFERENCES, EXPECTED_MEETING_REFERENCE]
    await client.query(
      `UPDATE short_links
       SET disabled_at = COALESCE(disabled_at, now()),
         deleted_at = COALESCE(deleted_at, now()),
         updated_at = now()
       WHERE slug = ANY($1::text[])`,
      [retiredReferences],
    )
    await client.query(
      `UPDATE crm_reference_registry
       SET status = 'retired', retired_at = COALESCE(retired_at, now())
       WHERE reference_code = ANY($1::text[])`,
      [retiredReferences],
    )

    const staleOutbox = await client.query(
      `DELETE FROM sync_outbox
       WHERE id = $1::uuid
         AND status = 'dead'
         AND operation = 'project_crm_workbook'
         AND last_error = 'CRM workbook projection is waiting for reconciliation (527 unresolved records)'
       RETURNING id::text, aggregate_id, target_system, operation, attempts, last_error, created_at`,
      [STALE_OUTBOX_ID],
    )
    if (staleOutbox.rows.length !== 1) {
      throw new Error('The obsolete workbook failure no longer matches the approved cleanup scope')
    }

    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES
       ($1, 'crm.test_records.retired_by_operator', 'crm_records', 'batch', $2::jsonb),
       ($1, 'sync.outbox.superseded_by_operator', 'sync_outbox', $3, $4::jsonb)`,
      [
        ACTOR,
        JSON.stringify({
          interactionReferences: deletedInteractions.rows.map((row) => row.reference_code),
          meetingReferences: deletedMeetings.rows.map((row) => row.reference_code),
          suiteCrmDeletesQueued,
          retainedExternalCalendarEvidence: meetings.rows.map((row) => ({
            referenceCode: row.reference_code,
            externalEventId: row.external_event_id,
            externalEventUrl: row.external_event_url,
          })),
        }),
        STALE_OUTBOX_ID,
        JSON.stringify(staleOutbox.rows[0]),
      ],
    )

    await client.query('COMMIT')
    console.log(JSON.stringify({
      ok: true,
      retiredReferences,
      suiteCrmDeletesQueued,
      supersededOutboxId: STALE_OUTBOX_ID,
    }))
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
