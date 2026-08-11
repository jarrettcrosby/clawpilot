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

function sha(value) {
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
    reportDiagnostics: true,
  })
  const diagnostics = (output.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(diagnostics, [])
  const loaded = { exports: {} }
  vm.runInNewContext(output.outputText, {
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
    exports: loaded.exports,
    module: loaded,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      if (specifier === '@/lib/integrations/commerceReadRuntime') {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceReadRuntime.ts',
        )
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return loaded.exports
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
  async recordAuditEvent() {},
}

const suiteCrmProjectionMock = {
  async enqueueSuiteCrmProductImageProjectionWithClient() {
    throw new Error('SuiteCRM projection is not expected before image completion')
  },
}

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
      suiteCrmProjectionMock,
  },
)
const refreshTypes = loadTypeScriptModule(
  'app_src/lib/integrations/faireProductImageRefreshTypes.ts',
)
const refreshPersistence = loadTypeScriptModule(
  'app_src/lib/persistence/faireProductImageRefresh.ts',
  {
    '@/lib/integrations/faireProductImageRefreshTypes': refreshTypes,
    '@/lib/persistence/commerceProductImageImports': imageImports,
    '@/lib/persistence/postgres': persistenceMock,
  },
)

async function seedFaireTarget(pool) {
  const organizationId = randomUUID()
  const pipelineId = randomUUID()
  const actorEmail = 'faire-image-refresh-postgres@episcs.com'
  const productId = randomUUID()
  await pool.query(
    `INSERT INTO app_users (email, role, status, activated_at)
     VALUES ($1, 'owner', 'active', clock_timestamp())`,
    [actorEmail],
  )
  await pool.query(
    `INSERT INTO workspace_organizations (id, name, created_by, updated_by)
     VALUES ($1::uuid, 'Faire image refresh acceptance', $2, $2)`,
    [organizationId, actorEmail],
  )
  await pool.query(
    `UPDATE app_users
     SET organization_id = $2::uuid,
         organization_name = 'Faire image refresh acceptance'
     WHERE email = $1`,
    [actorEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, status, is_default,
       created_by, updated_by
     ) VALUES ($1, $2::uuid, 'owner', 'active', true, $1, $1)`,
    [actorEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, is_default, workspace_organization_id
     ) VALUES (
       $1::uuid, 'Faire image refresh pipeline', $2, true, $3::uuid
     )`,
    [pipelineId, actorEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, reason, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shadow',
       'Faire image refresh acceptance', $3
     )`,
    [organizationId, pipelineId, actorEmail],
  )
  const account = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, external_account_id,
       commerce_credential_generation, created_by, updated_by
     ) VALUES (
       $1::uuid, 'faire', 'commerce', 'production',
       'AG Alchemy Faire', 'active', 'b_acceptance', 1, $2, $2
     ) RETURNING id::text, global_id`,
    [organizationId, actorEmail],
  )
  await pool.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'b_acceptance', 'faire_brand_token',
       decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
       decode(repeat('00', 16), 'hex'), 1, 'TEST', 'verified',
       clock_timestamp(), 'not_applicable', $3, $3
     )`,
    [organizationId, account.rows[0].id, actorEmail],
  )
  const product = await pool.query(
    `INSERT INTO crm_products (
       id, pipeline_id, source_key, name, sku, source_hash,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'faire-chicken-apple-10lb',
       'Chicken & Apple 10lb', 'AG-CHEWY-CA-BK', $3, $4, $4
     ) RETURNING reference_code`,
    [productId, pipelineId, sha('faire-chicken-apple-product'), actorEmail],
  )
  const mapping = await pool.query(
    `INSERT INTO operations_product_mappings (
       organization_id, integration_account_id, pipeline_id, product_id,
       channel_sku, external_product_id, external_variant_id,
       mapping_method, mapping_source_revision, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'AG-CHEWY-CA-BK',
       'p_26rmrj53zw', 'po_7yd59nrwqg', 'exact_variant',
       'faire-image-refresh-mapping-v1', true, $5
     ) RETURNING id::text`,
    [
      organizationId,
      account.rows[0].id,
      pipelineId,
      productId,
      actorEmail,
    ],
  )
  const channel = await pool.query(
    `INSERT INTO operations_product_channel_states (
       organization_id, integration_account_id, pipeline_id, provider,
       external_product_id, external_variant_id, product_id,
       product_mapping_id, provider_product_title,
       provider_variant_title, provider_sku, provider_status_raw,
       normalized_status, provider_active, observed_at, source_revision,
       source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'faire', 'p_26rmrj53zw',
       'po_7yd59nrwqg', $4::uuid, $5::uuid, 'Chicken & Apple 10lb',
       '10 lb case', 'AG-CHEWY-CA-BK', 'PUBLISHED', 'active', true,
       '2026-08-02T14:00:00.000Z'::timestamptz,
       'faire-image-refresh-channel-v1', $6, $7, $7
     ) RETURNING global_id, row_version::text`,
    [
      organizationId,
      account.rows[0].id,
      pipelineId,
      productId,
      mapping.rows[0].id,
      sha('faire-chicken-apple-channel'),
      actorEmail,
    ],
  )
  return {
    organizationId,
    pipelineId,
    actorEmail,
    productId,
    productReferenceCode: product.rows[0].reference_code,
    accountId: account.rows[0].id,
    accountGlobalId: account.rows[0].global_id,
    channelStateGlobalId: channel.rows[0].global_id,
    channelStateRowVersion: Number(channel.rows[0].row_version),
  }
}

async function verifyRefresh(pool) {
  const tenant = await seedFaireTarget(pool)
  const target = await refreshPersistence
    .readFaireProductImageRefreshTargetInPostgres({
      organizationId: tenant.organizationId,
      productId: tenant.productId,
      channelStateGlobalId: tenant.channelStateGlobalId,
    })
  assert.equal(target.productReferenceCode, tenant.productReferenceCode)
  assert.equal(target.integrationAccountGlobalId, tenant.accountGlobalId)
  assert.equal(target.externalProductId, 'p_26rmrj53zw')
  assert.equal(target.externalVariantId, 'po_7yd59nrwqg')
  assert.equal(target.providerSku, 'AG-CHEWY-CA-BK')
  assert.equal(target.channelStateRowVersion, tenant.channelStateRowVersion)
  assert.equal(target.credentialGeneration, 1)

  const result = await refreshPersistence
    .reconcileExactFaireProductImageRefreshInPostgres({
      target,
      observedAt: '2026-08-02T15:00:00.000Z',
      productSourceHash: sha('faire-targeted-image-set'),
      actorEmail: tenant.actorEmail,
      images: [{
        providerImageId: 'i_6xtuafkgqp',
        locatorSha256: sha('faire-front-locator'),
        sequence: 0,
        altText: 'Chicken & Apple 10lb',
        pixelWidth: null,
        pixelHeight: null,
        sourceHash: sha('faire-front-source'),
      }, {
        providerImageId: 'i_w2a6xa5ysh',
        locatorSha256: sha('faire-back-locator'),
        sequence: 1,
        altText: 'Chicken & Apple 10lb',
        pixelWidth: null,
        pixelHeight: null,
        sourceHash: sha('faire-back-source'),
      }],
    })
  assert.equal(result.imageSetComplete, false)
  assert.equal(result.active.length, 2)
  assert.equal(result.removed.length, 0)
  assert.deepEqual(
    Array.from(result.active, (entry) => entry.jobState),
    ['queued', 'queued'],
  )
  assert.ok(result.active.every((entry) => entry.productId === tenant.productId))

  const evidence = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observation_sets
        WHERE organization_id = $1::uuid
          AND integration_account_id = $2::uuid
          AND provider = 'faire'
          AND external_product_id = 'p_26rmrj53zw'
          AND image_set_complete = false) AS partial_sets,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observations
        WHERE organization_id = $1::uuid
          AND integration_account_id = $2::uuid
          AND provider = 'faire'
          AND external_product_id = 'p_26rmrj53zw'
          AND lifecycle_state = 'active') AS active_observations,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_observations
        WHERE organization_id = $1::uuid
          AND integration_account_id = $2::uuid
          AND lifecycle_state = 'removed') AS removed_observations,
       (SELECT count(*)::integer
        FROM operations_commerce_product_image_import_jobs job
        WHERE job.organization_id = $1::uuid
          AND job.integration_account_id = $2::uuid
          AND job.provider = 'faire'
          AND job.external_product_id = 'p_26rmrj53zw'
          AND job.product_id = $3::uuid
          AND job.state = 'queued') AS queued_jobs`,
    [tenant.organizationId, tenant.accountId, tenant.productId],
  )
  assert.deepEqual(evidence.rows[0], {
    partial_sets: 1,
    active_observations: 2,
    removed_observations: 0,
    queued_jobs: 2,
  })

  await pool.query(
    `UPDATE operations_product_channel_states
     SET row_version = row_version + 1,
         source_revision = 'faire-image-refresh-channel-v2',
         updated_by = $3
     WHERE organization_id = $1::uuid
       AND global_id = $2`,
    [tenant.organizationId, tenant.channelStateGlobalId, tenant.actorEmail],
  )
  await assert.rejects(
    refreshPersistence.reconcileExactFaireProductImageRefreshInPostgres({
      target,
      observedAt: '2026-08-02T15:01:00.000Z',
      productSourceHash: sha('stale-faire-targeted-image-set'),
      actorEmail: tenant.actorEmail,
      images: [],
    }),
    (error) => {
      assert.equal(error?.code, 'FAIRE_PRODUCT_IMAGE_REFRESH_TARGET_STALE')
      return true
    },
  )
  const afterStale = await pool.query(
    `SELECT count(*)::integer AS observations
     FROM operations_commerce_product_image_observations
     WHERE organization_id = $1::uuid`,
    [tenant.organizationId],
  )
  assert.equal(afterStale.rows[0].observations, 2)

  await assert.rejects(
    refreshPersistence.readFaireProductImageRefreshTargetInPostgres({
      organizationId: randomUUID(),
      productId: tenant.productId,
      channelStateGlobalId: tenant.channelStateGlobalId,
    }),
    (error) => {
      assert.equal(error?.code, 'FAIRE_PRODUCT_IMAGE_REFRESH_TARGET_NOT_FOUND')
      return true
    },
  )
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-faire-image-refresh-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=faire_image_refresh',
      '-e', 'POSTGRES_DB=faire_image_refresh',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = `postgresql://postgres:faire_image_refresh@127.0.0.1:${port}/faire_image_refresh`
    await waitForPostgres(databaseUrl)

    const migrationPool = new Pool({ connectionString: databaseUrl, max: 1 })
    const migrationClient = await migrationPool.connect()
    try {
      await applyMigrations(migrationClient)
    } finally {
      migrationClient.release()
      await migrationPool.end()
    }
    runtimePool = new Pool({ connectionString: databaseUrl, max: 4 })
    await verifyRefresh(runtimePool)
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
  console.log('Faire targeted Product image refresh PostgreSQL acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
