#!/usr/bin/env node
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

function fail(message) {
  console.error(`crm:backfill-suitecrm-interaction-contacts failed: ${message}`)
  process.exit(1)
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')
if (process.env.CLAWPILOT_BACKFILL_CONFIRM !== 'interaction-contacts-v1') {
  fail('CLAWPILOT_BACKFILL_CONFIRM=interaction-contacts-v1 is required')
}

const actor = String(process.env.CLAWPILOT_BACKFILL_ACTOR || '').trim().toLowerCase()
if (!actor) fail('CLAWPILOT_BACKFILL_ACTOR is required')

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
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('clawpilot-suitecrm-interaction-contacts-v1'))`)
    const records = await client.query(
      `SELECT interaction.id::text, interaction.pipeline_id::text,
         interaction.suitecrm_id, interaction.reference_code,
         interaction.subject, interaction.description,
         organization.suitecrm_id AS organization_suitecrm_id,
         contact.suitecrm_id AS contact_suitecrm_id
       FROM crm_interactions interaction
       JOIN crm_organizations organization
         ON organization.pipeline_id = interaction.pipeline_id
        AND organization.id = interaction.organization_id
       JOIN crm_contacts contact
         ON contact.pipeline_id = interaction.pipeline_id
        AND contact.id = interaction.contact_id
       WHERE interaction.suitecrm_id IS NOT NULL
         AND organization.suitecrm_id IS NOT NULL
         AND contact.suitecrm_id IS NOT NULL
       ORDER BY interaction.id`,
    )

    let queued = 0
    for (const row of records.rows) {
      const payload = {
        entity: 'interactions',
        pipelineId: row.pipeline_id,
        localId: row.id,
        suiteCrmId: row.suitecrm_id,
        attributes: {
          global_id_c: row.reference_code,
          name: row.subject || '',
          parent_type: 'Accounts',
          parent_id: row.organization_suitecrm_id,
          contact_id: row.contact_suitecrm_id,
          description: row.description || '',
        },
        relationships: [{
          linkFieldName: 'contact',
          relatedModuleName: 'Contacts',
          relatedBeanId: row.contact_suitecrm_id,
        }],
      }
      const result = await client.query(
        `INSERT INTO sync_outbox (
           aggregate_type, aggregate_id, operation, target_system, payload, status,
           idempotency_key, attempts, created_at, available_at, updated_at
         )
         VALUES ('crm_interactions', $1, 'upsert_record', 'suitecrm', $2::jsonb, 'queued', $3, 0, now(), now(), now())
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
         WHERE sync_outbox.payload IS DISTINCT FROM EXCLUDED.payload
         RETURNING status`,
        [row.id, JSON.stringify(payload), `crm:interaction-contact-backfill:v1:${row.id}:${row.contact_suitecrm_id}`],
      )
      if (result.rowCount) {
        queued += 1
        await client.query(
          `UPDATE crm_interactions
           SET sync_status = CASE WHEN $2 = 'processing' THEN 'syncing' ELSE 'pending' END,
             sync_error = NULL, updated_at = now()
           WHERE id = $1::uuid`,
          [row.id, result.rows[0].status],
        )
      }
    }

    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'crm.interaction_contacts.backfilled', 'crm_interactions', 'all', $2::jsonb)`,
      [actor, JSON.stringify({ eligible: records.rowCount || 0, queued })],
    )
    await client.query('COMMIT')
    console.log(JSON.stringify({ ok: true, eligible: records.rowCount || 0, queued }))
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
