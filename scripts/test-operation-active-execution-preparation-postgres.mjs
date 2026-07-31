#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
const root = process.cwd()
const actorEmail = 'active-preparation-test@episcs.com'
const HASH = Object.freeze({
  input: '1'.repeat(64),
  result: '2'.repeat(64),
  request: '3'.repeat(64),
  package1: '4'.repeat(64),
  package2: '5'.repeat(64),
})

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}, globals = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    BigInt,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
    ...globals,
  }, { filename: path })
  return module.exports
}

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
      max: 1,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      await pool.end().catch(() => {})
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message)
  }
  return String(error)
}

let errorSavepointSequence = 0

async function expectServiceError(client, label, pattern, operation) {
  errorSavepointSequence += 1
  const savepoint = `active_preparation_error_${errorSavepointSequence}`
  await client.query(`SAVEPOINT ${savepoint}`)
  let caught = null
  try {
    await operation()
  } catch (error) {
    caught = error
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
  await client.query(`RELEASE SAVEPOINT ${savepoint}`)
  assert.ok(caught, `${label} unexpectedly succeeded`)
  assert.match(errorMessage(caught), pattern, `${label} rejected incorrectly`)
}

function loadPreparationService(fetchCalls) {
  const activeContract = loadTypeScriptModule(
    'app_src/lib/operations/activeFulfillmentExecution.ts',
  )
  return loadTypeScriptModule(
    'app_src/lib/operations/activeFulfillmentExecutionPreparation.ts',
    {
      '@/lib/operations/activeFulfillmentExecution': activeContract,
      '@/lib/persistence/postgres': {
        acquireTransactionAdvisoryLock: (client, key) => client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [key],
        ),
        withTransaction() {
          throw new Error(
            'Acceptance must use the supplied disposable-Postgres transaction',
          )
        },
      },
    },
    {
      fetch() {
        fetchCalls.count += 1
        throw new Error('Active preparation must not call a provider')
      },
    },
  )
}

async function seedValidShadowSource(client, ids) {
  const destination = {
    name: 'Active preparation recipient',
    line1: '100 Destination Street',
    city: 'Hartford',
    region: 'CT',
    postalCode: '06103',
    countryCode: 'US',
  }
  const warehouseAddress = {
    line1: '7009 S 108th Street',
    city: 'La Vista',
    region: 'NE',
    postalCode: '68128',
    countryCode: 'US',
  }
  await client.query('SET LOCAL session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [actorEmail],
    )
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, reference_code
       ) VALUES
         ($1, 'Active preparation fixture', 'member', 'ga0009101'),
         ($2, 'Foreign preparation fixture', 'member', 'ga0009102')`,
      [ids.organization, ids.otherOrganization],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision
       ) VALUES
         ($1, $2, 'active', 7),
         ($3, $4, 'active', 7)`,
      [
        ids.organization,
        ids.pipeline,
        ids.otherOrganization,
        ids.otherPipeline,
      ],
    )
    await client.query(
      `INSERT INTO operations_orders (
         id, global_id, organization_id, pipeline_id, customer_id,
         integration_account_id, source_provider, external_order_id,
         order_number, status, currency, merchandise_total_minor,
         ship_to, source_payload
       ) VALUES (
         $1, 'gor0009101', $2, $3, $4, $5, 'shopify',
         'active-preparation-order-1', 'ACTIVE-PREP-1', 'packed', 'USD',
         2500, $6::jsonb, '{}'::jsonb
       )`,
      [
        ids.order,
        ids.organization,
        ids.pipeline,
        ids.customer,
        ids.commerceIntegration,
        JSON.stringify(destination),
      ],
    )
    await client.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, address, status
       ) VALUES (
         $1, 'gwh0009101', $2, 'ACTIVE-PREP',
         'Active preparation warehouse', $3::jsonb, 'active'
       )`,
      [ids.warehouse, ids.organization, JSON.stringify(warehouseAddress)],
    )
    await client.query(
      `INSERT INTO operations_fulfillment_plans (
         id, global_id, organization_id, order_id, warehouse_id,
         status, method, solver_status, estimated_cost_minor,
         promised_delivery_at, explanation
       ) VALUES (
         $1, 'gfp0009101', $2, $3, $4, 'released', 'optimizer',
         'optimal', 1800, now() + interval '3 days', '{}'::jsonb
       )`,
      [ids.plan, ids.organization, ids.order, ids.warehouse],
    )
    for (const [index, packageId] of ids.packages.entries()) {
      await client.query(
        `INSERT INTO operations_packages (
           id, global_id, organization_id, plan_id, package_number,
           length_mm, width_mm, height_mm, weight_grams, status
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 229, 178, $7, 'packed'
         )`,
        [
          packageId,
          `gpa000910${index + 1}`,
          ids.organization,
          ids.plan,
          index + 1,
          index === 0 ? 279 : 432,
          index === 0 ? 2500 : 5000,
        ],
      )
    }
    await client.query(
      `INSERT INTO operations_pack_rate_runs (
         id, global_id, organization_id, replay_group_key, scenario_id,
         source_kind, source_reference, provider, checkout_source, purpose,
         customer_resolution_outcome, status, policy_version,
         algorithm_version, input_hash, result_hash, input_snapshot,
         result_snapshot, stage_snapshot, line_count, package_count,
         rate_choice_count, currency, selected_provider,
         selected_service_code, selected_service_name,
         selected_carrier_cost_minor, customer_charge_minor, margin_minor,
         idempotency_key, pricing_semantics_version
       ) VALUES (
         $1, 'gprr0009101', $2, 'active-preparation-group',
         'active-preparation', 'active_commerce_candidate',
         'active-preparation-source', 'shopify', 'live_callback_recorded',
         'fulfillment_execution', 'not_attempted', 'succeeded',
         'active-preparation-policy-v1', 'active-preparation-algorithm-v1',
         $3, $4, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 2, 2,
         'USD', 'ups_rest', '03', 'UPS Ground', 1800, 1800, 0,
         'active-preparation-source-1', 2
       )`,
      [ids.sourceRun, ids.organization, HASH.input, HASH.result],
    )
    for (const [index, packageId] of ids.packages.entries()) {
      await client.query(
        `INSERT INTO operations_pack_rate_run_packages (
           organization_id, run_id, package_key, package_sequence,
           material_code, material_name, length_mm, width_mm, height_mm,
           content_weight_grams, tare_weight_grams, gross_weight_grams,
           allocation_count, package_hash, package_snapshot
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 229, 178, $8, 100, $9,
           1, $10, $11::jsonb
         )`,
        [
          ids.organization,
          ids.sourceRun,
          `box-${index + 1}`,
          index + 1,
          index === 0 ? 'AG12V2' : '20LB',
          index === 0 ? 'AG12V2' : '20lb Box',
          index === 0 ? 279 : 432,
          index === 0 ? 2400 : 4900,
          index === 0 ? 2500 : 5000,
          index === 0 ? HASH.package1 : HASH.package2,
          JSON.stringify({ packageId }),
        ],
      )
    }
    await client.query(
      `INSERT INTO operations_fulfillment_executions (
         id, global_id, organization_id, order_id, plan_id,
         checkout_pack_rate_run_id, fulfillment_pack_rate_run_id,
         authority_mode, state, idempotency_key, request_hash,
         provider_write_count, postage_purchase_count, label_write_count,
         commerce_write_count, prepared_by, completed_at
       ) VALUES (
         $1, 'gofe0009101', $2, $3, $4, $5, $5, 'shadow',
         'shadow_prepared', 'shadow-active-preparation-1', $6,
         0, 0, 0, 0, $7, now()
       )`,
      [
        ids.shadowExecution,
        ids.organization,
        ids.order,
        ids.plan,
        ids.sourceRun,
        HASH.request,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_shipment_groups (
         id, global_id, organization_id, fulfillment_execution_id,
         order_id, plan_id, warehouse_id, fulfillment_pack_rate_run_id,
         selected_provider, selected_service_code, selected_service_name,
         selected_carrier_cost_minor, currency, state, completed_at
       ) VALUES (
         $1, 'gshg0009101', $2, $3, $4, $5, $6, $7,
         'ups_rest', '03', 'UPS Ground', 1800, 'USD',
         'shadow_prepared', now()
       )`,
      [
        ids.shadowGroup,
        ids.organization,
        ids.shadowExecution,
        ids.order,
        ids.plan,
        ids.warehouse,
        ids.sourceRun,
      ],
    )
    for (const [index, packageId] of ids.packages.entries()) {
      await client.query(
        `INSERT INTO operations_fulfillment_execution_packages (
           organization_id, execution_id, shipment_group_id,
           fulfillment_pack_rate_run_id, package_id, package_key
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          ids.organization,
          ids.shadowExecution,
          ids.shadowGroup,
          ids.sourceRun,
          packageId,
          `box-${index + 1}`,
        ],
      )
    }
  } finally {
    await client.query('SET LOCAL session_replication_role = origin')
  }
}

async function mutateFixture(client, statement, params = []) {
  await client.query('SET LOCAL session_replication_role = replica')
  try {
    await client.query(statement, params)
  } finally {
    await client.query('SET LOCAL session_replication_role = origin')
  }
}

async function verifyAcceptance(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'clawpilot-active-execution-preparation-acceptance',
    max: 1,
  })
  const client = await pool.connect()
  const ids = {
    organization: randomUUID(),
    otherOrganization: randomUUID(),
    pipeline: randomUUID(),
    otherPipeline: randomUUID(),
    customer: randomUUID(),
    commerceIntegration: randomUUID(),
    order: randomUUID(),
    warehouse: randomUUID(),
    plan: randomUUID(),
    sourceRun: randomUUID(),
    shadowExecution: randomUUID(),
    shadowGroup: randomUUID(),
    packages: [randomUUID(), randomUUID()],
  }
  const fetchCalls = { count: 0 }
  const preparation = loadPreparationService(fetchCalls)
  const prepare = (
    input,
  ) => preparation.prepareActiveFulfillmentExecutionFromShadowInPostgres(
    input,
    client,
  )
  const baseInput = {
    organizationId: ids.organization,
    shadowExecutionGlobalId: 'gofe0009101',
    expectedActivationRevision: 7,
    expectedOrderRowVersion: 0,
    reason: 'Prepare the verified Shopify Shadow package set for fulfillment',
    idempotencyKey: 'active-preparation-command-1',
    actorEmail,
  }

  try {
    await client.query('BEGIN')
    await seedValidShadowSource(client, ids)

    await expectServiceError(
      client,
      'cross_tenant_lookup',
      /not found|shadow preparation|organization/iu,
      () => prepare({ ...baseInput, organizationId: ids.otherOrganization }),
    )
    await mutateFixture(
      client,
      `UPDATE operations_activation_scopes
       SET state = 'shadow'
       WHERE organization_id = $1`,
      [ids.organization],
    )
    await expectServiceError(
      client,
      'non_active_authority',
      /Operations Active|active authority|activation/iu,
      () => prepare(baseInput),
    )
    await mutateFixture(
      client,
      `UPDATE operations_activation_scopes
       SET state = 'active'
       WHERE organization_id = $1`,
      [ids.organization],
    )
    await expectServiceError(
      client,
      'stale_activation_revision',
      /revision|Operations Active|activation/iu,
      () => prepare({ ...baseInput, expectedActivationRevision: 6 }),
    )

    await expectServiceError(
      client,
      'stale_order_row_version',
      /order row version|order version|exact current/iu,
      () => prepare({ ...baseInput, expectedOrderRowVersion: 1 }),
    )

    await mutateFixture(
      client,
      `INSERT INTO operations_exceptions (
         id, global_id, organization_id, order_id, exception_type,
         severity, status, title, details
       ) VALUES (
         $1, 'gex0009101', $2, $3, 'active_preparation_blocked',
         'critical', 'open', 'Blocking Active preparation exception',
         '{}'::jsonb
       )`,
      [randomUUID(), ids.organization, ids.order],
    )
    await expectServiceError(
      client,
      'open_critical_order_exception',
      /blocked|open|critical|exception/iu,
      () => prepare(baseInput),
    )
    await mutateFixture(
      client,
      `DELETE FROM operations_exceptions
       WHERE organization_id = $1 AND order_id = $2`,
      [ids.organization, ids.order],
    )

    await mutateFixture(
      client,
      `UPDATE operations_orders SET status = 'released' WHERE id = $1`,
      [ids.order],
    )
    await expectServiceError(
      client,
      'order_not_packed',
      /packed|order state|source state/iu,
      () => prepare(baseInput),
    )
    await mutateFixture(
      client,
      `UPDATE operations_orders SET status = 'packed' WHERE id = $1`,
      [ids.order],
    )

    await mutateFixture(
      client,
      `UPDATE operations_fulfillment_plans
       SET status = 'planned' WHERE id = $1`,
      [ids.plan],
    )
    await expectServiceError(
      client,
      'plan_not_released',
      /released|plan state|source state/iu,
      () => prepare(baseInput),
    )
    await mutateFixture(
      client,
      `UPDATE operations_fulfillment_plans
       SET status = 'released' WHERE id = $1`,
      [ids.plan],
    )

    await mutateFixture(
      client,
      `UPDATE operations_packages SET status = 'planned' WHERE id = $1`,
      [ids.packages[0]],
    )
    await expectServiceError(
      client,
      'package_not_packed',
      /packed|package state|package set/iu,
      () => prepare(baseInput),
    )
    await mutateFixture(
      client,
      `UPDATE operations_packages SET status = 'packed' WHERE id = $1`,
      [ids.packages[0]],
    )

    for (const field of ['length_mm', 'width_mm', 'height_mm', 'weight_grams']) {
      await mutateFixture(
        client,
        `UPDATE operations_packages SET ${field} = ${field} + 1 WHERE id = $1`,
        [ids.packages[0]],
      )
      await expectServiceError(
        client,
        `package_${field}_drift`,
        /dimensions|weight|immutable|evidence|drift/iu,
        () => prepare(baseInput),
      )
      await mutateFixture(
        client,
        `UPDATE operations_packages SET ${field} = ${field} - 1 WHERE id = $1`,
        [ids.packages[0]],
      )
    }

    await mutateFixture(
      client,
      `DELETE FROM operations_fulfillment_execution_packages
       WHERE organization_id = $1 AND execution_id = $2 AND package_id = $3`,
      [ids.organization, ids.shadowExecution, ids.packages[1]],
    )
    await expectServiceError(
      client,
      'incomplete_package_set',
      /package set|package count|exact package|packages/iu,
      () => prepare(baseInput),
    )
    await mutateFixture(
      client,
      `INSERT INTO operations_fulfillment_execution_packages (
         organization_id, execution_id, shipment_group_id,
         fulfillment_pack_rate_run_id, package_id, package_key
       ) VALUES ($1, $2, $3, $4, $5, 'box-2')`,
      [
        ids.organization,
        ids.shadowExecution,
        ids.shadowGroup,
        ids.sourceRun,
        ids.packages[1],
      ],
    )

    await client.query(
      `ALTER TABLE operations_fulfillment_executions
         DROP CONSTRAINT IF EXISTS
           operations_fulfillment_executions_provider_write_count_check,
         DROP CONSTRAINT IF EXISTS
           operations_fulfillment_executions_postage_purchase_count_check,
         DROP CONSTRAINT IF EXISTS
           operations_fulfillment_executions_label_write_count_check,
         DROP CONSTRAINT IF EXISTS
           operations_fulfillment_executions_commerce_write_count_check,
         DROP CONSTRAINT IF EXISTS
           operations_fulfillment_executions_authority_valid`,
    )
    await mutateFixture(
      client,
      `UPDATE operations_fulfillment_executions
       SET provider_write_count = 1,
           postage_purchase_count = 1,
           label_write_count = 1,
           commerce_write_count = 1
       WHERE id = $1`,
      [ids.shadowExecution],
    )
    await expectServiceError(
      client,
      'shadow_source_with_effects',
      /zero|write|postage|label|commerce|effect/iu,
      () => prepare(baseInput),
    )
    await mutateFixture(
      client,
      `UPDATE operations_fulfillment_executions
       SET provider_write_count = 0,
           postage_purchase_count = 0,
           label_write_count = 0,
           commerce_write_count = 0
       WHERE id = $1`,
      [ids.shadowExecution],
    )

    const first = await prepare(baseInput)
    assert.equal(first.replayed, false)
    const persisted = await client.query(
      `SELECT
         execution.id::text AS active_execution_id,
         execution.global_id AS active_execution_global_id,
         execution.shadow_fulfillment_execution_id::text,
         execution.order_id::text,
         execution.plan_id::text,
         execution.warehouse_id::text,
         execution.authority_mode,
         execution.state AS execution_state,
         execution.activation_revision,
         execution.expected_order_row_version::text,
         execution.reason,
         execution.idempotency_key,
         execution.request_hash,
         execution.prepared_by,
         shipment_group.id::text AS active_group_id,
         shipment_group.global_id AS active_group_global_id,
         shipment_group.shadow_shipment_group_id::text,
         shipment_group.selected_provider,
         shipment_group.selected_service_code,
         shipment_group.selected_service_name,
         shipment_group.selected_carrier_cost_minor::text,
         shipment_group.currency,
         shipment_group.package_count,
         shipment_group.state AS group_state
       FROM operations_active_fulfillment_executions execution
       JOIN operations_active_shipment_groups shipment_group
         ON shipment_group.organization_id = execution.organization_id
        AND shipment_group.active_fulfillment_execution_id = execution.id
       WHERE execution.organization_id = $1
         AND execution.shadow_fulfillment_execution_id = $2`,
      [ids.organization, ids.shadowExecution],
    )
    assert.equal(persisted.rowCount, 1)
    assert.deepEqual(
      {
        shadowExecutionId:
          persisted.rows[0].shadow_fulfillment_execution_id,
        orderId: persisted.rows[0].order_id,
        planId: persisted.rows[0].plan_id,
        warehouseId: persisted.rows[0].warehouse_id,
        authorityMode: persisted.rows[0].authority_mode,
        executionState: persisted.rows[0].execution_state,
        activationRevision: persisted.rows[0].activation_revision,
        expectedOrderRowVersion:
          Number(persisted.rows[0].expected_order_row_version),
        reason: persisted.rows[0].reason,
        idempotencyKey: persisted.rows[0].idempotency_key,
        preparedBy: persisted.rows[0].prepared_by,
        shadowGroupId: persisted.rows[0].shadow_shipment_group_id,
        provider: persisted.rows[0].selected_provider,
        serviceCode: persisted.rows[0].selected_service_code,
        serviceName: persisted.rows[0].selected_service_name,
        carrierCostMinor:
          Number(persisted.rows[0].selected_carrier_cost_minor),
        currency: persisted.rows[0].currency,
        packageCount: persisted.rows[0].package_count,
        groupState: persisted.rows[0].group_state,
      },
      {
        shadowExecutionId: ids.shadowExecution,
        orderId: ids.order,
        planId: ids.plan,
        warehouseId: ids.warehouse,
        authorityMode: 'active',
        executionState: 'prepared',
        activationRevision: 7,
        expectedOrderRowVersion: 0,
        reason: baseInput.reason,
        idempotencyKey: baseInput.idempotencyKey,
        preparedBy: actorEmail,
        shadowGroupId: ids.shadowGroup,
        provider: 'ups_rest',
        serviceCode: '03',
        serviceName: 'UPS Ground',
        carrierCostMinor: 1800,
        currency: 'USD',
        packageCount: 2,
        groupState: 'prepared',
      },
    )
    assert.match(persisted.rows[0].request_hash, /^[a-f0-9]{64}$/u)

    const packages = await client.query(
      `SELECT
         package.package_id::text,
         package.package_key,
         package.package_number,
         package.shadow_fulfillment_execution_id::text
       FROM operations_active_execution_packages package
       WHERE package.organization_id = $1
         AND package.active_fulfillment_execution_id = $2
       ORDER BY package.package_number`,
      [ids.organization, persisted.rows[0].active_execution_id],
    )
    assert.deepEqual(
      packages.rows.map((row) => ({
        packageId: row.package_id,
        packageKey: row.package_key,
        packageNumber: row.package_number,
        shadowExecutionId: row.shadow_fulfillment_execution_id,
      })),
      [
        {
          packageId: ids.packages[0],
          packageKey: 'box-1',
          packageNumber: 1,
          shadowExecutionId: ids.shadowExecution,
        },
        {
          packageId: ids.packages[1],
          packageKey: 'box-2',
          packageNumber: 2,
          shadowExecutionId: ids.shadowExecution,
        },
      ],
    )

    const replay = await prepare(baseInput)
    assert.equal(replay.replayed, true)
    assert.equal(
      replay.activeExecutionGlobalId ?? replay.executionGlobalId,
      first.activeExecutionGlobalId ?? first.executionGlobalId,
    )
    assert.equal(
      replay.activeShipmentGroupGlobalId ?? replay.shipmentGroupGlobalId,
      first.activeShipmentGroupGlobalId ?? first.shipmentGroupGlobalId,
    )
    assert.equal(replay.requestHash, first.requestHash)
    assert.equal(replay.expectedOrderRowVersion, 0)
    assert.equal(replay.reason, baseInput.reason)

    await mutateFixture(
      client,
      `UPDATE operations_activation_scopes
       SET revision = 8 WHERE organization_id = $1`,
      [ids.organization],
    )
    await expectServiceError(
      client,
      'same_key_changed_revision',
      /idempotency|different|conflict|revision/iu,
      () => prepare({ ...baseInput, expectedActivationRevision: 8 }),
    )
    await expectServiceError(
      client,
      'same_key_changed_reason',
      /idempotency|different|conflict|evidence/iu,
      () => prepare({
        ...baseInput,
        reason: 'A different operator authorization reason',
      }),
    )
    await mutateFixture(
      client,
      `UPDATE operations_activation_scopes
       SET revision = 7 WHERE organization_id = $1`,
      [ids.organization],
    )
    await expectServiceError(
      client,
      'different_key_same_shadow',
      /already|different|shadow|conflict|idempotency/iu,
      () => prepare({
        ...baseInput,
        idempotencyKey: 'active-preparation-command-2',
      }),
    )

    const counts = await client.query(
      `SELECT
         (SELECT count(*)::integer
          FROM operations_active_fulfillment_executions
          WHERE organization_id = $1) AS executions,
         (SELECT count(*)::integer
          FROM operations_active_shipment_groups
          WHERE organization_id = $1) AS groups,
         (SELECT count(*)::integer
          FROM operations_active_execution_packages
          WHERE organization_id = $1) AS packages,
         (SELECT count(*)::integer
          FROM operations_active_carrier_group_attempts
          WHERE organization_id = $1) AS attempts,
         (SELECT count(*)::integer
          FROM operations_labels
          WHERE organization_id = $1) AS labels,
         (SELECT count(*)::integer
          FROM operations_shipments
          WHERE organization_id = $1) AS shipments`,
      [ids.organization],
    )
    assert.deepEqual(counts.rows[0], {
      executions: 1,
      groups: 1,
      packages: 2,
      attempts: 0,
      labels: 0,
      shipments: 0,
    })
    assert.equal(fetchCalls.count, 0)
    await client.query('ROLLBACK')
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
    `clawpilot-active-preparation-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_active_preparation',
      '-e', 'POSTGRES_DB=clawpilot_active_preparation',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:clawpilot_active_preparation@127.0.0.1:'
      + `${port}/clawpilot_active_preparation`
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
    'Active execution preparation disposable-PostgreSQL acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
