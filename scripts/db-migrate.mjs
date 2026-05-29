#!/usr/bin/env node
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

function fail(message) {
  console.error(`db:migrate failed: ${message}`)
  process.exit(1)
}

if (!process.env.DATABASE_URL) {
  fail('DATABASE_URL is required')
}

const migrationsDir = resolve(root, 'db', 'migrations')
if (!existsSync(migrationsDir)) {
  fail('missing db/migrations directory')
}

const files = readdirSync(migrationsDir)
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort((a, b) => a.localeCompare(b))

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
})

async function main() {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const applied = await client.query('SELECT filename FROM schema_migrations')
    const appliedNames = new Set(applied.rows.map((row) => row.filename))

    for (const file of files) {
      if (appliedNames.has(file)) {
        console.log(`skip ${file}`)
        continue
      }

      const sql = readFileSync(resolve(migrationsDir, file), 'utf-8')
      console.log(`apply ${file}`)
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }

    console.log('db:migrate complete')
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

