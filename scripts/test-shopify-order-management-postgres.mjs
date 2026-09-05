#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { applyMigrationSqlForTest } from './lib/postgres-test-migrations.mjs'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
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
  await applyMigrationSqlForTest(client, filename, sql, {
    checksum: createHash('sha256').update(sql).digest('hex'),
  })
}

function loadTypeScriptModule(path, mocks = {}, sourceOverride = null) {
  const source = sourceOverride ?? readFileSync(resolve(root, path), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

function postgresAdapter(pool, transactionControl = {}) {
  return {
    query(text, values = []) {
      return pool.query(text, values)
    },
    async acquireTransactionAdvisoryLock(client, key) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      )
    },
    async withTransaction(work) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client)
        const beforeCommit = transactionControl.beforeCommit
        if (beforeCommit) {
          transactionControl.beforeCommit = null
          await beforeCommit()
        }
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

async function expectRejected(work, expectedCode, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${message}: expected rejection`)
  if (expectedCode) {
    assert.equal(
      error.code,
      expectedCode,
      `${message}: ${String(error.message || error)}`,
    )
  }
  return error
}

async function expectDatabaseRejected(work, pattern, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${message}: expected database rejection`)
  assert.match(String(error.message || error), pattern, message)
  return error
}

async function expectFulfillmentReversalRaceRejected(work, message) {
  const error = await expectDatabaseRejected(
    work,
    /Shopify order management attempt blocks downstream planning/iu,
    message,
  )
  assert.equal(error.code, 'P0001', `${message}: exact guard SQLSTATE`)
  assert.doesNotMatch(
    String(error.message || error),
    /violates (?:check|foreign key|not-null) constraint/iu,
    `${message}: a schema constraint must not masquerade as the reversal guard`,
  )
}

async function seed(pool) {
  const ownerEmail = `shopify-order-owner-${randomUUID()}@example.test`
  const manageOnlyAdminEmail =
    `shopify-order-manage-${randomUUID()}@example.test`
  const executeOnlyAdminEmail =
    `shopify-order-execute-${randomUUID()}@example.test`
  const qualifiedAdminEmail =
    `shopify-order-qualified-${randomUUID()}@example.test`
  const legacyMemberEmail =
    `shopify-order-legacy-member-${randomUUID()}@example.test`
  await pool.query(
    `INSERT INTO app_users (email, role, status)
     VALUES
       ($1, 'owner', 'active'),
       ($2, 'admin', 'active'),
       ($3, 'admin', 'active'),
       ($4, 'admin', 'active'),
       ($5, 'member', 'active')`,
    [
      ownerEmail,
      manageOnlyAdminEmail,
      executeOnlyAdminEmail,
      qualifiedAdminEmail,
      legacyMemberEmail,
    ],
  )
  const organization = await pool.query(
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ('Shopify order management acceptance', 'root', $1, $1)
     RETURNING id::text`,
    [ownerEmail],
  )
  const organizationId = organization.rows[0].id
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES (
       $1, $2::uuid, 'owner', '{"manageOperations":true}'::jsonb,
       'active', true, $1, $1
     )`,
    [ownerEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES (
       $1, $2::uuid, 'member',
       '{"manageOperations":true,"executeWarehouse":true}'::jsonb,
       'active', false, $3, $3
     )`,
    [legacyMemberEmail, organizationId, ownerEmail],
  )
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES
       (
         $1, $4::uuid, 'admin',
         '{"manageOperations":true,"executeWarehouse":false}'::jsonb,
         'active', false, $5, $5
       ),
       (
         $2, $4::uuid, 'admin',
         '{"manageOperations":false,"executeWarehouse":true}'::jsonb,
         'active', false, $5, $5
       ),
       (
         $3, $4::uuid, 'admin',
         '{"manageOperations":true,"executeWarehouse":true}'::jsonb,
         'active', false, $5, $5
       )`,
    [
      manageOnlyAdminEmail,
      executeOnlyAdminEmail,
      qualifiedAdminEmail,
      organizationId,
      ownerEmail,
    ],
  )
  const pipeline = await pool.query(
    `INSERT INTO pipeline_spaces (
       name, owner_email, is_default, workspace_organization_id
     ) VALUES ('Shopify order management acceptance', $1, true, $2::uuid)
     RETURNING id::text`,
    [ownerEmail, organizationId],
  )
  const pipelineId = pipeline.rows[0].id
  await pool.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, revision, reason, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shadow', 7,
       'Shopify order management PostgreSQL acceptance', $3
     )`,
    [organizationId, pipelineId, ownerEmail],
  )
  const account = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, configuration, external_account_id,
       commerce_credential_generation, created_by, updated_by
     ) VALUES (
       $1::uuid, 'shopify', 'commerce', 'sandbox',
       'AG Alchemy Shopify acceptance', 'active',
       '{
         "shopDomain":"ag-alchemy-order-management.myshopify.com",
         "authMode":"shopify_client_credentials",
         "grantedScopes":["read_orders","write_merchant_managed_fulfillment_orders","write_order_edits","write_orders"]
       }'::jsonb,
       'gid://shopify/Shop/6600001', 1, $2, $2
     ) RETURNING id::text, global_id`,
    [organizationId, ownerEmail],
  )
  const accountId = account.rows[0].id
  const accountGlobalId = account.rows[0].global_id
  await pool.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'gid://shopify/Shop/6600001',
       'shopify_client_credentials', decode('01', 'hex'),
       decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex'),
       1, '0001', 'verified', now(), 'unverified', $3, $3
     )`,
    [organizationId, accountId, ownerEmail],
  )
  await pool.query(
    `INSERT INTO operations_commerce_provider_write_controls (
       organization_id, integration_account_id, provider, row_version,
       expected_row_version, requested_mode, bound_credential_generation,
       bound_granted_scopes, bound_granted_scope_digest, changed_by,
       changed_role, idempotency_key, request_hash
     ) VALUES (
       $1::uuid, $2::uuid, 'shopify', 1, 0, 'on', 1,
       ARRAY['read_orders','write_merchant_managed_fulfillment_orders','write_order_edits','write_orders']::text[],
       operations_commerce_granted_scope_digest(
         ARRAY['read_orders','write_merchant_managed_fulfillment_orders','write_order_edits','write_orders']::text[]
       ),
       $3, 'owner', $4, repeat('9', 64)
     )`,
    [
      organizationId,
      accountId,
      ownerEmail,
      `shopify-order-provider-writes-${randomUUID()}`,
    ],
  )
  const customer = await pool.query(
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, identity_key, name, relationship_type,
       source_payload, source_hash, sync_status, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3, 'Order management customer', 'customer',
       '{}'::jsonb, repeat('e', 64), 'synced', $4, $4
     ) RETURNING id::text`,
    [
      pipelineId,
      `order-management-customer-${randomUUID()}`,
      `customer:order-management-${randomUUID()}`,
      ownerEmail,
    ],
  )
  const customerId = customer.rows[0].id
  const contract = await pool.query(
    `INSERT INTO operations_contracts (
       organization_id, pipeline_id, customer_id, name, status, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'Order management acceptance',
       'active', $4
     ) RETURNING id::text`,
    [organizationId, pipelineId, customerId, ownerEmail],
  )
  const contractVersion = await pool.query(
    `INSERT INTO operations_contract_versions (
       organization_id, contract_id, version_number, effective_from,
       currency, status, terms_snapshot, published_by
     ) VALUES (
       $1::uuid, $2::uuid, 1, now() - interval '1 day', 'USD',
       'published', '{}'::jsonb, $3
     ) RETURNING id::text`,
    [organizationId, contract.rows[0].id, ownerEmail],
  )
  const currentSourceHash = 'a'.repeat(64)
  const fulfilledSourceHash = 'b'.repeat(64)

  async function order(input) {
    const result = await pool.query(
      `INSERT INTO operations_orders (
         organization_id, pipeline_id, customer_id, integration_account_id,
         source_provider, external_order_id, order_number, status, currency,
         merchandise_total_minor, ship_to, source_payload, created_by,
         updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify', $5, $6,
         'imported', 'USD', 1000, '{"country":"US"}'::jsonb,
         jsonb_build_object('sourceHash', $7::text), $8, $8
       ) RETURNING id::text, global_id, external_order_id, order_number,
                   row_version::text`,
      [
        organizationId,
        pipelineId,
        customerId,
        accountId,
        input.externalOrderId,
        input.orderNumber,
        input.sourceHash,
        ownerEmail,
      ],
    )
    return result.rows[0]
  }

  const current = await order({
    externalOrderId: 'gid://shopify/Order/6600002',
    orderNumber: '#6601',
    sourceHash: currentSourceHash,
  })
  const fulfilled = await order({
    externalOrderId: 'gid://shopify/Order/6600001',
    orderNumber: '#6600',
    sourceHash: fulfilledSourceHash,
  })
  const currentAcceptedProviderUpdatedAt = new Date(
    Date.now() - 60_000,
  ).toISOString()
  const currentTarget = await pool.query(
    `SELECT target.id::text
     FROM operations_commerce_order_revision_targets target
     WHERE target.organization_id = $1::uuid
       AND target.order_id = $2::uuid`,
    [organizationId, current.id],
  )
  const revisionClient = await pool.connect()
  let currentAcceptedObservationId = ''
  try {
    await revisionClient.query('SET session_replication_role = replica')
    const acceptedObservation = await revisionClient.query(
      `INSERT INTO operations_commerce_order_revision_observations (
         organization_id, integration_account_id, target_id, order_id,
         provider, credential_generation, external_order_id,
         source_revision, source_hash, revision_hash, normalized_snapshot,
         canonical_row_version, provider_read_count, provider_write_count,
         observed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify', 1, $5,
         $6, $7, repeat('d', 64), $8::jsonb, $9::bigint, 1, 0,
         $10::timestamptz
       ) RETURNING id::text`,
      [
        organizationId,
        accountId,
        currentTarget.rows[0].id,
        current.id,
        'gid://shopify/Order/6600002',
        currentAcceptedProviderUpdatedAt,
        currentSourceHash,
        JSON.stringify({
          provider: 'shopify',
          accountGlobalId,
          integrationAccountId: accountId,
          externalAccountId: 'gid://shopify/Shop/6600001',
          credentialVersion: 1,
          canonicalOrderGlobalId: current.global_id,
          canonicalOrderRowVersion: Number(current.row_version),
          order: {
            externalOrderId: 'gid://shopify/Order/6600002',
            orderNumber: '#6601',
            sourceHash: currentSourceHash,
            providerUpdatedAt: currentAcceptedProviderUpdatedAt,
          },
        }),
        Number(current.row_version),
        new Date().toISOString(),
      ],
    )
    currentAcceptedObservationId = acceptedObservation.rows[0].id
    await revisionClient.query(
      `UPDATE operations_commerce_order_revision_targets
       SET accepted_observation_id = $3::uuid,
           latest_observation_id = $3::uuid,
           latest_source_hash = $4,
           material_state = 'current',
           updated_at = now()
       WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
      [
        organizationId,
        current.id,
        acceptedObservation.rows[0].id,
        currentSourceHash,
      ],
    )
    await revisionClient.query(
      `UPDATE operations_commerce_order_revision_targets
       SET latest_source_hash = repeat('c', 64),
           material_state = 'provider_fulfilled',
           updated_at = now()
       WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
      [organizationId, fulfilled.id],
    )
  } finally {
    await revisionClient.query('SET session_replication_role = origin')
      .catch(() => undefined)
    revisionClient.release()
  }
  return {
    ownerEmail,
    manageOnlyAdminEmail,
    executeOnlyAdminEmail,
    qualifiedAdminEmail,
    legacyMemberEmail,
    organizationId,
    pipelineId,
    customerId,
    contractVersionId: contractVersion.rows[0].id,
    accountId,
    accountGlobalId,
    currentSourceHash,
    currentAcceptedProviderUpdatedAt,
    currentAcceptedObservationId,
    fulfilledSourceHash,
    current,
    fulfilled,
  }
}

async function seedFulfillmentReversalEvidence(pool, fixture) {
  const warehouse = await pool.query(
    `INSERT INTO operations_warehouses (
       organization_id, code, name, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'Fulfillment reversal acceptance warehouse', $3, $3
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      `REV-${randomUUID().slice(0, 8).toUpperCase()}`,
      fixture.ownerEmail,
    ],
  )
  const warehouseId = warehouse.rows[0].id
  const cancelledOrder = await pool.query(
    `UPDATE operations_orders
     SET status = 'cancelled', updated_by = $3,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND id = $2::uuid
     RETURNING row_version::text`,
    [fixture.organizationId, fixture.fulfilled.id, fixture.ownerEmail],
  )
  assert.equal(cancelledOrder.rowCount, 1)
  const historicalPlan = await pool.query(
    `INSERT INTO operations_fulfillment_plans (
       organization_id, order_id, warehouse_id, version_number, status,
       method, solver_status, estimated_cost_minor, explanation, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 1, 'cancelled',
       'manual_override', 'not_run', 0, '{}'::jsonb, $4
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      fixture.fulfilled.id,
      warehouseId,
      fixture.ownerEmail,
    ],
  )
  const plan = await pool.query(
    `INSERT INTO operations_fulfillment_plans (
       organization_id, order_id, warehouse_id, version_number, status,
       method, solver_status, estimated_cost_minor, explanation, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 2, 'cancelled',
       'manual_override', 'not_run', 0, '{}'::jsonb, $4
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      fixture.fulfilled.id,
      warehouseId,
      fixture.ownerEmail,
    ],
  )
  const product = await pool.query(
    `INSERT INTO crm_products (
       pipeline_id, source_key, name, sku, source_payload, source_hash,
       sync_status, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3, $4, '{}'::jsonb, repeat('4', 64),
       'synced', $5, $5
     ) RETURNING id::text`,
    [
      fixture.pipelineId,
      `fulfillment-reversal-product-${randomUUID()}`,
      `Fulfillment reversal product ${randomUUID()}`,
      `REV-${randomUUID().slice(0, 8)}`,
      fixture.ownerEmail,
    ],
  )
  const orderLine = await pool.query(
    `INSERT INTO operations_order_lines (
       organization_id, order_id, pipeline_id, product_id,
       external_line_id, channel_sku, description, quantity,
       unit_price_minor, weight_grams
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
       'Externally fulfilled reversal acceptance line', 1, 1000, 250
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      fixture.fulfilled.id,
      fixture.pipelineId,
      product.rows[0].id,
      `gid://shopify/LineItem/${Date.now()}`,
      `REV-${randomUUID().slice(0, 8)}`,
    ],
  )
  const location = await pool.query(
    `INSERT INTO operations_locations (
       organization_id, warehouse_id, code, zone, location_type, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'PICK', 'pick', $4
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      warehouseId,
      `REV-${randomUUID().slice(0, 8).toUpperCase()}`,
      fixture.ownerEmail,
    ],
  )
  const inventoryPool = await pool.query(
    `INSERT INTO operations_inventory_pools (
       organization_id, pipeline_id, name, pool_type, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'shared', $4
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      fixture.pipelineId,
      `Fulfillment reversal pool ${randomUUID()}`,
      fixture.ownerEmail,
    ],
  )
  const inventoryPosition = await pool.query(
    `INSERT INTO operations_inventory_positions (
       organization_id, pipeline_id, warehouse_id, location_id, pool_id,
       product_id, lot_code, on_hand_quantity, reserved_quantity,
       damaged_quantity, source_authority
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       $6::uuid, '', 10, 0, 0, 'clawpilot'
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      fixture.pipelineId,
      warehouseId,
      location.rows[0].id,
      inventoryPool.rows[0].id,
      product.rows[0].id,
    ],
  )
  const releasedReservation = await pool.query(
    `INSERT INTO operations_reservations (
       organization_id, order_id, order_line_id, position_id, quantity,
       status, idempotency_key, created_by, reservation_authority
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'active', $5, $6,
       'local_balance'
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      fixture.fulfilled.id,
      orderLine.rows[0].id,
      inventoryPosition.rows[0].id,
      `fulfillment-reversal-reservation-${randomUUID()}`,
      fixture.ownerEmail,
    ],
  )
  const allocation = await pool.query(
    `INSERT INTO operations_fulfillment_allocations (
       organization_id, plan_id, order_line_id, reservation_id, position_id,
       quantity
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      plan.rows[0].id,
      orderLine.rows[0].id,
      releasedReservation.rows[0].id,
      inventoryPosition.rows[0].id,
    ],
  )
  await pool.query(
    `UPDATE operations_reservations
     SET status = 'released', released_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, releasedReservation.rows[0].id],
  )
  const packagingMaterial = await pool.query(
    `INSERT INTO operations_packaging_materials (
       organization_id, code, name, material_type, inner_length_mm,
       inner_width_mm, inner_height_mm, tare_weight_grams,
       max_weight_grams, unit_cost_minor, currency, status, created_by,
       updated_by, dimension_basis, dimension_evidence_type
     ) VALUES (
       $1::uuid, $2, 'Fulfillment reversal carton', 'carton', 300, 200,
       100, 50, 5000, 100, 'USD', 'active', $3, $3, 'inner', 'legacy'
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      `REV-${randomUUID().slice(0, 8).toUpperCase()}`,
      fixture.ownerEmail,
    ],
  )
  const packagingStock = await pool.query(
    `INSERT INTO operations_packaging_material_stock (
       organization_id, packaging_material_id, warehouse_id, is_available,
       on_hand_quantity, row_version, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, true, 10, 0, $4, $4
     ) RETURNING id::text, row_version::text`,
    [
      fixture.organizationId,
      packagingMaterial.rows[0].id,
      warehouseId,
      fixture.ownerEmail,
    ],
  )
  const carrierRate = await pool.query(
    `INSERT INTO operations_carrier_rates (
       organization_id, plan_id, carrier, service_code, service_name,
       internal_cost_minor, customer_charge_minor, transit_days,
       estimated_delivery_at, meets_promise, selected, quote_snapshot
     ) VALUES (
       $1::uuid, $2::uuid, 'UPS', 'GROUND', 'UPS Ground', 100, 100, 3,
       now() + interval '3 days', true, false, '{}'::jsonb
     ) RETURNING id::text`,
    [fixture.organizationId, plan.rows[0].id],
  )
  const retainedPackage = await pool.query(
    `INSERT INTO operations_packages (
       organization_id, plan_id, package_number, length_mm, width_mm,
       height_mm, weight_grams, status
     ) VALUES (
       $1::uuid, $2::uuid, 1, 300, 200, 100, 250, 'planned'
     ) RETURNING id::text`,
    [fixture.organizationId, plan.rows[0].id],
  )
  await pool.query(
    `INSERT INTO operations_package_contents (
       organization_id, plan_id, order_id, package_id, order_line_id,
       quantity, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, $6
     )`,
    [
      fixture.organizationId,
      plan.rows[0].id,
      fixture.fulfilled.id,
      retainedPackage.rows[0].id,
      orderLine.rows[0].id,
      fixture.ownerEmail,
    ],
  )
  const wave = await pool.query(
    `INSERT INTO operations_waves (
       organization_id, warehouse_id, name, status, optimization_method,
       released_by, released_at, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, 'Fulfillment reversal acceptance wave',
       'cancelled', 'deterministic_fallback', $3, now(), now()
     ) RETURNING id::text`,
    [fixture.organizationId, warehouseId, fixture.ownerEmail],
  )
  const receipt = await pool.query(
    `INSERT INTO operations_command_receipts (
       organization_id, command_type, idempotency_key, request_hash,
       actor_email, status, correlation_id, target_global_id,
       result_payload, completed_at
     ) VALUES (
       $1::uuid, 'shopify_external_fulfillment_reconciliation', $2,
       repeat('7', 64), $3, 'succeeded', $4::uuid, $5,
       '{}'::jsonb, now()
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      `shopify-external-recon-${randomUUID()}`,
      fixture.ownerEmail,
      randomUUID(),
      fixture.fulfilled.global_id,
    ],
  )
  const fulfillmentGid = `gid://shopify/Fulfillment/${Date.now()}`
  const fulfillmentUpdatedAt = new Date(
    Date.now() - 30_000,
  ).toISOString()
  const providerOrderUpdatedAt = new Date(
    Date.now() - 60_000,
  ).toISOString()
  const evidenceSnapshot = {
    version: 'shopify-external-fulfillment-reconciliation-v2',
    order: { id: fixture.fulfilled.external_order_id },
    fulfillment: {
      id: fulfillmentGid,
      updatedAt: fulfillmentUpdatedAt,
      status: 'SUCCESS',
      displayStatus: 'FULFILLED',
    },
  }
  await pool.query(
    `INSERT INTO operations_shopify_external_fulfillment_reconciliations (
       organization_id, command_receipt_id, order_id,
       integration_account_id, plan_id, wave_id, external_order_id,
       provider_order_name, provider_order_updated_at,
       provider_fulfillment_id, provider_fulfillment_name,
       provider_fulfillment_created_at, provider_fulfillment_updated_at,
       provider_location_id, provider_fulfillment_order_ids,
       evidence_hash, evidence_snapshot, provider_read_count,
       provider_write_count, reason, reconciled_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7,
       $8, $9::timestamptz, $10, $11, $12::timestamptz,
       $13::timestamptz, $14, $15::text[], repeat('8', 64), $16::jsonb,
       2, 0, $17, $18
     )`,
    [
      fixture.organizationId,
      receipt.rows[0].id,
      fixture.fulfilled.id,
      fixture.accountId,
      plan.rows[0].id,
      wave.rows[0].id,
      fixture.fulfilled.external_order_id,
      fixture.fulfilled.order_number,
      providerOrderUpdatedAt,
      fulfillmentGid,
      '#REVERSAL-ACCEPTANCE',
      new Date(Date.now() - 120_000).toISOString(),
      fulfillmentUpdatedAt,
      'gid://shopify/Location/6600001',
      ['gid://shopify/FulfillmentOrder/6600001'],
      JSON.stringify(evidenceSnapshot),
      'Exact external fulfillment evidence for reversal acceptance',
      fixture.ownerEmail,
    ],
  )
  return {
    expectedOrderRowVersion: Number(cancelledOrder.rows[0].row_version),
    fulfillmentGid,
    fulfillmentUpdatedAt,
    providerOrderUpdatedAt,
    planId: plan.rows[0].id,
    historicalPlanId: historicalPlan.rows[0].id,
    warehouseId,
    waveId: wave.rows[0].id,
    orderLineId: orderLine.rows[0].id,
    allocationId: allocation.rows[0].id,
    locationId: location.rows[0].id,
    inventoryPositionId: inventoryPosition.rows[0].id,
    releasedReservationId: releasedReservation.rows[0].id,
    retainedPackageId: retainedPackage.rows[0].id,
    packagingMaterialId: packagingMaterial.rows[0].id,
    packagingStockId: packagingStock.rows[0].id,
    packagingStockRowVersion: Number(packagingStock.rows[0].row_version),
    carrierRateId: carrierRate.rows[0].id,
  }
}

async function seedLegacyCancellationAuthorization(
  pool,
  fixture,
  status,
  legacyIntentHash,
) {
  const activation = await pool.query(
    `SELECT state, revision::text
     FROM operations_activation_scopes
     WHERE organization_id = $1::uuid`,
    [fixture.organizationId],
  )
  assert.equal(activation.rowCount, 1)
  const now = Date.now()
  const preparedAt = new Date(
    now - (status === 'prepared' ? 60_000 : 10 * 60_000),
  ).toISOString()
  const observedAt = new Date(
    now - (status === 'prepared' ? 30_000 : 9 * 60_000),
  ).toISOString()
  const evidenceHash = createHash('sha256')
    .update(`${fixture.organizationId}:${status}`)
    .digest('hex')
  const authorization = await pool.query(
    `INSERT INTO operations_shopify_order_management_authorizations (
       organization_id, integration_account_id, integration_account_global_id,
       provider, account_environment, external_account_id, shop_domain,
       credential_generation, activation_state, activation_revision,
       provider_write_control_row_version, provider_write_scope_digest,
       order_id, order_global_id, external_order_id, order_number,
       expected_order_row_version, expected_source_hash,
       accepted_observation_id, accepted_provider_order_updated_at,
       provider_order_updated_at, provider_order_observed_at,
       provider_order_test, provider_snapshot_hash, action, cancel_reason,
       authorization_reason, intent_hash, idempotency_key, request_hash,
       status, authorized_by, authorized_role, prepared_at, expires_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'shopify', 'sandbox',
       'gid://shopify/Shop/6600001',
       'ag-alchemy-order-management.myshopify.com',
       1, $4, $5::integer, NULL, NULL,
       $6::uuid, $7, $8, $9, $10::bigint, $11,
       $12::uuid, $13::timestamptz, $13::timestamptz, $14::timestamptz,
       true, $15, 'cancel', 'OTHER',
       'Migration-era cancellation recovery regression', $16, $17, $15,
       'prepared', $18, 'owner', $19::timestamptz,
       $19::timestamptz + interval '5 minutes'
     ) RETURNING id::text, global_id`,
    [
      fixture.organizationId,
      fixture.accountId,
      fixture.accountGlobalId,
      activation.rows[0].state,
      activation.rows[0].revision,
      fixture.current.id,
      fixture.current.global_id,
      fixture.current.external_order_id,
      fixture.current.order_number,
      fixture.current.row_version,
      fixture.currentSourceHash,
      fixture.currentAcceptedObservationId,
      fixture.currentAcceptedProviderUpdatedAt,
      observedAt,
      evidenceHash,
      legacyIntentHash,
      `legacy-cancel-${status}-${randomUUID()}`,
      fixture.ownerEmail,
      preparedAt,
    ],
  )
  if (status === 'prepared') return authorization.rows[0]

  const attempt = await pool.query(
    `INSERT INTO operations_shopify_order_management_attempts (
       organization_id, authorization_id, integration_account_id,
       integration_account_global_id, provider, external_account_id,
       credential_generation, activation_revision,
       provider_write_control_row_version, provider_write_scope_digest,
       order_id, order_global_id, external_order_id,
       expected_order_row_version, expected_source_hash,
       accepted_observation_id, accepted_provider_order_updated_at,
       provider_snapshot_hash, action, intent_hash, attempt_hash,
       dispatch_state, claimed_by, claimed_at,
       processing_lease_expires_at
     ) SELECT
       $1::uuid, $2::uuid, $3::uuid, $4, 'shopify',
       'gid://shopify/Shop/6600001', 1, $5::integer, NULL, NULL,
       $6::uuid, $7, $8, $9::bigint, $10, $11::uuid,
       $12::timestamptz, $13, 'cancel', $13, $14,
       'authorized', $15, claim_clock.claimed_at,
       claim_clock.claimed_at + interval '5 minutes'
     FROM (SELECT clock_timestamp() - interval '10 minutes' AS claimed_at) claim_clock
     RETURNING id::text, global_id, claimed_at`,
    [
      fixture.organizationId,
      authorization.rows[0].id,
      fixture.accountId,
      fixture.accountGlobalId,
      activation.rows[0].revision,
      fixture.current.id,
      fixture.current.global_id,
      fixture.current.external_order_id,
      fixture.current.row_version,
      fixture.currentSourceHash,
      fixture.currentAcceptedObservationId,
      fixture.currentAcceptedProviderUpdatedAt,
      legacyIntentHash,
      createHash('sha256').update(`${evidenceHash}:attempt`).digest('hex'),
      fixture.ownerEmail,
    ],
  )
  await pool.query(
    `UPDATE operations_shopify_order_management_authorizations
     SET status = 'processing', provider_attempt_id = $3::uuid,
         processing_at = $4::timestamptz
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [
      fixture.organizationId,
      authorization.rows[0].id,
      attempt.rows[0].id,
      attempt.rows[0].claimed_at,
    ],
  )
  if (status === 'processing') {
    return { ...authorization.rows[0], attempt: attempt.rows[0] }
  }
  const outcomeHash = createHash('sha256')
    .update(`${evidenceHash}:unknown`)
    .digest('hex')
  const outcome = await pool.query(
    `INSERT INTO operations_shopify_order_management_outcomes (
       organization_id, authorization_id, provider_attempt_id,
       outcome_state, provider_write_count, evidence_hash, error_code,
       recorded_by
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'unknown', NULL, $4,
       'SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED', $5)
     RETURNING id::text, global_id, recorded_at`,
    [
      fixture.organizationId,
      authorization.rows[0].id,
      attempt.rows[0].id,
      outcomeHash,
      fixture.ownerEmail,
    ],
  )
  await pool.query(
    `UPDATE operations_shopify_order_management_authorizations
     SET status = 'unknown', latest_outcome_id = $3::uuid,
         completed_at = $4::timestamptz
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [
      fixture.organizationId,
      authorization.rows[0].id,
      outcome.rows[0].id,
      outcome.rows[0].recorded_at,
    ],
  )
  return {
    ...authorization.rows[0],
    attempt: attempt.rows[0],
    outcome: outcome.rows[0],
  }
}

async function verifyLegacyCancellationUpgrade(pool) {
  const audits = []
  const persistence = loadTypeScriptModule(
    'app_src/lib/persistence/shopifyOrderManagement.ts',
    {
      '@/lib/auditWriter': {
        async recordAuditEvent(event) { audits.push(event) },
      },
      '@/lib/persistence/postgres': postgresAdapter(pool),
    },
  )
  const legacyReason = 'Migration-era cancellation recovery regression'
  const legacyClaimAction = {
    type: 'cancel',
    reason: 'OTHER',
    refundMethod: 'none',
    restock: false,
    notifyCustomer: false,
  }
  const legacyIntentHash = persistence.shopifyOrderManagementEvidenceHash({
    schema: 'shopify-order-management-intent-v1',
    action: { type: 'cancel', reason: 'OTHER' },
    reason: legacyReason,
    expectedLineQuantity: null,
  })
  const preparedFixture = await seed(pool)
  const processingFixture = await seed(pool)
  const unknownFixture = await seed(pool)
  await pool.query('SET session_replication_role = replica')
  let prepared
  let processing
  let unknown
  try {
    prepared = await seedLegacyCancellationAuthorization(
      pool, preparedFixture, 'prepared', legacyIntentHash,
    )
    processing = await seedLegacyCancellationAuthorization(
      pool, processingFixture, 'processing', legacyIntentHash,
    )
    unknown = await seedLegacyCancellationAuthorization(
      pool, unknownFixture, 'unknown', legacyIntentHash,
    )
  } finally {
    await pool.query('SET session_replication_role = origin')
  }
  await applyMigration(
    pool,
    '0337_operations_shopify_ordinary_order_cancellation.sql',
  )

  const upgraded = await pool.query(
    `SELECT status, cancel_refund_method, cancel_restock,
            cancel_notify_customer, cancellation_payment_evidence,
            legacy_cancellation_without_payment_evidence
     FROM operations_shopify_order_management_authorizations
     WHERE id = ANY($1::uuid[])
     ORDER BY status`,
    [[prepared.id, processing.id, unknown.id]],
  )
  assert.equal(upgraded.rowCount, 3)
  for (const row of upgraded.rows) {
    assert.equal(row.cancel_refund_method, 'none')
    assert.equal(row.cancel_restock, false)
    assert.equal(row.cancel_notify_customer, false)
    assert.equal(row.cancellation_payment_evidence, null)
    assert.equal(row.legacy_cancellation_without_payment_evidence, true)
  }

  const claimed = await persistence.claimShopifyOrderManagementInPostgres({
    organizationId: preparedFixture.organizationId,
    actorEmail: preparedFixture.ownerEmail,
    authorizationGlobalId: prepared.global_id,
    action: legacyClaimAction,
    reason: legacyReason,
  })
  assert.equal(claimed.status, 'processing')
  const recovered = await persistence
    .recoverStaleShopifyOrderManagementAttemptInPostgres({
      organizationId: processingFixture.organizationId,
      actorEmail: processingFixture.ownerEmail,
      authorizationGlobalId: processing.global_id,
      providerAttemptGlobalId: processing.attempt.global_id,
    })
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.authorization.status, 'unknown')
  const reconciled = await persistence
    .reconcileShopifyOrderManagementOutcomeInPostgres({
      organizationId: unknownFixture.organizationId,
      actorEmail: unknownFixture.ownerEmail,
      authorizationGlobalId: unknown.global_id,
      providerAttemptGlobalId: unknown.attempt.global_id,
      resolution: 'not_applied',
      evidence: { exactRead: true, cancellationAbsent: true },
      providerWriteCount: null,
    })
  assert.equal(reconciled.status, 'reconciled')
  const statuses = await pool.query(
    `SELECT id::text, status
     FROM operations_shopify_order_management_authorizations
     WHERE id = ANY($1::uuid[])`,
    [[prepared.id, processing.id, unknown.id]],
  )
  assert.deepEqual(
    new Map(statuses.rows.map((row) => [row.id, row.status])),
    new Map([
      [prepared.id, 'processing'],
      [processing.id, 'unknown'],
      [unknown.id, 'reconciled'],
    ]),
  )
}

function snapshot(test, providerOrderUpdatedAt = null) {
  const observedAt = new Date()
  return {
    providerOrderUpdatedAt: providerOrderUpdatedAt
      || new Date(observedAt.getTime() - 1_000).toISOString(),
    providerOrderObservedAt: observedAt.toISOString(),
    providerOrderTest: test,
  }
}

async function appendProviderWriteControl(pool, fixture, rowVersion, mode) {
  await pool.query(
    `INSERT INTO operations_commerce_provider_write_controls (
       organization_id, integration_account_id, provider, row_version,
       expected_row_version, requested_mode, bound_credential_generation,
       bound_granted_scopes, bound_granted_scope_digest, changed_by,
       changed_role, idempotency_key, request_hash
     )
     SELECT
       account.organization_id, account.id, 'shopify', $3::bigint,
       $3::bigint - 1, $4,
       CASE WHEN $4 = 'on' THEN account.commerce_credential_generation END,
       CASE WHEN $4 = 'on' THEN
         operations_commerce_granted_scope_snapshot(account.configuration)
       END,
       CASE WHEN $4 = 'on' THEN
         operations_commerce_granted_scope_digest(
           operations_commerce_granted_scope_snapshot(account.configuration)
         )
       END,
       $5, 'owner', $6, encode(digest(convert_to($6, 'UTF8'), 'sha256'), 'hex')
     FROM operations_integration_accounts account
     WHERE account.organization_id = $1::uuid
       AND account.id = $2::uuid`,
    [
      fixture.organizationId,
      fixture.accountId,
      rowVersion,
      mode,
      fixture.ownerEmail,
      `shopify-order-provider-writes-${mode}-${rowVersion}-${randomUUID()}`,
    ],
  )
}

async function waitForCompetingBackendLock(pool, excludedPid, message) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const activity = await pool.query(
      `SELECT pid, state, wait_event_type
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND pid <> $1::integer
         AND state = 'active'
         AND wait_event_type = 'Lock'`,
      [excludedPid],
    )
    if (activity.rowCount > 0) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  assert.fail(`${message}: preparation never waited on the downstream lock`)
}

async function assertDownstreamWinsBeforePreparation(input) {
  const downstreamClient = await input.pool.connect()
  let prepareResult = null
  try {
    await downstreamClient.query('BEGIN')
    await downstreamClient.query("SET LOCAL statement_timeout = '10s'")
    const backend = await downstreamClient.query(
      'SELECT pg_backend_pid()::integer AS pid',
    )
    await downstreamClient.query(
      `UPDATE operations_fulfillment_plans
       SET status = 'released', updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, input.planId],
    )
    prepareResult = input.prepare().then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    )
    await waitForCompetingBackendLock(
      input.pool,
      backend.rows[0].pid,
      'downstream-before-preparation race',
    )
    await downstreamClient.query('COMMIT')
    const result = await prepareResult
    assert.equal(result.value, null)
    const rejectionMessage = String(result.error?.message || result.error)
    assert.ok(
      result.error?.code === 'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT'
        || (
          result.error?.code === 'P0001'
          && /Shopify fulfillment reversal authorization is not current or permitted/iu
            .test(rejectionMessage)
        ),
      `preparation must fail through an exact currentness fence after downstream commit: ${rejectionMessage}`,
    )
  } finally {
    await downstreamClient.query('ROLLBACK').catch(() => undefined)
    downstreamClient.release()
    if (prepareResult) await prepareResult.catch(() => undefined)
  }
  await input.pool.query(
    `UPDATE operations_fulfillment_plans
     SET status = 'cancelled', updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [input.organizationId, input.planId],
  )
}

async function assertFulfillmentReversalDownstreamGuards(
  pool,
  fixture,
  evidence,
) {
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `UPDATE operations_fulfillment_plans
       SET status = 'released', updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, evidence.historicalPlanId],
    ),
    'cancelled fulfillment-plan history must not reactivate during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `UPDATE operations_waves
       SET status = 'released'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, evidence.waveId],
    ),
    'exact reconciliation wave must not reactivate during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `UPDATE operations_reservations
       SET status = 'active', released_at = NULL
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, evidence.releasedReservationId],
    ),
    'released inventory reservation must not reactivate during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `INSERT INTO operations_pick_tasks (
         organization_id, wave_id, plan_id, allocation_id, from_location_id,
         quantity, sequence_number, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, 1, 'ready'
       )`,
      [
        fixture.organizationId,
        evidence.waveId,
        evidence.planId,
        evidence.allocationId,
        evidence.locationId,
      ],
    ),
    'pick creation through plan lineage must be rejected during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `INSERT INTO operations_packaging_material_claims (
         organization_id, plan_id, packaging_material_id, warehouse_id,
         packaging_material_stock_id, quantity, status,
         stock_row_version_at_claim, on_hand_quantity_at_claim, created_by,
         updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, 'active',
         $6::bigint, 10, $7, $7
       )`,
      [
        fixture.organizationId,
        evidence.planId,
        evidence.packagingMaterialId,
        evidence.warehouseId,
        evidence.packagingStockId,
        evidence.packagingStockRowVersion,
        fixture.ownerEmail,
      ],
    ),
    'packaging claim creation through plan lineage must be rejected during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `UPDATE operations_packages
       SET status = 'packed', packed_by = $3, packed_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, evidence.retainedPackageId, fixture.ownerEmail],
    ),
    'retained planned carton must not become packed during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `INSERT INTO operations_labels (
         organization_id, package_id, carrier_rate_id, carrier,
         service_code, tracking_number, format, label_payload,
         provider_label_id, idempotency_key, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'UPS', 'GROUND', $4, 'PDF',
         'guarded-label', $5, $6, 'created'
       )`,
      [
        fixture.organizationId,
        evidence.retainedPackageId,
        evidence.carrierRateId,
        `REV${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        `provider-reversal-${randomUUID()}`,
        `fulfillment-reversal-label-${randomUUID()}`,
      ],
    ),
    'carrier label creation through package lineage must be rejected during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `INSERT INTO operations_fulfillment_executions (
         organization_id, order_id, plan_id, checkout_pack_rate_run_id,
         fulfillment_pack_rate_run_id, authority_mode, state,
         idempotency_key, request_hash, prepared_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'shadow',
         'shadow_prepared', $6, repeat('1', 64), $7
       )`,
      [
        fixture.organizationId,
        fixture.fulfilled.id,
        evidence.planId,
        randomUUID(),
        randomUUID(),
        `fulfillment-reversal-execution-${randomUUID()}`,
        fixture.ownerEmail,
      ],
    ),
    'fulfillment execution creation must be rejected during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `INSERT INTO operations_active_fulfillment_executions (
         organization_id, shadow_fulfillment_execution_id, order_id,
         plan_id, warehouse_id, authority_mode, state,
         activation_revision, idempotency_key, request_hash, prepared_by,
         expected_order_row_version, reason
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'active',
         'prepared', 1, $6, repeat('6', 64), $7, $8::bigint,
         'Active execution must not race fulfillment reversal'
       )`,
      [
        fixture.organizationId,
        randomUUID(),
        fixture.fulfilled.id,
        evidence.planId,
        evidence.warehouseId,
        `fulfillment-reversal-active-execution-${randomUUID()}`,
        fixture.ownerEmail,
        evidence.expectedOrderRowVersion,
      ],
    ),
    'active fulfillment execution creation must be rejected during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `INSERT INTO operations_shipments (
         organization_id, order_id, plan_id, package_id, label_id, status,
         tracking_number, quoted_carrier_cost_minor, confirmed_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'confirmed',
         $6, 100, $7
       )`,
      [
        fixture.organizationId,
        fixture.fulfilled.id,
        evidence.planId,
        evidence.retainedPackageId,
        randomUUID(),
        `REV${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        fixture.ownerEmail,
      ],
    ),
    'shipment creation must be rejected during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider,
         external_order_id, state, payload_snapshot, idempotency_key
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify', $4, 'queued',
         '{}'::jsonb, $5
       )`,
      [
        fixture.organizationId,
        fixture.fulfilled.id,
        randomUUID(),
        fixture.fulfilled.external_order_id,
        `fulfillment-reversal-export-${randomUUID()}`,
      ],
    ),
    'commerce fulfillment export creation must be rejected during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `INSERT INTO operations_label_attempts (
         organization_id, order_id, package_id, carrier_rate_id,
         integration_account_id, carrier_account_id, action, state,
         environment, provider, adapter_version, idempotency_key,
         request_hash, redacted_request, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         'create', 'prepared', 'sandbox', 'ups_rest', 'guard-v1', $7,
         repeat('2', 64), '{}'::jsonb, $8
       )`,
      [
        fixture.organizationId,
        fixture.fulfilled.id,
        evidence.retainedPackageId,
        evidence.carrierRateId,
        fixture.accountId,
        randomUUID(),
        `fulfillment-reversal-attempt-${randomUUID()}`,
        fixture.ownerEmail,
      ],
    ),
    'carrier label attempt creation must be rejected during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `INSERT INTO operations_shipment_groups (
         organization_id, fulfillment_execution_id, order_id, plan_id,
         warehouse_id, fulfillment_pack_rate_run_id, selected_provider,
         selected_service_code, selected_service_name,
         selected_carrier_cost_minor, currency, state,
         selected_carrier_account_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         'ups_rest', 'GROUND', 'UPS Ground', 100, 'USD', 'shadow_prepared',
         $7::uuid
       )`,
      [
        fixture.organizationId,
        randomUUID(),
        fixture.fulfilled.id,
        evidence.planId,
        evidence.warehouseId,
        randomUUID(),
        randomUUID(),
      ],
    ),
    'shipment-group creation must be rejected during reversal',
  )
  await expectFulfillmentReversalRaceRejected(
    () => pool.query(
      `INSERT INTO operations_production_fulfillment_rerate_runs (
         organization_id, active_fulfillment_execution_id,
         active_shipment_group_id, order_id, plan_id, warehouse_id,
         source_fulfillment_pack_rate_run_id, activation_revision,
         currency, input_hash, destination_snapshot,
         destination_fingerprint, ordered_package_set_fingerprint,
         package_count, idempotency_key, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7::uuid, 1, 'USD', repeat('3', 64), '{}'::jsonb,
         repeat('4', 64), repeat('5', 64), 1, $8, $9
       )`,
      [
        fixture.organizationId,
        randomUUID(),
        randomUUID(),
        fixture.fulfilled.id,
        evidence.planId,
        evidence.warehouseId,
        randomUUID(),
        `fulfillment-reversal-rerate-${randomUUID()}`,
        fixture.ownerEmail,
      ],
    ),
    'production rerate creation must be rejected during reversal',
  )
}

async function verify(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 60_000,
    max: 4,
  })
  const audits = []
  const transactionControl = { beforeCommit: null }
  try {
    const fixture = await seed(pool)
    const independentFixture = await seed(pool)
    const reversalFixture = await seed(pool)
    // This acceptance isolates the 0283 unresolved-attempt race. The 0290
    // Shadow canonical-plan fence has its own PostgreSQL acceptance suite.
    await pool.query(
      `ALTER TABLE operations_fulfillment_plans
       DISABLE TRIGGER guard_shadow_commerce_canonical_plan_insert`,
    )
    const reversalEvidence = await seedFulfillmentReversalEvidence(
      pool,
      reversalFixture,
    )
    const persistence = loadTypeScriptModule(
      'app_src/lib/persistence/shopifyOrderManagement.ts',
      {
        '@/lib/auditWriter': {
          async recordAuditEvent(event) {
            audits.push(event)
          },
        },
        '@/lib/persistence/postgres': postgresAdapter(pool, transactionControl),
      },
    )

    const reversalSafety = async () => {
      const result = await pool.query(
        `SELECT operations_shopify_fulfillment_reversal_is_safe(
           $1::uuid, $2::uuid, $3, $4::timestamptz
         ) AS safe`,
        [
          reversalFixture.organizationId,
          reversalFixture.fulfilled.id,
          reversalEvidence.fulfillmentGid,
          reversalEvidence.fulfillmentUpdatedAt,
        ],
      )
      return result.rows[0]?.safe === true
    }
    const productionShape = await pool.query(
      `SELECT
         (
           SELECT count(*)::integer
           FROM operations_fulfillment_plans plan
           WHERE plan.organization_id = $1::uuid
             AND plan.order_id = $2::uuid
             AND plan.status = 'cancelled'
         ) AS cancelled_plan_count,
         (
           SELECT count(*)::integer
           FROM operations_fulfillment_plans plan
           WHERE plan.organization_id = $1::uuid
             AND plan.order_id = $2::uuid
             AND plan.id = $3::uuid
         ) AS exact_reconciliation_plan_count,
         package.status AS retained_package_status,
         package.packed_by,
         package.packed_at,
         (
           SELECT count(*)::integer
           FROM operations_package_contents content
           WHERE content.organization_id = package.organization_id
             AND content.package_id = package.id
         ) AS retained_content_count
       FROM operations_packages package
       WHERE package.organization_id = $1::uuid
         AND package.id = $4::uuid
         AND package.plan_id = $3::uuid`,
      [
        reversalFixture.organizationId,
        reversalFixture.fulfilled.id,
        reversalEvidence.planId,
        reversalEvidence.retainedPackageId,
      ],
    )
    assert.equal(productionShape.rowCount, 1)
    assert.equal(
      productionShape.rows[0].cancelled_plan_count,
      2,
      'two cancelled plan versions model retained production history',
    )
    assert.equal(productionShape.rows[0].exact_reconciliation_plan_count, 1)
    assert.equal(productionShape.rows[0].retained_package_status, 'planned')
    assert.equal(productionShape.rows[0].packed_by, null)
    assert.equal(productionShape.rows[0].packed_at, null)
    assert.equal(productionShape.rows[0].retained_content_count, 1)
    assert.equal(
      await reversalSafety(),
      true,
      'two cancelled plan versions plus retained planned cartons must remain reversible',
    )
    const activeBlockerClient = await pool.connect()
    try {
      await activeBlockerClient.query('BEGIN')
      await activeBlockerClient.query(
        'SET LOCAL session_replication_role = replica',
      )
      await activeBlockerClient.query(
        `INSERT INTO operations_active_fulfillment_executions (
           organization_id, shadow_fulfillment_execution_id, order_id,
           plan_id, warehouse_id, authority_mode, state,
           activation_revision, idempotency_key, request_hash, prepared_by,
           expected_order_row_version, reason
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           'active', 'prepared', 1, $6, repeat('6', 64), $7,
           $8::bigint, 'Active carrier execution blocks reversal'
         )`,
        [
          reversalFixture.organizationId,
          randomUUID(),
          reversalFixture.fulfilled.id,
          reversalEvidence.planId,
          reversalEvidence.warehouseId,
          `active-reversal-blocker-${randomUUID()}`,
          reversalFixture.ownerEmail,
          reversalEvidence.expectedOrderRowVersion,
        ],
      )
      const blocked = await activeBlockerClient.query(
        `SELECT operations_shopify_fulfillment_reversal_is_safe(
           $1::uuid, $2::uuid, $3, $4::timestamptz
         ) AS safe`,
        [
          reversalFixture.organizationId,
          reversalFixture.fulfilled.id,
          reversalEvidence.fulfillmentGid,
          reversalEvidence.fulfillmentUpdatedAt,
        ],
      )
      assert.equal(
        blocked.rows[0]?.safe,
        false,
        'active carrier execution evidence must block fulfillment reversal',
      )
      await activeBlockerClient.query('ROLLBACK')
    } finally {
      await activeBlockerClient.query('ROLLBACK').catch(() => undefined)
      activeBlockerClient.release()
    }
    assert.equal(await reversalSafety(), true)

    const reversalAction = {
      type: 'cancel_fulfillment',
      fulfillmentGid: reversalEvidence.fulfillmentGid,
      expectedFulfillmentUpdatedAt: reversalEvidence.fulfillmentUpdatedAt,
    }
    const reversalReason =
      'Reverse the exact externally reconciled Shopify fulfillment'
    const reversalPreparationInput = {
      organizationId: reversalFixture.organizationId,
      actorEmail: reversalFixture.ownerEmail,
      accountGlobalId: reversalFixture.accountGlobalId,
      orderGlobalId: reversalFixture.fulfilled.global_id,
      expectedOrderRowVersion: reversalEvidence.expectedOrderRowVersion,
      expectedSourceHash: reversalFixture.fulfilledSourceHash,
      ...snapshot(true, reversalEvidence.providerOrderUpdatedAt),
      action: reversalAction,
      reason: reversalReason,
    }
    await assertDownstreamWinsBeforePreparation({
      pool,
      organizationId: reversalFixture.organizationId,
      planId: reversalEvidence.planId,
      prepare: () => persistence.prepareShopifyOrderManagementInPostgres({
        ...reversalPreparationInput,
        idempotencyKey: 'shopify-fulfillment-reversal-downstream-first',
      }),
    })
    assert.equal(await reversalSafety(), true)
    const reversalPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        ...reversalPreparationInput,
        ...snapshot(true, reversalEvidence.providerOrderUpdatedAt),
        idempotencyKey: 'shopify-fulfillment-reversal-exact',
      })
    assert.equal(
      reversalPrepared.fulfillmentGid,
      reversalEvidence.fulfillmentGid,
    )
    assert.equal(
      reversalPrepared.expectedFulfillmentUpdatedAt,
      reversalEvidence.fulfillmentUpdatedAt,
    )
    const preparedDownstream = await pool.query(
      `UPDATE operations_fulfillment_plans
       SET status = 'released', updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND id = $2::uuid
       RETURNING status`,
      [reversalFixture.organizationId, reversalEvidence.historicalPlanId],
    )
    assert.equal(
      preparedDownstream.rows[0]?.status,
      'released',
      'prepared authorization must not freeze zero-write downstream work',
    )
    await expectRejected(
      () => persistence.claimShopifyOrderManagementInPostgres({
        organizationId: reversalFixture.organizationId,
        actorEmail: reversalFixture.ownerEmail,
        authorizationGlobalId: reversalPrepared.authorizationGlobalId,
        action: reversalAction,
        reason: reversalReason,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
      'downstream work after preparation must invalidate the final claim',
    )
    await pool.query(
      `UPDATE operations_fulfillment_plans
       SET status = 'cancelled', updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [reversalFixture.organizationId, reversalEvidence.historicalPlanId],
    )
    await expectRejected(
      () => persistence.claimShopifyOrderManagementInPostgres({
        organizationId: reversalFixture.organizationId,
        actorEmail: reversalFixture.ownerEmail,
        authorizationGlobalId: reversalPrepared.authorizationGlobalId,
        action: {
          ...reversalAction,
          fulfillmentGid: 'gid://shopify/Fulfillment/999999999999',
        },
        reason: reversalReason,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_MISMATCH',
      'a different fulfillment GID must not claim the authorization',
    )
    await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_shopify_order_management_attempts (
           organization_id, authorization_id, integration_account_id,
           integration_account_global_id, provider, external_account_id,
           credential_generation, provider_write_control_row_version,
           provider_write_scope_digest, order_id, order_global_id,
           external_order_id, expected_order_row_version,
           expected_source_hash, provider_snapshot_hash, action,
           fulfillment_gid, expected_fulfillment_updated_at, intent_hash,
           expected_line_quantity, requested_projection_hash,
           requires_order_edits, attempt_hash, dispatch_state, claimed_by,
           accepted_observation_id, accepted_provider_order_updated_at,
           claimed_at, processing_lease_expires_at
         )
         SELECT
           authz.organization_id, authz.id, authz.integration_account_id,
           authz.integration_account_global_id, authz.provider,
           authz.external_account_id, authz.credential_generation,
           authz.provider_write_control_row_version,
           authz.provider_write_scope_digest, authz.order_id,
           authz.order_global_id, authz.external_order_id,
           authz.expected_order_row_version, authz.expected_source_hash,
           authz.provider_snapshot_hash, authz.action, $3,
           authz.expected_fulfillment_updated_at, authz.intent_hash,
           authz.expected_line_quantity, authz.requested_projection_hash,
           authz.requires_order_edits, repeat('5', 64), 'authorized',
           authz.authorized_by, authz.accepted_observation_id,
           authz.accepted_provider_order_updated_at, clock_timestamp(),
           clock_timestamp() + interval '5 minutes'
         FROM operations_shopify_order_management_authorizations authz
         WHERE authz.organization_id = $1::uuid AND authz.global_id = $2`,
        [
          reversalFixture.organizationId,
          reversalPrepared.authorizationGlobalId,
          'gid://shopify/Fulfillment/999999999999',
        ],
      ),
      /fulfillment reversal provider attempt is not currently authorized/iu,
      'database trigger must reject a mismatched fulfillment GID',
    )
    const reversalAttemptBeforeClaim = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_shopify_order_management_attempts attempt
       JOIN operations_shopify_order_management_authorizations authz
         ON authz.organization_id = attempt.organization_id
        AND authz.id = attempt.authorization_id
       WHERE authz.organization_id = $1::uuid AND authz.global_id = $2`,
      [
        reversalFixture.organizationId,
        reversalPrepared.authorizationGlobalId,
      ],
    )
    assert.equal(reversalAttemptBeforeClaim.rows[0].count, 0)
    const reversalClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: reversalFixture.organizationId,
        actorEmail: reversalFixture.ownerEmail,
        authorizationGlobalId: reversalPrepared.authorizationGlobalId,
        action: reversalAction,
        reason: reversalReason,
      })
    assert.equal(
      reversalClaimed.fulfillmentGid,
      reversalEvidence.fulfillmentGid,
    )
    assert.equal(
      reversalClaimed.expectedFulfillmentUpdatedAt,
      reversalEvidence.fulfillmentUpdatedAt,
    )
    await assertFulfillmentReversalDownstreamGuards(
      pool,
      reversalFixture,
      reversalEvidence,
    )
    const reversalStored = await pool.query(
      `SELECT
         authz.fulfillment_gid AS authorization_fulfillment_gid,
         authz.expected_fulfillment_updated_at
           AS authorization_fulfillment_updated_at,
         attempt.fulfillment_gid AS attempt_fulfillment_gid,
         attempt.expected_fulfillment_updated_at
           AS attempt_fulfillment_updated_at
       FROM operations_shopify_order_management_authorizations authz
       JOIN operations_shopify_order_management_attempts attempt
         ON attempt.organization_id = authz.organization_id
        AND attempt.authorization_id = authz.id
       WHERE authz.organization_id = $1::uuid AND authz.global_id = $2`,
      [
        reversalFixture.organizationId,
        reversalPrepared.authorizationGlobalId,
      ],
    )
    assert.equal(reversalStored.rowCount, 1)
    assert.equal(
      reversalStored.rows[0].authorization_fulfillment_gid,
      reversalEvidence.fulfillmentGid,
    )
    assert.equal(
      reversalStored.rows[0].attempt_fulfillment_gid,
      reversalEvidence.fulfillmentGid,
    )
    assert.equal(
      new Date(
        reversalStored.rows[0].authorization_fulfillment_updated_at,
      ).toISOString(),
      reversalEvidence.fulfillmentUpdatedAt,
    )
    assert.equal(
      new Date(
        reversalStored.rows[0].attempt_fulfillment_updated_at,
      ).toISOString(),
      reversalEvidence.fulfillmentUpdatedAt,
    )
    const unknownReversal = await persistence
      .recordShopifyOrderManagementOutcomeInPostgres({
      organizationId: reversalFixture.organizationId,
      actorEmail: reversalFixture.ownerEmail,
      authorizationGlobalId: reversalPrepared.authorizationGlobalId,
      providerAttemptGlobalId: reversalClaimed.providerAttemptGlobalId,
      outcome: 'unknown',
      evidence: {
        schema: 'shopify-fulfillment-reversal-unknown-postgres-test-v1',
        fulfillmentGid: reversalEvidence.fulfillmentGid,
      },
      errorCode: 'SHOPIFY_FULFILLMENT_REVERSAL_OUTCOME_UNKNOWN',
      providerWriteCount: 1,
    })
    assert.equal(unknownReversal.status, 'unknown')
    await expectFulfillmentReversalRaceRejected(
      () => pool.query(
        `UPDATE operations_fulfillment_plans
         SET status = 'released', updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [reversalFixture.organizationId, reversalEvidence.historicalPlanId],
      ),
      'unknown fulfillment-reversal outcome must block downstream work',
    )
    const reconciledReversal = await persistence
      .reconcileShopifyOrderManagementOutcomeInPostgres({
        organizationId: reversalFixture.organizationId,
        actorEmail: reversalFixture.ownerEmail,
        authorizationGlobalId: reversalPrepared.authorizationGlobalId,
        providerAttemptGlobalId: reversalClaimed.providerAttemptGlobalId,
        resolution: 'applied',
        evidence: {
          schema: 'shopify-fulfillment-reversal-applied-postgres-test-v1',
          fulfillmentGid: reversalEvidence.fulfillmentGid,
          observedStatus: 'CANCELLED',
        },
        providerReference: reversalEvidence.fulfillmentGid,
        providerWriteCount: 1,
      })
    assert.equal(reconciledReversal.status, 'reconciled')
    assert.equal(reconciledReversal.reconciliationResolution, 'applied')
    const postReversalTarget = await persistence
      .readShopifyOrderManagementTargetInPostgres({
        organizationId: reversalFixture.organizationId,
        orderGlobalId: reversalFixture.fulfilled.global_id,
      })
    assert.equal(
      postReversalTarget?.postReversalOrderCancellationSafe,
      true,
    )
    assert.equal(
      postReversalTarget
        ?.postReversalOrderCancellationPredecessorGlobalId,
      reversalPrepared.authorizationGlobalId,
    )
    const postReversalCancelAction = {
      type: 'cancel_order_after_fulfillment_reversal',
      predecessorAuthorizationGlobalId:
        reversalPrepared.authorizationGlobalId,
      reason: 'STAFF',
    }
    const postReversalCancelReason =
      'Separately cancel the test order after exact fulfillment reversal'
    const postReversalCancelPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: reversalFixture.organizationId,
        actorEmail: reversalFixture.ownerEmail,
        accountGlobalId: reversalFixture.accountGlobalId,
        orderGlobalId: reversalFixture.fulfilled.global_id,
        expectedOrderRowVersion: reversalEvidence.expectedOrderRowVersion,
        expectedSourceHash: reversalFixture.fulfilledSourceHash,
        ...snapshot(true, reversalEvidence.providerOrderUpdatedAt),
        action: postReversalCancelAction,
        cancellationPaymentEvidence: {
          schema: 'shopify-order-cancel-payment-evidence-v2',
          transactionsCount: 0,
          transactionsHash: '0'.repeat(64),
          totalReceived: { amount: '0', currencyCode: 'USD' },
          totalRefunded: { amount: '0', currencyCode: 'USD' },
          totalCapturable: { amount: '0', currencyCode: 'USD' },
          refundMethod: 'none',
        },
        reason: postReversalCancelReason,
        idempotencyKey: 'shopify-order-cancel-after-reversal-exact',
      })
    assert.equal(
      postReversalCancelPrepared.predecessorAuthorizationGlobalId,
      reversalPrepared.authorizationGlobalId,
    )
    const postReversalCancelClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: reversalFixture.organizationId,
        actorEmail: reversalFixture.ownerEmail,
        authorizationGlobalId:
          postReversalCancelPrepared.authorizationGlobalId,
        action: postReversalCancelAction,
        reason: postReversalCancelReason,
      })
    assert.equal(
      postReversalCancelClaimed.predecessorAuthorizationGlobalId,
      reversalPrepared.authorizationGlobalId,
    )
    const postReversalPredecessorStored = await pool.query(
      `SELECT
         auth_predecessor.global_id AS authorization_predecessor_global_id,
         attempt_predecessor.global_id AS attempt_predecessor_global_id
       FROM operations_shopify_order_management_authorizations authz
       JOIN operations_shopify_order_management_authorizations auth_predecessor
         ON auth_predecessor.organization_id = authz.organization_id
        AND auth_predecessor.id = authz.predecessor_authorization_id
       JOIN operations_shopify_order_management_attempts attempt
         ON attempt.organization_id = authz.organization_id
        AND attempt.authorization_id = authz.id
       JOIN operations_shopify_order_management_authorizations
         attempt_predecessor
         ON attempt_predecessor.organization_id = attempt.organization_id
        AND attempt_predecessor.id = attempt.predecessor_authorization_id
       WHERE authz.organization_id = $1::uuid AND authz.global_id = $2`,
      [
        reversalFixture.organizationId,
        postReversalCancelPrepared.authorizationGlobalId,
      ],
    )
    assert.equal(postReversalPredecessorStored.rowCount, 1)
    assert.equal(
      postReversalPredecessorStored.rows[0]
        .authorization_predecessor_global_id,
      reversalPrepared.authorizationGlobalId,
    )
    assert.equal(
      postReversalPredecessorStored.rows[0].attempt_predecessor_global_id,
      reversalPrepared.authorizationGlobalId,
    )
    await persistence.recordShopifyOrderManagementOutcomeInPostgres({
      organizationId: reversalFixture.organizationId,
      actorEmail: reversalFixture.ownerEmail,
      authorizationGlobalId:
        postReversalCancelPrepared.authorizationGlobalId,
      providerAttemptGlobalId:
        postReversalCancelClaimed.providerAttemptGlobalId,
      outcome: 'succeeded',
      evidence: {
        schema: 'shopify-post-reversal-order-cancel-postgres-test-v1',
        predecessorAuthorizationGlobalId:
          reversalPrepared.authorizationGlobalId,
      },
      providerReference: 'gid://shopify/Job/6600001',
      providerWriteCount: 1,
    })

    // The new command lane is controlled only by the exact account revision.
    // A disabled global Operations activation must not affect it, and one
    // account being Off must not affect a different organization's account.
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'disabled', revision = revision + 1,
           reason = 'Provider writes owns Shopify order authority',
           updated_by = $3, updated_at = clock_timestamp()
       WHERE organization_id IN ($1::uuid, $2::uuid)`,
      [
        fixture.organizationId,
        independentFixture.organizationId,
        fixture.ownerEmail,
      ],
    )
    await appendProviderWriteControl(pool, fixture, 2, 'off')
    const offTarget = await persistence
      .readShopifyOrderManagementTargetInPostgres({
        organizationId: fixture.organizationId,
        orderGlobalId: fixture.fulfilled.global_id,
      })
    const independentTarget = await persistence
      .readShopifyOrderManagementTargetInPostgres({
        organizationId: independentFixture.organizationId,
        orderGlobalId: independentFixture.fulfilled.global_id,
      })
    assert.equal(offTarget.providerWriteRequestedMode, 'off')
    assert.equal(offTarget.providerWriteBindingCurrent, false)
    assert.equal(independentTarget.providerWriteRequestedMode, 'on')
    assert.equal(independentTarget.providerWriteBindingCurrent, true)
    const offAuthorizationCount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_shopify_order_management_authorizations
       WHERE organization_id = $1::uuid`,
      [fixture.organizationId],
    )
    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: { type: 'add_tag', tag: 'blocked-while-account-off' },
        reason: 'Provider writes Off must reject before durable intent',
        idempotencyKey: 'shopify-order-provider-writes-off',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_PROVIDER_WRITES_OFF',
      'Provider writes Off must reject before authorization',
    )
    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(true),
        action: {
          type: 'save_order',
          email: 'draft@example.com',
          phone: null,
          poNumber: null,
          note: null,
          shippingAddress: {
            firstName: 'Private',
            lastName: 'Draft',
            company: null,
            address1: '10 Provider Writes Off Way',
            address2: null,
            city: 'Raleigh',
            provinceCode: 'NC',
            countryCode: 'US',
            zip: '27601',
            phone: null,
          },
          tagAdds: [],
          tagRemoves: [],
          lineQuantities: [],
        },
        requestedProjectionHash: '6'.repeat(64),
        reason: 'Provider writes Off must block combined order Save',
        idempotencyKey: 'shopify-order-combined-save-off',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_PROVIDER_WRITES_OFF',
      'Provider writes Off must reject combined Save before authorization',
    )
    const afterOffAuthorizationCount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_shopify_order_management_authorizations
       WHERE organization_id = $1::uuid`,
      [fixture.organizationId],
    )
    assert.equal(
      afterOffAuthorizationCount.rows[0].count,
      offAuthorizationCount.rows[0].count,
    )

    const independentAction = {
      type: 'add_tag',
      tag: 'independent-account-stays-on',
    }
    const independentReason =
      'Prove another account remains writable while the first is Off'
    const independentPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: independentFixture.organizationId,
        actorEmail: independentFixture.ownerEmail,
        accountGlobalId: independentFixture.accountGlobalId,
        orderGlobalId: independentFixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(
          independentFixture.fulfilled.row_version,
        ),
        expectedSourceHash: independentFixture.fulfilledSourceHash,
        ...snapshot(false),
        action: independentAction,
        reason: independentReason,
        idempotencyKey: 'shopify-order-independent-account-on',
      })
    assert.equal(independentPrepared.providerWriteControlRowVersion, 1)
    assert.equal(independentPrepared.legacyActivationState, null)
    const independentClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: independentFixture.organizationId,
        actorEmail: independentFixture.ownerEmail,
        authorizationGlobalId: independentPrepared.authorizationGlobalId,
        action: independentAction,
        reason: independentReason,
      })
    await persistence.recordShopifyOrderManagementOutcomeInPostgres({
      organizationId: independentFixture.organizationId,
      actorEmail: independentFixture.ownerEmail,
      authorizationGlobalId: independentPrepared.authorizationGlobalId,
      providerAttemptGlobalId: independentClaimed.providerAttemptGlobalId,
      outcome: 'succeeded',
      evidence: { providerAlreadySatisfied: true },
      providerWriteCount: 0,
    })
    await appendProviderWriteControl(pool, fixture, 3, 'on')

    const adminPermissionAction = {
      type: 'add_tag',
      tag: 'clawpilot-admin-permission-check',
    }
    const adminPermissionReason =
      'Verify normal Shopify order work requires Operations management'
    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.executeOnlyAdminEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: adminPermissionAction,
        reason: adminPermissionReason,
        idempotencyKey: 'shopify-order-admin-execute-only',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_FORBIDDEN',
      'execute-only admin must not authorize Shopify order management',
    )
    const qualifiedAdminPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.manageOnlyAdminEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: adminPermissionAction,
        reason: adminPermissionReason,
        idempotencyKey: 'shopify-order-admin-qualified',
      })
    assert.equal(qualifiedAdminPrepared.authorizedRole, 'admin')
    const qualifiedAdminClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.manageOnlyAdminEmail,
        authorizationGlobalId: qualifiedAdminPrepared.authorizationGlobalId,
        action: adminPermissionAction,
        reason: adminPermissionReason,
      })
    let qualifiedAdminOutcome
    await pool.query(
      `UPDATE app_user_organization_memberships
       SET status = 'disabled', updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND user_email = $2`,
      [fixture.organizationId, fixture.manageOnlyAdminEmail],
    )
    try {
      qualifiedAdminOutcome = await persistence
        .recordShopifyOrderManagementOutcomeInPostgres({
          organizationId: fixture.organizationId,
          actorEmail: fixture.manageOnlyAdminEmail,
          authorizationGlobalId: qualifiedAdminPrepared.authorizationGlobalId,
          providerAttemptGlobalId: qualifiedAdminClaimed.providerAttemptGlobalId,
          outcome: 'succeeded',
          evidence: { exactRead: true, tagAlreadyPresent: true },
          providerWriteCount: 0,
        })
    } finally {
      await pool.query(
        `UPDATE app_user_organization_memberships
         SET status = 'active', updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid AND user_email = $2`,
        [fixture.organizationId, fixture.manageOnlyAdminEmail],
      )
    }
    assert.equal(qualifiedAdminOutcome.status, 'succeeded')

    const offAfterPrepareAction = {
      type: 'add_tag',
      tag: 'provider-writes-off-after-prepare',
    }
    const offAfterPrepareReason =
      'Prove Off after prepare prevents a durable provider attempt'
    const offAfterPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: offAfterPrepareAction,
        reason: offAfterPrepareReason,
        idempotencyKey: 'shopify-order-off-after-prepare',
      })
    await appendProviderWriteControl(pool, fixture, 4, 'off')
    await expectRejected(
      () => persistence.claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: offAfterPrepared.authorizationGlobalId,
        action: offAfterPrepareAction,
        reason: offAfterPrepareReason,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
      'Off after prepare must block before the provider-attempt row',
    )
    const offAfterAttemptCount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_shopify_order_management_attempts attempt
       JOIN operations_shopify_order_management_authorizations authz
         ON authz.organization_id = attempt.organization_id
        AND authz.id = attempt.authorization_id
       WHERE authz.organization_id = $1::uuid
         AND authz.global_id = $2`,
      [fixture.organizationId, offAfterPrepared.authorizationGlobalId],
    )
    assert.equal(offAfterAttemptCount.rows[0].count, 0)
    await appendProviderWriteControl(pool, fixture, 5, 'on')

    const scopeDriftAction = {
      type: 'add_tag',
      tag: 'provider-write-scope-drift',
    }
    const scopeDriftReason =
      'Prove exact granted-scope drift blocks before provider attempt'
    const scopeDriftPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: scopeDriftAction,
        reason: scopeDriftReason,
        idempotencyKey: 'shopify-order-scope-drift',
      })
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration,
             '{grantedScopes}',
             '["read_products","write_products"]'::jsonb
           ),
           updated_at = clock_timestamp(), updated_by = $3
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, fixture.accountId, fixture.ownerEmail],
    )
    await expectRejected(
      () => persistence.claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: scopeDriftPrepared.authorizationGlobalId,
        action: scopeDriftAction,
        reason: scopeDriftReason,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
      'scope drift must block before provider attempt',
    )
    await appendProviderWriteControl(pool, fixture, 6, 'on')
    const productOnlyAuthorizationCount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_shopify_order_management_authorizations
       WHERE organization_id = $1::uuid`,
      [fixture.organizationId],
    )
    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: { type: 'add_tag', tag: 'product-scope-is-not-order-scope' },
        reason: 'write_products alone must not authorize an order command',
        idempotencyKey: 'shopify-order-product-only-scope',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_PROVIDER_WRITES_OFF',
      'On without write_orders must reject before authorization',
    )
    const afterProductOnlyAuthorizationCount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_shopify_order_management_authorizations
       WHERE organization_id = $1::uuid`,
      [fixture.organizationId],
    )
    assert.equal(
      afterProductOnlyAuthorizationCount.rows[0].count,
      productOnlyAuthorizationCount.rows[0].count,
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration,
             '{grantedScopes}',
             '["read_orders","write_merchant_managed_fulfillment_orders","write_order_edits","write_orders"]'::jsonb
           ),
           updated_at = clock_timestamp(), updated_by = $3
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, fixture.accountId, fixture.ownerEmail],
    )
    await appendProviderWriteControl(pool, fixture, 7, 'on')

    const credentialDriftAction = {
      type: 'add_tag',
      tag: 'provider-write-credential-drift',
    }
    const credentialDriftReason =
      'Prove credential generation drift blocks before provider attempt'
    const credentialDriftPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: credentialDriftAction,
        reason: credentialDriftReason,
        idempotencyKey: 'shopify-order-credential-drift',
      })
    const credentialDriftClient = await pool.connect()
    await credentialDriftClient.query('BEGIN')
    try {
      await credentialDriftClient.query(
        `UPDATE operations_commerce_credentials
         SET credential_version = 2,
             credential_ciphertext = decode('04', 'hex'),
             credential_identifier_last_four = '0002',
             updated_at = clock_timestamp(), updated_by = $3
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [fixture.organizationId, fixture.accountId, fixture.ownerEmail],
      )
      await credentialDriftClient.query(
        `UPDATE operations_integration_accounts
         SET commerce_credential_generation = 2,
             updated_at = clock_timestamp(), updated_by = $3
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [fixture.organizationId, fixture.accountId, fixture.ownerEmail],
      )
      await credentialDriftClient.query('COMMIT')
    } catch (error) {
      await credentialDriftClient.query('ROLLBACK')
      throw error
    } finally {
      credentialDriftClient.release()
    }
    await expectRejected(
      () => persistence.claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: credentialDriftPrepared.authorizationGlobalId,
        action: credentialDriftAction,
        reason: credentialDriftReason,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
      'credential drift must block before provider attempt',
    )
    await appendProviderWriteControl(pool, fixture, 8, 'on')

    const tagAction = { type: 'add_tag', tag: 'clawpilot-test-6600' }
    const tagReason = 'Validate an additive marker on fulfilled order 6600'
    const preparedTag = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: tagAction,
        reason: tagReason,
        idempotencyKey: 'shopify-order-tag-6600-0001',
      })
    assert.equal(preparedTag.status, 'prepared')
    assert.equal(preparedTag.providerOrderTest, false)
    assert.equal(preparedTag.action, 'add_tag')
    assert.equal(preparedTag.authorizationReason, tagReason)
    assert.equal(preparedTag.legacyActivationState, null)
    assert.equal(preparedTag.legacyActivationRevision, null)
    assert.equal(preparedTag.providerWriteControlRowVersion, 8)
    assert.match(preparedTag.providerWriteScopeDigest, /^[a-f0-9]{64}$/u)
    assert.ok(preparedTag.tagHash)
    assert.equal(JSON.stringify(preparedTag).includes(tagAction.tag), false)
    assert.equal(
      new Date(preparedTag.expiresAt).getTime()
        - new Date(preparedTag.preparedAt).getTime(),
      300_000,
      'authorization lifetime must be exactly five minutes',
    )

    const replayedTag = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        providerOrderUpdatedAt: new Date(
          new Date(preparedTag.providerOrderUpdatedAt).getTime() + 30_000,
        ).toISOString(),
        providerOrderObservedAt: new Date(
          new Date(preparedTag.providerOrderObservedAt).getTime() + 30_000,
        ).toISOString(),
        providerOrderTest: false,
        action: tagAction,
        reason: tagReason,
        idempotencyKey: 'shopify-order-tag-6600-0001',
      })
    assert.equal(replayedTag.authorizationGlobalId, preparedTag.authorizationGlobalId)
    assert.equal(replayedTag.replayed, true)

    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        providerOrderUpdatedAt: preparedTag.providerOrderUpdatedAt,
        providerOrderObservedAt: preparedTag.providerOrderObservedAt,
        providerOrderTest: false,
        action: tagAction,
        reason: 'A different operator reason must conflict with this key',
        idempotencyKey: 'shopify-order-tag-6600-0001',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_IDEMPOTENCY_CONFLICT',
      'same key with a different reason must conflict',
    )

    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(true),
        action: {
          type: 'set_line_quantity',
          lineItemGid: 'gid://shopify/LineItem/6600001',
          quantity: 0,
        },
        expectedLineQuantity: 1,
        reason: 'Prove a destructive edit cannot use fulfilled revision drift',
        idempotencyKey: 'shopify-order-qty-6600-blocked',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
      'destructive action must reject a non-current provider revision',
    )

    const claimedTag = await persistence.claimShopifyOrderManagementInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: preparedTag.authorizationGlobalId,
      action: tagAction,
      reason: tagReason,
    })
    assert.equal(claimedTag.status, 'processing')
    assert.ok(claimedTag.providerAttemptGlobalId)
    const durableAttempt = await pool.query(
      `SELECT attempt.dispatch_state, authz.status
       FROM operations_shopify_order_management_attempts attempt
       JOIN operations_shopify_order_management_authorizations authz
         ON authz.organization_id = attempt.organization_id
        AND authz.id = attempt.authorization_id
       WHERE attempt.global_id = $1`,
      [claimedTag.providerAttemptGlobalId],
    )
    assert.deepEqual(durableAttempt.rows[0], {
      dispatch_state: 'authorized',
      status: 'processing',
    }, 'immutable attempt and processing fence must commit before network')
    const authorizationByAttempt = await persistence
      .readShopifyOrderManagementAuthorizationByAttemptInPostgres({
        organizationId: fixture.organizationId,
        attemptGlobalId: claimedTag.providerAttemptGlobalId,
      })
    assert.equal(
      authorizationByAttempt.authorizationGlobalId,
      preparedTag.authorizationGlobalId,
      'attempt reader must resolve within the exact tenant',
    )
    const crossTenantAuthorization = await persistence
      .readShopifyOrderManagementAuthorizationByAttemptInPostgres({
        organizationId: randomUUID(),
        attemptGlobalId: claimedTag.providerAttemptGlobalId,
      })
    assert.equal(
      crossTenantAuthorization,
      null,
      'attempt reader must not cross tenant boundaries',
    )

    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: { type: 'add_tag', tag: 'blocked-during-processing' },
        reason: 'A processing write must block this second preparation',
        idempotencyKey: 'shopify-order-tag-6600-0002',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_UNRESOLVED_WRITE',
      'processing must block another order write',
    )

    const unknown = await persistence
      .recordShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: preparedTag.authorizationGlobalId,
        providerAttemptGlobalId: claimedTag.providerAttemptGlobalId,
        outcome: 'unknown',
        evidence: { jobDone: false, exactReadCompleted: false },
        providerReference: 'gid://shopify/Job/6600001',
        errorCode: 'SHOPIFY_ORDER_CANCEL_JOB_PENDING',
        providerWriteCount: 1,
      })
    assert.equal(unknown.status, 'unknown')
    assert.equal(unknown.providerWriteCount, 1)
    assert.equal(unknown.providerReference, 'gid://shopify/Job/6600001')

    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: { type: 'add_tag', tag: 'blocked-during-unknown' },
        reason: 'An unknown outcome must block this second preparation',
        idempotencyKey: 'shopify-order-tag-6600-0003',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_UNRESOLVED_WRITE',
      'unknown must block another order write',
    )

    await appendProviderWriteControl(pool, fixture, 9, 'off')
    const reconciled = await persistence
      .reconcileShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: preparedTag.authorizationGlobalId,
        providerAttemptGlobalId: claimedTag.providerAttemptGlobalId,
        resolution: 'applied',
        evidence: { exactRead: true, tagObserved: true },
        providerReference: fixture.fulfilled.global_id,
        providerWriteCount: null,
      })
    assert.equal(reconciled.status, 'reconciled')
    assert.equal(reconciled.reconciliationResolution, 'applied')
    assert.equal(
      reconciled.providerWriteCount,
      1,
      'reconciliation must preserve a known original provider write count',
    )
    const offDuringReconciliation = await persistence
      .readShopifyOrderManagementTargetInPostgres({
        organizationId: fixture.organizationId,
        orderGlobalId: fixture.fulfilled.global_id,
      })
    assert.equal(offDuringReconciliation.providerWriteRequestedMode, 'off')
    await appendProviderWriteControl(pool, fixture, 10, 'on')

    const unknownCountAction = {
      type: 'add_tag',
      tag: 'clawpilot-unknown-write-count',
    }
    const unknownCountReason =
      'Prove an unknown transport count remains unknown after reconciliation'
    const unknownCountPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: unknownCountAction,
        reason: unknownCountReason,
        idempotencyKey: 'shopify-order-tag-6600-unknown-count',
      })
    const unknownCountClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: unknownCountPrepared.authorizationGlobalId,
        action: unknownCountAction,
        reason: unknownCountReason,
      })
    const unknownCountOutcome = await persistence
      .recordShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: unknownCountPrepared.authorizationGlobalId,
        providerAttemptGlobalId: unknownCountClaimed.providerAttemptGlobalId,
        outcome: 'unknown',
        evidence: { transportEndedWithoutResponse: true },
        errorCode: 'SHOPIFY_ORDER_TRANSPORT_OUTCOME_UNKNOWN',
        providerWriteCount: null,
      })
    assert.equal(unknownCountOutcome.providerWriteCount, null)
    const reconciledUnknownCount = await persistence
      .reconcileShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: unknownCountPrepared.authorizationGlobalId,
        providerAttemptGlobalId: unknownCountClaimed.providerAttemptGlobalId,
        resolution: 'not_applied',
        evidence: { exactRead: true, tagAbsent: true },
        providerWriteCount: null,
      })
    assert.equal(reconciledUnknownCount.status, 'reconciled')
    assert.equal(reconciledUnknownCount.providerWriteCount, null)

    const alreadyPresentAction = {
      type: 'add_tag',
      tag: 'clawpilot-already-present',
    }
    const alreadyPresentReason =
      'Record a successful no-op when the exact tag is already present'
    const alreadyPresentPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: alreadyPresentAction,
        reason: alreadyPresentReason,
        idempotencyKey: 'shopify-order-tag-6600-already-present',
      })
    const alreadyPresentClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: alreadyPresentPrepared.authorizationGlobalId,
        action: alreadyPresentAction,
        reason: alreadyPresentReason,
      })
    const alreadyPresentOutcome = await persistence
      .recordShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: alreadyPresentPrepared.authorizationGlobalId,
        providerAttemptGlobalId: alreadyPresentClaimed.providerAttemptGlobalId,
        outcome: 'succeeded',
        evidence: { exactRead: true, tagAlreadyPresent: true },
        providerReference: fixture.fulfilled.global_id,
        providerWriteCount: 0,
      })
    assert.equal(alreadyPresentOutcome.status, 'succeeded')
    assert.equal(
      alreadyPresentOutcome.providerWriteCount,
      0,
      'an already-satisfied additive intent is a truthful zero-write success',
    )

    const recoveryAction = {
      type: 'add_tag',
      tag: 'clawpilot-processing-lease-recovery',
    }
    const recoveryReason =
      'Recover a crashed command to unknown without retrying Shopify'
    const recoveryPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: recoveryAction,
        reason: recoveryReason,
        idempotencyKey: 'shopify-order-tag-6600-stale-recovery',
      })
    const recoveryClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        action: recoveryAction,
        reason: recoveryReason,
      })
    assert.equal(
      new Date(recoveryClaimed.processingLeaseExpiresAt).getTime()
        - new Date(recoveryClaimed.claimedAt).getTime(),
      300_000,
      'processing lease must be exactly five minutes',
    )
    const liveRecovery = await persistence
      .recoverStaleShopifyOrderManagementAttemptInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: recoveryClaimed.providerAttemptGlobalId,
      })
    assert.equal(liveRecovery.recovered, false)
    assert.equal(liveRecovery.authorization.status, 'processing')
    const liveRecoveryOutcome = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_shopify_order_management_outcomes outcome
       WHERE outcome.organization_id = $1::uuid
         AND outcome.authorization_id = (
           SELECT authz.id
           FROM operations_shopify_order_management_authorizations authz
           WHERE authz.organization_id = $1::uuid
             AND authz.global_id = $2
         )`,
      [fixture.organizationId, recoveryPrepared.authorizationGlobalId],
    )
    assert.equal(
      liveRecoveryOutcome.rows[0].count,
      0,
      'a live processing lease must not be stolen or receive an outcome',
    )
    await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_shopify_order_management_outcomes (
           organization_id, authorization_id, provider_attempt_id,
           outcome_state, reconciliation_resolution, provider_write_count,
           provider_reference, evidence_hash, error_code, recorded_by
         )
         SELECT authz.organization_id, authz.id, attempt.id,
                'unknown', NULL, NULL, NULL, repeat('d', 64),
                'SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED', $4
         FROM operations_shopify_order_management_authorizations authz
         JOIN operations_shopify_order_management_attempts attempt
           ON attempt.organization_id = authz.organization_id
          AND attempt.authorization_id = authz.id
         WHERE authz.organization_id = $1::uuid
           AND authz.global_id = $2
           AND attempt.global_id = $3`,
        [
          fixture.organizationId,
          recoveryPrepared.authorizationGlobalId,
          recoveryClaimed.providerAttemptGlobalId,
          fixture.ownerEmail,
        ],
      ),
      /processing lease is still active/i,
      'database must reject recovery while the exact processing lease is live',
    )
    const recoveryWarehouse = await pool.query(
      `INSERT INTO operations_warehouses (
         organization_id, code, name, created_by, updated_by
       ) VALUES ($1::uuid, $2, 'Recovery race warehouse', $3, $3)
       RETURNING id::text`,
      [
        fixture.organizationId,
        `REC-${randomUUID().slice(0, 8)}`,
        fixture.ownerEmail,
      ],
    )
    await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id, method, solver_status,
           promised_delivery_at, explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'manual_override', 'accepted',
           now() + interval '1 day', '{}'::jsonb, $4
         )`,
        [
          fixture.organizationId,
          fixture.fulfilled.id,
          recoveryWarehouse.rows[0].id,
          fixture.ownerEmail,
        ],
      ),
      /attempt blocks downstream planning/i,
      'processing attempt must block a downstream plan insert after claim',
    )
    await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_billable_events (
           organization_id, pipeline_id, customer_id, order_id,
           contract_version_id, event_type, amount_minor, source_global_id,
           idempotency_key
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'order', 0,
           $6, $7
         )`,
        [
          fixture.organizationId,
          fixture.pipelineId,
          fixture.customerId,
          fixture.fulfilled.id,
          fixture.contractVersionId,
          fixture.fulfilled.global_id,
          `blocked-billable-${randomUUID()}`,
        ],
      ),
      /attempt blocks downstream planning/i,
      'processing attempt must block the direct billable-event root',
    )
    await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_sandbox_commerce_e2e_authorizations (
           organization_id, order_id, external_order_id,
           confirmation_statement_version, confirmation_hash, reason,
           authorized_by, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'sandbox-commerce-e2e-v1',
           repeat('e', 64), $4, $5, now() + interval '1 hour'
         )`,
        [
          fixture.organizationId,
          fixture.fulfilled.id,
          'gid://shopify/Order/6600001',
          'Block direct sandbox authority while Shopify outcome is unresolved',
          fixture.ownerEmail,
        ],
      ),
      /attempt blocks downstream planning/i,
      'processing attempt must block the direct sandbox E2E authority root',
    )
    await expectDatabaseRejected(
      () => pool.query(
        `UPDATE operations_orders
         SET archived_at = clock_timestamp()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [fixture.organizationId, fixture.fulfilled.id],
      ),
      /attempt blocks downstream planning/i,
      'processing attempt must block a local order lifecycle update',
    )
    await expectRejected(
      () => persistence.recoverStaleShopifyOrderManagementAttemptInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: alreadyPresentClaimed.providerAttemptGlobalId,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_NOT_FOUND',
      'recovery must reject an attempt from a different authorization lineage',
    )
    await expectRejected(
      () => persistence.recoverStaleShopifyOrderManagementAttemptInPostgres({
        organizationId: randomUUID(),
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: recoveryClaimed.providerAttemptGlobalId,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_FORBIDDEN',
      'recovery must not cross tenant boundaries',
    )

    const agingClient = await pool.connect()
    try {
      await agingClient.query('SET session_replication_role = replica')
      const agedAttempt = await agingClient.query(
        `WITH aged AS (
           SELECT clock_timestamp() - interval '6 minutes' AS claimed_at
         )
         UPDATE operations_shopify_order_management_attempts attempt
         SET claimed_at = aged.claimed_at,
             processing_lease_expires_at =
               aged.claimed_at + interval '5 minutes'
         FROM aged
         WHERE attempt.organization_id = $1::uuid
           AND attempt.global_id = $2
         RETURNING attempt.id::text, attempt.claimed_at`,
        [fixture.organizationId, recoveryClaimed.providerAttemptGlobalId],
      )
      await agingClient.query(
        `UPDATE operations_shopify_order_management_authorizations authz
         SET processing_at = $3::timestamptz,
             updated_at = $3::timestamptz
         WHERE authz.organization_id = $1::uuid
           AND authz.global_id = $2`,
        [
          fixture.organizationId,
          recoveryPrepared.authorizationGlobalId,
          agedAttempt.rows[0].claimed_at,
        ],
      )
    } finally {
      await agingClient.query('SET session_replication_role = origin')
        .catch(() => undefined)
      agingClient.release()
    }
    const staleHealth = await persistence
      .readShopifyOrderManagementHealthFromPostgres()
    assert.ok(staleHealth.processing >= 1)
    assert.ok(staleHealth.staleProcessing >= 1)
    const concurrentRecovery = await Promise.all([
      persistence.recoverStaleShopifyOrderManagementAttemptInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.qualifiedAdminEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: recoveryClaimed.providerAttemptGlobalId,
      }),
      persistence.recoverStaleShopifyOrderManagementAttemptInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.qualifiedAdminEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: recoveryClaimed.providerAttemptGlobalId,
      }),
    ])
    assert.deepEqual(
      concurrentRecovery.map((entry) => entry.recovered).sort(),
      [false, true],
      'concurrent stale recovery must serialize to one immutable outcome',
    )
    for (const entry of concurrentRecovery) {
      assert.equal(entry.authorization.status, 'unknown')
      assert.equal(entry.authorization.providerWriteCount, null)
      assert.equal(
        entry.authorization.errorCode,
        'SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED',
      )
    }
    const recoveredOutcome = await pool.query(
      `SELECT outcome.outcome_state, outcome.provider_write_count,
              outcome.provider_reference, outcome.error_code
       FROM operations_shopify_order_management_outcomes outcome
       JOIN operations_shopify_order_management_authorizations authz
         ON authz.organization_id = outcome.organization_id
        AND authz.id = outcome.authorization_id
       WHERE authz.organization_id = $1::uuid
         AND authz.global_id = $2`,
      [fixture.organizationId, recoveryPrepared.authorizationGlobalId],
    )
    assert.deepEqual(recoveredOutcome.rows, [{
      outcome_state: 'unknown',
      provider_write_count: null,
      provider_reference: null,
      error_code: 'SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED',
    }], 'stale recovery must retain redacted unknown evidence with no invented count')
    await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id, method, solver_status,
           promised_delivery_at, explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'manual_override', 'accepted',
           now() + interval '1 day', '{}'::jsonb, $4
         )`,
        [
          fixture.organizationId,
          fixture.fulfilled.id,
          recoveryWarehouse.rows[0].id,
          fixture.ownerEmail,
        ],
      ),
      /attempt blocks downstream planning/i,
      'unknown attempt must retain the downstream planning fence',
    )
    const recoveredReconciliation = await persistence
      .reconcileShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.qualifiedAdminEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: recoveryClaimed.providerAttemptGlobalId,
        resolution: 'not_applied',
        evidence: { exactRead: true, tagAbsent: true },
        providerWriteCount: null,
      })
    assert.equal(recoveredReconciliation.status, 'reconciled')
    assert.equal(recoveredReconciliation.providerWriteCount, null)
    assert.ok(audits.some((event) => (
      event.eventType === 'operations.shopify_order_management.reconciled'
      && event.aggregateId === recoveryPrepared.authorizationGlobalId
      && event.payload.authorizedBy === fixture.ownerEmail
      && event.payload.reconciledBy === fixture.qualifiedAdminEmail
    )), 'qualified failover reconciliation must retain both actor identities')

    const claimWinsAction = {
      type: 'add_tag',
      tag: 'clawpilot-claim-wins-race',
    }
    const claimWinsReason =
      'Prove a committed claim makes a waiting downstream plan reject'
    const claimWinsPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: claimWinsAction,
        reason: claimWinsReason,
        idempotencyKey: 'shopify-order-tag-6600-claim-wins-race',
      })
    let claimTransitionReached
    const claimTransition = new Promise((resolvePromise) => {
      claimTransitionReached = resolvePromise
    })
    let releaseClaimCommit
    const claimCommitRelease = new Promise((resolvePromise) => {
      releaseClaimCommit = resolvePromise
    })
    transactionControl.beforeCommit = async () => {
      claimTransitionReached()
      await claimCommitRelease
    }
    const claimWinsPromise = persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: claimWinsPrepared.authorizationGlobalId,
        action: claimWinsAction,
        reason: claimWinsReason,
      })
    await claimTransition
    let waitingPlanSettled = false
    const waitingPlan = pool.query(
      `INSERT INTO operations_fulfillment_plans (
         organization_id, order_id, warehouse_id, method, solver_status,
         promised_delivery_at, explanation, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'manual_override', 'accepted',
         now() + interval '1 day', '{}'::jsonb, $4
       )`,
      [
        fixture.organizationId,
        fixture.fulfilled.id,
        recoveryWarehouse.rows[0].id,
        fixture.ownerEmail,
      ],
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    ).finally(() => { waitingPlanSettled = true })
    let waitingBillableSettled = false
    const waitingBillable = pool.query(
      `INSERT INTO operations_billable_events (
         organization_id, pipeline_id, customer_id, order_id,
         contract_version_id, event_type, amount_minor, source_global_id,
         idempotency_key
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'order', 0,
         $6, $7
       )`,
      [
        fixture.organizationId,
        fixture.pipelineId,
        fixture.customerId,
        fixture.fulfilled.id,
        fixture.contractVersionId,
        fixture.fulfilled.global_id,
        `claim-wins-billable-${randomUUID()}`,
      ],
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    ).finally(() => { waitingBillableSettled = true })
    let waitingSandboxSettled = false
    const waitingSandbox = pool.query(
      `INSERT INTO operations_sandbox_commerce_e2e_authorizations (
         organization_id, order_id, external_order_id,
         confirmation_statement_version, confirmation_hash, reason,
         authorized_by, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'sandbox-commerce-e2e-v1',
         repeat('f', 64), $4, $5, now() + interval '1 hour'
       )`,
      [
        fixture.organizationId,
        fixture.fulfilled.id,
        'gid://shopify/Order/6600001',
        'Claim must win before direct sandbox authority materializes',
        fixture.ownerEmail,
      ],
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    ).finally(() => { waitingSandboxSettled = true })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    assert.equal(
      waitingPlanSettled,
      false,
      'downstream insert must wait on the uncommitted processing transition',
    )
    assert.equal(waitingBillableSettled, false)
    assert.equal(waitingSandboxSettled, false)
    releaseClaimCommit()
    const claimWinsClaimed = await claimWinsPromise
    const waitingPlanResult = await waitingPlan
    const waitingBillableResult = await waitingBillable
    const waitingSandboxResult = await waitingSandbox
    assert.match(
      String(waitingPlanResult.error?.message || waitingPlanResult.error),
      /attempt blocks downstream planning/i,
      'claim winner must make the waiting downstream insert reject',
    )
    assert.match(
      String(waitingBillableResult.error?.message || waitingBillableResult.error),
      /attempt blocks downstream planning/i,
      'claim winner must reject the waiting direct billable-event root',
    )
    assert.match(
      String(waitingSandboxResult.error?.message || waitingSandboxResult.error),
      /attempt blocks downstream planning/i,
      'claim winner must reject the waiting direct sandbox-authority root',
    )
    const claimWinsDownstream = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_fulfillment_plans plan
       WHERE plan.organization_id = $1::uuid AND plan.order_id = $2::uuid`,
      [fixture.organizationId, fixture.fulfilled.id],
    )
    assert.equal(claimWinsDownstream.rows[0].count, 0)
    await persistence.recordShopifyOrderManagementOutcomeInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: claimWinsPrepared.authorizationGlobalId,
      providerAttemptGlobalId: claimWinsClaimed.providerAttemptGlobalId,
      outcome: 'succeeded',
      evidence: { exactRead: true, tagAlreadyPresent: true },
      providerWriteCount: 0,
    })

    const target = await persistence.readShopifyOrderManagementTargetInPostgres({
      organizationId: fixture.organizationId,
      orderGlobalId: fixture.fulfilled.global_id,
    })
    assert.equal(target.accountGlobalId, fixture.accountGlobalId)
    assert.equal(target.materialState, 'provider_fulfilled')
    assert.equal(target.latestSourceHash, 'c'.repeat(64))
    assert.equal(target.zeroDownstream, true)
    assert.ok(
      target.latestOpenAuthorization === null
      || target.latestOpenAuthorization.status === 'prepared',
      'stale prepared authorizations may remain visible but never become attempts',
    )

    const quantityAction = {
      type: 'set_line_quantity',
      lineItemGid: 'gid://shopify/LineItem/6600002',
      quantity: 0,
      staffNote: 'ClawPilot bounded quantity test',
    }
    const quantityReason = 'Exercise a bounded three-mutation line quantity edit'
    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.current.global_id,
        expectedOrderRowVersion: Number(fixture.current.row_version),
        expectedSourceHash: fixture.currentSourceHash,
        ...snapshot(true),
        action: quantityAction,
        expectedLineQuantity: 2,
        reason: 'Reject a live timestamp that differs from accepted evidence',
        idempotencyKey: 'shopify-order-qty-6601-updated-at-mismatch',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
      'destructive action must match the accepted observation provider timestamp',
    )
    const missingAcceptedClient = await pool.connect()
    try {
      await missingAcceptedClient.query('SET session_replication_role = replica')
      await missingAcceptedClient.query(
        `UPDATE operations_commerce_order_revision_targets
         SET accepted_observation_id = NULL
         WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
        [fixture.organizationId, fixture.current.id],
      )
    } finally {
      await missingAcceptedClient.query('SET session_replication_role = origin')
        .catch(() => undefined)
      missingAcceptedClient.release()
    }
    try {
      await expectRejected(
        () => persistence.prepareShopifyOrderManagementInPostgres({
          organizationId: fixture.organizationId,
          actorEmail: fixture.ownerEmail,
          accountGlobalId: fixture.accountGlobalId,
          orderGlobalId: fixture.current.global_id,
          expectedOrderRowVersion: Number(fixture.current.row_version),
          expectedSourceHash: fixture.currentSourceHash,
          ...snapshot(true, fixture.currentAcceptedProviderUpdatedAt),
          action: quantityAction,
          expectedLineQuantity: 2,
          reason: 'Reject destructive action without an accepted observation',
          idempotencyKey: 'shopify-order-qty-6601-accepted-missing',
        }),
        'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
        'destructive action must reject missing accepted observation evidence',
      )
    } finally {
      const restoreAcceptedClient = await pool.connect()
      try {
        await restoreAcceptedClient.query('SET session_replication_role = replica')
        await restoreAcceptedClient.query(
          `UPDATE operations_commerce_order_revision_targets
           SET accepted_observation_id = $3::uuid
           WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
          [
            fixture.organizationId,
            fixture.current.id,
            fixture.currentAcceptedObservationId,
          ],
        )
      } finally {
        await restoreAcceptedClient.query('SET session_replication_role = origin')
          .catch(() => undefined)
        restoreAcceptedClient.release()
      }
    }
    const preparedQuantity = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.current.global_id,
        expectedOrderRowVersion: Number(fixture.current.row_version),
        expectedSourceHash: fixture.currentSourceHash,
        ...snapshot(true, fixture.currentAcceptedProviderUpdatedAt),
        action: quantityAction,
        expectedLineQuantity: 2,
        reason: quantityReason,
        idempotencyKey: 'shopify-order-qty-6601-0001',
      })
    assert.equal(
      preparedQuantity.acceptedProviderOrderUpdatedAt,
      fixture.currentAcceptedProviderUpdatedAt,
    )
    assert.equal(
      preparedQuantity.acceptedObservationId,
      fixture.currentAcceptedObservationId,
    )
    const claimedQuantity = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: preparedQuantity.authorizationGlobalId,
        action: quantityAction,
        expectedLineQuantity: 2,
        reason: quantityReason,
      })
    const succeededQuantity = await persistence
      .recordShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: preparedQuantity.authorizationGlobalId,
        providerAttemptGlobalId: claimedQuantity.providerAttemptGlobalId,
        outcome: 'succeeded',
        evidence: { begin: true, setQuantity: true, commit: true },
        providerReference: fixture.current.global_id,
        providerWriteCount: 3,
      })
    assert.equal(succeededQuantity.status, 'succeeded')
    assert.equal(succeededQuantity.providerWriteCount, 3)

    const downstreamAction = { type: 'add_tag', tag: 'downstream-block' }
    const downstreamReason = 'Prove claim rechecks zero downstream warehouse state'
    const downstreamPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.current.global_id,
        expectedOrderRowVersion: Number(fixture.current.row_version),
        expectedSourceHash: fixture.currentSourceHash,
        ...snapshot(true),
        action: downstreamAction,
        reason: downstreamReason,
        idempotencyKey: 'shopify-order-downstream-6601',
      })
    const warehouse = await pool.query(
      `INSERT INTO operations_warehouses (
         organization_id, code, name, created_by, updated_by
       ) VALUES ($1::uuid, $2, 'Order management test warehouse', $3, $3)
       RETURNING id::text`,
      [fixture.organizationId, `SOM-${randomUUID().slice(0, 8)}`, fixture.ownerEmail],
    )
    const planningClient = await pool.connect()
    let planningCommitted = false
    try {
      await planningClient.query('BEGIN')
      await planningClient.query(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id, method, solver_status,
           promised_delivery_at, explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'manual_override', 'accepted',
           now() + interval '1 day', '{}'::jsonb, $4
         )`,
        [
          fixture.organizationId,
          fixture.current.id,
          warehouse.rows[0].id,
          fixture.ownerEmail,
        ],
      )
      await planningClient.query(
        `INSERT INTO operations_sandbox_commerce_e2e_authorizations (
           organization_id, order_id, external_order_id,
           confirmation_statement_version, confirmation_hash, reason,
           authorized_by, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'sandbox-commerce-e2e-v1',
           repeat('a', 64), $4, $5, now() + interval '1 hour'
         )`,
        [
          fixture.organizationId,
          fixture.current.id,
          'gid://shopify/Order/6600002',
          'Planning winner materializes direct sandbox authority before claim',
          fixture.ownerEmail,
        ],
      )
      await planningClient.query(
        `INSERT INTO operations_billable_events (
           organization_id, pipeline_id, customer_id, order_id,
           contract_version_id, event_type, amount_minor, source_global_id,
           idempotency_key
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'order', 0,
           $6, $7
         )`,
        [
          fixture.organizationId,
          fixture.pipelineId,
          fixture.customerId,
          fixture.current.id,
          fixture.contractVersionId,
          fixture.current.global_id,
          `planning-wins-billable-${randomUUID()}`,
        ],
      )
      let claimSettled = false
      const concurrentClaim = persistence
        .claimShopifyOrderManagementInPostgres({
          organizationId: fixture.organizationId,
          actorEmail: fixture.ownerEmail,
          authorizationGlobalId: downstreamPrepared.authorizationGlobalId,
          action: downstreamAction,
          reason: downstreamReason,
        })
        .then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        )
        .finally(() => { claimSettled = true })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
      assert.equal(
        claimSettled,
        false,
        'claim must wait while planning holds the prepared authorization lock',
      )
      await planningClient.query('COMMIT')
      planningCommitted = true
      const claimResult = await concurrentClaim
      assert.equal(
        claimResult.error?.code,
        'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
        'planning winner must make the waiting claim fail its downstream recheck',
      )
      const committedDirectRoots = await pool.query(
        `SELECT
           EXISTS (
             SELECT 1
             FROM operations_billable_events event
             WHERE event.organization_id = $1::uuid
               AND event.order_id = $2::uuid
           ) AS billable_exists,
           EXISTS (
             SELECT 1
             FROM operations_sandbox_commerce_e2e_authorizations authz
             WHERE authz.organization_id = $1::uuid
               AND authz.order_id = $2::uuid
           ) AS sandbox_authority_exists`,
        [fixture.organizationId, fixture.current.id],
      )
      assert.deepEqual(committedDirectRoots.rows[0], {
        billable_exists: true,
        sandbox_authority_exists: true,
      }, 'planning winner must commit both independent downstream roots')
    } finally {
      if (!planningCommitted) {
        await planningClient.query('ROLLBACK').catch(() => undefined)
      }
      planningClient.release()
    }
    await expectRejected(
      () => persistence.claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: downstreamPrepared.authorizationGlobalId,
        action: downstreamAction,
        reason: downstreamReason,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
      'replayed claim must remain blocked after downstream planning commits',
    )

    await expectDatabaseRejected(
      () => pool.query(
        `UPDATE operations_shopify_order_management_attempts
         SET attempt_hash = repeat('f', 64)
         WHERE global_id = $1`,
        [claimedTag.providerAttemptGlobalId],
      ),
      /attempts are immutable/i,
      'provider attempt evidence must be immutable',
    )
    await expectDatabaseRejected(
      () => pool.query(
        `UPDATE operations_shopify_order_management_outcomes
         SET evidence_hash = repeat('f', 64)
         WHERE global_id = $1`,
        [reconciled.latestOutcomeGlobalId],
      ),
      /outcomes are immutable/i,
      'provider outcome evidence must be immutable',
    )

    // 0308 is a predeploy migration, so the exact old 9d67 runtime must keep
    // serving during a rolling release. Its owner/admin activation-bound
    // prepare and claim shape remains accepted, while normal new commands use
    // only Provider writes. The bridge is intentionally not available to a
    // member even when that member has both legacy permission flags.
    await appendProviderWriteControl(pool, fixture, 11, 'off')
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'shadow', revision = revision + 1,
           reason = 'Exact 9d67 rolling-runtime compatibility proof',
           updated_by = $2, updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid`,
      [fixture.organizationId, fixture.ownerEmail],
    )
    const legacyPersistence = loadTypeScriptModule(
      'app_src/lib/persistence/shopifyOrderManagement.ts',
      {
        '@/lib/auditWriter': {
          async recordAuditEvent(event) {
            audits.push(event)
          },
        },
        '@/lib/persistence/postgres': postgresAdapter(pool),
      },
      command('git', [
        'show',
        '9d67c8d097bcd475e0109c3169a61a0885fcf059:app_src/lib/persistence/shopifyOrderManagement.ts',
      ]),
    )
    const legacyAction = {
      type: 'add_tag',
      tag: 'rolling-runtime-legacy-shape',
    }
    const legacyReason =
      'Prove the exact old runtime can finish during migration overlap'
    const legacyPrepared = await legacyPersistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: legacyAction,
        reason: legacyReason,
        idempotencyKey: 'shopify-order-legacy-rolling-prepare',
      })
    const legacyClaimed = await legacyPersistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: legacyPrepared.authorizationGlobalId,
        action: legacyAction,
        reason: legacyReason,
      })
    await legacyPersistence.recordShopifyOrderManagementOutcomeInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: legacyPrepared.authorizationGlobalId,
      providerAttemptGlobalId: legacyClaimed.providerAttemptGlobalId,
      outcome: 'succeeded',
      evidence: { providerAlreadySatisfied: true },
      providerWriteCount: 0,
    })
    const legacyShape = await pool.query(
      `SELECT
         authz.activation_state,
         authz.activation_revision::integer,
         authz.provider_write_control_row_version,
         authz.provider_write_scope_digest,
         attempt.activation_revision::integer AS attempt_activation_revision,
         attempt.provider_write_control_row_version
           AS attempt_provider_write_control_row_version,
         attempt.provider_write_scope_digest AS attempt_provider_write_scope_digest
       FROM operations_shopify_order_management_authorizations authz
       JOIN operations_shopify_order_management_attempts attempt
         ON attempt.organization_id = authz.organization_id
        AND attempt.authorization_id = authz.id
       WHERE authz.organization_id = $1::uuid
         AND authz.global_id = $2`,
      [fixture.organizationId, legacyPrepared.authorizationGlobalId],
    )
    assert.equal(legacyShape.rows[0].activation_state, 'shadow')
    assert.equal(
      legacyShape.rows[0].attempt_activation_revision,
      legacyShape.rows[0].activation_revision,
    )
    assert.equal(legacyShape.rows[0].provider_write_control_row_version, null)
    assert.equal(legacyShape.rows[0].provider_write_scope_digest, null)
    assert.equal(
      legacyShape.rows[0].attempt_provider_write_control_row_version,
      null,
    )
    assert.equal(legacyShape.rows[0].attempt_provider_write_scope_digest, null)

    await expectDatabaseRejected(
      () => pool.query(
        `WITH source AS (
           SELECT *
           FROM operations_shopify_order_management_authorizations
           WHERE organization_id = $1::uuid AND global_id = $2
         ), prepared_clock AS (
           SELECT clock_timestamp() AS prepared_at
         )
         INSERT INTO operations_shopify_order_management_authorizations (
           organization_id, integration_account_id,
           integration_account_global_id, provider, account_environment,
           external_account_id, shop_domain, credential_generation,
           activation_state, activation_revision,
           provider_write_control_row_version, provider_write_scope_digest,
           order_id, order_global_id, external_order_id, order_number,
           expected_order_row_version, expected_source_hash,
           accepted_observation_id, accepted_provider_order_updated_at,
           provider_order_updated_at, provider_order_observed_at,
           provider_order_test, provider_snapshot_hash, action, line_item_id,
           expected_line_quantity, requested_quantity, tag_hash,
           cancel_reason, staff_note_hash, authorization_reason, intent_hash,
           idempotency_key, request_hash, status, authorized_by,
           authorized_role, prepared_at, expires_at
         )
         SELECT
           source.organization_id, source.integration_account_id,
           source.integration_account_global_id, source.provider,
           source.account_environment, source.external_account_id,
           source.shop_domain, source.credential_generation,
           source.activation_state, source.activation_revision,
           NULL, NULL, source.order_id, source.order_global_id,
           source.external_order_id, source.order_number,
           source.expected_order_row_version, source.expected_source_hash,
           source.accepted_observation_id,
           source.accepted_provider_order_updated_at,
           prepared_clock.prepared_at - interval '1 second',
           prepared_clock.prepared_at, source.provider_order_test,
           source.provider_snapshot_hash, source.action, source.line_item_id,
           source.expected_line_quantity, source.requested_quantity,
           source.tag_hash, source.cancel_reason, source.staff_note_hash,
           'Member must not fabricate a rolling legacy authorization',
           source.intent_hash, $4, repeat('8', 64), 'prepared', $3,
           'member', prepared_clock.prepared_at,
           prepared_clock.prepared_at + interval '5 minutes'
         FROM source CROSS JOIN prepared_clock`,
        [
          fixture.organizationId,
          legacyPrepared.authorizationGlobalId,
          fixture.legacyMemberEmail,
          `shopify-order-legacy-member-${randomUUID()}`,
        ],
      ),
      /authorization is not current or permitted/i,
      'member cannot fabricate the legacy rolling-runtime shape',
    )

    // 0337 permits a current ordinary Shopify order (test=false) to enter the
    // same durable prepare/claim/outcome protocol. The exact refund, restock,
    // notification, reason, and bounded payment evidence must survive on both
    // the authorization and the provider-attempt row. Cancellation authority
    // is owner, or admin with both management and execution permissions.
    const ordinaryCancelAction = {
      type: 'cancel',
      reason: 'CUSTOMER',
      staffNote: 'Customer confirmed cancellation before warehouse release',
      refundMethod: 'original_payment_methods',
      restock: true,
      notifyCustomer: true,
    }
    const ordinaryCancelPaymentEvidence = {
      schema: 'shopify-order-cancel-payment-evidence-v2',
      transactionsCount: 2,
      transactionsHash: '6'.repeat(64),
      totalReceived: { amount: '125', currencyCode: 'USD' },
      totalRefunded: { amount: '0', currencyCode: 'USD' },
      totalCapturable: { amount: '0', currencyCode: 'USD' },
      refundMethod: 'original_payment_methods',
    }
    const missingTransactionsHashEvidence = {
      ...ordinaryCancelPaymentEvidence,
    }
    delete missingTransactionsHashEvidence.transactionsHash
    const cancellationPaymentEvidenceValidation = await pool.query(
      `SELECT
         public.operations_shopify_order_cancel_payment_evidence_v2_valid(
           $1::jsonb,
           $2::text
         ) AS valid`,
      [JSON.stringify(ordinaryCancelPaymentEvidence), 'original_payment_methods'],
    )
    assert.equal(
      cancellationPaymentEvidenceValidation.rows[0].valid,
      true,
      'the exact complete v2 cancellation payment ledger must validate',
    )
    const malformedCancellationPaymentEvidence = [
      ['sql null', null, 'original_payment_methods'],
      ['JSON null', 'null', 'original_payment_methods'],
      ['scalar', JSON.stringify('not-an-object'), 'original_payment_methods'],
      ['array', '[]', 'original_payment_methods'],
      ['missing key', JSON.stringify(
        missingTransactionsHashEvidence,
      ), 'original_payment_methods'],
      ['extra key', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        unbound: true,
      }), 'original_payment_methods'],
      ['wrong schema', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        schema: 'shopify-order-cancel-payment-evidence-v1',
      }), 'original_payment_methods'],
      ['wrong count type', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        transactionsCount: '2',
      }), 'original_payment_methods'],
      ['non-integer count', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        transactionsCount: 2.5,
      }), 'original_payment_methods'],
      ['wrong hash type', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        transactionsHash: 6,
      }), 'original_payment_methods'],
      ['invalid hash', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        transactionsHash: 'A'.repeat(64),
      }), 'original_payment_methods'],
      ['refund evidence mismatch', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        refundMethod: 'none',
      }), 'original_payment_methods'],
      ['invalid refund argument', JSON.stringify(
        ordinaryCancelPaymentEvidence,
      ), 'provider_credit'],
      ['money scalar', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        totalReceived: '125',
      }), 'original_payment_methods'],
      ['money missing key', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        totalReceived: { amount: '125' },
      }), 'original_payment_methods'],
      ['money extra key', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        totalReceived: {
          ...ordinaryCancelPaymentEvidence.totalReceived,
          precision: 2,
        },
      }), 'original_payment_methods'],
      ['wrong money amount type', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        totalReceived: { amount: 125, currencyCode: 'USD' },
      }), 'original_payment_methods'],
      ['noncanonical money amount', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        totalReceived: { amount: '125.00', currencyCode: 'USD' },
      }), 'original_payment_methods'],
      ['wrong money currency type', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        totalReceived: { amount: '125', currencyCode: 840 },
      }), 'original_payment_methods'],
      ['invalid money currency', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        totalReceived: { amount: '125', currencyCode: 'usd' },
      }), 'original_payment_methods'],
      ['mismatched money currency', JSON.stringify({
        ...ordinaryCancelPaymentEvidence,
        totalRefunded: { amount: '0', currencyCode: 'CAD' },
      }), 'original_payment_methods'],
    ]
    for (const [description, evidence, refundMethod] of
      malformedCancellationPaymentEvidence) {
      const invalidEvidence = await pool.query(
        `SELECT
           public.operations_shopify_order_cancel_payment_evidence_v2_valid(
             $1::jsonb,
             $2::text
           ) AS valid`,
        [evidence, refundMethod],
      )
      assert.equal(
        invalidEvidence.rows[0].valid,
        false,
        `${description} cancellation payment evidence must fail closed`,
      )
    }
    const ordinaryCancelReason =
      'Customer requested cancellation before any warehouse work began'
    const ordinaryCancelPreparation = {
      organizationId: independentFixture.organizationId,
      accountGlobalId: independentFixture.accountGlobalId,
      orderGlobalId: independentFixture.current.global_id,
      expectedOrderRowVersion: Number(independentFixture.current.row_version),
      expectedSourceHash: independentFixture.currentSourceHash,
      ...snapshot(
        false,
        independentFixture.currentAcceptedProviderUpdatedAt,
      ),
      action: ordinaryCancelAction,
      cancellationPaymentEvidence: ordinaryCancelPaymentEvidence,
      reason: ordinaryCancelReason,
    }
    for (const [actorEmail, key, description] of [
      [
        independentFixture.manageOnlyAdminEmail,
        'shopify-ordinary-cancel-manage-only',
        'manage-only admin',
      ],
      [
        independentFixture.executeOnlyAdminEmail,
        'shopify-ordinary-cancel-execute-only',
        'execute-only admin',
      ],
      [
        independentFixture.legacyMemberEmail,
        'shopify-ordinary-cancel-member',
        'member with legacy permission flags',
      ],
    ]) {
      await expectRejected(
        () => persistence.prepareShopifyOrderManagementInPostgres({
          ...ordinaryCancelPreparation,
          actorEmail,
          idempotencyKey: key,
        }),
        'SHOPIFY_ORDER_MANAGEMENT_FORBIDDEN',
        `${description} must not authorize ordinary cancellation`,
      )
    }
    const ordinaryCancelPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        ...ordinaryCancelPreparation,
        actorEmail: independentFixture.qualifiedAdminEmail,
        idempotencyKey: 'shopify-ordinary-cancel-0337',
      })
    assert.equal(ordinaryCancelPrepared.authorizedRole, 'admin')
    assert.equal(ordinaryCancelPrepared.providerOrderTest, false)
    assert.equal(
      ordinaryCancelPrepared.cancelRefundMethod,
      'original_payment_methods',
    )
    assert.equal(ordinaryCancelPrepared.cancelRestock, true)
    assert.equal(ordinaryCancelPrepared.cancelNotifyCustomer, true)
    assert.deepEqual(
      JSON.parse(JSON.stringify(
        ordinaryCancelPrepared.cancellationPaymentEvidence,
      )),
      ordinaryCancelPaymentEvidence,
    )
    const malformedAuthorizationInsert = await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_shopify_order_management_authorizations
         SELECT (
           pg_catalog.jsonb_populate_record(
             NULL::public.operations_shopify_order_management_authorizations,
             pg_catalog.to_jsonb(authz) || pg_catalog.jsonb_build_object(
               'cancellation_payment_evidence', '"scalar"'::jsonb
             )
           )
         ).*
         FROM operations_shopify_order_management_authorizations authz
         WHERE authz.organization_id = $1::uuid AND authz.global_id = $2`,
        [
          independentFixture.organizationId,
          ordinaryCancelPrepared.authorizationGlobalId,
        ],
      ),
      /cancellation intent is incomplete or not permitted/i,
      'authorization insert trigger must reject malformed payment evidence',
    )
    assert.equal(malformedAuthorizationInsert.code, 'P0001')
    const fabricatedLegacyAuthorization = await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_shopify_order_management_authorizations
         SELECT (
           pg_catalog.jsonb_populate_record(
             NULL::public.operations_shopify_order_management_authorizations,
             pg_catalog.to_jsonb(authz) || pg_catalog.jsonb_build_object(
               'legacy_cancellation_without_payment_evidence', true,
               'cancel_refund_method', 'none',
               'cancel_restock', false,
               'cancel_notify_customer', false,
               'cancellation_payment_evidence', NULL
             )
           )
         ).*
         FROM operations_shopify_order_management_authorizations authz
         WHERE authz.organization_id = $1::uuid AND authz.global_id = $2`,
        [
          independentFixture.organizationId,
          ordinaryCancelPrepared.authorizationGlobalId,
        ],
      ),
      /cancellation intent is incomplete or not permitted/i,
      'new authorization must not fabricate the migration-only legacy marker',
    )
    assert.equal(fabricatedLegacyAuthorization.code, 'P0001')

    const authorizationConstraintClient = await pool.connect()
    try {
      await authorizationConstraintClient.query('BEGIN')
      await authorizationConstraintClient.query(
        `ALTER TABLE operations_shopify_order_management_authorizations
         DISABLE TRIGGER protect_shopify_order_management_authorization_write`,
      )
      const malformedAuthorizationUpdate = await expectDatabaseRejected(
        () => authorizationConstraintClient.query(
          `UPDATE operations_shopify_order_management_authorizations
           SET cancellation_payment_evidence = '"scalar"'::jsonb
           WHERE organization_id = $1::uuid AND global_id = $2`,
          [
            independentFixture.organizationId,
            ordinaryCancelPrepared.authorizationGlobalId,
          ],
        ),
        /ops_shopify_order_mgmt_cancel_choices_valid/i,
        'authorization CHECK must reject malformed payment evidence',
      )
      assert.equal(malformedAuthorizationUpdate.code, '23514')
      await authorizationConstraintClient.query('ROLLBACK')
    } finally {
      await authorizationConstraintClient.query('ROLLBACK').catch(() => {})
      authorizationConstraintClient.release()
    }
    await expectRejected(
      () => persistence.claimShopifyOrderManagementInPostgres({
        organizationId: independentFixture.organizationId,
        actorEmail: independentFixture.qualifiedAdminEmail,
        authorizationGlobalId:
          ordinaryCancelPrepared.authorizationGlobalId,
        action: { ...ordinaryCancelAction, notifyCustomer: false },
        reason: ordinaryCancelReason,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_MISMATCH',
      'a changed customer-notification choice must not claim the intent',
    )
    const ordinaryCancelClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: independentFixture.organizationId,
        actorEmail: independentFixture.qualifiedAdminEmail,
        authorizationGlobalId:
          ordinaryCancelPrepared.authorizationGlobalId,
        action: ordinaryCancelAction,
        reason: ordinaryCancelReason,
      })
    const malformedAttemptInsert = await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_shopify_order_management_attempts
         SELECT (
           pg_catalog.jsonb_populate_record(
             NULL::public.operations_shopify_order_management_attempts,
             pg_catalog.to_jsonb(attempt) || pg_catalog.jsonb_build_object(
               'cancellation_payment_evidence', '{}'::jsonb
             )
           )
         ).*
         FROM operations_shopify_order_management_attempts attempt
         WHERE attempt.organization_id = $1::uuid AND attempt.global_id = $2`,
        [
          independentFixture.organizationId,
          ordinaryCancelClaimed.providerAttemptGlobalId,
        ],
      ),
      /cancellation attempt does not match its durable intent/i,
      'attempt insert trigger must reject incomplete payment evidence',
    )
    assert.equal(malformedAttemptInsert.code, 'P0001')

    const attemptConstraintClient = await pool.connect()
    try {
      await attemptConstraintClient.query('BEGIN')
      await attemptConstraintClient.query(
        `ALTER TABLE operations_shopify_order_management_attempts
         DISABLE TRIGGER protect_shopify_order_management_attempt_write`,
      )
      const malformedAttemptUpdate = await expectDatabaseRejected(
        () => attemptConstraintClient.query(
          `UPDATE operations_shopify_order_management_attempts
           SET cancellation_payment_evidence =
                 cancellation_payment_evidence
                 || '{"refundMethod":"none"}'::jsonb
           WHERE organization_id = $1::uuid AND global_id = $2`,
          [
            independentFixture.organizationId,
            ordinaryCancelClaimed.providerAttemptGlobalId,
          ],
        ),
        /ops_shopify_order_mgmt_attempt_cancel_choices_valid/i,
        'attempt CHECK must reject payment evidence/refund choice mismatch',
      )
      assert.equal(malformedAttemptUpdate.code, '23514')
      await attemptConstraintClient.query('ROLLBACK')
    } finally {
      await attemptConstraintClient.query('ROLLBACK').catch(() => {})
      attemptConstraintClient.release()
    }
    await persistence.recordShopifyOrderManagementOutcomeInPostgres({
      organizationId: independentFixture.organizationId,
      actorEmail: independentFixture.qualifiedAdminEmail,
      authorizationGlobalId: ordinaryCancelPrepared.authorizationGlobalId,
      providerAttemptGlobalId:
        ordinaryCancelClaimed.providerAttemptGlobalId,
      outcome: 'succeeded',
      evidence: {
        schema: 'shopify-order-cancel-postgres-acceptance-v1',
        providerCancelled: true,
      },
      providerReference: 'gid://shopify/Job/6600037',
      providerWriteCount: 1,
    })
    const ordinaryCancelStored = await pool.query(
      `SELECT
         authz.provider_order_test,
         authz.cancel_reason AS authorization_reason_code,
         authz.cancel_refund_method AS authorization_refund_method,
         authz.cancel_restock AS authorization_restock,
         authz.cancel_notify_customer AS authorization_notify_customer,
         authz.cancellation_payment_evidence
           AS authorization_payment_evidence,
         attempt.cancel_refund_method AS attempt_refund_method,
         attempt.cancel_restock AS attempt_restock,
         attempt.cancel_notify_customer AS attempt_notify_customer,
         attempt.cancellation_payment_evidence AS attempt_payment_evidence
       FROM operations_shopify_order_management_authorizations authz
       JOIN operations_shopify_order_management_attempts attempt
         ON attempt.organization_id = authz.organization_id
        AND attempt.authorization_id = authz.id
       WHERE authz.organization_id = $1::uuid AND authz.global_id = $2`,
      [
        independentFixture.organizationId,
        ordinaryCancelPrepared.authorizationGlobalId,
      ],
    )
    assert.equal(ordinaryCancelStored.rowCount, 1)
    assert.equal(ordinaryCancelStored.rows[0].provider_order_test, false)
    assert.equal(
      ordinaryCancelStored.rows[0].authorization_reason_code,
      'CUSTOMER',
    )
    for (const prefix of ['authorization', 'attempt']) {
      assert.equal(
        ordinaryCancelStored.rows[0][`${prefix}_refund_method`],
        'original_payment_methods',
      )
      assert.equal(ordinaryCancelStored.rows[0][`${prefix}_restock`], true)
      assert.equal(
        ordinaryCancelStored.rows[0][`${prefix}_notify_customer`],
        true,
      )
      assert.deepEqual(
        ordinaryCancelStored.rows[0][`${prefix}_payment_evidence`],
        ordinaryCancelPaymentEvidence,
      )
    }
    assert.equal(
      JSON.stringify(ordinaryCancelStored.rows).includes(
        ordinaryCancelAction.staffNote,
      ),
      false,
      'cancellation staff-note plaintext must not be retained',
    )

    // A verified production account uses the same current Provider-writes
    // binding, but the database permits only an ordinary cancellation. This
    // is independent of the runtime allowlist, which remains default-off and
    // is exercised by the command/runtime contract tests.
    await pool.query(
      `UPDATE operations_integration_accounts
       SET environment = 'production', updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [
        independentFixture.organizationId,
        independentFixture.accountGlobalId,
      ],
    )
    const productionCancelPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        ...ordinaryCancelPreparation,
        actorEmail: independentFixture.ownerEmail,
        idempotencyKey: 'shopify-production-cancel-0337',
      })
    assert.equal(productionCancelPrepared.accountEnvironment, 'production')
    assert.equal(productionCancelPrepared.action, 'cancel')
    const productionCancelClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: independentFixture.organizationId,
        actorEmail: independentFixture.ownerEmail,
        authorizationGlobalId:
          productionCancelPrepared.authorizationGlobalId,
        action: ordinaryCancelAction,
        reason: ordinaryCancelReason,
      })
    assert.equal(productionCancelClaimed.accountEnvironment, 'production')
    await persistence.recordShopifyOrderManagementOutcomeInPostgres({
      organizationId: independentFixture.organizationId,
      actorEmail: independentFixture.ownerEmail,
      authorizationGlobalId: productionCancelPrepared.authorizationGlobalId,
      providerAttemptGlobalId:
        productionCancelClaimed.providerAttemptGlobalId,
      outcome: 'failed',
      evidence: {
        schema: 'shopify-production-cancel-zero-write-test-v1',
        providerDispatched: false,
      },
      errorCode: 'TEST_PRE_DISPATCH_REJECTION',
      providerWriteCount: 0,
    })
    await expectDatabaseRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: independentFixture.organizationId,
        actorEmail: independentFixture.ownerEmail,
        accountGlobalId: independentFixture.accountGlobalId,
        orderGlobalId: independentFixture.current.global_id,
        expectedOrderRowVersion: Number(
          independentFixture.current.row_version,
        ),
        expectedSourceHash: independentFixture.currentSourceHash,
        ...snapshot(
          false,
          independentFixture.currentAcceptedProviderUpdatedAt,
        ),
        action: { type: 'add_tag', tag: 'production-must-reject-this' },
        reason: 'Prove production permits cancellation only',
        idempotencyKey: 'shopify-production-tag-denied-0337',
      }),
      /authorization is not current or permitted/i,
      'production database fence rejects every non-cancellation action',
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET environment = 'sandbox', updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [
        independentFixture.organizationId,
        independentFixture.accountGlobalId,
      ],
    )

    // 0312 retains one exact combined ordinary Save without retaining any
    // email, phone, PO, note, source-address, or tag plaintext. The same
    // pre-network claim
    // fence binds write_orders plus write_order_edits for multi-line edits.
    const ordinarySaveProjectionHash = '7'.repeat(64)
    const ordinarySaveAction = {
      type: 'save_order',
      email: 'private-buyer@example.com',
      phone: '+15555550199',
      poNumber: 'PRIVATE-PO-6601',
      note: 'Private handling note',
      shippingAddress: {
        firstName: 'Private',
        lastName: 'Buyer',
        company: 'Private Receiving LLC',
        address1: '987 Private Shipping Lane',
        address2: 'Suite 123',
        city: 'Durham',
        provinceCode: 'NC',
        countryCode: 'US',
        zip: '27701',
        phone: '+15555550177',
      },
      tagAdds: ['private-priority'],
      tagRemoves: [],
      lineQuantities: [
        { lineItemGid: 'gid://shopify/LineItem/6600000201', quantity: 1 },
        { lineItemGid: 'gid://shopify/LineItem/6600000202', quantity: 2 },
      ],
    }
    const ordinarySaveReason = 'Save ordinary Shopify order fields together'
    const ordinaryPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: independentFixture.organizationId,
        actorEmail: independentFixture.ownerEmail,
        accountGlobalId: independentFixture.accountGlobalId,
        orderGlobalId: independentFixture.current.global_id,
        expectedOrderRowVersion: Number(
          independentFixture.current.row_version,
        ),
        expectedSourceHash: independentFixture.currentSourceHash,
        ...snapshot(
          true,
          independentFixture.currentAcceptedProviderUpdatedAt,
        ),
        action: ordinarySaveAction,
        requestedProjectionHash: ordinarySaveProjectionHash,
        reason: ordinarySaveReason,
        idempotencyKey: 'shopify-order-combined-save-0312',
      })
    assert.equal(
      ordinaryPrepared.requestedProjectionHash,
      ordinarySaveProjectionHash,
    )
    assert.equal(ordinaryPrepared.requiresOrderEdits, true)
    const ordinaryClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: independentFixture.organizationId,
        actorEmail: independentFixture.ownerEmail,
        authorizationGlobalId: ordinaryPrepared.authorizationGlobalId,
        action: ordinarySaveAction,
        reason: ordinarySaveReason,
      })
    assert.equal(
      ordinaryClaimed.requestedProjectionHash,
      ordinarySaveProjectionHash,
    )
    assert.equal(ordinaryClaimed.requiresOrderEdits, true)
    await persistence.recordShopifyOrderManagementOutcomeInPostgres({
      organizationId: independentFixture.organizationId,
      actorEmail: independentFixture.ownerEmail,
      authorizationGlobalId: ordinaryPrepared.authorizationGlobalId,
      providerAttemptGlobalId: ordinaryClaimed.providerAttemptGlobalId,
      outcome: 'succeeded',
      evidence: {
        schema: 'shopify-order-management-combined-save-test-v1',
        requestedProjectionHash: ordinarySaveProjectionHash,
      },
      providerReference: independentFixture.current.external_order_id,
      providerWriteCount: 5,
    })
    const ordinaryStored = await pool.query(
      `SELECT authz.*, attempt.*, outcome.*
       FROM operations_shopify_order_management_authorizations authz
       JOIN operations_shopify_order_management_attempts attempt
         ON attempt.organization_id = authz.organization_id
        AND attempt.authorization_id = authz.id
       JOIN operations_shopify_order_management_outcomes outcome
         ON outcome.organization_id = authz.organization_id
        AND outcome.authorization_id = authz.id
        AND outcome.provider_attempt_id = attempt.id
       WHERE authz.organization_id = $1::uuid
         AND authz.global_id = $2`,
      [
        independentFixture.organizationId,
        ordinaryPrepared.authorizationGlobalId,
      ],
    )
    const ordinaryFulfillmentBinding = await pool.query(
      `SELECT
         authz.fulfillment_gid AS authorization_fulfillment_gid,
         authz.expected_fulfillment_updated_at
           AS authorization_fulfillment_updated_at,
         authz.predecessor_authorization_id
           AS authorization_predecessor_authorization_id,
         attempt.fulfillment_gid AS attempt_fulfillment_gid,
         attempt.expected_fulfillment_updated_at
           AS attempt_fulfillment_updated_at,
         attempt.predecessor_authorization_id
           AS attempt_predecessor_authorization_id
       FROM operations_shopify_order_management_authorizations authz
       JOIN operations_shopify_order_management_attempts attempt
         ON attempt.organization_id = authz.organization_id
        AND attempt.authorization_id = authz.id
       WHERE authz.organization_id = $1::uuid AND authz.global_id = $2`,
      [
        independentFixture.organizationId,
        ordinaryPrepared.authorizationGlobalId,
      ],
    )
    assert.equal(ordinaryFulfillmentBinding.rowCount, 1)
    assert.equal(
      ordinaryFulfillmentBinding.rows[0].authorization_fulfillment_gid,
      null,
    )
    assert.equal(
      ordinaryFulfillmentBinding.rows[0]
        .authorization_fulfillment_updated_at,
      null,
    )
    assert.equal(
      ordinaryFulfillmentBinding.rows[0].attempt_fulfillment_gid,
      null,
    )
    assert.equal(
      ordinaryFulfillmentBinding.rows[0].attempt_fulfillment_updated_at,
      null,
    )
    assert.equal(
      ordinaryFulfillmentBinding.rows[0]
        .authorization_predecessor_authorization_id,
      null,
    )
    assert.equal(
      ordinaryFulfillmentBinding.rows[0]
        .attempt_predecessor_authorization_id,
      null,
    )
    const ordinarySerialized = JSON.stringify(ordinaryStored.rows)
    for (const privateValue of [
      ordinarySaveAction.email,
      ordinarySaveAction.phone,
      ordinarySaveAction.poNumber,
      ordinarySaveAction.note,
      ordinarySaveAction.tagAdds[0],
      ...Object.values(ordinarySaveAction.shippingAddress).filter(Boolean),
    ]) {
      assert.equal(ordinarySerialized.includes(privateValue), false)
      assert.equal(
        JSON.stringify(audits.filter((event) => (
          event.aggregateId === ordinaryPrepared.authorizationGlobalId
        ))).includes(privateValue),
        false,
      )
    }
    assert.equal(
      ordinaryStored.rows[0].requested_projection_hash,
      ordinarySaveProjectionHash,
    )

    const health = await persistence
      .readShopifyOrderManagementHealthFromPostgres()
    assert.ok(health.prepared >= 1)
    assert.equal(health.processing, 0)
    assert.equal(health.staleProcessing, 0)
    assert.equal(health.unknown, 0)
    assert.ok(health.latestUnknownAt)
    assert.ok(health.lastCompletedAt)
    assert.ok(health.knownProviderWriteOutcomeCount >= 4)
    assert.ok(health.knownProviderWriteSum >= 4)

    const columns = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name =
           'operations_shopify_order_management_authorizations'`,
    )
    const names = columns.rows.map((row) => row.column_name)
    assert.equal(names.includes('tag'), false)
    assert.equal(names.includes('staff_note'), false)
    assert.ok(names.includes('tag_hash'))
    assert.ok(names.includes('staff_note_hash'))
    assert.ok(names.includes('authorization_reason'))

    const stored = await pool.query(
      `SELECT authz.*, attempt.*, outcome.*
       FROM operations_shopify_order_management_authorizations authz
       LEFT JOIN operations_shopify_order_management_attempts attempt
         ON attempt.authorization_id = authz.id
       LEFT JOIN operations_shopify_order_management_outcomes outcome
         ON outcome.authorization_id = authz.id
       WHERE authz.organization_id = $1::uuid`,
      [fixture.organizationId],
    )
    assert.equal(JSON.stringify(stored.rows).includes(tagAction.tag), false)
    assert.equal(
      JSON.stringify(stored.rows).includes(quantityAction.staffNote),
      false,
    )
    assert.ok(audits.some((event) => (
      event.eventType ===
        'operations.shopify_order_management.provider_attempt_committed'
      && event.payload.networkCalls === 0
      && event.payload.providerWrites === 0
    )))
    assert.ok(audits.some((event) => (
      event.eventType === 'operations.shopify_order_management.unknown'
      && event.payload.providerWrites === 1
    )))
    assert.ok(audits.some((event) => (
      event.eventType === 'operations.shopify_order_management.succeeded'
      && event.payload.providerWrites === 3
    )))
    assert.ok(audits.some((event) => (
      event.eventType ===
        'operations.shopify_order_management.processing_lease_expired'
      && event.payload.providerWrites === null
      && event.payload.providerRetryAuthorized === false
    )))
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  for (const phase of ['upgrade', 'fresh']) {
    const container =
      `clawpilot-shopify-order-management-${phase}-${randomUUID()}`
    try {
      command('docker', [
        'run', '--detach', '--rm', '--name', container,
        '-e', 'POSTGRES_PASSWORD=postgres',
        '-e', 'POSTGRES_DB=clawpilot_order_management_test',
        '-p', '127.0.0.1::5432',
        'pgvector/pgvector:pg18',
      ])
      const portOutput = command('docker', ['port', container, '5432/tcp'])
      const port = portOutput.trim().split(':').at(-1)
      const databaseUrl =
        `postgresql://postgres:postgres@127.0.0.1:${port}/clawpilot_order_management_test`
      await waitForPostgres(databaseUrl)
      const pool = new Pool({ connectionString: databaseUrl, max: 1 })
      try {
        for (const filename of migrations().filter((name) => (
          phase === 'fresh'
          || name !== '0337_operations_shopify_ordinary_order_cancellation.sql'
        ))) {
          await applyMigration(pool, filename)
        }
        if (phase === 'upgrade') {
          await verifyLegacyCancellationUpgrade(pool)
        }
      } finally {
        await pool.end()
      }
      if (phase === 'fresh') await verify(databaseUrl)
    } finally {
      spawnSync('docker', ['stop', '-t', '1', container], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      })
    }
  }
  console.log(
    'Shopify order management PostgreSQL upgrade, transitions, and safety fences passed.',
  )
}

await main()
