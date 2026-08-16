#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  actorEmail,
  applyMigration,
  command,
  migrations,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')

const {
  OPERATIONS_COMMERCE_STORE_SYNC_FUNCTION_HEALTH_SQL,
  OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL,
  OPERATIONS_COMMERCE_STORE_SYNC_STRUCTURE_HEALTH_SQL,
} = loadTypeScript(
  'app_src/lib/persistence/commerceStoreSyncHealth.ts',
)

function loadTypeScript(path, mocks = {}) {
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
    setInterval,
    clearInterval,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

function postgresAdapter(pool) {
  return {
    query(text, values = []) {
      return pool.query(text, values)
    },
    async withTransaction(work) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client)
        await client.query('COMMIT')
        return result
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

async function storeSyncFunctionHealth(client) {
  const result = await client.query(
    `SELECT ${OPERATIONS_COMMERCE_STORE_SYNC_FUNCTION_HEALTH_SQL} AS healthy`,
  )
  return result.rows[0]?.healthy === true
}

async function storeSyncStructureHealth(client) {
  const result = await client.query(
    `SELECT ${OPERATIONS_COMMERCE_STORE_SYNC_STRUCTURE_HEALTH_SQL} AS healthy`,
  )
  return result.rows[0]?.healthy === true
}

async function storeSyncRewrittenFunctionHealth(client) {
  const result = await client.query(
    `SELECT ${OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL}
       AS healthy`,
  )
  return result.rows[0]?.healthy === true
}

async function readStoreSyncHealthCatalog(client) {
  const signatures = [
    'public.operations_commerce_store_sync_effective_reason(uuid,uuid)',
    'public.operations_commerce_store_sync_is_running(uuid,uuid)',
    'public.operations_commerce_provider_read_authority_is_current(uuid,uuid,text)',
    'public.operations_commerce_product_image_read_authority_is_current(uuid,uuid,text,integer,text)',
    'public.guard_operations_commerce_product_image_read_authority()',
    'public.guard_operations_commerce_store_sync_read_lease()',
    'public.seed_operations_commerce_store_sync_control()',
    'public.protect_commerce_order_sync_session_lineage()',
    'public.protect_commerce_order_observation_lineage()',
    'public.commerce_order_observation_accepts_children(uuid,uuid)',
    'public.protect_shopify_order_webhook_read()',
    'public.protect_shopify_order_webhook_target()',
    'public.guard_operations_commerce_product_image_binding()',
    'public.protect_operations_commerce_store_sync_receipt()',
    'public.validate_operations_commerce_store_sync_identity()',
    'public.operations_shopify_inventory_read_config_is_ready(uuid,uuid)',
    'public.operations_commerce_product_image_account_is_current(uuid,uuid,text,integer)',
    'public.operations_commerce_product_image_account_lineage_is_current(uuid,uuid,text,integer)',
    'public.operations_commerce_product_image_mapping_targets(uuid,uuid,text,text)',
    'public.operations_commerce_product_image_job_fences_are_current(uuid,uuid)',
    'public.operations_commerce_product_image_projection_fences_are_current(uuid,uuid)',
  ]
  const functionRows = await client.query(
    `WITH required(signature) AS (
       SELECT unnest($1::text[])
     )
     SELECT required.signature,
            encode(digest(convert_to(btrim(regexp_replace(
              installed.prosrc, '[[:space:]]+', ' ', 'g'
            )), 'UTF8'), 'sha256'), 'hex') AS body_sha256,
            language.lanname,
            installed.provolatile,
            installed.proisstrict,
            installed.prosecdef,
            installed.proleakproof,
            installed.proparallel,
            installed.proconfig,
            pg_get_function_result(installed.oid) AS result_type
     FROM required
     JOIN pg_proc installed
       ON installed.oid = to_regprocedure(required.signature)
     JOIN pg_language language ON language.oid = installed.prolang
     ORDER BY required.signature`,
    [signatures],
  )
  const rewrittenHash = await client.query(
    `WITH required(signature) AS (
       SELECT unnest($1::text[])
     )
     SELECT encode(digest(convert_to(string_agg(concat_ws(
       '|', required.signature,
       btrim(regexp_replace(installed.prosrc, '[[:space:]]+', ' ', 'g')),
       language.lanname, installed.provolatile::text,
       installed.proisstrict::text, installed.prosecdef::text,
       installed.proleakproof::text, installed.proparallel::text,
       COALESCE(array_to_string(installed.proconfig, ','), ''),
       pg_get_function_result(installed.oid)
     ), chr(10) ORDER BY required.signature), 'UTF8'), 'sha256'), 'hex')
       AS value
     FROM required
     JOIN pg_proc installed
       ON installed.oid = to_regprocedure(required.signature)
     JOIN pg_language language ON language.oid = installed.prolang`,
    [signatures],
  )
  const structure = await client.query(
    `SELECT
       (SELECT encode(digest(convert_to(string_agg(concat_ws(
         '|', installed_table.relname, installed_constraint.conname,
         installed_constraint.contype::text,
         installed_constraint.convalidated::text,
         installed_constraint.confdeltype::text,
         installed_constraint.confupdtype::text,
         pg_get_constraintdef(installed_constraint.oid)
       ), chr(10) ORDER BY installed_table.relname,
          installed_constraint.conname), 'UTF8'), 'sha256'), 'hex')
        FROM pg_constraint installed_constraint
        JOIN pg_class installed_table
          ON installed_table.oid = installed_constraint.conrelid
        WHERE installed_constraint.conrelid IN (
          to_regclass('operations_commerce_store_sync_controls'),
          to_regclass('operations_commerce_store_sync_change_receipts'),
          to_regclass('operations_commerce_store_sync_read_leases')
        ) OR installed_constraint.conname IN (
          'commerce_intake_read_intents_authority_valid',
          'ops_commerce_image_set_authority_valid',
          'ops_commerce_image_job_authority_valid'
        )) AS constraint_hash,
       (SELECT encode(digest(convert_to(string_agg(concat_ws(
         '|', installed_table.relname, installed_index_class.relname,
         installed_index.indisprimary::text,
         installed_index.indisunique::text,
         installed_index.indisvalid::text,
         installed_index.indisready::text,
         installed_index.indkey::text,
         pg_get_indexdef(installed_index.indexrelid)
       ), chr(10) ORDER BY installed_table.relname,
          installed_index_class.relname), 'UTF8'), 'sha256'), 'hex')
        FROM pg_index installed_index
        JOIN pg_class installed_table
          ON installed_table.oid = installed_index.indrelid
        JOIN pg_class installed_index_class
          ON installed_index_class.oid = installed_index.indexrelid
        WHERE installed_index.indrelid IN (
          to_regclass('operations_commerce_store_sync_controls'),
          to_regclass('operations_commerce_store_sync_change_receipts'),
          to_regclass('operations_commerce_store_sync_read_leases')
        )) AS index_hash,
       (SELECT encode(digest(convert_to(string_agg(concat_ws(
         '|', table_name, column_name, ordinal_position::text,
         data_type, udt_schema, udt_name, is_nullable,
         COALESCE(column_default, '<null>'), is_identity,
         COALESCE(identity_generation, '<null>'), is_generated,
         COALESCE(generation_expression, '<null>'),
         COALESCE(collation_schema, '<null>'),
         COALESCE(collation_name, '<null>'),
         COALESCE(character_maximum_length::text, '<null>'),
         COALESCE(numeric_precision::text, '<null>'),
         COALESCE(numeric_scale::text, '<null>'),
         COALESCE(datetime_precision::text, '<null>')
       ), chr(10) ORDER BY table_name, column_name), 'UTF8'), 'sha256'), 'hex')
        FROM information_schema.columns
        WHERE table_schema = 'public' AND (
          table_name IN (
            'operations_commerce_store_sync_controls',
            'operations_commerce_store_sync_change_receipts',
            'operations_commerce_store_sync_read_leases'
          )
          OR (table_name IN (
            'operations_commerce_intake_read_intents',
            'operations_commerce_product_image_observation_sets',
            'operations_commerce_product_image_import_jobs'
          ) AND column_name = 'provider_read_authority')
        )) AS column_hash`,
  )
  return {
    functions: functionRows.rows,
    rewrittenHash: rewrittenHash.rows[0]?.value,
    ...structure.rows[0],
  }
}

async function assertFunctionTamperDetected(pool, tamperSql) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal(await storeSyncFunctionHealth(client), true)
    await client.query(tamperSql)
    assert.equal(await storeSyncFunctionHealth(client), false)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  assert.equal(await storeSyncFunctionHealth(pool), true)
}

async function assertStructureTamperDetected(pool, tamperSql) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal(await storeSyncStructureHealth(client), true)
    await client.query(tamperSql)
    assert.equal(await storeSyncStructureHealth(client), false)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  assert.equal(await storeSyncStructureHealth(pool), true)
}

async function assertRewrittenFunctionTamperDetected(pool, tamperSql) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal(await storeSyncRewrittenFunctionHealth(client), true)
    await client.query(tamperSql)
    assert.equal(await storeSyncRewrittenFunctionHealth(client), false)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  assert.equal(await storeSyncRewrittenFunctionHealth(pool), true)
}

async function withReplicaFixture(pool, work) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function fixture(index, state) {
  return {
    organizationId: randomUUID(),
    pipelineId: randomUUID(),
    accountId: randomUUID(),
    globalId: `gia00098${String(index).padStart(2, '0')}`,
    organizationGlobalId: `ga00098${String(index).padStart(2, '0')}`,
    state,
  }
}

async function seedAccount(client, value) {
  const allocated = await client.query(
    `SELECT allocate_global_reference('gia') AS global_id`,
  )
  value.globalId = allocated.rows[0].global_id
  await client.query(
    `INSERT INTO workspace_organizations (
       id, name, organization_type, reference_code
     ) VALUES ($1::uuid, $2, 'member', $3)`,
    [value.organizationId, `Store sync ${value.state}`, value.organizationGlobalId],
  )
  await client.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1::uuid, $2, $3, true, $4::uuid)`,
    [value.pipelineId, `Store sync ${value.state}`, actorEmail, value.organizationId],
  )
  await client.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, revision
     ) VALUES ($1::uuid, $2::uuid, $3, 1)`,
    [value.organizationId, value.pipelineId, value.state],
  )
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type,
       environment, display_name, status, configuration,
       external_account_id, commerce_credential_generation,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, 'shopify', 'commerce', 'sandbox',
       $4, 'active', jsonb_build_object('shopDomain', $5::text),
       $6, 1, $7, $7
     )`,
    [
      value.accountId,
      value.globalId,
      value.organizationId,
      `Store sync ${value.state}`,
      `${value.state.replace('_', '-')}.myshopify.com`,
      `gid://shopify/Shop/98${String(value.globalId).slice(-2)}`,
      actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     )
     SELECT account.organization_id, account.id, account.external_account_id,
            'shopify_client_credentials', decode('01', 'hex'),
            decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
            1, right(account.global_id, 4), 'verified', now(), 'unverified',
            $3, $3
     FROM operations_integration_accounts account
     WHERE account.organization_id = $1::uuid
       AND account.id = $2::uuid`,
    [value.organizationId, value.accountId, actorEmail],
  )
}

async function verify(databaseUrl, fixtures) {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 })
  const domain = loadTypeScript(
    'app_src/lib/operations/commerceStoreSync.ts',
  )
  const persistence = loadTypeScript(
    'app_src/lib/persistence/commerceStoreSync.ts',
    {
      '@/lib/operations/commerceStoreSync': domain,
      '@/lib/auditWriter': { async recordAuditEvent() {} },
      '@/lib/persistence/postgres': postgresAdapter(pool),
    },
  )
  try {
    const controls = await pool.query(
      `SELECT account.global_id, activation.state, control.desired_state,
              control.explicit_choice, control.revision
       FROM operations_commerce_store_sync_controls control
       JOIN operations_integration_accounts account
         ON account.organization_id = control.organization_id
        AND account.id = control.integration_account_id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = control.organization_id
       ORDER BY account.global_id`,
    )
    assert.equal(controls.rowCount, fixtures.length)
    for (const row of controls.rows) {
      assert.equal(
        row.desired_state,
        ['shadow', 'active'].includes(row.state) ? 'running' : 'paused',
      )
      assert.equal(row.explicit_choice, false)
      assert.equal(Number(row.revision), 1)
    }

    const active = fixtures.find((value) => value.state === 'active')
    assert.ok(active)
    let releaseProviderRead
    let markProviderReadStarted
    const providerReadStarted = new Promise((resolvePromise) => {
      markProviderReadStarted = resolvePromise
    })
    const providerReadRelease = new Promise((resolvePromise) => {
      releaseProviderRead = resolvePromise
    })
    const inFlightProviderRead =
      persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'automatic',
        readKind: 'order_history',
        intentKey: 'acceptance:active:order-history:1',
        acquiredBy: actorEmail,
        read: async () => {
          markProviderReadStarted()
          await providerReadRelease
          return 'provider-read-finished-before-pause'
        },
      })
    await providerReadStarted
    const pauseCommand =
      persistence.updateCommerceStoreSyncControlInPostgres({
        organizationId: active.organizationId,
        accountGlobalId: active.globalId,
        desiredState: 'paused',
        expectedDesiredState: 'running',
        expectedRevision: 1,
        reason: 'Pause while a precommitted provider read drains',
        actorEmail,
        idempotencyKey: 'store-sync:acceptance:provider-read-pause',
      })
    assert.equal(
      await Promise.race([
        pauseCommand.then(() => 'committed'),
        new Promise((resolvePromise) => {
          setTimeout(() => resolvePromise('waiting-for-read'), 100)
        }),
      ]),
      'committed',
    )
    const paused = await pauseCommand
    assert.equal(paused.control.effectiveState, 'paused')
    assert.equal(
      paused.control.effectiveReason,
      'STORE_SYNC_EXPLICIT_PAUSED_DRAINING',
    )
    releaseProviderRead()
    await assert.rejects(
      inFlightProviderRead,
      (error) => error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST',
    )
    const settledPaused = (
      await persistence.readCommerceStoreSyncControlsFromPostgres(
        active.organizationId,
      )
    ).find((control) => control.accountGlobalId === active.globalId)
    assert.equal(settledPaused?.effectiveReason, 'STORE_SYNC_EXPLICIT_PAUSED')

    let postPauseProviderCalls = 0
    await assert.rejects(
      persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'automatic',
        readKind: 'order_history',
        intentKey: 'acceptance:active:order-history:post-pause',
        acquiredBy: actorEmail,
        async read() {
          postPauseProviderCalls += 1
          return 'must-not-run'
        },
      }),
      (error) => (
        error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
      ),
    )
    assert.equal(postPauseProviderCalls, 0)
    await assert.rejects(
      pool.query(
        `INSERT INTO operations_commerce_store_sync_read_leases (
           id, organization_id, integration_account_id, authority_kind,
           read_kind, intent_fingerprint_sha256,
           control_revision, activation_revision, acquired_by,
           acquired_at, heartbeat_at, expires_at
         ) VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, 'automatic',
           'order_history', repeat('e', 64),
           (SELECT revision FROM operations_commerce_store_sync_controls
            WHERE organization_id = $1::uuid
              AND integration_account_id = $2::uuid),
           (SELECT revision FROM operations_activation_scopes
            WHERE organization_id = $1::uuid),
           $3,
           date_trunc('milliseconds', statement_timestamp()),
           date_trunc('milliseconds', statement_timestamp()),
           date_trunc('milliseconds', statement_timestamp())
             + interval '60 seconds'
         )`,
        [active.organizationId, active.accountId, actorEmail],
      ),
      /requires current exact authority/u,
    )
    let manualProviderCalls = 0
    assert.equal(
      await persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'manual_read_only',
        readKind: 'order_revision',
        intentKey: 'acceptance:active:manual-order-refresh:1',
        acquiredBy: actorEmail,
        async read() {
          manualProviderCalls += 1
          return 'manual-read-completed-under-pause'
        },
      }),
      'manual-read-completed-under-pause',
    )
    assert.equal(manualProviderCalls, 1)
    let emergencyProviderCalls = 0
    for (const emergencyState of ['disabled', 'frozen']) {
      const emergency = fixtures.find((value) => value.state === emergencyState)
      assert.ok(emergency)
      await assert.rejects(
        persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
          organizationId: emergency.organizationId,
          integrationAccountId: emergency.accountId,
          authorityKind: 'manual_read_only',
          readKind: 'order_revision',
          intentKey: `acceptance:${emergencyState}:manual-order-refresh:1`,
          acquiredBy: actorEmail,
          async read() {
            emergencyProviderCalls += 1
            return 'must-not-run'
          },
        }),
        (error) => error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED',
      )
    }
    assert.equal(emergencyProviderCalls, 0)
    await assert.rejects(
      persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'manual_read_only',
        readKind: 'order_revision',
        intentKey: 'acceptance:active:manual-order-refresh:1',
        acquiredBy: actorEmail,
        async read() {
          manualProviderCalls += 1
          return 'duplicate-intent-must-not-run'
        },
      }),
      (error) => (
        error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST'
      ),
    )
    assert.equal(manualProviderCalls, 1)
    const resumed =
      await persistence.updateCommerceStoreSyncControlInPostgres({
        organizationId: active.organizationId,
        accountGlobalId: active.globalId,
        desiredState: 'running',
        expectedDesiredState: 'paused',
        expectedRevision: 2,
        reason: 'Resume after bounded provider read acceptance',
        actorEmail,
        idempotencyKey: 'store-sync:acceptance:provider-read-resume',
      })
    assert.equal(resumed.control.effectiveState, 'running')

    let releaseCapturedRead
    let markCapturedRead
    const capturedReadCommitted = new Promise((resolvePromise) => {
      markCapturedRead = resolvePromise
    })
    const capturedReadRelease = new Promise((resolvePromise) => {
      releaseCapturedRead = resolvePromise
    })
    let capturedLeaseId = null
    const captureBeforePause =
      persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'automatic',
        readKind: 'order_history',
        intentKey: 'acceptance:active:capture-before-pause',
        acquiredBy: actorEmail,
        read: async (providerReadLease) => {
          capturedLeaseId = providerReadLease.id
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            await persistence
              .assertCommerceStoreSyncProviderReadLeaseCurrentWithClient(
                client,
                {
                  organizationId: active.organizationId,
                  integrationAccountId: active.accountId,
                  lease: providerReadLease,
                  authorityKind: 'automatic',
                  readKind: 'order_history',
                },
              )
            await client.query('COMMIT')
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
          markCapturedRead()
          await capturedReadRelease
          return 'captured-before-pause'
        },
      })
    await capturedReadCommitted
    const pausedAfterCapture =
      await persistence.updateCommerceStoreSyncControlInPostgres({
        organizationId: active.organizationId,
        accountGlobalId: active.globalId,
        desiredState: 'paused',
        expectedDesiredState: 'running',
        expectedRevision: 3,
        reason: 'Pause after exact provider evidence capture committed',
        actorEmail,
        idempotencyKey: 'store-sync:acceptance:pause-after-capture',
      })
    assert.equal(pausedAfterCapture.control.desiredState, 'paused')
    releaseCapturedRead()
    assert.equal(await captureBeforePause, 'captured-before-pause')
    const capturedLease = await pool.query(
      `SELECT captured_at IS NOT NULL AS captured,
              release_reason
       FROM operations_commerce_store_sync_read_leases
       WHERE id = $1::uuid`,
      [capturedLeaseId],
    )
    assert.equal(capturedLease.rows[0].captured, true)
    assert.equal(capturedLease.rows[0].release_reason, 'completed')
    await persistence.updateCommerceStoreSyncControlInPostgres({
      organizationId: active.organizationId,
      accountGlobalId: active.globalId,
      desiredState: 'running',
      expectedDesiredState: 'paused',
      expectedRevision: 4,
      reason: 'Resume after capture-before-pause proof',
      actorEmail,
      idempotencyKey: 'store-sync:acceptance:resume-after-capture',
    })

    let releaseStaleCapture
    let markStaleReadStarted
    const staleReadStarted = new Promise((resolvePromise) => {
      markStaleReadStarted = resolvePromise
    })
    const staleCaptureRelease = new Promise((resolvePromise) => {
      releaseStaleCapture = resolvePromise
    })
    let staleLeaseId = null
    let staleCaptureCommitted = false
    const pauseBeforeCapture =
      persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'automatic',
        readKind: 'order_history',
        intentKey: 'acceptance:active:pause-resume-before-capture',
        acquiredBy: actorEmail,
        read: async (providerReadLease) => {
          staleLeaseId = providerReadLease.id
          markStaleReadStarted()
          await staleCaptureRelease
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            await persistence
              .assertCommerceStoreSyncProviderReadLeaseCurrentWithClient(
                client,
                {
                  organizationId: active.organizationId,
                  integrationAccountId: active.accountId,
                  lease: providerReadLease,
                  authorityKind: 'automatic',
                  readKind: 'order_history',
                },
              )
            await client.query('COMMIT')
            staleCaptureCommitted = true
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
          return 'must-not-commit'
        },
      })
    await staleReadStarted
    await persistence.updateCommerceStoreSyncControlInPostgres({
      organizationId: active.organizationId,
      accountGlobalId: active.globalId,
      desiredState: 'paused',
      expectedDesiredState: 'running',
      expectedRevision: 5,
      reason: 'Pause before stale provider response capture',
      actorEmail,
      idempotencyKey: 'store-sync:acceptance:pause-before-capture',
    })
    await persistence.updateCommerceStoreSyncControlInPostgres({
      organizationId: active.organizationId,
      accountGlobalId: active.globalId,
      desiredState: 'running',
      expectedDesiredState: 'paused',
      expectedRevision: 6,
      reason: 'Resume with a new Store sync generation',
      actorEmail,
      idempotencyKey: 'store-sync:acceptance:resume-before-stale-capture',
    })
    releaseStaleCapture()
    await assert.rejects(
      pauseBeforeCapture,
      (error) => error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST',
    )
    assert.equal(staleCaptureCommitted, false)
    const staleLease = await pool.query(
      `SELECT captured_at, release_reason
       FROM operations_commerce_store_sync_read_leases
       WHERE id = $1::uuid`,
      [staleLeaseId],
    )
    assert.equal(staleLease.rows[0].captured_at, null)
    assert.equal(staleLease.rows[0].release_reason, 'failed')

    const shadow = fixtures.find((value) => value.state === 'shadow')
    assert.ok(shadow)
    const commandInput = {
      organizationId: shadow.organizationId,
      accountGlobalId: shadow.globalId,
      desiredState: 'running',
      expectedDesiredState: 'running',
      expectedRevision: 1,
      reason: 'Confirm Running as an independent Store sync choice',
      actorEmail,
      idempotencyKey: 'store-sync:acceptance:adopt-running',
    }
    const adopted = await persistence
      .updateCommerceStoreSyncControlInPostgres(commandInput)
    assert.equal(adopted.control.desiredState, 'running')
    assert.equal(adopted.control.explicitChoice, true)
    assert.equal(adopted.control.revision, 2)

    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'read_only', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [shadow.organizationId],
    )
    const replay = await persistence
      .updateCommerceStoreSyncControlInPostgres(commandInput)
    assert.equal(
      JSON.stringify(replay),
      JSON.stringify(adopted),
      'same key/request replay remains byte-stable after effective-state changes',
    )
    const projected = await persistence
      .readCommerceStoreSyncControlsFromPostgres(shadow.organizationId)
    assert.equal(projected[0].effectiveState, 'running')
    assert.equal(projected[0].effectiveReason, 'STORE_SYNC_EXPLICIT_RUNNING')

    const inventoryWarehouseId = randomUUID()
    const inventoryWarehouseGlobalId = (
      await pool.query(`SELECT allocate_global_reference('gwh') AS global_id`)
    ).rows[0].global_id
    await pool.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, status
       ) VALUES (
         $1::uuid, $2, $3::uuid, 'STORE-SYNC',
         'Store sync inventory fixture', 'active'
       )`,
      [
        inventoryWarehouseId,
        inventoryWarehouseGlobalId,
        shadow.organizationId,
      ],
    )
    const inventoryConfigId = randomUUID()
    const inventoryConfigGlobalId = (
      await pool.query(`SELECT allocate_global_reference('gscf') AS global_id`)
    ).rows[0].global_id
    const inventoryActivationRevision = Number((
      await pool.query(
        `SELECT revision FROM operations_activation_scopes
         WHERE organization_id = $1::uuid`,
        [shadow.organizationId],
      )
    ).rows[0].revision)
    await withReplicaFixture(pool, (client) => client.query(
      `INSERT INTO operations_shopify_carrier_service_configs (
         id, global_id, organization_id, integration_account_id,
         warehouse_id, registration_state, credential_generation,
         activation_revision, callback_token_version, callback_token_hash,
         policy_revision, policy_hash, policy_snapshot,
         inventory_max_age_seconds, quote_ttl_seconds,
         order_reconciliation_window_seconds, algorithm_version,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         'shadow_simulated', 1, $7::integer, 1, repeat('a', 64),
         1, repeat('b', 64), '{
           "planRateOptimization": {
             "version": "shopify-checkout-plan-rate-objective-v2",
             "maxCandidates": 4,
             "objectivePriority": [
               "landed_price", "package_count", "unused_cube"
             ],
             "handlingCostMinorPerPackage": 0,
             "handlingCostCurrency": "USD"
           },
           "checkoutRateWarm": {
             "version": "shopify-checkout-rate-warm-v1",
             "enabled": false,
             "mode": "hosted_ajax",
             "zoneScope": "all_saved_rate_zones",
             "concurrency": 2,
             "debounceMs": 350,
             "minIntervalMs": 1000,
             "supportedCountries": ["US"],
             "staleCartAbort": true
           }
         }'::jsonb,
         900, 120, 3600, 'store-sync-acceptance-v1', $6, $6
       )`,
      [
        inventoryConfigId,
        inventoryConfigGlobalId,
        shadow.organizationId,
        shadow.accountId,
        inventoryWarehouseId,
        actorEmail,
        inventoryActivationRevision,
      ],
    ))
    const inventoryReadReady = async () => (
      await pool.query(
        `SELECT operations_shopify_inventory_read_config_is_ready(
           $1::uuid, $2::uuid
         ) AS ready`,
        [shadow.organizationId, inventoryConfigId],
      )
    ).rows[0].ready
    assert.equal(
      await inventoryReadReady(),
      true,
      'shadow-simulated inventory reads remain eligible after Read only',
    )
    await withReplicaFixture(pool, (client) => client.query(
      `UPDATE operations_shopify_carrier_service_configs
       SET registration_state = 'registered',
           service_gid = 'gid://shopify/DeliveryCarrierService/9801',
           row_version = row_version + 1,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [shadow.organizationId, inventoryConfigId],
    ))
    assert.equal(
      await inventoryReadReady(),
      true,
      'registered inventory reads remain eligible after Read only',
    )

    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'disabled', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [shadow.organizationId],
    )
    assert.equal(
      (await persistence.readCommerceStoreSyncControlsFromPostgres(
        shadow.organizationId,
      ))[0].effectiveReason,
      'OPERATIONS_DISABLED_OVERRIDE',
    )
    assert.equal(await inventoryReadReady(), false)
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'frozen', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [shadow.organizationId],
    )
    assert.equal(
      (await persistence.readCommerceStoreSyncControlsFromPostgres(
        shadow.organizationId,
      ))[0].effectiveReason,
      'OPERATIONS_FROZEN_OVERRIDE',
    )
    assert.equal(await inventoryReadReady(), false)
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'read_only', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [shadow.organizationId],
    )

    await assert.rejects(
      persistence.updateCommerceStoreSyncControlInPostgres({
        ...commandInput,
        reason: 'Different request under the retained key',
      }),
      (error) => error?.code === 'COMMERCE_STORE_SYNC_IDEMPOTENCY_CONFLICT',
    )
    await assert.rejects(
      persistence.updateCommerceStoreSyncControlInPostgres({
        ...commandInput,
        idempotencyKey: 'store-sync:acceptance:stale-cas',
      }),
      (error) => error?.code === 'COMMERCE_STORE_SYNC_REVISION_CONFLICT',
    )

    const races = await Promise.allSettled([
      persistence.updateCommerceStoreSyncControlInPostgres({
        ...commandInput,
        desiredState: 'paused',
        expectedRevision: 2,
        idempotencyKey: 'store-sync:acceptance:race-a',
        reason: 'Pause from concurrent acceptance command A',
      }),
      persistence.updateCommerceStoreSyncControlInPostgres({
        ...commandInput,
        desiredState: 'paused',
        expectedRevision: 2,
        idempotencyKey: 'store-sync:acceptance:race-b',
        reason: 'Pause from concurrent acceptance command B',
      }),
    ])
    assert.equal(races.filter((value) => value.status === 'fulfilled').length, 1)
    assert.equal(races.filter((value) => value.status === 'rejected').length, 1)
    assert.equal(
      await inventoryReadReady(),
      false,
      'an explicit Paused Store sync blocks inventory readiness',
    )

    const secondAccountId = randomUUID()
    const secondAccountGlobalId = (
      await pool.query(`SELECT allocate_global_reference('gia') AS global_id`)
    ).rows[0].global_id
    await pool.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $4, $2::uuid, 'faire', 'commerce', 'production',
         'Isolated Faire', 'active', '{}'::jsonb, 'brand_store_sync_99', 1,
         $3, $3
       )`,
      [
        secondAccountId,
        shadow.organizationId,
        actorEmail,
        secondAccountGlobalId,
      ],
    )
    const isolated = await pool.query(
      `SELECT desired_state, explicit_choice, revision
       FROM operations_commerce_store_sync_controls
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [shadow.organizationId, secondAccountId],
    )
    assert.deepEqual(
      {
        desiredState: isolated.rows[0].desired_state,
        explicitChoice: isolated.rows[0].explicit_choice,
        revision: Number(isolated.rows[0].revision),
      },
      { desiredState: 'paused', explicitChoice: false, revision: 1 },
    )

    await assert.rejects(
      pool.query(
        `UPDATE operations_commerce_store_sync_controls
         SET integration_account_id = $3::uuid,
             revision = revision + 1,
             explicit_choice = true
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [shadow.organizationId, shadow.accountId, secondAccountId],
      ),
      /identity and creation evidence are immutable/i,
    )
    await assert.rejects(
      pool.query(
        `UPDATE operations_commerce_store_sync_controls
         SET revision = revision + 2,
             explicit_choice = true
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [shadow.organizationId, shadow.accountId],
      ),
      /revision must advance by exactly one/i,
    )
    await assert.rejects(
      pool.query(
        `UPDATE operations_commerce_store_sync_change_receipts
         SET reason = 'tampered'
         WHERE organization_id = $1::uuid`,
        [shadow.organizationId],
      ),
      /append-only/i,
    )

    const functionBodyTampers = [
      `CREATE OR REPLACE FUNCTION
         operations_commerce_store_sync_effective_reason(
           requested_organization_id uuid,
           requested_integration_account_id uuid
         )
       RETURNS text LANGUAGE sql STABLE
       AS $$ SELECT 'STORE_SYNC_EXPLICIT_RUNNING'::text $$`,
      `CREATE OR REPLACE FUNCTION
         operations_commerce_store_sync_is_running(
           requested_organization_id uuid,
           requested_integration_account_id uuid
         )
       RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`,
      `CREATE OR REPLACE FUNCTION
         seed_operations_commerce_store_sync_control()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE OR REPLACE FUNCTION
         protect_operations_commerce_store_sync_receipt()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN OLD; END $$`,
      `CREATE OR REPLACE FUNCTION
         validate_operations_commerce_store_sync_identity()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE OR REPLACE FUNCTION
         operations_shopify_inventory_read_config_is_ready(
           requested_organization_id uuid,
           requested_config_id uuid
         )
       RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`,
      `CREATE OR REPLACE FUNCTION
         operations_commerce_provider_read_authority_is_current(
           requested_organization_id uuid,
           requested_integration_account_id uuid,
           requested_authority text
         )
       RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`,
      `CREATE OR REPLACE FUNCTION
         operations_commerce_product_image_read_authority_is_current(
           requested_organization_id uuid,
           requested_integration_account_id uuid,
           requested_provider text,
           requested_credential_generation integer,
           requested_authority text
         )
       RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`,
      `CREATE OR REPLACE FUNCTION
         guard_operations_commerce_product_image_read_authority()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE OR REPLACE FUNCTION
         guard_operations_commerce_store_sync_read_lease()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN NEW; END $$`,
    ]
    for (const tamperSql of functionBodyTampers) {
      await assertFunctionTamperDetected(pool, tamperSql)
    }

    await assertRewrittenFunctionTamperDetected(
      pool,
      `CREATE OR REPLACE FUNCTION
         protect_commerce_order_sync_session_lineage()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN NEW; END $$`,
    )
    await assertRewrittenFunctionTamperDetected(
      pool,
      `CREATE OR REPLACE FUNCTION
         operations_commerce_product_image_projection_fences_are_current(
           requested_organization_id uuid,
           requested_job_id uuid
         )
       RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER
       SET search_path = pg_catalog, public
       AS $$ BEGIN RETURN true; END $$`,
    )

    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_store_sync_controls
         DROP CONSTRAINT
           operations_commerce_store_sync_controls_desired_state_check;
       ALTER TABLE operations_commerce_store_sync_controls
         ADD CONSTRAINT
           operations_commerce_store_sync_controls_desired_state_check
         CHECK (true)`,
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_store_sync_read_leases
         DROP CONSTRAINT
           operations_commerce_store_sync_read_leases_authority_valid;
       ALTER TABLE operations_commerce_store_sync_read_leases
         ADD CONSTRAINT
           operations_commerce_store_sync_read_leases_authority_valid
         CHECK (true)`,
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_intake_read_intents
         ALTER COLUMN provider_read_authority SET DEFAULT 'automatic'`,
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_store_sync_controls
         ALTER COLUMN explicit_choice DROP NOT NULL`,
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_store_sync_change_receipts
         ALTER COLUMN response_json TYPE varchar(8192)`,
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_store_sync_read_leases
         DISABLE TRIGGER
           guard_operations_commerce_store_sync_read_lease_write`,
    )
    await assertStructureTamperDetected(
      pool,
      `DROP TRIGGER guard_operations_commerce_image_job_authority_write
         ON operations_commerce_product_image_import_jobs;
       CREATE TRIGGER guard_operations_commerce_image_job_authority_write
         BEFORE UPDATE ON operations_commerce_product_image_import_jobs
         FOR EACH ROW EXECUTE FUNCTION
           validate_operations_commerce_store_sync_identity()`,
    )
    await assertStructureTamperDetected(
      pool,
      `DROP TRIGGER protect_operations_commerce_store_sync_receipt_write
         ON operations_commerce_store_sync_change_receipts;
       CREATE TRIGGER protect_operations_commerce_store_sync_receipt_write
         BEFORE UPDATE OR DELETE
         ON operations_commerce_store_sync_change_receipts
         FOR EACH ROW WHEN (false)
         EXECUTE FUNCTION protect_operations_commerce_store_sync_receipt()`,
    )
    await assertStructureTamperDetected(
      pool,
      `DROP TRIGGER validate_operations_commerce_store_sync_identity_write
         ON operations_commerce_store_sync_controls;
       CREATE TRIGGER validate_operations_commerce_store_sync_identity_write
         BEFORE INSERT OR UPDATE
         ON operations_commerce_store_sync_controls
         FOR EACH ROW WHEN (false)
         EXECUTE FUNCTION validate_operations_commerce_store_sync_identity()`,
    )
    await assertStructureTamperDetected(
      pool,
      `DROP TRIGGER seed_operations_commerce_store_sync_control_write
         ON operations_integration_accounts;
       CREATE TRIGGER seed_operations_commerce_store_sync_control_write
         AFTER INSERT ON operations_integration_accounts
         FOR EACH ROW WHEN (false)
         EXECUTE FUNCTION seed_operations_commerce_store_sync_control()`,
    )
    await assertStructureTamperDetected(
      pool,
      `CREATE SCHEMA store_sync_lookalike;
       CREATE TABLE store_sync_lookalike.operations_commerce_intake_read_intents (
         provider_read_authority text,
         CONSTRAINT commerce_intake_read_intents_authority_valid CHECK (true)
       );
       ALTER TABLE public.operations_commerce_intake_read_intents
         DROP CONSTRAINT commerce_intake_read_intents_authority_valid`,
    )
    await assertStructureTamperDetected(
      pool,
      `CREATE SCHEMA store_sync_lookalike;
       CREATE TABLE store_sync_lookalike.operations_commerce_store_sync_read_leases (
         provider_read_authority text
       );
       CREATE TRIGGER guard_operations_commerce_store_sync_read_lease_write
         BEFORE INSERT OR UPDATE OR DELETE
         ON store_sync_lookalike.operations_commerce_store_sync_read_leases
         FOR EACH ROW EXECUTE FUNCTION
           guard_operations_commerce_store_sync_read_lease();
       DROP TRIGGER guard_operations_commerce_store_sync_read_lease_write
         ON public.operations_commerce_store_sync_read_leases`,
    )
    const expiredLeaseClient = await pool.connect()
    try {
      await expiredLeaseClient.query('BEGIN')
      await expiredLeaseClient.query(
        'SET LOCAL session_replication_role = replica',
      )
      await expiredLeaseClient.query(
        `INSERT INTO operations_commerce_store_sync_read_leases (
           id, organization_id, integration_account_id, authority_kind,
           read_kind, intent_fingerprint_sha256,
           control_revision, activation_revision, acquired_by,
           acquired_at, heartbeat_at, expires_at
         ) VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, 'automatic',
           'order_history', repeat('f', 64),
           (SELECT revision FROM operations_commerce_store_sync_controls
            WHERE organization_id = $1::uuid
              AND integration_account_id = $2::uuid),
           (SELECT revision FROM operations_activation_scopes
            WHERE organization_id = $1::uuid),
           $3,
           clock_timestamp() - interval '61 seconds',
           clock_timestamp() - interval '61 seconds',
           clock_timestamp() - interval '1 second'
         )`,
        [active.organizationId, active.accountId, actorEmail],
      )
      await expiredLeaseClient.query('COMMIT')
      assert.equal(await storeSyncStructureHealth(pool), false)
      const reconciled = await persistence
        .reconcileExpiredCommerceStoreSyncProviderReadLeasesInPostgres()
      assert.equal(reconciled.reconciled, 1)
      assert.equal(await storeSyncStructureHealth(pool), true)
    } finally {
      await expiredLeaseClient.query('ROLLBACK').catch(() => {})
      expiredLeaseClient.release()
    }
    assert.equal(await storeSyncStructureHealth(pool), true)

    const structural = await pool.query(
      `SELECT
         (SELECT count(*) = 1 FROM pg_constraint
          WHERE conrelid = to_regclass(
            'operations_commerce_store_sync_controls'
          ) AND contype = 'p') AS control_pk,
         EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname =
             'operations_commerce_store_sync_controls_account_fkey'
             AND contype = 'f' AND convalidated
         ) AS control_fk,
         EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname =
             'operations_commerce_store_sync_receipts_idempotency_unique'
             AND contype = 'u'
         ) AS receipt_unique,
         EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgname =
             'validate_operations_commerce_store_sync_identity_write'
             AND tgtype = 23 AND tgenabled = 'O' AND NOT tgisinternal
         ) AS control_guard,
         EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgname =
             'protect_operations_commerce_store_sync_receipt_write'
             AND tgtype = 27 AND tgenabled = 'O' AND NOT tgisinternal
         ) AS receipt_guard`,
    )
    assert.deepEqual(structural.rows[0], {
      control_pk: true,
      control_fk: true,
      receipt_unique: true,
      control_guard: true,
      receipt_guard: true,
    })
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container =
    `clawpilot-store-sync-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_store_sync',
      '-e', 'POSTGRES_DB=clawpilot_store_sync',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:clawpilot_store_sync@127.0.0.1:'
      + `${port}/clawpilot_store_sync`
    )
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    const files = migrations()
    const migration = '0298_operations_commerce_store_sync_controls.sql'
    const migrationIndex = files.indexOf(migration)
    assert.ok(migrationIndex > 0, '0298 Store sync migration is missing')
    const fixtures = [
      fixture(1, 'shadow'),
      fixture(2, 'active'),
      fixture(3, 'read_only'),
      fixture(4, 'disabled'),
      fixture(5, 'frozen'),
    ]
    try {
      for (const file of files.slice(0, migrationIndex)) {
        await applyMigration(client, file)
      }
      await client.query(
        `INSERT INTO app_users (email, role, status)
         VALUES ($1, 'owner', 'active')`,
        [actorEmail],
      )
      for (const value of fixtures) await seedAccount(client, value)
      await applyMigration(client, migration)
    } finally {
      client.release()
      await pool.end()
    }
    await verify(databaseUrl, fixtures)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }
  console.log('Commerce Store sync disposable-PostgreSQL acceptance passed')
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
