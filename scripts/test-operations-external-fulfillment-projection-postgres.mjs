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

function operationsPersistenceFor(pool) {
  const domain = loadTypeScriptModule('app_src/lib/operations/domain.ts', {
    '@/lib/operations/types': {},
  })
  const orderShipTo = loadTypeScriptModule(
    'app_src/lib/operations/orderShipTo.ts',
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
    fulfilledOrder: randomUUID(),
    dueOrder: randomUUID(),
    openOrder: randomUUID(),
    shippedOrder: randomUUID(),
    target: randomUUID(),
    observation: randomUUID(),
    read: randomUUID(),
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
           created_by, updated_by
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
           $6::uuid, 'shopify', $7, $8, $9, 'USD', 1000,
           ${promisedDeliverySql},
           '{"name":"Projection recipient","line1":"35 Saxony Drive",'
             '"city":"Trumbull","region":"CT","postalCode":"06611",'
             '"country":"US"}'::jsonb,
           jsonb_build_object('sourceHash', $10::text), $11, $11
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
          sourceHash,
          actorEmail,
        ],
      )
    }
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
         observed_at
       ) VALUES (
         $1::uuid, 'gcor0009701', $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, 'shopify', 1, 'gid://shopify/Order/9701',
         'projection-fulfilled-v1', $6, $7,
         $8::jsonb, 0, 1, 0, now()
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
         protected_snapshot_expires_at
       ) VALUES (
         $1::uuid, 'gcrr0009701', $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, 'shopify', 1, $7, $8, 0, 'scheduled',
         1, 0, now(), now() + interval '7 days'
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
  } finally {
    await client.query('SET session_replication_role = origin')
      .catch(() => undefined)
    client.release()
  }
  return ids
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
    assert.equal(workspace.orderPage.total, 115)
    assert.equal(workspace.orderPage.returned, 115)
    assert.equal(workspace.orderPage.nextCursor, null)
    assert.equal(workspace.orders.length, 115)
    assert.equal(projected?.status, 'imported')
    assert.equal(projected?.externallyFulfilled, true)
    assert.equal(workspace.selectedOrder?.globalId, 'gor0009701')
    assert.equal(workspace.selectedOrder?.status, 'imported')
    assert.equal(workspace.selectedOrder?.externallyFulfilled, true)
    assert.equal(
      workspace.selectedOrder?.externalFulfillment,
      null,
      'provider status evidence must not invent a reconciliation record',
    )
    assert.deepEqual(workspace.selectedOrder?.shipments, [])
    assert.deepEqual(workspace.selectedOrder?.printArtifacts, [])
    assert.deepEqual(workspace.selectedOrder?.labelPrintJobs, [])
    assert.equal(workspace.summary.openOrders, 2)
    assert.equal(workspace.summary.dueSoon, 1)

    const cancelledOrders = []
    let cancelledCursor = null
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
    } while (cancelledCursor)
    assert.equal(cancelledPages, 3)
    assert.equal(cancelledOrders.length, 111)
    assert.equal(
      new Set(cancelledOrders.map((order) => order.globalId)).size,
      111,
      'canonical keyset pages must include each matching order exactly once',
    )

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
      })),
      [{
        globalId: 'gor0009701',
        status: 'imported',
        externallyFulfilled: true,
      }],
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
      reconciliations: '0',
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
