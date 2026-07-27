#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

export const SCRIPT_VERSION =
  'express-parcel-development-warehouse-normalization-v1'
export const PREPARE_CONFIRMATION =
  'prepare-express-parcel-dev-warehouse-v1'
export const FINALIZE_CONFIRMATION =
  'finalize-express-parcel-dev-warehouse-v1'
export const WMS_PRESERVE_CONFIRMATION =
  'retire-wms-simulation-preserve-printing-v1'
export const DISPOSABLE_REHEARSAL_CONFIRMATION =
  'normalize-express-parcel-disposable-rehearsal-v1'
export const TRUSTED_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
export const TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98'
export const WMS_SCENARIO_KEY = 'clawpilot-wms-development-v1'

export const TARGET = Object.freeze({
  organizationId: '364b95d1-af2c-494d-8891-78c5d5abb7ac',
  organizationReference: 'ga8142977',
  organizationName: 'Express Parcel International DBA EPISCS',
  sourceWarehouseGlobalId: 'gwh5361546',
  preservedWarehouseGlobalId: 'gwh7494117',
  mockWarehouseGlobalId: 'gwh8126795',
  preservedPrinterGlobalId: 'gpr5630232',
  preservedPrintAgentGlobalId: 'gpt7418225',
  unusedPrintAgentGlobalId: 'gpt5737324',
  proofLocationGlobalId: 'gwl1050773',
  proofPoolGlobalId: 'gip7957421',
  proofPositionGlobalId: 'giv9161814',
  disposablePrinterGlobalIds: ['gpr3308499', 'gpr5244920'],
  disposableRuleGlobalId: 'grl7292522',
  proofOrderGlobalId: 'gor3040630',
  proofLabelGlobalId: 'glb5783781',
  proofArtifactGlobalId: 'gpf7529214',
  proofPrintJobGlobalId: 'gpj7874315',
  carrierIntegrations: Object.freeze([
    Object.freeze({
      integrationGlobalId: 'gia8954146',
      provider: 'fedex_rest',
      accountGlobalId: 'gac9324986',
      accountLastFour: '1073',
      credentialVersion: 1,
    }),
    Object.freeze({
      integrationGlobalId: 'gia5798111',
      provider: 'ups_rest',
      accountGlobalId: 'gac9831000',
      accountLastFour: '3574',
      credentialVersion: 2,
    }),
  ]),
})

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const EMAIL_PATTERN =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const FINAL_WAREHOUSE_CODE = 'DEL-OH-01'
const FINAL_WAREHOUSE_NAME = "Jeg's Ecommerce Warehouse"
const SOURCE_TOMBSTONE_CODE = 'RETIRED-DEL-OH-01-SHELL'
const SOURCE_TOMBSTONE_NAME = 'Retired office print-agent enrollment shell'
const MAX_PRINT_AGENT_AGE_MINUTES = 15

function fail(message) {
  throw new Error(message)
}

function text(value) {
  return String(value || '').trim()
}

function isLocalDatabaseUrl(value) {
  try {
    const database = new URL(text(value))
    return ['postgres:', 'postgresql:'].includes(database.protocol)
      && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
        database.hostname.toLowerCase(),
      )
  } catch {
    return false
  }
}

function populatedRailwayMarkers(environment) {
  return Object.entries(environment)
    .filter(([key, value]) => key.startsWith('RAILWAY_') && text(value))
    .map(([key]) => key)
}

function integer(value) {
  return Number.parseInt(String(value || 0), 10)
}

function numeric(value) {
  return Number(value || 0)
}

function email(value, label) {
  const normalized = text(value).toLowerCase()
  if (!EMAIL_PATTERN.test(normalized) || !/^[\x21-\x7e]+$/.test(normalized)) {
    fail(`${label} must be a valid ASCII email address`)
  }
  return normalized
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

export function planDigest(plan) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalValue(plan)))
    .digest('hex')
}

export function parseArguments(argv) {
  const supported = new Set([
    '--plan',
    '--prepare',
    '--finalize',
    '--self-test',
    '--help',
  ])
  const unknown = argv.filter((argument) => !supported.has(argument))
  if (unknown.length) fail(`Unsupported argument(s): ${unknown.join(', ')}`)
  const selected = ['--prepare', '--finalize', '--self-test']
    .filter((argument) => argv.includes(argument))
  if (selected.length > 1) {
    fail('--prepare, --finalize, and --self-test cannot be combined')
  }
  return {
    mode: argv.includes('--prepare')
      ? 'prepare'
      : argv.includes('--finalize')
        ? 'finalize'
        : argv.includes('--self-test')
          ? 'self-test'
          : 'plan',
    help: argv.includes('--help'),
  }
}

export function configurationFromEnvironment(environment, mode = 'plan') {
  const config = {
    actorEmail: email(
      environment.EXPRESS_PARCEL_DEV_ACTOR_EMAIL,
      'EXPRESS_PARCEL_DEV_ACTOR_EMAIL',
    ),
    expectedDatabaseFingerprint: text(
      environment.EXPRESS_PARCEL_DEV_DATABASE_FINGERPRINT,
    ).toLowerCase(),
    expectedPlanDigest: text(
      environment.EXPRESS_PARCEL_DEV_PLAN_DIGEST,
    ).toLowerCase(),
    confirmation: text(environment.EXPRESS_PARCEL_DEV_CONFIRM),
  }
  if (mode === 'prepare' || mode === 'finalize') {
    if (!UUID_PATTERN.test(config.expectedDatabaseFingerprint)) {
      fail(
        'EXPRESS_PARCEL_DEV_DATABASE_FINGERPRINT must be the exact '
        + 'development database identity',
      )
    }
    if (!SHA256_PATTERN.test(config.expectedPlanDigest)) {
      fail(
        'EXPRESS_PARCEL_DEV_PLAN_DIGEST must be the SHA-256 digest from '
        + 'the immediately prior plan',
      )
    }
    const expectedConfirmation = mode === 'prepare'
      ? PREPARE_CONFIRMATION
      : FINALIZE_CONFIRMATION
    if (config.confirmation !== expectedConfirmation) {
      fail(`EXPRESS_PARCEL_DEV_CONFIRM=${expectedConfirmation} is required`)
    }
  }
  return config
}

export function validateRuntimeEnvironment(environment) {
  if (text(environment.CLAWPILOT_STORAGE).toLowerCase() !== 'postgres') {
    fail('CLAWPILOT_STORAGE=postgres is required')
  }
  const databaseUrl = text(environment.DATABASE_URL)
  if (!databaseUrl) fail('DATABASE_URL is required')
  const rehearsalConfirmation = text(
    environment.EXPRESS_PARCEL_DEV_DISPOSABLE_REHEARSAL_CONFIRM,
  )
  if (rehearsalConfirmation) {
    if (rehearsalConfirmation !== DISPOSABLE_REHEARSAL_CONFIRMATION) {
      fail(
        'EXPRESS_PARCEL_DEV_DISPOSABLE_REHEARSAL_CONFIRM='
        + `${DISPOSABLE_REHEARSAL_CONFIRMATION} is required`,
      )
    }
    if (populatedRailwayMarkers(environment).length > 0) {
      fail(
        'Disposable rehearsal cannot run with Railway environment markers',
      )
    }
    if (!isLocalDatabaseUrl(databaseUrl)) {
      fail('Disposable rehearsal requires a local PostgreSQL database URL')
    }
  } else {
    if (
      text(environment.RAILWAY_ENVIRONMENT_NAME).toLowerCase()
        !== 'development'
    ) {
      fail('RAILWAY_ENVIRONMENT_NAME=development is required')
    }
    if (
      text(environment.RAILWAY_PROJECT_ID).toLowerCase()
        !== TRUSTED_RAILWAY_PROJECT_ID
    ) {
      fail('RAILWAY_PROJECT_ID does not match the trusted ClawPilot project')
    }
    if (
      text(environment.RAILWAY_ENVIRONMENT_ID).toLowerCase()
        !== TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID
    ) {
      fail(
        'RAILWAY_ENVIRONMENT_ID does not match the trusted development environment',
      )
    }
  }
  for (const key of ['VERCEL_ENV', 'CLAWPILOT_ENV']) {
    const value = text(environment[key]).toLowerCase()
    if (value && !['dev', 'development', 'preview', 'local', 'test'].includes(value)) {
      fail(`${key}=${environment[key]} is not a development environment`)
    }
  }
}

function carrierExpectation(row) {
  return TARGET.carrierIntegrations.find(
    (expected) => expected.integrationGlobalId === row.integrationGlobalId,
  )
}

function assertStableIdentity(snapshot) {
  if (
    snapshot.organization.id !== TARGET.organizationId
    || snapshot.organization.referenceCode !== TARGET.organizationReference
    || snapshot.organization.name !== TARGET.organizationName
  ) {
    fail('Express Parcel organization identity differs from the approved target')
  }
  if (!['owner', 'admin'].includes(snapshot.actor.role)) {
    fail('The execution actor must be an active Express Parcel owner or admin')
  }
  if (snapshot.actor.status !== 'active') {
    fail('The execution actor membership is not active')
  }
  const warehouses = new Map(
    snapshot.warehouses.map((warehouse) => [warehouse.globalId, warehouse]),
  )
  for (const globalId of [
    TARGET.sourceWarehouseGlobalId,
    TARGET.preservedWarehouseGlobalId,
    TARGET.mockWarehouseGlobalId,
  ]) {
    if (!warehouses.has(globalId)) {
      fail(`Required warehouse ${globalId} is missing`)
    }
  }
  const printing = snapshot.printing
  if (
    printing.warehouseGlobalId !== TARGET.preservedWarehouseGlobalId
    || printing.printerGlobalId !== TARGET.preservedPrinterGlobalId
    || printing.printAgentGlobalId !== TARGET.preservedPrintAgentGlobalId
    || printing.proofOrderGlobalId !== TARGET.proofOrderGlobalId
    || printing.proofLabelGlobalId !== TARGET.proofLabelGlobalId
    || printing.proofArtifactGlobalId !== TARGET.proofArtifactGlobalId
    || printing.proofPrintJobGlobalId !== TARGET.proofPrintJobGlobalId
    || printing.printerStatus !== 'online'
    || printing.connectionMode !== 'local_agent'
    || printing.printAgentStatus !== 'active'
    || printing.proofPrintJobStatus !== 'delivered'
    || printing.deliveryAttemptCount !== 3
    || printing.deliveryStates !== 'queued,claimed,delivered'
  ) {
    fail('The immutable Zebra proof lineage differs from the approved target')
  }
  if (snapshot.carriers.length !== TARGET.carrierIntegrations.length) {
    fail('The approved FedEx and UPS integration set is incomplete')
  }
  for (const row of snapshot.carriers) {
    const expected = carrierExpectation(row)
    if (
      !expected
      || row.provider !== expected.provider
      || row.accountGlobalId !== expected.accountGlobalId
      || row.accountLastFour !== expected.accountLastFour
      || row.credentialVersion !== expected.credentialVersion
      || row.integrationStatus !== 'active'
      || row.accountStatus !== 'active'
      || row.verificationStatus !== 'verified'
    ) {
      fail(`Carrier integration ${row.integrationGlobalId} changed`)
    }
  }
}

export function determinePhase(snapshot) {
  const source = snapshot.warehouses.find(
    (warehouse) => warehouse.globalId === TARGET.sourceWarehouseGlobalId,
  )
  const preserved = snapshot.warehouses.find(
    (warehouse) => warehouse.globalId === TARGET.preservedWarehouseGlobalId,
  )
  const mock = snapshot.warehouses.find(
    (warehouse) => warehouse.globalId === TARGET.mockWarehouseGlobalId,
  )
  const orders = snapshot.orders
  const resources = snapshot.resources
  const sourceTopologyReady = (
    snapshot.sourceLocationDependencies.locations === 9
    && Object.entries(snapshot.sourceLocationDependencies).every(
      ([name, value]) => name === 'locations' || value === 0,
    )
  )
  const complete = (
    snapshot.activation.state === 'read_only'
    && orders.wmsTotal === 21
    && orders.wmsRetired === 21
    && orders.wmsActiveReservations === 0
    && orders.mockTotal === 8
    && orders.mockProofTotal === 8
    && orders.mockRetired === 8
    && orders.mockActiveReservations === 0
    && source?.status === 'inactive'
    && source?.code === SOURCE_TOMBSTONE_CODE
    && preserved?.status === 'active'
    && preserved?.code === FINAL_WAREHOUSE_CODE
    && snapshot.locations.sourceTotal === 0
    && snapshot.locations.preservedActive === 9
    && resources.disposablePrinters === 0
    && resources.unusedAgentStatus === 'revoked'
    && resources.proofLocationActive === false
    && resources.proofPoolActive === false
    && resources.proofPositionReserved === 0
    && mock?.status === 'inactive'
  )
  if (complete) return 'complete'
  const finalize = (
    snapshot.activation.state === 'frozen'
    && orders.wmsTotal === 21
    && orders.wmsRetired === 21
    && orders.wmsActiveReservations === 0
    && orders.mockTotal === 8
    && orders.mockProofTotal === 8
    && orders.mockRetired === 8
    && orders.mockActiveReservations === 0
    && resources.disposablePrinters === 0
    && resources.proofLocationActive === false
    && resources.proofPoolActive === false
    && resources.proofPositionReserved === 0
    && preserved?.status === 'active'
    && preserved?.simulationState === 'retired'
    && sourceTopologyReady
  )
  if (finalize) return 'finalize'
  const wmsCleanup = (
    snapshot.activation.state === 'frozen'
    && orders.wmsTotal === 21
    && orders.wmsRetired < 21
    && orders.mockTotal === 8
    && orders.mockProofTotal === 8
    && orders.mockRetired === 8
    && orders.mockActiveReservations === 0
    && resources.disposablePrinters === 0
    && resources.proofLocationActive === false
    && resources.proofPoolActive === false
    && resources.proofPositionReserved === 0
    && sourceTopologyReady
  )
  if (wmsCleanup) return 'wms_cleanup'
  const prepare = (
    snapshot.activation.state === 'read_only'
    && orders.wmsTotal === 21
    && orders.wmsRetired < 21
    && orders.mockTotal === 8
    && orders.mockProofTotal === 8
    && orders.mockRetired < 8
    && orders.mockActiveReservations === 7
    && orders.mockReservedQuantity === 7
    && resources.disposablePrinters === 2
    && resources.proofLocationActive === true
    && resources.proofPoolActive === true
    && resources.proofPositionReserved === 3
    && sourceTopologyReady
  )
  return prepare ? 'prepare' : 'blocked'
}

async function readSnapshot(client, config) {
  const database = (
    await client.query(
      `SELECT current_database() AS database_name,
         (
           SELECT value->>'id'
           FROM app_settings
           WHERE key = 'deployment.database.identity'
         ) AS database_fingerprint`,
    )
  ).rows[0]
  if (!UUID_PATTERN.test(database?.database_fingerprint || '')) {
    fail('Development database identity is missing or invalid')
  }
  const organization = (
    await client.query(
      `SELECT id::text, reference_code, name
       FROM workspace_organizations
       WHERE id = $1::uuid`,
      [TARGET.organizationId],
    )
  ).rows[0]
  if (!organization) fail('Express Parcel organization is missing')
  const actor = (
    await client.query(
      `SELECT membership.role, membership.status
       FROM app_user_organization_memberships membership
       JOIN app_users users ON users.email = membership.user_email
       WHERE membership.organization_id = $1::uuid
         AND membership.user_email = $2
         AND users.status = 'active'`,
      [TARGET.organizationId, config.actorEmail],
    )
  ).rows[0]
  if (!actor) fail('Execution actor is not an active Express Parcel member')
  const activation = (
    await client.query(
      `SELECT state, revision, reason
       FROM operations_activation_scopes
       WHERE organization_id = $1::uuid`,
      [TARGET.organizationId],
    )
  ).rows[0]
  if (!activation) fail('Express Parcel activation scope is missing')
  const warehouseRows = await client.query(
    `SELECT global_id, code, name, status,
            address->>'simulationState' AS simulation_state,
            address->>'formerScenarioKey' AS former_scenario_key
     FROM operations_warehouses
     WHERE organization_id = $1::uuid
       AND global_id = ANY($2::text[])
     ORDER BY global_id`,
    [
      TARGET.organizationId,
      [
        TARGET.sourceWarehouseGlobalId,
        TARGET.preservedWarehouseGlobalId,
        TARGET.mockWarehouseGlobalId,
      ],
    ],
  )
  const locations = (
    await client.query(
      `SELECT
         count(*) FILTER (
           WHERE warehouse.global_id = $2
         )::integer AS source_total,
         count(*) FILTER (
           WHERE warehouse.global_id = $2 AND location.active
         )::integer AS source_active,
         count(*) FILTER (
           WHERE warehouse.global_id = $3
         )::integer AS preserved_total,
         count(*) FILTER (
           WHERE warehouse.global_id = $3 AND location.active
         )::integer AS preserved_active,
         count(*) FILTER (
           WHERE warehouse.global_id = $4
         )::integer AS mock_total
       FROM operations_locations location
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = location.organization_id
        AND warehouse.id = location.warehouse_id
       WHERE location.organization_id = $1::uuid`,
      [
        TARGET.organizationId,
        TARGET.sourceWarehouseGlobalId,
        TARGET.preservedWarehouseGlobalId,
        TARGET.mockWarehouseGlobalId,
      ],
    )
  ).rows[0]
  const printing = (
    await client.query(
      `SELECT warehouse.global_id AS warehouse_global_id,
              printer.global_id AS printer_global_id,
              printer.status AS printer_status,
              printer.connection_mode,
              agent.global_id AS print_agent_global_id,
              agent.status AS print_agent_status,
              orders.global_id AS proof_order_global_id,
              label.global_id AS proof_label_global_id,
              artifact.global_id AS proof_artifact_global_id,
              job.global_id AS proof_print_job_global_id,
              job.status AS proof_print_job_status,
              count(attempt.id)::integer AS delivery_attempt_count,
              string_agg(attempt.state, ',' ORDER BY attempt.sequence_number)
                AS delivery_states
       FROM operations_print_jobs job
       JOIN operations_printers printer
         ON printer.organization_id = job.organization_id
        AND printer.id = job.requested_printer_id
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = printer.organization_id
        AND warehouse.id = printer.warehouse_id
       JOIN operations_print_agents agent
         ON agent.organization_id = printer.organization_id
        AND agent.id = printer.local_print_agent_id
       JOIN operations_print_artifacts artifact
         ON artifact.organization_id = job.organization_id
        AND artifact.id = job.artifact_id
       JOIN operations_orders orders
         ON orders.organization_id = artifact.organization_id
        AND orders.id = artifact.source_order_id
       JOIN operations_labels label
         ON label.organization_id = artifact.organization_id
        AND label.id = artifact.source_label_id
       LEFT JOIN operations_print_delivery_attempts attempt
         ON attempt.organization_id = job.organization_id
        AND attempt.print_job_id = job.id
       WHERE job.organization_id = $1::uuid
         AND job.global_id = $2
       GROUP BY warehouse.global_id, printer.global_id, printer.status,
                printer.connection_mode, agent.global_id, agent.status,
                orders.global_id, label.global_id, artifact.global_id,
                job.global_id, job.status`,
      [TARGET.organizationId, TARGET.proofPrintJobGlobalId],
    )
  ).rows[0]
  if (!printing) fail('The immutable Zebra proof lineage is missing')
  const carrierRows = await client.query(
    `SELECT integration.global_id AS integration_global_id,
            integration.provider, integration.status AS integration_status,
            account.global_id AS account_global_id,
            account.account_number_last_four,
            account.status AS account_status,
            credential.credential_version,
            credential.verification_status
     FROM operations_integration_accounts integration
     JOIN operations_carrier_accounts account
       ON account.organization_id = integration.organization_id
      AND account.integration_account_id = integration.id
     JOIN operations_carrier_credentials credential
       ON credential.organization_id = integration.organization_id
      AND credential.integration_account_id = integration.id
     WHERE integration.organization_id = $1::uuid
       AND integration.global_id = ANY($2::text[])
     ORDER BY integration.global_id`,
    [
      TARGET.organizationId,
      TARGET.carrierIntegrations.map((item) => item.integrationGlobalId),
    ],
  )
  const orders = (
    await client.query(
      `SELECT
         count(DISTINCT orders.id) FILTER (
           WHERE orders.source_payload->>'scenarioKey' = $2
         )::integer AS wms_total,
         count(DISTINCT orders.id) FILTER (
           WHERE orders.source_payload->>'scenarioKey' = $2
             AND orders.status = 'cancelled'
             AND orders.archived_at IS NOT NULL
         )::integer AS wms_retired,
         count(DISTINCT reservation.id) FILTER (
           WHERE orders.source_payload->>'scenarioKey' = $2
             AND reservation.status = 'active'
         )::integer AS wms_active_reservations,
         COALESCE(sum(reservation.quantity) FILTER (
           WHERE orders.source_payload->>'scenarioKey' = $2
             AND reservation.status = 'active'
         ), 0)::text AS wms_reserved_quantity,
         count(DISTINCT orders.id) FILTER (
           WHERE orders.source_provider = 'mock-commerce'
         )::integer AS mock_total,
         count(DISTINCT orders.id) FILTER (
           WHERE orders.source_provider = 'mock-commerce'
             AND COALESCE(
               lower(orders.source_payload #>> '{sourcePayload,proof}'),
               'false'
             )
               IN ('true', '1', 'yes')
         )::integer AS mock_proof_total,
         count(DISTINCT orders.id) FILTER (
           WHERE orders.source_provider = 'mock-commerce'
             AND orders.status = 'cancelled'
             AND orders.archived_at IS NOT NULL
         )::integer AS mock_retired,
         count(DISTINCT reservation.id) FILTER (
           WHERE orders.source_provider = 'mock-commerce'
             AND reservation.status = 'active'
         )::integer AS mock_active_reservations,
         COALESCE(sum(reservation.quantity) FILTER (
           WHERE orders.source_provider = 'mock-commerce'
             AND reservation.status = 'active'
         ), 0)::text AS mock_reserved_quantity
       FROM operations_orders orders
       LEFT JOIN operations_reservations reservation
         ON reservation.organization_id = orders.organization_id
        AND reservation.order_id = orders.id
       WHERE orders.organization_id = $1::uuid
         AND (
           orders.source_payload->>'scenarioKey' = $2
           OR orders.source_provider = 'mock-commerce'
         )`,
      [TARGET.organizationId, WMS_SCENARIO_KEY],
    )
  ).rows[0]
  const resources = (
    await client.query(
      `SELECT
         count(*) FILTER (
           WHERE printer.global_id = ANY($2::text[])
         )::integer AS disposable_printers,
         (
           SELECT agent.status
           FROM operations_print_agents agent
           WHERE agent.organization_id = $1::uuid
             AND agent.global_id = $3
         ) AS unused_agent_status,
         (
           SELECT location.active
           FROM operations_locations location
           WHERE location.organization_id = $1::uuid
             AND location.global_id = $4
         ) AS proof_location_active,
         (
           SELECT pool.active
           FROM operations_inventory_pools pool
           WHERE pool.organization_id = $1::uuid
             AND pool.global_id = $5
         ) AS proof_pool_active,
         (
           SELECT position.reserved_quantity::text
           FROM operations_inventory_positions position
           WHERE position.organization_id = $1::uuid
             AND position.global_id = $6
         ) AS proof_position_reserved
       FROM operations_printers printer
       WHERE printer.organization_id = $1::uuid`,
      [
        TARGET.organizationId,
        TARGET.disposablePrinterGlobalIds,
        TARGET.unusedPrintAgentGlobalId,
        TARGET.proofLocationGlobalId,
        TARGET.proofPoolGlobalId,
        TARGET.proofPositionGlobalId,
      ],
    )
  ).rows[0]
  const sourceLocationDependencies =
    await readSourceLocationDependencies(client)
  const snapshot = {
    database: {
      name: database.database_name,
      fingerprint: database.database_fingerprint,
    },
    organization: {
      id: organization.id,
      referenceCode: organization.reference_code,
      name: organization.name,
    },
    actor: { email: config.actorEmail, role: actor.role, status: actor.status },
    activation: {
      state: activation.state,
      revision: integer(activation.revision),
      reason: activation.reason || null,
    },
    warehouses: warehouseRows.rows.map((row) => ({
      globalId: row.global_id,
      code: row.code,
      name: row.name,
      status: row.status,
      simulationState: row.simulation_state || null,
      formerScenarioKey: row.former_scenario_key || null,
    })),
    locations: {
      sourceTotal: integer(locations.source_total),
      sourceActive: integer(locations.source_active),
      preservedTotal: integer(locations.preserved_total),
      preservedActive: integer(locations.preserved_active),
      mockTotal: integer(locations.mock_total),
    },
    printing: {
      warehouseGlobalId: printing.warehouse_global_id,
      printerGlobalId: printing.printer_global_id,
      printerStatus: printing.printer_status,
      connectionMode: printing.connection_mode,
      printAgentGlobalId: printing.print_agent_global_id,
      printAgentStatus: printing.print_agent_status,
      proofOrderGlobalId: printing.proof_order_global_id,
      proofLabelGlobalId: printing.proof_label_global_id,
      proofArtifactGlobalId: printing.proof_artifact_global_id,
      proofPrintJobGlobalId: printing.proof_print_job_global_id,
      proofPrintJobStatus: printing.proof_print_job_status,
      deliveryAttemptCount: integer(printing.delivery_attempt_count),
      deliveryStates: printing.delivery_states,
    },
    carriers: carrierRows.rows.map((row) => ({
      integrationGlobalId: row.integration_global_id,
      provider: row.provider,
      integrationStatus: row.integration_status,
      accountGlobalId: row.account_global_id,
      accountLastFour: row.account_number_last_four,
      accountStatus: row.account_status,
      credentialVersion: integer(row.credential_version),
      verificationStatus: row.verification_status,
    })),
    orders: {
      wmsTotal: integer(orders.wms_total),
      wmsRetired: integer(orders.wms_retired),
      wmsActiveReservations: integer(orders.wms_active_reservations),
      wmsReservedQuantity: numeric(orders.wms_reserved_quantity),
      mockTotal: integer(orders.mock_total),
      mockProofTotal: integer(orders.mock_proof_total),
      mockRetired: integer(orders.mock_retired),
      mockActiveReservations: integer(orders.mock_active_reservations),
      mockReservedQuantity: numeric(orders.mock_reserved_quantity),
    },
    resources: {
      disposablePrinters: integer(resources.disposable_printers),
      unusedAgentStatus: resources.unused_agent_status,
      proofLocationActive: resources.proof_location_active,
      proofPoolActive: resources.proof_pool_active,
      proofPositionReserved: numeric(resources.proof_position_reserved),
    },
    sourceLocationDependencies,
  }
  assertStableIdentity(snapshot)
  return {
    ...snapshot,
    phase: determinePhase(snapshot),
  }
}

function publicPlan(snapshot) {
  const plan = {
    scriptVersion: SCRIPT_VERSION,
    phase: snapshot.phase,
    database: snapshot.database,
    organization: snapshot.organization,
    actor: snapshot.actor,
    activation: snapshot.activation,
    warehouses: snapshot.warehouses,
    locations: snapshot.locations,
    printing: snapshot.printing,
    carriers: snapshot.carriers,
    orders: snapshot.orders,
    resources: snapshot.resources,
    sourceLocationDependencies: snapshot.sourceLocationDependencies,
    immutableRetention: [
      TARGET.preservedWarehouseGlobalId,
      TARGET.preservedPrinterGlobalId,
      TARGET.preservedPrintAgentGlobalId,
      TARGET.proofOrderGlobalId,
      TARGET.proofLabelGlobalId,
      TARGET.proofArtifactGlobalId,
      TARGET.proofPrintJobGlobalId,
      ...TARGET.carrierIntegrations.flatMap((item) => [
        item.integrationGlobalId,
        item.accountGlobalId,
      ]),
    ],
    nextAction: snapshot.phase === 'prepare'
      ? 'run_prepare'
      : snapshot.phase === 'wms_cleanup'
        ? 'run_wms_preserve_cleanup'
        : snapshot.phase === 'finalize'
          ? 'run_finalize'
          : snapshot.phase === 'complete'
            ? 'none'
            : 'investigate_drift',
  }
  return { plan, digest: planDigest(plan) }
}

function assertApprovedExecution(planResult, config, expectedPhase) {
  if (planResult.plan.database.fingerprint !== config.expectedDatabaseFingerprint) {
    fail('Development database identity changed after plan approval')
  }
  if (planResult.digest !== config.expectedPlanDigest) {
    fail('Normalization plan changed after approval')
  }
  if (planResult.plan.phase !== expectedPhase) {
    fail(
      `Expected ${expectedPhase} phase; current phase is `
      + `${planResult.plan.phase}`,
    )
  }
}

async function releaseMockReservations(client, actorEmail, orderIds) {
  const reservations = await client.query(
    `SELECT reservation.id::text, reservation.global_id,
            reservation.position_id::text, reservation.quantity
     FROM operations_reservations reservation
     WHERE reservation.organization_id = $1::uuid
       AND reservation.order_id = ANY($2::uuid[])
       AND reservation.status = 'active'
     ORDER BY reservation.created_at, reservation.id
     FOR UPDATE`,
    [TARGET.organizationId, orderIds],
  )
  const quantity = reservations.rows.reduce(
    (sum, reservation) => sum + numeric(reservation.quantity),
    0,
  )
  if (reservations.rowCount !== 7 || quantity !== 7) {
    fail(
      `Expected 7 mock reservations totaling 7; found `
      + `${reservations.rowCount} totaling ${quantity}`,
    )
  }
  for (const reservation of reservations.rows) {
    const position = (
      await client.query(
        `SELECT id::text, on_hand_quantity, reserved_quantity,
                damaged_quantity
         FROM operations_inventory_positions
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
         FOR UPDATE`,
        [TARGET.organizationId, reservation.position_id],
      )
    ).rows[0]
    const releaseQuantity = numeric(reservation.quantity)
    if (!position || numeric(position.reserved_quantity) < releaseQuantity) {
      fail(`Reserved balance is too low for ${reservation.global_id}`)
    }
    const after = (
      await client.query(
        `UPDATE operations_inventory_positions
         SET reserved_quantity = reserved_quantity - $3,
             version = version + 1,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
         RETURNING on_hand_quantity, reserved_quantity, damaged_quantity`,
        [
          TARGET.organizationId,
          reservation.position_id,
          releaseQuantity,
        ],
      )
    ).rows[0]
    await client.query(
      `INSERT INTO operations_inventory_ledger (
         organization_id, position_id, event_type, on_hand_delta,
         reserved_delta, damaged_delta, on_hand_after, reserved_after,
         damaged_after, source_global_id, reason, idempotency_key,
         actor_email, occurred_at
       ) VALUES (
         $1::uuid, $2::uuid, 'reservation_release', 0, $3, 0,
         $4, $5, $6, $7,
         'Express Parcel development mock proof retirement',
         $8, $9, now()
       )`,
      [
        TARGET.organizationId,
        reservation.position_id,
        -releaseQuantity,
        after.on_hand_quantity,
        after.reserved_quantity,
        after.damaged_quantity,
        reservation.global_id,
        `${SCRIPT_VERSION}:release:${reservation.global_id}`,
        actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_reservations
       SET status = 'released',
           released_at = COALESCE(released_at, now())
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [TARGET.organizationId, reservation.id],
    )
  }
  return { count: reservations.rowCount, quantity }
}

async function audit(client, actorEmail, eventType, payload) {
  await client.query(
    `INSERT INTO audit_events (
       actor, event_type, aggregate_type, aggregate_id, payload,
       subject, organization_id, is_system
     ) VALUES (
       $1, $2, 'workspace_organization', $3::uuid, $4::jsonb,
       $5, $3::uuid, false
     )`,
    [
      actorEmail,
      eventType,
      TARGET.organizationId,
      JSON.stringify(payload),
      TARGET.organizationName,
    ],
  )
}

async function prepare(client, config) {
  await client.query('BEGIN')
  try {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`clawpilot:${SCRIPT_VERSION}:${TARGET.organizationId}`],
    )
    await client.query(
      `SELECT organization_id
       FROM operations_activation_scopes
       WHERE organization_id = $1::uuid
       FOR UPDATE`,
      [TARGET.organizationId],
    )
    const before = publicPlan(await readSnapshot(client, config))
    assertApprovedExecution(before, config, 'prepare')
    await client.query(
      `UPDATE operations_activation_scopes
       SET state = 'frozen',
           revision = revision + 1,
           reason = 'Express Parcel development warehouse normalization',
           updated_by = $2,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND state = 'read_only'`,
      [TARGET.organizationId, config.actorEmail],
    )
    const mockOrders = await client.query(
      `SELECT id::text, global_id
       FROM operations_orders
       WHERE organization_id = $1::uuid
         AND source_provider = 'mock-commerce'
         AND COALESCE(
           lower(source_payload #>> '{sourcePayload,proof}'),
           'false'
         )
           IN ('true', '1', 'yes')
       ORDER BY global_id
       FOR UPDATE`,
      [TARGET.organizationId],
    )
    if (mockOrders.rowCount !== 8) {
      fail(`Expected exactly 8 mock proof orders; found ${mockOrders.rowCount}`)
    }
    const orderIds = mockOrders.rows.map((order) => order.id)
    const contaminatedWaves = await client.query(
      `WITH target_waves AS (
         SELECT DISTINCT task.wave_id
         FROM operations_pick_tasks task
         JOIN operations_fulfillment_plans plan
           ON plan.organization_id = task.organization_id
          AND plan.id = task.plan_id
         WHERE task.organization_id = $1::uuid
           AND plan.order_id = ANY($2::uuid[])
       )
       SELECT DISTINCT wave.global_id
       FROM target_waves target
       JOIN operations_pick_tasks task ON task.wave_id = target.wave_id
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = task.organization_id
        AND plan.id = task.plan_id
       JOIN operations_waves wave
         ON wave.organization_id = task.organization_id
        AND wave.id = task.wave_id
       WHERE plan.order_id <> ALL($2::uuid[])`,
      [TARGET.organizationId, orderIds],
    )
    if (contaminatedWaves.rowCount) {
      fail(
        `Mock proof waves contain unrelated orders: `
        + contaminatedWaves.rows.map((row) => row.global_id).join(', '),
      )
    }
    const released = await releaseMockReservations(
      client,
      config.actorEmail,
      orderIds,
    )
    const cancelledTasks = await client.query(
      `UPDATE operations_pick_tasks task
       SET status = 'cancelled', updated_at = now()
       FROM operations_fulfillment_plans plan
       WHERE task.organization_id = $1::uuid
         AND task.plan_id = plan.id
         AND plan.order_id = ANY($2::uuid[])
         AND task.status <> 'cancelled'
       RETURNING task.id`,
      [TARGET.organizationId, orderIds],
    )
    const cancelledPlans = await client.query(
      `UPDATE operations_fulfillment_plans
       SET status = 'cancelled', updated_at = now()
       WHERE organization_id = $1::uuid
         AND order_id = ANY($2::uuid[])
         AND status <> 'cancelled'
       RETURNING id`,
      [TARGET.organizationId, orderIds],
    )
    const cancelledWaves = await client.query(
      `WITH target_waves AS (
         SELECT DISTINCT task.wave_id
         FROM operations_pick_tasks task
         JOIN operations_fulfillment_plans plan
           ON plan.organization_id = task.organization_id
          AND plan.id = task.plan_id
         WHERE task.organization_id = $1::uuid
           AND plan.order_id = ANY($2::uuid[])
       )
       UPDATE operations_waves wave
       SET status = 'cancelled',
           completed_at = COALESCE(completed_at, now())
       WHERE wave.organization_id = $1::uuid
         AND wave.id IN (SELECT wave_id FROM target_waves)
         AND wave.status <> 'cancelled'
       RETURNING wave.id`,
      [TARGET.organizationId, orderIds],
    )
    await client.query(
      `UPDATE operations_orders
       SET status = 'cancelled',
           source_payload = source_payload || jsonb_build_object(
             'simulationState', 'retired',
             'retirementReason', 'mock_operations_proof_retired'
           ),
           archived_at = COALESCE(archived_at, now()),
           archive_reason = COALESCE(
             archive_reason,
             'mock_operations_proof_retired'
           ),
           archived_by = COALESCE(archived_by, $3),
           updated_by = $3,
           row_version = row_version + 1,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = ANY($2::uuid[])`,
      [TARGET.organizationId, orderIds, config.actorEmail],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'disabled',
           configuration = configuration || '{"state":"retired"}'::jsonb,
           credential_reference = NULL,
           updated_by = $2,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND provider = 'mock-commerce'
         AND integration_type = 'commerce'`,
      [TARGET.organizationId, config.actorEmail],
    )
    await client.query(
      `UPDATE operations_product_mappings mapping
       SET active = false, updated_at = now()
       FROM operations_integration_accounts integration
       WHERE mapping.organization_id = $1::uuid
         AND mapping.integration_account_id = integration.id
         AND integration.provider = 'mock-commerce'
         AND mapping.active`,
      [TARGET.organizationId],
    )
    await client.query(
      `UPDATE operations_contracts
       SET status = 'terminated', updated_at = now()
       WHERE organization_id = $1::uuid
         AND name LIKE 'Mock proof fulfillment %'
         AND status <> 'terminated'`,
      [TARGET.organizationId],
    )
    await client.query(
      `UPDATE operations_inventory_pool_customers membership
       SET effective_to = now()
       FROM operations_inventory_pools pool
       WHERE membership.organization_id = $1::uuid
         AND membership.pool_id = pool.id
         AND pool.name LIKE 'Proof pool %'
         AND membership.effective_to IS NULL
         AND membership.effective_from < now()`,
      [TARGET.organizationId],
    )
    await client.query(
      `UPDATE operations_inventory_pools
       SET active = false, updated_at = now()
       WHERE organization_id = $1::uuid
         AND name LIKE 'Proof pool %'
         AND active`,
      [TARGET.organizationId],
    )
    await client.query(
      `UPDATE operations_locations location
       SET active = false,
           notes = jsonb_build_object(
             'retirementReason', 'mock_operations_proof_retired',
             'previousNotes', location.notes
           )::text,
           updated_by = $2,
           row_version = location.row_version + 1,
           updated_at = now()
       FROM operations_warehouses warehouse
       WHERE location.organization_id = $1::uuid
         AND location.warehouse_id = warehouse.id
         AND (
           location.global_id = $3
           OR warehouse.global_id = $4
         )
         AND location.active`,
      [
        TARGET.organizationId,
        config.actorEmail,
        TARGET.proofLocationGlobalId,
        TARGET.mockWarehouseGlobalId,
      ],
    )
    await client.query(
      `UPDATE operations_rules
       SET active = false, updated_at = now()
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND active`,
      [TARGET.organizationId, TARGET.disposableRuleGlobalId],
    )
    const printerReferences = await client.query(
      `SELECT printer.global_id,
              (
                SELECT count(*)
                FROM operations_print_jobs job
                WHERE job.organization_id = printer.organization_id
                  AND (
                    job.printer_id = printer.id
                    OR job.requested_printer_id = printer.id
                    OR job.fallback_printer_id = printer.id
                  )
              )::integer AS jobs,
              (
                SELECT count(*)
                FROM operations_print_delivery_attempts attempt
                WHERE attempt.organization_id = printer.organization_id
                  AND attempt.printer_id = printer.id
              )::integer AS attempts,
              (
                SELECT count(*)
                FROM operations_printers fallback
                WHERE fallback.organization_id = printer.organization_id
                  AND fallback.fallback_printer_id = printer.id
              )::integer AS fallbacks
       FROM operations_printers printer
       WHERE printer.organization_id = $1::uuid
         AND printer.global_id = ANY($2::text[])
       ORDER BY printer.global_id
       FOR UPDATE`,
      [TARGET.organizationId, TARGET.disposablePrinterGlobalIds],
    )
    if (
      printerReferences.rowCount !== 2
      || printerReferences.rows.some(
        (row) => integer(row.jobs) || integer(row.attempts) || integer(row.fallbacks),
      )
    ) {
      fail('Disposable mock printers gained immutable or fallback references')
    }
    await client.query(
      `DELETE FROM operations_printers
       WHERE organization_id = $1::uuid
         AND global_id = ANY($2::text[])`,
      [TARGET.organizationId, TARGET.disposablePrinterGlobalIds],
    )
    await client.query(
      `UPDATE crm_reference_registry
       SET status = 'retired', retired_at = COALESCE(retired_at, now())
       WHERE reference_code = ANY($1::text[])
         AND status = 'active'`,
      [TARGET.disposablePrinterGlobalIds],
    )
    await client.query(
      `UPDATE operations_warehouses
       SET status = 'inactive',
           address = address || jsonb_build_object(
             'state', 'retired',
             'retirementReason', 'mock_operations_proof_retired'
           ),
           updated_by = $2,
           row_version = row_version + 1,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND global_id = $3`,
      [
        TARGET.organizationId,
        config.actorEmail,
        TARGET.mockWarehouseGlobalId,
      ],
    )
    await audit(
      client,
      config.actorEmail,
      'operations.development_warehouse_normalization.prepared',
      {
        scriptVersion: SCRIPT_VERSION,
        releasedReservations: released,
        cancelledPickTasks: cancelledTasks.rowCount,
        cancelledPlans: cancelledPlans.rowCount,
        cancelledWaves: cancelledWaves.rowCount,
        preservedPrinterGlobalId: TARGET.preservedPrinterGlobalId,
        preservedPrintAgentGlobalId: TARGET.preservedPrintAgentGlobalId,
      },
    )
    const after = publicPlan(await readSnapshot(client, config))
    if (after.plan.phase !== 'wms_cleanup') {
      fail(`Prepare postflight reached ${after.plan.phase}, not wms_cleanup`)
    }
    await client.query('COMMIT')
    return {
      ok: true,
      mode: 'prepare',
      beforeDigest: before.digest,
      after: after.plan,
      afterDigest: after.digest,
      reservationsReleased: released,
      wmsCleanup: wmsCleanupCommand(after.plan.database.fingerprint),
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function readSourceLocationDependencies(client) {
  const result = await client.query(
    `WITH source_warehouse AS (
       SELECT id
       FROM operations_warehouses
       WHERE organization_id = $1::uuid AND global_id = $2
     ),
     source_locations AS (
       SELECT id
       FROM operations_locations
       WHERE organization_id = $1::uuid
         AND warehouse_id IN (SELECT id FROM source_warehouse)
     )
     SELECT
       (SELECT count(*) FROM source_locations)::integer AS locations,
       (
         SELECT count(*) FROM operations_inventory_positions position
         WHERE position.organization_id = $1::uuid
           AND position.location_id IN (SELECT id FROM source_locations)
       )::integer AS positions,
       (
         SELECT count(*) FROM operations_location_product_rules rule
         WHERE rule.organization_id = $1::uuid
           AND (
             rule.location_id IN (SELECT id FROM source_locations)
             OR rule.replenishment_source_location_id
               IN (SELECT id FROM source_locations)
           )
       )::integer AS rules,
       (
         SELECT count(*) FROM operations_pick_tasks task
         WHERE task.organization_id = $1::uuid
           AND task.from_location_id IN (SELECT id FROM source_locations)
       )::integer AS pick_tasks,
       (
         SELECT count(*) FROM operations_receipt_lines line
         WHERE line.organization_id = $1::uuid
           AND line.target_location_id IN (SELECT id FROM source_locations)
       )::integer AS receipt_lines,
       (
         SELECT count(*) FROM operations_replenishment_tasks task
         WHERE task.organization_id = $1::uuid
           AND (
             task.source_location_id IN (SELECT id FROM source_locations)
             OR task.destination_location_id IN (SELECT id FROM source_locations)
           )
       )::integer AS replenishment_tasks,
       (
         SELECT count(*) FROM operations_locations child
         WHERE child.organization_id = $1::uuid
           AND child.parent_location_id IN (SELECT id FROM source_locations)
           AND child.id NOT IN (SELECT id FROM source_locations)
       )::integer AS external_children`,
    [TARGET.organizationId, TARGET.sourceWarehouseGlobalId],
  )
  return Object.fromEntries(
    Object.entries(result.rows[0]).map(([name, value]) => [
      name,
      integer(value),
    ]),
  )
}

async function assertSourceLocationsMovable(client) {
  const row = await readSourceLocationDependencies(client)
  const dependencies = Object.entries(row)
    .filter(([key, value]) => key !== 'locations' && integer(value) !== 0)
    .map(([key, value]) => `${key}=${value}`)
  if (integer(row.locations) !== 9 || dependencies.length) {
    fail(
      `Source warehouse locations are not the exact dependency-free 9-row `
      + `topology: locations=${row.locations}, ${dependencies.join(', ')}`,
    )
  }
}

async function finalize(client, config) {
  await client.query('BEGIN')
  try {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`clawpilot:${SCRIPT_VERSION}:${TARGET.organizationId}`],
    )
    await client.query(
      `SELECT organization_id
       FROM operations_activation_scopes
       WHERE organization_id = $1::uuid
       FOR UPDATE`,
      [TARGET.organizationId],
    )
    const before = publicPlan(await readSnapshot(client, config))
    assertApprovedExecution(before, config, 'finalize')
    const heartbeat = (
      await client.query(
        `SELECT status,
                extract(epoch FROM (now() - last_seen_at)) / 60 AS age_minutes
         FROM operations_print_agents
         WHERE organization_id = $1::uuid
           AND global_id = $2
         FOR UPDATE`,
        [TARGET.organizationId, TARGET.preservedPrintAgentGlobalId],
      )
    ).rows[0]
    if (
      !heartbeat
      || heartbeat.status !== 'active'
      || heartbeat.age_minutes === null
      || numeric(heartbeat.age_minutes) > MAX_PRINT_AGENT_AGE_MINUTES
    ) {
      fail(
        `Preserved print agent heartbeat must be active and no older than `
        + `${MAX_PRINT_AGENT_AGE_MINUTES} minutes`,
      )
    }
    await assertSourceLocationsMovable(client)
    const preservedLocationRows = await client.query(
      `SELECT location.id::text, location.active
       FROM operations_locations location
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = location.organization_id
        AND warehouse.id = location.warehouse_id
       WHERE location.organization_id = $1::uuid
         AND warehouse.global_id = $2
       ORDER BY location.global_id
       FOR UPDATE OF location`,
      [TARGET.organizationId, TARGET.preservedWarehouseGlobalId],
    )
    if (
      preservedLocationRows.rowCount !== 15
      || preservedLocationRows.rows.some((location) => location.active)
    ) {
      fail(
        'Preserved warehouse must contain exactly 15 inactive simulator/proof '
        + 'locations before consolidation',
      )
    }
    await client.query(
      `UPDATE operations_print_agents
       SET status = 'revoked',
           revoked_by = $3,
           revoked_at = now()
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND status = 'active'`,
      [
        TARGET.organizationId,
        TARGET.unusedPrintAgentGlobalId,
        config.actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_locations location
       SET code = 'RETIRED-' || location.global_id,
           notes = jsonb_build_object(
             'retirementReason', 'development_simulator_topology_retired',
             'originalCode', location.code,
             'previousNotes', location.notes
           )::text,
           updated_by = $3,
           row_version = location.row_version + 1,
           updated_at = now()
       FROM operations_warehouses warehouse
       WHERE location.organization_id = $1::uuid
         AND location.warehouse_id = warehouse.id
         AND warehouse.global_id = $2
         AND location.active = false
         AND location.code NOT LIKE 'RETIRED-%'`,
      [
        TARGET.organizationId,
        TARGET.preservedWarehouseGlobalId,
        config.actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_warehouses
       SET code = $3,
           name = $4,
           status = 'inactive',
           address = address || jsonb_build_object(
             'state', 'retired',
             'retirementReason', 'superseded_by_preserved_print_warehouse',
             'supersededBy', $5::text
           ),
           updated_by = $2,
           row_version = row_version + 1,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND global_id = $6`,
      [
        TARGET.organizationId,
        config.actorEmail,
        SOURCE_TOMBSTONE_CODE,
        SOURCE_TOMBSTONE_NAME,
        TARGET.preservedWarehouseGlobalId,
        TARGET.sourceWarehouseGlobalId,
      ],
    )
    const movedLocations = await client.query(
      `WITH target_warehouse AS (
         SELECT id
         FROM operations_warehouses
         WHERE organization_id = $1::uuid AND global_id = $3
       ),
       source_warehouse AS (
         SELECT id
         FROM operations_warehouses
         WHERE organization_id = $1::uuid AND global_id = $4
       )
       UPDATE operations_locations location
       SET warehouse_id = (SELECT id FROM target_warehouse),
           updated_by = $2,
           row_version = row_version + 1,
           updated_at = now()
       WHERE location.organization_id = $1::uuid
         AND location.warehouse_id IN (SELECT id FROM source_warehouse)
       RETURNING location.id`,
      [
        TARGET.organizationId,
        config.actorEmail,
        TARGET.preservedWarehouseGlobalId,
        TARGET.sourceWarehouseGlobalId,
      ],
    )
    if (movedLocations.rowCount !== 9) {
      fail(`Expected to move 9 real locations; moved ${movedLocations.rowCount}`)
    }
    await client.query(
      `UPDATE operations_warehouses target
       SET code = $4,
           name = $5,
           timezone = source.timezone,
           address = (
             source.address
             - 'state'
             - 'retirementReason'
             - 'supersededBy'
           ) || jsonb_build_object(
             'state', 'operational',
             'simulationState', 'retired',
             'formerScenarioKey', $6::text,
             'preservedForPrinting', true,
             'normalizedFromWarehouse', source.global_id
           ),
           status = 'active',
           cutoff_time = source.cutoff_time,
           facility_type = source.facility_type,
           operating_days = source.operating_days,
           opens_at = source.opens_at,
           closes_at = source.closes_at,
           standard_processing_minutes =
             source.standard_processing_minutes,
           daily_order_capacity = source.daily_order_capacity,
           updated_by = $2,
           row_version = target.row_version + 1,
           updated_at = now()
       FROM operations_warehouses source
       WHERE target.organization_id = $1::uuid
         AND source.organization_id = target.organization_id
         AND target.global_id = $3
         AND source.global_id = $7`,
      [
        TARGET.organizationId,
        config.actorEmail,
        TARGET.preservedWarehouseGlobalId,
        FINAL_WAREHOUSE_CODE,
        FINAL_WAREHOUSE_NAME,
        WMS_SCENARIO_KEY,
        TARGET.sourceWarehouseGlobalId,
      ],
    )
    await client.query(
      `UPDATE operations_activation_scopes
       SET state = 'read_only',
           revision = revision + 1,
           reason = 'Express Parcel warehouse normalized; writes remain disabled',
           updated_by = $2,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND state = 'frozen'`,
      [TARGET.organizationId, config.actorEmail],
    )
    await audit(
      client,
      config.actorEmail,
      'operations.development_warehouse_normalization.completed',
      {
        scriptVersion: SCRIPT_VERSION,
        activeWarehouseGlobalId: TARGET.preservedWarehouseGlobalId,
        preservedPrinterGlobalId: TARGET.preservedPrinterGlobalId,
        preservedPrintAgentGlobalId: TARGET.preservedPrintAgentGlobalId,
        retiredPrintAgentGlobalId: TARGET.unusedPrintAgentGlobalId,
        movedRealLocationCount: movedLocations.rowCount,
      },
    )
    const after = publicPlan(await readSnapshot(client, config))
    if (after.plan.phase !== 'complete') {
      fail(`Finalize postflight reached ${after.plan.phase}, not complete`)
    }
    await client.query('COMMIT')
    return {
      ok: true,
      mode: 'finalize',
      beforeDigest: before.digest,
      after: after.plan,
      afterDigest: after.digest,
      movedRealLocationCount: movedLocations.rowCount,
      printerHeartbeatAgeMinutes: numeric(heartbeat.age_minutes),
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export function wmsCleanupCommand(databaseFingerprint) {
  const expectedDatabaseFingerprint = text(databaseFingerprint).toLowerCase()
  if (!UUID_PATTERN.test(expectedDatabaseFingerprint)) {
    fail(
      'The WMS cleanup command requires the exact development database '
      + 'fingerprint from the normalization plan',
    )
  }
  return {
    environment: {
      WMS_SIM_ENV: 'development',
      WMS_SIM_ORGANIZATION_ID: TARGET.organizationId,
      WMS_SIM_PRESERVE_CONFIRM: WMS_PRESERVE_CONFIRMATION,
      WMS_SIM_EXPECTED_DATABASE_FINGERPRINT: expectedDatabaseFingerprint,
      WMS_SIM_PRESERVE_WAREHOUSE_GLOBAL_ID:
        TARGET.preservedWarehouseGlobalId,
      WMS_SIM_PRESERVE_PRINTER_GLOBAL_ID:
        TARGET.preservedPrinterGlobalId,
      WMS_SIM_PRESERVE_PRINT_AGENT_GLOBAL_ID:
        TARGET.preservedPrintAgentGlobalId,
      WMS_SIM_PRESERVE_FOREIGN_LOCATION_GLOBAL_ID:
        TARGET.proofLocationGlobalId,
      WMS_SIM_PRESERVE_FOREIGN_POOL_GLOBAL_ID:
        TARGET.proofPoolGlobalId,
      WMS_SIM_PRESERVE_FOREIGN_POSITION_GLOBAL_ID:
        TARGET.proofPositionGlobalId,
    },
    command:
      'node scripts/seed-wms-development-simulation.mjs '
      + '--cleanup-preserve-warehouse',
  }
}

export function runSelfTest() {
  assert.deepEqual(parseArguments([]), { mode: 'plan', help: false })
  assert.deepEqual(
    parseArguments(['--prepare']),
    { mode: 'prepare', help: false },
  )
  assert.deepEqual(
    parseArguments(['--finalize']),
    { mode: 'finalize', help: false },
  )
  assert.throws(
    () => parseArguments(['--prepare', '--finalize']),
    /cannot be combined/,
  )
  assert.equal(
    planDigest({ b: 2, a: 1 }),
    planDigest({ a: 1, b: 2 }),
  )
  const liveEnvironment = {
    CLAWPILOT_STORAGE: 'postgres',
    DATABASE_URL: 'postgres://example.invalid/clawpilot',
    RAILWAY_ENVIRONMENT_NAME: 'development',
    RAILWAY_PROJECT_ID: TRUSTED_RAILWAY_PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID:
      TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID,
  }
  assert.doesNotThrow(() => validateRuntimeEnvironment(liveEnvironment))
  assert.throws(
    () => validateRuntimeEnvironment({
      ...liveEnvironment,
      RAILWAY_ENVIRONMENT_ID:
        '22345678-1234-4123-8123-123456789abc',
    }),
    /trusted development environment/,
  )
  const rehearsalEnvironment = {
    CLAWPILOT_STORAGE: 'postgres',
    DATABASE_URL: 'postgres://localhost/clawpilot-rehearsal',
    EXPRESS_PARCEL_DEV_DISPOSABLE_REHEARSAL_CONFIRM:
      DISPOSABLE_REHEARSAL_CONFIRMATION,
  }
  assert.doesNotThrow(() => validateRuntimeEnvironment(rehearsalEnvironment))
  assert.throws(
    () => validateRuntimeEnvironment({
      ...rehearsalEnvironment,
      RAILWAY_ENVIRONMENT_NAME: 'development',
    }),
    /cannot run with Railway environment markers/,
  )
  const base = {
    actor: { role: 'admin', status: 'active' },
    activation: { state: 'read_only' },
    warehouses: [
      {
        globalId: TARGET.sourceWarehouseGlobalId,
        status: 'active',
        code: FINAL_WAREHOUSE_CODE,
      },
      {
        globalId: TARGET.preservedWarehouseGlobalId,
        status: 'active',
        code: 'DEV-WMS-SIM-01',
      },
      {
        globalId: TARGET.mockWarehouseGlobalId,
        status: 'active',
        code: 'MOCK-01',
      },
    ],
    locations: {
      sourceTotal: 9,
      sourceActive: 9,
      preservedTotal: 15,
      preservedActive: 15,
      mockTotal: 1,
    },
    orders: {
      wmsTotal: 21,
      wmsRetired: 0,
      wmsActiveReservations: 7,
      mockTotal: 8,
      mockProofTotal: 8,
      mockRetired: 0,
      mockActiveReservations: 7,
      mockReservedQuantity: 7,
    },
    resources: {
      disposablePrinters: 2,
      unusedAgentStatus: 'active',
      proofLocationActive: true,
      proofPoolActive: true,
      proofPositionReserved: 3,
    },
    sourceLocationDependencies: {
      locations: 9,
      positions: 0,
      rules: 0,
      pick_tasks: 0,
      receipt_lines: 0,
      replenishment_tasks: 0,
      external_children: 0,
    },
  }
  assert.equal(determinePhase(base), 'prepare')
  const wmsCleanup = structuredClone(base)
  wmsCleanup.activation.state = 'frozen'
  wmsCleanup.orders.mockRetired = 8
  wmsCleanup.orders.mockActiveReservations = 0
  wmsCleanup.resources.disposablePrinters = 0
  wmsCleanup.resources.proofLocationActive = false
  wmsCleanup.resources.proofPoolActive = false
  wmsCleanup.resources.proofPositionReserved = 0
  assert.equal(determinePhase(wmsCleanup), 'wms_cleanup')
  const ready = structuredClone(wmsCleanup)
  ready.orders.wmsRetired = 21
  ready.orders.wmsActiveReservations = 0
  ready.warehouses[1].simulationState = 'retired'
  assert.equal(determinePhase(ready), 'finalize')
  const complete = structuredClone(ready)
  complete.activation.state = 'read_only'
  complete.warehouses[0].status = 'inactive'
  complete.warehouses[0].code = SOURCE_TOMBSTONE_CODE
  complete.warehouses[1].code = FINAL_WAREHOUSE_CODE
  complete.locations.sourceTotal = 0
  complete.locations.preservedActive = 9
  complete.resources.unusedAgentStatus = 'revoked'
  complete.warehouses[2].status = 'inactive'
  assert.equal(determinePhase(complete), 'complete')
  const command = wmsCleanupCommand(
    '12345678-1234-4123-8123-123456789abc',
  )
  assert.equal(
    command.environment.WMS_SIM_PRESERVE_PRINTER_GLOBAL_ID,
    TARGET.preservedPrinterGlobalId,
  )
  assert.equal(
    command.environment.WMS_SIM_EXPECTED_DATABASE_FINGERPRINT,
    '12345678-1234-4123-8123-123456789abc',
  )
  assert.match(command.command, /--cleanup-preserve-warehouse$/)
  assert.throws(
    () => wmsCleanupCommand(''),
    /exact development database fingerprint/,
  )
  assert.throws(
    () => configurationFromEnvironment(
      { EXPRESS_PARCEL_DEV_ACTOR_EMAIL: 'admin@example.com' },
      'prepare',
    ),
    /DATABASE_FINGERPRINT/,
  )
  return {
    ok: true,
    mode: 'self-test',
    assertions: 18,
    scriptVersion: SCRIPT_VERSION,
  }
}

function printHelp() {
  console.log(`Express Parcel development warehouse normalization

Plan (read-only; this is the default):
  CLAWPILOT_STORAGE=postgres RAILWAY_ENVIRONMENT_NAME=development \\
    DATABASE_URL=<url> EXPRESS_PARCEL_DEV_ACTOR_EMAIL=<admin> \\
    node scripts/normalize-express-parcel-development-warehouse.mjs --plan

Prepare mock-proof retirement:
  Add the exact database fingerprint and plan digest printed by the immediately
  prior plan, plus:
    EXPRESS_PARCEL_DEV_CONFIRM=${PREPARE_CONFIRMATION}
  Then run with --prepare.

After prepare, run the exact WMS preserve-cleanup environment and command emitted
by this script. It includes the approved database fingerprint and the cleanup
checks that identity before opening its transaction. Then run a new --plan.

Finalize warehouse consolidation:
  Add the new exact plan digest plus:
    EXPRESS_PARCEL_DEV_CONFIRM=${FINALIZE_CONFIRMATION}
  Then run with --finalize.

Self-test:
  node scripts/normalize-express-parcel-development-warehouse.mjs --self-test

There is no production override. The tool preserves the exact Zebra
warehouse/printer/agent binding, immutable print proof, and approved FedEx/UPS
integrations. Live execution requires the trusted Railway project and
development environment IDs compiled into this one-time tool. Disposable
offline rehearsal requires a local PostgreSQL URL, no populated RAILWAY_*
marker, and:
  EXPRESS_PARCEL_DEV_DISPOSABLE_REHEARSAL_CONFIRM=${DISPOSABLE_REHEARSAL_CONFIRMATION}
It never deletes an inventory ledger row or print evidence row.`)
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args.mode === 'self-test') {
    console.log(JSON.stringify(runSelfTest(), null, 2))
    return
  }
  const config = configurationFromEnvironment(process.env, args.mode)
  validateRuntimeEnvironment(process.env)
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    ssl: process.env.PGSSLMODE === 'disable'
      ? false
      : { rejectUnauthorized: false },
  })
  try {
    const client = await pool.connect()
    try {
      const result = args.mode === 'prepare'
        ? await prepare(client, config)
        : args.mode === 'finalize'
          ? await finalize(client, config)
          : publicPlan(await readSnapshot(client, config))
      console.log(JSON.stringify(result, null, 2))
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
