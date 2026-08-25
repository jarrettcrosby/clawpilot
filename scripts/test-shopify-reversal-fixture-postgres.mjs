#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    env: { ...process.env, ...options.env },
  })
  if (result.error || result.status !== 0) {
    throw result.error || new Error(
      `${binary} ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    )
  }
  return String(result.stdout || '').trim()
}

function migrations() {
  return readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right))
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
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
    } catch {
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function applyMigration(client, filename) {
  const sql = readFileSync(resolve(root, 'db/migrations', filename), 'utf8')
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query(
      'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text',
    )
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES ($1, $2)`,
      [filename, createHash('sha256').update(sql).digest('hex')],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw new Error(`Migration ${filename} failed`, { cause: error })
  }
}

async function rejected(work, pattern, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${message}: expected rejection`)
  assert.match(String(error.message || error), pattern, message)
  return error
}

async function seedAuthority(pool) {
  const owner = `fixture-owner-${randomUUID()}@example.test`
  const inactiveAdmin = `fixture-admin-${randomUUID()}@example.test`
  await pool.query(
    `INSERT INTO app_users (email, role, status)
     VALUES ($1, 'owner', 'active'), ($2, 'admin', 'active')`,
    [owner, inactiveAdmin],
  )
  const organization = await pool.query(
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ('Shopify reversal fixture acceptance', 'root', $1, $1)
     RETURNING id::text`,
    [owner],
  )
  const organizationId = organization.rows[0].id
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES
       ($1, $3::uuid, 'owner', '{}'::jsonb, 'active', true, $1, $1),
       ($2, $3::uuid, 'admin', '{}'::jsonb, 'disabled', false, $1, $1)`,
    [owner, inactiveAdmin, organizationId],
  )
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (
       'deployment.database.identity',
       '{"id":"750aa268-0e31-4065-a99c-4016e4d4fab1"}'::jsonb,
       now()
     )
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = EXCLUDED.updated_at`,
  )
  await pool.query(
    `INSERT INTO crm_reference_number_registry (number_value, allocated_at)
     VALUES ('h34fedoa5b1o', now())`,
  )
  await pool.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, allocated_at,
       entity_type
     ) SELECT
       'giah34fedoa5b1o', 'gia', 'giah34fedoa5b1o', 'active', now(),
       entity_type
     FROM global_reference_entity_types
     WHERE prefix = 'gia'`,
  )
  const account = await pool.query(
    `INSERT INTO operations_integration_accounts (
       global_id, organization_id, provider, integration_type, environment,
       display_name, status, configuration, external_account_id,
       commerce_credential_generation, created_by, updated_by
     ) VALUES (
       'giah34fedoa5b1o', $1::uuid, 'shopify', 'commerce', 'sandbox',
       'Fixed reversal development store', 'active',
       '{
         "shopDomain":"fixed-reversal-fixture.myshopify.com",
         "authMode":"shopify_client_credentials",
         "grantedScopes":[
           "read_orders",
           "write_merchant_managed_fulfillment_orders",
           "write_orders"
         ]
       }'::jsonb,
       'gid://shopify/Shop/123456789', 1, $2, $2
     ) RETURNING id::text`,
    [organizationId, owner],
  )
  const accountId = account.rows[0].id
  await pool.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'gid://shopify/Shop/123456789',
       'shopify_client_credentials', decode('01', 'hex'),
       decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex'),
       1, '6789', 'verified', now(), 'unverified', $3, $3
     )`,
    [organizationId, accountId, owner],
  )
  await pool.query(
    `INSERT INTO operations_commerce_provider_write_controls (
       organization_id, integration_account_id, provider, row_version,
       expected_row_version, requested_mode, bound_credential_generation,
       bound_granted_scopes, bound_granted_scope_digest, changed_by,
       changed_role, idempotency_key, request_hash
     ) VALUES (
       $1::uuid, $2::uuid, 'shopify', 1, 0, 'on', 1,
       ARRAY[
         'read_orders',
         'write_merchant_managed_fulfillment_orders',
         'write_orders'
       ]::text[],
       operations_commerce_granted_scope_digest(ARRAY[
         'read_orders',
         'write_merchant_managed_fulfillment_orders',
         'write_orders'
       ]::text[]),
       $3, 'owner', $4, repeat('9', 64)
     )`,
    [
      organizationId,
      accountId,
      owner,
      `fixture-provider-writes-${randomUUID()}`,
    ],
  )
  const control = await pool.query(
    `SELECT row_version::text,
            bound_granted_scope_digest
     FROM operations_commerce_provider_write_control_current
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [organizationId, accountId],
  )
  return {
    owner,
    inactiveAdmin,
    organizationId,
    accountId,
    controlRowVersion: Number(control.rows[0].row_version),
    scopeDigest: control.rows[0].bound_granted_scope_digest,
  }
}

async function insertOrderCommand(pool, fixture, options = {}) {
  const global = await pool.query(
    `SELECT allocate_global_reference('gsfc') AS global_id`,
  )
  const globalId = global.rows[0].global_id
  const sourceIdentifier = `clawpilot-reversal-fixture:${globalId}`
  const uniqueTag = `clawpilot-reversal-${createHash('sha256')
    .update(`${globalId}:${randomUUID()}`)
    .digest('hex').slice(0, 24)}`
  const intentHash = createHash('sha256')
    .update(`intent:${globalId}`)
    .digest('hex')
  const confirmationHash = createHash('sha256')
    .update(`CREATE TEST ORDER ${intentHash.slice(0, 12)}`)
    .digest('hex')
  const expiresAt = new Date(Date.now() + (options.expiresInMs || 300_000))
    .toISOString()
  const inserted = await pool.query(
    `INSERT INTO operations_shopify_reversal_fixture_commands (
       global_id, organization_id, integration_account_id,
       phase, fixture_profile_version, prepared_by, prepared_role,
       idempotency_key, intent_hash, confirmation_hash,
       provider_write_control_row_version, credential_generation,
       granted_scope_digest, external_account_id, shop_domain,
       source_identifier, unique_tag, tag_fingerprint, expires_at
     ) VALUES (
       $1, $2::uuid, $3::uuid,
       'create_order', 'shopify-reversal-fixture-v1', $4, $5,
       $6, $7, $8,
       $9::bigint, 1, $10, 'gid://shopify/Shop/123456789',
       'fixed-reversal-fixture.myshopify.com',
       $11, $12,
       encode(digest(convert_to($12, 'UTF8'), 'sha256'), 'hex'),
       $13::timestamptz
     ) RETURNING id::text, global_id, intent_hash, confirmation_hash`,
    [
      globalId,
      fixture.organizationId,
      fixture.accountId,
      options.actor || fixture.owner,
      options.role || 'owner',
      `fixture-command-${randomUUID()}`,
      intentHash,
      confirmationHash,
      fixture.controlRowVersion,
      fixture.scopeDigest,
      sourceIdentifier,
      uniqueTag,
      expiresAt,
    ],
  )
  return inserted.rows[0]
}

async function exercise(pool) {
  const fixture = await seedAuthority(pool)
  await rejected(
    () => insertOrderCommand(pool, fixture, {
      actor: fixture.inactiveAdmin,
      role: 'admin',
    }),
    /command is not currently authorized/iu,
    'inactive administrator cannot prepare',
  )

  const short = await insertOrderCommand(pool, fixture, { expiresInMs: 500 })
  await rejected(
    () => insertOrderCommand(pool, fixture),
    /command is not currently authorized/iu,
    'a second live phase-1 command is serialized and rejected',
  )
  await pool.query('SELECT pg_sleep(0.55)')
  const prepared = await insertOrderCommand(pool, fixture)
  assert.notEqual(prepared.global_id, short.global_id)

  await rejected(
    () => pool.query(
      `UPDATE operations_shopify_reversal_fixture_commands
       SET expires_at = now() + interval '1 hour'
       WHERE id = $1::uuid`,
      [prepared.id],
    ),
    /ledgers are append-only/iu,
    'prepared commands are immutable',
  )
  await rejected(
    () => pool.query(
      `INSERT INTO operations_shopify_reversal_fixture_attempts (
         organization_id, command_id, phase, claimed_by, claimed_role,
         intent_hash, confirmation_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'create_order', $3, 'owner', $4, repeat('0', 64)
       )`,
      [
        fixture.organizationId,
        prepared.id,
        fixture.owner,
        prepared.intent_hash,
      ],
    ),
    /provider claim is not currently authorized/iu,
    'claim confirmation must remain intent-bound',
  )

  await pool.query(
    `UPDATE app_user_organization_memberships
     SET status = 'disabled'
     WHERE organization_id = $1::uuid AND user_email = $2`,
    [fixture.organizationId, fixture.owner],
  )
  await rejected(
    () => pool.query(
      `INSERT INTO operations_shopify_reversal_fixture_attempts (
         organization_id, command_id, phase, claimed_by, claimed_role,
         intent_hash, confirmation_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'create_order', $3, 'owner', $4, $5
       )`,
      [
        fixture.organizationId,
        prepared.id,
        fixture.owner,
        prepared.intent_hash,
        prepared.confirmation_hash,
      ],
    ),
    /provider claim is not currently authorized/iu,
    'active membership is rechecked at claim',
  )
  await pool.query(
    `UPDATE app_user_organization_memberships
     SET status = 'active'
     WHERE organization_id = $1::uuid AND user_email = $2`,
    [fixture.organizationId, fixture.owner],
  )
  const attempt = await pool.query(
    `INSERT INTO operations_shopify_reversal_fixture_attempts (
       organization_id, command_id, phase, claimed_by, claimed_role,
       intent_hash, confirmation_hash
     ) VALUES (
       $1::uuid, $2::uuid, 'create_order', $3, 'owner', $4, $5
     ) RETURNING id::text, global_id`,
    [
      fixture.organizationId,
      prepared.id,
      fixture.owner,
      prepared.intent_hash,
      prepared.confirmation_hash,
    ],
  )
  await rejected(
    () => pool.query(
      `INSERT INTO operations_shopify_reversal_fixture_attempts (
         organization_id, command_id, phase, claimed_by, claimed_role,
         intent_hash, confirmation_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'create_order', $3, 'owner', $4, $5
       )`,
      [
        fixture.organizationId,
        prepared.id,
        fixture.owner,
        prepared.intent_hash,
        prepared.confirmation_hash,
      ],
    ),
    /duplicate key/iu,
    'a claimed provider attempt cannot be retried',
  )

  const attemptId = attempt.rows[0].id
  await rejected(
    () => pool.query(
      `INSERT INTO operations_shopify_reversal_fixture_outcomes (
         organization_id, command_id, attempt_id, outcome_state,
         provider_mutation_attempted, provider_writes, error_code, recorded_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'rejected', true, 1,
         'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED', $4
       )`,
      [fixture.organizationId, prepared.id, attemptId, fixture.owner],
    ),
    /shape_valid/iu,
    'an explicit provider rejection cannot claim a confirmed provider write',
  )
  await pool.query(
    `INSERT INTO operations_shopify_reversal_fixture_outcomes (
       organization_id, command_id, attempt_id, outcome_state,
       provider_mutation_attempted, provider_writes, error_code, recorded_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'unknown', true, NULL,
       'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN', $4
     )`,
    [fixture.organizationId, prepared.id, attemptId, fixture.owner],
  )
  await pool.query(
    `INSERT INTO operations_shopify_reversal_fixture_outcomes (
       organization_id, command_id, attempt_id, outcome_state,
       provider_mutation_attempted, provider_writes, evidence_hash,
       recorded_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'reconciled_absent', false, 0,
       repeat('a', 64), $4
     )`,
    [fixture.organizationId, prepared.id, attemptId, fixture.owner],
  )
  await rejected(
    () => pool.query(
      `INSERT INTO operations_shopify_reversal_fixture_outcomes (
         organization_id, command_id, attempt_id, outcome_state,
         provider_mutation_attempted, provider_writes, evidence_hash,
         recorded_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'reconciled_absent', false, 0,
         repeat('b', 64), $4
       )`,
      [fixture.organizationId, prepared.id, attemptId, fixture.owner],
    ),
    /duplicate key/iu,
    'one read-reconciliation outcome is append-only',
  )
  await rejected(
    () => insertOrderCommand(pool, fixture),
    /command is not currently authorized/iu,
    'an unknown provider write is never retried after absent reconciliation',
  )
  await rejected(
    () => pool.query(
      `DELETE FROM operations_shopify_reversal_fixture_outcomes
       WHERE organization_id = $1::uuid AND attempt_id = $2::uuid`,
      [fixture.organizationId, attemptId],
    ),
    /ledgers are append-only/iu,
    'outcome evidence cannot be deleted',
  )
  const state = await pool.query(
    `SELECT state, attempt_global_id, reconciliation_outcome_global_id
     FROM operations_shopify_reversal_fixture_command_state
     WHERE organization_id = $1::uuid AND command_id = $2::uuid`,
    [fixture.organizationId, prepared.id],
  )
  assert.equal(state.rows[0].state, 'reconciled_absent')
  assert.equal(state.rows[0].attempt_global_id, attempt.rows[0].global_id)
  assert.ok(state.rows[0].reconciliation_outcome_global_id)
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-shopify-reversal-${randomUUID()}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=clawpilot_shopify_reversal_test',
      '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16',
    ])
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = portOutput.match(/:(\d+)$/u)?.[1]
    assert.ok(port, `Unable to parse disposable PostgreSQL port: ${portOutput}`)
    const databaseUrl =
      `postgresql://postgres:postgres@127.0.0.1:${port}/clawpilot_shopify_reversal_test`
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 8 })
    try {
      for (const filename of migrations()) {
        await applyMigration(pool, filename)
      }
      await exercise(pool)
    } finally {
      await pool.end()
    }
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }
  console.log('Shopify reversal fixture PostgreSQL ledger fences passed.')
}

await main()
