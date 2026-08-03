#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')

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

function evidenceHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function loadTypeScriptModule(path, mocks = {}) {
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
    Uint8Array,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      if (specifier.startsWith('node:')) return requireFromApp(specifier)
      throw new Error(`Unexpected test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code)
    return true
  })
}

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
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
    files.includes('0230_operations_faire_product_image_projection.sql'),
    'Faire Product-image projection migration is missing',
  )
  for (const file of files) {
    await client.query('BEGIN')
    try {
      await client.query(readFileSync(
        resolve(root, 'db/migrations', file),
        'utf8',
      ))
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw new Error(`Migration ${file} failed`, { cause: error })
    }
  }
}

async function seedOperationalFixture(pool) {
  const organizationId = randomUUID()
  const pipelineId = randomUUID()
  const productId = randomUUID()
  const imageAssetId = randomUUID()
  const actorEmail = `faire-image-${randomUUID()}@example.com`
  const productSourceHash = evidenceHash('faire-image-product')
  const channelSourceHash = evidenceHash('faire-image-channel')
  const imageBytes = Buffer.from('faire-product-image-postgres-acceptance')
  const imageContentSha256 = createHash('sha256')
    .update(imageBytes)
    .digest('hex')
  const credentialFingerprintSha256 = 'd'.repeat(64)
  const grantedScopes = [
    'READ_PRODUCTS',
    'WRITE_PRODUCTS',
    'READ_ORDERS',
    'WRITE_ORDERS',
    'READ_INVENTORIES',
    'WRITE_INVENTORIES',
    'READ_SHIPMENTS',
    'READ_REVIEWS',
  ]
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
    externalAccountId: 'faire-image-brand',
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
      `INSERT INTO workspace_organizations (
         id, name, created_by, updated_by
       ) VALUES ($1::uuid, 'Faire image operational acceptance', $2, $2)`,
      [organizationId, actorEmail],
    )
    await client.query(
      `UPDATE app_users
       SET organization_id = $2::uuid,
           organization_name = 'Faire image operational acceptance'
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
       ) VALUES ($1::uuid, 'Faire image pipeline', $2, true, $3::uuid)`,
      [pipelineId, actorEmail, organizationId],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision, reason,
         updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'shadow', 7,
         'Faire image operational acceptance', $3
       )`,
      [organizationId, pipelineId, actorEmail],
    )
    const account = await client.query(
      `INSERT INTO operations_integration_accounts (
         organization_id, provider, integration_type, environment,
         display_name, status, configuration, external_account_id,
         commerce_credential_generation, created_by, updated_by
       ) VALUES (
         $1::uuid, 'faire', 'commerce', 'production',
         'Faire image production acceptance', 'active', $3::jsonb,
         'faire-image-brand', 1, $2, $2
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
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, accountId, `commerce-credential:${accountId}:v1`],
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire-image-brand', 'faire_oauth',
         decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 1, 'TEST', 'verified',
         clock_timestamp(), 'not_applicable', $3, $3
       )`,
      [organizationId, accountId, actorEmail],
    )
    const proof = await client.query(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state, attempt_number,
         provider_reference, completed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire.oauth.authorization_code.exchange',
         'faire-external-api-v2-oauth-authorization-code-v1', $6,
         $7, operations_faire_provider_write_request_hash($3::jsonb),
         $3::jsonb, $4::jsonb, 'succeeded', 1, $5,
         date_trunc('milliseconds', clock_timestamp()), $8
       ) RETURNING id::text, global_id, completed_at`,
      [
        organizationId,
        accountId,
        JSON.stringify(scopeProofRequest),
        JSON.stringify(scopeEvidence),
        credentialFingerprintSha256,
        `commerce-credential:${accountId}:v1`,
        `faire-oauth-grant:1:${credentialFingerprintSha256}`,
        actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET configuration = $3::jsonb
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        organizationId,
        accountId,
        JSON.stringify({
          authMode: 'faire_oauth',
          tokenAcquisition: 'authorization_code',
          requestedScopes: grantedScopes,
          grantedScopes,
          scopeVerification: 'oauth_grant',
          oauthGrantTokenType: 'BEARER',
          oauthGrantCredentialFingerprintSha256:
            credentialFingerprintSha256,
          scopeProofProviderReference: credentialFingerprintSha256,
          scopeProofAttemptGlobalId: proof.rows[0].global_id,
        }),
      ],
    )
    await client.query(
      `INSERT INTO operations_faire_provider_write_scope_evidence (
         organization_id, integration_account_id, provider_attempt_id,
         external_account_id, credential_generation, verified_write_scopes,
         verification_source, provider_reference, redacted_evidence,
         evidence_hash, observed_at, recorded_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire-image-brand', 1,
         ARRAY['WRITE_INVENTORIES','WRITE_ORDERS','WRITE_PRODUCTS']::text[],
         'oauth_grant', $4, $5::jsonb,
         operations_faire_provider_write_request_hash($5::jsonb),
         $6::timestamptz, $7
       )`,
      [
        organizationId,
        accountId,
        proof.rows[0].id,
        credentialFingerprintSha256,
        JSON.stringify(scopeEvidence),
        proof.rows[0].completed_at,
        actorEmail,
      ],
    )
    const product = await client.query(
      `INSERT INTO crm_products (
         id, pipeline_id, source_key, name, sku, source_hash,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire-image-product',
         'Faire image Test Product', 'FAIRE-IMAGE-TEST', $3, $4, $4
       ) RETURNING reference_code`,
      [productId, pipelineId, productSourceHash, actorEmail],
    )
    const mapping = await client.query(
      `INSERT INTO operations_product_mappings (
         organization_id, integration_account_id, pipeline_id, product_id,
         channel_sku, external_product_id, external_variant_id,
         mapping_method, mapping_source_revision, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FAIRE-IMAGE-TEST',
         'p_image_acceptance', 'po_image_acceptance', 'exact_variant',
         'faire-image-mapping-v1', true, $5
       ) RETURNING id::text`,
      [organizationId, accountId, pipelineId, productId, actorEmail],
    )
    const channel = await client.query(
      `INSERT INTO operations_product_channel_states (
         organization_id, integration_account_id, pipeline_id, provider,
         external_product_id, external_variant_id, product_id,
         product_mapping_id, provider_product_title,
         provider_variant_title, provider_sku, provider_status_raw,
         normalized_status, provider_active, observed_at, source_revision,
         source_hash, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire', 'p_image_acceptance',
         'po_image_acceptance', $4::uuid, $5::uuid,
         'Faire image Test Product', 'Default', 'FAIRE-IMAGE-TEST',
         'PUBLISHED', 'active', true, clock_timestamp(),
         'faire-image-channel-v1', $6, $7, $7
       ) RETURNING id::text, global_id, row_version::text`,
      [
        organizationId,
        accountId,
        pipelineId,
        productId,
        mapping.rows[0].id,
        channelSourceHash,
        actorEmail,
      ],
    )
    const image = await client.query(
      `INSERT INTO crm_product_image_assets (
         id, organization_id, pipeline_id, product_id, asset_revision,
         content_bytes, mime_type, content_sha256, byte_length,
         pixel_width, pixel_height, alt_text, source, is_primary,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1,
         $5::bytea, 'image/png', $6, $7, 8, 8,
         'Exact Faire acceptance image', 'manual_upload', true, $8, $8
       ) RETURNING row_version::text`,
      [
        imageAssetId,
        organizationId,
        pipelineId,
        productId,
        imageBytes,
        imageContentSha256,
        imageBytes.byteLength,
        actorEmail,
      ],
    )
    await client.query('COMMIT')
    return {
      organizationId,
      pipelineId,
      productId,
      imageAssetId,
      actorEmail,
      accountId,
      accountGlobalId: account.rows[0].global_id,
      productReferenceCode: product.rows[0].reference_code,
      channelStateId: channel.rows[0].id,
      channelStateGlobalId: channel.rows[0].global_id,
      channelStateRowVersion: Number(channel.rows[0].row_version),
      channelSourceHash,
      imageRowVersion: Number(image.rows[0].row_version),
      imageContentSha256,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function withReplicaRole(pool, mutate) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    const result = await mutate(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function finalizeUnknownEffectWithoutStep(pool, input) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const attempt = await client.query(
      `UPDATE operations_commerce_provider_attempts
       SET state = 'unknown',
           redacted_response = $5::jsonb,
           provider_reference = $6,
           error_code = $7,
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND id = $3::uuid
         AND state = 'prepared'
         AND lease_token = $4::uuid`,
      [
        input.organizationId,
        input.integrationAccountId,
        input.providerAttemptId,
        input.leaseToken,
        JSON.stringify(input.redactedResult),
        input.providerReference,
        input.errorCode,
      ],
    )
    assert.equal(attempt.rowCount, 1)
    const effect = await client.query(
      `UPDATE operations_commerce_external_effect_intents
       SET state = 'unknown',
           lease_token = NULL,
           lease_expires_at = NULL,
           redacted_result = $5::jsonb,
           terminal_evidence_hash = $6,
           provider_reference = $7,
           error_code = $8,
           provider_write_count = $9,
           completed_at = now(),
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND id = $3::uuid
         AND state = 'claimed'
         AND lease_token = $4::uuid`,
      [
        input.organizationId,
        input.integrationAccountId,
        input.externalEffectId,
        input.leaseToken,
        JSON.stringify(input.redactedResult),
        evidenceHash(input.redactedResult),
        input.providerReference,
        input.errorCode,
        input.providerWriteCount,
      ],
    )
    assert.equal(effect.rowCount, 1)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function runOperationalAcceptance({
  pool,
  persistence,
  authorization,
}) {
  const fixture = await seedOperationalFixture(pool)
  const selection = await persistence
    .resolveFaireProductImageSelectionInPostgres({
      organizationId: fixture.organizationId,
      productId: fixture.productId,
      channelStateGlobalId: fixture.channelStateGlobalId,
      imageAssetId: fixture.imageAssetId,
    })
  const base = {
    organizationId: fixture.organizationId,
    productId: fixture.productId,
    channelStateGlobalId: fixture.channelStateGlobalId,
    imageAssetId: fixture.imageAssetId,
    expectedAccountGlobalId: selection.accountGlobalId,
    expectedExternalProductId: selection.externalProductId,
    expectedExternalVariantId: selection.externalVariantId,
    expectedProductReferenceCode: selection.productReferenceCode,
    expectedChannelStateRowVersion: selection.channelStateRowVersion,
    expectedChannelSourceRevision: selection.channelSourceRevision,
    expectedChannelSourceHash: selection.channelSourceHash,
    expectedAssetRevision: selection.assetRevision,
    expectedAssetRowVersion: selection.assetRowVersion,
    expectedAssetContentSha256: selection.assetContentSha256,
    actorEmail: fixture.actorEmail,
  }
  const shadow = await persistence
    .prepareFaireProductImageProjectionInPostgres({
      ...base,
      idempotencyKey: 'faire-image-shadow-operational-v1',
      mode: 'shadow',
      shadowSimulationEffectGlobalId: null,
    })
  assert.equal(shadow.effectState, 'simulated')
  assert.equal(shadow.providerWriteCount, 0)

  const shadowTimes = await pool.query(
    `SELECT issued_at, expires_at
     FROM operations_faire_product_image_delivery_grants
     WHERE id = $1::uuid`,
    [shadow.id],
  )
  await withReplicaRole(pool, (client) => client.query(
    `UPDATE operations_faire_product_image_delivery_grants
     SET issued_at = $2::timestamptz - interval '2 minutes',
         expires_at = $3::timestamptz - interval '2 minutes'
     WHERE id = $1::uuid`,
    [
      shadow.id,
      shadowTimes.rows[0].issued_at,
      shadowTimes.rows[0].expires_at,
    ],
  ))
  await expectCode(
    persistence.prepareFaireProductImageProjectionInPostgres({
      ...base,
      idempotencyKey: 'faire-image-active-expired-shadow-v1',
      mode: 'active',
      shadowSimulationEffectGlobalId: shadow.effectGlobalId,
    }),
    'FAIRE_PRODUCT_IMAGE_SHADOW_SIMULATION_STALE',
  )
  await withReplicaRole(pool, (client) => client.query(
    `UPDATE operations_faire_product_image_delivery_grants
     SET issued_at = $2::timestamptz, expires_at = $3::timestamptz
     WHERE id = $1::uuid`,
    [
      shadow.id,
      shadowTimes.rows[0].issued_at,
      shadowTimes.rows[0].expires_at,
    ],
  ))

  const active = await persistence
    .prepareFaireProductImageProjectionInPostgres({
      ...base,
      idempotencyKey: 'faire-image-active-operational-v1',
      mode: 'active',
      shadowSimulationEffectGlobalId: shadow.effectGlobalId,
    })
  assert.equal(active.effectState, 'pending')
  assert.ok(active.authorization)

  await withReplicaRole(pool, (client) => client.query(
    `UPDATE operations_faire_product_image_delivery_grants
     SET issued_at = $2::timestamptz - interval '2 minutes',
         expires_at = $3::timestamptz - interval '2 minutes'
     WHERE id = $1::uuid`,
    [
      shadow.id,
      shadowTimes.rows[0].issued_at,
      shadowTimes.rows[0].expires_at,
    ],
  ))
  await assert.rejects(
    authorization.claimFaireProviderWriteInPostgres({
      organizationId: fixture.organizationId,
      authorizationGlobalId: active.authorization.globalId,
      expectedAuthorizationFenceHash: active.authorization.fenceHash,
      workerId: 'faire-image-operational-stale-shadow',
      adapterVersion: 'faire-image-operational-v1',
      leaseSeconds: 5,
    }),
    /Shadow|authority|stale|expired/i,
  )
  await withReplicaRole(pool, (client) => client.query(
    `UPDATE operations_faire_product_image_delivery_grants
     SET issued_at = $2::timestamptz, expires_at = $3::timestamptz
     WHERE id = $1::uuid`,
    [
      shadow.id,
      shadowTimes.rows[0].issued_at,
      shadowTimes.rows[0].expires_at,
    ],
  ))

  const claimed = await authorization.claimFaireProviderWriteInPostgres({
    organizationId: fixture.organizationId,
    authorizationGlobalId: active.authorization.globalId,
    expectedAuthorizationFenceHash: active.authorization.fenceHash,
    workerId: 'faire-image-operational',
    adapterVersion: 'faire-image-operational-v1',
    leaseSeconds: 5,
  })
  assert.equal(claimed.effectState, 'claimed')
  const uploadedLocatorSha256 = evidenceHash('faire-upload-locator')
  const uploadEvidence = {
    provider: 'faire',
    operation: 'productImageUpload',
    outcome: 'succeeded',
    assetContentSha256: selection.assetContentSha256,
    uploadedLocatorSha256,
    providerWrites: 1,
  }
  const uploadStep = await persistence
    .recordFaireProductImageProviderStepInPostgres({
      organizationId: fixture.organizationId,
      deliveryGrantId: active.id,
      externalEffectId: active.effectId,
      providerAttemptId: claimed.providerAttemptId,
      stage: 'upload',
      outcome: 'succeeded',
      uploadedLocatorSha256,
      providerWriteCount: 1,
      redactedEvidence: uploadEvidence,
      actorEmail: fixture.actorEmail,
    })
  await assert.rejects(
    pool.query(
      `UPDATE operations_faire_product_image_provider_steps
       SET outcome = 'unknown' WHERE id = $1::uuid`,
      [uploadStep.id],
    ),
    /immutable/i,
  )
  await expectCode(
    persistence.recordFaireProductImageProviderStepInPostgres({
      organizationId: fixture.organizationId,
      deliveryGrantId: randomUUID(),
      externalEffectId: active.effectId,
      providerAttemptId: claimed.providerAttemptId,
      stage: 'upload',
      outcome: 'succeeded',
      uploadedLocatorSha256,
      providerWriteCount: 1,
      redactedEvidence: uploadEvidence,
      actorEmail: fixture.actorEmail,
    }),
    'FAIRE_PRODUCT_IMAGE_STEP_SAVE_FAILED',
  )

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_100))
  const expired = await persistence
    .readFaireProductImageReconciliationContextInPostgres({
      organizationId: fixture.organizationId,
      productId: fixture.productId,
      externalEffectGlobalId: active.effectGlobalId,
    })
  assert.equal(expired.effectState, 'claimed')
  assert.equal(expired.leaseExpired, true)
  assert.equal(expired.providerWriteCount, 1)
  assert.equal(expired.uploadedLocatorSha256, uploadedLocatorSha256)
  const recovered = await persistence
    .recoverExpiredFaireProductImageClaimInPostgres({
      organizationId: fixture.organizationId,
      productId: fixture.productId,
      externalEffectGlobalId: active.effectGlobalId,
      actorEmail: fixture.actorEmail,
    })
  assert.equal(recovered.effectState, 'unknown')
  assert.equal(recovered.leaseExpired, false)
  assert.equal(recovered.providerWriteCount, 1)
  assert.equal(recovered.uploadedLocatorSha256, uploadedLocatorSha256)
  const reconcileEvidence = {
    provider: 'faire',
    operation: 'productImagePublishReconciliation',
    outcome: 'observed_applied',
    externalProductId: selection.externalProductId,
    uploadedLocatorSha256,
    providerImageCount: 1,
    exactLocatorMatchCount: 1,
    providerWrites: 1,
    reconciledBy: fixture.actorEmail,
  }
  await persistence.recordFaireProductImageProviderStepInPostgres({
    organizationId: fixture.organizationId,
    deliveryGrantId: active.id,
    externalEffectId: active.effectId,
    providerAttemptId: null,
    stage: 'reconcile',
    outcome: 'observed_applied',
    uploadedLocatorSha256,
    providerWriteCount: 1,
    redactedEvidence: reconcileEvidence,
    actorEmail: fixture.actorEmail,
  })
  const terminal = await persistence
    .readFaireProductImageReconciliationContextInPostgres({
      organizationId: fixture.organizationId,
      productId: fixture.productId,
      externalEffectGlobalId: active.effectGlobalId,
    })
  assert.equal(terminal.effectState, 'unknown')
  assert.equal(terminal.latestOutcome, 'observed_applied')
  const states = await pool.query(
    `SELECT effect.state AS effect_state,
            effect.provider_write_count,
            attempt.state AS attempt_state
     FROM operations_commerce_external_effect_intents effect
     JOIN operations_commerce_provider_attempts attempt
       ON attempt.id = effect.provider_attempt_id
     WHERE effect.id = $1::uuid`,
    [active.effectId],
  )
  assert.deepEqual(states.rows[0], {
    effect_state: 'unknown',
    provider_write_count: 1,
    attempt_state: 'unknown',
  })
  const health =
    await persistence.readFaireProductImageProjectionHealthInPostgres()
  assert.equal(health.expiredClaimed, 0)
  assert.equal(health.counts.unknown, 1)
  assert.equal(health.unresolvedCounts.unknown, 0)

  const fallbackShadow = await persistence
    .prepareFaireProductImageProjectionInPostgres({
      ...base,
      idempotencyKey: 'faire-image-shadow-locator-fallback-v1',
      mode: 'shadow',
      shadowSimulationEffectGlobalId: null,
    })
  const fallbackActive = await persistence
    .prepareFaireProductImageProjectionInPostgres({
      ...base,
      idempotencyKey: 'faire-image-active-locator-fallback-v1',
      mode: 'active',
      shadowSimulationEffectGlobalId: fallbackShadow.effectGlobalId,
    })
  const fallbackClaim = await authorization.claimFaireProviderWriteInPostgres({
    organizationId: fixture.organizationId,
    authorizationGlobalId: fallbackActive.authorization.globalId,
    expectedAuthorizationFenceHash: fallbackActive.authorization.fenceHash,
    workerId: 'faire-image-locator-fallback',
    adapterVersion: 'faire-image-operational-v1',
    leaseSeconds: 30,
  })
  const fallbackLocatorSha256 = evidenceHash('faire-upload-locator-fallback')
  const fallbackUploadEvidence = {
    provider: 'faire',
    operation: 'productImageUpload',
    outcome: 'succeeded',
    assetContentSha256: selection.assetContentSha256,
    uploadedLocatorSha256: fallbackLocatorSha256,
    providerWrites: 1,
  }
  await assert.rejects(
    persistence.recordFaireProductImageProviderStepInPostgres({
      organizationId: fixture.organizationId,
      deliveryGrantId: active.id,
      externalEffectId: fallbackActive.effectId,
      providerAttemptId: fallbackClaim.providerAttemptId,
      stage: 'upload',
      outcome: 'succeeded',
      uploadedLocatorSha256: fallbackLocatorSha256,
      providerWriteCount: 1,
      redactedEvidence: fallbackUploadEvidence,
      actorEmail: fixture.actorEmail,
    }),
    /foreign key|violates/i,
  )
  await assert.rejects(
    persistence.recordFaireProductImageProviderStepInPostgres({
      organizationId: fixture.organizationId,
      deliveryGrantId: fallbackActive.id,
      externalEffectId: fallbackActive.effectId,
      providerAttemptId: claimed.providerAttemptId,
      stage: 'upload',
      outcome: 'succeeded',
      uploadedLocatorSha256: fallbackLocatorSha256,
      providerWriteCount: 1,
      redactedEvidence: fallbackUploadEvidence,
      actorEmail: fixture.actorEmail,
    }),
    /foreign key|violates/i,
  )
  const fallbackTerminalEvidence = {
    provider: 'faire',
    action: 'faire.product.image.publish',
    operation: 'productImagePublish',
    outcome: 'unknown',
    stage: 'upload_evidence_persistence',
    errorCode: 'FAIRE_PRODUCT_IMAGE_STEP_SAVE_FAILED',
    deliveryGrantId: fallbackActive.id,
    authorizationGlobalId: fallbackClaim.authorizationGlobalId,
    scopeEvidenceGlobalId: fallbackClaim.scopeEvidenceGlobalId,
    providerAttemptGlobalId: fallbackClaim.providerAttemptGlobalId,
    externalProductId: selection.externalProductId,
    assetContentSha256: selection.assetContentSha256,
    uploadedLocatorSha256: fallbackLocatorSha256,
    existingImagesPreserved: true,
    priorImageCount: 0,
    projectedImageCount: null,
    providerWritesKnown: false,
    providerWriteCountLowerBound: 1,
    providerWrites: 1,
  }
  await finalizeUnknownEffectWithoutStep(pool, {
    organizationId: fixture.organizationId,
    integrationAccountId: fallbackActive.integrationAccountId,
    externalEffectId: fallbackActive.effectId,
    providerAttemptId: fallbackClaim.providerAttemptId,
    leaseToken: fallbackClaim.leaseToken,
    redactedResult: fallbackTerminalEvidence,
    providerReference: selection.externalProductId,
    errorCode: 'FAIRE_PRODUCT_IMAGE_STEP_SAVE_FAILED',
    providerWriteCount: 1,
  })
  const fallbackContext = await persistence
    .readFaireProductImageReconciliationContextInPostgres({
      organizationId: fixture.organizationId,
      productId: fixture.productId,
      externalEffectGlobalId: fallbackActive.effectGlobalId,
    })
  assert.equal(fallbackContext.effectState, 'unknown')
  assert.equal(fallbackContext.providerWriteCount, 1)
  assert.equal(
    fallbackContext.uploadedLocatorSha256,
    fallbackLocatorSha256,
  )
  assert.equal(fallbackContext.latestOutcome, null)
  const fallbackSteps = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_faire_product_image_provider_steps
     WHERE organization_id = $1::uuid
       AND external_effect_id = $2::uuid`,
    [fixture.organizationId, fallbackActive.effectId],
  )
  assert.equal(fallbackSteps.rows[0].count, 0)
}

async function run(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    await applyMigrations(pool)
    const schema = await pool.query(`SELECT
      to_regclass('operations_faire_product_image_delivery_grants')::text
        AS grants,
      to_regclass('operations_faire_product_image_provider_steps')::text
        AS steps,
      to_regprocedure(
        'operations_faire_provider_write_authority_is_current(uuid,uuid,uuid,text,integer,integer,text,text,text,bigint,text,text,text,jsonb,uuid)'
      )::text AS authority_function,
      EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = to_regclass(
            'operations_faire_product_image_delivery_grants'
          )
          AND constraint_row.conname =
            'operations_faire_product_image_grant_org_id_unique'
          AND constraint_row.contype = 'u'
          AND constraint_row.convalidated
      ) AS scoped_grant_identity,
      EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = to_regclass(
            'operations_faire_provider_write_authorizations'
          )
          AND constraint_row.conname =
            'operations_faire_write_auth_image_grant_fkey'
          AND constraint_row.contype = 'f'
          AND constraint_row.convalidated
      ) AS authorization_grant_fkey,
      EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = to_regclass(
            'operations_faire_provider_write_authorizations'
          )
          AND constraint_row.conname =
            'operations_faire_write_auth_shadow_effect_fkey'
          AND constraint_row.contype = 'f'
          AND constraint_row.convalidated
      ) AS authorization_shadow_fkey,
      EXISTS (
        SELECT 1
        FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass(
            'operations_faire_product_image_delivery_grants'
          )
          AND trigger_row.tgname =
            'protect_operations_faire_product_image_grant_write'
          AND trigger_row.tgenabled = 'O'
          AND NOT trigger_row.tgisinternal
      ) AS immutable_grant_trigger,
      EXISTS (
        SELECT 1
        FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass(
            'operations_faire_provider_write_authorizations'
          )
          AND trigger_row.tgname =
            'protect_operations_faire_product_image_authority_write'
          AND trigger_row.tgenabled = 'O'
          AND NOT trigger_row.tgisinternal
      ) AS exact_authority_trigger,
      EXISTS (
        SELECT 1
        FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass(
            'operations_faire_product_image_provider_steps'
          )
          AND trigger_row.tgname =
            'protect_operations_faire_product_image_step_write'
          AND trigger_row.tgenabled = 'O'
          AND NOT trigger_row.tgisinternal
      ) AS immutable_step_trigger,
      (
        SELECT count(*) = 4
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = to_regclass(
            'operations_faire_product_image_provider_steps'
          )
          AND constraint_row.conname = ANY(ARRAY[
            'operations_faire_product_image_step_grant_identity_fkey',
            'operations_faire_product_image_step_effect_identity_fkey',
            'operations_faire_product_image_step_attempt_identity_fkey',
            'operations_faire_product_image_step_attempt_shape'
          ])
          AND constraint_row.convalidated
      ) AS exact_step_identity_constraints`)
    const row = schema.rows[0]
    assert.equal(
      row.grants,
      'operations_faire_product_image_delivery_grants',
    )
    assert.equal(
      row.steps,
      'operations_faire_product_image_provider_steps',
    )
    assert.match(
      row.authority_function,
      /^operations_faire_provider_write_authority_is_current/,
    )
    for (const key of [
      'scoped_grant_identity',
      'authorization_grant_fkey',
      'authorization_shadow_fkey',
      'immutable_grant_trigger',
      'exact_authority_trigger',
      'immutable_step_trigger',
      'exact_step_identity_constraints',
    ]) assert.equal(row[key], true, `${key} is required`)

    const constraints = await pool.query(`SELECT conname,
        pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = to_regclass(
        'operations_faire_provider_write_authorizations'
      )`)
    const definitions = constraints.rows
      .map((entry) => entry.definition)
      .join('\n')
    assert.match(definitions, /faire\.product\.image\.publish/)
    assert.match(definitions, /product_draft_update/)
    assert.match(definitions, /product_image_upload/)
    assert.match(
      definitions,
      /faire-product-image-shadow-provider-write-v1/,
    )
    assert.equal(
      constraints.rows.some((entry) => entry.conname ===
        'operations_faire_provider_wr_confirmation_statement_versi_check'),
      false,
    )
    assert.equal(
      constraints.rows.some((entry) => entry.conname ===
        'operations_faire_write_auth_confirmation_version_valid'),
      true,
    )

    const postgresMock = {
      acquireTransactionAdvisoryLock: (client, key) => client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      ),
      query: (sql, values) => pool.query(sql, values),
      async withTransaction(callback) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const value = await callback(client)
          await client.query('COMMIT')
          return value
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw error
        } finally {
          client.release()
        }
      },
    }
    const externalEffectsMock = {
      assertRedactedCommerceExternalEffectEvidence() {},
      commerceExternalEffectHash: evidenceHash,
    }
    const persistence = loadTypeScriptModule(
      'app_src/lib/persistence/faireProductImageProjection.ts',
      {
        '@/lib/persistence/commerceExternalEffects': externalEffectsMock,
        '@/lib/persistence/postgres': postgresMock,
      },
    )
    const authorization = loadTypeScriptModule(
      'app_src/lib/persistence/faireProviderWriteAuthorization.ts',
      {
        '@/lib/auditWriter': {
          async recordAuditEvent() {},
        },
        '@/lib/persistence/commerceExternalEffects': externalEffectsMock,
        '@/lib/persistence/postgres': postgresMock,
      },
    )
    const organizationId = randomUUID()
    const productId = randomUUID()
    const imageAssetId = randomUUID()
    await expectCode(
      persistence.resolveFaireProductImageSelectionInPostgres({
        organizationId,
        productId,
        channelStateGlobalId: 'gpcs0000000',
        imageAssetId,
      }),
      'FAIRE_PRODUCT_IMAGE_SELECTION_NOT_FOUND',
    )
    await expectCode(
      persistence.readFaireProductImageAssetForClaimInPostgres({
        organizationId,
        deliveryGrantId: randomUUID(),
        externalEffectGlobalId: 'gcef0000000',
        imageAssetId,
        contentSha256: '0'.repeat(64),
      }),
      'FAIRE_PRODUCT_IMAGE_ASSET_STALE',
    )
    await expectCode(
      persistence.readFaireProductImageReconciliationContextInPostgres({
        organizationId,
        productId,
        externalEffectGlobalId: 'gcef0000000',
      }),
      'FAIRE_PRODUCT_IMAGE_RECONCILIATION_NOT_FOUND',
    )
    const health =
      await persistence.readFaireProductImageProjectionHealthInPostgres()
    assert.equal(Object.keys(health.counts).length, 0)
    assert.equal(Object.keys(health.unresolvedCounts).length, 0)
    assert.equal(health.expiredClaimed, 0)
    assert.equal(health.latestAt, null)

    const freshness = await pool.query(`SELECT
      pg_get_functiondef(to_regprocedure(
        'protect_operations_faire_product_image_authority()'
      )) AS authority_trigger,
      pg_get_functiondef(to_regprocedure(
        'operations_faire_provider_write_authority_is_current(uuid,uuid,uuid,text,integer,integer,text,text,text,bigint,text,text,text,jsonb,uuid)'
      )) AS authority_predicate`)
    assert.match(
      freshness.rows[0].authority_trigger,
      /shadow_grant\.expires_at <= clock_timestamp\(\)/,
    )
    assert.match(
      freshness.rows[0].authority_predicate,
      /shadow_grant\.expires_at > clock_timestamp\(\)/,
    )
    assert.match(
      readFileSync(
        resolve(
          root,
          'app_src/lib/persistence/faireProductImageProjection.ts',
        ),
        'utf8',
      ),
      /shadow_grant\.expires_at > clock_timestamp\(\)/,
    )
    await runOperationalAcceptance({
      pool,
      persistence,
      authorization,
    })
  } finally {
    await pool.end()
  }
}

command('docker', ['info'], { timeout: 30_000 })
const container = `clawpilot-faire-image-${randomUUID()}`
try {
  command('docker', [
    'run', '--rm', '-d', '--name', container,
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=clawpilot_test',
    '-p', '127.0.0.1::5432',
    'pgvector/pgvector:pg16',
  ])
  const portOutput = command('docker', ['port', container, '5432/tcp'])
  const port = portOutput.trim().split(':').pop()
  const databaseUrl =
    `postgres://postgres:postgres@127.0.0.1:${port}/clawpilot_test`
  await waitForPostgres(databaseUrl)
  await run(databaseUrl)
  console.log('Faire Product-image PostgreSQL schema acceptance passed')
} finally {
  spawnSync('docker', ['stop', '-t', '1', container], {
    cwd: root,
    encoding: 'utf8',
  })
}
