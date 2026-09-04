#!/usr/bin/env node
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const NONTRANSACTIONAL_DIRECTIVE = '-- clawpilot:migration-mode=nontransactional'
const STATEMENT_BREAK = '-- clawpilot:migration-statement-break'

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

function parseNontransactionalStatements(file, sql) {
  if (!sql.trimStart().startsWith(NONTRANSACTIONAL_DIRECTIVE)) return null
  const statements = sql.split(STATEMENT_BREAK).map((statement) => (
    statement.trim()
  )).filter(Boolean)
  if (statements.length === 0) {
    throw new Error(`nontransactional migration ${file} has no statements`)
  }
  for (const statement of statements) {
    const executable = statement
      .replace(/^\s*--.*$/gmu, '')
      .trim()
      .replace(/;\s*$/u, '')
    if (!executable || executable.includes(';')) {
      throw new Error(
        `nontransactional migration ${file} must separate every SQL statement with ${STATEMENT_BREAK}`,
      )
    }
    if (/\b(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(executable)) {
      throw new Error(
        `nontransactional migration ${file} cannot control transactions`,
      )
    }
  }
  return statements
}

async function recordAppliedMigration(client, file, checksum) {
  await client.query('BEGIN')
  try {
    await client.query(
      'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
      [file, checksum],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function applyNontransactionalMigration(
  client,
  file,
  checksum,
  statements,
) {
  await client.query({ text: `SET lock_timeout = '5s'`, query_timeout: 0 })
  await client.query({ text: `SET statement_timeout = 0`, query_timeout: 0 })
  try {
    for (const [index, statement] of statements.entries()) {
      console.log(`apply ${file} statement ${index + 1}/${statements.length}`)
      await client.query({ text: statement, query_timeout: 0 })
    }
    await recordAppliedMigration(client, file, checksum)
  } finally {
    await client.query({ text: 'RESET statement_timeout', query_timeout: 0 })
      .catch(() => undefined)
    await client.query({ text: 'RESET lock_timeout', query_timeout: 0 })
      .catch(() => undefined)
  }
}

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
          throw new Error(
            `migration checksum mismatch for ${file}: database=${storedChecksum} source=${checksum}`,
          )
        }
        if (!storedChecksum) {
          await client.query('UPDATE schema_migrations SET checksum = $2 WHERE filename = $1', [file, checksum])
        }
        console.log(`skip ${file}`)
        continue
      }

      console.log(`apply ${file}`)
      const nontransactionalStatements = parseNontransactionalStatements(
        file,
        sql,
      )
      if (nontransactionalStatements) {
        await applyNontransactionalMigration(
          client,
          file,
          checksum,
          nontransactionalStatements,
        )
        continue
      }
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
