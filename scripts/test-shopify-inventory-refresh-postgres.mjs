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
const PREREQUISITE_MIGRATIONS = [
  '0169_operations_shopify_inventory_refresh_queue.sql',
  '0171_shopify_active_account_readiness.sql',
]
const TARGET_MIGRATIONS = [
  '0172_operations_commerce_inventory_attempt_lease_renewal.sql',
]
const ZERO_EFFECT_SUMMARY = {
  resource: 'inventory',
  readOnly: true,
  providerWrites: 0,
  orderQuantityAdjustment: 0,
}

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
      'Shopify inventory refresh acceptance is restricted to the trusted Railway development environment.',
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
  application_name:
    'clawpilot-shopify-inventory-refresh-rollback-acceptance',
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

async function migrationApplied(client, filename) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM schema_migrations
       WHERE filename = $1
     ) AS applied`,
    [filename],
  )
  return result.rows[0]?.applied === true
}

async function durableState(client) {
  const result = await client.query(
    `SELECT
       to_regclass(
         'public.operations_shopify_inventory_refresh_jobs'
       )::text AS queue_table,
       to_regclass(
         'public.idx_operations_shopify_inventory_refresh_active_account'
       )::text AS active_job_index,
       to_regclass(
         'public.idx_operations_shopify_inventory_read_singleflight'
       )::text AS provider_read_index,
       (
         SELECT count(*)::text
         FROM crm_reference_registry
       ) AS registry_count,
       (
         SELECT COALESCE(
           jsonb_agg(to_jsonb(attempt) ORDER BY attempt.id)::text,
           '[]'
         )
         FROM operations_commerce_provider_attempts attempt
       ) AS provider_attempts,
       (
         SELECT COALESCE(
           jsonb_agg(to_jsonb(job) ORDER BY job.id)::text,
           '[]'
         )
         FROM operations_shopify_inventory_refresh_jobs job
       ) AS inventory_refresh_jobs,
       (
         SELECT count(*)::text
         FROM operations_commerce_inventory_captures
       ) AS inventory_capture_count,
       (
         SELECT md5(COALESCE(string_agg(
           capture.id::text || ':' ||
           capture.provider_attempt_id::text || ':' ||
           capture.request_hash || ':' ||
           capture.snapshot_hash,
           ',' ORDER BY capture.id
         ), ''))
         FROM operations_commerce_inventory_captures capture
       ) AS inventory_capture_hash,
       (
         SELECT md5(COALESCE(string_agg(
           account.id::text || ':' || account.status,
           ',' ORDER BY account.id
         ), ''))
         FROM operations_integration_accounts account
       ) AS integration_account_status_hash,
       pg_get_functiondef(
         'operations_shopify_carrier_service_config_is_ready(uuid,uuid)'
           ::regprocedure
       ) AS readiness_function,
       pg_get_functiondef(
         'protect_operations_commerce_provider_attempt()'
           ::regprocedure
       ) AS provider_attempt_protection_function,
       (
         SELECT pg_get_triggerdef(trigger.oid) || ':' ||
                trigger.tgenabled::text
         FROM pg_trigger trigger
         WHERE trigger.tgrelid =
             'operations_commerce_provider_attempts'::regclass
           AND trigger.tgname =
             'protect_operations_commerce_provider_attempt_write'
           AND trigger.tgisinternal = false
       ) AS provider_attempt_protection_trigger`,
  )
  return {
    ...result.rows[0],
    migrationsApplied: Object.fromEntries(
      await Promise.all(TARGET_MIGRATIONS.map(async (filename) => [
        filename,
        await migrationApplied(client, filename),
      ])),
    ),
  }
}

async function readyFixture(client) {
  const result = await client.query(
    `SELECT
       config.organization_id::text,
       config.integration_account_id::text,
       account.global_id AS account_global_id,
       config.id::text AS carrier_service_config_id,
       config.warehouse_id::text,
       config.credential_generation,
       config.activation_revision,
       config.row_version::text AS config_row_version,
       config.policy_revision::text,
       config.policy_hash,
       config.inventory_max_age_seconds
     FROM operations_shopify_carrier_service_configs config
     JOIN operations_integration_accounts account
       ON account.organization_id = config.organization_id
      AND account.id = config.integration_account_id
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
      AND credential.credential_version = config.credential_generation
     JOIN operations_activation_scopes activation
       ON activation.organization_id = config.organization_id
      AND activation.revision = config.activation_revision
     WHERE config.registration_state IN (
         'shadow_simulated', 'registered'
       )
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND account.status = 'active'
       AND account.commerce_credential_generation =
           config.credential_generation
       AND credential.verification_status = 'verified'
       AND (
         (config.registration_state = 'registered'
           AND activation.state IN ('shadow', 'active'))
         OR
         (config.registration_state = 'shadow_simulated'
           AND activation.state = 'shadow')
       )
       AND COALESCE(
         account.configuration->'grantedScopes',
         '[]'::jsonb
       ) ?| ARRAY['read_inventory', 'write_inventory']
       AND COALESCE(
         account.configuration->'grantedScopes',
         '[]'::jsonb
       ) ?| ARRAY['read_locations', 'write_locations']
       AND COALESCE(
         account.configuration->'grantedScopes',
         '[]'::jsonb
       ) ?| ARRAY['read_products', 'write_products']
       AND operations_shopify_carrier_service_config_is_ready(
         config.organization_id,
         config.id
       )
     ORDER BY config.updated_at DESC, config.id
     LIMIT 1`,
  )
  if (!result.rows[0]) {
    fail(
      'A checkout-ready development Shopify account is required.',
    )
  }
  return result.rows[0]
}

async function insertProviderAttempt(client, fixture, suffix) {
  const result = await client.query(
    `INSERT INTO operations_commerce_provider_attempts (
       organization_id,
       integration_account_id,
       action,
       adapter_version,
       idempotency_key,
       request_hash,
       redacted_request,
       lease_token,
       lease_expires_at
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       'inventory.levels.read',
       'shopify-inventory-refresh-postgres-acceptance-v1',
       $3,
       $4,
       '{"resource":"inventory","readOnly":true}'::jsonb,
       gen_random_uuid(),
       now() + interval '20 minutes'
     )
     RETURNING id::text`,
    [
      fixture.organization_id,
      fixture.integration_account_id,
      `rollback-acceptance:${suffix}`,
      suffix.repeat(64).slice(0, 64),
    ],
  )
  return result.rows[0].id
}

async function activeProviderAttempt(client, fixture) {
  const result = await client.query(
    `SELECT id::text
     FROM operations_commerce_provider_attempts
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND action = 'inventory.levels.read'
       AND state = 'prepared'
     LIMIT 1`,
    [
      fixture.organization_id,
      fixture.integration_account_id,
    ],
  )
  return result.rows[0]?.id || null
}

async function finalizeProviderAttempt(client, id) {
  await client.query(
    `UPDATE operations_commerce_provider_attempts
     SET state = 'succeeded',
         redacted_response = $2::jsonb,
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = now()
     WHERE id = $1::uuid`,
    [id, JSON.stringify(ZERO_EFFECT_SUMMARY)],
  )
}

async function rejectWithinSavepoint(
  client,
  savepoint,
  operation,
  expected,
) {
  assert.match(
    savepoint,
    /^[a-z][a-z0-9_]*$/,
    'acceptance savepoint name must be a safe SQL identifier',
  )
  await client.query(`SAVEPOINT ${savepoint}`)
  try {
    await assert.rejects(operation(), expected)
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    await client.query(`RELEASE SAVEPOINT ${savepoint}`)
  }
}

async function latestInventoryCapture(client, fixture) {
  const result = await client.query(
    `SELECT capture.id::text
     FROM operations_commerce_inventory_captures capture
     WHERE capture.organization_id = $1::uuid
       AND capture.integration_account_id = $2::uuid
     ORDER BY capture.created_at DESC, capture.id DESC
     LIMIT 1`,
    [fixture.organization_id, fixture.integration_account_id],
  )
  if (!result.rows[0]?.id) {
    fail(
      'A durable Shopify inventory capture is required for lease acceptance.',
    )
  }
  return result.rows[0].id
}

async function terminalizePreparedInventoryAttempt(client, fixture) {
  const result = await client.query(
    `UPDATE operations_commerce_provider_attempts
     SET state = 'unknown',
         redacted_response = $3::jsonb,
         error_code = 'ROLLBACK_ACCEPTANCE_REPLACED',
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND action = 'inventory.levels.read'
       AND state = 'prepared'
     RETURNING id::text`,
    [
      fixture.organization_id,
      fixture.integration_account_id,
      JSON.stringify(ZERO_EFFECT_SUMMARY),
    ],
  )
  return result.rows.map((row) => row.id)
}

async function insertLeaseFixture(
  client,
  fixture,
  sourceCaptureId,
  {
    suffix,
    action = 'inventory.levels.read',
    requestHash = suffix.repeat(64).slice(0, 64),
    captureRequestHash = requestHash,
    withCapture = true,
    withLease = true,
  },
) {
  const attempt = await client.query(
    `INSERT INTO operations_commerce_provider_attempts (
       organization_id,
       integration_account_id,
       action,
       adapter_version,
       idempotency_key,
       request_hash,
       redacted_request,
       lease_token,
       lease_expires_at
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3,
       'shopify-inventory-lease-postgres-acceptance-v1',
       $4,
       $5,
       '{"resource":"inventory","readOnly":true}'::jsonb,
       CASE WHEN $6::boolean THEN gen_random_uuid() ELSE NULL END,
       CASE
         WHEN $6::boolean
         THEN clock_timestamp() - interval '1 second'
         ELSE NULL
       END
     )
     RETURNING id::text, lease_token::text, request_hash`,
    [
      fixture.organization_id,
      fixture.integration_account_id,
      action,
      `rollback-lease-acceptance:${suffix}`,
      requestHash,
      withLease,
    ],
  )
  const row = attempt.rows[0]
  if (withCapture) {
    await client.query(
      `INSERT INTO operations_commerce_inventory_captures (
         organization_id,
         integration_account_id,
         provider_attempt_id,
         warehouse_id,
         location_id,
         provider,
         adapter_version,
         credential_version,
         request_hash,
         snapshot_hash,
         provider_location_id,
         provider_fetched_at,
         level_count,
         captured_snapshot,
         snapshot_bytes,
         created_by
       )
       SELECT
         source.organization_id,
         source.integration_account_id,
         $4::uuid,
         source.warehouse_id,
         source.location_id,
         source.provider,
         source.adapter_version,
         source.credential_version,
         $5,
         source.snapshot_hash,
         source.provider_location_id,
         source.provider_fetched_at,
         source.level_count,
         source.captured_snapshot,
         source.snapshot_bytes,
         source.created_by
       FROM operations_commerce_inventory_captures source
       WHERE source.organization_id = $1::uuid
         AND source.integration_account_id = $2::uuid
         AND source.id = $3::uuid`,
      [
        fixture.organization_id,
        fixture.integration_account_id,
        sourceCaptureId,
        row.id,
        captureRequestHash,
      ],
    )
  }
  return row
}

async function terminalizeLeaseFixture(client, id) {
  await client.query(
    `UPDATE operations_commerce_provider_attempts
     SET state = 'unknown',
         redacted_response = $2::jsonb,
         error_code = 'ROLLBACK_ACCEPTANCE_COMPLETE',
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = clock_timestamp()
     WHERE id = $1::uuid
       AND state = 'prepared'`,
    [id, JSON.stringify(ZERO_EFFECT_SUMMARY)],
  )
}

async function exerciseProviderAttemptLeaseProtection(
  client,
  fixture,
) {
  const sourceCaptureId = await latestInventoryCapture(client, fixture)
  await terminalizePreparedInventoryAttempt(client, fixture)

  const captured = await insertLeaseFixture(
    client,
    fixture,
    sourceCaptureId,
    { suffix: 'lease', requestHash: 'd'.repeat(64) },
  )
  const immutableBefore = await client.query(
    `SELECT (
       to_jsonb(attempt)
         - ARRAY['lease_token', 'lease_expires_at']::text[]
     )::text AS immutable_attempt,
     (
       SELECT md5(to_jsonb(capture)::text)
       FROM operations_commerce_inventory_captures capture
       WHERE capture.provider_attempt_id = attempt.id
     ) AS capture_hash
     FROM operations_commerce_provider_attempts attempt
     WHERE attempt.id = $1::uuid`,
    [captured.id],
  )

  await rejectWithinSavepoint(
    client,
    'expired_same_token',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET lease_expires_at =
             clock_timestamp() + interval '15 minutes'
       WHERE id = $1::uuid`,
      [captured.id],
    ),
    /lease renewal must extend one live bounded lease/,
  )

  const rotated = await client.query(
    `UPDATE operations_commerce_provider_attempts
     SET lease_token = gen_random_uuid(),
         lease_expires_at =
           clock_timestamp() + interval '15 minutes'
     WHERE id = $1::uuid
       AND lease_token = $2::uuid
       AND lease_expires_at <= clock_timestamp()
     RETURNING lease_token::text, lease_expires_at`,
    [captured.id, captured.lease_token],
  )
  assert.equal(rotated.rowCount, 1)
  const liveToken = rotated.rows[0].lease_token

  const secondRotation = await client.query(
    `UPDATE operations_commerce_provider_attempts
     SET lease_token = gen_random_uuid(),
         lease_expires_at =
           clock_timestamp() + interval '15 minutes'
     WHERE id = $1::uuid
       AND lease_token = $2::uuid
       AND lease_expires_at <= clock_timestamp()
     RETURNING id`,
    [captured.id, captured.lease_token],
  )
  assert.equal(
    secondRotation.rowCount,
    0,
    'Only one expired-token rotation may win.',
  )

  const staleTerminalization = await client.query(
    `UPDATE operations_commerce_provider_attempts
     SET state = 'succeeded',
         redacted_response = $3::jsonb,
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = clock_timestamp()
     WHERE id = $1::uuid
       AND lease_token = $2::uuid
     RETURNING id`,
    [
      captured.id,
      captured.lease_token,
      JSON.stringify(ZERO_EFFECT_SUMMARY),
    ],
  )
  assert.equal(staleTerminalization.rowCount, 0)

  await rejectWithinSavepoint(
    client,
    'live_token_rotation',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET lease_token = gen_random_uuid(),
           lease_expires_at =
             clock_timestamp() + interval '15 minutes'
       WHERE id = $1::uuid`,
      [captured.id],
    ),
    /lease rotation requires one expired captured read/,
  )

  const renewed = await client.query(
    `UPDATE operations_commerce_provider_attempts
     SET lease_expires_at =
           clock_timestamp() + interval '15 minutes'
     WHERE id = $1::uuid
       AND lease_token = $2::uuid
     RETURNING lease_expires_at`,
    [captured.id, liveToken],
  )
  assert.equal(renewed.rowCount, 1)

  await rejectWithinSavepoint(
    client,
    'lease_noop',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET lease_expires_at = lease_expires_at
       WHERE id = $1::uuid`,
      [captured.id],
    ),
    /lease renewal must extend one live bounded lease/,
  )
  await rejectWithinSavepoint(
    client,
    'lease_shortening',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET lease_expires_at = lease_expires_at - interval '1 second'
       WHERE id = $1::uuid`,
      [captured.id],
    ),
    /lease renewal must extend one live bounded lease/,
  )
  await rejectWithinSavepoint(
    client,
    'lease_overlong',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET lease_expires_at =
             clock_timestamp() + interval '16 minutes'
       WHERE id = $1::uuid`,
      [captured.id],
    ),
    /lease renewal must extend one live bounded lease/,
  )
  await rejectWithinSavepoint(
    client,
    'nonlease_mutation',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET error_code = 'NOT_ALLOWED'
       WHERE id = $1::uuid`,
      [captured.id],
    ),
    /permit lease-only maintenance/,
  )
  await rejectWithinSavepoint(
    client,
    'identity_mutation',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET id = gen_random_uuid()
       WHERE id = $1::uuid`,
      [captured.id],
    ),
    /identity and request evidence are immutable/,
  )
  await rejectWithinSavepoint(
    client,
    'terminal_lease_retained',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET state = 'succeeded',
           completed_at = clock_timestamp()
       WHERE id = $1::uuid`,
      [captured.id],
    ),
    /must finalize exactly once/,
  )

  const immutableAfter = await client.query(
    `SELECT (
       to_jsonb(attempt)
         - ARRAY['lease_token', 'lease_expires_at']::text[]
     )::text AS immutable_attempt,
     (
       SELECT md5(to_jsonb(capture)::text)
       FROM operations_commerce_inventory_captures capture
       WHERE capture.provider_attempt_id = attempt.id
     ) AS capture_hash
     FROM operations_commerce_provider_attempts attempt
     WHERE attempt.id = $1::uuid`,
    [captured.id],
  )
  assert.deepEqual(immutableAfter.rows[0], immutableBefore.rows[0])

  const finalized = await client.query(
    `UPDATE operations_commerce_provider_attempts
     SET state = 'succeeded',
         redacted_response = $3::jsonb,
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = clock_timestamp()
     WHERE id = $1::uuid
       AND lease_token = $2::uuid
       AND lease_expires_at > clock_timestamp()
     RETURNING id`,
    [
      captured.id,
      liveToken,
      JSON.stringify(ZERO_EFFECT_SUMMARY),
    ],
  )
  assert.equal(finalized.rowCount, 1)
  await rejectWithinSavepoint(
    client,
    'second_terminal_update',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET provider_reference = 'not-allowed'
       WHERE id = $1::uuid`,
      [captured.id],
    ),
    /Terminal commerce provider attempts are immutable/,
  )
  await rejectWithinSavepoint(
    client,
    'terminal_delete',
    () => client.query(
      `DELETE FROM operations_commerce_provider_attempts
       WHERE id = $1::uuid`,
      [captured.id],
    ),
    /immutable and cannot be deleted/,
  )

  const missingCapture = await insertLeaseFixture(
    client,
    fixture,
    sourceCaptureId,
    {
      suffix: 'missing',
      requestHash: 'e'.repeat(64),
      withCapture: false,
    },
  )
  await rejectWithinSavepoint(
    client,
    'missing_capture',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET lease_token = gen_random_uuid(),
           lease_expires_at =
             clock_timestamp() + interval '15 minutes'
       WHERE id = $1::uuid`,
      [missingCapture.id],
    ),
    /lease rotation requires one expired captured read/,
  )
  await terminalizeLeaseFixture(client, missingCapture.id)

  const mismatchedCapture = await insertLeaseFixture(
    client,
    fixture,
    sourceCaptureId,
    {
      suffix: 'mismatch',
      requestHash: 'a'.repeat(64),
      captureRequestHash: 'b'.repeat(64),
    },
  )
  await rejectWithinSavepoint(
    client,
    'mismatched_capture',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET lease_token = gen_random_uuid(),
           lease_expires_at =
             clock_timestamp() + interval '15 minutes'
       WHERE id = $1::uuid`,
      [mismatchedCapture.id],
    ),
    /lease rotation requires one expired captured read/,
  )
  await terminalizeLeaseFixture(client, mismatchedCapture.id)

  const wrongAction = await insertLeaseFixture(
    client,
    fixture,
    sourceCaptureId,
    {
      suffix: 'wrong',
      action: 'catalog.products.read',
      requestHash: 'c'.repeat(64),
      withCapture: false,
    },
  )
  await rejectWithinSavepoint(
    client,
    'wrong_action',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET lease_expires_at =
             clock_timestamp() + interval '15 minutes'
       WHERE id = $1::uuid`,
      [wrongAction.id],
    ),
    /permit lease-only maintenance/,
  )
  await terminalizeLeaseFixture(client, wrongAction.id)

  const nullLease = await insertLeaseFixture(
    client,
    fixture,
    sourceCaptureId,
    {
      suffix: 'null',
      requestHash: 'f'.repeat(64),
      withCapture: false,
      withLease: false,
    },
  )
  await rejectWithinSavepoint(
    client,
    'null_lease_acquisition',
    () => client.query(
      `UPDATE operations_commerce_provider_attempts
       SET lease_token = gen_random_uuid(),
           lease_expires_at =
             clock_timestamp() + interval '15 minutes'
       WHERE id = $1::uuid`,
      [nullLease.id],
    ),
    /lease rotation requires one expired captured read/,
  )
  await terminalizeLeaseFixture(client, nullLease.id)
}

async function insertJob(client, fixture, maxAttempts = 2) {
  const result = await client.query(
    `INSERT INTO operations_shopify_inventory_refresh_jobs (
       organization_id,
       integration_account_id,
       carrier_service_config_id,
       warehouse_id,
       credential_generation,
       activation_revision,
       config_row_version,
       policy_revision,
       policy_hash,
       inventory_max_age_seconds,
       max_attempts
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4::uuid,
       $5::integer,
       $6::integer,
       $7::bigint,
       $8::bigint,
       $9,
       $10::integer,
       $11::integer
     )
     RETURNING id::text`,
    [
      fixture.organization_id,
      fixture.integration_account_id,
      fixture.carrier_service_config_id,
      fixture.warehouse_id,
      fixture.credential_generation,
      fixture.activation_revision,
      fixture.config_row_version,
      fixture.policy_revision,
      fixture.policy_hash,
      fixture.inventory_max_age_seconds,
      maxAttempts,
    ],
  )
  return result.rows[0].id
}

async function claimJob(client, jobId) {
  const result = await client.query(
    `WITH candidate AS (
       SELECT job.id
       FROM operations_shopify_inventory_refresh_jobs job
       JOIN operations_shopify_carrier_service_configs config
         ON config.organization_id = job.organization_id
        AND config.id = job.carrier_service_config_id
        AND config.integration_account_id =
            job.integration_account_id
        AND config.warehouse_id = job.warehouse_id
        AND config.credential_generation = job.credential_generation
        AND config.activation_revision = job.activation_revision
        AND config.row_version = job.config_row_version
        AND config.policy_revision = job.policy_revision
        AND config.policy_hash = job.policy_hash
        AND config.inventory_max_age_seconds =
            job.inventory_max_age_seconds
       JOIN operations_integration_accounts account
         ON account.organization_id = job.organization_id
        AND account.id = job.integration_account_id
        AND account.integration_type = 'commerce'
        AND account.provider = 'shopify'
        AND account.status = 'active'
        AND account.commerce_credential_generation =
            job.credential_generation
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = job.organization_id
        AND credential.integration_account_id =
            job.integration_account_id
        AND credential.credential_version = job.credential_generation
        AND credential.verification_status = 'verified'
       JOIN operations_activation_scopes activation
         ON activation.organization_id = job.organization_id
        AND activation.revision = job.activation_revision
       WHERE job.id = $1::uuid
         AND job.status IN ('pending', 'failed')
         AND job.available_at <= now()
         AND job.cancel_requested = false
         AND (
           (config.registration_state = 'registered'
             AND activation.state IN ('shadow', 'active'))
           OR
           (config.registration_state = 'shadow_simulated'
             AND activation.state = 'shadow')
         )
         AND COALESCE(
           account.configuration->'grantedScopes',
           '[]'::jsonb
         ) ?| ARRAY['read_inventory', 'write_inventory']
         AND COALESCE(
           account.configuration->'grantedScopes',
           '[]'::jsonb
         ) ?| ARRAY['read_locations', 'write_locations']
         AND COALESCE(
           account.configuration->'grantedScopes',
           '[]'::jsonb
         ) ?| ARRAY['read_products', 'write_products']
         AND operations_shopify_carrier_service_config_is_ready(
           config.organization_id,
           config.id
         )
       FOR UPDATE OF job SKIP LOCKED
     )
     UPDATE operations_shopify_inventory_refresh_jobs job
     SET status = 'processing',
         attempt_count = job.attempt_count + 1,
         locked_at = now(),
         locked_by = 'rollback-acceptance',
         lock_token = gen_random_uuid(),
         lease_expires_at = now() + interval '20 minutes',
         started_at = COALESCE(job.started_at, now()),
         last_error_code = NULL,
         updated_at = now()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING
       job.id::text,
       job.status,
       job.attempt_count,
       job.max_attempts,
       job.lock_token::text,
       job.locked_at,
       job.lease_expires_at`,
    [jobId],
  )
  return result.rows[0] || null
}

async function jobState(client, jobId) {
  const result = await client.query(
    `SELECT
       id::text,
       status,
       cancel_requested,
       attempt_count,
       max_attempts,
       available_at,
       locked_at,
       locked_by,
       lock_token::text,
       lease_expires_at,
       last_error_code,
       result_summary,
       started_at,
       completed_at
     FROM operations_shopify_inventory_refresh_jobs
     WHERE id = $1::uuid`,
    [jobId],
  )
  return result.rows[0] || null
}

async function projectionFenceCurrent(client, fixture, claim) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM operations_shopify_inventory_refresh_jobs job
       JOIN operations_shopify_carrier_service_configs config
         ON config.organization_id = job.organization_id
        AND config.id = job.carrier_service_config_id
        AND config.integration_account_id = job.integration_account_id
        AND config.warehouse_id = job.warehouse_id
        AND config.credential_generation = job.credential_generation
        AND config.activation_revision = job.activation_revision
        AND config.row_version = job.config_row_version
        AND config.policy_revision = job.policy_revision
        AND config.policy_hash = job.policy_hash
        AND config.inventory_max_age_seconds =
            job.inventory_max_age_seconds
       JOIN operations_integration_accounts account
         ON account.organization_id = job.organization_id
        AND account.id = job.integration_account_id
        AND account.status = 'active'
       WHERE job.id = $1::uuid
         AND job.organization_id = $2::uuid
         AND job.integration_account_id = $3::uuid
         AND job.status = 'processing'
         AND job.lock_token = $4::uuid
         AND job.lease_expires_at > now()
         AND job.cancel_requested = false
         AND operations_shopify_carrier_service_config_is_ready(
           config.organization_id,
           config.id
         )
     ) AS current`,
    [
      claim.id,
      fixture.organization_id,
      fixture.integration_account_id,
      claim.lock_token,
    ],
  )
  return result.rows[0]?.current === true
}

async function finishReadOnlySuccess(client, claim) {
  const result = await client.query(
    `UPDATE operations_shopify_inventory_refresh_jobs
     SET status = 'succeeded',
         result_summary = jsonb_build_object(
           'resource', 'inventory',
           'readOnly', true,
           'providerWrites', $3::integer,
           'orderQuantityAdjustment', $4::numeric,
           'inventoryRunGlobalId', $5::text,
           'providerFetchedAt', $6::text,
           'levelsSeen', $7::integer,
           'levelsProjected', $8::integer
         ),
         completed_at = now(),
         locked_at = NULL,
         locked_by = NULL,
         lock_token = NULL,
         lease_expires_at = NULL,
         last_error_code = NULL,
         updated_at = now()
     WHERE id = $1::uuid
       AND status = 'processing'
       AND lock_token = $2::uuid
       AND lease_expires_at > now()`,
    [
      claim.id,
      claim.lock_token,
      0,
      0,
      'gir0000001',
      '2026-07-30T12:00:00.000Z',
      1,
      1,
    ],
  )
  return result.rowCount || 0
}

async function failClaim(client, claim, errorCode) {
  const result = await client.query(
    `UPDATE operations_shopify_inventory_refresh_jobs
     SET status = CASE
           WHEN attempt_count >= max_attempts THEN 'dead'
           ELSE 'failed'
         END,
         available_at = now(),
         completed_at = CASE
           WHEN attempt_count >= max_attempts THEN now()
           ELSE NULL
         END,
         locked_at = NULL,
         locked_by = NULL,
         lock_token = NULL,
         lease_expires_at = NULL,
         last_error_code = $3,
         result_summary = $4::jsonb,
         updated_at = now()
     WHERE id = $1::uuid
       AND status = 'processing'
       AND lock_token = $2::uuid
       AND lease_expires_at > now()
     RETURNING status`,
    [
      claim.id,
      claim.lock_token,
      errorCode,
      JSON.stringify(ZERO_EFFECT_SUMMARY),
    ],
  )
  return result.rows[0]?.status || null
}

async function main() {
  const client = await pool.connect()
  let before
  let fixture
  let usedExistingProviderRead = false
  try {
    assert.equal(
      await databaseFingerprint(client),
      TRUSTED_DATABASE_FINGERPRINT,
      'connected database is not the trusted ClawPilot development database',
    )
    for (const filename of PREREQUISITE_MIGRATIONS) {
      assert.equal(
        await migrationApplied(client, filename),
        true,
        `${filename} must already be applied`,
      )
    }
    before = await durableState(client)

    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = '120s'`)
    await client.query(`SET LOCAL lock_timeout = '15s'`)
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended(
           'clawpilot-shopify-inventory-refresh-acceptance',
           0
         )
       )`,
    )
    for (const filename of TARGET_MIGRATIONS) {
      await client.query(migrationSql(filename))
    }

    const appliedState = await durableState(client)
    assert.equal(
      appliedState.queue_table,
      'operations_shopify_inventory_refresh_jobs',
    )
    assert.equal(
      appliedState.active_job_index,
      'idx_operations_shopify_inventory_refresh_active_account',
    )
    assert.equal(
      appliedState.provider_read_index,
      'idx_operations_shopify_inventory_read_singleflight',
    )
    assert.deepEqual(
      appliedState.migrationsApplied,
      before.migrationsApplied,
      'Rollback acceptance must not change durable migration history.',
    )
    assert.match(
      appliedState.provider_attempt_protection_function,
      /Prepared inventory attempts permit lease-only maintenance/,
    )

    const indexDefinition = await client.query(
      `SELECT pg_get_indexdef(
         'idx_operations_shopify_inventory_refresh_active_account'
           ::regclass
       ) AS active_job,
       pg_get_indexdef(
         'idx_operations_shopify_inventory_read_singleflight'
           ::regclass
       ) AS provider_read`,
    )
    assert.match(
      indexDefinition.rows[0].active_job,
      /organization_id, integration_account_id/,
    )
    assert.match(
      indexDefinition.rows[0].active_job,
      /status.*pending.*processing.*failed/,
    )
    assert.match(
      indexDefinition.rows[0].provider_read,
      /organization_id, integration_account_id/,
    )
    assert.match(
      indexDefinition.rows[0].provider_read,
      /inventory\.levels\.read/,
    )

    fixture = await readyFixture(client)
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended($1::text, 0)
       )`,
      [
        [
          'shopify-inventory-read',
          fixture.organization_id,
          fixture.integration_account_id,
        ].join(':'),
      ],
    )
    await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET status = 'cancelled',
           cancel_requested = true,
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = 'ROLLBACK_ACCEPTANCE_REPLACED',
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND status IN ('pending', 'processing', 'failed')`,
      [fixture.organization_id, fixture.integration_account_id],
    )

    await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'disabled'
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [fixture.organization_id, fixture.integration_account_id],
    )
    const disabledReady = await client.query(
      `SELECT operations_shopify_carrier_service_config_is_ready(
         $1::uuid, $2::uuid
       ) AS ready`,
      [fixture.organization_id, fixture.carrier_service_config_id],
    )
    assert.equal(
      disabledReady.rows[0]?.ready,
      false,
      'A disabled Shopify account must fail canonical readiness.',
    )
    const disabledJobId = await insertJob(client, fixture)
    assert.equal(
      await claimJob(client, disabledJobId),
      null,
      'A disabled Shopify account must not be claimable.',
    )
    await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET status = 'cancelled',
           cancel_requested = true,
           completed_at = now()
       WHERE id = $1::uuid`,
      [disabledJobId],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'active'
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [fixture.organization_id, fixture.integration_account_id],
    )
    const restoredReady = await client.query(
      `SELECT operations_shopify_carrier_service_config_is_ready(
         $1::uuid, $2::uuid
       ) AS ready`,
      [fixture.organization_id, fixture.carrier_service_config_id],
    )
    assert.equal(restoredReady.rows[0]?.ready, true)

    usedExistingProviderRead = Boolean(await activeProviderAttempt(
      client,
      fixture,
    ))
    await exerciseProviderAttemptLeaseProtection(client, fixture)

    const firstProviderAttempt = await insertProviderAttempt(
      client,
      fixture,
      'a',
    )
    await client.query('SAVEPOINT duplicate_provider_read')
    await assert.rejects(
      insertProviderAttempt(client, fixture, 'b'),
      /idx_operations_shopify_inventory_read_singleflight|duplicate key value/,
    )
    await client.query('ROLLBACK TO SAVEPOINT duplicate_provider_read')
    await finalizeProviderAttempt(client, firstProviderAttempt)
    const nextProviderAttempt = await insertProviderAttempt(
      client,
      fixture,
      'c',
    )
    await finalizeProviderAttempt(client, nextProviderAttempt)

    const successJobId = await insertJob(client, fixture)
    await client.query('SAVEPOINT duplicate_active_job')
    await assert.rejects(
      insertJob(client, fixture),
      /idx_operations_shopify_inventory_refresh_active_account|duplicate key value/,
    )
    await client.query('ROLLBACK TO SAVEPOINT duplicate_active_job')

    const successClaim = await claimJob(client, successJobId)
    assert.ok(successClaim)
    assert.equal(successClaim.status, 'processing')
    assert.equal(successClaim.attempt_count, 1)
    assert.ok(successClaim.lock_token)
    assert.ok(
      new Date(successClaim.lease_expires_at).getTime()
      > new Date(successClaim.locked_at).getTime(),
    )
    assert.equal(
      await claimJob(client, successJobId),
      null,
      'An active lease must not be claimed a second time.',
    )
    assert.equal(await finishReadOnlySuccess(client, successClaim), 1)
    const succeeded = await jobState(client, successJobId)
    assert.equal(succeeded.status, 'succeeded')
    assert.equal(succeeded.completed_at instanceof Date, true)
    assert.equal(succeeded.lock_token, null)
    assert.deepEqual(
      {
        resource: succeeded.result_summary.resource,
        readOnly: succeeded.result_summary.readOnly,
        providerWrites: succeeded.result_summary.providerWrites,
        orderQuantityAdjustment:
          succeeded.result_summary.orderQuantityAdjustment,
      },
      ZERO_EFFECT_SUMMARY,
    )

    const staleJobId = await insertJob(client, fixture)
    const staleClaim = await claimJob(client, staleJobId)
    assert.ok(staleClaim)
    assert.equal(
      await projectionFenceCurrent(client, fixture, staleClaim),
      true,
    )
    await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET config_row_version = config_row_version + 1
       WHERE id = $1::uuid`,
      [staleJobId],
    )
    assert.equal(
      await projectionFenceCurrent(client, fixture, staleClaim),
      false,
      'A mid-flight configuration revision must invalidate projection authority.',
    )
    const staleFence = await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs job
       SET status = CASE
             WHEN job.status = 'processing' THEN job.status
             ELSE 'cancelled'
           END,
           cancel_requested = true,
           completed_at = CASE
             WHEN job.status = 'processing' THEN job.completed_at
             ELSE now()
           END,
           last_error_code =
             'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
           updated_at = now()
       WHERE job.id = $1::uuid
         AND job.status IN ('pending', 'processing', 'failed')
         AND NOT EXISTS (
           SELECT 1
           FROM operations_shopify_carrier_service_configs config
           WHERE config.organization_id = job.organization_id
             AND config.id = job.carrier_service_config_id
             AND config.integration_account_id =
                 job.integration_account_id
             AND config.warehouse_id = job.warehouse_id
             AND config.credential_generation =
                 job.credential_generation
             AND config.activation_revision = job.activation_revision
             AND config.row_version = job.config_row_version
             AND config.policy_revision = job.policy_revision
             AND config.policy_hash = job.policy_hash
             AND config.inventory_max_age_seconds =
                 job.inventory_max_age_seconds
         )`,
      [staleJobId],
    )
    assert.equal(staleFence.rowCount, 1)
    const staleProcessing = await jobState(client, staleJobId)
    assert.equal(staleProcessing.status, 'processing')
    assert.equal(staleProcessing.cancel_requested, true)
    assert.ok(staleProcessing.lock_token)
    await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET status = 'cancelled',
           cancel_requested = true,
           completed_at = now(),
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code =
             'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
           updated_at = now()
       WHERE id = $1::uuid
         AND status = 'processing'
         AND lock_token = $2::uuid`,
      [staleJobId, staleClaim.lock_token],
    )
    const cancelled = await jobState(client, staleJobId)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(
      cancelled.last_error_code,
      'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED',
    )
    assert.equal(cancelled.completed_at instanceof Date, true)
    assert.equal(cancelled.lock_token, null)

    const retryJobId = await insertJob(client, fixture, 2)
    const retryClaim = await claimJob(client, retryJobId)
    assert.ok(retryClaim)
    assert.equal(
      await failClaim(
        client,
        retryClaim,
        'SHOPIFY_INVENTORY_REFRESH_FAILED',
      ),
      'failed',
    )
    const retrying = await jobState(client, retryJobId)
    assert.equal(retrying.status, 'failed')
    assert.equal(retrying.completed_at, null)
    assert.deepEqual(retrying.result_summary, ZERO_EFFECT_SUMMARY)

    const deadClaim = await claimJob(client, retryJobId)
    assert.ok(deadClaim)
    assert.equal(deadClaim.attempt_count, 2)
    assert.equal(
      await failClaim(
        client,
        deadClaim,
        'SHOPIFY_INVENTORY_REFRESH_FAILED',
      ),
      'dead',
    )
    const dead = await jobState(client, retryJobId)
    assert.equal(dead.status, 'dead')
    assert.equal(dead.completed_at instanceof Date, true)
    assert.equal(dead.lock_token, null)
    assert.deepEqual(dead.result_summary, ZERO_EFFECT_SUMMARY)

    const expiredJobId = await insertJob(client, fixture, 2)
    const expiredClaim = await claimJob(client, expiredJobId)
    assert.ok(expiredClaim)
    await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET locked_at = now() - interval '2 seconds',
           lease_expires_at = now() - interval '1 second'
       WHERE id = $1::uuid`,
      [expiredJobId],
    )
    assert.equal(
      await finishReadOnlySuccess(client, expiredClaim),
      0,
      'An expired owner must not complete a refresh job.',
    )
    assert.equal(
      await failClaim(
        client,
        expiredClaim,
        'SHOPIFY_INVENTORY_REFRESH_FAILED',
      ),
      null,
      'An expired owner must not fail a refresh job.',
    )
    await client.query(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET status = 'failed',
           available_at = now(),
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code =
             'SHOPIFY_INVENTORY_REFRESH_LEASE_EXPIRED',
           updated_at = now()
       WHERE id = $1::uuid
         AND status = 'processing'
         AND lease_expires_at <= now()`,
      [expiredJobId],
    )
    const recoveredExpired = await jobState(client, expiredJobId)
    assert.equal(recoveredExpired.status, 'failed')
    assert.equal(
      recoveredExpired.last_error_code,
      'SHOPIFY_INVENTORY_REFRESH_LEASE_EXPIRED',
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
    assert.deepEqual(
      await durableState(verification),
      before,
      'Rollback acceptance left schema or provider-attempt data behind.',
    )
  } finally {
    verification.release()
    await pool.end()
  }

  console.log(JSON.stringify({
    ok: true,
    acceptance: 'rollback-only-postgres',
    targetMigrations: TARGET_MIGRATIONS,
    targetMigrationState: before.migrationsApplied,
    disabledAccountExcluded: true,
    tenantAccountActiveJobUnique: true,
    providerReadSingleFlight: true,
    usedExistingProviderRead,
    providerAttemptLeaseRenewal: true,
    expiredCapturedLeaseRotation: true,
    providerAttemptEvidenceImmutable: true,
    providerAttemptFinalizesOnce: true,
    leasedClaimExclusive: true,
    expiredLeaseRejected: true,
    staleFenceCancelled: true,
    midFlightProjectionFenceRejected: true,
    transientFailureRetried: true,
    maxAttemptsDeadLettered: true,
    readOnlyResultEvidence: ZERO_EFFECT_SUMMARY,
    retainedSchemaOrData: false,
  }, null, 2))
}

main().catch(async (error) => {
  await pool.end().catch(() => undefined)
  console.error(error)
  process.exit(1)
})
