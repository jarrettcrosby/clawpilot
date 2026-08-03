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
const actorEmail = 'production-rerate-operator@example.com'
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

function registeredOriginFingerprintForFixture() {
  return createHash('sha256')
    .update(JSON.stringify({
      line1: origin.line1.toLowerCase(),
      line2: null,
      city: origin.city.toLowerCase(),
      region: origin.region.toLowerCase(),
      postalCode: origin.postalCode.toLowerCase().replace(/[\s-]/gu, ''),
      countryCode: origin.countryCode,
    }), 'utf8')
    .digest('hex')
}

const activeDispatchSnapshot = loadTypeScriptModule(
  'app_src/lib/operations/activeCarrierDispatchSnapshot.ts',
)
const providerBoundaryCallCount = { value: 0 }
let activeDispatchTransactionPool = null

const productionRerates = loadTypeScriptModule(
  'app_src/lib/operations/productionFulfillmentRerates.ts',
  {
    '@/lib/integrations/carrierWholeShipmentRateFoundation': {
      carrierWholeShipmentRateAddressFingerprints() {
        providerBoundaryCallCount.value += 1
        throw new Error('Unexpected rate-address preparation in finalizer test')
      },
      sealPreparedCarrierWholeShipmentRateRequest() {
        providerBoundaryCallCount.value += 1
        throw new Error('Unexpected rate-request preparation in finalizer test')
      },
    },
    '@/lib/integrations/carrierCredentialCrypto': {
      carrierAccountNumberFingerprint() {
        providerBoundaryCallCount.value += 1
        throw new Error('Unexpected account fingerprinting in finalizer test')
      },
    },
    '@/lib/operations/activeCarrierDispatchSnapshot': {
      createActiveCarrierDispatchRerateBinding() {
        providerBoundaryCallCount.value += 1
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

const productionReratesForDispatch = loadTypeScriptModule(
  'app_src/lib/operations/productionFulfillmentRerates.ts',
  {
    '@/lib/integrations/carrierWholeShipmentRateFoundation': {
      carrierWholeShipmentRateAddressFingerprints() {
        providerBoundaryCallCount.value += 1
        throw new Error('Dispatch preparation must not prepare a new rate address')
      },
      sealPreparedCarrierWholeShipmentRateRequest() {
        providerBoundaryCallCount.value += 1
        throw new Error('Dispatch preparation must not prepare a new rate request')
      },
    },
    '@/lib/integrations/carrierCredentialCrypto': {
      carrierAccountNumberFingerprint() {
        providerBoundaryCallCount.value += 1
        throw new Error('Dispatch preparation must not read a raw account number')
      },
    },
    '@/lib/operations/activeCarrierDispatchSnapshot': activeDispatchSnapshot,
    '@/lib/persistence/postgres': {
      acquireTransactionAdvisoryLock: (client, key) => client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      ),
      withTransaction() {
        throw new Error(
          'Dispatch-context acceptance must use the supplied transaction',
        )
      },
    },
  },
)

const activeDispatchPersistence = loadTypeScriptModule(
  'app_src/lib/operations/activeCarrierDispatchPersistence.ts',
  {
    '@/lib/operations/activeCarrierDispatchSnapshot': activeDispatchSnapshot,
    '@/lib/operations/productionFulfillmentRerates': productionReratesForDispatch,
    '@/lib/persistence/postgres': {
      acquireTransactionAdvisoryLock: (client, key) => client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      ),
      async withTransaction(callback) {
        if (!activeDispatchTransactionPool) {
          throw new Error('Active dispatch transaction pool is not configured')
        }
        const client = await activeDispatchTransactionPool.connect()
        try {
          await client.query('BEGIN')
          const result = await callback(client)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw error
        } finally {
          client.release()
        }
      },
    },
  },
)

function dispatchBinding(ids) {
  return activeDispatchSnapshot.createActiveCarrierDispatchRerateBinding({
    organization: { id: ids.organization, globalId: 'ga0009001' },
    order: { id: ids.order, globalId: 'gor0009001' },
    plan: { id: ids.plan, globalId: 'gfp0009001' },
    warehouse: { id: ids.warehouse, globalId: 'gwh0009001' },
    origin: {
      contactName: origin.contactName,
      companyName: origin.companyName,
      phone: origin.phone,
      email: null,
      line1: origin.line1,
      line2: null,
      line3: null,
      city: origin.city,
      region: origin.region,
      postalCode: origin.postalCode,
      countryCode: origin.countryCode,
      residential: origin.residential,
    },
    destination: {
      contactName: destination.contactName,
      companyName: null,
      phone: null,
      email: null,
      line1: destination.line1,
      line2: null,
      line3: null,
      city: destination.city,
      region: destination.region,
      postalCode: destination.postalCode,
      countryCode: destination.countryCode,
      residential: destination.residential,
    },
    billing,
    packages: ids.packages.map((packageId, index) => ({
      packageId,
      packageGlobalId: `gpa000900${index + 1}`,
      packageNumber: index + 1,
      dimensionsMm: {
        length: index === 0 ? 279 : 432,
        width: 229,
        height: 178,
      },
      weightGrams: index === 0 ? 2500 : 5000,
    })),
  })
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
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function createDisposablePostgresDatabase(databaseUrl, databaseName) {
  assert.match(databaseName, /^[a-z0-9_]+$/u)
  const adminUrl = new URL(databaseUrl)
  adminUrl.pathname = '/postgres'
  const pool = new Pool({
    connectionString: adminUrl.toString(),
    application_name: 'clawpilot-production-rerate-db-create',
    max: 1,
  })
  try {
    await pool.query(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await pool.end()
  }
  const createdUrl = new URL(databaseUrl)
  createdUrl.pathname = `/${databaseName}`
  return createdUrl.toString()
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

async function expectServiceError(
  client,
  label,
  expectedCode,
  expectedStatus,
  operation,
) {
  const savepoint = `rerate_service_${label.replaceAll(/[^a-z0-9_]/giu, '_')}`
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
  assert.equal(caught.code, expectedCode, `${label} returned an unstable code`)
  assert.equal(caught.status, expectedStatus, `${label} returned an unstable status`)
}

async function expectIndependentServiceError(
  label,
  expectedCode,
  expectedStatus,
  operation,
) {
  let caught = null
  try {
    await operation()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `${label} unexpectedly succeeded`)
  assert.equal(caught.code, expectedCode, `${label} returned an unstable code`)
  assert.equal(caught.status, expectedStatus, `${label} returned an unstable status`)
}

async function expectRowLockTimeout(client, label, sql, parameters) {
  await client.query('BEGIN')
  await client.query("SET LOCAL lock_timeout = '250ms'")
  let caught = null
  try {
    await client.query(sql, parameters)
  } catch (error) {
    caught = error
  }
  await client.query('ROLLBACK')
  assert.ok(caught, `${label} was not protected by the selection transaction`)
  assert.equal(caught.code, '55P03', `${label} did not fail on a row-lock timeout`)
}

async function seedPrerequisiteLineage(client, ids) {
  await client.query('SET LOCAL session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')
       ON CONFLICT (email) DO NOTHING`,
      [actorEmail],
    )
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
         activation_revision, expected_order_row_version, reason,
         idempotency_key, request_hash
       ) VALUES (
         $1, 'gaex0009001', $2, $3, $4, $5, $6, 'active',
         'prepared', 7, 0, 'Production rerate test fixture',
         'active-rerate-execution-1', $7
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
        registeredOriginFingerprintForFixture(),
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
    await client.query('SET LOCAL session_replication_role = origin').catch(() => {})
  }
}

async function insertRun(client, ids, runId, idempotencyKey) {
  const binding = dispatchBinding(ids)
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
      binding.destinationFingerprint,
      binding.orderedPackageSetFingerprint,
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
  const binding = dispatchBinding(ids)
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
      registeredOriginFingerprintForFixture(),
      credential,
      JSON.stringify(origin),
      binding.originFingerprint,
      JSON.stringify(billing),
      binding.billingFingerprint,
      options.idempotencyKey,
      HASH.request,
      JSON.stringify(options.redactedRequest ?? { packageCount: 2 }),
    ],
  )
}

async function insertSelection(client, ids, options) {
  const credential = await credentialFingerprint(client, ids)
  const binding = dispatchBinding(ids)
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
      registeredOriginFingerprintForFixture(),
      credential,
      HASH.input,
      HASH.result,
      binding.originFingerprint,
      binding.destinationFingerprint,
      binding.billingFingerprint,
      binding.orderedPackageSetFingerprint,
      options.expiresAt,
      options.selectedAt ?? null,
    ],
  )
}

async function verifyAcceptance(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'clawpilot-production-rerate-acceptance',
    max: 2,
  })
  activeDispatchTransactionPool = pool
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

    const activeDispatchSafetyConstraintNames = [
      'operations_active_carrier_attempt_safety_valid',
      'operations_active_carrier_package_evidence_redacted',
      'operations_active_label_attempt_evidence_redacted',
      'operations_active_label_evidence_redacted',
    ]
    const validatedActiveDispatchSafetyConstraints = await client.query(
      `SELECT conname, convalidated
       FROM pg_constraint
       WHERE conname = ANY($1::text[])
       ORDER BY conname`,
      [activeDispatchSafetyConstraintNames],
    )
    assert.deepEqual(
      validatedActiveDispatchSafetyConstraints.rows,
      [...activeDispatchSafetyConstraintNames]
        .sort()
        .map((conname) => ({ conname, convalidated: true })),
    )

    const directTerminalAttempts = [
      {
        state: 'failed',
        providerReference: null,
        errorCode: 'PROVIDER_REJECTED',
        diagnostic: {
          diagnosticVersion: 1,
          providerStatus: 'provider_rejected',
          shipmentOutcome: 'not_created',
          retryable: true,
          requestMayHaveReachedProvider: true,
          responseReceived: true,
        },
      },
      {
        state: 'unknown',
        providerReference: null,
        errorCode: 'AMBIGUOUS_OUTCOME',
        diagnostic: {
          diagnosticVersion: 1,
          providerStatus: 'timeout',
          shipmentOutcome: 'unknown',
          retryable: false,
          requestMayHaveReachedProvider: true,
          responseReceived: false,
        },
      },
      {
        state: 'succeeded',
        providerReference: 'provider-shipment-direct-terminal',
        errorCode: null,
        diagnostic: {
          diagnosticVersion: 1,
          providerStatus: 'succeeded',
          shipmentOutcome: 'created',
          retryable: false,
          requestMayHaveReachedProvider: true,
          responseReceived: true,
        },
      },
    ]

    for (const terminalAttempt of directTerminalAttempts) {
      await expectDatabaseError(
        client,
        `direct_${terminalAttempt.state}_attempt_without_prepare`,
        /insert requires prepared state/,
        () => client.query(
          `INSERT INTO operations_active_carrier_group_attempts (
             organization_id, active_fulfillment_execution_id,
             active_shipment_group_id, production_rerate_selection_id,
             attempt_number, state, environment, selected_provider,
             selected_service_code, selected_service_name, package_count,
             adapter_version, idempotency_key, request_hash, redacted_request,
             redacted_response, provider_reference, error_code,
             dispatched_at, completed_at
           ) VALUES (
             $1, $2, $3, gen_random_uuid(), 1, $5, 'production',
             'ups_rest', '02', 'UPS 2nd Day Air', 2,
             'direct-terminal-test-v1', $6,
             $4, '{}'::jsonb, $7::jsonb, $8, $9,
             clock_timestamp(), clock_timestamp()
           )`,
          [
            ids.organization,
            ids.activeExecution,
            ids.activeGroup,
            HASH.request,
            terminalAttempt.state,
            `direct-${terminalAttempt.state}-without-prepare`,
            JSON.stringify(terminalAttempt.diagnostic),
            terminalAttempt.providerReference,
            terminalAttempt.errorCode,
          ],
        ),
      )
    }

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
    const selectableReferences = await client.query(
      `SELECT run.global_id AS run_global_id,
              offer.global_id AS offer_global_id
       FROM operations_production_fulfillment_rerate_runs run
       JOIN operations_production_fulfillment_rerate_offers offer
         ON offer.organization_id = run.organization_id
        AND offer.rerate_run_id = run.id
       WHERE run.organization_id = $1::uuid
         AND run.id = $2::uuid
         AND offer.id = $3::uuid`,
      [ids.organization, successRun, offerId],
    )
    const rerateRunGlobalId = selectableReferences.rows[0].run_global_id
    const offerGlobalId = selectableReferences.rows[0].offer_global_id
    await expectServiceError(
      client,
      'cross_tenant_offer_selection',
      'OPERATIONS_PRODUCTION_RERATE_OFFER_NOT_FOUND',
      404,
      () => productionRerates.selectProductionFulfillmentRerateOfferInPostgres({
        organizationId: ids.otherOrganization,
        rerateRunGlobalId,
        offerGlobalId,
        selectionReason: 'Cross-tenant offer must remain inaccessible',
        idempotencyKey: 'cross-tenant-selection-command-1',
        selectedBy: actorEmail,
      }, client),
    )
    await expectServiceError(
      client,
      'missing_offer_selection',
      'OPERATIONS_PRODUCTION_RERATE_OFFER_NOT_FOUND',
      404,
      () => productionRerates.selectProductionFulfillmentRerateOfferInPostgres({
        organizationId: ids.organization,
        rerateRunGlobalId,
        offerGlobalId: 'garo9999999',
        selectionReason: 'Missing offer must remain inaccessible',
        idempotencyKey: 'missing-offer-selection-command-1',
        selectedBy: actorEmail,
      }, client),
    )
    await expectServiceError(
      client,
      'expired_offer_selection',
      'OPERATIONS_PRODUCTION_RERATE_OFFER_INELIGIBLE',
      409,
      () => productionRerates.selectProductionFulfillmentRerateOfferInPostgres({
        organizationId: ids.organization,
        rerateRunGlobalId: delayedReplay.rerateRunGlobalId,
        offerGlobalId: delayedReplay.offers[0].globalId,
        selectionReason: 'Expired offer must not become dispatch authority',
        idempotencyKey: 'expired-offer-selection-command-1',
        selectedBy: actorEmail,
      }, client),
    )
    const expiredSelectionLineage = await client.query(
      `SELECT run.id::text AS run_id,
              attempt.id::text AS attempt_id,
              result.id::text AS result_id,
              offer.id::text AS offer_id
       FROM operations_production_fulfillment_rerate_runs run
       JOIN operations_production_fulfillment_rerate_attempts attempt
         ON attempt.organization_id = run.organization_id
        AND attempt.rerate_run_id = run.id
       JOIN operations_production_fulfillment_rerate_results result
         ON result.organization_id = run.organization_id
        AND result.rerate_run_id = run.id
        AND result.attempt_id = attempt.id
       JOIN operations_production_fulfillment_rerate_offers offer
         ON offer.organization_id = run.organization_id
        AND offer.rerate_run_id = run.id
        AND offer.attempt_id = attempt.id
        AND offer.result_id = result.id
       WHERE run.organization_id = $1::uuid
         AND run.global_id = $2
         AND offer.global_id = $3`,
      [
        ids.organization,
        delayedReplay.rerateRunGlobalId,
        delayedReplay.offers[0].globalId,
      ],
    )
    const historicalSelectionId = randomUUID()
    await client.query('SET LOCAL session_replication_role = replica')
    await insertSelection(client, ids, {
      selectionId: historicalSelectionId,
      runId: expiredSelectionLineage.rows[0].run_id,
      attemptId: expiredSelectionLineage.rows[0].attempt_id,
      resultId: expiredSelectionLineage.rows[0].result_id,
      offerId: expiredSelectionLineage.rows[0].offer_id,
      expiresAt: agedExpiresAt,
      selectedAt: agedCompletedAt,
    })
    await client.query('SET LOCAL session_replication_role = origin')
    await client.query('SAVEPOINT historical_selection_replay')
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(
      `UPDATE operations_orders
       SET currency = 'EUR'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, ids.order],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'disabled'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, ids.carrierIntegration],
    )
    await client.query('SET LOCAL session_replication_role = origin')
    const historicalReplay = await productionRerates
      .selectProductionFulfillmentRerateOfferInPostgres({
        organizationId: ids.organization,
        rerateRunGlobalId: delayedReplay.rerateRunGlobalId,
        offerGlobalId: delayedReplay.offers[0].globalId,
        selectionReason: 'A new command replays the prior immutable choice',
        idempotencyKey: 'historical-selection-command-replay-1',
        selectedBy: actorEmail,
      }, client)
    assert.equal(historicalReplay.id, historicalSelectionId)
    assert.equal(historicalReplay.replayed, true)
    assert.ok(
      Date.parse(historicalReplay.expiresAt) < Date.now(),
      'Historical replay must not be presented as fresh dispatch authority',
    )
    assert.equal(
      historicalReplay.selectionReason,
      'lowest valid whole-shipment cost',
      'Historical replay must preserve the original immutable reason',
    )
    const historicalReceipt = await client.query(
      `SELECT status, result_global_id
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = 'select-production-rerate-offer'
         AND idempotency_key = 'historical-selection-command-replay-1'`,
      [ids.organization],
    )
    assert.deepEqual(historicalReceipt.rows[0], {
      status: 'succeeded',
      result_global_id: historicalReplay.globalId,
    })
    await client.query('ROLLBACK TO SAVEPOINT historical_selection_replay')
    await client.query('RELEASE SAVEPOINT historical_selection_replay')
    await client.query('SET CONSTRAINTS ALL DEFERRED')
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
    await expectServiceError(
      client,
      'selection_currency_stale',
      'OPERATIONS_PRODUCTION_RERATE_SELECTION_DESTINATION_OR_CURRENCY_STALE',
      409,
      async () => {
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `UPDATE operations_orders
           SET currency = 'EUR'
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [ids.organization, ids.order],
        )
        await client.query('SET LOCAL session_replication_role = origin')
        return productionRerates.selectProductionFulfillmentRerateOfferInPostgres({
          organizationId: ids.organization,
          rerateRunGlobalId,
          offerGlobalId,
          selectionReason: 'Reject a stale order currency binding',
          idempotencyKey: 'stale-currency-selection-command-1',
          selectedBy: actorEmail,
        }, client)
      },
    )
    await expectServiceError(
      client,
      'selection_authority_stale',
      'OPERATIONS_PRODUCTION_RERATE_SELECTION_AUTHORITY_STALE',
      409,
      async () => {
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `UPDATE operations_integration_accounts
           SET status = 'disabled'
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [ids.organization, ids.carrierIntegration],
        )
        await client.query('SET LOCAL session_replication_role = origin')
        return productionRerates.selectProductionFulfillmentRerateOfferInPostgres({
          organizationId: ids.organization,
          rerateRunGlobalId,
          offerGlobalId,
          selectionReason: 'Reject stale production carrier authority',
          idempotencyKey: 'stale-authority-selection-command-1',
          selectedBy: actorEmail,
        }, client)
      },
    )

    const selectionInput = Object.freeze({
      organizationId: ids.organization,
      rerateRunGlobalId,
      offerGlobalId,
      selectionReason: 'Lowest valid whole-shipment cost',
      idempotencyKey: 'successful-selection-command-1',
      selectedBy: actorEmail,
    })
    const firstSelection = await productionRerates
      .selectProductionFulfillmentRerateOfferInPostgres(selectionInput, client)
    assert.equal(firstSelection.replayed, false)
    assert.equal(firstSelection.rerateRunGlobalId, rerateRunGlobalId)
    assert.equal(firstSelection.offerGlobalId, offerGlobalId)
    assert.equal(firstSelection.selectionReason, selectionInput.selectionReason)
    const selectionId = firstSelection.id

    const selectionReceipt = await client.query(
      `SELECT request_hash, status, result_global_id,
              result_payload->>'globalId' AS payload_global_id
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = 'select-production-rerate-offer'
         AND idempotency_key = $2`,
      [ids.organization, selectionInput.idempotencyKey],
    )
    assert.deepEqual(selectionReceipt.rows[0], {
      request_hash: fingerprint(
        'production-fulfillment-rerate-selection-command-v1',
        {
          rerateRunGlobalId,
          offerGlobalId,
          selectionReason: selectionInput.selectionReason,
        },
      ),
      status: 'succeeded',
      result_global_id: firstSelection.globalId,
      payload_global_id: firstSelection.globalId,
    })

    const replayedSelection = await productionRerates
      .selectProductionFulfillmentRerateOfferInPostgres(selectionInput, client)
    assert.equal(replayedSelection.replayed, true)
    assert.equal(replayedSelection.globalId, firstSelection.globalId)
    assert.equal(replayedSelection.id, firstSelection.id)
    await expectServiceError(
      client,
      'changed_selection_payload_same_key',
      'OPERATIONS_PRODUCTION_RERATE_SELECTION_IDEMPOTENCY_CONFLICT',
      409,
      () => productionRerates.selectProductionFulfillmentRerateOfferInPostgres({
        ...selectionInput,
        selectionReason: 'Changed reason must conflict with the original receipt',
      }, client),
    )
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
    await client.query('COMMIT')
    const preparedDispatch = await activeDispatchPersistence
      .prepareActiveCarrierDispatchAttemptInPostgres({
        organizationId: ids.organization,
        productionRerateSelectionGlobalId: firstSelection.globalId,
        actorEmail,
      })
    assert.equal(preparedDispatch.dispatchOwner, true)
    assert.equal(preparedDispatch.replayed, false)
    assert.equal(preparedDispatch.state, 'prepared')
    assert.equal(preparedDispatch.attemptNumber, 1)
    assert.equal(preparedDispatch.provider, 'ups_rest')
    assert.equal(preparedDispatch.serviceCode, '02')
    assert.equal(preparedDispatch.serviceName, 'UPS 2nd Day Air')
    assert.equal(preparedDispatch.packageCount, 2)
    assert.equal(
      preparedDispatch.requestHash,
      preparedDispatch.requestSnapshot.snapshotHash,
    )
    assert.equal(
      preparedDispatch.providerIdempotencyIdentity,
      preparedDispatch.requestSnapshot.providerIdempotencyIdentity,
    )
    const preparedRequestRedaction = await client.query(
      `SELECT operations_active_provider_evidence_is_redacted($1::jsonb)
                AS request_is_redacted`,
      [JSON.stringify(preparedDispatch.requestSnapshot)],
    )
    assert.equal(preparedRequestRedaction.rows[0].request_is_redacted, true)

    await client.query('BEGIN')
    const unsafeActiveProviderEvidence = {
      headers: [['Authorization', 'Bearer must-not-persist']],
    }
    await expectDatabaseError(
      client,
      'unsafe_active_package_result_evidence',
      /operations_active_carrier_package_evidence_redacted/,
      async () => {
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `INSERT INTO operations_active_carrier_package_results (
             organization_id, carrier_group_attempt_id,
             active_fulfillment_execution_id, active_shipment_group_id,
             package_id, package_number, state,
             redacted_provider_evidence
           ) VALUES (
             $1, $2, $3, $4, $5, 1, 'unknown', $6::jsonb
           )`,
          [
            ids.organization,
            preparedDispatch.id,
            ids.activeExecution,
            ids.activeGroup,
            ids.packages[0],
            JSON.stringify(unsafeActiveProviderEvidence),
          ],
        )
      },
    )
    await expectDatabaseError(
      client,
      'unsafe_active_label_attempt_evidence',
      /operations_active_label_attempt_evidence_redacted/,
      async () => {
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `INSERT INTO operations_label_attempts (
             organization_id, order_id, package_id, carrier_rate_id,
             integration_account_id, carrier_account_id, action, state,
             environment, provider, adapter_version, idempotency_key,
             request_hash, redacted_request, redacted_response,
             active_fulfillment_execution_id, active_shipment_group_id,
             active_carrier_group_attempt_id
           ) VALUES (
             $1, $2, $3, gen_random_uuid(), $4, $5, 'create', 'prepared',
             'production', 'ups_rest', 'ups-label-v1',
             'unsafe-active-label-attempt', $6, $7::jsonb, '{}'::jsonb,
             $8, $9, $10
           )`,
          [
            ids.organization,
            ids.order,
            ids.packages[0],
            ids.carrierIntegration,
            ids.carrierAccount,
            HASH.request,
            JSON.stringify(unsafeActiveProviderEvidence),
            ids.activeExecution,
            ids.activeGroup,
            preparedDispatch.id,
          ],
        )
      },
    )
    await expectDatabaseError(
      client,
      'unsafe_active_label_evidence',
      /operations_active_label_evidence_redacted/,
      async () => {
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `INSERT INTO operations_labels (
             organization_id, package_id, carrier_rate_id, carrier,
             service_code, tracking_number, format, label_payload,
             provider_label_id, idempotency_key, status, environment,
             redacted_provider_evidence, active_fulfillment_execution_id,
             active_shipment_group_id, active_carrier_group_attempt_id
           ) VALUES (
             $1, $2, gen_random_uuid(), 'UPS', '02',
             'UNSAFE-ACTIVE-TRACKING', 'ZPL', '^XA^XZ',
             'unsafe-active-provider-label', 'unsafe-active-label',
             'created', 'production', $3::jsonb, $4, $5, $6
           )`,
          [
            ids.organization,
            ids.packages[0],
            JSON.stringify(unsafeActiveProviderEvidence),
            ids.activeExecution,
            ids.activeGroup,
            preparedDispatch.id,
          ],
        )
      },
    )
    await client.query('COMMIT')

    const replayedPreparedDispatch = await activeDispatchPersistence
      .prepareActiveCarrierDispatchAttemptInPostgres({
        organizationId: ids.organization,
        productionRerateSelectionGlobalId: firstSelection.globalId,
        actorEmail,
      })
    assert.equal(replayedPreparedDispatch.globalId, preparedDispatch.globalId)
    assert.equal(replayedPreparedDispatch.dispatchOwner, false)
    assert.equal(replayedPreparedDispatch.replayed, true)

    const noEffectsBeforeDispatch = await client.query(
      `SELECT
         (SELECT count(*)::int FROM operations_label_attempts
          WHERE organization_id = $1) AS label_attempts,
         (SELECT count(*)::int FROM operations_labels
          WHERE organization_id = $1) AS labels,
         (SELECT count(*)::int FROM operations_shipments
          WHERE organization_id = $1) AS shipments,
         (SELECT count(*)::int FROM operations_inventory_ledger
          WHERE organization_id = $1) AS inventory_ledger,
         (SELECT count(*)::int FROM operations_print_artifacts
          WHERE organization_id = $1
            AND document_type = 'packing_slip') AS packing_slips,
         (SELECT count(*)::int FROM operations_print_jobs
          WHERE organization_id = $1) AS print_jobs,
         (SELECT count(*)::int FROM operations_active_carrier_package_results
          WHERE organization_id = $1) AS active_package_results,
         (SELECT count(*)::int FROM operations_commerce_fulfillment_exports
          WHERE organization_id = $1) AS fulfillment_exports`,
      [ids.organization],
    )
    assert.deepEqual(noEffectsBeforeDispatch.rows[0], {
      label_attempts: 0,
      labels: 0,
      shipments: 0,
      inventory_ledger: 0,
      packing_slips: 0,
      print_jobs: 0,
      active_package_results: 0,
      fulfillment_exports: 0,
    })

    for (const unsafeDiagnostics of [
      { token: 'must-not-persist' },
      { bearerToken: 'must-not-persist' },
      { oauthToken: 'must-not-persist' },
      { body: '<AccessToken>must-not-persist</AccessToken>' },
      { headers: [['Authorization', 'Bearer must-not-persist']] },
    ]) {
      assert.throws(
        () => activeDispatchPersistence
          .createActiveCarrierDispatchTerminalDiagnostics(unsafeDiagnostics),
        (error) => error?.code
          === 'OPERATIONS_ACTIVE_DISPATCH_TERMINAL_DIAGNOSTICS_INVALID',
      )
      const databaseRedaction = await client.query(
        `SELECT
           operations_active_provider_evidence_is_redacted($1::jsonb)
             AS generic_safe,
           operations_active_dispatch_terminal_diagnostic_is_safe($1::jsonb)
             AS terminal_safe`,
        [JSON.stringify(unsafeDiagnostics)],
      )
      assert.equal(databaseRedaction.rows[0].generic_safe, false)
      assert.equal(databaseRedaction.rows[0].terminal_safe, false)
    }

    const dispatchedAt = new Date(
      Math.max(Date.now(), Date.parse(preparedDispatch.persistedAt)),
    ).toISOString()
    const completedAt = dispatchedAt
    const failureDiagnostics = {
      diagnosticVersion: 1,
      providerStatus: 'timeout',
      shipmentOutcome: 'not_created',
      retryable: true,
      requestMayHaveReachedProvider: false,
      responseReceived: false,
      providerCode: 'ETIMEDOUT',
    }
    await expectIndependentServiceError(
      'unsupported_dispatch_success',
      'OPERATIONS_ACTIVE_DISPATCH_SUCCESS_MATERIALIZATION_NOT_IMPLEMENTED',
      501,
      () => activeDispatchPersistence
        .finalizeActiveCarrierDispatchAttemptInPostgres({
          organizationId: ids.organization,
          attemptGlobalId: preparedDispatch.globalId,
          outcome: {
            state: 'succeeded',
            dispatchedAt,
            completedAt,
            redactedResponse: {},
          },
        }),
    )
    await expectIndependentServiceError(
      'dispatch_before_durable_prepare',
      'OPERATIONS_ACTIVE_DISPATCH_TIMESTAMP_INVALID',
      409,
      () => activeDispatchPersistence
        .finalizeActiveCarrierDispatchFailureInPostgres({
          organizationId: ids.organization,
          attemptGlobalId: preparedDispatch.globalId,
          outcome: {
            dispatchedAt: new Date(
              Date.parse(preparedDispatch.persistedAt) - 1,
            ).toISOString(),
            completedAt,
            errorCode: 'CARRIER_TIMEOUT',
            redactedResponse: failureDiagnostics,
          },
        }),
    )
    await expectIndependentServiceError(
      'future_dated_dispatch_terminal_evidence',
      'OPERATIONS_ACTIVE_DISPATCH_TIMESTAMP_INVALID',
      409,
      () => activeDispatchPersistence
        .finalizeActiveCarrierDispatchFailureInPostgres({
          organizationId: ids.organization,
          attemptGlobalId: preparedDispatch.globalId,
          outcome: {
            dispatchedAt: new Date(Date.now() + 60_000).toISOString(),
            completedAt: new Date(Date.now() + 60_000).toISOString(),
            errorCode: 'CARRIER_TIMEOUT',
            redactedResponse: failureDiagnostics,
          },
        }),
    )
    const concurrentFailures = await Promise.all([
      activeDispatchPersistence.finalizeActiveCarrierDispatchFailureInPostgres({
        organizationId: ids.organization,
        attemptGlobalId: preparedDispatch.globalId,
        outcome: {
          dispatchedAt,
          completedAt,
          errorCode: 'CARRIER_TIMEOUT',
          redactedResponse: failureDiagnostics,
        },
      }),
      activeDispatchPersistence.finalizeActiveCarrierDispatchFailureInPostgres({
        organizationId: ids.organization,
        attemptGlobalId: preparedDispatch.globalId,
        outcome: {
          dispatchedAt,
          completedAt,
          errorCode: 'CARRIER_TIMEOUT',
          redactedResponse: failureDiagnostics,
        },
      }),
    ])
    const failedDispatch = concurrentFailures.find((attempt) => !attempt.replayed)
    const concurrentFailureReplay = concurrentFailures.find(
      (attempt) => attempt.replayed,
    )
    assert.ok(failedDispatch, 'Concurrent finalization did not assign one writer')
    assert.ok(
      concurrentFailureReplay,
      'Concurrent finalization did not return one exact replay',
    )
    assert.equal(failedDispatch.state, 'failed')
    assert.equal(failedDispatch.replayed, false)
    assert.equal(concurrentFailureReplay.globalId, failedDispatch.globalId)

    const replayedFailure = await activeDispatchPersistence
      .finalizeActiveCarrierDispatchFailureInPostgres({
        organizationId: ids.organization,
        attemptGlobalId: preparedDispatch.globalId,
        outcome: {
          dispatchedAt,
          completedAt,
          errorCode: 'CARRIER_TIMEOUT',
          redactedResponse: failureDiagnostics,
        },
      })
    assert.equal(replayedFailure.replayed, true)
    await expectIndependentServiceError(
      'changed_terminal_dispatch_evidence',
      'OPERATIONS_ACTIVE_DISPATCH_FINALIZATION_CONFLICT',
      409,
      () => activeDispatchPersistence
        .finalizeActiveCarrierDispatchFailureInPostgres({
          organizationId: ids.organization,
          attemptGlobalId: preparedDispatch.globalId,
          outcome: {
            dispatchedAt,
            completedAt,
            errorCode: 'CHANGED_FAILURE',
            redactedResponse: failureDiagnostics,
          },
        }),
    )

    await client.query('BEGIN')
    await expectDatabaseError(
      client,
      'changed_direct_retry_lineage',
      /must retain its exact provider, service, and package count/,
      async () => {
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `UPDATE operations_active_carrier_group_attempts
           SET selected_service_code = '03',
               selected_service_name = 'UPS Ground'
           WHERE organization_id = $1 AND id = $2`,
          [ids.organization, preparedDispatch.id],
        )
        await client.query('SET LOCAL session_replication_role = origin')
        await client.query(
          `INSERT INTO operations_active_carrier_group_attempts (
             organization_id, active_fulfillment_execution_id,
             active_shipment_group_id, production_rerate_selection_id,
             attempt_number, state, environment, selected_provider,
             selected_service_code, selected_service_name, package_count,
             adapter_version, idempotency_key, request_hash,
             redacted_request, actor_email, persisted_at
           )
           SELECT organization_id, active_fulfillment_execution_id,
                  active_shipment_group_id, production_rerate_selection_id,
                  2, 'prepared', environment, selected_provider,
                  '02', 'UPS 2nd Day Air', package_count, adapter_version,
                  'changed-direct-retry-lineage', request_hash,
                  redacted_request, actor_email, clock_timestamp()
           FROM operations_active_carrier_group_attempts
           WHERE organization_id = $1 AND id = $2`,
          [ids.organization, preparedDispatch.id],
        )
      },
    )
    await client.query('COMMIT')

    const retryDispatch = await activeDispatchPersistence
      .prepareActiveCarrierDispatchAttemptInPostgres({
        organizationId: ids.organization,
        productionRerateSelectionGlobalId: firstSelection.globalId,
        actorEmail,
      })
    assert.equal(retryDispatch.dispatchOwner, true)
    assert.equal(retryDispatch.attemptNumber, 2)
    assert.notEqual(retryDispatch.globalId, preparedDispatch.globalId)
    assert.notEqual(
      retryDispatch.providerIdempotencyIdentity,
      preparedDispatch.providerIdempotencyIdentity,
    )

    const unknownDispatchedAt = new Date(
      Math.max(Date.now(), Date.parse(retryDispatch.persistedAt)),
    ).toISOString()
    const unknownCompletedAt = unknownDispatchedAt
    const unknownDispatch = await activeDispatchPersistence
      .finalizeActiveCarrierDispatchFailureInPostgres({
        organizationId: ids.organization,
        attemptGlobalId: retryDispatch.globalId,
        outcome: {
          dispatchedAt: unknownDispatchedAt,
          completedAt: unknownCompletedAt,
          errorCode: 'CARRIER_TIMEOUT',
          redactedResponse: {
            diagnosticVersion: 1,
            providerStatus: 'timeout',
            shipmentOutcome: 'unknown',
            retryable: false,
            requestMayHaveReachedProvider: true,
            responseReceived: false,
          },
        },
      })
    assert.equal(unknownDispatch.state, 'unknown')
    assert.equal(
      unknownDispatch.errorCode,
      'UNSAFE_PROVIDER_EVIDENCE_REJECTED',
    )
    assert.deepEqual(unknownDispatch.redactedResponse, {
      diagnosticVersion: 1,
      providerStatus: 'safety_evidence_rejected',
      shipmentOutcome: 'unknown',
      retryable: false,
      requestMayHaveReachedProvider: true,
      responseReceived: false,
    })
    const blockedUnknownReplay = await activeDispatchPersistence
      .prepareActiveCarrierDispatchAttemptInPostgres({
        organizationId: ids.organization,
        productionRerateSelectionGlobalId: firstSelection.globalId,
        actorEmail,
      })
    assert.equal(blockedUnknownReplay.globalId, retryDispatch.globalId)
    assert.equal(blockedUnknownReplay.dispatchOwner, false)
    assert.equal(blockedUnknownReplay.replayed, true)
    assert.equal(blockedUnknownReplay.state, 'unknown')

    const noEffectsAfterTerminalEvidence = await client.query(
      `SELECT
         (SELECT count(*)::int FROM operations_label_attempts
          WHERE organization_id = $1) AS label_attempts,
         (SELECT count(*)::int FROM operations_labels
          WHERE organization_id = $1) AS labels,
         (SELECT count(*)::int FROM operations_shipments
          WHERE organization_id = $1) AS shipments,
         (SELECT count(*)::int FROM operations_inventory_ledger
          WHERE organization_id = $1) AS inventory_ledger,
         (SELECT count(*)::int FROM operations_print_artifacts
          WHERE organization_id = $1
            AND document_type = 'packing_slip') AS packing_slips,
         (SELECT count(*)::int FROM operations_print_jobs
          WHERE organization_id = $1) AS print_jobs,
         (SELECT count(*)::int FROM operations_active_carrier_package_results
          WHERE organization_id = $1) AS active_package_results,
         (SELECT count(*)::int FROM operations_commerce_fulfillment_exports
          WHERE organization_id = $1) AS fulfillment_exports`,
      [ids.organization],
    )
    assert.deepEqual(
      noEffectsAfterTerminalEvidence.rows[0],
      noEffectsBeforeDispatch.rows[0],
    )
    assert.equal(providerBoundaryCallCount.value, 0)
    await client.query('BEGIN')
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
    activeDispatchTransactionPool = null
    client.release()
    await pool.end()
  }
}

async function verifySelectionAuthorityLocks(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'clawpilot-production-rerate-selection-locks',
    max: 5,
  })
  activeDispatchTransactionPool = pool
  const setup = await pool.connect()
  const selector = await pool.connect()
  const updater = await pool.connect()
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
    await setup.query('BEGIN')
    await seedPrerequisiteLineage(setup, ids)
    const runId = randomUUID()
    const attemptId = randomUUID()
    const resultId = randomUUID()
    const offerId = randomUUID()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    await insertRun(setup, ids, runId, 'authority-lock-rerate-run')
    await insertRunPackages(setup, ids, runId)
    await insertAttempt(setup, ids, {
      runId,
      attemptId,
      attemptNumber: 1,
      idempotencyKey: 'authority-lock-attempt-1',
    })
    await setup.query(
      `INSERT INTO operations_production_fulfillment_rerate_results (
         id, organization_id, rerate_run_id, attempt_id, state,
         provider_reference, result_hash, redacted_response, completed_at,
         expires_at
       ) VALUES (
         $1, $2, $3, $4, 'succeeded', 'UPS-LOCK-RATE', $5,
         '{"offerCount":1}'::jsonb, now(), $6
       )`,
      [resultId, ids.organization, runId, attemptId, HASH.result, expiresAt],
    )
    await setup.query(
      `INSERT INTO operations_production_fulfillment_rerate_offers (
         id, organization_id, rerate_run_id, attempt_id, result_id,
         provider, service_code, service_name, amount_minor, currency,
         transit_days, offer_hash, normalized_offer, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'ups_rest', '03', 'UPS Ground',
         1800, 'USD', 3, $6, '{"packageCount":2}'::jsonb, $7
       )`,
      [
        offerId,
        ids.organization,
        runId,
        attemptId,
        resultId,
        HASH.offer,
        expiresAt,
      ],
    )
    await setup.query('SET CONSTRAINTS ALL IMMEDIATE')
    const references = await setup.query(
      `SELECT run.global_id AS run_global_id,
              offer.global_id AS offer_global_id
       FROM operations_production_fulfillment_rerate_runs run
       JOIN operations_production_fulfillment_rerate_offers offer
         ON offer.organization_id = run.organization_id
        AND offer.rerate_run_id = run.id
       WHERE run.organization_id = $1::uuid
         AND run.id = $2::uuid
         AND offer.id = $3::uuid`,
      [ids.organization, runId, offerId],
    )
    await setup.query('COMMIT')

    await selector.query('BEGIN')
    const selection = await productionRerates
      .selectProductionFulfillmentRerateOfferInPostgres({
        organizationId: ids.organization,
        rerateRunGlobalId: references.rows[0].run_global_id,
        offerGlobalId: references.rows[0].offer_global_id,
        selectionReason: 'Hold current authority through immutable selection',
        idempotencyKey: 'authority-lock-selection-command-1',
        selectedBy: actorEmail,
      }, selector)
    assert.equal(selection.replayed, false)

    const lockedUpdates = [
      [
        'activation authority',
        `UPDATE operations_activation_scopes
         SET updated_at = updated_at
         WHERE organization_id = $1::uuid`,
        [ids.organization],
      ],
      [
        'order destination and currency authority',
        `UPDATE operations_orders
         SET updated_at = updated_at
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, ids.order],
      ],
      [
        'carrier integration authority',
        `UPDATE operations_integration_accounts
         SET updated_at = updated_at
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, ids.carrierIntegration],
      ],
      [
        'carrier account configuration authority',
        `UPDATE operations_carrier_accounts
         SET updated_at = updated_at
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, ids.carrierAccount],
      ],
      [
        'carrier credential authority',
        `UPDATE operations_carrier_credentials
         SET updated_at = updated_at
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [ids.organization, ids.carrierIntegration],
      ],
    ]
    for (const [label, sql, parameters] of lockedUpdates) {
      await expectRowLockTimeout(updater, label, sql, parameters)
    }
    await selector.query('COMMIT')

    const concurrentDispatches = await Promise.all([
      activeDispatchPersistence.prepareActiveCarrierDispatchAttemptInPostgres({
        organizationId: ids.organization,
        productionRerateSelectionGlobalId: selection.globalId,
        actorEmail,
      }),
      activeDispatchPersistence.prepareActiveCarrierDispatchAttemptInPostgres({
        organizationId: ids.organization,
        productionRerateSelectionGlobalId: selection.globalId,
        actorEmail,
      }),
    ])
    const dispatchOwner = concurrentDispatches.find(
      (attempt) => attempt.dispatchOwner,
    )
    const dispatchReplay = concurrentDispatches.find(
      (attempt) => !attempt.dispatchOwner,
    )
    assert.ok(dispatchOwner, 'Concurrent prepare did not assign one owner')
    assert.ok(dispatchReplay, 'Concurrent prepare did not return one replay')
    assert.equal(dispatchOwner.replayed, false)
    assert.equal(dispatchReplay.globalId, dispatchOwner.globalId)
    assert.equal(dispatchReplay.dispatchOwner, false)
    assert.equal(dispatchReplay.replayed, true)

    const oneDurableOwner = await setup.query(
      `SELECT count(*)::int AS attempt_count
       FROM operations_active_carrier_group_attempts
       WHERE organization_id = $1::uuid
         AND active_shipment_group_id = $2::uuid`,
      [ids.organization, ids.activeGroup],
    )
    assert.equal(oneDurableOwner.rows[0].attempt_count, 1)
  } catch (error) {
    await setup.query('ROLLBACK').catch(() => {})
    await selector.query('ROLLBACK').catch(() => {})
    await updater.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    activeDispatchTransactionPool = null
    setup.release()
    selector.release()
    updater.release()
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
    const authorityDatabaseUrl = await createDisposablePostgresDatabase(
      databaseUrl,
      `clawpilot_rerate_authority_${randomUUID().replaceAll('-', '')}`,
    )
    command('node', ['scripts/db-migrate.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: authorityDatabaseUrl,
        PGSSLMODE: 'disable',
      },
      timeout: 180_000,
    })
    await verifySelectionAuthorityLocks(authorityDatabaseUrl)
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
