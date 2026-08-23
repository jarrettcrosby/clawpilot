#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  actorEmail,
  command,
  loadTypeScriptModule,
  orderIds,
  postgresAdapter,
  seedApplyRevisionAuthority,
  seedBeforeRevisionMigration,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const root = process.cwd()

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

const futureIndependentControlContract = readFileSync(
  resolve(
    root,
    'scripts/fixtures/0306_operations_order_training_independent_control_contract.sql',
  ),
  'utf8',
)
const futureIndependentControlChecksum =
  '0f7bb5f6e2b82569f5ba42822d41e4f42772366fdd572e772c12bfc5d413a4e1'
assert.equal(
  sha(futureIndependentControlContract),
  futureIndependentControlChecksum,
  'The frozen 0306 independent-control contract must remain byte-exact',
)

async function installFutureIndependentControl(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(futureIndependentControlContract)
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES (
         '0306_operations_order_training_independent_control_contract.sql',
         $1
       )`,
      [futureIndependentControlChecksum],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

async function rejected(work, pattern, label) {
  await assert.rejects(
    work,
    (error) => {
      assert.match(String(error?.message || error), pattern, label)
      return true
    },
    label,
  )
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

async function createWarehouseAndMaterial(pool, organizationId) {
  const suffix = randomUUID().slice(0, 8)
  const warehouse = (await pool.query(
    `INSERT INTO operations_warehouses (
       organization_id, code, name, timezone, address, status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'Shadow training warehouse', 'America/New_York',
       $3::jsonb, 'active', $4, $4
     ) RETURNING id::text, global_id`,
    [
      organizationId,
      `TRAIN-${suffix.toUpperCase()}`,
      JSON.stringify({
        name: 'Shadow training warehouse',
        line1: '35 Saxony Drive',
        city: 'Trumbull',
        region: 'CT',
        postalCode: '06611',
        country: 'US',
      }),
      actorEmail,
    ],
  )).rows[0]
  const material = (await pool.query(
    `INSERT INTO operations_packaging_materials (
       organization_id, code, name, material_type,
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
       $1::uuid, $2, 'Shadow training carton', 'carton',
       280, 230, 180, 120, 5000, 55,
       'USD', 'active', 'manual', 'inner',
       'measured', $3, now(), $4,
       280, 230, 180, 'measured', $3, now(), $4, $4, $4
     ) RETURNING id::text, global_id, name, row_version::text`,
    [
      organizationId,
      `TRAIN-BOX-${suffix.toUpperCase()}`,
      `shadow-training-measurement-${suffix}`,
      actorEmail,
    ],
  )).rows[0]
  return { warehouse, material }
}

async function currentAuthorization(pool, fixture) {
  const result = await pool.query(
    `SELECT order_row.id::text AS order_id,
            order_row.row_version::text AS order_row_version,
            candidate.id::text AS candidate_id,
            candidate.row_version::text AS candidate_row_version,
            candidate.source_hash AS candidate_source_hash,
            account.id::text AS account_id,
            account.global_id AS account_global_id,
            account.provider,
            account.environment,
            credential.credential_version,
            activation.revision AS activation_revision
     FROM operations_orders order_row
     JOIN operations_integration_accounts account
       ON account.organization_id = order_row.organization_id
      AND account.id = order_row.integration_account_id
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = order_row.organization_id
      AND candidate.integration_account_id = order_row.integration_account_id
      AND candidate.id = $3::uuid
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = order_row.organization_id
     WHERE order_row.organization_id = $1::uuid
       AND order_row.id = $2::uuid`,
    [fixture.organizationId, fixture.order.id, fixture.candidate.id],
  )
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

async function insertRun(pool, fixture, input) {
  const authorization = await currentAuthorization(pool, fixture)
  const snapshot = {
    provider: authorization.provider,
    externalOrderId: fixture.externalOrderId,
    candidateGlobalId: fixture.candidate.global_id,
    candidateRowVersion: Number(authorization.candidate_row_version),
  }
  const counterColumn = input.counterColumn
  const counterSql = counterColumn ? `, ${counterColumn}` : ''
  const counterValueSql = counterColumn ? ', $20' : ''
  const values = [
    fixture.organizationId,
    authorization.order_id,
    authorization.account_id,
    authorization.candidate_id,
    input.generation,
    authorization.provider,
    input.accountEnvironment ?? authorization.environment,
    authorization.activation_revision,
    Number(authorization.order_row_version),
    Number(authorization.candidate_row_version),
    authorization.candidate_source_hash,
    authorization.credential_version,
    input.idempotencyKey,
    sha(`request:${input.idempotencyKey}`),
    input.reason || 'Exercise the exact local-only Shadow training boundary',
    actorEmail,
    JSON.stringify(snapshot),
    sha(JSON.stringify(snapshot)),
    actorEmail,
  ]
  if (counterColumn) values.push(input.counterValue ?? 1)
  const result = await pool.query(
    `INSERT INTO operations_shadow_training_runs (
       organization_id, source_order_id, integration_account_id,
       source_candidate_id, generation, provider, account_environment,
       authorization_activation_revision, authorization_order_row_version,
       authorization_candidate_row_version,
       authorization_candidate_source_hash,
       authorization_credential_generation,
       authorization_idempotency_key, authorization_request_hash,
       authorization_reason, authorized_by, source_snapshot,
       source_snapshot_sha256, updated_by${counterSql}
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
       $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17::jsonb, $18, $19${counterValueSql}
     ) RETURNING id::text, global_id, state, row_version::text,
                 account_environment`,
    values,
  )
  return result.rows[0]
}

async function resetRun(pool, fixture, run, reason) {
  const result = await pool.query(
    `UPDATE operations_shadow_training_runs
     SET state = 'reset', reset_at = now(), reset_reason = $3,
         reset_blocker_code = NULL, row_version = row_version + 1,
         updated_by = $4, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid
     RETURNING state, row_version::text`,
    [fixture.organizationId, run.id, reason, actorEmail],
  )
  assert.equal(result.rows[0].state, 'reset')
  return result.rows[0]
}

async function verifyActivationRunConcurrency(pool, fixture) {
  const runClient = await pool.connect()
  const activationClient = await pool.connect()
  let concurrentRun
  try {
    await runClient.query('BEGIN')
    concurrentRun = await insertRun(runClient, fixture, {
      generation: 20,
      idempotencyKey: 'shadow-training-concurrent-run-first',
    })
    await activationClient.query('BEGIN')
    let activationSettled = false
    const activationAttempt = activationClient.query(
      `UPDATE operations_activation_scopes
       SET state = 'active', revision = revision + 1,
           updated_by = $2, updated_at = now()
       WHERE organization_id = $1::uuid
       RETURNING state`,
      [fixture.organizationId, actorEmail],
    ).finally(() => {
      activationSettled = true
    })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75))
    assert.equal(
      activationSettled,
      false,
      'A profile change must serialize behind concurrent training authorization',
    )
    await runClient.query('COMMIT')
    const activationResult = await activationAttempt
    assert.equal(
      activationResult.rows[0].state,
      'active',
      'An open local training run must not block an Active profile change',
    )
    await activationClient.query('COMMIT')
  } finally {
    await runClient.query('ROLLBACK').catch(() => undefined)
    await activationClient.query('ROLLBACK').catch(() => undefined)
    runClient.release()
    activationClient.release()
  }

  await resetRun(
    pool,
    fixture,
    concurrentRun,
    'Finish run-first activation concurrency proof',
  )

  await pool.query(
    `UPDATE operations_activation_scopes
     SET state = 'shadow', revision = revision + 1,
         updated_by = $2, updated_at = now()
     WHERE organization_id = $1::uuid`,
    [fixture.organizationId, actorEmail],
  )

  const activeFirstClient = await pool.connect()
  const blockedRunClient = await pool.connect()
  try {
    await activeFirstClient.query('BEGIN')
    await activeFirstClient.query(
      `UPDATE operations_activation_scopes
       SET state = 'active', revision = revision + 1,
           updated_by = $2, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [fixture.organizationId, actorEmail],
    )
    await blockedRunClient.query('BEGIN')
    let runSettled = false
    const runAttempt = rejected(
      insertRun(blockedRunClient, fixture, {
        generation: 21,
        idempotencyKey: 'shadow-training-concurrent-active-first',
      }).finally(() => {
        runSettled = true
      }),
      /exact current safety profile|authorization requires/u,
      'A stale profile revision must not authorize a concurrent training run',
    )
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75))
    assert.equal(
      runSettled,
      false,
      'Training authorization must wait for the concurrent activation lock',
    )
    await activeFirstClient.query('COMMIT')
    await runAttempt
    await blockedRunClient.query('ROLLBACK')
  } finally {
    await activeFirstClient.query('ROLLBACK').catch(() => undefined)
    await blockedRunClient.query('ROLLBACK').catch(() => undefined)
    activeFirstClient.release()
    blockedRunClient.release()
  }

  const activeRun = await insertRun(pool, fixture, {
    generation: 21,
    idempotencyKey: 'order-training-current-active-retry',
  })
  await resetRun(
    pool,
    fixture,
    activeRun,
    'Fresh current Active authorization remains available for local training',
  )

  await pool.query(
    `UPDATE operations_activation_scopes
     SET state = 'shadow', revision = revision + 1,
         updated_by = $2, updated_at = now()
     WHERE organization_id = $1::uuid`,
    [fixture.organizationId, actorEmail],
  )
}

async function verifyCanonicalTrainingConcurrency(pool, fixture, facts) {
  await pool.query(
    `UPDATE operations_activation_scopes
     SET state = 'read_only', revision = revision + 1,
         updated_by = $2, updated_at = now()
     WHERE organization_id = $1::uuid`,
    [fixture.organizationId, actorEmail],
  )

  const runFirstClient = await pool.connect()
  const blockedCanonicalClient = await pool.connect()
  let runFirst
  try {
    await runFirstClient.query('BEGIN')
    runFirst = await insertRun(runFirstClient, fixture, {
      generation: 22,
      idempotencyKey: 'order-training-concurrent-run-before-canonical',
    })
    await blockedCanonicalClient.query('BEGIN')
    let canonicalSettled = false
    const canonicalAttempt = rejected(
      blockedCanonicalClient.query(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id,
           version_number, status, method, solver_status,
           promised_delivery_at, explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 190, 'planned',
           'manual_override', 'not_run', now() + interval '1 day',
           '{}'::jsonb, $4
         )`,
        [
          fixture.organizationId,
          fixture.order.id,
          facts.warehouse.id,
          actorEmail,
        ],
      ).finally(() => {
        canonicalSettled = true
      }),
      /OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED/u,
      'A training authorization that wins serialization must quarantine canonical work',
    )
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75))
    assert.equal(
      canonicalSettled,
      false,
      'Canonical work must wait for a concurrent training authorization',
    )
    await runFirstClient.query('COMMIT')
    await canonicalAttempt
    await blockedCanonicalClient.query('ROLLBACK')
  } finally {
    await runFirstClient.query('ROLLBACK').catch(() => undefined)
    await blockedCanonicalClient.query('ROLLBACK').catch(() => undefined)
    runFirstClient.release()
    blockedCanonicalClient.release()
  }
  await resetRun(
    pool,
    fixture,
    runFirst,
    'Finish training-first canonical serialization proof',
  )

  const canonicalFirstClient = await pool.connect()
  const blockedRunClient = await pool.connect()
  let canonicalPlan
  try {
    await canonicalFirstClient.query('BEGIN')
    canonicalPlan = (await canonicalFirstClient.query(
      `INSERT INTO operations_fulfillment_plans (
         organization_id, order_id, warehouse_id,
         version_number, status, method, solver_status,
         promised_delivery_at, explanation, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 191, 'planned',
         'manual_override', 'not_run', now() + interval '1 day',
         '{}'::jsonb, $4
       ) RETURNING id::text`,
      [
        fixture.organizationId,
        fixture.order.id,
        facts.warehouse.id,
        actorEmail,
      ],
    )).rows[0]
    await blockedRunClient.query('BEGIN')
    let runSettled = false
    const runAttempt = rejected(
      insertRun(blockedRunClient, fixture, {
        generation: 23,
        idempotencyKey: 'order-training-concurrent-canonical-before-run',
      }).finally(() => {
        runSettled = true
      }),
      /authorization requires an untouched imported connected-store order/u,
      'Committed canonical work must make a later training authorization ineligible',
    )
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75))
    assert.equal(
      runSettled,
      false,
      'Training authorization must wait for concurrent canonical work',
    )
    await canonicalFirstClient.query('COMMIT')
    await runAttempt
    await blockedRunClient.query('ROLLBACK')
  } finally {
    await canonicalFirstClient.query('ROLLBACK').catch(() => undefined)
    await blockedRunClient.query('ROLLBACK').catch(() => undefined)
    canonicalFirstClient.release()
    blockedRunClient.release()
  }
  await withReplicaSession(pool, (client) => client.query(
    `DELETE FROM operations_fulfillment_plans
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, canonicalPlan.id],
  ))

  await pool.query(
    `UPDATE operations_activation_scopes
     SET state = 'shadow', revision = revision + 1,
         updated_by = $2, updated_at = now()
     WHERE organization_id = $1::uuid`,
    [fixture.organizationId, actorEmail],
  )
}

async function createSealedEvidence(
  pool,
  fixture,
  { warehouse, material },
  input,
) {
  const authorization = await currentAuthorization(pool, fixture)
  const lineGlobalId = input.lineGlobalId || (
    await pool.query(`SELECT allocate_global_reference('gcal') AS global_id`)
  ).rows[0].global_id
  const allocation = {
    lineGlobalId,
    productGlobalId: fixture.product.reference_code,
    quantity: 2,
    title: 'Revision exact case pack',
  }
  const packageHash = sha(`package:${input.key}:${lineGlobalId}`)
  const requestHash = sha(`evidence-request:${input.key}`)
  const planInputHash = sha(`evidence-input:${input.key}`)
  const planResultHash = sha(`evidence-result:${input.key}`)
  const planSnapshot = {
    shadowTraining: {
      version: 'shadow-training-evidence-v1',
      runGlobalId: input.runGlobalId,
      runRowVersion: input.runRowVersion ?? 0,
    },
  }
  const evidence = await withReplicaSession(pool, async (client) => {
    const inserted = (await client.query(
      `INSERT INTO operations_cartonization_rate_evidence (
         organization_id, integration_account_id, order_candidate_id,
         candidate_row_version, candidate_source_hash, warehouse_id,
         evidence_mode, policy_version, algorithm_version, request_hash,
         plan_input_hash, plan_result_hash, plan_snapshot,
         assumption_snapshot, status, idempotency_key, actor_email,
         write_token_hash, destination_fingerprint, sealed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid,
         'assumption_backed_sandbox', 'shadow-training-test-v1',
         'shadow-training-test-v1', $7, $8, $9,
         $14::jsonb, '{}'::jsonb, 'succeeded', $10, $11, $12, $13, now()
       ) RETURNING id::text, global_id`,
      [
        fixture.organizationId,
        authorization.account_id,
        authorization.candidate_id,
        Number(authorization.candidate_row_version),
        authorization.candidate_source_hash,
        warehouse.id,
        requestHash,
        planInputHash,
        planResultHash,
        `shadow-evidence-${input.key}`,
        actorEmail,
        sha(`write-token:${input.key}`),
        sha(`destination:${input.key}`),
        JSON.stringify(planSnapshot),
      ],
    )).rows[0]
    await client.query(
      `INSERT INTO operations_cartonization_rate_evidence_packages (
         organization_id, evidence_id, package_key, package_sequence,
         planning_method, packaging_material_id, material_row_version,
         inner_dimensions_mm, rated_outer_dimensions_mm,
         content_weight_grams, tare_weight_grams,
         rated_gross_weight_grams, max_weight_grams,
         allocations, package_hash, carrier_parcel_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, $3, 1, 'or_tools', $4::uuid, $5,
         $6::jsonb, $6::jsonb, 2400, 120, 2520, 5000,
         $7::jsonb, $8, $9::jsonb
       )`,
      [
        fixture.organizationId,
        inserted.id,
        `package-${input.key}`,
        material.id,
        Number(material.row_version),
        JSON.stringify({ length: 280, width: 230, height: 180 }),
        JSON.stringify([allocation]),
        packageHash,
        JSON.stringify({
          description: 'Shadow training carton',
          dimensionUnit: 'IN',
          length: 11.02,
          width: 9.06,
          height: 7.09,
          weight: 5.56,
          weightUnit: 'LB',
        }),
      ],
    )
    return inserted
  })
  return {
    ...evidence,
    warehouseId: warehouse.id,
    material,
    allocation,
    packageHash,
    packageKey: `package-${input.key}`,
    evidenceHash: sha(`training-evidence:${input.key}`),
    accountGlobalId: authorization.account_global_id,
    candidateRowVersion: Number(authorization.candidate_row_version),
    candidateSourceHash: authorization.candidate_source_hash,
    requestHash,
    planInputHash,
    planResultHash,
    planSnapshot,
  }
}

function persistenceEvidence(fixture, facts, evidence) {
  return {
    globalId: evidence.global_id,
    accountGlobalId: evidence.accountGlobalId,
    candidateGlobalId: fixture.candidate.global_id,
    candidateOrderNumber: fixture.order.order_number || fixture.externalOrderId,
    candidateRowVersion: evidence.candidateRowVersion,
    candidateSourceHash: evidence.candidateSourceHash,
    destinationFingerprint: sha(`destination:${evidence.global_id}`),
    requestHash: evidence.requestHash,
    warehouse: {
      globalId: facts.warehouse.global_id,
      name: 'Shadow training warehouse',
    },
    inventorySyncRunGlobalId: null,
    evidenceMode: 'assumption_backed_sandbox',
    requiredCarrierProviders: [],
    policyVersion: 'shadow-training-test-v1',
    algorithmVersion: 'shadow-training-test-v1',
    planInputHash: evidence.planInputHash,
    planResultHash: evidence.planResultHash,
    planSnapshot: evidence.planSnapshot,
    assumptionSnapshot: {},
    status: 'succeeded',
    idempotencyKey: `shadow-evidence-${evidence.global_id}`,
    actorEmail,
    createdAt: new Date().toISOString(),
    shipmentRates: [],
    packages: [{
      packageKey: evidence.packageKey,
      packageSequence: 1,
      planningMethod: 'or_tools',
      packagingMaterialGlobalId: evidence.material.global_id,
      packagingMaterialName: evidence.material.name,
      approvedPackRecipeGlobalId: null,
      approvedPackRecipeName: null,
      materialRowVersion: Number(evidence.material.row_version),
      recipeRowVersion: null,
      recipes: [],
      orToolsProfiles: [],
      innerDimensionsMm: { length: 280, width: 230, height: 180 },
      ratedOuterDimensionsMm: { length: 280, width: 230, height: 180 },
      contentWeightGrams: 2400,
      tareWeightGrams: 120,
      ratedGrossWeightGrams: 2520,
      maxWeightGrams: 5000,
      allocations: [evidence.allocation],
      carrierParcel: {
        description: 'Shadow training carton',
        dimensionUnit: 'IN',
        length: 11.02,
        width: 9.06,
        height: 7.09,
        weight: 5.56,
        weightUnit: 'LB',
      },
      packageHash: evidence.packageHash,
      quotes: [],
    }],
  }
}

async function insertPlanOverlay(pool, fixture, run, evidence) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const trainingPackage = (await client.query(
      `INSERT INTO operations_shadow_training_packages (
         organization_id, training_run_id, package_sequence,
         evidence_package_key, packaging_material_global_id,
         packaging_material_name, rated_outer_dimensions_mm,
         content_weight_grams, tare_weight_grams,
         rated_gross_weight_grams, allocations, source_package_hash
       ) VALUES (
         $1::uuid, $2::uuid, 1, $3, $4, $5,
         $6::jsonb, 2400, 120, 2520, $7::jsonb, $8
       ) RETURNING id::text, global_id`,
      [
        fixture.organizationId,
        run.id,
        evidence.packageKey,
        evidence.material.global_id,
        evidence.material.name,
        JSON.stringify({ length: 280, width: 230, height: 180 }),
        JSON.stringify([evidence.allocation]),
        evidence.packageHash,
      ],
    )).rows[0]
    const task = (await client.query(
      `INSERT INTO operations_shadow_training_pick_tasks (
         organization_id, training_run_id, training_package_id,
         task_sequence, source_line_global_id, product_global_id,
         title, quantity
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 1, $4, $5, $6, $7
       ) RETURNING id::text, global_id`,
      [
        fixture.organizationId,
        run.id,
        trainingPackage.id,
        evidence.allocation.lineGlobalId,
        evidence.allocation.productGlobalId,
        evidence.allocation.title,
        evidence.allocation.quantity,
      ],
    )).rows[0]
    await client.query(
      `UPDATE operations_shadow_training_runs
       SET cartonization_evidence_id = $3::uuid,
           cartonization_evidence_global_id = $4,
           cartonization_evidence_sha256 = $5,
           warehouse_id = $6::uuid, state = 'planned',
           row_version = row_version + 1,
           updated_by = $7, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        fixture.organizationId,
        run.id,
        evidence.id,
        evidence.global_id,
        evidence.evidenceHash,
        evidence.warehouseId,
        actorEmail,
      ],
    )
    const event = (await client.query(
      `INSERT INTO operations_shadow_training_events (
         organization_id, training_run_id, event_type, from_state,
         to_state, request_hash, idempotency_key, payload, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, 'shadow_training.planned', 'enabled',
         'planned', $3, $4, '{"providerWrites":0}'::jsonb, $5
       ) RETURNING global_id`,
      [
        fixture.organizationId,
        run.id,
        sha(`event:${run.id}`),
        `event-plan-${run.id}`,
        actorEmail,
      ],
    )).rows[0]
    await client.query('COMMIT')
    return { trainingPackage, task, event }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function attemptPlanVariant(pool, fixture, run, evidence, variant = {}) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let trainingPackage = null
    const dimensions = variant.dimensions || {
      length: 280,
      width: 230,
      height: 180,
    }
    const allocations = variant.allocations || [evidence.allocation]
    if (!variant.omitPackage) {
      trainingPackage = (await client.query(
        `INSERT INTO operations_shadow_training_packages (
           organization_id, training_run_id, package_sequence,
           evidence_package_key, packaging_material_global_id,
           packaging_material_name, rated_outer_dimensions_mm,
           content_weight_grams, tare_weight_grams,
           rated_gross_weight_grams, allocations, source_package_hash
         ) VALUES (
           $1::uuid, $2::uuid, 1, $3, $4, $5, $6::jsonb,
           $7, $8, $9, $10::jsonb, $11
         ) RETURNING id::text, global_id`,
        [
          fixture.organizationId,
          variant.packageRunId || run.id,
          evidence.packageKey,
          variant.materialGlobalId || evidence.material.global_id,
          variant.materialName || evidence.material.name,
          JSON.stringify(dimensions),
          variant.contentWeightGrams || 2400,
          variant.tareWeightGrams || 120,
          variant.ratedGrossWeightGrams || 2520,
          JSON.stringify(allocations),
          variant.packageHash || evidence.packageHash,
        ],
      )).rows[0]
    }
    if (!variant.omitPick && trainingPackage) {
      const pick = variant.pick || allocations[0]
      await client.query(
        `INSERT INTO operations_shadow_training_pick_tasks (
           organization_id, training_run_id, training_package_id,
           task_sequence, source_line_global_id, product_global_id,
           title, quantity
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 1, $4, $5, $6, $7
         )`,
        [
          fixture.organizationId,
          variant.pickRunId || run.id,
          variant.pickPackageId || trainingPackage.id,
          pick.lineGlobalId,
          pick.productGlobalId,
          pick.title,
          pick.quantity,
        ],
      )
    }
    if (!variant.skipRunUpdate) {
      await client.query(
        `UPDATE operations_shadow_training_runs
         SET cartonization_evidence_id = $3::uuid,
             cartonization_evidence_global_id = $4,
             cartonization_evidence_sha256 = $5,
             warehouse_id = $6::uuid, state = 'planned',
             row_version = row_version + 1,
             updated_by = $7, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [
          fixture.organizationId,
          run.id,
          evidence.id,
          evidence.global_id,
          evidence.evidenceHash,
          evidence.warehouseId,
          actorEmail,
        ],
      )
    }
    await client.query('COMMIT')
    return trainingPackage
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function completeTrainingLifecycle(
  pool,
  fixture,
  run,
  trainingPackage,
  task,
  material,
) {
  await pool.query(
    `UPDATE operations_shadow_training_runs
     SET state = 'released', row_version = row_version + 1,
         updated_by = $3, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, run.id, actorEmail],
  )
  await pool.query(
    `UPDATE operations_shadow_training_pick_tasks
     SET status = 'picked', picked_by = $3, picked_at = now(),
         updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, task.id, actorEmail],
  )
  await pool.query(
    `UPDATE operations_shadow_training_runs
     SET state = 'picked', row_version = row_version + 1,
         updated_by = $3, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, run.id, actorEmail],
  )
  await pool.query(
    `UPDATE operations_packaging_materials
     SET name = 'Renamed live catalog carton', row_version = row_version + 1,
         updated_by = $3, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, material.id, actorEmail],
  )
  await pool.query(
    `UPDATE operations_shadow_training_packages
     SET status = 'packed', packed_by = $3, packed_at = now(),
         updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, trainingPackage.id, actorEmail],
  )
  await pool.query(
    `UPDATE operations_shadow_training_runs
     SET state = 'packed', row_version = row_version + 1,
         updated_by = $3, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, run.id, actorEmail],
  )
  await pool.query(
    `UPDATE operations_shadow_training_packages
     SET status = 'completed', completed_at = now(), updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, trainingPackage.id],
  )
  const completed = await pool.query(
    `UPDATE operations_shadow_training_runs
     SET state = 'completed', completed_at = now(),
         row_version = row_version + 1,
         updated_by = $3, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid
     RETURNING state, completed_at, row_version::text`,
    [fixture.organizationId, run.id, actorEmail],
  )
  assert.equal(completed.rows[0].state, 'completed')
  assert.ok(completed.rows[0].completed_at)
  const packageSnapshot = await pool.query(
    `SELECT packaging_material_name, status
     FROM operations_shadow_training_packages
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, trainingPackage.id],
  )
  assert.deepEqual(packageSnapshot.rows[0], {
    packaging_material_name: 'Shadow training carton',
    status: 'completed',
  }, 'Renaming the live material must not mutate sealed training facts')
  return completed.rows[0]
}

function shadowTrainingPersistence(pool, evidenceByGlobalId = new Map()) {
  const domain = loadTypeScriptModule(
    'app_src/lib/operations/shadowTraining.ts',
  )
  return loadTypeScriptModule(
    'app_src/lib/persistence/operationShadowTraining.ts',
    {
      '@/lib/operations/shadowTraining': domain,
      '@/lib/persistence/cartonizationRateEvidence': {
        async readCartonizationRateEvidenceByGlobalId(input) {
          return evidenceByGlobalId.get(input.evidenceGlobalId) || null
        },
      },
      '@/lib/persistence/postgres': {
        ...postgresAdapter(pool),
        getPostgresPool: () => pool,
      },
    },
  )
}

async function addUnresolvedCandidateLine(pool, fixture) {
  const unresolvedGlobalId = (
    await pool.query(`SELECT allocate_global_reference('gcol') AS global_id`)
  ).rows[0].global_id
  const unresolvedId = randomUUID()
  await withReplicaSession(pool, (client) => client.query(
    `INSERT INTO operations_commerce_order_candidate_lines
     SELECT (jsonb_populate_record(
       NULL::operations_commerce_order_candidate_lines,
       to_jsonb(source_line) || jsonb_build_object(
         'id', $3::text,
         'global_id', $4::text,
         'external_line_id', $5::text,
         'product_id', NULL,
         'product_mapping_id', NULL,
         'mapping_state', 'unresolved',
         'packaging_state', 'unresolved',
         'packaging_source', 'none',
         'package_profile_id', NULL,
         'commerce_variant_pack_mapping_id', NULL,
         'commerce_variant_pack_mapping_row_version', NULL,
         'pack_profile_version_id', NULL,
         'pack_profile_version_row_version', NULL,
         'pack_profile_package_level', NULL,
         'pack_profile_base_each_quantity', NULL,
         'packaging_weight_source', NULL,
         'price_resolution_state', 'unresolved',
         'resolved_currency_code', NULL,
         'resolved_unit_price_minor', NULL,
         'resolved_subtotal_minor', NULL,
         'resolved_discount_minor', NULL,
         'resolved_brand_discount_minor', NULL,
         'resolved_tax_minor', NULL,
         'resolved_other_adjustment_minor', NULL,
         'resolved_total_minor', NULL,
         'workflow_state', 'held',
         'blocking_codes', jsonb_build_array('line_price_required'),
         'canonical_order_line_id', NULL,
         'promoted_at', NULL,
         'source_hash', $6::text,
         'created_at', now(),
         'updated_at', now(),
         'expires_at', now() + interval '7 days'
       )
     )).* 
     FROM operations_commerce_order_candidate_lines source_line
     WHERE source_line.organization_id = $1::uuid
       AND source_line.id = $2::uuid`,
    [
      fixture.organizationId,
      fixture.candidateLine.id,
      unresolvedId,
      unresolvedGlobalId,
      `${fixture.oldExternalLineId}-unresolved`,
      sha(`unresolved-line:${unresolvedId}`),
    ],
  ))
  return unresolvedGlobalId
}

async function verifyCanonicalWriteGuards(pool, fixture) {
  const statements = [
    `INSERT INTO operations_fulfillment_plans (organization_id, order_id)
     VALUES ($1::uuid, $2::uuid)`,
    `INSERT INTO operations_reservations (organization_id, order_id)
     VALUES ($1::uuid, $2::uuid)`,
    `INSERT INTO operations_shipments (organization_id, order_id)
     VALUES ($1::uuid, $2::uuid)`,
    `INSERT INTO operations_commerce_fulfillment_exports (
       organization_id, order_id
     ) VALUES ($1::uuid, $2::uuid)`,
  ]
  for (const statement of statements) {
    await rejected(
      pool.query(statement, [fixture.organizationId, fixture.order.id]),
      /OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED/u,
      `${fixture.provider} canonical write must require the Shadow overlay`,
    )
  }
}

async function verifyCanonicalWritesAreNotGloballyShadowBlocked(pool, fixture) {
  const statements = [
    `INSERT INTO operations_fulfillment_plans (organization_id, order_id)
     VALUES ($1::uuid, $2::uuid)`,
    `INSERT INTO operations_reservations (organization_id, order_id)
     VALUES ($1::uuid, $2::uuid)`,
    `INSERT INTO operations_shipments (organization_id, order_id)
     VALUES ($1::uuid, $2::uuid)`,
    `INSERT INTO operations_commerce_fulfillment_exports (
       organization_id, order_id
     ) VALUES ($1::uuid, $2::uuid)`,
  ]
  for (const statement of statements) {
    await assert.rejects(
      pool.query(statement, [fixture.organizationId, fixture.order.id]),
      (error) => {
        assert.doesNotMatch(
          String(error?.message || error),
          /OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED/u,
          `${fixture.provider} ordinary canonical work must not be globally Shadow-blocked`,
        )
        return true
      },
    )
  }
}

async function verify(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  const ids = orderIds()
  try {
    await seedBeforeRevisionMigration(pool, ids)
    await pool.query(
      `UPDATE operations_integration_accounts
       SET environment = 'sandbox', updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, ids.integration],
    )
    const shopifySeed = await seedApplyRevisionAuthority(pool, ids, 'shopify')
    const faireSeed = await seedApplyRevisionAuthority(pool, ids, 'faire')
    const shopify = { ...shopifySeed, organizationId: ids.organization }
    const faire = { ...faireSeed, organizationId: ids.organization }
    const facts = await createWarehouseAndMaterial(pool, ids.organization)

    await rejected(
      insertRun(pool, shopify, {
        generation: 1,
        accountEnvironment: 'mock',
        idempotencyKey: 'shadow-training-mock-rejected',
      }),
      /account_environment|Order training source/u,
      'Mock commerce accounts must not authorize Order training',
    )
    for (const counterColumn of [
      'commerce_provider_write_count',
      'production_postage_count',
      'inventory_mutation_count',
      'packaging_stock_mutation_count',
    ]) {
      await rejected(
        insertRun(pool, shopify, {
          generation: 1,
          idempotencyKey: `shadow-counter-${counterColumn}`,
          counterColumn,
          counterValue: 1,
        }),
        /violates check constraint/u,
        `${counterColumn} must be structurally fixed at zero`,
      )
    }

    const sandboxRun = await insertRun(pool, shopify, {
      generation: 1,
      idempotencyKey: 'shadow-training-shopify-sandbox',
    })
    const productionRun = await insertRun(pool, faire, {
      generation: 1,
      idempotencyKey: 'shadow-training-faire-production',
    })
    assert.equal(sandboxRun.account_environment, 'sandbox')
    assert.equal(productionRun.account_environment, 'production')
    assert.match(sandboxRun.global_id, /^gtrn[0-9a-v]{12}$/u)
    assert.match(productionRun.global_id, /^gtrn[0-9a-v]{12}$/u)

    const activeWithOpenTraining = await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'active', revision = revision + 1,
           updated_by = $2, updated_at = now()
       WHERE organization_id = $1::uuid
       RETURNING state`,
      [ids.organization, actorEmail],
    )
    assert.equal(
      activeWithOpenTraining.rows[0].state,
      'active',
      'A local-only training run must not block an Active profile change',
    )
    await rejected(
      pool.query(
        `DELETE FROM operations_activation_scopes
         WHERE organization_id = $1::uuid`,
        [ids.organization],
      ),
      /OPERATIONS_ORDER_TRAINING_SAFETY_PROFILE_REQUIRED/u,
      'The safety profile row cannot be deleted while a training run remains open',
    )
    await withReplicaSession(pool, (client) => client.query(
      `DELETE FROM operations_activation_scopes
       WHERE organization_id = $1::uuid`,
      [ids.organization],
    ))
    const restoredProfile = await pool.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision,
         reason, updated_by
       ) VALUES ($1::uuid, $2::uuid, 'active', 2, $3, $4)
       RETURNING state`,
      [
        ids.organization,
        ids.pipeline,
        'Restore the safety profile without stranding local training',
        actorEmail,
      ],
    )
    assert.equal(restoredProfile.rows[0].state, 'active')
    for (const allowedState of [
      'disabled',
      'shadow',
      'read_only',
      'active',
      'frozen',
    ]) {
      const safeExit = await pool.query(
        `UPDATE operations_activation_scopes
         SET state = $2, revision = revision + 1,
             updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid
         RETURNING state`,
        [ids.organization, allowedState, actorEmail],
      )
      assert.equal(safeExit.rows[0].state, allowedState)
      await verifyCanonicalWriteGuards(pool, shopify)
    }
    const activationProjection = shadowTrainingPersistence(pool)
    const activationDriftedRun = await activationProjection
      .readOperationsShadowTrainingForOrderInPostgres({
        organizationId: ids.organization,
        orderGlobalId: shopify.order.global_id,
      })
    assert.equal(activationDriftedRun.run.activationChanged, true)
    assert.deepEqual(
      Array.from(activationDriftedRun.run.availableActions),
      ['plan', 'reset'],
      'Profile changes must not strand an exact local training run',
    )
    await resetRun(pool, shopify, sandboxRun, 'Finish environment eligibility')
    await resetRun(pool, faire, productionRun, 'Finish production eligibility')

    const independentEvidenceByGlobalId = new Map()
    const independentProfileTraining = shadowTrainingPersistence(
      pool,
      independentEvidenceByGlobalId,
    )
    for (const [index, safetyState] of [
      'disabled',
      'shadow',
      'read_only',
      'active',
      'frozen',
    ].entries()) {
      await pool.query(
        `UPDATE operations_activation_scopes
         SET state = $2, revision = revision + 1,
             updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid`,
        [ids.organization, safetyState, actorEmail],
      )
      let modeRun = await independentProfileTraining
        .enableOperationsShadowTrainingInPostgres({
          organizationId: ids.organization,
          actorEmail,
          orderGlobalId: shopify.order.global_id,
          confirmation: 'local_training_only',
          reason: `Prove local Order training is available in ${safetyState}`,
          idempotencyKey: `order-training-enable-${index}-${safetyState}`,
        })
      assert.equal(modeRun.state, 'enabled')
      assert.equal(
        modeRun.activationChanged,
        false,
        `${safetyState} is the authorization-time profile, not immediate drift`,
      )
      assert.deepEqual(
        Array.from(modeRun.availableActions),
        ['plan', 'reset'],
        `${safetyState} must expose the complete local training start boundary`,
      )
      const modeEvidence = await createSealedEvidence(
        pool,
        shopify,
        facts,
        {
          key: `profile-${safetyState}`,
          runGlobalId: modeRun.globalId,
          runRowVersion: modeRun.rowVersion,
        },
      )
      independentEvidenceByGlobalId.set(
        modeEvidence.global_id,
        persistenceEvidence(shopify, facts, modeEvidence),
      )
      modeRun = await independentProfileTraining
        .planOperationsShadowTrainingInPostgres({
          organizationId: ids.organization,
          actorEmail,
          runGlobalId: modeRun.globalId,
          cartonizationEvidenceGlobalId: modeEvidence.global_id,
          expectedRowVersion: modeRun.rowVersion,
          reason: `Plan exact local Order training in ${safetyState}`,
          idempotencyKey: `order-training-plan-${index}-${safetyState}`,
        })
      for (const [method, expectedState, action] of [
        ['releaseOperationsShadowTrainingInPostgres', 'released', 'release'],
        ['confirmOperationsShadowTrainingPicksInPostgres', 'picked', 'pick'],
        ['verifyOperationsShadowTrainingPackInPostgres', 'packed', 'pack'],
        ['completeOperationsShadowTrainingInPostgres', 'completed', 'complete'],
      ]) {
        modeRun = await independentProfileTraining[method]({
          organizationId: ids.organization,
          actorEmail,
          runGlobalId: modeRun.globalId,
          expectedRowVersion: modeRun.rowVersion,
          reason: `${action} exact local Order training in ${safetyState}`,
          idempotencyKey:
            `order-training-${action}-${index}-${safetyState}`,
        })
        assert.equal(
          modeRun.state,
          expectedState,
          `${safetyState} must complete the ${action} training boundary`,
        )
      }
      const resetModeRun = await independentProfileTraining
        .resetOperationsShadowTrainingInPostgres({
          organizationId: ids.organization,
          actorEmail,
          runGlobalId: modeRun.globalId,
          expectedRowVersion: modeRun.rowVersion,
          reason: `Finish ${safetyState} Order training availability proof`,
          idempotencyKey: `order-training-reset-${index}-${safetyState}`,
        })
      assert.equal(resetModeRun.state, 'reset')
    }
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'shadow', revision = revision + 1,
           updated_by = $2, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [ids.organization, actorEmail],
    )
    await verifyActivationRunConcurrency(pool, shopify)
    await verifyCanonicalTrainingConcurrency(pool, shopify, facts)

    const planRun = await insertRun(pool, shopify, {
      generation: 30,
      idempotencyKey: 'shadow-training-valid-plan',
    })
    const planEvidence = await createSealedEvidence(
      pool,
      shopify,
      facts,
      { key: 'valid-plan', runGlobalId: planRun.global_id },
    )
    const legacyPlan = await withReplicaSession(pool, async (client) => (
      await client.query(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id,
           version_number, status, method, solver_status,
           promised_delivery_at, explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 91, 'planned',
           'manual_override', 'not_run', now() + interval '1 day',
           '{}'::jsonb, $4
         ) RETURNING id::text`,
        [ids.organization, faire.order.id, facts.warehouse.id, actorEmail],
      )
    ).rows[0])
    const mirroredPlanUpdate = await pool.query(
      `UPDATE operations_fulfillment_plans
       SET status = 'cancelled', updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid
       RETURNING status`,
      [ids.organization, legacyPlan.id],
    )
    assert.equal(
      mirroredPlanUpdate.rows[0].status,
      'cancelled',
      'Provider reconciliation may update same-order canonical status in Shadow',
    )
    await rejected(
      pool.query(
        `UPDATE operations_fulfillment_plans
         SET order_id = $3::uuid, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, legacyPlan.id, shopify.order.id],
      ),
      /OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED/u,
      'A legacy canonical plan cannot be rebound into another Shadow commerce order',
    )
    await rejected(
      pool.query(
        `UPDATE operations_fulfillment_plans
         SET cartonization_evidence_id = $3::uuid, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, legacyPlan.id, planEvidence.id],
      ),
      /OPERATIONS_SHADOW_TRAINING_EVIDENCE_CANONICAL_FORBIDDEN/u,
      'A legacy canonical plan cannot be rebound to Shadow training evidence',
    )
    await withReplicaSession(pool, (client) => client.query(
      `DELETE FROM operations_fulfillment_plans
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, legacyPlan.id],
    ))
    const mirrorLocation = (await pool.query(
      `INSERT INTO operations_locations (
         organization_id, warehouse_id, code, zone, location_type,
         active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'SHADOW-MIRROR', 'STORAGE', 'storage',
         true, $3
       ) RETURNING id::text`,
      [ids.organization, facts.warehouse.id, actorEmail],
    )).rows[0]
    const mirrorPool = (await pool.query(
      `INSERT INTO operations_inventory_pools (
         organization_id, pipeline_id, name, pool_type,
         allocation_policy, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'Shadow mirror regression pool',
         'shared', 'fifo', true, $3
       ) RETURNING id::text`,
      [ids.organization, ids.pipeline, actorEmail],
    )).rows[0]
    const mirrorPosition = (await pool.query(
      `INSERT INTO operations_inventory_positions (
         organization_id, pipeline_id, warehouse_id, location_id,
         pool_id, product_id, lot_code, on_hand_quantity,
         reserved_quantity, damaged_quantity
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, 'SHADOW-MIRROR', 10, 0, 0
       ) RETURNING id::text`,
      [
        ids.organization,
        ids.pipeline,
        facts.warehouse.id,
        mirrorLocation.id,
        mirrorPool.id,
        faire.product.id,
      ],
    )).rows[0]
    const legacyReservation = await withReplicaSession(pool, async (client) => (
      await client.query(
        `INSERT INTO operations_reservations (
           organization_id, order_id, order_line_id, position_id,
           quantity, status, idempotency_key, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           1, 'active', $5, $6
         ) RETURNING id::text`,
        [
          ids.organization,
          faire.order.id,
          faire.orderLine.id,
          mirrorPosition.id,
          'shadow-training-legacy-reservation',
          actorEmail,
        ],
      )
    ).rows[0])
    const mirroredReservationUpdate = await pool.query(
      `UPDATE operations_reservations
       SET status = 'released', released_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid
       RETURNING status`,
      [ids.organization, legacyReservation.id],
    )
    assert.equal(
      mirroredReservationUpdate.rows[0].status,
      'released',
      'Provider reconciliation may release same-order reservations in Shadow',
    )
    await rejected(
      pool.query(
        `UPDATE operations_reservations
         SET order_id = $3::uuid
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, legacyReservation.id, shopify.order.id],
      ),
      /OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED/u,
      'A legacy reservation cannot be rebound into another Shadow commerce order',
    )
    await withReplicaSession(pool, (client) => client.query(
      `DELETE FROM operations_reservations
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, legacyReservation.id],
    ))
    assert.match(planEvidence.allocation.lineGlobalId, /^gcal[0-9a-v]{12}$/u)
    const overlay = await insertPlanOverlay(pool, shopify, planRun, planEvidence)
    assert.match(overlay.trainingPackage.global_id, /^gtpk[0-9a-v]{12}$/u)
    assert.match(overlay.task.global_id, /^gtpt[0-9a-v]{12}$/u)
    assert.match(overlay.event.global_id, /^gtev[0-9a-v]{12}$/u)

    await rejected(
      pool.query(
        `UPDATE operations_shadow_training_packages
         SET content_weight_grams = content_weight_grams + 1
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, overlay.trainingPackage.id],
      ),
      /package facts are immutable|PACKAGE_EVIDENCE_MISMATCH/u,
      'Copied package evidence cannot be tampered with',
    )
    await rejected(
      pool.query(
        `UPDATE operations_shadow_training_pick_tasks
         SET title = 'Tampered training pick'
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, overlay.task.id],
      ),
      /pick task facts are immutable|PICK_EVIDENCE_MISMATCH/u,
      'Copied pick evidence cannot be tampered with',
    )
    await rejected(
      pool.query(
        `UPDATE operations_shadow_training_runs
         SET state = 'reset', reset_at = now(), reset_reason = NULL,
             row_version = row_version + 1, updated_by = $3,
             updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, planRun.id, actorEmail],
      ),
      /operations_shadow_training_runs_reset_valid/u,
      'Reset terminal facts cannot be null',
    )

    const labelLink = (await pool.query(
      `INSERT INTO operations_shadow_training_label_links (
         organization_id, training_run_id, training_package_id, status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'create_prepared')
       RETURNING id::text, global_id`,
      [ids.organization, planRun.id, overlay.trainingPackage.id],
    )).rows[0]
    assert.match(labelLink.global_id, /^gtll[0-9a-v]{12}$/u)
    await pool.query(
      `UPDATE operations_shadow_training_label_links
       SET status = 'create_unknown', updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, labelLink.id],
    )
    for (const illegalRetryState of ['create_prepared', 'created']) {
      await rejected(
        pool.query(
          `UPDATE operations_shadow_training_label_links
           SET status = $3, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [ids.organization, labelLink.id, illegalRetryState],
        ),
        /Illegal Shadow training label transition/u,
        'An unknown label outcome cannot be downgraded or retried',
      )
    }
    await rejected(
      pool.query(
        `UPDATE operations_shadow_training_runs
         SET state = 'reset', reset_at = now(), reset_reason = 'Reset test',
             row_version = row_version + 1, updated_by = $3,
             updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, planRun.id, actorEmail],
      ),
      /label outcome must be positively reconciled/u,
      'Unknown label outcomes must block reset',
    )
    await pool.query(
      `UPDATE operations_shadow_training_label_links
       SET status = 'create_reconciled_none', updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, labelLink.id],
    )
    const completedRun = await completeTrainingLifecycle(
      pool,
      shopify,
      planRun,
      overlay.trainingPackage,
      overlay.task,
      facts.material,
    )
    assert.equal(completedRun.row_version, '5')
    await resetRun(pool, shopify, planRun, 'Completed training may reset')
    const activeAfterReset = await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'active', revision = revision + 1,
           updated_by = $2, updated_at = now()
       WHERE organization_id = $1::uuid
       RETURNING state`,
      [ids.organization, actorEmail],
    )
    assert.equal(activeAfterReset.rows[0].state, 'active')
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'shadow', revision = revision + 1,
           updated_by = $2, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [ids.organization, actorEmail],
    )
    facts.material = (await pool.query(
      `SELECT id::text, global_id, name, row_version::text
       FROM operations_packaging_materials
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, facts.material.id],
    )).rows[0]

    const evidenceByGlobalId = new Map()
    const persistence = shadowTrainingPersistence(pool, evidenceByGlobalId)
    let persistedRun = await persistence.enableOperationsShadowTrainingInPostgres({
      organizationId: ids.organization,
      actorEmail,
      orderGlobalId: shopify.order.global_id,
      confirmation: 'local_training_only',
      reason: 'Exercise the complete persistence-backed training lifecycle',
      idempotencyKey: 'shadow-training-persistence-enable',
    })
    assert.equal(persistedRun.state, 'enabled')
    assert.equal(persistedRun.rowVersion, 0)
    assert.match(persistedRun.globalId, /^gtrn[0-9a-v]{12}$/u)

    const persistedEvidenceRecord = await createSealedEvidence(
      pool,
      shopify,
      facts,
      {
        key: 'persistence-lifecycle',
        runGlobalId: persistedRun.globalId,
        runRowVersion: persistedRun.rowVersion,
      },
    )
    evidenceByGlobalId.set(
      persistedEvidenceRecord.global_id,
      persistenceEvidence(shopify, facts, persistedEvidenceRecord),
    )
    await withReplicaSession(pool, (client) => client.query(
      `UPDATE operations_orders
       SET status = 'validated', row_version = row_version + 1,
           updated_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, shopify.order.id, actorEmail],
    ))
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'read_only', revision = revision + 1,
           updated_by = $2, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [ids.organization, actorEmail],
    )
    const mirroredOrder = await persistence
      .readOperationsShadowTrainingForOrderInPostgres({
        organizationId: ids.organization,
        orderGlobalId: shopify.order.global_id,
      })
    assert.equal(mirroredOrder.run.sourceChanged, true)
    assert.equal(mirroredOrder.run.sourceStatus, 'validated')
    assert.equal(mirroredOrder.run.rowVersion, 0)
    assert.equal(mirroredOrder.run.candidateChanged, false)
    assert.equal(mirroredOrder.run.restartRequiredBeforePlan, false)
    assert.equal(mirroredOrder.run.activationChanged, true)
    assert.deepEqual(
      Array.from(mirroredOrder.run.availableActions),
      ['plan', 'reset'],
      'Order-only provider mirroring stays plannable from the exact candidate snapshot',
    )
    persistedRun = await persistence.planOperationsShadowTrainingInPostgres({
      organizationId: ids.organization,
      actorEmail,
      runGlobalId: persistedRun.globalId,
      cartonizationEvidenceGlobalId: persistedEvidenceRecord.global_id,
      expectedRowVersion: persistedRun.rowVersion,
      reason: 'Bind exact sealed evidence after a provider mirror update',
      idempotencyKey: 'shadow-training-persistence-plan',
    })
    assert.equal(persistedRun.state, 'planned')
    assert.equal(persistedRun.rowVersion, 1)
    assert.equal(persistedRun.sourceChanged, true)
    assert.match(persistedRun.packages[0].globalId, /^gtpk[0-9a-v]{12}$/u)
    assert.match(persistedRun.pickTasks[0].globalId, /^gtpt[0-9a-v]{12}$/u)

    const persistenceTransitions = [
      ['releaseOperationsShadowTrainingInPostgres', 'released', 'release', 'disabled'],
      ['confirmOperationsShadowTrainingPicksInPostgres', 'picked', 'pick', 'active'],
      ['verifyOperationsShadowTrainingPackInPostgres', 'packed', 'pack', 'frozen'],
      ['completeOperationsShadowTrainingInPostgres', 'completed', 'complete', 'shadow'],
    ]
    for (const [method, expectedState, key, safetyState] of persistenceTransitions) {
      await pool.query(
        `UPDATE operations_activation_scopes
         SET state = $2, revision = revision + 1,
             updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid`,
        [ids.organization, safetyState, actorEmail],
      )
      persistedRun = await persistence[method]({
        organizationId: ids.organization,
        actorEmail,
        runGlobalId: persistedRun.globalId,
        expectedRowVersion: persistedRun.rowVersion,
        reason: `Persistence-backed ${key} training transition`,
        idempotencyKey: `shadow-training-persistence-${key}`,
      })
      assert.equal(persistedRun.state, expectedState)
      assert.equal(
        persistedRun.activationChanged,
        true,
        `${safetyState} remains an audit difference, not a local-training blocker`,
      )
    }
    assert.equal(persistedRun.rowVersion, 5)
    assert.ok(persistedRun.completedAt)
    await rejected(
      pool.query(
        `UPDATE operations_shadow_training_packages
         SET status = 'packed', packed_by = $3,
             packed_at = packed_at + interval '1 second',
             completed_at = NULL, updated_at = now()
         WHERE organization_id = $1::uuid
           AND training_run_id = (
             SELECT id
             FROM operations_shadow_training_runs
             WHERE organization_id = $1::uuid AND global_id = $2
           )
           AND status = 'completed'`,
        [ids.organization, persistedRun.globalId, 'tamper@example.com'],
      ),
      /Shadow training package packing evidence is immutable/u,
      'Completed-to-packed Undo cannot rewrite the original packing actor or timestamp',
    )
    const undoExpectations = [
      { state: 'packed', packageStatus: 'packed', pickStatus: 'picked', key: 'complete' },
      { state: 'picked', packageStatus: 'planned', pickStatus: 'picked', key: 'pack' },
      { state: 'released', packageStatus: 'planned', pickStatus: 'ready', key: 'pick' },
      { state: 'planned', packageStatus: 'planned', pickStatus: 'ready', key: 'release' },
    ]
    for (const expected of undoExpectations) {
      const undoInput = {
        organizationId: ids.organization,
        actorEmail,
        runGlobalId: persistedRun.globalId,
        expectedRowVersion: persistedRun.rowVersion,
        reason: `Undo only the local ${expected.key} training step`,
        idempotencyKey: `shadow-training-persistence-undo-${expected.key}`,
      }
      persistedRun = await persistence.undoOperationsShadowTrainingInPostgres(undoInput)
      assert.equal(persistedRun.state, expected.state)
      assert.equal(persistedRun.packages[0].status, expected.packageStatus)
      assert.equal(persistedRun.pickTasks[0].status, expected.pickStatus)
      assert.equal(persistedRun.completedAt, null)
      assert.equal(persistedRun.counters.commerceProviderWrites, 0)
      assert.equal(persistedRun.counters.productionPostage, 0)
      assert.equal(persistedRun.counters.inventoryMutations, 0)
      assert.equal(persistedRun.counters.packagingStockMutations, 0)
      if (expected.key === 'complete') {
        const replay = await persistence.undoOperationsShadowTrainingInPostgres(undoInput)
        assert.equal(replay.state, expected.state)
        assert.equal(
          replay.rowVersion,
          persistedRun.rowVersion,
          'Exact idempotent replay does not apply a second rewind',
        )
        await rejected(
          persistence.undoOperationsShadowTrainingInPostgres({
            ...undoInput,
            reason: 'Reuse the undo key for a different request',
          }),
          /OPERATIONS_SHADOW_TRAINING_IDEMPOTENCY_REUSED|different training command/u,
          'Undo idempotency keys cannot be reused for a different request',
        )
        await rejected(
          persistence.undoOperationsShadowTrainingInPostgres({
            ...undoInput,
            idempotencyKey: 'shadow-training-persistence-undo-stale-version',
          }),
          /OPERATIONS_SHADOW_TRAINING_VERSION_CONFLICT|changed after it was opened/u,
          'Undo rejects a stale run row version',
        )
      }
    }
    assert.equal(persistedRun.rowVersion, 9)
    await rejected(
      persistence.undoOperationsShadowTrainingInPostgres({
        organizationId: ids.organization,
        actorEmail,
        runGlobalId: persistedRun.globalId,
        expectedRowVersion: persistedRun.rowVersion,
        reason: 'Attempt to undo immutable planning facts',
        idempotencyKey: 'shadow-training-persistence-undo-plan-forbidden',
      }),
      /OPERATIONS_SHADOW_TRAINING_TRANSITION_INVALID|not available from planned/u,
      'Planning facts require Reset rather than destructive undo',
    )
    const undoEvents = await pool.query(
      `SELECT event_type, from_state, to_state, payload
       FROM operations_shadow_training_events
       WHERE organization_id = $1::uuid
         AND training_run_id = (
           SELECT id FROM operations_shadow_training_runs
           WHERE organization_id = $1::uuid AND global_id = $2
         )
         AND event_type = 'shadow_training.undo'
       ORDER BY occurred_at, id`,
      [ids.organization, persistedRun.globalId],
    )
    assert.deepEqual(
      undoEvents.rows.map((event) => [event.from_state, event.to_state]),
      [
        ['completed', 'packed'],
        ['packed', 'picked'],
        ['picked', 'released'],
        ['released', 'planned'],
      ],
    )
    for (const event of undoEvents.rows) {
      assert.equal(event.payload.trainingOnly, true)
      assert.equal(event.payload.commerceProviderWrites, 0)
      assert.equal(event.payload.productionPostage, 0)
      assert.equal(event.payload.inventoryMutations, 0)
      assert.equal(event.payload.packagingStockMutations, 0)
    }
    for (const [method, expectedState, key] of persistenceTransitions) {
      persistedRun = await persistence[method]({
        organizationId: ids.organization,
        actorEmail,
        runGlobalId: persistedRun.globalId,
        expectedRowVersion: persistedRun.rowVersion,
        reason: `Repeat persistence-backed ${key} training transition after undo`,
        idempotencyKey: `shadow-training-persistence-repeat-${key}`,
      })
      assert.equal(persistedRun.state, expectedState)
    }
    assert.equal(persistedRun.rowVersion, 13)
    const persistenceCompletedAt = persistedRun.completedAt
    assert.ok(persistenceCompletedAt)
    persistedRun = await persistence.resetOperationsShadowTrainingInPostgres({
      organizationId: ids.organization,
      actorEmail,
      runGlobalId: persistedRun.globalId,
      expectedRowVersion: persistedRun.rowVersion,
      reason: 'Reset completed persistence-backed training history',
      idempotencyKey: 'shadow-training-persistence-reset',
    })
    assert.equal(persistedRun.state, 'reset')
    assert.equal(persistedRun.rowVersion, 14)
    assert.equal(
      persistedRun.completedAt,
      persistenceCompletedAt,
      'Reset preserves immutable completion audit evidence',
    )

    const persistenceActive = await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'active', revision = revision + 1,
           updated_by = $2, updated_at = now()
       WHERE organization_id = $1::uuid
       RETURNING state`,
      [ids.organization, actorEmail],
    )
    assert.equal(persistenceActive.rows[0].state, 'active')
    await rejected(
      pool.query(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id,
           cartonization_evidence_id, version_number, status, method,
           solver_status, promised_delivery_at, explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 98,
           'planned', 'manual_override', 'not_run',
           now() + interval '1 day', '{}'::jsonb, $5
         )`,
        [
          ids.organization,
          shopify.order.id,
          facts.warehouse.id,
          persistedEvidenceRecord.id,
          actorEmail,
        ],
      ),
      /OPERATIONS_SHADOW_TRAINING_EVIDENCE_CANONICAL_FORBIDDEN/u,
      'Training-only evidence cannot authorize a canonical plan in Active',
    )
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'shadow', revision = revision + 1,
           updated_by = $2, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [ids.organization, actorEmail],
    )
    await withReplicaSession(pool, (client) => client.query(
      `UPDATE operations_orders
       SET status = 'imported', row_version = row_version + 1,
           updated_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, shopify.order.id, actorEmail],
    ))

    const preSealDriftAuthorization = await currentAuthorization(pool, shopify)
    const preSealDriftRun = await insertRun(pool, shopify, {
      generation: 40,
      idempotencyKey: 'shadow-training-pre-seal-candidate-drift',
    })
    await pool.query(
      `UPDATE operations_commerce_order_candidates
       SET row_version = row_version + 1, updated_by = $3,
           updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, shopify.candidate.id, actorEmail],
    )
    const preSealDriftedRead = await persistence
      .readOperationsShadowTrainingForOrderInPostgres({
        organizationId: ids.organization,
        orderGlobalId: shopify.order.global_id,
      })
    assert.equal(preSealDriftedRead.run.candidateChanged, true)
    assert.equal(preSealDriftedRead.run.trainingEvidenceSealed, false)
    assert.equal(preSealDriftedRead.run.restartRequiredBeforePlan, true)
    assert.deepEqual(
      Array.from(preSealDriftedRead.run.availableActions),
      ['reset'],
      'Candidate drift before evidence sealing requires Reset',
    )
    await rejected(
      persistence.assertOperationsShadowTrainingEvidenceRequestInPostgres({
        organizationId: ids.organization,
        runGlobalId: preSealDriftRun.global_id,
        expectedRunRowVersion: Number(preSealDriftRun.row_version),
        accountGlobalId: preSealDriftAuthorization.account_global_id,
        candidateGlobalId: shopify.candidate.global_id,
        expectedCandidateRowVersion:
          Number(preSealDriftAuthorization.candidate_row_version),
        warehouseGlobalId: facts.warehouse.global_id,
      }),
      /OPERATIONS_SHADOW_TRAINING_EVIDENCE_AUTHORITY_INVALID|no longer matches/u,
      'Candidate drift before evidence sealing rejects route authorization',
    )
    await resetRun(
      pool,
      shopify,
      preSealDriftRun,
      'Reset candidate drift before evidence sealing',
    )

    const driftRun = await insertRun(pool, shopify, {
      generation: 41,
      idempotencyKey: 'shadow-training-candidate-drift',
    })
    const driftEvidence = await createSealedEvidence(
      pool,
      shopify,
      facts,
      { key: 'candidate-drift', runGlobalId: driftRun.global_id },
    )
    await withReplicaSession(pool, (client) => client.query(
      `UPDATE operations_cartonization_rate_evidence
       SET status = 'partial'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, driftEvidence.id],
    ))
    evidenceByGlobalId.set(
      driftEvidence.global_id,
      {
        ...persistenceEvidence(shopify, facts, driftEvidence),
        status: 'partial',
      },
    )
    const crossRun = await insertRun(pool, faire, {
      generation: 2,
      idempotencyKey: 'shadow-training-cross-run-fence',
    })
    const wrongMaterialGlobalId = (
      await pool.query(`SELECT allocate_global_reference('gmat') AS global_id`)
    ).rows[0].global_id
    const packageMismatchCases = [
      ['material', { materialGlobalId: wrongMaterialGlobalId }],
      ['name', { materialName: 'Wrong copied material name' }],
      ['dimensions', {
        dimensions: { length: 281, width: 230, height: 180 },
      }],
      ['weight', { contentWeightGrams: 2401 }],
      ['allocations', {
        allocations: [{ ...driftEvidence.allocation, quantity: 3 }],
      }],
      ['hash', { packageHash: sha('wrong-package-hash') }],
    ]
    for (const [field, variant] of packageMismatchCases) {
      await rejected(
        attemptPlanVariant(pool, shopify, driftRun, driftEvidence, variant),
        /OPERATIONS_SHADOW_TRAINING_PACKAGE_EVIDENCE_MISMATCH/u,
        `INSERT-time package ${field} mismatch must fail deferred validation`,
      )
    }
    const wrongLineGlobalId = (
      await pool.query(`SELECT allocate_global_reference('gcal') AS global_id`)
    ).rows[0].global_id
    const wrongProductGlobalId = (
      await pool.query(`SELECT allocate_global_reference('gp') AS global_id`)
    ).rows[0].global_id
    const pickMismatchCases = [
      ['line', { ...driftEvidence.allocation, lineGlobalId: wrongLineGlobalId }],
      ['product', {
        ...driftEvidence.allocation,
        productGlobalId: wrongProductGlobalId,
      }],
      ['title', { ...driftEvidence.allocation, title: 'Wrong pick title' }],
      ['quantity', { ...driftEvidence.allocation, quantity: 1 }],
    ]
    for (const [field, pick] of pickMismatchCases) {
      await rejected(
        attemptPlanVariant(pool, shopify, driftRun, driftEvidence, { pick }),
        /OPERATIONS_SHADOW_TRAINING_PICK_EVIDENCE_MISMATCH/u,
        `INSERT-time pick ${field} mismatch must fail deferred validation`,
      )
    }
    await rejected(
      attemptPlanVariant(pool, shopify, driftRun, driftEvidence, {
        packageRunId: crossRun.id,
        omitPick: true,
        skipRunUpdate: true,
      }),
      /OPERATIONS_SHADOW_TRAINING_PACKAGE_EVIDENCE_MISMATCH/u,
      'A package copied into a different training run must be rejected',
    )
    await rejected(
      pool.query(
        `INSERT INTO operations_shadow_training_pick_tasks (
           organization_id, training_run_id, training_package_id,
           task_sequence, source_line_global_id, product_global_id,
           title, quantity
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 99, $4, $5, $6, $7
         )`,
        [
          ids.organization,
          crossRun.id,
          overlay.trainingPackage.id,
          driftEvidence.allocation.lineGlobalId,
          driftEvidence.allocation.productGlobalId,
          driftEvidence.allocation.title,
          driftEvidence.allocation.quantity,
        ],
      ),
      /operations_shadow_training_pick_tasks_package_fkey/u,
      'A pick task cannot reference a package from another training run',
    )
    await rejected(
      attemptPlanVariant(pool, shopify, driftRun, driftEvidence, {
        omitPick: true,
      }),
      /OPERATIONS_SHADOW_TRAINING_PLAN_COVERAGE_MISMATCH/u,
      'Planning cannot omit the pick copied from an evidence allocation',
    )
    await resetRun(pool, faire, crossRun, 'Finish cross-run isolation test')
    await rejected(
      pool.query(
        `UPDATE operations_shadow_training_runs
         SET cartonization_evidence_id = $3::uuid,
             cartonization_evidence_global_id = $4,
             cartonization_evidence_sha256 = $5,
             warehouse_id = $6::uuid, state = 'planned',
             row_version = row_version + 1,
             updated_by = $7, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [
          ids.organization,
          driftRun.id,
          driftEvidence.id,
          driftEvidence.global_id,
          driftEvidence.evidenceHash,
          driftEvidence.warehouseId,
          actorEmail,
        ],
      ),
      /OPERATIONS_SHADOW_TRAINING_PLAN_COVERAGE_MISMATCH/u,
      'Planning must cover every sealed package and allocation',
    )
    await pool.query(
      `UPDATE operations_commerce_order_candidates
       SET row_version = row_version + 1, updated_by = $3,
           updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, shopify.candidate.id, actorEmail],
    )
    await rejected(
      persistence.assertOperationsShadowTrainingEvidenceRequestInPostgres({
        organizationId: ids.organization,
        runGlobalId: driftRun.global_id,
        expectedRunRowVersion: Number(driftRun.row_version),
        accountGlobalId: driftEvidence.accountGlobalId,
        candidateGlobalId: shopify.candidate.global_id,
        expectedCandidateRowVersion: driftEvidence.candidateRowVersion,
        warehouseGlobalId: facts.warehouse.global_id,
      }),
      /OPERATIONS_SHADOW_TRAINING_EVIDENCE_AUTHORITY_INVALID|no longer matches this order, connection, candidate, or warehouse request|source.*changed/u,
      'Candidate revision drift must reject any new evidence authorization',
    )
    const postSealDriftedRead = await persistence
      .readOperationsShadowTrainingForOrderInPostgres({
        organizationId: ids.organization,
        orderGlobalId: shopify.order.global_id,
      })
    assert.equal(postSealDriftedRead.run.candidateChanged, true)
    assert.equal(postSealDriftedRead.run.trainingEvidenceSealed, true)
    assert.equal(
      postSealDriftedRead.run.cartonizationEvidenceGlobalId,
      driftEvidence.global_id,
      'Reload projects the exact pre-drift sealed evidence for reuse',
    )
    assert.equal(postSealDriftedRead.run.restartRequiredBeforePlan, false)
    assert.deepEqual(
      Array.from(postSealDriftedRead.run.availableActions),
      ['plan', 'reset'],
      'Candidate drift after exact evidence sealing keeps the frozen Plan action',
    )
    const frozenDriftOverlay = await persistence
      .planOperationsShadowTrainingInPostgres({
        organizationId: ids.organization,
        actorEmail,
        runGlobalId: driftRun.global_id,
        cartonizationEvidenceGlobalId:
          postSealDriftedRead.run.cartonizationEvidenceGlobalId,
        expectedRowVersion: Number(driftRun.row_version),
        reason: 'Reuse the exact sealed evidence after provider candidate drift',
        idempotencyKey: 'shadow-training-post-seal-drift-plan',
      })
    assert.equal(frozenDriftOverlay.state, 'planned')
    assert.match(frozenDriftOverlay.packages[0].globalId, /^gtpk[0-9a-v]{12}$/u)
    const driftedRead = await persistence.readOperationsShadowTrainingForOrderInPostgres({
      organizationId: ids.organization,
      orderGlobalId: shopify.order.global_id,
    })
    assert.equal(
      driftedRead.run?.sourceChanged,
      true,
      'The frozen training overlay remains usable and visibly reports provider source drift',
    )
    await resetRun(pool, shopify, driftRun, 'Discard completed frozen drift proof')

    const unresolvedLineGlobalId = await addUnresolvedCandidateLine(pool, faire)
    assert.match(unresolvedLineGlobalId, /^gcol[0-9a-v]{12}$/u)
    await rejected(
      insertRun(pool, faire, {
        generation: 3,
        idempotencyKey: 'shadow-training-mixed-lines-db-rejected',
      }),
      /untouched imported connected-store order/u,
      'The database authorization fence rejects mixed-resolution orders',
    )
    await rejected(
      persistence.enableOperationsShadowTrainingInPostgres({
        organizationId: ids.organization,
        actorEmail,
        orderGlobalId: faire.order.global_id,
        confirmation: 'local_training_only',
        reason: 'Mixed resolved and unresolved lines must not train',
        idempotencyKey: 'shadow-training-mixed-lines-rejected',
      }),
      /no resolved training lines/u,
      'An order with a mixture of resolved and unresolved lines is ineligible',
    )

    const downstreamRun = await insertRun(pool, shopify, {
      generation: 42,
      idempotencyKey: 'shadow-training-downstream-primer',
    })
    await resetRun(pool, shopify, downstreamRun, 'Prime downstream fence')
    await withReplicaSession(pool, (client) => client.query(
      `INSERT INTO operations_fulfillment_plans (
         organization_id, order_id, warehouse_id, version_number,
         status, method, solver_status, promised_delivery_at,
         explanation, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 99,
         'planned', 'manual_override', 'not_run', now() + interval '1 day',
         '{}'::jsonb, $4
       )`,
      [ids.organization, shopify.order.id, facts.warehouse.id, actorEmail],
    ))
    await rejected(
      insertRun(pool, shopify, {
        generation: 43,
        idempotencyKey: 'shadow-training-downstream-rejected',
      }),
      /untouched imported connected-store order/u,
      'Direct run inserts must reject an order with canonical downstream facts',
    )

    await withReplicaSession(pool, (client) => client.query(
      `UPDATE operations_orders
       SET status = 'shipped', row_version = row_version + 1,
           updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, faire.order.id],
    ))
    await verifyCanonicalWritesAreNotGloballyShadowBlocked(pool, shopify)
    await verifyCanonicalWritesAreNotGloballyShadowBlocked(pool, faire)

    const retained = await pool.query(
      `SELECT count(*)::integer AS run_count,
              max(commerce_provider_write_count)::integer AS provider_writes,
              max(production_postage_count)::integer AS production_postage,
              max(inventory_mutation_count)::integer AS inventory_mutations,
              max(packaging_stock_mutation_count)::integer AS stock_mutations
       FROM operations_shadow_training_runs
       WHERE organization_id = $1::uuid`,
      [ids.organization],
    )
    assert.ok(retained.rows[0].run_count >= 6)
    assert.deepEqual(
      {
        providerWrites: retained.rows[0].provider_writes,
        productionPostage: retained.rows[0].production_postage,
        inventoryMutations: retained.rows[0].inventory_mutations,
        stockMutations: retained.rows[0].stock_mutations,
      },
      {
        providerWrites: 0,
        productionPostage: 0,
        inventoryMutations: 0,
        stockMutations: 0,
      },
    )
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container =
    `clawpilot-shadow-training-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=shadow_training',
      '-e', 'POSTGRES_DB=shadow_training',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl =
      `postgresql://postgres:shadow_training@127.0.0.1:${port}`
      + '/shadow_training'
    await waitForPostgres(databaseUrl)
    command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PGSSLMODE: 'disable',
      },
      timeout: 300_000,
    })
    await installFutureIndependentControl(databaseUrl)
    await verify(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Operations Shadow training disposable-PostgreSQL acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
