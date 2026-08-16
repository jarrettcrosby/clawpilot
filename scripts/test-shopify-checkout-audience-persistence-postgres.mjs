#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = resolve(import.meta.dirname, '..')
const requireFromScript = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')

const ORGANIZATION_ID = '29300000-0000-4000-8000-000000000001'
const SANDBOX_ACCOUNT_ID = '29300000-0000-4000-8000-000000000010'
const PRODUCTION_ACCOUNT_ID = '29300000-0000-4000-8000-000000000011'
const SANDBOX_ACCOUNT_GLOBAL_ID = 'gia2930001'
const PRODUCTION_ACCOUNT_GLOBAL_ID = 'gia2930002'
const ACTOR_EMAIL = 'checkout-audience-owner@example.test'
const RETAINED_SERVICE_GID =
  'gid://shopify/DeliveryCarrierService/2930001'
const RETAINED_CALLBACK_TOKEN_VERSION = 7
const RETAINED_CALLBACK_TOKEN_HASH = 'e'.repeat(64)

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

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

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    AbortController,
    AbortSignal,
    Array,
    BigInt,
    Boolean,
    Buffer,
    Date,
    Error,
    Headers,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Request,
    Response,
    Set,
    String,
    TextDecoder,
    TextEncoder,
    URL,
    Uint8Array,
    clearTimeout,
    console,
    exports: module.exports,
    module,
    process,
    setTimeout,
    structuredClone,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromScript(specifier)
    },
  }, { filename: path })
  return module.exports
}

function postgresAdapter(pool) {
  return {
    query: (sql, values = []) => pool.query(sql, values),
    getPostgresPool: () => pool,
    acquireTransactionAdvisoryLock: (client, key) => client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [key],
    ),
    withTransaction: async (work) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

async function seedFixture(pool) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [ACTOR_EMAIL],
    )
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, created_by, updated_by
       ) VALUES (
         $1::uuid, 'Checkout audience fixture', 'root', $2, $2
       )`,
      [ORGANIZATION_ID, ACTOR_EMAIL],
    )
    await client.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, permissions, status,
         is_default, created_by, updated_by
       ) VALUES (
         $1, $2::uuid, 'owner',
         '{"manageOperations":true}'::jsonb, 'active', true, $1, $1
       )`,
      [ACTOR_EMAIL, ORGANIZATION_ID],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision
       ) VALUES (
         $1::uuid, '29300000-0000-4000-8000-000000000002'::uuid,
         'shadow', 1
       )`,
      [ORGANIZATION_ID],
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation
       ) VALUES
       (
         $2::uuid, $3, $1::uuid, 'shopify', 'commerce', 'sandbox',
         'Audience sandbox store', 'active',
         '{
           "accountName":"Audience sandbox store",
           "grantedScopes":["write_shipping"],
           "lastVerifiedAt":"2026-08-15T12:00:00.000Z"
         }'::jsonb,
         'audience-sandbox.myshopify.com', 1
       ),
       (
         $4::uuid, $5, $1::uuid, 'shopify', 'commerce', 'production',
         'Audience production store', 'active',
         '{
           "accountName":"Audience production store",
           "grantedScopes":["write_shipping"],
           "lastVerifiedAt":"2026-08-15T12:00:00.000Z"
         }'::jsonb,
         'audience-production.myshopify.com', 1
       )`,
      [
        ORGANIZATION_ID,
        SANDBOX_ACCOUNT_ID,
        SANDBOX_ACCOUNT_GLOBAL_ID,
        PRODUCTION_ACCOUNT_ID,
        PRODUCTION_ACCOUNT_GLOBAL_ID,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status
       ) VALUES
       (
         $1::uuid, $2::uuid, 'audience-sandbox.myshopify.com',
         'shopify_client_credentials', decode('01', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, '0001', 'verified', now(), 'unverified'
       ),
       (
         $1::uuid, $3::uuid, 'audience-production.myshopify.com',
         'shopify_client_credentials', decode('02', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, '0002', 'verified', now(), 'unverified'
       )`,
      [ORGANIZATION_ID, SANDBOX_ACCOUNT_ID, PRODUCTION_ACCOUNT_ID],
    )
    await client.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, address, status
       ) VALUES (
         '29300000-0000-4000-8000-000000000020'::uuid,
         'gwh2930001', $1::uuid, 'AUDIENCE', 'Audience warehouse',
         '{
           "line1":"6949 S 108th St",
           "city":"La Vista",
           "region":"NE",
           "postalCode":"68128",
           "countryCode":"US"
         }'::jsonb,
         'active'
       )`,
      [ORGANIZATION_ID],
    )
    const basePolicyValue = {
      version: 'shopify-checkout-rating-policy-v1',
      planRateOptimization: {
        version: 'shopify-checkout-plan-rate-objective-v2',
        maxCandidates: 4,
        objectivePriority: [
          'landed_price',
          'package_count',
          'unused_cube',
        ],
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
        minIntervalMs: 1_000,
        supportedCountries: ['US'],
        staleCartAbort: true,
      },
      shadowCheckoutAudience: {
        version: 'shopify-checkout-audience-v1',
        mode: 'restricted_customers',
      },
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1',
        audience: 'restricted_customers',
        rateSource: 'production',
      },
    }
    const sandboxBasePolicy = JSON.stringify({
      ...basePolicyValue,
      checkoutRateControl: {
        ...basePolicyValue.checkoutRateControl,
        rateSource: 'sandbox',
      },
    })
    const productionBasePolicy = JSON.stringify(basePolicyValue)
    await client.query(
      `INSERT INTO crm_reference_registry (
         reference_code, prefix, canonical_code, status, entity_type
       ) VALUES
       (
         'gscf2930001', 'gscf', 'gscf2930001', 'active',
         'operations.shopify_carrier_service_config'
       ),
       (
         'gscf2930002', 'gscf', 'gscf2930002', 'active',
         'operations.shopify_carrier_service_config'
       )`,
    )
    await client.query(
      `INSERT INTO operations_shopify_carrier_service_configs (
         id, global_id, organization_id, integration_account_id,
         warehouse_id, service_gid, registered_service_name,
         registration_state, credential_generation, activation_revision,
         callback_token_version, callback_token_hash,
         policy_revision, policy_hash, policy_snapshot,
         inventory_max_age_seconds, quote_ttl_seconds,
         order_reconciliation_window_seconds, algorithm_version,
         row_version, created_by, updated_by
       ) VALUES
       (
         '29300000-0000-4000-8000-000000000030'::uuid,
         'gscf2930001', $1::uuid, $2::uuid,
         '29300000-0000-4000-8000-000000000020'::uuid,
         $4, 'Audience sandbox store', 'disabled', 1, 1,
         $5, $6, 1, repeat('f', 64), $7::jsonb,
         900, 900, 86400, 'checkout-audience-acceptance-v1',
         1, $8, $8
       ),
       (
         '29300000-0000-4000-8000-000000000031'::uuid,
         'gscf2930002', $1::uuid, $3::uuid,
         '29300000-0000-4000-8000-000000000020'::uuid,
         'gid://shopify/DeliveryCarrierService/2930002',
         'Audience production store', 'disabled', 1, 1,
         8, repeat('d', 64), 1, repeat('c', 64), $9::jsonb,
         900, 900, 86400, 'checkout-audience-acceptance-v1',
         1, $8, $8
       )`,
      [
        ORGANIZATION_ID,
        SANDBOX_ACCOUNT_ID,
        PRODUCTION_ACCOUNT_ID,
        RETAINED_SERVICE_GID,
        RETAINED_CALLBACK_TOKEN_VERSION,
        RETAINED_CALLBACK_TOKEN_HASH,
        sandboxBasePolicy,
        ACTOR_EMAIL,
        productionBasePolicy,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
    client.release()
  }
}

async function exerciseCarrierServiceModeMatrix(pool) {
  const safeStates = new Set(['shadow', 'read_only', 'active'])
  const states = ['disabled', 'frozen', 'read_only', 'shadow', 'active']
  const operations = ['create', 'update', 'delete']
  let sequence = 0
  for (const state of states) {
    for (const operation of operations) {
      sequence += 1
      const client = await pool.connect()
      await client.query('BEGIN')
      await client.query('SET CONSTRAINTS ALL DEFERRED')
      try {
        const activationRevision = 100 + sequence
        const configRowVersion = 500 + sequence
        const effectId = randomUUID()
        const requestHash = sequence.toString(16).padStart(64, '0')
        const aggregateHash = (sequence + 1000)
          .toString(16).padStart(64, '0')
        const terminalHash = (sequence + 2000)
          .toString(16).padStart(64, '0')
        const serviceGid = operation === 'create'
          ? null
          : RETAINED_SERVICE_GID
        const registrationState = operation === 'create'
          ? 'shadow_simulated'
          : 'registered'
        const mutation = operation === 'update'
          ? {
              operation: 'update',
              carrierServiceId: RETAINED_SERVICE_GID,
              serviceName: 'Audience sandbox store',
            }
          : operation === 'create'
            ? { operation: 'create' }
            : {
                operation: 'delete',
                carrierServiceId: RETAINED_SERVICE_GID,
              }

        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `UPDATE operations_activation_scopes
           SET state = $2, revision = $3
           WHERE organization_id = $1::uuid`,
          [ORGANIZATION_ID, state, activationRevision],
        )
        await client.query(
          `UPDATE operations_shopify_carrier_service_configs
           SET registration_state = $3,
               service_gid = $4,
               registered_service_name = $5,
               activation_revision = 1,
               row_version = $6::bigint
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid`,
          [
            ORGANIZATION_ID,
            SANDBOX_ACCOUNT_ID,
            registrationState,
            serviceGid,
            operation === 'create'
              ? null
              : operation === 'update'
                ? 'Legacy checkout name'
                : 'Audience sandbox store',
            configRowVersion,
          ],
        )
        await client.query(
          `INSERT INTO operations_commerce_external_effect_aggregate_fences (
             organization_id, integration_account_id, provider,
             aggregate_type, aggregate_id, aggregate_revision,
             aggregate_hash
           ) VALUES (
             $1::uuid, $2::uuid, 'shopify',
             'shopify_carrier_service_configuration', 'gscf2930001',
             $3::bigint, $4
           )
           ON CONFLICT (
             organization_id, integration_account_id, provider,
             aggregate_type, aggregate_id
           ) DO UPDATE SET
             aggregate_revision = EXCLUDED.aggregate_revision,
             aggregate_hash = EXCLUDED.aggregate_hash`,
          [
            ORGANIZATION_ID,
            SANDBOX_ACCOUNT_ID,
            configRowVersion,
            aggregateHash,
          ],
        )
        await client.query('SET LOCAL session_replication_role = origin')

        const effect = await client.query(
          `INSERT INTO operations_commerce_external_effect_intents (
             id, organization_id, integration_account_id, provider, action,
             desired_mode, credential_generation, activation_revision,
             aggregate_type, aggregate_id, aggregate_revision,
             aggregate_hash, idempotency_key, request_hash,
             redacted_request, state, redacted_result,
             terminal_evidence_hash, provider_write_count, completed_at,
             created_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, 'shopify', $4,
             'shadow', 1, $5,
             'shopify_carrier_service_configuration', 'gscf2930001',
             $6::bigint, $7, $8, $9, $10::jsonb, 'simulated',
             '{"providerWrites":0}'::jsonb, $11, 0, now(), $12
           )
           RETURNING id::text, global_id`,
          [
            effectId,
            ORGANIZATION_ID,
            SANDBOX_ACCOUNT_ID,
            `shopify.carrier_service.${operation}`,
            activationRevision,
            configRowVersion,
            aggregateHash,
            `checkout-mode-simulation:${state}:${operation}:${sequence}`,
            requestHash,
            JSON.stringify({ mutation }),
            terminalHash,
            ACTOR_EMAIL,
          ],
        )
        assert.equal(
          effect.rows.length,
          1,
          `${state}/${operation} must retain exact zero-write simulation`,
        )

        const insertAuthorization = () => client.query(
          `INSERT INTO
             operations_shopify_carrier_service_mutation_authorizations (
               organization_id, integration_account_id, config_id,
               simulation_effect_id, operation, account_environment,
               credential_generation, config_row_version, activation_state,
               activation_revision, simulation_activation_revision,
               provider_write_activation_revision, aggregate_hash,
               request_hash, expected_service_gid, confirmation_hash,
               confirmation_statement_version, idempotency_key,
               authorized_by, authorized_role, expires_at
             ) VALUES (
               $1::uuid, $2::uuid,
               '29300000-0000-4000-8000-000000000030'::uuid,
               $3::uuid, $4, 'sandbox', 1, $5::bigint, $6, 1, $7,
               $7, $8, $9, $10, repeat('f', 64),
               'shopify-carrier-service-sandbox-provider-write-v1',
               $11, $12, 'owner', now() + interval '2 minutes'
             )
             RETURNING id::text, global_id`,
          [
            ORGANIZATION_ID,
            SANDBOX_ACCOUNT_ID,
            effectId,
            operation,
            configRowVersion,
            state,
            activationRevision,
            aggregateHash,
            requestHash,
            serviceGid,
            `checkout-mode-authorization:${state}:${operation}:${sequence}`,
            ACTOR_EMAIL,
          ],
        )

        if (!safeStates.has(state)) {
          await assert.rejects(
            insertAuthorization(),
            /activation|provider[- ]write|safety|check constraint|Shadow simulation/iu,
            `${state}/${operation} must block the provider-write grant`,
          )
          continue
        }

        const authorization = await insertAuthorization()
        assert.equal(authorization.rows.length, 1)
        const leaseToken = randomUUID()
        const attempt = await client.query(
          `INSERT INTO operations_shopify_carrier_service_mutation_attempts (
             organization_id, authorization_id, worker_id, adapter_version,
             lease_token, lease_expires_at
           ) VALUES (
             $1::uuid, $2::uuid, 'checkout-mode-matrix',
             'checkout-mode-matrix-v1', $3::uuid,
             now() + interval '30 seconds'
           ) RETURNING id::text`,
          [ORGANIZATION_ID, authorization.rows[0].id, leaseToken],
        )
        assert.equal(attempt.rows.length, 1)
        const outcome = await client.query(
          `INSERT INTO operations_shopify_carrier_service_mutation_outcomes (
             organization_id, attempt_id, lease_token, outcome,
             redacted_result, result_hash, provider_reference, error_code,
             provider_write_count, finalized_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, 'succeeded',
             '{"providerMutationAttempted":true,"providerWrites":1}'::jsonb,
             repeat('e', 64), $4, NULL, 1,
             'checkout-mode-matrix-v1'
           ) RETURNING id::text, global_id`,
          [
            ORGANIZATION_ID,
            attempt.rows[0].id,
            leaseToken,
            RETAINED_SERVICE_GID,
          ],
        )
        assert.equal(
          outcome.rows.length,
          1,
          `${state}/${operation} must retain exact applied outcome`,
        )

        if (operation === 'update') {
          const finalizedName = await client.query(
            `UPDATE operations_shopify_carrier_service_configs
             SET registered_service_name = 'Audience sandbox store',
                 row_version = row_version + 1,
                 updated_by = $3,
                 updated_at = now()
             WHERE organization_id = $1::uuid
               AND id = $2::uuid
               AND row_version = $4::bigint
             RETURNING row_version::text, registered_service_name`,
            [
              ORGANIZATION_ID,
              '29300000-0000-4000-8000-000000000030',
              ACTOR_EMAIL,
              configRowVersion,
            ],
          )
          assert.deepEqual(finalizedName.rows, [{
            row_version: String(configRowVersion + 1),
            registered_service_name: 'Audience sandbox store',
          }], `${state}/update must finalize from exact applied evidence`)
        } else {
          const targetState = operation === 'create'
            ? 'registered'
            : 'disabled'
          const targetGid = operation === 'create'
            ? RETAINED_SERVICE_GID
            : null
          await client.query(
            `INSERT INTO
               operations_shopify_carrier_service_config_mutation_links (
                 organization_id, config_id, authorization_id, attempt_id,
                 outcome_id, resolution_id, from_row_version,
                 to_row_version, from_registration_state,
                 to_registration_state, from_service_gid, to_service_gid,
                 linked_by, linked_role
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, NULL,
                 $6::bigint, $6::bigint + 1, $7, $8, $9, $10,
                 $11, 'owner'
               )`,
            [
              ORGANIZATION_ID,
              '29300000-0000-4000-8000-000000000030',
              authorization.rows[0].id,
              attempt.rows[0].id,
              outcome.rows[0].id,
              configRowVersion,
              registrationState,
              targetState,
              serviceGid,
              targetGid,
              ACTOR_EMAIL,
            ],
          )
          const finalizedConfig = await client.query(
            `UPDATE operations_shopify_carrier_service_configs
             SET registration_state = $3,
                 service_gid = $4,
                 registered_service_name = $5,
                 activation_revision = $6,
                 row_version = row_version + 1,
                 updated_by = $7,
                 updated_at = now()
             WHERE organization_id = $1::uuid
               AND id = $2::uuid
               AND row_version = $8::bigint
             RETURNING row_version::text, registration_state, service_gid`,
            [
              ORGANIZATION_ID,
              '29300000-0000-4000-8000-000000000030',
              targetState,
              targetGid,
              operation === 'create' ? 'Audience sandbox store' : null,
              activationRevision,
              ACTOR_EMAIL,
              configRowVersion,
            ],
          )
          assert.equal(
            finalizedConfig.rows.length,
            1,
            `${state}/${operation} must finalize exact provider state`,
          )
        }
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }
  }
}

function apiRequest(body, idempotencyKey = '') {
  const request = new Request(
    'http://localhost/api/integrations/commerce/shopify/carrier-service',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    },
  )
  Object.defineProperty(request, 'nextUrl', {
    value: new URL(request.url),
  })
  return request
}

async function configRow(pool, accountGlobalId) {
  const result = await pool.query(
    `SELECT
       config.row_version::text,
       config.policy_revision::text,
       config.policy_hash,
       config.policy_snapshot,
       config.service_gid,
       config.callback_token_version,
       config.callback_token_hash
     FROM operations_shopify_carrier_service_configs config
     JOIN operations_integration_accounts account
       ON account.organization_id = config.organization_id
      AND account.id = config.integration_account_id
     WHERE config.organization_id = $1::uuid
       AND account.global_id = $2`,
    [ORGANIZATION_ID, accountGlobalId],
  )
  assert.equal(result.rows.length, 1)
  return result.rows[0]
}

async function exerciseHistoricalReceiptMigration(databaseUrl) {
  const terminalId = '29300000-0000-4000-8000-000000000090'
  const processingId = '29300000-0000-4000-8000-000000000091'
  const historyDatabaseName = `checkout_audience_history_${process.pid}`
  const adminUrl = new URL(databaseUrl)
  adminUrl.pathname = '/postgres'
  const historyUrl = new URL(databaseUrl)
  historyUrl.pathname = `/${historyDatabaseName}`
  const adminPool = new Pool({ connectionString: adminUrl.toString(), max: 1 })
  await adminPool.query(`CREATE DATABASE ${historyDatabaseName}`)
  const pool = new Pool({ connectionString: historyUrl.toString(), max: 2 })
  try {
    await pool.query(
      `CREATE TABLE schema_migrations (
         filename text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await pool.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES (
         '0299_operations_shopify_checkout_rate_control.sql',
         $1
       )`,
      [command('shasum', [
        '-a', '256',
        resolve(root, 'db/migrations/0299_operations_shopify_checkout_rate_control.sql'),
      ]).split(/\s+/u)[0]],
    )
    command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: historyUrl.toString() },
      timeout: 300_000,
    })
    await seedFixture(pool)
    await pool.query('SET session_replication_role = replica')
    try {
      await pool.query(
        `INSERT INTO operations_shopify_checkout_rate_receipts (
         id, global_id, organization_id, integration_account_id, config_id,
         config_row_version, credential_generation, activation_revision,
         activation_state, policy_revision, policy_hash, warehouse_id,
         algorithm_version, request_fingerprint, destination_fingerprint,
         carrier_destination_fingerprint, line_quantity_fingerprint,
         request_evidence_hash, redacted_request_snapshot, currency,
         idempotency_key, status, lease_token, lease_expires_at, claimed_by,
         line_count, package_count, offer_count, package_plan_hash,
         result_hash, result_snapshot, error_code, inventory_snapshot_hash,
         inventory_snapshot_at, reconciliation_window_seconds,
         reconciliation_deadline_at, expires_at, completed_at,
         created_at, updated_at
       ) VALUES
       (
         $1::uuid, 'gsqr2930090', $3::uuid, $4::uuid, $5::uuid,
         1, 1, 1, 'active', 1, repeat('a', 64), $6::uuid,
         'historical-terminal', repeat('b', 64), repeat('c', 64),
         repeat('d', 64), repeat('e', 64), repeat('f', 64), '{}'::jsonb,
         'USD', 'historical-terminal-0299', 'failed', NULL, NULL, NULL,
         1, 0, 0, NULL, repeat('1', 64), '{}'::jsonb,
         'HISTORICAL_FAILURE', repeat('2', 64), now(), 900,
         now() + interval '900 seconds', now() + interval '1 hour', now(),
         now(), now()
       ),
       (
         $2::uuid, 'gsqr2930091', $3::uuid, $4::uuid, $5::uuid,
         1, 1, 1, 'shadow', 1, repeat('a', 64), $6::uuid,
         'historical-processing', repeat('3', 64), repeat('4', 64),
         repeat('5', 64), repeat('6', 64), repeat('7', 64), '{}'::jsonb,
         'USD', 'historical-processing-0299', 'processing', gen_random_uuid(),
         now() + interval '5 minutes', 'historical-worker',
         1, 0, 0, NULL, NULL, NULL, NULL, repeat('8', 64), now(), 900,
         now() + interval '900 seconds', NULL, NULL, now(), now()
       )`,
      [
        terminalId,
        processingId,
        ORGANIZATION_ID,
        SANDBOX_ACCOUNT_ID,
        '29300000-0000-4000-8000-000000000030',
        '29300000-0000-4000-8000-000000000020',
      ],
      )
    } finally {
      await pool.query('SET session_replication_role = origin')
    }
    await pool.query(
      `DELETE FROM schema_migrations
       WHERE filename = '0299_operations_shopify_checkout_rate_control.sql'`,
    )
    command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: historyUrl.toString() },
      timeout: 300_000,
    })
    const migrated = await pool.query(
      `SELECT id::text, status, rate_source
       FROM operations_shopify_checkout_rate_receipts
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [[terminalId, processingId]],
    )
    assert.deepEqual(migrated.rows, [
      { id: terminalId, status: 'failed', rate_source: 'production' },
      { id: processingId, status: 'processing', rate_source: 'sandbox' },
    ])
    await assert.rejects(
      pool.query(
        `UPDATE operations_shopify_checkout_rate_receipts
         SET rate_source = 'sandbox'
         WHERE id = $1::uuid`,
        [terminalId],
      ),
      /checkout rate receipts are immutable/u,
    )
  } finally {
    await pool.end().catch(() => undefined)
    await adminPool.query(
      `DROP DATABASE IF EXISTS ${historyDatabaseName} WITH (FORCE)`,
    ).catch(() => undefined)
    await adminPool.end().catch(() => undefined)
  }
}

async function exercise(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    max: 4,
  })
  const audits = []
  let staleSetupRead = false
  let canActivate = true
  try {
    await seedFixture(pool)
    await exerciseCarrierServiceModeMatrix(pool)
    const planPolicy = loadTypeScriptModule(
      'app_src/lib/operations/shopifyCheckoutPlanRatePolicy.ts',
      {
        '../currency.ts': {
          DEFAULT_WORKSPACE_CURRENCY_CODE: 'USD',
          isIso4217CurrencyCode: (value) => (
            typeof value === 'string'
            && /^[A-Z]{3}$/u.test(value)
            && value !== 'ZZZ'
          ),
        },
      },
    )
    const rateWarmPolicy = loadTypeScriptModule(
      'app_src/lib/operations/shopifyCheckoutRateWarmPolicy.ts',
    )
    const audiencePolicy = loadTypeScriptModule(
      'app_src/lib/operations/shopifyCheckoutAudiencePolicy.ts',
    )
    const rateControl = loadTypeScriptModule(
      'app_src/lib/operations/shopifyCheckoutRateControl.ts',
      {
        './shopifyCheckoutAudiencePolicy': audiencePolicy,
      },
    )
    const customerPolicyDomain = loadTypeScriptModule(
      'app_src/lib/integrations/shopifyCustomerRatePolicy.ts',
    )
    const customerPolicies = loadTypeScriptModule(
      'app_src/lib/persistence/shopifyCustomerRatePolicies.ts',
      {
        '@/lib/integrations/shopifyCustomerRatePolicy':
          customerPolicyDomain,
        '@/lib/operations/shopifyCheckoutRateControl': rateControl,
        '@/lib/persistence/postgres': postgresAdapter(pool),
      },
    )
    const persistence = loadTypeScriptModule(
      'app_src/lib/persistence/shopifyCheckoutRating.ts',
      {
        '@/lib/auditWriter': {
          async recordAuditEvent(event) {
            audits.push(event)
          },
        },
        '@/lib/operations/shopifyCheckoutPlanRatePolicy': planPolicy,
        '@/lib/operations/shopifyCheckoutRateWarmPolicy': rateWarmPolicy,
        '@/lib/operations/shopifyCheckoutAudiencePolicy': audiencePolicy,
        '@/lib/operations/shopifyCheckoutRateControl': rateControl,
        '@/lib/persistence/postgres': postgresAdapter(pool),
      },
    )

    class CommerceIntegrationRequestError extends Error {
      constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
        super(message)
        this.name = 'CommerceIntegrationRequestError'
        this.status = status
        this.code = code
      }
    }
    class ShopifyCarrierServiceRegistrationError extends Error {
      constructor(message, status = 400, code = 'REGISTRATION_FAILED') {
        super(message)
        this.status = status
        this.code = code
        this.retryable = false
        this.effectGlobalId = null
      }
    }
    class ShopifyCarrierServiceMutationAuthorizationError extends Error {
      constructor(message, status = 400, code = 'AUTHORIZATION_FAILED') {
        super(message)
        this.status = status
        this.code = code
      }
    }

    const integrationState = async (organizationId) => {
      assert.equal(organizationId, ORGANIZATION_ID)
      const result = await pool.query(
        `SELECT global_id, environment, display_name, configuration,
           external_account_id
         FROM operations_integration_accounts
         WHERE organization_id = $1::uuid
           AND provider = 'shopify'
         ORDER BY global_id`,
        [ORGANIZATION_ID],
      )
      return {
        accounts: result.rows.map((row) => ({
          globalId: row.global_id,
          provider: 'shopify',
          environment: row.environment,
          displayName: row.display_name,
          status: 'active',
          configured: true,
          credentialVersion: 1,
          verificationStatus: 'verified',
          receiptIntakeEnabled: false,
          externalAccountId: row.external_account_id,
          configuration: row.configuration,
        })),
      }
    }
    const setupReference = {
      activation: { state: 'shadow', revision: 1 },
      warehouses: [],
      materials: [],
      carrierAccounts: [],
      evidence: {
        succeededReceipts: 0,
        failedReceipts: 0,
        lastReceivedAt: null,
        latest: [],
      },
    }
    const customerSummary = {
      policyCount: 1,
      simulatedCount: 1,
      shadowAllowedCount: 1,
      checkoutEligibleCount: 1,
      expiredSimulatedCount: 0,
      blockedCount: 0,
      enforcedCount: 0,
      earliestShadowExpiresAt: '2026-08-16T12:00:00.000Z',
      enforcement: {
        state: 'provider_enforcement_blocked',
        defaultPolicy: 'hide_all',
        providerWriteAvailable: false,
        providerWritesPerformed: 0,
      },
    }
    const carrierServiceRegistration = {
      executeAuthorizedShopifyCarrierServiceMutation: async () => {
        throw new Error('provider mutation must not run')
      },
      executeShopifyCarrierServiceRegistration: async () => {
        throw new Error('provider mutation must not run')
      },
      SHOPIFY_CARRIER_SERVICE_REGISTRATION_ADAPTER_VERSION: 'test',
      shopifyCarrierServiceRegistrationRequestHash: () => 'a'.repeat(64),
      ShopifyCarrierServiceRegistrationError,
      verifyShopifyCarrierServiceMutationForReconciliation: async () => {
        throw new Error('provider verification must not run')
      },
    }
    const mutationAuthorization = {
      authorizeShopifyCarrierServiceMutationInPostgres: async () => null,
      claimShopifyCarrierServiceMutationInPostgres: async () => null,
      finalizeShopifyCarrierServiceConfigMutationInPostgres: async () => null,
      finalizeShopifyCarrierServiceNameAlignmentInPostgres: async () => null,
      readShopifyCarrierServiceMutationAuthorizationFromPostgres:
        async () => null,
      readShopifyCarrierServiceMutationAuthorizationsFromPostgres:
        async () => [],
      resolveShopifyCarrierServiceMutationInPostgres: async () => null,
      shopifyCarrierServiceMutationConfirmationHash: () => 'b'.repeat(64),
      shopifyCarrierServiceMutationConfirmationVersion: 'test',
      shopifyCarrierServiceMutationResolutionConfirmationHash:
        () => 'c'.repeat(64),
      SHOPIFY_CARRIER_SERVICE_RECONCILIATION_CONFIRMATION_VERSION: 'test',
      ShopifyCarrierServiceMutationAuthorizationError,
    }
    const route = loadTypeScriptModule(
      'app_src/app/api/integrations/commerce/shopify/carrier-service/route.ts',
      {
        'next/server': {
          NextRequest: Request,
          NextResponse: {
            json(body, init = {}) {
              return {
                body,
                status: init.status || 200,
                headers: init.headers || {},
              }
            },
          },
        },
        '@/lib/integrations/commerceCredentialCrypto': {
          normalizeCommerceAccountGlobalId: (value) => value,
          shopifyCarrierServiceCallbackToken: () => 't'.repeat(43),
        },
        '@/lib/integrations/shopifyCarrierServiceRegistration':
          carrierServiceRegistration,
        '@/lib/integrations/shopifyCarrierServiceBranding': {
          shopifyStoreEntityCarrierServiceName: (value) => String(value).trim(),
        },
        '@/lib/integrations/shopifyShadowCheckoutAllowlist': {
          hasValidShopifyShadowVariantAllowlist: () => true,
        },
        '@/lib/integrations/commerceIntegrations': {
          CommerceIntegrationRequestError,
          testCommerceConnection: async () => null,
        },
        '@/lib/operations/hybridCartonization': {
          HYBRID_CARTONIZATION_ALGORITHM_VERSION: 'test',
        },
        '@/lib/operations/shopifyCheckoutPlanRatePolicy': planPolicy,
        '@/lib/operations/shopifyCheckoutRateWarmPolicy': rateWarmPolicy,
        '@/lib/operations/shopifyCheckoutAudiencePolicy': audiencePolicy,
        '@/lib/operations/shopifyCheckoutRateControl': rateControl,
        '@/lib/operations/authorization': {
          activeOperationsOrganizationId: () => ORGANIZATION_ID,
          operationsCapabilities: () => ({
            canManage: true,
            canActivate,
          }),
        },
        '@/lib/persistence/config': {
          isPostgresStorageEnabled: () => true,
        },
        '@/lib/persistence/commerceExternalEffects': {
          commerceExternalEffectHash: () => 'd'.repeat(64),
          readCommerceExternalEffectByIdempotencyFromPostgres:
            async () => null,
        },
        '@/lib/persistence/commerceIntegrations': {
          readCommerceIntegrationsStateFromPostgres: integrationState,
        },
        '@/lib/persistence/commerceStoreSync': {
          readCommerceStoreSyncControlsFromPostgres: async () => [
            SANDBOX_ACCOUNT_GLOBAL_ID,
            PRODUCTION_ACCOUNT_GLOBAL_ID,
          ].map((accountGlobalId) => ({
            accountGlobalId,
            provider: 'shopify',
            environment: accountGlobalId === SANDBOX_ACCOUNT_GLOBAL_ID
              ? 'sandbox'
              : 'production',
            displayName: accountGlobalId,
            accountStatus: 'active',
            desiredState: 'running',
            effectiveState: 'running',
            effectiveReason: 'STORE_SYNC_EXPLICIT_RUNNING',
            effectiveReasonLabel:
              'Running by an explicit Store sync choice.',
            explicitChoice: true,
            revision: 1,
            reason: 'Checkout audience fixture',
            updatedAt: '2026-08-15T12:00:00.000Z',
          })),
        },
        '@/lib/persistence/shopifyCustomerRatePolicies': {
          readShopifyCustomerRatePolicySummaryFromPostgres:
            async () => customerSummary,
        },
        '@/lib/persistence/shopifyCheckoutRating': {
          ...persistence,
          async readShopifyCarrierServiceConfigFromPostgres(input) {
            const config = await persistence
              .readShopifyCarrierServiceConfigFromPostgres(input)
            if (!config || !staleSetupRead) return config
            staleSetupRead = false
            return { ...config, rowVersion: config.rowVersion - 1 }
          },
        },
        '@/lib/persistence/shopifyCarrierServiceMutationAuthorization':
          mutationAuthorization,
        '@/lib/persistence/shopifyCarrierServiceSetup': {
          readShopifyCarrierServiceSetupReferenceFromPostgres:
            async () => setupReference,
        },
        '@/lib/publicUrl': {
          appPublicUrl: () => 'https://dev.example.test',
        },
        '@/lib/requestUser': {
          requireRequestUser: async () => ({
            email: ACTOR_EMAIL,
            role: 'owner',
            organizationId: ORGANIZATION_ID,
          }),
        },
        '@/lib/users': {
          effectiveAuthorizationRole: () => 'owner',
        },
      },
    )

    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'read_only', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [ORGANIZATION_ID],
    )

    const readOnlyCustomerGid = 'gid://shopify/Customer/293001'
    const createdReadOnlyPolicy =
      await customerPolicies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        customerGid: readOnlyCustomerGid,
        mode: 'include_only',
        serviceCodes: ['clawpilot:ups:03'],
        shadowTestChargeMode: 'carrier_rate',
        actorEmail: ACTOR_EMAIL,
      })
    assert.equal(createdReadOnlyPolicy.policy.status, 'simulated')
    assert.equal(createdReadOnlyPolicy.policy.providerState, 'not_written')
    assert.equal(createdReadOnlyPolicy.enforcement.activationState, 'read_only')
    assert.equal(createdReadOnlyPolicy.enforcement.defaultPolicy, 'hide_all')
    const eligibleReadOnlyPolicy =
      await customerPolicies
        .readShopifyCheckoutCustomerRatePolicyFromPostgres({
          organizationId: ORGANIZATION_ID,
          accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
          shopifyCustomerGid: readOnlyCustomerGid,
        })
    assert.equal(eligibleReadOnlyPolicy?.mode, 'include_only')
    assert.equal(
      JSON.stringify(eligibleReadOnlyPolicy?.serviceCodes),
      JSON.stringify(['clawpilot:ups:03']),
    )
    const updatedReadOnlyPolicy =
      await customerPolicies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        customerGid: readOnlyCustomerGid,
        mode: 'exclude',
        serviceCodes: ['clawpilot:ups:03'],
        shadowTestChargeMode: 'carrier_rate',
        shadowLifetimeMode: 'timed',
        shadowDurationMinutes: 60,
        expectedRowVersion: createdReadOnlyPolicy.policy.rowVersion,
        actorEmail: ACTOR_EMAIL,
      })
    assert.equal(updatedReadOnlyPolicy.policy.mode, 'exclude')
    const removedReadOnlyPolicy =
      await customerPolicies.removeShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        customerGid: readOnlyCustomerGid,
        expectedRowVersion: updatedReadOnlyPolicy.policy.rowVersion,
        actorEmail: ACTOR_EMAIL,
      })
    assert.equal(removedReadOnlyPolicy.policy.status, 'removed')
    assert.equal(
      await customerPolicies
        .readShopifyCheckoutCustomerRatePolicyFromPostgres({
          organizationId: ORGANIZATION_ID,
          accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
          shopifyCustomerGid: readOnlyCustomerGid,
        }),
      null,
    )

    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'active', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [ORGANIZATION_ID],
    )
    const activeCustomerGid = 'gid://shopify/Customer/293002'
    const createdActivePolicy =
      await customerPolicies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: PRODUCTION_ACCOUNT_GLOBAL_ID,
        customerGid: activeCustomerGid,
        mode: 'show_all',
        serviceCodes: [],
        shadowTestChargeMode: 'carrier_rate',
        actorEmail: ACTOR_EMAIL,
      })
    assert.equal(createdActivePolicy.policy.status, 'blocked')
    assert.equal(createdActivePolicy.enforcement.defaultPolicy, 'hide_all')
    assert.equal(
      await customerPolicies
        .readShopifyCheckoutCustomerRatePolicyFromPostgres({
          organizationId: ORGANIZATION_ID,
          accountGlobalId: PRODUCTION_ACCOUNT_GLOBAL_ID,
          shopifyCustomerGid: activeCustomerGid,
        }),
      null,
      'a blocked desired LIVE policy must never authorize checkout',
    )

    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'frozen', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [ORGANIZATION_ID],
    )
    const frozenCustomerGid = 'gid://shopify/Customer/293003'
    const frozenDesiredPolicy =
      await customerPolicies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        customerGid: frozenCustomerGid,
        mode: 'show_all',
        serviceCodes: [],
        shadowTestChargeMode: 'carrier_rate',
        actorEmail: ACTOR_EMAIL,
      })
    assert.equal(frozenDesiredPolicy.policy.status, 'simulated')
    assert.equal(frozenDesiredPolicy.policy.providerState, 'not_written')
    assert.equal(frozenDesiredPolicy.enforcement.activationState, 'frozen')
    assert.equal(frozenDesiredPolicy.enforcement.defaultPolicy, 'hide_all')
    assert.equal(
      frozenDesiredPolicy.enforcement.providerWritesPerformed,
      0,
    )
    const updatedFrozenDesiredPolicy =
      await customerPolicies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        customerGid: frozenCustomerGid,
        mode: 'include_only',
        serviceCodes: ['clawpilot:ups:03'],
        shadowLifetimeMode: 'timed',
        shadowDurationMinutes: 60,
        shadowTestChargeMode: 'carrier_rate',
        expectedRowVersion: frozenDesiredPolicy.policy.rowVersion,
        actorEmail: ACTOR_EMAIL,
      })
    assert.equal(updatedFrozenDesiredPolicy.policy.status, 'simulated')
    assert.equal(
      updatedFrozenDesiredPolicy.enforcement.providerWritesPerformed,
      0,
    )
    const frozenRemovedCustomerGid = 'gid://shopify/Customer/293005'
    const frozenRemovedPolicy =
      await customerPolicies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        customerGid: frozenRemovedCustomerGid,
        mode: 'show_all',
        serviceCodes: [],
        shadowTestChargeMode: 'carrier_rate',
        actorEmail: ACTOR_EMAIL,
      })
    const removedWhileFrozen =
      await customerPolicies.removeShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        customerGid: frozenRemovedCustomerGid,
        expectedRowVersion: frozenRemovedPolicy.policy.rowVersion,
        actorEmail: ACTOR_EMAIL,
      })
    assert.equal(removedWhileFrozen.policy.status, 'removed')
    assert.equal(removedWhileFrozen.enforcement.providerWritesPerformed, 0)
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'read_only', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [ORGANIZATION_ID],
    )
    assert.equal(
      (await customerPolicies
        .readShopifyCheckoutCustomerRatePolicyFromPostgres({
          organizationId: ORGANIZATION_ID,
          accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
          shopifyCustomerGid: frozenCustomerGid,
        }))?.mode,
      'include_only',
      'Frozen desired policy did not survive the transition to Read_only',
    )

    const beforeUnauthorized = await configRow(
      pool,
      SANDBOX_ACCOUNT_GLOBAL_ID,
    )
    canActivate = false
    const unauthorized = await route.POST(apiRequest({
      action: 'save-checkout-rate-control',
      accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
      expectedRowVersion: 1,
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1',
        audience: 'off',
        rateSource: 'sandbox',
      },
      reason: 'Unauthorized acceptance attempt',
    }, 'checkout-control:unauthorized:v1'))
    canActivate = true
    assert.equal(unauthorized.status, 403)
    assert.equal(
      unauthorized.body.code,
      'SHOPIFY_CARRIER_SERVICE_ACTIVATOR_REQUIRED',
    )
    assert.deepEqual(
      await configRow(pool, SANDBOX_ACCOUNT_GLOBAL_ID),
      beforeUnauthorized,
      'unauthorized control request changed the configuration',
    )

    let expectedRowVersion = 1
    let expectedPolicyRevision = 1
    for (const audience of [
      'restricted_customers',
      'off',
      'all_eligible',
    ]) {
      const before = await configRow(pool, SANDBOX_ACCOUNT_GLOBAL_ID)
      const idempotencyKey = `checkout-control:${audience}:v1`
      const requestBody = {
        action: 'save-checkout-rate-control',
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        expectedRowVersion,
        checkoutRateControl: {
          version: 'shopify-checkout-rate-control-v1',
          audience,
          rateSource: 'sandbox',
        },
        reason: `Acceptance control change to ${audience}`,
      }
      const response = await route.POST(apiRequest(
        requestBody,
        idempotencyKey,
      ))
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(response.body.ok, true)
      expectedRowVersion += 1
      expectedPolicyRevision += 1
      assert.deepEqual(JSON.parse(JSON.stringify(response.body.result)), {
        version: 'shopify-checkout-rate-control-command-result-v1',
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        configGlobalId: 'gscf2930001',
        idempotencyKey,
        requestHash: response.body.result.requestHash,
        checkoutRateControl: requestBody.checkoutRateControl,
        rowVersion: expectedRowVersion,
        policyRevision: expectedPolicyRevision,
        providerWrites: 0,
      })
      assert.match(response.body.result.requestHash, /^[a-f0-9]{64}$/u)
      const after = await configRow(pool, SANDBOX_ACCOUNT_GLOBAL_ID)
      assert.equal(Number(after.row_version), expectedRowVersion)
      assert.equal(Number(after.policy_revision), expectedPolicyRevision)
      assert.equal(
        after.policy_snapshot.checkoutRateControl.audience,
        audience,
      )
      assert.equal(
        after.policy_snapshot.checkoutRateControl.rateSource,
        'sandbox',
      )
      assert.equal(
        after.policy_hash,
        persistence.shopifyCheckoutRatingHash(after.policy_snapshot),
      )
      assert.equal(after.service_gid, RETAINED_SERVICE_GID)
      assert.equal(
        after.callback_token_version,
        RETAINED_CALLBACK_TOKEN_VERSION,
      )
      assert.equal(
        after.callback_token_hash,
        RETAINED_CALLBACK_TOKEN_HASH,
      )
      assert.equal(after.service_gid, before.service_gid)
      assert.equal(
        after.callback_token_hash,
        before.callback_token_hash,
      )
      const replay = await route.POST(apiRequest(
        requestBody,
        idempotencyKey,
      ))
      assert.equal(replay.status, 200)
      assert.equal(
        JSON.stringify(replay.body),
        JSON.stringify(response.body),
        'same key and body must replay the byte-stable retained result',
      )
      assert.deepEqual(await configRow(pool, SANDBOX_ACCOUNT_GLOBAL_ID), after)
      const conflictingReplay = await route.POST(apiRequest({
        ...requestBody,
        reason: `${requestBody.reason} changed`,
      }, idempotencyKey))
      assert.equal(conflictingReplay.status, 409)
      assert.equal(
        conflictingReplay.body.code,
        'SHOPIFY_CHECKOUT_RATE_CONTROL_IDEMPOTENCY_CONFLICT',
      )
    }

    const extraField = await route.POST(apiRequest({
      action: 'save-checkout-rate-control',
      accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
      expectedRowVersion,
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1',
        audience: 'off',
        rateSource: 'sandbox',
      },
      reason: 'Exact-field rejection acceptance',
      extra: true,
    }, 'checkout-control:extra-field:v1'))
    assert.equal(extraField.status, 400)
    assert.equal(
      extraField.body.code,
      'SHOPIFY_CHECKOUT_RATE_CONTROL_REQUEST_INVALID',
    )

    const sameKeyBody = {
      action: 'save-checkout-rate-control',
      accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
      expectedRowVersion,
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1',
        audience: 'off',
        rateSource: 'sandbox',
      },
      reason: 'Concurrent exact replay acceptance',
    }
    const sameKeyResponses = await Promise.all([
      route.POST(apiRequest(
        sameKeyBody,
        'checkout-control:concurrent-same:v1',
      )),
      route.POST(apiRequest(
        sameKeyBody,
        'checkout-control:concurrent-same:v1',
      )),
    ])
    assert.deepEqual(sameKeyResponses.map((item) => item.status), [200, 200])
    assert.equal(
      JSON.stringify(sameKeyResponses[0].body),
      JSON.stringify(sameKeyResponses[1].body),
    )
    expectedRowVersion += 1
    expectedPolicyRevision += 1

    const differentKeyResponses = await Promise.all([
      route.POST(apiRequest({
        ...sameKeyBody,
        expectedRowVersion,
        checkoutRateControl: {
          ...sameKeyBody.checkoutRateControl,
          audience: 'restricted_customers',
        },
        reason: 'Concurrent CAS contender one',
      }, 'checkout-control:concurrent-different-a:v1')),
      route.POST(apiRequest({
        ...sameKeyBody,
        expectedRowVersion,
        checkoutRateControl: {
          ...sameKeyBody.checkoutRateControl,
          audience: 'all_eligible',
        },
        reason: 'Concurrent CAS contender two',
      }, 'checkout-control:concurrent-different-b:v1')),
    ])
    assert.deepEqual(
      differentKeyResponses.map((item) => item.status).sort(),
      [200, 409],
    )
    assert.equal(
      differentKeyResponses.find((item) => item.status === 409)?.body.code,
      'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT',
    )
    expectedRowVersion += 1
    expectedPolicyRevision += 1

    const liveRestricted = await route.POST(apiRequest({
      action: 'save-checkout-rate-control',
      accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
      expectedRowVersion,
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1',
        audience: 'restricted_customers',
        rateSource: 'production',
      },
      reason: 'Save desired LIVE restricted control',
    }, 'checkout-control:switch-live:v1'))
    assert.equal(liveRestricted.status, 200, JSON.stringify(liveRestricted.body))
    expectedRowVersion += 1
    expectedPolicyRevision += 1
    const switchCustomerGid = 'gid://shopify/Customer/293004'
    const blockedLivePolicy =
      await customerPolicies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        customerGid: switchCustomerGid,
        mode: 'show_all',
        serviceCodes: [],
        shadowTestChargeMode: 'carrier_rate',
        actorEmail: ACTOR_EMAIL,
      })
    assert.equal(blockedLivePolicy.policy.status, 'blocked')
    assert.equal(
      await customerPolicies
        .readShopifyCheckoutCustomerRatePolicyFromPostgres({
          organizationId: ORGANIZATION_ID,
          accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
          shopifyCustomerGid: switchCustomerGid,
        }),
      null,
      'a desired LIVE policy authorized the restricted callback',
    )

    const testRestricted = await route.POST(apiRequest({
      action: 'save-checkout-rate-control',
      accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
      expectedRowVersion,
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1',
        audience: 'restricted_customers',
        rateSource: 'sandbox',
      },
      reason: 'Return to bounded TEST restricted proof',
    }, 'checkout-control:switch-test:v1'))
    assert.equal(testRestricted.status, 200, JSON.stringify(testRestricted.body))
    expectedRowVersion += 1
    expectedPolicyRevision += 1
    assert.equal(
      await customerPolicies
        .readShopifyCheckoutCustomerRatePolicyFromPostgres({
          organizationId: ORGANIZATION_ID,
          accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
          shopifyCustomerGid: switchCustomerGid,
        }),
      null,
      'switching LIVE to TEST reclassified a blocked policy implicitly',
    )
    const renewedTestPolicy =
      await customerPolicies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        customerGid: switchCustomerGid,
        mode: 'show_all',
        serviceCodes: [],
        shadowLifetimeMode: 'timed',
        shadowDurationMinutes: 60,
        shadowTestChargeMode: 'carrier_rate',
        expectedRowVersion: blockedLivePolicy.policy.rowVersion,
        actorEmail: ACTOR_EMAIL,
      })
    assert.equal(renewedTestPolicy.policy.status, 'simulated')
    assert.equal(
      (await customerPolicies
        .readShopifyCheckoutCustomerRatePolicyFromPostgres({
          organizationId: ORGANIZATION_ID,
          accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
          shopifyCustomerGid: switchCustomerGid,
        }))?.mode,
      'show_all',
      'explicit TEST renewal did not create a bounded eligible policy',
    )

    const beforeStale = await configRow(pool, SANDBOX_ACCOUNT_GLOBAL_ID)
    const stale = await route.POST(apiRequest({
      action: 'save-checkout-rate-control',
      accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
      expectedRowVersion: expectedRowVersion - 1,
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1',
        audience: 'off',
        rateSource: 'sandbox',
      },
      reason: 'Stale acceptance write',
    }, 'checkout-control:stale:v1'))
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT')
    assert.deepEqual(
      await configRow(pool, SANDBOX_ACCOUNT_GLOBAL_ID),
      beforeStale,
      'stale API write changed the CarrierService configuration',
    )

    const legacy = await route.POST(apiRequest({
      action: 'save-checkout-audience',
      accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
      shadowCheckoutAudience: {
        version: 'shopify-checkout-audience-v1',
        mode: 'off',
      },
    }))
    assert.equal(legacy.status, 410)
    assert.equal(
      legacy.body.code,
      'SHOPIFY_CHECKOUT_RATE_CONTROL_MIGRATION_REQUIRED',
    )

    const production = await route.POST(apiRequest({
      action: 'save-checkout-rate-control',
      accountGlobalId: PRODUCTION_ACCOUNT_GLOBAL_ID,
      expectedRowVersion: 1,
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1',
        audience: 'restricted_customers',
        rateSource: 'sandbox',
      },
      reason: 'Save desired TEST source while production serving stays empty',
    }, 'checkout-control:production-test-desired:v1'))
    assert.equal(production.status, 200, JSON.stringify(production.body))
    assert.equal(production.body.result.providerWrites, 0)
    assert.equal(
      (await configRow(pool, PRODUCTION_ACCOUNT_GLOBAL_ID))
        .policy_snapshot.checkoutRateControl.rateSource,
      'sandbox',
    )
    const productionTestCustomerGid = 'gid://shopify/Customer/293005'
    const productionTestPolicy =
      await customerPolicies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: PRODUCTION_ACCOUNT_GLOBAL_ID,
        customerGid: productionTestCustomerGid,
        mode: 'show_all',
        serviceCodes: [],
        shadowLifetimeMode: 'timed',
        shadowDurationMinutes: 60,
        shadowTestChargeMode: 'carrier_rate',
        actorEmail: ACTOR_EMAIL,
      })
    assert.equal(productionTestPolicy.policy.status, 'blocked')
    assert.equal(productionTestPolicy.policy.providerState, 'write_blocked')
    assert.equal(productionTestPolicy.policy.shadowLifetimeMode, null)
    assert.equal(productionTestPolicy.policy.shadowDurationMinutes, null)
    assert.equal(productionTestPolicy.policy.shadowExpiresAt, null)
    assert.equal(productionTestPolicy.policy.shadowTestChargeMode, 'carrier_rate')
    assert.equal(
      await customerPolicies
        .readShopifyCheckoutCustomerRatePolicyFromPostgres({
          organizationId: ORGANIZATION_ID,
          accountGlobalId: PRODUCTION_ACCOUNT_GLOBAL_ID,
          shopifyCustomerGid: productionTestCustomerGid,
        }),
      null,
      'production Shopify + Restricted TEST created an effective proof policy',
    )
    await assert.rejects(
      () => customerPolicies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: ORGANIZATION_ID,
        accountGlobalId: PRODUCTION_ACCOUNT_GLOBAL_ID,
        customerGid: productionTestCustomerGid,
        mode: 'show_all',
        serviceCodes: [],
        shadowLifetimeMode: 'timed',
        shadowDurationMinutes: 60,
        shadowTestChargeMode: 'zero_single_service',
        shadowTestServiceCode: 'clawpilot:ups:03',
        shadowTestSubsidyReason: 'Production TEST subsidy must stay blocked',
        expectedRowVersion: productionTestPolicy.policy.rowVersion,
        actorEmail: ACTOR_EMAIL,
      }),
      (error) => (
        error.code === 'SHOPIFY_CHECKOUT_TEST_SUBSIDY_REQUIRES_TEST_SOURCE'
        && error.status === 409
      ),
      'production Shopify TEST must reject proof-only subsidy semantics',
    )

    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'frozen', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [ORGANIZATION_ID],
    )
    const frozenOff = await route.POST(apiRequest({
      action: 'save-checkout-rate-control',
      accountGlobalId: PRODUCTION_ACCOUNT_GLOBAL_ID,
      expectedRowVersion: 2,
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1',
        audience: 'off',
        rateSource: 'sandbox',
      },
      reason: 'Dormant TEST source while frozen',
    }, 'checkout-control:frozen-off:v1'))
    assert.equal(frozenOff.status, 200, JSON.stringify(frozenOff.body))
    assert.equal(frozenOff.body.result.providerWrites, 0)

    await assert.rejects(
      pool.query(
        `INSERT INTO operations_shopify_checkout_rate_control_receipts (
           organization_id, integration_account_id, config_id,
           idempotency_key, request_hash, expected_row_version,
           prior_control, requested_control, resulting_row_version,
           resulting_policy_revision, response_json, reason, actor_email
         )
         SELECT
           organization_id, integration_account_id, config_id,
           'checkout-control:tampered-identity:v1', repeat('9', 64),
           expected_row_version, prior_control, requested_control,
           resulting_row_version, resulting_policy_revision,
           jsonb_set(
             jsonb_set(
               jsonb_set(
                 response_json,
                 '{accountGlobalId}',
                 '"gia9999999"'::jsonb
               ),
               '{idempotencyKey}',
               '"checkout-control:tampered-identity:v1"'::jsonb
             ),
             '{requestHash}',
             to_jsonb(repeat('9', 64))
           ),
           'Tampered identity receipt', actor_email
         FROM operations_shopify_checkout_rate_control_receipts
         WHERE organization_id = $1::uuid
         ORDER BY created_at
         LIMIT 1`,
        [ORGANIZATION_ID],
      ),
      /receipt response identity is invalid/u,
    )
    const retainedReceipt = await pool.query(
      `SELECT id::text
       FROM operations_shopify_checkout_rate_control_receipts
       WHERE organization_id = $1::uuid
       ORDER BY created_at
       LIMIT 1`,
      [ORGANIZATION_ID],
    )
    assert.ok(retainedReceipt.rows[0]?.id)
    await assert.rejects(
      pool.query(
        `UPDATE operations_shopify_checkout_rate_control_receipts
         SET reason = 'mutated'
         WHERE id = $1::uuid`,
        [retainedReceipt.rows[0].id],
      ),
      /control receipts are immutable/u,
    )
    await assert.rejects(
      pool.query(
        `DELETE FROM operations_shopify_checkout_rate_control_receipts
         WHERE id = $1::uuid`,
        [retainedReceipt.rows[0].id],
      ),
      /control receipts are immutable/u,
    )

    assert.equal(audits.length, 9)
    assert.equal(
      audits.filter((audit) => (
        audit.payload.checkoutRateControl.audience === 'off'
      )).length >= 2,
      true,
    )
    assert.ok(audits.every((audit) => (
      audit.eventType
        === 'operations.shopify_carrier_service.checkout_rate_control_updated'
      && audit.payload.providerRegistrationRetained === true
      && audit.payload.providerWrites === 0
    )))
  } finally {
    await pool.end()
  }
}

async function main() {
  const existingDatabaseUrl = String(
    process.env.SHOPIFY_CHECKOUT_AUDIENCE_ACCEPTANCE_DATABASE_URL || '',
  ).trim()
  if (existingDatabaseUrl) {
    await exercise(existingDatabaseUrl)
    console.log('Shopify checkout-audience API persistence acceptance passed')
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-checkout-audience-acceptance-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  let containerStarted = false
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=checkout_audience_acceptance',
      '-e', 'POSTGRES_DB=checkout_audience_acceptance',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    containerStarted = true
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:checkout_audience_acceptance@127.0.0.1:'
      + `${port}/checkout_audience_acceptance`
    )
    await waitForPostgres(databaseUrl)
    command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 300_000,
    })
    await exercise(databaseUrl)
    await exerciseHistoricalReceiptMigration(databaseUrl)
  } finally {
    if (containerStarted) {
      const stopped = spawnSync('docker', ['stop', container], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      })
      if (stopped.error) throw stopped.error
    }
  }
  console.log('Shopify checkout-audience API persistence acceptance passed')
}

await main()
