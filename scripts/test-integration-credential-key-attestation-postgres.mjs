#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  createCipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import {
  INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERIFICATION_FAILED,
  createIntegrationCredentialKeyAttestation,
  deriveIntegrationCredentialEncryptionKey,
  verifyIntegrationCredentialKeyAttestation,
} from '../app_src/lib/integrations/integrationCredentialKeyAttestation.mjs'
import {
  INTEGRATION_CREDENTIAL_KEY_REVIEWED_ADOPTION_INSTALL_CONTEXT,
  applyIntegrationCredentialKeyAdoption,
  bootstrapEmptyIntegrationCredentialKeyAttestation,
  planIntegrationCredentialKeyAdoption,
} from './integration-credential-key-attestation.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const keyMaterial = 'postgres-attestation-key-material-000000000000000001'
const wrongKeyMaterial = 'postgres-attestation-key-material-000000000000000002'
const keyId = 'prod-integrations-2026-09'
const actor = 'attestation-operator@example.com'
const inactiveActor = 'inactive-attestation-operator@example.com'
const memberActor = 'member-attestation-operator@example.com'
const migration = readFileSync(
  new URL(
    '../db/migrations/0356_operations_integration_credential_key_attestation.sql',
    import.meta.url,
  ),
  'utf8',
)

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim()
}

let disposableContainer = null
function stopDisposableContainer() {
  if (!disposableContainer) return
  try {
    command('docker', ['rm', '-f', disposableContainer], { timeout: 30_000 })
  } catch {}
  disposableContainer = null
}
process.once('exit', stopDisposableContainer)

function config(value = keyMaterial) {
  return Object.freeze({
    keyId,
    getKeyMaterial() {
      return value
    },
  })
}

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

function databaseUrl(baseUrl, databaseName) {
  const parsed = new URL(baseUrl)
  parsed.pathname = `/${databaseName}`
  return parsed.toString()
}

async function setupDatabase(baseUrl, databaseName, identity) {
  const admin = new Pool({ connectionString: baseUrl, max: 1 })
  await admin.query(`CREATE DATABASE ${databaseName}`)
  await admin.end()
  const pool = new Pool({
    connectionString: databaseUrl(baseUrl, databaseName),
    max: 4,
  })
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE EXTENSION pgcrypto;
      CREATE TABLE app_settings (key text PRIMARY KEY, value jsonb NOT NULL);
      CREATE TABLE app_users (
        email text PRIMARY KEY,
        role text NOT NULL,
        status text NOT NULL
      );
      CREATE TABLE operations_integration_accounts (
        id uuid NOT NULL,
        global_id text NOT NULL,
        organization_id uuid NOT NULL,
        provider text NOT NULL,
        environment text NOT NULL,
        PRIMARY KEY (organization_id, id)
      );
      CREATE TABLE operations_commerce_credentials (
        organization_id uuid NOT NULL,
        integration_account_id uuid NOT NULL,
        external_account_id text NOT NULL,
        credential_ciphertext bytea NOT NULL,
        credential_iv bytea NOT NULL,
        credential_tag bytea NOT NULL,
        credential_version integer NOT NULL
      );
      CREATE TABLE operations_carrier_credentials (
        organization_id uuid NOT NULL,
        integration_account_id uuid NOT NULL,
        credential_ciphertext bytea NOT NULL,
        credential_iv bytea NOT NULL,
        credential_tag bytea NOT NULL,
        credential_version integer NOT NULL
      );
      CREATE TABLE operations_carrier_accounts (
        id uuid PRIMARY KEY,
        global_id text NOT NULL,
        organization_id uuid NOT NULL,
        integration_account_id uuid NOT NULL,
        account_number_ciphertext text NOT NULL,
        account_number_iv text NOT NULL,
        account_number_tag text NOT NULL,
        encryption_version integer NOT NULL
      );
      CREATE TABLE operations_commerce_oauth_installations (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        browser_session_id uuid NOT NULL,
        state_hash text NOT NULL,
        application_credential_ciphertext bytea,
        application_credential_iv bytea,
        application_credential_tag bytea
      );
      CREATE TABLE operations_commerce_webhook_receipts (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        integration_account_id uuid,
        provider text,
        provider_event_id text,
        topic text,
        payload_ciphertext bytea,
        payload_iv bytea,
        payload_tag bytea
      );
      CREATE TABLE operations_commerce_order_candidates (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        integration_account_id uuid,
        external_order_id text,
        source_hash text,
        party_snapshot_ciphertext bytea,
        party_snapshot_iv bytea,
        party_snapshot_tag bytea,
        ship_to_snapshot_ciphertext bytea,
        ship_to_snapshot_iv bytea,
        ship_to_snapshot_tag bytea
      );
      CREATE TABLE operations_commerce_intake_read_intents (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        integration_account_id uuid,
        provider text,
        provider_attempt_id uuid,
        request_hash text,
        response_ciphertext bytea,
        response_iv bytea,
        response_tag bytea
      );
      CREATE TABLE operations_commerce_intake_continuations (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        integration_account_id uuid,
        provider text,
        session_id uuid,
        batch_number integer,
        query_hash text,
        cursor_ciphertext bytea,
        cursor_iv bytea,
        cursor_tag bytea
      );
      CREATE TABLE operations_commerce_order_workbench (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        integration_account_id uuid,
        external_order_id text,
        ship_to_source_hash text,
        ship_to_ciphertext bytea,
        ship_to_iv bytea,
        ship_to_tag bytea
      );
      CREATE TABLE operations_orders (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        integration_account_id uuid,
        external_order_id text
      );
      CREATE TABLE operations_order_shipment_address_working_copies (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        order_id uuid,
        source_order_hash text NOT NULL,
        ship_to_ciphertext bytea NOT NULL,
        ship_to_iv bytea NOT NULL,
        ship_to_tag bytea NOT NULL
      );
      INSERT INTO app_users (email, role, status)
      VALUES
        ('${actor}', 'owner', 'active'),
        ('${inactiveActor}', 'owner', 'disabled'),
        ('${memberActor}', 'member', 'active');
      INSERT INTO app_settings (key, value)
      VALUES (
        'deployment.database.identity',
        jsonb_build_object('id', '${identity}')
      );
    `)
    await client.query('BEGIN')
    try {
      await client.query(migration)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  } finally {
    client.release()
  }
  return pool
}

function encryptCredentialPayload(value, aad, material = keyMaterial) {
  const key = deriveIntegrationCredentialEncryptionKey(material)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const plaintext = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ])
  if (!Buffer.isBuffer(value)) plaintext.fill(0)
  key.fill(0)
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

const port = 55_000 + Number.parseInt(randomUUID().slice(0, 4), 16) % 9_000
disposableContainer = (
  `clawpilot-key-attestation-${process.pid}-${randomUUID().slice(0, 8)}`
)
command('docker', ['info'], { timeout: 30_000 })
command('docker', [
  'create', '--name', disposableContainer,
  '-e', 'POSTGRES_PASSWORD=attestation_test',
  '-e', 'POSTGRES_DB=postgres',
  '-p', `127.0.0.1:${port}:5432`,
  'postgres:16-alpine',
], { timeout: 60_000 })
command('docker', ['start', disposableContainer], { timeout: 60_000 })
const baseUrl = (
  `postgresql://postgres:attestation_test@127.0.0.1:${port}/postgres`
)
await waitForPostgres(baseUrl)

const emptyIdentity = randomUUID()
const concurrentIdentity = randomUUID()
const adoptionIdentity = randomUUID()
const emptyPool = await setupDatabase(baseUrl, 'attestation_empty', emptyIdentity)
const concurrentPool = await setupDatabase(
  baseUrl,
  'attestation_concurrent',
  concurrentIdentity,
)
const adoptionPool = await setupDatabase(
  baseUrl,
  'attestation_adoption',
  adoptionIdentity,
)

try {
  const emptyClient = await emptyPool.connect()
  try {
    for (const unauthorizedActor of [inactiveActor, memberActor]) {
      await assert.rejects(
        bootstrapEmptyIntegrationCredentialKeyAttestation({
          client: emptyClient,
          config: config(),
          actor: unauthorizedActor,
          expectedDatabaseIdentity: emptyIdentity,
        }),
        (error) => error.code
          === 'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_ACTOR_UNAUTHORIZED',
      )
    }
    const bootstrapped = await bootstrapEmptyIntegrationCredentialKeyAttestation({
      client: emptyClient,
      config: config(),
      actor,
      expectedDatabaseIdentity: emptyIdentity,
    })
    assert.equal(bootstrapped.status, 'verified')
    assert.equal(bootstrapped.databaseIdentity, emptyIdentity)
    assert.equal(bootstrapped.keyId, keyId)
    assert.deepEqual(
      await bootstrapEmptyIntegrationCredentialKeyAttestation({
        client: emptyClient,
        config: config(),
        actor,
        expectedDatabaseIdentity: emptyIdentity,
      }),
      bootstrapped,
      'Empty bootstrap is idempotent once the immutable row exists',
    )
    await assert.rejects(
      verifyIntegrationCredentialKeyAttestation({
        client: emptyClient,
        secret: wrongKeyMaterial,
        keyId,
        expectedDatabaseIdentity: emptyIdentity,
      }),
      (error) => error.code
        === INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERIFICATION_FAILED,
    )
    const columns = await emptyClient.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name =
           'operations_integration_credential_key_attestations'
       ORDER BY ordinal_position`,
    )
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'singleton_id',
      'attestation_version',
      'database_identity',
      'key_id',
      'sentinel_ciphertext',
      'sentinel_iv',
      'sentinel_tag',
      'bootstrap_mode',
      'adoption_evidence_sha256',
      'created_by',
      'created_at',
    ])
    const publicPrivileges = await emptyClient.query(
      `SELECT
         EXISTS (
           SELECT 1
           FROM pg_class relation
           CROSS JOIN LATERAL aclexplode(COALESCE(
             relation.relacl,
             acldefault('r', relation.relowner)
           )) privilege
           WHERE relation.oid =
             'operations_integration_credential_key_attestations'::regclass
             AND privilege.grantee = 0
         ) AS public_table_access,
         EXISTS (
           SELECT 1
           FROM pg_proc procedure
           CROSS JOIN LATERAL aclexplode(COALESCE(
             procedure.proacl,
             acldefault('f', procedure.proowner)
           )) privilege
           WHERE procedure.oid IN (
             'validate_integration_credential_key_attestation_insert()'::regprocedure,
             'reject_integration_credential_key_attestation_mutation()'::regprocedure
           )
             AND privilege.grantee = 0
         ) AS public_function_access`,
    )
    assert.deepEqual(publicPrivileges.rows[0], {
      public_table_access: false,
      public_function_access: false,
    })
    for (const statement of [
      `UPDATE operations_integration_credential_key_attestations
       SET key_id = 'replacement'`,
      'DELETE FROM operations_integration_credential_key_attestations',
      'TRUNCATE operations_integration_credential_key_attestations',
    ]) {
      await assert.rejects(emptyClient.query(statement), /immutable/iu)
    }
  } finally {
    emptyClient.release()
  }

  const first = await concurrentPool.connect()
  const second = await concurrentPool.connect()
  try {
    let releaseHeldLocks
    const heldLocksReleased = new Promise((resolve) => {
      releaseHeldLocks = resolve
    })
    let reportHeldLocks
    const heldLocks = new Promise((resolve) => {
      reportHeldLocks = resolve
    })
    const pausingClient = {
      async query(...args) {
        const result = await first.query(...args)
        if (
          typeof args[0] === 'string'
          && args[0].startsWith('LOCK TABLE ')
        ) {
          reportHeldLocks()
          await heldLocksReleased
        }
        return result
      },
    }
    const firstBootstrap = bootstrapEmptyIntegrationCredentialKeyAttestation({
      client: pausingClient,
      config: config(),
      actor,
      expectedDatabaseIdentity: concurrentIdentity,
    })
    await heldLocks
    await second.query("SET lock_timeout = '250ms'")
    try {
      await assert.rejects(
        second.query(
          `INSERT INTO operations_commerce_order_workbench (
             id, organization_id, ship_to_source_hash,
             ship_to_ciphertext, ship_to_iv, ship_to_tag
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
          [
            randomUUID(),
            randomUUID(),
            '1'.repeat(64),
            randomBytes(32),
            randomBytes(12),
            randomBytes(16),
          ],
        ),
        (error) => error.code === '55P03',
        'Bootstrap SHARE locks must conflict with key-backed store writers',
      )
    } finally {
      releaseHeldLocks()
    }
    const attempts = [
      await firstBootstrap,
      await bootstrapEmptyIntegrationCredentialKeyAttestation({
        client: second,
        config: config(),
        actor,
        expectedDatabaseIdentity: concurrentIdentity,
      }),
    ]
    assert.deepEqual(attempts[0], attempts[1])
    const count = await concurrentPool.query(
      `SELECT count(*)::integer AS count
       FROM operations_integration_credential_key_attestations`,
    )
    assert.equal(count.rows[0].count, 1)
  } finally {
    first.release()
    second.release()
  }

  const adoptionClient = await adoptionPool.connect()
  try {
    const organizationId = randomUUID()
    const generated = createIntegrationCredentialKeyAttestation({
      databaseIdentity: adoptionIdentity,
      keyId,
      keyMaterial,
    })

    const insertDirectEmptyAttestation = (createdBy = actor) => (
      adoptionClient.query(
        `INSERT INTO operations_integration_credential_key_attestations (
           singleton_id, attestation_version, database_identity, key_id,
           sentinel_ciphertext, sentinel_iv, sentinel_tag, bootstrap_mode,
           adoption_evidence_sha256, created_by
         ) VALUES (1, $1, $2::uuid, $3, $4, $5, $6, 'empty', NULL, $7)`,
        [
          generated.attestationVersion,
          adoptionIdentity,
          keyId,
          generated.sentinelCiphertext,
          generated.sentinelIv,
          generated.sentinelTag,
          createdBy,
        ],
      )
    )
    for (const unauthorizedActor of [inactiveActor, memberActor]) {
      await assert.rejects(
        insertDirectEmptyAttestation(unauthorizedActor),
        /requires an active owner or admin/iu,
      )
    }

    async function assertStoreBlocksEmptyBootstrap(store, insert, remove) {
      await insert()
      await assert.rejects(
        insertDirectEmptyAttestation(),
        /empty bootstrap requires an empty key-backed store/iu,
        `${store} must block the database-trigger empty bootstrap`,
      )
      await assert.rejects(
        bootstrapEmptyIntegrationCredentialKeyAttestation({
          client: adoptionClient,
          config: config(),
          actor,
          expectedDatabaseIdentity: adoptionIdentity,
        }),
        (error) => error.code
          === 'INTEGRATION_CREDENTIAL_KEY_LEGACY_FOOTPRINT_REQUIRES_REVIEW',
        `${store} must block the operator empty bootstrap`,
      )
      await remove()
    }

    const workbenchProbeId = randomUUID()
    await assertStoreBlocksEmptyBootstrap(
      'operations_commerce_order_workbench',
      () => adoptionClient.query(
        `INSERT INTO operations_commerce_order_workbench (
           id, organization_id, ship_to_source_hash,
           ship_to_ciphertext, ship_to_iv, ship_to_tag
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
        [
          workbenchProbeId,
          organizationId,
          '1'.repeat(64),
          randomBytes(32),
          randomBytes(12),
          randomBytes(16),
        ],
      ),
      () => adoptionClient.query(
        'DELETE FROM operations_commerce_order_workbench WHERE id = $1::uuid',
        [workbenchProbeId],
      ),
    )

    const workingCopyProbeId = randomUUID()
    await assertStoreBlocksEmptyBootstrap(
      'operations_order_shipment_address_working_copies',
      () => adoptionClient.query(
        `INSERT INTO operations_order_shipment_address_working_copies (
           id, organization_id, source_order_hash,
           ship_to_ciphertext, ship_to_iv, ship_to_tag
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
        [
          workingCopyProbeId,
          organizationId,
          '2'.repeat(64),
          randomBytes(32),
          randomBytes(12),
          randomBytes(16),
        ],
      ),
      () => adoptionClient.query(
        `DELETE FROM operations_order_shipment_address_working_copies
         WHERE id = $1::uuid`,
        [workingCopyProbeId],
      ),
    )

    const accounts = {
      shopify: { id: randomUUID(), globalId: 'gia0000001' },
      faire: { id: randomUUID(), globalId: 'gia0000002' },
      ups: { id: randomUUID(), globalId: 'gia0000003' },
      wwex: { id: randomUUID(), globalId: 'gia0000004' },
    }
    for (const [provider, account] of Object.entries(accounts)) {
      const environment = provider === 'faire' ? 'production' : 'production'
      const storedProvider = provider === 'ups' ? 'ups_rest'
        : provider === 'wwex' ? 'wwex_speedship'
          : provider
      await adoptionClient.query(
        `INSERT INTO operations_integration_accounts (
           id, global_id, organization_id, provider, environment
         ) VALUES ($1::uuid, $2, $3::uuid, $4, $5)`,
        [
          account.id,
          account.globalId,
          organizationId,
          storedProvider,
          environment,
        ],
      )
    }

    const shopifyExternalAccountId = 'gid://shopify/Shop/123456789'
    const shopifyCredential = encryptCredentialPayload(
      {
        provider: 'shopify',
        authMode: 'shopify_client_credentials',
        clientId: 'fixture-client',
        clientSecret: 'fixture-client-secret-value',
      },
      `clawpilot:commerce:${organizationId}:shopify:production:${shopifyExternalAccountId}:credential:v1`,
    )
    const faireExternalAccountId = 'faire-brand-fixture'
    const faireCredential = encryptCredentialPayload(
      {
        provider: 'faire',
        authMode: 'faire_brand_token',
        accessToken: 'fixture-faire-access-token',
      },
      `clawpilot:commerce:${organizationId}:faire:production:${faireExternalAccountId}:credential:v1`,
    )
    for (const fixture of [
      {
        account: accounts.shopify,
        externalAccountId: shopifyExternalAccountId,
        encrypted: shopifyCredential,
      },
      {
        account: accounts.faire,
        externalAccountId: faireExternalAccountId,
        encrypted: faireCredential,
      },
    ]) {
      await adoptionClient.query(
        `INSERT INTO operations_commerce_credentials (
           organization_id, integration_account_id, external_account_id,
           credential_ciphertext, credential_iv, credential_tag,
           credential_version
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 1)`,
        [
          organizationId,
          fixture.account.id,
          fixture.externalAccountId,
          fixture.encrypted.ciphertext,
          fixture.encrypted.iv,
          fixture.encrypted.tag,
        ],
      )
    }

    const upsCredential = encryptCredentialPayload(
      {
        clientId: 'fixture-ups-client',
        clientSecret: 'fixture-ups-client-secret',
        accountNumber: 'A12345',
      },
      `clawpilot:carrier:${organizationId}:ups_rest:production:credential:v1`,
    )
    const wwexCredential = encryptCredentialPayload(
      {
        authKind: 'oauth_client_credentials',
        clientId: 'fixture-wwex-client',
        clientSecret: 'fixture-wwex-client-secret',
        audience: 'https://fixture.example.test',
      },
      `clawpilot:brokered-transport:${organizationId}:wwex_speedship:production:credential:v1`,
    )
    for (const fixture of [
      { account: accounts.ups, encrypted: upsCredential },
      { account: accounts.wwex, encrypted: wwexCredential },
    ]) {
      await adoptionClient.query(
        `INSERT INTO operations_carrier_credentials (
           organization_id, integration_account_id,
           credential_ciphertext, credential_iv, credential_tag,
           credential_version
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, 1)`,
        [
          organizationId,
          fixture.account.id,
          fixture.encrypted.ciphertext,
          fixture.encrypted.iv,
          fixture.encrypted.tag,
        ],
      )
    }

    const carrierAccountId = randomUUID()
    const carrierAccountGlobalId = 'gac0000001'
    const carrierAccountNumber = encryptCredentialPayload(
      Buffer.from('A12345', 'utf8'),
      `clawpilot:carrier:${organizationId}:ups_rest:production:account:${carrierAccountGlobalId}:v1`,
    )
    await adoptionClient.query(
      `INSERT INTO operations_carrier_accounts (
         id, global_id, organization_id, integration_account_id,
         account_number_ciphertext, account_number_iv,
         account_number_tag, encryption_version
       ) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, 1)`,
      [
        carrierAccountId,
        carrierAccountGlobalId,
        organizationId,
        accounts.ups.id,
        carrierAccountNumber.ciphertext.toString('base64'),
        carrierAccountNumber.iv.toString('base64'),
        carrierAccountNumber.tag.toString('base64'),
      ],
    )

    const oauthId = randomUUID()
    const browserSessionId = randomUUID()
    const oauthStateHash = '3'.repeat(64)
    const oauthCredential = encryptCredentialPayload(
      {
        applicationId: 'fixture-faire-application',
        applicationSecret: 'fixture-faire-application-secret',
      },
      `clawpilot:commerce:${organizationId}:faire:${browserSessionId}:${oauthStateHash}:oauth-installation:v1`,
    )
    await adoptionClient.query(
      `INSERT INTO operations_commerce_oauth_installations (
         id, organization_id, browser_session_id, state_hash,
         application_credential_ciphertext, application_credential_iv,
         application_credential_tag
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
      [
        oauthId,
        organizationId,
        browserSessionId,
        oauthStateHash,
        oauthCredential.ciphertext,
        oauthCredential.iv,
        oauthCredential.tag,
      ],
    )

    const webhookId = randomUUID()
    const webhookEventId = 'shopify-webhook-fixture-1'
    const webhookTopic = 'orders/updated'
    const webhookPayload = encryptCredentialPayload(
      Buffer.from('{"id":"fixture-order"}', 'utf8'),
      `clawpilot:commerce:${accounts.shopify.globalId}:shopify:${webhookEventId}:${webhookTopic}:webhook:v1`,
    )
    await adoptionClient.query(
      `INSERT INTO operations_commerce_webhook_receipts (
         id, organization_id, integration_account_id, provider,
         provider_event_id, topic,
         payload_ciphertext, payload_iv, payload_tag
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'shopify', $4, $5, $6, $7, $8)`,
      [
        webhookId,
        organizationId,
        accounts.shopify.id,
        webhookEventId,
        webhookTopic,
        webhookPayload.ciphertext,
        webhookPayload.iv,
        webhookPayload.tag,
      ],
    )

    const candidateId = randomUUID()
    const candidateExternalOrderId = 'gid://shopify/Order/fixture-1'
    const candidateSourceHash = '7'.repeat(64)
    const partySnapshot = encryptCredentialPayload(
      { email: 'fixture@example.com' },
      `clawpilot:commerce:${organizationId}:${accounts.shopify.globalId}:${candidateExternalOrderId}:${candidateSourceHash}:party:candidate-snapshot:v1`,
    )
    const shipToSnapshot = encryptCredentialPayload(
      { line1: '1 Test Way', city: 'Testville' },
      `clawpilot:commerce:${organizationId}:${accounts.shopify.globalId}:${candidateExternalOrderId}:${candidateSourceHash}:ship_to:candidate-snapshot:v1`,
    )
    await adoptionClient.query(
      `INSERT INTO operations_commerce_order_candidates (
         id, organization_id, integration_account_id, external_order_id,
         source_hash, party_snapshot_ciphertext, party_snapshot_iv,
         party_snapshot_tag, ship_to_snapshot_ciphertext,
         ship_to_snapshot_iv, ship_to_snapshot_tag
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         $6, $7, $8, $9, $10, $11
       )`,
      [
        candidateId,
        organizationId,
        accounts.shopify.id,
        candidateExternalOrderId,
        candidateSourceHash,
        partySnapshot.ciphertext,
        partySnapshot.iv,
        partySnapshot.tag,
        shipToSnapshot.ciphertext,
        shipToSnapshot.iv,
        shipToSnapshot.tag,
      ],
    )

    const readIntentId = randomUUID()
    const providerAttemptId = randomUUID()
    const readRequestHash = '8'.repeat(64)
    const readResult = encryptCredentialPayload(
      Buffer.from('{"orders":[]}', 'utf8'),
      `clawpilot:commerce:${organizationId}:${accounts.shopify.globalId}:shopify:${readIntentId}:${providerAttemptId}:${readRequestHash}:intake-read-result:v1`,
    )
    await adoptionClient.query(
      `INSERT INTO operations_commerce_intake_read_intents (
         id, organization_id, integration_account_id, provider,
         provider_attempt_id, request_hash,
         response_ciphertext, response_iv, response_tag
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'shopify', $4::uuid, $5,
                 $6, $7, $8)`,
      [
        readIntentId,
        organizationId,
        accounts.shopify.id,
        providerAttemptId,
        readRequestHash,
        readResult.ciphertext,
        readResult.iv,
        readResult.tag,
      ],
    )

    const continuationId = randomUUID()
    const continuationSessionId = randomUUID()
    const continuationBatchNumber = 2
    const continuationQueryHash = '9'.repeat(64)
    const continuation = encryptCredentialPayload(
      { cursor: 'fixture-cursor' },
      `clawpilot:commerce:${organizationId}:${accounts.shopify.globalId}:shopify:${continuationSessionId}:${continuationBatchNumber}:${continuationQueryHash}:intake-continuation:v1`,
    )
    await adoptionClient.query(
      `INSERT INTO operations_commerce_intake_continuations (
         id, organization_id, integration_account_id, provider, session_id,
         batch_number, query_hash, cursor_ciphertext, cursor_iv, cursor_tag
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'shopify', $4::uuid, $5, $6,
                 $7, $8, $9)`,
      [
        continuationId,
        organizationId,
        accounts.shopify.id,
        continuationSessionId,
        continuationBatchNumber,
        continuationQueryHash,
        continuation.ciphertext,
        continuation.iv,
        continuation.tag,
      ],
    )

    const workbenchId = randomUUID()
    const workbenchExternalOrderId = 'gid://shopify/Order/fixture-workbench'
    const workbenchSourceHash = 'a'.repeat(64)
    const workbenchAddress = encryptCredentialPayload(
      { line1: '2 Test Way', city: 'Testville' },
      `clawpilot:commerce:${organizationId}:${accounts.shopify.globalId}:${workbenchExternalOrderId}:${workbenchSourceHash}:ship_to:candidate-snapshot:v1`,
    )
    await adoptionClient.query(
      `INSERT INTO operations_commerce_order_workbench (
         id, organization_id, integration_account_id, external_order_id,
         ship_to_source_hash, ship_to_ciphertext, ship_to_iv, ship_to_tag
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)`,
      [
        workbenchId,
        organizationId,
        accounts.shopify.id,
        workbenchExternalOrderId,
        workbenchSourceHash,
        workbenchAddress.ciphertext,
        workbenchAddress.iv,
        workbenchAddress.tag,
      ],
    )

    const sourceOrderId = randomUUID()
    const sourceOrderExternalId = 'gid://shopify/Order/fixture-working-copy'
    await adoptionClient.query(
      `INSERT INTO operations_orders (
         id, organization_id, integration_account_id, external_order_id
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      [
        sourceOrderId,
        organizationId,
        accounts.shopify.id,
        sourceOrderExternalId,
      ],
    )
    const workingCopyId = randomUUID()
    const workingCopySourceHash = 'b'.repeat(64)
    const workingCopyAddress = encryptCredentialPayload(
      { line1: '3 Test Way', city: 'Testville' },
      `clawpilot:commerce:${organizationId}:${accounts.shopify.globalId}:${sourceOrderExternalId}:${workingCopySourceHash}:ship_to:candidate-snapshot:v1`,
    )
    await adoptionClient.query(
      `INSERT INTO operations_order_shipment_address_working_copies (
         id, organization_id, order_id, source_order_hash,
         ship_to_ciphertext, ship_to_iv, ship_to_tag
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
      [
        workingCopyId,
        organizationId,
        sourceOrderId,
        workingCopySourceHash,
        workingCopyAddress.ciphertext,
        workingCopyAddress.iv,
        workingCopyAddress.tag,
      ],
    )

    await assert.rejects(
      insertDirectEmptyAttestation(),
      /empty bootstrap requires an empty key-backed store/iu,
    )
    await assert.rejects(
      planIntegrationCredentialKeyAdoption({
        client: adoptionClient,
        config: config(wrongKeyMaterial),
        actor,
        expectedDatabaseIdentity: adoptionIdentity,
      }),
      (error) => error.code
        === 'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
    )

    const wrongOauthCredential = encryptCredentialPayload(
      {
        applicationId: 'fixture-faire-application',
        applicationSecret: 'fixture-faire-application-secret',
      },
      `clawpilot:commerce:${organizationId}:faire:${browserSessionId}:${oauthStateHash}:oauth-installation:v1`,
      wrongKeyMaterial,
    )
    await adoptionClient.query(
      `UPDATE operations_commerce_oauth_installations
       SET application_credential_ciphertext = $2,
           application_credential_iv = $3,
           application_credential_tag = $4
       WHERE id = $1::uuid`,
      [
        oauthId,
        wrongOauthCredential.ciphertext,
        wrongOauthCredential.iv,
        wrongOauthCredential.tag,
      ],
    )
    await assert.rejects(
      planIntegrationCredentialKeyAdoption({
        client: adoptionClient,
        config: config(),
        actor,
        expectedDatabaseIdentity: adoptionIdentity,
      }),
      (error) => error.code
        === 'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
      'A mixed-key credential footprint must not be adopted',
    )
    await adoptionClient.query(
      `UPDATE operations_commerce_oauth_installations
       SET application_credential_ciphertext = $2,
           application_credential_iv = $3,
           application_credential_tag = $4
       WHERE id = $1::uuid`,
      [
        oauthId,
        oauthCredential.ciphertext,
        oauthCredential.iv,
        oauthCredential.tag,
      ],
    )

    const wrongWebhookPayload = encryptCredentialPayload(
      Buffer.from('{"id":"fixture-order"}', 'utf8'),
      `clawpilot:commerce:${accounts.shopify.globalId}:shopify:${webhookEventId}:${webhookTopic}:webhook:v1`,
      wrongKeyMaterial,
    )
    await adoptionClient.query(
      `UPDATE operations_commerce_webhook_receipts
       SET payload_ciphertext = $2, payload_iv = $3, payload_tag = $4
       WHERE id = $1::uuid`,
      [
        webhookId,
        wrongWebhookPayload.ciphertext,
        wrongWebhookPayload.iv,
        wrongWebhookPayload.tag,
      ],
    )
    await assert.rejects(
      planIntegrationCredentialKeyAdoption({
        client: adoptionClient,
        config: config(),
        actor,
        expectedDatabaseIdentity: adoptionIdentity,
      }),
      (error) => error.code
        === 'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
      'A mixed-key non-credential footprint must not be adopted',
    )
    await adoptionClient.query(
      `UPDATE operations_commerce_webhook_receipts
       SET payload_ciphertext = $2, payload_iv = $3, payload_tag = $4
       WHERE id = $1::uuid`,
      [
        webhookId,
        webhookPayload.ciphertext,
        webhookPayload.iv,
        webhookPayload.tag,
      ],
    )

    await adoptionClient.query(
      `UPDATE operations_commerce_order_candidates
       SET source_hash = $2
       WHERE id = $1::uuid`,
      [candidateId, 'c'.repeat(64)],
    )
    await assert.rejects(
      planIntegrationCredentialKeyAdoption({
        client: adoptionClient,
        config: config(),
        actor,
        expectedDatabaseIdentity: adoptionIdentity,
      }),
      (error) => error.code
        === 'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
      'AAD identity tampering must invalidate protected candidate snapshots',
    )
    await adoptionClient.query(
      `UPDATE operations_commerce_order_candidates
       SET source_hash = $2
       WHERE id = $1::uuid`,
      [candidateId, candidateSourceHash],
    )

    const plan = await planIntegrationCredentialKeyAdoption({
      client: adoptionClient,
      config: config(),
      actor,
      expectedDatabaseIdentity: adoptionIdentity,
      now: new Date('2026-09-05T12:00:00.000Z'),
    })
    assert.equal(plan.footprint.total, 13)
    assert.equal(plan.footprint.anchorCount, 13)
    assert.equal(JSON.stringify(plan).includes(keyMaterial), false)
    assert.equal(JSON.stringify(plan).includes('fixture-client-secret-value'), false)

    const insertDirectReviewedAttestation = () => adoptionClient.query(
      `INSERT INTO operations_integration_credential_key_attestations (
         singleton_id, attestation_version, database_identity, key_id,
         sentinel_ciphertext, sentinel_iv, sentinel_tag, bootstrap_mode,
         adoption_evidence_sha256, created_by
       ) VALUES (
         1, $1, $2::uuid, $3, $4, $5, $6,
         'reviewed_adoption', $7, $8
       )`,
      [
        generated.attestationVersion,
        adoptionIdentity,
        keyId,
        generated.sentinelCiphertext,
        generated.sentinelIv,
        generated.sentinelTag,
        plan.planDigest,
        actor,
      ],
    )
    await assert.rejects(
      insertDirectReviewedAttestation(),
      /transaction-local installation context/iu,
      'A raw reviewed-adoption sentinel insert must be rejected',
    )
    await adoptionClient.query('BEGIN')
    try {
      await adoptionClient.query(
        'SELECT set_config($1, $2, true)',
        [
          INTEGRATION_CREDENTIAL_KEY_REVIEWED_ADOPTION_INSTALL_CONTEXT,
          '0'.repeat(64),
        ],
      )
      await assert.rejects(
        insertDirectReviewedAttestation(),
        /transaction-local installation context/iu,
        'An unbound reviewed-adoption installation context must be rejected',
      )
    } finally {
      await adoptionClient.query('ROLLBACK')
    }
    await assert.rejects(
      applyIntegrationCredentialKeyAdoption({
        client: adoptionClient,
        config: config(),
        actor,
        expectedDatabaseIdentity: adoptionIdentity,
        plan,
        reviewedPlanDigest: '0'.repeat(64),
        now: new Date('2026-09-05T12:01:00.000Z'),
      }),
      (error) => error.code
        === 'INTEGRATION_CREDENTIAL_KEY_ADOPTION_REVIEW_REQUIRED',
    )
    async function assertReviewedPlanInvalidatedByDrift(store, insert, remove) {
      await insert()
      await assert.rejects(
        applyIntegrationCredentialKeyAdoption({
          client: adoptionClient,
          config: config(),
          actor,
          expectedDatabaseIdentity: adoptionIdentity,
          plan,
          reviewedPlanDigest: plan.planDigest,
          now: new Date('2026-09-05T12:01:00.000Z'),
        }),
        (error) => error.code
          === 'INTEGRATION_CREDENTIAL_KEY_ADOPTION_FOOTPRINT_CHANGED',
        `${store} drift must invalidate the reviewed adoption plan`,
      )
      await remove()
    }

    const workbenchDriftId = randomUUID()
    await assertReviewedPlanInvalidatedByDrift(
      'operations_commerce_order_workbench',
      () => adoptionClient.query(
        `INSERT INTO operations_commerce_order_workbench (
           id, organization_id, ship_to_source_hash,
           ship_to_ciphertext, ship_to_iv, ship_to_tag
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
        [
          workbenchDriftId,
          organizationId,
          '4'.repeat(64),
          randomBytes(32),
          randomBytes(12),
          randomBytes(16),
        ],
      ),
      () => adoptionClient.query(
        'DELETE FROM operations_commerce_order_workbench WHERE id = $1::uuid',
        [workbenchDriftId],
      ),
    )

    const workingCopyDriftId = randomUUID()
    await assertReviewedPlanInvalidatedByDrift(
      'operations_order_shipment_address_working_copies',
      () => adoptionClient.query(
        `INSERT INTO operations_order_shipment_address_working_copies (
           id, organization_id, source_order_hash,
           ship_to_ciphertext, ship_to_iv, ship_to_tag
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
        [
          workingCopyDriftId,
          organizationId,
          '5'.repeat(64),
          randomBytes(32),
          randomBytes(12),
          randomBytes(16),
        ],
      ),
      () => adoptionClient.query(
        `DELETE FROM operations_order_shipment_address_working_copies
         WHERE id = $1::uuid`,
        [workingCopyDriftId],
      ),
    )

    const adoptionWriter = await adoptionPool.connect()
    let releaseAdoptionLocks
    const adoptionLocksReleased = new Promise((resolve) => {
      releaseAdoptionLocks = resolve
    })
    let reportAdoptionLocks
    const adoptionLocks = new Promise((resolve) => {
      reportAdoptionLocks = resolve
    })
    const pausingAdoptionClient = {
      async query(...args) {
        const result = await adoptionClient.query(...args)
        if (
          typeof args[0] === 'string'
          && args[0].startsWith('LOCK TABLE ')
        ) {
          reportAdoptionLocks()
          await adoptionLocksReleased
        }
        return result
      },
    }
    const adoptionPromise = applyIntegrationCredentialKeyAdoption({
      client: pausingAdoptionClient,
      config: config(),
      actor,
      expectedDatabaseIdentity: adoptionIdentity,
      plan,
      reviewedPlanDigest: plan.planDigest,
      now: new Date('2026-09-05T12:01:00.000Z'),
    })
    await adoptionLocks
    await adoptionWriter.query("SET lock_timeout = '250ms'")
    try {
      await assert.rejects(
        adoptionWriter.query(
          `UPDATE operations_integration_accounts
           SET global_id = $2
           WHERE organization_id = $1::uuid
             AND id = $3::uuid`,
          [organizationId, 'gia0000099', accounts.shopify.id],
        ),
        (error) => error.code === '55P03',
        'Adoption locks must prevent authenticated account identity drift',
      )
      await assert.rejects(
        adoptionWriter.query(
          `INSERT INTO operations_order_shipment_address_working_copies (
             id, organization_id, source_order_hash,
             ship_to_ciphertext, ship_to_iv, ship_to_tag
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
          [
            randomUUID(),
            organizationId,
            '6'.repeat(64),
            randomBytes(32),
            randomBytes(12),
            randomBytes(16),
          ],
        ),
        (error) => error.code === '55P03',
        'Adoption SHARE locks must conflict with key-backed store writers',
      )
    } finally {
      releaseAdoptionLocks()
      adoptionWriter.release()
    }
    const adopted = await adoptionPromise
    assert.equal(adopted.status, 'verified')
    const stored = await adoptionClient.query(
      `SELECT bootstrap_mode, adoption_evidence_sha256,
              encode(sentinel_ciphertext, 'escape') AS ciphertext
       FROM operations_integration_credential_key_attestations`,
    )
    assert.deepEqual(
      {
        bootstrap_mode: stored.rows[0].bootstrap_mode,
        adoption_evidence_sha256: stored.rows[0].adoption_evidence_sha256,
      },
      {
        bootstrap_mode: 'reviewed_adoption',
        adoption_evidence_sha256: plan.planDigest,
      },
    )
    assert.equal(stored.rows[0].ciphertext.includes(keyMaterial), false)
    assert.equal(stored.rows[0].ciphertext.includes('fixture-client-secret'), false)
    const installContext = await adoptionClient.query(
      `SELECT COALESCE(NULLIF(current_setting($1, true), ''), '') = ''
         AS cleared`,
      [INTEGRATION_CREDENTIAL_KEY_REVIEWED_ADOPTION_INSTALL_CONTEXT],
    )
    assert.equal(
      installContext.rows[0].cleared,
      true,
      'Reviewed-adoption installation context must be transaction-local',
    )
  } finally {
    adoptionClient.release()
  }
} finally {
  await Promise.all([
    emptyPool.end(),
    concurrentPool.end(),
    adoptionPool.end(),
  ])
  stopDisposableContainer()
}

console.log('integration credential key attestation PostgreSQL tests passed')
