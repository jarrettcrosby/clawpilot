#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PRODUCTION_REBIND_CRITICAL_RELATIONS,
  PRODUCTION_REBIND_HISTORY_SCHEMA_MIGRATION_CHECKSUM,
  PRODUCTION_REBIND_SCHEMA_MIGRATIONS,
  ProductionRebindHistorySchemaAttestationError,
  attestProductionRebindHistorySchema,
  inspectProductionRebindHistorySchema,
} from './production-rebind-history-schema-attestation.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const requestedImage = process.env.CLAWPILOT_TEST_POSTGRES_IMAGE?.trim()
const images = requestedImage
  ? [requestedImage]
  : ['pgvector/pgvector:pg16', 'pgvector/pgvector:pg18']

for (const image of images) {
  assert.match(
    image,
    /(?:postgres|pgvector)(?::|\/)(?:pg)?(?:16|18)(?:-|$)/iu,
    'CLAWPILOT_TEST_POSTGRES_IMAGE must select PostgreSQL 16 or 18',
  )
}

assert.deepEqual(
  [...PRODUCTION_REBIND_CRITICAL_RELATIONS].sort(),
  [...PRODUCTION_REBIND_CRITICAL_RELATIONS],
  'critical relation lock targets are deterministic',
)
assert.equal(
  new Set(PRODUCTION_REBIND_CRITICAL_RELATIONS).size,
  PRODUCTION_REBIND_CRITICAL_RELATIONS.length,
  'critical relation lock targets are unique',
)
assert.equal(
  Object.isFrozen(PRODUCTION_REBIND_CRITICAL_RELATIONS),
  true,
  'critical relation lock targets are immutable',
)

for (const expected of PRODUCTION_REBIND_SCHEMA_MIGRATIONS) {
  const installed = readFileSync(
    resolve(root, 'db/migrations', expected.filename),
    'utf8',
  )
  assert.equal(
    createHash('sha256').update(installed, 'utf8').digest('hex'),
    expected.checksum,
    `the frozen ${expected.filename} checksum matches the reviewed migration bytes`,
  )
}
assert.equal(
  PRODUCTION_REBIND_SCHEMA_MIGRATIONS[0].checksum,
  PRODUCTION_REBIND_HISTORY_SCHEMA_MIGRATION_CHECKSUM,
)

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      await pool.end().catch(() => undefined)
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function expectFailure(pool, expectedCode, label, mutate) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const before = await inspectProductionRebindHistorySchema(client)
    await mutate(client)
    const after = await inspectProductionRebindHistorySchema(client)
    assert.notEqual(after.schemaDigest, before.schemaDigest, `${label} changes the catalog digest`)
    await assert.rejects(
      attestProductionRebindHistorySchema(client),
      (error) => (
        error instanceof ProductionRebindHistorySchemaAttestationError
        && error.code === expectedCode
      ),
      `${label} must fail with ${expectedCode}`,
    )
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
  await attestProductionRebindHistorySchema(pool)
}

async function expectLedgerFailure(pool, filename) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE public.schema_migrations
       SET checksum = repeat('0', 64)
       WHERE filename = $1`,
      [filename],
    )
    await assert.rejects(
      attestProductionRebindHistorySchema(client),
      (error) => (
        error instanceof ProductionRebindHistorySchemaAttestationError
        && error.code === 'migration_checksum_mismatch'
      ),
      `${filename} ledger drift fails closed`,
    )
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
  await attestProductionRebindHistorySchema(pool)
}

async function exerciseImage(image) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const container = `clawpilot-target-schema-attestation-${suffix}`
  const password = `target-schema-attestation-${suffix}`
  let pool
  command('docker', [
    'run', '--detach', '--rm', '--name', container,
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', 'POSTGRES_DB=clawpilot_target_schema_attestation',
    '--publish', '127.0.0.1::5432',
    image,
  ])
  try {
    const portOutput = command('docker', ['port', container, '5432/tcp']).trim()
    const port = portOutput.slice(portOutput.lastIndexOf(':') + 1)
    assert.match(port, /^\d+$/u, 'Docker published a PostgreSQL port')
    const databaseUrl =
      `postgresql://postgres:${password}@127.0.0.1:${port}/clawpilot_target_schema_attestation`
    await waitForPostgres(databaseUrl)

    // Use the production migration runner against a blank database. This is
    // intentionally not a hand-built fixture: the real 0349 and 0353-0357
    // migrations, their prerequisites, and their real ledger rows execute.
    const migrationOutput = command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PGSSLMODE: 'disable',
      },
      timeout: 180_000,
    })
    for (const expected of PRODUCTION_REBIND_SCHEMA_MIGRATIONS) {
      assert.ok(
        migrationOutput.includes(`apply ${expected.filename}`),
        `${expected.filename} executed through the real migration runner`,
      )
    }

    pool = new Pool({ connectionString: databaseUrl, max: 3 })
    const applied = await pool.query(
      `SELECT filename, checksum, applied_at IS NOT NULL AS has_applied_at
       FROM public.schema_migrations
       WHERE filename = ANY($1::text[])
       ORDER BY filename`,
      [PRODUCTION_REBIND_SCHEMA_MIGRATIONS.map(({ filename }) => filename)],
    )
    assert.equal(applied.rowCount, PRODUCTION_REBIND_SCHEMA_MIGRATIONS.length)
    assert.ok(applied.rows.every((row) => row.has_applied_at === true))

    const baseline = await inspectProductionRebindHistorySchema(pool)
    assert.deepEqual(baseline.missingRelations, [])
    assert.deepEqual(baseline.missingFunctions, [])
    assert.equal(
      baseline.catalog.relations.length,
      PRODUCTION_REBIND_CRITICAL_RELATIONS.length,
      'every critical relation is fingerprinted',
    )
    for (const relation of PRODUCTION_REBIND_CRITICAL_RELATIONS) {
      assert.ok(
        baseline.catalog.columns.some((column) => column.relation === relation),
        `${relation} columns are fingerprinted`,
      )
    }
    for (const requiredTrigger of [
      'protect_commerce_migration_provider_identity_fence_write',
      'protect_carrier_account_migration_placeholder_write',
      'protect_migrated_carrier_shipper_identity_write',
      'protect_active_migrated_source_authority_integration_write',
      'protect_active_migrated_source_authority_credential_write',
      'enforce_migrated_commerce_provider_identity_write',
      'protect_commerce_workspace_migration_receipt_write',
      'guard_operations_commerce_product_image_import_job_write',
      'validate_integration_credential_key_attestation_insert',
      'reject_integration_credential_key_attestation_update_delete',
      'reject_integration_credential_key_attestation_truncate',
      'guard_hosted_production_sandbox_read_authorization_trigger',
    ]) {
      assert.ok(
        baseline.catalog.triggers.some((trigger) => trigger.name === requiredTrigger),
        `${requiredTrigger} is fingerprinted`,
      )
    }
    assert.ok(
      baseline.catalog.functions.some(
        (fn) => fn.name === 'validate_integration_credential_key_attestation_insert',
      ),
      '0356 validation function is fingerprinted',
    )
    assert.ok(
      baseline.catalog.functions.some(
        (fn) => fn.name === 'guard_operations_commerce_product_image_import_job',
      ),
      '0357 image-import runtime-parking function is fingerprinted',
    )
    const hostedSandboxAuthorizationGuard = baseline.catalog.functions.find(
      (fn) => fn.name === 'guard_hosted_production_sandbox_read_authorization',
    )
    assert.ok(
      hostedSandboxAuthorizationGuard,
      '0358 hosted sandbox read authorization guard is fingerprinted',
    )
    for (const exactIdentity of [
      'gia9286799',
      '33785418-9927-4e10-a492-d3a44b9b6f21',
      'giah34fedoa5b1o',
      'c8fcf491-cf8c-469a-b03c-0026a762752c',
    ]) {
      assert.ok(
        hostedSandboxAuthorizationGuard.source.includes(exactIdentity),
        `0358 guard pins exact compiled account/organization identity ${exactIdentity}`,
      )
    }
    assert.ok(
      baseline.catalog.functions.some(
        (fn) => fn.name
          === 'operations_commerce_hosted_production_sandbox_read_is_current',
      ),
      '0358 hosted sandbox read capability predicate is fingerprinted',
    )
    const recoveryBudgetColumn = baseline.catalog.columns.find(
      (column) => (
        column.relation === 'public.operations_commerce_fulfillment_exports'
        && column.name === 'automatic_recovery_attempts'
      ),
    )
    assert.equal(recoveryBudgetColumn?.type, 'integer')
    assert.equal(recoveryBudgetColumn?.notNull, true)
    assert.equal(recoveryBudgetColumn?.default, '0')
    const recoveryBudgetConstraint = baseline.catalog.constraints.find(
      (constraint) => (
        constraint.relation === 'public.operations_commerce_fulfillment_exports'
        && constraint.name
          === 'operations_commerce_fulfillment_exports_recovery_budget_valid'
      ),
    )
    assert.ok(
      recoveryBudgetConstraint?.validated === true,
      '0359 recovery-budget check constraint is fingerprinted',
    )
    assert.equal(
      recoveryBudgetConstraint.definition.replace(/[()\s]/gu, ''),
      'CHECKautomatic_recovery_attempts>=0ANDautomatic_recovery_attempts<=attempts',
    )
    const recoveryBudgetIndex = baseline.catalog.indexes.find(
      (index) => (
        index.relation === 'public.operations_commerce_fulfillment_exports'
        && index.name
          === 'operations_commerce_fulfillment_exports_recovery_budget_idx'
      ),
    )
    assert.ok(
      recoveryBudgetIndex?.valid === true && recoveryBudgetIndex?.ready === true,
      '0359 recovery-budget index is fingerprinted and ready',
    )
    assert.equal(
      recoveryBudgetIndex.predicate.replace(/[()\s]/gu, ''),
      "provider=ANYARRAY['shopify'::text,'faire'::text]ANDstate=ANYARRAY['processing'::text,'failed'::text]",
    )

    console.log(`${image} target schema digest ${baseline.schemaDigest}`)
    const evidence = await attestProductionRebindHistorySchema(pool)
    assert.equal(evidence.postgresMajor, baseline.postgresMajor)
    assert.equal(evidence.schemaDigest, baseline.schemaDigest)

    for (const expected of PRODUCTION_REBIND_SCHEMA_MIGRATIONS) {
      await expectLedgerFailure(pool, expected.filename)
    }

    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0353 check constraint drift',
      (client) => client.query(
        `ALTER TABLE public.operations_commerce_workspace_migration_cutover_fences
         DROP CONSTRAINT operations_commerce_workspace_cutover_release_valid,
         ADD CONSTRAINT operations_commerce_workspace_cutover_release_valid
           CHECK (true)`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0354 index drift',
      (client) => client.query(
        `DROP INDEX public.operations_carrier_migration_placeholder_state_idx`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0356 column default drift',
      (client) => client.query(
        `ALTER TABLE public.operations_integration_credential_key_attestations
         ALTER COLUMN singleton_id SET DEFAULT 2`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0359 recovery-budget column default drift',
      (client) => client.query(
        `ALTER TABLE public.operations_commerce_fulfillment_exports
         ALTER COLUMN automatic_recovery_attempts SET DEFAULT 1`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0359 recovery-budget check drift',
      (client) => client.query(
        `ALTER TABLE public.operations_commerce_fulfillment_exports
         DROP CONSTRAINT operations_commerce_fulfillment_exports_recovery_budget_valid,
         ADD CONSTRAINT operations_commerce_fulfillment_exports_recovery_budget_valid
           CHECK (automatic_recovery_attempts >= 0)`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0359 recovery-budget index drift',
      (client) => client.query(
        `DROP INDEX public.operations_commerce_fulfillment_exports_recovery_budget_idx`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'relation row-security drift',
      (client) => client.query(
        `ALTER TABLE public.operations_commerce_migration_provider_identity_fences
         ENABLE ROW LEVEL SECURITY`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'relation ACL drift',
      (client) => client.query(
        `GRANT SELECT ON public.operations_carrier_account_migration_placeholders
         TO PUBLIC`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'column ACL drift',
      (client) => client.query(
        `GRANT SELECT (key_id)
         ON public.operations_integration_credential_key_attestations TO PUBLIC`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'relation owner drift',
      async (client) => {
        await client.query('CREATE ROLE target_schema_drift_owner NOLOGIN')
        await client.query(
          `ALTER TABLE public.operations_commerce_workspace_migration_cutover_fences
           OWNER TO target_schema_drift_owner`,
        )
      },
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'function ACL drift',
      (client) => client.query(
        `REVOKE EXECUTE
         ON FUNCTION public.protect_commerce_migration_provider_identity_fence()
         FROM PUBLIC`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'function owner drift',
      async (client) => {
        await client.query('CREATE ROLE target_function_drift_owner NOLOGIN')
        await client.query(
          `ALTER FUNCTION public.protect_carrier_account_migration_placeholder()
           OWNER TO target_function_drift_owner`,
        )
      },
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0356 function body drift',
      (client) => client.query(String.raw`
        CREATE OR REPLACE FUNCTION
          public.reject_integration_credential_key_attestation_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RETURN NULL;
        END;
        $$
      `),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0357 function body drift',
      (client) => client.query(String.raw`
        CREATE OR REPLACE FUNCTION
          public.guard_operations_commerce_product_image_import_job()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'disabled 0354 trigger',
      (client) => client.query(
        `ALTER TABLE public.operations_carrier_accounts
         DISABLE TRIGGER protect_migrated_carrier_shipper_identity_write`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'altered 0356 trigger event mask',
      (client) => client.query(
        `DROP TRIGGER reject_integration_credential_key_attestation_update_delete
           ON public.operations_integration_credential_key_attestations;
         CREATE TRIGGER reject_integration_credential_key_attestation_update_delete
         BEFORE UPDATE ON public.operations_integration_credential_key_attestations
         FOR EACH ROW EXECUTE FUNCTION
           public.reject_integration_credential_key_attestation_mutation()`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'public schema ACL drift',
      (client) => client.query('GRANT CREATE ON SCHEMA public TO PUBLIC'),
    )
    await expectFailure(
      pool,
      'schema_object_missing',
      'missing 0356 safety relation',
      (client) => client.query(
        `DROP TABLE public.operations_integration_credential_key_attestations CASCADE`,
      ),
    )

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `LOCK TABLE ${PRODUCTION_REBIND_CRITICAL_RELATIONS.join(', ')}
         IN ACCESS SHARE MODE`,
      )
      await attestProductionRebindHistorySchema(client)
      await client.query(
        `ALTER TABLE public.operations_commerce_migration_provider_identity_fences
         DISABLE TRIGGER protect_commerce_migration_provider_identity_fence_write`,
      )
      await assert.rejects(
        attestProductionRebindHistorySchema(client),
        (error) => (
          error instanceof ProductionRebindHistorySchemaAttestationError
          && error.code === 'schema_catalog_mismatch'
        ),
        'caller-owned transaction can re-attest after taking DDL-protection locks',
      )
      await client.query('ROLLBACK')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    await attestProductionRebindHistorySchema(pool)
  } finally {
    if (pool) await pool.end().catch(() => undefined)
    command('docker', ['rm', '--force', container], { stdio: 'ignore' })
  }
}

for (const image of images) await exerciseImage(image)

console.log(`production rebind target schema attestation passed (${images.join(', ')})`)
