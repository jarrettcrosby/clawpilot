#!/usr/bin/env node

import assert from 'node:assert/strict'
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
const MIGRATIONS = [
  '0148_operations_commerce_external_effects.sql',
  '0149_operations_shopify_checkout_rating.sql',
  '0150_operations_shopify_carrier_service_mutation_authorization.sql',
]
const MIGRATION_PASSES = 1
const EXPECTED_RELATIONS = [
  'operations_commerce_external_effect_aggregate_fences',
  'operations_commerce_external_effect_intents',
  'operations_shopify_carrier_service_configs',
  'operations_shopify_carrier_service_config_materials',
  'operations_shopify_carrier_service_config_carriers',
  'operations_shopify_checkout_rate_receipts',
  'operations_shopify_checkout_rate_receipt_lines',
  'operations_shopify_checkout_rate_receipt_packages',
  'operations_shopify_checkout_rate_receipt_allocations',
  'operations_shopify_checkout_rate_receipt_offers',
  'operations_shopify_checkout_rate_reconciliations',
  'operations_shopify_carrier_service_mutation_authorizations',
  'operations_shopify_carrier_service_mutation_attempts',
  'operations_shopify_carrier_service_mutation_outcomes',
  'operations_shopify_carrier_service_mutation_resolutions',
  'operations_shopify_carrier_service_config_mutation_links',
]

function fail(message) {
  throw new Error(message)
}

function requireTrustedEnvironment() {
  if (
    String(process.env.RAILWAY_PROJECT_ID || '') !== TRUSTED_PROJECT_ID
    || String(process.env.RAILWAY_ENVIRONMENT_ID || '')
      !== TRUSTED_ENVIRONMENT_ID
    || String(process.env.RAILWAY_ENVIRONMENT_NAME || '') !== 'development'
  ) {
    fail(
      'Shopify PostgreSQL acceptance is restricted to the trusted Railway development environment.',
    )
  }
}

function migrationSql(filename) {
  return readFileSync(
    fileURLToPath(
      new URL(`../db/migrations/${filename}`, import.meta.url),
    ),
    'utf8',
  )
}

const databaseUrl = String(
  process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '',
).trim()
if (!databaseUrl) {
  fail('DATABASE_PUBLIC_URL or DATABASE_URL is required.')
}
requireTrustedEnvironment()

const parsedUrl = new URL(databaseUrl)
parsedUrl.searchParams.delete('sslmode')
const pool = new Pool({
  connectionString: parsedUrl.toString(),
  ssl: parsedUrl.hostname.endsWith('rlwy.net')
    ? { rejectUnauthorized: false }
    : undefined,
  application_name: 'clawpilot-shopify-postgres-rollback-acceptance',
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

async function relationState(client) {
  const result = await client.query(
    `SELECT requested.name,
       to_regclass('public.' || requested.name)::text AS relation_name
     FROM unnest($1::text[]) AS requested(name)
     ORDER BY requested.name`,
    [EXPECTED_RELATIONS],
  )
  return Object.fromEntries(
    result.rows.map((row) => [row.name, row.relation_name]),
  )
}

async function appliedMigrationState(client) {
  const result = await client.query(
    `SELECT filename
     FROM schema_migrations
     WHERE filename = ANY($1::text[])
     ORDER BY filename`,
    [MIGRATIONS],
  )
  return result.rows.map((row) => row.filename)
}

async function assertNewIdentifiersFitPostgres(client) {
  const result = await client.query(
    `SELECT object_name, length(object_name) AS object_name_length
     FROM (
       SELECT c.relname AS object_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND (
           c.relname LIKE 'operations_commerce_external_effect%'
           OR c.relname LIKE 'operations_shopify_carrier_service%'
           OR c.relname LIKE 'operations_shopify_checkout_rate%'
         )
       UNION ALL
       SELECT p.proname AS object_name
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND (
           p.proname LIKE '%commerce_external_effect%'
           OR p.proname LIKE '%shopify_carrier_service%'
           OR p.proname LIKE '%shopify_checkout_rate%'
         )
       UNION ALL
       SELECT t.tgname AS object_name
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND NOT t.tgisinternal
         AND (
           t.tgname LIKE '%commerce_external_effect%'
           OR t.tgname LIKE '%shopify_carrier_service%'
           OR t.tgname LIKE '%shopify_checkout_rate%'
         )
     ) objects
     WHERE length(object_name) > 63
     ORDER BY object_name`,
  )
  assert.deepEqual(
    result.rows,
    [],
    'new Shopify/commerce SQL identifiers must not exceed 63 bytes',
  )
}

async function assertRequiredDatabaseGuards(client) {
  const triggers = await client.query(
    `SELECT t.tgname, pg_get_triggerdef(t.oid) AS definition
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND NOT t.tgisinternal
       AND c.relname = ANY($1::text[])`,
    [[
      'operations_commerce_external_effect_intents',
      'operations_shopify_carrier_service_configs',
      'operations_shopify_checkout_rate_receipt_packages',
      'operations_shopify_checkout_rate_receipt_offers',
      'operations_shopify_checkout_rate_reconciliations',
      'operations_shopify_carrier_service_mutation_attempts',
      'operations_shopify_carrier_service_mutation_outcomes',
      'operations_shopify_carrier_service_mutation_resolutions',
    ]],
  )
  const names = new Set(triggers.rows.map((row) => row.tgname))
  for (const required of [
    'protect_operations_commerce_external_effect_intent_write',
    'validate_operations_shopify_carrier_service_config_write',
    'protect_operations_shopify_checkout_rate_receipt_package_write',
    'protect_operations_shopify_checkout_rate_receipt_offer_write',
    'protect_operations_shopify_checkout_rate_reconciliation_write',
    'protect_ops_shopify_cs_mut_attempt_write',
    'protect_ops_shopify_cs_mut_outcome_write',
    'protect_ops_shopify_cs_mut_resolution_write',
  ]) {
    assert.ok(names.has(required), `missing database guard ${required}`)
  }

  const packageColumns = await client.query(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name =
         'operations_shopify_checkout_rate_receipt_packages'
       AND column_name = ANY($1::text[])
     ORDER BY column_name`,
    [[
      'packaging_material_stock_id',
      'packaging_material_stock_row_version',
      'packaging_material_stock_on_hand_quantity',
      'carrier_parcel_snapshot',
    ]],
  )
  assert.deepEqual(
    packageColumns.rows.map((row) => row.column_name),
    [
      'carrier_parcel_snapshot',
      'packaging_material_stock_id',
      'packaging_material_stock_on_hand_quantity',
      'packaging_material_stock_row_version',
    ],
  )
  assert.ok(
    packageColumns.rows.every((row) => row.is_nullable === 'NO'),
    'package stock and parcel evidence must be required',
  )

  const offerColumns = await client.query(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name =
         'operations_shopify_checkout_rate_receipt_offers'
       AND column_name = ANY($1::text[])
     ORDER BY column_name`,
    [[
      'carrier_request_hash',
      'carrier_response_rate_hash',
      'carrier_rate_purpose',
    ]],
  )
  assert.deepEqual(
    offerColumns.rows.map((row) => row.column_name),
    [
      'carrier_rate_purpose',
      'carrier_request_hash',
      'carrier_response_rate_hash',
    ],
  )
  assert.ok(
    offerColumns.rows.every((row) => row.is_nullable === 'NO'),
    'offer request/response bindings must be required',
  )

  const resolutionEvidence = await client.query(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name =
         'operations_shopify_carrier_service_mutation_resolutions'
       AND column_name = 'redacted_evidence'`,
  )
  assert.deepEqual(
    resolutionEvidence.rows,
    [{ column_name: 'redacted_evidence', is_nullable: 'NO' }],
    'reconciliation must retain required redacted provider evidence',
  )
  const resolutionConstraints = await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     JOIN pg_class r ON r.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'public'
       AND r.relname =
         'operations_shopify_carrier_service_mutation_resolutions'
       AND c.conname =
         'ops_shopify_cs_mut_resolution_redacted'`,
  )
  assert.equal(resolutionConstraints.rows.length, 1)
  assert.match(
    resolutionConstraints.rows[0].definition,
    /operations_commerce_external_effect_json_is_redacted\(redacted_evidence\)/,
  )
}

async function main() {
  const client = await pool.connect()
  let beforeRelations
  let beforeMigrations
  try {
    assert.equal(
      await databaseFingerprint(client),
      TRUSTED_DATABASE_FINGERPRINT,
      'connected database is not the trusted ClawPilot development database',
    )
    beforeRelations = await relationState(client)
    beforeMigrations = await appliedMigrationState(client)
    assert.deepEqual(
      beforeMigrations,
      [],
      'rollback-only acceptance must run before migrations 0148-0150 are permanently applied',
    )
    assert.ok(
      Object.values(beforeRelations).every((value) => value === null),
      'rollback-only acceptance expected migrations 0148-0150 to be absent',
    )

    await client.query('BEGIN')
    try {
      await client.query(`SET LOCAL statement_timeout = '120s'`)
      for (let pass = 1; pass <= MIGRATION_PASSES; pass += 1) {
        for (const filename of MIGRATIONS) {
          try {
            await client.query(migrationSql(filename))
          } catch (error) {
            error.message =
              `${filename} pass ${pass}: ${error.message}`
            throw error
          }
        }
      }
      const duringRelations = await relationState(client)
      assert.ok(
        Object.values(duringRelations).every((value) => value !== null),
        'migrations did not create every expected relation',
      )
      await assertNewIdentifiersFitPostgres(client)
      await assertRequiredDatabaseGuards(client)
    } finally {
      await client.query('ROLLBACK')
    }
  } finally {
    client.release()
  }

  const verification = await pool.connect()
  try {
    assert.equal(
      await databaseFingerprint(verification),
      TRUSTED_DATABASE_FINGERPRINT,
    )
    assert.deepEqual(
      await relationState(verification),
      beforeRelations,
      'rollback left Shopify checkout schema residue',
    )
    assert.deepEqual(
      await appliedMigrationState(verification),
      beforeMigrations,
      'rollback changed schema migration history',
    )
  } finally {
    verification.release()
    await pool.end()
  }

  console.log(JSON.stringify({
    ok: true,
    acceptance: 'rollback-only-postgres',
    databaseFingerprint: TRUSTED_DATABASE_FINGERPRINT,
    migrations: MIGRATIONS,
    migrationPasses: MIGRATION_PASSES,
    retainedSchemaOrData: false,
  }, null, 2))
}

main().catch(async (error) => {
  await pool.end().catch(() => undefined)
  console.error(error)
  process.exit(1)
})
