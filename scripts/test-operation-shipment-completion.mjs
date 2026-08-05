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

async function addSandboxLabelsForAllPackages(
  pool,
  fixture,
  orderGlobalId,
  environment = 'sandbox',
) {
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
    const trackingNumber = `${environment.toUpperCase()}E2E${index + 1}${randomUUID()
      .replaceAll('-', '').slice(0, 16).toUpperCase()}`
    await pool.query(
      `INSERT INTO operations_labels (
         organization_id, package_id, carrier_rate_id, carrier, service_code,
         tracking_number, format, label_payload, provider_label_id,
         idempotency_key, status, environment, redacted_provider_evidence
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         $6, 'PDF', $7, $8, $9, 'created', $10, $11::jsonb
       )`,
      [
        fixture.organizationId, row.package_id, row.rate_id, row.carrier,
        row.service_code, trackingNumber,
        Buffer.from(`%PDF-1.4 sandbox E2E package ${index + 1}`).toString('base64'),
        `sandbox-e2e-provider-${randomUUID()}`,
        `sandbox-e2e-label-${randomUUID()}`,
        environment,
        JSON.stringify({ environment, packageGlobalId: row.package_global_id }),
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
    const fulfillmentNotificationPolicy = loadTypeScriptModule(
      'app_src/lib/persistence/shopifyFulfillmentNotifications.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
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
    const commerceFulfillmentRecoveryPolicy = loadTypeScriptModule(
      'app_src/lib/commerceFulfillmentRecoveryPolicy.ts',
    )
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
    let shopifyFulfillmentPreparationCalls = 0
    let shopifyFulfillmentPreparationHook = null
    const shopifyFulfillmentInputs = []
    let shopifyFulfillmentExecutionCalls = 0
    let shopifyFulfillmentReconciliationCalls = 0
    let shopifyFulfillmentReconciliationResult = null
    let faireFulfillmentPreparationCalls = 0
    let faireFulfillmentAuthorizationRevision = 4
    let faireFulfillmentExecutionCalls = 0
    const faireFulfillmentInputs = []
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
          prepareShopifyFulfillmentWriteback: async (input) => {
            shopifyFulfillmentPreparationCalls += 1
            shopifyFulfillmentInputs.push(JSON.parse(JSON.stringify(input)))
            if (shopifyFulfillmentPreparationHook) {
              await shopifyFulfillmentPreparationHook(input)
            }
            const lineItems = Array.isArray(input.expectedLineItems)
              ? input.expectedLineItems.map((line) => ({
                  lineItemId: String(line.externalLineId || line.lineItemId),
                  quantity: Number(line.quantity),
                }))
              : []
            return {
              signature: {
                version: 1,
                externalOrderId: input.externalOrderId,
                fulfillmentOrders: [{
                  fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/456',
                  locationId: 'gid://shopify/Location/321',
                  lineItems: lineItems.map((line, index) => ({
                    fulfillmentOrderLineItemId:
                      `gid://shopify/FulfillmentOrderLineItem/${789 + index}`,
                    lineItemId: line.lineItemId,
                    quantity: line.quantity,
                  })),
                }],
                lineItems,
                carrier: input.carrier,
                trackingNumbers: input.trackingNumbers,
                notifyCustomer: input.notifyCustomer,
              },
              existing: null,
            }
          },
          executeShopifyFulfillmentWriteback: async () => {
            shopifyFulfillmentExecutionCalls += 1
            return {
              providerReference: 'shopify-focused-fulfillment-reference',
            }
          },
          reconcileShopifyFulfillmentWriteback: async () => {
            shopifyFulfillmentReconciliationCalls += 1
            return shopifyFulfillmentReconciliationResult
          },
        },
        '@/lib/integrations/faireFulfillmentRuntime': {
          prepareCurrentFaireFulfillmentAuthority: async () => {
            faireFulfillmentPreparationCalls += 1
            return {
              authorizationRevision: faireFulfillmentAuthorizationRevision,
              credentialGeneration: 2,
              externalAccountId: 'b_faire-shipment-acceptance',
            }
          },
          executeCurrentFaireFulfillmentWriteback: async (input) => {
            faireFulfillmentExecutionCalls += 1
            faireFulfillmentInputs.push(JSON.parse(JSON.stringify(input)))
            return {
              outcome: 'succeeded',
              writeAttempt: { ...input.writeAttempt, state: 'succeeded' },
              providerOrderId: input.externalOrderId,
              providerState: 'PRE_TRANSIT',
              providerShipmentReferences: input.packages.map(
                (_item, index) => `s_faireacceptance${index + 1}`,
              ),
              trackingCodes: input.packages.map(
                (item) => item.trackingCode,
              ),
              replayed: input.mode === 'reconcile_unknown',
              reconciledUnknownOutcome: input.mode === 'reconcile_unknown',
            }
          },
        },
        '@/lib/commerceFulfillmentRecoveryPolicy':
          commerceFulfillmentRecoveryPolicy,
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
            printJobGlobalId: 'gpj1234567',
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
    const commerceFulfillmentRecovery = loadTypeScriptModule(
      'app_src/lib/persistence/commerceFulfillmentRecovery.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
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

    const createShopifyShipmentFixture = async (
      scenario,
      { notifyCustomerDefault = false } = {},
    ) => {
      const fixture = await createFixture(scenario)
      const order = await advanceOrderToPacked(persistence, fixture, scenario)
      await addPackagingClaim(pool, fixture, order.planned.orderGlobalId)
      await addActiveLabel(pool, fixture, order.planned.orderGlobalId, 'mock')
      const account = await pool.query(
        `UPDATE operations_integration_accounts integration
         SET provider = 'shopify', integration_type = 'commerce',
             environment = 'sandbox',
             external_account_id = $3,
             display_name = $4,
             configuration = jsonb_build_object('shopDomain', $5::text),
             updated_by = $6, updated_at = now()
         FROM operations_orders source_order
         WHERE source_order.organization_id = $1::uuid
           AND source_order.global_id = $2
           AND integration.organization_id = source_order.organization_id
           AND integration.id = source_order.integration_account_id
         RETURNING integration.id::text, integration.global_id`,
        [
          fixture.organizationId,
          order.planned.orderGlobalId,
          `gid://shopify/Shop/${randomUUID()}`,
          `Shopify notification ${scenario}`,
          `${scenario}.myshopify.com`,
          fixture.email,
        ],
      )
      assert.equal(account.rowCount, 1)
      await pool.query(
        `UPDATE operations_orders
         SET source_provider = 'shopify',
             external_order_id = $3, updated_by = $4, updated_at = now()
         WHERE organization_id = $1::uuid AND global_id = $2`,
        [
          fixture.organizationId,
          order.planned.orderGlobalId,
          `gid://shopify/Order/${randomUUID()}`,
          fixture.email,
        ],
      )
      await postgres.withTransaction((client) => (
        fulfillmentNotificationPolicy
          .ensureShopifyFulfillmentNotificationPolicyWithClient(client, {
            organizationId: fixture.organizationId,
            integrationAccountId: account.rows[0].id,
            actorEmail: fixture.email,
          })
      ))
      let revision = 1
      if (notifyCustomerDefault) {
        const enabled = await fulfillmentNotificationPolicy
          .updateShopifyFulfillmentNotificationPolicyInPostgres({
            organizationId: fixture.organizationId,
            accountGlobalId: account.rows[0].global_id,
            actorEmail: fixture.email,
            expectedRevision: revision,
            notifyCustomerDefault: true,
            reason: `Enable the ${scenario} Shopify notification acceptance default`,
          })
        revision = enabled.revision
      }
      return {
        fixture,
        order,
        account: account.rows[0],
        revision,
      }
    }

    const policyFixture = await seedWorkspace(pool, 'notification-policy')
    const shopifyAccount = await pool.query(
      `INSERT INTO operations_integration_accounts (
         organization_id, provider, integration_type, environment,
         external_account_id, display_name, configuration, created_by, updated_by
       ) VALUES (
         $1::uuid, 'shopify', 'commerce', 'sandbox',
         'gid://shopify/Shop/6567', 'Policy acceptance Shopify',
         '{"shopDomain":"policy-acceptance.myshopify.com"}'::jsonb, $2, $2
       ) RETURNING id::text, global_id`,
      [policyFixture.organizationId, policyFixture.email],
    )
    await postgres.withTransaction((client) => (
      fulfillmentNotificationPolicy
        .ensureShopifyFulfillmentNotificationPolicyWithClient(client, {
          organizationId: policyFixture.organizationId,
          integrationAccountId: shopifyAccount.rows[0].id,
          actorEmail: policyFixture.email,
        })
    ))
    const safePolicy = await pool.query(
      `SELECT notify_customer_default, revision::text
       FROM operations_shopify_fulfillment_notification_policies
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [policyFixture.organizationId, shopifyAccount.rows[0].id],
    )
    assert.deepEqual(safePolicy.rows[0], {
      notify_customer_default: false,
      revision: '1',
    })
    const enabledPolicy = await fulfillmentNotificationPolicy
      .updateShopifyFulfillmentNotificationPolicyInPostgres({
        organizationId: policyFixture.organizationId,
        accountGlobalId: shopifyAccount.rows[0].global_id,
        actorEmail: policyFixture.email,
        expectedRevision: 1,
        notifyCustomerDefault: true,
        reason: 'Enable customer notifications for future acceptance shipments',
      })
    assert.equal(enabledPolicy.notifyCustomerDefault, true)
    assert.equal(enabledPolicy.revision, 2)
    await assert.rejects(
      () => fulfillmentNotificationPolicy
        .updateShopifyFulfillmentNotificationPolicyInPostgres({
          organizationId: policyFixture.organizationId,
          accountGlobalId: shopifyAccount.rows[0].global_id,
          actorEmail: policyFixture.email,
          expectedRevision: 1,
          notifyCustomerDefault: false,
          reason: 'Reject a stale policy revision during acceptance',
        }),
      (error) => error?.code === 'SHOPIFY_FULFILLMENT_NOTIFICATION_REVISION_CONFLICT',
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = '{"shopDomain":"reconnected.myshopify.com"}'::jsonb
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [policyFixture.organizationId, shopifyAccount.rows[0].id],
    )
    const preservedPolicy = await pool.query(
      `SELECT notify_customer_default, revision::text
       FROM operations_shopify_fulfillment_notification_policies
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [policyFixture.organizationId, shopifyAccount.rows[0].id],
    )
    assert.deepEqual(preservedPolicy.rows[0], {
      notify_customer_default: true,
      revision: '2',
    })
    const faireAccount = await pool.query(
      `INSERT INTO operations_integration_accounts (
         organization_id, provider, integration_type, environment,
         external_account_id, display_name, configuration, created_by, updated_by
       ) VALUES (
         $1::uuid, 'faire', 'commerce', 'production',
         'faire-policy-acceptance', 'Policy acceptance Faire', '{}'::jsonb, $2, $2
       ) RETURNING id::text`,
      [policyFixture.organizationId, policyFixture.email],
    )
    await assert.rejects(
      () => pool.query(
        `INSERT INTO operations_shopify_fulfillment_notification_policies (
           organization_id, integration_account_id, notify_customer_default,
           revision, change_reason, created_by, updated_by
         ) VALUES ($1::uuid, $2::uuid, false, 1,
           'This invalid Faire policy must be rejected', $3, $3)`,
        [policyFixture.organizationId, faireAccount.rows[0].id, policyFixture.email],
      ),
      /Shopify-commerce-only/,
    )

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
    assert.match(generatedPackingList.packingSlipArtifactGlobalId, /^gpf[0-9a-v]{12}$/)
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
    assert.deepEqual(JSON.parse(JSON.stringify(confirmed.customerNotification)), {
      mode: 'clawpilot_explicit',
      notifyCustomer: false,
      source: 'legacy_safe_default',
      accountPolicyRevision: null,
      overrideReason: null,
      decidedBy: successFixture.email,
    })

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
    assert.match(shipment.rows[0].global_id, /^gsh[0-9a-v]{12}$/)
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
    assert.match(artifact.rows[0].global_id, /^gpf[0-9a-v]{12}$/)
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
    assert.match(observation.rows[0].global_id, /^gto[0-9a-v]{12}$/)

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
    const strandedExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, payload_snapshot, idempotency_key
       )
       SELECT organization_id, order_id, shipment_id, provider, external_order_id,
              'queued', payload_snapshot - 'customerNotification',
              idempotency_key || ':stranded-acceptance'
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id`,
      [successFixture.organizationId, confirmed.commerceExportGlobalId],
    )
    const exportCountBeforeRetry = await pool.query(
      `SELECT count(*)::int AS count
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid`,
      [successFixture.organizationId],
    )
    const retriedExport = await persistence
      .retryOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: successFixture.organizationId,
        actorEmail: successFixture.email,
        commerceExportGlobalId: strandedExport.rows[0].global_id,
        reason: 'Recover the stranded immutable export in focused acceptance',
        idempotencyKey: `retry-stranded-export-${randomUUID()}`,
      })
    assert.equal(retriedExport.state, 'succeeded')
    assert.equal(retriedExport.replayed, false)
    assert.equal(retriedExport.customerNotification.notifyCustomer, false)
    assert.equal(
      retriedExport.customerNotification.source,
      'legacy_safe_default',
    )
    const exportCountAfterRetry = await pool.query(
      `SELECT count(*)::int AS count
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid`,
      [successFixture.organizationId],
    )
    assert.equal(
      exportCountAfterRetry.rows[0].count,
      exportCountBeforeRetry.rows[0].count,
      'Retry must reuse the same export rather than creating another row',
    )
    const retriedExportEvidence = await pool.query(
      `SELECT state, attempts
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [successFixture.organizationId, strandedExport.rows[0].global_id],
    )
    assert.deepEqual(retriedExportEvidence.rows[0], {
      state: 'succeeded',
      attempts: 1,
    })

    const faireFixture = await createFixture(
      'faire-export-writeback',
      { unitsPerPackage: 1 },
    )
    const faireOrder = await advanceOrderToPacked(
      persistence,
      faireFixture,
      'faire-export-writeback',
    )
    await splitPackedOrderIntoTwoPackagesForFixture(
      pool,
      faireFixture,
      faireOrder.planned.orderGlobalId,
    )
    await addPackagingClaim(
      pool,
      faireFixture,
      faireOrder.planned.orderGlobalId,
    )
    const faireTrackingNumbers = await addSandboxLabelsForAllPackages(
      pool,
      faireFixture,
      faireOrder.planned.orderGlobalId,
      'mock',
    )
    await pool.query(
      `UPDATE operations_integration_accounts integration
       SET provider = 'faire', environment = 'production',
           external_account_id = 'b_faire-shipment-acceptance',
           configuration = '{}'::jsonb
       FROM operations_orders source_order
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2
         AND integration.organization_id = source_order.organization_id
         AND integration.id = source_order.integration_account_id`,
      [faireFixture.organizationId, faireOrder.planned.orderGlobalId],
    )
    await pool.query(
      `UPDATE operations_orders
       SET source_provider = 'faire',
           external_order_id = 'bo_faire_shipment_acceptance'
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [faireFixture.organizationId, faireOrder.planned.orderGlobalId],
    )
    await expectRejected(
      () => persistence.confirmOperationsOrderShipmentFromPostgres({
        organizationId: faireFixture.organizationId,
        actorEmail: faireFixture.email,
        orderGlobalId: faireOrder.planned.orderGlobalId,
        expectedRowVersion: faireOrder.packed.rowVersion,
        reason: 'Reject mock carrier tracking before a Faire provider write',
        idempotencyKey: `reject-faire-mock-labels-${randomUUID()}`,
      }),
      (error) => error?.code === 'OPERATIONS_FAIRE_PRODUCTION_LABEL_REQUIRED',
      'Faire fulfillment must never publish mock or sandbox tracking',
    )
    assert.equal(faireTrackingNumbers.length, 2)
    assert.equal(faireFulfillmentPreparationCalls, 0)
    assert.equal(faireFulfillmentExecutionCalls, 0)
    assert.equal(faireFulfillmentInputs.length, 0)

    // Exact Faire candidate/pack/package authority is exercised by the
    // commerce-intake disposable-PostgreSQL acceptance. This focused fixture
    // starts at the already-validated authorization boundary so the existing
    // shipment transaction, one-use consumption, and Faire export cannot
    // regress back to rejecting authorized sandbox labels.
    await pool.query(
      `UPDATE operations_labels label
       SET environment = 'sandbox'
       FROM operations_packages package,
            operations_fulfillment_plans plan,
            operations_orders source_order
       WHERE label.organization_id = $1::uuid
         AND label.organization_id = package.organization_id
         AND label.package_id = package.id
         AND package.organization_id = plan.organization_id
         AND package.plan_id = plan.id
         AND plan.organization_id = source_order.organization_id
         AND plan.order_id = source_order.id
         AND source_order.global_id = $2`,
      [faireFixture.organizationId, faireOrder.planned.orderGlobalId],
    )
    const faireSandboxAuthorization = await pool.query(
      `INSERT INTO operations_sandbox_commerce_e2e_authorizations (
         organization_id, order_id, external_order_id,
         confirmation_statement_version, confirmation_hash, reason,
         authorized_by, expires_at
       )
       SELECT source_order.organization_id, source_order.id,
              source_order.external_order_id,
              'sandbox-commerce-e2e-v1', repeat('a', 64),
              'Focused post-validation Faire sandbox shipment acceptance',
              $3, now() + interval '30 minutes'
       FROM operations_orders source_order
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2
       RETURNING id::text, global_id`,
      [
        faireFixture.organizationId,
        faireOrder.planned.orderGlobalId,
        faireFixture.email,
      ],
    )
    assert.equal(faireSandboxAuthorization.rowCount, 1)
    const originalRequireSandboxAuthorization =
      sandboxAuthorization.requireActiveSandboxCommerceE2eAuthorization
    const originalConsumeSandboxAuthorization =
      sandboxAuthorization.consumeSandboxCommerceE2eAuthorization
    const requireValidatedFaireSandboxAuthorization = async (client, input) => {
      const result = await client.query(
        `SELECT sandbox_auth.id::text, sandbox_auth.organization_id::text,
                sandbox_auth.order_id::text, sandbox_auth.authorized_by
         FROM operations_sandbox_commerce_e2e_authorizations sandbox_auth
         JOIN operations_orders source_order
           ON source_order.organization_id = sandbox_auth.organization_id
          AND source_order.id = sandbox_auth.order_id
         WHERE sandbox_auth.organization_id = $1::uuid
           AND sandbox_auth.global_id = $2
           AND source_order.global_id = $3
           AND sandbox_auth.authorized_by = $4
           AND sandbox_auth.state = 'active'
           AND sandbox_auth.expires_at > now()
           AND sandbox_auth.external_order_id = source_order.external_order_id
           AND source_order.source_provider = 'faire'
         FOR UPDATE OF sandbox_auth`,
        [
          input.organizationId,
          input.authorizationGlobalId,
          input.orderGlobalId,
          input.actorEmail,
        ],
      )
      if (result.rowCount !== 1) {
        const error = new Error(
          'Exact actor/order active sandbox E2E authorization is required',
        )
        error.code = 'SANDBOX_E2E_AUTHORIZATION_REQUIRED'
        error.status = 403
        throw error
      }
      return result.rows[0]
    }
    sandboxAuthorization.requireActiveSandboxCommerceE2eAuthorization =
      requireValidatedFaireSandboxAuthorization
    sandboxAuthorization.consumeSandboxCommerceE2eAuthorization = async (
      client,
      input,
    ) => {
      const authorizationRow =
        await requireValidatedFaireSandboxAuthorization(client, input)
      const consumed = await client.query(
        `UPDATE operations_sandbox_commerce_e2e_authorizations
         SET state = 'consumed', consumed_at = now(), consumed_by = $3
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND state = 'active'
         RETURNING id`,
        [input.organizationId, authorizationRow.id, input.actorEmail],
      )
      assert.equal(consumed.rowCount, 1)
      return consumed.rows[0]
    }
    let authorizedFaireResult
    try {
      authorizedFaireResult =
        await persistence.confirmOperationsOrderShipmentFromPostgres({
          organizationId: faireFixture.organizationId,
          actorEmail: faireFixture.email,
          orderGlobalId: faireOrder.planned.orderGlobalId,
          expectedRowVersion: faireOrder.packed.rowVersion,
          reason: 'Confirm authorized Faire sandbox shipment and writeback',
          idempotencyKey: `confirm-authorized-faire-sandbox-${randomUUID()}`,
          sandboxE2eAuthorizationGlobalId:
            faireSandboxAuthorization.rows[0].global_id,
        })
    } finally {
      sandboxAuthorization.requireActiveSandboxCommerceE2eAuthorization =
        originalRequireSandboxAuthorization
      sandboxAuthorization.consumeSandboxCommerceE2eAuthorization =
        originalConsumeSandboxAuthorization
    }
    assert.equal(authorizedFaireResult.orderStatus, 'shipped')
    assert.equal(authorizedFaireResult.commerceExportState, 'succeeded')
    assert.equal(faireFulfillmentPreparationCalls, 1)
    assert.equal(faireFulfillmentExecutionCalls, 1)
    assert.equal(faireFulfillmentInputs.length, 1)
    assert.deepEqual(
      [...faireFulfillmentInputs[0].packages]
        .map((item) => item.trackingCode)
        .sort(),
      [...faireTrackingNumbers].sort(),
    )
    assert.ok(
      faireFulfillmentInputs[0].packages.every((item) => (
        item.makerCost?.amountMinor === 0
        && item.makerCost?.currency === 'USD'
      )),
      'Authorized sandbox Faire fulfillment must publish an explicit zero maker cost',
    )
    const consumedFaireAuthorization = await pool.query(
      `SELECT state, consumed_by
       FROM operations_sandbox_commerce_e2e_authorizations
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [
        faireFixture.organizationId,
        faireSandboxAuthorization.rows[0].global_id,
      ],
    )
    assert.deepEqual(consumedFaireAuthorization.rows[0], {
      state: 'consumed',
      consumed_by: faireFixture.email,
    })

    const rejectedFaireExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key,
         error_code, error_message, completed_at
       )
       SELECT organization_id, order_id, shipment_id, provider,
              external_order_id, 'failed', 1, payload_snapshot,
              idempotency_key || ':known-rejection-revision',
              'FAIRE_REQUEST_REJECTED',
              'Faire rejected the first exact request', now()
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id, idempotency_key, external_order_id,
                 payload_snapshot`,
      [
        faireFixture.organizationId,
        authorizedFaireResult.commerceExportGlobalId,
      ],
    )
    assert.equal(rejectedFaireExport.rowCount, 1)
    const rejectedExport = rejectedFaireExport.rows[0]
    await pool.query(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state, attempt_number,
         error_code, requested_at, completed_at, created_by
       )
       SELECT source_order.organization_id, source_order.integration_account_id,
              'faire.fulfillment.shipments.create',
              'faire-fulfillment-writeback-v1', $3, $4, repeat('a', 64),
              jsonb_build_object(
                'version', 1,
                'externalOrderId', $5::text,
                'expectedShipDate', $6::jsonb->>'shippedAt',
                'authorizationRevision', 4,
                'packages', (
                  SELECT jsonb_agg(jsonb_build_object(
                    'packageReference', package->>'packageReference',
                    'carrier', package->>'carrier',
                    'trackingCode', package->>'trackingCode'
                  ))
                  FROM jsonb_array_elements($6::jsonb->'packages') package
                )
              ),
              '{}'::jsonb, 'failed', 1, 'FAIRE_REQUEST_REJECTED',
              now(), now(), $7
       FROM operations_orders source_order
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2`,
      [
        faireFixture.organizationId,
        faireOrder.planned.orderGlobalId,
        rejectedExport.global_id,
        rejectedExport.idempotency_key,
        rejectedExport.external_order_id,
        JSON.stringify(rejectedExport.payload_snapshot),
        faireFixture.email,
      ],
    )
    faireFulfillmentAuthorizationRevision = 5
    const revisedFaireResult = await persistence
      .executeOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: faireFixture.organizationId,
        actorEmail: faireFixture.email,
        commerceExportGlobalId: rejectedExport.global_id,
        reason: 'Retry known Faire rejection after revised operator review',
        auditEventKey: `faire-known-rejection-retry:${rejectedExport.global_id}`,
      })
    assert.equal(
      revisedFaireResult.state,
      'succeeded',
      JSON.stringify(revisedFaireResult),
    )
    assert.equal(faireFulfillmentInputs.at(-1).mode, 'execute')
    assert.equal(
      faireFulfillmentInputs.at(-1).writeAttempt.authorizationRevision,
      5,
    )
    const revisedAttempts = await pool.query(
      `SELECT state, attempt_number,
              redacted_request->>'authorizationRevision' AS revision
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid
         AND external_object_id = $2
         AND action = 'faire.fulfillment.shipments.create'
       ORDER BY attempt_number`,
      [faireFixture.organizationId, rejectedExport.global_id],
    )
    assert.deepEqual(revisedAttempts.rows, [
      { state: 'failed', attempt_number: 1, revision: '4' },
      { state: 'succeeded', attempt_number: 2, revision: '5' },
    ])

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
    assert.match(authorization.authorizationGlobalId, /^gsea[0-9a-v]{12}$/)
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
      expectedNotificationPolicyRevision: 0,
    }
    const authorizedResult = await persistence.confirmOperationsOrderShipmentFromPostgres(
      authorizedInput,
    )
    assert.equal(authorizedResult.orderStatus, 'shipped')
    assert.equal(authorizedResult.replayed, false)
    assert.equal(shopifyFulfillmentPreparationCalls, 1)
    assert.equal(shopifyFulfillmentExecutionCalls, 1)
    const authorizedProviderAttempt = await pool.query(
      `SELECT state, attempt_number, external_object_id, redacted_request,
              provider_reference, error_code
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid
         AND external_object_id = $2
         AND action = 'shopify.fulfillment.create'`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    assert.equal(authorizedProviderAttempt.rowCount, 1)
    assert.equal(authorizedProviderAttempt.rows[0].state, 'succeeded')
    assert.equal(authorizedProviderAttempt.rows[0].attempt_number, 1)
    assert.equal(
      authorizedProviderAttempt.rows[0].provider_reference,
      'shopify-focused-fulfillment-reference',
    )
    assert.equal(authorizedProviderAttempt.rows[0].error_code, null)
    assert.equal(authorizedProviderAttempt.rows[0].redacted_request.version, 1)
    assert.equal(
      authorizedProviderAttempt.rows[0].redacted_request.notifyCustomer,
      false,
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(authorizedResult.customerNotification)),
      {
        mode: 'clawpilot_explicit',
        notifyCustomer: false,
        source: 'sandbox_e2e_suppression',
        accountPolicyRevision: 0,
        overrideReason: null,
        decidedBy: authorizedFixture.email,
      },
    )
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
    const multiPackageIdentity = await pool.query(
      `SELECT package.package_number, shipment.global_id AS shipment_global_id,
              shipment.tracking_number,
              artifact.global_id AS packing_slip_artifact_global_id
       FROM operations_shipments shipment
       JOIN operations_packages package
         ON package.organization_id = shipment.organization_id
        AND package.id = shipment.package_id
       JOIN operations_print_artifacts artifact
         ON artifact.organization_id = shipment.organization_id
        AND artifact.source_shipment_id = shipment.id
        AND artifact.document_type = 'packing_slip'
       JOIN operations_orders source_order
         ON source_order.organization_id = shipment.organization_id
        AND source_order.id = shipment.order_id
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2
       ORDER BY package.package_number`,
      [authorizedFixture.organizationId, authorized.planned.orderGlobalId],
    )
    assert.equal(multiPackageIdentity.rowCount, 2)
    assert.equal(
      authorizedResult.shipmentGlobalId,
      multiPackageIdentity.rows[0].shipment_global_id,
    )
    assert.equal(
      authorizedResult.trackingNumber,
      multiPackageIdentity.rows[0].tracking_number,
    )
    assert.equal(
      authorizedResult.packingSlipArtifactGlobalId,
      multiPackageIdentity.rows[0].packing_slip_artifact_global_id,
    )
    assert.notEqual(
      authorizedResult.shipmentGlobalId,
      multiPackageIdentity.rows[1].shipment_global_id,
    )
    assert.notEqual(
      authorizedResult.trackingNumber,
      multiPackageIdentity.rows[1].tracking_number,
    )
    const retainedSandboxExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key,
         provider_reference, completed_at
       )
       SELECT organization_id, order_id, shipment_id, provider,
              external_order_id, 'succeeded', attempts,
              payload_snapshot - 'customerNotification',
              idempotency_key || ':legacy-completed-receipt-replay',
              provider_reference, now()
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id,
                 payload_snapshot->>'sandboxE2eAuthorizationGlobalId'
                   AS sandbox_authorization_global_id`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    assert.equal(retainedSandboxExport.rowCount, 1)
    assert.equal(
      retainedSandboxExport.rows[0].sandbox_authorization_global_id,
      authorizationGlobalId,
    )
    const legacySandboxReceipt = await pool.query(
      `UPDATE operations_command_receipts
       SET result_payload = jsonb_set(
             result_payload - 'customerNotification',
             '{commerceExportGlobalId}',
             to_jsonb($3::text),
             true
           ),
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND command_type = 'confirm_operations_order_shipment'
         AND idempotency_key = $2
         AND status = 'succeeded'
       RETURNING result_payload`,
      [
        authorizedFixture.organizationId,
        authorizedInput.idempotencyKey,
        retainedSandboxExport.rows[0].global_id,
      ],
    )
    assert.equal(legacySandboxReceipt.rowCount, 1)
    assert.equal(
      legacySandboxReceipt.rows[0].result_payload.printJobGlobalId,
      authorizedResult.printJobGlobalId,
    )
    assert.equal(
      legacySandboxReceipt.rows[0].result_payload.printWarning,
      authorizedResult.printWarning,
    )
    assert.equal(
      legacySandboxReceipt.rows[0].result_payload.commerceExportGlobalId,
      retainedSandboxExport.rows[0].global_id,
    )
    const legacyReplayEvidenceBefore = await orderEvidence(
      pool,
      authorizedFixture,
      authorized.planned.orderGlobalId,
    )
    const authorizedReplay = await persistence.confirmOperationsOrderShipmentFromPostgres(
      authorizedInput,
    )
    assert.equal(authorizedReplay.replayed, true)
    const {
      customerNotification: _receiptNotification,
      replayed: _receiptReplayState,
      ...immutableReceiptFields
    } = legacySandboxReceipt.rows[0].result_payload
    const {
      customerNotification: replayedNotification,
      replayed: _replayedReplayState,
      ...replayedReceiptFields
    } = JSON.parse(JSON.stringify(authorizedReplay))
    assert.deepEqual(
      replayedReceiptFields,
      immutableReceiptFields,
      'Legacy notification recovery must preserve every immutable completed-receipt field',
    )
    assert.deepEqual(replayedNotification, {
      mode: 'clawpilot_explicit',
      notifyCustomer: false,
      source: 'sandbox_e2e_suppression',
      accountPolicyRevision: null,
      overrideReason: null,
      decidedBy: null,
    })
    for (const field of [
      'rowVersion',
      'shipmentGlobalId',
      'trackingNumber',
      'packingSlipArtifactGlobalId',
      'commerceExportGlobalId',
      'commerceExportState',
      'printJobGlobalId',
      'printWarning',
    ]) {
      assert.equal(
        authorizedReplay[field],
        legacySandboxReceipt.rows[0].result_payload[field],
        `Completed receipt replay changed immutable ${field}`,
      )
    }
    assert.deepEqual(
      await orderEvidence(
        pool,
        authorizedFixture,
        authorized.planned.orderGlobalId,
      ),
      legacyReplayEvidenceBefore,
    )
    const replayedAuthorization = await sandboxAuthorization
      .readSandboxCommerceE2eAuthorizationInPostgres({
        organizationId: authorizedFixture.organizationId,
        authorizationGlobalId,
      })
    assert.equal(replayedAuthorization.state, 'consumed')
    assert.equal(replayedAuthorization.consumedAt, consumedAuthorization.consumedAt)

    const legacySandboxExport6567 = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key, completed_at
       )
       SELECT organization_id, order_id, shipment_id, provider,
              external_order_id, 'succeeded', attempts,
              payload_snapshot - 'customerNotification',
              idempotency_key || ':legacy-sandbox-6567-read-model', now()
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    assert.equal(legacySandboxExport6567.rowCount, 1)
    const legacySandboxWorkspace =
      await persistence.readOperationsWorkspaceFromPostgres({
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
    const legacySandboxDecision = legacySandboxWorkspace.selectedOrder
      ?.commerceExports.find(
        (item) => item.globalId === legacySandboxExport6567.rows[0].global_id,
      )?.customerNotification
    assert.deepEqual(
      JSON.parse(JSON.stringify(legacySandboxDecision)),
      {
        mode: 'clawpilot_explicit',
        notifyCustomer: false,
        source: 'sandbox_e2e_suppression',
        accountPolicyRevision: null,
        overrideReason: null,
        decidedBy: null,
      },
      'A retained Shopify sandbox E2E authorization must identify legacy #6567-style export suppression',
    )

    const cappedProcessingExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key, updated_at
       )
       SELECT organization_id, order_id, shipment_id, provider, external_order_id,
              'processing', 8, payload_snapshot,
              idempotency_key || ':capped-processing-recovery',
              now() - interval '6 minutes'
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    const cappedUnknownExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key,
         error_code, error_message, completed_at
       )
       SELECT organization_id, order_id, shipment_id, provider, external_order_id,
              'failed', 8, payload_snapshot,
              idempotency_key || ':capped-unknown-recovery',
              'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
              'Unresolved acceptance outcome', now()
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    assert.equal(cappedProcessingExport.rowCount, 1)
    assert.equal(cappedUnknownExport.rowCount, 1)
    const exhaustedCount = await commerceFulfillmentRecovery
      .finalizeExhaustedCommerceFulfillmentRecoveriesInPostgres({
        workerId: 'shipment-completion-acceptance',
        limit: 5,
      })
    assert.equal(exhaustedCount, 2)
    const exhaustedEvidence = await pool.query(
      `SELECT global_id, state, attempts, error_code,
              completed_at IS NOT NULL AS completed
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid
         AND global_id = ANY($2::text[])
       ORDER BY global_id`,
      [
        authorizedFixture.organizationId,
        [
          cappedProcessingExport.rows[0].global_id,
          cappedUnknownExport.rows[0].global_id,
        ],
      ],
    )
    assert.equal(exhaustedEvidence.rowCount, 2)
    assert.ok(exhaustedEvidence.rows.every((row) => (
      row.state === 'failed'
      && row.attempts === 8
      && row.error_code ===
        'OPERATIONS_COMMERCE_EXPORT_AUTOMATIC_RECOVERY_EXHAUSTED'
      && row.completed === true
    )))
    const exhaustionAudits = await pool.query(
      `SELECT aggregate_id, payload
       FROM audit_events
       WHERE organization_id = $1::uuid
         AND event_type =
           'operations.commerce_fulfillment.recovery_exhausted'
       ORDER BY aggregate_id`,
      [authorizedFixture.organizationId],
    )
    assert.equal(exhaustionAudits.rowCount, 2)
    assert.ok(exhaustionAudits.rows.every((row) => (
      row.payload.managerRecoveryRequired === true
      && row.payload.providerIo === false
    )))

    const fairePreDispatchCrashExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key, updated_at
       )
       SELECT organization_id, order_id, shipment_id, 'faire',
              'bo_faire_predispatch_crash_acceptance', 'processing', 1,
              jsonb_set(
                jsonb_set(
                  fulfillment_export.payload_snapshot,
                  '{providerWriteProtocol}',
                  '"faire-fulfillment-attempt-v1"'::jsonb,
                  true
                ),
                '{packages}',
                (
                  SELECT jsonb_agg(jsonb_build_object(
                    'packageReference', package.global_id,
                    'carrier', label.carrier,
                    'trackingCode', shipment.tracking_number
                  ) ORDER BY package.global_id)
                  FROM operations_shipments shipment
                  JOIN operations_packages package
                    ON package.organization_id = shipment.organization_id
                   AND package.id = shipment.package_id
                  JOIN operations_labels label
                    ON label.organization_id = shipment.organization_id
                   AND label.id = shipment.label_id
                  WHERE shipment.organization_id =
                    fulfillment_export.organization_id
                    AND shipment.order_id = fulfillment_export.order_id
                ),
                true
              ),
              fulfillment_export.idempotency_key
                || ':faire-predispatch-crash-recovery',
              now() - interval '6 minutes'
       FROM operations_commerce_fulfillment_exports fulfillment_export
       WHERE fulfillment_export.organization_id = $1::uuid
         AND fulfillment_export.global_id = $2
       RETURNING global_id`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    assert.equal(fairePreDispatchCrashExport.rowCount, 1)
    const faireCrashClaim = await commerceFulfillmentRecovery
      .claimCommerceFulfillmentRecoveryInPostgres({
        workerId: 'shipment-completion-acceptance',
      })
    assert.equal(
      faireCrashClaim.commerceExportGlobalId,
      fairePreDispatchCrashExport.rows[0].global_id,
    )
    assert.equal(faireCrashClaim.priorState, 'processing')
    assert.equal(faireCrashClaim.attempt, 2)
    const faireExecutionsBeforeCrashRecovery = faireFulfillmentExecutionCalls
    const faireCrashRecovery = await persistence
      .executeOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: faireCrashClaim.organizationId,
        actorEmail: faireCrashClaim.actorEmail,
        commerceExportGlobalId: faireCrashClaim.commerceExportGlobalId,
        reason: 'Resume the exact-v1 pre-dispatch Faire crash safely',
        auditEventKey: (
          `shipment-completion-faire-crash-recovery:`
          + faireCrashClaim.commerceExportGlobalId
        ),
        preclaimed: {
          attempt: faireCrashClaim.attempt,
          priorState: faireCrashClaim.priorState,
          priorErrorCode: faireCrashClaim.priorErrorCode,
          workerId: 'shipment-completion-acceptance',
        },
      })
    assert.equal(
      faireCrashRecovery.state,
      'succeeded',
      JSON.stringify(faireCrashRecovery),
    )
    assert.equal(
      faireFulfillmentExecutionCalls,
      faireExecutionsBeforeCrashRecovery + 1,
    )
    assert.equal(
      faireFulfillmentInputs.at(-1).mode,
      'execute',
      'No durable provider attempt proves the pre-dispatch crash can execute',
    )
    const faireCrashAttempts = await pool.query(
      `SELECT state, attempt_number
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid
         AND external_object_id = $2
         AND action = 'faire.fulfillment.shipments.create'`,
      [
        authorizedFixture.organizationId,
        fairePreDispatchCrashExport.rows[0].global_id,
      ],
    )
    assert.deepEqual(faireCrashAttempts.rows, [{
      state: 'succeeded',
      attempt_number: 2,
    }])

    await pool.query(
      `UPDATE operations_shipments shipment
       SET confirmed_by = NULL
       FROM operations_commerce_fulfillment_exports fulfillment_export
       WHERE fulfillment_export.organization_id = $1::uuid
         AND fulfillment_export.global_id = $2
         AND shipment.organization_id = fulfillment_export.organization_id
         AND shipment.id = fulfillment_export.shipment_id`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    const deletedConfirmerExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key,
         requested_at, updated_at
       )
       SELECT organization_id, order_id, shipment_id, provider, external_order_id,
              'queued', 0, payload_snapshot,
              idempotency_key || ':deleted-confirmer-recovery',
              now() - interval '1 minute', now() - interval '1 minute'
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    assert.equal(deletedConfirmerExport.rowCount, 1)
    const deletedConfirmerClaim = await commerceFulfillmentRecovery
      .claimCommerceFulfillmentRecoveryInPostgres({
        workerId: 'shipment-completion-acceptance',
      })
    assert.equal(
      deletedConfirmerClaim.commerceExportGlobalId,
      deletedConfirmerExport.rows[0].global_id,
    )
    assert.equal(deletedConfirmerClaim.actorEmail, null)
    const deletedConfirmerRecovery = await persistence
      .executeOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: deletedConfirmerClaim.organizationId,
        actorEmail: deletedConfirmerClaim.actorEmail,
        commerceExportGlobalId: deletedConfirmerClaim.commerceExportGlobalId,
        reason: 'Continue after original shipment confirmer deletion',
        auditEventKey: (
          `shipment-completion-deleted-confirmer:`
          + deletedConfirmerClaim.commerceExportGlobalId
        ),
        preclaimed: {
          attempt: deletedConfirmerClaim.attempt,
          priorState: deletedConfirmerClaim.priorState,
          priorErrorCode: deletedConfirmerClaim.priorErrorCode,
          workerId: 'shipment-completion-acceptance',
        },
      })
    assert.equal(deletedConfirmerRecovery.state, 'succeeded')
    const deletedConfirmerEvidence = await pool.query(
      `SELECT attempt.created_by, audit.actor, audit.is_system,
              audit.payload
       FROM operations_commerce_provider_attempts attempt
       JOIN audit_events audit
         ON audit.organization_id = attempt.organization_id
        AND audit.aggregate_id = attempt.external_object_id
        AND audit.event_type =
          'operations.commerce_fulfillment.attempted'
       WHERE attempt.organization_id = $1::uuid
         AND attempt.external_object_id = $2
         AND attempt.action = 'shopify.fulfillment.create'`,
      [
        authorizedFixture.organizationId,
        deletedConfirmerExport.rows[0].global_id,
      ],
    )
    assert.equal(deletedConfirmerEvidence.rowCount, 1)
    assert.equal(deletedConfirmerEvidence.rows[0].created_by, null)
    assert.equal(deletedConfirmerEvidence.rows[0].actor, 'system')
    assert.equal(deletedConfirmerEvidence.rows[0].is_system, true)
    assert.equal(
      deletedConfirmerEvidence.rows[0].payload.originalConfirmer,
      null,
    )

    const interleavedShopifyExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key
       )
       SELECT organization_id, order_id, shipment_id, provider, external_order_id,
              'queued', 0, payload_snapshot,
              idempotency_key || ':interleaved-shopify-attempt'
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    assert.equal(interleavedShopifyExport.rowCount, 1)
    let releaseFirstPreparation
    let markFirstPreparationEntered
    const firstPreparationEntered = new Promise((resolvePromise) => {
      markFirstPreparationEntered = resolvePromise
    })
    const releaseFirstPreparationPromise = new Promise((resolvePromise) => {
      releaseFirstPreparation = resolvePromise
    })
    let firstPreparationHeld = false
    shopifyFulfillmentPreparationHook = async () => {
      if (firstPreparationHeld) return
      firstPreparationHeld = true
      markFirstPreparationEntered()
      await releaseFirstPreparationPromise
    }
    const preparationCallsBeforeInterleaving = shopifyFulfillmentPreparationCalls
    const executionCallsBeforeInterleaving = shopifyFulfillmentExecutionCalls
    const firstInterleavedAttempt = persistence
      .retryOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: authorizedFixture.organizationId,
        actorEmail: authorizedFixture.email,
        commerceExportGlobalId: interleavedShopifyExport.rows[0].global_id,
        reason: 'Hold the first Shopify preparation to prove stale-attempt fencing',
        idempotencyKey: `retry-interleaved-shopify-first-${randomUUID()}`,
      })
    await firstPreparationEntered
    await pool.query(
      `UPDATE operations_commerce_fulfillment_exports
       SET updated_at = now() - interval '6 minutes'
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [authorizedFixture.organizationId, interleavedShopifyExport.rows[0].global_id],
    )
    const secondInterleavedAttempt = await persistence
      .retryOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: authorizedFixture.organizationId,
        actorEmail: authorizedFixture.email,
        commerceExportGlobalId: interleavedShopifyExport.rows[0].global_id,
        reason: 'Supersede the stale pre-registration Shopify worker safely',
        idempotencyKey: `retry-interleaved-shopify-second-${randomUUID()}`,
      })
    assert.equal(secondInterleavedAttempt.state, 'succeeded')
    releaseFirstPreparation()
    await assert.rejects(
      firstInterleavedAttempt,
      (error) => error?.code === 'OPERATIONS_COMMERCE_EXPORT_CHANGED',
    )
    shopifyFulfillmentPreparationHook = null
    assert.equal(
      shopifyFulfillmentPreparationCalls,
      preparationCallsBeforeInterleaving + 2,
    )
    assert.equal(
      shopifyFulfillmentExecutionCalls,
      executionCallsBeforeInterleaving + 1,
      'The superseded worker must fail its exact-attempt CAS before calling Shopify',
    )
    const interleavedProviderAttempts = await pool.query(
      `SELECT state, attempt_number
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid
         AND external_object_id = $2
         AND action = 'shopify.fulfillment.create'`,
      [
        authorizedFixture.organizationId,
        interleavedShopifyExport.rows[0].global_id,
      ],
    )
    assert.deepEqual(interleavedProviderAttempts.rows, [{
      state: 'succeeded',
      attempt_number: 2,
    }])

    const staleShopifyExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key, updated_at
       )
       SELECT organization_id, order_id, shipment_id, provider, external_order_id,
              'processing', 1,
              jsonb_set(
                payload_snapshot,
                '{customerNotification}',
                '{"notifyCustomer":true}'::jsonb,
                true
              ),
              idempotency_key || ':stale-shopify-recovery',
              now() - interval '6 minutes'
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    assert.equal(staleShopifyExport.rowCount, 1)
    const staleShopifyProviderAttempt = await pool.query(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state, attempt_number,
         requested_at, created_by
       )
       SELECT attempt.organization_id, attempt.integration_account_id,
              attempt.action, attempt.adapter_version,
              $3, attempt.idempotency_key || ':stale-shopify-recovery',
              attempt.request_hash, attempt.redacted_request, '{}'::jsonb,
              'prepared', 1, now() - interval '6 minutes', attempt.created_by
       FROM operations_commerce_provider_attempts attempt
       WHERE attempt.organization_id = $1::uuid
         AND attempt.external_object_id = $2
         AND attempt.action = 'shopify.fulfillment.create'
       ORDER BY attempt.requested_at DESC
       LIMIT 1
       RETURNING global_id`,
      [
        authorizedFixture.organizationId,
        authorizedResult.commerceExportGlobalId,
        staleShopifyExport.rows[0].global_id,
      ],
    )
    assert.equal(staleShopifyProviderAttempt.rowCount, 1)
    const preparationCallsBeforeStaleRecovery =
      shopifyFulfillmentPreparationCalls
    const executionCallsBeforeStaleRecovery = shopifyFulfillmentExecutionCalls
    const reconciliationCallsBeforeStaleRecovery =
      shopifyFulfillmentReconciliationCalls
    const fencedStaleShopifyExport = await persistence
      .retryOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: authorizedFixture.organizationId,
        actorEmail: authorizedFixture.email,
        commerceExportGlobalId: staleShopifyExport.rows[0].global_id,
        reason: 'Fence the stale Shopify attempt before any provider replay',
        idempotencyKey: `retry-stale-shopify-fence-${randomUUID()}`,
      })
    assert.equal(fencedStaleShopifyExport.state, 'failed')
    assert.equal(fencedStaleShopifyExport.providerReference, null)
    assert.equal(
      fencedStaleShopifyExport.errorCode,
      'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(fencedStaleShopifyExport.customerNotification)),
      {
        mode: 'clawpilot_explicit',
        notifyCustomer: false,
        source: 'sandbox_e2e_suppression',
        accountPolicyRevision: null,
        overrideReason: null,
        decidedBy: null,
      },
    )
    assert.equal(
      shopifyFulfillmentPreparationCalls,
      preparationCallsBeforeStaleRecovery,
      'A durable prior attempt must not be prepared again',
    )
    assert.equal(
      shopifyFulfillmentExecutionCalls,
      executionCallsBeforeStaleRecovery,
      'The first stale recovery must not repeat the Shopify mutation',
    )
    assert.equal(
      shopifyFulfillmentReconciliationCalls,
      reconciliationCallsBeforeStaleRecovery + 1,
      'The first stale recovery must perform exactly one read-only reconciliation',
    )
    const fencedStaleShopifyEvidence = await pool.query(
      `SELECT state, attempts, error_code
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [authorizedFixture.organizationId, staleShopifyExport.rows[0].global_id],
    )
    assert.deepEqual(fencedStaleShopifyEvidence.rows[0], {
      state: 'failed',
      attempts: 2,
      error_code: 'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
    })

    const unresolvedStaleShopifyExport = await persistence
      .retryOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: authorizedFixture.organizationId,
        actorEmail: authorizedFixture.email,
        commerceExportGlobalId: staleShopifyExport.rows[0].global_id,
        reason: 'Reconcile the durable Shopify attempt again without another write',
        idempotencyKey: `retry-stale-shopify-reconcile-${randomUUID()}`,
      })
    assert.equal(unresolvedStaleShopifyExport.state, 'failed')
    assert.equal(
      unresolvedStaleShopifyExport.errorCode,
      'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
    )
    assert.equal(
      shopifyFulfillmentPreparationCalls,
      preparationCallsBeforeStaleRecovery,
      'Repeated unknown-outcome recovery must not prepare another write',
    )
    assert.equal(
      shopifyFulfillmentExecutionCalls,
      executionCallsBeforeStaleRecovery,
      'Repeated unknown-outcome recovery must never repeat the Shopify mutation',
    )
    assert.equal(
      shopifyFulfillmentReconciliationCalls,
      reconciliationCallsBeforeStaleRecovery + 2,
      'Repeated unknown-outcome recovery must remain read-only',
    )
    const unresolvedStaleShopifyEvidence = await pool.query(
      `SELECT state, attempts, error_code
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [authorizedFixture.organizationId, staleShopifyExport.rows[0].global_id],
    )
    assert.deepEqual(unresolvedStaleShopifyEvidence.rows[0], {
      state: 'failed',
      attempts: 3,
      error_code: 'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
    })

    shopifyFulfillmentReconciliationResult = {
      providerReference: 'shopify-reconciled-fulfillment-reference',
      trackingNumber: authorizedTrackingNumbers[0],
      trackingNumbers: authorizedTrackingNumbers,
      replayed: true,
    }
    const reconciledStaleShopifyExport = await persistence
      .retryOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: authorizedFixture.organizationId,
        actorEmail: authorizedFixture.email,
        commerceExportGlobalId: staleShopifyExport.rows[0].global_id,
        reason: 'Record the exact Shopify fulfillment observed by read-only reconciliation',
        idempotencyKey: `retry-stale-shopify-observed-${randomUUID()}`,
      })
    assert.equal(reconciledStaleShopifyExport.state, 'succeeded')
    assert.equal(
      reconciledStaleShopifyExport.providerReference,
      'shopify-reconciled-fulfillment-reference',
    )
    assert.equal(
      shopifyFulfillmentExecutionCalls,
      executionCallsBeforeStaleRecovery,
      'Exact reconciliation success must not repeat the Shopify mutation',
    )
    assert.equal(
      shopifyFulfillmentReconciliationCalls,
      reconciliationCallsBeforeStaleRecovery + 3,
    )
    const reconciledStaleShopifyEvidence = await pool.query(
      `SELECT state, attempts, error_code
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [authorizedFixture.organizationId, staleShopifyExport.rows[0].global_id],
    )
    assert.deepEqual(reconciledStaleShopifyEvidence.rows[0], {
      state: 'succeeded',
      attempts: 4,
      error_code: null,
    })
    shopifyFulfillmentReconciliationResult = null

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

    const falseDefault = await createShopifyShipmentFixture(
      'notification-default-false',
    )
    const falseDefaultResult =
      await persistence.confirmOperationsOrderShipmentFromPostgres({
        organizationId: falseDefault.fixture.organizationId,
        actorEmail: falseDefault.fixture.email,
        orderGlobalId: falseDefault.order.planned.orderGlobalId,
        expectedRowVersion: falseDefault.order.packed.rowVersion,
        reason: 'Confirm the safe false Shopify notification default',
        idempotencyKey: `confirm-notification-default-false-${randomUUID()}`,
        expectedNotificationPolicyRevision: falseDefault.revision,
      })
    assert.equal(falseDefaultResult.commerceExportState, 'succeeded')
    assert.deepEqual(
      JSON.parse(JSON.stringify(falseDefaultResult.customerNotification)),
      {
        mode: 'clawpilot_explicit',
        notifyCustomer: false,
        source: 'account_default',
        accountPolicyRevision: 1,
        overrideReason: null,
        decidedBy: falseDefault.fixture.email,
      },
    )
    assert.equal(shopifyFulfillmentInputs.at(-1).notifyCustomer, false)

    const trueDefault = await createShopifyShipmentFixture(
      'notification-default-true',
      { notifyCustomerDefault: true },
    )
    const trueDefaultResult =
      await persistence.confirmOperationsOrderShipmentFromPostgres({
        organizationId: trueDefault.fixture.organizationId,
        actorEmail: trueDefault.fixture.email,
        orderGlobalId: trueDefault.order.planned.orderGlobalId,
        expectedRowVersion: trueDefault.order.packed.rowVersion,
        reason: 'Confirm the enabled Shopify notification request default',
        idempotencyKey: `confirm-notification-default-true-${randomUUID()}`,
        expectedNotificationPolicyRevision: trueDefault.revision,
      })
    assert.equal(trueDefaultResult.commerceExportState, 'succeeded')
    assert.deepEqual(
      JSON.parse(JSON.stringify(trueDefaultResult.customerNotification)),
      {
        mode: 'clawpilot_explicit',
        notifyCustomer: true,
        source: 'account_default',
        accountPolicyRevision: 2,
        overrideReason: null,
        decidedBy: trueDefault.fixture.email,
      },
    )
    assert.equal(shopifyFulfillmentInputs.at(-1).notifyCustomer, true)

    const orderOverride = await createShopifyShipmentFixture(
      'notification-order-override',
    )
    const overrideReason = (
      'Request a notification for this exact Shopify acceptance order only'
    )
    const orderOverrideResult =
      await persistence.confirmOperationsOrderShipmentFromPostgres({
        organizationId: orderOverride.fixture.organizationId,
        actorEmail: orderOverride.fixture.email,
        orderGlobalId: orderOverride.order.planned.orderGlobalId,
        expectedRowVersion: orderOverride.order.packed.rowVersion,
        reason: 'Confirm the explicit per-order notification exception',
        idempotencyKey: `confirm-notification-override-${randomUUID()}`,
        expectedNotificationPolicyRevision: orderOverride.revision,
        customerNotificationOverride: true,
        customerNotificationOverrideReason: overrideReason,
      })
    assert.equal(orderOverrideResult.commerceExportState, 'succeeded')
    assert.deepEqual(
      JSON.parse(JSON.stringify(orderOverrideResult.customerNotification)),
      {
        mode: 'clawpilot_explicit',
        notifyCustomer: true,
        source: 'order_override',
        accountPolicyRevision: 1,
        overrideReason,
        decidedBy: orderOverride.fixture.email,
      },
    )
    assert.equal(shopifyFulfillmentInputs.at(-1).notifyCustomer, true)

    const revisionRace = await createShopifyShipmentFixture(
      'notification-policy-revision-race',
    )
    const raceEvidenceBefore = await orderEvidence(
      pool,
      revisionRace.fixture,
      revisionRace.order.planned.orderGlobalId,
    )
    const racePreparationCallsBefore = shopifyFulfillmentPreparationCalls
    const revisedRacePolicy = await fulfillmentNotificationPolicy
      .updateShopifyFulfillmentNotificationPolicyInPostgres({
        organizationId: revisionRace.fixture.organizationId,
        accountGlobalId: revisionRace.account.global_id,
        actorEmail: revisionRace.fixture.email,
        expectedRevision: revisionRace.revision,
        notifyCustomerDefault: true,
        reason: 'Change the policy after the operator opened the shipment',
      })
    assert.equal(revisedRacePolicy.revision, 2)
    await expectRejected(
      () => persistence.confirmOperationsOrderShipmentFromPostgres({
        organizationId: revisionRace.fixture.organizationId,
        actorEmail: revisionRace.fixture.email,
        orderGlobalId: revisionRace.order.planned.orderGlobalId,
        expectedRowVersion: revisionRace.order.packed.rowVersion,
        reason: 'Reject confirmation using the stale notification revision',
        idempotencyKey: `confirm-notification-revision-race-${randomUUID()}`,
        expectedNotificationPolicyRevision: revisionRace.revision,
      }),
      (error) => (
        error?.code === 'OPERATIONS_NOTIFICATION_POLICY_REVISION_CONFLICT'
      ),
      'Shipment confirmation must reject a raced Shopify notification policy',
    )
    assert.equal(
      shopifyFulfillmentPreparationCalls,
      racePreparationCallsBefore,
      'A notification policy race must fail before any Shopify provider I/O',
    )
    assert.deepEqual(
      await orderEvidence(
        pool,
        revisionRace.fixture,
        revisionRace.order.planned.orderGlobalId,
      ),
      raceEvidenceBefore,
    )

    const retryAfterPolicyChange = await createShopifyShipmentFixture(
      'notification-policy-change-after-export',
    )
    shopifyFulfillmentPreparationHook = async () => {
      const error = new Error(
        'Simulated Shopify preparation rejection before provider dispatch',
      )
      error.code = 'SHOPIFY_PREPARATION_REJECTED'
      throw error
    }
    let failedImmutableExport
    try {
      failedImmutableExport =
        await persistence.confirmOperationsOrderShipmentFromPostgres({
          organizationId: retryAfterPolicyChange.fixture.organizationId,
          actorEmail: retryAfterPolicyChange.fixture.email,
          orderGlobalId: retryAfterPolicyChange.order.planned.orderGlobalId,
          expectedRowVersion: retryAfterPolicyChange.order.packed.rowVersion,
          reason: 'Create the immutable export before a policy change',
          idempotencyKey: `confirm-before-notification-change-${randomUUID()}`,
          expectedNotificationPolicyRevision: retryAfterPolicyChange.revision,
        })
    } finally {
      shopifyFulfillmentPreparationHook = null
    }
    assert.equal(failedImmutableExport.commerceExportState, 'failed')
    assert.deepEqual(
      JSON.parse(JSON.stringify(failedImmutableExport.customerNotification)),
      {
        mode: 'clawpilot_explicit',
        notifyCustomer: false,
        source: 'account_default',
        accountPolicyRevision: 1,
        overrideReason: null,
        decidedBy: retryAfterPolicyChange.fixture.email,
      },
    )
    const changedAfterExport = await fulfillmentNotificationPolicy
      .updateShopifyFulfillmentNotificationPolicyInPostgres({
        organizationId: retryAfterPolicyChange.fixture.organizationId,
        accountGlobalId: retryAfterPolicyChange.account.global_id,
        actorEmail: retryAfterPolicyChange.fixture.email,
        expectedRevision: retryAfterPolicyChange.revision,
        notifyCustomerDefault: true,
        reason: 'Enable requests only after the failed export was frozen',
      })
    assert.equal(changedAfterExport.revision, 2)
    const retryInputCountBefore = shopifyFulfillmentInputs.length
    const immutableRetry = await persistence
      .retryOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: retryAfterPolicyChange.fixture.organizationId,
        actorEmail: retryAfterPolicyChange.fixture.email,
        commerceExportGlobalId: failedImmutableExport.commerceExportGlobalId,
        reason: 'Retry with the original immutable notification decision',
        idempotencyKey: `retry-after-notification-change-${randomUUID()}`,
      })
    assert.equal(immutableRetry.state, 'succeeded')
    assert.deepEqual(
      JSON.parse(JSON.stringify(immutableRetry.customerNotification)),
      JSON.parse(JSON.stringify(failedImmutableExport.customerNotification)),
    )
    assert.equal(
      shopifyFulfillmentInputs.length,
      retryInputCountBefore + 1,
    )
    assert.equal(
      shopifyFulfillmentInputs.at(-1).notifyCustomer,
      false,
      'A later policy change must not alter the retry request frozen in the export',
    )
    const immutableExportEvidence = await pool.query(
      `SELECT payload_snapshot->'customerNotification' AS decision
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [
        retryAfterPolicyChange.fixture.organizationId,
        failedImmutableExport.commerceExportGlobalId,
      ],
    )
    assert.deepEqual(
      immutableExportEvidence.rows[0].decision,
      JSON.parse(JSON.stringify(failedImmutableExport.customerNotification)),
    )
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
  const notificationMigration = read(
    'db/migrations/0201_operations_fulfillment_notification_policy.sql',
  )
  for (const fragment of [
    "SET LOCAL lock_timeout = '5s'",
    "SET LOCAL statement_timeout = '25s'",
    'operations_shopify_fulfillment_notification_policies',
    'notify_customer_default boolean NOT NULL DEFAULT false',
    "policy_version = 'shopify-fulfillment-notification-v1'",
    'Fulfillment notification policy is Shopify-commerce-only',
  ]) {
    assert.ok(
      notificationMigration.includes(fragment),
      `Fulfillment notification migration is missing ${fragment}`,
    )
  }
  assert.ok(
    !notificationMigration.includes("'provider_managed'"),
    'Notification policy migration must not add a provider-managed fulfillment-export terminal state',
  )
  const operationsSource = read('app_src/lib/persistence/operations.ts')
  for (const fragment of [
    'sandbox_e2e_suppression',
    'retryOperationsCommerceFulfillmentExportFromPostgres',
    "commandType: 'retry_operations_commerce_fulfillment_export'",
    "AND attempts = $7",
    'commerceFulfillmentRecoveryMode({',
    'registerShopifyFulfillmentProviderAttempt',
    'registerFaireFulfillmentProviderAttempt',
    'operations_commerce_provider_attempts',
    "'shopify.fulfillment.create'",
    "'faire.fulfillment.shipments.create'",
    "providerWriteProtocol: 'shopify-fulfillment-attempt-v2'",
    "'faire-fulfillment-attempt-v1'",
    'reconcileShopifyFulfillmentWriteback',
    'executeCurrentFaireFulfillmentWriteback',
    'prepareCurrentFaireFulfillmentAuthority',
    'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
    "mode: 'unavailable'",
    'customerNotification: resolvedCustomerNotification',
    'OPERATIONS_FAIRE_FULFILLMENT_SIGNATURE_REQUIRED',
  ]) {
    assert.ok(
      operationsSource.includes(fragment),
      `Shipment completion persistence is missing ${fragment}`,
    )
  }
  const commerceRoute = read('app_src/app/api/integrations/commerce/route.ts')
  for (const fragment of [
    "action === 'set-shopify-fulfillment-notification-policy'",
    'requireActivator(actor)',
    'setShopifyFulfillmentNotificationPolicy',
  ]) {
    assert.ok(
      commerceRoute.includes(fragment),
      `Commerce policy API is missing ${fragment}`,
    )
  }
  const commercePanel = read('app_src/components/settings/CommerceIntegrationPanel.tsx')
  for (const fragment of [
    'Fulfillment &amp; tracking',
    'Save notification default',
    'Customer notification requests use a ClawPilot default for this',
    'Shopify customer notification requests now default to',
    'Enable Shopify customer notification requests for future',
    'Disable Shopify customer notification requests for future',
    'changing this setting never changes the request captured for prior',
    'shipment tracking triggers Faire&apos;s shipment email',
    'Use a controlled recipient for test orders',
  ]) {
    assert.ok(
      commercePanel.includes(fragment),
      `Commerce policy settings UI is missing ${fragment}`,
    )
  }
  const operationsPanel = read('app_src/components/operations/OperationsSection.tsx')
  for (const fragment of [
    'This commerce provider does not expose a ClawPilot customer-notification',
    'Customer notification requested',
    'Customer notification not requested',
    'Use ClawPilot connection default',
    'shipment tracking triggers Faire&apos;s shipment email',
    'Verify this test order uses a controlled recipient',
  ]) {
    assert.ok(
      operationsPanel.includes(fragment),
      `Operations notification UI is missing ${fragment}`,
    )
  }
  assert.ok(
    !operationsPanel.includes('Customer email enabled'),
    'Operations UI must describe a provider notification request, not email delivery',
  )
  const operationsRoute = read('app_src/app/api/operations/route.ts')
  for (const fragment of [
    "action === 'retry-commerce-fulfillment-export'",
    'retryOperationsCommerceFulfillmentExportFromPostgres',
    'Customer notification exception reason',
  ]) {
    assert.ok(
      operationsRoute.includes(fragment),
      `Operations fulfillment API is missing ${fragment}`,
    )
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
