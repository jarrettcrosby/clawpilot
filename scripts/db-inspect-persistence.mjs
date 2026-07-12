#!/usr/bin/env node
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

if (!process.env.DATABASE_URL) {
  console.error('db:inspect failed: DATABASE_URL is required')
  process.exit(1)
}

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
})

const tables = [
  'tasks',
  'agent_threads',
  'agent_thread_messages',
  'execution_runs',
  'execution_results',
  'pipeline_sheet_rows',
  'sync_outbox',
  'audit_events',
]

try {
  const migrations = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename')
  const counts = {}
  for (const table of tables) {
    const result = await pool.query(`SELECT COUNT(*)::integer AS count FROM ${table}`)
    counts[table] = Number(result.rows[0]?.count || 0)
  }
  const outbox = await pool.query(`
    SELECT status, COUNT(*)::integer AS count
    FROM sync_outbox
    GROUP BY status
    ORDER BY status
  `)

  console.log(JSON.stringify({
    migrations: migrations.rows.map((row) => row.filename),
    counts,
    outbox: Object.fromEntries(outbox.rows.map((row) => [row.status, Number(row.count || 0)])),
  }, null, 2))
} finally {
  await pool.end()
}
