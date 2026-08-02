#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
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
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right))
  assert.ok(
    files.includes('0221_operations_commerce_product_image_imports.sql'),
    'commerce image import migration is missing',
  )
  assert.ok(
    files.includes(
      '0225_operations_commerce_product_image_exact_fanout.sql',
    ),
    'exact commerce image fan-out migration is missing',
  )
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

const persistenceMock = {
  acquireTransactionAdvisoryLock: (client, key) => client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
    [key],
  ),
  withTransaction: withRuntimeTransaction,
}

const auditWriterMock = {
  async recordAuditEvent(input, client) {
    const write = async (transaction) => transaction.query(
      `INSERT INTO audit_events (
         actor, event_type, aggregate_type, aggregate_id, payload, event_key,
         subject, organization_id, is_system
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $1, $7::uuid, false)
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
    if (client) await write(client)
    else await withRuntimeTransaction(write)
  },
}

const suiteCrmProductImageProjection = loadTypeScriptModule(
  'app_src/lib/persistence/suiteCrmProductImageProjection.ts',
  {
    '@/lib/auditWriter': auditWriterMock,
    '@/lib/persistence/postgres': persistenceMock,
  },
)

const productImageAssets = loadTypeScriptModule(
  'app_src/lib/crm/productImageAssets.ts',
)
const imageImports = loadTypeScriptModule(
  'app_src/lib/persistence/commerceProductImageImports.ts',
  {
    '@/lib/auditWriter': auditWriterMock,
    '@/lib/crm/productImageAssets': productImageAssets,
    '@/lib/persistence/postgres': persistenceMock,
    '@/lib/persistence/suiteCrmProductImageProjection':
      suiteCrmProductImageProjection,
  },
)
const crmImageAssets = loadTypeScriptModule(
  'app_src/lib/persistence/crmProductImageAssets.ts',
  {
    '@/lib/auditWriter': auditWriterMock,
    '@/lib/crm/productImageAssets': productImageAssets,
    '@/lib/persistence/postgres': persistenceMock,
    '@/lib/persistence/suiteCrmProductImageProjection':
      suiteCrmProductImageProjection,
  },
)

function assertImportCode(action, expectedCode) {
  return assert.rejects(action, (error) => {
    assert.equal(error?.code, expectedCode)
    return true
  })
}

async function seedTenant(pool, suffix) {
  const organizationId = randomUUID()
  const pipelineId = randomUUID()
  const actorEmail = `image-import-${suffix}@example.com`
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
       VALUES ($1::uuid, $2, $3, $3)`,
      [organizationId, `Image import ${suffix}`, actorEmail],
    )
    await client.query(
      `UPDATE app_users
       SET organization_id = $2::uuid, organization_name = $3
       WHERE email = $1`,
      [actorEmail, organizationId, `Image import ${suffix}`],
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
       ) VALUES ($1::uuid, $2, $3, true, $4::uuid)`,
      [pipelineId, `Image pipeline ${suffix}`, actorEmail, organizationId],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, reason, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'shadow', 'Image import acceptance', $3
       )`,
      [organizationId, pipelineId, actorEmail],
    )
    const account = await client.query(
      `INSERT INTO operations_integration_accounts (
         organization_id, provider, integration_type, environment,
         display_name, status, external_account_id,
         commerce_credential_generation, created_by, updated_by
       ) VALUES (
         $1::uuid, 'shopify', 'commerce', 'production', $2, 'active',
         $3, 1, $4, $4
       ) RETURNING id::text, global_id`,
      [
        organizationId,
        `Shopify image account ${suffix}`,
        `shop-${suffix}.myshopify.com`,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         webhook_verified_at, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'shopify_client_credentials',
         decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 1, 'TEST', 'verified',
         clock_timestamp(), 'verified', clock_timestamp(), $4, $4
       )`,
      [
        organizationId,
        account.rows[0].id,
        `shop-${suffix}.myshopify.com`,
        actorEmail,
      ],
    )
    await client.query('COMMIT')
    return {
      organizationId,
      pipelineId,
      actorEmail,
      accountId: account.rows[0].id,
      accountGlobalId: account.rows[0].global_id,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function addPipeline(pool, tenant, suffix) {
  const pipelineId = randomUUID()
  await pool.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1::uuid, $2, $3, false, $4::uuid)`,
    [
      pipelineId,
      `Image pipeline ${suffix}`,
      tenant.actorEmail,
      tenant.organizationId,
    ],
  )
  return { ...tenant, pipelineId }
}

async function addProduct(pool, tenant, input) {
  const product = await pool.query(
    `INSERT INTO crm_products (
       pipeline_id, source_key, name, sku, source_hash, created_by, updated_by
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $6)
     RETURNING id::text, reference_code`,
    [
      tenant.pipelineId,
      `image-product-${input.key}`,
      input.name,
      `IMG-${input.key}`.slice(0, 25),
      sha256(`product:${input.key}`),
      tenant.actorEmail,
    ],
  )
  const productId = product.rows[0].id
  const mappings = []
  for (const [index, externalVariantId] of input.variants.entries()) {
    const mappingExternalVariantId = input.mappingVariants?.[index]
      ?? externalVariantId
    const mapping = await pool.query(
      `INSERT INTO operations_product_mappings (
         organization_id, integration_account_id, pipeline_id, product_id,
         channel_sku, external_product_id, external_variant_id,
         mapping_method, mapping_source_revision, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
         'exact_variant', $8, true, $9
       ) RETURNING id::text`,
      [
        tenant.organizationId,
        tenant.accountId,
        tenant.pipelineId,
        productId,
        `SKU-${input.key}-${index}`,
        input.externalProductId,
        mappingExternalVariantId,
        `mapping-${input.key}-${index}`,
        tenant.actorEmail,
      ],
    )
    await pool.query(
      `INSERT INTO operations_product_channel_states (
         organization_id, integration_account_id, pipeline_id, provider,
         external_product_id, external_variant_id, product_id,
         product_mapping_id, provider_status_raw, normalized_status,
         provider_active, observed_at, source_revision, source_hash,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify', $4, $5, $6::uuid,
         $7::uuid, 'ACTIVE', 'active', true, clock_timestamp(), $8, $9,
         $10, $10
       )`,
      [
        tenant.organizationId,
        tenant.accountId,
        tenant.pipelineId,
        input.externalProductId,
        externalVariantId,
        productId,
        mapping.rows[0].id,
        `channel-${input.key}-${index}`,
        sha256(`channel:${input.key}:${index}`),
        tenant.actorEmail,
      ],
    )
    mappings.push(mapping.rows[0].id)
  }
  return {
    id: productId,
    referenceCode: product.rows[0].reference_code,
    mappingIds: mappings,
  }
}

const observationClockBase = Date.now() - 3_600_000
let observationClockTick = 0

function nextObservationTimestamp() {
  observationClockTick += 1
  return new Date(observationClockBase + observationClockTick * 1_000).toISOString()
}

function observationInput(tenant, values) {
  return {
    organizationId: values.organizationId ?? tenant.organizationId,
    integrationAccountId: values.integrationAccountId ?? tenant.accountId,
    provider: values.provider ?? 'shopify',
    credentialGeneration: values.credentialGeneration ?? 1,
    externalProductId: values.externalProductId,
    providerImageId: values.providerImageId,
    locatorSha256: values.locatorSha256,
    sequence: values.sequence ?? 0,
    altText: values.altText ?? 'Provider product image',
    pixelWidth: values.pixelWidth ?? null,
    pixelHeight: values.pixelHeight ?? null,
    lifecycle: values.lifecycle ?? 'active',
    sourceHash: values.sourceHash,
    observedAt: values.observedAt ?? nextObservationTimestamp(),
    actorEmail: values.actorEmail ?? tenant.actorEmail,
    maxAttempts: values.maxAttempts,
  }
}

function imageSetInput(tenant, values) {
  const observation = observationInput(tenant, values)
  const removed = observation.lifecycle === 'removed'
  return {
    organizationId: observation.organizationId,
    integrationAccountId: observation.integrationAccountId,
    provider: observation.provider,
    credentialGeneration: observation.credentialGeneration,
    externalProductId: observation.externalProductId,
    productSourceHash: values.productSourceHash
      ?? sha256(`test-product-image-set:${observation.sourceHash}:${observation.lifecycle}`),
    imageSetComplete: removed,
    observedAt: observation.observedAt,
    providerUpdatedAt: observation.providerUpdatedAt,
    actorEmail: observation.actorEmail,
    maxAttempts: observation.maxAttempts,
    images: removed ? [] : [{
      providerImageId: observation.providerImageId,
      locatorSha256: observation.locatorSha256,
      sequence: observation.sequence,
      altText: observation.altText,
      pixelWidth: observation.pixelWidth,
      pixelHeight: observation.pixelHeight,
      sourceHash: observation.sourceHash,
    }],
  }
}

async function recordObservation(tenant, values) {
  const input = imageSetInput(tenant, values)
  const result = await imageImports
    .reconcileCommerceProductImageSetInPostgres(input)
  const receipt = values.lifecycle === 'removed'
    ? result.removed[0]
    : result.active[0]
  assert.ok(receipt, 'expected image reconciliation receipt')
  return receipt
}

async function claimOne(organizationId, workerId = 'image-import-acceptance') {
  const claims = await imageImports.claimCommerceProductImageImportJobsInPostgres({
    organizationId,
    workerId,
    limit: 1,
    leaseSeconds: 30,
  })
  assert.equal(claims.length, 1, 'expected exactly one image import claim')
  return claims[0]
}

async function completeClaim(claim, bytes, mimeType, sourceEvidence = {}) {
  return imageImports.completeCommerceProductImageImportJobInPostgres({
    organizationId: claim.organizationId,
    jobId: claim.jobId,
    leaseToken: claim.leaseToken,
    actorEmail: claim.actorEmail,
    bytes,
    declaredMimeType: mimeType,
    sourceByteLength: sourceEvidence.sourceByteLength ?? bytes.byteLength,
    sourceContentSha256: sourceEvidence.sourceContentSha256 ?? sha256(bytes),
    normalizationVersion: sourceEvidence.normalizationVersion ?? 'identity-v1',
  })
}

async function verifySchemaSafety(pool) {
  const tables = [
    'operations_commerce_product_image_snapshot_fences',
    'operations_commerce_product_image_observation_sets',
    'operations_commerce_product_image_observations',
    'operations_commerce_product_image_observation_set_memberships',
    'operations_commerce_product_image_import_jobs',
    'operations_commerce_product_image_asset_provenance',
    'operations_commerce_product_image_bindings',
    'operations_commerce_product_image_import_worker_heartbeat',
  ]
  const forbidden = await pool.query(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
       AND (
         column_name ~* '(^|_)(url|uri|bytes|payload|secret|provider_write)($|_)'
         OR data_type IN ('bytea', 'json', 'jsonb')
       )`,
    [tables],
  )
  assert.deepEqual(forbidden.rows, [])

  const source = read(
    'app_src/lib/persistence/commerceProductImageImports.ts',
  )
  const migration = read(
    'db/migrations/0221_operations_commerce_product_image_imports.sql',
  )
  const fanoutMigration = read(
    'db/migrations/0225_operations_commerce_product_image_exact_fanout.sql',
  )
  assert.doesNotMatch(source, /\bfetch\s*\(/u)
  assert.doesNotMatch(source, /provider_write_count/u)
  assert.match(source, /imageSetComplete/u)
  assert.match(source, /commerce-product-image-set:/u)
  assert.match(source, /FOR UPDATE SKIP LOCKED/u)
  assert.doesNotMatch(
    source,
    /export async function recordCommerceProductImageObservationInPostgres/u,
  )
  assert.match(
    migration,
    /provenance\.activation_revision = NEW\.activation_revision/u,
  )
  assert.match(migration, /import_job\.state = 'succeeded'/u)
  assert.match(
    migration,
    /operations_commerce_product_image_job_fences_are_current\(/u,
  )
  assert.match(
    fanoutMigration,
    /operations_commerce_product_image_mapping_targets\(/u,
  )
  assert.match(
    fanoutMigration,
    /ops_commerce_image_provenance_job_product_unique/u,
  )
  assert.match(
    fanoutMigration,
    /ops_commerce_image_binding_exact_product_unique/u,
  )
  assert.match(
    source,
    /operations\.commerce_product_image_import\.fanout_completed/u,
  )
}

async function verifyImports(pool) {
  await verifySchemaSafety(pool)
  const alpha = await seedTenant(pool, 'alpha')
  const beta = await seedTenant(pool, 'beta')
  const gamma = await seedTenant(pool, 'gamma')

  const catalog = await addProduct(pool, alpha, {
    key: 'catalog',
    name: 'Catalog image product',
    externalProductId: 'gid://shopify/Product/100',
    variants: [
      'gid://shopify/ProductVariant/101',
      'gid://shopify/ProductVariant/102',
    ],
  })
  await pool.query(
    `UPDATE crm_products
     SET suitecrm_id = 'suitecrm-catalog-image-acceptance'
     WHERE pipeline_id = $1::uuid AND id = $2::uuid`,
    [alpha.pipelineId, catalog.id],
  )
  const manual = await addProduct(pool, alpha, {
    key: 'manual',
    name: 'Manual-primary product',
    externalProductId: 'gid://shopify/Product/200',
    variants: ['gid://shopify/ProductVariant/201'],
  })
  const ambiguousA = await addProduct(pool, alpha, {
    key: 'ambiguous-a',
    name: 'Ambiguous image product A',
    externalProductId: 'gid://shopify/Product/300',
    variants: ['gid://shopify/ProductVariant/301'],
  })
  const ambiguousB = await addProduct(pool, alpha, {
    key: 'ambiguous-b',
    name: 'Ambiguous image product B',
    externalProductId: 'gid://shopify/Product/300',
    variants: ['gid://shopify/ProductVariant/302'],
  })
  await pool.query(
    `UPDATE crm_products
     SET suitecrm_id = concat('suitecrm-exact-fanout-', id::text)
     WHERE pipeline_id = $1::uuid
       AND id = ANY($2::uuid[])`,
    [alpha.pipelineId, [ambiguousA.id, ambiguousB.id]],
  )
  const leaseProduct = await addProduct(pool, beta, {
    key: 'lease',
    name: 'Lease image product',
    externalProductId: 'gid://shopify/Product/900',
    variants: ['gid://shopify/ProductVariant/901'],
  })

  await assertImportCode(
    imageImports.reconcileCommerceProductImageSetInPostgres(
      imageSetInput(alpha, {
        externalProductId: 'gid://shopify/Product/100',
        providerImageId: 'https://cdn.example.test/raw.png',
        locatorSha256: sha256('raw-locator'),
        sourceHash: sha256('raw-source'),
      }),
    ),
    'COMMERCE_PRODUCT_IMAGE_RAW_LOCATOR_FORBIDDEN',
  )
  await assert.rejects(
    imageImports.reconcileCommerceProductImageSetInPostgres({
      ...imageSetInput(alpha, {
        externalProductId: 'gid://shopify/Product/100',
        providerImageId: 'image-wrong-credential',
        locatorSha256: sha256('wrong-credential-locator'),
        sourceHash: sha256('wrong-credential-source'),
      }),
      credentialGeneration: 2,
    }),
    /current verified account credential/u,
  )
  await assert.rejects(
    imageImports.reconcileCommerceProductImageSetInPostgres({
      ...imageSetInput(alpha, {
        externalProductId: 'gid://shopify/Product/100',
        providerImageId: 'cross-tenant-image',
        locatorSha256: sha256('cross-tenant-locator'),
        sourceHash: sha256('cross-tenant-source'),
      }),
      integrationAccountId: beta.accountId,
    }),
    /current verified account credential/u,
  )

  const firstInput = imageSetInput(alpha, {
    externalProductId: 'gid://shopify/Product/100',
    providerImageId: 'shopify-image-1',
    locatorSha256: sha256('locator-v1'),
    sequence: 0,
    altText: 'Catalog front',
    pixelWidth: 1,
    pixelHeight: 1,
    sourceHash: sha256('image-source-v1'),
  })
  const firstResult = await imageImports
    .reconcileCommerceProductImageSetInPostgres(firstInput)
  const first = firstResult.active[0]
  assert.ok(first)
  assert.equal(first.jobState, 'queued')
  assert.equal(first.productId, catalog.id)
  assert.match(first.observationGlobalId, /^gcio[0-9a-v]{12}$/u)
  assert.match(first.jobGlobalId, /^gcij[0-9a-v]{12}$/u)
  assert.equal(first.observationGlobalId.length, 16)
  assert.equal(first.jobGlobalId.length, 16)

  const replayResult = await imageImports
    .reconcileCommerceProductImageSetInPostgres(firstInput)
  const replay = replayResult.active[0]
  assert.ok(replay)
  assert.equal(replay.replayed, true)
  assert.equal(replay.observationId, first.observationId)
  assert.equal(replay.jobId, first.jobId)
  await assertImportCode(
    imageImports.reconcileCommerceProductImageSetInPostgres({
      ...firstInput,
      observedAt: nextObservationTimestamp(),
      productSourceHash: sha256('different-product-source-same-image-source'),
      images: [{
        ...firstInput.images[0],
        locatorSha256: sha256('different-locator-same-source'),
      }],
    }),
    'COMMERCE_PRODUCT_IMAGE_SOURCE_HASH_COLLISION',
  )

  const firstClaim = await claimOne(alpha.organizationId)
  assert.equal(firstClaim.productId, catalog.id)
  assert.equal(firstClaim.mappingCount, 2)
  assert.equal(firstClaim.accountGlobalId, alpha.accountGlobalId)
  assert.equal(firstClaim.actorEmail, alpha.actorEmail)
  assert.match(firstClaim.accountGlobalId, /^gia[0-9a-v]{12}$/u)
  await assertImportCode(
    imageImports.completeCommerceProductImageImportJobInPostgres({
      organizationId: firstClaim.organizationId,
      jobId: firstClaim.jobId,
      leaseToken: firstClaim.leaseToken,
      actorEmail: beta.actorEmail,
      bytes: ONE_PIXEL_PNG,
      declaredMimeType: 'image/png',
      sourceByteLength: ONE_PIXEL_PNG.byteLength,
      sourceContentSha256: sha256(ONE_PIXEL_PNG),
      normalizationVersion: 'identity-v1',
    }),
    'COMMERCE_PRODUCT_IMAGE_ACTOR_FENCE_MISMATCH',
  )
  const firstCompletion = await completeClaim(
    firstClaim,
    ONE_PIXEL_PNG,
    'image/png',
  )
  assert.equal(firstCompletion.reusedAsset, false)
  assert.equal(firstCompletion.isPrimary, true)
  assert.match(firstCompletion.provenanceGlobalId, /^gcip[0-9a-v]{12}$/u)
  assert.equal(firstCompletion.provenanceGlobalId.length, 16)
  const firstSuiteCrmProjection = await pool.query(
    `SELECT payload, idempotency_key, status
     FROM sync_outbox
     WHERE aggregate_type = 'crm_products'
       AND aggregate_id = $1
       AND target_system = 'suitecrm'
     ORDER BY created_at, id`,
    [catalog.id],
  )
  assert.equal(firstSuiteCrmProjection.rows.length, 1)
  assert.equal(firstSuiteCrmProjection.rows[0].status, 'queued')
  assert.equal(
    firstSuiteCrmProjection.rows[0].payload.productImage.referenceCode,
    catalog.referenceCode,
  )
  assert.equal(
    firstSuiteCrmProjection.rows[0].payload.productImage.contentSha256,
    firstCompletion.assetContentSha256,
  )
  assert.ok(firstSuiteCrmProjection.rows[0].idempotency_key.startsWith(
    `crm:products:image:v1:${catalog.id}:${firstCompletion.assetId}:1:`,
  ))
  assert.ok(firstSuiteCrmProjection.rows[0].idempotency_key.endsWith(
    `:${firstCompletion.assetContentSha256}`,
  ))
  await pool.query(
    `DELETE FROM sync_outbox
     WHERE target_system = 'suitecrm' AND idempotency_key = $1`,
    [firstSuiteCrmProjection.rows[0].idempotency_key],
  )
  const suiteCrmImageBackfill = read(
    'db/migrations/0222_suitecrm_product_image_projection_backfill.sql',
  )
  await pool.query(suiteCrmImageBackfill)
  await pool.query(suiteCrmImageBackfill)
  const backfilledSuiteCrmProjection = await pool.query(
    `SELECT payload, idempotency_key, status
     FROM sync_outbox
     WHERE aggregate_type = 'crm_products'
       AND aggregate_id = $1
       AND target_system = 'suitecrm'`,
    [catalog.id],
  )
  assert.equal(backfilledSuiteCrmProjection.rows.length, 1)
  assert.equal(backfilledSuiteCrmProjection.rows[0].status, 'queued')
  assert.deepEqual(
    backfilledSuiteCrmProjection.rows[0].payload.productImage,
    firstSuiteCrmProjection.rows[0].payload.productImage,
  )
  assert.equal(
    backfilledSuiteCrmProjection.rows[0].idempotency_key,
    firstSuiteCrmProjection.rows[0].idempotency_key,
  )
  const backfillAudit = await pool.query(
    `SELECT count(*)::integer AS count
     FROM audit_events
     WHERE event_type = 'crm.product_image.suitecrm_backfill_queued'
       AND aggregate_id = $1`,
    [catalog.id],
  )
  assert.equal(backfillAudit.rows[0].count, 1)
  const firstBinding = await pool.query(
    `SELECT
       global_id, lifecycle_state, row_version, provider_sequence,
       effective_alt_text, asset_id::text, latest_import_job_generation
     FROM operations_commerce_product_image_bindings
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_product_id = 'gid://shopify/Product/100'
       AND image_identity_sha256 = $3`,
    [alpha.organizationId, alpha.accountId, first.imageIdentitySha256],
  )
  assert.match(firstBinding.rows[0].global_id, /^gcib[0-9a-v]{12}$/u)
  assert.deepEqual({
    lifecycleState: firstBinding.rows[0].lifecycle_state,
    rowVersion: Number(firstBinding.rows[0].row_version),
    providerSequence: firstBinding.rows[0].provider_sequence,
    effectiveAltText: firstBinding.rows[0].effective_alt_text,
    assetId: firstBinding.rows[0].asset_id,
    latestImportJobGeneration:
      firstBinding.rows[0].latest_import_job_generation,
  }, {
    lifecycleState: 'active',
    rowVersion: 1,
    providerSequence: 0,
    effectiveAltText: 'Catalog front',
    assetId: firstCompletion.assetId,
    latestImportJobGeneration: 1,
  })
  const mismatchedMembershipClient = await pool.connect()
  try {
    await mismatchedMembershipClient.query('BEGIN')
    const mismatchedSet = await mismatchedMembershipClient.query(
      `INSERT INTO operations_commerce_product_image_observation_sets (
         organization_id, integration_account_id, provider,
         credential_generation, external_product_id, product_source_hash,
         image_set_complete, image_identity_count,
         image_identity_set_sha256, snapshot_sha256, observed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', 1,
         'gid://shopify/Product/100', $3, true, 1, $4, $5,
         clock_timestamp(), $6
       ) RETURNING id::text`,
      [
        alpha.organizationId,
        alpha.accountId,
        sha256('mismatched-member-product-source'),
        sha256([
          'commerce-product-image-identity-set-v1',
          sha256('a-different-declared-identity'),
        ].join('\u001f')),
        sha256('mismatched-member-snapshot'),
        alpha.actorEmail,
      ],
    )
    const firstObservationEvidence = await mismatchedMembershipClient.query(
      `SELECT
         provider, credential_generation, external_product_id,
         image_identity_sha256, observation_revision, locator_sha256,
         source_hash
       FROM operations_commerce_product_image_observations
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [alpha.organizationId, first.observationId],
    )
    const observed = firstObservationEvidence.rows[0]
    await mismatchedMembershipClient.query(
      `INSERT INTO
         operations_commerce_product_image_observation_set_memberships (
           organization_id, integration_account_id, provider,
           credential_generation, external_product_id, observation_set_id,
           image_identity_sha256, observation_id, observation_revision,
           locator_sha256, observation_source_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8::uuid,
           $9, $10, $11
         )`,
      [
        alpha.organizationId,
        alpha.accountId,
        observed.provider,
        observed.credential_generation,
        observed.external_product_id,
        mismatchedSet.rows[0].id,
        observed.image_identity_sha256,
        first.observationId,
        observed.observation_revision,
        observed.locator_sha256,
        observed.source_hash,
      ],
    )
    await assert.rejects(
      mismatchedMembershipClient.query('COMMIT'),
      /membership hash does not match immutable evidence/u,
    )
  } finally {
    await mismatchedMembershipClient.query('ROLLBACK').catch(() => {})
    mismatchedMembershipClient.release()
  }
  const completionReplay = await completeClaim(
    firstClaim,
    ONE_PIXEL_PNG,
    'image/png',
  )
  assert.equal(completionReplay.replayed, true)
  assert.equal(completionReplay.assetId, firstCompletion.assetId)

  const sameBytes = await recordObservation(alpha, {
      externalProductId: 'gid://shopify/Product/100',
      providerImageId: 'shopify-image-1',
      locatorSha256: sha256('locator-v2'),
      sequence: 0,
      altText: 'Catalog front refresh',
      pixelWidth: 1,
      pixelHeight: 1,
      sourceHash: sha256('image-source-v2'),
    })
  assert.equal(sameBytes.observationRevision, 2)
  const sameBytesCompletion = await completeClaim(
    await claimOne(alpha.organizationId),
    ONE_PIXEL_PNG,
    'image/png',
  )
  assert.equal(sameBytesCompletion.reusedAsset, true)
  assert.equal(sameBytesCompletion.assetId, firstCompletion.assetId)
  const catalogAfterAltRefresh = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: alpha.organizationId,
      productId: catalog.id,
    })
  assert.equal(catalogAfterAltRefresh.assets.length, 1)
  assert.equal(catalogAfterAltRefresh.assets[0].altText, 'Catalog front refresh')
  assert.equal(catalogAfterAltRefresh.assets[0].providerSequence, 0)
  assert.match(
    catalogAfterAltRefresh.assets[0].providerBindingGlobalId,
    /^gcib[0-9a-v]{12}$/u,
  )

  const changedBytes = await recordObservation(alpha, {
      externalProductId: 'gid://shopify/Product/100',
      providerImageId: 'shopify-image-1',
      locatorSha256: sha256('locator-v3'),
      sequence: 0,
      altText: 'Catalog front JPEG',
      sourceHash: sha256('image-source-v3'),
    })
  assert.equal(changedBytes.observationRevision, 3)
  const normalizedSourceHash = sha256('oversized-provider-source-v1')
  const changedCompletion = await completeClaim(
    await claimOne(alpha.organizationId),
    FOUR_BY_FIVE_WEBP,
    'image/webp',
    {
      sourceByteLength: (2 * 1024 * 1024) + 1,
      sourceContentSha256: normalizedSourceHash,
      normalizationVersion: 'sharp-0.35.3-webp-auto-orient-v1-q82',
    },
  )
  assert.equal(changedCompletion.reusedAsset, false)
  assert.equal(changedCompletion.assetRevision, 2)
  assert.equal(changedCompletion.isPrimary, true)
  const normalizedProvenance = await pool.query(
    `SELECT
       source_byte_length,
       source_content_sha256,
       normalization_version,
       asset_content_sha256
     FROM operations_commerce_product_image_asset_provenance
     WHERE id = $1::uuid`,
    [changedCompletion.provenanceId],
  )
  assert.deepEqual(normalizedProvenance.rows[0], {
    source_byte_length: (2 * 1024 * 1024) + 1,
    source_content_sha256: normalizedSourceHash,
    normalization_version: 'sharp-0.35.3-webp-auto-orient-v1-q82',
    asset_content_sha256: sha256(FOUR_BY_FIVE_WEBP),
  })
  const setProjectionCount = await pool.query(
    `SELECT count(*)::integer AS count
     FROM sync_outbox
     WHERE aggregate_type = 'crm_products'
       AND aggregate_id = $1
       AND target_system = 'suitecrm'
       AND payload->'productImage' IS NOT NULL`,
    [catalog.id],
  )
  assert.equal(setProjectionCount.rows[0].count, 2)
  const catalogAfterByteChange = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: alpha.organizationId,
      productId: catalog.id,
    })
  assert.deepEqual(
    catalogAfterByteChange.assets.map((asset) => ({
      id: asset.id,
      altText: asset.altText,
      primary: asset.isPrimary,
    })),
    [{
      id: changedCompletion.assetId,
      altText: 'Catalog front JPEG',
      primary: true,
    }],
    'immutable superseded bytes remain stored but are hidden without an active binding',
  )

  const provenanceCounts = await pool.query(
    `SELECT
       count(*)::integer AS provenance_count,
       count(DISTINCT asset_id)::integer AS asset_count
     FROM operations_commerce_product_image_asset_provenance
     WHERE organization_id = $1::uuid AND product_id = $2::uuid`,
    [alpha.organizationId, catalog.id],
  )
  assert.deepEqual(provenanceCounts.rows[0], {
    provenance_count: 3,
    asset_count: 2,
  })

  const manualImage = productImageAssets.validateCrmProductImage({
    bytes: ONE_PIXEL_PNG,
    declaredMimeType: 'image/png',
    altText: 'Operator-selected primary',
  })
  const manualAsset = await pool.query(
    `INSERT INTO crm_product_image_assets (
       organization_id, pipeline_id, product_id, asset_revision,
       content_bytes, mime_type, content_sha256, byte_length,
       pixel_width, pixel_height, alt_text, source, is_primary,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 1, $4::bytea, $5, $6, $7,
       $8, $9, $10, 'manual_upload', true, $11, $11
     ) RETURNING id::text`,
    [
      alpha.organizationId,
      alpha.pipelineId,
      manual.id,
      Buffer.from(manualImage.bytes),
      manualImage.mimeType,
      manualImage.contentSha256,
      manualImage.byteLength,
      manualImage.pixelWidth,
      manualImage.pixelHeight,
      manualImage.altText,
      alpha.actorEmail,
    ],
  )
  await recordObservation(alpha, {
      externalProductId: 'gid://shopify/Product/200',
      providerImageId: 'manual-product-identical-provider-image',
      locatorSha256: sha256('manual-product-identical-locator'),
      sourceHash: sha256('manual-product-identical-source'),
    })
  const manualDedupe = await completeClaim(
    await claimOne(alpha.organizationId),
    ONE_PIXEL_PNG,
    'image/png',
  )
  assert.equal(manualDedupe.reusedAsset, true)
  assert.equal(manualDedupe.assetId, manualAsset.rows[0].id)
  assert.equal(manualDedupe.isPrimary, true)
  await recordObservation(alpha, {
      externalProductId: 'gid://shopify/Product/200',
      providerImageId: 'manual-product-provider-image',
      locatorSha256: sha256('manual-product-locator'),
      sourceHash: sha256('manual-product-source'),
    })
  const manualCompletion = await completeClaim(
    await claimOne(alpha.organizationId),
    FOUR_BY_FIVE_WEBP,
    'image/webp',
  )
  assert.equal(manualCompletion.isPrimary, false)
  const primaryAfterImport = await pool.query(
    `SELECT id::text, source
     FROM crm_product_image_assets
     WHERE organization_id = $1::uuid
       AND product_id = $2::uuid
       AND is_primary`,
    [alpha.organizationId, manual.id],
  )
  assert.deepEqual(primaryAfterImport.rows, [{
    id: manualAsset.rows[0].id,
    source: 'manual_upload',
  }])
  const removedManualProviderBindings = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      organizationId: alpha.organizationId,
      integrationAccountId: alpha.accountId,
      provider: 'shopify',
      credentialGeneration: 1,
      externalProductId: 'gid://shopify/Product/200',
      productSourceHash: sha256('manual-primary-provider-images-removed'),
      imageSetComplete: true,
      observedAt: nextObservationTimestamp(),
      actorEmail: alpha.actorEmail,
      images: [],
    })
  assert.equal(removedManualProviderBindings.removed.length, 2)
  const manualPrimaryAfterProviderRemoval = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: alpha.organizationId,
      productId: manual.id,
    })
  assert.equal(manualPrimaryAfterProviderRemoval.assets.length, 1)
  assert.equal(
    manualPrimaryAfterProviderRemoval.assets[0].id,
    manualAsset.rows[0].id,
  )
  assert.equal(manualPrimaryAfterProviderRemoval.assets[0].isPrimary, true)

  const suiteCrmPrecedenceProduct = await addProduct(pool, alpha, {
    key: 'suitecrm-primary-precedence',
    name: 'SuiteCRM primary precedence',
    externalProductId: 'gid://shopify/Product/210',
    variants: ['gid://shopify/ProductVariant/211'],
  })
  const suiteCrmPrimaryImage = productImageAssets.validateCrmProductImage({
    bytes: ONE_PIXEL_PNG,
    declaredMimeType: 'image/png',
    altText: 'SuiteCRM-origin primary',
  })
  const suiteCrmPrimary = await pool.query(
    `INSERT INTO crm_product_image_assets (
       organization_id, pipeline_id, product_id, asset_revision,
       content_bytes, mime_type, content_sha256, byte_length,
       pixel_width, pixel_height, alt_text, source, is_primary,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 1, $4::bytea, $5, $6, $7,
       $8, $9, $10, 'suitecrm_import', true, $11, $11
     ) RETURNING id::text`,
    [
      alpha.organizationId,
      alpha.pipelineId,
      suiteCrmPrecedenceProduct.id,
      Buffer.from(suiteCrmPrimaryImage.bytes),
      suiteCrmPrimaryImage.mimeType,
      suiteCrmPrimaryImage.contentSha256,
      suiteCrmPrimaryImage.byteLength,
      suiteCrmPrimaryImage.pixelWidth,
      suiteCrmPrimaryImage.pixelHeight,
      suiteCrmPrimaryImage.altText,
      alpha.actorEmail,
    ],
  )
  await recordObservation(alpha, {
    externalProductId: 'gid://shopify/Product/210',
    providerImageId: 'provider-supersedes-suitecrm-primary',
    locatorSha256: sha256('provider-supersedes-suitecrm-primary-locator'),
    sourceHash: sha256('provider-supersedes-suitecrm-primary-source'),
  })
  const providerAfterSuiteCrm = await completeClaim(
    await claimOne(alpha.organizationId),
    FOUR_BY_FIVE_WEBP,
    'image/webp',
  )
  assert.equal(providerAfterSuiteCrm.isPrimary, true)
  const providerPrecedence = await pool.query(
    `SELECT id::text, source, is_primary
     FROM crm_product_image_assets
     WHERE organization_id = $1::uuid AND product_id = $2::uuid
     ORDER BY asset_revision`,
    [alpha.organizationId, suiteCrmPrecedenceProduct.id],
  )
  assert.deepEqual(providerPrecedence.rows, [
    {
      id: suiteCrmPrimary.rows[0].id,
      source: 'suitecrm_import',
      is_primary: false,
    },
    {
      id: providerAfterSuiteCrm.assetId,
      source: 'provider_import',
      is_primary: true,
    },
  ])

  const suiteCrmDedupeProduct = await addProduct(pool, alpha, {
    key: 'suitecrm-provider-dedupe',
    name: 'SuiteCRM provider dedupe',
    externalProductId: 'gid://shopify/Product/220',
    variants: ['gid://shopify/ProductVariant/221'],
  })
  const suiteCrmDedupeAsset = await pool.query(
    `INSERT INTO crm_product_image_assets (
       organization_id, pipeline_id, product_id, asset_revision,
       content_bytes, mime_type, content_sha256, byte_length,
       pixel_width, pixel_height, alt_text, source, is_primary,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 1, $4::bytea, $5, $6, $7,
       $8, $9, $10, 'suitecrm_import', true, $11, $11
     ) RETURNING id::text`,
    [
      alpha.organizationId,
      alpha.pipelineId,
      suiteCrmDedupeProduct.id,
      Buffer.from(suiteCrmPrimaryImage.bytes),
      suiteCrmPrimaryImage.mimeType,
      suiteCrmPrimaryImage.contentSha256,
      suiteCrmPrimaryImage.byteLength,
      suiteCrmPrimaryImage.pixelWidth,
      suiteCrmPrimaryImage.pixelHeight,
      'SuiteCRM same-content primary',
      alpha.actorEmail,
    ],
  )
  await recordObservation(alpha, {
    externalProductId: 'gid://shopify/Product/220',
    providerImageId: 'provider-matches-suitecrm-primary',
    locatorSha256: sha256('provider-matches-suitecrm-primary-locator'),
    sourceHash: sha256('provider-matches-suitecrm-primary-source'),
  })
  const providerSuiteCrmDedupe = await completeClaim(
    await claimOne(alpha.organizationId),
    ONE_PIXEL_PNG,
    'image/png',
  )
  assert.equal(providerSuiteCrmDedupe.reusedAsset, true)
  assert.equal(providerSuiteCrmDedupe.assetId, suiteCrmDedupeAsset.rows[0].id)
  assert.equal(providerSuiteCrmDedupe.isPrimary, true)
  const crossSourceBinding = await pool.query(
    `SELECT binding.asset_id::text, asset.source, asset.is_primary
     FROM operations_commerce_product_image_bindings binding
     JOIN crm_product_image_assets asset
       ON asset.organization_id = binding.organization_id
      AND asset.pipeline_id = binding.pipeline_id
      AND asset.product_id = binding.product_id
      AND asset.id = binding.asset_id
     WHERE binding.organization_id = $1::uuid
       AND binding.product_id = $2::uuid
       AND binding.lifecycle_state = 'active'`,
    [alpha.organizationId, suiteCrmDedupeProduct.id],
  )
  assert.deepEqual(crossSourceBinding.rows, [{
    asset_id: suiteCrmDedupeAsset.rows[0].id,
    source: 'suitecrm_import',
    is_primary: true,
  }])
  const removedCrossSourceBinding = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      organizationId: alpha.organizationId,
      integrationAccountId: alpha.accountId,
      provider: 'shopify',
      credentialGeneration: 1,
      externalProductId: 'gid://shopify/Product/220',
      productSourceHash: sha256('provider-matches-suitecrm-primary-removed'),
      imageSetComplete: true,
      observedAt: nextObservationTimestamp(),
      actorEmail: alpha.actorEmail,
      images: [],
    })
  assert.equal(removedCrossSourceBinding.removed.length, 1)
  const suiteCrmPrimaryAfterProviderRemoval = await pool.query(
    `SELECT id::text, source, is_primary
     FROM crm_product_image_assets
     WHERE organization_id = $1::uuid
       AND product_id = $2::uuid
       AND is_primary = true`,
    [alpha.organizationId, suiteCrmDedupeProduct.id],
  )
  assert.deepEqual(suiteCrmPrimaryAfterProviderRemoval.rows, [{
    id: suiteCrmDedupeAsset.rows[0].id,
    source: 'suitecrm_import',
    is_primary: true,
  }])

  const ordered = await addProduct(pool, alpha, {
    key: 'provider-ordering',
    name: 'Provider ordering product',
    externalProductId: 'gid://shopify/Product/250',
    variants: ['gid://shopify/ProductVariant/251'],
  })
  const orderedBase = {
    organizationId: alpha.organizationId,
    integrationAccountId: alpha.accountId,
    provider: 'shopify',
    credentialGeneration: 1,
    externalProductId: 'gid://shopify/Product/250',
    imageSetComplete: true,
    actorEmail: alpha.actorEmail,
  }
  const orderedClock = Date.now() - 300_000
  const orderedImageA = {
    providerImageId: 'ordered-image-a',
    locatorSha256: sha256('ordered-locator-a-v1'),
    sequence: 0,
    altText: 'Ordered image A v1',
    sourceHash: sha256('ordered-source-a-v1'),
  }
  const orderedImageB = {
    providerImageId: 'ordered-image-b',
    locatorSha256: sha256('ordered-locator-b-v1'),
    sequence: 1,
    altText: 'Ordered image B v1',
    sourceHash: sha256('ordered-source-b-v1'),
  }
  await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...orderedBase,
    productSourceHash: sha256('ordered-product-v1'),
    observedAt: new Date(orderedClock).toISOString(),
    images: [orderedImageA, orderedImageB],
  })
  const reversedClaims = await imageImports
    .claimCommerceProductImageImportJobsInPostgres({
      organizationId: alpha.organizationId,
      workerId: 'reverse-completion-worker',
      limit: 2,
      leaseSeconds: 60,
    })
  assert.equal(reversedClaims.length, 2)
  const orderedClaimA = reversedClaims.find((claim) => claim.sequence === 0)
  const orderedClaimB = reversedClaims.find((claim) => claim.sequence === 1)
  assert.ok(orderedClaimA && orderedClaimB)
  const orderedCompletionB = await completeClaim(
    orderedClaimB,
    FOUR_BY_FIVE_WEBP,
    'image/webp',
  )
  assert.equal(orderedCompletionB.isPrimary, true)
  const orderedCompletionA = await completeClaim(
    orderedClaimA,
    ONE_PIXEL_PNG,
    'image/png',
  )
  assert.equal(orderedCompletionA.isPrimary, true)
  let orderedState = await crmImageAssets.listCrmProductImageAssetsInPostgres({
    organizationId: alpha.organizationId,
    productId: ordered.id,
  })
  assert.deepEqual(
    orderedState.assets.map((asset) => ({
      id: asset.id,
      sequence: asset.providerSequence,
      primary: asset.isPrimary,
    })),
    [
      { id: orderedCompletionA.assetId, sequence: 0, primary: true },
      { id: orderedCompletionB.assetId, sequence: 1, primary: false },
    ],
    'provider primary must be independent of reverse completion order',
  )
  const reorderedImageA = {
    ...orderedImageA,
    locatorSha256: sha256('ordered-locator-a-v2'),
    sequence: 1,
    altText: 'Ordered image A moved second',
    sourceHash: sha256('ordered-source-a-v2'),
  }
  const reorderedImageB = {
    ...orderedImageB,
    locatorSha256: sha256('ordered-locator-b-v2'),
    sequence: 0,
    altText: 'Ordered image B moved first',
    sourceHash: sha256('ordered-source-b-v2'),
  }
  await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...orderedBase,
    productSourceHash: sha256('ordered-product-v2'),
    observedAt: new Date(orderedClock + 10_000).toISOString(),
    images: [reorderedImageA, reorderedImageB],
  })
  const reorderedClaims = await imageImports
    .claimCommerceProductImageImportJobsInPostgres({
      organizationId: alpha.organizationId,
      workerId: 'metadata-refresh-worker',
      limit: 2,
      leaseSeconds: 60,
    })
  assert.equal(reorderedClaims.length, 2)
  for (const claim of reorderedClaims) {
    await completeClaim(
      claim,
      claim.providerImageId === 'ordered-image-a'
        ? ONE_PIXEL_PNG
        : FOUR_BY_FIVE_WEBP,
      claim.providerImageId === 'ordered-image-a'
        ? 'image/png'
        : 'image/webp',
    )
  }
  orderedState = await crmImageAssets.listCrmProductImageAssetsInPostgres({
    organizationId: alpha.organizationId,
    productId: ordered.id,
  })
  assert.deepEqual(
    orderedState.assets.map((asset) => ({
      id: asset.id,
      sequence: asset.providerSequence,
      altText: asset.altText,
      primary: asset.isPrimary,
    })),
    [
      {
        id: orderedCompletionB.assetId,
        sequence: 0,
        altText: 'Ordered image B moved first',
        primary: true,
      },
      {
        id: orderedCompletionA.assetId,
        sequence: 1,
        altText: 'Ordered image A moved second',
        primary: false,
      },
    ],
    'alt-only/order changes must project without mutating immutable asset bytes',
  )
  const orderedAIdentity = imageImports
    .commerceProductImageIdentitySha256(reorderedImageA)
  const orderedBIdentity = imageImports
    .commerceProductImageIdentitySha256(reorderedImageB)
  await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...orderedBase,
    productSourceHash: sha256('ordered-product-remove-b'),
    observedAt: new Date(orderedClock + 20_000).toISOString(),
    images: [reorderedImageA],
  })
  orderedState = await crmImageAssets.listCrmProductImageAssetsInPostgres({
    organizationId: alpha.organizationId,
    productId: ordered.id,
  })
  assert.deepEqual(
    orderedState.assets.map((asset) => ({
      id: asset.id,
      primary: asset.isPrimary,
    })),
    [{ id: orderedCompletionA.assetId, primary: true }],
  )
  const inactiveOrderedB = await pool.query(
    `SELECT lifecycle_state
     FROM operations_commerce_product_image_bindings
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_product_id = 'gid://shopify/Product/250'
       AND image_identity_sha256 = $3`,
    [alpha.organizationId, alpha.accountId, orderedBIdentity],
  )
  assert.equal(inactiveOrderedB.rows[0].lifecycle_state, 'inactive')
  await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...orderedBase,
    productSourceHash: sha256('ordered-product-reactivate-b'),
    observedAt: new Date(orderedClock + 30_000).toISOString(),
    images: [reorderedImageA, reorderedImageB],
  })
  const reactivationClaim = await claimOne(alpha.organizationId)
  assert.equal(reactivationClaim.providerImageId, 'ordered-image-b')
  const reactivatedOrderedB = await completeClaim(
    reactivationClaim,
    FOUR_BY_FIVE_WEBP,
    'image/webp',
  )
  assert.equal(reactivatedOrderedB.isPrimary, true)
  const rollbackRemovalClient = await pool.connect()
  try {
    await rollbackRemovalClient.query('BEGIN')
    await imageImports.reconcileCommerceProductImageSetWithClient({
      ...orderedBase,
      productSourceHash: sha256('ordered-removal-outer-rollback'),
      observedAt: new Date(orderedClock + 40_000).toISOString(),
      images: [reorderedImageA],
    }, rollbackRemovalClient)
    const insideRollback = await rollbackRemovalClient.query(
      `SELECT lifecycle_state
       FROM operations_commerce_product_image_bindings
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_product_id = 'gid://shopify/Product/250'
         AND image_identity_sha256 = $3`,
      [alpha.organizationId, alpha.accountId, orderedBIdentity],
    )
    assert.equal(insideRollback.rows[0].lifecycle_state, 'inactive')
    await rollbackRemovalClient.query('ROLLBACK')
  } catch (error) {
    await rollbackRemovalClient.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    rollbackRemovalClient.release()
  }
  const afterRollbackBinding = await pool.query(
    `SELECT image_identity_sha256, lifecycle_state
     FROM operations_commerce_product_image_bindings
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_product_id = 'gid://shopify/Product/250'
       AND image_identity_sha256 = ANY($3::text[])
     ORDER BY image_identity_sha256`,
    [
      alpha.organizationId,
      alpha.accountId,
      [orderedAIdentity, orderedBIdentity],
    ],
  )
  assert.ok(afterRollbackBinding.rows.every((row) => (
    row.lifecycle_state === 'active'
  )))

  const dedupeProduct = await addProduct(pool, alpha, {
    key: 'same-bytes-identities',
    name: 'Same bytes identity product',
    externalProductId: 'gid://shopify/Product/275',
    variants: ['gid://shopify/ProductVariant/276'],
  })
  const dedupeBase = {
    organizationId: alpha.organizationId,
    integrationAccountId: alpha.accountId,
    provider: 'shopify',
    credentialGeneration: 1,
    externalProductId: 'gid://shopify/Product/275',
    imageSetComplete: true,
    actorEmail: alpha.actorEmail,
  }
  const dedupeImages = [
    {
      providerImageId: 'same-bytes-a',
      locatorSha256: sha256('same-bytes-locator-a'),
      sequence: 0,
      altText: 'Same bytes A',
      sourceHash: sha256('same-bytes-source-a'),
    },
    {
      providerImageId: 'same-bytes-b',
      locatorSha256: sha256('same-bytes-locator-b'),
      sequence: 1,
      altText: 'Same bytes B',
      sourceHash: sha256('same-bytes-source-b'),
    },
  ]
  await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...dedupeBase,
    productSourceHash: sha256('same-bytes-product-v1'),
    observedAt: new Date(orderedClock).toISOString(),
    images: dedupeImages,
  })
  const dedupeClaims = await imageImports
    .claimCommerceProductImageImportJobsInPostgres({
      organizationId: alpha.organizationId,
      workerId: 'same-bytes-worker',
      limit: 2,
      leaseSeconds: 60,
    })
  assert.equal(dedupeClaims.length, 2)
  const dedupeCompletions = []
  for (const claim of dedupeClaims) {
    dedupeCompletions.push(await completeClaim(claim, ONE_PIXEL_PNG, 'image/png'))
  }
  assert.equal(new Set(dedupeCompletions.map((result) => result.assetId)).size, 1)
  const dedupeBindings = await pool.query(
    `SELECT count(*)::integer AS count,
            count(DISTINCT asset_id)::integer AS assets
     FROM operations_commerce_product_image_bindings
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_product_id = 'gid://shopify/Product/275'
       AND lifecycle_state = 'active'`,
    [alpha.organizationId, alpha.accountId],
  )
  assert.deepEqual(dedupeBindings.rows[0], { count: 2, assets: 1 })
  await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...dedupeBase,
    productSourceHash: sha256('same-bytes-product-remove-a'),
    observedAt: new Date(orderedClock + 10_000).toISOString(),
    images: [dedupeImages[1]],
  })
  let dedupeState = await crmImageAssets.listCrmProductImageAssetsInPostgres({
    organizationId: alpha.organizationId,
    productId: dedupeProduct.id,
  })
  assert.equal(dedupeState.assets.length, 1)
  assert.equal(dedupeState.assets[0].altText, 'Same bytes B')
  await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...dedupeBase,
    productSourceHash: sha256('same-bytes-product-empty'),
    observedAt: new Date(orderedClock + 20_000).toISOString(),
    images: [],
  })
  dedupeState = await crmImageAssets.listCrmProductImageAssetsInPostgres({
    organizationId: alpha.organizationId,
    productId: dedupeProduct.id,
  })
  assert.equal(dedupeState.assets.length, 0)

  const replayCycleProduct = await addProduct(pool, alpha, {
    key: 'identical-reactivation',
    name: 'Identical reactivation product',
    externalProductId: 'gid://shopify/Product/280',
    variants: ['gid://shopify/ProductVariant/281'],
  })
  const replayCycleClock = Date.now() - 240_000
  const replayCycleImage = {
    providerImageId: 'identical-reactivation-image',
    locatorSha256: sha256('identical-reactivation-locator'),
    sequence: 0,
    altText: 'Identical reactivation image',
    sourceHash: sha256('identical-reactivation-source'),
  }
  const replayCycleBase = {
    organizationId: alpha.organizationId,
    integrationAccountId: alpha.accountId,
    provider: 'shopify',
    credentialGeneration: 1,
    externalProductId: 'gid://shopify/Product/280',
    productSourceHash: sha256('identical-reactivation-product-source'),
    imageSetComplete: true,
    actorEmail: alpha.actorEmail,
    images: [replayCycleImage],
  }
  const replayCycleInitial = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      ...replayCycleBase,
      observedAt: new Date(replayCycleClock).toISOString(),
    })
  assert.equal(replayCycleInitial.active[0].observationRevision, 1)
  const replayCycleInitialCompletion = await completeClaim(
    await claimOne(alpha.organizationId, 'identical-reactivation-worker-one'),
    ONE_PIXEL_PNG,
    'image/png',
  )
  await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...replayCycleBase,
    productSourceHash: sha256('identical-reactivation-removed'),
    observedAt: new Date(replayCycleClock + 10_000).toISOString(),
    images: [],
  })
  const replayCycleReactivated = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      ...replayCycleBase,
      observedAt: new Date(replayCycleClock + 20_000).toISOString(),
    })
  assert.equal(replayCycleReactivated.active[0].observationRevision, 3)
  const replayCycleReactivationCompletion = await completeClaim(
    await claimOne(alpha.organizationId, 'identical-reactivation-worker-two'),
    ONE_PIXEL_PNG,
    'image/png',
  )
  assert.equal(replayCycleReactivationCompletion.reusedAsset, true)
  assert.equal(
    replayCycleReactivationCompletion.assetId,
    replayCycleInitialCompletion.assetId,
  )
  const replayCycleEvidence = await pool.query(
    `SELECT
       observation_set.id::text AS observation_set_id,
       membership.observation_revision::integer
     FROM operations_commerce_product_image_observation_sets observation_set
     JOIN operations_commerce_product_image_observation_set_memberships
       membership
       ON membership.organization_id = observation_set.organization_id
      AND membership.integration_account_id =
            observation_set.integration_account_id
      AND membership.observation_set_id = observation_set.id
     WHERE observation_set.organization_id = $1::uuid
       AND observation_set.external_product_id =
             'gid://shopify/Product/280'
       AND observation_set.product_source_hash = $2
     ORDER BY observation_set.observed_at`,
    [
      alpha.organizationId,
      replayCycleBase.productSourceHash,
    ],
  )
  assert.equal(replayCycleEvidence.rows.length, 2)
  assert.equal(
    new Set(replayCycleEvidence.rows.map((row) => row.observation_set_id)).size,
    2,
  )
  assert.deepEqual(
    replayCycleEvidence.rows.map((row) => row.observation_revision),
    [1, 3],
    'a later identical reactivation must bind its own snapshot to new evidence',
  )
  const replayCycleProjection = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: alpha.organizationId,
      productId: replayCycleProduct.id,
    })
  assert.equal(replayCycleProjection.assets.length, 1)

  const samePipelineOldProduct = await addProduct(pool, alpha, {
    key: 'same-pipeline-remap-old',
    name: 'Same pipeline remap old product',
    externalProductId: 'gid://shopify/Product/290',
    variants: ['gid://shopify/ProductVariant/291'],
  })
  const samePipelineInput = imageSetInput(alpha, {
    externalProductId: 'gid://shopify/Product/290',
    providerImageId: 'same-pipeline-remap-image',
    locatorSha256: sha256('same-pipeline-remap-locator'),
    altText: 'Same pipeline remap image',
    sourceHash: sha256('same-pipeline-remap-source'),
  })
  const samePipelineInitial = await imageImports
    .reconcileCommerceProductImageSetInPostgres(samePipelineInput)
  const samePipelineInitialReceipt = samePipelineInitial.active[0]
  const samePipelineInitialCompletion = await completeClaim(
    await claimOne(alpha.organizationId, 'same-pipeline-remap-worker-one'),
    ONE_PIXEL_PNG,
    'image/png',
  )
  const readableProviderAsset = await crmImageAssets
    .readCrmProductImageAssetBytesInPostgres({
      organizationId: alpha.organizationId,
      productId: samePipelineOldProduct.id,
      assetId: samePipelineInitialCompletion.assetId,
    })
  assert.equal(
    readableProviderAsset.contentSha256,
    samePipelineInitialCompletion.assetContentSha256,
  )
  await pool.query(
    `UPDATE operations_product_mappings
     SET active = false, updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [alpha.organizationId, samePipelineOldProduct.mappingIds[0]],
  )
  const samePipelineNewProduct = await addProduct(pool, alpha, {
    key: 'same-pipeline-remap-new',
    name: 'Same pipeline remap new product',
    externalProductId: 'gid://shopify/Product/290',
    variants: ['gid://shopify/ProductVariant/292'],
  })
  const staleMappingProjection = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: alpha.organizationId,
      productId: samePipelineOldProduct.id,
    })
  assert.equal(staleMappingProjection.assets.length, 0)
  await assertImportCode(
    crmImageAssets.readCrmProductImageAssetBytesInPostgres({
      organizationId: alpha.organizationId,
      productId: samePipelineOldProduct.id,
      assetId: samePipelineInitialCompletion.assetId,
    }),
    'CRM_PRODUCT_IMAGE_ASSET_NOT_FOUND',
  )
  await assertImportCode(
    crmImageAssets.setPrimaryCrmProductImageAssetInPostgres({
      organizationId: alpha.organizationId,
      productId: samePipelineOldProduct.id,
      assetId: samePipelineInitialCompletion.assetId,
      expectedRowVersion: 1,
      actorEmail: alpha.actorEmail,
    }),
    'CRM_PRODUCT_IMAGE_ASSET_NOT_FOUND',
  )
  const oldProductManualState = await crmImageAssets
    .uploadCrmProductImageAssetInPostgres({
      organizationId: alpha.organizationId,
      productId: samePipelineOldProduct.id,
      actorEmail: alpha.actorEmail,
      bytes: FOUR_BY_FIVE_WEBP,
      declaredMimeType: 'image/webp',
      altText: 'Manual image after provider remap',
      setPrimary: false,
    })
  assert.equal(oldProductManualState.assets.length, 1)
  assert.equal(oldProductManualState.assets[0].source, 'manual_upload')
  assert.equal(oldProductManualState.assets[0].isPrimary, true)

  const samePipelineRemapped = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      ...samePipelineInput,
      productSourceHash: sha256('same-pipeline-remapped-product-source'),
      observedAt: nextObservationTimestamp(),
    })
  const samePipelineRemappedReceipt = samePipelineRemapped.active[0]
  assert.equal(samePipelineRemappedReceipt.replayed, true)
  assert.notEqual(
    samePipelineRemappedReceipt.jobId,
    samePipelineInitialReceipt.jobId,
  )
  assert.equal(samePipelineRemappedReceipt.productId, samePipelineNewProduct.id)
  const samePipelineRemappedCompletion = await completeClaim(
    await claimOne(alpha.organizationId, 'same-pipeline-remap-worker-two'),
    ONE_PIXEL_PNG,
    'image/png',
  )
  const samePipelineNewProjection = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: alpha.organizationId,
      productId: samePipelineNewProduct.id,
    })
  assert.equal(samePipelineNewProjection.assets.length, 1)
  assert.equal(
    samePipelineNewProjection.assets[0].id,
    samePipelineRemappedCompletion.assetId,
  )

  const tombstone = await recordObservation(alpha, {
      externalProductId: 'gid://shopify/Product/100',
      providerImageId: 'shopify-image-1',
      locatorSha256: sha256('locator-v3'),
      sequence: 0,
      altText: 'Catalog front JPEG',
      lifecycle: 'removed',
      sourceHash: sha256('image-source-removed'),
    })
  assert.equal(tombstone.jobState, 'cancelled')
  assert.equal(tombstone.observationRevision, 4)
  const removedBinding = await pool.query(
    `SELECT binding.lifecycle_state, binding.row_version,
            binding.asset_id::text, asset.is_primary
     FROM operations_commerce_product_image_bindings binding
     JOIN crm_product_image_assets asset
       ON asset.organization_id = binding.organization_id
      AND asset.id = binding.asset_id
     WHERE binding.organization_id = $1::uuid
       AND binding.integration_account_id = $2::uuid
       AND binding.external_product_id = 'gid://shopify/Product/100'
       AND binding.image_identity_sha256 = $3`,
    [alpha.organizationId, alpha.accountId, first.imageIdentitySha256],
  )
  assert.deepEqual({
    lifecycleState: removedBinding.rows[0].lifecycle_state,
    rowVersion: Number(removedBinding.rows[0].row_version),
    assetId: removedBinding.rows[0].asset_id,
    isPrimary: removedBinding.rows[0].is_primary,
  }, {
    lifecycleState: 'inactive',
    rowVersion: 4,
    assetId: changedCompletion.assetId,
    isPrimary: false,
  })
  const hiddenAfterRemoval = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: alpha.organizationId,
      productId: catalog.id,
    })
  assert.equal(hiddenAfterRemoval.assets.length, 0)
  const clearProjection = await pool.query(
    `SELECT payload, idempotency_key, status
     FROM sync_outbox
     WHERE aggregate_type = 'crm_products'
       AND aggregate_id = $1
       AND target_system = 'suitecrm'
       AND payload->'productImage' = 'null'::jsonb
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [catalog.id],
  )
  assert.equal(clearProjection.rows.length, 1)
  assert.equal(clearProjection.rows[0].status, 'queued')
  assert.equal(clearProjection.rows[0].payload.productImage, null)
  assert.ok(clearProjection.rows[0].idempotency_key.endsWith(':none'))
  await assertImportCode(
    crmImageAssets.readCrmProductImageAssetBytesInPostgres({
      organizationId: alpha.organizationId,
      productId: catalog.id,
      assetId: changedCompletion.assetId,
    }),
    'CRM_PRODUCT_IMAGE_ASSET_NOT_FOUND',
  )
  const retained = await pool.query(
    `SELECT count(*)::integer AS count
     FROM crm_product_image_assets
     WHERE organization_id = $1::uuid AND product_id = $2::uuid`,
    [alpha.organizationId, catalog.id],
  )
  assert.equal(retained.rows[0].count, 2)
  const deletedLifecycleClock = Date.now() - 30_000
  const reactivatedCatalog = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      organizationId: alpha.organizationId,
      integrationAccountId: alpha.accountId,
      provider: 'shopify',
      credentialGeneration: 1,
      externalProductId: 'gid://shopify/Product/100',
      productSourceHash: sha256('catalog-reactivated-before-delete'),
      productLifecycle: 'active',
      imageSetComplete: true,
      observedAt: new Date(deletedLifecycleClock).toISOString(),
      actorEmail: alpha.actorEmail,
      images: [{
        providerImageId: 'shopify-image-1',
        locatorSha256: sha256('catalog-reactivated-locator'),
        sequence: 0,
        altText: 'Catalog reactivated',
        sourceHash: sha256('catalog-reactivated-source'),
      }],
    })
  assert.equal(reactivatedCatalog.active.length, 1)
  await completeClaim(
    await claimOne(alpha.organizationId),
    ONE_PIXEL_PNG,
    'image/png',
  )
  const deletedCatalog = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      organizationId: alpha.organizationId,
      integrationAccountId: alpha.accountId,
      provider: 'shopify',
      credentialGeneration: 1,
      externalProductId: 'gid://shopify/Product/100',
      productSourceHash: sha256('signed-products-delete-body'),
      productLifecycle: 'deleted',
      imageSetComplete: false,
      observedAt: new Date(deletedLifecycleClock + 10_000).toISOString(),
      actorEmail: alpha.actorEmail,
      images: [{
        providerImageId: 'must-be-ignored-on-deleted-product',
        locatorSha256: sha256('ignored-deleted-locator'),
        sequence: 0,
        altText: 'Ignored deleted payload image',
        sourceHash: sha256('ignored-deleted-source'),
      }],
    })
  assert.equal(deletedCatalog.productLifecycle, 'deleted')
  assert.equal(deletedCatalog.imageSetComplete, true)
  assert.equal(deletedCatalog.active.length, 0)
  assert.equal(deletedCatalog.removed.length, 1)
  const catalogAfterDeletedLifecycle = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: alpha.organizationId,
      productId: catalog.id,
    })
  assert.equal(catalogAfterDeletedLifecycle.assets.length, 0)
  const delayedPreDeleteSnapshot = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      organizationId: alpha.organizationId,
      integrationAccountId: alpha.accountId,
      provider: 'shopify',
      credentialGeneration: 1,
      externalProductId: 'gid://shopify/Product/100',
      productSourceHash: sha256('delayed-pre-delete-snapshot'),
      productLifecycle: 'active',
      imageSetComplete: true,
      observedAt: new Date(deletedLifecycleClock + 5_000).toISOString(),
      actorEmail: alpha.actorEmail,
      images: [{
        providerImageId: 'shopify-image-1',
        locatorSha256: sha256('delayed-pre-delete-locator'),
        sequence: 0,
        altText: 'Delayed stale image',
        sourceHash: sha256('delayed-pre-delete-source'),
      }],
    })
  assert.equal(delayedPreDeleteSnapshot.staleSnapshotIgnored, true)
  await assert.rejects(
    pool.query(
      `DELETE FROM crm_product_image_assets
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [alpha.organizationId, firstCompletion.assetId],
    ),
    /immutable and cannot be deleted/u,
  )

  const unmapped = await recordObservation(alpha, {
      externalProductId: 'gid://shopify/Product/500',
      providerImageId: 'unmapped-image',
      locatorSha256: sha256('unmapped-locator'),
      sourceHash: sha256('unmapped-source'),
    })
  assert.equal(unmapped.jobState, 'waiting_mapping')
  assert.equal(unmapped.waitReason, 'unmapped')
  const unmappedProduct = await addProduct(pool, alpha, {
    key: 'unmapped-now-mapped',
    name: 'Eventually mapped product',
    externalProductId: 'gid://shopify/Product/500',
    variants: ['gid://shopify/ProductVariant/501'],
  })
  const globallyResolved = await imageImports
    .resolveWaitingCommerceProductImageImportJobsInPostgres({
      updatedBy: 'global-image-resolver',
      limit: 10,
    })
  assert.ok(globallyResolved.some((job) => (
    job.jobId === unmapped.jobId
    && job.state === 'queued'
    && job.productId === unmappedProduct.id
  )))
  await pool.query(
    `UPDATE operations_product_mappings
     SET active = false, updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [alpha.organizationId, unmappedProduct.mappingIds[0]],
  )
  const staleMappingClaim = await imageImports
    .claimCommerceProductImageImportJobsInPostgres({
      organizationId: alpha.organizationId,
      workerId: 'mapping-fence-worker',
      limit: 1,
    })
  assert.equal(staleMappingClaim.length, 0)
  const staleMappingState = await pool.query(
    `SELECT state, wait_reason
     FROM operations_commerce_product_image_import_jobs
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [alpha.organizationId, unmapped.jobId],
  )
  assert.deepEqual(staleMappingState.rows[0], {
    state: 'waiting_mapping',
    wait_reason: 'mapping_changed',
  })
  await pool.query(
    `UPDATE operations_product_mappings
     SET active = true, updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [alpha.organizationId, unmappedProduct.mappingIds[0]],
  )
  await imageImports.resolveWaitingCommerceProductImageImportJobsInPostgres({
    updatedBy: 'mapping-fence-resolver',
    limit: 10,
  })
  await completeClaim(
    await claimOne(alpha.organizationId),
    ONE_PIXEL_PNG,
    'image/png',
  )

  await addProduct(pool, alpha, {
    key: 'mismatched-variant-fence',
    name: 'Mismatched variant fence',
    externalProductId: 'gid://shopify/Product/550',
    variants: ['gid://shopify/ProductVariant/551'],
    mappingVariants: ['gid://shopify/ProductVariant/552'],
  })
  const mismatchedVariant = await recordObservation(alpha, {
    externalProductId: 'gid://shopify/Product/550',
    providerImageId: 'mismatched-variant-image',
    locatorSha256: sha256('mismatched-variant-locator'),
    sourceHash: sha256('mismatched-variant-source'),
  })
  assert.equal(mismatchedVariant.jobState, 'waiting_mapping')
  assert.equal(mismatchedVariant.waitReason, 'unmapped')

  await addProduct(pool, alpha, {
    key: 'mixed-mismatched-variant-fence',
    name: 'Mixed mismatched variant fence',
    externalProductId: 'gid://shopify/Product/560',
    variants: [
      'gid://shopify/ProductVariant/561',
      'gid://shopify/ProductVariant/562',
    ],
    mappingVariants: [
      'gid://shopify/ProductVariant/561',
      'gid://shopify/ProductVariant/563',
    ],
  })
  const mixedMismatchedVariant = await recordObservation(alpha, {
    externalProductId: 'gid://shopify/Product/560',
    providerImageId: 'mixed-mismatched-variant-image',
    locatorSha256: sha256('mixed-mismatched-variant-locator'),
    sourceHash: sha256('mixed-mismatched-variant-source'),
  })
  assert.equal(mixedMismatchedVariant.jobState, 'waiting_mapping')
  assert.equal(mixedMismatchedVariant.waitReason, 'unmapped')

  const exactFanoutInput = imageSetInput(alpha, {
    externalProductId: 'gid://shopify/Product/300',
    providerImageId: 'exact-fanout-image',
    locatorSha256: sha256('exact-fanout-locator'),
    altText: 'Exact product-level fan-out',
    sourceHash: sha256('exact-fanout-source'),
  })
  const exactFanoutResult = await imageImports
    .reconcileCommerceProductImageSetInPostgres(exactFanoutInput)
  const exactFanout = exactFanoutResult.active[0]
  assert.ok(exactFanout)
  assert.equal(exactFanout.jobState, 'queued')
  assert.equal(exactFanout.waitReason, null)
  assert.ok([
    ambiguousA.id,
    ambiguousB.id,
  ].includes(exactFanout.productId))
  const exactFanoutClaim = await claimOne(alpha.organizationId)
  assert.equal(exactFanoutClaim.mappingCount, 2)
  const exactFanoutCompletion = await completeClaim(
    exactFanoutClaim,
    ONE_PIXEL_PNG,
    'image/png',
  )
  assert.equal(exactFanoutCompletion.targetCount, 2)
  const exactFanoutEvidence = await pool.query(
    `SELECT
       count(DISTINCT provenance.product_id)::integer AS provenance_targets,
       count(DISTINCT binding.product_id)::integer AS binding_targets,
       count(DISTINCT asset.product_id)::integer AS asset_targets,
       count(DISTINCT projection.aggregate_id)::integer AS projection_targets,
       count(DISTINCT event.id)::integer AS completion_audits
     FROM operations_commerce_product_image_asset_provenance provenance
     JOIN operations_commerce_product_image_bindings binding
       ON binding.organization_id = provenance.organization_id
      AND binding.integration_account_id = provenance.integration_account_id
      AND binding.external_product_id = provenance.external_product_id
      AND binding.image_identity_sha256 = provenance.image_identity_sha256
      AND binding.product_id = provenance.product_id
      AND binding.latest_import_job_id = provenance.import_job_id
     JOIN crm_product_image_assets asset
       ON asset.organization_id = provenance.organization_id
      AND asset.pipeline_id = provenance.pipeline_id
      AND asset.product_id = provenance.product_id
      AND asset.id = provenance.asset_id
     LEFT JOIN sync_outbox projection
       ON projection.aggregate_type = 'crm_products'
      AND projection.aggregate_id = provenance.product_id::text
      AND projection.target_system = 'suitecrm'
      AND projection.payload->'productImage' IS NOT NULL
     LEFT JOIN audit_events event
       ON event.organization_id = provenance.organization_id
      AND event.event_type =
            'operations.commerce_product_image_import.fanout_completed'
      AND event.aggregate_id = $2
     WHERE provenance.organization_id = $1::uuid
       AND provenance.import_job_id = $3::uuid`,
    [alpha.organizationId, exactFanout.jobGlobalId, exactFanout.jobId],
  )
  assert.deepEqual(exactFanoutEvidence.rows[0], {
    provenance_targets: 2,
    binding_targets: 2,
    asset_targets: 2,
    projection_targets: 2,
    completion_audits: 1,
  })
  const fanoutReplay = await completeClaim(
    exactFanoutClaim,
    ONE_PIXEL_PNG,
    'image/png',
  )
  assert.equal(fanoutReplay.replayed, true)
  assert.equal(fanoutReplay.targetCount, 2)
  await pool.query(
    `UPDATE operations_product_mappings
     SET active = false, updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [alpha.organizationId, ambiguousB.mappingIds[0]],
  )
  const narrowedFanout = await imageImports
    .reconcileCommerceProductImageSetInPostgres(exactFanoutInput)
  assert.equal(narrowedFanout.active[0].jobState, 'queued')
  assert.equal(narrowedFanout.active[0].productId, ambiguousA.id)
  const narrowedCompletion = await completeClaim(
    await claimOne(alpha.organizationId),
    ONE_PIXEL_PNG,
    'image/png',
  )
  assert.equal(narrowedCompletion.targetCount, 1)
  const removedFanoutTarget = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: alpha.organizationId,
      productId: ambiguousB.id,
    })
  assert.equal(removedFanoutTarget.assets.length, 0)

  const boundedFanoutExternalProductId = 'gid://shopify/Product/390'
  for (let index = 0; index < 51; index += 1) {
    await addProduct(pool, alpha, {
      key: `bounded-fanout-${index}`,
      name: `Bounded fan-out ${index}`,
      externalProductId: boundedFanoutExternalProductId,
      variants: [`gid://shopify/ProductVariant/${390_000 + index}`],
    })
  }
  const boundedFanout = await recordObservation(alpha, {
    externalProductId: boundedFanoutExternalProductId,
    providerImageId: 'bounded-fanout-image',
    locatorSha256: sha256('bounded-fanout-locator'),
    sourceHash: sha256('bounded-fanout-source'),
  })
  assert.equal(boundedFanout.jobState, 'queued')
  const boundedFanoutClaim = await claimOne(
    alpha.organizationId,
    'bounded-fanout-worker',
  )
  assert.equal(boundedFanoutClaim.mappingCount, 51)
  await assertImportCode(
    completeClaim(boundedFanoutClaim, ONE_PIXEL_PNG, 'image/png'),
    'COMMERCE_PRODUCT_IMAGE_FANOUT_REVIEW_REQUIRED',
  )
  const boundedFanoutFailure = await imageImports
    .failCommerceProductImageImportJobInPostgres({
      organizationId: alpha.organizationId,
      jobId: boundedFanoutClaim.jobId,
      leaseToken: boundedFanoutClaim.leaseToken,
      workerId: 'bounded-fanout-worker',
      errorCode: 'COMMERCE_PRODUCT_IMAGE_FANOUT_REVIEW_REQUIRED',
      retryable: false,
    })
  assert.equal(boundedFanoutFailure.state, 'dead')
  const boundedFanoutWrites = await pool.query(
    `SELECT count(*)::integer AS count
     FROM crm_product_image_assets asset
     JOIN operations_product_mappings mapping
       ON mapping.pipeline_id = asset.pipeline_id
      AND mapping.product_id = asset.product_id
     WHERE asset.organization_id = $1::uuid
       AND mapping.external_product_id = $2`,
    [alpha.organizationId, boundedFanoutExternalProductId],
  )
  assert.equal(boundedFanoutWrites.rows[0].count, 0)

  const setProduct = await addProduct(pool, alpha, {
    key: 'set-reconcile',
    name: 'Set reconcile product',
    externalProductId: 'gid://shopify/Product/600',
    variants: ['gid://shopify/ProductVariant/601'],
  })
  const setImageA = {
    providerImageId: 'set-image-a',
    locatorSha256: sha256('set-locator-a'),
    sequence: 0,
    altText: 'Set image A',
    sourceHash: sha256('set-source-a'),
  }
  const setImageB = {
    providerImageId: 'set-image-b',
    locatorSha256: sha256('set-locator-b'),
    sequence: 1,
    altText: 'Set image B',
    sourceHash: sha256('set-source-b'),
  }
  const setBase = {
    organizationId: alpha.organizationId,
    integrationAccountId: alpha.accountId,
    provider: 'shopify',
    credentialGeneration: 1,
    externalProductId: 'gid://shopify/Product/600',
    actorEmail: alpha.actorEmail,
  }
  const setClock = Date.now() - 120_000
  const setObservedAt = (offsetSeconds) =>
    new Date(setClock + offsetSeconds * 1_000).toISOString()
  await assertImportCode(
    imageImports.reconcileCommerceProductImageSetInPostgres({
      ...setBase,
      observedAt: setObservedAt(0),
      productSourceHash: sha256('duplicate-set-must-rollback'),
      imageSetComplete: true,
      images: [setImageA, { ...setImageA, sequence: 1 }],
    }),
    'COMMERCE_PRODUCT_IMAGE_DUPLICATE_IDENTITY',
  )
  const rolledBackSet = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_product_image_observations
     WHERE organization_id = $1::uuid
       AND external_product_id = 'gid://shopify/Product/600'`,
    [alpha.organizationId],
  )
  assert.equal(rolledBackSet.rows[0].count, 0)
  const initialSet = await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...setBase,
    observedAt: setObservedAt(10),
    productSourceHash: sha256('complete-set-v1'),
    imageSetComplete: true,
    images: [setImageA, setImageB],
  })
  assert.equal(initialSet.staleSnapshotIgnored, false)
  assert.equal(initialSet.active.length, 2)
  assert.equal(initialSet.removed.length, 0)
  const jobsBeforeNonImageChange = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_product_image_import_jobs
     WHERE organization_id = $1::uuid
       AND external_product_id = 'gid://shopify/Product/600'`,
    [alpha.organizationId],
  )
  const nonImageProductChange = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      ...setBase,
      observedAt: setObservedAt(20),
      productSourceHash: sha256('title-only-product-change'),
      imageSetComplete: true,
      images: [setImageA, setImageB],
    })
  assert.equal(nonImageProductChange.staleSnapshotIgnored, false)
  assert.ok(nonImageProductChange.active.every((receipt) => receipt.replayed))
  const jobsAfterNonImageChange = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_product_image_import_jobs
     WHERE organization_id = $1::uuid
       AND external_product_id = 'gid://shopify/Product/600'`,
    [alpha.organizationId],
  )
  assert.equal(
    jobsAfterNonImageChange.rows[0].count,
    jobsBeforeNonImageChange.rows[0].count,
    'a non-image product change must not create image work',
  )
  const partialSet = await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...setBase,
    observedAt: setObservedAt(30),
    productSourceHash: sha256('partial-page-v2'),
    imageSetComplete: false,
    images: [setImageA],
  })
  assert.equal(partialSet.staleSnapshotIgnored, false)
  assert.equal(partialSet.removed.length, 0)
  const partialFence = await pool.query(
    `SELECT accepted_observed_at
     FROM operations_commerce_product_image_snapshot_fences
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND provider = 'shopify'
       AND credential_generation = 1
       AND external_product_id = 'gid://shopify/Product/600'`,
    [alpha.organizationId, alpha.accountId],
  )
  assert.equal(
    new Date(partialFence.rows[0].accepted_observed_at).toISOString(),
    setObservedAt(30),
    'a partial set must advance the durable snapshot fence',
  )
  const imageBIdentity = imageImports.commerceProductImageIdentitySha256(setImageB)
  const imageBAfterPartial = await pool.query(
    `SELECT lifecycle_state
     FROM operations_commerce_product_image_observations
     WHERE organization_id = $1::uuid
       AND external_product_id = 'gid://shopify/Product/600'
       AND image_identity_sha256 = $2
     ORDER BY observation_revision DESC
     LIMIT 1`,
    [alpha.organizationId, imageBIdentity],
  )
  assert.equal(imageBAfterPartial.rows[0].lifecycle_state, 'active')
  const completeSet = await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...setBase,
    observedAt: setObservedAt(40),
    productSourceHash: sha256('complete-set-v3'),
    imageSetComplete: true,
    images: [setImageA],
  })
  assert.equal(completeSet.removed.length, 1)
  assert.equal(completeSet.removed[0].jobState, 'cancelled')
  const equalReplayBefore = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observation_sets
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/600') AS sets,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observations
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/600') AS observations,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_import_jobs
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/600') AS jobs`,
    [alpha.organizationId],
  )
  const completeSetReplay = await imageImports.reconcileCommerceProductImageSetInPostgres({
    ...setBase,
    observedAt: setObservedAt(40),
    productSourceHash: sha256('complete-set-v3'),
    imageSetComplete: true,
    images: [setImageA],
  })
  assert.equal(completeSetReplay.staleSnapshotIgnored, false)
  assert.equal(completeSetReplay.active[0].replayed, true)
  assert.equal(completeSetReplay.removed.length, 0)
  assert.equal(completeSetReplay.active[0].productId, setProduct.id)
  const equalReplayAfter = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observation_sets
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/600') AS sets,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observations
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/600') AS observations,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_import_jobs
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/600') AS jobs`,
    [alpha.organizationId],
  )
  assert.deepEqual(
    equalReplayAfter.rows[0],
    equalReplayBefore.rows[0],
    'an equal snapshot replay must not create evidence or work',
  )
  await assertImportCode(
    imageImports.reconcileCommerceProductImageSetInPostgres({
      ...setBase,
      observedAt: setObservedAt(40),
      productSourceHash: sha256('same-time-different-snapshot'),
      imageSetComplete: true,
      images: [setImageA],
    }),
    'COMMERCE_PRODUCT_IMAGE_SNAPSHOT_COLLISION',
  )

  const imageAIdentity = imageImports.commerceProductImageIdentitySha256(setImageA)
  const evidenceBeforeStaleSet = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observation_sets
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/600') AS sets,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observations
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/600') AS observations`,
    [alpha.organizationId],
  )
  const staleProductSet = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      ...setBase,
      observedAt: setObservedAt(35),
      productSourceHash: sha256('delayed-older-complete-set'),
      imageSetComplete: true,
      images: [setImageB],
    })
  assert.equal(staleProductSet.staleSnapshotIgnored, true)
  assert.deepEqual(Array.from(staleProductSet.active), [])
  assert.deepEqual(Array.from(staleProductSet.removed), [])
  const evidenceAfterStaleSet = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observation_sets
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/600') AS sets,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observations
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/600') AS observations`,
    [alpha.organizationId],
  )
  assert.deepEqual(evidenceAfterStaleSet.rows[0], evidenceBeforeStaleSet.rows[0])
  const stateAfterStaleSet = await pool.query(
    `SELECT DISTINCT ON (image_identity_sha256)
       image_identity_sha256, lifecycle_state
     FROM operations_commerce_product_image_observations
     WHERE organization_id = $1::uuid
       AND external_product_id = 'gid://shopify/Product/600'
       AND image_identity_sha256 = ANY($2::text[])
     ORDER BY image_identity_sha256, observation_revision DESC`,
    [alpha.organizationId, [imageAIdentity, imageBIdentity]],
  )
  assert.deepEqual(
    Object.fromEntries(stateAfterStaleSet.rows.map((row) => [
      row.image_identity_sha256,
      row.lifecycle_state,
    ])),
    { [imageAIdentity]: 'active', [imageBIdentity]: 'removed' },
    'an older complete snapshot cannot reactivate removed images or tombstone current ones',
  )

  const emptyPartialSet = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      ...setBase,
      observedAt: setObservedAt(50),
      productSourceHash: sha256('newer-empty-partial-set'),
      imageSetComplete: false,
      images: [],
    })
  assert.equal(emptyPartialSet.staleSnapshotIgnored, false)
  assert.equal(emptyPartialSet.removed.length, 0)
  const completeEmptySet = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      ...setBase,
      observedAt: setObservedAt(60),
      productSourceHash: sha256('newer-complete-empty-set'),
      imageSetComplete: true,
      images: [],
    })
  assert.equal(completeEmptySet.staleSnapshotIgnored, false)
  assert.equal(completeEmptySet.active.length, 0)
  assert.equal(completeEmptySet.removed.length, 1)
  const completeEmptyReplay = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      ...setBase,
      observedAt: setObservedAt(60),
      productSourceHash: sha256('newer-complete-empty-set'),
      imageSetComplete: true,
      images: [],
    })
  assert.equal(completeEmptyReplay.staleSnapshotIgnored, false)
  assert.equal(completeEmptyReplay.removed.length, 0)
  const finalSetFence = await pool.query(
    `SELECT accepted_observed_at
     FROM operations_commerce_product_image_snapshot_fences
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND provider = 'shopify'
       AND credential_generation = 1
       AND external_product_id = 'gid://shopify/Product/600'`,
    [alpha.organizationId, alpha.accountId],
  )
  assert.equal(
    new Date(finalSetFence.rows[0].accepted_observed_at).toISOString(),
    setObservedAt(60),
    'complete-empty reconciliation must advance the durable snapshot fence',
  )
  const observationSetEvidence = await pool.query(
    `SELECT global_id, image_identity_count, image_set_complete
     FROM operations_commerce_product_image_observation_sets
     WHERE organization_id = $1::uuid
       AND external_product_id = 'gid://shopify/Product/600'
     ORDER BY observed_at DESC, created_at DESC`,
    [alpha.organizationId],
  )
  assert.ok(observationSetEvidence.rows.length >= 6)
  assert.ok(observationSetEvidence.rows.every((row) => (
    /^gcis[0-9a-v]{12}$/u.test(row.global_id)
    && row.global_id.length === 16
  )))
  assert.ok(observationSetEvidence.rows.some((row) => (
    row.image_identity_count === 0 && row.image_set_complete === true
  )))

  const betaIndependentSet = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      ...setBase,
      organizationId: beta.organizationId,
      integrationAccountId: beta.accountId,
      actorEmail: beta.actorEmail,
      observedAt: setObservedAt(5),
      productSourceHash: sha256('beta-independent-older-clock'),
      imageSetComplete: true,
      images: [],
    })
  assert.equal(betaIndependentSet.staleSnapshotIgnored, false)
  const independentFences = await pool.query(
    `SELECT organization_id::text, accepted_observed_at
     FROM operations_commerce_product_image_snapshot_fences
     WHERE external_product_id = 'gid://shopify/Product/600'
     ORDER BY organization_id::text`,
  )
  assert.equal(independentFences.rows.length, 2)

  const rollbackClient = await pool.connect()
  try {
    await rollbackClient.query('BEGIN')
    await imageImports.reconcileCommerceProductImageSetWithClient({
      ...setBase,
      externalProductId: 'gid://shopify/Product/700',
      observedAt: setObservedAt(70),
      productSourceHash: sha256('outer-transaction-rollback'),
      imageSetComplete: true,
      images: [{
        providerImageId: 'rollback-image',
        locatorSha256: sha256('rollback-locator'),
        sequence: 0,
        sourceHash: sha256('rollback-image-source'),
      }],
    }, rollbackClient)
    await rollbackClient.query('ROLLBACK')
  } catch (error) {
    await rollbackClient.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    rollbackClient.release()
  }
  const rolledBackOuterTransaction = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_snapshot_fences
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/700') AS fences,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observation_sets
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/700') AS sets,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observations
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/700') AS observations`,
    [alpha.organizationId],
  )
  assert.deepEqual(rolledBackOuterTransaction.rows[0], {
    fences: 0,
    sets: 0,
    observations: 0,
  })

  // A claim is fenced to the exact activation revision. Freezing Operations
  // after the claim must prevent persistence without losing the durable work.
  const frozenProduct = await addProduct(pool, gamma, {
    key: 'activation-freeze',
    name: 'Activation freeze product',
    externalProductId: 'gid://shopify/Product/950',
    variants: ['gid://shopify/ProductVariant/951'],
  })
  const frozenReceipt = await recordObservation(gamma, {
    externalProductId: 'gid://shopify/Product/950',
    providerImageId: 'activation-freeze-image',
    locatorSha256: sha256('activation-freeze-locator'),
    sourceHash: sha256('activation-freeze-source'),
    maxAttempts: 1,
  })
  const frozenClaim = await claimOne(
    gamma.organizationId,
    'activation-freeze-worker',
  )
  await pool.query(
    `UPDATE operations_activation_scopes
     SET state = 'frozen',
         revision = revision + 1,
         reason = 'Acceptance freeze after image claim',
         updated_by = $2,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid`,
    [gamma.organizationId, gamma.actorEmail],
  )
  await assertImportCode(
    completeClaim(frozenClaim, ONE_PIXEL_PNG, 'image/png'),
    'COMMERCE_PRODUCT_IMAGE_FENCE_STALE',
  )
  const frozenWrites = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM crm_product_image_assets
        WHERE organization_id = $1::uuid
          AND product_id = $2::uuid) AS assets,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_asset_provenance
        WHERE organization_id = $1::uuid
          AND product_id = $2::uuid) AS provenance,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_bindings
        WHERE organization_id = $1::uuid
          AND external_product_id = 'gid://shopify/Product/950') AS bindings`,
    [gamma.organizationId, frozenProduct.id],
  )
  assert.deepEqual(frozenWrites.rows[0], {
    assets: 0,
    provenance: 0,
    bindings: 0,
  })
  const frozenRecovery = await imageImports
    .failCommerceProductImageImportJobInPostgres({
      organizationId: gamma.organizationId,
      jobId: frozenReceipt.jobId,
      leaseToken: frozenClaim.leaseToken,
      workerId: 'activation-freeze-worker',
      errorCode: 'ACTIVATION_REVISION_CHANGED',
      retryable: true,
      retryAfterSeconds: 0,
    })
  assert.deepEqual({ ...frozenRecovery }, {
    state: 'waiting_mapping',
    attemptCount: 1,
  })
  const whileFrozen = await imageImports
    .resolveWaitingCommerceProductImageImportJobsInPostgres({
      organizationId: gamma.organizationId,
      updatedBy: 'activation-freeze-resolver',
      limit: 10,
    })
  assert.deepEqual(Array.from(whileFrozen, (job) => ({
    jobId: job.jobId,
    state: job.state,
    waitReason: job.waitReason,
  })), [{
    jobId: frozenReceipt.jobId,
    state: 'waiting_mapping',
    waitReason: 'mapping_changed',
  }])
  await pool.query(
    `UPDATE operations_activation_scopes
     SET state = 'shadow',
         revision = revision + 1,
         reason = 'Acceptance freeze released',
         updated_by = $2,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid`,
    [gamma.organizationId, gamma.actorEmail],
  )
  const afterUnfreeze = await imageImports
    .resolveWaitingCommerceProductImageImportJobsInPostgres({
      organizationId: gamma.organizationId,
      updatedBy: 'activation-unfreeze-resolver',
      limit: 10,
    })
  assert.ok(afterUnfreeze.some((job) => (
    job.jobId !== frozenReceipt.jobId
    && job.state === 'queued'
    && job.productId === frozenProduct.id
  )))
  await completeClaim(
    await claimOne(gamma.organizationId, 'activation-unfreeze-worker'),
    ONE_PIXEL_PNG,
    'image/png',
  )
  const frozenBinding = await pool.query(
    `SELECT lifecycle_state, activation_revision
     FROM operations_commerce_product_image_bindings
     WHERE organization_id = $1::uuid
       AND external_product_id = 'gid://shopify/Product/950'`,
    [gamma.organizationId],
  )
  assert.deepEqual(frozenBinding.rows[0], {
    lifecycle_state: 'active',
    activation_revision: 3,
  })
  const frozenJobGenerations = await pool.query(
    `SELECT job_generation, state, attempt_count, last_error_code
     FROM operations_commerce_product_image_import_jobs
     WHERE organization_id = $1::uuid
       AND observation_id = $2::uuid
     ORDER BY job_generation`,
    [gamma.organizationId, frozenReceipt.observationId],
  )
  assert.deepEqual(frozenJobGenerations.rows, [
    {
      job_generation: 1,
      state: 'cancelled',
      attempt_count: 1,
      last_error_code: 'MAPPING_CHANGED',
    },
    {
      job_generation: 2,
      state: 'succeeded',
      attempt_count: 1,
      last_error_code: null,
    },
  ])

  // Switching the authoritative pipeline after a claim must strand neither
  // the observation nor the binding. The same immutable observation gets an
  // auditable successor generation when a later successful import is remapped.
  const switchOldProduct = await addProduct(pool, gamma, {
    key: 'pipeline-switch-old',
    name: 'Pipeline switch old product',
    externalProductId: 'gid://shopify/Product/960',
    variants: ['gid://shopify/ProductVariant/961'],
  })
  const switchInput = imageSetInput(gamma, {
    externalProductId: 'gid://shopify/Product/960',
    providerImageId: 'pipeline-switch-image',
    locatorSha256: sha256('pipeline-switch-locator'),
    altText: 'Pipeline switch image',
    sourceHash: sha256('pipeline-switch-source'),
    maxAttempts: 3,
  })
  const switchFirst = await imageImports
    .reconcileCommerceProductImageSetInPostgres(switchInput)
  const switchFirstReceipt = switchFirst.active[0]
  const switchOldClaim = await claimOne(
    gamma.organizationId,
    'pipeline-switch-old-worker',
  )
  const gammaSecond = await addPipeline(pool, gamma, 'gamma-second')
  const switchSecondProduct = await addProduct(pool, gammaSecond, {
    key: 'pipeline-switch-second',
    name: 'Pipeline switch second product',
    externalProductId: 'gid://shopify/Product/960',
    variants: ['gid://shopify/ProductVariant/962'],
  })
  await pool.query(
    `UPDATE operations_activation_scopes
     SET data_pipeline_id = $2::uuid,
         state = 'shadow',
         revision = revision + 1,
         reason = 'Acceptance authoritative pipeline switch',
         updated_by = $3,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid`,
    [gamma.organizationId, gammaSecond.pipelineId, gamma.actorEmail],
  )
  await assertImportCode(
    completeClaim(switchOldClaim, ONE_PIXEL_PNG, 'image/png'),
    'COMMERCE_PRODUCT_IMAGE_FENCE_STALE',
  )
  const switchRecovery = await imageImports
    .failCommerceProductImageImportJobInPostgres({
      organizationId: gamma.organizationId,
      jobId: switchFirstReceipt.jobId,
      leaseToken: switchOldClaim.leaseToken,
      workerId: 'pipeline-switch-old-worker',
      errorCode: 'PIPELINE_MAPPING_CHANGED',
      retryable: true,
      retryAfterSeconds: 0,
    })
  assert.equal(switchRecovery.state, 'waiting_mapping')
  const switchResolved = await imageImports
    .resolveWaitingCommerceProductImageImportJobsInPostgres({
      organizationId: gamma.organizationId,
      updatedBy: 'pipeline-switch-resolver',
      limit: 10,
    })
  assert.ok(switchResolved.some((job) => (
    job.jobId === switchFirstReceipt.jobId
    && job.state === 'queued'
    && job.productId === switchSecondProduct.id
  )))
  const switchSecondCompletion = await completeClaim(
    await claimOne(gamma.organizationId, 'pipeline-switch-second-worker'),
    ONE_PIXEL_PNG,
    'image/png',
  )
  assert.equal(switchSecondCompletion.reusedAsset, false)
  assert.equal(switchOldProduct.id === switchSecondProduct.id, false)

  const removedFromFormerPipeline = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      organizationId: gamma.organizationId,
      integrationAccountId: gamma.accountId,
      provider: 'shopify',
      credentialGeneration: 1,
      externalProductId: 'gid://shopify/Product/950',
      productSourceHash: sha256('former-pipeline-provider-delete'),
      productLifecycle: 'deleted',
      imageSetComplete: true,
      observedAt: nextObservationTimestamp(),
      actorEmail: gamma.actorEmail,
      images: [],
    })
  assert.equal(removedFromFormerPipeline.removed.length, 1)
  const formerPipelineBinding = await pool.query(
    `SELECT lifecycle_state, pipeline_id::text, product_id::text
     FROM operations_commerce_product_image_bindings
     WHERE organization_id = $1::uuid
       AND external_product_id = 'gid://shopify/Product/950'`,
    [gamma.organizationId],
  )
  assert.deepEqual(formerPipelineBinding.rows[0], {
    lifecycle_state: 'inactive',
    pipeline_id: gamma.pipelineId,
    product_id: frozenProduct.id,
  })
  const formerPipelineProjection = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: gamma.organizationId,
      productId: frozenProduct.id,
    })
  assert.equal(formerPipelineProjection.assets.length, 0)

  const gammaThird = await addPipeline(pool, gamma, 'gamma-third')
  const switchThirdProduct = await addProduct(pool, gammaThird, {
    key: 'pipeline-switch-third',
    name: 'Pipeline switch third product',
    externalProductId: 'gid://shopify/Product/960',
    variants: ['gid://shopify/ProductVariant/963'],
  })
  await pool.query(
    `UPDATE operations_activation_scopes
     SET data_pipeline_id = $2::uuid,
         state = 'shadow',
         revision = revision + 1,
         reason = 'Acceptance remap after success',
         updated_by = $3,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid`,
    [gamma.organizationId, gammaThird.pipelineId, gamma.actorEmail],
  )
  const remappedResult = await imageImports
    .reconcileCommerceProductImageSetInPostgres({
      ...switchInput,
      productSourceHash: sha256('pipeline-switch-remapped-product-source'),
      observedAt: nextObservationTimestamp(),
    })
  const remappedReceipt = remappedResult.active[0]
  assert.equal(remappedReceipt.replayed, true)
  assert.notEqual(remappedReceipt.jobId, switchFirstReceipt.jobId)
  assert.equal(remappedReceipt.jobState, 'queued')
  assert.equal(remappedReceipt.productId, switchThirdProduct.id)
  const switchThirdCompletion = await completeClaim(
    await claimOne(gamma.organizationId, 'pipeline-switch-third-worker'),
    ONE_PIXEL_PNG,
    'image/png',
  )
  const remapEvidence = await pool.query(
    `SELECT
       array_agg(job.job_generation ORDER BY job.job_generation) AS generations,
       array_agg(job.state ORDER BY job.job_generation) AS states,
       count(DISTINCT job.observation_id)::integer AS observations,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_asset_provenance provenance
        WHERE provenance.organization_id = $1::uuid
          AND provenance.observation_id = $2::uuid) AS provenance_count
     FROM operations_commerce_product_image_import_jobs job
     WHERE job.organization_id = $1::uuid
       AND job.observation_id = $2::uuid`,
    [gamma.organizationId, switchFirstReceipt.observationId],
  )
  assert.deepEqual(remapEvidence.rows[0], {
    generations: [1, 2],
    states: ['succeeded', 'succeeded'],
    observations: 1,
    provenance_count: 2,
  })
  const remappedBinding = await pool.query(
    `SELECT product_id::text, pipeline_id::text, asset_id::text,
            latest_import_job_generation, lifecycle_state
     FROM operations_commerce_product_image_bindings
     WHERE organization_id = $1::uuid
       AND external_product_id = 'gid://shopify/Product/960'
     ORDER BY latest_import_job_generation DESC
     LIMIT 1`,
    [gamma.organizationId],
  )
  assert.deepEqual(remappedBinding.rows[0], {
    product_id: switchThirdProduct.id,
    pipeline_id: gammaThird.pipelineId,
    asset_id: switchThirdCompletion.assetId,
    latest_import_job_generation: 2,
    lifecycle_state: 'active',
  })
  const supersededPipelineProjection = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: gamma.organizationId,
      productId: switchSecondProduct.id,
    })
  assert.equal(supersededPipelineProjection.assets.length, 0)
  const currentPipelineProjection = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: gamma.organizationId,
      productId: switchThirdProduct.id,
    })
  assert.equal(currentPipelineProjection.assets.length, 1)
  assert.equal(
    currentPipelineProjection.assets[0].id,
    switchThirdCompletion.assetId,
  )

  // Dead jobs remain terminal under ordinary replay. An owner/admin action
  // creates a separate generation and preserves the dead row as audit history.
  const deadProduct = await addProduct(pool, gammaThird, {
    key: 'operator-dead-retry',
    name: 'Operator dead retry product',
    externalProductId: 'gid://shopify/Product/970',
    variants: ['gid://shopify/ProductVariant/971'],
  })
  const deadInput = imageSetInput(gamma, {
    externalProductId: 'gid://shopify/Product/970',
    providerImageId: 'operator-dead-retry-image',
    locatorSha256: sha256('operator-dead-retry-locator'),
    sourceHash: sha256('operator-dead-retry-source'),
    maxAttempts: 1,
  })
  const deadFirst = await imageImports
    .reconcileCommerceProductImageSetInPostgres(deadInput)
  const deadReceipt = deadFirst.active[0]
  const deadClaim = await claimOne(gamma.organizationId, 'operator-dead-worker')
  const terminalFailure = await imageImports
    .failCommerceProductImageImportJobInPostgres({
      organizationId: gamma.organizationId,
      jobId: deadReceipt.jobId,
      leaseToken: deadClaim.leaseToken,
      workerId: 'operator-dead-worker',
      errorCode: 'PROVIDER_IMAGE_READ_FAILED',
      retryable: false,
      retryAfterSeconds: 0,
    })
  assert.deepEqual(
    { ...terminalFailure },
    { state: 'dead', attemptCount: 1 },
  )
  const ordinaryDeadReplay = await imageImports
    .reconcileCommerceProductImageSetInPostgres(deadInput)
  assert.equal(ordinaryDeadReplay.active[0].jobId, deadReceipt.jobId)
  assert.equal(ordinaryDeadReplay.active[0].jobState, 'dead')
  await assertImportCode(
    imageImports.retryDeadCommerceProductImageImportJobInPostgres({
      organizationId: gamma.organizationId,
      jobId: deadReceipt.jobId,
      actorEmail: beta.actorEmail,
      reason: 'Cross-tenant retry must fail',
    }),
    'COMMERCE_PRODUCT_IMAGE_RETRY_FORBIDDEN',
  )
  const deadSuccessor = await imageImports
    .retryDeadCommerceProductImageImportJobInPostgres({
      organizationId: gamma.organizationId,
      jobId: deadReceipt.jobId,
      actorEmail: gamma.actorEmail,
      reason: 'Provider endpoint recovered; operator approved one retry',
    })
  assert.equal(deadSuccessor.jobGeneration, 2)
  assert.equal(deadSuccessor.state, 'queued')
  assert.equal(deadSuccessor.productId, deadProduct.id)
  await completeClaim(
    await claimOne(gamma.organizationId, 'operator-retry-worker'),
    FOUR_BY_FIVE_WEBP,
    'image/webp',
  )
  const deadRetryEvidence = await pool.query(
    `SELECT
       array_agg(job.job_generation ORDER BY job.job_generation) AS generations,
       array_agg(job.state ORDER BY job.job_generation) AS states,
       count(DISTINCT ROW(
         job.observation_id,
         job.observation_revision,
         job.image_identity_sha256,
         job.locator_sha256,
         job.observation_source_hash
       ))::integer AS immutable_inputs,
       (SELECT count(*)::integer
        FROM audit_events event
        WHERE event.organization_id = $1::uuid
          AND event.event_type =
                'operations.commerce_product_image_import.successor_created'
          AND event.payload->>'reason' = 'operator_retry'
          AND event.payload->>'operatorReason' =
                'Provider endpoint recovered; operator approved one retry')
         AS retry_audits
     FROM operations_commerce_product_image_import_jobs job
     WHERE job.organization_id = $1::uuid
       AND job.observation_id = $2::uuid`,
    [gamma.organizationId, deadReceipt.observationId],
  )
  assert.deepEqual(deadRetryEvidence.rows[0], {
    generations: [1, 2],
    states: ['dead', 'succeeded'],
    immutable_inputs: 1,
    retry_audits: 1,
  })

  const expiredProduct = await addProduct(pool, gammaThird, {
    key: 'expired-mapping-recovery',
    name: 'Expired mapping recovery product',
    externalProductId: 'gid://shopify/Product/980',
    variants: ['gid://shopify/ProductVariant/981'],
  })
  const expiredMapping = await recordObservation(gamma, {
    externalProductId: 'gid://shopify/Product/980',
    providerImageId: 'expired-mapping-image',
    locatorSha256: sha256('expired-mapping-locator'),
    sourceHash: sha256('expired-mapping-source'),
    maxAttempts: 3,
  })
  const expiredMappingClaim = (await imageImports
    .claimCommerceProductImageImportJobsInPostgres({
      organizationId: gamma.organizationId,
      workerId: 'expired-mapping-worker-one',
      limit: 1,
      leaseSeconds: 5,
    }))[0]
  assert.ok(expiredMappingClaim)
  await pool.query(
    `UPDATE operations_activation_scopes
     SET revision = revision + 1,
         reason = 'Acceptance revision change during expiring claim',
         updated_by = $2,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid`,
    [gamma.organizationId, gamma.actorEmail],
  )
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_100))
  const afterExpiredMappingClaim = await imageImports
    .claimCommerceProductImageImportJobsInPostgres({
      organizationId: gamma.organizationId,
      workerId: 'expired-mapping-worker-two',
      limit: 1,
      leaseSeconds: 30,
    })
  assert.equal(afterExpiredMappingClaim.length, 0)
  const expiredMappingState = await pool.query(
    `SELECT state, wait_reason, attempt_count, pipeline_id::text,
            product_id::text, product_mapping_id::text, activation_revision
     FROM operations_commerce_product_image_import_jobs
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [gamma.organizationId, expiredMapping.jobId],
  )
  assert.deepEqual(expiredMappingState.rows[0], {
    state: 'waiting_mapping',
    wait_reason: 'mapping_changed',
    attempt_count: 1,
    pipeline_id: null,
    product_id: null,
    product_mapping_id: null,
    activation_revision: null,
  })
  const resolvedExpiredMapping = await imageImports
    .resolveWaitingCommerceProductImageImportJobsInPostgres({
      organizationId: gamma.organizationId,
      updatedBy: 'expired-mapping-resolver',
      limit: 10,
    })
  assert.ok(resolvedExpiredMapping.some((job) => (
    job.jobId === expiredMapping.jobId
    && job.state === 'queued'
    && job.productId === expiredProduct.id
  )))
  const recoveredExpiredClaim = await claimOne(
    gamma.organizationId,
    'expired-mapping-worker-three',
  )
  assert.equal(recoveredExpiredClaim.attemptCount, 2)
  await completeClaim(recoveredExpiredClaim, ONE_PIXEL_PNG, 'image/png')

  // Provider assets remain stored, but only a binding under the current
  // credential generation is visible to CRM readers.
  const beforeCredentialRotation = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: gamma.organizationId,
      productId: expiredProduct.id,
    })
  assert.equal(beforeCredentialRotation.assets.length, 1)
  await pool.query(
    `UPDATE operations_commerce_credentials
     SET credential_ciphertext = decode('03', 'hex'),
         credential_identifier_last_four = 'ROT3',
         credential_version = 2,
         verification_status = 'verified',
         verified_at = clock_timestamp(),
         last_error_code = NULL,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [gamma.organizationId, gamma.accountId],
  )
  await pool.query(
    `UPDATE operations_integration_accounts
     SET commerce_credential_generation = 2,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [gamma.organizationId, gamma.accountId],
  )
  const afterCredentialRotation = await crmImageAssets
    .listCrmProductImageAssetsInPostgres({
      organizationId: gamma.organizationId,
      productId: expiredProduct.id,
    })
  assert.equal(afterCredentialRotation.assets.length, 0)
  const retainedAfterCredentialRotation = await pool.query(
    `SELECT count(*)::integer AS count
     FROM crm_product_image_assets
     WHERE organization_id = $1::uuid AND product_id = $2::uuid`,
    [gamma.organizationId, expiredProduct.id],
  )
  assert.equal(retainedAfterCredentialRotation.rows[0].count, 1)

  const alphaGlobal = await recordObservation(alpha, {
      externalProductId: 'gid://shopify/Product/100',
      providerImageId: 'alpha-global-image',
      locatorSha256: sha256('alpha-global-locator'),
      sourceHash: sha256('alpha-global-source'),
      observedAt: new Date(deletedLifecycleClock + 20_000).toISOString(),
    })
  assert.equal(alphaGlobal.productId, catalog.id)
  const betaGlobal = await recordObservation(beta, {
      externalProductId: 'gid://shopify/Product/900',
      providerImageId: 'beta-global-image',
      locatorSha256: sha256('beta-global-locator'),
      sourceHash: sha256('beta-global-source'),
    })
  assert.equal(betaGlobal.productId, leaseProduct.id)

  // The trusted global worker drains two tenants in one bounded claim without
  // allowing any account, Product, credential, or actor fence to cross them.
  let globalClaim = await imageImports.claimCommerceProductImageImportJobsInPostgres({
    workerId: 'global-image-worker',
    limit: 20,
    leaseSeconds: 30,
  })
  assert.ok(globalClaim.length >= 2)
  assert.deepEqual(
    new Set(Array.from(globalClaim, (claim) => claim.organizationId)),
    new Set([alpha.organizationId, beta.organizationId]),
  )
  for (const claim of globalClaim) {
    assert.ok([alpha.organizationId, beta.organizationId].includes(claim.organizationId))
    assert.equal(
      claim.organizationId === alpha.organizationId
        ? claim.accountGlobalId
        : beta.accountGlobalId,
      claim.accountGlobalId,
    )
    await completeClaim(claim, ONE_PIXEL_PNG, 'image/png')
  }

  const lease = await recordObservation(beta, {
      externalProductId: 'gid://shopify/Product/900',
      providerImageId: 'lease-image',
      locatorSha256: sha256('lease-locator'),
      sourceHash: sha256('lease-source'),
      maxAttempts: 2,
    })
  assert.equal(lease.productId, leaseProduct.id)
  const firstLeaseClaim = await imageImports
    .claimCommerceProductImageImportJobsInPostgres({
      organizationId: beta.organizationId,
      workerId: 'lease-worker-one',
      limit: 1,
      leaseSeconds: 5,
    })
  assert.equal(firstLeaseClaim[0].attemptCount, 1)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_100))
  const staleLeaseHealth = await imageImports
    .readCommerceProductImageImportQueueHealthInPostgres()
  assert.equal(staleLeaseHealth.claimedCount, 1)
  assert.equal(staleLeaseHealth.staleLeaseCount, 1)
  const secondLeaseClaim = await imageImports
    .claimCommerceProductImageImportJobsInPostgres({
      organizationId: beta.organizationId,
      workerId: 'lease-worker-two',
      limit: 1,
      leaseSeconds: 30,
    })
  assert.equal(secondLeaseClaim[0].jobId, lease.jobId)
  assert.equal(secondLeaseClaim[0].attemptCount, 2)
  const dead = await imageImports.failCommerceProductImageImportJobInPostgres({
    organizationId: beta.organizationId,
    jobId: lease.jobId,
    leaseToken: secondLeaseClaim[0].leaseToken,
    workerId: 'lease-worker-two',
    errorCode: 'PROVIDER_IMAGE_READ_FAILED',
    retryable: true,
    retryAfterSeconds: 0,
  })
  assert.equal(dead.state, 'dead')
  assert.equal(dead.attemptCount, 2)

  const stale = await recordObservation(beta, {
      externalProductId: 'gid://shopify/Product/900',
      providerImageId: 'stale-credential-image',
      locatorSha256: sha256('stale-credential-locator'),
      sourceHash: sha256('stale-credential-source'),
    })
  await pool.query(
    `UPDATE operations_commerce_credentials
     SET credential_ciphertext = decode('02', 'hex'),
         credential_identifier_last_four = 'ROT2',
         credential_version = 2,
         verification_status = 'verified',
         verified_at = clock_timestamp(),
         last_error_code = NULL,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [beta.organizationId, beta.accountId],
  )
  await pool.query(
    `UPDATE operations_integration_accounts
     SET commerce_credential_generation = 2,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [beta.organizationId, beta.accountId],
  )
  const staleClaims = await imageImports
    .claimCommerceProductImageImportJobsInPostgres({
      organizationId: beta.organizationId,
      workerId: 'stale-credential-worker',
      limit: 10,
    })
  assert.deepEqual(Array.from(staleClaims), [])
  const staleState = await pool.query(
    `SELECT state, last_error_code
     FROM operations_commerce_product_image_import_jobs
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [beta.organizationId, stale.jobId],
  )
  assert.deepEqual(staleState.rows[0], {
    state: 'cancelled',
    last_error_code: 'CREDENTIAL_STALE',
  })

  const overdue = await recordObservation(beta, {
        externalProductId: 'gid://shopify/Product/900',
        providerImageId: 'overdue-image',
        locatorSha256: sha256('overdue-locator'),
        sourceHash: sha256('overdue-source'),
        credentialGeneration: 2,
    })
  const agingClient = await pool.connect()
  try {
    await agingClient.query('SET session_replication_role = replica')
    await agingClient.query(
      `UPDATE operations_commerce_product_image_import_jobs
       SET available_at = statement_timestamp() - interval '6 minutes'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [beta.organizationId, overdue.jobId],
    )
  } finally {
    await agingClient.query('SET session_replication_role = origin')
      .catch(() => {})
    agingClient.release()
  }
  const overdueHealth = await imageImports
    .readCommerceProductImageImportQueueHealthInPostgres()
  assert.equal(overdueHealth.queuedCount, 1)
  assert.equal(overdueHealth.overdueCount, 1)
  await completeClaim(
    await claimOne(beta.organizationId, 'overdue-image-worker'),
    FOUR_BY_FIVE_WEBP,
    'image/webp',
  )

  const heartbeatStart = new Date(Date.now() - 1_000).toISOString()
  await assert.rejects(
    imageImports.recordCommerceProductImageImportWorkerHeartbeatInPostgres({
      phase: 'starting',
      checkedAt: new Date(Date.now() + 2 * 60_000).toISOString(),
    }),
    /heartbeat cannot be future-dated/u,
  )
  const startingHeartbeat = await imageImports
    .recordCommerceProductImageImportWorkerHeartbeatInPostgres({
      phase: 'starting',
      checkedAt: heartbeatStart,
    })
  assert.equal(startingHeartbeat.phase, 'starting')
  const staleHeartbeat = await imageImports
    .recordCommerceProductImageImportWorkerHeartbeatInPostgres({
      phase: 'degraded',
      checkedAt: new Date(Date.now() - 2_000).toISOString(),
    })
  assert.equal(staleHeartbeat.phase, 'starting')
  assert.equal(staleHeartbeat.checkedAt, startingHeartbeat.checkedAt)
  const completedHeartbeat = await imageImports
    .recordCommerceProductImageImportWorkerHeartbeatInPostgres({
      phase: 'completed',
    })
  const finalHealth = await imageImports
    .readCommerceProductImageImportQueueHealthInPostgres()
  assert.equal(finalHealth.deadCount, 3)
  assert.equal(finalHealth.staleLeaseCount, 0)
  assert.equal(finalHealth.overdueCount, 0)
  assert.equal(finalHealth.heartbeat.phase, 'completed')
  assert.equal(finalHealth.heartbeat.checkedAt, completedHeartbeat.checkedAt)

  const mismatchedMembershipEvidence = await pool.query(
    `WITH reconstructed AS (
       SELECT
         observation_set.id,
         observation_set.image_identity_count,
         observation_set.image_identity_set_sha256,
         count(membership.image_identity_sha256)::integer AS member_count,
         encode(
           digest(
             convert_to(
               concat_ws(
                 chr(31),
                 'commerce-product-image-identity-set-v1',
                 string_agg(
                   membership.image_identity_sha256,
                   chr(31) ORDER BY membership.image_identity_sha256
                 )
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         ) AS reconstructed_sha256
       FROM operations_commerce_product_image_observation_sets observation_set
       LEFT JOIN operations_commerce_product_image_observation_set_memberships
         membership
         ON membership.organization_id = observation_set.organization_id
        AND membership.integration_account_id =
              observation_set.integration_account_id
        AND membership.observation_set_id = observation_set.id
       GROUP BY observation_set.id
     )
     SELECT id::text
     FROM reconstructed
     WHERE member_count <> image_identity_count
        OR reconstructed_sha256 <> image_identity_set_sha256`,
  )
  assert.deepEqual(mismatchedMembershipEvidence.rows, [])
  const lateMembershipCandidate = await pool.query(
    `SELECT
       observation_set.organization_id::text,
       observation_set.integration_account_id::text,
       observation_set.provider,
       observation_set.credential_generation,
       observation_set.external_product_id,
       observation_set.id::text AS observation_set_id,
       observation.image_identity_sha256,
       observation.id::text AS observation_id,
       observation.observation_revision,
       observation.locator_sha256,
       observation.source_hash
     FROM operations_commerce_product_image_observation_sets observation_set
     JOIN operations_commerce_product_image_observations observation
       ON observation.organization_id = observation_set.organization_id
      AND observation.integration_account_id =
            observation_set.integration_account_id
      AND observation.provider = observation_set.provider
      AND observation.credential_generation =
            observation_set.credential_generation
      AND observation.external_product_id = observation_set.external_product_id
      AND observation.lifecycle_state = 'active'
     WHERE observation_set.organization_id = $1::uuid
       AND observation_set.external_product_id =
             'gid://shopify/Product/600'
       AND observation_set.image_identity_count = 1
       AND NOT EXISTS (
         SELECT 1
         FROM operations_commerce_product_image_observation_set_memberships
           existing
         WHERE existing.organization_id = observation_set.organization_id
           AND existing.integration_account_id =
                 observation_set.integration_account_id
           AND existing.observation_set_id = observation_set.id
           AND existing.image_identity_sha256 =
                 observation.image_identity_sha256
       )
     ORDER BY observation_set.observed_at, observation.observation_revision
     LIMIT 1`,
    [alpha.organizationId],
  )
  assert.equal(lateMembershipCandidate.rows.length, 1)
  const lateMember = lateMembershipCandidate.rows[0]
  const lateMembershipClient = await pool.connect()
  try {
    await lateMembershipClient.query('BEGIN')
    await lateMembershipClient.query(
      `INSERT INTO
         operations_commerce_product_image_observation_set_memberships (
           organization_id, integration_account_id, provider,
           credential_generation, external_product_id, observation_set_id,
           image_identity_sha256, observation_id, observation_revision,
           locator_sha256, observation_source_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8::uuid,
           $9, $10, $11
         )`,
      [
        lateMember.organization_id,
        lateMember.integration_account_id,
        lateMember.provider,
        lateMember.credential_generation,
        lateMember.external_product_id,
        lateMember.observation_set_id,
        lateMember.image_identity_sha256,
        lateMember.observation_id,
        lateMember.observation_revision,
        lateMember.locator_sha256,
        lateMember.source_hash,
      ],
    )
    await assert.rejects(
      lateMembershipClient.query('COMMIT'),
      /membership count does not match immutable evidence/u,
    )
  } finally {
    await lateMembershipClient.query('ROLLBACK').catch(() => {})
    lateMembershipClient.release()
  }
  const immutableMembership = await pool.query(
    `SELECT organization_id::text, integration_account_id::text,
            observation_set_id::text, image_identity_sha256
     FROM operations_commerce_product_image_observation_set_memberships
     ORDER BY created_at
     LIMIT 1`,
  )
  await assert.rejects(
    pool.query(
      `UPDATE operations_commerce_product_image_observation_set_memberships
       SET locator_sha256 = $5
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND observation_set_id = $3::uuid
         AND image_identity_sha256 = $4`,
      [
        immutableMembership.rows[0].organization_id,
        immutableMembership.rows[0].integration_account_id,
        immutableMembership.rows[0].observation_set_id,
        immutableMembership.rows[0].image_identity_sha256,
        sha256('attempted-membership-mutation'),
      ],
    ),
    /observation-set memberships are immutable/u,
  )

  const immutableObservation = await pool.query(
    `SELECT id::text
     FROM operations_commerce_product_image_observations
     WHERE organization_id = $1::uuid
     ORDER BY created_at
     LIMIT 1`,
    [alpha.organizationId],
  )
  await assert.rejects(
    pool.query(
      `UPDATE operations_commerce_product_image_observations
       SET image_sequence = image_sequence + 1
       WHERE id = $1::uuid`,
      [immutableObservation.rows[0].id],
    ),
    /observations are immutable/u,
  )
  const immutableProvenance = await pool.query(
    `SELECT id::text
     FROM operations_commerce_product_image_asset_provenance
     WHERE organization_id = $1::uuid
     ORDER BY imported_at
     LIMIT 1`,
    [alpha.organizationId],
  )
  await assert.rejects(
    pool.query(
      `DELETE FROM operations_commerce_product_image_asset_provenance
       WHERE id = $1::uuid`,
      [immutableProvenance.rows[0].id],
    ),
    /provenance is immutable/u,
  )

  const evidence = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observations) AS observations,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_import_jobs) AS jobs,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_asset_provenance) AS provenance,
       (SELECT count(*)::integer
        FROM crm_product_image_assets
        WHERE source = 'provider_import') AS imported_assets,
       (SELECT count(*)::integer
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
          AND column_name = 'provider_write_count') AS provider_write_columns`,
    [[
      'operations_commerce_product_image_observations',
      'operations_commerce_product_image_import_jobs',
      'operations_commerce_product_image_asset_provenance',
    ]],
  )
  assert.ok(evidence.rows[0].observations >= 10)
  assert.equal(
    evidence.rows[0].jobs,
    evidence.rows[0].observations + 5,
    'only exact fan-out narrowing, exhausted remap, two remap-after-success paths, and explicit dead retry add job generations',
  )
  assert.ok(evidence.rows[0].provenance >= 7)
  assert.ok(evidence.rows[0].imported_assets >= 6)
  assert.equal(evidence.rows[0].provider_write_columns, 0)
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-commerce-images-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_images',
      '-e', 'POSTGRES_DB=clawpilot_images',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = `postgresql://postgres:clawpilot_images@127.0.0.1:${port}/clawpilot_images`
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
    await verifyImports(runtimePool)
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
  console.log('Commerce product image import PostgreSQL acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
