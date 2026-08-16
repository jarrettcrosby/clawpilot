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
  /const OPERATIONS_SHADOW_TRAINING_HEALTH_SQL = String\.raw`([\s\S]*?)`\n/u,
)
assert.ok(sqlMatch, 'Health route must contain the exact 0290 attestation SQL')
const attestationSql = sqlMatch[1]

const requiredStructure = [
  '0290_operations_shadow_training_runs.sql',
  '0300_operations_order_training_independent_control.sql',
  'operations_shadow_training_runs',
  'operations_shadow_training_packages',
  'operations_shadow_training_pick_tasks',
  'operations_shadow_training_label_links',
  'operations_shadow_training_events',
  '94b2140dfccc4cbe4be93f7a012209f62c42e843571e98478eaed8138f184ca4',
  '901e43b88b31a4b9351fcfd47922662d4279521cee47565dc58acbf316097286',
  '499e300e70604fc04b2439d060ffebd1e2115211b8d98d9ce008c23334713db2',
  'c22cef6f8aa8f8fb01e82a154d6c4e93e8ed79eda97a2539ff91c6bdcd4ec834',
  '16a6e0621dc8e4baa112f231a094243cfd222230f73ecba4b842ba3006f2dba4',
  '6898d7e22abcb3963c55bac7f3eb30cef0eda6dd8ca030d36e1bf99d3f683cd0',
  '340ca4ea1323121e8316f852e9240f21cc99fb23bf53eb312d923617347c3bce',
  '1ec65dc17177ce3d53776ebb035f175f0d7ba10900d2dc5de88bfb31aafd5ea0',
  '9a033b6182465d99682fc1ecee2dca0302ac95f726b1f2b3d1ef6c7bc932371a',
  '0c8485310e1dade3adfd8b38128b7ea288975456f2ff796fa9160a5757881dad',
  '8425b26ae132be23ef0b835fc03b5ac35bf0b42b2728a098ff1184f62f4fa1fc',
  'c1fa92771860f78c76184fae9ffa538cb772d25efd0fadc23d2f72192f106e21',
  'e15f2304f2daa3d4ec1238374d052368f57c68bf6df030bbdd21735e245bf230',
  '786a373981688256f1f83b94208b405a2b6446d04a21678a2a76a4110005d14e',
  'ca5802ce1dc69f7e6d47f6cb0b5abc44dfac824fb8318610820e03383bedb310',
  'a5b376395ea46576c38bcd3dabb9e1a57b97aeeb37bef308afdec3ce4fa0e053',
  'operations_shadow_training_runs_one_open_order',
  "(state <> ''reset''::text)",
  'validate_operations_shadow_training_package_fact()',
  'validate_operations_shadow_training_pick_fact()',
  'validate_operations_shadow_training_plan_coverage()',
  'protect_operations_shadow_training_run()',
  'validate_operations_shadow_training_run_identity()',
  'protect_operations_shadow_training_package()',
  'protect_operations_shadow_training_pick_task()',
  'protect_operations_shadow_training_event()',
  'validate_operations_shadow_training_label_link()',
  'guard_shadow_commerce_canonical_write()',
  'guard_shadow_training_activation_change()',
  'validate_operations_shadow_training_package_fact_commit',
  'validate_operations_shadow_training_pick_fact_commit',
  'validate_operations_shadow_training_plan_coverage_update',
  'validate_operations_shadow_training_run_identity_mutation',
  'protect_operations_shadow_training_run_mutation',
  'protect_operations_shadow_training_package_mutation',
  'protect_operations_shadow_training_pick_task_mutation',
  'protect_operations_shadow_training_event_mutation',
  'validate_operations_shadow_training_label_link_mutation',
  'guard_shadow_commerce_canonical_plan_insert',
  'guard_shadow_commerce_canonical_reservation_insert',
  'guard_shadow_commerce_canonical_shipment_insert',
  'guard_shadow_commerce_canonical_export_insert',
  'guard_shadow_training_activation_change_insert',
  'guard_shadow_training_activation_change_update',
  'guard_shadow_training_activation_change_delete',
  'installed_index.indisunique',
  'installed_index.indisvalid',
  'installed_index.indisready',
  "installed_trigger.tgenabled = 'O'",
  'installed_trigger.tgqual IS NULL',
  'installed_trigger.tgdeferrable',
  'installed_trigger.tginitdeferred',
  'installed_trigger.tgattr',
  "THEN ARRAY['state']::name[]",
  'gtrn',
  'gtpk',
  'gtpt',
  'gtll',
  'gtev',
]
for (const fragment of requiredStructure) {
  assert.ok(
    attestationSql.includes(fragment),
    `0290 health attestation missing ${fragment}`,
  )
}

assert.ok(
  (healthSource.match(/row\?\.operations_shadow_training_applied/gu) || [])
    .length >= 3,
  '0290 structural drift must fail migrationsCurrent and global health',
)
assert.match(
  healthSource,
  /&& row\?\.operations_shadow_training_applied/u,
  '0290 attestation must participate in migrationsCurrent',
)
assert.match(
  healthSource,
  /\|\| !row\?\.operations_shadow_training_applied/u,
  '0290 attestation failure must append the global migration health error',
)
assert.match(
  healthSource,
  /shadowTraining: \{[\s\S]*?operations_shadow_training_applied[\s\S]*?'migration-or-structure-pending'/u,
  '0290 attestation must be visible in the health response',
)
assert.match(
  healthSource,
  /\{ status: errors\.length > 0 \? 503 : 200 \}/u,
  'Any global health error, including 0290 drift, must return HTTP 503',
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
    'Fresh 0290 schema must pass the exact health attestation',
  )

  await pool.query('BEGIN')
  try {
    await pool.query(
      `DELETE FROM schema_migrations
       WHERE filename = '0290_operations_shadow_training_runs.sql'`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A missing 0290 migration record must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `DELETE FROM schema_migrations
       WHERE filename = '0300_operations_order_training_independent_control.sql'`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A missing 0300 independent-control migration record must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `ALTER TABLE operations_shadow_training_packages
       DROP CONSTRAINT operations_shadow_training_packages_sequence_unique`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Removing package-sequence uniqueness must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query('DROP TABLE operations_shadow_training_events')
    assert.equal(
      await attest(pool),
      false,
      'A missing training ledger must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      'DROP INDEX operations_shadow_training_runs_one_open_order',
    )
    assert.equal(
      await attest(pool),
      false,
      'Removing the one-open-run fence must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `ALTER TABLE operations_shadow_training_runs
       DROP CONSTRAINT operations_shadow_training_runs_terminal_valid,
       ADD CONSTRAINT operations_shadow_training_runs_terminal_valid
         CHECK (state IS NOT NULL)`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A same-named weakened terminal-state check must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `ALTER TABLE operations_shadow_training_packages
       DROP CONSTRAINT operations_shadow_training_packages_run_fkey`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Removing exact run-to-package ownership must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `CREATE OR REPLACE FUNCTION guard_shadow_commerce_canonical_write()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RETURN NEW;
       END;
       $$`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Weakening the canonical-write quarantine function must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  for (const [tableName, triggerName] of [
    [
      'operations_fulfillment_plans',
      'guard_shadow_commerce_canonical_plan_insert',
    ],
    [
      'operations_reservations',
      'guard_shadow_commerce_canonical_reservation_insert',
    ],
    [
      'operations_shipments',
      'guard_shadow_commerce_canonical_shipment_insert',
    ],
    [
      'operations_commerce_fulfillment_exports',
      'guard_shadow_commerce_canonical_export_insert',
    ],
  ]) {
    await pool.query('BEGIN')
    try {
      await pool.query(
        `ALTER TABLE ${tableName} DISABLE TRIGGER ${triggerName}`,
      )
      assert.equal(
        await attest(pool),
        false,
        `Disabling canonical-write quarantine ${triggerName} must fail health`,
      )
    } finally {
      await pool.query('ROLLBACK')
    }
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `DROP TRIGGER guard_shadow_commerce_canonical_plan_insert
         ON operations_fulfillment_plans;
       CREATE TRIGGER guard_shadow_commerce_canonical_plan_insert
       BEFORE INSERT OR UPDATE ON operations_fulfillment_plans
       FOR EACH ROW WHEN (false)
       EXECUTE FUNCTION guard_shadow_commerce_canonical_write()`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A same-function canonical trigger disabled by WHEN(false) must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `CREATE OR REPLACE FUNCTION guard_shadow_training_activation_change()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP = 'DELETE' THEN
           RETURN OLD;
         END IF;
         RETURN NEW;
       END;
       $$`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Weakening activation-change protection must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  for (const triggerName of [
    'guard_shadow_training_activation_change_insert',
    'guard_shadow_training_activation_change_update',
    'guard_shadow_training_activation_change_delete',
  ]) {
    await pool.query('BEGIN')
    try {
      await pool.query(
        `ALTER TABLE operations_activation_scopes
         DISABLE TRIGGER ${triggerName}`,
      )
      assert.equal(
        await attest(pool),
        false,
        `Disabling activation protection ${triggerName} must fail health`,
      )
    } finally {
      await pool.query('ROLLBACK')
    }
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `DROP TRIGGER guard_shadow_training_activation_change_update
         ON operations_activation_scopes`,
    )
    await pool.query(
      `CREATE TRIGGER guard_shadow_training_activation_change_update
       BEFORE UPDATE OF reason ON operations_activation_scopes
       FOR EACH ROW
       EXECUTE FUNCTION guard_shadow_training_activation_change()`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Rebinding activation protection away from state must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `UPDATE global_reference_entity_types
       SET entity_type = 'operations.shadow_training_wrong'
       WHERE prefix = 'gtrn'`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Changing the training-run reference owner must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }
}

async function main() {
  const existingDatabaseUrl = String(
    process.env.SHADOW_TRAINING_HEALTH_DATABASE_URL || '',
  ).trim()
  if (existingDatabaseUrl) {
    const pool = new Pool({ connectionString: existingDatabaseUrl, max: 2 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
    console.log('Shadow training health attestation passed')
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-shadow-training-health-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  let containerStarted = false
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=shadow_training_health',
      '-e', 'POSTGRES_DB=shadow_training_health',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    containerStarted = true
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:shadow_training_health@127.0.0.1:'
      + `${port}/shadow_training_health`
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
      command('docker', ['stop', container], { timeout: 30_000 })
    }
  }

  console.log('Shadow training health attestation passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
