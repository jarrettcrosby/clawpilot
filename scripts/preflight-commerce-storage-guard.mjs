#!/usr/bin/env node

import { createRequire } from 'node:module'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const ONLINE_MIGRATION =
  '0352_operations_commerce_storage_bloat_guard_online.sql'
const TARGET_RELATIONS = [
  'operations_commerce_intake_read_intents',
  'operations_commerce_inventory_sync_runs',
  'operations_commerce_inventory_snapshot_contents',
]

function fail(message) {
  throw new Error(`commerce storage preflight failed: ${message}`)
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')

const sslMode = String(
  process.env.PGSSLMODE || process.env.DATABASE_SSL || '',
).toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true'
    ? { rejectUnauthorized: false }
    : undefined,
  application_name: 'clawpilot-commerce-storage-preflight',
  connectionTimeoutMillis: 5000,
  query_timeout: 30000,
})

async function main() {
  const client = await pool.connect()
  try {
    const state = await client.query(
      `SELECT
         to_regclass('public.schema_migrations') IS NOT NULL AS registry_exists,
         ARRAY[
           to_regclass('public.operations_commerce_intake_read_intents'),
           to_regclass('public.operations_commerce_inventory_sync_runs'),
           to_regclass(
             'public.operations_commerce_inventory_snapshot_contents'
           )
         ]::oid[] AS relation_ids`,
    )
    const registryExists = state.rows[0]?.registry_exists === true
    const relationIds = (state.rows[0]?.relation_ids || [])
      .filter((value) => value !== null)
      .map((value) => Number(value))
    if (registryExists) {
      const applied = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM schema_migrations WHERE filename = $1
         ) AS applied`,
        [ONLINE_MIGRATION],
      )
      if (applied.rows[0]?.applied === true) {
        console.log(JSON.stringify({
          ok: true,
          migration: ONLINE_MIGRATION,
          status: 'already-applied',
        }))
        process.exitCode = 0
        return
      }
    }
    if (relationIds.length === 0) {
      console.log(JSON.stringify({
        ok: true,
        migration: ONLINE_MIGRATION,
        status: 'fresh-database',
        relations: [],
      }))
      process.exitCode = 0
      return
    }

    const relations = await client.query(
      `SELECT c.oid::integer AS oid, c.relname,
              COALESCE(c.reltuples, 0)::bigint::text AS estimated_rows,
              pg_total_relation_size(c.oid)::bigint::text AS total_bytes
       FROM pg_class c
       WHERE c.oid = ANY($1::oid[])
       ORDER BY c.relname`,
      [relationIds],
    )
    const locks = await client.query(
      `SELECT lock.pid, lock.relation::regclass::text AS relation,
              lock.mode, lock.granted
       FROM pg_locks lock
       WHERE lock.pid <> pg_backend_pid()
         AND lock.relation = ANY($1::oid[])
         AND lock.granted
         AND lock.mode = ANY($2::text[])
       ORDER BY lock.relation::regclass::text, lock.pid`,
      [
        relationIds,
        [
          'ShareUpdateExclusiveLock',
          'ShareLock',
          'ShareRowExclusiveLock',
          'ExclusiveLock',
          'AccessExclusiveLock',
        ],
      ],
    )
    const longTransactions = await client.query(
      `SELECT pid, state,
              floor(extract(epoch FROM (clock_timestamp() - xact_start)))
                ::integer AS age_seconds
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND backend_type = 'client backend'
         AND xact_start IS NOT NULL
         AND xact_start < clock_timestamp() - interval '5 minutes'
       ORDER BY xact_start`,
    )
    const invalidIndexes = await client.query(
      `SELECT indexrelid::regclass::text AS index_name
       FROM pg_index
       WHERE indrelid = ANY($1::oid[])
         AND NOT indisvalid
       ORDER BY indexrelid::regclass::text`,
      [relationIds],
    )
    const summary = {
      ok: locks.rowCount === 0 && longTransactions.rowCount === 0,
      migration: ONLINE_MIGRATION,
      status: 'ready',
      expectedRelations: TARGET_RELATIONS,
      relations: relations.rows.map((row) => ({
        name: row.relname,
        estimatedRows: Number(row.estimated_rows),
        totalBytes: Number(row.total_bytes),
      })),
      conflictingLocks: locks.rows,
      longTransactions: longTransactions.rows,
      invalidIndexes: invalidIndexes.rows.map((row) => row.index_name),
    }
    console.log(JSON.stringify(summary))
    if (!summary.ok) {
      fail('conflicting locks or transactions older than five minutes exist')
    }
  } finally {
    client.release()
  }
}

try {
  await main()
} finally {
  await pool.end()
}
