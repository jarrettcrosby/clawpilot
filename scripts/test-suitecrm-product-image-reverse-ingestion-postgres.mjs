#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { applyMigrationSqlForTest } from './lib/postgres-test-migrations.mjs'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const sharp = requireFromApp('sharp')
const ts = requireFromApp('typescript')
let runtimePool = null

const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))
const FOUR_BY_FIVE_WEBP = Uint8Array.from(Buffer.from(
  'UklGRh4AAABXRUJQVlA4TBEAAAAvAwABAAdQlFKUp/+BiOh/AAA=',
  'base64',
))

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    BigInt,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    Uint8Array,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
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
      await pool.end().catch(() => {})
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function applyMigrations(client) {
  const files = readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right))
  assert.ok(
    files.includes('0226_suitecrm_product_image_reverse_ingestion.sql'),
    'SuiteCRM Product image reverse-ingestion migration is missing',
  )
  for (const file of files) {
    await applyMigrationSqlForTest(
      client,
      file,
      read(`db/migrations/${file}`),
    )
  }
}

async function withRuntimeTransaction(callback) {
  assert.ok(runtimePool, 'Runtime PostgreSQL pool is not configured')
  const client = await runtimePool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

const postgresMock = {
  acquireTransactionAdvisoryLock: (client, key) => client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
    [key],
  ),
  query: (...args) => runtimePool.query(...args),
  withTransaction: withRuntimeTransaction,
}

const auditWriterMock = {
  async recordAuditEvent(input, client) {
    await client.query(
      `INSERT INTO audit_events (
         actor, event_type, aggregate_type, aggregate_id, payload, event_key,
         subject, organization_id, is_system
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6, $1, $7::uuid, false
       )
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
      [
        input.actor || null,
        input.eventType,
        input.aggregateType || null,
        input.aggregateId || null,
        JSON.stringify(input.payload || {}),
        input.eventKey || null,
        input.organizationId || null,
      ],
    )
  },
}

const productImageAssets = loadTypeScriptModule(
  'app_src/lib/crm/productImageAssets.ts',
)
const ingestion = loadTypeScriptModule(
  'app_src/lib/persistence/suiteCrmProductImageIngestion.ts',
  {
    '@/lib/auditWriter': auditWriterMock,
    '@/lib/crm/productImageAssets': productImageAssets,
    '@/lib/persistence/postgres': postgresMock,
  },
)

async function seedTenant(pool, key = 'primary') {
  const organizationId = randomUUID()
  const pipelineId = randomUUID()
  const actorEmail = key === 'primary'
    ? 'suitecrm-image-reader@example.com'
    : `suitecrm-image-reader-${key}@example.com`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO app_users (email, role, status, activated_at)
       VALUES ($1, 'owner', 'active', clock_timestamp())`,
      [actorEmail],
    )
    await client.query(
      `INSERT INTO workspace_organizations (id, name, created_by, updated_by)
       VALUES ($1::uuid, 'SuiteCRM image reverse ingestion', $2, $2)`,
      [organizationId, actorEmail],
    )
    await client.query(
      `UPDATE app_users
       SET organization_id = $2::uuid,
           organization_name = 'SuiteCRM image reverse ingestion'
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
         $1::uuid, 'SuiteCRM image pipeline', $2, true, $3::uuid
       )`,
      [pipelineId, actorEmail, organizationId],
    )
    await client.query('COMMIT')
    return { organizationId, pipelineId, actorEmail }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function addProduct(pool, tenant, key, suiteCrmId) {
  const product = await pool.query(
    `INSERT INTO crm_products (
       pipeline_id, suitecrm_id, source_key, name, sku, source_hash,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $7
     )
     RETURNING id::text, reference_code`,
    [
      tenant.pipelineId,
      suiteCrmId,
      `suitecrm-image-${key}`,
      `SuiteCRM image ${key}`,
      `SCI-${key}`.slice(0, 25),
      sha256(`product:${key}`),
      tenant.actorEmail,
    ],
  )
  return {
    id: product.rows[0].id,
    referenceCode: product.rows[0].reference_code,
    suiteCrmId,
  }
}

async function addManualPrimary(pool, tenant, product, bytes, mimeType, name) {
  const validated = productImageAssets.validateCrmProductImage({
    bytes,
    declaredMimeType: mimeType,
    altText: name,
  })
  const inserted = await pool.query(
    `INSERT INTO crm_product_image_assets (
       organization_id, pipeline_id, product_id, asset_revision,
       content_bytes, mime_type, content_sha256, byte_length, pixel_width,
       pixel_height, alt_text, source, is_primary, row_version,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 1, $4::bytea, $5, $6, $7, $8,
       $9, $10, 'manual_upload', true, 1, $11, $11
     )
     RETURNING id::text`,
    [
      tenant.organizationId,
      tenant.pipelineId,
      product.id,
      Buffer.from(validated.bytes),
      validated.mimeType,
      validated.contentSha256,
      validated.byteLength,
      validated.pixelWidth,
      validated.pixelHeight,
      validated.altText,
      tenant.actorEmail,
    ],
  )
  return { id: inserted.rows[0].id, ...validated }
}

function imageInput(tenant, product, values) {
  const bytes = values.bytes
  const contentSha256 = values.absent ? null : sha256(bytes)
  return {
    organizationId: tenant.organizationId,
    suiteCrmId: values.suiteCrmId || product.suiteCrmId,
    suiteCrmGlobalId: values.globalId || product.referenceCode,
    suiteCrmModifiedAt: values.modifiedAt,
    productName: `SuiteCRM image ${values.name || 'remote'}`,
    media: values.absent ? null : {
      mediaId: values.mediaId || randomUUID(),
      originalName: values.originalName || `remote-${contentSha256}.png`,
      mimeType: values.mimeType,
      contentSha256,
      bytes,
    },
    actorEmail: tenant.actorEmail,
    observedAt: values.observedAt || values.modifiedAt,
  }
}

async function verifyProductImageLockOrdering(pool, tenant, product) {
  const blocker = await pool.connect()
  let ingestPromise = null
  let ingestSettled = false
  try {
    await blocker.query('BEGIN')
    const blockerPid = await blocker.query('SELECT pg_backend_pid()::integer AS pid')
    await blocker.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [`crm-product-images:${tenant.organizationId}:${product.id}`],
    )

    ingestPromise = ingestion.ingestSuiteCrmProductImageSnapshotInPostgres(
      imageInput(tenant, product, {
        modifiedAt: '2026-08-02T12:40:00Z',
        mimeType: 'image/png',
        bytes: ONE_PIXEL_PNG,
      }),
    )

    const deadline = Date.now() + 5_000
    let advisoryWaiterObserved = false
    while (Date.now() < deadline) {
      const waiters = await pool.query(
        `SELECT count(*)::integer AS count
         FROM pg_stat_activity activity
         WHERE $1::integer = ANY(pg_blocking_pids(activity.pid))`,
        [blockerPid.rows[0].pid],
      )
      if (waiters.rows[0].count > 0) {
        advisoryWaiterObserved = true
        break
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    assert.equal(
      advisoryWaiterObserved,
      true,
      'SuiteCRM ingestion did not reach the Product-image advisory lock',
    )

    await blocker.query(
      `SELECT id
       FROM crm_products
       WHERE id = $1::uuid
       FOR UPDATE NOWAIT`,
      [product.id],
    )
    await blocker.query('ROLLBACK')

    const result = await ingestPromise
    ingestSettled = true
    assert.equal(result.resolution, 'imported_primary')
  } finally {
    await blocker.query('ROLLBACK').catch(() => {})
    blocker.release()
    if (ingestPromise && !ingestSettled) {
      await ingestPromise.catch(() => {})
    }
  }
}

async function verify(pool) {
  const authorityTriggers = await pool.query(
    `SELECT
       relation.relname,
       trigger_row.tgname,
       trigger_row.tgenabled,
       trigger_row.tgtype::integer,
       procedure.proname
     FROM pg_trigger trigger_row
     JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
     JOIN pg_proc procedure ON procedure.oid = trigger_row.tgfoid
     WHERE relation.relname IN (
       'crm_suitecrm_product_image_observations',
       'crm_suitecrm_product_image_asset_provenance',
       'crm_suitecrm_product_image_snapshot_fences'
     )
       AND NOT trigger_row.tgisinternal
     ORDER BY relation.relname, trigger_row.tgname`,
  )
  assert.deepEqual(authorityTriggers.rows, [
    {
      relname: 'crm_suitecrm_product_image_asset_provenance',
      tgname: 'guard_crm_suitecrm_product_image_provenance_write',
      tgenabled: 'O',
      tgtype: 31,
      proname: 'guard_crm_suitecrm_product_image_provenance',
    },
    {
      relname: 'crm_suitecrm_product_image_observations',
      tgname: 'guard_crm_suitecrm_product_image_observation_write',
      tgenabled: 'O',
      tgtype: 31,
      proname: 'guard_crm_suitecrm_product_image_observation',
    },
    {
      relname: 'crm_suitecrm_product_image_snapshot_fences',
      tgname: 'guard_crm_suitecrm_image_fence_initial_revision_write',
      tgenabled: 'O',
      tgtype: 5,
      proname: 'guard_crm_suitecrm_image_fence_initial_revision',
    },
    {
      relname: 'crm_suitecrm_product_image_snapshot_fences',
      tgname: 'guard_crm_suitecrm_product_image_snapshot_fence_write',
      tgenabled: 'O',
      tgtype: 31,
      proname: 'guard_crm_suitecrm_product_image_snapshot_fence',
    },
  ])
  const authorityConstraints = await pool.query(
    `SELECT conname
     FROM pg_constraint
     WHERE conrelid IN (
       'crm_suitecrm_product_image_observations'::regclass,
       'crm_suitecrm_product_image_asset_provenance'::regclass,
       'crm_suitecrm_product_image_snapshot_fences'::regclass
     )
       AND convalidated
       AND conname = ANY($1::text[])
     ORDER BY conname`,
    [[
      'crm_suitecrm_product_image_observation_provider_writes_zero',
      'crm_suitecrm_product_image_observation_correlation_valid',
      'crm_suitecrm_product_image_observation_media_valid',
      'crm_suitecrm_product_image_observation_primary_valid',
      'crm_suitecrm_product_image_observation_timestamp_valid',
      'crm_suitecrm_product_image_provenance_provider_writes_zero',
      'crm_suitecrm_product_image_provenance_scope_valid',
      'crm_suitecrm_product_image_provenance_primary_before_valid',
      'crm_suitecrm_product_image_provenance_result_valid',
      'crm_suitecrm_product_image_provenance_resolution_valid',
      'crm_suitecrm_product_image_snapshot_fence_provenance_fkey',
    ]],
  )
  assert.equal(authorityConstraints.rows.length, 11)

  const tenant = await seedTenant(pool)
  const product = await addProduct(
    pool,
    tenant,
    'primary',
    '11111111-1111-4111-8111-111111111111',
  )
  assert.equal(
    await ingestion.findSuiteCrmProductImageOrganizationInPostgres(
      product.referenceCode,
    ),
    tenant.organizationId,
  )
  const beforeOutbox = await pool.query(
    `SELECT count(*)::integer AS count
     FROM sync_outbox
     WHERE target_system IN ('suitecrm', 'shopify', 'faire')`,
  )

  const firstInput = imageInput(tenant, product, {
    modifiedAt: '2026-08-02T12:00:00Z',
    mimeType: 'image/png',
    bytes: ONE_PIXEL_PNG,
  })
  const otherTenant = await seedTenant(pool, 'other')
  const rotatedActorEmail = 'suitecrm-image-reader-rotated@example.com'
  await pool.query(
    `INSERT INTO app_users (
       email, role, status, activated_at, organization_id, organization_name
     ) VALUES (
       $1, 'owner', 'active', clock_timestamp(), $2::uuid,
       'SuiteCRM image reverse ingestion'
     )`,
    [rotatedActorEmail, tenant.organizationId],
  )
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, status, is_default,
       created_by, updated_by
     ) VALUES ($1, $2::uuid, 'owner', 'active', false, $3, $3)`,
    [rotatedActorEmail, tenant.organizationId, tenant.actorEmail],
  )
  await assert.rejects(
    ingestion.ingestSuiteCrmProductImageSnapshotInPostgres({
      ...firstInput,
      actorEmail: otherTenant.actorEmail,
    }),
    (error) => error?.code === 'SUITECRM_PRODUCT_IMAGE_ACTOR_FORBIDDEN',
  )
  await assert.rejects(
    ingestion.ingestSuiteCrmProductImageSnapshotInPostgres({
      ...firstInput,
      suiteCrmModifiedAt: '2026-08-02T12:10:01Z',
      observedAt: '2026-08-02T12:05:00Z',
    }),
    (error) => error?.code === 'SUITECRM_PRODUCT_IMAGE_MODIFIED_AT_FUTURE',
  )
  const first = await ingestion.ingestSuiteCrmProductImageSnapshotInPostgres(
    firstInput,
  )
  assert.equal(first.resolution, 'imported_primary')
  assert.equal(first.promotedToPrimary, true)
  assert.match(first.observationGlobalId, /^gsio[0-9a-v]{12}$/u)
  assert.match(first.provenanceGlobalId, /^gsip[0-9a-v]{12}$/u)
  const firstAsset = await pool.query(
    `SELECT source, is_primary, content_sha256
     FROM crm_product_image_assets
     WHERE id = $1::uuid`,
    [first.assetId],
  )
  assert.deepEqual(firstAsset.rows[0], {
    source: 'suitecrm_import',
    is_primary: true,
    content_sha256: sha256(ONE_PIXEL_PNG),
  })

  const replay = await ingestion.ingestSuiteCrmProductImageSnapshotInPostgres(
    firstInput,
  )
  assert.equal(replay.replayed, true)
  assert.equal(replay.observationId, first.observationId)
  const stale = await ingestion.ingestSuiteCrmProductImageSnapshotInPostgres(
    imageInput(tenant, product, {
      modifiedAt: '2026-08-02T11:59:00Z',
      mimeType: 'image/png',
      bytes: ONE_PIXEL_PNG,
    }),
  )
  assert.equal(stale.resolution, 'stale_ignored')
  assert.equal(stale.observationId, null)

  await assert.rejects(
    ingestion.ingestSuiteCrmProductImageSnapshotInPostgres(
      imageInput(tenant, product, {
        modifiedAt: '2026-08-02T12:00:00Z',
        mimeType: 'image/webp',
        bytes: FOUR_BY_FIVE_WEBP,
      }),
    ),
    (error) => error?.code === 'SUITECRM_PRODUCT_IMAGE_SNAPSHOT_CONFLICT',
  )

  const second = await ingestion.ingestSuiteCrmProductImageSnapshotInPostgres(
    imageInput(tenant, product, {
      modifiedAt: '2026-08-02T12:05:00Z',
      mimeType: 'image/webp',
      bytes: FOUR_BY_FIVE_WEBP,
      originalName: 'suitecrm-user-selection.webp',
    }),
  )
  assert.equal(second.resolution, 'imported_primary')
  const primaryAfterSecond = await pool.query(
    `SELECT id::text, source, content_sha256
     FROM crm_product_image_assets
     WHERE pipeline_id = $1::uuid AND product_id = $2::uuid
       AND is_primary = true`,
    [tenant.pipelineId, product.id],
  )
  assert.deepEqual(primaryAfterSecond.rows[0], {
    id: second.assetId,
    source: 'suitecrm_import',
    content_sha256: sha256(FOUR_BY_FIVE_WEBP),
  })

  const echo = await ingestion.ingestSuiteCrmProductImageSnapshotInPostgres(
    imageInput(tenant, product, {
      modifiedAt: '2026-08-02T12:10:00Z',
      mimeType: 'image/png',
      bytes: ONE_PIXEL_PNG,
      originalName: `${product.referenceCode}-${sha256(ONE_PIXEL_PNG)}.png`,
    }),
  )
  assert.equal(echo.resolution, 'echo_suppressed')
  assert.equal(echo.assetId, first.assetId)
  assert.equal(echo.promotedToPrimary, false)
  const primaryAfterEcho = await pool.query(
    `SELECT id::text FROM crm_product_image_assets
     WHERE pipeline_id = $1::uuid AND product_id = $2::uuid
       AND is_primary = true`,
    [tenant.pipelineId, product.id],
  )
  assert.equal(primaryAfterEcho.rows[0].id, second.assetId)

  const transformedProduct = await addProduct(
    pool,
    tenant,
    'transformed-echo',
    '99999999-9999-4999-8999-999999999999',
  )
  const transformedSource = await addManualPrimary(
    pool,
    tenant,
    transformedProduct,
    FOUR_BY_FIVE_WEBP,
    'image/webp',
    'Transformed echo authority',
  )
  const transformedPng = await sharp(Buffer.from(FOUR_BY_FIVE_WEBP), {
    failOn: 'warning',
    limitInputPixels: 40_000_000,
  }).rotate().png({
    compressionLevel: 9,
    adaptiveFiltering: true,
  }).toBuffer()
  const transformedEcho = await ingestion
    .ingestSuiteCrmProductImageSnapshotInPostgres(
      imageInput(tenant, transformedProduct, {
        modifiedAt: '2026-08-02T12:15:00Z',
        mimeType: 'image/png',
        bytes: transformedPng,
        originalName: `${transformedProduct.referenceCode}-${sha256(FOUR_BY_FIVE_WEBP)}-${sha256(transformedPng)}.png`,
      }),
    )
  assert.equal(transformedEcho.resolution, 'echo_suppressed')
  assert.notEqual(transformedEcho.assetId, transformedSource.id)
  assert.equal(transformedEcho.contentSha256, sha256(transformedPng))
  assert.equal(transformedEcho.promotedToPrimary, false)
  const transformedAssets = await pool.query(
    `SELECT id::text, source, content_sha256, is_primary
     FROM crm_product_image_assets
     WHERE pipeline_id = $1::uuid AND product_id = $2::uuid
     ORDER BY asset_revision`,
    [tenant.pipelineId, transformedProduct.id],
  )
  assert.deepEqual(transformedAssets.rows, [
    {
      id: transformedSource.id,
      source: 'manual_upload',
      content_sha256: sha256(FOUR_BY_FIVE_WEBP),
      is_primary: true,
    },
    {
      id: transformedEcho.assetId,
      source: 'suitecrm_import',
      content_sha256: sha256(transformedPng),
      is_primary: false,
    },
  ])

  const manualProduct = await addProduct(
    pool,
    tenant,
    'manual',
    '33333333-3333-4333-8333-333333333333',
  )
  const manualPrimary = await addManualPrimary(
    pool,
    tenant,
    manualProduct,
    ONE_PIXEL_PNG,
    'image/png',
    'Manual authority',
  )
  const secondary = await ingestion.ingestSuiteCrmProductImageSnapshotInPostgres(
    imageInput(tenant, manualProduct, {
      modifiedAt: '2026-08-02T12:20:00Z',
      mimeType: 'image/webp',
      bytes: FOUR_BY_FIVE_WEBP,
      originalName: 'suitecrm-independent-change.webp',
    }),
  )
  assert.equal(secondary.resolution, 'imported_secondary')
  assert.equal(secondary.promotedToPrimary, false)
  const manualStillPrimary = await pool.query(
    `SELECT id::text FROM crm_product_image_assets
     WHERE pipeline_id = $1::uuid AND product_id = $2::uuid
       AND is_primary = true`,
    [tenant.pipelineId, manualProduct.id],
  )
  assert.equal(manualStillPrimary.rows[0].id, manualPrimary.id)

  const identityConflict = await ingestion
    .ingestSuiteCrmProductImageSnapshotInPostgres(
      imageInput(tenant, manualProduct, {
        suiteCrmId: '44444444-4444-4444-8444-444444444444',
        modifiedAt: '2026-08-02T12:25:00Z',
        mimeType: 'image/png',
        bytes: ONE_PIXEL_PNG,
      }),
    )
  assert.equal(identityConflict.resolution, 'identity_conflict')
  assert.equal(identityConflict.productId, null)
  assert.equal(identityConflict.assetId, null)

  const integrityConflict = await ingestion
    .ingestSuiteCrmProductImageSnapshotInPostgres(
      imageInput(tenant, manualProduct, {
        modifiedAt: '2026-08-02T12:30:00Z',
        mimeType: 'image/webp',
        bytes: FOUR_BY_FIVE_WEBP,
        originalName: `${manualProduct.referenceCode}-${sha256(ONE_PIXEL_PNG)}.webp`,
      }),
    )
  assert.equal(integrityConflict.resolution, 'media_integrity_conflict')
  assert.equal(integrityConflict.assetId, null)

  await ingestion.writeSuiteCrmProductImageIngestionHeartbeatInPostgres({
    phase: 'degraded',
    details: { acceptance: true, providerWrites: 0 },
  })
  const health = await ingestion
    .readSuiteCrmProductImageIngestionHealthInPostgres()
  assert.equal(health.providerWrites, 0)
  assert.equal(health.importedPrimary, 2)
  assert.equal(health.importedSecondary, 1)
  assert.equal(health.echoesSuppressed, 2)
  assert.equal(health.identityConflicts, 1)
  assert.equal(health.mediaIntegrityConflicts, 1)
  assert.equal(health.heartbeat.phase, 'degraded')

  const removedSuiteCrmPrimary = await ingestion
    .ingestSuiteCrmProductImageSnapshotInPostgres(
      imageInput(tenant, product, {
        modifiedAt: '2026-08-02T12:35:00Z',
        absent: true,
      }),
    )
  assert.equal(removedSuiteCrmPrimary.resolution, 'no_image')
  assert.equal(removedSuiteCrmPrimary.assetId, null)
  const primaryAfterSuiteCrmRemoval = await pool.query(
    `SELECT id::text
     FROM crm_product_image_assets
     WHERE pipeline_id = $1::uuid AND product_id = $2::uuid
       AND is_primary = true`,
    [tenant.pipelineId, product.id],
  )
  assert.equal(primaryAfterSuiteCrmRemoval.rows.length, 0)
  const retainedSuiteCrmHistory = await pool.query(
    `SELECT is_primary
     FROM crm_product_image_assets
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [tenant.organizationId, second.assetId],
  )
  assert.deepEqual(retainedSuiteCrmHistory.rows[0], { is_primary: false })

  const absentAgainstManualPrimary = await ingestion
    .ingestSuiteCrmProductImageSnapshotInPostgres(
      imageInput(tenant, manualProduct, {
        modifiedAt: '2026-08-02T12:35:00Z',
        absent: true,
      }),
    )
  assert.equal(absentAgainstManualPrimary.resolution, 'no_image')
  assert.equal(absentAgainstManualPrimary.assetId, null)
  const manualAfterSuiteCrmRemoval = await pool.query(
    `SELECT id::text
     FROM crm_product_image_assets
     WHERE pipeline_id = $1::uuid AND product_id = $2::uuid
       AND is_primary = true`,
    [tenant.pipelineId, manualProduct.id],
  )
  assert.equal(manualAfterSuiteCrmRemoval.rows[0].id, manualPrimary.id)

  const absentIdentityConflict = await ingestion
    .ingestSuiteCrmProductImageSnapshotInPostgres(
      imageInput(tenant, manualProduct, {
        suiteCrmId: '77777777-7777-4777-8777-777777777777',
        modifiedAt: '2026-08-02T12:36:00Z',
        absent: true,
      }),
    )
  assert.equal(absentIdentityConflict.resolution, 'identity_conflict')
  assert.equal(absentIdentityConflict.productId, null)

  const rotatedActorRemoval = await ingestion
    .ingestSuiteCrmProductImageSnapshotInPostgres({
      ...imageInput(tenant, product, {
        modifiedAt: '2026-08-02T12:37:00Z',
        absent: true,
      }),
      actorEmail: rotatedActorEmail,
    })
  assert.equal(rotatedActorRemoval.resolution, 'no_image')
  const rotatedFenceActor = await pool.query(
    `SELECT created_by, updated_by
     FROM crm_suitecrm_product_image_snapshot_fences
     WHERE organization_id = $1::uuid AND suitecrm_id = $2`,
    [tenant.organizationId, product.suiteCrmId],
  )
  assert.deepEqual(rotatedFenceActor.rows[0], {
    created_by: tenant.actorEmail,
    updated_by: rotatedActorEmail,
  })

  const immutableObservation = await pool.query(
    `SELECT id::text FROM crm_suitecrm_product_image_observations
     ORDER BY created_at LIMIT 1`,
  )
  await assert.rejects(
    pool.query(
      `UPDATE crm_suitecrm_product_image_observations
       SET observed_at = clock_timestamp()
       WHERE id = $1::uuid`,
      [immutableObservation.rows[0].id],
    ),
    /observations are immutable/u,
  )
  const immutableProvenance = await pool.query(
    `SELECT id::text FROM crm_suitecrm_product_image_asset_provenance
     ORDER BY imported_at LIMIT 1`,
  )
  await assert.rejects(
    pool.query(
      `DELETE FROM crm_suitecrm_product_image_asset_provenance
       WHERE id = $1::uuid`,
      [immutableProvenance.rows[0].id],
    ),
    /provenance is immutable/u,
  )
  await assert.rejects(
    pool.query(
      `UPDATE crm_suitecrm_product_image_snapshot_fences
       SET accepted_suitecrm_modified_at = accepted_suitecrm_modified_at
             - interval '1 minute',
           fence_revision = fence_revision + 1,
           updated_by = $3
       WHERE organization_id = $1::uuid AND suitecrm_id = $2`,
      [tenant.organizationId, product.suiteCrmId, tenant.actorEmail],
    ),
    /snapshot fence cannot regress/u,
  )

  await assert.rejects(
    pool.query(
      `INSERT INTO crm_suitecrm_product_image_observations (
         organization_id, pipeline_id, product_id, suitecrm_id,
         suitecrm_global_id, suitecrm_modified_at, correlation_state,
         media_state, media_id, original_name, mime_type, content_sha256,
         byte_length, pixel_width, pixel_height, snapshot_sha256,
         observation_revision, observed_by, observed_at,
         provider_write_count
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz,
         'exact', 'present', $7::uuid, NULL, 'image/png', $8,
         $9, 1, 1, $10, 1000, $11, $6::timestamptz, 0
       )`,
      [
        tenant.organizationId,
        tenant.pipelineId,
        product.id,
        product.suiteCrmId,
        product.referenceCode,
        '2026-08-03T00:00:00Z',
        randomUUID(),
        sha256(ONE_PIXEL_PNG),
        ONE_PIXEL_PNG.byteLength,
        sha256('malformed-present-observation'),
        tenant.actorEmail,
      ],
    ),
    /observation_media_valid/u,
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO crm_suitecrm_product_image_observations (
         organization_id, pipeline_id, product_id, suitecrm_id,
         suitecrm_global_id, suitecrm_modified_at, correlation_state,
         media_state, snapshot_sha256, observation_revision, observed_by,
         observed_at, provider_write_count
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz,
         'exact', 'absent', $7, 1001, $8, $9::timestamptz, 0
       )`,
      [
        tenant.organizationId,
        tenant.pipelineId,
        product.id,
        product.suiteCrmId,
        product.referenceCode,
        '2026-08-03T00:05:01Z',
        sha256('future-observation'),
        tenant.actorEmail,
        '2026-08-03T00:00:00Z',
      ],
    ),
    /observation_timestamp_valid/u,
  )

  const lineageProduct = await addProduct(
    pool,
    tenant,
    'lineage',
    '66666666-6666-4666-8666-666666666666',
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO crm_suitecrm_product_image_observations (
         organization_id, pipeline_id, product_id, suitecrm_id,
         suitecrm_global_id, suitecrm_modified_at, correlation_state,
         media_state, snapshot_sha256, observation_revision, observed_by,
         observed_at, provider_write_count
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz,
         'exact', 'absent', $7, 999, $8, $6::timestamptz, 0
       )`,
      [
        tenant.organizationId,
        tenant.pipelineId,
        lineageProduct.id,
        lineageProduct.suiteCrmId,
        lineageProduct.referenceCode,
        '2026-08-03T00:00:30Z',
        sha256('wrong-tenant-observation'),
        otherTenant.actorEmail,
      ],
    ),
    /requires active organization membership/u,
  )
  const lineageSnapshotOne = sha256('lineage-observation-one')
  const lineageObservationOne = await pool.query(
    `INSERT INTO crm_suitecrm_product_image_observations (
       organization_id, pipeline_id, product_id, suitecrm_id,
       suitecrm_global_id, suitecrm_modified_at, correlation_state,
       media_state, snapshot_sha256, observation_revision, observed_by,
       observed_at, provider_write_count
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz,
       'exact', 'absent', $7, 1, $8, $6::timestamptz, 0
     ) RETURNING id::text`,
    [
      tenant.organizationId,
      tenant.pipelineId,
      lineageProduct.id,
      lineageProduct.suiteCrmId,
      lineageProduct.referenceCode,
      '2026-08-03T00:01:00Z',
      lineageSnapshotOne,
      tenant.actorEmail,
    ],
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO crm_suitecrm_product_image_asset_provenance (
         organization_id, suitecrm_id, observation_id, pipeline_id,
         product_id, resolution, promoted_to_primary,
         provider_write_count, imported_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'no_image',
         false, 0, $6
       )`,
      [
        tenant.organizationId,
        lineageProduct.suiteCrmId,
        lineageObservationOne.rows[0].id,
        tenant.pipelineId,
        manualProduct.id,
        tenant.actorEmail,
      ],
    ),
    /does not match its observation lineage/u,
  )
  await pool.query(
    `INSERT INTO crm_suitecrm_product_image_asset_provenance (
       organization_id, suitecrm_id, observation_id, pipeline_id,
       product_id, resolution, promoted_to_primary,
       provider_write_count, imported_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'no_image',
       false, 0, $6
     )`,
    [
      tenant.organizationId,
      lineageProduct.suiteCrmId,
      lineageObservationOne.rows[0].id,
      tenant.pipelineId,
      lineageProduct.id,
      tenant.actorEmail,
    ],
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO crm_suitecrm_product_image_snapshot_fences (
         organization_id, suitecrm_id, pipeline_id, product_id,
         accepted_suitecrm_modified_at, accepted_snapshot_sha256,
         accepted_observation_id, fence_revision, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::timestamptz, $6,
         $7::uuid, 1, $8, $8
       )`,
      [
        tenant.organizationId,
        lineageProduct.suiteCrmId,
        tenant.pipelineId,
        manualProduct.id,
        '2026-08-03T00:01:00Z',
        lineageSnapshotOne,
        lineageObservationOne.rows[0].id,
        tenant.actorEmail,
      ],
    ),
    /does not match exact observation evidence/u,
  )

  const lineageSnapshotTwo = sha256('lineage-observation-two')
  const lineageObservationTwo = await pool.query(
    `INSERT INTO crm_suitecrm_product_image_observations (
       organization_id, pipeline_id, product_id, suitecrm_id,
       suitecrm_global_id, suitecrm_modified_at, correlation_state,
       media_state, snapshot_sha256, observation_revision, observed_by,
       observed_at, provider_write_count
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz,
       'exact', 'absent', $7, 2, $8, $6::timestamptz, 0
     ) RETURNING id::text`,
    [
      tenant.organizationId,
      tenant.pipelineId,
      lineageProduct.id,
      lineageProduct.suiteCrmId,
      lineageProduct.referenceCode,
      '2026-08-03T00:02:00Z',
      lineageSnapshotTwo,
      tenant.actorEmail,
    ],
  )
  await pool.query(
    `INSERT INTO crm_suitecrm_product_image_asset_provenance (
       organization_id, suitecrm_id, observation_id, pipeline_id,
       product_id, resolution, promoted_to_primary,
       provider_write_count, imported_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'no_image',
       false, 0, $6
     )`,
    [
      tenant.organizationId,
      lineageProduct.suiteCrmId,
      lineageObservationTwo.rows[0].id,
      tenant.pipelineId,
      lineageProduct.id,
      tenant.actorEmail,
    ],
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO crm_suitecrm_product_image_snapshot_fences (
         organization_id, suitecrm_id, pipeline_id, product_id,
         accepted_suitecrm_modified_at, accepted_snapshot_sha256,
         accepted_observation_id, fence_revision, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::timestamptz, $6,
         $7::uuid, 2, $8, $8
       )`,
      [
        tenant.organizationId,
        lineageProduct.suiteCrmId,
        tenant.pipelineId,
        lineageProduct.id,
        '2026-08-03T00:02:00Z',
        lineageSnapshotTwo,
        lineageObservationTwo.rows[0].id,
        tenant.actorEmail,
      ],
    ),
    /must begin at revision one/u,
  )

  const lineageWrongAsset = await addManualPrimary(
    pool,
    tenant,
    lineageProduct,
    ONE_PIXEL_PNG,
    'image/png',
    'Lineage wrong-content asset',
  )
  const lineageObservationThree = await pool.query(
    `INSERT INTO crm_suitecrm_product_image_observations (
       organization_id, pipeline_id, product_id, suitecrm_id,
       suitecrm_global_id, suitecrm_modified_at, correlation_state,
       media_state, media_id, original_name, mime_type, content_sha256,
       byte_length, pixel_width, pixel_height, snapshot_sha256,
       observation_revision, local_primary_asset_id,
       local_primary_asset_revision, local_primary_row_version,
       local_primary_content_sha256, observed_by, observed_at,
       provider_write_count
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz,
       'exact', 'present', $7::uuid, 'lineage-observed.webp',
       'image/webp', $8, $9, 4, 5, $10, 3, $11::uuid, 1, 1, $12,
       $13, $6::timestamptz, 0
     ) RETURNING id::text`,
    [
      tenant.organizationId,
      tenant.pipelineId,
      lineageProduct.id,
      lineageProduct.suiteCrmId,
      lineageProduct.referenceCode,
      '2026-08-03T00:03:00Z',
      randomUUID(),
      sha256(FOUR_BY_FIVE_WEBP),
      FOUR_BY_FIVE_WEBP.byteLength,
      sha256('lineage-observation-three'),
      lineageWrongAsset.id,
      lineageWrongAsset.contentSha256,
      tenant.actorEmail,
    ],
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO crm_suitecrm_product_image_asset_provenance (
         organization_id, suitecrm_id, observation_id, pipeline_id,
         product_id, resolution, local_primary_before_asset_id,
         local_primary_before_revision, local_primary_before_row_version,
         local_primary_before_content_sha256, result_asset_id,
         result_asset_revision, result_asset_content_sha256,
         promoted_to_primary, provider_write_count, imported_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         'echo_suppressed', $6::uuid, 1, 1, $7, $6::uuid, 1, $7,
         false, 0, $8
       )`,
      [
        tenant.organizationId,
        lineageProduct.suiteCrmId,
        lineageObservationThree.rows[0].id,
        tenant.pipelineId,
        lineageProduct.id,
        lineageWrongAsset.id,
        lineageWrongAsset.contentSha256,
        tenant.actorEmail,
      ],
    ),
    /result evidence is not exact/u,
  )

  const afterOutbox = await pool.query(
    `SELECT count(*)::integer AS count
     FROM sync_outbox
     WHERE target_system IN ('suitecrm', 'shopify', 'faire')`,
  )
  assert.equal(afterOutbox.rows[0].count, beforeOutbox.rows[0].count)
  const zeroWrites = await pool.query(
    `SELECT
       (SELECT COALESCE(sum(provider_write_count), 0)::integer
        FROM crm_suitecrm_product_image_observations) AS observation_writes,
       (SELECT COALESCE(sum(provider_write_count), 0)::integer
        FROM crm_suitecrm_product_image_asset_provenance) AS provenance_writes`,
  )
  assert.deepEqual(zeroWrites.rows[0], {
    observation_writes: 0,
    provenance_writes: 0,
  })

  const lockOrderProduct = await addProduct(
    pool,
    tenant,
    'lock-order',
    '55555555-5555-4555-8555-555555555555',
  )
  await verifyProductImageLockOrdering(pool, tenant, lockOrderProduct)
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-suitecrm-image-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_suitecrm_image',
      '-e', 'POSTGRES_DB=clawpilot_suitecrm_image',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = `postgresql://postgres:clawpilot_suitecrm_image@127.0.0.1:${port}/clawpilot_suitecrm_image`
    await waitForPostgres(databaseUrl)

    const migrationPool = new Pool({ connectionString: databaseUrl, max: 1 })
    const migrationClient = await migrationPool.connect()
    try {
      await applyMigrations(migrationClient)
    } finally {
      migrationClient.release()
      await migrationPool.end()
    }
    runtimePool = new Pool({ connectionString: databaseUrl, max: 8 })
    await verify(runtimePool)
    await runtimePool.end()
    runtimePool = null
  } finally {
    if (runtimePool) await runtimePool.end().catch(() => {})
    runtimePool = null
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('SuiteCRM Product image reverse-ingestion PostgreSQL acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
