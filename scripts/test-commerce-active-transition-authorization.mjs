#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')
const contractsOnly = process.argv.includes('--contracts-only')

const organizationId = '11111111-1111-4111-8111-111111111111'
const otherOrganizationId = '22222222-2222-4222-8222-222222222222'
const pipelineId = '33333333-3333-4333-8333-333333333333'
const otherPipelineId = '44444444-4444-4444-8444-444444444444'
const ownerEmail = 'active-owner@example.test'
const otherOwnerEmail = 'other-active-owner@example.test'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(
      [
        `${binary} ${args.join(' ')} failed`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join('\n'),
    )
  }
  return String(result.stdout || '').trim()
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
  const sandbox = {
    AbortController,
    AbortSignal,
    Buffer,
    Date,
    Error,
    Headers,
    Request,
    Response,
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
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

function verifySourceContracts() {
  const migration = read(
    'db/migrations/0167_operations_commerce_active_transition_authorization.sql',
  )
  const faireFulfillmentAuthority = read(
    'db/migrations/0224_operations_faire_fulfillment_authority.sql',
  )
  const healthRoute = read('app_src/app/api/health/route.ts')
  const predeploy = read('scripts/verify-predeploy.mjs')
  assert.match(
    healthRoute,
    /faire_fulfillment_authority_applied/,
    'Health must require the Faire fulfillment authority migration',
  )
  assert.match(
    predeploy,
    /0224_operations_faire_fulfillment_authority\.sql/,
    'Predeploy must require the Faire fulfillment authority migration',
  )
  const collationRepair = read(
    'db/migrations/0199_operations_commerce_active_canonical_collation.sql',
  )
  assert.match(collationRepair, /COLLATE "C"/)
  assert.match(
    collationRepair,
    /operations_commerce_active_cohort_json_valid/,
  )
  for (const fragment of [
    'operations_commerce_active_transition_preparations',
    'operations_commerce_active_transition_authorizations',
    'operations_commerce_active_transitions',
    'operations_commerce_active_cohort_hash',
    'operations_commerce_active_preparation_is_current',
    'operations_commerce_active_capability_claim_is_current',
    'Commerce Active transition preparations are append-only',
    'Commerce Active transition authorizations are append-only',
    'Commerce Active transitions are append-only',
    "expires_at <= authorized_at + interval '5 minutes'",
    'UNIQUE (organization_id, authorization_id)',
    'UNIQUE (organization_id, from_activation_revision)',
  ]) {
    assert.ok(
      migration.includes(fragment),
      `Commerce Active migration missing ${fragment}`,
    )
  }
  for (const fragment of [
    'operations_faire_fulfillment_scope_evidence_is_current',
    'operations_faire_provider_write_scope_evidence_is_current',
    "account.configuration->>'scopeVerification' = 'oauth_grant'",
    "'READ_BRAND', 'READ_ORDERS', 'READ_SHIPMENTS', 'WRITE_ORDERS'",
    "'order_update', 'fulfillment_export', 'tracking_export'",
    'ORDER BY (cohort.member->>\'accountGlobalId\') COLLATE "C"',
    'ORDER BY scope.value COLLATE "C"',
    'ORDER BY item.value COLLATE "C"',
  ]) {
    assert.ok(
      faireFulfillmentAuthority.includes(fragment),
      `Faire fulfillment authority migration missing ${fragment}`,
    )
  }

  const persistence = read(
    'app_src/lib/persistence/commerceActiveTransitionAuthorization.ts',
  )
  for (const fragment of [
    'prepareCommerceActiveTransitionInPostgres',
    'authorizeCommerceActiveTransitionInPostgres',
    'consumeCommerceActiveTransitionAuthorizationInPostgres',
    'readCommerceActiveCapabilityClaimInPostgres',
    'requireCommerceActiveCapabilityClaimInPostgres',
    'isClawPilotCommerceCapabilityImplemented',
    'COMMERCE_ACTIVE_CAPABILITY_NOT_IMPLEMENTED',
    'requireImplementedCohort',
    'commerceActiveCohortHash',
    'providerWrites: 0',
    'credentialDecryptions: 0',
    'providerRequests: 0',
    'COMMERCE_ACTIVE_AUTHORIZATION_TTL_SECONDS = 300',
  ]) {
    assert.ok(
      persistence.includes(fragment),
      `Commerce Active persistence missing ${fragment}`,
    )
  }
  for (const forbidden of [
    'credential_ciphertext',
    'credential_iv',
    'credential_tag',
    'decryptCommerce',
    'fetch(',
  ]) {
    assert.ok(
      !persistence.includes(forbidden),
      `Commerce Active preparation must not access ${forbidden}`,
    )
  }
  for (const obsoleteCheckoutLatch of [
    'lockShopifyCarrierServiceConfigurationWriters',
    'registeredShopifyCarrierServiceRebindings',
    'applyRegisteredShopifyCarrierServiceRebindings',
    'COMMERCE_ACTIVE_SHOPIFY_CALLBACK_CONFIG_MISSING',
    'COMMERCE_ACTIVE_SHOPIFY_CALLBACK_MUTATION_UNRESOLVED',
    'operations.shopify_carrier_service.activation_revision_rebound',
    'carrierServiceRebindings:',
  ]) {
    assert.equal(
      persistence.includes(obsoleteCheckoutLatch),
      false,
      `global Active transition must not inspect or mutate checkout state via ${obsoleteCheckoutLatch}`,
    )
  }

  const capabilityCatalog = read(
    'app_src/lib/integrations/commerceCapabilities.ts',
  )
  for (const fragment of [
    'commerceCapabilityImplementationState',
    'isClawPilotCommerceCapabilityImplemented',
    "=== 'control_plane_implemented'",
  ]) {
    assert.ok(
      capabilityCatalog.includes(fragment),
      `Commerce capability registry missing ${fragment}`,
    )
  }

  const operationsUi = read(
    'app_src/components/operations/OperationsSection.tsx',
  )
  for (const fragment of [
    'implementation?: Record<',
    'selectable: implemented && scopeEligible',
    'disabled={!option.selectable}',
    "reason === 'not_implemented'",
    'Provider-supported capabilities remain',
    'commerceActiveInitialSelection({',
    'preservationBlockers.length',
    'No immediately preceding Active Shopify cohort was found',
  ]) {
    assert.ok(
      operationsUi.includes(fragment),
      `Commerce Active UI truthfulness guard missing ${fragment}`,
    )
  }
  for (const obsoleteUiLatch of [
    'readShopifyCarrierServiceActivationSetups(',
    'carrierServiceUnavailableReason',
    'SHOPIFY_CARRIER_SERVICE_GID_PATTERN',
    'Set up CarrierService first',
    'CarrierService status unavailable',
  ]) {
    assert.equal(
      operationsUi.includes(obsoleteUiLatch),
      false,
      `global Active capability review must not depend on checkout setup via ${obsoleteUiLatch}`,
    )
  }

  const integrationPersistence = read(
    'app_src/lib/persistence/commerceIntegrations.ts',
  )
  for (const fragment of [
    'commerceActiveContinuation',
    'readCommerceActiveContinuationInPostgres({ organizationId })',
  ]) {
    assert.ok(
      integrationPersistence.includes(fragment),
      `Commerce integrations state missing ${fragment}`,
    )
  }
  for (const fragment of [
    'readCommerceActiveContinuationInPostgres',
    "activation.state = 'shadow'",
    'activated.to_activation_revision = activation.revision - 1',
    'prepared.cohort',
  ]) {
    assert.ok(
      persistence.includes(fragment),
      `Commerce Active Shopify continuation read missing ${fragment}`,
    )
  }

  const selection = loadTypeScriptModule(
    'app_src/lib/operations/commerceActiveSelection.ts',
  )
  const selectionAccounts = [
    {
      accountGlobalId: 'gia-shopify-prior',
      provider: 'shopify',
      capabilities: [
        { capability: 'fulfillment_export', selectable: true, unavailableReason: null },
        { capability: 'tracking_export', selectable: true, unavailableReason: null },
        { capability: 'shipping_rate_callbacks', selectable: true, unavailableReason: null },
      ],
    },
    {
      accountGlobalId: 'gia-shopify-new',
      provider: 'shopify',
      capabilities: [
        { capability: 'shipping_rate_callbacks', selectable: true, unavailableReason: null },
      ],
    },
    {
      accountGlobalId: 'gia-faire',
      provider: 'faire',
      capabilities: [
        { capability: 'catalog_publishing', selectable: true, unavailableReason: null },
        { capability: 'order_update', selectable: true, unavailableReason: null },
        { capability: 'fulfillment_export', selectable: true, unavailableReason: null },
        { capability: 'tracking_export', selectable: true, unavailableReason: null },
      ],
    },
  ]
  const preservedSelection = JSON.parse(JSON.stringify(
    selection.commerceActiveInitialSelection({
      accounts: selectionAccounts,
      continuation: {
        sourceTransitionGlobalId: 'gcat000000000001',
        sourceActivationRevision: 2,
        shadowActivationRevision: 3,
        shopifyAccounts: [{
          accountGlobalId: 'gia-shopify-prior',
          writeCapabilities: [
            'fulfillment_export',
            'shipping_rate_callbacks',
            'tracking_export',
          ],
        }],
      },
      expectedShadowActivationRevision: 3,
    }),
  ))
  assert.deepEqual(preservedSelection.selections, {
    'gia-shopify-prior': [
      'fulfillment_export',
      'shipping_rate_callbacks',
      'tracking_export',
    ],
    'gia-shopify-new': [],
    'gia-faire': ['order_update', 'fulfillment_export', 'tracking_export'],
  })
  assert.deepEqual(preservedSelection.preservationBlockers, [])
  assert.equal(preservedSelection.preservedShopifyCapabilityCount, 3)
  assert.equal(preservedSelection.faireDefaultedAccountCount, 1)
  const blockedSelection = JSON.parse(JSON.stringify(
    selection.commerceActiveInitialSelection({
      accounts: selectionAccounts.map((account) => account.accountGlobalId
        === 'gia-shopify-prior'
        ? {
            ...account,
            capabilities: account.capabilities.map((option) => option.capability
              === 'tracking_export'
              ? { ...option, selectable: false, unavailableReason: 'missing_scope' }
              : option),
          }
        : account),
      continuation: {
        sourceTransitionGlobalId: 'gcat000000000001',
        sourceActivationRevision: 2,
        shadowActivationRevision: 3,
        shopifyAccounts: [{
          accountGlobalId: 'gia-shopify-prior',
          writeCapabilities: [
            'fulfillment_export',
            'shipping_rate_callbacks',
            'tracking_export',
          ],
        }],
      },
      expectedShadowActivationRevision: 3,
    }),
  ))
  assert.deepEqual(blockedSelection.selections['gia-shopify-prior'], [
    'fulfillment_export',
    'shipping_rate_callbacks',
  ])
  assert.equal(blockedSelection.preservationBlockers.length, 1)
  assert.match(blockedSelection.preservationBlockers[0], /missing a required scope/)
}

async function waitForPostgres(pool) {
  let lastError
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (error) {
      lastError = error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error?.code, code)
      return true
    },
  )
}

async function seedWorkspace(pool) {
  await pool.query(
    `INSERT INTO app_users (
       email, role, status, activated_at
     ) VALUES
       ($1, 'owner', 'active', now()),
       ($2, 'owner', 'active', now())`,
    [ownerEmail, otherOwnerEmail],
  )
  await pool.query(
    `INSERT INTO workspace_organizations (
       id, name, organization_type, created_by, updated_by
     ) VALUES
       ($1::uuid, 'Active cohort test', 'member', $3, $3),
       ($2::uuid, 'Other active cohort test', 'member', $4, $4)`,
    [organizationId, otherOrganizationId, ownerEmail, otherOwnerEmail],
  )
  await pool.query(
    `UPDATE app_users
     SET organization_id = CASE
       WHEN email = $1 THEN $3::uuid
       ELSE $4::uuid
     END,
     organization_name = CASE
       WHEN email = $1 THEN 'Active cohort test'
       ELSE 'Other active cohort test'
     END
     WHERE email IN ($1, $2)`,
    [ownerEmail, otherOwnerEmail, organizationId, otherOrganizationId],
  )
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, status, is_default,
       created_by, updated_by
     ) VALUES
       ($1, $3::uuid, 'owner', 'active', true, $1, $1),
       ($2, $4::uuid, 'owner', 'active', true, $2, $2)`,
    [ownerEmail, otherOwnerEmail, organizationId, otherOrganizationId],
  )
  await pool.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, is_default, workspace_organization_id
     ) VALUES
       ($1::uuid, 'Active cohort pipeline', $3, true, $5::uuid),
       ($2::uuid, 'Other cohort pipeline', $4, true, $6::uuid)`,
    [
      pipelineId,
      otherPipelineId,
      ownerEmail,
      otherOwnerEmail,
      organizationId,
      otherOrganizationId,
    ],
  )
  await pool.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, revision, reason, updated_by
     ) VALUES
       ($1::uuid, $2::uuid, 'shadow', 1, 'Active cohort test', $3),
       ($4::uuid, $5::uuid, 'shadow', 1, 'Other cohort test', $6)`,
    [
      organizationId,
      pipelineId,
      ownerEmail,
      otherOrganizationId,
      otherPipelineId,
      otherOwnerEmail,
    ],
  )
  const accounts = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id,
       provider,
       integration_type,
       environment,
       external_account_id,
       display_name,
       status,
       configuration,
       commerce_credential_generation,
       created_by,
       updated_by
     ) VALUES
       (
         $1::uuid,
         'shopify',
         'commerce',
         'production',
         'ag-alchemy.myshopify.com',
         'AG Alchemy Shopify',
         'active',
         $3::jsonb,
         1,
         $5,
         $5
       ),
       (
         $1::uuid,
         'faire',
         'commerce',
         'production',
         'faire-brand-ag-alchemy',
         'AG Alchemy Faire',
         'active',
         $4::jsonb,
         1,
         $5,
         $5
       ),
       (
         $2::uuid,
         'shopify',
         'commerce',
         'production',
         'other.myshopify.com',
         'Other Shopify',
         'active',
         $3::jsonb,
         1,
         $6,
         $6
       )
     RETURNING id::text, global_id, organization_id::text, provider`,
    [
      organizationId,
      otherOrganizationId,
      JSON.stringify({
        grantedScopes: [
          'read_locations',
          'write_inventory',
          'write_merchant_managed_fulfillment_orders',
          'write_shipping',
        ],
      }),
      JSON.stringify({
        grantedScopes: [
          'READ_SHIPMENTS',
          'WRITE_INVENTORIES',
          'WRITE_ORDERS',
        ],
      }),
      ownerEmail,
      otherOwnerEmail,
    ],
  )
  for (const account of accounts.rows) {
    const isFaire = account.provider === 'faire'
    const externalAccountId = isFaire
      ? 'faire-brand-ag-alchemy'
      : account.organization_id === organizationId
        ? 'ag-alchemy.myshopify.com'
        : 'other.myshopify.com'
    const actor = account.organization_id === organizationId
      ? ownerEmail
      : otherOwnerEmail
    await pool.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id,
         integration_account_id,
         external_account_id,
         auth_mode,
         credential_ciphertext,
         credential_iv,
         credential_tag,
         credential_version,
         credential_identifier_last_four,
         verification_status,
         verified_at,
         webhook_verification_status,
         webhook_verified_at,
         created_by,
         updated_by
       ) VALUES (
         $1::uuid,
         $2::uuid,
         $3,
         $4,
         decode('01', 'hex'),
         decode('000000000000000000000000', 'hex'),
         decode('00000000000000000000000000000000', 'hex'),
         1,
         'test',
         'verified',
         now(),
         $5,
         $6,
         $7,
         $7
       )`,
      [
        account.organization_id,
        account.id,
        externalAccountId,
        isFaire ? 'faire_oauth' : 'shopify_client_credentials',
        isFaire ? 'not_applicable' : 'verified',
        isFaire ? null : new Date(),
        actor,
      ],
    )
  }
  return {
    shopify: accounts.rows.find(
      (account) => (
        account.organization_id === organizationId
        && account.provider === 'shopify'
      ),
    ),
    faire: accounts.rows.find(
      (account) => (
        account.organization_id === organizationId
        && account.provider === 'faire'
      ),
    ),
    otherShopify: accounts.rows.find(
      (account) => account.organization_id === otherOrganizationId,
    ),
  }
}

async function seedCheckoutTransitionInvariant(pool, shopifyAccountId) {
  const warehouse = await pool.query(
    `INSERT INTO operations_warehouses (
       organization_id, code, name, created_by, updated_by
     ) VALUES (
       $1::uuid, 'ACTIVE-CHECKOUT',
       'Active checkout transition invariant warehouse', $2, $2
     ) RETURNING id::text`,
    [organizationId, ownerEmail],
  )
  const policySnapshot = {
    version: 'shopify-checkout-rating-policy-v1',
    planRateOptimization: {
      version: 'shopify-checkout-plan-rate-objective-v2',
      maxCandidates: 4,
      objectivePriority: ['landed_price', 'package_count', 'unused_cube'],
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
      mode: 'all_eligible',
    },
    checkoutRateControl: {
      version: 'shopify-checkout-rate-control-v1',
      audience: 'all_eligible',
      rateSource: 'production',
    },
  }
  await pool.query(`SET session_replication_role = 'replica'`)
  try {
    const config = await pool.query(
      `INSERT INTO operations_shopify_carrier_service_configs (
         organization_id, integration_account_id, warehouse_id,
         registration_state, service_gid, registered_service_name,
         credential_generation, activation_revision,
         callback_token_version, callback_token_hash, policy_revision,
         policy_hash, policy_snapshot, inventory_max_age_seconds,
         quote_ttl_seconds, order_reconciliation_window_seconds,
         algorithm_version, row_version, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'registered',
         'gid://shopify/DeliveryCarrierService/299900001',
         'Active transition invariant CarrierService',
         1, 1, 1, repeat('a', 64), 1, repeat('b', 64), $4::jsonb,
         900, 900, 86400, 'active-transition-invariant-v1', 7,
         $5, $5
       ) RETURNING id::text, global_id, row_version::text`,
      [
        organizationId,
        shopifyAccountId,
        warehouse.rows[0].id,
        JSON.stringify(policySnapshot),
        ownerEmail,
      ],
    )
    const aggregateHash = 'c'.repeat(64)
    const requestHash = 'd'.repeat(64)
    await pool.query(
      `INSERT INTO operations_commerce_external_effect_aggregate_fences (
         organization_id, integration_account_id, provider,
         aggregate_type, aggregate_id, aggregate_revision, aggregate_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify',
         'shopify_carrier_service_configuration', $3, 7, $4
       )`,
      [organizationId, shopifyAccountId, config.rows[0].global_id, aggregateHash],
    )
    const simulation = await pool.query(
      `INSERT INTO operations_commerce_external_effect_intents (
         organization_id, integration_account_id, provider, action,
         desired_mode, credential_generation, activation_revision,
         aggregate_type, aggregate_id, aggregate_revision, aggregate_hash,
         idempotency_key, request_hash, redacted_request, state,
         redacted_result, terminal_evidence_hash, provider_write_count,
         completed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify',
         'shopify.carrier_service.create', 'shadow', 1, 1,
         'shopify_carrier_service_configuration', $3, 7, $4,
         'active-transition-unresolved-simulation', $5,
         '{"mutation":{"operation":"create"}}'::jsonb,
         'simulated', '{"providerWrites":0}'::jsonb, repeat('f', 64),
         0, now(), $6
       ) RETURNING id::text`,
      [
        organizationId,
        shopifyAccountId,
        config.rows[0].global_id,
        aggregateHash,
        requestHash,
        ownerEmail,
      ],
    )
    await pool.query(
      `INSERT INTO operations_shopify_carrier_service_mutation_authorizations (
         organization_id, integration_account_id, config_id,
         simulation_effect_id, operation, account_environment,
         credential_generation, config_row_version, activation_state,
         activation_revision, aggregate_hash, request_hash,
         expected_service_gid, confirmation_hash,
         confirmation_statement_version, idempotency_key,
         authorized_by, authorized_role, expires_at,
         simulation_activation_revision, provider_write_activation_revision
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'create', 'production',
         1, 7, 'shadow', 1, $5, $6, NULL, repeat('e', 64),
         'shopify-carrier-service-mutation-v1',
         'active-transition-unresolved-authorization',
         $7, 'owner', now() + interval '5 minutes', 1, 1
       )`,
      [
        organizationId,
        shopifyAccountId,
        config.rows[0].id,
        simulation.rows[0].id,
        aggregateHash,
        requestHash,
        ownerEmail,
      ],
    )
    return config.rows[0]
  } finally {
    await pool.query(`SET session_replication_role = 'origin'`)
  }
}

async function checkoutTransitionEvidence(pool, configId) {
  const result = await pool.query(
    `SELECT
       to_jsonb(config) AS config,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(simulation) ORDER BY simulation.id)
         FROM operations_commerce_external_effect_intents simulation
         WHERE simulation.organization_id = config.organization_id
           AND simulation.aggregate_type =
             'shopify_carrier_service_configuration'
           AND simulation.aggregate_id = config.global_id
       ), '[]'::jsonb) AS simulations,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(auth) ORDER BY auth.id)
         FROM operations_shopify_carrier_service_mutation_authorizations
           auth
         WHERE auth.organization_id = config.organization_id
           AND auth.config_id = config.id
       ), '[]'::jsonb) AS authorizations
     FROM operations_shopify_carrier_service_configs config
     WHERE config.organization_id = $1::uuid
       AND config.id = $2::uuid`,
    [organizationId, configId],
  )
  assert.ok(result.rows[0], 'Checkout transition invariant fixture is missing')
  return result.rows[0]
}

async function verifyDisposablePostgres() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = [
    'clawpilot-commerce-active',
    process.pid,
    crypto.randomBytes(3).toString('hex'),
  ].join('-')
  let pool
  try {
    command('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      'POSTGRES_PASSWORD=commerce_active',
      '-e',
      'POSTGRES_DB=commerce_active',
      '-p',
      '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command(
      'docker',
      ['port', container, '5432/tcp'],
    )
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(
      port > 0,
      `Unable to resolve disposable PostgreSQL port from ${portOutput}`,
    )
    const databaseUrl =
      `postgresql://postgres:commerce_active@127.0.0.1:${port}/commerce_active`
    pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 2_000,
    })
    await waitForPostgres(pool)
    command('npm', ['run', 'db:migrate'], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        CLAWPILOT_STORAGE: 'postgres',
        CLAWPILOT_DB_FALLBACK_TO_FILE: 'false',
      },
      timeout: 180_000,
    })
    const canonicalScopeOrder = await pool.query(
      `SELECT operations_commerce_active_configuration_scopes(
         '{"grantedScopes":["read_customers","read_custom_fulfillment_services"]}'::jsonb
       ) AS scopes`,
    )
    assert.deepEqual(canonicalScopeOrder.rows[0].scopes, [
      'read_custom_fulfillment_services',
      'read_customers',
    ])
    const faireScopeMap = await pool.query(
      `SELECT operations_commerce_active_capability_scopes(
         'faire', 'fulfillment_export'
       ) AS scopes`,
    )
    assert.deepEqual(faireScopeMap.rows[0].scopes, [
      'READ_BRAND',
      'READ_ORDERS',
      'READ_SHIPMENTS',
      'WRITE_ORDERS',
    ])

    const postgresMock = {
      acquireTransactionAdvisoryLock: async () => undefined,
      query: (sql, params = []) => pool.query(sql, params),
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
    const auditEvents = []
    const capabilityCatalog = loadTypeScriptModule(
      'app_src/lib/integrations/commerceCapabilities.ts',
    )
    const persistence = loadTypeScriptModule(
      'app_src/lib/persistence/commerceActiveTransitionAuthorization.ts',
      {
        mocks: {
          '@/lib/auditWriter': {
            recordAuditEvent: async (event) => {
              auditEvents.push(event)
            },
          },
          '@/lib/integrations/commerceCapabilities': capabilityCatalog,
          '@/lib/persistence/operationShadowTraining': {
            assertNoOpenOperationsShadowTrainingRunsForActivation:
              async () => {},
          },
          '@/lib/persistence/postgres': postgresMock,
        },
      },
    )
    const accounts = await seedWorkspace(pool)
    assert.ok(accounts.shopify)
    assert.ok(accounts.faire)
    assert.ok(accounts.otherShopify)
    const checkoutInvariant = await seedCheckoutTransitionInvariant(
      pool,
      accounts.shopify.id,
    )
    const checkoutEvidenceBeforeModes = await checkoutTransitionEvidence(
      pool,
      checkoutInvariant.id,
    )
    await pool.query('BEGIN')
    try {
      await pool.query(
        `UPDATE operations_activation_scopes
         SET state = 'disabled', revision = revision + 1,
             reason = 'Exercise checkout-independent emergency mode',
             updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid`,
        [organizationId],
      )
      assert.deepEqual(
        await checkoutTransitionEvidence(pool, checkoutInvariant.id),
        checkoutEvidenceBeforeModes,
        'entering Disabled must not mutate registered checkout evidence',
      )
      await pool.query(
        `UPDATE operations_activation_scopes
         SET state = 'shadow', revision = revision + 1,
             reason = 'Resume checkout-independent Shadow mode',
             updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid`,
        [organizationId],
      )
      assert.deepEqual(
        await checkoutTransitionEvidence(pool, checkoutInvariant.id),
        checkoutEvidenceBeforeModes,
        'Disabled to Shadow must leave config, simulation, and unresolved authorization byte-stable',
      )
    } finally {
      await pool.query('ROLLBACK')
    }

    const selectedAccounts = [{
      accountGlobalId: accounts.shopify.global_id,
      capabilities: [
        'fulfillment_export',
        'shipping_rate_callbacks',
        'tracking_export',
      ],
    }]
    const prepared = await persistence
      .prepareCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 1,
        selectedAccounts,
        idempotencyKey: 'prepare-main',
      })
    assert.equal(prepared.replayed, false)
    assert.equal(prepared.accounts.length, 1)
    assert.deepEqual(
      [...prepared.accounts.map((account) => account.accountGlobalId)],
      [...prepared.accounts.map((account) => account.accountGlobalId)].sort(),
    )
    const databaseHash = await pool.query(
      `SELECT operations_commerce_active_cohort_hash(
         $1::uuid,
         'shadow',
         1,
         'active',
         2,
         $2::jsonb
       ) AS cohort_hash`,
      [organizationId, JSON.stringify(prepared.accounts)],
    )
    assert.equal(databaseHash.rows[0].cohort_hash, prepared.cohortHash)
    assert.equal(
      persistence.commerceActiveCohortHash({
        organizationId,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 1,
        targetActivationState: 'active',
        targetActivationRevision: 2,
        accounts: [...prepared.accounts].reverse(),
      }),
      prepared.cohortHash,
    )

    const preparedReplay = await persistence
      .prepareCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 1,
        selectedAccounts,
        idempotencyKey: 'prepare-main',
      })
    assert.equal(preparedReplay.replayed, true)
    assert.equal(
      preparedReplay.preparationGlobalId,
      prepared.preparationGlobalId,
    )

    await expectCode(
      persistence.prepareCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 1,
        selectedAccounts: [{
          accountGlobalId: accounts.otherShopify.global_id,
          capabilities: ['inventory_export'],
        }],
        idempotencyKey: 'tenant-mismatch',
      }),
      'COMMERCE_ACTIVE_ACCOUNT_NOT_FOUND',
    )
    await expectCode(
      persistence.prepareCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 1,
        selectedAccounts: [{
          accountGlobalId: accounts.faire.global_id,
          capabilities: ['inventory_export'],
        }],
        idempotencyKey: 'faire-not-implemented',
      }),
      'COMMERCE_ACTIVE_CAPABILITY_NOT_IMPLEMENTED',
    )
    const faireFulfillmentScopes = [
      'READ_BRAND',
      'READ_ORDERS',
      'READ_SHIPMENTS',
      'WRITE_ORDERS',
    ]
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = $3::jsonb,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [
        organizationId,
        accounts.faire.id,
        JSON.stringify({
          requestedScopes: faireFulfillmentScopes,
          grantedScopes: null,
          scopeVerification: 'not_exposed_by_provider',
        }),
      ],
    )
    await expectCode(
      persistence.prepareCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 1,
        selectedAccounts: [{
          accountGlobalId: accounts.faire.global_id,
          capabilities: [
            'order_update',
            'fulfillment_export',
            'tracking_export',
          ],
        }],
        idempotencyKey: 'faire-requested-scopes-only',
      }),
      'COMMERCE_ACTIVE_SCOPE_MISSING',
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = $3::jsonb,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [
        organizationId,
        accounts.faire.id,
        JSON.stringify({
          requestedScopes: faireFulfillmentScopes,
          grantedScopes: faireFulfillmentScopes,
          scopeVerification: 'oauth_grant',
        }),
      ],
    )
    const forgedFaireCapabilities = [
      'fulfillment_export',
      'order_update',
      'tracking_export',
    ]
    const forgedFaireCohort = [{
      accountId: accounts.faire.id,
      accountGlobalId: accounts.faire.global_id,
      provider: 'faire',
      environment: 'production',
      externalAccountId: 'faire-brand-ag-alchemy',
      credentialGeneration: 1,
      authMode: 'faire_oauth',
      priorAccountStatus: 'active',
      targetAccountStatus: 'active',
      grantedScopes: faireFulfillmentScopes,
      grantedScopeDigest: persistence.commerceActiveGrantedScopeDigest(
        faireFulfillmentScopes,
      ),
      writeCapabilities: forgedFaireCapabilities,
      capabilityDigest: persistence.commerceActiveCapabilityDigest(
        forgedFaireCapabilities,
      ),
    }]
    const forgedFaireDatabaseGate = await pool.query(
      `SELECT operations_commerce_active_cohort_matches_current(
         $1::uuid, $2::jsonb, 'shadow', 1, 'priorAccountStatus'
       ) AS current`,
      [organizationId, JSON.stringify(forgedFaireCohort)],
    )
    assert.equal(
      forgedFaireDatabaseGate.rows[0].current,
      false,
      'database currentness must reject self-asserted Faire grant scopes',
    )
    await expectCode(
      persistence.prepareCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 1,
        selectedAccounts: [{
          accountGlobalId: accounts.faire.global_id,
          capabilities: [
            'order_update',
            'fulfillment_export',
            'tracking_export',
          ],
        }],
        idempotencyKey: 'faire-self-asserted-granted-scopes',
      }),
      'COMMERCE_ACTIVE_FAIRE_SCOPE_EVIDENCE_REQUIRED',
    )
    await expectCode(
      persistence.prepareCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 1,
        selectedAccounts: [{
          accountGlobalId: accounts.shopify.global_id,
          capabilities: ['inventory_export'],
        }],
        idempotencyKey: 'shopify-not-implemented',
      }),
      'COMMERCE_ACTIVE_CAPABILITY_NOT_IMPLEMENTED',
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
         configuration,
         '{grantedScopes}',
         (configuration->'grantedScopes') - 'write_shipping'
       )
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [organizationId, accounts.shopify.global_id],
    )
    await expectCode(
      persistence.prepareCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 1,
        selectedAccounts: [{
          accountGlobalId: accounts.shopify.global_id,
          capabilities: ['shipping_rate_callbacks'],
        }],
        idempotencyKey: 'missing-scope',
      }),
      'COMMERCE_ACTIVE_SCOPE_MISSING',
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
         configuration,
         '{grantedScopes}',
         (configuration->'grantedScopes') || '"write_shipping"'::jsonb
       )
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [organizationId, accounts.shopify.global_id],
    )

    const authorizedForDrift = await persistence
      .authorizeCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        preparationGlobalId: prepared.preparationGlobalId,
        expectedCohortHash: prepared.cohortHash,
        idempotencyKey: 'authorize-drift',
      })
    assert.equal(authorizedForDrift.replayed, false)
    const authorizedReplay = await persistence
      .authorizeCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        preparationGlobalId: prepared.preparationGlobalId,
        expectedCohortHash: prepared.cohortHash,
        idempotencyKey: 'authorize-drift',
      })
    assert.equal(authorizedReplay.replayed, true)
    assert.equal(
      authorizedReplay.authorizationGlobalId,
      authorizedForDrift.authorizationGlobalId,
    )

    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
         configuration,
         '{grantedScopes}',
         (configuration->'grantedScopes') - 'write_shipping'
       )
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [organizationId, accounts.shopify.global_id],
    )
    await expectCode(
      persistence.consumeCommerceActiveTransitionAuthorizationInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        authorizationGlobalId:
          authorizedForDrift.authorizationGlobalId,
        expectedCohortHash: prepared.cohortHash,
        idempotencyKey: 'consume-drift',
      }),
      'COMMERCE_ACTIVE_COHORT_DRIFT',
    )
    const stillShadow = await pool.query(
      `SELECT state, revision
       FROM operations_activation_scopes
       WHERE organization_id = $1::uuid`,
      [organizationId],
    )
    assert.deepEqual(stillShadow.rows[0], {
      state: 'shadow',
      revision: 1,
    })
    assert.equal(
      Number((
        await pool.query(
          `SELECT count(*) AS count
           FROM operations_commerce_active_transitions
           WHERE organization_id = $1::uuid`,
          [organizationId],
        )
      ).rows[0].count),
      0,
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
         configuration,
         '{grantedScopes}',
         (configuration->'grantedScopes') || '"write_shipping"'::jsonb
       )
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [organizationId, accounts.shopify.global_id],
    )

    const preparedForExpiry = await persistence
      .prepareCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 1,
        selectedAccounts,
        idempotencyKey: 'prepare-expiry',
      })
    const expiredAuthorization = await pool.query(
      `INSERT INTO operations_commerce_active_transition_authorizations (
         organization_id,
         preparation_id,
         cohort_hash,
         confirmation_statement_version,
         confirmation_hash,
         idempotency_key,
         request_hash,
         authorized_by,
         authorized_role,
         authorized_at,
         expires_at
       )
       SELECT
         prepared.organization_id,
         prepared.id,
         prepared.cohort_hash,
         'commerce-active-transition-v1',
         operations_commerce_active_confirmation_hash(
           'commerce-active-transition-v1',
           prepared.cohort_hash,
           $2,
           'owner'
         ),
         'expired-auth',
         repeat('a', 64),
         $2,
         'owner',
         now() - interval '6 minutes',
         now() - interval '1 minute'
       FROM operations_commerce_active_transition_preparations prepared
       WHERE prepared.organization_id = $1::uuid
         AND prepared.global_id = $3
       RETURNING global_id`,
      [
        organizationId,
        ownerEmail,
        preparedForExpiry.preparationGlobalId,
      ],
    )
    await expectCode(
      persistence.consumeCommerceActiveTransitionAuthorizationInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        authorizationGlobalId:
          expiredAuthorization.rows[0].global_id,
        expectedCohortHash: preparedForExpiry.cohortHash,
        idempotencyKey: 'consume-expired',
      }),
      'COMMERCE_ACTIVE_AUTHORIZATION_EXPIRED',
    )

    const authorizedWithoutCarrierService = await persistence
      .authorizeCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        preparationGlobalId: preparedForExpiry.preparationGlobalId,
        expectedCohortHash: preparedForExpiry.cohortHash,
        idempotencyKey: 'authorize-main',
      })
    const authorized = authorizedWithoutCarrierService
    const activated = await persistence
      .consumeCommerceActiveTransitionAuthorizationInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        authorizationGlobalId: authorized.authorizationGlobalId,
        expectedCohortHash: preparedForExpiry.cohortHash,
        idempotencyKey: 'consume-main',
        reason: 'Activate commerce authority independent of checkout setup',
      })
    assert.equal(activated.replayed, false)
    assert.equal(activated.state, 'active')
    assert.equal(activated.revision, 2)
    assert.equal(activated.accountCount, 1)
    assert.equal(activated.capabilityCount, 3)
    assert.deepEqual(
      await checkoutTransitionEvidence(pool, checkoutInvariant.id),
      checkoutEvidenceBeforeModes,
      'Shadow to Active must not rebind checkout revision, churn rowVersion, or consume unresolved checkout evidence',
    )
    const activatedReplay = await persistence
      .consumeCommerceActiveTransitionAuthorizationInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        authorizationGlobalId: authorized.authorizationGlobalId,
        expectedCohortHash: preparedForExpiry.cohortHash,
        idempotencyKey: 'consume-main',
        reason: 'Activate commerce authority independent of checkout setup',
      })
    assert.equal(activatedReplay.replayed, true)
    assert.equal(
      activatedReplay.transitionGlobalId,
      activated.transitionGlobalId,
    )
    await expectCode(
      persistence.consumeCommerceActiveTransitionAuthorizationInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        authorizationGlobalId: authorized.authorizationGlobalId,
        expectedCohortHash: preparedForExpiry.cohortHash,
        idempotencyKey: 'consume-second-time',
        reason: 'Activate commerce authority independent of checkout setup',
      }),
      'COMMERCE_ACTIVE_CONSUMPTION_IDEMPOTENCY_CONFLICT',
    )

    const claim = await persistence
      .readCommerceActiveCapabilityClaimInPostgres({
        organizationId,
        accountGlobalId: accounts.shopify.global_id,
        capability: 'tracking_export',
        expectedActivationRevision: 2,
      })
    assert.ok(claim)
    assert.equal(claim.transitionGlobalId, activated.transitionGlobalId)
    assert.equal(claim.externalAccountId, 'ag-alchemy.myshopify.com')
    assert.equal(
      await persistence.readCommerceActiveCapabilityClaimInPostgres({
        organizationId: otherOrganizationId,
        accountGlobalId: accounts.shopify.global_id,
        capability: 'shipping_rate_callbacks',
      }),
      null,
    )

    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
         configuration,
         '{grantedScopes}',
         (configuration->'grantedScopes')
           - 'write_merchant_managed_fulfillment_orders'
       )
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [organizationId, accounts.shopify.global_id],
    )
    assert.equal(
      await persistence.readCommerceActiveCapabilityClaimInPostgres({
        organizationId,
        accountGlobalId: accounts.shopify.global_id,
        capability: 'tracking_export',
      }),
      null,
    )

    const combinedFaireScopes = [
      'READ_BRAND',
      'READ_ORDERS',
      'READ_SHIPMENTS',
      'WRITE_ORDERS',
    ]
    const credentialFingerprintSha256 = 'c'.repeat(64)
    const oauthGrantCompletedAt = new Date().toISOString()
    const credentialReference =
      `commerce-credential:${accounts.faire.id}:v1`
    const oauthGrantRequest = {
      provider: 'faire',
      operation: 'authorizationCodeExchange',
      grantType: 'AUTHORIZATION_CODE',
      requestedScopes: combinedFaireScopes,
      credentialFingerprintSha256,
      providerWrites: 0,
    }
    const oauthGrantEvidence = {
      provider: 'faire',
      operation: 'authorizationCodeExchange',
      grantType: 'AUTHORIZATION_CODE',
      tokenType: 'BEARER',
      externalAccountId: 'faire-brand-ag-alchemy',
      credentialGeneration: 1,
      requestedScopes: combinedFaireScopes,
      grantedScopes: combinedFaireScopes,
      credentialFingerprintSha256,
      providerReference: credentialFingerprintSha256,
      providerWrites: 0,
    }
    await pool.query(
      `UPDATE operations_integration_accounts
       SET credential_reference = $3,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [organizationId, accounts.faire.id, credentialReference],
    )
    const oauthGrantAttempt = await pool.query(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash, redacted_request,
         redacted_response, state, attempt_number, provider_reference,
         requested_at, completed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire.oauth.authorization_code.exchange',
         'faire-external-api-v2-oauth-authorization-code-v1', $3,
         $4, operations_faire_provider_write_request_hash($5::jsonb),
         $5::jsonb, $6::jsonb, 'succeeded', 1, $7,
         $8::timestamptz, $8::timestamptz, $9
       ) RETURNING id::text, global_id`,
      [
        organizationId,
        accounts.faire.id,
        credentialReference,
        `faire-oauth-grant:1:${credentialFingerprintSha256}`,
        JSON.stringify(oauthGrantRequest),
        JSON.stringify(oauthGrantEvidence),
        credentialFingerprintSha256,
        oauthGrantCompletedAt,
        ownerEmail,
      ],
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = $3::jsonb,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [
        organizationId,
        accounts.faire.id,
        JSON.stringify({
          authMode: 'faire_oauth',
          tokenAcquisition: 'authorization_code',
          requestedScopes: combinedFaireScopes,
          grantedScopes: combinedFaireScopes,
          scopeVerification: 'oauth_grant',
          oauthGrantTokenType: 'BEARER',
          oauthGrantCredentialFingerprintSha256:
            credentialFingerprintSha256,
          scopeProofProviderReference: credentialFingerprintSha256,
          scopeProofAttemptGlobalId: oauthGrantAttempt.rows[0].global_id,
        }),
      ],
    )
    await pool.query(
      `INSERT INTO operations_faire_provider_write_scope_evidence (
         organization_id, integration_account_id, provider_attempt_id,
         external_account_id, credential_generation, verified_write_scopes,
         verification_source, provider_reference, redacted_evidence,
         evidence_hash, observed_at, recorded_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire-brand-ag-alchemy', 1,
         ARRAY['WRITE_ORDERS']::text[], 'oauth_grant', $4, $5::jsonb,
         operations_faire_provider_write_request_hash($5::jsonb),
         $6::timestamptz, $7
       )`,
      [
        organizationId,
        accounts.faire.id,
        oauthGrantAttempt.rows[0].id,
        credentialFingerprintSha256,
        JSON.stringify(oauthGrantEvidence),
        oauthGrantCompletedAt,
        ownerEmail,
      ],
    )
    assert.equal(
      (
        await pool.query(
          `SELECT operations_faire_fulfillment_scope_evidence_is_current(
             $1::uuid, $2::uuid, 1
           ) AS current`,
          [organizationId, accounts.faire.id],
        )
      ).rows[0].current,
      true,
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration,
             '{grantedScopes}',
             (configuration->'grantedScopes')
               || '"write_merchant_managed_fulfillment_orders"'::jsonb
           ),
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [organizationId, accounts.shopify.global_id],
    )
    const returnedToShadow = await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'shadow', revision = revision + 1,
           reason = 'Extend the exact Active cohort with Faire OAuth authority',
           updated_by = $2, updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND state = 'active'
         AND revision = 2
       RETURNING state, revision`,
      [organizationId, ownerEmail],
    )
    assert.deepEqual(returnedToShadow.rows[0], {
      state: 'shadow',
      revision: 3,
    })
    assert.deepEqual(
      await checkoutTransitionEvidence(pool, checkoutInvariant.id),
      checkoutEvidenceBeforeModes,
      'Active to Shadow must not mutate registered checkout config or unresolved mutation evidence',
    )
    const continuation = await persistence
      .readCommerceActiveContinuationInPostgres({ organizationId })
    assert.equal(
      continuation.sourceTransitionGlobalId,
      activated.transitionGlobalId,
    )
    assert.equal(continuation.sourceActivationRevision, 2)
    assert.equal(continuation.shadowActivationRevision, 3)
    assert.deepEqual(
      JSON.parse(JSON.stringify(continuation.shopifyAccounts)),
      [{
        accountGlobalId: accounts.shopify.global_id,
        writeCapabilities: [
          'fulfillment_export',
          'shipping_rate_callbacks',
          'tracking_export',
        ],
      }],
    )
    const combinedSelection = [
      {
        accountGlobalId: accounts.shopify.global_id,
        capabilities: [
          'fulfillment_export',
          'shipping_rate_callbacks',
          'tracking_export',
        ],
      },
      {
        accountGlobalId: accounts.faire.global_id,
        capabilities: [
          'order_update',
          'fulfillment_export',
          'tracking_export',
        ],
      },
    ]
    const combinedPreparation = await persistence
      .prepareCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 3,
        selectedAccounts: combinedSelection,
        idempotencyKey: 'prepare-shopify-faire-oauth',
      })
    assert.equal(combinedPreparation.accounts.length, 2)
    assert.deepEqual(
      combinedPreparation.accounts.find(
        (account) => account.provider === 'shopify',
      )?.writeCapabilities,
      [
        'fulfillment_export',
        'shipping_rate_callbacks',
        'tracking_export',
      ],
    )
    assert.deepEqual(
      combinedPreparation.accounts.find(
        (account) => account.provider === 'faire',
      )?.writeCapabilities,
      ['fulfillment_export', 'order_update', 'tracking_export'],
    )
    const combinedAuthorization = await persistence
      .authorizeCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        preparationGlobalId: combinedPreparation.preparationGlobalId,
        expectedCohortHash: combinedPreparation.cohortHash,
        idempotencyKey: 'authorize-shopify-faire-oauth',
      })
    const combinedActivation = await persistence
      .consumeCommerceActiveTransitionAuthorizationInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        authorizationGlobalId:
          combinedAuthorization.authorizationGlobalId,
        expectedCohortHash: combinedPreparation.cohortHash,
        idempotencyKey: 'consume-shopify-faire-oauth',
        reason: 'Preserve Shopify and activate exact Faire fulfillment claims',
      })
    assert.equal(combinedActivation.state, 'active')
    assert.equal(combinedActivation.revision, 4)
    assert.equal(combinedActivation.accountCount, 2)
    assert.equal(combinedActivation.capabilityCount, 6)
    for (const [accountGlobalId, capabilities] of [
      [accounts.shopify.global_id, [
        'fulfillment_export',
        'shipping_rate_callbacks',
        'tracking_export',
      ]],
      [accounts.faire.global_id, [
        'order_update',
        'fulfillment_export',
        'tracking_export',
      ]],
    ]) {
      for (const capability of capabilities) {
        assert.ok(
          await persistence.readCommerceActiveCapabilityClaimInPostgres({
            organizationId,
            accountGlobalId,
            capability,
            expectedActivationRevision: 4,
          }),
          `${accountGlobalId} must retain ${capability} at Active revision 4`,
        )
      }
    }

    await assert.rejects(
      pool.query(
        `UPDATE operations_commerce_active_transition_preparations
         SET request_hash = repeat('b', 64)
         WHERE organization_id = $1::uuid
           AND global_id = $2`,
        [organizationId, prepared.preparationGlobalId],
      ),
      /append-only/,
    )
    assert.equal(
      auditEvents.filter(
        (event) => (
          event.eventType
          === 'operations.commerce.active_transition.consumed'
        ),
      ).length,
      2,
    )
  } finally {
    if (pool) await pool.end().catch(() => undefined)
    spawnSync(
      'docker',
      ['stop', '-t', '1', container],
      { cwd: root, encoding: 'utf8', timeout: 20_000 },
    )
  }
}

async function main() {
  verifySourceContracts()
  if (!contractsOnly) await verifyDisposablePostgres()
  console.log(
    `Commerce Active transition authorization contracts passed${
      contractsOnly ? '' : ' with disposable PostgreSQL'
    }`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
