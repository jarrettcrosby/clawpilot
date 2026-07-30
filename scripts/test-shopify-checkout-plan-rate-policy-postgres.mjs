#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const TRUSTED_PROJECT_ID = 'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
const TRUSTED_ENVIRONMENT_ID = 'e4abd95f-825c-4242-b37b-825a92597e98'
const TRUSTED_DATABASE_FINGERPRINT =
  '750aa268-0e31-4065-a99c-4016e4d4fab1'
const TARGET_MIGRATION =
  '0170_operations_shopify_checkout_plan_rate_policy.sql'
const DEFAULT_POLICY = {
  version: 'shopify-checkout-plan-rate-objective-v2',
  maxCandidates: 4,
  objectivePriority: [
    'landed_price',
    'package_count',
    'unused_cube',
  ],
  handlingCostMinorPerPackage: 0,
  handlingCostCurrency: 'USD',
}

function fail(message) {
  throw new Error(message)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

function validPolicy(value) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 5
    && value.version === DEFAULT_POLICY.version
    && Number.isSafeInteger(value.maxCandidates)
    && value.maxCandidates >= 1
    && value.maxCandidates <= 4
    && Array.isArray(value.objectivePriority)
    && value.objectivePriority.length === 3
    && new Set(value.objectivePriority).size === 3
    && DEFAULT_POLICY.objectivePriority.every(
      (objective) => value.objectivePriority.includes(objective),
    )
    && Number.isSafeInteger(value.handlingCostMinorPerPackage)
    && value.handlingCostMinorPerPackage >= 0
    && value.handlingCostMinorPerPackage <= 1_000_000
    && typeof value.handlingCostCurrency === 'string'
    && /^[A-Z]{3}$/.test(value.handlingCostCurrency)
  )
}

function requireTrustedEnvironment() {
  if (
    String(process.env.RAILWAY_PROJECT_ID || '') !== TRUSTED_PROJECT_ID
    || String(process.env.RAILWAY_ENVIRONMENT_ID || '')
      !== TRUSTED_ENVIRONMENT_ID
    || String(process.env.RAILWAY_ENVIRONMENT_NAME || '') !== 'development'
  ) {
    fail(
      'Shopify plan-rate policy acceptance is restricted to the trusted Railway development environment.',
    )
  }
}

function migrationSql() {
  return readFileSync(
    fileURLToPath(
      new URL(`../db/migrations/${TARGET_MIGRATION}`, import.meta.url),
    ),
    'utf8',
  )
}

let databaseUrl = String(
  process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '',
).trim()
if (!databaseUrl) {
  fail('DATABASE_PUBLIC_URL or DATABASE_URL is required.')
}
requireTrustedEnvironment()

let parsedUrl = new URL(databaseUrl)
if (parsedUrl.hostname.endsWith('.railway.internal')) {
  const databaseVariables = JSON.parse(execFileSync(
    'railway',
    [
      'variables',
      '--service',
      'Postgres',
      '--environment',
      'development',
      '--json',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  ))
  databaseUrl = String(databaseVariables.DATABASE_PUBLIC_URL || '').trim()
  if (!databaseUrl) {
    fail('The Railway Postgres public validation URL is unavailable.')
  }
  parsedUrl = new URL(databaseUrl)
}
parsedUrl.searchParams.delete('sslmode')

const pool = new Pool({
  connectionString: parsedUrl.toString(),
  ssl: parsedUrl.hostname.endsWith('rlwy.net')
    ? { rejectUnauthorized: false }
    : undefined,
  application_name: 'clawpilot-shopify-plan-rate-policy-rollback-acceptance',
  max: 2,
  connectionTimeoutMillis: 15_000,
  query_timeout: 120_000,
})

async function databaseFingerprint(client) {
  const result = await client.query(
    `SELECT (
       SELECT value ->> 'id'
       FROM app_settings
       WHERE key = 'deployment.database.identity'
     ) AS database_fingerprint`,
  )
  return result.rows[0]?.database_fingerprint || null
}

async function configs(client) {
  const result = await client.query(
    `SELECT
       config.organization_id::text,
       config.id::text,
       config.policy_revision::text,
       config.policy_hash,
       config.policy_snapshot,
       config.row_version::text,
       upper(preference.currency_code) AS organization_currency_code
     FROM operations_shopify_carrier_service_configs config
     JOIN workspace_organization_preferences preference
       ON preference.organization_id = config.organization_id
     ORDER BY config.organization_id, config.id`,
  )
  return result.rows
}

async function missingPreferenceConfigCount(client) {
  const result = await client.query(
    `SELECT count(*)::text AS count
     FROM operations_shopify_carrier_service_configs config
     LEFT JOIN workspace_organization_preferences preference
       ON preference.organization_id = config.organization_id
     WHERE preference.organization_id IS NULL`,
  )
  return Number(result.rows[0]?.count || 0)
}

async function main() {
  const client = await pool.connect()
  let before
  try {
    assert.equal(
      await databaseFingerprint(client),
      TRUSTED_DATABASE_FINGERPRINT,
      'connected database is not the trusted ClawPilot development database',
    )
    const applied = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM schema_migrations WHERE filename = $1
       ) AS applied`,
      [TARGET_MIGRATION],
    )
    assert.equal(
      applied.rows[0]?.applied,
      false,
      `${TARGET_MIGRATION} is already permanently applied`,
    )
    before = await configs(client)
    assert.ok(
      before.length > 0,
      'At least one current tenant CarrierService config is required',
    )

    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = '120s'`)
    await client.query(`SET LOCAL lock_timeout = '15s'`)
    await client.query(migrationSql())

    assert.equal(
      await missingPreferenceConfigCount(client),
      0,
      'Every current tenant CarrierService config must have a currency preference after migration',
    )
    const after = await configs(client)
    assert.equal(after.length, before.length)
    for (const row of after) {
      const original = before.find((candidate) => (
        candidate.organization_id === row.organization_id
        && candidate.id === row.id
      ))
      assert.ok(original)
      const policy = row.policy_snapshot.planRateOptimization
      assert.equal(validPolicy(policy), true)
      assert.equal(hash(row.policy_snapshot), row.policy_hash)
      const wasValid = validPolicy(
        original.policy_snapshot.planRateOptimization,
      )
      assert.equal(
        Number(row.policy_revision),
        Number(original.policy_revision) + (wasValid ? 0 : 1),
      )
      assert.equal(
        Number(row.row_version),
        Number(original.row_version) + (wasValid ? 0 : 1),
      )
      if (!wasValid) {
        assert.deepEqual(policy, {
          ...DEFAULT_POLICY,
          handlingCostCurrency: row.organization_currency_code,
        })
      }
    }

    const target = after[0]
    const wrongTenant = await client.query(
      `UPDATE operations_shopify_carrier_service_configs
       SET policy_revision = policy_revision + 1
       WHERE organization_id =
         '00000000-0000-0000-0000-000000000000'::uuid
         AND id = $1::uuid`,
      [target.id],
    )
    assert.equal(
      wrongTenant.rowCount,
      0,
      'A different tenant must not mutate the target config',
    )

    const selectedPolicy = {
      ...DEFAULT_POLICY,
      maxCandidates: 2,
      objectivePriority: [
        'unused_cube',
        'landed_price',
        'package_count',
      ],
      handlingCostMinorPerPackage: 17,
      handlingCostCurrency: target.organization_currency_code,
    }
    const selectedSnapshot = {
      ...target.policy_snapshot,
      planRateOptimization: selectedPolicy,
    }
    const selected = await client.query(
      `UPDATE operations_shopify_carrier_service_configs
       SET policy_snapshot = $3::jsonb,
           policy_hash = encode(
             digest(
               canonical_operations_shopify_checkout_policy_jsonb(
                 $3::jsonb
               ),
               'sha256'
             ),
             'hex'
           ),
           policy_revision = policy_revision + 1,
           row_version = row_version + 1
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
       RETURNING policy_snapshot, policy_hash`,
      [
        target.organization_id,
        target.id,
        JSON.stringify(selectedSnapshot),
      ],
    )
    assert.equal(selected.rowCount, 1)
    assert.deepEqual(
      selected.rows[0].policy_snapshot.planRateOptimization,
      selectedPolicy,
    )
    assert.equal(
      selected.rows[0].policy_hash,
      hash(selected.rows[0].policy_snapshot),
    )

    await client.query('SAVEPOINT missing_policy')
    await assert.rejects(
      client.query(
        `UPDATE operations_shopify_carrier_service_configs
         SET policy_snapshot = policy_snapshot - 'planRateOptimization',
             row_version = row_version + 1
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [target.organization_id, target.id],
      ),
      /operations_shopify_configs_plan_rate_policy_valid/,
    )
    await client.query('ROLLBACK TO SAVEPOINT missing_policy')
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }

  const verification = await pool.connect()
  try {
    assert.deepEqual(
      await configs(verification),
      before,
      'Rollback acceptance must leave every tenant config unchanged',
    )
  } finally {
    verification.release()
    await pool.end()
  }

  console.log(JSON.stringify({
    ok: true,
    suite: 'shopify-checkout-plan-rate-policy-postgres',
    migration: TARGET_MIGRATION,
    currentTenantConfigCount: before.length,
    rolledBack: true,
  }, null, 2))
}

await main()
