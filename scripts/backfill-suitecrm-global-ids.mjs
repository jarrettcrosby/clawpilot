#!/usr/bin/env node
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const ENTITIES = [
  ['organizations', 'crm_organizations'],
  ['contacts', 'crm_contacts'],
  ['leads', 'crm_leads'],
  ['opportunities', 'crm_opportunities'],
  ['meetings', 'crm_meetings'],
  ['interactions', 'crm_interactions'],
  ['campaigns', 'crm_campaigns'],
]

function fail(message) {
  console.error(`crm:backfill-suitecrm failed: ${message}`)
  process.exit(1)
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')
if (process.env.CLAWPILOT_BACKFILL_CONFIRM !== 'global-id-v1') {
  fail('CLAWPILOT_BACKFILL_CONFIRM=global-id-v1 is required')
}

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 30000,
})

function validPayload(value, entity, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${entity} ${id} has no reusable SuiteCRM outbox payload`)
  }
  if (!value.attributes || typeof value.attributes !== 'object' || Array.isArray(value.attributes)) {
    throw new Error(`${entity} ${id} has invalid SuiteCRM attributes`)
  }
  return value
}

async function meetingRelationships(client, row) {
  const result = await client.query(
    `SELECT 'accounts' AS "linkFieldName", 'Accounts' AS "relatedModuleName", suitecrm_id AS "relatedBeanId"
     FROM crm_organizations
     WHERE pipeline_id = $1::uuid AND id = $2::uuid AND suitecrm_id IS NOT NULL
     UNION ALL
     SELECT 'contacts', 'Contacts', suitecrm_id
     FROM crm_contacts
     WHERE pipeline_id = $1::uuid AND id = $3::uuid AND suitecrm_id IS NOT NULL
     UNION ALL
     SELECT 'leads', 'Leads', suitecrm_id
     FROM crm_leads
     WHERE pipeline_id = $1::uuid AND id = $4::uuid AND suitecrm_id IS NOT NULL
     UNION ALL
     SELECT 'opportunity', 'Opportunities', suitecrm_id
     FROM crm_opportunities
     WHERE pipeline_id = $1::uuid AND id = $5::uuid AND suitecrm_id IS NOT NULL`,
    [row.pipeline_id, row.organization_id, row.contact_id, row.lead_id, row.opportunity_id],
  )
  return result.rows
}

async function backfillEntity(client, entity, table) {
  const expected = await client.query(
    `SELECT count(*)::integer AS count FROM ${table} WHERE suitecrm_id IS NOT NULL`,
  )
  const meetingFields = entity === 'meetings'
    ? ', record.organization_id::text, record.contact_id::text, record.lead_id::text, record.opportunity_id::text'
    : ''
  const records = await client.query(
    `SELECT record.id::text, record.pipeline_id::text, record.suitecrm_id, record.reference_code,
       latest.payload${meetingFields}
     FROM ${table} record
     JOIN LATERAL (
       SELECT outbox.payload
       FROM sync_outbox outbox
       WHERE outbox.target_system = 'suitecrm'
         AND outbox.operation = 'upsert_record'
         AND outbox.aggregate_type = $1
         AND outbox.aggregate_id = record.id::text
       ORDER BY outbox.created_at DESC, outbox.id DESC
       LIMIT 1
     ) latest ON true
     WHERE record.suitecrm_id IS NOT NULL
     ORDER BY record.id`,
    [`crm_${entity}`],
  )
  if ((records.rowCount || 0) !== Number(expected.rows[0]?.count || 0)) {
    throw new Error(`${entity} contains SuiteCRM records without a reusable outbox projection`)
  }

  let queued = 0
  for (const row of records.rows) {
    const current = validPayload(row.payload, entity, row.id)
    const payload = {
      ...current,
      entity,
      pipelineId: row.pipeline_id,
      localId: row.id,
      suiteCrmId: row.suitecrm_id,
      attributes: {
        ...current.attributes,
        global_id_c: row.reference_code,
      },
    }
    if (entity === 'meetings') payload.relationships = await meetingRelationships(client, row)
    const result = await client.query(
      `INSERT INTO sync_outbox (
         aggregate_type, aggregate_id, operation, target_system, payload, status,
         idempotency_key, attempts, created_at, available_at, updated_at
       )
       VALUES ($1, $2, 'upsert_record', 'suitecrm', $3::jsonb, 'queued', $4, 0, now(), now(), now())
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
       RETURNING id`,
      [
        `crm_${entity}`,
        row.id,
        JSON.stringify(payload),
        `crm:suitecrm-global-id:v1:${entity}:${row.id}`,
      ],
    )
    if (result.rowCount) {
      queued += 1
      await client.query(
        `UPDATE ${table} SET sync_status = 'pending', sync_error = NULL, updated_at = now() WHERE id = $1::uuid`,
        [row.id],
      )
    }
  }
  return { records: records.rowCount || 0, queued }
}

async function main() {
  const client = await pool.connect()
  const summary = {}
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('clawpilot-suitecrm-global-id-backfill-v1'))`)
    for (const [entity, table] of ENTITIES) {
      summary[entity] = await backfillEntity(client, entity, table)
    }
    await client.query('COMMIT')
    console.log(JSON.stringify({ ok: true, summary }))
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
