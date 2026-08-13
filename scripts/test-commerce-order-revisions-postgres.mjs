#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
const root = process.cwd()
export const actorEmail = 'commerce-order-revision-postgres@clawpilot.com'

export function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

export async function waitForPostgres(databaseUrl) {
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

export function migrations() {
  return readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right))
}

export async function applyMigration(client, file) {
  const sql = readFileSync(resolve(root, 'db/migrations', file), 'utf8')
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query(
      'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text',
    )
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES ($1, $2)`,
      [file, createHash('sha256').update(sql).digest('hex')],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw new Error(`Migration ${file} failed`, { cause: error })
  }
}

export function postgresAdapter(pool) {
  return {
    query(text, values = []) {
      return pool.query(text, values)
    },
    async withTransaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const value = await fn(client)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async acquireTransactionAdvisoryLock(client, key) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      )
    },
  }
}

async function verifyProtectedSnapshotPurgeRolloutSkip(client) {
  const persistence = loadTypeScriptModule(
    'app_src/lib/persistence/commerceOrderRevisions.ts',
    {
      '@/lib/integrations/commerceReadRuntime': {
        commerceReadRuntimeAvailable: () => true,
        commerceReadAccountSql: () => "account.status <> 'error'",
      },
      '@/lib/persistence/postgres': {
        query(text, values = []) {
          return client.query(text, values)
        },
        async withTransaction(fn) {
          return fn(client)
        },
        async acquireTransactionAdvisoryLock() {},
      },
      '@/lib/auditWriter': { async recordAuditEvent() {} },
    },
  )
  const result = await persistence
    .purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres({
      limit: 50_000,
    })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    schemaAvailable: false,
    skipped: true,
    limit: 500,
    purged: 0,
    expiredProtectedReadBacklog: null,
    backlogTruncated: false,
  }, 'pre-0274 rollout must skip the protected snapshot purge safely')
}

export function loadTypeScriptModule(path, mocks = {}) {
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
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    RegExp,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      if (specifier === '@/lib/integrations/commerceOrderRevisionEvidence') {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceOrderRevisionEvidence.ts',
        )
      }
      if (specifier === '@/lib/integrations/commerceCredentialCrypto') {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceCredentialCrypto.ts',
        )
      }
      if (specifier === '@/lib/globalIds.mjs') {
        return {
          normalizeGlobalId(value, prefix) {
            const normalized = String(value || '').trim().toLowerCase()
            return new RegExp(
              `^${prefix}(?:[0-9]{7}|[0-9a-v]{12})$`,
              'u',
            ).test(normalized)
              ? normalized
              : null
          },
        }
      }
      if (specifier === '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs') {
        const encryptionKey = 'revision-postgres-encryption-key-material-0001'
        return {
          resolveCommerceOrderRevisionEvidenceKeyConfig() {
            return {
              activeKeyId: 'revision-test-k1',
              keyIds: ['revision-test-k1'],
              hasEncryptionKey: () => true,
              getFingerprintKeyMaterial: () => (
                'revision-postgres-fingerprint-key-material-0001'
              ),
              getEncryptionKeyMaterial: (keyId) => (
                keyId === 'revision-test-k1' ? encryptionKey : null
              ),
            }
          },
          summarizeCommerceOrderRevisionEvidenceKeyReadiness(
            _configuration,
            references,
          ) {
            return {
              status: 'ready',
              ready: true,
              activeKeyId: 'revision-test-k1',
              configuredKeyIds: ['revision-test-k1'],
              referencedKeyIds: references.referencedKeyIds || [],
              missingReferencedKeyIds: [],
              invalidReferencedKeyIdCount: 0,
              unpurgedProtectedReadCount:
                references.unpurgedProtectedReadCount || 0,
            }
          },
        }
      }
      if (specifier === '@/lib/persistence/config') {
        return { isHostedRuntime: () => false }
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

export function orderIds() {
  return {
    organization: randomUUID(),
    pipeline: randomUUID(),
    integration: randomUUID(),
    integrationFaire: randomUUID(),
    customer: randomUUID(),
    apply: randomUUID(),
    applyFaire: randomUUID(),
    current: randomUUID(),
    missing: randomUUID(),
    stale: randomUUID(),
    shipped: randomUUID(),
  }
}

export async function seedBeforeRevisionMigration(client, ids) {
  const hashes = {
    current: 'a'.repeat(64),
    missing: 'b'.repeat(64),
    stale: 'c'.repeat(64),
    shipped: 'd'.repeat(64),
  }
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
       ) VALUES ($1, 'Order revision acceptance', 'member', 'ga0009301')`,
      [ids.organization],
    )
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, is_default, workspace_organization_id
       ) VALUES ($1, 'Order revision acceptance', $2, true, $3)`,
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
         $1, 'gia0009301', $2, 'shopify', 'commerce', 'production',
         'Revision acceptance Shopify', 'active',
         '{"shopDomain":"revision-acceptance.myshopify.com"}'::jsonb,
         'gid://shopify/Shop/9301', 1, $3, $3
       )`,
      [ids.integration, ids.organization, actorEmail],
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1, $2, 'gid://shopify/Shop/9301', 'shopify_client_credentials',
         decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 1, '9301', 'verified', now(),
         'unverified', $3, $3
       )`,
      [ids.organization, ids.integration, actorEmail],
    )
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, source_key, identity_key, name, relationship_type,
         source_payload, source_hash, sync_status, created_by, updated_by
       ) VALUES (
         $1, $2, 'revision-customer', 'customer:revision-customer',
         'Revision customer', 'customer', '{}'::jsonb, $3, 'synced', $4, $4
       )`,
      [ids.customer, ids.pipeline, 'e'.repeat(64), actorEmail],
    )
    const orders = [
      [ids.current, 'gor0009301', '9301', 'imported', hashes.current],
      [ids.missing, 'gor0009302', '9302', 'imported', hashes.missing],
      [ids.stale, 'gor0009303', '9303', 'imported', hashes.stale],
      [ids.shipped, 'gor0009304', '9304', 'shipped', hashes.shipped],
    ]
    for (const [id, globalId, suffix, status, sourceHash] of orders) {
      await client.query(
        `INSERT INTO operations_orders (
           id, global_id, organization_id, pipeline_id, customer_id,
           integration_account_id, source_provider, external_order_id,
           order_number, status, currency, merchandise_total_minor,
           ship_to, source_payload, created_by, updated_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'shopify', $7, $8, $9,
           'USD', 1000, '{"country":"US"}'::jsonb,
           jsonb_build_object('sourceHash', $10::text), $11, $11
         )`,
        [
          id,
          globalId,
          ids.organization,
          ids.pipeline,
          ids.customer,
          ids.integration,
          `gid://shopify/Order/${suffix}`,
          `#${suffix}`,
          status,
          sourceHash,
          actorEmail,
        ],
      )
    }
  } finally {
    await client.query('SET session_replication_role = origin')
  }
  return hashes
}

export function snapshot(input) {
  return {
    version: 'shopify-canonical-order-revision-v1',
    provider: 'shopify',
    accountGlobalId: 'gia0009301',
    integrationAccountId: input.claim.integrationAccountId,
    externalAccountId: 'gid://shopify/Shop/9301',
    credentialVersion: input.claim.credentialVersion,
    canonicalOrderGlobalId: input.claim.canonicalOrderGlobalId,
    canonicalOrderRowVersion: input.claim.canonicalOrderRowVersion,
    observedAt: input.observedAt,
    order: {
      externalOrderId: input.claim.externalOrderId,
      orderNumber: `#${input.claim.externalOrderId.split('/').at(-1)}`,
      sourceHash: input.sourceHash,
      sourceRevision: input.sourceRevision,
      canonicalStates: {
        lifecycle: input.lifecycle || 'open',
        payment: 'paid',
        fulfillment: input.fulfillment || 'unfulfilled',
        returns: 'none',
      },
      currency: 'USD',
      partyFingerprint: 'f'.repeat(64),
      shipToFingerprint: '0'.repeat(64),
      lines: [],
    },
  }
}

export async function seedApplyRevisionAuthority(pool, ids, provider = 'shopify') {
  assert.ok(['shopify', 'faire'].includes(provider))
  const isFaire = provider === 'faire'
  const suffix = isFaire ? '9315' : '9305'
  const integrationAccountId = isFaire ? ids.integrationFaire : ids.integration
  const orderId = isFaire ? ids.applyFaire : ids.apply
  const externalAccountId = isFaire
    ? 'brand_revision_9315'
    : 'gid://shopify/Shop/9301'
  const externalOrderId = isFaire
    ? `bo_revision_${suffix}`
    : `gid://shopify/Order/${suffix}`
  const oldExternalLineId = isFaire
    ? `oi_revision_${suffix}_01`
    : `gid://shopify/LineItem/${suffix}01`
  const newExternalLineId = isFaire
    ? `oi_revision_${suffix}_02`
    : `gid://shopify/LineItem/${suffix}02`
  const externalProductId = isFaire
    ? `p_revision_${suffix}`
    : `gid://shopify/Product/${suffix}`
  const externalVariantId = isFaire
    ? `po_revision_${suffix}`
    : `gid://shopify/ProductVariant/${suffix}`
  const externalInventoryItemId = isFaire
    ? `faire_inventory_${suffix}`
    : `gid://shopify/InventoryItem/${suffix}`
  const customerExternalId = isFaire
    ? `retailer_revision_${suffix}`
    : `gid://shopify/Customer/${suffix}`
  const sku = `REV-${suffix}`
  const acceptedSourceHash = '1'.repeat(64)
  const productSourceHash = '2'.repeat(64)
  const candidateLineSourceHash = '3'.repeat(64)

  if (isFaire) {
    await pool.query(
      `INSERT INTO operations_integration_accounts (
         id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire', 'commerce', 'production',
         'Revision acceptance Faire', 'active',
         jsonb_build_object('brandId', $3::text), $3, 1, $4, $4
       )`,
      [integrationAccountId, ids.organization, externalAccountId, actorEmail],
    )
    await pool.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'faire_oauth',
         decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 1, '9315', 'verified', now(),
         'not_applicable', $4, $4
       )`,
      [ids.organization, integrationAccountId, externalAccountId, actorEmail],
    )
  }

  const customer = await pool.query(
    `SELECT id::text, reference_code
     FROM crm_organizations
     WHERE id = $1::uuid AND pipeline_id = $2::uuid`,
    [ids.customer, ids.pipeline],
  )
  assert.equal(customer.rowCount, 1)
  const product = (await pool.query(
    `INSERT INTO crm_products (
       pipeline_id, source_key, name, sku, product_type, price, cost,
       currency, source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'Revision ${provider} exact case pack', $3, 'Good',
       10.00, 4.00, 'USD', $4, $5, $5
     ) RETURNING id::text, reference_code`,
    [ids.pipeline, `revision-product-${suffix}`, sku, productSourceHash, actorEmail],
  )).rows[0]
  const productMapping = (await pool.query(
    `INSERT INTO operations_product_mappings (
       organization_id, integration_account_id, pipeline_id,
       product_id, channel_sku, external_product_id,
       external_variant_id, external_inventory_item_id,
       mapping_method, mapping_source_revision, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
       'exact_variant', 'revision-apply-fixture-v1', true, $9
     ) RETURNING id::text`,
    [
      ids.organization, integrationAccountId, ids.pipeline, product.id, sku,
      externalProductId, externalVariantId, externalInventoryItemId, actorEmail,
    ],
  )).rows[0]
  const channelState = (await pool.query(
    `INSERT INTO operations_product_channel_states (
       organization_id, integration_account_id, pipeline_id, provider,
       external_product_id, external_variant_id, external_inventory_item_id,
       product_id, product_mapping_id, provider_product_title,
       provider_variant_title, provider_sku, provider_status_raw,
       normalized_status, provider_active, requires_shipping, weight_grams,
       observed_at, source_revision, source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, '${provider}', $4, $5, $6,
       $7::uuid, $8::uuid, 'Revision ${provider} exact case pack', 'Case of six', $9,
       'PUBLISHED', 'active', true, true, 1200, now(),
       'revision-channel-v1', $10, $11, $11
     ) RETURNING id::text, pack_evidence_hash`,
    [
      ids.organization, integrationAccountId, ids.pipeline,
      externalProductId, externalVariantId, externalInventoryItemId,
      product.id, productMapping.id, sku, '4'.repeat(64), actorEmail,
    ],
  )).rows[0]
  const packProfile = (await pool.query(
    `INSERT INTO operations_product_pack_profiles (
       organization_id, pipeline_id, product_id, profile_key,
       profile_name, package_level, is_default, status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'revision-${provider}-case-six',
       'Revision ${provider} exact case of six', 'case', true, 'active', $4, $4
     ) RETURNING id::text`,
    [ids.organization, ids.pipeline, product.id, actorEmail],
  )).rows[0]
  const packVersion = (await pool.query(
    `INSERT INTO operations_product_pack_profile_versions (
       organization_id, pipeline_id, product_id, profile_id,
       version_number, lifecycle_state, base_each_quantity,
       unit_of_measure, length_mm, width_mm, height_mm, dimension_basis,
       gross_weight_grams, weight_basis, fit_model, ships_as_own_package,
       assembly_policy, evidence_type, source, is_current,
       evidence_reference, confirmed_at, confirmed_by, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       1, 'active', 6, 'case', 300, 220, 180, 'outer',
       1200, 'customer_stated', 'rigid_3d', false, 'never',
       'customer_confirmed', 'manual', true,
       'Revision ${provider} Apply exact case evidence', now(), $5, $5
     ) RETURNING id::text, global_id, row_version::text`,
    [ids.organization, ids.pipeline, product.id, packProfile.id, actorEmail],
  )).rows[0]
  const packMapping = (await pool.query(
    `INSERT INTO operations_commerce_variant_pack_mappings (
       organization_id, integration_account_id, pipeline_id, product_id,
       provider, external_product_id, external_variant_id,
       default_pack_profile_version_id, provider_lifecycle_state,
       projection_state, mapping_purpose, source_revision, source_hash,
       pack_evidence_hash, observed_at, is_current, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       '${provider}', $5, $6, $7::uuid, 'active',
       'current', 'catalog', 'revision-pack-v1', $8, $9,
       now(), true, $10, $10
     ) RETURNING id::text, global_id, row_version::text`,
    [
      ids.organization, integrationAccountId, ids.pipeline, product.id,
      externalProductId, externalVariantId, packVersion.id,
      '5'.repeat(64), channelState.pack_evidence_hash, actorEmail,
    ],
  )).rows[0]

  const order = (await pool.query(
    `INSERT INTO operations_orders (
       id, organization_id, pipeline_id, customer_id,
       integration_account_id, source_provider, external_order_id,
       order_number, status, currency, merchandise_total_minor,
       requested_delivery_at, ship_to, source_payload, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, '${provider}', $6, $7, 'imported', 'USD', 2000,
       NULL, $8::jsonb, $9::jsonb, $10, $10
     ) RETURNING id::text, global_id, row_version::text`,
    [
      orderId, ids.organization, ids.pipeline, ids.customer, integrationAccountId,
      externalOrderId, `#${suffix}`,
      JSON.stringify({
        name: 'Revision recipient', line1: '35 Saxony Drive',
        city: 'Trumbull', region: 'CT', postalCode: '06611', country: 'US',
      }),
      JSON.stringify({ sourceHash: acceptedSourceHash }),
      actorEmail,
    ],
  )).rows[0]
  const orderLine = (await pool.query(
    `INSERT INTO operations_order_lines (
       organization_id, order_id, pipeline_id, product_id,
       external_line_id, channel_sku, description, quantity,
       unit_price_minor, weight_grams, dimensions_mm
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5, $6, 'Revision ${provider} exact case pack - original line', 2,
       1000, 1200, '{"length":300,"width":220,"height":180}'::jsonb
     ) RETURNING id::text, global_id`,
    [
      ids.organization, order.id, ids.pipeline, product.id,
      oldExternalLineId, sku,
    ],
  )).rows[0]
  const promotionReceipt = (await pool.query(
    `INSERT INTO operations_command_receipts (
       organization_id, command_type, idempotency_key, request_hash,
       actor_email, status, correlation_id, result_global_id,
       result_payload, completed_at
     ) VALUES (
       $1::uuid, 'promote_commerce_order', $2, $3,
       $4, 'succeeded', $5::uuid, $6,
       $7::jsonb, now()
     ) RETURNING id::text`,
    [
      ids.organization, `promote-revision-apply-${suffix}`, '6'.repeat(64),
      actorEmail, randomUUID(), order.global_id,
      JSON.stringify({ orderGlobalId: order.global_id, orderStatus: 'imported' }),
    ],
  )).rows[0]
  const intakeRun = (await pool.query(
    `INSERT INTO operations_commerce_intake_runs (
       organization_id, integration_account_id, pipeline_id,
       provider, resource, credential_version, provider_api_version,
       normalizer_version, idempotency_key, request_hash, window_end,
       workflow_state, records_seen, records_staged, records_promoted,
       canonical_orders_created, completed_at, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       '${provider}', 'orders', 1, '2026-07', 'revision-apply-fixture-v1',
       'intake-revision-apply-9305', $4, now(),
       'promoted', 1, 1, 1, 1, now(), $5, $5
     ) RETURNING id::text`,
    [ids.organization, integrationAccountId, ids.pipeline, '7'.repeat(64), actorEmail],
  )).rows[0]
  const candidate = (await pool.query(
    `INSERT INTO operations_commerce_order_candidates (
       organization_id, integration_account_id, pipeline_id, run_id,
       provider, external_order_id, order_number_snapshot, source_channel,
       provider_order_status_raw, provider_financial_status_raw,
       provider_fulfillment_status_raw, provider_return_status_raw,
       normalized_order_status, normalized_payment_status,
       normalized_fulfillment_status, normalized_return_status,
       test_order, requires_shipping, currency_code, subtotal_minor,
       discount_minor, brand_discount_minor, shipping_minor, tax_minor,
       other_adjustment_minor, total_minor, party_kind,
       party_snapshot_state, customer_resolution_state,
       customer_match_method, customer_id, ship_to_snapshot_state,
       ship_to_snapshot_source, ship_to_snapshot_ciphertext,
       ship_to_snapshot_iv, ship_to_snapshot_tag, ship_to_snapshot_hash,
       ship_to_snapshot_encryption_version, delivery_resolution_state,
       requested_delivery_at, observed_at, source_revision, source_hash,
       provider_api_version, normalizer_version, workflow_state,
       blocking_codes, canonical_order_id, promotion_command_receipt_id,
       promotion_idempotency_key, promotion_request_hash, promoted_at,
       row_version, created_by, updated_by, expires_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       '${provider}', $5, $6, 'online_store',
       'open', 'paid', 'unfulfilled', 'none',
       'open', 'paid', 'unfulfilled', 'none',
       false, true, 'USD', 2000,
       0, 0, 500, 0, 0, 2500, 'consumer',
       'missing', 'resolved', 'exact_external_id', $7::uuid, 'confirmed',
       'manual', $8, $9, $10, $11,
       1, 'manual', now() + interval '7 days', now(), 'revision-intake-v1', $12,
       '2026-07', 'revision-apply-fixture-v1', 'promoted',
       '{}'::text[], $13::uuid, $14::uuid,
       $15, $16, now(),
       1, $17, $17, now() + interval '7 days'
     ) RETURNING id::text, global_id, row_version::text`,
    [
      ids.organization, integrationAccountId, ids.pipeline, intakeRun.id,
      externalOrderId, `#${suffix}`, ids.customer,
      Buffer.from('revision apply confirmed ship-to'), Buffer.alloc(12, 1),
      Buffer.alloc(16, 2), '8'.repeat(64), acceptedSourceHash, order.id,
      promotionReceipt.id, `promote-revision-apply-${suffix}`,
      '9'.repeat(64), actorEmail,
    ],
  )).rows[0]
  const candidateLine = (await pool.query(
    `INSERT INTO operations_commerce_order_candidate_lines (
       organization_id, integration_account_id, pipeline_id, run_id,
       order_candidate_id, provider, external_line_id,
       external_product_id, external_variant_id, external_inventory_item_id,
       sku_snapshot, product_title_snapshot, provider_status_raw,
       normalized_status, ordered_quantity, current_quantity,
       unfulfilled_quantity, physical_quantity, currency_code,
       unit_price_minor, subtotal_minor, discount_minor,
       brand_discount_minor, tax_minor, other_adjustment_minor, total_minor,
       price_resolution_state, resolved_currency_code,
       resolved_unit_price_minor, resolved_subtotal_minor,
       resolved_discount_minor, resolved_brand_discount_minor,
       resolved_tax_minor, resolved_other_adjustment_minor,
       resolved_total_minor, taxable, requires_shipping, mapping_state,
       product_id, product_mapping_id, packaging_state, packaging_source,
       commerce_variant_pack_mapping_id,
       commerce_variant_pack_mapping_row_version,
       pack_profile_version_id, pack_profile_version_row_version,
       pack_profile_package_level, pack_profile_base_each_quantity,
       packaging_weight_source, weight_grams, length_mm, width_mm, height_mm,
       observed_at, source_revision, source_hash,
       provider_api_version, normalizer_version, workflow_state,
       blocking_codes, canonical_order_line_id, promoted_at,
       row_version, created_by, updated_by, expires_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, '${provider}', $6, $7, $8, $9, $10,
       'Revision ${provider} exact case pack', 'open', 'open',
       2, 2, 2, 2, 'USD', 1000, 2000,
       0, 0, 0, 0, 2000, 'provider',
       'USD', 1000, 2000, 0, 0, 0, 0, 2000,
       true, true, 'resolved', $11::uuid, $12::uuid,
       'resolved', 'variant_pack_mapping', $13::uuid, $14::bigint,
       $15::uuid, $16::bigint, 'case', 6, 'profile_version',
       1200, 300, 220, 180,
       now(), 'revision-line-intake-v1', $17,
       '2026-07', 'revision-apply-fixture-v1', 'promoted',
       '{}'::text[], $18::uuid, now(),
       1, $19, $19, now() + interval '7 days'
     ) RETURNING id::text, global_id`,
    [
      ids.organization, integrationAccountId, ids.pipeline, intakeRun.id,
      candidate.id, oldExternalLineId, externalProductId, externalVariantId,
      externalInventoryItemId, sku, product.id, productMapping.id,
      packMapping.id, packMapping.row_version, packVersion.id,
      packVersion.row_version, candidateLineSourceHash, orderLine.id, actorEmail,
    ],
  )).rows[0]
  await pool.query(
    `INSERT INTO operations_external_identifiers (
       organization_id, integration_account_id, entity_type,
       entity_global_id, external_id, status, match_method,
       match_evidence, last_verified_at
     ) VALUES
       ($1::uuid, $2::uuid, 'crm.organization', $3, $4,
        'active', 'exact_external_id', '{}'::jsonb, now()),
       ($1::uuid, $2::uuid, 'operations.order_line', $5, $6,
        'active', 'commerce_order_promotion', '{}'::jsonb, now())`,
    [
      ids.organization, integrationAccountId, customer.rows[0].reference_code,
      customerExternalId, orderLine.global_id, oldExternalLineId,
    ],
  )
  return Object.freeze({
    provider,
    integrationAccountId,
    orderId,
    order,
    orderLine,
    candidate,
    candidateLine,
    product,
    productMapping,
    packVersion,
    packMapping,
    externalOrderId,
    oldExternalLineId,
    newExternalLineId,
    externalProductId,
    externalVariantId,
    customerExternalId,
    sku,
    acceptedSourceHash,
  })
}

export async function applyStructuralRevisionAuthority({
  pool,
  ids,
  persistence,
  evidence,
  revisionCrypto,
  provider = 'shopify',
}) {
  const isFaire = provider === 'faire'
  const applySeed = await seedApplyRevisionAuthority(pool, ids, provider)
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = CASE
       WHEN order_id = $1::uuid THEN now()
       ELSE now() + interval '1 day'
     END
     WHERE organization_id = $2::uuid`,
    [applySeed.orderId, ids.organization],
  )
  const [applyClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider, workerId: `revision-worker-apply-${provider}`, limit: 1,
    })
  assert.equal(applyClaim.canonicalOrderId, applySeed.orderId)
  assert.equal(applyClaim.canonicalOrderRowVersion, 0)
  const applySourceHash = 'd'.repeat(64)
  const party = {
    externalIdentity: { state: 'confirmed', value: applySeed.customerExternalId },
    email: { state: 'confirmed', value: 'revision-recipient@example.com' },
  }
  const shipTo = {
    name: 'Revision recipient',
    line1: '1700 Commerce Drive',
    line2: null,
    city: 'Trumbull',
    regionCode: 'CT',
    postalCode: '06611',
    countryCode: 'US',
  }
  const partyFingerprint =
    revisionCrypto.commerceOrderRevisionProtectedContentFingerprint(
      party,
      ids.organization,
      applyClaim.accountGlobalId,
      applySeed.externalOrderId,
      'party',
    )
  const shipToFingerprint =
    revisionCrypto.commerceOrderRevisionProtectedContentFingerprint(
      shipTo,
      ids.organization,
      applyClaim.accountGlobalId,
      applySeed.externalOrderId,
      'ship_to',
    )
  const applySnapshot = {
    version: isFaire
      ? 'faire-canonical-order-revision-v2'
      : 'shopify-canonical-order-revision-v1',
    provider,
    accountGlobalId: applyClaim.accountGlobalId,
    integrationAccountId: applyClaim.integrationAccountId,
    externalAccountId: applyClaim.externalAccountId,
    credentialVersion: applyClaim.credentialVersion,
    canonicalOrderGlobalId: applyClaim.canonicalOrderGlobalId,
    canonicalOrderRowVersion: applyClaim.canonicalOrderRowVersion,
    observedAt: new Date().toISOString(),
    order: {
      externalOrderId: applySeed.externalOrderId,
      orderNumber: '#9305-REVISED',
      sourceHash: applySourceHash,
      sourceRevision: 'revision-apply-exact-v2',
      rawStates: {
        order: 'open', payment: 'paid', fulfillment: 'unfulfilled', returns: 'none',
      },
      canonicalStates: {
        lifecycle: 'open', payment: 'paid', fulfillment: 'unfulfilled', returns: 'none',
      },
      ...(isFaire ? {
        providerRevisionState: {
          orderState: 'NEW',
          shipmentCount: 0,
          lineStateBasis: 'all_processing',
          quantityBasis: 'exact_order_item_quantity',
        },
      } : {}),
      currency: 'USD',
      requestedDeliveryAt: null,
      money: {
        headerState: 'complete',
        reconciliationMode: 'discount_separate',
        subtotalMinor: '3000',
        shippingMinor: '500',
        taxMinor: '0',
        discountMinor: '0',
        totalMinor: '3500',
      },
      partyFingerprint,
      shipToFingerprint,
      lines: [{
        externalLineId: applySeed.newExternalLineId,
        externalProductId: applySeed.externalProductId,
        externalVariantId: applySeed.externalVariantId,
        sku: applySeed.sku,
        titleSnapshot: 'Revision exact case pack',
        variantTitleSnapshot: 'Case of six',
        orderedQuantity: 3,
        currentQuantity: 3,
        cancelledQuantity: 0,
        fulfilledQuantity: 0,
        unfulfilledQuantity: 3,
        returnedQuantity: isFaire ? 0 : null,
        removedOrRefundedQuantity: 0,
        physicalUnitQuantity: isFaire ? 18 : 3,
        unitMultiplier: isFaire ? 6 : null,
        unitPriceMinor: '1000',
        lineSubtotalMinor: '3000',
        requiresShipping: true,
        sourceHash: 'e'.repeat(64),
      }],
    },
  }
  const applyRevisionHash = evidence.commerceOrderRevisionHash(applySnapshot)
  if (isFaire) {
    const completeness = await pool.query(
      `SELECT
         ocr_faire_revision_snapshot_complete($1::jsonb) AS exact_new,
         ocr_faire_revision_snapshot_complete($2::jsonb) AS processing,
         ocr_faire_revision_snapshot_complete($3::jsonb) AS missing_state`,
      [
        JSON.stringify(applySnapshot),
        JSON.stringify({
          ...applySnapshot,
          order: {
            ...applySnapshot.order,
            providerRevisionState: {
              ...applySnapshot.order.providerRevisionState,
              orderState: 'PROCESSING',
            },
          },
        }),
        JSON.stringify({
          ...applySnapshot,
          order: {
            ...applySnapshot.order,
            providerRevisionState: undefined,
          },
        }),
      ],
    )
    assert.deepEqual(completeness.rows[0], {
      exact_new: true,
      processing: false,
      missing_state: false,
    })
  }
  const protectedParty = {
    ...revisionCrypto.encryptCommerceOrderRevisionProtectedSnapshot(
      party,
      ids.organization,
      applyClaim.accountGlobalId,
      applySeed.externalOrderId,
      applySourceHash,
      'party',
    ),
    contentFingerprint: partyFingerprint,
  }
  const protectedShipTo = {
    ...revisionCrypto.encryptCommerceOrderRevisionProtectedSnapshot(
      shipTo,
      ids.organization,
      applyClaim.accountGlobalId,
      applySeed.externalOrderId,
      applySourceHash,
      'ship_to',
    ),
    contentFingerprint: shipToFingerprint,
  }
  const applyRead = await persistence
    .captureCommerceOrderRevisionObservationInPostgres({
      claim: applyClaim,
      sourceRevision: applySnapshot.order.sourceRevision,
      sourceHash: applySourceHash,
      revisionHash: applyRevisionHash,
      normalizedSnapshot: applySnapshot,
      protectedParty,
      protectedShipTo,
      providerReads: 2,
      providerWrites: 0,
      observedAt: applySnapshot.observedAt,
    })
  assert.equal(applyRead.changed, true)
  assert.equal(applyRead.materialState, 'review_required')
  process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_APPLY_ENABLED = '1'
  let managerState
  try {
    managerState = await persistence
      .readManagerCommerceOrderRevisionStateFromPostgres({
        organizationId: ids.organization,
        orderGlobalId: applyClaim.canonicalOrderGlobalId,
      })
  } finally {
    delete process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_APPLY_ENABLED
  }
  assert.equal(managerState.state?.applyEligible, true)
  assert.match(managerState.state?.exceptionGlobalId || '', /^gex[0-9a-v]+$/u)
  const applyInput = {
    organizationId: ids.organization,
    actorEmail,
    orderGlobalId: applyClaim.canonicalOrderGlobalId,
    observationGlobalId: applyRead.observationGlobalId,
    readGlobalId: applyRead.readGlobalId,
    expectedSourceHash: applySourceHash,
    expectedRevisionHash: applyRevisionHash,
    expectedRowVersion: 0,
    reason: `Apply exact wholly unstarted ${provider} structural revision`,
    idempotencyKey: `provider-apply:${applyRead.readGlobalId}`,
  }
  process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_APPLY_ENABLED = '1'
  let applied
  try {
    applied = await persistence
      .applyCommerceOrderRevisionToClawPilotInPostgres(applyInput)
    assert.equal(applied.replayed, false)
    assert.deepEqual(JSON.parse(JSON.stringify(applied.changeSummary)), {
      headerChanged: true,
      retainedLines: 0,
      changedLines: 0,
      addedLines: 1,
      removedLines: 1,
    })
    const replayedApplication = await persistence
      .applyCommerceOrderRevisionToClawPilotInPostgres(applyInput)
    assert.equal(replayedApplication.replayed, true)
    assert.equal(replayedApplication.applicationGlobalId, applied.applicationGlobalId)
  } finally {
    delete process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_APPLY_ENABLED
  }
  return Object.freeze({
    applySeed,
    applyClaim,
    applyRead,
    applied,
    applyInput,
  })
}


async function verifyAcceptance(databaseUrl, ids, hashes) {
  process.env.CLAWPILOT_ENV = 'development'
  process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = '1'
  delete process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_STRICT
  delete process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_APPLY_ENABLED
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  const basePostgres = postgresAdapter(pool)
  let observedQueries = 0
  let observedTransactions = 0
  const postgres = {
    ...basePostgres,
    query(...args) {
      observedQueries += 1
      return basePostgres.query(...args)
    },
    withTransaction(...args) {
      observedTransactions += 1
      return basePostgres.withTransaction(...args)
    },
  }
  let auditWrites = 0
  const persistence = loadTypeScriptModule(
    'app_src/lib/persistence/commerceOrderRevisions.ts',
    {
      '@/lib/integrations/commerceReadRuntime': {
        commerceReadRuntimeAvailable: () => true,
        commerceReadAccountSql: () => "account.status <> 'error'",
      },
      '@/lib/persistence/postgres': postgres,
      '@/lib/auditWriter': {
        async recordAuditEvent(_input, client) {
          assert.ok(client, 'manager disposition audit is transaction-bound')
          auditWrites += 1
        },
      },
    },
  )
  const evidence = loadTypeScriptModule(
    'app_src/lib/integrations/commerceOrderRevisionEvidence.ts',
  )
  const revisionCrypto = loadTypeScriptModule(
    'app_src/lib/integrations/commerceCredentialCrypto.ts',
  )
  const queriesBeforeDisabledApply = observedQueries
  const transactionsBeforeDisabledApply = observedTransactions
  await assert.rejects(
    persistence.applyCommerceOrderRevisionToClawPilotInPostgres({}),
    (error) => error.code === 'COMMERCE_ORDER_REVISION_APPLY_DISABLED',
  )
  assert.equal(
    observedQueries,
    queriesBeforeDisabledApply,
    'default-off Apply must reject before querying PostgreSQL',
  )
  assert.equal(
    observedTransactions,
    transactionsBeforeDisabledApply,
    'default-off Apply must reject before opening a transaction',
  )
  const backfill = await pool.query(
    `SELECT order_id::text, claim_state, material_state, accepted_source_hash
     FROM operations_commerce_order_revision_targets
     WHERE organization_id = $1
     ORDER BY order_id`,
    [ids.organization],
  )
  assert.equal(backfill.rowCount, 3, 'only nonterminal provider orders backfill')
  assert.ok(backfill.rows.every((row) => (
    row.claim_state === 'pending' && row.material_state === 'current'
  )))
  assert.ok(!backfill.rows.some((row) => row.order_id === ids.shipped))

  const applySeed = await seedApplyRevisionAuthority(pool, ids)
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = CASE
       WHEN order_id = $1::uuid THEN now()
       ELSE now() + interval '1 day'
     END
     WHERE organization_id = $2::uuid`,
    [ids.apply, ids.organization],
  )
  const [applyClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-apply', limit: 1,
    })
  assert.equal(applyClaim.canonicalOrderId, ids.apply)
  assert.equal(applyClaim.canonicalOrderRowVersion, 0)
  const applySourceHash = 'd'.repeat(64)
  const applyLineSourceHash = 'e'.repeat(64)
  const party = {
    externalIdentity: { state: 'confirmed', value: applySeed.customerExternalId },
    email: { state: 'confirmed', value: 'revision-recipient@example.com' },
  }
  const shipTo = {
    name: 'Revision recipient',
    line1: '1700 Commerce Drive',
    line2: null,
    city: 'Trumbull',
    regionCode: 'CT',
    postalCode: '06611',
    countryCode: 'US',
  }
  const partyFingerprint =
    revisionCrypto.commerceOrderRevisionProtectedContentFingerprint(
      party,
      ids.organization,
      applyClaim.accountGlobalId,
      applySeed.externalOrderId,
      'party',
    )
  const shipToFingerprint =
    revisionCrypto.commerceOrderRevisionProtectedContentFingerprint(
      shipTo,
      ids.organization,
      applyClaim.accountGlobalId,
      applySeed.externalOrderId,
      'ship_to',
    )
  const applySnapshot = {
    version: 'shopify-canonical-order-revision-v1',
    provider: 'shopify',
    accountGlobalId: applyClaim.accountGlobalId,
    integrationAccountId: applyClaim.integrationAccountId,
    externalAccountId: applyClaim.externalAccountId,
    credentialVersion: applyClaim.credentialVersion,
    canonicalOrderGlobalId: applyClaim.canonicalOrderGlobalId,
    canonicalOrderRowVersion: applyClaim.canonicalOrderRowVersion,
    observedAt: new Date().toISOString(),
    order: {
      externalOrderId: applySeed.externalOrderId,
      orderNumber: '#9305-REVISED',
      sourceHash: applySourceHash,
      sourceRevision: 'revision-apply-exact-v2',
      rawStates: {
        order: 'open', payment: 'paid', fulfillment: 'unfulfilled', returns: 'none',
      },
      canonicalStates: {
        lifecycle: 'open', payment: 'paid', fulfillment: 'unfulfilled', returns: 'none',
      },
      currency: 'USD',
      requestedDeliveryAt: null,
      money: {
        headerState: 'complete',
        reconciliationMode: 'discount_separate',
        subtotalMinor: '3000',
        shippingMinor: '500',
        taxMinor: '0',
        discountMinor: '0',
        totalMinor: '3500',
      },
      partyFingerprint,
      shipToFingerprint,
      lines: [{
        externalLineId: applySeed.newExternalLineId,
        externalProductId: applySeed.externalProductId,
        externalVariantId: applySeed.externalVariantId,
        sku: applySeed.sku,
        titleSnapshot: 'Revision exact case pack',
        variantTitleSnapshot: 'Case of six',
        orderedQuantity: 3,
        currentQuantity: 3,
        cancelledQuantity: 0,
        fulfilledQuantity: 0,
        unfulfilledQuantity: 3,
        returnedQuantity: null,
        removedOrRefundedQuantity: 0,
        physicalUnitQuantity: 3,
        unitMultiplier: null,
        unitPriceMinor: '1000',
        lineSubtotalMinor: '3000',
        requiresShipping: true,
        sourceHash: applyLineSourceHash,
      }],
    },
  }
  const applyRevisionHash = evidence.commerceOrderRevisionHash(applySnapshot)
  const protectedParty = {
    ...revisionCrypto.encryptCommerceOrderRevisionProtectedSnapshot(
      party,
      ids.organization,
      applyClaim.accountGlobalId,
      applySeed.externalOrderId,
      applySourceHash,
      'party',
    ),
    contentFingerprint: partyFingerprint,
  }
  const protectedShipTo = {
    ...revisionCrypto.encryptCommerceOrderRevisionProtectedSnapshot(
      shipTo,
      ids.organization,
      applyClaim.accountGlobalId,
      applySeed.externalOrderId,
      applySourceHash,
      'ship_to',
    ),
    contentFingerprint: shipToFingerprint,
  }
  const applyRead = await persistence
    .captureCommerceOrderRevisionObservationInPostgres({
      claim: applyClaim,
      sourceRevision: applySnapshot.order.sourceRevision,
      sourceHash: applySourceHash,
      revisionHash: applyRevisionHash,
      normalizedSnapshot: applySnapshot,
      protectedParty,
      protectedShipTo,
      providerReads: 2,
      providerWrites: 0,
      observedAt: applySnapshot.observedAt,
    })
  assert.equal(applyRead.changed, true)
  assert.equal(applyRead.materialState, 'review_required')
  const applyInput = {
    organizationId: ids.organization,
    actorEmail,
    orderGlobalId: applyClaim.canonicalOrderGlobalId,
    observationGlobalId: applyRead.observationGlobalId,
    readGlobalId: applyRead.readGlobalId,
    expectedSourceHash: applySourceHash,
    expectedRevisionHash: applyRevisionHash,
    expectedRowVersion: 0,
    reason: 'Apply exact wholly unstarted Shopify structural revision',
    idempotencyKey: `provider-apply:${applyRead.readGlobalId}`,
  }
  process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_APPLY_ENABLED = '1'
  let applied
  try {
    applied = await persistence
      .applyCommerceOrderRevisionToClawPilotInPostgres(applyInput)
    assert.equal(applied.replayed, false)
    assert.deepEqual(JSON.parse(JSON.stringify(applied.changeSummary)), {
      headerChanged: true,
      retainedLines: 0,
      changedLines: 0,
      addedLines: 1,
      removedLines: 1,
    })
    const replayedApplication = await persistence
      .applyCommerceOrderRevisionToClawPilotInPostgres(applyInput)
    assert.equal(replayedApplication.replayed, true)
    assert.equal(replayedApplication.applicationGlobalId, applied.applicationGlobalId)
  } finally {
    delete process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_APPLY_ENABLED
  }
  assert.equal(auditWrites, 1, 'successful structural Apply retains one audit event')
  const appliedAuthority = await pool.query(
    `SELECT
       order_row.row_version::integer,
       order_row.order_number,
       order_row.merchandise_total_minor::integer,
       order_row.source_payload #>> '{headerMoney,customerChargeUse}'
         AS customer_charge_use,
       application.lifecycle_state,
       application.provider_write_count,
       candidate.accepted_revision_application_id = application.id
         AS candidate_pointer_current,
       target.applied_application_id = application.id AS target_pointer_current,
       count(line.id)::integer AS application_lines,
       count(line.id) FILTER (WHERE line.change_kind = 'added')::integer AS added,
       count(line.id) FILTER (WHERE line.change_kind = 'removed')::integer AS removed
     FROM operations_orders order_row
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = order_row.organization_id
      AND candidate.canonical_order_id = order_row.id
     JOIN operations_commerce_order_revision_targets target
       ON target.organization_id = order_row.organization_id
      AND target.order_id = order_row.id
     JOIN operations_commerce_order_revision_applications application
       ON application.organization_id = order_row.organization_id
      AND application.order_id = order_row.id
     JOIN operations_commerce_order_revision_application_lines line
       ON line.organization_id = application.organization_id
      AND line.application_id = application.id
     WHERE order_row.organization_id = $1::uuid AND order_row.id = $2::uuid
     GROUP BY order_row.id, application.id, candidate.id, target.id`,
    [ids.organization, ids.apply],
  )
  assert.deepEqual(appliedAuthority.rows[0], {
    row_version: 1,
    order_number: '#9305-REVISED',
    merchandise_total_minor: 3000,
    customer_charge_use: 'eligible',
    lifecycle_state: 'sealed',
    provider_write_count: 0,
    candidate_pointer_current: true,
    target_pointer_current: true,
    application_lines: 2,
    added: 1,
    removed: 1,
  })
  const appliedLines = await pool.query(
    `SELECT line.external_line_id, line.quantity::integer,
            line.revision_retired_at IS NOT NULL AS retired,
            external.status,
            planning.pack_profile_base_each_quantity
     FROM operations_order_lines line
     JOIN operations_external_identifiers external
       ON external.organization_id = line.organization_id
      AND external.integration_account_id = $2::uuid
      AND external.entity_type = 'operations.order_line'
      AND external.entity_global_id = line.global_id
      AND external.external_id = line.external_line_id
     LEFT JOIN operations_commerce_current_planning_lines planning
       ON planning.organization_id = line.organization_id
      AND planning.canonical_order_line_id = line.id
     WHERE line.organization_id = $1::uuid AND line.order_id = $3::uuid
     ORDER BY line.external_line_id`,
    [ids.organization, ids.integration, ids.apply],
  )
  assert.deepEqual(appliedLines.rows, [
    {
      external_line_id: applySeed.oldExternalLineId,
      quantity: 2,
      retired: true,
      status: 'retired',
      pack_profile_base_each_quantity: null,
    },
    {
      external_line_id: applySeed.newExternalLineId,
      quantity: 3,
      retired: false,
      status: 'active',
      pack_profile_base_each_quantity: 6,
    },
  ])
  const faireAuthority = await applyStructuralRevisionAuthority({
    pool,
    ids,
    persistence,
    evidence,
    revisionCrypto,
    provider: 'faire',
  })
  const retainedFaireAuthority = await pool.query(
    `SELECT application.provider, application.lifecycle_state,
            application.provider_write_count,
            order_row.row_version::integer,
            order_row.source_payload #>> '{headerMoney,customerChargeUse}'
              AS customer_charge_use,
            count(line.id)::integer AS application_lines,
            max(line.unit_multiplier)::integer AS unit_multiplier
     FROM operations_commerce_order_revision_applications application
     JOIN operations_orders order_row
       ON order_row.organization_id = application.organization_id
      AND order_row.id = application.order_id
     JOIN operations_commerce_order_revision_application_lines line
       ON line.organization_id = application.organization_id
      AND line.application_id = application.id
     WHERE application.organization_id = $1::uuid
       AND application.global_id = $2
     GROUP BY application.id, order_row.id`,
    [ids.organization, faireAuthority.applied.applicationGlobalId],
  )
  assert.deepEqual(retainedFaireAuthority.rows[0], {
    provider: 'faire',
    lifecycle_state: 'sealed',
    provider_write_count: 0,
    row_version: 1,
    customer_charge_use: 'blocked',
    application_lines: 2,
    unit_multiplier: 6,
  })
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now()
     WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
    [ids.organization, ids.apply],
  )
  const [readdClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-readd', limit: 1,
    })
  assert.equal(readdClaim.canonicalOrderId, ids.apply)
  assert.equal(readdClaim.canonicalOrderRowVersion, 1)
  const readdSourceHash = 'c'.repeat(64)
  const readdParty = {
    externalIdentity: { state: 'confirmed', value: applySeed.customerExternalId },
    email: { state: 'confirmed', value: 'revision-recipient@example.com' },
  }
  const readdShipTo = {
    name: 'Revision recipient',
    line1: '1700 Commerce Drive',
    line2: null,
    city: 'Trumbull',
    regionCode: 'CT',
    postalCode: '06611',
    countryCode: 'US',
  }
  const readdPartyFingerprint =
    revisionCrypto.commerceOrderRevisionProtectedContentFingerprint(
      readdParty,
      ids.organization,
      readdClaim.accountGlobalId,
      applySeed.externalOrderId,
      'party',
    )
  const readdShipToFingerprint =
    revisionCrypto.commerceOrderRevisionProtectedContentFingerprint(
      readdShipTo,
      ids.organization,
      readdClaim.accountGlobalId,
      applySeed.externalOrderId,
      'ship_to',
    )
  const readdSnapshot = {
    version: 'shopify-canonical-order-revision-v1',
    provider: 'shopify',
    accountGlobalId: readdClaim.accountGlobalId,
    integrationAccountId: readdClaim.integrationAccountId,
    externalAccountId: readdClaim.externalAccountId,
    credentialVersion: readdClaim.credentialVersion,
    canonicalOrderGlobalId: readdClaim.canonicalOrderGlobalId,
    canonicalOrderRowVersion: readdClaim.canonicalOrderRowVersion,
    observedAt: new Date().toISOString(),
    order: {
      externalOrderId: applySeed.externalOrderId,
      orderNumber: '#9305-READDED',
      sourceHash: readdSourceHash,
      sourceRevision: 'revision-apply-exact-v3',
      rawStates: {
        order: 'open', payment: 'paid', fulfillment: 'unfulfilled', returns: 'none',
      },
      canonicalStates: {
        lifecycle: 'open', payment: 'paid', fulfillment: 'unfulfilled', returns: 'none',
      },
      currency: 'USD',
      requestedDeliveryAt: null,
      money: {
        headerState: 'complete',
        reconciliationMode: 'discount_separate',
        subtotalMinor: '5000',
        shippingMinor: '500',
        taxMinor: '0',
        discountMinor: '0',
        totalMinor: '5500',
      },
      partyFingerprint: readdPartyFingerprint,
      shipToFingerprint: readdShipToFingerprint,
      lines: [
        {
          externalLineId: applySeed.oldExternalLineId,
          externalProductId: applySeed.externalProductId,
          externalVariantId: applySeed.externalVariantId,
          sku: applySeed.sku,
          titleSnapshot: 'Revision exact case pack',
          variantTitleSnapshot: 'Case of six',
          orderedQuantity: 2,
          currentQuantity: 2,
          cancelledQuantity: 0,
          fulfilledQuantity: 0,
          unfulfilledQuantity: 2,
          returnedQuantity: null,
          removedOrRefundedQuantity: 0,
          physicalUnitQuantity: 2,
          unitMultiplier: null,
          unitPriceMinor: '1000',
          lineSubtotalMinor: '2000',
          requiresShipping: true,
          sourceHash: 'b'.repeat(64),
        },
        {
          externalLineId: applySeed.newExternalLineId,
          externalProductId: applySeed.externalProductId,
          externalVariantId: applySeed.externalVariantId,
          sku: applySeed.sku,
          titleSnapshot: 'Revision exact case pack',
          variantTitleSnapshot: 'Case of six',
          orderedQuantity: 3,
          currentQuantity: 3,
          cancelledQuantity: 0,
          fulfilledQuantity: 0,
          unfulfilledQuantity: 3,
          returnedQuantity: null,
          removedOrRefundedQuantity: 0,
          physicalUnitQuantity: 3,
          unitMultiplier: null,
          unitPriceMinor: '1000',
          lineSubtotalMinor: '3000',
          requiresShipping: true,
          sourceHash: 'a'.repeat(64),
        },
      ],
    },
  }
  const readdRevisionHash = evidence.commerceOrderRevisionHash(readdSnapshot)
  const readdRead = await persistence
    .captureCommerceOrderRevisionObservationInPostgres({
      claim: readdClaim,
      sourceRevision: readdSnapshot.order.sourceRevision,
      sourceHash: readdSourceHash,
      revisionHash: readdRevisionHash,
      normalizedSnapshot: readdSnapshot,
      protectedParty: {
        ...revisionCrypto.encryptCommerceOrderRevisionProtectedSnapshot(
          readdParty,
          ids.organization,
          readdClaim.accountGlobalId,
          applySeed.externalOrderId,
          readdSourceHash,
          'party',
        ),
        contentFingerprint: readdPartyFingerprint,
      },
      protectedShipTo: {
        ...revisionCrypto.encryptCommerceOrderRevisionProtectedSnapshot(
          readdShipTo,
          ids.organization,
          readdClaim.accountGlobalId,
          applySeed.externalOrderId,
          readdSourceHash,
          'ship_to',
        ),
        contentFingerprint: readdShipToFingerprint,
      },
      providerReads: 2,
      providerWrites: 0,
      observedAt: readdSnapshot.observedAt,
    })
  assert.equal(readdRead.materialState, 'review_required')
  const readdInput = {
    organizationId: ids.organization,
    actorEmail,
    orderGlobalId: readdClaim.canonicalOrderGlobalId,
    observationGlobalId: readdRead.observationGlobalId,
    readGlobalId: readdRead.readGlobalId,
    expectedSourceHash: readdSourceHash,
    expectedRevisionHash: readdRevisionHash,
    expectedRowVersion: 1,
    reason: 'Reapply exact Shopify revision with lifetime line identity',
    idempotencyKey: `provider-readd:${readdRead.readGlobalId}`,
  }
  process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_APPLY_ENABLED = '1'
  let readded
  try {
    readded = await persistence
      .applyCommerceOrderRevisionToClawPilotInPostgres(readdInput)
  } finally {
    delete process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_APPLY_ENABLED
  }
  assert.deepEqual(JSON.parse(JSON.stringify(readded.changeSummary)), {
    headerChanged: true,
    retainedLines: 1,
    changedLines: 1,
    addedLines: 0,
    removedLines: 0,
  })
  const readdedAuthority = await pool.query(
    `SELECT
       order_row.row_version::integer,
       candidate.accepted_revision_application_id = application.id
         AS candidate_pointer_current,
       target.applied_application_id = application.id AS target_pointer_current,
       old_line.id::text = $4::uuid::text AS reused_canonical_id,
       old_line.global_id = $5 AS reused_canonical_global_id,
       old_line.revision_retired_at IS NULL AS old_line_current,
       old_external.status AS old_external_status,
       readd_line.prior_application_line_id = removed_line.id
         AS immutable_removal_linked,
       readd_line.candidate_line_id IS NULL AS uses_revision_lineage,
       first_application.lifecycle_state AS first_application_state,
       count(planning.global_id)::integer AS planning_lines,
       min(planning.pack_profile_base_each_quantity)::integer AS min_base_each,
       max(planning.pack_profile_base_each_quantity)::integer AS max_base_each
     FROM operations_orders order_row
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = order_row.organization_id
      AND candidate.canonical_order_id = order_row.id
     JOIN operations_commerce_order_revision_targets target
       ON target.organization_id = order_row.organization_id
      AND target.order_id = order_row.id
     JOIN operations_commerce_order_revision_applications application
       ON application.organization_id = order_row.organization_id
      AND application.global_id = $3
     JOIN operations_commerce_order_revision_applications first_application
       ON first_application.organization_id = order_row.organization_id
      AND first_application.global_id = $6
     JOIN operations_order_lines old_line
       ON old_line.organization_id = order_row.organization_id
      AND old_line.order_id = order_row.id
      AND old_line.external_line_id = $7
     JOIN operations_external_identifiers old_external
       ON old_external.organization_id = old_line.organization_id
      AND old_external.integration_account_id = $8::uuid
      AND old_external.entity_type = 'operations.order_line'
      AND old_external.entity_global_id = old_line.global_id
      AND old_external.external_id = old_line.external_line_id
     JOIN operations_commerce_order_revision_application_lines removed_line
       ON removed_line.organization_id = first_application.organization_id
      AND removed_line.application_id = first_application.id
      AND removed_line.canonical_order_line_id = old_line.id
      AND removed_line.change_kind = 'removed'
     JOIN operations_commerce_order_revision_application_lines readd_line
       ON readd_line.organization_id = application.organization_id
      AND readd_line.application_id = application.id
      AND readd_line.canonical_order_line_id = old_line.id
      AND readd_line.change_kind = 'changed'
     JOIN operations_commerce_current_planning_lines planning
       ON planning.organization_id = order_row.organization_id
      AND planning.order_candidate_id = candidate.id
     WHERE order_row.organization_id = $1::uuid AND order_row.id = $2::uuid
     GROUP BY order_row.id, candidate.id, target.id, application.id,
              first_application.id, old_line.id, old_external.status,
              readd_line.id, removed_line.id`,
    [
      ids.organization, ids.apply, readded.applicationGlobalId,
      applySeed.orderLine.id, applySeed.orderLine.global_id,
      applied.applicationGlobalId, applySeed.oldExternalLineId, ids.integration,
    ],
  )
  assert.deepEqual(readdedAuthority.rows[0], {
    row_version: 2,
    candidate_pointer_current: true,
    target_pointer_current: true,
    reused_canonical_id: true,
    reused_canonical_global_id: true,
    old_line_current: true,
    old_external_status: 'active',
    immutable_removal_linked: true,
    uses_revision_lineage: true,
    first_application_state: 'sealed',
    planning_lines: 2,
    min_base_each: 6,
    max_base_each: 6,
  })
  auditWrites = 0

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = CASE WHEN order_id = $1 THEN now() ELSE now() + interval '1 day' END
     WHERE organization_id = $2`,
    [ids.current, ids.organization],
  )
  const [claim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify',
      workerId: 'revision-worker-one',
      limit: 1,
    })
  assert.equal(claim.canonicalOrderId, ids.current)
  const leased = await pool.query(
    `SELECT claim_state, locked_by, locked_until > now() AS lease_current
     FROM operations_commerce_order_revision_targets WHERE id = $1`,
    [claim.targetId],
  )
  assert.deepEqual(leased.rows[0], {
    claim_state: 'processing',
    locked_by: 'revision-worker-one',
    lease_current: true,
  })
  assert.equal((await persistence.claimCommerceOrderRevisionTargetsInPostgres({
    provider: 'shopify', workerId: 'revision-worker-two', limit: 1,
  })).length, 0, 'an active lease cannot be double-claimed')

  const firstSnapshot = snapshot({
    claim,
    sourceHash: hashes.current,
    sourceRevision: 'revision-1',
    observedAt: '2026-08-12T12:00:00.000Z',
  })
  const first = await persistence
    .captureCommerceOrderRevisionObservationInPostgres({
      claim,
      sourceRevision: firstSnapshot.order.sourceRevision,
      sourceHash: hashes.current,
      revisionHash: evidence.commerceOrderRevisionHash(firstSnapshot),
      normalizedSnapshot: firstSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: firstSnapshot.observedAt,
    })
  assert.equal(first.changed, false)
  assert.equal(first.providerWrites, 0)

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now() WHERE id = $1`,
    [claim.targetId],
  )
  const [repeatClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-repeat', limit: 1,
    })
  const repeatedSnapshot = snapshot({
    claim: repeatClaim,
    sourceHash: hashes.current,
    sourceRevision: 'revision-1',
    observedAt: '2026-08-12T13:00:00.000Z',
  })
  assert.equal(
    evidence.commerceOrderRevisionHash(firstSnapshot),
    evidence.commerceOrderRevisionHash(repeatedSnapshot),
  )
  const repeated = await persistence
    .captureCommerceOrderRevisionObservationInPostgres({
      claim: repeatClaim,
      sourceRevision: repeatedSnapshot.order.sourceRevision,
      sourceHash: hashes.current,
      revisionHash: evidence.commerceOrderRevisionHash(repeatedSnapshot),
      normalizedSnapshot: repeatedSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: repeatedSnapshot.observedAt,
    })
  assert.equal(repeated.changed, false)
  const unchangedCount = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_order_revision_observations
     WHERE order_id = $1`,
    [ids.current],
  )
  assert.equal(unchangedCount.rows[0].count, 1, 'unchanged repeats dedupe')
  const unchangedReads = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_order_revision_reads
     WHERE order_id = $1`,
    [ids.current],
  )
  assert.equal(unchangedReads.rows[0].count, 2, 'each unchanged exact read retains a fresh fence')

  await pool.query(
    `UPDATE operations_orders
     SET row_version = row_version + 1
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [ids.organization, ids.current],
  )
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now() WHERE id = $1`,
    [claim.targetId],
  )
  const [rowVersionClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-row-version', limit: 1,
    })
  assert.equal(rowVersionClaim.canonicalOrderRowVersion, 1)
  const rowVersionSnapshot = snapshot({
    claim: rowVersionClaim,
    sourceHash: hashes.current,
    sourceRevision: 'revision-1',
    observedAt: new Date().toISOString(),
  })
  assert.equal(
    evidence.commerceOrderRevisionHash(rowVersionSnapshot),
    evidence.commerceOrderRevisionHash(firstSnapshot),
    'local canonical row-version fences do not change provider-content identity',
  )
  const rowVersionRead = await persistence
    .captureCommerceOrderRevisionObservationInPostgres({
      claim: rowVersionClaim,
      sourceRevision: rowVersionSnapshot.order.sourceRevision,
      sourceHash: hashes.current,
      revisionHash: evidence.commerceOrderRevisionHash(rowVersionSnapshot),
      normalizedSnapshot: rowVersionSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: rowVersionSnapshot.observedAt,
    })
  assert.equal(rowVersionRead.changed, false)

  await pool.query('BEGIN')
  try {
    await pool.query(
      `UPDATE operations_commerce_credentials
       SET credential_ciphertext = decode('02', 'hex'),
           credential_version = 2,
           updated_by = $3
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration, actorEmail],
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET commerce_credential_generation = 2,
           updated_by = $3
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [ids.organization, ids.integration, actorEmail],
    )
    await pool.query('COMMIT')
  } catch (error) {
    await pool.query('ROLLBACK')
    throw error
  }
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now() WHERE id = $1`,
    [claim.targetId],
  )
  const [credentialRotationClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-credential-rotation', limit: 1,
    })
  assert.equal(credentialRotationClaim.credentialVersion, 2)
  assert.equal(credentialRotationClaim.canonicalOrderRowVersion, 1)
  const credentialRotationSnapshot = snapshot({
    claim: credentialRotationClaim,
    sourceHash: hashes.current,
    sourceRevision: 'revision-1',
    observedAt: new Date().toISOString(),
  })
  assert.equal(
    evidence.commerceOrderRevisionHash(credentialRotationSnapshot),
    evidence.commerceOrderRevisionHash(firstSnapshot),
    'credential rotation does not change provider-content identity',
  )
  const credentialRotationRead = await persistence
    .captureCommerceOrderRevisionObservationInPostgres({
      claim: credentialRotationClaim,
      sourceRevision: credentialRotationSnapshot.order.sourceRevision,
      sourceHash: hashes.current,
      revisionHash: evidence.commerceOrderRevisionHash(credentialRotationSnapshot),
      normalizedSnapshot: credentialRotationSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: credentialRotationSnapshot.observedAt,
    })
  assert.equal(credentialRotationRead.changed, false)
  const reusedObservationEvidence = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_order_revision_observations observation
        WHERE observation.organization_id = $1::uuid
          AND observation.order_id = $2::uuid) AS observations,
       count(*)::integer AS reads,
       max(read_row.canonical_row_version)::integer AS latest_row_version,
       max(read_row.credential_generation)::integer AS latest_credential_generation
     FROM operations_commerce_order_revision_reads read_row
     WHERE read_row.organization_id = $1::uuid
       AND read_row.order_id = $2::uuid`,
    [ids.organization, ids.current],
  )
  assert.deepEqual(reusedObservationEvidence.rows[0], {
    observations: 1,
    reads: 4,
    latest_row_version: 1,
    latest_credential_generation: 2,
  }, 'one immutable provider-content observation supports occurrence-current read fences')

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now() WHERE id = $1`,
    [claim.targetId],
  )
  const [changedClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-changed', limit: 1,
    })
  const changedHash = '9'.repeat(64)
  const changedSnapshot = snapshot({
    claim: changedClaim,
    sourceHash: changedHash,
    sourceRevision: 'revision-2',
    observedAt: new Date().toISOString(),
    lifecycle: 'cancelled',
  })
  const changedRevisionHash = evidence.commerceOrderRevisionHash(changedSnapshot)
  const changed = await persistence
    .captureCommerceOrderRevisionObservationInPostgres({
      claim: changedClaim,
      sourceRevision: changedSnapshot.order.sourceRevision,
      sourceHash: changedHash,
      revisionHash: changedRevisionHash,
      normalizedSnapshot: changedSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: changedSnapshot.observedAt,
    })
  assert.equal(changed.materialState, 'provider_cancelled')
  const managerException = await pool.query(
    `SELECT count(*)::integer AS count, min(severity) AS severity,
            min(status) AS status
     FROM operations_exceptions
     WHERE organization_id = $1 AND order_id = $2
       AND exception_type = 'commerce_order_revision_required'`,
    [ids.organization, ids.current],
  )
  assert.deepEqual(managerException.rows[0], {
    count: 1,
    severity: 'critical',
    status: 'open',
  })
  for (const forbiddenStatus of ['resolved', 'dismissed']) {
    await assert.rejects(
      pool.query(
        `UPDATE operations_exceptions
         SET status = $3
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
           AND exception_type = 'commerce_order_revision_required'`,
        [ids.organization, ids.current, forbiddenStatus],
      ),
      /immutable disposition evidence/u,
    )
  }
  await pool.query(
    `UPDATE operations_exceptions
     SET status = 'acknowledged'
     WHERE organization_id = $1::uuid AND order_id = $2::uuid
       AND exception_type = 'commerce_order_revision_required'`,
    [ids.organization, ids.current],
  )
  await pool.query(
    `UPDATE operations_exceptions
     SET status = 'open'
     WHERE organization_id = $1::uuid AND order_id = $2::uuid
       AND exception_type = 'commerce_order_revision_required'`,
    [ids.organization, ids.current],
  )
  const gateClient = await pool.connect()
  try {
    for (const operation of [
      'plan',
      'release',
      'assign',
      'pick',
      'pack',
      'prepare_fulfillment',
      'rate',
      'select_rate',
      'label',
      'packing_slip',
      'ship',
      'export',
    ]) {
      await assert.rejects(
        persistence.assertCommerceOrderRevisionExecutionCurrent(gateClient, {
          organizationId: ids.organization,
          orderId: ids.current,
          operation,
        }),
        (error) => error.code === 'COMMERCE_ORDER_REVISION_REVIEW_REQUIRED',
      )
    }
  } finally {
    gateClient.release()
  }
  await assert.rejects(
    pool.query(
      `UPDATE operations_commerce_order_revision_observations
       SET provider_write_count = 0 WHERE order_id = $1`,
      [ids.current],
    ),
    /immutable/u,
  )
  await assert.rejects(
    persistence.captureCommerceOrderRevisionObservationInPostgres({
      claim: changedClaim,
      sourceRevision: changedSnapshot.order.sourceRevision,
      sourceHash: changedHash,
      revisionHash: changedRevisionHash,
      normalizedSnapshot: changedSnapshot,
      providerReads: 2,
      providerWrites: 1,
      observedAt: changedSnapshot.observedAt,
    }),
    /provider-write fence/u,
  )

  await pool.query(
    `DELETE FROM operations_commerce_order_revision_targets
     WHERE organization_id = $1 AND order_id = $2`,
    [ids.organization, ids.missing],
  )
  const missingClient = await pool.connect()
  try {
    await assert.rejects(
      persistence.assertCommerceOrderRevisionExecutionCurrent(missingClient, {
        organizationId: ids.organization, orderId: ids.missing, operation: 'plan',
      }),
      /latest provider revision/u,
    )
  } finally {
    missingClient.release()
  }

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now()
     WHERE organization_id = $1 AND order_id = $2`,
    [ids.organization, ids.stale],
  )
  const [expiredLeaseClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-stale', limit: 1,
    })
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET locked_until = now() - interval '1 second'
     WHERE id = $1`,
    [expiredLeaseClaim.targetId],
  )
  const [staleClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-stale', limit: 1,
    })
  assert.equal(staleClaim.targetId, expiredLeaseClaim.targetId)
  assert.notEqual(
    staleClaim.leaseToken,
    expiredLeaseClaim.leaseToken,
    'same-worker reclaim receives a new per-claim lease token',
  )
  assert.equal(await persistence.failCommerceOrderRevisionTargetInPostgres({
    claim: expiredLeaseClaim,
    workerId: expiredLeaseClaim.workerId,
    errorCode: 'COMMERCE_ORDER_REVISION_EXPIRED_CLAIM_TEST',
  }), null, 'an expired claim cannot fail the reclaimed lease')
  const expiredSnapshot = snapshot({
    claim: expiredLeaseClaim,
    sourceHash: hashes.stale,
    sourceRevision: 'expired-lease-revision',
    observedAt: new Date().toISOString(),
  })
  await assert.rejects(
    persistence.captureCommerceOrderRevisionObservationInPostgres({
      claim: expiredLeaseClaim,
      sourceRevision: expiredSnapshot.order.sourceRevision,
      sourceHash: hashes.stale,
      revisionHash: evidence.commerceOrderRevisionHash(expiredSnapshot),
      normalizedSnapshot: expiredSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: expiredSnapshot.observedAt,
    }),
    /stale or lost/u,
  )
  const reclaimedLease = await pool.query(
    `SELECT claim_state, locked_by, lock_token::text
     FROM operations_commerce_order_revision_targets WHERE id = $1`,
    [staleClaim.targetId],
  )
  assert.deepEqual(reclaimedLease.rows[0], {
    claim_state: 'processing',
    locked_by: staleClaim.workerId,
    lock_token: staleClaim.leaseToken,
  }, 'expired capture/fail cannot mutate the same-worker reclaimed lease')
  await pool.query(
    `UPDATE operations_orders SET row_version = row_version + 1
     WHERE id = $1`,
    [ids.stale],
  )
  const staleSnapshot = snapshot({
    claim: staleClaim,
    sourceHash: hashes.stale,
    sourceRevision: 'stale-revision',
    observedAt: '2026-08-12T15:00:00.000Z',
  })
  await assert.rejects(
    persistence.captureCommerceOrderRevisionObservationInPostgres({
      claim: staleClaim,
      sourceRevision: staleSnapshot.order.sourceRevision,
      sourceHash: hashes.stale,
      revisionHash: evidence.commerceOrderRevisionHash(staleSnapshot),
      normalizedSnapshot: staleSnapshot,
      providerReads: 2,
      providerWrites: 0,
      observedAt: staleSnapshot.observedAt,
    }),
    /stale or lost/u,
  )
  assert.equal(await persistence.failCommerceOrderRevisionTargetInPostgres({
    claim: staleClaim,
    workerId: staleClaim.workerId,
    errorCode: 'COMMERCE_ORDER_REVISION_STALE_TEST',
  }), 'failed')
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now()
     WHERE organization_id = $1 AND order_id = $2`,
    [ids.organization, ids.stale],
  )
  const [freshClaim] = await persistence
    .claimCommerceOrderRevisionTargetsInPostgres({
      provider: 'shopify', workerId: 'revision-worker-fresh', limit: 1,
    })
  const freshSnapshot = snapshot({
    claim: freshClaim,
    sourceHash: hashes.stale,
    sourceRevision: 'current-revision',
    observedAt: new Date().toISOString(),
  })
  await persistence.captureCommerceOrderRevisionObservationInPostgres({
    claim: freshClaim,
    sourceRevision: freshSnapshot.order.sourceRevision,
    sourceHash: hashes.stale,
    revisionHash: evidence.commerceOrderRevisionHash(freshSnapshot),
    normalizedSnapshot: freshSnapshot,
    providerReads: 2,
    providerWrites: 0,
    observedAt: freshSnapshot.observedAt,
  })
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET checked_at = now() - interval '2 hours'
     WHERE organization_id = $1 AND order_id = $2`,
    [ids.organization, ids.stale],
  )
  const staleCoverageClient = await pool.connect()
  try {
    await assert.rejects(
      persistence.assertCommerceOrderRevisionExecutionCurrent(
        staleCoverageClient,
        { organizationId: ids.organization, orderId: ids.stale, operation: 'plan' },
      ),
      /latest provider revision/u,
    )
  } finally {
    staleCoverageClient.release()
  }
  const staleCoverageHealth =
    await persistence.readCommerceOrderRevisionHealthFromPostgres()
  assert.equal(staleCoverageHealth.status, 'degraded')
  assert.ok(
    staleCoverageHealth.summary.stale > 0,
    'post-0274 stale authority must remain explicit degraded health',
  )

  await pool.query('SET session_replication_role = replica')
  try {
    await pool.query(
      `INSERT INTO operations_fulfillment_plans (
         global_id, organization_id, order_id, warehouse_id,
         version_number, status, method, promised_delivery_at
       ) VALUES (
         'gfp0009301', $1::uuid, $2::uuid, $3::uuid,
         1, 'planned', 'manual_override', now() + interval '1 day'
       )`,
      [ids.organization, ids.current, randomUUID()],
    )
  } finally {
    await pool.query('SET session_replication_role = origin')
  }
  const cancellationInput = {
    organizationId: ids.organization,
    actorEmail,
    orderGlobalId: changedClaim.canonicalOrderGlobalId,
    observationGlobalId: changed.observationGlobalId,
    readGlobalId: changed.readGlobalId,
    expectedSourceHash: changedHash,
    expectedRevisionHash: changedRevisionHash,
    expectedRowVersion: changedClaim.canonicalOrderRowVersion,
    reason: 'Accept exact provider cancellation after warehouse-start verification',
    idempotencyKey: `provider-cancel:${changed.observationGlobalId}`,
  }
  await assert.rejects(
    persistence.cancelUnstartedCommerceOrderFromProviderRevisionInPostgres(
      cancellationInput,
    ),
    (error) => error.code === 'COMMERCE_ORDER_REVISION_CANCELLATION_STARTED',
  )
  assert.equal(auditWrites, 0, 'rejected cancellation has no audit side effect')
  await pool.query('SET session_replication_role = replica')
  try {
    await pool.query(
      `DELETE FROM operations_fulfillment_plans
       WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
      [ids.organization, ids.current],
    )
  } finally {
    await pool.query('SET session_replication_role = origin')
  }

  const cancelled = await persistence
    .cancelUnstartedCommerceOrderFromProviderRevisionInPostgres(cancellationInput)
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled)), {
    dispositionGlobalId: cancelled.dispositionGlobalId,
    orderGlobalId: changedClaim.canonicalOrderGlobalId,
    observationGlobalId: changed.observationGlobalId,
    readGlobalId: changed.readGlobalId,
    sourceHash: changedHash,
    revisionHash: changedRevisionHash,
    previousStatus: 'imported',
    status: 'cancelled',
    previousRowVersion: changedClaim.canonicalOrderRowVersion,
    newRowVersion: changedClaim.canonicalOrderRowVersion + 1,
    replayed: false,
    providerReads: 2,
    providerWrites: 0,
  })
  assert.match(cancelled.dispositionGlobalId, /^gcod/u)
  assert.equal(auditWrites, 1)
  const replayedCancellation = await persistence
    .cancelUnstartedCommerceOrderFromProviderRevisionInPostgres(cancellationInput)
  assert.equal(replayedCancellation.replayed, true)
  assert.equal(replayedCancellation.dispositionGlobalId, cancelled.dispositionGlobalId)
  assert.equal(auditWrites, 1, 'transport retry replays without duplicate audit')
  await assert.rejects(
    persistence.cancelUnstartedCommerceOrderFromProviderRevisionInPostgres({
      ...cancellationInput,
      reason: 'A different request cannot reuse this exact transport key',
    }),
    (error) => error.code === 'COMMERCE_ORDER_REVISION_IDEMPOTENCY_CONFLICT',
  )

  const cancellationState = await pool.query(
    `SELECT
       order_row.status, order_row.row_version::integer,
       target.material_state, target.accepted_source_hash,
       exception.status AS exception_status,
       disposition.provider_write_count,
       (SELECT count(*)::integer FROM operations_domain_events event
        WHERE event.organization_id = $1::uuid
          AND event.aggregate_id = $2::uuid
          AND event.event_type = 'operations.order.cancelled_from_provider_revision') AS event_count
     FROM operations_orders order_row
     JOIN operations_commerce_order_revision_targets target
       ON target.organization_id = order_row.organization_id
      AND target.order_id = order_row.id
     JOIN operations_commerce_order_revision_dispositions disposition
       ON disposition.organization_id = order_row.organization_id
      AND disposition.order_id = order_row.id
     JOIN operations_exceptions exception
       ON exception.organization_id = order_row.organization_id
      AND exception.order_id = order_row.id
      AND exception.exception_type = 'commerce_order_revision_required'
     WHERE order_row.organization_id = $1::uuid AND order_row.id = $2::uuid`,
    [ids.organization, ids.current],
  )
  assert.deepEqual(cancellationState.rows[0], {
    status: 'cancelled',
    row_version: changedClaim.canonicalOrderRowVersion + 1,
    material_state: 'current',
    accepted_source_hash: changedHash,
    exception_status: 'resolved',
    provider_write_count: 0,
    event_count: 1,
  })
  await assert.rejects(
    pool.query(
      `UPDATE operations_commerce_order_revision_dispositions
       SET reason = reason WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
      [ids.organization, ids.current],
    ),
    /immutable/u,
  )
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now()
     WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
    [ids.organization, ids.current],
  )
  assert.equal((await persistence.claimCommerceOrderRevisionTargetsInPostgres({
    provider: 'shopify', workerId: 'terminal-order-read-fence', limit: 5,
  })).length, 0, 'cancelled canonical orders stop exact provider polling')
  const protectedReads = await pool.query(
    `SELECT id::text, global_id,
            encode(party_snapshot_ciphertext, 'hex') AS party_ciphertext,
            encode(party_snapshot_iv, 'hex') AS party_iv,
            encode(party_snapshot_tag, 'hex') AS party_tag,
            party_snapshot_hash, party_content_fingerprint,
            party_snapshot_key_id, party_snapshot_encryption_version,
            encode(ship_to_snapshot_ciphertext, 'hex') AS ship_to_ciphertext,
            encode(ship_to_snapshot_iv, 'hex') AS ship_to_iv,
            encode(ship_to_snapshot_tag, 'hex') AS ship_to_tag,
            ship_to_snapshot_hash, ship_to_content_fingerprint,
            ship_to_snapshot_key_id, ship_to_snapshot_encryption_version,
            source_hash, revision_hash, protected_snapshot_purged_at
     FROM operations_commerce_order_revision_reads
     WHERE party_snapshot_ciphertext IS NOT NULL
       AND ship_to_snapshot_ciphertext IS NOT NULL
       AND protected_snapshot_purged_at IS NULL
     ORDER BY created_at, id
     LIMIT 2`,
  )
  assert.equal(
    protectedReads.rowCount,
    2,
    'purge acceptance requires one expired and one live protected read',
  )
  const [expiredBefore, liveBefore] = protectedReads.rows
  await pool.query('SET session_replication_role = replica')
  try {
    await pool.query(
      `UPDATE operations_commerce_order_revision_reads
       SET created_at = now() - interval '31 days',
           protected_snapshot_expires_at = now() - interval '1 day'
       WHERE id = $1::uuid`,
      [expiredBefore.id],
    )
  } finally {
    await pool.query('SET session_replication_role = origin')
  }
  const healthBeforePurge =
    await persistence.readCommerceOrderRevisionHealthFromPostgres()
  assert.equal(healthBeforePurge.expiredProtectedReadBacklog, 1)
  assert.equal(healthBeforePurge.status, 'degraded')
  const purgeResult = await persistence
    .purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres({ limit: 1 })
  assert.deepEqual(JSON.parse(JSON.stringify(purgeResult)), {
    schemaAvailable: true,
    skipped: false,
    limit: 1,
    purged: 1,
    expiredProtectedReadBacklog: 0,
    backlogTruncated: false,
  })
  const protectedAfter = await pool.query(
    `SELECT id::text, global_id,
            encode(party_snapshot_ciphertext, 'hex') AS party_ciphertext,
            encode(party_snapshot_iv, 'hex') AS party_iv,
            encode(party_snapshot_tag, 'hex') AS party_tag,
            party_snapshot_hash, party_content_fingerprint,
            party_snapshot_key_id, party_snapshot_encryption_version,
            encode(ship_to_snapshot_ciphertext, 'hex') AS ship_to_ciphertext,
            encode(ship_to_snapshot_iv, 'hex') AS ship_to_iv,
            encode(ship_to_snapshot_tag, 'hex') AS ship_to_tag,
            ship_to_snapshot_hash, ship_to_content_fingerprint,
            ship_to_snapshot_key_id, ship_to_snapshot_encryption_version,
            source_hash, revision_hash, protected_snapshot_purged_at
     FROM operations_commerce_order_revision_reads
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[expiredBefore.id, liveBefore.id]],
  )
  const expiredAfter = protectedAfter.rows.find(
    (row) => row.id === expiredBefore.id,
  )
  const liveAfter = protectedAfter.rows.find((row) => row.id === liveBefore.id)
  assert.ok(expiredAfter?.protected_snapshot_purged_at)
  for (const field of [
    'party_ciphertext', 'party_iv', 'party_tag',
    'ship_to_ciphertext', 'ship_to_iv', 'ship_to_tag',
  ]) assert.equal(expiredAfter[field], null, `expired ${field} must be purged`)
  for (const field of [
    'global_id', 'party_snapshot_hash', 'party_content_fingerprint',
    'party_snapshot_key_id', 'party_snapshot_encryption_version',
    'ship_to_snapshot_hash', 'ship_to_content_fingerprint',
    'ship_to_snapshot_key_id', 'ship_to_snapshot_encryption_version',
    'source_hash', 'revision_hash',
  ]) {
    assert.equal(
      expiredAfter[field],
      expiredBefore[field],
      `expired ${field} evidence must be retained`,
    )
  }
  assert.deepEqual(
    Object.fromEntries(Object.keys(liveBefore).map((field) => [
      field,
      liveAfter[field] instanceof Date
        ? liveAfter[field].toISOString()
        : liveAfter[field],
    ])),
    Object.fromEntries(Object.keys(liveBefore).map((field) => [
      field,
      liveBefore[field] instanceof Date
        ? liveBefore[field].toISOString()
        : liveBefore[field],
    ])),
    'unexpired protected ciphertext and evidence must remain unchanged',
  )
  const health = await persistence.readCommerceOrderRevisionHealthFromPostgres()
  assert.equal(health.expiredProtectedReadBacklog, 0)
  const activeCurrentTargets = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_order_revision_targets target
     JOIN operations_orders order_row
       ON order_row.organization_id = target.organization_id
      AND order_row.id = target.order_id
     WHERE target.material_state = 'current'
       AND order_row.status NOT IN ('shipped', 'cancelled')`,
  )
  assert.equal(
    health.targets
      .filter((row) => row.materialState === 'current')
      .reduce((sum, row) => sum + row.count, 0),
    activeCurrentTargets.rows[0].count,
    'terminal target is excluded from active revision health',
  )

  const retained = await pool.query(
    `SELECT count(*)::integer AS observations,
            max(provider_write_count)::integer AS provider_writes
     FROM operations_commerce_order_revision_observations`,
  )
  assert.ok(retained.rows[0].observations >= 3)
  assert.equal(retained.rows[0].provider_writes, 0)
  await pool.end()
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-order-revision-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=commerce_order_revision',
      '-e', 'POSTGRES_DB=commerce_order_revision',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:commerce_order_revision@127.0.0.1:'
      + `${port}/commerce_order_revision`
    )
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    const files = migrations()
    const revisionIndex = files.indexOf('0273_operations_commerce_order_revisions.sql')
    const applyIndex = files.indexOf(
      '0274_operations_commerce_order_revision_apply.sql',
    )
    assert.ok(revisionIndex > 0, '0273 commerce order revision migration is missing')
    assert.ok(applyIndex > revisionIndex, '0274 commerce order revision migration is missing')
    let ids
    let hashes
    try {
      for (const file of files.slice(0, revisionIndex)) {
        await applyMigration(client, file)
      }
      ids = orderIds()
      hashes = await seedBeforeRevisionMigration(client, ids)
      for (const file of files.slice(revisionIndex, applyIndex)) {
        await applyMigration(client, file)
      }
      await verifyProtectedSnapshotPurgeRolloutSkip(client)
      for (const file of files.slice(applyIndex)) await applyMigration(client, file)
    } finally {
      client.release()
      await pool.end()
    }
    await verifyAcceptance(databaseUrl, ids, hashes)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Commerce order revision disposable-PostgreSQL acceptance passed')
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
