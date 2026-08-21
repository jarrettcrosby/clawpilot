#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import {
  SHIPPING_ONE_OFF_PACK_CATALOG_FINGERPRINT_SQL,
  SHIPPING_ONE_OFF_PACK_HEALTH_SQL,
} from '../app_src/lib/persistence/shippingOneOffPackHealth.ts'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
const CONFIRMATION =
  'I CONFIRM THESE EXACT ITEMS ARE PHYSICALLY IN THESE PACKAGES'

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
      'pgvector/pgvector:pg16',
    ], { stdio: 'ignore', timeout: 180_000 })
    const portOutput = execFileSync('docker', ['port', container, '5432/tcp'], {
      encoding: 'utf8',
    })
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve disposable PostgreSQL port: ${portOutput}`)
    databaseUrl = `postgresql://postgres:clawpilot_shipping_pack@127.0.0.1:${port}/clawpilot_shipping_pack`
    const deadline = Date.now() + 60_000
    while (true) {
      const ready = spawnSync('docker', [
        'exec', container, 'pg_isready', '-U', 'postgres',
        '-d', 'clawpilot_shipping_pack',
      ], { stdio: 'ignore' })
      if (ready.status === 0) break
      if (Date.now() >= deadline) {
        throw new Error('Disposable PostgreSQL did not become ready')
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
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
      const result = await work(client)
      const hook = beforeTransactionCommit
      if (hook) {
        beforeTransactionCommit = null
        await hook()
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
  const healthFingerprint = await pool.query(
    SHIPPING_ONE_OFF_PACK_CATALOG_FINGERPRINT_SQL,
  )
  if (process.env.CLAWPILOT_PRINT_SHIPPING_PACK_HEALTH === '1') {
    console.log('SHIPPING_PACK_HEALTH_FINGERPRINT', healthFingerprint.rows[0])
  }
  assert.deepEqual(healthFingerprint.rows[0], {
    artifact_count: 75,
    artifact_hash:
      'b463547928148723e9f5b35d92b310992c57e8dfc6a646a5bb3221898ba2c992',
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
