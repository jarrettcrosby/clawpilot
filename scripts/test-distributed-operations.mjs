#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')
const contractsOnly = process.argv.includes('--contracts-only') || !process.env.DATABASE_URL

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

function verifySourceContracts() {
  const migration = read('db/migrations/0081_distributed_operations_foundation.sql')
  for (const fragment of [
    "('gor', 'operations.order'",
    "('gwh', 'operations.warehouse'",
    "('giv', 'operations.inventory_position'",
    "('gld', 'operations.inventory_ledger'",
    "('gsh', 'operations.shipment'",
    "('gbe', 'operations.billable_event'",
    "('gev', 'operations.domain_event'",
    'CREATE TABLE IF NOT EXISTS operations_integration_accounts',
    'CREATE TABLE IF NOT EXISTS operations_inventory_positions',
    'CREATE TABLE IF NOT EXISTS operations_inventory_ledger',
    'CREATE TABLE IF NOT EXISTS operations_orders',
    'CREATE TABLE IF NOT EXISTS operations_fulfillment_plans',
    'CREATE TABLE IF NOT EXISTS operations_shipments',
    'CREATE TABLE IF NOT EXISTS operations_billable_events',
    'CREATE TABLE IF NOT EXISTS operations_domain_events',
    'operations_orders_external_unique',
    'operations_inventory_ledger_idempotency_unique',
    'protect_operations_append_only',
    'protect_operations_inventory_ledger_mutation',
    'protect_operations_domain_events_mutation',
    'protect_operations_billable_events_mutation',
  ]) assert.ok(migration.includes(fragment), `Operations migration missing ${fragment}`)

  for (const forbidden of ['client_secret', 'access_token', 'private_key']) {
    assert.ok(!migration.toLowerCase().includes(forbidden), `Operations migration must not persist ${forbidden}`)
  }

  const persistence = read('app_src/lib/persistence/operations.ts')
  for (const fragment of [
    'readOperationsWorkspaceFromPostgres',
    'runMockOperationsProofFromPostgres',
    'updateOperationsExceptionInPostgres',
    'operations:exception:',
    "aggregateType: 'operations.exception'",
    'operations:proof-order:',
    'FOR UPDATE OF position',
    'OPERATIONS_FULFILLMENT_INFEASIBLE',
    'operations_inventory_ledger',
    'operations_billable_events',
    "target_system, idempotency_key",
    "eventType: 'operations.proof_order.completed'",
  ]) assert.ok(persistence.includes(fragment), `Operations persistence missing ${fragment}`)
  assert.ok(!persistence.includes('console.'), 'Operations persistence must not log tenant data')

  const adapters = read('app_src/lib/operations/adapters.ts')
  for (const fragment of ['CommerceAdapter', 'CarrierAdapter', 'PrintAdapter', 'MockCommerceAdapter', 'MockCarrierAdapter', 'MockPrintAdapter']) {
    assert.ok(adapters.includes(fragment), `Operations adapter boundary missing ${fragment}`)
  }

  const domain = read('app_src/lib/operations/domain.ts')
  for (const fragment of ['DeterministicFulfillmentOptimizer', 'cartonizeSinglePackage', 'selectPromiseRate', 'priceContract']) {
    assert.ok(domain.includes(fragment), `Operations domain missing ${fragment}`)
  }

  const route = read('app_src/app/api/operations/route.ts')
  for (const fragment of [
    'requireRequestUser',
    'operationsCapabilities',
    'activeOperationsOrganizationId',
    'isPostgresStorageEnabled',
    'readOperationsWorkspaceFromPostgres',
    'runMockOperationsProofFromPostgres',
    'updateOperationsExceptionInPostgres',
    "'Cache-Control': 'private, no-store'",
    'MAX_REQUEST_BYTES',
    "action === 'run-proof-order'",
    "action === 'update-exception'",
  ]) assert.ok(route.includes(fragment), `Operations route missing ${fragment}`)
  assert.ok(!/clientSecret|accessToken|privateKey/i.test(route), 'Operations route must not handle credentials')

  const health = read('app_src/app/api/health/route.ts')
  assert.ok(
    health.includes("WHERE filename = '0081_distributed_operations_foundation.sql'"),
    'Health must require the distributed operations migration',
  )
  assert.ok(
    health.includes('row?.distributed_operations_migration_applied'),
    'Health migration status must include distributed operations',
  )

  const predeploy = read('scripts/verify-predeploy.mjs')
  assert.ok(
    predeploy.includes("'db/migrations/0081_distributed_operations_foundation.sql'"),
    'Predeploy must require the distributed operations migration',
  )
}

async function verifyRouteBehavior() {
  class OperationsRequestError extends Error {
    constructor(code, message, status = 400) {
      super(message)
      this.code = code
      this.status = status
    }
  }
  const calls = { reads: [], proofs: [], exceptions: [] }
  const route = loadTypeScriptModule('app_src/app/api/operations/route.ts', {
    mocks: {
      'next/server': {
        NextResponse: {
          json(payload, init = {}) {
            return new Response(JSON.stringify(payload), {
              status: init.status || 200,
              headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
            })
          },
        },
      },
      '@/lib/operations/authorization': {
        operationsCapabilities: (actor) => actor.capabilities,
        activeOperationsOrganizationId: (actor) => {
          if (!actor.organizationId) throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
          return actor.organizationId
        },
      },
      '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
      '@/lib/persistence/operations': {
        OperationsRequestError,
        readOperationsWorkspaceFromPostgres: async (input) => {
          calls.reads.push(input)
          return { organizationId: input.organizationId, orders: [], capabilities: input.capabilities }
        },
        runMockOperationsProofFromPostgres: async (input) => {
          calls.proofs.push(input)
          return {
            orderGlobalId: 'gor1234567',
            orderStatus: 'shipped',
            duplicate: input.proof.externalOrderId === 'duplicate-order',
            trackingNumber: 'MOCKTRACKING',
            steps: Array.from({ length: 20 }, (_, index) => `step-${index + 1}`),
          }
        },
        updateOperationsExceptionInPostgres: async (input) => {
          calls.exceptions.push(input)
          return {
            changed: true,
            exception: {
              globalId: input.exceptionGlobalId,
              status: input.status,
              title: 'Inventory review',
            },
          }
        },
      },
      '@/lib/requestUser': {
        requireRequestUser: async (request) => request.actor,
      },
    },
  })

  const actor = {
    email: 'operator@example.com',
    organizationId: randomUUID(),
    capabilities: { canView: true, canManage: true, canExecute: true },
  }
  const request = (url, options = {}) => ({
    actor: options.actor || actor,
    nextUrl: new URL(url),
    headers: new Headers(options.headers || {}),
    text: async () => options.body || '',
  })
  const payload = async (response) => JSON.parse(await response.text())

  const deniedRead = await route.GET(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: false, canManage: false, canExecute: false } },
  }))
  assert.equal(deniedRead.status, 403)
  assert.equal((await payload(deniedRead)).code, 'OPERATIONS_VIEW_REQUIRED')

  const invalidStatus = await route.GET(request('http://localhost/api/operations?status=unknown'))
  assert.equal(invalidStatus.status, 400)
  assert.equal((await payload(invalidStatus)).code, 'OPERATIONS_STATUS_INVALID')

  const validRead = await route.GET(request('http://localhost/api/operations?status=shipped&exceptionStatus=open&search=proof&order=gor1234567'))
  assert.equal(validRead.status, 200)
  assert.equal(validRead.headers.get('cache-control'), 'private, no-store')
  assert.equal(calls.reads.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.reads[0])), {
    organizationId: actor.organizationId,
    capabilities: actor.capabilities,
    search: 'proof',
    status: 'shipped',
    exceptionStatus: 'open',
    selectedOrderGlobalId: 'gor1234567',
  })

  const requested = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const proof = {
    customerGlobalId: 'ga1234567',
    productGlobalId: 'gp1234567',
    externalOrderId: 'route-proof',
    orderNumber: 'ROUTE-1',
    quantity: 2,
    openingQuantity: 12,
    requestedDeliveryAt: requested,
    shipTo: {
      name: 'Receiving',
      line1: '200 Customer Lane',
      city: 'New York',
      region: 'NY',
      postalCode: '10001',
      country: 'us',
    },
  }
  const deniedWrite = await route.POST(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: true, canManage: true, canExecute: false } },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'run-proof-order', proof }),
  }))
  assert.equal(deniedWrite.status, 403)
  assert.equal((await payload(deniedWrite)).code, 'OPERATIONS_EXECUTE_REQUIRED')

  const validWrite = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'run-proof-order', proof }),
  }))
  assert.equal(validWrite.status, 201)
  assert.equal(calls.proofs.length, 1)
  assert.equal(calls.proofs[0].organizationId, actor.organizationId)
  assert.equal(calls.proofs[0].actorEmail, actor.email)
  assert.equal(calls.proofs[0].proof.shipTo.country, 'US')

  const validExceptionUpdate = await route.POST(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: true, canManage: true, canExecute: false } },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update-exception', exceptionGlobalId: 'gex1234567', status: 'acknowledged' }),
  }))
  assert.equal(validExceptionUpdate.status, 200)
  assert.equal(calls.exceptions.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.exceptions[0])), {
    organizationId: actor.organizationId,
    actorEmail: actor.email,
    exceptionGlobalId: 'gex1234567',
    status: 'acknowledged',
  })

  const deniedExceptionUpdate = await route.POST(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: true, canManage: false, canExecute: false } },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update-exception', exceptionGlobalId: 'gex1234567', status: 'resolved' }),
  }))
  assert.equal(deniedExceptionUpdate.status, 403)
  assert.equal((await payload(deniedExceptionUpdate)).code, 'OPERATIONS_MANAGE_REQUIRED')

  const invalidProduct = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'run-proof-order', proof: { ...proof, productGlobalId: 'gp1' } }),
  }))
  assert.equal(invalidProduct.status, 400)
  assert.equal((await payload(invalidProduct)).code, 'OPERATIONS_REQUEST_INVALID')

  const invalidContentType = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'run-proof-order', proof }),
  }))
  assert.equal(invalidContentType.status, 415)
  assert.equal((await payload(invalidContentType)).code, 'OPERATIONS_CONTENT_TYPE_INVALID')

  const noWorkspace = await route.GET(request('http://localhost/api/operations', {
    actor: { ...actor, organizationId: '' },
  }))
  assert.equal(noWorkspace.status, 409)
  assert.equal((await payload(noWorkspace)).code, 'ACTIVE_ORGANIZATION_REQUIRED')
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

async function seedWorkspace(pool, label) {
  const suffix = randomUUID().slice(0, 8)
  const email = `operations-${label}-${suffix}@example.com`
  await pool.query(
    `INSERT INTO app_users (email, role, status, display_name)
     VALUES ($1, 'owner', 'active', $2)`,
    [email, `Operations ${label}`],
  )
  const organization = await pool.query(
    `INSERT INTO workspace_organizations (name, organization_type, created_by, updated_by)
     VALUES ($1, 'root', $2, $2)
     RETURNING id::text, reference_code`,
    [`Operations ${label} ${suffix}`, email],
  )
  const organizationId = organization.rows[0].id
  await pool.query(
    `UPDATE app_users SET organization_id = $2::uuid, organization_name = $3 WHERE email = $1`,
    [email, organizationId, `Operations ${label} ${suffix}`],
  )
  const pipeline = await pool.query(
    `INSERT INTO pipeline_spaces (name, owner_email, is_default, workspace_organization_id)
     VALUES ($1, $2, true, $3::uuid)
     RETURNING id::text`,
    [`${label} pipeline`, email, organizationId],
  )
  const pipelineId = pipeline.rows[0].id
  const customer = await pool.query(
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, name, identity_key, workspace_organization_id,
       relationship_type, source_hash, created_by, updated_by
     ) VALUES ($1::uuid, $2, $3, $2, $4::uuid, 'customer', $2, $5, $5)
     RETURNING id::text, reference_code, name`,
    [pipelineId, `operations-${label}-customer-${suffix}`, `${label} Customer ${suffix}`, organizationId, email],
  )
  const product = await pool.query(
    `INSERT INTO crm_products (
       pipeline_id, source_key, name, sku, product_type, price, cost,
       currency, source_hash, created_by, updated_by
     ) VALUES ($1::uuid, $2, $3, $4, 'Good', 24.50, 9.25, 'USD', $2, $5, $5)
     RETURNING id::text, reference_code, name`,
    [pipelineId, `operations-${label}-product-${suffix}`, `${label} Product ${suffix}`, `OPS-${label}-${suffix}`, email],
  )
  return {
    email,
    organizationId,
    organizationGlobalId: organization.rows[0].reference_code,
    pipelineId,
    customer: customer.rows[0],
    product: product.rows[0],
  }
}

function proofInput(fixture, externalOrderId, overrides = {}) {
  const requested = new Date()
  requested.setUTCDate(requested.getUTCDate() + 10)
  return {
    customerGlobalId: fixture.customer.reference_code,
    productGlobalId: fixture.product.reference_code,
    externalOrderId,
    orderNumber: `ORDER-${externalOrderId.slice(-8)}`,
    quantity: 2,
    openingQuantity: 12,
    requestedDeliveryAt: requested.toISOString(),
    shipTo: {
      name: 'Receiving',
      line1: '200 Customer Lane',
      city: 'New York',
      region: 'NY',
      postalCode: '10001',
      country: 'US',
    },
    ...overrides,
  }
}

async function expectRejected(work, predicate, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, message)
  if (predicate) assert.ok(predicate(error), `${message}: ${String(error?.message || error)}`)
}

async function verifyPostgresAcceptance() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: String(process.env.PGSSLMODE || '').toLowerCase() === 'require' ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
    query_timeout: 20_000,
  })
  try {
    await pool.query('SELECT 1')
    const domain = loadTypeScriptModule('app_src/lib/operations/domain.ts')
    const adapters = loadTypeScriptModule('app_src/lib/operations/adapters.ts', {
      mocks: { '@/lib/operations/domain': domain },
    })
    const persistence = loadTypeScriptModule('app_src/lib/persistence/operations.ts', {
      mocks: {
        '@/lib/auditWriter': auditWriterMock(),
        '@/lib/operations/adapters': adapters,
        '@/lib/operations/domain': domain,
        '@/lib/persistence/postgres': postgresMock(pool),
      },
    })
    const primary = await seedWorkspace(pool, 'primary')
    const other = await seedWorkspace(pool, 'other')
    const externalOrderId = `mock-${randomUUID()}`
    const first = await persistence.runMockOperationsProofFromPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      proof: proofInput(primary, externalOrderId),
    })
    assert.match(first.orderGlobalId, /^gor\d{7}$/)
    assert.equal(first.orderStatus, 'shipped')
    assert.equal(first.duplicate, false)
    assert.match(first.trackingNumber, /^MOCK[A-F0-9]{18}$/)
    assert.equal(first.steps.length, 20)

    const baseline = await pool.query(
      `SELECT
         (SELECT count(*) FROM operations_orders WHERE organization_id = $1::uuid)::int AS orders,
         (SELECT count(*) FROM operations_order_lines WHERE organization_id = $1::uuid)::int AS lines,
         (SELECT count(*) FROM operations_reservations WHERE organization_id = $1::uuid)::int AS reservations,
         (SELECT count(*) FROM operations_shipments WHERE organization_id = $1::uuid)::int AS shipments,
         (SELECT count(*) FROM operations_billable_events WHERE organization_id = $1::uuid)::int AS billables,
         (SELECT count(*) FROM operations_domain_events WHERE organization_id = $1::uuid)::int AS events,
         (SELECT count(*) FROM sync_outbox WHERE aggregate_type = 'operations.order' AND aggregate_id = $2)::int AS outbox,
         (SELECT count(*) FROM audit_events WHERE organization_id = $1::uuid AND event_type = 'operations.proof_order.completed')::int AS audits`,
      [primary.organizationId, first.orderGlobalId],
    )
    assert.equal(baseline.rows[0].orders, 1)
    assert.equal(baseline.rows[0].lines, 1)
    assert.equal(baseline.rows[0].reservations, 1)
    assert.equal(baseline.rows[0].shipments, 1)
    assert.equal(baseline.rows[0].billables, 4)
    assert.ok(baseline.rows[0].events >= 14)
    assert.equal(baseline.rows[0].outbox, 1)
    assert.equal(baseline.rows[0].audits, 1)

    const duplicate = await persistence.runMockOperationsProofFromPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      proof: proofInput(primary, externalOrderId),
    })
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.orderGlobalId, first.orderGlobalId)
    assert.equal(duplicate.trackingNumber, first.trackingNumber)
    const afterRetry = await pool.query(
      `SELECT
         (SELECT count(*) FROM operations_orders WHERE organization_id = $1::uuid)::int AS orders,
         (SELECT count(*) FROM operations_shipments WHERE organization_id = $1::uuid)::int AS shipments,
         (SELECT count(*) FROM operations_billable_events WHERE organization_id = $1::uuid)::int AS billables,
         (SELECT count(*) FROM operations_domain_events WHERE organization_id = $1::uuid)::int AS events`,
      [primary.organizationId],
    )
    assert.deepEqual(afterRetry.rows[0], {
      orders: baseline.rows[0].orders,
      shipments: baseline.rows[0].shipments,
      billables: baseline.rows[0].billables,
      events: baseline.rows[0].events,
    })

    const inventory = await pool.query(
      `SELECT position.id::text, position.on_hand_quantity::text, position.reserved_quantity::text,
              pool.owner_customer_id::text,
              COALESCE(sum(ledger.on_hand_delta), 0)::text AS ledger_on_hand,
              COALESCE(sum(ledger.reserved_delta), 0)::text AS ledger_reserved,
              count(ledger.id)::int AS ledger_entries
       FROM operations_inventory_positions position
       JOIN operations_inventory_pools pool ON pool.organization_id = position.organization_id AND pool.id = position.pool_id
       LEFT JOIN operations_inventory_ledger ledger ON ledger.organization_id = position.organization_id AND ledger.position_id = position.id
       WHERE position.organization_id = $1::uuid
       GROUP BY position.id, pool.owner_customer_id`,
      [primary.organizationId],
    )
    assert.equal(inventory.rows.length, 1)
    assert.equal(inventory.rows[0].on_hand_quantity, '10.000000')
    assert.equal(inventory.rows[0].reserved_quantity, '0.000000')
    assert.equal(inventory.rows[0].ledger_on_hand, '10.000000')
    assert.equal(inventory.rows[0].ledger_reserved, '0.000000')
    assert.equal(inventory.rows[0].ledger_entries, 4)
    assert.equal(inventory.rows[0].owner_customer_id, primary.customer.id)

    const money = await pool.query(
      `SELECT plan.estimated_revenue_minor::text,
              sum(billable.amount_minor)::text AS billable_total,
              count(*)::int AS billable_count
       FROM operations_orders orders
       JOIN operations_fulfillment_plans plan ON plan.organization_id = orders.organization_id AND plan.order_id = orders.id
       JOIN operations_billable_events billable ON billable.organization_id = orders.organization_id AND billable.order_id = orders.id
       WHERE orders.organization_id = $1::uuid AND orders.global_id = $2
       GROUP BY plan.id`,
      [primary.organizationId, first.orderGlobalId],
    )
    assert.equal(money.rows[0].estimated_revenue_minor, money.rows[0].billable_total)
    assert.equal(money.rows[0].billable_total, '1335')
    assert.equal(money.rows[0].billable_count, 4)

    const workspace = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: primary.organizationId,
      capabilities: { canView: true, canManage: true, canExecute: true },
      selectedOrderGlobalId: first.orderGlobalId,
    })
    assert.equal(workspace.orders.length, 1)
    assert.equal(workspace.selectedOrder.globalId, first.orderGlobalId)
    assert.equal(workspace.selectedOrder.lines[0].reservedQuantity, 0)
    assert.equal(workspace.selectedOrder.packages[0].status, 'shipped')
    assert.equal(workspace.selectedOrder.rates.filter((rate) => rate.selected).length, 1)
    assert.equal(workspace.selectedOrder.billableEvents.length, 4)
    assert.equal(workspace.summary.openOrders, 0)
    assert.equal(workspace.summary.shippedToday, 1)
    assert.equal(workspace.summary.availableUnits, 10)
    assert.equal(workspace.summary.reservedUnits, 0)
    assert.equal(workspace.summary.unbilledMinor, '1335')

    const exceptionSeed = await pool.query(
      `INSERT INTO operations_exceptions (
         organization_id, order_id, exception_type, severity, title, details, assigned_to
       ) SELECT $1::uuid, orders.id, 'inventory_variance', 'high',
           'Verify reserved inventory', $3::jsonb, $4
         FROM operations_orders orders
        WHERE orders.organization_id = $1::uuid AND orders.global_id = $2
       RETURNING global_id`,
      [
        primary.organizationId,
        first.orderGlobalId,
        JSON.stringify({ recommendedAction: 'Reconcile the location count.', evidence: { expected: 12, observed: 10 } }),
        primary.email,
      ],
    )
    assert.match(exceptionSeed.rows[0].global_id, /^gex\d{7}$/)
    const exceptionWorkspace = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: primary.organizationId,
      capabilities: { canView: true, canManage: true, canExecute: true },
      exceptionStatus: 'open',
    })
    assert.equal(exceptionWorkspace.exceptions.length, 1)
    assert.equal(exceptionWorkspace.exceptions[0].orderGlobalId, first.orderGlobalId)
    assert.equal(exceptionWorkspace.exceptions[0].customerGlobalId, primary.customer.reference_code)
    assert.equal(exceptionWorkspace.exceptions[0].details.recommendedAction, 'Reconcile the location count.')
    assert.equal(exceptionWorkspace.summary.exceptions, 1)

    const acknowledged = await persistence.updateOperationsExceptionInPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      exceptionGlobalId: exceptionSeed.rows[0].global_id,
      status: 'acknowledged',
    })
    assert.equal(acknowledged.changed, true)
    assert.equal(acknowledged.exception.status, 'acknowledged')
    const acknowledgedAgain = await persistence.updateOperationsExceptionInPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      exceptionGlobalId: exceptionSeed.rows[0].global_id,
      status: 'acknowledged',
    })
    assert.equal(acknowledgedAgain.changed, false)
    const resolved = await persistence.updateOperationsExceptionInPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      exceptionGlobalId: exceptionSeed.rows[0].global_id,
      status: 'resolved',
    })
    assert.equal(resolved.exception.status, 'resolved')
    assert.ok(resolved.exception.resolvedAt)
    await expectRejected(
      () => persistence.updateOperationsExceptionInPostgres({
        organizationId: primary.organizationId,
        actorEmail: primary.email,
        exceptionGlobalId: exceptionSeed.rows[0].global_id,
        status: 'dismissed',
      }),
      (error) => error.code === 'OPERATIONS_EXCEPTION_TRANSITION_INVALID',
      'Resolved exceptions must be reopened before a new disposition',
    )
    const reopened = await persistence.updateOperationsExceptionInPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      exceptionGlobalId: exceptionSeed.rows[0].global_id,
      status: 'open',
    })
    assert.equal(reopened.exception.status, 'open')
    assert.equal(reopened.exception.resolvedAt, null)
    const exceptionEvidence = await pool.query(
      `SELECT
         (SELECT count(*) FROM operations_domain_events
          WHERE organization_id = $1::uuid AND aggregate_global_id = $2)::int AS domain_events,
         (SELECT count(*) FROM audit_events
          WHERE organization_id = $1::uuid AND aggregate_id = $2)::int AS audit_events`,
      [primary.organizationId, exceptionSeed.rows[0].global_id],
    )
    assert.deepEqual(exceptionEvidence.rows[0], { domain_events: 3, audit_events: 3 })

    await expectRejected(
      () => persistence.updateOperationsExceptionInPostgres({
        organizationId: other.organizationId,
        actorEmail: other.email,
        exceptionGlobalId: exceptionSeed.rows[0].global_id,
        status: 'acknowledged',
      }),
      (error) => error.code === 'OPERATIONS_EXCEPTION_NOT_FOUND',
      'Cross-workspace exception updates must fail',
    )

    const isolated = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: other.organizationId,
      capabilities: { canView: true, canManage: false, canExecute: false },
    })
    assert.equal(isolated.orders.length, 0)
    assert.equal(isolated.catalog.customers.length, 1)
    assert.equal(isolated.catalog.products.length, 1)
    assert.equal(JSON.stringify(isolated).includes(first.orderGlobalId), false)

    await expectRejected(
      () => persistence.runMockOperationsProofFromPostgres({
        organizationId: primary.organizationId,
        actorEmail: primary.email,
        proof: proofInput(primary, `wrong-tenant-${randomUUID()}`, {
          customerGlobalId: other.customer.reference_code,
        }),
      }),
      (error) => error.code === 'OPERATIONS_CUSTOMER_NOT_FOUND',
      'Cross-workspace customer lookup must fail',
    )

    const failedExternalOrderId = `infeasible-${randomUUID()}`
    await expectRejected(
      () => persistence.runMockOperationsProofFromPostgres({
        organizationId: primary.organizationId,
        actorEmail: primary.email,
        proof: proofInput(primary, failedExternalOrderId, { quantity: 1000, openingQuantity: 1 }),
      }),
      (error) => error.code === 'OPERATIONS_FULFILLMENT_INFEASIBLE',
      'Infeasible fulfillment must fail',
    )
    const rolledBack = await pool.query(
      `SELECT count(*)::int AS count FROM operations_orders
       WHERE organization_id = $1::uuid AND external_order_id = $2`,
      [primary.organizationId, failedExternalOrderId],
    )
    assert.equal(rolledBack.rows[0].count, 0, 'Failed order left partial state')

    await expectRejected(
      () => pool.query(
        `INSERT INTO operations_product_mappings (
           organization_id, integration_account_id, pipeline_id, product_id,
           channel_sku, external_product_id, created_by
         ) SELECT $1::uuid, integration.id, $2::uuid, $3::uuid, $4, $4, $5
           FROM operations_integration_accounts integration
          WHERE integration.organization_id = $1::uuid LIMIT 1`,
        [primary.organizationId, other.pipelineId, other.product.id, `INVALID-${randomUUID()}`, primary.email],
      ),
      (error) => error.code === '23503',
      'Cross-workspace product mapping must violate tenant foreign keys',
    )

    const ledgerId = await pool.query(
      `SELECT id::text FROM operations_inventory_ledger WHERE organization_id = $1::uuid LIMIT 1`,
      [primary.organizationId],
    )
    const eventId = await pool.query(
      `SELECT id::text FROM operations_domain_events WHERE organization_id = $1::uuid LIMIT 1`,
      [primary.organizationId],
    )
    const billableId = await pool.query(
      `SELECT id::text FROM operations_billable_events WHERE organization_id = $1::uuid LIMIT 1`,
      [primary.organizationId],
    )
    for (const [table, id] of [
      ['operations_inventory_ledger', ledgerId.rows[0].id],
      ['operations_domain_events', eventId.rows[0].id],
      ['operations_billable_events', billableId.rows[0].id],
    ]) {
      await expectRejected(
        () => pool.query(`UPDATE ${table} SET global_id = global_id WHERE id = $1::uuid`, [id]),
        (error) => error.code === 'P0001' && /append-only/.test(error.message),
        `${table} must reject updates`,
      )
      await expectRejected(
        () => pool.query(`DELETE FROM ${table} WHERE id = $1::uuid`, [id]),
        (error) => error.code === 'P0001' && /append-only/.test(error.message),
        `${table} must reject deletes`,
      )
    }
  } finally {
    await pool.end()
  }
}

async function main() {
  verifySourceContracts()
  await verifyRouteBehavior()
  if (!contractsOnly) await verifyPostgresAcceptance()
  console.log(`Distributed operations contracts passed${contractsOnly ? '' : ' with PostgreSQL acceptance'}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
