#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const root = process.cwd()
const suppliedDatabaseUrl = String(process.env.DATABASE_URL || '').trim()

const unionRepairMigrationPath = fileURLToPath(
  new URL(
    '../db/migrations/0194_operations_fulfillment_execution_union_repair.sql',
    import.meta.url,
  ),
)
const parcelRepairMigrationPath = fileURLToPath(
  new URL(
    '../db/migrations/0195_operations_fulfillment_rate_parcel_evidence.sql',
    import.meta.url,
  ),
)
const unionRepairMigrationSql = readFileSync(
  unionRepairMigrationPath,
  'utf8',
)
const parcelRepairMigrationSql = readFileSync(
  parcelRepairMigrationPath,
  'utf8',
)

function template(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${label} start marker is missing`)
  const contentStart = start + startMarker.length
  const end = source.indexOf(endMarker, contentStart)
  assert.notEqual(end, -1, `${label} end marker is missing`)
  return source.slice(contentStart, end).trim()
}

const lineRepair = template(
  unionRepairMigrationSql,
  'line_repair constant text := $line$',
  '$line$;',
  'Line repair template',
)
const packageRepair = template(
  unionRepairMigrationSql,
  'package_repair constant text := $package$',
  '$package$;',
  'Package repair template',
)
const providerParcelRepair = template(
  parcelRepairMigrationSql,
  'provider_parcel_repair constant text := $parcel$',
  '$parcel$;',
  'Provider parcel repair template',
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
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function verifyRepair(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'clawpilot-fulfillment-validator-repair-proof',
    max: 1,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 5_000,
  })
  const client = await pool.connect()
  let transactionOpen = false
  try {
    await client.query('BEGIN')
    transactionOpen = true
    await client.query(`SET LOCAL lock_timeout = '15s'`)
    await client.query(`SET LOCAL statement_timeout = '120s'`)
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtext('clawpilot-schema-migrations')
       )`,
    )

    const initialDefinitionResult = await client.query(
      `SELECT pg_get_functiondef(
         'validate_operations_fulfillment_execution()'::regprocedure
       ) AS definition`,
    )
    const initialDefinition = String(
      initialDefinitionResult.rows[0]?.definition || '',
    )
    const revisionCurrentLineAuthority = initialDefinition.includes(
      'operations_current_order_lines',
    )
    if (!revisionCurrentLineAuthority) {
      await client.query(unionRepairMigrationSql)
      await client.query(parcelRepairMigrationSql)
    }
    const firstDefinitionResult = await client.query(
      `SELECT pg_get_functiondef(
         'validate_operations_fulfillment_execution()'::regprocedure
       ) AS definition`,
    )
    const firstDefinition = String(
      firstDefinitionResult.rows[0]?.definition || '',
    )

    // 0274 deliberately recompiles the repaired validator against the
    // current-line view. Reapplying the historical 0194 template after that
    // point would be a backwards migration, so verify the final definition in
    // place. Pre-0274 schemas still prove byte-identical 0194/0195 replay.
    if (!revisionCurrentLineAuthority) {
      await client.query(unionRepairMigrationSql)
      await client.query(parcelRepairMigrationSql)
    }
    const secondDefinitionResult = await client.query(
      `SELECT pg_get_functiondef(
         'validate_operations_fulfillment_execution()'::regprocedure
       ) AS definition`,
    )
    const definition = String(
      secondDefinitionResult.rows[0]?.definition || '',
    )
    assert.equal(
      definition,
      firstDefinition,
      'The authoritative validator repair must remain byte-identical',
    )
    if (revisionCurrentLineAuthority) {
      assert.ok(
        definition.includes('operations_current_order_lines'),
        'Post-0274 fulfillment validation must retain current-line authority',
      )
    }

    for (const fragment of [
      'canonical_line_mismatch',
      'execution_line_mismatch',
      'canonical_package_mismatch',
      'execution_package_mismatch',
      "max(run.input_snapshot->>'carrierDestinationFingerprint')",
      "'packagePlanHash', run.result_snapshot->>'packagePlanHash'",
      "'packageCount', run.package_count",
      'operations_shopify_checkout_carrier_request_parcel_snapshot(',
      "'approved_recipe'",
    ]) {
      assert.ok(
        definition.includes(fragment),
        `Repaired validator is missing ${fragment}`,
      )
    }
    assert.equal(
      definition.includes('max(receipt.carrier_destination_fingerprint)'),
      false,
      'Repaired validator must retain the complete fulfillment destination repair',
    )
    assert.equal(
      definition.includes(
        'WHERE response_rate.value = choice.normalized_response',
      ),
      false,
      'Repaired validator must retain the exact package-identity rate-choice repair',
    )
    assert.equal(
      definition.includes(
        'operations_shopify_checkout_carrier_parcel_snapshot(\n      package.package_key',
      ),
      false,
      'Repaired validator must not compare provider evidence with the internal package-key parcel shape',
    )

    await client.query(`
      CREATE TEMP TABLE operations_order_lines (
        id uuid,
        global_id text,
        organization_id uuid,
        order_id uuid,
        pipeline_id uuid,
        product_id uuid,
        quantity numeric
      ) ON COMMIT DROP;
      CREATE TEMP TABLE crm_products (
        id uuid,
        pipeline_id uuid,
        reference_code text
      ) ON COMMIT DROP;
      CREATE TEMP TABLE operations_pack_rate_run_lines (
        organization_id uuid,
        run_id uuid,
        line_key text,
        product_key text,
        required_quantity numeric
      ) ON COMMIT DROP;
      CREATE TEMP TABLE operations_fulfillment_execution_lines (
        organization_id uuid,
        execution_id uuid,
        order_line_id uuid,
        line_key text,
        product_key text,
        required_quantity numeric
      ) ON COMMIT DROP;
      CREATE TEMP TABLE operations_packages (
        id uuid,
        organization_id uuid,
        plan_id uuid,
        evidence_package_key text,
        package_number integer,
        length_mm integer,
        width_mm integer,
        height_mm integer,
        cartonization_evidence_id uuid,
        weight_grams integer,
        status text
      ) ON COMMIT DROP;
      CREATE TEMP TABLE operations_cartonization_rate_evidence_packages (
        organization_id uuid,
        evidence_id uuid,
        package_key text,
        content_weight_grams integer,
        tare_weight_grams integer,
        packaging_material_id uuid
      ) ON COMMIT DROP;
      CREATE TEMP TABLE operations_packaging_materials (
        id uuid,
        organization_id uuid,
        code text,
        name text
      ) ON COMMIT DROP;
      CREATE TEMP TABLE operations_pack_rate_run_packages (
        organization_id uuid,
        run_id uuid,
        package_key text,
        package_sequence integer,
        material_code text,
        material_name text,
        length_mm integer,
        width_mm integer,
        height_mm integer,
        content_weight_grams integer,
        tare_weight_grams integer,
        gross_weight_grams integer
      ) ON COMMIT DROP;
      CREATE TEMP TABLE operations_fulfillment_execution_packages (
        organization_id uuid,
        execution_id uuid,
        shipment_group_id uuid,
        package_id uuid,
        package_key text
      ) ON COMMIT DROP;

      INSERT INTO crm_products VALUES (
        '00000000-0000-0000-0000-000000000007',
        '00000000-0000-0000-0000-000000000008',
        'PRODUCT-1'
      );
      INSERT INTO operations_order_lines VALUES (
        '00000000-0000-0000-0000-000000000009',
        'LINE-1',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000008',
        '00000000-0000-0000-0000-000000000007',
        1
      );
      INSERT INTO operations_pack_rate_run_lines VALUES (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000005',
        'LINE-1',
        'PRODUCT-1',
        1
      );
      INSERT INTO operations_fulfillment_execution_lines VALUES (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000009',
        'LINE-1',
        'PRODUCT-1',
        1
      );
      INSERT INTO operations_packaging_materials VALUES (
        '00000000-0000-0000-0000-000000000010',
        '00000000-0000-0000-0000-000000000002',
        'BOX-1',
        'Box 1'
      );
      INSERT INTO operations_cartonization_rate_evidence_packages VALUES (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000011',
        'PKG-1',
        900,
        100,
        '00000000-0000-0000-0000-000000000010'
      );
      INSERT INTO operations_packages VALUES (
        '00000000-0000-0000-0000-000000000012',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000004',
        'PKG-1',
        1,
        100,
        90,
        80,
        '00000000-0000-0000-0000-000000000011',
        1000,
        'packed'
      );
      INSERT INTO operations_pack_rate_run_packages VALUES (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000005',
        'PKG-1',
        1,
        'BOX-1',
        'Box 1',
        100,
        90,
        80,
        900,
        100,
        1000
      );
      INSERT INTO operations_fulfillment_execution_packages VALUES (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000006',
        '00000000-0000-0000-0000-000000000012',
        'PKG-1'
      );
    `)

    await client.query(`
      DO $proof$
      DECLARE
        execution record;
        group_row record;
        line_mismatch_count bigint;
        package_mismatch_count bigint;
        ordered_fulfillment_parcels jsonb;
      BEGIN
        SELECT
          '00000000-0000-0000-0000-000000000001'::uuid AS id,
          '00000000-0000-0000-0000-000000000002'::uuid AS organization_id,
          '00000000-0000-0000-0000-000000000003'::uuid AS order_id,
          '00000000-0000-0000-0000-000000000004'::uuid AS plan_id,
          '00000000-0000-0000-0000-000000000005'::uuid AS fulfillment_pack_rate_run_id
        INTO execution;
        SELECT
          '00000000-0000-0000-0000-000000000006'::uuid AS id
        INTO group_row;

        ${lineRepair}
        ${packageRepair}

        IF line_mismatch_count <> 0 OR package_mismatch_count <> 0 THEN
          RAISE EXCEPTION
            'Matching repair proof unexpectedly produced lineage mismatches';
        END IF;

        ${providerParcelRepair}
        IF ordered_fulfillment_parcels IS DISTINCT FROM
          '[{
            "description": "ClawPilot carton 1",
            "length": 4,
            "width": 4,
            "height": 4,
            "dimensionUnit": "IN",
            "weight": 2.3,
            "weightUnit": "LB"
          }]'::jsonb
        THEN
          RAISE EXCEPTION
            'Provider parcel repair emitted an unexpected request shape: %',
            ordered_fulfillment_parcels;
        END IF;
        IF ordered_fulfillment_parcels->0 ? 'packageKey'
           OR ordered_fulfillment_parcels->0 ? 'exteriorInches'
           OR ordered_fulfillment_parcels->0 ? 'grossPounds'
        THEN
          RAISE EXCEPTION
            'Provider parcel repair leaked internal package fields';
        END IF;

        UPDATE operations_pack_rate_run_lines
        SET required_quantity = 2;
        ${lineRepair}
        IF line_mismatch_count <> 2 THEN
          RAISE EXCEPTION
            'Canonical/run line mismatch expected 2, received %',
            line_mismatch_count;
        END IF;
        UPDATE operations_pack_rate_run_lines
        SET required_quantity = 1;

        UPDATE operations_fulfillment_execution_lines
        SET required_quantity = 2;
        ${lineRepair}
        IF line_mismatch_count <> 2 THEN
          RAISE EXCEPTION
            'Execution-edge line mismatch expected 2, received %',
            line_mismatch_count;
        END IF;
        UPDATE operations_fulfillment_execution_lines
        SET required_quantity = 1;

        UPDATE operations_pack_rate_run_packages
        SET gross_weight_grams = 1001;
        ${packageRepair}
        IF package_mismatch_count <> 2 THEN
          RAISE EXCEPTION
            'Canonical/run package mismatch expected 2, received %',
            package_mismatch_count;
        END IF;
        UPDATE operations_pack_rate_run_packages
        SET gross_weight_grams = 1000;

        UPDATE operations_fulfillment_execution_packages
        SET package_key = 'PKG-OTHER';
        ${packageRepair}
        IF package_mismatch_count <> 2 THEN
          RAISE EXCEPTION
            'Execution-edge package mismatch expected 2, received %',
            package_mismatch_count;
        END IF;
      END;
      $proof$;
    `)

    await client.query('ROLLBACK')
    transactionOpen = false
    console.log(
      'Fulfillment-validator repair PostgreSQL proof passed; transaction rolled back.',
    )
  } finally {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => undefined)
    }
    client.release()
    await pool.end()
  }
}

async function main() {
  if (suppliedDatabaseUrl) {
    await verifyRepair(suppliedDatabaseUrl)
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-fulfillment-validator-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_fulfillment_validator',
      '-e', 'POSTGRES_DB=clawpilot_fulfillment_validator',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:clawpilot_fulfillment_validator@127.0.0.1:'
      + `${port}/clawpilot_fulfillment_validator`
    )
    await waitForPostgres(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    await verifyRepair(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
