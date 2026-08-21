#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const healthSource = readFileSync(
  resolve(root, 'app_src/app/api/health/route.ts'),
  'utf8',
)
const sqlMatch = healthSource.match(
  /const SHOPIFY_TEST_STORE_CANONICAL_E2E_HEALTH_SQL = String\.raw`([\s\S]*?)`\n/u,
)
assert.ok(sqlMatch, 'Health route must contain the exact 0302 attestation SQL')
const attestationSql = sqlMatch[1]
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const disposablePostgresImage = String(
  process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16',
).trim()
assert.ok(
  ['pgvector/pgvector:pg16', 'pgvector/pgvector:pg18'].includes(
    disposablePostgresImage,
  ),
  'CLAWPILOT_TEST_POSTGRES_IMAGE must select the exact pg16 or pg18 image',
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

async function fingerprint(pool, sql) {
  const result = await pool.query(sql)
  return {
    count: result.rowCount,
    hash: createHash('sha256')
      .update(result.rows.map((row) => row.line).join('\n'))
      .digest('hex'),
  }
}

async function fingerprints(pool) {
  const table = await fingerprint(pool, `
    SELECT concat_ws('|', required.table_name, installed_namespace.nspname,
             installed.relkind::text, installed.relpersistence::text,
             installed.relrowsecurity::text,
             installed.relforcerowsecurity::text) AS line
    FROM (VALUES
      ('operations_shopify_test_store_e2e_evidence'),
      ('operations_shopify_test_store_e2e_fulfillment_confirmations')
    ) required(table_name)
    LEFT JOIN pg_catalog.pg_class installed
      ON installed.oid = pg_catalog.to_regclass(
        'public.' || required.table_name
      )
    LEFT JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed.relnamespace
    ORDER BY required.table_name
  `)
  const column = await fingerprint(pool, `
    SELECT concat_ws('|', table_row.relname, table_namespace.nspname,
             installed.attname, installed.attnum::text,
             pg_catalog.format_type(installed.atttypid, installed.atttypmod),
             installed.attnotnull::text, installed.attidentity::text,
             installed.attgenerated::text,
             COALESCE(pg_catalog.pg_get_expr(
               installed_default.adbin, installed_default.adrelid
             ), ''),
             COALESCE(installed_collation.collname, '')) AS line
    FROM pg_catalog.pg_attribute installed
    JOIN pg_catalog.pg_class table_row
      ON table_row.oid = installed.attrelid
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_row.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef installed_default
      ON installed_default.adrelid = installed.attrelid
     AND installed_default.adnum = installed.attnum
    LEFT JOIN pg_catalog.pg_collation installed_collation
      ON installed_collation.oid = installed.attcollation
    WHERE installed.attnum > 0
      AND NOT installed.attisdropped
      AND installed.attrelid IN (
        pg_catalog.to_regclass(
          'public.operations_shopify_test_store_e2e_evidence'
        ),
        pg_catalog.to_regclass(
          'public.operations_shopify_test_store_e2e_fulfillment_confirmations'
        )
      )
    ORDER BY table_row.relname, installed.attnum
  `)
  const constraint = await fingerprint(pool, `
    SELECT concat_ws('|', required.table_name, table_namespace.nspname,
             installed.conname, installed.contype::text,
             installed.convalidated::text, installed.condeferrable::text,
             installed.condeferred::text,
             trim(regexp_replace(
               pg_catalog.pg_get_constraintdef(installed.oid),
               '[[:space:]]+', ' ', 'g'
             ))) AS line
    FROM (VALUES
      ('operations_shopify_test_store_e2e_evidence', NULL::text),
      ('operations_shopify_test_store_e2e_fulfillment_confirmations', NULL::text),
      ('operations_sandbox_commerce_e2e_authorizations',
       'operations_sandbox_e2e_confirm_version_check')
    ) required(table_name, constraint_name)
    LEFT JOIN pg_catalog.pg_class table_row
      ON table_row.oid = pg_catalog.to_regclass(
        'public.' || required.table_name
      )
    LEFT JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_row.relnamespace
    LEFT JOIN pg_catalog.pg_constraint installed
      ON installed.conrelid = table_row.oid
     AND (
       required.constraint_name IS NULL
       OR installed.conname = required.constraint_name
     )
    ORDER BY required.table_name, installed.conname
  `)
  const index = await fingerprint(pool, `
    SELECT concat_ws('|', table_row.relname, table_namespace.nspname,
             index_row.relname, index_namespace.nspname,
             installed.indisunique::text, installed.indisprimary::text,
             installed.indisvalid::text, installed.indisready::text,
             trim(regexp_replace(
               pg_catalog.pg_get_indexdef(installed.indexrelid),
               '[[:space:]]+', ' ', 'g'
             ))) AS line
    FROM pg_catalog.pg_index installed
    JOIN pg_catalog.pg_class table_row
      ON table_row.oid = installed.indrelid
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_row.relnamespace
    JOIN pg_catalog.pg_class index_row
      ON index_row.oid = installed.indexrelid
    JOIN pg_catalog.pg_namespace index_namespace
      ON index_namespace.oid = index_row.relnamespace
    WHERE installed.indrelid IN (
      pg_catalog.to_regclass(
        'public.operations_shopify_test_store_e2e_evidence'
      ),
      pg_catalog.to_regclass(
        'public.operations_shopify_test_store_e2e_fulfillment_confirmations'
      )
    ) OR installed.indexrelid = pg_catalog.to_regclass(
      'public.operations_shopify_test_store_e2e_active_org_unique'
    )
    ORDER BY table_row.relname, index_row.relname
  `)
  const fn = await fingerprint(pool, `
    SELECT concat_ws('|', required.signature, installed_namespace.nspname,
             language.lanname, installed.prokind::text,
             installed.provolatile::text, installed.proparallel::text,
             installed.proisstrict::text, installed.prosecdef::text,
             installed.proleakproof::text,
             pg_catalog.format_type(installed.prorettype, NULL),
             installed.pronargs::text, installed.pronargdefaults::text,
             COALESCE(array_to_string(installed.proconfig, ','), ''),
             trim(regexp_replace(
               installed.prosrc, '[[:space:]]+', ' ', 'g'
             ))) AS line
    FROM (VALUES
      ('operations_shopify_test_store_e2e_is_current(uuid,uuid,uuid)'),
      ('protect_shopify_test_store_e2e_confirmation()'),
      ('protect_shopify_test_store_e2e_evidence()')
    ) required(signature)
    LEFT JOIN pg_catalog.pg_proc installed
      ON installed.oid = pg_catalog.to_regprocedure(
        'public.' || required.signature
      )
    LEFT JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed.pronamespace
    LEFT JOIN pg_catalog.pg_language language
      ON language.oid = installed.prolang
    ORDER BY required.signature
  `)
  const trigger = await fingerprint(pool, `
    SELECT concat_ws('|', required.table_name, table_namespace.nspname,
             installed.tgname, installed.tgtype::text,
             installed.tgenabled::text, installed.tgisinternal::text,
             function_namespace.nspname || '.' || trigger_function.proname
               || '(' || pg_catalog.pg_get_function_identity_arguments(
                 trigger_function.oid
               ) || ')',
             COALESCE(pg_catalog.pg_get_expr(
               installed.tgqual, installed.tgrelid
             ), ''),
             trim(regexp_replace(
               pg_catalog.pg_get_triggerdef(installed.oid),
               '[[:space:]]+', ' ', 'g'
             ))) AS line
    FROM (VALUES
      ('operations_shopify_test_store_e2e_evidence',
       'protect_shopify_test_store_e2e_evidence_write'),
      ('operations_shopify_test_store_e2e_fulfillment_confirmations',
       'protect_shopify_test_store_e2e_confirmation_write')
    ) required(table_name, trigger_name)
    LEFT JOIN pg_catalog.pg_class table_row
      ON table_row.oid = pg_catalog.to_regclass(
        'public.' || required.table_name
      )
    LEFT JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_row.relnamespace
    LEFT JOIN pg_catalog.pg_trigger installed
      ON installed.tgrelid = table_row.oid
     AND installed.tgname = required.trigger_name
    LEFT JOIN pg_catalog.pg_proc trigger_function
      ON trigger_function.oid = installed.tgfoid
    LEFT JOIN pg_catalog.pg_namespace function_namespace
      ON function_namespace.oid = trigger_function.pronamespace
    ORDER BY required.table_name, installed.tgname
  `)
  return { table, column, constraint, index, function: fn, trigger }
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
  assert.equal(await attest(pool), true, `${message}: rollback must restore green`)
}

async function exercise(pool) {
  const exactFingerprints = await fingerprints(pool)
  if (process.argv.includes('--print-fingerprints')) {
    console.log(JSON.stringify(exactFingerprints, null, 2))
    return
  }
  assert.equal(
    await attest(pool),
    true,
    `Fresh 0302 schema must pass exact health attestation: ${JSON.stringify(exactFingerprints)}`,
  )
  await tamper(
    pool,
    `UPDATE public.schema_migrations SET checksum = repeat('0', 64)
     WHERE filename = '0302_operations_shopify_test_store_canonical_e2e.sql'`,
    'Changed 0302 checksum must fail health',
  )
  await tamper(
    pool,
    `ALTER TABLE public.operations_shopify_test_store_e2e_evidence
       ALTER COLUMN authorization_request_hash DROP NOT NULL`,
    'Changed column nullability must fail health',
  )
  await tamper(
    pool,
    `ALTER TABLE public.operations_shopify_test_store_e2e_evidence
       DROP CONSTRAINT operations_shopify_test_store_e2e_evidence_fresh,
       ADD CONSTRAINT operations_shopify_test_store_e2e_evidence_fresh
         CHECK (true)`,
    'Same-named weakened proof freshness CHECK must fail health',
  )
  await tamper(
    pool,
    `ALTER TABLE public.operations_sandbox_commerce_e2e_authorizations
       DROP CONSTRAINT operations_sandbox_e2e_confirm_version_check,
       ADD CONSTRAINT operations_sandbox_e2e_confirm_version_check
         CHECK (true)`,
    'Same-named weakened authorization-version CHECK must fail health',
  )
  await tamper(
    pool,
    `ALTER TABLE
       public.operations_shopify_test_store_e2e_fulfillment_confirmations
       DROP CONSTRAINT operations_shopify_test_store_e2e_confirmation_key_unique`,
    'Removed confirmation idempotency unique must fail health',
  )
  await tamper(
    pool,
    `ALTER TABLE public.operations_shopify_test_store_e2e_evidence
       DROP CONSTRAINT operations_shopify_test_store_e2e_evidence_order_fkey,
       ADD CONSTRAINT operations_shopify_test_store_e2e_evidence_order_fkey
         CHECK (true)`,
    'Same-named FK replaced by a CHECK must fail health',
  )
  await tamper(
    pool,
    `DROP INDEX public.operations_shopify_test_store_e2e_active_org_unique;
     CREATE UNIQUE INDEX operations_shopify_test_store_e2e_active_org_unique
       ON public.operations_sandbox_commerce_e2e_authorizations
         (organization_id)
       WHERE state = 'active'`,
    'Changed partial-index predicate must fail health',
  )
  await tamper(
    pool,
    `ALTER FUNCTION
       public.operations_shopify_test_store_e2e_is_current(uuid,uuid,uuid)
       VOLATILE`,
    'Changed current-authority function metadata must fail health',
  )
  await tamper(
    pool,
    `DROP TRIGGER protect_shopify_test_store_e2e_evidence_write
       ON public.operations_shopify_test_store_e2e_evidence;
     CREATE TRIGGER protect_shopify_test_store_e2e_evidence_write
       BEFORE INSERT OR UPDATE OR DELETE
       ON public.operations_shopify_test_store_e2e_evidence
       FOR EACH ROW WHEN (false)
       EXECUTE FUNCTION public.protect_shopify_test_store_e2e_evidence()`,
    'Same-named trigger with WHEN false must fail health',
  )
  await pool.query('BEGIN')
  try {
    await pool.query('CREATE SCHEMA shopify_test_e2e_health_shadow')
    const definition = await pool.query(
      `SELECT pg_catalog.pg_get_functiondef(
         'public.operations_shopify_test_store_e2e_is_current(uuid,uuid,uuid)'::regprocedure
       ) AS definition`,
    )
    await pool.query(String(definition.rows[0].definition).replace(
      'FUNCTION public.operations_shopify_test_store_e2e_is_current',
      'FUNCTION shopify_test_e2e_health_shadow.operations_shopify_test_store_e2e_is_current',
    ))
    await pool.query(
      `CREATE OR REPLACE FUNCTION
         public.operations_shopify_test_store_e2e_is_current(
           requested_organization_id uuid,
           requested_authorization_id uuid,
           requested_order_id uuid
         )
       RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`,
    )
    await pool.query(
      `SET LOCAL search_path = shopify_test_e2e_health_shadow, public, pg_catalog`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A foreign-schema exact lookalike must not hide weakened public authority',
    )
  } finally {
    await pool.query('ROLLBACK')
  }
  assert.equal(
    await attest(pool),
    true,
    'Foreign-schema lookalike rollback must restore green health',
  )
}

async function main() {
  const existingDatabaseUrl = String(
    process.env.SHOPIFY_TEST_STORE_E2E_HEALTH_DATABASE_URL || '',
  ).trim()
  if (existingDatabaseUrl) {
    const pool = new Pool({ connectionString: existingDatabaseUrl, max: 2 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-shopify-test-e2e-health-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  let containerStarted = false
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=shopify_test_e2e_health',
      '-e', 'POSTGRES_DB=shopify_test_e2e_health',
      '-p', '127.0.0.1::5432',
      disposablePostgresImage,
    ], { timeout: 180_000 })
    containerStarted = true
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:shopify_test_e2e_health@127.0.0.1:'
      + `${port}/shopify_test_e2e_health`
    )
    await waitForPostgres(databaseUrl)
    command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
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
        command('docker', ['stop', '-t', '1', container], { timeout: 30_000 })
      } catch {
        // Preserve the primary assertion if best-effort cleanup also fails.
      }
    }
  }
  console.log('Shopify test-store canonical E2E exact health passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
