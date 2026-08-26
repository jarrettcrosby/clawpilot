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
const migrationFilename = '0329_career_site_submissions.sql'
const migration = readFileSync(resolve(root, 'db/migrations', migrationFilename), 'utf8')
const migrationChecksum = createHash('sha256').update(migration).digest('hex')
const expectedChecksum = '57025eaa8a87a1b2b78b97bd700b633355c8f2bc56308923abf6c4210efd8045'
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

function loadPersistence(pool) {
  const path = 'app_src/lib/persistence/careerSiteSubmissions.ts'
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
  class RequestError extends Error {}
  vm.runInNewContext(output, {
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === 'node:crypto') return requireFromApp('node:crypto')
      if (specifier === '@/lib/auditWriter') return { async recordAuditEvent() {} }
      if (specifier === '@/lib/careerSiteSubmissionContract') {
        return {
          CareerSiteSubmissionRequestError: RequestError,
          careerSiteSubmissionPayloadHash: () => '0'.repeat(64),
        }
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

async function seedSubmission(pool, input) {
  const submissionId = randomUUID()
  const result = await pool.query(
    `INSERT INTO career_site_submissions (
       external_submission_id, source_app, owner_email,
       workspace_organization_id, form_type, requester_name,
       requester_email, interest, message, network_interest, role_fit,
       newsletter_consent, resume_variant, payload_hash
     ) VALUES (
       $1::uuid, $2, $3, $4::uuid, 'contact', 'Test Recruiter',
       $5, 'leadership', 'A deliberately bounded PostgreSQL test message.',
       false, false, false, NULL, $6
     ) RETURNING id::text`,
    [
      submissionId,
      sourceApp,
      input.ownerEmail,
      input.organizationId,
      input.requesterEmail,
      createHash('sha256').update(submissionId).digest('hex'),
    ],
  )
  const id = result.rows[0].id
  const outbox = await pool.query(
    `INSERT INTO career_site_submission_outbox (submission_id)
     VALUES ($1::uuid) RETURNING id::text`,
    [id],
  )
  return { id, outboxId: outbox.rows[0].id, submissionId }
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

  const scoped = await seedSubmission(pool, {
    ownerEmail,
    organizationId,
    requesterEmail: 'scoped@example.com',
  })
  await assert.rejects(
    pool.query(
      `UPDATE career_site_submission_outbox
       SET requeue_count = 1, last_requeued_at = now()
       WHERE id = $1::uuid`,
      [scoped.outboxId],
    ),
    /career_site_submission_outbox_requeue_audit_valid|check constraint/i,
  )
  const wrongScope = await persistence.claimCareerSiteSubmissionOutboxInPostgres({
    sourceApp,
    ownerEmail: otherOwnerEmail,
    organizationId,
    limit: 50,
  })
  assert.equal(wrongScope.length, 0, 'Wrong owner must not claim or consume attempts')
  const untouched = await pool.query(
    'SELECT status, attempts FROM career_site_submission_outbox WHERE id = $1::uuid',
    [scoped.outboxId],
  )
  assert.deepEqual(untouched.rows[0], { status: 'queued', attempts: 0 })

  const claimed = await persistence.claimCareerSiteSubmissionOutboxInPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
    limit: 50,
    leaseSeconds: 900,
  })
  assert.equal(claimed.length, 1, 'Claims must remain one item even when a larger limit is requested')
  assert.equal(claimed[0].externalSubmissionId, scoped.submissionId)
  const beforeRenewal = await pool.query(
    'SELECT locked_at::text FROM career_site_submission_outbox WHERE id = $1::uuid',
    [scoped.outboxId],
  )
  await pool.query('SELECT pg_sleep(0.01)')
  await persistence.renewCareerSiteSubmissionOutboxLeaseInPostgres(claimed[0])
  const afterRenewal = await pool.query(
    'SELECT locked_at::text FROM career_site_submission_outbox WHERE id = $1::uuid',
    [scoped.outboxId],
  )
  assert.ok(Date.parse(afterRenewal.rows[0].locked_at) > Date.parse(beforeRenewal.rows[0].locked_at))
  await persistence.completeCareerSiteSubmissionOutboxInPostgres(claimed[0])

  const firstQueued = await seedSubmission(pool, {
    ownerEmail,
    organizationId,
    requesterEmail: 'first@example.com',
  })
  const secondQueued = await seedSubmission(pool, {
    ownerEmail,
    organizationId,
    requesterEmail: 'second@example.com',
  })
  const oneAtATime = await persistence.claimCareerSiteSubmissionOutboxInPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
    limit: 50,
  })
  assert.equal(oneAtATime.length, 1)
  const stillQueued = await pool.query(
    `SELECT count(*)::integer AS count
     FROM career_site_submission_outbox
     WHERE id = ANY($1::uuid[]) AND status = 'queued'`,
    [[firstQueued.outboxId, secondQueued.outboxId]],
  )
  assert.equal(stillQueued.rows[0].count, 1)
  await persistence.completeCareerSiteSubmissionOutboxInPostgres(oneAtATime[0])
  const remaining = await persistence.claimCareerSiteSubmissionOutboxInPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
  })
  assert.equal(remaining.length, 1)
  await persistence.completeCareerSiteSubmissionOutboxInPostgres(remaining[0])

  let competingLock = null
  const primaryLock = await persistence.withCareerSiteSubmissionSheetLock('private-sheet-id', async () => {
    competingLock = await persistence.withCareerSiteSubmissionSheetLock(
      'private-sheet-id',
      async () => 'must-not-run',
    )
    return 'held'
  })
  assert.equal(primaryLock.acquired, true)
  assert.equal(primaryLock.value, 'held')
  assert.equal(competingLock.acquired, false)
  assert.equal(competingLock.value, null)

  await persistence.recordCareerSiteSubmissionWorkerHeartbeatInPostgres({
    phase: 'completed',
    workerId: 'postgres-test',
    claimed: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
  })
  let health = await persistence.readCareerSiteSubmissionOperationalHealthFromPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
    pollMs: 10_000,
    leaseSeconds: 900,
  })
  assert.equal(health.healthy, true)
  assert.equal(health.migration.checksumMatches, true)
  assert.equal(JSON.stringify(health).includes(ownerEmail), false)
  assert.equal(JSON.stringify(health).includes('scoped@example.com'), false)

  const retryable = await seedSubmission(pool, {
    ownerEmail,
    organizationId,
    requesterEmail: 'retryable@example.com',
  })
  await pool.query(
    `UPDATE career_site_submission_outbox
     SET status = 'failed', attempts = 1, available_at = now() + interval '30 seconds'
     WHERE id = $1::uuid`,
    [retryable.outboxId],
  )
  health = await persistence.readCareerSiteSubmissionOperationalHealthFromPostgres({ sourceApp, ownerEmail, organizationId })
  assert.equal(health.status, 'degraded')
  assert.equal(health.queue.failed, 1)
  assert.equal(health.healthy, true)
  await pool.query('DELETE FROM career_site_submissions WHERE id = $1::uuid', [retryable.id])

  const outOfScope = await seedSubmission(pool, {
    ownerEmail: otherOwnerEmail,
    organizationId,
    requesterEmail: 'other@example.com',
  })
  health = await persistence.readCareerSiteSubmissionOperationalHealthFromPostgres({ sourceApp, ownerEmail, organizationId })
  assert.equal(health.healthy, false)
  assert.equal(health.queue.outOfScopePending, 1)
  await pool.query('DELETE FROM career_site_submissions WHERE id = $1::uuid', [outOfScope.id])

  const dead = await seedSubmission(pool, {
    ownerEmail,
    organizationId,
    requesterEmail: 'dead@example.com',
  })
  await pool.query(
    `UPDATE career_site_submission_outbox
     SET status = 'dead', attempts = 8, processed_at = now()
     WHERE id = $1::uuid`,
    [dead.outboxId],
  )
  health = await persistence.readCareerSiteSubmissionOperationalHealthFromPostgres({ sourceApp, ownerEmail, organizationId })
  assert.equal(health.status, 'unhealthy')
  assert.equal(health.queue.dead, 1)
  const immutableBefore = await pool.query(
    `SELECT requester_email, payload_hash FROM career_site_submissions WHERE id = $1::uuid`,
    [dead.id],
  )
  for (let generation = 1; generation <= 3; generation += 1) {
    const requeued = await persistence.requeueDeadCareerSiteSubmissionInPostgres({
      actorEmail: ownerEmail,
      organizationId,
      submissionId: dead.submissionId,
      expectedGeneration: generation - 1,
      reason: `Operator Sheet recovery generation ${generation}`,
    })
    assert.equal(requeued.generation, generation)
    await pool.query(
      `UPDATE career_site_submission_outbox
       SET status = 'dead', attempts = 8, processed_at = now()
       WHERE id = $1::uuid`,
      [dead.outboxId],
    )
    if (generation === 1) {
      await assert.rejects(
        persistence.requeueDeadCareerSiteSubmissionInPostgres({
          actorEmail: ownerEmail,
          organizationId,
          submissionId: dead.submissionId,
          expectedGeneration: 0,
          reason: 'Replay after a lost recovery response must not spend another generation',
        }),
        (error) => error?.code === 'CAREER_SITE_SUBMISSION_REQUEUE_GENERATION_MISMATCH',
      )
      const replayState = await pool.query(
        'SELECT status, requeue_count FROM career_site_submission_outbox WHERE id = $1::uuid',
        [dead.outboxId],
      )
      assert.deepEqual(replayState.rows[0], { status: 'dead', requeue_count: 1 })
    }
  }
  await assert.rejects(
    persistence.requeueDeadCareerSiteSubmissionInPostgres({
      actorEmail: ownerEmail,
      organizationId,
      submissionId: dead.submissionId,
      expectedGeneration: 3,
      reason: 'A fourth Sheet recovery must be rejected',
    }),
    (error) => error?.code === 'CAREER_SITE_SUBMISSION_REQUEUE_LIMIT',
  )
  const immutableAfter = await pool.query(
    `SELECT requester_email, payload_hash FROM career_site_submissions WHERE id = $1::uuid`,
    [dead.id],
  )
  assert.deepEqual(immutableAfter.rows[0], immutableBefore.rows[0])
  await pool.query('DELETE FROM career_site_submissions WHERE id = $1::uuid', [dead.id])

  await pool.query(
    'UPDATE schema_migrations SET checksum = repeat($2, 64) WHERE filename = $1',
    [migrationFilename, 'f'],
  )
  health = await persistence.readCareerSiteSubmissionOperationalHealthFromPostgres({ sourceApp, ownerEmail, organizationId })
  assert.equal(health.healthy, false)
  assert.equal(health.migration.checksumMatches, false)
  await pool.query(
    'UPDATE schema_migrations SET checksum = $2 WHERE filename = $1',
    [migrationFilename, migrationChecksum],
  )

  await pool.query(
    `UPDATE app_settings
     SET value = jsonb_set(value, '{checkedAt}', to_jsonb((now() - interval '10 minutes')::text))
     WHERE key = 'career_site.submissions.outbox.worker.heartbeat'`,
  )
  health = await persistence.readCareerSiteSubmissionOperationalHealthFromPostgres({
    sourceApp,
    ownerEmail,
    organizationId,
    pollMs: 10_000,
  })
  assert.equal(health.worker.stale, true)
  assert.equal(health.healthy, false)

  await persistence.recordCareerSiteSubmissionWorkerHeartbeatInPostgres({
    phase: 'failed',
    workerId: 'postgres-test',
    claimed: 1,
    succeeded: 0,
    failed: 1,
    dead: 0,
  })
  health = await persistence.readCareerSiteSubmissionOperationalHealthFromPostgres({ sourceApp, ownerEmail, organizationId })
  assert.equal(health.worker.phase, 'failed')
  assert.equal(health.healthy, false)

  await pool.end()
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-career-site-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=career_site_submissions',
      '-e', 'POSTGRES_DB=career_site_submissions',
      '-p', '127.0.0.1::5432',
      'postgres:16-alpine',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:career_site_submissions@127.0.0.1:'
      + `${port}/career_site_submissions`
    )
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
  console.log('Career-site submissions disposable-PostgreSQL acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
