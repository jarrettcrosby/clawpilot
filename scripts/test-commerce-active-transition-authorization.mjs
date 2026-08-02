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
    'lockShopifyCarrierServiceConfigurationWriters',
    'registeredShopifyCarrierServiceRebindings',
    'applyRegisteredShopifyCarrierServiceRebindings',
    "writeCapabilities.includes('shipping_rate_callbacks')",
    'operations_shopify_carrier_service_config_is_ready(',
    "'COMMERCE_ACTIVE_SHOPIFY_CALLBACK_MUTATION_UNRESOLVED'",
    'operations.shopify_carrier_service.activation_revision_rebound',
    'callbackTokenRotations: 0',
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
  const rebindStart = persistence.indexOf(
    'async function applyRegisteredShopifyCarrierServiceRebindings(',
  )
  const rebindEnd = persistence.indexOf(
    'export async function consumeCommerceActiveTransitionAuthorizationInPostgres(',
    rebindStart,
  )
  const rebindPreflightStart = persistence.indexOf(
    'async function registeredShopifyCarrierServiceRebindings(',
  )
  const rebindPreflight = persistence.slice(
    rebindPreflightStart,
    rebindStart,
  )
  assert.equal(
    rebindPreflight.includes('JOIN operations_commerce_credentials'),
    false,
    'Active rebind must enumerate every registered CarrierService even when its credential row is missing',
  )
  assert.ok(
    rebindPreflight.includes(
      'COMMERCE_ACTIVE_SHOPIFY_CALLBACK_CONFIG_MISSING',
    ),
    'Active rebind must reject a callback capability claim without a registered CarrierService',
  )
  assert.ok(
    rebindPreflight.includes('matchedCallbackAccountIds'),
    'Active rebind must prove exact registered-config coverage in both directions',
  )
  assert.equal(
    rebindPreflight.includes('row.callback_ready'),
    false,
    'Active rebind preflight must allow an explicitly authorized disabled account to become active before canonical readiness is evaluated',
  )
  assert.ok(
    rebindStart >= 0 && rebindEnd > rebindStart,
    'Commerce Active CarrierService rebind boundary is invalid',
  )
  const rebind = persistence.slice(rebindStart, rebindEnd)
  assert.ok(
    rebind.includes('callback_ready'),
    'Active rebind must prove canonical callback readiness after account activation and revision rebinding',
  )
  for (const forbiddenMutation of [
    'SET service_gid =',
    'SET callback_token_version =',
    'SET callback_token_hash =',
    'SET registered_service_name =',
    'SET policy_snapshot =',
    'SET warehouse_id =',
  ]) {
    assert.equal(
      rebind.includes(forbiddenMutation),
      false,
      `Commerce Active rebind must not mutate ${forbiddenMutation}`,
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
    "option.unavailableReason === 'not_implemented'",
    'Provider-supported capabilities remain',
  ]) {
    assert.ok(
      operationsUi.includes(fragment),
      `Commerce Active UI truthfulness guard missing ${fragment}`,
    )
  }
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
        isFaire ? 'faire_brand_token' : 'shopify_client_credentials',
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
          '@/lib/persistence/postgres': postgresMock,
        },
      },
    )
    const accounts = await seedWorkspace(pool)
    assert.ok(accounts.shopify)
    assert.ok(accounts.faire)
    assert.ok(accounts.otherShopify)

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
          capabilities: ['tracking_export'],
        }],
        idempotencyKey: 'faire-not-implemented',
      }),
      'COMMERCE_ACTIVE_CAPABILITY_NOT_IMPLEMENTED',
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
    await expectCode(
      persistence.consumeCommerceActiveTransitionAuthorizationInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        authorizationGlobalId:
          authorizedWithoutCarrierService.authorizationGlobalId,
        expectedCohortHash: preparedForExpiry.cohortHash,
        idempotencyKey: 'consume-missing-carrier-service',
        reason: 'Reject callback authority without a registered service',
      }),
      'COMMERCE_ACTIVE_SHOPIFY_CALLBACK_CONFIG_MISSING',
    )
    const selectedAccountsWithoutCallbacks = [{
      accountGlobalId: accounts.shopify.global_id,
      capabilities: [
        'fulfillment_export',
        'tracking_export',
      ],
    }]
    const preparedWithoutCallbacks = await persistence
      .prepareCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        expectedActivationState: 'shadow',
        expectedActivationRevision: 1,
        selectedAccounts: selectedAccountsWithoutCallbacks,
        idempotencyKey: 'prepare-without-callbacks',
      })
    const authorized = await persistence
      .authorizeCommerceActiveTransitionInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        preparationGlobalId:
          preparedWithoutCallbacks.preparationGlobalId,
        expectedCohortHash: preparedWithoutCallbacks.cohortHash,
        idempotencyKey: 'authorize-without-callbacks',
      })
    const activated = await persistence
      .consumeCommerceActiveTransitionAuthorizationInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        authorizationGlobalId: authorized.authorizationGlobalId,
        expectedCohortHash: preparedWithoutCallbacks.cohortHash,
        idempotencyKey: 'consume-main',
        reason: 'Activate exact verified commerce cohort',
      })
    assert.equal(activated.replayed, false)
    assert.equal(activated.state, 'active')
    assert.equal(activated.revision, 2)
    assert.equal(activated.accountCount, 1)
    assert.equal(activated.capabilityCount, 2)
    const activatedReplay = await persistence
      .consumeCommerceActiveTransitionAuthorizationInPostgres({
        organizationId,
        actorEmail: ownerEmail,
        authorizationGlobalId: authorized.authorizationGlobalId,
        expectedCohortHash: preparedWithoutCallbacks.cohortHash,
        idempotencyKey: 'consume-main',
        reason: 'Activate exact verified commerce cohort',
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
        expectedCohortHash: preparedWithoutCallbacks.cohortHash,
        idempotencyKey: 'consume-second-time',
        reason: 'Activate exact verified commerce cohort',
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
      1,
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
