#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'
import {
  SHIPPING_ONE_OFF_PACK_CATALOG_FINGERPRINT_SQL,
  SHIPPING_ONE_OFF_PACK_HEALTH_SQL,
  SHIPPING_ONE_OFF_PACK_POST_0325_CATALOG_HASH,
  SHIPPING_ONE_OFF_PACK_POST_0325_MIGRATION_CHECKSUM,
} from '../app_src/lib/persistence/shippingOneOffPackHealth.ts'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
const disposablePostgresImage = String(
  process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16',
).trim()
assert.ok(
  ['pgvector/pgvector:pg16', 'pgvector/pgvector:pg18'].includes(
    disposablePostgresImage,
  ),
  'CLAWPILOT_TEST_POSTGRES_IMAGE must select the exact pg16 or pg18 image',
)
const CONFIRMATION =
  'I CONFIRM THESE EXACT ITEMS ARE PHYSICALLY IN THESE PACKAGES'

async function waitForStablePostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
  let previousPostmasterStart = null
  let consecutiveMatches = 0
  let lastError = null
  while (Date.now() < deadline) {
    const probe = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 1_000,
      query_timeout: 1_000,
    })
    try {
      const result = await probe.query(
        'SELECT pg_postmaster_start_time()::text AS postmaster_start',
      )
      const postmasterStart = String(result.rows[0]?.postmaster_start || '')
      consecutiveMatches = postmasterStart === previousPostmasterStart
        ? consecutiveMatches + 1
        : 1
      previousPostmasterStart = postmasterStart
      if (postmasterStart && consecutiveMatches >= 2) return
    } catch (error) {
      lastError = error
      previousPostmasterStart = null
      consecutiveMatches = 0
    } finally {
      await probe.end().catch(() => undefined)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Disposable PostgreSQL TCP endpoint did not become stable: ${
      lastError instanceof Error ? lastError.message : 'unknown readiness error'
    }`,
  )
}

let databaseUrl = String(process.env.CLAWPILOT_SHIPPING_PACK_DATABASE_URL || '').trim()
if (!databaseUrl) {
  execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 })
  const container = `clawpilot-shipping-pack-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    execFileSync('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_shipping_pack',
      '-e', 'POSTGRES_DB=clawpilot_shipping_pack',
      '-p', '127.0.0.1::5432',
      disposablePostgresImage,
    ], { stdio: 'ignore', timeout: 180_000 })
    const portOutput = execFileSync('docker', ['port', container, '5432/tcp'], {
      encoding: 'utf8',
    })
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve disposable PostgreSQL port: ${portOutput}`)
    databaseUrl = `postgresql://postgres:clawpilot_shipping_pack@127.0.0.1:${port}/clawpilot_shipping_pack`
    await waitForStablePostgres(databaseUrl)
    execFileSync('node', ['scripts/db-migrate.mjs'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      stdio: 'inherit',
      timeout: 240_000,
    })
    execFileSync('node', ['scripts/test-shipping-one-off-pack-postgres.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        CLAWPILOT_SHIPPING_PACK_DATABASE_URL: databaseUrl,
        PGSSLMODE: 'disable',
      },
      stdio: 'inherit',
      timeout: 180_000,
    })
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      stdio: 'ignore',
      timeout: 20_000,
    })
  }
  process.exit(0)
}

const parsed = new URL(databaseUrl)
parsed.searchParams.delete('sslmode')
assert.ok(
  ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname),
  'Shipping pack acceptance is restricted to disposable local PostgreSQL.',
)
const pool = new Pool({
  connectionString: parsed.toString(),
  application_name: 'clawpilot-shipping-pack-acceptance',
  max: 8,
  connectionTimeoutMillis: 15_000,
  query_timeout: 120_000,
})

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function oneOffShipmentHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

class TestPersistenceError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function loadTypeScript(path, mocks) {
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: path,
      reportDiagnostics: true,
    },
  )
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], `${path} must transpile without syntax errors`)
  const module = { exports: {} }
  vm.runInNewContext(output.outputText, {
    Array, Boolean, Buffer, Date, Error, JSON, Map, Math, Number, Object,
    Promise, RegExp, Set, String, URL, console, exports: module.exports,
    module, process,
    require(specifier) {
      if (specifier === '@/lib/integrations/integrationCredentialRuntimeGate.mjs') {
        return integrationCredentialRuntimeGate
      }
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

let auditWrites = 0
let beforeTransactionCommit = null
let nextTransactionStarted = null
const postgres = {
  query(text, values = []) {
    return pool.query(text, values)
  },
  async acquireTransactionAdvisoryLock(client, key) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [key],
    )
  },
  async withTransaction(work) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const startedHook = nextTransactionStarted
      if (startedHook) {
        nextTransactionStarted = null
        await startedHook(client)
      }
      const result = await work(client)
      const hook = beforeTransactionCommit
      if (hook) {
        beforeTransactionCommit = null
        await hook(client)
      }
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  },
}

function captureNextTransactionBackendPid() {
  assert.equal(
    nextTransactionStarted,
    null,
    'Only one transaction PID capture may be armed at a time',
  )
  let resolvePid
  let rejectPid
  const pidPromise = new Promise((resolvePromise, rejectPromise) => {
    resolvePid = resolvePromise
    rejectPid = rejectPromise
  })
  nextTransactionStarted = async (client) => {
    try {
      const result = await client.query(
        'SELECT pg_backend_pid()::integer AS pid',
      )
      resolvePid(result.rows[0].pid)
    } catch (error) {
      rejectPid(error)
      throw error
    }
  }
  return Promise.race([
    pidPromise,
    new Promise((_, rejectPromise) => {
      setTimeout(
        () => rejectPromise(new Error('Timed out capturing contender backend PID')),
        5_000,
      )
    }),
  ])
}

async function backendPid(client) {
  const result = await client.query('SELECT pg_backend_pid()::integer AS pid')
  return result.rows[0].pid
}

async function waitForBackendLock({
  contenderPid,
  ownerPid,
  expectedLockType,
  message,
}) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const activity = await pool.query(
      `SELECT wait_event_type,
              wait_event,
              pg_blocking_pids(pid) AS blocking_pids
       FROM pg_stat_activity
       WHERE pid = $1::integer`,
      [contenderPid],
    )
    const row = activity.rows[0]
    if (row?.wait_event_type === 'Lock') {
      const waitingLocks = await pool.query(
        `SELECT locktype, mode, relation::regclass::text AS relation_name
         FROM pg_locks
         WHERE pid = $1::integer
           AND NOT granted
         ORDER BY locktype, mode`,
        [contenderPid],
      )
      assert.ok(
        row.blocking_pids.map(Number).includes(Number(ownerPid)),
        `${message}: contender must name the exact owner as its blocker`,
      )
      assert.ok(
        waitingLocks.rows.some((lock) => lock.locktype === expectedLockType),
        `${message}: expected ungranted ${expectedLockType} lock, saw ${JSON.stringify(waitingLocks.rows)}`,
      )
      return {
        waitEvent: row.wait_event,
        waitingLocks: waitingLocks.rows,
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  throw new Error(`${message}: contender never entered an observable lock wait`)
}

function printProfileAdapter() {
  return {
    async listOperationsPrinterProfilesInPostgres(organizationId, client) {
      const result = await client.query(
        `SELECT printer.id::text,
                printer.global_id,
                printer.warehouse_id::text,
                warehouse.global_id AS warehouse_global_id,
                warehouse.name AS warehouse_name,
                printer.code,
                printer.name,
                printer.station_type,
                printer.printer_type,
                printer.connection_mode,
                printer.supported_formats,
                printer.supported_media,
                printer.supported_document_types,
                printer.default_document_types,
                fallback.global_id AS fallback_printer_global_id,
                fallback.name AS fallback_printer_name,
                agent.global_id AS local_print_agent_global_id,
                agent.name AS local_print_agent_name,
                agent.status AS local_print_agent_status,
                agent.last_seen_at AS local_print_agent_last_seen_at,
                printer.priority,
                printer.status,
                printer.row_version,
                printer.last_seen_at,
                printer.updated_at
         FROM operations_printers printer
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = printer.organization_id
          AND warehouse.id = printer.warehouse_id
         LEFT JOIN operations_printers fallback
           ON fallback.organization_id = printer.organization_id
          AND fallback.id = printer.fallback_printer_id
         LEFT JOIN operations_print_agents agent
           ON agent.organization_id = printer.organization_id
          AND agent.warehouse_id = printer.warehouse_id
          AND agent.id = printer.local_print_agent_id
         WHERE printer.organization_id = $1::uuid
         ORDER BY printer.priority, printer.name`,
        [organizationId],
      )
      return result.rows.map((row) => ({
        id: row.id,
        globalId: row.global_id,
        warehouseId: row.warehouse_id,
        warehouseGlobalId: row.warehouse_global_id,
        warehouseName: row.warehouse_name,
        code: row.code,
        name: row.name,
        stationType: row.station_type,
        printerType: row.printer_type,
        connectionMode: row.connection_mode,
        supportedFormats: row.supported_formats,
        supportedMedia: row.supported_media,
        supportedDocumentTypes: row.supported_document_types,
        defaultDocumentTypes: row.default_document_types,
        fallbackPrinterGlobalId: row.fallback_printer_global_id,
        fallbackPrinterName: row.fallback_printer_name,
        localPrintAgentGlobalId: row.local_print_agent_global_id,
        localPrintAgentName: row.local_print_agent_name,
        localPrintAgentStatus: row.local_print_agent_status,
        localPrintAgentLastSeenAt: row.local_print_agent_last_seen_at
          ? new Date(row.local_print_agent_last_seen_at).toISOString()
          : null,
        priority: row.priority,
        status: row.status,
        rowVersion: row.row_version,
        lastSeenAt: row.last_seen_at
          ? new Date(row.last_seen_at).toISOString()
          : null,
        updatedAt: new Date(row.updated_at).toISOString(),
      }))
    },
  }
}

const persistence = loadTypeScript(
  'app_src/lib/persistence/shippingOneOffPack.ts',
  {
    '@/lib/auditWriter': {
      recordAuditEvent: async () => { auditWrites += 1 },
    },
    '@/lib/operations/oneOffShipments': { oneOffShipmentHash },
    '@/lib/operations/oneOffShipmentConstants': {
      ONE_OFF_PACK_CONFIRMATION: CONFIRMATION,
    },
    '@/lib/persistence/oneOffShipments': {
      OneOffShipmentPersistenceError: TestPersistenceError,
    },
    '@/lib/persistence/postgres': postgres,
  },
)
const printing = loadTypeScript('app_src/lib/operations/printing.ts', {})
const carrierManagedDelegation = loadTypeScript(
  'app_src/lib/integrations/carrierManagedDelegation.ts',
  {},
)
const requestErrorAdapter = {
  OperationsRequestError: TestPersistenceError,
}
const printPersistence = loadTypeScript(
  'app_src/lib/persistence/operationPrintDelivery.ts',
  {
    '@/lib/auditWriter': {
      recordAuditEvent: async () => { auditWrites += 1 },
    },
    '@/lib/integrations/carrierManagedDelegation': carrierManagedDelegation,
    '@/lib/operations/printing': printing,
    '@/lib/persistence/operations': requestErrorAdapter,
    '@/lib/persistence/operationPrinting': printProfileAdapter(),
    '@/lib/persistence/postgres': postgres,
  },
)
let carrierProviderWrites = 0
const rejectCarrierWrite = () => {
  carrierProviderWrites += 1
  throw new Error('Shipping print recovery attempted a carrier/provider write')
}
const executionPersistence = loadTypeScript(
  'app_src/lib/persistence/operationOneOffShipping.ts',
  {
    '@/lib/auditWriter': {
      recordAuditEvent: async () => { auditWrites += 1 },
    },
    '@/lib/integrations/carrierIntegrations': {
      resolveCarrierOneOffVoidRuntime: rejectCarrierWrite,
      resolveCarrierProductionShippingRuntime: rejectCarrierWrite,
      resolveCarrierSandboxShippingRuntime: rejectCarrierWrite,
    },
    '@/lib/integrations/carrierOneOffGroupShipment': {
      carrierOneOffGroupLifecycleMode: () => 'carrier_void',
      executeCarrierOneOffGroupShipment: rejectCarrierWrite,
      executeCarrierOneOffGroupVoid: rejectCarrierWrite,
      prepareCarrierOneOffGroupRequest: rejectCarrierWrite,
      prepareCarrierOneOffGroupVoidRequest: rejectCarrierWrite,
    },
    '@/lib/operations/oneOffShipments': {
      oneOffProviderLabel: (provider) => provider === 'fedex_rest'
        ? 'FedEx'
        : provider === 'wwex_speedship'
          ? 'Worldwide Express'
          : 'UPS',
      oneOffShipmentHash,
    },
    '@/lib/operations/packageCatalog': {
      defaultCanonicalPackageProfile: () => ({
        catalogEntryId: 'box',
        contractVersion: 'operations.package_catalog.v1',
      }),
    },
    '@/lib/persistence/operationPrintDelivery': printPersistence,
    '@/lib/operations/printing': printing,
    '@/lib/persistence/oneOffShipments': {
      OneOffShipmentPersistenceError: TestPersistenceError,
      quoteOneOffShipmentInPostgres: rejectCarrierWrite,
    },
    '@/lib/persistence/postgres': postgres,
    '@/lib/persistence/shippingOneOffPack': persistence,
  },
)

async function expectCode(work, code, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${message}: expected rejection`)
  if (code !== undefined) {
    assert.equal(error.code, code, `${message}: ${String(error.message || error)}`)
  }
  return error
}

async function shippingPackHealthIsGreen(client) {
  const result = await client.query(
    `SELECT (${SHIPPING_ONE_OFF_PACK_HEALTH_SQL}) AS healthy`,
  )
  return result.rows[0]?.healthy === true
}

async function exerciseHealthTamper() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal(
      await shippingPackHealthIsGreen(client),
      true,
      'Fresh 0304 checksum and exact catalog must be healthy',
    )
    const cases = [
      ['missing 0325 migration ledger', async () => {
        await client.query(
          `DELETE FROM public.schema_migrations
           WHERE filename =
             '0325_operations_shopify_fulfillment_reversal.sql'`,
        )
      }],
      ['wrong 0325 migration checksum', async () => {
        await client.query(
          `UPDATE public.schema_migrations SET checksum = repeat('0', 64)
           WHERE filename =
             '0325_operations_shopify_fulfillment_reversal.sql'`,
        )
      }],
      ['migration checksum', async () => {
        await client.query(
          `UPDATE schema_migrations SET checksum = repeat('0', 64)
           WHERE filename = '0304_shipping_one_off_pack_confirmation.sql'`,
        )
      }],
      ['receipt validator replacement', async () => {
        await client.query(
          `CREATE OR REPLACE FUNCTION
             validate_operations_shipping_one_off_pack_receipt()
           RETURNS trigger LANGUAGE plpgsql AS $health$
           BEGIN RETURN NEW; END;
           $health$`,
        )
      }],
      ['exact plan execution authority replacement', async () => {
        await client.query(
          `CREATE OR REPLACE FUNCTION
             operations_one_off_plan_execution_is_exact(
               authority_organization_id uuid,
               authority_plan_id uuid,
               required_execution_mode text DEFAULT NULL
             )
           RETURNS boolean LANGUAGE sql STABLE AS $health$
             SELECT true
           $health$`,
        )
      }],
      ['disabled concurrent evidence fence', async () => {
        await client.query(
          `ALTER TABLE operations_fulfillment_allocations
           DISABLE TRIGGER protect_shipping_pack_allocation_evidence`,
        )
      }],
      ['reservation evidence body replacement', async () => {
        await client.query(
          `CREATE OR REPLACE FUNCTION
             protect_operations_shipping_one_off_pack_evidence()
           RETURNS trigger LANGUAGE plpgsql AS $health$
           BEGIN
             IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
             RETURN NEW;
           END;
           $health$`,
        )
      }],
      ['reservation fence WHEN false', async () => {
        await client.query(
          `DROP TRIGGER protect_shipping_pack_reservation_evidence
           ON operations_reservations`,
        )
        await client.query(
          `CREATE TRIGGER protect_shipping_pack_reservation_evidence
           BEFORE INSERT OR UPDATE OR DELETE ON operations_reservations
           FOR EACH ROW WHEN (false)
           EXECUTE FUNCTION
             protect_operations_shipping_one_off_pack_evidence()`,
        )
      }],
      ['extra protected-table trigger', async () => {
        await client.query(
          `CREATE FUNCTION shipping_pack_health_extra_trigger()
           RETURNS trigger LANGUAGE plpgsql AS $health$
           BEGIN RETURN NEW; END;
           $health$`,
        )
        await client.query(
          `CREATE TRIGGER shipping_pack_health_extra_trigger
           BEFORE INSERT ON operations_reservations
           FOR EACH ROW
           EXECUTE FUNCTION shipping_pack_health_extra_trigger()`,
        )
      }],
      ['weakened receipt snapshot constraint', async () => {
        await client.query(
          `ALTER TABLE operations_shipping_one_off_pack_receipts
           DROP CONSTRAINT operations_shipping_one_off_pack_receipts_snapshot_valid`,
        )
        await client.query(
          `ALTER TABLE operations_shipping_one_off_pack_receipts
           ADD CONSTRAINT operations_shipping_one_off_pack_receipts_snapshot_valid
           CHECK (true)`,
        )
      }],
    ]
    for (const [label, tamper] of cases) {
      await client.query('SAVEPOINT shipping_pack_health_tamper')
      await tamper()
      assert.equal(
        await shippingPackHealthIsGreen(client),
        false,
        `${label} must make exact Shipping pack health red`,
      )
      await client.query('ROLLBACK TO SAVEPOINT shipping_pack_health_tamper')
      await client.query('RELEASE SAVEPOINT shipping_pack_health_tamper')
      assert.equal(
        await shippingPackHealthIsGreen(client),
        true,
        `${label} rollback must restore exact Shipping pack health`,
      )
    }
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

const ids = Object.fromEntries([
  'organization', 'otherOrganization', 'pipeline', 'customer',
  'nativeIntegration', 'carrierIntegration', 'carrierAccount', 'warehouse',
  'inventoryPool', 'receivingLocation',
].map((key) => [key, randomUUID()]))
const actorEmail = 'shipping-only-pack@example.test'
const destination = {
  name: 'Bakery Bites recipient',
  line1: '100 Test Street',
  city: 'Boston',
  region: 'MA',
  postalCode: '02108',
  countryCode: 'US',
  residential: false,
}
const warehouseAddress = {
  name: 'Bakery Bites test warehouse',
  line1: '7009 S 108th Street',
  city: 'La Vista',
  region: 'NE',
  postalCode: '68128',
  countryCode: 'US',
  phone: '4025550100',
  residential: false,
}

function code(prefix, index) {
  return `${prefix}${String(9_400_000 + index).padStart(7, '0')}`
}

function fixture(index, kind, packageStatus = 'planned') {
  return {
    index,
    kind,
    packageStatus,
    product: randomUUID(),
    quote: randomUUID(),
    offer: randomUUID(),
    rateRequest: randomUUID(),
    order: randomUUID(),
    line: randomUUID(),
    plan: randomUUID(),
    rate: randomUUID(),
    package: randomUUID(),
    content: randomUUID(),
    position: randomUUID(),
    reservation: randomUUID(),
    allocation: randomUUID(),
    group: randomUUID(),
    lineKey: `line-${index}`,
    orderGlobalId: code('gor', index),
    productGlobalId: code('gp', index),
    quoteGlobalId: code('goq', index),
    offerGlobalId: code('goo', index),
    planGlobalId: code('gfp', index),
    packageGlobalId: code('gpa', index),
    positionGlobalId: code('giv', index),
    reservationGlobalId: code('grs', index),
    allocationGlobalId: code('gfa', index),
    rateGlobalId: code('grt', index),
    rateEvidenceGlobalId: code('grq', index),
  }
}

const existing = fixture(1, 'existing')
const createdProduct = fixture(2, 'new')
const labeled = fixture(3, 'existing', 'labeled')
const shipped = fixture(4, 'existing', 'shipped')
const unresolved = fixture(5, 'existing')
const adHoc = fixture(6, 'ad_hoc', 'packed')
const writerFirst = fixture(7, 'existing')
const idempotencyRaceA = fixture(8, 'existing')
const idempotencyRaceB = fixture(9, 'new')
const lockProbe = fixture(10, 'existing')
const lockProbeExtraLine = randomUUID()

async function seedBase(client) {
  await client.query('SET LOCAL session_replication_role = replica')
  await client.query(
    `INSERT INTO app_users (email, role, permissions, status, contact_reference_code)
     VALUES ($1, 'member', $2::jsonb, 'active', 'gc9400001')`,
    [actorEmail, JSON.stringify({
      viewShipping: true,
      createShipments: true,
      purchaseLivePostage: false,
      viewOperations: false,
      executeWarehouse: false,
    })],
  )
  await client.query(
    `INSERT INTO workspace_organizations (
       id, name, organization_type, reference_code
     ) VALUES
       ($1, 'Test Pro Bakery Bites', 'member', 'ga9400001'),
       ($2, 'Unrelated organization', 'member', 'ga9400002')`,
    [ids.organization, ids.otherOrganization],
  )
  await client.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status
     ) VALUES ($1, $2, 'member', $3::jsonb, 'active')`,
    [actorEmail, ids.organization, JSON.stringify({
      viewShipping: true,
      createShipments: true,
      purchaseLivePostage: false,
      viewOperations: false,
      executeWarehouse: false,
    })],
  )
  await client.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, workspace_organization_id
     ) VALUES ($1, 'Bakery Bites Shipping', $2, $3)`,
    [ids.pipeline, actorEmail, ids.organization],
  )
  await client.query(
    `INSERT INTO crm_organizations (
       id, pipeline_id, source_key, name, source_hash, identity_key,
       workspace_organization_id, relationship_type, reference_code
     ) VALUES (
       $1, $2, 'shipping-pack-customer', 'Bakery Bites customer',
       $3, 'shipping-pack-customer', $4, 'customer', 'ga9400003'
     )`,
    [ids.customer, ids.pipeline, '0'.repeat(64), ids.organization],
  )
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type,
       environment, display_name, status, configuration
     ) VALUES
       ($1, 'gia9400001', $3, 'clawpilot_native', 'commerce', 'mock',
        'ClawPilot native', 'active', '{}'::jsonb),
       ($2, 'gia9400002', $3, 'ups_rest', 'carrier', 'sandbox',
        'UPS sandbox', 'active', '{}'::jsonb)`,
    [ids.nativeIntegration, ids.carrierIntegration, ids.organization],
  )
  await client.query(
    `INSERT INTO operations_warehouses (
       id, global_id, organization_id, code, name, address, status
     ) VALUES (
       $1, 'gwh9400001', $2, 'BAKERY', 'Bakery Bites warehouse',
       $3::jsonb, 'active'
     )`,
    [ids.warehouse, ids.organization, JSON.stringify(warehouseAddress)],
  )
  await client.query(
    `INSERT INTO operations_inventory_pools (
       id, global_id, organization_id, pipeline_id, owner_customer_id,
       name, pool_type
     ) VALUES (
       $1, 'gip9400001', $2, $3, $4, 'Bakery Bites inventory',
       'customer_dedicated'
     )`,
    [ids.inventoryPool, ids.organization, ids.pipeline, ids.customer],
  )
  await client.query(
    `INSERT INTO operations_locations (
       id, global_id, organization_id, warehouse_id, code, zone,
       location_type, storage_function
     ) VALUES (
       $1, 'gwl9400001', $2, $3, 'SHIP-ONE-OFF', 'SHIPPING',
       'staging', 'work_area'
     )`,
    [ids.receivingLocation, ids.organization, ids.warehouse],
  )
  await client.query(
    `INSERT INTO operations_carrier_accounts (
       id, global_id, organization_id, integration_account_id, display_name,
       account_number_ciphertext, account_number_iv, account_number_tag,
       account_number_last_four, account_number_fingerprint,
       registered_address, registered_address_fingerprint, status, sender_name
     ) VALUES (
       $1, 'gac9400001', $2, $3, 'UPS sandbox', 'fixture', 'fixture',
       'fixture', '0001', $4, $5::jsonb, $4, 'active', 'Bakery Bites'
     )`,
    [
      ids.carrierAccount, ids.organization, ids.carrierIntegration,
      'a'.repeat(64), JSON.stringify(warehouseAddress),
    ],
  )
}

function sealedLine(item) {
  if (item.kind === 'existing') {
    return {
      kind: 'existing',
      lineKey: item.lineKey,
      productGlobalId: item.productGlobalId,
      productName: `Bakery item ${item.index}`,
      sku: `BAKERY-${item.index}`,
      quantity: 1,
      unitPriceMinor: 1200 + item.index,
      unitWeightGrams: 500 + item.index,
      unitDimensionsMm: { length: 200, width: 150, height: 80 },
    }
  }
  if (item.kind === 'new') {
    return {
      kind: 'new',
      lineKey: item.lineKey,
      productName: `Bakery item ${item.index}`,
      sku: `BAKERY-${item.index}`,
      quantity: 1,
      unitPriceMinor: 1200 + item.index,
      unitWeightGrams: 500 + item.index,
      unitDimensionsMm: { length: 200, width: 150, height: 80 },
      physicalUnitsOnHandConfirmed: true,
    }
  }
  return {
    kind: 'ad_hoc',
    lineKey: item.lineKey,
    productName: 'One-time tasting kit',
    sku: '',
    quantity: 1,
    unitPriceMinor: 1500,
    unitWeightGrams: 600,
    unitDimensionsMm: { length: 200, width: 150, height: 80 },
  }
}

async function seedFixture(client, item, { unresolvedGroup = false } = {}) {
  const line = sealedLine(item)
  const packages = [{
    packageKey: `package-${item.index}`,
    description: `Parcel ${item.index}`,
    packageProfile: {
      catalogEntryId: 'box',
      contractVersion: 'operations.package_catalog.v1',
    },
    dimensionsMm: { length: 300, width: 220, height: 140 },
    grossWeightGrams: 1000 + item.index,
    allocations: [{ lineKey: item.lineKey, quantity: 1 }],
  }]
  const requestHash = oneOffShipmentHash({ fixture: item.index })
  const carrierRequestHash = createHash('sha256')
    .update(`carrier-${item.index}`).digest('hex')
  const carrierResponseHash = createHash('sha256')
    .update(`response-${item.index}`).digest('hex')
  const selectionKey = 'ups_rest:gia9400002:gac9400001:v1'
  const selection = {
    selectionKey,
    provider: 'ups_rest',
    integrationAccountGlobalId: 'gia9400002',
    carrierAccountGlobalId: 'gac9400001',
    credentialVersion: 1,
    packageCodes: [{
      packageKey: packages[0].packageKey,
      catalogEntryId: 'box',
      catalogVersion: 'operations.package_catalog.v1',
      providerPackageCode: '02',
    }],
  }
  const selectionResult = {
    status: 'succeeded',
    eligibleOfferCount: 1,
    errorCode: null,
  }

  if (item.kind !== 'ad_hoc') {
    await client.query(
      `INSERT INTO crm_products (
         id, pipeline_id, source_key, reference_code, name, sku, source_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        item.product, ids.pipeline, `shipping-pack-product-${item.index}`,
        item.productGlobalId, line.productName, line.sku,
        createHash('sha256').update(`product-${item.index}`).digest('hex'),
      ],
    )
  }
  await client.query(
    `INSERT INTO operations_carrier_rate_requests (
       id, global_id, organization_id, integration_account_id,
       carrier_account_id, provider, environment, purpose, adapter_version,
       credential_version, carrier_selection_key, request_hash,
       redacted_request, redacted_response, status, requested_at, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'ups_rest', 'sandbox',
       'cartonization_shipment_rate', 'fixture-v1', 1, $6, $7,
       $8::jsonb, $9::jsonb, 'succeeded', now(), now()
     )`,
    [
      item.rateRequest, item.rateEvidenceGlobalId, ids.organization,
      ids.carrierIntegration, ids.carrierAccount,
      selectionKey,
      carrierRequestHash,
      JSON.stringify({ shipment: { parcels: [{ packageKey: packages[0].packageKey }] } }),
      JSON.stringify({ rates: [{ serviceCode: '03', currency: 'USD', amount: '12.00' }] }),
    ],
  )
  await client.query(
    `INSERT INTO operations_one_off_shipment_quotes (
       id, global_id, organization_id, pipeline_id, customer_id, warehouse_id,
       inventory_pool_id, receiving_location_id, rate_environment,
       reference_number, currency, destination_snapshot, destination_hash,
       lines_snapshot, lines_hash, packages_snapshot, packages_hash,
       required_carrier_providers, provider_results_snapshot,
       required_transport_sources, transport_results_snapshot,
       required_carrier_selections, carrier_selection_results_snapshot,
       carrier_selection_schema_version, request_hash, status, idempotency_key,
       actor_email, expires_at, execution_mode
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 'sandbox', $9, 'USD',
       $10::jsonb, $11, $12::jsonb, $13, $14::jsonb, $15,
       ARRAY['ups_rest']::text[], $16::jsonb,
       ARRAY['ups_rest:small_parcel']::text[], $17::jsonb,
       $18::jsonb, $19::jsonb, 1, $20, 'succeeded', $21,
       $22, now() + interval '1 hour', 'test'
     )`,
    [
      item.quote, item.quoteGlobalId, ids.organization, ids.pipeline,
      item.kind === 'ad_hoc' ? null : ids.customer, ids.warehouse,
      item.kind === 'ad_hoc' ? null : ids.inventoryPool,
      item.kind === 'ad_hoc' ? null : ids.receivingLocation,
      `PACK-${item.index}`, JSON.stringify(destination),
      createHash('sha256').update(`destination-${item.index}`).digest('hex'),
      JSON.stringify([line]),
      createHash('sha256').update(JSON.stringify([line])).digest('hex'),
      JSON.stringify(packages),
      createHash('sha256').update(JSON.stringify(packages)).digest('hex'),
      JSON.stringify({ ups_rest: selectionResult }),
      JSON.stringify({ 'ups_rest:small_parcel': selectionResult }),
      JSON.stringify([selection]),
      JSON.stringify({ [selectionKey]: selectionResult }),
      requestHash, `shipping-pack-quote-${item.index}`, actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_one_off_shipment_quote_offers (
       id, global_id, organization_id, quote_id, integration_account_id,
       carrier_account_id, provider, environment, credential_version,
       carrier_selection_key, service_code, service_name, amount_minor,
       currency, transit_days, estimated_delivery_at, rate_evidence_global_id,
       carrier_request_hash, carrier_response_hash, offer_snapshot,
       transport_mode, handling_unit_mode, executing_carrier_code,
       executing_carrier_name
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'ups_rest', 'sandbox', 1, $7,
       '03', 'UPS Ground', 1200, 'USD', 3, now() + interval '3 days',
       $8, $9, $10, '{}'::jsonb,
       'small_parcel', 'loose_packages', 'UPS', 'UPS'
     )`,
    [
      item.offer, item.offerGlobalId, ids.organization, item.quote,
      ids.carrierIntegration, ids.carrierAccount,
      selectionKey,
      item.rateEvidenceGlobalId, carrierRequestHash, carrierResponseHash,
    ],
  )
  await client.query(
    `INSERT INTO operations_orders (
       id, global_id, organization_id, pipeline_id, customer_id,
       integration_account_id, source_provider, external_order_id,
       order_number, order_type, status, currency, merchandise_total_minor,
       ship_to, source_payload, row_version
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'clawpilot_native', $7, $8,
       'one_off', $9, 'USD', $10, $11::jsonb, '{}'::jsonb, 0
     )`,
    [
      item.order, item.orderGlobalId, ids.organization, ids.pipeline,
      item.kind === 'ad_hoc' ? null : ids.customer, ids.nativeIntegration,
      `shipping-pack-order-${item.index}`, `PACK-${item.index}`,
      item.kind === 'ad_hoc' ? 'packed' : 'planned', line.unitPriceMinor,
      JSON.stringify(destination),
    ],
  )
  if (item.kind !== 'ad_hoc') {
    await client.query(
      `INSERT INTO operations_order_lines (
         id, global_id, organization_id, order_id, pipeline_id, product_id,
         external_line_id, channel_sku, description, quantity,
         unit_price_minor, weight_grams, dimensions_mm
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12::jsonb
       )`,
      [
        item.line, code('gol', item.index), ids.organization, item.order,
        ids.pipeline, item.product, item.lineKey, line.sku, line.productName,
        line.unitPriceMinor, line.unitWeightGrams,
        JSON.stringify(line.unitDimensionsMm),
      ],
    )
  }
  await client.query(
    `INSERT INTO operations_one_off_shipment_quote_consumptions (
       organization_id, quote_id, order_id, offer_id, reason, consumed_by
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ids.organization, item.quote, item.order, item.offer,
      'Create exact Bakery Bites one-off fixture', actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_fulfillment_plans (
       id, global_id, organization_id, order_id, warehouse_id,
       version_number, status, method, solver_status, estimated_cost_minor,
       promised_delivery_at, explanation, one_off_quote_id, one_off_offer_id
     ) VALUES (
       $1, $2, $3, $4, $5, 1, 'planned', 'manual_override', 'optimal',
       1200, now() + interval '3 days', '{}'::jsonb, $6, $7
     )`,
    [
      item.plan, item.planGlobalId, ids.organization, item.order,
      ids.warehouse, item.quote, item.offer,
    ],
  )
  await client.query(
    `INSERT INTO operations_carrier_rates (
       id, global_id, organization_id, plan_id, carrier, service_code,
       service_name, internal_cost_minor, customer_charge_minor,
       transit_days, estimated_delivery_at, meets_promise, selected,
       quote_snapshot, one_off_quote_id, one_off_offer_id,
       one_off_rate_evidence_global_id, one_off_currency
     ) VALUES (
       $1, $2, $3, $4, 'ups', '03', 'UPS Ground', 1200, 1200, 3,
       now() + interval '3 days', true, true, '{}'::jsonb,
       $5, $6, $7, 'USD'
     )`,
    [
      item.rate, item.rateGlobalId, ids.organization, item.plan,
      item.quote, item.offer, item.rateEvidenceGlobalId,
    ],
  )
  await client.query(
    `INSERT INTO operations_packages (
       id, global_id, organization_id, plan_id, package_number,
       length_mm, width_mm, height_mm, weight_grams, status
     ) VALUES ($1, $2, $3, $4, 1, 300, 220, 140, $5, $6)`,
    [
      item.package, item.packageGlobalId, ids.organization, item.plan,
      packages[0].grossWeightGrams, item.packageStatus,
    ],
  )
  if (item.kind === 'ad_hoc') {
    const itemSnapshot = {
      kind: 'ad_hoc', lineKey: item.lineKey, name: line.productName,
      sku: null, quantity: 1, unitPriceMinor: line.unitPriceMinor,
      unitWeightGrams: line.unitWeightGrams,
      unitDimensionsMm: line.unitDimensionsMm,
    }
    const adHocLine = await client.query(
      `INSERT INTO operations_one_off_ad_hoc_order_lines (
         organization_id, quote_id, order_id, line_key, description,
         quantity, unit_price_minor, unit_weight_grams, unit_dimensions_mm,
         item_snapshot, item_snapshot_hash, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, 1, $6, $7, $8::jsonb, $9::jsonb, $10, $11
       ) RETURNING id::text`,
      [
        ids.organization, item.quote, item.order, item.lineKey,
        line.productName, line.unitPriceMinor, line.unitWeightGrams,
        JSON.stringify(line.unitDimensionsMm), JSON.stringify(itemSnapshot),
        oneOffShipmentHash(itemSnapshot), actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_one_off_ad_hoc_package_contents (
         organization_id, plan_id, order_id, package_id,
         ad_hoc_order_line_id, quantity, created_by
       ) VALUES ($1, $2, $3, $4, $5, 1, $6)`,
      [
        ids.organization, item.plan, item.order, item.package,
        adHocLine.rows[0].id, actorEmail,
      ],
    )
  } else {
    await client.query(
      `INSERT INTO operations_package_contents (
         id, organization_id, plan_id, order_id, package_id,
         order_line_id, quantity, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)`,
      [
        item.content, ids.organization, item.plan, item.order, item.package,
        item.line, actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_inventory_positions (
         id, global_id, organization_id, pipeline_id, warehouse_id,
         location_id, pool_id, product_id, on_hand_quantity,
         reserved_quantity, damaged_quantity, version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 10, 1, 0, 7)`,
      [
        item.position, item.positionGlobalId, ids.organization, ids.pipeline,
        ids.warehouse, ids.receivingLocation, ids.inventoryPool, item.product,
      ],
    )
    await client.query(
      `INSERT INTO operations_reservations (
         id, global_id, organization_id, order_id, order_line_id,
         position_id, quantity, status, idempotency_key, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'active', $7, $8)`,
      [
        item.reservation, item.reservationGlobalId, ids.organization,
        item.order, item.line, item.position,
        `shipping-pack-reservation-${item.index}`, actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_fulfillment_allocations (
         id, global_id, organization_id, plan_id, order_line_id,
         reservation_id, position_id, quantity
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
      [
        item.allocation, item.allocationGlobalId, ids.organization, item.plan,
        item.line, item.reservation, item.position,
      ],
    )
  }
  if (unresolvedGroup) {
    await client.query(
      `INSERT INTO operations_one_off_carrier_group_attempts (
         id, global_id, organization_id, order_id, plan_id,
         planning_quote_id, planning_offer_id, purchase_quote_id,
         purchase_offer_id, carrier_rate_id, integration_account_id,
         carrier_account_id, action, state, environment, provider,
         service_code, package_count, selected_amount_minor, currency,
         adapter_version, idempotency_key, request_hash, redacted_request,
         reason, actor_email
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $6, $7, $8, $9, $10,
         'create', 'prepared', 'sandbox', 'ups_rest', '03', 1, 1200,
         'USD', 'fixture-v1', $11, $12, '{}'::jsonb, $13, $14
       )`,
      [
        item.group, code('gocg', item.index), ids.organization, item.order,
        item.plan, item.quote, item.offer, item.rate,
        ids.carrierIntegration, ids.carrierAccount,
        `shipping-pack-group-${item.index}`,
        createHash('sha256').update(`group-${item.index}`).digest('hex'),
        'Unresolved carrier fixture blocks physical pack', actorEmail,
      ],
    )
  }
}

async function seedActivePrintRecoveryGroup(client, item) {
  const groupId = randomUUID()
  const labelId = randomUUID()
  const labelPayload = '^XA^FO20,20^FDPRINT RECOVERY^FS^XZ'
  const labelContentSha256 = createHash('sha256')
    .update(labelPayload, 'utf8')
    .digest('hex')
  const labelByteLength = Buffer.byteLength(labelPayload, 'utf8')
  const trackingNumber = `1ZPRINT${String(item.index).padStart(8, '0')}`
  const groupFixtureKey = `shipping-print-group-fixture-${item.index}`
  const providerLabelId = `shipping-print-provider-label-${item.index}`
  await client.query(
    `UPDATE operations_packages
     SET status = 'labeled'
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [ids.organization, item.package],
  )
  await client.query(
    `INSERT INTO operations_one_off_carrier_group_attempts (
       id, organization_id, order_id, plan_id,
       planning_quote_id, planning_offer_id,
       purchase_quote_id, purchase_offer_id, carrier_rate_id,
       integration_account_id, carrier_account_id,
       action, state, environment, provider, service_code, package_count,
       selected_amount_minor, currency, adapter_version, idempotency_key,
       request_hash, redacted_request, redacted_response,
       master_tracking_number, provider_shipment_id, provider_reference,
       reason, actor_email, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, $6::uuid, $5::uuid, $6::uuid, $7::uuid,
       $8::uuid, $9::uuid,
       'create', 'succeeded', 'sandbox', 'ups_rest', '03', 1,
       1200, 'USD', 'shipping-print-recovery-fixture-v1', $10,
       $11, $12::jsonb, $13::jsonb,
       $15, $16, $16,
       'Seed exact immutable label for Shipping print recovery', $14, now()
     )`,
    [
      groupId,
      ids.organization,
      item.order,
      item.plan,
      item.quote,
      item.offer,
      item.rate,
      ids.carrierIntegration,
      ids.carrierAccount,
      groupFixtureKey,
      createHash('sha256').update(groupFixtureKey).digest('hex'),
      JSON.stringify({ fixture: 'shipping-print-recovery' }),
      JSON.stringify({ fixture: 'shipping-print-recovery', succeeded: true }),
      actorEmail,
      trackingNumber,
      `shipping-print-provider-fixture-${item.index}`,
    ],
  )
  await client.query(
    `INSERT INTO operations_one_off_carrier_group_members (
       organization_id, carrier_group_attempt_id, order_id, plan_id,
       package_id, package_number, quote_package_key,
       length_mm, width_mm, height_mm, weight_grams,
       allocated_selected_cost_minor, parcel_snapshot_hash
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, 1, $6, 300, 220, 140, $7,
       1200, $8
     )`,
    [
      ids.organization,
      groupId,
      item.order,
      item.plan,
      item.package,
      `package-${item.index}`,
      1000 + item.index,
      createHash('sha256').update('shipping-print-parcel').digest('hex'),
    ],
  )
  const label = await client.query(
    `INSERT INTO operations_labels (
       id, organization_id, package_id, carrier_rate_id,
       carrier, service_code, tracking_number, format, label_payload,
       provider_label_id, idempotency_key, status,
       integration_account_id, carrier_account_id, environment,
       request_hash, redacted_provider_evidence,
       one_off_carrier_group_attempt_id
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       'UPS', '03', $11, 'ZPL', $5,
       $12, $13,
       'created', $6::uuid, $7::uuid, 'sandbox', $8, $9::jsonb, $10::uuid
     )
     RETURNING global_id`,
    [
      labelId,
      ids.organization,
      item.package,
      item.rate,
      labelPayload,
      ids.carrierIntegration,
      ids.carrierAccount,
      createHash('sha256').update(
        `shipping-print-label-${item.index}`,
      ).digest('hex'),
      JSON.stringify({
        provider: 'ups_rest',
        packageNumber: 1,
        labelContentSha256,
        labelByteLength,
      }),
      groupId,
      trackingNumber,
      providerLabelId,
      `shipping-print-label-fixture-${item.index}`,
    ],
  )
  await client.query(
    `INSERT INTO operations_one_off_carrier_group_results (
       organization_id, carrier_group_attempt_id, package_id,
       package_number, label_id, tracking_number,
       provider_package_reference, redacted_provider_evidence
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 1, $4::uuid,
       $5, $6, $7::jsonb
     )`,
    [
      ids.organization,
      groupId,
      item.package,
      labelId,
      trackingNumber,
      providerLabelId,
      JSON.stringify({
        provider: 'ups_rest',
        packageNumber: 1,
        contentSha256: labelContentSha256,
        byteLength: labelByteLength,
      }),
    ],
  )
  return {
    groupId,
    labelId,
    labelGlobalId: label.rows[0].global_id,
  }
}

async function installShippingPrintRoute(client) {
  const agent = await client.query(
    `INSERT INTO operations_print_agents (
       organization_id, warehouse_id, name, secret_hash,
       request_fingerprint, idempotency_key, status, enrolled_by,
       last_seen_at, supported_formats, supported_media,
       supported_document_types
     ) VALUES (
       $1::uuid, $2::uuid, 'Shipping recovery test agent', $3,
       $4, 'shipping-print-agent-fixture', 'active', $5, now(),
       ARRAY['ZPL']::text[], ARRAY['label_4x6']::text[],
       ARRAY['shipping_label']::text[]
     )
     RETURNING id::text, global_id`,
    [
      ids.organization,
      ids.warehouse,
      createHash('sha256').update('shipping-print-secret').digest('hex'),
      createHash('sha256').update('shipping-print-agent').digest('hex'),
      actorEmail,
    ],
  )
  const printer = await client.query(
    `INSERT INTO operations_printers (
       organization_id, warehouse_id, code, name, station_type,
       supports_zpl, priority, status, created_by,
       printer_type, connection_mode, supported_formats, supported_media,
       supported_document_types, default_document_types,
       local_print_agent_id
     ) VALUES (
       $1::uuid, $2::uuid, 'SHIP-RECOVERY', 'Shipping recovery printer',
       'shipping', true, 1, 'online', $3,
       'thermal', 'local_agent', ARRAY['ZPL']::text[],
       ARRAY['label_4x6']::text[], ARRAY['shipping_label']::text[],
       ARRAY['shipping_label']::text[], $4::uuid
     )
     RETURNING id::text, global_id`,
    [ids.organization, ids.warehouse, actorEmail, agent.rows[0].id],
  )
  return {
    agentId: agent.rows[0].id,
    agentGlobalId: agent.rows[0].global_id,
    printerId: printer.rows[0].id,
    printerGlobalId: printer.rows[0].global_id,
  }
}

async function forcePrintOutcome(jobGlobalId, route, input) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    const job = await client.query(
      `SELECT job.id::text, job.printer_id::text,
              COALESCE(max(attempt.sequence_number), 0)::integer AS sequence
       FROM operations_print_jobs job
       LEFT JOIN operations_print_delivery_attempts attempt
         ON attempt.organization_id = job.organization_id
        AND attempt.print_job_id = job.id
       WHERE job.organization_id = $1::uuid AND job.global_id = $2
       GROUP BY job.id, job.printer_id`,
      [ids.organization, jobGlobalId],
    )
    assert.equal(job.rowCount, 1)
    const row = job.rows[0]
    const sequence = row.sequence + 1
    if (input.status === 'delivered') {
      await client.query(
        `INSERT INTO operations_print_delivery_attempts (
           organization_id, print_job_id, printer_id,
           attempt_number, sequence_number, state, actor_type,
           print_agent_id, idempotency_key, request_fingerprint,
           detail, device_job_reference, delivery_evidence,
           physical_output_verified
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid,
           $4, $5, 'delivered', 'local_print_agent',
           $6::uuid, $7, $8,
           'Certain local printer acknowledgement',
           'local-device.legacy.v1.redacted',
           'local_agent_acknowledgement', false
         )`,
        [
          ids.organization,
          row.id,
          row.printer_id,
          input.attempts,
          sequence,
          route.agentId,
          `shipping-print-delivered-${randomUUID()}`,
          createHash('sha256').update(`delivered-${randomUUID()}`).digest('hex'),
        ],
      )
      await client.query(
        `UPDATE operations_print_jobs
         SET status = 'delivered', attempts = $3, max_attempts = $4,
             delivered_at = now(), last_error = NULL,
             claimed_by_print_agent_id = NULL,
             current_claim_attempt_id = NULL, claim_expires_at = NULL
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, row.id, input.attempts, input.maxAttempts],
      )
    } else {
      const errorCode = input.uncertain
        ? 'PRINT_OUTCOME_UNCERTAIN'
        : input.errorCode || 'PRINTER_UNAVAILABLE'
      await client.query(
        `INSERT INTO operations_print_delivery_attempts (
           organization_id, print_job_id, printer_id,
           attempt_number, sequence_number, state, actor_type,
           idempotency_key, request_fingerprint,
           detail, error_code, error_message, physical_output_verified
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid,
           $4, $5, 'failed', 'system', $6, $7,
           'Certain zero-output Shipping recovery fixture', $8, $9, false
         )`,
        [
          ids.organization,
          row.id,
          row.printer_id,
          input.attempts,
          sequence,
          `shipping-print-failed-${randomUUID()}`,
          createHash('sha256').update(`failed-${randomUUID()}`).digest('hex'),
          errorCode,
          input.uncertain
            ? 'The physical output outcome is deliberately uncertain'
            : 'The printer did not accept any physical output',
        ],
      )
      await client.query(
        `UPDATE operations_print_jobs
         SET status = 'failed', attempts = $3, max_attempts = $4,
             delivered_at = NULL, last_error = $5,
             claimed_by_print_agent_id = NULL,
             current_claim_attempt_id = NULL, claim_expires_at = NULL
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [
          ids.organization,
          row.id,
          input.attempts,
          input.maxAttempts,
          errorCode,
        ],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function printRecoveryInput(state, label, key, reason) {
  return {
    organizationId: ids.organization,
    actorEmail,
    idempotencyKey: key,
    orderGlobalId: state.orderGlobalId,
    expectedRowVersion: state.rowVersion,
    packageGlobalId: label.packageGlobalId,
    labelGlobalId: label.labelGlobalId,
    expectedRecoveryAction: label.printRecoveryAction
      || (label.printJobGlobalId ? 'retry' : 'enqueue'),
    expectedPrintJobGlobalId: label.printJobGlobalId,
    expectedPrintJobStatus: label.printJobStatus,
    expectedPrintArtifactGlobalId: label.printArtifactGlobalId,
    expectedPrintAttempts: label.printAttempts,
    expectedPrintMaxAttempts: label.printMaxAttempts,
    expectedLatestAttemptSequenceNumber:
      label.printLatestAttemptSequenceNumber,
    expectedLatestErrorCode: label.printLatestErrorCode,
    reason,
  }
}

async function snapshotReservation(item) {
  const result = await pool.query(
    `SELECT reservation.id::text, reservation.global_id,
            reservation.quantity::text, reservation.status,
            reservation.position_id::text, position.on_hand_quantity::text,
            position.reserved_quantity::text, position.damaged_quantity::text,
            position.version::text
     FROM operations_reservations reservation
     JOIN operations_inventory_positions position
       ON position.organization_id = reservation.organization_id
      AND position.id = reservation.position_id
     WHERE reservation.organization_id = $1 AND reservation.order_id = $2`,
    [ids.organization, item.order],
  )
  return JSON.parse(JSON.stringify(result.rows))
}

async function insertAdditionalPosition(client, item, lotCode) {
  const result = await client.query(
    `INSERT INTO operations_inventory_positions (
       id, organization_id, pipeline_id, warehouse_id, location_id,
       pool_id, product_id, lot_code, on_hand_quantity,
       reserved_quantity, damaged_quantity, version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 10, 1, 0, 11)
     RETURNING id::text, global_id`,
    [
      randomUUID(), ids.organization, ids.pipeline, ids.warehouse,
      ids.receivingLocation, ids.inventoryPool, item.product, lotCode,
    ],
  )
  return result.rows[0]
}

async function insertAdditionalReservation(client, item, position, key) {
  return client.query(
    `INSERT INTO operations_reservations (
       organization_id, order_id, order_line_id, position_id, quantity,
       status, idempotency_key, created_by
     ) VALUES ($1, $2, $3, $4, 1, 'active', $5, $6)
     RETURNING id::text, global_id`,
    [
      ids.organization, item.order, item.line, position.id, key, actorEmail,
    ],
  )
}

function commandInput(item, review, key) {
  return {
    organizationId: ids.organization,
    actorEmail,
    idempotencyKey: key,
    orderGlobalId: item.orderGlobalId,
    expectedRowVersion: 0,
    expectedReviewSnapshotHash: review.evidenceHash,
    confirmation: CONFIRMATION,
    reason: 'Physically reviewed the exact Bakery Bites parcel contents',
  }
}

function orderAdvisoryKey(item) {
  return `shipping:one-off-pack:${ids.organization}:${item.orderGlobalId}`
}

function waitFor(promise, label, timeoutMs = 3_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs,
    )),
  ])
}

const evidenceWriterCases = [
  {
    label: 'order lines',
    item: lockProbe,
    immutable: false,
    write: (client) => client.query(
      `UPDATE operations_order_lines SET description = description
       WHERE organization_id = $1 AND id = $2`,
      [ids.organization, lockProbe.line],
    ),
    lockRow: (client) => client.query(
      `SELECT id FROM operations_order_lines
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ids.organization, lockProbe.line],
    ),
  },
  {
    label: 'fulfillment allocations',
    item: lockProbe,
    immutable: false,
    write: (client) => client.query(
      `UPDATE operations_fulfillment_allocations SET quantity = quantity
       WHERE organization_id = $1 AND id = $2`,
      [ids.organization, lockProbe.allocation],
    ),
    lockRow: (client) => client.query(
      `SELECT id FROM operations_fulfillment_allocations
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ids.organization, lockProbe.allocation],
    ),
  },
  {
    label: 'reservations',
    item: lockProbe,
    immutable: false,
    write: (client) => client.query(
      `UPDATE operations_reservations SET quantity = quantity
       WHERE organization_id = $1 AND id = $2`,
      [ids.organization, lockProbe.reservation],
    ),
    lockRow: (client) => client.query(
      `SELECT id FROM operations_reservations
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ids.organization, lockProbe.reservation],
    ),
  },
  {
    label: 'package contents',
    item: lockProbe,
    immutable: false,
    write: (client) => client.query(
      `INSERT INTO operations_package_contents (
         id, organization_id, plan_id, order_id, package_id,
         order_line_id, quantity, created_by
       ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 1, $6)`,
      [
        ids.organization, lockProbe.plan, lockProbe.order, lockProbe.package,
        lockProbeExtraLine, actorEmail,
      ],
    ),
    lockRow: (client) => client.query(
      `SELECT id FROM operations_package_contents
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ids.organization, lockProbe.content],
    ),
  },
  {
    label: 'ad-hoc order lines',
    item: adHoc,
    immutable: true,
    write: (client) => client.query(
      `UPDATE operations_one_off_ad_hoc_order_lines
       SET description = description
       WHERE organization_id = $1 AND order_id = $2`,
      [ids.organization, adHoc.order],
    ),
    lockRow: (client) => client.query(
      `SELECT id FROM operations_one_off_ad_hoc_order_lines
       WHERE organization_id = $1 AND order_id = $2 FOR UPDATE`,
      [ids.organization, adHoc.order],
    ),
  },
  {
    label: 'ad-hoc package contents',
    item: adHoc,
    immutable: true,
    write: (client) => client.query(
      `UPDATE operations_one_off_ad_hoc_package_contents
       SET quantity = quantity
       WHERE organization_id = $1 AND order_id = $2`,
      [ids.organization, adHoc.order],
    ),
    lockRow: (client) => client.query(
      `SELECT id FROM operations_one_off_ad_hoc_package_contents
       WHERE organization_id = $1 AND order_id = $2 FOR UPDATE`,
      [ids.organization, adHoc.order],
    ),
  },
]

async function exerciseEvidenceLockOrdering() {
  for (const evidenceCase of evidenceWriterCases) {
    const writer = await pool.connect()
    const pack = await pool.connect()
    let writerOpen = false
    let packOpen = false
    try {
      await writer.query('BEGIN')
      writerOpen = true
      let writerError = null
      try {
        await evidenceCase.write(writer)
      } catch (error) {
        writerError = error
      }
      if (evidenceCase.immutable) {
        assert.ok(writerError, `${evidenceCase.label} must retain prior immutability`)
        assert.notEqual(writerError.code, '40P01')
        assert.notEqual(writerError.code, '40001')
        await writer.query('ROLLBACK')
        writerOpen = false
        await pack.query('BEGIN')
        packOpen = true
        await waitFor(pack.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [orderAdvisoryKey(evidenceCase.item)],
        ), `${evidenceCase.label} writer-first advisory acquisition`)
        await pack.query('ROLLBACK')
        packOpen = false
        continue
      }
      assert.equal(writerError, null, `${evidenceCase.label} writer-first update`)
      await pack.query('BEGIN')
      packOpen = true
      let packLockSettled = false
      const packLock = pack.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [orderAdvisoryKey(evidenceCase.item)],
      ).then(
        (result) => { packLockSettled = true; return result },
        (error) => { packLockSettled = true; throw error },
      )
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      assert.equal(
        packLockSettled,
        false,
        `${evidenceCase.label} pack must serialize behind a writer-first fence`,
      )
      await writer.query('ROLLBACK')
      writerOpen = false
      await waitFor(packLock, `${evidenceCase.label} writer-first pack lock`)
      await waitFor(
        evidenceCase.lockRow(pack),
        `${evidenceCase.label} writer-first pack tuple lock`,
      )
      await pack.query('ROLLBACK')
      packOpen = false
    } finally {
      if (writerOpen) await writer.query('ROLLBACK').catch(() => undefined)
      if (packOpen) await pack.query('ROLLBACK').catch(() => undefined)
      writer.release()
      pack.release()
    }

    const packFirst = await pool.connect()
    const losingWriter = await pool.connect()
    let packFirstOpen = false
    let losingWriterOpen = false
    try {
      await packFirst.query('BEGIN')
      packFirstOpen = true
      await packFirst.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [orderAdvisoryKey(evidenceCase.item)],
      )
      await losingWriter.query('BEGIN')
      losingWriterOpen = true
      let outcome = null
      try {
        await waitFor(
          evidenceCase.write(losingWriter),
          `${evidenceCase.label} pack-first writer conflict`,
        )
      } catch (error) {
        outcome = error
      }
      assert.ok(outcome, `${evidenceCase.label} pack-first writer must reject`)
      assert.notEqual(outcome.code, '40P01', `${evidenceCase.label} cannot deadlock`)
      assert.notEqual(outcome.code, '40001', `${evidenceCase.label} cannot leak serialization`)
      if (!evidenceCase.immutable) {
        assert.equal(outcome.code, '55P03')
        assert.equal(
          outcome.message,
          'OPERATIONS_SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY',
        )
      }
      await losingWriter.query('ROLLBACK')
      losingWriterOpen = false
      await waitFor(
        evidenceCase.lockRow(packFirst),
        `${evidenceCase.label} pack-first tuple lock`,
      )
      await packFirst.query('ROLLBACK')
      packFirstOpen = false
    } finally {
      if (losingWriterOpen) {
        await losingWriter.query('ROLLBACK').catch(() => undefined)
      }
      if (packFirstOpen) await packFirst.query('ROLLBACK').catch(() => undefined)
      losingWriter.release()
      packFirst.release()
    }
  }
}

const setup = await pool.connect()
try {
  await setup.query('BEGIN')
  await seedBase(setup)
  for (const item of [
    existing, createdProduct, labeled, shipped, unresolved, adHoc, writerFirst,
    idempotencyRaceA, idempotencyRaceB,
    lockProbe,
  ]) {
    await seedFixture(setup, item, { unresolvedGroup: item === unresolved })
  }
  await setup.query(
    `INSERT INTO operations_order_lines (
       id, global_id, organization_id, order_id, pipeline_id, product_id,
       external_line_id, channel_sku, description, quantity,
       unit_price_minor, weight_grams, dimensions_mm
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'lock-probe-extra-line',
       'LOCK-PROBE', 'Lock probe package-content line', 1, 100, 100,
       '{"length":100,"width":100,"height":100}'::jsonb
     )`,
    [
      lockProbeExtraLine, code('gol', 110), ids.organization, lockProbe.order,
      ids.pipeline, lockProbe.product,
    ],
  )
  await setup.query(
    `INSERT INTO operations_orders (
       id, global_id, organization_id, pipeline_id, customer_id,
       integration_account_id, source_provider, external_order_id,
       order_number, order_type, status, currency, merchandise_total_minor,
       ship_to, source_payload
     ) VALUES (
       $1, 'gor9400099', $2, $3, $4, $5, 'shopify',
       'imported-order', 'IMPORTED', 'standard', 'planned', 'USD', 1000,
       $6::jsonb, '{}'::jsonb
     )`,
    [
      randomUUID(), ids.organization, ids.pipeline, ids.customer,
      ids.nativeIntegration, JSON.stringify(destination),
    ],
  )
  await setup.query('SET LOCAL session_replication_role = origin')
  await setup.query('COMMIT')
} catch (error) {
  await setup.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  setup.release()
}

try {
  const fulfillmentReversalLedger = await pool.query(
    `SELECT checksum
     FROM public.schema_migrations
     WHERE filename =
       '0325_operations_shopify_fulfillment_reversal.sql'`,
  )
  assert.deepEqual(fulfillmentReversalLedger.rows, [{
    checksum: SHIPPING_ONE_OFF_PACK_POST_0325_MIGRATION_CHECKSUM,
  }])
  const healthFingerprint = await pool.query(
    SHIPPING_ONE_OFF_PACK_CATALOG_FINGERPRINT_SQL,
  )
  if (process.env.CLAWPILOT_PRINT_SHIPPING_PACK_HEALTH === '1') {
    console.log('SHIPPING_PACK_HEALTH_FINGERPRINT', healthFingerprint.rows[0])
  }
  assert.deepEqual(healthFingerprint.rows[0], {
    artifact_count: 75,
    artifact_hash: SHIPPING_ONE_OFF_PACK_POST_0325_CATALOG_HASH,
  })
  await exerciseHealthTamper()
  const exact = await pool.query(
    `SELECT source_order.global_id,
            operations_one_off_plan_execution_is_exact(
              plan.organization_id, plan.id, 'test'
            ) AS exact_execution,
            operations_one_off_plan_package_set_is_exact(
              plan.organization_id, plan.id, plan.one_off_quote_id
            ) AS exact_packages
     FROM operations_orders source_order
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = source_order.organization_id
      AND plan.order_id = source_order.id
     WHERE source_order.organization_id = $1
       AND source_order.global_id = ANY($2::text[])
     ORDER BY source_order.global_id`,
    [ids.organization, [
      existing.orderGlobalId, createdProduct.orderGlobalId,
      labeled.orderGlobalId, shipped.orderGlobalId, unresolved.orderGlobalId,
      adHoc.orderGlobalId, writerFirst.orderGlobalId,
      idempotencyRaceA.orderGlobalId, idempotencyRaceB.orderGlobalId,
    ]],
  )
  assert.equal(exact.rowCount, 9)
  assert.ok(exact.rows.every((row) => row.exact_execution && row.exact_packages))
  await exerciseEvidenceLockOrdering()

  await expectCode(
    () => persistence.readShippingOneOffPackReviewFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: 'gor9400099',
    }),
    'OPERATIONS_ONE_OFF_PACK_CONTEXT_UNAVAILABLE',
    'Imported orders must not enter Shipping one-off pack',
  )
  await expectCode(
    () => persistence.readShippingOneOffPackReviewFromPostgres({
      organizationId: ids.otherOrganization,
      orderGlobalId: existing.orderGlobalId,
    }),
    'OPERATIONS_ONE_OFF_PACK_CONTEXT_UNAVAILABLE',
    'Cross-organization order IDs must not resolve',
  )

  for (const [item, label] of [[labeled, 'labeled'], [shipped, 'shipped']]) {
    const review = await persistence.readShippingOneOffPackReviewFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: item.orderGlobalId,
    })
    assert.match(review.blocker, /Every package must still be planned/)
    await expectCode(
      () => persistence.packShippingOneOffShipmentInPostgres({
        ...commandInput(item, { evidenceHash: 'a'.repeat(64) }, `blocked-${label}-pack`),
      }),
      'OPERATIONS_ONE_OFF_PACK_EVIDENCE_STALE',
      `Already-${label} package state must block Shipping pack`,
    )
  }

  const unresolvedReview = await persistence.readShippingOneOffPackReviewFromPostgres({
    organizationId: ids.organization,
    orderGlobalId: unresolved.orderGlobalId,
  })
  assert.match(unresolvedReview.blocker, /carrier execution evidence/)
  await expectCode(
    () => persistence.packShippingOneOffShipmentInPostgres({
      ...commandInput(
        unresolved,
        { evidenceHash: 'b'.repeat(64) },
        'blocked-unresolved-group',
      ),
    }),
    'OPERATIONS_ONE_OFF_PACK_EVIDENCE_STALE',
    'An unresolved carrier group must block Shipping pack',
  )

  const adHocReview = await persistence.readShippingOneOffPackReviewFromPostgres({
    organizationId: ids.organization,
    orderGlobalId: adHoc.orderGlobalId,
  })
  assert.equal(adHocReview.state, 'packed')
  assert.equal(adHocReview.required, false)
  assert.equal(adHocReview.reservations.length, 0)
  await expectCode(
    () => persistence.packShippingOneOffShipmentInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: 'ad-hoc-direct-path-stays-packed',
      orderGlobalId: adHoc.orderGlobalId,
      expectedRowVersion: 0,
      expectedReviewSnapshotHash: 'c'.repeat(64),
      confirmation: CONFIRMATION,
      reason: 'Pure ad-hoc direct recipient remains auto-packed',
    }),
    'OPERATIONS_ONE_OFF_PACK_STATE_INVALID',
    'Pure ad-hoc auto-pack must not re-enter physical inventory pack',
  )

  const [idempotencyReviewA, idempotencyReviewB] = await Promise.all([
    persistence.readShippingOneOffPackReviewFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: idempotencyRaceA.orderGlobalId,
    }),
    persistence.readShippingOneOffPackReviewFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: idempotencyRaceB.orderGlobalId,
    }),
  ])
  assert.equal(idempotencyReviewA.blocker, null)
  assert.equal(idempotencyReviewB.blocker, null)
  assert.equal(idempotencyReviewA.lines[0].kind, 'existing')
  assert.equal(idempotencyReviewB.lines[0].kind, 'new')
  const idempotencyReservationsBefore = await Promise.all([
    snapshotReservation(idempotencyRaceA),
    snapshotReservation(idempotencyRaceB),
  ])
  const sharedIdempotencyKey = 'shipping-pack-same-key-different-orders'
  const idempotencyOutcomes = await Promise.allSettled([
    persistence.packShippingOneOffShipmentInPostgres(commandInput(
      idempotencyRaceA,
      idempotencyReviewA,
      sharedIdempotencyKey,
    )),
    persistence.packShippingOneOffShipmentInPostgres(commandInput(
      idempotencyRaceB,
      idempotencyReviewB,
      sharedIdempotencyKey,
    )),
  ])
  const idempotencySuccesses = idempotencyOutcomes.filter(
    (outcome) => outcome.status === 'fulfilled',
  )
  const idempotencyFailures = idempotencyOutcomes.filter(
    (outcome) => outcome.status === 'rejected',
  )
  assert.equal(idempotencySuccesses.length, 1)
  assert.equal(idempotencyFailures.length, 1)
  assert.equal(
    idempotencyFailures[0].reason.code,
    'OPERATIONS_IDEMPOTENCY_KEY_REUSED',
  )
  assert.equal(idempotencyFailures[0].reason.status, 409)
  assert.notEqual(idempotencyFailures[0].reason.code, '23505')
  const idempotencyWinner = idempotencySuccesses[0].value.orderGlobalId
  const racedStates = await pool.query(
    `SELECT source_order.global_id, source_order.status,
            source_order.row_version::integer,
            package.status AS package_status,
            (SELECT count(*)::integer
             FROM operations_shipping_one_off_pack_receipts receipt
             WHERE receipt.organization_id = source_order.organization_id
               AND receipt.order_id = source_order.id) AS receipts
     FROM operations_orders source_order
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = source_order.organization_id
      AND plan.order_id = source_order.id
     JOIN operations_packages package
       ON package.organization_id = plan.organization_id
      AND package.plan_id = plan.id
     WHERE source_order.organization_id = $1
       AND source_order.global_id = ANY($2::text[])
     ORDER BY source_order.global_id`,
    [ids.organization, [
      idempotencyRaceA.orderGlobalId,
      idempotencyRaceB.orderGlobalId,
    ]],
  )
  assert.equal(racedStates.rowCount, 2)
  for (const state of racedStates.rows) {
    if (state.global_id === idempotencyWinner) {
      assert.deepEqual(state, {
        global_id: state.global_id,
        status: 'packed',
        row_version: 1,
        package_status: 'packed',
        receipts: 1,
      })
    } else {
      assert.deepEqual(state, {
        global_id: state.global_id,
        status: 'planned',
        row_version: 0,
        package_status: 'planned',
        receipts: 0,
      })
    }
  }
  assert.deepEqual(
    await Promise.all([
      snapshotReservation(idempotencyRaceA),
      snapshotReservation(idempotencyRaceB),
    ]),
    idempotencyReservationsBefore,
    'Existing/new inventory reservations must survive the winning pack and losing conflict',
  )

  const writerFirstReview =
    await persistence.readShippingOneOffPackReviewFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: writerFirst.orderGlobalId,
    })
  assert.equal(writerFirstReview.blocker, null)
  const reservationWriter = await pool.connect()
  let writerFirstPackAttempt = null
  try {
    await reservationWriter.query('BEGIN')
    const extraPosition = await insertAdditionalPosition(
      reservationWriter,
      writerFirst,
      'writer-before-pack',
    )
    await insertAdditionalReservation(
      reservationWriter,
      writerFirst,
      extraPosition,
      'shipping-pack-writer-before-pack',
    )
    let packSettled = false
    writerFirstPackAttempt = persistence.packShippingOneOffShipmentInPostgres(
      commandInput(
        writerFirst,
        writerFirstReview,
        'writer-before-pack-must-be-visible',
      ),
    ).then(
      (result) => { packSettled = true; return { result, error: null } },
      (error) => { packSettled = true; return { result: null, error } },
    )
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 125))
    assert.equal(
      packSettled,
      false,
      'Pack must wait behind a reservation writer that owns its order fence',
    )
    await reservationWriter.query('COMMIT')
    const outcome = await writerFirstPackAttempt
    assert.ok(outcome.error, 'Writer-first reservation drift must reject pack')
    assert.equal(
      outcome.error.code,
      'OPERATIONS_ONE_OFF_PACK_EVIDENCE_STALE',
    )
    assert.match(
      String(outcome.error.message || outcome.error),
      /active inventory reservations no longer exactly cover/i,
    )
  } catch (error) {
    await reservationWriter.query('ROLLBACK').catch(() => undefined)
    if (writerFirstPackAttempt) await writerFirstPackAttempt
    throw error
  } finally {
    reservationWriter.release()
  }

  const existingReview = await persistence.readShippingOneOffPackReviewFromPostgres({
    organizationId: ids.organization,
    orderGlobalId: existing.orderGlobalId,
  })
  assert.equal(existingReview.required, true)
  assert.equal(existingReview.blocker, null)
  assert.equal(existingReview.lines[0].kind, 'existing')
  const beforeReservation = await snapshotReservation(existing)
  const exactExistingInput = commandInput(
    existing, existingReview, 'existing-pack-concurrent-stable',
  )
  const packFirstPosition = await insertAdditionalPosition(
    pool,
    existing,
    'pack-before-writer',
  )
  let concurrentEvidenceWrites = null
  beforeTransactionCommit = async () => {
    const settled = [false, false, false, false]
    const attempts = [
      pool.query(
        `UPDATE operations_order_lines SET description = 'Concurrent drift'
         WHERE organization_id = $1 AND id = $2`,
        [ids.organization, existing.line],
      ),
      pool.query(
        `UPDATE operations_fulfillment_allocations SET quantity = 2
         WHERE organization_id = $1 AND id = $2`,
        [ids.organization, existing.allocation],
      ),
      pool.query(
        `INSERT INTO operations_package_contents (
           id, organization_id, plan_id, order_id, package_id,
           order_line_id, quantity, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)`,
        [
          randomUUID(), ids.organization, existing.plan, existing.order,
          existing.package, existing.line, actorEmail,
        ],
      ),
      insertAdditionalReservation(
        pool,
        existing,
        packFirstPosition,
        'shipping-pack-pack-before-writer',
      ),
    ].map((attempt, index) => attempt.then(
      () => { settled[index] = true; return null },
      (error) => { settled[index] = true; return error },
    ))
    concurrentEvidenceWrites = Promise.all(attempts)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 125))
    assert.deepEqual(
      settled.slice(2),
      [true, true],
      'New content and reservation evidence must reject promptly',
    )
  }
  const concurrentResults = await Promise.all([
    persistence.packShippingOneOffShipmentInPostgres(exactExistingInput),
    persistence.packShippingOneOffShipmentInPostgres(exactExistingInput),
  ])
  assert.deepEqual(
    concurrentResults.map((result) => result.replayed).sort(),
    [false, true],
  )
  assert.ok(concurrentResults.every((result) => (
    JSON.stringify(result.effects) === JSON.stringify({
      providerWrites: 0,
      labelWrites: 0,
      shipmentWrites: 0,
      inventoryWrites: 0,
    })
  )))
  assert.deepEqual(await snapshotReservation(existing), beforeReservation)
  const evidenceWriteOutcomes = await concurrentEvidenceWrites
  assert.equal(evidenceWriteOutcomes.length, 4)
  for (const [index, outcome] of evidenceWriteOutcomes.entries()) {
    assert.ok(outcome, 'Concurrent evidence writer must receive a stable conflict')
    assert.notEqual(outcome.code, '40P01')
    assert.notEqual(outcome.code, '40001')
    if (outcome.code === '55P03') {
      assert.equal(
        String(outcome.message || outcome),
        'OPERATIONS_SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY',
      )
    } else {
      assert.ok(index < 2, 'New evidence inserts must use the stable busy conflict')
      assert.match(
        String(outcome.message || outcome),
        /pack line, content, and allocation evidence is sealed/i,
      )
    }
  }
  const postPackPosition = await insertAdditionalPosition(
    pool,
    existing,
    'post-pack-new-position',
  )
  const postPackInsertError = await expectCode(
    () => insertAdditionalReservation(
      pool,
      existing,
      postPackPosition,
      'shipping-pack-post-pack-new-position',
    ),
    undefined,
    'A new-position reservation insert after pack must be rejected',
  )
  assert.match(
    String(postPackInsertError.message || postPackInsertError),
    /pack reservation evidence is sealed/i,
  )
  const sealedQuantityError = await expectCode(
    () => pool.query(
      `UPDATE operations_reservations
       SET quantity = quantity + 1
       WHERE organization_id = $1 AND id = $2`,
      [ids.organization, existing.reservation],
    ),
    undefined,
    'Packed reservation quantity evidence must be immutable',
  )
  assert.match(
    String(sealedQuantityError.message || sealedQuantityError),
    /pack reservation evidence is sealed/i,
  )
  const sealedIdentityError = await expectCode(
    () => pool.query(
      `UPDATE operations_reservations
       SET position_id = $3
       WHERE organization_id = $1 AND id = $2`,
      [ids.organization, existing.reservation, postPackPosition.id],
    ),
    undefined,
    'Packed reservation identity evidence must be immutable',
  )
  assert.match(
    String(sealedIdentityError.message || sealedIdentityError),
    /pack reservation evidence is sealed/i,
  )
  const sealedAuthorityEvidenceError = await expectCode(
    () => pool.query(
      `UPDATE operations_reservations
       SET provider_inventory_sync_run_id = gen_random_uuid()
       WHERE organization_id = $1 AND id = $2`,
      [ids.organization, existing.reservation],
    ),
    undefined,
    'Packed reservation authority evidence must be immutable',
  )
  assert.match(
    String(
      sealedAuthorityEvidenceError.message || sealedAuthorityEvidenceError,
    ),
    /pack reservation evidence is sealed/i,
  )
  const existingReceipt = await pool.query(
    `SELECT count(*)::integer AS receipts,
            min(reservation_count)::integer AS reservations,
            min(provider_write_count)::integer AS provider_writes,
            min(label_write_count)::integer AS label_writes,
            min(shipment_write_count)::integer AS shipment_writes
     FROM operations_shipping_one_off_pack_receipts
     WHERE organization_id = $1 AND order_id = $2`,
    [ids.organization, existing.order],
  )
  assert.deepEqual(existingReceipt.rows[0], {
    receipts: 1,
    reservations: 1,
    provider_writes: 0,
    label_writes: 0,
    shipment_writes: 0,
  })
  const forgedReceiptError = await expectCode(
    () => pool.query(
      `INSERT INTO operations_shipping_one_off_pack_receipts (
         id, organization_id, order_id, plan_id, planning_quote_id,
         planning_offer_id, actor_email, idempotency_key, request_hash,
         reason, confirmation_statement, expected_order_row_version,
         order_row_version_after, plan_version_number, review_snapshot,
         review_snapshot_hash, package_count, reservation_count, packed_at
       )
       SELECT gen_random_uuid(), receipt.organization_id, receipt.order_id,
              receipt.plan_id, receipt.planning_quote_id,
              receipt.planning_offer_id, receipt.actor_email,
              'forged-same-count-snapshot', repeat('d', 64),
              'Attempt a direct same-count forged receipt',
              receipt.confirmation_statement,
              receipt.expected_order_row_version,
              receipt.order_row_version_after, receipt.plan_version_number,
              jsonb_set(
                receipt.review_snapshot,
                '{reservations,0,positionRowVersion}',
                '999999'::jsonb
              ) AS forged_snapshot,
              operations_transport_json_sha256(jsonb_set(
                receipt.review_snapshot,
                '{reservations,0,positionRowVersion}',
                '999999'::jsonb
              )),
              receipt.package_count, receipt.reservation_count,
              receipt.packed_at
       FROM operations_shipping_one_off_pack_receipts receipt
       WHERE receipt.organization_id = $1 AND receipt.order_id = $2`,
      [ids.organization, existing.order],
    ),
    undefined,
    'Same-count forged receipt snapshot must be rejected',
  )
  assert.match(
    String(forgedReceiptError.message || forgedReceiptError),
    /must retain the exact native order, plan, packages, reservations, and row versions/i,
  )

  const staleReview = await persistence.readShippingOneOffPackReviewFromPostgres({
    organizationId: ids.organization,
    orderGlobalId: createdProduct.orderGlobalId,
  })
  assert.equal(staleReview.lines[0].kind, 'new')
  await pool.query(
    `UPDATE operations_inventory_positions
     SET version = version + 1
     WHERE organization_id = $1 AND id = $2`,
    [ids.organization, createdProduct.position],
  )
  await expectCode(
    () => persistence.packShippingOneOffShipmentInPostgres(
      commandInput(createdProduct, staleReview, 'new-product-stale-review'),
    ),
    'OPERATIONS_ONE_OFF_PACK_EVIDENCE_STALE',
    'Stale inventory-position row-version evidence must block pack',
  )
  const refreshed = await persistence.readShippingOneOffPackReviewFromPostgres({
    organizationId: ids.organization,
    orderGlobalId: createdProduct.orderGlobalId,
  })
  assert.notEqual(refreshed.evidenceHash, staleReview.evidenceHash)
  const newBeforeReservation = await snapshotReservation(createdProduct)
  const newResult = await persistence.packShippingOneOffShipmentInPostgres(
    commandInput(createdProduct, refreshed, 'new-product-pack-refreshed'),
  )
  assert.equal(newResult.replayed, false)
  assert.deepEqual(await snapshotReservation(createdProduct), newBeforeReservation)

  const consumedLifecycle = await pool.query(
    `UPDATE operations_reservations
     SET status = 'consumed', released_at = now()
     WHERE organization_id = $1 AND id = $2 AND status = 'active'
     RETURNING status, released_at IS NOT NULL AS released_at_set`,
    [ids.organization, existing.reservation],
  )
  assert.deepEqual(consumedLifecycle.rows[0], {
    status: 'consumed',
    released_at_set: true,
  })
  const releasedLifecycle = await pool.query(
    `UPDATE operations_reservations
     SET status = 'released', released_at = now()
     WHERE organization_id = $1 AND id = $2 AND status = 'active'
     RETURNING status, released_at IS NOT NULL AS released_at_set`,
    [ids.organization, createdProduct.reservation],
  )
  assert.deepEqual(releasedLifecycle.rows[0], {
    status: 'released',
    released_at_set: true,
  })

  const mutationCounts = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_shipping_one_off_pack_receipts) AS receipts,
       (SELECT count(*)::integer FROM operations_labels) AS labels,
       (SELECT count(*)::integer FROM operations_shipments) AS shipments,
       (SELECT count(*)::integer
        FROM operations_one_off_carrier_group_attempts) AS carrier_groups`,
  )
  assert.deepEqual(mutationCounts.rows[0], {
    receipts: 3,
    labels: 0,
    shipments: 0,
    carrier_groups: 1,
  })
  assert.equal(auditWrites, 3)

  const printSeed = await pool.connect()
  let printFixture
  let printLockFixture
  let printReprintFixture
  const printReprintItem = [idempotencyRaceA, idempotencyRaceB].find(
    (item) => item.orderGlobalId === idempotencyWinner,
  )
  assert.ok(printReprintItem)
  try {
    await printSeed.query('BEGIN')
    await printSeed.query('SET LOCAL session_replication_role = replica')
    printFixture = await seedActivePrintRecoveryGroup(printSeed, existing)
    printLockFixture = await seedActivePrintRecoveryGroup(
      printSeed,
      createdProduct,
    )
    printReprintFixture = await seedActivePrintRecoveryGroup(
      printSeed,
      printReprintItem,
    )
    await printSeed.query('COMMIT')
  } catch (error) {
    await printSeed.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    printSeed.release()
  }
  const forbiddenPrintWritesBefore = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM operations_labels) AS labels,
       (SELECT count(*)::integer FROM operations_label_attempts)
         AS label_attempts,
       (SELECT count(*)::integer FROM operations_shipments) AS shipments,
       (SELECT count(*)::integer
          FROM operations_one_off_carrier_group_attempts) AS carrier_groups,
       (SELECT count(*)::integer
          FROM operations_one_off_carrier_group_results) AS carrier_results,
       (SELECT count(*)::integer
          FROM operations_carrier_rate_requests) AS carrier_requests,
       (SELECT jsonb_agg(jsonb_build_object(
          'globalId', label.global_id,
          'status', label.status,
          'payloadHash', encode(digest(
            convert_to(label.label_payload, 'UTF8'), 'sha256'
          ), 'hex'),
          'requestHash', label.request_hash,
          'providerEvidence', label.redacted_provider_evidence
        ) ORDER BY label.global_id)
        FROM operations_labels label) AS label_evidence`,
  )
  const initialPrintState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: existing.orderGlobalId,
    })
  assert.equal(initialPrintState.orderStatus, 'packed')
  assert.equal(initialPrintState.carrierGroup.active, true)
  const initialPrintLabel = initialPrintState.carrierGroup.labels[0]
  assert.equal(initialPrintLabel.labelGlobalId, printFixture.labelGlobalId)
  assert.equal(initialPrintLabel.printJobGlobalId, null)
  assert.equal(initialPrintLabel.printStatus, null)
  assert.equal(initialPrintLabel.printRecoveryAction, 'enqueue')
  const enqueueKey = 'shipping-print-no-printer-then-retry'
  const enqueueInput = printRecoveryInput(
    initialPrintState,
    initialPrintLabel,
    enqueueKey,
    'Queue this exact immutable label after the printer route is available',
  )
  await expectCode(
    () => executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
      enqueueInput,
    ),
    'OPERATIONS_PRINT_ROUTE_UNAVAILABLE',
    'No printer must reject Shipping recovery without creating print evidence',
  )
  const noPrinterEvidence = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_print_artifacts artifact
        WHERE artifact.organization_id = $1::uuid
          AND artifact.source_label_id = $2::uuid) AS artifacts,
       (SELECT count(*)::integer
        FROM operations_print_jobs job
        WHERE job.organization_id = $1::uuid
          AND job.label_id = $2::uuid) AS jobs,
       (SELECT count(*)::integer
        FROM operations_print_delivery_attempts attempt
        JOIN operations_print_jobs job
          ON job.organization_id = attempt.organization_id
         AND job.id = attempt.print_job_id
        WHERE job.organization_id = $1::uuid
          AND job.label_id = $2::uuid) AS attempts`,
    [ids.organization, printFixture.labelId],
  )
  assert.deepEqual(noPrinterEvidence.rows[0], {
    artifacts: 0,
    jobs: 0,
    attempts: 0,
  })

  const printRoute = await installShippingPrintRoute(pool)
  const printLockState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: createdProduct.orderGlobalId,
    })
  const printLockLabel = printLockState.carrierGroup.labels[0]
  const printLockShippingInput = printRecoveryInput(
    printLockState,
    printLockLabel,
    'shipping-print-label-lock-race',
    'Serialize this Shipping enqueue against a generic label enqueue',
  )
  let shippingBehindGenericEnqueue = null
  beforeTransactionCommit = async (ownerClient) => {
    const ownerPid = await backendPid(ownerClient)
    const contenderPidPromise = captureNextTransactionBackendPid()
    let settled = false
    shippingBehindGenericEnqueue = executionPersistence
      .recoverOperationsOneOffLabelPrintInPostgres(printLockShippingInput)
      .then(
        (result) => { settled = true; return { result, error: null } },
        (error) => { settled = true; return { result: null, error } },
      )
    const contenderPid = await contenderPidPromise
    await waitForBackendLock({
      contenderPid,
      ownerPid,
      expectedLockType: 'advisory',
      message: 'Shipping behind generic enqueue print-label fence',
    })
    assert.equal(
      settled,
      false,
      'Shipping must wait at the shared print-label fence while generic enqueue owns it',
    )
  }
  const genericLockOriginal = await printPersistence
    .enqueueOperationsPrintJobInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: 'generic-print-label-lock-race',
      warehouseId: ids.warehouse,
      document: {
        type: 'shipping_label',
        sourceLabelGlobalId: printLockFixture.labelGlobalId,
        media: 'label_4x6',
      },
    })
  const shippingBehindGenericEnqueueOutcome =
    await shippingBehindGenericEnqueue
  assert.ok(shippingBehindGenericEnqueueOutcome.error)
  assert.notEqual(shippingBehindGenericEnqueueOutcome.error.code, '40P01')
  assert.notEqual(shippingBehindGenericEnqueueOutcome.error.code, '40001')
  const labelLockRaceCount = await pool.query(
    `SELECT count(*)::integer AS jobs
     FROM operations_print_jobs
     WHERE organization_id = $1::uuid AND label_id = $2::uuid`,
    [ids.organization, printLockFixture.labelId],
  )
  assert.equal(labelLockRaceCount.rows[0].jobs, 1)

  const printReprintState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: printReprintItem.orderGlobalId,
    })
  const printReprintLabel = printReprintState.carrierGroup.labels[0]
  const printReprintShippingInput = printRecoveryInput(
    printReprintState,
    printReprintLabel,
    'shipping-print-generic-reprint-lock',
    'Queue the original before proving generic reprint lock compatibility',
  )
  let genericBehindShippingEnqueue = null
  beforeTransactionCommit = async (ownerClient) => {
    const ownerPid = await backendPid(ownerClient)
    const contenderPidPromise = captureNextTransactionBackendPid()
    let settled = false
    genericBehindShippingEnqueue = printPersistence
      .enqueueOperationsPrintJobInPostgres({
        organizationId: ids.organization,
        actorEmail,
        idempotencyKey: 'generic-behind-shipping-label-lock',
        warehouseId: ids.warehouse,
        document: {
          type: 'shipping_label',
          sourceLabelGlobalId: printReprintFixture.labelGlobalId,
          media: 'label_4x6',
        },
      })
      .then(
        (result) => { settled = true; return { result, error: null } },
        (error) => { settled = true; return { result: null, error } },
      )
    const contenderPid = await contenderPidPromise
    await waitForBackendLock({
      contenderPid,
      ownerPid,
      expectedLockType: 'advisory',
      message: 'Generic enqueue behind Shipping print-label fence',
    })
    assert.equal(
      settled,
      false,
      'Generic enqueue must wait while Shipping owns the shared print-label fence',
    )
  }
  const printReprintOriginal = await executionPersistence
    .recoverOperationsOneOffLabelPrintInPostgres(printReprintShippingInput)
  const genericBehindShippingEnqueueOutcome =
    await genericBehindShippingEnqueue
  assert.ok(genericBehindShippingEnqueueOutcome.error)
  assert.notEqual(genericBehindShippingEnqueueOutcome.error.code, '40P01')
  assert.notEqual(genericBehindShippingEnqueueOutcome.error.code, '40001')

  await forcePrintOutcome(genericLockOriginal.globalId, printRoute, {
    status: 'failed', attempts: 1, maxAttempts: 3, uncertain: false,
  })
  const printLockFailedState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: createdProduct.orderGlobalId,
    })
  const printLockRetryInput = printRecoveryInput(
    printLockFailedState,
    printLockFailedState.carrierGroup.labels[0],
    'shipping-retry-behind-generic-reprint',
    'Bind an exact Shipping retry before generic reprint lock proof',
  )
  await executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
    printLockRetryInput,
  )
  await forcePrintOutcome(genericLockOriginal.globalId, printRoute, {
    status: 'delivered', attempts: 2, maxAttempts: 3,
  })
  let shippingBehindGenericReprint = null
  beforeTransactionCommit = async (ownerClient) => {
    const ownerPid = await backendPid(ownerClient)
    const contenderPidPromise = captureNextTransactionBackendPid()
    let settled = false
    shippingBehindGenericReprint = executionPersistence
      .recoverOperationsOneOffLabelPrintInPostgres(printLockRetryInput)
      .then(
        (result) => { settled = true; return { result, error: null } },
        (error) => { settled = true; return { result: null, error } },
      )
    const contenderPid = await contenderPidPromise
    await waitForBackendLock({
      contenderPid,
      ownerPid,
      expectedLockType: 'transactionid',
      message: 'Shipping retry replay behind generic reprint job lock',
    })
    assert.equal(
      settled,
      false,
      'Shipping must wait on the generic writer job while compatible label SHARE locks avoid a cycle',
    )
  }
  await printPersistence.reprintOperationsPrintJobInPostgres({
    organizationId: ids.organization,
    actorEmail,
    idempotencyKey: 'generic-first-reprint-lock-proof',
    jobGlobalId: genericLockOriginal.globalId,
    reason: 'Controlled generic-first reprint after acknowledged output',
  })
  const shippingBehindGenericReprintOutcome =
    await shippingBehindGenericReprint
  assert.equal(shippingBehindGenericReprintOutcome.error, null)
  assert.equal(shippingBehindGenericReprintOutcome.result.action, 'retry')

  await forcePrintOutcome(printReprintOriginal.printJobGlobalId, printRoute, {
    status: 'delivered', attempts: 1, maxAttempts: 3,
  })
  let genericBehindShippingReprint = null
  beforeTransactionCommit = async (ownerClient) => {
    const ownerPid = await backendPid(ownerClient)
    const contenderPidPromise = captureNextTransactionBackendPid()
    let settled = false
    genericBehindShippingReprint = printPersistence
      .reprintOperationsPrintJobInPostgres({
        organizationId: ids.organization,
        actorEmail,
        idempotencyKey: 'generic-behind-shipping-reprint-lock-proof',
        jobGlobalId: printReprintOriginal.printJobGlobalId,
        reason: 'Controlled reprint waiting behind exact Shipping replay',
      })
      .then(
        (result) => { settled = true; return { result, error: null } },
        (error) => { settled = true; return { result: null, error } },
      )
    const contenderPid = await contenderPidPromise
    await waitForBackendLock({
      contenderPid,
      ownerPid,
      expectedLockType: 'transactionid',
      message: 'Generic reprint behind Shipping job lock',
    })
    assert.equal(
      settled,
      false,
      'Generic reprint must wait on the job tuple held by Shipping replay',
    )
  }
  const shippingFirstReprintReplay = await executionPersistence
    .recoverOperationsOneOffLabelPrintInPostgres(printReprintShippingInput)
  assert.equal(shippingFirstReprintReplay.action, 'enqueue')
  const genericBehindShippingReprintOutcome =
    await genericBehindShippingReprint
  assert.equal(genericBehindShippingReprintOutcome.error, null)

  const enqueueResults = await Promise.all([
    executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
      enqueueInput,
    ),
    executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
      enqueueInput,
    ),
  ])
  assert.deepEqual(
    enqueueResults.map((result) => result.replayed).sort(),
    [false, true],
  )
  assert.equal(enqueueResults[0].action, 'enqueue')
  assert.equal(
    enqueueResults[0].printJobGlobalId,
    enqueueResults[1].printJobGlobalId,
  )
  assert.equal(enqueueResults[0].sourcePrintJobGlobalId, null)
  assert.deepEqual(JSON.parse(JSON.stringify(enqueueResults[0].effects)), {
    carrierWrites: 0,
    providerWrites: 0,
    labelWrites: 0,
  })
  const queuedEvidence = await pool.query(
    `SELECT count(DISTINCT artifact.id)::integer AS artifacts,
            count(DISTINCT job.id)::integer AS jobs,
            count(DISTINCT attempt.id)::integer AS attempts
     FROM operations_print_jobs job
     JOIN operations_print_artifacts artifact
       ON artifact.organization_id = job.organization_id
      AND artifact.id = job.artifact_id
     JOIN operations_print_delivery_attempts attempt
       ON attempt.organization_id = job.organization_id
      AND attempt.print_job_id = job.id
     WHERE job.organization_id = $1::uuid
       AND job.label_id = $2::uuid`,
    [ids.organization, printFixture.labelId],
  )
  assert.deepEqual(queuedEvidence.rows[0], {
    artifacts: 1,
    jobs: 1,
    attempts: 1,
  })
  const queuedPrintState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: existing.orderGlobalId,
    })
  const queuedPrintLabel = queuedPrintState.carrierGroup.labels[0]
  assert.equal(queuedPrintLabel.printJobGlobalId, enqueueResults[0].printJobGlobalId)
  assert.equal(queuedPrintLabel.printStatus, 'queued')
  assert.equal(queuedPrintLabel.printRecoveryAction, null)
  assert.equal(queuedPrintLabel.printArtifactGlobalId, enqueueResults[0].printArtifactGlobalId)

  await forcePrintOutcome(enqueueResults[0].printJobGlobalId, printRoute, {
    status: 'failed', attempts: 1, maxAttempts: 3, uncertain: false,
  })
  const failedPrintState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: existing.orderGlobalId,
    })
  const failedPrintLabel = failedPrintState.carrierGroup.labels[0]
  assert.equal(failedPrintLabel.printStatus, 'failed')
  assert.equal(failedPrintLabel.printOutcomeUncertain, false)
  assert.equal(failedPrintLabel.printRecoveryAction, 'retry')
  const retryKey = 'shipping-print-safe-failed-retry'
  const retryInput = printRecoveryInput(
    failedPrintState,
    failedPrintLabel,
    retryKey,
    'Retry the exact certain zero-output failed print job',
  )
  const retryResults = await Promise.all([
    executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
      retryInput,
    ),
    executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
      retryInput,
    ),
  ])
  assert.deepEqual(
    retryResults.map((result) => result.replayed).sort(),
    [false, true],
  )
  assert.ok(retryResults.every((result) => (
    result.action === 'retry'
    && result.printJobGlobalId === enqueueResults[0].printJobGlobalId
    && result.sourcePrintJobGlobalId === enqueueResults[0].printJobGlobalId
  )))
  const retryAttemptCount = await pool.query(
    `SELECT count(*)::integer AS attempts
     FROM operations_print_delivery_attempts attempt
     JOIN operations_print_jobs job
       ON job.organization_id = attempt.organization_id
      AND job.id = attempt.print_job_id
     WHERE job.organization_id = $1::uuid
       AND job.global_id = $2
       AND attempt.idempotency_key = $3`,
    [
      ids.organization,
      enqueueResults[0].printJobGlobalId,
      `print-user:retry:${retryKey}`,
    ],
  )
  assert.equal(retryAttemptCount.rows[0].attempts, 1)

  await forcePrintOutcome(enqueueResults[0].printJobGlobalId, printRoute, {
    status: 'failed', attempts: 2, maxAttempts: 3, uncertain: false,
  })
  const secondRetryState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: existing.orderGlobalId,
    })
  const secondRetryLabel = secondRetryState.carrierGroup.labels[0]
  assert.equal(secondRetryLabel.printRecoveryAction, 'retry')
  const secondRetryInput = printRecoveryInput(
    secondRetryState,
    secondRetryLabel,
    'shipping-print-safe-failed-retry-k2',
    'Queue a second exact retry before the bounded attempts exhaust',
  )
  const secondRetryResult = await executionPersistence
    .recoverOperationsOneOffLabelPrintInPostgres(secondRetryInput)
  assert.equal(secondRetryResult.action, 'retry')
  assert.equal(secondRetryResult.replayed, false)

  await forcePrintOutcome(enqueueResults[0].printJobGlobalId, printRoute, {
    status: 'failed', attempts: 3, maxAttempts: 3, uncertain: false,
    errorCode: 'ARBITRARY_FAILED_CODE',
  })
  const arbitraryFailureState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: existing.orderGlobalId,
    })
  const arbitraryFailureLabel = arbitraryFailureState.carrierGroup.labels[0]
  assert.equal(arbitraryFailureLabel.printStatus, 'failed')
  assert.equal(
    arbitraryFailureLabel.printRecoveryAction,
    null,
    'An arbitrary failure code is not proof that zero bytes reached the printer',
  )
  const arbitraryRecoveryCountsBefore = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM operations_print_jobs
        WHERE organization_id = $1::uuid AND label_id = $2::uuid) AS jobs,
       (SELECT count(*)::integer
        FROM operations_print_delivery_attempts attempt
        JOIN operations_print_jobs job
          ON job.organization_id = attempt.organization_id
         AND job.id = attempt.print_job_id
        WHERE job.organization_id = $1::uuid
          AND job.label_id = $2::uuid) AS attempts`,
    [ids.organization, printFixture.labelId],
  )
  await expectCode(
    () => executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
      {
        ...printRecoveryInput(
          arbitraryFailureState,
          arbitraryFailureLabel,
          'shipping-print-arbitrary-failure-refusal',
          'Do not retry without exact zero-byte delivery evidence',
        ),
        expectedRecoveryAction: 'new_print',
      },
    ),
    'OPERATIONS_ONE_OFF_PRINT_RECOVERY_UNAVAILABLE',
    'Arbitrary failure evidence must not authorize retry or a new print',
  )
  const arbitraryRecoveryCountsAfter = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM operations_print_jobs
        WHERE organization_id = $1::uuid AND label_id = $2::uuid) AS jobs,
       (SELECT count(*)::integer
        FROM operations_print_delivery_attempts attempt
        JOIN operations_print_jobs job
          ON job.organization_id = attempt.organization_id
         AND job.id = attempt.print_job_id
        WHERE job.organization_id = $1::uuid
          AND job.label_id = $2::uuid) AS attempts`,
    [ids.organization, printFixture.labelId],
  )
  assert.deepEqual(
    arbitraryRecoveryCountsAfter.rows[0],
    arbitraryRecoveryCountsBefore.rows[0],
  )
  await forcePrintOutcome(enqueueResults[0].printJobGlobalId, printRoute, {
    status: 'failed', attempts: 3, maxAttempts: 3, uncertain: false,
    errorCode: 'PRINT_DELIVERY_STOPPED',
  })
  const exhaustedPrintState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: existing.orderGlobalId,
    })
  const exhaustedPrintLabel = exhaustedPrintState.carrierGroup.labels[0]
  assert.equal(exhaustedPrintLabel.printStatus, 'failed')
  assert.equal(exhaustedPrintLabel.printAttempts, 3)
  assert.equal(exhaustedPrintLabel.printMaxAttempts, 3)
  assert.equal(exhaustedPrintLabel.printRecoveryAction, 'new_print')
  const newPrintKey = 'shipping-print-exhausted-new-print'
  const newPrintInput = printRecoveryInput(
    exhaustedPrintState,
    exhaustedPrintLabel,
    newPrintKey,
    'Authorize a deliberate new print after certain exhausted failure',
  )
  const newPrintResults = await Promise.all([
    executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
      newPrintInput,
    ),
    executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
      newPrintInput,
    ),
  ])
  assert.deepEqual(
    newPrintResults.map((result) => result.replayed).sort(),
    [false, true],
  )
  assert.ok(newPrintResults.every((result) => (
    result.action === 'new_print'
    && result.sourcePrintJobGlobalId === enqueueResults[0].printJobGlobalId
    && result.printJobGlobalId === newPrintResults[0].printJobGlobalId
    && result.printArtifactGlobalId === enqueueResults[0].printArtifactGlobalId
  )))
  const printLineage = await pool.query(
    `SELECT count(*)::integer AS jobs,
            count(*) FILTER (
              WHERE original.global_id = $3
                AND job.artifact_id = original.artifact_id
            )::integer AS exact_reprints
     FROM operations_print_jobs job
     LEFT JOIN operations_print_jobs original
       ON original.organization_id = job.organization_id
      AND original.id = job.reprint_of_job_id
     WHERE job.organization_id = $1::uuid
       AND job.label_id = $2::uuid`,
    [
      ids.organization,
      printFixture.labelId,
      enqueueResults[0].printJobGlobalId,
    ],
  )
  assert.deepEqual(printLineage.rows[0], { jobs: 2, exact_reprints: 1 })
  const reprintQueuedState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: existing.orderGlobalId,
    })
  const reprintQueuedLabel = reprintQueuedState.carrierGroup.labels[0]
  assert.equal(reprintQueuedLabel.printJobGlobalId, newPrintResults[0].printJobGlobalId)
  assert.equal(reprintQueuedLabel.printStatus, 'queued')
  assert.equal(
    reprintQueuedLabel.printReprintOfJobGlobalId,
    enqueueResults[0].printJobGlobalId,
  )

  await forcePrintOutcome(newPrintResults[0].printJobGlobalId, printRoute, {
    status: 'delivered', attempts: 1, maxAttempts: 3,
  })
  const deliveredPrintState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: existing.orderGlobalId,
    })
  const deliveredPrintLabel = deliveredPrintState.carrierGroup.labels[0]
  assert.equal(deliveredPrintLabel.printStatus, 'printed')
  assert.equal(deliveredPrintLabel.printRecoveryAction, null)
  await expectCode(
    () => executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
      printRecoveryInput(
        deliveredPrintState,
        deliveredPrintLabel,
        'shipping-print-delivered-refusal',
        'Refuse another Shipping print after certain acknowledgement',
      ),
    ),
    'OPERATIONS_ONE_OFF_PRINT_ALREADY_ACKNOWLEDGED',
    'Shipping must not reprint an acknowledged physical output',
  )

  await forcePrintOutcome(newPrintResults[0].printJobGlobalId, printRoute, {
    status: 'failed', attempts: 2, maxAttempts: 3, uncertain: true,
  })
  const uncertainPrintState = await executionPersistence
    .readOneOffShipmentExecutionStateFromPostgres({
      organizationId: ids.organization,
      orderGlobalId: existing.orderGlobalId,
    })
  const uncertainPrintLabel = uncertainPrintState.carrierGroup.labels[0]
  assert.equal(uncertainPrintLabel.printStatus, 'failed')
  assert.equal(uncertainPrintLabel.printOutcomeUncertain, true)
  assert.equal(uncertainPrintLabel.printRecoveryAction, null)
  const uncertainInput = printRecoveryInput(
    uncertainPrintState,
    uncertainPrintLabel,
    'shipping-print-uncertain-refusal',
    'Refuse a duplicate because physical output may have occurred',
  )
  await expectCode(
    () => executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
      uncertainInput,
    ),
    'OPERATIONS_ONE_OFF_PRINT_OUTCOME_UNCERTAIN',
    'Shipping must not resend an outcome-uncertain physical output',
  )
  const historicalReplayCountsBefore = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM operations_print_jobs job
        WHERE job.organization_id = $1::uuid
          AND job.label_id = $2::uuid) AS jobs,
       (SELECT count(*)::integer
        FROM operations_print_delivery_attempts attempt
        JOIN operations_print_jobs job
          ON job.organization_id = attempt.organization_id
         AND job.id = attempt.print_job_id
        WHERE job.organization_id = $1::uuid
          AND job.label_id = $2::uuid) AS attempts`,
    [ids.organization, printFixture.labelId],
  )
  const historicalEnqueueReplay = await executionPersistence
    .recoverOperationsOneOffLabelPrintInPostgres(enqueueInput)
  assert.equal(historicalEnqueueReplay.action, 'enqueue')
  assert.equal(historicalEnqueueReplay.replayed, true)
  assert.equal(
    historicalEnqueueReplay.printJobGlobalId,
    enqueueResults[0].printJobGlobalId,
    'Historical enqueue K must resolve its original job after later reprint state',
  )
  const historicalRetryReplay = await executionPersistence
    .recoverOperationsOneOffLabelPrintInPostgres(retryInput)
  assert.equal(historicalRetryReplay.action, 'retry')
  assert.equal(historicalRetryReplay.replayed, true)
  assert.equal(
    historicalRetryReplay.printJobGlobalId,
    enqueueResults[0].printJobGlobalId,
    'Retry K1 must remain a retry replay after K2 and exhaustion',
  )
  const historicalNewPrintReplay = await executionPersistence
    .recoverOperationsOneOffLabelPrintInPostgres(newPrintInput)
  assert.equal(historicalNewPrintReplay.action, 'new_print')
  assert.equal(historicalNewPrintReplay.replayed, true)
  assert.equal(
    historicalNewPrintReplay.printJobGlobalId,
    newPrintResults[0].printJobGlobalId,
    'New-print K must resolve its original lineage job after later transitions',
  )
  const historicalReplayCountsAfter = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM operations_print_jobs job
        WHERE job.organization_id = $1::uuid
          AND job.label_id = $2::uuid) AS jobs,
       (SELECT count(*)::integer
        FROM operations_print_delivery_attempts attempt
        JOIN operations_print_jobs job
          ON job.organization_id = attempt.organization_id
         AND job.id = attempt.print_job_id
        WHERE job.organization_id = $1::uuid
          AND job.label_id = $2::uuid) AS attempts`,
    [ids.organization, printFixture.labelId],
  )
  assert.deepEqual(
    historicalReplayCountsAfter.rows[0],
    historicalReplayCountsBefore.rows[0],
    'Historical enqueue, retry, and new-print replay must create zero effects',
  )
  await expectCode(
    () => executionPersistence.recoverOperationsOneOffLabelPrintInPostgres({
      ...uncertainInput,
      idempotencyKey: enqueueKey,
      expectedRecoveryAction: 'retry',
    }),
    'OPERATIONS_IDEMPOTENCY_KEY_REUSED',
    'A workflow key bound to enqueue must never switch to retry',
  )
  const sameKeyCrossNamespace = await Promise.allSettled([
    executionPersistence.recoverOperationsOneOffLabelPrintInPostgres(
      enqueueInput,
    ),
    executionPersistence.recoverOperationsOneOffLabelPrintInPostgres({
      ...uncertainInput,
      idempotencyKey: enqueueKey,
      expectedRecoveryAction: 'retry',
    }),
  ])
  assert.equal(
    sameKeyCrossNamespace.filter(
      (outcome) => outcome.status === 'fulfilled',
    ).length,
    1,
  )
  const crossNamespaceFailure = sameKeyCrossNamespace.find(
    (outcome) => outcome.status === 'rejected',
  )
  assert.equal(
    crossNamespaceFailure.reason.code,
    'OPERATIONS_IDEMPOTENCY_KEY_REUSED',
  )
  assert.notEqual(crossNamespaceFailure.reason.code, '40P01')
  assert.notEqual(crossNamespaceFailure.reason.code, '40001')
  await expectCode(
    () => executionPersistence.recoverOperationsOneOffLabelPrintInPostgres({
      ...uncertainInput,
      organizationId: ids.otherOrganization,
      idempotencyKey: 'shipping-print-cross-org-refusal',
    }),
    'OPERATIONS_ONE_OFF_GROUP_CONTEXT_UNAVAILABLE',
    'Cross-organization Shipping print recovery must not resolve the order',
  )
  for (const [label, changes] of [
    ['stale order row version', {
      expectedRowVersion: uncertainInput.expectedRowVersion + 1,
    }],
    ['package drift', { packageGlobalId: 'gpa9400998' }],
    ['label drift', { labelGlobalId: 'glb9400998' }],
    ['artifact drift', { expectedPrintArtifactGlobalId: 'gpf9400998' }],
  ]) {
    await expectCode(
      () => executionPersistence.recoverOperationsOneOffLabelPrintInPostgres({
        ...uncertainInput,
        ...changes,
        idempotencyKey: `shipping-print-${label.replaceAll(' ', '-')}`,
      }),
      'OPERATIONS_ONE_OFF_PRINT_CONTEXT_CHANGED',
      `${label} must reject before any print mutation`,
    )
  }
  await expectCode(
    () => executionPersistence.recoverOperationsOneOffLabelPrintInPostgres({
      ...uncertainInput,
      orderGlobalId: 'gor9400099',
      expectedRowVersion: 0,
      idempotencyKey: 'shipping-print-imported-order-refusal',
    }),
    'OPERATIONS_ONE_OFF_GROUP_CONTEXT_UNAVAILABLE',
    'Imported orders must not enter Shipping print recovery',
  )
  const forbiddenPrintWritesAfter = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM operations_labels) AS labels,
       (SELECT count(*)::integer FROM operations_label_attempts)
         AS label_attempts,
       (SELECT count(*)::integer FROM operations_shipments) AS shipments,
       (SELECT count(*)::integer
          FROM operations_one_off_carrier_group_attempts) AS carrier_groups,
       (SELECT count(*)::integer
          FROM operations_one_off_carrier_group_results) AS carrier_results,
       (SELECT count(*)::integer
          FROM operations_carrier_rate_requests) AS carrier_requests,
       (SELECT jsonb_agg(jsonb_build_object(
          'globalId', label.global_id,
          'status', label.status,
          'payloadHash', encode(digest(
            convert_to(label.label_payload, 'UTF8'), 'sha256'
          ), 'hex'),
          'requestHash', label.request_hash,
          'providerEvidence', label.redacted_provider_evidence
        ) ORDER BY label.global_id)
        FROM operations_labels label) AS label_evidence`,
  )
  assert.deepEqual(
    forbiddenPrintWritesAfter.rows[0],
    forbiddenPrintWritesBefore.rows[0],
    'Shipping print recovery must produce zero carrier/provider/label/shipment writes',
  )
  assert.equal(carrierProviderWrites, 0)

  await expectCode(
    () => pool.query(
      `UPDATE operations_shipping_one_off_pack_receipts
       SET reason = 'Tampered immutable receipt' WHERE order_id = $1`,
      [existing.order],
    ),
    undefined,
    'Receipt updates must be rejected',
  )
  console.log('Shipping-only one-off pack disposable PostgreSQL checks passed.')
} finally {
  await pool.end()
}
