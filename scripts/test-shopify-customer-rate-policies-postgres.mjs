#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')
const TARGET_MIGRATION =
  '0188_operations_shopify_shadow_test_subsidy.sql'

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

async function applyMigrationsThrough(databaseUrl, targetMigration) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
  })
  const migrationsDirectory = resolve(root, 'db/migrations')
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right))
    .filter((name) => name.localeCompare(targetMigration) <= 0)
  assert.ok(
    migrations.includes(targetMigration),
    `Missing target migration ${targetMigration}`,
  )
  const client = await pool.connect()
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('clawpilot-schema-migrations'))`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    for (const filename of migrations) {
      const sql = read(`db/migrations/${filename}`)
      const checksum = createHash('sha256').update(sql).digest('hex')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum)
           VALUES ($1, $2)`,
          [filename, checksum],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    await client.query(
      `SELECT pg_advisory_unlock(hashtext('clawpilot-schema-migrations'))`,
    ).catch(() => undefined)
    client.release()
    await pool.end()
  }
}

function customerPolicyHash(input) {
  return createHash('sha256')
    .update(JSON.stringify(input), 'utf8')
    .digest('hex')
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

async function seedLegacyUpgradeFixtures(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
  })
  try {
    const tenant = await seedTenant(pool, 'legacy-upgrade')
    const tombstoneGid = 'gid://shopify/Customer/9901'
    const timedGid = 'gid://shopify/Customer/9902'
    const legacyTimedHash = customerPolicyHash({
      version: 1,
      mode: 'show_all',
      serviceCodes: [],
      shadowDurationMinutes: 60,
    })
    await pool.query(
      `INSERT INTO operations_shopify_customer_rate_policies (
         organization_id, integration_account_id, shopify_customer_gid,
         mode, service_codes, policy_hash, status, provider_state,
         shadow_duration_minutes, shadow_expires_at, removed_at,
         created_by, updated_by
       ) VALUES
       (
         $1::uuid, $2::uuid, $3,
         'show_all', '[]'::jsonb, repeat('c', 64),
         'removed', 'not_written', NULL, NULL, now(), $5, $5
       ),
       (
         $1::uuid, $2::uuid, $4,
         'show_all', '[]'::jsonb, $6,
         'simulated', 'not_written', 60,
         now() + interval '60 minutes', NULL, $5, $5
       )`,
      [
        tenant.organizationId,
        tenant.integrationAccountId,
        tombstoneGid,
        timedGid,
        tenant.email,
        legacyTimedHash,
      ],
    )
    return {
      tenant,
      tombstoneGid,
      timedGid,
      expectedTombstoneHash: customerPolicyHash({
        version: 2,
        mode: 'show_all',
        serviceCodes: [],
        shadowLifetimeMode: null,
        shadowDurationMinutes: null,
        shadowTestChargeMode: 'carrier_rate',
        shadowTestServiceCode: null,
        shadowTestSubsidyReason: null,
      }),
      expectedTimedHash: customerPolicyHash({
        version: 2,
        mode: 'show_all',
        serviceCodes: [],
        shadowLifetimeMode: 'timed',
        shadowDurationMinutes: 60,
        shadowTestChargeMode: 'carrier_rate',
        shadowTestServiceCode: null,
        shadowTestSubsidyReason: null,
      }),
    }
  } finally {
    await pool.end()
  }
}

async function verifyLegacyUpgradeFixtures(databaseUrl, fixtures) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
  })
  try {
    const result = await pool.query(
      `SELECT shopify_customer_gid, status, provider_state,
              shadow_lifetime_mode, shadow_duration_minutes,
              shadow_expires_at, policy_hash,
              shadow_test_charge_mode, shadow_test_service_code,
              shadow_test_subsidy_reason
       FROM operations_shopify_customer_rate_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND shopify_customer_gid = ANY($3::text[])
       ORDER BY shopify_customer_gid`,
      [
        fixtures.tenant.organizationId,
        fixtures.tenant.integrationAccountId,
        [fixtures.tombstoneGid, fixtures.timedGid],
      ],
    )
    assert.equal(result.rows.length, 2)
    const [tombstone, timed] = result.rows
    assert.deepEqual(
      {
        customerGid: tombstone.shopify_customer_gid,
        status: tombstone.status,
        providerState: tombstone.provider_state,
        lifetimeMode: tombstone.shadow_lifetime_mode,
        duration: tombstone.shadow_duration_minutes,
        expiresAt: tombstone.shadow_expires_at,
        policyHash: tombstone.policy_hash,
        shadowTestChargeMode: tombstone.shadow_test_charge_mode,
        shadowTestServiceCode: tombstone.shadow_test_service_code,
        shadowTestSubsidyReason: tombstone.shadow_test_subsidy_reason,
      },
      {
        customerGid: fixtures.tombstoneGid,
        status: 'removed',
        providerState: 'not_written',
        lifetimeMode: 'none',
        duration: null,
        expiresAt: null,
        policyHash: fixtures.expectedTombstoneHash,
        shadowTestChargeMode: 'carrier_rate',
        shadowTestServiceCode: null,
        shadowTestSubsidyReason: null,
      },
      '0181 must preserve a valid fail-closed 0178 Shadow tombstone',
    )
    assert.equal(timed.shopify_customer_gid, fixtures.timedGid)
    assert.equal(timed.shadow_lifetime_mode, 'timed')
    assert.equal(Number(timed.shadow_duration_minutes), 60)
    assert.ok(timed.shadow_expires_at instanceof Date)
    assert.equal(timed.policy_hash, fixtures.expectedTimedHash)
    assert.equal(timed.shadow_test_charge_mode, 'carrier_rate')
    assert.equal(timed.shadow_test_service_code, null)
    assert.equal(timed.shadow_test_subsidy_reason, null)
  } finally {
    await pool.end()
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
       shadow_lifetime_mode, shadow_duration_minutes, shadow_expires_at,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3,
       'show_all', '[]'::jsonb, repeat('a', 64),
       'simulated', 'not_written', 'timed', $4::smallint,
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
      {
        gid: 'gid://shopify/Customer/104',
        duration: undefined,
        lifetime: 'until_turned_off',
      },
    ]
    const created = []
    for (const fixture of durationFixtures) {
      created.push(await policies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: primary.organizationId,
        accountGlobalId: primary.accountGlobalId,
        customerGid: fixture.gid,
        mode: 'show_all',
        serviceCodes: [],
        shadowLifetimeMode: fixture.lifetime,
        shadowDurationMinutes: fixture.duration,
        actorEmail: primary.email,
      }))
    }
    assert.deepEqual(
      created.map((entry) => entry.policy.shadowDurationMinutes),
      [15, 60, 240, null],
      'Timed Shadow duration and explicit indefinite lifetime must remain distinct',
    )
    assert.deepEqual(
      created.map((entry) => entry.policy.shadowLifetimeMode),
      ['timed', 'timed', 'timed', 'until_turned_off'],
      'Shadow lifetime mode must round-trip without inferring forever from NULL',
    )
    assert.deepEqual(
      created.map((entry) => entry.policy.shadowTestChargeMode),
      ['carrier_rate', 'carrier_rate', 'carrier_rate', 'carrier_rate'],
      'Normal carrier charging must remain the default',
    )
    const subsidyGid = 'gid://shopify/Customer/107'
    const subsidyReason = 'Operator-authorized zero-dollar checkout proof'
    const subsidy = await policies.upsertShopifyCustomerRatePolicyInPostgres({
      organizationId: primary.organizationId,
      accountGlobalId: primary.accountGlobalId,
      customerGid: subsidyGid,
      mode: 'show_all',
      serviceCodes: [],
      shadowTestChargeMode: 'zero_single_service',
      shadowTestServiceCode: 'clawpilot:ups:03',
      shadowTestSubsidyReason: subsidyReason,
      actorEmail: primary.email,
    })
    assert.equal(subsidy.policy.shadowTestChargeMode, 'zero_single_service')
    assert.equal(subsidy.policy.shadowTestServiceCode, 'clawpilot:ups:03')
    assert.equal(subsidy.policy.shadowTestSubsidyReason, subsidyReason)
    assert.equal(
      subsidy.policy.policyHash,
      customerPolicyHash({
        version: 2,
        mode: 'show_all',
        serviceCodes: [],
        shadowLifetimeMode: 'timed',
        shadowDurationMinutes: 60,
        shadowTestChargeMode: 'zero_single_service',
        shadowTestServiceCode: 'clawpilot:ups:03',
        shadowTestSubsidyReason: subsidyReason,
      }),
      'The semantic policy hash must bind the exact subsidy configuration',
    )
    const removedSubsidy =
      await policies.removeShopifyCustomerRatePolicyInPostgres({
        organizationId: primary.organizationId,
        accountGlobalId: primary.accountGlobalId,
        customerGid: subsidyGid,
        expectedRowVersion: subsidy.policy.rowVersion,
        actorEmail: primary.email,
      })
    assert.equal(removedSubsidy.policy.status, 'removed')
    assert.equal(removedSubsidy.policy.shadowTestChargeMode, 'carrier_rate')
    assert.equal(removedSubsidy.policy.shadowTestServiceCode, null)
    assert.equal(removedSubsidy.policy.shadowTestSubsidyReason, null)
    const intervals = await pool.query(
      `SELECT
         shopify_customer_gid,
         extract(epoch FROM shadow_expires_at - updated_at)::integer AS seconds
       FROM operations_shopify_customer_rate_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND status = 'simulated'
         AND shadow_lifetime_mode = 'timed'
       ORDER BY shopify_customer_gid`,
      [primary.organizationId, primary.integrationAccountId],
    )
    const indefinite =
      await policies.readActiveShopifyCustomerRatePolicyFromPostgres({
        organizationId: primary.organizationId,
        accountGlobalId: primary.accountGlobalId,
        shopifyCustomerGid: durationFixtures[3].gid,
      })
    assert.equal(indefinite?.shadowLifetimeMode, 'until_turned_off')
    assert.equal(indefinite?.shadowDurationMinutes, null)
    assert.equal(indefinite?.shadowExpiresAt, null)

    await expectRejected(
      () => pool.query(
        `INSERT INTO operations_shopify_customer_rate_policies (
           organization_id, integration_account_id, shopify_customer_gid,
           mode, service_codes, policy_hash, status, provider_state,
           created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, 'gid://shopify/Customer/105',
           'show_all', '[]'::jsonb, repeat('b', 64),
           'simulated', 'not_written', $3, $3
         )`,
        [primary.organizationId, primary.integrationAccountId, primary.email],
      ),
      (error) => error.code === '23514',
      'NULL duration and expiry without explicit indefinite mode must fail closed',
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
    assert.equal(summary.untilTurnedOffSimulatedCount, 1)

    const guardedGid = durationFixtures[2].gid
    await expectRejected(
      () => pool.query(
        `UPDATE operations_shopify_customer_rate_policies
         SET status = 'enforced',
             provider_state = 'applied',
             provider_metafield_gid = 'gid://shopify/Metafield/1',
             provider_metafield_updated_at = now(),
             shadow_lifetime_mode = 'none',
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

    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'active', updated_at = now(), updated_by = $2
       WHERE organization_id = $1::uuid`,
      [primary.organizationId, primary.email],
    )
    await expectRejected(
      () => policies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: primary.organizationId,
        accountGlobalId: primary.accountGlobalId,
        customerGid: 'gid://shopify/Customer/108',
        mode: 'show_all',
        serviceCodes: [],
        shadowTestChargeMode: 'zero_single_service',
        shadowTestServiceCode: 'clawpilot:ups:03',
        shadowTestSubsidyReason: 'Must remain Shadow-only',
        actorEmail: primary.email,
      }),
      (error) => (
        error.code === 'SHOPIFY_SHADOW_TEST_SUBSIDY_REQUIRES_SHADOW'
        && error.status === 409
      ),
      'Active mode must reject a zero-charge Shadow test policy',
    )
    const activeBlocked =
      await policies.upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: primary.organizationId,
        accountGlobalId: primary.accountGlobalId,
        customerGid: 'gid://shopify/Customer/106',
        mode: 'show_all',
        serviceCodes: [],
        actorEmail: primary.email,
      })
    assert.equal(activeBlocked.policy.status, 'blocked')
    assert.equal(activeBlocked.policy.providerState, 'write_blocked')
    assert.equal(activeBlocked.policy.shadowLifetimeMode, null)
    assert.equal(activeBlocked.policy.shadowDurationMinutes, null)
    assert.equal(activeBlocked.policy.shadowExpiresAt, null)
    assert.equal(activeBlocked.policy.shadowTestChargeMode, 'carrier_rate')
    assert.equal(activeBlocked.policy.shadowTestServiceCode, null)
    assert.equal(activeBlocked.policy.shadowTestSubsidyReason, null)
    assert.equal(activeBlocked.enforcement.providerWritesPerformed, 0)
    await expectRejected(
      () => pool.query(
        `UPDATE operations_shopify_customer_rate_policies
         SET shadow_test_charge_mode = 'zero_single_service',
             shadow_test_service_code = 'clawpilot:ups:03',
             shadow_test_subsidy_reason = 'Direct Active subsidy is forbidden'
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND shopify_customer_gid = 'gid://shopify/Customer/106'`,
        [primary.organizationId, primary.integrationAccountId],
      ),
      (error) => error.code === '23514' || error.code === 'P0001',
      'The database must reject a zero-charge subsidy outside simulated Shadow',
    )
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
    await applyMigrationsThrough(
      databaseUrl,
      '0178_operations_shopify_customer_rate_policies.sql',
    )
    const legacyUpgradeFixtures = await seedLegacyUpgradeFixtures(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    await verifyLegacyUpgradeFixtures(databaseUrl, legacyUpgradeFixtures)
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
