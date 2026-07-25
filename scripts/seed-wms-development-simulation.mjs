#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))

const SCENARIO_KEY = 'clawpilot-wms-development-v1'
const DEFAULT_ANCHOR_DATE = '2026-07-25'
const ALLOWED_ENVIRONMENTS = new Set(['dev', 'development', 'local'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const FALSE_PERMISSIONS = Object.freeze({
  inviteUsers: false,
  manageUserAccess: false,
  createBoards: false,
  createPipelines: false,
  viewFullReleaseHistory: false,
  manageBackups: false,
  manageLinks: false,
  viewOrganizationAudit: false,
  viewSystemAudit: false,
})

function fail(message) {
  throw new Error(message)
}

function digest(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
}

function actorEmailForOrganization(organizationId) {
  const organizationKey = organizationId.replaceAll('-', '').slice(0, 12).toLowerCase()
  return `wms-simulator+${organizationKey}@clawpilot.invalid`
}

function parseArguments(argv) {
  const flags = new Set(argv)
  const unknown = argv.filter((value) => !['--cleanup', '--self-test', '--help'].includes(value))
  if (unknown.length > 0) {
    fail(`Unsupported argument(s): ${unknown.join(', ')}`)
  }
  if (flags.has('--cleanup') && flags.has('--self-test')) {
    fail('--cleanup and --self-test cannot be combined')
  }
  return {
    cleanup: flags.has('--cleanup'),
    selfTest: flags.has('--self-test'),
    help: flags.has('--help'),
  }
}

function normalizedEnvironment(value) {
  return String(value || '').trim().toLowerCase()
}

function isLocalDatabaseHost(hostname) {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized.endsWith('.localhost')
}

function validateExecutionEnvironment(environment) {
  const explicitEnvironment = normalizedEnvironment(environment.WMS_SIM_ENV)
  if (!ALLOWED_ENVIRONMENTS.has(explicitEnvironment)) {
    fail('WMS_SIM_ENV must be explicitly set to dev, development, or local')
  }

  for (const key of ['RAILWAY_ENVIRONMENT_NAME', 'VERCEL_ENV', 'CLAWPILOT_ENV']) {
    const value = normalizedEnvironment(environment[key])
    if (value && !ALLOWED_ENVIRONMENTS.has(value)) {
      fail(`${key}=${environment[key]} is not a development or local environment`)
    }
  }

  const organizationId = String(environment.WMS_SIM_ORGANIZATION_ID || '').trim()
  if (!UUID_PATTERN.test(organizationId)) {
    fail('WMS_SIM_ORGANIZATION_ID must be an explicitly supplied UUID')
  }

  const pipelineId = String(environment.WMS_SIM_PIPELINE_ID || '').trim()
  if (pipelineId && !UUID_PATTERN.test(pipelineId)) {
    fail('WMS_SIM_PIPELINE_ID must be a UUID when supplied')
  }

  const databaseUrl = String(environment.DATABASE_URL || '').trim()
  if (!databaseUrl) {
    fail('DATABASE_URL is required')
  }

  let database
  try {
    database = new URL(databaseUrl)
  } catch {
    fail('DATABASE_URL must be a valid PostgreSQL URL')
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) {
    fail('DATABASE_URL must use the postgres or postgresql protocol')
  }

  const providerEnvironment = normalizedEnvironment(
    environment.RAILWAY_ENVIRONMENT_NAME
      || environment.VERCEL_ENV
      || environment.CLAWPILOT_ENV,
  )
  if (!isLocalDatabaseHost(database.hostname) && !providerEnvironment) {
    fail(
      'A non-local DATABASE_URL requires RAILWAY_ENVIRONMENT_NAME, VERCEL_ENV, '
      + 'or CLAWPILOT_ENV to prove it is a development database',
    )
  }

  const anchorDate = String(environment.WMS_SIM_ANCHOR_DATE || DEFAULT_ANCHOR_DATE).trim()
  if (!DATE_PATTERN.test(anchorDate) || Number.isNaN(Date.parse(`${anchorDate}T00:00:00.000Z`))) {
    fail('WMS_SIM_ANCHOR_DATE must be a valid YYYY-MM-DD date')
  }

  return {
    explicitEnvironment,
    organizationId,
    pipelineId: pipelineId || null,
    databaseUrl,
    anchorDate,
  }
}

function isoAt(anchorDate, dayOffset, hour, minute = 0) {
  const value = new Date(`${anchorDate}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + dayOffset)
  value.setUTCHours(hour, minute, 0, 0)
  return value.toISOString()
}

function buildScenario(
  anchorDate = DEFAULT_ANCHOR_DATE,
  organizationId = '10000000-0000-4000-8000-000000000001',
) {
  const products = [
    {
      key: 'fast',
      sourceKey: `${SCENARIO_KEY}:product:fast`,
      sku: 'DEV-FAST-001',
      name: '[DEV WMS] Synthetic Fast Mover',
      category: 'Simulation / Forward pick',
      priceMinor: 1800,
      costMinor: 700,
      weightGrams: 420,
      dimensionsMm: { length: 210, width: 140, height: 80 },
      casePack: 12,
    },
    {
      key: 'medium',
      sourceKey: `${SCENARIO_KEY}:product:medium`,
      sku: 'DEV-MEZZ-001',
      name: '[DEV WMS] Synthetic Mezzanine Mover',
      category: 'Simulation / Mezzanine',
      priceMinor: 3200,
      costMinor: 1300,
      weightGrams: 900,
      dimensionsMm: { length: 280, width: 180, height: 120 },
      casePack: 8,
    },
    {
      key: 'slow',
      sourceKey: `${SCENARIO_KEY}:product:slow`,
      sku: 'DEV-RES-001',
      name: '[DEV WMS] Synthetic Reserve Case',
      category: 'Simulation / Reserve',
      priceMinor: 5400,
      costMinor: 2600,
      weightGrams: 2800,
      dimensionsMm: { length: 420, width: 300, height: 220 },
      casePack: 4,
    },
    {
      key: 'bulk',
      sourceKey: `${SCENARIO_KEY}:product:bulk`,
      sku: 'DEV-BULK-001',
      name: '[DEV WMS] Synthetic Oversize Kit',
      category: 'Simulation / Reserve oversize',
      priceMinor: 12500,
      costMinor: 6200,
      weightGrams: 7200,
      dimensionsMm: { length: 760, width: 460, height: 360 },
      casePack: 1,
    },
  ]

  const locations = [
    {
      code: 'BUILDING-01',
      zone: 'FACILITY',
      locationType: 'storage',
      topologyLevel: 'building',
      pickSequence: 0,
      maxVolumeCubicMeters: null,
      maxWeightKg: null,
      allowMixedProducts: true,
      parentCode: null,
      role: 'facility',
    },
    {
      code: 'RECEIVE-DOCK-01',
      zone: 'INBOUND',
      locationType: 'receiving',
      topologyLevel: 'dock',
      pickSequence: 10,
      maxVolumeCubicMeters: 160,
      maxWeightKg: 50000,
      allowMixedProducts: true,
      parentCode: 'BUILDING-01',
      role: 'receiving',
    },
    {
      code: 'STAGE-IN-01',
      zone: 'INBOUND',
      locationType: 'staging',
      topologyLevel: 'staging',
      pickSequence: 20,
      maxVolumeCubicMeters: 80,
      maxWeightKg: 25000,
      allowMixedProducts: true,
      parentCode: 'BUILDING-01',
      role: 'inbound_staging',
    },
    {
      code: 'RESERVE-ZONE',
      zone: 'RESERVE',
      locationType: 'storage',
      topologyLevel: 'zone',
      pickSequence: 100,
      maxVolumeCubicMeters: null,
      maxWeightKg: null,
      allowMixedProducts: true,
      parentCode: 'BUILDING-01',
      role: 'reserve',
    },
    {
      code: 'RES-A01-B01-L01',
      zone: 'RESERVE',
      locationType: 'storage',
      topologyLevel: 'bin',
      pickSequence: 110,
      maxVolumeCubicMeters: 72,
      maxWeightKg: 18000,
      allowMixedProducts: true,
      parentCode: 'RESERVE-ZONE',
      role: 'reserve',
    },
    {
      code: 'FORWARD-PICK-ZONE',
      zone: 'FORWARD_PICK',
      locationType: 'pick',
      topologyLevel: 'zone',
      pickSequence: 200,
      maxVolumeCubicMeters: null,
      maxWeightKg: null,
      allowMixedProducts: false,
      parentCode: 'BUILDING-01',
      role: 'forward_pick',
    },
    {
      code: 'FP-A01-B01-L01',
      zone: 'FORWARD_PICK',
      locationType: 'pick',
      topologyLevel: 'bin',
      pickSequence: 210,
      maxVolumeCubicMeters: 1.2,
      maxWeightKg: 400,
      allowMixedProducts: false,
      parentCode: 'FORWARD-PICK-ZONE',
      role: 'forward_pick',
      replenishment: {
        mode: 'min_max',
        minimum: 12,
        target: 36,
        maximum: 48,
        source: 'RES-A01-B01-L01',
      },
    },
    {
      code: 'MEZZ-PICK-ZONE',
      zone: 'MEZZANINE',
      locationType: 'pick',
      topologyLevel: 'zone',
      pickSequence: 300,
      maxVolumeCubicMeters: null,
      maxWeightKg: null,
      allowMixedProducts: false,
      parentCode: 'BUILDING-01',
      role: 'mezzanine_pick',
    },
    {
      code: 'MZ-M01-B01-L01',
      zone: 'MEZZANINE',
      locationType: 'pick',
      topologyLevel: 'bin',
      pickSequence: 310,
      maxVolumeCubicMeters: 2.4,
      maxWeightKg: 750,
      allowMixedProducts: false,
      parentCode: 'MEZZ-PICK-ZONE',
      role: 'mezzanine_pick',
      replenishment: {
        mode: 'order_demand',
        minimum: 8,
        target: 18,
        maximum: 32,
        source: 'RES-A01-B01-L01',
      },
    },
    {
      code: 'REPLEN-STAGE-01',
      zone: 'REPLENISHMENT',
      locationType: 'staging',
      topologyLevel: 'staging',
      pickSequence: 400,
      maxVolumeCubicMeters: 24,
      maxWeightKg: 8000,
      allowMixedProducts: true,
      parentCode: 'BUILDING-01',
      role: 'replenishment_staging',
    },
    {
      code: 'PACK-01',
      zone: 'OUTBOUND',
      locationType: 'pack',
      topologyLevel: 'station',
      pickSequence: 500,
      maxVolumeCubicMeters: 8,
      maxWeightKg: 1500,
      allowMixedProducts: true,
      parentCode: 'BUILDING-01',
      role: 'pack',
    },
    {
      code: 'SHIP-DOCK-UPS',
      zone: 'OUTBOUND',
      locationType: 'shipping',
      topologyLevel: 'dock',
      pickSequence: 600,
      maxVolumeCubicMeters: 90,
      maxWeightKg: 30000,
      allowMixedProducts: true,
      parentCode: 'BUILDING-01',
      role: 'carrier_dock',
      carrier: 'UPS',
      cutoff: '21:00',
    },
    {
      code: 'SHIP-DOCK-FDX',
      zone: 'OUTBOUND',
      locationType: 'shipping',
      topologyLevel: 'dock',
      pickSequence: 610,
      maxVolumeCubicMeters: 90,
      maxWeightKg: 30000,
      allowMixedProducts: true,
      parentCode: 'BUILDING-01',
      role: 'carrier_dock',
      carrier: 'FEDEX',
      cutoff: '21:00',
    },
    {
      code: 'RETURNS-01',
      zone: 'RETURNS',
      locationType: 'returns',
      topologyLevel: 'staging',
      pickSequence: 700,
      maxVolumeCubicMeters: 30,
      maxWeightKg: 9000,
      allowMixedProducts: true,
      parentCode: 'BUILDING-01',
      role: 'returns',
    },
  ]

  const patterns = [
    [['fast', 8], ['medium', 2]],
    [['fast', 10]],
    [['fast', 12], ['medium', 4]],
    [['medium', 6], ['slow', 2]],
    [['fast', 7], ['bulk', 1]],
    [['fast', 5], ['medium', 3], ['slow', 1]],
    [['fast', 9], ['medium', 2]],
  ]
  const productByKey = new Map(products.map((product) => [product.key, product]))
  const orders = Array.from({ length: 21 }, (_, index) => {
    const dayOffset = -6 + Math.floor(index / 3)
    const orderSequence = (index % 3) + 1
    const date = isoAt(anchorDate, dayOffset, 14)
    const dateKey = date.slice(0, 10).replaceAll('-', '')
    const lines = patterns[index % patterns.length].map(([productKey, quantity], lineIndex) => {
      const product = productByKey.get(productKey)
      return {
        externalLineId: `LINE-${lineIndex + 1}`,
        productKey,
        quantity,
        unitPriceMinor: product.priceMinor,
        weightGrams: product.weightGrams,
        dimensionsMm: product.dimensionsMm,
      }
    })
    return {
      externalOrderId: `WMS-SIM-${dateKey}-${String(orderSequence).padStart(2, '0')}`,
      orderNumber: `DEV-${dateKey}-${String(orderSequence).padStart(2, '0')}`,
      importedAt: isoAt(anchorDate, dayOffset, 14, orderSequence * 5),
      requestedDeliveryAt: isoAt(anchorDate, dayOffset + 3, 20),
      promisedDeliveryAt: isoAt(anchorDate, dayOffset + 3, 20),
      releaseForExecution: index < 4,
      demandClass: index < 4 ? 'released_replenishment_pressure' : 'future_demand',
      lines,
    }
  })

  return {
    scenarioKey: SCENARIO_KEY,
    anchorDate,
    actor: {
      email: actorEmailForOrganization(organizationId),
      displayName: 'WMS Development Simulator',
      jobTitle: 'Synthetic warehouse operator',
    },
    customer: {
      sourceKey: `${SCENARIO_KEY}:customer`,
      identityKey: `customer:synthetic:${SCENARIO_KEY}`,
      name: '[DEV WMS] Northstar Test Commerce LLC',
    },
    warehouse: {
      code: 'DEV-WMS-SIM-01',
      name: 'Jegs Place Development Simulation',
      facilityType: 'distribution_center',
      timezone: 'America/New_York',
      cutoff: '21:00',
      operatingDays: [1, 2, 3, 4, 5, 6],
      opensAt: '06:00',
      closesAt: '23:00',
      standardProcessingMinutes: 90,
      dailyOrderCapacity: 1200,
      address: {
        line1: '101 Jegs Place',
        city: 'Delaware',
        state: 'OH',
        postalCode: '43015',
        country: 'US',
      },
      carrierCutoffs: { UPS: '21:00', FEDEX: '21:00' },
    },
    locations,
    products,
    positions: [
      { productKey: 'fast', locationCode: 'RES-A01-B01-L01', quantity: 480 },
      { productKey: 'fast', locationCode: 'FP-A01-B01-L01', quantity: 36 },
      { productKey: 'medium', locationCode: 'RES-A01-B01-L01', quantity: 240 },
      { productKey: 'medium', locationCode: 'MZ-M01-B01-L01', quantity: 18 },
      { productKey: 'slow', locationCode: 'RES-A01-B01-L01', quantity: 120 },
      { productKey: 'bulk', locationCode: 'RES-A01-B01-L01', quantity: 32 },
    ],
    placementRules: [
      { productKey: 'fast', locationCode: 'FP-A01-B01-L01', ruleType: 'preferred', maximum: 48 },
      { productKey: 'fast', locationCode: 'RES-A01-B01-L01', ruleType: 'allowed', maximum: 480 },
      { productKey: 'medium', locationCode: 'MZ-M01-B01-L01', ruleType: 'preferred', maximum: 32 },
      { productKey: 'medium', locationCode: 'RES-A01-B01-L01', ruleType: 'allowed', maximum: 240 },
      { productKey: 'slow', locationCode: 'RES-A01-B01-L01', ruleType: 'preferred', maximum: 120 },
      { productKey: 'bulk', locationCode: 'RES-A01-B01-L01', ruleType: 'preferred', maximum: 32 },
    ],
    executionPositionByProduct: {
      fast: 'FP-A01-B01-L01',
      medium: 'MZ-M01-B01-L01',
      slow: 'RES-A01-B01-L01',
      bulk: 'RES-A01-B01-L01',
    },
    orders,
  }
}

async function requireSchema(client) {
  const requiredTables = [
    'app_users',
    'app_user_organization_memberships',
    'workspace_organizations',
    'pipeline_spaces',
    'crm_organizations',
    'crm_products',
    'operations_integration_accounts',
    'operations_warehouses',
    'operations_locations',
    'operations_location_product_rules',
    'operations_inventory_pools',
    'operations_inventory_pool_customers',
    'operations_inventory_positions',
    'operations_inventory_ledger',
    'operations_orders',
    'operations_order_lines',
    'operations_reservations',
    'operations_fulfillment_plans',
    'operations_fulfillment_allocations',
    'operations_carton_plans',
    'operations_packages',
    'operations_waves',
    'operations_pick_tasks',
  ]
  const result = await client.query(
    `SELECT name, to_regclass(name) IS NOT NULL AS present
     FROM unnest($1::text[]) AS name`,
    [requiredTables],
  )
  const missing = result.rows.filter((row) => !row.present).map((row) => row.name)
  if (missing.length > 0) {
    fail(`Required Operations schema is missing: ${missing.join(', ')}`)
  }
}

async function resolveScope(client, configuration) {
  const organizationResult = await client.query(
    `SELECT id::text, name
     FROM workspace_organizations
     WHERE id = $1::uuid
     FOR UPDATE`,
    [configuration.organizationId],
  )
  if (organizationResult.rowCount !== 1) {
    fail(`Organization ${configuration.organizationId} does not exist`)
  }

  const pipelineResult = await client.query(
    `SELECT id::text, name
     FROM pipeline_spaces
     WHERE workspace_organization_id = $1::uuid
       AND ($2::uuid IS NULL OR id = $2::uuid)
     ORDER BY is_default DESC, updated_at DESC, id
     LIMIT 1
     FOR UPDATE`,
    [configuration.organizationId, configuration.pipelineId],
  )
  if (pipelineResult.rowCount !== 1) {
    fail(
      configuration.pipelineId
        ? `Pipeline ${configuration.pipelineId} does not belong to the supplied organization`
        : 'The supplied organization has no pipeline; create one or provide WMS_SIM_PIPELINE_ID',
    )
  }
  return {
    organizationId: organizationResult.rows[0].id,
    organizationName: organizationResult.rows[0].name,
    pipelineId: pipelineResult.rows[0].id,
    pipelineName: pipelineResult.rows[0].name,
  }
}

async function upsertActor(client, scope, scenario) {
  await client.query(
    `INSERT INTO app_users (
       email, role, status, display_name, job_title, timezone, locale,
       permissions, organization_id, organization_name, crm_user_enabled,
       reference_code, invited_at, activated_at, updated_at
     )
     VALUES (
       $1, 'member', 'disabled', $2, $3, 'America/New_York', 'en-US',
       $4::jsonb, $5::uuid, $6, false, NULL, now(), NULL, now()
     )
     ON CONFLICT (email) DO UPDATE SET
       role = 'member',
       status = 'disabled',
       display_name = EXCLUDED.display_name,
       job_title = EXCLUDED.job_title,
       timezone = EXCLUDED.timezone,
       locale = EXCLUDED.locale,
       permissions = EXCLUDED.permissions,
       organization_id = EXCLUDED.organization_id,
       organization_name = EXCLUDED.organization_name,
       crm_user_enabled = false,
       reference_code = NULL,
       suitecrm_user_id = NULL,
       suitecrm_username = NULL,
       activated_at = NULL,
       updated_at = now()`,
    [
      scenario.actor.email,
      scenario.actor.displayName,
      scenario.actor.jobTitle,
      JSON.stringify(FALSE_PERMISSIONS),
      scope.organizationId,
      scope.organizationName,
    ],
  )
  await client.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by, updated_at
     )
     VALUES ($1, $2::uuid, 'member', $3::jsonb, 'disabled', false, $1, $1, now())
     ON CONFLICT (user_email, organization_id) DO UPDATE SET
       role = 'member',
       permissions = EXCLUDED.permissions,
       status = 'disabled',
       is_default = false,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [scenario.actor.email, scope.organizationId, JSON.stringify(FALSE_PERMISSIONS)],
  )
}

async function upsertSyntheticCustomer(client, scope, scenario) {
  const payload = {
    scenarioKey: scenario.scenarioKey,
    synthetic: true,
    nonDeliverable: true,
    state: 'active',
  }
  const result = await client.query(
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, identity_key, priority, name, account_type,
       account_manager, description, source_payload, source_hash, sync_status,
       sync_error, created_by, updated_by, workspace_organization_id,
       relationship_type, email, email_opt_out, updated_at
     )
     VALUES (
       $1::uuid, $2, $3, 'D', $4, 'Synthetic test customer', $5, $6,
       $7::jsonb, $8, 'synced', NULL, $5, $5, NULL, 'customer', NULL, true, now()
     )
     ON CONFLICT (pipeline_id, source_key) DO UPDATE SET
       identity_key = EXCLUDED.identity_key,
       priority = EXCLUDED.priority,
       name = EXCLUDED.name,
       account_type = EXCLUDED.account_type,
       account_manager = EXCLUDED.account_manager,
       description = EXCLUDED.description,
       source_payload = EXCLUDED.source_payload,
       source_hash = EXCLUDED.source_hash,
       sync_status = 'synced',
       sync_error = NULL,
       updated_by = EXCLUDED.updated_by,
       email = NULL,
       email_opt_out = true,
       updated_at = now()
     RETURNING id::text, reference_code`,
    [
      scope.pipelineId,
      scenario.customer.sourceKey,
      scenario.customer.identityKey,
      scenario.customer.name,
      scenario.actor.email,
      'Development-only synthetic WMS demand owner. Never synchronize or contact.',
      JSON.stringify(payload),
      digest(payload),
    ],
  )
  return result.rows[0]
}

async function upsertProducts(client, scope, scenario) {
  const result = new Map()
  for (const product of scenario.products) {
    const payload = {
      scenarioKey: scenario.scenarioKey,
      synthetic: true,
      dimensionsMm: product.dimensionsMm,
      weightGrams: product.weightGrams,
      casePack: product.casePack,
      unitOfMeasure: 'each',
    }
    const query = await client.query(
      `INSERT INTO crm_products (
         pipeline_id, source_key, name, sku, product_type, category, status,
         price, cost, currency, description, active, source_payload, source_hash,
         sync_status, sync_error, created_by, updated_by, updated_at
       )
       VALUES (
         $1::uuid, $2, $3, $4, 'Good', $5, 'Active',
         $6::numeric / 100, $7::numeric / 100, 'USD', $8, true,
         $9::jsonb, $10, 'synced', NULL, $11, $11, now()
       )
       ON CONFLICT (pipeline_id, source_key) DO UPDATE SET
         name = EXCLUDED.name,
         sku = EXCLUDED.sku,
         category = EXCLUDED.category,
         status = 'Active',
         price = EXCLUDED.price,
         cost = EXCLUDED.cost,
         description = EXCLUDED.description,
         active = true,
         source_payload = EXCLUDED.source_payload,
         source_hash = EXCLUDED.source_hash,
         sync_status = 'synced',
         sync_error = NULL,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING id::text, reference_code`,
      [
        scope.pipelineId,
        product.sourceKey,
        product.name,
        product.sku,
        product.category,
        product.priceMinor,
        product.costMinor,
        'Synthetic development product. Not for commerce, billing, or shipment.',
        JSON.stringify(payload),
        digest(payload),
        scenario.actor.email,
      ],
    )
    result.set(product.key, { ...product, ...query.rows[0] })
  }
  return result
}

async function upsertIntegration(client, scope, scenario) {
  const configuration = {
    scenarioKey: scenario.scenarioKey,
    synthetic: true,
    outboundNetworkEnabled: false,
    credentialsPermitted: false,
  }
  const result = await client.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment, display_name,
       status, configuration, credential_reference, created_by, updated_by, updated_at
     )
     VALUES (
       $1::uuid, 'wms_development_simulator', 'commerce', 'mock',
       'WMS Development Simulator', 'active', $2::jsonb, NULL, $3, $3, now()
     )
     ON CONFLICT (organization_id, integration_type, provider, environment) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       status = 'active',
       configuration = EXCLUDED.configuration,
       credential_reference = NULL,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING id::text, global_id`,
    [scope.organizationId, JSON.stringify(configuration), scenario.actor.email],
  )
  return result.rows[0]
}

async function upsertWarehouse(client, scope, scenario) {
  const address = {
    ...scenario.warehouse.address,
    scenarioKey: scenario.scenarioKey,
    synthetic: true,
    carrierCutoffs: scenario.warehouse.carrierCutoffs,
  }
  const result = await client.query(
    `INSERT INTO operations_warehouses (
       organization_id, code, name, timezone, address, status, cutoff_time,
       carrier_cutoffs, facility_type, operating_days, opens_at, closes_at,
       standard_processing_minutes, daily_order_capacity,
       created_by, updated_by, updated_at
     )
     VALUES (
       $1::uuid, $2, $3, $4, $5::jsonb, 'active', $6::time, $7::jsonb, $8,
       $9::smallint[], $10::time, $11::time, $12, $13, $14, $14, now()
     )
     ON CONFLICT (organization_id, code) DO UPDATE SET
       name = EXCLUDED.name,
       timezone = EXCLUDED.timezone,
       address = EXCLUDED.address,
       status = 'active',
       cutoff_time = EXCLUDED.cutoff_time,
       carrier_cutoffs = EXCLUDED.carrier_cutoffs,
       facility_type = EXCLUDED.facility_type,
       operating_days = EXCLUDED.operating_days,
       opens_at = EXCLUDED.opens_at,
       closes_at = EXCLUDED.closes_at,
       standard_processing_minutes = EXCLUDED.standard_processing_minutes,
       daily_order_capacity = EXCLUDED.daily_order_capacity,
       updated_by = EXCLUDED.updated_by,
       row_version = operations_warehouses.row_version + 1,
       updated_at = now()
     RETURNING id::text, global_id`,
    [
      scope.organizationId,
      scenario.warehouse.code,
      scenario.warehouse.name,
      scenario.warehouse.timezone,
      JSON.stringify(address),
      scenario.warehouse.cutoff,
      JSON.stringify(scenario.warehouse.carrierCutoffs),
      scenario.warehouse.facilityType,
      scenario.warehouse.operatingDays,
      scenario.warehouse.opensAt,
      scenario.warehouse.closesAt,
      scenario.warehouse.standardProcessingMinutes,
      scenario.warehouse.dailyOrderCapacity,
      scenario.actor.email,
    ],
  )
  return result.rows[0]
}

async function upsertLocations(client, scope, scenario, warehouse) {
  const locations = new Map()
  for (const location of scenario.locations) {
    const parent = location.parentCode ? locations.get(location.parentCode) : null
    if (location.parentCode && !parent) {
      fail(`Location ${location.code} references missing parent ${location.parentCode}`)
    }
    const notes = {
      scenarioKey: scenario.scenarioKey,
      synthetic: true,
      storageRole: location.role,
      replenishment: location.replenishment || null,
      carrier: location.carrier || null,
      carrierCutoffLocal: location.cutoff || null,
      pickSequenceMeaning: 'Ascending travel sequence within this synthetic facility',
    }
    const storageFunction = {
      reserve: 'reserve',
      forward_pick: 'forward_pick',
      mezzanine_pick: 'mezzanine_pick',
      inbound_staging: 'staging',
      replenishment_staging: 'staging',
    }[location.role] || 'work_area'
    const result = await client.query(
      `INSERT INTO operations_locations (
         organization_id, warehouse_id, code, zone, location_type, pick_sequence,
         active, parent_location_id, topology_level, storage_function,
         max_volume_cubic_meters, max_weight_kg, allow_mixed_products, notes,
         created_by, updated_by, updated_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, true, $7::uuid, $8,
         $9, $10, $11, $12, $13, $14, $14, now()
       )
       ON CONFLICT (organization_id, warehouse_id, code) DO UPDATE SET
         zone = EXCLUDED.zone,
         location_type = EXCLUDED.location_type,
         pick_sequence = EXCLUDED.pick_sequence,
         active = true,
         parent_location_id = EXCLUDED.parent_location_id,
         topology_level = EXCLUDED.topology_level,
         storage_function = EXCLUDED.storage_function,
         max_volume_cubic_meters = EXCLUDED.max_volume_cubic_meters,
         max_weight_kg = EXCLUDED.max_weight_kg,
         allow_mixed_products = EXCLUDED.allow_mixed_products,
         notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by,
         row_version = operations_locations.row_version + 1,
         updated_at = now()
       RETURNING id::text, global_id`,
      [
        scope.organizationId,
        warehouse.id,
        location.code,
        location.zone,
        location.locationType,
        location.pickSequence,
        parent?.id || null,
        location.topologyLevel,
        storageFunction,
        location.maxVolumeCubicMeters,
        location.maxWeightKg,
        location.allowMixedProducts,
        JSON.stringify(notes),
        scenario.actor.email,
      ],
    )
    locations.set(location.code, { ...location, ...result.rows[0] })
  }
  return locations
}

async function upsertInventoryPool(client, scope, scenario, customer) {
  const result = await client.query(
    `INSERT INTO operations_inventory_pools (
       organization_id, pipeline_id, owner_customer_id, name, pool_type,
       allocation_policy, active, created_by, updated_at
     )
     VALUES (
       $1::uuid, $2::uuid, NULL, '[DEV WMS] Shared Simulation Pool',
       'shared', 'priority', true, $3, now()
     )
     ON CONFLICT (organization_id, name) DO UPDATE SET
       pipeline_id = EXCLUDED.pipeline_id,
       owner_customer_id = NULL,
       pool_type = 'shared',
       allocation_policy = 'priority',
       active = true,
       updated_at = now()
     RETURNING id::text, global_id`,
    [scope.organizationId, scope.pipelineId, scenario.actor.email],
  )
  const pool = result.rows[0]
  await client.query(
    `INSERT INTO operations_inventory_pool_customers (
       organization_id, pool_id, pipeline_id, customer_id, priority,
       effective_from, effective_to, approved_by
     )
     VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 10,
       $5::timestamptz, NULL, $6
     )
     ON CONFLICT (pool_id, customer_id, effective_from) DO UPDATE SET
       priority = 10,
       effective_to = NULL,
       approved_by = EXCLUDED.approved_by`,
    [
      scope.organizationId,
      pool.id,
      scope.pipelineId,
      customer.id,
      `${scenario.anchorDate}T00:00:00.000Z`,
      scenario.actor.email,
    ],
  )
  return pool
}

async function upsertProductMappings(client, scope, scenario, integration, products) {
  for (const product of products.values()) {
    await client.query(
      `INSERT INTO operations_product_mappings (
         organization_id, integration_account_id, pipeline_id, product_id,
         channel_sku, external_product_id, active, created_by, updated_at
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, true, $7, now())
       ON CONFLICT (organization_id, integration_account_id, channel_sku) DO UPDATE SET
         pipeline_id = EXCLUDED.pipeline_id,
         product_id = EXCLUDED.product_id,
         external_product_id = EXCLUDED.external_product_id,
         active = true,
         updated_at = now()`,
      [
        scope.organizationId,
        integration.id,
        scope.pipelineId,
        product.id,
        product.sku,
        `${scenario.scenarioKey}:${product.key}`,
        scenario.actor.email,
      ],
    )
  }
}

async function upsertPlacementRules(client, scope, scenario, locations, products) {
  for (const rule of scenario.placementRules) {
    const replenishment = locations.get(rule.locationCode).replenishment || null
    const sourceLocation = replenishment ? locations.get(replenishment.source) : null
    await client.query(
      `INSERT INTO operations_location_product_rules (
         organization_id, pipeline_id, location_id, product_id, rule_type,
         max_quantity, replenishment_mode, replenishment_source_location_id,
         min_quantity, target_quantity, active, created_by, updated_by, updated_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid,
         $9, $10, true, $11, $11, now()
       )
       ON CONFLICT (organization_id, location_id, product_id) DO UPDATE SET
         rule_type = EXCLUDED.rule_type,
         max_quantity = EXCLUDED.max_quantity,
         replenishment_mode = EXCLUDED.replenishment_mode,
         replenishment_source_location_id = EXCLUDED.replenishment_source_location_id,
         min_quantity = EXCLUDED.min_quantity,
         target_quantity = EXCLUDED.target_quantity,
         active = true,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        scope.organizationId,
        scope.pipelineId,
        locations.get(rule.locationCode).id,
        products.get(rule.productKey).id,
        rule.ruleType,
        rule.maximum,
        replenishment?.mode || 'disabled',
        sourceLocation?.id || null,
        replenishment?.minimum ?? null,
        replenishment?.target ?? null,
        scenario.actor.email,
      ],
    )
  }
}

async function upsertPositions(client, scope, scenario, warehouse, locations, pool, products) {
  const positions = new Map()
  for (const fixture of scenario.positions) {
    const location = locations.get(fixture.locationCode)
    const product = products.get(fixture.productKey)
    const inserted = await client.query(
      `INSERT INTO operations_inventory_positions (
         organization_id, pipeline_id, warehouse_id, location_id, pool_id,
         product_id, lot_code, on_hand_quantity, reserved_quantity,
         damaged_quantity, version, updated_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7, $8, 0, 0, 0, now()
       )
       ON CONFLICT (
         organization_id, warehouse_id, location_id, pool_id, product_id, lot_code
       ) DO NOTHING
       RETURNING id::text, global_id, on_hand_quantity, reserved_quantity, damaged_quantity`,
      [
        scope.organizationId,
        scope.pipelineId,
        warehouse.id,
        location.id,
        pool.id,
        product.id,
        `${scenario.scenarioKey}:LOT-01`,
        fixture.quantity,
      ],
    )
    let position = inserted.rows[0]
    if (position) {
      await client.query(
        `INSERT INTO operations_inventory_ledger (
           organization_id, position_id, event_type, on_hand_delta,
           reserved_delta, damaged_delta, on_hand_after, reserved_after,
           damaged_after, source_global_id, reason, idempotency_key,
           actor_email, occurred_at
         )
         VALUES (
           $1::uuid, $2::uuid, 'opening_balance', $3, 0, 0, $3, 0, 0,
           $4, $5, $6, $7, $8::timestamptz
         )
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
        [
          scope.organizationId,
          position.id,
          fixture.quantity,
          position.global_id,
          `${scenario.scenarioKey} synthetic opening balance`,
          `${scenario.scenarioKey}:opening:${fixture.productKey}:${fixture.locationCode}`,
          scenario.actor.email,
          `${scenario.anchorDate}T06:00:00.000Z`,
        ],
      )
    } else {
      const existing = await client.query(
        `SELECT id::text, global_id, on_hand_quantity, reserved_quantity, damaged_quantity
         FROM operations_inventory_positions
         WHERE organization_id = $1::uuid
           AND warehouse_id = $2::uuid
           AND location_id = $3::uuid
           AND pool_id = $4::uuid
           AND product_id = $5::uuid
           AND lot_code = $6
         FOR UPDATE`,
        [
          scope.organizationId,
          warehouse.id,
          location.id,
          pool.id,
          product.id,
          `${scenario.scenarioKey}:LOT-01`,
        ],
      )
      position = existing.rows[0]
    }
    positions.set(`${fixture.productKey}:${fixture.locationCode}`, {
      ...position,
      productKey: fixture.productKey,
      locationCode: fixture.locationCode,
    })
  }
  return positions
}

async function upsertOrder(client, scope, scenario, integration, customer, products, fixture) {
  const merchandiseTotalMinor = fixture.lines.reduce(
    (sum, line) => sum + (line.quantity * line.unitPriceMinor),
    0,
  )
  const shipTo = {
    name: 'John Doe',
    company: 'Synthetic Receiver',
    email: 'john.doe@clawpilot.invalid',
    phone: '555-0100',
    line1: '101 Academy Drive',
    city: 'Buzzards Bay',
    state: 'MA',
    postalCode: '02532',
    country: 'US',
    synthetic: true,
  }
  const sourcePayload = {
    scenarioKey: scenario.scenarioKey,
    synthetic: true,
    demandClass: fixture.demandClass,
    labelsPermitted: false,
    pickupsPermitted: false,
  }
  const orderResult = await client.query(
    `INSERT INTO operations_orders (
       organization_id, pipeline_id, customer_id, integration_account_id,
       source_provider, external_order_id, order_number, order_type, status,
       currency, merchandise_total_minor, requested_delivery_at,
       promised_delivery_at, ship_to, source_payload, imported_at,
       created_by, updated_by, updated_at
     )
     VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'wms_development_simulator',
       $5, $6, 'standard', $7, 'USD', $8, $9::timestamptz,
       $10::timestamptz, $11::jsonb, $12::jsonb, $13::timestamptz,
       $14, $14, now()
     )
     ON CONFLICT (organization_id, integration_account_id, external_order_id) DO UPDATE SET
       customer_id = EXCLUDED.customer_id,
       pipeline_id = EXCLUDED.pipeline_id,
       order_number = EXCLUDED.order_number,
       status = EXCLUDED.status,
       merchandise_total_minor = EXCLUDED.merchandise_total_minor,
       requested_delivery_at = EXCLUDED.requested_delivery_at,
       promised_delivery_at = EXCLUDED.promised_delivery_at,
       ship_to = EXCLUDED.ship_to,
       source_payload = EXCLUDED.source_payload,
       imported_at = EXCLUDED.imported_at,
       updated_by = EXCLUDED.updated_by,
       row_version = operations_orders.row_version + 1,
       updated_at = now()
     RETURNING id::text, global_id`,
    [
      scope.organizationId,
      scope.pipelineId,
      customer.id,
      integration.id,
      fixture.externalOrderId,
      fixture.orderNumber,
      fixture.releaseForExecution ? 'released' : 'validated',
      merchandiseTotalMinor,
      fixture.requestedDeliveryAt,
      fixture.promisedDeliveryAt,
      JSON.stringify(shipTo),
      JSON.stringify(sourcePayload),
      fixture.importedAt,
      scenario.actor.email,
    ],
  )
  const order = { ...fixture, ...orderResult.rows[0], merchandiseTotalMinor }
  order.persistedLines = []
  for (const line of fixture.lines) {
    const product = products.get(line.productKey)
    const lineResult = await client.query(
      `INSERT INTO operations_order_lines (
         organization_id, order_id, pipeline_id, product_id, external_line_id,
         channel_sku, description, quantity, unit_price_minor, weight_grams,
         dimensions_mm
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11::jsonb
       )
       ON CONFLICT (order_id, external_line_id) DO UPDATE SET
         pipeline_id = EXCLUDED.pipeline_id,
         product_id = EXCLUDED.product_id,
         channel_sku = EXCLUDED.channel_sku,
         description = EXCLUDED.description,
         quantity = EXCLUDED.quantity,
         unit_price_minor = EXCLUDED.unit_price_minor,
         weight_grams = EXCLUDED.weight_grams,
         dimensions_mm = EXCLUDED.dimensions_mm
       RETURNING id::text, global_id`,
      [
        scope.organizationId,
        order.id,
        scope.pipelineId,
        product.id,
        line.externalLineId,
        product.sku,
        product.name,
        line.quantity,
        line.unitPriceMinor,
        line.weightGrams,
        JSON.stringify(line.dimensionsMm),
      ],
    )
    order.persistedLines.push({ ...line, ...lineResult.rows[0], product })
  }
  return order
}

async function activateReservation(client, scope, scenario, order, line, position) {
  const idempotencyKey = `${scenario.scenarioKey}:reservation:${order.externalOrderId}:${line.externalLineId}`
  const existing = await client.query(
    `SELECT id::text, global_id, status, quantity
     FROM operations_reservations
     WHERE organization_id = $1::uuid
       AND idempotency_key = $2
     FOR UPDATE`,
    [scope.organizationId, idempotencyKey],
  )
  if (existing.rowCount === 1 && existing.rows[0].status === 'active') {
    return existing.rows[0]
  }
  if (existing.rowCount === 1 && existing.rows[0].status === 'consumed') {
    fail(`Cannot reactivate consumed simulation reservation ${existing.rows[0].global_id}`)
  }

  const lockedPosition = await client.query(
    `SELECT id::text, global_id, on_hand_quantity, reserved_quantity, damaged_quantity
     FROM operations_inventory_positions
     WHERE organization_id = $1::uuid AND id = $2::uuid
     FOR UPDATE`,
    [scope.organizationId, position.id],
  )
  const balance = lockedPosition.rows[0]
  const available = Number(balance.on_hand_quantity)
    - Number(balance.reserved_quantity)
    - Number(balance.damaged_quantity)
  if (available < line.quantity) {
    fail(
      `Synthetic position ${balance.global_id} has ${available} available; `
      + `${line.quantity} is required for ${order.externalOrderId}`,
    )
  }

  let reservation
  if (existing.rowCount === 0) {
    const inserted = await client.query(
      `INSERT INTO operations_reservations (
         organization_id, order_id, order_line_id, position_id, quantity,
         status, idempotency_key, expires_at, created_by
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'active', $6,
         $7::timestamptz, $8
       )
       RETURNING id::text, global_id, status, quantity`,
      [
        scope.organizationId,
        order.id,
        line.id,
        position.id,
        line.quantity,
        idempotencyKey,
        order.promisedDeliveryAt,
        scenario.actor.email,
      ],
    )
    reservation = inserted.rows[0]
  } else {
    const reactivated = await client.query(
      `UPDATE operations_reservations
       SET status = 'active',
           quantity = $3,
           expires_at = $4::timestamptz,
           released_at = NULL
       WHERE organization_id = $1::uuid AND id = $2::uuid
       RETURNING id::text, global_id, status, quantity`,
      [
        scope.organizationId,
        existing.rows[0].id,
        line.quantity,
        order.promisedDeliveryAt,
      ],
    )
    reservation = reactivated.rows[0]
  }

  const updatedPosition = await client.query(
    `UPDATE operations_inventory_positions
     SET reserved_quantity = reserved_quantity + $3,
         version = version + 1,
         updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid
     RETURNING on_hand_quantity, reserved_quantity, damaged_quantity`,
    [scope.organizationId, position.id, line.quantity],
  )
  const cycleResult = await client.query(
    `SELECT count(*)::integer AS cycle
     FROM operations_inventory_ledger
     WHERE organization_id = $1::uuid
       AND source_global_id = $2
       AND event_type = 'reservation'`,
    [scope.organizationId, reservation.global_id],
  )
  const cycle = Number(cycleResult.rows[0].cycle) + 1
  const after = updatedPosition.rows[0]
  await client.query(
    `INSERT INTO operations_inventory_ledger (
       organization_id, position_id, event_type, on_hand_delta,
       reserved_delta, damaged_delta, on_hand_after, reserved_after,
       damaged_after, source_global_id, reason, idempotency_key,
       actor_email, occurred_at
     )
     VALUES (
       $1::uuid, $2::uuid, 'reservation', 0, $3, 0, $4, $5, $6,
       $7, $8, $9, $10, $11::timestamptz
     )`,
    [
      scope.organizationId,
      position.id,
      line.quantity,
      after.on_hand_quantity,
      after.reserved_quantity,
      after.damaged_quantity,
      reservation.global_id,
      `${scenario.scenarioKey} synthetic released-order reservation`,
      `${scenario.scenarioKey}:reserve:${reservation.global_id}:cycle:${cycle}`,
      scenario.actor.email,
      order.importedAt,
    ],
  )
  return reservation
}

async function upsertPlanAndPackage(client, scope, scenario, warehouse, order) {
  const totalWeight = order.persistedLines.reduce(
    (sum, line) => sum + (line.weightGrams * line.quantity),
    500,
  )
  const costMinor = 850 + Math.round(totalWeight / 120)
  const revenueMinor = costMinor + 650
  const explanation = {
    scenarioKey: scenario.scenarioKey,
    synthetic: true,
    method: 'deterministic_fallback',
    storagePath: ['reserve', 'forward-pick', 'mezzanine', 'pack'],
    carrierCutoffsLocal: scenario.warehouse.carrierCutoffs,
    carrierTransactionsPermitted: false,
  }
  const planResult = await client.query(
    `INSERT INTO operations_fulfillment_plans (
       organization_id, order_id, warehouse_id, version_number, status, method,
       solver_status, fallback_reason, estimated_cost_minor,
       estimated_revenue_minor, estimated_margin_minor, promised_delivery_at,
       explanation, created_by, updated_at
     )
     VALUES (
       $1::uuid, $2::uuid, $3::uuid, 1, 'released',
       'deterministic_fallback', 'simulation', 'Development fixture',
       $4, $5, $6, $7::timestamptz, $8::jsonb, $9, now()
     )
     ON CONFLICT (order_id, version_number) DO UPDATE SET
       warehouse_id = EXCLUDED.warehouse_id,
       status = 'released',
       method = EXCLUDED.method,
       solver_status = EXCLUDED.solver_status,
       fallback_reason = EXCLUDED.fallback_reason,
       estimated_cost_minor = EXCLUDED.estimated_cost_minor,
       estimated_revenue_minor = EXCLUDED.estimated_revenue_minor,
       estimated_margin_minor = EXCLUDED.estimated_margin_minor,
       promised_delivery_at = EXCLUDED.promised_delivery_at,
       explanation = EXCLUDED.explanation,
       updated_at = now()
     RETURNING id::text, global_id`,
    [
      scope.organizationId,
      order.id,
      warehouse.id,
      costMinor,
      revenueMinor,
      revenueMinor - costMinor,
      order.promisedDeliveryAt,
      JSON.stringify(explanation),
      scenario.actor.email,
    ],
  )
  const plan = planResult.rows[0]
  const packageFixture = {
    packageNumber: 1,
    lengthMm: 460,
    widthMm: 340,
    heightMm: 280,
    weightGrams: totalWeight,
  }
  await client.query(
    `INSERT INTO operations_carton_plans (
       organization_id, plan_id, algorithm, package_count, total_weight_grams, packages
     )
     VALUES (
       $1::uuid, $2::uuid, 'deterministic_simulation', 1, $3, $4::jsonb
     )
     ON CONFLICT (plan_id) DO UPDATE SET
       algorithm = EXCLUDED.algorithm,
       package_count = EXCLUDED.package_count,
       total_weight_grams = EXCLUDED.total_weight_grams,
       packages = EXCLUDED.packages`,
    [
      scope.organizationId,
      plan.id,
      totalWeight,
      JSON.stringify([{ ...packageFixture, synthetic: true, scenarioKey: scenario.scenarioKey }]),
    ],
  )
  await client.query(
    `INSERT INTO operations_packages (
       organization_id, plan_id, package_number, length_mm, width_mm, height_mm,
       weight_grams, status, packed_by, packed_at
     )
     VALUES ($1::uuid, $2::uuid, 1, $3, $4, $5, $6, 'planned', NULL, NULL)
     ON CONFLICT (plan_id, package_number) DO UPDATE SET
       length_mm = EXCLUDED.length_mm,
       width_mm = EXCLUDED.width_mm,
       height_mm = EXCLUDED.height_mm,
       weight_grams = EXCLUDED.weight_grams,
       status = 'planned',
       packed_by = NULL,
       packed_at = NULL`,
    [
      scope.organizationId,
      plan.id,
      packageFixture.lengthMm,
      packageFixture.widthMm,
      packageFixture.heightMm,
      packageFixture.weightGrams,
    ],
  )
  return plan
}

async function upsertWave(client, scope, scenario, warehouse) {
  const name = `[DEV WMS] Replenishment Pressure ${scenario.anchorDate}`
  const existing = await client.query(
    `SELECT id::text, global_id
     FROM operations_waves
     WHERE organization_id = $1::uuid
       AND warehouse_id = $2::uuid
       AND name = $3
     ORDER BY created_at
     LIMIT 1
     FOR UPDATE`,
    [scope.organizationId, warehouse.id, name],
  )
  if (existing.rowCount === 1) {
    await client.query(
      `UPDATE operations_waves
       SET status = 'released',
           optimization_method = 'deterministic_fallback',
           released_by = $3,
           released_at = $4::timestamptz,
           completed_at = NULL
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        scope.organizationId,
        existing.rows[0].id,
        scenario.actor.email,
        `${scenario.anchorDate}T16:00:00.000Z`,
      ],
    )
    return existing.rows[0]
  }
  const inserted = await client.query(
    `INSERT INTO operations_waves (
       organization_id, warehouse_id, name, status, optimization_method,
       released_by, released_at
     )
     VALUES (
       $1::uuid, $2::uuid, $3, 'released', 'deterministic_fallback',
       $4, $5::timestamptz
     )
     RETURNING id::text, global_id`,
    [
      scope.organizationId,
      warehouse.id,
      name,
      scenario.actor.email,
      `${scenario.anchorDate}T16:00:00.000Z`,
    ],
  )
  return inserted.rows[0]
}

async function seedExecution(client, scope, scenario, warehouse, locations, positions, orders) {
  const wave = await upsertWave(client, scope, scenario, warehouse)
  let pickSequence = 1
  for (const order of orders.filter((value) => value.releaseForExecution)) {
    const plan = await upsertPlanAndPackage(client, scope, scenario, warehouse, order)
    for (const line of order.persistedLines) {
      const locationCode = scenario.executionPositionByProduct[line.productKey]
      const position = positions.get(`${line.productKey}:${locationCode}`)
      const reservation = await activateReservation(
        client,
        scope,
        scenario,
        order,
        line,
        position,
      )
      const allocationResult = await client.query(
        `INSERT INTO operations_fulfillment_allocations (
           organization_id, plan_id, order_line_id, reservation_id,
           position_id, quantity
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6)
         ON CONFLICT (plan_id, order_line_id, position_id) DO UPDATE SET
           reservation_id = EXCLUDED.reservation_id,
           quantity = EXCLUDED.quantity
         RETURNING id::text`,
        [
          scope.organizationId,
          plan.id,
          line.id,
          reservation.id,
          position.id,
          line.quantity,
        ],
      )
      const allocation = allocationResult.rows[0]
      await client.query(
        `INSERT INTO operations_pick_tasks (
           organization_id, wave_id, plan_id, allocation_id, from_location_id,
           quantity, sequence_number, status, assigned_to, picked_quantity,
           picked_at, updated_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7,
           'ready', NULL, NULL, NULL, now()
         )
         ON CONFLICT (allocation_id) DO UPDATE SET
           wave_id = EXCLUDED.wave_id,
           plan_id = EXCLUDED.plan_id,
           from_location_id = EXCLUDED.from_location_id,
           quantity = EXCLUDED.quantity,
           sequence_number = EXCLUDED.sequence_number,
           status = 'ready',
           assigned_to = NULL,
           picked_quantity = NULL,
           picked_at = NULL,
           updated_at = now()`,
        [
          scope.organizationId,
          wave.id,
          plan.id,
          allocation.id,
          locations.get(locationCode).id,
          line.quantity,
          pickSequence,
        ],
      )
      pickSequence += 1
    }
  }
  return { wave, pickTasks: pickSequence - 1 }
}

async function seedScenario(client, configuration, scenario) {
  await client.query('BEGIN')
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`${scenario.scenarioKey}:${configuration.organizationId}`],
    )
    await requireSchema(client)
    const scope = await resolveScope(client, configuration)
    await upsertActor(client, scope, scenario)
    const customer = await upsertSyntheticCustomer(client, scope, scenario)
    const products = await upsertProducts(client, scope, scenario)
    const integration = await upsertIntegration(client, scope, scenario)
    const warehouse = await upsertWarehouse(client, scope, scenario)
    const locations = await upsertLocations(client, scope, scenario, warehouse)
    const pool = await upsertInventoryPool(client, scope, scenario, customer)
    await upsertProductMappings(client, scope, scenario, integration, products)
    await upsertPlacementRules(client, scope, scenario, locations, products)
    const positions = await upsertPositions(
      client,
      scope,
      scenario,
      warehouse,
      locations,
      pool,
      products,
    )
    const orders = []
    for (const fixture of scenario.orders) {
      orders.push(await upsertOrder(
        client,
        scope,
        scenario,
        integration,
        customer,
        products,
        fixture,
      ))
    }
    const execution = await seedExecution(
      client,
      scope,
      scenario,
      warehouse,
      locations,
      positions,
      orders,
    )
    await client.query('COMMIT')
    return {
      ok: true,
      mode: 'seed',
      environment: configuration.explicitEnvironment,
      scenarioKey: scenario.scenarioKey,
      organizationId: scope.organizationId,
      organizationName: scope.organizationName,
      pipelineId: scope.pipelineId,
      pipelineName: scope.pipelineName,
      actorEmail: scenario.actor.email,
      warehouseGlobalId: warehouse.global_id,
      customerGlobalId: customer.reference_code,
      productCount: products.size,
      locationCount: locations.size,
      inventoryPositionCount: positions.size,
      orderCount: orders.length,
      releasedOrderCount: orders.filter((order) => order.releaseForExecution).length,
      pickTaskCount: execution.pickTasks,
      carrierTransactionsCreated: 0,
      emailsSent: 0,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function releaseScenarioReservations(client, scope, scenario) {
  const reservations = await client.query(
    `SELECT reservation.id::text, reservation.global_id, reservation.position_id::text,
            reservation.quantity
     FROM operations_reservations reservation
     WHERE reservation.organization_id = $1::uuid
       AND reservation.idempotency_key LIKE $2
       AND reservation.status = 'active'
     ORDER BY reservation.created_at, reservation.id
     FOR UPDATE`,
    [scope.organizationId, `${scenario.scenarioKey}:reservation:%`],
  )
  for (const reservation of reservations.rows) {
    const positionResult = await client.query(
      `SELECT id::text, on_hand_quantity, reserved_quantity, damaged_quantity
       FROM operations_inventory_positions
       WHERE organization_id = $1::uuid AND id = $2::uuid
       FOR UPDATE`,
      [scope.organizationId, reservation.position_id],
    )
    const position = positionResult.rows[0]
    const quantity = Number(reservation.quantity)
    if (Number(position.reserved_quantity) < quantity) {
      fail(`Cannot release ${reservation.global_id}; position reserved balance is too low`)
    }
    const updated = await client.query(
      `UPDATE operations_inventory_positions
       SET reserved_quantity = reserved_quantity - $3,
           version = version + 1,
           updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid
       RETURNING on_hand_quantity, reserved_quantity, damaged_quantity`,
      [scope.organizationId, reservation.position_id, quantity],
    )
    const cycleResult = await client.query(
      `SELECT count(*)::integer AS cycle
       FROM operations_inventory_ledger
       WHERE organization_id = $1::uuid
         AND source_global_id = $2
         AND event_type = 'reservation_release'`,
      [scope.organizationId, reservation.global_id],
    )
    const cycle = Number(cycleResult.rows[0].cycle) + 1
    const after = updated.rows[0]
    await client.query(
      `INSERT INTO operations_inventory_ledger (
         organization_id, position_id, event_type, on_hand_delta,
         reserved_delta, damaged_delta, on_hand_after, reserved_after,
         damaged_after, source_global_id, reason, idempotency_key,
         actor_email, occurred_at
       )
       VALUES (
         $1::uuid, $2::uuid, 'reservation_release', 0, $3, 0, $4, $5, $6,
         $7, $8, $9, $10, now()
       )`,
      [
        scope.organizationId,
        reservation.position_id,
        -quantity,
        after.on_hand_quantity,
        after.reserved_quantity,
        after.damaged_quantity,
        reservation.global_id,
        `${scenario.scenarioKey} cleanup`,
        `${scenario.scenarioKey}:release:${reservation.global_id}:cycle:${cycle}`,
        scenario.actor.email,
      ],
    )
    await client.query(
      `UPDATE operations_reservations
       SET status = 'released', released_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [scope.organizationId, reservation.id],
    )
  }
  return reservations.rowCount
}

async function cleanupScenario(client, configuration, scenario) {
  await client.query('BEGIN')
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`${scenario.scenarioKey}:${configuration.organizationId}`],
    )
    await requireSchema(client)
    const scope = await resolveScope(client, configuration)
    const releasedReservations = await releaseScenarioReservations(client, scope, scenario)

    const integrationResult = await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'disabled',
           configuration = configuration || '{"state":"retired"}'::jsonb,
           credential_reference = NULL,
           updated_by = $2,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND provider = 'wms_development_simulator'
         AND integration_type = 'commerce'
         AND environment = 'mock'
       RETURNING id::text`,
      [scope.organizationId, scenario.actor.email],
    )
    const integrationIds = integrationResult.rows.map((row) => row.id)

    let cancelledOrders = 0
    if (integrationIds.length > 0) {
      const orderIds = await client.query(
        `SELECT id::text
         FROM operations_orders
         WHERE organization_id = $1::uuid
           AND integration_account_id = ANY($2::uuid[])`,
        [scope.organizationId, integrationIds],
      )
      const ids = orderIds.rows.map((row) => row.id)
      if (ids.length > 0) {
        await client.query(
          `UPDATE operations_pick_tasks pick_task
           SET status = 'cancelled', updated_at = now()
           FROM operations_fulfillment_plans plan
           WHERE pick_task.organization_id = $1::uuid
             AND pick_task.plan_id = plan.id
             AND plan.order_id = ANY($2::uuid[])`,
          [scope.organizationId, ids],
        )
        await client.query(
          `UPDATE operations_fulfillment_plans
           SET status = 'cancelled', updated_at = now()
           WHERE organization_id = $1::uuid
             AND order_id = ANY($2::uuid[])`,
          [scope.organizationId, ids],
        )
        const cancelled = await client.query(
          `UPDATE operations_orders
           SET status = 'cancelled',
               source_payload = source_payload || '{"simulationState":"retired"}'::jsonb,
               updated_by = $3,
               row_version = row_version + 1,
               updated_at = now()
           WHERE organization_id = $1::uuid
             AND id = ANY($2::uuid[])
           RETURNING id`,
          [scope.organizationId, ids, scenario.actor.email],
        )
        cancelledOrders = cancelled.rowCount
      }
    }

    await client.query(
      `UPDATE operations_waves
       SET status = 'cancelled', completed_at = now()
       WHERE organization_id = $1::uuid
         AND name = $2`,
      [
        scope.organizationId,
        `[DEV WMS] Replenishment Pressure ${scenario.anchorDate}`,
      ],
    )
    await client.query(
      `UPDATE operations_location_product_rules rule
       SET active = false, updated_by = $2, updated_at = now()
       FROM operations_locations location, operations_warehouses warehouse
       WHERE rule.organization_id = $1::uuid
         AND rule.location_id = location.id
         AND location.warehouse_id = warehouse.id
         AND warehouse.code = 'DEV-WMS-SIM-01'`,
      [scope.organizationId, scenario.actor.email],
    )
    await client.query(
      `UPDATE operations_product_mappings
       SET active = false, updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = ANY($2::uuid[])`,
      [scope.organizationId, integrationIds],
    )
    await client.query(
      `UPDATE operations_locations location
       SET active = false,
           updated_by = $2,
           row_version = row_version + 1,
           updated_at = now()
       FROM operations_warehouses warehouse
       WHERE location.organization_id = $1::uuid
         AND location.warehouse_id = warehouse.id
         AND warehouse.code = 'DEV-WMS-SIM-01'`,
      [scope.organizationId, scenario.actor.email],
    )
    await client.query(
      `UPDATE operations_warehouses
       SET status = 'inactive',
           updated_by = $2,
           row_version = row_version + 1,
           updated_at = now()
       WHERE organization_id = $1::uuid AND code = 'DEV-WMS-SIM-01'`,
      [scope.organizationId, scenario.actor.email],
    )
    await client.query(
      `UPDATE operations_inventory_pools
       SET active = false, updated_at = now()
       WHERE organization_id = $1::uuid
         AND name = '[DEV WMS] Shared Simulation Pool'`,
      [scope.organizationId],
    )
    await client.query(
      `UPDATE crm_products
       SET active = false,
           status = 'Inactive',
           source_payload = source_payload || '{"simulationState":"retired"}'::jsonb,
           updated_by = $3,
           updated_at = now()
       WHERE pipeline_id = $1::uuid
         AND source_key LIKE $2`,
      [scope.pipelineId, `${scenario.scenarioKey}:product:%`, scenario.actor.email],
    )
    await client.query(
      `UPDATE crm_organizations
       SET source_payload = source_payload || '{"state":"retired"}'::jsonb,
           updated_by = $3,
           updated_at = now()
       WHERE pipeline_id = $1::uuid AND source_key = $2`,
      [scope.pipelineId, scenario.customer.sourceKey, scenario.actor.email],
    )
    await client.query(
      `UPDATE app_user_organization_memberships
       SET status = 'disabled',
           is_default = false,
           updated_by = $1,
           updated_at = now()
       WHERE user_email = $1 AND organization_id = $2::uuid`,
      [scenario.actor.email, scope.organizationId],
    )
    await client.query(
      `UPDATE app_users
       SET status = 'disabled',
           activated_at = NULL,
           permissions = $2::jsonb,
           updated_at = now()
       WHERE email = $1`,
      [scenario.actor.email, JSON.stringify(FALSE_PERMISSIONS)],
    )

    await client.query('COMMIT')
    return {
      ok: true,
      mode: 'cleanup',
      environment: configuration.explicitEnvironment,
      scenarioKey: scenario.scenarioKey,
      organizationId: scope.organizationId,
      organizationName: scope.organizationName,
      pipelineId: scope.pipelineId,
      reservationsReleased: releasedReservations,
      ordersCancelled: cancelledOrders,
      immutableInventoryLedgerPreserved: true,
      carrierTransactionsVoided: 0,
      emailsSent: 0,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

function runSelfTest() {
  const localConfiguration = {
    WMS_SIM_ENV: 'local',
    WMS_SIM_ORGANIZATION_ID: '10000000-0000-4000-8000-000000000001',
    DATABASE_URL: 'postgresql://localhost/clawpilot_dev',
  }
  assert.doesNotThrow(() => validateExecutionEnvironment(localConfiguration))
  assert.throws(
    () => validateExecutionEnvironment({ ...localConfiguration, WMS_SIM_ENV: 'production' }),
    /must be explicitly set/,
  )
  assert.throws(
    () => validateExecutionEnvironment({
      ...localConfiguration,
      RAILWAY_ENVIRONMENT_NAME: 'production',
    }),
    /not a development or local environment/,
  )
  assert.throws(
    () => validateExecutionEnvironment({
      ...localConfiguration,
      DATABASE_URL: 'postgresql://remote.example/clawpilot',
    }),
    /requires RAILWAY_ENVIRONMENT_NAME/,
  )
  assert.throws(
    () => validateExecutionEnvironment({
      ...localConfiguration,
      WMS_SIM_ORGANIZATION_ID: '',
    }),
    /explicitly supplied UUID/,
  )

  const first = buildScenario(
    DEFAULT_ANCHOR_DATE,
    localConfiguration.WMS_SIM_ORGANIZATION_ID,
  )
  const second = buildScenario(
    DEFAULT_ANCHOR_DATE,
    localConfiguration.WMS_SIM_ORGANIZATION_ID,
  )
  assert.deepEqual(first, second, 'Scenario generation must be deterministic')
  assert.equal(first.actor.email, 'wms-simulator+100000000000@clawpilot.invalid')
  assert.ok(first.actor.email.endsWith('.invalid'))
  assert.deepEqual(first.warehouse.address, {
    line1: '101 Jegs Place',
    city: 'Delaware',
    state: 'OH',
    postalCode: '43015',
    country: 'US',
  })
  assert.deepEqual(first.warehouse.carrierCutoffs, { UPS: '21:00', FEDEX: '21:00' })
  assert.equal(first.orders.length, 21)
  assert.ok(first.orders.some((order) => order.lines.length > 1))
  const releasedDemand = first.orders
    .filter((order) => order.releaseForExecution)
    .flatMap((order) => order.lines)
    .reduce((totals, line) => {
      totals[line.productKey] = (totals[line.productKey] || 0) + line.quantity
      return totals
    }, {})
  assert.equal(releasedDemand.fast, 30)
  assert.equal(releasedDemand.medium, 12)
  assert.ok(36 - releasedDemand.fast < 12, 'Forward pick demand must trigger replenishment')
  assert.ok(18 - releasedDemand.medium < 8, 'Mezzanine demand must trigger replenishment')
  assert.ok(first.locations.some((location) => location.role === 'reserve'))
  assert.ok(first.locations.some((location) => location.role === 'forward_pick'))
  assert.ok(first.locations.some((location) => location.role === 'mezzanine_pick'))
  assert.ok(first.locations.some((location) => location.role === 'replenishment_staging'))
  assert.equal(JSON.stringify(first).includes('credential'), false)
  assert.equal(JSON.stringify(first).includes('labelData'), false)
  assert.equal(JSON.stringify(first).includes('pickupConfirmation'), false)
  for (const order of first.orders) {
    assert.ok(order.externalOrderId.startsWith('WMS-SIM-'))
  }
  return {
    ok: true,
    mode: 'self-test',
    assertions: 24,
    scenarioKey: first.scenarioKey,
    products: first.products.length,
    locations: first.locations.length,
    orders: first.orders.length,
    releasedFastDemand: releasedDemand.fast,
    releasedMezzanineDemand: releasedDemand.medium,
  }
}

function printHelp() {
  console.log(`Usage:
  WMS_SIM_ENV=local WMS_SIM_ORGANIZATION_ID=<uuid> DATABASE_URL=<url> \\
    node scripts/seed-wms-development-simulation.mjs

  WMS_SIM_ENV=local WMS_SIM_ORGANIZATION_ID=<uuid> DATABASE_URL=<url> \\
    node scripts/seed-wms-development-simulation.mjs --cleanup

  node scripts/seed-wms-development-simulation.mjs --self-test

Optional:
  WMS_SIM_PIPELINE_ID=<uuid>       Select a pipeline in the supplied organization.
  WMS_SIM_ANCHOR_DATE=YYYY-MM-DD  Override the deterministic ${DEFAULT_ANCHOR_DATE} anchor.

This script has no production override.`)
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args.selfTest) {
    console.log(JSON.stringify(runSelfTest(), null, 2))
    return
  }

  const configuration = validateExecutionEnvironment(process.env)
  const scenario = buildScenario(configuration.anchorDate, configuration.organizationId)
  const { Pool } = requireFromApp('pg')
  const sslMode = normalizedEnvironment(process.env.PGSSLMODE || process.env.DATABASE_SSL)
  const pool = new Pool({
    connectionString: configuration.databaseUrl,
    ssl: sslMode === 'require' || sslMode === 'true'
      ? { rejectUnauthorized: false }
      : undefined,
    connectionTimeoutMillis: 5000,
    query_timeout: 60000,
    max: 2,
  })
  try {
    const client = await pool.connect()
    try {
      const result = args.cleanup
        ? await cleanupScenario(client, configuration, scenario)
        : await seedScenario(client, configuration, scenario)
      console.log(JSON.stringify(result, null, 2))
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(`wms-development-simulation failed: ${error.message}`)
  process.exitCode = 1
})
