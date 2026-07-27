#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))

const SCENARIO_KEY = 'clawpilot-wms-development-v1'
const SIMULATOR_LINEAGE_LOCK_PREFIX = 'clawpilot:wms-development-simulator-lineage'
const PRESERVE_PRINTING_CONFIRMATION = 'retire-wms-simulation-preserve-printing-v1'
const PRESERVE_DISPOSABLE_REHEARSAL_CONFIRMATION =
  'retire-wms-simulation-disposable-rehearsal-v1'
const TRUSTED_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
const TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98'
const DEFAULT_ANCHOR_DATE = '2026-07-25'
const ALLOWED_ENVIRONMENTS = new Set(['dev', 'development', 'local'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const WAREHOUSE_GLOBAL_ID_PATTERN = /^gwh[0-9]{7}$/
const LOCATION_GLOBAL_ID_PATTERN = /^gwl[0-9]{7}$/
const INVENTORY_POOL_GLOBAL_ID_PATTERN = /^gip[0-9]{7}$/
const INVENTORY_POSITION_GLOBAL_ID_PATTERN = /^giv[0-9]{7}$/
const PRINTER_GLOBAL_ID_PATTERN = /^gpr[0-9]{7}$/
const PRINT_AGENT_GLOBAL_ID_PATTERN = /^gpt[0-9]{7}$/
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

function simulatorLineageLockKey(organizationId) {
  return `${SIMULATOR_LINEAGE_LOCK_PREFIX}:${organizationId.toLowerCase()}`
}

function parsedObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function scenarioCustomerIdentities(scenario) {
  const normalizedName = String(scenario.customer.name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  return {
    seededSourceKey: scenario.customer.sourceKey,
    seededIdentityKey: scenario.customer.identityKey,
    canonicalIdentityKey: `customer:name:${normalizedName}`,
  }
}

function isAllowedScenarioCustomerIdentity(customer, scenario) {
  const identities = scenarioCustomerIdentities(scenario)
  return (
    customer.source_key === identities.seededSourceKey
    && customer.identity_key === identities.seededIdentityKey
  ) || (
    customer.source_key === identities.canonicalIdentityKey
    && customer.identity_key === identities.canonicalIdentityKey
  )
}

function parseArguments(argv) {
  const flags = new Set(argv)
  const supported = [
    '--cleanup',
    '--cleanup-preserve-warehouse',
    '--self-test',
    '--help',
  ]
  const unknown = argv.filter((value) => !supported.includes(value))
  if (unknown.length > 0) {
    fail(`Unsupported argument(s): ${unknown.join(', ')}`)
  }
  const selectedModes = [
    flags.has('--cleanup'),
    flags.has('--cleanup-preserve-warehouse'),
    flags.has('--self-test'),
  ].filter(Boolean).length
  if (selectedModes > 1) {
    fail('--cleanup, --cleanup-preserve-warehouse, and --self-test cannot be combined')
  }
  return {
    cleanup: flags.has('--cleanup'),
    cleanupPreserveWarehouse: flags.has('--cleanup-preserve-warehouse'),
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
    || normalized === '[::1]'
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

function populatedRailwayMarkers(environment) {
  return Object.entries(environment)
    .filter(([key, value]) => (
      key.startsWith('RAILWAY_') && String(value || '').trim()
    ))
    .map(([key]) => key)
}

function validatePreserveExecutionLane(environment) {
  const rehearsalConfirmation = String(
    environment.WMS_SIM_DISPOSABLE_REHEARSAL_CONFIRM || '',
  ).trim()
  if (rehearsalConfirmation) {
    if (
      rehearsalConfirmation
        !== PRESERVE_DISPOSABLE_REHEARSAL_CONFIRMATION
    ) {
      fail(
        'WMS_SIM_DISPOSABLE_REHEARSAL_CONFIRM='
        + `${PRESERVE_DISPOSABLE_REHEARSAL_CONFIRMATION} is required`,
      )
    }
    if (populatedRailwayMarkers(environment).length > 0) {
      fail(
        'Disposable rehearsal cannot run with Railway environment markers',
      )
    }
    let database
    try {
      database = new URL(String(environment.DATABASE_URL || '').trim())
    } catch {
      fail('Disposable rehearsal requires a local PostgreSQL database URL')
    }
    if (!isLocalDatabaseHost(database.hostname)) {
      fail('Disposable rehearsal requires a local PostgreSQL database URL')
    }
    return
  }
  if (
    normalizedEnvironment(environment.RAILWAY_ENVIRONMENT_NAME)
      !== 'development'
  ) {
    fail('RAILWAY_ENVIRONMENT_NAME=development is required for preserve cleanup')
  }
  if (
    normalizedEnvironment(environment.RAILWAY_PROJECT_ID)
      !== TRUSTED_RAILWAY_PROJECT_ID
  ) {
    fail('RAILWAY_PROJECT_ID does not match the trusted ClawPilot project')
  }
  if (
    normalizedEnvironment(environment.RAILWAY_ENVIRONMENT_ID)
      !== TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID
  ) {
    fail(
      'RAILWAY_ENVIRONMENT_ID does not match the trusted development environment',
    )
  }
}

function validatePreservePrintingConfiguration(environment) {
  if (String(environment.WMS_SIM_PRESERVE_CONFIRM || '').trim()
      !== PRESERVE_PRINTING_CONFIRMATION) {
    fail(
      `WMS_SIM_PRESERVE_CONFIRM=${PRESERVE_PRINTING_CONFIRMATION} is required`,
    )
  }
  const warehouseGlobalId = String(
    environment.WMS_SIM_PRESERVE_WAREHOUSE_GLOBAL_ID || '',
  ).trim()
  const printerGlobalId = String(
    environment.WMS_SIM_PRESERVE_PRINTER_GLOBAL_ID || '',
  ).trim()
  const printAgentGlobalId = String(
    environment.WMS_SIM_PRESERVE_PRINT_AGENT_GLOBAL_ID || '',
  ).trim()
  const foreignLocationGlobalId = String(
    environment.WMS_SIM_PRESERVE_FOREIGN_LOCATION_GLOBAL_ID || '',
  ).trim()
  const foreignPoolGlobalId = String(
    environment.WMS_SIM_PRESERVE_FOREIGN_POOL_GLOBAL_ID || '',
  ).trim()
  const foreignPositionGlobalId = String(
    environment.WMS_SIM_PRESERVE_FOREIGN_POSITION_GLOBAL_ID || '',
  ).trim()
  const expectedDatabaseFingerprint = String(
    environment.WMS_SIM_EXPECTED_DATABASE_FINGERPRINT || '',
  ).trim().toLowerCase()
  if (!UUID_PATTERN.test(expectedDatabaseFingerprint)) {
    fail(
      'WMS_SIM_EXPECTED_DATABASE_FINGERPRINT must be the exact '
      + 'development database identity',
    )
  }
  if (!WAREHOUSE_GLOBAL_ID_PATTERN.test(warehouseGlobalId)) {
    fail('WMS_SIM_PRESERVE_WAREHOUSE_GLOBAL_ID must be an exact gwh Global ID')
  }
  if (!PRINTER_GLOBAL_ID_PATTERN.test(printerGlobalId)) {
    fail('WMS_SIM_PRESERVE_PRINTER_GLOBAL_ID must be an exact gpr Global ID')
  }
  if (!PRINT_AGENT_GLOBAL_ID_PATTERN.test(printAgentGlobalId)) {
    fail('WMS_SIM_PRESERVE_PRINT_AGENT_GLOBAL_ID must be an exact gpt Global ID')
  }
  if (!LOCATION_GLOBAL_ID_PATTERN.test(foreignLocationGlobalId)) {
    fail(
      'WMS_SIM_PRESERVE_FOREIGN_LOCATION_GLOBAL_ID must be an exact gwl Global ID',
    )
  }
  if (!INVENTORY_POOL_GLOBAL_ID_PATTERN.test(foreignPoolGlobalId)) {
    fail(
      'WMS_SIM_PRESERVE_FOREIGN_POOL_GLOBAL_ID must be an exact gip Global ID',
    )
  }
  if (!INVENTORY_POSITION_GLOBAL_ID_PATTERN.test(foreignPositionGlobalId)) {
    fail(
      'WMS_SIM_PRESERVE_FOREIGN_POSITION_GLOBAL_ID must be an exact giv Global ID',
    )
  }
  return {
    warehouseGlobalId,
    printerGlobalId,
    printAgentGlobalId,
    foreignLocationGlobalId,
    foreignPoolGlobalId,
    foreignPositionGlobalId,
    expectedDatabaseFingerprint,
  }
}

function assertDatabaseFingerprint(actualFingerprint, expectedFingerprint) {
  const actual = String(actualFingerprint || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(actual)) {
    fail('Connected development database identity is missing or invalid')
  }
  if (actual !== expectedFingerprint) {
    fail('Connected database identity does not match the approved development plan')
  }
  return actual
}

async function assertExpectedDatabaseFingerprint(client, expectedFingerprint) {
  const database = (
    await client.query(
      `SELECT value->>'id' AS database_fingerprint
       FROM app_settings
       WHERE key = 'deployment.database.identity'`,
    )
  ).rows[0]
  return assertDatabaseFingerprint(
    database?.database_fingerprint,
    expectedFingerprint,
  )
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
    'operations_product_mappings',
    'operations_orders',
    'operations_order_lines',
    'operations_reservations',
    'operations_fulfillment_plans',
    'operations_fulfillment_allocations',
    'operations_carton_plans',
    'operations_packages',
    'operations_waves',
    'operations_pick_tasks',
    'operations_exceptions',
    'operations_receipts',
    'operations_receipt_lines',
    'operations_replenishment_tasks',
    'operations_printers',
    'operations_print_agents',
    'sync_outbox',
    'short_links',
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

async function assertSimulatorLineageSeedable(client, scope) {
  const result = await client.query(
    `SELECT (
       EXISTS (
         SELECT 1
         FROM operations_integration_accounts integration
         WHERE integration.organization_id = $1::uuid
           AND integration.provider = 'wms_development_simulator'
           AND integration.integration_type = 'commerce'
           AND integration.environment = 'mock'
           AND integration.configuration->>'state' = 'retired'
       )
       OR EXISTS (
         SELECT 1
         FROM operations_orders orders
         WHERE orders.organization_id = $1::uuid
           AND orders.source_provider = 'wms_development_simulator'
           AND (
             orders.archived_at IS NOT NULL
             OR orders.source_payload->>'simulationState' = 'retired'
           )
       )
       OR EXISTS (
         SELECT 1
         FROM operations_warehouses warehouse
         WHERE warehouse.organization_id = $1::uuid
           AND warehouse.code = 'DEV-WMS-SIM-01'
           AND warehouse.address->>'state' = 'retired'
       )
     ) AS retired`,
    [scope.organizationId],
  )
  if (result.rows[0]?.retired === true) {
    fail(
      'The WMS development simulator lineage is retired for this organization '
      + 'and cannot be reseeded',
    )
  }
}

async function resolveScenarioRetirementTarget(
  client,
  configuration,
  scope,
  scenario,
  preservePrinting = null,
) {
  const integrationResult = await client.query(
    `SELECT integration.id::text, integration.global_id
     FROM operations_integration_accounts integration
     WHERE integration.organization_id = $1::uuid
       AND integration.provider = 'wms_development_simulator'
       AND integration.integration_type = 'commerce'
       AND integration.environment = 'mock'
       AND integration.configuration->>'scenarioKey' = $2
     ORDER BY integration.id
     FOR UPDATE`,
    [scope.organizationId, scenario.scenarioKey],
  )
  if (integrationResult.rowCount !== 1) {
    fail(
      `Scenario cleanup requires exactly one marked integration; found `
      + `${integrationResult.rowCount}`,
    )
  }
  const integration = integrationResult.rows[0]

  const warehouseResult = await client.query(
    `SELECT warehouse.id::text, warehouse.global_id
     FROM operations_warehouses warehouse
     WHERE warehouse.organization_id = $1::uuid
       AND warehouse.code = 'DEV-WMS-SIM-01'
       AND warehouse.address->>'scenarioKey' = $2
     ORDER BY warehouse.id
     FOR UPDATE`,
    [scope.organizationId, scenario.scenarioKey],
  )
  if (warehouseResult.rowCount !== 1) {
    fail(
      `Scenario cleanup requires exactly one marked warehouse; found `
      + `${warehouseResult.rowCount}`,
    )
  }
  const warehouse = warehouseResult.rows[0]
  if (
    preservePrinting
    && warehouse.global_id !== preservePrinting.warehouseGlobalId
  ) {
    fail(
      `Scenario cleanup preserve target is ${warehouse.global_id}, not `
      + `${preservePrinting.warehouseGlobalId}`,
    )
  }

  const orderResult = await client.query(
    `SELECT orders.id::text, orders.external_order_id,
            orders.pipeline_id::text, orders.integration_account_id::text,
            orders.customer_id::text,
            orders.source_payload->>'scenarioKey' AS scenario_key
     FROM operations_orders orders
     WHERE orders.organization_id = $1::uuid
       AND orders.source_provider = 'wms_development_simulator'
       AND (
         orders.integration_account_id = $3::uuid
         OR orders.source_payload->>'scenarioKey' = $2
       )
     ORDER BY orders.external_order_id, orders.id
     FOR UPDATE`,
    [scope.organizationId, scenario.scenarioKey, integration.id],
  )
  const expectedExternalOrderIds = scenario.orders
    .map((order) => order.externalOrderId)
    .sort()
  const actualExternalOrderIds = orderResult.rows
    .map((order) => order.external_order_id)
    .sort()
  const exactOrderSet = actualExternalOrderIds.length === expectedExternalOrderIds.length
    && actualExternalOrderIds.every(
      (externalOrderId, index) => externalOrderId === expectedExternalOrderIds[index],
    )
  if (!exactOrderSet) {
    const actual = new Set(actualExternalOrderIds)
    const expected = new Set(expectedExternalOrderIds)
    const missing = expectedExternalOrderIds.filter((id) => !actual.has(id))
    const unexpected = actualExternalOrderIds.filter((id) => !expected.has(id))
    fail(
      `Scenario cleanup expected ${expectedExternalOrderIds.length} exact orders; found `
      + `${actualExternalOrderIds.length}; missing=${missing.join(',') || 'none'}; `
      + `unexpected=${unexpected.join(',') || 'none'}`,
    )
  }
  if (orderResult.rows.some((order) => order.scenario_key !== scenario.scenarioKey)) {
    fail('Scenario cleanup found an expected order without the exact scenario marker')
  }
  if (orderResult.rows.some((order) => order.integration_account_id !== integration.id)) {
    fail('Scenario cleanup found an expected order bound to another integration')
  }
  const customerIds = [...new Set(orderResult.rows.map((order) => order.customer_id))]
  if (customerIds.length !== 1 || !customerIds[0]) {
    fail(`Scenario cleanup orders span ${customerIds.length} customers`)
  }
  const customerId = customerIds[0]

  const pipelineIds = [...new Set(orderResult.rows.map((order) => order.pipeline_id))]
  if (pipelineIds.length !== 1) {
    fail(`Scenario cleanup orders span ${pipelineIds.length} pipelines`)
  }
  const pipelineId = pipelineIds[0]
  if (configuration.pipelineId && configuration.pipelineId !== pipelineId) {
    fail(
      `Scenario cleanup pipeline ${pipelineId} does not match `
      + `WMS_SIM_PIPELINE_ID=${configuration.pipelineId}`,
    )
  }
  const pipelineResult = await client.query(
    `SELECT id::text, name
     FROM pipeline_spaces
     WHERE workspace_organization_id = $1::uuid
       AND id = $2::uuid
     FOR UPDATE`,
    [scope.organizationId, pipelineId],
  )
  if (pipelineResult.rowCount !== 1) {
    fail(`Scenario cleanup pipeline ${pipelineId} is not owned by the supplied organization`)
  }

  const customerResult = await client.query(
    `SELECT customer.id::text, customer.reference_code,
            customer.pipeline_id::text, customer.source_key,
            customer.identity_key, customer.name,
            customer.account_type, customer.relationship_type
     FROM crm_organizations customer
     JOIN pipeline_spaces pipeline
       ON pipeline.id = customer.pipeline_id
      AND pipeline.workspace_organization_id = $1::uuid
     WHERE customer.source_payload->>'scenarioKey' = $2
       AND customer.source_payload->>'synthetic' = 'true'
       AND customer.source_payload->>'nonDeliverable' = 'true'
     ORDER BY customer.id
     FOR UPDATE`,
    [scope.organizationId, scenario.scenarioKey],
  )
  if (customerResult.rowCount !== 1) {
    fail(
      `Scenario cleanup requires exactly one marked customer in pipeline ${pipelineId}; `
      + `found ${customerResult.rowCount}`,
    )
  }
  const customer = customerResult.rows[0]
  if (customer.id !== customerId) {
    fail('Scenario cleanup orders are bound to another marked customer')
  }
  if (customer.pipeline_id !== pipelineId) {
    fail('Scenario cleanup marked customer belongs to another pipeline')
  }
  if (
    customer.name !== scenario.customer.name
    || customer.account_type !== 'Synthetic test customer'
    || customer.relationship_type !== 'customer'
  ) {
    fail('Scenario cleanup marked customer metadata is not exact')
  }
  if (!isAllowedScenarioCustomerIdentity(customer, scenario)) {
    fail('Scenario cleanup marked customer identity is not an allowed exact pair')
  }
  const productResult = await client.query(
    `SELECT product.id::text, product.reference_code, product.source_key
     FROM crm_products product
     WHERE product.pipeline_id = $1::uuid
       AND product.source_key LIKE $2
       AND product.source_payload->>'scenarioKey' = $3
     ORDER BY product.source_key, product.id
     FOR UPDATE`,
    [
      pipelineId,
      `${scenario.scenarioKey}:product:%`,
      scenario.scenarioKey,
    ],
  )
  const expectedProductSourceKeys = scenario.products
    .map((product) => product.sourceKey)
    .sort()
  const actualProductSourceKeys = productResult.rows
    .map((product) => product.source_key)
    .sort()
  if (
    actualProductSourceKeys.length !== expectedProductSourceKeys.length
    || actualProductSourceKeys.some(
      (sourceKey, index) => sourceKey !== expectedProductSourceKeys[index],
    )
  ) {
    fail(
      `Scenario cleanup requires ${expectedProductSourceKeys.length} exact marked products; `
      + `found ${actualProductSourceKeys.length}`,
    )
  }
  const productIdBySourceKey = new Map(
    productResult.rows.map((product) => [product.source_key, product.id]),
  )
  const productIds = productResult.rows.map((product) => product.id)
  const suiteCrmOutboxResult = await client.query(
    `SELECT outbox.id::text, outbox.status
     FROM sync_outbox outbox
     WHERE outbox.target_system = 'suitecrm'
       AND outbox.operation IN ('upsert_record', 'reproject_record')
       AND outbox.status IN ('queued', 'failed', 'processing')
       AND (
         (
           outbox.aggregate_type = 'crm_organizations'
           AND outbox.aggregate_id = $1
         )
         OR (
           outbox.aggregate_type = 'crm_products'
           AND outbox.aggregate_id = ANY($2::text[])
         )
       )
     ORDER BY outbox.id
     FOR UPDATE`,
    [customer.id, productIds],
  )
  const processingSuiteCrmOutbox = suiteCrmOutboxResult.rows
    .filter((outbox) => outbox.status === 'processing')
  if (processingSuiteCrmOutbox.length > 0) {
    fail(
      `Scenario cleanup blocked by ${processingSuiteCrmOutbox.length} `
      + 'processing SuiteCRM projection(s)',
    )
  }

  const locationResult = await client.query(
    `SELECT location.id::text, location.global_id, location.code,
            location.notes, location.active
     FROM operations_locations location
     WHERE location.organization_id = $1::uuid
       AND location.warehouse_id = $2::uuid
     ORDER BY location.code, location.id
     FOR UPDATE`,
    [scope.organizationId, warehouse.id],
  )
  const markedLocationRows = locationResult.rows.filter(
    (location) => parsedObject(location.notes).scenarioKey === scenario.scenarioKey,
  )
  const foreignLocationRows = locationResult.rows.filter(
    (location) => parsedObject(location.notes).scenarioKey !== scenario.scenarioKey,
  )
  const expectedLocationCodes = scenario.locations
    .map((location) => location.code)
    .sort()
  const actualLocationCodes = markedLocationRows
    .map((location) => location.code)
    .sort()
  const exactLocationSet = actualLocationCodes.length === expectedLocationCodes.length
    && actualLocationCodes.every(
      (code, index) => code === expectedLocationCodes[index],
    )
  if (!exactLocationSet) {
    fail(
      `Scenario cleanup requires ${expectedLocationCodes.length} exact marked locations; `
      + `found ${actualLocationCodes.length} marked locations`,
    )
  }
  if (!preservePrinting && foreignLocationRows.length > 0) {
    fail(
      `Scenario cleanup found ${foreignLocationRows.length} unrelated warehouse `
      + 'location(s)',
    )
  }
  if (preservePrinting) {
    if (
      foreignLocationRows.length !== 1
      || foreignLocationRows[0].global_id !== preservePrinting.foreignLocationGlobalId
    ) {
      fail(
        'Scenario cleanup preserve mode requires exactly the explicitly named '
        + 'foreign proof location',
      )
    }
    if (foreignLocationRows[0].active !== false) {
      fail('The preserved foreign proof location must already be inactive')
    }
  }
  const locationIdByCode = new Map(
    markedLocationRows.map((location) => [location.code, location.id]),
  )

  const poolResult = await client.query(
    `SELECT pool.id::text, pool.global_id, pool.pipeline_id::text,
            pool.owner_customer_id::text
     FROM operations_inventory_pools pool
     WHERE pool.organization_id = $1::uuid
       AND pool.name = '[DEV WMS] Shared Simulation Pool'
     ORDER BY pool.id
     FOR UPDATE`,
    [scope.organizationId],
  )
  if (poolResult.rowCount !== 1) {
    fail(
      `Scenario cleanup requires exactly one named simulator pool; found `
      + `${poolResult.rowCount}`,
    )
  }
  const pool = poolResult.rows[0]
  if (pool.pipeline_id !== pipelineId) {
    fail(`Scenario simulator pool belongs to unexpected pipeline ${pool.pipeline_id}`)
  }
  if (pool.owner_customer_id && pool.owner_customer_id !== customer.id) {
    fail('Scenario simulator pool has an unrelated owner customer')
  }

  const poolPositionResult = await client.query(
    `SELECT position.id::text, position.warehouse_id::text
     FROM operations_inventory_positions position
     WHERE position.organization_id = $1::uuid
       AND position.pool_id = $2::uuid
     ORDER BY position.id
     FOR UPDATE`,
    [scope.organizationId, pool.id],
  )
  if (poolPositionResult.rows.some(
    (position) => position.warehouse_id !== warehouse.id
  )) {
    fail('Scenario simulator pool has inventory positions outside the marked warehouse')
  }

  const poolCustomerResult = await client.query(
    `SELECT eligible.customer_id::text, eligible.pipeline_id::text
     FROM operations_inventory_pool_customers eligible
     WHERE eligible.organization_id = $1::uuid
       AND eligible.pool_id = $2::uuid
     ORDER BY eligible.customer_id, eligible.effective_from
     FOR UPDATE`,
    [scope.organizationId, pool.id],
  )
  if (
    poolCustomerResult.rowCount !== 1
    || poolCustomerResult.rows.some(
      (eligible) => eligible.customer_id !== customer.id
        || eligible.pipeline_id !== pipelineId
    )
  ) {
    fail(
      'Scenario simulator pool must have exactly one link to the marked '
      + 'scenario customer',
    )
  }

  const warehousePositionResult = await client.query(
    `SELECT position.id::text, position.global_id,
            position.pool_id::text, position.product_id::text,
            position.location_id::text, position.reserved_quantity,
            pool.global_id AS pool_global_id, pool.name AS pool_name,
            pool.active AS pool_active,
            location.global_id AS location_global_id,
            location.active AS location_active,
            (
              SELECT count(*)
              FROM operations_reservations reservation
              WHERE reservation.organization_id = position.organization_id
                AND reservation.position_id = position.id
                AND reservation.status = 'active'
            )::integer AS active_reservations,
            (
              SELECT count(*)
              FROM operations_fulfillment_allocations allocation
              JOIN operations_fulfillment_plans plan
                ON plan.organization_id = allocation.organization_id
               AND plan.id = allocation.plan_id
              WHERE allocation.organization_id = position.organization_id
                AND allocation.position_id = position.id
                AND plan.status <> 'cancelled'
            )::integer AS active_allocations
     FROM operations_inventory_positions position
     JOIN operations_inventory_pools pool
       ON pool.organization_id = position.organization_id
      AND pool.id = position.pool_id
     JOIN operations_locations location
       ON location.organization_id = position.organization_id
      AND location.id = position.location_id
     WHERE position.organization_id = $1::uuid
       AND position.warehouse_id = $2::uuid
     ORDER BY position.id
     FOR UPDATE OF position, pool, location`,
    [scope.organizationId, warehouse.id],
  )
  const exactProductIds = new Set(productIdBySourceKey.values())
  const exactLocationIds = new Set(locationIdByCode.values())
  const scenarioPositions = warehousePositionResult.rows.filter(
    (position) => position.pool_id === pool.id,
  )
  const foreignPositions = warehousePositionResult.rows.filter(
    (position) => position.pool_id !== pool.id,
  )
  if (scenarioPositions.some(
    (position) => !exactProductIds.has(position.product_id)
      || !exactLocationIds.has(position.location_id)
  )) {
    fail('Marked scenario warehouse has an inventory position outside exact fixture products or locations')
  }
  if (!preservePrinting && foreignPositions.length > 0) {
    fail('Marked scenario warehouse has an inventory position from another pool')
  }
  if (preservePrinting) {
    const foreignPosition = foreignPositions[0]
    if (
      foreignPositions.length !== 1
      || !foreignPosition
      || foreignPosition.global_id !== preservePrinting.foreignPositionGlobalId
      || foreignPosition.pool_global_id !== preservePrinting.foreignPoolGlobalId
      || foreignPosition.location_global_id
        !== preservePrinting.foreignLocationGlobalId
      || exactProductIds.has(foreignPosition.product_id)
      || !String(foreignPosition.pool_name || '').startsWith('Proof pool ')
      || foreignPosition.pool_active !== false
      || foreignPosition.location_active !== false
      || Number(foreignPosition.reserved_quantity) !== 0
      || Number(foreignPosition.active_reservations) !== 0
      || Number(foreignPosition.active_allocations) !== 0
    ) {
      fail(
        'Scenario cleanup preserve mode found an unretired or unexpected '
        + 'foreign proof position',
      )
    }
  }

  const activeRuleResult = await client.query(
    `SELECT rule.id::text, location.code AS location_code, rule.product_id::text
     FROM operations_location_product_rules rule
     JOIN operations_locations location
       ON location.organization_id = rule.organization_id
      AND location.id = rule.location_id
     WHERE rule.organization_id = $1::uuid
       AND location.warehouse_id = $2::uuid
       AND rule.active
     ORDER BY rule.id
     FOR UPDATE OF rule`,
    [scope.organizationId, warehouse.id],
  )
  const expectedRulePairs = new Set(scenario.placementRules.map((rule) => {
    const product = scenario.products.find((candidate) => candidate.key === rule.productKey)
    return `${locationIdByCode.get(rule.locationCode)}:${productIdBySourceKey.get(product.sourceKey)}`
  }))
  if (activeRuleResult.rows.some(
    (rule) => !expectedRulePairs.has(
      `${locationIdByCode.get(rule.location_code)}:${rule.product_id}`,
    )
  )) {
    fail('Marked scenario warehouse has an active location rule outside the exact fixture')
  }

  const orderIds = orderResult.rows.map((order) => order.id)
  const waveName = `[DEV WMS] Replenishment Pressure ${scenario.anchorDate}`
  const waveResult = await client.query(
    `SELECT wave.id::text, wave.global_id, wave.name,
            EXISTS (
              SELECT 1
              FROM operations_pick_tasks other_task
              JOIN operations_fulfillment_plans other_plan
                ON other_plan.organization_id = other_task.organization_id
               AND other_plan.id = other_task.plan_id
              WHERE other_task.organization_id = wave.organization_id
                AND other_task.wave_id = wave.id
                AND NOT (other_plan.order_id = ANY($4::uuid[]))
            ) AS contaminated
     FROM operations_waves wave
     WHERE wave.organization_id = $1::uuid
       AND (
         (
           wave.warehouse_id = $2::uuid
           AND wave.name = $3
         )
         OR EXISTS (
           SELECT 1
           FROM operations_pick_tasks scenario_task
           JOIN operations_fulfillment_plans scenario_plan
             ON scenario_plan.organization_id = scenario_task.organization_id
            AND scenario_plan.id = scenario_task.plan_id
           WHERE scenario_task.organization_id = wave.organization_id
             AND scenario_task.wave_id = wave.id
             AND scenario_plan.order_id = ANY($4::uuid[])
         )
       )
     ORDER BY wave.id
     FOR UPDATE`,
    [scope.organizationId, warehouse.id, waveName, orderIds],
  )
  const contaminatedWaves = waveResult.rows
    .filter((wave) => wave.contaminated === true)
    .map((wave) => wave.global_id)
  if (contaminatedWaves.length > 0) {
    fail(
      `Scenario cleanup refused contaminated wave(s): ${contaminatedWaves.join(', ')}`,
    )
  }
  const waveIds = waveResult.rows.map((wave) => wave.id)

  const unrelatedReservationResult = await client.query(
    `SELECT reservation.global_id
     FROM operations_reservations reservation
     JOIN operations_inventory_positions position
       ON position.organization_id = reservation.organization_id
      AND position.id = reservation.position_id
     JOIN operations_orders orders
       ON orders.organization_id = reservation.organization_id
      AND orders.id = reservation.order_id
     WHERE reservation.organization_id = $1::uuid
       AND reservation.status = 'active'
       AND (
         position.pool_id = $2::uuid
         OR position.warehouse_id = $3::uuid
       )
       AND (
         orders.source_provider IS DISTINCT FROM 'wms_development_simulator'
         OR orders.source_payload->>'scenarioKey' IS DISTINCT FROM $4
       )
     ORDER BY reservation.id
     FOR UPDATE OF reservation, position, orders`,
    [scope.organizationId, pool.id, warehouse.id, scenario.scenarioKey],
  )
  const unrelatedAllocationResult = await client.query(
    `SELECT allocation.global_id
     FROM operations_fulfillment_allocations allocation
     JOIN operations_inventory_positions position
       ON position.organization_id = allocation.organization_id
      AND position.id = allocation.position_id
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = allocation.organization_id
      AND plan.id = allocation.plan_id
     JOIN operations_orders orders
       ON orders.organization_id = plan.organization_id
      AND orders.id = plan.order_id
     WHERE allocation.organization_id = $1::uuid
       AND plan.status <> 'cancelled'
       AND (
         position.pool_id = $2::uuid
         OR position.warehouse_id = $3::uuid
       )
       AND (
         orders.source_provider IS DISTINCT FROM 'wms_development_simulator'
         OR orders.source_payload->>'scenarioKey' IS DISTINCT FROM $4
       )
     ORDER BY allocation.id
     FOR UPDATE OF allocation, position, plan, orders`,
    [scope.organizationId, pool.id, warehouse.id, scenario.scenarioKey],
  )
  const unrelatedPlanResult = await client.query(
    `SELECT plan.global_id
     FROM operations_fulfillment_plans plan
     JOIN operations_orders orders
       ON orders.organization_id = plan.organization_id
      AND orders.id = plan.order_id
     WHERE plan.organization_id = $1::uuid
       AND plan.warehouse_id = $2::uuid
       AND plan.status <> 'cancelled'
       AND (
         orders.source_provider IS DISTINCT FROM 'wms_development_simulator'
         OR orders.source_payload->>'scenarioKey' IS DISTINCT FROM $3
       )
     ORDER BY plan.id
     FOR UPDATE OF plan, orders`,
    [scope.organizationId, warehouse.id, scenario.scenarioKey],
  )
  const nonterminalReceiptResult = await client.query(
    `SELECT receipt.global_id
     FROM operations_receipts receipt
     WHERE receipt.organization_id = $1::uuid
       AND receipt.status NOT IN ('completed', 'cancelled')
       AND (
         receipt.warehouse_id = $2::uuid
         OR receipt.inventory_pool_id = $3::uuid
         OR EXISTS (
           SELECT 1
           FROM operations_receipt_lines receipt_line
           JOIN operations_locations target_location
             ON target_location.organization_id = receipt_line.organization_id
            AND target_location.id = receipt_line.target_location_id
           WHERE receipt_line.organization_id = receipt.organization_id
             AND receipt_line.receipt_id = receipt.id
             AND target_location.warehouse_id = $2::uuid
         )
       )
     ORDER BY receipt.id
     FOR UPDATE OF receipt`,
    [scope.organizationId, warehouse.id, pool.id],
  )
  const nonterminalReplenishmentResult = await client.query(
    `SELECT task.global_id
     FROM operations_replenishment_tasks task
     WHERE task.organization_id = $1::uuid
       AND task.status NOT IN ('completed', 'cancelled')
       AND (
         task.warehouse_id = $2::uuid
         OR task.inventory_pool_id = $3::uuid
         OR EXISTS (
           SELECT 1
           FROM operations_locations task_location
           WHERE task_location.organization_id = task.organization_id
             AND task_location.id IN (
               task.source_location_id,
               task.destination_location_id
             )
             AND task_location.warehouse_id = $2::uuid
         )
       )
     ORDER BY task.id
     FOR UPDATE OF task`,
    [scope.organizationId, warehouse.id, pool.id],
  )
  const otherActiveWaveResult = await client.query(
    `SELECT wave.global_id
     FROM operations_waves wave
     WHERE wave.organization_id = $1::uuid
       AND wave.warehouse_id = $2::uuid
       AND wave.status IN ('planned', 'released', 'in_progress')
       AND NOT (wave.id = ANY($3::uuid[]))
     ORDER BY wave.id
     FOR UPDATE OF wave`,
    [scope.organizationId, warehouse.id, waveIds],
  )
  const activePrinterResult = await client.query(
    `SELECT printer.global_id
     FROM operations_printers printer
     WHERE printer.organization_id = $1::uuid
       AND printer.warehouse_id = $2::uuid
       AND printer.status <> 'disabled'
     ORDER BY printer.id
     FOR UPDATE OF printer`,
    [scope.organizationId, warehouse.id],
  )
  const activePrintAgentResult = await client.query(
    `SELECT agent.global_id
     FROM operations_print_agents agent
     WHERE agent.organization_id = $1::uuid
       AND agent.warehouse_id = $2::uuid
       AND agent.status = 'active'
     ORDER BY agent.id
     FOR UPDATE OF agent`,
    [scope.organizationId, warehouse.id],
  )
  let unexpectedActivePrinterCount = activePrinterResult.rowCount
  let unexpectedActivePrintAgentCount = activePrintAgentResult.rowCount
  if (preservePrinting) {
    const activePrinterGlobalIds = activePrinterResult.rows.map(
      (printer) => printer.global_id,
    )
    const activePrintAgentGlobalIds = activePrintAgentResult.rows.map(
      (agent) => agent.global_id,
    )
    if (
      activePrinterGlobalIds.length !== 1
      || activePrinterGlobalIds[0] !== preservePrinting.printerGlobalId
      || activePrintAgentGlobalIds.length !== 1
      || activePrintAgentGlobalIds[0] !== preservePrinting.printAgentGlobalId
    ) {
      fail(
        'Scenario cleanup preserve mode requires exactly the named active '
        + 'printer and print agent',
      )
    }
    const printingBinding = await client.query(
      `SELECT printer.global_id AS printer_global_id,
              agent.global_id AS print_agent_global_id,
              warehouse.global_id AS warehouse_global_id,
              printer.status AS printer_status,
              printer.connection_mode,
              agent.status AS print_agent_status
       FROM operations_printers printer
       JOIN operations_print_agents agent
         ON agent.organization_id = printer.organization_id
        AND agent.warehouse_id = printer.warehouse_id
        AND agent.id = printer.local_print_agent_id
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = printer.organization_id
        AND warehouse.id = printer.warehouse_id
       WHERE printer.organization_id = $1::uuid
         AND printer.global_id = $2
         AND agent.global_id = $3
         AND warehouse.global_id = $4
       FOR UPDATE OF printer, agent, warehouse`,
      [
        scope.organizationId,
        preservePrinting.printerGlobalId,
        preservePrinting.printAgentGlobalId,
        preservePrinting.warehouseGlobalId,
      ],
    )
    const binding = printingBinding.rows[0]
    if (
      printingBinding.rowCount !== 1
      || binding.printer_status === 'disabled'
      || binding.connection_mode !== 'local_agent'
      || binding.print_agent_status !== 'active'
    ) {
      fail('The explicitly preserved printer-to-agent binding is not active')
    }
    unexpectedActivePrinterCount = 0
    unexpectedActivePrintAgentCount = 0
  }
  const unrelatedDependents = [
    ['active_reservations', unrelatedReservationResult.rowCount],
    ['active_allocations', unrelatedAllocationResult.rowCount],
    ['non_cancelled_plans', unrelatedPlanResult.rowCount],
    ['nonterminal_receipts', nonterminalReceiptResult.rowCount],
    ['nonterminal_replenishment_tasks', nonterminalReplenishmentResult.rowCount],
    ['other_active_waves', otherActiveWaveResult.rowCount],
    ['active_printers', unexpectedActivePrinterCount],
    ['active_print_agents', unexpectedActivePrintAgentCount],
  ].filter(([, count]) => Number(count) > 0)
  if (unrelatedDependents.length > 0) {
    fail(
      'Scenario cleanup refused active unrelated warehouse or pool dependents: '
      + unrelatedDependents.map(([name, count]) => `${name}=${count}`).join(', '),
    )
  }

  return {
    scope: {
      ...scope,
      pipelineId,
      pipelineName: pipelineResult.rows[0].name,
    },
    integration,
    warehouse,
    customer,
    pool,
    productIds,
    crmReferenceCodes: [
      customer.reference_code,
      ...productResult.rows.map((product) => product.reference_code),
    ],
    orderIds,
    waveIds,
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
  const identities = scenarioCustomerIdentities(scenario)
  const existing = await client.query(
    `SELECT customer.id::text, customer.reference_code,
            customer.pipeline_id::text, customer.source_key,
            customer.identity_key, customer.name,
            customer.account_type, customer.relationship_type,
            customer.source_payload
     FROM crm_organizations customer
     JOIN pipeline_spaces pipeline
       ON pipeline.id = customer.pipeline_id
      AND pipeline.workspace_organization_id = $1::uuid
     WHERE (
         customer.source_payload->>'scenarioKey' = $2
         OR (
           customer.pipeline_id = $3::uuid
           AND (
             customer.source_key = ANY($4::text[])
             OR customer.identity_key = ANY($5::text[])
           )
         )
       )
     ORDER BY customer.id
     FOR UPDATE`,
    [
      scope.organizationId,
      scenario.scenarioKey,
      scope.pipelineId,
      [identities.seededSourceKey, identities.canonicalIdentityKey],
      [identities.seededIdentityKey, identities.canonicalIdentityKey],
    ],
  )
  if (existing.rowCount > 1) {
    fail(`Scenario generation found ${existing.rowCount} conflicting customer identities`)
  }
  if (existing.rowCount === 1) {
    const customer = existing.rows[0]
    const markedPayload = parsedObject(customer.source_payload)
    if (
      markedPayload.scenarioKey !== scenario.scenarioKey
      || markedPayload.synthetic !== true
      || markedPayload.nonDeliverable !== true
      || customer.pipeline_id !== scope.pipelineId
      || customer.name !== scenario.customer.name
      || customer.account_type !== 'Synthetic test customer'
      || customer.relationship_type !== 'customer'
      || !isAllowedScenarioCustomerIdentity(customer, scenario)
    ) {
      fail('Scenario generation found a conflicting or repurposed customer identity')
    }
    const updated = await client.query(
      `UPDATE crm_organizations
       SET priority = 'D',
           name = $3,
           account_type = 'Synthetic test customer',
           account_manager = $4,
           description = $5,
           source_payload = $6::jsonb,
           source_hash = $7,
           sync_status = 'synced',
           sync_error = NULL,
           updated_by = $4,
           email = NULL,
           email_opt_out = true,
           updated_at = now()
       WHERE pipeline_id = $1::uuid
         AND id = $2::uuid
       RETURNING id::text, reference_code`,
      [
        scope.pipelineId,
        customer.id,
        scenario.customer.name,
        scenario.actor.email,
        'Development-only synthetic WMS demand owner. Never synchronize or contact.',
        JSON.stringify(payload),
        digest(payload),
      ],
    )
    return updated.rows[0]
  }

  const inserted = await client.query(
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
  return inserted.rows[0]
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
       ON CONFLICT (organization_id, integration_account_id, channel_sku)
       WHERE channel_sku IS NOT NULL
         AND mapping_method = 'legacy_sku'
       DO UPDATE SET
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
      [simulatorLineageLockKey(configuration.organizationId)],
    )
    await requireSchema(client)
    const scope = await resolveScope(client, configuration)
    await assertSimulatorLineageSeedable(client, scope)
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

async function releaseScenarioReservations(client, scope, scenario, orderIds) {
  if (orderIds.length === 0) return 0

  const reservations = await client.query(
    `SELECT reservation.id::text, reservation.global_id, reservation.position_id::text,
            reservation.quantity
     FROM operations_reservations reservation
     WHERE reservation.organization_id = $1::uuid
       AND reservation.order_id = ANY($2::uuid[])
       AND reservation.status = 'active'
     ORDER BY reservation.created_at, reservation.id
     FOR UPDATE`,
    [scope.organizationId, orderIds],
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
       SET status = 'released', released_at = COALESCE(released_at, now())
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [scope.organizationId, reservation.id],
    )
  }
  return reservations.rowCount
}

async function assertPreservedPrintingRetained(
  client,
  scope,
  scenario,
  preservePrinting,
) {
  const result = await client.query(
    `SELECT warehouse.global_id AS warehouse_global_id,
            warehouse.status AS warehouse_status,
            warehouse.address->>'simulationState' AS simulation_state,
            warehouse.address->>'formerScenarioKey' AS former_scenario_key,
            printer.global_id AS printer_global_id,
            printer.status AS printer_status,
            printer.connection_mode,
            agent.global_id AS print_agent_global_id,
            agent.status AS print_agent_status
     FROM operations_warehouses warehouse
     JOIN operations_printers printer
       ON printer.organization_id = warehouse.organization_id
      AND printer.warehouse_id = warehouse.id
     JOIN operations_print_agents agent
       ON agent.organization_id = printer.organization_id
      AND agent.warehouse_id = printer.warehouse_id
      AND agent.id = printer.local_print_agent_id
     WHERE warehouse.organization_id = $1::uuid
       AND warehouse.global_id = $2
       AND printer.global_id = $3
       AND agent.global_id = $4`,
    [
      scope.organizationId,
      preservePrinting.warehouseGlobalId,
      preservePrinting.printerGlobalId,
      preservePrinting.printAgentGlobalId,
    ],
  )
  const row = result.rows[0]
  if (
    result.rowCount !== 1
    || row.warehouse_status !== 'active'
    || row.simulation_state !== 'retired'
    || row.former_scenario_key !== scenario.scenarioKey
    || row.printer_status === 'disabled'
    || row.connection_mode !== 'local_agent'
    || row.print_agent_status !== 'active'
  ) {
    fail('Scenario cleanup did not preserve the exact active printing binding')
  }
}

async function assertScenarioRetired(
  client,
  scope,
  scenario,
  preservePrinting = null,
) {
  const customerIdentities = scenarioCustomerIdentities(scenario)
  const result = await client.query(
    `WITH target_warehouse AS (
       SELECT warehouse.id
       FROM operations_warehouses warehouse
       WHERE warehouse.organization_id = $1::uuid
         AND warehouse.code = 'DEV-WMS-SIM-01'
         AND warehouse.address->>'scenarioKey' = $2
     ),
     target_pool AS (
       SELECT pool.id
       FROM operations_inventory_pools pool
       WHERE pool.organization_id = $1::uuid
         AND pool.name = '[DEV WMS] Shared Simulation Pool'
     ),
     target_locations AS (
       SELECT location.id
       FROM operations_locations location
       WHERE location.organization_id = $1::uuid
         AND location.warehouse_id IN (SELECT id FROM target_warehouse)
     ),
     scenario_products AS (
       SELECT product.id, product.reference_code
       FROM crm_products product
       JOIN pipeline_spaces pipeline
         ON pipeline.id = product.pipeline_id
        AND pipeline.workspace_organization_id = $1::uuid
       WHERE product.source_key LIKE $6
         AND product.source_payload->>'scenarioKey' = $2
     ),
     scenario_customer_candidates AS (
       SELECT customer.id, customer.pipeline_id, customer.source_key,
              customer.identity_key, customer.name, customer.account_type,
              customer.relationship_type, customer.reference_code
       FROM crm_organizations customer
       JOIN pipeline_spaces pipeline
         ON pipeline.id = customer.pipeline_id
        AND pipeline.workspace_organization_id = $1::uuid
       WHERE customer.source_payload->>'scenarioKey' = $2
         AND customer.source_payload->>'synthetic' = 'true'
         AND customer.source_payload->>'nonDeliverable' = 'true'
     ),
     scenario_customer AS (
       SELECT customer.id, customer.pipeline_id, customer.reference_code
       FROM scenario_customer_candidates customer
       WHERE customer.name = $7
         AND customer.account_type = 'Synthetic test customer'
         AND customer.relationship_type = 'customer'
         AND (
           (
             customer.source_key = $8
             AND customer.identity_key = $9
           )
           OR (
             customer.source_key = $10
             AND customer.identity_key = $10
           )
         )
     ),
     scenario_reference_codes AS (
       SELECT customer.reference_code FROM scenario_customer customer
       UNION
       SELECT product.reference_code FROM scenario_products product
     ),
     scenario_orders AS (
       SELECT orders.id, orders.pipeline_id, orders.customer_id
       FROM operations_orders orders
       WHERE orders.organization_id = $1::uuid
         AND orders.source_provider = 'wms_development_simulator'
         AND orders.source_payload->>'scenarioKey' = $2
     )
     SELECT
       (
         SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
         FROM operations_integration_accounts integration
         WHERE integration.organization_id = $1::uuid
           AND integration.provider = 'wms_development_simulator'
           AND integration.integration_type = 'commerce'
           AND integration.environment = 'mock'
           AND integration.configuration->>'scenarioKey' = $2
       )::integer AS integration_count_invalid,
       (
         SELECT CASE WHEN count(*) = $11::integer THEN 0 ELSE 1 END
         FROM scenario_products
       )::integer AS product_count_invalid,
       (
         SELECT CASE WHEN count(*) = $5::integer THEN 0 ELSE 1 END
         FROM operations_orders orders
         WHERE orders.organization_id = $1::uuid
           AND orders.source_provider = 'wms_development_simulator'
           AND orders.source_payload->>'scenarioKey' = $2
       )::integer AS order_count_invalid,
       (
         SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
         FROM operations_warehouses warehouse
         WHERE warehouse.organization_id = $1::uuid
           AND warehouse.code = 'DEV-WMS-SIM-01'
           AND warehouse.address->>'scenarioKey' = $2
       )::integer AS warehouse_count_invalid,
       (
         SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
         FROM operations_inventory_pools pool
         WHERE pool.organization_id = $1::uuid
           AND pool.name = '[DEV WMS] Shared Simulation Pool'
       )::integer AS inventory_pool_count_invalid,
       (
         SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
         FROM scenario_customer_candidates
       )::integer AS customer_count_invalid,
       (
         SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
         FROM scenario_customer
       )::integer AS customer_identity_invalid,
       (
         SELECT count(*)
         FROM scenario_orders orders
         WHERE NOT EXISTS (
           SELECT 1
           FROM scenario_customer customer
           WHERE customer.id = orders.customer_id
             AND customer.pipeline_id = orders.pipeline_id
         )
       )::integer AS orders_customer_invalid,
       (
         SELECT CASE
           WHEN count(*) = 1
            AND count(*) FILTER (
              WHERE EXISTS (
                SELECT 1
                FROM scenario_customer customer
                WHERE customer.id = eligible.customer_id
                  AND customer.pipeline_id = eligible.pipeline_id
              )
            ) = 1
           THEN 0
           ELSE 1
         END
         FROM operations_inventory_pool_customers eligible
         WHERE eligible.organization_id = $1::uuid
           AND eligible.pool_id IN (SELECT id FROM target_pool)
       )::integer AS pool_customer_links_invalid,
       (
         SELECT count(*)
         FROM operations_inventory_pools pool
         WHERE pool.organization_id = $1::uuid
           AND pool.id IN (SELECT id FROM target_pool)
           AND pool.owner_customer_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM scenario_customer customer
             WHERE customer.id = pool.owner_customer_id
           )
       )::integer AS pool_owner_invalid,
       (
         SELECT count(*)
         FROM sync_outbox outbox
         WHERE outbox.target_system = 'suitecrm'
           AND outbox.operation IN ('upsert_record', 'reproject_record')
           AND outbox.status IN ('queued', 'failed', 'processing')
           AND (
             (
               outbox.aggregate_type = 'crm_organizations'
               AND EXISTS (
                 SELECT 1
                 FROM scenario_customer customer
                 WHERE outbox.aggregate_id = customer.id::text
               )
             )
             OR (
               outbox.aggregate_type = 'crm_products'
               AND EXISTS (
                 SELECT 1
                 FROM scenario_products product
                 WHERE outbox.aggregate_id = product.id::text
               )
             )
           )
       )::integer AS claimable_suitecrm_outbox,
       (
         SELECT count(*)
         FROM short_links link
         WHERE link.source_app = 'clawpilot-crm'
           AND link.deleted_at IS NULL
           AND link.disabled_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM scenario_reference_codes reference
             WHERE link.slug = reference.reference_code
                OR link.slug = 'mail-' || reference.reference_code
                OR reference.reference_code = ANY(link.tags)
                OR link.destination_url LIKE
                  '%/crm/' || reference.reference_code || '%'
           )
       )::integer AS active_crm_short_links,
       (
         SELECT count(*)
         FROM operations_integration_accounts integration
         WHERE integration.organization_id = $1::uuid
           AND integration.provider = 'wms_development_simulator'
           AND integration.integration_type = 'commerce'
           AND integration.environment = 'mock'
           AND integration.configuration->>'scenarioKey' = $2
           AND (
             integration.status <> 'disabled'
             OR integration.credential_reference IS NOT NULL
             OR integration.configuration->>'state' IS DISTINCT FROM 'retired'
           )
       )::integer AS integrations_not_retired,
       (
         SELECT count(*)
         FROM operations_orders orders
         WHERE orders.organization_id = $1::uuid
           AND orders.source_provider = 'wms_development_simulator'
           AND orders.source_payload->>'scenarioKey' = $2
           AND (
             orders.status <> 'cancelled'
             OR orders.archived_at IS NULL
             OR orders.archive_reason IS NULL
             OR orders.archived_by IS NULL
             OR orders.source_payload->>'simulationState' IS DISTINCT FROM 'retired'
             OR orders.source_payload->>'retirementReason'
               IS DISTINCT FROM 'wms_development_simulation_retired'
           )
       )::integer AS orders_not_retired,
       (
         SELECT count(*)
         FROM operations_reservations reservation
         JOIN operations_orders orders
           ON orders.organization_id = reservation.organization_id
          AND orders.id = reservation.order_id
         WHERE reservation.organization_id = $1::uuid
           AND orders.source_provider = 'wms_development_simulator'
           AND orders.source_payload->>'scenarioKey' = $2
           AND reservation.status = 'active'
       )::integer AS active_reservations,
       (
         SELECT count(*)
         FROM operations_reservations reservation
         JOIN operations_inventory_positions position
           ON position.organization_id = reservation.organization_id
          AND position.id = reservation.position_id
         JOIN operations_orders orders
           ON orders.organization_id = reservation.organization_id
          AND orders.id = reservation.order_id
         WHERE reservation.organization_id = $1::uuid
           AND reservation.status = 'active'
           AND (
             position.pool_id IN (SELECT id FROM target_pool)
             OR position.warehouse_id IN (SELECT id FROM target_warehouse)
           )
           AND NOT EXISTS (
             SELECT 1 FROM scenario_orders
             WHERE scenario_orders.id = orders.id
           )
       )::integer AS unrelated_active_reservations,
       (
         SELECT count(*)
         FROM operations_fulfillment_allocations allocation
         JOIN operations_inventory_positions position
           ON position.organization_id = allocation.organization_id
          AND position.id = allocation.position_id
         JOIN operations_fulfillment_plans plan
           ON plan.organization_id = allocation.organization_id
          AND plan.id = allocation.plan_id
         JOIN operations_orders orders
           ON orders.organization_id = plan.organization_id
          AND orders.id = plan.order_id
         WHERE allocation.organization_id = $1::uuid
           AND plan.status <> 'cancelled'
           AND (
             position.pool_id IN (SELECT id FROM target_pool)
             OR position.warehouse_id IN (SELECT id FROM target_warehouse)
           )
           AND NOT EXISTS (
             SELECT 1 FROM scenario_orders
             WHERE scenario_orders.id = orders.id
           )
       )::integer AS unrelated_active_allocations,
       (
         SELECT count(*)
         FROM operations_fulfillment_plans plan
         JOIN operations_orders orders
           ON orders.organization_id = plan.organization_id
          AND orders.id = plan.order_id
         WHERE plan.organization_id = $1::uuid
           AND plan.warehouse_id IN (SELECT id FROM target_warehouse)
           AND plan.status <> 'cancelled'
           AND NOT EXISTS (
             SELECT 1 FROM scenario_orders
             WHERE scenario_orders.id = orders.id
           )
       )::integer AS unrelated_non_cancelled_plans,
       (
         SELECT count(*)
         FROM operations_receipts receipt
         WHERE receipt.organization_id = $1::uuid
           AND receipt.status NOT IN ('completed', 'cancelled')
           AND (
             receipt.warehouse_id IN (SELECT id FROM target_warehouse)
             OR receipt.inventory_pool_id IN (SELECT id FROM target_pool)
             OR EXISTS (
               SELECT 1
               FROM operations_receipt_lines receipt_line
               JOIN operations_locations target_location
                 ON target_location.organization_id = receipt_line.organization_id
                AND target_location.id = receipt_line.target_location_id
               WHERE receipt_line.organization_id = receipt.organization_id
                 AND receipt_line.receipt_id = receipt.id
                 AND target_location.warehouse_id IN (
                   SELECT id FROM target_warehouse
                 )
             )
           )
       )::integer AS unrelated_nonterminal_receipts,
       (
         SELECT count(*)
         FROM operations_replenishment_tasks task
         WHERE task.organization_id = $1::uuid
           AND task.status NOT IN ('completed', 'cancelled')
           AND (
             task.warehouse_id IN (SELECT id FROM target_warehouse)
             OR task.inventory_pool_id IN (SELECT id FROM target_pool)
             OR EXISTS (
               SELECT 1
               FROM operations_locations task_location
               WHERE task_location.organization_id = task.organization_id
                 AND task_location.id IN (
                   task.source_location_id,
                   task.destination_location_id
                 )
                 AND task_location.warehouse_id IN (
                   SELECT id FROM target_warehouse
                 )
             )
           )
       )::integer AS unrelated_nonterminal_replenishment_tasks,
       (
         SELECT count(*)
         FROM operations_inventory_positions position
         WHERE position.organization_id = $1::uuid
           AND position.warehouse_id IN (SELECT id FROM target_warehouse)
           AND NOT EXISTS (
             SELECT 1 FROM target_pool WHERE target_pool.id = position.pool_id
           )
       )::integer AS foreign_pool_positions_in_warehouse,
       (
         SELECT count(*)
         FROM operations_inventory_positions position
         WHERE position.organization_id = $1::uuid
           AND position.warehouse_id IN (SELECT id FROM target_warehouse)
           AND (
             NOT EXISTS (
               SELECT 1
               FROM scenario_products
               WHERE scenario_products.id = position.product_id
             )
             OR NOT EXISTS (
               SELECT 1
               FROM target_locations
               WHERE target_locations.id = position.location_id
             )
           )
       )::integer AS foreign_product_or_location_positions,
       (
         SELECT count(*)
         FROM operations_inventory_positions position
         WHERE position.organization_id = $1::uuid
           AND position.pool_id IN (SELECT id FROM target_pool)
           AND NOT EXISTS (
             SELECT 1
             FROM target_warehouse
             WHERE target_warehouse.id = position.warehouse_id
           )
       )::integer AS simulator_pool_positions_outside_warehouse,
       (
         SELECT count(*)
         FROM operations_fulfillment_plans plan
         JOIN operations_orders orders
           ON orders.organization_id = plan.organization_id
          AND orders.id = plan.order_id
         WHERE plan.organization_id = $1::uuid
           AND orders.source_provider = 'wms_development_simulator'
           AND orders.source_payload->>'scenarioKey' = $2
           AND plan.status <> 'cancelled'
       )::integer AS plans_not_cancelled,
       (
         SELECT count(*)
         FROM operations_pick_tasks pick_task
         JOIN operations_fulfillment_plans plan
           ON plan.organization_id = pick_task.organization_id
          AND plan.id = pick_task.plan_id
         JOIN operations_orders orders
           ON orders.organization_id = plan.organization_id
          AND orders.id = plan.order_id
         WHERE pick_task.organization_id = $1::uuid
           AND orders.source_provider = 'wms_development_simulator'
           AND orders.source_payload->>'scenarioKey' = $2
           AND pick_task.status <> 'cancelled'
       )::integer AS tasks_not_cancelled,
       (
         SELECT count(*)
         FROM operations_waves wave
         WHERE wave.organization_id = $1::uuid
           AND (
             (
               wave.name = $3
               AND EXISTS (
                 SELECT 1
                 FROM operations_warehouses warehouse
                 WHERE warehouse.organization_id = wave.organization_id
                   AND warehouse.id = wave.warehouse_id
                   AND warehouse.code = 'DEV-WMS-SIM-01'
                   AND warehouse.address->>'scenarioKey' = $2
               )
             )
             OR EXISTS (
               SELECT 1
               FROM operations_pick_tasks wave_task
               JOIN operations_fulfillment_plans wave_plan
                 ON wave_plan.organization_id = wave_task.organization_id
                AND wave_plan.id = wave_task.plan_id
               JOIN operations_orders wave_order
                 ON wave_order.organization_id = wave_plan.organization_id
                AND wave_order.id = wave_plan.order_id
               WHERE wave_task.organization_id = wave.organization_id
                 AND wave_task.wave_id = wave.id
                 AND wave_order.source_provider = 'wms_development_simulator'
                 AND wave_order.source_payload->>'scenarioKey' = $2
             )
           )
           AND wave.status <> 'cancelled'
       )::integer AS waves_not_cancelled,
       (
         SELECT count(*)
         FROM operations_waves wave
         WHERE wave.organization_id = $1::uuid
           AND wave.warehouse_id IN (SELECT id FROM target_warehouse)
           AND wave.status IN ('planned', 'released', 'in_progress')
           AND wave.name IS DISTINCT FROM $3
           AND NOT EXISTS (
             SELECT 1
             FROM operations_pick_tasks wave_task
             JOIN operations_fulfillment_plans wave_plan
               ON wave_plan.organization_id = wave_task.organization_id
              AND wave_plan.id = wave_task.plan_id
             JOIN scenario_orders
               ON scenario_orders.id = wave_plan.order_id
             WHERE wave_task.organization_id = wave.organization_id
               AND wave_task.wave_id = wave.id
           )
       )::integer AS unrelated_active_waves,
       (
         SELECT count(*)
         FROM operations_printers printer
         WHERE printer.organization_id = $1::uuid
           AND printer.warehouse_id IN (SELECT id FROM target_warehouse)
           AND printer.status <> 'disabled'
       )::integer AS unrelated_active_printers,
       (
         SELECT count(*)
         FROM operations_print_agents agent
         WHERE agent.organization_id = $1::uuid
           AND agent.warehouse_id IN (SELECT id FROM target_warehouse)
           AND agent.status = 'active'
       )::integer AS unrelated_active_print_agents,
       (
         SELECT count(*)
         FROM operations_exceptions exception
         JOIN operations_orders orders
           ON orders.organization_id = exception.organization_id
          AND orders.id = exception.order_id
         WHERE exception.organization_id = $1::uuid
           AND orders.source_provider = 'wms_development_simulator'
           AND orders.source_payload->>'scenarioKey' = $2
           AND exception.status IN ('open', 'acknowledged')
       )::integer AS active_exceptions,
       (
         SELECT count(*)
         FROM operations_warehouses warehouse
         WHERE warehouse.organization_id = $1::uuid
           AND warehouse.code = 'DEV-WMS-SIM-01'
           AND warehouse.address->>'scenarioKey' = $2
           AND (
             warehouse.status <> 'inactive'
             OR warehouse.address->>'state' IS DISTINCT FROM 'retired'
           )
       )::integer AS active_warehouses,
       (
         SELECT count(*)
         FROM operations_locations location
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = location.organization_id
          AND warehouse.id = location.warehouse_id
         WHERE location.organization_id = $1::uuid
           AND warehouse.code = 'DEV-WMS-SIM-01'
           AND warehouse.address->>'scenarioKey' = $2
           AND location.active
       )::integer AS active_locations,
       (
         SELECT count(*)
         FROM operations_location_product_rules rule
         JOIN operations_locations location
           ON location.organization_id = rule.organization_id
          AND location.id = rule.location_id
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = location.organization_id
          AND warehouse.id = location.warehouse_id
         WHERE rule.organization_id = $1::uuid
           AND warehouse.code = 'DEV-WMS-SIM-01'
           AND warehouse.address->>'scenarioKey' = $2
           AND rule.active
       )::integer AS active_location_rules,
       (
         SELECT count(*)
         FROM operations_product_mappings mapping
         JOIN operations_integration_accounts integration
           ON integration.organization_id = mapping.organization_id
          AND integration.id = mapping.integration_account_id
         WHERE mapping.organization_id = $1::uuid
           AND integration.provider = 'wms_development_simulator'
           AND integration.integration_type = 'commerce'
           AND integration.environment = 'mock'
           AND integration.configuration->>'scenarioKey' = $2
           AND mapping.active
       )::integer AS active_product_mappings,
       (
         SELECT count(*)
         FROM operations_inventory_pools pool
         WHERE pool.organization_id = $1::uuid
           AND pool.name = '[DEV WMS] Shared Simulation Pool'
           AND pool.active
       )::integer AS active_inventory_pools,
       (
         SELECT count(*)
         FROM crm_products product
         JOIN pipeline_spaces pipeline
           ON pipeline.id = product.pipeline_id
          AND pipeline.workspace_organization_id = $1::uuid
         WHERE product.source_key LIKE $6
           AND product.source_payload->>'scenarioKey' = $2
           AND (
             product.active
             OR product.status IS DISTINCT FROM 'Inactive'
             OR product.source_payload->>'simulationState' IS DISTINCT FROM 'retired'
             OR COALESCE(
               lower(product.source_payload->>'archived'),
               'false'
             ) NOT IN ('true', '1', 'yes')
           )
       )::integer AS active_products,
       (
         SELECT count(*)
         FROM crm_organizations customer
         JOIN scenario_customer marked
           ON marked.id = customer.id
          AND marked.pipeline_id = customer.pipeline_id
         WHERE customer.source_payload->>'state' IS DISTINCT FROM 'retired'
            OR COALESCE(
              lower(customer.source_payload->>'archived'),
              'false'
            ) NOT IN ('true', '1', 'yes')
       )::integer AS active_customers,
       (
         SELECT count(*)
         FROM app_user_organization_memberships membership
         WHERE membership.organization_id = $1::uuid
           AND membership.user_email = $4
           AND (membership.status <> 'disabled' OR membership.is_default)
       )::integer AS active_actor_memberships,
       (
         SELECT count(*)
         FROM app_users actor
         WHERE actor.email = $4
           AND actor.status <> 'disabled'
       )::integer AS active_actors`,
    [
      scope.organizationId,
      scenario.scenarioKey,
      `[DEV WMS] Replenishment Pressure ${scenario.anchorDate}`,
      scenario.actor.email,
      scenario.orders.length,
      `${scenario.scenarioKey}:product:%`,
      scenario.customer.name,
      customerIdentities.seededSourceKey,
      customerIdentities.seededIdentityKey,
      customerIdentities.canonicalIdentityKey,
      scenario.products.length,
    ],
  )
  const expectedPreservedCounts = preservePrinting
    ? new Map([
      ['foreign_pool_positions_in_warehouse', 1],
      ['foreign_product_or_location_positions', 1],
      ['unrelated_active_printers', 1],
      ['unrelated_active_print_agents', 1],
      ['active_warehouses', 1],
    ])
    : new Map()
  const violations = Object.entries(result.rows[0])
    .filter(([name, count]) => (
      expectedPreservedCounts.has(name)
        ? Number(count) !== expectedPreservedCounts.get(name)
        : Number(count) > 0
    ))
    .map(([name, count]) => `${name}=${count}`)
  if (violations.length > 0) {
    fail(`Scenario cleanup postflight failed: ${violations.join(', ')}`)
  }
  if (preservePrinting) {
    await assertPreservedPrintingRetained(
      client,
      scope,
      scenario,
      preservePrinting,
    )
  }
}

async function cleanupScenario(
  client,
  configuration,
  scenario,
  preservePrinting = null,
) {
  await client.query('BEGIN')
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [simulatorLineageLockKey(configuration.organizationId)],
    )
    await requireSchema(client)
    const resolvedScope = await resolveScope(client, configuration)
    const target = await resolveScenarioRetirementTarget(
      client,
      configuration,
      resolvedScope,
      scenario,
      preservePrinting,
    )
    const scope = target.scope
    const integrationIds = [target.integration.id]
    const warehouseIds = [target.warehouse.id]
    const orderIds = target.orderIds
    const waveIds = target.waveIds

    const neutralizedSuiteCrmOutbox = await client.query(
      `UPDATE sync_outbox
       SET status = 'dead',
           last_error = 'WMS development simulator retired before SuiteCRM delivery',
           available_at = 'infinity'::timestamptz,
           processed_at = COALESCE(processed_at, now()),
           locked_at = NULL,
           lock_token = NULL,
           updated_at = now()
       WHERE target_system = 'suitecrm'
         AND operation IN ('upsert_record', 'reproject_record')
         AND status IN ('queued', 'failed')
         AND (
           (
             aggregate_type = 'crm_organizations'
             AND aggregate_id = $1
           )
           OR (
             aggregate_type = 'crm_products'
             AND aggregate_id = ANY($2::text[])
           )
         )
       RETURNING id`,
      [target.customer.id, target.productIds],
    )

    await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'disabled',
           configuration = configuration || '{"state":"retired"}'::jsonb,
           credential_reference = NULL,
           updated_by = $2,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $3::uuid
         AND (
           status <> 'disabled'
           OR credential_reference IS NOT NULL
           OR configuration->>'state' IS DISTINCT FROM 'retired'
         )`,
      [scope.organizationId, scenario.actor.email, target.integration.id],
    )

    const releasedReservations = await releaseScenarioReservations(
      client,
      scope,
      scenario,
      orderIds,
    )

    let cancelledOrders = 0
    let cancelledPickTasks = 0
    let cancelledPlans = 0
    let cancelledWaves = 0
    let dismissedExceptions = 0
    if (orderIds.length > 0) {
      const taskResult = await client.query(
        `UPDATE operations_pick_tasks pick_task
         SET status = 'cancelled', updated_at = now()
         FROM operations_fulfillment_plans plan
         WHERE pick_task.organization_id = $1::uuid
           AND pick_task.plan_id = plan.id
           AND plan.order_id = ANY($2::uuid[])
           AND pick_task.status <> 'cancelled'
         RETURNING pick_task.id`,
        [scope.organizationId, orderIds],
      )
      cancelledPickTasks = taskResult.rowCount

      const planResult = await client.query(
        `UPDATE operations_fulfillment_plans
         SET status = 'cancelled', updated_at = now()
         WHERE organization_id = $1::uuid
           AND order_id = ANY($2::uuid[])
           AND status <> 'cancelled'
         RETURNING id`,
        [scope.organizationId, orderIds],
      )
      cancelledPlans = planResult.rowCount

      const exceptionResult = await client.query(
        `UPDATE operations_exceptions exception
         SET status = 'dismissed',
             resolved_by = COALESCE(exception.resolved_by, $3),
             resolved_at = COALESCE(exception.resolved_at, now()),
             details = exception.details || jsonb_build_object(
               'retirementReason', 'wms_development_simulation_retired'
             ),
             updated_at = now()
         WHERE exception.organization_id = $1::uuid
           AND exception.order_id = ANY($2::uuid[])
           AND exception.status IN ('open', 'acknowledged')
         RETURNING exception.id`,
        [scope.organizationId, orderIds, scenario.actor.email],
      )
      dismissedExceptions = exceptionResult.rowCount

      const cancelled = await client.query(
        `UPDATE operations_orders
         SET status = 'cancelled',
             source_payload = source_payload || jsonb_build_object(
               'simulationState', 'retired',
               'retirementReason', 'wms_development_simulation_retired'
             ),
             archived_at = COALESCE(archived_at, now()),
             archive_reason = COALESCE(
               archive_reason,
               'wms_development_simulation_retired'
             ),
             archived_by = COALESCE(archived_by, $3),
             updated_by = $3,
             row_version = row_version + 1,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = ANY($2::uuid[])
           AND (
             status <> 'cancelled'
             OR archived_at IS NULL
             OR archive_reason IS NULL
             OR archived_by IS NULL
             OR source_payload->>'simulationState' IS DISTINCT FROM 'retired'
             OR source_payload->>'retirementReason'
               IS DISTINCT FROM 'wms_development_simulation_retired'
           )
         RETURNING id`,
        [scope.organizationId, orderIds, scenario.actor.email],
      )
      cancelledOrders = cancelled.rowCount
    }

    const waveResult = await client.query(
      `UPDATE operations_waves wave
       SET status = 'cancelled',
           completed_at = COALESCE(completed_at, now())
       WHERE wave.organization_id = $1::uuid
         AND wave.id = ANY($2::uuid[])
         AND wave.status <> 'cancelled'
       RETURNING wave.id::text`,
      [scope.organizationId, waveIds],
    )
    cancelledWaves = waveResult.rowCount

    await client.query(
      `UPDATE operations_location_product_rules rule
       SET active = false, updated_by = $2, updated_at = now()
       FROM operations_locations location, operations_warehouses warehouse
       WHERE rule.organization_id = $1::uuid
         AND rule.location_id = location.id
         AND location.warehouse_id = warehouse.id
         AND warehouse.id = ANY($3::uuid[])
         AND rule.active`,
      [scope.organizationId, scenario.actor.email, warehouseIds],
    )
    await client.query(
      `UPDATE operations_product_mappings
       SET active = false, updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = ANY($2::uuid[])
         AND active`,
      [scope.organizationId, integrationIds],
    )
    await client.query(
      `UPDATE operations_locations location
       SET active = false,
           updated_by = $2,
           row_version = location.row_version + 1,
           updated_at = now()
       FROM operations_warehouses warehouse
       WHERE location.organization_id = $1::uuid
         AND location.warehouse_id = warehouse.id
         AND warehouse.id = ANY($3::uuid[])
         AND location.active`,
      [scope.organizationId, scenario.actor.email, warehouseIds],
    )
    if (preservePrinting) {
      await client.query(
        `UPDATE operations_warehouses
         SET status = 'active',
             address = (address - 'synthetic') || jsonb_build_object(
               'simulationState', 'retired',
               'retirementReason', 'wms_development_simulation_retired',
               'formerScenarioKey', $4,
               'preservedForPrinting', true
             ),
             updated_by = $2,
             row_version = row_version + 1,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = ANY($3::uuid[])
           AND (
             status <> 'active'
             OR address->>'simulationState' IS DISTINCT FROM 'retired'
             OR address->>'formerScenarioKey' IS DISTINCT FROM $4
             OR COALESCE(
               lower(address->>'preservedForPrinting'),
               'false'
             ) NOT IN ('true', '1', 'yes')
           )`,
        [
          scope.organizationId,
          scenario.actor.email,
          warehouseIds,
          scenario.scenarioKey,
        ],
      )
    } else {
      await client.query(
        `UPDATE operations_warehouses
         SET status = 'inactive',
             address = address || jsonb_build_object(
               'state', 'retired',
               'retirementReason', 'wms_development_simulation_retired'
             ),
             updated_by = $2,
             row_version = row_version + 1,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = ANY($3::uuid[])
           AND (
             status <> 'inactive'
             OR address->>'state' IS DISTINCT FROM 'retired'
           )`,
        [scope.organizationId, scenario.actor.email, warehouseIds],
      )
    }
    await client.query(
      `UPDATE operations_inventory_pools
       SET active = false, updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND active`,
      [scope.organizationId, target.pool.id],
    )
    await client.query(
      `UPDATE crm_products
       SET active = false,
           status = 'Inactive',
           source_payload = source_payload || jsonb_build_object(
             'simulationState', 'retired',
             'retirementReason', 'wms_development_simulation_retired',
             'archived', true
           ),
           updated_by = $3,
           updated_at = now()
       WHERE pipeline_id = $1::uuid
         AND id = ANY($2::uuid[])
         AND source_payload->>'scenarioKey' = $4
         AND (
           active
           OR status IS DISTINCT FROM 'Inactive'
           OR source_payload->>'simulationState' IS DISTINCT FROM 'retired'
           OR source_payload->>'retirementReason'
             IS DISTINCT FROM 'wms_development_simulation_retired'
           OR COALESCE(
             lower(source_payload->>'archived'),
             'false'
           ) NOT IN ('true', '1', 'yes')
         )`,
      [
        scope.pipelineId,
        target.productIds,
        scenario.actor.email,
        scenario.scenarioKey,
      ],
    )
    await client.query(
      `UPDATE crm_organizations
       SET source_payload = source_payload || jsonb_build_object(
             'state', 'retired',
             'retirementReason', 'wms_development_simulation_retired',
             'archived', true
           ),
           updated_by = $3,
           updated_at = now()
       WHERE pipeline_id = $1::uuid
         AND id = $2::uuid
         AND source_payload->>'scenarioKey' = $4
         AND (
           source_payload->>'state' IS DISTINCT FROM 'retired'
           OR source_payload->>'retirementReason'
             IS DISTINCT FROM 'wms_development_simulation_retired'
           OR COALESCE(
             lower(source_payload->>'archived'),
             'false'
           ) NOT IN ('true', '1', 'yes')
         )`,
      [
        scope.pipelineId,
        target.customer.id,
        scenario.actor.email,
        scenario.scenarioKey,
      ],
    )
    const disabledCrmShortLinks = await client.query(
      `UPDATE short_links link
       SET disabled_at = COALESCE(link.disabled_at, now()),
           updated_at = now()
       WHERE link.source_app = 'clawpilot-crm'
         AND link.deleted_at IS NULL
         AND link.disabled_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM unnest($1::text[]) reference(reference_code)
           WHERE link.slug = reference.reference_code
              OR link.slug = 'mail-' || reference.reference_code
              OR reference.reference_code = ANY(link.tags)
              OR link.destination_url LIKE
                '%/crm/' || reference.reference_code || '%'
         )
       RETURNING link.id`,
      [target.crmReferenceCodes],
    )
    await client.query(
      `UPDATE app_user_organization_memberships
       SET status = 'disabled',
           is_default = false,
           updated_by = $1,
           updated_at = now()
       WHERE user_email = $1
         AND organization_id = $2::uuid
         AND (status <> 'disabled' OR is_default)`,
      [scenario.actor.email, scope.organizationId],
    )
    await client.query(
      `UPDATE app_users
       SET status = 'disabled',
           activated_at = NULL,
           permissions = $2::jsonb,
           updated_at = now()
       WHERE email = $1
         AND (
           status <> 'disabled'
           OR activated_at IS NOT NULL
           OR permissions IS DISTINCT FROM $2::jsonb
         )`,
      [scenario.actor.email, JSON.stringify(FALSE_PERMISSIONS)],
    )

    await assertScenarioRetired(client, scope, scenario, preservePrinting)

    await client.query('COMMIT')
    return {
      ok: true,
      mode: preservePrinting ? 'cleanup-preserve-warehouse' : 'cleanup',
      environment: configuration.explicitEnvironment,
      scenarioKey: scenario.scenarioKey,
      organizationId: scope.organizationId,
      organizationName: scope.organizationName,
      pipelineId: scope.pipelineId,
      reservationsReleased: releasedReservations,
      ordersCancelled: cancelledOrders,
      ordersArchived: cancelledOrders,
      pickTasksCancelled: cancelledPickTasks,
      plansCancelled: cancelledPlans,
      wavesCancelled: cancelledWaves,
      exceptionsDismissed: dismissedExceptions,
      suiteCrmProjectionsNeutralized: neutralizedSuiteCrmOutbox.rowCount,
      crmShortLinksDisabled: disabledCrmShortLinks.rowCount,
      postflightPassed: true,
      immutableInventoryLedgerPreserved: true,
      preservedWarehouseGlobalId: preservePrinting?.warehouseGlobalId || null,
      preservedPrinterGlobalId: preservePrinting?.printerGlobalId || null,
      preservedPrintAgentGlobalId: preservePrinting?.printAgentGlobalId || null,
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
  assert.deepEqual(
    parseArguments(['--cleanup-preserve-warehouse']),
    {
      cleanup: false,
      cleanupPreserveWarehouse: true,
      selfTest: false,
      help: false,
    },
  )
  assert.throws(
    () => parseArguments(['--cleanup', '--cleanup-preserve-warehouse']),
    /cannot be combined/,
  )
  const preserveEnvironment = {
    WMS_SIM_PRESERVE_CONFIRM: PRESERVE_PRINTING_CONFIRMATION,
    WMS_SIM_EXPECTED_DATABASE_FINGERPRINT:
      '12345678-1234-4123-8123-123456789abc',
    WMS_SIM_PRESERVE_WAREHOUSE_GLOBAL_ID: 'gwh7494117',
    WMS_SIM_PRESERVE_PRINTER_GLOBAL_ID: 'gpr5630232',
    WMS_SIM_PRESERVE_PRINT_AGENT_GLOBAL_ID: 'gpt7418225',
    WMS_SIM_PRESERVE_FOREIGN_LOCATION_GLOBAL_ID: 'gwl1050773',
    WMS_SIM_PRESERVE_FOREIGN_POOL_GLOBAL_ID: 'gip7957421',
    WMS_SIM_PRESERVE_FOREIGN_POSITION_GLOBAL_ID: 'giv9161814',
  }
  assert.deepEqual(
    validatePreservePrintingConfiguration(preserveEnvironment),
    {
      warehouseGlobalId: 'gwh7494117',
      printerGlobalId: 'gpr5630232',
      printAgentGlobalId: 'gpt7418225',
      foreignLocationGlobalId: 'gwl1050773',
      foreignPoolGlobalId: 'gip7957421',
      foreignPositionGlobalId: 'giv9161814',
      expectedDatabaseFingerprint:
        '12345678-1234-4123-8123-123456789abc',
    },
  )
  assert.throws(
    () => validatePreservePrintingConfiguration({
      ...preserveEnvironment,
      WMS_SIM_PRESERVE_CONFIRM: '',
    }),
    /is required/,
  )
  assert.throws(
    () => validatePreservePrintingConfiguration({
      ...preserveEnvironment,
      WMS_SIM_EXPECTED_DATABASE_FINGERPRINT: '',
    }),
    /exact development database identity/,
  )
  assert.equal(
    assertDatabaseFingerprint(
      '12345678-1234-4123-8123-123456789ABC',
      '12345678-1234-4123-8123-123456789abc',
    ),
    '12345678-1234-4123-8123-123456789abc',
  )
  assert.throws(
    () => assertDatabaseFingerprint(
      '22345678-1234-4123-8123-123456789abc',
      '12345678-1234-4123-8123-123456789abc',
    ),
    /does not match/,
  )
  const livePreserveEnvironment = {
    DATABASE_URL: 'postgres://example.invalid/clawpilot',
    RAILWAY_ENVIRONMENT_NAME: 'development',
    RAILWAY_PROJECT_ID: TRUSTED_RAILWAY_PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID:
      TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID,
  }
  assert.doesNotThrow(
    () => validatePreserveExecutionLane(livePreserveEnvironment),
  )
  assert.throws(
    () => validatePreserveExecutionLane({
      ...livePreserveEnvironment,
      RAILWAY_ENVIRONMENT_ID:
        '22345678-1234-4123-8123-123456789abc',
    }),
    /trusted development environment/,
  )
  const rehearsalPreserveEnvironment = {
    DATABASE_URL: 'postgres://localhost/clawpilot-rehearsal',
    WMS_SIM_DISPOSABLE_REHEARSAL_CONFIRM:
      PRESERVE_DISPOSABLE_REHEARSAL_CONFIRMATION,
  }
  assert.doesNotThrow(
    () => validatePreserveExecutionLane(rehearsalPreserveEnvironment),
  )
  assert.throws(
    () => validatePreserveExecutionLane({
      ...rehearsalPreserveEnvironment,
      RAILWAY_ENVIRONMENT_NAME: 'development',
    }),
    /cannot run with Railway environment markers/,
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
  const customerIdentities = scenarioCustomerIdentities(first)
  assert.deepEqual(customerIdentities, {
    seededSourceKey: 'clawpilot-wms-development-v1:customer',
    seededIdentityKey: 'customer:synthetic:clawpilot-wms-development-v1',
    canonicalIdentityKey: 'customer:name:[dev wms] northstar test commerce llc',
  })
  assert.equal(isAllowedScenarioCustomerIdentity({
    source_key: customerIdentities.seededSourceKey,
    identity_key: customerIdentities.seededIdentityKey,
  }, first), true)
  assert.equal(isAllowedScenarioCustomerIdentity({
    source_key: customerIdentities.canonicalIdentityKey,
    identity_key: customerIdentities.canonicalIdentityKey,
  }, first), true)
  assert.equal(isAllowedScenarioCustomerIdentity({
    source_key: customerIdentities.seededSourceKey,
    identity_key: customerIdentities.canonicalIdentityKey,
  }, first), false)
  assert.equal(isAllowedScenarioCustomerIdentity({
    source_key: 'customer:name:unrelated',
    identity_key: 'customer:name:unrelated',
  }, first), false)
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
    assertions: 41,
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

  WMS_SIM_ENV=development WMS_SIM_ORGANIZATION_ID=<uuid> DATABASE_URL=<url> \\
    WMS_SIM_PRESERVE_CONFIRM=${PRESERVE_PRINTING_CONFIRMATION} \\
    WMS_SIM_EXPECTED_DATABASE_FINGERPRINT=<uuid-from-normalization-plan> \\
    WMS_SIM_PRESERVE_WAREHOUSE_GLOBAL_ID=<gwh> \\
    WMS_SIM_PRESERVE_PRINTER_GLOBAL_ID=<gpr> \\
    WMS_SIM_PRESERVE_PRINT_AGENT_GLOBAL_ID=<gpt> \\
    WMS_SIM_PRESERVE_FOREIGN_LOCATION_GLOBAL_ID=<gwl> \\
    WMS_SIM_PRESERVE_FOREIGN_POOL_GLOBAL_ID=<gip> \\
    WMS_SIM_PRESERVE_FOREIGN_POSITION_GLOBAL_ID=<giv> \\
    node scripts/seed-wms-development-simulation.mjs --cleanup-preserve-warehouse

  node scripts/seed-wms-development-simulation.mjs --self-test

Optional:
  WMS_SIM_PIPELINE_ID=<uuid>       Select a pipeline in the supplied organization.
  WMS_SIM_ANCHOR_DATE=YYYY-MM-DD  Override the deterministic ${DEFAULT_ANCHOR_DATE} anchor.

Cleanup permanently retires the WMS development simulator lineage for the
organization. No scenario version can reseed that lineage afterward.

The preserve-warehouse cleanup is a narrow development recovery mode. It still
retires the exact 21-order scenario and writes compensating reservation ledger
entries, but retains one exact warehouse/printer/agent binding. Its one named
foreign proof position must already be inactive, unreserved, and cancelled.
Live preserve cleanup requires the trusted Railway project and development
environment IDs compiled into this tool. Disposable offline rehearsal requires
a local PostgreSQL URL, no populated RAILWAY_* marker, and:
  WMS_SIM_DISPOSABLE_REHEARSAL_CONFIRM=${PRESERVE_DISPOSABLE_REHEARSAL_CONFIRMATION}

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
  const preservePrinting = args.cleanupPreserveWarehouse
    ? validatePreservePrintingConfiguration(process.env)
    : null
  if (preservePrinting) {
    validatePreserveExecutionLane(process.env)
  }
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
      if (preservePrinting) {
        await assertExpectedDatabaseFingerprint(
          client,
          preservePrinting.expectedDatabaseFingerprint,
        )
      }
      const result = args.cleanup || args.cleanupPreserveWarehouse
        ? await cleanupScenario(
          client,
          configuration,
          scenario,
          preservePrinting,
        )
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
