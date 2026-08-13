#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  actorEmail,
  applyStructuralRevisionAuthority,
  applyMigration,
  command,
  loadTypeScriptModule,
  migrations,
  orderIds,
  postgresAdapter,
  seedBeforeRevisionMigration,
  snapshot,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const tests = []

function test(name, callback) {
  tests.push({ name, callback })
}

async function rejectedTransaction(pool, pattern, callback) {
  const client = await pool.connect()
  let rejection = null
  try {
    await client.query('BEGIN')
    try {
      await callback(client)
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    } catch (error) {
      rejection = error
    }
    await client.query('ROLLBACK')
  } finally {
    client.release()
  }
  assert.ok(rejection, 'direct authority mutation unexpectedly succeeded')
  assert.match(
    String(rejection?.cause?.message || rejection?.message || rejection),
    pattern,
  )
}

function persistenceFor(pool) {
  const postgres = postgresAdapter(pool)
  return loadTypeScriptModule(
    'app_src/lib/persistence/commerceOrderRevisions.ts',
    {
      '@/lib/integrations/commerceReadRuntime': {
        commerceReadRuntimeAvailable: () => true,
        commerceReadAccountSql: () => "account.status <> 'error'",
      },
      '@/lib/persistence/postgres': postgres,
      '@/lib/auditWriter': {
        async recordAuditEvent(_input, client) {
          assert.ok(client, 'revision authority audit must be transaction-bound')
        },
      },
    },
  )
}

async function retainAcceptedOccurrence(pool, ids, persistence, evidence) {
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = CASE
       WHEN order_id = $1::uuid THEN now()
       ELSE now() + interval '1 day'
     END
     WHERE organization_id = $2::uuid`,
    [ids.current, ids.organization],
  )
  const claims = await persistence.claimCommerceOrderRevisionTargetsInPostgres({
    provider: 'shopify',
    workerId: 'revision-authority-accepted-read',
    limit: 1,
  })
  assert.equal(claims.length, 1)
  const claim = claims[0]
  assert.equal(claim.canonicalOrderId, ids.current)
  const normalizedSnapshot = snapshot({
    claim,
    sourceHash: 'a'.repeat(64),
    sourceRevision: 'revision-authority-current-v1',
    observedAt: new Date().toISOString(),
  })
  const retained = await persistence.captureCommerceOrderRevisionObservationInPostgres({
    claim,
    sourceRevision: normalizedSnapshot.order.sourceRevision,
    sourceHash: normalizedSnapshot.order.sourceHash,
    revisionHash: evidence.commerceOrderRevisionHash(normalizedSnapshot),
    normalizedSnapshot,
    providerReads: 2,
    providerWrites: 0,
    observedAt: normalizedSnapshot.observedAt,
  })
  assert.equal(retained.changed, false)
  const authority = (await pool.query(
    `SELECT
       target.id::text AS target_id,
       target.integration_account_id::text,
       target.order_id::text,
       target.provider,
       target.accepted_observation_id::text,
       target.accepted_read_id::text,
       target.accepted_source_hash,
       target.accepted_revision_hash,
       account.global_id AS account_global_id,
       account.external_account_id,
       account.commerce_credential_generation AS credential_generation,
       order_row.global_id AS order_global_id,
       order_row.external_order_id,
       order_row.row_version::text AS canonical_row_version,
       observation.source_revision,
       observation.source_hash,
       observation.revision_hash,
       observation.normalized_snapshot,
       observation.observed_at
     FROM operations_commerce_order_revision_targets target
     JOIN operations_orders order_row
       ON order_row.organization_id = target.organization_id
      AND order_row.id = target.order_id
     JOIN operations_integration_accounts account
       ON account.organization_id = target.organization_id
      AND account.id = target.integration_account_id
     JOIN operations_commerce_order_revision_observations observation
       ON observation.organization_id = target.organization_id
      AND observation.id = target.accepted_observation_id
     WHERE target.organization_id = $1::uuid
       AND target.order_id = $2::uuid`,
    [ids.organization, ids.current],
  )).rows[0]
  assert.ok(authority?.accepted_read_id)
  return authority
}

async function insertObservation(client, ids, authority, overrides = {}) {
  const normalizedSnapshot = overrides.normalizedSnapshot
    ? structuredClone(overrides.normalizedSnapshot)
    : structuredClone(authority.normalized_snapshot)
  const values = {
    integrationAccountId: authority.integration_account_id,
    targetId: authority.target_id,
    orderId: authority.order_id,
    provider: authority.provider,
    credentialGeneration: Number(authority.credential_generation),
    externalOrderId: authority.external_order_id,
    sourceRevision: `authority-observation-${randomUUID()}`,
    sourceHash: 'b'.repeat(64),
    revisionHash: 'c'.repeat(64),
    canonicalRowVersion: Number(authority.canonical_row_version),
    normalizedSnapshot,
    ...overrides,
  }
  delete values.normalizedSnapshot
  values.normalizedSnapshot = normalizedSnapshot
  values.normalizedSnapshot.order.sourceRevision = values.sourceRevision
  values.normalizedSnapshot.order.sourceHash = values.sourceHash
  values.normalizedSnapshot.canonicalOrderRowVersion =
    values.canonicalRowVersion
  values.normalizedSnapshot.credentialVersion = values.credentialGeneration
  return client.query(
    `INSERT INTO operations_commerce_order_revision_observations (
       organization_id, integration_account_id, target_id, order_id,
       provider, credential_generation, external_order_id, source_revision,
       source_hash, revision_hash, normalized_snapshot, canonical_row_version,
       provider_read_count, provider_write_count, observed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5, $6, $7, $8,
       $9, $10, $11::jsonb, $12,
       2, 0, now()
     ) RETURNING id::text, global_id`,
    [
      ids.organization,
      values.integrationAccountId,
      values.targetId,
      values.orderId,
      values.provider,
      values.credentialGeneration,
      values.externalOrderId,
      values.sourceRevision,
      values.sourceHash,
      values.revisionHash,
      JSON.stringify(values.normalizedSnapshot),
      values.canonicalRowVersion,
    ],
  )
}

async function insertRead(client, ids, authority, overrides = {}) {
  const values = {
    integrationAccountId: authority.integration_account_id,
    targetId: authority.target_id,
    observationId: authority.accepted_observation_id,
    orderId: authority.order_id,
    provider: authority.provider,
    credentialGeneration: Number(authority.credential_generation),
    sourceHash: authority.source_hash,
    revisionHash: authority.revision_hash,
    canonicalRowVersion: Number(authority.canonical_row_version),
    triggerKind: 'scheduled',
    commandReceiptId: null,
    actor: null,
    partyCiphertext: null,
    partyIv: null,
    partyTag: null,
    partyHash: null,
    partyFingerprint: null,
    partyKeyId: null,
    partyVersion: null,
    shipCiphertext: null,
    shipIv: null,
    shipTag: null,
    shipHash: null,
    shipFingerprint: null,
    shipKeyId: null,
    shipVersion: null,
    purgedAt: null,
    ...overrides,
  }
  return client.query(
    `INSERT INTO operations_commerce_order_revision_reads (
       organization_id, integration_account_id, target_id, observation_id,
       order_id, provider, credential_generation, source_hash,
       revision_hash, canonical_row_version, trigger_kind,
       command_receipt_id, actor_email,
       party_snapshot_ciphertext, party_snapshot_iv, party_snapshot_tag,
       party_snapshot_hash, party_content_fingerprint, party_snapshot_key_id,
       party_snapshot_encryption_version,
       ship_to_snapshot_ciphertext, ship_to_snapshot_iv, ship_to_snapshot_tag,
       ship_to_snapshot_hash, ship_to_content_fingerprint,
       ship_to_snapshot_key_id, ship_to_snapshot_encryption_version,
       provider_read_count, provider_write_count, observed_at,
       protected_snapshot_expires_at, protected_snapshot_purged_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, $6, $7, $8,
       $9, $10, $11,
       $12::uuid, $13,
       $14, $15, $16,
       $17, $18, $19, $20,
       $21, $22, $23,
       $24, $25, $26, $27,
       2, 0, now(), now() + interval '1 day', $28::timestamptz
     )`,
    [
      ids.organization,
      values.integrationAccountId,
      values.targetId,
      values.observationId,
      values.orderId,
      values.provider,
      values.credentialGeneration,
      values.sourceHash,
      values.revisionHash,
      values.canonicalRowVersion,
      values.triggerKind,
      values.commandReceiptId,
      values.actor,
      values.partyCiphertext,
      values.partyIv,
      values.partyTag,
      values.partyHash,
      values.partyFingerprint,
      values.partyKeyId,
      values.partyVersion,
      values.shipCiphertext,
      values.shipIv,
      values.shipTag,
      values.shipHash,
      values.shipFingerprint,
      values.shipKeyId,
      values.shipVersion,
      values.purgedAt,
    ],
  )
}

async function authorityMatrix(databaseUrl, ids) {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const persistence = persistenceFor(pool)
  const evidence = loadTypeScriptModule(
    'app_src/lib/integrations/commerceOrderRevisionEvidence.ts',
  )
  const authority = await retainAcceptedOccurrence(
    pool,
    ids,
    persistence,
    evidence,
  )

  test('observation rejects a crossed canonical order', async () => {
    await rejectedTransaction(pool, /observation lineage is invalid/u, (client) => (
      insertObservation(client, ids, authority, { orderId: ids.missing })
    ))
  })

  test('observation rejects a forged account Global ID', async () => {
    await rejectedTransaction(pool, /observation lineage is invalid/u, (client) => {
      const forged = structuredClone(authority.normalized_snapshot)
      forged.accountGlobalId = 'gia9999999'
      return insertObservation(client, ids, authority, {
        sourceHash: 'd'.repeat(64),
        revisionHash: 'e'.repeat(64),
        normalizedSnapshot: forged,
      })
    })
  })

  test('observation rejects a forged external account identity', async () => {
    await rejectedTransaction(pool, /observation lineage is invalid/u, (client) => {
      const forged = structuredClone(authority.normalized_snapshot)
      forged.externalAccountId = 'gid://shopify/Shop/9999999'
      return insertObservation(client, ids, authority, {
        sourceHash: 'f'.repeat(64),
        revisionHash: '1'.repeat(64),
        normalizedSnapshot: forged,
      })
    })
  })

  test('read rejects a crossed canonical order', async () => {
    await rejectedTransaction(pool, /exact read lineage is invalid/u, (client) => (
      insertRead(client, ids, authority, { orderId: ids.missing })
    ))
  })

  test('read rejects a source/revision tuple not owned by its observation', async () => {
    await rejectedTransaction(pool, /exact read lineage is invalid/u, (client) => (
      insertRead(client, ids, authority, {
        sourceHash: '2'.repeat(64),
        revisionHash: '3'.repeat(64),
      })
    ))
  })

  test('manager read rejects an unrelated command receipt', async () => {
    await rejectedTransaction(pool, /exact read lineage is invalid/u, async (client) => {
      const receipt = (await client.query(
        `INSERT INTO operations_command_receipts (
           organization_id, command_type, idempotency_key, request_hash,
           actor_email, status, correlation_id, target_global_id
         ) VALUES (
           $1::uuid, 'operations.commerce_order_revision.refresh', $2, $3,
           $4, 'processing', $5::uuid, NULL
         )
         RETURNING id::text`,
        [
          ids.organization,
          `authority-wrong-target-${randomUUID()}`,
          '4'.repeat(64),
          actorEmail,
          randomUUID(),
        ],
      )).rows[0]
      assert.ok(receipt?.id)
      return insertRead(client, ids, authority, {
        triggerKind: 'manager',
        commandReceiptId: receipt.id,
        actor: actorEmail,
      })
    })
  })

  test('accepted evidence tuple cannot change while retaining the same read', async () => {
    await rejectedTransaction(
      pool,
      /accepted revision evidence must match its exact read/u,
      (client) => (
        client.query(
          `UPDATE operations_commerce_order_revision_targets
           SET accepted_source_hash = $3,
               accepted_revision_hash = $4
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [
            ids.organization,
            authority.target_id,
            '5'.repeat(64),
            '6'.repeat(64),
          ],
        )
      ),
    )
  })

  test('party protected snapshot rejects a partial live tuple', async () => {
    await rejectedTransaction(pool, /ocr_reads_party_snapshot_valid/u, (client) => (
      insertRead(client, ids, authority, {
        partyCiphertext: Buffer.from('partial-party'),
        partyIv: Buffer.alloc(12, 1),
      })
    ))
  })

  test('ship-to protected snapshot rejects a partial live tuple', async () => {
    await rejectedTransaction(pool, /ocr_reads_ship_to_snapshot_valid/u, (client) => (
      insertRead(client, ids, authority, {
        shipCiphertext: Buffer.from('partial-ship-to'),
        shipIv: Buffer.alloc(12, 1),
      })
    ))
  })

  test('purged protected snapshot rejects incomplete retained metadata', async () => {
    await rejectedTransaction(pool, /ocr_reads_party_snapshot_valid/u, (client) => (
      insertRead(client, ids, authority, {
        partyHash: '7'.repeat(64),
        purgedAt: new Date().toISOString(),
      })
    ))
  })

  const revisionCrypto = loadTypeScriptModule(
    'app_src/lib/integrations/commerceCredentialCrypto.ts',
  )
  const appliedAuthority = await applyStructuralRevisionAuthority({
    pool,
    ids,
    persistence,
    evidence,
    revisionCrypto,
  })
  const installed = (await pool.query(
    `SELECT
       application.id::text AS application_id,
       application.expected_order_row_version::text,
       application.resulting_order_row_version::text,
       target.id::text AS target_id,
       candidate.id::text AS candidate_id
     FROM operations_commerce_order_revision_applications application
     JOIN operations_commerce_order_revision_targets target
       ON target.organization_id = application.organization_id
      AND target.applied_application_id = application.id
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = application.organization_id
      AND candidate.accepted_revision_application_id = application.id
     WHERE application.organization_id = $1::uuid
       AND application.global_id = $2`,
    [ids.organization, appliedAuthority.applied.applicationGlobalId],
  )).rows[0]
  assert.ok(installed?.application_id)

  test('candidate application pointer cannot be cleared', async () => {
    await rejectedTransaction(pool, /pointer cannot be cleared/u, (client) => (
      client.query(
        `UPDATE operations_commerce_order_candidates
         SET accepted_revision_application_id = NULL
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, installed.candidate_id],
      )
    ))
  })

  test('target application pointer cannot be cleared', async () => {
    await rejectedTransaction(pool, /pointer cannot be cleared/u, (client) => (
      client.query(
        `UPDATE operations_commerce_order_revision_targets
         SET applied_application_id = NULL
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, installed.target_id],
      )
    ))
  })

  test('candidate and target application pointers cannot split at commit', async () => {
    await rejectedTransaction(pool, /application pointers are split/u, async (client) => {
      const source = (await client.query(
        `SELECT * FROM operations_commerce_order_revision_applications
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, installed.application_id],
      )).rows[0]
      assert.ok(source)
      await client.query('SET LOCAL session_replication_role = replica')
      const later = (await client.query(
        `INSERT INTO operations_commerce_order_revision_applications (
           organization_id, integration_account_id, target_id,
           observation_id, read_id, order_id, provider, action,
           idempotency_key, request_hash, expected_order_row_version,
           resulting_order_row_version, previous_status, resulting_status,
           previous_source_hash, source_hash, revision_hash, change_summary,
           reason, provider_read_count, provider_write_count, actor_email,
           lifecycle_state, sealed_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16, $17, $18::jsonb, $19, $20, 0, $21,
           'sealed', now()
         ) RETURNING id::text`,
        [
          source.organization_id, source.integration_account_id,
          source.target_id, source.observation_id, source.read_id,
          source.order_id, source.provider, source.action,
          `authority-later-${randomUUID()}`, '8'.repeat(64),
          Number(source.resulting_order_row_version),
          Number(source.resulting_order_row_version) + 1,
          source.previous_status, source.resulting_status,
          source.source_hash, '8'.repeat(64), '9'.repeat(64),
          JSON.stringify(source.change_summary), source.reason,
          source.provider_read_count, actorEmail,
        ],
      )).rows[0]
      await client.query('SET LOCAL session_replication_role = origin')
      await client.query(
        `UPDATE operations_commerce_order_candidates
         SET accepted_revision_application_id = $3::uuid,
             row_version = row_version + 1
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, installed.candidate_id, later.id],
      )
    })
  })

  test('an application pointer cannot move to an equal or older result version', async () => {
    await rejectedTransaction(pool, /pointer must advance/u, async (client) => {
      const source = (await client.query(
        `SELECT * FROM operations_commerce_order_revision_applications
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, installed.application_id],
      )).rows[0]
      await client.query('SET LOCAL session_replication_role = replica')
      const older = (await client.query(
        `INSERT INTO operations_commerce_order_revision_applications (
           organization_id, integration_account_id, target_id,
           observation_id, read_id, order_id, provider, action,
           idempotency_key, request_hash, expected_order_row_version,
           resulting_order_row_version, previous_status, resulting_status,
           previous_source_hash, source_hash, revision_hash, change_summary,
           reason, provider_read_count, provider_write_count, actor_email,
           lifecycle_state, sealed_at
         ) SELECT
           organization_id, integration_account_id, target_id,
           observation_id, read_id, order_id, provider, action,
           $3, $4, expected_order_row_version, resulting_order_row_version,
           previous_status, resulting_status, previous_source_hash,
           $5, $6, change_summary, reason, provider_read_count, 0,
           actor_email, 'sealed', now()
         FROM operations_commerce_order_revision_applications
         WHERE organization_id = $1::uuid AND id = $2::uuid
         RETURNING id::text`,
        [
          ids.organization, installed.application_id,
          `authority-older-${randomUUID()}`, 'a'.repeat(64),
          'b'.repeat(64), 'c'.repeat(64),
        ],
      )).rows[0]
      await client.query('SET LOCAL session_replication_role = origin')
      await client.query(
        `UPDATE operations_commerce_order_candidates
         SET accepted_revision_application_id = $3::uuid
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, installed.candidate_id, older.id],
      )
    })
  })

  const failures = []
  for (const entry of tests) {
    try {
      await entry.callback()
      console.log(`ok - ${entry.name}`)
    } catch (error) {
      failures.push({ name: entry.name, error })
      console.error(`not ok - ${entry.name}`)
      console.error(error)
    }
  }
  await pool.end()
  if (failures.length) {
    throw new AggregateError(
      failures.map((entry) => entry.error),
      `${failures.length} commerce order revision authority checks failed`,
    )
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-order-revision-authority-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=commerce_order_revision_authority',
      '-e', 'POSTGRES_DB=commerce_order_revision_authority',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:commerce_order_revision_authority@127.0.0.1:'
      + `${port}/commerce_order_revision_authority`
    )
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    const files = migrations()
    const revisionIndex = files.indexOf(
      '0273_operations_commerce_order_revisions.sql',
    )
    assert.ok(revisionIndex > 0, '0273 commerce revision migration is missing')
    const ids = orderIds()
    try {
      for (const file of files.slice(0, revisionIndex)) {
        await applyMigration(client, file)
      }
      await seedBeforeRevisionMigration(client, ids)
      for (const file of files.slice(revisionIndex)) {
        await applyMigration(client, file)
      }
    } finally {
      client.release()
      await pool.end()
    }
    await authorityMatrix(databaseUrl, ids)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Commerce order revision direct authority matrix passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
