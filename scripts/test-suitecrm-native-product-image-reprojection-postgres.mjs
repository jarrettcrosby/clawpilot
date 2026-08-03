#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const IMAGE_SHA256 = createHash('sha256').update(IMAGE_BYTES).digest('hex')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

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

async function applyMigrations(client) {
  const files = readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right))
  for (const file of files) {
    await client.query('BEGIN')
    try {
      await client.query(read(`db/migrations/${file}`))
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw new Error(`Migration ${file} failed`, { cause: error })
    }
  }
}

function commandEnvironment(databaseUrl, additions = {}) {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED: '1',
    SUITECRM_BASE_URL: 'http://suitecrm.railway.internal:8080',
    CLAWPILOT_PUBLIC_URL: 'https://clawpilot.example.test',
    SUITECRM_MEDIA_USERNAME: 'clawpilot-media',
    SUITECRM_MEDIA_PASSWORD: 'dedicated-media-password',
    SUITECRM_ADMIN_USER: 'administrator',
    SUITECRM_ADMIN_PASSWORD: 'different-administrator-password',
    SUITECRM_CLIENT_ID: 'different-general-client',
    SUITECRM_CLIENT_SECRET: 'different-general-secret',
    ...additions,
  }
}

function runReprojection(databaseUrl, args, additions = {}) {
  return JSON.parse(command(
    process.execPath,
    ['scripts/requeue-suitecrm-native-product-image.mjs', ...args],
    { env: commandEnvironment(databaseUrl, additions) },
  ))
}

async function seed(pool) {
  const organizationId = randomUUID()
  const pipelineId = randomUUID()
  const productId = randomUUID()
  const suiteCrmId = randomUUID()
  const imageAssetId = randomUUID()
  const actorEmail = 'suitecrm-image-owner@example.com'
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO app_users (email, role, status, activated_at)
       VALUES ($1, 'owner', 'active', clock_timestamp())`,
      [actorEmail],
    )
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, created_by, updated_by
       ) VALUES ($1::uuid, 'Native image reprojection', $2, $2)`,
      [organizationId, actorEmail],
    )
    await client.query(
      `UPDATE app_users
       SET organization_id = $2::uuid,
           organization_name = 'Native image reprojection'
       WHERE email = $1`,
      [actorEmail, organizationId],
    )
    await client.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, status, is_default,
         created_by, updated_by
       ) VALUES ($1, $2::uuid, 'owner', 'active', true, $1, $1)`,
      [actorEmail, organizationId],
    )
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, is_default, workspace_organization_id
       ) VALUES (
         $1::uuid, 'Native image reprojection pipeline', $2, true, $3::uuid
       )`,
      [pipelineId, actorEmail, organizationId],
    )
    const product = await client.query(
      `INSERT INTO crm_products (
         id, pipeline_id, suitecrm_id, source_key, name, sku,
         product_type, category, price, cost, currency, url, description,
         source_hash, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'suitecrm-native-image-test',
         'SuiteCRM native image test', 'NATIVE-IMAGE-TEST', 'Good',
         'Test', 10, 5, 'USD', 'https://example.test/product',
         'SuiteCRM native image reprojection test', $4, $5, $5
       )
       RETURNING reference_code`,
      [
        productId,
        pipelineId,
        suiteCrmId,
        createHash('sha256').update('suitecrm-native-image-test').digest('hex'),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO crm_product_image_assets (
         id, organization_id, pipeline_id, product_id, asset_revision,
         content_bytes, mime_type, content_sha256, byte_length,
         pixel_width, pixel_height, alt_text, source, is_primary,
         row_version, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5,
         'image/png', $6, $7, 1, 1, 'Native image test',
         'manual_upload', true, 1, $8, $8
       )`,
      [
        imageAssetId,
        organizationId,
        pipelineId,
        productId,
        IMAGE_BYTES,
        IMAGE_SHA256,
        IMAGE_BYTES.byteLength,
        actorEmail,
      ],
    )
    await client.query('COMMIT')
    return {
      organizationId,
      pipelineId,
      productId,
      suiteCrmId,
      imageAssetId,
      actorEmail,
      referenceCode: product.rows[0].reference_code,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function verify(pool, databaseUrl) {
  const fixture = await seed(pool)
  const plan = runReprojection(
    databaseUrl,
    ['--product', fixture.referenceCode],
  )
  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'plan')
  assert.equal(plan.plan.alreadyProjected, false)
  assert.equal(plan.plan.nativeProjection.ready, true)
  assert.equal(plan.plan.imageContentSha256, IMAGE_SHA256)
  assert.match(plan.plan.confirmation, /^suitecrm-native-product-image:gp/u)

  const applied = runReprojection(
    databaseUrl,
    ['--product', fixture.referenceCode, '--apply'],
    {
      CLAWPILOT_SUITECRM_IMAGE_REPROJECT_ACTOR: fixture.actorEmail,
      CLAWPILOT_SUITECRM_IMAGE_REPROJECT_CONFIRM: plan.plan.confirmation,
    },
  )
  assert.equal(applied.changed, true)
  assert.equal(applied.reason, 'queued')
  assert.equal(applied.providerWrites, 0)

  const outbox = await pool.query(
    `SELECT id::text, status, attempts, payload
     FROM sync_outbox
     WHERE target_system = 'suitecrm'
       AND aggregate_type = 'crm_products'
       AND aggregate_id = $1
       AND payload ? 'productImage'
     ORDER BY created_at DESC
     LIMIT 1`,
    [fixture.productId],
  )
  assert.equal(outbox.rows[0].status, 'queued')
  assert.equal(outbox.rows[0].attempts, 0)
  assert.equal(outbox.rows[0].payload.productImageProjectionRequired, true)
  assert.equal(
    outbox.rows[0].payload.productImage.contentSha256,
    IMAGE_SHA256,
  )
  const queuedAudit = await pool.query(
    `SELECT count(*)::integer AS count
     FROM audit_events
     WHERE event_type =
       'crm.product_image.suitecrm_native_reprojection_queued'
       AND aggregate_id = $1`,
    [fixture.productId],
  )
  assert.equal(queuedAudit.rows[0].count, 1)

  const replay = runReprojection(
    databaseUrl,
    ['--product', fixture.referenceCode, '--apply'],
    {
      CLAWPILOT_SUITECRM_IMAGE_REPROJECT_ACTOR: fixture.actorEmail,
      CLAWPILOT_SUITECRM_IMAGE_REPROJECT_CONFIRM: plan.plan.confirmation,
    },
  )
  assert.equal(replay.changed, false)
  assert.equal(replay.reason, 'already_scheduled')
  const replayAudit = await pool.query(
    `SELECT count(*)::integer AS count
     FROM audit_events
     WHERE event_type =
       'crm.product_image.suitecrm_native_reprojection_queued'
       AND aggregate_id = $1`,
    [fixture.productId],
  )
  assert.equal(replayAudit.rows[0].count, 1)

  const mediaId = randomUUID()
  await pool.query(
    `UPDATE sync_outbox
     SET status = 'succeeded', processed_at = now(), updated_at = now()
     WHERE id = $1::uuid`,
    [outbox.rows[0].id],
  )
  await pool.query(
    `INSERT INTO audit_events (
       actor, subject, is_system, organization_id, event_type,
       aggregate_type, aggregate_id, payload, event_key
     ) VALUES (
       'system', 'system', true, $1::uuid,
       'crm.product_image.suitecrm_native_projection_completed',
       'crm_product', $2, $3::jsonb, $4
     )`,
    [
      fixture.organizationId,
      fixture.productId,
      JSON.stringify({
        productId: fixture.productId,
        productReferenceCode: fixture.referenceCode,
        suiteCrmId: fixture.suiteCrmId,
        imageContentSha256: IMAGE_SHA256,
        action: 'attached',
        mediaId,
        outboxId: outbox.rows[0].id,
        outboxAttempt: 1,
      }),
      `suitecrm-native-image-test-result:${fixture.productId}`,
    ],
  )
  const completedPlan = runReprojection(
    databaseUrl,
    ['--product', fixture.referenceCode],
  )
  assert.equal(completedPlan.plan.alreadyProjected, true)
  assert.equal(completedPlan.plan.latestNativeResult.mediaId, mediaId)
  const completedReplay = runReprojection(
    databaseUrl,
    ['--product', fixture.referenceCode, '--apply'],
    {
      CLAWPILOT_SUITECRM_IMAGE_REPROJECT_ACTOR: fixture.actorEmail,
      CLAWPILOT_SUITECRM_IMAGE_REPROJECT_CONFIRM: plan.plan.confirmation,
    },
  )
  assert.equal(completedReplay.changed, false)
  assert.equal(completedReplay.reason, 'already_projected')
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-suitecrm-native-image-${
    process.pid
  }-${randomUUID().slice(0, 8)}`
  let pool = null
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_suitecrm_native_image',
      '-e', 'POSTGRES_DB=clawpilot_suitecrm_native_image',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl =
      `postgresql://postgres:clawpilot_suitecrm_native_image@127.0.0.1:${
        port
      }/clawpilot_suitecrm_native_image`
    await waitForPostgres(databaseUrl)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    const migrationClient = await pool.connect()
    try {
      await applyMigrations(migrationClient)
    } finally {
      migrationClient.release()
    }
    await verify(pool, databaseUrl)
  } finally {
    if (pool) await pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'SuiteCRM native Product image reprojection PostgreSQL acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
