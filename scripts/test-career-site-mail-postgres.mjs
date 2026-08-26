#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
const migrationFilename = '0330_career_site_mail_outbox.sql'
const migration = readFileSync(resolve(root, 'db/migrations', migrationFilename), 'utf8')
const migrationChecksum = createHash('sha256').update(migration).digest('hex')
const expectedChecksum = '2812f40dd0d8e11529021276e37eac963a303ab60016c862b3425457d144915d'
const ownerEmail = 'jarrett@suburbiasandwichco.com'
const otherOwnerEmail = 'other@suburbiasandwichco.com'
const sourceApp = 'jarrett-career-site'

assert.equal(migrationChecksum, expectedChecksum)

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  }).trim()
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 45_000
  let lastError = null
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1_000, max: 1 })
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

function payloadHash(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function rfcMessageId(idempotencyKey) {
  const digest = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')
  return `career-site-${digest.slice(0, 40)}@suburbiasandwichco.com`
}

function loadPersistence(pool) {
  const path = 'app_src/lib/persistence/careerSiteMailOutbox.ts'
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const postgres = {
    query(text, values = []) {
      return pool.query(text, values)
    },
    async withTransaction(callback) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const value = await callback(client)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  }
  class RequestError extends Error {
    constructor(message, status, code) {
      super(message)
      this.status = status
      this.code = code
    }
  }
  const encryptedRequests = new Map()
  const encryptPayload = (request) => {
    const encoded = Buffer.from(JSON.stringify(request), 'utf8')
    const ciphertext = Buffer.from(encoded.map((byte) => byte ^ 0xaa))
    encryptedRequests.set(ciphertext.toString('hex'), request)
    return {
      ciphertext,
      iv: Buffer.alloc(12, 1),
      tag: Buffer.alloc(16, 2),
      keyId: 'career-test-v1',
      encryptionVersion: 1,
    }
  }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === 'node:crypto') return requireFromApp('node:crypto')
      if (specifier === '@/lib/auditWriter') return { async recordAuditEvent() {} }
      if (specifier === '@/lib/careerSiteMailContract') {
        return {
          CareerSiteMailRequestError: RequestError,
        }
      }
      if (specifier === '@/lib/careerSiteMailCrypto') {
        return {
          careerSiteMailPayloadFingerprint: payloadHash,
          encryptCareerSiteMailPayload: encryptPayload,
          decryptCareerSiteMailPayload(fields) {
            const request = encryptedRequests.get(fields.ciphertext.toString('hex'))
            if (!request) throw new Error('Stored career-site mail payload could not be decrypted')
            return request
          },
          careerSiteMailEncryptionKeyReadiness(referencedKeyIds) {
            return {
              ready: true,
              activeKeyId: 'career-test-v1',
              referencedKeyIds,
              missingReferencedKeyIds: [],
            }
          },
        }
      }
      if (specifier === '@/lib/careerSiteMailDelivery') {
        return { careerSiteRfcMessageId: rfcMessageId }
      }
      if (specifier === '@/lib/persistence/config') {
        return { isPostgresStorageEnabled: () => true }
      }
      if (specifier === '@/lib/persistence/postgres') return postgres
      throw new Error(`Unexpected persistence test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

async function installSchema(pool) {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE schema_migrations (
      filename text PRIMARY KEY,
      checksum text
    );
    CREATE TABLE app_settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE app_user_organization_memberships (
      user_email text NOT NULL,
      organization_id uuid NOT NULL,
      PRIMARY KEY (user_email, organization_id)
    );
  `)
  await pool.query(migration)
  await pool.query(
    'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
    [migrationFilename, migrationChecksum],
  )
}

function contactRequest(id, message = 'A deliberately bounded PostgreSQL mail test message.') {
  return {
    messageType: 'contact-notification',
    idempotencyKey: `contact/${id}`,
    data: {
      submissionId: id,
      name: 'Test Recruiter',
      email: 'recruiter@example.com',
      organization: null,
      interest: 'leadership',
      message,
    },
  }
}

async function acceptance(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 })
  const persistence = loadPersistence(pool)
  const organizationId = randomUUID()
  await pool.query(
    `INSERT INTO app_user_organization_memberships (user_email, organization_id)
     VALUES ($1, $3::uuid), ($2, $3::uuid)`,
    [ownerEmail, otherOwnerEmail, organizationId],
  )
  const actor = { ownerEmail, organizationId, sourceApp }
  const externalId = randomUUID()
  const request = contactRequest(externalId)
  const created = await persistence.createCareerSiteMailInPostgres({ actor, request })
  assert.equal(created.duplicate, false)
  assert.equal(created.status, 'queued')
  const payloadColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'career_site_mail_outbox'
       AND column_name IN ('payload', 'payload_ciphertext', 'payload_key_id')
     ORDER BY column_name`,
  )
  assert.deepEqual(payloadColumns.rows.map((row) => row.column_name), [
    'payload_ciphertext',
    'payload_key_id',
  ])
  const encryptedAtRest = await pool.query(
    `SELECT encode(payload_ciphertext, 'escape') AS ciphertext
     FROM career_site_mail_outbox WHERE id = $1::uuid`,
    [created.id],
  )
  assert.doesNotMatch(encryptedAtRest.rows[0].ciphertext, /recruiter@example|deliberately bounded/i)
  await assert.rejects(
    pool.query(
      'UPDATE career_site_mail_outbox SET payload_key_id = NULL WHERE id = $1::uuid',
      [created.id],
    ),
    /career_site_mail_outbox_payload_encryption_valid|check constraint/i,
  )
  await assert.rejects(
    pool.query(
      `UPDATE career_site_mail_outbox
       SET requeue_count = 1, last_requeued_at = now()
       WHERE id = $1::uuid`,
      [created.id],
    ),
    /career_site_mail_outbox_requeue_audit_valid|check constraint/i,
  )
  await assert.rejects(
    pool.query(
      `UPDATE career_site_mail_outbox SET draft_id = 'unreserved_draft'
       WHERE id = $1::uuid`,
      [created.id],
    ),
    /career_site_mail_outbox_provider_ids_valid|check constraint/i,
  )
  const replay = await persistence.createCareerSiteMailInPostgres({ actor, request })
  assert.equal(replay.duplicate, true)
  assert.equal(replay.status, 'queued')
  await assert.rejects(
    persistence.createCareerSiteMailInPostgres({
      actor,
      request: contactRequest(externalId, 'Different content must conflict with the same idempotency key.'),
    }),
    (error) => error?.code === 'CAREER_SITE_MAIL_IDEMPOTENCY_CONFLICT',
  )

  let claimed = await persistence.claimCareerSiteMailOutboxInPostgres({
    sourceApp,
    ownerEmail: otherOwnerEmail,
    organizationId,
  })
  assert.equal(claimed.length, 0, 'Wrong owner must not claim the message')
  let stored = await pool.query(
    'SELECT status, attempts FROM career_site_mail_outbox WHERE id = $1::uuid',
    [created.id],
  )
  assert.deepEqual(stored.rows[0], { status: 'queued', attempts: 0 })

  claimed = await persistence.claimCareerSiteMailOutboxInPostgres({ sourceApp, ownerEmail, organizationId })
  assert.equal(claimed.length, 1)
  assert.equal(
    persistence.decryptCareerSiteMailOutboxRequest(claimed[0]).idempotencyKey,
    request.idempotencyKey,
  )
  assert.equal(claimed[0].draftId, null)
  const firstDraftId = 'draft_mail_001'
  assert.equal(await persistence.saveCareerSiteMailDraftInPostgres({
    item: claimed[0],
    draftId: firstDraftId,
  }), firstDraftId)
  await persistence.failCareerSiteMailOutboxInPostgres({
    item: claimed[0],
    error: 'simulated retry-safe delivery response loss',
    retryBaseSeconds: 30,
  })
  await pool.query(
    'UPDATE career_site_mail_outbox SET available_at = now() WHERE id = $1::uuid',
    [created.id],
  )
  claimed = await persistence.claimCareerSiteMailOutboxInPostgres({ sourceApp, ownerEmail, organizationId })
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].draftId, firstDraftId, 'Retry must retain and resend only the same durable Gmail draft')
  await persistence.completeCareerSiteMailOutboxInPostgres({
    item: claimed[0],
    providerMessageId: 'sent_mail_001',
  })
  stored = await pool.query(
    `SELECT status, draft_id, provider_message_id,
       draft_creation_started_at IS NOT NULL AS draft_creation_started,
       delivered_at IS NOT NULL AS delivered,
       payload_ciphertext IS NULL AS payload_scrubbed,
       payload_purged_at IS NOT NULL AS payload_purged
     FROM career_site_mail_outbox WHERE id = $1::uuid`,
    [created.id],
  )
  assert.deepEqual(stored.rows[0], {
    status: 'succeeded',
    draft_id: firstDraftId,
    provider_message_id: 'sent_mail_001',
    draft_creation_started: true,
    delivered: true,
    payload_scrubbed: true,
    payload_purged: true,
  })
  const sentReplay = await persistence.createCareerSiteMailInPostgres({ actor, request })
  assert.equal(sentReplay.duplicate, true)
  assert.equal(sentReplay.status, 'sent')

  await persistence.recordCareerSiteMailWorkerHeartbeatInPostgres({
    phase: 'completed',
    workerId: 'postgres-test',
    claimed: 1,
    succeeded: 1,
    failed: 0,
    dead: 0,
  })
  let health = await persistence.readCareerSiteMailOperationalHealthFromPostgres({ sourceApp, ownerEmail, organizationId })
  assert.equal(health.healthy, true)
  assert.equal(health.migration.checksumMatches, true)

  const retryId = randomUUID()
  const retryCreated = await persistence.createCareerSiteMailInPostgres({
    actor,
    request: contactRequest(retryId),
  })
  let retryClaim = (await persistence.claimCareerSiteMailOutboxInPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
  }))[0]
  await persistence.failCareerSiteMailOutboxInPostgres({
    item: retryClaim,
    error: 'bounded transient failure',
  })
  await persistence.recordCareerSiteMailWorkerHeartbeatInPostgres({
    phase: 'degraded',
    workerId: 'postgres-test',
    claimed: 1,
    succeeded: 0,
    failed: 1,
    dead: 0,
  })
  health = await persistence.readCareerSiteMailOperationalHealthFromPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
  })
  assert.equal(health.status, 'degraded')
  assert.equal(health.queue.failed, 1)
  assert.equal(health.healthy, true, 'bounded retry degradation must keep readiness HTTP-2xx compatible')
  await pool.query('DELETE FROM career_site_mail_outbox WHERE id = $1::uuid', [retryCreated.id])
  await persistence.recordCareerSiteMailWorkerHeartbeatInPostgres({
    phase: 'completed',
    workerId: 'postgres-test',
    claimed: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
  })

  const deadId = randomUUID()
  const deadRequest = contactRequest(deadId)
  const deadCreated = await persistence.createCareerSiteMailInPostgres({ actor, request: deadRequest })
  let deadClaim = (await persistence.claimCareerSiteMailOutboxInPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
    maxAttempts: 1,
  }))[0]
  const retainedDraftId = 'draft_dead_recovery_001'
  await persistence.saveCareerSiteMailDraftInPostgres({ item: deadClaim, draftId: retainedDraftId })
  const retainedRfcMessageId = deadClaim.rfcMessageId
  assert.equal(await persistence.failCareerSiteMailOutboxInPostgres({
    item: deadClaim,
    error: 'terminal provider failure',
    maxAttempts: 1,
  }), 'dead')
  const deadReplay = await persistence.createCareerSiteMailInPostgres({ actor, request: deadRequest })
  assert.equal(deadReplay.duplicate, true)
  assert.equal(deadReplay.status, 'dead')
  for (let generation = 1; generation <= 3; generation += 1) {
    const requeued = await persistence.requeueDeadCareerSiteMailInPostgres({
      actorEmail: ownerEmail,
      organizationId,
      idempotencyKey: deadRequest.idempotencyKey,
      expectedGeneration: generation - 1,
      reason: `Operator recovery generation ${generation}`,
    })
    assert.equal(requeued.generation, generation)
    deadClaim = (await persistence.claimCareerSiteMailOutboxInPostgres({
      sourceApp,
      ownerEmail,
      organizationId,
      maxAttempts: 1,
    }))[0]
    assert.equal(deadClaim.draftId, retainedDraftId)
    assert.equal(deadClaim.rfcMessageId, retainedRfcMessageId)
    await persistence.failCareerSiteMailOutboxInPostgres({
      item: deadClaim,
      error: `terminal provider failure generation ${generation}`,
      maxAttempts: 1,
    })
    if (generation === 1) {
      await assert.rejects(
        persistence.requeueDeadCareerSiteMailInPostgres({
          actorEmail: ownerEmail,
          organizationId,
          idempotencyKey: deadRequest.idempotencyKey,
          expectedGeneration: 0,
          reason: 'Replay after a lost recovery response must not spend another generation',
        }),
        (error) => error?.code === 'CAREER_SITE_MAIL_REQUEUE_GENERATION_MISMATCH',
      )
      const replayState = await pool.query(
        'SELECT status, requeue_count FROM career_site_mail_outbox WHERE id = $1::uuid',
        [deadCreated.id],
      )
      assert.deepEqual(replayState.rows[0], { status: 'dead', requeue_count: 1 })
    }
  }
  await assert.rejects(
    persistence.requeueDeadCareerSiteMailInPostgres({
      actorEmail: ownerEmail,
      organizationId,
      idempotencyKey: deadRequest.idempotencyKey,
      expectedGeneration: 3,
      reason: 'A fourth recovery must be rejected',
    }),
    (error) => error?.code === 'CAREER_SITE_MAIL_REQUEUE_LIMIT',
  )

  const ambiguousDraftId = randomUUID()
  const ambiguousDraftRequest = contactRequest(ambiguousDraftId)
  const ambiguousDraftCreated = await persistence.createCareerSiteMailInPostgres({
    actor,
    request: ambiguousDraftRequest,
  })
  const ambiguousDraftClaim = (await persistence.claimCareerSiteMailOutboxInPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
    maxAttempts: 1,
  }))[0]
  assert.equal(
    await persistence.reserveCareerSiteMailDraftCreationInPostgres(ambiguousDraftClaim),
    true,
  )
  assert.equal(await persistence.failCareerSiteMailOutboxInPostgres({
    item: ambiguousDraftClaim,
    error: 'ambiguous draft creation with no searchable draft',
    maxAttempts: 1,
  }), 'dead')
  let ambiguousDraftState = await pool.query(
    `SELECT draft_creation_started_at IS NOT NULL AS reserved, draft_id
     FROM career_site_mail_outbox WHERE id = $1::uuid`,
    [ambiguousDraftCreated.id],
  )
  assert.deepEqual(ambiguousDraftState.rows[0], { reserved: true, draft_id: null })
  await persistence.requeueDeadCareerSiteMailInPostgres({
    actorEmail: ownerEmail,
    organizationId,
    idempotencyKey: ambiguousDraftRequest.idempotencyKey,
    expectedGeneration: 0,
    reason: 'Operator confirmed no draft was recoverable and authorized one new attempt',
  })
  ambiguousDraftState = await pool.query(
    `SELECT status, draft_creation_started_at, draft_id
     FROM career_site_mail_outbox WHERE id = $1::uuid`,
    [ambiguousDraftCreated.id],
  )
  assert.deepEqual(ambiguousDraftState.rows[0], {
    status: 'queued',
    draft_creation_started_at: null,
    draft_id: null,
  })
  await pool.query('DELETE FROM career_site_mail_outbox WHERE id = $1::uuid', [ambiguousDraftCreated.id])

  const expiredId = randomUUID()
  const expiredRequest = contactRequest(expiredId)
  const expiredCreated = await persistence.createCareerSiteMailInPostgres({ actor, request: expiredRequest })
  const expiredClaim = (await persistence.claimCareerSiteMailOutboxInPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
    maxAttempts: 1,
  }))[0]
  await persistence.failCareerSiteMailOutboxInPostgres({
    item: expiredClaim,
    error: 'terminal payload retention test',
    maxAttempts: 1,
  })
  await pool.query(
    `UPDATE career_site_mail_outbox SET updated_at = now() - interval '31 days'
     WHERE id = $1::uuid`,
    [expiredCreated.id],
  )
  assert.equal(await persistence.purgeExpiredCareerSiteMailDeadPayloadsInPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
    retentionDays: 30,
  }), 1)
  const expiredStored = await pool.query(
    `SELECT payload_ciphertext IS NULL AS scrubbed, payload_purged_at IS NOT NULL AS purged
     FROM career_site_mail_outbox WHERE id = $1::uuid`,
    [expiredCreated.id],
  )
  assert.deepEqual(expiredStored.rows[0], { scrubbed: true, purged: true })
  await assert.rejects(
    persistence.requeueDeadCareerSiteMailInPostgres({
      actorEmail: ownerEmail,
      organizationId,
      idempotencyKey: expiredRequest.idempotencyKey,
      expectedGeneration: 0,
      reason: 'Expired protected payload cannot be recovered',
    }),
    (error) => error?.code === 'CAREER_SITE_MAIL_PAYLOAD_PURGED',
  )
  await pool.query(
    'DELETE FROM career_site_mail_outbox WHERE id IN ($1::uuid, $2::uuid)',
    [deadCreated.id, expiredCreated.id],
  )

  const otherId = randomUUID()
  await persistence.createCareerSiteMailInPostgres({
    actor: { ownerEmail: otherOwnerEmail, organizationId, sourceApp },
    request: contactRequest(otherId),
  })
  health = await persistence.readCareerSiteMailOperationalHealthFromPostgres({ sourceApp, ownerEmail, organizationId })
  assert.equal(health.queue.outOfScopePending, 1)
  assert.equal(health.healthy, false)
  await pool.query('DELETE FROM career_site_mail_outbox WHERE owner_email = $1', [otherOwnerEmail])

  await pool.query(
    'UPDATE schema_migrations SET checksum = repeat($2, 64) WHERE filename = $1',
    [migrationFilename, 'f'],
  )
  health = await persistence.readCareerSiteMailOperationalHealthFromPostgres({ sourceApp, ownerEmail, organizationId })
  assert.equal(health.migration.checksumMatches, false)
  assert.equal(health.healthy, false)
  await pool.query(
    'UPDATE schema_migrations SET checksum = $2 WHERE filename = $1',
    [migrationFilename, migrationChecksum],
  )

  await pool.query(
    `UPDATE app_settings
     SET value = jsonb_set(value, '{checkedAt}', to_jsonb((now() - interval '10 minutes')::text))
     WHERE key = 'career_site.mail.outbox.worker.heartbeat'`,
  )
  health = await persistence.readCareerSiteMailOperationalHealthFromPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
    pollMs: 10_000,
  })
  assert.equal(health.worker.stale, true)
  assert.equal(health.healthy, false)

  await pool.end()
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-career-mail-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=career_site_mail',
      '-e', 'POSTGRES_DB=career_site_mail',
      '-p', '127.0.0.1::5432',
      'postgres:16-alpine',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = `postgresql://postgres:career_site_mail@127.0.0.1:${port}/career_site_mail`
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    await installSchema(pool)
    await pool.end()
    await acceptance(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Career-site mail disposable-PostgreSQL acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
