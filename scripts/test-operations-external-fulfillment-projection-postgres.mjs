#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import {
  actorEmail,
  command,
  loadTypeScriptModule,
  postgresAdapter,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function providerTimelineReaderFor(pool) {
  return async (input) => {
    const observation = (await pool.query(
      `SELECT observation.id::text, observation.global_id,
              observation.observed_at, observation.provider_updated_at
       FROM operations_commerce_order_observations observation
       JOIN operations_integration_accounts account
         ON account.organization_id = observation.organization_id
        AND account.id = observation.integration_account_id
        AND account.provider = observation.provider
       WHERE observation.organization_id = $1::uuid
         AND account.global_id = $2
         AND observation.external_order_id = $3
         AND observation.observation_kind = ANY($4::text[])
       ORDER BY (
                  COALESCE(
                    observation.provider_updated_at,
                    observation.observed_at
                  ),
                  observation.observed_at,
                  observation.id
                ) DESC
       LIMIT 1`,
      [
        input.organizationId,
        input.accountGlobalId,
        input.externalOrderId,
        input.providerObservationKinds || [
          'manual_exact_read',
          'webhook_exact_read',
        ],
      ],
    )).rows[0]
    if (!observation) {
      return { items: [], truncated: false, limit: 500, providerWrites: 0 }
    }
    const [lines, events] = await Promise.all([
      pool.query(
        `SELECT external_line_id, external_product_id, external_variant_id,
                sku, title_snapshot, variant_title_snapshot, vendor_snapshot,
                original_quantity::text, current_quantity::text,
                unfulfilled_quantity::text, fulfilled_quantity::text,
                returned_quantity::text, requires_shipping
                , unit_price_currency, unit_price_minor::text
                , subtotal_currency, subtotal_minor::text
                , discount_currency, discount_minor::text
                , tax_currency, tax_minor::text
         FROM operations_commerce_order_observation_lines
         WHERE organization_id = $1::uuid
           AND observation_id = $2::uuid
         ORDER BY external_line_id`,
        [input.organizationId, observation.id],
      ),
      pool.query(
        `SELECT global_id, event_kind, event_status, occurred_at,
                external_subject_id, quantity::text, amount_minor::text,
                currency, tracking_carrier,
                CASE WHEN sensitive_evidence_expires_at > now()
                  THEN tracking_number ELSE NULL END AS tracking_number,
                CASE WHEN sensitive_evidence_expires_at > now()
                  THEN tracking_url ELSE NULL END AS tracking_url,
                sensitive_evidence_redacted_at, provider_location_id
         FROM operations_commerce_order_event_observations
         WHERE organization_id = $1::uuid
           AND observation_id = $2::uuid
         ORDER BY occurred_at, id`,
        [input.organizationId, observation.id],
      ),
    ])
    const optionalNumber = (value) => value === null ? null : Number(value)
    return {
      items: [
        ...events.rows.map((event) => ({
          evidenceSource: 'provider',
          evidenceGlobalId: event.global_id,
          eventKind: event.event_kind,
          eventStatus: event.event_status,
          occurredAt: event.occurred_at.toISOString(),
          attributionSource: 'provider_system',
          actorEmail: null,
          providerActorFingerprint: null,
          locationReference: event.provider_location_id,
          payload: {
            externalSubjectId: event.external_subject_id,
            quantity: optionalNumber(event.quantity),
            amountMinor: optionalNumber(event.amount_minor),
            currency: event.currency,
            trackingCarrier: event.tracking_carrier,
            trackingNumber: event.tracking_number,
            trackingUrl: event.tracking_url,
            sensitiveEvidenceRedactedAt:
              event.sensitive_evidence_redacted_at?.toISOString() || null,
          },
        })),
        {
          evidenceSource: 'provider',
          evidenceGlobalId: observation.global_id,
          eventKind: 'order_lines_snapshot',
          eventStatus: null,
          occurredAt: (
            observation.provider_updated_at || observation.observed_at
          ).toISOString(),
          attributionSource: 'provider_system',
          actorEmail: null,
          providerActorFingerprint: null,
          locationReference: null,
          payload: {
            observationGlobalId: observation.global_id,
            observedAt: observation.observed_at
              .toISOString()
              .replace('Z', '+00:00'),
            inventorySemantics: 'order_demand',
            lines: lines.rows.map((line) => ({
              externalLineId: line.external_line_id,
              externalProductId: line.external_product_id,
              externalVariantId: line.external_variant_id,
              sku: line.sku,
              titleSnapshot: line.title_snapshot,
              variantTitleSnapshot: line.variant_title_snapshot,
              vendorSnapshot: line.vendor_snapshot,
              originalQuantity: Number(line.original_quantity),
              currentQuantity: optionalNumber(line.current_quantity),
              unfulfilledQuantity: optionalNumber(line.unfulfilled_quantity),
              fulfilledQuantity: optionalNumber(line.fulfilled_quantity),
              returnedQuantity: optionalNumber(line.returned_quantity),
              requiresShipping: line.requires_shipping,
              unitPriceCurrency: line.unit_price_currency,
              unitPriceMinor: line.unit_price_minor,
              subtotalCurrency: line.subtotal_currency,
              subtotalMinor: line.subtotal_minor,
              discountCurrency: line.discount_currency,
              discountMinor: line.discount_minor,
              taxCurrency: line.tax_currency,
              taxMinor: line.tax_minor,
            })),
          },
        },
      ],
      truncated: false,
      limit: 500,
      providerWrites: 0,
    }
  }
}

function operationsPersistenceFor(pool) {
  const domain = loadTypeScriptModule('app_src/lib/operations/domain.ts', {
    '@/lib/operations/types': {},
  })
  const orderShipTo = loadTypeScriptModule(
    'app_src/lib/operations/orderShipTo.ts',
  )
  const providerOrderHistory = loadTypeScriptModule(
    'app_src/lib/operations/providerOrderHistory.ts',
  )
  const providerOrderMoney = loadTypeScriptModule(
    'app_src/lib/operations/providerOrderMoney.ts',
  )
  class NamedBoundaryError extends Error {}
  class RevisionGateError extends Error {}
  const noOp = async () => undefined

  return loadTypeScriptModule('app_src/lib/persistence/operations.ts', {
    '@/lib/auditWriter': { recordAuditEvent: noOp },
    '@/lib/crm/stableId': {
      normalizedCrmIdentityText: (value) => (
        String(value || '').trim().toLowerCase()
      ),
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
    '@/lib/operations/providerOrderHistory': providerOrderHistory,
    '@/lib/operations/providerOrderMoney': providerOrderMoney,
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
        providerTimelineReaderFor(pool),
    },
    '@/lib/persistence/commerceProviderWrites': {
      CommerceProviderWriteControlError: NamedBoundaryError,
      readCommerceProviderWriteControlsFromPostgres: async () => ({
        accounts: [],
      }),
      requireCurrentCommerceProviderWritesInPostgres: async () => {
        throw new Error(
          'External-fulfillment projection must not authorize provider writes',
        )
      },
    },
    '@/lib/persistence/commerceStoreSync': {
      readCommerceStoreSyncControlsFromPostgres: async () => [],
    },
    '@/lib/persistence/orderUnitWeightEvidence': {
      assertCurrentOrderUnitWeightEvidence: noOp,
    },
    '@/lib/persistence/operationPrintDelivery': {},
    '@/lib/persistence/operationShadowFulfillmentPreparation': {
      readShadowFulfillmentPreparation: async () => null,
    },
    '@/lib/persistence/operationsOrderShipmentAddress': {
      readOperationsOrderShipmentAddressInPostgres: async (input) => {
        const result = await pool.query(
          `SELECT global_id, row_version::text, status, ship_to
           FROM operations_orders
           WHERE organization_id = $1::uuid
             AND global_id = $2
             AND archived_at IS NULL
           LIMIT 1`,
          [input.organizationId, input.orderGlobalId],
        )
        const row = result.rows[0]
        assert.ok(row, 'selected projection order exists')
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
          editBlockedReason: null,
          providerWrites: 0,
        }
      },
    },
    '@/lib/persistence/productPackaging': {},
    '@/lib/persistence/postgres': postgresAdapter(pool),
    '@/lib/persistence/shopifyCheckoutRating': {},
  })
}

function fixtureIds() {
  return {
    organization: randomUUID(),
    pipeline: randomUUID(),
    integration: randomUUID(),
    customer: randomUUID(),
    longCustomer: randomUUID(),
    product: randomUUID(),
    fulfilledProduct: randomUUID(),
    fulfilledOrder: randomUUID(),
    dueOrder: randomUUID(),
    openOrder: randomUUID(),
    shippedOrder: randomUUID(),
    nativeOrder: randomUUID(),
    target: randomUUID(),
    observation: randomUUID(),
    read: randomUUID(),
    providerObservation: randomUUID(),
    newerProviderObservation: randomUUID(),
    newerProviderBackfillSession: randomUUID(),
    providerCandidate: randomUUID(),
    providerRun: randomUUID(),
    providerEvent: randomUUID(),
    unrelatedBlankTrackingEvent: randomUUID(),
    fulfilledLine: randomUUID(),
    warehouse: randomUUID(),
    location: randomUUID(),
    inventoryPool: randomUUID(),
    locationMapping: randomUUID(),
    removalObservation: randomUUID(),
    retainedTrackingEvent: randomUUID(),
    removedTrackingEvent: randomUUID(),
    reconciliation: randomUUID(),
    unrelatedBlankReconciliation: randomUUID(),
  }
}

async function seedFixture(pool) {
  const ids = fixtureIds()
  const acceptedHash = 'a'.repeat(64)
  const fulfilledHash = 'b'.repeat(64)
  const revisionHash = 'c'.repeat(64)
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [actorEmail],
    )
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, reference_code
       ) VALUES (
         $1::uuid, 'External fulfillment projection acceptance',
         'member', 'ga0009701'
       )`,
      [ids.organization],
    )
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, is_default, workspace_organization_id
       ) VALUES (
         $1::uuid, 'External fulfillment projection acceptance',
         $2, true, $3::uuid
       )`,
      [ids.pipeline, actorEmail, ids.organization],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision
       ) VALUES ($1::uuid, $2::uuid, 'shadow', 1)`,
      [ids.organization, ids.pipeline],
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation,
         created_by, updated_by
       ) VALUES (
         $1::uuid, 'gia0009701', $2::uuid, 'shopify', 'commerce',
         'production', 'Projection acceptance Shopify', 'active',
         '{"shopDomain":"projection-acceptance.myshopify.com"}'::jsonb,
         'gid://shopify/Shop/9701', 1, $3, $3
       )`,
      [ids.integration, ids.organization, actorEmail],
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'gid://shopify/Shop/9701',
         'shopify_client_credentials', decode('01', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, '9701', 'verified', now(), 'unverified', $3, $3
       )`,
      [ids.organization, ids.integration, actorEmail],
    )
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, source_key, identity_key, name,
         relationship_type, source_payload, source_hash, sync_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'projection-customer',
         'customer:projection-customer', 'Projection customer', 'customer',
         '{}'::jsonb, $3, 'synced', $4, $4
       )`,
      [ids.customer, ids.pipeline, 'd'.repeat(64), actorEmail],
    )
    await client.query(
      `INSERT INTO crm_products (
         id, pipeline_id, source_key, name, sku, source_hash,
         sync_status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'projection-product',
         'Projection searchable product', 'PROJECTION-SKU-9702', $3,
         'synced', $4, $4
       )`,
      [ids.product, ids.pipeline, '9'.repeat(64), actorEmail],
    )
    await client.query(
      `INSERT INTO crm_products (
         id, pipeline_id, source_key, name, sku, source_hash,
         sync_status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'projection-fulfilled-product',
         'Immutable fulfilled product', 'LOCAL-SKU-9701', $3,
         'synced', $4, $4
       )`,
      [
        ids.fulfilledProduct,
        ids.pipeline,
        '5'.repeat(64),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, source_key, identity_key, name,
         relationship_type, source_payload, source_hash, sync_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'projection-long-cursor-customer',
         'customer:projection-long-cursor', $3, 'customer',
         '{}'::jsonb, $4, 'synced', $5, $5
       )`,
      [
        ids.longCustomer,
        ids.pipeline,
        '客'.repeat(500),
        '6'.repeat(64),
        actorEmail,
      ],
    )

    const orders = [
      [
        ids.fulfilledOrder,
        'gor0009701',
        '9701',
        'imported',
        "now() + interval '1 day'",
        acceptedHash,
      ],
      [
        ids.dueOrder,
        'gor0009702',
        '9702',
        'imported',
        "now() + interval '1 day'",
        'e'.repeat(64),
      ],
      [
        ids.openOrder,
        'gor0009703',
        '9703',
        'imported',
        'NULL',
        'f'.repeat(64),
      ],
      [
        ids.shippedOrder,
        'gor0009704',
        '9704',
        'shipped',
        'NULL',
        '1'.repeat(64),
      ],
    ]
    for (const [
      orderId,
      globalId,
      suffix,
      status,
      promisedDeliverySql,
      sourceHash,
    ] of orders) {
      await client.query(
        `INSERT INTO operations_orders (
           id, global_id, organization_id, pipeline_id, customer_id,
           integration_account_id, source_provider, external_order_id,
           order_number, status, currency, merchandise_total_minor,
           promised_delivery_at, ship_to, source_payload,
           created_by, updated_by, updated_at
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
           $6::uuid, 'shopify', $7, $8, $9, 'USD', 1000,
           ${promisedDeliverySql},
           '{"name":"Projection recipient","line1":"35 Saxony Drive",'
             '"city":"Trumbull","region":"CT","postalCode":"06611",'
             '"country":"US"}'::jsonb,
           $10::jsonb, $11, $11, $12::timestamptz
         )`,
        [
          orderId,
          globalId,
          ids.organization,
          ids.pipeline,
          ids.customer,
          ids.integration,
          `gid://shopify/Order/${suffix}`,
          `#${suffix}`,
          status,
          JSON.stringify({
            sourceHash,
            amountsMinor: {
              total: orderId === ids.fulfilledOrder ? '12345' : '1000',
            },
          }),
          actorEmail,
          '2026-08-01T12:00:00.000Z',
        ],
      )
    }
    await client.query(
      `UPDATE operations_orders
       SET requested_delivery_at = '2026-08-05T15:00:00.000Z'::timestamptz
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [ids.organization, ids.openOrder],
    )
    await client.query(
      `UPDATE operations_orders
       SET requested_delivery_at = '2026-08-06T16:30:00.000Z'::timestamptz
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [ids.organization, ids.fulfilledOrder],
    )
    await client.query(
      `INSERT INTO operations_orders (
         id, global_id, organization_id, pipeline_id, customer_id,
         integration_account_id, source_provider, external_order_id,
         order_number, status, currency, merchandise_total_minor,
         promised_delivery_at, ship_to, source_payload,
         created_by, updated_by, updated_at
       ) VALUES (
         $1::uuid, 'gor0009705', $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, 'clawpilot_native', 'native-order-9705',
         '#9705', 'shipped', 'USD', 54321, NULL,
         '{"name":"Native recipient","line1":"35 Saxony Drive",'
           '"city":"Trumbull","region":"CT","postalCode":"06611",'
           '"country":"US"}'::jsonb,
         '{}'::jsonb, $6, $6, '2026-08-01T12:00:00.000Z'::timestamptz
       )`,
      [
        ids.nativeOrder,
        ids.organization,
        ids.pipeline,
        ids.customer,
        ids.integration,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_order_lines (
         organization_id, order_id, pipeline_id, product_id,
         external_line_id, channel_sku, description, quantity,
         unit_price_minor, weight_grams, dimensions_mm
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         'gid://shopify/LineItem/9702', 'CHANNEL-SKU-9702',
         'Projection searchable product', 1,
         1000, 250, '{"length":200,"width":150,"height":100}'::jsonb
       )`,
      [ids.organization, ids.dueOrder, ids.pipeline, ids.product],
    )
    await client.query(
      `INSERT INTO operations_order_lines (
         id, organization_id, order_id, pipeline_id, product_id,
         external_line_id, channel_sku, description, quantity,
         unit_price_minor, weight_grams, dimensions_mm
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         'gid://shopify/LineItem/9701-clawpilot', 'LOCAL-SKU-9701',
         'Immutable ClawPilot fulfillment demand', 4,
         1000, 250, '{"length":200,"width":150,"height":100}'::jsonb
       )`,
      [
        ids.fulfilledLine,
        ids.organization,
        ids.fulfilledOrder,
        ids.pipeline,
        ids.fulfilledProduct,
      ],
    )
    await client.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, status
       ) VALUES (
         $1::uuid, 'gwh0009701', $2::uuid,
         'PROVIDER-9701', 'Provider mapped warehouse', 'active'
       )`,
      [ids.warehouse, ids.organization],
    )
    await client.query(
      `INSERT INTO operations_locations (
         id, global_id, organization_id, warehouse_id, code, active
       ) VALUES (
         $1::uuid, 'gwl0009701', $2::uuid, $3::uuid,
         'PROVIDER-9701-PICK', true
       )`,
      [ids.location, ids.organization, ids.warehouse],
    )
    await client.query(
      `INSERT INTO operations_inventory_pools (
         id, global_id, organization_id, pipeline_id, name, pool_type
       ) VALUES (
         $1::uuid, 'gip0009701', $2::uuid, $3::uuid,
         'Provider mapping inventory', 'shared'
       )`,
      [ids.inventoryPool, ids.organization, ids.pipeline],
    )
    await client.query(
      `INSERT INTO operations_commerce_inventory_location_mappings (
         id, global_id, organization_id, integration_account_id,
         external_location_id, external_location_name,
         warehouse_id, location_id, inventory_pool_id,
         mapping_method, active
       ) VALUES (
         $1::uuid, 'gilm0009701', $2::uuid, $3::uuid,
         'gid://shopify/Location/9701', 'Provider location 9701',
         $4::uuid, $5::uuid, $6::uuid, 'manual', true
       )`,
      [
        ids.locationMapping,
        ids.organization,
        ids.integration,
        ids.warehouse,
        ids.location,
        ids.inventoryPool,
      ],
    )
    await client.query(
      `INSERT INTO operations_orders (
         id, global_id, organization_id, pipeline_id, customer_id,
         integration_account_id, source_provider, external_order_id,
         order_number, status, currency, merchandise_total_minor,
         promised_delivery_at, ship_to, source_payload,
         created_by, updated_by, updated_at
       )
       SELECT gen_random_uuid(),
              'gor' || lpad((9800 + seed)::text, 7, '0'),
              $1::uuid, $2::uuid, $3::uuid, $4::uuid,
              'shopify',
              'gid://shopify/Order/' || (9800 + seed)::text,
              '#' || (9800 + seed)::text,
              'cancelled', 'USD', 1000, NULL,
              '{"name":"Projection recipient","line1":"35 Saxony Drive",'
                '"city":"Trumbull","region":"CT","postalCode":"06611",'
                '"country":"US"}'::jsonb,
              jsonb_build_object('sourceHash', repeat('2', 64)),
              $5, $5,
              '2026-08-31T12:00:00.000Z'::timestamptz
       FROM generate_series(0, 110) AS seed`,
      [
        ids.organization,
        ids.pipeline,
        ids.customer,
        ids.integration,
        actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_orders
       SET customer_id = $2::uuid
       WHERE organization_id = $1::uuid
         AND order_number IN ('#9800', '#9801')`,
      [ids.organization, ids.longCustomer],
    )

    await client.query(
      `INSERT INTO operations_commerce_order_revision_targets (
         id, organization_id, integration_account_id, order_id, provider,
         accepted_source_hash, latest_source_hash, material_state,
         claim_state, checked_at, next_check_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify',
         $5, $6, 'provider_fulfilled', 'ready', now(), now()
       )`,
      [
        ids.target,
        ids.organization,
        ids.integration,
        ids.fulfilledOrder,
        acceptedHash,
        fulfilledHash,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_revision_observations (
         id, global_id, organization_id, integration_account_id, target_id,
         order_id, provider, credential_generation, external_order_id,
         source_revision, source_hash, revision_hash, normalized_snapshot,
         canonical_row_version, provider_read_count, provider_write_count,
         observed_at, created_at
       ) VALUES (
         $1::uuid, 'gcor0009701', $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, 'shopify', 1, 'gid://shopify/Order/9701',
         'projection-fulfilled-v1', $6, $7,
         $8::jsonb, 0, 1, 0,
         date_trunc('milliseconds', statement_timestamp() - interval '3 hours'),
         date_trunc('milliseconds', statement_timestamp() - interval '3 hours')
       )`,
      [
        ids.observation,
        ids.organization,
        ids.integration,
        ids.target,
        ids.fulfilledOrder,
        fulfilledHash,
        revisionHash,
        JSON.stringify({
          version: 'shopify-canonical-order-revision-v1',
          order: {
            requestedDeliveryAt: null,
            deliveryPromise: {
              source: 'fulfillment_order.deliveryMethod',
              observedMaxDeliveryAt: '2026-08-08T17:45:00.000Z',
              coverage: 'partial',
              effectiveScopes: [
                'read_merchant_managed_fulfillment_orders',
              ],
              connectionComplete: true,
              eligibleNodeCount: 1,
              datedNodeCount: 1,
            },
            canonicalStates: {
              lifecycle: 'closed',
              payment: 'paid',
              fulfillment: 'fulfilled',
              returns: 'none',
            },
          },
        }),
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_revision_reads (
         id, global_id, organization_id, integration_account_id, target_id,
         observation_id, order_id, provider, credential_generation,
         source_hash, revision_hash, canonical_row_version, trigger_kind,
         provider_read_count, provider_write_count, observed_at,
         protected_snapshot_expires_at, created_at
       ) VALUES (
         $1::uuid, 'gcrr0009701', $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, 'shopify', 1, $7, $8, 0, 'scheduled',
         1, 0,
         date_trunc('milliseconds', statement_timestamp() - interval '3 hours'),
         statement_timestamp() + interval '7 days',
         date_trunc('milliseconds', statement_timestamp() - interval '3 hours')
       )`,
      [
        ids.read,
        ids.organization,
        ids.integration,
        ids.target,
        ids.observation,
        ids.fulfilledOrder,
        fulfilledHash,
        revisionHash,
      ],
    )
    await client.query(
      `UPDATE operations_commerce_order_revision_targets
       SET latest_observation_id = $1::uuid,
           latest_read_id = $2::uuid,
           checked_at = now(),
           updated_at = now()
       WHERE organization_id = $3::uuid
         AND id = $4::uuid`,
      [ids.observation, ids.read, ids.organization, ids.target],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_observations (
         id, global_id, organization_id, integration_account_id, order_id,
         provider, credential_generation, observation_kind,
         external_order_id, order_number, source_revision, source_hash,
         canonical_lifecycle_state, canonical_payment_state,
         canonical_fulfillment_state, canonical_return_state,
         currency, provider_total_minor, provider_updated_at,
         observed_at, provider_read_count, provider_write_count, created_at,
         manual_provider_read_lease_id
       ) VALUES (
         $1::uuid, 'gcoo0009701', $2::uuid, $3::uuid, $4::uuid,
         'shopify', 1, 'manual_exact_read',
         'gid://shopify/Order/9701', '#9701',
         'projection-tracking-v1', $5,
         'closed', 'paid', 'fulfilled', 'none',
         'USD', 12345,
         date_trunc('milliseconds', statement_timestamp() - interval '2 hours'),
         date_trunc('milliseconds', statement_timestamp() - interval '2 hours'),
         1, 0,
         date_trunc('milliseconds', statement_timestamp() - interval '2 hours'),
         $6::uuid
       )`,
      [
        ids.providerObservation,
        ids.organization,
        ids.integration,
        ids.fulfilledOrder,
        '3'.repeat(64),
        randomUUID(),
      ],
    )
    const providerRevision = (await client.query(
      `SELECT provider_updated_at, observed_at
       FROM operations_commerce_order_observations
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, ids.providerObservation],
    )).rows[0]
    await client.query(
      `INSERT INTO operations_commerce_order_observation_lines (
         organization_id, observation_id, external_line_id,
         external_product_id, external_variant_id, sku,
         title_snapshot, variant_title_snapshot, vendor_snapshot,
         original_quantity, current_quantity, unfulfilled_quantity,
         fulfilled_quantity, returned_quantity, requires_shipping,
         unit_price_currency, unit_price_minor,
         subtotal_currency, subtotal_minor,
         discount_currency, discount_minor, tax_currency, tax_minor
       ) VALUES
         ($1::uuid, $2::uuid, 'gid://shopify/LineItem/9701-provider-a',
          'gid://shopify/Product/9701-a',
          'gid://shopify/ProductVariant/9701-a', 'PROVIDER-A-9701',
          'Provider Banana Bread 20lb', 'Case of 5', 'AG Alchemy',
          5, 3, 0, 3, 1, true,
          'USD', 2500, 'USD', 12500, 'USD', 500, 'USD', 1000),
         ($1::uuid, $2::uuid, 'gid://shopify/LineItem/9701-provider-b',
          'gid://shopify/Product/9701-b',
          'gid://shopify/ProductVariant/9701-b', NULL,
          'Replacement Chicken Bones 20lb', NULL, 'AG Alchemy',
          2, 1, 0, 1, 1, true,
          'USD', 4200, 'USD', 8400, 'USD', 0, 'USD', 672)`,
      [ids.organization, ids.providerObservation],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_event_observations (
         id, global_id, organization_id, integration_account_id,
         observation_id, order_id, provider, external_order_id,
         external_event_id, external_subject_id, event_hash,
         event_kind, event_status, quantity, amount_minor, currency,
         attribution_source,
         tracking_carrier, tracking_number,
         provider_location_id,
         sensitive_evidence_expires_at,
         occurred_at, observed_at, provider_write_count, created_at
       ) VALUES (
         $1::uuid, 'gcoe0009701', $2::uuid, $3::uuid,
         $4::uuid, $5::uuid, 'shopify', 'gid://shopify/Order/9701',
         'projection-tracking-event-9701',
         'projection-fulfillment-9701', $6,
         'tracking_updated', 'delivered', 3, 1250, 'USD',
         'provider_system',
         'UPS', '1ZPROJECTION9701',
         'gid://shopify/Location/9701',
         statement_timestamp() + interval '30 days',
         date_trunc('milliseconds', statement_timestamp() - interval '2 hours'),
         date_trunc('milliseconds', statement_timestamp() - interval '2 hours'),
         0,
         date_trunc('milliseconds', statement_timestamp() - interval '2 hours')
       )`,
      [
        ids.providerEvent,
        ids.organization,
        ids.integration,
        ids.providerObservation,
        ids.fulfilledOrder,
        '4'.repeat(64),
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_event_observations (
         id, global_id, organization_id, integration_account_id,
         observation_id, order_id, provider, external_order_id,
         external_event_id, external_subject_id, event_hash,
         event_kind, event_status, attribution_source,
         tracking_carrier, tracking_number,
         provider_location_id,
         sensitive_evidence_expires_at,
         occurred_at, observed_at, provider_write_count, created_at
       ) VALUES (
         $1::uuid, 'gcoe0009706', $2::uuid, $3::uuid,
         $4::uuid, $5::uuid, 'shopify', 'gid://shopify/Order/9701',
         'projection-tracking-event-9701-untracked-sibling',
         'projection-fulfillment-9701-untracked-sibling', $6,
         'tracking_updated', 'success', 'provider_system',
         NULL, NULL, 'gid://shopify/Location/9701',
         statement_timestamp() + interval '30 days',
         date_trunc('milliseconds', statement_timestamp() - interval '90 minutes'),
         date_trunc('milliseconds', statement_timestamp() - interval '90 minutes'),
         0,
         date_trunc('milliseconds', statement_timestamp() - interval '90 minutes')
       )`,
      [
        ids.unrelatedBlankTrackingEvent,
        ids.organization,
        ids.integration,
        ids.providerObservation,
        ids.fulfilledOrder,
        '6'.repeat(64),
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_candidates (
         id, global_id, organization_id, integration_account_id, pipeline_id,
         run_id, provider, external_order_id, order_number_snapshot,
         provider_order_status_raw, provider_financial_status_raw,
         provider_fulfillment_status_raw, provider_return_status_raw,
         normalized_order_status, normalized_payment_status,
         normalized_fulfillment_status, normalized_return_status,
         requires_shipping, currency_code, subtotal_minor, discount_minor,
         brand_discount_minor, shipping_minor, tax_minor,
         other_adjustment_minor, total_minor, party_snapshot_state,
         customer_resolution_state, ship_to_snapshot_state,
         ship_to_snapshot_source, delivery_resolution_state,
         provider_requested_delivery_at, observed_at, provider_updated_at,
         source_revision, source_hash, provider_api_version,
         normalizer_version, workflow_state, blocking_codes, row_version,
         created_by, updated_by, expires_at
       ) VALUES (
         $1::uuid, 'gcoc0009701', $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, 'shopify', 'gid://shopify/Order/9701', '#9701',
         'CLOSED', 'PAID', 'FULFILLED', 'PARTIALLY_RETURNED',
         'closed', 'paid', 'fulfilled', 'partial',
         true, 'USD', 12345, 0, 0, 0, 0, 0, 12345, 'missing',
         'unresolved', 'missing', 'none', 'unresolved', NULL,
         $6::timestamptz - interval '1 minute', $7::timestamptz,
         'projection-current-candidate-v1', $8, '2026-07',
         'external-fulfillment-projection-v1', 'held', '{}'::text[], 0,
         $9, $9, now() + interval '7 days'
       )`,
      [
        ids.providerCandidate,
        ids.organization,
        ids.integration,
        ids.pipeline,
        ids.providerRun,
        providerRevision.observed_at,
        providerRevision.provider_updated_at,
        '0'.repeat(64),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_observations (
         id, global_id, organization_id, integration_account_id, order_id,
         provider, credential_generation, observation_kind,
         external_order_id, order_number, source_revision, source_hash,
         canonical_lifecycle_state, canonical_payment_state,
         canonical_fulfillment_state, canonical_return_state,
         currency, provider_total_minor, provider_updated_at,
         observed_at, provider_read_count, provider_write_count, created_at,
         manual_provider_read_lease_id
       ) VALUES (
         $1::uuid, 'gcoo0009702', $2::uuid, $3::uuid, $4::uuid,
         'shopify', 1, 'manual_exact_read',
         'gid://shopify/Order/9703', '#9703',
         'projection-tracking-removal-v1', $5,
         'open', 'paid', 'unfulfilled', 'none',
         'USD', 1000,
         date_trunc('milliseconds', statement_timestamp() - interval '4 hours'),
         date_trunc('milliseconds', statement_timestamp() - interval '4 hours'),
         1, 0,
         date_trunc('milliseconds', statement_timestamp() - interval '4 hours'),
         $6::uuid
       )`,
      [
        ids.removalObservation,
        ids.organization,
        ids.integration,
        ids.openOrder,
        '7'.repeat(64),
        randomUUID(),
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_event_observations (
         id, global_id, organization_id, integration_account_id,
         observation_id, order_id, provider, external_order_id,
         external_event_id, external_subject_id, event_hash,
         event_kind, event_status, attribution_source,
         tracking_carrier, tracking_number,
         sensitive_evidence_expires_at,
         occurred_at, observed_at, provider_write_count, created_at
       ) VALUES (
         $1::uuid, 'gcoe0009702', $2::uuid, $3::uuid,
         $4::uuid, $5::uuid, 'shopify', 'gid://shopify/Order/9703',
         'projection-tracking-event-9703-original',
         'projection-fulfillment-9703', $6,
         'tracking_updated', 'in_transit', 'provider_system',
         'UPS', '1ZREMOVED9703', statement_timestamp() + interval '30 days',
         date_trunc('milliseconds', statement_timestamp() - interval '4 hours'),
         date_trunc('milliseconds', statement_timestamp() - interval '4 hours'),
         0,
         date_trunc('milliseconds', statement_timestamp() - interval '4 hours')
       ), (
         $7::uuid, 'gcoe0009703', $2::uuid, $3::uuid,
         $4::uuid, $5::uuid, 'shopify', 'gid://shopify/Order/9703',
         'projection-tracking-event-9703-removed',
         'projection-fulfillment-9703', $8,
         'tracking_updated', 'unknown', 'provider_system',
         NULL, NULL, statement_timestamp() + interval '30 days',
         date_trunc(
           'milliseconds',
           statement_timestamp() - interval '3 hours 30 minutes'
         ),
         date_trunc(
           'milliseconds',
           statement_timestamp() - interval '3 hours 30 minutes'
         ),
         0,
         date_trunc(
           'milliseconds',
           statement_timestamp() - interval '3 hours 30 minutes'
         )
       )`,
      [
        ids.retainedTrackingEvent,
        ids.organization,
        ids.integration,
        ids.removalObservation,
        ids.openOrder,
        '8'.repeat(64),
        ids.removedTrackingEvent,
        '9'.repeat(64),
      ],
    )
    await client.query(
      `INSERT INTO operations_shopify_external_fulfillment_reconciliations (
         id, global_id, organization_id, command_receipt_id, order_id,
         integration_account_id, plan_id, wave_id,
         external_order_id, provider_order_name,
         provider_order_updated_at, provider_order_closed_at,
         provider_fulfillment_id, provider_fulfillment_name,
         provider_fulfillment_created_at,
         provider_fulfillment_updated_at, provider_location_id,
         provider_fulfillment_order_ids, evidence_hash,
         evidence_snapshot, provider_read_count, provider_write_count,
         reason, reconciled_by, reconciled_at
       ) VALUES (
         $1::uuid, 'gsfr0009701', $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, $7::uuid,
         'gid://shopify/Order/9704', '#9704',
         date_trunc('milliseconds', statement_timestamp() - interval '1 hour'),
         date_trunc('milliseconds', statement_timestamp() - interval '1 hour'),
         'gid://shopify/Fulfillment/9704', '#9704.1',
         date_trunc('milliseconds', statement_timestamp() - interval '1 hour'),
         date_trunc('milliseconds', statement_timestamp() - interval '1 hour'),
         'gid://shopify/Location/9704', ARRAY['9704-fo'], $8,
         $9::jsonb, 2, 0,
         'Retain exact external fulfillment evidence', $10,
         date_trunc('milliseconds', statement_timestamp() - interval '1 hour')
       )`,
      [
        ids.reconciliation,
        ids.organization,
        randomUUID(),
        ids.shippedOrder,
        ids.integration,
        randomUUID(),
        randomUUID(),
        '5'.repeat(64),
        JSON.stringify({
          fulfillment: {
            tracking: [{
              company: 'USPS',
              number: '9400RECONCILIATION9704',
              url: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9704',
            }],
          },
        }),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_shopify_external_fulfillment_reconciliations (
         id, global_id, organization_id, command_receipt_id, order_id,
         integration_account_id, plan_id, wave_id,
         external_order_id, provider_order_name,
         provider_order_updated_at, provider_order_closed_at,
         provider_fulfillment_id, provider_fulfillment_name,
         provider_fulfillment_created_at,
         provider_fulfillment_updated_at, provider_location_id,
         provider_fulfillment_order_ids, evidence_hash,
         evidence_snapshot, provider_read_count, provider_write_count,
         reason, reconciled_by, reconciled_at
       ) VALUES (
         $1::uuid, 'gsfr0009702', $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, $7::uuid,
         'gid://shopify/Order/9701', '#9701',
         date_trunc('milliseconds', statement_timestamp() - interval '90 minutes'),
         date_trunc('milliseconds', statement_timestamp() - interval '90 minutes'),
         'gid://shopify/Fulfillment/9701-sibling', '#9701.2',
         date_trunc('milliseconds', statement_timestamp() - interval '90 minutes'),
         date_trunc('milliseconds', statement_timestamp() - interval '90 minutes'),
         'gid://shopify/Location/9701', ARRAY['9701-fo-sibling'], $8,
         $9::jsonb, 2, 0,
         'Retain exact sibling fulfillment evidence', $10,
         date_trunc('milliseconds', statement_timestamp() - interval '90 minutes')
       )`,
      [
        ids.unrelatedBlankReconciliation,
        ids.organization,
        randomUUID(),
        ids.fulfilledOrder,
        ids.integration,
        randomUUID(),
        randomUUID(),
        '6'.repeat(64),
        JSON.stringify({ fulfillment: { tracking: [] } }),
        actorEmail,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
      .catch(() => undefined)
    client.release()
  }
  return ids
}

async function advanceCandidatePastExactObservation(pool, ids) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `UPDATE operations_commerce_order_candidates candidate
       SET observed_at = observation.observed_at + interval '1 minute',
           provider_updated_at = observation.provider_updated_at,
           provider_requested_delivery_at = NULL,
           source_revision = 'projection-newer-observed-candidate-v2',
           updated_at = now()
       FROM operations_commerce_order_observations observation
       WHERE candidate.organization_id = $1::uuid
         AND candidate.id = $2::uuid
         AND observation.organization_id = candidate.organization_id
         AND observation.id = $3::uuid`,
      [ids.organization, ids.providerCandidate, ids.providerObservation],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
      .catch(() => undefined)
    client.release()
  }
}

async function appendNewerScheduledPollPastExactObservation(pool, ids) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO operations_commerce_order_backfill_sessions (
         id, global_id, organization_id, integration_account_id,
         provider, session_kind, credential_generation, policy_revision,
         coverage_basis, status, requested_from, requested_through,
         idempotency_key, request_hash, query_hash, requested_by, reason,
         completed_at
       ) VALUES (
         $1::uuid, 'gcob0009709', $2::uuid, $3::uuid,
         'shopify', 'continuous_poll', 1, 1,
         'shopify_updated_at_overlap', 'succeeded',
         statement_timestamp() - interval '1 day', statement_timestamp(),
         'projection-newer-scheduled-poll-9709', $4, $5, $6,
         'Projection currentness regression scheduled poll',
         statement_timestamp()
       )`,
      [
        ids.newerProviderBackfillSession,
        ids.organization,
        ids.integration,
        '1'.repeat(64),
        '2'.repeat(64),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_observations (
         id, global_id, organization_id, integration_account_id,
         backfill_session_id, order_id,
         provider, credential_generation, observation_kind,
         external_order_id, order_number, source_revision, source_hash,
         canonical_lifecycle_state, canonical_payment_state,
         canonical_fulfillment_state, canonical_return_state,
         currency, provider_total_minor, provider_updated_at,
         observed_at, provider_read_count, provider_write_count, created_at
       )
       SELECT
         $1::uuid, 'gcoo0009709', observation.organization_id,
         observation.integration_account_id, $2::uuid, observation.order_id,
         observation.provider, observation.credential_generation,
         'scheduled_poll', observation.external_order_id,
         observation.order_number,
         'projection-newer-scheduled-poll-v2', $3,
         observation.canonical_lifecycle_state,
         observation.canonical_payment_state,
         observation.canonical_fulfillment_state,
         observation.canonical_return_state,
         observation.currency, observation.provider_total_minor,
         observation.provider_updated_at,
         observation.observed_at + interval '30 seconds',
         1, 0, observation.created_at + interval '30 seconds'
       FROM operations_commerce_order_observations observation
       WHERE observation.organization_id = $4::uuid
         AND observation.id = $5::uuid`,
      [
        ids.newerProviderObservation,
        ids.newerProviderBackfillSession,
        'e'.repeat(64),
        ids.organization,
        ids.providerObservation,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
      .catch(() => undefined)
    client.release()
  }
}

async function removeNewerScheduledPoll(pool, ids) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `DELETE FROM operations_commerce_order_observations
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [ids.organization, ids.newerProviderObservation],
    )
    await client.query(
      `DELETE FROM operations_commerce_order_backfill_sessions
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [ids.organization, ids.newerProviderBackfillSession],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
      .catch(() => undefined)
    client.release()
  }
}

async function durableState(pool, organizationId) {
  const [orders, evidence, providerWrites, externalWrites] = await Promise.all([
    pool.query(
      `SELECT global_id, status, row_version::text, source_payload, updated_at
       FROM operations_orders
       WHERE organization_id = $1::uuid
       ORDER BY global_id`,
      [organizationId],
    ),
    pool.query(
      `SELECT
         (SELECT count(*)
          FROM operations_commerce_order_revision_observations
          WHERE organization_id = $1::uuid)::text AS observations,
         (SELECT count(*)
          FROM operations_commerce_order_revision_reads
          WHERE organization_id = $1::uuid)::text AS reads,
         (SELECT count(*)
          FROM operations_commerce_order_revision_targets
          WHERE organization_id = $1::uuid)::text AS targets`,
      [organizationId],
    ),
    pool.query(
      `SELECT
         (SELECT COALESCE(sum(provider_write_count), 0)::text
          FROM operations_commerce_order_revision_observations
          WHERE organization_id = $1::uuid) AS observation_writes,
         (SELECT COALESCE(sum(provider_write_count), 0)::text
          FROM operations_commerce_order_revision_reads
          WHERE organization_id = $1::uuid) AS read_writes`,
      [organizationId],
    ),
    pool.query(
      `SELECT
         (SELECT count(*) FROM operations_shipments
          WHERE organization_id = $1::uuid)::text AS shipments,
         (SELECT count(*) FROM operations_labels
          WHERE organization_id = $1::uuid)::text AS labels,
         (SELECT count(*) FROM operations_print_artifacts
          WHERE organization_id = $1::uuid)::text AS artifacts,
         (SELECT count(*)
          FROM operations_shopify_external_fulfillment_reconciliations
          WHERE organization_id = $1::uuid)::text AS reconciliations`,
      [organizationId],
    ),
  ])
  return plain({
    orders: orders.rows,
    evidence: evidence.rows[0],
    providerWrites: providerWrites.rows[0],
    externalWrites: externalWrites.rows[0],
  })
}

const capabilities = Object.freeze({
  canActivate: false,
  canManage: false,
  canExecute: false,
  canViewCosts: false,
})

async function verifyProjection(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  try {
    const ids = await seedFixture(pool)
    const persistence = operationsPersistenceFor(pool)
    const before = await durableState(pool, ids.organization)

    const workspace = plain(
      await persistence.readOperationsWorkspaceFromPostgres({
        organizationId: ids.organization,
        capabilities,
        selectedOrderGlobalId: 'gor0009701',
      }),
    )
    const projected = workspace.orders.find(
      (order) => order.globalId === 'gor0009701',
    )
    assert.equal(workspace.orderPage.total, 116)
    assert.equal(workspace.orderPage.returned, 116)
    assert.equal(workspace.orderPage.nextCursor, null)
    assert.equal(workspace.orders.length, 116)
    assert.equal(projected?.status, 'imported')
    assert.equal(projected?.externallyFulfilled, true)
    assert.equal(
      projected?.lineCount,
      1,
      'canonical list rows retain immutable ClawPilot fulfillment demand',
    )
    assert.equal(
      projected?.providerLineCount,
      2,
      'canonical list rows expose the separate current provider line count',
    )
    assert.equal(projected?.warehouseName, 'Provider mapped warehouse')
    assert.equal(
      projected?.warehouseProvenance,
      'provider_location_mapping',
      'an unplanned canonical order may show only an active exact location mapping',
    )
    assert.equal(
      projected?.requestedDeliveryAt,
      null,
      'scope-filtered fulfillment-order dates are not promoted to a customer requested date',
    )
    assert.equal(
      projected?.providerPromisedDeliveryAt,
      '2026-08-08T17:45:00.000Z',
      'the latest exact provider revision exposes its observed provider delivery window separately',
    )
    assert.equal(projected?.providerDeliveryCoverage, 'partial')
    assert.equal(
      projected?.providerDeliverySource,
      'fulfillment_order.deliveryMethod',
    )
    assert.equal(
      projected?.orderValueMinor,
      '12345',
      'an unplanned promoted order retains its exact provider header total',
    )
    assert.equal(
      projected?.expectedRevenueMinor,
      null,
      'provider order value must remain separate from fulfillment-plan revenue',
    )
    assert.equal(projected?.trackingNumber, '1ZPROJECTION9701')
    const requestedOnly = workspace.orders.find(
      (order) => order.globalId === 'gor0009703',
    )
    assert.equal(requestedOnly?.promisedDeliveryAt, null)
    assert.equal(
      requestedOnly?.requestedDeliveryAt,
      '2026-08-05T15:00:00.000Z',
      'canonical order rows retain requested delivery when no promise exists',
    )
    const native = workspace.orders.find(
      (order) => order.globalId === 'gor0009705',
    )
    assert.equal(
      native?.orderValueMinor,
      '54321',
      'native orders use their durable merchandise total as list value',
    )
    assert.equal(workspace.selectedOrder?.globalId, 'gor0009701')
    assert.equal(workspace.selectedOrder?.status, 'imported')
    assert.equal(workspace.selectedOrder?.externallyFulfilled, true)
    assert.equal(workspace.selectedOrder?.lineCount, 1)
    assert.equal(workspace.selectedOrder?.providerLineCount, 2)
    assert.equal(
      workspace.selectedOrder?.warehouseProvenance,
      'provider_location_mapping',
    )
    assert.equal(
      workspace.selectedOrder?.requestedDeliveryAt,
      null,
      'canonical detail does not relabel a scope-filtered provider window as requested delivery',
    )
    assert.equal(
      workspace.selectedOrder?.providerPromisedDeliveryAt,
      '2026-08-08T17:45:00.000Z',
      'canonical detail uses the same provider delivery observation as the list',
    )
    const clearedPromiseObservationId = randomUUID()
    const clearedPromiseClient = await pool.connect()
    try {
      await clearedPromiseClient.query('SET session_replication_role = replica')
      await clearedPromiseClient.query(
        `INSERT INTO operations_commerce_order_revision_observations (
           id, global_id, organization_id, integration_account_id, target_id,
           order_id, provider, credential_generation, external_order_id,
           source_revision, source_hash, revision_hash, normalized_snapshot,
           canonical_row_version, provider_read_count, provider_write_count,
           observed_at, created_at
         ) VALUES (
           $1::uuid, 'gcor0009799', $2::uuid, $3::uuid, $4::uuid,
           $5::uuid, 'shopify', 1, 'gid://shopify/Order/9701',
           'projection-fulfilled-v2', $6, $7, $8::jsonb,
           0, 1, 0,
           date_trunc('milliseconds', statement_timestamp() - interval '2 hours'),
           date_trunc('milliseconds', statement_timestamp() - interval '2 hours')
         )`,
        [
          clearedPromiseObservationId,
          ids.organization,
          ids.integration,
          ids.target,
          ids.fulfilledOrder,
          'd'.repeat(64),
          'e'.repeat(64),
          JSON.stringify({
            version: 'shopify-canonical-order-revision-v1',
            order: {
              requestedDeliveryAt: null,
              deliveryPromise: {
                source: 'fulfillment_order.deliveryMethod',
                observedMaxDeliveryAt: null,
                coverage: 'partial',
                effectiveScopes: [
                  'read_merchant_managed_fulfillment_orders',
                ],
                connectionComplete: true,
                eligibleNodeCount: 1,
                datedNodeCount: 0,
              },
              canonicalStates: {
                lifecycle: 'closed',
                payment: 'paid',
                fulfillment: 'fulfilled',
                returns: 'none',
              },
            },
          }),
        ],
      )
      await clearedPromiseClient.query('SET session_replication_role = origin')
      const clearedPromisePage = plain(
        await persistence.readOperationsOrderPageFromPostgres({
          organizationId: ids.organization,
          search: '#9701',
        }),
      )
      assert.equal(
        clearedPromisePage.orders[0]?.providerPromisedDeliveryAt,
        null,
        'a newer exact provider observation can clear an obsolete delivery window',
      )
      assert.equal(clearedPromisePage.orders[0]?.requestedDeliveryAt, null)
    } finally {
      await clearedPromiseClient.query('SET session_replication_role = replica')
        .catch(() => undefined)
      await clearedPromiseClient.query(
        `DELETE FROM operations_commerce_order_revision_observations
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [ids.organization, clearedPromiseObservationId],
      ).catch(() => undefined)
      await clearedPromiseClient.query('SET session_replication_role = origin')
        .catch(() => undefined)
      clearedPromiseClient.release()
    }
    assert.deepEqual(
      workspace.selectedOrder?.lines.map((line) => ({
        channelSku: line.channelSku,
        quantity: line.quantity,
      })),
      [{ channelSku: 'LOCAL-SKU-9701', quantity: 4 }],
      'provider adjustments must not rewrite ClawPilot fulfillment lines',
    )
    assert.deepEqual(
      workspace.selectedOrder?.providerHistory?.currentLines.map((line) => ({
        sku: line.sku,
        title: line.titleSnapshot,
        variant: line.variantTitleSnapshot,
        vendor: line.vendorSnapshot,
        ordered: line.orderedQuantity,
        current: line.currentQuantity,
        fulfilled: line.fulfilledQuantity,
        unfulfilled: line.unfulfilledQuantity,
        returned: line.returnedQuantity,
        removed: line.orderedQuantity - Number(line.currentQuantity),
        unit: [line.unitPriceCurrency, line.unitPriceMinor],
        subtotal: [line.subtotalCurrency, line.subtotalMinor],
        discount: [line.discountCurrency, line.discountMinor],
        tax: [line.taxCurrency, line.taxMinor],
      })),
      [
        {
          sku: 'PROVIDER-A-9701',
          title: 'Provider Banana Bread 20lb',
          variant: 'Case of 5',
          vendor: 'AG Alchemy',
          ordered: 5,
          current: 3,
          fulfilled: 3,
          unfulfilled: 0,
          returned: 1,
          removed: 2,
          unit: ['USD', '2500'],
          subtotal: ['USD', '12500'],
          discount: ['USD', '500'],
          tax: ['USD', '1000'],
        },
        {
          sku: null,
          title: 'Replacement Chicken Bones 20lb',
          variant: null,
          vendor: 'AG Alchemy',
          ordered: 2,
          current: 1,
          fulfilled: 1,
          unfulfilled: 0,
          returned: 1,
          removed: 1,
          unit: ['USD', '4200'],
          subtotal: ['USD', '8400'],
          discount: ['USD', '0'],
          tax: ['USD', '672'],
        },
      ],
      'canonical detail exposes exact current sales-channel adjustments separately',
    )
    assert.equal(workspace.selectedOrder?.providerHistory?.currency, 'USD')
    assert.equal(
      workspace.selectedOrder?.providerHistory?.providerTotalMinor,
      '12345',
    )
    assert.equal(workspace.selectedOrder?.providerHistory?.providerWrites, 0)
    assert.deepEqual(
      workspace.selectedOrder?.providerHistory?.events.map((event) => ({
        kind: event.kind,
        externalSubjectId: event.externalSubjectId,
        quantity: event.quantity,
        amountMinor: event.amountMinor,
        currency: event.currency,
        trackingNumber: event.trackingNumber,
      })),
      [
        {
          kind: 'tracking_updated',
          externalSubjectId: 'projection-fulfillment-9701',
          quantity: 3,
          amountMinor: 1250,
          currency: 'USD',
          trackingNumber: '1ZPROJECTION9701',
        },
        {
          kind: 'tracking_updated',
          externalSubjectId: 'projection-fulfillment-9701-untracked-sibling',
          quantity: null,
          amountMinor: null,
          currency: null,
          trackingNumber: null,
        },
      ],
      'canonical detail retains provider event subject, quantity, and money evidence',
    )
    assert.equal(
      workspace.selectedOrder?.trackingNumber,
      '1ZPROJECTION9701',
      'a newer untracked sibling fulfillment must not mask valid tracking',
    )
    assert.deepEqual(
      workspace.selectedOrder?.externalFulfillment?.tracking,
      [],
      'a blank sibling reconciliation remains visible without hiding valid provider tracking',
    )
    assert.deepEqual(workspace.selectedOrder?.shipments, [])
    assert.deepEqual(workspace.selectedOrder?.printArtifacts, [])
    assert.deepEqual(workspace.selectedOrder?.labelPrintJobs, [])
    assert.equal(workspace.summary.openOrders, 2)
    assert.equal(workspace.summary.dueSoon, 1)

    await appendNewerScheduledPollPastExactObservation(pool, ids)
    const staleAfterPollList = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        search: '#9701',
      }),
    )
    assert.equal(
      staleAfterPollList.orders[0]?.providerLineCount,
      null,
      'a newer scheduled poll suppresses an older exact line snapshot',
    )
    const staleAfterPollDetail = plain(
      await persistence.readOperationsWorkspaceFromPostgres({
        organizationId: ids.organization,
        capabilities,
        selectedOrderGlobalId: 'gor0009701',
      }),
    )
    assert.equal(
      staleAfterPollDetail.selectedOrder?.providerHistory,
      null,
      'a newer scheduled poll suppresses older exact provider history',
    )

    await removeNewerScheduledPoll(pool, ids)
    await advanceCandidatePastExactObservation(pool, ids)
    const staleProviderList = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        search: '#9701',
      }),
    )
    assert.equal(staleProviderList.orders[0]?.providerLineCount, null)
    assert.equal(staleProviderList.orders[0]?.lineCount, 1)
    assert.equal(
      staleProviderList.orders[0]?.requestedDeliveryAt,
      null,
      'a partial provider window remains separate from requested delivery',
    )
    assert.equal(
      staleProviderList.orders[0]?.providerPromisedDeliveryAt,
      '2026-08-08T17:45:00.000Z',
      'an exact revision provider window remains visible after candidate history advances',
    )
    const staleProviderDetail = plain(
      await persistence.readOperationsWorkspaceFromPostgres({
        organizationId: ids.organization,
        capabilities,
        selectedOrderGlobalId: 'gor0009701',
      }),
    )
    assert.equal(
      staleProviderDetail.selectedOrder?.providerHistory,
      null,
      'the same provider timestamp with a later-observed candidate suppresses stale exact history',
    )
    assert.equal(staleProviderDetail.selectedOrder?.lineCount, 1)
    assert.equal(staleProviderDetail.selectedOrder?.lines.length, 1)
    assert.equal(
      staleProviderDetail.selectedOrder?.warehouseProvenance,
      'provider_location_mapping',
    )
    const reconciliationDetail = plain(
      await persistence.readOperationsWorkspaceFromPostgres({
        organizationId: ids.organization,
        capabilities,
        selectedOrderGlobalId: 'gor0009704',
      }),
    )
    assert.equal(
      reconciliationDetail.selectedOrder?.trackingNumber,
      '9400RECONCILIATION9704',
      'a newer blank sibling reconciliation cannot mask valid tracking evidence',
    )

    const cancelledOrders = []
    let cancelledCursor = null
    let firstCancelledCursor = null
    let cancelledPages = 0
    do {
      const page = plain(
        await persistence.readOperationsOrderPageFromPostgres({
          organizationId: ids.organization,
          status: 'cancelled',
          cursor: cancelledCursor,
          pageSize: 40,
        }),
      )
      cancelledPages += 1
      assert.equal(page.page.total, 111)
      assert.equal(page.page.returned, page.orders.length)
      assert.equal(page.page.pageSize, 40)
      assert.equal(page.page.complete, page.page.nextCursor === null)
      assert.equal(page.page.truncated, page.page.nextCursor !== null)
      cancelledOrders.push(...page.orders)
      cancelledCursor = page.page.nextCursor
      if (cancelledPages === 1) firstCancelledCursor = cancelledCursor
    } while (cancelledCursor)
    assert.equal(cancelledPages, 3)
    assert.equal(cancelledOrders.length, 111)
    assert.equal(
      new Set(cancelledOrders.map((order) => order.globalId)).size,
      111,
      'canonical keyset pages must include each matching order exactly once',
    )
    assert.ok(firstCancelledCursor)
    const yearZeroCursorPayload = JSON.parse(
      Buffer.from(firstCancelledCursor, 'base64url').toString('utf8'),
    )
    yearZeroCursorPayload.sortValue = '0000-01-01T00:00:00.000Z'
    const yearZeroCursor = Buffer.from(
      JSON.stringify(yearZeroCursorPayload),
      'utf8',
    ).toString('base64url')
    await assert.rejects(
      () => persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        status: 'cancelled',
        cursor: yearZeroCursor,
        pageSize: 40,
      }),
      (error) => error?.code === 'OPERATIONS_ORDER_PAGE_CURSOR_INVALID',
      'year-zero cursors must fail before PostgreSQL timestamptz casting',
    )
    const expectedOrderNumberSort = await pool.query(
      `SELECT global_id
       FROM operations_orders
       WHERE organization_id = $1::uuid
         AND archived_at IS NULL
       ORDER BY lower(order_number) ASC, id ASC`,
      [ids.organization],
    )
    const orderNumberSort = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        sort: 'order_number',
        direction: 'asc',
      }),
    )
    assert.deepEqual(
      orderNumberSort.orders.map((order) => order.globalId),
      expectedOrderNumberSort.rows.map((row) => row.global_id),
      'canonical order-number sorting must use the selected stable tuple',
    )
    const searchedProductSku = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        search: 'PROJECTION-SKU-9702',
      }),
    )
    assert.deepEqual(
      searchedProductSku.orders.map((order) => order.globalId),
      ['gor0009702'],
      'canonical search must include resolved product SKUs',
    )
    const searchedChannelSku = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        search: 'CHANNEL-SKU-9702',
      }),
    )
    assert.deepEqual(
      searchedChannelSku.orders.map((order) => order.globalId),
      ['gor0009702'],
      'canonical search must include channel SKUs',
    )
    const shopifyOnly = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        provider: 'shopify',
      }),
    )
    assert.equal(shopifyOnly.page.total, 115)
    const faireOnly = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        provider: 'faire',
      }),
    )
    assert.equal(faireOnly.page.total, 0)
    const trackingMissing = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        tracking: 'missing',
      }),
    )
    assert.equal(trackingMissing.page.total, 114)
    const trackingPresent = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        tracking: 'present',
      }),
    )
    assert.equal(trackingPresent.page.total, 2)
    assert.deepEqual(
      trackingPresent.orders.map((order) => ({
        globalId: order.globalId,
        trackingNumber: order.trackingNumber,
      })).sort((left, right) => left.globalId.localeCompare(right.globalId)),
      [
        {
          globalId: 'gor0009701',
          trackingNumber: '1ZPROJECTION9701',
        },
        {
          globalId: 'gor0009704',
          trackingNumber: '9400RECONCILIATION9704',
        },
      ],
      'canonical tracking projects provider events and reconciliation evidence',
    )
    for (const [search, expectedGlobalId] of [
      ['1ZPROJECTION9701', 'gor0009701'],
      ['9400RECONCILIATION9704', 'gor0009704'],
    ]) {
      const searchedTracking = plain(
        await persistence.readOperationsOrderPageFromPostgres({
          organizationId: ids.organization,
          search,
        }),
      )
      assert.deepEqual(
        searchedTracking.orders.map((order) => order.globalId),
        [expectedGlobalId],
        'canonical search includes every retained tracking source',
      )
    }
    const removedTrackingSearch = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        search: '1ZREMOVED9703',
      }),
    )
    assert.equal(
      removedTrackingSearch.page.total,
      0,
      'a newer provider tracking-removal event must shadow the old number',
    )
    const trackingSorted = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        tracking: 'present',
        sort: 'tracking',
        direction: 'asc',
      }),
    )
    assert.deepEqual(
      trackingSorted.orders.map((order) => order.globalId),
      ['gor0009701', 'gor0009704'],
      'tracking sorting uses the same unified tracking projection',
    )
    const providerTracked = trackingPresent.orders.find(
      (order) => order.globalId === 'gor0009701',
    )
    const reconciliationTracked = trackingPresent.orders.find(
      (order) => order.globalId === 'gor0009704',
    )
    assert.ok(providerTracked)
    assert.ok(reconciliationTracked)
    assert.ok(
      new Date(reconciliationTracked.updatedAt) >
        new Date(providerTracked.updatedAt),
      'list activity follows newer reconciliation evidence',
    )
    const afterProviderActivity = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        updatedAfter: providerTracked.updatedAt,
      }),
    )
    assert.deepEqual(
      afterProviderActivity.orders.map((order) => order.globalId),
      ['gor0009704'],
      'updated filtering uses provider and reconciliation activity',
    )
    const missingTrackingSorted = []
    let missingTrackingCursor = null
    do {
      const page = plain(
        await persistence.readOperationsOrderPageFromPostgres({
          organizationId: ids.organization,
          sort: 'tracking',
          direction: 'asc',
          cursor: missingTrackingCursor,
          pageSize: 40,
        }),
      )
      missingTrackingSorted.push(...page.orders)
      missingTrackingCursor = page.page.nextCursor
    } while (missingTrackingCursor)
    assert.equal(
      missingTrackingSorted.length,
      116,
      'empty tracking sort keys must remain valid across every keyset page',
    )
    assert.equal(
      new Set(missingTrackingSorted.map((order) => order.globalId)).size,
      116,
      'tracking sorting must not skip orders without tracking evidence',
    )
    const longCustomerFirstPage = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        status: 'cancelled',
        sort: 'customer',
        direction: 'desc',
        pageSize: 1,
      }),
    )
    assert.ok(longCustomerFirstPage.page.nextCursor)
    assert.ok(
      longCustomerFirstPage.page.nextCursor.length > 2000,
      '500 multibyte characters must exercise the expanded cursor envelope',
    )
    assert.ok(longCustomerFirstPage.page.nextCursor.length <= 4096)
    const longCustomerSecondPage = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        status: 'cancelled',
        sort: 'customer',
        direction: 'desc',
        cursor: longCustomerFirstPage.page.nextCursor,
        pageSize: 1,
      }),
    )
    assert.equal(longCustomerSecondPage.orders.length, 1)
    assert.notEqual(
      longCustomerSecondPage.orders[0].globalId,
      longCustomerFirstPage.orders[0].globalId,
    )
    const nulCustomerCursorPayload = JSON.parse(
      Buffer.from(
        longCustomerFirstPage.page.nextCursor,
        'base64url',
      ).toString('utf8'),
    )
    nulCustomerCursorPayload.sortValue = 'forged\u0000customer'
    const nulCustomerCursor = Buffer.from(
      JSON.stringify(nulCustomerCursorPayload),
      'utf8',
    ).toString('base64url')
    await assert.rejects(
      () => persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        status: 'cancelled',
        sort: 'customer',
        direction: 'desc',
        cursor: nulCustomerCursor,
        pageSize: 1,
      }),
      (error) => error?.code === 'OPERATIONS_ORDER_PAGE_CURSOR_INVALID'
        && error?.status === 400,
      'forged NUL text cursors must fail before PostgreSQL binding',
    )
    const updatedAfterFuture = plain(
      await persistence.readOperationsOrderPageFromPostgres({
        organizationId: ids.organization,
        updatedAfter: '2999-01-01T00:00:00.000Z',
      }),
    )
    assert.equal(updatedAfterFuture.page.total, 0)
    for (const changedScope of [
      { sort: 'order_number' },
      { direction: 'asc' },
      { provider: 'shopify' },
      { tracking: 'missing' },
      { updatedAfter: '2026-08-30T00:00:00.000Z' },
    ]) {
      await assert.rejects(
        () => persistence.readOperationsOrderPageFromPostgres({
          organizationId: ids.organization,
          status: 'cancelled',
          cursor: firstCancelledCursor,
          pageSize: 40,
          ...changedScope,
        }),
        (error) => error?.code === 'OPERATIONS_ORDER_PAGE_CURSOR_INVALID',
        'canonical cursors must reject changed sort/filter scope',
      )
    }

    const imported = plain(
      await persistence.readOperationsWorkspaceFromPostgres({
        organizationId: ids.organization,
        capabilities,
        status: 'imported',
      }),
    )
    assert.deepEqual(
      imported.orders.map((order) => order.globalId).sort(),
      ['gor0009702', 'gor0009703'],
      'the Imported filter excludes an effectively externally fulfilled order',
    )

    const fulfilledExternally = plain(
      await persistence.readOperationsWorkspaceFromPostgres({
        organizationId: ids.organization,
        capabilities,
        status: 'fulfilled_externally',
      }),
    )
    assert.deepEqual(
      fulfilledExternally.orders.map((order) => ({
        globalId: order.globalId,
        status: order.status,
        externallyFulfilled: order.externallyFulfilled,
      })).sort((left, right) => left.globalId.localeCompare(right.globalId)),
      [
        {
          globalId: 'gor0009701',
          status: 'imported',
          externallyFulfilled: true,
        },
        {
          globalId: 'gor0009704',
          status: 'shipped',
          externallyFulfilled: true,
        },
      ],
    )

    const after = await durableState(pool, ids.organization)
    assert.deepEqual(
      after,
      before,
      'projection reads must not mutate canonical orders or create provider/local execution evidence',
    )
    assert.equal(after.providerWrites.observation_writes, '0')
    assert.equal(after.providerWrites.read_writes, '0')
    assert.deepEqual(after.externalWrites, {
      shipments: '0',
      labels: '0',
      artifacts: '0',
      reconciliations: '2',
    })
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-external-fulfillment-projection-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=external_fulfillment_projection',
      '-e', 'POSTGRES_DB=external_fulfillment_projection',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:external_fulfillment_projection@127.0.0.1:'
      + `${port}/external_fulfillment_projection`
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
    await verifyProjection(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'Operations external-fulfillment projection disposable-PostgreSQL acceptance passed',
  )
}

if (resolve(process.argv[1] || '') === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
