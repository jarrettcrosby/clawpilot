#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    env: { ...process.env, ...options.env },
  })
  if (result.error || result.status !== 0) {
    throw result.error || new Error(
      `${binary} ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    )
  }
  return String(result.stdout || '').trim()
}

async function waitForPostgres(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000 })
  const deadline = Date.now() + 60_000
  try {
    while (Date.now() < deadline) {
      try {
        await pool.query('SELECT 1')
        return
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
      }
    }
  } finally {
    await pool.end().catch(() => undefined)
  }
  throw new Error('Disposable PostgreSQL did not become ready')
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
    BigInt,
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
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

function postgresAdapter(pool) {
  return {
    query: (sql, params = []) => pool.query(sql, params),
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

async function expectRejected(work, predicate, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${message}: expected rejection`)
  assert.ok(
    predicate(error),
    `${message}: ${String(error?.code || '')} ${String(error?.message || error)}`,
  )
}

async function seedUser(pool, input) {
  await pool.query(
    `INSERT INTO app_users (email, role, status)
     VALUES ($1, $2, 'active')`,
    [input.email, input.appRole || 'member'],
  )
}

async function seedTenant(pool, label) {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `authority-owner-${label}-${suffix}@example.test`
  const adminEmail = `authority-admin-${label}-${suffix}@example.test`
  const restrictedAdminEmail =
    `authority-restricted-${label}-${suffix}@example.test`
  await seedUser(pool, { email: ownerEmail, appRole: 'owner' })
  await seedUser(pool, { email: adminEmail })
  await seedUser(pool, { email: restrictedAdminEmail })
  const organization = await pool.query(
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ($1, 'root', $2, $2)
     RETURNING id::text`,
    [`Authority ${label} ${suffix}`, ownerEmail],
  )
  const organizationId = organization.rows[0].id
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES
       ($1, $4::uuid, 'owner', '{"manageOperations":true}'::jsonb,
        'active', true, $1, $1),
       ($2, $4::uuid, 'admin', '{"manageOperations":true}'::jsonb,
        'active', true, $1, $1),
       ($3, $4::uuid, 'admin', '{"manageOperations":false}'::jsonb,
        'active', true, $1, $1)`,
    [ownerEmail, adminEmail, restrictedAdminEmail, organizationId],
  )

  async function account(provider, environment, status = 'active') {
    const externalAccountId = `${provider}-${label}-${environment}-${suffix}`
    const result = await pool.query(
      `INSERT INTO operations_integration_accounts (
         organization_id, provider, integration_type, environment,
         display_name, status, configuration, external_account_id,
         commerce_credential_generation, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, 'commerce', $3, $4, $5, '{}'::jsonb, $6, 1, $7, $7
       ) RETURNING id::text, global_id`,
      [
        organizationId,
        provider,
        environment,
        `${provider} ${environment} ${label}`,
        status,
        externalAccountId,
        ownerEmail,
      ],
    )
    const seeded = result.rows[0]
    await pool.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         webhook_verified_at, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, decode('01', 'hex'),
         decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex'),
         1, 'test', 'verified', now(), $5,
         CASE WHEN $5 = 'verified' THEN now() ELSE NULL END, $6, $6
       )`,
      [
        organizationId,
        seeded.id,
        externalAccountId,
        provider === 'shopify'
          ? 'shopify_client_credentials' : 'faire_brand_token',
        provider === 'shopify' ? 'verified' : 'not_applicable',
        ownerEmail,
      ],
    )
    if (provider === 'shopify') {
      await pool.query(
        `UPDATE operations_integration_accounts
         SET configuration = jsonb_build_object(
               'orderWebhookSubscriptions', jsonb_build_object(
                 'accountGlobalId', global_id,
                 'credentialGeneration', commerce_credential_generation,
                 'desiredUri',
                   'https://authority.example.test/api/integrations/commerce/shopify/webhooks/'
                     || global_id,
                 'requiredTopics', jsonb_build_array(
                   'orders/create', 'orders/updated', 'orders/edited',
                   'orders/cancelled', 'orders/paid', 'orders/fulfilled',
                   'orders/partially_fulfilled'
                 ),
                 'requiredIncludeFields', jsonb_build_array(
                   'admin_graphql_api_id', 'updated_at'
                 ),
                 'observedCount', 7,
                 'matchingCount', 7,
                 'missingTopics', '[]'::jsonb,
                 'conflictingTopics', '[]'::jsonb,
                 'subscriptionReady', true,
                 'processorState', 'available',
                 'exactReadProcessorReady', true,
                 'scheduledPollBackstop', true,
                 'ready', true,
                 'observedAt', to_jsonb(now()),
                 'discoveryState', 'succeeded',
                 'discoveryErrorCode', NULL,
                 'providerWrites', 0
               )
             ),
             updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [organizationId, seeded.id],
      )
    }
    return { ...seeded, provider, environment, status, externalAccountId }
  }

  const shopify = await account('shopify', 'sandbox')
  const faire = await account('faire', 'sandbox')
  const disabled = await account('shopify', 'mock', 'disabled')
  return {
    organizationId,
    ownerEmail,
    adminEmail,
    restrictedAdminEmail,
    shopify,
    faire,
    disabled,
  }
}

async function seedStaleReadinessEvidence(pool, tenant) {
  const warehouse = await pool.query(
    `INSERT INTO pipeline_spaces (
       name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1, $2, false, $3::uuid)
     RETURNING id::text`,
    ['Authority readiness pipeline', tenant.ownerEmail, tenant.organizationId],
  )
  await pool.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, revision, reason, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shadow', 1,
       'Authority readiness acceptance', $3
     )`,
    [tenant.organizationId, warehouse.rows[0].id, tenant.ownerEmail],
  )
  await pool.query(
    `INSERT INTO operations_commerce_order_sync_policies (
       organization_id, integration_account_id, historical_observation_enabled,
       continuous_observation_enabled, continuous_transport,
       provider_event_processor_state, revision, continuous_high_watermark,
       continuous_next_poll_at, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, true, true, 'scheduled_poll',
       'processor_pending', 1, now() - interval '31 minutes',
       now() - interval '1 minute', $3, $3
     )`,
    [tenant.organizationId, tenant.shopify.id, tenant.ownerEmail],
  )
  await pool.query(
    `INSERT INTO operations_commerce_sync_cursors (
       organization_id, integration_account_id, resource,
       reconciliation_status, last_started_at, last_completed_at
     ) VALUES (
       $1::uuid, $2::uuid, 'orders', 'succeeded',
       now() - interval '1 minute', now()
     )`,
    [tenant.organizationId, tenant.shopify.id],
  )
  await pool.query(
    `INSERT INTO operations_commerce_order_backfill_sessions (
       organization_id, integration_account_id, provider, session_kind,
       credential_generation, policy_revision, coverage_basis, status,
       requested_from, requested_through, idempotency_key, request_hash,
       query_hash, requested_by, reason
     ) VALUES (
       $1::uuid, $2::uuid, 'shopify', 'historical_backfill', 1, 1,
       'shopify_rolling_60_days', 'pending',
       date_trunc('milliseconds', statement_timestamp()) - interval '60 days',
       date_trunc('milliseconds', statement_timestamp()),
       'history-readiness-0001', repeat('8', 64), repeat('9', 64), $3,
       'Completed historical readiness evidence'
     )`,
    [tenant.organizationId, tenant.shopify.id, tenant.ownerEmail],
  )
  await pool.query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = 'processing',
         attempt_count = attempt_count + 1,
         locked_at = now(),
         locked_by = 'authority-readiness-fixture',
         lock_token = gen_random_uuid(),
         lease_expires_at = now() + interval '10 minutes',
         started_at = COALESCE(started_at, now()),
         last_error_code = NULL,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND idempotency_key = 'history-readiness-0001'`,
    [tenant.organizationId, tenant.shopify.id],
  )
  await pool.query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = 'succeeded',
         read_all_orders_scope_observed = CASE
           WHEN session_kind = 'historical_backfill' THEN true
           ELSE false
         END,
         completeness_state = CASE
           WHEN session_kind = 'historical_backfill'
             THEN 'shopify_fixed_window_orders_complete'
           ELSE 'unknown'
         END,
         page_count = page_count + 1,
         attempt_count = 0,
         locked_at = NULL,
         locked_by = NULL,
         lock_token = NULL,
         lease_expires_at = NULL,
         completed_at = now(),
         available_at = now(),
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND status = 'processing'
       AND idempotency_key = 'history-readiness-0001'`,
    [tenant.organizationId, tenant.shopify.id],
  )
  await pool.query(
    `INSERT INTO operations_commerce_order_backfill_sessions (
       organization_id, integration_account_id, provider, session_kind,
       credential_generation, policy_revision, coverage_basis, status,
       requested_from, requested_through, idempotency_key, request_hash,
       query_hash, requested_by, reason
     ) VALUES (
       $1::uuid, $2::uuid, 'shopify', 'continuous_poll', 1, 1,
       'shopify_updated_at_overlap', 'pending',
       date_trunc('milliseconds', statement_timestamp()) - interval '30 minutes',
       date_trunc('milliseconds', statement_timestamp()),
       'continuous-readiness-0001', repeat('a', 64), repeat('b', 64), $3,
       'Stale continuous readiness evidence'
     )`,
    [tenant.organizationId, tenant.shopify.id, tenant.ownerEmail],
  )
  await pool.query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = 'processing',
         attempt_count = attempt_count + 1,
         locked_at = now(),
         locked_by = 'authority-readiness-fixture',
         lock_token = gen_random_uuid(),
         lease_expires_at = now() + interval '10 minutes',
         started_at = COALESCE(started_at, now()),
         last_error_code = NULL,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND idempotency_key = 'continuous-readiness-0001'`,
    [tenant.organizationId, tenant.shopify.id],
  )
  await pool.query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = 'succeeded',
         read_all_orders_scope_observed = false,
         completeness_state = 'unknown',
         page_count = page_count + 1,
         attempt_count = 0,
         locked_at = NULL,
         locked_by = NULL,
         lock_token = NULL,
         lease_expires_at = NULL,
         completed_at = now(),
         available_at = now(),
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND status = 'processing'
       AND idempotency_key = 'continuous-readiness-0001'`,
    [tenant.organizationId, tenant.shopify.id],
  )
  const physicalWarehouse = await pool.query(
    `INSERT INTO operations_warehouses (
       organization_id, code, name, created_by
     ) VALUES ($1::uuid, $2, 'Authority inventory warehouse', $3)
     RETURNING id::text`,
    [tenant.organizationId, `AUTH-${randomUUID().slice(0, 8)}`, tenant.ownerEmail],
  )
  const config = await pool.query(
    `INSERT INTO operations_shopify_carrier_service_configs (
       organization_id, integration_account_id, warehouse_id,
       registration_state, credential_generation, activation_revision,
       callback_token_version, callback_token_hash, policy_revision,
       policy_hash, policy_snapshot, inventory_max_age_seconds,
       quote_ttl_seconds, order_reconciliation_window_seconds,
       algorithm_version, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'unconfigured', 1, 1, 1,
       repeat('c', 64), 1, repeat('d', 64),
       jsonb_build_object(
         'planRateOptimization', jsonb_build_object(
           'version', 'shopify-checkout-plan-rate-objective-v2',
           'maxCandidates', 4,
           'objectivePriority', jsonb_build_array(
             'landed_price', 'package_count', 'unused_cube'
           ),
           'handlingCostMinorPerPackage', 0,
           'handlingCostCurrency', 'USD'
         ),
         'checkoutRateWarm', jsonb_build_object(
           'version', 'shopify-checkout-rate-warm-v1',
           'enabled', false,
           'mode', 'hosted_ajax',
           'zoneScope', 'all_saved_rate_zones',
           'concurrency', 2,
           'debounceMs', 350,
           'minIntervalMs', 1000,
           'supportedCountries', jsonb_build_array('US'),
           'staleCartAbort', true
         ),
         'checkoutRateControl', jsonb_build_object(
           'version', 'shopify-checkout-rate-control-v1',
           'audience', 'restricted_customers',
           'rateSource', 'sandbox'
         )
       ), 60, 30, 60,
       'authority-readiness-v1', $4, $4
     ) RETURNING id::text, row_version`,
    [
      tenant.organizationId,
      tenant.shopify.id,
      physicalWarehouse.rows[0].id,
      tenant.ownerEmail,
    ],
  )
  await pool.query(
    `INSERT INTO operations_shopify_inventory_refresh_jobs (
       organization_id, integration_account_id, carrier_service_config_id,
       warehouse_id, credential_generation, activation_revision,
       config_row_version, policy_revision, policy_hash,
       inventory_max_age_seconds, status, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, $5::bigint, 1,
       repeat('d', 64), 60, 'succeeded', now() - interval '2 minutes'
     )`,
    [
      tenant.organizationId,
      tenant.shopify.id,
      config.rows[0].id,
      physicalWarehouse.rows[0].id,
      config.rows[0].row_version,
    ],
  )
  await pool.query(
    `INSERT INTO operations_shopify_inventory_refresh_watermarks (
       organization_id, integration_account_id, credential_generation,
       dirty_version, reconciled_version, last_reconciled_at
     ) VALUES ($1::uuid, $2::uuid, 1, 0, 0, now() - interval '2 minutes')`,
    [tenant.organizationId, tenant.shopify.id],
  )
  await pool.query(
    `INSERT INTO operations_faire_inventory_poll_jobs (
       organization_id, integration_account_id, credential_version,
       activation_revision, status, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, 1, 1, 'succeeded', now() - interval '31 minutes'
     )`,
    [tenant.organizationId, tenant.faire.id],
  )
  await pool.query(
    `INSERT INTO operations_commerce_order_sync_policies (
       organization_id, integration_account_id, historical_observation_enabled,
       continuous_observation_enabled, continuous_transport,
       provider_event_processor_state, revision, continuous_high_watermark,
       continuous_next_poll_at, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, true, true, 'scheduled_poll',
       'unsupported', 1, now(), now() + interval '5 minutes', $3, $3
     )`,
    [tenant.organizationId, tenant.faire.id, tenant.ownerEmail],
  )
  await pool.query(
    `WITH fixture_clock AS (
       SELECT date_trunc('milliseconds', clock_timestamp()) AS clock
     )
     INSERT INTO operations_commerce_order_backfill_sessions (
       organization_id, integration_account_id, provider, session_kind,
       credential_generation, policy_revision, coverage_basis, status,
       requested_from, requested_through, idempotency_key, request_hash,
       query_hash, requested_by, reason
     )
     SELECT $1::uuid, $2::uuid, 'faire', 'historical_backfill', 1, 1,
            'faire_provider_available_orders', 'pending', NULL, fixture_clock.clock,
            'faire-history-readiness-0001', repeat('1', 64), repeat('2', 64),
            $3, 'Provider-available Faire order history evidence'
     FROM fixture_clock`,
    [tenant.organizationId, tenant.faire.id, tenant.ownerEmail],
  )
  await pool.query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = 'processing', attempt_count = attempt_count + 1,
         locked_at = now(), locked_by = 'authority-readiness-fixture',
         lock_token = gen_random_uuid(),
         lease_expires_at = now() + interval '10 minutes',
         started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND idempotency_key = 'faire-history-readiness-0001'`,
    [tenant.organizationId, tenant.faire.id],
  )
  await pool.query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = 'succeeded', page_count = page_count + 1,
         attempt_count = 0,
         completeness_state = 'faire_provider_available_orders_complete',
         read_all_orders_scope_observed = NULL,
         return_history_state = 'provider_embedded',
         locked_at = NULL, locked_by = NULL, lock_token = NULL,
         lease_expires_at = NULL, completed_at = now(),
         available_at = now(), updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND idempotency_key = 'faire-history-readiness-0001'`,
    [tenant.organizationId, tenant.faire.id],
  )
  await pool.query(
    `WITH fixture_clock AS (
       SELECT date_trunc('milliseconds', clock_timestamp()) AS clock
     )
     INSERT INTO operations_commerce_order_backfill_sessions (
       organization_id, integration_account_id, provider, session_kind,
       credential_generation, policy_revision, coverage_basis, status,
       requested_from, requested_through, idempotency_key, request_hash,
       query_hash, requested_by, reason
     )
     SELECT $1::uuid, $2::uuid, 'faire', 'continuous_poll', 1, 1,
            'faire_updated_at_overlap_unfenced', 'pending',
            fixture_clock.clock - interval '5 minutes', fixture_clock.clock,
            'faire-continuous-readiness-0001', repeat('3', 64), repeat('4', 64),
            $3, 'Current five-minute Faire order observation evidence'
     FROM fixture_clock`,
    [tenant.organizationId, tenant.faire.id, tenant.ownerEmail],
  )
  await pool.query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = 'processing', attempt_count = attempt_count + 1,
         locked_at = now(), locked_by = 'authority-readiness-fixture',
         lock_token = gen_random_uuid(),
         lease_expires_at = now() + interval '10 minutes',
         started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND idempotency_key = 'faire-continuous-readiness-0001'`,
    [tenant.organizationId, tenant.faire.id],
  )
  await pool.query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = 'succeeded', page_count = page_count + 1,
         attempt_count = 0, completeness_state = 'unknown',
         read_all_orders_scope_observed = NULL,
         return_history_state = 'provider_embedded',
         locked_at = NULL, locked_by = NULL, lock_token = NULL,
         lease_expires_at = NULL, completed_at = now(),
         available_at = now(), updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND idempotency_key = 'faire-continuous-readiness-0001'`,
    [tenant.organizationId, tenant.faire.id],
  )
}

function apiRequest(method, body, idempotencyKey) {
  const request = new Request(
    'http://localhost/api/integrations/commerce/authority-policies',
    {
      method,
      headers: body ? {
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
  )
  Object.defineProperty(request, 'nextUrl', {
    value: new URL(request.url),
  })
  return request
}

async function seedBlockedScopeEvidence(pool, tenant) {
  const pipeline = await pool.query(
    `INSERT INTO pipeline_spaces (
       name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1, $2, true, $3::uuid)
     RETURNING id::text`,
    ['Authority lineage pipeline', tenant.ownerEmail, tenant.organizationId],
  )
  const pipelineId = pipeline.rows[0].id
  const product = await pool.query(
    `INSERT INTO crm_products (
       pipeline_id, source_key, name, sku, source_hash, sync_status,
       created_by, updated_by
     ) VALUES ($1::uuid, $2, $3, $4, repeat('1', 64), 'synced', $5, $5)
     RETURNING id::text, reference_code`,
    [pipelineId, `authority-product-${randomUUID()}`, 'Lineage product', 'LINEAGE', tenant.ownerEmail],
  )
  const customer = await pool.query(
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, identity_key, name, source_hash, sync_status,
       created_by, updated_by
     ) VALUES ($1::uuid, $2, $2, $3, repeat('2', 64), 'synced', $4, $4)
     RETURNING id::text, reference_code`,
    [pipelineId, `authority-customer-${randomUUID()}`, 'Lineage customer', tenant.ownerEmail],
  )
  const mapping = await pool.query(
    `INSERT INTO operations_product_mappings (
       organization_id, integration_account_id, pipeline_id, product_id,
       channel_sku, external_product_id, external_variant_id,
       external_inventory_item_id, mapping_method, mapping_source_revision,
       active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'LINEAGE',
       'gid://shopify/Product/lineage', 'gid://shopify/ProductVariant/lineage',
       'gid://shopify/InventoryItem/lineage', 'exact_variant', 'lineage-v1',
       true, $5
     ) RETURNING id::text, global_id, updated_at`,
    [
      tenant.organizationId,
      tenant.shopify.id,
      pipelineId,
      product.rows[0].id,
      tenant.ownerEmail,
    ],
  )
  const channel = await pool.query(
    `INSERT INTO operations_product_channel_states (
       organization_id, integration_account_id, pipeline_id, provider,
       external_product_id, external_variant_id, external_inventory_item_id,
       product_id, product_mapping_id, provider_status_raw,
       normalized_status, provider_active, observed_at, source_revision,
       source_hash, row_version, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'shopify',
       'gid://shopify/Product/lineage', 'gid://shopify/ProductVariant/lineage',
       'gid://shopify/InventoryItem/lineage', $4::uuid, $5::uuid,
       'UNLISTED', 'unlisted', true, now(), 'lineage-v1', repeat('3', 64),
       4, $6, $6
     ) RETURNING id::text, row_version, source_hash, observed_at`,
    [
      tenant.organizationId,
      tenant.shopify.id,
      pipelineId,
      product.rows[0].id,
      mapping.rows[0].id,
      tenant.ownerEmail,
    ],
  )
  const currentMapping = await pool.query(
    `SELECT updated_at::text AS updated_at
     FROM operations_product_mappings
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [tenant.organizationId, mapping.rows[0].id],
  )
  mapping.rows[0].updated_at = currentMapping.rows[0].updated_at
  const currentChannel = await pool.query(
    `SELECT row_version, source_hash, observed_at::text AS observed_at
     FROM operations_product_channel_states
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [tenant.organizationId, channel.rows[0].id],
  )
  channel.rows[0] = { ...channel.rows[0], ...currentChannel.rows[0] }
  return {
    pipelineId,
    product: product.rows[0],
    customer: customer.rows[0],
    mapping: mapping.rows[0],
    channel: channel.rows[0],
  }
}

async function insertBlockedScope(pool, tenant, evidence, input = {}) {
  return pool.query(
    `INSERT INTO operations_commerce_provider_write_scope_requests (
       organization_id, integration_account_id, pipeline_id, customer_id,
       product_mapping_id, product_id, provider, account_environment,
       deployment_scope, requested_resources, state, provider_write_enabled,
       supported_outbound_effect, blocker_codes, account_global_id,
       external_account_id, customer_global_id, product_global_id,
       product_mapping_global_id,
       channel_sku, external_product_id, external_variant_id,
       external_inventory_item_id, credential_generation,
       product_mapping_updated_at, channel_state_id, channel_state_row_version,
       channel_state_source_hash, channel_state_observed_at, request_reason,
       recorded_by, recorded_role, idempotency_key, request_hash
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
       'shopify', 'sandbox', 'development', ARRAY['orders','inventory']::text[],
       'blocked', false, NULL, ARRAY[
         'COMMERCE_ORDER_WRITE_ADAPTER_UNAVAILABLE',
         'COMMERCE_CUSTOMER_SCOPED_INVENTORY_NOT_REPRESENTABLE'
       ]::text[], $7, $8, $9, $10, $11, 'LINEAGE',
       'gid://shopify/Product/lineage',
       'gid://shopify/ProductVariant/lineage',
       'gid://shopify/InventoryItem/lineage', $19::integer, $12::timestamptz,
       $13::uuid, $14::bigint, $15, $16::timestamptz,
       'Synthetic blocked-lineage acceptance evidence', $17, 'owner', $18,
       repeat('4', 64)
     ) RETURNING global_id`,
    [
      tenant.organizationId,
      tenant.shopify.id,
      evidence.pipelineId,
      evidence.customer.id,
      evidence.mapping.id,
      evidence.product.id,
      tenant.shopify.global_id,
      tenant.shopify.externalAccountId,
      evidence.customer.reference_code,
      evidence.product.reference_code,
      evidence.mapping.global_id,
      input.mappingUpdatedAt || evidence.mapping.updated_at,
      evidence.channel.id,
      input.channelRowVersion ?? evidence.channel.row_version,
      evidence.channel.source_hash,
      evidence.channel.observed_at,
      tenant.ownerEmail,
      `blocked-${randomUUID()}`,
      input.credentialGeneration ?? 1,
    ],
  )
}

async function verify(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
  })
  const audits = []
  try {
    const primary = await seedTenant(pool, 'primary')
    const other = await seedTenant(pool, 'other')
    await seedStaleReadinessEvidence(pool, primary)
    const domain = loadTypeScriptModule(
      'app_src/lib/integrations/commerceAuthorityPolicy.ts',
    )
    const persistence = loadTypeScriptModule(
      'app_src/lib/persistence/commerceAuthorityPolicies.ts',
      {
        '@/lib/auditWriter': {
          async recordAuditEvent(event) {
            audits.push(event)
          },
        },
        '@/lib/integrations/commerceAuthorityPolicy': domain,
        '@/lib/integrations/shopifyOrderWebhook': {
          SHOPIFY_ORDER_WEBHOOK_DISCOVERY_MAX_AGE_SECONDS: 86_400,
        },
        '@/lib/persistence/postgres': postgresAdapter(pool),
      },
    )
    let actor = null
    const route = loadTypeScriptModule(
      'app_src/app/api/integrations/commerce/authority-policies/route.ts',
      {
        'next/server': {
          NextResponse: {
            json(body, init = {}) {
              return { body, status: init.status || 200, headers: init.headers }
            },
          },
        },
        '@/lib/operations/authorization': {
          activeOperationsOrganizationId(current) {
            return current.organizationId
          },
          operationsCapabilities(current) {
            return current.capabilities
          },
        },
        '@/lib/persistence/config': {
          isPostgresStorageEnabled() {
            return true
          },
        },
        '@/lib/persistence/commerceAuthorityPolicies': persistence,
        '@/lib/requestUser': {
          async requireRequestUser() {
            return actor
          },
        },
        '@/lib/users': {
          effectiveAuthorizationRole(current) {
            return current.role
          },
        },
      },
    )
    const asActor = (email, role, organizationId, capabilities) => ({
      email, role, organizationId, capabilities,
    })
    const owner = asActor(
      primary.ownerEmail,
      'owner',
      primary.organizationId,
      { canManage: true, canActivate: true },
    )
    const admin = asActor(
      primary.adminEmail,
      'admin',
      primary.organizationId,
      { canManage: true, canActivate: true },
    )
    actor = owner
    const stateResponse = await route.GET(apiRequest('GET'))
    assert.equal(stateResponse.status, 200)
    assert.ok(stateResponse.body.state.policies.length >= 6)
    assert.ok(stateResponse.body.state.policies.every((policy) => (
      [primary.shopify.global_id, primary.faire.global_id, primary.disabled.global_id]
        .includes(policy.accountGlobalId)
    )))
    const disabledPolicy = stateResponse.body.state.policies.find(
      (policy) => policy.accountGlobalId === primary.disabled.global_id,
    )
    assert.equal(disabledPolicy.actualReadiness.state, 'unavailable')
    assert.equal(disabledPolicy.actualReadiness.policyChangeAllowed, false)
    const faireInventory = stateResponse.body.state.policies.find(
      (policy) => policy.accountGlobalId === primary.faire.global_id
        && policy.resource === 'inventory',
    )
    assert.equal(faireInventory.authorityMode, 'observation_only')
    assert.equal(faireInventory.desiredIngestMode, 'observation_only')
    assert.equal(faireInventory.actualReadiness.state, 'observation_only')
    assert.equal(
      faireInventory.actualReadiness.evidence.faireInventoryObservationFresh,
      false,
    )
    assert.ok(faireInventory.actualReadiness.blockerCodes.includes(
      'COMMERCE_FAIRE_INVENTORY_OBSERVATION_STALE',
    ))
    const faireOrders = stateResponse.body.state.policies.find(
      (policy) => policy.accountGlobalId === primary.faire.global_id
        && policy.resource === 'orders',
    )
    assert.equal(
      faireOrders.desiredIngestMode,
      'provider_available_history_and_continuous_poll',
    )
    assert.equal(faireOrders.actualReadiness.state, 'ready')
    assert.equal(
      faireOrders.actualReadiness.evidence.continuousTransport,
      'scheduled_poll',
    )
    assert.equal(
      faireOrders.actualReadiness.evidence.providerEventProcessorState,
      'unsupported',
    )
    assert.equal(
      faireOrders.actualReadiness.evidence.continuousTransportAvailable,
      true,
    )
    assert.equal(
      faireOrders.actualReadiness.evidence.realtimeTransportAvailable,
      false,
    )
    assert.equal(faireOrders.actualReadiness.blockerCodes.length, 0)
    const shopifyOrders = stateResponse.body.state.policies.find(
      (policy) => policy.accountGlobalId === primary.shopify.global_id
        && policy.resource === 'orders',
    )
    assert.equal(shopifyOrders.actualReadiness.state, 'degraded')
    assert.equal(
      shopifyOrders.actualReadiness.evidence
        .historicalBackfillCompletenessState,
      'shopify_fixed_window_orders_complete',
      'A later continuous poll must not erase completed historical coverage',
    )
    assert.equal(
      shopifyOrders.actualReadiness.evidence.continuousPollStatus,
      'succeeded',
    )
    assert.equal(
      shopifyOrders.actualReadiness.evidence.continuousPollFresh,
      false,
    )
    assert.equal(
      shopifyOrders.actualReadiness.evidence.realtimeTransportAvailable,
      false,
    )
    assert.ok(shopifyOrders.actualReadiness.blockerCodes.includes(
      'COMMERCE_ORDER_CONTINUOUS_POLL_STALE',
    ))
    assert.ok(shopifyOrders.actualReadiness.blockerCodes.includes(
      'COMMERCE_ORDER_EVENT_PROCESSOR_PENDING',
    ))
    const orderMirrorReadinessBeforeCursorChange = JSON.stringify({
      state: shopifyOrders.actualReadiness.state,
      blockerCodes: shopifyOrders.actualReadiness.blockerCodes,
      historicalBackfillCompletenessState:
        shopifyOrders.actualReadiness.evidence
          .historicalBackfillCompletenessState,
      continuousPollStatus:
        shopifyOrders.actualReadiness.evidence.continuousPollStatus,
      continuousPollFresh:
        shopifyOrders.actualReadiness.evidence.continuousPollFresh,
    })
    await pool.query(
      `UPDATE operations_commerce_sync_cursors
       SET reconciliation_status = 'failed',
           last_error_code = 'UNRELATED_INTAKE_CURSOR_FAILURE',
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'orders'`,
      [primary.organizationId, primary.shopify.id],
    )
    const afterCursorChange = await route.GET(apiRequest('GET'))
    const shopifyOrdersAfterCursorChange =
      afterCursorChange.body.state.policies.find(
        (policy) => policy.accountGlobalId === primary.shopify.global_id
          && policy.resource === 'orders',
      )
    assert.equal(JSON.stringify({
      state: shopifyOrdersAfterCursorChange.actualReadiness.state,
      blockerCodes:
        shopifyOrdersAfterCursorChange.actualReadiness.blockerCodes,
      historicalBackfillCompletenessState:
        shopifyOrdersAfterCursorChange.actualReadiness.evidence
          .historicalBackfillCompletenessState,
      continuousPollStatus:
        shopifyOrdersAfterCursorChange.actualReadiness.evidence
          .continuousPollStatus,
      continuousPollFresh:
        shopifyOrdersAfterCursorChange.actualReadiness.evidence
          .continuousPollFresh,
    }), orderMirrorReadinessBeforeCursorChange)

    await pool.query(
      `WITH fixture_clock AS (
         SELECT date_trunc('milliseconds', clock_timestamp()) AS clock
       )
       INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, idempotency_key, request_hash,
         query_hash, requested_by, reason
       )
       SELECT $1::uuid, $2::uuid, 'shopify', 'historical_backfill', 1, 1,
              'shopify_rolling_60_days', 'pending',
              fixture_clock.clock - interval '60 days', fixture_clock.clock,
              'stale-lineage-history-0001', repeat('c', 64), repeat('d', 64),
              $3, 'Historical evidence before policy rotation'
       FROM fixture_clock`,
      [primary.organizationId, primary.shopify.id, primary.ownerEmail],
    )
    const staleHistoricalClaim = await pool.query(
      `UPDATE operations_commerce_order_backfill_sessions
       SET status = 'processing', attempt_count = 1,
           locked_at = now(), locked_by = 'authority-readiness-fixture',
           lock_token = gen_random_uuid(),
           lease_expires_at = now() + interval '10 minutes',
           started_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND idempotency_key = 'stale-lineage-history-0001'
       RETURNING id::text`,
      [primary.organizationId, primary.shopify.id],
    )
    assert.equal(staleHistoricalClaim.rowCount, 1)
    await pool.query(
      `UPDATE operations_commerce_order_backfill_sessions
       SET status = 'succeeded', page_count = 1, attempt_count = 0,
           read_all_orders_scope_observed = true,
           return_history_state = 'unavailable',
           completeness_state = 'shopify_fixed_window_orders_complete',
           locked_at = NULL, locked_by = NULL, lock_token = NULL,
           lease_expires_at = NULL, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [staleHistoricalClaim.rows[0].id],
    )
    await pool.query(
      `UPDATE operations_commerce_order_sync_policies
       SET continuous_transport = 'webhook_signal_plus_poll',
           provider_event_processor_state = 'available',
           revision = 2,
           continuous_high_watermark = now(),
           continuous_next_poll_at = now() + interval '20 minutes',
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    await pool.query(
      `WITH fixture_clock AS (
         SELECT date_trunc('milliseconds', clock_timestamp()) AS clock
       )
       INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, idempotency_key, request_hash,
         query_hash, requested_by, reason
       )
       SELECT $1::uuid, $2::uuid, 'shopify', 'continuous_poll',
              1, 2, 'shopify_updated_at_overlap', 'pending',
              fixture_clock.clock - interval '5 minutes', fixture_clock.clock,
              'current-continuous-poll-0001', repeat('e', 64), repeat('f', 64),
              $3, 'Current continuous observation evidence'
       FROM fixture_clock`,
      [primary.organizationId, primary.shopify.id, primary.ownerEmail],
    )
    const currentContinuousClaim = await pool.query(
      `UPDATE operations_commerce_order_backfill_sessions
       SET status = 'processing', attempt_count = 1,
           locked_at = now(), locked_by = 'authority-readiness-fixture',
           lock_token = gen_random_uuid(),
           lease_expires_at = now() + interval '10 minutes',
           started_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND idempotency_key = 'current-continuous-poll-0001'
       RETURNING id::text`,
      [primary.organizationId, primary.shopify.id],
    )
    assert.equal(currentContinuousClaim.rowCount, 1)
    await pool.query(
      `UPDATE operations_commerce_order_backfill_sessions
       SET status = 'succeeded', page_count = 1, attempt_count = 0,
           read_all_orders_scope_observed = false,
           return_history_state = 'unavailable',
           completeness_state = 'unknown',
           locked_at = NULL, locked_by = NULL, lock_token = NULL,
           lease_expires_at = NULL, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [currentContinuousClaim.rows[0].id],
    )
    const afterOrderLineageRotation = await route.GET(apiRequest('GET'))
    const shopifyOrdersAfterLineageRotation =
      afterOrderLineageRotation.body.state.policies.find(
        (policy) => policy.accountGlobalId === primary.shopify.global_id
          && policy.resource === 'orders',
      )
    assert.equal(
      shopifyOrdersAfterLineageRotation.actualReadiness.evidence
        .historicalBackfillStatus,
      'succeeded',
      'A continuous-transport-only revision must preserve current-credential historical coverage',
    )
    assert.equal(
      shopifyOrdersAfterLineageRotation.actualReadiness.evidence
        .historicalBackfillCompletenessState,
      'shopify_fixed_window_orders_complete',
    )
    assert.equal(
      shopifyOrdersAfterLineageRotation.actualReadiness.evidence
        .continuousPollFresh,
      true,
      'The negative history assertion must isolate otherwise-current continuous evidence',
    )
    assert.equal(
      shopifyOrdersAfterLineageRotation.actualReadiness.evidence
        .realtimeTransportAvailable,
      true,
    )
    assert.equal(
      shopifyOrdersAfterLineageRotation.actualReadiness.state,
      'ready',
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration,
             '{orderWebhookSubscriptions,observedAt}',
             to_jsonb((now() - interval '25 hours')::text),
             false
           ),
           updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    const staleOrderSubscriptionState = await route.GET(apiRequest('GET'))
    const staleOrderSubscription =
      staleOrderSubscriptionState.body.state.policies.find(
        (policy) => policy.accountGlobalId === primary.shopify.global_id
          && policy.resource === 'orders',
      )
    assert.equal(
      staleOrderSubscription.actualReadiness.evidence
        .shopifyOrderSubscriptionReady,
      false,
    )
    assert.equal(staleOrderSubscription.actualReadiness.state, 'degraded')
    assert.ok(staleOrderSubscription.actualReadiness.blockerCodes.includes(
      'COMMERCE_ORDER_WEBHOOK_SUBSCRIPTIONS_UNREADY',
    ))
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration,
             '{orderWebhookSubscriptions,observedAt}',
             '"not-a-timestamp"'::jsonb,
             false
           ),
           updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    const invalidOrderSubscriptionState = await route.GET(apiRequest('GET'))
    const invalidOrderSubscription =
      invalidOrderSubscriptionState.body.state.policies.find(
        (policy) => policy.accountGlobalId === primary.shopify.global_id
          && policy.resource === 'orders',
      )
    assert.equal(
      invalidOrderSubscription.actualReadiness.evidence
        .shopifyOrderSubscriptionReady,
      false,
      'Malformed discovery time fails closed without aborting authority reads',
    )
    assert.ok(invalidOrderSubscription.actualReadiness.blockerCodes.includes(
      'COMMERCE_ORDER_WEBHOOK_SUBSCRIPTIONS_UNREADY',
    ))
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration,
             '{orderWebhookSubscriptions,observedAt}',
             to_jsonb(now()),
             false
           ),
           updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    assert.ok(
      !shopifyOrdersAfterLineageRotation.actualReadiness.blockerCodes.includes(
        'COMMERCE_ORDER_HISTORICAL_COVERAGE_INCOMPLETE',
      ),
    )
    await pool.query(
      `WITH fixture_clock AS (
         SELECT date_trunc('milliseconds', clock_timestamp()) AS clock
       )
       INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, idempotency_key, request_hash,
         query_hash, requested_by, reason
       )
       SELECT $1::uuid, $2::uuid, 'shopify', 'historical_backfill', 1, 2,
              'shopify_rolling_60_days', 'pending',
              fixture_clock.clock - interval '60 days', fixture_clock.clock,
              'current-lineage-history-0001', repeat('1', 64), repeat('2', 64),
              $3, 'Current exact historical coverage evidence'
       FROM fixture_clock`,
      [primary.organizationId, primary.shopify.id, primary.ownerEmail],
    )
    const pendingHistoricalReadiness = await route.GET(apiRequest('GET'))
    const pendingHistoricalShopifyOrders =
      pendingHistoricalReadiness.body.state.policies.find(
        (policy) => policy.accountGlobalId === primary.shopify.global_id
          && policy.resource === 'orders',
      )
    assert.equal(
      pendingHistoricalShopifyOrders.actualReadiness.evidence
        .historicalBackfillStatus,
      'pending',
      'A newer pending historical request must supersede prior completed evidence',
    )
    assert.equal(
      pendingHistoricalShopifyOrders.actualReadiness.state,
      'degraded',
    )
    assert.ok(
      pendingHistoricalShopifyOrders.actualReadiness.blockerCodes.includes(
        'COMMERCE_ORDER_HISTORICAL_COVERAGE_INCOMPLETE',
      ),
    )
    const currentHistoricalClaim = await pool.query(
      `UPDATE operations_commerce_order_backfill_sessions
       SET status = 'processing', attempt_count = 1,
           locked_at = now(), locked_by = 'authority-readiness-fixture',
           lock_token = gen_random_uuid(),
           lease_expires_at = now() + interval '10 minutes',
           started_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND idempotency_key = 'current-lineage-history-0001'
       RETURNING id::text`,
      [primary.organizationId, primary.shopify.id],
    )
    assert.equal(currentHistoricalClaim.rowCount, 1)
    await pool.query(
      `UPDATE operations_commerce_order_backfill_sessions
       SET status = 'succeeded', page_count = 1, attempt_count = 0,
           read_all_orders_scope_observed = true,
           return_history_state = 'unavailable',
           completeness_state = 'shopify_fixed_window_orders_complete',
           locked_at = NULL, locked_by = NULL, lock_token = NULL,
           lease_expires_at = NULL, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [currentHistoricalClaim.rows[0].id],
    )
    const currentOrderReadiness = await route.GET(apiRequest('GET'))
    const currentShopifyOrders = currentOrderReadiness.body.state.policies.find(
      (policy) => policy.accountGlobalId === primary.shopify.global_id
        && policy.resource === 'orders',
    )
    assert.equal(currentShopifyOrders.actualReadiness.state, 'ready')
    assert.equal(currentShopifyOrders.actualReadiness.evidence.activationState, 'shadow')
    await pool.query(
      `UPDATE operations_commerce_order_sync_policies
       SET historical_observation_enabled = false,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    const historyDisabledReadiness = await route.GET(apiRequest('GET'))
    const historyDisabledShopifyOrders =
      historyDisabledReadiness.body.state.policies.find(
        (policy) => policy.accountGlobalId === primary.shopify.global_id
          && policy.resource === 'orders',
      )
    assert.equal(historyDisabledShopifyOrders.actualReadiness.state, 'degraded')
    assert.ok(
      historyDisabledShopifyOrders.actualReadiness.blockerCodes.includes(
        'COMMERCE_ORDER_HISTORICAL_COVERAGE_INCOMPLETE',
      ),
      'Current historical-observation disablement must close readiness',
    )
    await pool.query(
      `UPDATE operations_commerce_order_sync_policies
       SET historical_observation_enabled = true,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'frozen', updated_at = now()
       WHERE organization_id = $1::uuid`,
      [primary.organizationId],
    )
    const frozenOrderReadiness = await route.GET(apiRequest('GET'))
    const frozenShopifyOrders = frozenOrderReadiness.body.state.policies.find(
      (policy) => policy.accountGlobalId === primary.shopify.global_id
        && policy.resource === 'orders',
    )
    assert.equal(frozenShopifyOrders.actualReadiness.state, 'unavailable')
    assert.equal(frozenShopifyOrders.actualReadiness.evidence.activationState, 'frozen')
    assert.ok(frozenShopifyOrders.actualReadiness.blockerCodes.includes(
      'COMMERCE_AUTHORITY_STORE_SYNC_PAUSED',
    ))
    assert.ok(frozenShopifyOrders.actualReadiness.blockerCodes.includes(
      'OPERATIONS_FROZEN_OVERRIDE',
    ))
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'shadow', updated_at = now()
       WHERE organization_id = $1::uuid`,
      [primary.organizationId],
    )
    const shopifyInventory = stateResponse.body.state.policies.find(
      (policy) => policy.accountGlobalId === primary.shopify.global_id
        && policy.resource === 'inventory',
    )
    assert.equal(shopifyInventory.actualReadiness.state, 'degraded')
    assert.equal(
      shopifyInventory.actualReadiness.evidence.shopifyInventoryMaxAgeSeconds,
      60,
    )
    assert.equal(
      shopifyInventory.actualReadiness.evidence.shopifyInventoryFresh,
      false,
    )
    assert.ok(shopifyInventory.actualReadiness.blockerCodes.includes(
      'COMMERCE_SHOPIFY_INVENTORY_REFRESH_STALE',
    ))
    await pool.query(
      `UPDATE operations_shopify_inventory_refresh_jobs
       SET completed_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    await pool.query(
      `UPDATE operations_shopify_inventory_refresh_watermarks
       SET last_reconciled_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_build_object(
             'webhookSubscriptions', jsonb_build_object(
               'accountGlobalId', global_id,
               'credentialGeneration', commerce_credential_generation,
               'desiredUri',
                 'https://authority.example.test/api/integrations/commerce/shopify/webhooks/'
                   || global_id,
               'requiredTopics', jsonb_build_array(
                 'inventory_items/create', 'inventory_items/delete',
                 'inventory_items/update', 'inventory_levels/connect',
                 'inventory_levels/disconnect', 'inventory_levels/update'
               ),
               'observedCount', 6,
               'matchingCount', 6,
               'missingTopics', '[]'::jsonb,
               'conflictingTopics', '[]'::jsonb,
               'ready', true,
               'observedAt', to_jsonb(now()),
               'discoveryState', 'succeeded',
               'discoveryErrorCode', NULL,
               'providerWrites', 0
             )
           ),
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND commerce_credential_generation = 1`,
      [primary.organizationId, primary.shopify.id],
    )
    const readShopifyInventoryPolicy = async () => {
      const response = await route.GET(apiRequest('GET'))
      assert.equal(response.status, 200)
      return response.body.state.policies.find(
        (policy) => policy.accountGlobalId === primary.shopify.global_id
          && policy.resource === 'inventory',
      )
    }
    const subscriptionReadyInventory = await readShopifyInventoryPolicy()
    assert.equal(
      subscriptionReadyInventory.actualReadiness.evidence
        .shopifyInventorySubscriptionReady,
      true,
    )
    assert.equal(subscriptionReadyInventory.actualReadiness.state, 'ready')

    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration, '{webhookSubscriptions,observedAt}',
             to_jsonb(now() - interval '25 hours'), false
           )
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    const staleInventorySubscription = await readShopifyInventoryPolicy()
    assert.equal(
      staleInventorySubscription.actualReadiness.evidence
        .shopifyInventorySubscriptionReady,
      false,
    )
    assert.ok(staleInventorySubscription.actualReadiness.blockerCodes.includes(
      'COMMERCE_SHOPIFY_INVENTORY_SUBSCRIPTION_UNREADY',
    ))

    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration, '{webhookSubscriptions,observedAt}',
             to_jsonb('not-a-timestamp'::text), false
           )
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    const malformedInventorySubscription = await readShopifyInventoryPolicy()
    assert.equal(
      malformedInventorySubscription.actualReadiness.evidence
        .shopifyInventorySubscriptionReady,
      false,
      'Malformed inventory discovery time fails closed without aborting reads',
    )

    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             jsonb_set(
               configuration, '{webhookSubscriptions,observedAt}',
               to_jsonb(now()), false
             ),
             '{webhookSubscriptions,credentialGeneration}',
             to_jsonb(2), false
           )
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    assert.equal(
      (await readShopifyInventoryPolicy()).actualReadiness.evidence
        .shopifyInventorySubscriptionReady,
      false,
      'Prior-generation inventory subscription evidence must not be current',
    )

    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             jsonb_set(
               configuration, '{webhookSubscriptions,credentialGeneration}',
               to_jsonb(commerce_credential_generation), false
             ),
             '{webhookSubscriptions,accountGlobalId}',
             to_jsonb('gia0000000'::text), false
           )
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    assert.equal(
      (await readShopifyInventoryPolicy()).actualReadiness.evidence
        .shopifyInventorySubscriptionReady,
      false,
      'Foreign-account inventory subscription evidence must not be current',
    )

    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             jsonb_set(
               configuration, '{webhookSubscriptions,accountGlobalId}',
               to_jsonb(global_id), false
             ),
             '{webhookSubscriptions,desiredUri}',
             to_jsonb(
               'https://authority.example.test/api/integrations/commerce/shopify/webhooks/'
                 || global_id || '/suffix'
             ), false
           )
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    assert.equal(
      (await readShopifyInventoryPolicy()).actualReadiness.evidence
        .shopifyInventorySubscriptionReady,
      false,
      'Callback suffix lookalikes must not satisfy exact inventory readiness',
    )

    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(
                   configuration, '{webhookSubscriptions,desiredUri}',
                   to_jsonb(
                     'https://authority.example.test/api/integrations/commerce/shopify/webhooks/'
                       || global_id
                   ), false
                 ),
                 '{webhookSubscriptions,missingTopics}',
                 jsonb_build_array('inventory_levels/update'), false
               ),
               '{webhookSubscriptions,ready}', 'false'::jsonb, false
             ),
             '{webhookSubscriptions,matchingCount}', '5'::jsonb, false
           )
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, primary.shopify.id],
    )
    const subscriptionUnreadyState = await route.GET(apiRequest('GET'))
    const subscriptionUnreadyInventory =
      subscriptionUnreadyState.body.state.policies.find(
        (policy) => policy.accountGlobalId === primary.shopify.global_id
          && policy.resource === 'inventory',
      )
    assert.equal(
      subscriptionUnreadyInventory.actualReadiness.evidence
        .webhookVerificationStatus,
      'verified',
    )
    assert.equal(
      subscriptionUnreadyInventory.actualReadiness.evidence
        .shopifyInventoryFresh,
      true,
    )
    assert.equal(
      subscriptionUnreadyInventory.actualReadiness.evidence
        .shopifyInventoryWatermarkClean,
      true,
    )
    assert.equal(
      subscriptionUnreadyInventory.actualReadiness.evidence
        .shopifyInventorySubscriptionReady,
      false,
    )
    assert.equal(
      subscriptionUnreadyInventory.actualReadiness.evidence
        .shopifyInventorySubscriptionMissingCount,
      1,
    )
    assert.equal(subscriptionUnreadyInventory.actualReadiness.state, 'degraded')
    assert.ok(subscriptionUnreadyInventory.actualReadiness.blockerCodes.includes(
      'COMMERCE_SHOPIFY_INVENTORY_SUBSCRIPTION_UNREADY',
    ))

    actor = asActor(
      primary.restrictedAdminEmail,
      'admin',
      primary.organizationId,
      { canManage: true, canActivate: false },
    )
    const denied = await route.POST(apiRequest('POST', {
      accountGlobalId: primary.shopify.global_id,
      resource: 'orders',
      authorityMode: 'provider',
      expectedRevision: 0,
      reason: 'Restricted administrator must be denied',
    }, 'denied-policy-0001'))
    assert.equal(denied.status, 403)

    actor = owner
    const orderBody = {
      accountGlobalId: primary.shopify.global_id,
      resource: 'orders',
      authorityMode: 'provider',
      expectedRevision: 0,
      reason: 'Provider remains the order system of record',
    }
    const first = await route.POST(apiRequest('POST', orderBody, 'order-policy-0001'))
    assert.equal(first.status, 200)
    assert.equal(first.body.result.replayed, false)
    const replay = await route.POST(apiRequest('POST', orderBody, 'order-policy-0001'))
    assert.equal(replay.status, 200)
    assert.equal(replay.body.result.replayed, true)
    const second = await route.POST(apiRequest('POST', {
      ...orderBody,
      expectedRevision: 1,
      reason: 'A second revision preserves exact replay identity',
    }, 'order-policy-0002'))
    assert.equal(second.status, 200)
    assert.equal(second.body.result.policy.revision, 2)
    const oldReplayAfterNewRevision = await route.POST(
      apiRequest('POST', orderBody, 'order-policy-0001'),
    )
    assert.equal(oldReplayAfterNewRevision.status, 200)
    assert.equal(oldReplayAfterNewRevision.body.result.replayed, true)
    assert.equal(oldReplayAfterNewRevision.body.result.policy.revision, 1)
    assert.equal(
      oldReplayAfterNewRevision.body.result.policy.reason,
      orderBody.reason,
    )
    const conflict = await route.POST(apiRequest('POST', {
      ...orderBody,
      reason: 'A different semantic request must conflict',
    }, 'order-policy-0001'))
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.code, 'COMMERCE_AUTHORITY_IDEMPOTENCY_CONFLICT')
    assert.match(
      audits[0].eventKey,
      new RegExp(`${primary.organizationId}:${primary.shopify.global_id}:order-policy-0001$`),
    )

    actor = admin
    const adminWrite = await route.POST(apiRequest('POST', {
      accountGlobalId: primary.shopify.global_id,
      resource: 'inventory',
      authorityMode: 'provider',
      expectedRevision: 0,
      reason: 'Operations administrator records snapshot intent',
    }, 'inventory-policy-0001'))
    assert.equal(adminWrite.status, 200)

    actor = owner
    const crossTenant = await route.POST(apiRequest('POST', {
      accountGlobalId: other.shopify.global_id,
      resource: 'orders',
      authorityMode: 'provider',
      expectedRevision: 0,
      reason: 'Cross tenant account must never resolve here',
    }, 'cross-tenant-0001'))
    assert.equal(crossTenant.status, 404)

    const raceBody = {
      accountGlobalId: primary.faire.global_id,
      resource: 'orders',
      authorityMode: 'provider',
      expectedRevision: 0,
      reason: 'Concurrent revision race acceptance evidence',
    }
    const raced = await Promise.all([
      route.POST(apiRequest('POST', raceBody, 'race-policy-0001')),
      route.POST(apiRequest('POST', raceBody, 'race-policy-0002')),
    ])
    assert.equal(raced.filter((entry) => entry.status === 200).length, 1)
    assert.equal(raced.filter((entry) => (
      entry.status === 409
      && entry.body.code === 'COMMERCE_AUTHORITY_REVISION_CONFLICT'
    )).length, 1)

    const policyId = first.body.result.policy.policyGlobalId
    await expectRejected(
      () => pool.query(
        `UPDATE operations_commerce_authority_policies
         SET reason = 'Mutation must fail'
         WHERE global_id = $1`,
        [policyId],
      ),
      (error) => error.code === 'P0001' && /immutable/.test(error.message),
      'Policy update immutability',
    )
    await expectRejected(
      () => pool.query(
        `DELETE FROM operations_commerce_authority_policies
         WHERE global_id = $1`,
        [policyId],
      ),
      (error) => error.code === 'P0001' && /immutable/.test(error.message),
      'Policy delete immutability',
    )
    await expectRejected(
      () => pool.query(
        `INSERT INTO operations_commerce_authority_policies (
           organization_id, integration_account_id, provider, resource,
           revision, authority_mode, desired_ingest_mode, provider_write_mode,
           provider_write_count, expected_previous_revision, reason,
           actor_email, actor_role, idempotency_key, request_hash
         ) VALUES (
           $1::uuid, $2::uuid, 'faire', 'inventory', 1, 'provider',
           'windowed_history_and_core_order_signals_plus_poll', 'disabled', 0, 0,
           'Faire inventory cannot claim provider authority', $3, 'owner',
           'invalid-faire-inventory', repeat('5', 64)
         )`,
        [primary.organizationId, primary.faire.id, primary.ownerEmail],
      ),
      (error) => error.code === '23514',
      'Faire inventory authority matrix',
    )
    await expectRejected(
      () => pool.query(
        `INSERT INTO operations_commerce_authority_policies (
           organization_id, integration_account_id, provider, resource,
           revision, authority_mode, desired_ingest_mode, provider_write_mode,
           provider_write_count, expected_previous_revision, reason,
           actor_email, actor_role, idempotency_key, request_hash
         ) VALUES (
           $1::uuid, $2::uuid, 'shopify', 'orders', 3, 'provider',
           'windowed_history_and_core_order_signals_plus_poll', 'disabled', 0, 2,
           'Restricted administrator must fail at trigger', $3, 'admin',
           'restricted-admin-direct', repeat('6', 64)
         )`,
        [
          primary.organizationId,
          primary.shopify.id,
          primary.restrictedAdminEmail,
        ],
      ),
      (error) => error.code === 'P0001' && /owner or operations administrator/.test(error.message),
      'Database administrator permission trigger',
    )
    await expectRejected(
      () => pool.query(
        `INSERT INTO operations_commerce_authority_policies (
           organization_id, integration_account_id, provider, resource,
           revision, authority_mode, desired_ingest_mode, provider_write_mode,
           provider_write_count, expected_previous_revision, reason,
           actor_email, actor_role, idempotency_key, request_hash
         ) VALUES (
           $1::uuid, $2::uuid, 'shopify', 'orders', 1, 'provider',
           'windowed_history_and_core_order_signals_plus_poll', 'disabled', 1, 0,
           'Provider writes must remain impossible', $3, 'owner',
           'provider-write-count-direct', repeat('7', 64)
         )`,
        [other.organizationId, other.shopify.id, other.ownerEmail],
      ),
      (error) => error.code === '23514',
      'Provider write count fence',
    )

    const lineage = await seedBlockedScopeEvidence(pool, primary)
    await expectRejected(
      () => insertBlockedScope(pool, primary, lineage, {
        channelRowVersion: Number(lineage.channel.row_version) - 1,
      }),
      (error) => error.code === 'P0001' && /lineage is invalid/.test(error.message),
      'Stale exact channel-state lineage',
    )
    const wrongModeClient = await pool.connect()
    try {
      await wrongModeClient.query('BEGIN')
      await wrongModeClient.query(
        `UPDATE operations_commerce_credentials
       SET auth_mode = 'faire_brand_token',
           credential_ciphertext = decode('04', 'hex'),
           credential_iv = decode(repeat('05', 12), 'hex'),
           credential_tag = decode(repeat('06', 16), 'hex'),
           credential_identifier_last_four = 'mode',
           credential_version = credential_version + 1,
           webhook_verification_status = 'not_applicable',
           webhook_verified_at = NULL,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
        [primary.organizationId, primary.shopify.id],
      )
      await wrongModeClient.query(
        `UPDATE operations_integration_accounts
       SET commerce_credential_generation =
             commerce_credential_generation + 1,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
        [primary.organizationId, primary.shopify.id],
      )
      await expectRejected(
        () => insertBlockedScope(wrongModeClient, primary, lineage, {
          credentialGeneration: 2,
        }),
        (error) => error.code === 'P0001' && /lineage is invalid/.test(error.message),
        'Blocked Shopify scope requires Shopify credential mode',
      )
    } finally {
      await wrongModeClient.query('ROLLBACK')
      wrongModeClient.release()
    }
    const lineageDebug = await pool.query(
      `SELECT
         account.status, account.global_id, account.external_account_id,
         account.commerce_credential_generation,
         credential.credential_version, credential.verification_status,
         mapping.global_id AS mapping_global_id,
         mapping.pipeline_id::text AS mapping_pipeline_id,
         mapping.id::text AS mapping_id,
         mapping.product_id::text AS mapping_product_id,
         mapping.channel_sku,
         mapping.external_product_id AS mapping_external_product_id,
         mapping.external_variant_id AS mapping_external_variant_id,
         mapping.external_inventory_item_id AS mapping_external_inventory_item_id,
         mapping.updated_at AS mapping_updated_at,
         mapping.active AS mapping_active,
         product.reference_code AS product_global_id,
         product.active AS product_active,
         customer.reference_code AS customer_global_id,
         customer.id::text AS customer_id,
         channel_state.id::text AS channel_state_id,
         channel_state.integration_account_id::text AS channel_account_id,
         channel_state.pipeline_id::text AS channel_pipeline_id,
         channel_state.product_mapping_id::text AS channel_mapping_id,
         channel_state.product_id::text AS channel_product_id,
         channel_state.row_version, channel_state.source_hash,
         channel_state.observed_at, channel_state.normalized_status,
         channel_state.external_product_id,
         channel_state.external_variant_id,
         channel_state.external_inventory_item_id
       FROM operations_integration_accounts account
       JOIN operations_product_mappings mapping
         ON mapping.organization_id = account.organization_id
        AND mapping.integration_account_id = account.id
       JOIN crm_products product
         ON product.pipeline_id = mapping.pipeline_id
        AND product.id = mapping.product_id
       JOIN crm_organizations customer
         ON customer.pipeline_id = mapping.pipeline_id
        AND customer.id = $3::uuid
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_product_channel_states channel_state
         ON channel_state.organization_id = mapping.organization_id
        AND channel_state.integration_account_id = mapping.integration_account_id
        AND channel_state.id = $4::uuid
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid`,
      [
        primary.organizationId,
        primary.shopify.id,
        lineage.customer.id,
        lineage.channel.id,
      ],
    )
    assert.equal(lineageDebug.rows.length, 1)
    const exactLineage = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_integration_accounts account
       JOIN operations_product_mappings mapping
         ON mapping.organization_id = account.organization_id
        AND mapping.integration_account_id = account.id
       JOIN crm_products product
         ON product.pipeline_id = mapping.pipeline_id
        AND product.id = mapping.product_id
       JOIN crm_organizations customer
         ON customer.pipeline_id = mapping.pipeline_id
        AND customer.id = $18::uuid
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_product_channel_states channel_state
         ON channel_state.organization_id = mapping.organization_id
        AND channel_state.integration_account_id = mapping.integration_account_id
        AND channel_state.id = $20::uuid
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.integration_type = 'commerce'
         AND account.provider = $3
         AND account.environment = $4
         AND account.status = 'active'
         AND account.global_id = $5
         AND account.external_account_id = $6
         AND account.commerce_credential_generation = $7::integer
         AND credential.credential_version = $7::integer
         AND credential.verification_status = 'verified'
         AND credential.last_error_code IS NULL
         AND credential.external_account_id = account.external_account_id
         AND mapping.pipeline_id = $8::uuid
         AND mapping.id = $9::uuid
         AND mapping.product_id = $10::uuid
         AND mapping.global_id = $11
         AND mapping.channel_sku = $12
         AND mapping.external_product_id = $13
         AND mapping.external_variant_id = $14
         AND mapping.external_inventory_item_id = $15
         AND mapping.active
         AND mapping.updated_at = $16::timestamptz
         AND product.reference_code = $17
         AND product.active
         AND customer.reference_code = $19
         AND channel_state.provider = 'shopify'
         AND channel_state.integration_account_id = account.id
         AND channel_state.pipeline_id = mapping.pipeline_id
         AND channel_state.product_mapping_id = mapping.id
         AND channel_state.product_id = mapping.product_id
         AND channel_state.external_product_id = $13
         AND channel_state.external_variant_id = $14
         AND channel_state.external_inventory_item_id = $15
         AND channel_state.normalized_status IN ('active', 'unlisted')
         AND channel_state.row_version = $21::bigint
         AND channel_state.source_hash = $22
         AND channel_state.observed_at = $23::timestamptz`,
      [
        primary.organizationId,
        primary.shopify.id,
        'shopify',
        'sandbox',
        primary.shopify.global_id,
        primary.shopify.externalAccountId,
        1,
        lineage.pipelineId,
        lineage.mapping.id,
        lineage.product.id,
        lineage.mapping.global_id,
        'LINEAGE',
        'gid://shopify/Product/lineage',
        'gid://shopify/ProductVariant/lineage',
        'gid://shopify/InventoryItem/lineage',
        lineage.mapping.updated_at,
        lineage.product.reference_code,
        lineage.customer.id,
        lineage.customer.reference_code,
        lineage.channel.id,
        lineage.channel.row_version,
        lineage.channel.source_hash,
        lineage.channel.observed_at,
      ],
    )
    assert.equal(exactLineage.rows[0].count, 1)
    const blocked = await insertBlockedScope(pool, primary, lineage)
    assert.match(blocked.rows[0].global_id, /^gaud/u)
    await expectRejected(
      () => pool.query(
        `UPDATE operations_commerce_provider_write_scope_requests
         SET request_reason = 'Mutation must remain unavailable'
         WHERE global_id = $1`,
        [blocked.rows[0].global_id],
      ),
      (error) => error.code === 'P0001' && /immutable/.test(error.message),
      'Blocked scope immutability',
    )

    const counts = await pool.query(
      `SELECT
         COALESCE(sum(provider_write_count), 0)::integer AS policy_writes,
         count(*) FILTER (WHERE provider_write_enabled)::integer AS enabled_scope
       FROM operations_commerce_authority_policies policy
       FULL JOIN operations_commerce_provider_write_scope_requests request
         ON false`,
    )
    assert.equal(counts.rows[0].policy_writes, 0)
    assert.equal(counts.rows[0].enabled_scope, 0)

    // A credentialed commerce account is one provider identity. Reusing the
    // same row for another provider or integration type would relabel durable
    // policy and history evidence, so 0276 rejects both mutations.
    await expectRejected(
      () => pool.query(
        `UPDATE operations_integration_accounts
         SET provider = 'faire', updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [primary.organizationId, primary.shopify.id],
      ),
      (error) => error.code === 'P0001'
        && /credentialed commerce account provider and type are immutable/.test(error.message),
      'Credentialed account provider identity is immutable',
    )
    await expectRejected(
      () => pool.query(
        `UPDATE operations_integration_accounts
         SET integration_type = 'carrier', updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [primary.organizationId, primary.shopify.id],
      ),
      (error) => error.code === 'P0001'
        && /credentialed commerce account provider and type are immutable/.test(error.message),
      'Credentialed account integration type is immutable',
    )
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container =
    `clawpilot-commerce-authority-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=commerce_authority',
      '-e', 'POSTGRES_DB=commerce_authority',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port from ${portOutput}`)
    const databaseUrl =
      `postgresql://postgres:commerce_authority@127.0.0.1:${port}`
      + '/commerce_authority'
    await waitForPostgres(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 240_000,
    })
    await verify(databaseUrl)
    console.log(
      'commerce authority disposable PostgreSQL and API acceptance passed',
    )
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
