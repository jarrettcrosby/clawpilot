#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    env: { ...process.env, ...options.env },
  })
  if (result.error || result.status !== 0) {
    throw result.error || new Error(
      `${binary} ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    )
  }
  return String(result.stdout || '').trim()
}

function migrations() {
  return readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right))
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
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

async function applyMigration(client, filename) {
  const sql = readFileSync(resolve(root, 'db/migrations', filename), 'utf8')
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query(
      'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text',
    )
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES ($1, $2)`,
      [filename, createHash('sha256').update(sql).digest('hex')],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw new Error(`Migration ${filename} failed`, { cause: error })
  }
}

function loadTypeScriptModule(path, mocks = {}) {
  const source = readFileSync(resolve(root, path), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
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
    URL,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

function postgresAdapter(pool, transactionControl = {}) {
  return {
    query(text, values = []) {
      return pool.query(text, values)
    },
    async acquireTransactionAdvisoryLock(client, key) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      )
    },
    async withTransaction(work) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client)
        const beforeCommit = transactionControl.beforeCommit
        if (beforeCommit) {
          transactionControl.beforeCommit = null
          await beforeCommit()
        }
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

async function expectRejected(work, expectedCode, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${message}: expected rejection`)
  if (expectedCode) {
    assert.equal(
      error.code,
      expectedCode,
      `${message}: ${String(error.message || error)}`,
    )
  }
  return error
}

async function expectDatabaseRejected(work, pattern, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${message}: expected database rejection`)
  assert.match(String(error.message || error), pattern, message)
}

async function seed(pool) {
  const ownerEmail = `shopify-order-owner-${randomUUID()}@example.test`
  const manageOnlyAdminEmail =
    `shopify-order-manage-${randomUUID()}@example.test`
  const executeOnlyAdminEmail =
    `shopify-order-execute-${randomUUID()}@example.test`
  const qualifiedAdminEmail =
    `shopify-order-qualified-${randomUUID()}@example.test`
  await pool.query(
    `INSERT INTO app_users (email, role, status)
     VALUES
       ($1, 'owner', 'active'),
       ($2, 'admin', 'active'),
       ($3, 'admin', 'active'),
       ($4, 'admin', 'active')`,
    [
      ownerEmail,
      manageOnlyAdminEmail,
      executeOnlyAdminEmail,
      qualifiedAdminEmail,
    ],
  )
  const organization = await pool.query(
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ('Shopify order management acceptance', 'root', $1, $1)
     RETURNING id::text`,
    [ownerEmail],
  )
  const organizationId = organization.rows[0].id
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES (
       $1, $2::uuid, 'owner', '{"manageOperations":true}'::jsonb,
       'active', true, $1, $1
     )`,
    [ownerEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES
       (
         $1, $4::uuid, 'admin',
         '{"manageOperations":true,"executeWarehouse":false}'::jsonb,
         'active', false, $5, $5
       ),
       (
         $2, $4::uuid, 'admin',
         '{"manageOperations":false,"executeWarehouse":true}'::jsonb,
         'active', false, $5, $5
       ),
       (
         $3, $4::uuid, 'admin',
         '{"manageOperations":true,"executeWarehouse":true}'::jsonb,
         'active', false, $5, $5
       )`,
    [
      manageOnlyAdminEmail,
      executeOnlyAdminEmail,
      qualifiedAdminEmail,
      organizationId,
      ownerEmail,
    ],
  )
  const pipeline = await pool.query(
    `INSERT INTO pipeline_spaces (
       name, owner_email, is_default, workspace_organization_id
     ) VALUES ('Shopify order management acceptance', $1, true, $2::uuid)
     RETURNING id::text`,
    [ownerEmail, organizationId],
  )
  const pipelineId = pipeline.rows[0].id
  await pool.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, revision, reason, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shadow', 7,
       'Shopify order management PostgreSQL acceptance', $3
     )`,
    [organizationId, pipelineId, ownerEmail],
  )
  const account = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, configuration, external_account_id,
       commerce_credential_generation, created_by, updated_by
     ) VALUES (
       $1::uuid, 'shopify', 'commerce', 'sandbox',
       'AG Alchemy Shopify acceptance', 'active',
       '{"shopDomain":"ag-alchemy-order-management.myshopify.com"}'::jsonb,
       'gid://shopify/Shop/6600001', 1, $2, $2
     ) RETURNING id::text, global_id`,
    [organizationId, ownerEmail],
  )
  const accountId = account.rows[0].id
  const accountGlobalId = account.rows[0].global_id
  await pool.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'gid://shopify/Shop/6600001',
       'shopify_client_credentials', decode('01', 'hex'),
       decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex'),
       1, '0001', 'verified', now(), 'unverified', $3, $3
     )`,
    [organizationId, accountId, ownerEmail],
  )
  const customer = await pool.query(
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, identity_key, name, relationship_type,
       source_payload, source_hash, sync_status, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3, 'Order management customer', 'customer',
       '{}'::jsonb, repeat('e', 64), 'synced', $4, $4
     ) RETURNING id::text`,
    [
      pipelineId,
      `order-management-customer-${randomUUID()}`,
      `customer:order-management-${randomUUID()}`,
      ownerEmail,
    ],
  )
  const customerId = customer.rows[0].id
  const contract = await pool.query(
    `INSERT INTO operations_contracts (
       organization_id, pipeline_id, customer_id, name, status, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'Order management acceptance',
       'active', $4
     ) RETURNING id::text`,
    [organizationId, pipelineId, customerId, ownerEmail],
  )
  const contractVersion = await pool.query(
    `INSERT INTO operations_contract_versions (
       organization_id, contract_id, version_number, effective_from,
       currency, status, terms_snapshot, published_by
     ) VALUES (
       $1::uuid, $2::uuid, 1, now() - interval '1 day', 'USD',
       'published', '{}'::jsonb, $3
     ) RETURNING id::text`,
    [organizationId, contract.rows[0].id, ownerEmail],
  )
  const currentSourceHash = 'a'.repeat(64)
  const fulfilledSourceHash = 'b'.repeat(64)

  async function order(input) {
    const result = await pool.query(
      `INSERT INTO operations_orders (
         organization_id, pipeline_id, customer_id, integration_account_id,
         source_provider, external_order_id, order_number, status, currency,
         merchandise_total_minor, ship_to, source_payload, created_by,
         updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify', $5, $6,
         'imported', 'USD', 1000, '{"country":"US"}'::jsonb,
         jsonb_build_object('sourceHash', $7::text), $8, $8
       ) RETURNING id::text, global_id, row_version::text`,
      [
        organizationId,
        pipelineId,
        customerId,
        accountId,
        input.externalOrderId,
        input.orderNumber,
        input.sourceHash,
        ownerEmail,
      ],
    )
    return result.rows[0]
  }

  const current = await order({
    externalOrderId: 'gid://shopify/Order/6600002',
    orderNumber: '#6601',
    sourceHash: currentSourceHash,
  })
  const fulfilled = await order({
    externalOrderId: 'gid://shopify/Order/6600001',
    orderNumber: '#6600',
    sourceHash: fulfilledSourceHash,
  })
  const currentAcceptedProviderUpdatedAt = new Date(
    Date.now() - 60_000,
  ).toISOString()
  const currentTarget = await pool.query(
    `SELECT target.id::text
     FROM operations_commerce_order_revision_targets target
     WHERE target.organization_id = $1::uuid
       AND target.order_id = $2::uuid`,
    [organizationId, current.id],
  )
  const revisionClient = await pool.connect()
  let currentAcceptedObservationId = ''
  try {
    await revisionClient.query('SET session_replication_role = replica')
    const acceptedObservation = await revisionClient.query(
      `INSERT INTO operations_commerce_order_revision_observations (
         organization_id, integration_account_id, target_id, order_id,
         provider, credential_generation, external_order_id,
         source_revision, source_hash, revision_hash, normalized_snapshot,
         canonical_row_version, provider_read_count, provider_write_count,
         observed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify', 1, $5,
         $6, $7, repeat('d', 64), $8::jsonb, $9::bigint, 1, 0,
         $10::timestamptz
       ) RETURNING id::text`,
      [
        organizationId,
        accountId,
        currentTarget.rows[0].id,
        current.id,
        'gid://shopify/Order/6600002',
        currentAcceptedProviderUpdatedAt,
        currentSourceHash,
        JSON.stringify({
          provider: 'shopify',
          accountGlobalId,
          integrationAccountId: accountId,
          externalAccountId: 'gid://shopify/Shop/6600001',
          credentialVersion: 1,
          canonicalOrderGlobalId: current.global_id,
          canonicalOrderRowVersion: Number(current.row_version),
          order: {
            externalOrderId: 'gid://shopify/Order/6600002',
            orderNumber: '#6601',
            sourceHash: currentSourceHash,
            providerUpdatedAt: currentAcceptedProviderUpdatedAt,
          },
        }),
        Number(current.row_version),
        new Date().toISOString(),
      ],
    )
    currentAcceptedObservationId = acceptedObservation.rows[0].id
    await revisionClient.query(
      `UPDATE operations_commerce_order_revision_targets
       SET accepted_observation_id = $3::uuid,
           latest_observation_id = $3::uuid,
           latest_source_hash = $4,
           material_state = 'current',
           updated_at = now()
       WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
      [
        organizationId,
        current.id,
        acceptedObservation.rows[0].id,
        currentSourceHash,
      ],
    )
    await revisionClient.query(
      `UPDATE operations_commerce_order_revision_targets
       SET latest_source_hash = repeat('c', 64),
           material_state = 'provider_fulfilled',
           updated_at = now()
       WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
      [organizationId, fulfilled.id],
    )
  } finally {
    await revisionClient.query('SET session_replication_role = origin')
      .catch(() => undefined)
    revisionClient.release()
  }
  return {
    ownerEmail,
    manageOnlyAdminEmail,
    executeOnlyAdminEmail,
    qualifiedAdminEmail,
    organizationId,
    pipelineId,
    customerId,
    contractVersionId: contractVersion.rows[0].id,
    accountId,
    accountGlobalId,
    currentSourceHash,
    currentAcceptedProviderUpdatedAt,
    currentAcceptedObservationId,
    fulfilledSourceHash,
    current,
    fulfilled,
  }
}

function snapshot(test, providerOrderUpdatedAt = null) {
  const observedAt = new Date()
  return {
    providerOrderUpdatedAt: providerOrderUpdatedAt
      || new Date(observedAt.getTime() - 1_000).toISOString(),
    providerOrderObservedAt: observedAt.toISOString(),
    providerOrderTest: test,
  }
}

async function verify(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 60_000,
    max: 4,
  })
  const audits = []
  const transactionControl = { beforeCommit: null }
  try {
    const fixture = await seed(pool)
    // This acceptance isolates the 0283 unresolved-attempt race. The 0290
    // Shadow canonical-plan fence has its own PostgreSQL acceptance suite.
    await pool.query(
      `ALTER TABLE operations_fulfillment_plans
       DISABLE TRIGGER guard_shadow_commerce_canonical_plan_insert`,
    )
    const persistence = loadTypeScriptModule(
      'app_src/lib/persistence/shopifyOrderManagement.ts',
      {
        '@/lib/auditWriter': {
          async recordAuditEvent(event) {
            audits.push(event)
          },
        },
        '@/lib/persistence/postgres': postgresAdapter(pool, transactionControl),
      },
    )

    const adminPermissionAction = {
      type: 'add_tag',
      tag: 'clawpilot-admin-permission-check',
    }
    const adminPermissionReason =
      'Verify both admin operations and warehouse permissions are required'
    for (const [actor, suffix] of [
      [fixture.manageOnlyAdminEmail, 'manage-only'],
      [fixture.executeOnlyAdminEmail, 'execute-only'],
    ]) {
      await expectRejected(
        () => persistence.prepareShopifyOrderManagementInPostgres({
          organizationId: fixture.organizationId,
          actorEmail: actor,
          accountGlobalId: fixture.accountGlobalId,
          orderGlobalId: fixture.fulfilled.global_id,
          expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
          expectedSourceHash: fixture.fulfilledSourceHash,
          ...snapshot(false),
          action: adminPermissionAction,
          reason: adminPermissionReason,
          idempotencyKey: `shopify-order-admin-${suffix}`,
        }),
        'SHOPIFY_ORDER_MANAGEMENT_FORBIDDEN',
        `${suffix} admin must not authorize Shopify order management`,
      )
    }
    const qualifiedAdminPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.qualifiedAdminEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: adminPermissionAction,
        reason: adminPermissionReason,
        idempotencyKey: 'shopify-order-admin-qualified',
      })
    assert.equal(qualifiedAdminPrepared.authorizedRole, 'admin')
    const qualifiedAdminClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.qualifiedAdminEmail,
        authorizationGlobalId: qualifiedAdminPrepared.authorizationGlobalId,
        action: adminPermissionAction,
        reason: adminPermissionReason,
      })
    let qualifiedAdminOutcome
    await pool.query(
      `UPDATE app_user_organization_memberships
       SET status = 'disabled', updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND user_email = $2`,
      [fixture.organizationId, fixture.qualifiedAdminEmail],
    )
    try {
      qualifiedAdminOutcome = await persistence
        .recordShopifyOrderManagementOutcomeInPostgres({
          organizationId: fixture.organizationId,
          actorEmail: fixture.qualifiedAdminEmail,
          authorizationGlobalId: qualifiedAdminPrepared.authorizationGlobalId,
          providerAttemptGlobalId: qualifiedAdminClaimed.providerAttemptGlobalId,
          outcome: 'succeeded',
          evidence: { exactRead: true, tagAlreadyPresent: true },
          providerWriteCount: 0,
        })
    } finally {
      await pool.query(
        `UPDATE app_user_organization_memberships
         SET status = 'active', updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid AND user_email = $2`,
        [fixture.organizationId, fixture.qualifiedAdminEmail],
      )
    }
    assert.equal(qualifiedAdminOutcome.status, 'succeeded')

    const tagAction = { type: 'add_tag', tag: 'clawpilot-test-6600' }
    const tagReason = 'Validate an additive marker on fulfilled order 6600'
    const preparedTag = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: tagAction,
        reason: tagReason,
        idempotencyKey: 'shopify-order-tag-6600-0001',
      })
    assert.equal(preparedTag.status, 'prepared')
    assert.equal(preparedTag.providerOrderTest, false)
    assert.equal(preparedTag.action, 'add_tag')
    assert.equal(preparedTag.authorizationReason, tagReason)
    assert.ok(preparedTag.tagHash)
    assert.equal(JSON.stringify(preparedTag).includes(tagAction.tag), false)
    assert.equal(
      new Date(preparedTag.expiresAt).getTime()
        - new Date(preparedTag.preparedAt).getTime(),
      300_000,
      'authorization lifetime must be exactly five minutes',
    )

    const replayedTag = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        providerOrderUpdatedAt: new Date(
          new Date(preparedTag.providerOrderUpdatedAt).getTime() + 30_000,
        ).toISOString(),
        providerOrderObservedAt: new Date(
          new Date(preparedTag.providerOrderObservedAt).getTime() + 30_000,
        ).toISOString(),
        providerOrderTest: false,
        action: tagAction,
        reason: tagReason,
        idempotencyKey: 'shopify-order-tag-6600-0001',
      })
    assert.equal(replayedTag.authorizationGlobalId, preparedTag.authorizationGlobalId)
    assert.equal(replayedTag.replayed, true)

    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        providerOrderUpdatedAt: preparedTag.providerOrderUpdatedAt,
        providerOrderObservedAt: preparedTag.providerOrderObservedAt,
        providerOrderTest: false,
        action: tagAction,
        reason: 'A different operator reason must conflict with this key',
        idempotencyKey: 'shopify-order-tag-6600-0001',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_IDEMPOTENCY_CONFLICT',
      'same key with a different reason must conflict',
    )

    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(true),
        action: {
          type: 'set_line_quantity',
          lineItemGid: 'gid://shopify/LineItem/6600001',
          quantity: 0,
        },
        expectedLineQuantity: 1,
        reason: 'Prove a destructive edit cannot use fulfilled revision drift',
        idempotencyKey: 'shopify-order-qty-6600-blocked',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
      'destructive action must reject a non-current provider revision',
    )

    const claimedTag = await persistence.claimShopifyOrderManagementInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: preparedTag.authorizationGlobalId,
      action: tagAction,
      reason: tagReason,
    })
    assert.equal(claimedTag.status, 'processing')
    assert.ok(claimedTag.providerAttemptGlobalId)
    const durableAttempt = await pool.query(
      `SELECT attempt.dispatch_state, authz.status
       FROM operations_shopify_order_management_attempts attempt
       JOIN operations_shopify_order_management_authorizations authz
         ON authz.organization_id = attempt.organization_id
        AND authz.id = attempt.authorization_id
       WHERE attempt.global_id = $1`,
      [claimedTag.providerAttemptGlobalId],
    )
    assert.deepEqual(durableAttempt.rows[0], {
      dispatch_state: 'authorized',
      status: 'processing',
    }, 'immutable attempt and processing fence must commit before network')
    const authorizationByAttempt = await persistence
      .readShopifyOrderManagementAuthorizationByAttemptInPostgres({
        organizationId: fixture.organizationId,
        attemptGlobalId: claimedTag.providerAttemptGlobalId,
      })
    assert.equal(
      authorizationByAttempt.authorizationGlobalId,
      preparedTag.authorizationGlobalId,
      'attempt reader must resolve within the exact tenant',
    )
    const crossTenantAuthorization = await persistence
      .readShopifyOrderManagementAuthorizationByAttemptInPostgres({
        organizationId: randomUUID(),
        attemptGlobalId: claimedTag.providerAttemptGlobalId,
      })
    assert.equal(
      crossTenantAuthorization,
      null,
      'attempt reader must not cross tenant boundaries',
    )

    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: { type: 'add_tag', tag: 'blocked-during-processing' },
        reason: 'A processing write must block this second preparation',
        idempotencyKey: 'shopify-order-tag-6600-0002',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_UNRESOLVED_WRITE',
      'processing must block another order write',
    )

    const unknown = await persistence
      .recordShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: preparedTag.authorizationGlobalId,
        providerAttemptGlobalId: claimedTag.providerAttemptGlobalId,
        outcome: 'unknown',
        evidence: { jobDone: false, exactReadCompleted: false },
        providerReference: 'gid://shopify/Job/6600001',
        errorCode: 'SHOPIFY_ORDER_CANCEL_JOB_PENDING',
        providerWriteCount: 1,
      })
    assert.equal(unknown.status, 'unknown')
    assert.equal(unknown.providerWriteCount, 1)
    assert.equal(unknown.providerReference, 'gid://shopify/Job/6600001')

    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: { type: 'add_tag', tag: 'blocked-during-unknown' },
        reason: 'An unknown outcome must block this second preparation',
        idempotencyKey: 'shopify-order-tag-6600-0003',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_UNRESOLVED_WRITE',
      'unknown must block another order write',
    )

    const reconciled = await persistence
      .reconcileShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: preparedTag.authorizationGlobalId,
        providerAttemptGlobalId: claimedTag.providerAttemptGlobalId,
        resolution: 'applied',
        evidence: { exactRead: true, tagObserved: true },
        providerReference: fixture.fulfilled.global_id,
        providerWriteCount: null,
      })
    assert.equal(reconciled.status, 'reconciled')
    assert.equal(reconciled.reconciliationResolution, 'applied')
    assert.equal(
      reconciled.providerWriteCount,
      1,
      'reconciliation must preserve a known original provider write count',
    )

    const unknownCountAction = {
      type: 'add_tag',
      tag: 'clawpilot-unknown-write-count',
    }
    const unknownCountReason =
      'Prove an unknown transport count remains unknown after reconciliation'
    const unknownCountPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: unknownCountAction,
        reason: unknownCountReason,
        idempotencyKey: 'shopify-order-tag-6600-unknown-count',
      })
    const unknownCountClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: unknownCountPrepared.authorizationGlobalId,
        action: unknownCountAction,
        reason: unknownCountReason,
      })
    const unknownCountOutcome = await persistence
      .recordShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: unknownCountPrepared.authorizationGlobalId,
        providerAttemptGlobalId: unknownCountClaimed.providerAttemptGlobalId,
        outcome: 'unknown',
        evidence: { transportEndedWithoutResponse: true },
        errorCode: 'SHOPIFY_ORDER_TRANSPORT_OUTCOME_UNKNOWN',
        providerWriteCount: null,
      })
    assert.equal(unknownCountOutcome.providerWriteCount, null)
    const reconciledUnknownCount = await persistence
      .reconcileShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: unknownCountPrepared.authorizationGlobalId,
        providerAttemptGlobalId: unknownCountClaimed.providerAttemptGlobalId,
        resolution: 'not_applied',
        evidence: { exactRead: true, tagAbsent: true },
        providerWriteCount: null,
      })
    assert.equal(reconciledUnknownCount.status, 'reconciled')
    assert.equal(reconciledUnknownCount.providerWriteCount, null)

    const alreadyPresentAction = {
      type: 'add_tag',
      tag: 'clawpilot-already-present',
    }
    const alreadyPresentReason =
      'Record a successful no-op when the exact tag is already present'
    const alreadyPresentPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: alreadyPresentAction,
        reason: alreadyPresentReason,
        idempotencyKey: 'shopify-order-tag-6600-already-present',
      })
    const alreadyPresentClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: alreadyPresentPrepared.authorizationGlobalId,
        action: alreadyPresentAction,
        reason: alreadyPresentReason,
      })
    const alreadyPresentOutcome = await persistence
      .recordShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: alreadyPresentPrepared.authorizationGlobalId,
        providerAttemptGlobalId: alreadyPresentClaimed.providerAttemptGlobalId,
        outcome: 'succeeded',
        evidence: { exactRead: true, tagAlreadyPresent: true },
        providerReference: fixture.fulfilled.global_id,
        providerWriteCount: 0,
      })
    assert.equal(alreadyPresentOutcome.status, 'succeeded')
    assert.equal(
      alreadyPresentOutcome.providerWriteCount,
      0,
      'an already-satisfied additive intent is a truthful zero-write success',
    )

    const recoveryAction = {
      type: 'add_tag',
      tag: 'clawpilot-processing-lease-recovery',
    }
    const recoveryReason =
      'Recover a crashed command to unknown without retrying Shopify'
    const recoveryPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: recoveryAction,
        reason: recoveryReason,
        idempotencyKey: 'shopify-order-tag-6600-stale-recovery',
      })
    const recoveryClaimed = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        action: recoveryAction,
        reason: recoveryReason,
      })
    assert.equal(
      new Date(recoveryClaimed.processingLeaseExpiresAt).getTime()
        - new Date(recoveryClaimed.claimedAt).getTime(),
      300_000,
      'processing lease must be exactly five minutes',
    )
    const liveRecovery = await persistence
      .recoverStaleShopifyOrderManagementAttemptInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: recoveryClaimed.providerAttemptGlobalId,
      })
    assert.equal(liveRecovery.recovered, false)
    assert.equal(liveRecovery.authorization.status, 'processing')
    const liveRecoveryOutcome = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_shopify_order_management_outcomes outcome
       WHERE outcome.organization_id = $1::uuid
         AND outcome.authorization_id = (
           SELECT authz.id
           FROM operations_shopify_order_management_authorizations authz
           WHERE authz.organization_id = $1::uuid
             AND authz.global_id = $2
         )`,
      [fixture.organizationId, recoveryPrepared.authorizationGlobalId],
    )
    assert.equal(
      liveRecoveryOutcome.rows[0].count,
      0,
      'a live processing lease must not be stolen or receive an outcome',
    )
    await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_shopify_order_management_outcomes (
           organization_id, authorization_id, provider_attempt_id,
           outcome_state, reconciliation_resolution, provider_write_count,
           provider_reference, evidence_hash, error_code, recorded_by
         )
         SELECT authz.organization_id, authz.id, attempt.id,
                'unknown', NULL, NULL, NULL, repeat('d', 64),
                'SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED', $4
         FROM operations_shopify_order_management_authorizations authz
         JOIN operations_shopify_order_management_attempts attempt
           ON attempt.organization_id = authz.organization_id
          AND attempt.authorization_id = authz.id
         WHERE authz.organization_id = $1::uuid
           AND authz.global_id = $2
           AND attempt.global_id = $3`,
        [
          fixture.organizationId,
          recoveryPrepared.authorizationGlobalId,
          recoveryClaimed.providerAttemptGlobalId,
          fixture.ownerEmail,
        ],
      ),
      /processing lease is still active/i,
      'database must reject recovery while the exact processing lease is live',
    )
    const recoveryWarehouse = await pool.query(
      `INSERT INTO operations_warehouses (
         organization_id, code, name, created_by, updated_by
       ) VALUES ($1::uuid, $2, 'Recovery race warehouse', $3, $3)
       RETURNING id::text`,
      [
        fixture.organizationId,
        `REC-${randomUUID().slice(0, 8)}`,
        fixture.ownerEmail,
      ],
    )
    await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id, method, solver_status,
           promised_delivery_at, explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'manual_override', 'accepted',
           now() + interval '1 day', '{}'::jsonb, $4
         )`,
        [
          fixture.organizationId,
          fixture.fulfilled.id,
          recoveryWarehouse.rows[0].id,
          fixture.ownerEmail,
        ],
      ),
      /attempt blocks downstream planning/i,
      'processing attempt must block a downstream plan insert after claim',
    )
    await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_billable_events (
           organization_id, pipeline_id, customer_id, order_id,
           contract_version_id, event_type, amount_minor, source_global_id,
           idempotency_key
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'order', 0,
           $6, $7
         )`,
        [
          fixture.organizationId,
          fixture.pipelineId,
          fixture.customerId,
          fixture.fulfilled.id,
          fixture.contractVersionId,
          fixture.fulfilled.global_id,
          `blocked-billable-${randomUUID()}`,
        ],
      ),
      /attempt blocks downstream planning/i,
      'processing attempt must block the direct billable-event root',
    )
    await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_sandbox_commerce_e2e_authorizations (
           organization_id, order_id, external_order_id,
           confirmation_statement_version, confirmation_hash, reason,
           authorized_by, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'sandbox-commerce-e2e-v1',
           repeat('e', 64), $4, $5, now() + interval '1 hour'
         )`,
        [
          fixture.organizationId,
          fixture.fulfilled.id,
          'gid://shopify/Order/6600001',
          'Block direct sandbox authority while Shopify outcome is unresolved',
          fixture.ownerEmail,
        ],
      ),
      /attempt blocks downstream planning/i,
      'processing attempt must block the direct sandbox E2E authority root',
    )
    await expectDatabaseRejected(
      () => pool.query(
        `UPDATE operations_orders
         SET archived_at = clock_timestamp()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [fixture.organizationId, fixture.fulfilled.id],
      ),
      /attempt blocks downstream planning/i,
      'processing attempt must block a local order lifecycle update',
    )
    await expectRejected(
      () => persistence.recoverStaleShopifyOrderManagementAttemptInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: alreadyPresentClaimed.providerAttemptGlobalId,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_NOT_FOUND',
      'recovery must reject an attempt from a different authorization lineage',
    )
    await expectRejected(
      () => persistence.recoverStaleShopifyOrderManagementAttemptInPostgres({
        organizationId: randomUUID(),
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: recoveryClaimed.providerAttemptGlobalId,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_FORBIDDEN',
      'recovery must not cross tenant boundaries',
    )

    const agingClient = await pool.connect()
    try {
      await agingClient.query('SET session_replication_role = replica')
      const agedAttempt = await agingClient.query(
        `WITH aged AS (
           SELECT clock_timestamp() - interval '6 minutes' AS claimed_at
         )
         UPDATE operations_shopify_order_management_attempts attempt
         SET claimed_at = aged.claimed_at,
             processing_lease_expires_at =
               aged.claimed_at + interval '5 minutes'
         FROM aged
         WHERE attempt.organization_id = $1::uuid
           AND attempt.global_id = $2
         RETURNING attempt.id::text, attempt.claimed_at`,
        [fixture.organizationId, recoveryClaimed.providerAttemptGlobalId],
      )
      await agingClient.query(
        `UPDATE operations_shopify_order_management_authorizations authz
         SET processing_at = $3::timestamptz,
             updated_at = $3::timestamptz
         WHERE authz.organization_id = $1::uuid
           AND authz.global_id = $2`,
        [
          fixture.organizationId,
          recoveryPrepared.authorizationGlobalId,
          agedAttempt.rows[0].claimed_at,
        ],
      )
    } finally {
      await agingClient.query('SET session_replication_role = origin')
        .catch(() => undefined)
      agingClient.release()
    }
    const staleHealth = await persistence
      .readShopifyOrderManagementHealthFromPostgres()
    assert.ok(staleHealth.processing >= 1)
    assert.ok(staleHealth.staleProcessing >= 1)
    const concurrentRecovery = await Promise.all([
      persistence.recoverStaleShopifyOrderManagementAttemptInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.qualifiedAdminEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: recoveryClaimed.providerAttemptGlobalId,
      }),
      persistence.recoverStaleShopifyOrderManagementAttemptInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.qualifiedAdminEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: recoveryClaimed.providerAttemptGlobalId,
      }),
    ])
    assert.deepEqual(
      concurrentRecovery.map((entry) => entry.recovered).sort(),
      [false, true],
      'concurrent stale recovery must serialize to one immutable outcome',
    )
    for (const entry of concurrentRecovery) {
      assert.equal(entry.authorization.status, 'unknown')
      assert.equal(entry.authorization.providerWriteCount, null)
      assert.equal(
        entry.authorization.errorCode,
        'SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED',
      )
    }
    const recoveredOutcome = await pool.query(
      `SELECT outcome.outcome_state, outcome.provider_write_count,
              outcome.provider_reference, outcome.error_code
       FROM operations_shopify_order_management_outcomes outcome
       JOIN operations_shopify_order_management_authorizations authz
         ON authz.organization_id = outcome.organization_id
        AND authz.id = outcome.authorization_id
       WHERE authz.organization_id = $1::uuid
         AND authz.global_id = $2`,
      [fixture.organizationId, recoveryPrepared.authorizationGlobalId],
    )
    assert.deepEqual(recoveredOutcome.rows, [{
      outcome_state: 'unknown',
      provider_write_count: null,
      provider_reference: null,
      error_code: 'SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED',
    }], 'stale recovery must retain redacted unknown evidence with no invented count')
    await expectDatabaseRejected(
      () => pool.query(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id, method, solver_status,
           promised_delivery_at, explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'manual_override', 'accepted',
           now() + interval '1 day', '{}'::jsonb, $4
         )`,
        [
          fixture.organizationId,
          fixture.fulfilled.id,
          recoveryWarehouse.rows[0].id,
          fixture.ownerEmail,
        ],
      ),
      /attempt blocks downstream planning/i,
      'unknown attempt must retain the downstream planning fence',
    )
    const recoveredReconciliation = await persistence
      .reconcileShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.qualifiedAdminEmail,
        authorizationGlobalId: recoveryPrepared.authorizationGlobalId,
        providerAttemptGlobalId: recoveryClaimed.providerAttemptGlobalId,
        resolution: 'not_applied',
        evidence: { exactRead: true, tagAbsent: true },
        providerWriteCount: null,
      })
    assert.equal(recoveredReconciliation.status, 'reconciled')
    assert.equal(recoveredReconciliation.providerWriteCount, null)
    assert.ok(audits.some((event) => (
      event.eventType === 'operations.shopify_order_management.reconciled'
      && event.aggregateId === recoveryPrepared.authorizationGlobalId
      && event.payload.authorizedBy === fixture.ownerEmail
      && event.payload.reconciledBy === fixture.qualifiedAdminEmail
    )), 'qualified failover reconciliation must retain both actor identities')

    const claimWinsAction = {
      type: 'add_tag',
      tag: 'clawpilot-claim-wins-race',
    }
    const claimWinsReason =
      'Prove a committed claim makes a waiting downstream plan reject'
    const claimWinsPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.fulfilled.global_id,
        expectedOrderRowVersion: Number(fixture.fulfilled.row_version),
        expectedSourceHash: fixture.fulfilledSourceHash,
        ...snapshot(false),
        action: claimWinsAction,
        reason: claimWinsReason,
        idempotencyKey: 'shopify-order-tag-6600-claim-wins-race',
      })
    let claimTransitionReached
    const claimTransition = new Promise((resolvePromise) => {
      claimTransitionReached = resolvePromise
    })
    let releaseClaimCommit
    const claimCommitRelease = new Promise((resolvePromise) => {
      releaseClaimCommit = resolvePromise
    })
    transactionControl.beforeCommit = async () => {
      claimTransitionReached()
      await claimCommitRelease
    }
    const claimWinsPromise = persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: claimWinsPrepared.authorizationGlobalId,
        action: claimWinsAction,
        reason: claimWinsReason,
      })
    await claimTransition
    let waitingPlanSettled = false
    const waitingPlan = pool.query(
      `INSERT INTO operations_fulfillment_plans (
         organization_id, order_id, warehouse_id, method, solver_status,
         promised_delivery_at, explanation, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'manual_override', 'accepted',
         now() + interval '1 day', '{}'::jsonb, $4
       )`,
      [
        fixture.organizationId,
        fixture.fulfilled.id,
        recoveryWarehouse.rows[0].id,
        fixture.ownerEmail,
      ],
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    ).finally(() => { waitingPlanSettled = true })
    let waitingBillableSettled = false
    const waitingBillable = pool.query(
      `INSERT INTO operations_billable_events (
         organization_id, pipeline_id, customer_id, order_id,
         contract_version_id, event_type, amount_minor, source_global_id,
         idempotency_key
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'order', 0,
         $6, $7
       )`,
      [
        fixture.organizationId,
        fixture.pipelineId,
        fixture.customerId,
        fixture.fulfilled.id,
        fixture.contractVersionId,
        fixture.fulfilled.global_id,
        `claim-wins-billable-${randomUUID()}`,
      ],
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    ).finally(() => { waitingBillableSettled = true })
    let waitingSandboxSettled = false
    const waitingSandbox = pool.query(
      `INSERT INTO operations_sandbox_commerce_e2e_authorizations (
         organization_id, order_id, external_order_id,
         confirmation_statement_version, confirmation_hash, reason,
         authorized_by, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'sandbox-commerce-e2e-v1',
         repeat('f', 64), $4, $5, now() + interval '1 hour'
       )`,
      [
        fixture.organizationId,
        fixture.fulfilled.id,
        'gid://shopify/Order/6600001',
        'Claim must win before direct sandbox authority materializes',
        fixture.ownerEmail,
      ],
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    ).finally(() => { waitingSandboxSettled = true })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    assert.equal(
      waitingPlanSettled,
      false,
      'downstream insert must wait on the uncommitted processing transition',
    )
    assert.equal(waitingBillableSettled, false)
    assert.equal(waitingSandboxSettled, false)
    releaseClaimCommit()
    const claimWinsClaimed = await claimWinsPromise
    const waitingPlanResult = await waitingPlan
    const waitingBillableResult = await waitingBillable
    const waitingSandboxResult = await waitingSandbox
    assert.match(
      String(waitingPlanResult.error?.message || waitingPlanResult.error),
      /attempt blocks downstream planning/i,
      'claim winner must make the waiting downstream insert reject',
    )
    assert.match(
      String(waitingBillableResult.error?.message || waitingBillableResult.error),
      /attempt blocks downstream planning/i,
      'claim winner must reject the waiting direct billable-event root',
    )
    assert.match(
      String(waitingSandboxResult.error?.message || waitingSandboxResult.error),
      /attempt blocks downstream planning/i,
      'claim winner must reject the waiting direct sandbox-authority root',
    )
    const claimWinsDownstream = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_fulfillment_plans plan
       WHERE plan.organization_id = $1::uuid AND plan.order_id = $2::uuid`,
      [fixture.organizationId, fixture.fulfilled.id],
    )
    assert.equal(claimWinsDownstream.rows[0].count, 0)
    await persistence.recordShopifyOrderManagementOutcomeInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.ownerEmail,
      authorizationGlobalId: claimWinsPrepared.authorizationGlobalId,
      providerAttemptGlobalId: claimWinsClaimed.providerAttemptGlobalId,
      outcome: 'succeeded',
      evidence: { exactRead: true, tagAlreadyPresent: true },
      providerWriteCount: 0,
    })

    const target = await persistence.readShopifyOrderManagementTargetInPostgres({
      organizationId: fixture.organizationId,
      orderGlobalId: fixture.fulfilled.global_id,
    })
    assert.equal(target.accountGlobalId, fixture.accountGlobalId)
    assert.equal(target.materialState, 'provider_fulfilled')
    assert.equal(target.latestSourceHash, 'c'.repeat(64))
    assert.equal(target.zeroDownstream, true)
    assert.equal(target.latestOpenAuthorization, null)

    const quantityAction = {
      type: 'set_line_quantity',
      lineItemGid: 'gid://shopify/LineItem/6600002',
      quantity: 0,
      staffNote: 'ClawPilot bounded quantity test',
    }
    const quantityReason = 'Exercise a bounded three-mutation line quantity edit'
    await expectRejected(
      () => persistence.prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.current.global_id,
        expectedOrderRowVersion: Number(fixture.current.row_version),
        expectedSourceHash: fixture.currentSourceHash,
        ...snapshot(true),
        action: quantityAction,
        expectedLineQuantity: 2,
        reason: 'Reject a live timestamp that differs from accepted evidence',
        idempotencyKey: 'shopify-order-qty-6601-updated-at-mismatch',
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
      'destructive action must match the accepted observation provider timestamp',
    )
    const missingAcceptedClient = await pool.connect()
    try {
      await missingAcceptedClient.query('SET session_replication_role = replica')
      await missingAcceptedClient.query(
        `UPDATE operations_commerce_order_revision_targets
         SET accepted_observation_id = NULL
         WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
        [fixture.organizationId, fixture.current.id],
      )
    } finally {
      await missingAcceptedClient.query('SET session_replication_role = origin')
        .catch(() => undefined)
      missingAcceptedClient.release()
    }
    try {
      await expectRejected(
        () => persistence.prepareShopifyOrderManagementInPostgres({
          organizationId: fixture.organizationId,
          actorEmail: fixture.ownerEmail,
          accountGlobalId: fixture.accountGlobalId,
          orderGlobalId: fixture.current.global_id,
          expectedOrderRowVersion: Number(fixture.current.row_version),
          expectedSourceHash: fixture.currentSourceHash,
          ...snapshot(true, fixture.currentAcceptedProviderUpdatedAt),
          action: quantityAction,
          expectedLineQuantity: 2,
          reason: 'Reject destructive action without an accepted observation',
          idempotencyKey: 'shopify-order-qty-6601-accepted-missing',
        }),
        'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
        'destructive action must reject missing accepted observation evidence',
      )
    } finally {
      const restoreAcceptedClient = await pool.connect()
      try {
        await restoreAcceptedClient.query('SET session_replication_role = replica')
        await restoreAcceptedClient.query(
          `UPDATE operations_commerce_order_revision_targets
           SET accepted_observation_id = $3::uuid
           WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
          [
            fixture.organizationId,
            fixture.current.id,
            fixture.currentAcceptedObservationId,
          ],
        )
      } finally {
        await restoreAcceptedClient.query('SET session_replication_role = origin')
          .catch(() => undefined)
        restoreAcceptedClient.release()
      }
    }
    const preparedQuantity = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.current.global_id,
        expectedOrderRowVersion: Number(fixture.current.row_version),
        expectedSourceHash: fixture.currentSourceHash,
        ...snapshot(true, fixture.currentAcceptedProviderUpdatedAt),
        action: quantityAction,
        expectedLineQuantity: 2,
        reason: quantityReason,
        idempotencyKey: 'shopify-order-qty-6601-0001',
      })
    assert.equal(
      preparedQuantity.acceptedProviderOrderUpdatedAt,
      fixture.currentAcceptedProviderUpdatedAt,
    )
    assert.equal(
      preparedQuantity.acceptedObservationId,
      fixture.currentAcceptedObservationId,
    )
    const claimedQuantity = await persistence
      .claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: preparedQuantity.authorizationGlobalId,
        action: quantityAction,
        expectedLineQuantity: 2,
        reason: quantityReason,
      })
    const succeededQuantity = await persistence
      .recordShopifyOrderManagementOutcomeInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: preparedQuantity.authorizationGlobalId,
        providerAttemptGlobalId: claimedQuantity.providerAttemptGlobalId,
        outcome: 'succeeded',
        evidence: { begin: true, setQuantity: true, commit: true },
        providerReference: fixture.current.global_id,
        providerWriteCount: 3,
      })
    assert.equal(succeededQuantity.status, 'succeeded')
    assert.equal(succeededQuantity.providerWriteCount, 3)

    const downstreamAction = { type: 'add_tag', tag: 'downstream-block' }
    const downstreamReason = 'Prove claim rechecks zero downstream warehouse state'
    const downstreamPrepared = await persistence
      .prepareShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        accountGlobalId: fixture.accountGlobalId,
        orderGlobalId: fixture.current.global_id,
        expectedOrderRowVersion: Number(fixture.current.row_version),
        expectedSourceHash: fixture.currentSourceHash,
        ...snapshot(true),
        action: downstreamAction,
        reason: downstreamReason,
        idempotencyKey: 'shopify-order-downstream-6601',
      })
    const warehouse = await pool.query(
      `INSERT INTO operations_warehouses (
         organization_id, code, name, created_by, updated_by
       ) VALUES ($1::uuid, $2, 'Order management test warehouse', $3, $3)
       RETURNING id::text`,
      [fixture.organizationId, `SOM-${randomUUID().slice(0, 8)}`, fixture.ownerEmail],
    )
    const planningClient = await pool.connect()
    let planningCommitted = false
    try {
      await planningClient.query('BEGIN')
      await planningClient.query(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id, method, solver_status,
           promised_delivery_at, explanation, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'manual_override', 'accepted',
           now() + interval '1 day', '{}'::jsonb, $4
         )`,
        [
          fixture.organizationId,
          fixture.current.id,
          warehouse.rows[0].id,
          fixture.ownerEmail,
        ],
      )
      await planningClient.query(
        `INSERT INTO operations_sandbox_commerce_e2e_authorizations (
           organization_id, order_id, external_order_id,
           confirmation_statement_version, confirmation_hash, reason,
           authorized_by, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'sandbox-commerce-e2e-v1',
           repeat('a', 64), $4, $5, now() + interval '1 hour'
         )`,
        [
          fixture.organizationId,
          fixture.current.id,
          'gid://shopify/Order/6600002',
          'Planning winner materializes direct sandbox authority before claim',
          fixture.ownerEmail,
        ],
      )
      await planningClient.query(
        `INSERT INTO operations_billable_events (
           organization_id, pipeline_id, customer_id, order_id,
           contract_version_id, event_type, amount_minor, source_global_id,
           idempotency_key
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'order', 0,
           $6, $7
         )`,
        [
          fixture.organizationId,
          fixture.pipelineId,
          fixture.customerId,
          fixture.current.id,
          fixture.contractVersionId,
          fixture.current.global_id,
          `planning-wins-billable-${randomUUID()}`,
        ],
      )
      let claimSettled = false
      const concurrentClaim = persistence
        .claimShopifyOrderManagementInPostgres({
          organizationId: fixture.organizationId,
          actorEmail: fixture.ownerEmail,
          authorizationGlobalId: downstreamPrepared.authorizationGlobalId,
          action: downstreamAction,
          reason: downstreamReason,
        })
        .then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        )
        .finally(() => { claimSettled = true })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
      assert.equal(
        claimSettled,
        false,
        'claim must wait while planning holds the prepared authorization lock',
      )
      await planningClient.query('COMMIT')
      planningCommitted = true
      const claimResult = await concurrentClaim
      assert.equal(
        claimResult.error?.code,
        'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
        'planning winner must make the waiting claim fail its downstream recheck',
      )
      const committedDirectRoots = await pool.query(
        `SELECT
           EXISTS (
             SELECT 1
             FROM operations_billable_events event
             WHERE event.organization_id = $1::uuid
               AND event.order_id = $2::uuid
           ) AS billable_exists,
           EXISTS (
             SELECT 1
             FROM operations_sandbox_commerce_e2e_authorizations authz
             WHERE authz.organization_id = $1::uuid
               AND authz.order_id = $2::uuid
           ) AS sandbox_authority_exists`,
        [fixture.organizationId, fixture.current.id],
      )
      assert.deepEqual(committedDirectRoots.rows[0], {
        billable_exists: true,
        sandbox_authority_exists: true,
      }, 'planning winner must commit both independent downstream roots')
    } finally {
      if (!planningCommitted) {
        await planningClient.query('ROLLBACK').catch(() => undefined)
      }
      planningClient.release()
    }
    await expectRejected(
      () => persistence.claimShopifyOrderManagementInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.ownerEmail,
        authorizationGlobalId: downstreamPrepared.authorizationGlobalId,
        action: downstreamAction,
        reason: downstreamReason,
      }),
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_CURRENT',
      'replayed claim must remain blocked after downstream planning commits',
    )

    await expectDatabaseRejected(
      () => pool.query(
        `UPDATE operations_shopify_order_management_attempts
         SET attempt_hash = repeat('f', 64)
         WHERE global_id = $1`,
        [claimedTag.providerAttemptGlobalId],
      ),
      /attempts are immutable/i,
      'provider attempt evidence must be immutable',
    )
    await expectDatabaseRejected(
      () => pool.query(
        `UPDATE operations_shopify_order_management_outcomes
         SET evidence_hash = repeat('f', 64)
         WHERE global_id = $1`,
        [reconciled.latestOutcomeGlobalId],
      ),
      /outcomes are immutable/i,
      'provider outcome evidence must be immutable',
    )

    const health = await persistence
      .readShopifyOrderManagementHealthFromPostgres()
    assert.ok(health.prepared >= 1)
    assert.equal(health.processing, 0)
    assert.equal(health.staleProcessing, 0)
    assert.equal(health.unknown, 0)
    assert.ok(health.latestUnknownAt)
    assert.ok(health.lastCompletedAt)
    assert.ok(health.knownProviderWriteOutcomeCount >= 4)
    assert.ok(health.knownProviderWriteSum >= 4)

    const columns = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name =
           'operations_shopify_order_management_authorizations'`,
    )
    const names = columns.rows.map((row) => row.column_name)
    assert.equal(names.includes('tag'), false)
    assert.equal(names.includes('staff_note'), false)
    assert.ok(names.includes('tag_hash'))
    assert.ok(names.includes('staff_note_hash'))
    assert.ok(names.includes('authorization_reason'))

    const stored = await pool.query(
      `SELECT authz.*, attempt.*, outcome.*
       FROM operations_shopify_order_management_authorizations authz
       LEFT JOIN operations_shopify_order_management_attempts attempt
         ON attempt.authorization_id = authz.id
       LEFT JOIN operations_shopify_order_management_outcomes outcome
         ON outcome.authorization_id = authz.id
       WHERE authz.organization_id = $1::uuid`,
      [fixture.organizationId],
    )
    assert.equal(JSON.stringify(stored.rows).includes(tagAction.tag), false)
    assert.equal(
      JSON.stringify(stored.rows).includes(quantityAction.staffNote),
      false,
    )
    assert.ok(audits.some((event) => (
      event.eventType ===
        'operations.shopify_order_management.provider_attempt_committed'
      && event.payload.networkCalls === 0
      && event.payload.providerWrites === 0
    )))
    assert.ok(audits.some((event) => (
      event.eventType === 'operations.shopify_order_management.unknown'
      && event.payload.providerWrites === 1
    )))
    assert.ok(audits.some((event) => (
      event.eventType === 'operations.shopify_order_management.succeeded'
      && event.payload.providerWrites === 3
    )))
    assert.ok(audits.some((event) => (
      event.eventType ===
        'operations.shopify_order_management.processing_lease_expired'
      && event.payload.providerWrites === null
      && event.payload.providerRetryAuthorized === false
    )))
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-shopify-order-management-${randomUUID()}`
  try {
    command('docker', [
      'run', '--detach', '--rm', '--name', container,
      '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=clawpilot_order_management_test',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ])
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = portOutput.trim().split(':').at(-1)
    const databaseUrl =
      `postgresql://postgres:postgres@127.0.0.1:${port}/clawpilot_order_management_test`
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    try {
      for (const filename of migrations()) {
        await applyMigration(pool, filename)
      }
    } finally {
      await pool.end()
    }
    await verify(databaseUrl)
    console.log(
      'Shopify order management PostgreSQL transitions and safety fences passed.',
    )
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }
}

await main()
