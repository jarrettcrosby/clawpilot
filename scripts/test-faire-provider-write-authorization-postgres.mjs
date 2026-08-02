#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
const root = process.cwd()
const actorEmail = 'faire-write-owner@example.com'
let runtimePool = null

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
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
    Array,
    BigInt,
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
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
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

async function applyMigrations(client) {
  const files = readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right))
  assert.ok(
    files.includes('0220_operations_faire_provider_write_authorizations.sql'),
    'Faire provider-write authorization migration is missing',
  )
  for (const file of files) {
    await client.query('BEGIN')
    try {
      await client.query(read(`db/migrations/${file}`))
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw new Error(`Migration ${file} failed`, { cause: error })
    }
  }
}

async function withRuntimeTransaction(callback) {
  assert.ok(runtimePool, 'Runtime PostgreSQL pool is not configured')
  const client = await runtimePool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

const persistenceMock = {
  acquireTransactionAdvisoryLock: (client, key) => client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
    [key],
  ),
  query(sql, values) {
    assert.ok(runtimePool, 'Runtime PostgreSQL pool is not configured')
    return runtimePool.query(sql, values)
  },
  withTransaction: withRuntimeTransaction,
}

function canonicalJson(value) {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), 'Evidence numbers must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  assert.equal(typeof value, 'object', 'Evidence must be JSON')
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`
}

function assertRedactedEvidence(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  const forbidden = /^(authorization|accesstoken|refreshtoken|clientsecret|secret|secretid|password|apikey|privatekey|xshopifyaccesstoken)$/
  const inspect = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(inspect)
    for (const [key, child] of Object.entries(node)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      assert.doesNotMatch(normalized, forbidden)
      assert.equal(normalized.endsWith('applicationsecret'), false)
      assert.equal(
        normalized.includes('faire') && normalized.endsWith('accesstoken'),
        false,
      )
      assert.equal(
        normalized.includes('faire') && normalized.endsWith('brandtoken'),
        false,
      )
      assert.equal(
        normalized.includes('faire') && normalized.endsWith('appcredentials'),
        false,
      )
      inspect(child)
    }
  }
  inspect(value)
}

const commerceExternalEffects = {
  assertRedactedCommerceExternalEffectEvidence: assertRedactedEvidence,
  commerceExternalEffectHash(value) {
    return createHash('sha256').update(canonicalJson(value)).digest('hex')
  },
}

const faireAuthorization = loadTypeScriptModule(
  'app_src/lib/persistence/faireProviderWriteAuthorization.ts',
  {
    '@/lib/auditWriter': {
      recordAuditEvent(input, client) {
        return client.query(
          `INSERT INTO audit_events (
             actor, event_type, aggregate_type, aggregate_id, payload,
             event_key, subject, organization_id, is_system
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, $9)
           ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
          [
            input.actor || null,
            input.eventType,
            input.aggregateType || null,
            input.aggregateId || null,
            JSON.stringify(input.payload || {}),
            input.eventKey || null,
            input.subject || null,
            input.organizationId || null,
            input.isSystem === true,
          ],
        )
      },
    },
    '@/lib/persistence/commerceExternalEffects': commerceExternalEffects,
    '@/lib/persistence/postgres': persistenceMock,
  },
)

async function expectAuthorizationCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.code, code)
    return true
  })
}

async function seedFixture(pool) {
  const organizationId = randomUUID()
  const pipelineId = randomUUID()
  const aggregateHash = 'a'.repeat(64)
  const request = {
    operation: 'productDraftCreate',
    draft: {
      name: 'ClawPilot Faire Test Product',
      sku: 'CLAWPILOT-FAIRE-TEST',
      wholesalePriceMinor: 100,
    },
  }
  const requestHash = commerceExternalEffects.commerceExternalEffectHash(request)
  const simulationResult = {
    provider: 'faire',
    operation: 'productDraftCreate',
    outcome: 'simulated',
    providerWrites: 0,
  }
  const simulationHash = commerceExternalEffects.commerceExternalEffectHash(
    simulationResult,
  )
  const grantedScopes = [
    'READ_PRODUCTS',
    'WRITE_PRODUCTS',
    'READ_ORDERS',
    'WRITE_ORDERS',
    'READ_BRAND',
    'READ_RETAILER',
    'READ_INVENTORIES',
    'WRITE_INVENTORIES',
    'READ_SHIPMENTS',
    'READ_REVIEWS',
  ]
  const verifiedWriteScopes = [
    'WRITE_INVENTORIES',
    'WRITE_ORDERS',
    'WRITE_PRODUCTS',
  ]
  const credentialFingerprintSha256 = 'd'.repeat(64)
  const scopeProofRequest = {
    provider: 'faire',
    operation: 'authorizationCodeExchange',
    grantType: 'AUTHORIZATION_CODE',
    requestedScopes: grantedScopes,
    credentialFingerprintSha256,
    providerWrites: 0,
  }
  const scopeEvidence = {
    provider: 'faire',
    operation: 'authorizationCodeExchange',
    grantType: 'AUTHORIZATION_CODE',
    tokenType: 'BEARER',
    externalAccountId: 'faire-brand-acceptance',
    credentialGeneration: 1,
    requestedScopes: grantedScopes,
    grantedScopes,
    credentialFingerprintSha256,
    providerReference: credentialFingerprintSha256,
    providerWrites: 0,
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO app_users (email, role, status, activated_at)
       VALUES ($1, 'owner', 'active', clock_timestamp())`,
      [actorEmail],
    )
    await client.query(
      `INSERT INTO workspace_organizations (id, name, created_by, updated_by)
       VALUES ($1::uuid, 'Faire write authorization acceptance', $2, $2)`,
      [organizationId, actorEmail],
    )
    await client.query(
      `UPDATE app_users
       SET organization_id = $2::uuid,
           organization_name = 'Faire write authorization acceptance'
       WHERE email = $1`,
      [actorEmail, organizationId],
    )
    await client.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, status, is_default,
         created_by, updated_by
       ) VALUES ($1, $2::uuid, 'owner', 'active', true, $1, $1)`,
      [actorEmail, organizationId],
    )
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, is_default, workspace_organization_id
       ) VALUES ($1::uuid, 'Faire acceptance pipeline', $2, true, $3::uuid)`,
      [pipelineId, actorEmail, organizationId],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision, reason, updated_by
       ) VALUES ($1::uuid, $2::uuid, 'shadow', 7,
                 'Faire exact-write acceptance', $3)`,
      [organizationId, pipelineId, actorEmail],
    )
    const account = await client.query(
      `INSERT INTO operations_integration_accounts (
         organization_id, provider, integration_type, environment,
         display_name, status, configuration, external_account_id,
         commerce_credential_generation, created_by, updated_by
       ) VALUES (
         $1::uuid, 'faire', 'commerce', 'production',
         'Faire production acceptance', 'active',
         $3::jsonb,
         'faire-brand-acceptance', 1, $2, $2
       ) RETURNING id::text, global_id`,
      [
        organizationId,
        actorEmail,
        JSON.stringify({
          authMode: 'faire_oauth',
          tokenAcquisition: 'authorization_code',
          requestedScopes: grantedScopes,
          grantedScopes: null,
          scopeVerification: 'requested_only',
        }),
      ],
    )
    const accountId = account.rows[0].id
    await client.query(
      `UPDATE operations_integration_accounts
       SET credential_reference = $3
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [
        organizationId,
        accountId,
        `commerce-credential:${accountId}:v1`,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire-brand-acceptance', 'faire_oauth',
         decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 1, 'TEST', 'verified',
         clock_timestamp(), 'not_applicable', $3, $3
       )`,
      [organizationId, accountId, actorEmail],
    )
    await client.query(
      `INSERT INTO operations_commerce_external_effect_aggregate_fences (
         organization_id, integration_account_id, provider, aggregate_type,
         aggregate_id, aggregate_revision, aggregate_hash
       ) VALUES
         ($1::uuid, $2::uuid, 'faire', 'commerce.product',
          'test-product', 3, $3),
         ($1::uuid, $2::uuid, 'faire', 'commerce.product',
          'stale-product', 3, $4)`,
      [organizationId, accountId, aggregateHash, 'b'.repeat(64)],
    )
    const staleSimulation = await client.query(
      `INSERT INTO operations_commerce_external_effect_intents (
         organization_id, integration_account_id, provider, action,
         desired_mode, credential_generation, activation_revision,
         aggregate_type, aggregate_id, aggregate_revision, aggregate_hash,
         idempotency_key, request_hash, redacted_request, state,
         redacted_result, terminal_evidence_hash, provider_write_count,
         completed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire', 'faire.product.draft.create',
         'shadow', 1, 7, 'commerce.product', 'stale-product', 3, $3,
         'faire-shadow-stale-product-v1', $4, $5::jsonb, 'simulated',
         $6::jsonb, $7, 0, clock_timestamp(), $8
       ) RETURNING global_id`,
      [
        organizationId,
        accountId,
        'b'.repeat(64),
        requestHash,
        JSON.stringify(request),
        JSON.stringify(simulationResult),
        simulationHash,
        actorEmail,
      ],
    )
    const simulation = await client.query(
      `INSERT INTO operations_commerce_external_effect_intents (
         organization_id, integration_account_id, provider, action,
         desired_mode, credential_generation, activation_revision,
         aggregate_type, aggregate_id, aggregate_revision, aggregate_hash,
         idempotency_key, request_hash, redacted_request, state,
         redacted_result, terminal_evidence_hash, provider_write_count,
         completed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire', 'faire.product.draft.create',
         'shadow', 1, 7, 'commerce.product', 'test-product', 3, $3,
         'faire-shadow-test-product-v1', $4, $5::jsonb, 'simulated',
         $6::jsonb, $7, 0, clock_timestamp(), $8
       ) RETURNING global_id`,
      [
        organizationId,
        accountId,
        aggregateHash,
        requestHash,
        JSON.stringify(request),
        JSON.stringify(simulationResult),
        simulationHash,
        actorEmail,
      ],
    )
    const scopeProofAttempt = await client.query(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash, redacted_request,
         redacted_response, state, attempt_number, provider_reference,
         completed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire.oauth.authorization_code.exchange',
         'faire-external-api-v2-oauth-authorization-code-v1',
         $6,
         'faire-oauth-grant:1:${credentialFingerprintSha256}',
         operations_faire_provider_write_request_hash($3::jsonb),
         $3::jsonb, $4::jsonb, 'succeeded', 1,
         '${credentialFingerprintSha256}',
         date_trunc('milliseconds', clock_timestamp()), $5
       ) RETURNING id::text, global_id, completed_at`,
      [
        organizationId,
        accountId,
        JSON.stringify(scopeProofRequest),
        JSON.stringify(scopeEvidence),
        actorEmail,
        `commerce-credential:${accountId}:v1`,
      ],
    )
    const proof = scopeProofAttempt.rows[0]
    const evidenceInsert = `INSERT INTO
       operations_faire_provider_write_scope_evidence (
         organization_id, integration_account_id, provider_attempt_id,
         external_account_id, credential_generation, verified_write_scopes,
         verification_source, provider_reference, redacted_evidence,
         evidence_hash, observed_at, recorded_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire-brand-acceptance', 1,
         $7::text[], 'oauth_grant',
         '${credentialFingerprintSha256}', $4::jsonb,
         operations_faire_provider_write_request_hash($4::jsonb),
         $5::timestamptz, $6
       ) RETURNING id::text, global_id`
    await client.query(
      `UPDATE operations_integration_accounts
       SET configuration = $3::jsonb
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [
        organizationId,
        accountId,
        JSON.stringify({
          authMode: 'faire_oauth',
          tokenAcquisition: 'authorization_code',
          requestedScopes: grantedScopes,
          grantedScopes: null,
          scopeVerification: 'requested_only',
          oauthGrantTokenType: 'BEARER',
          oauthGrantCredentialFingerprintSha256:
            credentialFingerprintSha256,
          scopeProofProviderReference: credentialFingerprintSha256,
          scopeProofAttemptGlobalId: proof.global_id,
        }),
      ],
    )

    const evidenceValues = (redactedEvidence = scopeEvidence) => [
      organizationId,
      accountId,
      proof.id,
      JSON.stringify(redactedEvidence),
      proof.completed_at,
      actorEmail,
      verifiedWriteScopes,
    ]
    await client.query('SAVEPOINT requested_only_scope_proof')
    await assert.rejects(
      client.query(evidenceInsert, evidenceValues()),
      /does not match the current credential grant/,
    )
    await client.query('ROLLBACK TO SAVEPOINT requested_only_scope_proof')
    await client.query('RELEASE SAVEPOINT requested_only_scope_proof')

    const grantConfiguration = {
      authMode: 'faire_oauth',
      tokenAcquisition: 'authorization_code',
      requestedScopes: grantedScopes,
      grantedScopes,
      scopeVerification: 'oauth_grant',
      oauthGrantTokenType: 'BEARER',
      oauthGrantCredentialFingerprintSha256: credentialFingerprintSha256,
      scopeProofProviderReference: credentialFingerprintSha256,
      scopeProofAttemptGlobalId: proof.global_id,
    }
    await client.query(
      `UPDATE operations_integration_accounts
       SET configuration = $3::jsonb
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [organizationId, accountId, JSON.stringify(grantConfiguration)],
    )

    for (const [name, malformedEvidence] of [
      ['non_bearer', { ...scopeEvidence, tokenType: 'MAC' }],
      ['unsupported_scope', {
        ...scopeEvidence,
        requestedScopes: [...grantedScopes, 'WRITE_EVERYTHING'],
        grantedScopes: [...grantedScopes, 'WRITE_EVERYTHING'],
      }],
      ['mismatched_reference', {
        ...scopeEvidence,
        credentialFingerprintSha256: 'e'.repeat(64),
        providerReference: 'e'.repeat(64),
      }],
    ]) {
      await client.query(`SAVEPOINT ${name}`)
      await assert.rejects(
        client.query(evidenceInsert, evidenceValues(malformedEvidence)),
        /does not match the current credential grant/,
      )
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
      await client.query(`RELEASE SAVEPOINT ${name}`)
    }

    const evidence = await client.query(evidenceInsert, evidenceValues())
    const productionGate = await client.query(
      `SELECT operations_faire_provider_write_scope_evidence_is_current(
         $1::uuid, $2::uuid, $3::uuid, 1
       ) AS current`,
      [organizationId, evidence.rows[0].id, accountId],
    )
    assert.equal(productionGate.rows[0].current, true)

    await client.query('SAVEPOINT later_connection_verification')
    await client.query(
      `UPDATE operations_commerce_credentials
       SET verified_at = verified_at + interval '30 days'
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [organizationId, accountId],
    )
    const laterVerificationGate = await client.query(
      `SELECT operations_faire_provider_write_scope_evidence_is_current(
         $1::uuid, $2::uuid, $3::uuid, 1
       ) AS current`,
      [organizationId, evidence.rows[0].id, accountId],
    )
    assert.equal(laterVerificationGate.rows[0].current, true)
    await client.query('ROLLBACK TO SAVEPOINT later_connection_verification')
    await client.query('RELEASE SAVEPOINT later_connection_verification')

    const scopeCapabilities = await client.query(
      `SELECT
         operations_faire_provider_write_scope_evidence_is_current(
           $1::uuid, $2::uuid, $3::uuid, 1
         )
         AND evidence.verified_write_scopes @>
           ARRAY['WRITE_PRODUCTS']::text[] AS write_products,
         operations_faire_fulfillment_scope_evidence_is_current(
           $1::uuid, $3::uuid, 1
         ) AS write_orders
       FROM operations_faire_provider_write_scope_evidence evidence
       WHERE evidence.organization_id = $1::uuid
         AND evidence.id = $2::uuid
         AND evidence.integration_account_id = $3::uuid`,
      [organizationId, evidence.rows[0].id, accountId],
    )
    assert.deepEqual(scopeCapabilities.rows[0], {
      write_products: true,
      write_orders: true,
    })

    const verifyMissingGrantScope = async (
      missingScope,
      expectedProductWrite,
      expectedOrderWrite,
    ) => {
      const scopedGrant = grantedScopes.filter(
        (scope) => scope !== missingScope,
      )
      const scopedWriteGrant = verifiedWriteScopes.filter(
        (scope) => scope !== missingScope,
      )
      const scopedRequest = {
        ...scopeProofRequest,
        requestedScopes: scopedGrant,
      }
      const scopedEvidence = {
        ...scopeEvidence,
        requestedScopes: scopedGrant,
        grantedScopes: scopedGrant,
      }
      const scopedConfiguration = {
        ...grantConfiguration,
        requestedScopes: scopedGrant,
        grantedScopes: scopedGrant,
      }
      const savepoint = `missing_${missingScope.toLowerCase()}`
      await client.query(`SAVEPOINT ${savepoint}`)
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `UPDATE operations_integration_accounts
         SET configuration = $3::jsonb
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [organizationId, accountId, JSON.stringify(scopedConfiguration)],
      )
      await client.query(
        `UPDATE operations_commerce_provider_attempts
         SET request_hash =
               operations_faire_provider_write_request_hash($3::jsonb),
             redacted_request = $3::jsonb,
             redacted_response = $4::jsonb
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [
          organizationId,
          proof.id,
          JSON.stringify(scopedRequest),
          JSON.stringify(scopedEvidence),
        ],
      )
      await client.query(
        `UPDATE operations_faire_provider_write_scope_evidence
         SET verified_write_scopes = $3::text[],
             redacted_evidence = $4::jsonb,
             evidence_hash =
               operations_faire_provider_write_request_hash($4::jsonb)
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [
          organizationId,
          evidence.rows[0].id,
          scopedWriteGrant,
          JSON.stringify(scopedEvidence),
        ],
      )
      await client.query('SET LOCAL session_replication_role = origin')
      const scopedCapabilities = await client.query(
        `SELECT
           operations_faire_provider_write_scope_evidence_is_current(
             $1::uuid, $2::uuid, $3::uuid, 1
           ) AS evidence_current,
           operations_faire_provider_write_scope_evidence_is_current(
             $1::uuid, $2::uuid, $3::uuid, 1
           )
           AND evidence.verified_write_scopes @>
             ARRAY['WRITE_PRODUCTS']::text[] AS write_products,
           operations_faire_fulfillment_scope_evidence_is_current(
             $1::uuid, $3::uuid, 1
           ) AS write_orders
         FROM operations_faire_provider_write_scope_evidence evidence
         WHERE evidence.organization_id = $1::uuid
           AND evidence.id = $2::uuid`,
        [organizationId, evidence.rows[0].id, accountId],
      )
      assert.deepEqual(scopedCapabilities.rows[0], {
        evidence_current: true,
        write_products: expectedProductWrite,
        write_orders: expectedOrderWrite,
      })
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      await client.query(`RELEASE SAVEPOINT ${savepoint}`)
    }
    await verifyMissingGrantScope('WRITE_PRODUCTS', false, true)
    await verifyMissingGrantScope('WRITE_ORDERS', true, false)

    await client.query('SAVEPOINT brand_token_is_not_current')
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(
      `UPDATE operations_commerce_credentials
       SET auth_mode = 'faire_brand_token'
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [organizationId, accountId],
    )
    await client.query('SET LOCAL session_replication_role = origin')
    const brandTokenGate = await client.query(
      `SELECT operations_faire_provider_write_scope_evidence_is_current(
         $1::uuid, $2::uuid, $3::uuid, 1
       ) AS current`,
      [organizationId, evidence.rows[0].id, accountId],
    )
    assert.equal(brandTokenGate.rows[0].current, false)
    await client.query('ROLLBACK TO SAVEPOINT brand_token_is_not_current')
    await client.query('RELEASE SAVEPOINT brand_token_is_not_current')
    await client.query('COMMIT')
    return {
      organizationId,
      accountId,
      accountGlobalId: account.rows[0].global_id,
      shadowEffectGlobalId: simulation.rows[0].global_id,
      staleShadowEffectGlobalId: staleSimulation.rows[0].global_id,
      scopeEvidenceGlobalId: evidence.rows[0].global_id,
      scopeEvidenceId: evidence.rows[0].id,
      scopeProofAttemptGlobalId: proof.global_id,
      scopeProofProviderReference: credentialFingerprintSha256,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function verifyAuthorization(pool) {
  const fixture = await seedFixture(pool)
  const authorizeInput = {
    ...fixture,
    idempotencyKey: 'faire-active-test-product-v1',
    confirmationStatement: faireAuthorization.FAIRE_PROVIDER_WRITE_CONFIRMATION,
    actorEmail,
    lifetimeSeconds: 300,
  }

  const secretChecks = await pool.query(
    `SELECT
       operations_faire_provider_write_json_is_redacted(
         $1::jsonb
       ) AS application_secret,
       operations_faire_provider_write_json_is_redacted(
         $2::jsonb
       ) AS access_token_header,
       operations_faire_provider_write_json_is_redacted(
         $3::jsonb
       ) AS oauth_access_token_header,
       operations_faire_provider_write_json_is_redacted(
         $4::jsonb
       ) AS app_credentials_header,
       operations_faire_provider_write_json_is_redacted(
         $5::jsonb
       ) AS redacted_request`,
    [
      JSON.stringify({ draft: { applicationSecret: 'must-not-persist' } }),
      JSON.stringify({ draft: { 'x-faire-access-token': 'must-not-persist' } }),
      JSON.stringify({ draft: { 'x-faire-oauth-access-token': 'must-not-persist' } }),
      JSON.stringify({ draft: { 'x-faire-app-credentials': 'must-not-persist' } }),
      JSON.stringify({ operation: 'productDraftCreate', draft: { sku: 'SAFE' } }),
    ],
  )
  assert.deepEqual(secretChecks.rows[0], {
    application_secret: false,
    access_token_header: false,
    oauth_access_token_header: false,
    app_credentials_header: false,
    redacted_request: true,
  })

  const staleGenerationGate = await pool.query(
    `SELECT operations_faire_provider_write_scope_evidence_is_current(
       $1::uuid, $2::uuid, $3::uuid, 2
     ) AS current`,
    [fixture.organizationId, fixture.scopeEvidenceId, fixture.accountId],
  )
  assert.equal(staleGenerationGate.rows[0].current, false)

  await pool.query(
    `UPDATE operations_commerce_credentials
     SET verification_status = 'failed',
         last_error_code = 'DISPOSABLE_STALE_CREDENTIAL',
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [fixture.organizationId, fixture.accountId],
  )
  await expectAuthorizationCode(
    faireAuthorization.authorizeAndPrepareFaireProviderWriteInPostgres(
      authorizeInput,
    ),
    'FAIRE_PROVIDER_WRITE_AUTHORIZATION_UNAVAILABLE',
  )
  await pool.query(
    `UPDATE operations_commerce_credentials
     SET verification_status = 'verified',
         last_error_code = NULL,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [fixture.organizationId, fixture.accountId],
  )

  await pool.query(
    `UPDATE operations_activation_scopes
     SET state = 'read_only', updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid`,
    [fixture.organizationId],
  )
  await expectAuthorizationCode(
    faireAuthorization.authorizeAndPrepareFaireProviderWriteInPostgres(
      authorizeInput,
    ),
    'FAIRE_PROVIDER_WRITE_AUTHORIZATION_UNAVAILABLE',
  )
  await pool.query(
    `UPDATE operations_activation_scopes
     SET state = 'shadow', updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid`,
    [fixture.organizationId],
  )

  await pool.query(
    `UPDATE operations_commerce_external_effect_aggregate_fences
     SET aggregate_revision = 4,
         aggregate_hash = $3,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND provider = 'faire'
       AND aggregate_type = 'commerce.product'
       AND aggregate_id = 'stale-product'`,
    [fixture.organizationId, fixture.accountId, 'c'.repeat(64)],
  )
  await expectAuthorizationCode(
    faireAuthorization.authorizeAndPrepareFaireProviderWriteInPostgres({
      ...authorizeInput,
      shadowEffectGlobalId: fixture.staleShadowEffectGlobalId,
      idempotencyKey: 'faire-active-stale-product-v1',
    }),
    'FAIRE_PROVIDER_WRITE_AUTHORIZATION_UNAVAILABLE',
  )

  const authorized = await faireAuthorization
    .authorizeAndPrepareFaireProviderWriteInPostgres(authorizeInput)
  assert.match(authorized.authorizationGlobalId, /^gfwa[0-9a-v]{12}$/)
  assert.match(authorized.effectGlobalId, /^gcef[0-9a-v]{12}$/)
  assert.equal(authorized.state, 'active')
  assert.equal(authorized.effectState, 'pending')
  assert.deepEqual(Array.from(authorized.capabilities), ['product_draft_create'])
  assert.deepEqual(Array.from(authorized.verifiedWriteScopes), ['WRITE_PRODUCTS'])

  const replay = await faireAuthorization
    .authorizeAndPrepareFaireProviderWriteInPostgres(authorizeInput)
  assert.equal(replay.authorizationGlobalId, authorized.authorizationGlobalId)
  assert.equal(replay.effectGlobalId, authorized.effectGlobalId)

  await assert.rejects(
    pool.query(
      `INSERT INTO operations_commerce_external_effect_intents (
         organization_id, integration_account_id, provider, action,
         desired_mode, credential_generation, activation_revision,
         aggregate_type, aggregate_id, aggregate_revision, aggregate_hash,
         idempotency_key, request_hash, redacted_request, state,
         provider_write_count, created_by
       )
       SELECT organization_id, integration_account_id, 'faire', action,
              'active', credential_generation, activation_revision,
              aggregate_type, aggregate_id, aggregate_revision, aggregate_hash,
              'faire-forged-write-v1', request_hash, redacted_request,
              'pending', 0, authorized_by
       FROM operations_faire_provider_write_authorizations
       WHERE global_id = $1`,
      [authorized.authorizationGlobalId],
    ),
    /Active Faire effect requires exact one-shot resource-scoped Shadow authority/,
  )

  await pool.query(`
    CREATE OR REPLACE FUNCTION reject_disposable_faire_claim()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $rollback_test$
    BEGIN
      IF NEW.claimed_by = 'faire-provider-write-rollback' THEN
        RAISE EXCEPTION 'Disposable mid-claim rollback';
      END IF;
      RETURN NEW;
    END;
    $rollback_test$;
    CREATE TRIGGER reject_disposable_faire_claim
    BEFORE UPDATE ON operations_commerce_external_effect_intents
    FOR EACH ROW EXECUTE FUNCTION reject_disposable_faire_claim();
  `)
  await assert.rejects(
    faireAuthorization.claimFaireProviderWriteInPostgres({
      organizationId: fixture.organizationId,
      authorizationGlobalId: authorized.authorizationGlobalId,
      expectedAuthorizationFenceHash: authorized.authorizationFenceHash,
      workerId: 'faire-provider-write-rollback',
      adapterVersion: 'acceptance-v1',
      leaseSeconds: 5,
    }),
    /Disposable mid-claim rollback/,
  )
  await pool.query(`
    DROP TRIGGER reject_disposable_faire_claim
      ON operations_commerce_external_effect_intents;
    DROP FUNCTION reject_disposable_faire_claim();
  `)
  const rolledBackClaim = await pool.query(
    `SELECT auth.state AS authorization_state,
            effect.state AS effect_state,
            (SELECT count(*)::integer
             FROM operations_commerce_provider_attempts attempt
             WHERE attempt.external_object_id = effect.global_id) AS attempts
     FROM operations_faire_provider_write_authorizations auth
     JOIN operations_commerce_external_effect_intents effect
       ON effect.faire_provider_write_authorization_id = auth.id
     WHERE auth.global_id = $1`,
    [authorized.authorizationGlobalId],
  )
  assert.deepEqual(rolledBackClaim.rows[0], {
    authorization_state: 'active',
    effect_state: 'pending',
    attempts: 0,
  })

  const claimed = await faireAuthorization.claimFaireProviderWriteInPostgres({
    organizationId: fixture.organizationId,
    authorizationGlobalId: authorized.authorizationGlobalId,
    expectedAuthorizationFenceHash: authorized.authorizationFenceHash,
    workerId: 'faire-provider-write-acceptance',
    adapterVersion: 'acceptance-v1',
    leaseSeconds: 5,
  })
  assert.equal(claimed.state, 'consumed')
  assert.equal(claimed.effectState, 'claimed')
  assert.equal(claimed.attemptNumber, 1)
  assert.match(claimed.providerAttemptGlobalId, /^gxa[0-9a-v]{12}$/)

  await expectAuthorizationCode(
    faireAuthorization.claimFaireProviderWriteInPostgres({
      organizationId: fixture.organizationId,
      authorizationGlobalId: authorized.authorizationGlobalId,
      expectedAuthorizationFenceHash: authorized.authorizationFenceHash,
      workerId: 'duplicate-faire-provider-write',
      adapterVersion: 'acceptance-v1',
    }),
    'FAIRE_PROVIDER_WRITE_RECONCILIATION_REQUIRED',
  )
  const attemptCount = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_provider_attempts
     WHERE external_object_id = $1`,
    [authorized.effectGlobalId],
  )
  assert.equal(attemptCount.rows[0].count, 1)

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_100))
  const reconciliation = await faireAuthorization
    .readFaireProviderWriteClaimsRequiringReconciliationInPostgres({
      organizationId: fixture.organizationId,
    })
  assert.deepEqual(
    Array.from(reconciliation, (item) => item.authorizationGlobalId),
    [authorized.authorizationGlobalId],
  )
  const unknown = await faireAuthorization
    .finalizeExpiredFaireProviderWriteClaimUnknownInPostgres({
      organizationId: fixture.organizationId,
      authorizationGlobalId: authorized.authorizationGlobalId,
      reconciledBy: 'faire-reconciliation-acceptance',
    })
  assert.equal(unknown.effectState, 'unknown')
  assert.equal(unknown.state, 'consumed')

  const terminal = await pool.query(
    `SELECT effect.state AS effect_state,
            effect.provider_write_count,
            attempt.state AS attempt_state,
            attempt.attempt_number
     FROM operations_commerce_external_effect_intents effect
     JOIN operations_commerce_provider_attempts attempt
       ON attempt.id = effect.provider_attempt_id
     WHERE effect.global_id = $1`,
    [authorized.effectGlobalId],
  )
  assert.deepEqual(terminal.rows[0], {
    effect_state: 'unknown',
    provider_write_count: 0,
    attempt_state: 'unknown',
    attempt_number: 1,
  })

  await expectAuthorizationCode(
    faireAuthorization.authorizeAndPrepareFaireProviderWriteInPostgres({
      ...authorizeInput,
      idempotencyKey: 'faire-active-test-product-v2',
    }),
    'FAIRE_PROVIDER_WRITE_ALREADY_AUTHORIZED',
  )
  const aggregateAuthorizationCount = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_faire_provider_write_authorizations
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND action = 'faire.product.draft.create'
       AND aggregate_type = 'commerce.product'
       AND aggregate_id = 'test-product'
       AND aggregate_revision = 3`,
    [fixture.organizationId, fixture.accountId],
  )
  assert.equal(aggregateAuthorizationCount.rows[0].count, 1)
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-faire-write-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_faire_write',
      '-e', 'POSTGRES_DB=clawpilot_faire_write',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = `postgresql://postgres:clawpilot_faire_write@127.0.0.1:${port}/clawpilot_faire_write`
    await waitForPostgres(databaseUrl)

    const migrationPool = new Pool({ connectionString: databaseUrl, max: 1 })
    const migrationClient = await migrationPool.connect()
    try {
      await applyMigrations(migrationClient)
    } finally {
      migrationClient.release()
      await migrationPool.end()
    }
    runtimePool = new Pool({ connectionString: databaseUrl, max: 8 })
    await verifyAuthorization(runtimePool)
    await runtimePool.end()
    runtimePool = null
  } finally {
    if (runtimePool) await runtimePool.end().catch(() => {})
    runtimePool = null
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Faire provider-write PostgreSQL authorization acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
