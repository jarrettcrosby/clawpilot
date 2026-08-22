#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  applyMigration,
  command,
  loadTypeScriptModule,
  migrations,
  postgresAdapter,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const actorEmail = 'shipment-address-postgres@clawpilot.com'
const commandType = 'operations.order_shipment_address.update'

function fixture(suffix) {
  return {
    organizationId: randomUUID(),
    pipelineId: randomUUID(),
    customerId: randomUUID(),
    integrationId: randomUUID(),
    orderId: randomUUID(),
    revisionTargetId: randomUUID(),
    organizationGlobalId: `ga${suffix}`,
    accountGlobalId: `gia${suffix}`,
    orderGlobalId: `gor${suffix}`,
    externalOrderId: `gid://shopify/Order/${suffix}`,
  }
}

function nativeFixture(suffix) {
  return {
    organizationId: randomUUID(),
    pipelineId: randomUUID(),
    orderId: randomUUID(),
    organizationGlobalId: `ga${suffix}`,
    orderGlobalId: `gor${suffix}`,
    externalOrderId: `clawpilot-native:${suffix}`,
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

async function expectAddressError(action, code, status) {
  let observed = null
  try {
    await action()
  } catch (error) {
    observed = error
  }
  assert.ok(observed, `Expected ${code}`)
  assert.equal(observed.code, code)
  assert.equal(observed.status, status)
}

async function seedTenant(client, item, label) {
  await client.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, entity_type
     ) VALUES ($1, 'gor', $1, 'active', 'operations.order')`,
    [item.orderGlobalId],
  )
  await client.query(
    `INSERT INTO workspace_organizations (
       id, name, organization_type, reference_code
     ) VALUES ($1::uuid, $2, 'member', $3)`,
    [item.organizationId, `${label} organization`, item.organizationGlobalId],
  )
  await client.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1::uuid, $2, $3, true, $4::uuid)`,
    [item.pipelineId, `${label} pipeline`, actorEmail, item.organizationId],
  )
  await client.query(
    `INSERT INTO crm_organizations (
       id, pipeline_id, source_key, identity_key, name,
       relationship_type, source_payload, source_hash, sync_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, 'customer',
       '{}'::jsonb, $6, 'synced', $7, $7
     )`,
    [
      item.customerId,
      item.pipelineId,
      `shipment-address-${label}`,
      `customer:shipment-address-${label}`,
      `${label} customer`,
      'c'.repeat(64),
      actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type,
       environment, display_name, status, configuration,
       external_account_id, commerce_credential_generation,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, 'shopify', 'commerce', 'sandbox',
       $4, 'active', '{}'::jsonb, $5, 1, $6, $6
     )`,
    [
      item.integrationId,
      item.accountGlobalId,
      item.organizationId,
      `${label} Shopify`,
      `gid://shopify/Shop/${item.accountGlobalId.slice(-7)}`,
      actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_orders (
       id, global_id, organization_id, pipeline_id, customer_id,
       integration_account_id, source_provider, external_order_id,
       order_number, status, currency, merchandise_total_minor,
       ship_to, source_payload, row_version, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
       $6::uuid, 'shopify', $7, $8, 'imported', 'USD', 1000,
       '{}'::jsonb, $9::jsonb, 7, $10, $10
     )`,
    [
      item.orderId,
      item.orderGlobalId,
      item.organizationId,
      item.pipelineId,
      item.customerId,
      item.integrationId,
      item.externalOrderId,
      `#${item.orderGlobalId.slice(-7)}`,
      JSON.stringify({ immutableSourceMarker: `${label}-source` }),
      actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_commerce_order_revision_targets (
       id, organization_id, integration_account_id, order_id, provider,
       accepted_source_hash, latest_source_hash, material_state,
       claim_state, row_version
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify',
       $5, $5, 'current', 'ready', 3
     )`,
    [
      item.revisionTargetId,
      item.organizationId,
      item.integrationId,
      item.orderId,
      item.orderGlobalId.endsWith('1') ? 'a'.repeat(64) : 'b'.repeat(64),
    ],
  )
}

async function seedNativeOneOff(client, item) {
  await client.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, entity_type
     ) VALUES ($1, 'gor', $1, 'active', 'operations.order')`,
    [item.orderGlobalId],
  )
  await client.query(
    `INSERT INTO workspace_organizations (
       id, name, organization_type, reference_code
     ) VALUES ($1::uuid, 'Native one-off organization', 'member', $2)`,
    [item.organizationId, item.organizationGlobalId],
  )
  await client.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1::uuid, 'Native one-off pipeline', $2, true, $3::uuid)`,
    [item.pipelineId, actorEmail, item.organizationId],
  )
  await client.query(
    `INSERT INTO operations_orders (
       id, global_id, organization_id, pipeline_id, customer_id,
       integration_account_id, source_provider, external_order_id,
       order_number, order_type, status, currency,
       merchandise_total_minor, ship_to, source_payload, row_version,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, NULL,
       NULL, 'clawpilot_native', $5, 'ONE-OFF-1', 'one_off', 'packed',
       'USD', 0, $6::jsonb, '{"native":true}'::jsonb, 4, $7, $7
     )`,
    [
      item.orderId,
      item.orderGlobalId,
      item.organizationId,
      item.pipelineId,
      item.externalOrderId,
      JSON.stringify({
        name: 'Vendor receiving',
        line1: '50 Native Way',
        line2: null,
        city: 'Charlotte',
        region: 'NC',
        postalCode: '28202',
        country: 'US',
      }),
      actorEmail,
    ],
  )
}

async function seedFixtures(pool, primary, other, native) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    // Current one-off creation provisions a synthetic clawpilot_native account,
    // while the universal read contract also supports legacy/no-account rows.
    // Relax only this disposable schema so the LEFT JOIN regression is exact.
    await client.query(
      `ALTER TABLE operations_orders
       ALTER COLUMN integration_account_id DROP NOT NULL`,
    )
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [actorEmail],
    )
    await seedTenant(client, primary, 'Primary')
    await seedTenant(client, other, 'Other')
    await seedNativeOneOff(client, native)
  } finally {
    await client.query('SET session_replication_role = origin')
    client.release()
  }
}

async function canonicalSnapshot(pool, item) {
  const [order, revision] = await Promise.all([
    pool.query(
      `SELECT row_version::text, status, ship_to, source_payload,
              updated_by, updated_at
       FROM operations_orders
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [item.organizationId, item.orderId],
    ),
    pool.query(
      `SELECT accepted_source_hash, latest_source_hash, material_state,
              claim_state, row_version::text, updated_at
       FROM operations_commerce_order_revision_targets
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [item.organizationId, item.revisionTargetId],
    ),
  ])
  return plain({ order: order.rows[0], revision: revision.rows[0] })
}

async function stateCounts(pool, item) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_order_shipment_address_working_copies
        WHERE organization_id = $1::uuid) AS working_copies,
       (SELECT count(*)::integer
        FROM operations_command_receipts
        WHERE organization_id = $1::uuid AND command_type = $2) AS receipts,
       (SELECT count(*)::integer
        FROM audit_events
        WHERE organization_id = $1::uuid
          AND event_type = 'operations.order_shipment_address.updated') AS audits,
       (SELECT count(*)::integer
        FROM operations_commerce_external_effect_intents
        WHERE organization_id = $1::uuid) AS external_effect_intents`,
    [item.organizationId, commandType],
  )
  return plain(result.rows[0])
}

function loadPersistence(pool) {
  const orderShipTo = loadTypeScriptModule(
    'app_src/lib/operations/orderShipTo.ts',
  )
  return loadTypeScriptModule(
    'app_src/lib/persistence/operationsOrderShipmentAddress.ts',
    {
      '@/lib/operations/orderShipTo': orderShipTo,
      '@/lib/integrations/carrierSandboxRate': {
        carrierSandboxPartyFingerprint() {
          return 'f'.repeat(64)
        },
      },
      '@/lib/persistence/postgres': postgresAdapter(pool),
      '@/lib/auditWriter': {
        async recordAuditEvent(input, client) {
          await client.query(
            `INSERT INTO audit_events (
               actor, event_type, aggregate_type, aggregate_id, payload,
               event_key, subject, organization_id, is_system
             ) VALUES (
               $1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, false
             ) ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
            [
              input.actor || null,
              input.eventType,
              input.aggregateType || null,
              input.aggregateId || null,
              JSON.stringify(input.payload || {}),
              input.eventKey || null,
              input.subject || null,
              input.organizationId || null,
            ],
          )
        },
      },
    },
  )
}

async function seedLabelFence(pool, item) {
  const client = await pool.connect()
  const planId = randomUUID()
  const packageId = randomUUID()
  const rateId = randomUUID()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO operations_fulfillment_plans (
         id, global_id, organization_id, order_id, warehouse_id,
         version_number, status, method, solver_status,
         promised_delivery_at, created_by
       ) VALUES (
         $1::uuid, 'gfp0009811', $2::uuid, $3::uuid, $4::uuid,
         2, 'planned', 'manual_override', 'not_run', now() + interval '2 days', $5
       )`,
      [planId, item.organizationId, item.orderId, randomUUID(), actorEmail],
    )
    await client.query(
      `INSERT INTO operations_packages (
         id, global_id, organization_id, plan_id, package_number,
         length_mm, width_mm, height_mm, weight_grams, status
       ) VALUES (
         $1::uuid, 'gpa0009811', $2::uuid, $3::uuid, 1,
         100, 100, 100, 100, 'packed'
       )`,
      [packageId, item.organizationId, planId],
    )
    await client.query(
      `INSERT INTO operations_carrier_rates (
         id, global_id, organization_id, plan_id, carrier, service_code,
         service_name, internal_cost_minor, customer_charge_minor,
         transit_days, estimated_delivery_at, meets_promise, selected
       ) VALUES (
         $1::uuid, 'grt0009811', $2::uuid, $3::uuid, 'UPS', 'GROUND',
         'Ground', 100, 100, 3, now() + interval '3 days', true, true
       )`,
      [rateId, item.organizationId, planId],
    )
    await client.query(
      `INSERT INTO operations_labels (
         global_id, organization_id, package_id, carrier_rate_id,
         carrier, service_code, tracking_number, format, label_payload,
         provider_label_id, idempotency_key, status
       ) VALUES (
         'glb0009811', $1::uuid, $2::uuid, $3::uuid,
         'UPS', 'GROUND', 'TEST9811', 'PDF', 'test',
         'provider-test-9811', 'shipment-address-label-9811', 'created'
       )`,
      [item.organizationId, packageId, rateId],
    )
    await client.query(
      `UPDATE operations_labels SET environment = 'production'
       WHERE organization_id = $1::uuid AND global_id = 'glb0009811'`,
      [item.organizationId],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
    client.release()
  }
}

async function seedUnratedPlan(pool, item) {
  const client = await pool.connect()
  const planId = randomUUID()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO operations_fulfillment_plans (
         id, global_id, organization_id, order_id, warehouse_id,
         version_number, status, method, solver_status,
         promised_delivery_at, created_by
       ) VALUES (
         $1::uuid, 'gfp0009810', $2::uuid, $3::uuid, $4::uuid,
         1, 'planned', 'manual_override', 'not_run',
         now() + interval '2 days', $5
       )`,
      [planId, item.organizationId, item.orderId, randomUUID(), actorEmail],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
    client.release()
  }
  return planId
}

async function verifyAcceptance(databaseUrl, primary, other, native) {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY =
    'operations-shipment-address-postgres-encryption-key-0001'
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  try {
    await seedFixtures(pool, primary, other, native)
    const persistence = loadPersistence(pool)
    const canonicalBefore = await canonicalSnapshot(pool, primary)
    const initialCounts = await stateCounts(pool, primary)

    const nativeAddress = plain(await persistence
      .readOperationsOrderShipmentAddressInPostgres({
        organizationId: native.organizationId,
        orderGlobalId: native.orderGlobalId,
      }))
    assert.equal(nativeAddress.provenance, 'source')
    assert.equal(nativeAddress.readiness, 'carrier_ready')
    assert.equal(nativeAddress.orderRowVersion, 4)
    assert.equal(nativeAddress.rowVersion, 0)
    assert.equal(nativeAddress.editable, false)
    assert.equal(nativeAddress.value.line1, '50 Native Way')
    assert.deepEqual(nativeAddress.value, nativeAddress.sourceValue)

    const missingSave = plain(await persistence
      .updateOperationsOrderShipmentAddressInPostgres({
        organizationId: primary.organizationId,
        actorEmail,
        idempotencyKey: 'shipment-address-missing-0001',
        orderGlobalId: primary.orderGlobalId,
        expectedOrderRowVersion: 7,
        expectedAddressRowVersion: 0,
        changes: { name: null },
      }))
    assert.equal(missingSave.orderRowVersion, 7)
    assert.equal(missingSave.rowVersion, 1)
    assert.equal(missingSave.readiness, 'missing')
    assert.equal(missingSave.providerWrites, 0)
    assert.equal(missingSave.providerWriteIntentCreated, false)
    assert.deepEqual(
      await canonicalSnapshot(pool, primary),
      canonicalBefore,
      'local save must not mutate canonical order or accepted revision binding',
    )

    const partial = plain(await persistence
      .updateOperationsOrderShipmentAddressInPostgres({
        organizationId: primary.organizationId,
        actorEmail,
        idempotencyKey: 'shipment-address-partial-0002',
        orderGlobalId: primary.orderGlobalId,
        expectedOrderRowVersion: 7,
        expectedAddressRowVersion: 1,
        changes: {
          name: 'Vendor\u00a0Receiving',
          line1: '10 Example Way',
          city: 'Charlotte',
          country: 'US',
        },
      }))
    assert.equal(partial.rowVersion, 2)
    assert.equal(partial.readiness, 'incomplete')
    assert.deepEqual(partial.issues.map((issue) => issue.field), [
      'region',
      'postalCode',
    ])

    const readyInput = {
      organizationId: primary.organizationId,
      actorEmail,
      idempotencyKey: 'shipment-address-ready-0003',
      orderGlobalId: primary.orderGlobalId,
      expectedOrderRowVersion: 7,
      expectedAddressRowVersion: 2,
      changes: { region: 'NC', postalCode: '28202' },
    }
    const ready = plain(await persistence
      .updateOperationsOrderShipmentAddressInPostgres(readyInput))
    assert.equal(ready.rowVersion, 3)
    assert.equal(ready.readiness, 'carrier_ready')
    assert.equal(ready.replayed, false)
    const replayed = plain(await persistence
      .updateOperationsOrderShipmentAddressInPostgres(readyInput))
    assert.equal(replayed.rowVersion, 3)
    assert.equal(replayed.replayed, true)

    const current = plain(await persistence
      .readOperationsOrderShipmentAddressInPostgres({
        organizationId: primary.organizationId,
        orderGlobalId: primary.orderGlobalId,
      }))
    assert.equal(current.provenance, 'local')
    assert.equal(current.readiness, 'carrier_ready')
    assert.equal(current.orderRowVersion, 7)
    assert.equal(current.rowVersion, 3)
    assert.deepEqual(current.sourceValue, {
      name: null,
      line1: null,
      line2: null,
      city: null,
      region: null,
      postalCode: null,
      country: null,
    })
    assert.deepEqual(current.value, {
      name: 'Vendor\u00a0Receiving',
      line1: '10 Example Way',
      line2: null,
      city: 'Charlotte',
      region: 'NC',
      postalCode: '28202',
      country: 'US',
    })
    const activeDestination = {
      contactName: '  VENDOR\u00a0RECEIVING ',
      companyName: 'Ignored enrichment',
      phone: '704-555-0100',
      email: 'receiving@example.com',
      line1: '10 Example Way',
      line2: null,
      line3: null,
      city: 'Charlotte',
      region: 'NC',
      postalCode: '28202',
      countryCode: 'US',
      residential: false,
    }
    const dispatchBinding = await pool.query(
      `SELECT
         working_copy.dispatch_core_fingerprint,
         operations_dispatch_address_core_fingerprint($3::jsonb)
           AS sql_fingerprint,
         operations_order_dispatch_destination_matches(
           $1::uuid, $2::uuid, $3::jsonb
         ) AS effective_matches,
         operations_order_dispatch_destination_matches(
           $1::uuid, $2::uuid, '{}'::jsonb
         ) AS source_matches,
         operations_order_dispatch_destination_matches(
           $1::uuid, $2::uuid,
           jsonb_set($3::jsonb, '{postalCode}', '"99999"'::jsonb)
         ) AS wrong_matches
       FROM operations_order_shipment_address_working_copies working_copy
       WHERE working_copy.organization_id = $1::uuid
         AND working_copy.order_id = $2::uuid`,
      [primary.organizationId, primary.orderId, JSON.stringify(activeDestination)],
    )
    assert.equal(dispatchBinding.rows[0].effective_matches, true)
    assert.equal(dispatchBinding.rows[0].source_matches, false)
    assert.equal(dispatchBinding.rows[0].wrong_matches, false)
    assert.equal(
      dispatchBinding.rows[0].dispatch_core_fingerprint,
      dispatchBinding.rows[0].sql_fingerprint,
      'Active SQL authority must use the exact normalized local-address fingerprint',
    )
    await expectAddressError(
      () => persistence.updateOperationsOrderShipmentAddressInPostgres({
        ...readyInput,
        changes: { line2: 'Dock 2' },
      }),
      'OPERATIONS_IDEMPOTENCY_CONFLICT',
      409,
    )
    await expectAddressError(
      () => persistence.updateOperationsOrderShipmentAddressInPostgres({
        ...readyInput,
        idempotencyKey: 'shipment-address-stale-0004',
        expectedAddressRowVersion: 2,
      }),
      'OPERATIONS_SHIPMENT_ADDRESS_VERSION_CONFLICT',
      409,
    )
    await expectAddressError(
      () => persistence.updateOperationsOrderShipmentAddressInPostgres({
        ...readyInput,
        idempotencyKey: 'shipment-address-order-stale-0004',
        expectedOrderRowVersion: 6,
        expectedAddressRowVersion: 3,
      }),
      'OPERATIONS_ORDER_VERSION_CONFLICT',
      409,
    )
    await expectAddressError(
      () => persistence.updateOperationsOrderShipmentAddressInPostgres({
        ...readyInput,
        idempotencyKey: 'shipment-address-cross-tenant-0005',
        orderGlobalId: other.orderGlobalId,
        expectedAddressRowVersion: 0,
      }),
      'OPERATIONS_ORDER_NOT_FOUND',
      404,
    )

    const protectedRow = await pool.query(
      `SELECT ship_to_ciphertext
       FROM operations_order_shipment_address_working_copies
       WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
      [primary.organizationId, primary.orderId],
    )
    const originalCiphertext = protectedRow.rows[0].ship_to_ciphertext
    await pool.query(
      `UPDATE operations_order_shipment_address_working_copies
       SET ship_to_ciphertext = set_byte(
         ship_to_ciphertext, 0, (get_byte(ship_to_ciphertext, 0) + 1) % 256
       )
       WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
      [primary.organizationId, primary.orderId],
    )
    const beforeProtectedFailure = await stateCounts(pool, primary)
    await expectAddressError(
      () => persistence.readOperationsOrderShipmentAddressInPostgres({
        organizationId: primary.organizationId,
        orderGlobalId: primary.orderGlobalId,
      }),
      'OPERATIONS_SHIPMENT_ADDRESS_PROTECTED_DATA_UNREADABLE',
      500,
    )
    await expectAddressError(
      () => persistence.updateOperationsOrderShipmentAddressInPostgres({
        ...readyInput,
        idempotencyKey: 'shipment-address-corrupt-0006',
        expectedAddressRowVersion: 3,
        changes: { line2: 'Must roll back' },
      }),
      'OPERATIONS_SHIPMENT_ADDRESS_PROTECTED_DATA_UNREADABLE',
      500,
    )
    assert.deepEqual(
      await stateCounts(pool, primary),
      beforeProtectedFailure,
      'ciphertext failure must roll back receipt, audit, and working-copy state',
    )
    await pool.query(
      `UPDATE operations_order_shipment_address_working_copies
       SET ship_to_ciphertext = $3
       WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
      [primary.organizationId, primary.orderId, originalCiphertext],
    )

    const stalePlanId = await seedUnratedPlan(pool, primary)
    await pool.query(
      `UPDATE operations_orders SET status = 'planned'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, primary.orderId],
    )
    const plannedEdit = plain(await persistence
      .updateOperationsOrderShipmentAddressInPostgres({
        ...readyInput,
        idempotencyKey: 'shipment-address-planned-0007',
        expectedAddressRowVersion: 3,
        changes: { line2: 'Dock 4' },
      }))
    assert.equal(plannedEdit.rowVersion, 4)
    assert.equal(plannedEdit.rerateRequired, true)
    const plannedAddress = plain(await persistence
      .readOperationsOrderShipmentAddressInPostgres({
        organizationId: primary.organizationId,
        orderGlobalId: primary.orderGlobalId,
      }))
    assert.equal(plannedAddress.editable, true)
    assert.equal(plannedAddress.rerateRequired, true)
    await pool.query(
      `UPDATE operations_orders SET status = 'imported'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, primary.orderId],
    )
    await pool.query(
      `UPDATE operations_fulfillment_plans SET status = 'cancelled'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [primary.organizationId, stalePlanId],
    )

    await seedLabelFence(pool, primary)
    await expectAddressError(
      () => persistence.updateOperationsOrderShipmentAddressInPostgres({
        ...readyInput,
        idempotencyKey: 'shipment-address-label-fence-0008',
        expectedAddressRowVersion: 4,
        changes: { line2: 'Too late' },
      }),
      'OPERATIONS_SHIPMENT_ADDRESS_DOWNSTREAM_EVIDENCE_EXISTS',
      409,
    )

    const finalCounts = await stateCounts(pool, primary)
    assert.equal(finalCounts.working_copies, 1)
    assert.equal(finalCounts.receipts, 4)
    assert.equal(finalCounts.audits, 4)
    assert.equal(finalCounts.external_effect_intents, 0)
    assert.equal(initialCounts.external_effect_intents, 0)
    const protectedText = JSON.stringify((await pool.query(
      `SELECT encode(ship_to_ciphertext, 'base64') AS ciphertext,
              ship_to_state, source_order_hash, row_version::text
       FROM operations_order_shipment_address_working_copies
       WHERE organization_id = $1::uuid`,
      [primary.organizationId],
    )).rows[0])
    for (const secret of ['Vendor\u00a0Receiving', '10 Example Way', 'Charlotte', '28202']) {
      assert.ok(!protectedText.includes(secret), `database leaked ${secret}`)
    }
    assert.deepEqual(
      await canonicalSnapshot(pool, primary),
      {
        ...canonicalBefore,
        order: { ...canonicalBefore.order, status: 'imported' },
      },
      'shipment edits and fences must preserve canonical source/revision evidence',
    )
    assert.deepEqual(await stateCounts(pool, other), {
      working_copies: 0,
      receipts: 0,
      audits: 0,
      external_effect_intents: 0,
    })
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-shipment-address-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=shipment_address',
      '-e', 'POSTGRES_DB=shipment_address',
      '-p', '127.0.0.1::5432',
      process.env.CLAWPILOT_DISPOSABLE_POSTGRES_IMAGE || 'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = `postgresql://postgres:shipment_address@127.0.0.1:${port}/shipment_address`
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    try {
      const files = migrations()
      const target = '0310_operations_order_shipment_address_working_copy.sql'
      const targetIndex = files.indexOf(target)
      assert.ok(targetIndex > 0, '0310 shipment-address migration is missing')
      for (const file of files.slice(0, targetIndex + 1)) {
        await applyMigration(client, file)
      }
      const installed = await client.query(
        `SELECT
           to_regclass(
             'public.operations_order_shipment_address_working_copies'
           )::text AS table_name,
           EXISTS (
             SELECT 1 FROM pg_trigger
             WHERE tgrelid =
               'public.operations_order_shipment_address_working_copies'::regclass
               AND tgname =
                 'validate_operations_order_shipment_address_working_copy'
               AND NOT tgisinternal
           ) AS validation_trigger,
           to_regprocedure(
             'public.operations_order_dispatch_destination_matches(uuid,uuid,jsonb)'
           )::text AS effective_dispatch_matcher`,
      )
      assert.equal(
        installed.rows[0].table_name,
        'operations_order_shipment_address_working_copies',
      )
      assert.equal(installed.rows[0].validation_trigger, true)
      assert.equal(
        installed.rows[0].effective_dispatch_matcher,
        'operations_order_dispatch_destination_matches(uuid,uuid,jsonb)',
      )
      const activeValidators = await client.query(
        `SELECT proname, pg_get_functiondef(procedure.oid) AS definition
         FROM pg_proc procedure
         JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = 'public'
           AND proname = ANY($1::text[])
         ORDER BY proname`,
        [[
          'validate_operations_active_carrier_group_attempt_prepare',
          'validate_operations_production_rerate_attempt_insert',
          'validate_operations_production_rerate_run_insert',
          'validate_operations_production_rerate_selection_insert',
        ]],
      )
      assert.equal(activeValidators.rowCount, 4)
      for (const validator of activeValidators.rows) {
        assert.ok(
          validator.definition.includes(
            'operations_order_dispatch_destination_matches',
          ),
          `${validator.proname} still binds only operations_orders.ship_to`,
        )
      }
    } finally {
      client.release()
      await pool.end()
    }
    await verifyAcceptance(
      databaseUrl,
      fixture('0009801'),
      fixture('0009802'),
      nativeFixture('0009803'),
    )
    console.log('Operations order shipment-address PostgreSQL acceptance passed')
  } finally {
    command('docker', ['rm', '-f', container], { timeout: 30_000 })
  }
}

await main()
