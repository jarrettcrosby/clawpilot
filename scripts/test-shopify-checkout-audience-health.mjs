#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const disposablePostgresImage = String(
  process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16',
).trim()
assert.ok(
  [
    'pgvector/pgvector:pg16',
    'pgvector/pgvector:pg18',
  ].includes(disposablePostgresImage),
  'CLAWPILOT_TEST_POSTGRES_IMAGE must select the exact pg16 or pg18 image',
)
const futureCommerceRolloutContractMigration = readFileSync(
  resolve(
    root,
    'scripts/fixtures/0305_operations_commerce_rollout_contract.sql',
  ),
  'utf8',
)
const preMigrationSafetyCarrierRatingFunction = readFileSync(
  resolve(
    root,
    'db/migrations/0285_shopify_carrier_service_configured_carriers.sql',
  ),
  'utf8',
).match(
  /CREATE OR REPLACE FUNCTION\s+(?:public\.)?operations_shopify_carrier_configuration_allows_rating\([\s\S]*?\n\$\$;/u,
)?.[0]
assert.ok(
  preMigrationSafetyCarrierRatingFunction,
  'The exact pre-0354 carrier-rating function must remain available to test rolling health',
)
assert.equal(
  createHash('sha256')
    .update(futureCommerceRolloutContractMigration)
    .digest('hex'),
  'e5ad3008d637149bc5e1d86f6d4345c6aa42d50420f0af09afae312f32f8145b',
  'The exact combined 0305 contract bytes must match Release 1 health',
)
assert.equal(
  existsSync(resolve(
    root,
    'db/migrations/0305_operations_commerce_rollout_contract.sql',
  )),
  false,
  'Release A must not publish the strict 0305 contract as an executable migration',
)
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
assert.match(
  rateControlAttestationSql,
  /WHERE extra_table_namespace\.nspname = 'public'\s+--[^\n]*\n\s+--[^\n]*\n\s+--[^\n]*\n\s+AND extra\.contype OPERATOR\(pg_catalog\.<>\) 'n'\s+AND \(/u,
  '0299 health must exclude PostgreSQL 18 NOT NULL constraint rows',
)
const writerContractSqlMatch = healthSource.match(
  /const SHOPIFY_CHECKOUT_RATE_SOURCE_WRITER_CONTRACT_SQL = String\.raw`([\s\S]*?)`\n/u,
)
assert.ok(
  writerContractSqlMatch,
  'Health route must contain the exact receipt-writer phase SQL',
)
const writerContractSql = writerContractSqlMatch[1].replaceAll(
  '${SHOPIFY_CHECKOUT_RATE_CONTROL_HEALTH_SQL}',
  rateControlAttestationSql,
)
const legacy14aPolicy = {
  version: 'shopify-checkout-rating-policy-v1',
  planRateOptimization: {
    version: 'shopify-checkout-plan-rate-objective-v2',
    maxCandidates: 4,
    objectivePriority: ['landed_price', 'package_count', 'unused_cube'],
    handlingCostMinorPerPackage: 0,
    handlingCostCurrency: 'USD',
  },
  checkoutRateWarm: {
    version: 'shopify-checkout-rate-warm-v1',
    enabled: false,
    mode: 'hosted_ajax',
    zoneScope: 'all_saved_rate_zones',
    concurrency: 2,
    debounceMs: 350,
    minIntervalMs: 1000,
    supportedCountries: ['US'],
    staleCartAbort: true,
  },
  shadowCheckoutAudience: {
    version: 'shopify-checkout-audience-v1',
    mode: 'restricted_customers',
  },
}
const explicitRateControlPolicy = {
  ...legacy14aPolicy,
  checkoutRateControl: {
    version: 'shopify-checkout-rate-control-v1',
    audience: 'restricted_customers',
    rateSource: 'production',
  },
}

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
  'ad82ca01e9e19cb20c95bfec25588d50ad706419ee3a58db24e0662de85e3618',
  '0317_operations_shopify_carrier_service_simulation_runtime_readiness.sql',
  '8b6de19ad2fa428edd087100e1cb73c851ba59a7fdff248ce71eedd9d3b3e3bb',
  '0309_operations_measured_packaging_evidence.sql',
  '52b83a83329d8f4f60e2f0ff539d54849e5e4c69c88ad80917970f880b754da2',
  '0354_operations_sales_shipping_workspace_migration_safety.sql',
  '322e822d66cc6b6e9d4fd9d662fe3e1064db7b9fe08279e7024e9644e422c399',
  'derive_operations_shopify_checkout_rate_source_compat()',
  'derive_operations_shopify_checkout_rate_source_compat_write',
  '35818f8af90aa04cc95a7fecbf10f3af0fcb31f708e14c374db7e4521b01c698',
  '055e248fcf32fa04416ba9048da9d9b261669706c17dbc926206952d214fb13c',
  'e5ad3008d637149bc5e1d86f6d4345c6aa42d50420f0af09afae312f32f8145b',
  '363d0bf6435f60092e96d225d38b01ecb123e9e42b525e3200fd067b7494ec64',
  'b28b6980199f9e2fd9af0e43f84b825570fcdda1bed1b35ba1a0891bb5f65ae0',
  'f0c296dbf7f1d67b8a99e2f98c1b097c54ea876da83a01d7aad3191b4e7c8823',
  'b599b5047d42b8f4e4b1dd29898d7b4d50bb241bdb1e5f031e8c95f5197414f6',
  'ed9536637383e8d5a4a62c2a99ef4daca73b1a746e558e9dc409b2bf19baf29d',
  'ec1e699fff0e0e1e90b6415081c3cb0cb80d36bdd7e0642401c0f32a10174371',
  'df473e7836235c04c828539deb912ecb65c57709b489d07458d09f0b7bbcf490',
  'fde4be4596b4ee46d81af6b2b22bc92548e63a427877e2f1e2f055d212e0d57e',
  'd57e00e735e7bb4e86f6b88827c50360007cccefd98573de58ed3733c889ea38',
  'ab9cfb51412ec44ee6d15d734652036bf56c7a5ffe8e8df418653d9a3310632a',
  'operations_shopify_checkout_rate_control_is_valid(jsonb)',
  'operations_shopify_checkout_rate_control_response_is_valid(jsonb)',
  'validate_operations_shopify_customer_rate_policy_write()',
  'protect_operations_commerce_external_effect_intent()',
  'protect_ops_shopify_cs_mut_authorization()',
  'protect_ops_shopify_cs_attempt_authorization_lock()',
  'protect_ops_shopify_cs_brand_override_update()',
  'operations_shopify_carrier_service_rating_runtime_is_ready(uuid,uuid)',
  'operations_shopify_checkout_rating_channel_is_eligible(text,text,text,text,boolean,boolean,integer)',
  'validate_operations_commerce_variant_pack_mapping()',
  'protect_operations_shopify_checkout_rate_receipt()',
  'validate_op_shopify_checkout_attempt_finalization()',
  'operations_shopify_configs_rate_control_valid',
  'operations_shopify_checkout_rate_control_receipts',
  'operations_shopify_rate_control_receipt_config_fkey',
  'operations_shopify_configs_org_id_account_unique',
  'public.digest(',
  'pg_catalog.to_regprocedure(',
  'pg_catalog.to_regclass(',
  'public.operations_shopify_checkout_rate_control_is_valid(',
]) {
  assert.ok(
    rateControlAttestationSql.includes(fragment),
    `0299 health attestation missing ${fragment}`,
  )
}
for (const fragment of [
  'public.digest(',
  'pg_catalog.to_regprocedure(',
  'pg_catalog.to_regclass(',
]) {
  assert.ok(
    writerContractSql.includes(fragment),
    `Receipt-writer phase SQL missing trusted resolver ${fragment}`,
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
for (const contract of [
  'legacy-writer-compatible',
  'strict-explicit',
]) {
  assert.ok(
    healthSource.includes(`'${contract}'`),
    `0299 health must expose the ${contract} receipt-writer phase`,
  )
}

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

async function receiptWriterContract(pool) {
  const result = await pool.query(
    `SELECT (${writerContractSql}) AS contract`,
  )
  return String(result.rows[0]?.contract || '')
}

async function projectFrozenCommerceContractPredecessor(client) {
  // 0305 is a frozen rollout-contract fixture for the exact 0299-era schema.
  // Later additive migrations legitimately extend the read-lease table, so
  // remove only those post-contract additions inside the caller's rollback
  // transaction before exercising the frozen contraction.
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'operations_commerce_store_sync_read_leases'
         AND column_name = 'history_exclusion_code'
     ) AS applied`,
  )
  if (result.rows[0]?.applied !== true) return
  await client.query(
    `DROP TRIGGER IF EXISTS
       guard_commerce_order_history_lease_exclusion_write
       ON public.operations_commerce_store_sync_read_leases;
     DROP FUNCTION IF EXISTS
       public.guard_commerce_order_history_lease_exclusion();
     ALTER TABLE public.operations_commerce_store_sync_read_leases
       DROP COLUMN history_exclusion_code,
       DROP COLUMN history_excluded_external_order_id,
       DROP COLUMN history_excluded_provider_created_at`,
  )
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

async function rejectCommerceContractPredecessor(
  pool,
  tamperSql,
  expectedError,
  message,
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(tamperSql)
    await projectFrozenCommerceContractPredecessor(client)
    await assert.rejects(
      client.query(futureCommerceRolloutContractMigration),
      expectedError,
      message,
    )
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  const ledger = await pool.query(
    `SELECT count(*)::integer AS count
     FROM public.schema_migrations
     WHERE filename = '0305_operations_commerce_rollout_contract.sql'`,
  )
  assert.equal(
    ledger.rows[0]?.count,
    0,
    `${message}: rejection must not record the 0305 ledger`,
  )
  assert.equal(
    await attestRateControl(pool),
    true,
    `${message}: rollback must restore Release A health`,
  )
}

async function exercise(pool) {
  const notNullConstraintCatalog = await pool.query(
    `SELECT current_setting('server_version_num')::integer
              AS server_version_num,
            (
              SELECT count(*)::integer
              FROM pg_catalog.pg_constraint installed_constraint
              WHERE installed_constraint.conrelid = pg_catalog.to_regclass(
                      'public.operations_shopify_checkout_rate_control_receipts'
                    )
                AND installed_constraint.contype = 'n'
            ) AS not_null_constraint_count`,
  )
  const serverVersionNum = Number(
    notNullConstraintCatalog.rows[0]?.server_version_num,
  )
  const notNullConstraintCount = Number(
    notNullConstraintCatalog.rows[0]?.not_null_constraint_count,
  )
  assert.equal(
    notNullConstraintCount > 0,
    serverVersionNum >= 180_000,
    'Only PostgreSQL 18+ should expose checkout NOT NULL constraint rows',
  )
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
  assert.equal(
    await receiptWriterContract(pool),
    'legacy-writer-compatible',
    'Fresh Release A schema must expose only the exact legacy-writer phase',
  )
  const rollingPreMigrationSafetyClient = await pool.connect()
  try {
    await rollingPreMigrationSafetyClient.query('BEGIN')
    await rollingPreMigrationSafetyClient.query(
      `DELETE FROM public.schema_migrations
       WHERE filename =
         '0354_operations_sales_shipping_workspace_migration_safety.sql'`,
    )
    await rollingPreMigrationSafetyClient.query(
      preMigrationSafetyCarrierRatingFunction,
    )
    // Migration 0299 hardens every audited checkout function after the 0285
    // body is installed. Reapply that exact pre-0354 catalog setting because
    // CREATE OR REPLACE above intentionally reconstructs the older body.
    await rollingPreMigrationSafetyClient.query(
      `ALTER FUNCTION
         public.operations_shopify_carrier_configuration_allows_rating(
           jsonb,
           text
         )
       SET search_path = pg_catalog, public, pg_temp`,
    )
    assert.equal(
      await attestRateControl(rollingPreMigrationSafetyClient),
      true,
      'The exact pre-0354 function and absent ledger must remain rollout-healthy',
    )
    assert.equal(
      await receiptWriterContract(rollingPreMigrationSafetyClient),
      'legacy-writer-compatible',
      'The exact pre-0354 phase must preserve the legacy writer contract',
    )
  } finally {
    await rollingPreMigrationSafetyClient.query('ROLLBACK').catch(() => {})
    rollingPreMigrationSafetyClient.release()
  }
  assert.equal(
    await attestRateControl(pool),
    true,
    'The pre-0354 rolling-health rollback must restore final health',
  )
  await tamperRateControl(
    pool,
    `DELETE FROM public.schema_migrations
     WHERE filename =
       '0354_operations_sales_shipping_workspace_migration_safety.sql'`,
    'The post-0354 carrier-rating body must not pass as a pre-0354 phase',
  )
  const stalePostMigrationLedgerClient = await pool.connect()
  try {
    await stalePostMigrationLedgerClient.query('BEGIN')
    await stalePostMigrationLedgerClient.query(
      preMigrationSafetyCarrierRatingFunction,
    )
    await stalePostMigrationLedgerClient.query(
      `ALTER FUNCTION
         public.operations_shopify_carrier_configuration_allows_rating(
           jsonb,
           text
         )
       SET search_path = pg_catalog, public, pg_temp`,
    )
    assert.equal(
      await attestRateControl(stalePostMigrationLedgerClient),
      false,
      'The pre-0354 body must not pass under the exact post-0354 ledger',
    )
    assert.equal(
      await receiptWriterContract(stalePostMigrationLedgerClient),
      'invalid',
      'A stale post-0354 ledger/body pairing must invalidate the writer phase',
    )
  } finally {
    await stalePostMigrationLedgerClient.query('ROLLBACK').catch(() => {})
    stalePostMigrationLedgerClient.release()
  }
  const rollingPreMigrationStrictClient = await pool.connect()
  try {
    await rollingPreMigrationStrictClient.query('BEGIN')
    await rollingPreMigrationStrictClient.query(
      `DELETE FROM public.schema_migrations
       WHERE filename =
         '0354_operations_sales_shipping_workspace_migration_safety.sql'`,
    )
    await rollingPreMigrationStrictClient.query(
      preMigrationSafetyCarrierRatingFunction,
    )
    await rollingPreMigrationStrictClient.query(
      `ALTER FUNCTION
         public.operations_shopify_carrier_configuration_allows_rating(
           jsonb,
           text
         )
       SET search_path = pg_catalog, public, pg_temp`,
    )
    await projectFrozenCommerceContractPredecessor(
      rollingPreMigrationStrictClient,
    )
    await rollingPreMigrationStrictClient.query(
      futureCommerceRolloutContractMigration,
    )
    await rollingPreMigrationStrictClient.query(
      `INSERT INTO public.schema_migrations (filename, checksum)
       VALUES (
         '0305_operations_commerce_rollout_contract.sql',
         'e5ad3008d637149bc5e1d86f6d4345c6aa42d50420f0af09afae312f32f8145b'
       )`,
    )
    assert.equal(
      await attestRateControl(rollingPreMigrationStrictClient),
      true,
      'The exact pre-0354 strict 0305 phase must remain rollout-healthy',
    )
    assert.equal(
      await receiptWriterContract(rollingPreMigrationStrictClient),
      'strict-explicit',
      'The exact pre-0354 strict 0305 phase must expose the strict writer contract',
    )
  } finally {
    await rollingPreMigrationStrictClient.query('ROLLBACK').catch(() => {})
    rollingPreMigrationStrictClient.release()
  }
  const checksumFallthroughClient = await pool.connect()
  try {
    await checksumFallthroughClient.query('BEGIN')
    await checksumFallthroughClient.query(
      `UPDATE public.schema_migrations
       SET checksum = repeat('0', 64)
       WHERE filename =
         '0354_operations_sales_shipping_workspace_migration_safety.sql'`,
    )
    await checksumFallthroughClient.query(
      preMigrationSafetyCarrierRatingFunction,
    )
    await checksumFallthroughClient.query(
      `ALTER FUNCTION
         public.operations_shopify_carrier_configuration_allows_rating(
           jsonb,
           text
         )
       SET search_path = pg_catalog, public, pg_temp`,
    )
    assert.equal(
      await attestRateControl(checksumFallthroughClient),
      false,
      'A wrong 0354 checksum must not fall through to pre-0354 function health',
    )
    assert.equal(
      await receiptWriterContract(checksumFallthroughClient),
      'invalid',
      'A wrong 0354 checksum must invalidate the exposed writer phase',
    )
  } finally {
    await checksumFallthroughClient.query('ROLLBACK').catch(() => {})
    checksumFallthroughClient.release()
  }
  assert.equal(
    await attestRateControl(pool),
    true,
    'The 0354 checksum-fallthrough rollback must restore final health',
  )
  const attackerClient = await pool.connect()
  try {
    await attackerClient.query('BEGIN')
    await attackerClient.query(
      `CREATE SCHEMA checkout_rate_control_attacker;
       CREATE FUNCTION checkout_rate_control_attacker.digest(
         payload bytea,
         algorithm text
       ) RETURNS bytea
       LANGUAGE sql IMMUTABLE STRICT
       AS $$
         SELECT pg_catalog.convert_to('attacker-bytea-digest', 'UTF8')
       $$;
       CREATE FUNCTION checkout_rate_control_attacker.digest(
         payload text,
         algorithm text
       ) RETURNS bytea
       LANGUAGE sql IMMUTABLE STRICT
       AS $$
         SELECT pg_catalog.convert_to('attacker-text-digest', 'UTF8')
       $$;
       CREATE FUNCTION checkout_rate_control_attacker.encode(
         payload bytea,
         format_name text
       ) RETURNS text
       LANGUAGE sql IMMUTABLE STRICT
       AS $$ SELECT 'attacker-encode'::text $$;
       CREATE FUNCTION checkout_rate_control_attacker.convert_to(
         payload text,
         encoding_name pg_catalog.name
       ) RETURNS bytea
       LANGUAGE sql IMMUTABLE STRICT
       AS $$ SELECT pg_catalog.convert_to('attacker-convert', 'UTF8') $$;
       CREATE FUNCTION checkout_rate_control_attacker.to_regprocedure(
         object_name text
       ) RETURNS pg_catalog.regprocedure
       LANGUAGE sql IMMUTABLE STRICT
       AS $$ SELECT NULL::pg_catalog.regprocedure $$;
       CREATE FUNCTION checkout_rate_control_attacker.to_regclass(
         object_name text
       ) RETURNS pg_catalog.regclass
       LANGUAGE sql IMMUTABLE STRICT
       AS $$ SELECT NULL::pg_catalog.regclass $$;
       CREATE FUNCTION checkout_rate_control_attacker.jsonb_typeof(
         payload jsonb
       ) RETURNS text
       LANGUAGE sql IMMUTABLE STRICT
       AS $$ SELECT 'array'::text $$`,
    )
    await attackerClient.query(`SET LOCAL session_replication_role = 'replica'`)
    await attackerClient.query(
      `INSERT INTO public.operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation
       ) VALUES (
         '29991000-0000-4000-8000-000000000001'::uuid,
         'gia2999101',
         '29991000-0000-4000-8000-000000000002'::uuid,
         'shopify', 'commerce', 'production',
         'Attacker namespace health fixture', 'active',
         '{"accountName":"Attacker namespace health fixture"}'::jsonb,
         'attacker-namespace-health.myshopify.com', 1
       )`,
    )
    await attackerClient.query(
      `INSERT INTO public.operations_shopify_carrier_service_configs (
         id, global_id, organization_id, integration_account_id,
         warehouse_id, registration_state, credential_generation,
         activation_revision, callback_token_version, callback_token_hash,
         policy_revision, policy_hash, policy_snapshot,
         inventory_max_age_seconds, quote_ttl_seconds,
         order_reconciliation_window_seconds, algorithm_version, row_version
       ) VALUES (
         '29991000-0000-4000-8000-000000000003'::uuid,
         'gscf2999101',
         '29991000-0000-4000-8000-000000000002'::uuid,
         '29991000-0000-4000-8000-000000000001'::uuid,
         '29991000-0000-4000-8000-000000000004'::uuid,
         'disabled', 1, 1, 1, repeat('a', 64), 1, repeat('b', 64),
         $1::jsonb, 900, 900, 86400,
         'attacker-namespace-health-v1', 1
       )`,
      [JSON.stringify(explicitRateControlPolicy)],
    )
    await attackerClient.query(`SET LOCAL session_replication_role = 'origin'`)
    assert.equal(
      await attestRateControl(attackerClient),
      true,
      'The valid public config fixture must preserve health before attacker-first resolution',
    )
    await attackerClient.query(
      `SET LOCAL search_path =
         checkout_rate_control_attacker, public, pg_catalog`,
    )
    const attackerResolution = await attackerClient.query(
      `SELECT
         encode(
           digest(convert_to('probe', 'UTF8'), 'sha256'),
           'hex'
         ) AS digest_result,
         to_regprocedure(
           'public.operations_shopify_checkout_rate_control_is_valid(jsonb)'
         ) IS NULL AS procedure_resolver_shadowed,
         to_regclass(
           'public.operations_shopify_carrier_service_configs'
         ) IS NULL AS class_resolver_shadowed`,
    )
    assert.deepEqual(
      attackerResolution.rows[0],
      {
        digest_result: 'attacker-encode',
        procedure_resolver_shadowed: true,
        class_resolver_shadowed: true,
      },
      'The attacker-first fixture must intercept unqualified hashes and resolvers',
    )
    assert.equal(
      await attestRateControl(attackerClient),
      true,
      'Attacker-first digest overloads and resolvers must not influence exact health',
    )
    assert.equal(
      await receiptWriterContract(attackerClient),
      'legacy-writer-compatible',
      'Attacker-first hashes and resolvers must not spoof the Release A writer phase',
    )
    await attackerClient.query(
      `CREATE FUNCTION checkout_rate_control_attacker.
         operations_shopify_checkout_rate_control_is_valid(input jsonb)
       RETURNS boolean
       LANGUAGE sql IMMUTABLE STRICT
       AS $$ SELECT false $$`,
    )
    const attackerValidatorResolution = await attackerClient.query(
      `SELECT operations_shopify_checkout_rate_control_is_valid(
         $1::jsonb -> 'checkoutRateControl'
       ) IS FALSE AS final_validator_shadowed`,
      [JSON.stringify(explicitRateControlPolicy)],
    )
    assert.deepEqual(
      attackerValidatorResolution.rows[0],
      { final_validator_shadowed: true },
      'The attacker-first fixture must intercept the unqualified final validator',
    )
    assert.equal(
      await attestRateControl(attackerClient),
      true,
      'Attacker-first final-validator shadowing must not influence exact health',
    )
    assert.equal(
      await receiptWriterContract(attackerClient),
      'legacy-writer-compatible',
      'Attacker-first final-validator shadowing must not spoof the Release A writer phase',
    )
    await attackerClient.query(
      `CREATE TABLE checkout_rate_control_attacker.index_name_probe (
         id integer NOT NULL
       );
       CREATE INDEX operations_shopify_configs_org_id_account_unique
         ON checkout_rate_control_attacker.index_name_probe (id)`,
    )
    assert.equal(
      await attestRateControl(attackerClient),
      true,
      'An unrelated foreign-schema index with the canonical config index name must not influence exact health',
    )
    assert.equal(
      await receiptWriterContract(attackerClient),
      'legacy-writer-compatible',
      'An unrelated foreign-schema index name must not invalidate the Release A writer phase',
    )
    const hardenedRatingSemantics = await attackerClient.query(
      `SELECT public.operations_shopify_carrier_configuration_allows_rating(
         '{"allowedCapabilities":{"production_rate":true}}'::jsonb,
         'production'
       ) AS allowed`,
    )
    assert.deepEqual(
      hardenedRatingSemantics.rows[0],
      { allowed: false },
      'The migrated carrier-rating function must ignore an attacker-first jsonb_typeof overload',
    )
    await attackerClient.query(
      `ALTER FUNCTION
         public.operations_shopify_carrier_configuration_allows_rating(
           jsonb,
           text
         )
       RESET search_path`,
    )
    assert.equal(
      await attestRateControl(attackerClient),
      false,
      'Removing the migrated carrier-rating search_path must fail exact health',
    )
    const unhardenedRatingSemantics = await attackerClient.query(
      `SELECT public.operations_shopify_carrier_configuration_allows_rating(
         '{"allowedCapabilities":{"production_rate":true}}'::jsonb,
         'production'
       ) AS allowed`,
    )
    assert.deepEqual(
      unhardenedRatingSemantics.rows[0],
      { allowed: true },
      'The attacker fixture must prove why the carrier-rating search_path is pinned',
    )
  } finally {
    await attackerClient.query('ROLLBACK').catch(() => {})
    attackerClient.release()
  }
  assert.equal(
    await attestRateControl(pool),
    true,
    'Attacker-first namespace rollback must preserve exact health',
  )
  const legacyActivationConstraint = await pool.query(
    `SELECT count(*)::integer AS count
     FROM pg_catalog.pg_constraint
     WHERE conrelid = pg_catalog.to_regclass(
       'public.operations_shopify_checkout_rate_receipts'
     )
       AND conname =
         'operations_shopify_checkout_rate_receipt_activation_state_check'`,
  )
  assert.equal(
    legacyActivationConstraint.rows[0]?.count,
    0,
    '0299 must remove the legacy Shadow/Active-only receipt constraint',
  )

  const rollingHealthMarkers = await pool.query(
    `SELECT
       regexp_replace(
         pg_get_functiondef(
           'public.derive_operations_legacy_shopify_carrier_selection_key()'::regprocedure
         ),
         '[[:space:]]+', ' ', 'g'
       ) LIKE '%carrier_integration.environment = CASE receipt.activation_state%'
         AS legacy_selection,
       regexp_replace(
         pg_get_functiondef(
           'public.validate_one_off_rate_selection_key()'::regprocedure
         ),
         '[[:space:]]+', ' ', 'g'
       ) LIKE '%carrier_integration.environment = CASE receipt.activation_state%'
         AS one_off_selection,
       regexp_replace(
         pg_get_functiondef(
           'public.protect_op_shopify_checkout_provider_attempt()'::regprocedure
         ),
         '[[:space:]]+', ' ', 'g'
       ) LIKE '%carrier_integration.environment = CASE receipt.activation_state%'
         AS provider_attempt,
       regexp_replace(
         pg_get_functiondef(
           'public.validate_op_shopify_checkout_attempt_finalization()'::regprocedure
         ),
         '[[:space:]]+', ' ', 'g'
       ) LIKE '%carrier_integration.environment = CASE NEW.activation_state%'
         AS attempt_finalization`,
  )
  assert.deepEqual(
    rollingHealthMarkers.rows[0],
    {
      legacy_selection: true,
      one_off_selection: true,
      provider_attempt: true,
      attempt_finalization: true,
    },
    '0299 must preserve every exact legacy health marker while executable source uses rate_source',
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
    `UPDATE schema_migrations
     SET checksum = repeat('0', 64)
     WHERE filename = '0309_operations_measured_packaging_evidence.sql'`,
    'A changed 0309 measured-packaging phase checksum must fail health',
  )
  await tamperRateControl(
    pool,
    `UPDATE schema_migrations
     SET checksum = repeat('0', 64)
     WHERE filename =
       '0354_operations_sales_shipping_workspace_migration_safety.sql'`,
    'A changed 0354 migration checksum must fail health',
  )
  await tamperRateControl(
    pool,
    `DELETE FROM schema_migrations
     WHERE filename = '0309_operations_measured_packaging_evidence.sql'`,
    '0354 health must require its exact 0309 predecessor ledger',
  )
  await tamperRateControl(
    pool,
    `UPDATE schema_migrations
     SET checksum = repeat('0', 64)
     WHERE filename =
       '0317_operations_shopify_carrier_service_simulation_runtime_readiness.sql'`,
    'A changed 0317 simulation-readiness checksum must fail health',
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
       public.operations_shopify_cs_config_has_exact_finalization_link(
         requested_organization_id uuid,
         requested_config_id uuid,
         requested_integration_account_id uuid,
         requested_from_row_version bigint,
         requested_to_row_version bigint,
         requested_from_registration_state text,
         requested_to_registration_state text,
         requested_from_service_gid text,
         requested_to_service_gid text,
         requested_from_activation_revision integer,
         requested_to_activation_revision integer,
         requested_credential_generation integer
       )
     RETURNS boolean LANGUAGE sql STABLE
     AS $$ SELECT true $$`,
    'A weakened exact config-finalization helper must fail health',
  )
  await tamperRateControl(
    pool,
    `CREATE OR REPLACE FUNCTION
       protect_ops_shopify_cs_attempt_authorization_lock()
     RETURNS trigger LANGUAGE plpgsql
     AS $$ BEGIN RETURN NEW; END $$`,
    'A removed attempt-side authorization lock must fail health',
  )
  await tamperRateControl(
    pool,
    `CREATE OR REPLACE FUNCTION
       protect_ops_shopify_cs_brand_override_update()
     RETURNS trigger LANGUAGE plpgsql
     AS $$ BEGIN RETURN NEW; END $$`,
    'A removed config-side brand authorization lock must fail health',
  )
  await tamperRateControl(
    pool,
    `CREATE OR REPLACE FUNCTION
       derive_operations_shopify_checkout_rate_source_compat()
     RETURNS trigger LANGUAGE plpgsql
     AS $$ BEGIN RETURN NEW; END $$`,
    'A weakened legacy receipt-writer bridge must fail health',
  )
  await tamperRateControl(
    pool,
    `CREATE OR REPLACE FUNCTION
       validate_op_shopify_checkout_attempt_finalization()
     RETURNS trigger LANGUAGE plpgsql
     AS $$ BEGIN RETURN NEW; END $$`,
    'A weakened rate-source finalization fence must fail health',
  )
  await tamperRateControl(
    pool,
    `ALTER TABLE operations_shopify_checkout_rate_receipts
       DISABLE TRIGGER
         derive_operations_shopify_checkout_rate_source_compat_write`,
    'A disabled legacy receipt-writer bridge must fail health',
  )
  await pool.query('BEGIN')
  try {
    await pool.query(
      `CREATE TABLE checkout_health_shadow_bridge_binding (
         organization_id uuid,
         integration_account_id uuid,
         config_id uuid,
         config_row_version bigint,
         credential_generation integer,
         policy_revision bigint,
         policy_hash text,
         activation_state text,
         rate_source text
       );
       CREATE TRIGGER checkout_health_shadow_bridge_binding_write
       BEFORE INSERT ON checkout_health_shadow_bridge_binding
       FOR EACH ROW EXECUTE FUNCTION
         derive_operations_shopify_checkout_rate_source_compat()`,
    )
    assert.equal(
      await attestRateControl(pool),
      false,
      'An extra bridge binding must fail exact health',
    )
    assert.equal(
      await receiptWriterContract(pool),
      'invalid',
      'An extra bridge binding must invalidate the exposed writer phase',
    )
    await projectFrozenCommerceContractPredecessor(pool)
    await assert.rejects(
      pool.query(futureCommerceRolloutContractMigration),
      /exact receipt-writer trigger/u,
      '0305 must reject an extra bridge binding before contraction',
    )
  } finally {
    await pool.query('ROLLBACK')
  }
  assert.equal(
    await attestRateControl(pool),
    true,
    'Extra bridge binding rollback must restore exact health',
  )
  await tamperRateControl(
    pool,
    `DROP TRIGGER derive_operations_shopify_checkout_rate_source_compat_write
       ON operations_shopify_checkout_rate_receipts;
     DROP FUNCTION derive_operations_shopify_checkout_rate_source_compat()`,
    'The bridge must not disappear before the exact contract migration',
  )
  const rejectedContractClient = await pool.connect()
  try {
    await rejectedContractClient.query('BEGIN')
    await rejectedContractClient.query(
      `CREATE OR REPLACE FUNCTION
         derive_operations_shopify_checkout_rate_source_compat()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN NEW; END $$`,
    )
    await projectFrozenCommerceContractPredecessor(rejectedContractClient)
    await assert.rejects(
      rejectedContractClient.query(futureCommerceRolloutContractMigration),
      /requires the exact receipt-writer bridge/u,
      'The frozen 0305 contract must reject a drifted compatibility bridge before dropping anything',
    )
  } finally {
    await rejectedContractClient.query('ROLLBACK').catch(() => {})
    rejectedContractClient.release()
  }
  assert.equal(
    await attestRateControl(pool),
    true,
    'Rejected 0305 contract bytes must roll back without changing Release 1 health',
  )
  await rejectCommerceContractPredecessor(
    pool,
    `UPDATE public.schema_migrations
     SET checksum = repeat('0', 64)
     WHERE filename = '0298_operations_commerce_store_sync_controls.sql'`,
    /requires exact 0298 and 0299 predecessors/u,
    '0305 must reject a changed 0298 predecessor checksum',
  )
  await rejectCommerceContractPredecessor(
    pool,
    `UPDATE public.schema_migrations
     SET checksum = repeat('0', 64)
     WHERE filename = '0299_operations_shopify_checkout_rate_control.sql'`,
    /requires exact 0298 and 0299 predecessors/u,
    '0305 must reject a changed 0299 predecessor checksum',
  )
  await rejectCommerceContractPredecessor(
    pool,
    `ALTER TABLE public.operations_commerce_intake_read_intents
       ALTER COLUMN provider_read_authority DROP NOT NULL`,
    /requires the exact expanded column catalog/u,
    '0305 must reject weakened provider-read authority nullability',
  )
  await rejectCommerceContractPredecessor(
    pool,
    `ALTER TABLE public.operations_commerce_intake_read_intents
       ALTER COLUMN provider_read_authority
       SET DEFAULT 'manual_read_only'`,
    /requires the exact expanded column catalog/u,
    '0305 must reject a changed provider-read authority default',
  )
  await rejectCommerceContractPredecessor(
    pool,
    `ALTER TABLE public.operations_commerce_intake_read_intents
       ADD CONSTRAINT checkout_health_extra_authority_check
       CHECK (provider_read_authority = 'manual_read_only')`,
    /requires the exact authority constraints/u,
    '0305 must reject an extra authority constraint',
  )
  await rejectCommerceContractPredecessor(
    pool,
    `CREATE SCHEMA checkout_health_operator_shadow;
     CREATE FUNCTION checkout_health_operator_shadow.text_eq(text, text)
     RETURNS boolean LANGUAGE sql IMMUTABLE
     AS $$ SELECT true $$;
     CREATE OPERATOR checkout_health_operator_shadow.= (
       LEFTARG = text,
       RIGHTARG = text,
       FUNCTION = checkout_health_operator_shadow.text_eq
     );
     SET LOCAL search_path =
       checkout_health_operator_shadow, public, pg_catalog, pg_temp;
     ALTER TABLE public.operations_commerce_store_sync_controls
       DROP CONSTRAINT
         operations_commerce_store_sync_controls_desired_state_check;
     ALTER TABLE public.operations_commerce_store_sync_controls
       ADD CONSTRAINT
         operations_commerce_store_sync_controls_desired_state_check
       CHECK (desired_state IN ('running', 'paused'))`,
    /requires exact CHECK operator bindings/u,
    '0305 must reject a byte-identical CHECK rebound to an attacker operator',
  )
  await rejectCommerceContractPredecessor(
    pool,
    `CREATE OR REPLACE FUNCTION
       public.validate_operations_shopify_checkout_rate_control_config()
     RETURNS trigger LANGUAGE plpgsql
     AS $$ BEGIN RETURN NEW; END $$`,
    /requires the exact legacy config-writer bridge/u,
    '0305 must reject a weakened legacy config-writer bridge body',
  )
  await rejectCommerceContractPredecessor(
    pool,
    `ALTER TABLE public.operations_shopify_carrier_service_configs
       DISABLE TRIGGER
         validate_operations_shopify_checkout_rate_control_config_write`,
    /requires the exact config-writer trigger/u,
    '0305 must reject a disabled legacy config-writer bridge',
  )
  await rejectCommerceContractPredecessor(
    pool,
    `DROP TRIGGER
       validate_operations_shopify_checkout_rate_control_config_write
       ON public.operations_shopify_carrier_service_configs;
     CREATE TRIGGER
       validate_operations_shopify_checkout_rate_control_config_write
       BEFORE INSERT OR UPDATE OF policy_snapshot, integration_account_id
       ON public.operations_shopify_carrier_service_configs
       FOR EACH ROW EXECUTE FUNCTION
         public.validate_operations_shopify_carrier_service_config()`,
    /requires the exact config-writer trigger/u,
    '0305 must reject a same-name config trigger rebound to another function',
  )
  await rejectCommerceContractPredecessor(
    pool,
    `CREATE TEMP TABLE checkout_health_extra_config_binding (
       organization_id uuid,
       integration_account_id uuid,
       policy_snapshot jsonb,
       policy_hash text
     );
     CREATE TRIGGER checkout_health_extra_config_binding_write
       BEFORE INSERT ON checkout_health_extra_config_binding
       FOR EACH ROW EXECUTE FUNCTION
         public.validate_operations_shopify_checkout_rate_control_config()`,
    /requires the exact config-writer trigger/u,
    '0305 must reject an extra all-schema config-writer binding',
  )
  const contractClient = await pool.connect()
  try {
    await contractClient.query('BEGIN')
    // db-migrate executes the exact SQL before recording its checksum in the
    // same transaction. Keep this order identical to the production runner.
    await projectFrozenCommerceContractPredecessor(contractClient)
    await contractClient.query(futureCommerceRolloutContractMigration)
    await contractClient.query(
      `INSERT INTO public.schema_migrations (filename, checksum)
       VALUES (
         '0305_operations_commerce_rollout_contract.sql',
         'e5ad3008d637149bc5e1d86f6d4345c6aa42d50420f0af09afae312f32f8145b'
       )`,
    )
    const contractedDefaults = await contractClient.query(
      `SELECT count(*)::integer AS authority_columns,
              count(*) FILTER (
                WHERE column_default IS NULL
              )::integer AS defaults_removed
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN (
           'operations_commerce_intake_read_intents',
           'operations_commerce_product_image_observation_sets',
           'operations_commerce_product_image_import_jobs'
         )
         AND column_name = 'provider_read_authority'`,
    )
    assert.deepEqual(
      contractedDefaults.rows[0],
      { authority_columns: 3, defaults_removed: 3 },
      'The exact combined 0305 bytes must contract all Store sync writer defaults',
    )
    assert.equal(
      await attestRateControl(contractClient),
      true,
      'The exact 0305 ledger and absent bridge must remain rollout-healthy',
    )
    assert.equal(
      await receiptWriterContract(contractClient),
      'strict-explicit',
      'The exact 0305 ledger must expose only the strict writer phase',
    )

    await contractClient.query(`SET LOCAL session_replication_role = 'replica'`)
    await contractClient.query(
      `INSERT INTO public.operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision, reason
       ) VALUES (
         '30500000-0000-4000-8000-000000000002'::uuid,
         '30500000-0000-4000-8000-000000000009'::uuid,
         'shadow', 1, 'Strict legacy config rejection fixture'
       )`,
    )
    await contractClient.query(
      `INSERT INTO public.operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation
       ) VALUES
       (
         '30500000-0000-4000-8000-000000000001'::uuid,
         'gia3050001',
         '30500000-0000-4000-8000-000000000002'::uuid,
         'shopify', 'commerce', 'production',
         'Strict legacy update fixture', 'active',
         '{"accountName":"Strict legacy update fixture"}'::jsonb,
         'strict-legacy-update.myshopify.com', 1
       ),
       (
         '30500000-0000-4000-8000-000000000005'::uuid,
         'gia3050002',
         '30500000-0000-4000-8000-000000000002'::uuid,
         'shopify', 'commerce', 'sandbox',
         'Strict legacy insert fixture', 'active',
         '{"accountName":"Strict legacy insert fixture"}'::jsonb,
         'strict-legacy-insert.myshopify.com', 1
       )`,
    )
    await contractClient.query(
      `INSERT INTO public.operations_shopify_carrier_service_configs (
         id, global_id, organization_id, integration_account_id,
         warehouse_id, registration_state, credential_generation,
         activation_revision, callback_token_version, callback_token_hash,
         policy_revision, policy_hash, policy_snapshot,
         inventory_max_age_seconds, quote_ttl_seconds,
         order_reconciliation_window_seconds, algorithm_version, row_version
       ) VALUES (
         '30500000-0000-4000-8000-000000000003'::uuid,
         'gscf3050001',
         '30500000-0000-4000-8000-000000000002'::uuid,
         '30500000-0000-4000-8000-000000000001'::uuid,
         '30500000-0000-4000-8000-000000000004'::uuid,
         'unconfigured', 1, 1, 1, repeat('a', 64), 1,
         pg_catalog.encode(
           public.digest(
             public.canonical_operations_shopify_checkout_policy_jsonb(
               $1::jsonb
             ),
             'sha256'
           ),
           'hex'
         ),
         $1::jsonb, 900, 900, 86400,
         'strict-explicit-seed-v1', 1
       )`,
      [JSON.stringify(explicitRateControlPolicy)],
    )
    await contractClient.query(`SET LOCAL session_replication_role = 'origin'`)

    await contractClient.query('SAVEPOINT strict_legacy_config_insert')
    try {
      await assert.rejects(
        contractClient.query(
          `INSERT INTO public.operations_shopify_carrier_service_configs (
             organization_id, integration_account_id, warehouse_id,
             registration_state, credential_generation,
             activation_revision, callback_token_version,
             callback_token_hash, policy_revision, policy_hash,
             policy_snapshot, inventory_max_age_seconds, quote_ttl_seconds,
             order_reconciliation_window_seconds, algorithm_version,
             created_by, updated_by
           ) VALUES (
             '30500000-0000-4000-8000-000000000002'::uuid,
             '30500000-0000-4000-8000-000000000005'::uuid,
             '30500000-0000-4000-8000-000000000004'::uuid,
             'unconfigured', 1, 1, 1, repeat('b', 64), 1,
             pg_catalog.encode(
               public.digest(
                 public.canonical_operations_shopify_checkout_policy_jsonb(
                   $1::jsonb
                 ),
                 'sha256'
               ),
               'hex'
             ),
             $1::jsonb, 900, 900, 86400,
             'legacy-14a-config-insert-v1', NULL, NULL
           )`,
          [JSON.stringify(legacy14aPolicy)],
        ),
        /operations_shopify_configs_rate_control_valid/u,
        'Strict 0305 must reject an old-14a config INSERT that omits checkoutRateControl',
      )
    } finally {
      await contractClient.query(
        'ROLLBACK TO SAVEPOINT strict_legacy_config_insert',
      )
      await contractClient.query('RELEASE SAVEPOINT strict_legacy_config_insert')
    }

    await contractClient.query('SAVEPOINT strict_legacy_config_update')
    try {
      await assert.rejects(
        contractClient.query(
          `UPDATE public.operations_shopify_carrier_service_configs
           SET warehouse_id =
                 '30500000-0000-4000-8000-000000000004'::uuid,
               registration_state = 'unconfigured',
               service_gid = NULL,
               registered_service_name = NULL,
               credential_generation = 1,
               activation_revision = 1,
               callback_token_version = 1,
               callback_token_hash = repeat('c', 64),
               policy_revision = 2,
               policy_hash = pg_catalog.encode(
                 public.digest(
                   public.canonical_operations_shopify_checkout_policy_jsonb(
                     $1::jsonb
                   ),
                   'sha256'
                 ),
                 'hex'
               ),
               policy_snapshot = $1::jsonb,
               inventory_max_age_seconds = 900,
               quote_ttl_seconds = 900,
               order_reconciliation_window_seconds = 86400,
               algorithm_version = 'legacy-14a-config-update-v1',
               last_error_code = NULL,
               row_version = row_version + 1,
               updated_by = NULL,
               updated_at = pg_catalog.now()
           WHERE organization_id =
                   '30500000-0000-4000-8000-000000000002'::uuid
             AND id = '30500000-0000-4000-8000-000000000003'::uuid`,
          [JSON.stringify(legacy14aPolicy)],
        ),
        /operations_shopify_configs_rate_control_valid/u,
        'Strict 0305 must reject an old-14a config UPDATE that omits checkoutRateControl',
      )
    } finally {
      await contractClient.query(
        'ROLLBACK TO SAVEPOINT strict_legacy_config_update',
      )
      await contractClient.query('RELEASE SAVEPOINT strict_legacy_config_update')
    }
    const strictLegacyWriteState = await contractClient.query(
      `SELECT
         (
           SELECT pg_catalog.count(*)::integer
           FROM public.operations_shopify_carrier_service_configs
           WHERE organization_id =
                   '30500000-0000-4000-8000-000000000002'::uuid
             AND integration_account_id =
                   '30500000-0000-4000-8000-000000000005'::uuid
         ) AS inserted_count,
         (
           SELECT policy_snapshot ? 'checkoutRateControl'
           FROM public.operations_shopify_carrier_service_configs
           WHERE organization_id =
                   '30500000-0000-4000-8000-000000000002'::uuid
             AND id = '30500000-0000-4000-8000-000000000003'::uuid
         ) AS update_control_preserved`,
    )
    assert.deepEqual(
      strictLegacyWriteState.rows[0],
      { inserted_count: 0, update_control_preserved: true },
      'Rejected old-14a config writes must leave the strict saved rows unchanged',
    )
    assert.equal(
      await attestRateControl(contractClient),
      true,
      'Rejected old-14a config writes must preserve exact strict health',
    )
    assert.equal(
      await receiptWriterContract(contractClient),
      'strict-explicit',
      'Rejected old-14a config writes must not change the strict writer phase',
    )
  } finally {
    await contractClient.query('ROLLBACK').catch(() => {})
    contractClient.release()
  }
  assert.equal(
    await attestRateControl(pool),
    true,
    'The 0305 transition rollback must restore the exact bridge',
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
  await tamperRateControl(
    pool,
    `ALTER TABLE operations_shopify_carrier_service_configs
       DISABLE TRIGGER protect_ops_shopify_cs_brand_override_write`,
    'A disabled brand-override lock trigger must fail health',
  )
  await tamperRateControl(
    pool,
    `CREATE TABLE checkout_health_extra_trigger_target (id integer);
     CREATE TRIGGER protect_ops_shopify_cs_brand_override_write
     BEFORE INSERT ON checkout_health_extra_trigger_target
     FOR EACH ROW EXECUTE FUNCTION
       protect_ops_shopify_cs_brand_override_update()`,
    'An extra binding to an affected 0299 trigger function must fail health',
  )
  await tamperRateControl(
    pool,
    `ALTER TABLE operations_shopify_checkout_rate_control_receipts
       ADD CONSTRAINT checkout_health_extra_receipt_check CHECK (false)`,
    'An extra constraint on the 0299 command receipt table must fail health',
  )
  await tamperRateControl(
    pool,
    `ALTER TABLE operations_shopify_checkout_rate_receipts
       ADD CONSTRAINT checkout_health_extra_source_check
       CHECK (rate_source = 'sandbox')`,
    'An extra rate-source constraint on the legacy receipt table must fail health',
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
      disposablePostgresImage,
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
