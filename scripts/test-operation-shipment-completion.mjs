#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { normalizeGlobalId } from '../app_src/lib/globalIds.mjs'

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
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES (
       $1, $2::uuid, 'owner', '{"manageOperations":true}'::jsonb,
       'active', true, $1, $1
     )`,
    [email, organizationId],
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
    // This helper intentionally rewrites an immutable packed fixture into two
    // packages. Replica mode keeps that setup isolated from both the legacy
    // write guard and the deferred native one-off package-set validator.
    await client.query('SET LOCAL session_replication_role = replica')
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

async function seedNativeOneOffCarrierGroup(
  pool,
  fixture,
  orderGlobalId,
  {
    state = 'succeeded',
    omitLastResult = false,
    mismatchedAllocation = false,
    wrongCarrier = false,
    wrongService = false,
    closed = false,
  } = {},
) {
  const context = await pool.query(
    `SELECT source_order.id::text AS order_id,
            plan.id::text AS plan_id,
            package.id::text AS package_id,
            package.global_id AS package_global_id,
            package.package_number,
            package.length_mm, package.width_mm, package.height_mm,
            package.weight_grams,
            rate.id::text AS carrier_rate_id,
            rate.carrier, rate.service_code
     FROM operations_orders source_order
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = source_order.organization_id
      AND plan.order_id = source_order.id
     JOIN operations_packages package
       ON package.organization_id = plan.organization_id
      AND package.plan_id = plan.id
     JOIN operations_carrier_rates rate
       ON rate.organization_id = plan.organization_id
      AND rate.plan_id = plan.id
      AND rate.selected = true
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
     ORDER BY package.package_number`,
    [fixture.organizationId, orderGlobalId],
  )
  assert.equal(context.rowCount, 2)
  const first = context.rows[0]
  const selectedAmountMinor = 1000
  const allocated = mismatchedAllocation ? [400, 500] : [400, 600]
  const client = await pool.connect()
  let seededAttemptId = null
  let seededAttemptGlobalId = null
  try {
    await client.query('BEGIN')
    // This isolated fixture does not call a carrier. The execution migration
    // has its own exact-authority/persistence acceptance; here we bypass only
    // fixture-construction triggers so shipment confirmation can be exercised
    // against complete and deliberately corrupt immutable group states.
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(
      `UPDATE operations_orders
       SET source_provider = 'clawpilot_native', order_type = 'one_off'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, first.order_id],
    )
    await client.query(
      `UPDATE operations_activation_scopes
       SET state = 'shadow', revision = revision + 1,
           reason = 'Focused native one-off TEST confirmation',
           updated_by = $2, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [fixture.organizationId, fixture.email],
    )
    const attempt = await client.query(
      `INSERT INTO operations_one_off_carrier_group_attempts (
         organization_id, order_id, plan_id,
         planning_quote_id, planning_offer_id,
         purchase_quote_id, purchase_offer_id, carrier_rate_id,
         integration_account_id, carrier_account_id, create_attempt_id,
         action, state, environment, provider, service_code,
         package_count, selected_amount_minor, currency,
         adapter_version, idempotency_key, request_hash,
         redacted_request, redacted_response,
         master_tracking_number, provider_shipment_id, provider_reference,
         error_code, reason, actor_email, completed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid,
         $9::uuid, $10::uuid, NULL,
         'create', $11, 'sandbox', 'ups_rest', $12,
         2, $13, 'USD',
         'focused-one-off-confirmation-v1', $14, $15,
         $16::jsonb, $17::jsonb,
         $18, $19, $19,
         $20, 'Focused native one-off TEST carrier group', $21,
         CASE WHEN $11 = 'prepared' THEN NULL ELSE now() END
       )
       RETURNING id::text, global_id`,
      [
        fixture.organizationId,
        first.order_id,
        first.plan_id,
        randomUUID(), randomUUID(), randomUUID(), randomUUID(),
        first.carrier_rate_id,
        randomUUID(), randomUUID(),
        state,
        first.service_code,
        selectedAmountMinor,
        `native-confirm-${randomUUID()}`,
        'a'.repeat(64),
        JSON.stringify({ focusedAcceptance: true }),
        JSON.stringify({ focusedAcceptance: true, state }),
        state === 'succeeded' ? '1ZFOCUSEDMASTER000' : null,
        state === 'succeeded' ? `focused-provider-${randomUUID()}` : null,
        state === 'failed' || state === 'unknown'
          ? `FOCUSED_${state.toUpperCase()}`
          : null,
        fixture.email,
      ],
    )
    const attemptId = attempt.rows[0].id
    seededAttemptId = attemptId
    seededAttemptGlobalId = attempt.rows[0].global_id
    for (const [index, packageRow] of context.rows.entries()) {
      const member = await client.query(
        `INSERT INTO operations_one_off_carrier_group_members (
           organization_id, carrier_group_attempt_id, order_id, plan_id,
           package_id, package_number, quote_package_key,
           length_mm, width_mm, height_mm, weight_grams,
           allocated_selected_cost_minor, parcel_snapshot_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           $5::uuid, $6, $7, $8, $9, $10, $11, $12, $13
         ) RETURNING id::text`,
        [
          fixture.organizationId, attemptId, first.order_id, first.plan_id,
          packageRow.package_id, packageRow.package_number,
          `focused-package-${packageRow.package_number}`,
          packageRow.length_mm, packageRow.width_mm, packageRow.height_mm,
          packageRow.weight_grams, allocated[index], String(index + 1).repeat(64),
        ],
      )
      assert.equal(member.rowCount, 1)
      const trackingNumber = `TESTGROUP${index + 1}${randomUUID()
        .replaceAll('-', '').slice(0, 15).toUpperCase()}`
      const providerPackageReference = `focused-package-result-${randomUUID()}`
      const label = await client.query(
        `INSERT INTO operations_labels (
           organization_id, package_id, carrier_rate_id,
           carrier, service_code, tracking_number, format, label_payload,
           provider_label_id, idempotency_key, status, environment,
           redacted_provider_evidence, one_off_carrier_group_attempt_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
           'PDF', $7, $8, $9, 'created', 'sandbox', $10::jsonb, $11::uuid
         ) RETURNING id::text, global_id`,
        [
          fixture.organizationId, packageRow.package_id,
          first.carrier_rate_id,
          wrongCarrier ? 'FedEx' : 'UPS',
          wrongService ? `${first.service_code}-wrong` : first.service_code,
          trackingNumber,
          Buffer.from(`%PDF-1.4 native one-off ${index + 1}`).toString('base64'),
          providerPackageReference,
          `native-one-off-label-${randomUUID()}`,
          JSON.stringify({ focusedAcceptance: true, package: index + 1 }),
          attemptId,
        ],
      )
      await client.query(
        `UPDATE operations_packages SET status = 'labeled'
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [fixture.organizationId, packageRow.package_id],
      )
      if (!(omitLastResult && index === context.rows.length - 1)) {
        await client.query(
          `INSERT INTO operations_one_off_carrier_group_results (
             organization_id, carrier_group_attempt_id, package_id,
             package_number, label_id, tracking_number,
             provider_package_reference, redacted_provider_evidence
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::jsonb
           )`,
          [
            fixture.organizationId, attemptId, packageRow.package_id,
            packageRow.package_number, label.rows[0].id, trackingNumber,
            providerPackageReference,
            JSON.stringify({ focusedAcceptance: true }),
          ],
        )
      }
    }
    if (closed) {
      await client.query(
        `INSERT INTO operations_one_off_carrier_group_attempts (
           organization_id, order_id, plan_id,
           planning_quote_id, planning_offer_id,
           purchase_quote_id, purchase_offer_id, carrier_rate_id,
           integration_account_id, carrier_account_id, create_attempt_id,
           action, state, environment, provider, service_code,
           package_count, selected_amount_minor, currency,
           adapter_version, idempotency_key, request_hash,
           redacted_request, redacted_response,
           master_tracking_number, provider_shipment_id, provider_reference,
           error_code, reason, actor_email, completed_at
         )
         SELECT organization_id, order_id, plan_id,
                planning_quote_id, planning_offer_id,
                purchase_quote_id, purchase_offer_id, carrier_rate_id,
                integration_account_id, carrier_account_id, id,
                'void', 'succeeded', environment, provider, service_code,
                package_count, selected_amount_minor, currency,
                adapter_version, $3, $4, $5::jsonb, $6::jsonb,
                master_tracking_number, provider_shipment_id,
                provider_shipment_id, NULL,
                'Focused whole-group void', $7, now()
         FROM operations_one_off_carrier_group_attempts
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [
          fixture.organizationId, attemptId, `native-void-${randomUUID()}`,
          'b'.repeat(64), JSON.stringify({ focusedVoid: true }),
          JSON.stringify({ focusedVoid: true }), fixture.email,
        ],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  await pool.query(
    // Keep the confirmation fixture exact-mode aware without fabricating a
    // real carrier quote. This disposable database is destroyed after the run.
    `CREATE OR REPLACE FUNCTION operations_one_off_plan_execution_is_exact(
       authority_organization_id uuid,
       authority_plan_id uuid,
       required_execution_mode text DEFAULT NULL
     ) RETURNS boolean LANGUAGE sql STABLE AS $$
       SELECT EXISTS (
         SELECT 1
         FROM operations_one_off_carrier_group_attempts attempt
         WHERE attempt.organization_id = authority_organization_id
           AND attempt.plan_id = authority_plan_id
           AND attempt.action = 'create'
           AND (
             required_execution_mode IS NULL
             OR (required_execution_mode = 'test' AND attempt.environment = 'sandbox')
             OR (required_execution_mode = 'live' AND attempt.environment = 'production')
           )
       )
     $$`,
  )
  return {
    groupAttemptId: seededAttemptId,
    groupAttemptGlobalId: seededAttemptGlobalId,
    selectedAmountMinor,
  }
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
    class FocusedProviderWriteControlError extends Error {
      constructor(code, message, status = 409) {
        super(message)
        this.name = 'CommerceProviderWriteControlError'
        this.code = code
        this.status = status
      }
    }
    let focusedProviderWritesOn = true
    let focusedProviderWriteChecks = 0
    let focusedProviderWriteOffRejections = 0
    let focusedProviderCredentialGenerationOverride = null
    let focusedProviderWriteControlRowVersion = 1
    const focusedProviderWriteGrantedScopes = {
      shopify: [
        'read_orders',
        'write_merchant_managed_fulfillment_orders',
      ],
      faire: [
        'READ_BRAND',
        'READ_ORDERS',
        'READ_SHIPMENTS',
        'WRITE_ORDERS',
      ],
    }
    const focusedProviderWriteScopeDigest = Object.fromEntries(
      Object.entries(focusedProviderWriteGrantedScopes).map(
        ([provider, scopes]) => [
          provider,
          createHash('sha256').update([...scopes].sort().join('\n')).digest('hex'),
        ],
      ),
    )
    const commerceProviderWrites = {
      CommerceProviderWriteControlError: FocusedProviderWriteControlError,
      readCommerceProviderWriteControlsFromPostgres: async ({
        organizationId,
      }) => {
        const accounts = await pool.query(
          `SELECT global_id, display_name, provider, environment
           FROM operations_integration_accounts
           WHERE organization_id = $1::uuid
             AND provider IN ('shopify', 'faire')`,
          [organizationId],
        )
        return {
          organizationId,
          accounts: accounts.rows.map((account) => ({
            accountGlobalId: account.global_id,
            accountDisplayName: account.display_name,
            provider: account.provider,
            environment: account.environment,
            providerWritesEffective: focusedProviderWritesOn,
            fulfillmentWritesEffective: focusedProviderWritesOn,
            fulfillmentWritesBlockedReason: focusedProviderWritesOn
              ? null
              : 'Turn Provider writes On before confirming shipment.',
          })),
        }
      },
      requireCurrentCommerceProviderWritesInPostgres: async (input) => {
        focusedProviderWriteChecks += 1
        if (!focusedProviderWritesOn) {
          focusedProviderWriteOffRejections += 1
          throw new FocusedProviderWriteControlError(
            'COMMERCE_PROVIDER_WRITES_OFF',
            'Provider writes is Off for the exact connected account',
            403,
          )
        }
        const account = await pool.query(
          `SELECT provider, environment, commerce_credential_generation
           FROM operations_integration_accounts
           WHERE organization_id = $1::uuid
             AND global_id = $2`,
          [input.organizationId, input.accountGlobalId],
        )
        assert.equal(account.rowCount, 1)
        assert.equal(account.rows[0].provider, input.provider)
        const storedCredentialGeneration = Number(
          account.rows[0].commerce_credential_generation,
        )
        const credentialGeneration =
          focusedProviderCredentialGenerationOverride
          ?? (storedCredentialGeneration > 0
            ? storedCredentialGeneration
            : input.provider === 'faire' ? 2 : 1)
        if (
          input.expectedControlRowVersion !== undefined
          && Number(input.expectedControlRowVersion)
            !== focusedProviderWriteControlRowVersion
        ) {
          throw new FocusedProviderWriteControlError(
            'COMMERCE_PROVIDER_WRITES_AUTHORITY_CHANGED',
            'Provider writes control changed after shipment authorization',
          )
        }
        if (
          input.expectedCredentialGeneration !== undefined
          && Number(input.expectedCredentialGeneration)
            !== credentialGeneration
        ) {
          throw new FocusedProviderWriteControlError(
            'COMMERCE_PROVIDER_WRITES_AUTHORITY_CHANGED',
            'Provider writes credential changed after shipment authorization',
          )
        }
        if (
          input.expectedGrantedScopeDigest !== undefined
          && input.expectedGrantedScopeDigest
            !== focusedProviderWriteScopeDigest[input.provider]
        ) {
          throw new FocusedProviderWriteControlError(
            'COMMERCE_PROVIDER_WRITES_AUTHORITY_CHANGED',
            'Provider writes scopes changed after shipment authorization',
          )
        }
        return {
          accountGlobalId: input.accountGlobalId,
          provider: input.provider,
          environment: account.rows[0].environment,
          controlRowVersion: focusedProviderWriteControlRowVersion,
          credentialGeneration,
          grantedScopes: [...focusedProviderWriteGrantedScopes[input.provider]],
          grantedScopeDigest: focusedProviderWriteScopeDigest[input.provider],
        }
      },
      requireSealedCommerceProviderWritesInPostgres: async (input) => {
        const contract = input.provider === 'shopify'
          ? {
              action: 'shopify.fulfillment.create',
              adapterVersion: 'shopify-fulfillment-writeback-v2',
            }
          : {
              action: 'faire.fulfillment.shipments.create',
              adapterVersion: 'faire-fulfillment-writeback-v2',
            }
        const sealedAuthority = {
          accountGlobalId: input.accountGlobalId,
          provider: input.provider,
          environment: input.environment,
          controlRowVersion: input.expectedControlRowVersion,
          credentialGeneration: input.expectedCredentialGeneration,
          grantedScopeDigest: input.expectedGrantedScopeDigest,
        }
        const providerAttempt = await pool.query(
          `SELECT attempt.global_id
           FROM operations_commerce_provider_attempts attempt
           JOIN operations_integration_accounts account
             ON account.organization_id = attempt.organization_id
            AND account.id = attempt.integration_account_id
           JOIN operations_commerce_fulfillment_exports export
             ON export.organization_id = attempt.organization_id
            AND export.global_id = attempt.external_object_id
            AND export.provider = account.provider
           WHERE attempt.organization_id = $1::uuid
             AND attempt.global_id = $2
             AND account.global_id = $3
             AND account.provider = $4
             AND account.environment = $5
             AND attempt.action = $6
             AND attempt.adapter_version = $7
             AND attempt.external_object_id = $8
             AND attempt.state = 'prepared'
             AND attempt.request_hash = $9
             AND attempt.redacted_request->'providerWriteAuthority'
               = $10::jsonb`,
          [
            input.organizationId,
            input.providerAttemptGlobalId,
            input.accountGlobalId,
            input.provider,
            input.environment,
            contract.action,
            contract.adapterVersion,
            input.commerceExportGlobalId,
            input.providerAttemptRequestHash,
            JSON.stringify(sealedAuthority),
          ],
        )
        assert.equal(
          providerAttempt.rowCount,
          1,
          'provider execution must present its exact durable prepared attempt',
        )
        const requestedMode = focusedProviderWritesOn
        focusedProviderWritesOn = true
        try {
          const authority = await commerceProviderWrites
            .requireCurrentCommerceProviderWritesInPostgres(input)
          assert.equal(authority.environment, input.environment)
          return authority
        } finally {
          focusedProviderWritesOn = requestedMode
        }
      },
    }
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
    const shopifyTestStoreConstants = loadTypeScriptModule(
      'app_src/lib/operations/shopifyTestStoreCanonicalE2e.ts',
    )
    const shopifyTestStorePersistence = loadTypeScriptModule(
      'app_src/lib/persistence/shopifyTestStoreCanonicalE2e.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/integrations/shopifyOrderManagementRuntime': {
            shopifyOrderManagementAccountAllowed: () => true,
          },
          '@/lib/operations/shopifyTestStoreCanonicalE2e':
            shopifyTestStoreConstants,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
    const sandboxAuthorization = loadTypeScriptModule(
      'app_src/lib/persistence/sandboxCommerceE2eAuthorization.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/operations/sandboxCommerceE2e': sandboxCommerceE2e,
          '@/lib/persistence/shopifyTestStoreCanonicalE2e':
            shopifyTestStorePersistence,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
    const domain = loadTypeScriptModule('app_src/lib/operations/domain.ts')
    const pickManagement = loadTypeScriptModule(
      'app_src/lib/operations/pickManagement.ts',
    )
    const commerceFulfillmentRecoveryPolicy = loadTypeScriptModule(
      'app_src/lib/commerceFulfillmentRecoveryPolicy.ts',
    )
    const adapters = loadTypeScriptModule('app_src/lib/operations/adapters.ts', {
      mocks: { '@/lib/operations/domain': domain },
    })
    const stableId = loadTypeScriptModule('app_src/lib/crm/stableId.ts')
    const packingSlip = loadTypeScriptModule('app_src/lib/operations/packingSlip.ts')
    const barcodeLabels = loadTypeScriptModule(
      'app_src/lib/operations/barcodeLabels.ts',
      { mocks: { '@/lib/globalIds.mjs': { normalizeGlobalId } } },
    )
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
    const shopifyCheckoutAudiencePolicy = loadTypeScriptModule(
      'app_src/lib/operations/shopifyCheckoutAudiencePolicy.ts',
    )
    const shopifyCheckoutRateControl = loadTypeScriptModule(
      'app_src/lib/operations/shopifyCheckoutRateControl.ts',
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
          '@/lib/operations/shopifyCheckoutAudiencePolicy':
            shopifyCheckoutAudiencePolicy,
          '@/lib/operations/shopifyCheckoutRateControl':
            shopifyCheckoutRateControl,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
    let shopifyFulfillmentPreparationCalls = 0
    let shopifyFulfillmentPreparationHook = null
    const shopifyFulfillmentInputs = []
    let shopifyFulfillmentExecutionCalls = 0
    let turnProviderWritesOffBeforeShopifyExecution = false
    let shopifyFulfillmentReconciliationCalls = 0
    let shopifyFulfillmentReconciliationResult = null
    let useExactAuthorityShopifyWriteback = false
    let exactProviderExpectedLineItems = []
    let exactProviderExternalOrderId = null
    let exactProviderMutationCalls = 0
    let exactProviderReadCalls = 0
    const exactAuthorityShopifyWriteback = loadTypeScriptModule(
      'app_src/lib/integrations/shopifyFulfillmentWriteback.ts',
      {
        mocks: {
          '@/lib/integrations/commerceCredentialCrypto': {
            normalizeCommerceOrganizationId: String,
            normalizeCommerceAccountGlobalId: String,
            decryptCommerceCredential: () => ({
              provider: 'shopify',
              clientId: 'focused-client-id',
              clientSecret: 'focused-client-secret',
            }),
          },
          '@/lib/integrations/commerceCapabilities': {
            hasEffectiveShopifyScope: (scopes, scope) => scopes.includes(scope),
          },
          '@/lib/integrations/shopifyCommerceClient': {
            normalizeShopifyShopDomain: String,
            requestShopifyAccessToken: async () => ({
              accessToken: 'focused-access-token',
              grantedScopes: [
                'read_orders',
                'write_merchant_managed_fulfillment_orders',
              ],
            }),
            probeShopifyConnection: async () => ({
              shopId: 'gid://shopify/Shop/6567',
              grantedScopes: [
                'read_orders',
                'write_merchant_managed_fulfillment_orders',
              ],
            }),
            shopifyAdminGraphql: async (_credential, request) => {
              if (request.operationName === 'ClawPilotOrderFulfillment') {
                exactProviderReadCalls += 1
                return {
                  order: {
                    id: exactProviderExternalOrderId,
                    canNotifyCustomer: true,
                    fulfillmentsCount: { count: 0 },
                    fulfillments: [],
                    fulfillmentOrders: {
                      nodes: [{
                        id: 'gid://shopify/FulfillmentOrder/6567',
                        status: 'OPEN',
                        requestStatus: 'UNSUBMITTED',
                        assignedLocation: {
                          location: { id: 'gid://shopify/Location/6567' },
                        },
                        lineItems: {
                          nodes: exactProviderExpectedLineItems.map(
                            (line, index) => ({
                              id: `gid://shopify/FulfillmentOrderLineItem/${6567 + index}`,
                              lineItem: { id: line.lineItemId },
                              remainingQuantity: line.quantity,
                            }),
                          ),
                          pageInfo: { hasNextPage: false },
                        },
                      }],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                }
              }
              exactProviderMutationCalls += 1
              return {
                fulfillmentCreate: {
                  fulfillment: {
                    id: 'gid://shopify/Fulfillment/6567',
                    status: 'SUCCESS',
                  },
                  userErrors: [],
                },
              }
            },
          },
          '@/lib/integrations/shopifyReversalFixtureRuntime': {
            SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN:
              'test-pro-bakery-bites.myshopify.com',
          },
          '@/lib/persistence/commerceIntegrations': {
            readCommerceRuntimeCredentialFromPostgres: async (input) => ({
              organizationId: input.organizationId,
              globalId: input.accountGlobalId,
              provider: 'shopify',
              environment: 'sandbox',
              externalAccountId: 'gid://shopify/Shop/6567',
              status: 'active',
              verificationStatus: 'verified',
              credentialVersion: 1,
              configuration: {
                shopDomain: 'focused-shipment.myshopify.com',
              },
              encrypted: {},
            }),
          },
          '@/lib/persistence/commerceProviderWrites': commerceProviderWrites,
          '@/lib/persistence/shopifyReversalFixture': {
            assertShopifyReversalFixtureFulfillmentClaimCurrentInPostgres:
              async () => {
                throw new Error(
                  'Shipment completion acceptance does not use the hidden reversal fixture',
                )
              },
          },
          '@/lib/persistence/shopifyTestStoreCanonicalE2e':
            shopifyTestStorePersistence,
          '@/lib/persistence/sandboxCommerceE2eAuthorization':
            sandboxAuthorization,
        },
      },
    )
    let faireFulfillmentPreparationCalls = 0
    let faireFulfillmentAuthorizationRevision = 4
    let faireFulfillmentExecutionCalls = 0
    const faireFulfillmentInputs = []
    const orderShipTo = loadTypeScriptModule(
      'app_src/lib/operations/orderShipTo.ts',
    )
    const carrierSandboxRate = loadTypeScriptModule(
      'app_src/lib/integrations/carrierSandboxRate.ts',
      {
        mocks: {
          '@/lib/integrations/carrierCredentialClient': {
            CarrierCredentialClientError: class extends Error {},
            requestCarrierAccessToken() {
              throw new Error('Shipment completion does not request carrier credentials')
            },
          },
          '@/lib/integrations/carrierWholeShipmentRateFoundation': {
            FEDEX_WHOLE_SHIPMENT_PACKAGING_TYPES: {},
            UPS_WHOLE_SHIPMENT_PACKAGING_TYPES: {},
          },
        },
      },
    )
    const operationsOrderShipmentAddress = loadTypeScriptModule(
      'app_src/lib/persistence/operationsOrderShipmentAddress.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/integrations/commerceCredentialCrypto': {
            decryptCommerceCandidateSnapshot: () => {
              throw new Error('No local shipment-address copy is expected')
            },
            encryptCommerceCandidateSnapshot: () => {
              throw new Error('Shipment completion does not edit addresses')
            },
          },
          '@/lib/integrations/carrierSandboxRate': carrierSandboxRate,
          '@/lib/operations/orderShipTo': orderShipTo,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
    const persistence = loadTypeScriptModule('app_src/lib/persistence/operations.ts', {
      mocks: {
        '@/lib/auditWriter': auditWriter,
        '@/lib/crm/stableId': stableId,
        '@/lib/persistence/commerceOrderRevisions': {
          async assertCommerceOrderRevisionExecutionCurrent() {},
          CommerceOrderRevisionGateError: class extends Error {},
        },
        '@/lib/persistence/commerceStoreSync': {
          readCommerceStoreSyncControlsFromPostgres: async () => [],
        },
        '@/lib/persistence/commerceOrderWorkbench': {
          readCommerceOrderWorkbenchFromPostgres: async () => [],
        },
        '@/lib/persistence/orderUnitWeightEvidence': {
          assertCurrentOrderUnitWeightEvidence: async () => {},
        },
        '@/lib/persistence/commerceProviderWrites': commerceProviderWrites,
        '@/lib/operations/orderShipTo': orderShipTo,
        '@/lib/persistence/operationsOrderShipmentAddress':
          operationsOrderShipmentAddress,
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
          shopifyFulfillmentAttemptSignatureHashCandidates:
            exactAuthorityShopifyWriteback
              .shopifyFulfillmentAttemptSignatureHashCandidates,
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
            if (useExactAuthorityShopifyWriteback) {
              exactProviderExpectedLineItems = lineItems
              exactProviderExternalOrderId = input.externalOrderId
              return exactAuthorityShopifyWriteback
                .prepareShopifyFulfillmentWriteback(input)
            }
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
                sandboxE2eAuthorityKind:
                  input.sandboxE2eAuthorityKind ?? null,
              },
              existing: null,
            }
          },
          executeShopifyFulfillmentWriteback: async (input) => {
            shopifyFulfillmentExecutionCalls += 1
            if (turnProviderWritesOffBeforeShopifyExecution) {
              focusedProviderWritesOn = false
              turnProviderWritesOffBeforeShopifyExecution = false
            }
            if (useExactAuthorityShopifyWriteback) {
              return exactAuthorityShopifyWriteback
                .executeShopifyFulfillmentWriteback(input)
            }
            return {
              providerReference: 'shopify-focused-fulfillment-reference',
            }
          },
          reconcileShopifyFulfillmentWriteback: async () => {
            shopifyFulfillmentReconciliationCalls += 1
            return shopifyFulfillmentReconciliationResult
          },
        },
        '@/lib/integrations/shopifyOrderPlanningAuthority': {
          ShopifyOrderPlanningAuthorityError: class extends Error {},
          assertShopifyOrderPlanningAuthorityHash: (value) => value,
          normalizeShopifyOrderPlanningAuthoritySnapshot: (value) => value,
          shopifyOrderPlanningAuthorityHash: () => {
            throw new Error(
              'Shipment completion acceptance does not hash Shopify planning authority',
            )
          },
          inspectShopifyOrderPlanningAuthority: async () => {
            throw new Error(
              'Shipment completion acceptance does not read Shopify planning authority',
            )
          },
        },
        '@/lib/integrations/shopifyExternalFulfillmentReconciliation': {
          ShopifyExternalFulfillmentReconciliationError: class extends Error {
            constructor(code, message, status = 409, retryable = false) {
              super(message)
              this.name = 'ShopifyExternalFulfillmentReconciliationError'
              this.code = code
              this.status = status
              this.retryable = retryable
            }
          },
          inspectShopifyExternalFulfillment: async () => {
            throw new Error(
              'Shipment completion acceptance does not read Shopify external fulfillment',
            )
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
        '@/lib/operations/pickManagement': pickManagement,
        '@/lib/operations/barcodeLabels': barcodeLabels,
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
        '@/lib/persistence/operationShadowTraining': {
          assertNoOpenOperationsShadowTrainingRunsForActivation:
            async () => {},
        },
        '@/lib/persistence/sandboxCommerceE2eAuthorization': sandboxAuthorization,
        '@/lib/persistence/shopifyTestStoreCanonicalE2e':
          shopifyTestStorePersistence,
        '@/lib/persistence/postgres': postgres,
        '@/lib/persistence/productPackaging': productPackaging,
        '@/lib/persistence/shopifyCheckoutRating': shopifyCheckoutRating,
      },
    })
    let carrierLabelProviderCalls = 0
    let carrierLabelEvidenceCalls = 0
    let carrierLabelPrintCalls = 0
    class FocusedCarrierIntegrationRequestError extends Error {
      constructor(message, status = 409, code = 'CARRIER_INTEGRATION_INVALID') {
        super(message)
        this.status = status
        this.code = code
      }
    }
    class FocusedCarrierSandboxLabelError extends Error {
      constructor(
        message,
        status = 409,
        code = 'CARRIER_SANDBOX_LABEL_INVALID',
        uncertain = false,
        redactedResponse = null,
      ) {
        super(message)
        this.status = status
        this.code = code
        this.uncertain = uncertain
        this.redactedResponse = redactedResponse
      }
    }
    const shippingPersistence = loadTypeScriptModule(
      'app_src/lib/persistence/operationShipping.ts',
      {
        mocks: {
          '@/lib/auditWriter': auditWriter,
          '@/lib/operations/orderShipTo': orderShipTo,
          '@/lib/persistence/operationsOrderShipmentAddress':
            operationsOrderShipmentAddress,
          '@/lib/integrations/carrierIntegrations': {
            CarrierIntegrationRequestError:
              FocusedCarrierIntegrationRequestError,
            resolveCarrierSandboxShippingRuntime: async (input) => {
              const runtime = await pool.query(
                `SELECT integration.id::text AS integration_account_id,
                        integration.global_id AS integration_global_id,
                        carrier_account.id::text AS carrier_account_id,
                        carrier_account.global_id AS carrier_account_global_id,
                        carrier_account.display_name,
                        carrier_account.account_number_last_four
                 FROM operations_integration_accounts integration
                 JOIN operations_carrier_accounts carrier_account
                   ON carrier_account.organization_id = integration.organization_id
                  AND carrier_account.integration_account_id = integration.id
                 WHERE integration.organization_id = $1::uuid
                   AND integration.provider = $2
                   AND integration.integration_type = 'carrier'
                   AND integration.environment = 'sandbox'
                   AND integration.status = 'active'
                   AND carrier_account.status = 'active'
                   AND ($3::text IS NULL OR carrier_account.global_id = $3)
                 LIMIT 2`,
                [
                  input.organizationId,
                  input.provider,
                  input.carrierAccountGlobalId || null,
                ],
              )
              assert.equal(
                runtime.rowCount,
                1,
                'Focused carrier runtime must resolve exactly one account',
              )
              const row = runtime.rows[0]
              return {
                organizationId: input.organizationId,
                provider: input.provider,
                integrationAccountId: row.integration_account_id,
                integrationGlobalId: row.integration_global_id,
                carrierAccountId: row.carrier_account_id,
                carrierAccountGlobalId: row.carrier_account_global_id,
                carrierAccountDisplayName: row.display_name,
                accountNumberLastFour: row.account_number_last_four,
                credentialVersion: 1,
                billingRelationship: 'shipper',
                billingSelectionSnapshot: { relationship: 'shipper' },
              }
            },
          },
          '@/lib/integrations/carrierSandboxLabel': {
            CARRIER_SANDBOX_LABEL_ADAPTER_VERSION:
              'focused-legacy-read-only-guard-v1',
            CarrierSandboxLabelError: FocusedCarrierSandboxLabelError,
            carrierSandboxLabelRequestEvidence: () => {
              carrierLabelEvidenceCalls += 1
              return {
                requestHash: 'a'.repeat(64),
                redactedRequest: { focusedAcceptance: true },
              }
            },
            carrierSandboxVoidRequestEvidence: () => ({
              requestHash: 'b'.repeat(64),
              redactedRequest: { focusedAcceptance: true },
            }),
            createCarrierSandboxLabel: async () => {
              carrierLabelProviderCalls += 1
              return {
                trackingNumber:
                  `FOCUSED${randomUUID().replaceAll('-', '').slice(0, 18)}`,
                format: 'PDF',
                labelPayload: Buffer.from(
                  '%PDF-1.4 focused legacy Active label',
                ).toString('base64'),
                providerLabelId: `focused-provider-${randomUUID()}`,
                evidence: {
                  redactedRequest: { focusedAcceptance: true },
                  redactedResponse: { focusedAcceptance: true },
                  providerReference: `focused-provider-${randomUUID()}`,
                },
              }
            },
            voidCarrierSandboxLabel: async () => {
              carrierLabelProviderCalls += 1
              throw new Error(
                'Legacy Read only authority reached the carrier provider',
              )
            },
          },
          '@/lib/integrations/carrierSandboxRate': {
            CARRIER_SANDBOX_RATE_FIXTURE: {
              origin: {},
              destination: {},
            },
          },
          '@/lib/persistence/commerceOrderRevisions': {
            async assertCommerceOrderRevisionExecutionCurrent() {},
            CommerceOrderRevisionGateError: class extends Error {},
          },
          '@/lib/persistence/operationPrintDelivery': {
            enqueueOperationsPrintJobInPostgres: async () => {
              carrierLabelPrintCalls += 1
              return { globalId: 'gpj0000001' }
            },
          },
          '@/lib/persistence/operations': {
            OperationsRequestError: persistence.OperationsRequestError,
          },
          '@/lib/persistence/sandboxCommerceE2eAuthorization':
            sandboxAuthorization,
          '@/lib/persistence/shopifyTestStoreCanonicalE2e':
            shopifyTestStorePersistence,
          '@/lib/persistence/postgres': postgres,
        },
      },
    )
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
    assert.equal(
      typeof shippingPersistence.createOperationsSandboxLabelInPostgres,
      'function',
      'createOperationsSandboxLabelInPostgres must be exported',
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

    const seedFocusedShopifyProviderWriteAuthority = async ({
      organizationId,
      integrationAccountId,
      externalAccountId,
      shopDomain,
      actorEmail,
    }) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `UPDATE operations_integration_accounts
           SET provider = 'shopify', integration_type = 'commerce',
               status = 'active', external_account_id = $3,
               commerce_credential_generation = 1,
               configuration = configuration || jsonb_build_object(
                 'shopDomain', $4::text,
                 'grantedScopes', $5::jsonb
               ),
               updated_by = $6, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [
            organizationId,
            integrationAccountId,
            externalAccountId,
            shopDomain,
            JSON.stringify(focusedProviderWriteGrantedScopes.shopify),
            actorEmail,
          ],
        )
        await client.query(
          `INSERT INTO operations_commerce_credentials (
             organization_id, integration_account_id, external_account_id,
             auth_mode, credential_ciphertext, credential_iv, credential_tag,
             credential_version, credential_identifier_last_four,
             verification_status, verified_at, webhook_verification_status,
             created_by, updated_by
           ) VALUES (
             $1::uuid, $2::uuid, $3, 'shopify_client_credentials',
             decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
             decode(repeat('00', 16), 'hex'), 1, '0001', 'verified', now(),
             'unverified', $4, $4
           )
           ON CONFLICT (organization_id, integration_account_id) DO UPDATE
           SET external_account_id = EXCLUDED.external_account_id,
               auth_mode = EXCLUDED.auth_mode,
               credential_ciphertext = EXCLUDED.credential_ciphertext,
               credential_iv = EXCLUDED.credential_iv,
               credential_tag = EXCLUDED.credential_tag,
               credential_version = EXCLUDED.credential_version,
               credential_identifier_last_four =
                 EXCLUDED.credential_identifier_last_four,
               verification_status = EXCLUDED.verification_status,
               verified_at = EXCLUDED.verified_at,
               last_error_code = NULL,
               webhook_verification_status =
                 EXCLUDED.webhook_verification_status,
               webhook_verified_at = NULL,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
          [organizationId, integrationAccountId, externalAccountId, actorEmail],
        )
        await client.query('SET LOCAL session_replication_role = origin')
        await client.query(
          `INSERT INTO operations_commerce_provider_write_controls (
             organization_id, integration_account_id, provider, row_version,
             expected_row_version, requested_mode,
             bound_credential_generation, bound_granted_scopes,
             bound_granted_scope_digest, changed_by, changed_role,
             idempotency_key, request_hash
           ) VALUES (
             $1::uuid, $2::uuid, 'shopify', $3::bigint,
             ($3::bigint - 1), 'on', 1, $4::text[], $5, $6, 'owner',
             $7, repeat('c', 64)
           )`,
          [
            organizationId,
            integrationAccountId,
            focusedProviderWriteControlRowVersion,
            focusedProviderWriteGrantedScopes.shopify,
            focusedProviderWriteScopeDigest.shopify,
            actorEmail,
            `focused-shopify-provider-writes-${randomUUID()}`,
          ],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }

    const seedFocusedFaireProviderWriteAuthority = async ({
      organizationId,
      integrationAccountId,
      externalAccountId,
      actorEmail,
    }) => {
      const client = await pool.connect()
      const credentialFingerprint = 'd'.repeat(64)
      const requestedScopes = focusedProviderWriteGrantedScopes.faire
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `UPDATE operations_integration_accounts
           SET provider = 'faire', integration_type = 'commerce',
               environment = 'production', status = 'active',
               external_account_id = $3,
               commerce_credential_generation = 1,
               credential_reference =
                 'commerce-credential:' || id::text || ':v1',
               configuration = jsonb_build_object(
                 'authMode', 'faire_oauth',
                 'tokenAcquisition', 'authorization_code',
                 'requestedScopes', $4::jsonb,
                 'grantedScopes', $4::jsonb,
                 'scopeVerification', 'oauth_grant',
                 'oauthGrantTokenType', 'BEARER',
                 'oauthGrantCredentialFingerprintSha256', $5::text,
                 'scopeProofProviderReference', $5::text,
                 'scopeProofAttemptGlobalId', 'pending'
               ),
               updated_by = $6, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [
            organizationId,
            integrationAccountId,
            externalAccountId,
            JSON.stringify(requestedScopes),
            credentialFingerprint,
            actorEmail,
          ],
        )
        await client.query(
          `INSERT INTO operations_commerce_credentials (
             organization_id, integration_account_id, external_account_id,
             auth_mode, credential_ciphertext, credential_iv, credential_tag,
             credential_version, credential_identifier_last_four,
             verification_status, verified_at, webhook_verification_status,
             created_by, updated_by
           ) VALUES (
             $1::uuid, $2::uuid, $3, 'faire_oauth',
             decode('02', 'hex'), decode(repeat('00', 12), 'hex'),
             decode(repeat('00', 16), 'hex'), 1, '0002', 'verified', now(),
             'not_applicable', $4, $4
           )
           ON CONFLICT (organization_id, integration_account_id) DO UPDATE
           SET external_account_id = EXCLUDED.external_account_id,
               auth_mode = EXCLUDED.auth_mode,
               credential_ciphertext = EXCLUDED.credential_ciphertext,
               credential_iv = EXCLUDED.credential_iv,
               credential_tag = EXCLUDED.credential_tag,
               credential_version = EXCLUDED.credential_version,
               credential_identifier_last_four =
                 EXCLUDED.credential_identifier_last_four,
               verification_status = EXCLUDED.verification_status,
               verified_at = EXCLUDED.verified_at,
               last_error_code = NULL,
               webhook_verification_status =
                 EXCLUDED.webhook_verification_status,
               webhook_verified_at = NULL,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
          [organizationId, integrationAccountId, externalAccountId, actorEmail],
        )
        const grantRequest = {
          provider: 'faire',
          operation: 'authorizationCodeExchange',
          grantType: 'AUTHORIZATION_CODE',
          requestedScopes,
          credentialFingerprintSha256: credentialFingerprint,
          providerWrites: 0,
        }
        const grantEvidence = {
          provider: 'faire',
          operation: 'authorizationCodeExchange',
          grantType: 'AUTHORIZATION_CODE',
          tokenType: 'BEARER',
          externalAccountId,
          credentialGeneration: 1,
          requestedScopes,
          grantedScopes: requestedScopes,
          credentialFingerprintSha256: credentialFingerprint,
          providerReference: credentialFingerprint,
          providerWrites: 0,
        }
        const grantObservedAt = new Date()
        const grantAttempt = await client.query(
          `INSERT INTO operations_commerce_provider_attempts (
             organization_id, integration_account_id, action, adapter_version,
             external_object_id, idempotency_key, request_hash,
             redacted_request, redacted_response, state, attempt_number,
             provider_reference, requested_at, completed_at, created_by
           ) VALUES (
             $1::uuid, $2::uuid, 'faire.oauth.authorization_code.exchange',
             'faire-external-api-v2-oauth-authorization-code-v1',
             'commerce-credential:' || $2::uuid::text || ':v1', $3,
             operations_faire_provider_write_request_hash($4::jsonb),
             $4::jsonb, $5::jsonb, 'succeeded', 1, $6,
             $8::timestamptz, $8::timestamptz, $7
           ) RETURNING id::text, global_id, completed_at`,
          [
            organizationId,
            integrationAccountId,
            `faire-oauth-grant:1:${credentialFingerprint}`,
            JSON.stringify(grantRequest),
            JSON.stringify(grantEvidence),
            credentialFingerprint,
            actorEmail,
            grantObservedAt,
          ],
        )
        await client.query(
          `UPDATE operations_integration_accounts
           SET configuration = jsonb_set(
             configuration,
             '{scopeProofAttemptGlobalId}',
             to_jsonb($3::text),
             true
           )
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [organizationId, integrationAccountId, grantAttempt.rows[0].global_id],
        )
        await client.query(
          `INSERT INTO operations_faire_provider_write_scope_evidence (
             organization_id, integration_account_id, provider_attempt_id,
             external_account_id, credential_generation,
             verified_write_scopes, verification_source,
             provider_reference, redacted_evidence, evidence_hash,
             observed_at, recorded_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, 1,
             ARRAY['WRITE_ORDERS']::text[], 'oauth_grant', $5, $6::jsonb,
             operations_faire_provider_write_request_hash($6::jsonb),
             $7::timestamptz, $8
           )`,
          [
            organizationId,
            integrationAccountId,
            grantAttempt.rows[0].id,
            externalAccountId,
            credentialFingerprint,
            JSON.stringify(grantEvidence),
            grantAttempt.rows[0].completed_at,
            actorEmail,
          ],
        )
        await client.query('SET LOCAL session_replication_role = origin')
        await client.query(
          `INSERT INTO operations_commerce_provider_write_controls (
             organization_id, integration_account_id, provider, row_version,
             expected_row_version, requested_mode,
             bound_credential_generation, bound_granted_scopes,
             bound_granted_scope_digest, changed_by, changed_role,
             idempotency_key, request_hash
           ) VALUES (
             $1::uuid, $2::uuid, 'faire', $3::bigint,
             ($3::bigint - 1), 'on', 1, $4::text[], $5, $6, 'owner',
             $7, repeat('d', 64)
           )`,
          [
            organizationId,
            integrationAccountId,
            focusedProviderWriteControlRowVersion,
            requestedScopes,
            focusedProviderWriteScopeDigest.faire,
            actorEmail,
            `focused-faire-provider-writes-${randomUUID()}`,
          ],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }

    const createLegacyReadOnlyAuthorizationFixture = async (provider) => {
      const scenario = `legacy-${provider}-read-only-authority`
      const fixture = await createFixture(scenario, { unitsPerPackage: 1 })
      const order = await advanceOrderToPacked(
        persistence,
        fixture,
        scenario,
      )
      const packagingClaim = await addPackagingClaim(
        pool,
        fixture,
        order.planned.orderGlobalId,
      )
      const externalAccountId = provider === 'shopify'
        ? `gid://shopify/Shop/${Date.now()}${provider.length}`
        : `b_legacy_read_only_${randomUUID().replaceAll('-', '')}`
      const externalOrderId = provider === 'shopify'
        ? `gid://shopify/Order/${Date.now()}${provider.length}`
        : `bo_legacy_read_only_${randomUUID().replaceAll('-', '')}`
      const setup = await pool.connect()
      let result
      try {
        await setup.query('BEGIN')
        await setup.query('SET LOCAL session_replication_role = replica')
        const context = await setup.query(
          `SELECT source_order.id::text AS order_id,
                  source_order.integration_account_id::text AS account_id,
                  source_order.pipeline_id::text AS pipeline_id,
                  source_order.customer_id::text AS customer_id,
                  source_order.ship_to,
                  plan.id::text AS plan_id,
                  plan.warehouse_id::text AS warehouse_id
           FROM operations_orders source_order
           JOIN operations_fulfillment_plans plan
             ON plan.organization_id = source_order.organization_id
            AND plan.order_id = source_order.id
           WHERE source_order.organization_id = $1::uuid
             AND source_order.global_id = $2`,
          [fixture.organizationId, order.planned.orderGlobalId],
        )
        assert.equal(context.rowCount, 1)
        const sourceShipTo = orderShipTo.normalizeOrderShipToDraft(
          context.rows[0].ship_to,
        )
        assert.equal(
          orderShipTo.orderShipToReadiness(sourceShipTo),
          'carrier_ready',
        )
        const destinationFingerprint = carrierSandboxRate
          .carrierSandboxPartyFingerprint({
            name: sourceShipTo.name,
            line1: sourceShipTo.line1,
            line2: sourceShipTo.line2,
            city: sourceShipTo.city,
            region: sourceShipTo.region,
            postalCode: sourceShipTo.postalCode,
            countryCode: sourceShipTo.country,
          })
        const candidateSourceHash = createHash('sha256')
          .update(`legacy-authority-candidate:${fixture.organizationId}:${provider}`)
          .digest('hex')
        const candidate = await setup.query(
          `INSERT INTO operations_commerce_order_candidates (
             organization_id, integration_account_id, pipeline_id, run_id,
             provider, external_order_id, order_number_snapshot,
             provider_order_status_raw, provider_financial_status_raw,
             provider_fulfillment_status_raw, provider_return_status_raw,
             normalized_order_status, normalized_payment_status,
             normalized_fulfillment_status, normalized_return_status,
             test_order, requires_shipping, currency_code, subtotal_minor,
             shipping_minor, tax_minor, other_adjustment_minor, total_minor,
             party_kind, party_snapshot_state, customer_resolution_state,
             customer_match_method, customer_id,
             ship_to_snapshot_state, ship_to_snapshot_source,
             ship_to_snapshot_ciphertext, ship_to_snapshot_iv,
             ship_to_snapshot_tag, ship_to_snapshot_hash,
             ship_to_snapshot_encryption_version,
             delivery_resolution_state, requested_delivery_at,
             observed_at, source_revision, source_hash,
             provider_api_version, normalizer_version,
             workflow_state, blocking_codes, canonical_order_id,
             promotion_command_receipt_id, promotion_idempotency_key,
             promotion_request_hash, promoted_at, row_version,
             created_by, updated_by, expires_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             $5, $6, '#LEGACY-AUTHORITY',
             'open', 'paid', 'unfulfilled', 'none',
             'open', 'paid', 'unfulfilled', 'none',
             true, true, 'USD', 4900, 0, 0, 0, 4900,
             'consumer', 'missing', 'resolved', 'exact_email', $7::uuid,
             'confirmed', 'manual', decode('0102', 'hex'),
             decode(repeat('01', 12), 'hex'),
             decode(repeat('02', 16), 'hex'), repeat('f', 64), 1,
             'manual', now() + interval '7 days', now(),
             'legacy-authority-source-v1', $8,
             '2026-07', 'legacy-authority-fixture-v1',
             'promoted', '{}'::text[], $9::uuid,
             $10::uuid, 'legacy-authority-promote', repeat('b', 64), now(),
             1, $11, $11, now() + interval '1 day'
           ) RETURNING id::text, row_version::bigint, source_hash`,
          [
            fixture.organizationId,
            context.rows[0].account_id,
            context.rows[0].pipeline_id,
            randomUUID(),
            provider,
            externalOrderId,
            context.rows[0].customer_id,
            candidateSourceHash,
            context.rows[0].order_id,
            randomUUID(),
            fixture.email,
          ],
        )
        assert.equal(candidate.rowCount, 1)
        const cartonizationEvidence = await setup.query(
          `INSERT INTO operations_cartonization_rate_evidence (
             organization_id, integration_account_id, order_candidate_id,
             candidate_row_version, candidate_source_hash, warehouse_id,
             destination_fingerprint, evidence_mode, policy_version,
             algorithm_version, request_hash, plan_input_hash,
             plan_result_hash, plan_snapshot, assumption_snapshot, status,
             idempotency_key, actor_email, write_token_hash, sealed_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5, $6::uuid,
             $7, 'operational', 'legacy-authority-fixture-v1',
             'legacy-authority-fixture-v1', repeat('b', 64),
             repeat('c', 64), repeat('d', 64),
             jsonb_build_object('carrierReadEnvironment', 'sandbox'),
             '{}'::jsonb, 'succeeded', $8, $9, repeat('e', 64), now()
           ) RETURNING id::text`,
          [
            fixture.organizationId,
            context.rows[0].account_id,
            candidate.rows[0].id,
            candidate.rows[0].row_version,
            candidate.rows[0].source_hash,
            context.rows[0].warehouse_id,
            destinationFingerprint,
            `legacy-authority-evidence-${randomUUID()}`,
            fixture.email,
          ],
        )
        await setup.query(
          `UPDATE operations_fulfillment_plans
           SET cartonization_evidence_id = $3::uuid
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [
            fixture.organizationId,
            context.rows[0].plan_id,
            cartonizationEvidence.rows[0].id,
          ],
        )
        const carrierIntegration = await setup.query(
          `INSERT INTO operations_integration_accounts (
             organization_id, provider, integration_type, environment,
             display_name, status, configuration, created_by, updated_by
           ) VALUES (
             $1::uuid, 'ups_rest', 'carrier', 'sandbox',
             'Focused legacy guard UPS', 'active', '{}'::jsonb, $2, $2
           ) RETURNING id::text, global_id`,
          [fixture.organizationId, fixture.email],
        )
        assert.equal(carrierIntegration.rowCount, 1)
        const carrierAccount = await setup.query(
          `INSERT INTO operations_carrier_accounts (
             organization_id, integration_account_id, display_name,
             sender_name,
             account_number_ciphertext, account_number_iv,
             account_number_tag, account_number_last_four,
             account_number_fingerprint, registered_address,
             registered_address_fingerprint, address_verification,
             status, created_by, updated_by
           ) VALUES (
             $1::uuid, $2::uuid, 'Focused legacy guard shipper',
             'Focused legacy guard shipper',
             'focused-ciphertext', 'focused-iv', 'focused-tag', '0001',
             repeat('1', 64),
             jsonb_build_object(
               'line1', '1 Focused Way', 'city', 'Delaware',
               'region', 'OH', 'postalCode', '43015',
               'countryCode', 'US'
             ),
             repeat('2', 64), 'operator_attested',
             'active', $3, $3
           ) RETURNING id::text, global_id`,
          [
            fixture.organizationId,
            carrierIntegration.rows[0].id,
            fixture.email,
          ],
        )
        assert.equal(carrierAccount.rowCount, 1)
        await setup.query(
          `UPDATE operations_integration_accounts
           SET provider = $3, integration_type = 'commerce',
               environment = 'sandbox', status = 'active',
               external_account_id = $4,
               commerce_credential_generation = CASE
                 WHEN $3 = 'shopify' THEN 1
                 ELSE commerce_credential_generation
               END,
               configuration = CASE
                 WHEN $3 = 'shopify' THEN jsonb_build_object(
                   'shopDomain', 'legacy-read-only.myshopify.com',
                   'grantedScopes', $6::jsonb
                 )
                 ELSE configuration
               END,
               updated_by = $5, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [
            fixture.organizationId,
            context.rows[0].account_id,
            provider,
            externalAccountId,
            fixture.email,
            JSON.stringify(focusedProviderWriteGrantedScopes.shopify),
          ],
        )
        if (provider === 'shopify') {
          await setup.query(
            `INSERT INTO operations_commerce_credentials (
               organization_id, integration_account_id, external_account_id,
               auth_mode, credential_ciphertext, credential_iv, credential_tag,
               credential_version, credential_identifier_last_four,
               verification_status, verified_at, webhook_verification_status,
               created_by, updated_by
             ) VALUES (
               $1::uuid, $2::uuid, $3, 'shopify_client_credentials',
               decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
               decode(repeat('00', 16), 'hex'), 1, '0001', 'verified', now(),
               'unverified', $4, $4
             )`,
            [
              fixture.organizationId,
              context.rows[0].account_id,
              externalAccountId,
              fixture.email,
            ],
          )
          await setup.query('SET LOCAL session_replication_role = origin')
          await setup.query(
            `INSERT INTO operations_commerce_provider_write_controls (
               organization_id, integration_account_id, provider, row_version,
               expected_row_version, requested_mode,
               bound_credential_generation, bound_granted_scopes,
               bound_granted_scope_digest, changed_by, changed_role,
               idempotency_key, request_hash
             ) VALUES (
               $1::uuid, $2::uuid, 'shopify', $3::bigint,
               ($3::bigint - 1), 'on', 1, $4::text[], $5, $6, 'owner',
               $7, repeat('a', 64)
             )`,
            [
              fixture.organizationId,
              context.rows[0].account_id,
              focusedProviderWriteControlRowVersion,
              focusedProviderWriteGrantedScopes.shopify,
              focusedProviderWriteScopeDigest.shopify,
              fixture.email,
              `legacy-shopify-provider-writes-${randomUUID()}`,
            ],
          )
          await setup.query('SET LOCAL session_replication_role = replica')
        }
        await setup.query(
          `UPDATE operations_orders
           SET source_provider = $3, external_order_id = $4,
               updated_by = $5, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [
            fixture.organizationId,
            context.rows[0].order_id,
            provider,
            externalOrderId,
            fixture.email,
          ],
        )
        await setup.query(
          `UPDATE operations_carrier_rates
           SET selected = false
           WHERE organization_id = $1::uuid AND plan_id = $2::uuid`,
          [fixture.organizationId, context.rows[0].plan_id],
        )
        const selectedRate = await setup.query(
          `UPDATE operations_carrier_rates
           SET selected = true
           WHERE organization_id = $1::uuid AND plan_id = $2::uuid
             AND carrier = 'UPS' AND service_code = 'GROUND'
           RETURNING id::text, global_id`,
          [fixture.organizationId, context.rows[0].plan_id],
        )
        assert.equal(selectedRate.rowCount, 1)
        const activation = await setup.query(
          `UPDATE operations_activation_scopes
           SET state = 'read_only', revision = revision + 1,
               reason = 'Reject legacy authority in Read only execution',
               updated_by = $2, updated_at = now()
           WHERE organization_id = $1::uuid
           RETURNING state`,
          [fixture.organizationId, fixture.email],
        )
        assert.equal(activation.rows[0]?.state, 'read_only')
        const authorization = await setup.query(
          `INSERT INTO operations_sandbox_commerce_e2e_authorizations (
             organization_id, order_id, external_order_id,
             confirmation_statement_version, confirmation_hash, reason,
             authorized_by, expires_at
           ) VALUES (
             $1::uuid, $2::uuid, $3,
             'sandbox-commerce-e2e-v1', repeat('e', 64),
             'Legacy authority must not unlock Read only execution',
             $4, now() + interval '30 minutes'
           ) RETURNING id::text, global_id, state, consumed_at, consumed_by`,
          [
            fixture.organizationId,
            context.rows[0].order_id,
            externalOrderId,
            fixture.email,
          ],
        )
        assert.equal(authorization.rowCount, 1)
        const packageContext = await setup.query(
          `SELECT package.global_id AS package_global_id,
                  rate.global_id AS carrier_rate_global_id
           FROM operations_packages package
           JOIN operations_carrier_rates rate
             ON rate.organization_id = package.organization_id
            AND rate.plan_id = package.plan_id
            AND rate.selected = true
           WHERE package.organization_id = $1::uuid
             AND package.plan_id = $2::uuid`,
          [fixture.organizationId, context.rows[0].plan_id],
        )
        assert.equal(packageContext.rowCount, 1)
        result = {
          fixture,
          order,
          packagingClaim,
          authorization: authorization.rows[0],
          packageGlobalId: packageContext.rows[0].package_global_id,
          carrierRateGlobalId:
            packageContext.rows[0].carrier_rate_global_id,
          carrierAccountGlobalId: carrierAccount.rows[0].global_id,
        }
        await setup.query('COMMIT')
      } catch (error) {
        await setup.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        setup.release()
      }
      return result
    }

    const assertLegacyReadOnlyAuthorityRejected = async (provider) => {
      const target = await createLegacyReadOnlyAuthorizationFixture(provider)
      const originalRequireSandboxAuthorization =
        sandboxAuthorization.requireActiveSandboxCommerceE2eAuthorization
      if (provider === 'faire') {
        sandboxAuthorization.requireActiveSandboxCommerceE2eAuthorization =
          async (client, input) => {
            const authorization = await client.query(
              `SELECT sandbox_auth.id::text,
                      sandbox_auth.organization_id::text,
                      sandbox_auth.order_id::text,
                      sandbox_auth.authorized_by,
                      sandbox_auth.confirmation_statement_version
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
            assert.equal(
              authorization.rowCount,
              1,
              'Focused Faire legacy authority must remain exact and active',
            )
            return authorization.rows[0]
          }
      }
      try {
        const labelMutationBaseline = await pool.query(
          `SELECT
             (SELECT count(*)::int FROM operations_labels
              WHERE organization_id = $1::uuid) AS labels,
             (SELECT count(*)::int FROM operations_label_attempts
              WHERE organization_id = $1::uuid) AS attempts`,
          [target.fixture.organizationId],
        )
        const labelProviderBaseline = carrierLabelProviderCalls
        const labelEvidenceBaseline = carrierLabelEvidenceCalls
        const labelPrintBaseline = carrierLabelPrintCalls
        const activeLabel = await shippingPersistence
          .createOperationsSandboxLabelInPostgres({
            organizationId: target.fixture.organizationId,
            actorEmail: target.fixture.email,
            orderGlobalId: target.order.planned.orderGlobalId,
            packageGlobalId: target.packageGlobalId,
            carrierRateGlobalId: target.carrierRateGlobalId,
            carrierAccountGlobalId: target.carrierAccountGlobalId,
            sandboxE2eAuthorizationGlobalId:
              target.authorization.global_id,
            expectedRowVersion: target.order.packed.rowVersion,
            reason:
              `Create legacy ${provider} sandbox label in Read only`,
            idempotencyKey:
              `legacy-${provider}-read-only-label-${randomUUID()}`,
          })
        assert.equal(activeLabel.labelStatus, 'created')
        assert.equal(activeLabel.orderStatus, 'packed')
        assert.equal(carrierLabelProviderCalls, labelProviderBaseline + 1)
        assert.equal(carrierLabelEvidenceCalls, labelEvidenceBaseline + 1)
        assert.equal(carrierLabelPrintCalls, labelPrintBaseline + 1)
        const labelMutationAfter = await pool.query(
          `SELECT
             (SELECT count(*)::int FROM operations_labels
              WHERE organization_id = $1::uuid) AS labels,
             (SELECT count(*)::int FROM operations_label_attempts
              WHERE organization_id = $1::uuid) AS attempts`,
          [target.fixture.organizationId],
        )
        assert.equal(
          labelMutationAfter.rows[0].labels,
          labelMutationBaseline.rows[0].labels + 1,
        )
        assert.equal(
          labelMutationAfter.rows[0].attempts,
          labelMutationBaseline.rows[0].attempts + 1,
        )
        const shipmentEvidenceBefore = await orderEvidence(
          pool,
          target.fixture,
          target.order.planned.orderGlobalId,
        )
        const packagingEvidenceBefore = await packagingClaimEvidence(
          pool,
          target.fixture,
          target.packagingClaim,
        )
        const shopifyPreparationBaseline = shopifyFulfillmentPreparationCalls
        const shopifyExecutionBaseline = shopifyFulfillmentExecutionCalls
        const fairePreparationBaseline = faireFulfillmentPreparationCalls
        const faireExecutionBaseline = faireFulfillmentExecutionCalls
        const activation = await pool.query(
          `UPDATE operations_activation_scopes
           SET state = 'active', revision = revision + 1,
               reason = 'Provider writes Off must win over Active',
               updated_by = $2, updated_at = now()
           WHERE organization_id = $1::uuid
           RETURNING state`,
          [target.fixture.organizationId, target.fixture.email],
        )
        assert.equal(activation.rows[0]?.state, 'active')
        focusedProviderWritesOn = false
        await expectRejected(
          () => persistence.confirmOperationsOrderShipmentFromPostgres({
            organizationId: target.fixture.organizationId,
            actorEmail: target.fixture.email,
            orderGlobalId: target.order.planned.orderGlobalId,
            expectedRowVersion: activeLabel.rowVersion,
            reason:
              `Reject ${provider} shipment while Provider writes is Off`,
            idempotencyKey:
              `legacy-${provider}-read-only-shipment-${randomUUID()}`,
            sandboxE2eAuthorizationGlobalId:
              target.authorization.global_id,
            expectedNotificationPolicyRevision:
              provider === 'shopify' ? 0 : null,
          }),
          (error) => error?.code === 'COMMERCE_PROVIDER_WRITES_OFF',
          `${provider} Provider writes Off must reject even while Operations is Active`,
        )
        assert.deepEqual(
          await orderEvidence(
            pool,
            target.fixture,
            target.order.planned.orderGlobalId,
          ),
          shipmentEvidenceBefore,
          `Legacy ${provider} Read only rejection must write no shipment, inventory, or export`,
        )
        assert.deepEqual(
          await packagingClaimEvidence(
            pool,
            target.fixture,
            target.packagingClaim,
          ),
          packagingEvidenceBefore,
          `Legacy ${provider} Read only rejection must not consume packaging inventory`,
        )
        assert.equal(shopifyFulfillmentPreparationCalls, shopifyPreparationBaseline)
        assert.equal(shopifyFulfillmentExecutionCalls, shopifyExecutionBaseline)
        assert.equal(faireFulfillmentPreparationCalls, fairePreparationBaseline)
        assert.equal(faireFulfillmentExecutionCalls, faireExecutionBaseline)
        const retainedAuthorization = await pool.query(
          `SELECT state, consumed_at, consumed_by
           FROM operations_sandbox_commerce_e2e_authorizations
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [target.fixture.organizationId, target.authorization.id],
        )
        assert.deepEqual(
          retainedAuthorization.rows[0],
          { state: 'active', consumed_at: null, consumed_by: null },
          `Legacy ${provider} Read only rejection must not consume authorization`,
        )
        if (provider === 'shopify') {
          focusedProviderWritesOn = true
          const disabledProfile = await pool.query(
            `UPDATE operations_activation_scopes
             SET state = 'disabled', revision = revision + 1,
                 reason = 'Shopify Provider writes On authorizes fulfillment',
                 updated_by = $2, updated_at = now()
             WHERE organization_id = $1::uuid
             RETURNING state`,
            [target.fixture.organizationId, target.fixture.email],
          )
          assert.equal(disabledProfile.rows[0]?.state, 'disabled')
          const enabledResult = await persistence
            .confirmOperationsOrderShipmentFromPostgres({
              organizationId: target.fixture.organizationId,
              actorEmail: target.fixture.email,
              orderGlobalId: target.order.planned.orderGlobalId,
              expectedRowVersion: activeLabel.rowVersion,
              reason:
                'Confirm exact Shopify sandbox shipment with Provider writes On',
              idempotencyKey:
                `legacy-shopify-provider-writes-on-${randomUUID()}`,
              sandboxE2eAuthorizationGlobalId:
                target.authorization.global_id,
              expectedNotificationPolicyRevision: 0,
            })
          assert.equal(enabledResult.orderStatus, 'shipped')
          assert.equal(enabledResult.commerceExportState, 'succeeded')
          assert.equal(
            shopifyFulfillmentPreparationCalls,
            shopifyPreparationBaseline + 1,
          )
          assert.equal(
            shopifyFulfillmentExecutionCalls,
            shopifyExecutionBaseline + 1,
          )
        }
      } finally {
        focusedProviderWritesOn = true
        sandboxAuthorization.requireActiveSandboxCommerceE2eAuthorization =
          originalRequireSandboxAuthorization
      }
    }

    await assertLegacyReadOnlyAuthorityRejected('shopify')
    await assertLegacyReadOnlyAuthorityRejected('faire')

    const createShopifyShipmentFixture = async (
      scenario,
      { notifyCustomerDefault = false } = {},
    ) => {
      const fixture = await createFixture(scenario)
      const order = await advanceOrderToPacked(persistence, fixture, scenario)
      await addPackagingClaim(pool, fixture, order.planned.orderGlobalId)
      const account = await pool.query(
        `UPDATE operations_integration_accounts integration
         SET provider = 'shopify', integration_type = 'commerce',
             environment = 'production',
             external_account_id = $3,
             display_name = $4,
             configuration = jsonb_build_object('shopDomain', $5::text),
             updated_by = $6, updated_at = now()
         FROM operations_orders source_order
         WHERE source_order.organization_id = $1::uuid
           AND source_order.global_id = $2
           AND integration.organization_id = source_order.organization_id
           AND integration.id = source_order.integration_account_id
         RETURNING integration.id::text, integration.global_id,
                   integration.external_account_id,
                   integration.configuration->>'shopDomain' AS shop_domain`,
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
      await seedFocusedShopifyProviderWriteAuthority({
        organizationId: fixture.organizationId,
        integrationAccountId: account.rows[0].id,
        externalAccountId: account.rows[0].external_account_id,
        shopDomain: account.rows[0].shop_domain,
        actorEmail: fixture.email,
      })
      // Shopify notification behavior is exercised after the separately
      // tested production-planning boundary. Retain an exact active fixture
      // authorization so the disposable database accepts the prebuilt plan.
      // This provider-write fixture uses explicit mock carrier evidence; the
      // exact production carrier-lineage path is covered by the 0315 matrix.
      await pool.query(
        `INSERT INTO operations_sandbox_commerce_e2e_authorizations (
           organization_id, order_id, external_order_id,
           confirmation_statement_version, confirmation_hash, reason,
           authorized_by, expires_at
         )
         SELECT source_order.organization_id, source_order.id,
                source_order.external_order_id,
                'sandbox-commerce-e2e-v1', repeat('b', 64),
                'Focused Shopify notification shipment acceptance',
                $3, now() + interval '30 minutes'
         FROM operations_orders source_order
         WHERE source_order.organization_id = $1::uuid
           AND source_order.global_id = $2`,
        [fixture.organizationId, order.planned.orderGlobalId, fixture.email],
      )
      const activation = await pool.query(
        `UPDATE operations_activation_scopes
         SET state = 'active', revision = revision + 1,
             reason = 'Focused Shopify notification shipment acceptance',
             updated_by = $2, updated_at = now()
         WHERE organization_id = $1::uuid
         RETURNING state`,
        [fixture.organizationId, fixture.email],
      )
      assert.equal(activation.rows[0]?.state, 'active')
      await addActiveLabel(
        pool,
        fixture,
        order.planned.orderGlobalId,
        'mock',
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

    const createCanonicalShopifyTestFixture = async (scenario) => {
      const fixture = await createFixture(scenario, { unitsPerPackage: 1 })
      const order = await advanceOrderToPacked(persistence, fixture, scenario)
      await splitPackedOrderIntoTwoPackagesForFixture(
        pool,
        fixture,
        order.planned.orderGlobalId,
      )
      await addPackagingClaim(pool, fixture, order.planned.orderGlobalId)
      await addSandboxLabelsForAllPackages(
        pool,
        fixture,
        order.planned.orderGlobalId,
      )
      const context = await pool.query(
        `SELECT source_order.id::text AS order_id,
                source_order.row_version::text AS order_row_version,
                source_order.pipeline_id::text AS pipeline_id,
                source_order.integration_account_id::text AS account_id,
                source_order.ship_to,
                integration.global_id AS account_global_id,
                plan.id::text AS plan_id,
                plan.warehouse_id::text AS warehouse_id
         FROM operations_orders source_order
         JOIN operations_integration_accounts integration
           ON integration.organization_id = source_order.organization_id
          AND integration.id = source_order.integration_account_id
         JOIN operations_fulfillment_plans plan
           ON plan.organization_id = source_order.organization_id
          AND plan.order_id = source_order.id
         WHERE source_order.organization_id = $1::uuid
           AND source_order.global_id = $2`,
        [fixture.organizationId, order.planned.orderGlobalId],
      )
      assert.equal(context.rowCount, 1)
      const source = context.rows[0]
      const sourceShipTo = orderShipTo.normalizeOrderShipToDraft(
        source.ship_to,
      )
      assert.equal(
        orderShipTo.orderShipToReadiness(sourceShipTo),
        'carrier_ready',
      )
      const destinationFingerprint = carrierSandboxRate
        .carrierSandboxPartyFingerprint({
          name: sourceShipTo.name,
          line1: sourceShipTo.line1,
          line2: sourceShipTo.line2,
          city: sourceShipTo.city,
          region: sourceShipTo.region,
          postalCode: sourceShipTo.postalCode,
          countryCode: sourceShipTo.country,
        })
      const externalShopId = `gid://shopify/Shop/${Date.now()}1`
      const externalOrderId = `gid://shopify/Order/${Date.now()}2`
      const candidateSourceHash = 'c'.repeat(64)
      const setup = await pool.connect()
      let candidate
      let activationRevision
      try {
        await setup.query('BEGIN')
        await setup.query('SET LOCAL session_replication_role = replica')
        await setup.query(
          `UPDATE operations_integration_accounts
           SET provider = 'shopify', integration_type = 'commerce',
               environment = 'sandbox', status = 'active',
               external_account_id = $3,
               commerce_credential_generation = 1,
               configuration = jsonb_build_object(
                 'shopDomain', 'canonical-test.myshopify.com',
                 'grantedScopes', $5::jsonb
               ),
               updated_by = $4, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [
            fixture.organizationId,
            source.account_id,
            externalShopId,
            fixture.email,
            JSON.stringify(focusedProviderWriteGrantedScopes.shopify),
          ],
        )
        await setup.query(
          `INSERT INTO operations_commerce_credentials (
             organization_id, integration_account_id, external_account_id,
             auth_mode, credential_ciphertext, credential_iv, credential_tag,
             credential_version, credential_identifier_last_four,
             verification_status, verified_at, webhook_verification_status,
             created_by, updated_by
           ) VALUES (
             $1::uuid, $2::uuid, $3, 'shopify_client_credentials',
             decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
             decode(repeat('00', 16), 'hex'), 1, '0001', 'verified', now(),
             'unverified', $4, $4
           )`,
          [
            fixture.organizationId,
            source.account_id,
            externalShopId,
            fixture.email,
          ],
        )
        await setup.query('SET LOCAL session_replication_role = origin')
        await setup.query(
          `INSERT INTO operations_commerce_provider_write_controls (
             organization_id, integration_account_id, provider, row_version,
             expected_row_version, requested_mode,
             bound_credential_generation, bound_granted_scopes,
             bound_granted_scope_digest, changed_by, changed_role,
             idempotency_key, request_hash
           ) VALUES (
             $1::uuid, $2::uuid, 'shopify', $3::bigint,
             ($3::bigint - 1), 'on', 1, $4::text[], $5, $6, 'owner',
             $7, repeat('b', 64)
           )`,
          [
            fixture.organizationId,
            source.account_id,
            focusedProviderWriteControlRowVersion,
            focusedProviderWriteGrantedScopes.shopify,
            focusedProviderWriteScopeDigest.shopify,
            fixture.email,
            `canonical-shopify-provider-writes-${randomUUID()}`,
          ],
        )
        await setup.query('SET LOCAL session_replication_role = replica')
        await setup.query(
          `UPDATE operations_orders
           SET source_provider = 'shopify', external_order_id = $3,
               updated_by = $4, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [
            fixture.organizationId,
            source.order_id,
            externalOrderId,
            fixture.email,
          ],
        )
        const activation = await setup.query(
          `UPDATE operations_activation_scopes
           SET state = 'read_only', revision = revision + 1,
               reason = 'Exact canonical Shopify test-store acceptance',
               updated_by = $2, updated_at = now()
           WHERE organization_id = $1::uuid
           RETURNING revision`,
          [fixture.organizationId, fixture.email],
        )
        activationRevision = activation.rows[0].revision
        const run = await setup.query(
          `INSERT INTO operations_commerce_intake_runs (
             organization_id, integration_account_id, pipeline_id,
             provider, resource, credential_version, provider_api_version,
             normalizer_version, idempotency_key, request_hash, window_end,
             workflow_state, records_seen, records_staged, records_ready,
             records_promoted, canonical_orders_created,
             provider_write_count, inventory_write_count,
             reservation_write_count, fulfillment_write_count,
             shipment_write_count, commerce_export_write_count,
             completed_at, created_by, updated_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, 'shopify', 'orders', 1,
             '2026-07', 'canonical-test-fixture-v1', $4, $5, now(),
             'promoted', 1, 1, 0, 1, 1,
             0, 0, 0, 0, 0, 0, now(), $6, $6
           ) RETURNING id::text`,
          [
            fixture.organizationId,
            source.account_id,
            source.pipeline_id,
            `canonical-test-intake-${randomUUID()}`,
            'a'.repeat(64),
            fixture.email,
          ],
        )
        const promotionReceipt = await setup.query(
          `INSERT INTO operations_command_receipts (
             organization_id, command_type, idempotency_key, request_hash,
             actor_email, status, correlation_id, result_global_id,
             result_payload, completed_at
           ) VALUES (
             $1::uuid, 'promote_commerce_order', $2, $3,
             $4, 'succeeded', $5::uuid, $6,
             jsonb_build_object('orderGlobalId', $6::text), now()
           ) RETURNING id::text`,
          [
            fixture.organizationId,
            `canonical-test-promote-${randomUUID()}`,
            'b'.repeat(64),
            fixture.email,
            randomUUID(),
            order.planned.orderGlobalId,
          ],
        )
        candidate = (await setup.query(
          `INSERT INTO operations_commerce_order_candidates (
             organization_id, integration_account_id, pipeline_id, run_id,
             provider, external_order_id, order_number_snapshot,
             provider_order_status_raw, provider_financial_status_raw,
             provider_fulfillment_status_raw, provider_return_status_raw,
             normalized_order_status, normalized_payment_status,
             normalized_fulfillment_status, normalized_return_status,
             test_order, requires_shipping, currency_code, subtotal_minor,
             shipping_minor, tax_minor, other_adjustment_minor, total_minor,
             party_kind, party_snapshot_state, customer_resolution_state,
             customer_match_method, customer_id,
             ship_to_snapshot_state, ship_to_snapshot_source,
             ship_to_snapshot_ciphertext, ship_to_snapshot_iv,
             ship_to_snapshot_tag, ship_to_snapshot_hash,
             ship_to_snapshot_encryption_version,
             delivery_resolution_state, requested_delivery_at,
             observed_at, source_revision,
             source_hash, provider_api_version, normalizer_version,
             workflow_state, blocking_codes, canonical_order_id,
             promotion_command_receipt_id, promotion_idempotency_key,
             promotion_request_hash, promoted_at,
             row_version, created_by, updated_by, expires_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             'shopify', $5, '#CANONICAL-TEST',
             'open', 'paid', 'unfulfilled', 'none',
             'open', 'paid', 'unfulfilled', 'none',
             true, true, 'USD', 4900,
             0, 0, 0, 4900,
             'consumer', 'missing', 'resolved', 'exact_email', $9::uuid,
             'confirmed', 'manual', decode('0102', 'hex'),
             decode(repeat('01', 12), 'hex'), decode(repeat('02', 16), 'hex'),
             repeat('f', 64), 1,
             'manual', now() + interval '7 days',
             now(), 'canonical-test-source-v1',
             $6, '2026-07', 'canonical-test-fixture-v1',
             'promoted', '{}'::text[], $7::uuid,
             $10::uuid, 'canonical-test-promote', repeat('b', 64), now(),
             1, $8, $8, now() + interval '1 day'
           ) RETURNING id::text, global_id, row_version::text`,
          [
            fixture.organizationId,
            source.account_id,
            source.pipeline_id,
            run.rows[0].id,
            externalOrderId,
            candidateSourceHash,
            source.order_id,
            fixture.email,
            fixture.customer.id,
            promotionReceipt.rows[0].id,
          ],
        )).rows[0]
        const cartonization = await setup.query(
          `INSERT INTO operations_cartonization_rate_evidence (
             organization_id, integration_account_id, order_candidate_id,
             candidate_row_version, candidate_source_hash, warehouse_id,
             destination_fingerprint,
             evidence_mode, policy_version, algorithm_version,
             request_hash, plan_input_hash, plan_result_hash,
             plan_snapshot, assumption_snapshot, status,
             idempotency_key, actor_email, write_token_hash, sealed_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid,
             $4::bigint, $5, $6::uuid,
             $7,
             'operational', 'canonical-test-policy-v1',
             'canonical-test-algorithm-v1',
             repeat('1', 64), repeat('2', 64), repeat('3', 64),
             jsonb_build_object('carrierReadEnvironment', 'sandbox'),
             '{}'::jsonb, 'succeeded', $8, $9, repeat('4', 64), now()
           ) RETURNING id::text`,
          [
            fixture.organizationId,
            source.account_id,
            candidate.id,
            candidate.row_version,
            candidateSourceHash,
            source.warehouse_id,
            destinationFingerprint,
            `canonical-test-evidence-${randomUUID()}`,
            fixture.email,
          ],
        )
        await setup.query(
          `UPDATE operations_fulfillment_plans
           SET cartonization_evidence_id = $3::uuid
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [fixture.organizationId, source.plan_id, cartonization.rows[0].id],
        )
        await setup.query('COMMIT')
      } catch (error) {
        await setup.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        setup.release()
      }
      await postgres.withTransaction((client) => (
        fulfillmentNotificationPolicy
          .ensureShopifyFulfillmentNotificationPolicyWithClient(client, {
            organizationId: fixture.organizationId,
            integrationAccountId: source.account_id,
            actorEmail: fixture.email,
          })
      ))
      const proof = {
        version:
          shopifyTestStoreConstants.SHOPIFY_TEST_STORE_CANONICAL_E2E_PROOF_VERSION,
        activationRevision,
        accountGlobalId: source.account_global_id,
        externalAccountId: externalShopId,
        credentialGeneration: 1,
        orderGlobalId: order.planned.orderGlobalId,
        orderRowVersion: Number(source.order_row_version),
        externalOrderId,
        candidateGlobalId: candidate.global_id,
        candidateRowVersion: Number(candidate.row_version),
        candidateSourceRevision: 'canonical-test-source-v1',
        candidateSourceHash,
        providerOrderUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
        providerVerifiedAt: new Date().toISOString(),
        test: true,
      }
      const authorizationInput = {
        organizationId: fixture.organizationId,
        actorEmail: fixture.email,
        idempotencyKey: `canonical-authorize-${randomUUID()}`,
        confirmationStatement:
          shopifyTestStoreConstants.SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION,
        reason: 'Exact canonical Shopify test-store acceptance',
        lifetimeMinutes: 120,
        proof,
      }
      await assert.rejects(
        () => shopifyTestStorePersistence
          .persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres(
            authorizationInput,
          ),
        (error) => error?.code === 'SHOPIFY_TEST_E2E_RESUME_AUTHORITY_INVALID',
        'A progressed order without prior exact authority must not enter the lane',
      )
      const rejectedResumeWrites = await pool.query(
        `SELECT (
           (SELECT count(*)
            FROM operations_sandbox_commerce_e2e_authorizations auth
            WHERE auth.organization_id = $1::uuid
              AND auth.order_id = $2::uuid)
           + (SELECT count(*)
              FROM operations_shopify_test_store_e2e_evidence evidence
              WHERE evidence.organization_id = $1::uuid
                AND evidence.order_id = $2::uuid)
         )::text AS write_count`,
        [fixture.organizationId, source.order_id],
      )
      assert.equal(
        Number(rejectedResumeWrites.rows[0].write_count),
        0,
        'Rejected progressed-order entry must create zero authorization writes',
      )
      const predecessor = await pool.connect()
      try {
        await predecessor.query('BEGIN')
        await predecessor.query('SET LOCAL session_replication_role = replica')
        await predecessor.query(
          `WITH prior_authority AS (
             INSERT INTO operations_sandbox_commerce_e2e_authorizations (
               organization_id, order_id, external_order_id, state,
               confirmation_statement_version, confirmation_hash, reason,
               authorized_by, authorized_at, expires_at
             ) VALUES (
               $1::uuid, $2::uuid, $3, 'expired',
               'shopify-test-store-canonical-e2e-v1', repeat('d', 64),
               'Prior exact authorization for canonical resume acceptance',
               $4, now() - interval '10 minutes', now() - interval '5 minutes'
             )
             RETURNING id, organization_id, order_id, confirmation_hash
           )
           INSERT INTO operations_shopify_test_store_e2e_evidence (
             authorization_id, organization_id, confirmation_hash,
             integration_account_id, account_global_id, external_account_id,
             credential_generation, activation_revision,
             order_id, order_global_id, external_order_id,
             initial_order_row_version,
             order_candidate_id, order_candidate_global_id,
             order_candidate_row_version, order_candidate_source_revision,
             order_candidate_source_hash, provider_proof_version,
             provider_proof_hash, provider_order_updated_at,
             provider_verified_at, provider_test,
             authorization_idempotency_key, authorization_request_hash,
             created_by
           )
           SELECT prior_authority.id, prior_authority.organization_id,
                  prior_authority.confirmation_hash,
                  $5::uuid, $6, $7, 1, $8::integer,
                  prior_authority.order_id, $9, $3,
                  $10::bigint,
                  $11::uuid, $12, $13::bigint, $14, $15,
                  'shopify-test-store-canonical-e2e-proof-v1', $16,
                  $17::timestamptz, $18::timestamptz, true,
                  'prior-canonical-authority-key', repeat('e', 64), $4
           FROM prior_authority`,
          [
            fixture.organizationId,
            source.order_id,
            externalOrderId,
            fixture.email,
            source.account_id,
            source.account_global_id,
            externalShopId,
            activationRevision,
            order.planned.orderGlobalId,
            source.order_row_version,
            candidate.id,
            candidate.global_id,
            candidate.row_version,
            'canonical-test-source-v1',
            candidateSourceHash,
            shopifyTestStorePersistence
              .shopifyTestStoreCanonicalE2eProofHash(proof),
            proof.providerOrderUpdatedAt,
            proof.providerVerifiedAt,
          ],
        )
        await predecessor.query('COMMIT')
      } catch (error) {
        await predecessor.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        predecessor.release()
      }
      const unrelatedProfileChange = await pool.query(
        `UPDATE operations_activation_scopes
         SET state = 'frozen', revision = revision + 1,
             reason = 'Canonical test-order authority is profile independent',
             updated_by = $2, updated_at = now()
         WHERE organization_id = $1::uuid
         RETURNING revision`,
        [fixture.organizationId, fixture.email],
      )
      assert.notEqual(
        Number(unrelatedProfileChange.rows[0].revision),
        proof.activationRevision,
        'The authorization proof must survive an unrelated profile revision change',
      )
      const [authorization, replay] = await Promise.all([
        shopifyTestStorePersistence
          .persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres(
            authorizationInput,
          ),
        shopifyTestStorePersistence
          .persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres(
            authorizationInput,
          ),
      ])
      assert.equal(replay.authorizationGlobalId, authorization.authorizationGlobalId)
      assert.deepEqual(
        [authorization.replayed, replay.replayed].sort(),
        [false, true],
        'Concurrent exact authorization must create once and replay once',
      )
      await assert.rejects(
        () => shopifyTestStorePersistence
          .persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
            ...authorizationInput,
            reason: 'Conflicting semantics under a reused authorization key',
          }),
        (error) => error?.code === 'SHOPIFY_TEST_E2E_IDEMPOTENCY_CONFLICT',
        'A reused authorization key with different semantics must fail closed',
      )
      const authorizationRow = await pool.query(
        `SELECT auth.id::text, auth.global_id,
                evidence.authorization_idempotency_key,
                evidence.authorization_request_hash
         FROM operations_sandbox_commerce_e2e_authorizations auth
         JOIN operations_shopify_test_store_e2e_evidence evidence
           ON evidence.organization_id = auth.organization_id
          AND evidence.authorization_id = auth.id
         WHERE auth.organization_id = $1::uuid AND auth.global_id = $2`,
        [fixture.organizationId, authorization.authorizationGlobalId],
      )
      assert.equal(authorizationRow.rowCount, 1)
      assert.equal(
        authorizationRow.rows[0].authorization_idempotency_key,
        authorizationInput.idempotencyKey,
      )
      assert.match(
        authorizationRow.rows[0].authorization_request_hash,
        /^[a-f0-9]{64}$/,
      )
      return {
        fixture,
        order,
        source,
        target: {
          externalShopId,
          externalOrderId,
          activationRevision,
          candidate,
          candidateSourceHash,
          proof,
          authorizationInput,
        },
        authorization: authorizationRow.rows[0],
      }
    }

    const canonical = await createCanonicalShopifyTestFixture(
      'canonical-shopify-test-store',
    )
    const authorizationProviderPreparationBaseline =
      shopifyFulfillmentPreparationCalls
    const authorizationProviderExecutionBaseline =
      shopifyFulfillmentExecutionCalls
    await assert.rejects(
      () => shopifyTestStorePersistence
        .persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
          ...canonical.target.authorizationInput,
          proof: {
            ...canonical.target.proof,
            providerVerifiedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
            providerOrderUpdatedAt:
              new Date(Date.now() - 7 * 60_000).toISOString(),
          },
        }),
      (error) => error?.code === 'SHOPIFY_TEST_E2E_PROOF_STALE',
      'Authorization must reject stale positive provider proof',
    )
    await assert.rejects(
      () => shopifyTestStorePersistence
        .persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
          ...canonical.target.authorizationInput,
          proof: { ...canonical.target.proof, test: false },
        }),
      (error) => error?.code === 'SHOPIFY_TEST_E2E_PROVIDER_TEST_REQUIRED',
      'Authorization must reject any proof other than exact test=true',
    )
    await assert.rejects(
      () => shopifyTestStorePersistence
        .persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
          ...canonical.target.authorizationInput,
          reason: 'A different concurrent authorization must not coexist',
          idempotencyKey: `canonical-authorize-conflict-${randomUUID()}`,
        }),
      (error) => error?.code === 'SHOPIFY_TEST_E2E_AUTHORIZATION_ALREADY_ACTIVE',
      'Only one exact canonical Shopify test-store authorization may be active',
    )
    await assert.rejects(
      () => shopifyTestStorePersistence
        .assertActiveShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
          organizationId: randomUUID(),
          actorEmail: canonical.fixture.email,
          authorizationGlobalId: canonical.authorization.global_id,
          orderGlobalId: canonical.order.planned.orderGlobalId,
          expectedOrderRowVersion: canonical.order.packed.rowVersion,
        }),
      (error) => error?.code === 'SHOPIFY_TEST_E2E_AUTHORIZATION_REQUIRED',
      'Cross-organization authority must fail closed',
    )
    await assert.rejects(
      () => shopifyTestStorePersistence
        .assertActiveShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
          organizationId: canonical.fixture.organizationId,
          actorEmail: canonical.fixture.email,
          authorizationGlobalId: canonical.authorization.global_id,
          orderGlobalId: 'gor0000000',
          expectedOrderRowVersion: canonical.order.packed.rowVersion,
        }),
      (error) => error?.code === 'SHOPIFY_TEST_E2E_AUTHORIZATION_REQUIRED',
      'Cross-order authority must fail closed',
    )
    await assert.rejects(
      () => shopifyTestStorePersistence
        .assertActiveShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
          organizationId: canonical.fixture.organizationId,
          actorEmail: 'different-owner@example.com',
          authorizationGlobalId: canonical.authorization.global_id,
          orderGlobalId: canonical.order.planned.orderGlobalId,
          expectedOrderRowVersion: canonical.order.packed.rowVersion,
        }),
      (error) => error?.code === 'SHOPIFY_TEST_E2E_AUTHORIZATION_REQUIRED',
      'Authorization must remain bound to the exact owner/admin actor',
    )

    const mutateCanonicalContext = async (sql, params = []) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(sql, params)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
    for (const activationState of [
      'disabled',
      'shadow',
      'read_only',
      'active',
      'frozen',
    ]) {
      await mutateCanonicalContext(
        `UPDATE operations_activation_scopes
         SET state = $2
         WHERE organization_id = $1::uuid`,
        [canonical.fixture.organizationId, activationState],
      )
      await shopifyTestStorePersistence
        .assertActiveShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
          organizationId: canonical.fixture.organizationId,
          actorEmail: canonical.fixture.email,
          authorizationGlobalId: canonical.authorization.global_id,
          orderGlobalId: canonical.order.planned.orderGlobalId,
          expectedOrderRowVersion: canonical.order.packed.rowVersion,
        })
    }
    await mutateCanonicalContext(
      `UPDATE operations_activation_scopes
       SET state = 'read_only'
       WHERE organization_id = $1::uuid`,
      [canonical.fixture.organizationId],
    )
    await mutateCanonicalContext(
      `WITH updated_account AS (
         UPDATE operations_integration_accounts
         SET commerce_credential_generation = 2
         WHERE organization_id = $1::uuid AND id = $2::uuid
         RETURNING id
       )
       UPDATE operations_commerce_credentials
       SET credential_version = 2
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND EXISTS (SELECT 1 FROM updated_account)`,
      [canonical.fixture.organizationId, canonical.source.account_id],
    )
    await assert.rejects(
      () => shopifyTestStorePersistence
        .assertActiveShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
          organizationId: canonical.fixture.organizationId,
          actorEmail: canonical.fixture.email,
          authorizationGlobalId: canonical.authorization.global_id,
          orderGlobalId: canonical.order.planned.orderGlobalId,
          expectedOrderRowVersion: canonical.order.packed.rowVersion,
        }),
      (error) => error?.code === 'SHOPIFY_TEST_E2E_AUTHORIZATION_STALE',
      'Credential-generation drift must invalidate authority',
    )
    await mutateCanonicalContext(
      `WITH updated_account AS (
         UPDATE operations_integration_accounts
         SET commerce_credential_generation = 1
         WHERE organization_id = $1::uuid AND id = $2::uuid
         RETURNING id
       )
       UPDATE operations_commerce_credentials
       SET credential_version = 1
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND EXISTS (SELECT 1 FROM updated_account)`,
      [canonical.fixture.organizationId, canonical.source.account_id],
    )
    await mutateCanonicalContext(
      `UPDATE operations_commerce_order_candidates
       SET source_hash = repeat('9', 64)
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [canonical.fixture.organizationId, canonical.target.candidate.id],
    )
    await assert.rejects(
      () => shopifyTestStorePersistence
        .assertActiveShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
          organizationId: canonical.fixture.organizationId,
          actorEmail: canonical.fixture.email,
          authorizationGlobalId: canonical.authorization.global_id,
          orderGlobalId: canonical.order.planned.orderGlobalId,
          expectedOrderRowVersion: canonical.order.packed.rowVersion,
        }),
      (error) => error?.code === 'SHOPIFY_TEST_E2E_AUTHORIZATION_STALE',
      'Candidate-source drift must invalidate authority',
    )
    await mutateCanonicalContext(
      `UPDATE operations_commerce_order_candidates
       SET source_hash = $3
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        canonical.fixture.organizationId,
        canonical.target.candidate.id,
        canonical.target.candidateSourceHash,
      ],
    )

    const expireAndRenewCanonical = async (stage) => {
      await mutateCanonicalContext(
        `WITH expired_authorization AS (
           UPDATE operations_sandbox_commerce_e2e_authorizations
           SET authorized_at = now() - interval '10 minutes',
               expires_at = now() - interval '5 minutes'
           WHERE organization_id = $1::uuid AND id = $2::uuid
           RETURNING id
         ), updated_order AS (
           UPDATE operations_orders
           SET status = $3
           WHERE organization_id = $1::uuid AND id = $4::uuid
             AND EXISTS (SELECT 1 FROM expired_authorization)
           RETURNING id
         )
         UPDATE operations_fulfillment_plans
         SET status = CASE WHEN $3 = 'planned' THEN 'planned' ELSE 'released' END
         WHERE organization_id = $1::uuid AND id = $5::uuid
           AND EXISTS (SELECT 1 FROM updated_order)`,
        [
          canonical.fixture.organizationId,
          canonical.authorization.id,
          stage,
          canonical.source.order_id,
          canonical.source.plan_id,
        ],
      )
      await assert.rejects(
        () => shopifyTestStorePersistence
          .assertActiveShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
            organizationId: canonical.fixture.organizationId,
            actorEmail: canonical.fixture.email,
            authorizationGlobalId: canonical.authorization.global_id,
            orderGlobalId: canonical.order.planned.orderGlobalId,
            expectedOrderRowVersion: canonical.order.packed.rowVersion,
          }),
        (error) => error?.code === 'SHOPIFY_TEST_E2E_AUTHORIZATION_EXPIRED',
        `Expired ${stage} authority must fail closed before renewal`,
      )
      const verifiedAt = new Date()
      const renewed = await shopifyTestStorePersistence
        .persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
          ...canonical.target.authorizationInput,
          idempotencyKey: `canonical-renew-${stage}-${randomUUID()}`,
          proof: {
            ...canonical.target.proof,
            providerVerifiedAt: verifiedAt.toISOString(),
          },
        })
      const renewedRow = await pool.query(
        `SELECT id::text, global_id
         FROM operations_sandbox_commerce_e2e_authorizations
         WHERE organization_id = $1::uuid AND global_id = $2`,
        [canonical.fixture.organizationId, renewed.authorizationGlobalId],
      )
      assert.equal(renewedRow.rowCount, 1)
      canonical.authorization = renewedRow.rows[0]
      await shopifyTestStorePersistence
        .assertActiveShopifyTestStoreCanonicalE2eAuthorizationInPostgres({
          organizationId: canonical.fixture.organizationId,
          actorEmail: canonical.fixture.email,
          authorizationGlobalId: canonical.authorization.global_id,
          orderGlobalId: canonical.order.planned.orderGlobalId,
          expectedOrderRowVersion: canonical.order.packed.rowVersion,
          expectedOrderStatus: stage,
        })
    }
    await expireAndRenewCanonical('planned')
    await expireAndRenewCanonical('released')
    await expireAndRenewCanonical('packed')
    assert.equal(
      shopifyFulfillmentPreparationCalls,
      authorizationProviderPreparationBaseline,
      'Authorization, expiry, and renewal must not prepare a provider write',
    )
    assert.equal(
      shopifyFulfillmentExecutionCalls,
      authorizationProviderExecutionBaseline,
      'Authorization, expiry, and renewal must not execute a provider write',
    )
    const canonicalConfirmation = await shopifyTestStorePersistence
      .confirmShopifyTestStoreCanonicalE2eFulfillmentInPostgres({
        organizationId: canonical.fixture.organizationId,
        actorEmail: canonical.fixture.email,
        idempotencyKey: 'canonical-fulfillment-confirmation-lost-response',
        authorizationGlobalId: canonical.authorization.global_id,
        orderGlobalId: canonical.order.planned.orderGlobalId,
        expectedOrderRowVersion: canonical.order.packed.rowVersion,
        confirmationStatement:
          shopifyTestStoreConstants.SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION,
        reason: 'Reviewed exact sandbox labels for canonical acceptance',
      })
    assert.equal(canonicalConfirmation.notifyCustomer, false)
    assert.equal(canonicalConfirmation.replayed, false)
    const canonicalConfirmationReplay = await shopifyTestStorePersistence
      .confirmShopifyTestStoreCanonicalE2eFulfillmentInPostgres({
        organizationId: canonical.fixture.organizationId,
        actorEmail: canonical.fixture.email,
        idempotencyKey: 'canonical-fulfillment-confirmation-lost-response',
        authorizationGlobalId: canonical.authorization.global_id,
        orderGlobalId: canonical.order.planned.orderGlobalId,
        expectedOrderRowVersion: canonical.order.packed.rowVersion,
        confirmationStatement:
          shopifyTestStoreConstants.SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION,
        reason: 'Reviewed exact sandbox labels for canonical acceptance',
      })
    assert.equal(canonicalConfirmationReplay.replayed, true)
    assert.equal(
      canonicalConfirmationReplay.confirmationHash,
      canonicalConfirmation.confirmationHash,
      'An exact lost-response retry must replay the immutable confirmation',
    )
    await assert.rejects(
      () => shopifyTestStorePersistence
        .confirmShopifyTestStoreCanonicalE2eFulfillmentInPostgres({
          organizationId: canonical.fixture.organizationId,
          actorEmail: canonical.fixture.email,
          idempotencyKey: 'canonical-fulfillment-confirmation-lost-response',
          authorizationGlobalId: canonical.authorization.global_id,
          orderGlobalId: canonical.order.planned.orderGlobalId,
          expectedOrderRowVersion: canonical.order.packed.rowVersion,
          confirmationStatement:
            shopifyTestStoreConstants.SHOPIFY_TEST_STORE_FULFILLMENT_CONFIRMATION,
          reason: 'Conflicting semantics under the retained fulfillment key',
        }),
      (error) => error?.code
        === 'SHOPIFY_TEST_E2E_FULFILLMENT_IDEMPOTENCY_CONFLICT',
      'A retained fulfillment key must reject changed semantics',
    )
    const confirmedSnapshot = await pool.query(
      `SELECT confirmation.label_evidence,
              confirmation.label_evidence_hash,
              confirmation.idempotency_key,
              confirmation.request_hash
       FROM operations_shopify_test_store_e2e_fulfillment_confirmations
         confirmation
       WHERE confirmation.organization_id = $1::uuid
         AND confirmation.authorization_id = $2::uuid`,
      [canonical.fixture.organizationId, canonical.authorization.id],
    )
    assert.equal(confirmedSnapshot.rowCount, 1)
    assert.equal(
      confirmedSnapshot.rows[0].idempotency_key,
      'canonical-fulfillment-confirmation-lost-response',
    )
    assert.match(confirmedSnapshot.rows[0].request_hash, /^[a-f0-9]{64}$/)
    const exactLabels = await pool.query(
      `SELECT package.global_id AS "packageGlobalId",
              label.global_id AS "labelGlobalId",
              label.tracking_number AS "trackingNumber"
       FROM operations_orders source_order
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = source_order.organization_id
        AND plan.order_id = source_order.id
       JOIN operations_packages package
         ON package.organization_id = plan.organization_id
        AND package.plan_id = plan.id
       JOIN operations_labels label
         ON label.organization_id = package.organization_id
        AND label.package_id = package.id
        AND label.status = 'created'
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2
       ORDER BY package.package_number, package.id`,
      [canonical.fixture.organizationId, canonical.order.planned.orderGlobalId],
    )
    assert.deepEqual(
      confirmedSnapshot.rows[0].label_evidence,
      exactLabels.rows,
      'Second confirmation persists the exact package, label, and tracking snapshot',
    )
    const beforeDrift = await orderEvidence(
      pool,
      canonical.fixture,
      canonical.order.planned.orderGlobalId,
    )
    const providerPreparationBeforeDrift = shopifyFulfillmentPreparationCalls
    const providerExecutionBeforeDrift = shopifyFulfillmentExecutionCalls
    const drift = await pool.connect()
    let replacementLabelId
    try {
      await drift.query('BEGIN')
      await drift.query('SET LOCAL session_replication_role = replica')
      const replaced = await drift.query(
        `UPDATE operations_labels
         SET status = 'voided', voided_at = now(), voided_by = $3
         WHERE organization_id = $1::uuid AND global_id = $2
         RETURNING organization_id::text, package_id::text,
                   carrier_rate_id::text, carrier, service_code,
                   format, label_payload, redacted_provider_evidence`,
        [
          canonical.fixture.organizationId,
          exactLabels.rows[0].labelGlobalId,
          canonical.fixture.email,
        ],
      )
      const old = replaced.rows[0]
      const replacement = await drift.query(
        `INSERT INTO operations_labels (
           organization_id, package_id, carrier_rate_id, carrier,
           service_code, tracking_number, format, label_payload,
           provider_label_id, idempotency_key, status, environment,
           redacted_provider_evidence
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5,
           'SANDBOX-REPLACED-AFTER-CONFIRMATION', $6, $7,
           'replacement-provider-label', $8, 'created', 'sandbox', $9::jsonb
         ) RETURNING id::text`,
        [
          canonical.fixture.organizationId,
          old.package_id,
          old.carrier_rate_id,
          old.carrier,
          old.service_code,
          old.format,
          old.label_payload,
          `canonical-replacement-${randomUUID()}`,
          JSON.stringify(old.redacted_provider_evidence),
        ],
      )
      replacementLabelId = replacement.rows[0].id
      await drift.query('COMMIT')
    } catch (error) {
      await drift.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      drift.release()
    }
    await assert.rejects(
      () => persistence.confirmOperationsOrderShipmentFromPostgres({
        organizationId: canonical.fixture.organizationId,
        actorEmail: canonical.fixture.email,
        orderGlobalId: canonical.order.planned.orderGlobalId,
        expectedRowVersion: canonical.order.packed.rowVersion,
        reason: 'Reject replacement after exact fulfillment confirmation',
        idempotencyKey: `canonical-label-drift-${randomUUID()}`,
        sandboxE2eAuthorizationGlobalId:
          canonical.authorization.global_id,
        expectedNotificationPolicyRevision: 1,
      }),
      (error) => (
        error?.code === 'SHOPIFY_TEST_E2E_CONFIRMED_LABEL_EVIDENCE_CHANGED'
      ),
    )
    const afterDrift = await orderEvidence(
      pool,
      canonical.fixture,
      canonical.order.planned.orderGlobalId,
    )
    assert.deepEqual(
      afterDrift,
      beforeDrift,
      'Label drift must produce zero order, shipment, inventory, or export mutation',
    )
    assert.equal(shopifyFulfillmentPreparationCalls, providerPreparationBeforeDrift)
    assert.equal(shopifyFulfillmentExecutionCalls, providerExecutionBeforeDrift)
    const restore = await pool.connect()
    try {
      await restore.query('BEGIN')
      await restore.query('SET LOCAL session_replication_role = replica')
      await restore.query(
        `DELETE FROM operations_labels
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [canonical.fixture.organizationId, replacementLabelId],
      )
      await restore.query(
        `UPDATE operations_labels
         SET status = 'created', voided_at = NULL, voided_by = NULL
         WHERE organization_id = $1::uuid AND global_id = $2`,
        [
          canonical.fixture.organizationId,
          exactLabels.rows[0].labelGlobalId,
        ],
      )
      await restore.query('COMMIT')
    } catch (error) {
      await restore.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      restore.release()
    }
    const canonicalShipment = await persistence
      .confirmOperationsOrderShipmentFromPostgres({
        organizationId: canonical.fixture.organizationId,
        actorEmail: canonical.fixture.email,
        orderGlobalId: canonical.order.planned.orderGlobalId,
        expectedRowVersion: canonical.order.packed.rowVersion,
        reason: 'Confirm exact matched canonical Shopify test shipment',
        idempotencyKey: `canonical-exact-shipment-${randomUUID()}`,
        sandboxE2eAuthorizationGlobalId:
          canonical.authorization.global_id,
        expectedNotificationPolicyRevision: 1,
      })
    assert.equal(canonicalShipment.orderStatus, 'shipped')
    assert.equal(canonicalShipment.customerNotification.notifyCustomer, false)
    assert.equal(shopifyFulfillmentExecutionCalls, providerExecutionBeforeDrift + 1)
    await mutateCanonicalContext(
      `UPDATE operations_commerce_fulfillment_exports
       SET state = 'processing', completed_at = NULL,
           provider_reference = NULL, error_code = NULL, error_message = NULL
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [
        canonical.fixture.organizationId,
        canonicalShipment.commerceExportGlobalId,
      ],
    )
    const exactProviderClaim = await shopifyTestStorePersistence
      .requireShopifyTestStoreFulfillmentWriteClaimInPostgres({
        organizationId: canonical.fixture.organizationId,
        accountGlobalId: canonical.source.account_global_id,
        externalOrderId: canonical.target.externalOrderId,
        authorizationGlobalId: canonical.authorization.global_id,
        commerceExportGlobalId: canonicalShipment.commerceExportGlobalId,
      })
    assert.equal(exactProviderClaim.notifyCustomer, false)
    assert.equal(exactProviderClaim.credentialGeneration, 1)
    const providerClaimPreparationBaseline = shopifyFulfillmentPreparationCalls
    const providerClaimExecutionBaseline = shopifyFulfillmentExecutionCalls
    for (const authorityMutation of [
      `payload_snapshot - 'sandboxE2eAuthorityKind'`,
      `jsonb_set(
        payload_snapshot,
        '{sandboxE2eAuthorityKind}',
        '"legacy_packed"'::jsonb,
        true
      )`,
    ]) {
      await mutateCanonicalContext(
        `UPDATE operations_commerce_fulfillment_exports
         SET payload_snapshot = ${authorityMutation}
         WHERE organization_id = $1::uuid AND global_id = $2`,
        [
          canonical.fixture.organizationId,
          canonicalShipment.commerceExportGlobalId,
        ],
      )
      await assert.rejects(
        () => shopifyTestStorePersistence
          .requireShopifyTestStoreFulfillmentWriteClaimInPostgres({
            organizationId: canonical.fixture.organizationId,
            accountGlobalId: canonical.source.account_global_id,
            externalOrderId: canonical.target.externalOrderId,
            authorizationGlobalId: canonical.authorization.global_id,
            commerceExportGlobalId: canonicalShipment.commerceExportGlobalId,
          }),
        (error) => error?.code === 'SHOPIFY_TEST_E2E_FULFILLMENT_CLAIM_INVALID',
        'Canonical provider claim must reject missing or cross-kind export evidence',
      )
      await mutateCanonicalContext(
        `UPDATE operations_commerce_fulfillment_exports
         SET payload_snapshot = jsonb_set(
           payload_snapshot,
           '{sandboxE2eAuthorityKind}',
           '"shopify_test_store_canonical"'::jsonb,
           true
         )
         WHERE organization_id = $1::uuid AND global_id = $2`,
        [
          canonical.fixture.organizationId,
          canonicalShipment.commerceExportGlobalId,
        ],
      )
    }
    await mutateCanonicalContext(
      `UPDATE operations_labels
       SET status = 'voided', voided_at = now(), voided_by = $3
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [
        canonical.fixture.organizationId,
        exactLabels.rows[0].labelGlobalId,
        canonical.fixture.email,
      ],
    )
    await assert.rejects(
      () => shopifyTestStorePersistence
        .requireShopifyTestStoreFulfillmentWriteClaimInPostgres({
          organizationId: canonical.fixture.organizationId,
          accountGlobalId: canonical.source.account_global_id,
          externalOrderId: canonical.target.externalOrderId,
          authorizationGlobalId: canonical.authorization.global_id,
          commerceExportGlobalId: canonicalShipment.commerceExportGlobalId,
        }),
      (error) => error?.code === 'SHOPIFY_TEST_E2E_FULFILLMENT_CLAIM_INVALID',
      'Voiding a confirmed label must invalidate the pre-provider claim',
    )
    assert.equal(shopifyFulfillmentPreparationCalls, providerClaimPreparationBaseline)
    assert.equal(shopifyFulfillmentExecutionCalls, providerClaimExecutionBaseline)

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
    const faireCommerceAccount = await pool.query(
      `UPDATE operations_integration_accounts integration
       SET provider = 'faire', environment = 'production',
           external_account_id = 'b_faire-shipment-acceptance',
           configuration = '{}'::jsonb
       FROM operations_orders source_order
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2
         AND integration.organization_id = source_order.organization_id
         AND integration.id = source_order.integration_account_id
       RETURNING integration.id::text`,
      [faireFixture.organizationId, faireOrder.planned.orderGlobalId],
    )
    assert.equal(faireCommerceAccount.rowCount, 1)
    await pool.query(
      `UPDATE operations_orders
       SET source_provider = 'faire',
           external_order_id = 'bo_faire_shipment_acceptance'
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [faireFixture.organizationId, faireOrder.planned.orderGlobalId],
    )
    await seedFocusedFaireProviderWriteAuthority({
      organizationId: faireFixture.organizationId,
      integrationAccountId: faireCommerceAccount.rows[0].id,
      externalAccountId: 'b_faire-shipment-acceptance',
      actorEmail: faireFixture.email,
    })
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
    const faireActivationClient = await pool.connect()
    let faireActivationResult
    try {
      await faireActivationClient.query('BEGIN')
      // The Faire authorization-evidence migrations own full promotion
      // acceptance. This focused shipment fixture starts after that boundary,
      // so bypass only activation validation while retaining every shipment,
      // inventory, export, and authorization-consumption guard under test.
      await faireActivationClient.query(
        'SET LOCAL session_replication_role = replica',
      )
      faireActivationResult = await faireActivationClient.query(
        `UPDATE operations_activation_scopes
         SET state = 'active', revision = revision + 1,
             reason = 'Authorized exact-order Faire sandbox E2E guard acceptance',
             updated_by = $2, updated_at = now()
         WHERE organization_id = $1::uuid
         RETURNING state, revision`,
        [faireFixture.organizationId, faireFixture.email],
      )
      await faireActivationClient.query('COMMIT')
    } catch (error) {
      await faireActivationClient.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      faireActivationClient.release()
    }
    assert.equal(faireActivationResult.rows[0]?.state, 'active')
    const originalRequireSandboxAuthorization =
      sandboxAuthorization.requireActiveSandboxCommerceE2eAuthorization
    const originalConsumeSandboxAuthorization =
      sandboxAuthorization.consumeSandboxCommerceE2eAuthorization
    const requireValidatedFaireSandboxAuthorization = async (client, input) => {
      const result = await client.query(
        `SELECT sandbox_auth.id::text, sandbox_auth.organization_id::text,
                sandbox_auth.order_id::text, sandbox_auth.authorized_by,
                sandbox_auth.confirmation_statement_version
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
    // Full Faire promotion acceptance proves the immutable authorization
    // evidence that lets this Active sandbox plan cross the plan-status
    // trigger. This focused fixture deliberately starts after that boundary.
    await pool.query(
      `ALTER TABLE operations_fulfillment_plans
       DISABLE TRIGGER validate_ops_plan_cartonization_evidence`,
    )
    try {
      const legacyProfile = await pool.query(
        `UPDATE operations_activation_scopes
         SET state = 'frozen', revision = revision + 1,
             reason = 'Faire Provider writes On is the connected mutation gate',
             updated_by = $2, updated_at = now()
         WHERE organization_id = $1::uuid
         RETURNING state`,
        [faireFixture.organizationId, faireFixture.email],
      )
      assert.equal(legacyProfile.rows[0]?.state, 'frozen')
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
      await pool.query(
        `ALTER TABLE operations_fulfillment_plans
         ENABLE TRIGGER validate_ops_plan_cartonization_evidence`,
      )
      sandboxAuthorization.requireActiveSandboxCommerceE2eAuthorization =
        originalRequireSandboxAuthorization
      sandboxAuthorization.consumeSandboxCommerceE2eAuthorization =
        originalConsumeSandboxAuthorization
    }
    assert.equal(authorizedFaireResult.orderStatus, 'shipped')
    const authorizedFaireExportEvidence = await pool.query(
      `SELECT state, error_code, error_message
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [
        faireFixture.organizationId,
        authorizedFaireResult.commerceExportGlobalId,
      ],
    )
    assert.equal(
      authorizedFaireResult.commerceExportState,
      'succeeded',
      JSON.stringify({
        result: authorizedFaireResult,
        export: authorizedFaireExportEvidence.rows[0],
      }),
    )
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

    // Pre-change exports did not persist providerWriteAuthority. A durable
    // provider attempt still binds this exact account, provider, order, and
    // export, so recovery must remain GET-only instead of stranding processing.
    const legacyFaireRecoveryExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key, updated_at
       )
       SELECT organization_id, order_id, shipment_id, provider,
              external_order_id, 'processing', 1,
              payload_snapshot - 'providerWriteAuthority',
              idempotency_key || ':legacy-no-provider-authority',
              now() - interval '6 minutes'
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id`,
      [
        faireFixture.organizationId,
        authorizedFaireResult.commerceExportGlobalId,
      ],
    )
    assert.equal(legacyFaireRecoveryExport.rowCount, 1)
    const legacyFaireRecoveryAttempt = await pool.query(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state, attempt_number,
         requested_at, created_by
       )
       SELECT organization_id, integration_account_id, action,
              'faire-fulfillment-writeback-v1',
              $3, idempotency_key || ':legacy-no-provider-authority',
              request_hash, redacted_request, '{}'::jsonb, 'prepared', 1,
              now() - interval '6 minutes', created_by
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid
         AND external_object_id = $2
         AND action = 'faire.fulfillment.shipments.create'
       ORDER BY requested_at DESC
       LIMIT 1
       RETURNING global_id`,
      [
        faireFixture.organizationId,
        authorizedFaireResult.commerceExportGlobalId,
        legacyFaireRecoveryExport.rows[0].global_id,
      ],
    )
    assert.equal(legacyFaireRecoveryAttempt.rowCount, 1)
    const fairePreparationsBeforeLegacyRecovery =
      faireFulfillmentPreparationCalls
    const faireExecutionsBeforeLegacyRecovery = faireFulfillmentExecutionCalls
    const legacyFaireRecovery = await persistence
      .retryOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: faireFixture.organizationId,
        actorEmail: faireFixture.email,
        commerceExportGlobalId: legacyFaireRecoveryExport.rows[0].global_id,
        reason: 'Reconcile legacy Faire attempt without a provider write',
        idempotencyKey: `legacy-faire-reconcile-${randomUUID()}`,
      })
    assert.equal(legacyFaireRecovery.state, 'succeeded')
    assert.equal(
      faireFulfillmentPreparationCalls,
      fairePreparationsBeforeLegacyRecovery,
    )
    assert.equal(
      faireFulfillmentExecutionCalls,
      faireExecutionsBeforeLegacyRecovery + 1,
    )
    assert.equal(faireFulfillmentInputs.at(-1).mode, 'reconcile_unknown')
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        faireFulfillmentInputs.at(-1),
        'providerAttemptGlobalId',
      ),
      false,
    )

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
                'authorizationRevision', 1,
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
    await pool.query(
      `INSERT INTO operations_commerce_provider_write_controls (
         organization_id, integration_account_id, provider, row_version,
         expected_row_version, requested_mode,
         bound_credential_generation, bound_granted_scopes,
         bound_granted_scope_digest, changed_by, changed_role,
         idempotency_key, request_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'faire', 2, 1, 'on', 1, $3::text[], $4,
         $5, 'owner', $6, repeat('e', 64)
       )`,
      [
        faireFixture.organizationId,
        faireCommerceAccount.rows[0].id,
        focusedProviderWriteGrantedScopes.faire,
        focusedProviderWriteScopeDigest.faire,
        faireFixture.email,
        `focused-faire-provider-writes-revision-2-${randomUUID()}`,
      ],
    )
    focusedProviderWriteControlRowVersion = 2
    faireFulfillmentAuthorizationRevision = 2
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
      focusedProviderWriteControlRowVersion,
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
      { state: 'failed', attempt_number: 1, revision: '1' },
      {
        state: 'succeeded',
        attempt_number: 2,
        revision: String(focusedProviderWriteControlRowVersion),
      },
    ])
    focusedProviderWriteControlRowVersion = 1

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
      `WITH updated_order AS (
         UPDATE operations_orders
         SET source_provider = 'shopify',
             external_order_id = 'gid://shopify/Order/6567'
         WHERE organization_id = $1::uuid AND global_id = $2
         RETURNING id, integration_account_id
       ), updated_account AS (
         UPDATE operations_integration_accounts account
         SET provider = 'shopify', integration_type = 'commerce',
             environment = 'sandbox', status = 'active',
             external_account_id = 'gid://shopify/Shop/6567',
             configuration = '{"shopDomain":"focused-shipment.myshopify.com"}'::jsonb,
             commerce_credential_generation = 1,
             updated_by = $3, updated_at = now()
         FROM updated_order
         WHERE account.organization_id = $1::uuid
           AND account.id = updated_order.integration_account_id
       )
       UPDATE operations_order_lines source_line
       SET external_line_id = 'gid://shopify/LineItem/6567'
       FROM updated_order
       WHERE source_line.organization_id = $1::uuid
         AND source_line.order_id = updated_order.id`,
      [
        authorizedFixture.organizationId,
        authorized.planned.orderGlobalId,
        authorizedFixture.email,
      ],
    )
    const authorizedShopifyAccount = await pool.query(
      `SELECT integration.id::text, integration.external_account_id
       FROM operations_orders source_order
       JOIN operations_integration_accounts integration
         ON integration.organization_id = source_order.organization_id
        AND integration.id = source_order.integration_account_id
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2`,
      [
        authorizedFixture.organizationId,
        authorized.planned.orderGlobalId,
      ],
    )
    assert.equal(authorizedShopifyAccount.rowCount, 1)
    await seedFocusedShopifyProviderWriteAuthority({
      organizationId: authorizedFixture.organizationId,
      integrationAccountId: authorizedShopifyAccount.rows[0].id,
      externalAccountId:
        authorizedShopifyAccount.rows[0].external_account_id,
      shopDomain: 'focused-shipment.myshopify.com',
      actorEmail: authorizedFixture.email,
    })
    const activationTelemetry = await pool.query(
      `UPDATE operations_activation_scopes
         SET state = 'active', revision = revision + 1,
             reason = 'Retain activation telemetry before exact authorization',
             updated_by = $2, updated_at = now()
         WHERE organization_id = $1::uuid
         RETURNING state`,
      [authorizedFixture.organizationId, authorizedFixture.email],
    )
    assert.equal(activationTelemetry.rows[0]?.state, 'active')
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
    const authorizedPreparationCallsBefore = shopifyFulfillmentPreparationCalls
    const authorizedExecutionCallsBefore = shopifyFulfillmentExecutionCalls
    useExactAuthorityShopifyWriteback = true
    turnProviderWritesOffBeforeShopifyExecution = true
    let authorizedResult
    try {
      authorizedResult = await persistence
        .confirmOperationsOrderShipmentFromPostgres(authorizedInput)
    } finally {
      useExactAuthorityShopifyWriteback = false
    }
    assert.equal(
      focusedProviderWritesOn,
      false,
      'Off after durable provider-attempt registration must not cancel the immutable in-flight attempt',
    )
    focusedProviderWritesOn = true
    assert.equal(authorizedResult.orderStatus, 'shipped')
    assert.equal(authorizedResult.replayed, false)
    assert.equal(
      shopifyFulfillmentPreparationCalls,
      authorizedPreparationCallsBefore + 1,
    )
    assert.equal(
      shopifyFulfillmentExecutionCalls,
      authorizedExecutionCallsBefore + 1,
    )
    assert.equal(exactProviderReadCalls, 2)
    assert.equal(
      exactProviderMutationCalls,
      1,
      'Active legacy shipment must reach the real Shopify prepare/execute path exactly once',
    )
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
      'gid://shopify/Fulfillment/6567',
    )
    assert.equal(authorizedProviderAttempt.rows[0].error_code, null)
    assert.equal(authorizedProviderAttempt.rows[0].redacted_request.version, 1)
    assert.equal(
      authorizedProviderAttempt.rows[0].redacted_request.notifyCustomer,
      false,
    )
    assert.equal(
      authorizedProviderAttempt.rows[0].redacted_request
        .sandboxE2eAuthorityKind,
      'legacy_packed',
      'The immutable provider attempt must bind exact legacy authority kind',
    )
    assert.deepEqual(
      authorizedProviderAttempt.rows[0].redacted_request
        .providerWriteAuthority,
      {
        accountGlobalId:
          authorizedProviderAttempt.rows[0].redacted_request
            .providerWriteAuthority.accountGlobalId,
        provider: 'shopify',
        environment: 'sandbox',
        controlRowVersion: focusedProviderWriteControlRowVersion,
        credentialGeneration: 1,
        grantedScopeDigest: focusedProviderWriteScopeDigest.shopify,
      },
      'The first durable provider attempt must seal exact current account, provider, environment, control, credential, and scope authority',
    )

    const zeroAttemptReauthorization = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key
       )
       SELECT organization_id, order_id, shipment_id, provider,
              external_order_id, 'queued', 0,
              jsonb_set(
                jsonb_set(
                  payload_snapshot,
                  '{providerWriteAuthority,controlRowVersion}',
                  '7'::jsonb
                ),
                '{providerWriteAuthority,credentialGeneration}',
                '1'::jsonb
              ),
              idempotency_key || ':zero-attempt-reauthorization'
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id, payload_snapshot`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    focusedProviderWritesOn = false
    const offBeforeRegistration = await persistence
      .executeOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: authorizedFixture.organizationId,
        actorEmail: authorizedFixture.email,
        commerceExportGlobalId: zeroAttemptReauthorization.rows[0].global_id,
        reason: 'Provider writes Off must reject before durable registration',
        auditEventKey:
          `zero-attempt-provider-off:${zeroAttemptReauthorization.rows[0].global_id}`,
      })
    assert.equal(offBeforeRegistration.state, 'failed')
    assert.equal(offBeforeRegistration.errorCode, 'COMMERCE_PROVIDER_WRITES_OFF')
    const noOffAttempt = await pool.query(
      `SELECT count(*)::int AS count
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid AND external_object_id = $2`,
      [authorizedFixture.organizationId, zeroAttemptReauthorization.rows[0].global_id],
    )
    assert.equal(noOffAttempt.rows[0].count, 0)
    focusedProviderWritesOn = true
    const reboundZeroAttempt = await persistence
      .executeOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: authorizedFixture.organizationId,
        actorEmail: authorizedFixture.email,
        commerceExportGlobalId: zeroAttemptReauthorization.rows[0].global_id,
        reason: 'Retry with newly reviewed current provider-write authority',
        auditEventKey:
          `zero-attempt-provider-on:${zeroAttemptReauthorization.rows[0].global_id}`,
      })
    assert.equal(reboundZeroAttempt.state, 'succeeded')
    const reboundAttempt = await pool.query(
      `SELECT redacted_request->'providerWriteAuthority' AS authority
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid AND external_object_id = $2`,
      [authorizedFixture.organizationId, zeroAttemptReauthorization.rows[0].global_id],
    )
    assert.deepEqual(reboundAttempt.rows[0].authority, {
      accountGlobalId:
        zeroAttemptReauthorization.rows[0].payload_snapshot
          .providerWriteAuthority.accountGlobalId,
      provider: 'shopify',
      environment: 'sandbox',
      controlRowVersion: focusedProviderWriteControlRowVersion,
      credentialGeneration: 1,
      grantedScopeDigest: focusedProviderWriteScopeDigest.shopify,
    })
    assert.equal(
      zeroAttemptReauthorization.rows[0].payload_snapshot
        .providerWriteAuthority.controlRowVersion,
      7,
      'The shipment-time authority remains immutable provenance after first-attempt reauthorization',
    )

    const crossAccountExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key
       )
       SELECT organization_id, order_id, shipment_id, provider,
              external_order_id, 'queued', 0,
              jsonb_set(
                payload_snapshot,
                '{providerWriteAuthority,accountGlobalId}',
                to_jsonb('gia1234567'::text)
              ),
              idempotency_key || ':cross-account-authority'
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    const crossAccountRejected = await persistence
      .executeOperationsCommerceFulfillmentExportFromPostgres({
        organizationId: authorizedFixture.organizationId,
        actorEmail: authorizedFixture.email,
        commerceExportGlobalId: crossAccountExport.rows[0].global_id,
        reason: 'Reject a provider-write snapshot bound to another account',
        auditEventKey:
          `cross-account-provider-authority:${crossAccountExport.rows[0].global_id}`,
      })
    assert.equal(crossAccountRejected.state, 'failed')
    assert.equal(
      crossAccountRejected.errorCode,
      'OPERATIONS_PROVIDER_WRITE_AUTHORITY_MISMATCH',
    )
    const crossAccountAttempts = await pool.query(
      `SELECT count(*)::int AS count
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid AND external_object_id = $2`,
      [authorizedFixture.organizationId, crossAccountExport.rows[0].global_id],
    )
    assert.equal(crossAccountAttempts.rows[0].count, 0)
    focusedProviderCredentialGenerationOverride = null
    const legacyClaimContext = await pool.query(
      `SELECT account.global_id AS account_global_id,
              export.payload_snapshot
       FROM operations_commerce_fulfillment_exports export
       JOIN operations_orders source_order
         ON source_order.organization_id = export.organization_id
        AND source_order.id = export.order_id
       JOIN operations_integration_accounts account
         ON account.organization_id = source_order.organization_id
        AND account.id = source_order.integration_account_id
       WHERE export.organization_id = $1::uuid AND export.global_id = $2`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    assert.equal(
      legacyClaimContext.rows[0].payload_snapshot.sandboxE2eAuthorityKind,
      'legacy_packed',
      'The immutable export snapshot must bind exact legacy authority kind',
    )
    const legacyClaimProviderReadsBefore = exactProviderReadCalls
    const legacyClaimProviderMutationsBefore = exactProviderMutationCalls
    const retainedLegacyClaimExport = await pool.query(
      `INSERT INTO operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, attempts, payload_snapshot, idempotency_key
       )
       SELECT organization_id, order_id, shipment_id, provider,
              external_order_id, 'processing', 1,
              payload_snapshot - 'sandboxE2eAuthorityKind'
                               - 'customerNotification',
              idempotency_key || ':retained-legacy-claim'
       FROM operations_commerce_fulfillment_exports
       WHERE organization_id = $1::uuid AND global_id = $2
       RETURNING global_id`,
      [authorizedFixture.organizationId, authorizedResult.commerceExportGlobalId],
    )
    const legacyClaimExportGlobalIds = [
      zeroAttemptReauthorization.rows[0].global_id,
      crossAccountExport.rows[0].global_id,
      retainedLegacyClaimExport.rows[0].global_id,
    ]
    const retainedLegacyClaim = await sandboxAuthorization
      .requireLegacySandboxCommerceE2eFulfillmentWriteClaimInPostgres({
        organizationId: authorizedFixture.organizationId,
        accountGlobalId: legacyClaimContext.rows[0].account_global_id,
        externalOrderId: 'gid://shopify/Order/6567',
        authorizationGlobalId,
        commerceExportGlobalId: retainedLegacyClaimExport.rows[0].global_id,
      })
    assert.equal(retainedLegacyClaim.authorityKind, 'legacy_packed')
    assert.equal(retainedLegacyClaim.authorityKindPersisted, false)
    assert.equal(retainedLegacyClaim.notifyCustomer, false)

    for (const [suffix, payloadExpression] of [
      [
        'cross-kind',
        `jsonb_set(payload_snapshot,
          '{sandboxE2eAuthorityKind}',
          '"shopify_test_store_canonical"'::jsonb, true)`,
      ],
      [
        'unsafe-notify',
        `jsonb_set(
          payload_snapshot - 'sandboxE2eAuthorityKind',
          '{customerNotification,notifyCustomer}',
          'true'::jsonb, true
        )`,
      ],
      [
        'missing-notification-new-kind',
        `payload_snapshot - 'customerNotification'`,
      ],
      [
        'missing-authorization',
        `payload_snapshot - 'sandboxE2eAuthorizationGlobalId'`,
      ],
    ]) {
      const invalidLegacyClaimExport = await pool.query(
        `INSERT INTO operations_commerce_fulfillment_exports (
           organization_id, order_id, shipment_id, provider,
           external_order_id, state, attempts, payload_snapshot,
           idempotency_key
         )
         SELECT organization_id, order_id, shipment_id, provider,
                external_order_id, 'processing', 1,
                ${payloadExpression}, idempotency_key || $3
         FROM operations_commerce_fulfillment_exports
         WHERE organization_id = $1::uuid AND global_id = $2
         RETURNING global_id`,
        [
          authorizedFixture.organizationId,
          authorizedResult.commerceExportGlobalId,
          `:${suffix}`,
        ],
      )
      legacyClaimExportGlobalIds.push(
        invalidLegacyClaimExport.rows[0].global_id,
      )
      await assert.rejects(
        () => sandboxAuthorization
          .requireLegacySandboxCommerceE2eFulfillmentWriteClaimInPostgres({
            organizationId: authorizedFixture.organizationId,
            accountGlobalId: legacyClaimContext.rows[0].account_global_id,
            externalOrderId: 'gid://shopify/Order/6567',
            authorizationGlobalId,
            commerceExportGlobalId:
              invalidLegacyClaimExport.rows[0].global_id,
          }),
        (error) => error?.code === 'SANDBOX_E2E_FULFILLMENT_CLAIM_INVALID',
        `${suffix} legacy authority evidence must fail closed`,
      )
    }
    const legacyClaimCleanup = await pool.connect()
    try {
      await legacyClaimCleanup.query('BEGIN')
      await legacyClaimCleanup.query(
        'SET LOCAL session_replication_role = replica',
      )
      await legacyClaimCleanup.query(
        `DELETE FROM operations_commerce_fulfillment_exports
         WHERE organization_id = $1::uuid AND global_id = ANY($2::text[])`,
        [authorizedFixture.organizationId, legacyClaimExportGlobalIds],
      )
      await legacyClaimCleanup.query('COMMIT')
    } catch (error) {
      await legacyClaimCleanup.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      legacyClaimCleanup.release()
    }
    assert.equal(exactProviderReadCalls, legacyClaimProviderReadsBefore)
    assert.equal(
      exactProviderMutationCalls,
      legacyClaimProviderMutationsBefore,
      'Rejected and retained-compatibility claim probes must make zero provider calls',
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
              external_order_id, 'processing', 1,
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
      [faireFixture.organizationId, authorizedFaireResult.commerceExportGlobalId],
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
    focusedProviderWriteControlRowVersion = 2
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
        faireFixture.organizationId,
        fairePreDispatchCrashExport.rows[0].global_id,
      ],
    )
    assert.deepEqual(faireCrashAttempts.rows, [{
      state: 'succeeded',
      attempt_number: 2,
    }])
    focusedProviderWriteControlRowVersion = 1

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
              ) - 'providerWriteAuthority',
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
         lease_token, lease_expires_at, requested_at, created_by
       )
       SELECT attempt.organization_id, attempt.integration_account_id,
              attempt.action, attempt.adapter_version,
              $3, attempt.idempotency_key || ':stale-shopify-recovery',
              attempt.request_hash, attempt.redacted_request, '{}'::jsonb,
              'prepared', 1, $4::uuid, now() + interval '5 minutes',
              now(), attempt.created_by
       FROM operations_commerce_provider_attempts attempt
       WHERE attempt.organization_id = $1::uuid
         AND attempt.external_object_id = $2
         AND attempt.action = 'shopify.fulfillment.create'
       ORDER BY attempt.requested_at DESC
       LIMIT 1
       RETURNING id::text, global_id`,
      [
        authorizedFixture.organizationId,
        authorizedResult.commerceExportGlobalId,
        staleShopifyExport.rows[0].global_id,
        randomUUID(),
      ],
    )
    assert.equal(staleShopifyProviderAttempt.rowCount, 1)
    const ageStaleShopifyAttempt = await pool.connect()
    try {
      await ageStaleShopifyAttempt.query('BEGIN')
      await ageStaleShopifyAttempt.query(
        'SET LOCAL session_replication_role = replica',
      )
      await ageStaleShopifyAttempt.query(
        `UPDATE operations_commerce_provider_attempts
         SET requested_at = now() - interval '6 minutes',
             lease_expires_at = now() - interval '1 minute'
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [
          authorizedFixture.organizationId,
          staleShopifyProviderAttempt.rows[0].id,
        ],
      )
      await ageStaleShopifyAttempt.query('COMMIT')
    } catch (error) {
      await ageStaleShopifyAttempt.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      ageStaleShopifyAttempt.release()
    }
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
      `The first stale recovery must perform exactly one read-only reconciliation: ${JSON.stringify(fencedStaleShopifyExport)}`,
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

    const nativeFixture = await createFixture('native-one-off-multi-package')
    const nativeOrder = await advanceOrderToPacked(
      persistence,
      nativeFixture,
      'native-one-off-multi-package',
    )
    await splitPackedOrderIntoTwoPackagesForFixture(
      pool,
      nativeFixture,
      nativeOrder.planned.orderGlobalId,
    )
    await addPackagingClaim(
      pool,
      nativeFixture,
      nativeOrder.planned.orderGlobalId,
    )
    const nativeGroup = await seedNativeOneOffCarrierGroup(
      pool,
      nativeFixture,
      nativeOrder.planned.orderGlobalId,
    )
    const nativeConfirmInput = {
      organizationId: nativeFixture.organizationId,
      actorEmail: nativeFixture.email,
      orderGlobalId: nativeOrder.planned.orderGlobalId,
      expectedRowVersion: nativeOrder.packed.rowVersion,
      reason: 'Confirm complete native one-off TEST carrier group',
      idempotencyKey: `confirm-native-one-off-${randomUUID()}`,
    }
    const nativeConfirmed = await persistence
      .confirmOperationsOrderShipmentFromPostgres(nativeConfirmInput)
    assert.equal(nativeConfirmed.orderStatus, 'shipped')
    assert.equal(nativeConfirmed.replayed, false)
    const nativeShipmentEvidence = await pool.query(
      `SELECT shipment.global_id, shipment.package_id::text,
              shipment.quoted_carrier_cost_minor::text,
              carrier_group.global_id AS carrier_group_global_id
       FROM operations_shipments shipment
       JOIN operations_orders source_order
         ON source_order.organization_id = shipment.organization_id
        AND source_order.id = shipment.order_id
       JOIN operations_one_off_carrier_group_attempts carrier_group
         ON carrier_group.organization_id = shipment.organization_id
        AND carrier_group.id = shipment.one_off_carrier_group_attempt_id
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2
       ORDER BY shipment.package_id`,
      [nativeFixture.organizationId, nativeOrder.planned.orderGlobalId],
    )
    assert.equal(nativeShipmentEvidence.rowCount, 2)
    assert.deepEqual(
      [...new Set(nativeShipmentEvidence.rows.map(
        (row) => row.carrier_group_global_id,
      ))],
      [nativeGroup.groupAttemptGlobalId],
    )
    assert.equal(
      nativeShipmentEvidence.rows.reduce(
        (sum, row) => sum + Number(row.quoted_carrier_cost_minor),
        0,
      ),
      nativeGroup.selectedAmountMinor,
      'Per-package shipment allocations must sum to the whole-group selected amount',
    )
    const nativeReplay = await persistence
      .confirmOperationsOrderShipmentFromPostgres(nativeConfirmInput)
    assert.equal(nativeReplay.replayed, true)
    assert.equal(nativeReplay.shipmentGlobalId, nativeConfirmed.shipmentGlobalId)
    const nativeShipmentCountAfterReplay = await pool.query(
      `SELECT count(*)::int AS count
       FROM operations_shipments shipment
       JOIN operations_orders source_order
         ON source_order.organization_id = shipment.organization_id
        AND source_order.id = shipment.order_id
       WHERE source_order.organization_id = $1::uuid
         AND source_order.global_id = $2`,
      [nativeFixture.organizationId, nativeOrder.planned.orderGlobalId],
    )
    assert.equal(nativeShipmentCountAfterReplay.rows[0].count, 2)

    for (const scenario of [
      {
        name: 'partial',
        seed: { omitLastResult: true },
        errorCode: 'OPERATIONS_ONE_OFF_GROUP_PARTIAL',
      },
      {
        name: 'allocation-mismatch',
        seed: { mismatchedAllocation: true },
        errorCode: 'OPERATIONS_ONE_OFF_GROUP_PARTIAL',
      },
      {
        name: 'carrier-mismatch',
        seed: { wrongCarrier: true },
        errorCode: 'OPERATIONS_ONE_OFF_GROUP_PARTIAL',
      },
      {
        name: 'service-mismatch',
        seed: { wrongService: true },
        errorCode: 'OPERATIONS_ONE_OFF_GROUP_PARTIAL',
      },
      {
        name: 'unknown',
        seed: { state: 'unknown' },
        errorCode: 'OPERATIONS_ONE_OFF_GROUP_UNRESOLVED',
      },
      {
        name: 'voided',
        seed: { closed: true },
        errorCode: 'OPERATIONS_ONE_OFF_GROUP_CLOSED',
      },
    ]) {
      const fixture = await createFixture(`native-one-off-${scenario.name}`)
      const order = await advanceOrderToPacked(
        persistence,
        fixture,
        `native-one-off-${scenario.name}`,
      )
      await splitPackedOrderIntoTwoPackagesForFixture(
        pool,
        fixture,
        order.planned.orderGlobalId,
      )
      await seedNativeOneOffCarrierGroup(
        pool,
        fixture,
        order.planned.orderGlobalId,
        scenario.seed,
      )
      await expectRejected(
        () => persistence.confirmOperationsOrderShipmentFromPostgres({
          organizationId: fixture.organizationId,
          actorEmail: fixture.email,
          orderGlobalId: order.planned.orderGlobalId,
          expectedRowVersion: order.packed.rowVersion,
          reason: `Reject ${scenario.name} native one-off carrier group`,
          idempotencyKey: `confirm-native-${scenario.name}-${randomUUID()}`,
        }),
        (error) => error?.code === scenario.errorCode,
        `${scenario.name} native one-off carrier group must not confirm`,
      )
    }
    assert.ok(
      focusedProviderWriteChecks > focusedProviderWriteOffRejections,
      'Connected shipment success must recheck exact Provider writes authority',
    )
    assert.equal(
      focusedProviderWriteOffRejections,
      3,
      'Shopify, Faire, and zero-attempt retry must reject Provider writes Off independently of the legacy profile',
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
  const oneOffExecutionMigration = read(
    'db/migrations/0263_operations_one_off_execution.sql',
  )
  for (const fragment of [
    'operations_one_off_carrier_group_attempts',
    'operations_one_off_carrier_group_members',
    'allocated_selected_cost_minor',
    'operations_one_off_carrier_group_results',
    'one_off_carrier_group_attempt_id',
    'validate_operations_one_off_group_shipment',
  ]) {
    assert.ok(
      oneOffExecutionMigration.includes(fragment),
      `One-off shipment confirmation migration is missing ${fragment}`,
    )
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
    'lockNativeOneOffShipmentAuthority',
    'allocatedCostByPackageId',
    'one_off_carrier_group_attempt_id',
    'OPERATIONS_ONE_OFF_GROUP_PARTIAL',
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
