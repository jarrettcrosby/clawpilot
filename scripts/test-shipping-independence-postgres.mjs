#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  SHIPPING_INDEPENDENCE_HEALTH_SQL,
} from '../app_src/lib/persistence/shippingIndependenceHealth.ts'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const TARGET_MIGRATION = '0301_shipping_independent_one_off_items.sql'
const TRUSTED_PROJECT_ID = 'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
const TRUSTED_ENVIRONMENT_ID = 'e4abd95f-825c-4242-b37b-825a92597e98'
const TRUSTED_DATABASE_FINGERPRINT = '750aa268-0e31-4065-a99c-4016e4d4fab1'

let databaseUrl = String(
  process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '',
).trim()
if (!databaseUrl) {
  execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 })
  const container = `clawpilot-shipping-independence-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    execFileSync('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_shipping',
      '-e', 'POSTGRES_DB=clawpilot_shipping',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { stdio: 'ignore', timeout: 180_000 })
    const portOutput = execFileSync('docker', ['port', container, '5432/tcp'], {
      encoding: 'utf8',
    })
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve disposable PostgreSQL port: ${portOutput}`)
    databaseUrl = `postgresql://postgres:clawpilot_shipping@127.0.0.1:${port}/clawpilot_shipping`
    const deadline = Date.now() + 60_000
    while (true) {
      const ready = spawnSync('docker', [
        'exec', container, 'pg_isready', '-U', 'postgres', '-d', 'clawpilot_shipping',
      ], { stdio: 'ignore' })
      if (ready.status === 0) break
      if (Date.now() >= deadline) throw new Error('Disposable PostgreSQL did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    execFileSync('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      stdio: 'inherit',
      timeout: 240_000,
    })
    execFileSync('node', ['scripts/test-shipping-independence-postgres.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PGSSLMODE: 'disable',
        CLAWPILOT_SHIPPING_PG_CHILD: '1',
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

let parsed = new URL(databaseUrl)
if (parsed.hostname.endsWith('.railway.internal')) {
  const variables = JSON.parse(execFileSync('railway', [
    'variables', '--service', 'Postgres', '--environment', 'development', '--json',
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 }))
  databaseUrl = String(variables.DATABASE_PUBLIC_URL || '').trim()
  parsed = new URL(databaseUrl)
}
parsed.searchParams.delete('sslmode')
const remote = !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
if (remote && (
  process.env.RAILWAY_PROJECT_ID !== TRUSTED_PROJECT_ID
  || process.env.RAILWAY_ENVIRONMENT_ID !== TRUSTED_ENVIRONMENT_ID
  || process.env.RAILWAY_ENVIRONMENT_NAME !== 'development'
)) {
  throw new Error('Shipping independence acceptance is restricted to local Postgres or trusted Railway development.')
}

const pool = new Pool({
  connectionString: parsed.toString(),
  ssl: parsed.hostname.endsWith('rlwy.net') ? { rejectUnauthorized: false } : undefined,
  application_name: 'clawpilot-shipping-independence-rollback-acceptance',
  max: 4,
  connectionTimeoutMillis: 15_000,
  query_timeout: 120_000,
})
const migrationSql = readFileSync(fileURLToPath(
  new URL(`../db/migrations/${TARGET_MIGRATION}`, import.meta.url),
), 'utf8')
const permissionBackfillSql = migrationSql.slice(
  migrationSql.indexOf('-- New Shipping permissions must preserve'),
  migrationSql.indexOf('CREATE OR REPLACE FUNCTION operations_one_off_lines_are_pure_ad_hoc'),
)

async function shippingIndependenceIsHealthy(client) {
  const result = await client.query(
    `SELECT (${SHIPPING_INDEPENDENCE_HEALTH_SQL}) AS healthy`,
  )
  return result.rows[0]?.healthy === true
}

async function assertHealthRejectsTamper(client, label, tamper) {
  await client.query('SAVEPOINT shipping_health_tamper')
  try {
    await tamper()
    assert.equal(
      await shippingIndependenceIsHealthy(client),
      false,
      `${label} must make exact Shipping health red`,
    )
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT shipping_health_tamper')
    await client.query('RELEASE SAVEPOINT shipping_health_tamper')
  }
  assert.equal(
    await shippingIndependenceIsHealthy(client),
    true,
    `${label} rollback must restore exact Shipping health`,
  )
}

async function exerciseHealthTamperEvidence(client) {
  assert.equal(
    await shippingIndependenceIsHealthy(client),
    true,
    'Fresh 0301 catalog must satisfy exact Shipping health',
  )

  await assertHealthRejectsTamper(client, 'pure-ad-hoc helper replacement', async () => {
    await client.query(
      `CREATE OR REPLACE FUNCTION public.operations_one_off_lines_are_pure_ad_hoc(lines_snapshot jsonb)
       RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'`,
    )
  })
  await assertHealthRejectsTamper(client, 'customer guard CHECK(true)', async () => {
    await client.query(
      `ALTER TABLE public.operations_one_off_shipment_quotes
       DROP CONSTRAINT operations_one_off_shipment_quotes_customer_scope_valid`,
    )
    await client.query(
      `ALTER TABLE public.operations_one_off_shipment_quotes
       ADD CONSTRAINT operations_one_off_shipment_quotes_customer_scope_valid
       CHECK (true)`,
    )
  })
  await assertHealthRejectsTamper(client, 'disabled immutability trigger', async () => {
    await client.query(
      `ALTER TABLE public.operations_one_off_ad_hoc_order_lines
       DISABLE TRIGGER protect_operations_one_off_ad_hoc_line_write`,
    )
  })
  await assertHealthRejectsTamper(client, 'direct-recipient WHEN(false) trigger', async () => {
    await client.query(
      `DROP TRIGGER validate_operations_one_off_direct_recipient_deferred
       ON public.operations_orders`,
    )
    await client.query(
      `CREATE CONSTRAINT TRIGGER validate_operations_one_off_direct_recipient_deferred
       AFTER INSERT OR UPDATE OF customer_id, ship_to ON public.operations_orders
       DEFERRABLE INITIALLY DEFERRED
       FOR EACH ROW WHEN (false)
       EXECUTE FUNCTION public.validate_operations_one_off_direct_recipient()`,
    )
  })
  await assertHealthRejectsTamper(client, 'Shipping scope fence replacement', async () => {
    await client.query(
      `ALTER TABLE public.operations_shipping_scopes
       DROP CONSTRAINT operations_shipping_scopes_pipeline_scope_fkey`,
    )
    await client.query(
      `ALTER TABLE public.operations_shipping_scopes
       ADD CONSTRAINT operations_shipping_scopes_pipeline_scope_fkey
       CHECK (true)`,
    )
  })
  await assertHealthRejectsTamper(client, 'foreign-schema Shipping scope lookalike', async () => {
    await client.query('CREATE SCHEMA shipping_health_lookalike')
    await client.query(
      `ALTER TABLE public.operations_shipping_scopes
       SET SCHEMA shipping_health_lookalike`,
    )
    await client.query(
      `SET LOCAL search_path = shipping_health_lookalike, public`,
    )
  })
}

async function exercisePermissionBackfill(client) {
  const organizationId = randomUUID()
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const cases = [
    ['owner', 'owner', {}, [true, true, true]],
    ['admin-none', 'admin', {}, [false, false, false]],
    ['admin-view', 'admin', { viewOperations: true }, [true, false, false]],
    ['admin-execute', 'admin', {
      viewOperations: true,
      manageOperations: true,
      executeWarehouse: true,
    }, [true, true, true]],
    ['member-view', 'member', {
      viewOperations: true,
      manageOperations: true,
      executeWarehouse: true,
    }, [true, true, false]],
    ['member-explicit-deny', 'member', {
      viewOperations: true,
      manageOperations: true,
      executeWarehouse: true,
      createShipments: false,
    }, [true, false, false]],
    ['admin-explicit-deny', 'admin', {
      viewOperations: true,
      manageOperations: true,
      executeWarehouse: true,
      viewShipping: false,
      createShipments: false,
      purchaseLivePostage: false,
    }, [false, false, false]],
    ['member-explicit-grant', 'member', {
      viewShipping: true,
      createShipments: true,
      purchaseLivePostage: true,
    }, [true, true, true]],
  ]
  await client.query('SET LOCAL session_replication_role = replica')
  await client.query(
    `INSERT INTO workspace_organizations (
       id, name, organization_type
     ) VALUES ($1, 'Shipping permission backfill fixture', 'member')`,
    [organizationId],
  )
  for (const [name, role, permissions] of cases) {
    const email = `shipping-backfill-${name}-${suffix}@example.test`
    await client.query(
      `INSERT INTO app_users (
         email, role, permissions, status
       ) VALUES ($1, $2, $3::jsonb, 'active')`,
      [email, role, JSON.stringify(permissions)],
    )
    await client.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, permissions, status
       ) VALUES ($1, $2, $3, $4::jsonb, 'active')`,
      [email, organizationId, role, JSON.stringify(permissions)],
    )
  }
  await client.query('SET LOCAL session_replication_role = origin')
  await client.query(permissionBackfillSql)

  for (const table of ['app_users', 'app_user_organization_memberships']) {
    const rows = await client.query(
      `SELECT user_record.email,
              ARRAY[
                (user_record.permissions->>'viewShipping')::boolean,
                (user_record.permissions->>'createShipments')::boolean,
                (user_record.permissions->>'purchaseLivePostage')::boolean
              ] AS shipping_permissions
       FROM (
         SELECT app_user.email, app_user.permissions
         FROM app_users app_user
         WHERE $1 = 'app_users'
           AND app_user.email LIKE $2
         UNION ALL
         SELECT membership.user_email AS email, membership.permissions
         FROM app_user_organization_memberships membership
         WHERE $1 = 'app_user_organization_memberships'
           AND membership.organization_id = $3::uuid
       ) user_record`,
      [table, `shipping-backfill-%-${suffix}@example.test`, organizationId],
    )
    const byEmail = new Map(rows.rows.map((row) => [row.email, row.shipping_permissions]))
    for (const [name, , , expected] of cases) {
      assert.deepEqual(
        byEmail.get(`shipping-backfill-${name}-${suffix}@example.test`),
        expected,
        `${table} ${name} must preserve its exact legacy Shipping authority`,
      )
    }
  }
}

async function exerciseFirstUseScopeConcurrency() {
  const organizationId = randomUUID()
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
  const actor = `shipping-scope-${suffix}@example.test`
  const setup = await pool.connect()
  try {
    await setup.query('BEGIN')
    await setup.query('SET LOCAL session_replication_role = replica')
    await setup.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [actor],
    )
    await setup.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type
       ) VALUES ($1, 'Concurrent Shipping scope fixture', 'member')`,
      [organizationId],
    )
    await setup.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, permissions, status
       ) VALUES ($1, $2, 'owner', '{}'::jsonb, 'active')`,
      [actor, organizationId],
    )
    await setup.query('COMMIT')
  } catch (error) {
    await setup.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    setup.release()
  }

  const provision = async () => {
    const connection = await pool.connect()
    try {
      await connection.query('BEGIN')
      await connection.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [`shipping:scope:${organizationId}`],
      )
      const existing = await connection.query(
        `SELECT data_pipeline_id::text AS pipeline_id
         FROM operations_shipping_scopes
         WHERE organization_id = $1::uuid
         FOR UPDATE`,
        [organizationId],
      )
      let pipelineId = existing.rows[0]?.pipeline_id || null
      if (!pipelineId) {
        const pipeline = await connection.query(
          `SELECT id::text
           FROM pipeline_spaces
           WHERE workspace_organization_id = $1::uuid
           ORDER BY updated_at DESC, id
           LIMIT 1`,
          [organizationId],
        )
        pipelineId = pipeline.rows[0]?.id || null
      }
      if (!pipelineId) {
        const created = await connection.query(
          `INSERT INTO pipeline_spaces (
             name, owner_email, workspace_organization_id,
             is_default, sheet_id, sync_enabled
           ) VALUES ('Shipping records', $1, $2::uuid, false, NULL, false)
           RETURNING id::text`,
          [actor, organizationId],
        )
        pipelineId = created.rows[0].id
      }
      await connection.query(
        `INSERT INTO operations_shipping_scopes (
           organization_id, data_pipeline_id
         ) VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (organization_id) DO NOTHING`,
        [organizationId, pipelineId],
      )
      await connection.query('COMMIT')
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }

  await Promise.all([provision(), provision()])
  const evidence = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_shipping_scopes
        WHERE organization_id = $1::uuid) AS scopes,
       (SELECT count(*)::integer
        FROM pipeline_spaces
        WHERE workspace_organization_id = $1::uuid
          AND name = 'Shipping records') AS internal_pipelines`,
    [organizationId],
  )
  assert.deepEqual(evidence.rows[0], {
    scopes: 1,
    internal_pipelines: 1,
  }, 'Concurrent first-use Shipping loads must create one scope and one internal pipeline')
}

async function exerciseAdHocEvidence(client) {
  const ids = Object.fromEntries([
    'organization', 'otherOrganization', 'pipeline', 'integration', 'warehouse',
    'carrierAccount', 'quote', 'offer', 'order', 'plan', 'package',
  ].map((key) => [key, randomUUID()]))
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const actor = `shipping-${suffix}@example.test`
  const destination = {
    name: 'Direct recipient',
    line1: '100 Direct Street',
    line2: null,
    city: 'Boston',
    region: 'MA',
    postalCode: '02108',
    country: 'US',
    phone: '6175550101',
    shipFromPhone: '6175550100',
    residential: false,
  }
  const resolvedLine = {
    kind: 'ad_hoc',
    lineKey: 'direct-line-1',
    quantity: 2,
    productName: 'One-time sample',
    sku: '',
    unitPriceMinor: 2500,
    unitWeightGrams: 450,
    unitDimensionsMm: { length: 220, width: 140, height: 80 },
  }
  const itemSnapshot = {
    kind: 'ad_hoc',
    lineKey: 'direct-line-1',
    name: 'One-time sample',
    sku: null,
    quantity: 2,
    unitPriceMinor: 2500,
    unitWeightGrams: 450,
    unitDimensionsMm: { length: 220, width: 140, height: 80 },
  }
  const packages = [{
    packageKey: 'direct-package-1',
    dimensionsMm: { length: 300, width: 200, height: 150 },
    grossWeightGrams: 1000,
    allocations: [{ lineKey: 'direct-line-1', quantity: 2 }],
  }]
  const before = await client.query(
    `SELECT
       (SELECT count(*)::integer FROM crm_products) AS products,
       (SELECT count(*)::integer FROM operations_receipts) AS receipts,
       (SELECT count(*)::integer FROM operations_inventory_positions) AS positions,
       (SELECT count(*)::integer FROM operations_reservations) AS reservations`,
  )
  await client.query('SET LOCAL session_replication_role = replica')
  await client.query(
    `INSERT INTO app_users (email, role, status, contact_reference_code)
     VALUES ($1, 'member', 'active', $2)`,
    [actor, `gc${suffix}`],
  )
  await client.query(
    `INSERT INTO workspace_organizations (id, name, organization_type, reference_code)
     VALUES ($1, 'Shipping direct fixture', 'member', $3),
            ($2, 'Shipping cross-org fixture', 'member', $4)`,
    [ids.organization, ids.otherOrganization, `ga${suffix}`, `ga${suffix.slice(0, 11)}v`],
  )
  await client.query(
    `INSERT INTO pipeline_spaces (id, name, owner_email, workspace_organization_id)
     VALUES ($1, 'Shipping direct fixture', $2, $3)`,
    [ids.pipeline, actor, ids.organization],
  )
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type,
       environment, display_name, status, configuration
     ) VALUES ($1, $2, $3, 'clawpilot_native', 'commerce', 'mock',
       'Shipping native fixture', 'active', '{}'::jsonb)`,
    [ids.integration, `gia${suffix}`, ids.organization],
  )
  await client.query(
    `INSERT INTO operations_warehouses (
       id, global_id, organization_id, code, name, address, status
     ) VALUES ($1, $2, $3, 'DIRECT', 'Direct origin', $4::jsonb, 'active')`,
    [ids.warehouse, `gwh${suffix}`, ids.organization, JSON.stringify(destination)],
  )
  await client.query(
    `INSERT INTO operations_carrier_accounts (
       id, global_id, organization_id, integration_account_id, display_name,
       account_number_ciphertext, account_number_iv, account_number_tag,
       account_number_last_four, account_number_fingerprint,
       registered_address, registered_address_fingerprint, status, sender_name
     ) VALUES (
       $1, $2, $3, $4, 'Direct UPS fixture', 'fixture', 'fixture', 'fixture',
       '0001', $5, $6::jsonb, $5, 'active', 'Direct sender'
     )`,
    [
      ids.carrierAccount, `gac${suffix}`, ids.organization, ids.integration,
      'c'.repeat(64), JSON.stringify({ ...destination, countryCode: destination.country }),
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
       $1, $2, $3, $4, NULL, $5, NULL, NULL, 'sandbox',
       'DIRECT-ONE-OFF', 'USD', $6::jsonb, $7, $8::jsonb, $7,
       $9::jsonb, $7, ARRAY['ups_rest']::text[], '{}'::jsonb,
       NULL, NULL,
       NULL, NULL, NULL, $7, 'succeeded', $10,
       $11, now() + interval '1 hour', 'test'
     )`,
    [
      ids.quote, `goq${suffix}`, ids.organization, ids.pipeline, ids.warehouse,
      JSON.stringify(destination), 'a'.repeat(64), JSON.stringify([resolvedLine]),
      JSON.stringify(packages), `direct-${suffix}`, actor,
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
       $1, $2, $3, $4, $5, $6, 'ups_rest', 'sandbox', 1,
       'fixture', '03', 'UPS Ground', 1200, 'USD', 3,
       now() + interval '3 days', 'grq0000001', $7, $7, '{}'::jsonb,
       'small_parcel', 'loose_packages', 'UPS', 'UPS'
     )`,
    [
      ids.offer, `goo${suffix}`, ids.organization, ids.quote,
      ids.integration, ids.carrierAccount, 'b'.repeat(64),
    ],
  )
  await client.query(
    `INSERT INTO operations_orders (
       id, global_id, organization_id, pipeline_id, customer_id,
       integration_account_id, source_provider, external_order_id,
       order_number, order_type, status, currency, merchandise_total_minor,
       ship_to, source_payload
     ) VALUES (
       $1, allocate_global_reference('gor'), $2, $3, NULL, $4, 'clawpilot_native', $5,
       'DIRECT-ONE-OFF', 'one_off', 'packed', 'USD', 5000,
       $6::jsonb, '{}'::jsonb
     )`,
    [ids.order, ids.organization, ids.pipeline, ids.integration,
      `direct-${suffix}`, JSON.stringify(destination)],
  )
  await client.query(
    `INSERT INTO operations_one_off_shipment_quote_consumptions (
       organization_id, quote_id, order_id, offer_id, reason, consumed_by
     ) VALUES ($1, $2, $3, $4, 'Direct recipient fixture', $5)`,
    [ids.organization, ids.quote, ids.order, ids.offer, actor],
  )
  await client.query(
    `INSERT INTO operations_fulfillment_plans (
       id, organization_id, order_id, warehouse_id, status, method,
       solver_status, estimated_cost_minor, promised_delivery_at,
       explanation, one_off_quote_id, one_off_offer_id
     ) VALUES (
       $1, $2, $3, $4, 'planned', 'manual_override', 'optimal', 1200,
       now() + interval '3 days', '{}'::jsonb, $5, $6
     )`,
    [ids.plan, ids.organization, ids.order, ids.warehouse, ids.quote, ids.offer],
  )
  await client.query(
    `INSERT INTO operations_packages (
       id, organization_id, plan_id, package_number, length_mm, width_mm,
       height_mm, weight_grams, status
     ) VALUES ($1, $2, $3, 1, 300, 200, 150, 1000, 'packed')`,
    [ids.package, ids.organization, ids.plan],
  )
  await client.query('SET LOCAL session_replication_role = origin')

  const line = await client.query(
    `INSERT INTO operations_one_off_ad_hoc_order_lines (
       organization_id, quote_id, order_id, line_key, description,
       item_reference, quantity, unit_price_minor, unit_weight_grams,
       unit_dimensions_mm, item_snapshot, item_snapshot_hash, created_by
     ) VALUES (
       $1, $2, $3, 'direct-line-1', 'One-time sample', NULL,
       2, 2500, 450, $4::jsonb, $5::jsonb, $6, $7
     ) RETURNING id::text`,
    [ids.organization, ids.quote, ids.order,
      JSON.stringify(itemSnapshot.unitDimensionsMm), JSON.stringify(itemSnapshot),
      'c'.repeat(64), actor],
  )
  await client.query(
    `INSERT INTO operations_one_off_ad_hoc_package_contents (
       organization_id, plan_id, order_id, package_id,
       ad_hoc_order_line_id, quantity, created_by
     ) VALUES ($1, $2, $3, $4, $5, 2, $6)`,
    [ids.organization, ids.plan, ids.order, ids.package, line.rows[0].id, actor],
  )
  await client.query(
    `UPDATE operations_orders SET ship_to = ship_to
     WHERE organization_id = $1 AND id = $2`,
    [ids.organization, ids.order],
  )
  await client.query('SET CONSTRAINTS ALL IMMEDIATE')

  await client.query('SAVEPOINT immutable_check')
  await assert.rejects(
    client.query(
      `UPDATE operations_one_off_ad_hoc_order_lines
       SET description = 'Drifted' WHERE id = $1`,
      [line.rows[0].id],
    ),
    /immutable/,
  )
  await client.query('ROLLBACK TO SAVEPOINT immutable_check')
  await client.query('SAVEPOINT cross_org_check')
  await assert.rejects(
    client.query(
      `INSERT INTO operations_one_off_ad_hoc_package_contents (
         organization_id, plan_id, order_id, package_id,
         ad_hoc_order_line_id, quantity, created_by
       ) VALUES ($1, $2, $3, $4, $5, 2, $6)`,
      [ids.otherOrganization, ids.plan, ids.order, ids.package, line.rows[0].id, actor],
    ),
    /foreign key|lineage/i,
  )
  await client.query('ROLLBACK TO SAVEPOINT cross_org_check')

  const after = await client.query(
    `SELECT
       (SELECT count(*)::integer FROM crm_products) AS products,
       (SELECT count(*)::integer FROM operations_receipts) AS receipts,
       (SELECT count(*)::integer FROM operations_inventory_positions) AS positions,
       (SELECT count(*)::integer FROM operations_reservations) AS reservations`,
  )
  assert.deepEqual(after.rows[0], before.rows[0], 'Ad-hoc evidence must create zero product/inventory rows')
}

const client = await pool.connect()
try {
  if (remote) {
    const identity = await client.query(
      `SELECT value->>'id' AS id FROM app_settings
       WHERE key = 'deployment.database.identity'`,
    )
    assert.equal(identity.rows[0]?.id, TRUSTED_DATABASE_FINGERPRINT)
  }
  const prerequisites = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM schema_migrations
       WHERE filename = '0300_operations_order_training_independent_control.sql'
     ) AS ready,
     EXISTS (
       SELECT 1 FROM schema_migrations WHERE filename = $1
     ) AS target_applied`,
    [TARGET_MIGRATION],
  )
  assert.equal(prerequisites.rows[0]?.ready, true, '0300 prerequisite must be applied')

  if (!remote) await exerciseFirstUseScopeConcurrency()

  await client.query('BEGIN')
  if (!prerequisites.rows[0]?.target_applied) await client.query(migrationSql)

  const catalog = await client.query(
    `SELECT
       to_regclass('public.operations_shipping_scopes') IS NOT NULL AS shipping_scope,
       to_regclass('public.operations_one_off_ad_hoc_order_lines') IS NOT NULL AS ad_hoc_lines,
       to_regclass('public.operations_one_off_ad_hoc_package_contents') IS NOT NULL AS ad_hoc_contents,
       NOT (
         SELECT attnotnull FROM pg_attribute
         WHERE attrelid = 'operations_one_off_shipment_quotes'::regclass
           AND attname = 'customer_id' AND NOT attisdropped
       ) AS quote_customer_nullable,
       NOT (
         SELECT attnotnull FROM pg_attribute
         WHERE attrelid = 'operations_orders'::regclass
           AND attname = 'customer_id' AND NOT attisdropped
       ) AS order_customer_nullable,
       operations_one_off_lines_are_pure_ad_hoc(
         '[{"kind":"ad_hoc","lineKey":"one"}]'::jsonb
       ) AS pure_ad_hoc,
       NOT operations_one_off_lines_are_pure_ad_hoc(
         '[{"kind":"existing","lineKey":"one"}]'::jsonb
       ) AS inventory_backed_not_ad_hoc`,
  )
  assert.deepEqual(catalog.rows[0], {
    shipping_scope: true,
    ad_hoc_lines: true,
    ad_hoc_contents: true,
    quote_customer_nullable: true,
    order_customer_nullable: true,
    pure_ad_hoc: true,
    inventory_backed_not_ad_hoc: true,
  })

  const activationLeaks = await client.query(
    `SELECT proname
     FROM pg_proc
     WHERE proname IN (
       'validate_operations_one_off_group_prepare',
       'validate_operations_one_off_group_shipment'
     )
       AND pg_get_functiondef(oid) ILIKE '%operations_activation_scopes%'`,
  )
  assert.equal(activationLeaks.rowCount, 0)

  const safeguards = await client.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'operations_one_off_ad_hoc_package_contents'::regclass
           AND conname = 'operations_one_off_ad_hoc_contents_line_fkey'
           AND pg_get_constraintdef(oid) ILIKE '%organization_id, order_id, ad_hoc_order_line_id%'
       ) AS cross_org_line_fence,
       EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'operations_one_off_ad_hoc_order_lines'::regclass
           AND tgname = 'protect_operations_one_off_ad_hoc_line_write'
           AND NOT tgisinternal
       ) AS immutable_line,
       EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'operations_one_off_ad_hoc_package_contents'::regclass
           AND tgname = 'validate_operations_one_off_ad_hoc_content_set_deferred'
           AND NOT tgisinternal
       ) AS exact_package_set`,
  )
  assert.deepEqual(safeguards.rows[0], {
    cross_org_line_fence: true,
    immutable_line: true,
    exact_package_set: true,
  })
  await exerciseHealthTamperEvidence(client)
  await exercisePermissionBackfill(client)
  await exerciseAdHocEvidence(client)
  await client.query('ROLLBACK')
  console.log('Shipping independence disposable Postgres checks passed.')
} catch (error) {
  try { await client.query('ROLLBACK') } catch {}
  throw error
} finally {
  client.release()
  await pool.end()
}
