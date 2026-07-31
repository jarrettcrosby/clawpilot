#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')
const TARGET_MIGRATION =
  '0178_operations_shopify_customer_rate_policies.sql'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    env: { ...process.env, ...options.env },
  })
  if (result.error || result.status !== 0) {
    throw result.error || new Error(
      `${commandName} ${args.join(' ')} failed: ${
        result.stderr || result.stdout
      }`,
    )
  }
  return String(result.stdout || '').trim()
}

async function waitForPostgres(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000 })
  const deadline = Date.now() + 60_000
  try {
    while (Date.now() < deadline) {
      try {
        await pool.query('SELECT 1')
        return
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
      }
    }
  } finally {
    await pool.end().catch(() => undefined)
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

function loadTypeScriptModule(path, { mocks = {} } = {}) {
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
    AbortController,
    AbortSignal,
    BigInt,
    Buffer,
    Date,
    Error,
    Headers,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Request,
    Response,
    Set,
    String,
    TextDecoder,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    setTimeout,
    structuredClone,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

function postgresAdapter(pool) {
  return {
    query: (sql, params = []) => pool.query(sql, params),
    getPostgresPool: () => pool,
    acquireTransactionAdvisoryLock: (client, key) => client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [key],
    ),
    withTransaction: async (work) => {
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
  }
}

async function expectRejected(work, predicate, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${message}: expected rejection`)
  assert.ok(
    predicate(error),
    `${message}: ${String(error?.code || '')} ${String(error?.message || error)}`,
  )
}

async function seedTenant(pool, label) {
  const suffix = randomUUID().slice(0, 8)
  const email = `shopify-policy-${label}-${suffix}@example.com`
  await pool.query(
    `INSERT INTO app_users (email, role, status, display_name)
     VALUES ($1, 'owner', 'active', $2)`,
    [email, `Shopify policy ${label}`],
  )
  const organization = await pool.query(
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ($1, 'root', $2, $2)
     RETURNING id::text`,
    [`Shopify policy ${label} ${suffix}`, email],
  )
  const organizationId = organization.rows[0].id
  await pool.query(
    `UPDATE app_users
     SET organization_id = $2::uuid, organization_name = $3
     WHERE email = $1`,
    [email, organizationId, `Shopify policy ${label} ${suffix}`],
  )
  const pipeline = await pool.query(
    `INSERT INTO pipeline_spaces (
       name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1, $2, true, $3::uuid)
     RETURNING id::text`,
    [`Shopify policy ${label}`, email, organizationId],
  )
  await pool.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, reason, updated_by
     ) VALUES ($1::uuid, $2::uuid, 'shadow', $3, $4)`,
    [organizationId, pipeline.rows[0].id, 'Migration 0178 acceptance', email],
  )
  const account = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, configuration, created_by, updated_by
     ) VALUES (
       $1::uuid, 'shopify', 'commerce', 'sandbox',
       $2, 'active', '{}'::jsonb, $3, $3
     ) RETURNING id::text, global_id`,
    [organizationId, `Shopify ${label}`, email],
  )
  return {
    organizationId,
    email,
    integrationAccountId: account.rows[0].id,
    accountGlobalId: account.rows[0].global_id,
  }
}

async function verifyMigrationPresence(pool) {
  const result = await pool.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM schema_migrations WHERE filename = $1
       ) AS migration_present,
       to_regclass(
         'operations_shopify_customer_rate_policies'
       )::text AS policy_table,
       to_regprocedure(
         'validate_operations_shopify_customer_rate_policy_write()'
       )::text AS write_guard,
       EXISTS (
         SELECT 1
         FROM pg_trigger trigger
         JOIN pg_class relation ON relation.oid = trigger.tgrelid
         WHERE relation.relname =
           'operations_shopify_customer_rate_policies'
           AND trigger.tgname =
             'validate_operations_shopify_customer_rate_policy_write_trigger'
           AND NOT trigger.tgisinternal
       ) AS write_trigger_present`,
    [TARGET_MIGRATION],
  )
  assert.deepEqual(result.rows[0], {
    migration_present: true,
    policy_table: 'operations_shopify_customer_rate_policies',
    write_guard: 'validate_operations_shopify_customer_rate_policy_write()',
    write_trigger_present: true,
  })
}

async function rawShadowInsert(pool, tenant, input) {
  return pool.query(
    `INSERT INTO operations_shopify_customer_rate_policies (
       organization_id, integration_account_id, shopify_customer_gid,
       mode, service_codes, policy_hash, status, provider_state,
       shadow_duration_minutes, shadow_expires_at,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3,
       'show_all', '[]'::jsonb, repeat('a', 64),
       'simulated', 'not_written', $4::smallint,
       now() + ($4::integer * interval '1 minute'), $5, $5
     ) RETURNING id::text`,
    [
      input.organizationId ?? tenant.organizationId,
      input.integrationAccountId ?? tenant.integrationAccountId,
      input.customerGid,
      input.durationMinutes,
      tenant.email,
    ],
  )
}

async function verifyPostgresAcceptance(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
  })
  try {
    await verifyMigrationPresence(pool)
    const primary = await seedTenant(pool, 'primary')
    const other = await seedTenant(pool, 'other')
    const policyDomain = loadTypeScriptModule(
      'app_src/lib/integrations/shopifyCustomerRatePolicy.ts',
    )
    const policies = loadTypeScriptModule(
      'app_src/lib/persistence/shopifyCustomerRatePolicies.ts',
      {
        mocks: {
          '@/lib/integrations/shopifyCustomerRatePolicy': policyDomain,
          '@/lib/persistence/postgres': postgresAdapter(pool),
        },
      },
    )

    await expectRejected(
      () => rawShadowInsert(pool, other, {
        organizationId: other.organizationId,
        integrationAccountId: primary.integrationAccountId,
        customerGid: 'gid://shopify/Customer/901',
        durationMinutes: 60,
      }),
      (error) => error.code === 'P0001'
        && /requires a Shopify commerce account/.test(error.message),
      'A Shopify account from another tenant must fail closed',
    )

    for (const durationMinutes of [14, 241]) {
      await expectRejected(
        () => rawShadowInsert(pool, primary, {
          customerGid: `gid://shopify/Customer/${900 + durationMinutes}`,
          durationMinutes,
        }),
        (error) => error.code === '23514',
        `A ${durationMinutes}-minute Shadow window must violate the DB bound`,
      )
    }

    const durationFixtures = [
      { gid: 'gid://shopify/Customer/101', duration: 15 },
      { gid: 'gid://shopify/Customer/102', duration: undefined },
      { gid: 'gid://shopify/Customer/103', duration: 240 },
    ]
    const created = []
    for (const fixture of durationFixtures) {
      created.push(await policies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: primary.organizationId,
        accountGlobalId: primary.accountGlobalId,
        customerGid: fixture.gid,
        mode: 'show_all',
        serviceCodes: [],
        shadowDurationMinutes: fixture.duration,
        actorEmail: primary.email,
      }))
    }
    assert.deepEqual(
      created.map((entry) => entry.policy.shadowDurationMinutes),
      [15, 60, 240],
      'Shadow duration must preserve the 15/60/240 minute contract',
    )
    const intervals = await pool.query(
      `SELECT
         shopify_customer_gid,
         extract(epoch FROM shadow_expires_at - updated_at)::integer AS seconds
       FROM operations_shopify_customer_rate_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
       ORDER BY shopify_customer_gid`,
      [primary.organizationId, primary.integrationAccountId],
    )
    assert.deepEqual(
      intervals.rows,
      [
        { shopify_customer_gid: durationFixtures[0].gid, seconds: 900 },
        { shopify_customer_gid: durationFixtures[1].gid, seconds: 3_600 },
        { shopify_customer_gid: durationFixtures[2].gid, seconds: 14_400 },
      ],
    )

    await policies.upsertShopifyCustomerRatePolicyInPostgres({
      organizationId: other.organizationId,
      accountGlobalId: other.accountGlobalId,
      customerGid: durationFixtures[0].gid,
      mode: 'show_all',
      serviceCodes: [],
      actorEmail: other.email,
    })
    await expectRejected(
      () => rawShadowInsert(pool, primary, {
        customerGid: durationFixtures[0].gid,
        durationMinutes: 60,
      }),
      (error) => error.code === '23505',
      'An exact Customer GID must be unique inside its tenant and account',
    )

    const firstVersion = created[0].policy.rowVersion
    const updated = await policies.upsertShopifyCustomerRatePolicyInPostgres({
      organizationId: primary.organizationId,
      accountGlobalId: primary.accountGlobalId,
      customerGid: durationFixtures[0].gid,
      mode: 'hide_all',
      serviceCodes: [],
      shadowDurationMinutes: 15,
      expectedRowVersion: firstVersion,
      actorEmail: primary.email,
    })
    assert.equal(updated.policy.rowVersion, firstVersion + 1)
    await expectRejected(
      () => policies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: primary.organizationId,
        accountGlobalId: primary.accountGlobalId,
        customerGid: durationFixtures[0].gid,
        mode: 'show_all',
        serviceCodes: [],
        shadowDurationMinutes: 15,
        expectedRowVersion: firstVersion,
        actorEmail: primary.email,
      }),
      (error) => error.code === 'SHOPIFY_CUSTOMER_POLICY_STALE'
        && error.status === 409,
      'A stale row version must fail instead of overwriting policy intent',
    )

    const removed = await policies.removeShopifyCustomerRatePolicyInPostgres({
      organizationId: primary.organizationId,
      accountGlobalId: primary.accountGlobalId,
      customerGid: durationFixtures[0].gid,
      expectedRowVersion: updated.policy.rowVersion,
      actorEmail: primary.email,
    })
    assert.equal(removed.policy.status, 'removed')
    assert.equal(removed.policy.rowVersion, updated.policy.rowVersion + 1)
    assert.ok(removed.policy.removedAt)
    assert.equal(await policies.readShopifyCustomerRatePolicyFromPostgres({
      organizationId: primary.organizationId,
      accountGlobalId: primary.accountGlobalId,
      customerGid: durationFixtures[0].gid,
    }), null)
    const retained = await policies.readShopifyCustomerRatePolicyFromPostgres({
      organizationId: primary.organizationId,
      accountGlobalId: primary.accountGlobalId,
      customerGid: durationFixtures[0].gid,
      includeRemoved: true,
    })
    assert.equal(retained.status, 'removed')
    const removeReplay =
      await policies.removeShopifyCustomerRatePolicyInPostgres({
        organizationId: primary.organizationId,
        accountGlobalId: primary.accountGlobalId,
        customerGid: durationFixtures[0].gid,
        expectedRowVersion: retained.rowVersion,
        actorEmail: primary.email,
      })
    assert.equal(removeReplay.policy.rowVersion, retained.rowVersion)

    const expiringGid = durationFixtures[1].gid
    await pool.query(
      `WITH expiration AS (
         SELECT now() - interval '61 minutes' AS updated_at
       )
       UPDATE operations_shopify_customer_rate_policies policy
       SET updated_at = expiration.updated_at,
           shadow_expires_at = expiration.updated_at + interval '60 minutes'
       FROM expiration
       WHERE policy.organization_id = $1::uuid
         AND policy.integration_account_id = $2::uuid
         AND policy.shopify_customer_gid = $3`,
      [primary.organizationId, primary.integrationAccountId, expiringGid],
    )
    assert.equal(
      await policies.readActiveShopifyCustomerRatePolicyFromPostgres({
        organizationId: primary.organizationId,
        accountGlobalId: primary.accountGlobalId,
        shopifyCustomerGid: expiringGid,
      }),
      null,
      'An expired Shadow policy must fail closed',
    )
    const summary =
      await policies.readShopifyCustomerRatePolicySummaryFromPostgres({
        organizationId: primary.organizationId,
        accountGlobalId: primary.accountGlobalId,
      })
    assert.equal(summary.expiredSimulatedCount, 1)

    const guardedGid = durationFixtures[2].gid
    await expectRejected(
      () => pool.query(
        `UPDATE operations_shopify_customer_rate_policies
         SET status = 'enforced',
             provider_state = 'applied',
             provider_metafield_gid = 'gid://shopify/Metafield/1',
             provider_metafield_updated_at = now(),
             shadow_duration_minutes = NULL,
             shadow_expires_at = NULL,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND shopify_customer_gid = $3`,
        [primary.organizationId, primary.integrationAccountId, guardedGid],
      ),
      (error) => error.code === 'P0001'
        && /must remain provider-write-free/.test(error.message),
      'Operations Shadow must reject provider-written policy state',
    )
    const guarded = await pool.query(
      `SELECT status, provider_state
       FROM operations_shopify_customer_rate_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND shopify_customer_gid = $3`,
      [primary.organizationId, primary.integrationAccountId, guardedGid],
    )
    assert.deepEqual(guarded.rows[0], {
      status: 'simulated',
      provider_state: 'not_written',
    })
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container =
    `clawpilot-shopify-policy-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_shopify_policy',
      '-e', 'POSTGRES_DB=clawpilot_shopify_policy',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port from ${portOutput}`)
    const databaseUrl =
      `postgresql://postgres:clawpilot_shopify_policy@127.0.0.1:${port}`
      + '/clawpilot_shopify_policy'
    await waitForPostgres(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    await verifyPostgresAcceptance(databaseUrl)
    console.log(
      'Shopify customer rate-policy disposable PostgreSQL acceptance passed',
    )
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
