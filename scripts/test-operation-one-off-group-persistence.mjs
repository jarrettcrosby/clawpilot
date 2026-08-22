#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const root = process.cwd()
const actorEmail = 'one-off-group-persistence@example.com'
const PACKAGE_CATALOG_VERSION = 'operations.package_catalog.v1'
const UPS_SELECTION_KEY = 'ups_rest:gia0009302:gac0009301:v1'

const HASH = Object.freeze({
  account: 'a'.repeat(64),
  registeredAddress: 'b'.repeat(64),
  destination: 'c'.repeat(64),
  lines: 'd'.repeat(64),
  packages: 'e'.repeat(64),
  planningRequest: '1'.repeat(64),
  planningCarrierRequest: '2'.repeat(64),
  planningCarrierResponse: '3'.repeat(64),
  purchaseRequest: '4'.repeat(64),
  purchaseCarrierRequest: '5'.repeat(64),
  purchaseCarrierResponse: '6'.repeat(64),
  groupRequest: '7'.repeat(64),
  label1Request: '8'.repeat(64),
  label2Request: '9'.repeat(64),
})

const destination = Object.freeze({
  name: 'One-off persistence recipient',
  contactName: 'One-off persistence recipient',
  line1: '100 Destination Street',
  city: 'Hartford',
  region: 'CT',
  postalCode: '06103',
  countryCode: 'US',
  residential: true,
})

const warehouseAddress = Object.freeze({
  name: 'One-off persistence warehouse',
  contactName: 'One-off persistence operator',
  companyName: 'ClawPilot fixture',
  line1: '7009 S 108th Street',
  city: 'La Vista',
  region: 'NE',
  postalCode: '68128',
  countryCode: 'US',
  phone: '4025550100',
  residential: false,
})

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
  let lastError = null
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: 'clawpilot-one-off-group-wait',
      max: 1,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch (error) {
      lastError = error
      await pool.end().catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError ?? new Error('Disposable PostgreSQL did not become ready')
}

function fixtureIds() {
  return {
    organization: randomUUID(),
    pipeline: randomUUID(),
    customer: randomUUID(),
    products: [randomUUID(), randomUUID()],
    nativeIntegration: randomUUID(),
    carrierIntegration: randomUUID(),
    carrierAccount: randomUUID(),
    warehouse: randomUUID(),
    inventoryPool: randomUUID(),
    receivingLocation: randomUUID(),
    order: randomUUID(),
    lines: [randomUUID(), randomUUID()],
    plan: randomUUID(),
    packages: [randomUUID(), randomUUID()],
    packageContents: [randomUUID(), randomUUID()],
    planningQuote: randomUUID(),
    planningOffer: randomUUID(),
    purchaseQuote: randomUUID(),
    purchaseOffer: randomUUID(),
    carrierRate: randomUUID(),
    groupAttempt: randomUUID(),
    standardOrder: randomUUID(),
    standardPlan: randomUUID(),
    standardPackage: randomUUID(),
    standardCarrierRate: randomUUID(),
    standardLabelAttempt: randomUUID(),
  }
}

function quoteSnapshots(ids) {
  const lines = [
    {
      lineKey: 'line-1',
      productId: ids.products[0],
      sku: 'ONE-OFF-FIXTURE-1',
      description: 'One-off fixture item one',
      quantity: 1,
      unitPriceMinor: 1000,
    },
    {
      lineKey: 'line-2',
      productId: ids.products[1],
      sku: 'ONE-OFF-FIXTURE-2',
      description: 'One-off fixture item two',
      quantity: 1,
      unitPriceMinor: 1500,
    },
  ]
  const packages = [
    {
      packageKey: 'package-1',
      packageProfile: {
        catalogEntryId: 'box',
        contractVersion: PACKAGE_CATALOG_VERSION,
      },
      dimensionsMm: { length: 300, width: 200, height: 100 },
      grossWeightGrams: 1_000,
      allocations: [{ lineKey: 'line-1', quantity: 1 }],
    },
    {
      packageKey: 'package-2',
      packageProfile: {
        catalogEntryId: 'box',
        contractVersion: PACKAGE_CATALOG_VERSION,
      },
      dimensionsMm: { length: 400, width: 250, height: 150 },
      grossWeightGrams: 2_000,
      allocations: [{ lineKey: 'line-2', quantity: 1 }],
    },
  ]
  return { lines, packages }
}

function exactUpsSelection(packages) {
  return {
    selectionKey: UPS_SELECTION_KEY,
    provider: 'ups_rest',
    integrationAccountGlobalId: 'gia0009302',
    carrierAccountGlobalId: 'gac0009301',
    credentialVersion: 1,
    packageCodes: packages.map((oneOffPackage) => ({
      packageKey: oneOffPackage.packageKey,
      catalogEntryId: oneOffPackage.packageProfile.catalogEntryId,
      catalogVersion: oneOffPackage.packageProfile.contractVersion,
      providerPackageCode: '02',
    })),
  }
}

async function seedPrerequisites(client, ids) {
  await client.query('SET LOCAL session_replication_role = replica')
  await client.query(
      `INSERT INTO app_users (
         email, role, status, contact_reference_code
       ) VALUES ($1, 'owner', 'active', 'gc0009301')`,
      [actorEmail],
    )
  await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, reference_code
       ) VALUES ($1, 'One-off group persistence fixture', 'member', 'ga0009301')`,
      [ids.organization],
    )
  await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, workspace_organization_id
       ) VALUES ($1, 'One-off group fixture', $2, $3)`,
      [ids.pipeline, actorEmail, ids.organization],
    )
  await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, source_key, name, source_hash, identity_key,
         workspace_organization_id, relationship_type, reference_code
       ) VALUES (
         $1, $2, 'one-off-group-customer', 'One-off group customer',
         $3, 'one-off-group-customer', $4, 'customer', 'ga0009302'
       )`,
      [ids.customer, ids.pipeline, '0'.repeat(64), ids.organization],
    )
  for (const [index, productId] of ids.products.entries()) {
    await client.query(
        `INSERT INTO crm_products (
           id, pipeline_id, source_key, reference_code, name, sku,
           source_hash
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          productId,
          ids.pipeline,
          `one-off-fixture-product-${index + 1}`,
          `gp000930${index + 1}`,
          `One-off fixture item ${index + 1}`,
          `ONE-OFF-FIXTURE-${index + 1}`,
          `${index + 1}`.repeat(64),
        ],
      )
  }
  await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration
       ) VALUES
         ($1, 'gia0009301', $3, 'clawpilot_native', 'commerce', 'mock',
          'ClawPilot native fixture', 'active', '{}'::jsonb),
         ($2, 'gia0009302', $3, 'ups_rest', 'carrier', 'sandbox',
          'UPS sandbox fixture', 'active', '{}'::jsonb)`,
      [ids.nativeIntegration, ids.carrierIntegration, ids.organization],
    )
  await client.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, address, status
       ) VALUES (
         $1, 'gwh0009301', $2, 'ONE-OFF', 'One-off fixture warehouse',
         $3::jsonb, 'active'
       )`,
      [ids.warehouse, ids.organization, JSON.stringify(warehouseAddress)],
    )
  await client.query(
      `INSERT INTO operations_inventory_pools (
         id, global_id, organization_id, pipeline_id, owner_customer_id,
         name, pool_type
       ) VALUES (
         $1, 'gip0009301', $2, $3, $4,
         'One-off fixture inventory', 'customer_dedicated'
       )`,
      [ids.inventoryPool, ids.organization, ids.pipeline, ids.customer],
    )
  await client.query(
      `INSERT INTO operations_locations (
         id, global_id, organization_id, warehouse_id, code, zone,
         location_type, storage_function
       ) VALUES (
         $1, 'gwl0009301', $2, $3, 'RECEIVING-ONE-OFF', 'RECEIVING',
         'receiving', 'work_area'
       )`,
      [ids.receivingLocation, ids.organization, ids.warehouse],
    )
  await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision
       ) VALUES ($1, $2, 'shadow', 1)`,
      [ids.organization, ids.pipeline],
    )
  await client.query(
      `INSERT INTO operations_carrier_accounts (
         id, global_id, organization_id, integration_account_id,
         display_name, account_number_ciphertext, account_number_iv,
         account_number_tag, account_number_last_four,
         account_number_fingerprint, registered_address,
         registered_address_fingerprint, address_verification,
         allow_sender_billing, allow_recipient_billing,
         allow_third_party_billing, status, sender_name,
         configuration_revision
       ) VALUES (
         $1, 'gac0009301', $2, $3, 'UPS sandbox fixture', 'ciphertext',
         'iv', 'tag', '1234', $4, $5::jsonb, $6,
         'provider_verified', true, true, true, 'active',
         'ClawPilot fixture', 1
       )`,
      [
        ids.carrierAccount,
        ids.organization,
        ids.carrierIntegration,
        HASH.account,
        JSON.stringify(warehouseAddress),
        HASH.registeredAddress,
      ],
    )
  await client.query(
      `INSERT INTO operations_carrier_credentials (
         organization_id, integration_account_id, credential_ciphertext,
         credential_iv, credential_tag, credential_version,
         client_id_last_four, account_number_last_four,
         credential_kind, credential_identifier_last_four,
         verification_status, verified_at, credential_fingerprint
       ) VALUES (
         $1, $2, decode('010203', 'hex'), decode('040506', 'hex'),
         decode('070809', 'hex'), 1, 'c123', '1234',
         'oauth_client_credentials', 'c123', 'verified', now(),
         operations_carrier_credential_fingerprint(
           1, decode('010203', 'hex'), decode('040506', 'hex'),
           decode('070809', 'hex')
         )
       )`,
      [ids.organization, ids.carrierIntegration],
    )
  const exactRateRequest = JSON.stringify({
    shipment: {
      parcels: quoteSnapshots(ids).packages.map((oneOffPackage) => ({
        packageKey: oneOffPackage.packageKey,
        packageCode: '02',
      })),
    },
  })
  await client.query(
      `INSERT INTO operations_carrier_rate_requests (
         global_id, organization_id, integration_account_id,
         carrier_account_id, provider, environment, purpose,
         adapter_version, credential_version, carrier_selection_key, request_hash,
         redacted_request, redacted_response, status, requested_at,
         completed_at
       ) VALUES
         ('grq0009301', $1, $2, $3, 'ups_rest', 'sandbox',
          'cartonization_shipment_rate', 'fixture-v1', 1, $4, $5,
          $6::jsonb, $7::jsonb, 'succeeded', now(), now()),
         ('grq0009302', $1, $2, $3, 'ups_rest', 'sandbox',
          'cartonization_shipment_rate', 'fixture-v1', 1, $4, $8,
          $9::jsonb, $10::jsonb, 'succeeded', now(), now())`,
      [
        ids.organization,
        ids.carrierIntegration,
        ids.carrierAccount,
        UPS_SELECTION_KEY,
        HASH.planningCarrierRequest,
        exactRateRequest,
        JSON.stringify({
          rates: [{ serviceCode: '03', currency: 'USD', amount: '12.00' }],
        }),
        HASH.purchaseCarrierRequest,
        exactRateRequest,
        JSON.stringify({
          rates: [{ serviceCode: '03', currency: 'USD', amount: '13.00' }],
        }),
      ],
    )
  await client.query(
      `INSERT INTO operations_orders (
         id, global_id, organization_id, pipeline_id, customer_id,
         integration_account_id, source_provider, external_order_id,
         order_number, order_type, status, currency,
         merchandise_total_minor, ship_to, source_payload
       ) VALUES (
         $1, 'gor0009301', $2, $3, $4, $5, 'clawpilot_native',
         'one-off-group-order-1', 'ONE-OFF-GROUP-1', 'one_off', 'packed',
         'USD', 2500, $6::jsonb, '{}'::jsonb
       )`,
      [
        ids.order,
        ids.organization,
        ids.pipeline,
        ids.customer,
        ids.nativeIntegration,
        JSON.stringify(destination),
      ],
    )
  for (const [index, lineId] of ids.lines.entries()) {
    await client.query(
        `INSERT INTO operations_order_lines (
           id, global_id, organization_id, order_id, pipeline_id,
           product_id, external_line_id, channel_sku, description,
           quantity, unit_price_minor, weight_grams, dimensions_mm
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           1, $10, $11, $12::jsonb
         )`,
        [
          lineId,
          `gol000930${index + 1}`,
          ids.organization,
          ids.order,
          ids.pipeline,
          ids.products[index],
          `line-${index + 1}`,
          `ONE-OFF-FIXTURE-${index + 1}`,
          `One-off fixture item ${index + 1}`,
          index === 0 ? 1000 : 1500,
          index === 0 ? 1000 : 2000,
          JSON.stringify(index === 0
            ? { length: 300, width: 200, height: 100 }
            : { length: 400, width: 250, height: 150 }),
        ],
      )
  }
  await client.query('SET LOCAL session_replication_role = origin')
}

async function insertCanonicalPlanPackages(client, ids) {
  await client.query(
    `INSERT INTO operations_fulfillment_plans (
       id, organization_id, order_id, warehouse_id, status, method,
       solver_status, estimated_cost_minor, promised_delivery_at,
       explanation, one_off_quote_id, one_off_offer_id
     ) VALUES (
       $1, $2, $3, $4, 'released', 'manual_override', 'optimal', 1200,
       now() + interval '3 days', '{}'::jsonb, $5, $6
     )`,
    [
      ids.plan,
      ids.organization,
      ids.order,
      ids.warehouse,
      ids.planningQuote,
      ids.planningOffer,
    ],
  )
  for (const [index, packageId] of ids.packages.entries()) {
    const dimensions = index === 0
      ? [300, 200, 100, 1000]
      : [400, 250, 150, 2000]
    await client.query(
      `INSERT INTO operations_packages (
         id, organization_id, plan_id, package_number, length_mm,
         width_mm, height_mm, weight_grams, status, packed_by, packed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'packed', $9, now()
       )`,
      [
        packageId,
        ids.organization,
        ids.plan,
        index + 1,
        ...dimensions,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_package_contents (
         id, organization_id, plan_id, order_id, package_id,
         order_line_id, quantity, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)`,
      [
        ids.packageContents[index],
        ids.organization,
        ids.plan,
        ids.order,
        packageId,
        ids.lines[index],
        actorEmail,
      ],
    )
  }
}

async function insertQuoteAuthority(
  client,
  ids,
  {
    quoteId,
    offerId,
    idempotencyKey,
    quoteRequestHash,
    carrierRequestHash,
    carrierResponseHash,
    evidenceGlobalId,
    amountMinor,
    packedRerate = false,
  },
) {
  const snapshots = quoteSnapshots(ids)
  const selection = exactUpsSelection(snapshots.packages)
  const result = {
    status: 'succeeded',
    eligibleOfferCount: 1,
    errorCode: null,
  }
  await client.query(
    `INSERT INTO operations_one_off_shipment_quote_commands (
       organization_id, idempotency_key, request_hash, actor_email
     ) VALUES ($1, $2, $3, $4)`,
    [ids.organization, idempotencyKey, quoteRequestHash, actorEmail],
  )
  await client.query(
    `INSERT INTO operations_one_off_shipment_quotes (
       id, organization_id, pipeline_id, customer_id, warehouse_id,
       inventory_pool_id, receiving_location_id, rate_environment,
       reference_number, currency, destination_snapshot, destination_hash,
       lines_snapshot, lines_hash, packages_snapshot, packages_hash,
       required_carrier_providers, provider_results_snapshot,
       required_transport_sources, transport_results_snapshot,
       required_carrier_selections, carrier_selection_results_snapshot,
       carrier_selection_schema_version, request_hash,
       status, idempotency_key, actor_email, expires_at, execution_mode,
       packed_rerate_order_id, packed_rerate_plan_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'sandbox', $8, 'USD',
       $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14,
       ARRAY['ups_rest']::text[], $15::jsonb,
       ARRAY['ups_rest:small_parcel']::text[], $16::jsonb,
       $17::jsonb, $18::jsonb, 1, $19, 'succeeded', $20,
       $21, now() + interval '1 hour', 'test', $22, $23
     )`,
    [
      quoteId,
      ids.organization,
      ids.pipeline,
      ids.customer,
      ids.warehouse,
      ids.inventoryPool,
      ids.receivingLocation,
      packedRerate ? 'ONE-OFF-GROUP-PACKED-RERATE' : 'ONE-OFF-GROUP-PLAN',
      JSON.stringify(destination),
      HASH.destination,
      JSON.stringify(snapshots.lines),
      HASH.lines,
      JSON.stringify(snapshots.packages),
      HASH.packages,
      JSON.stringify({ ups_rest: result }),
      JSON.stringify({ 'ups_rest:small_parcel': result }),
      JSON.stringify([selection]),
      JSON.stringify({ [UPS_SELECTION_KEY]: result }),
      quoteRequestHash,
      idempotencyKey,
      actorEmail,
      packedRerate ? ids.order : null,
      packedRerate ? ids.plan : null,
    ],
  )
  await client.query(
    `INSERT INTO operations_one_off_shipment_quote_offers (
       id, organization_id, quote_id, integration_account_id,
       carrier_account_id, provider, environment, credential_version,
       carrier_selection_key,
       service_code, service_name, amount_minor, currency, transit_days,
       estimated_delivery_at, rate_evidence_global_id,
       carrier_request_hash, carrier_response_hash, offer_snapshot
     ) VALUES (
       $1, $2, $3, $4, $5, 'ups_rest', 'sandbox', 1, $6, '03',
       'UPS Ground', $7, 'USD', 3, now() + interval '3 days',
       $8, $9, $10, $11::jsonb
     )`,
    [
      offerId,
      ids.organization,
      quoteId,
      ids.carrierIntegration,
      ids.carrierAccount,
      UPS_SELECTION_KEY,
      amountMinor,
      evidenceGlobalId,
      carrierRequestHash,
      carrierResponseHash,
      JSON.stringify({ serviceCode: '03', amountMinor, currency: 'USD' }),
    ],
  )
  await client.query(
    `UPDATE operations_one_off_shipment_quote_commands
     SET state = 'completed', quote_id = $3, completed_at = now()
     WHERE organization_id = $1 AND idempotency_key = $2`,
    [ids.organization, idempotencyKey, quoteId],
  )
}

async function seedOneOffAuthority(client, ids) {
  await insertQuoteAuthority(client, ids, {
    quoteId: ids.planningQuote,
    offerId: ids.planningOffer,
    idempotencyKey: 'one-off-group-planning-quote-1',
    quoteRequestHash: HASH.planningRequest,
    carrierRequestHash: HASH.planningCarrierRequest,
    carrierResponseHash: HASH.planningCarrierResponse,
    evidenceGlobalId: 'grq0009301',
    amountMinor: 1200,
  })
  await client.query(
    `INSERT INTO operations_one_off_shipment_quote_consumptions (
       organization_id, quote_id, order_id, offer_id, reason, consumed_by
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ids.organization,
      ids.planningQuote,
      ids.order,
      ids.planningOffer,
      'Create the canonical native one-off fixture order',
      actorEmail,
    ],
  )
  await insertCanonicalPlanPackages(client, ids)
  await client.query(
    `INSERT INTO operations_carrier_rates (
       id, organization_id, plan_id, carrier, service_code, service_name,
       internal_cost_minor, customer_charge_minor, transit_days,
       estimated_delivery_at, meets_promise, selected, quote_snapshot,
       one_off_quote_id, one_off_offer_id,
       one_off_rate_evidence_global_id, one_off_currency
     ) VALUES (
       $1, $2, $3, 'ups', '03', 'UPS Ground', 1200, 1200, 3,
       now() + interval '3 days', true, true, '{}'::jsonb,
       $4, $5, 'grq0009301', 'USD'
     )`,
    [
      ids.carrierRate,
      ids.organization,
      ids.plan,
      ids.planningQuote,
      ids.planningOffer,
    ],
  )
  await insertQuoteAuthority(client, ids, {
    quoteId: ids.purchaseQuote,
    offerId: ids.purchaseOffer,
    idempotencyKey: 'one-off-group-packed-rerate-1',
    quoteRequestHash: HASH.purchaseRequest,
    carrierRequestHash: HASH.purchaseCarrierRequest,
    carrierResponseHash: HASH.purchaseCarrierResponse,
    evidenceGlobalId: 'grq0009302',
    amountMinor: 1300,
    packedRerate: true,
  })
}

async function seedStandardMaskedLabelAuthority(client, ids) {
  await client.query('SET LOCAL session_replication_role = replica')
  await client.query(
    `INSERT INTO operations_orders (
       id, global_id, organization_id, pipeline_id, customer_id,
       integration_account_id, source_provider, external_order_id,
       order_number, order_type, status, currency,
       merchandise_total_minor, ship_to, source_payload
     ) VALUES (
       $1, 'gor0009302', $2, $3, $4, $5, 'clawpilot_native',
       'standard-masked-label-order-1', 'STANDARD-MASKED-LABEL-1',
       'standard', 'packed', 'USD', 2500, $6::jsonb, '{}'::jsonb
     )`,
    [
      ids.standardOrder,
      ids.organization,
      ids.pipeline,
      ids.customer,
      ids.nativeIntegration,
      JSON.stringify(destination),
    ],
  )
  await client.query(
    `INSERT INTO operations_fulfillment_plans (
       id, organization_id, order_id, warehouse_id, status, method,
       solver_status, estimated_cost_minor, promised_delivery_at,
       explanation
     ) VALUES (
       $1, $2, $3, $4, 'released', 'manual_override', 'optimal', 1200,
       now() + interval '3 days', '{}'::jsonb
     )`,
    [ids.standardPlan, ids.organization, ids.standardOrder, ids.warehouse],
  )
  await client.query(
    `INSERT INTO operations_packages (
       id, organization_id, plan_id, package_number, length_mm,
       width_mm, height_mm, weight_grams, status, packed_by, packed_at
     ) VALUES (
       $1, $2, $3, 1, 300, 200, 100, 1000, 'packed', $4, now()
     )`,
    [ids.standardPackage, ids.organization, ids.standardPlan, actorEmail],
  )
  await client.query(
    `INSERT INTO operations_carrier_rates (
       id, organization_id, plan_id, carrier, service_code, service_name,
       internal_cost_minor, customer_charge_minor, transit_days,
       estimated_delivery_at, meets_promise, selected, quote_snapshot
     ) VALUES (
       $1, $2, $3, 'UPS', '03', 'UPS Ground', 1200, 1200, 3,
       now() + interval '3 days', true, true, '{}'::jsonb
     )`,
    [ids.standardCarrierRate, ids.organization, ids.standardPlan],
  )
  await client.query(
    `INSERT INTO operations_label_attempts (
       id, organization_id, order_id, package_id, carrier_rate_id,
       integration_account_id, carrier_account_id, action, state,
       environment, provider, adapter_version, idempotency_key,
       request_hash, redacted_request, actor_email
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'create', 'prepared',
       'sandbox', 'ups_rest', 'fixture-v1', 'standard-masked-attempt-1',
       $8, '{}'::jsonb, $9
     )`,
    [
      ids.standardLabelAttempt,
      ids.organization,
      ids.standardOrder,
      ids.standardPackage,
      ids.standardCarrierRate,
      ids.carrierIntegration,
      ids.carrierAccount,
      HASH.label1Request,
      actorEmail,
    ],
  )
  await client.query('SET LOCAL session_replication_role = origin')
}

async function verifyStandardMaskedLabelAuthority(client, ids) {
  await client.query('BEGIN')
  try {
    const inserted = await client.query(
      `INSERT INTO operations_labels (
         organization_id, package_id, carrier_rate_id, carrier,
         service_code, tracking_number, format, label_payload,
         provider_label_id, idempotency_key, status,
         integration_account_id, carrier_account_id, environment,
         request_hash, redacted_provider_evidence, create_attempt_id
       ) VALUES (
         $1, $2, $3, 'UPS', '03', '1ZXXXXXXXXXXXXXXXX', 'ZPL',
         '^XA^FDstandard masked sandbox label^FS^XZ',
         'standard-masked-provider-label', 'standard-masked-label-1',
         'created', $4, $5, 'sandbox', $6, '{}'::jsonb, $7
       )
       RETURNING id::text`,
      [
        ids.organization,
        ids.standardPackage,
        ids.standardCarrierRate,
        ids.carrierIntegration,
        ids.carrierAccount,
        HASH.label1Request,
        ids.standardLabelAttempt,
      ],
    )
    assert.equal(inserted.rowCount, 1)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
  }

  await expectDatabaseReject(
    client,
    'unbound standard UPS masked sandbox label',
    /exact sandbox one-off group or standard label attempt/iu,
    () => client.query(
      `INSERT INTO operations_labels (
         organization_id, package_id, carrier_rate_id, carrier,
         service_code, tracking_number, format, label_payload,
         provider_label_id, idempotency_key, status,
         integration_account_id, carrier_account_id, environment,
         request_hash, redacted_provider_evidence
       ) VALUES (
         $1, $2, $3, 'UPS', '03', '1ZXXXXXXXXXXXXXXXX', 'ZPL',
         '^XA^FDunbound masked sandbox label^FS^XZ',
         'unbound-masked-provider-label', 'unbound-masked-label-1',
         'created', $4, $5, 'sandbox', $6, '{}'::jsonb
       )`,
      [
        ids.organization,
        ids.standardPackage,
        ids.standardCarrierRate,
        ids.carrierIntegration,
        ids.carrierAccount,
        HASH.label1Request,
      ],
    ),
  )
}

async function insertCarrierGroupAttempt(client, ids) {
  await client.query(
    `INSERT INTO operations_one_off_carrier_group_attempts (
       id, organization_id, order_id, plan_id, planning_quote_id,
       planning_offer_id, purchase_quote_id, purchase_offer_id,
       carrier_rate_id, integration_account_id, carrier_account_id,
       action, state, environment, provider, service_code, package_count,
       selected_amount_minor, currency, adapter_version, idempotency_key,
       request_hash, redacted_request, reason, actor_email
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       'create', 'prepared', 'sandbox', 'ups_rest', '03', 2, 1300,
       'USD', 'fixture-v1', 'one-off-group-create-1', $12,
       $13::jsonb, $14, $15
     )`,
    [
      ids.groupAttempt,
      ids.organization,
      ids.order,
      ids.plan,
      ids.planningQuote,
      ids.planningOffer,
      ids.purchaseQuote,
      ids.purchaseOffer,
      ids.carrierRate,
      ids.carrierIntegration,
      ids.carrierAccount,
      HASH.groupRequest,
      JSON.stringify({ packageCount: 2, provider: 'ups_rest', serviceCode: '03' }),
      'Buy the exact fresh packed two-package sandbox group',
      actorEmail,
    ],
  )
}

async function prepareCarrierGroup(client, ids) {
  await insertCarrierGroupAttempt(client, ids)
  await client.query(
    `INSERT INTO operations_one_off_purchase_quote_consumptions (
       organization_id, quote_id, offer_id, order_id, plan_id,
       carrier_group_attempt_id, reason, consumed_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      ids.organization,
      ids.purchaseQuote,
      ids.purchaseOffer,
      ids.order,
      ids.plan,
      ids.groupAttempt,
      'Consume the exact fresh packed two-package rate once',
      actorEmail,
    ],
  )
  for (const [index, packageId] of ids.packages.entries()) {
    const facts = index === 0
      ? ['package-1', 300, 200, 100, 1000, 600]
      : ['package-2', 400, 250, 150, 2000, 700]
    await client.query(
      `INSERT INTO operations_one_off_carrier_group_members (
         organization_id, carrier_group_attempt_id, order_id, plan_id,
         package_id, package_number, quote_package_key, length_mm,
         width_mm, height_mm, weight_grams, allocated_selected_cost_minor,
         parcel_snapshot_hash
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         operations_one_off_package_snapshot_hash($1, $4, $5, $13)
       )`,
      [
        ids.organization,
        ids.groupAttempt,
        ids.order,
        ids.plan,
        packageId,
        index + 1,
        ...facts,
        ids.purchaseQuote,
      ],
    )
  }
}

async function insertGroupLabelAndResult(
  client,
  ids,
  index,
  labelId,
  {
    carrier = 'UPS',
    serviceCode = '03',
    resultContentSha256 = null,
    resultByteLength = null,
  } = {},
) {
  const trackingNumber = index === 0
    ? '1Z0000000000000001'
    : '1Z0000000000000002'
  const providerPackageReference = `fixture-package-${index + 1}`
  const labelPayload = `^XA^FO20,20^FD${trackingNumber}^FS^XZ`
  const labelContentSha256 = createHash('sha256')
    .update(labelPayload, 'utf8')
    .digest('hex')
  const labelByteLength = Buffer.byteLength(labelPayload, 'utf8')
  await client.query(
    `UPDATE operations_packages
     SET status = 'labeled'
     WHERE organization_id = $1 AND id = $2`,
    [ids.organization, ids.packages[index]],
  )
  await client.query(
    `INSERT INTO operations_labels (
       id, organization_id, package_id, carrier_rate_id, carrier,
       service_code, tracking_number, format, label_payload,
       provider_label_id, idempotency_key, status,
       integration_account_id, carrier_account_id, environment,
       request_hash, redacted_provider_evidence,
       one_off_carrier_group_attempt_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'ZPL', $8, $9, $10,
       'created', $11, $12, 'sandbox', $13, $14::jsonb, $15
     )`,
    [
      labelId,
      ids.organization,
      ids.packages[index],
      ids.carrierRate,
      carrier,
      serviceCode,
      trackingNumber,
      labelPayload,
      providerPackageReference,
      `one-off-group-label-${index + 1}`,
      ids.carrierIntegration,
      ids.carrierAccount,
      index === 0 ? HASH.label1Request : HASH.label2Request,
      JSON.stringify({
        provider: 'ups_rest',
        packageNumber: index + 1,
        labelContentSha256,
        labelByteLength,
      }),
      ids.groupAttempt,
    ],
  )
  await client.query(
    `INSERT INTO operations_one_off_carrier_group_results (
       organization_id, carrier_group_attempt_id, package_id,
       package_number, label_id, tracking_number,
       provider_package_reference, redacted_provider_evidence
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      ids.organization,
      ids.groupAttempt,
      ids.packages[index],
      index + 1,
      labelId,
      trackingNumber,
      providerPackageReference,
      JSON.stringify({
        provider: 'ups_rest',
        packageNumber: index + 1,
        contentSha256: resultContentSha256 || labelContentSha256,
        byteLength: resultByteLength ?? labelByteLength,
      }),
    ],
  )
}

async function finalizeCarrierGroup(
  client,
  ids,
  labelIds,
  count = 2,
  optionsByIndex = [],
) {
  for (let index = 0; index < count; index += 1) {
    await insertGroupLabelAndResult(
      client,
      ids,
      index,
      labelIds[index],
      optionsByIndex[index],
    )
  }
  await client.query(
    `UPDATE operations_one_off_carrier_group_attempts
     SET state = 'succeeded', completed_at = now(),
         provider_charge_minor = 1350, provider_charge_currency = 'USD',
         charge_variance_minor = 50,
         master_tracking_number = '1Z0000000000000001',
         provider_shipment_id = 'fixture-whole-shipment-1',
         provider_reference = 'fixture-whole-shipment-1',
         redacted_response = $3::jsonb
     WHERE organization_id = $1 AND id = $2`,
    [
      ids.organization,
      ids.groupAttempt,
      JSON.stringify({ packageCount: count, provider: 'ups_rest' }),
    ],
  )
}

async function insertPreparedCloseAttempt(client, ids, action = 'void') {
  const inserted = await client.query(
    `INSERT INTO operations_one_off_carrier_group_attempts (
       organization_id, order_id, plan_id,
       planning_quote_id, planning_offer_id,
       purchase_quote_id, purchase_offer_id, carrier_rate_id,
       integration_account_id, carrier_account_id, create_attempt_id,
       action, environment, provider, service_code, package_count,
       selected_amount_minor, currency, adapter_version,
       idempotency_key, request_hash, redacted_request,
       master_tracking_number, provider_shipment_id,
       reason, actor_email
     )
     SELECT organization_id, order_id, plan_id,
            planning_quote_id, planning_offer_id,
            purchase_quote_id, purchase_offer_id, carrier_rate_id,
            integration_account_id, carrier_account_id, id,
            $3, environment, provider, service_code, package_count,
            selected_amount_minor, currency, adapter_version,
            $4, $5, $6::jsonb,
            master_tracking_number, provider_shipment_id,
            $7, $8
     FROM operations_one_off_carrier_group_attempts
     WHERE organization_id = $1 AND id = $2
     RETURNING id::text`,
    [
      ids.organization,
      ids.groupAttempt,
      action,
      `one-off-group-${action}-${randomUUID()}`,
      createHash('sha256').update(`fixture-${action}`).digest('hex'),
      JSON.stringify({ fixture: true, action }),
      `Exercise exact whole-group ${action} transition`,
      actorEmail,
    ],
  )
  return inserted.rows[0].id
}

async function exerciseSuccessfulWholeGroupVoid(client, ids, closeAttemptId) {
  await client.query(
    `UPDATE operations_labels
     SET status = 'voided', one_off_void_group_attempt_id = $3,
         voided_at = now(), voided_by = $4,
         redacted_provider_evidence = redacted_provider_evidence
           || jsonb_build_object('void', $5::jsonb)
     WHERE organization_id = $1
       AND one_off_carrier_group_attempt_id = $2`,
    [
      ids.organization,
      ids.groupAttempt,
      closeAttemptId,
      actorEmail,
      JSON.stringify({ fixture: true, wholeShipment: true }),
    ],
  )
  await client.query(
    `UPDATE operations_packages package
     SET status = 'packed'
     FROM operations_one_off_carrier_group_members member
     WHERE member.organization_id = $1
       AND member.carrier_group_attempt_id = $2
       AND package.organization_id = member.organization_id
       AND package.id = member.package_id`,
    [ids.organization, ids.groupAttempt],
  )
  await client.query(
    `UPDATE operations_one_off_carrier_group_attempts
     SET state = 'succeeded', completed_at = now(),
         provider_reference = provider_shipment_id,
         redacted_response = '{"fixture":true,"voided":true}'::jsonb
     WHERE organization_id = $1 AND id = $2`,
    [ids.organization, closeAttemptId],
  )
  await client.query('SET CONSTRAINTS ALL IMMEDIATE')
  const closed = await client.query(
    `SELECT count(*)::integer AS count
     FROM operations_labels
     WHERE organization_id = $1
       AND one_off_carrier_group_attempt_id = $2
       AND one_off_void_group_attempt_id = $3
       AND status = 'voided'`,
    [ids.organization, ids.groupAttempt, closeAttemptId],
  )
  assert.equal(closed.rows[0].count, 2)
}

async function expectDatabaseReject(client, label, expected, operation) {
  await client.query('BEGIN')
  let caught = null
  try {
    await operation()
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
  } catch (error) {
    caught = error
  } finally {
    await client.query('ROLLBACK').catch(() => {})
  }
  assert.ok(caught, `${label} unexpectedly passed PostgreSQL authority checks`)
  assert.match(caught.message, expected, `${label} returned an unexpected rejection`)
}

async function verifyAcceptance(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'clawpilot-one-off-group-persistence-acceptance',
    max: 1,
  })
  const client = await pool.connect()
  const ids = fixtureIds()
  try {
    await client.query('BEGIN')
    await seedPrerequisites(client, ids)
    await seedOneOffAuthority(client, ids)
    await seedStandardMaskedLabelAuthority(client, ids)
    await client.query('COMMIT')

    await verifyStandardMaskedLabelAuthority(client, ids)

    const freshBeforeConsumption = await client.query(
      `SELECT operations_one_off_purchase_quote_is_valid(
         $1, $2, $3, $4
       ) AS is_valid`,
      [ids.organization, ids.plan, ids.purchaseQuote, ids.purchaseOffer],
    )
    assert.equal(freshBeforeConsumption.rows[0].is_valid, true)

    await expectDatabaseReject(
      client,
      'competing package label before whole-group preparation',
      /competing active label/iu,
      async () => {
        await client.query(
          `INSERT INTO operations_labels (
             organization_id, package_id, carrier_rate_id, carrier,
             service_code, tracking_number, format, label_payload,
             provider_label_id, idempotency_key, status,
             integration_account_id, carrier_account_id, environment,
             request_hash, redacted_provider_evidence
           ) VALUES (
             $1, $2, $3, 'ups', '03', '1ZCOMPETING0000001', 'ZPL',
             '^XA^FDcompeting^FS^XZ', 'competing-provider-label',
             'one-off-competing-label', 'created', $4, $5, 'sandbox',
             $6, '{}'::jsonb
           )`,
          [
            ids.organization,
            ids.packages[0],
            ids.carrierRate,
            ids.carrierIntegration,
            ids.carrierAccount,
            HASH.label1Request,
          ],
        )
        await insertCarrierGroupAttempt(client, ids)
      },
    )

    await client.query('BEGIN')
    await prepareCarrierGroup(client, ids)
    await client.query('COMMIT')

    const prepared = await client.query(
      `SELECT attempt.state, attempt.package_count,
              count(member.id)::integer AS member_count,
              sum(member.allocated_selected_cost_minor)::bigint AS allocated
       FROM operations_one_off_carrier_group_attempts attempt
       JOIN operations_one_off_carrier_group_members member
         ON member.organization_id = attempt.organization_id
        AND member.carrier_group_attempt_id = attempt.id
       WHERE attempt.organization_id = $1 AND attempt.id = $2
       GROUP BY attempt.state, attempt.package_count`,
      [ids.organization, ids.groupAttempt],
    )
    assert.deepEqual(prepared.rows[0], {
      state: 'prepared',
      package_count: 2,
      member_count: 2,
      allocated: '1300',
    })

    const freshAfterConsumption = await client.query(
      `SELECT operations_one_off_purchase_quote_is_valid(
         $1, $2, $3, $4
       ) AS is_valid`,
      [ids.organization, ids.plan, ids.purchaseQuote, ids.purchaseOffer],
    )
    assert.equal(freshAfterConsumption.rows[0].is_valid, false)

    await expectDatabaseReject(
      client,
      'duplicate fresh purchase quote consumption',
      /duplicate key|unique constraint/iu,
      () => client.query(
        `INSERT INTO operations_one_off_purchase_quote_consumptions (
           organization_id, quote_id, offer_id, order_id, plan_id,
           carrier_group_attempt_id, reason, consumed_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ids.organization,
          ids.purchaseQuote,
          ids.purchaseOffer,
          ids.order,
          ids.plan,
          ids.groupAttempt,
          'Attempt to consume the packed quote twice',
          actorEmail,
        ],
      ),
    )

    await expectDatabaseReject(
      client,
      'wrong carrier label for prepared whole group',
      /exact prepared group member/iu,
      () => insertGroupLabelAndResult(
        client,
        ids,
        0,
        randomUUID(),
        { carrier: 'FedEx' },
      ),
    )

    await expectDatabaseReject(
      client,
      'wrong service label for prepared whole group',
      /exact prepared group member/iu,
      () => insertGroupLabelAndResult(
        client,
        ids,
        0,
        randomUUID(),
        { serviceCode: '02' },
      ),
    )

    await expectDatabaseReject(
      client,
      'label payload digest mismatch against immutable group result',
      /one exact active label per package/iu,
      () => finalizeCarrierGroup(
        client,
        ids,
        [randomUUID(), randomUUID()],
        2,
        [{ resultContentSha256: 'f'.repeat(64) }, {}],
      ),
    )

    await expectDatabaseReject(
      client,
      'partial one-package provider result set',
      /one exact active label per package/iu,
      async () => {
        await finalizeCarrierGroup(client, ids, [randomUUID()], 1)
      },
    )

    const labelIds = [randomUUID(), randomUUID()]
    await client.query('BEGIN')
    await finalizeCarrierGroup(client, ids, labelIds)
    await client.query('COMMIT')

    const complete = await client.query(
      `SELECT attempt.state, attempt.package_count,
              count(DISTINCT member.id)::integer AS member_count,
              count(DISTINCT result.id)::integer AS result_count,
              count(DISTINCT label.id)::integer AS label_count,
              count(DISTINCT package.id) FILTER (
                WHERE package.status = 'labeled'
              )::integer AS labeled_package_count,
              attempt.provider_charge_minor,
              attempt.charge_variance_minor
       FROM operations_one_off_carrier_group_attempts attempt
       JOIN operations_one_off_carrier_group_members member
         ON member.organization_id = attempt.organization_id
        AND member.carrier_group_attempt_id = attempt.id
       JOIN operations_one_off_carrier_group_results result
         ON result.organization_id = member.organization_id
        AND result.carrier_group_attempt_id = member.carrier_group_attempt_id
        AND result.package_id = member.package_id
       JOIN operations_labels label
         ON label.organization_id = result.organization_id
        AND label.id = result.label_id
       JOIN operations_packages package
         ON package.organization_id = member.organization_id
        AND package.id = member.package_id
       WHERE attempt.organization_id = $1 AND attempt.id = $2
       GROUP BY attempt.state, attempt.package_count,
                attempt.provider_charge_minor, attempt.charge_variance_minor`,
      [ids.organization, ids.groupAttempt],
    )
    assert.deepEqual(complete.rows[0], {
      state: 'succeeded',
      package_count: 2,
      member_count: 2,
      result_count: 2,
      label_count: 2,
      labeled_package_count: 2,
      provider_charge_minor: '1350',
      charge_variance_minor: '50',
    })

    await expectDatabaseReject(
      client,
      'succeeded group label payload tamper',
      /label identity and provider bytes are immutable/iu,
      () => client.query(
        `UPDATE operations_labels
         SET label_payload = label_payload || '^FXtampered^FS'
         WHERE organization_id = $1 AND id = $2`,
        [ids.organization, labelIds[0]],
      ),
    )

    await expectDatabaseReject(
      client,
      'succeeded group provider label identity tamper',
      /label identity and provider bytes are immutable/iu,
      () => client.query(
        `UPDATE operations_labels
         SET provider_label_id = provider_label_id || '-tampered'
         WHERE organization_id = $1 AND id = $2`,
        [ids.organization, labelIds[0]],
      ),
    )

    await expectDatabaseReject(
      client,
      'succeeded group provider evidence tamper',
      /label lifecycle evidence is immutable/iu,
      () => client.query(
        `UPDATE operations_labels
         SET redacted_provider_evidence = redacted_provider_evidence
           || '{"tampered":true}'::jsonb
         WHERE organization_id = $1 AND id = $2`,
        [ids.organization, labelIds[0]],
      ),
    )

    await expectDatabaseReject(
      client,
      'UPS TEST local close with non-sample provider shipment ID',
      /Local sample close is limited to UPS CIE sample shipments/iu,
      async () => {
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `UPDATE operations_one_off_carrier_group_attempts
           SET master_tracking_number = '1ZXXXXXXXXXXXXXXXX',
               provider_shipment_id = 'not-a-cie-sample-shipment',
               provider_reference = 'not-a-cie-sample-shipment'
           WHERE organization_id = $1 AND id = $2`,
          [ids.organization, ids.groupAttempt],
        )
        await client.query(
          `UPDATE operations_labels
           SET tracking_number = '1ZXXXXXXXXXXXXXXXX'
           WHERE organization_id = $1
             AND one_off_carrier_group_attempt_id = $2`,
          [ids.organization, ids.groupAttempt],
        )
        await client.query(
          `UPDATE operations_one_off_carrier_group_results
           SET tracking_number = '1ZXXXXXXXXXXXXXXXX'
           WHERE organization_id = $1 AND carrier_group_attempt_id = $2`,
          [ids.organization, ids.groupAttempt],
        )
        await client.query('SET LOCAL session_replication_role = origin')
        await insertPreparedCloseAttempt(client, ids, 'close_sample')
      },
    )

    await expectDatabaseReject(
      client,
      'canonical package geometry tamper',
      /package facts are immutable/iu,
      () => client.query(
        `UPDATE operations_packages
         SET length_mm = length_mm + 1
         WHERE organization_id = $1 AND id = $2`,
        [ids.organization, ids.packages[0]],
      ),
    )

    await expectDatabaseReject(
      client,
      'canonical package content tamper',
      /content allocations are immutable|exactly match its immutable quote parcels/iu,
      () => client.query(
        `UPDATE operations_package_contents
         SET quantity = quantity + 1
         WHERE organization_id = $1 AND id = $2`,
        [ids.organization, ids.packageContents[0]],
      ),
    )

    await expectDatabaseReject(
      client,
      'NULL one-off label group lineage bypass',
      /cannot mix label lineage with an active carrier group/iu,
      () => client.query(
        `INSERT INTO operations_labels (
           organization_id, package_id, carrier_rate_id, carrier,
           service_code, tracking_number, format, label_payload,
           provider_label_id, idempotency_key, status,
           integration_account_id, carrier_account_id, environment,
           request_hash, redacted_provider_evidence
         ) VALUES (
           $1, $2, $3, 'ups', '03', '1ZNULLLINEAGE00001', 'ZPL',
           '^XA^FDnull lineage^FS^XZ', 'null-lineage-provider-label',
           'one-off-null-lineage-label', 'created', $4, $5, 'sandbox',
           $6, '{}'::jsonb
         )`,
        [
          ids.organization,
          ids.packages[0],
          ids.carrierRate,
          ids.carrierIntegration,
          ids.carrierAccount,
          HASH.label1Request,
        ],
      ),
    )

    await expectDatabaseReject(
      client,
      'shipment NULL carrier-group lineage bypass',
      /requires the exact carrier group lineage/iu,
      () => client.query(
        `INSERT INTO operations_shipments (
           organization_id, order_id, plan_id, package_id, label_id,
           status, tracking_number, quoted_carrier_cost_minor,
           confirmed_by
         ) VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, 600, $7)`,
        [
          ids.organization,
          ids.order,
          ids.plan,
          ids.packages[0],
          labelIds[0],
          '1Z0000000000000001',
          actorEmail,
        ],
      ),
    )

    await expectDatabaseReject(
      client,
      'one-off shipment wrong allocated package cost',
      /exact complete active carrier group/iu,
      () => client.query(
        `INSERT INTO operations_shipments (
           organization_id, order_id, plan_id, package_id, label_id,
           status, tracking_number, quoted_carrier_cost_minor,
           confirmed_by, one_off_carrier_group_attempt_id
         ) VALUES (
           $1, $2, $3, $4, $5, 'confirmed', $6, 601, $7, $8
         )`,
        [
          ids.organization,
          ids.order,
          ids.plan,
          ids.packages[0],
          labelIds[0],
          '1Z0000000000000001',
          actorEmail,
          ids.groupAttempt,
        ],
      ),
    )

    await expectDatabaseReject(
      client,
      'one-off shipment allocated package cost tamper',
      /shipment identity and cost are immutable/iu,
      async () => {
        const inserted = await client.query(
          `INSERT INTO operations_shipments (
             organization_id, order_id, plan_id, package_id, label_id,
             status, tracking_number, quoted_carrier_cost_minor,
             confirmed_by, one_off_carrier_group_attempt_id
           ) VALUES (
             $1, $2, $3, $4, $5, 'confirmed', $6, 600, $7, $8
           ) RETURNING id`,
          [
            ids.organization,
            ids.order,
            ids.plan,
            ids.packages[0],
            labelIds[0],
            '1Z0000000000000001',
            actorEmail,
            ids.groupAttempt,
          ],
        )
        await client.query(
          `UPDATE operations_shipments
           SET quoted_carrier_cost_minor = 601
           WHERE id = $1`,
          [inserted.rows[0].id],
        )
      },
    )

    await expectDatabaseReject(
      client,
      'one-off shipment deletion',
      /shipments cannot be deleted/iu,
      async () => {
        const inserted = await client.query(
          `INSERT INTO operations_shipments (
             organization_id, order_id, plan_id, package_id, label_id,
             status, tracking_number, quoted_carrier_cost_minor,
             confirmed_by, one_off_carrier_group_attempt_id
           ) VALUES (
             $1, $2, $3, $4, $5, 'confirmed', $6, 600, $7, $8
           ) RETURNING id`,
          [
            ids.organization,
            ids.order,
            ids.plan,
            ids.packages[0],
            labelIds[0],
            '1Z0000000000000001',
            actorEmail,
            ids.groupAttempt,
          ],
        )
        await client.query(
          'DELETE FROM operations_shipments WHERE id = $1',
          [inserted.rows[0].id],
        )
      },
    )

    await expectDatabaseReject(
      client,
      'cross-mode public void idempotency-key reuse',
      /operations_one_off_group_void_idempotency_unique|duplicate key|unique constraint/iu,
      async () => {
        await client.query('SET LOCAL session_replication_role = replica')
        for (const [action, requestHash] of [
          ['void', 'a'.repeat(64)],
          ['close_sample', 'b'.repeat(64)],
        ]) {
          await client.query(
            `INSERT INTO operations_one_off_carrier_group_attempts (
               organization_id, order_id, plan_id,
               planning_quote_id, planning_offer_id,
               purchase_quote_id, purchase_offer_id, carrier_rate_id,
               integration_account_id, carrier_account_id, create_attempt_id,
               action, state, environment, provider, service_code,
               package_count, selected_amount_minor, currency, adapter_version,
               idempotency_key, request_hash, redacted_request,
               master_tracking_number, provider_shipment_id,
               error_code, reason, actor_email, completed_at
             )
             SELECT organization_id, order_id, plan_id,
                    planning_quote_id, planning_offer_id,
                    purchase_quote_id, purchase_offer_id, carrier_rate_id,
                    integration_account_id, carrier_account_id, id,
                    $3, 'failed', environment, provider, service_code,
                    package_count, selected_amount_minor, currency, adapter_version,
                    $4, $5, $6::jsonb,
                    master_tracking_number, provider_shipment_id,
                    'FIXTURE_REJECTED', $7, $8, now()
             FROM operations_one_off_carrier_group_attempts
             WHERE organization_id = $1 AND id = $2`,
            [
              ids.organization,
              ids.groupAttempt,
              action,
              'shared-public-void-command-key',
              requestHash,
              JSON.stringify({ fixture: true, action }),
              `Exercise cross-mode ${action} idempotency-key reuse`,
              actorEmail,
            ],
          )
        }
      },
    )

    const persistedCounts = await client.query(
      `SELECT
         (SELECT count(*)::integer
          FROM operations_one_off_purchase_quote_consumptions
          WHERE organization_id = $1) AS purchase_consumptions,
         (SELECT count(*)::integer
          FROM operations_one_off_carrier_group_attempts
          WHERE organization_id = $1) AS group_attempts,
         (SELECT count(*)::integer
          FROM operations_one_off_carrier_group_members
          WHERE organization_id = $1) AS members,
         (SELECT count(*)::integer
          FROM operations_one_off_carrier_group_results
          WHERE organization_id = $1) AS results,
         (SELECT count(*)::integer
          FROM operations_labels
          WHERE organization_id = $1) AS labels,
         (SELECT count(*)::integer
          FROM operations_shipments
          WHERE organization_id = $1) AS shipments`,
      [ids.organization],
    )
    assert.deepEqual(persistedCounts.rows[0], {
      purchase_consumptions: 1,
      group_attempts: 1,
      members: 2,
      results: 2,
      labels: 2,
      shipments: 0,
    })

    // Exercise the real prepare/commit/provider/finalize transaction shape.
    // The carrier call sits between these transactions in production.
    await client.query('BEGIN')
    const closeAttemptId = await insertPreparedCloseAttempt(client, ids)
    await client.query('COMMIT')
    await client.query('BEGIN')
    await exerciseSuccessfulWholeGroupVoid(client, ids, closeAttemptId)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-one-off-group-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_one_off_group',
      '-e', 'POSTGRES_DB=clawpilot_one_off_group',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      `postgresql://postgres:clawpilot_one_off_group@127.0.0.1:${port}`
      + '/clawpilot_one_off_group'
    )
    await waitForPostgres(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    await verifyAcceptance(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'One-off whole-group persistence disposable-PostgreSQL acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
