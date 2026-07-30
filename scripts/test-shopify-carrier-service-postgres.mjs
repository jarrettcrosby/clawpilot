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
const REQUIRED_APPLIED_MIGRATIONS = [
  '0148_operations_commerce_external_effects.sql',
  '0149_operations_shopify_checkout_rating.sql',
  '0150_operations_shopify_carrier_service_mutation_authorization.sql',
  '0151_operations_product_pack_management_hardening.sql',
]
const TARGET_MIGRATION =
  '0156_operations_shopify_carrier_service_active_authorization.sql'
const RECEIPT_REUSE_MIGRATION =
  '0157_operations_shopify_checkout_receipt_reuse.sql'
const CURRENT_ISSUE_INDEX_MIGRATION =
  '0158_operations_commerce_current_issue_index.sql'
const TRACKED_MIGRATIONS = [
  ...REQUIRED_APPLIED_MIGRATIONS,
  TARGET_MIGRATION,
  RECEIPT_REUSE_MIGRATION,
  CURRENT_ISSUE_INDEX_MIGRATION,
]
const LEGACY_PROBE_GLOBAL_ID = 'gsca9999999'
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
    [TRACKED_MIGRATIONS],
  )
  return result.rows.map((row) => row.filename)
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

async function activeAuthorizationObjectState(client) {
  const columns = await client.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name =
         'operations_shopify_carrier_service_mutation_authorizations'
       AND column_name = ANY($1::text[])
     ORDER BY column_name`,
    [[
      'provider_write_activation_revision',
      'simulation_activation_revision',
    ]],
  )
  const constraints = await client.query(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     JOIN pg_class relation ON relation.oid = c.conrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname =
         'operations_shopify_carrier_service_mutation_authorizations'
       AND c.conname = ANY($1::text[])
     ORDER BY c.conname`,
    [[
      'ops_shopify_cs_mut_auth_sim_revision_valid',
      'ops_shopify_cs_mut_auth_write_revision_valid',
    ]],
  )
  const triggers = await client.query(
    `SELECT trigger.tgname,
       pg_get_triggerdef(trigger.oid) AS definition
     FROM pg_trigger trigger
     JOIN pg_class relation ON relation.oid = trigger.tgrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname =
         'operations_shopify_carrier_service_mutation_authorizations'
       AND trigger.tgname =
         'protect_ops_shopify_cs_mut_auth_write'
       AND NOT trigger.tgisinternal
     ORDER BY trigger.tgname`,
  )
  const functions = await client.query(
    `SELECT procedure.proname,
       pg_get_functiondef(procedure.oid) AS definition
     FROM pg_proc procedure
     JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure.proname = ANY($1::text[])
     ORDER BY procedure.proname`,
    [[
      'operations_shopify_carrier_service_config_is_ready',
      'operations_shopify_cs_active_authorization_fence_hash',
      'operations_shopify_cs_config_has_exact_finalization_link',
      'protect_ops_shopify_cs_config_mut_link',
      'protect_ops_shopify_cs_mut_attempt',
      'protect_ops_shopify_cs_mut_authorization',
      'validate_operations_shopify_carrier_service_config',
      'validate_operations_shopify_carrier_service_config_ready',
    ]],
  )
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    triggers: triggers.rows,
    functions: functions.rows,
  }
}

async function authorizationDataState(client) {
  const result = await client.query(
    `SELECT count(*)::text AS row_count,
       count(*) FILTER (
         WHERE global_id = $1
       )::text AS legacy_probe_count
     FROM operations_shopify_carrier_service_mutation_authorizations`,
    [LEGACY_PROBE_GLOBAL_ID],
  )
  return result.rows[0]
}

async function assertActiveAuthorizationUpgrade(client) {
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL statement_timeout = '120s'`)
    await client.query(`SET LOCAL lock_timeout = '15s'`)
    const foreignKeys = await client.query(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE table_schema = 'public'
         AND table_name =
           'operations_shopify_carrier_service_mutation_authorizations'
         AND constraint_type = 'FOREIGN KEY'`,
    )
    await client.query(
      `DROP TRIGGER IF EXISTS
         protect_ops_shopify_cs_mut_auth_write
       ON operations_shopify_carrier_service_mutation_authorizations`,
    )
    for (const row of foreignKeys.rows) {
      await client.query(
        `ALTER TABLE
           operations_shopify_carrier_service_mutation_authorizations
         DROP CONSTRAINT ${quoteIdentifier(row.constraint_name)}`,
      )
    }
    await client.query(
      `INSERT INTO
         operations_shopify_carrier_service_mutation_authorizations (
           global_id, organization_id, integration_account_id, config_id,
           simulation_effect_id, operation, account_environment,
           credential_generation, config_row_version, activation_state,
           activation_revision, aggregate_hash, request_hash,
           expected_service_gid, confirmation_hash,
           confirmation_statement_version, idempotency_key,
           authorized_by, authorized_role, expires_at
         ) VALUES (
           $1,
           '10000000-0000-4000-8000-000000000001'::uuid,
           '10000000-0000-4000-8000-000000000002'::uuid,
           '10000000-0000-4000-8000-000000000003'::uuid,
           '10000000-0000-4000-8000-000000000004'::uuid,
           'create', 'sandbox', 1, 0, 'shadow', 7,
           repeat('a', 64), repeat('b', 64), NULL, repeat('c', 64),
           'shopify-carrier-service-sandbox-provider-write-v1',
           'legacy-upgrade-test', 'legacy@example.test', 'owner',
           now() + interval '2 minutes'
         )`,
      [LEGACY_PROBE_GLOBAL_ID],
    )

    await client.query(migrationSql(TARGET_MIGRATION))
    await client.query(migrationSql(RECEIPT_REUSE_MIGRATION))
    await client.query(migrationSql(CURRENT_ISSUE_INDEX_MIGRATION))
    const upgraded = await client.query(
      `SELECT
         activation_revision,
         simulation_activation_revision,
         provider_write_activation_revision
       FROM operations_shopify_carrier_service_mutation_authorizations
       WHERE global_id = $1`,
      [LEGACY_PROBE_GLOBAL_ID],
    )
    assert.deepEqual(upgraded.rows[0], {
      activation_revision: 7,
      simulation_activation_revision: 7,
      provider_write_activation_revision: null,
    })
    const trigger = await client.query(
      `SELECT 1
       FROM pg_trigger trigger
       JOIN pg_class relation ON relation.oid = trigger.tgrelid
       WHERE relation.relname =
         'operations_shopify_carrier_service_mutation_authorizations'
         AND trigger.tgname =
           'protect_ops_shopify_cs_mut_auth_write'
         AND NOT trigger.tgisinternal`,
    )
    assert.equal(
      trigger.rows.length,
      1,
      'active authorization upgrade did not restore append-only trigger',
    )
    const activeState = await activeAuthorizationObjectState(client)
    assert.deepEqual(
      activeState.columns,
      [
        {
          column_name: 'provider_write_activation_revision',
          data_type: 'integer',
          is_nullable: 'YES',
        },
        {
          column_name: 'simulation_activation_revision',
          data_type: 'integer',
          is_nullable: 'NO',
        },
      ],
      'active authorization revision columns are incomplete',
    )
    assert.deepEqual(
      activeState.constraints.map((row) => row.conname),
      [
        'ops_shopify_cs_mut_auth_sim_revision_valid',
        'ops_shopify_cs_mut_auth_write_revision_valid',
      ],
      'active authorization revision constraints are incomplete',
    )
    assert.ok(
      activeState.functions.some((row) => (
        row.proname
          === 'operations_shopify_cs_active_authorization_fence_hash'
      )),
      'active authorization fence function is missing',
    )
    const attemptFence = activeState.functions.find(
      (row) => row.proname === 'protect_ops_shopify_cs_mut_attempt',
    )?.definition || ''
    assert.match(
      attemptFence,
      /current_activation_state IS DISTINCT FROM 'active'/,
      'provider-call claim must retain the current Active-state fence',
    )
    assert.match(
      attemptFence,
      /current_activation_revision IS DISTINCT FROM\s+authorization_provider_write_activation_revision/,
      'provider-call claim must retain the exact Active-revision fence',
    )
    const localFinalizer = activeState.functions.find(
      (row) => row.proname === 'protect_ops_shopify_cs_config_mut_link',
    )?.definition || ''
    assert.match(
      localFinalizer,
      /configuration requires exact succeeded provider evidence/,
      'local finalization must require immutable succeeded provider evidence',
    )
    assert.match(
      localFinalizer,
      /config_row_version IS DISTINCT FROM NEW\.from_row_version/,
      'local finalization must retain the exact configuration row fence',
    )
    assert.doesNotMatch(
      localFinalizer,
      /current_activation_(?:state|revision)|activation\.state|activation\.revision|account_generation|credential_status|operations_commerce_credentials/,
      'post-provider local finalization must survive organization activation and credential drift',
    )
    const exactFinalization = activeState.functions.find(
      (row) => row.proname
        === 'operations_shopify_cs_config_has_exact_finalization_link',
    )?.definition || ''
    assert.match(
      exactFinalization,
      /authorized_mutation\.provider_write_activation_revision =\s+requested_to_activation_revision/,
      'local finalization must bind the stored provider-write revision',
    )
    assert.match(
      exactFinalization,
      /authorized_mutation\.credential_generation =\s+requested_credential_generation/,
      'local finalization must retain the authorization credential generation',
    )
    const configWriteValidator = activeState.functions.find(
      (row) => row.proname
        === 'validate_operations_shopify_carrier_service_config',
    )?.definition || ''
    assert.match(
      configWriteValidator,
      /operations_shopify_cs_config_has_exact_finalization_link/,
      'config validation must recognize only an exact local-finalization link',
    )
    assert.match(
      configWriteValidator,
      /IF NOT exact_finalization_link_exists[\s\S]+account_generation IS DISTINCT FROM NEW\.credential_generation[\s\S]+activation_revision IS DISTINCT FROM NEW\.activation_revision/,
      'ordinary config writes must retain mutable credential and activation fences',
    )
    const readyWriteValidator = activeState.functions.find(
      (row) => row.proname
        === 'validate_operations_shopify_carrier_service_config_ready',
    )?.definition || ''
    assert.match(
      readyWriteValidator,
      /operations_shopify_carrier_service_config_is_ready[\s\S]+AND NOT exact_finalization_link_exists/,
      'deferred callback-ready validation must exempt only exact local finalization',
    )
    const callbackReadyPredicate = activeState.functions.find(
      (row) => row.proname
        === 'operations_shopify_carrier_service_config_is_ready',
    )?.definition || ''
    assert.match(
      callbackReadyPredicate,
      /activation\.revision = config\.activation_revision/,
      'runtime callback readiness must remain fail-closed on Active revision drift',
    )

    await client.query('SAVEPOINT legacy_claim_probe')
    let legacyClaimRejected = false
    try {
      await client.query(
        `INSERT INTO
           operations_shopify_carrier_service_mutation_attempts (
             organization_id, authorization_id, worker_id,
             adapter_version, lease_token, lease_expires_at
           )
         SELECT
           organization_id, id, 'legacy-upgrade-probe',
           'legacy-upgrade-probe-v1',
           gen_random_uuid(), now() + interval '30 seconds'
         FROM operations_shopify_carrier_service_mutation_authorizations
         WHERE global_id = $1`,
        [LEGACY_PROBE_GLOBAL_ID],
      )
    } catch (error) {
      legacyClaimRejected = /Active authorization expired or became stale/
        .test(String(error.message || ''))
    }
    await client.query('ROLLBACK TO SAVEPOINT legacy_claim_probe')
    await client.query('RELEASE SAVEPOINT legacy_claim_probe')
    assert.equal(
      legacyClaimRejected,
      true,
      'upgraded legacy Shadow authorization was claimable',
    )

    await client.query('SAVEPOINT legacy_append_only_probe')
    let appendOnlyRejected = false
    try {
      await client.query(
        `UPDATE operations_shopify_carrier_service_mutation_authorizations
         SET provider_write_activation_revision = 8
         WHERE global_id = $1`,
        [LEGACY_PROBE_GLOBAL_ID],
      )
    } catch {
      appendOnlyRejected = true
    }
    await client.query('ROLLBACK TO SAVEPOINT legacy_append_only_probe')
    await client.query('RELEASE SAVEPOINT legacy_append_only_probe')
    assert.equal(
      appendOnlyRejected,
      true,
      'upgraded legacy authorization was not append-only',
    )
    await assertNewIdentifiersFitPostgres(client)
    await assertRequiredDatabaseGuards(client)
    await assertCachedReceiptReuseSchema(client)
    await assertCurrentIssueProjectionIndex(client)
  } finally {
    await client.query('ROLLBACK')
  }
}

async function assertCurrentIssueProjectionIndex(client) {
  const result = await client.query(
    `SELECT indexdef
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'commerce_intake_rejections_current_identity_idx'`,
  )
  assert.equal(
    result.rows.length,
    1,
    'current commerce issue projection index is missing',
  )
  const definition = String(result.rows[0].indexdef || '')
  for (const required of [
    'organization_id',
    'integration_account_id',
    'resource_type',
    'external_id',
    'created_at DESC',
    'id DESC',
  ]) {
    assert.ok(
      definition.includes(required),
      `current commerce issue projection index is missing ${required}`,
    )
  }
  assert.doesNotMatch(
    definition,
    /\bINCLUDE\s*\(/i,
    'current commerce issue projection index must remain key-only',
  )

  const externalId = Array.from(
    { length: 512 },
    (_, index) => String.fromCodePoint(0x10000 + index),
  ).join('')
  const safeMessage = Array.from(
    { length: 500 },
    (_, index) => String.fromCodePoint(0x11000 + index),
  ).join('')
  assert.equal([...externalId].length, 512)
  assert.equal([...safeMessage].length, 500)
  assert.ok(
    Buffer.byteLength(externalId, 'utf8') > 2_000,
    'external-id boundary probe must exercise a wide UTF-8 value',
  )
  assert.ok(
    Buffer.byteLength(safeMessage, 'utf8') >= 2_000,
    'safe-message boundary probe must exercise a wide UTF-8 value',
  )

  const foreignKeys = await client.query(
    `SELECT constraint_name
     FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'operations_commerce_intake_rejections'
       AND constraint_type = 'FOREIGN KEY'`,
  )
  await client.query(
    `DROP TRIGGER IF EXISTS
       protect_operations_commerce_intake_rejection
     ON operations_commerce_intake_rejections`,
  )
  for (const row of foreignKeys.rows) {
    await client.query(
      `ALTER TABLE operations_commerce_intake_rejections
       DROP CONSTRAINT ${quoteIdentifier(row.constraint_name)}`,
    )
  }
  const inserted = await client.query(
    `INSERT INTO operations_commerce_intake_rejections (
       id, global_id, organization_id, integration_account_id,
       pipeline_id, run_id, provider, resource_type, external_id,
       source_hash, error_code, safe_message, created_by, updated_by,
       created_at, updated_at, expires_at
     ) VALUES (
       '15800000-0000-4000-8000-000000000001'::uuid,
       'gcrj9580158',
       '15800000-0000-4000-8000-000000000002'::uuid,
       '15800000-0000-4000-8000-000000000003'::uuid,
       '15800000-0000-4000-8000-000000000004'::uuid,
       '15800000-0000-4000-8000-000000000005'::uuid,
       'shopify', 'product', $1, repeat('d', 64),
       'INDEX_WIDTH_PROBE', $2, 'rollback-acceptance',
       'rollback-acceptance', now(), now(), now() + interval '1 day'
     )
     RETURNING id::text`,
    [externalId, safeMessage],
  )
  assert.deepEqual(
    inserted.rows,
    [{ id: '15800000-0000-4000-8000-000000000001' }],
    'current-issue index rejected valid maximum-width rejection evidence',
  )
}

async function assertCachedReceiptReuseSchema(client) {
  const indexes = await client.query(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = ANY($1::text[])
     ORDER BY indexname`,
    [[
      'op_shopify_rate_reconciliations_receipt_match_idx',
      'op_shopify_rate_reconciliations_receipt_match_unique',
    ]],
  )
  assert.deepEqual(
    indexes.rows.map((row) => row.indexname),
    ['op_shopify_rate_reconciliations_receipt_match_idx'],
    'cached Shopify receipt evidence must be reusable across exact orders',
  )
  assert.doesNotMatch(
    indexes.rows[0].indexdef,
    /CREATE UNIQUE INDEX/,
    'cached Shopify receipt lookup must not be one-order exclusive',
  )
  const matcher = await client.query(
    `SELECT pg_get_functiondef(
       'operations_shopify_checkout_rate_match_candidates(uuid,uuid,boolean)'
         ::regprocedure
     ) AS definition`,
  )
  assert.doesNotMatch(
    matcher.rows[0].definition,
    /operations_shopify_checkout_rate_reconciliations prior|prior\.receipt_id/,
    'the first exact order must not consume cached Shopify receipt evidence',
  )
  const recoveryRelations = await client.query(
    `SELECT
       to_regclass(
         'public.operations_shopify_checkout_rate_reconciliation_supersessions'
       )::text AS supersession_table,
       to_regclass(
         'public.operations_shopify_checkout_rate_current_reconciliations'
       )::text AS current_view`,
  )
  assert.deepEqual(recoveryRelations.rows, [{
    supersession_table:
      'operations_shopify_checkout_rate_reconciliation_supersessions',
    current_view:
      'operations_shopify_checkout_rate_current_reconciliations',
  }], 'cached receipt recovery relations are missing')

  const currentView = await client.query(
    `SELECT definition
     FROM pg_views
     WHERE schemaname = 'public'
       AND viewname =
         'operations_shopify_checkout_rate_current_reconciliations'`,
  )
  assert.equal(currentView.rows.length, 1)
  assert.match(
    currentView.rows[0].definition,
    /operations_shopify_checkout_rate_reconciliation_supersessions/,
    'current Shopify decision view must project verified supersessions',
  )
  assert.match(
    currentView.rows[0].definition,
    /selected_offer/,
    'current Shopify decision view must derive the exact immutable offer',
  )

  const recoveryGuard = await client.query(
    `SELECT pg_get_functiondef(
       'protect_ops_shopify_rate_recon_supersession()'::regprocedure
     ) AS definition`,
  )
  assert.match(
    recoveryGuard.rows[0].definition,
    /exact_candidate_count IS DISTINCT FROM 1/,
    'cached receipt supersession must require exactly one current match',
  )
  assert.match(
    recoveryGuard.rows[0].definition,
    /original_reconciliation\.outcome[\s\S]*rejected[\s\S]*expired/,
    'cached receipt supersession must preserve matched and ambiguous decisions',
  )
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
      'operations_shopify_checkout_rate_reconciliation_supersessions',
      'operations_shopify_carrier_service_mutation_authorizations',
      'operations_shopify_carrier_service_mutation_attempts',
      'operations_shopify_carrier_service_mutation_outcomes',
      'operations_shopify_carrier_service_mutation_resolutions',
      'operations_shopify_carrier_service_config_mutation_links',
    ]],
  )
  const names = new Set(triggers.rows.map((row) => row.tgname))
  for (const required of [
    'protect_operations_commerce_external_effect_intent_write',
    'validate_operations_shopify_carrier_service_config_write',
    'protect_operations_shopify_checkout_rate_receipt_package_write',
    'protect_operations_shopify_checkout_rate_receipt_offer_write',
    'protect_operations_shopify_checkout_rate_reconciliation_write',
    'protect_ops_shopify_rate_reconciliation_supersession_write',
    'protect_ops_shopify_cs_mut_auth_write',
    'protect_ops_shopify_cs_mut_attempt_write',
    'protect_ops_shopify_cs_mut_outcome_write',
    'protect_ops_shopify_cs_mut_resolution_write',
    'protect_ops_shopify_cs_config_mut_link_write',
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
      'planning_method',
      'pack_profile_version_id',
      'pack_profile_version_row_version',
      'self_package_line_key',
    ]],
  )
  assert.deepEqual(
    packageColumns.rows.map((row) => row.column_name),
    [
      'carrier_parcel_snapshot',
      'pack_profile_version_id',
      'pack_profile_version_row_version',
      'packaging_material_stock_id',
      'packaging_material_stock_on_hand_quantity',
      'packaging_material_stock_row_version',
      'planning_method',
      'self_package_line_key',
    ],
  )
  const nullableByColumn = new Map(packageColumns.rows.map(
    (row) => [row.column_name, row.is_nullable],
  ))
  assert.equal(nullableByColumn.get('carrier_parcel_snapshot'), 'NO')
  assert.equal(nullableByColumn.get('planning_method'), 'NO')
  for (const nullableEvidence of [
    'packaging_material_stock_id',
    'packaging_material_stock_row_version',
    'packaging_material_stock_on_hand_quantity',
    'pack_profile_version_id',
    'pack_profile_version_row_version',
    'self_package_line_key',
  ]) {
    assert.equal(
      nullableByColumn.get(nullableEvidence),
      'YES',
      `${nullableEvidence} must be conditionally required by package method`,
    )
  }

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
  let beforeActiveObjects
  let beforeAuthorizationData
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
      REQUIRED_APPLIED_MIGRATIONS,
      'rollback-only acceptance requires 0148-0151 applied and must stop once 0156 or 0157 is permanently applied',
    )
    assert.ok(
      Object.values(beforeRelations).every((value) => value !== null),
      'rollback-only acceptance requires the existing 0148-0151 Shopify schema',
    )
    beforeActiveObjects = await activeAuthorizationObjectState(client)
    assert.deepEqual(
      beforeActiveObjects.columns,
      [],
      'rollback-only acceptance must run before 0156 columns exist',
    )
    assert.deepEqual(
      beforeActiveObjects.constraints,
      [],
      'rollback-only acceptance must run before 0156 constraints exist',
    )
    assert.equal(
      beforeActiveObjects.functions.some((row) => (
        row.proname
          === 'operations_shopify_cs_active_authorization_fence_hash'
      )),
      false,
      'rollback-only acceptance must run before the 0156 fence function exists',
    )
    beforeAuthorizationData = await authorizationDataState(client)
    assert.equal(
      beforeAuthorizationData.legacy_probe_count,
      '0',
      'reserved legacy upgrade probe already exists',
    )

    await assertActiveAuthorizationUpgrade(client)
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
    assert.deepEqual(
      await activeAuthorizationObjectState(verification),
      beforeActiveObjects,
      'rollback left active-authorization schema residue',
    )
    assert.deepEqual(
      await authorizationDataState(verification),
      beforeAuthorizationData,
      'rollback left active-authorization data residue',
    )
  } finally {
    verification.release()
    await pool.end()
  }

  console.log(JSON.stringify({
    ok: true,
    acceptance: 'rollback-only-postgres',
    databaseFingerprint: TRUSTED_DATABASE_FINGERPRINT,
    requiredAppliedMigrations: REQUIRED_APPLIED_MIGRATIONS,
    targetMigrations: [
      TARGET_MIGRATION,
      RECEIPT_REUSE_MIGRATION,
      CURRENT_ISSUE_INDEX_MIGRATION,
    ],
    retainedSchemaOrData: false,
  }, null, 2))
}

main().catch(async (error) => {
  await pool.end().catch(() => undefined)
  console.error(error)
  process.exit(1)
})
