#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = resolve(import.meta.dirname, '..')
const requireFromScript = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')

const ORGANIZATION_ID = '29300000-0000-4000-8000-000000000001'
const SANDBOX_ACCOUNT_ID = '29300000-0000-4000-8000-000000000010'
const PRODUCTION_ACCOUNT_ID = '29300000-0000-4000-8000-000000000011'
const SANDBOX_ACCOUNT_GLOBAL_ID = 'gia2930001'
const PRODUCTION_ACCOUNT_GLOBAL_ID = 'gia2930002'
const ACTOR_EMAIL = 'checkout-audience-owner@example.test'
const RETAINED_SERVICE_GID =
  'gid://shopify/DeliveryCarrierService/2930001'
const RETAINED_CALLBACK_TOKEN_VERSION = 7
const RETAINED_CALLBACK_TOKEN_HASH = 'e'.repeat(64)

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim()
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 45_000
  let lastError = null
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
    } catch (error) {
      lastError = error
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
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
    AbortController,
    AbortSignal,
    Array,
    BigInt,
    Boolean,
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
    Uint8Array,
    clearTimeout,
    console,
    exports: module.exports,
    module,
    process,
    setTimeout,
    structuredClone,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromScript(specifier)
    },
  }, { filename: path })
  return module.exports
}

function postgresAdapter(pool) {
  return {
    query: (sql, values = []) => pool.query(sql, values),
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

async function seedFixture(pool) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [ACTOR_EMAIL],
    )
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, created_by, updated_by
       ) VALUES (
         $1::uuid, 'Checkout audience fixture', 'root', $2, $2
       )`,
      [ORGANIZATION_ID, ACTOR_EMAIL],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision
       ) VALUES (
         $1::uuid, '29300000-0000-4000-8000-000000000002'::uuid,
         'shadow', 1
       )`,
      [ORGANIZATION_ID],
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation
       ) VALUES
       (
         $2::uuid, $3, $1::uuid, 'shopify', 'commerce', 'sandbox',
         'Audience sandbox store', 'active',
         '{
           "accountName":"Audience sandbox store",
           "grantedScopes":["write_shipping"],
           "lastVerifiedAt":"2026-08-15T12:00:00.000Z"
         }'::jsonb,
         'audience-sandbox.myshopify.com', 1
       ),
       (
         $4::uuid, $5, $1::uuid, 'shopify', 'commerce', 'production',
         'Audience production store', 'active',
         '{
           "accountName":"Audience production store",
           "grantedScopes":["write_shipping"],
           "lastVerifiedAt":"2026-08-15T12:00:00.000Z"
         }'::jsonb,
         'audience-production.myshopify.com', 1
       )`,
      [
        ORGANIZATION_ID,
        SANDBOX_ACCOUNT_ID,
        SANDBOX_ACCOUNT_GLOBAL_ID,
        PRODUCTION_ACCOUNT_ID,
        PRODUCTION_ACCOUNT_GLOBAL_ID,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status
       ) VALUES
       (
         $1::uuid, $2::uuid, 'audience-sandbox.myshopify.com',
         'shopify_client_credentials', decode('01', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, '0001', 'verified', now(), 'unverified'
       ),
       (
         $1::uuid, $3::uuid, 'audience-production.myshopify.com',
         'shopify_client_credentials', decode('02', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, '0002', 'verified', now(), 'unverified'
       )`,
      [ORGANIZATION_ID, SANDBOX_ACCOUNT_ID, PRODUCTION_ACCOUNT_ID],
    )
    await client.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, address, status
       ) VALUES (
         '29300000-0000-4000-8000-000000000020'::uuid,
         'gwh2930001', $1::uuid, 'AUDIENCE', 'Audience warehouse',
         '{
           "line1":"6949 S 108th St",
           "city":"La Vista",
           "region":"NE",
           "postalCode":"68128",
           "countryCode":"US"
         }'::jsonb,
         'active'
       )`,
      [ORGANIZATION_ID],
    )
    const basePolicy = JSON.stringify({
      version: 'shopify-checkout-rating-policy-v1',
      planRateOptimization: {
        version: 'shopify-checkout-plan-rate-objective-v2',
        maxCandidates: 4,
        objectivePriority: [
          'landed_price',
          'package_count',
          'unused_cube',
        ],
        handlingCostMinorPerPackage: 0,
        handlingCostCurrency: 'USD',
      },
      checkoutRateWarm: {
        version: 'shopify-checkout-rate-warm-v1',
        enabled: false,
        mode: 'hosted_ajax',
        zoneScope: 'all_saved_rate_zones',
        concurrency: 2,
        debounceMs: 350,
        minIntervalMs: 1_000,
        supportedCountries: ['US'],
        staleCartAbort: true,
      },
      shadowCheckoutAudience: {
        version: 'shopify-checkout-audience-v1',
        mode: 'restricted_customers',
      },
    })
    await client.query(
      `INSERT INTO operations_shopify_carrier_service_configs (
         id, global_id, organization_id, integration_account_id,
         warehouse_id, service_gid, registered_service_name,
         registration_state, credential_generation, activation_revision,
         callback_token_version, callback_token_hash,
         policy_revision, policy_hash, policy_snapshot,
         inventory_max_age_seconds, quote_ttl_seconds,
         order_reconciliation_window_seconds, algorithm_version,
         row_version, created_by, updated_by
       ) VALUES
       (
         '29300000-0000-4000-8000-000000000030'::uuid,
         'gscf2930001', $1::uuid, $2::uuid,
         '29300000-0000-4000-8000-000000000020'::uuid,
         $4, 'Audience sandbox store', 'disabled', 1, 1,
         $5, $6, 1, repeat('f', 64), $7::jsonb,
         900, 900, 86400, 'checkout-audience-acceptance-v1',
         1, $8, $8
       ),
       (
         '29300000-0000-4000-8000-000000000031'::uuid,
         'gscf2930002', $1::uuid, $3::uuid,
         '29300000-0000-4000-8000-000000000020'::uuid,
         'gid://shopify/DeliveryCarrierService/2930002',
         'Audience production store', 'disabled', 1, 1,
         8, repeat('d', 64), 1, repeat('c', 64), $7::jsonb,
         900, 900, 86400, 'checkout-audience-acceptance-v1',
         1, $8, $8
       )`,
      [
        ORGANIZATION_ID,
        SANDBOX_ACCOUNT_ID,
        PRODUCTION_ACCOUNT_ID,
        RETAINED_SERVICE_GID,
        RETAINED_CALLBACK_TOKEN_VERSION,
        RETAINED_CALLBACK_TOKEN_HASH,
        basePolicy,
        ACTOR_EMAIL,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
    client.release()
  }
}

function apiRequest(body) {
  const request = new Request(
    'http://localhost/api/integrations/commerce/shopify/carrier-service',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  Object.defineProperty(request, 'nextUrl', {
    value: new URL(request.url),
  })
  return request
}

async function configRow(pool, accountGlobalId) {
  const result = await pool.query(
    `SELECT
       config.row_version::text,
       config.policy_revision::text,
       config.policy_hash,
       config.policy_snapshot,
       config.service_gid,
       config.callback_token_version,
       config.callback_token_hash
     FROM operations_shopify_carrier_service_configs config
     JOIN operations_integration_accounts account
       ON account.organization_id = config.organization_id
      AND account.id = config.integration_account_id
     WHERE config.organization_id = $1::uuid
       AND account.global_id = $2`,
    [ORGANIZATION_ID, accountGlobalId],
  )
  assert.equal(result.rows.length, 1)
  return result.rows[0]
}

async function exercise(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    max: 4,
  })
  const audits = []
  let staleSetupRead = false
  try {
    await seedFixture(pool)
    const planPolicy = loadTypeScriptModule(
      'app_src/lib/operations/shopifyCheckoutPlanRatePolicy.ts',
      {
        '../currency.ts': {
          DEFAULT_WORKSPACE_CURRENCY_CODE: 'USD',
          isIso4217CurrencyCode: (value) => (
            typeof value === 'string'
            && /^[A-Z]{3}$/u.test(value)
            && value !== 'ZZZ'
          ),
        },
      },
    )
    const rateWarmPolicy = loadTypeScriptModule(
      'app_src/lib/operations/shopifyCheckoutRateWarmPolicy.ts',
    )
    const audiencePolicy = loadTypeScriptModule(
      'app_src/lib/operations/shopifyCheckoutAudiencePolicy.ts',
    )
    const persistence = loadTypeScriptModule(
      'app_src/lib/persistence/shopifyCheckoutRating.ts',
      {
        '@/lib/auditWriter': {
          async recordAuditEvent(event) {
            audits.push(event)
          },
        },
        '@/lib/operations/shopifyCheckoutPlanRatePolicy': planPolicy,
        '@/lib/operations/shopifyCheckoutRateWarmPolicy': rateWarmPolicy,
        '@/lib/operations/shopifyCheckoutAudiencePolicy': audiencePolicy,
        '@/lib/persistence/postgres': postgresAdapter(pool),
      },
    )

    class CommerceIntegrationRequestError extends Error {
      constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
        super(message)
        this.name = 'CommerceIntegrationRequestError'
        this.status = status
        this.code = code
      }
    }
    class ShopifyCarrierServiceRegistrationError extends Error {
      constructor(message, status = 400, code = 'REGISTRATION_FAILED') {
        super(message)
        this.status = status
        this.code = code
        this.retryable = false
        this.effectGlobalId = null
      }
    }
    class ShopifyCarrierServiceMutationAuthorizationError extends Error {
      constructor(message, status = 400, code = 'AUTHORIZATION_FAILED') {
        super(message)
        this.status = status
        this.code = code
      }
    }

    const integrationState = async (organizationId) => {
      assert.equal(organizationId, ORGANIZATION_ID)
      const result = await pool.query(
        `SELECT global_id, environment, display_name, configuration,
           external_account_id
         FROM operations_integration_accounts
         WHERE organization_id = $1::uuid
           AND provider = 'shopify'
         ORDER BY global_id`,
        [ORGANIZATION_ID],
      )
      return {
        accounts: result.rows.map((row) => ({
          globalId: row.global_id,
          provider: 'shopify',
          environment: row.environment,
          displayName: row.display_name,
          status: 'active',
          configured: true,
          credentialVersion: 1,
          verificationStatus: 'verified',
          receiptIntakeEnabled: false,
          externalAccountId: row.external_account_id,
          configuration: row.configuration,
        })),
      }
    }
    const setupReference = {
      activation: { state: 'shadow', revision: 1 },
      warehouses: [],
      materials: [],
      carrierAccounts: [],
      evidence: {
        succeededReceipts: 0,
        failedReceipts: 0,
        lastReceivedAt: null,
        latest: [],
      },
    }
    const customerSummary = {
      policyCount: 1,
      simulatedCount: 1,
      shadowAllowedCount: 1,
      expiredSimulatedCount: 0,
      blockedCount: 0,
      enforcedCount: 0,
      earliestShadowExpiresAt: '2026-08-16T12:00:00.000Z',
      enforcement: {
        state: 'provider_enforcement_blocked',
        defaultPolicy: 'hide_all',
        providerWriteAvailable: false,
        providerWritesPerformed: 0,
      },
    }
    const carrierServiceRegistration = {
      executeAuthorizedShopifyCarrierServiceMutation: async () => {
        throw new Error('provider mutation must not run')
      },
      executeShopifyCarrierServiceRegistration: async () => {
        throw new Error('provider mutation must not run')
      },
      SHOPIFY_CARRIER_SERVICE_REGISTRATION_ADAPTER_VERSION: 'test',
      shopifyCarrierServiceRegistrationRequestHash: () => 'a'.repeat(64),
      ShopifyCarrierServiceRegistrationError,
      verifyShopifyCarrierServiceMutationForReconciliation: async () => {
        throw new Error('provider verification must not run')
      },
    }
    const mutationAuthorization = {
      authorizeShopifyCarrierServiceMutationInPostgres: async () => null,
      claimShopifyCarrierServiceMutationInPostgres: async () => null,
      finalizeShopifyCarrierServiceConfigMutationInPostgres: async () => null,
      finalizeShopifyCarrierServiceNameAlignmentInPostgres: async () => null,
      readShopifyCarrierServiceMutationAuthorizationFromPostgres:
        async () => null,
      readShopifyCarrierServiceMutationAuthorizationsFromPostgres:
        async () => [],
      resolveShopifyCarrierServiceMutationInPostgres: async () => null,
      shopifyCarrierServiceMutationConfirmationHash: () => 'b'.repeat(64),
      shopifyCarrierServiceMutationConfirmationVersion: 'test',
      shopifyCarrierServiceMutationResolutionConfirmationHash:
        () => 'c'.repeat(64),
      SHOPIFY_CARRIER_SERVICE_RECONCILIATION_CONFIRMATION_VERSION: 'test',
      ShopifyCarrierServiceMutationAuthorizationError,
    }
    const route = loadTypeScriptModule(
      'app_src/app/api/integrations/commerce/shopify/carrier-service/route.ts',
      {
        'next/server': {
          NextRequest: Request,
          NextResponse: {
            json(body, init = {}) {
              return {
                body,
                status: init.status || 200,
                headers: init.headers || {},
              }
            },
          },
        },
        '@/lib/integrations/commerceCredentialCrypto': {
          normalizeCommerceAccountGlobalId: (value) => value,
          shopifyCarrierServiceCallbackToken: () => 't'.repeat(43),
        },
        '@/lib/integrations/shopifyCarrierServiceRegistration':
          carrierServiceRegistration,
        '@/lib/integrations/shopifyCarrierServiceBranding': {
          shopifyStoreEntityCarrierServiceName: (value) => String(value).trim(),
        },
        '@/lib/integrations/shopifyShadowCheckoutAllowlist': {
          hasValidShopifyShadowVariantAllowlist: () => true,
        },
        '@/lib/integrations/commerceIntegrations': {
          CommerceIntegrationRequestError,
          testCommerceConnection: async () => null,
        },
        '@/lib/operations/hybridCartonization': {
          HYBRID_CARTONIZATION_ALGORITHM_VERSION: 'test',
        },
        '@/lib/operations/shopifyCheckoutPlanRatePolicy': planPolicy,
        '@/lib/operations/shopifyCheckoutRateWarmPolicy': rateWarmPolicy,
        '@/lib/operations/shopifyCheckoutAudiencePolicy': audiencePolicy,
        '@/lib/operations/authorization': {
          activeOperationsOrganizationId: () => ORGANIZATION_ID,
          operationsCapabilities: () => ({
            canManage: true,
            canActivate: true,
          }),
        },
        '@/lib/persistence/config': {
          isPostgresStorageEnabled: () => true,
        },
        '@/lib/persistence/commerceExternalEffects': {
          commerceExternalEffectHash: () => 'd'.repeat(64),
          readCommerceExternalEffectByIdempotencyFromPostgres:
            async () => null,
        },
        '@/lib/persistence/commerceIntegrations': {
          readCommerceIntegrationsStateFromPostgres: integrationState,
        },
        '@/lib/persistence/commerceStoreSync': {
          readCommerceStoreSyncControlsFromPostgres: async () => [
            SANDBOX_ACCOUNT_GLOBAL_ID,
            PRODUCTION_ACCOUNT_GLOBAL_ID,
          ].map((accountGlobalId) => ({
            accountGlobalId,
            provider: 'shopify',
            environment: accountGlobalId === SANDBOX_ACCOUNT_GLOBAL_ID
              ? 'sandbox'
              : 'production',
            displayName: accountGlobalId,
            accountStatus: 'active',
            desiredState: 'running',
            effectiveState: 'running',
            effectiveReason: 'STORE_SYNC_EXPLICIT_RUNNING',
            effectiveReasonLabel:
              'Running by an explicit Store sync choice.',
            explicitChoice: true,
            revision: 1,
            reason: 'Checkout audience fixture',
            updatedAt: '2026-08-15T12:00:00.000Z',
          })),
        },
        '@/lib/persistence/shopifyCustomerRatePolicies': {
          readShopifyCustomerRatePolicySummaryFromPostgres:
            async () => customerSummary,
        },
        '@/lib/persistence/shopifyCheckoutRating': {
          ...persistence,
          async readShopifyCarrierServiceConfigFromPostgres(input) {
            const config = await persistence
              .readShopifyCarrierServiceConfigFromPostgres(input)
            if (!config || !staleSetupRead) return config
            staleSetupRead = false
            return { ...config, rowVersion: config.rowVersion - 1 }
          },
        },
        '@/lib/persistence/shopifyCarrierServiceMutationAuthorization':
          mutationAuthorization,
        '@/lib/persistence/shopifyCarrierServiceSetup': {
          readShopifyCarrierServiceSetupReferenceFromPostgres:
            async () => setupReference,
        },
        '@/lib/publicUrl': {
          appPublicUrl: () => 'https://dev.example.test',
        },
        '@/lib/requestUser': {
          requireRequestUser: async () => ({
            email: ACTOR_EMAIL,
            role: 'owner',
            organizationId: ORGANIZATION_ID,
          }),
        },
        '@/lib/users': {
          effectiveAuthorizationRole: () => 'owner',
        },
      },
    )

    let expectedRowVersion = 1
    let expectedPolicyRevision = 1
    for (const mode of [
      'restricted_customers',
      'off',
      'all_eligible',
    ]) {
      const before = await configRow(pool, SANDBOX_ACCOUNT_GLOBAL_ID)
      const response = await route.POST(apiRequest({
        action: 'save-checkout-audience',
        accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
        shadowCheckoutAudience: {
          version: 'shopify-checkout-audience-v1',
          mode,
        },
      }))
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(response.body.ok, true)
      expectedRowVersion += 1
      expectedPolicyRevision += 1
      const after = await configRow(pool, SANDBOX_ACCOUNT_GLOBAL_ID)
      assert.equal(Number(after.row_version), expectedRowVersion)
      assert.equal(Number(after.policy_revision), expectedPolicyRevision)
      assert.equal(
        after.policy_snapshot.shadowCheckoutAudience.mode,
        mode,
      )
      assert.equal(
        after.policy_hash,
        persistence.shopifyCheckoutRatingHash(after.policy_snapshot),
      )
      assert.equal(after.service_gid, RETAINED_SERVICE_GID)
      assert.equal(
        after.callback_token_version,
        RETAINED_CALLBACK_TOKEN_VERSION,
      )
      assert.equal(
        after.callback_token_hash,
        RETAINED_CALLBACK_TOKEN_HASH,
      )
      assert.equal(after.service_gid, before.service_gid)
      assert.equal(
        after.callback_token_hash,
        before.callback_token_hash,
      )
      assert.equal(
        response.body.setup.config.shadowCheckoutAudience.mode,
        mode,
      )
    }

    const beforeStale = await configRow(pool, SANDBOX_ACCOUNT_GLOBAL_ID)
    staleSetupRead = true
    const stale = await route.POST(apiRequest({
      action: 'save-checkout-audience',
      accountGlobalId: SANDBOX_ACCOUNT_GLOBAL_ID,
      shadowCheckoutAudience: {
        version: 'shopify-checkout-audience-v1',
        mode: 'off',
      },
    }))
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT')
    assert.deepEqual(
      await configRow(pool, SANDBOX_ACCOUNT_GLOBAL_ID),
      beforeStale,
      'stale API write changed the CarrierService configuration',
    )

    const beforeProduction = await configRow(
      pool,
      PRODUCTION_ACCOUNT_GLOBAL_ID,
    )
    const production = await route.POST(apiRequest({
      action: 'save-checkout-audience',
      accountGlobalId: PRODUCTION_ACCOUNT_GLOBAL_ID,
      shadowCheckoutAudience: {
        version: 'shopify-checkout-audience-v1',
        mode: 'all_eligible',
      },
    }))
    assert.equal(production.status, 409)
    assert.equal(
      production.body.code,
      'SHOPIFY_CHECKOUT_AUDIENCE_SANDBOX_REQUIRED',
    )
    assert.deepEqual(
      await configRow(pool, PRODUCTION_ACCOUNT_GLOBAL_ID),
      beforeProduction,
      'production all-eligible rejection changed the configuration',
    )

    assert.equal(audits.length, 3)
    assert.deepEqual(
      audits.map((audit) => audit.payload.mode),
      ['restricted_customers', 'off', 'all_eligible'],
    )
    assert.ok(audits.every((audit) => (
      audit.eventType
        === 'operations.shopify_carrier_service.checkout_audience_updated'
      && audit.payload.providerRegistrationRetained === true
      && audit.payload.callbackTokenHashRetained === true
      && audit.payload.providerWrites === 0
    )))
  } finally {
    await pool.end()
  }
}

async function main() {
  const existingDatabaseUrl = String(
    process.env.SHOPIFY_CHECKOUT_AUDIENCE_ACCEPTANCE_DATABASE_URL || '',
  ).trim()
  if (existingDatabaseUrl) {
    await exercise(existingDatabaseUrl)
    console.log('Shopify checkout-audience API persistence acceptance passed')
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-checkout-audience-acceptance-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  let containerStarted = false
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=checkout_audience_acceptance',
      '-e', 'POSTGRES_DB=checkout_audience_acceptance',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    containerStarted = true
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:checkout_audience_acceptance@127.0.0.1:'
      + `${port}/checkout_audience_acceptance`
    )
    await waitForPostgres(databaseUrl)
    command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 300_000,
    })
    await exercise(databaseUrl)
  } finally {
    if (containerStarted) {
      const stopped = spawnSync('docker', ['stop', container], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      })
      if (stopped.error) throw stopped.error
    }
  }
  console.log('Shopify checkout-audience API persistence acceptance passed')
}

await main()
