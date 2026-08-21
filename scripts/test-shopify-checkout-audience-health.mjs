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
const rateControlSqlMatch = healthSource.match(
  /const SHOPIFY_CHECKOUT_RATE_CONTROL_HEALTH_SQL = String\.raw`([\s\S]*?)`\n/u,
)
assert.ok(rateControlSqlMatch, 'Health route must contain exact 0299 attestation SQL')
const rateControlAttestationSql = rateControlSqlMatch[1]

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

for (const fragment of [
  '0299_operations_shopify_checkout_rate_control.sql',
  '09f634524cbe67e825f0675c5ca0a73290e94d57eb3229a82412f329986ae581',
  '622a3970365026c6d9b8ed34de31737bd4b7b1cfd0ad8750e37b5db5a7e9b0c0',
  '84549b7f6f070ce2f5df23d89aaf818a0711e59016ca0c88ec9b4312816d04b9',
  '16218feeb6f9a6804932f1e9a29e26bb7fd1c2f7c2d0b46956571a806ba31845',
  '7b85db01722082bf6ad5e1d55fddbfb6045f808a47c436e2055ea887b6f2bde4',
  'ab9cfb51412ec44ee6d15d734652036bf56c7a5ffe8e8df418653d9a3310632a',
  'operations_shopify_checkout_rate_control_is_valid(jsonb)',
  'operations_shopify_checkout_rate_control_response_is_valid(jsonb)',
  'validate_operations_shopify_customer_rate_policy_write()',
  'protect_operations_commerce_external_effect_intent()',
  'protect_ops_shopify_cs_mut_authorization()',
  'operations_shopify_carrier_service_rating_runtime_is_ready(uuid,uuid)',
  'operations_shopify_checkout_rating_channel_is_eligible(text,text,text,text,boolean,boolean,integer)',
  'validate_operations_commerce_variant_pack_mapping()',
  'protect_operations_shopify_checkout_rate_receipt()',
  'operations_shopify_configs_rate_control_valid',
  'operations_shopify_checkout_rate_control_receipts',
  'operations_shopify_rate_control_receipt_config_fkey',
  'operations_shopify_configs_org_id_account_unique',
]) {
  assert.ok(
    rateControlAttestationSql.includes(fragment),
    `0299 health attestation missing ${fragment}`,
  )
}
assert.ok(
  (healthSource.match(/row\?\.shopify_checkout_rate_control_applied/gu) || [])
    .length >= 3,
  '0299 drift must fail migrationsCurrent and global health',
)
assert.match(
  healthSource,
  /shopifyCheckoutRateControl: \{[\s\S]*?shopify_checkout_rate_control_applied[\s\S]*?'migration-or-structure-pending'/u,
  '0299 attestation must be visible in the health response',
)

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

async function attestRateControl(pool) {
  const result = await pool.query(
    `SELECT (${rateControlAttestationSql}) AS applied`,
  )
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

async function tamperRateControl(pool, sql, message) {
  await pool.query('BEGIN')
  try {
    await pool.query(sql)
    assert.equal(await attestRateControl(pool), false, message)
  } finally {
    await pool.query('ROLLBACK')
  }
  assert.equal(
    await attestRateControl(pool),
    true,
    `${message}: rollback must restore green health`,
  )
}

async function exercise(pool) {
  assert.equal(
    await attest(pool),
    true,
    'Fresh 0293 schema must pass exact health attestation',
  )
  assert.equal(
    await attestRateControl(pool),
    true,
    'Fresh 0299 schema must pass exact checkout-rate control health',
  )

  await pool.query('BEGIN')
  try {
    await pool.query(`SET LOCAL session_replication_role = 'replica'`)
    await pool.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation
       ) VALUES (
         '29990000-0000-4000-8000-000000000001'::uuid,
         'gia2999001',
         '29990000-0000-4000-8000-000000000002'::uuid,
         'shopify', 'commerce', 'production',
         'Production desired TEST health fixture', 'active',
         '{"accountName":"Production desired TEST health fixture"}'::jsonb,
         'production-desired-test.myshopify.com', 1
       )`,
    )
    await pool.query(
      `INSERT INTO operations_shopify_carrier_service_configs (
         id, global_id, organization_id, integration_account_id,
         warehouse_id, registration_state, credential_generation,
         activation_revision, callback_token_version, callback_token_hash,
         policy_revision, policy_hash, policy_snapshot,
         inventory_max_age_seconds, quote_ttl_seconds,
         order_reconciliation_window_seconds, algorithm_version, row_version
       ) VALUES (
         '29990000-0000-4000-8000-000000000003'::uuid,
         'gscf2999001',
         '29990000-0000-4000-8000-000000000002'::uuid,
         '29990000-0000-4000-8000-000000000001'::uuid,
         '29990000-0000-4000-8000-000000000004'::uuid,
         'disabled', 1, 1, 1, repeat('a', 64), 1, repeat('b', 64),
         '{
           "version":"shopify-checkout-rating-policy-v1",
           "planRateOptimization":{
             "version":"shopify-checkout-plan-rate-objective-v2",
             "maxCandidates":4,
             "objectivePriority":["landed_price","package_count","unused_cube"],
             "handlingCostMinorPerPackage":0,
             "handlingCostCurrency":"USD"
           },
           "checkoutRateWarm":{
             "version":"shopify-checkout-rate-warm-v1",
             "enabled":false,
             "mode":"hosted_ajax",
             "zoneScope":"all_saved_rate_zones",
             "concurrency":2,
             "debounceMs":350,
             "minIntervalMs":1000,
             "supportedCountries":["US"],
             "staleCartAbort":true
           },
           "shadowCheckoutAudience":{
             "version":"shopify-checkout-audience-v1",
             "mode":"restricted_customers"
           },
           "checkoutRateControl":{
             "version":"shopify-checkout-rate-control-v1",
             "audience":"restricted_customers",
             "rateSource":"sandbox"
           }
         }'::jsonb,
         900, 900, 86400, 'production-desired-test-health-v1', 1
       )`,
    )
    await pool.query(`SET LOCAL session_replication_role = 'origin'`)
    assert.equal(
      await attestRateControl(pool),
      true,
      'A production Shopify account may retain desired TEST control while effective runtime stays blocked',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  const rateControlSemantics = await pool.query(
    `SELECT
       operations_shopify_checkout_rate_control_is_valid(
         '{"version":"shopify-checkout-rate-control-v1","audience":"off","rateSource":"sandbox"}'::jsonb
       ) AS valid,
       operations_shopify_checkout_rate_control_is_valid(
         '{"version":"shopify-checkout-rate-control-v1","audience":"off"}'::jsonb
       ) AS missing_key,
       operations_shopify_checkout_rate_control_is_valid(
         '{"version":"shopify-checkout-rate-control-v1","audience":"off","rateSource":"sandbox","extra":true}'::jsonb
       ) AS extra_key`,
  )
  assert.deepEqual(rateControlSemantics.rows[0], {
    valid: true,
    missing_key: false,
    extra_key: false,
  })

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

  await tamperRateControl(
    pool,
    `UPDATE schema_migrations
     SET checksum = repeat('0', 64)
     WHERE filename = '0299_operations_shopify_checkout_rate_control.sql'`,
    'A changed 0299 migration checksum must fail health',
  )
  await tamperRateControl(
    pool,
    `CREATE OR REPLACE FUNCTION
       operations_shopify_checkout_rate_control_is_valid(input jsonb)
     RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
     AS $$ SELECT true $$`,
    'A weakened 0299 control validator must fail health',
  )
  const validatorDefinition = await pool.query(
    `SELECT pg_get_functiondef(
       'public.operations_shopify_checkout_rate_control_is_valid(jsonb)'::regprocedure
     ) AS definition`,
  )
  const shadowValidatorDefinition = String(
    validatorDefinition.rows[0]?.definition || '',
  ).replace(
    'FUNCTION public.operations_shopify_checkout_rate_control_is_valid',
    'FUNCTION checkout_health_shadow.operations_shopify_checkout_rate_control_is_valid',
  )
  assert.notEqual(
    shadowValidatorDefinition,
    validatorDefinition.rows[0]?.definition,
    'The foreign-schema validator fixture must preserve exact expected bytes',
  )
  await pool.query('BEGIN')
  try {
    await pool.query('CREATE SCHEMA checkout_health_shadow')
    await pool.query(shadowValidatorDefinition)
    await pool.query(
      `CREATE OR REPLACE FUNCTION
         public.operations_shopify_checkout_rate_control_is_valid(input jsonb)
       RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
       AS $$ SELECT true $$`,
    )
    await pool.query(
      'SET LOCAL search_path = checkout_health_shadow, public, pg_catalog',
    )
    assert.equal(
      await attestRateControl(pool),
      false,
      'A foreign-schema exact lookalike must not hide a weakened public runtime function',
    )
  } finally {
    await pool.query('ROLLBACK')
  }
  assert.equal(
    await attestRateControl(pool),
    true,
    'Foreign-schema lookalike rollback must restore green health',
  )
  await tamperRateControl(
    pool,
    `CREATE OR REPLACE FUNCTION
       operations_shopify_carrier_service_rating_runtime_is_ready(
         requested_organization_id uuid,
         requested_config_id uuid
       )
     RETURNS boolean LANGUAGE sql STABLE
     AS $$ SELECT true $$`,
    'A rating-runtime readiness function replaced with SELECT true must fail health',
  )
  await tamperRateControl(
    pool,
    `CREATE OR REPLACE FUNCTION
       operations_legacy_shopify_config_carrier_account_id(
         requested_organization_id uuid,
         requested_receipt_global_id text,
         requested_provider text
       )
     RETURNS uuid LANGUAGE sql STABLE
     AS $$ SELECT NULL::uuid $$`,
    'A weakened receipt-lineage source function must fail health',
  )
  await tamperRateControl(
    pool,
    `ALTER TABLE operations_shopify_carrier_service_configs
       DROP CONSTRAINT operations_shopify_configs_rate_control_valid,
       ADD CONSTRAINT operations_shopify_configs_rate_control_valid
         CHECK (true)`,
    'A same-named but weakened checkout control CHECK must fail health',
  )
  await tamperRateControl(
    pool,
    `DROP TRIGGER
       validate_operations_shopify_checkout_rate_control_config_write
       ON operations_shopify_carrier_service_configs;
     CREATE TRIGGER
       validate_operations_shopify_checkout_rate_control_config_write
     BEFORE INSERT OR UPDATE OF policy_snapshot, integration_account_id
     ON operations_shopify_carrier_service_configs
     FOR EACH ROW WHEN (false)
     EXECUTE FUNCTION validate_operations_shopify_checkout_rate_control_config()`,
    'A same-named config trigger with a false WHEN clause must fail health',
  )
  await tamperRateControl(
    pool,
    `DROP TRIGGER
       validate_operations_shopify_checkout_rate_control_receipt_write
       ON operations_shopify_checkout_rate_control_receipts;
     CREATE TRIGGER
       validate_operations_shopify_checkout_rate_control_receipt_write
     BEFORE INSERT ON operations_shopify_checkout_rate_control_receipts
     FOR EACH ROW EXECUTE FUNCTION
       protect_operations_shopify_checkout_rate_control_receipt()`,
    'A same-named receipt trigger rebound to the wrong function must fail health',
  )
  await tamperRateControl(
    pool,
    `ALTER TABLE operations_shopify_carrier_service_configs
       DISABLE TRIGGER
         validate_operations_shopify_checkout_rate_control_config_write`,
    'A disabled checkout-rate control trigger must fail health',
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
