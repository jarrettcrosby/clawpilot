#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = process.cwd()
const routePath = 'app_src/app/api/health/route.ts'
const healthSource = readFileSync(resolve(root, routePath), 'utf8')
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const sqlMatch = healthSource.match(
  /const OPERATIONS_SHOPIFY_LOCATION_ROUTING_HEALTH_SQL = String\.raw`([\s\S]*?)`\n/u,
)
assert.ok(sqlMatch, 'Health route must export the exact 0288 attestation SQL')
const attestationSql = sqlMatch[1]

const requiredStructure = [
  '0288_operations_shopify_location_routing.sql',
  'ownership_classification',
  'provider_snapshot_json',
  'provider_snapshot_hash',
  'provider_observed_at',
  'inventory_import_enabled',
  'location_mapping_id',
  'location_mapping_row_version',
  'provider_location_id',
  'inventory_location_id',
  'inventory_pool_id',
  'operations_commerce_inventory_location_mappings_ownership_valid',
  'operations_commerce_inventory_location_mappings_snapshot_valid',
  'operations_shopify_inventory_refresh_jobs_status_check',
  'operations_shopify_inventory_refresh_lease_valid',
  'operations_shopify_inventory_refresh_completion_valid',
  'operations_shopify_inventory_refresh_mapping_fence_complete',
  'operations_shopify_inventory_refresh_mapping_status_consistent',
  'operations_shopify_inventory_refresh_mapping_fkey',
  'operations_shopify_inventory_refresh_inventory_location_fkey',
  'operations_shopify_inventory_refresh_inventory_pool_fkey',
  'idx_operations_shopify_inventory_refresh_active_account',
  'idx_operations_shopify_inventory_refresh_active_mapping',
  'idx_operations_shopify_inventory_refresh_processing_account',
  'idx_operations_commerce_inventory_active_projection_target',
  'installed_fk.convalidated',
  'installed_index.indisunique',
  'installed_index.indisvalid',
  'installed_index.indisready',
]
for (const fragment of requiredStructure) {
  assert.ok(
    attestationSql.includes(fragment),
    `0288 health attestation missing ${fragment}`,
  )
}

assert.ok(
  (healthSource.match(
    /row\?\.operations_shopify_location_routing_applied/gu,
  ) || []).length >= 3,
  '0288 structural drift must fail migrationsCurrent and global health',
)
assert.match(
  healthSource,
  /&& row\?\.operations_shopify_location_routing_applied/u,
  '0288 attestation must participate in migrationsCurrent',
)
assert.match(
  healthSource,
  /\|\| !row\?\.operations_shopify_location_routing_applied/u,
  '0288 attestation failure must append the global migration health error',
)
assert.match(
  healthSource,
  /status:\s*errors\.length > 0\s*\?\s*503\s*:\s*200/u,
  'Any global health error, including 0288 drift during key adoption, must return HTTP 503',
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
  const result = await pool.query(
    `SELECT (${attestationSql}) AS applied`,
  )
  return result.rows[0]?.applied === true
}

async function exercise(pool) {
  assert.equal(
    await attest(pool),
    true,
    'Fresh 0288 schema must pass the exact health attestation',
  )

  await pool.query('BEGIN')
  try {
    await pool.query(
      'DROP INDEX idx_operations_shopify_inventory_refresh_active_mapping',
    )
    assert.equal(
      await attest(pool),
      false,
      'A missing mapped-active unique index must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      'DROP INDEX idx_operations_commerce_inventory_active_projection_target',
    )
    assert.equal(
      await attest(pool),
      false,
      'A missing cross-account projection-target fence must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `ALTER TABLE operations_commerce_inventory_location_mappings
       DROP CONSTRAINT
         operations_commerce_inventory_location_mappings_ownership_valid,
       ADD CONSTRAINT
         operations_commerce_inventory_location_mappings_ownership_valid
         CHECK (ownership_classification IS NOT NULL)`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A same-named but weakened ownership constraint must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `ALTER TABLE operations_shopify_inventory_refresh_jobs
       DROP CONSTRAINT
         operations_shopify_inventory_refresh_mapping_fkey,
       ADD CONSTRAINT operations_shopify_inventory_refresh_mapping_fkey
         FOREIGN KEY (
           organization_id, integration_account_id, location_mapping_id
         ) REFERENCES operations_commerce_inventory_location_mappings (
           organization_id, integration_account_id, id
         ) ON DELETE RESTRICT NOT VALID`,
    )
    assert.equal(
      await attest(pool),
      false,
      'An unvalidated mapping foreign key must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }
}

async function main() {
  const existingDatabaseUrl = String(
    process.env.SHOPIFY_LOCATION_HEALTH_DATABASE_URL || '',
  ).trim()
  if (existingDatabaseUrl) {
    const pool = new Pool({ connectionString: existingDatabaseUrl, max: 2 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
    console.log('Shopify location-routing health attestation passed')
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-shopify-location-health-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=shopify_location_health',
      '-e', 'POSTGRES_DB=shopify_location_health',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:shopify_location_health@127.0.0.1:'
      + `${port}/shopify_location_health`
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
    command('docker', ['stop', container], { timeout: 30_000 })
  }

  console.log('Shopify location-routing health attestation passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
