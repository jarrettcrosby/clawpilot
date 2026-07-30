#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const TRUSTED_PROJECT_ID = 'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
const TRUSTED_ENVIRONMENT_ID = 'e4abd95f-825c-4242-b37b-825a92597e98'
const TRUSTED_DATABASE_FINGERPRINT =
  '750aa268-0e31-4065-a99c-4016e4d4fab1'
const REQUIRED_APPLIED_MIGRATION =
  '0159_operations_shopify_receipt_and_carrier_authority.sql'
const TARGET_MIGRATION =
  '0160_operations_shopify_product_media_shadow_authority.sql'
const TARGET_PRODUCT_REFERENCE = 'gp4513844'
const TARGET_ACCOUNT_GLOBAL_ID = 'gia9286799'
const TARGET_CHANNEL_GLOBAL_ID = 'gpcs2196232'
const PUBLIC_ORIGIN = 'https://dev.aiapp.eigenracing.com'
const CONFIRMATION_STATEMENT =
  'shopify-product-image-shadow-provider-write-v1'
const SNAPSHOT_TABLES = [
  'crm_reference_number_registry',
  'crm_reference_registry',
  'crm_products',
  'crm_product_image_assets',
  'operations_commerce_external_effect_aggregate_fences',
  'operations_commerce_external_effect_intents',
  'operations_commerce_provider_attempts',
  'operations_product_mappings',
  'operations_product_channel_states',
  'operations_shopify_product_media_delivery_grants',
  'operations_shopify_product_media_source_bindings',
  'operations_shopify_product_media_write_authorizations',
]

function fail(message) {
  throw new Error(message)
}

function requireTrustedEnvironment() {
  if (
    String(process.env.RAILWAY_PROJECT_ID || '') !== TRUSTED_PROJECT_ID
    || String(process.env.RAILWAY_ENVIRONMENT_ID || '')
      !== TRUSTED_ENVIRONMENT_ID
    || String(process.env.RAILWAY_ENVIRONMENT_NAME || '') !== 'development'
  ) {
    fail(
      'Shopify Product-image PostgreSQL acceptance is restricted to the trusted Railway development environment.',
    )
  }
}

function migrationSql() {
  return readFileSync(
    fileURLToPath(
      new URL(`../db/migrations/${TARGET_MIGRATION}`, import.meta.url),
    ),
    'utf8',
  )
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function jsonHash(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'))
}

const databaseUrl = String(
  process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '',
).trim()
if (!databaseUrl) {
  fail('DATABASE_PUBLIC_URL or DATABASE_URL is required.')
}
requireTrustedEnvironment()

const parsedUrl = new URL(databaseUrl)
parsedUrl.searchParams.delete('sslmode')
const pool = new Pool({
  connectionString: parsedUrl.toString(),
  ssl: parsedUrl.hostname.endsWith('rlwy.net')
    ? { rejectUnauthorized: false }
    : undefined,
  application_name:
    'clawpilot-shopify-product-image-postgres-rollback-acceptance',
  max: 1,
  connectionTimeoutMillis: 15_000,
  query_timeout: 120_000,
})

async function databaseFingerprint(client) {
  const result = await client.query(
    `SELECT (
       SELECT value ->> 'id'
       FROM app_settings
       WHERE key = 'deployment.database.identity'
     ) AS database_fingerprint`,
  )
  return result.rows[0]?.database_fingerprint || null
}

async function migrationState(client) {
  const result = await client.query(
    `SELECT filename
     FROM schema_migrations
     WHERE filename = ANY($1::text[])
     ORDER BY filename`,
    [[REQUIRED_APPLIED_MIGRATION, TARGET_MIGRATION]],
  )
  return result.rows.map((row) => row.filename)
}

async function objectState(client) {
  const relations = await client.query(
    `SELECT requested.name,
       to_regclass('public.' || requested.name)::text AS relation_name
     FROM unnest($1::text[]) AS requested(name)
     ORDER BY requested.name`,
    [SNAPSHOT_TABLES],
  )
  const columns = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (
           table_name =
             'operations_shopify_product_media_delivery_grants'
           AND column_name = ANY($1::text[])
         )
         OR (
           table_name =
             'operations_shopify_product_media_write_authorizations'
           AND column_name = ANY($2::text[])
         )
         OR table_name =
           'operations_shopify_product_media_source_bindings'
       )
     ORDER BY table_name, ordinal_position`,
    [
      [
        'external_variant_id',
        'channel_normalized_status',
        'channel_provider_active',
      ],
      [
        'simulation_effect_id',
        'provider_write_activation_revision',
        'confirmation_statement_version',
      ],
    ],
  )
  const functions = await client.query(
    `SELECT procedure.proname,
       pg_get_function_identity_arguments(procedure.oid) AS arguments
     FROM pg_proc procedure
     JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure.proname = ANY($1::text[])
     ORDER BY procedure.proname, arguments`,
    [[
      'operations_shopify_product_media_authority_is_current',
      'operations_shopify_product_media_delivery_is_authorized',
      'protect_operations_shopify_parent_product_mapping',
      'protect_operations_shopify_product_media_delivery_grant',
      'protect_operations_shopify_product_media_source_binding',
      'protect_operations_shopify_product_media_write_authorization',
    ]],
  )
  return {
    relations: relations.rows,
    columns: columns.rows,
    functions: functions.rows,
  }
}

async function dataState(client) {
  const relationLookup = await client.query(
    `SELECT requested.name,
       to_regclass('public.' || requested.name) IS NOT NULL AS exists
     FROM unnest($1::text[]) AS requested(name)
     ORDER BY requested.name`,
    [SNAPSHOT_TABLES],
  )
  const counts = {}
  for (const row of relationLookup.rows) {
    counts[row.name] = row.exists
      ? (
          await client.query(
            `SELECT count(*)::text AS row_count
             FROM ${quoteIdentifier(row.name)}`,
          )
        ).rows[0].row_count
      : null
  }
  const target = await client.query(
    `SELECT
       product.id::text AS product_id,
       product.reference_code,
       product.source_hash,
       account.id::text AS integration_account_id,
       account.global_id AS integration_account_global_id,
       account.status AS integration_account_status,
       account.commerce_credential_generation,
       channel.id::text AS channel_state_id,
       channel.global_id AS channel_state_global_id,
       channel.row_version::text AS channel_state_row_version,
       channel.source_revision AS channel_source_revision,
       channel.source_hash AS channel_source_hash,
       channel.external_product_id,
       channel.external_variant_id,
       channel.normalized_status,
       channel.provider_active,
       mapping.id::text AS mapping_id,
       mapping.active AS mapping_active,
       count(asset.id)::text AS image_asset_count,
       count(asset.id) FILTER (WHERE asset.is_primary)::text
         AS primary_image_count
     FROM crm_products product
     JOIN operations_product_channel_states channel
       ON channel.pipeline_id = product.pipeline_id
      AND channel.product_id = product.id
     JOIN operations_integration_accounts account
       ON account.organization_id = channel.organization_id
      AND account.id = channel.integration_account_id
     JOIN operations_product_mappings mapping
       ON mapping.organization_id = channel.organization_id
      AND mapping.integration_account_id =
            channel.integration_account_id
      AND mapping.pipeline_id = channel.pipeline_id
      AND mapping.id = channel.product_mapping_id
     LEFT JOIN crm_product_image_assets asset
       ON asset.organization_id = channel.organization_id
      AND asset.pipeline_id = product.pipeline_id
      AND asset.product_id = product.id
     WHERE product.reference_code = $1
       AND account.global_id = $2
       AND channel.global_id = $3
     GROUP BY
       product.id,
       product.reference_code,
       product.source_hash,
       account.id,
       account.global_id,
       account.status,
       account.commerce_credential_generation,
       channel.id,
       channel.global_id,
       channel.row_version,
       channel.source_revision,
       channel.source_hash,
       channel.external_product_id,
       channel.external_variant_id,
       channel.normalized_status,
       channel.provider_active,
       mapping.id,
       mapping.active`,
    [
      TARGET_PRODUCT_REFERENCE,
      TARGET_ACCOUNT_GLOBAL_ID,
      TARGET_CHANNEL_GLOBAL_ID,
    ],
  )
  const targetFence = await client.query(
    `SELECT
       fence.organization_id::text,
       fence.integration_account_id::text,
       fence.provider,
       fence.aggregate_type,
       fence.aggregate_id,
       fence.aggregate_revision::text,
       fence.aggregate_hash,
       fence.updated_at
     FROM operations_commerce_external_effect_aggregate_fences fence
     JOIN operations_integration_accounts account
       ON account.organization_id = fence.organization_id
      AND account.id = fence.integration_account_id
     WHERE account.global_id = $1
       AND fence.provider = 'shopify'
       AND fence.aggregate_type = 'shopify_product_projection'
       AND fence.aggregate_id = $2`,
    [TARGET_ACCOUNT_GLOBAL_ID, TARGET_PRODUCT_REFERENCE],
  )
  return {
    counts,
    target: target.rows,
    targetFence: targetFence.rows,
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

async function expectDatabaseRejection(
  client,
  label,
  operation,
  expectedMessage,
) {
  const savepoint = `expected_rejection_${expectDatabaseRejection.sequence++}`
  await client.query(`SAVEPOINT ${quoteIdentifier(savepoint)}`)
  let caught = null
  try {
    await operation()
  } catch (error) {
    caught = error
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${quoteIdentifier(savepoint)}`)
  await client.query(`RELEASE SAVEPOINT ${quoteIdentifier(savepoint)}`)
  assert.ok(caught, `${label} unexpectedly succeeded`)
  if (expectedMessage) {
    assert.match(
      String(caught.message || caught),
      expectedMessage,
      `${label} failed for an unexpected reason`,
    )
  }
  return caught
}
expectDatabaseRejection.sequence = 1

async function selectExactTarget(client) {
  const result = await client.query(
    `SELECT
       channel.organization_id::text,
       channel.integration_account_id::text,
       account.global_id AS integration_account_global_id,
       account.status AS integration_account_status,
       account.commerce_credential_generation AS credential_generation,
       credential.credential_version,
       credential.verification_status,
       activation.state AS activation_state,
       activation.revision AS activation_revision,
       product.pipeline_id::text,
       product.id::text AS product_id,
       product.reference_code AS product_reference_code,
       product.source_hash AS product_source_hash,
       channel.id::text AS channel_state_id,
       channel.global_id AS channel_state_global_id,
       channel.row_version::text AS channel_state_row_version,
       channel.source_revision AS channel_source_revision,
       channel.source_hash AS channel_source_hash,
       channel.external_product_id AS product_gid,
       channel.external_variant_id,
       channel.normalized_status AS channel_normalized_status,
       channel.provider_active AS channel_provider_active,
       mapping.id::text AS mapping_id,
       membership.user_email AS actor_email,
       membership.role AS actor_role,
       floor(extract(epoch FROM clock_timestamp()))::text AS now_epoch
     FROM crm_products product
     JOIN operations_product_channel_states channel
       ON channel.pipeline_id = product.pipeline_id
      AND channel.product_id = product.id
     JOIN operations_integration_accounts account
       ON account.organization_id = channel.organization_id
      AND account.id = channel.integration_account_id
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = channel.organization_id
     JOIN operations_product_mappings mapping
       ON mapping.organization_id = channel.organization_id
      AND mapping.integration_account_id =
            channel.integration_account_id
      AND mapping.pipeline_id = channel.pipeline_id
      AND mapping.id = channel.product_mapping_id
      AND mapping.product_id = product.id
     JOIN LATERAL (
       SELECT candidate.user_email, candidate.role
       FROM app_user_organization_memberships candidate
       WHERE candidate.organization_id = channel.organization_id
         AND candidate.status = 'active'
         AND candidate.role IN ('owner', 'admin')
       ORDER BY
         CASE WHEN candidate.role = 'owner' THEN 0 ELSE 1 END,
         candidate.user_email
       LIMIT 1
     ) membership ON true
     WHERE product.reference_code = $1
       AND account.global_id = $2
       AND channel.global_id = $3
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND account.status IN ('active', 'disabled')
       AND credential.verification_status = 'verified'
       AND credential.credential_version =
             account.commerce_credential_generation
       AND activation.state = 'shadow'
       AND activation.data_pipeline_id = product.pipeline_id
       AND channel.provider = 'shopify'
       AND channel.normalized_status = 'active'
       AND channel.provider_active = true
       AND mapping.active = true
       AND mapping.external_product_id =
             channel.external_product_id
       AND mapping.external_variant_id =
             channel.external_variant_id
       AND NOT EXISTS (
         SELECT 1
         FROM operations_product_channel_states sibling
         WHERE sibling.organization_id = channel.organization_id
           AND sibling.integration_account_id =
                 channel.integration_account_id
           AND sibling.provider = 'shopify'
           AND sibling.external_product_id =
                 channel.external_product_id
           AND sibling.product_id IS NOT NULL
           AND sibling.product_id <> product.id
       )`,
    [
      TARGET_PRODUCT_REFERENCE,
      TARGET_ACCOUNT_GLOBAL_ID,
      TARGET_CHANNEL_GLOBAL_ID,
    ],
  )
  assert.equal(
    result.rows.length,
    1,
    'rollback-only acceptance requires one exact ready Test Product mapping',
  )
  return result.rows[0]
}

async function selectOrCreatePrimaryImage(client, target, runId) {
  const existing = await client.query(
    `SELECT
       id::text,
       asset_revision::text,
       row_version::text,
       content_sha256,
       mime_type,
       byte_length,
       pixel_width,
       pixel_height,
       alt_text
     FROM crm_product_image_assets
     WHERE organization_id = $1::uuid
       AND pipeline_id = $2::uuid
       AND product_id = $3::uuid
       AND is_primary = true
     ORDER BY asset_revision DESC, id
     LIMIT 1
     FOR SHARE`,
    [
      target.organization_id,
      target.pipeline_id,
      target.product_id,
    ],
  )
  if (existing.rows[0]) return existing.rows[0]

  const content = Buffer.from(
    `rollback-only-shopify-product-image:${runId}`,
    'utf8',
  )
  const inserted = await client.query(
    `INSERT INTO crm_product_image_assets (
       organization_id, pipeline_id, product_id, asset_revision,
       content_bytes, mime_type, content_sha256, byte_length,
       pixel_width, pixel_height, alt_text, source, is_primary,
       created_by, updated_by
     )
     SELECT
       $1::uuid,
       $2::uuid,
       $3::uuid,
       COALESCE(max(asset.asset_revision), 0) + 1,
       $4::bytea,
       'image/png',
       $5,
       $6,
       1,
       1,
       'Rollback-only exact Test Product image authority',
       'manual_upload',
       true,
       $7,
       $7
     FROM crm_product_image_assets asset
     WHERE asset.organization_id = $1::uuid
       AND asset.pipeline_id = $2::uuid
       AND asset.product_id = $3::uuid
     RETURNING
       id::text,
       asset_revision::text,
       row_version::text,
       content_sha256,
       mime_type,
       byte_length,
       pixel_width,
       pixel_height,
       alt_text`,
    [
      target.organization_id,
      target.pipeline_id,
      target.product_id,
      content,
      sha256(content),
      content.length,
      target.actor_email,
    ],
  )
  assert.ok(inserted.rows[0], 'temporary primary image was not inserted')
  return inserted.rows[0]
}

async function nextAggregateRevision(client, target) {
  const result = await client.query(
    `SELECT GREATEST(
       COALESCE((
         SELECT max(media_grant.aggregate_revision)
         FROM operations_shopify_product_media_delivery_grants media_grant
         WHERE media_grant.organization_id = $1::uuid
           AND media_grant.integration_account_id = $2::uuid
           AND media_grant.product_id = $3::uuid
       ), 0),
       COALESCE((
         SELECT fence.aggregate_revision
         FROM operations_commerce_external_effect_aggregate_fences fence
         WHERE fence.organization_id = $1::uuid
           AND fence.integration_account_id = $2::uuid
           AND fence.provider = 'shopify'
           AND fence.aggregate_type = 'shopify_product_projection'
           AND fence.aggregate_id = $4
       ), 0)
     )::text AS current_revision`,
    [
      target.organization_id,
      target.integration_account_id,
      target.product_id,
      target.product_reference_code,
    ],
  )
  const current = Number(result.rows[0]?.current_revision || 0)
  assert.ok(
    Number.isSafeInteger(current) && current >= 0,
    'current Product projection revision is invalid',
  )
  return current + 1
}

async function advanceFence(client, target, revision, aggregateHash) {
  const result = await client.query(
    `INSERT INTO operations_commerce_external_effect_aggregate_fences (
       organization_id, integration_account_id, provider,
       aggregate_type, aggregate_id, aggregate_revision, aggregate_hash
     ) VALUES (
       $1::uuid, $2::uuid, 'shopify',
       'shopify_product_projection', $3, $4::bigint, $5
     )
     ON CONFLICT (
       organization_id, integration_account_id, provider,
       aggregate_type, aggregate_id
     ) DO UPDATE SET
       aggregate_revision = EXCLUDED.aggregate_revision,
       aggregate_hash = EXCLUDED.aggregate_hash,
       updated_at = clock_timestamp()
     WHERE operations_commerce_external_effect_aggregate_fences
             .aggregate_revision < EXCLUDED.aggregate_revision
     RETURNING aggregate_revision::text, aggregate_hash`,
    [
      target.organization_id,
      target.integration_account_id,
      target.product_reference_code,
      revision,
      aggregateHash,
    ],
  )
  assert.deepEqual(
    result.rows,
    [{ aggregate_revision: String(revision), aggregate_hash: aggregateHash }],
    'Product projection aggregate fence did not advance exactly',
  )
}

async function insertGrant(client, target, image, input) {
  const result = await client.query(
    `INSERT INTO operations_shopify_product_media_delivery_grants (
       id, organization_id, integration_account_id,
       integration_account_global_id, pipeline_id, product_id,
       channel_state_id, image_asset_id, idempotency_key, desired_mode,
       public_origin, product_reference_code, product_source_hash,
       product_gid, channel_state_global_id, channel_state_row_version,
       channel_source_revision, channel_source_hash, external_variant_id,
       channel_normalized_status, channel_provider_active,
       asset_revision, asset_row_version, asset_content_sha256,
       asset_mime_type, asset_byte_length, asset_pixel_width,
       asset_pixel_height, asset_alt_text, credential_generation,
       activation_revision, aggregate_revision, aggregate_hash, issued_at,
       expires_at, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid,
       $7::uuid, $8::uuid, $9, $10, $11, $12, $13, $14, $15,
       $16::bigint, $17, $18, $19, $20, $21, $22::bigint, $23::bigint,
       $24, $25, $26, $27, $28, $29, $30, $31, $32::bigint, $33,
       to_timestamp($34), to_timestamp($35), $36
     )
     RETURNING
       id::text,
       idempotency_key,
       aggregate_revision::text,
       aggregate_hash,
       floor(extract(epoch FROM issued_at))::text AS issued_at_epoch,
       floor(extract(epoch FROM expires_at))::text AS expires_at_epoch`,
    [
      input.id,
      target.organization_id,
      target.integration_account_id,
      target.integration_account_global_id,
      target.pipeline_id,
      target.product_id,
      target.channel_state_id,
      image.id,
      input.idempotencyKey,
      input.mode,
      PUBLIC_ORIGIN,
      target.product_reference_code,
      target.product_source_hash,
      target.product_gid,
      target.channel_state_global_id,
      target.channel_state_row_version,
      target.channel_source_revision,
      target.channel_source_hash,
      target.external_variant_id,
      target.channel_normalized_status,
      target.channel_provider_active,
      image.asset_revision,
      image.row_version,
      image.content_sha256,
      image.mime_type,
      image.byte_length,
      image.pixel_width,
      image.pixel_height,
      image.alt_text,
      target.credential_generation,
      target.activation_revision,
      input.aggregateRevision,
      input.aggregateHash,
      input.issuedAtEpoch,
      input.expiresAtEpoch,
      target.actor_email,
    ],
  )
  assert.ok(result.rows[0], `${input.mode} delivery grant was not inserted`)
  return result.rows[0]
}

function mediaRequest({
  target,
  image,
  deliveryGrantId,
  authorizationId = null,
  originalSourceSha256,
  sourceHost,
}) {
  return {
    provider: 'shopify',
    operation: 'productUpdate',
    productGid: target.product_gid,
    deliveryGrantId,
    ...(authorizationId
      ? { productMediaAuthorizationId: authorizationId }
      : {}),
    patch: {
      media: {
        mediaContentType: 'IMAGE',
        originalSourceSha256,
        sourceHost,
        altSha256: sha256(Buffer.from(image.alt_text, 'utf8')),
      },
    },
  }
}

async function insertShadowEffect(
  client,
  target,
  grant,
  redactedRequest,
) {
  const redactedResult = {
    provider: 'shopify',
    operation: 'productUpdate',
    outcome: 'simulated',
    providerWrites: 0,
  }
  const result = await client.query(
    `INSERT INTO operations_commerce_external_effect_intents (
       organization_id, integration_account_id, provider, action,
       desired_mode, credential_generation, activation_revision,
       aggregate_type, aggregate_id, aggregate_revision, aggregate_hash,
       idempotency_key, request_hash, redacted_request, state,
       redacted_result, terminal_evidence_hash, provider_write_count,
       completed_at, created_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shopify', 'shopify.product.update',
       'shadow', $3, $4, 'shopify_product_projection', $5,
       $6::bigint, $7, $8, $9, $10::jsonb, 'simulated',
       $11::jsonb, $12, 0, clock_timestamp(), $13
     )
     RETURNING id::text, global_id`,
    [
      target.organization_id,
      target.integration_account_id,
      target.credential_generation,
      target.activation_revision,
      target.product_reference_code,
      grant.aggregate_revision,
      grant.aggregate_hash,
      grant.idempotency_key,
      jsonHash(redactedRequest),
      JSON.stringify(redactedRequest),
      JSON.stringify(redactedResult),
      jsonHash(redactedResult),
      target.actor_email,
    ],
  )
  assert.ok(result.rows[0], 'zero-write Shadow simulation was not inserted')
  return result.rows[0]
}

async function insertActiveEffect(
  client,
  target,
  grant,
  authorizationId,
  redactedRequest,
) {
  return client.query(
    `INSERT INTO operations_commerce_external_effect_intents (
       organization_id, integration_account_id, provider, action,
       desired_mode, credential_generation, activation_revision,
       aggregate_type, aggregate_id, aggregate_revision, aggregate_hash,
       idempotency_key, request_hash, redacted_request,
       shopify_product_media_authorization_id, state,
       provider_write_count, created_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shopify', 'shopify.product.update',
       'active', $3, $4, 'shopify_product_projection', $5,
       $6::bigint, $7, $8, $9, $10::jsonb, $11::uuid,
       'pending', 0, $12
     )
     RETURNING id::text, global_id, request_hash, state`,
    [
      target.organization_id,
      target.integration_account_id,
      target.credential_generation,
      target.activation_revision,
      target.product_reference_code,
      grant.aggregate_revision,
      grant.aggregate_hash,
      grant.idempotency_key,
      jsonHash(redactedRequest),
      JSON.stringify(redactedRequest),
      authorizationId,
      target.actor_email,
    ],
  )
}

async function insertAuthorization(
  client,
  target,
  activeGrant,
  simulation,
  input = {},
) {
  const result = await client.query(
    `INSERT INTO
       operations_shopify_product_media_write_authorizations (
         organization_id,
         integration_account_id,
         delivery_grant_id,
         simulation_effect_id,
         provider_write_activation_revision,
         confirmation_statement_version,
         authorized_by,
         authorized_role,
         authorized_at,
         expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
         $7, $8, to_timestamp($9), to_timestamp($10)
       )
       RETURNING id::text`,
    [
      target.organization_id,
      target.integration_account_id,
      activeGrant.id,
      simulation.id,
      target.activation_revision,
      CONFIRMATION_STATEMENT,
      target.actor_email,
      target.actor_role,
      input.authorizedAtEpoch,
      input.expiresAtEpoch,
    ],
  )
  assert.ok(result.rows[0], 'exact Product-image authority was not inserted')
  return result.rows[0]
}

async function insertSourceBinding(
  client,
  target,
  image,
  activeGrant,
  authorization,
  source,
  overrides = {},
) {
  const values = {
    organizationId: target.organization_id,
    integrationAccountId: target.integration_account_id,
    authorizationId: authorization.id,
    deliveryGrantId: activeGrant.id,
    sourceUrlSha256: source.sourceUrlSha256,
    sourceOrigin: PUBLIC_ORIGIN,
    sourceHost: source.sourceHost,
    signedTokenSha256: source.signedTokenSha256,
    tokenProductId: target.product_id,
    tokenImageAssetId: image.id,
    tokenAssetContentSha256: image.content_sha256,
    tokenMode: 'active',
    tokenIssuedAtEpoch: activeGrant.issued_at_epoch,
    tokenExpiresAtEpoch: activeGrant.expires_at_epoch,
    boundBy: target.actor_email,
    ...overrides,
  }
  return client.query(
    `INSERT INTO operations_shopify_product_media_source_bindings (
       organization_id, integration_account_id, authorization_id,
       delivery_grant_id, source_url_sha256, source_origin, source_host,
       signed_token_sha256, token_product_id, token_image_asset_id,
       token_asset_content_sha256, token_mode, token_issued_at_epoch,
       token_expires_at_epoch, bound_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
       $9::uuid, $10::uuid, $11, $12, $13::bigint, $14::bigint, $15
     )
     RETURNING id::text`,
    [
      values.organizationId,
      values.integrationAccountId,
      values.authorizationId,
      values.deliveryGrantId,
      values.sourceUrlSha256,
      values.sourceOrigin,
      values.sourceHost,
      values.signedTokenSha256,
      values.tokenProductId,
      values.tokenImageAssetId,
      values.tokenAssetContentSha256,
      values.tokenMode,
      values.tokenIssuedAtEpoch,
      values.tokenExpiresAtEpoch,
      values.boundBy,
    ],
  )
}

async function claimEffect(
  client,
  target,
  activeEffect,
  activeGrant,
  redactedRequest,
) {
  const leaseToken = randomUUID()
  const attempt = await client.query(
    `INSERT INTO operations_commerce_provider_attempts (
       organization_id, integration_account_id, action, adapter_version,
       idempotency_key, request_hash, redacted_request, state,
       attempt_number, lease_token, lease_expires_at, created_by
     ) VALUES (
       $1::uuid, $2::uuid, 'external_effect:shopify.product.update',
       'postgres-authority-contract-v1', $3, $4, $5::jsonb,
       'prepared', 1, $6::uuid, clock_timestamp() + interval '60 seconds',
       $7
     )
     RETURNING id::text`,
    [
      target.organization_id,
      target.integration_account_id,
      activeGrant.idempotency_key,
      activeEffect.request_hash,
      JSON.stringify(redactedRequest),
      leaseToken,
      target.actor_email,
    ],
  )
  const claimed = await client.query(
    `UPDATE operations_commerce_external_effect_intents
     SET state = 'claimed',
         provider_attempt_id = $3::uuid,
         lease_token = $4::uuid,
         lease_expires_at = clock_timestamp() + interval '60 seconds',
         claimed_by = 'postgres-authority-contract',
         claimed_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND state = 'pending'
     RETURNING state, provider_attempt_id::text`,
    [
      target.organization_id,
      activeEffect.id,
      attempt.rows[0].id,
      leaseToken,
    ],
  )
  assert.deepEqual(
    claimed.rows,
    [{ state: 'claimed', provider_attempt_id: attempt.rows[0].id }],
    'exact Product-image provider attempt was not claimable',
  )
  return claimed.rows[0]
}

async function assertSecondProductSameParentRejected(
  client,
  target,
  runId,
) {
  const syntheticProduct = await client.query(
    `INSERT INTO crm_products (
       pipeline_id, source_key, name, source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $5
     )
     RETURNING id::text`,
    [
      target.pipeline_id,
      `rollback-only:${runId}`,
      `Rollback-only Product ${runId}`,
      sha256(Buffer.from(`product:${runId}`, 'utf8')),
      target.actor_email,
    ],
  )
  const alternateVariant =
    `gid://shopify/ProductVariant/${String(Date.now()).padEnd(13, '7')}`
  const mapping = await client.query(
    `INSERT INTO operations_product_mappings (
       organization_id, integration_account_id, pipeline_id, product_id,
       channel_sku, external_product_id, external_variant_id,
       mapping_method, mapping_source_revision, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
       'exact_variant', $8, true, $9
     )
     RETURNING id::text`,
    [
      target.organization_id,
      target.integration_account_id,
      target.pipeline_id,
      syntheticProduct.rows[0].id,
      `ROLLBACK-${runId.slice(0, 18)}`,
      target.product_gid,
      alternateVariant,
      `rollback-only:${runId}`,
      target.actor_email,
    ],
  )
  await expectDatabaseRejection(
    client,
    'second ClawPilot Product mapped to the same Shopify parent',
    () => client.query(
      `INSERT INTO operations_product_channel_states (
         organization_id, integration_account_id, pipeline_id, provider,
         external_product_id, external_variant_id, product_id,
         product_mapping_id, provider_status_raw, normalized_status,
         provider_active, observed_at, source_revision, source_hash,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify',
         $4, $5, $6::uuid, $7::uuid, 'ACTIVE', 'active',
         true, clock_timestamp(), $8, $9, $10, $10
       )`,
      [
        target.organization_id,
        target.integration_account_id,
        target.pipeline_id,
        target.product_gid,
        alternateVariant,
        syntheticProduct.rows[0].id,
        mapping.rows[0].id,
        `rollback-only:${runId}`,
        sha256(Buffer.from(`channel:${runId}`, 'utf8')),
        target.actor_email,
      ],
    ),
    /cannot map to a second ClawPilot Product|parent Product GID/i,
  )
}

async function runAuthorityAcceptance(client) {
  const runId = randomUUID()
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(
         'shopify-product-image-postgres-rollback-acceptance',
         0
       )
     )`,
  )
  const target = await selectExactTarget(client)
  const image = await selectOrCreatePrimaryImage(client, target, runId)
  const shadowRevision = await nextAggregateRevision(client, target)
  const activeRevision = shadowRevision + 1
  const nowEpoch = Number(target.now_epoch)
  const shadowHash = sha256(Buffer.from(`shadow:${runId}`, 'utf8'))
  const activeHash = sha256(Buffer.from(`active:${runId}`, 'utf8'))

  await advanceFence(client, target, shadowRevision, shadowHash)
  const shadowGrant = await insertGrant(client, target, image, {
    id: randomUUID(),
    idempotencyKey: `pg-shadow-image:${runId}`,
    mode: 'shadow',
    aggregateRevision: shadowRevision,
    aggregateHash: shadowHash,
    issuedAtEpoch: nowEpoch,
    expiresAtEpoch: nowEpoch + 60,
  })
  const shadowRequest = mediaRequest({
    target,
    image,
    deliveryGrantId: shadowGrant.id,
    originalSourceSha256:
      sha256(Buffer.from(`shadow-source:${runId}`, 'utf8')),
    sourceHost: new URL(PUBLIC_ORIGIN).hostname,
  })
  const simulation = await insertShadowEffect(
    client,
    target,
    shadowGrant,
    shadowRequest,
  )

  await advanceFence(client, target, activeRevision, activeHash)
  const activeGrant = await insertGrant(client, target, image, {
    id: randomUUID(),
    idempotencyKey: `pg-active-image:${runId}`,
    mode: 'active',
    aggregateRevision: activeRevision,
    aggregateHash: activeHash,
    issuedAtEpoch: nowEpoch,
    expiresAtEpoch: nowEpoch + (15 * 60),
  })

  const unsignedActiveRequest = mediaRequest({
    target,
    image,
    deliveryGrantId: activeGrant.id,
    originalSourceSha256:
      sha256(Buffer.from(`unsigned-source:${runId}`, 'utf8')),
    sourceHost: new URL(PUBLIC_ORIGIN).hostname,
  })
  await expectDatabaseRejection(
    client,
    'generic Active image write without exact authority',
    () => insertActiveEffect(
      client,
      target,
      activeGrant,
      null,
      unsignedActiveRequest,
    ),
    /requires exact resource-scoped Shadow authority/i,
  )

  await expectDatabaseRejection(
    client,
    'legacy authorization without resource-scoped columns',
    () => client.query(
      `INSERT INTO
         operations_shopify_product_media_write_authorizations (
           organization_id, integration_account_id, delivery_grant_id,
           authorized_by, authorized_role, authorized_at, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5,
           to_timestamp($6), to_timestamp($7)
         )`,
      [
        target.organization_id,
        target.integration_account_id,
        activeGrant.id,
        target.actor_email,
        target.actor_role,
        nowEpoch,
        nowEpoch + (5 * 60),
      ],
    ),
    /exact short-lived Shadow simulation evidence|invalid/i,
  )

  await expectDatabaseRejection(
    client,
    'expired resource authority',
    () => insertAuthorization(
      client,
      target,
      activeGrant,
      simulation,
      {
        authorizedAtEpoch: nowEpoch - 120,
        expiresAtEpoch: nowEpoch - 60,
      },
    ),
    /invalid|stale|expiry|short-lived/i,
  )

  const authorization = await insertAuthorization(
    client,
    target,
    activeGrant,
    simulation,
    {
      authorizedAtEpoch: nowEpoch,
      expiresAtEpoch: nowEpoch + (5 * 60),
    },
  )
  const replayGrant = await insertGrant(client, target, image, {
    id: randomUUID(),
    idempotencyKey: `pg-active-image-replay:${runId}`,
    mode: 'active',
    aggregateRevision: activeRevision + 1,
    aggregateHash:
      sha256(Buffer.from(`active-replay:${runId}`, 'utf8')),
    issuedAtEpoch: nowEpoch,
    expiresAtEpoch: nowEpoch + (15 * 60),
  })
  const replayAuthorizationError = await expectDatabaseRejection(
    client,
    'second authorization consuming the same Shadow simulation',
    () => insertAuthorization(
      client,
      target,
      replayGrant,
      simulation,
      {
        authorizedAtEpoch: nowEpoch,
        expiresAtEpoch: nowEpoch + (5 * 60),
      },
    ),
    /duplicate key|already exists/i,
  )
  assert.equal(
    replayAuthorizationError.constraint,
    'idx_ops_shopify_media_auth_simulation_effect',
    'Shadow simulation replay must fail on its exact one-use index',
  )
  const token = `rollback.${Buffer.from(runId).toString('base64url')}`
  const originalSource =
    `${PUBLIC_ORIGIN}/api/integrations/commerce/shopify/product-media/${token}`
  const sourceUrlSha256 = sha256(Buffer.from(originalSource, 'utf8'))
  const sourceHost = new URL(originalSource).hostname
  const source = {
    sourceUrlSha256,
    sourceHost,
    signedTokenSha256: sha256(Buffer.from(token, 'utf8')),
  }
  for (const mismatch of [
    {
      label: 'source binding origin mismatch',
      overrides: {
        sourceOrigin: 'https://alternate.example.test',
        sourceHost: 'alternate.example.test',
      },
    },
    {
      label: 'source binding host mismatch',
      overrides: { sourceHost: 'alternate.example.test' },
    },
    {
      label: 'source binding Product mismatch',
      overrides: { tokenProductId: randomUUID() },
    },
    {
      label: 'source binding image-asset mismatch',
      overrides: { tokenImageAssetId: randomUUID() },
    },
    {
      label: 'source binding image-content mismatch',
      overrides: { tokenAssetContentSha256: 'f'.repeat(64) },
    },
    {
      label: 'source binding token epoch mismatch',
      overrides: {
        tokenIssuedAtEpoch:
          Number(activeGrant.issued_at_epoch) + 1,
      },
    },
  ]) {
    await expectDatabaseRejection(
      client,
      mismatch.label,
      () => insertSourceBinding(
        client,
        target,
        image,
        activeGrant,
        authorization,
        source,
        mismatch.overrides,
      ),
      /signed source binding is stale or mismatched/i,
    )
  }
  const sourceBinding = await insertSourceBinding(
    client,
    target,
    image,
    activeGrant,
    authorization,
    source,
  )
  assert.equal(sourceBinding.rows.length, 1)
  for (const mutation of [
    {
      label: 'source binding update',
      sql: `UPDATE operations_shopify_product_media_source_bindings
            SET source_url_sha256 = $3
            WHERE organization_id = $1::uuid
              AND id = $2::uuid`,
      values: [
        target.organization_id,
        sourceBinding.rows[0].id,
        'e'.repeat(64),
      ],
    },
    {
      label: 'source binding delete',
      sql: `DELETE FROM operations_shopify_product_media_source_bindings
            WHERE organization_id = $1::uuid
              AND id = $2::uuid`,
      values: [target.organization_id, sourceBinding.rows[0].id],
    },
  ]) {
    await expectDatabaseRejection(
      client,
      mutation.label,
      () => client.query(mutation.sql, mutation.values),
      /signed source bindings are immutable/i,
    )
  }

  const activeRequest = mediaRequest({
    target,
    image,
    deliveryGrantId: activeGrant.id,
    authorizationId: authorization.id,
    originalSourceSha256: sourceUrlSha256,
    sourceHost,
  })
  for (const mismatch of [
    {
      label: 'alternate signed source hash',
      request: mediaRequest({
        target,
        image,
        deliveryGrantId: activeGrant.id,
        authorizationId: authorization.id,
        originalSourceSha256:
          sha256(Buffer.from(`alternate-source:${runId}`, 'utf8')),
        sourceHost,
      }),
    },
    {
      label: 'alternate signed source host',
      request: mediaRequest({
        target,
        image,
        deliveryGrantId: activeGrant.id,
        authorizationId: authorization.id,
        originalSourceSha256: sourceUrlSha256,
        sourceHost: 'alternate.example.test',
      }),
    },
  ]) {
    await expectDatabaseRejection(
      client,
      mismatch.label,
      () => insertActiveEffect(
        client,
        target,
        activeGrant,
        authorization.id,
        mismatch.request,
      ),
      /resource-scoped Shadow authority is stale|mismatched|invalid/i,
    )
  }

  const activeEffectResult = await insertActiveEffect(
    client,
    target,
    activeGrant,
    authorization.id,
    activeRequest,
  )
  assert.equal(activeEffectResult.rows.length, 1)
  const activeEffect = activeEffectResult.rows[0]

  await expectDatabaseRejection(
    client,
    'single-use authority replay',
    () => insertActiveEffect(
      client,
      target,
      activeGrant,
      authorization.id,
      activeRequest,
    ),
    /duplicate key|already exists|stale|invalid/i,
  )

  const deliverableBeforeClaim = await client.query(
    `SELECT operations_shopify_product_media_delivery_is_authorized(
       $1::uuid,
       $2::uuid
     ) AS authorized`,
    [target.organization_id, activeGrant.id],
  )
  assert.equal(
    deliverableBeforeClaim.rows[0]?.authorized,
    false,
    'signed media bytes must not be deliverable before the exact claim',
  )

  await expectDatabaseRejection(
    client,
    'channel revision drift at provider claim',
    async () => {
      await client.query(
        `UPDATE operations_product_channel_states
         SET row_version = row_version + 1,
             source_revision = source_revision || ':rollback-drift',
             source_hash = $4,
             updated_by = $5,
             updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND id = $3::uuid`,
        [
          target.organization_id,
          target.integration_account_id,
          target.channel_state_id,
          sha256(Buffer.from(`drift:${runId}`, 'utf8')),
          target.actor_email,
        ],
      )
      await claimEffect(
        client,
        target,
        activeEffect,
        activeGrant,
        activeRequest,
      )
    },
    /authority is stale|mismatched|invalid/i,
  )

  await claimEffect(
    client,
    target,
    activeEffect,
    activeGrant,
    activeRequest,
  )
  const deliverableAfterClaim = await client.query(
    `SELECT operations_shopify_product_media_delivery_is_authorized(
       $1::uuid,
       $2::uuid
     ) AS authorized`,
    [target.organization_id, activeGrant.id],
  )
  assert.equal(
    deliverableAfterClaim.rows[0]?.authorized,
    true,
    'exact claimed authority must enable only its bound media bytes',
  )

  await assertSecondProductSameParentRejected(client, target, runId)

  return {
    targetProduct: target.product_reference_code,
    targetAccount: target.integration_account_global_id,
    targetChannel: target.channel_state_global_id,
    exactSuccess: true,
    noAuthorizationRejected: true,
    replayRejected: true,
    driftRejected: true,
    alternateSourceHashRejected: true,
    alternateSourceHostRejected: true,
    secondProductSameParentRejected: true,
    expiredAuthorityRejected: true,
    legacyAuthorityRejected: true,
    providerCalls: 0,
  }
}

async function main() {
  const client = await pool.connect()
  let beforeObjects
  let beforeData
  let beforeMigrations
  let acceptance
  let targetPreviouslyApplied = false
  let executedTargetInsideTransaction = false
  try {
    assert.equal(
      await databaseFingerprint(client),
      TRUSTED_DATABASE_FINGERPRINT,
      'connected database is not the trusted ClawPilot development database',
    )
    beforeMigrations = await migrationState(client)
    assert.ok(
      beforeMigrations.includes(REQUIRED_APPLIED_MIGRATION),
      `rollback-only acceptance requires ${REQUIRED_APPLIED_MIGRATION}`,
    )
    beforeObjects = await objectState(client)
    beforeData = await dataState(client)
    const targetApplied = beforeMigrations.includes(TARGET_MIGRATION)
    targetPreviouslyApplied = targetApplied
    const sourceBindingExists = beforeObjects.relations.some(
      (row) => (
        row.name ===
          'operations_shopify_product_media_source_bindings'
        && row.relation_name !== null
      ),
    )
    assert.equal(
      sourceBindingExists,
      targetApplied,
      '0160 migration history and Product-image authority schema disagree',
    )

    await client.query('BEGIN')
    try {
      await client.query(`SET LOCAL statement_timeout = '120s'`)
      await client.query(`SET LOCAL lock_timeout = '15s'`)
      await client.query(migrationSql())
      executedTargetInsideTransaction = true
      const upgradedObjects = await objectState(client)
      assert.ok(
        upgradedObjects.relations.some(
          (row) => (
            row.name ===
              'operations_shopify_product_media_source_bindings'
            && row.relation_name !== null
          ),
        ),
        '0160 signed-source binding table is missing',
      )
      assert.equal(
        upgradedObjects.functions.length,
        6,
        '0160 exact Product-image authority functions are incomplete',
      )
      acceptance = await runAuthorityAcceptance(client)
    } finally {
      await client.query('ROLLBACK')
    }
  } finally {
    client.release()
  }

  const verification = await pool.connect()
  try {
    assert.equal(
      await databaseFingerprint(verification),
      TRUSTED_DATABASE_FINGERPRINT,
    )
    assert.deepEqual(
      await migrationState(verification),
      beforeMigrations,
      'rollback changed schema migration history',
    )
    assert.deepEqual(
      await objectState(verification),
      beforeObjects,
      'rollback left Shopify Product-image schema residue',
    )
    assert.deepEqual(
      await dataState(verification),
      beforeData,
      'rollback left Shopify Product-image data residue',
    )
  } finally {
    verification.release()
    await pool.end()
  }

  console.log(JSON.stringify({
    ok: true,
    acceptance: 'rollback-only-postgres',
    environment: 'development',
    databaseFingerprint: TRUSTED_DATABASE_FINGERPRINT,
    requiredAppliedMigration: REQUIRED_APPLIED_MIGRATION,
    targetMigration: TARGET_MIGRATION,
    targetPreviouslyApplied,
    executedTargetInsideTransaction,
    ...acceptance,
    retainedSchemaOrData: false,
  }, null, 2))
}

main().catch(async (error) => {
  await pool.end().catch(() => undefined)
  console.error(error)
  process.exit(1)
})
