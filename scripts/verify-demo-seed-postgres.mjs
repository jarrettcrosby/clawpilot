#!/usr/bin/env node
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Client } = requireFromApp('pg')

const sourceUrl = String(process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '')
if (!sourceUrl) throw new Error('DATABASE_PUBLIC_URL or DATABASE_URL is required')

const databaseName = `clawpilot_demo_test_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
const adminUrl = new URL(sourceUrl)
const testUrl = new URL(sourceUrl)
testUrl.pathname = `/${databaseName}`
const external = Boolean(process.env.DATABASE_PUBLIC_URL)
function adminClient() {
  return new Client({
    connectionString: adminUrl.toString(),
    ssl: external ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
  })
}

function run(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      PGSSLMODE: external ? 'require' : process.env.PGSSLMODE,
      CLAWPILOT_DEMO_MODE: '1',
      CLAWPILOT_ALLOW_LOCAL_DEMO_SEED: '1',
      RAILWAY_ENVIRONMENT_NAME: 'demo',
    },
    encoding: 'utf8',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) throw new Error(`${script} exited with status ${result.status ?? 'unknown'}`)
}

let created = false
try {
  const setup = adminClient()
  await setup.connect()
  const stale = await setup.query(
    `SELECT datname FROM pg_database WHERE datname LIKE 'clawpilot_demo_test_%'`,
  )
  for (const row of stale.rows) {
    if (/^clawpilot_demo_test_[0-9]+_[0-9a-f]+$/.test(row.datname)) {
      await setup.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`)
    }
  }
  await setup.query(`CREATE DATABASE ${databaseName}`)
  created = true
  await setup.end()
  run('scripts/db-migrate.mjs')
  run('scripts/seed-demo-environment.mjs')
  run('scripts/verify-demo-environment.mjs')
  run('scripts/seed-demo-environment.mjs')
  run('scripts/verify-demo-environment.mjs')
  console.log('demo Postgres seed acceptance passed')
} finally {
  if (created) {
    const cleanup = adminClient()
    await cleanup.connect().catch(() => undefined)
    if (cleanup.readyForQuery) {
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`).catch(() => undefined)
    }
    await cleanup.end().catch(() => undefined)
  }
}
