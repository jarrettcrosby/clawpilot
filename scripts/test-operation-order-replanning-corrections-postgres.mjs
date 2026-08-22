#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import {
  actorEmail,
  command,
  loadTypeScriptModule,
  postgresAdapter,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const root = process.cwd()

function persistenceFor(pool) {
  const domain = loadTypeScriptModule('app_src/lib/operations/domain.ts', {
    '@/lib/operations/types': {},
  })
  const orderShipTo = loadTypeScriptModule(
    'app_src/lib/operations/orderShipTo.ts',
  )
  class RevisionGateError extends Error {}
  class NamedBoundaryError extends Error {}
  const noOp = async () => undefined
  const readShipmentAddress = async (input) => {
    const executor = input.client || pool
    const result = await executor.query(
      `SELECT global_id, row_version, status, ship_to
       FROM operations_orders
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND archived_at IS NULL
       LIMIT 1`,
      [input.organizationId, input.orderGlobalId],
    )
    const row = result.rows[0]
    if (!row) throw new NamedBoundaryError('Operations order was not found')
    const value = orderShipTo.normalizeOrderShipToDraft(row.ship_to)
    return {
      orderGlobalId: row.global_id,
      orderRowVersion: Number(row.row_version),
      rowVersion: 0,
      value,
      sourceValue: value,
      readiness: orderShipTo.orderShipToReadiness(value),
      issues: orderShipTo.orderShipToIssues(value),
      provenance: 'source',
      sourceVersionChanged: false,
      rerateRequired: false,
      editable: row.status !== 'shipped',
      editBlockedReason: row.status === 'shipped'
        ? 'Shipped orders are no longer editable.'
        : null,
      providerWrites: 0,
    }
  }
  return loadTypeScriptModule('app_src/lib/persistence/operations.ts', {
    '@/lib/auditWriter': { recordAuditEvent: noOp },
    '@/lib/crm/stableId': {
      normalizedCrmIdentityText: (value) => String(value || '').trim().toLowerCase(),
    },
    '@/lib/integrations/shopifyFulfillmentWriteback': {},
    '@/lib/integrations/shopifyOrderPlanningAuthority': {
      ShopifyOrderPlanningAuthorityError: NamedBoundaryError,
    },
    '@/lib/integrations/shopifyExternalFulfillmentReconciliation': {
      ShopifyExternalFulfillmentReconciliationError: NamedBoundaryError,
    },
    '@/lib/integrations/faireFulfillmentRuntime': {},
    '@/lib/commerceFulfillmentRecoveryPolicy': {},
    '@/lib/persistence/sandboxCommerceE2eAuthorization': {},
    '@/lib/persistence/shopifyTestStoreCanonicalE2e': {},
    '@/lib/persistence/commerceOrderRevisions': {
      assertCommerceOrderRevisionExecutionCurrent: noOp,
      CommerceOrderRevisionGateError: RevisionGateError,
    },
    '@/lib/operations/adapters': {},
    '@/lib/operations/domain': domain,
    '@/lib/operations/orderShipTo': orderShipTo,
    '@/lib/operations/packingSlip': {
      PACKAGE_PACK_WORK_INSTRUCTION_TEMPLATE_VERSION: 'test-pack-work-v1',
      PACKING_SLIP_TEMPLATE_VERSION: 'test-packing-slip-v1',
    },
    '@/lib/operations/barcodeLabels': {},
    '@/lib/operations/canonicalFulfillmentPlanning': {
      CANONICAL_FULFILLMENT_RATE_POLICY_VERSION: 'test-rate-policy-v1',
      CanonicalFulfillmentPlanningError: NamedBoundaryError,
    },
    '@/lib/integrations/carrierCheckoutRate': {
      CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS: 8,
    },
    '@/lib/integrations/carrierIntegrations': {},
    '@/lib/operations/pickManagement': {},
    '@/lib/persistence/crm': {},
    '@/lib/persistence/cartonizationRateEvidence': {},
    '@/lib/persistence/commerceOrderWorkbench': {
      readCommerceOrderWorkbenchFromPostgres: async () => [],
    },
    '@/lib/persistence/commerceStoreSync': {
      readCommerceStoreSyncControlsFromPostgres: async () => [],
    },
    '@/lib/persistence/operationPrintDelivery': {},
    '@/lib/persistence/operationShadowFulfillmentPreparation': {
      readShadowFulfillmentPreparation: async () => null,
    },
    '@/lib/persistence/operationShadowTraining': {
      assertNoOpenOperationsShadowTrainingRunsForActivation: noOp,
    },
    '@/lib/persistence/operationsOrderShipmentAddress': {
      readOperationsOrderShipmentAddressInPostgres: readShipmentAddress,
    },
    '@/lib/persistence/productPackaging': {},
    '@/lib/persistence/postgres': postgresAdapter(pool),
    '@/lib/persistence/shopifyCheckoutRating': {
      ShopifyCheckoutRatingPersistenceError: NamedBoundaryError,
    },
  })
}

async function withReplicaSession(pool, work) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    return await work(client)
  } finally {
    await client.query('SET session_replication_role = origin')
      .catch(() => undefined)
    client.release()
  }
}

function idsFor(index) {
  const numeric = String(9_100 + index).padStart(7, '0')
  return {
    numeric,
    organization: randomUUID(),
    pipeline: randomUUID(),
    customer: randomUUID(),
    integration: randomUUID(),
    product: randomUUID(),
    order: randomUUID(),
    line: randomUUID(),
    warehouse: randomUUID(),
    location: randomUUID(),
    pool: randomUUID(),
    position: randomUUID(),
    reservation: randomUUID(),
    plan: randomUUID(),
    allocation: randomUUID(),
    package: randomUUID(),
    material: randomUUID(),
    stock: randomUUID(),
    claim: randomUUID(),
    observation: randomUUID(),
    target: randomUUID(),
    read: randomUUID(),
  }
}

async function seedFixture(pool, {
  index,
  status,
  activationState = 'active',
}) {
  const ids = idsFor(index)
  const acceptedSourceHash = String(index).repeat(64).slice(0, 64)
  const acceptedRevisionHash = String(index + 4).repeat(64).slice(0, 64)
  const promisedDelivery = new Date(Date.now() + 86_400_000).toISOString()
  await withReplicaSession(pool, async (client) => {
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, reference_code
       ) VALUES ($1::uuid, $2, 'member', $3)`,
      [ids.organization, `Replanning correction ${index}`, `ga${ids.numeric}`],
    )
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, is_default, workspace_organization_id
       ) VALUES ($1::uuid, $2, $3, true, $4::uuid)`,
      [ids.pipeline, `Replanning correction ${index}`, actorEmail, ids.organization],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision,
         reason, updated_by
       ) VALUES ($1::uuid, $2::uuid, $3, 7, $4, $5)`,
      [
        ids.organization,
        ids.pipeline,
        activationState,
        `Exact ${activationState} correction test`,
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
         $1::uuid, $2, $3::uuid, 'shopify', 'commerce', 'production',
         $4, 'active', $5::jsonb, $6, 1, $7, $7
       )`,
      [
        ids.integration,
        `gia${ids.numeric}`,
        ids.organization,
        `Replanning Shopify ${index}`,
        JSON.stringify({ shopDomain: `replanning-${index}.myshopify.com` }),
        `gid://shopify/Shop/${9_100 + index}`,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO crm_reference_registry (
         reference_code, prefix, canonical_code, status, entity_type
       ) VALUES ($1, 'gor', $1, 'active', 'operations.order')`,
      [`gor${ids.numeric}`],
    )
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, source_key, identity_key, name,
         relationship_type, source_payload, source_hash,
         sync_status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, 'customer',
         '{}'::jsonb, $6, 'synced', $7, $7
       )`,
      [
        ids.customer,
        ids.pipeline,
        `replanning-customer-${index}`,
        `customer:replanning-${index}`,
        `Replanning customer ${index}`,
        'c'.repeat(64),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO crm_products (
         id, pipeline_id, source_key, name, sku, product_type,
         price, cost, currency, source_hash, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, 'Good',
         10.00, 4.00, 'USD', $6, $7, $7
       )`,
      [
        ids.product,
        ids.pipeline,
        `replanning-product-${index}`,
        `Replanning product ${index}`,
        `REPLAN-${index}`,
        'd'.repeat(64),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_orders (
         id, global_id, organization_id, pipeline_id, customer_id,
         integration_account_id, source_provider, external_order_id,
         order_number, order_type, status, currency,
         merchandise_total_minor, promised_delivery_at, ship_to,
         source_payload, row_version, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, 'shopify', $7, $8, 'standard', $9, 'USD',
         2000, $10::timestamptz, $11::jsonb, $12::jsonb,
         3, $13, $13
       )`,
      [
        ids.order,
        `gor${ids.numeric}`,
        ids.organization,
        ids.pipeline,
        ids.customer,
        ids.integration,
        `gid://shopify/Order/${9_100 + index}`,
        `#${9_100 + index}`,
        status,
        promisedDelivery,
        JSON.stringify({
          name: 'Replanning recipient',
          line1: '35 Saxony Drive',
          city: 'Trumbull',
          region: 'CT',
          postalCode: '06611',
          country: 'US',
        }),
        JSON.stringify({ sourceHash: acceptedSourceHash }),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_order_lines (
         id, global_id, organization_id, order_id, pipeline_id,
         product_id, external_line_id, channel_sku, description,
         quantity, unit_price_minor, weight_grams, dimensions_mm
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, $7, $8, $9, 2, 1000, 500,
         '{"length":200,"width":150,"height":100}'::jsonb
       )`,
      [
        ids.line,
        `gol${ids.numeric}`,
        ids.organization,
        ids.order,
        ids.pipeline,
        ids.product,
        `gid://shopify/LineItem/${9_100 + index}`,
        `REPLAN-${index}`,
        `Replanning product ${index}`,
      ],
    )
    await client.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, timezone,
         address, status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4, $5, 'America/New_York',
         $6::jsonb, 'active', $7, $7
       )`,
      [
        ids.warehouse,
        `gwh${ids.numeric}`,
        ids.organization,
        `REPLAN-${index}`,
        `Replanning warehouse ${index}`,
        JSON.stringify({
          name: 'Replanning warehouse', line1: '35 Saxony Drive',
          city: 'Trumbull', region: 'CT', postalCode: '06611', country: 'US',
        }),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_locations (
         id, global_id, organization_id, warehouse_id,
         code, zone, location_type, pick_sequence, active, created_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid,
         'A-01', 'STORAGE', 'pick', 1, true, $5
       )`,
      [ids.location, `gwl${ids.numeric}`, ids.organization, ids.warehouse, actorEmail],
    )
    await client.query(
      `INSERT INTO operations_inventory_pools (
         id, global_id, organization_id, pipeline_id, name,
         pool_type, allocation_policy, active, created_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5,
         'shared', 'fifo', true, $6
       )`,
      [ids.pool, `gip${ids.numeric}`, ids.organization, ids.pipeline, `Pool ${index}`, actorEmail],
    )
    await client.query(
      `INSERT INTO operations_inventory_positions (
         id, global_id, organization_id, pipeline_id, warehouse_id,
         location_id, pool_id, product_id, lot_code,
         on_hand_quantity, reserved_quantity, damaged_quantity,
         version, source_authority
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, $8::uuid, '', 10, 2, 0, 4, 'clawpilot'
       )`,
      [
        ids.position,
        `giv${ids.numeric}`,
        ids.organization,
        ids.pipeline,
        ids.warehouse,
        ids.location,
        ids.pool,
        ids.product,
      ],
    )
    await client.query(
      `INSERT INTO operations_reservations (
         id, global_id, organization_id, order_id, order_line_id,
         position_id, quantity, status, idempotency_key,
         reservation_authority, created_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, 2, 'active', $7, 'local_balance', $8
       )`,
      [
        ids.reservation,
        `grs${ids.numeric}`,
        ids.organization,
        ids.order,
        ids.line,
        ids.position,
        `replanning-reservation-${index}`,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_fulfillment_plans (
         id, global_id, organization_id, order_id, warehouse_id,
         version_number, status, method, solver_status,
         estimated_cost_minor, estimated_revenue_minor,
         estimated_margin_minor, promised_delivery_at,
         explanation, created_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         1, $6, 'manual_override', 'accepted', 500, 2000, 1500,
         $7::timestamptz, '{"fixture":"replanning-correction"}'::jsonb, $8
       )`,
      [
        ids.plan,
        `gfp${ids.numeric}`,
        ids.organization,
        ids.order,
        ids.warehouse,
        status,
        promisedDelivery,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_fulfillment_allocations (
         id, global_id, organization_id, plan_id, order_line_id,
         reservation_id, position_id, quantity
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, 2
       )`,
      [
        ids.allocation,
        `gfa${ids.numeric}`,
        ids.organization,
        ids.plan,
        ids.line,
        ids.reservation,
        ids.position,
      ],
    )
    await client.query(
      `INSERT INTO operations_packages (
         id, global_id, organization_id, plan_id, package_number,
         length_mm, width_mm, height_mm, weight_grams, status
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, 1,
         250, 200, 150, 1100, 'planned'
       )`,
      [ids.package, `gpa${ids.numeric}`, ids.organization, ids.plan],
    )
    await client.query(
      `INSERT INTO operations_packaging_materials (
         id, global_id, organization_id, code, name, material_type,
         inner_length_mm, inner_width_mm, inner_height_mm,
         tare_weight_grams, max_weight_grams, unit_cost_minor,
         currency, status, source, dimension_basis,
         dimension_evidence_type, dimension_evidence_reference,
         dimension_confirmed_at, dimension_confirmed_by,
         rated_outer_length_mm, rated_outer_width_mm,
         rated_outer_height_mm, rated_outer_dimension_evidence_type,
         rated_outer_dimension_evidence_reference,
         rated_outer_dimension_confirmed_at,
         rated_outer_dimension_confirmed_by, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4, $5, 'carton',
         250, 200, 150, 100, 5000, 50, 'USD', 'active', 'manual', 'inner',
         'measured', $6, now(), $7,
         250, 200, 150, 'measured', $6, now(), $7, $7, $7
       )`,
      [
        ids.material,
        `gmat${ids.numeric}`,
        ids.organization,
        `REPLAN-BOX-${index}`,
        `Replanning carton ${index}`,
        `replanning-measurement-${index}`,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_packaging_material_stock (
         id, global_id, organization_id, packaging_material_id,
         warehouse_id, is_available, on_hand_quantity, row_version,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         true, 10, 2, $6, $6
       )`,
      [ids.stock, `gmas${ids.numeric}`, ids.organization, ids.material, ids.warehouse, actorEmail],
    )
    await client.query(
      `INSERT INTO operations_packaging_material_claims (
         id, global_id, organization_id, plan_id,
         packaging_material_id, warehouse_id,
         packaging_material_stock_id, quantity, status,
         stock_row_version_at_claim, on_hand_quantity_at_claim,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, $7::uuid, 1, 'active', 2, 10, $8, $8
       )`,
      [
        ids.claim,
        `gpmc${ids.numeric}`,
        ids.organization,
        ids.plan,
        ids.material,
        ids.warehouse,
        ids.stock,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_revision_observations (
         id, global_id, organization_id, integration_account_id,
         target_id, order_id, provider, credential_generation,
         external_order_id, source_revision, source_hash, revision_hash,
         normalized_snapshot, canonical_row_version,
         provider_read_count, provider_write_count, observed_at
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         'shopify', 1, $7, 'replanning-revision-v1', $8, $9,
         '{}'::jsonb, 3, 1, 0, now()
       )`,
      [
        ids.observation,
        `gcor${ids.numeric}`,
        ids.organization,
        ids.integration,
        ids.target,
        ids.order,
        `gid://shopify/Order/${9_100 + index}`,
        acceptedSourceHash,
        acceptedRevisionHash,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_revision_reads (
         id, global_id, organization_id, integration_account_id,
         target_id, observation_id, order_id, provider,
         credential_generation, source_hash, revision_hash,
         canonical_row_version, trigger_kind, provider_read_count,
         provider_write_count, observed_at, protected_snapshot_expires_at
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7::uuid, 'shopify', 1, $8, $9, 3,
         'scheduled', 1, 0, now(), now() + interval '1 day'
       )`,
      [
        ids.read,
        `gcrr${ids.numeric}`,
        ids.organization,
        ids.integration,
        ids.target,
        ids.observation,
        ids.order,
        acceptedSourceHash,
        acceptedRevisionHash,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_revision_targets (
         id, organization_id, integration_account_id, order_id, provider,
         accepted_source_hash, latest_source_hash, latest_observation_id,
         material_state, claim_state, attempt_count, next_check_at,
         checked_at, row_version, latest_read_id, accepted_observation_id,
         accepted_read_id, accepted_revision_hash
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify',
         $5, $5, $6::uuid, 'current', 'ready', 1,
         now() + interval '1 day', now(), 5, $7::uuid, $6::uuid,
         $7::uuid, $8
       )`,
      [
        ids.target,
        ids.organization,
        ids.integration,
        ids.order,
        acceptedSourceHash,
        ids.observation,
        ids.read,
        acceptedRevisionHash,
      ],
    )
  })
  return {
    ids,
    status,
    orderGlobalId: `gor${ids.numeric}`,
    planGlobalId: `gfp${ids.numeric}`,
  }
}

async function projectedAction(persistence, fixture) {
  const workspace = await persistence.readOperationsWorkspaceFromPostgres({
    organizationId: fixture.ids.organization,
    capabilities: {
      canView: true,
      canManage: true,
      canExecute: true,
      canActivate: false,
    },
    selectedOrderGlobalId: fixture.orderGlobalId,
  })
  const action = workspace.selectedOrder?.availableActions.find(
    (candidate) => candidate.action === 'reopen_for_replanning',
  )
  assert.ok(action, 'Server must project the correction action on order detail')
  return action
}

async function verifyCorrection(pool, persistence, fixture) {
  const action = await projectedAction(persistence, fixture)
  assert.equal(action.enabled, true)
  assert.equal(action.expectedPlanGlobalId, fixture.planGlobalId)
  assert.equal(action.expectedPlanVersion, 1)
  assert.match(action.expectedCorrectionFingerprint, /^[a-f0-9]{64}$/u)
  const input = {
    organizationId: fixture.ids.organization,
    actorEmail,
    orderGlobalId: fixture.orderGlobalId,
    expectedRowVersion: 3,
    expectedPlanGlobalId: fixture.planGlobalId,
    expectedPlanVersion: 1,
    expectedCorrectionFingerprint: action.expectedCorrectionFingerprint,
    reason: 'Manager corrected the local warehouse plan',
    idempotencyKey: `replanning-correction-${fixture.status}-stable`,
  }
  const result = await persistence
    .reopenOperationsOrderForReplanningInPostgres(input)
  assert.deepEqual(
    {
      status: result.orderStatus,
      previousRowVersion: result.previousRowVersion,
      rowVersion: result.rowVersion,
      cancelledPlanGlobalId: result.cancelledPlanGlobalId,
      releasedLocalReservationCount: result.releasedLocalReservationCount,
      releasedProviderCommitmentCount:
        result.releasedProviderCommitmentCount,
      releasedPackagingClaimCount: result.releasedPackagingClaimCount,
      providerReads: result.providerReads,
      providerWrites: result.providerWrites,
      replayed: result.replayed,
    },
    {
      status: 'imported',
      previousRowVersion: 3,
      rowVersion: 4,
      cancelledPlanGlobalId: fixture.planGlobalId,
      releasedLocalReservationCount: 1,
      releasedProviderCommitmentCount: 0,
      releasedPackagingClaimCount: 1,
      providerReads: 0,
      providerWrites: 0,
      replayed: false,
    },
  )
  assert.match(result.correctionGlobalId, /^gorc[0-9a-v]{12}$/u)

  const retained = await pool.query(
    `SELECT source_order.status AS order_status,
            source_order.row_version::integer AS order_row_version,
            plan.status AS plan_status,
            reservation.status AS reservation_status,
            position.reserved_quantity::text AS reserved_quantity,
            position.version::integer AS position_version,
            claim.status AS claim_status,
            correction.provider_read_count,
            correction.provider_write_count,
            correction.compensation_snapshot,
            (SELECT count(*)::integer
             FROM operations_inventory_ledger ledger
             WHERE ledger.organization_id = source_order.organization_id
               AND ledger.event_type = 'reservation_release') AS ledger_count,
            (SELECT count(*)::integer
             FROM operations_domain_events event
             WHERE event.organization_id = source_order.organization_id
               AND event.event_type = 'operations.order.reopened_for_replanning')
              AS event_count,
            (SELECT count(*)::integer
             FROM operations_order_replanning_corrections evidence
             WHERE evidence.organization_id = source_order.organization_id)
              AS correction_count
     FROM operations_orders source_order
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = source_order.organization_id
      AND plan.id = $3::uuid
     JOIN operations_reservations reservation
       ON reservation.organization_id = source_order.organization_id
      AND reservation.id = $4::uuid
     JOIN operations_inventory_positions position
       ON position.organization_id = reservation.organization_id
      AND position.id = reservation.position_id
     JOIN operations_packaging_material_claims claim
       ON claim.organization_id = source_order.organization_id
      AND claim.id = $5::uuid
     JOIN operations_order_replanning_corrections correction
       ON correction.organization_id = source_order.organization_id
      AND correction.order_id = source_order.id
     WHERE source_order.organization_id = $1::uuid
       AND source_order.id = $2::uuid`,
    [
      fixture.ids.organization,
      fixture.ids.order,
      fixture.ids.plan,
      fixture.ids.reservation,
      fixture.ids.claim,
    ],
  )
  assert.equal(retained.rowCount, 1)
  const row = retained.rows[0]
  assert.deepEqual(
    {
      orderStatus: row.order_status,
      orderRowVersion: row.order_row_version,
      planStatus: row.plan_status,
      reservationStatus: row.reservation_status,
      reservedQuantity: row.reserved_quantity,
      positionVersion: row.position_version,
      claimStatus: row.claim_status,
      providerReads: row.provider_read_count,
      providerWrites: row.provider_write_count,
      ledgerCount: row.ledger_count,
      eventCount: row.event_count,
      correctionCount: row.correction_count,
    },
    {
      orderStatus: 'imported',
      orderRowVersion: 4,
      planStatus: 'cancelled',
      reservationStatus: 'released',
      reservedQuantity: '0.000000',
      positionVersion: 5,
      claimStatus: 'released',
      providerReads: 0,
      providerWrites: 0,
      ledgerCount: 1,
      eventCount: 1,
      correctionCount: 1,
    },
  )
  assert.equal(row.compensation_snapshot.providerReads, 0)
  assert.equal(row.compensation_snapshot.providerWrites, 0)

  const replay = await persistence
    .reopenOperationsOrderForReplanningInPostgres(input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.correctionGlobalId, result.correctionGlobalId)
  const replayCounts = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_order_replanning_corrections
        WHERE organization_id = $1::uuid) AS corrections,
       (SELECT count(*)::integer
        FROM operations_inventory_ledger
        WHERE organization_id = $1::uuid
          AND event_type = 'reservation_release') AS releases`,
    [fixture.ids.organization],
  )
  assert.deepEqual(replayCounts.rows[0], { corrections: 1, releases: 1 })
  await assert.rejects(
    pool.query(
      `UPDATE operations_order_replanning_corrections
       SET reason = 'Attempt to rewrite immutable correction evidence'
       WHERE organization_id = $1::uuid`,
      [fixture.ids.organization],
    ),
    /immutable/u,
  )
  await assert.rejects(
    pool.query(
      `DELETE FROM operations_order_replanning_corrections
       WHERE organization_id = $1::uuid`,
      [fixture.ids.organization],
    ),
    /immutable/u,
  )
}

async function verifyExactAuthorityBlockers(pool, persistence) {
  const wrongTarget = await seedFixture(pool, { index: 3, status: 'planned' })
  await withReplicaSession(pool, (client) => client.query(
    `UPDATE operations_commerce_order_revision_targets
     SET provider = 'faire'
     WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
    [wrongTarget.ids.organization, wrongTarget.ids.order],
  ))
  const targetAction = await projectedAction(persistence, wrongTarget)
  assert.equal(targetAction.enabled, false)
  assert.equal(targetAction.blockedCode, 'OPERATIONS_REPLANNING_REVISION_STALE')
  assert.equal(targetAction.expectedCorrectionFingerprint, null)

  const extraReservation = await seedFixture(pool, { index: 4, status: 'planned' })
  const extraPositionId = randomUUID()
  await withReplicaSession(pool, async (client) => {
    await client.query(
      `INSERT INTO operations_inventory_positions (
         id, global_id, organization_id, pipeline_id, warehouse_id,
         location_id, pool_id, product_id, lot_code,
         on_hand_quantity, reserved_quantity, damaged_quantity,
         version, source_authority
       ) VALUES (
         $1::uuid, 'giv0091994', $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, $7::uuid, 'extra', 10, 1, 0, 1, 'clawpilot'
       )`,
      [
        extraPositionId,
        extraReservation.ids.organization,
        extraReservation.ids.pipeline,
        extraReservation.ids.warehouse,
        extraReservation.ids.location,
        extraReservation.ids.pool,
        extraReservation.ids.product,
      ],
    )
    await client.query(
      `INSERT INTO operations_reservations (
         global_id, organization_id, order_id, order_line_id,
         position_id, quantity, status, idempotency_key,
         reservation_authority, created_by
       ) VALUES (
         'grs0091994', $1::uuid, $2::uuid, $3::uuid,
         $4::uuid, 1, 'active', 'replanning-extra-reservation',
         'local_balance', $5
       )`,
      [
        extraReservation.ids.organization,
        extraReservation.ids.order,
        extraReservation.ids.line,
        extraPositionId,
        actorEmail,
      ],
    )
  })
  const reservationAction = await projectedAction(persistence, extraReservation)
  assert.equal(reservationAction.enabled, false)
  assert.equal(
    reservationAction.blockedCode,
    'OPERATIONS_REPLANNING_COMMITMENTS_CHANGED',
  )

  const wrongAllocationPosition = await seedFixture(pool, {
    index: 6,
    status: 'planned',
  })
  const unrelatedPositionId = randomUUID()
  await withReplicaSession(pool, async (client) => {
    await client.query(
      `INSERT INTO operations_inventory_positions (
         id, global_id, organization_id, pipeline_id, warehouse_id,
         location_id, pool_id, product_id, lot_code,
         on_hand_quantity, reserved_quantity, damaged_quantity,
         version, source_authority
       ) VALUES (
         $1::uuid, 'giv0091996', $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, $7::uuid, 'wrong-allocation',
         10, 0, 0, 1, 'clawpilot'
       )`,
      [
        unrelatedPositionId,
        wrongAllocationPosition.ids.organization,
        wrongAllocationPosition.ids.pipeline,
        wrongAllocationPosition.ids.warehouse,
        wrongAllocationPosition.ids.location,
        wrongAllocationPosition.ids.pool,
        wrongAllocationPosition.ids.product,
      ],
    )
    await client.query(
      `UPDATE operations_fulfillment_allocations
       SET position_id = $3::uuid
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        wrongAllocationPosition.ids.organization,
        wrongAllocationPosition.ids.allocation,
        unrelatedPositionId,
      ],
    )
  })
  const allocationAction = await projectedAction(
    persistence,
    wrongAllocationPosition,
  )
  assert.equal(allocationAction.enabled, false)
  assert.equal(
    allocationAction.blockedCode,
    'OPERATIONS_REPLANNING_COMMITMENTS_CHANGED',
  )

  const released = await seedFixture(pool, { index: 5, status: 'released' })
  const releasedAction = await projectedAction(persistence, released)
  assert.equal(releasedAction.enabled, false)
  assert.equal(
    releasedAction.blockedCode,
    'OPERATIONS_REPLANNING_RELEASED_RECALL_REQUIRED',
  )
  assert.match(releasedAction.blockedReason, /every picker device/u)
  assert.equal(releasedAction.expectedCorrectionFingerprint, null)

  for (const [index, activationState] of [
    [7, 'disabled'],
    [8, 'frozen'],
  ]) {
    const emergency = await seedFixture(pool, {
      index,
      status: 'planned',
      activationState,
    })
    const emergencyAction = await projectedAction(persistence, emergency)
    assert.equal(emergencyAction.enabled, false)
    assert.equal(
      emergencyAction.blockedCode,
      'OPERATIONS_REPLANNING_SAFETY_PROFILE_BLOCKED',
    )
    assert.equal(emergencyAction.expectedCorrectionFingerprint, null)
  }
}

async function verify(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  try {
    await pool.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [actorEmail],
    )
    const persistence = persistenceFor(pool)
    for (const [index, activationState] of [
      [1, 'active'],
      [2, 'shadow'],
      [9, 'read_only'],
    ]) {
      await verifyCorrection(
        pool,
        persistence,
        await seedFixture(pool, {
          index,
          status: 'planned',
          activationState,
        }),
      )
    }
    await verifyExactAuthorityBlockers(pool, persistence)

    const source = String(
      await import('node:fs/promises').then(({ readFile }) => readFile(
        resolve(root, 'app_src/lib/persistence/operations.ts'),
        'utf8',
      )),
    )
    assert.match(
      source,
      /COALESCE\(max\(version_number\), 0\)::integer \+ 1/u,
      'Replanning must append MAX(version)+1 after cancelled history',
    )
    assert.match(
      source,
      /newer_plan\.status <> 'cancelled'/u,
      'Demand must use only the latest non-cancelled plan generation',
    )
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container =
    `clawpilot-replanning-correction-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=replanning_correction',
      '-e', 'POSTGRES_DB=replanning_correction',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:replanning_correction@127.0.0.1:'
      + `${port}/replanning_correction`
    )
    await waitForPostgres(databaseUrl)
    command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PGSSLMODE: 'disable',
      },
      timeout: 300_000,
    })
    await verify(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'Operations order replanning correction disposable-PostgreSQL acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
