#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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

function markedSql(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  assert.ok(start >= 0, `Missing SQL marker ${startMarker}`)
  assert.ok(end > start, `Missing SQL marker ${endMarker}`)
  return source.slice(start + startMarker.length, end).trim()
}

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function normalizeTestShopifyPlanningAuthority(value) {
  return {
    version: value.version,
    shopId: value.shopId,
    credentialVersion: value.credentialVersion,
    accountGlobalId: value.accountGlobalId,
    candidate: {
      globalId: value.candidate.globalId,
      rowVersion: value.candidate.rowVersion,
      sourceHash: value.candidate.sourceHash,
    },
    warehouse: {
      globalId: value.warehouse.globalId,
      locationMappingGlobalId:
        value.warehouse.locationMappingGlobalId,
      locationMappingRowVersion:
        value.warehouse.locationMappingRowVersion,
      shopifyLocationId: value.warehouse.shopifyLocationId,
    },
    order: {
      externalOrderId: value.order.externalOrderId,
      name: value.order.name,
      updatedAt: new Date(value.order.updatedAt).toISOString(),
      confirmed: true,
      cancelledAt: null,
      closedAt: null,
      fulfillmentStatus: value.order.fulfillmentStatus,
      fulfillable: true,
    },
    lines: value.lines.map((line) => ({
      candidateLineGlobalId: line.candidateLineGlobalId,
      canonicalLineGlobalId: line.canonicalLineGlobalId,
      externalLineId: line.externalLineId,
      quantity: line.quantity,
    })).sort((left, right) => (
      left.externalLineId.localeCompare(right.externalLineId)
      || left.candidateLineGlobalId.localeCompare(
        right.candidateLineGlobalId,
      )
    )),
    fulfillmentOrders: value.fulfillmentOrders.map((order) => ({
      fulfillmentOrderId: order.fulfillmentOrderId,
      status: 'OPEN',
      requestStatus: 'UNSUBMITTED',
      updatedAt: new Date(order.updatedAt).toISOString(),
      assignedLocationId: order.assignedLocationId,
      lines: order.lines.map((line) => ({
        fulfillmentOrderLineItemId:
          line.fulfillmentOrderLineItemId,
        externalLineId: line.externalLineId,
        quantity: line.quantity,
      })).sort((left, right) => (
        left.externalLineId.localeCompare(right.externalLineId)
        || left.fulfillmentOrderLineItemId.localeCompare(
          right.fulfillmentOrderLineItemId,
        )
      )),
    })).sort((left, right) => (
      left.fulfillmentOrderId.localeCompare(right.fulfillmentOrderId)
    )),
  }
}

function testShopifyPlanningAuthorityHash(value) {
  return sha(JSON.stringify(normalizeTestShopifyPlanningAuthority(value)))
}

function loadTypeScriptModule(path, { mocks = {}, globals = {} } = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    BigInt,
    Buffer,
    Date,
    Error,
    Headers,
    Map,
    Request,
    Response,
    Set,
    TextDecoder,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    setTimeout,
    structuredClone,
    ...globals,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    env: { ...process.env, ...options.env },
  })
  if (result.error || result.status !== 0) {
    throw result.error || new Error(
      `${commandName} ${args.join(' ')} failed: ${
        result.stderr || result.stdout
      }`,
    )
  }
  return String(result.stdout || '').trim()
}

async function waitForPostgres(connectionString) {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 2000,
  })
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

function postgresMock(pool) {
  return {
    query: (sql, params = []) => pool.query(sql, params),
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

async function seedCanonicalPlanningFixture(
  pool,
  {
    activationState = 'active',
    carrierReadEnvironment = 'production',
    checkoutServiceCode = null,
    customerChargeUse = 'eligible',
    duplicatePackageLine = false,
    packagingStockOnHand = 2,
    inventoryAuthority = 'shopify',
    shopifyUnlistedChannel = false,
  } = {},
) {
  const suffix = randomUUID().slice(0, 8)
  const shopifyNumericId = BigInt(`0x${suffix}`).toString()
  const localSplitAuthority = inventoryAuthority === 'clawpilot_split'
  assert.ok(
    localSplitAuthority || inventoryAuthority === 'shopify',
    `Unsupported canonical inventory authority ${inventoryAuthority}`,
  )
  const commerceProvider = localSplitAuthority ? 'faire' : 'shopify'
  const commerceEnvironment = localSplitAuthority
    ? 'production'
    : 'sandbox'
  assert.equal(
    localSplitAuthority && checkoutServiceCode !== null,
    false,
    'Only Shopify fixtures may retain a Shopify checkout service code',
  )
  assert.equal(
    localSplitAuthority && shopifyUnlistedChannel,
    false,
    'Only Shopify fixtures may use an UNLISTED channel state',
  )
  const channelProviderStatusRaw = shopifyUnlistedChannel
    ? 'UNLISTED'
    : 'PUBLISHED'
  const channelNormalizedStatus = shopifyUnlistedChannel
    ? 'unlisted'
    : 'active'
  const channelProviderActive = !shopifyUnlistedChannel
  const email = `canonical-planning-${suffix}@example.com`
  await pool.query(
    `INSERT INTO app_users (email, role, status, display_name)
     VALUES ($1, 'owner', 'active', 'Canonical planning acceptance')`,
    [email],
  )
  const organizationResult = await pool.query(
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ($1, 'root', $2, $2)
     RETURNING id::text`,
    [`Canonical planning ${suffix}`, email],
  )
  const organizationId = organizationResult.rows[0].id
  await pool.query(
    `UPDATE app_users
     SET organization_id = $2::uuid, organization_name = $3
     WHERE email = $1`,
    [email, organizationId, `Canonical planning ${suffix}`],
  )
  const pipelineResult = await pool.query(
    `INSERT INTO pipeline_spaces (
       name, owner_email, is_default, workspace_organization_id
     ) VALUES ('Canonical planning pipeline', $1, true, $2::uuid)
     RETURNING id::text`,
    [email, organizationId],
  )
  const pipelineId = pipelineResult.rows[0].id
  await pool.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, reason, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3,
       'Focused canonical fulfillment acceptance', $4
     )
     ON CONFLICT (organization_id) DO UPDATE
     SET data_pipeline_id = EXCLUDED.data_pipeline_id,
         state = EXCLUDED.state,
         reason = EXCLUDED.reason,
         updated_by = EXCLUDED.updated_by`,
    [organizationId, pipelineId, activationState, email],
  )
  const customerResult = await pool.query(
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, name, identity_key,
       workspace_organization_id, relationship_type, source_hash,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'Canonical planning customer', $2,
       $3::uuid, 'customer', $4, $5, $5
     )
     RETURNING id::text, reference_code`,
    [
      pipelineId,
      `canonical-customer-${suffix}`,
      organizationId,
      sha(`canonical-customer-${suffix}`),
      email,
    ],
  )
  const customer = customerResult.rows[0]
  const productResult = await pool.query(
    `INSERT INTO crm_products (
       pipeline_id, source_key, name, sku, product_type, price, cost,
       currency, source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'Canonical 6 oz test product', $3, 'Good',
       10.00, 4.00, 'USD', $4, $5, $5
     )
     RETURNING id::text, reference_code`,
    [
      pipelineId,
      `canonical-product-${suffix}`,
      `CANON-${suffix}`,
      sha(`canonical-product-${suffix}`),
      email,
    ],
  )
  const product = productResult.rows[0]
  const commerceAccountResult = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, configuration, external_account_id,
       commerce_credential_generation, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'commerce', $3,
       'Canonical commerce', 'active', '{}'::jsonb, $4, 1, $5, $5
     )
     RETURNING id::text, global_id`,
    [
      organizationId,
      commerceProvider,
      commerceEnvironment,
      commerceProvider === 'shopify'
        ? `gid://shopify/Shop/${shopifyNumericId}`
        : `canonical-${commerceProvider}-${suffix}`,
      email,
    ],
  )
  const commerceAccount = commerceAccountResult.rows[0]
  if (commerceProvider === 'shopify') {
    await pool.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3,
         'shopify_client_credentials', $4, $5, $6,
         1, '1234', 'verified', now(), 'unverified', $7, $7
       )`,
      [
        organizationId,
        commerceAccount.id,
        `gid://shopify/Shop/${shopifyNumericId}`,
        Buffer.from(`canonical-shopify-credential-${suffix}`),
        Buffer.alloc(12, 3),
        Buffer.alloc(16, 4),
        email,
      ],
    )
  }
  const upsAccountResult = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, configuration, created_by, updated_by
     ) VALUES (
       $1::uuid, 'ups_rest', 'carrier', 'sandbox',
       'Canonical UPS', 'active', '{}'::jsonb, $2, $2
     )
     RETURNING id::text`,
    [organizationId, email],
  )
  const fedexAccountResult = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, configuration, created_by, updated_by
     ) VALUES (
       $1::uuid, 'fedex_rest', 'carrier', 'sandbox',
       'Canonical FedEx', 'active', '{}'::jsonb, $2, $2
     )
     RETURNING id::text`,
    [organizationId, email],
  )
  async function createCarrierAccount({
    integrationAccountId,
    provider,
    displayName,
    lastFour,
  }) {
    const registeredAddress = {
      name: 'Canonical warehouse',
      line1: '7009 S 108th St',
      city: 'La Vista',
      region: 'NE',
      postalCode: '68128',
      countryCode: 'US',
    }
    const result = await pool.query(
      `INSERT INTO operations_carrier_accounts (
         organization_id, integration_account_id, display_name, sender_name,
         account_number_ciphertext, account_number_iv, account_number_tag,
         account_number_last_four, account_number_fingerprint,
         registered_address, registered_address_fingerprint,
         address_verification, status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'Canonical warehouse',
         $4, $5, $6, $7, $8,
         $9::jsonb, $10,
         'operator_attested', 'active', $11, $11
       )
       RETURNING id::text`,
      [
        organizationId,
        integrationAccountId,
        displayName,
        `canonical-${provider}-ciphertext-${suffix}`,
        `canonical-${provider}-iv-${suffix}`,
        `canonical-${provider}-tag-${suffix}`,
        lastFour,
        sha(`canonical-${provider}-account-${suffix}`),
        JSON.stringify(registeredAddress),
        sha(JSON.stringify(registeredAddress)),
        email,
      ],
    )
    return result.rows[0]
  }
  const upsCarrierAccount = await createCarrierAccount({
    integrationAccountId: upsAccountResult.rows[0].id,
    provider: 'ups_rest',
    displayName: 'Canonical UPS account',
    lastFour: '1001',
  })
  const fedexCarrierAccount = await createCarrierAccount({
    integrationAccountId: fedexAccountResult.rows[0].id,
    provider: 'fedex_rest',
    displayName: 'Canonical FedEx account',
    lastFour: '2002',
  })
  const warehouseResult = await pool.query(
    `INSERT INTO operations_warehouses (
       organization_id, code, name, timezone, address, status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'Canonical warehouse', 'America/Chicago',
       $3::jsonb, 'active', $4, $4
     )
     RETURNING id::text, global_id`,
    [
      organizationId,
      `CAN-${suffix}`,
      JSON.stringify({
        name: 'Canonical warehouse',
        line1: '7009 S 108th St',
        city: 'La Vista',
        region: 'NE',
        postalCode: '68128',
        country: 'US',
      }),
      email,
    ],
  )
  const warehouse = warehouseResult.rows[0]
  const locationResult = await pool.query(
    `INSERT INTO operations_locations (
       organization_id, warehouse_id, code, zone, location_type,
       pick_sequence, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, 'PICK-01', 'PICK', 'pick',
       1, true, $3
     )
     RETURNING id::text, global_id`,
    [organizationId, warehouse.id, email],
  )
  const location = locationResult.rows[0]
  let reserveLocation = null
  if (localSplitAuthority) {
    const reserveLocationResult = await pool.query(
      `INSERT INTO operations_locations (
         organization_id, warehouse_id, code, zone, location_type,
         pick_sequence, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'RESERVE-01', 'RESERVE', 'storage',
         2, true, $3
       )
       RETURNING id::text, global_id`,
      [organizationId, warehouse.id, email],
    )
    reserveLocation = reserveLocationResult.rows[0]
  }
  const poolResult = await pool.query(
    `INSERT INTO operations_inventory_pools (
       organization_id, pipeline_id, name, pool_type,
       allocation_policy, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, 'Canonical shared inventory',
       'shared', 'fifo', true, $3
     )
     RETURNING id::text`,
    [organizationId, pipelineId, email],
  )
  const inventoryPoolId = poolResult.rows[0].id
  const mappingResult = await pool.query(
    `INSERT INTO operations_product_mappings (
       organization_id, integration_account_id, pipeline_id,
       product_id, channel_sku, external_product_id,
       external_variant_id, external_inventory_item_id,
       mapping_method, mapping_source_revision, active,
       created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
       'exact_variant', 'canonical-acceptance', true, $9
     )
     RETURNING id::text`,
    [
      organizationId,
      commerceAccount.id,
      pipelineId,
      product.id,
      `CANON-${suffix}`,
      `gid://shopify/Product/${suffix}`,
      `gid://shopify/ProductVariant/${suffix}`,
      `gid://shopify/InventoryItem/${suffix}`,
      email,
    ],
  )
  const productMappingId = mappingResult.rows[0].id
  let commercePackMapping = null
  let commercePackVersion = null
  {
    const channelRevision = `canonical-${commerceProvider}-pack-${suffix}`
    const channelHash = sha(channelRevision)
    const channelStateResult = await pool.query(
      `INSERT INTO operations_product_channel_states (
         organization_id, integration_account_id, pipeline_id, provider,
         external_product_id, external_variant_id,
         external_inventory_item_id, product_id, product_mapping_id,
         provider_product_title, provider_variant_title, provider_sku,
         provider_status_raw, normalized_status, provider_active,
         requires_shipping, weight_grams, observed_at, source_revision,
         source_hash, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
         $8::uuid, $9::uuid,
         'Canonical 6 oz test product', 'Default', $10,
         $14, $15, $16, true, 170, now(), $11, $12,
         $13, $13
       )
       RETURNING id::text, pack_evidence_hash`,
      [
        organizationId,
        commerceAccount.id,
        pipelineId,
        commerceProvider,
        `gid://shopify/Product/${suffix}`,
        `gid://shopify/ProductVariant/${suffix}`,
        `gid://shopify/InventoryItem/${suffix}`,
        product.id,
        productMappingId,
        `CANON-${suffix}`,
        channelRevision,
        channelHash,
        email,
        channelProviderStatusRaw,
        channelNormalizedStatus,
        channelProviderActive,
      ],
    )
    const packProfileResult = await pool.query(
      `INSERT INTO operations_product_pack_profiles (
         organization_id, pipeline_id, product_id, profile_key,
         profile_name, package_level, is_default, status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire-each',
         'Exact commerce each', 'each', true, 'active', $4, $4
       )
       RETURNING id::text`,
      [organizationId, pipelineId, product.id, email],
    )
    const packVersionResult = await pool.query(
      `INSERT INTO operations_product_pack_profile_versions (
         organization_id, pipeline_id, product_id, profile_id,
         version_number, lifecycle_state, base_each_quantity,
         unit_of_measure, length_mm, width_mm, height_mm, dimension_basis,
         gross_weight_grams, weight_basis, fit_model,
         ships_as_own_package, assembly_policy, evidence_type, source,
         is_current, evidence_reference, confirmed_at, confirmed_by,
         created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         1, 'active', 1, 'each', 203, 152, 51, 'outer',
         170, 'customer_stated', 'rigid_3d', false, 'never',
         'customer_confirmed', 'manual', true,
         'Canonical exact commerce item-pack evidence', now(), $5, $5
       )
       RETURNING id::text, global_id, row_version::text`,
      [
        organizationId,
        pipelineId,
        product.id,
        packProfileResult.rows[0].id,
        email,
      ],
    )
    commercePackVersion = packVersionResult.rows[0]
    const packMappingResult = await pool.query(
      `INSERT INTO operations_commerce_variant_pack_mappings (
         organization_id, integration_account_id, pipeline_id, product_id,
         provider, external_product_id, external_variant_id,
         default_pack_profile_version_id, provider_lifecycle_state,
         projection_state, mapping_purpose, source_revision, source_hash,
         pack_evidence_hash, observed_at, is_current, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5, $6, $7, $8::uuid, $13,
         'current', 'catalog', $9, $10, $11, now(), true, $12, $12
       )
       RETURNING id::text, global_id, row_version::text`,
      [
        organizationId,
        commerceAccount.id,
        pipelineId,
        product.id,
        commerceProvider,
        `gid://shopify/Product/${suffix}`,
        `gid://shopify/ProductVariant/${suffix}`,
        commercePackVersion.id,
        channelRevision,
        channelHash,
        channelStateResult.rows[0].pack_evidence_hash,
        email,
        channelNormalizedStatus,
      ],
    )
    commercePackMapping = packMappingResult.rows[0]
  }
  const materialResult = await pool.query(
    `INSERT INTO operations_packaging_materials (
       organization_id, code, name, material_type,
       inner_length_mm, inner_width_mm, inner_height_mm,
       tare_weight_grams, max_weight_grams, unit_cost_minor,
       currency, status, source,
       dimension_basis, dimension_evidence_type,
       dimension_evidence_reference, dimension_confirmed_at,
       dimension_confirmed_by,
       rated_outer_length_mm, rated_outer_width_mm,
       rated_outer_height_mm, rated_outer_dimension_evidence_type,
       rated_outer_dimension_evidence_reference,
       rated_outer_dimension_confirmed_at,
       rated_outer_dimension_confirmed_by,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'Canonical test carton', 'carton',
       280, 230, 180, 120, 5000, 55,
       'USD', 'active', 'manual',
       'inner', 'measured', $3, now(), $4,
       280, 230, 180, 'measured', $3, now(), $4,
       $4, $4
     )
     RETURNING id::text, global_id, row_version::text`,
    [
      organizationId,
      `BOX-${suffix.toUpperCase()}`,
      `canonical-measurement-${suffix}`,
      email,
    ],
  )
  const material = materialResult.rows[0]
  const packagingStockResult = await pool.query(
    `INSERT INTO operations_packaging_material_stock (
       organization_id, packaging_material_id, warehouse_id,
       is_available, on_hand_quantity, reorder_point_quantity,
       reorder_to_quantity, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       true, $4, 0, $4, $5, $5
     )
     RETURNING id::text, global_id, row_version::text,
               on_hand_quantity`,
    [
      organizationId,
      material.id,
      warehouse.id,
      packagingStockOnHand,
      email,
    ],
  )
  const packagingStock = packagingStockResult.rows[0]
  const orderResult = await pool.query(
    `INSERT INTO operations_orders (
       organization_id, pipeline_id, customer_id, integration_account_id,
       source_provider, external_order_id, order_number, status, currency,
       merchandise_total_minor, requested_delivery_at, ship_to,
       source_payload, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5, $6, $7, 'imported', 'USD',
       2000, NULL, $8::jsonb, $9::jsonb, $10, $10
     )
     RETURNING id::text, global_id, row_version::text`,
    [
      organizationId,
      pipelineId,
      customer.id,
      commerceAccount.id,
      commerceProvider,
      commerceProvider === 'shopify'
        ? `gid://shopify/Order/${shopifyNumericId}`
        : `canonical-${commerceProvider}-order-${suffix}`,
      `CANON-${suffix}`,
      JSON.stringify({
        name: 'Canonical planning customer',
        line1: '35 Saxony Drive',
        city: 'Trumbull',
        region: 'CT',
        postalCode: '06611',
        country: 'US',
      }),
      JSON.stringify({
        amountsMinor: {
          merchandise: 2000,
          shipping: 1500,
          total: 3500,
        },
        headerMoney: {
          customerChargeUse,
        },
      }),
      email,
    ],
  )
  const order = orderResult.rows[0]
  const orderLineResult = await pool.query(
    `INSERT INTO operations_order_lines (
       organization_id, order_id, pipeline_id, product_id,
       external_line_id, channel_sku, description, quantity,
       unit_price_minor, weight_grams, dimensions_mm
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5, $6, 'Canonical 6 oz test product', 2,
       1000, 170, '{"length":203,"width":152,"height":51}'::jsonb
     )
     RETURNING id::text, global_id`,
    [
      organizationId,
      order.id,
      pipelineId,
      product.id,
      `gid://shopify/LineItem/${shopifyNumericId}`,
      `CANON-${suffix}`,
    ],
  )
  const orderLine = orderLineResult.rows[0]
  const promotionReceiptResult = await pool.query(
    `INSERT INTO operations_command_receipts (
       organization_id, command_type, idempotency_key, request_hash,
       actor_email, status, correlation_id, result_global_id,
       result_payload, completed_at
     ) VALUES (
       $1::uuid, 'promote_commerce_order', $2, $3,
       $4, 'succeeded', $5::uuid, $6,
       $7::jsonb, now()
     )
     RETURNING id::text`,
    [
      organizationId,
      `promote-${suffix}`,
      sha(`promote-${suffix}`),
      email,
      randomUUID(),
      order.global_id,
      JSON.stringify({
        orderGlobalId: order.global_id,
        orderStatus: 'imported',
      }),
    ],
  )
  const promotionReceiptId = promotionReceiptResult.rows[0].id
  const intakeRunResult = await pool.query(
    `INSERT INTO operations_commerce_intake_runs (
       organization_id, integration_account_id, pipeline_id,
       provider, resource, credential_version, provider_api_version,
       normalizer_version, idempotency_key, request_hash, window_end,
       workflow_state, records_seen, records_staged, records_promoted,
       canonical_orders_created, completed_at, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       $4, 'orders', 1, '2026-07', 'canonical-test-v1',
       $5, $6, now(), 'promoted', 1, 1, 1, 1, now(), $7, $7
     )
     RETURNING id::text`,
    [
      organizationId,
      commerceAccount.id,
      pipelineId,
      commerceProvider,
      `intake-${suffix}`,
      sha(`intake-${suffix}`),
      email,
    ],
  )
  const intakeRunId = intakeRunResult.rows[0].id
  const sourceHash = sha(`candidate-${suffix}`)
  const candidateResult = await pool.query(
    `INSERT INTO operations_commerce_order_candidates (
       organization_id, integration_account_id, pipeline_id, run_id,
       provider, external_order_id, order_number_snapshot, source_channel,
       checkout_shipping_service_code,
       provider_order_status_raw, provider_financial_status_raw,
       provider_fulfillment_status_raw, provider_return_status_raw,
       normalized_order_status, normalized_payment_status,
       normalized_fulfillment_status, normalized_return_status,
       test_order, requires_shipping, currency_code, subtotal_minor,
       discount_minor, brand_discount_minor, shipping_minor, tax_minor,
       other_adjustment_minor, total_minor, party_kind,
       party_snapshot_state, customer_resolution_state,
       customer_match_method, customer_id, ship_to_snapshot_state,
       ship_to_snapshot_source, ship_to_snapshot_ciphertext,
       ship_to_snapshot_iv, ship_to_snapshot_tag, ship_to_snapshot_hash,
       ship_to_snapshot_encryption_version, delivery_resolution_state,
       requested_delivery_at, observed_at, source_revision, source_hash,
       provider_api_version, normalizer_version, workflow_state,
       blocking_codes, canonical_order_id, promotion_command_receipt_id,
       promotion_idempotency_key, promotion_request_hash, promoted_at,
       row_version, created_by, updated_by, expires_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       '${commerceProvider}', $5, $6, 'online_store', $19,
       'open', 'paid', 'unfulfilled', 'none',
       'open', 'paid', 'unfulfilled', 'none',
       true, true, 'USD', 2000,
       0, 0, 1500, 0, 0, 3500, 'consumer',
       'missing', 'resolved',
       'exact_email', $7::uuid, 'confirmed',
       'manual', $8, $9, $10, $11,
       1, 'manual', now() + interval '7 days',
       now(), $12, $13, '2026-07', 'canonical-test-v1',
       'promoted', '{}'::text[], $14::uuid, $15::uuid,
       $16, $17, now(), 1, $18, $18, now() + interval '7 days'
     )
     RETURNING id::text, global_id, row_version::text`,
    [
      organizationId,
      commerceAccount.id,
      pipelineId,
      intakeRunId,
      commerceProvider === 'shopify'
        ? `gid://shopify/Order/${shopifyNumericId}`
        : `canonical-${commerceProvider}-order-${suffix}`,
      `CANON-${suffix}`,
      customer.id,
      Buffer.from('canonical confirmed ship-to'),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      sha(`ship-to-${suffix}`),
      `revision-${suffix}`,
      sourceHash,
      order.id,
      promotionReceiptId,
      `promote-${suffix}`,
      sha(`promote-request-${suffix}`),
      email,
      checkoutServiceCode,
    ],
  )
  const candidate = candidateResult.rows[0]
  const candidateLineResult = await pool.query(
    `INSERT INTO operations_commerce_order_candidate_lines (
       organization_id, integration_account_id, pipeline_id, run_id,
       order_candidate_id, provider, external_line_id,
       external_product_id, external_variant_id,
       external_inventory_item_id, sku_snapshot,
       product_title_snapshot, provider_status_raw, normalized_status,
       ordered_quantity, current_quantity, unfulfilled_quantity,
       physical_quantity, currency_code, unit_price_minor, subtotal_minor,
       discount_minor, brand_discount_minor, tax_minor,
       other_adjustment_minor, total_minor, price_resolution_state,
       resolved_currency_code, resolved_unit_price_minor,
       resolved_subtotal_minor, resolved_discount_minor,
       resolved_brand_discount_minor, resolved_tax_minor,
       resolved_other_adjustment_minor, resolved_total_minor,
       taxable, requires_shipping, mapping_state, product_id,
       product_mapping_id, packaging_state, packaging_source,
       commerce_variant_pack_mapping_id,
       commerce_variant_pack_mapping_row_version,
       pack_profile_version_id, pack_profile_version_row_version,
       pack_profile_package_level, pack_profile_base_each_quantity,
       packaging_weight_source,
       weight_grams, length_mm, width_mm, height_mm,
       observed_at, source_revision, source_hash,
       provider_api_version, normalizer_version, workflow_state,
       blocking_codes, canonical_order_line_id, promoted_at,
       row_version, created_by, updated_by, expires_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, '${commerceProvider}', $6,
       $7, $8, $9, $10,
       'Canonical 6 oz test product', 'open', 'open',
       2, 2, 2, 2, 'USD', 1000, 2000,
       0, 0, 0, 0, 2000, 'provider',
       'USD', 1000, 2000, 0, 0, 0, 0, 2000,
       true, true, 'resolved', $11::uuid,
       $12::uuid, 'resolved', $13,
       $14::uuid, $15::bigint, $16::uuid, $17::bigint,
       $18, $19::integer, $20,
       170, 203, 152, 51,
       now(), $21, $22, '2026-07', 'canonical-test-v1',
       'promoted', '{}'::text[], $23::uuid, now(),
       1, $24, $24, now() + interval '7 days'
     )
     RETURNING id::text, global_id`,
    [
      organizationId,
      commerceAccount.id,
      pipelineId,
      intakeRunId,
      candidate.id,
      `gid://shopify/LineItem/${shopifyNumericId}`,
      `gid://shopify/Product/${suffix}`,
      `gid://shopify/ProductVariant/${suffix}`,
      `gid://shopify/InventoryItem/${suffix}`,
      `CANON-${suffix}`,
      product.id,
      productMappingId,
      'variant_pack_mapping',
      commercePackMapping?.id || null,
      commercePackMapping?.row_version || null,
      commercePackVersion?.id || null,
      commercePackVersion?.row_version || null,
      'each',
      1,
      'profile_version',
      `line-revision-${suffix}`,
      sha(`line-${suffix}`),
      orderLine.id,
      email,
    ],
  )
  const candidateLine = candidateLineResult.rows[0]

  let inventoryRun = null
  let inventoryLevel = null
  let inventoryPosition = null
  let inventoryLocationMapping = null
  let splitInventoryPositions = []
  if (!localSplitAuthority) {
  const providerAttemptResult = await pool.query(
    `INSERT INTO operations_commerce_provider_attempts (
       organization_id, integration_account_id, action, adapter_version,
       external_object_id, idempotency_key, request_hash,
       redacted_request, redacted_response, state,
       completed_at, created_by
     ) VALUES (
       $1::uuid, $2::uuid, 'inventory_read', 'canonical-test-v1',
       $3, $4, $5, '{}'::jsonb, '{}'::jsonb, 'succeeded',
       now(), $6
     )
     RETURNING id::text`,
    [
      organizationId,
      commerceAccount.id,
      `gid://shopify/Location/${shopifyNumericId}`,
      `inventory-attempt-${suffix}`,
      sha(`inventory-attempt-${suffix}`),
      email,
    ],
  )
  const providerAttemptId = providerAttemptResult.rows[0].id
  const inventoryLocationMappingResult = await pool.query(
    `INSERT INTO operations_commerce_inventory_location_mappings (
       organization_id, integration_account_id,
       external_location_id, external_location_name,
       external_location_address, warehouse_id, location_id,
       inventory_pool_id, mapping_method, active,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'Canonical Shopify location',
       '{}'::jsonb, $4::uuid, $5::uuid, $6::uuid,
       'manual', true, $7, $7
     )
     RETURNING id::text, global_id, row_version::text,
               external_location_id`,
    [
      organizationId,
      commerceAccount.id,
      `gid://shopify/Location/${shopifyNumericId}`,
      warehouse.id,
      location.id,
      inventoryPoolId,
      email,
    ],
  )
  inventoryLocationMapping = inventoryLocationMappingResult.rows[0]
  const inventoryLocationMappingId = inventoryLocationMapping.id
  const captureResult = await pool.query(
    `INSERT INTO operations_commerce_inventory_captures (
       organization_id, integration_account_id, provider_attempt_id,
       warehouse_id, location_id, provider, adapter_version,
       credential_version, request_hash, snapshot_hash,
       provider_location_id, provider_fetched_at, level_count,
       captured_snapshot, snapshot_bytes, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       'shopify', 'canonical-test-v1', 1, $6, $7,
       $8, now(), 1, '{"levels":1}'::jsonb, 12, $9
     )
     RETURNING id::text`,
    [
      organizationId,
      commerceAccount.id,
      providerAttemptId,
      warehouse.id,
      location.id,
      sha(`inventory-request-${suffix}`),
      sha(`inventory-snapshot-${suffix}`),
      inventoryLocationMapping.external_location_id,
      email,
    ],
  )
  const captureId = captureResult.rows[0].id
  const inventoryRunResult = await pool.query(
    `INSERT INTO operations_commerce_inventory_sync_runs (
       organization_id, integration_account_id, provider_attempt_id,
       capture_id, location_mapping_id, warehouse_id, location_id,
       inventory_pool_id, provider, adapter_version, credential_version,
       idempotency_key, request_hash, snapshot_hash, status,
       provider_location_id, provider_location_name, provider_fetched_at,
       levels_seen, levels_mapped, levels_projected, levels_unmapped,
       levels_untracked, negative_available_levels,
       equation_mismatch_levels, provider_available_quantity,
       provider_committed_quantity, provider_on_hand_quantity,
       operational_available_quantity, positions_created,
       positions_updated, positions_zeroed, created_by, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       $6::uuid, $7::uuid, $8::uuid,
       'shopify', 'canonical-test-v1', 1,
       $9, $10, $11, 'succeeded',
       $12, 'Canonical Shopify location', now(),
       1, 1, 1, 0, 0, 0, 0,
       8, 2, 10, 8, 1, 0, 0, $13, now()
     )
     RETURNING id::text, global_id`,
    [
      organizationId,
      commerceAccount.id,
      providerAttemptId,
      captureId,
      inventoryLocationMappingId,
      warehouse.id,
      location.id,
      inventoryPoolId,
      `inventory-run-${suffix}`,
      sha(`inventory-run-request-${suffix}`),
      sha(`inventory-run-snapshot-${suffix}`),
      inventoryLocationMapping.external_location_id,
      email,
    ],
  )
  inventoryRun = inventoryRunResult.rows[0]
  const positionResult = await pool.query(
    `SELECT set_config('clawpilot.shopify_inventory_sync', 'on', false)`,
  )
  assert.equal(positionResult.rowCount, 1)
  const inventoryPositionResult = await pool.query(
    `INSERT INTO operations_inventory_positions (
       organization_id, pipeline_id, warehouse_id, location_id,
       pool_id, product_id, lot_code, on_hand_quantity,
       reserved_quantity, damaged_quantity, source_authority
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
       '', 10, 2, 0, 'shopify'
     )
     RETURNING id::text, global_id`,
    [
      organizationId,
      pipelineId,
      warehouse.id,
      location.id,
      inventoryPoolId,
      product.id,
    ],
  )
  inventoryPosition = inventoryPositionResult.rows[0]
  await pool.query(
    `SELECT set_config('clawpilot.shopify_inventory_sync', 'off', false)`,
  )
  const inventoryLevelResult = await pool.query(
    `INSERT INTO operations_commerce_inventory_levels (
       organization_id, sync_run_id, integration_account_id,
       location_mapping_id, warehouse_id, location_id, inventory_pool_id,
       pipeline_id, product_id, inventory_position_id,
       provider_location_id, external_inventory_item_id, sku,
       tracked, mapping_state, projection_state,
       provider_available_quantity, provider_incoming_quantity,
       provider_committed_quantity, provider_damaged_quantity,
       provider_on_hand_quantity, provider_quality_control_quantity,
       provider_reserved_quantity, provider_safety_stock_quantity,
       provider_quantity_evidence, operational_available_quantity,
       equation_matches, provider_weight_grams, provider_dimensions_mm,
       product_snapshot, source_hash
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       $4::uuid, $5::uuid, $6::uuid, $7::uuid,
       $8::uuid, $9::uuid, $10::uuid,
       $11, $12, $13,
       true, 'mapped', 'projected',
       8, 0, 2, 0, 10, 0, 0, 0,
       '{"available":8,"committed":2,"onHand":10}'::jsonb, 8,
       true, 170, '{"length":203,"width":152,"height":51}'::jsonb,
       '{"title":"Canonical 6 oz test product"}'::jsonb, $14
     )
     RETURNING id::text, global_id`,
    [
      organizationId,
      inventoryRun.id,
      commerceAccount.id,
      inventoryLocationMappingId,
      warehouse.id,
      location.id,
      inventoryPoolId,
      pipelineId,
      product.id,
      inventoryPosition.id,
      inventoryLocationMapping.external_location_id,
      `gid://shopify/InventoryItem/${suffix}`,
      `CANON-${suffix}`,
      sha(`inventory-level-${suffix}`),
    ],
  )
  inventoryLevel = inventoryLevelResult.rows[0]
  } else {
    assert.ok(reserveLocation, 'Local split fixture requires reserve location')
    const localPositionsResult = await pool.query(
      `INSERT INTO operations_inventory_positions (
         organization_id, pipeline_id, warehouse_id, location_id,
         pool_id, product_id, lot_code, on_hand_quantity,
         reserved_quantity, damaged_quantity, source_authority
       ) VALUES
         (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, 'PICK-FACE', 1, 0, 0, 'clawpilot'
         ),
         (
           $1::uuid, $2::uuid, $3::uuid, $7::uuid,
           $5::uuid, $6::uuid, 'RESERVE-CASE', 4, 0, 1, 'clawpilot'
         )
       RETURNING id::text, global_id, location_id::text,
                 lot_code, on_hand_quantity::text,
                 reserved_quantity::text, damaged_quantity::text`,
      [
        organizationId,
        pipelineId,
        warehouse.id,
        location.id,
        inventoryPoolId,
        product.id,
        reserveLocation.id,
      ],
    )
    splitInventoryPositions = localPositionsResult.rows
    inventoryPosition = splitInventoryPositions[0]
  }

  const destinationFingerprint = sha(`destination-${suffix}`)
  const parcelOne = {
    description: 'Canonical package 1',
    length: 11.024,
    width: 9.055,
    height: 7.087,
    dimensionUnit: 'IN',
    weight: 0.639,
    weightUnit: 'LB',
  }
  const parcelTwo = {
    ...parcelOne,
    description: 'Canonical package 2',
  }
  const packageKeys = ['canonical-package-1', 'canonical-package-2']
  const rateRequestIds = {}
  for (const rate of [{
    provider: 'ups_rest',
    accountId: upsAccountResult.rows[0].id,
    carrierAccountId: upsCarrierAccount.id,
    rates: [{
      serviceCode: 'ground',
      serviceName: 'UPS Ground',
      amount: '12.50',
      currency: 'USD',
      rateType: 'account',
      transitDays: 3,
      deliveryDate: null,
    }],
  }, {
    provider: 'fedex_rest',
    accountId: fedexAccountResult.rows[0].id,
    carrierAccountId: fedexCarrierAccount.id,
    rates: [{
      serviceCode: 'fedex_ground',
      serviceName: 'FedEx Ground',
      amount: '13.25',
      currency: 'USD',
      rateType: 'account',
      transitDays: 2,
      deliveryDate: null,
    }],
  }]) {
    const requestHash = sha(`${rate.provider}-request-${suffix}`)
    const result = await pool.query(
      `INSERT INTO operations_carrier_rate_requests (
         organization_id, integration_account_id, carrier_account_id, provider,
         environment, purpose, adapter_version, credential_version,
         request_hash, redacted_request, redacted_response,
         status, actor_email, requested_at, completed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4,
         'sandbox', 'cartonization_shipment_rate',
         'canonical-test-v1', 1, $5, $6::jsonb, $7::jsonb,
         'succeeded', $8, now() - interval '1 second', now()
       )
       RETURNING id::text, global_id`,
      [
        organizationId,
        rate.accountId,
        rate.carrierAccountId,
        rate.provider,
        requestHash,
        JSON.stringify({
          shipment: {
            destinationFingerprint,
            rateScope: 'multi_package_shipment',
            packageCount: 2,
            parcels: [parcelOne, parcelTwo],
          },
        }),
        JSON.stringify({
          rateScope: 'multi_package_shipment',
          packageCount: 2,
          rateCount: rate.rates.length,
          rates: rate.rates,
        }),
        email,
      ],
    )
    rateRequestIds[rate.provider] = {
      ...result.rows[0],
      requestHash,
    }
  }

  const shopifyPlanningAuthority = commerceProvider === 'shopify'
    ? {
        version: 'shopify-order-planning-authority-v1',
        shopId: `gid://shopify/Shop/${shopifyNumericId}`,
        credentialVersion: 1,
        accountGlobalId: commerceAccount.global_id,
        candidate: {
          globalId: candidate.global_id,
          rowVersion: Number(candidate.row_version),
          sourceHash,
        },
        warehouse: {
          globalId: warehouse.global_id,
          locationMappingGlobalId:
            inventoryLocationMapping.global_id,
          locationMappingRowVersion: Number(
            inventoryLocationMapping.row_version,
          ),
          shopifyLocationId:
            inventoryLocationMapping.external_location_id,
        },
        order: {
          externalOrderId:
            `gid://shopify/Order/${shopifyNumericId}`,
          name: `#CANON-${suffix}`,
          updatedAt: '2026-08-10T12:00:00.000Z',
          confirmed: true,
          cancelledAt: null,
          closedAt: null,
          fulfillmentStatus: 'UNFULFILLED',
          fulfillable: true,
        },
        lines: [{
          candidateLineGlobalId: candidateLine.global_id,
          canonicalLineGlobalId: orderLine.global_id,
          externalLineId:
            `gid://shopify/LineItem/${shopifyNumericId}`,
          quantity: 2,
        }],
        fulfillmentOrders: [{
          fulfillmentOrderId:
            `gid://shopify/FulfillmentOrder/${shopifyNumericId}1`,
          status: 'OPEN',
          requestStatus: 'UNSUBMITTED',
          updatedAt: '2026-08-10T11:59:00.000Z',
          assignedLocationId:
            inventoryLocationMapping.external_location_id,
          lines: [{
            fulfillmentOrderLineItemId:
              `gid://shopify/FulfillmentOrderLineItem/${shopifyNumericId}2`,
            externalLineId:
              `gid://shopify/LineItem/${shopifyNumericId}`,
            quantity: 2,
          }],
        }],
      }
    : null
  const planSnapshot = {
    version: 'canonical-acceptance-v1',
    carrierReadEnvironment,
    packages: packageKeys,
    ...(shopifyPlanningAuthority
      ? {
          shopifyOrderPlanningAuthorityHash:
            testShopifyPlanningAuthorityHash(
              shopifyPlanningAuthority,
            ),
          shopifyOrderPlanningAuthority:
            shopifyPlanningAuthority,
        }
      : {}),
  }

  const evidenceToken = `canonical-evidence-${randomUUID()}`
  const evidenceClient = await pool.connect()
  let evidence
  try {
    await evidenceClient.query('BEGIN')
    await evidenceClient.query(
      `SELECT set_config(
         'clawpilot.cartonization_evidence_write_token', $1, true
       )`,
      [evidenceToken],
    )
    const evidenceResult = await evidenceClient.query(
      `INSERT INTO operations_cartonization_rate_evidence (
         organization_id, integration_account_id, order_candidate_id,
         candidate_row_version, candidate_source_hash,
         destination_fingerprint, warehouse_id, inventory_sync_run_id,
         evidence_mode, policy_version, algorithm_version,
         request_hash, plan_input_hash, plan_result_hash,
         plan_snapshot, assumption_snapshot, status,
         idempotency_key, actor_email, write_token_hash
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         1, $4, $5, $6::uuid, $7::uuid,
         'operational', 'canonical-acceptance-v1', 'or-tools-v1',
         $8, $9, $10, $11::jsonb, $12::jsonb, 'succeeded',
         $13, $14, $15
       )
       RETURNING id::text, global_id`,
      [
        organizationId,
        commerceAccount.id,
        candidate.id,
        sourceHash,
        destinationFingerprint,
        warehouse.id,
        inventoryRun?.id || null,
        sha(`evidence-request-${suffix}`),
        sha(`plan-input-${suffix}`),
        sha(`plan-result-${suffix}`),
        JSON.stringify(planSnapshot),
        JSON.stringify({
          inventorySyncRunGlobalId: inventoryRun?.global_id || null,
          candidateRowVersion: 1,
        }),
        `canonical-evidence-${suffix}`,
        email,
        sha(evidenceToken),
      ],
    )
    evidence = evidenceResult.rows[0]
    for (const [index, packageKey] of packageKeys.entries()) {
      await evidenceClient.query(
        `INSERT INTO operations_cartonization_rate_evidence_packages (
           organization_id, evidence_id, package_key, package_sequence,
           planning_method, packaging_material_id, material_row_version,
           inner_dimensions_mm, rated_outer_dimensions_mm,
           content_weight_grams, tare_weight_grams,
           rated_gross_weight_grams, max_weight_grams,
           allocations, carrier_parcel_snapshot, package_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4,
           'or_tools', $5::uuid, $6,
           '{"length":280,"width":230,"height":180}'::jsonb,
           '{"length":280,"width":230,"height":180}'::jsonb,
           170, 120, 290, 5000, $7::jsonb, $8::jsonb, $9
         )`,
        [
          organizationId,
          evidence.id,
          packageKey,
          index + 1,
          material.id,
          Number(material.row_version),
          JSON.stringify([
            {
              lineGlobalId: candidateLine.global_id,
              productGlobalId: product.reference_code,
              title: 'Canonical 6 oz test product',
              quantity: 1,
            },
            ...(duplicatePackageLine && index === 0
              ? [{
                  lineGlobalId: candidateLine.global_id,
                  productGlobalId: product.reference_code,
                  title: 'Canonical 6 oz test product',
                  quantity: 1,
                }]
              : []),
          ]),
          JSON.stringify(index === 0 ? parcelOne : parcelTwo),
          sha(`${packageKey}-${suffix}`),
        ],
      )
      await evidenceClient.query(
        `INSERT INTO
           operations_cartonization_rate_evidence_package_profiles (
             organization_id, evidence_id, package_key, line_global_id,
             product_global_id, input_pack_profile_version_id,
             input_profile_version_global_id,
             input_profile_version_row_version, fit_model,
             unit_dimensions_mm, unit_weight_grams, quantity
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4,
             $5, $6::uuid, $7, $8, 'rigid_3d',
             '{"length":203,"width":152,"height":51}'::jsonb,
             170, 1
           )`,
        [
          organizationId,
          evidence.id,
          packageKey,
          candidateLine.global_id,
          product.reference_code,
          commercePackVersion.id,
          commercePackVersion.global_id,
          Number(commercePackVersion.row_version),
        ],
      )
    }
    for (const packageKey of packageKeys) {
      for (const provider of ['ups_rest', 'fedex_rest']) {
        await evidenceClient.query(
          `INSERT INTO operations_cartonization_rate_evidence_quotes (
             organization_id, evidence_id, package_key, provider,
             rate_purpose, carrier_rate_request_id, quote_status,
             carrier_request_hash, package_rate_context_hash
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4,
             'cartonization_shipment_rate', $5::uuid, 'succeeded',
             $6, $7
           )`,
          [
            organizationId,
            evidence.id,
            packageKey,
            provider,
            rateRequestIds[provider].id,
            rateRequestIds[provider].requestHash,
            sha(`${provider}-shipment-context-${suffix}`),
          ],
        )
      }
    }
    await evidenceClient.query(
      `UPDATE operations_cartonization_rate_evidence
       SET sealed_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, evidence.id],
    )
    await evidenceClient.query('COMMIT')
  } catch (error) {
    await evidenceClient.query('ROLLBACK')
    throw error
  } finally {
    evidenceClient.release()
  }

  return {
    email,
    organizationId,
    order,
    candidate,
    candidateLine,
    product,
    material,
    packagingStock,
    evidence,
    inventoryRun,
    inventoryLevel,
    inventoryPosition,
    splitInventoryPositions,
    warehouse,
    location,
    reserveLocation,
    inventoryPoolId,
    commerceAccount,
    commercePackMapping,
    shopifyPlanningAuthority,
    expected: {
      checkoutChargeMinor:
        customerChargeUse === 'eligible' ? 1500 : null,
      carrierCostMinor: 1250,
      checkoutVarianceMinor:
        customerChargeUse === 'eligible' ? 250 : null,
      packageCount: 2,
    },
  }
}

async function installReceiptExemptUnlistedCheckoutMapping(pool, fixture) {
  const retired = await pool.query(
    `UPDATE operations_commerce_variant_pack_mappings
     SET projection_state = 'stale',
         is_current = false,
         effective_to = GREATEST(
           now(), effective_from + interval '1 microsecond'
         ),
         row_version = row_version + 1,
         updated_at = now(),
         updated_by = $5
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND row_version = $3::bigint
       AND is_current = true
       AND projection_state = 'current'
     RETURNING id::text, row_version::text, $4::text AS captured_global_id`,
    [
      fixture.organizationId,
      fixture.commercePackMapping.id,
      fixture.commercePackMapping.row_version,
      fixture.commercePackMapping.global_id,
      fixture.email,
    ],
  )
  assert.equal(
    retired.rowCount,
    1,
    'Candidate-captured catalog mapping must retire as stale',
  )
  const channel = await pool.query(
    `SELECT
       state.source_revision, state.source_hash, state.pack_evidence_hash,
       state.normalized_status
     FROM operations_product_channel_states state
     WHERE state.organization_id = $1::uuid
       AND state.integration_account_id = $2::uuid
       AND state.product_id = $3::uuid
       AND state.provider = 'shopify'
     LIMIT 1`,
    [
      fixture.organizationId,
      fixture.commerceAccount.id,
      fixture.product.id,
    ],
  )
  assert.equal(
    channel.rows[0]?.normalized_status,
    'unlisted',
    'Late exact mapping fixture must retain the truthful UNLISTED channel',
  )

  // The checkout-mapping trigger's activation fences have their own dedicated
  // PostgreSQL acceptance. This fixture injects only the current exact mapping
  // needed to isolate the promoted-order cartonization read boundary.
  await pool.query(
    `ALTER TABLE operations_commerce_variant_pack_mappings
       DISABLE TRIGGER validate_operations_commerce_variant_pack_mapping`,
  )
  let mapping
  try {
    mapping = await pool.query(
      `INSERT INTO operations_commerce_variant_pack_mappings (
         organization_id, integration_account_id, pipeline_id, product_id,
         provider, external_product_id, external_variant_id,
         default_pack_profile_version_id, provider_lifecycle_state,
         projection_state, mapping_purpose, source_revision, source_hash,
         pack_evidence_hash, observed_at, is_current, created_by, updated_by
       )
       SELECT
         old.organization_id, old.integration_account_id,
         old.pipeline_id, old.product_id, old.provider,
         old.external_product_id, old.external_variant_id,
         old.default_pack_profile_version_id, $3,
         'current', 'shopify_checkout', $4, $5, $6,
         now(), true, $7, $7
       FROM operations_commerce_variant_pack_mappings old
       WHERE old.organization_id = $1::uuid
         AND old.id = $2::uuid
       RETURNING id::text, global_id, row_version::text`,
      [
        fixture.organizationId,
        fixture.commercePackMapping.id,
        channel.rows[0].normalized_status,
        channel.rows[0].source_revision,
        channel.rows[0].source_hash,
        channel.rows[0].pack_evidence_hash,
        fixture.email,
      ],
    )
  } finally {
    await pool.query(
      `ALTER TABLE operations_commerce_variant_pack_mappings
         ENABLE TRIGGER validate_operations_commerce_variant_pack_mapping`,
    )
  }
  assert.equal(mapping.rowCount, 1)
  const receipts = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_shopify_checkout_rate_current_reconciliations
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND order_candidate_id = $3::uuid`,
    [
      fixture.organizationId,
      fixture.commerceAccount.id,
      fixture.candidate.id,
    ],
  )
  assert.equal(
    receipts.rows[0].count,
    0,
    'Receipt-exempt fixture must not invent checkout reconciliation',
  )
  return {
    mapping: mapping.rows[0],
    retiredCapture: retired.rows[0],
  }
}

async function appendShopifyInventoryReconciliation(
  pool,
  fixture,
  {
    availableQuantity = 8,
    committedQuantity = 2,
  } = {},
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const sourceResult = await client.query(
      `SELECT
         run.integration_account_id::text,
         run.location_mapping_id::text,
         run.warehouse_id::text,
         run.location_id::text,
         run.inventory_pool_id::text,
         run.provider_location_id,
         run.provider_location_name,
         run.adapter_version,
         run.credential_version,
         run.completed_at,
         level.pipeline_id::text,
         level.product_id::text,
         level.inventory_position_id::text,
         level.external_inventory_item_id,
         level.sku,
         level.provider_weight_grams,
         level.provider_dimensions_mm,
         level.product_snapshot
       FROM operations_commerce_inventory_sync_runs run
       JOIN operations_commerce_inventory_levels level
         ON level.organization_id = run.organization_id
        AND level.integration_account_id = run.integration_account_id
        AND level.sync_run_id = run.id
       WHERE run.organization_id = $1::uuid
         AND run.id = $2::uuid
         AND level.id = $3::uuid
         AND level.inventory_position_id = $4::uuid`,
      [
        fixture.organizationId,
        fixture.inventoryRun.id,
        fixture.inventoryLevel.id,
        fixture.inventoryPosition.id,
      ],
    )
    assert.equal(sourceResult.rowCount, 1)
    const source = sourceResult.rows[0]
    const suffix = randomUUID().slice(0, 8)
    const evidenceTimestamp = new Date(
      new Date(source.completed_at).getTime() + 1000,
    ).toISOString()
    const onHandQuantity = availableQuantity + committedQuantity

    const attemptResult = await client.query(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state,
         completed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'inventory_read', $3,
         $4, $5, $6, '{}'::jsonb, '{}'::jsonb, 'succeeded',
         $7::timestamptz, $8
       )
       RETURNING id::text`,
      [
        fixture.organizationId,
        source.integration_account_id,
        source.adapter_version,
        source.provider_location_id,
        `inventory-attempt-latest-${suffix}`,
        sha(`inventory-attempt-latest-${suffix}`),
        evidenceTimestamp,
        fixture.email,
      ],
    )
    const providerAttemptId = attemptResult.rows[0].id
    const snapshotHash = sha(`inventory-snapshot-latest-${suffix}`)
    const capturedSnapshot = JSON.stringify({
      fixture: 'canonical-latest-provider-commitment',
      availableQuantity,
      committedQuantity,
      onHandQuantity,
    })
    const captureResult = await client.query(
      `INSERT INTO operations_commerce_inventory_captures (
         organization_id, integration_account_id, provider_attempt_id,
         warehouse_id, location_id, provider, adapter_version,
         credential_version, request_hash, snapshot_hash,
         provider_location_id, provider_fetched_at, level_count,
         captured_snapshot, snapshot_bytes, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         'shopify', $6, $7, $8, $9,
         $10, $11::timestamptz, 1, $12::jsonb, $13, $14
       )
       RETURNING id::text`,
      [
        fixture.organizationId,
        source.integration_account_id,
        providerAttemptId,
        source.warehouse_id,
        source.location_id,
        source.adapter_version,
        source.credential_version,
        sha(`inventory-request-latest-${suffix}`),
        snapshotHash,
        source.provider_location_id,
        evidenceTimestamp,
        capturedSnapshot,
        Buffer.byteLength(capturedSnapshot, 'utf8'),
        fixture.email,
      ],
    )

    await client.query(
      `SELECT set_config('clawpilot.shopify_inventory_sync', 'on', true)`,
    )
    const positionResult = await client.query(
      `UPDATE operations_inventory_positions
       SET on_hand_quantity = $3,
           reserved_quantity = $4,
           version = version + 1,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
       RETURNING on_hand_quantity::text, reserved_quantity::text`,
      [
        fixture.organizationId,
        fixture.inventoryPosition.id,
        onHandQuantity,
        committedQuantity,
      ],
    )
    assert.deepEqual(positionResult.rows[0], {
      on_hand_quantity: `${onHandQuantity}.000000`,
      reserved_quantity: `${committedQuantity}.000000`,
    })

    const runResult = await client.query(
      `INSERT INTO operations_commerce_inventory_sync_runs (
         organization_id, integration_account_id, provider_attempt_id,
         capture_id, location_mapping_id, warehouse_id, location_id,
         inventory_pool_id, provider, adapter_version, credential_version,
         idempotency_key, request_hash, snapshot_hash, status,
         provider_location_id, provider_location_name, provider_fetched_at,
         levels_seen, levels_mapped, levels_projected, levels_unmapped,
         levels_untracked, negative_available_levels,
         equation_mismatch_levels, provider_available_quantity,
         provider_committed_quantity, provider_on_hand_quantity,
         operational_available_quantity, positions_created,
         positions_updated, positions_zeroed, created_by, completed_at,
         level_set_hash
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, $8::uuid,
         'shopify', $9, $10,
         $11, $12, $13, 'succeeded',
         $14, $15, $16::timestamptz,
         1, 1, 1, 0, 0, 0, 0,
         $17, $18, $19, $17, 0, 1, 0, $20, $16::timestamptz,
         $21
       )
       RETURNING id::text, global_id, level_set_hash`,
      [
        fixture.organizationId,
        source.integration_account_id,
        providerAttemptId,
        captureResult.rows[0].id,
        source.location_mapping_id,
        source.warehouse_id,
        source.location_id,
        source.inventory_pool_id,
        source.adapter_version,
        source.credential_version,
        `inventory-run-latest-${suffix}`,
        sha(`inventory-run-request-latest-${suffix}`),
        snapshotHash,
        source.provider_location_id,
        source.provider_location_name,
        evidenceTimestamp,
        availableQuantity,
        committedQuantity,
        onHandQuantity,
        fixture.email,
        sha(`inventory-level-set-latest-${suffix}`),
      ],
    )
    const run = runResult.rows[0]
    const levelResult = await client.query(
      `INSERT INTO operations_commerce_inventory_levels (
         organization_id, sync_run_id, integration_account_id,
         location_mapping_id, warehouse_id, location_id, inventory_pool_id,
         pipeline_id, product_id, inventory_position_id,
         provider_location_id, external_inventory_item_id, sku,
         tracked, mapping_state, projection_state,
         provider_available_quantity, provider_incoming_quantity,
         provider_committed_quantity, provider_damaged_quantity,
         provider_on_hand_quantity, provider_quality_control_quantity,
         provider_reserved_quantity, provider_safety_stock_quantity,
         provider_quantity_evidence, operational_available_quantity,
         equation_matches, provider_weight_grams, provider_dimensions_mm,
         product_snapshot, source_hash
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         $4::uuid, $5::uuid, $6::uuid, $7::uuid,
         $8::uuid, $9::uuid, $10::uuid,
         $11, $12, $13,
         true, 'mapped', 'projected',
         $14, 0, $15, 0, $16, 0, 0, 0,
         $17::jsonb, $14, true, $18, $19::jsonb,
         $20::jsonb, $21
       )
       RETURNING id::text, global_id`,
      [
        fixture.organizationId,
        run.id,
        source.integration_account_id,
        source.location_mapping_id,
        source.warehouse_id,
        source.location_id,
        source.inventory_pool_id,
        source.pipeline_id,
        source.product_id,
        source.inventory_position_id,
        source.provider_location_id,
        source.external_inventory_item_id,
        source.sku,
        availableQuantity,
        committedQuantity,
        onHandQuantity,
        JSON.stringify({
          available: availableQuantity,
          committed: committedQuantity,
          onHand: onHandQuantity,
        }),
        source.provider_weight_grams,
        JSON.stringify(source.provider_dimensions_mm),
        JSON.stringify(source.product_snapshot),
        sha(`inventory-level-latest-${suffix}`),
      ],
    )
    await client.query('COMMIT')
    return {
      run,
      level: levelResult.rows[0],
      onHandQuantity,
      committedQuantity,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function appendUnchangedShopifyInventoryObservation(
  pool,
  fixture,
  sourceRunId,
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const sourceResult = await client.query(
      `SELECT run.*
       FROM operations_commerce_inventory_sync_runs run
       WHERE run.organization_id = $1::uuid
         AND run.id = $2::uuid
         AND run.status = 'succeeded'
         AND run.source_level_set_run_id IS NULL
         AND run.level_set_hash IS NOT NULL`,
      [fixture.organizationId, sourceRunId],
    )
    assert.equal(sourceResult.rowCount, 1)
    const source = sourceResult.rows[0]
    const suffix = randomUUID().slice(0, 8)
    const evidenceTimestamp = new Date(
      new Date(source.completed_at).getTime() + 1000,
    ).toISOString()
    const attemptResult = await client.query(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state,
         completed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'inventory_read', $3,
         $4, $5, $6, '{}'::jsonb, '{}'::jsonb, 'succeeded',
         $7::timestamptz, $8
       )
       RETURNING id::text`,
      [
        fixture.organizationId,
        source.integration_account_id,
        source.adapter_version,
        source.provider_location_id,
        `inventory-attempt-unchanged-${suffix}`,
        sha(`inventory-attempt-unchanged-${suffix}`),
        evidenceTimestamp,
        fixture.email,
      ],
    )
    const capturedSnapshot = JSON.stringify({
      fixture: 'canonical-unchanged-provider-commitment',
      snapshotHash: source.snapshot_hash,
    })
    const captureResult = await client.query(
      `INSERT INTO operations_commerce_inventory_captures (
         organization_id, integration_account_id, provider_attempt_id,
         warehouse_id, location_id, provider, adapter_version,
         credential_version, request_hash, snapshot_hash,
         provider_location_id, provider_fetched_at, level_count,
         captured_snapshot, snapshot_bytes, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         'shopify', $6, $7, $8, $9,
         $10, $11::timestamptz, $12, $13::jsonb, $14, $15
       )
       RETURNING id::text`,
      [
        fixture.organizationId,
        source.integration_account_id,
        attemptResult.rows[0].id,
        source.warehouse_id,
        source.location_id,
        source.adapter_version,
        source.credential_version,
        sha(`inventory-request-unchanged-${suffix}`),
        source.snapshot_hash,
        source.provider_location_id,
        evidenceTimestamp,
        source.levels_seen,
        capturedSnapshot,
        Buffer.byteLength(capturedSnapshot, 'utf8'),
        fixture.email,
      ],
    )
    const aliasResult = await client.query(
      `INSERT INTO operations_commerce_inventory_sync_runs (
         organization_id, integration_account_id, provider_attempt_id,
         capture_id, location_mapping_id, warehouse_id, location_id,
         inventory_pool_id, provider, adapter_version, credential_version,
         idempotency_key, request_hash, snapshot_hash, status,
         provider_location_id, provider_location_name, provider_fetched_at,
         levels_seen, levels_mapped, levels_projected, levels_unmapped,
         levels_untracked, negative_available_levels,
         equation_mismatch_levels, provider_available_quantity,
         provider_committed_quantity, provider_on_hand_quantity,
         operational_available_quantity, positions_created,
         positions_updated, positions_zeroed, provider_writes,
         order_quantity_adjustment, created_by, completed_at,
         level_set_hash, source_level_set_run_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, $8::uuid,
         'shopify', $9, $10, $11, $12, $13, 'succeeded',
         $14, $15, $16::timestamptz,
         $17, $18, $19, $20, $21, $22, $23,
         $24, $25, $26, $27, 0, 0, 0, 0, 0, $28,
         $16::timestamptz, $29, $30::uuid
       )
       RETURNING id::text, global_id, source_level_set_run_id::text`,
      [
        fixture.organizationId,
        source.integration_account_id,
        attemptResult.rows[0].id,
        captureResult.rows[0].id,
        source.location_mapping_id,
        source.warehouse_id,
        source.location_id,
        source.inventory_pool_id,
        source.adapter_version,
        source.credential_version,
        `inventory-run-unchanged-${suffix}`,
        sha(`inventory-run-request-unchanged-${suffix}`),
        source.snapshot_hash,
        source.provider_location_id,
        source.provider_location_name,
        evidenceTimestamp,
        source.levels_seen,
        source.levels_mapped,
        source.levels_projected,
        source.levels_unmapped,
        source.levels_untracked,
        source.negative_available_levels,
        source.equation_mismatch_levels,
        source.provider_available_quantity,
        source.provider_committed_quantity,
        source.provider_on_hand_quantity,
        source.operational_available_quantity,
        fixture.email,
        source.level_set_hash,
        source.id,
      ],
    )
    await client.query('COMMIT')
    return { run: aliasResult.rows[0] }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function canonicalPlanningState(pool, fixture) {
  const result = await pool.query(
    `SELECT
       orders.status,
       orders.row_version::int,
       plan.global_id AS plan_global_id,
       plan.status AS plan_status,
       plan.cartonization_evidence_id::text AS plan_evidence_id,
       plan.estimated_cost_minor::int,
       plan.estimated_revenue_minor::int,
       plan.estimated_margin_minor::int,
       plan.explanation,
       count(DISTINCT package.id)::int AS package_count,
       count(DISTINCT content.id)::int AS package_content_count,
       (SELECT COALESCE(sum(plan_content.quantity), 0)::text
        FROM operations_package_contents plan_content
        JOIN operations_packages content_package
          ON content_package.organization_id = plan_content.organization_id
         AND content_package.id = plan_content.package_id
        WHERE plan_content.organization_id = orders.organization_id
          AND content_package.plan_id = plan.id)
         AS package_content_quantity,
       count(DISTINCT reservation.id)::int AS reservation_count,
       min(reservation.reservation_authority) AS reservation_authority,
       min(reservation.provider_inventory_sync_run_id::text)
         AS reservation_inventory_run_id,
       min(reservation.provider_inventory_level_id::text)
         AS reservation_inventory_level_id,
       (SELECT count(*)::int
        FROM operations_packaging_material_claims claim
        WHERE claim.organization_id = plan.organization_id
          AND claim.plan_id = plan.id) AS packaging_claim_count,
       (SELECT COALESCE(sum(claim.quantity), 0)::int
        FROM operations_packaging_material_claims claim
        WHERE claim.organization_id = plan.organization_id
          AND claim.plan_id = plan.id
          AND claim.status = 'active') AS active_packaging_claim_quantity,
       (SELECT min(claim.status)
        FROM operations_packaging_material_claims claim
        WHERE claim.organization_id = plan.organization_id
          AND claim.plan_id = plan.id) AS packaging_claim_status,
       (SELECT min(stock.on_hand_quantity)::int
        FROM operations_packaging_material_claims claim
        JOIN operations_packaging_material_stock stock
          ON stock.organization_id = claim.organization_id
         AND stock.id = claim.packaging_material_stock_id
        WHERE claim.organization_id = plan.organization_id
          AND claim.plan_id = plan.id) AS packaging_stock_on_hand_quantity,
       count(DISTINCT allocation.id)::int AS allocation_count,
       count(DISTINCT rate.id) FILTER (WHERE rate.selected)::int
         AS selected_rate_count,
       min(rate.carrier) FILTER (WHERE rate.selected) AS selected_carrier,
       min(rate.service_code) FILTER (WHERE rate.selected)
         AS selected_service_code,
       (min(rate.internal_cost_minor)
         FILTER (WHERE rate.selected))::int AS selected_cost_minor,
       (min(rate.customer_charge_minor)
         FILTER (WHERE rate.selected))::int AS selected_charge_minor,
       position.on_hand_quantity::text,
       position.reserved_quantity::text,
       (SELECT count(*)::int
        FROM operations_inventory_ledger ledger
        WHERE ledger.organization_id = orders.organization_id
          AND ledger.position_id = position.id) AS ledger_count,
       (SELECT count(*)::int
        FROM operations_labels label
        JOIN operations_packages label_package
          ON label_package.organization_id = label.organization_id
         AND label_package.id = label.package_id
        WHERE label.organization_id = orders.organization_id
          AND label_package.plan_id = plan.id) AS label_count,
       (SELECT count(*)::int
        FROM operations_label_attempts attempt
        JOIN operations_packages attempt_package
          ON attempt_package.organization_id = attempt.organization_id
         AND attempt_package.id = attempt.package_id
        WHERE attempt.organization_id = orders.organization_id
          AND attempt_package.plan_id = plan.id) AS label_attempt_count,
       (SELECT count(*)::int
        FROM operations_shipments shipment
        WHERE shipment.organization_id = orders.organization_id
          AND shipment.order_id = orders.id) AS shipment_count,
       (SELECT count(*)::int
        FROM operations_commerce_fulfillment_exports export
        WHERE export.organization_id = orders.organization_id
          AND export.order_id = orders.id) AS fulfillment_export_count,
       (SELECT count(*)::int
        FROM operations_commerce_external_effect_intents intent
        WHERE intent.organization_id = orders.organization_id)
         AS provider_effect_intent_count,
       (SELECT count(*)::int
        FROM operations_print_artifacts artifact
        WHERE artifact.organization_id = orders.organization_id
          AND artifact.source_order_id = orders.id) AS print_artifact_count
     FROM operations_orders orders
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = orders.organization_id
      AND plan.order_id = orders.id
     JOIN operations_packages package
       ON package.organization_id = plan.organization_id
      AND package.plan_id = plan.id
     JOIN operations_package_contents content
       ON content.organization_id = package.organization_id
      AND content.package_id = package.id
     JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = plan.organization_id
      AND allocation.plan_id = plan.id
     JOIN operations_reservations reservation
       ON reservation.organization_id = allocation.organization_id
      AND reservation.id = allocation.reservation_id
     JOIN operations_carrier_rates rate
       ON rate.organization_id = plan.organization_id
      AND rate.plan_id = plan.id
     JOIN operations_inventory_positions position
       ON position.organization_id = reservation.organization_id
      AND position.id = reservation.position_id
     WHERE orders.organization_id = $1::uuid
       AND orders.global_id = $2
     GROUP BY orders.id, plan.id, position.id`,
    [fixture.organizationId, fixture.order.global_id],
  )
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

async function verifyLatestProviderCommitmentRelease(
  pool,
  operations,
  hybridCartonizationPersistence,
) {
  const fixture = await seedCanonicalPlanningFixture(pool, {
    checkoutServiceCode: 'clawpilot:dev:test-zero',
    shopifyUnlistedChannel: true,
    packagingStockOnHand: 10,
  })
  const planned = await operations.planOperationsOrderFromPostgres({
    organizationId: fixture.organizationId,
    actorEmail: fixture.email,
    orderGlobalId: fixture.order.global_id,
    cartonizationEvidenceGlobalId: fixture.evidence.global_id,
    expectedRowVersion: Number(fixture.order.row_version),
    reason: 'Plan against immutable provider commitment evidence',
    idempotencyKey: `canonical-latest-plan-${randomUUID()}`,
  })
  const originalState = await canonicalPlanningState(pool, fixture)
  assert.equal(originalState.reservation_authority, 'provider_commitment')
  assert.equal(
    originalState.reservation_inventory_run_id,
    fixture.inventoryRun.id,
  )
  assert.equal(
    originalState.reservation_inventory_level_id,
    fixture.inventoryLevel.id,
  )
  const beforeCounts = await pool.query(
    `SELECT
       count(DISTINCT reservation.id)::int AS reservations,
       count(DISTINCT allocation.id)::int AS allocations,
       count(ledger.id) FILTER (
         WHERE ledger.source_authority = 'clawpilot'
       )::int AS local_ledger_rows,
       COALESCE(sum(ledger.reserved_delta) FILTER (
         WHERE ledger.source_authority = 'clawpilot'
       ), 0)::text AS local_reserved_delta
     FROM operations_fulfillment_plans plan
     JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = plan.organization_id
      AND allocation.plan_id = plan.id
     JOIN operations_reservations reservation
       ON reservation.organization_id = allocation.organization_id
      AND reservation.id = allocation.reservation_id
     LEFT JOIN operations_inventory_ledger ledger
       ON ledger.organization_id = reservation.organization_id
      AND ledger.position_id = reservation.position_id
     WHERE plan.organization_id = $1::uuid
       AND plan.global_id = $2`,
    [fixture.organizationId, planned.fulfillmentPlanGlobalId],
  )
  assert.deepEqual(beforeCounts.rows[0], {
    reservations: 1,
    allocations: 1,
    local_ledger_rows: 0,
    local_reserved_delta: '0',
  })

  const latest = await appendShopifyInventoryReconciliation(pool, fixture)
  const unchanged = await appendUnchangedShopifyInventoryObservation(
    pool,
    fixture,
    latest.run.id,
  )
  const supportResult = await pool.query(
    `SELECT reservation.id::text AS reservation_id,
            support.supported,
            support.reason_code,
            support.latest_inventory_sync_run_global_id
              AS latest_sync_run_global_id
     FROM operations_reservations reservation
     CROSS JOIN LATERAL operations_provider_commitment_current_support(
       reservation.organization_id,
       reservation.id
     ) support
     WHERE reservation.organization_id = $1::uuid
       AND reservation.order_id = $2::uuid
       AND reservation.reservation_authority = 'provider_commitment'`,
    [fixture.organizationId, fixture.order.id],
  )
  assert.equal(supportResult.rowCount, 1)
  assert.equal(supportResult.rows[0].supported, true)
  assert.equal(supportResult.rows[0].reason_code, 'OK')
  assert.equal(
    supportResult.rows[0].latest_sync_run_global_id,
    unchanged.run.global_id,
  )
  await installReceiptExemptUnlistedCheckoutMapping(pool, fixture)
  await assert.rejects(
    () => hybridCartonizationPersistence
      .readHybridCartonizationInputFromPostgres({
        organizationId: fixture.organizationId,
        accountGlobalId: fixture.commerceAccount.global_id,
        candidateGlobalId: fixture.candidate.global_id,
        expectedCandidateRowVersion: Number(fixture.candidate.row_version),
        warehouseGlobalId: fixture.warehouse.global_id,
        mode: 'production',
        selectedMaterials: [{
          materialGlobalId: fixture.material.global_id,
          expectedRowVersion: Number(fixture.material.row_version),
        }],
        assumedCommittedQuantities: [],
      }),
    (error) => {
      assert.equal(
        error.code,
        'HYBRID_CARTONIZATION_INVENTORY_INSUFFICIENT',
      )
      return true
    },
    'A reservation tied to the prior Shopify sync must still consume the current level commitment through its stable position',
  )

  const released = await operations.releaseOperationsOrderFromPostgres({
    organizationId: fixture.organizationId,
    actorEmail: fixture.email,
    orderGlobalId: fixture.order.global_id,
    expectedRowVersion: planned.rowVersion,
    reason: 'Release with sufficient current provider commitment support',
    idempotencyKey: `canonical-latest-release-${randomUUID()}`,
  })
  assert.equal(released.orderStatus, 'released')
  const after = await pool.query(
    `SELECT
       count(DISTINCT reservation.id)::int AS reservations,
       count(DISTINCT allocation.id)::int AS allocations,
       min(reservation.status) AS reservation_status,
       min(reservation.provider_inventory_sync_run_id::text)
         AS reservation_inventory_run_id,
       min(reservation.provider_inventory_level_id::text)
         AS reservation_inventory_level_id,
       min(position.on_hand_quantity)::text AS on_hand_quantity,
       min(position.reserved_quantity)::text AS reserved_quantity,
       count(ledger.id) FILTER (
         WHERE ledger.source_authority = 'clawpilot'
       )::int AS local_ledger_rows,
       COALESCE(sum(ledger.reserved_delta) FILTER (
         WHERE ledger.source_authority = 'clawpilot'
       ), 0)::text AS local_reserved_delta
     FROM operations_fulfillment_plans plan
     JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = plan.organization_id
      AND allocation.plan_id = plan.id
     JOIN operations_reservations reservation
       ON reservation.organization_id = allocation.organization_id
      AND reservation.id = allocation.reservation_id
     JOIN operations_inventory_positions position
       ON position.organization_id = reservation.organization_id
      AND position.id = reservation.position_id
     LEFT JOIN operations_inventory_ledger ledger
       ON ledger.organization_id = reservation.organization_id
      AND ledger.position_id = reservation.position_id
     WHERE plan.organization_id = $1::uuid
       AND plan.global_id = $2`,
    [fixture.organizationId, planned.fulfillmentPlanGlobalId],
  )
  assert.deepEqual(after.rows[0], {
    reservations: 1,
    allocations: 1,
    reservation_status: 'active',
    reservation_inventory_run_id: fixture.inventoryRun.id,
    reservation_inventory_level_id: fixture.inventoryLevel.id,
    on_hand_quantity: `${latest.onHandQuantity}.000000`,
    reserved_quantity: `${latest.committedQuantity}.000000`,
    local_ledger_rows: 0,
    local_reserved_delta: '0',
  })
  const releaseEvent = await pool.query(
    `SELECT payload
     FROM operations_domain_events
     WHERE organization_id = $1::uuid
       AND aggregate_id = $2::uuid
       AND event_type = 'operations.wave.released'
     ORDER BY occurred_at DESC, id DESC
     LIMIT 1`,
    [fixture.organizationId, fixture.order.id],
  )
  assert.equal(releaseEvent.rowCount, 1)
  assert.equal(
    releaseEvent.rows[0].payload.providerCommitmentsRevalidated,
    1,
  )
  assert.deepEqual(
    releaseEvent.rows[0].payload
      .providerCommitmentInventorySyncRunGlobalIds,
    [unchanged.run.global_id],
  )

  const consumed = await pool.query(
    `UPDATE operations_reservations
     SET status = 'consumed', released_at = now()
     WHERE organization_id = $1::uuid
       AND order_id = $2::uuid
       AND reservation_authority = 'provider_commitment'
       AND status = 'active'
     RETURNING status, provider_inventory_sync_run_id::text,
               provider_inventory_level_id::text`,
    [fixture.organizationId, fixture.order.id],
  )
  assert.deepEqual(consumed.rows[0], {
    status: 'consumed',
    provider_inventory_sync_run_id: fixture.inventoryRun.id,
    provider_inventory_level_id: fixture.inventoryLevel.id,
  })

  const undercoveredFixture = await seedCanonicalPlanningFixture(pool)
  await operations.planOperationsOrderFromPostgres({
    organizationId: undercoveredFixture.organizationId,
    actorEmail: undercoveredFixture.email,
    orderGlobalId: undercoveredFixture.order.global_id,
    cartonizationEvidenceGlobalId: undercoveredFixture.evidence.global_id,
    expectedRowVersion: Number(undercoveredFixture.order.row_version),
    reason: 'Exercise the provider commitment undercoverage guard',
    idempotencyKey: `canonical-undercoverage-plan-${randomUUID()}`,
  })
  const undercoverageClient = await pool.connect()
  try {
    await undercoverageClient.query('BEGIN')
    await undercoverageClient.query(
      `SELECT set_config(
         'clawpilot.shopify_inventory_sync',
         'on',
         true
       )`,
    )
    await undercoverageClient.query('SAVEPOINT provider_undercoverage')
    await assert.rejects(
      () => undercoverageClient.query(
        `UPDATE operations_inventory_positions
         SET on_hand_quantity = 9,
             reserved_quantity = 1,
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [
          undercoveredFixture.organizationId,
          undercoveredFixture.inventoryPosition.id,
        ],
      ),
      /provider commitment|Shopify committed|active provider/i,
    )
    await undercoverageClient.query(
      'ROLLBACK TO SAVEPOINT provider_undercoverage',
    )
    const protectedPosition = await undercoverageClient.query(
      `SELECT on_hand_quantity::text, reserved_quantity::text
       FROM operations_inventory_positions
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [
        undercoveredFixture.organizationId,
        undercoveredFixture.inventoryPosition.id,
      ],
    )
    assert.deepEqual(protectedPosition.rows[0], {
      on_hand_quantity: '10.000000',
      reserved_quantity: '2.000000',
    })
    await undercoverageClient.query('ROLLBACK')
  } catch (error) {
    await undercoverageClient.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    undercoverageClient.release()
  }
}

async function verifyPackagingClaimConcurrency(pool) {
  const fixture = await seedCanonicalPlanningFixture(pool, {
    packagingStockOnHand: 1,
  })
  await pool.query(
    `ALTER TABLE operations_fulfillment_plans
     DISABLE TRIGGER validate_ops_plan_cartonization_evidence`,
  )
  let planResult
  try {
    planResult = await pool.query(
      `INSERT INTO operations_fulfillment_plans (
         organization_id, order_id, warehouse_id, version_number,
         status, method, solver_status, promised_delivery_at,
         explanation, created_by
       ) VALUES
         (
           $1::uuid, $2::uuid, $3::uuid, 101,
           'planned', 'manual_override', 'claim_race_a', now(),
           '{"acceptance":"packaging-claim-race-a"}'::jsonb, $4
         ),
         (
           $1::uuid, $2::uuid, $3::uuid, 102,
           'planned', 'manual_override', 'claim_race_b', now(),
           '{"acceptance":"packaging-claim-race-b"}'::jsonb, $4
         )
       RETURNING id::text`,
      [
        fixture.organizationId,
        fixture.order.id,
        fixture.warehouse.id,
        fixture.email,
      ],
    )
  } finally {
    await pool.query(
      `ALTER TABLE operations_fulfillment_plans
       ENABLE TRIGGER validate_ops_plan_cartonization_evidence`,
    )
  }
  assert.equal(planResult.rowCount, 2)
  const warehouseId = fixture.warehouse.id
  const race = await Promise.allSettled(
    planResult.rows.map((plan) => pool.query(
      `INSERT INTO operations_packaging_material_claims (
         organization_id, plan_id, packaging_material_id,
         warehouse_id, packaging_material_stock_id, quantity,
         status, stock_row_version_at_claim,
         on_hand_quantity_at_claim, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         $4::uuid, $5::uuid, 1,
         'active', $6, $7, $8, $8
       )
       RETURNING id::text, plan_id::text`,
      [
        fixture.organizationId,
        plan.id,
        fixture.material.id,
        warehouseId,
        fixture.packagingStock.id,
        Number(fixture.packagingStock.row_version),
        fixture.packagingStock.on_hand_quantity,
        fixture.email,
      ],
    )),
  )
  const succeeded = race.filter((result) => result.status === 'fulfilled')
  const rejected = race.filter((result) => result.status === 'rejected')
  assert.equal(succeeded.length, 1)
  assert.equal(rejected.length, 1)
  assert.match(
    String(rejected[0].reason?.message || rejected[0].reason),
    /Active packaging material claims exceed physical on-hand stock/,
  )
  const winningClaim = succeeded[0].value.rows[0]
  const losingPlan = planResult.rows.find(
    (plan) => plan.id !== winningClaim.plan_id,
  )
  assert.ok(losingPlan)
  const afterRace = await pool.query(
    `SELECT
       count(*) FILTER (WHERE claim.status = 'active')::int AS active_claims,
       COALESCE(sum(claim.quantity)
         FILTER (WHERE claim.status = 'active'), 0)::int AS active_quantity,
       min(stock.on_hand_quantity)::int AS on_hand_quantity
     FROM operations_packaging_material_claims claim
     JOIN operations_packaging_material_stock stock
       ON stock.organization_id = claim.organization_id
      AND stock.id = claim.packaging_material_stock_id
     WHERE claim.organization_id = $1::uuid
       AND claim.packaging_material_stock_id = $2::uuid`,
    [fixture.organizationId, fixture.packagingStock.id],
  )
  assert.deepEqual(afterRace.rows[0], {
    active_claims: 1,
    active_quantity: 1,
    on_hand_quantity: 1,
  })
  await pool.query(
    `UPDATE operations_packaging_material_claims
     SET status = 'released', released_at = now(),
         updated_by = $3, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, winningClaim.id, fixture.email],
  )
  const replacement = await pool.query(
    `INSERT INTO operations_packaging_material_claims (
       organization_id, plan_id, packaging_material_id,
       warehouse_id, packaging_material_stock_id, quantity,
       status, stock_row_version_at_claim,
       on_hand_quantity_at_claim, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       $4::uuid, $5::uuid, 1,
       'active', $6, $7, $8, $8
     )
     RETURNING id::text`,
    [
      fixture.organizationId,
      losingPlan.id,
      fixture.material.id,
      warehouseId,
      fixture.packagingStock.id,
      Number(fixture.packagingStock.row_version),
      fixture.packagingStock.on_hand_quantity,
      fixture.email,
    ],
  )
  assert.equal(replacement.rowCount, 1)
  await assert.rejects(
    () => pool.query(
      `UPDATE operations_packaging_material_claims
       SET status = 'active', released_at = NULL,
           updated_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, winningClaim.id, fixture.email],
    ),
    /Packaging material claim lifecycle is terminal/,
  )
  const lifecycleState = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status = 'active')::int AS active_claims,
       count(*) FILTER (WHERE status = 'released')::int AS released_claims,
       (SELECT on_hand_quantity
        FROM operations_packaging_material_stock
        WHERE organization_id = $1::uuid AND id = $2::uuid)
         AS on_hand_quantity
     FROM operations_packaging_material_claims
     WHERE organization_id = $1::uuid
       AND packaging_material_stock_id = $2::uuid`,
    [fixture.organizationId, fixture.packagingStock.id],
  )
  assert.deepEqual(lifecycleState.rows[0], {
    active_claims: 1,
    released_claims: 1,
    on_hand_quantity: 1,
  })
}

async function verifyPlanningAfterCancelledGeneration(pool, operations) {
  const fixture = await seedCanonicalPlanningFixture(pool, {
    activationState: 'active',
    carrierReadEnvironment: 'production',
  })
  const cancelledPlan = await pool.query(
    `INSERT INTO operations_fulfillment_plans (
       organization_id, order_id, warehouse_id, version_number,
       status, method, solver_status, fallback_reason,
       estimated_cost_minor, estimated_revenue_minor,
       estimated_margin_minor, promised_delivery_at,
       explanation, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 1,
       'cancelled', 'manual_override', 'cancelled_before_execution',
       'Manager reopened the prior operational plan',
       0, NULL, NULL, now() + interval '3 days',
       '{"version":"canonical-fulfillment-plan-v1","planGeneration":1,"cancelledBeforeExecution":true}'::jsonb,
       $4
     )
     RETURNING id::text, global_id`,
    [
      fixture.organizationId,
      fixture.order.id,
      fixture.warehouse.id,
      fixture.email,
    ],
  )
  assert.equal(cancelledPlan.rowCount, 1)

  const idempotencyKey = `canonical-replan-v2-${randomUUID()}`
  const input = {
    organizationId: fixture.organizationId,
    actorEmail: fixture.email,
    orderGlobalId: fixture.order.global_id,
    cartonizationEvidenceGlobalId: fixture.evidence.global_id,
    expectedRowVersion: Number(fixture.order.row_version),
    reason: 'Create generation two after a cancelled operational plan',
    idempotencyKey,
  }
  const planned = await operations.planOperationsOrderFromPostgres(input)
  assert.equal(planned.replayed, false)
  assert.equal(planned.orderStatus, 'planned')
  assert.equal(planned.rowVersion, Number(fixture.order.row_version) + 1)
  assert.equal(planned.cartonizationEvidenceGlobalId, fixture.evidence.global_id)
  assert.notEqual(
    planned.fulfillmentPlanGlobalId,
    cancelledPlan.rows[0].global_id,
  )

  const generations = await pool.query(
    `SELECT plan.global_id,
            plan.version_number,
            plan.status,
            evidence.global_id AS evidence_global_id,
            (plan.explanation ->> 'planGeneration')::int
              AS explanation_generation
     FROM operations_fulfillment_plans plan
     LEFT JOIN operations_cartonization_rate_evidence evidence
       ON evidence.organization_id = plan.organization_id
      AND evidence.id = plan.cartonization_evidence_id
     WHERE plan.organization_id = $1::uuid
       AND plan.order_id = $2::uuid
     ORDER BY plan.version_number`,
    [fixture.organizationId, fixture.order.id],
  )
  assert.deepEqual(generations.rows, [
    {
      global_id: cancelledPlan.rows[0].global_id,
      version_number: 1,
      status: 'cancelled',
      evidence_global_id: null,
      explanation_generation: 1,
    },
    {
      global_id: planned.fulfillmentPlanGlobalId,
      version_number: 2,
      status: 'planned',
      evidence_global_id: fixture.evidence.global_id,
      explanation_generation: 2,
    },
  ])
  const orderState = await pool.query(
    `SELECT status, row_version::int
     FROM operations_orders
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, fixture.order.id],
  )
  assert.deepEqual(orderState.rows[0], {
    status: 'planned',
    row_version: Number(fixture.order.row_version) + 1,
  })

  const replayed = await operations.planOperationsOrderFromPostgres(input)
  assert.equal(replayed.replayed, true)
  assert.equal(
    replayed.fulfillmentPlanGlobalId,
    planned.fulfillmentPlanGlobalId,
  )
  const replayState = await pool.query(
    `SELECT count(*)::int AS plan_count,
            max(version_number)::int AS max_version
     FROM operations_fulfillment_plans
     WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
    [fixture.organizationId, fixture.order.id],
  )
  assert.deepEqual(replayState.rows[0], {
    plan_count: 2,
    max_version: 2,
  })
}

async function verifyLocalSplitPlanning(pool, operations) {
  const fixture = await seedCanonicalPlanningFixture(pool, {
    inventoryAuthority: 'clawpilot_split',
  })
  const planInput = {
    organizationId: fixture.organizationId,
    actorEmail: fixture.email,
    orderGlobalId: fixture.order.global_id,
    cartonizationEvidenceGlobalId: fixture.evidence.global_id,
    expectedRowVersion: Number(fixture.order.row_version),
    reason: 'Allocate one local line across pick-face and reserve stock',
    idempotencyKey: `canonical-local-split-${randomUUID()}`,
  }
  const planned = await operations.planOperationsOrderFromPostgres(planInput)
  assert.equal(planned.orderStatus, 'planned')
  assert.equal(planned.rowVersion, Number(fixture.order.row_version) + 1)

  const allocationResult = await pool.query(
    `SELECT
       allocation.id::text AS allocation_id,
       allocation.quantity::text AS allocation_quantity,
       reservation.id::text AS reservation_id,
       reservation.quantity::text AS reservation_quantity,
       reservation.status AS reservation_status,
       reservation.reservation_authority,
       reservation.provider_inventory_sync_run_id::text
         AS provider_inventory_sync_run_id,
       reservation.provider_inventory_level_id::text
         AS provider_inventory_level_id,
       position.id::text AS position_id,
       position.global_id AS position_global_id,
       position.lot_code,
       position.on_hand_quantity::text,
       position.reserved_quantity::text,
       position.damaged_quantity::text,
       location.pick_sequence,
       (
         SELECT count(*)::int
         FROM operations_inventory_ledger ledger
         WHERE ledger.organization_id = position.organization_id
           AND ledger.position_id = position.id
           AND ledger.event_type = 'reservation'
       ) AS reservation_ledger_count,
       (
         SELECT COALESCE(sum(ledger.reserved_delta), 0)::text
         FROM operations_inventory_ledger ledger
         WHERE ledger.organization_id = position.organization_id
           AND ledger.position_id = position.id
           AND ledger.event_type = 'reservation'
       ) AS reservation_ledger_delta
     FROM operations_fulfillment_plans plan
     JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = plan.organization_id
      AND allocation.plan_id = plan.id
     JOIN operations_reservations reservation
       ON reservation.organization_id = allocation.organization_id
      AND reservation.id = allocation.reservation_id
     JOIN operations_inventory_positions position
       ON position.organization_id = allocation.organization_id
      AND position.id = allocation.position_id
     JOIN operations_locations location
       ON location.organization_id = position.organization_id
      AND location.id = position.location_id
     WHERE plan.organization_id = $1::uuid
       AND plan.global_id = $2
     ORDER BY location.pick_sequence, position.global_id, allocation.id`,
    [fixture.organizationId, planned.fulfillmentPlanGlobalId],
  )
  assert.equal(allocationResult.rowCount, 2)
  assert.deepEqual(
    allocationResult.rows.map((row) => row.pick_sequence),
    [1, 2],
    'Local allocations must follow stable warehouse pick sequence',
  )
  assert.deepEqual(
    allocationResult.rows.map((row) => row.lot_code),
    ['PICK-FACE', 'RESERVE-CASE'],
  )
  assert.deepEqual(
    allocationResult.rows.map((row) => row.allocation_quantity),
    ['1.000000', '1.000000'],
  )
  assert.deepEqual(
    allocationResult.rows.map((row) => row.reservation_quantity),
    ['1.000000', '1.000000'],
  )
  assert.ok(allocationResult.rows.every((row) => (
    row.reservation_status === 'active'
    && row.reservation_authority === 'local_balance'
    && row.provider_inventory_sync_run_id === null
    && row.provider_inventory_level_id === null
    && row.reservation_ledger_count === 1
    && row.reservation_ledger_delta === '1.000000'
  )))
  assert.deepEqual(
    allocationResult.rows.map((row) => ({
      onHand: row.on_hand_quantity,
      reserved: row.reserved_quantity,
      damaged: row.damaged_quantity,
    })),
    [
      {
        onHand: '1.000000',
        reserved: '1.000000',
        damaged: '0.000000',
      },
      {
        onHand: '4.000000',
        reserved: '1.000000',
        damaged: '1.000000',
      },
    ],
    'Planning must reserve one whole unit in each position without consuming on-hand or damaged stock',
  )

  const conservation = await pool.query(
    `SELECT
       line.quantity::text AS ordered_quantity,
       COALESCE(sum(reservation.quantity), 0)::text
         AS reserved_quantity,
       COALESCE(sum(allocation.quantity), 0)::text
         AS allocated_quantity,
       (
         SELECT COALESCE(sum(content.quantity), 0)::text
         FROM operations_package_contents content
         JOIN operations_packages package
           ON package.organization_id = content.organization_id
          AND package.id = content.package_id
         WHERE package.organization_id = plan.organization_id
           AND package.plan_id = plan.id
           AND content.order_line_id = line.id
       ) AS packed_quantity
     FROM operations_fulfillment_plans plan
     JOIN operations_order_lines line
       ON line.organization_id = plan.organization_id
      AND line.order_id = plan.order_id
     JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = line.organization_id
      AND allocation.plan_id = plan.id
      AND allocation.order_line_id = line.id
     JOIN operations_reservations reservation
       ON reservation.organization_id = allocation.organization_id
      AND reservation.id = allocation.reservation_id
     WHERE plan.organization_id = $1::uuid
       AND plan.global_id = $2
     GROUP BY plan.id, line.id`,
    [fixture.organizationId, planned.fulfillmentPlanGlobalId],
  )
  assert.deepEqual(conservation.rows[0], {
    ordered_quantity: '2.000000',
    reserved_quantity: '2.000000',
    allocated_quantity: '2.000000',
    packed_quantity: '2.000000',
  })

  const replayed = await operations.planOperationsOrderFromPostgres(planInput)
  assert.equal(replayed.replayed, true)
  const replayCounts = await pool.query(
    `SELECT
       (SELECT count(*)::int
        FROM operations_reservations
        WHERE organization_id = $1::uuid
          AND order_id = $2::uuid) AS reservations,
       (SELECT count(*)::int
        FROM operations_fulfillment_allocations allocation
        JOIN operations_fulfillment_plans plan
          ON plan.organization_id = allocation.organization_id
         AND plan.id = allocation.plan_id
        WHERE plan.organization_id = $1::uuid
          AND plan.order_id = $2::uuid) AS allocations`,
    [fixture.organizationId, fixture.order.id],
  )
  assert.deepEqual(replayCounts.rows[0], {
    reservations: 2,
    allocations: 2,
  })

  const released = await operations.releaseOperationsOrderFromPostgres({
    organizationId: fixture.organizationId,
    actorEmail: fixture.email,
    orderGlobalId: fixture.order.global_id,
    expectedRowVersion: planned.rowVersion,
    reason: 'Release every local split allocation in pick order',
    idempotencyKey: `canonical-local-release-${randomUUID()}`,
  })
  assert.equal(released.orderStatus, 'released')
  const pickResult = await pool.query(
    `SELECT
       pick.sequence_number,
       pick.quantity::text AS pick_quantity,
       pick.status,
       location.pick_sequence,
       position.global_id AS position_global_id,
       allocation.quantity::text AS allocation_quantity,
       reservation.quantity::text AS reservation_quantity
     FROM operations_pick_tasks pick
     JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = pick.organization_id
      AND allocation.id = pick.allocation_id
     JOIN operations_inventory_positions position
       ON position.organization_id = allocation.organization_id
      AND position.id = allocation.position_id
     JOIN operations_locations location
       ON location.organization_id = position.organization_id
      AND location.id = position.location_id
     JOIN operations_reservations reservation
       ON reservation.organization_id = allocation.organization_id
      AND reservation.id = allocation.reservation_id
     WHERE pick.organization_id = $1::uuid
       AND pick.plan_id = (
         SELECT id
         FROM operations_fulfillment_plans
         WHERE organization_id = $1::uuid AND global_id = $2
       )
     ORDER BY pick.sequence_number`,
    [fixture.organizationId, planned.fulfillmentPlanGlobalId],
  )
  assert.equal(pickResult.rowCount, 2)
  assert.deepEqual(
    pickResult.rows.map((row) => ({
      sequence: row.sequence_number,
      route: row.pick_sequence,
      pick: row.pick_quantity,
      allocation: row.allocation_quantity,
      reservation: row.reservation_quantity,
      status: row.status,
    })),
    [
      {
        sequence: 1,
        route: 1,
        pick: '1.000000',
        allocation: '1.000000',
        reservation: '1.000000',
        status: 'ready',
      },
      {
        sequence: 2,
        route: 2,
        pick: '1.000000',
        allocation: '1.000000',
        reservation: '1.000000',
        status: 'ready',
      },
    ],
  )

  const picked = await operations.confirmOperationsOrderPicksFromPostgres({
    organizationId: fixture.organizationId,
    actorEmail: fixture.email,
    orderGlobalId: fixture.order.global_id,
    expectedRowVersion: released.rowVersion,
    reason: 'Confirm every local split pick without consuming inventory',
    idempotencyKey: `canonical-local-pick-${randomUUID()}`,
  })
  assert.equal(picked.orderStatus, 'picking')
  const pickedState = await pool.query(
    `SELECT
       position.lot_code,
       position.on_hand_quantity::text,
       position.reserved_quantity::text,
       reservation.status AS reservation_status,
       pick.status AS pick_status,
       pick.picked_quantity::text,
       count(ledger.id)::int AS ledger_count
     FROM operations_pick_tasks pick
     JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = pick.organization_id
      AND allocation.id = pick.allocation_id
     JOIN operations_reservations reservation
       ON reservation.organization_id = allocation.organization_id
      AND reservation.id = allocation.reservation_id
     JOIN operations_inventory_positions position
       ON position.organization_id = allocation.organization_id
      AND position.id = allocation.position_id
     LEFT JOIN operations_inventory_ledger ledger
       ON ledger.organization_id = position.organization_id
      AND ledger.position_id = position.id
     WHERE pick.organization_id = $1::uuid
       AND pick.plan_id = (
         SELECT id
         FROM operations_fulfillment_plans
         WHERE organization_id = $1::uuid AND global_id = $2
       )
     GROUP BY position.id, reservation.id, pick.id
     ORDER BY position.lot_code`,
    [fixture.organizationId, planned.fulfillmentPlanGlobalId],
  )
  assert.equal(pickedState.rowCount, 2)
  assert.ok(pickedState.rows.every((row) => (
    row.pick_status === 'picked'
    && row.picked_quantity === '1.000000'
    && row.reservation_status === 'active'
    && row.ledger_count === 2
  )))

  const shortageFixture = await seedCanonicalPlanningFixture(pool, {
    inventoryAuthority: 'clawpilot_split',
  })
  const reservePosition = shortageFixture.splitInventoryPositions.find(
    (position) => position.lot_code === 'RESERVE-CASE',
  )
  assert.ok(reservePosition)
  await pool.query(
    `UPDATE operations_inventory_positions
     SET damaged_quantity = on_hand_quantity
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [shortageFixture.organizationId, reservePosition.id],
  )
  await assert.rejects(
    () => operations.planOperationsOrderFromPostgres({
      organizationId: shortageFixture.organizationId,
      actorEmail: shortageFixture.email,
      orderGlobalId: shortageFixture.order.global_id,
      cartonizationEvidenceGlobalId:
        shortageFixture.evidence.global_id,
      expectedRowVersion: Number(shortageFixture.order.row_version),
      reason: 'Reject a line that cumulative usable stock cannot cover',
      idempotencyKey: `canonical-local-shortage-${randomUUID()}`,
    }),
    (error) => {
      assert.equal(error.code, 'OPERATIONS_INVENTORY_SHORTAGE')
      return true
    },
  )
  const shortageEffects = await pool.query(
    `SELECT
       orders.status,
       orders.row_version::text,
       (SELECT count(*)::int
        FROM operations_fulfillment_plans plan
        WHERE plan.organization_id = orders.organization_id
          AND plan.order_id = orders.id) AS plans,
       (SELECT count(*)::int
        FROM operations_reservations reservation
        WHERE reservation.organization_id = orders.organization_id
          AND reservation.order_id = orders.id) AS reservations,
       (SELECT count(*)::int
        FROM operations_fulfillment_allocations allocation
        JOIN operations_fulfillment_plans plan
          ON plan.organization_id = allocation.organization_id
         AND plan.id = allocation.plan_id
        WHERE plan.organization_id = orders.organization_id
          AND plan.order_id = orders.id) AS allocations,
       (SELECT count(*)::int
        FROM operations_inventory_ledger ledger
        JOIN operations_inventory_positions position
          ON position.organization_id = ledger.organization_id
         AND position.id = ledger.position_id
        WHERE position.organization_id = orders.organization_id
          AND position.product_id = line.product_id) AS ledger_rows,
       (SELECT COALESCE(sum(position.reserved_quantity), 0)::text
        FROM operations_inventory_positions position
        WHERE position.organization_id = orders.organization_id
          AND position.product_id = line.product_id) AS reserved_quantity
     FROM operations_orders orders
     JOIN operations_order_lines line
       ON line.organization_id = orders.organization_id
      AND line.order_id = orders.id
     WHERE orders.organization_id = $1::uuid
       AND orders.id = $2::uuid`,
    [shortageFixture.organizationId, shortageFixture.order.id],
  )
  assert.deepEqual(shortageEffects.rows[0], {
    status: 'imported',
    row_version: shortageFixture.order.row_version,
    plans: 0,
    reservations: 0,
    allocations: 0,
    ledger_rows: 0,
    reserved_quantity: '0.000000',
  })
}

async function verifyCanonicalPlanning(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    query_timeout: 30_000,
  })
  try {
    const postgres = postgresMock(pool)
    const auditWriter = {
      recordAuditEvent: async () => {},
    }
    const currency = loadTypeScriptModule('app_src/lib/currency.ts')
    const canonicalPlanning = loadTypeScriptModule(
      'app_src/lib/operations/canonicalFulfillmentPlanning.ts',
      { mocks: { '../currency.ts': currency } },
    )
    const stableId = loadTypeScriptModule('app_src/lib/crm/stableId.ts')
    const domain = loadTypeScriptModule('app_src/lib/operations/domain.ts')
    const pickManagement = loadTypeScriptModule(
      'app_src/lib/operations/pickManagement.ts',
    )
    const adapters = loadTypeScriptModule(
      'app_src/lib/operations/adapters.ts',
      { mocks: { '@/lib/operations/domain': domain } },
    )
    const packingSlip = loadTypeScriptModule(
      'app_src/lib/operations/packingSlip.ts',
    )
    const packagingMaterialsDomain = loadTypeScriptModule(
      'app_src/lib/operations/packagingMaterials.ts',
    )
    const commerceFulfillmentRecoveryPolicy = loadTypeScriptModule(
      'app_src/lib/commerceFulfillmentRecoveryPolicy.ts',
    )
    const fulfillmentOptimizerContract = loadTypeScriptModule(
      'app_src/lib/operations/fulfillmentOptimizerContract.ts',
    )
    const globalIds = await import(
      new URL('../app_src/lib/globalIds.mjs', import.meta.url)
    )
    const barcodeLabels = loadTypeScriptModule(
      'app_src/lib/operations/barcodeLabels.ts',
      { mocks: { '@/lib/globalIds.mjs': globalIds } },
    )
    const orderShipTo = loadTypeScriptModule(
      'app_src/lib/operations/orderShipTo.ts',
    )
    const orderListQuery = loadTypeScriptModule(
      'app_src/lib/operations/orderListQuery.ts',
    )
    const providerOrderMoney = loadTypeScriptModule(
      'app_src/lib/operations/providerOrderMoney.ts',
    )
    const providerOrderHistory = loadTypeScriptModule(
      'app_src/lib/operations/providerOrderHistory.ts',
    )
    const operationsOrderShipmentAddress = loadTypeScriptModule(
      'app_src/lib/persistence/operationsOrderShipmentAddress.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/integrations/carrierSandboxRate': {
            carrierSandboxPartyFingerprint: () => {
              throw new Error(
                'Canonical planning acceptance reads sealed address evidence only',
              )
            },
          },
          '@/lib/integrations/commerceCredentialCrypto': {
            decryptCommerceCandidateSnapshot: () => {
              throw new Error(
                'Canonical planning acceptance does not decrypt shipment-address overrides',
              )
            },
            encryptCommerceCandidateSnapshot: () => {
              throw new Error(
                'Canonical planning acceptance does not edit shipment-address overrides',
              )
            },
          },
          '@/lib/operations/orderShipTo': orderShipTo,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
    const cartonizationRateEvidence = loadTypeScriptModule(
      'app_src/lib/persistence/cartonizationRateEvidence.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/integrations/commerceCredentialCrypto': {
            decryptCommerceCandidateSnapshot: () => {
              throw new Error(
                'Canonical planning acceptance does not decrypt provider data',
              )
            },
          },
          '@/lib/integrations/carrierSandboxRate': {
            carrierSandboxPartyFingerprint: () => {
              throw new Error(
                'Canonical planning acceptance reads sealed evidence only',
              )
            },
            normalizeCarrierSandboxParty: (value) => value,
          },
          '@/lib/operations/fulfillmentOptimizerContract':
            fulfillmentOptimizerContract,
          '@/lib/operations/orderShipTo': orderShipTo,
          '@/lib/persistence/operationsOrderShipmentAddress':
            operationsOrderShipmentAddress,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
    const shopifyCheckoutChannelEligibility = loadTypeScriptModule(
      'app_src/lib/integrations/shopifyCheckoutChannelEligibility.ts',
    )
    const hybridCartonizationPersistence = loadTypeScriptModule(
      'app_src/lib/persistence/hybridCartonization.ts',
      {
        mocks: {
          '@/lib/integrations/shopifyCheckoutChannelEligibility':
            shopifyCheckoutChannelEligibility,
          '@/lib/persistence/postgres': postgres,
          '@/lib/persistence/shopifyCheckoutRating': {
            shopifyCheckoutRateLineageIsRequired: (serviceCode) => (
              typeof serviceCode === 'string'
              && /^clawpilot:(ups|fedex):[A-Za-z0-9][A-Za-z0-9._-]{0,56}$/.test(
                serviceCode.trim(),
              )
            ),
            shopifyCheckoutRatingHash: (value) => sha(
              JSON.stringify(value),
            ),
          },
        },
      },
    )
    let shopifyPlanningAuthorityReadCount = 0
    let shopifyPlanningAuthorityMode = 'match'
    class TestShopifyOrderPlanningAuthorityError extends Error {
      constructor(message, status = 409, code = 'TEST_SHOPIFY_ERROR') {
        super(message)
        this.name = 'ShopifyOrderPlanningAuthorityError'
        this.status = status
        this.code = code
      }
    }
    const shopifyOrderPlanningAuthority = {
      ShopifyOrderPlanningAuthorityError:
        TestShopifyOrderPlanningAuthorityError,
      assertShopifyOrderPlanningAuthorityHash(value) {
        if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
          throw new TestShopifyOrderPlanningAuthorityError(
            'Shopify order planning authority hash is invalid',
            400,
            'SHOPIFY_ORDER_PLANNING_HASH_INVALID',
          )
        }
        return value
      },
      normalizeShopifyOrderPlanningAuthoritySnapshot:
        normalizeTestShopifyPlanningAuthority,
      shopifyOrderPlanningAuthorityHash:
        testShopifyPlanningAuthorityHash,
      async inspectShopifyOrderPlanningAuthority(input) {
        shopifyPlanningAuthorityReadCount += 1
        const retained = await pool.query(
          `SELECT evidence.id::text,
                  account.id::text AS account_id,
                  candidate.id::text AS candidate_id,
                  mapping.id::text AS mapping_id,
                  evidence.plan_snapshot
                    -> 'shopifyOrderPlanningAuthority' AS snapshot
           FROM operations_cartonization_rate_evidence evidence
           JOIN operations_integration_accounts account
             ON account.organization_id = evidence.organization_id
            AND account.id = evidence.integration_account_id
           JOIN operations_commerce_order_candidates candidate
             ON candidate.organization_id = evidence.organization_id
            AND candidate.id = evidence.order_candidate_id
           JOIN operations_warehouses warehouse
             ON warehouse.organization_id = evidence.organization_id
            AND warehouse.id = evidence.warehouse_id
           JOIN operations_commerce_inventory_location_mappings mapping
             ON mapping.organization_id = evidence.organization_id
            AND mapping.integration_account_id =
                  evidence.integration_account_id
            AND mapping.warehouse_id = evidence.warehouse_id
            AND mapping.active = true
           WHERE evidence.organization_id = $1::uuid
             AND account.global_id = $2
             AND candidate.global_id = $3
             AND evidence.candidate_row_version = $4::bigint
             AND warehouse.global_id = $5
             AND evidence.sealed_at IS NOT NULL
           ORDER BY evidence.id DESC
           LIMIT 1`,
          [
            input.organizationId,
            input.accountGlobalId,
            input.candidateGlobalId,
            input.expectedCandidateRowVersion,
            input.warehouseGlobalId,
          ],
        )
        if (!retained.rows[0]?.snapshot) {
          throw new TestShopifyOrderPlanningAuthorityError(
            'Test Shopify authority target was not found',
            409,
            'SHOPIFY_ORDER_PLANNING_CONTEXT_UNAVAILABLE',
          )
        }
        const snapshot = normalizeTestShopifyPlanningAuthority(
          retained.rows[0].snapshot,
        )
        if (shopifyPlanningAuthorityMode === 'changed') {
          snapshot.fulfillmentOrders[0].updatedAt = new Date(
            new Date(
              snapshot.fulfillmentOrders[0].updatedAt,
            ).getTime() + 1_000,
          ).toISOString()
        }
        if (shopifyPlanningAuthorityMode === 'locked-changed') {
          const changedRetained = normalizeTestShopifyPlanningAuthority(
            snapshot,
          )
          changedRetained.order.updatedAt = new Date(
            new Date(changedRetained.order.updatedAt).getTime() + 1_000,
          ).toISOString()
          await pool.query(
            `ALTER TABLE operations_cartonization_rate_evidence
             DISABLE TRIGGER USER`,
          )
          try {
            await pool.query(
              `UPDATE operations_cartonization_rate_evidence
               SET plan_snapshot = jsonb_set(
                 jsonb_set(
                   plan_snapshot,
                   '{shopifyOrderPlanningAuthority}',
                   $2::jsonb,
                   true
                 ),
                 '{shopifyOrderPlanningAuthorityHash}',
                 to_jsonb($3::text),
                 true
               )
               WHERE id = $1::uuid`,
              [
                retained.rows[0].id,
                JSON.stringify(changedRetained),
                testShopifyPlanningAuthorityHash(changedRetained),
              ],
            )
          } finally {
            await pool.query(
              `ALTER TABLE operations_cartonization_rate_evidence
               ENABLE TRIGGER USER`,
            )
          }
        }
        if (shopifyPlanningAuthorityMode === 'locked-account-changed') {
          await pool.query(
            `ALTER TABLE operations_integration_accounts
             DISABLE TRIGGER USER`,
          )
          try {
            await pool.query(
              `UPDATE operations_integration_accounts
               SET commerce_credential_generation =
                     commerce_credential_generation + 1
               WHERE id = $1::uuid`,
              [retained.rows[0].account_id],
            )
          } finally {
            await pool.query(
              `ALTER TABLE operations_integration_accounts
               ENABLE TRIGGER USER`,
            )
          }
        }
        if (shopifyPlanningAuthorityMode === 'locked-candidate-changed') {
          await pool.query(
            `ALTER TABLE operations_commerce_order_candidates
             DISABLE TRIGGER USER`,
          )
          try {
            await pool.query(
              `UPDATE operations_commerce_order_candidates
               SET row_version = row_version + 1
               WHERE id = $1::uuid`,
              [retained.rows[0].candidate_id],
            )
          } finally {
            await pool.query(
              `ALTER TABLE operations_commerce_order_candidates
               ENABLE TRIGGER USER`,
            )
          }
        }
        if (shopifyPlanningAuthorityMode === 'locked-mapping-changed') {
          await pool.query(
            `UPDATE operations_commerce_inventory_location_mappings
             SET row_version = row_version + 1
             WHERE id = $1::uuid`,
            [retained.rows[0].mapping_id],
          )
        }
        return {
          authorityHash: testShopifyPlanningAuthorityHash(snapshot),
          snapshot,
          providerReads: 1,
          providerWrites: 0,
        }
      },
    }
    class TestShopifyExternalFulfillmentReconciliationError extends Error {
      constructor(
        message,
        status = 409,
        code = 'TEST_SHOPIFY_EXTERNAL_FULFILLMENT_ERROR',
      ) {
        super(message)
        this.name = 'ShopifyExternalFulfillmentReconciliationError'
        this.status = status
        this.code = code
        this.retryable = false
      }
    }
    const shopifyExternalFulfillmentReconciliation = {
      ShopifyExternalFulfillmentReconciliationError:
        TestShopifyExternalFulfillmentReconciliationError,
      async inspectShopifyExternalFulfillment() {
        throw new TestShopifyExternalFulfillmentReconciliationError(
          'Canonical planning acceptance does not reconcile external fulfillment',
        )
      },
    }
    const operations = loadTypeScriptModule(
      'app_src/lib/persistence/operations.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/crm/stableId': stableId,
          '@/lib/integrations/carrierCheckoutRate': {
            rateCheckoutShipment: async () => {
              throw new Error(
                'Canonical planning acceptance does not call carrier rates',
              )
            },
          },
          '@/lib/integrations/carrierIntegrations': {
            testCarrierSandboxShipmentRate: async () => {
              throw new Error(
                'Canonical planning acceptance does not call carrier sandboxes',
              )
            },
          },
          '@/lib/integrations/shopifyFulfillmentWriteback': {
            executeShopifyFulfillmentWriteback: async () => {
              throw new Error(
                'Canonical planning acceptance does not write Shopify fulfillment',
              )
            },
            shopifyFulfillmentAttemptSignatureHashCandidates: () => {
              throw new Error(
                'Canonical planning acceptance does not hash Shopify fulfillment attempts',
              )
            },
          },
          '@/lib/integrations/integrationCredentialRuntimeGate.mjs': {
            isIntegrationCredentialRuntimeGateError: () => false,
          },
          '@/lib/integrations/shopifyOrderPlanningAuthority':
            shopifyOrderPlanningAuthority,
          '@/lib/integrations/shopifyExternalFulfillmentReconciliation':
            shopifyExternalFulfillmentReconciliation,
          '@/lib/integrations/faireFulfillmentRuntime': {
            prepareCurrentFaireFulfillmentAuthority: async () => {
              throw new Error(
                'Canonical planning acceptance does not authorize Faire fulfillment',
              )
            },
            executeCurrentFaireFulfillmentWriteback: async () => {
              throw new Error(
                'Canonical planning acceptance does not write Faire fulfillment',
              )
            },
          },
          '@/lib/commerceFulfillmentRecoveryPolicy':
            commerceFulfillmentRecoveryPolicy,
          '@/lib/operations/adapters': adapters,
          '@/lib/operations/canonicalFulfillmentPlanning':
            canonicalPlanning,
          '@/lib/operations/domain': domain,
          '@/lib/operations/pickManagement': pickManagement,
          '@/lib/operations/packingSlip': packingSlip,
          '@/lib/operations/barcodeLabels': barcodeLabels,
          '@/lib/operations/orderListQuery': orderListQuery,
          '@/lib/operations/orderShipTo': orderShipTo,
          '@/lib/operations/providerOrderMoney': providerOrderMoney,
          '@/lib/operations/providerOrderHistory': providerOrderHistory,
          '@/lib/persistence/cartonizationRateEvidence':
            cartonizationRateEvidence,
          '@/lib/persistence/commerceOrderWorkbench': {
            readCommerceOrderWorkbenchPageFromPostgres: async () => ({
              orders: [],
              page: {
                total: 0,
                returned: 0,
                pageSize: 250,
                nextCursor: null,
                complete: true,
                truncated: false,
              },
            }),
          },
          '@/lib/persistence/commerceOrderSync': {
            readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres:
              async () => ({
                items: [],
                truncated: false,
                limit: 500,
                providerWrites: 0,
              }),
          },
          '@/lib/persistence/orderUnitWeightEvidence': {
            assertCurrentOrderUnitWeightEvidence: async () => {},
          },
          '@/lib/persistence/commerceProviderWrites': {
            CommerceProviderWriteControlError: class extends Error {},
            readCommerceProviderWriteControlsFromPostgres: async () => ({
              accounts: [],
            }),
            requireCurrentCommerceProviderWritesInPostgres: async () => {
              throw new Error(
                'Canonical planning acceptance does not authorize Provider writes',
              )
            },
          },
          '@/lib/persistence/commerceOrderRevisions': {
            async assertCommerceOrderRevisionExecutionCurrent() {},
            CommerceOrderRevisionGateError: class extends Error {},
          },
          '@/lib/persistence/commerceStoreSync': {
            readCommerceStoreSyncControlsFromPostgres: async () => [],
          },
          '@/lib/persistence/shopifyTestStoreCanonicalE2e': {
            requireActiveShopifyTestStoreCanonicalE2eAuthorization: async () => {
              throw new Error(
                'Canonical planning acceptance does not authorize a Shopify test-store E2E lane',
              )
            },
            requireExactShopifyTestStoreConfirmedLabelSnapshot: async () => {
              throw new Error(
                'Canonical planning acceptance does not confirm Shopify test-store labels',
              )
            },
          },
          '@/lib/persistence/crm': {
            stageCrmRecordWithClient: async () => {
              throw new Error(
                'Canonical planning acceptance does not stage CRM records',
              )
            },
          },
          '@/lib/persistence/operationPrintDelivery': {
            enqueueOperationsPrintJobInPostgres: async () => {
              throw new Error(
                'Canonical planning must not enqueue a print job',
              )
            },
          },
          '@/lib/persistence/operationShadowFulfillmentPreparation': {
            readShadowFulfillmentPreparation: async () => {
              throw new Error(
                'Canonical planning acceptance does not read Shadow execution evidence',
              )
            },
          },
          '@/lib/persistence/operationShadowTraining': {
            assertNoOpenOperationsShadowTrainingRunsForActivation:
              async () => {},
          },
          '@/lib/persistence/operationsOrderShipmentAddress':
            operationsOrderShipmentAddress,
          '@/lib/persistence/sandboxCommerceE2eAuthorization': {
            requireActiveSandboxCommerceE2eAuthorization: async () => {
              throw new Error(
                'Canonical planning acceptance has no sandbox E2E authorization',
              )
            },
            consumeSandboxCommerceE2eAuthorization: async () => {
              throw new Error(
                'Canonical planning acceptance has no sandbox E2E authorization',
              )
            },
          },
          '@/lib/persistence/postgres': postgres,
          '@/lib/persistence/productPackaging': {
            readDefaultProductPackagingWithClient: async () => new Map(),
          },
          '@/lib/persistence/shopifyCheckoutRating': {
            shopifyCheckoutRateLineageIsRequired: () => false,
            shopifyCheckoutRateOutcomeAllowsFulfillment: () => false,
          },
        },
      },
    )
    const packagingMaterials = loadTypeScriptModule(
      'app_src/lib/persistence/packagingMaterials.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/operations/packagingMaterials':
            packagingMaterialsDomain,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
    assert.equal(
      typeof operations.planOperationsOrderFromPostgres,
      'function',
      'planOperationsOrderFromPostgres must be exported',
    )
    assert.equal(
      typeof operations.releaseOperationsOrderFromPostgres,
      'function',
      'releaseOperationsOrderFromPostgres must be exported',
    )
    assert.equal(
      typeof operations.confirmOperationsOrderPicksFromPostgres,
      'function',
      'confirmOperationsOrderPicksFromPostgres must be exported',
    )
    assert.equal(
      typeof packagingMaterials.savePackagingMaterialStockInPostgres,
      'function',
      'savePackagingMaterialStockInPostgres must be exported',
    )
    assert.equal(
      typeof hybridCartonizationPersistence
        .readHybridCartonizationInputFromPostgres,
      'function',
      'readHybridCartonizationInputFromPostgres must be exported',
    )

    const migrationApplied = await pool.query(
      `SELECT 1
       FROM schema_migrations
       WHERE filename =
         '0176_operations_canonical_fulfillment_planning.sql'`,
    )
    assert.equal(
      migrationApplied.rowCount,
      1,
      'Migration 0176 must be applied in disposable PostgreSQL',
    )

    const faireInventoryFixture = await seedCanonicalPlanningFixture(
      pool,
      { inventoryAuthority: 'clawpilot_split' },
    )
    const faireAccount = await pool.query(
      `SELECT global_id
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND id = (
           SELECT integration_account_id
           FROM operations_commerce_order_candidates
           WHERE organization_id = $1::uuid
             AND id = $2::uuid
         )`,
      [faireInventoryFixture.organizationId, faireInventoryFixture.candidate.id],
    )
    const faireCartonizationInput = await hybridCartonizationPersistence
      .readHybridCartonizationInputFromPostgres({
        organizationId: faireInventoryFixture.organizationId,
        accountGlobalId: faireAccount.rows[0].global_id,
        candidateGlobalId: faireInventoryFixture.candidate.global_id,
        expectedCandidateRowVersion: Number(
          faireInventoryFixture.candidate.row_version,
        ),
        warehouseGlobalId: faireInventoryFixture.warehouse.global_id,
        mode: 'production',
        selectedMaterials: [{
          materialGlobalId: faireInventoryFixture.material.global_id,
          expectedRowVersion: Number(
            faireInventoryFixture.material.row_version,
          ),
        }],
        assumedCommittedQuantities: [],
      })
    assert.equal(faireCartonizationInput.account.provider, 'faire')
    assert.equal(faireCartonizationInput.inventory.syncRunGlobalId, null)
    assert.equal(faireCartonizationInput.inventory.providerFetchedAt, null)
    assert.equal(faireCartonizationInput.inventory.completedAt, null)
    assert.equal(
      faireCartonizationInput.inventory.products[0]
        .availabilityAuthority,
      'operational_available',
    )
    assert.equal(
      faireCartonizationInput.inventory.products[0]
        .effectiveAvailableQuantity,
      4,
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(
        faireCartonizationInput.inventory.products[0]
          .sourceLevelGlobalIds,
      )),
      [],
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(
        faireCartonizationInput.inventory.products[0]
          .sourcePositionGlobalIds,
      )),
      faireInventoryFixture.splitInventoryPositions
        .map((position) => position.global_id)
        .sort(),
    )

    const shopifyInventoryFixture = await seedCanonicalPlanningFixture(pool, {
      checkoutServiceCode: 'clawpilot:dev:test-zero',
      shopifyUnlistedChannel: true,
    })
    const lateMapping = await installReceiptExemptUnlistedCheckoutMapping(
      pool,
      shopifyInventoryFixture,
    )
    const shopifyAccount = await pool.query(
      `SELECT global_id
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND id = (
           SELECT integration_account_id
           FROM operations_commerce_order_candidates
           WHERE organization_id = $1::uuid
             AND id = $2::uuid
         )`,
      [
        shopifyInventoryFixture.organizationId,
        shopifyInventoryFixture.candidate.id,
      ],
    )
    const shopifyCartonizationInput = await hybridCartonizationPersistence
      .readHybridCartonizationInputFromPostgres({
        organizationId: shopifyInventoryFixture.organizationId,
        accountGlobalId: shopifyAccount.rows[0].global_id,
        candidateGlobalId: shopifyInventoryFixture.candidate.global_id,
        expectedCandidateRowVersion: Number(
          shopifyInventoryFixture.candidate.row_version,
        ),
        warehouseGlobalId: shopifyInventoryFixture.warehouse.global_id,
        mode: 'production',
        selectedMaterials: [{
          materialGlobalId: shopifyInventoryFixture.material.global_id,
          expectedRowVersion: Number(
            shopifyInventoryFixture.material.row_version,
          ),
        }],
        assumedCommittedQuantities: [],
      })
    assert.equal(shopifyCartonizationInput.account.provider, 'shopify')
    assert.equal(
      shopifyCartonizationInput.inventory.syncRunGlobalId,
      shopifyInventoryFixture.inventoryRun.global_id,
    )
    assert.equal(
      shopifyCartonizationInput.inventory.products[0]
        .availabilityAuthority,
      'shopify_provider_commitment',
    )

    const capturedMappingState = await pool.query(
      `SELECT
         line.commerce_variant_pack_mapping_id::text AS captured_mapping_id,
         line.commerce_variant_pack_mapping_row_version::text
           AS captured_mapping_row_version,
         mapping.projection_state,
         mapping.is_current,
         mapping.row_version::text AS current_mapping_row_version
       FROM operations_commerce_order_candidate_lines line
       JOIN operations_commerce_variant_pack_mappings mapping
         ON mapping.organization_id = line.organization_id
        AND mapping.id = line.commerce_variant_pack_mapping_id
       WHERE line.organization_id = $1::uuid
         AND line.id = $2::uuid`,
      [
        shopifyInventoryFixture.organizationId,
        shopifyInventoryFixture.candidateLine.id,
      ],
    )
    assert.deepEqual(capturedMappingState.rows[0], {
      captured_mapping_id: shopifyInventoryFixture.commercePackMapping.id,
      captured_mapping_row_version:
        shopifyInventoryFixture.commercePackMapping.row_version,
      projection_state: 'stale',
      is_current: false,
      current_mapping_row_version:
        lateMapping.retiredCapture.row_version,
    })
    assert.equal(shopifyCartonizationInput.lineEvidence.length, 1)
    assert.deepEqual(
      {
        mappingGlobalId:
          shopifyCartonizationInput.lineEvidence[0]
            .variantPackMappingGlobalId,
        checkoutReceiptGlobalId:
          shopifyCartonizationInput.lineEvidence[0]
            .checkoutReceiptGlobalId,
        fulfillmentPackSource:
          shopifyCartonizationInput.lineEvidence[0]
            .fulfillmentPackSource,
        accountEnvironment:
          shopifyCartonizationInput.lineEvidence[0]
            .fulfillmentPackEvidence.accountEnvironment,
        providerStatusRaw:
          shopifyCartonizationInput.lineEvidence[0]
            .fulfillmentPackEvidence.channelProviderStatusRaw,
        normalizedStatus:
          shopifyCartonizationInput.lineEvidence[0]
            .fulfillmentPackEvidence.channelNormalizedStatus,
        providerActive:
          shopifyCartonizationInput.lineEvidence[0]
            .fulfillmentPackEvidence.channelProviderActive,
      },
      {
        mappingGlobalId: lateMapping.mapping.global_id,
        checkoutReceiptGlobalId: null,
        fulfillmentPackSource: 'current_shopify_checkout_mapping',
        accountEnvironment: 'sandbox',
        providerStatusRaw: 'UNLISTED',
        normalizedStatus: 'unlisted',
        providerActive: false,
      },
      'Receipt-exempt promoted Shopify order must replace stale capture with the current exact UNLISTED mapping without a receipt',
    )
    const genuineClawPilotFixture = await seedCanonicalPlanningFixture(pool, {
      checkoutServiceCode: 'clawpilot:ups:03',
    })
    await assert.rejects(
      () => hybridCartonizationPersistence
        .readHybridCartonizationInputFromPostgres({
          organizationId: genuineClawPilotFixture.organizationId,
          accountGlobalId:
            genuineClawPilotFixture.commerceAccount.global_id,
          candidateGlobalId: genuineClawPilotFixture.candidate.global_id,
          expectedCandidateRowVersion: Number(
            genuineClawPilotFixture.candidate.row_version,
          ),
          warehouseGlobalId: genuineClawPilotFixture.warehouse.global_id,
          mode: 'production',
          selectedMaterials: [{
            materialGlobalId: genuineClawPilotFixture.material.global_id,
            expectedRowVersion: Number(
              genuineClawPilotFixture.material.row_version,
            ),
          }],
          assumedCommittedQuantities: [],
        }),
      (error) => {
        assert.equal(
          error.code,
          'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
        )
        assert.equal(error.status, 409)
        return true
      },
      'A genuine ClawPilot carrier rate must remain fail-closed without its exact checkout receipt',
    )

    const upgradeFixture = await seedCanonicalPlanningFixture(pool, {
      activationState: 'active',
      carrierReadEnvironment: 'production',
    })
    await pool.query(
      `ALTER TABLE operations_fulfillment_plans
       DISABLE TRIGGER validate_ops_plan_cartonization_evidence`,
    )
    let legacyPlan
    try {
      const legacyPlanResult = await pool.query(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id, version_number,
           status, method, solver_status, estimated_cost_minor,
           estimated_revenue_minor, estimated_margin_minor,
           promised_delivery_at, explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 1,
           'planned', 'optimizer', 'legacy_pre_migration', 0,
           NULL, NULL, now() + interval '3 days',
           '{"fixture":"pre_0176_active_plan"}'::jsonb, $4
         )
         RETURNING id::text, global_id`,
        [
          upgradeFixture.organizationId,
          upgradeFixture.order.id,
          upgradeFixture.warehouse.id,
          upgradeFixture.email,
        ],
      )
      legacyPlan = legacyPlanResult.rows[0]
    } finally {
      await pool.query(
        `ALTER TABLE operations_fulfillment_plans
         ENABLE TRIGGER validate_ops_plan_cartonization_evidence`,
      )
    }
    await pool.query(
      `ALTER TABLE operations_activation_scopes
       DISABLE TRIGGER validate_ops_activation_canonical_plans`,
    )
    try {
      await pool.query(
        `UPDATE operations_activation_scopes
         SET state = 'active'
         WHERE organization_id = $1::uuid`,
        [upgradeFixture.organizationId],
      )
    } finally {
      await pool.query(
        `ALTER TABLE operations_activation_scopes
         ENABLE TRIGGER validate_ops_activation_canonical_plans`,
      )
    }

    const migrationSource = read(
      'db/migrations/0176_operations_canonical_fulfillment_planning.sql',
    )
    const upgradePreflight = markedSql(
      migrationSource,
      '-- BEGIN 0176 ACTIVE PLAN UPGRADE PREFLIGHT',
      '-- END 0176 ACTIVE PLAN UPGRADE PREFLIGHT',
    )
    await assert.rejects(
      () => pool.query(upgradePreflight),
      /Migration 0176 cannot preserve Active Operations organization .* while plan .* lacks production carrier-read evidence/,
    )
    const localPlan = await pool.query(
      `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id, version_number,
           status, method, solver_status, estimated_cost_minor,
           promised_delivery_at, explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 2,
           'planned', 'optimizer', 'direct_active_insert', 0,
           now() + interval '3 days', '{}'::jsonb, $4
         )`,
        [
          upgradeFixture.organizationId,
          upgradeFixture.order.id,
           upgradeFixture.warehouse.id,
           upgradeFixture.email,
         ],
    )
    assert.equal(localPlan.rowCount, 1)
    const releasedLocalPlan = await pool.query(
      `UPDATE operations_fulfillment_plans
         SET status = 'released'
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [upgradeFixture.organizationId, legacyPlan.id],
    )
    assert.equal(releasedLocalPlan.rowCount, 1)

    const fixture = await seedCanonicalPlanningFixture(pool)
    const foreignFixture = await seedCanonicalPlanningFixture(pool)
    const unrelatedSuffix = randomUUID().slice(0, 8)
    const unrelatedOrderResult = await pool.query(
      `INSERT INTO operations_orders (
         organization_id, pipeline_id, customer_id, integration_account_id,
         source_provider, external_order_id, order_number, status, currency,
         merchandise_total_minor, requested_delivery_at, ship_to,
         source_payload, created_by, updated_by
       )
       SELECT
         organization_id, pipeline_id, customer_id, integration_account_id,
         source_provider, external_order_id || '-unrelated-' || $3,
         order_number || '-UNRELATED-' || $3, 'imported', currency,
         merchandise_total_minor, requested_delivery_at, ship_to,
         source_payload, created_by, updated_by
       FROM operations_orders
       WHERE organization_id = $1::uuid AND id = $2::uuid
       RETURNING id::text, global_id, row_version::text`,
      [fixture.organizationId, fixture.order.id, unrelatedSuffix],
    )
    const unrelatedOrder = unrelatedOrderResult.rows[0]
    assert.ok(unrelatedOrder, 'Same-organization unrelated order is required')

    const planningReceiptForKey = async (idempotencyKey) => {
      const receipt = await pool.query(
        `SELECT target_global_id, status, attempts,
                request_hash, updated_at::text
         FROM operations_command_receipts
         WHERE organization_id = $1::uuid
           AND command_type = 'plan_operations_order'
           AND idempotency_key = $2
         LIMIT 1`,
        [fixture.organizationId, idempotencyKey],
      )
      return receipt.rows[0] ?? null
    }
    const assertPlanningAuthorityRejected = async ({
      label,
      orderGlobalId,
      evidenceGlobalId,
      expectedRowVersion,
    }) => {
      const rejectedKey = `authority-rejected-${randomUUID()}`
      await assert.rejects(
        () => operations.planOperationsOrderFromPostgres({
          organizationId: fixture.organizationId,
          actorEmail: fixture.email,
          orderGlobalId,
          cartonizationEvidenceGlobalId: evidenceGlobalId,
          expectedRowVersion,
          reason: `Reject ${label} planning authority`,
          idempotencyKey: rejectedKey,
        }),
        (error) => {
          assert.equal(error.code, 'OPERATIONS_ORDER_EVIDENCE_MISMATCH')
          assert.equal(error.status, 409)
          assert.equal(
            error.message,
            'The order and cartonization evidence do not share one promoted commerce candidate',
          )
          return true
        },
        `${label} must use the uniform planning authority error`,
      )
      assert.equal(
        await planningReceiptForKey(rejectedKey),
        null,
        `${label} must not create a command receipt`,
      )
    }

    await assertPlanningAuthorityRejected({
      label: 'cross-organization order and evidence',
      orderGlobalId: foreignFixture.order.global_id,
      evidenceGlobalId: foreignFixture.evidence.global_id,
      expectedRowVersion: Number(foreignFixture.order.row_version),
    })
    await assertPlanningAuthorityRejected({
      label: 'nonexistent same-organization order',
      orderGlobalId: `gor${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      evidenceGlobalId: fixture.evidence.global_id,
      expectedRowVersion: Number(fixture.order.row_version),
    })
    await assertPlanningAuthorityRejected({
      label: 'same-organization order with unrelated evidence',
      orderGlobalId: unrelatedOrder.global_id,
      evidenceGlobalId: fixture.evidence.global_id,
      expectedRowVersion: Number(unrelatedOrder.row_version),
    })
    const unpromotedFixture = await seedCanonicalPlanningFixture(pool)
    await pool.query(
      `ALTER TABLE operations_commerce_order_candidates
       DISABLE TRIGGER protect_operations_commerce_order_candidate`,
    )
    await pool.query(
      `ALTER TABLE operations_commerce_order_candidates
       DROP CONSTRAINT commerce_order_candidates_promotion_valid`,
    )
    try {
      await pool.query(
        `UPDATE operations_commerce_order_candidates
         SET workflow_state = 'ready', row_version = row_version + 1
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [unpromotedFixture.organizationId, unpromotedFixture.candidate.id],
      )
      await assertPlanningAuthorityRejected({
        label: 'unpromoted same-organization candidate',
        orderGlobalId: unpromotedFixture.order.global_id,
        evidenceGlobalId: unpromotedFixture.evidence.global_id,
        expectedRowVersion: Number(unpromotedFixture.order.row_version),
      })
    } finally {
      await pool.query(
        `UPDATE operations_commerce_order_candidates
         SET workflow_state = 'promoted', row_version = row_version + 1
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [unpromotedFixture.organizationId, unpromotedFixture.candidate.id],
      )
      await pool.query(
        `ALTER TABLE operations_commerce_order_candidates
         ADD CONSTRAINT commerce_order_candidates_promotion_valid CHECK (
           (
             workflow_state = 'promoted'
             AND canonical_order_id IS NOT NULL
             AND promotion_command_receipt_id IS NOT NULL
             AND promotion_idempotency_key IS NOT NULL
             AND length(btrim(promotion_idempotency_key)) BETWEEN 1 AND 255
             AND promotion_request_hash IS NOT NULL
             AND promotion_request_hash ~ '^[a-f0-9]{64}$'
             AND promoted_at IS NOT NULL
           )
           OR (
             workflow_state <> 'promoted'
             AND canonical_order_id IS NULL
             AND promotion_command_receipt_id IS NULL
             AND promotion_idempotency_key IS NULL
             AND promotion_request_hash IS NULL
             AND promoted_at IS NULL
           )
         )`,
      )
      await pool.query(
        `ALTER TABLE operations_commerce_order_candidates
         ENABLE TRIGGER protect_operations_commerce_order_candidate`,
      )
    }

    for (const changedAuthority of [
      {
        mode: 'locked-changed',
        label: 'sealed evidence',
        code: 'OPERATIONS_CARTONIZATION_SHOPIFY_AUTHORITY_STALE',
      },
      {
        mode: 'locked-account-changed',
        label: 'integration account credential generation',
        code: 'OPERATIONS_CARTONIZATION_SHOPIFY_AUTHORITY_STALE',
      },
      {
        mode: 'locked-candidate-changed',
        label: 'promoted candidate row version',
        code: 'OPERATIONS_CARTONIZATION_EVIDENCE_STALE',
      },
      {
        mode: 'locked-mapping-changed',
        label: 'active Shopify location mapping row version',
        code: 'OPERATIONS_CARTONIZATION_SHOPIFY_AUTHORITY_STALE',
      },
    ]) {
      const changedAuthorityFixture =
        await seedCanonicalPlanningFixture(pool)
      const changedAuthorityKey = `authority-changed-${randomUUID()}`
      const readsBeforeChangedAuthority = shopifyPlanningAuthorityReadCount
      shopifyPlanningAuthorityMode = changedAuthority.mode
      try {
        await assert.rejects(
          () => operations.planOperationsOrderFromPostgres({
            organizationId: changedAuthorityFixture.organizationId,
            actorEmail: changedAuthorityFixture.email,
            orderGlobalId: changedAuthorityFixture.order.global_id,
            cartonizationEvidenceGlobalId:
              changedAuthorityFixture.evidence.global_id,
            expectedRowVersion: Number(
              changedAuthorityFixture.order.row_version,
            ),
            reason: `Reject changed ${changedAuthority.label}`,
            idempotencyKey: changedAuthorityKey,
          }),
          (error) => {
            assert.equal(error.code, changedAuthority.code)
            assert.equal(error.status, 409)
            return true
          },
        )
      } finally {
        shopifyPlanningAuthorityMode = 'match'
      }
      assert.equal(
        shopifyPlanningAuthorityReadCount,
        readsBeforeChangedAuthority + 1,
        `A ${changedAuthority.label} race must follow one live read`,
      )
      const changedAuthorityEffects = await pool.query(
        `SELECT
           (SELECT count(*)::int
            FROM operations_fulfillment_plans
            WHERE organization_id = $1::uuid) AS plans,
           (SELECT count(*)::int
            FROM operations_reservations
            WHERE organization_id = $1::uuid) AS reservations,
           receipt.status,
           receipt.error_code
         FROM operations_command_receipts receipt
         WHERE receipt.organization_id = $1::uuid
           AND receipt.command_type = 'plan_operations_order'
           AND receipt.idempotency_key = $2`,
        [changedAuthorityFixture.organizationId, changedAuthorityKey],
      )
      assert.deepEqual(changedAuthorityEffects.rows[0], {
        plans: 0,
        reservations: 0,
        status: 'failed',
        error_code: changedAuthority.code,
      })
    }

    const idempotencyKey = (
      `operations-plan:${foreignFixture.order.global_id}:${randomUUID()}`
    )
    const input = {
      organizationId: fixture.organizationId,
      actorEmail: fixture.email,
      orderGlobalId: fixture.order.global_id,
      cartonizationEvidenceGlobalId: fixture.evidence.global_id,
      expectedRowVersion: Number(fixture.order.row_version),
      reason: 'Accept sealed operational evidence in focused PostgreSQL',
      idempotencyKey,
    }
    const readsBeforePlan = shopifyPlanningAuthorityReadCount
    const result = await operations.planOperationsOrderFromPostgres(input)
    assert.equal(
      shopifyPlanningAuthorityReadCount,
      readsBeforePlan + 1,
      'A newly claimed Shopify plan must perform one live authority read',
    )
    assert.equal(result.orderGlobalId, fixture.order.global_id)
    assert.equal(result.orderStatus, 'planned')
    assert.equal(result.rowVersion, Number(fixture.order.row_version) + 1)
    assert.equal(result.replayed, false)
    assert.equal(result.packageCount, fixture.expected.packageCount)
    assert.equal(
      result.cartonizationEvidenceGlobalId,
      fixture.evidence.global_id,
    )
    assert.match(result.fulfillmentPlanGlobalId, /^gfp[0-9a-v]{12}$/)
    assert.equal(result.carrier, 'UPS')
    assert.equal(result.serviceCode, 'ground')
    assert.equal(result.serviceName, 'UPS Ground')
    assert.equal(
      result.carrierCostMinor,
      fixture.expected.carrierCostMinor,
    )
    assert.equal(
      result.checkoutShippingChargeMinor,
      fixture.expected.checkoutChargeMinor,
    )
    assert.equal(
      result.checkoutVarianceMinor,
      fixture.expected.checkoutVarianceMinor,
    )
    assert.equal(result.currency, 'USD')

    const state = await canonicalPlanningState(pool, fixture)
    assert.equal(state.status, 'planned')
    assert.equal(
      state.row_version,
      Number(fixture.order.row_version) + 1,
    )
    assert.equal(state.plan_global_id, result.fulfillmentPlanGlobalId)
    assert.equal(state.plan_status, 'planned')
    assert.equal(state.plan_evidence_id, fixture.evidence.id)
    assert.equal(
      state.estimated_cost_minor,
      fixture.expected.carrierCostMinor,
    )
    assert.equal(
      state.estimated_revenue_minor,
      fixture.expected.checkoutChargeMinor,
    )
    assert.equal(
      state.estimated_margin_minor,
      fixture.expected.checkoutVarianceMinor,
    )
    assert.equal(state.package_count, fixture.expected.packageCount)
    assert.equal(state.package_content_count, fixture.expected.packageCount)
    assert.equal(state.package_content_quantity, '2.000000')
    assert.equal(state.reservation_count, 1)
    assert.equal(state.reservation_authority, 'provider_commitment')
    assert.equal(
      state.reservation_inventory_run_id,
      fixture.inventoryRun.id,
    )
    assert.equal(
      state.reservation_inventory_level_id,
      fixture.inventoryLevel.id,
    )
    assert.equal(state.packaging_claim_count, 1)
    assert.equal(
      state.active_packaging_claim_quantity,
      fixture.expected.packageCount,
    )
    assert.equal(state.packaging_claim_status, 'active')
    assert.equal(
      state.packaging_stock_on_hand_quantity,
      fixture.expected.packageCount,
      'Planning claims packaging stock without decrementing physical on-hand',
    )
    assert.equal(state.allocation_count, 1)
    assert.equal(state.selected_rate_count, 1)
    assert.equal(state.selected_carrier, 'UPS')
    assert.equal(state.selected_service_code, 'ground')
    assert.equal(
      state.selected_cost_minor,
      fixture.expected.carrierCostMinor,
    )
    assert.equal(
      state.selected_charge_minor,
      fixture.expected.checkoutChargeMinor,
    )
    assert.equal(state.on_hand_quantity, '10.000000')
    assert.equal(state.reserved_quantity, '2.000000')
    assert.equal(
      state.ledger_count,
      0,
      'Provider-authoritative inventory must not receive a local ledger write',
    )
    assert.equal(state.label_count, 0)
    assert.equal(state.label_attempt_count, 0)
    assert.equal(state.shipment_count, 0)
    assert.equal(state.fulfillment_export_count, 0)
    assert.equal(state.provider_effect_intent_count, 0)
    assert.equal(state.print_artifact_count, 0)
    assert.equal(state.explanation.mudApplied, false)
    assert.equal(state.explanation.providerWrites, 0)
    assert.equal(state.explanation.labelWrites, 0)
    assert.equal(state.explanation.shipmentWrites, 0)
    assert.equal(state.explanation.packagingMaterialClaimCount, 1)
    assert.equal(state.explanation.packagingStockDecremented, false)

    const receiptTarget = async () => (
      (await planningReceiptForKey(idempotencyKey))?.target_global_id ?? null
    )
    assert.equal(
      await receiptTarget(),
      fixture.order.global_id,
      'Planning receipts must persist the server-resolved order target',
    )
    await pool.query(
      `UPDATE operations_command_receipts
       SET target_global_id = NULL
       WHERE organization_id = $1::uuid
         AND command_type = 'plan_operations_order'
         AND idempotency_key = $2`,
      [fixture.organizationId, idempotencyKey],
    )
    const legacyNullReceipt = await planningReceiptForKey(idempotencyKey)
    await assert.rejects(
      () => operations.planOperationsOrderFromPostgres({
        ...input,
        orderGlobalId: foreignFixture.order.global_id,
        cartonizationEvidenceGlobalId: foreignFixture.evidence.global_id,
        expectedRowVersion: Number(foreignFixture.order.row_version),
      }),
      (error) => {
        assert.equal(error.code, 'OPERATIONS_ORDER_EVIDENCE_MISMATCH')
        assert.equal(error.status, 409)
        return true
      },
      'A legacy NULL receipt requires fresh same-organization authority',
    )
    assert.deepEqual(
      await planningReceiptForKey(idempotencyKey),
      legacyNullReceipt,
      'Failed fresh authority must not mutate a legacy NULL receipt',
    )
    await assert.rejects(
      () => operations.planOperationsOrderFromPostgres({
        ...input,
        reason: `${input.reason} with a changed request hash`,
      }),
      (error) => {
        assert.equal(error.code, 'OPERATIONS_IDEMPOTENCY_CONFLICT')
        return true
      },
      'A hash conflict must not populate a legacy NULL target',
    )
    assert.equal(
      await receiptTarget(),
      null,
      'Legacy target fill must happen only after request-hash equality',
    )
    const readsBeforeReplay = shopifyPlanningAuthorityReadCount
    const replayed = await operations.planOperationsOrderFromPostgres(input)
    assert.equal(
      shopifyPlanningAuthorityReadCount,
      readsBeforeReplay,
      'A completed planning receipt must replay without a provider read',
    )
    assert.deepEqual(
      {
        ...JSON.parse(JSON.stringify(replayed)),
        replayed: false,
      },
      JSON.parse(JSON.stringify(result)),
      'Idempotent replay must return the original canonical planning result',
    )
    assert.equal(replayed.replayed, true)
    assert.equal(
      await receiptTarget(),
      fixture.order.global_id,
      'An exact replay must safely fill a legacy NULL target',
    )
    await pool.query(
      `UPDATE operations_command_receipts
       SET target_global_id = $3
       WHERE organization_id = $1::uuid
         AND command_type = 'plan_operations_order'
         AND idempotency_key = $2`,
      [fixture.organizationId, idempotencyKey, fixture.evidence.global_id],
    )
    await assert.rejects(
      () => operations.planOperationsOrderFromPostgres(input),
      (error) => {
        assert.equal(error.code, 'OPERATIONS_IDEMPOTENCY_CONFLICT')
        return true
      },
      'A non-NULL receipt target mismatch must fail closed',
    )
    assert.equal(
      await receiptTarget(),
      fixture.evidence.global_id,
      'A mismatched non-NULL target must remain unchanged',
    )
    await pool.query(
      `UPDATE operations_command_receipts
       SET target_global_id = $3
       WHERE organization_id = $1::uuid
         AND command_type = 'plan_operations_order'
         AND idempotency_key = $2`,
      [fixture.organizationId, idempotencyKey, fixture.order.global_id],
    )
    const duplicateCounts = await pool.query(
      `SELECT
         (SELECT count(*)::int
          FROM operations_fulfillment_plans
          WHERE organization_id = $1::uuid
            AND order_id = $2::uuid) AS plans,
         (SELECT count(*)::int
          FROM operations_reservations
          WHERE organization_id = $1::uuid
            AND order_id = $2::uuid) AS reservations,
         (SELECT count(*)::int
          FROM operations_packaging_material_claims claim
          JOIN operations_fulfillment_plans claim_plan
            ON claim_plan.organization_id = claim.organization_id
           AND claim_plan.id = claim.plan_id
          WHERE claim_plan.organization_id = $1::uuid
            AND claim_plan.order_id = $2::uuid) AS packaging_claims,
         (SELECT count(*)::int
          FROM operations_packages package
          JOIN operations_fulfillment_plans plan
            ON plan.organization_id = package.organization_id
           AND plan.id = package.plan_id
          WHERE plan.organization_id = $1::uuid
            AND plan.order_id = $2::uuid) AS packages`,
      [fixture.organizationId, fixture.order.id],
    )
    assert.deepEqual(duplicateCounts.rows[0], {
      plans: 1,
      reservations: 1,
      packaging_claims: 1,
      packages: fixture.expected.packageCount,
    })
    const providerReservation = await pool.query(
      `SELECT id::text
       FROM operations_reservations
       WHERE organization_id = $1::uuid
         AND order_id = $2::uuid
         AND reservation_authority = 'provider_commitment'
       LIMIT 1`,
      [fixture.organizationId, fixture.order.id],
    )
    const lifecycleClient = await pool.connect()
    try {
      await lifecycleClient.query('BEGIN')
      await lifecycleClient.query(
        `UPDATE operations_reservations
         SET status = 'released'
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [fixture.organizationId, providerReservation.rows[0].id],
      )
      await assert.rejects(
        () => lifecycleClient.query(
          `UPDATE operations_reservations
           SET status = 'active'
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [fixture.organizationId, providerReservation.rows[0].id],
        ),
        /terminal provider commitment reservation cannot be reactivated/,
      )
    } finally {
      await lifecycleClient.query('ROLLBACK').catch(() => undefined)
      lifecycleClient.release()
    }

    const activationState = await pool.query(
      `SELECT activation.state,
              evidence.plan_snapshot->>'carrierReadEnvironment'
                AS carrier_read_environment
       FROM operations_activation_scopes activation
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = activation.organization_id
        AND plan.order_id = $2::uuid
       JOIN operations_cartonization_rate_evidence evidence
         ON evidence.organization_id = plan.organization_id
        AND evidence.id = plan.cartonization_evidence_id
       WHERE activation.organization_id = $1::uuid`,
      [fixture.organizationId, fixture.order.id],
    )
    assert.deepEqual(activationState.rows[0], {
      state: 'active',
      carrier_read_environment: 'production',
    })

    await assert.rejects(
      () => packagingMaterials.savePackagingMaterialStockInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.email,
        stock: {
          materialGlobalId: fixture.material.global_id,
          warehouseId: fixture.warehouse.id,
          isAvailable: true,
          onHandQuantity: fixture.expected.packageCount - 1,
          reorderPointQuantity: 0,
          reorderToQuantity: fixture.expected.packageCount,
          expectedRowVersion: Number(fixture.packagingStock.row_version),
        },
      }),
      (error) => {
        assert.equal(
          error.code,
          'PACKAGING_MATERIAL_STOCK_ACTIVE_CLAIMS_CONFLICT',
        )
        return true
      },
    )
    await assert.rejects(
      () => pool.query(
        `UPDATE operations_packaging_material_stock
         SET on_hand_quantity = $3
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [
          fixture.organizationId,
          fixture.packagingStock.id,
          fixture.expected.packageCount - 1,
        ],
      ),
      /Packaging material stock cannot fall below active plan claims/,
    )
    const protectedStock = await pool.query(
      `SELECT on_hand_quantity, row_version::text
       FROM operations_packaging_material_stock
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, fixture.packagingStock.id],
    )
    assert.deepEqual(protectedStock.rows[0], {
      on_hand_quantity: fixture.expected.packageCount,
      row_version: fixture.packagingStock.row_version,
    })

    const unknownChargeFixture =
      await seedCanonicalPlanningFixture(pool, {
        customerChargeUse: 'blocked',
      })
    const unknownChargeResult =
      await operations.planOperationsOrderFromPostgres({
        organizationId: unknownChargeFixture.organizationId,
        actorEmail: unknownChargeFixture.email,
        orderGlobalId: unknownChargeFixture.order.global_id,
        cartonizationEvidenceGlobalId:
          unknownChargeFixture.evidence.global_id,
        expectedRowVersion:
          Number(unknownChargeFixture.order.row_version),
        reason: 'Preserve unknown checkout money as unknown',
        idempotencyKey: `canonical-plan-${randomUUID()}`,
      })
    assert.equal(unknownChargeResult.checkoutShippingChargeMinor, null)
    assert.equal(unknownChargeResult.checkoutVarianceMinor, null)
    const unknownChargeState = await canonicalPlanningState(
      pool,
      unknownChargeFixture,
    )
    assert.equal(unknownChargeState.estimated_revenue_minor, null)
    assert.equal(unknownChargeState.estimated_margin_minor, null)
    assert.equal(unknownChargeState.selected_charge_minor, null)

    const inactiveLocationFixture =
      await seedCanonicalPlanningFixture(pool)
    await pool.query(
      `UPDATE operations_locations
       SET active = false
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        inactiveLocationFixture.organizationId,
        inactiveLocationFixture.location.id,
      ],
    )
    await assert.rejects(
      () => operations.planOperationsOrderFromPostgres({
        organizationId: inactiveLocationFixture.organizationId,
        actorEmail: inactiveLocationFixture.email,
        orderGlobalId: inactiveLocationFixture.order.global_id,
        cartonizationEvidenceGlobalId:
          inactiveLocationFixture.evidence.global_id,
        expectedRowVersion:
          Number(inactiveLocationFixture.order.row_version),
        reason: 'Reject provider inventory in an inactive location',
        idempotencyKey: `canonical-plan-${randomUUID()}`,
      }),
      (error) => {
        assert.equal(
          error.code,
          'OPERATIONS_PROVIDER_INVENTORY_AMBIGUOUS',
        )
        return true
      },
    )

    await assert.rejects(
      () => seedCanonicalPlanningFixture(pool, {
        duplicatePackageLine: true,
      }),
      (error) => {
        assert.equal(
          error.code,
          'P0001',
        )
        assert.match(
          error.message,
          /one exact operational profile edge per allocation/,
        )
        return true
      },
    )

    const activeSandboxFixture =
      await seedCanonicalPlanningFixture(pool, {
        activationState: 'active',
        carrierReadEnvironment: 'sandbox',
      })
    await operations.planOperationsOrderFromPostgres({
      organizationId: activeSandboxFixture.organizationId,
      actorEmail: activeSandboxFixture.email,
      orderGlobalId: activeSandboxFixture.order.global_id,
      cartonizationEvidenceGlobalId:
        activeSandboxFixture.evidence.global_id,
      expectedRowVersion:
        Number(activeSandboxFixture.order.row_version),
      reason: 'Local planning accepts exact sandbox carrier estimates',
      idempotencyKey: `canonical-plan-${randomUUID()}`,
    })
    const activeSandboxEffects = await pool.query(
      `SELECT
         (SELECT count(*)::int
          FROM operations_fulfillment_plans
          WHERE organization_id = $1::uuid
            AND order_id = $2::uuid) AS plans,
         (SELECT count(*)::int
          FROM operations_packaging_material_claims
          WHERE organization_id = $1::uuid) AS packaging_claims`,
      [
        activeSandboxFixture.organizationId,
        activeSandboxFixture.order.id,
      ],
    )
    assert.deepEqual(activeSandboxEffects.rows[0], {
      plans: 1,
      packaging_claims: 1,
    })

    const missingEvidenceFixture =
      await seedCanonicalPlanningFixture(pool, {
        activationState: 'shadow',
        carrierReadEnvironment: 'production',
      })
    await pool.query(
      `UPDATE operations_integration_accounts
       SET environment = 'production'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        missingEvidenceFixture.organizationId,
        missingEvidenceFixture.commerceAccount.id,
      ],
    )
    await pool.query(
      `ALTER TABLE operations_fulfillment_plans
       DISABLE TRIGGER validate_ops_plan_cartonization_evidence`,
    )
    await pool.query(
      `ALTER TABLE operations_fulfillment_plans
       DISABLE TRIGGER guard_shadow_commerce_canonical_plan_insert`,
    )
    try {
      await pool.query(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id, version_number,
           status, method, solver_status, promised_delivery_at,
           explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 1,
           'planned', 'manual_override', 'missing_evidence_guard', now(),
           '{"acceptance":"missing-evidence-guard"}'::jsonb, $4
         )`,
        [
          missingEvidenceFixture.organizationId,
          missingEvidenceFixture.order.id,
          missingEvidenceFixture.warehouse.id,
          missingEvidenceFixture.email,
        ],
      )
    } finally {
      await pool.query(
        `ALTER TABLE operations_fulfillment_plans
         ENABLE TRIGGER guard_shadow_commerce_canonical_plan_insert`,
      )
      await pool.query(
        `ALTER TABLE operations_fulfillment_plans
         ENABLE TRIGGER validate_ops_plan_cartonization_evidence`,
      )
    }
    const missingEvidenceActivation = await pool.query(
      `SELECT state, revision
       FROM operations_activation_scopes
       WHERE organization_id = $1::uuid`,
      [missingEvidenceFixture.organizationId],
    )
    await assert.rejects(
      () => operations.updateOperationsActivationInPostgres({
        organizationId: missingEvidenceFixture.organizationId,
        actorEmail: missingEvidenceFixture.email,
        state: 'active',
        reason: 'Reject a plan with no cartonization evidence link',
        expectedCurrentState: missingEvidenceActivation.rows[0].state,
        expectedCurrentRevision: missingEvidenceActivation.rows[0].revision,
      }),
      (error) => {
        assert.equal(error.code, 'OPERATIONS_ACTIVE_SANDBOX_PLANS_EXIST')
        return true
      },
    )
    const localProfileTransition = await pool.query(
      `UPDATE operations_activation_scopes
         SET state = 'active'
         WHERE organization_id = $1::uuid
         RETURNING state`,
      [missingEvidenceFixture.organizationId],
    )
    assert.equal(localProfileTransition.rows[0]?.state, 'active')

    const packagingShortageFixture =
      await seedCanonicalPlanningFixture(pool, {
        packagingStockOnHand: 1,
      })
    await assert.rejects(
      () => operations.planOperationsOrderFromPostgres({
        organizationId: packagingShortageFixture.organizationId,
        actorEmail: packagingShortageFixture.email,
        orderGlobalId: packagingShortageFixture.order.global_id,
        cartonizationEvidenceGlobalId:
          packagingShortageFixture.evidence.global_id,
        expectedRowVersion:
          Number(packagingShortageFixture.order.row_version),
        reason: 'Reject a two-carton plan against one available carton',
        idempotencyKey: `canonical-plan-${randomUUID()}`,
      }),
      (error) => {
        assert.equal(
          error.code,
          'OPERATIONS_PACKAGING_MATERIAL_STOCK_EXHAUSTED',
        )
        return true
      },
    )
    const packagingShortageEffects = await pool.query(
      `SELECT
         (SELECT count(*)::int
          FROM operations_fulfillment_plans
          WHERE organization_id = $1::uuid
            AND order_id = $2::uuid) AS plans,
         (SELECT count(*)::int
          FROM operations_packaging_material_claims
          WHERE organization_id = $1::uuid) AS packaging_claims,
         (SELECT on_hand_quantity
          FROM operations_packaging_material_stock
          WHERE organization_id = $1::uuid
            AND id = $3::uuid) AS on_hand_quantity`,
      [
        packagingShortageFixture.organizationId,
        packagingShortageFixture.order.id,
        packagingShortageFixture.packagingStock.id,
      ],
    )
    assert.deepEqual(packagingShortageEffects.rows[0], {
      plans: 0,
      packaging_claims: 0,
      on_hand_quantity: 1,
    })

    const allocationAuthority = await pool.query(
      `SELECT allocation.plan_id::text, allocation.reservation_id::text,
              allocation.position_id::text, allocation.quantity::text
       FROM operations_fulfillment_allocations allocation
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = allocation.organization_id
        AND plan.id = allocation.plan_id
       WHERE plan.organization_id = $1::uuid
         AND plan.order_id = $2::uuid
       ORDER BY allocation.id
       LIMIT 1`,
      [fixture.organizationId, fixture.order.id],
    )
    const foreignLine = await pool.query(
      `SELECT id::text
       FROM operations_order_lines
       WHERE organization_id = $1::uuid AND order_id = $2::uuid
       ORDER BY id
       LIMIT 1`,
      [
        packagingShortageFixture.organizationId,
        packagingShortageFixture.order.id,
      ],
    )
    await assert.rejects(
      () => pool.query(
        `INSERT INTO operations_fulfillment_allocations (
           organization_id, plan_id, order_line_id, reservation_id,
           position_id, quantity
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6)`,
        [
          fixture.organizationId,
          allocationAuthority.rows[0].plan_id,
          foreignLine.rows[0].id,
          allocationAuthority.rows[0].reservation_id,
          allocationAuthority.rows[0].position_id,
          allocationAuthority.rows[0].quantity,
        ],
      ),
      /Fulfillment allocation must exactly match its active reservation/,
    )
    await assert.rejects(
      () => pool.query(
        `UPDATE operations_fulfillment_allocations
         SET quantity = quantity + 1
         WHERE organization_id = $1::uuid
           AND plan_id = $2::uuid`,
        [fixture.organizationId, allocationAuthority.rows[0].plan_id],
      ),
      /Fulfillment allocation identity and quantity are immutable/,
    )

    await verifyLatestProviderCommitmentRelease(
      pool,
      operations,
      hybridCartonizationPersistence,
    )
    await verifyPlanningAfterCancelledGeneration(pool, operations)
    await verifyLocalSplitPlanning(pool, operations)
    await verifyPackagingClaimConcurrency(pool)
  } finally {
    await pool.end()
  }
}

async function main() {
  const migration = read(
    'db/migrations/0176_operations_canonical_fulfillment_planning.sql',
  )
  for (const fragment of [
    'cartonization_evidence_id uuid',
    'reservation_authority text',
    "'provider_commitment'",
    'provider_inventory_sync_run_id uuid',
    'provider_inventory_level_id uuid',
    'operations_packaging_material_claims',
    'validate_ops_packaging_material_claim',
    'validate_ops_packaging_stock_active_claims',
    'validate_ops_activation_canonical_plans',
    'BEGIN 0176 ACTIVE PLAN UPGRADE PREFLIGHT',
    'Migration 0176 cannot preserve Active Operations organization',
    'validate_ops_fulfillment_allocation_integrity',
    "'active', 'consumed', 'released'",
    'validate_ops_reservation_authority',
    'A terminal provider commitment reservation cannot be reactivated',
    'Active fulfillment planning requires sealed production carrier-read evidence',
    'missing or non-production carrier-read plan',
    'protect_ops_inventory_ledger_authority',
    'ALTER COLUMN estimated_revenue_minor DROP NOT NULL',
    'ALTER COLUMN customer_charge_minor DROP NOT NULL',
  ]) {
    assert.ok(
      migration.includes(fragment),
      `Canonical planning migration is missing ${fragment}`,
    )
  }

  const suppliedDatabaseUrl = String(process.env.DATABASE_URL || '').trim()
  if (suppliedDatabaseUrl) {
    const parsed = new URL(suppliedDatabaseUrl)
    assert.ok(
      ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname),
      'Supplied canonical-planning database must be local and disposable',
    )
    await waitForPostgres(suppliedDatabaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: suppliedDatabaseUrl,
        PGSSLMODE: 'disable',
      },
      timeout: 180_000,
    })
    await verifyCanonicalPlanning(suppliedDatabaseUrl)
    console.log(
      'Canonical fulfillment planning local-PostgreSQL acceptance passed',
    )
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-canonical-plan-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_canonical_plan',
      '-e', 'POSTGRES_DB=clawpilot_canonical_plan',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command(
      'docker',
      ['port', container, '5432/tcp'],
    )
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(
      port > 0,
      `Unable to resolve disposable PostgreSQL port from ${portOutput}`,
    )
    const databaseUrl = (
      'postgresql://postgres:clawpilot_canonical_plan'
      + `@127.0.0.1:${port}/clawpilot_canonical_plan`
    )
    await waitForPostgres(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: {
        DATABASE_URL: databaseUrl,
        PGSSLMODE: 'disable',
      },
      timeout: 180_000,
    })
    await verifyCanonicalPlanning(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'Canonical fulfillment planning disposable-PostgreSQL acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
