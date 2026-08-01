#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const root = process.cwd()

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1_000, max: 1 })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      await pool.end().catch(() => {})
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

function migrationFiles() {
  return readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right))
}

async function applyMigrations(client, files) {
  for (const file of files) {
    await client.query('BEGIN')
    try {
      await client.query(readFileSync(resolve(root, 'db/migrations', file), 'utf8'))
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw new Error(`Migration ${file} failed`, { cause: error })
    }
  }
}

async function expectRejected(client, sql, messagePattern) {
  await client.query('SAVEPOINT expected_rejection')
  try {
    await client.query(sql)
    assert.fail(`Expected query to fail: ${sql}`)
  } catch (error) {
    assert.match(String(error.message || error), messagePattern)
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_rejection')
    await client.query('RELEASE SAVEPOINT expected_rejection')
  }
}

async function seedGrandfatheredDuplicate(client) {
  await client.query('BEGIN')
  try {
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(`
      INSERT INTO crm_reference_number_registry (number_value)
      VALUES ('9999998')
    `)
    await client.query(`
      INSERT INTO crm_reference_registry (
        reference_code, prefix, canonical_code, status, entity_type
      )
      SELECT 'ga9999998', 'ga', 'ga9999998', 'active', entity_type
      FROM global_reference_entity_types WHERE prefix = 'ga'
      UNION ALL
      SELECT 'gc9999998', 'gc', 'gc9999998', 'retired', entity_type
      FROM global_reference_entity_types WHERE prefix = 'gc'
    `)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function verifyDeploymentAAllocator(client) {
  const definition = await client.query(`
    SELECT pg_get_functiondef(procedure.oid) AS definition
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = current_schema()
      AND procedure.proname = 'allocate_global_reference'
      AND pg_get_function_identity_arguments(procedure.oid) =
        'requested_prefix text'
  `)
  assert.equal(definition.rowCount, 1)
  assert.match(definition.rows[0].definition, /1000000 \+ floor\(random\(\) \* 9000000\)/)
  assert.doesNotMatch(definition.rows[0].definition, /gen_random_bytes/)

  await client.query('BEGIN')
  try {
    const allocated = await client.query(
      `SELECT allocate_global_reference('ga') AS reference_code`,
    )
    assert.match(allocated.rows[0].reference_code, /^ga[0-9]{7}$/)
  } finally {
    await client.query('ROLLBACK')
  }
}

async function verifyCompatibility(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  const client = await pool.connect()
  try {
    const duplicate = await client.query(`
      SELECT count(*)::integer AS count
      FROM crm_reference_registry
      WHERE reference_code IN ('ga9999998', 'gc9999998')
    `)
    assert.equal(duplicate.rows[0].count, 2, 'grandfathered duplicate suffix rows survive')

    const helpers = await client.query(`
      SELECT
        global_reference_code_is_valid('ga1234567', 'ga') AS legacy_ok,
        global_reference_code_is_valid('ga0123456789av', 'ga') AS v2_ok,
        global_reference_code_is_valid('gc1234567', 'ga') AS prefix_leak,
        global_reference_code_is_valid('ga0123456789aw', 'ga') AS alphabet_leak,
        global_reference_code_is_valid('ga0123456789AV', 'ga') AS uppercase_leak
    `)
    assert.deepEqual(helpers.rows[0], {
      legacy_ok: true,
      v2_ok: true,
      prefix_leak: false,
      alphabet_leak: false,
      uppercase_leak: false,
    })

    const numericOnlyChecks = await client.query(`
      SELECT count(*)::integer AS count
      FROM pg_constraint constraint_row
      WHERE constraint_row.contype = 'c'
        AND position('^g' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
        AND position('[0-9]{7}' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
        AND position('[0-9a-v]{12}' IN pg_get_constraintdef(constraint_row.oid, true)) = 0
    `)
    assert.equal(numericOnlyChecks.rows[0].count, 0)

    const numericOnlyFunctions = await client.query(`
      SELECT count(*)::integer AS count
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = current_schema()
        AND procedure.prokind = 'f'
        AND position('^g' IN pg_get_functiondef(procedure.oid)) > 0
        AND position('[0-9]{7}' IN pg_get_functiondef(procedure.oid)) > 0
        AND position('[0-9a-v]{12}' IN pg_get_functiondef(procedure.oid)) = 0
    `)
    assert.equal(numericOnlyFunctions.rows[0].count, 0)

    const unvalidated = await client.query(`
      SELECT count(*)::integer AS count
      FROM pg_constraint constraint_row
      WHERE constraint_row.contype = 'c'
        AND NOT constraint_row.convalidated
        AND position('[0-9a-v]{12}' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
    `)
    assert.equal(unvalidated.rows[0].count, 0)

    const allocatorDefinition = await client.query(`
      SELECT pg_get_functiondef(procedure.oid) AS definition
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = current_schema()
        AND procedure.proname = 'allocate_global_reference'
        AND pg_get_function_identity_arguments(procedure.oid) =
          'requested_prefix text'
    `)
    assert.equal(allocatorDefinition.rowCount, 1)
    assert.match(allocatorDefinition.rows[0].definition, /gen_random_bytes\(12\)/)
    assert.match(
      allocatorDefinition.rows[0].definition,
      /0123456789abcdefghijklmnopqrstuv/,
    )
    assert.match(allocatorDefinition.rows[0].definition, /FOR attempt IN 1\.\.32 LOOP/)
    assert.doesNotMatch(
      allocatorDefinition.rows[0].definition,
      /1000000 \+ floor\(random\(\) \* 9000000\)/,
    )

    const countsBeforeRollback = await client.query(`
      SELECT
        (SELECT count(*)::integer FROM crm_reference_number_registry) AS suffixes,
        (SELECT count(*)::integer FROM crm_reference_registry) AS references
    `)
    await client.query('BEGIN')
    try {
      const allocated = await client.query(
        `SELECT allocate_global_reference('ga') AS reference_code`,
      )
      const referenceCode = allocated.rows[0].reference_code
      const suffix = referenceCode.slice(2)
      assert.match(referenceCode, /^ga[0-9a-v]{12}$/)

      const reserved = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM crm_reference_number_registry WHERE number_value = $1
         ) AS found`,
        [suffix],
      )
      assert.equal(reserved.rows[0].found, true)
      const registered = await client.query(
        `SELECT EXISTS (
           SELECT 1
           FROM crm_reference_registry
           WHERE reference_code = $1
             AND prefix = 'ga'
             AND canonical_code = $1
             AND entity_type = 'crm.organization'
         ) AS found`,
        [referenceCode],
      )
      assert.equal(registered.rows[0].found, true)
    } finally {
      await client.query('ROLLBACK')
    }
    const countsAfterRollback = await client.query(`
      SELECT
        (SELECT count(*)::integer FROM crm_reference_number_registry) AS suffixes,
        (SELECT count(*)::integer FROM crm_reference_registry) AS references
    `)
    assert.deepEqual(
      countsAfterRollback.rows[0],
      countsBeforeRollback.rows[0],
      'Rolling back an allocation must release both registry inserts',
    )

    await client.query('BEGIN')
    try {
      await expectRejected(
        client,
        `SELECT allocate_global_reference('gzz')`,
        /Unsupported Global ID prefix/,
      )
    } finally {
      await client.query('ROLLBACK')
    }

    const prefixes = Array.from({ length: 96 }, (_, index) => (
      index % 2 === 0 ? 'ga' : 'gc'
    ))
    const concurrentAllocations = await Promise.all(prefixes.map(async (prefix) => {
      const result = await pool.query(
        `SELECT allocate_global_reference($1) AS reference_code`,
        [prefix],
      )
      return { prefix, referenceCode: result.rows[0].reference_code }
    }))
    const wrapperAllocation = await client.query(
      `SELECT allocate_crm_reference('ga') AS reference_code`,
    )
    concurrentAllocations.push({
      prefix: 'ga',
      referenceCode: wrapperAllocation.rows[0].reference_code,
    })

    const allocatedCodes = concurrentAllocations.map(({ prefix, referenceCode }) => {
      assert.match(referenceCode, new RegExp(`^${prefix}[0-9a-v]{12}$`))
      return referenceCode
    })
    const allocatedSuffixes = concurrentAllocations.map(
      ({ prefix, referenceCode }) => referenceCode.slice(prefix.length),
    )
    assert.equal(new Set(allocatedCodes).size, allocatedCodes.length)
    assert.equal(
      new Set(allocatedSuffixes).size,
      allocatedSuffixes.length,
      'New suffixes must be globally unique across prefixes',
    )

    const durableAllocationRows = await client.query(
      `SELECT
         (SELECT count(*)::integer
          FROM crm_reference_registry
          WHERE reference_code = ANY($1::text[])) AS references,
         (SELECT count(*)::integer
          FROM crm_reference_number_registry
          WHERE number_value = ANY($2::text[])) AS suffixes`,
      [allocatedCodes, allocatedSuffixes],
    )
    assert.deepEqual(durableAllocationRows.rows[0], {
      references: allocatedCodes.length,
      suffixes: allocatedSuffixes.length,
    })

    await client.query('BEGIN')
    try {
      await client.query(`
        INSERT INTO crm_reference_number_registry (number_value)
        VALUES ('00000000000a'), ('00000000000b')
      `)
      await client.query(`
        INSERT INTO crm_reference_registry (
          reference_code, prefix, canonical_code, status, entity_type
        )
        SELECT 'ga00000000000a', 'ga', 'ga00000000000a', 'active', entity_type
        FROM global_reference_entity_types WHERE prefix = 'ga'
        UNION ALL
        SELECT 'gc00000000000b', 'gc', 'gc00000000000b', 'active', entity_type
        FROM global_reference_entity_types WHERE prefix = 'gc'
      `)
      await client.query(`
        INSERT INTO workspace_organizations (name, reference_code)
        VALUES ('Global ID v2 acceptance', 'ga00000000000a')
      `)
      await client.query(`
        INSERT INTO short_links (
          owner_email, source_app, slug, destination_url, tags
        ) VALUES (
          'global-id-test@episcs.com',
          'clawpilot-crm',
          'ga00000000000a',
          'https://example.com/crm/ga00000000000a',
          ARRAY['crm', 'ga00000000000a']
        )
      `)
      await expectRejected(
        client,
        `INSERT INTO short_links (
           owner_email, source_app, slug, destination_url
         ) VALUES (
           'global-id-test@episcs.com',
           'clawpilot',
           'gc00000000000b',
           'https://example.com/not-crm'
         )`,
        /reserved for CRM/,
      )
      await expectRejected(
        client,
        `INSERT INTO crm_reference_number_registry (number_value)
         VALUES ('00000000000w')`,
        /crm_reference_number_registry_valid/,
      )
      await client.query(`
        INSERT INTO crm_reference_number_registry (number_value)
        VALUES ('vvvvvvvvvvvv')
      `)
      await client.query(`
        INSERT INTO crm_reference_registry (
          reference_code, prefix, canonical_code, status, entity_type
        )
        SELECT 'gavvvvvvvvvvvv', 'ga', 'gavvvvvvvvvvvv', 'active', entity_type
        FROM global_reference_entity_types WHERE prefix = 'ga'
      `)
      await expectRejected(
        client,
        `INSERT INTO crm_reference_registry (
           reference_code, prefix, canonical_code, status, entity_type
         )
         SELECT 'gcvvvvvvvvvvvv', 'gc', 'gcvvvvvvvvvvvv', 'active', entity_type
         FROM global_reference_entity_types WHERE prefix = 'gc'`,
        /suffix is already allocated/,
      )
    } finally {
      await client.query('ROLLBACK')
    }
  } finally {
    client.release()
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-global-id-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_global_id',
      '-e', 'POSTGRES_DB=clawpilot_global_id',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = `postgresql://postgres:clawpilot_global_id@127.0.0.1:${port}/clawpilot_global_id`
    await waitForPostgres(databaseUrl)

    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    try {
      const files = migrationFiles()
      const deploymentAIndex = files.findIndex((file) => file.startsWith('0202_'))
      const deploymentBIndex = files.findIndex((file) => file.startsWith('0219_'))
      assert.ok(deploymentAIndex > 0, '0202 Deployment A migration is missing')
      assert.ok(deploymentBIndex > deploymentAIndex, '0219 Deployment B migration is missing')
      await applyMigrations(client, files.slice(0, deploymentAIndex))
      await seedGrandfatheredDuplicate(client)
      await applyMigrations(client, files.slice(deploymentAIndex, deploymentBIndex))
      await verifyDeploymentAAllocator(client)
      await applyMigrations(client, files.slice(deploymentBIndex))
    } finally {
      client.release()
      await pool.end()
    }
    await verifyCompatibility(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Global ID full-migration PostgreSQL compatibility acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
