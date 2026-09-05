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
    clearInterval,
    console,
    exports: loaded.exports,
    module: loaded,
    process,
    setInterval,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      if (specifier === '@/lib/integrations/commerceReadRuntime') {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceReadRuntime.ts',
        )
      }
      if (specifier === '@/lib/operations/commerceStoreSync') {
        return loadTypeScriptModule(
          'app_src/lib/operations/commerceStoreSync.ts',
        )
      }
      if (specifier === '@/lib/persistence/commerceStoreSync') {
        return loadTypeScriptModule(
          'app_src/lib/persistence/commerceStoreSync.ts',
          mocks,
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
    files.includes(
      '0223_operations_faire_inventory_observation_polling.sql',
    ),
    'Faire inventory polling migration is missing',
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

const persistenceMock = {
  acquireTransactionAdvisoryLock: (client, key) => client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
    [key],
  ),
  query: (...args) => runtimePool.query(...args),
  withTransaction: withRuntimeTransaction,
}

const integrationErrors = {
  CommerceIntegrationRequestError: class CommerceIntegrationRequestError extends Error {
    constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
      super(message)
      this.status = status
      this.code = code
    }
  },
}

const polling = loadTypeScriptModule(
  'app_src/lib/persistence/faireInventoryPolling.ts',
  {
    '@/lib/auditWriter': {
      async recordAuditEvent() {},
    },
    '@/lib/integrations/commerceIntegrations': integrationErrors,
    '@/lib/persistence/postgres': persistenceMock,
  },
)

async function seedTarget(pool) {
  const organizationId = randomUUID()
  const pipelineId = randomUUID()
  const productId = randomUUID()
  const actorEmail = 'faire-inventory-postgres@episcs.com'
  await pool.query(
    `INSERT INTO app_users (email, role, status, activated_at)
     VALUES ($1, 'owner', 'active', clock_timestamp())`,
    [actorEmail],
  )
  await pool.query(
    `INSERT INTO workspace_organizations (id, name, created_by, updated_by)
     VALUES ($1::uuid, 'Faire inventory polling acceptance', $2, $2)`,
    [organizationId, actorEmail],
  )
  await pool.query(
    `UPDATE app_users
     SET organization_id = $2::uuid,
         organization_name = 'Faire inventory polling acceptance'
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
       $1::uuid, 'Faire inventory pipeline', $2, true, $3::uuid
     )`,
    [pipelineId, actorEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, reason, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shadow',
       'Faire inventory polling acceptance', $3
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
       'Faire inventory brand', 'active', 'brand_inventory_acceptance',
       1, $2, $2
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
       $1::uuid, $2::uuid, 'brand_inventory_acceptance',
       'faire_brand_token', decode('01', 'hex'),
       decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
       1, 'TEST', 'verified', clock_timestamp(), 'not_applicable', $3, $3
     )`,
    [organizationId, account.rows[0].id, actorEmail],
  )
  await pool.query(
    `INSERT INTO crm_products (
       id, pipeline_id, source_key, name, sku, source_hash,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'faire-inventory-product',
       'Faire Inventory Product', 'FAIRE-INV-1', $3, $4, $4
     )`,
    [productId, pipelineId, sha('faire-inventory-product'), actorEmail],
  )
  const mapping = await pool.query(
    `INSERT INTO operations_product_mappings (
       organization_id, integration_account_id, pipeline_id, product_id,
       channel_sku, external_product_id, external_variant_id,
       mapping_method, mapping_source_revision, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FAIRE-INV-1',
       'product_inventory_1', 'variant_inventory_1', 'exact_variant',
       'faire-inventory-mapping-v1', true, $5
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
       $1::uuid, $2::uuid, $3::uuid, 'faire', 'product_inventory_1',
       'variant_inventory_1', $4::uuid, $5::uuid,
       'Faire Inventory Product', 'Default', 'FAIRE-INV-1',
       'PUBLISHED', 'active', true,
       '2026-08-02T12:00:00.000Z'::timestamptz,
       'faire-inventory-channel-v1', $6, $7, $7
     ) RETURNING id::text, row_version::text, source_hash`,
    [
      organizationId,
      account.rows[0].id,
      pipelineId,
      productId,
      mapping.rows[0].id,
      sha('faire-inventory-channel'),
      actorEmail,
    ],
  )
  for (let index = 2; index <= 10; index += 1) {
    const additionalProductId = randomUUID()
    const sku = `FAIRE-INV-${index}`
    const externalProductId = `product_inventory_${index}`
    const externalVariantId = `variant_inventory_${index}`
    await pool.query(
      `INSERT INTO crm_products (
         id, pipeline_id, source_key, name, sku, source_hash,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $7
       )`,
      [
        additionalProductId,
        pipelineId,
        `faire-inventory-product-${index}`,
        `Faire Inventory Product ${index}`,
        sku,
        sha(`faire-inventory-product-${index}`),
        actorEmail,
      ],
    )
    const additionalMapping = await pool.query(
      `INSERT INTO operations_product_mappings (
         organization_id, integration_account_id, pipeline_id, product_id,
         channel_sku, external_product_id, external_variant_id,
         mapping_method, mapping_source_revision, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
         'exact_variant', $8, true, $9
       ) RETURNING id::text`,
      [
        organizationId,
        account.rows[0].id,
        pipelineId,
        additionalProductId,
        sku,
        externalProductId,
        externalVariantId,
        `faire-inventory-mapping-v${index}`,
        actorEmail,
      ],
    )
    await pool.query(
      `INSERT INTO operations_product_channel_states (
         organization_id, integration_account_id, pipeline_id, provider,
         external_product_id, external_variant_id, product_id,
         product_mapping_id, provider_product_title,
         provider_variant_title, provider_sku, provider_status_raw,
         normalized_status, provider_active, observed_at, source_revision,
         source_hash, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire', $4, $5, $6::uuid,
         $7::uuid, $8, 'Default', $9, 'PUBLISHED', 'active', true,
         '2026-08-02T12:00:00.000Z'::timestamptz, $10, $11, $12, $12
       )`,
      [
        organizationId,
        account.rows[0].id,
        pipelineId,
        externalProductId,
        externalVariantId,
        additionalProductId,
        additionalMapping.rows[0].id,
        `Faire Inventory Product ${index}`,
        sku,
        `faire-inventory-channel-v${index}`,
        sha(`faire-inventory-channel-${index}`),
        actorEmail,
      ],
    )
  }
  return {
    organizationId,
    pipelineId,
    productId,
    actorEmail,
    accountId: account.rows[0].id,
    accountGlobalId: account.rows[0].global_id,
    mappingId: mapping.rows[0].id,
    channelStateId: channel.rows[0].id,
    channelStateRowVersion: channel.rows[0].row_version,
    channelStateSourceHash: channel.rows[0].source_hash,
  }
}

async function verifyPolling(pool) {
  const targetData = await seedTarget(pool)
  const policyBefore = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_product_intake_policies
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [targetData.organizationId, targetData.accountId],
  )
  assert.equal(policyBefore.rows[0].count, 0)
  const inventoryBefore = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM operations_inventory_positions
        WHERE organization_id = $1::uuid) AS positions,
       (SELECT count(*)::integer FROM operations_inventory_ledger
        WHERE organization_id = $1::uuid) AS ledger`,
    [targetData.organizationId],
  )

  const queued = await polling.queueAutomaticFaireInventoryPollsInPostgres()
  assert.equal(queued.queued, 1)
  assert.equal(queued.cancelled, 0)
  let [target] = await polling.claimFaireInventoryPollJobsInPostgres({
    limit: 1,
    workerId: 'faire-postgres-worker',
  })
  assert.ok(target)
  assert.equal(target.accountGlobalId, targetData.accountGlobalId)
  assert.equal(target.credentialVersion, 1)
  assert.equal(target.activationRevision, 1)
  assert.equal(target.recoveredLease, false)
  let releaseInFlightRead
  let markInFlightReadStarted
  const inFlightReadStarted = new Promise((resolvePromise) => {
    markInFlightReadStarted = resolvePromise
  })
  const releaseRead = new Promise((resolvePromise) => {
    releaseInFlightRead = resolvePromise
  })
  const inFlightRead = polling.withFaireInventoryPollProviderReadFenceInPostgres({
    target,
    async read() {
      markInFlightReadStarted()
      await releaseRead
      return 'provider-read-finished-before-pause'
    },
  })
  await inFlightReadStarted
  const pauseClient = await pool.connect()
  const pauseCommitted = pauseClient.query(
    `UPDATE operations_commerce_store_sync_controls
     SET desired_state = 'paused',
         explicit_choice = true,
         revision = revision + 1,
         reason = 'Pause serialization acceptance',
         updated_by = $3,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [targetData.organizationId, targetData.accountId, targetData.actorEmail],
  ).finally(() => pauseClient.release())
  assert.equal(
    await Promise.race([
      pauseCommitted.then(() => 'committed'),
      new Promise((resolvePromise) => {
        setTimeout(() => resolvePromise('waiting-for-read'), 100)
      }),
    ]),
    'committed',
  )
  const draining = await pool.query(
    `SELECT operations_commerce_store_sync_effective_reason(
       $1::uuid,
       $2::uuid
     ) AS reason`,
    [targetData.organizationId, targetData.accountId],
  )
  assert.equal(
    draining.rows[0].reason,
    'STORE_SYNC_EXPLICIT_PAUSED_DRAINING',
  )
  releaseInFlightRead()
  await assert.rejects(
    inFlightRead,
    (error) => error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST',
  )
  await pauseCommitted
  const paused = await pool.query(
    `SELECT operations_commerce_store_sync_effective_reason(
       $1::uuid,
       $2::uuid
     ) AS reason`,
    [targetData.organizationId, targetData.accountId],
  )
  assert.equal(paused.rows[0].reason, 'STORE_SYNC_EXPLICIT_PAUSED')

  let postPauseReadCalls = 0
  await assert.rejects(
    polling.withFaireInventoryPollProviderReadFenceInPostgres({
      target,
      async read() {
        postPauseReadCalls += 1
        return 'must-not-run'
      },
    }),
    (error) => error?.code === 'FAIRE_INVENTORY_POLL_FENCE_CHANGED',
  )
  assert.equal(postPauseReadCalls, 0)
  const parked = await polling
    .parkFaireInventoryPollForStoreSyncPauseInPostgres({ target })
  assert.equal(parked.parked, true)
  const pausedJobBefore = (
    await pool.query(
      `SELECT status, attempt_count, selector_after, locked_at, locked_by,
              lock_token, lease_expires_at, available_at, updated_at
       FROM operations_faire_inventory_poll_jobs
       WHERE id = $1::uuid`,
      [target.id],
    )
  ).rows[0]
  for (let pausedCycle = 0; pausedCycle < 2; pausedCycle += 1) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(
        await polling.queueAutomaticFaireInventoryPollsInPostgres(),
      )),
      { queued: 0, cancelled: 0 },
    )
  }
  const pausedJobAfter = (
    await pool.query(
      `SELECT status, attempt_count, selector_after, locked_at, locked_by,
              lock_token, lease_expires_at, available_at, updated_at
       FROM operations_faire_inventory_poll_jobs
       WHERE id = $1::uuid`,
      [target.id],
    )
  ).rows[0]
  assert.deepEqual(
    pausedJobAfter,
    pausedJobBefore,
    'repeated Paused scheduler cycles must not churn retained Faire work',
  )
  await pool.query(
    `UPDATE operations_commerce_store_sync_controls
     SET desired_state = 'running',
         explicit_choice = true,
         revision = revision + 1,
         reason = 'Resume after pause serialization acceptance',
         updated_by = $3,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [targetData.organizationId, targetData.accountId, targetData.actorEmail],
  )
  const [resumedTarget] =
    await polling.claimFaireInventoryPollJobsInPostgres({
      limit: 1,
      workerId: 'faire-postgres-worker-resumed',
    })
  assert.ok(resumedTarget)
  assert.equal(resumedTarget.id, target.id)
  target = resumedTarget

  let completed = null
  const observedVariantIds = []
  // One-selector pages force a ten-page healthy sweep. This proves page
  // progression does not consume the eight-attempt retry budget.
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    const page = await polling.readFaireInventoryPollSelectorsInPostgres({
      target,
      limit: 1,
    })
    assert.equal(page.selectors.length, 1)
    observedVariantIds.push(page.selectors[0].externalVariantId)
    const observation = {
      ...page.selectors[0],
      providerRecordState: 'present',
      onHandState: 'quantity',
      onHandQuantity: 5,
      committedState: 'quantity',
      committedQuantity: 9,
      availableState: 'quantity',
      availableQuantity: -4,
      sourceHash: sha(
        `faire-inventory-observation-${page.selectors[0].externalVariantId}`,
      ),
    }
    completed = await polling.withFaireInventoryPollProviderReadFenceInPostgres({
      target,
      read: (providerReadLease) => (
        polling.completeFaireInventoryPollPageInPostgres({
          target,
          providerReadLease,
          selectors: page.selectors,
          observations: [observation],
          hasMore: page.hasMore,
          nextSelectorAfter: page.nextSelectorAfter,
          observedAt: '2026-08-02T18:00:00.000Z',
        })
      ),
    })
    if (pageIndex < 9) {
      assert.equal(page.hasMore, true)
      assert.equal(completed.continued, true)
      const retryBudget = await pool.query(
        `SELECT status, attempt_count
         FROM operations_faire_inventory_poll_jobs
         WHERE id = $1::uuid`,
        [target.id],
      )
      assert.equal(retryBudget.rows[0].status, 'pending')
      assert.equal(retryBudget.rows[0].attempt_count, 0)
      ;[target] = await polling.claimFaireInventoryPollJobsInPostgres({
        limit: 1,
        workerId: `faire-postgres-page-${pageIndex + 2}`,
      })
      assert.ok(target)
      assert.equal(target.attemptCount, 1)
    } else {
      assert.equal(page.hasMore, false)
    }
  }
  assert.equal(new Set(observedVariantIds).size, 10)
  assert.equal(completed.completed, true)
  assert.equal(completed.quantityCount, 3)
  assert.equal(completed.leaseLost, false)

  const evidence = await pool.query(
    `SELECT provider_record_state, on_hand_state,
            on_hand_quantity::text, committed_state,
            committed_quantity::text, available_state,
            available_quantity::text, authority,
            wms_projection_applied, provider_writes
     FROM operations_faire_inventory_observations
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_variant_id = 'variant_inventory_1'`,
    [targetData.organizationId, targetData.accountId],
  )
  assert.deepEqual(evidence.rows, [{
    provider_record_state: 'present',
    on_hand_state: 'quantity',
    on_hand_quantity: '5',
    committed_state: 'quantity',
    committed_quantity: '9',
    available_state: 'quantity',
    available_quantity: '-4',
    authority: 'faire_channel_listing_observation',
    wms_projection_applied: false,
    provider_writes: 0,
  }])
  await assert.rejects(
    pool.query(
      `UPDATE operations_faire_inventory_observations
       SET available_quantity = 0
       WHERE organization_id = $1::uuid`,
      [targetData.organizationId],
    ),
    /append-only/i,
  )

  const state = await polling.readFaireInventoryPollStateFromPostgres({
    organizationId: targetData.organizationId,
    accountGlobalId: targetData.accountGlobalId,
  })
  assert.equal(state.webhookSupported, false)
  assert.equal(state.wmsInventoryAuthoritySupported, false)
  assert.equal(state.wmsProjectionApplied, false)
  assert.equal(state.providerWrites, 0)
  assert.equal(state.latestJob.status, 'succeeded')
  assert.equal(state.latestJob.quantitiesObserved, 30)

  const secondQueue =
    await polling.queueAutomaticFaireInventoryPollsInPostgres()
  assert.equal(secondQueue.queued, 0)

  const dead = await pool.query(
    `INSERT INTO operations_faire_inventory_poll_jobs (
       organization_id, integration_account_id, credential_version,
       activation_revision, status, attempt_count, last_error_code,
       completed_at
     ) VALUES (
       $1::uuid, $2::uuid, 1, 1, 'dead', 1,
       'FAIRE_ACCESS_DENIED', clock_timestamp()
     ) RETURNING id::text`,
    [targetData.organizationId, targetData.accountId],
  )
  const recovery = await polling.recoverFaireInventoryPollInPostgres({
    organizationId: targetData.organizationId,
    accountGlobalId: targetData.accountGlobalId,
    failedJobId: dead.rows[0].id,
    expectedCredentialVersion: 1,
    expectedErrorCode: 'FAIRE_ACCESS_DENIED',
    reason: 'Credential access was reviewed in the Faire portal',
    actorEmail: targetData.actorEmail,
  })
  assert.equal(recovery.replayed, false)
  assert.equal(recovery.providerWrites, 0)
  assert.equal(recovery.wmsProjectionApplied, false)
  const replay = await polling.recoverFaireInventoryPollInPostgres({
    organizationId: targetData.organizationId,
    accountGlobalId: targetData.accountGlobalId,
    failedJobId: dead.rows[0].id,
    expectedCredentialVersion: 1,
    expectedErrorCode: 'FAIRE_ACCESS_DENIED',
    reason: 'Credential access was reviewed in the Faire portal',
    actorEmail: targetData.actorEmail,
  })
  assert.equal(replay.replayed, true)
  assert.equal(replay.jobId, recovery.jobId)

  const [firstLease] = await polling.claimFaireInventoryPollJobsInPostgres({
    limit: 1,
    workerId: 'faire-postgres-recovery-one',
  })
  assert.equal(firstLease.id, recovery.jobId)
  await pool.query(
    `UPDATE operations_faire_inventory_poll_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
     WHERE id = $1::uuid`,
    [firstLease.id],
  )
  const [reclaimed] = await polling.claimFaireInventoryPollJobsInPostgres({
    limit: 1,
    workerId: 'faire-postgres-recovery-two',
  })
  assert.equal(reclaimed.id, firstLease.id)
  assert.equal(reclaimed.recoveredLease, true)
  assert.equal(reclaimed.attemptCount, 2)

  const health = await polling.readFaireInventoryPollHealthFromPostgres()
  assert.equal(health.configuredAccounts, 1)
  assert.equal(health.schedulingEligibleAccounts, 1)
  assert.equal(health.webhookSupported, false)
  assert.equal(health.wmsInventoryAuthoritySupported, false)
  assert.equal(health.providerWrites, 0)
  assert.equal(health.processing, 1)
  assert.equal(health.dead, 0)

  const inventoryAfter = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM operations_inventory_positions
        WHERE organization_id = $1::uuid) AS positions,
       (SELECT count(*)::integer FROM operations_inventory_ledger
        WHERE organization_id = $1::uuid) AS ledger`,
    [targetData.organizationId],
  )
  assert.deepEqual(inventoryAfter.rows[0], inventoryBefore.rows[0])
  const policyAfter = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_product_intake_policies
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [targetData.organizationId, targetData.accountId],
  )
  assert.equal(policyAfter.rows[0].count, 0)
}

const container = `clawpilot-faire-inventory-${randomUUID()}`
let pool
try {
  command('docker', ['info'], { timeout: 30_000 })
  command('docker', [
    'run', '--rm', '-d', '--name', container,
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=clawpilot_test',
    '-p', '127.0.0.1::5432',
    'pgvector/pgvector:pg16',
  ], { timeout: 30_000 })
  const portOutput = command(
    'docker',
    ['port', container, '5432/tcp'],
    { timeout: 30_000 },
  ).trim()
  const port = portOutput.split(':').at(-1)
  assert.match(String(port), /^\d+$/)
  const databaseUrl =
    `postgresql://postgres:postgres@127.0.0.1:${port}/clawpilot_test`
  await waitForPostgres(databaseUrl)
  pool = new Pool({ connectionString: databaseUrl, max: 4 })
  runtimePool = pool
  await applyMigrations(pool)
  await verifyPolling(pool)
  console.log('Faire inventory polling Postgres tests passed')
} finally {
  runtimePool = null
  await pool?.end().catch(() => {})
  spawnSync('docker', ['stop', '-t', '1', container], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
}
