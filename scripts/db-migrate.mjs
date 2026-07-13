#!/usr/bin/env node
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
  connectionTimeoutMillis: 5000,
  query_timeout: 30000,
})

async function main() {
  const client = await pool.connect()
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('clawpilot-schema-migrations'))`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text')

    const applied = await client.query('SELECT filename, checksum FROM schema_migrations')
    const appliedChecksums = new Map(applied.rows.map((row) => [row.filename, row.checksum]))

    for (const file of files) {
      const sql = readFileSync(resolve(migrationsDir, file), 'utf-8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      if (appliedChecksums.has(file)) {
        const storedChecksum = appliedChecksums.get(file)
        if (storedChecksum && storedChecksum !== checksum) {
          throw new Error(`migration checksum mismatch for ${file}`)
        }
        if (!storedChecksum) {
          await client.query('UPDATE schema_migrations SET checksum = $2 WHERE filename = $1', [file, checksum])
        }
        console.log(`skip ${file}`)
        continue
      }

      console.log(`apply ${file}`)
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }

    console.log('db:migrate complete')
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('clawpilot-schema-migrations'))`).catch(() => undefined)
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
