#!/usr/bin/env node

import assert from 'node:assert/strict'
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
const TARGET_MIGRATION = '0165_shopify_store_entity_readiness.sql'

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
      'Shopify store-entity acceptance is restricted to the trusted Railway development environment.',
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
  application_name: 'clawpilot-shopify-store-entity-rollback-acceptance',
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

async function migrationApplied(client) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM schema_migrations
       WHERE filename = $1
     ) AS applied`,
    [TARGET_MIGRATION],
  )
  return result.rows[0]?.applied === true
}

async function readinessFunctionDefinition(client) {
  const result = await client.query(
    `SELECT pg_get_functiondef(
       'operations_shopify_carrier_service_config_is_ready(uuid,uuid)'
         ::regprocedure
     ) AS definition`,
  )
  return result.rows[0]?.definition || null
}

async function readyConfiguration(client) {
  const result = await client.query(
    `SELECT
       config.organization_id::text,
       config.id::text AS config_id,
       account.id::text AS integration_account_id,
       account.configuration,
       account.configuration ->> 'accountName' AS account_name
     FROM operations_shopify_carrier_service_configs config
     JOIN operations_integration_accounts account
       ON account.organization_id = config.organization_id
      AND account.id = config.integration_account_id
     WHERE operations_shopify_carrier_service_config_is_ready(
       config.organization_id,
       config.id
     )
       AND length(
         btrim(account.configuration ->> 'accountName')
       ) BETWEEN 1 AND 255
     ORDER BY config.updated_at DESC
     LIMIT 1`,
  )
  if (!result.rows[0]) {
    fail(
      'A ready development Shopify CarrierService configuration with a provider store entity is required.',
    )
  }
  return result.rows[0]
}

async function isReady(client, fixture) {
  const result = await client.query(
    `SELECT operations_shopify_carrier_service_config_is_ready(
       $1::uuid,
       $2::uuid
     ) AS ready`,
    [fixture.organization_id, fixture.config_id],
  )
  return result.rows[0]?.ready === true
}

async function setAccountName(client, fixture, value) {
  await client.query(
    `UPDATE operations_integration_accounts
     SET configuration = CASE
       WHEN $3::text IS NULL THEN configuration - 'accountName'
       ELSE jsonb_set(configuration, '{accountName}', to_jsonb($3::text), true)
     END
     WHERE organization_id = $1::uuid
       AND id = $2::uuid`,
    [
      fixture.organization_id,
      fixture.integration_account_id,
      value,
    ],
  )
}

async function main() {
  const client = await pool.connect()
  let beforeDefinition
  let fixture
  try {
    assert.equal(
      await databaseFingerprint(client),
      TRUSTED_DATABASE_FINGERPRINT,
      'connected database is not the trusted ClawPilot development database',
    )
    assert.equal(
      await migrationApplied(client),
      false,
      `${TARGET_MIGRATION} is already permanently applied`,
    )
    beforeDefinition = await readinessFunctionDefinition(client)
    fixture = await readyConfiguration(client)

    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = '120s'`)
    await client.query(`SET LOCAL lock_timeout = '15s'`)
    await client.query(migrationSql())

    assert.equal(
      await isReady(client, fixture),
      true,
      'A verified provider store entity must retain readiness.',
    )

    await setAccountName(client, fixture, null)
    assert.equal(
      await isReady(client, fixture),
      false,
      'A missing provider store entity must fail readiness.',
    )

    await setAccountName(client, fixture, '   ')
    assert.equal(
      await isReady(client, fixture),
      false,
      'A blank provider store entity must fail readiness.',
    )

    await setAccountName(client, fixture, 'A'.repeat(256))
    assert.equal(
      await isReady(client, fixture),
      false,
      'An oversized provider store entity must fail readiness.',
    )

    await setAccountName(client, fixture, 'Store\nName')
    assert.equal(
      await isReady(client, fixture),
      false,
      'A provider store entity with control characters must fail readiness.',
    )

    await setAccountName(client, fixture, 'A'.repeat(255))
    assert.equal(
      await isReady(client, fixture),
      true,
      'A visible provider store entity at the upper bound must be ready.',
    )

    await setAccountName(client, fixture, fixture.account_name)
    assert.equal(
      await isReady(client, fixture),
      true,
      'Restoring the verified store entity must restore readiness.',
    )

    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }

  const verification = await pool.connect()
  try {
    assert.equal(
      await databaseFingerprint(verification),
      TRUSTED_DATABASE_FINGERPRINT,
    )
    assert.equal(await migrationApplied(verification), false)
    assert.equal(
      await readinessFunctionDefinition(verification),
      beforeDefinition,
      'Rollback left a changed readiness function.',
    )
    const restored = await verification.query(
      `SELECT configuration
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [fixture.organization_id, fixture.integration_account_id],
    )
    assert.deepEqual(
      restored.rows[0]?.configuration,
      fixture.configuration,
      'Rollback left Shopify integration data changes.',
    )
  } finally {
    verification.release()
    await pool.end()
  }

  console.log(JSON.stringify({
    ok: true,
    acceptance: 'rollback-only-postgres',
    databaseFingerprint: TRUSTED_DATABASE_FINGERPRINT,
    targetMigration: TARGET_MIGRATION,
    providerStoreEntity: fixture.account_name,
    missingEntityRejected: true,
    blankEntityRejected: true,
    oversizedEntityRejected: true,
    controlCharacterEntityRejected: true,
    upperBoundEntityAccepted: true,
    retainedSchemaOrData: false,
  }, null, 2))
}

main().catch(async (error) => {
  await pool.end().catch(() => undefined)
  console.error(error)
  process.exit(1)
})
