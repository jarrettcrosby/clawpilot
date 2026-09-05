#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const healthSource = readFileSync(
  resolve(root, 'app_src/app/api/health/route.ts'),
  'utf8',
)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const sqlMatch = healthSource.match(
  /const OPERATIONS_ORDER_REPLANNING_CORRECTIONS_HEALTH_SQL = String\.raw`([\s\S]*?)`\n/u,
)
assert.ok(sqlMatch, 'Health route must contain the exact 0291 attestation SQL')
const attestationSql = sqlMatch[1]

const requiredStructure = [
  '0291_operations_order_replanning_corrections.sql',
  '6ac42626a53b421d1d5085e0f2ddc578df29ec400d2a70bc156ce9c9fbb0ff60',
  'operations_order_replanning_corrections',
  '2938b378a5b5bcca279c528b86d7b1df9182abfd31351d1c7fe39735aee4ec67',
  '803de41c0651fcdb789c3cb0713fdd4b624fc193734971d6ce3685bcd32f3b44',
  '2187b8e068b269a9b028016c289bcbafb015d21cc5741af9662af9ac755f888c',
  '48bcb77441900d0f09ef13a570e6cb2a9d14af7d7731de14224aa02771f11348',
  '767b517b2911b4f3e4e527605531e4bcbc46701fbb69c4aa7421e85b865b4951',
  'validate_operations_order_replanning_correction()',
  '9e9d9e682d1aeefb8a08476ea4c2c48139eb0857d82824c48925d4f4654b9041',
  'reject_operations_order_replanning_correction_mutation()',
  '6ff446c0be811717eb351904655a3b6b1f846c8cb0fd71da15f2c06da1d5ca42',
  '14ac1ff9cfe3b8e46f113db57f19c591b01b363fe107865b79e9ed2cdedbc96f',
  'installed_index.indisunique',
  'installed_index.indisprimary',
  'installed_index.indisvalid',
  'installed_index.indisready',
  'installed_trigger.tgtype',
  'installed_trigger.tgenabled',
  'installed_trigger.tgattr',
  "installed_reference.prefix = 'gorc'",
  "'operations.order_replanning_correction'",
  "'Order replanning correction'",
]
for (const fragment of requiredStructure) {
  assert.ok(
    attestationSql.includes(fragment),
    `0291 health attestation missing ${fragment}`,
  )
}

assert.ok(
  (
    healthSource.match(
      /row\?\.operations_order_replanning_corrections_applied/gu,
    ) || []
  ).length >= 3,
  '0291 structural drift must fail migrationsCurrent and global health',
)
assert.match(
  healthSource,
  /&& row\?\.operations_order_replanning_corrections_applied/u,
  '0291 attestation must participate in migrationsCurrent',
)
assert.match(
  healthSource,
  /\|\| !row\?\.operations_order_replanning_corrections_applied/u,
  '0291 attestation failure must append the global migration health error',
)
assert.match(
  healthSource,
  /orderReplanningCorrections: \{[\s\S]*?operations_order_replanning_corrections_applied[\s\S]*?'migration-or-structure-pending'/u,
  '0291 attestation must be visible in the health response',
)
assert.match(
  healthSource,
  /status:\s*errors\.length > 0\s*\?\s*503\s*:\s*200/u,
  'Any global health error, including 0291 drift during key adoption, must return HTTP 503',
)

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim()
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 45_000
  let lastError = null
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
      max: 1,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch (error) {
      lastError = error
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

async function attest(pool) {
  const result = await pool.query(`SELECT (${attestationSql}) AS applied`)
  return result.rows[0]?.applied === true
}

async function tamper(pool, sql, message) {
  await pool.query('BEGIN')
  try {
    await pool.query(sql)
    assert.equal(await attest(pool), false, message)
  } finally {
    await pool.query('ROLLBACK')
  }
}

async function exercise(pool) {
  assert.equal(
    await attest(pool),
    true,
    'Fresh 0291 schema must pass the exact health attestation',
  )

  await tamper(
    pool,
    `DELETE FROM schema_migrations
     WHERE filename = '0291_operations_order_replanning_corrections.sql'`,
    'A missing 0291 migration record must fail health',
  )
  await tamper(
    pool,
    `UPDATE schema_migrations
     SET checksum = repeat('0', 64)
     WHERE filename = '0291_operations_order_replanning_corrections.sql'`,
    'A mismatched 0291 migration checksum must fail health',
  )
  await tamper(
    pool,
    `ALTER TABLE operations_order_replanning_corrections
     DROP COLUMN provider_write_count CASCADE`,
    'Removing a correction column must fail health',
  )
  await tamper(
    pool,
    `ALTER TABLE operations_order_replanning_corrections
     DROP CONSTRAINT operations_order_replanning_corrections_global_valid,
     ADD CONSTRAINT operations_order_replanning_corrections_global_valid
       CHECK (global_id IS NOT NULL)`,
    'Weakening a same-named correction CHECK must fail health',
  )
  await tamper(
    pool,
    `ALTER TABLE operations_order_replanning_corrections
     DROP CONSTRAINT operations_order_replanning_corrections_plan_fkey`,
    'Removing exact order-to-plan ownership must fail health',
  )
  await tamper(
    pool,
    `ALTER TABLE operations_order_replanning_corrections
     DROP CONSTRAINT operations_order_replanning_corrections_receipt_unique`,
    'Removing receipt idempotency uniqueness must fail health',
  )
  await tamper(
    pool,
    'DROP INDEX idx_operations_order_replanning_corrections_order',
    'Removing the correction-order lookup index must fail health',
  )
  await tamper(
    pool,
    `CREATE OR REPLACE FUNCTION validate_operations_order_replanning_correction()
     RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       RETURN NEW;
     END;
     $$`,
    'Weakening the correction validation function must fail health',
  )
  await tamper(
    pool,
    `ALTER TABLE operations_order_replanning_corrections
     DISABLE TRIGGER operations_order_replanning_corrections_immutable`,
    'Disabling append-only correction protection must fail health',
  )
  await tamper(
    pool,
    `UPDATE global_reference_entity_types
     SET entity_type = 'operations.order_replanning_correction_wrong'
     WHERE prefix = 'gorc'`,
    'Changing the correction reference owner must fail health',
  )
}

async function main() {
  const existingDatabaseUrl = String(
    process.env.ORDER_REPLANNING_CORRECTIONS_HEALTH_DATABASE_URL || '',
  ).trim()
  if (existingDatabaseUrl) {
    const pool = new Pool({ connectionString: existingDatabaseUrl, max: 2 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
    console.log('Order replanning correction health attestation passed')
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-order-replanning-health-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  let containerStarted = false
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=order_replanning_health',
      '-e', 'POSTGRES_DB=order_replanning_health',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    containerStarted = true
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:order_replanning_health@127.0.0.1:'
      + `${port}/order_replanning_health`
    )
    await waitForPostgres(databaseUrl)
    command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 300_000,
    })
    const pool = new Pool({ connectionString: databaseUrl, max: 2 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
  } finally {
    if (containerStarted) {
      command('docker', ['stop', container], { timeout: 30_000 })
    }
  }

  console.log('Order replanning correction health attestation passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
