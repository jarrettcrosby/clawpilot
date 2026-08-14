#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const CONFIRMATION = 'RECORD_BLOCKED_SCOPE_WITH_ZERO_PROVIDER_WRITES'
// This is the durable deployment.database.identity value recorded by the
// ClawPilot development database.  Caller-provided environment labels are not
// trusted as deployment evidence.
const TRUSTED_DEVELOPMENT_DATABASE_IDENTITY =
  '750aa268-0e31-4065-a99c-4016e4d4fab1'
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const CUSTOMER_GLOBAL_ID = /^ga(?:[0-9]{7}|[0-9a-v]{12})$/u
const MAPPING_GLOBAL_ID = /^gpm(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u

function fail(message) {
  throw new Error(message)
}

function argument(name) {
  const prefix = `--${name}=`
  const values = process.argv.slice(2).filter((entry) => entry.startsWith(prefix))
  if (values.length !== 1) fail(`Exactly one ${prefix}<value> is required`)
  const value = values[0].slice(prefix.length).trim()
  if (!value) fail(`${name} is required`)
  return value
}

function exactGlobalId(name, pattern) {
  const value = argument(name).toLowerCase()
  if (!pattern.test(value)) fail(`${name} is invalid`)
  return value
}

function exactReason() {
  const value = argument('reason')
  if (
    value.length < 10
    || value.length > 500
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail('reason must contain 10-500 visible characters')
  }
  return value
}

function exactActorEmail() {
  const value = argument('actor-email').toLowerCase()
  if (
    value.length > 320
    || !value.includes('@')
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail('actor-email is invalid')
  }
  return value
}

function exactIdempotencyKey() {
  const value = argument('idempotency-key')
  if (!IDEMPOTENCY_KEY.test(value)) fail('idempotency-key is invalid')
  return value
}

function requestHash(input) {
  return createHash('sha256').update(JSON.stringify({
    version: 'commerce-provider-write-scope-request-v1',
    deploymentScope: 'development',
    provider: 'shopify',
    requestedResources: ['orders', 'inventory'],
    state: 'blocked',
    providerWriteEnabled: false,
    supportedOutboundEffect: null,
    blockerCodes: [
      'COMMERCE_ORDER_WRITE_ADAPTER_UNAVAILABLE',
      'COMMERCE_CUSTOMER_SCOPED_INVENTORY_NOT_REPRESENTABLE',
    ],
    accountGlobalId: input.accountGlobalId,
    customerGlobalId: input.customerGlobalId,
    productMappingGlobalId: input.productMappingGlobalId,
    reason: input.reason,
    actorEmail: input.actorEmail,
  })).digest('hex')
}

function databaseUrl() {
  const value = String(
    process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '',
  ).trim()
  if (!/^postgres(?:ql)?:\/\//u.test(value)) {
    fail('DATABASE_PUBLIC_URL or DATABASE_URL must be a PostgreSQL URL')
  }
  return value
}

async function assertTrustedDevelopmentDatabase(client) {
  const result = await client.query(
    `SELECT current_database() AS database_name,
            value->>'id' AS database_identity
     FROM app_settings
     WHERE key = 'deployment.database.identity'
     LIMIT 1`,
  )
  const evidence = result.rows[0]
  if (
    evidence?.database_name !== 'railway'
    || evidence?.database_identity !== TRUSTED_DEVELOPMENT_DATABASE_IDENTITY
  ) {
    fail('Connected database is not the verified ClawPilot development database')
  }
}

async function main() {
  const apply = process.argv.slice(2).includes('--apply')
  const confirmation = argument('confirm')
  if (confirmation !== CONFIRMATION) {
    fail(`confirm must equal ${CONFIRMATION}`)
  }
  const input = {
    accountGlobalId: exactGlobalId('account-global-id', ACCOUNT_GLOBAL_ID),
    customerGlobalId: exactGlobalId('customer-global-id', CUSTOMER_GLOBAL_ID),
    productMappingGlobalId: exactGlobalId(
      'product-mapping-global-id',
      MAPPING_GLOBAL_ID,
    ),
    actorEmail: exactActorEmail(),
    idempotencyKey: exactIdempotencyKey(),
    reason: exactReason(),
  }
  const hash = requestHash(input)
  const pool = new Pool({
    connectionString: databaseUrl(),
    ssl: String(process.env.PGSSLMODE || '').toLowerCase() === 'disable'
      ? undefined
      : { rejectUnauthorized: false },
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await assertTrustedDevelopmentDatabase(client)
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [
        `commerce-provider-write-scope:${input.accountGlobalId}:${input.customerGlobalId}:${input.productMappingGlobalId}`,
      ],
    )
    const evidenceResult = await client.query(
      `SELECT
         account.organization_id::text,
         account.id::text AS integration_account_id,
         account.global_id AS account_global_id,
         account.external_account_id,
         account.provider,
         account.environment,
         account.commerce_credential_generation AS credential_generation,
         mapping.pipeline_id::text,
         mapping.id::text AS product_mapping_id,
         mapping.global_id AS product_mapping_global_id,
         mapping.product_id::text,
         mapping.channel_sku,
         mapping.external_product_id,
         mapping.external_variant_id,
         mapping.external_inventory_item_id AS mapping_external_inventory_item_id,
         mapping.updated_at::text AS product_mapping_updated_at,
         product.reference_code AS product_global_id,
         product.name AS product_name,
         customer.id::text AS customer_id,
         customer.reference_code AS customer_global_id,
         customer.name AS customer_name,
         channel_state.id::text AS channel_state_id,
         channel_state.external_inventory_item_id,
         channel_state.row_version AS channel_state_row_version,
         channel_state.source_hash AS channel_state_source_hash,
         channel_state.observed_at::text AS channel_state_observed_at,
         membership.role AS actor_role
       FROM operations_integration_accounts account
       JOIN operations_product_mappings mapping
         ON mapping.organization_id = account.organization_id
        AND mapping.integration_account_id = account.id
       JOIN crm_products product
         ON product.pipeline_id = mapping.pipeline_id
        AND product.id = mapping.product_id
       JOIN crm_organizations customer
         ON customer.pipeline_id = mapping.pipeline_id
        AND customer.reference_code = $2
       JOIN LATERAL (
         SELECT state.id, state.external_inventory_item_id,
                state.row_version, state.source_hash, state.observed_at
         FROM operations_product_channel_states state
         WHERE state.organization_id = mapping.organization_id
           AND state.integration_account_id = mapping.integration_account_id
           AND state.product_mapping_id = mapping.id
           AND state.product_id = mapping.product_id
           AND state.pipeline_id = mapping.pipeline_id
           AND state.external_product_id = mapping.external_product_id
           AND state.external_variant_id = mapping.external_variant_id
           AND state.external_inventory_item_id IS NOT NULL
           AND state.external_inventory_item_id =
                 mapping.external_inventory_item_id
           AND state.normalized_status IN ('active', 'unlisted')
         LIMIT 1
       ) channel_state ON true
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.external_account_id = account.external_account_id
        AND credential.credential_version =
              account.commerce_credential_generation
        AND credential.auth_mode = 'shopify_client_credentials'
        AND credential.verification_status = 'verified'
       JOIN app_user_organization_memberships membership
         ON membership.organization_id = account.organization_id
        AND membership.user_email = $4
        AND membership.status = 'active'
        AND (
          membership.role = 'owner'
          OR (
            membership.role = 'admin'
            AND COALESCE(
              (membership.permissions->>'manageOperations')::boolean,
              false
            )
          )
        )
       WHERE account.global_id = $1
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
         AND account.environment = 'sandbox'
         AND account.status = 'active'
         AND mapping.global_id = $3
         AND mapping.active = true
         AND product.active = true
       LIMIT 2`,
      [
        input.accountGlobalId,
        input.customerGlobalId,
        input.productMappingGlobalId,
        input.actorEmail,
      ],
    )
    if (evidenceResult.rows.length !== 1) {
      fail('Exact sandbox account, customer, product mapping, and actor scope did not resolve')
    }
    const evidence = evidenceResult.rows[0]
    if (!evidence.external_inventory_item_id) {
      fail('The exact Shopify product mapping lacks an inventory item identity')
    }

    const prior = await client.query(
      `SELECT global_id, request_hash
       FROM operations_commerce_provider_write_scope_requests
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND idempotency_key = $3
       LIMIT 1`,
      [
        evidence.organization_id,
        evidence.integration_account_id,
        input.idempotencyKey,
      ],
    )
    if (prior.rows[0] && prior.rows[0].request_hash !== hash) {
      fail('idempotency-key was already used for a different scope request')
    }

    let requestGlobalId = prior.rows[0]?.global_id || null
    let replayed = Boolean(requestGlobalId)
    if (!requestGlobalId) {
      const existingScope = await client.query(
        `SELECT global_id, request_hash
         FROM operations_commerce_provider_write_scope_requests
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND customer_id = $3::uuid
           AND product_mapping_id = $4::uuid
           AND deployment_scope = 'development'
         LIMIT 1`,
        [
          evidence.organization_id,
          evidence.integration_account_id,
          evidence.customer_id,
          evidence.product_mapping_id,
        ],
      )
      if (existingScope.rows[0]) {
        fail(
          'This exact blocked scope request already exists under another idempotency key',
        )
      }
      const inserted = await client.query(
        `INSERT INTO operations_commerce_provider_write_scope_requests (
           organization_id, integration_account_id, pipeline_id, customer_id,
           product_mapping_id, product_id, provider, account_environment,
           deployment_scope, requested_resources, state,
           provider_write_enabled, supported_outbound_effect, blocker_codes,
           account_global_id, external_account_id, customer_global_id,
           product_global_id, product_mapping_global_id, channel_sku,
           external_product_id,
           external_variant_id, external_inventory_item_id,
           credential_generation, product_mapping_updated_at,
           channel_state_id, channel_state_row_version,
           channel_state_source_hash, channel_state_observed_at, request_reason,
           recorded_by, recorded_role, idempotency_key, request_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           'shopify', 'sandbox', 'development',
           ARRAY['orders', 'inventory']::text[], 'blocked', false, NULL,
           ARRAY[
             'COMMERCE_ORDER_WRITE_ADAPTER_UNAVAILABLE',
             'COMMERCE_CUSTOMER_SCOPED_INVENTORY_NOT_REPRESENTABLE'
           ]::text[],
           $7, $8, $9, $10, $11, $12, $13, $14, $15,
           $16::integer, $17::timestamptz, $18::uuid, $19::bigint,
           $20, $21::timestamptz, $22, $23, $24, $25, $26
         ) RETURNING global_id`,
        [
          evidence.organization_id,
          evidence.integration_account_id,
          evidence.pipeline_id,
          evidence.customer_id,
          evidence.product_mapping_id,
          evidence.product_id,
          evidence.account_global_id,
          evidence.external_account_id,
          evidence.customer_global_id,
          evidence.product_global_id,
          evidence.product_mapping_global_id,
          evidence.channel_sku,
          evidence.external_product_id,
          evidence.external_variant_id,
          evidence.external_inventory_item_id,
          evidence.credential_generation,
          evidence.product_mapping_updated_at,
          evidence.channel_state_id,
          evidence.channel_state_row_version,
          evidence.channel_state_source_hash,
          evidence.channel_state_observed_at,
          input.reason,
          input.actorEmail,
          evidence.actor_role,
          input.idempotencyKey,
          hash,
        ],
      )
      requestGlobalId = inserted.rows[0]?.global_id || null
      if (!requestGlobalId) fail('Blocked scope request was not retained')
      replayed = false
      await client.query(
        `INSERT INTO audit_events (
           actor, event_type, aggregate_type, aggregate_id, payload,
           event_key, subject, organization_id, is_system
         ) VALUES (
           $1, 'commerce.provider_write_scope.blocked_request_recorded',
           'operations.commerce_provider_write_scope_request', $2,
           $3::jsonb, $4, $1, $5::uuid, false
         )
         ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
        [
          input.actorEmail,
          requestGlobalId,
          JSON.stringify({
            provider: 'shopify',
            accountGlobalId: evidence.account_global_id,
            customerGlobalId: evidence.customer_global_id,
            productGlobalId: evidence.product_global_id,
            productMappingGlobalId: evidence.product_mapping_global_id,
            requestedResources: ['orders', 'inventory'],
            state: 'blocked',
            providerWriteEnabled: false,
            supportedOutboundEffect: null,
            blockerCodes: [
              'COMMERCE_ORDER_WRITE_ADAPTER_UNAVAILABLE',
              'COMMERCE_CUSTOMER_SCOPED_INVENTORY_NOT_REPRESENTABLE',
            ],
            reason: input.reason,
          }),
          `commerce-provider-write-scope:${evidence.organization_id}:${evidence.account_global_id}:${input.idempotencyKey}`,
          evidence.organization_id,
        ],
      )
    }

    if (apply) await client.query('COMMIT')
    else await client.query('ROLLBACK')
    console.log(JSON.stringify({
      ok: true,
      applied: apply,
      replayed,
      requestGlobalId: apply ? requestGlobalId : null,
      accountGlobalId: evidence.account_global_id,
      customer: {
        globalId: evidence.customer_global_id,
        name: evidence.customer_name,
      },
      product: {
        globalId: evidence.product_global_id,
        mappingGlobalId: evidence.product_mapping_global_id,
        name: evidence.product_name,
        channelSku: evidence.channel_sku,
      },
      state: 'blocked',
      providerWriteEnabled: false,
      supportedOutboundEffect: null,
      blockerCodes: [
        'COMMERCE_ORDER_WRITE_ADAPTER_UNAVAILABLE',
        'COMMERCE_CUSTOMER_SCOPED_INVENTORY_NOT_REPRESENTABLE',
      ],
    }, null, 2))
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original failure.
    }
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
