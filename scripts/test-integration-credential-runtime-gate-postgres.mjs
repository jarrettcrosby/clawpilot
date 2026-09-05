#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import {
  createIntegrationCredentialKeyAttestation,
} from '../app_src/lib/integrations/integrationCredentialKeyAttestation.mjs'
import {
  readIntegrationCredentialRuntimeAttestation,
  refreshIntegrationCredentialRuntimeReadiness,
} from '../app_src/lib/integrations/integrationCredentialRuntimeGate.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const attestationMigrationName =
  '0356_operations_integration_credential_key_attestation.sql'
const attestationMigration = readFileSync(
  new URL(`../db/migrations/${attestationMigrationName}`, import.meta.url),
  'utf8',
)
const attestationMigrationChecksum = createHash('sha256')
  .update(attestationMigration, 'utf8')
  .digest('hex')
const productImageRuntimeParkingMigrationName =
  '0357_operations_commerce_product_image_runtime_parking.sql'
const productImageRuntimeParkingMigration = readFileSync(
  new URL(
    `../db/migrations/${productImageRuntimeParkingMigrationName}`,
    import.meta.url,
  ),
  'utf8',
)
const productImageRuntimeParkingMigrationChecksum = createHash('sha256')
  .update(productImageRuntimeParkingMigration, 'utf8')
  .digest('hex')
const databaseIdentity = randomUUID()
const keyId = 'runtime-postgres-v1'
const keyMaterial = 'runtime-postgres-key-material-00000000000000000001'
const actor = 'runtime-attestation@example.test'

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  }).trim()
}

const port = 55_000 + Number.parseInt(randomUUID().slice(0, 4), 16) % 9_000
let container = `clawpilot-runtime-gate-${process.pid}-${randomUUID().slice(0, 8)}`

function cleanup() {
  if (!container) return
  try {
    command('docker', ['rm', '-f', container], { timeout: 30_000 })
  } catch {}
  container = ''
}
process.once('exit', cleanup)

async function waitForPostgres(databaseUrl) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 1_000,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      await pool.end().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

command('docker', ['info'], { timeout: 30_000 })
command('docker', [
  'create', '--name', container,
  '-e', 'POSTGRES_PASSWORD=runtime_gate_test',
  '-e', 'POSTGRES_DB=postgres',
  '-p', `127.0.0.1:${port}:5432`,
  'postgres:18-alpine',
], { timeout: 60_000 })
command('docker', ['start', container], { timeout: 60_000 })

const databaseUrl =
  `postgresql://postgres:runtime_gate_test@127.0.0.1:${port}/postgres`
await waitForPostgres(databaseUrl)
const pool = new Pool({ connectionString: databaseUrl, max: 2 })

try {
  await pool.query(`
    CREATE EXTENSION pgcrypto;
    CREATE TABLE schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL
    );
    CREATE TABLE app_settings (key text PRIMARY KEY, value jsonb NOT NULL);
    CREATE TABLE app_users (
      email text PRIMARY KEY,
      role text NOT NULL,
      status text NOT NULL
    );
    CREATE TABLE operations_carrier_accounts (
      id uuid PRIMARY KEY,
      account_number_ciphertext text
    );
    CREATE TABLE operations_carrier_credentials (
      id uuid PRIMARY KEY,
      credential_ciphertext bytea
    );
    CREATE TABLE operations_commerce_credentials (
      id uuid PRIMARY KEY,
      credential_ciphertext bytea
    );
    CREATE TABLE operations_commerce_intake_continuations (
      id uuid PRIMARY KEY,
      cursor_ciphertext bytea
    );
    CREATE TABLE operations_commerce_intake_read_intents (
      id uuid PRIMARY KEY,
      response_ciphertext bytea
    );
    CREATE TABLE operations_commerce_oauth_installations (
      id uuid PRIMARY KEY,
      application_credential_ciphertext bytea
    );
    CREATE TABLE operations_commerce_order_candidates (
      id uuid PRIMARY KEY,
      party_snapshot_ciphertext bytea,
      ship_to_snapshot_ciphertext bytea
    );
    CREATE TABLE operations_commerce_order_workbench (
      id uuid PRIMARY KEY,
      ship_to_ciphertext bytea
    );
    CREATE TABLE operations_commerce_webhook_receipts (
      id uuid PRIMARY KEY,
      payload_ciphertext bytea
    );
    CREATE TABLE operations_order_shipment_address_working_copies (
      id uuid PRIMARY KEY,
      ship_to_ciphertext bytea
    );
    CREATE TABLE operations_commerce_product_image_import_jobs (
      id uuid,
      global_id text,
      job_generation integer,
      organization_id uuid,
      integration_account_id uuid,
      provider text,
      credential_generation integer,
      observation_id uuid,
      observation_revision bigint,
      external_product_id text,
      image_identity_sha256 text,
      locator_sha256 text,
      observation_source_hash text,
      pipeline_id uuid,
      product_id uuid,
      product_mapping_id uuid,
      mapping_count integer,
      mapping_fingerprint_sha256 text,
      activation_revision integer,
      asset_alt_text text,
      state text,
      wait_reason text,
      attempt_count integer,
      max_attempts integer,
      available_at timestamptz,
      lease_token uuid,
      claimed_by text,
      claimed_at timestamptz,
      lease_expires_at timestamptz,
      last_error_code text,
      result_asset_id uuid,
      result_content_sha256 text,
      completed_at timestamptz,
      created_by text,
      updated_by text,
      created_at timestamptz,
      updated_at timestamptz
    );
    INSERT INTO app_settings (key, value)
    VALUES (
      'deployment.database.identity',
      jsonb_build_object('id', '${databaseIdentity}')
    );
    INSERT INTO app_users (email, role, status)
    VALUES ('${actor}', 'owner', 'active');
  `)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(attestationMigration)
    await client.query(
      'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
      [attestationMigrationName, attestationMigrationChecksum],
    )
    await client.query(productImageRuntimeParkingMigration)
    await client.query(`
      CREATE TRIGGER guard_operations_commerce_product_image_import_job_write
      BEFORE INSERT OR UPDATE OR DELETE
      ON operations_commerce_product_image_import_jobs
      FOR EACH ROW EXECUTE FUNCTION
        guard_operations_commerce_product_image_import_job()
    `)
    await client.query(
      'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
      [
        productImageRuntimeParkingMigrationName,
        productImageRuntimeParkingMigrationChecksum,
      ],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }

  const generated = createIntegrationCredentialKeyAttestation({
    databaseIdentity,
    keyId,
    keyMaterial,
  })
  await pool.query(
    `INSERT INTO operations_integration_credential_key_attestations (
       singleton_id, attestation_version, database_identity, key_id,
       sentinel_ciphertext, sentinel_iv, sentinel_tag, bootstrap_mode,
       adoption_evidence_sha256, created_by
     ) VALUES (1, $1, $2::uuid, $3, $4, $5, $6, 'empty', NULL, $7)`,
    [
      generated.attestationVersion,
      generated.databaseIdentity,
      generated.keyId,
      generated.sentinelCiphertext,
      generated.sentinelIv,
      generated.sentinelTag,
      actor,
    ],
  )

  const environment = {
    RAILWAY_ENVIRONMENT_NAME: 'runtime-gate-test',
    RAILWAY_DEPLOYMENT_ID: 'runtime-gate-postgres-test',
    DATABASE_URL: databaseUrl,
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID: keyId,
  }
  const ready = await refreshIntegrationCredentialRuntimeReadiness({
    client: pool,
    environment,
    allowMissingProof: true,
  })
  assert.equal(ready.status, 'verified')
  assert.equal(ready.providerIoReady, true)
  assert.ok(environment.INTEGRATION_CREDENTIAL_RUNTIME_PROOF)

  await pool.query(
    `UPDATE schema_migrations
     SET checksum = $2
     WHERE filename = $1`,
    [productImageRuntimeParkingMigrationName, '0'.repeat(64)],
  )
  await assert.rejects(
    readIntegrationCredentialRuntimeAttestation({
      client: pool,
      environment,
    }),
    /INTEGRATION_CREDENTIAL_RUNTIME_SCHEMA_REQUIRED/u,
  )
  await pool.query(
    `UPDATE schema_migrations
     SET checksum = $2
     WHERE filename = $1`,
    [
      productImageRuntimeParkingMigrationName,
      productImageRuntimeParkingMigrationChecksum,
    ],
  )

  await pool.query(`
    CREATE OR REPLACE FUNCTION
      guard_operations_commerce_product_image_import_job()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END;
    $$
  `)
  await assert.rejects(
    readIntegrationCredentialRuntimeAttestation({
      client: pool,
      environment,
    }),
    /INTEGRATION_CREDENTIAL_RUNTIME_SCHEMA_REQUIRED/u,
  )
  const restoreClient = await pool.connect()
  try {
    await restoreClient.query('BEGIN')
    await restoreClient.query(productImageRuntimeParkingMigration)
    await restoreClient.query('COMMIT')
  } catch (error) {
    await restoreClient.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    restoreClient.release()
  }

  await pool.query(`
    ALTER TABLE operations_commerce_product_image_import_jobs
      DISABLE TRIGGER guard_operations_commerce_product_image_import_job_write
  `)
  await assert.rejects(
    readIntegrationCredentialRuntimeAttestation({
      client: pool,
      environment,
    }),
    /INTEGRATION_CREDENTIAL_RUNTIME_SCHEMA_REQUIRED/u,
  )
  await pool.query(`
    ALTER TABLE operations_commerce_product_image_import_jobs
      ENABLE TRIGGER guard_operations_commerce_product_image_import_job_write
  `)

  await pool.query(`
    DROP TRIGGER reject_integration_credential_key_attestation_update_delete
      ON operations_integration_credential_key_attestations
  `)
  await assert.rejects(
    readIntegrationCredentialRuntimeAttestation({
      client: pool,
      environment,
    }),
    /INTEGRATION_CREDENTIAL_RUNTIME_SCHEMA_REQUIRED/u,
  )

  console.log('PASS test-integration-credential-runtime-gate-postgres')
} finally {
  await pool.end().catch(() => undefined)
  cleanup()
}
