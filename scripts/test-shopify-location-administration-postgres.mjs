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

function command(binary, args, timeout = 180_000) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
  })
  if (result.error || result.status !== 0) {
    throw result.error || new Error(
      `${binary} ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    )
  }
  return String(result.stdout || '').trim()
}

function migrationFiles() {
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

function loadPersistence(pool) {
  const path = 'app_src/lib/persistence/shopifyLocationAdministration.ts'
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: path,
    },
  ).outputText
  const module = { exports: {} }
  const postgres = {
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
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === 'node:crypto') return requireFromApp(specifier)
      if (specifier === '@/lib/auditWriter') {
        return { async recordAuditEvent() {} }
      }
      if (specifier === '@/lib/persistence/postgres') return postgres
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

async function expectCode(work, code, label) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${label}: expected rejection`)
  assert.equal(error.code, code, `${label}: ${String(error.message || error)}`)
}

async function expectDatabaseError(work, pattern, label) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${label}: expected database rejection`)
  assert.match(String(error.message || error), pattern, label)
}

const address = Object.freeze({
  address1: '100 Bakery Way',
  address2: '',
  city: 'Fairfield',
  provinceCode: 'CT',
  countryCode: 'US',
  zip: '06824',
})

function providerLocation(overrides = {}) {
  return {
    id: 'gid://shopify/Location/2890001',
    name: 'Mapped Bakery Warehouse',
    isActive: false,
    activatable: true,
    shipsInventory: true,
    fulfillsOnlineOrders: true,
    isFulfillmentService: false,
    fulfillmentService: null,
    address: { ...address },
    ...overrides,
  }
}

async function seed(pool) {
  const ownerEmail = `shopify-location-owner-${randomUUID()}@example.test`
  const otherEmail = `shopify-location-other-${randomUUID()}@example.test`
  await pool.query(
    `INSERT INTO app_users (email, role, status)
     VALUES ($1, 'owner', 'active'), ($2, 'admin', 'active')`,
    [ownerEmail, otherEmail],
  )
  const organization = await pool.query(
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ('Shopify location administration', 'root', $1, $1)
     RETURNING id::text`,
    [ownerEmail],
  )
  const tenant = await pool.query(
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ('Other tenant', 'root', $1, $1)
     RETURNING id::text`,
    [ownerEmail],
  )
  const organizationId = organization.rows[0].id
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES (
       $1, $2::uuid, 'owner',
       '{"manageOperations":true,"executeWarehouse":true}'::jsonb,
       'active', true, $1, $1
     )`,
    [ownerEmail, organizationId],
  )
  const pipeline = await pool.query(
    `INSERT INTO pipeline_spaces (
       name, owner_email, is_default, workspace_organization_id
     ) VALUES ('Shopify location administration', $1, true, $2::uuid)
     RETURNING id::text`,
    [ownerEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, revision, reason, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shadow', 9,
       'Shopify location administration acceptance', $3
     )`,
    [organizationId, pipeline.rows[0].id, ownerEmail],
  )
  const account = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, configuration, external_account_id,
       commerce_credential_generation, created_by, updated_by
     ) VALUES (
       $1::uuid, 'shopify', 'commerce', 'sandbox',
       'Test Pro Bakery Bites', 'active',
       '{"shopDomain":"test-pro-bakery-bites.myshopify.com"}'::jsonb,
       'gid://shopify/Shop/2890001', 3, $2, $2
     ) RETURNING id::text, global_id`,
    [organizationId, ownerEmail],
  )
  await pool.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'gid://shopify/Shop/2890001',
       'shopify_client_credentials', decode('01', 'hex'),
       decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex'),
       3, '0001', 'verified', now(), 'unverified', $3, $3
     )`,
    [organizationId, account.rows[0].id, ownerEmail],
  )
  async function warehouse(code, name) {
    const result = await pool.query(
      `INSERT INTO operations_warehouses (
         organization_id, code, name, timezone, address, status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3, 'America/New_York', $4::jsonb, 'active', $5, $5
       ) RETURNING id::text, global_id, row_version::text`,
      [
        organizationId,
        code,
        name,
        JSON.stringify({
          name,
          line1: address.address1,
          line2: '',
          city: address.city,
          region: address.provinceCode,
          postalCode: address.zip,
          country: address.countryCode,
        }),
        ownerEmail,
      ],
    )
    return result.rows[0]
  }
  const addWarehouse = await warehouse('ADD-01', 'Add Bakery Warehouse')
  const staleWarehouse = await warehouse('STALE-01', 'Stale Bakery Warehouse')
  const mappedWarehouse = await warehouse(
    'MAPPED-01',
    'Mapped Bakery Warehouse',
  )
  const crossAccountWarehouse = await warehouse(
    'CROSS-01',
    'Cross Account Bakery Warehouse',
  )
  const location = await pool.query(
    `INSERT INTO operations_locations (
       organization_id, warehouse_id, code, zone, location_type,
       active, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'STORAGE-01', 'STORAGE', 'storage', true, $3, $3
     ) RETURNING id::text`,
    [organizationId, mappedWarehouse.id, ownerEmail],
  )
  const inventoryPool = await pool.query(
    `INSERT INTO operations_inventory_pools (
       organization_id, pipeline_id, name, pool_type, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, 'Bakery inventory', 'shared', true, $3
     ) RETURNING id::text`,
    [organizationId, pipeline.rows[0].id, ownerEmail],
  )
  const mapping = await pool.query(
    `INSERT INTO operations_commerce_inventory_location_mappings (
       organization_id, integration_account_id, external_location_id,
       external_location_name, external_location_address, warehouse_id,
       location_id, inventory_pool_id, mapping_method, active, row_version,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'gid://shopify/Location/2890001',
       'Mapped Bakery Warehouse', $3::jsonb, $4::uuid, $5::uuid, $6::uuid,
       'manual', true, 0, $7, $7
     ) RETURNING id::text, global_id, row_version::text`,
    [
      organizationId,
      account.rows[0].id,
      JSON.stringify(address),
      mappedWarehouse.id,
      location.rows[0].id,
      inventoryPool.rows[0].id,
      ownerEmail,
    ],
  )
  const otherAccount = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, configuration, external_account_id,
       commerce_credential_generation, created_by, updated_by
     ) VALUES (
       $1::uuid, 'shopify', 'commerce', 'production',
       'Other Shopify development store', 'active',
       '{"shopDomain":"other-shopify-development-store.myshopify.com"}'::jsonb,
       'gid://shopify/Shop/2890002', 0, $2, $2
     ) RETURNING id::text`,
    [organizationId, ownerEmail],
  )
  const crossAccountLocation = await pool.query(
    `INSERT INTO operations_locations (
       organization_id, warehouse_id, code, zone, location_type,
       active, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'CROSS-STORAGE-01', 'STORAGE', 'storage',
       true, $3, $3
     ) RETURNING id::text`,
    [organizationId, crossAccountWarehouse.id, ownerEmail],
  )
  const crossAccountPool = await pool.query(
    `INSERT INTO operations_inventory_pools (
       organization_id, pipeline_id, name, pool_type, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, 'Cross account inventory', 'shared', true, $3
     ) RETURNING id::text`,
    [organizationId, pipeline.rows[0].id, ownerEmail],
  )
  await pool.query(
    `INSERT INTO operations_commerce_inventory_location_mappings (
       organization_id, integration_account_id, external_location_id,
       external_location_name, external_location_address, warehouse_id,
       location_id, inventory_pool_id, mapping_method, active, row_version,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'gid://shopify/Location/2890002',
       'Cross Account Bakery Warehouse', $3::jsonb, $4::uuid, $5::uuid,
       $6::uuid, 'manual', true, 0, $7, $7
     )`,
    [
      organizationId,
      otherAccount.rows[0].id,
      JSON.stringify(address),
      crossAccountWarehouse.id,
      crossAccountLocation.rows[0].id,
      crossAccountPool.rows[0].id,
      ownerEmail,
    ],
  )
  return {
    organizationId,
    otherOrganizationId: tenant.rows[0].id,
    ownerEmail,
    otherEmail,
    accountGlobalId: account.rows[0].global_id,
    otherAccountId: otherAccount.rows[0].id,
    addWarehouse,
    staleWarehouse,
    mappedWarehouse,
    crossAccountWarehouse,
    mapping: mapping.rows[0],
  }
}

async function exercise(pool) {
  for (const migration of migrationFiles()) {
    await applyMigration(pool, migration)
  }
  const fixture = await seed(pool)
  const persistence = loadPersistence(pool)
  const configuration =
    await persistence.readShopifyLocationAdministrationConfigurationInPostgres({
      organizationId: fixture.organizationId,
      accountGlobalId: fixture.accountGlobalId,
    })
  assert.equal(configuration.warehouses.length, 4)
  assert.ok(configuration.warehouses.every(
    (warehouse) => warehouse.locationAdministrationReady,
  ))
  const addDesired = configuration.warehouses.find(
    (warehouse) => warehouse.globalId === fixture.addWarehouse.global_id,
  ).desiredLocation
  const crossAccountRoutedWarehouse = configuration.warehouses.find(
    (warehouse) => (
      warehouse.globalId === fixture.crossAccountWarehouse.global_id
    ),
  )
  assert.equal(
    crossAccountRoutedWarehouse.hasActiveCommerceLocationRouting,
    true,
  )
  await expectCode(
    () => persistence.prepareShopifyLocationAdministrationInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      actorRole: 'owner',
      accountGlobalId: fixture.accountGlobalId,
      action: 'locationAdd',
      warehouseGlobalId: fixture.crossAccountWarehouse.global_id,
      expectedWarehouseRowVersion: Number(
        fixture.crossAccountWarehouse.row_version,
      ),
      mappingGlobalId: null,
      expectedMappingRowVersion: null,
      providerLocation: null,
      providerLocationSetHash: '0'.repeat(64),
      providerObservedAt: new Date().toISOString(),
      desiredLocation: crossAccountRoutedWarehouse.desiredLocation,
      reason: 'This second account must not claim an already routed target.',
      confirmationStatement: [
        'AUTHORIZE SHOPIFY LOCATION', 'ADD', fixture.accountGlobalId,
        fixture.crossAccountWarehouse.global_id, 'NEW',
      ].join(' | '),
      idempotencyKey: 'location-add-cross-account-2890002',
    }),
    'SHOPIFY_LOCATION_ADMINISTRATION_WAREHOUSE_ALREADY_MAPPED',
    'cross-account active warehouse routing',
  )
  const addInput = {
    organizationId: fixture.organizationId,
    actorEmail: fixture.ownerEmail,
    actorRole: 'owner',
    accountGlobalId: fixture.accountGlobalId,
    action: 'locationAdd',
    warehouseGlobalId: fixture.addWarehouse.global_id,
    expectedWarehouseRowVersion: Number(fixture.addWarehouse.row_version),
    mappingGlobalId: null,
    expectedMappingRowVersion: null,
    providerLocation: null,
    providerLocationSetHash: 'a'.repeat(64),
    providerObservedAt: new Date().toISOString(),
    desiredLocation: addDesired,
    reason: 'Create the reviewed Bakery development-store location.',
    confirmationStatement: [
      'AUTHORIZE SHOPIFY LOCATION', 'ADD', fixture.accountGlobalId,
      fixture.addWarehouse.global_id, 'NEW',
    ].join(' | '),
    idempotencyKey: 'location-add-2890001',
  }
  const prepared =
    await persistence.prepareShopifyLocationAdministrationInPostgres(addInput)
  assert.equal(prepared.status, 'prepared')
  assert.equal(prepared.action, 'locationAdd')
  assert.equal(prepared.mappingGlobalId, null)
  const pendingPrepared =
    await persistence.readPendingShopifyLocationAdministrationsInPostgres({
      organizationId: fixture.organizationId,
      accountGlobalId: fixture.accountGlobalId,
      actorEmail: fixture.ownerEmail,
    })
  assert.equal(pendingPrepared.length, 1)
  assert.equal(
    pendingPrepared[0].authorizationGlobalId,
    prepared.authorizationGlobalId,
  )
  assert.equal(
    (await persistence.readPendingShopifyLocationAdministrationsInPostgres({
      organizationId: fixture.organizationId,
      accountGlobalId: fixture.accountGlobalId,
      actorEmail: fixture.otherEmail,
    })).length,
    0,
    'pending authorization recovery is actor-bound',
  )
  const replay =
    await persistence.prepareShopifyLocationAdministrationInPostgres(addInput)
  assert.equal(replay.authorizationGlobalId, prepared.authorizationGlobalId)
  await expectCode(
    () => persistence.prepareShopifyLocationAdministrationInPostgres({
      ...addInput,
      reason: 'A different request must conflict with the existing key.',
    }),
    'SHOPIFY_LOCATION_ADMINISTRATION_IDEMPOTENCY_CONFLICT',
    'request-hash idempotency conflict',
  )
  await expectCode(
    () => persistence.readShopifyLocationAdministrationAuthorizationInPostgres({
      organizationId: fixture.otherOrganizationId,
      authorizationGlobalId: prepared.authorizationGlobalId,
    }),
    'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_NOT_FOUND',
    'cross-tenant authorization read',
  )
  await expectCode(
    () => persistence.readShopifyLocationAdministrationAuthorizationInPostgres({
      organizationId: fixture.organizationId,
      authorizationGlobalId: 'gsla0000000',
    }),
    'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_NOT_FOUND',
    'unknown authorization',
  )
  await expectCode(
    () => persistence.claimShopifyLocationAdministrationInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.otherEmail,
      authorizationGlobalId: prepared.authorizationGlobalId,
      idempotencyKey: addInput.idempotencyKey,
    }),
    'SHOPIFY_LOCATION_ADMINISTRATION_ACTOR_OR_IDEMPOTENCY_MISMATCH',
    'actor-bound claim',
  )
  const claimed =
    await persistence.claimShopifyLocationAdministrationInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: prepared.authorizationGlobalId,
      idempotencyKey: addInput.idempotencyKey,
    })
  assert.equal(claimed.status, 'processing')
  assert.ok(claimed.attemptGlobalId)
  await expectCode(
    () => persistence.claimShopifyLocationAdministrationInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: prepared.authorizationGlobalId,
      idempotencyKey: addInput.idempotencyKey,
    }),
    'SHOPIFY_LOCATION_ADMINISTRATION_ALREADY_CLAIMED',
    'one-shot claim',
  )
  const unknown =
    await persistence.recordShopifyLocationAdministrationOutcomeInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: prepared.authorizationGlobalId,
      attemptGlobalId: claimed.attemptGlobalId,
      outcome: 'unknown',
      providerLocationId: null,
      providerReference: null,
      providerWriteCount: null,
      errorCode: 'SHOPIFY_TIMEOUT',
      evidence: {
        schema: 'shopify-location-administration-outcome-v1',
        providerMutationAttempted: true,
        providerWritesKnown: false,
        providerWrites: null,
      },
    })
  assert.equal(unknown.status, 'unknown')
  const pendingUnknown =
    await persistence.readPendingShopifyLocationAdministrationsInPostgres({
      organizationId: fixture.organizationId,
      accountGlobalId: fixture.accountGlobalId,
      actorEmail: fixture.ownerEmail,
    })
  assert.equal(pendingUnknown.length, 1)
  assert.equal(pendingUnknown[0].attemptGlobalId, claimed.attemptGlobalId)
  const reconciled =
    await persistence.reconcileShopifyLocationAdministrationAppliedInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: prepared.authorizationGlobalId,
      attemptGlobalId: claimed.attemptGlobalId,
      providerLocationId: 'gid://shopify/Location/2890099',
      providerReference: 'gid://shopify/Location/2890099',
      evidence: {
        schema: 'shopify-location-administration-reconciliation-v1',
        resolution: 'confirmed_applied',
        providerMutationsDuringReconciliation: 0,
      },
    })
  assert.equal(reconciled.status, 'reconciled')
  assert.equal(
    (await persistence.readPendingShopifyLocationAdministrationsInPostgres({
      organizationId: fixture.organizationId,
      accountGlobalId: fixture.accountGlobalId,
      actorEmail: fixture.ownerEmail,
    })).length,
    0,
  )

  const immutableIds = await pool.query(
    `SELECT attempt.id::text AS attempt_id, outcome.id::text AS outcome_id
       FROM operations_shopify_location_administration_authorizations authz
       JOIN operations_shopify_location_administration_attempts attempt
         ON attempt.id = authz.provider_attempt_id
       JOIN operations_shopify_location_administration_outcomes outcome
         ON outcome.id = authz.latest_outcome_id
      WHERE authz.global_id = $1`,
    [prepared.authorizationGlobalId],
  )
  await expectDatabaseError(
    () => pool.query(
      `UPDATE operations_shopify_location_administration_attempts
          SET dispatch_state = 'authorized' WHERE id = $1::uuid`,
      [immutableIds.rows[0].attempt_id],
    ),
    /attempts are immutable/u,
    'attempt immutability',
  )
  await expectDatabaseError(
    () => pool.query(
      `DELETE FROM operations_shopify_location_administration_outcomes
        WHERE id = $1::uuid`,
      [immutableIds.rows[0].outcome_id],
    ),
    /outcomes are immutable/u,
    'outcome immutability',
  )

  const routeStalePrepared =
    await persistence.prepareShopifyLocationAdministrationInPostgres({
      ...addInput,
      idempotencyKey: 'location-add-route-stale-2890001',
    })
  const routeLocation = await pool.query(
    `INSERT INTO operations_locations (
       organization_id, warehouse_id, code, zone, location_type,
       active, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'ROUTE-STALE-01', 'STORAGE', 'storage', true,
       $3, $3
     ) RETURNING id::text`,
    [fixture.organizationId, fixture.addWarehouse.id, fixture.ownerEmail],
  )
  const routePool = await pool.query(
    `INSERT INTO operations_inventory_pools (
       organization_id, pipeline_id, name, pool_type, active, created_by
     )
     SELECT $1::uuid, data_pipeline_id, 'Route stale inventory', 'shared',
            true, $2
       FROM operations_activation_scopes
      WHERE organization_id = $1::uuid
     RETURNING id::text`,
    [fixture.organizationId, fixture.ownerEmail],
  )
  await pool.query(
    `INSERT INTO operations_commerce_inventory_location_mappings (
       organization_id, integration_account_id, external_location_id,
       external_location_name, external_location_address, warehouse_id,
       location_id, inventory_pool_id, mapping_method, active, row_version,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'gid://shopify/Location/2890003',
       'Add Bakery Warehouse', $3::jsonb, $4::uuid, $5::uuid, $6::uuid,
       'manual', true, 0, $7, $7
     )`,
    [
      fixture.organizationId,
      fixture.otherAccountId,
      JSON.stringify(address),
      fixture.addWarehouse.id,
      routeLocation.rows[0].id,
      routePool.rows[0].id,
      fixture.ownerEmail,
    ],
  )
  await expectCode(
    () => persistence.claimShopifyLocationAdministrationInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: routeStalePrepared.authorizationGlobalId,
      idempotencyKey: 'location-add-route-stale-2890001',
    }),
    'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_STALE',
    'cross-account active routing invalidates an existing add grant',
  )

  const staleConfiguration =
    await persistence.readShopifyLocationAdministrationConfigurationInPostgres({
      organizationId: fixture.organizationId,
      accountGlobalId: fixture.accountGlobalId,
    })
  const staleDesired = staleConfiguration.warehouses.find(
    (warehouse) => warehouse.globalId === fixture.staleWarehouse.global_id,
  ).desiredLocation
  const stalePrepared =
    await persistence.prepareShopifyLocationAdministrationInPostgres({
      ...addInput,
      warehouseGlobalId: fixture.staleWarehouse.global_id,
      expectedWarehouseRowVersion: Number(fixture.staleWarehouse.row_version),
      desiredLocation: staleDesired,
      confirmationStatement: [
        'AUTHORIZE SHOPIFY LOCATION', 'ADD', fixture.accountGlobalId,
        fixture.staleWarehouse.global_id, 'NEW',
      ].join(' | '),
      idempotencyKey: 'location-add-stale-2890001',
    })
  await pool.query(
    `UPDATE operations_warehouses
        SET address = address || '{"line2":"Suite 2"}'::jsonb,
            row_version = row_version + 1
      WHERE organization_id = $1::uuid AND global_id = $2`,
    [fixture.organizationId, fixture.staleWarehouse.global_id],
  )
  await expectCode(
    () => persistence.claimShopifyLocationAdministrationInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: stalePrepared.authorizationGlobalId,
      idempotencyKey: 'location-add-stale-2890001',
    }),
    'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_STALE',
    'warehouse row-version and address hash fence',
  )

  const mappingConfiguration =
    await persistence.readShopifyLocationAdministrationConfigurationInPostgres({
      organizationId: fixture.organizationId,
      accountGlobalId: fixture.accountGlobalId,
    })
  const mappedDesired = mappingConfiguration.warehouses.find(
    (warehouse) => warehouse.globalId === fixture.mappedWarehouse.global_id,
  ).desiredLocation
  await expectCode(
    () => persistence.prepareShopifyLocationAdministrationInPostgres({
      ...addInput,
      action: 'locationEdit',
      warehouseGlobalId: fixture.mappedWarehouse.global_id,
      expectedWarehouseRowVersion: Number(fixture.mappedWarehouse.row_version),
      mappingGlobalId: fixture.mapping.global_id,
      expectedMappingRowVersion: 0,
      providerLocation: providerLocation({
        isFulfillmentService: true,
        fulfillmentService: {
          id: 'gid://shopify/FulfillmentService/1',
          handle: 'third-party',
          serviceName: 'Third Party',
        },
      }),
      providerLocationSetHash: null,
      desiredLocation: mappedDesired,
      confirmationStatement: [
        'AUTHORIZE SHOPIFY LOCATION', 'EDIT', fixture.accountGlobalId,
        fixture.mappedWarehouse.global_id,
        'gid://shopify/Location/2890001',
      ].join(' | '),
      idempotencyKey: 'location-edit-fs-2890001',
    }),
    'SHOPIFY_LOCATION_ADMINISTRATION_FULFILLMENT_SERVICE_FORBIDDEN',
    'fulfillment-service location write',
  )
  await expectCode(
    () => persistence.prepareShopifyLocationAdministrationInPostgres({
      ...addInput,
      action: 'locationActivate',
      warehouseGlobalId: fixture.mappedWarehouse.global_id,
      expectedWarehouseRowVersion: Number(fixture.mappedWarehouse.row_version),
      mappingGlobalId: fixture.mapping.global_id,
      expectedMappingRowVersion: 0,
      providerLocation: providerLocation({
        name: 'Former Bakery Warehouse',
      }),
      providerLocationSetHash: null,
      desiredLocation: mappedDesired,
      confirmationStatement: [
        'AUTHORIZE SHOPIFY LOCATION', 'ACTIVATE', fixture.accountGlobalId,
        fixture.mappedWarehouse.global_id,
        'gid://shopify/Location/2890001',
      ].join(' | '),
      idempotencyKey: 'location-activate-edit-first-2890001',
    }),
    'SHOPIFY_LOCATION_ADMINISTRATION_LOCATION_EDIT_REQUIRED',
    'activation requires exact warehouse location facts',
  )
  const editPrepared =
    await persistence.prepareShopifyLocationAdministrationInPostgres({
      ...addInput,
      action: 'locationEdit',
      warehouseGlobalId: fixture.mappedWarehouse.global_id,
      expectedWarehouseRowVersion: Number(fixture.mappedWarehouse.row_version),
      mappingGlobalId: fixture.mapping.global_id,
      expectedMappingRowVersion: 0,
      providerLocation: providerLocation({
        name: 'Former Bakery Warehouse',
      }),
      providerLocationSetHash: null,
      desiredLocation: mappedDesired,
      confirmationStatement: [
        'AUTHORIZE SHOPIFY LOCATION', 'EDIT', fixture.accountGlobalId,
        fixture.mappedWarehouse.global_id,
        'gid://shopify/Location/2890001',
      ].join(' | '),
      idempotencyKey: 'location-edit-2890001',
    })
  assert.equal(editPrepared.mappingRowVersion, 1)
  assert.equal(editPrepared.providerSnapshot.isFulfillmentService, false)
  const mappingRow = await pool.query(
    `SELECT row_version::text, ownership_classification,
            provider_snapshot_hash
       FROM operations_commerce_inventory_location_mappings
      WHERE global_id = $1`,
    [fixture.mapping.global_id],
  )
  assert.equal(mappingRow.rows[0].row_version, '1')
  assert.equal(mappingRow.rows[0].ownership_classification, 'merchant_managed')
  assert.match(mappingRow.rows[0].provider_snapshot_hash, /^[a-f0-9]{64}$/u)
  const editClaim =
    await persistence.claimShopifyLocationAdministrationInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: editPrepared.authorizationGlobalId,
      idempotencyKey: 'location-edit-2890001',
    })
  const failed =
    await persistence.recordShopifyLocationAdministrationOutcomeInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: editPrepared.authorizationGlobalId,
      attemptGlobalId: editClaim.attemptGlobalId,
      outcome: 'failed',
      providerLocationId: null,
      providerReference: null,
      providerWriteCount: 0,
      errorCode: 'SHOPIFY_LOCATION_ADMINISTRATION_USER_ERROR',
      evidence: {
        schema: 'shopify-location-administration-outcome-v1',
        userErrors: [{ field: ['input', 'name'], messageHash: 'b'.repeat(64) }],
        providerWrites: 0,
      },
    })
  assert.equal(failed.status, 'failed')
  const count = await pool.query(
    `SELECT
       (SELECT count(*)::int
          FROM operations_shopify_location_administration_attempts)
          AS attempts,
       (SELECT count(*)::int
          FROM operations_shopify_location_administration_outcomes)
          AS outcomes`,
  )
  assert.equal(count.rows[0].attempts, 2)
  assert.equal(count.rows[0].outcomes, 3)
}

async function main() {
  command('docker', ['info'], 30_000)
  const container = (
    `clawpilot-shopify-location-admin-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=shopify_location_admin',
      '-e', 'POSTGRES_DB=shopify_location_admin',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ])
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:shopify_location_admin@127.0.0.1:'
      + `${port}/shopify_location_admin`
    )
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 6 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
  } finally {
    command('docker', ['stop', container], 30_000)
  }
  console.log('Shopify location-administration PostgreSQL safety tests passed')
}

main().catch((error) => {
  console.error(error)
  if (error.cause) console.error(error.cause)
  process.exit(1)
})
