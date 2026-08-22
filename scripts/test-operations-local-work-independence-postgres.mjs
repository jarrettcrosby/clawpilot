#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  OPERATIONS_COMMERCE_STORE_SYNC_FUNCTION_HEALTH_SQL,
  OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL,
} from '../app_src/lib/persistence/commerceStoreSyncHealth.ts'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const image = String(
  process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16',
).trim()
assert.ok(
  ['pgvector/pgvector:pg16', 'pgvector/pgvector:pg18'].includes(image),
  'Select the exact pg16 or pg18 disposable PostgreSQL image',
)

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
  let lastError = null
  while (Date.now() < deadline) {
    const probe = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 1_000,
    })
    try {
      await probe.query('SELECT 1')
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    } finally {
      await probe.end().catch(() => undefined)
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

let databaseUrl = String(process.env.DATABASE_URL || '').trim()
if (!databaseUrl) {
  execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 })
  const container = (
    `clawpilot-local-work-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    execFileSync('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_local_work',
      '-e', 'POSTGRES_DB=clawpilot_local_work',
      '-p', '127.0.0.1::5432', image,
    ], { stdio: 'ignore', timeout: 180_000 })
    const portOutput = execFileSync(
      'docker', ['port', container, '5432/tcp'], { encoding: 'utf8' },
    )
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    databaseUrl = (
      `postgresql://postgres:clawpilot_local_work@127.0.0.1:${port}`
      + '/clawpilot_local_work'
    )
    await waitForPostgres(databaseUrl)
    execFileSync('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      stdio: 'inherit',
      timeout: 300_000,
    })
    execFileSync('node', [
      'scripts/test-operations-local-work-independence-postgres.mjs',
    ], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      stdio: 'inherit',
      timeout: 180_000,
    })
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      stdio: 'ignore',
      timeout: 20_000,
    })
  }
  process.exit(0)
}

const parsed = new URL(databaseUrl)
assert.ok(
  ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname),
  'Local-work activation acceptance is restricted to local PostgreSQL',
)
parsed.searchParams.delete('sslmode')
const pool = new Pool({ connectionString: parsed.toString(), max: 1 })
const client = await pool.connect()

try {
  await client.query('BEGIN')
  const health = await client.query(
    `SELECT
       (${OPERATIONS_COMMERCE_STORE_SYNC_FUNCTION_HEALTH_SQL})
         AS function_health,
       (${OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL})
         AS rewritten_function_health`,
  )
  assert.deepEqual(health.rows[0], {
    function_health: true,
    rewritten_function_health: true,
  }, '0314 Store Sync functions must satisfy their exact health hashes')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
  const actor = `local-work-${suffix}@example.test`
  await client.query(
    `INSERT INTO app_users (email, role, status)
     VALUES ($1, 'owner', 'active')`,
    [actor],
  )

  for (const [index, state] of [
    'disabled', 'shadow', 'read_only', 'active', 'frozen',
  ].entries()) {
    const organizationId = randomUUID()
    const pipelineId = randomUUID()
    const accountId = randomUUID()
    const globalId = (
      await client.query(`SELECT allocate_global_reference('gia') AS value`)
    ).rows[0].value
    const organizationGlobalId = (
      await client.query(`SELECT allocate_global_reference('ga') AS value`)
    ).rows[0].value
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, reference_code
       ) VALUES ($1::uuid, $2, 'member', $3)`,
      [organizationId, `Local work ${state}`, organizationGlobalId],
    )
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, is_default, workspace_organization_id
       ) VALUES ($1::uuid, $2, $3, true, $4::uuid)`,
      [pipelineId, `Local work ${state}`, actor, organizationId],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision
       ) VALUES ($1::uuid, $2::uuid, $3, 1)`,
      [organizationId, pipelineId, state],
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, 'shopify', 'commerce', 'sandbox',
         $4, 'active', jsonb_build_object('shopDomain', $5::text),
         $6, 1, $7, $7
       )`,
      [
        accountId,
        globalId,
        organizationId,
        `Local work ${state}`,
        `${state.replace('_', '-')}-${suffix}.myshopify.com`,
        `gid://shopify/Shop/${suffix}${index}`,
        actor,
      ],
    )

    const running = await client.query(
      `SELECT
         operations_commerce_store_sync_effective_reason($1, $2) AS reason,
         operations_commerce_store_sync_is_running($1, $2) AS automatic,
         operations_commerce_provider_read_authority_is_current(
           $1, $2, 'manual_read_only'
         ) AS manual`,
      [organizationId, accountId],
    )
    assert.deepEqual(running.rows[0], {
      reason: 'STORE_SYNC_LEGACY_ACTIVE_RUNNING',
      automatic: true,
      manual: true,
    }, `${state}: account-scoped reads must not inherit global activation`)

    await client.query(
      `UPDATE operations_commerce_store_sync_controls
       SET desired_state = 'paused', explicit_choice = true,
           revision = revision + 1
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [organizationId, accountId],
    )
    const paused = await client.query(
      `SELECT
         operations_commerce_store_sync_is_running($1, $2) AS automatic,
         operations_commerce_provider_read_authority_is_current(
           $1, $2, 'manual_read_only'
         ) AS manual`,
      [organizationId, accountId],
    )
    assert.deepEqual(paused.rows[0], { automatic: false, manual: true })
  }

  const definitions = await client.query(
    `SELECT proname, pg_get_functiondef(oid) AS definition
     FROM pg_proc
     WHERE proname IN (
       'guard_shadow_commerce_canonical_write',
       'validate_ops_plan_cartonization_evidence'
     )`,
  )
  const byName = new Map(
    definitions.rows.map((row) => [row.proname, row.definition]),
  )
  assert.doesNotMatch(
    byName.get('guard_shadow_commerce_canonical_write') || '',
    /activation\.state/u,
  )
  assert.match(
    byName.get('guard_shadow_commerce_canonical_write') || '',
    /operations_shadow_training_runs/u,
  )
  assert.doesNotMatch(
    byName.get('validate_ops_plan_cartonization_evidence') || '',
    /operations_activation_scopes|carrier_read_environment/u,
  )
  assert.ok(
    (await client.query(
      `SELECT to_regclass(
         'public.operations_commerce_provider_write_controls'
       ) IS NOT NULL AS present`,
    )).rows[0].present,
    'Per-account Provider Writes control must remain installed',
  )
  await client.query('ROLLBACK')
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  client.release()
  await pool.end()
}

console.log('Operations local-work activation matrix PostgreSQL checks passed.')
