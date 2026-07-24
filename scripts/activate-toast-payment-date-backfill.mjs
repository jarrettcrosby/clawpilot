#!/usr/bin/env node

import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const connectionString = String(process.env.DATABASE_URL || '').trim()
if (!connectionString) {
  console.error('Toast payment-date backfill activation requires DATABASE_URL')
  process.exit(1)
}

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 10000,
})

const client = await pool.connect()
try {
  await client.query('BEGIN')
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('clawpilot-toast-payment-date-backfill-v1'))",
  )
  const result = await client.query(
    `
      WITH staged AS (
        SELECT
          id,
          row_number() OVER (
            ORDER BY organization_id, restaurant_guid, business_date DESC, id
          ) - 1 AS position
        FROM toast_sync_outbox
        WHERE status = 'pending'
          AND request_state @> '{"backfill":"pos_payment_exceptions_v1","staged":true}'::jsonb
      ),
      activated AS (
        UPDATE toast_sync_outbox job
        SET available_at = now()
              + make_interval(secs => ((staged.position / 4)::integer * 60)),
            request_state = (COALESCE(job.request_state, '{}'::jsonb) - 'staged')
              || jsonb_build_object('activatedAt', now()),
            updated_at = now()
        FROM staged
        WHERE job.id = staged.id
        RETURNING job.available_at
      )
      SELECT
        count(*)::integer AS activated,
        max(available_at)::text AS final_available_at
      FROM activated
    `,
  )
  await client.query('COMMIT')
  console.log(JSON.stringify({
    ok: true,
    activated: Number(result.rows[0]?.activated || 0),
    finalAvailableAt: result.rows[0]?.final_available_at || null,
  }))
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  console.error(`Toast payment-date backfill activation failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
