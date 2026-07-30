#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
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
    const shopifyCheckoutRating = loadTypeScriptModule(
      'app_src/lib/persistence/shopifyCheckoutRating.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
    const persistence = loadTypeScriptModule('app_src/lib/persistence/operations.ts', {
      mocks: {
        '@/lib/auditWriter': auditWriter,
        '@/lib/crm/stableId': stableId,
        '@/lib/operations/adapters': adapters,
        '@/lib/operations/domain': domain,
        '@/lib/operations/packingSlip': packingSlip,
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

    const createFixture = async (scenario) => {
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
            unitsPerPackage: 2,
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
      packingSlip.PACKAGE_PACKING_LIST_TEMPLATE_VERSION,
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
  const paginated = packingSlip.renderPackagePackingList({
    documentStage: 'warehouse_packing',
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
    'The final package packing-list page must be numbered',
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
