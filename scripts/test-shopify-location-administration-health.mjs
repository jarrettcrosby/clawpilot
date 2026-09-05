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
  /const OPERATIONS_SHOPIFY_LOCATION_ADMINISTRATION_HEALTH_SQL = String\.raw`([\s\S]*?)`\n/u,
)
assert.ok(sqlMatch, 'Health route must contain the exact 0289 attestation SQL')
const attestationSql = sqlMatch[1]

const requiredStructure = [
  '0289_operations_shopify_location_administration.sql',
  'operations_shopify_location_administration_authorizations',
  'operations_shopify_location_administration_attempts',
  'operations_shopify_location_administration_outcomes',
  'cbbc8b291f3fa65763de5d4535fd8ff93d8ce1802d43fe4241640edc930d7c58',
  '3e805985730407b50af636736bbe8ef66373214d3a73b1262afd0e6bdf7e9e9c',
  '3330bdef494fa4d7f7658398a68594639e3cb68ee7f8e1dc4a90e44d467adf64',
  'ops_shopify_location_admin_one_unresolved_account_idx',
  'ops_shopify_location_admin_auth_idempotency_unique',
  'ops_shopify_location_admin_attempt_authorization_unique',
  'ops_shopify_location_admin_outcome_state_unique',
  'operations_shopify_location_admin_actor_current(uuid,text,text)',
  'operations_shopify_location_admin_is_current(uuid,uuid)',
  'protect_shopify_location_admin_authorization()',
  'protect_shopify_location_admin_attempt()',
  'protect_shopify_location_admin_outcome()',
  'validate_shopify_location_admin_auth_insert',
  'protect_shopify_location_admin_auth_write',
  'protect_shopify_location_admin_attempt_write',
  'protect_shopify_location_admin_outcome_write',
  "installed_trigger.tgenabled = 'O'",
  'installed_trigger.tgconstraint = 0',
  'installed_index.indisunique',
  'installed_index.indisvalid',
  'installed_index.indisready',
  'gsla',
  'gslt',
  'gslo',
]
for (const fragment of requiredStructure) {
  assert.ok(
    attestationSql.includes(fragment),
    `0289 health attestation missing ${fragment}`,
  )
}

assert.ok(
  (healthSource.match(
    /row\?\.operations_shopify_location_administration_applied/gu,
  ) || []).length >= 3,
  '0289 structural drift must fail migrationsCurrent and global health',
)
assert.match(
  healthSource,
  /&& row\?\.operations_shopify_location_administration_applied/u,
  '0289 attestation must participate in migrationsCurrent',
)
assert.match(
  healthSource,
  /\|\| !row\?\.operations_shopify_location_administration_applied/u,
  '0289 attestation failure must append the global migration health error',
)
assert.match(
  healthSource,
  /shopifyLocationAdministration: \{[\s\S]*?operations_shopify_location_administration_applied[\s\S]*?'migration-or-structure-pending'/u,
  '0289 attestation must be visible in the health response',
)
assert.match(
  healthSource,
  /status:\s*errors\.length > 0\s*\?\s*503\s*:\s*200/u,
  'Any global health error, including 0289 drift during key adoption, must return HTTP 503',
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

async function exercise(pool) {
  assert.equal(
    await attest(pool),
    true,
    'Fresh 0289 schema must pass the exact health attestation',
  )

  await pool.query('BEGIN')
  try {
    await pool.query(
      'DROP INDEX ops_shopify_location_admin_one_unresolved_account_idx',
    )
    assert.equal(
      await attest(pool),
      false,
      'Removing the per-account unresolved-write fence must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `ALTER TABLE operations_shopify_location_administration_authorizations
       DROP CONSTRAINT ops_shopify_location_admin_auth_state_valid,
       ADD CONSTRAINT ops_shopify_location_admin_auth_state_valid
         CHECK (status IS NOT NULL)`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A same-named but weakened authorization state check must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `ALTER TABLE operations_shopify_location_administration_authorizations
       DROP CONSTRAINT ops_shopify_location_admin_auth_mapping_fkey,
       ADD CONSTRAINT ops_shopify_location_admin_auth_mapping_fkey
         FOREIGN KEY (
           organization_id, integration_account_id, location_mapping_id
         ) REFERENCES operations_commerce_inventory_location_mappings (
           organization_id, integration_account_id, id
         ) ON DELETE RESTRICT NOT VALID`,
    )
    assert.equal(
      await attest(pool),
      false,
      'An unvalidated cross-account mapping authority link must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `CREATE OR REPLACE FUNCTION
         operations_shopify_location_admin_is_current(
           p_organization_id uuid,
           p_authorization_id uuid
         )
       RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Weakening the cross-account/current-authority function must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `ALTER TABLE operations_shopify_location_administration_outcomes
       DISABLE TRIGGER protect_shopify_location_admin_outcome_write`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Disabling immutable outcome enforcement must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `UPDATE global_reference_entity_types
       SET entity_type = 'operations.shopify_location_administration_wrong'
       WHERE prefix = 'gslo'`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Changing immutable outcome reference ownership must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }
}

async function main() {
  const existingDatabaseUrl = String(
    process.env.SHOPIFY_LOCATION_ADMINISTRATION_HEALTH_DATABASE_URL || '',
  ).trim()
  if (existingDatabaseUrl) {
    const pool = new Pool({ connectionString: existingDatabaseUrl, max: 2 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
    console.log('Shopify location-administration health attestation passed')
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-shopify-location-admin-health-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=shopify_location_admin_health',
      '-e', 'POSTGRES_DB=shopify_location_admin_health',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:shopify_location_admin_health@127.0.0.1:'
      + `${port}/shopify_location_admin_health`
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

  console.log('Shopify location-administration health attestation passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
