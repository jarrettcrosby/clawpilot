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
  /const SHOPIFY_CHECKOUT_AUDIENCE_POLICY_HEALTH_SQL = String\.raw`([\s\S]*?)`\n/u,
)
assert.ok(sqlMatch, 'Health route must contain the exact 0293 attestation SQL')
const attestationSql = sqlMatch[1]

for (const fragment of [
  '0293_shopify_checkout_audience_policy.sql',
  'ad112694afea9286f28d38e6522224d44b36f5b32013f87483399e6da5ce8707',
  'operations_shopify_checkout_audience_policy_is_valid(jsonb)',
  '69cf98f4440714e6907e8c9a56a9a87e57b5985dcce3909ce80fc5980c96974a',
  'operations_shopify_configs_checkout_audience_valid',
  '8c5a314298d629ea08b1f0df80b28001f8bc31d413fe10d547dd7eaaaf5845a9',
  "config.policy_snapshot ? 'shadowCheckoutAudience'",
]) {
  assert.ok(
    attestationSql.includes(fragment),
    `0293 health attestation missing ${fragment}`,
  )
}

assert.ok(
  (healthSource.match(
    /row\?\.shopify_checkout_audience_policy_applied/gu,
  ) || []).length >= 3,
  '0293 drift must fail migrationsCurrent and global health',
)
assert.match(
  healthSource,
  /&& row\?\.shopify_checkout_audience_policy_applied/u,
  '0293 attestation must participate in migrationsCurrent',
)
assert.match(
  healthSource,
  /\|\| !row\?\.shopify_checkout_audience_policy_applied/u,
  '0293 attestation failure must append the global migration health error',
)
assert.match(
  healthSource,
  /shopifyCheckoutAudiencePolicy: \{[\s\S]*?shopify_checkout_audience_policy_applied[\s\S]*?'migration-or-structure-pending'/u,
  '0293 attestation must be visible in the health response',
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
    'Fresh 0293 schema must pass exact health attestation',
  )

  const semantics = await pool.query(
    `SELECT
       operations_shopify_checkout_audience_policy_is_valid(
         '{"version":"shopify-checkout-audience-v1","mode":"off"}'::jsonb
       ) AS valid,
       operations_shopify_checkout_audience_policy_is_valid(
         '{"version":"shopify-checkout-audience-v1","mode":"everyone"}'::jsonb
       ) AS malformed,
       operations_shopify_checkout_audience_policy_is_valid(NULL::jsonb)
         IS NULL AS missing_is_rolling_compatible`,
  )
  assert.deepEqual(semantics.rows[0], {
    valid: true,
    malformed: false,
    missing_is_rolling_compatible: true,
  })

  await pool.query(
    `CREATE TEMP TABLE checkout_audience_policy_probe (
       policy_snapshot jsonb NOT NULL,
       CONSTRAINT checkout_audience_policy_probe_valid CHECK (
         operations_shopify_checkout_audience_policy_is_valid(
           policy_snapshot -> 'shadowCheckoutAudience'
         ) IS NOT FALSE
       )
     )`,
  )
  await pool.query(
    `INSERT INTO checkout_audience_policy_probe (policy_snapshot)
     VALUES
       ('{}'::jsonb),
       ('{"shadowCheckoutAudience":{"version":"shopify-checkout-audience-v1","mode":"restricted_customers"}}'::jsonb)`,
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO checkout_audience_policy_probe (policy_snapshot)
       VALUES ('{"shadowCheckoutAudience":{"version":"shopify-checkout-audience-v1","mode":"everyone"}}'::jsonb)`,
    ),
    /checkout_audience_policy_probe_valid/u,
  )

  await tamper(
    pool,
    `UPDATE schema_migrations
     SET checksum = repeat('0', 64)
     WHERE filename = '0293_shopify_checkout_audience_policy.sql'`,
    'A changed 0293 migration checksum must fail health',
  )
  await tamper(
    pool,
    `CREATE OR REPLACE FUNCTION
       operations_shopify_checkout_audience_policy_is_valid(input jsonb)
     RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
     AS $$ SELECT true $$`,
    'A weakened audience validator must fail health',
  )
  await tamper(
    pool,
    `ALTER TABLE operations_shopify_carrier_service_configs
       DROP CONSTRAINT operations_shopify_configs_checkout_audience_valid,
       ADD CONSTRAINT operations_shopify_configs_checkout_audience_valid
         CHECK (true)`,
    'A same-named but weakened audience CHECK must fail health',
  )
}

async function main() {
  const existingDatabaseUrl = String(
    process.env.SHOPIFY_CHECKOUT_AUDIENCE_HEALTH_DATABASE_URL || '',
  ).trim()
  if (existingDatabaseUrl) {
    const pool = new Pool({ connectionString: existingDatabaseUrl, max: 2 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
    console.log('Shopify checkout-audience health attestation passed')
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-checkout-audience-health-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  let containerStarted = false
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=checkout_audience_health',
      '-e', 'POSTGRES_DB=checkout_audience_health',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    containerStarted = true
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:checkout_audience_health@127.0.0.1:'
      + `${port}/checkout_audience_health`
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
      try {
        command('docker', ['stop', container], { timeout: 30_000 })
      } catch {
        // Preserve the primary assertion if best-effort cleanup also fails.
      }
    }
  }
  console.log('Shopify checkout-audience health attestation passed')
}

await main()
