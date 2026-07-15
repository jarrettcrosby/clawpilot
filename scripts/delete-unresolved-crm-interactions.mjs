#!/usr/bin/env node
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const REFERENCE_CODES = ['gi4623602', 'gi6564750']
const SOURCE_FINGERPRINTS = [
  { sourceSuffix: ':interactions:22', descriptionNeedle: 'proofsupport.com/jz9xx0qovz' },
  { sourceSuffix: ':interactions:128', descriptionNeedle: 'proofsupport.com/4yaemq7gve' },
]

function fail(message) {
  console.error(`crm:delete-unresolved-interactions failed: ${message}`)
  process.exit(1)
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')
if (process.env.CLAWPILOT_DELETE_CONFIRM !== 'unresolved-interactions-v1') {
  fail('CLAWPILOT_DELETE_CONFIRM=unresolved-interactions-v1 is required')
}

const actor = String(process.env.CLAWPILOT_DELETE_ACTOR || '').trim().toLowerCase()
if (!actor) fail('CLAWPILOT_DELETE_ACTOR is required')

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 30000,
})

async function main() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('clawpilot-delete-unresolved-interactions-v1'))`)
    const records = await client.query(
      `SELECT id::text, pipeline_id::text, suitecrm_id, reference_code
       FROM crm_interactions
       WHERE reference_code = ANY($1::text[])
          OR (source_key LIKE '%' || $2 AND description ILIKE '%' || $3 || '%')
          OR (source_key LIKE '%' || $4 AND description ILIKE '%' || $5 || '%')
       ORDER BY reference_code
       FOR UPDATE`,
      [
        REFERENCE_CODES,
        SOURCE_FINGERPRINTS[0].sourceSuffix,
        SOURCE_FINGERPRINTS[0].descriptionNeedle,
        SOURCE_FINGERPRINTS[1].sourceSuffix,
        SOURCE_FINGERPRINTS[1].descriptionNeedle,
      ],
    )
    const matchedReferenceCodes = Array.from(new Set(records.rows.map((record) => record.reference_code)))
    const retiredReferenceCodes = Array.from(new Set([...REFERENCE_CODES, ...matchedReferenceCodes]))

    let suiteCrmDeletesQueued = 0
    for (const record of records.rows) {
      await client.query(
        `DELETE FROM sync_outbox
         WHERE target_system = 'suitecrm'
           AND aggregate_type = 'crm_interactions'
           AND aggregate_id = $1
           AND operation = 'upsert_record'`,
        [record.id],
      )
      if (record.suitecrm_id) {
        const queued = await client.query(
          `INSERT INTO sync_outbox (
             aggregate_type, aggregate_id, operation, target_system, payload,
             status, idempotency_key, attempts, created_at, available_at, updated_at
           )
           VALUES (
             'crm_interactions', $1, 'delete_record', 'suitecrm', $2::jsonb,
             'queued', $3, 0, now(), now(), now()
           )
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
            record.id,
            JSON.stringify({
              entity: 'interactions',
              pipelineId: record.pipeline_id,
              localId: record.id,
              suiteCrmId: record.suitecrm_id,
              attributes: {},
            }),
            `crm-delete:interactions:${record.id}`,
          ],
        )
        suiteCrmDeletesQueued += queued.rowCount || 0
      }
    }

    await client.query(
      `DELETE FROM crm_inbound_message_links WHERE reference_code = ANY($1::text[])`,
      [retiredReferenceCodes],
    )
    await client.query(
      `UPDATE crm_inbound_messages
       SET marker_references = ARRAY(
         SELECT marker FROM unnest(marker_references) marker WHERE NOT marker = ANY($1::text[])
       )
       WHERE marker_references && $1::text[]`,
      [retiredReferenceCodes],
    )
    await client.query(
      `DELETE FROM crm_integration_actions WHERE reference_code = ANY($1::text[])`,
      [retiredReferenceCodes],
    )
    const deleted = await client.query(
      `DELETE FROM crm_interactions WHERE reference_code = ANY($1::text[]) RETURNING reference_code`,
      [matchedReferenceCodes],
    )
    await client.query(
      `UPDATE short_links
       SET disabled_at = COALESCE(disabled_at, now()),
         deleted_at = COALESCE(deleted_at, now()),
         updated_at = now()
       WHERE slug = ANY($1::text[])`,
      [retiredReferenceCodes],
    )
    await client.query(
      `UPDATE crm_reference_registry
       SET status = 'retired', retired_at = COALESCE(retired_at, now())
       WHERE reference_code = ANY($1::text[])`,
      [retiredReferenceCodes],
    )
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'crm.interactions.deleted_by_operator', 'crm_interactions', 'batch', $2::jsonb)`,
      [actor, JSON.stringify({
        requestedReferenceCodes: REFERENCE_CODES,
        matchedReferenceCodes,
        deletedReferenceCodes: deleted.rows.map((row) => row.reference_code),
        suiteCrmDeletesQueued,
      })],
    )
    await client.query('COMMIT')
    console.log(JSON.stringify({
      ok: true,
      requested: REFERENCE_CODES,
      matched: matchedReferenceCodes,
      deleted: deleted.rows.map((row) => row.reference_code),
      suiteCrmDeletesQueued,
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
