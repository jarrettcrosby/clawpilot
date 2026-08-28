#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
const images = ['postgres:16-alpine', 'postgres:18-alpine']
const migrationFilename =
  '0338_operations_print_physical_output_attestation.sql'
const migrationSource = readFileSync(
  resolve(root, 'db/migrations', migrationFilename),
  'utf8',
)
const migrationChecksum = createHash('sha256')
  .update(migrationSource)
  .digest('hex')

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  }).trim()
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
  let lastError = null
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: false,
      connectionTimeoutMillis: 1_000,
      max: 1,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch (error) {
      lastError = error
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

function healthSql() {
  const path =
    'app_src/lib/persistence/operationsPrintPhysicalOutputHealth.ts'
  const output = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
    require: requireFromApp,
  }, { filename: path })
  return module.exports.OPERATIONS_PRINT_PHYSICAL_OUTPUT_HEALTH_SQL
}

async function installFixture(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 1 })
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL
    );
    CREATE TABLE workspace_organizations (
      id uuid PRIMARY KEY
    );
    CREATE TABLE app_user_organization_memberships (
      user_email text NOT NULL,
      organization_id uuid NOT NULL,
      role text NOT NULL,
      permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL,
      PRIMARY KEY (user_email, organization_id)
    );
    CREATE TABLE operations_print_jobs (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      status text NOT NULL,
      delivered_at timestamptz,
      PRIMARY KEY (id),
      UNIQUE (organization_id, id)
    );
    CREATE TABLE operations_print_delivery_attempts (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      print_job_id uuid NOT NULL,
      sequence_number integer NOT NULL,
      state text NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (organization_id, print_job_id, id)
    );
    CREATE OR REPLACE FUNCTION protect_operations_append_only()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'Operational ledger, event, and billing evidence is append-only';
    END;
    $$;
  `)
  await pool.query(migrationSource)
  await pool.query(
    `INSERT INTO schema_migrations (filename, checksum)
     VALUES ($1, $2)`,
    [migrationFilename, migrationChecksum],
  )
  return pool
}

async function exactHealth(pool) {
  const result = await pool.query(
    `SELECT (${healthSql()}) AS ready`,
  )
  return result.rows[0].ready
}

async function verifyImage(image) {
  const majorVersion = image.match(/postgres:(\d+)-alpine/u)?.[1]
  assert.ok(majorVersion, `Unexpected PostgreSQL image ${image}`)
  const container =
    `clawpilot-print-output-health-${majorVersion}-${process.pid}-${randomUUID().slice(0, 8)}`
  const password = `clawpilot_print_output_${majorVersion}`
  let pool
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', `POSTGRES_PASSWORD=${password}`,
      '-e', 'POSTGRES_DB=clawpilot_print_output',
      '-p', '127.0.0.1::5432',
      image,
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl =
      `postgresql://postgres:${password}@127.0.0.1:${port}/clawpilot_print_output`
    await waitForPostgres(databaseUrl)
    pool = await installFixture(databaseUrl)

    assert.equal(
      await exactHealth(pool),
      true,
      `Exact physical-output health must pass on PostgreSQL ${majorVersion}`,
    )
    const implicitNotNullRows = await pool.query(
      `SELECT count(*)::integer AS count
       FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = pg_catalog.to_regclass(
         'public.operations_print_physical_output_attestations'
       )
         AND constraint_row.contype = 'n'`,
    )
    assert.equal(
      Number(implicitNotNullRows.rows[0].count) > 0,
      majorVersion === '18',
      `PostgreSQL ${majorVersion} implicit NOT NULL catalog behavior changed`,
    )

    await pool.query('BEGIN')
    try {
      await pool.query(`
        ALTER TABLE operations_print_physical_output_attestations
          DROP CONSTRAINT operations_print_physical_output_reason_valid;
        ALTER TABLE operations_print_physical_output_attestations
          ADD CONSTRAINT operations_print_physical_output_reason_valid
          CHECK (true);
      `)
      assert.equal(
        await exactHealth(pool),
        false,
        `Constraint tampering must fail health on PostgreSQL ${majorVersion}`,
      )
    } finally {
      await pool.query('ROLLBACK')
    }
    assert.equal(await exactHealth(pool), true)
  } finally {
    await pool?.end().catch(() => undefined)
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }
}

command('docker', ['info'], { timeout: 30_000 })
for (const image of images) await verifyImage(image)
console.log(
  'Physical-output exact catalog health passed on PostgreSQL 16 and 18, including tamper detection.',
)
