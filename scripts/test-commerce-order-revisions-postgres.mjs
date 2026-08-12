#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
const root = process.cwd()
const actorEmail = 'commerce-order-revision-postgres@clawpilot.com'

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
      await pool.end().catch(() => {})
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

function migrations() {
  return readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right))
}

async function applyMigration(client, file) {
  await client.query('BEGIN')
  try {
    await client.query(readFileSync(resolve(root, 'db/migrations', file), 'utf8'))
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw new Error(`Migration ${file} failed`, { cause: error })
  }
}

function postgresAdapter(pool) {
  return {
    query(text, values = []) {
      return pool.query(text, values)
    },
    async withTransaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const value = await fn(client)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async acquireTransactionAdvisoryLock(client, key) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      )
    },
  }
}

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: path,
    },
  ).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    RegExp,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      if (specifier === '@/lib/integrations/commerceOrderRevisionEvidence') {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceOrderRevisionEvidence.ts',
        )
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

function orderIds() {
  return {
    organization: randomUUID(),
    pipeline: randomUUID(),
    integration: randomUUID(),
    customer: randomUUID(),
    current: randomUUID(),
    missing: randomUUID(),
    stale: randomUUID(),
    shipped: randomUUID(),
  }
}

async function seedBeforeRevisionMigration(client, ids) {
  const hashes = {
    current: 'a'.repeat(64),
    missing: 'b'.repeat(64),
    stale: 'c'.repeat(64),
    shipped: 'd'.repeat(64),
  }
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [actorEmail],
    )
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, reference_code
       ) VALUES ($1, 'Order revision acceptance', 'member', 'ga0009301')`,
      [ids.organization],
    )
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, is_default, workspace_organization_id
       ) VALUES ($1, 'Order revision acceptance', $2, true, $3)`,
      [ids.pipeline, actorEmail, ids.organization],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision
       ) VALUES ($1, $2, 'shadow', 1)`,
      [ids.organization, ids.pipeline],
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation,
         created_by, updated_by
       ) VALUES (
         $1, 'gia0009301', $2, 'shopify', 'commerce', 'production',
         'Revision acceptance Shopify', 'active',
         '{"shopDomain":"revision-acceptance.myshopify.com"}'::jsonb,
         'gid://shopify/Shop/9301', 1, $3, $3
       )`,
      [ids.integration, ids.organization, actorEmail],
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1, $2, 'gid://shopify/Shop/9301', 'shopify_client_credentials',
         decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 1, '9301', 'verified', now(),
         'unverified', $3, $3
       )`,
      [ids.organization, ids.integration, actorEmail],
    )
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, source_key, identity_key, name, relationship_type,
         source_payload, source_hash, sync_status, created_by, updated_by
       ) VALUES (
         $1, $2, 'revision-customer', 'customer:revision-customer',
         'Revision customer', 'customer', '{}'::jsonb, $3, 'synced', $4, $4
       )`,
      [ids.customer, ids.pipeline, 'e'.repeat(64), actorEmail],
    )
    const orders = [
      [ids.current, 'gor0009301', '9301', 'imported', hashes.current],
      [ids.missing, 'gor0009302', '9302', 'imported', hashes.missing],
      [ids.stale, 'gor0009303', '9303', 'imported', hashes.stale],
      [ids.shipped, 'gor0009304', '9304', 'shipped', hashes.shipped],
    ]
    for (const [id, globalId, suffix, status, sourceHash] of orders) {
      await client.query(
        `INSERT INTO operations_orders (
           id, global_id, organization_id, pipeline_id, customer_id,
           integration_account_id, source_provider, external_order_id,
           order_number, status, currency, merchandise_total_minor,
           ship_to, source_payload, created_by, updated_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'shopify', $7, $8, $9,
           'USD', 1000, '{"country":"US"}'::jsonb,
           jsonb_build_object('sourceHash', $10::text), $11, $11
         )`,
        [
          id,
          globalId,
          ids.organization,
          ids.pipeline,
          ids.customer,
          ids.integration,
          `gid://shopify/Order/${suffix}`,
          `#${suffix}`,
          status,
          sourceHash,
          actorEmail,
        ],
      )
    }
  } finally {
    await client.query('SET session_replication_role = origin')
  }
  return hashes
}

function snapshot(input) {
  return {
    version: 'shopify-canonical-order-revision-v1',
    provider: 'shopify',
    accountGlobalId: 'gia0009301',
    integrationAccountId: input.claim.integrationAccountId,
    externalAccountId: 'gid://shopify/Shop/9301',
    credentialVersion: input.claim.credentialVersion,
    canonicalOrderGlobalId: input.claim.canonicalOrderGlobalId,
    canonicalOrderRowVersion: input.claim.canonicalOrderRowVersion,
    observedAt: input.observedAt,
    order: {
      externalOrderId: input.claim.externalOrderId,
      orderNumber: `#${input.claim.externalOrderId.split('/').at(-1)}`,
      sourceHash: input.sourceHash,
      sourceRevision: input.sourceRevision,
      canonicalStates: {
        lifecycle: input.lifecycle || 'open',
        payment: 'paid',
        fulfillment: input.fulfillment || 'unfulfilled',
        returns: 'none',
      },
      currency: 'USD',
      partyFingerprint: 'f'.repeat(64),
      shipToFingerprint: '0'.repeat(64),
      lines: [],
    },
  }
}

async function verifyAcceptance(databaseUrl, ids, hashes) {
  process.env.CLAWPILOT_ENV = 'development'
  process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = '1'
  delete process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_STRICT
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  const postgres = postgresAdapter(pool)
  let auditWrites = 0
  const persistence = loadTypeScriptModule(
    'app_src/lib/persistence/commerceOrderRevisions.ts',
    {
      '@/lib/integrations/commerceReadRuntime': {
        commerceReadRuntimeAvailable: () => true,
        commerceReadAccountSql: () => "account.status <> 'error'",
      },
      '@/lib/persistence/postgres': postgres,
      '@/lib/auditWriter': {
        async recordAuditEvent(_input, client) {
          assert.ok(client, 'manager disposition audit is transaction-bound')
          auditWrites += 1
        },
      },
    },
  )
  const evidence = loadTypeScriptModule(
    'app_src/lib/integrations/commerceOrderRevisionEvidence.ts',
  )
  const backfill = await pool.query(
    `SELECT order_id::text, claim_state, material_state, accepted_source_hash
     FROM operations_commerce_order_revision_targets
     WHERE organization_id = $1
     ORDER BY order_id`,
    [ids.organization],
  )
  assert.equal(backfill.rowCount, 3, 'only nonterminal provider orders backfill')
  assert.ok(backfill.rows.every((row) => (
    row.claim_state === 'pending' && row.material_state === 'current'
  )))
  assert.ok(!backfill.rows.some((row) => row.order_id === ids.shipped))

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = CASE WHEN order_id = $1 THEN now() ELSE now() + interval '1 day' END
     WHERE organization_id = $2`,
    [ids.current, ids.organization],
  )
  const [claim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify',
      workerId: 'revision-worker-one',
      limit: 1,
    })
  assert.equal(claim.canonicalOrderId, ids.current)
  const leased = await pool.query(
    `SELECT claim_state, locked_by, locked_until > now() AS lease_current
     FROM operations_commerce_order_revision_targets WHERE id = $1`,
    [claim.targetId],
  )
  assert.deepEqual(leased.rows[0], {
    claim_state: 'processing',
    locked_by: 'revision-worker-one',
    lease_current: true,
  })
  assert.equal((await persistence.claimCommerceOrderRevisionTargetsInPostgres({
    provider: 'shopify', workerId: 'revision-worker-two', limit: 1,
  })).length, 0, 'an active lease cannot be double-claimed')

  const firstSnapshot = snapshot({
    claim,
    sourceHash: hashes.current,
    sourceRevision: 'revision-1',
    observedAt: '2026-08-12T12:00:00.000Z',
  })
  const first = await persistence
    .captureCommerceOrderRevisionObservationInPostgres({
      claim,
      sourceRevision: firstSnapshot.order.sourceRevision,
      sourceHash: hashes.current,
      revisionHash: evidence.commerceOrderRevisionHash(firstSnapshot),
      normalizedSnapshot: firstSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: firstSnapshot.observedAt,
    })
  assert.equal(first.changed, false)
  assert.equal(first.providerWrites, 0)

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now() WHERE id = $1`,
    [claim.targetId],
  )
  const [repeatClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-repeat', limit: 1,
    })
  const repeatedSnapshot = snapshot({
    claim: repeatClaim,
    sourceHash: hashes.current,
    sourceRevision: 'revision-1',
    observedAt: '2026-08-12T13:00:00.000Z',
  })
  assert.equal(
    evidence.commerceOrderRevisionHash(firstSnapshot),
    evidence.commerceOrderRevisionHash(repeatedSnapshot),
  )
  const repeated = await persistence
    .captureCommerceOrderRevisionObservationInPostgres({
      claim: repeatClaim,
      sourceRevision: repeatedSnapshot.order.sourceRevision,
      sourceHash: hashes.current,
      revisionHash: evidence.commerceOrderRevisionHash(repeatedSnapshot),
      normalizedSnapshot: repeatedSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: repeatedSnapshot.observedAt,
    })
  assert.equal(repeated.changed, false)
  const unchangedCount = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_order_revision_observations
     WHERE order_id = $1`,
    [ids.current],
  )
  assert.equal(unchangedCount.rows[0].count, 1, 'unchanged repeats dedupe')

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now() WHERE id = $1`,
    [claim.targetId],
  )
  const [changedClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-changed', limit: 1,
    })
  const changedHash = '9'.repeat(64)
  const changedSnapshot = snapshot({
    claim: changedClaim,
    sourceHash: changedHash,
    sourceRevision: 'revision-2',
    observedAt: new Date().toISOString(),
    lifecycle: 'cancelled',
  })
  const changedRevisionHash = evidence.commerceOrderRevisionHash(changedSnapshot)
  const changed = await persistence
    .captureCommerceOrderRevisionObservationInPostgres({
      claim: changedClaim,
      sourceRevision: changedSnapshot.order.sourceRevision,
      sourceHash: changedHash,
      revisionHash: changedRevisionHash,
      normalizedSnapshot: changedSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: changedSnapshot.observedAt,
    })
  assert.equal(changed.materialState, 'provider_cancelled')
  const managerException = await pool.query(
    `SELECT count(*)::integer AS count, min(severity) AS severity,
            min(status) AS status
     FROM operations_exceptions
     WHERE organization_id = $1 AND order_id = $2
       AND exception_type = 'commerce_order_revision_required'`,
    [ids.organization, ids.current],
  )
  assert.deepEqual(managerException.rows[0], {
    count: 1,
    severity: 'critical',
    status: 'open',
  })
  for (const forbiddenStatus of ['resolved', 'dismissed']) {
    await assert.rejects(
      pool.query(
        `UPDATE operations_exceptions
         SET status = $3
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
           AND exception_type = 'commerce_order_revision_required'`,
        [ids.organization, ids.current, forbiddenStatus],
      ),
      /immutable disposition evidence/u,
    )
  }
  await pool.query(
    `UPDATE operations_exceptions
     SET status = 'acknowledged'
     WHERE organization_id = $1::uuid AND order_id = $2::uuid
       AND exception_type = 'commerce_order_revision_required'`,
    [ids.organization, ids.current],
  )
  await pool.query(
    `UPDATE operations_exceptions
     SET status = 'open'
     WHERE organization_id = $1::uuid AND order_id = $2::uuid
       AND exception_type = 'commerce_order_revision_required'`,
    [ids.organization, ids.current],
  )
  const gateClient = await pool.connect()
  try {
    for (const operation of [
      'plan',
      'release',
      'assign',
      'pick',
      'pack',
      'prepare_fulfillment',
      'rate',
      'select_rate',
      'label',
      'packing_slip',
      'ship',
      'export',
    ]) {
      await assert.rejects(
        persistence.assertCommerceOrderRevisionExecutionCurrent(gateClient, {
          organizationId: ids.organization,
          orderId: ids.current,
          operation,
        }),
        (error) => error.code === 'COMMERCE_ORDER_REVISION_REVIEW_REQUIRED',
      )
    }
  } finally {
    gateClient.release()
  }
  await assert.rejects(
    pool.query(
      `UPDATE operations_commerce_order_revision_observations
       SET provider_write_count = 0 WHERE order_id = $1`,
      [ids.current],
    ),
    /immutable/u,
  )
  await assert.rejects(
    persistence.captureCommerceOrderRevisionObservationInPostgres({
      claim: changedClaim,
      sourceRevision: changedSnapshot.order.sourceRevision,
      sourceHash: changedHash,
      revisionHash: changedRevisionHash,
      normalizedSnapshot: changedSnapshot,
      providerReads: 2,
      providerWrites: 1,
      observedAt: changedSnapshot.observedAt,
    }),
    /provider-write fence/u,
  )

  await pool.query(
    `DELETE FROM operations_commerce_order_revision_targets
     WHERE organization_id = $1 AND order_id = $2`,
    [ids.organization, ids.missing],
  )
  const missingClient = await pool.connect()
  try {
    await persistence.assertCommerceOrderRevisionExecutionCurrent(missingClient, {
      organizationId: ids.organization, orderId: ids.missing, operation: 'plan',
    })
    process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_STRICT = '1'
    await assert.rejects(
      persistence.assertCommerceOrderRevisionExecutionCurrent(missingClient, {
        organizationId: ids.organization, orderId: ids.missing, operation: 'plan',
      }),
      /latest provider revision/u,
    )
  } finally {
    delete process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_STRICT
    missingClient.release()
  }

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now()
     WHERE organization_id = $1 AND order_id = $2`,
    [ids.organization, ids.stale],
  )
  const [expiredLeaseClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-stale', limit: 1,
    })
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET locked_until = now() - interval '1 second'
     WHERE id = $1`,
    [expiredLeaseClaim.targetId],
  )
  const [staleClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-stale', limit: 1,
    })
  assert.equal(staleClaim.targetId, expiredLeaseClaim.targetId)
  assert.notEqual(
    staleClaim.leaseToken,
    expiredLeaseClaim.leaseToken,
    'same-worker reclaim receives a new per-claim lease token',
  )
  assert.equal(await persistence.failCommerceOrderRevisionTargetInPostgres({
    claim: expiredLeaseClaim,
    workerId: expiredLeaseClaim.workerId,
    errorCode: 'COMMERCE_ORDER_REVISION_EXPIRED_CLAIM_TEST',
  }), null, 'an expired claim cannot fail the reclaimed lease')
  const expiredSnapshot = snapshot({
    claim: expiredLeaseClaim,
    sourceHash: hashes.stale,
    sourceRevision: 'expired-lease-revision',
    observedAt: new Date().toISOString(),
  })
  await assert.rejects(
    persistence.captureCommerceOrderRevisionObservationInPostgres({
      claim: expiredLeaseClaim,
      sourceRevision: expiredSnapshot.order.sourceRevision,
      sourceHash: hashes.stale,
      revisionHash: evidence.commerceOrderRevisionHash(expiredSnapshot),
      normalizedSnapshot: expiredSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: expiredSnapshot.observedAt,
    }),
    /stale or lost/u,
  )
  const reclaimedLease = await pool.query(
    `SELECT claim_state, locked_by, lock_token::text
     FROM operations_commerce_order_revision_targets WHERE id = $1`,
    [staleClaim.targetId],
  )
  assert.deepEqual(reclaimedLease.rows[0], {
    claim_state: 'processing',
    locked_by: staleClaim.workerId,
    lock_token: staleClaim.leaseToken,
  }, 'expired capture/fail cannot mutate the same-worker reclaimed lease')
  await pool.query(
    `UPDATE operations_orders SET row_version = row_version + 1
     WHERE id = $1`,
    [ids.stale],
  )
  const staleSnapshot = snapshot({
    claim: staleClaim,
    sourceHash: hashes.stale,
    sourceRevision: 'stale-revision',
    observedAt: '2026-08-12T15:00:00.000Z',
  })
  await assert.rejects(
    persistence.captureCommerceOrderRevisionObservationInPostgres({
      claim: staleClaim,
      sourceRevision: staleSnapshot.order.sourceRevision,
      sourceHash: hashes.stale,
      revisionHash: evidence.commerceOrderRevisionHash(staleSnapshot),
      normalizedSnapshot: staleSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: staleSnapshot.observedAt,
    }),
    /stale or lost/u,
  )
  assert.equal(await persistence.failCommerceOrderRevisionTargetInPostgres({
    claim: staleClaim,
    workerId: staleClaim.workerId,
    errorCode: 'COMMERCE_ORDER_REVISION_STALE_TEST',
  }), 'failed')
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now()
     WHERE organization_id = $1 AND order_id = $2`,
    [ids.organization, ids.stale],
  )
  const [freshClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-fresh', limit: 1,
    })
  const freshSnapshot = snapshot({
    claim: freshClaim,
    sourceHash: hashes.stale,
    sourceRevision: 'current-revision',
    observedAt: new Date().toISOString(),
  })
  await persistence.captureCommerceOrderRevisionObservationInPostgres({
    claim: freshClaim,
    sourceRevision: freshSnapshot.order.sourceRevision,
    sourceHash: hashes.stale,
    revisionHash: evidence.commerceOrderRevisionHash(freshSnapshot),
    normalizedSnapshot: freshSnapshot,
    providerReads: 2,
    providerWrites: 0,
    observedAt: freshSnapshot.observedAt,
  })
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET checked_at = now() - interval '2 hours'
     WHERE organization_id = $1 AND order_id = $2`,
    [ids.organization, ids.stale],
  )
  const staleCoverageClient = await pool.connect()
  try {
    await persistence.assertCommerceOrderRevisionExecutionCurrent(
      staleCoverageClient,
      { organizationId: ids.organization, orderId: ids.stale, operation: 'plan' },
    )
    process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_STRICT = '1'
    await assert.rejects(
      persistence.assertCommerceOrderRevisionExecutionCurrent(
        staleCoverageClient,
        { organizationId: ids.organization, orderId: ids.stale, operation: 'plan' },
      ),
      /latest provider revision/u,
    )
  } finally {
    delete process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_STRICT
    staleCoverageClient.release()
  }
  const staleCoverageHealth =
    await persistence.readCommerceOrderRevisionHealthFromPostgres()
  assert.equal(staleCoverageHealth.status, 'degraded')
  assert.ok(
    staleCoverageHealth.summary.stale > 0,
    'default-shadow stale coverage must remain explicit degraded health',
  )

  await pool.query('SET session_replication_role = replica')
  try {
    await pool.query(
      `INSERT INTO operations_fulfillment_plans (
         global_id, organization_id, order_id, warehouse_id,
         version_number, status, method, promised_delivery_at
       ) VALUES (
         'gfp0009301', $1::uuid, $2::uuid, $3::uuid,
         1, 'planned', 'manual_override', now() + interval '1 day'
       )`,
      [ids.organization, ids.current, randomUUID()],
    )
  } finally {
    await pool.query('SET session_replication_role = origin')
  }
  const cancellationInput = {
    organizationId: ids.organization,
    actorEmail,
    orderGlobalId: changedClaim.canonicalOrderGlobalId,
    observationGlobalId: changed.observationGlobalId,
    expectedSourceHash: changedHash,
    expectedRevisionHash: changedRevisionHash,
    expectedRowVersion: changedClaim.canonicalOrderRowVersion,
    reason: 'Accept exact provider cancellation after warehouse-start verification',
    idempotencyKey: `provider-cancel:${changed.observationGlobalId}`,
  }
  await assert.rejects(
    persistence.cancelUnstartedCommerceOrderFromProviderRevisionInPostgres(
      cancellationInput,
    ),
    (error) => error.code === 'COMMERCE_ORDER_REVISION_CANCELLATION_STARTED',
  )
  assert.equal(auditWrites, 0, 'rejected cancellation has no audit side effect')
  await pool.query('SET session_replication_role = replica')
  try {
    await pool.query(
      `DELETE FROM operations_fulfillment_plans
       WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
      [ids.organization, ids.current],
    )
  } finally {
    await pool.query('SET session_replication_role = origin')
  }

  const cancelled = await persistence
    .cancelUnstartedCommerceOrderFromProviderRevisionInPostgres(cancellationInput)
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled)), {
    dispositionGlobalId: cancelled.dispositionGlobalId,
    orderGlobalId: changedClaim.canonicalOrderGlobalId,
    observationGlobalId: changed.observationGlobalId,
    sourceHash: changedHash,
    revisionHash: changedRevisionHash,
    previousStatus: 'imported',
    status: 'cancelled',
    previousRowVersion: changedClaim.canonicalOrderRowVersion,
    newRowVersion: changedClaim.canonicalOrderRowVersion + 1,
    replayed: false,
    providerReads: 2,
    providerWrites: 0,
  })
  assert.match(cancelled.dispositionGlobalId, /^gcod/u)
  assert.equal(auditWrites, 1)
  const replayedCancellation = await persistence
    .cancelUnstartedCommerceOrderFromProviderRevisionInPostgres(cancellationInput)
  assert.equal(replayedCancellation.replayed, true)
  assert.equal(replayedCancellation.dispositionGlobalId, cancelled.dispositionGlobalId)
  assert.equal(auditWrites, 1, 'transport retry replays without duplicate audit')
  await assert.rejects(
    persistence.cancelUnstartedCommerceOrderFromProviderRevisionInPostgres({
      ...cancellationInput,
      reason: 'A different request cannot reuse this exact transport key',
    }),
    (error) => error.code === 'COMMERCE_ORDER_REVISION_IDEMPOTENCY_CONFLICT',
  )

  const cancellationState = await pool.query(
    `SELECT
       order_row.status, order_row.row_version::integer,
       target.material_state, target.accepted_source_hash,
       exception.status AS exception_status,
       disposition.provider_write_count,
       (SELECT count(*)::integer FROM operations_domain_events event
        WHERE event.organization_id = $1::uuid
          AND event.aggregate_id = $2::uuid
          AND event.event_type = 'operations.order.cancelled_from_provider_revision') AS event_count
     FROM operations_orders order_row
     JOIN operations_commerce_order_revision_targets target
       ON target.organization_id = order_row.organization_id
      AND target.order_id = order_row.id
     JOIN operations_commerce_order_revision_dispositions disposition
       ON disposition.organization_id = order_row.organization_id
      AND disposition.order_id = order_row.id
     JOIN operations_exceptions exception
       ON exception.organization_id = order_row.organization_id
      AND exception.order_id = order_row.id
      AND exception.exception_type = 'commerce_order_revision_required'
     WHERE order_row.organization_id = $1::uuid AND order_row.id = $2::uuid`,
    [ids.organization, ids.current],
  )
  assert.deepEqual(cancellationState.rows[0], {
    status: 'cancelled',
    row_version: changedClaim.canonicalOrderRowVersion + 1,
    material_state: 'current',
    accepted_source_hash: changedHash,
    exception_status: 'resolved',
    provider_write_count: 0,
    event_count: 1,
  })
  await assert.rejects(
    pool.query(
      `UPDATE operations_commerce_order_revision_dispositions
       SET reason = reason WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
      [ids.organization, ids.current],
    ),
    /immutable/u,
  )
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now()
     WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
    [ids.organization, ids.current],
  )
  assert.equal((await persistence.claimCommerceOrderRevisionTargetsInPostgres({
    provider: 'shopify', workerId: 'terminal-order-read-fence', limit: 5,
  })).length, 0, 'cancelled canonical orders stop exact provider polling')
  const health = await persistence.readCommerceOrderRevisionHealthFromPostgres()
  assert.ok(
    !health.targets.some((row) => row.materialState === 'current' && row.count > 1),
    'terminal target is excluded from active revision health',
  )

  const retained = await pool.query(
    `SELECT count(*)::integer AS observations,
            max(provider_write_count)::integer AS provider_writes
     FROM operations_commerce_order_revision_observations`,
  )
  assert.ok(retained.rows[0].observations >= 3)
  assert.equal(retained.rows[0].provider_writes, 0)
  await pool.end()
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-order-revision-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=commerce_order_revision',
      '-e', 'POSTGRES_DB=commerce_order_revision',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:commerce_order_revision@127.0.0.1:'
      + `${port}/commerce_order_revision`
    )
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    const files = migrations()
    const revisionIndex = files.indexOf('0273_operations_commerce_order_revisions.sql')
    assert.ok(revisionIndex > 0, '0273 commerce order revision migration is missing')
    let ids
    let hashes
    try {
      for (const file of files.slice(0, revisionIndex)) {
        await applyMigration(client, file)
      }
      ids = orderIds()
      hashes = await seedBeforeRevisionMigration(client, ids)
      await applyMigration(client, files[revisionIndex])
    } finally {
      client.release()
      await pool.end()
    }
    await verifyAcceptance(databaseUrl, ids, hashes)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Commerce order revision disposable-PostgreSQL acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
