#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
const actorEmail = 'commerce-staging-postgres-test@episcs.com'
const observedAt = '2026-07-31T18:00:00.000Z'
const retentionExpiresAt = '2026-08-29T18:00:00.000Z'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}, globals = {}) {
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
    BigInt,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
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
    ...globals,
  }, { filename: path })
  return module.exports
}

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
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

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  return JSON.stringify(value) ?? 'null'
}

function commandHash(value) {
  return hash(canonicalJson(value))
}

function available(value) {
  return Object.freeze({ state: 'available', value })
}

function unavailable(reason = 'not_provided') {
  return Object.freeze({ state: 'unavailable', value: null, reason })
}

function money(amountMinor, currency) {
  const value = Object.freeze({ amountMinor: BigInt(amountMinor), currency })
  return available(Object.freeze({
    primary: value,
    shop: available(value),
    presentment: unavailable(),
  }))
}

function orderFixture(input) {
  const lineHash = hash(`line:${input.key}`)
  const orderHash = hash(`order:${input.key}`)
  const fulfilled = input.unfulfilledQuantity === 0
  const orderedQuantity = input.orderedQuantity ?? 1
  return Object.freeze({
    schemaVersion: 'commerce-normalized-order-v1',
    identity: Object.freeze({
      provider: 'shopify',
      resourceType: 'order',
      value: `gid://shopify/Order/${input.key}`,
    }),
    orderNumber: `POSTGRES-${input.key}`,
    providerCreatedAt: observedAt,
    providerProcessedAt: observedAt,
    providerUpdatedAt: observedAt,
    providerCancelledAt: null,
    providerClosedAt: null,
    rawStates: Object.freeze({
      lifecycle: 'OPEN',
      payment: 'PAID',
      fulfillment: fulfilled ? 'FULFILLED' : 'UNFULFILLED',
      returns: 'NONE',
    }),
    canonicalStates: Object.freeze({
      lifecycle: 'open',
      payment: 'paid',
      fulfillment: fulfilled ? 'fulfilled' : 'unfulfilled',
      returns: 'none',
    }),
    currency: 'USD',
    subtotal: money(0, 'USD'),
    shipping: money(0, 'USD'),
    tax: money(0, 'USD'),
    discount: money(0, 'USD'),
    total: money(0, 'USD'),
    headerMoney: Object.freeze({
      state: 'complete',
      unavailableFields: Object.freeze([]),
      fulfillmentDemandEligible: true,
      accountingEligible: true,
      customerChargeEligible: true,
    }),
    party: unavailable(),
    shipTo: unavailable(),
    requestedDeliveryAt: unavailable(),
    lines: Object.freeze([Object.freeze({
      schemaVersion: 'commerce-normalized-order-line-v1',
      identity: Object.freeze({
        provider: 'shopify',
        resourceType: 'order_line',
        value: `gid://shopify/LineItem/${input.key}`,
      }),
      productIdentity: available(Object.freeze({
        provider: 'shopify',
        resourceType: 'product',
        value: `gid://shopify/Product/${input.key}`,
      })),
      variantIdentity: available(Object.freeze({
        provider: 'shopify',
        resourceType: 'variant',
        value: input.variantId,
      })),
      sku: `POSTGRES-${input.key}`,
      titleSnapshot: `PostgreSQL staging ${input.key}`,
      variantTitleSnapshot: 'Default',
      vendorSnapshot: 'ClawPilot acceptance',
      orderedQuantity,
      currentQuantity: orderedQuantity,
      cancelledQuantity: 0,
      fulfilledQuantity: fulfilled ? orderedQuantity : 0,
      unfulfilledQuantity: input.unfulfilledQuantity,
      returnedQuantity: 0,
      removedOrRefundedQuantity: 0,
      unitMultiplier: 1,
      physicalUnitQuantity: orderedQuantity,
      unitPrice: input.unitPrice,
      lineSubtotal: input.lineSubtotal || input.unitPrice,
      lineDiscount: input.lineDiscount || (input.unitPrice.state === 'available'
        ? money(0, input.unitPrice.value.primary.currency)
        : unavailable()),
      lineTax: input.lineTax || (input.unitPrice.state === 'available'
        ? money(0, input.unitPrice.value.primary.currency)
        : unavailable()),
      requiresShipping: false,
      packaging: unavailable(),
      sourceHash: lineHash,
    })]),
    lineItemsTruncated: false,
    sourceStale: false,
    readinessFacts: Object.freeze([Object.freeze({
      dimension: 'product',
      code: 'product_mapping_required',
      blocking: true,
      subjectExternalId: input.variantId,
    })]),
    providerFacts: Object.freeze({
      provider: 'shopify',
      shopDomain: 'commerce-staging-postgres.myshopify.com',
      sourceName: 'web',
      testOrder: true,
      shippingService: null,
    }),
    sourceHash: orderHash,
  })
}

class CommerceIntegrationRequestError extends Error {
  constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
    super(message)
    this.name = 'CommerceIntegrationRequestError'
    this.status = status
    this.code = code
  }
}

function loadCommerceStagingService(pool, counters) {
  const normalization = loadTypeScriptModule(
    'app_src/lib/operations/commerceNormalization.ts',
  )
  const packRuntime = loadTypeScriptModule(
    'app_src/lib/integrations/commercePackRuntime.ts',
  )
  const orderStaging = loadTypeScriptModule(
    'app_src/lib/integrations/commerceOrderStaging.ts',
  )
  const mustNotRun = (name) => () => {
    throw new Error(`${name} must not run during order-only staging acceptance`)
  }
  return loadTypeScriptModule(
    'app_src/lib/persistence/commerceIntake.ts',
    {
      '@/lib/auditWriter': {
        async recordAuditEvent() {
          counters.auditEvents += 1
        },
      },
      '@/lib/integrations/commerceCredentialCrypto': {
        decryptCommerceIntakeReadResult: mustNotRun(
          'decryptCommerceIntakeReadResult',
        ),
        decryptCommerceIntakeContinuation() {
          return { orderCursor: 'commerce-staging-recovery-cursor' }
        },
        decryptCommerceCandidateSnapshot: mustNotRun(
          'decryptCommerceCandidateSnapshot',
        ),
        encryptCommerceCandidateSnapshot: mustNotRun(
          'encryptCommerceCandidateSnapshot',
        ),
        encryptCommerceIntakeReadResult: mustNotRun(
          'encryptCommerceIntakeReadResult',
        ),
        encryptCommerceIntakeContinuation: mustNotRun(
          'encryptCommerceIntakeContinuation',
        ),
        shopifyCheckoutDestinationFingerprint: mustNotRun(
          'shopifyCheckoutDestinationFingerprint',
        ),
      },
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError,
      },
      '@/lib/integrations/commerceProductMappingPolicy': {
        exactProductMappingMutation: mustNotRun('exactProductMappingMutation'),
      },
      '@/lib/integrations/commerceProductNaming': {
        commerceProductDisplayName({ productTitle, variantTitle }) {
          return [productTitle, variantTitle].filter(Boolean).join(' · ')
        },
      },
      '@/lib/integrations/commerceProductLifecycle': {
        normalizeCommerceProductChannelStatus: mustNotRun(
          'normalizeCommerceProductChannelStatus',
        ),
      },
      '@/lib/integrations/commerceCanonicalProductIdentity': {
        selectCanonicalCommerceProductIdentity: mustNotRun(
          'selectCanonicalCommerceProductIdentity',
        ),
      },
      '@/lib/integrations/commerceProductChannelOffers': {
        selectCommerceProductChannelOffers: mustNotRun(
          'selectCommerceProductChannelOffers',
        ),
      },
      '@/lib/integrations/commercePackRuntime': packRuntime,
      '@/lib/integrations/commerceOrderStaging': orderStaging,
      '@/lib/persistence/commerceIntegrations': {},
      '@/lib/operations/commerceNormalization': normalization,
      '@/lib/persistence/crm': {
        stageCrmRecordWithClient: mustNotRun('stageCrmRecordWithClient'),
      },
      '@/lib/persistence/postgres': {
        acquireTransactionAdvisoryLock: (client, key) => client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [key],
        ),
        async withTransaction(operation) {
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            const result = await operation(client)
            await client.query('COMMIT')
            return result
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {})
            throw error
          } finally {
            client.release()
          }
        },
      },
      '@/lib/persistence/commerceCatalogSync': {
        applyCommerceCatalogSyncPolicyWithClient: mustNotRun(
          'applyCommerceCatalogSyncPolicyWithClient',
        ),
        commerceCatalogCredentialSupportsProducts: mustNotRun(
          'commerceCatalogCredentialSupportsProducts',
        ),
        readCommerceCatalogSyncStateWithClient: mustNotRun(
          'readCommerceCatalogSyncStateWithClient',
        ),
      },
      '@/lib/persistence/productChannelStates': {
        linkProductChannelStateWithClient: mustNotRun(
          'linkProductChannelStateWithClient',
        ),
        upsertProductChannelStateWithClient: mustNotRun(
          'upsertProductChannelStateWithClient',
        ),
      },
      '@/lib/persistence/shopifyCheckoutRating': {
        reconcileShopifyCheckoutRateForOrderCandidateWithClient: mustNotRun(
          'reconcileShopifyCheckoutRateForOrderCandidateWithClient',
        ),
        shopifyCheckoutRateLineageIsRequired: () => false,
        shopifyCheckoutRateOutcomeAllowsFulfillment: () => false,
      },
    },
    {
      fetch() {
        counters.fetchCalls += 1
        throw new Error('Commerce staging must not call a provider')
      },
    },
  )
}

function loadCommerceOrderReconciliationPersistence(pool) {
  return loadTypeScriptModule(
    'app_src/lib/persistence/commerceOrderReconciliation.ts',
    {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async withTransaction(operation) {
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            const result = await operation(client)
            await client.query('COMMIT')
            return result
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {})
            throw error
          } finally {
            client.release()
          }
        },
      },
    },
  )
}

async function seedCapturedRead(client, ids, envelope) {
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [actorEmail],
    )
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, reference_code
       ) VALUES ($1, 'Commerce staging PostgreSQL', 'member', 'ga0009201')`,
      [ids.organization],
    )
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, is_default, workspace_organization_id
       ) VALUES ($1, 'Commerce staging PostgreSQL', $2, true, $3)`,
      [ids.pipeline, actorEmail, ids.organization],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision
       ) VALUES ($1, $2, 'shadow', 1)`,
      [ids.organization, ids.pipeline],
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation,
         created_by, updated_by
       ) VALUES (
         $1, 'gia0009201', $2, 'shopify', 'commerce', 'production',
         'Commerce staging PostgreSQL', 'active', '{}'::jsonb,
         'gid://shopify/Shop/9201', 1, $3, $3
       )`,
      [ids.integrationAccount, ids.organization, actorEmail],
    )
    await client.query(
      `INSERT INTO crm_products (
         id, pipeline_id, source_key, reference_code, name, sku,
         status, price, cost, currency, source_hash, sync_status,
         created_by, updated_by
       ) VALUES (
         $1, $2, 'commerce-staging-postgres', 'gp0009201',
         'Commerce staging mapped product', 'POSTGRES-MAPPED',
         'Active', 0, 0, 'USD', $3, 'synced', $4, $4
       )`,
      [ids.product, ids.pipeline, hash('mapped-product'), actorEmail],
    )
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, source_key, identity_key, name, relationship_type,
         source_payload, source_hash, sync_status, created_by, updated_by
       ) VALUES (
         $1, $2, 'commerce-promotion-postgres-customer',
         'customer:commerce-promotion-postgres-customer',
         'Commerce promotion PostgreSQL customer', 'customer',
         '{}'::jsonb, $3, 'synced', $4, $4
       )`,
      [ids.customer, ids.pipeline, hash('promotion-customer'), actorEmail],
    )
    await client.query(
      `INSERT INTO operations_product_mappings (
         id, global_id, organization_id, integration_account_id,
         pipeline_id, product_id, channel_sku, external_product_id,
         external_variant_id, mapping_method, mapping_source_revision,
         active, created_by
       ) VALUES (
         $1, 'gpm0009201', $2, $3, $4, $5, 'POSTGRES-MAPPED',
         'gid://shopify/Product/mapped-zero', $6, 'exact_variant',
         $7, true, $8
       )`,
      [
        ids.productMapping,
        ids.organization,
        ids.integrationAccount,
        ids.pipeline,
        ids.product,
        ids.mappedVariant,
        hash('mapped-source-revision'),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_provider_attempts (
         id, global_id, organization_id, integration_account_id,
         action, adapter_version, idempotency_key, request_hash,
         redacted_request, redacted_response, state, completed_at, created_by
       ) VALUES (
         $1, 'gxa0009201', $2, $3, 'commerce.intake.read',
         'commerce-staging-postgres-v1', $4, $5, '{}'::jsonb, '{}'::jsonb,
         'succeeded', now(), $6
       )`,
      [
        ids.providerAttempt,
        ids.organization,
        ids.integrationAccount,
        ids.idempotencyKey,
        hash('provider-read-request'),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_intake_read_intents (
         id, organization_id, integration_account_id, pipeline_id,
         provider, resource, intake_action, idempotency_key, request_hash,
         credential_version, target_kind, session_id, batch_number,
         window_start, window_end, query_hash, intent_state,
         provider_attempt_id, response_ciphertext, response_iv, response_tag,
         response_hash, response_bytes, response_encryption_version,
         created_by, updated_by, expires_at
       ) VALUES (
         $1, $2, $3, $4, 'shopify', 'orders', 'fetch', $5, $6,
         1, 'none', $7, 1, NULL, $8::timestamptz, $9, 'captured',
         $10, $11, $12, $13, $14, 2, 1, $15, $15, $16::timestamptz
       )`,
      [
        ids.readIntent,
        ids.organization,
        ids.integrationAccount,
        ids.pipeline,
        ids.idempotencyKey,
        hash('read-intent-request'),
        ids.session,
        observedAt,
        ids.queryHash,
        ids.providerAttempt,
        Buffer.from('[]'),
        Buffer.alloc(12, 1),
        Buffer.alloc(16, 2),
        ids.responseHash,
        actorEmail,
        retentionExpiresAt,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
  assert.equal(envelope.orders.length, 6)
}

async function verifyPromotionNumericScaleAcceptance(
  pool,
  ids,
  persistence,
  counters,
) {
  const runtime = {
    organizationId: ids.organization,
    integrationAccountId: ids.integrationAccount,
    globalId: 'gia0009201',
    provider: 'shopify',
    credentialVersion: 1,
    externalAccountId: 'gid://shopify/Shop/9201',
  }
  const providerAttemptsBefore = Number((await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_provider_attempts
     WHERE organization_id = $1`,
    [ids.organization],
  )).rows[0].count)

  const setup = await pool.connect()
  let exact
  let fractional
  try {
    await setup.query('SET session_replication_role = replica')
    const candidates = await setup.query(
      `UPDATE operations_commerce_order_candidates candidate
       SET customer_resolution_state = 'resolved',
           customer_match_method = 'manual',
           customer_id = $2,
           delivery_resolution_state = 'not_required',
           workflow_state = 'ready',
           blocking_codes = '{}'::text[],
           row_version = row_version + 1,
           updated_by = $3,
           updated_at = now()
       WHERE candidate.organization_id = $1
         AND candidate.external_order_id IN (
           'gid://shopify/Order/mapped-zero',
           'gid://shopify/Order/mapped-fractional'
         )
       RETURNING candidate.id::text, candidate.external_order_id,
                 candidate.global_id,
                 candidate.row_version::text`,
      [ids.organization, ids.customer, actorEmail],
    )
    assert.equal(candidates.rowCount, 2)
    exact = candidates.rows.find((row) => (
      row.external_order_id === 'gid://shopify/Order/mapped-zero'
    ))
    fractional = candidates.rows.find((row) => (
      row.external_order_id === 'gid://shopify/Order/mapped-fractional'
    ))
    assert.ok(exact)
    assert.ok(fractional)
    const lines = await setup.query(
      `UPDATE operations_commerce_order_candidate_lines line
       SET workflow_state = 'ready',
           blocking_codes = '{}'::text[],
           row_version = line.row_version + 1,
           updated_by = $3,
           updated_at = now()
       FROM operations_commerce_order_candidates candidate
       WHERE line.organization_id = $1
         AND candidate.organization_id = line.organization_id
         AND candidate.id = line.order_candidate_id
         AND candidate.id = ANY($2::uuid[])
       RETURNING line.id::text`,
      [ids.organization, [exact.id, fractional.id], actorEmail],
    )
    assert.equal(lines.rowCount, 2)
  } finally {
    await setup.query('SET session_replication_role = origin').catch(() => {})
    setup.release()
  }

  const promotion = await persistence.promoteCommerceCandidateInPostgres({
    runtime,
    actorEmail,
    idempotencyKey: 'commerce-promotion-scaled-whole-zero-price',
    candidateGlobalId: exact.global_id,
    candidateRowVersion: Number(exact.row_version),
    requestHash: hash('commerce-promotion-scaled-whole-zero-price'),
  })
  assert.equal(promotion.replayed, false)
  assert.equal(promotion.providerWrites, 0)
  assert.equal(promotion.inventoryWrites, 0)
  assert.equal(promotion.reservationWrites, 0)
  assert.equal(promotion.fulfillmentWrites, 0)
  assert.equal(promotion.shipmentWrites, 0)
  assert.match(promotion.canonicalOrderGlobalId, /^gor[0-9]{7}$/)
  assert.equal(promotion.canonicalLineGlobalIds.length, 1)

  const exactEvidence = await pool.query(
    `SELECT
       canonical.global_id,
       canonical.merchandise_total_minor::text,
       canonical.source_payload #>> '{monetaryReconciliation,canonicalMerchandiseTotalMinor}'
         AS reconciled_merchandise_total_minor,
       canonical.source_payload ->> 'providerWrites' AS provider_writes,
       line.quantity::text,
       line.unit_price_minor::text,
       candidate.workflow_state AS candidate_state,
       candidate_line.workflow_state AS line_state,
       event.payload ->> 'providerWrites' AS event_provider_writes
     FROM operations_orders canonical
     JOIN operations_order_lines line
       ON line.organization_id = canonical.organization_id
      AND line.order_id = canonical.id
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = canonical.organization_id
      AND candidate.canonical_order_id = canonical.id
     JOIN operations_commerce_order_candidate_lines candidate_line
       ON candidate_line.organization_id = candidate.organization_id
      AND candidate_line.order_candidate_id = candidate.id
      AND candidate_line.canonical_order_line_id = line.id
     JOIN operations_domain_events event
       ON event.organization_id = canonical.organization_id
      AND event.aggregate_id = canonical.id
      AND event.event_type = 'operations.order.imported'
     WHERE canonical.organization_id = $1
       AND canonical.external_order_id =
           'gid://shopify/Order/mapped-zero'`,
    [ids.organization],
  )
  assert.equal(exactEvidence.rowCount, 1)
  assert.deepEqual(exactEvidence.rows[0], {
    global_id: promotion.canonicalOrderGlobalId,
    merchandise_total_minor: '0',
    reconciled_merchandise_total_minor: '0',
    provider_writes: '0',
    quantity: '50.000000',
    unit_price_minor: '0',
    candidate_state: 'promoted',
    line_state: 'promoted',
    event_provider_writes: '0',
  })

  await assert.rejects(
    persistence.promoteCommerceCandidateInPostgres({
      runtime,
      actorEmail,
      idempotencyKey: 'commerce-promotion-fractional-zero-price',
      candidateGlobalId: fractional.global_id,
      candidateRowVersion: Number(fractional.row_version),
      requestHash: hash('commerce-promotion-fractional-zero-price'),
    }),
    (error) => (
      error.code === 'COMMERCE_INTAKE_MONEY_RECONCILIATION_REQUIRED'
    ),
  )
  const fractionalEvidence = await pool.query(
    `SELECT
       candidate.workflow_state,
       candidate.canonical_order_id::text,
       line.workflow_state AS line_state,
       line.canonical_order_line_id::text,
       (SELECT count(*)::integer
        FROM operations_orders canonical
        WHERE canonical.organization_id = candidate.organization_id
          AND canonical.external_order_id = candidate.external_order_id)
         AS canonical_order_count,
       (SELECT count(*)::integer
        FROM operations_command_receipts receipt
        WHERE receipt.organization_id = candidate.organization_id
          AND receipt.idempotency_key =
              'commerce-promotion-fractional-zero-price') AS receipt_count
     FROM operations_commerce_order_candidates candidate
     JOIN operations_commerce_order_candidate_lines line
       ON line.organization_id = candidate.organization_id
      AND line.order_candidate_id = candidate.id
     WHERE candidate.organization_id = $1
       AND candidate.external_order_id =
           'gid://shopify/Order/mapped-fractional'`,
    [ids.organization],
  )
  assert.deepEqual(fractionalEvidence.rows[0], {
    workflow_state: 'ready',
    canonical_order_id: null,
    line_state: 'ready',
    canonical_order_line_id: null,
    canonical_order_count: 0,
    receipt_count: 0,
  })

  const providerAttemptsAfter = Number((await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_provider_attempts
     WHERE organization_id = $1`,
    [ids.organization],
  )).rows[0].count)
  assert.equal(providerAttemptsAfter, providerAttemptsBefore)
  assert.equal(counters.fetchCalls, 0)
}

async function verifyAcceptance(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'clawpilot-commerce-intake-staging-acceptance',
    max: 3,
  })
  const ids = {
    organization: randomUUID(),
    pipeline: randomUUID(),
    integrationAccount: randomUUID(),
    customer: randomUUID(),
    product: randomUUID(),
    productMapping: randomUUID(),
    providerAttempt: randomUUID(),
    readIntent: randomUUID(),
    session: randomUUID(),
    idempotencyKey: 'commerce-staging-postgres-fetch-1',
    queryHash: hash('commerce-staging-query'),
    responseHash: hash('commerce-staging-response'),
    mappedVariant: 'gid://shopify/ProductVariant/mapped-zero',
  }
  const envelope = Object.freeze({
    schemaVersion: 'commerce-normalization-envelope-v1',
    normalizerVersion: 'commerce-staging-postgres-v1',
    provider: 'shopify',
    organizationId: ids.organization,
    integrationAccountId: ids.integrationAccount,
    externalAccountId: 'gid://shopify/Shop/9201',
    apiVersion: '2026-07',
    observedAt,
    credentialGeneration: 1,
    retentionExpiresAt,
    sourceHash: hash('commerce-staging-envelope'),
    products: Object.freeze([]),
    orders: Object.freeze([
      orderFixture({
        key: 'mapped-zero',
        variantId: ids.mappedVariant,
        unitPrice: money(0, 'USD'),
        orderedQuantity: 50,
        unfulfilledQuantity: 50,
      }),
      orderFixture({
        key: 'mapped-fractional',
        variantId: ids.mappedVariant,
        unitPrice: money(0, 'USD'),
        orderedQuantity: 1.5,
        unfulfilledQuantity: 1.5,
      }),
      orderFixture({
        key: 'missing-positive',
        variantId: 'gid://shopify/ProductVariant/missing-positive',
        unitPrice: unavailable(),
        lineSubtotal: money(900, 'USD'),
        lineDiscount: money(0, 'USD'),
        lineTax: money(0, 'USD'),
        unfulfilledQuantity: 1,
      }),
      orderFixture({
        key: 'mismatch-positive',
        variantId: 'gid://shopify/ProductVariant/mismatch-positive',
        unitPrice: money(500, 'CAD'),
        unfulfilledQuantity: 1,
      }),
      orderFixture({
        key: 'negative-positive',
        variantId: 'gid://shopify/ProductVariant/negative-positive',
        unitPrice: money(-1, 'USD'),
        unfulfilledQuantity: 1,
      }),
      orderFixture({
        key: 'fulfilled-missing',
        variantId: 'gid://shopify/ProductVariant/fulfilled-missing',
        unitPrice: unavailable(),
        unfulfilledQuantity: 0,
      }),
    ]),
    rejections: Object.freeze([]),
  })
  const client = await pool.connect()
  try {
    await seedCapturedRead(client, ids, envelope)
  } finally {
    client.release()
  }

  const counters = { auditEvents: 0, fetchCalls: 0 }
  const persistence = loadCommerceStagingService(pool, counters)
  const result = await persistence.stageCommerceNormalizationEnvelopeInPostgres({
    runtime: {
      organizationId: ids.organization,
      globalId: 'gia0009201',
      provider: 'shopify',
      credentialVersion: 1,
    },
    actorEmail,
    idempotencyKey: ids.idempotencyKey,
    envelope,
    stageAction: 'fetch',
    page: {
      mode: 'operational',
      resource: 'orders',
      sessionId: ids.session,
      batchNumber: 1,
      previousRunGlobalId: null,
      windowStart: null,
      windowEnd: observedAt,
      queryHash: ids.queryHash,
      nextOrderCursor: null,
      providerRowsSeen: 6,
      eligibleOrdersSeen: 6,
    },
    refreshCandidateGlobalId: null,
    retryRejectionGlobalId: null,
    readIntentId: ids.readIntent,
    capturedResponseHash: ids.responseHash,
  })
  assert.equal(result.replayed, false)
  assert.equal(result.ordersStaged, 6)
  assert.equal(result.recordsStaged, 6)
  assert.equal(result.providerWrites, 0)
  assert.equal(result.syncCursorAdvanced, false)
  assert.equal(counters.fetchCalls, 0)
  assert.equal(counters.auditEvents, 1)

  const evidence = await pool.query(
    `SELECT
       candidate.external_order_id,
       candidate.blocking_codes AS candidate_blocking_codes,
       line.mapping_state,
       line.unfulfilled_quantity::text,
       line.currency_code,
       line.unit_price_minor::text,
       line.subtotal_minor::text,
       line.discount_minor::text,
       line.tax_minor::text,
       line.price_resolution_state,
       line.resolved_currency_code,
       line.resolved_unit_price_minor::text,
       line.blocking_codes AS line_blocking_codes
     FROM operations_commerce_order_candidates candidate
     JOIN operations_commerce_order_candidate_lines line
       ON line.organization_id = candidate.organization_id
      AND line.integration_account_id = candidate.integration_account_id
      AND line.pipeline_id = candidate.pipeline_id
      AND line.order_candidate_id = candidate.id
     WHERE candidate.organization_id = $1
     ORDER BY candidate.order_number_snapshot`,
    [ids.organization],
  )
  assert.equal(evidence.rowCount, 6)
  const byOrder = new Map(evidence.rows.map((row) => [
    row.external_order_id.split('/').at(-1),
    row,
  ]))

  const exact = byOrder.get('mapped-zero')
  assert.equal(exact.mapping_state, 'resolved')
  assert.equal(exact.currency_code, 'USD')
  assert.equal(exact.unit_price_minor, '0')
  assert.equal(exact.price_resolution_state, 'provider')
  assert.equal(exact.resolved_currency_code, 'USD')
  assert.equal(exact.resolved_unit_price_minor, '0')
  assert.equal(exact.unfulfilled_quantity, '50.000000')
  assert.ok(!exact.line_blocking_codes.includes('line_price_required'))
  assert.ok(!exact.candidate_blocking_codes.includes('line_price_required'))
  assert.ok(!exact.line_blocking_codes.includes('product_mapping_required'))
  assert.ok(!exact.candidate_blocking_codes.includes('product_mapping_required'))

  const fractional = byOrder.get('mapped-fractional')
  assert.equal(fractional.mapping_state, 'resolved')
  assert.equal(fractional.price_resolution_state, 'provider')
  assert.equal(fractional.resolved_currency_code, 'USD')
  assert.equal(fractional.resolved_unit_price_minor, '0')
  assert.equal(fractional.unfulfilled_quantity, '1.500000')

  for (const key of [
    'missing-positive',
    'mismatch-positive',
    'negative-positive',
  ]) {
    const unresolved = byOrder.get(key)
    assert.equal(unresolved.mapping_state, 'unresolved')
    assert.equal(unresolved.price_resolution_state, 'unresolved')
    assert.equal(unresolved.resolved_currency_code, null)
    assert.equal(unresolved.resolved_unit_price_minor, null)
    assert.ok(unresolved.line_blocking_codes.includes('line_price_required'))
    assert.ok(
      unresolved.candidate_blocking_codes.includes('line_price_required'),
    )
    assert.ok(
      unresolved.line_blocking_codes.includes('product_mapping_required'),
    )
    assert.ok(
      unresolved.candidate_blocking_codes.includes(
        'product_mapping_required',
      ),
    )
  }
  assert.equal(byOrder.get('missing-positive').currency_code, 'USD')
  assert.equal(byOrder.get('missing-positive').unit_price_minor, null)
  assert.equal(byOrder.get('missing-positive').subtotal_minor, '900')
  assert.equal(byOrder.get('missing-positive').discount_minor, '0')
  assert.equal(byOrder.get('missing-positive').tax_minor, '0')
  assert.equal(byOrder.get('mismatch-positive').currency_code, 'CAD')
  assert.equal(byOrder.get('mismatch-positive').unit_price_minor, '500')
  assert.equal(byOrder.get('negative-positive').currency_code, 'USD')
  assert.equal(byOrder.get('negative-positive').unit_price_minor, null)
  assert.equal(byOrder.get('negative-positive').subtotal_minor, null)
  assert.equal(byOrder.get('negative-positive').discount_minor, '0')
  assert.equal(byOrder.get('negative-positive').tax_minor, '0')

  const fulfilled = byOrder.get('fulfilled-missing')
  assert.equal(fulfilled.unfulfilled_quantity, '0.000000')
  assert.equal(fulfilled.price_resolution_state, 'unresolved')
  assert.ok(!fulfilled.line_blocking_codes.includes('line_price_required'))
  assert.ok(!fulfilled.candidate_blocking_codes.includes('line_price_required'))

  const zeroEffects = await pool.query(
    `SELECT
       run.provider_write_count,
       run.sync_cursor_advanced,
       run.inventory_write_count,
       run.fulfillment_write_count,
       run.shipment_write_count,
       run.commerce_export_write_count,
       (SELECT count(*)::integer
        FROM operations_commerce_provider_attempts attempt
        WHERE attempt.organization_id = run.organization_id) AS attempts,
       (SELECT count(*)::integer
        FROM operations_commerce_sync_cursors cursor
        WHERE cursor.organization_id = run.organization_id) AS cursors
     FROM operations_commerce_intake_runs run
     WHERE run.organization_id = $1`,
    [ids.organization],
  )
  assert.deepEqual(zeroEffects.rows[0], {
    provider_write_count: 0,
    sync_cursor_advanced: false,
    inventory_write_count: 0,
    fulfillment_write_count: 0,
    shipment_write_count: 0,
    commerce_export_write_count: 0,
    attempts: 1,
    cursors: 0,
  })
  const readEvidence = await pool.query(
    `SELECT attempt.state, intent.intent_state
     FROM operations_commerce_provider_attempts attempt
     JOIN operations_commerce_intake_read_intents intent
       ON intent.organization_id = attempt.organization_id
      AND intent.integration_account_id = attempt.integration_account_id
      AND intent.provider_attempt_id = attempt.id
     WHERE attempt.organization_id = $1`,
    [ids.organization],
  )
  assert.deepEqual(readEvidence.rows[0], {
    state: 'succeeded',
    intent_state: 'staged',
  })

  const recoveryKey = 'commerce-staging-postgres-recovery-key'
  const recoveryAttempt = randomUUID()
  const recoveryIntent = randomUUID()
  const continuationEvidence = await pool.query(
    `SELECT continuation.id::text, continuation.session_id::text,
            continuation.batch_number, continuation.query_hash,
            continuation.row_version::text, run.global_id,
            continuation.window_start, continuation.window_end
     FROM operations_commerce_intake_continuations continuation
     JOIN operations_commerce_intake_runs run
       ON run.organization_id = continuation.organization_id
      AND run.integration_account_id = continuation.integration_account_id
      AND run.id = continuation.run_id
     WHERE continuation.organization_id = $1
     LIMIT 1`,
    [ids.organization],
  )
  assert.equal(continuationEvidence.rowCount, 1)
  const continuation = continuationEvidence.rows[0]
  const cursorHash = hash(JSON.stringify({
    orderCursor: 'commerce-staging-recovery-cursor',
  }))
  const policyDriftRequest = (policyVersion) => commandHash({
    policyVersion,
    accountGlobalId: 'gia0009201',
    credentialVersion: 1,
    action: 'fetch-next',
    resource: 'orders',
    target: {
      kind: 'continuation',
      globalId: continuation.global_id,
      sourceHash: null,
      externalIdHash: null,
      continuationId: continuation.id,
      continuationCursorHash: cursorHash,
      continuationRowVersion: Number(continuation.row_version),
    },
    pageSize: 25,
    readOnly: true,
    providerWrites: 0,
    syncCursorAdvance: false,
  })
  const legacyRequestHash = policyDriftRequest(
    'commerce-intake-resolution-v1',
  )
  const currentRequestHash = policyDriftRequest(
    'commerce-intake-resolution-v2',
  )
  assert.notEqual(legacyRequestHash, currentRequestHash)
  const clientForRecovery = await pool.connect()
  try {
    await clientForRecovery.query('SET session_replication_role = replica')
    await clientForRecovery.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_build_object(
             'grantedScopes', jsonb_build_array('read_orders')
           )
       WHERE organization_id = $1 AND id = $2`,
      [ids.organization, ids.integrationAccount],
    )
    await clientForRecovery.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1, $2, 'gid://shopify/Shop/9201',
         'shopify_client_credentials', $3, $4, $5, 1, '9201',
         'verified', now(), 'unverified', $6, $6
       )`,
      [
        ids.organization,
        ids.integrationAccount,
        Buffer.from('encrypted'),
        Buffer.alloc(12, 3),
        Buffer.alloc(16, 4),
        actorEmail,
      ],
    )
    await clientForRecovery.query(
      `UPDATE operations_commerce_intake_runs
       SET created_by = 'system:commerce-order-reconciliation'
       WHERE organization_id = $1 AND global_id = $2`,
      [ids.organization, continuation.global_id],
    )
    await clientForRecovery.query(
      `UPDATE operations_commerce_intake_continuations
       SET cursor_state = 'available',
           cursor_ciphertext = $2,
           cursor_iv = $3,
           cursor_tag = $4,
           cursor_hash = $5,
           encryption_version = 1
       WHERE id = $1`,
      [
        continuation.id,
        Buffer.from('encrypted-cursor'),
        Buffer.alloc(12, 5),
        Buffer.alloc(16, 6),
        cursorHash,
      ],
    )
    await clientForRecovery.query(
      `INSERT INTO operations_commerce_provider_attempts (
         id, global_id, organization_id, integration_account_id,
         action, adapter_version, idempotency_key, request_hash,
         redacted_request, redacted_response, state, completed_at,
         created_by
       ) VALUES (
         $1, 'gxa0009202', $2, $3, 'commerce.intake.read',
         'commerce-staging-postgres-v1', $4, $5, '{}'::jsonb,
         '{}'::jsonb, 'succeeded', now(),
         $6
       )`,
      [
        recoveryAttempt,
        ids.organization,
        ids.integrationAccount,
        recoveryKey,
        legacyRequestHash,
        actorEmail,
      ],
    )
    await clientForRecovery.query(
      `INSERT INTO operations_commerce_intake_read_intents (
         id, organization_id, integration_account_id, pipeline_id,
         provider, resource, intake_action, idempotency_key, request_hash,
         credential_version, target_kind, target_global_id,
         continuation_id, continuation_cursor_hash,
         continuation_row_version, session_id, batch_number, window_start,
         window_end, query_hash, intent_state, provider_attempt_id,
         response_ciphertext, response_iv, response_tag, response_hash,
         response_bytes, response_encryption_version, created_by, updated_by,
         expires_at
       ) VALUES (
         $1, $2, $3, $4, 'shopify', 'orders', 'fetch-next', $5, $6,
         1, 'continuation', $7, $8, $9, $10, $11, $12,
         $13::timestamptz, $14::timestamptz, $15, 'captured', $16,
         $17, $18, $19, $20, 2, 1,
         $21, $21, $22::timestamptz
       )`,
      [
        recoveryIntent,
        ids.organization,
        ids.integrationAccount,
        ids.pipeline,
        recoveryKey,
        legacyRequestHash,
        continuation.global_id,
        continuation.id,
        cursorHash,
        continuation.row_version,
        continuation.session_id,
        continuation.batch_number + 1,
        continuation.window_start,
        continuation.window_end,
        continuation.query_hash,
        recoveryAttempt,
        Buffer.from('[]'),
        Buffer.alloc(12, 7),
        Buffer.alloc(16, 8),
        hash('commerce-staging-recovery-response'),
        actorEmail,
        retentionExpiresAt,
      ],
    )
  } finally {
    await clientForRecovery.query('SET session_replication_role = origin')
      .catch(() => {})
    clientForRecovery.release()
  }

  const recoveryPersistence = loadCommerceOrderReconciliationPersistence(pool)
  const recoveryTargets = await recoveryPersistence
    .claimCommerceOrderReconciliationTargetsInPostgres({ limit: 1 })
  assert.equal(recoveryTargets.length, 1)
  assert.equal(
    recoveryTargets[0].continuationRunGlobalId,
    continuation.global_id,
  )
  assert.equal(recoveryTargets[0].continuationIdempotencyKey, recoveryKey)

  const recoveryRuntime = {
    organizationId: ids.organization,
    globalId: 'gia0009201',
    provider: 'shopify',
    credentialVersion: 1,
    externalAccountId: 'gid://shopify/Shop/9201',
  }
  const mismatchClient = await pool.connect()
  try {
    await mismatchClient.query('SET session_replication_role = replica')
    await mismatchClient.query(
      `UPDATE operations_commerce_intake_read_intents
       SET target_global_id = 'gcir9999999'
       WHERE id = $1`,
      [recoveryIntent],
    )
  } finally {
    await mismatchClient.query('SET session_replication_role = origin')
      .catch(() => {})
    mismatchClient.release()
  }
  await assert.rejects(
    persistence.prepareCommerceIntakeReadIntentInPostgres({
      runtime: recoveryRuntime,
      actorEmail: 'system:commerce-order-reconciliation',
      idempotencyKey: recoveryKey,
      action: 'fetch-next',
      resource: 'orders',
      target: { kind: 'none' },
      continuationRunGlobalId: continuation.global_id,
      pageSize: 25,
    }),
    (error) => error.code === 'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
  )
  const restoredClient = await pool.connect()
  try {
    await restoredClient.query('SET session_replication_role = replica')
    await restoredClient.query(
      `UPDATE operations_commerce_intake_read_intents
       SET target_global_id = $2
       WHERE id = $1`,
      [recoveryIntent, continuation.global_id],
    )
  } finally {
    await restoredClient.query('SET session_replication_role = origin')
      .catch(() => {})
    restoredClient.release()
  }

  const preparedMismatchClient = await pool.connect()
  try {
    await preparedMismatchClient.query('SET session_replication_role = replica')
    await preparedMismatchClient.query(
      `UPDATE operations_commerce_intake_read_intents
       SET intent_state = 'prepared',
           provider_attempt_id = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           response_ciphertext = NULL,
           response_iv = NULL,
           response_tag = NULL,
           response_hash = NULL,
           response_bytes = NULL,
           response_encryption_version = NULL
       WHERE id = $1`,
      [recoveryIntent],
    )
  } finally {
    await preparedMismatchClient.query('SET session_replication_role = origin')
      .catch(() => {})
    preparedMismatchClient.release()
  }
  await assert.rejects(
    persistence.prepareCommerceIntakeReadIntentInPostgres({
      runtime: recoveryRuntime,
      actorEmail: 'system:commerce-order-reconciliation',
      idempotencyKey: recoveryKey,
      action: 'fetch-next',
      resource: 'orders',
      target: { kind: 'none' },
      continuationRunGlobalId: continuation.global_id,
      pageSize: 25,
    }),
    (error) => error.code === 'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
  )
  const capturedRestoreClient = await pool.connect()
  try {
    await capturedRestoreClient.query('SET session_replication_role = replica')
    await capturedRestoreClient.query(
      `UPDATE operations_commerce_intake_read_intents
       SET intent_state = 'captured',
           provider_attempt_id = $2::uuid,
           response_ciphertext = $3,
           response_iv = $4,
           response_tag = $5,
           response_hash = $6,
           response_bytes = 2,
           response_encryption_version = 1
       WHERE id = $1`,
      [
        recoveryIntent,
        recoveryAttempt,
        Buffer.from('[]'),
        Buffer.alloc(12, 7),
        Buffer.alloc(16, 8),
        hash('commerce-staging-recovery-response'),
      ],
    )
  } finally {
    await capturedRestoreClient.query('SET session_replication_role = origin')
      .catch(() => {})
    capturedRestoreClient.release()
  }
  const recoveredIntent =
    await persistence.prepareCommerceIntakeReadIntentInPostgres({
      runtime: recoveryRuntime,
      actorEmail: 'system:commerce-order-reconciliation',
      idempotencyKey: recoveryKey,
      action: 'fetch-next',
      resource: 'orders',
      target: { kind: 'none' },
      continuationRunGlobalId: continuation.global_id,
      pageSize: 25,
    })
  assert.equal(recoveredIntent.id, recoveryIntent)

  const activeLeaseToken = randomUUID()
  const activeLeaseClient = await pool.connect()
  try {
    await activeLeaseClient.query('SET session_replication_role = replica')
    await activeLeaseClient.query(
      `UPDATE operations_commerce_provider_attempts
       SET state = 'prepared',
           completed_at = NULL,
           lease_token = $2,
           lease_expires_at = now() + interval '10 minutes'
       WHERE id = $1`,
      [recoveryAttempt, activeLeaseToken],
    )
    await activeLeaseClient.query(
      `UPDATE operations_commerce_intake_read_intents
       SET intent_state = 'reading',
           lease_token = $2,
           lease_expires_at = now() + interval '10 minutes',
           response_ciphertext = NULL,
           response_iv = NULL,
           response_tag = NULL,
           response_hash = NULL,
           response_bytes = NULL,
           response_encryption_version = NULL
       WHERE id = $1`,
      [recoveryIntent, activeLeaseToken],
    )
  } finally {
    await activeLeaseClient.query('SET session_replication_role = origin')
      .catch(() => {})
    activeLeaseClient.release()
  }
  const recoveredReadingIntent =
    await persistence.prepareCommerceIntakeReadIntentInPostgres({
      runtime: recoveryRuntime,
      actorEmail: 'system:commerce-order-reconciliation',
      idempotencyKey: recoveryKey,
      action: 'fetch-next',
      resource: 'orders',
      target: { kind: 'none' },
      continuationRunGlobalId: continuation.global_id,
      pageSize: 25,
    })
  assert.equal(recoveredReadingIntent.id, recoveryIntent)
  await assert.rejects(
    persistence.reserveCommerceIntakeProviderReadInPostgres({
      runtime: recoveryRuntime,
      actorEmail: 'system:commerce-order-reconciliation',
      providerAttemptActorEmail: null,
      idempotencyKey: recoveryKey,
      readIntentId: recoveryIntent,
      adapterVersion: 'commerce-staging-postgres-v2',
      redactedRequest: {
        resource: 'orders',
        readOnly: true,
        providerWrites: 0,
      },
    }),
    (error) => error.code === 'COMMERCE_INTAKE_READ_IN_PROGRESS',
  )

  const expiredLeaseClient = await pool.connect()
  try {
    await expiredLeaseClient.query('SET session_replication_role = replica')
    await expiredLeaseClient.query(
      `UPDATE operations_commerce_provider_attempts
       SET lease_expires_at = now() - interval '1 minute'
       WHERE id = $1`,
      [recoveryAttempt],
    )
    await expiredLeaseClient.query(
      `UPDATE operations_commerce_intake_read_intents
       SET lease_expires_at = now() - interval '1 minute'
       WHERE id = $1`,
      [recoveryIntent],
    )
  } finally {
    await expiredLeaseClient.query('SET session_replication_role = origin')
      .catch(() => {})
    expiredLeaseClient.release()
  }
  const recoveredExpiredReadingIntent =
    await persistence.prepareCommerceIntakeReadIntentInPostgres({
      runtime: recoveryRuntime,
      actorEmail: 'system:commerce-order-reconciliation',
      idempotencyKey: recoveryKey,
      action: 'fetch-next',
      resource: 'orders',
      target: { kind: 'none' },
      continuationRunGlobalId: continuation.global_id,
      pageSize: 25,
    })
  assert.equal(recoveredExpiredReadingIntent.id, recoveryIntent)
  await assert.rejects(
    persistence.reserveCommerceIntakeProviderReadInPostgres({
      runtime: recoveryRuntime,
      actorEmail: 'system:commerce-order-reconciliation',
      providerAttemptActorEmail: null,
      idempotencyKey: recoveryKey,
      readIntentId: recoveryIntent,
      adapterVersion: 'commerce-staging-postgres-v2',
      redactedRequest: {
        resource: 'orders',
        readOnly: true,
        providerWrites: 0,
      },
    }),
    (error) => error.code === 'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
  )
  const recoveredState = await pool.query(
    `SELECT intent.intent_state, attempt.state AS attempt_state,
            saved.cursor_state
     FROM operations_commerce_intake_read_intents intent
     JOIN operations_commerce_provider_attempts attempt
       ON attempt.id = intent.provider_attempt_id
     JOIN operations_commerce_intake_continuations saved
       ON saved.id = intent.continuation_id
     WHERE intent.id = $1`,
    [recoveryIntent],
  )
  assert.deepEqual(recoveredState.rows[0], {
    intent_state: 'uncertain',
    attempt_state: 'unknown',
    cursor_state: 'invalid',
  })
  assert.equal(
    counters.fetchCalls,
    0,
    'Policy-drift recovery must not call the provider',
  )
  await verifyPromotionNumericScaleAcceptance(
    pool,
    ids,
    persistence,
    counters,
  )
  await pool.end()
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-commerce-staging-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_commerce_staging',
      '-e', 'POSTGRES_DB=clawpilot_commerce_staging',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:clawpilot_commerce_staging@127.0.0.1:'
      + `${port}/clawpilot_commerce_staging`
    )
    await waitForPostgres(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    await verifyAcceptance(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'Commerce intake staging, scaled-whole zero-price promotion, fractional '
      + 'rollback, and policy-drift recovery disposable-PostgreSQL '
      + 'acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
