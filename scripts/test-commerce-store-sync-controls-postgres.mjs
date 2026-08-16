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
