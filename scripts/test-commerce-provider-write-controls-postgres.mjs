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
const containerName = `clawpilot-provider-writes-${process.pid}`

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 45_000,
    env: { ...process.env, ...options.env },
  })
  if (result.error || result.status !== 0) {
    throw result.error || new Error(
      `${binary} ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
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

function postgresAdapter(pool) {
  return {
    query: (sql, params = []) => pool.query(sql, params),
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

function loadPersistenceModule(pool, auditCalls) {
  const path = 'app_src/lib/persistence/commerceProviderWrites.ts'
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
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/auditWriter') {
        return {
          recordAuditEvent: async (input, client) => {
            auditCalls.push(input)
            await client.query(
              `INSERT INTO public.audit_events (
                 actor, event_type, aggregate_type, aggregate_id, payload,
                 event_key, subject, organization_id, is_system
               ) VALUES (
                 $1, $2, $3, $4, $5::jsonb, $6, $1, $7::uuid, false
               )
               ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
              [
                input.actor || null,
                input.eventType,
                input.aggregateType || null,
                input.aggregateId || null,
                JSON.stringify(input.payload || {}),
                input.eventKey || null,
                input.organizationId || null,
              ],
            )
          },
        }
      }
      if (specifier === '@/lib/persistence/postgres') {
        return postgresAdapter(pool)
      }
      if (specifier === '@/lib/integrations/commerceCapabilities') {
        const scopes = [
          'read_orders',
          'write_orders',
          'write_merchant_managed_fulfillment_orders',
        ]
        return {
          SHOPIFY_ACCESS_SCOPES: scopes,
          hasEffectiveShopifyScope(grantedScopes, requiredScope) {
            return grantedScopes.includes(requiredScope)
              || (
                requiredScope.startsWith('read_')
                && grantedScopes.includes(
                  `write_${requiredScope.slice('read_'.length)}`,
                )
              )
          },
        }
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

async function rejected(work, expectedCode) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `Expected ${expectedCode} rejection`)
  assert.equal(error.code, expectedCode, String(error?.message || error))
}

async function rejectedMessage(work, pattern) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `Expected rejection matching ${pattern}`)
  assert.match(String(error.message || error), pattern)
}

async function seed(pool) {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `provider-writes-owner-${suffix}@example.test`
  const memberEmail = `provider-writes-member-${suffix}@example.test`
  const restrictedEmail = `provider-writes-restricted-${suffix}@example.test`
  await pool.query(
    `INSERT INTO public.app_users (email, role, status)
     VALUES ($1, 'owner', 'active'), ($2, 'member', 'active'),
            ($3, 'member', 'active')`,
    [ownerEmail, memberEmail, restrictedEmail],
  )
  const organization = await pool.query(
    `INSERT INTO public.workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ($1, 'root', $2, $2)
     RETURNING id::text`,
    [`Provider writes ${suffix}`, ownerEmail],
  )
  const organizationId = organization.rows[0].id
  const auxiliaryOrganization = await pool.query(
    `INSERT INTO public.workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ($1, 'root', $2, $2)
     RETURNING id::text`,
    [`Provider writes auxiliary ${suffix}`, ownerEmail],
  )
  const auxiliaryOrganizationId = auxiliaryOrganization.rows[0].id
  await pool.query(
    `INSERT INTO public.app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES
       ($1, $4::uuid, 'owner', '{"manageOperations":true}'::jsonb,
        'active', true, $1, $1),
       ($2, $4::uuid, 'member', '{"manageOperations":true}'::jsonb,
        'active', true, $1, $1),
       ($3, $4::uuid, 'member', '{"manageOperations":false}'::jsonb,
        'active', true, $1, $1)`,
    [ownerEmail, memberEmail, restrictedEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO public.app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES (
       $1, $2::uuid, 'owner', '{"manageOperations":true}'::jsonb,
       'active', false, $1, $1
     )`,
    [ownerEmail, auxiliaryOrganizationId],
  )
  const pipeline = await pool.query(
    `INSERT INTO public.pipeline_spaces (
       name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1, $2, true, $3::uuid)
     RETURNING id::text`,
    [`Provider writes ${suffix}`, ownerEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO public.operations_activation_scopes (
       organization_id, data_pipeline_id, state, reason, updated_by
     ) VALUES ($1::uuid, $2::uuid, 'active', $3, $4)`,
    [
      organizationId,
      pipeline.rows[0].id,
      'Legacy profile must not authorize connected provider writes',
      ownerEmail,
    ],
  )

  async function account(input) {
    const accountOrganizationId = input.organizationId || organizationId
    const externalAccountId = `${input.provider}-${input.environment}-${randomUUID()}`
    const authMode = input.authMode || (input.provider === 'shopify'
      ? 'shopify_client_credentials'
      : 'faire_brand_token')
    const result = await pool.query(
      `INSERT INTO public.operations_integration_accounts (
         organization_id, provider, integration_type, environment,
         display_name, status, configuration, external_account_id,
         commerce_credential_generation, credential_reference,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2, 'commerce', $3, $4, 'active', $5::jsonb, $6,
         1, NULL, $7, $7
       ) RETURNING id::text, global_id`,
      [
        accountOrganizationId,
        input.provider,
        input.environment,
        input.displayName,
        JSON.stringify(input.configuration),
        externalAccountId,
        ownerEmail,
      ],
    )
    const row = result.rows[0]
    await pool.query(
      `UPDATE public.operations_integration_accounts
       SET credential_reference = $3
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [
        accountOrganizationId,
        row.id,
        `commerce-credential:${row.id}:v1`,
      ],
    )
    await pool.query(
      `INSERT INTO public.operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, last_error_code,
         webhook_verification_status, webhook_verified_at,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, decode('01', 'hex'),
         decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex'),
         1, 'test', 'verified', now(), NULL, $5,
         CASE WHEN $5 = 'verified' THEN now() ELSE NULL END, $6, $6
       )`,
      [
        accountOrganizationId,
        row.id,
        externalAccountId,
        authMode,
        input.provider === 'shopify' ? 'verified' : 'not_applicable',
        ownerEmail,
      ],
    )
    return { ...row, externalAccountId }
  }

  const shopify = await account({
    provider: 'shopify',
    environment: 'sandbox',
    displayName: 'Test Pro Bakery Shopify',
    configuration: {
      authMode: 'shopify_client_credentials',
      grantedScopes: [
        'write_orders',
        'write_merchant_managed_fulfillment_orders',
      ],
    },
  })
  const faire = await account({
    organizationId: auxiliaryOrganizationId,
    provider: 'faire',
    environment: 'production',
    displayName: 'Test Pro Bakery Faire',
    configuration: {
      authMode: 'faire_brand_token',
      grantedScopes: null,
      scopeVerification: 'not_exposed_by_provider',
    },
  })
  const faireScopes = [
    'READ_BRAND',
    'READ_ORDERS',
    'READ_SHIPMENTS',
    'WRITE_ORDERS',
  ]
  const faireCredentialFingerprint = 'd'.repeat(64)
  const faireOauth = await account({
    provider: 'faire',
    environment: 'production',
    authMode: 'faire_oauth',
    displayName: 'Test Pro Bakery Faire OAuth',
    configuration: {
      authMode: 'faire_oauth',
      tokenAcquisition: 'authorization_code',
      requestedScopes: faireScopes,
      grantedScopes: faireScopes,
      scopeVerification: 'oauth_grant',
      oauthGrantTokenType: 'BEARER',
      oauthGrantCredentialFingerprintSha256: faireCredentialFingerprint,
      scopeProofProviderReference: faireCredentialFingerprint,
      scopeProofAttemptGlobalId: 'pending',
    },
  })
  const faireScopeRequest = {
    provider: 'faire',
    operation: 'authorizationCodeExchange',
    grantType: 'AUTHORIZATION_CODE',
    requestedScopes: faireScopes,
    credentialFingerprintSha256: faireCredentialFingerprint,
    providerWrites: 0,
  }
  const faireScopeEvidence = {
    provider: 'faire',
    operation: 'authorizationCodeExchange',
    grantType: 'AUTHORIZATION_CODE',
    tokenType: 'BEARER',
    externalAccountId: faireOauth.externalAccountId,
    credentialGeneration: 1,
    requestedScopes: faireScopes,
    grantedScopes: faireScopes,
    credentialFingerprintSha256: faireCredentialFingerprint,
    providerReference: faireCredentialFingerprint,
    providerWrites: 0,
  }
  const faireScopeAttempt = await pool.query(
    `INSERT INTO public.operations_commerce_provider_attempts (
       organization_id, integration_account_id, action, adapter_version,
       external_object_id, idempotency_key, request_hash, redacted_request,
       redacted_response, state, attempt_number, provider_reference,
       requested_at, completed_at, created_by
     ) VALUES (
       $1::uuid, $2::uuid, 'faire.oauth.authorization_code.exchange',
       'faire-external-api-v2-oauth-authorization-code-v1', $3,
       $4, operations_faire_provider_write_request_hash($5::jsonb),
       $5::jsonb, $6::jsonb, 'succeeded', 1, $7,
       $9::timestamptz, $9::timestamptz, $8
     ) RETURNING id::text, global_id, completed_at`,
    [
      organizationId,
      faireOauth.id,
      `commerce-credential:${faireOauth.id}:v1`,
      `faire-oauth-grant:1:${faireCredentialFingerprint}`,
      JSON.stringify(faireScopeRequest),
      JSON.stringify(faireScopeEvidence),
      faireCredentialFingerprint,
      ownerEmail,
      new Date(),
    ],
  )
  const proof = faireScopeAttempt.rows[0]
  await pool.query(
    `UPDATE public.operations_integration_accounts
     SET configuration = jsonb_set(
       configuration,
       '{scopeProofAttemptGlobalId}',
       to_jsonb($3::text),
       true
     )
     WHERE organization_id = $1::uuid
       AND id = $2::uuid`,
    [organizationId, faireOauth.id, proof.global_id],
  )
  await pool.query(
    `INSERT INTO public.operations_faire_provider_write_scope_evidence (
       organization_id, integration_account_id, provider_attempt_id,
       external_account_id, credential_generation, verified_write_scopes,
       verification_source, provider_reference, redacted_evidence,
       evidence_hash, observed_at, recorded_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, 1, ARRAY['WRITE_ORDERS']::text[],
       'oauth_grant', $5, $6::jsonb,
       operations_faire_provider_write_request_hash($6::jsonb),
       $7::timestamptz, $8
     )`,
    [
      organizationId,
      faireOauth.id,
      proof.id,
      faireOauth.externalAccountId,
      faireCredentialFingerprint,
      JSON.stringify(faireScopeEvidence),
      proof.completed_at,
      ownerEmail,
    ],
  )
  const shopifyProductOnly = await account({
    organizationId: auxiliaryOrganizationId,
    provider: 'shopify',
    environment: 'sandbox',
    displayName: 'Order-editing-only Shopify',
    configuration: {
      authMode: 'shopify_client_credentials',
      grantedScopes: ['write_orders'],
    },
  })
  const shopifyProduction = await account({
    provider: 'shopify',
    environment: 'production',
    displayName: 'Production Shopify',
    configuration: {
      authMode: 'shopify_client_credentials',
      grantedScopes: ['read_orders', 'write_orders'],
    },
  })
  return {
    organizationId,
    auxiliaryOrganizationId,
    ownerEmail,
    memberEmail,
    restrictedEmail,
    shopify,
    faire,
    faireOauth,
    shopifyProductOnly,
    shopifyProduction,
  }
}

let pool = null
try {
  command('docker', [
    'run', '--rm', '-d', '--name', containerName,
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=clawpilot',
    '-p', '127.0.0.1::5432',
    'pgvector/pgvector:pg16',
  ])
  const published = command('docker', ['port', containerName, '5432/tcp'])
  const port = published.match(/:(\d+)$/u)?.[1]
  assert.ok(port, `Could not resolve disposable PostgreSQL port: ${published}`)
  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/clawpilot`
  await waitForPostgres(databaseUrl)
  command('node', ['scripts/db-migrate.mjs'], {
    timeout: 120_000,
    env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
  })
  pool = new Pool({ connectionString: databaseUrl })
  const tenant = await seed(pool)
  const auditCalls = []
  const persistence = loadPersistenceModule(pool, auditCalls)

  const initial = await persistence
    .readCommerceProviderWriteControlsFromPostgres({
      organizationId: tenant.organizationId,
    })
  assert.equal(initial.accounts.length, 3)
  const auxiliary = await persistence
    .readCommerceProviderWriteControlsFromPostgres({
      organizationId: tenant.auxiliaryOrganizationId,
    })
  assert.equal(auxiliary.accounts.length, 2)
  const initialShopify = initial.accounts.find(
    (account) => account.accountGlobalId === tenant.shopify.global_id,
  )
  const initialFaire = auxiliary.accounts.find(
    (account) => account.accountGlobalId === tenant.faire.global_id,
  )
  const initialFaireOauth = initial.accounts.find(
    (account) => account.accountGlobalId === tenant.faireOauth.global_id,
  )
  assert.equal(initialShopify.requestedMode, 'off')
  assert.equal(initialShopify.rowVersion, 0)
  assert.equal(initialShopify.effectiveFromDefault, true)
  assert.equal(initialShopify.enableAvailable, true)
  assert.equal(initialShopify.providerWritesEffective, false)
  assert.equal(initialShopify.fulfillmentWritesEffective, false)
  assert.equal(
    initialShopify.commandEnforcement,
    'shopify_order_management_and_fulfillment',
  )
  for (const [accounts, accountId] of [
    [initial.accounts, tenant.shopifyProduction.global_id],
  ]) {
    const disconnected = accounts.find(
      (account) => account.accountGlobalId === accountId,
    )
    assert.equal(disconnected.enableAvailable, false)
    assert.equal(disconnected.commandEnforcement, 'not_connected')
    assert.equal(disconnected.providerWritesEffective, false)
    assert.equal(
      disconnected.blocker.code,
      'COMMERCE_PROVIDER_WRITES_COMMAND_ENFORCEMENT_UNAVAILABLE',
    )
  }
  const orderEditingOnly = auxiliary.accounts.find(
    (account) => account.accountGlobalId
      === tenant.shopifyProductOnly.global_id,
  )
  assert.equal(orderEditingOnly.enableAvailable, true)
  assert.equal(orderEditingOnly.commandEnforcement, 'shopify_order_management')
  assert.equal(orderEditingOnly.providerWritesEffective, false)
  assert.equal(orderEditingOnly.fulfillmentWritesEffective, false)
  assert.match(
    orderEditingOnly.fulfillmentWritesBlockedReason,
    /Reconnect Shopify.*write_merchant_managed_fulfillment_orders.*read_orders.*write_orders/iu,
  )
  assert.equal(initialFaire.requestedMode, 'off')
  assert.equal(initialFaire.bindingStatus, 'unavailable')
  assert.equal(
    initialFaire.blocker.code,
    'COMMERCE_PROVIDER_WRITES_FAIRE_OAUTH_REQUIRED',
  )
  assert.equal(initialFaireOauth.requestedMode, 'off')
  assert.equal(initialFaireOauth.enableAvailable, true)
  assert.equal(initialFaireOauth.commandEnforcement, 'faire_fulfillment')
  assert.equal(initialFaireOauth.providerWritesEffective, false)

  const enableKey = `provider-writes-enable-${randomUUID()}`
  const enabled = await persistence.setCommerceProviderWriteControlInPostgres({
    organizationId: tenant.organizationId,
    accountGlobalId: tenant.shopify.global_id,
    mode: 'on',
    expectedRowVersion: 0,
    actorEmail: tenant.ownerEmail,
    actorRole: 'owner',
    idempotencyKey: enableKey,
  })
  assert.equal(enabled.replayed, false)
  assert.equal(enabled.control.requestedMode, 'on')
  assert.equal(enabled.control.rowVersion, 1)
  assert.equal(enabled.control.bindingStatus, 'current')
  assert.equal(enabled.control.bindingCurrent, true)
  assert.equal(enabled.control.boundCredentialGeneration, 1)
  assert.equal(
    enabled.control.commandEnforcement,
    'shopify_order_management_and_fulfillment',
  )
  assert.equal(enabled.control.providerWritesEffective, true)
  assert.equal(enabled.control.fulfillmentWritesEffective, true)
  assert.match(enabled.control.boundGrantedScopeDigest, /^[a-f0-9]{64}$/u)

  const sealedExportClient = await pool.connect()
  let sealedCommerceExportGlobalId = null
  try {
    await sealedExportClient.query('BEGIN')
    await sealedExportClient.query(
      'SET LOCAL session_replication_role = replica',
    )
    const sealedExport = await sealedExportClient.query(
      `INSERT INTO public.operations_commerce_fulfillment_exports (
         organization_id, order_id, shipment_id, provider, external_order_id,
         state, payload_snapshot, idempotency_key
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify', $4,
         'processing', '{}'::jsonb, $5
       ) RETURNING global_id`,
      [
        tenant.organizationId,
        randomUUID(),
        randomUUID(),
        'gid://shopify/Order/6567',
        `provider-writes-sealed-export-${randomUUID()}`,
      ],
    )
    sealedCommerceExportGlobalId = sealedExport.rows[0].global_id
    await sealedExportClient.query('COMMIT')
  } catch (error) {
    await sealedExportClient.query('ROLLBACK')
    throw error
  } finally {
    sealedExportClient.release()
  }
  assert.match(sealedCommerceExportGlobalId, /^gfe[0-9a-v]+$/u)

  const sealedProviderWriteAuthority = {
    accountGlobalId: tenant.shopify.global_id,
    provider: 'shopify',
    environment: 'sandbox',
    controlRowVersion: enabled.control.rowVersion,
    credentialGeneration: enabled.control.boundCredentialGeneration,
    grantedScopeDigest: enabled.control.boundGrantedScopeDigest,
  }
  const sealedProviderAttemptRequestHash = 'e'.repeat(64)
  const insertSealedProviderAttempt = async ({
    action = 'shopify.fulfillment.create',
    adapterVersion = 'shopify-fulfillment-writeback-v2',
    state = 'prepared',
    authority = sealedProviderWriteAuthority,
  } = {}) => {
    const attempt = await pool.query(
      `INSERT INTO public.operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state, attempt_number,
         requested_at, completed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7,
         jsonb_build_object('providerWriteAuthority', $8::jsonb),
         '{}'::jsonb, $9, 1, now(),
         CASE WHEN $9 = 'prepared' THEN NULL ELSE now() END, $10
       ) RETURNING global_id`,
      [
        tenant.organizationId,
        tenant.shopify.id,
        action,
        adapterVersion,
        sealedCommerceExportGlobalId,
        `provider-writes-sealed-attempt-${randomUUID()}`,
        sealedProviderAttemptRequestHash,
        JSON.stringify(authority),
        state,
        tenant.ownerEmail,
      ],
    )
    return attempt.rows[0].global_id
  }
  const sealedProviderAttemptGlobalId = await insertSealedProviderAttempt()
  const sealedAttemptInput = (overrides = {}) => ({
    organizationId: tenant.organizationId,
    accountGlobalId: tenant.shopify.global_id,
    provider: 'shopify',
    environment: 'sandbox',
    providerAttemptGlobalId: sealedProviderAttemptGlobalId,
    providerAttemptRequestHash: sealedProviderAttemptRequestHash,
    commerceExportGlobalId: sealedCommerceExportGlobalId,
    requiredScopes: [
      'read_orders',
      'write_merchant_managed_fulfillment_orders',
    ],
    expectedControlRowVersion: enabled.control.rowVersion,
    expectedCredentialGeneration: enabled.control.boundCredentialGeneration,
    expectedGrantedScopeDigest: enabled.control.boundGrantedScopeDigest,
    ...overrides,
  })
  const wrongActionAttemptGlobalId = await insertSealedProviderAttempt({
    action: 'shopify.orders.update',
  })
  const wrongAdapterAttemptGlobalId = await insertSealedProviderAttempt({
    adapterVersion: 'shopify-fulfillment-writeback-v1',
  })
  const terminalAttemptGlobalId = await insertSealedProviderAttempt({
    state: 'failed',
  })
  const wrongAuthorityAttemptGlobalId = await insertSealedProviderAttempt({
    authority: {
      ...sealedProviderWriteAuthority,
      controlRowVersion: enabled.control.rowVersion + 100,
    },
  })
  for (const invalidAttemptInput of [
    sealedAttemptInput({ providerAttemptGlobalId: 'gxa9999999' }),
    sealedAttemptInput({ organizationId: tenant.auxiliaryOrganizationId }),
    sealedAttemptInput({
      accountGlobalId: tenant.shopifyProduction.global_id,
      environment: 'production',
    }),
    sealedAttemptInput({
      providerAttemptGlobalId: wrongActionAttemptGlobalId,
    }),
    sealedAttemptInput({
      providerAttemptGlobalId: wrongAdapterAttemptGlobalId,
    }),
    sealedAttemptInput({ commerceExportGlobalId: 'gfe9999999' }),
    sealedAttemptInput({ providerAttemptGlobalId: terminalAttemptGlobalId }),
    sealedAttemptInput({ providerAttemptRequestHash: 'f'.repeat(64) }),
    sealedAttemptInput({
      providerAttemptGlobalId: wrongAuthorityAttemptGlobalId,
    }),
  ]) {
    await rejected(
      () => persistence.requireSealedCommerceProviderWritesInPostgres(
        invalidAttemptInput,
      ),
      'COMMERCE_PROVIDER_WRITES_PROVIDER_ATTEMPT_MISMATCH',
    )
  }
  await rejected(
    () => persistence.requireSealedCommerceProviderWritesInPostgres(
      sealedAttemptInput({ providerAttemptGlobalId: undefined }),
    ),
    'COMMERCE_PROVIDER_WRITES_PROVIDER_ATTEMPT_INVALID',
  )

  for (const activationState of [
    'disabled',
    'shadow',
    'read_only',
    'frozen',
    'active',
  ]) {
    await pool.query(
      `UPDATE public.operations_activation_scopes
       SET state = $2, revision = revision + 1, updated_by = $3
       WHERE organization_id = $1::uuid`,
      [tenant.organizationId, activationState, tenant.ownerEmail],
    )
    const authority = await persistence
      .requireCurrentCommerceProviderWritesInPostgres({
        organizationId: tenant.organizationId,
        accountGlobalId: tenant.shopify.global_id,
        provider: 'shopify',
        requiredScopes: [
          'read_orders',
          'write_merchant_managed_fulfillment_orders',
        ],
        expectedControlRowVersion: enabled.control.rowVersion,
        expectedCredentialGeneration:
          enabled.control.boundCredentialGeneration,
        expectedGrantedScopeDigest:
          enabled.control.boundGrantedScopeDigest,
      })
    assert.equal(authority.controlRowVersion, 1)
    assert.equal(authority.credentialGeneration, 1)
    assert.ok(
      authority.grantedScopes.includes(
        'write_merchant_managed_fulfillment_orders',
      ),
    )
  }

  const orderEditingOnlyEnabled = await persistence
    .setCommerceProviderWriteControlInPostgres({
      organizationId: tenant.auxiliaryOrganizationId,
      accountGlobalId: tenant.shopifyProductOnly.global_id,
      mode: 'on',
      expectedRowVersion: 0,
      actorEmail: tenant.ownerEmail,
      actorRole: 'owner',
      idempotencyKey: `provider-writes-order-only-${randomUUID()}`,
    })
  assert.equal(orderEditingOnlyEnabled.control.requestedMode, 'on')
  assert.equal(orderEditingOnlyEnabled.control.bindingStatus, 'current')
  assert.equal(orderEditingOnlyEnabled.control.providerWritesEffective, true)
  assert.equal(
    orderEditingOnlyEnabled.control.fulfillmentWritesEffective,
    false,
    'write_orders alone must never enable Confirm shipment',
  )
  assert.match(
    orderEditingOnlyEnabled.control.fulfillmentWritesBlockedReason,
    /Reconnect Shopify.*write_merchant_managed_fulfillment_orders/iu,
    'An already-On order-editing control must show scope guidance, not say to turn On again',
  )

  for (const [organizationId, accountGlobalId] of [
    [tenant.organizationId, tenant.shopifyProduction.global_id],
  ]) {
    await rejected(
      () => persistence.setCommerceProviderWriteControlInPostgres({
        organizationId,
        accountGlobalId,
        mode: 'on',
        expectedRowVersion: 0,
        actorEmail: tenant.ownerEmail,
        actorRole: 'owner',
        idempotencyKey: `provider-writes-disconnected-${randomUUID()}`,
      }),
      'COMMERCE_PROVIDER_WRITES_COMMAND_ENFORCEMENT_UNAVAILABLE',
    )
  }

  const replayed = await persistence.setCommerceProviderWriteControlInPostgres({
    organizationId: tenant.organizationId,
    accountGlobalId: tenant.shopify.global_id,
    mode: 'on',
    expectedRowVersion: 0,
    actorEmail: tenant.ownerEmail,
    actorRole: 'owner',
    idempotencyKey: enableKey,
  })
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.control.rowVersion, 1)
  await rejected(
    () => persistence.setCommerceProviderWriteControlInPostgres({
      organizationId: tenant.organizationId,
      accountGlobalId: tenant.shopify.global_id,
      mode: 'off',
      expectedRowVersion: 1,
      actorEmail: tenant.ownerEmail,
      actorRole: 'owner',
      idempotencyKey: enableKey,
    }),
    'COMMERCE_PROVIDER_WRITES_IDEMPOTENCY_CONFLICT',
  )
  await rejected(
    () => persistence.setCommerceProviderWriteControlInPostgres({
      organizationId: tenant.organizationId,
      accountGlobalId: tenant.shopify.global_id,
      mode: 'off',
      expectedRowVersion: 0,
      actorEmail: tenant.memberEmail,
      actorRole: 'member',
      idempotencyKey: `provider-writes-stale-${randomUUID()}`,
    }),
    'COMMERCE_PROVIDER_WRITES_ROW_VERSION_CONFLICT',
  )

  await rejectedMessage(
    () => pool.query(
      `INSERT INTO public.operations_commerce_provider_write_controls (
         organization_id, integration_account_id, provider, row_version,
         expected_row_version, requested_mode, bound_credential_generation,
         bound_granted_scopes, bound_granted_scope_digest, changed_by,
         changed_role, idempotency_key, request_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', 2, 1, 'on', 1,
         ARRAY['read_orders', 'write_orders']::text[], $3, $4, 'member',
         $5, repeat('a', 64)
       )`,
      [
        tenant.organizationId,
        tenant.shopify.id,
        enabled.control.boundGrantedScopeDigest,
        tenant.memberEmail,
        `provider-writes-member-on-${randomUUID()}`,
      ],
    ),
    /actor is not authorized/u,
  )
  await rejectedMessage(
    () => pool.query(
      `INSERT INTO public.operations_commerce_provider_write_controls (
         organization_id, integration_account_id, provider, row_version,
         expected_row_version, requested_mode, bound_credential_generation,
         bound_granted_scopes, bound_granted_scope_digest, changed_by,
         changed_role, idempotency_key, request_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', 2, 1, 'on', 1,
         ARRAY['read_orders', 'write_orders']::text[], repeat('0', 64),
         $3, 'owner', $4, repeat('b', 64)
       )`,
      [
        tenant.organizationId,
        tenant.shopify.id,
        tenant.ownerEmail,
        `provider-writes-bad-binding-${randomUUID()}`,
      ],
    ),
    /credential or scope binding is stale/u,
  )

  const disabled = await persistence.setCommerceProviderWriteControlInPostgres({
    organizationId: tenant.organizationId,
    accountGlobalId: tenant.shopify.global_id,
    mode: 'off',
    expectedRowVersion: 1,
    actorEmail: tenant.memberEmail,
    actorRole: 'member',
    idempotencyKey: `provider-writes-disable-${randomUUID()}`,
  })
  assert.equal(disabled.control.requestedMode, 'off')
  assert.equal(disabled.control.rowVersion, 2)
  assert.equal(disabled.control.boundCredentialGeneration, null)
  assert.equal(disabled.control.boundGrantedScopeDigest, null)
  const sealedWhileOff = await persistence
    .requireSealedCommerceProviderWritesInPostgres(sealedAttemptInput())
  assert.equal(sealedWhileOff.controlRowVersion, enabled.control.rowVersion)
  assert.equal(sealedWhileOff.accountGlobalId, tenant.shopify.global_id)
  assert.equal(sealedWhileOff.provider, 'shopify')
  assert.equal(sealedWhileOff.environment, 'sandbox')
  await pool.query(
    `UPDATE public.operations_activation_scopes
     SET state = 'active', revision = revision + 1, updated_by = $2
     WHERE organization_id = $1::uuid`,
    [tenant.organizationId, tenant.ownerEmail],
  )
  await rejected(
    () => persistence.requireCurrentCommerceProviderWritesInPostgres({
      organizationId: tenant.organizationId,
      accountGlobalId: tenant.shopify.global_id,
      provider: 'shopify',
      requiredScopes: [
        'read_orders',
        'write_merchant_managed_fulfillment_orders',
      ],
    }),
    'COMMERCE_PROVIDER_WRITES_OFF',
  )

  await rejectedMessage(
    () => pool.query(
      `UPDATE public.operations_commerce_provider_write_controls
       SET requested_mode = 'on'
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND row_version = 2`,
      [tenant.organizationId, tenant.shopify.id],
    ),
    /revisions are immutable/u,
  )
  await rejected(
    () => persistence.setCommerceProviderWriteControlInPostgres({
      organizationId: tenant.auxiliaryOrganizationId,
      accountGlobalId: tenant.faire.global_id,
      mode: 'on',
      expectedRowVersion: 0,
      actorEmail: tenant.ownerEmail,
      actorRole: 'owner',
      idempotencyKey: `provider-writes-faire-${randomUUID()}`,
    }),
    'COMMERCE_PROVIDER_WRITES_FAIRE_OAUTH_REQUIRED',
  )

  const enabledAgain = await persistence
    .setCommerceProviderWriteControlInPostgres({
      organizationId: tenant.organizationId,
      accountGlobalId: tenant.shopify.global_id,
      mode: 'on',
      expectedRowVersion: 2,
      actorEmail: tenant.ownerEmail,
      actorRole: 'owner',
      idempotencyKey: `provider-writes-enable-again-${randomUUID()}`,
    })
  assert.equal(enabledAgain.control.bindingCurrent, true)
  await pool.query(
    `UPDATE public.operations_integration_accounts
     SET status = 'disabled', updated_at = now(), updated_by = $3
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [tenant.organizationId, tenant.shopify.id, tenant.ownerEmail],
  )
  const drifted = await persistence
    .readCommerceProviderWriteControlsFromPostgres({
      organizationId: tenant.organizationId,
    })
  const driftedShopify = drifted.accounts.find(
    (account) => account.accountGlobalId === tenant.shopify.global_id,
  )
  assert.equal(driftedShopify.requestedMode, 'on')
  assert.equal(driftedShopify.bindingStatus, 'revalidation_required')
  assert.equal(driftedShopify.bindingCurrent, false)
  assert.equal(driftedShopify.providerWritesEffective, false)

  const safeOff = await persistence.setCommerceProviderWriteControlInPostgres({
    organizationId: tenant.organizationId,
    accountGlobalId: tenant.shopify.global_id,
    mode: 'off',
    expectedRowVersion: 3,
    actorEmail: tenant.memberEmail,
    actorRole: 'member',
    idempotencyKey: `provider-writes-safe-off-${randomUUID()}`,
  })
  assert.equal(safeOff.control.requestedMode, 'off')
  assert.equal(safeOff.control.rowVersion, 4)
  assert.equal(safeOff.control.bindingStatus, 'unavailable')

  const historicalReplay = await persistence
    .setCommerceProviderWriteControlInPostgres({
      organizationId: tenant.organizationId,
      accountGlobalId: tenant.shopify.global_id,
      mode: 'on',
      expectedRowVersion: 0,
      actorEmail: tenant.ownerEmail,
      actorRole: 'owner',
      idempotencyKey: enableKey,
    })
  assert.equal(historicalReplay.replayed, true)
  assert.equal(historicalReplay.control.rowVersion, 1)
  assert.equal(historicalReplay.control.requestedMode, 'on')
  assert.equal(historicalReplay.control.changedBy, tenant.ownerEmail)
  assert.equal(
    historicalReplay.control.boundGrantedScopeDigest,
    enabled.control.boundGrantedScopeDigest,
  )

  await rejectedMessage(
    () => pool.query(
      `INSERT INTO public.operations_commerce_provider_write_controls (
         organization_id, integration_account_id, provider, row_version,
         expected_row_version, requested_mode, changed_by, changed_role,
         idempotency_key, request_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', 5, 4, 'off', $3, 'member',
         $4, repeat('c', 64)
       )`,
      [
        tenant.organizationId,
        tenant.shopify.id,
        tenant.restrictedEmail,
        `provider-writes-restricted-off-${randomUUID()}`,
      ],
    ),
    /actor is not authorized/u,
  )

  const revisions = await pool.query(
    `SELECT row_version, requested_mode, bound_credential_generation,
            bound_granted_scope_digest, changed_by, changed_role, created_at
     FROM public.operations_commerce_provider_write_controls
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
     ORDER BY row_version`,
    [tenant.organizationId, tenant.shopify.id],
  )
  assert.deepEqual(
    revisions.rows.map((row) => [Number(row.row_version), row.requested_mode]),
    [[1, 'on'], [2, 'off'], [3, 'on'], [4, 'off']],
  )
  assert.ok(revisions.rows.every((row) => row.created_at))
  assert.equal(revisions.rows[0].changed_by, tenant.ownerEmail)
  assert.equal(revisions.rows[1].changed_by, tenant.memberEmail)
  assert.equal(revisions.rows[1].bound_credential_generation, null)
  assert.equal(revisions.rows[1].bound_granted_scope_digest, null)
  assert.equal(auditCalls.length, 5)
  assert.deepEqual(
    auditCalls.map((event) => event.eventType),
    [
      'commerce.provider_writes.turned_on',
      'commerce.provider_writes.turned_on',
      'commerce.provider_writes.turned_off',
      'commerce.provider_writes.turned_on',
      'commerce.provider_writes.turned_off',
    ],
  )
  const auditRows = await pool.query(
    `SELECT count(*)::integer AS count
     FROM public.audit_events
     WHERE organization_id = $1::uuid
       AND event_type LIKE 'commerce.provider_writes.%'`,
    [tenant.organizationId],
  )
  assert.equal(auditRows.rows[0].count, 4)

  await pool.query(
    `UPDATE public.operations_activation_scopes
     SET state = 'disabled', revision = revision + 1, updated_by = $2
     WHERE organization_id = $1::uuid`,
    [tenant.organizationId, tenant.ownerEmail],
  )
  const faireEnabled = await persistence
    .setCommerceProviderWriteControlInPostgres({
      organizationId: tenant.organizationId,
      accountGlobalId: tenant.faireOauth.global_id,
      mode: 'on',
      expectedRowVersion: 0,
      actorEmail: tenant.ownerEmail,
      actorRole: 'owner',
      idempotencyKey: `provider-writes-faire-on-${randomUUID()}`,
    })
  assert.equal(faireEnabled.control.commandEnforcement, 'faire_fulfillment')
  assert.equal(faireEnabled.control.providerWritesEffective, true)
  const faireAuthority = await persistence
    .requireCurrentCommerceProviderWritesInPostgres({
      organizationId: tenant.organizationId,
      accountGlobalId: tenant.faireOauth.global_id,
      provider: 'faire',
      requiredScopes: [
        'READ_BRAND',
        'READ_ORDERS',
        'READ_SHIPMENTS',
        'WRITE_ORDERS',
      ],
      expectedControlRowVersion: faireEnabled.control.rowVersion,
      expectedCredentialGeneration:
        faireEnabled.control.boundCredentialGeneration,
      expectedGrantedScopeDigest:
        faireEnabled.control.boundGrantedScopeDigest,
    })
  assert.equal(faireAuthority.controlRowVersion, 1)
  assert.equal(faireAuthority.environment, 'production')
  await pool.query(
    `UPDATE public.operations_activation_scopes
     SET state = 'active', revision = revision + 1, updated_by = $2
     WHERE organization_id = $1::uuid`,
    [tenant.organizationId, tenant.ownerEmail],
  )
  const faireDisabled = await persistence
    .setCommerceProviderWriteControlInPostgres({
      organizationId: tenant.organizationId,
      accountGlobalId: tenant.faireOauth.global_id,
      mode: 'off',
      expectedRowVersion: 1,
      actorEmail: tenant.ownerEmail,
      actorRole: 'owner',
      idempotencyKey: `provider-writes-faire-off-${randomUUID()}`,
    })
  assert.equal(faireDisabled.control.providerWritesEffective, false)
  await rejected(
    () => persistence.requireCurrentCommerceProviderWritesInPostgres({
      organizationId: tenant.organizationId,
      accountGlobalId: tenant.faireOauth.global_id,
      provider: 'faire',
      requiredScopes: [
        'READ_BRAND',
        'READ_ORDERS',
        'READ_SHIPMENTS',
        'WRITE_ORDERS',
      ],
    }),
    'COMMERCE_PROVIDER_WRITES_OFF',
  )

  command('node', ['scripts/test-shopify-order-management-health.mjs'], {
    timeout: 120_000,
    env: {
      SHOPIFY_ORDER_MANAGEMENT_HEALTH_DATABASE_URL: databaseUrl,
    },
  })

  console.log('Commerce Provider writes disposable-PostgreSQL acceptance passed')
} finally {
  if (pool) await pool.end().catch(() => undefined)
  spawnSync('docker', ['stop', containerName], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
}
