#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const contractsOnly = process.argv.includes('--contracts-only')
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
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
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
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
      `${commandName} ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    )
  }
  return String(result.stdout || '').trim()
}

async function waitForPostgres(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 2000 })
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

function auditWriterMock() {
  return {
    recordAuditEvent: async (input, client) => {
      await client.query(
        `INSERT INTO audit_events (
           actor, event_type, aggregate_type, aggregate_id, payload, event_key,
           subject, organization_id, is_system
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, $9)
         ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
        [
          input.actor || null,
          input.eventType,
          input.aggregateType || null,
          input.aggregateId || null,
          JSON.stringify(input.payload || {}),
          input.eventKey || null,
          input.subject || input.actor || null,
          input.organizationId || null,
          input.isSystem === true,
        ],
      )
    },
  }
}

async function seedWorkspace(pool, scenario) {
  const suffix = randomUUID().slice(0, 8)
  const email = `shipment-completion-${suffix}@example.com`
  await pool.query(
    `INSERT INTO app_users (email, role, status, display_name)
     VALUES ($1, 'owner', 'active', 'Shipment completion acceptance')`,
    [email],
  )
  const organization = await pool.query(
    `INSERT INTO workspace_organizations (name, organization_type, created_by, updated_by)
     VALUES ($1, 'root', $2, $2)
     RETURNING id::text`,
    [`Shipment completion ${scenario} ${suffix}`, email],
  )
  const organizationId = organization.rows[0].id
  await pool.query(
    `UPDATE app_users
     SET organization_id = $2::uuid, organization_name = $3
     WHERE email = $1`,
    [email, organizationId, `Shipment completion ${scenario} ${suffix}`],
  )
  const pipeline = await pool.query(
    `INSERT INTO pipeline_spaces (name, owner_email, is_default, workspace_organization_id)
     VALUES ('Shipment completion pipeline', $1, true, $2::uuid)
     RETURNING id::text`,
    [email, organizationId],
  )
  const pipelineId = pipeline.rows[0].id
  const customer = await pool.query(
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, name, identity_key, workspace_organization_id,
       relationship_type, source_hash, created_by, updated_by
     ) VALUES ($1::uuid, $2, 'Mock shipment customer', $2, $3::uuid,
       'customer', $2, $4, $4)
     RETURNING id::text, reference_code, name`,
    [pipelineId, `shipment-customer-${suffix}`, organizationId, email],
  )
  const product = await pool.query(
    `INSERT INTO crm_products (
       pipeline_id, source_key, name, sku, product_type, price, cost,
       currency, source_hash, created_by, updated_by
     ) VALUES ($1::uuid, $2, 'Test shipment product', $3, 'Good',
       24.50, 9.25, 'USD', $2, $4, $4)
     RETURNING id::text, reference_code, name`,
    [pipelineId, `shipment-product-${suffix}`, `SHIP-${suffix}`, email],
  )
  return {
    email,
    organizationId,
    pipelineId,
    customer: customer.rows[0],
    product: product.rows[0],
  }
}

function proofInput(fixture, sequence) {
  const requested = new Date()
  requested.setUTCDate(requested.getUTCDate() + 10)
  return {
    customerGlobalId: fixture.customer.reference_code,
    productGlobalId: fixture.product.reference_code,
    externalOrderId: `shipment-${sequence}-${randomUUID()}`,
    orderNumber: `SHIP-${sequence}-${randomUUID().slice(0, 8)}`,
    quantity: 2,
    openingQuantity: 12,
    executionMode: 'planned',
    requestedDeliveryAt: requested.toISOString(),
    shipTo: {
      name: 'John Doe',
      line1: '101 Jegs Place',
      city: 'Delaware',
      region: 'OH',
      postalCode: '43015',
      country: 'US',
    },
  }
}

async function advanceOrderToPacked(persistence, fixture, sequence) {
  const planned = await persistence.runMockOperationsProofFromPostgres({
    organizationId: fixture.organizationId,
    actorEmail: fixture.email,
    proof: proofInput(fixture, sequence),
  })
  const workspace = await persistence.readOperationsWorkspaceFromPostgres({
    organizationId: fixture.organizationId,
    capabilities: { canView: true, canManage: true, canExecute: true },
    selectedOrderGlobalId: planned.orderGlobalId,
  })
  const released = await persistence.releaseOperationsOrderFromPostgres({
    organizationId: fixture.organizationId,
    actorEmail: fixture.email,
    orderGlobalId: planned.orderGlobalId,
    expectedRowVersion: workspace.selectedOrder.rowVersion,
    reason: `Release ${sequence} for shipment completion acceptance`,
    idempotencyKey: `release-${sequence}-${randomUUID()}`,
  })
  const picked = await persistence.confirmOperationsOrderPicksFromPostgres({
    organizationId: fixture.organizationId,
    actorEmail: fixture.email,
    orderGlobalId: planned.orderGlobalId,
    expectedRowVersion: released.rowVersion,
    reason: `Confirm ${sequence} pick for shipment completion acceptance`,
    idempotencyKey: `pick-${sequence}-${randomUUID()}`,
  })
  const packed = await persistence.verifyOperationsOrderPackFromPostgres({
    organizationId: fixture.organizationId,
    actorEmail: fixture.email,
    orderGlobalId: planned.orderGlobalId,
    expectedRowVersion: picked.rowVersion,
    reason: `Verify ${sequence} pack for shipment completion acceptance`,
    idempotencyKey: `pack-${sequence}-${randomUUID()}`,
  })
  return { planned, packed }
}

async function addActiveLabel(pool, fixture, orderGlobalId, environment) {
  const context = await pool.query(
    `SELECT package.id::text AS package_id,
            rate.id::text AS rate_id,
            rate.carrier,
            rate.service_code
     FROM operations_orders orders
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = orders.organization_id
      AND plan.order_id = orders.id
     JOIN operations_packages package
       ON package.organization_id = plan.organization_id
      AND package.plan_id = plan.id
     JOIN operations_carrier_rates rate
       ON rate.organization_id = plan.organization_id
      AND rate.plan_id = plan.id
      AND rate.selected = true
     WHERE orders.organization_id = $1::uuid
       AND orders.global_id = $2`,
    [fixture.organizationId, orderGlobalId],
  )
  assert.equal(context.rowCount, 1)
  const trackingNumber = `${environment === 'sandbox' ? 'SANDBOX' : 'MOCK'}${randomUUID()
    .replaceAll('-', '')
    .slice(0, 20)
    .toUpperCase()}`
  const label = await pool.query(
    `INSERT INTO operations_labels (
       organization_id, package_id, carrier_rate_id, carrier, service_code,
       tracking_number, format, label_payload, provider_label_id,
       idempotency_key, status, environment, redacted_provider_evidence
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5,
       $6, 'PDF', $7, $8, $9, 'created', $10, $11::jsonb
     )
     RETURNING id::text, global_id`,
    [
      fixture.organizationId,
      context.rows[0].package_id,
      context.rows[0].rate_id,
      context.rows[0].carrier,
      context.rows[0].service_code,
      trackingNumber,
      Buffer.from(`%PDF-1.4 ${environment} acceptance label`).toString('base64'),
      `${environment}-provider-${randomUUID()}`,
      `${environment}-label-${randomUUID()}`,
      environment,
      JSON.stringify({ environment, acceptance: true }),
    ],
  )
  await pool.query(
    `UPDATE operations_packages
     SET status = 'labeled'
     WHERE organization_id = $1::uuid
       AND id = $2::uuid`,
    [fixture.organizationId, context.rows[0].package_id],
  )
  return {
    ...label.rows[0],
    trackingNumber,
  }
}

async function splitPackedOrderIntoTwoPackagesForFixture(pool, fixture, orderGlobalId) {
  const source = await pool.query(
    `SELECT package.id::text AS package_id, package.plan_id::text,
            package.length_mm, package.width_mm, package.height_mm,
            package.weight_grams, package.packed_by, package.packed_at,
            content.id::text AS content_id,
            content.order_id::text, content.order_line_id::text
     FROM operations_orders source_order
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = source_order.organization_id
      AND plan.order_id = source_order.id
     JOIN operations_packages package
       ON package.organization_id = plan.organization_id
      AND package.plan_id = plan.id
     JOIN operations_package_contents content
       ON content.organization_id = package.organization_id
      AND content.package_id = package.id
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2`,
    [fixture.organizationId, orderGlobalId],
  )
  assert.equal(source.rowCount, 1)
  const row = source.rows[0]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'ALTER TABLE operations_package_contents DISABLE TRIGGER protect_operations_package_content_write',
    )
    await client.query(
      `UPDATE operations_package_contents SET quantity = 1
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, row.content_id],
    )
    const second = await client.query(
      `INSERT INTO operations_packages (
         organization_id, plan_id, package_number,
         length_mm, width_mm, height_mm, weight_grams,
         status, packed_by, packed_at
       ) VALUES ($1::uuid, $2::uuid, 2, $3, $4, $5, $6, 'packed', $7, $8)
       RETURNING id::text`,
      [
        fixture.organizationId, row.plan_id, row.length_mm, row.width_mm,
        row.height_mm, Math.max(1, Math.floor(row.weight_grams / 2)),
        row.packed_by, row.packed_at,
      ],
    )
    await client.query(
      `INSERT INTO operations_package_contents (
         organization_id, plan_id, order_id, package_id,
         order_line_id, quantity, created_by
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, $6)`,
      [
        fixture.organizationId, row.plan_id, row.order_id, second.rows[0].id,
        row.order_line_id, fixture.email,
      ],
    )
    await client.query(
      'ALTER TABLE operations_package_contents ENABLE TRIGGER protect_operations_package_content_write',
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function addSandboxLabelsForAllPackages(pool, fixture, orderGlobalId) {
  const context = await pool.query(
    `SELECT package.id::text AS package_id, package.global_id AS package_global_id,
            rate.id::text AS rate_id, rate.carrier, rate.service_code
     FROM operations_orders source_order
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = source_order.organization_id
      AND plan.order_id = source_order.id
     JOIN operations_packages package
       ON package.organization_id = plan.organization_id
      AND package.plan_id = plan.id
     JOIN operations_carrier_rates rate
       ON rate.organization_id = plan.organization_id
      AND rate.plan_id = plan.id AND rate.selected = true
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
     ORDER BY package.package_number`,
    [fixture.organizationId, orderGlobalId],
  )
  assert.equal(context.rowCount, 2)
  const trackingNumbers = []
  for (const [index, row] of context.rows.entries()) {
    const trackingNumber = `SANDBOXE2E${index + 1}${randomUUID()
      .replaceAll('-', '').slice(0, 16).toUpperCase()}`
    await pool.query(
      `INSERT INTO operations_labels (
         organization_id, package_id, carrier_rate_id, carrier, service_code,
         tracking_number, format, label_payload, provider_label_id,
         idempotency_key, status, environment, redacted_provider_evidence
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         $6, 'PDF', $7, $8, $9, 'created', 'sandbox', $10::jsonb
       )`,
      [
        fixture.organizationId, row.package_id, row.rate_id, row.carrier,
        row.service_code, trackingNumber,
        Buffer.from(`%PDF-1.4 sandbox E2E package ${index + 1}`).toString('base64'),
        `sandbox-e2e-provider-${randomUUID()}`,
        `sandbox-e2e-label-${randomUUID()}`,
        JSON.stringify({ environment: 'sandbox', packageGlobalId: row.package_global_id }),
      ],
    )
    await pool.query(
      `UPDATE operations_packages SET status = 'labeled'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, row.package_id],
    )
    trackingNumbers.push(trackingNumber)
  }
  return trackingNumbers
}

async function addPackagingClaim(pool, fixture, orderGlobalId) {
  const plan = await pool.query(
    `SELECT plan.id::text, plan.warehouse_id::text
     FROM operations_orders source_order
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = source_order.organization_id
      AND plan.order_id = source_order.id
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
     ORDER BY plan.version_number DESC
     LIMIT 1`,
    [fixture.organizationId, orderGlobalId],
  )
  assert.equal(plan.rowCount, 1)
  const code = `SHIP-${randomUUID().slice(0, 8).toUpperCase()}`
  const material = await pool.query(
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
       $1::uuid, $2, 'Shipment claim carton', 'carton',
       305, 229, 152, 120, 5000, 55,
       'USD', 'active', 'manual',
       'inner', 'measured', $3, now(), $4,
       305, 229, 152, 'measured', $3, now(), $4,
       $4, $4
     )
     RETURNING id::text, global_id`,
    [
      fixture.organizationId,
      code,
      `shipment-completion-measurement-${code.toLowerCase()}`,
      fixture.email,
    ],
  )
  const stock = await pool.query(
    `INSERT INTO operations_packaging_material_stock (
       organization_id, packaging_material_id, warehouse_id,
       is_available, on_hand_quantity, reorder_point_quantity,
       reorder_to_quantity, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, true, 3, 0, 3, $4, $4
     )
     RETURNING id::text, global_id, row_version::text,
               on_hand_quantity`,
    [
      fixture.organizationId,
      material.rows[0].id,
      plan.rows[0].warehouse_id,
      fixture.email,
    ],
  )
  const claim = await pool.query(
    `INSERT INTO operations_packaging_material_claims (
       organization_id, plan_id, packaging_material_id, warehouse_id,
       packaging_material_stock_id, quantity,
       stock_row_version_at_claim, on_hand_quantity_at_claim,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, 1, $6, $7, $8, $8
     )
     RETURNING id::text, global_id, status`,
    [
      fixture.organizationId,
      plan.rows[0].id,
      material.rows[0].id,
      plan.rows[0].warehouse_id,
      stock.rows[0].id,
      stock.rows[0].row_version,
      stock.rows[0].on_hand_quantity,
      fixture.email,
    ],
  )
  return {
    claim: claim.rows[0],
    stock: stock.rows[0],
  }
}

async function packagingClaimEvidence(pool, fixture, claimFixture) {
  const result = await pool.query(
    `SELECT claim.status, claim.consumed_at IS NOT NULL AS consumed,
            claim.released_at IS NOT NULL AS released,
            stock.on_hand_quantity,
            stock.row_version::text
     FROM operations_packaging_material_claims claim
     JOIN operations_packaging_material_stock stock
       ON stock.organization_id = claim.organization_id
      AND stock.id = claim.packaging_material_stock_id
     WHERE claim.organization_id = $1::uuid
       AND claim.id = $2::uuid`,
    [fixture.organizationId, claimFixture.claim.id],
  )
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

async function orderEvidence(pool, fixture, orderGlobalId) {
  const result = await pool.query(
    `SELECT orders.status,
            orders.row_version::int,
            COALESCE(sum(position.on_hand_quantity), 0)::text AS on_hand_quantity,
            COALESCE(sum(position.reserved_quantity), 0)::text AS reserved_quantity,
            (SELECT count(*)::int
             FROM operations_reservations reservation
             JOIN operations_order_lines line
               ON line.organization_id = reservation.organization_id
              AND line.id = reservation.order_line_id
             WHERE line.organization_id = orders.organization_id
               AND line.order_id = orders.id
               AND reservation.status = 'consumed') AS consumed_reservations,
            (SELECT count(*)::int
             FROM operations_shipments shipment
             WHERE shipment.organization_id = orders.organization_id
               AND shipment.order_id = orders.id) AS shipments,
            (SELECT count(*)::int
             FROM operations_print_artifacts artifact
             WHERE artifact.organization_id = orders.organization_id
               AND artifact.source_order_id = orders.id
               AND artifact.document_type = 'packing_slip') AS packing_slips,
            (SELECT count(*)::int
             FROM operations_print_artifact_payloads payload
             JOIN operations_print_artifacts artifact
               ON artifact.organization_id = payload.organization_id
              AND artifact.id = payload.artifact_id
             WHERE artifact.organization_id = orders.organization_id
               AND artifact.source_order_id = orders.id
               AND artifact.document_type = 'packing_slip') AS packing_slip_payloads,
            (SELECT count(*)::int
             FROM operations_tracking_observations observation
             JOIN operations_shipments shipment
               ON shipment.organization_id = observation.organization_id
              AND shipment.id = observation.shipment_id
             WHERE shipment.organization_id = orders.organization_id
               AND shipment.order_id = orders.id) AS tracking_observations,
            (SELECT count(*)::int
             FROM operations_commerce_fulfillment_exports export
             WHERE export.organization_id = orders.organization_id
               AND export.order_id = orders.id) AS fulfillment_exports,
            (SELECT count(*)::int
             FROM operations_inventory_ledger ledger
             WHERE ledger.organization_id = orders.organization_id
               AND ledger.event_type = 'ship'
               AND ledger.position_id IN (
                 SELECT shipped_allocation.position_id
                 FROM operations_fulfillment_allocations shipped_allocation
                 JOIN operations_order_lines shipped_line
                   ON shipped_line.organization_id = shipped_allocation.organization_id
                  AND shipped_line.id = shipped_allocation.order_line_id
                 WHERE shipped_line.organization_id = orders.organization_id
                   AND shipped_line.order_id = orders.id
               )) AS ship_ledger_entries
     FROM operations_orders orders
     JOIN operations_order_lines line
       ON line.organization_id = orders.organization_id
      AND line.order_id = orders.id
     JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = line.organization_id
      AND allocation.order_line_id = line.id
     JOIN operations_inventory_positions position
       ON position.organization_id = allocation.organization_id
      AND position.id = allocation.position_id
     WHERE orders.organization_id = $1::uuid
       AND orders.global_id = $2
     GROUP BY orders.id`,
    [fixture.organizationId, orderGlobalId],
  )
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

async function expectRejected(work, predicate, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, message)
  assert.ok(predicate(error), `${message}: ${String(error?.message || error)}`)
}

async function verifyShipmentCompletion(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    query_timeout: 20_000,
  })
  try {
    const postgres = postgresMock(pool)
    const auditWriter = auditWriterMock()
    const sandboxCommerceE2e = loadTypeScriptModule(
      'app_src/lib/operations/sandboxCommerceE2e.ts',
    )
    const sandboxAuthorization = loadTypeScriptModule(
      'app_src/lib/persistence/sandboxCommerceE2eAuthorization.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/operations/sandboxCommerceE2e': sandboxCommerceE2e,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
    const domain = loadTypeScriptModule('app_src/lib/operations/domain.ts')
    const adapters = loadTypeScriptModule('app_src/lib/operations/adapters.ts', {
      mocks: { '@/lib/operations/domain': domain },
    })
    const stableId = loadTypeScriptModule('app_src/lib/crm/stableId.ts')
    const packingSlip = loadTypeScriptModule('app_src/lib/operations/packingSlip.ts')
    const productPackaging = loadTypeScriptModule('app_src/lib/persistence/productPackaging.ts', {
      mocks: {
        '@/lib/auditWriter': auditWriter,
        '@/lib/persistence/postgres': postgres,
      },
    })
    const currency = loadTypeScriptModule('app_src/lib/currency.ts')
    const canonicalPlanning = loadTypeScriptModule(
      'app_src/lib/operations/canonicalFulfillmentPlanning.ts',
      { mocks: { '../currency.ts': currency } },
    )
    const shopifyCheckoutPlanRatePolicy = loadTypeScriptModule(
      'app_src/lib/operations/shopifyCheckoutPlanRatePolicy.ts',
      { mocks: { '../currency.ts': currency } },
    )
    const shopifyCheckoutRateWarmPolicy = loadTypeScriptModule(
      'app_src/lib/operations/shopifyCheckoutRateWarmPolicy.ts',
    )
    const shopifyCheckoutRating = loadTypeScriptModule(
      'app_src/lib/persistence/shopifyCheckoutRating.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/operations/shopifyCheckoutPlanRatePolicy':
            shopifyCheckoutPlanRatePolicy,
          '@/lib/operations/shopifyCheckoutRateWarmPolicy':
            shopifyCheckoutRateWarmPolicy,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
    const persistence = loadTypeScriptModule('app_src/lib/persistence/operations.ts', {
      mocks: {
        '@/lib/auditWriter': auditWriter,
        '@/lib/crm/stableId': stableId,
        '@/lib/integrations/carrierCheckoutRate': {
          rateCheckoutShipment: async () => {
            throw new Error(
              'Shipment completion acceptance does not call checkout rates',
            )
          },
        },
        '@/lib/integrations/carrierIntegrations': {
          testCarrierSandboxShipmentRate: async () => {
            throw new Error(
              'Shipment completion acceptance does not call carrier sandboxes',
            )
          },
        },
        '@/lib/integrations/shopifyFulfillmentWriteback': {
          executeShopifyFulfillmentWriteback: async () => ({
            providerReference: 'shopify-focused-fulfillment-reference',
          }),
        },
        '@/lib/operations/adapters': adapters,
        '@/lib/operations/canonicalFulfillmentPlanning':
          canonicalPlanning,
        '@/lib/operations/domain': domain,
        '@/lib/operations/packingSlip': packingSlip,
        '@/lib/persistence/cartonizationRateEvidence': {
          readCartonizationRateEvidenceByGlobalId: async () => null,
        },
        '@/lib/persistence/crm': {
          stageCrmRecordWithClient: async () => {
            throw new Error('Shipment completion acceptance does not stage CRM records')
          },
        },
        '@/lib/persistence/operationPrintDelivery': {
          enqueueOperationsPrintJobInPostgres: async () => ({
            printJobGlobalId: null,
            printJobStatus: null,
            printWarning: 'No printer configured in focused shipment completion acceptance.',
          }),
        },
        '@/lib/persistence/operationShadowFulfillmentPreparation': {
          readShadowFulfillmentPreparation: async () => null,
        },
        '@/lib/persistence/sandboxCommerceE2eAuthorization': sandboxAuthorization,
        '@/lib/persistence/postgres': postgres,
        '@/lib/persistence/productPackaging': productPackaging,
        '@/lib/persistence/shopifyCheckoutRating': shopifyCheckoutRating,
      },
    })
    assert.equal(
      typeof persistence.confirmOperationsOrderShipmentFromPostgres,
      'function',
      'confirmOperationsOrderShipmentFromPostgres must be exported',
    )
    assert.equal(
      typeof persistence.generateOperationsPackagePackingSlipInPostgres,
      'function',
      'generateOperationsPackagePackingSlipInPostgres must be exported',
    )

    const createFixture = async (scenario, { unitsPerPackage = 2 } = {}) => {
      const fixture = await seedWorkspace(pool, scenario)
      await postgres.withTransaction((client) => (
        productPackaging.upsertProductPackagingProfileWithClient(client, {
          organizationId: fixture.organizationId,
          pipelineId: fixture.pipelineId,
          productId: fixture.product.id,
          actorEmail: fixture.email,
          profile: {
            profileName: `Shipment completion ${scenario} package`,
            packageType: 'carton',
            unitOfMeasure: 'each',
            unitsPerPackage,
            measurementSystem: 'imperial',
            lengthMm: 305,
            widthMm: 229,
            heightMm: 152,
            weightGrams: 1814,
            active: true,
            source: 'manual',
          },
        })
      ))
      return fixture
    }

    const packingListFixture = await createFixture('package-packing-list')
    const packingListOrder = await advanceOrderToPacked(
      persistence,
      packingListFixture,
      'package-packing-list',
    )
    const packingListPackage = await pool.query(
      `SELECT package.global_id,
              count(content.id)::int AS content_count,
              sum(content.quantity)::text AS content_quantity
       FROM operations_orders source_order
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = source_order.organization_id
        AND plan.order_id = source_order.id
       JOIN operations_packages package
         ON package.organization_id = plan.organization_id
        AND package.plan_id = plan.id
       LEFT JOIN operations_package_contents content
         ON content.organization_id = package.organization_id
        AND content.package_id = package.id
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2
       GROUP BY package.id`,
      [packingListFixture.organizationId, packingListOrder.planned.orderGlobalId],
    )
    assert.equal(packingListPackage.rowCount, 1)
    assert.equal(packingListPackage.rows[0].content_count, 1)
    assert.equal(packingListPackage.rows[0].content_quantity, '2.000000')
    const beforePackingList = await orderEvidence(
      pool,
      packingListFixture,
      packingListOrder.planned.orderGlobalId,
    )
    const packingListInput = {
      organizationId: packingListFixture.organizationId,
      actorEmail: packingListFixture.email,
      orderGlobalId: packingListOrder.planned.orderGlobalId,
      packageGlobalId: packingListPackage.rows[0].global_id,
      expectedRowVersion: packingListOrder.packed.rowVersion,
      idempotencyKey: `package-packing-list-${randomUUID()}`,
    }
    const generatedPackingList = (
      await persistence.generateOperationsPackagePackingSlipInPostgres(
        packingListInput,
      )
    )
    assert.equal(generatedPackingList.orderStatus, 'packed')
    assert.equal(generatedPackingList.rowVersion, packingListOrder.packed.rowVersion)
    assert.equal(
      generatedPackingList.packageGlobalId,
      packingListPackage.rows[0].global_id,
    )
    assert.equal(generatedPackingList.documentKind, 'pack_work_instruction')
    assert.equal(
      generatedPackingList.documentStage,
      'pre_label_pack_work_instruction',
    )
    assert.equal(generatedPackingList.finalPackingSlip, false)
    assert.match(generatedPackingList.packingSlipArtifactGlobalId, /^gpf\d{7}$/)
    assert.equal(
      generatedPackingList.contentUrl,
      `/api/operations/artifacts/${generatedPackingList.packingSlipArtifactGlobalId}`,
    )
    assert.equal(generatedPackingList.replayed, false)
    const afterPackingList = await orderEvidence(
      pool,
      packingListFixture,
      packingListOrder.planned.orderGlobalId,
    )
    assert.deepEqual(afterPackingList, {
      ...beforePackingList,
      packing_slips: beforePackingList.packing_slips + 1,
      packing_slip_payloads: beforePackingList.packing_slip_payloads + 1,
    })
    assert.equal(afterPackingList.status, 'packed')
    assert.equal(afterPackingList.shipments, 0)
    assert.equal(afterPackingList.tracking_observations, 0)
    assert.equal(afterPackingList.fulfillment_exports, 0)
    assert.equal(afterPackingList.ship_ledger_entries, 0)
    const packageArtifact = await pool.query(
      `SELECT artifact.source_package_id IS NOT NULL AS has_package,
              artifact.source_shipment_id IS NULL AS has_no_shipment,
              payload.template_version,
              payload.render_snapshot,
              payload.payload
       FROM operations_print_artifacts artifact
       JOIN operations_print_artifact_payloads payload
         ON payload.organization_id = artifact.organization_id
        AND payload.artifact_id = artifact.id
       WHERE artifact.organization_id = $1::uuid
         AND artifact.global_id = $2`,
      [
        packingListFixture.organizationId,
        generatedPackingList.packingSlipArtifactGlobalId,
      ],
    )
    assert.equal(packageArtifact.rowCount, 1)
    assert.equal(packageArtifact.rows[0].has_package, true)
    assert.equal(packageArtifact.rows[0].has_no_shipment, true)
    assert.equal(
      packageArtifact.rows[0].template_version,
      packingSlip.PACKAGE_PACK_WORK_INSTRUCTION_TEMPLATE_VERSION,
    )
    assert.equal(
      packageArtifact.rows[0].render_snapshot.documentKind,
      'pack_work_instruction',
    )
    assert.equal(
      packageArtifact.rows[0].render_snapshot.documentStage,
      'pre_label_pack_work_instruction',
    )
    assert.equal(
      packageArtifact.rows[0].render_snapshot.finalPackingSlip,
      false,
    )
    assert.deepEqual(
      packageArtifact.rows[0].render_snapshot.lines.map((line) => ({
        productGlobalId: line.productGlobalId,
        quantity: line.quantity,
      })),
      [{
        productGlobalId: packingListFixture.product.reference_code,
        quantity: 2,
      }],
    )
    assert.equal(
      packageArtifact.rows[0].payload.subarray(0, 4).toString(),
      '%PDF',
    )
    const replayedPackingList = (
      await persistence.generateOperationsPackagePackingSlipInPostgres(
        packingListInput,
      )
    )
    assert.equal(replayedPackingList.replayed, true)
    assert.equal(
      replayedPackingList.packingSlipArtifactGlobalId,
      generatedPackingList.packingSlipArtifactGlobalId,
    )
    const packageArtifactCount = await pool.query(
      `SELECT count(*)::int AS count
       FROM operations_print_artifacts artifact
       WHERE artifact.organization_id = $1::uuid
         AND artifact.source_package_id = (
           SELECT id
           FROM operations_packages
           WHERE organization_id = $1::uuid
             AND global_id = $2
         )
         AND artifact.source_shipment_id IS NULL
         AND artifact.document_type = 'packing_slip'`,
      [packingListFixture.organizationId, packingListPackage.rows[0].global_id],
    )
    assert.equal(packageArtifactCount.rows[0].count, 1)

    const successFixture = await createFixture('success')
    const successful = await advanceOrderToPacked(persistence, successFixture, 'success')
    const packagingClaim = await addPackagingClaim(
      pool,
      successFixture,
      successful.planned.orderGlobalId,
    )
    const mockLabel = await addActiveLabel(
      pool,
      successFixture,
      successful.planned.orderGlobalId,
      'mock',
    )
    const beforeSuccess = await orderEvidence(
      pool,
      successFixture,
      successful.planned.orderGlobalId,
    )
    assert.equal(beforeSuccess.on_hand_quantity, '12.000000')
    assert.equal(beforeSuccess.reserved_quantity, '2.000000')
    assert.deepEqual(
      await packagingClaimEvidence(pool, successFixture, packagingClaim),
      {
        status: 'active',
        consumed: false,
        released: false,
        on_hand_quantity: 3,
        row_version: packagingClaim.stock.row_version,
      },
    )
    const successInput = {
      organizationId: successFixture.organizationId,
      actorEmail: successFixture.email,
      orderGlobalId: successful.planned.orderGlobalId,
      expectedRowVersion: successful.packed.rowVersion,
      reason: 'Confirm mock shipment in focused acceptance',
      idempotencyKey: `confirm-success-${randomUUID()}`,
    }
    const confirmed = await persistence.confirmOperationsOrderShipmentFromPostgres(successInput)
    assert.equal(confirmed.orderGlobalId, successful.planned.orderGlobalId)
    assert.equal(confirmed.orderStatus, 'shipped')
    assert.equal(confirmed.rowVersion, successful.packed.rowVersion + 1)
    assert.equal(confirmed.replayed, false)

    const afterSuccess = await orderEvidence(
      pool,
      successFixture,
      successful.planned.orderGlobalId,
    )
    assert.deepEqual(afterSuccess, {
      status: 'shipped',
      row_version: successful.packed.rowVersion + 1,
      on_hand_quantity: '10.000000',
      reserved_quantity: '0.000000',
      consumed_reservations: 1,
      shipments: 1,
      packing_slips: 1,
      packing_slip_payloads: 1,
      tracking_observations: 1,
      fulfillment_exports: 1,
      ship_ledger_entries: 1,
    })
    const consumedPackaging = await packagingClaimEvidence(
      pool,
      successFixture,
      packagingClaim,
    )
    assert.deepEqual(consumedPackaging, {
      status: 'consumed',
      consumed: true,
      released: false,
      on_hand_quantity: 2,
      row_version: String(Number(packagingClaim.stock.row_version) + 1),
    })
    const shipment = await pool.query(
      `SELECT shipment.global_id, shipment.tracking_number
       FROM operations_shipments shipment
       JOIN operations_orders orders
         ON orders.organization_id = shipment.organization_id
        AND orders.id = shipment.order_id
       WHERE orders.organization_id = $1::uuid
         AND orders.global_id = $2`,
      [successFixture.organizationId, successful.planned.orderGlobalId],
    )
    assert.equal(shipment.rowCount, 1)
    assert.match(shipment.rows[0].global_id, /^gsh\d{7}$/)
    assert.equal(shipment.rows[0].tracking_number, mockLabel.trackingNumber)
    const artifact = await pool.query(
      `SELECT artifact.global_id,
              artifact.source_shipment_id IS NOT NULL AS has_shipment,
              artifact.format,
              artifact.media_size,
              payload.mime_type,
              payload.filename,
              payload.template_version,
              payload.payload
       FROM operations_print_artifacts artifact
       JOIN operations_print_artifact_payloads payload
         ON payload.organization_id = artifact.organization_id
        AND payload.artifact_id = artifact.id
       JOIN operations_orders orders
         ON orders.organization_id = artifact.organization_id
        AND orders.id = artifact.source_order_id
      WHERE orders.organization_id = $1::uuid
         AND orders.global_id = $2
         AND artifact.document_type = 'packing_slip'`,
      [successFixture.organizationId, successful.planned.orderGlobalId],
    )
    assert.equal(artifact.rowCount, 1)
    assert.match(artifact.rows[0].global_id, /^gpf\d{7}$/)
    assert.equal(artifact.rows[0].has_shipment, true)
    assert.equal(artifact.rows[0].format, 'PDF')
    assert.equal(artifact.rows[0].media_size, 'letter')
    assert.equal(artifact.rows[0].mime_type, 'application/pdf')
    assert.match(artifact.rows[0].filename, /\.pdf$/)
    assert.ok(artifact.rows[0].template_version)
    assert.equal(artifact.rows[0].payload.subarray(0, 4).toString(), '%PDF')
    const observation = await pool.query(
      `SELECT observation.global_id, observation.status, observation.source
       FROM operations_tracking_observations observation
       JOIN operations_shipments shipment
         ON shipment.organization_id = observation.organization_id
        AND shipment.id = observation.shipment_id
       JOIN operations_orders orders
         ON orders.organization_id = shipment.organization_id
        AND orders.id = shipment.order_id
       WHERE orders.organization_id = $1::uuid
         AND orders.global_id = $2`,
      [successFixture.organizationId, successful.planned.orderGlobalId],
    )
    assert.deepEqual(observation.rows.map((row) => ({
      globalId: row.global_id,
      status: row.status,
      source: row.source,
    })), [{
      globalId: observation.rows[0].global_id,
      status: 'confirmed',
      source: 'shipment_confirmation',
    }])
    assert.match(observation.rows[0].global_id, /^gto\d{7}$/)

    const replayed = await persistence.confirmOperationsOrderShipmentFromPostgres(successInput)
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.orderGlobalId, confirmed.orderGlobalId)
    assert.equal(replayed.rowVersion, confirmed.rowVersion)
    const afterReplay = await orderEvidence(
      pool,
      successFixture,
      successful.planned.orderGlobalId,
    )
    assert.deepEqual(afterReplay, afterSuccess)
    assert.deepEqual(
      await packagingClaimEvidence(
        pool,
        successFixture,
        packagingClaim,
      ),
      consumedPackaging,
      'Shipment replay must not consume packaging stock twice',
    )

    const sandboxFixture = await createFixture('sandbox')
    const sandbox = await advanceOrderToPacked(persistence, sandboxFixture, 'sandbox')
    await addActiveLabel(pool, sandboxFixture, sandbox.planned.orderGlobalId, 'sandbox')
    const beforeSandbox = await orderEvidence(
      pool,
      sandboxFixture,
      sandbox.planned.orderGlobalId,
    )
    await expectRejected(
      () => persistence.confirmOperationsOrderShipmentFromPostgres({
        organizationId: sandboxFixture.organizationId,
        actorEmail: sandboxFixture.email,
        orderGlobalId: sandbox.planned.orderGlobalId,
        expectedRowVersion: sandbox.packed.rowVersion,
        reason: 'Sandbox labels may not consume inventory',
        idempotencyKey: `confirm-sandbox-${randomUUID()}`,
      }),
      (error) => (
        /SANDBOX/i.test(`${String(error?.code || '')} ${String(error?.message || '')}`)
        && Number(error?.status || 0) >= 400
      ),
      'Sandbox label confirmation must be rejected',
    )
    const afterSandbox = await orderEvidence(
      pool,
      sandboxFixture,
      sandbox.planned.orderGlobalId,
    )
    assert.deepEqual(afterSandbox, beforeSandbox)
    assert.equal(afterSandbox.status, 'packed')
    assert.equal(afterSandbox.on_hand_quantity, '12.000000')
    assert.equal(afterSandbox.reserved_quantity, '2.000000')

    const authorizedFixture = await createFixture(
      'authorized-multi-package-sandbox',
      { unitsPerPackage: 1 },
    )
    const authorized = await advanceOrderToPacked(
      persistence,
      authorizedFixture,
      'authorized-multi-package-sandbox',
    )
    await splitPackedOrderIntoTwoPackagesForFixture(
      pool,
      authorizedFixture,
      authorized.planned.orderGlobalId,
    )
    const authorizedPackagingClaim = await addPackagingClaim(
      pool,
      authorizedFixture,
      authorized.planned.orderGlobalId,
    )
    const authorizedTrackingNumbers = await addSandboxLabelsForAllPackages(
      pool,
      authorizedFixture,
      authorized.planned.orderGlobalId,
    )
    await pool.query(
      `UPDATE operations_orders
       SET source_provider = 'shopify'
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [authorizedFixture.organizationId, authorized.planned.orderGlobalId],
    )
    await assert.rejects(
      () => pool.query(
        `UPDATE operations_activation_scopes
         SET state = 'active', revision = revision + 1,
             reason = 'Reject unauthorized sandbox plan',
             updated_by = $2, updated_at = now()
         WHERE organization_id = $1::uuid`,
        [authorizedFixture.organizationId, authorizedFixture.email],
      ),
      /Active Operations cannot retain missing or non-production carrier-read plan/,
    )
    const authorization = await sandboxAuthorization.authorizeSandboxCommerceE2eInPostgres({
      organizationId: authorizedFixture.organizationId,
      actorEmail: authorizedFixture.email,
      orderGlobalId: authorized.planned.orderGlobalId,
      confirmationStatement: sandboxAuthorization.SANDBOX_COMMERCE_E2E_CONFIRMATION,
      reason: 'Authorized multi-package sandbox E2E acceptance',
      lifetimeMinutes: 30,
    })
    assert.equal(authorization.state, 'active')
    assert.match(authorization.authorizationGlobalId, /^gsea\d{7}$/)
    const authorizationReplay = await sandboxAuthorization
      .authorizeSandboxCommerceE2eInPostgres({
        organizationId: authorizedFixture.organizationId,
        actorEmail: authorizedFixture.email,
        orderGlobalId: authorized.planned.orderGlobalId,
        confirmationStatement: sandboxAuthorization.SANDBOX_COMMERCE_E2E_CONFIRMATION,
        reason: 'Authorized multi-package sandbox E2E acceptance',
        lifetimeMinutes: 30,
      })
    assert.equal(
      authorizationReplay.authorizationGlobalId,
      authorization.authorizationGlobalId,
    )
    assert.equal(authorizationReplay.expiresAt, authorization.expiresAt)
    await assert.rejects(
      () => sandboxAuthorization.authorizeSandboxCommerceE2eInPostgres({
        organizationId: authorizedFixture.organizationId,
        actorEmail: authorizedFixture.email,
        orderGlobalId: authorized.planned.orderGlobalId,
        confirmationStatement: sandboxAuthorization.SANDBOX_COMMERCE_E2E_CONFIRMATION,
        reason: 'A different active authorization reason is rejected',
        lifetimeMinutes: 30,
      }),
      (error) => error?.code === 'SANDBOX_E2E_AUTHORIZATION_ALREADY_ACTIVE',
    )
    assert.equal(
      await sandboxAuthorization
        .readActiveSandboxCommerceE2eAuthorizationForOrderInPostgres({
          organizationId: authorizedFixture.organizationId,
          orderGlobalId: authorized.planned.orderGlobalId,
          actorEmail: 'different-operator@example.com',
        }),
      null,
    )
    const authorizationGlobalId = authorization.authorizationGlobalId
    const activationResult = await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'active', revision = revision + 1,
           reason = 'Authorized exact-order sandbox E2E guard acceptance',
           updated_by = $2, updated_at = now()
       WHERE organization_id = $1::uuid
       RETURNING state, revision`,
      [authorizedFixture.organizationId, authorizedFixture.email],
    )
    assert.equal(activationResult.rows[0]?.state, 'active')
    const authorizedWorkspace = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: authorizedFixture.organizationId,
      actorEmail: authorizedFixture.email,
      capabilities: {
        canView: true,
        canManage: true,
        canExecute: true,
        canActivate: true,
      },
      selectedOrderGlobalId: authorized.planned.orderGlobalId,
    })
    assert.equal(
      authorizedWorkspace.selectedOrder?.sandboxCommerceE2eAuthorization
        ?.authorizationGlobalId,
      authorizationGlobalId,
    )
    assert.equal(
      authorizedWorkspace.selectedOrder?.availableActions.find(
        (action) => action.action === 'confirm_shipment',
      )?.enabled,
      true,
    )
    const authorizedInput = {
      organizationId: authorizedFixture.organizationId,
      actorEmail: authorizedFixture.email,
      orderGlobalId: authorized.planned.orderGlobalId,
      expectedRowVersion: authorized.packed.rowVersion,
      reason: 'Authorized multi-package sandbox E2E acceptance',
      idempotencyKey: `confirm-authorized-sandbox-${randomUUID()}`,
      sandboxE2eAuthorizationGlobalId: authorizationGlobalId,
    }
    const authorizedResult = await persistence.confirmOperationsOrderShipmentFromPostgres(
      authorizedInput,
    )
    assert.equal(authorizedResult.orderStatus, 'shipped')
    assert.equal(authorizedResult.replayed, false)
    const authorizedEvidence = await orderEvidence(
      pool,
      authorizedFixture,
      authorized.planned.orderGlobalId,
    )
    assert.deepEqual(authorizedEvidence, {
      status: 'shipped',
      row_version: authorized.packed.rowVersion + 1,
      on_hand_quantity: '10.000000',
      reserved_quantity: '0.000000',
      consumed_reservations: 1,
      shipments: 2,
      packing_slips: 2,
      packing_slip_payloads: 2,
      tracking_observations: 2,
      fulfillment_exports: 1,
      ship_ledger_entries: 1,
    })
    const persistedTracking = await pool.query(
      `SELECT shipment.tracking_number
       FROM operations_shipments shipment
       JOIN operations_orders orders
         ON orders.organization_id = shipment.organization_id
        AND orders.id = shipment.order_id
       WHERE orders.organization_id = $1::uuid
         AND orders.global_id = $2
       ORDER BY shipment.tracking_number`,
      [authorizedFixture.organizationId, authorized.planned.orderGlobalId],
    )
    assert.deepEqual(
      persistedTracking.rows.map((row) => row.tracking_number),
      [...authorizedTrackingNumbers].sort(),
    )
    assert.deepEqual(
      await packagingClaimEvidence(
        pool,
        authorizedFixture,
        authorizedPackagingClaim,
      ),
      {
        status: 'consumed',
        consumed: true,
        released: false,
        on_hand_quantity: 2,
        row_version: String(Number(authorizedPackagingClaim.stock.row_version) + 1),
      },
    )
    const consumedAuthorization = await sandboxAuthorization
      .readSandboxCommerceE2eAuthorizationInPostgres({
        organizationId: authorizedFixture.organizationId,
        authorizationGlobalId,
      })
    assert.equal(consumedAuthorization.state, 'consumed')
    assert.equal(consumedAuthorization.consumedBy, authorizedFixture.email)
    const fulfilledPlan = await pool.query(
      `SELECT plan.status
       FROM operations_fulfillment_plans plan
       JOIN operations_orders source_order
         ON source_order.organization_id = plan.organization_id
        AND source_order.id = plan.order_id
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2
       ORDER BY plan.version_number DESC
       LIMIT 1`,
      [authorizedFixture.organizationId, authorized.planned.orderGlobalId],
    )
    assert.equal(fulfilledPlan.rows[0]?.status, 'fulfilled')
    const consumedWorkspace = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: authorizedFixture.organizationId,
      actorEmail: authorizedFixture.email,
      capabilities: {
        canView: true,
        canManage: true,
        canExecute: true,
        canActivate: true,
      },
      selectedOrderGlobalId: authorized.planned.orderGlobalId,
    })
    assert.equal(
      consumedWorkspace.selectedOrder?.sandboxCommerceE2eAuthorization,
      null,
    )
    const authorizedReplay = await persistence.confirmOperationsOrderShipmentFromPostgres(
      authorizedInput,
    )
    assert.equal(authorizedReplay.replayed, true)
    assert.deepEqual(
      await orderEvidence(
        pool,
        authorizedFixture,
        authorized.planned.orderGlobalId,
      ),
      authorizedEvidence,
    )
    const replayedAuthorization = await sandboxAuthorization
      .readSandboxCommerceE2eAuthorizationInPostgres({
        organizationId: authorizedFixture.organizationId,
        authorizationGlobalId,
      })
    assert.equal(replayedAuthorization.state, 'consumed')
    assert.equal(replayedAuthorization.consumedAt, consumedAuthorization.consumedAt)

    const staleFixture = await createFixture('stale')
    const stale = await advanceOrderToPacked(persistence, staleFixture, 'stale')
    await addActiveLabel(pool, staleFixture, stale.planned.orderGlobalId, 'mock')
    const beforeStale = await orderEvidence(pool, staleFixture, stale.planned.orderGlobalId)
    await expectRejected(
      () => persistence.confirmOperationsOrderShipmentFromPostgres({
        organizationId: staleFixture.organizationId,
        actorEmail: staleFixture.email,
        orderGlobalId: stale.planned.orderGlobalId,
        expectedRowVersion: stale.packed.rowVersion - 1,
        reason: 'Stale row version must not consume inventory',
        idempotencyKey: `confirm-stale-${randomUUID()}`,
      }),
      (error) => error?.code === 'OPERATIONS_ORDER_VERSION_CONFLICT',
      'Stale row version shipment confirmation must be rejected',
    )
    const afterStale = await orderEvidence(pool, staleFixture, stale.planned.orderGlobalId)
    assert.deepEqual(afterStale, beforeStale)
    assert.equal(afterStale.status, 'packed')
    assert.equal(afterStale.on_hand_quantity, '12.000000')
    assert.equal(afterStale.reserved_quantity, '2.000000')
  } finally {
    await pool.end()
  }
}

async function main() {
  const migration = read('db/migrations/0099_operations_shipment_completion.sql')
  for (const fragment of [
    'CREATE TABLE IF NOT EXISTS operations_print_artifact_payloads',
    'CREATE TABLE IF NOT EXISTS operations_tracking_observations',
    'CREATE TABLE IF NOT EXISTS operations_commerce_fulfillment_exports',
    'UNIQUE (organization_id, idempotency_key)',
  ]) {
    assert.ok(migration.includes(fragment), `Shipment completion migration is missing ${fragment}`)
  }
  const packageAllocationMigration = read(
    'db/migrations/0121_operations_package_contents.sql',
  )
  for (const fragment of [
    'CREATE TABLE IF NOT EXISTS operations_package_contents',
    'operations_package_contents_package_line_unique',
    'protect_operations_package_content_write',
    'ADD COLUMN IF NOT EXISTS source_package_id uuid',
    'operations_print_artifacts_package_packing_list_unique',
  ]) {
    assert.ok(
      packageAllocationMigration.includes(fragment),
      `Package packing-list migration is missing ${fragment}`,
    )
  }
  const packingSlip = loadTypeScriptModule(
    'app_src/lib/operations/packingSlip.ts',
  )
  const paginated = packingSlip.renderPackagePackWorkInstruction({
    documentKind: 'pack_work_instruction',
    documentStage: 'pre_label_pack_work_instruction',
    finalPackingSlip: false,
    orderGlobalId: 'gor0000001',
    orderNumber: 'PAGINATION-ACCEPTANCE',
    customerName: 'Pagination Customer',
    customerGlobalId: 'ga0000001',
    fulfillmentPlanGlobalId: 'gfp0000001',
    warehouseId: randomUUID(),
    warehouseGlobalId: 'gwh0000001',
    warehouseName: 'Pagination Warehouse',
    packageGlobalId: 'gpa0000001',
    packageNumber: 1,
    packageCount: 1,
    shipTo: {
      name: 'Pagination Customer',
      line1: '100 Packing Lane',
      city: 'Hartford',
      region: 'CT',
      postalCode: '06103',
      country: 'US',
    },
    lines: Array.from({ length: 31 }, (_, index) => ({
      productGlobalId: `gp${String(index + 1).padStart(7, '0')}`,
      productName: `Pagination item ${index + 1}`,
      channelSku: `PAGE-${index + 1}`,
      quantity: index + 1,
    })),
  })
  const paginatedSource = paginated.payload.toString('binary')
  assert.match(
    paginatedSource,
    /\/Count 3/,
    'Thirty-one exact package lines must render across three PDF pages',
  )
  assert.ok(
    paginatedSource.includes('Pagination item 31'),
    'The final exact package line must not be silently truncated',
  )
  assert.ok(
    paginatedSource.includes('Page 3 of 3'),
    'The final package Pack Work Instruction page must be numbered',
  )
  assert.ok(
    paginatedSource.includes('ClawPilot Pack Work Instruction')
      && paginatedSource.includes('PRE-LABEL - NOT A FINAL PACKING SLIP')
      && paginatedSource.includes(
        'Provisional warehouse instruction only. No label, tracking number, or shipment confirmation exists.',
      ),
    'The pre-label document must identify itself as a provisional Pack Work Instruction',
  )
  assert.equal(
    paginated.templateVersion,
    'pack-work-instruction-package-letter-v1',
  )
  assert.match(
    paginated.filename,
    /-pack-work-instruction\.pdf$/,
  )
  const shipmentPackingSlip = packingSlip.renderPackingSlip({
    orderGlobalId: 'gor0000001',
    orderNumber: 'SHIPMENT-PAGINATION',
    customerName: 'Pagination Customer',
    customerGlobalId: 'ga0000001',
    shipmentGlobalId: 'gsh0000001',
    trackingNumber: 'TRACKING-PAGINATION',
    carrier: 'test',
    serviceCode: 'ground',
    shippedAt: '2026-07-27T00:00:00.000Z',
    shipTo: {
      name: 'Pagination Customer',
      line1: '100 Packing Lane',
      city: 'Hartford',
      region: 'CT',
      postalCode: '06103',
      country: 'US',
    },
    lines: Array.from({ length: 31 }, (_, index) => ({
      productGlobalId: `gp${String(index + 1).padStart(7, '0')}`,
      productName: `Shipment item ${index + 1}`,
      channelSku: `SHIP-PAGE-${index + 1}`,
      quantity: index + 1,
    })),
  })
  const shipmentPackingSource = shipmentPackingSlip.payload.toString('binary')
  assert.equal(
    shipmentPackingSlip.templateVersion,
    'packing-slip-letter-v2',
  )
  assert.match(
    shipmentPackingSource,
    /\/Count 3/,
    'Thirty-one shipment lines must render across three PDF pages',
  )
  assert.ok(
    shipmentPackingSource.includes('Shipment item 31'),
    'The final shipment packing-slip line must not be silently truncated',
  )
  assert.ok(
    shipmentPackingSource.includes('Page 3 of 3'),
    'The final shipment packing-slip page must be numbered',
  )
  assert.ok(
    shipmentPackingSource.includes('ClawPilot Packing Slip'),
    'The tracking-bound final shipment document must remain a packing slip',
  )
  assert.ok(
    !shipmentPackingSource.includes('Pack Work Instruction'),
    'The tracking-bound final packing slip must not be relabeled as a work instruction',
  )

  if (contractsOnly) {
    console.log('Operations shipment document contracts passed')
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-shipment-completion-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_shipment_completion',
      '-e', 'POSTGRES_DB=clawpilot_shipment_completion',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(port > 0, `Unable to resolve disposable PostgreSQL port from ${portOutput}`)
    const databaseUrl = (
      `postgresql://postgres:clawpilot_shipment_completion@127.0.0.1:${port}`
      + '/clawpilot_shipment_completion'
    )
    await waitForPostgres(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    await verifyShipmentCompletion(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Operations shipment completion disposable-PostgreSQL acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
