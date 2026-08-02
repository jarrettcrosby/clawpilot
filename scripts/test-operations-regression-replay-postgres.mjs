#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const databaseUrl = String(process.env.DATABASE_URL || '').trim()
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is required for the rollback-only Operations PostgreSQL acceptance.',
  )
}

const migrationPath = fileURLToPath(
  new URL(
    '../db/migrations/0145_operations_two_pass_pack_rate_runs.sql',
    import.meta.url,
  ),
)
const migrationSql = readFileSync(migrationPath, 'utf8')
const pricingSemanticsMigrationPath = fileURLToPath(
  new URL(
    '../db/migrations/0146_operations_pack_rate_pricing_semantics.sql',
    import.meta.url,
  ),
)
const pricingSemanticsMigrationSql = readFileSync(
  pricingSemanticsMigrationPath,
  'utf8',
)
const token = randomUUID().replaceAll('-', '').slice(0, 16)
const scenarioId = `postgres-acceptance-${token}`
const replayGroupKey = `operations-postgres-acceptance:${token}`
const customerSourceKey = `postgres-acceptance:${token}:customer`
const artifactStoragePrefix =
  `clawpilot-document:postgres-acceptance:${token}`

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'clawpilot-operations-postgres-rollback-acceptance',
  max: 2,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 5_000,
})

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

function sha256(value) {
  const input = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(canonicalize(value)))
  return createHash('sha256').update(input).digest('hex')
}

function databaseErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function expectDatabaseError(client, label, pattern, operation) {
  const savepoint = `acceptance_${label.replaceAll(/[^a-z0-9_]/gi, '_')}`
  await client.query(`SAVEPOINT ${savepoint}`)
  let caught = null
  try {
    await operation()
  } catch (error) {
    caught = error
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
  if (!caught) {
    throw new Error(`${label} unexpectedly succeeded`)
  }
  assert.match(
    databaseErrorMessage(caught),
    pattern,
    `${label} returned the wrong database rejection`,
  )
}

function makeGraph({
  firstQuantity = 12,
  secondQuantity = 36,
  firstAllocationQuantity = firstQuantity,
  secondAllocationQuantity = secondQuantity,
  includeSecondLine = true,
  selectedCarrierCostMinor = 1840,
  packagePlanHash,
}) {
  const lines = [
    {
      lineKey: 'line-6oz',
      productKey: 'ag-6oz-bag',
      title: 'AG Alchemy 6 oz bag',
      requiredQuantity: firstQuantity,
      unitWeightGrams: 170,
    },
    ...(includeSecondLine
      ? [{
        lineKey: 'line-2oz',
        productKey: 'ag-2oz-bag',
        title: 'AG Alchemy 2 oz bag',
        requiredQuantity: secondQuantity,
        unitWeightGrams: 57,
      }]
      : []),
  ]
  const packages = [
    {
      packageKey: 'package-1',
      sequence: 1,
      materialCode: 'AG12V2',
      materialName: 'AG12V2 shipping carton',
      dimensionsMm: { length: 279, width: 229, height: 178 },
      tareWeightGrams: 250,
      allocations: [{
        lineKey: lines[0].lineKey,
        productKey: lines[0].productKey,
        title: lines[0].title,
        quantity: firstAllocationQuantity,
      }],
    },
    ...(includeSecondLine
      ? [{
        packageKey: 'package-2',
        sequence: 2,
        materialCode: 'CARTON-2OZ',
        materialName: '2 oz carton shipping box',
        dimensionsMm: { length: 356, width: 279, height: 203 },
        tareWeightGrams: 310,
        allocations: [{
          lineKey: lines[1].lineKey,
          productKey: lines[1].productKey,
          title: lines[1].title,
          quantity: secondAllocationQuantity,
        }],
      }]
      : []),
  ].map((item) => {
    const contentWeightGrams = item.allocations.reduce((total, allocation) => {
      const line = lines.find((candidate) => (
        candidate.lineKey === allocation.lineKey
        && candidate.productKey === allocation.productKey
      ))
      assert.ok(line, 'package allocation must reference one graph line')
      return total + (allocation.quantity * line.unitWeightGrams)
    }, 0)
    return {
      ...item,
      contentWeightGrams,
      grossWeightGrams: contentWeightGrams + item.tareWeightGrams,
    }
  })
  return {
    lines,
    packages,
    rates: [
      {
        provider: 'ups_rest',
        serviceCode: '03',
        serviceName: 'UPS Ground',
        carrierCostMinor: selectedCarrierCostMinor,
        selected: true,
      },
      {
        provider: 'fedex_rest',
        serviceCode: 'FEDEX_GROUND',
        serviceName: 'FedEx Ground',
        carrierCostMinor: selectedCarrierCostMinor + 115,
        selected: false,
      },
    ],
    packagePlanHash,
  }
}

async function insertRun(client, input) {
  const inputSnapshot = {
    acceptance: 'rollback-only-postgres',
    purpose: input.purpose,
    scenarioId: input.scenarioId,
  }
  const resultSnapshot = {
    packagePlanHash: input.graph.packagePlanHash,
    allocationHash: input.allocationHash,
    materialHash: input.materialHash,
    serviceHash: input.serviceHash,
  }
  const stageSnapshot = {
    stage: input.purpose,
    providerWrites: 0,
    postagePurchases: 0,
    labelWrites: 0,
  }
  const selectedRate = input.graph.rates.find((rate) => rate.selected)
  assert.ok(selectedRate, 'run graph must contain one selected rate')
  const isCheckout = input.purpose === 'checkout_quote'
  const checkoutShippingChargeMinor = 2350
  const result = await client.query(
    `INSERT INTO operations_pack_rate_runs (
       organization_id, replay_group_key, scenario_id, source_kind,
       source_reference, provider, checkout_source, purpose,
       prior_checkout_run_id, pipeline_id, customer_id,
       customer_resolution_outcome, status, blocker_code, policy_version,
       algorithm_version, input_hash, result_hash, input_snapshot,
       result_snapshot, stage_snapshot, line_count, package_count,
       rate_choice_count, currency, selected_provider,
       selected_service_code, selected_service_name,
       selected_carrier_cost_minor, customer_charge_minor, mud_markup_minor,
       margin_minor, idempotency_key, actor_email, pricing_semantics_version,
       provider_write_count,
       postage_purchase_count, label_write_count, expires_at
     ) VALUES (
       $1::uuid, $2, $3, 'sanitized_historical_replay', $4, 'shopify',
       'live_callback_recorded', $5, $6::uuid, $7::uuid, $8::uuid, $9,
       'succeeded', NULL, 'postgres-acceptance-policy-v1',
       'postgres-acceptance-algorithm-v1', $10, $11, $12::jsonb, $13::jsonb,
       $14::jsonb, $15, $16, $17, 'USD', $18, $19, $20, $21, $22, NULL,
       $22::bigint - $21::bigint, $23, $24, 2, 0, 0, 0,
       CASE WHEN $5 = 'checkout_quote'
         THEN now() + interval '15 minutes'
         ELSE NULL
       END
     )
     RETURNING id::text, global_id, created_at`,
    [
      input.organizationId,
      input.replayGroupKey,
      input.scenarioId,
      input.sourceReference,
      input.purpose,
      input.priorCheckoutRunId,
      isCheckout ? null : input.pipelineId,
      isCheckout ? null : input.customerId,
      isCheckout ? 'not_attempted' : 'created',
      sha256(inputSnapshot),
      sha256(resultSnapshot),
      JSON.stringify(inputSnapshot),
      JSON.stringify(resultSnapshot),
      JSON.stringify(stageSnapshot),
      input.graph.lines.length,
      input.graph.packages.length,
      input.graph.rates.length,
      selectedRate.provider,
      selectedRate.serviceCode,
      selectedRate.serviceName,
      selectedRate.carrierCostMinor,
      checkoutShippingChargeMinor,
      `${input.replayGroupKey}:${input.purpose}`,
      input.actorEmail,
    ],
  )
  return result.rows[0]
}

async function insertRate(client, input) {
  const normalizedResponse = {
    replayOnly: true,
    noProviderCall: true,
    packageCount: input.packageCount,
    provider: input.rate.provider,
    serviceCode: input.rate.serviceCode,
    packagePlanHash: input.packagePlanHash,
  }
  await client.query(
    `INSERT INTO operations_pack_rate_run_rate_choices (
       organization_id, run_id, provider, service_code, service_name,
       carrier_cost_minor, currency, selected, recorded_fact_version,
       normalized_response
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, 'USD', $7,
       'sanitized-recorded-rate-v1', $8::jsonb
     )`,
    [
      input.organizationId,
      input.runId,
      input.rate.provider,
      input.rate.serviceCode,
      input.rate.serviceName,
      input.rate.carrierCostMinor,
      input.rate.selected,
      JSON.stringify(normalizedResponse),
    ],
  )
}

async function insertRunChildren(client, input) {
  for (const line of input.graph.lines) {
    const snapshot = {
      lineKey: line.lineKey,
      productKey: line.productKey,
      title: line.title,
      requiredQuantity: line.requiredQuantity,
      unitWeightGrams: line.unitWeightGrams,
    }
    await client.query(
      `INSERT INTO operations_pack_rate_run_lines (
         organization_id, run_id, line_key, product_key, title,
         required_quantity, unit_weight_grams, line_hash, line_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb
       )`,
      [
        input.organizationId,
        input.runId,
        line.lineKey,
        line.productKey,
        line.title,
        line.requiredQuantity,
        line.unitWeightGrams,
        sha256(snapshot),
        JSON.stringify(snapshot),
      ],
    )
  }
  for (const item of input.graph.packages) {
    const packageSnapshot = {
      packageKey: item.packageKey,
      sequence: item.sequence,
      materialCode: item.materialCode,
      materialName: item.materialName,
      dimensionsMm: item.dimensionsMm,
      contentWeightGrams: item.contentWeightGrams,
      tareWeightGrams: item.tareWeightGrams,
      grossWeightGrams: item.grossWeightGrams,
    }
    await client.query(
      `INSERT INTO operations_pack_rate_run_packages (
         organization_id, run_id, package_key, package_sequence,
         material_code, material_name, length_mm, width_mm, height_mm,
         content_weight_grams, tare_weight_grams, gross_weight_grams,
         allocation_count, package_hash, package_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15::jsonb
       )`,
      [
        input.organizationId,
        input.runId,
        item.packageKey,
        item.sequence,
        item.materialCode,
        item.materialName,
        item.dimensionsMm.length,
        item.dimensionsMm.width,
        item.dimensionsMm.height,
        item.contentWeightGrams,
        item.tareWeightGrams,
        item.grossWeightGrams,
        item.allocations.length,
        sha256(packageSnapshot),
        JSON.stringify(packageSnapshot),
      ],
    )
    for (const allocation of item.allocations) {
      const allocationSnapshot = {
        packageKey: item.packageKey,
        lineKey: allocation.lineKey,
        productKey: allocation.productKey,
        comparisonProductKey: allocation.productKey,
        title: allocation.title,
        quantity: allocation.quantity,
      }
      await client.query(
        `INSERT INTO operations_pack_rate_run_allocations (
           organization_id, run_id, package_key, line_key, product_key,
           comparison_product_key, title, quantity, allocation_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9
         )`,
        [
          input.organizationId,
          input.runId,
          item.packageKey,
          allocation.lineKey,
          allocation.productKey,
          allocation.productKey,
          allocation.title,
          allocation.quantity,
          sha256(allocationSnapshot),
        ],
      )
    }
  }
  for (const rate of input.graph.rates) {
    await insertRate(client, {
      organizationId: input.organizationId,
      runId: input.runId,
      rate,
      packageCount: input.graph.packages.length,
      packagePlanHash: input.graph.packagePlanHash,
    })
  }
}

async function insertPackingSlipArtifact(client, input) {
  const payload = Buffer.from(
    [
      '%PDF-1.4',
      `% ClawPilot rollback-only package ${input.package.packageKey}`,
      '1 0 obj << /Type /Catalog >> endobj',
      'trailer << /Root 1 0 R >>',
      '%%EOF',
      '',
    ].join('\n'),
  )
  const trackingNumber =
    `1ZACCEPT${String(input.package.sequence).padStart(10, '0')}`
  const recordedLabelReference =
    `recorded-label:${token}:${input.package.sequence}`
  const lines = [...input.package.allocations]
    .sort((left, right) => (
      left.lineKey.localeCompare(right.lineKey)
      || left.productKey.localeCompare(right.productKey)
    ))
    .map((allocation) => ({
      lineKey: allocation.lineKey,
      productKey: allocation.productKey,
      title: allocation.title,
      quantity: allocation.quantity,
    }))
  const renderSnapshot = {
    documentStage: 'recorded_fulfillment_replay',
    runGlobalId: input.fulfillmentRun.global_id,
    scenarioId,
    sourceReference: `shopify-recorded-${token}`,
    packageKey: input.package.packageKey,
    packageSequence: input.package.sequence,
    packageCount: input.packageCount,
    trackingNumber,
    carrier: 'ups_rest',
    serviceCode: '03',
    recordedLabelReference,
    providerWriteCount: 0,
    postagePurchaseCount: 0,
    lines,
  }
  const contentSha256 = sha256(payload)
  const artifact = await client.query(
    `INSERT INTO operations_print_artifacts (
       organization_id, document_type, format, media_size, content_sha256,
       byte_length, storage_reference, created_by
     ) VALUES (
       $1::uuid, 'packing_slip', 'PDF', 'letter', $2, $3, $4, $5
     )
     RETURNING id::text, global_id`,
    [
      input.organizationId,
      contentSha256,
      payload.byteLength,
      `${artifactStoragePrefix}:${input.package.packageKey}`,
      input.actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_print_artifact_payloads (
       artifact_id, organization_id, mime_type, filename, payload,
       template_version, render_snapshot
     ) VALUES (
       $1::uuid, $2::uuid, 'application/pdf', $3, $4,
       'postgres-acceptance-v1', $5::jsonb
     )`,
    [
      artifact.rows[0].id,
      input.organizationId,
      `acceptance-${input.package.packageKey}.pdf`,
      payload,
      JSON.stringify(renderSnapshot),
    ],
  )
  return {
    ...artifact.rows[0],
    trackingNumber,
    recordedLabelReference,
  }
}

async function insertFinalization(client, input) {
  await client.query(
    `INSERT INTO operations_pack_rate_run_package_finalizations (
       organization_id, run_id, package_key, response_source, carrier,
       service_code, tracking_number, recorded_label_reference,
       packing_slip_artifact_id, provider_write_count,
       postage_purchase_count
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'recorded_label_response', 'ups_rest',
       '03', $4, $5, $6::uuid, 0, 0
     )`,
    [
      input.organizationId,
      input.runId,
      input.packageKey,
      input.trackingNumber,
      input.recordedLabelReference,
      input.artifactId,
    ],
  )
}

async function main() {
  const client = await pool.connect()
  let transactionOpen = false
  const createdGlobalIds = []
  let createdGlobalSuffixes = []
  let migrationPreexisting = false
  let databaseName = ''
  let organizationName = ''
  try {
    const identity = await client.query(
      `SELECT
         current_database() AS database_name,
         to_regclass('public.operations_pack_rate_runs') IS NOT NULL
           AS migration_preexisting`,
    )
    databaseName = identity.rows[0].database_name
    migrationPreexisting = identity.rows[0].migration_preexisting

    await client.query('BEGIN')
    transactionOpen = true
    await client.query(`SET LOCAL lock_timeout = '15s'`)
    await client.query(`SET LOCAL statement_timeout = '120s'`)
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtext('clawpilot:operations:postgres-rollback-acceptance')
       )`,
    )

    // Applying the idempotent migration here proves a fresh dev database can
    // accept the contract. PostgreSQL rolls the DDL back with all test rows.
    await client.query(migrationSql)
    await client.query(pricingSemanticsMigrationSql)

    const context = await client.query(
      `SELECT
         activation.organization_id::text AS organization_id,
         activation.data_pipeline_id::text AS pipeline_id,
         organization.name AS organization_name,
         membership.user_email AS actor_email
       FROM operations_activation_scopes activation
       JOIN workspace_organizations organization
         ON organization.id = activation.organization_id
       JOIN pipeline_spaces pipeline
         ON pipeline.workspace_organization_id = activation.organization_id
        AND pipeline.id = activation.data_pipeline_id
       JOIN app_user_organization_memberships membership
         ON membership.organization_id = activation.organization_id
        AND membership.status = 'active'
       JOIN app_users actor
         ON actor.email = membership.user_email
        AND actor.status = 'active'
       ORDER BY
         CASE
           WHEN lower(btrim(organization.name)) = 'ag alchemy, llc' THEN 0
           ELSE 1
         END,
         CASE membership.role
           WHEN 'owner' THEN 0
           WHEN 'admin' THEN 1
           ELSE 2
         END,
         membership.user_email
       LIMIT 1`,
    )
    assert.ok(
      context.rows[0],
      'dev Postgres needs one activated Operations organization, pipeline, and active actor',
    )
    const {
      organization_id: organizationId,
      pipeline_id: pipelineId,
      organization_name: selectedOrganizationName,
      actor_email: actorEmail,
    } = context.rows[0]
    organizationName = selectedOrganizationName

    const packagePlanHash = sha256({
      token,
      packages: ['AG12V2', 'CARTON-2OZ'],
    })
    const checkoutGraph = makeGraph({
      selectedCarrierCostMinor: 1840,
      packagePlanHash,
    })
    const fulfillmentGraph = makeGraph({
      selectedCarrierCostMinor: 1995,
      packagePlanHash,
    })
    const sharedRunInput = {
      organizationId,
      scenarioId,
      sourceReference: `shopify-recorded-${token}`,
      actorEmail,
      pipelineId,
      allocationHash: sha256({
        packages: checkoutGraph.packages.map((item) => item.allocations),
      }),
      materialHash: sha256(
        checkoutGraph.packages.map((item) => item.materialCode),
      ),
      serviceHash: sha256({ provider: 'ups_rest', serviceCode: '03' }),
    }

    const checkoutRun = await insertRun(client, {
      ...sharedRunInput,
      replayGroupKey,
      purpose: 'checkout_quote',
      priorCheckoutRunId: null,
      customerId: null,
      graph: checkoutGraph,
    })
    createdGlobalIds.push(checkoutRun.global_id)
    await insertRunChildren(client, {
      organizationId,
      runId: checkoutRun.id,
      graph: checkoutGraph,
    })

    const neutralCheckout = await client.query(
      `SELECT pipeline_id, customer_id, customer_resolution_outcome
       FROM operations_pack_rate_runs
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [organizationId, checkoutRun.id],
    )
    assert.equal(neutralCheckout.rows[0].pipeline_id, null)
    assert.equal(neutralCheckout.rows[0].customer_id, null)
    assert.equal(
      neutralCheckout.rows[0].customer_resolution_outcome,
      'not_attempted',
    )

    const customerPayload = {
      replayOnly: true,
      noExternalSync: true,
      acceptanceToken: token,
    }
    const customer = await client.query(
      `INSERT INTO crm_organizations (
         pipeline_id, source_key, identity_key, name, account_type,
         relationship_type, description, source_payload, source_hash,
         sync_status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $2, 'Rollback-only PostgreSQL acceptance customer',
         'customer', 'customer',
         'Transaction-local customer used by Operations PostgreSQL acceptance.',
         $3::jsonb, $4, 'synced', $5, $5
       )
       RETURNING id::text, reference_code`,
      [
        pipelineId,
        customerSourceKey,
        JSON.stringify(customerPayload),
        sha256(customerPayload),
        actorEmail,
      ],
    )
    createdGlobalIds.push(customer.rows[0].reference_code)

    const fulfillmentRun = await insertRun(client, {
      ...sharedRunInput,
      replayGroupKey,
      purpose: 'fulfillment_execution',
      priorCheckoutRunId: checkoutRun.id,
      customerId: customer.rows[0].id,
      graph: fulfillmentGraph,
    })
    createdGlobalIds.push(fulfillmentRun.global_id)
    await insertRunChildren(client, {
      organizationId,
      runId: fulfillmentRun.id,
      graph: fulfillmentGraph,
    })

    // Force the initially-deferred completeness trigger now, before rollback.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')

    const completedRuns = await client.query(
      `SELECT
         count(*)::integer AS run_count,
         count(*) FILTER (
           WHERE purpose = 'checkout_quote'
             AND pipeline_id IS NULL
             AND customer_id IS NULL
         )::integer AS customer_neutral_checkout_count,
         count(*) FILTER (
           WHERE purpose = 'fulfillment_execution'
             AND pipeline_id = $3::uuid
             AND customer_id = $4::uuid
         )::integer AS resolved_fulfillment_count,
         count(*) FILTER (
           WHERE selected_provider = 'ups_rest'
             AND selected_service_code = '03'
         )::integer AS common_service_count,
         count(*) FILTER (
           WHERE pricing_semantics_version = 2
         )::integer AS corrected_pricing_count,
         count(*) FILTER (
           WHERE mud_markup_minor IS NOT NULL
         )::integer AS premature_mud_count,
         sum(provider_write_count)::integer AS provider_write_count,
         sum(postage_purchase_count)::integer AS postage_purchase_count,
         sum(label_write_count)::integer AS label_write_count
       FROM operations_pack_rate_runs
       WHERE organization_id = $1::uuid
         AND id = ANY($2::uuid[])`,
      [
        organizationId,
        [checkoutRun.id, fulfillmentRun.id],
        pipelineId,
        customer.rows[0].id,
      ],
    )
    assert.deepEqual(completedRuns.rows[0], {
      run_count: 2,
      customer_neutral_checkout_count: 1,
      resolved_fulfillment_count: 1,
      common_service_count: 2,
      corrected_pricing_count: 2,
      premature_mud_count: 0,
      provider_write_count: 0,
      postage_purchase_count: 0,
      label_write_count: 0,
    })

    await expectDatabaseError(
      client,
      'lineage_rejection',
      /Fulfillment execution lineage must reference the exact checkout quote context/,
      async () => {
        await client.query('SET CONSTRAINTS ALL DEFERRED')
        await insertRun(client, {
          ...sharedRunInput,
          replayGroupKey,
          sourceReference: `shopify-wrong-${token}`,
          purpose: 'fulfillment_execution',
          priorCheckoutRunId: checkoutRun.id,
          customerId: customer.rows[0].id,
          graph: fulfillmentGraph,
        })
      },
    )

    await expectDatabaseError(
      client,
      'single_selected_service_rejection',
      /operations_pack_rate_run_rate_choices_selected_unique|duplicate key/,
      async () => {
        await client.query('SET CONSTRAINTS ALL DEFERRED')
        const graph = makeGraph({
          firstQuantity: 1,
          firstAllocationQuantity: 1,
          includeSecondLine: false,
          selectedCarrierCostMinor: 1840,
          packagePlanHash: sha256({ token, rejection: 'selected-service' }),
        })
        const run = await insertRun(client, {
          ...sharedRunInput,
          replayGroupKey: `${replayGroupKey}:selected-service`,
          scenarioId: `${scenarioId}-selected`,
          sourceReference: `shopify-selected-${token}`,
          purpose: 'checkout_quote',
          priorCheckoutRunId: null,
          customerId: null,
          graph,
        })
        await insertRate(client, {
          organizationId,
          runId: run.id,
          rate: graph.rates[0],
          packageCount: 1,
          packagePlanHash: graph.packagePlanHash,
        })
        await insertRate(client, {
          organizationId,
          runId: run.id,
          rate: { ...graph.rates[1], selected: true },
          packageCount: 1,
          packagePlanHash: graph.packagePlanHash,
        })
      },
    )

    await expectDatabaseError(
      client,
      'quantity_conservation_rejection',
      /Pack-and-rate run is missing exact packages, allocations, or selected-rate evidence/,
      async () => {
        await client.query('SET CONSTRAINTS ALL DEFERRED')
        const graph = makeGraph({
          firstQuantity: 2,
          firstAllocationQuantity: 1,
          includeSecondLine: false,
          selectedCarrierCostMinor: 1840,
          packagePlanHash: sha256({ token, rejection: 'quantity' }),
        })
        const run = await insertRun(client, {
          ...sharedRunInput,
          replayGroupKey: `${replayGroupKey}:quantity`,
          scenarioId: `${scenarioId}-quantity`,
          sourceReference: `shopify-quantity-${token}`,
          purpose: 'checkout_quote',
          priorCheckoutRunId: null,
          customerId: null,
          graph,
        })
        await insertRunChildren(client, {
          organizationId,
          runId: run.id,
          graph,
        })
        await client.query('SET CONSTRAINTS ALL IMMEDIATE')
      },
    )

    await expectDatabaseError(
      client,
      'append_only_rejection',
      /Operational ledger, event, and billing evidence is append-only/,
      () => client.query(
        `UPDATE operations_pack_rate_runs
         SET stage_snapshot = stage_snapshot
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [organizationId, fulfillmentRun.id],
      ),
    )

    const varianceSnapshot = {
      checkoutRunGlobalId: checkoutRun.global_id,
      fulfillmentRunGlobalId: fulfillmentRun.global_id,
      causes: ['recorded_rate_changed'],
    }
    const variance = await client.query(
      `INSERT INTO operations_pack_rate_variances (
         organization_id, checkout_run_id, fulfillment_run_id,
         package_count_delta, checkout_carrier_cost_minor,
         checkout_customer_charge_minor, fulfillment_carrier_cost_minor,
         carrier_cost_variance_minor, realized_margin_minor, currency,
         allocation_changed, material_changed, service_changed, causes,
         comparison_hash
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 0, 1840, 2350, 1995, 155, 355,
         'USD', false, false, false, '["recorded_rate_changed"]'::jsonb, $4
       )
       RETURNING global_id`,
      [
        organizationId,
        checkoutRun.id,
        fulfillmentRun.id,
        sha256(varianceSnapshot),
      ],
    )
    createdGlobalIds.push(variance.rows[0].global_id)

    const preLabelGate = await client.query(
      `SELECT count(*)::integer AS finalization_count
       FROM operations_pack_rate_run_package_finalizations
       WHERE organization_id = $1::uuid
         AND run_id = $2::uuid`,
      [organizationId, fulfillmentRun.id],
    )
    assert.equal(
      preLabelGate.rows[0].finalization_count,
      0,
      'final packing slips must not exist before recorded tracking evidence',
    )

    const artifacts = []
    for (const item of fulfillmentGraph.packages) {
      const artifact = await insertPackingSlipArtifact(client, {
        organizationId,
        actorEmail,
        fulfillmentRun,
        package: item,
        packageCount: fulfillmentGraph.packages.length,
      })
      artifacts.push({ ...artifact, package: item })
      createdGlobalIds.push(artifact.global_id)
    }

    await expectDatabaseError(
      client,
      'final_document_gate_rejection',
      /Recorded final packing slip must match its immutable package allocation and tracking evidence/,
      () => insertFinalization(client, {
        organizationId,
        runId: fulfillmentRun.id,
        packageKey: artifacts[0].package.packageKey,
        trackingNumber: `${artifacts[0].trackingNumber}-MISMATCH`,
        recordedLabelReference: artifacts[0].recordedLabelReference,
        artifactId: artifacts[0].id,
      }),
    )

    for (const artifact of artifacts) {
      await insertFinalization(client, {
        organizationId,
        runId: fulfillmentRun.id,
        packageKey: artifact.package.packageKey,
        trackingNumber: artifact.trackingNumber,
        recordedLabelReference: artifact.recordedLabelReference,
        artifactId: artifact.id,
      })
    }

    const finalDocuments = await client.query(
      `SELECT
         count(*)::integer AS finalization_count,
         count(DISTINCT finalization.carrier || ':' || finalization.service_code)
           ::integer AS selected_service_count,
         count(DISTINCT finalization.tracking_number)::integer
           AS tracking_number_count,
         count(*) FILTER (
           WHERE artifact.document_type = 'packing_slip'
             AND artifact.format = 'PDF'
             AND artifact.media_size = 'letter'
             AND payload.mime_type = 'application/pdf'
             AND artifact.content_sha256
               = encode(digest(payload.payload, 'sha256'), 'hex')
             AND artifact.byte_length = octet_length(payload.payload)
         )::integer AS exact_document_count
       FROM operations_pack_rate_run_package_finalizations finalization
       JOIN operations_print_artifacts artifact
         ON artifact.organization_id = finalization.organization_id
        AND artifact.id = finalization.packing_slip_artifact_id
       JOIN operations_print_artifact_payloads payload
         ON payload.organization_id = artifact.organization_id
        AND payload.artifact_id = artifact.id
       WHERE finalization.organization_id = $1::uuid
         AND finalization.run_id = $2::uuid`,
      [organizationId, fulfillmentRun.id],
    )
    assert.deepEqual(finalDocuments.rows[0], {
      finalization_count: 2,
      selected_service_count: 1,
      tracking_number_count: 2,
      exact_document_count: 2,
    })

    const retainedEvidence = await client.query(
      `SELECT
         (SELECT count(*) FROM operations_pack_rate_runs
           WHERE scenario_id = $1)::integer AS runs,
         (SELECT count(*) FROM operations_pack_rate_run_lines
           WHERE run_id = ANY($2::uuid[]))::integer AS lines,
         (SELECT count(*) FROM operations_pack_rate_run_packages
           WHERE run_id = ANY($2::uuid[]))::integer AS packages,
         (SELECT count(*) FROM operations_pack_rate_run_allocations
           WHERE run_id = ANY($2::uuid[]))::integer AS allocations,
         (SELECT count(*) FROM operations_pack_rate_run_rate_choices
           WHERE run_id = ANY($2::uuid[]))::integer AS rate_choices,
         (SELECT count(*) FROM operations_pack_rate_run_package_finalizations
           WHERE run_id = $3::uuid)::integer AS finalizations,
         (SELECT count(*) FROM operations_pack_rate_variances
           WHERE fulfillment_run_id = $3::uuid)::integer AS variances`,
      [scenarioId, [checkoutRun.id, fulfillmentRun.id], fulfillmentRun.id],
    )
    assert.deepEqual(retainedEvidence.rows[0], {
      runs: 2,
      lines: 4,
      packages: 4,
      allocations: 4,
      rate_choices: 4,
      finalizations: 2,
      variances: 1,
    })

    const reservedSuffixes = await client.query(
      `SELECT global_reference_suffix(reference_code, prefix) AS suffix
       FROM crm_reference_registry
       WHERE reference_code = ANY($1::text[])
       ORDER BY reference_code`,
      [createdGlobalIds],
    )
    createdGlobalSuffixes = reservedSuffixes.rows.map((row) => row.suffix)
    assert.equal(
      createdGlobalSuffixes.length,
      createdGlobalIds.length,
      'every transaction-local Global ID must have one reserved suffix',
    )

    await client.query('ROLLBACK')
    transactionOpen = false

    // Keep the first connection checked out so this verification is performed
    // by a distinct PostgreSQL session after the rollback.
    const verifier = await pool.connect()
    try {
      const schemaState = await verifier.query(
        `SELECT
           to_regclass('public.operations_pack_rate_runs') IS NOT NULL
             AS migration_present`,
      )
      assert.equal(
        schemaState.rows[0].migration_present,
        migrationPreexisting,
        'transactional migration application changed schema after rollback',
      )

      const durableResidue = await verifier.query(
        `SELECT
           (SELECT count(*) FROM crm_organizations
             WHERE source_key = $1)::integer AS customers,
           (SELECT count(*) FROM crm_reference_registry
             WHERE reference_code = ANY($2::text[]))::integer AS references,
           (SELECT count(*) FROM crm_reference_number_registry
             WHERE number_value = ANY($3::text[]))::integer AS numbers`,
        [
          customerSourceKey,
          createdGlobalIds,
          createdGlobalSuffixes,
        ],
      )
      assert.deepEqual(durableResidue.rows[0], {
        customers: 0,
        references: 0,
        numbers: 0,
      })

      if (migrationPreexisting) {
        const operationsResidue = await verifier.query(
          `SELECT
             (SELECT count(*) FROM operations_pack_rate_runs
               WHERE scenario_id = $1)::integer AS runs,
             (SELECT count(*) FROM operations_pack_rate_variances
               WHERE global_id = ANY($2::text[]))::integer AS variances,
             (SELECT count(*) FROM operations_print_artifacts
               WHERE storage_reference LIKE $3)::integer AS artifacts`,
          [scenarioId, createdGlobalIds, `${artifactStoragePrefix}:%`],
        )
        assert.deepEqual(operationsResidue.rows[0], {
          runs: 0,
          variances: 0,
          artifacts: 0,
        })
      }
    } finally {
      verifier.release()
    }

    console.log('Operations PostgreSQL rollback acceptance passed.')
    console.log(`- database: ${databaseName}`)
    console.log(`- organization context: ${organizationName}`)
    console.log(
      `- migration 0145: transactionally applied (${migrationPreexisting
        ? 'already present before probe'
        : 'fresh-schema path exercised'})`,
    )
    console.log(
      '- migration 0146: transactionally applied with version-2 pricing semantics',
    )
    console.log(
      '- accepted: customer-neutral checkout -> resolved fulfillment, 2 packages, UPS + FedEx rates, 1 selected service, variance, and 2 tracking-bound packing slips',
    )
    console.log(
      '- rejected: broken lineage, a second selected service, quantity loss, append-only mutation, and mismatched final document evidence',
    )
    console.log(
      '- safety: 0 provider writes, 0 postage purchases, 0 label writes, transaction rolled back, and 0 retained rows verified from a second session',
    )
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the original acceptance failure.
      }
    }
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

await main()
