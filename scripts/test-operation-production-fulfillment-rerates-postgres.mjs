#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
const HASH = Object.freeze({
  account: 'a'.repeat(64),
  registeredOrigin: 'b'.repeat(64),
  origin: 'c'.repeat(64),
  destination: 'd'.repeat(64),
  billing: 'e'.repeat(64),
  packageSet: 'f'.repeat(64),
  input: '1'.repeat(64),
  request: '2'.repeat(64),
  result: '3'.repeat(64),
  offer: '4'.repeat(64),
  package1: '5'.repeat(64),
  package2: '6'.repeat(64),
})
const destination = Object.freeze({
  name: 'Production rerate recipient',
  contactName: 'Production rerate recipient',
  line1: '100 Destination Street',
  city: 'Hartford',
  region: 'CT',
  postalCode: '06103',
  countryCode: 'US',
  residential: true,
})
const registeredOrigin = Object.freeze({
  line1: '7009 S 108th Street',
  city: 'La Vista',
  region: 'NE',
  postalCode: '68128',
  countryCode: 'US',
})
const origin = Object.freeze({
  ...registeredOrigin,
  name: 'AG Alchemy, LLC',
  contactName: 'AG Alchemy Warehouse',
  companyName: 'AG Alchemy, LLC',
  phone: '4025550100',
  residential: false,
})
const billing = Object.freeze({
  relationship: 'sender',
  payerAccountNumberFingerprint: HASH.account,
  payerCountryCode: 'US',
  payerPostalCode: '68128',
})

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}) {
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
  }, { filename: path })
  return module.exports
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

function fingerprint(kind, value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ kind, value })), 'utf8')
    .digest('hex')
}

const productionRerates = loadTypeScriptModule(
  'app_src/lib/operations/productionFulfillmentRerates.ts',
  {
    '@/lib/integrations/carrierWholeShipmentRateFoundation': {
      carrierWholeShipmentRateAddressFingerprints() {
        throw new Error('Unexpected rate-address preparation in finalizer test')
      },
      sealPreparedCarrierWholeShipmentRateRequest() {
        throw new Error('Unexpected rate-request preparation in finalizer test')
      },
    },
    '@/lib/integrations/carrierCredentialCrypto': {
      carrierAccountNumberFingerprint() {
        throw new Error('Unexpected account fingerprinting in finalizer test')
      },
    },
    '@/lib/operations/activeCarrierDispatchSnapshot': {
      createActiveCarrierDispatchRerateBinding() {
        throw new Error('Unexpected dispatch binding in finalizer test')
      },
    },
    '@/lib/persistence/postgres': {
      acquireTransactionAdvisoryLock: (client, key) => client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      ),
      withTransaction() {
        throw new Error('Finalizer acceptance must use the supplied transaction')
      },
    },
  },
)

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
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function expectDatabaseError(client, label, pattern, operation) {
  const savepoint = `rerate_${label.replaceAll(/[^a-z0-9_]/giu, '_')}`
  await client.query(`SAVEPOINT ${savepoint}`)
  let caught = null
  try {
    await operation()
  } catch (error) {
    caught = error
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
  await client.query(`RELEASE SAVEPOINT ${savepoint}`)
  await client.query('SET CONSTRAINTS ALL DEFERRED')
  assert.ok(caught, `${label} unexpectedly succeeded`)
  assert.match(errorMessage(caught), pattern, `${label} rejected incorrectly`)
}

async function seedPrerequisiteLineage(client, ids) {
  await client.query('SET LOCAL session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, reference_code
       ) VALUES
         ($1, 'Production rerate fixture', 'member', 'ga0009001'),
         ($2, 'Foreign rerate fixture', 'member', 'ga0009002')`,
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
         $1, 'gor0009001', $2, $3, $4, $5, 'shopify',
         'rerate-order-1', 'RERATE-1', 'released', 'USD', 2500,
         $6::jsonb, '{}'::jsonb
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
         $1, 'gwh0009001', $2, 'AG-TEST', 'AG test warehouse',
         $3::jsonb, 'active'
       )`,
      [ids.warehouse, ids.organization, JSON.stringify(registeredOrigin)],
    )
    await client.query(
      `INSERT INTO operations_fulfillment_plans (
         id, global_id, organization_id, order_id, warehouse_id,
         status, method, solver_status, estimated_cost_minor,
         promised_delivery_at, explanation
       ) VALUES (
         $1, 'gfp0009001', $2, $3, $4, 'released', 'optimizer',
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
           $1, $2, $3, $4, $5, $6, $7, $8, $9, 'packed'
         )`,
        [
          packageId,
          `gpa000900${index + 1}`,
          ids.organization,
          ids.plan,
          index + 1,
          index === 0 ? 279 : 432,
          229,
          178,
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
         $1, 'gprr0009001', $2, 'rerate-acceptance-group',
         'rerate-acceptance', 'active_commerce_candidate',
         'rerate-acceptance-source', 'shopify', 'live_callback_recorded',
         'fulfillment_execution', 'not_attempted', 'succeeded',
         'rerate-policy-v1', 'rerate-algorithm-v1', $3, $4,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 2, 2, 'USD',
         'ups_rest', '03', 'UPS Ground', 1800, 1800, 0,
         'rerate-source-run-1', 2
       )`,
      [ids.sourceRun, ids.organization, HASH.input, HASH.result],
    )
    await client.query(
      `INSERT INTO operations_fulfillment_executions (
         id, global_id, organization_id, order_id, plan_id,
         checkout_pack_rate_run_id, fulfillment_pack_rate_run_id,
         authority_mode, state, idempotency_key, request_hash,
         completed_at
       ) VALUES (
         $1, 'gofe0009001', $2, $3, $4, $5, $5, 'shadow',
         'shadow_prepared', 'shadow-rerate-execution-1', $6, now()
       )`,
      [
        ids.shadowExecution,
        ids.organization,
        ids.order,
        ids.plan,
        ids.sourceRun,
        HASH.request,
      ],
    )
    await client.query(
      `INSERT INTO operations_shipment_groups (
         id, global_id, organization_id, fulfillment_execution_id,
         order_id, plan_id, warehouse_id, fulfillment_pack_rate_run_id,
         selected_provider, selected_service_code, selected_service_name,
         selected_carrier_cost_minor, currency, state, completed_at
       ) VALUES (
         $1, 'gshg0009001', $2, $3, $4, $5, $6, $7,
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
    await client.query(
      `INSERT INTO operations_active_fulfillment_executions (
         id, global_id, organization_id, shadow_fulfillment_execution_id,
         order_id, plan_id, warehouse_id, authority_mode, state,
         activation_revision, idempotency_key, request_hash
       ) VALUES (
         $1, 'gaex0009001', $2, $3, $4, $5, $6, 'active',
         'prepared', 7, 'active-rerate-execution-1', $7
       )`,
      [
        ids.activeExecution,
        ids.organization,
        ids.shadowExecution,
        ids.order,
        ids.plan,
        ids.warehouse,
        HASH.request,
      ],
    )
    await client.query(
      `INSERT INTO operations_active_shipment_groups (
         id, global_id, organization_id, active_fulfillment_execution_id,
         shadow_shipment_group_id, selected_provider,
         selected_service_code, selected_service_name,
         selected_carrier_cost_minor, currency, package_count, state
       ) VALUES (
         $1, 'gash0009001', $2, $3, $4, 'ups_rest', '03',
         'UPS Ground', 1800, 'USD', 2, 'prepared'
       )`,
      [
        ids.activeGroup,
        ids.organization,
        ids.activeExecution,
        ids.shadowGroup,
      ],
    )
    for (const [index, packageId] of ids.packages.entries()) {
      await client.query(
        `INSERT INTO operations_active_execution_packages (
           organization_id, active_fulfillment_execution_id,
           active_shipment_group_id, shadow_fulfillment_execution_id,
           package_id, package_key, package_number
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ids.organization,
          ids.activeExecution,
          ids.activeGroup,
          ids.shadowExecution,
          packageId,
          `box-${index + 1}`,
          index + 1,
        ],
      )
    }
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration
       ) VALUES (
         $1, 'gia0009001', $2, 'ups_rest', 'carrier', 'production',
         'UPS production fixture', 'active', '{}'::jsonb
       )`,
      [ids.carrierIntegration, ids.organization],
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
         $1, 'gac0009001', $2, $3, 'UPS fixture', 'ciphertext',
         'iv', 'tag', '1234', $4, $5::jsonb, $6,
         'provider_verified', true, true, true, 'active',
         'AG Alchemy, LLC', 1
       )`,
      [
        ids.carrierAccount,
        ids.organization,
        ids.carrierIntegration,
        HASH.account,
        JSON.stringify(registeredOrigin),
        HASH.registeredOrigin,
      ],
    )
    await client.query(
      `INSERT INTO operations_carrier_credentials (
         organization_id, integration_account_id, credential_ciphertext,
         credential_iv, credential_tag, credential_version,
         client_id_last_four, account_number_last_four,
         verification_status, verified_at, credential_fingerprint
       ) VALUES (
         $1, $2, decode('010203', 'hex'), decode('040506', 'hex'),
         decode('070809', 'hex'), 1, 'c123', '1234', 'verified', now(),
         operations_carrier_credential_fingerprint(
           1, decode('010203', 'hex'), decode('040506', 'hex'),
           decode('070809', 'hex')
         )
       )`,
      [ids.organization, ids.carrierIntegration],
    )
  } finally {
    await client.query('SET LOCAL session_replication_role = origin')
  }
}

async function insertRun(client, ids, runId, idempotencyKey) {
  await client.query(
    `INSERT INTO operations_production_fulfillment_rerate_runs (
       id, organization_id, active_fulfillment_execution_id,
       active_shipment_group_id, order_id, plan_id, warehouse_id,
       source_fulfillment_pack_rate_run_id, activation_revision,
       currency, input_hash, destination_snapshot, destination_fingerprint,
       ordered_package_set_fingerprint, package_count, idempotency_key
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 7, 'USD', $9,
       $10::jsonb, $11, $12, 2, $13
     )`,
    [
      runId,
      ids.organization,
      ids.activeExecution,
      ids.activeGroup,
      ids.order,
      ids.plan,
      ids.warehouse,
      ids.sourceRun,
      HASH.input,
      JSON.stringify(destination),
      HASH.destination,
      HASH.packageSet,
      idempotencyKey,
    ],
  )
}

async function insertRunPackages(client, ids, runId, count = 2) {
  for (let index = 0; index < count; index += 1) {
    await client.query(
      `INSERT INTO operations_production_fulfillment_rerate_packages (
         organization_id, rerate_run_id, active_fulfillment_execution_id,
         active_shipment_group_id, package_id, package_global_id,
         package_key, package_number, length_mm, width_mm, height_mm,
         weight_grams, package_hash
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, 229, 178, $10, $11
       )`,
      [
        ids.organization,
        runId,
        ids.activeExecution,
        ids.activeGroup,
        ids.packages[index],
        `gpa000900${index + 1}`,
        `box-${index + 1}`,
        index + 1,
        index === 0 ? 279 : 432,
        index === 0 ? 2500 : 5000,
        index === 0 ? HASH.package1 : HASH.package2,
      ],
    )
  }
}

async function credentialFingerprint(client, ids) {
  const result = await client.query(
    `SELECT credential_fingerprint
     FROM operations_carrier_credentials
     WHERE organization_id = $1 AND integration_account_id = $2`,
    [ids.organization, ids.carrierIntegration],
  )
  return result.rows[0].credential_fingerprint
}

async function insertAttempt(client, ids, options) {
  const credential = await credentialFingerprint(client, ids)
  await client.query(
    `INSERT INTO operations_production_fulfillment_rerate_attempts (
       id, organization_id, rerate_run_id, attempt_number, provider,
       integration_account_id, carrier_account_id,
       carrier_account_configuration_revision, account_number_fingerprint,
       registered_origin_fingerprint, credential_revision,
       credential_fingerprint, sender_name_snapshot, origin_snapshot,
       origin_fingerprint, billing_relationship,
       payer_account_number_fingerprint, payer_country_code,
       payer_postal_code, billing_snapshot, billing_fingerprint,
       adapter_version, idempotency_key, request_hash, redacted_request,
       persisted_at
     ) VALUES (
       $1, $2, $3, $4, 'ups_rest', $5, $6, $7, $8, $9, 1, $10,
       'AG Alchemy, LLC', $11::jsonb, $12, 'sender', $8, 'US',
       '68128', $13::jsonb, $14, 'ups-rest-rerate-v1', $15, $16,
       $17::jsonb, now() - interval '2 seconds'
     )`,
    [
      options.attemptId,
      ids.organization,
      options.runId,
      options.attemptNumber,
      ids.carrierIntegration,
      ids.carrierAccount,
      options.configurationRevision ?? 1,
      HASH.account,
      HASH.registeredOrigin,
      credential,
      JSON.stringify(origin),
      HASH.origin,
      JSON.stringify(billing),
      HASH.billing,
      options.idempotencyKey,
      HASH.request,
      JSON.stringify(options.redactedRequest ?? { packageCount: 2 }),
    ],
  )
}

async function insertSelection(client, ids, options) {
  const credential = await credentialFingerprint(client, ids)
  await client.query(
    `INSERT INTO operations_production_fulfillment_rerate_selections (
       id, organization_id, rerate_run_id,
       active_fulfillment_execution_id, active_shipment_group_id,
       attempt_id, result_id, offer_id, provider, service_code,
       service_name, amount_minor, currency, integration_account_id,
       carrier_account_id, carrier_account_configuration_revision,
       account_number_fingerprint, registered_origin_fingerprint,
       credential_revision, credential_fingerprint, adapter_version,
       provider_reference, input_hash, result_hash, origin_fingerprint,
       destination_fingerprint, billing_fingerprint,
       ordered_package_set_fingerprint, expires_at, selection_reason,
       selected_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 'ups_rest', '02',
       'UPS 2nd Day Air', 4200, 'USD', $9, $10, 1, $11, $12, 1,
       $13, 'ups-rest-rerate-v1', 'UPS-RATE-1', $14, $15, $16,
       $17, $18, $19, $20, 'lowest valid whole-shipment cost',
       COALESCE($21::timestamptz, now())
     )`,
    [
      options.selectionId,
      ids.organization,
      options.runId,
      ids.activeExecution,
      ids.activeGroup,
      options.attemptId,
      options.resultId,
      options.offerId,
      ids.carrierIntegration,
      ids.carrierAccount,
      HASH.account,
      HASH.registeredOrigin,
      credential,
      HASH.input,
      HASH.result,
      HASH.origin,
      HASH.destination,
      HASH.billing,
      HASH.packageSet,
      options.expiresAt,
      options.selectedAt ?? null,
    ],
  )
}

async function verifyAcceptance(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'clawpilot-production-rerate-acceptance',
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
    activeExecution: randomUUID(),
    activeGroup: randomUUID(),
    packages: [randomUUID(), randomUUID()],
    carrierIntegration: randomUUID(),
    carrierAccount: randomUUID(),
  }
  try {
    await client.query('BEGIN')
    await seedPrerequisiteLineage(client, ids)

    await expectDatabaseError(
      client,
      'cross_tenant_run',
      /exact Active execution and shipment group/,
      () => client.query(
        `INSERT INTO operations_production_fulfillment_rerate_runs (
           organization_id, active_fulfillment_execution_id,
           active_shipment_group_id, order_id, plan_id, warehouse_id,
           source_fulfillment_pack_rate_run_id, activation_revision,
           currency, input_hash, destination_snapshot,
           destination_fingerprint, ordered_package_set_fingerprint,
           package_count, idempotency_key
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 7, 'USD', $8, $9::jsonb,
           $10, $11, 2, 'cross-tenant-rerate'
         )`,
        [
          ids.otherOrganization,
          ids.activeExecution,
          ids.activeGroup,
          ids.order,
          ids.plan,
          ids.warehouse,
          ids.sourceRun,
          HASH.input,
          JSON.stringify(destination),
          HASH.destination,
          HASH.packageSet,
        ],
      ),
    )
    await expectDatabaseError(
      client,
      'stale_activation_revision',
      /current Operations Active revision/,
      () => client.query(
        `INSERT INTO operations_production_fulfillment_rerate_runs (
           organization_id, active_fulfillment_execution_id,
           active_shipment_group_id, order_id, plan_id, warehouse_id,
           source_fulfillment_pack_rate_run_id, activation_revision,
           currency, input_hash, destination_snapshot,
           destination_fingerprint, ordered_package_set_fingerprint,
           package_count, idempotency_key
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 6, 'USD', $8, $9::jsonb,
           $10, $11, 2, 'stale-revision-rerate'
         )`,
        [
          ids.organization,
          ids.activeExecution,
          ids.activeGroup,
          ids.order,
          ids.plan,
          ids.warehouse,
          ids.sourceRun,
          HASH.input,
          JSON.stringify(destination),
          HASH.destination,
          HASH.packageSet,
        ],
      ),
    )

    const partialRun = randomUUID()
    await expectDatabaseError(
      client,
      'partial_package_set',
      /complete ordered Active package set/,
      async () => {
        await insertRun(client, ids, partialRun, 'partial-package-rerate')
        await insertRunPackages(client, ids, partialRun, 1)
        await client.query('SET CONSTRAINTS ALL IMMEDIATE')
      },
    )

    const currencyRun = randomUUID()
    await insertRun(client, ids, currencyRun, 'currency-drift-rerate')
    await insertRunPackages(client, ids, currencyRun)
    await expectDatabaseError(
      client,
      'attempt_currency_drift',
      /destination or currency changed after run preparation/,
      async () => {
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `UPDATE operations_orders
           SET currency = 'EUR'
           WHERE organization_id = $1 AND id = $2`,
          [ids.organization, ids.order],
        )
        await client.query('SET LOCAL session_replication_role = origin')
        await insertAttempt(client, ids, {
          runId: currencyRun,
          attemptId: randomUUID(),
          attemptNumber: 1,
          idempotencyKey: 'currency-drift-attempt-1',
        })
      },
    )

    const unknownRun = randomUUID()
    await insertRun(client, ids, unknownRun, 'unknown-outcome-rerate')
    await insertRunPackages(client, ids, unknownRun)
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    await client.query('SET CONSTRAINTS ALL DEFERRED')
    const unknownAttempt = randomUUID()
    await insertAttempt(client, ids, {
      runId: unknownRun,
      attemptId: unknownAttempt,
      attemptNumber: 1,
      idempotencyKey: 'unknown-attempt-1',
    })
    const prepared = await client.query(
      `SELECT state FROM operations_production_fulfillment_rerate_attempts
       WHERE id = $1`,
      [unknownAttempt],
    )
    assert.equal(prepared.rows[0].state, 'prepared')
    await expectDatabaseError(
      client,
      'prepared_retry',
      /Prepared, succeeded, or unknown production rerate attempt cannot be retried/,
      () => insertAttempt(client, ids, {
        runId: unknownRun,
        attemptId: randomUUID(),
        attemptNumber: 2,
        idempotencyKey: 'prepared-attempt-2',
      }),
    )
    const redaction = await client.query(
      `SELECT
         operations_production_rerate_json_is_redacted(
           '{"accessToken":"secret"}'::jsonb
         ) AS token_safe,
         operations_production_rerate_json_is_redacted(
           '{"payerAccountNumber":"1234"}'::jsonb
         ) AS account_safe,
         operations_production_rerate_json_is_redacted(
           '{"credential_ciphertext":"encrypted"}'::jsonb
         ) AS credential_safe`,
    )
    assert.deepEqual(redaction.rows[0], {
      token_safe: false,
      account_safe: false,
      credential_safe: false,
    })
    await client.query(
      `INSERT INTO operations_production_fulfillment_rerate_results (
         organization_id, rerate_run_id, attempt_id, state, error_code,
         result_hash, redacted_response, completed_at
       ) VALUES (
         $1, $2, $3, 'unknown', 'PROVIDER_OUTCOME_UNKNOWN', $4,
         '{"outcome":"unknown"}'::jsonb, now()
       )`,
      [ids.organization, unknownRun, unknownAttempt, HASH.result],
    )
    await expectDatabaseError(
      client,
      'unknown_retry',
      /Prepared, succeeded, or unknown production rerate attempt cannot be retried/,
      () => insertAttempt(client, ids, {
        runId: unknownRun,
        attemptId: randomUUID(),
        attemptNumber: 2,
        idempotencyKey: 'unknown-attempt-2',
      }),
    )

    const skewRun = randomUUID()
    await insertRun(client, ids, skewRun, 'database-clock-skew-rerate')
    await insertRunPackages(client, ids, skewRun)
    const skewAttempt = randomUUID()
    const skewRedactedRequest = { packageCount: 2 }
    await insertAttempt(client, ids, {
      runId: skewRun,
      attemptId: skewAttempt,
      attemptNumber: 1,
      idempotencyKey: 'database-clock-skew-attempt-1',
      redactedRequest: skewRedactedRequest,
    })
    const skewRate = Object.freeze({
      serviceCode: '03',
      serviceName: 'UPS Ground',
      amount: '12.50',
      currency: 'USD',
      rateType: 'negotiated',
      transitDays: 3,
      deliveryDate: null,
    })
    const skewRedactedResponse = Object.freeze({
      adapterVersion: 'carrier-whole-shipment-rate-v1',
      accessMode: 'rate_read_only',
      providerMutationCount: 0,
      provider: 'ups_rest',
      environment: 'production',
      endpoint: 'https://onlinetools.ups.com/api/rating/v2409/Rate',
      endpointVersion: 'v2409',
      purpose: 'fulfillment_execution',
      rateScope: 'multi_package_shipment',
      expectedCurrency: 'USD',
      packageCount: 2,
      rateCount: 1,
      rates: [skewRate],
    })
    const skewedProviderResponse = Object.freeze({
      provider: 'ups_rest',
      environment: 'production',
      purpose: 'fulfillment_execution',
      rateScope: 'multi_package_shipment',
      expectedCurrency: 'USD',
      packageCount: 2,
      rates: [skewRate],
      evidence: {
        requestHash: HASH.request,
        providerPayloadHash: '7'.repeat(64),
        redactedRequest: skewRedactedRequest,
        redactedResponse: skewRedactedResponse,
        providerReference: 'UPS-SKEW-RATE',
        requestedAt: '2099-01-01T00:00:00.000Z',
        completedAt: '2099-01-01T00:00:01.000Z',
      },
    })
    const skewFirstResult = (
      await productionRerates
        .finalizeProductionFulfillmentRerateAttemptInPostgres({
          organizationId: ids.organization,
          attemptGlobalId: (
            await client.query(
              `SELECT global_id
               FROM operations_production_fulfillment_rerate_attempts
               WHERE id = $1`,
              [skewAttempt],
            )
          ).rows[0].global_id,
          outcome: {
            state: 'succeeded',
            parsedResponse: skewedProviderResponse,
          },
        }, client)
    )
    assert.equal(skewFirstResult.state, 'succeeded')
    assert.equal(skewFirstResult.replayed, false)
    assert.equal(skewFirstResult.offers.length, 1)
    assert.ok(
      Date.parse(skewFirstResult.completedAt) < Date.parse('2099-01-01T00:00:00Z'),
      'Provider/app clock skew must not future-date terminal evidence',
    )
    assert.equal(
      Date.parse(skewFirstResult.expiresAt)
        - Date.parse(skewFirstResult.completedAt),
      5 * 60 * 1000,
      'Successful offer lifetime must derive from the database terminal clock',
    )

    const agedCompletedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const agedExpiresAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const normalizedRateEvidence = {
      serviceCode: skewRate.serviceCode,
      serviceName: skewRate.serviceName,
      amountMinor: 1250,
      currency: 'USD',
      rateType: skewRate.rateType,
      transitDays: skewRate.transitDays,
      deliveryAt: null,
    }
    const agedResultHash = fingerprint(
      'production-fulfillment-rerate-result-v1',
      {
        attemptId: skewAttempt,
        requestHash: HASH.request,
        providerPayloadHash: skewedProviderResponse.evidence.providerPayloadHash,
        providerReference: skewedProviderResponse.evidence.providerReference,
        completedAt: agedCompletedAt,
        expiresAt: agedExpiresAt,
        redactedResponse: skewRedactedResponse,
        rates: [normalizedRateEvidence],
      },
    )
    const normalizedOffer = canonicalize({
      ...normalizedRateEvidence,
      provider: 'ups_rest',
    })
    const agedOfferHash = fingerprint(
      'production-fulfillment-rerate-offer-v1',
      { resultHash: agedResultHash, offer: normalizedOffer },
    )
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(
      `UPDATE operations_production_fulfillment_rerate_results
       SET result_hash = $2, completed_at = $3::timestamptz,
           expires_at = $4::timestamptz
       WHERE id = $1::uuid`,
      [
        skewFirstResult.id,
        agedResultHash,
        agedCompletedAt,
        agedExpiresAt,
      ],
    )
    await client.query(
      `UPDATE operations_production_fulfillment_rerate_offers
       SET offer_hash = $2, expires_at = $3::timestamptz
       WHERE result_id = $1::uuid`,
      [skewFirstResult.id, agedOfferHash, agedExpiresAt],
    )
    await client.query('SET LOCAL session_replication_role = origin')

    const delayedReplay = await productionRerates
      .finalizeProductionFulfillmentRerateAttemptInPostgres({
        organizationId: ids.organization,
        attemptGlobalId: skewFirstResult.attemptGlobalId,
        outcome: {
          state: 'succeeded',
          parsedResponse: {
            ...skewedProviderResponse,
            evidence: {
              ...skewedProviderResponse.evidence,
              requestedAt: '2001-01-01T00:00:00.000Z',
              completedAt: '2001-01-01T00:00:01.000Z',
            },
          },
        },
      }, client)
    assert.equal(delayedReplay.replayed, true)
    assert.equal(delayedReplay.resultHash, agedResultHash)
    assert.equal(delayedReplay.completedAt, agedCompletedAt)
    assert.equal(delayedReplay.expiresAt, agedExpiresAt)
    assert.equal(delayedReplay.offers[0].offerHash, agedOfferHash)

    const successRun = randomUUID()
    await insertRun(client, ids, successRun, 'successful-rerate-run')
    await insertRunPackages(client, ids, successRun)
    const failedAttempt = randomUUID()
    await insertAttempt(client, ids, {
      runId: successRun,
      attemptId: failedAttempt,
      attemptNumber: 1,
      idempotencyKey: 'failed-attempt-1',
    })
    await client.query(
      `INSERT INTO operations_production_fulfillment_rerate_results (
         organization_id, rerate_run_id, attempt_id, state, error_code,
         result_hash, redacted_response, completed_at
       ) VALUES (
         $1, $2, $3, 'failed', 'PROVIDER_REJECTED', $4,
         '{"outcome":"failed"}'::jsonb, now()
       )`,
      [ids.organization, successRun, failedAttempt, HASH.result],
    )
    const successAttempt = randomUUID()
    await insertAttempt(client, ids, {
      runId: successRun,
      attemptId: successAttempt,
      attemptNumber: 2,
      idempotencyKey: 'successful-attempt-2',
    })
    await expectDatabaseError(
      client,
      'stale_account_revision',
      /exact current production account and credential revision/,
      () => insertAttempt(client, ids, {
        runId: successRun,
        attemptId: randomUUID(),
        attemptNumber: 3,
        configurationRevision: 2,
        idempotencyKey: 'stale-account-attempt-3',
      }),
    )
    const resultId = randomUUID()
    const offerId = randomUUID()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    await expectDatabaseError(
      client,
      'future_result_completion',
      /cannot be future-dated/,
      () => client.query(
        `INSERT INTO operations_production_fulfillment_rerate_results (
           id, organization_id, rerate_run_id, attempt_id, state,
           provider_reference, result_hash, redacted_response, completed_at,
           expires_at
         ) VALUES (
           $1, $2, $3, $4, 'succeeded', 'UPS-FUTURE-RATE', $5,
           '{"offerCount":1}'::jsonb,
           clock_timestamp() + interval '5 minutes',
           clock_timestamp() + interval '10 minutes'
         )`,
        [
          randomUUID(),
          ids.organization,
          successRun,
          successAttempt,
          HASH.result,
        ],
      ),
    )
    await client.query(
      `INSERT INTO operations_production_fulfillment_rerate_results (
         id, organization_id, rerate_run_id, attempt_id, state,
         provider_reference, result_hash, redacted_response, completed_at,
         expires_at
       ) VALUES (
         $1, $2, $3, $4, 'succeeded', 'UPS-RATE-1', $5,
         '{"offerCount":1}'::jsonb, now(), $6
       )`,
      [
        resultId,
        ids.organization,
        successRun,
        successAttempt,
        HASH.result,
        expiresAt,
      ],
    )
    await client.query(
      `INSERT INTO operations_production_fulfillment_rerate_offers (
         id, organization_id, rerate_run_id, attempt_id, result_id,
         provider, service_code, service_name, amount_minor, currency,
         transit_days, offer_hash, normalized_offer, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'ups_rest', '02', 'UPS 2nd Day Air',
         4200, 'USD', 2, $6, '{"packageCount":2}'::jsonb, $7
       )`,
      [
        offerId,
        ids.organization,
        successRun,
        successAttempt,
        resultId,
        HASH.offer,
        expiresAt,
      ],
    )
    await expectDatabaseError(
      client,
      'future_selection',
      /cannot be future-dated/,
      () => insertSelection(client, ids, {
        selectionId: randomUUID(),
        runId: successRun,
        attemptId: successAttempt,
        resultId,
        offerId,
        expiresAt,
        selectedAt: new Date(Date.now() + 5 * 60 * 1000),
      }),
    )
    await expectDatabaseError(
      client,
      'selection_integration_disabled',
      /integration, account, or credential revision is stale/,
      async () => {
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `UPDATE operations_integration_accounts
           SET status = 'disabled'
           WHERE organization_id = $1 AND id = $2`,
          [ids.organization, ids.carrierIntegration],
        )
        await client.query('SET LOCAL session_replication_role = origin')
        await insertSelection(client, ids, {
          selectionId: randomUUID(),
          runId: successRun,
          attemptId: successAttempt,
          resultId,
          offerId,
          expiresAt,
        })
      },
    )
    const selectionId = randomUUID()
    await insertSelection(client, ids, {
      selectionId,
      runId: successRun,
      attemptId: successAttempt,
      resultId,
      offerId,
      expiresAt,
    })
    await expectDatabaseError(
      client,
      'second_selection',
      /operations_production_rerate_selections_run_unique/,
      () => client.query(
        `INSERT INTO operations_production_fulfillment_rerate_selections
         SELECT gen_random_uuid(), allocate_global_reference('gars'),
                organization_id, rerate_run_id,
                active_fulfillment_execution_id, active_shipment_group_id,
                attempt_id, result_id, offer_id, provider, service_code,
                service_name, amount_minor, currency,
                integration_account_id, carrier_account_id,
                carrier_account_configuration_revision,
                account_number_fingerprint, registered_origin_fingerprint,
                credential_revision, credential_fingerprint, adapter_version,
                provider_reference, input_hash, result_hash,
                origin_fingerprint, destination_fingerprint,
                billing_fingerprint, ordered_package_set_fingerprint,
                expires_at, selection_reason, selected_by, selected_at,
                created_at
         FROM operations_production_fulfillment_rerate_selections
         WHERE id = $1`,
        [selectionId],
      ),
    )
    await expectDatabaseError(
      client,
      'wrong_dispatch_service',
      /exact current unexpired production rerate selection/,
      () => client.query(
        `INSERT INTO operations_active_carrier_group_attempts (
           organization_id, active_fulfillment_execution_id,
           active_shipment_group_id, production_rerate_selection_id,
           attempt_number, state, environment, selected_provider,
           selected_service_code, selected_service_name, package_count,
           adapter_version, idempotency_key, request_hash,
           redacted_request
         ) VALUES (
           $1, $2, $3, $4, 1, 'prepared', 'production', 'ups_rest',
           '03', 'UPS Ground', 2, 'ups-label-v1',
           'wrong-dispatch-service', $5, '{}'::jsonb
         )`,
        [
          ids.organization,
          ids.activeExecution,
          ids.activeGroup,
          selectionId,
          HASH.request,
        ],
      ),
    )
    await client.query(
      `INSERT INTO operations_active_carrier_group_attempts (
         organization_id, active_fulfillment_execution_id,
         active_shipment_group_id, production_rerate_selection_id,
         attempt_number, state, environment, selected_provider,
         selected_service_code, selected_service_name, package_count,
         adapter_version, idempotency_key, request_hash, redacted_request
       ) VALUES (
         $1, $2, $3, $4, 1, 'prepared', 'production', 'ups_rest',
         '02', 'UPS 2nd Day Air', 2, 'ups-label-v1',
         'valid-production-dispatch', $5, '{}'::jsonb
       )`,
      [
        ids.organization,
        ids.activeExecution,
        ids.activeGroup,
        selectionId,
        HASH.request,
      ],
    )
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    await expectDatabaseError(
      client,
      'append_only_selection',
      /append-only/,
      () => client.query(
        `UPDATE operations_production_fulfillment_rerate_selections
         SET selection_reason = 'mutated selection' WHERE id = $1`,
        [selectionId],
      ),
    )
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
    `clawpilot-production-rerate-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_rerate',
      '-e', 'POSTGRES_DB=clawpilot_rerate',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      `postgresql://postgres:clawpilot_rerate@127.0.0.1:${port}`
      + '/clawpilot_rerate'
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
    'Production fulfillment rerate disposable-PostgreSQL acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
