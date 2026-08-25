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
const expectedChecksum = 'd2ed980456eb4e0da6e58d1c8bc2fcff6dfe7430cc8a78ef22257f471a1cd350'
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
  vm.runInNewContext(output, {
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
          careerSiteMailPayloadHash: payloadHash,
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
  })
  assert.equal(claimed.length, 0, 'Wrong owner must not claim the message')
  let stored = await pool.query(
    'SELECT status, attempts FROM career_site_mail_outbox WHERE id = $1::uuid',
    [created.id],
  )
  assert.deepEqual(stored.rows[0], { status: 'queued', attempts: 0 })

  claimed = await persistence.claimCareerSiteMailOutboxInPostgres({ sourceApp, ownerEmail })
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].request.idempotencyKey, request.idempotencyKey)
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
  claimed = await persistence.claimCareerSiteMailOutboxInPostgres({ sourceApp, ownerEmail })
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].draftId, firstDraftId, 'Retry must retain and resend only the same durable Gmail draft')
  await persistence.completeCareerSiteMailOutboxInPostgres({
    item: claimed[0],
    providerMessageId: 'sent_mail_001',
  })
  stored = await pool.query(
    'SELECT status, draft_id, provider_message_id, delivered_at IS NOT NULL AS delivered FROM career_site_mail_outbox WHERE id = $1::uuid',
    [created.id],
  )
  assert.deepEqual(stored.rows[0], {
    status: 'succeeded',
    draft_id: firstDraftId,
    provider_message_id: 'sent_mail_001',
    delivered: true,
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
  let health = await persistence.readCareerSiteMailOperationalHealthFromPostgres({ sourceApp, ownerEmail })
  assert.equal(health.healthy, true)
  assert.equal(health.migration.checksumMatches, true)

  const otherId = randomUUID()
  await persistence.createCareerSiteMailInPostgres({
    actor: { ownerEmail: otherOwnerEmail, organizationId, sourceApp },
    request: contactRequest(otherId),
  })
  health = await persistence.readCareerSiteMailOperationalHealthFromPostgres({ sourceApp, ownerEmail })
  assert.equal(health.queue.outOfScopePending, 1)
  assert.equal(health.healthy, false)
  await pool.query('DELETE FROM career_site_mail_outbox WHERE owner_email = $1', [otherOwnerEmail])

  await pool.query(
    'UPDATE schema_migrations SET checksum = repeat($2, 64) WHERE filename = $1',
    [migrationFilename, 'f'],
  )
  health = await persistence.readCareerSiteMailOperationalHealthFromPostgres({ sourceApp, ownerEmail })
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
